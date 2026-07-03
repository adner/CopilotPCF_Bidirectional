# Specification — Dynamic Dashboard MCP Server

**Status:** Implemented
**Date:** 2026-07-02
**Scope of this document:** the **custom MCP server** for the "Dynamic Dashboard" demo. The
client side (Xrm.Copilot APIs, the widget→app bridge, the PCF control) is covered in
`references/power-apps-copilot-integration.md`.

> **Provenance note:** citations of the form "demo spec §X" throughout this document refer to the
> original planning spec (`copilot-dynamic-dashboard-demo-spec.md`, now retired) that pinned down
> the tool/endpoint contract before this server existed. Everything load-bearing from it was
> restated in full in this document (the tool surface in §3, the endpoints in §7, security in §8),
> so those citations are historical breadcrumbs, not required reading. Its planned `mock-server/`
> was never needed — the real server was built first and the PCF developed directly against it.

---

## 0. Prime directive — the web contract is the fixed seam

The **PCF dashboard control** (`controls/dynamic-dashboard/`) is coded against the HTTP contract
in §7 and the token model in §8. That seam is binding: same endpoints, same JSON shapes, same
tokens. Everything else in this spec (OpenAI generation, Dataverse querying) is *implementation
behind that fixed seam*.

**Single-user, single-tenant, stage-demo grade.** No identity model, no multi-user isolation. Auth
is demo-grade capability tokens (demo spec §3.3/§7), explicitly not production.

### 0.1 Prior art — `GenUI_MCP` (proven MCP Apps rendering pattern)

`https://github.com/adner/GenUI_MCP` is the user's own, **verified-working-in-an-M365-Copilot-
declarative-agent** MCP Apps server (a NL-description → interactive HTML generator). It is the ground
truth for the *rendering* half of this spec and settles the widget-delivery question:

- Its architecture — **one static viewer resource** + tool returns **`structuredContent.html`** +
  viewer injects into a **nested `<iframe srcdoc=…>`** — is exactly the pattern §4 adopts. No external
  `fetch`/frame from the pane widget; proven to render in the target host.
- We **reuse** its `mcp-app.ts` (viewer runtime), `assemble-document.ts` (theme + resize bridge +
  design shell), and `server.ts`/`main.ts` (Streamable-HTTP + stdio transport, `registerAppTool` /
  `registerAppResource` / `RESOURCE_MIME_TYPE` usage, `@modelcontextprotocol/ext-apps@^1.7.x`).
- We **diverge** in three ways: generation is a **direct OpenAI call** (not GenUI's AG-UI/LangGraph
  agent); the assembled doc is **data-driven** (pane bakes rows, tile fetches); and the viewer gains an
  **Add-to-dashboard button**. We are also **safer on CSP**: GenUI must allowlist CDN domains (three/
  gsap/d3/chart.js) and flags that as its one host-CSP risk — our vanilla-only charts need **no
  external domains at all**.

---

## 1. Locked decisions (from spec review, 2026-07-02)

| Decision | Choice | Notes |
|---|---|---|
| Runtime / language | **Node 18+ / TypeScript** | Matches the Node mock and the JS widget ecosystem |
| MCP framework | **`@modelcontextprotocol/sdk`** + **`@modelcontextprotocol/ext-apps`** (the "mcp-apps plugin") | ext-apps provides the server tool+UI-resource helpers and the client `App` class |
| MCP transport | **Streamable HTTP** at `POST /mcp` | Remote MCP so the declarative agent can reach it; same process/port as the web endpoints |
| LLM provider | **OpenAI.com API** (`openai` Node SDK) | API key via env; model configurable, default `gpt-4o` with **structured outputs** |
| Dataverse data path | **TDS (SQL) endpoint** as primary, **Web API/FetchXML as documented fallback** | Feasibility confirmed — see §6 |
| Dataverse auth | **Confidential client** (client-credentials); ClientId + secret provided by the user | Same app registration used for TDS token acquisition |
| Schema grounding for query generation | **Curated schema doc** injected into the LLM prompt | `config/dataverse-schema.md` — see §5.3 |
| Tile/registry auth | **Capability tokens** (`k=`), HTTPS, no login | demo spec §3.3/§7 |
| State persistence | **JSON file** (singleton), survives restart; reset = delete/clear the file | demo spec §6 |
| Widget delivery | **Static viewer resource + `structuredContent.html` + nested `srcdoc`** | Proven in `GenUI_MCP` (§0.1); no external fetch/iframe from the pane |
| Supported `vizType` set | `bar`, `line`, `pie`, `kpi` (extensible) | Match the mock's set; keep the string identifiers stable |

Third-party-package rule (from the original brief): **the generated visualization HTML/JS must be
vanilla** — no CDN chart libraries, no runtime third-party imports in the tile/widget. Server-side
npm dependencies (MCP SDK, ext-apps, openai, the SQL driver) are fine and expected.

---

## 2. Architecture

Single Node process, single HTTPS listener, two logical surfaces on shared state:

```
                         ┌──────────────────────────── MCP Server process (Node/TS, one HTTPS port) ───────────────────────────┐
 M365 Copilot            │                                                                                                       │
 declarative agent ──────┼─▶ POST /mcp   (Streamable HTTP MCP transport)                                                        │
   • create_visualization│      tools: create_visualization · add_to_dashboard · list_dashboard ·                              │
   • add_to_dashboard     │             remove_from_dashboard                                                                   │
   • list_dashboard       │      UI resource: ui://ddb/viewer.html  (ONE static viewer; chart arrives as structuredContent.html)│
                          │                                                                                                       │
 MCP Apps viewer ─────────┼─▶ create_visualization → structuredContent.html → nested <iframe srcdoc> (renders baked rows)       │
 (in Copilot pane)        │   [Add to dashboard] ─▶ add_to_dashboard (callServerTool) + postMessage nudge to the PCF            │
                          │   ┌── Web endpoints (plain HTTPS, capability tokens) ──────────────────────────────────────────┐    │
 PCF dashboard ───────────┼──▶│ GET /dashboard?k=<dashboardKey>              → registry JSON                                │    │
 (in Power App)           │   │ GET /tiles/{vizId}?k=<tileKey>               → self-contained tile HTML                     │    │
 tile <iframe> ───────────┼──▶│ GET /tiles/{vizId}/data?k=<tileKey>          → current rows JSON (re-runs the query)        │    │
                          │   │ DELETE /tiles/{vizId}?k=<dashboardKey>       → 204 (idempotent)                             │    │
                          │   └───────────────────────────────────────────────────────────────────────────────────────────┘    │
                          │                                                                                                       │
                          │   Shared state (singleton, JSON-file persisted):                                                     │
                          │     • vizStore:  vizId → { title, vizType, sql, renderCore, sampleRows?, createdAt }                 │
                          │     • registry:  vizId → { title, vizType, tileKey, tileUrl, addedAt }   (the "dashboard")            │
                          │                                                                                                       │
                          │   Dataverse client (confidential client): TDS SQL endpoint (primary) / Web API (fallback)            │
                          │   OpenAI client: NL + curated schema → { title, vizType, sql, renderCore }                           │
                          └───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Two stores, deliberately separate:**

- **`vizStore`** — every visualization the agent generates, whether or not it's on the dashboard. Keyed
  by `vizId`. Holds the **bound SQL** and the **render core** so the viz can be re-rendered and its
  data re-fetched on demand. A created-but-never-added viz simply lives here until process reset.
- **`registry`** — the dashboard: the subset of vizIds the user clicked **Add to dashboard** on, each
  with its minted `tileKey`/`tileUrl`. This is the `{ tiles: [...] }` that `GET /dashboard` returns.

`add_to_dashboard(vizId)` promotes a `vizStore` entry into `registry`. `remove_from_dashboard` /
`DELETE /tiles/{id}` demote it (the `vizStore` entry may remain).

---

## 3. MCP tools (implements demo spec §3.1)

All tools are registered on the MCP server exposed at `POST /mcp`. Names and I/O shapes below are
**binding** — the widget code and the agent depend on them.

### 3.1 `create_visualization`  *(called by the agent)*

Turns a natural-language request into a rendered visualization widget.

- **Input:** `{ query: string, vizTypeHint?: "bar"|"line"|"pie"|"kpi" }` — `query` is the user's NL
  request (e.g. *"the value of the 5 most recently created opportunities in a bar chart"*).
- **Behavior:**
  1. Call OpenAI (§5) with `query` + the curated schema doc → structured result
     `{ title, vizType, sql, renderCore }`.
  2. **Validate the SQL by executing it** against Dataverse (§6). On error, one bounded repair
     attempt (feed the DB error back to the model), then fail cleanly (§9).
  3. Mint a stable `vizId` (`crypto.randomUUID()`), store
     `{ vizId, title, vizType, sql, renderCore, createdAt }` in `vizStore`.
  4. **Assemble the pane document:** `assembleDocument(renderCore, {mode:'inline', rows})` (§4.2) — a
     self-contained HTML doc that renders the chart from the baked `rows`.
- **Result:**
  - UI resource reference via `_meta.ui.resourceUri = "ui://ddb/viewer.html"` — the single static
    viewer (§4.3), so the host renders it in the pane.
  - `structuredContent`: `{ vizId, title, vizType, html }` — **`vizId`, `title`, `vizType` are
    required by demo spec §3.1**; `html` is the assembled pane document the viewer injects via
    `srcdoc` (proven `GenUI_MCP` pattern). No `tileUrl` here — the pane renders baked data and never
    reaches our server; the `tileKey`/`tileUrl` are minted later at `add_to_dashboard`.

### 3.2 `add_to_dashboard`  *(called by the **widget** via `app.callServerTool`)*

- **Input:** `{ vizId: string }`.
- **Behavior:** promote `vizId` from `vizStore` to `registry`; **mint the per-tile `tileKey`** here;
  `tileUrl = ${PUBLIC_BASE_URL}/tiles/${vizId}?k=${tileKey}`. **Idempotent:** adding an already-added
  viz returns the *same* `tileUrl` and does not re-mint. Persist.
- **Result `structuredContent`:** `{ vizId, title, vizType, tileUrl }` (demo spec §3.1 exact shape).

### 3.3 `list_dashboard`  *(agent, optional beat)*

- **Input:** none. **Result:** `{ tiles: [...] }` — the same array shape as `GET /dashboard` (§7.1).

### 3.4 `remove_from_dashboard`  *(agent, optional beat)*

- **Input:** `{ vizId: string }`. Remove from `registry` (idempotent). Result: `{ removed: boolean }`.

### 3.5 No `get_viz_data` tool  *(removed)*

There is deliberately **no** MCP tool for re-pulling a viz's data. It would be inert: the pane widget
renders from the `html` (baked `rows`) returned by `create_visualization` (§4.3), and a plain
`tools/call` result does **not** re-render an already-drawn MCP Apps widget (only the tool bound to the
viewer resource does). So such a tool could neither refresh the pane nor the tile — it would only hand
raw rows back to the model as text.

Data refresh is a **web-plane** concern, not an MCP-tool concern. The dashboard tile (and, later, the
PCF component) re-pulls fresh rows via HTTP `GET /tiles/{id}/data?k=<tileKey>` (§7), which re-runs the
same bound SQL — one source of truth per viz. If a live in-pane ↻ is ever wanted, wire the viewer to
re-invoke `create_visualization` (which owns the resource binding and can re-inject updated `html`),
not a separate data tool.

---

## 4. Visualization rendering — proven MCP Apps pattern (static viewer + `structuredContent.html` + nested srcdoc)

This follows the **verified-working** architecture of the reference project `GenUI_MCP` (§0.1) — the
same pattern shipped into an M365 Copilot declarative agent. The LLM authors the **chart core once**;
the server assembles it into a self-contained HTML document and delivers that document two ways:
inline to the pane (via the tool result) and served as a tile URL to the Power App. The server never
trusts the LLM to emit host-bridge plumbing (the §3.4 Add handler, the data adapters) — that is
templated.

**Key design fact (why this is robust):** the pane widget does **not** reach our server by external
`fetch` or external `<iframe src>`. The finished HTML travels inside `structuredContent.html` and is
injected into a **nested `<iframe srcdoc=…>`** inside a single static viewer resource. The chart's
inline `<script>` runs inside that nested iframe's own document — no host `unsafe-eval`, no per-viz
MCP resource, no external-domain dependency. Because our charts are **vanilla (no CDN)**, we declare
**no `resourceDomains`/`connectDomains` at all** — eliminating the one CSP risk `GenUI_MCP` flags
(its §9.2, where a strict host could block its CDN imports).

### 4.1 The chart-core contract (LLM output)

The model returns `renderCore`: a string of **vanilla** JS defining exactly:

```js
function render(container, rows) { /* build chart from rows using only DOM/Canvas/SVG */ }
```

- No imports, no `fetch`, no network, no third-party libs, no `<script src>`. Pure function of
  `(container, rows)`. Must render legibly at ~420×300 (tiles live in ~480×320 iframes).
- `rows` is an array of plain objects (result rows; column names as keys).
- The server validates `renderCore` is a single function declaration with no forbidden tokens
  (`import`, `require`, `fetch`, `XMLHttpRequest`, `eval`, `new Function`, external `//` URLs) before
  use; on failure → repair or fail (§9).

### 4.2 `assembleDocument(renderCore, dataSource, opts)` — one core, two data modes

A server-side function (adapt `GenUI_MCP/src/assemble-document.ts`) that emits a **self-contained
HTML document**: theme CSS (light/dark, driven by a `set-theme` postMessage), the inlined
`renderCore` as an inline `<script>`, a **resize bridge** (posts `widget-resize` to the parent so the
viewer sizes the iframe — reuse GenUI's), a minimal inner meta-CSP (`default-src 'none'; script-src
'unsafe-inline'; style-src 'unsafe-inline'; img-src data:` — **no external domains**, since vanilla),
and a `#chart` mount. Two `dataSource` modes:

- **`inline` (pane):** the initial `rows` are baked into the document; on load it calls
  `render(chart, BAKED_ROWS)`. No network. Used for `structuredContent.html` (§3.1).
- **`fetch` (tile):** the document `fetch('/tiles/{vizId}/data?k='+tileKey)` on load and on the ↻
  control, then `render(chart, rows)`. Used for the served tile page (§4.4). Runs in the Power App,
  where fetch to our server works (CORS).

### 4.3 The pane widget = one static viewer resource `ui://ddb/viewer.html`

A single static, generic viewer (Vite `vite-plugin-singlefile` bundle — reuse `GenUI_MCP/mcp-app.ts`
+ `mcp-app.html`), registered once via `registerAppResource`. It:

- Boots **`App`** from `@modelcontextprotocol/ext-apps`; `app.onhostcontextchanged` applies host
  theme (via `applyDocumentTheme` / `applyHostStyleVariables`) and pushes `set-theme` to the nested
  iframe; `app.ontoolresult` reads `structuredContent.html` and injects it into
  `<iframe sandbox="allow-scripts allow-same-origin" srcdoc={html}>`; listens for `widget-resize` to
  size the iframe. (All of this is GenUI's proven viewer, reused verbatim.)
- **Our one addition — the Add-to-dashboard button in the viewer chrome** (outer document, which has
  the `App` instance; the nested srcdoc stays a pure chart). On click it runs the **verbatim §3.4
  handler**: `app.callServerTool({ name: 'add_to_dashboard', arguments: { vizId } })`, then fans out
  the `powerapps.copilot.chat.action` / `ddb.dashboard.updated` postMessage nudge to
  `window.top`/`parent`/`parent.parent` with `actionData: { vizId, title, vizType, tileUrl }` (from
  the `add_to_dashboard` result), then renders "✓ On your dashboard". `vizId` comes from
  `structuredContent.vizId`. Copy the handler block **exactly** from demo spec §3.4.

One static resource serves every viz; the per-viz chart arrives as `structuredContent.html`. (This
resolves the old "dynamic per-viz resource" question — there isn't one.)

### 4.4 The tile served page (HTTP `GET /tiles/{vizId}`)

`assembleDocument(renderCore, {mode:'fetch', vizId, tileKey})` — the same chart core, self-fetching
its data. Iframed by the PCF dashboard (`sandbox="allow-scripts allow-same-origin"`). ↻ re-fetches
(beat 5 "it's alive"). **No aggressive cache headers** (demo spec §3.2). No MCP SDK, no Add button.

The chart core is authored **once** by the model; §4.3 bakes it with rows for the pane, §4.4 wraps it
with a fetch for the tile. No second hand-authored rendering; no external framing anywhere.

---

## 5. OpenAI generation pipeline (§3.1 step 1)

### 5.1 Provider & call

- OpenAI.com API via the official `openai` Node SDK; `OPENAI_API_KEY` from env; model from
  `OPENAI_MODEL` (default `gpt-4o`).
- **Single structured-output call** (JSON schema / `response_format`) returning:
  `{ title: string, vizType: "bar"|"line"|"pie"|"kpi", sql: string, renderCore: string }`.
- System prompt establishes: the TDS SQL dialect and the **read-only, SELECT-only** rule; the
  render-core contract (§4.1, vanilla only); the vizType vocabulary; "prefer few, aggregate columns;
  alias columns to friendly names."

### 5.2 SQL constraints

- `SELECT`-only. Reject/repair any statement containing DML/DDL keywords (`INSERT`, `UPDATE`,
  `DELETE`, `DROP`, `ALTER`, `EXEC`, `MERGE`, `;` chaining) before execution — defense in depth even
  though the endpoint is read-only.
- Encourage `TOP`/`ORDER BY` for "most recent N" style asks; the schema doc (§5.3) names the
  `createdon` / status columns to use.

### 5.3 Schema grounding — `config/dataverse-schema.md` (curated)

A hand-maintained doc injected verbatim into the prompt, describing **only the demo's tables**:
logical/SQL table names, key columns, types, choice/status semantics, and 2–3 example NL→SQL pairs.
Example coverage: `opportunity` (name, estimatedvalue, createdon, statuscode), `contact`
(fullname, gendercode, createdon). Keep it small and accurate; it is the model's entire world.

> Tradeoff (accepted): brittle if the environment schema drifts or the user asks about a table not in
> the doc. Mitigation: the doc lists the covered tables explicitly and the system prompt instructs the
> model to return a friendly "I can only chart: …" error (surfaced per §9) for out-of-scope asks.
> Upgrade path (not built): runtime metadata introspection replaces the curated doc.

---

## 6. Dataverse data access

### 6.1 Primary: TDS (SQL) endpoint — feasibility confirmed

The Dataverse TDS/SQL endpoint accepts a **service-principal (client-credentials) access token**: acquire
a token for resource `https://<org>.crm.dynamics.com/` from
`https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token` with the provided ClientId/secret, then
attach it to the SQL connection (`.NET`: `conn.AccessToken`; **Node**: `tedious`/`mssql` with
`authentication.type = 'azure-active-directory-access-token'` or
`'azure-active-directory-service-principal-secret'`).

- **Target environment (confirmed 2026-07-02):** the demo Dataverse env
  (`https://<yourorg>.crm4.dynamics.com/`) — the TDS endpoint is **enabled**. Connection target:
  `Server=<yourorg>.crm4.dynamics.com,5558` (or 1433), `Database=<yourorg>`, `Encrypt=true`.
  (`crm4` = EMEA region.)
- **Read-only**; SELECT queries only (aligns with §5.2).
- **Remaining prerequisites to verify at first connection (Phase 3):**
  1. ~~TDS endpoint enabled~~ — ✅ confirmed enabled for this environment.
  2. Outbound **1433/5558** open from wherever the server runs (a corp network or cloud host may block
     1433 egress — the classic gotcha; localhost dev usually fine).
  3. The app registration is a Dataverse **application user** with read access to the demo tables.
- Node driver (`tedious` or `mssql`) is a server-side dependency — permitted (the vanilla-only rule is
  about the *browser* visualization, not the server).

### 6.2 Fallback: Web API (OData / FetchXML)

If any §6.1 prerequisite fails on the target environment, switch the data path to the Dataverse **Web
API** (`/api/data/v9.2`) using the same confidential-client token (resource = the org URL) via `fetch`.
The LLM then emits **FetchXML or an OData query** instead of SQL, and the render-core contract is
unchanged (still `render(container, rows)`; the server normalizes OData rows to plain objects).

Keep the data layer behind one interface (`runQuery(boundQuery): Promise<Row[]>`) so primary vs
fallback is a single swap and `vizStore` stores whichever `boundQuery` form is in use.

### 6.3 Token handling

One confidential-client token acquisition module, cached with expiry-aware refresh, shared by TDS
(and Web API fallback). ClientId/secret/tenant/org URL all from env (§8).

---

## 7. Web endpoints (implements demo spec §3.2) — consumed by the PCF and tiles

All HTTPS. `k` = capability token. Shapes below are **exact** (the built PCF depends on them).

### 7.1 `GET /dashboard?k=<dashboardKey>`
Returns the registry:
```json
{ "tiles": [ { "vizId": "…", "title": "…", "vizType": "bar",
              "tileUrl": "https://…/tiles/<vizId>?k=<tileKey>", "addedAt": "<iso>" } ] }
```

### 7.2 `GET /tiles/{vizId}?k=<tileKey>`
The **self-contained tile HTML** (§4.3). Framing allowed from `*.dynamics.com` (§8 headers).

### 7.3 `GET /tiles/{vizId}/data?k=<tileKey>`
Current rows JSON — re-runs the bound query (§6): `{ "rows": [ … ] }`. Called by the tile (path F).

### 7.4 `DELETE /tiles/{vizId}?k=<dashboardKey>`
Remove from `registry`. `204` on success; removing a missing tile is **also `204`** (idempotent).

**Auth:** every endpoint validates its `k` token (registry endpoints → `dashboardKey`; tile endpoints
→ that tile's `tileKey`). Missing/wrong token → `401`/`403`.

---

## 8. Security (implements demo spec §7)

1. **HTTPS everywhere.** Locally: self-signed on `https://localhost:8443` (document the one-time trust
   step), mirroring the mock. Mixed content is silently blocked inside the HTTPS Power App.
2. **Capability tokens** (§8.2 / demo spec §3.3): unguessable `dashboardKey` (long-lived, from env) +
   per-tile `tileKey` (**minted at `add_to_dashboard`**, §3.2). Server rejects missing/wrong tokens.
   Demo-grade by decision.
3. **CORS** on `GET /dashboard` and `DELETE /tiles/*` (called by the PCF via `fetch` from the app
   origin): answer `OPTIONS` preflight; `Access-Control-Allow-Origin: https://<org>.crm.dynamics.com`
   (or `*` demo-grade); `Access-Control-Allow-Methods: GET, DELETE`.
4. **Framing** on `/tiles/*` (§8.3): **no** `X-Frame-Options`; `Content-Security-Policy: frame-ancestors
   https://*.dynamics.com https://*.crm*.dynamics.com` — the tile is iframed only by the Power App (the
   pane widget renders via `srcdoc`, not by framing the tile).
5. **No aggressive caching** on `/tiles/*` (the PCF reloads iframes to refresh).
6. **SQL safety** (§5.2): SELECT-only allowlist even though the endpoint is read-only.
7. **Render-core sanitization** (§4.1): reject non-vanilla / network-touching / `eval`-using cores.
8. Secrets (OpenAI key, Dataverse client secret, `dashboardKey`) only from env; never logged, never in
   any served HTML.

### 8.2 Token model

- `dashboardKey` — long-lived, from env; authorizes `GET /dashboard` and `DELETE /tiles/{id}`.
- `tileKey` — per tile, minted at `add_to_dashboard`, stored in `registry`; authorizes
  `GET /tiles/{id}` and `GET /tiles/{id}/data`.

### 8.3 The widget sandbox (the "domain security" seam) — resolved by the §4 pattern

MCP Apps widgets render in a **host-controlled sandboxed iframe** that blocks external connections and
frames **by default**, and `unsafe-eval` is not grantable. `_meta.ui.csp` only lets a server *declare
domain allowlists* (`connectDomains`/`resourceDomains`/`frameDomains`); M365 Copilot / Cowork is
documented to **drop `connectDomains`/`resourceDomains`**, and `frameDomains` honoring varies by host.
This is exactly why the pane widget must **not** depend on reaching our server by external `fetch` or
external `<iframe src>`.

**The §4 pattern sidesteps all of it** (per the proven `GenUI_MCP`, §0.1): the chart HTML travels in
`structuredContent.html` and renders in a **nested `srcdoc` iframe** — no external network, no external
frame. The nested doc carries its **own** minimal meta-CSP (§4.2), and because our charts are **vanilla
(no CDN)** we declare **no external domains** — so host CSP variance cannot break rendering. The only
`callServerTool` the widget makes is `add_to_dashboard` (a control action, the sanctioned pattern).

Framing headers on `/tiles/*` (§8 item 4) therefore only need to satisfy the **Power App** (the tile is
iframed by the PCF, not by the pane): `frame-ancestors https://*.dynamics.com …`.

Production path (talk-track only, not built): Entra ID in front of the server; tiles do MSAL in-iframe
or move behind app-proxy/API-management. (demo spec §3.3.)

---

## 9. Error handling, logging & diagnostics

### 9.1 Error modes

| Failure | Handling |
|---|---|
| OpenAI returns invalid/non-conforming JSON | One retry with schema reminder; then tool error with a friendly message |
| Generated SQL errors on execution | One bounded repair (feed DB error back to the model); then fail cleanly — `create_visualization` returns a tool error, no viz stored |
| Out-of-scope ask (table not in schema doc) | Model instructed to signal it; tool returns a friendly "I can chart: opportunities, contacts, …" message, no viz stored |
| `renderCore` fails sanitization (§4.1) | Treat as generation failure → repair/fail |
| `/tiles/{id}/data` query fails at refresh time | Tile shows an inline "couldn't refresh" state; last-good render stays; never 500 the whole tile page |
| `add_to_dashboard` for unknown `vizId` | Tool error (viz must exist in `vizStore` first) |
| Dataverse token acquisition fails | Startup/first-call error surfaced clearly (likely misconfigured client/secret/tenant) |

Every tool error returns a human-readable message the agent can relay; the widget's §3.4 handler
already renders `err.message` (demo spec §3.4). **Every error message ends with `(log: <runId8>)`** so a
user-visible failure points straight at its log file (§9.2).

### 9.2 Logging (design it in from day one)

This server has more moving parts than a plain tool server — an LLM call, a SQL query, an assembly
step, and a web plane hit by the PCF/tiles — and when a demo misbehaves you need to see *which* stage
failed without a debugger. Reuse and generalize `GenUI_MCP/src/logger.ts` (per-call JSONL + compact
stderr mirror). Two log scopes:

- **Per-tool-call log** — one JSONL file per MCP tool invocation:
  `logs/<ts>_<tool>_<runId8>.jsonl`. Each call opens a logger with a fresh `runId` and records a line
  per stage, so a single file tells the whole story of one `create_visualization`:
  | Stage | Fields logged |
  |---|---|
  | `tool.start` | tool, runId, redacted args (the NL `description`) |
  | `openai.request` / `openai.response` | model, prompt length, **latency ms**, token usage, parsed `{ title, vizType, sqlLen }` (full `sql`/prompt only at `LOG_LEVEL=debug`) |
  | `openai.repair` | the DB/validation error fed back, attempt # |
  | `sql.exec` | `vizId`, **latency ms**, `rowCount` (full SQL + a small `rowsSample` only at debug) |
  | `sanitize` | `renderCore`/SQL verdict + which forbidden token tripped a reject |
  | `assemble.done` | `htmlLen`, mode (`inline`/`fetch`) |
  | `tool.end` | `{ ok, error? }` outcome |
- **Rolling HTTP log** — `logs/http.jsonl` (append) for the web plane + `/mcp`, which is *not* tied to a
  tool call: one line per request `{ t, method, path, tokenOk, status, ms, origin }`. This is the log
  you read when the PCF or a tile "does nothing" — it shows whether the request even arrived, whether
  the `k=` token matched (`tokenOk`, never the token value), the status, and CORS origin.

Cross-cutting rules:

- **stderr mirror** of every line as a compact `[ddb-mcp] [LEVEL] msg {…≤240ch}`. **VS Code surfaces
  MCP-server stderr in its "MCP: ddb-mcp" output channel**, so you watch the run live there with zero
  extra tooling; `tail -f logs/*.jsonl | jq` for the full detail.
- **`LOG_LEVEL`** (`debug|info|warn|error`, default `info`): files always capture through `info`;
  `debug` adds the full OpenAI prompt+raw response, full SQL, and a `rowsSample`. Never dump these at
  `info`.
- **Redaction is mandatory:** a single `redact()` helper keeps `OPENAI_API_KEY`, `AAD_CLIENT_SECRET`,
  `DASHBOARD_KEY`, and every `tileKey` out of logs — log token *validity/shape*, never the value.
  Startup logs a config summary with each secret shown as `set`/`missing` only.
- **Time everything external:** wrap the OpenAI call, each Dataverse query, and each whole tool call in
  a monotonic timer and log `ms` — latency is the first question when a host times a tool call out (a
  real risk; `GenUI_MCP` §10 notes 100 s+ generations tripping host caps).
- `logs/` is gitignored; no retention policy (manual cleanup), matching GenUI.

### 9.3 Diagnostics — `probe.ts` (`npm run probe`), host-free

A one-shot CLI (model on `GenUI_MCP/probe.ts`) to exercise the pipeline **without** an MCP host — the
fastest inner loop for the two real risks (Dataverse connectivity §6.1, generation quality §14.2):

- `npm run probe dataverse` — acquire the confidential-client token and run `SELECT TOP 1 …`; prints
  ok + latency. **Run this first** — it settles the §6.1 egress/app-user unknowns in one command.
- `npm run probe generate "<description>"` — full `create_visualization` pipeline minus MCP; writes the
  assembled document to `dist/probe-<ts>.html` (**open it in a browser to eyeball the chart**) and
  prints `{ title, vizType, sql, rowCount }`. This is how you tune prompts/model without VS Code.
- `npm run probe query "<vizId>"` — re-run a stored viz's bound SQL (mirrors `/tiles/{id}/data`) to
  debug refresh.

### 9.4 Standalone testing in VS Code

1. `npm run dev` (Vite watch for the viewer bundle + `tsx` watching the server) — or `npm run serve`.
   Server logs `listening on http://localhost:<PORT>/mcp (health: /health)`.
2. **`.vscode/mcp.json`** points VS Code at the HTTP transport:
   ```json
   { "servers": { "ddb-mcp": { "type": "http", "url": "http://localhost:3101/mcp" } } }
   ```
   For the standalone MCP loop, **plain HTTP on localhost is fine** — the HTTPS / self-signed cert and
   the tile/PCF framing concerns only bind once the PCF is in the loop (Phase 4), so certs don't block
   VS Code testing. (A `--stdio` variant also works: `"command": "npx", "args": ["tsx","main.ts","--stdio"]`.)
3. Ask the model in VS Code Chat to create a visualization → the tool runs, the **viewer renders in the
   MCP Apps panel**; watch the "MCP: ddb-mcp" output channel for the live stderr trace, and open the
   per-call `logs/*.jsonl` if a stage failed. (If a given VS Code build doesn't render MCP Apps UI, use
   `ext-apps`' `basic-host` — `GenUI_MCP` used it — as a standalone renderer.)
4. Exercise the web plane the PCF will use, with `curl`, before the PCF exists:
   `curl -k "http://localhost:3101/dashboard?k=$DASHBOARD_KEY"`, then a tile URL from `add_to_dashboard`
   — `logs/http.jsonl` confirms token checks and status.

Suggested order: **probe dataverse → probe generate (open the HTML) → VS Code create_visualization →
add_to_dashboard → curl the web endpoints.** Each step isolates one layer, so a failure is localized.

---

## 10. Configuration (env)

| Var | Purpose |
|---|---|
| `PORT` / `TLS_CERT` / `TLS_KEY` | HTTPS listener (self-signed locally) |
| `PUBLIC_BASE_URL` | Base for minted `tileUrl` (e.g. `https://ddb-demo.example.com`) |
| `DASHBOARD_KEY` | The registry capability token (`k` for `/dashboard` + `DELETE`) |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | OpenAI.com API (default model `gpt-4o`) |
| `DATAVERSE_ORG_URL` | The target environment's org URL (e.g. `https://<yourorg>.crm4.dynamics.com`) |
| `AAD_TENANT_ID` / `AAD_CLIENT_ID` / `AAD_CLIENT_SECRET` | Confidential client (provided by user) |
| `DATA_PATH` | `tds` (default) or `webapi` — selects the §6 data path |
| `STATE_FILE` | JSON persistence path for `vizStore` + `registry` |
| `LOG_LEVEL` | `debug\|info\|warn\|error` (default `info`) — §9.2; `debug` logs full prompts/SQL/rows |
| `LOG_DIR` | log output dir (default `logs/`, gitignored) |

---

## 11. Repo layout

```
DynamicDashboard/
├── mcp-server/                     # THIS spec
│   ├── main.ts                     # entry: HTTPS listener; Streamable-HTTP /mcp + --stdio; stray-rejection guard  (reuse GenUI main.ts)
│   ├── server.ts                   # createServer(): registerAppTool (§3) + registerAppResource(viewer) (reuse GenUI server.ts)
│   ├── mcp-app.html                # viewer entry (reuse GenUI)
│   ├── vite.config.ts              # bundles viewer → dist/mcp-app.html single file (reuse GenUI)
│   ├── src/
│   │   ├── mcp-app.ts              # viewer runtime: App, ontoolresult→srcdoc inject, theme+resize, Add button (§4.3, extend GenUI)
│   │   ├── web.ts                  # §7 web endpoints (/dashboard, /tiles/*, DELETE)
│   │   ├── generate.ts             # OpenAI pipeline (§5): NL → {title,vizType,sql,renderCore}
│   │   ├── dataverse.ts            # runQuery(): TDS primary / Web API fallback (§6) + token cache
│   │   ├── assemble-document.ts    # §4.2 assembleDocument(renderCore, dataSource): inline|fetch (adapt GenUI)
│   │   ├── store.ts                # vizStore + registry, JSON-file persisted (§2)
│   │   ├── security.ts             # token check, CORS, framing, SQL/render sanitization (§8)
│   │   └── logger.ts               # per-call JSONL + stderr mirror + redact() (§9.2, reuse GenUI)
│   ├── probe.ts                    # §9.3 host-free CLI: probe dataverse|generate|query (model on GenUI probe.ts)
│   ├── config/dataverse-schema.md  # curated schema doc (§5.3)
│   ├── .vscode/mcp.json            # §9.4 VS Code MCP endpoint
│   ├── dist/                       # built viewer bundle (gitignored)
│   ├── logs/                       # per-call + http JSONL logs (gitignored)
│   ├── .env.example
│   └── package.json
```

Reuse-from-GenUI files are noted inline (§0.1).

---

## 12. Build plan

1. **Skeleton + state + logging** — HTTP(S) listener, `/mcp` transport + `/health` wired, `store.ts`
   with JSON persistence, env/config, and **`logger.ts` first** (§9.2: per-call JSONL, `http.jsonl`,
   stderr mirror, `redact()`). Stand up `probe.ts` (§9.3) and `.vscode/mcp.json` (§9.4) now so every
   later phase is observable and host-free-testable from the start.
2. **Web endpoints against static data** — implement §7 (all four) returning canned data; run the
   **existing PCF** against it and confirm parity with the mock (this proves the seam before any LLM
   or Dataverse work).
3. **Dataverse data layer** — `dataverse.ts` `runQuery()`; confirm §6.1 with **`npm run probe
   dataverse`** (settles egress/app-user in one command); wire `/tiles/{id}/data` to
   real queries. Fall back to §6.2 if blocked.
4. **Viewer + srcdoc (reuse GenUI)** — port `mcp-app.ts`/`mcp-app.html`/`assemble-document.ts`/
   `server.ts`/`main.ts` from `GenUI_MCP`; register the static `ui://ddb/viewer.html` resource; verify
   an MCP client renders an `assembleDocument({mode:'inline'})` doc via `srcdoc`.
5. **OpenAI generation** — `generate.ts` + `dataverse-schema.md`; iterate quality with **`npm run probe
   generate`** (open the HTML) before touching the host; then `create_visualization` end-to-end
   (NL → SQL validated → renderCore → `assembleDocument` → `structuredContent.html`). Repair/error
   paths (§9). Same `renderCore` also drives the `mode:'fetch'` tile page.
6. **`add_to_dashboard` / `list` / `remove`** + the viewer's Add button (§4.3): registry promotion,
   `tileKey` minting, idempotency, the §3.4 nudge.
7. **Security hardening** — §8 pass: tokens enforced, CORS/framing headers, SQL/render sanitization.

---

## 13. Verification (parity-first)

- **Standalone-first (host-free):** `npm run probe dataverse` (data path ok), `npm run probe generate
  "…"` (chart HTML opens in a browser), then VS Code `create_visualization` renders the viewer — all
  before the PCF/agent exist (§9.4). Each failure is localized by its `logs/*.jsonl`.
- **Contract parity:** point the **existing PCF** and the demo spec's `mock-widget.html` at this
  server; every §10 check in the demo spec passes unchanged (dashboard renders, ↻ moves numbers via
  real Dataverse, ✕ deletes and survives Refresh, nudge → tile appears).
- **MCP surface:** an MCP client (or the agent) calls `create_visualization` → the viewer renders the
  chart in the pane (from `structuredContent.html` via `srcdoc`); its **Add** button → tile lands on
  the PCF within ~1s.
- **Data truth:** edit an opportunity → the dashboard tile's ↻ shows the new number — same bound SQL,
  one source of truth.
- **Security spot-checks:** tile URL without `k=` → 401/403; `GET /dashboard` cross-origin without CORS
  blocked; SELECT-only allowlist rejects a crafted DML `query`; a render-core with `fetch` is rejected.
- **Reset:** clear `STATE_FILE` (or restart) → empty dashboard.

---

## 14. Open items to confirm before/at implementation

The prior widget-strategy spike and the "dynamic MCP resource" question are **resolved** by adopting
the proven `GenUI_MCP` pattern (§0.1, §4): one static viewer + `structuredContent.html` + `srcdoc`, no
external framing. What remains is routine verification, none of it gating the design:

1. **TDS end-to-end — ✅ VERIFIED (2026-07-02)** against the demo environment:
   `npm run probe dataverse` acquired a service-principal token and ran a `SELECT` (~3.3 s cold);
   `npm run probe generate` ran real generated SQL returning live opportunity rows. Egress on 5558 and
   app-user read access are confirmed working. (§6.2 Web API fallback remains a stub, unneeded.)
2. **Generation quality — ✅ VERIFIED across `bar`/`pie`/`line`/`kpi`** (`gpt-4o`, single call each):
   all produced valid T-SQL (incl. `FORMAT`/`YEAR`/`GETDATE`, `CASE`, `SUM`) against the live schema and
   clean vanilla SVG `render(container, rows)` following the `label`/`value` convention. *Eyeball the
   `dist/probe-*.html` outputs for visual polish before the stage demo*; enrich the §5.1 prompt or bump
   the model if any looks weak. (Note: the render-core sanitizer must allow W3C namespace URIs like
   `http://www.w3.org/2000/svg` — required by `createElementNS`; handled in `security.ts`.)
3. **ext-apps version pin:** verified `@modelcontextprotocol/ext-apps@^1.7.1` (`registerAppTool` /
   `registerAppResource` / `RESOURCE_MIME_TYPE`); installed and type-checks clean.
4. **`vizType` vocabulary** must match whatever the mock/PCF special-case (if anything); default
   `bar|line|pie|kpi`.

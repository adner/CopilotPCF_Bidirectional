# Power Apps ↔ M365 Copilot Integration Reference

The single reference for the integration seam this demo is built on: how a PCF control inside a
model-driven Power App talks to the M365 Copilot pane, how an MCP Apps widget in that pane talks
back to the app, and how the `DDB.DynamicDashboard` control uses those mechanisms.

This doc covers the **client-side integration** (PCF + widget + bridge). The **server** design —
tools, generation pipeline, web endpoints, security — is `../spec.md` (code comments cite it as
`§3`, `§7`, etc.).

---

## 1. The Xrm.Copilot API surface

Power Apps exposes two distinct API tracks under `Xrm.Copilot`:

### Track 1 — M365 Copilot sidebar (what this demo uses)

Opens and drives the M365 Copilot panel from form scripts or PCF controls.

| API | Description |
|-----|-------------|
| `Xrm.Copilot.openM365CopilotPanel()` | Opens the M365 Copilot sidebar |
| `Xrm.Copilot.sendPromptToM365Copilot(text, options)` | Sends a prompt to the sidebar; Copilot responds on behalf of the user |
| `Xrm.Copilot.isM365CopilotEnabled()` | Guard check before using the above |
| `Xrm.Copilot.addActionHandler(actionName, handler)` | Registers a handler for custom actions posted back from Copilot widgets |
| `Xrm.Copilot.getCurrentAgent()` | Returns the active agent (`{ agentId, mode }`) |

`sendPromptToM365Copilot` options:

- `gptId` — id of a specific declarative agent to target. An **opaque string**, not a plain GUID:
  per Microsoft's time-tracker sample it has the form `T_<guid>` (tenant-scoped) or
  `U_<guid>.declarativeAgentPowerApps` (user-scoped), and is passed to Copilot verbatim. For an
  ATK-provisioned agent this is the `M365_TITLE_ID` in `env/.env.dev` (not the `TEAMS_APP_ID`).
  The platform can re-mint it on republish; confirm the live value with
  `Xrm.Copilot.getCurrentAgent()` in DevTools while the agent is open in the pane.
- `autoSubmit` — `false` places the prompt in the input box unsubmitted; `true` submits it
  immediately (this demo uses `true`, so a chart renders without a second click).

### Track 2 — Copilot Studio topic execution (preview; not used here)

Silently calls a Copilot Studio topic and returns structured JSON (`MCSResponse[]`) — no sidebar:
`Xrm.Copilot.executeEvent/executePrompt` (form scripts), `Context.Copilot.executeEvent/executePrompt` (PCF).

### How a PCF control reaches the sidebar APIs

PCF's own `Context.Copilot` does **not** expose the sidebar APIs. The proven workaround (from
Microsoft's [time-tracker sample](https://github.com/matthidinger/powerapps-timetracker-copilot-sample))
is reading `window.Xrm.Copilot` directly:

```ts
const copilot = (window as unknown as { Xrm?: { Copilot?: CopilotApi } }).Xrm?.Copilot;
if (!copilot?.sendPromptToM365Copilot) {
  // error path: control must run hosted inside the model-driven app
}
await copilot.openM365CopilotPanel();
await copilot.sendPromptToM365Copilot(prompt, { autoSubmit: true, gptId });
```

This only works when the PCF runs **inside a model-driven app**, where `window.Xrm` is ambient.
Always keep an explicit error path for when it is absent (PCF harness, canvas, custom pages).

### Custom page (canvas) limitations

A custom page is a canvas app embedded in an MDA — it runs in its own iframe and does **not** get
`window.Xrm`:

| Capability | MDA form/grid | Custom page |
|---|---|---|
| `openM365CopilotPanel()` / `sendPromptToM365Copilot()` | ✅ | ❌ |
| `addActionHandler()` via Xrm | ✅ | ❌ |
| Receive host actions via raw `postMessage` | ✅ | ✅ (frame-agnostic) |
| PCF `Context.Copilot.executeEvent/executePrompt` | ✅ | ✅ |

This is why the dashboard is hosted as the **default grid control of a hosting table** reached via
a sitemap subarea — a model-driven surface with `window.Xrm` — and never as a custom page.

---

## 2. The widget → app bridge (`powerapps.copilot.chat.action`)

MCP Apps widgets render inside the Copilot pane (a nested iframe). The MCP Apps SDK has **no**
method for posting to the host Power App — that uses a raw, officially documented `postMessage`
envelope:

```js
const message = {
  eventName: 'powerapps.copilot.chat.action',
  action: 'ddb.dashboard.updated',        // your namespaced action ID
  actionData: { vizId, title, vizType, tileUrl },
};
// Fan out to multiple ancestors — the widget is a nested iframe inside the pane,
// and the exact frame topology is not under our control:
for (const t of [window.top, window.parent, window.parent?.parent]) {
  try { if (t && t !== window) t.postMessage(message, '*'); } catch { /* next */ }
}
```

The envelope shape (`eventName`, `action`, `actionData`) is the official contract. The same
payload also works from Adaptive Cards via `Action.Submit` with
`data: { type: "PowerApps", action: "…", actionData: {…} }`.

### Receiving side — dual registration, always

Register **both** the official handler and a raw message listener:

```ts
Xrm.Copilot.addActionHandler('ddb.dashboard.updated', handler);       // official path
window.addEventListener('message', (e) => {                            // load-bearing fallback
  const d = e.data;
  if (d?.eventName === 'powerapps.copilot.chat.action' && d?.action === 'ddb.dashboard.updated')
    handler(d.actionData);
});
```

Because the pane is a nested iframe, `addActionHandler` routing can be unreliable; the raw
listener is the path that always works. Double delivery is expected — handlers must be idempotent.
Remove the listener in `destroy()`.

### postMessage hygiene

The nudge arrives via a `'*'`-target contract, so the listener must validate the message **shape**
strictly and treat it only as a **refresh trigger**: the authoritative state always comes from the
server (`GET /dashboard` with its capability token). A spoofed message can at worst cause an extra
fetch. Never render solely from `actionData` — the nudge can be missed or doubled; optimistic
rendering from it is fine as long as a reconciling fetch follows.

---

## 3. MCP Apps widgets in the Copilot pane

Widgets are self-contained HTML documents served as MCP resources and rendered by the pane. Built
with the MCP Apps SDK (`@modelcontextprotocol/ext-apps` — note `App` is a **named** export):

```js
const app = new App({ name: 'my-widget', version: '1.0.0' });
app.ontoolresult = (result) => render(result);          // data from the agent's tool call
app.onhostcontextchanged = (ctx) => applyTheme(ctx.theme);
await app.connect();
```

Key methods: `app.ontoolresult` (receive tool output), `app.callServerTool()` (widget → MCP server
direct call — this is how "Add to dashboard" works without an LLM hop), `app.sendMessage()`,
`app.getHostContext()`.

In this demo the widget is a single static viewer resource (`ui://ddb/viewer.html`, built from
`mcp-server/src/mcp-app.ts`) that renders whatever `structuredContent.html` a tool returns in a
nested `srcdoc` iframe — see `spec.md` §4.

---

## 4. How the demo wires it together

### Communication paths

| # | Path | Mechanism |
|---|---|---|
| A | App → Copilot | PCF's **Generate new report ✨** button: `openM365CopilotPanel()` + `sendPromptToM365Copilot(prompt, { autoSubmit: true, gptId })`, with a random pre-baked prompt from a curated list |
| B | Copilot → MCP server | The declarative agent (`DashboardAgent/`) calls the server's MCP tools; widgets render in the pane |
| C | Widget → MCP server | `app.callServerTool({ name: 'add_to_dashboard', arguments: { vizId } })` on button click |
| D | Widget → App | The `ddb.dashboard.updated` postMessage nudge (§2) — refresh trigger only |
| E | App → server | Plain HTTPS from the PCF: `GET /dashboard`, tile iframes, `DELETE /tiles/:vizId` |
| F | Tile → server | Each served tile fetches its own `GET /tiles/:vizId/data` on load and on ↻ |

Source of truth is the **server's singleton registry** (single-user demo, no identity model). If
the nudge (D) is missed, Refresh/polling converge on the same state via E.

### The PCF control (`controls/dynamic-dashboard/`, `DDB.DynamicDashboard`)

Standard (non-React) **dataset** PCF hosted full-page as the default grid control of an empty
hosting table (deployed as `cr19f_dashboard`); the dataset anchor is ignored — it only provides
the full-page surface. Manifest input properties:

| Property | Purpose |
|---|---|
| `serverBaseUrl` | HTTPS base URL of the MCP/web server (must match `external-service-usage` domain) |
| `dashboardKey` | Registry capability token (`k` for `/dashboard` + `DELETE`) — same value as the server's `DASHBOARD_KEY` |
| `agentId` | `gptId` of the declarative agent targeted by path A |
| `seedPrompt` | Optional fallback prompt (the button normally picks from its built-in list) |
| `autoRefreshSeconds` | Poll `/dashboard` every N seconds; 0/blank = nudge + manual Refresh only |

Behaviors that matter (all in `DynamicDashboard/index.ts`):

- **Diff by `vizId`** — `renderTiles()` adds/removes only what changed; recreating unchanged
  iframes would visibly reload every chart on each refresh.
- **In-place edits** — each tile carries `updatedAt`; when it changes (the agent called
  `update_visualization`), only that tile's iframe is reloaded.
- **Tile iframes** — `sandbox="allow-scripts allow-same-origin"`. `allow-same-origin` is
  deliberate and required: without it the iframe gets an opaque origin and the tile's self-fetch
  of its `/data` endpoint becomes a null-origin CORS failure. No `allow-top-navigation`,
  `allow-forms`, or `allow-popups`.
- **Nudge handling** — optimistic render from `actionData` when usable, then always
  `loadDashboard()` to reconcile.

### Security layers (client side)

1. **PCF manifest** — `external-service-usage enabled="true"` + the server domain. A declaration,
   not enforcement; changing the domain = manifest edit + version bump + `pac pcf push`.
2. **Environment CSP** (Power Platform admin center) — off by default; if enabled, the server
   domain must be in `connect-src` (registry fetch/DELETE) and `frame-src` (tile iframes). Check
   the target environment before demo day.
3. **HTTPS everywhere** — the app is HTTPS, so an `http://` server URL is silently blocked as
   mixed content. Hence the devtunnel in development.
4. **Capability URLs** — unguessable `k=` tokens per tile + for the registry; demo-grade by
   explicit decision (no login, no cookies). Server-side enforcement: `spec.md` §8.
5. **Tile framing** — the server sends `Content-Security-Policy: frame-ancestors` on `/tiles/*`
   (configurable via `TILE_FRAME_ANCESTORS`; includes `https://*.dynamics.com` and the local
   harness origin).

### Pitfalls (hard-won)

- **Opaque-origin fetches** — forgetting `allow-same-origin` in the tile sandbox: charts render
  once and never refresh.
- **Mixed content** — `http://localhost` server inside the HTTPS app fails silently.
- **Manifest domain drift** — `external-service-usage` domains are baked in; a new tunnel URL
  means edit + version bump + push. Prefer one stable hostname.
- **UCI caching** — bump the control version on every push or UCI serves a stale bundle.
- **Full re-render flicker** — always diff tiles by `vizId`.
- **Registry/nudge divergence** — never trust `actionData` as the source of truth.
- **Model-driven surface required** — `window.Xrm` does not exist in custom pages or the PCF
  harness; path A degrades with an explicit error status.

---

## 5. External references

- [Xrm.Copilot API reference](https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/clientapi/reference/xrm-copilot)
- [Agent Xrm APIs overview](https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/clientapi/bring-intelligence-using-agent-apis)
- [PCF Agent APIs](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/bring-intelligence-using-agent-apis)
- [SendPromptToM365CopilotOptions](https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/clientapi/reference/xrm-copilot/sendprompttom365copilotoptions)
- [Microsoft time-tracker sample](https://github.com/matthidinger/powerapps-timetracker-copilot-sample) — the proven pattern source for the PCF ↔ Copilot bridge

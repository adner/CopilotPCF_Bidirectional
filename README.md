# Dynamic Dashboard — chat a dashboard into existence with M365 Copilot

A demo where a user **chats data visualizations into existence in M365 Copilot** and publishes
them as **live tiles on a Power Apps dashboard** — without ever leaving the conversation.

> *"Show me a bar chart of open opportunities by month."*
> *"Actually, make it a pie chart instead."*
> *"Nice — add it to my dashboard."*

Each request goes to a **declarative agent** backed by a custom **MCP server**. The server turns
natural language into a Dataverse SQL query plus a vanilla-JS chart (one LLM call, structured
output), renders it as an **MCP Apps widget** in the Copilot pane, and — when the user clicks
**Add to dashboard** — serves the same visualization as a self-refreshing HTML tile that a **PCF
control** in a model-driven Power App picks up within a second. One generated artifact, rendered
two ways.

## The demo, in six beats

1. **Empty dashboard** — a full-page PCF control in the model-driven app: "No reports yet."
2. **Ask** — click **Generate new report ✨**; the Copilot pane opens and submits a starter prompt.
3. **Generate & iterate** — the agent calls the server; a chart widget renders in the pane.
   Iterate conversationally — each turn refines the same visualization.
4. **Publish** — click the widget's **Add to dashboard** button. The tile animates onto the
   dashboard *behind the pane* (a `postMessage` nudge tells the PCF to re-fetch).
5. **It's alive** — edit a record in the app, hit ↻ on the tile: the number moves. Tiles are
   served UI with a real data path, not screenshots.
6. **Manage** — remove tiles with ✕, or ask the agent *"what's on my dashboard?"*.

## Architecture

```
┌────────────────────────── Model-driven app (browser tab) ────────────────────────────────┐
│  ┌── PCF: DDB.DynamicDashboard (full-page) ────────┐   ┌── M365 Copilot pane ─────────┐  │
│  │  header: Generate new report ✨ · Refresh       │   │  Declarative agent           │  │
│  │  tile grid:                                     │(A)│   │ (B) MCP protocol         │  │
│  │   ┌─────────────┐ ┌─────────────┐               ├──▶│   ▼                          │  │
│  │   │ iframe      │ │ iframe      │               │   │  viz widget (MCP Apps)       │  │
│  │   │ /tiles/a?k= │ │ /tiles/b?k= │               │   │  [Add to dashboard] ──(C)──┐ │  │
│  │   └──────┬──────┘ └──────┬──────┘               │◀──┼──(D) postMessage nudge     │ │  │
│  │  'message' listener + addActionHandler          │   └────────────────────────────┼─┘  │
│  └────────┬──────────────────┬────────(E)──────────┘                                │    │
└───────────┼──────────────────┼──────────────────────────────────────────────────────┼────┘
            │(F) tile self-refresh                                                     │
            ▼                  ▼                                                       ▼
   ┌───────────────────────────────────────────────────────────────────────────────────────┐
   │  MCP + web server (Node/TS, one Express app, port 3101)                                │
   │  MCP:  create_visualization · update_visualization · add_to_dashboard ·                │
   │        list_dashboard · remove_from_dashboard                                          │
   │  HTTP: GET /dashboard · GET /tiles/:id · GET /tiles/:id/data · DELETE /tiles/:id       │
   │  NL → {SQL + render()} via one OpenAI structured-output call ── Dataverse (TDS/SQL)    │
   └───────────────────────────────────────────────────────────────────────────────────────┘
```

Key design points:

- **Generate once, wrap twice** — the LLM emits only a vanilla `function render(container, rows)`
  chart core; the server wraps it either with inlined rows (the pane widget) or with a data-fetch
  loop (the served tile). Same chart, two hosts.
- **Vanilla-only rendering, enforced** — no CDNs, no chart libraries, no `fetch`/`eval` inside
  generated code, so the output is immune to host CSP variance. A sanitizer rejects violations,
  and SQL is validated *by executing it* (read-only) with a 2-attempt LLM repair loop.
- **Capability URLs** — every exposed endpoint is gated by an unguessable token. Demo-grade auth
  by explicit decision: no login, HTTPS only, not production.
- **The nudge** — publishing fans out a `powerapps.copilot.chat.action` postMessage that the PCF
  treats purely as a "re-fetch now" trigger; the server registry stays the single source of truth.

## Repo layout

| Path | What it is |
|---|---|
| [`mcp-server/`](mcp-server/) | The server: MCP tools + web plane, NL→viz pipeline, Dataverse access, security. See its [README](mcp-server/README.md) for setup. |
| [`DashboardAgent/`](DashboardAgent/) | The M365 Copilot declarative agent (Microsoft 365 Agents Toolkit project) that fronts the MCP server. |
| [`controls/dynamic-dashboard/`](controls/dynamic-dashboard/) | The `DDB.DynamicDashboard` PCF control — the dashboard surface inside the Power App. |
| [`spec.md`](spec.md) | The authoritative server design (code comments cite its sections). |
| [`references/power-apps-copilot-integration.md`](references/power-apps-copilot-integration.md) | The client-side integration reference: Xrm.Copilot APIs, the widget→app bridge, PCF design, pitfalls. |
| [`CLAUDE.md`](CLAUDE.md) | Working notes for AI coding agents (architecture map, commands, conventions). |

## Running it

The repo ships with placeholders where your own values go — replace each before the
corresponding component will work:

| Placeholder | Where | Replace with |
|---|---|---|
| `https://your-server-host.example.com` | `DashboardAgent/appPackage/ai-plugin.json`, `DashboardAgent/.vscode/mcp.json`, `controls/dynamic-dashboard/DynamicDashboard/ControlManifest.Input.xml` | your server's HTTPS base URL (e.g. a devtunnel host) — the same value as `PUBLIC_BASE_URL` in `mcp-server/.env` |
| `https://yourorg.crm4.dynamics.com` | `mcp-server/.env` (from `.env.example`) | your Dataverse environment URL |
| blank IDs in `DashboardAgent/env/.env.dev` | — | filled in automatically when you provision the agent |
| `mcp-server/easteregg.jpg` | — | optional: swap the placeholder image for your own to personalize the `reveal_easter_egg` tool |

### 1. The server (`mcp-server/`)

Prereqs: Node 18+, an OpenAI API key, and an Entra ID app registration set up as a **Dataverse
application user** with read access (the server queries Dataverse over the TDS/SQL endpoint).

```bash
cd mcp-server
npm install
cp .env.example .env          # fill in OpenAI + AAD credentials, org URL, DASHBOARD_KEY
npm run probe dataverse       # verify credentials/connectivity (token + SELECT TOP 1)
npm run probe generate "open opportunity value by month as a bar chart"   # full pipeline, writes dist/probe-*.html
npm run build                 # bundle the widget viewer (required before serve)
npm run serve                 # MCP on http://localhost:3101/mcp, health on /health
```

`.vscode/mcp.json` points VS Code at the local server, so you can exercise the tools from any MCP
client before wiring the agent.

### 2. HTTPS exposure

The Copilot agent and the Power App both need to reach the server over **HTTPS** (tiles inside the
HTTPS app are otherwise blocked as mixed content). Expose port 3101 through a tunnel (e.g.
`devtunnel` with anonymous access) and set `PUBLIC_BASE_URL` in `.env` to the tunnel URL.

### 3. The agent (`DashboardAgent/`)

An Agents Toolkit project: open it in VS Code with the Microsoft 365 Agents Toolkit extension and
provision it to your tenant. `appPackage/ai-plugin.json` must point at your server's `/mcp` URL
(replace the placeholder). After provisioning, note the agent's ID (`gptId`) — the PCF needs it.
It is an opaque id of the form `T_<guid>` (the `M365_TITLE_ID` written to `env/.env.dev`); to
confirm the live value, open the agent in the Copilot pane inside the Power App and run
`Xrm.Copilot.getCurrentAgent()` in the browser DevTools console.

### 4. The PCF control (`controls/dynamic-dashboard/`)

```bash
cd controls/dynamic-dashboard
npm install
npm start watch               # local harness on http://localhost:8181 (tile plane works; Copilot APIs don't — expected)
pac pcf push --publisher-prefix ddb   # deploy to your environment
```

Then, in the maker portal: bind the control as the default grid control of an empty hosting table,
add a **Dashboard** sitemap page for it in a model-driven app, and set the control properties —
`serverBaseUrl` (the HTTPS tunnel), `dashboardKey` (= the server's `DASHBOARD_KEY`), `agentId`
(the gptId from step 3). The manifest's `external-service-usage` domain must match the server
host; changing it requires a version bump + re-push.

## Security disclaimer

This is a **stage demo**, deliberately single-user with no identity model: dashboard composition
lives in a server-side singleton registry, and endpoints are protected only by capability tokens
over HTTPS. Anyone with a tile URL can read that tile. A production version would put the server
behind Entra ID (MSAL in the tiles, or an app proxy / API management layer in front).

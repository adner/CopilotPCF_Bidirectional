# Dynamic Dashboard

Chat a chart into existence in M365 Copilot, then pin it to a Power Apps dashboard.

> *"Show me a bar chart of open opportunities by month."*
> *"Make it a pie chart instead."*
> *"Nice, add it to my dashboard."*

You describe what you want in the Copilot pane. A [declarative agent](DashboardAgent/) hands the
request to a custom [MCP server](mcp-server/), which uses an LLM to turn it into a SQL query and a
small chart, then renders that chart right there in the chat. Click **Add to dashboard** and the
same chart shows up as a live tile in a model-driven app a second later. One thing generated, shown
in two places.

## How the demo goes

1. Open the app. The dashboard is empty — "No reports yet."
2. Click **Generate new report ✨**. The Copilot pane opens with a starter prompt.
3. The agent builds a chart and shows it in the pane. Keep talking to refine it.
4. Click **Add to dashboard**. The tile slides onto the dashboard behind the pane.
5. Change a record, hit ↻ on the tile — the numbers update. These are real, data-backed tiles, not
   screenshots.
6. Remove tiles with ✕, or just ask the agent what's on your dashboard.

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

A few decisions worth calling out:

- **Generate once, show twice.** The LLM only writes a plain `function render(container, rows)`.
  The server wraps that same core two ways: with the data baked in (the chat widget), or with a
  refresh loop (the dashboard tile).
- **Plain JS charts, nothing fetched at runtime.** No CDNs or chart libraries in the generated
  code, so it survives whatever content-security policy the host enforces. A sanitizer rejects
  anything that breaks the rule, and the SQL is checked by actually running it (read-only), with a
  couple of automatic repair attempts if it fails.
- **Capability URLs.** Every endpoint is gated by an unguessable token. This is demo-grade auth on
  purpose — no login, HTTPS only, not production.
- **The nudge.** Publishing sends a `postMessage` that just tells the dashboard to re-fetch; the
  server's registry is always the source of truth.

The client-side seam — how the PCF, the Copilot pane, and the widget actually talk to each other —
is written up in detail in
**[references/power-apps-copilot-integration.md](references/power-apps-copilot-integration.md)**.
Read that before touching the PCF or the widget bridge; it captures the Xrm.Copilot APIs, the
postMessage contract, and the pitfalls that cost real time.

## What's in here

| Path | What it is |
|---|---|
| [`mcp-server/`](mcp-server/) | The server: MCP tools, web endpoints, the NL→chart pipeline, Dataverse access. Setup in its [README](mcp-server/README.md). |
| [`DashboardAgent/`](DashboardAgent/) | The M365 Copilot declarative agent that fronts the server (Microsoft 365 Agents Toolkit project). |
| [`controls/dynamic-dashboard/`](controls/dynamic-dashboard/) | The `DDB.DynamicDashboard` PCF control — the dashboard surface. |
| [`spec.md`](spec.md) | The server design in full (code comments cite its sections). |
| [`references/power-apps-copilot-integration.md`](references/power-apps-copilot-integration.md) | The client-side integration reference (start here for PCF/widget work). |
| [`CLAUDE.md`](CLAUDE.md) | Working notes for AI coding agents. |

## Running it

The repo ships with placeholders where your own values go. Swap each one before the matching
component will work:

| Placeholder | Where | Replace with |
|---|---|---|
| `https://your-server-host.example.com` | `DashboardAgent/appPackage/ai-plugin.json`, `DashboardAgent/.vscode/mcp.json`, the PCF's `ControlManifest.Input.xml` | your server's HTTPS base URL (same as `PUBLIC_BASE_URL` in `mcp-server/.env`) |
| `https://yourorg.crm4.dynamics.com` | `mcp-server/.env` | your Dataverse environment URL |
| blank IDs in `DashboardAgent/env/.env.dev` | — | filled in when you provision the agent |
| `mcp-server/easteregg.jpg` | — | optional: swap in your own image for the `reveal_easter_egg` tool |

### 1. The server

You'll need Node 18+, an OpenAI API key, and an Entra ID app registration set up as a Dataverse
application user with read access (the server reads Dataverse over the TDS/SQL endpoint).

```bash
cd mcp-server
npm install
cp .env.example .env          # OpenAI + AAD credentials, org URL, DASHBOARD_KEY
npm run probe dataverse       # check credentials and connectivity
npm run probe generate "open opportunity value by month as a bar chart"   # full pipeline → dist/probe-*.html
npm run build                 # bundle the widget viewer (required before serve)
npm run serve                 # MCP on http://localhost:3101/mcp
```

### 2. HTTPS exposure

Both the agent and the Power App reach the server over HTTPS — an `http://localhost` URL gets
blocked as mixed content inside the app. Expose port 3101 through a tunnel (e.g. `devtunnel`) and
point `PUBLIC_BASE_URL` at the tunnel URL.

### 3. The agent

Open `DashboardAgent/` in VS Code with the Microsoft 365 Agents Toolkit extension and provision it
to your tenant. Point `appPackage/ai-plugin.json` at your server's `/mcp` URL first. After
provisioning, grab the agent's `gptId` — the PCF needs it. It's an opaque id like `T_<guid>` (the
`M365_TITLE_ID` in `env/.env.dev`); confirm the live value by opening the agent in the pane and
running `Xrm.Copilot.getCurrentAgent()` in DevTools.

### 4. The PCF control

```bash
cd controls/dynamic-dashboard
npm install
npm start watch               # local harness on :8181 (tiles work; Copilot APIs don't — expected)
pac pcf push --publisher-prefix ddb
```

Then in the maker portal: bind the control as the default grid control of an empty hosting table,
add a **Dashboard** sitemap page in a model-driven app, and set `serverBaseUrl` (the tunnel),
`dashboardKey` (= the server's `DASHBOARD_KEY`), and `agentId` (the gptId from step 3). The
manifest's `external-service-usage` domain has to match the server host — changing it means a
version bump and a re-push.

## Credit

The PCF ↔ Copilot bridge here follows the pattern Matt Hidinger worked out in his
[Power Apps time-tracker Copilot sample](https://github.com/matthidinger/powerapps-timetracker-copilot-sample),
which is what got this demo off the ground. Thanks, Matt.

## Security

This is a stage demo, single-user by design with no identity model. Dashboard state lives in one
server-side registry, and endpoints are protected only by capability tokens over HTTPS — anyone
with a tile URL can read that tile. A real version would sit behind Entra ID (MSAL in the tiles, or
an app proxy / API management layer in front).

## License

[MIT](LICENSE) © Andreas Adner

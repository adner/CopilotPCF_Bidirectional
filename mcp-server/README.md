# Dynamic Dashboard — MCP server

NL → Dataverse-backed visualization, served as an MCP App widget (M365 Copilot pane) **and** an
embeddable tile (Power App PCF). Full design: `../spec.md`. Proven rendering pattern: `GenUI_MCP`.

## 1. Configure

```bash
cp .env.example .env    # then edit .env
```

Fill in `.env`:

- `OPENAI_API_KEY`, `OPENAI_MODEL` (default `gpt-4o`)
- `AAD_TENANT_ID`, `AAD_CLIENT_ID`, `AAD_CLIENT_SECRET` (confidential client / service principal)
- `DATAVERSE_ORG_URL` (your environment's URL, e.g. `https://yourorg.crm4.dynamics.com`)
- `DASHBOARD_KEY` (any unguessable string for the demo)

The app registration must be a **Dataverse application user** with read access to the demo tables,
and outbound **1433/5558** must be open to the org host (TDS endpoint).

## 2. Install

```bash
npm install
```

## 3. Test standalone, host-free (fastest inner loop)

```bash
npm run probe dataverse
#   → acquires a token and runs SELECT TOP 1. Settles connectivity/creds in one command.

npm run probe generate "the value of the 5 most recently created opportunities in a bar chart"
#   → runs the full pipeline, writes dist/probe-<ts>.html — open it in a browser to see the chart.
```

## 4. Run + connect from VS Code

```bash
npm run build     # bundle the viewer once (dist/mcp-app.html)
npm run serve     # http://localhost:3101/mcp   (health: /health)
# or: npm run dev  (viewer watch + server watch)
```

`.vscode/mcp.json` already points VS Code at `http://localhost:3101/mcp`. Ask the model to create a
visualization; the viewer renders in the MCP Apps panel. Watch the **"MCP: ddb-mcp"** output channel
for the live stderr trace; open `logs/*.jsonl` for full per-call detail.

Exercise the web plane the PCF will use:

```bash
curl "http://localhost:3101/dashboard?k=$DASHBOARD_KEY"
# add a viz in the pane, then GET the tile URL that add_to_dashboard returned.
```

## Notes

- **HTTP is fine for standalone.** HTTPS/self-signed certs and tile framing matter only once the PCF
  is in the loop; they don't block VS Code testing.
- Logs (`logs/`), the viewer build (`dist/`), and `state.json` are gitignored.
- `DATA_PATH=webapi` (OData fallback) is stubbed — the TDS path is the default and is implemented.

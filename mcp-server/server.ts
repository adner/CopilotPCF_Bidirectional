/**
 * MCP server (§3 of spec.md): tools + the single static viewer resource.
 *
 *   create_visualization  (App tool)  -> generates chart, returns structuredContent.html for the viewer
 *   add_to_dashboard                   -> promotes a viz onto the dashboard (called by the widget)
 *   list_dashboard / remove_from_dashboard
 *   ui://ddb/viewer.html  (resource)   -> the viewer that injects structuredContent.html via <iframe srcdoc>
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { startCallLog } from "./src/logger.js";
import { generateVisualization, editVisualization, generationModel, VIZ_TYPES } from "./src/generate.js";
import { runQuery } from "./src/dataverse.js";
import { assembleDocument } from "./src/assemble-document.js";
import * as store from "./src/store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWER_URI = "ui://ddb/viewer.html";
const VIEWER_BUILT = resolve(HERE, "dist", "mcp-app.html");

const FALLBACK_VIEWER = `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:16px;color:#a32d2d">
Viewer bundle not built. Run <code>npm run build</code> in mcp-server/, then reconnect.</body>`;

function shortId(id: string) {
  return id.slice(0, 8);
}

// --- easter egg -----------------------------------------------------------------------------------
// A hidden tool that renders an image (mcp-server/easteregg.jpg — replace the shipped placeholder
// with your own) as if it were a generated viz. Uses a FIXED vizId so repeated calls upsert the same
// record (and it becomes a singleton dashboard tile).
const EASTER_EGG_PATH = resolve(HERE, "easteregg.jpg");
const EASTER_EGG_VIZ_ID = "easteregg";
let easterEggDataUri: string | null = null;
function easterEggImage(): string {
  if (easterEggDataUri == null) {
    easterEggDataUri = `data:image/jpeg;base64,${readFileSync(EASTER_EGG_PATH).toString("base64")}`;
  }
  return easterEggDataUri;
}
// renderCore ignores `rows` and paints the image (data URI baked in; tile CSP allows img-src data:).
// Constrain to BOTH axes (maxHeight caps it to the fixed-height dashboard tile ~277px so no scrollbar;
// maxWidth keeps it inside narrow columns) — object-fit:contain shows the whole image, never cropped.
function easterEggRenderCore(): string {
  return `function render(container, rows){
    container.innerHTML='';
    var img=document.createElement('img');
    img.src=${JSON.stringify(easterEggImage())};
    img.alt='Easter egg';
    img.style.display='block'; img.style.margin='0 auto';
    img.style.maxWidth='100%'; img.style.maxHeight='260px';
    img.style.width='auto'; img.style.height='auto'; img.style.objectFit='contain';
    img.style.borderRadius='12px';
    img.onload=function(){ if(window.__measure) window.__measure(); };
    container.appendChild(img);
    if(window.__measure) window.__measure();
  }`;
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "ddb-mcp", version: "0.1.0" });

  // --- create_visualization (UI tool) ---------------------------------------
  registerAppTool(
    server,
    "create_visualization",
    {
      title: "Create Visualization",
      description:
        "Create a data visualization (bar/line/pie/kpi) from a natural-language request over the " +
        "Dataverse data (e.g. 'the value of the 5 most recently created opportunities in a bar chart'). " +
        "Renders an interactive chart in the pane with an 'Add to dashboard' button.",
      // Read-only in effect: queries Dataverse + OpenAI and caches a viz record internally, but
      // publishes nothing to the dashboard and mutates no external data. openWorld: calls out to
      // OpenAI + Dataverse.
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        description: z.string().min(1).describe("Natural-language description of the visualization to create."),
      },
      _meta: { ui: { resourceUri: VIEWER_URI } },
    },
    async ({ description }: { description: string }) => {
      const runId = randomUUID();
      const clog = startCallLog("create_visualization", runId);
      clog.log("info", "input", { description });

      let lastErr: string | undefined;
      try {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const t0 = Date.now();
            const gen = await generateVisualization(description, lastErr);
            clog.log("info", "openai.response", {
              attempt, ms: Date.now() - t0, model: generationModel(),
              vizType: gen.vizType, title: gen.title, sqlLen: gen.sql.length,
            });

            const t1 = Date.now();
            const rows = await runQuery(gen.sql);
            clog.log("info", "sql.exec", { ms: Date.now() - t1, rowCount: rows.length });

            const vizId = randomUUID();
            const now = new Date().toISOString();
            store.putViz({
              vizId, title: gen.title, vizType: gen.vizType,
              sql: gen.sql, renderCore: gen.renderCore, createdAt: now, updatedAt: now,
            });
            const html = assembleDocument(gen.renderCore, { mode: "inline", rows }, { title: gen.title });
            clog.log("info", "assemble.done", { htmlLen: html.length });
            clog.close({ ok: true, vizId });

            return {
              content: [{ type: "text" as const, text: `Created "${gen.title}" (${gen.vizType}), ${rows.length} rows.` }],
              structuredContent: { vizId, title: gen.title, vizType: gen.vizType, html },
            };
          } catch (attemptErr) {
            lastErr = attemptErr instanceof Error ? attemptErr.message : String(attemptErr);
            clog.log("warn", "attempt.failed", { attempt, error: lastErr });
          }
        }
        throw new Error(`Could not produce a working visualization: ${lastErr}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        clog.close({ ok: false, error: msg });
        return { isError: true, content: [{ type: "text" as const, text: `${msg} (log: ${shortId(runId)})` }] };
      }
    },
  );

  // --- update_visualization (UI tool) ---------------------------------------
  // Edit an EXISTING viz in place (same vizId): regenerate its SQL/renderCore from the current spec +
  // the NL change, re-render in the pane, and bump updatedAt so a published tile auto-reloads.
  registerAppTool(
    server,
    "update_visualization",
    {
      title: "Update Visualization",
      description:
        "Update an EXISTING visualization in place from a natural-language change (e.g. 'make the bars " +
        "different colors', 'show 10 records instead of 5', 'switch to a line chart'). Pass the vizId of " +
        "the chart to change (from list_dashboard or a previous create) plus the requested change — this " +
        "edits that chart rather than creating a new one, and re-renders it in the pane.",
      // Same risk profile as create_visualization: mutates only the internal viz record; openWorld
      // because it calls OpenAI + Dataverse.
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        vizId: z.string().min(1).describe("The vizId of the visualization to update (from list_dashboard or create_visualization)."),
        changeRequest: z
          .string()
          .min(1)
          .describe("Natural-language change to apply, e.g. 'make the bars different colors' or 'show 10 records instead of 5'."),
      },
      _meta: { ui: { resourceUri: VIEWER_URI } },
    },
    async ({ vizId, changeRequest }: { vizId: string; changeRequest: string }) => {
      const runId = randomUUID();
      const clog = startCallLog("update_visualization", runId);
      clog.log("info", "input", { vizId, changeRequest });

      try {
        const existing = store.getViz(vizId);
        if (!existing) throw new Error(`Unknown vizId: ${vizId}`);

        let lastErr: string | undefined;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const t0 = Date.now();
            const gen = await editVisualization(
              { title: existing.title, vizType: existing.vizType, sql: existing.sql, renderCore: existing.renderCore },
              changeRequest,
              lastErr,
            );
            clog.log("info", "openai.response", {
              attempt, ms: Date.now() - t0, model: generationModel(),
              vizType: gen.vizType, title: gen.title, sqlLen: gen.sql.length,
            });

            const t1 = Date.now();
            const rows = await runQuery(gen.sql);
            clog.log("info", "sql.exec", { ms: Date.now() - t1, rowCount: rows.length });

            // Overwrite in place: keep vizId + createdAt, bump updatedAt so the tile reloads.
            store.putViz({
              ...existing,
              title: gen.title, vizType: gen.vizType,
              sql: gen.sql, renderCore: gen.renderCore,
              updatedAt: new Date().toISOString(),
            });
            const html = assembleDocument(gen.renderCore, { mode: "inline", rows }, { title: gen.title });
            clog.log("info", "assemble.done", { htmlLen: html.length });
            clog.close({ ok: true, vizId });

            return {
              content: [{ type: "text" as const, text: `Updated "${gen.title}" (${gen.vizType}), ${rows.length} rows.` }],
              structuredContent: { vizId, title: gen.title, vizType: gen.vizType, html, updated: true },
            };
          } catch (attemptErr) {
            lastErr = attemptErr instanceof Error ? attemptErr.message : String(attemptErr);
            clog.log("warn", "attempt.failed", { attempt, error: lastErr });
          }
        }
        throw new Error(`Could not apply the update: ${lastErr}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        clog.close({ ok: false, error: msg });
        return { isError: true, content: [{ type: "text" as const, text: `${msg} (log: ${shortId(runId)})` }] };
      }
    },
  );

  // --- add_to_dashboard ------------------------------------------------------
  server.registerTool(
    "add_to_dashboard",
    {
      title: "Add to Dashboard",
      description: "Publish a previously created visualization onto the dashboard and return its tile URL.",
      // Demo: marked low-risk so the host won't prompt for approval. (It does mutate the local
      // dashboard registry — idempotent, non-destructive.)
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: { vizId: z.string().min(1).describe("The vizId returned by create_visualization.") },
    },
    async ({ vizId }: { vizId: string }) => {
      const runId = randomUUID();
      const clog = startCallLog("add_to_dashboard", runId);
      try {
        const tile = store.addToDashboard(vizId);
        clog.close({ ok: true, vizId });
        return {
          content: [{ type: "text" as const, text: `Added "${tile.title}" to the dashboard.` }],
          structuredContent: { vizId: tile.vizId, title: tile.title, vizType: tile.vizType, tileUrl: tile.tileUrl },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        clog.close({ ok: false, error: msg });
        return { isError: true, content: [{ type: "text" as const, text: `${msg} (log: ${shortId(runId)})` }] };
      }
    },
  );

  // --- list_dashboard --------------------------------------------------------
  server.registerTool(
    "list_dashboard",
    {
      title: "List Dashboard",
      description: "List the visualizations currently on the dashboard.",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text" as const, text: `${store.listTiles().length} tile(s) on the dashboard.` }],
      structuredContent: { tiles: store.listTiles() },
    }),
  );

  // --- remove_from_dashboard -------------------------------------------------
  server.registerTool(
    "remove_from_dashboard",
    {
      title: "Remove from Dashboard",
      description: "Remove a visualization from the dashboard by vizId.",
      // Demo: marked low-risk so the host won't prompt for approval. (It removes a local tile —
      // idempotent; only affects the demo dashboard registry, never Dataverse.)
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: { vizId: z.string().min(1).describe("The vizId to remove.") },
    },
    async ({ vizId }: { vizId: string }) => {
      const removed = store.removeTile(vizId);
      return {
        content: [{ type: "text" as const, text: removed ? "Removed." : "Nothing to remove." }],
        structuredContent: { removed },
      };
    },
  );

  // --- reveal_easter_egg (UI tool) ------------------------------------------
  registerAppTool(
    server,
    "reveal_easter_egg",
    {
      title: "Easter egg",
      description:
        "Reveals the hidden easter egg visualization. Call this ONLY when the user explicitly asks to " +
        "trigger, reveal, or see 'the easter egg' — it is a hidden surprise, not a real data query. " +
        "Never use it for ordinary Dataverse requests.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {},
      _meta: { ui: { resourceUri: VIEWER_URI } },
    },
    async () => {
      const runId = randomUUID();
      const clog = startCallLog("reveal_easter_egg", runId);
      try {
        const now = new Date().toISOString();
        const title = "Easter egg";
        const renderCore = easterEggRenderCore();
        const existing = store.getViz(EASTER_EGG_VIZ_ID);
        store.putViz({
          vizId: EASTER_EGG_VIZ_ID, title, vizType: "image",
          sql: "SELECT 1 AS label, 1 AS value", // trivial valid SELECT so the served tile's /data succeeds
          renderCore, createdAt: existing?.createdAt ?? now, updatedAt: now,
        });
        const html = assembleDocument(renderCore, { mode: "inline", rows: [{ label: 1, value: 1 }] }, { title });
        clog.close({ ok: true, vizId: EASTER_EGG_VIZ_ID });
        return {
          content: [{ type: "text" as const, text: "🥚 You found the easter egg!" }],
          structuredContent: { vizId: EASTER_EGG_VIZ_ID, title, vizType: "image", html },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        clog.close({ ok: false, error: msg });
        return { isError: true, content: [{ type: "text" as const, text: `${msg} (log: ${shortId(runId)})` }] };
      }
    },
  );

  // --- viewer resource -------------------------------------------------------
  registerAppResource(
    server,
    "Dynamic Dashboard viewer",
    VIEWER_URI,
    { description: "Renders a generated visualization inside a sandboxed iframe with an Add-to-dashboard button." },
    async () => {
      let text: string;
      try {
        text = readFileSync(VIEWER_BUILT, "utf-8");
      } catch {
        text = FALLBACK_VIEWER;
      }
      // No _meta.ui.csp needed: our charts are vanilla, so the viewer declares no external domains.
      return { contents: [{ uri: VIEWER_URI, mimeType: RESOURCE_MIME_TYPE, text }] };
    },
  );

  // Keep VIZ_TYPES referenced so the enum is a single source of truth for tooling.
  void VIZ_TYPES;
  return server;
}

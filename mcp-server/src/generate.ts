/**
 * OpenAI generation pipeline (§5 of spec.md).
 * NL description + curated schema doc  ->  { title, vizType, sql, renderCore }.
 * A single structured-output call; the caller validates the SQL by executing it (§9 repair loop).
 */
import OpenAI from "openai";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config, requireConfig } from "./config.js";
import { sanitizeSql, sanitizeRenderCore } from "./security.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DOC_PATH = resolve(HERE, "..", "config", "dataverse-schema.md");

export const VIZ_TYPES = ["bar", "line", "pie", "kpi"] as const;
export type VizType = (typeof VIZ_TYPES)[number];

export interface GeneratedViz {
  title: string;
  vizType: VizType;
  sql: string;
  renderCore: string;
}

let schemaDoc: string | null = null;
function getSchemaDoc(): string {
  if (schemaDoc == null) {
    try {
      schemaDoc = readFileSync(SCHEMA_DOC_PATH, "utf-8");
    } catch {
      schemaDoc = "(no schema doc found — only generate queries you are confident about)";
    }
  }
  return schemaDoc;
}

let client: OpenAI | null = null;
function getClient(): OpenAI {
  requireConfig(["openaiApiKey"]);
  if (!client) client = new OpenAI({ apiKey: config.openaiApiKey });
  return client;
}

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", description: "Short chart title." },
    vizType: { type: "string", enum: [...VIZ_TYPES] },
    sql: {
      type: "string",
      description:
        "A single read-only T-SQL SELECT for the Dataverse TDS endpoint. Return friendly columns, " +
        "typically `label` (category) and `value` (number).",
    },
    renderCore: {
      type: "string",
      description:
        "Vanilla JS defining exactly `function render(container, rows){…}` that builds a POLISHED, " +
        "INTERACTIVE SVG chart. See the system prompt's DESIGN BRIEF for the full requirements " +
        "(responsive sizing, hover tooltips via the DDB helper, label handling, per-type styling). " +
        "`rows` is the SQL result (array of objects keyed by column name).",
    },
  },
  required: ["title", "vizType", "sql", "renderCore"],
} as const;

function systemPrompt(): string {
  return [
    "You generate beautiful, interactive data visualizations for a Microsoft Dataverse dashboard.",
    "Given a natural-language request, return a chart specification as structured JSON.",
    "",
    "=== SQL ===",
    "- `sql`: a SINGLE read-only T-SQL SELECT against the Dataverse TDS endpoint. SELECT only — no",
    "  INSERT/UPDATE/DELETE/DDL, no semicolons chaining statements. Use only tables/columns from the",
    "  schema below. Return friendly columns: `label` (category, string) and `value` (number).",
    "- `vizType`: one of bar | line | pie | kpi.",
    "",
    "=== renderCore DESIGN BRIEF ===",
    "Define EXACTLY `function render(container, rows){…}` in VANILLA JS building an SVG chart.",
    "NO import/require/fetch/eval/new Function, NO <script src>, NO external URLs or CDNs or web fonts",
    "(the only URL allowed is the SVG namespace http://www.w3.org/2000/svg). Self-contained only.",
    "",
    "A global helper `DDB` is ALREADY DEFINED — use it, do not redefine it:",
    "  • DDB.fmt(number) -> compact label string ('480k', '1.2M', '3,204').",
    "  • DDB.truncate(str, max) -> str shortened with an ellipsis.",
    "  • DDB.palette -> array of 10 vivid hex colors for categorical series.",
    "  • DDB.tooltip(container) -> { show(clientX, clientY, htmlString), hide() } — a floating hover",
    "    tooltip. Create ONE per render and reuse it. Pass raw mouse event.clientX/clientY.",
    "",
    "Colors: read theme CSS variables — text var(--fg), muted text var(--muted), gridlines var(--border),",
    "primary fill var(--accent) (secondary var(--accent2)). For multi-category use DDB.palette.",
    "",
    "REQUIREMENTS (apply to every chart):",
    " 0. Do NOT draw your own title/heading text — the widget already renders the title above your chart.",
    " 1. Reflow, don't scale: the harness RE-CALLS render(container, rows) on every resize, so recompute",
    "    the layout FRESH each call from const w = container.clientWidth || 440 and a height ~260. Set the",
    "    <svg> width=w height=h and viewBox='0 0 '+w+' '+h (so 1 unit = 1px). Never hard-code a wide fixed",
    "    width; the chart must fit its container and never overflow horizontally. Elements must REFLOW",
    "    (recompute positions), not merely shrink. You may append HTML (divs) alongside the SVG.",
    " 2. Hover: for each datum attach mouseenter/mousemove/mouseleave; on hover visibly emphasize it",
    "    (raise opacity/add stroke/enlarge) AND call tip.show(e.clientX, e.clientY,",
    "    '<b>'+label+'</b><br>'+DDB.fmt(value)); hide on mouseleave. Add a CSS transition for smoothness.",
    " 3. Labels must NEVER overlap: rotate x-axis labels ~-32deg (text-anchor:end) OR use",
    "    DDB.truncate(label, 12); always show the FULL label in the tooltip. Use var(--muted), ~11px.",
    " 4. Polish: rounded corners (rx 4-6), a subtle baseline, 3-4 light horizontal gridlines with value",
    "    ticks via DDB.fmt, generous padding, and value labels where they fit.",
    " 5. ATTACH EVERYTHING you create: every element/node built with createElement/createElementNS MUST be",
    "    appended into its parent, and the top-level node(s) appended to `container`. A created-but-never-",
    "    appended element renders NOTHING (a silent blank). Before finishing, confirm every `num`, `sub`,",
    "    `svg`, wrapper, legend row, etc. is reachable from `container` via appendChild.",
    "",
    "PER TYPE:",
    " • bar: vertical rounded bars with a small gap; subtle top-to-bottom gradient on var(--accent);",
    "   gridlines + y ticks; value shown on hover (and on top if it fits).",
    " • line: smooth path (Catmull-Rom/bezier) in var(--accent) with a soft area fill beneath",
    "   (accent at ~0.12 opacity); circle markers that enlarge on hover; x=label, y=value.",
    " • pie: prefer a DONUT (inner radius ~55%). Keep it COMPACT — diameter ~min(w, 240)px, NOT the full",
    "   width. Build a flex wrapper div (class=\"ddb-legend\" is available, or your own",
    "   display:flex;flex-wrap:wrap;gap:16px;align-items:center) holding the donut SVG and an HTML legend",
    "   of DIV rows (a color swatch + label + DDB.fmt(value)); flex-wrap makes the legend sit BESIDE the",
    "   donut when wide and STACK BELOW it when narrow. Slices use DDB.palette; hovered slice pops/brightens.",
    "   Do NOT bake the legend text into a wide SVG — that is what breaks resizing.",
    " • kpi: one large bold number (~48px, var(--accent)) via DDB.fmt, the metric name beneath in",
    "   var(--muted); centered vertically and horizontally. If multiple rows, show the first/aggregate.",
    "   Build a wrapper div, then append BOTH the number div and the label div INTO the wrapper, then",
    "   append the wrapper to container — e.g. wrap.appendChild(num); wrap.appendChild(sub);",
    "   container.appendChild(wrap);  (forgetting the inner appends yields an empty box).",
    "",
    "If the request cannot be satisfied from the schema, still return your best-effort SELECT over the",
    "closest available table.",
    "",
    "=== DATAVERSE SCHEMA ===",
    getSchemaDoc(),
  ].join("\n");
}

/** The repair-loop feedback clause, appended to the user message on a retry. */
function priorErrorClause(priorError?: string): string {
  return priorError
    ? `\n\nYour previous attempt failed with:\n${priorError}\nFix it and return a corrected specification.`
    : "";
}

/**
 * Shared structured-output call: one OpenAI request → parse → sanitize. Throws on empty/invalid
 * output or a sanitizer violation, so the caller's repair loop can feed the message back.
 */
async function runGeneration(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
): Promise<GeneratedViz> {
  const completion = await getClient().chat.completions.create({
    model: config.openaiModel,
    messages,
    response_format: {
      type: "json_schema",
      json_schema: { name: "visualization", strict: true, schema: RESPONSE_SCHEMA as unknown as Record<string, unknown> },
    },
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("OpenAI returned an empty response");

  let parsed: GeneratedViz;
  try {
    parsed = JSON.parse(raw) as GeneratedViz;
  } catch {
    throw new Error("OpenAI response was not valid JSON");
  }

  return {
    title: String(parsed.title || "Untitled"),
    vizType: (VIZ_TYPES as readonly string[]).includes(parsed.vizType) ? parsed.vizType : "bar",
    sql: sanitizeSql(String(parsed.sql || "")),
    renderCore: sanitizeRenderCore(String(parsed.renderCore || "")),
  };
}

/**
 * One generation attempt (create from scratch). `priorError` (if given) is fed back for a repair
 * attempt. SQL and renderCore are sanitized before return (throws if they violate the contract).
 */
export async function generateVisualization(
  description: string,
  priorError?: string,
): Promise<GeneratedViz> {
  return runGeneration([
    { role: "system", content: systemPrompt() },
    {
      role: "user",
      content: `Create a visualization for this request:\n\n${description}` + priorErrorClause(priorError),
    },
  ]);
}

/**
 * Edit an EXISTING visualization in place. The model receives the current spec and returns a COMPLETE
 * updated spec (same 4 fields) with only the requested change applied — used by `update_visualization`
 * so a tweak patches the chart rather than regenerating a different one. Reuses the same DESIGN BRIEF
 * (renderCore is regenerated) and the same 2-attempt repair loop via `priorError`.
 */
export async function editVisualization(
  current: { title: string; vizType: string; sql: string; renderCore: string },
  changeRequest: string,
  priorError?: string,
): Promise<GeneratedViz> {
  return runGeneration([
    { role: "system", content: systemPrompt() },
    {
      role: "user",
      content:
        `You are EDITING an existing visualization. Here is its CURRENT specification:\n\n` +
        `Title: ${current.title}\n` +
        `vizType: ${current.vizType}\n` +
        `SQL:\n${current.sql}\n\n` +
        `renderCore:\n${current.renderCore}\n\n` +
        `Apply ONLY this change:\n${changeRequest}\n\n` +
        `Return the COMPLETE updated specification (all four fields), preserving everything the change ` +
        `does not affect. Keep the same vizType unless the change clearly requires a different one.` +
        priorErrorClause(priorError),
    },
  ]);
}

/** Token usage / model info are logged by the caller; expose the model for logs. */
export function generationModel(): string {
  return config.openaiModel;
}

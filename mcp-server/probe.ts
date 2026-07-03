/**
 * Host-free diagnostics (§9.3 of spec.md).
 *
 *   npm run probe dataverse                 -> token + trivial SELECT (settles §6.1 quickly)
 *   npm run probe generate "<description>"  -> full generation pipeline; writes dist/probe-<ts>.html
 *   npm run probe query "<vizId>"           -> re-run a stored viz's SQL (mirrors /tiles/{id}/data)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { configSummary } from "./src/config.js";
import { checkConnectivity, runQuery, closePool } from "./src/dataverse.js";
import { generateVisualization, generationModel } from "./src/generate.js";
import { assembleDocument } from "./src/assemble-document.js";
import * as store from "./src/store.js";

function print(label: string, obj: unknown) {
  console.log(`\n${label}:\n` + JSON.stringify(obj, null, 2));
}

async function probeDataverse() {
  console.log("Checking Dataverse connectivity (token + SELECT TOP 1)…");
  const result = await checkConnectivity();
  print("dataverse", result);
  if (!result.ok) {
    console.log(
      "\nHints: confirm AAD_* creds in .env, that the app is a Dataverse application user with read access,\n" +
        "and that outbound port " + "5558/1433 is open to the org host.",
    );
    process.exitCode = 1;
  }
}

async function probeGenerate(description: string) {
  if (!description) throw new Error('Usage: npm run probe generate "your description"');
  console.log(`Generating (model=${generationModel()}) for: ${description}`);
  const t0 = Date.now();
  const gen = await generateVisualization(description);
  console.log(`  generated in ${Date.now() - t0}ms — ${gen.vizType} — "${gen.title}"`);
  console.log(`  SQL: ${gen.sql}`);

  console.log("Running the generated SQL…");
  const t1 = Date.now();
  const rows = await runQuery(gen.sql);
  console.log(`  ${rows.length} rows in ${Date.now() - t1}ms`);

  const html = assembleDocument(gen.renderCore, { mode: "inline", rows }, { title: gen.title });
  const dir = resolve("dist");
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const out = resolve(dir, `probe-${ts}.html`);
  writeFileSync(out, html);
  console.log(`\n✅ Wrote ${out} — open it in a browser to eyeball the chart.`);
  print("rowsSample", rows.slice(0, 3));
}

async function probeQuery(vizId: string) {
  if (!vizId) throw new Error('Usage: npm run probe query "<vizId>"');
  const viz = store.getViz(vizId);
  if (!viz) throw new Error(`Unknown vizId: ${vizId} (nothing in ${"state.json"})`);
  console.log(`Re-running SQL for "${viz.title}": ${viz.sql}`);
  const rows = await runQuery(viz.sql);
  print("rows", rows);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const arg = rest.join(" ").trim();
  print("config", configSummary());

  switch (cmd) {
    case "dataverse": await probeDataverse(); break;
    case "generate": await probeGenerate(arg); break;
    case "query": await probeQuery(arg); break;
    default:
      console.log(
        "\nUsage:\n" +
          "  npm run probe dataverse\n" +
          '  npm run probe generate "the value of the 5 most recently created opportunities in a bar chart"\n' +
          '  npm run probe query "<vizId>"',
      );
  }
}

main()
  .catch((err) => {
    console.error("\n❌ " + (err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  })
  .finally(() => closePool());

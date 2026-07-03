/**
 * Structured logging (§9.2 of spec.md), adapted from GenUI_MCP/src/logger.ts.
 *
 *  - Per-tool-call JSONL file: logs/<ts>_<tool>_<runId8>.jsonl  (one call = one file)
 *  - Rolling HTTP log:         logs/http.jsonl                    (web plane + /mcp)
 *  - Compact stderr mirror of every line (VS Code shows this in its MCP output channel)
 *  - redact() keeps secrets/tokens out of every sink.
 */
import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.js";

const LEVELS: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const stderrEnabled = (level: string) =>
  (LEVELS[level] ?? 2) <= (LEVELS[config.logLevel] ?? 2);

// Keys whose values must never be written to a log.
const SECRET_KEY = /(secret|apikey|api_key|password|token|dashboardkey|tilekey|clientsecret|^k$|authorization)/i;

/** Deep-copy `input`, replacing secret-ish keys with "***". */
export function redact(input: unknown): unknown {
  if (input == null || typeof input !== "object") return input;
  if (Array.isArray(input)) return input.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? "***" : redact(v);
  }
  return out;
}

function ensureDir() {
  mkdirSync(config.logDir, { recursive: true });
}

// --- Rolling HTTP log ---------------------------------------------------------
let httpStream: WriteStream | null = null;
function httpStreamGet(): WriteStream {
  if (!httpStream) {
    ensureDir();
    httpStream = createWriteStream(resolve(config.logDir, "http.jsonl"), { flags: "a" });
  }
  return httpStream;
}

export interface HttpLogEntry {
  method: string;
  path: string;
  status: number;
  ms: number;
  tokenOk?: boolean;
  origin?: string;
}
export function httpLog(entry: HttpLogEntry): void {
  httpStreamGet().write(JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
  if (stderrEnabled("info")) {
    console.error(
      `[ddb-mcp] [http] ${entry.method} ${entry.path} -> ${entry.status} ${entry.ms}ms` +
        (entry.tokenOk === undefined ? "" : ` tokenOk=${entry.tokenOk}`),
    );
  }
}

// --- Per-call logger ----------------------------------------------------------
export interface CallLogger {
  readonly runId: string;
  readonly path: string;
  log(level: string, msg: string, data?: Record<string, unknown>): void;
  close(outcome: { ok: boolean; error?: string; [k: string]: unknown }): void;
}

export function startCallLog(tool: string, runId: string): CallLogger {
  ensureDir();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = resolve(config.logDir, `${ts}_${tool}_${runId.slice(0, 8)}.jsonl`);
  const stream = createWriteStream(path, { flags: "a" });

  const log = (level: string, msg: string, data?: Record<string, unknown>) => {
    const safe = data ? (redact(data) as Record<string, unknown>) : undefined;
    stream.write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...(safe ?? {}) }) + "\n");
    if (stderrEnabled(level)) {
      const compact = safe ? " " + JSON.stringify(safe).slice(0, 240) : "";
      console.error(`[ddb-mcp] [${level}] ${tool} ${msg}${compact}`);
    }
  };

  log("info", "tool.start", { runId, tool });
  return {
    runId,
    path,
    log,
    close(outcome) {
      log("info", "tool.end", outcome);
      stream.end();
    },
  };
}

/** Ad-hoc top-level log line (startup, probe, etc.). */
export function log(level: string, msg: string, data?: Record<string, unknown>): void {
  if (!stderrEnabled(level)) return;
  const compact = data ? " " + JSON.stringify(redact(data)).slice(0, 400) : "";
  console.error(`[ddb-mcp] [${level}] ${msg}${compact}`);
}

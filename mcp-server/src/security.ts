/**
 * Guards (§8 of spec.md): capability-token checks + SQL / render-core sanitization.
 * Demo-grade — see spec §3.3.
 */

/** Constant-time-ish token comparison (both must be non-empty and equal). */
export function tokenOk(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string" || !provided || !expected) return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const SQL_FORBIDDEN =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|EXEC|EXECUTE|MERGE|TRUNCATE|GRANT|REVOKE|INTO)\b/i;

/** Allow only a single read-only SELECT/WITH statement. Throws on violation. */
export function sanitizeSql(sql: string): string {
  const s = sql.trim().replace(/;+\s*$/, "");
  if (!/^\s*(WITH|SELECT)\b/i.test(s)) {
    throw new Error("Generated SQL must be a SELECT query");
  }
  if (SQL_FORBIDDEN.test(s)) {
    throw new Error("Generated SQL contains a forbidden (non-read-only) keyword");
  }
  if (s.includes(";")) {
    throw new Error("Generated SQL must be a single statement");
  }
  return s;
}

// Case-sensitive on `Function` so it catches `new Function` but not `function render`.
const RENDER_FORBIDDEN =
  /\b(import|require|fetch|XMLHttpRequest|eval|WebSocket|localStorage|sessionStorage|importScripts)\b|\bFunction\s*\(|document\.cookie/;

// Standard W3C namespace URIs used by createElementNS/setAttributeNS for SVG/XML — these are
// identifiers, not network fetches, and are required for vanilla SVG rendering.
const W3C_NAMESPACE =
  /https?:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xhtml|1999\/xlink|2000\/xmlns\/|XML\/1998\/namespace)/gi;

/** Ensure the LLM's render core is a self-contained vanilla function. Throws on violation. */
export function sanitizeRenderCore(code: string): string {
  const c = code.trim();
  if (!/function\s+render\s*\(/.test(c)) {
    throw new Error("renderCore must define `function render(container, rows)`");
  }
  if (RENDER_FORBIDDEN.test(c)) {
    throw new Error("renderCore contains a forbidden token (no import/require/fetch/eval/…)");
  }
  // Allow W3C namespace URIs; any *other* external URL is a real network reference → reject.
  if (/https?:\/\//i.test(c.replace(W3C_NAMESPACE, ""))) {
    throw new Error("renderCore must not reference external URLs (vanilla, self-contained only)");
  }
  return c;
}

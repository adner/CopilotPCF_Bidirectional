/**
 * Central configuration, loaded from `.env` (see .env.example).
 * Secrets are never logged directly — use configSummary() for a redacted view.
 */
import "dotenv/config";

const num = (v: string | undefined, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
const trimSlash = (v: string) => v.replace(/\/+$/, "");

const port = num(process.env.PORT, 3101);

export const config = {
  port,
  publicBaseUrl: trimSlash(process.env.PUBLIC_BASE_URL || `http://localhost:${port}`),
  dashboardKey: process.env.DASHBOARD_KEY || "",

  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-4o",

  dataverseOrgUrl: trimSlash(process.env.DATAVERSE_ORG_URL || ""),
  tdsPort: num(process.env.DATAVERSE_TDS_PORT, 5558),
  aadTenantId: process.env.AAD_TENANT_ID || "",
  aadClientId: process.env.AAD_CLIENT_ID || "",
  aadClientSecret: process.env.AAD_CLIENT_SECRET || "",
  dataPath: (process.env.DATA_PATH || "tds").toLowerCase() as "tds" | "webapi",

  // Space-separated CSP frame-ancestors sources allowed to iframe tiles. Lock to the org host for
  // the real app; add your PCF harness origin (e.g. http://localhost:8181) for local testing.
  tileFrameAncestors:
    process.env.TILE_FRAME_ANCESTORS || "https://*.dynamics.com 'self'",

  stateFile: process.env.STATE_FILE || "state.json",
  logLevel: (process.env.LOG_LEVEL || "info").toLowerCase() as
    | "error" | "warn" | "info" | "debug",
  logDir: process.env.LOG_DIR || "logs",
};

export type Config = typeof config;

/** Parse the org URL into a TDS { server, database } pair. */
export function dataverseServerAndDb(): { server: string; database: string } {
  if (!config.dataverseOrgUrl) {
    throw new Error("DATAVERSE_ORG_URL is not set — configure it in mcp-server/.env");
  }
  const host = new URL(config.dataverseOrgUrl).host; // e.g. yourorg.crm4.dynamics.com
  return { server: host, database: host.split(".")[0] }; // db == first label
}

/** Throw a clear error if any required config key is empty. */
export function requireConfig(keys: (keyof Config)[]): void {
  const missing = keys.filter((k) => !config[k]);
  if (missing.length) {
    throw new Error(
      `Missing required config: ${missing.join(", ")}. Set them in mcp-server/.env`,
    );
  }
}

/** Redacted, log-safe view of the effective configuration. */
export function configSummary(): Record<string, unknown> {
  const s = (v: string) => (v ? "set" : "MISSING");
  return {
    port: config.port,
    publicBaseUrl: config.publicBaseUrl,
    dataPath: config.dataPath,
    dataverseOrgUrl: config.dataverseOrgUrl || "MISSING",
    tdsPort: config.tdsPort,
    openaiModel: config.openaiModel,
    openaiApiKey: s(config.openaiApiKey),
    aadTenantId: s(config.aadTenantId),
    aadClientId: s(config.aadClientId),
    aadClientSecret: s(config.aadClientSecret),
    dashboardKey: s(config.dashboardKey),
    logLevel: config.logLevel,
  };
}

/**
 * Dataverse data layer (§6 of spec.md).
 *
 * Primary path (DATA_PATH=tds): the Dataverse TDS/SQL endpoint, authenticated with a
 * confidential-client (service principal) access token acquired for the org resource and
 * attached to the SQL connection — the proven pattern. Read-only, SELECT only.
 *
 * Fallback (DATA_PATH=webapi): stubbed here — token acquisition is wired, the OData query
 * translation is left as a follow-up (see spec §6.2).
 */
import sql from "mssql";
import { ClientSecretCredential } from "@azure/identity";
import { config, dataverseServerAndDb, requireConfig } from "./config.js";
import { log } from "./logger.js";

export type Row = Record<string, unknown>;

let credential: ClientSecretCredential | null = null;
function getCredential(): ClientSecretCredential {
  requireConfig(["aadTenantId", "aadClientId", "aadClientSecret", "dataverseOrgUrl"]);
  if (!credential) {
    credential = new ClientSecretCredential(
      config.aadTenantId,
      config.aadClientId,
      config.aadClientSecret,
    );
  }
  return credential;
}

async function getAccessToken(): Promise<string> {
  const scope = `${config.dataverseOrgUrl}/.default`;
  const token = await getCredential().getToken(scope);
  if (!token?.token) throw new Error("Failed to acquire Dataverse access token");
  return token.token;
}

// --- TDS connection pool (re-created on demand; token attached per connect) ---
let pool: sql.ConnectionPool | null = null;

async function getPool(): Promise<sql.ConnectionPool> {
  if (pool && pool.connected) return pool;
  if (pool) {
    try { await pool.close(); } catch { /* ignore */ }
    pool = null;
  }
  const { server, database } = dataverseServerAndDb();
  const token = await getAccessToken();

  // `authentication` is a tedious feature forwarded by mssql; not in mssql's TS types → cast.
  const poolConfig = {
    server,
    port: config.tdsPort,
    database,
    options: { encrypt: true, trustServerCertificate: false, enableArithAbort: true },
    authentication: {
      type: "azure-active-directory-access-token",
      options: { token },
    },
    connectionTimeout: 30_000,
    requestTimeout: 60_000,
  } as unknown as sql.config;

  pool = await new sql.ConnectionPool(poolConfig).connect();
  return pool;
}

/** Run a read-only query and return plain-object rows. Sanitize the SQL *before* calling this. */
export async function runQuery(query: string): Promise<Row[]> {
  if (config.dataPath === "webapi") {
    throw new Error(
      "DATA_PATH=webapi is not implemented in this scaffold. Use tds, or implement the OData fallback (spec §6.2).",
    );
  }
  const p = await getPool();
  const result = await p.request().query(query);
  return (result.recordset ?? []) as Row[];
}

/** Connectivity check for `probe dataverse` — token + a trivial SELECT. */
export async function checkConnectivity(): Promise<{ ok: boolean; ms: number; sample?: unknown; error?: string }> {
  const start = Date.now();
  try {
    const rows = await runQuery("SELECT TOP (1) 1 AS ok");
    return { ok: true, ms: Date.now() - start, sample: rows[0] };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    try { await pool.close(); } catch { /* ignore */ }
    pool = null;
    log("debug", "dataverse.pool.closed");
  }
}

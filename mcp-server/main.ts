/**
 * Entry point. Default = Streamable HTTP on PORT (3101). `--stdio` for stdio hosts.
 * Also mounts the plain web endpoints (§7) and /health on the same port.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { createServer } from "./server.js";
import { webRouter } from "./src/web.js";
import { config, configSummary } from "./src/config.js";
import { log } from "./src/logger.js";

const useStdio = process.argv.includes("--stdio");

process.on("unhandledRejection", (reason) => {
  log("error", "unhandledRejection", { reason: reason instanceof Error ? reason.message : String(reason) });
});

async function main() {
  if (useStdio) {
    const server = createServer();
    await server.connect(new StdioServerTransport());
    log("info", "started (stdio)", configSummary());
    return;
  }

  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use(
    cors({
      origin: "*",
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "mcp-session-id", "Last-Event-ID", "mcp-protocol-version"],
      exposedHeaders: ["mcp-session-id", "mcp-protocol-version"],
    }),
  );

  app.get("/health", (_req, res) => res.json({ status: "ok", ...configSummary() }));

  // Web plane (§7): /dashboard, /tiles/*, DELETE.
  app.use("/", webRouter());

  // MCP transport (per-session Streamable HTTP).
  const transports = new Map<string, StreamableHTTPServerTransport>();
  app.all("/mcp", async (req, res) => {
    const sessionId = req.header("mcp-session-id");
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      transport.onclose = () => {
        const sid = transport!.sessionId;
        if (sid) transports.delete(sid);
      };
      const mcp = createServer();
      await mcp.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
    const sid = transport.sessionId;
    if (sid && !transports.has(sid)) transports.set(sid, transport);
  });

  app.listen(config.port, () => {
    log("info", `listening on http://localhost:${config.port}/mcp  (health: /health)`, configSummary());
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

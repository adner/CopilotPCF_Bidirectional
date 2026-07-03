/**
 * Plain-HTTPS web endpoints (§7 of spec.md), consumed by the PCF dashboard and the tiles.
 *   GET    /dashboard?k=<dashboardKey>
 *   GET    /tiles/:vizId?k=<tileKey>
 *   GET    /tiles/:vizId/data?k=<tileKey>
 *   DELETE /tiles/:vizId?k=<dashboardKey>
 */
import { Router, type Request, type Response } from "express";
import { config } from "./config.js";
import { tokenOk } from "./security.js";
import { httpLog } from "./logger.js";
import * as store from "./store.js";
import { runQuery } from "./dataverse.js";
import { tilePage } from "./assemble-document.js";

function done(req: Request, status: number, start: number, tokenOkFlag?: boolean) {
  httpLog({
    method: req.method,
    path: req.path,
    status,
    ms: Date.now() - start,
    tokenOk: tokenOkFlag,
    origin: req.header("origin"),
  });
}

export function webRouter(): Router {
  const r = Router();

  r.get("/dashboard", (req: Request, res: Response) => {
    const start = Date.now();
    if (!tokenOk(req.query.k, config.dashboardKey)) {
      done(req, 401, start, false);
      return res.status(401).json({ error: "invalid token" });
    }
    done(req, 200, start, true);
    res.json({ tiles: store.listTiles() });
  });

  r.get("/tiles/:vizId", (req: Request, res: Response) => {
    const start = Date.now();
    const tile = store.getTile(req.params.vizId);
    const ok = !!tile && tokenOk(req.query.k, tile.tileKey);
    if (!tile) { done(req, 404, start); return res.status(404).send("Not found"); }
    if (!ok) { done(req, 403, start, false); return res.status(403).send("Forbidden"); }
    const viz = store.getViz(tile.vizId);
    if (!viz) { done(req, 404, start, true); return res.status(404).send("Viz missing"); }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Security-Policy", `frame-ancestors ${config.tileFrameAncestors}`);
    res.setHeader("Cache-Control", "no-store");
    done(req, 200, start, true);
    res.send(tilePage(viz.renderCore, tile.vizId, tile.tileKey, tile.title));
  });

  r.get("/tiles/:vizId/data", async (req: Request, res: Response) => {
    const start = Date.now();
    const tile = store.getTile(req.params.vizId);
    const ok = !!tile && tokenOk(req.query.k, tile.tileKey);
    if (!tile) { done(req, 404, start); return res.status(404).json({ error: "not found" }); }
    if (!ok) { done(req, 403, start, false); return res.status(403).json({ error: "forbidden" }); }
    const viz = store.getViz(tile.vizId);
    if (!viz) { done(req, 404, start, true); return res.status(404).json({ error: "viz missing" }); }

    try {
      const rows = await runQuery(viz.sql);
      res.setHeader("Cache-Control", "no-store");
      done(req, 200, start, true);
      res.json({ rows });
    } catch (err) {
      done(req, 502, start, true);
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  r.delete("/tiles/:vizId", (req: Request, res: Response) => {
    const start = Date.now();
    if (!tokenOk(req.query.k, config.dashboardKey)) {
      done(req, 401, start, false);
      return res.status(401).end();
    }
    store.removeTile(req.params.vizId); // idempotent
    done(req, 204, start, true);
    res.status(204).end();
  });

  return r;
}

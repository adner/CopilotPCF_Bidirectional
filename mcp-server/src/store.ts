/**
 * Singleton state (§2 / §6 of spec.md), persisted to a JSON file.
 *   - vizStore: every generated visualization (with its bound SQL + render core)
 *   - registry: the dashboard (vizIds the user clicked "Add to dashboard" on)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { config } from "./config.js";

export interface VizRecord {
  vizId: string;
  title: string;
  vizType: string;
  sql: string;
  renderCore: string;
  createdAt: string;
  updatedAt: string; // bumped by update_visualization; = createdAt on first create
}

export interface Tile {
  vizId: string;
  title: string;
  vizType: string;
  tileKey: string;
  tileUrl: string;
  addedAt: string;
}

/**
 * Public tile shape returned by GET /dashboard and list_dashboard (no tileKey). `updatedAt` mirrors
 * the underlying viz's `updatedAt` so the PCF can detect an in-place edit and reload just that tile.
 */
export type PublicTile = Omit<Tile, "tileKey"> & { updatedAt: string };

interface State {
  vizStore: Record<string, VizRecord>;
  registry: Record<string, Tile>;
}

let state: State = { vizStore: {}, registry: {} };

function load(): void {
  if (!existsSync(config.stateFile)) return;
  try {
    const parsed = JSON.parse(readFileSync(config.stateFile, "utf-8")) as Partial<State>;
    state = { vizStore: parsed.vizStore ?? {}, registry: parsed.registry ?? {} };
  } catch {
    // Corrupt state file — start clean rather than crash.
    state = { vizStore: {}, registry: {} };
  }
}
function save(): void {
  const dir = dirname(config.stateFile);
  if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
  writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
}
load();

export function putViz(v: VizRecord): void {
  state.vizStore[v.vizId] = v;
  save();
}
export function getViz(vizId: string): VizRecord | undefined {
  return state.vizStore[vizId];
}

/**
 * The tile URL is DERIVED from the current PUBLIC_BASE_URL, never persisted stale — so changing
 * PUBLIC_BASE_URL (e.g. localhost → devtunnel) heals every existing tile on the next read.
 */
function tileUrlFor(vizId: string, tileKey: string): string {
  return `${config.publicBaseUrl}/tiles/${vizId}?k=${tileKey}`;
}

/** Promote a viz onto the dashboard; idempotent (returns the same tile if already added). */
export function addToDashboard(vizId: string): Tile {
  const viz = getViz(vizId);
  if (!viz) throw new Error(`Unknown vizId: ${vizId}`);
  const existing = state.registry[vizId];
  if (existing) {
    existing.tileUrl = tileUrlFor(vizId, existing.tileKey); // refresh against the current base
    return existing;
  }

  const tileKey = randomUUID().replace(/-/g, "");
  const tile: Tile = {
    vizId,
    title: viz.title,
    vizType: viz.vizType,
    tileKey,
    tileUrl: tileUrlFor(vizId, tileKey),
    addedAt: new Date().toISOString(),
  };
  state.registry[vizId] = tile;
  save();
  return tile;
}

export function getTile(vizId: string): Tile | undefined {
  return state.registry[vizId];
}

export function listTiles(): PublicTile[] {
  return Object.values(state.registry).map(({ tileKey, ...pub }) => {
    // Read title/vizType/updatedAt LIVE from the viz so an in-place edit isn't masked by the
    // copies cached on the tile at add-time (fall back to those if the viz is somehow gone).
    const viz = state.vizStore[pub.vizId];
    return {
      ...pub,
      title: viz?.title ?? pub.title,
      vizType: viz?.vizType ?? pub.vizType,
      updatedAt: viz?.updatedAt ?? pub.addedAt,
      tileUrl: tileUrlFor(pub.vizId, tileKey), // always current-base, never stale localhost
    };
  });
}

/** Remove a tile from the dashboard. Idempotent — returns whether it existed. */
export function removeTile(vizId: string): boolean {
  const had = vizId in state.registry;
  delete state.registry[vizId];
  save();
  return had;
}

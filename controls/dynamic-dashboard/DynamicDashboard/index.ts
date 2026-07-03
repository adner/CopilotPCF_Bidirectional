import { IInputs, IOutputs } from "./generated/ManifestTypes";

/**
 * DDB.DynamicDashboard — a full-page dataset PCF that renders the live dashboard.
 *
 * It does NOT read its dataset (that anchor only hosts the control full-page). Its only data plane
 * is HTTPS to the MCP/web server:
 *   GET    /dashboard?k=<dashboardKey>        -> { tiles: [...] }         (the registry)
 *   GET    /tiles/:vizId?k=<tileKey>          -> self-contained tile HTML (iframed)
 *   DELETE /tiles/:vizId?k=<dashboardKey>     -> 204                      (remove a tile)
 *
 * Two ways a change reaches us: the user clicks Refresh / we poll, or a Copilot widget publishes a
 * tile and posts the `ddb.dashboard.updated` nudge (we reconcile via /dashboard — never trust the
 * message as the source of truth).
 */

// --- window.Xrm.Copilot is ambient in a model-driven app; not in the PCF typings. -------------
interface CopilotApi {
  isM365CopilotEnabled?: () => boolean;
  openM365CopilotPanel?: () => Promise<void> | void;
  sendPromptToM365Copilot?: (
    text: string,
    options?: { autoSubmit?: boolean; gptId?: string },
  ) => Promise<void> | void;
  addActionHandler?: (action: string, handler: (data: unknown) => void) => void;
}

/** window.Xrm.Copilot is ambient in a model-driven app but absent from PCF typings. */
function copilotApi(): CopilotApi | undefined {
  return (window as unknown as { Xrm?: { Copilot?: CopilotApi } }).Xrm?.Copilot;
}

interface Tile {
  vizId: string;
  title: string;
  vizType: string;
  tileUrl: string;
  addedAt?: string;
  updatedAt?: string; // bumped when the viz is edited in place → reload just this tile
}

const HOST_EVENT = "powerapps.copilot.chat.action";
const HOST_ACTION = "ddb.dashboard.updated";
const DEFAULT_SEED = "Show me a bar chart of open opportunities by month.";

// "Generate new report ✨" picks one of these at random and auto-submits it to Copilot, so the pane
// opens and immediately renders a chart. Every column/table here is drawn from the generator's
// curated schema (mcp-server/config/dataverse-schema.md) so these reliably produce a valid viz.
const SEED_PROMPTS = [
  "Show me a bar chart of the estimated value of the 5 most recently created opportunities.",
  "Create a pie chart comparing the number of open, won, and lost opportunities.",
  "Give me a line chart of how many opportunities were created each month this year.",
  "Show a bar chart of total estimated revenue grouped by opportunity status (open, won, lost).",
  "Show me a KPI card with the total estimated value of all open opportunities.",
  "Create a pie chart of contacts by gender (male, female, unknown).",
  "Give me a bar chart of the top 8 cities by number of contacts.",
  "Show a line chart of new contacts added per month this year.",
  "Show me a bar chart of the top 10 opportunities by estimated value.",
  "Create a KPI card with the total number of open opportunities.",
];

export class DynamicDashboard implements ComponentFramework.StandardControl<IInputs, IOutputs> {
  private root!: HTMLDivElement;
  private grid!: HTMLDivElement;
  private statusEl!: HTMLDivElement;
  private countChip!: HTMLSpanElement;
  private emptyEl!: HTMLDivElement;

  private cards = new Map<string, HTMLDivElement>(); // vizId -> tile card
  private serverBaseUrl = "";
  private dashboardKey = "";
  private agentId = "";
  private seedPrompt = DEFAULT_SEED;
  private pollHandle: number | undefined;
  private pollSeconds = 0;

  private onWindowMessage = (e: MessageEvent): void => this.handleHostMessage(e);

  public init(
    context: ComponentFramework.Context<IInputs>,
    _notifyOutputChanged: () => void,
    _state: ComponentFramework.Dictionary,
    container: HTMLDivElement,
  ): void {
    this.readConfig(context);
    this.buildChrome(container);

    // Nudge receive — dual registration (the Copilot pane is a nested iframe; addActionHandler
    // routing can be unreliable there, so the raw message listener is the load-bearing path).
    copilotApi()?.addActionHandler?.(HOST_ACTION, (data) => this.onNudge(data));
    window.addEventListener("message", this.onWindowMessage);

    void this.loadDashboard();
    this.applyPolling();
  }

  public updateView(context: ComponentFramework.Context<IInputs>): void {
    const before = `${this.serverBaseUrl}|${this.dashboardKey}|${this.pollSeconds}`;
    this.readConfig(context);
    const after = `${this.serverBaseUrl}|${this.dashboardKey}|${this.pollSeconds}`;
    if (before !== after) {
      this.applyPolling();
      void this.loadDashboard(); // config changed at design/runtime — re-pull
    }
  }

  public getOutputs(): IOutputs {
    return {};
  }

  public destroy(): void {
    window.removeEventListener("message", this.onWindowMessage);
    if (this.pollHandle !== undefined) window.clearInterval(this.pollHandle);
  }

  // --- config ---------------------------------------------------------------
  private readConfig(context: ComponentFramework.Context<IInputs>): void {
    const p = context.parameters;
    this.serverBaseUrl = (p.serverBaseUrl.raw ?? "").replace(/\/+$/, "");
    this.dashboardKey = p.dashboardKey.raw ?? "";
    this.agentId = p.agentId.raw ?? "";
    this.seedPrompt = p.seedPrompt.raw || DEFAULT_SEED;
    this.pollSeconds = Math.max(0, p.autoRefreshSeconds.raw ?? 0);
  }

  private applyPolling(): void {
    if (this.pollHandle !== undefined) {
      window.clearInterval(this.pollHandle);
      this.pollHandle = undefined;
    }
    if (this.pollSeconds > 0) {
      this.pollHandle = window.setInterval(() => void this.loadDashboard(), this.pollSeconds * 1000);
    }
  }

  // --- DOM chrome -----------------------------------------------------------
  private buildChrome(container: HTMLDivElement): void {
    this.root = document.createElement("div");
    this.root.className = "ddb-root";

    const head = document.createElement("div");
    head.className = "ddb-head";

    const title = document.createElement("div");
    title.className = "ddb-h-title";
    title.textContent = "My dashboard";

    this.countChip = document.createElement("span");
    this.countChip.className = "ddb-chip";
    this.countChip.textContent = "0";

    const spacer = document.createElement("div");
    spacer.className = "ddb-spacer";

    const newBtn = document.createElement("button");
    newBtn.className = "ddb-btn ddb-btn--primary";
    newBtn.textContent = "Generate new report ✨";
    newBtn.addEventListener("click", () => void this.sendToCopilot());

    const refreshBtn = document.createElement("button");
    refreshBtn.className = "ddb-btn";
    refreshBtn.textContent = "Refresh";
    refreshBtn.addEventListener("click", () => void this.loadDashboard());

    head.append(title, this.countChip, spacer, newBtn, refreshBtn);

    this.statusEl = document.createElement("div");
    this.statusEl.className = "ddb-status";

    this.grid = document.createElement("div");
    this.grid.className = "ddb-grid";

    this.emptyEl = document.createElement("div");
    this.emptyEl.className = "ddb-empty";
    this.emptyEl.hidden = true;
    this.emptyEl.innerHTML =
      '<div class="ddb-empty-card"><div class="ddb-empty-h">No reports yet</div>' +
      '<div class="ddb-empty-p">Click <b>Generate new report ✨</b> to have Copilot build a chart, ' +
      'then <b>Add to dashboard</b>.</div></div>';

    this.root.append(head, this.statusEl, this.grid, this.emptyEl);
    container.appendChild(this.root);
  }

  private setStatus(msg: string, kind: "" | "ok" | "err" | "busy" = ""): void {
    this.statusEl.textContent = msg;
    this.statusEl.className = "ddb-status" + (kind ? " ddb-status--" + kind : "");
  }

  // --- data plane -----------------------------------------------------------
  private async loadDashboard(): Promise<void> {
    if (!this.serverBaseUrl || !this.dashboardKey) {
      this.setStatus("Set Server Base URL and Dashboard Key on the control.", "err");
      return;
    }
    this.setStatus("Loading…", "busy");
    try {
      const res = await fetch(`${this.serverBaseUrl}/dashboard?k=${encodeURIComponent(this.dashboardKey)}`, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { tiles?: Tile[] };
      this.renderTiles(Array.isArray(body.tiles) ? body.tiles : []);
      this.setStatus("");
    } catch (err) {
      this.setStatus("Could not reach the server: " + this.msg(err), "err");
    }
  }

  /** Diff by vizId so unchanged tiles keep their iframe (a full re-render reloads every chart). */
  private renderTiles(tiles: Tile[]): void {
    const incoming = new Map(tiles.map((t) => [t.vizId, t]));

    for (const [vizId, card] of this.cards) {
      if (!incoming.has(vizId)) {
        card.remove();
        this.cards.delete(vizId);
      }
    }
    for (const tile of tiles) {
      const card = this.cards.get(tile.vizId);
      if (!card) this.addCard(tile, true);
      else this.refreshCardIfChanged(card, tile); // in-place edit → reload just this tile
    }

    this.countChip.textContent = String(this.cards.size);
    this.emptyEl.hidden = this.cards.size > 0;
  }

  /** If the viz was edited (updatedAt changed), reload its iframe and refresh the title label. */
  private refreshCardIfChanged(card: HTMLDivElement, tile: Tile): void {
    const stamp = tile.updatedAt ?? "";
    if (!stamp || card.dataset.updatedAt === stamp) return;
    card.dataset.updatedAt = stamp;
    const frame = card.querySelector<HTMLIFrameElement>("iframe.ddb-frame");
    if (frame) frame.src = tile.tileUrl; // re-pulls updated renderCore + data
    const label = card.querySelector<HTMLSpanElement>(".ddb-tile-title");
    if (label) {
      label.textContent = tile.title || "Untitled";
      label.title = tile.title || "";
    }
  }

  private addCard(tile: Tile, markNew: boolean): void {
    if (this.cards.has(tile.vizId) || !tile.tileUrl) return;

    const card = document.createElement("div");
    card.className = "ddb-tile" + (markNew ? " ddb-tile--new" : "");
    card.dataset.updatedAt = tile.updatedAt ?? ""; // baseline for in-place-edit reloads

    const bar = document.createElement("div");
    bar.className = "ddb-tile-bar";

    const label = document.createElement("span");
    label.className = "ddb-tile-title";
    label.textContent = tile.title || "Untitled";
    label.title = tile.title || "";

    const reload = document.createElement("button");
    reload.className = "ddb-icon";
    reload.title = "Reload";
    reload.textContent = "↻";

    const remove = document.createElement("button");
    remove.className = "ddb-icon";
    remove.title = "Remove";
    remove.textContent = "✕";
    remove.addEventListener("click", () => void this.removeTile(tile.vizId));

    bar.append(label, reload, remove);

    const frame = document.createElement("iframe");
    frame.className = "ddb-frame";
    // allow-same-origin is deliberate: the tile must fetch its own /data endpoint. Without it the
    // iframe gets an opaque origin and every self-fetch becomes a null-origin CORS failure.
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frame.setAttribute("loading", "lazy");
    frame.src = tile.tileUrl;
    reload.addEventListener("click", () => {
      frame.src = tile.tileUrl;
    });

    card.append(bar, frame);
    this.grid.appendChild(card);
    this.cards.set(tile.vizId, card);

    if (markNew) window.setTimeout(() => card.classList.remove("ddb-tile--new"), 2200);
  }

  private async removeTile(vizId: string): Promise<void> {
    const card = this.cards.get(vizId);
    try {
      const res = await fetch(`${this.serverBaseUrl}/tiles/${encodeURIComponent(vizId)}?k=${encodeURIComponent(this.dashboardKey)}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      card?.remove();
      this.cards.delete(vizId);
      this.countChip.textContent = String(this.cards.size);
      this.emptyEl.hidden = this.cards.size > 0;
    } catch (err) {
      this.setStatus("Could not remove tile: " + this.msg(err), "err");
    }
  }

  // --- app -> Copilot -------------------------------------------------------
  private async sendToCopilot(): Promise<void> {
    const copilot = copilotApi();
    if (!copilot?.sendPromptToM365Copilot || !copilot.openM365CopilotPanel) {
      this.setStatus("Open this dashboard inside the model-driven app to use Copilot.", "err");
      return;
    }
    // Immediate feedback: openM365CopilotPanel() boots the Copilot pane (a nested iframe with its
    // own SPA + auth), which takes a beat — without this the button looks dead during that wait.
    this.setStatus("Opening Copilot…", "busy");
    try {
      // A random pre-baked prompt makes each click a fresh, varied demo.
      const prompt = SEED_PROMPTS[Math.floor(Math.random() * SEED_PROMPTS.length)];
      await copilot.openM365CopilotPanel();
      // autoSubmit:true → Copilot submits the prompt itself, so the chart renders with no 2nd click.
      await copilot.sendPromptToM365Copilot(prompt, {
        autoSubmit: true,
        gptId: this.agentId || undefined,
      });
      this.setStatus("Generating your report in Copilot…", "ok");
    } catch (err) {
      this.setStatus("Could not open Copilot: " + this.msg(err), "err");
    }
  }

  // --- Copilot -> app (nudge) ----------------------------------------------
  private handleHostMessage(e: MessageEvent): void {
    const d = e.data as { eventName?: string; action?: string; actionData?: unknown } | null;
    if (!d || d.eventName !== HOST_EVENT || d.action !== HOST_ACTION) return;
    this.onNudge(d.actionData);
  }

  private onNudge(actionData: unknown): void {
    const a = (actionData ?? {}) as Partial<Tile>;
    // Optimistic: if we got a usable tile, show it immediately…
    if (a.vizId && a.tileUrl) {
      this.addCard(
        { vizId: a.vizId, title: a.title ?? "New report", vizType: a.vizType ?? "", tileUrl: a.tileUrl },
        true,
      );
      this.countChip.textContent = String(this.cards.size);
      this.emptyEl.hidden = this.cards.size > 0;
    }
    // …then reconcile against the authoritative registry (message may be missed or doubled).
    void this.loadDashboard();
  }

  private msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Dynamic Dashboard viewer (§4.3 of spec.md) — adapted from GenUI_MCP/src/mcp-app.ts.
 *
 * On tool result it injects structuredContent.html into a nested <iframe srcdoc>, and adds an
 * "Add to dashboard" button in the outer chrome that calls add_to_dashboard + posts the §3.4 nudge.
 */
import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";

const HOST_ACTION = "ddb.dashboard.updated";

const root = document.getElementById("root")!;
let widgetFrame: HTMLIFrameElement | null = null;
let currentTheme: "light" | "dark" = "light";
let currentViz: { vizId: string; title: string; vizType: string } | null = null;

const app = new App({ name: "Dynamic Dashboard Viewer", version: "0.1.0" }, {});

function pushTheme() {
  widgetFrame?.contentWindow?.postMessage({ type: "set-theme", theme: currentTheme }, "*");
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}) {
  return Object.assign(document.createElement(tag), props);
}

function renderLoading(msg = "Generating…") {
  const wrap = el("div", { className: "state-loading" });
  wrap.appendChild(el("span", { className: "spinner" }));
  wrap.appendChild(el("span", { textContent: msg }));
  root.replaceChildren(wrap);
  widgetFrame = null;
}

function renderError(title: string, detail?: string) {
  const wrap = el("div", { className: "state-error" });
  wrap.appendChild(el("strong", { textContent: title }));
  if (detail) wrap.appendChild(el("div", { textContent: detail }));
  root.replaceChildren(wrap);
  widgetFrame = null;
}

function fanoutNudge(tileUrl: string) {
  if (!currentViz) return;
  const msg = {
    eventName: "powerapps.copilot.chat.action",
    action: HOST_ACTION,
    actionData: { vizId: currentViz.vizId, title: currentViz.title, vizType: currentViz.vizType, tileUrl },
  };
  for (const target of [window.top, window.parent, window.parent?.parent]) {
    try { if (target && target !== window) target.postMessage(msg, "*"); } catch { /* next */ }
  }
}

function renderContent(html: string) {
  const toolbar = el("div", { className: "ddb-toolbar" });
  const addBtn = el("button", { className: "ddb-add", textContent: "Add to dashboard" });
  const status = el("span", { className: "ddb-status" });
  toolbar.append(addBtn, status);

  addBtn.addEventListener("click", async () => {
    if (!currentViz) return;
    addBtn.disabled = true;
    status.className = "ddb-status";
    status.textContent = "Adding…";
    try {
      const result = await app.callServerTool({ name: "add_to_dashboard", arguments: { vizId: currentViz.vizId } });
      const tileUrl = (result?.structuredContent as { tileUrl?: string } | undefined)?.tileUrl ?? "";
      fanoutNudge(tileUrl);
      addBtn.textContent = "✓ On your dashboard";
      status.textContent = "";
    } catch (err) {
      addBtn.disabled = false;
      status.className = "ddb-status err";
      status.textContent = "Could not add: " + (err instanceof Error ? err.message : String(err));
    }
  });

  const iframe = el("iframe", { className: "widget-frame" });
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
  iframe.style.height = "320px";
  iframe.addEventListener("load", pushTheme);
  iframe.srcdoc = html;

  root.replaceChildren(toolbar, iframe);
  widgetFrame = iframe;
}

// Size the outer iframe to the nested chart's reported height.
window.addEventListener("message", (e) => {
  if (!widgetFrame || e.source !== widgetFrame.contentWindow) return;
  const d = e.data as { type?: string; height?: number } | null;
  if (!d || d.type !== "widget-resize" || typeof d.height !== "number") return;
  widgetFrame.style.height = `${Math.max(80, Math.min(d.height, 4000))}px`;
});

app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) { applyDocumentTheme(ctx.theme); currentTheme = ctx.theme; pushTheme(); }
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};

app.ontoolinputpartial = () => { if (!widgetFrame) renderLoading(); };

app.ontoolresult = (result) => {
  if (result.isError) {
    const text = (result.content ?? []).find((c) => c.type === "text") as { text?: string } | undefined;
    renderError("Could not create visualization", text?.text);
    return;
  }
  const sc = result.structuredContent as
    | { vizId?: string; title?: string; vizType?: string; html?: string; updated?: boolean }
    | undefined;
  if (!sc?.html || !sc.vizId) { renderError("No visualization in result"); return; }
  currentViz = { vizId: sc.vizId, title: sc.title ?? "", vizType: sc.vizType ?? "" };
  renderContent(sc.html);
  // In-place edit of a viz that may already be on the dashboard: nudge the host so it reconciles and
  // reloads that tile now (no tileUrl → the PCF skips the optimistic add and just re-pulls /dashboard).
  if (sc.updated) fanoutNudge("");
};

app.onteardown = async () => ({});

renderLoading("Rendering…");

void app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx?.theme) { applyDocumentTheme(ctx.theme); currentTheme = ctx.theme; pushTheme(); }
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
});

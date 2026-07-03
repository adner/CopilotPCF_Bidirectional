/**
 * assembleDocument (§4.2 of spec.md) — wraps the LLM's vanilla `render(container, rows)`
 * core into a self-contained HTML document. Two data modes:
 *   - inline: initial rows baked in (used for the pane widget, delivered via structuredContent.html)
 *   - fetch:  the document fetches /tiles/{id}/data?k=… on load and on ↻ (used for the served tile)
 *
 * No CDN, no external anything. The inner meta-CSP is minimal (spec §4.2 / §8.3).
 */

export type DataSource =
  | { mode: "inline"; rows: unknown[] }
  | { mode: "fetch"; vizId: string; tileKey: string };

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );
}

const META_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'self'";

const THEME_CSS = `
  :root{--fg:#1c2431;--muted:#8a93a3;--bg:#ffffff;--panel:#f7f9fc;--accent:#3b82f6;--accent2:#8b5cf6;--border:rgba(20,30,50,.10)}
  :root[data-theme="dark"]{--fg:#e8ecf3;--muted:#8a93a3;--bg:#161a22;--panel:#1e2430;--accent:#60a5fa;--accent2:#a78bfa;--border:rgba(255,255,255,.12)}
  *{box-sizing:border-box}
  html,body{margin:0}
  body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:var(--bg);padding:10px;-webkit-font-smoothing:antialiased}
  .ddb-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
  .ddb-title{font-weight:650;font-size:14px;letter-spacing:.1px;flex:1}
  #ddb-refresh{font:inherit;cursor:pointer;border:1px solid var(--border);color:var(--muted);background:transparent;border-radius:8px;width:28px;height:28px;transition:.15s}
  #ddb-refresh:hover{color:var(--fg);border-color:var(--accent)}
  #chart{position:relative;min-height:40px}
  #chart svg{display:block;max-width:100%;height:auto;overflow:visible}
  #chart .ddb-legend{display:flex;flex-wrap:wrap;gap:4px 14px;align-items:center}
  #chart .ddb-legend .ddb-lg{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
  #chart .ddb-legend .ddb-sw{width:11px;height:11px;border-radius:3px;flex:0 0 auto}
  #chart text{font-family:inherit}
  .ddb-tip{position:absolute;pointer-events:none;transform:translate(-50%,-125%);background:var(--fg);color:var(--bg);padding:5px 9px;border-radius:7px;font-size:12px;line-height:1.35;white-space:nowrap;opacity:0;transition:opacity .12s ease;z-index:10;box-shadow:0 6px 20px rgba(0,0,0,.22);font-weight:500}
  .ddb-tip b{font-weight:700}
  .ddb-err{color:#e15759;font-size:13px;padding:6px 0}
`;

// Vanilla charting helpers baked into every document (no third-party). The generated
// renderCore MAY call these for consistent formatting, colors, and hover tooltips.
const DDB_JS = `
window.DDB=(function(){
  function fmt(n){
    if(n==null||n===''||isNaN(n)) return String(n);
    n=Number(n); var a=Math.abs(n);
    if(a>=1e9) return trim(n/1e9)+'B';
    if(a>=1e6) return trim(n/1e6)+'M';
    if(a>=1e3) return trim(n/1e3)+'k';
    return (Math.round(n*100)/100).toLocaleString();
  }
  function trim(x){ return (Math.round(x*10)/10).toString(); }
  function truncate(s,max){ s=String(s==null?'':s); return s.length>max? s.slice(0,max-1)+'\\u2026' : s; }
  var palette=['#3b82f6','#8b5cf6','#ec4899','#f59e0b','#10b981','#06b6d4','#ef4444','#84cc16','#a855f7','#14b8a6'];
  function tooltip(container){
    var host=container||document.body;
    var tip=document.createElement('div'); tip.className='ddb-tip';
    host.appendChild(tip);
    var rect=function(){ return host.getBoundingClientRect(); };
    return {
      show:function(clientX,clientY,html){ var r=rect(); tip.innerHTML=html; tip.style.left=(clientX-r.left)+'px'; tip.style.top=(clientY-r.top)+'px'; tip.style.opacity='1'; },
      hide:function(){ tip.style.opacity='0'; },
      el:tip
    };
  }
  return { fmt:fmt, trim:trim, truncate:truncate, palette:palette, tooltip:tooltip };
})();
`;

// Runs inside the widget/tile iframe: size reporting + theme reception.
const BRIDGE_JS = `
(function(){
  function measure(){
    var c=document.getElementById('chart');
    var h=Math.max(document.body.scrollHeight,document.documentElement.scrollHeight,c?c.scrollHeight:0);
    try{parent.postMessage({type:'widget-resize',height:h},'*');}catch(e){}
  }
  window.__measure=measure;
  window.addEventListener('load',measure);
  window.addEventListener('resize',measure);
  window.addEventListener('message',function(e){
    var d=e.data||{};
    if(d.type==='set-theme'){
      document.documentElement.setAttribute('data-theme',d.theme==='dark'?'dark':'light');
      document.documentElement.style.colorScheme=d.theme;
      measure();
    }
  });
})();
`;

export function assembleDocument(
  renderCore: string,
  dataSource: DataSource,
  opts: { title?: string } = {},
): string {

  let dataScript: string;
  if (dataSource.mode === "inline") {
    dataScript = `boot(${JSON.stringify(dataSource.rows)});`;
  } else {
    const url = `/tiles/${dataSource.vizId}/data?k=${dataSource.tileKey}`;
    dataScript = `
      function refresh(){
        fetch(${JSON.stringify(url)})
          .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
          .then(function(d){ boot(d.rows||[]); })
          .catch(fail);
      }
      var _rb=document.getElementById('ddb-refresh');
      if(_rb) _rb.addEventListener('click',refresh);
      refresh();`;
  }

  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${META_CSP}">
<style>${THEME_CSS}</style></head>
<body>
${
    // Served (fetch-mode) tiles are framed by the PCF, whose card bar already shows the title +
    // reload + remove — so suppress this inner header to avoid a duplicated title. The inline
    // Copilot-pane widget has no outer chrome, so it keeps its own title.
    dataSource.mode === "inline"
      ? `<div class="ddb-head"><span class="ddb-title">${escapeHtml(opts.title ?? "")}</span></div>`
      : ""
  }
<div id="chart"></div>
<div id="ddb-err" class="ddb-err" hidden></div>
<script>${BRIDGE_JS}</script>
<script>${DDB_JS}</script>
<script>${renderCore}</script>
<script>
var _rows=null;
function boot(rows){
  if(rows!=null) _rows=rows;
  try{
    var c=document.getElementById('chart'); c.innerHTML='';
    var e=document.getElementById('ddb-err'); e.hidden=true;
    render(c, _rows||[]);
    if(window.__measure) window.__measure();
  }catch(err){ fail(err); }
}
function fail(err){
  var e=document.getElementById('ddb-err'); e.hidden=false;
  e.textContent='Could not render: '+((err&&err.message)||err);
  if(window.__measure) window.__measure();
}
// Re-run render on resize so charts REFLOW (recompute layout) instead of just scaling.
(function(){var t;window.addEventListener('resize',function(){clearTimeout(t);t=setTimeout(function(){if(_rows!=null)boot();},140);});})();
${dataScript}
</script>
</body></html>`;
}

/** Convenience: the tile page for a registry tile (fetch mode). */
export function tilePage(renderCore: string, vizId: string, tileKey: string, title: string): string {
  return assembleDocument(renderCore, { mode: "fetch", vizId, tileKey }, { title });
}

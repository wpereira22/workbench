import { $, $$, h, SHORT, toast, fmt, clip, showCall, ENGINE } from "./ui.js";
import { BuildView } from "./build.js";
import { LibraryView } from "./library.js";
import { DataView } from "./data.js";
import { AnalyzeView } from "./analyze.js";

const MODES = { build: "#buildMode", documents: "#libraryMode", data: "#dataMode", query: "#analyzeMode" };

const app = {
  state: null,
  mode: "build",
  scope: null, // the selection a query runs over, handed over from the Data view

  async refreshState() {
    this.state = await fetch("/api/state").then((r) => r.json());
    for (const d of this.state.library) SHORT[d.id] = d.short;
    this.renderTop();
    return this.state;
  },

  renderTop() {
    const st = this.state;
    $(".brand").title = `${st.collection} · ${st.library.length} documents`;
    ENGINE.name = st.models.engine ?? "Jev";
    $("#jevPill").classList.toggle("ok", st.keys.decisions);
    $("#jevPill").lastChild.textContent = ENGINE.name;
    $("#jevPill").title = `${ENGINE.name} (${st.models.jev}) answers every decision`;
    $("#claudePill").classList.toggle("ok", !st.planner.error);
    $("#claudePill").title = st.planner.error ? `Claude Code: ${st.planner.error}` : "Claude Code designs queries and writes answers (your local CLI, no API key)";
    for (const b of $$(".modes button[data-mode]")) b.classList.toggle("on", b.dataset.mode === this.mode);
  },

  setMode(m) {
    if (!MODES[m]) m = "build";
    this.mode = m;
    for (const [k, sel] of Object.entries(MODES)) $(sel).hidden = k !== m;
    this.renderTop();
    if (m === "query") this.analyze.flow.draw();
    if (m === "data" && !this.data.res) this.data.load();
    if (m === "build") { this.build.renderList(); this.build.drawMosaic(); }
    if (location.hash !== `#${m}`) history.replaceState(null, "", `#${m}`);
  },

  async showInLibrary(docId, blockId) {
    this.setMode("documents");
    await this.library.open(docId, blockId);
  },

  showData(filters, lens) {
    this.setMode("data");
    this.data.show(filters, lens ?? "all");
  },

  showCallById(id) { showCall(id); },

  /** A selection from the Data view becomes the scope of the next query. */
  setScope(scope) {
    this.scope = scope;
    const chip = $("#cmdScope");
    chip.hidden = !scope;
    chip.replaceChildren(...(scope ? [h("span", {}, `over ${scope.label}`), h("button", { type: "button", title: "Query the whole library instead", onclick: () => this.setScope(null) }, "✕")] : []));
    if (scope) { $("#cmdInput").placeholder = "Describe the columns you want for these rows…"; $("#cmdInput").focus(); }
    else $("#cmdInput").placeholder = "Ask the library for a dataset…";
    this.analyze?.renderScope();
  },

  query(text) {
    if (!text) return;
    this.setMode("query");
    this.analyze.run({ question: text, scope: this.scope ?? undefined });
  },

  setActivity(label) {
    $("#activity").hidden = !label;
    $("#activityText").textContent = label ?? "";
  },

  async getDoc(id) {
    if (!this.library.cache.has(id)) this.library.cache.set(id, await fetch(`/api/doc/${id}`).then((r) => r.json()));
    return this.library.cache.get(id);
  },

  /** Shows where a row came from: the page crop with the block outlined, or the text in its section. */
  async sourcePreview(row, el) {
    const docId = row.src?.doc ?? row.doc;
    const { doc } = await this.getDoc(docId);
    const b = row.src?.block && doc.blocks.find((x) => x.id === row.src.block);
    const part = b?.parts?.find((p) => p.bbox) ?? (b?.bbox ? { page: b.page, bbox: b.bbox } : null);
    if (part?.page) {
      const pg = doc.pages[part.page - 1];
      const W = Math.max(280, el.clientWidth || 340);
      const k = W / pg.w;
      const [x0, y0, x1, y1] = part.bbox;
      const H = Math.min(260, Math.max(140, (y1 - y0) * k + 90));
      const offset = Math.max(0, Math.min(pg.h * k - H, (y0 + y1) / 2 * k - H / 2));
      el.replaceChildren(
        h("div", { class: "crop", style: `height:${H}px`, onclick: () => this.showInLibrary(docId, b.id), title: "Open this page in Documents" },
          h("img", { src: `/pages/${docId}/${part.page}.jpg`, style: `width:${W}px;top:${-offset}px` }),
          h("div", { class: "crop-box", style: `left:${x0 * k - 3}px;top:${y0 * k - offset - 3}px;width:${(x1 - x0) * k + 6}px;height:${(y1 - y0) * k + 6}px` })),
        h("div", { class: "muted tiny" }, `${doc.short} · page ${part.page} of ${doc.pages.length} · the outlined block is the exact text ${ENGINE.name} judged`),
        h("div", { class: "quote small" }, row.text));
    } else {
      el.replaceChildren(h("div", { class: "muted tiny" }, `${doc.short} · ${doc.format.toUpperCase()} · ${b?.tag ? `<${b.tag}> element` : "web capture"}`), h("div", { class: "quote small" }, row.text));
    }
  },

  onLibraryChanged(summary) {
    this.state.library = summary;
    for (const d of summary) SHORT[d.id] = d.short;
    this.renderTop();
  },

  setMetrics(m) {
    $("#libMetrics").textContent = m ? `${fmt(m.calls)} ${ENGINE.name} calls · ${fmt(m.predicates)} decisions · ${(m.wallMs / 1000).toFixed(1)} s · $${m.costUsd.toFixed(3)}` : "";
  },

  openKey() {
    const openai = this.state.models.provider === "openai";
    $("#keyTitle").textContent = `${ENGINE.name} key`;
    $("#keyLink").href = openai ? "https://platform.openai.com/api-keys" : "https://console.typesafe.ai/keys";
    $("#keyLink").textContent = openai ? "platform.openai.com/api-keys" : "console.typesafe.ai/keys";
    $("#keyInput").placeholder = openai ? "sk-…" : "ts_…";
    $("#keyErr").textContent = "";
    $("#keyInput").value = "";
    $("#keyDlg").showModal();
  },
};

async function boot() {
  await app.refreshState();
  app.build = new BuildView(app);
  app.library = new LibraryView(app);
  app.data = new DataView(app);
  app.analyze = new AnalyzeView(app);
  // Each workspace mounts while visible so its layout can measure itself.
  for (const [k, sel] of Object.entries(MODES)) $(sel).hidden = false;
  app.build.mount($("#buildMode"));
  app.library.mount($("#libraryMode"), app.state.library);
  app.data.mount($("#dataMode"));
  app.analyze.mount($("#analyzeMode"), app.state.programs);
  app.setMode(location.hash.slice(1) || "build");
}

for (const b of $$(".modes button[data-mode]")) b.addEventListener("click", () => app.setMode(b.dataset.mode));
addEventListener("hashchange", () => { const m = location.hash.slice(1); if (MODES[m] && m !== app.mode) app.setMode(m); });
$("#jevPill").addEventListener("click", () => app.openKey());
$("#claudePill").addEventListener("click", () => toast(app.state.planner.error ?? `Queries are designed and answers written by your local Claude Code CLI (${app.state.planner.model ?? "default model"}). No API key needed.`, app.state.planner.error ? "err" : "info"));
$("#cmdForm").addEventListener("submit", (e) => { e.preventDefault(); const q = $("#cmdInput").value.trim(); if (q) { app.query(q); $("#cmdInput").value = ""; } });
addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("#cmdInput").focus(); }
  if (e.key === "Escape" && !document.querySelector("dialog[open]")) { app.data?.closeDetail(); }
});
$("#keyForm").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "save") return;
  e.preventDefault();
  const r = await fetch("/api/key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: $("#keyInput").value.trim() }) });
  const j = await r.json();
  if (!r.ok) return ($("#keyErr").textContent = j.error);
  $("#keyDlg").close();
  app.refreshState();
});
$("#mClose").addEventListener("click", () => $("#modal").close());
$("#modal").addEventListener("click", (e) => { if (e.target === $("#modal")) $("#modal").close(); });

// Drop a file anywhere: it goes to Build and parses live.
let dragDepth = 0;
addEventListener("dragenter", (e) => { if (e.dataTransfer?.types.includes("Files")) { dragDepth++; $("#dropVeil").hidden = false; } });
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#dropVeil").hidden = true; } });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("#dropVeil").hidden = true;
  if (e.target.closest?.("#dropZone")) return; // the Build drop zone handles its own drops
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length) { app.setMode("build"); app.build.upload(files); }
});

boot().catch((err) => toast(err.message));
window.app = app;

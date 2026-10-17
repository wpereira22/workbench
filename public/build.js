// Build: add documents and watch Jev parse them, live. Every event the parser streams becomes motion here: the
// decision flow (which questions run, and which branch each block takes), the audit stack firing, parse health
// falling, the pages filling with color, and a feed of the decisions themselves.
import { $, h, s, fmt, pct, human, clip, toast, streamPost, ROLE_COLOR, ROLE_LABEL, MOD_COLOR, MOD_LABEL, CONTENT_ROLES, SERIES } from "./ui.js";

const CHECKS = [
  ["R3", "Re-verify stitches"], ["R1", "Find fragments"], ["R2", "Attach fragments"], ["R4", "Second opinion on roles"],
  ["R13", "Running headers"], ["M1", "Trust markup?"], ["R8", "Rebuild rows"], ["R9", "Repeated headings"], ["R12", "Split run-in headings"],
  ["R11", "Numbering stack"], ["R10", "Nesting"],
];
const LOOP = [["L-attach", "attach fragments"], ["L-split", "split long headings"], ["L-empty", "empty headings"], ["L-number", "numbering conflicts"], ["L-runoff", "runoff on close calls"]];

/** Which node of the flow a Jev call belongs to, and how to say its question in a few words. */
function stageOf(stage) {
  if (stage.startsWith("S0")) return "stitch";
  if (stage.startsWith("S1")) return "profile";
  if (stage.startsWith("S2")) return "roles";
  if (stage.startsWith("S3")) return "levels";
  if (stage.startsWith("S4")) return "modality";
  if (stage.startsWith("S5")) return "sections";
  if (/^A L /.test(stage)) return "loop";
  if (/^A relabel/.test(stage)) return "audit";
  const m = stage.match(/^A (R\d+|M1)/);
  return m ? m[1] : "audit";
}
const SAY = {
  stitch: () => "continues into a later piece?",
  roles: () => "what is this block?",
  levels: () => "IF heading → how deep?",
  modality: (k) => (k.startsWith("dl__") ? "IF content → sets a deadline?" : "IF content → must · may · defines?"),
  sections: (k) => (k === "role" ? "what does this section do?" : `is it about ${human(k.replace(/^topic_/, ""))}?`),
  profile: (k) => (k.startsWith("topic_") ? `about ${human(k.replace(/^topic_/, ""))}?` : human(k) + "?"),
};
const answerText = (a, stage, k) => {
  if (!a) return "—";
  if (a.c != null) return stage === "stitch" ? (a.c === "none" ? "no" : `yes → ${a.c.replace("next", "piece ")}`) : human(ROLE_LABEL[a.c] ?? MOD_LABEL[a.c] ?? a.c);
  if (a.s != null) return stage === "levels" ? `level ${Math.round(a.s)}` : `score ${a.s}`;
  return `${a.p >= 0.5 ? "yes" : "no"} ${pct(a.p)}`;
};
const answerColor = (a, stage) => (a?.c && stage === "roles" ? ROLE_COLOR[a.c] : a?.c && stage === "modality" ? MOD_COLOR[a.c] : a?.p != null ? (a.p >= 0.5 ? "#82d1a4" : "#77777f") : "#b7bfff");

export class BuildView {
  constructor(app) {
    this.app = app;
    this.sel = null; // selected document id
    this.job = null; // the build being watched
    this.busy = false;
  }

  mount(el) {
    this.el = el;
    el.replaceChildren(
      h("aside", { class: "side" },
        h("label", { class: "adder", id: "dropZone", ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add("over"); }, ondragleave: (e) => e.currentTarget.classList.remove("over"), ondrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove("over"); this.upload([...e.dataTransfer.files]); } },
          h("input", { type: "file", accept: ".pdf,.html,.htm,application/pdf,text/html", multiple: true, hidden: true, onchange: (e) => this.upload([...e.target.files]) }),
          h("span", { class: "adder-plus" }, "+"),
          h("span", { class: "adder-text" }, h("b", {}, "Add a document"), h("small", {}, "Drop a PDF or HTML file, or click")),
        ),
        h("form", { class: "urlform", onsubmit: (e) => { e.preventDefault(); this.addUrl(e.target.url.value.trim()); e.target.reset(); } },
          h("input", { name: "url", placeholder: "or paste a link and press Enter" })),
        h("div", { class: "side-label" }, h("span", {}, "Library"), h("span", { id: "bqTitle" })),
        h("div", { class: "doclist", id: "bqList" }),
      ),
      h("section", { class: "bstage" },
        h("div", { class: "bscroll" },
          h("header", { class: "bhead", id: "bHead" }),
          h("div", { class: "stats", id: "bStats" }),
          h("div", { class: "section-label" }, "How Jev parsed it"),
          h("div", { class: "steps", id: "river" }),
          h("div", { class: "mosaic-wrap" },
            h("div", { class: "section-label row between" }, h("span", {}, "Every block on every page"), h("div", { class: "legend", id: "mosLegend" })),
            h("canvas", { id: "mosaic" })),
        ),
      ),
      h("aside", { class: "feedpanel" },
        h("div", { class: "feed-h" }, h("span", {}, "Decisions as they land"), h("span", { class: "num", id: "bFeedStats" })),
        h("div", { class: "dfeed", id: "dFeed" }, h("div", { class: "empty" }, "Rebuild a document, or drop a new one, and every question Jev answers appears here: which block, what it asked, what it decided.")),
      ),
    );
    $("#mosLegend").replaceChildren(...Object.entries(ROLE_LABEL).filter(([k]) => !["front_matter", "page_furniture", "toc_entry"].includes(k)).map(([k, l]) => h("span", {}, h("i", { style: `background:${ROLE_COLOR[k]}` }), l)));
    this.renderList();
    const first = this.app.state.library.find((d) => d.id === "genius-act") ?? this.app.state.library[0];
    if (first) this.select(first.id);
    new ResizeObserver(() => this.drawMosaic()).observe($("#river"));
  }

  // ───────────── library list ─────────────

  renderList() {
    const docs = this.app.state.library;
    $("#bqTitle").textContent = `${docs.length} · ${fmt(docs.reduce((a, d) => a + d.pages, 0))} pages`;
    $("#bqList").replaceChildren(...[...docs].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")).map((d) => h("button", { class: `docitem ${this.sel === d.id ? "on" : ""} ${this.job?.id === d.id && this.busy ? "live" : ""}`, onclick: () => this.select(d.id) },
      h("span", { class: "dt" }, d.short, d.health?.after ? h("i", { class: "hdot", title: `${d.health.after} open parse issue${d.health.after > 1 ? "s" : ""}` }) : null),
      h("span", { class: "dm" }, `${d.format.toUpperCase()}${d.pages ? ` · ${d.pages} pp` : ""} · ${fmt(d.blocks)} blocks${d.metrics ? ` · ${(d.metrics.wallMs / 1000).toFixed(1)} s` : ""}`))));
  }

  select(id) {
    this.sel = id;
    if (!this.busy) {
      const d = this.app.state.library.find((x) => x.id === id);
      this.job = this.newJob(id, d);
      this.job.idle = true;
      this.loadDoc(id).then(() => { this.fillFromSaved(id); this.render(); });
    }
    this.renderList();
    this.render();
  }

  // ───────────── jobs ─────────────

  newJob(id, d) {
    return {
      id, title: d?.title ?? "", short: d?.short ?? "", format: d?.format ?? "pdf", t0: Date.now(), end: null, idle: false, status: "starting",
      pages: d?.pages ?? 0, raw: d?.rawBlocks ?? 0, blocks: d?.blocks ?? 0, ocr: 0, joins: 0,
      nodes: Object.fromEntries(["extract", "stitch", "profile", "roles", "levels", "modality", "audit", "loop", "sections", "outline", ...CHECKS.map(([c]) => c)].map((k) => [k, { n: 0, calls: 0 }])),
      roles: {}, mods: {}, heads: 0, content: 0, other: 0, checks: {}, loopRounds: 0, health: null, sections: 0, secRoles: {},
      inflight: 0, calls: 0, decisions: 0, cached: 0, cost: 0, rate: [], last: [], profile: null,
      geo: null, lab: new Map(), feed: [], feedTotal: 0,
    };
  }

  async loadDoc(id) {
    const v = await fetch(`/api/doc/${id}`).then((r) => (r.ok ? r.json() : null));
    if (!v || this.job?.id !== id) return;
    const J = this.job;
    J.geo = { pages: v.doc.pages, blocks: (v.doc.raw ?? v.doc.blocks).map(({ id, page, bbox, text }) => ({ id, page, bbox, len: text.length })), format: v.doc.format };
    J.saved = v;
    this.drawMosaic();
  }

  /** A document not being rebuilt shows its last build, from what was saved. */
  fillFromSaved(id) {
    const J = this.job, v = J?.saved;
    if (!v || J.id !== id || !J.idle) return;
    const st = v.structure;
    if (!st) return;
    J.blocks = v.doc.blocks.length;
    J.geo.blocks = v.doc.blocks.map(({ id, page, bbox, parts, text }) => ({ id, page, bbox, parts, len: text.length }));
    for (const [bid, l] of Object.entries(st.blocks)) {
      J.lab.set(bid, l.role);
      J.roles[l.role] = (J.roles[l.role] ?? 0) + 1;
      if (l.modality) J.mods[l.modality] = (J.mods[l.modality] ?? 0) + 1;
    }
    J.heads = J.roles.heading ?? 0;
    J.content = [...CONTENT_ROLES].reduce((a, r) => a + (J.roles[r] ?? 0), 0);
    J.other = Object.values(J.roles).reduce((a, n) => a + n, 0) - J.heads - J.content;
    for (const c of st.audit?.checks ?? []) J.checks[c.id] = c;
    J.loopRounds = Math.max(0, ...(st.audit?.loop ?? []).map((x) => x.round));
    J.health = st.health ? { before: st.health.before.total, after: st.health.after.total, verified: st.health.after.verified ?? 0 } : null;
    J.sections = st.sections.length;
    for (const s of st.sections) if (s.role) J.secRoles[s.role] = (J.secRoles[s.role] ?? 0) + 1;
    J.profile = st.profile;
    J.joins = st.stitched?.links?.length ?? 0;
    const m = st.metrics;
    if (m) Object.assign(J, { calls: m.calls, elapsed: m.wallMs, decisions: m.decisions ?? 0 });
    for (const [stage, n] of Object.entries(m?.byStage ?? {})) { const k = stageOf(stage); (J.nodes[k] ??= { n: 0, calls: 0 }).n += n; if (/^R\d|^M1/.test(k)) J.nodes.audit.n += n; }
    this.drawMosaic();
  }

  async upload(files) {
    for (const f of files.filter((f) => /\.(pdf|html?)$/i.test(f.name) || /pdf|html/.test(f.type))) {
      if (this.busy) return toast("A build is already running.", "warn");
      await this.watch(`/api/library/upload`, f, { name: f.name, label: `Uploading ${f.name}` });
    }
    if (files.length && !files.some((f) => /\.(pdf|html?)$/i.test(f.name))) toast("Drop a PDF or an HTML file.", "warn");
  }

  addUrl(url) {
    if (!/^https?:\/\//.test(url)) return toast("Paste a link that starts with http(s)://", "warn");
    this.watch("/api/library/add", null, { url, label: `Downloading ${clip(url, 60)}` });
  }

  rebuild(fresh) {
    if (!this.sel) return;
    this.watch("/api/library/structure", null, { ids: [this.sel], fresh, label: fresh ? "Re-parsing with live Jev calls" : "Rebuilding (answers served from cache)" });
  }

  async watch(url, file, opts) {
    if (this.busy) return toast("A build is already running.", "warn");
    if (!this.app.state.keys.typesafe) return this.app.openKey();
    this.busy = true;
    const d = opts.ids ? this.app.state.library.find((x) => x.id === opts.ids[0]) : null;
    this.job = this.newJob(d?.id ?? null, d);
    this.job.status = opts.label;
    this.job.fresh = Boolean(opts.fresh);
    $("#dFeed").replaceChildren();
    if (d) await this.loadDoc(d.id);
    if (this.job.geo) { this.job.geo.blocks = this.job.geo.blocks.map((b) => ({ ...b })); this.job.lab.clear(); }
    this.app.setActivity(opts.label);
    this.tick = setInterval(() => this.sample(), 250);
    this.render();
    try {
      const onEvent = (ev) => this.onEvent(ev);
      if (file) {
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": file.type || "application/pdf", "X-File-Name": encodeURIComponent(file.name) }, body: file });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line) onEvent(JSON.parse(line)); }
        }
      } else await streamPost(url, opts.ids ? { ids: opts.ids, fresh: opts.fresh } : { url: opts.url }, onEvent);
    } catch (err) {
      toast(err.message);
      this.job.status = `Failed: ${err.message}`;
    } finally {
      clearInterval(this.tick);
      this.sample();
      this.busy = false;
      this.job.end ??= Date.now();
      this.app.setActivity(null);
      await this.app.refreshState();
      this.app.library?.cache.delete(this.job.id);
      this.app.onLibraryChanged(this.app.state.library);
      this.app.library?.setSummary(this.app.state.library);
      this.app.data?.invalidate();
      if (this.job.id) this.sel = this.job.id;
      this.renderList();
      this.render();
    }
  }

  async remove(id) {
    const d = this.app.state.library.find((x) => x.id === id);
    if (!confirm(`Remove “${d?.short ?? id}” from the library? Its file, extraction, and structure are deleted.`)) return;
    const r = await fetch(`/api/library/${id}`, { method: "DELETE" });
    if (!r.ok) return toast((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
    await this.app.refreshState();
    this.app.onLibraryChanged(this.app.state.library);
    this.app.library?.cache.delete(id);
    this.app.library?.setSummary(this.app.state.library);
    this.app.data?.invalidate();
    const next = this.app.state.library[0];
    if (next) this.select(next.id);
    toast(`Removed ${d?.short ?? id}.`, "info");
  }

  // ───────────── events ─────────────

  onEvent(ev) {
    const J = this.job;
    const N = (k) => J.nodes[k] ?? (J.nodes[k] = { n: 0, calls: 0 });
    switch (ev.t) {
      case "add_status":
        J.status = { uploaded: `Uploaded ${fmt(ev.bytes)} bytes`, downloading: "Downloading", extracting: "Extracting text and layout (code)", extracted: "Extracted", structuring: "Jev is structuring" }[ev.status] ?? ev.status;
        if (ev.id) J.id = ev.id;
        if (ev.status === "extracted") Object.assign(J, { pages: ev.pages, raw: ev.blocks, ocr: ev.ocr });
        if (ev.status === "structuring") {
          const d = ev.library?.find((x) => x.id === ev.id);
          if (d) Object.assign(J, { title: d.title, short: d.short, format: d.format });
          this.app.state.library = ev.library ?? this.app.state.library;
          this.renderList();
          this.loadDoc(ev.id);
        }
        break;
      case "pending": J.inflight++; break;
      case "fail": J.inflight--; this.feedLine({ stage: ev.stage, err: ev.error }); break;
      case "call": {
        J.inflight--;
        J.calls++;
        J.decisions += ev.n;
        if (ev.cached) J.cached++;
        const node = stageOf(ev.stage);
        N(node).n += ev.n;
        N(node).calls++;
        N(node).hit = performance.now();
        if (/^R\d|^M1/.test(node)) { N("audit").n += ev.n; N("audit").hit = performance.now(); }
        for (const p of ev.peek ?? []) this.feedLine({ stage: ev.stage, node, ...p, call: ev.id });
        break;
      }
      case "metrics": J.cost = ev.m.costUsd; J.metrics = ev.m; break;
      case "lib_stage": if (ev.stage === "S0" && ev.total) J.raw = ev.total; break;
      case "lib_stitch": J.joins += ev.items.length; break;
      case "lib_stitched":
        J.blocks = ev.blocks.length;
        if (J.geo) J.geo.blocks = ev.blocks.map(({ id, page, bbox, parts, text }) => ({ id, page, bbox, parts, len: text?.length ?? 40 }));
        break;
      case "lib_profile": J.profile = ev.profile; break;
      case "lib_blocks":
        for (const it of ev.items) {
          if (ev.stage === "S2") {
            const was = J.lab.get(it.b);
            if (was) J.roles[was]--;
            J.lab.set(it.b, it.role);
            J.roles[it.role] = (J.roles[it.role] ?? 0) + 1;
          } else if (ev.stage === "S4" && it.modality) J.mods[it.modality] = (J.mods[it.modality] ?? 0) + 1;
        }
        J.heads = J.roles.heading ?? 0;
        J.content = [...CONTENT_ROLES].reduce((a, r) => a + (J.roles[r] ?? 0), 0);
        J.other = Object.values(J.roles).reduce((a, n) => a + n, 0) - J.heads - J.content;
        J.dirtyMosaic = true;
        break;
      case "lib_audit": J.checks[ev.check.id] = ev.check; break;
      case "lib_health":
        J.health ??= {};
        J.health[ev.phase === "before" ? "before" : "after"] = ev.counts.total;
        if (ev.phase === "after") J.health.verified = ev.counts.verified ?? 0;
        break;
      case "lib_outline": J.sections = ev.sections.length; break;
      case "lib_section": if (ev.section.role) J.secRoles[ev.section.role] = (J.secRoles[ev.section.role] ?? 0) + 1; break;
      case "lib_done": J.end = Date.now(); J.status = "Done"; J.doneMetrics = ev.metrics; break;
      case "fatal": J.status = `Failed: ${ev.error}`; toast(ev.error); break;
    }
    this.schedule();
  }

  feedLine(x) {
    const J = this.job;
    J.feedTotal++;
    J.feed.push(x);
    if (J.feed.length > 4000) J.feed.splice(0, 2000);
  }

  /** Four times a second: decisions-per-second for the sparkline. */
  sample() {
    const J = this.job;
    if (!J) return;
    const now = Date.now();
    J.rate.push([now, J.decisions]);
    while (J.rate.length > 160) J.rate.shift();
    this.schedule();
  }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
      this.flushFeed();
      if (this.job?.dirtyMosaic) { this.job.dirtyMosaic = false; this.drawMosaic(); }
    });
  }

  // ───────────── rendering ─────────────

  render() {
    const J = this.job;
    if (!J) return;
    const d = this.app.state.library.find((x) => x.id === J.id);
    const elapsed = J.idle ? J.elapsed : (J.end ?? Date.now()) - J.t0;
    const est = d ? Math.max(0.01, (d.pages || d.blocks / 40) * 0.0022) : null;
    const meta = [J.profile ? human(J.profile.doc_type) : null, (J.format ?? "").toUpperCase(), J.pages ? `${J.pages} pages` : null, J.ocr ? `${J.ocr} scanned page${J.ocr > 1 ? "s" : ""} read with OCR` : null].filter(Boolean).join(" · ");
    const act = (label, onclick, cls = "", title) => h("button", { class: `act ${cls}`, onclick, title }, label);
    $("#bHead").replaceChildren(...[
      h("div", { class: "bh-meta" }, meta, h("span", { class: `bstatus ${this.busy ? "live" : J.idle ? "" : "done"}` }, this.busy ? J.status : J.idle ? "last build" : J.status)),
      h("h1", { class: "bh-title" }, J.title || J.short || "New document"),
      J.id && !this.busy ? h("div", { class: "bh-actions" },
        act("Watch it rebuild", () => this.rebuild(false), "strong", "Run the whole parse again with every answer served from the cache: the pipeline at full speed, for free"),
        act(`Re-parse live${est ? ` · ≈$${est.toFixed(2)}` : ""}`, () => confirm(`Re-parse ${J.short} with live Jev calls (about $${est?.toFixed(2)})?`) && this.rebuild(true), "", "Ask Jev every question again, live"),
        act("Open document", () => this.app.showInLibrary(J.id)),
        act("Its data", () => this.app.showData({ doc: [J.id] })),
        act("Remove", () => this.remove(J.id), "danger", "Remove this document from the library")) : null,
    ].filter(Boolean));
    const rate = this.rateNow();
    const H = J.health;
    $("#bStats").replaceChildren(...[
      stat("Decisions", fmt(J.decisions || (J.idle ? null : 0)), `${fmt(J.calls)} Jev calls${J.cached ? `, ${fmt(J.cached)} cached` : ""}`),
      J.idle ? null : h("div", { class: "stat" }, h("span", { class: "k" }, "Per second"), h("b", { class: `v ${this.busy ? "live" : ""}` }, this.busy ? fmt(Math.round(rate)) : J.idle || !elapsed ? "—" : fmt(Math.round(J.decisions / Math.max(0.1, elapsed / 1000)))), this.spark()),
      stat("Blocks", fmt(J.blocks || null), J.raw && J.raw !== J.blocks ? `from ${fmt(J.raw)} pieces` : "with positions"),
      stat("Open issues", H ? `${H.before ?? "…"} → ${H.after ?? "…"}` : "—", H?.verified ? `${H.verified} more confirmed fine` : "before → after audit"),
      stat(J.idle ? "Built in" : "Elapsed", elapsed == null ? "—" : elapsed < 1000 ? `${Math.round(elapsed)} ms` : `${(elapsed / 1000).toFixed(1)} s`, J.idle ? "" : this.busy ? `${Math.max(0, J.inflight)} calls in flight` : ""),
      J.idle ? null : stat("Jev cost", `$${(J.cost ?? 0).toFixed(3)}`, J.fresh ? "live calls" : "cache is free"),
    ].filter(Boolean));
    this.renderRiver();
  }

  rateNow() {
    const r = this.job?.rate ?? [];
    if (r.length < 2) return 0;
    const a = r[Math.max(0, r.length - 5)], b = r[r.length - 1];
    return (b[1] - a[1]) / Math.max(0.001, (b[0] - a[0]) / 1000);
  }

  spark() {
    const r = this.job?.rate ?? [];
    const W = 120, Hh = 18;
    if (r.length < 3) return s("svg", { viewBox: `0 0 ${W} ${Hh}`, preserveAspectRatio: "none", height: Hh, class: "spark" });
    const rates = r.slice(1).map((x, i) => (x[1] - r[i][1]) / Math.max(0.001, (x[0] - r[i][0]) / 1000));
    const max = Math.max(1, ...rates);
    const pts = rates.map((v, i) => `${(i / Math.max(1, rates.length - 1)) * W},${Hh - 2 - (v / max) * (Hh - 4)}`).join(" ");
    return s("svg", { viewBox: `0 0 ${W} ${Hh}`, preserveAspectRatio: "none", height: Hh, class: "spark" }, s("polyline", { points: pts, fill: "none", stroke: "currentColor", "stroke-width": 1.25, "vector-effect": "non-scaling-stroke" }));
  }

  /** The parse as a program: each step is a question Jev answers, and the IF/ELSE branches after
   *  "what is each block?" decide which questions a block meets next. Steps glow as their answers land. */
  renderRiver() {
    const J = this.job;
    const now = performance.now();
    const hotK = (k) => J.nodes[k]?.hit && now - J.nodes[k].hit < 400;
    const nodeN = (k) => (J.idle && !J.decisions ? null : J.nodes[k]?.n ?? 0);
    const totalRoles = Object.values(J.roles).reduce((a, n) => a + n, 0);
    const totalMods = Object.values(J.mods).reduce((a, n) => a + n, 0);
    const bar = (dist, colors, labels) => {
      const items = Object.entries(dist).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
      const tot = items.reduce((a, [, n]) => a + n, 0);
      if (!tot) return null;
      return h("div", { class: "dist" },
        h("div", { class: "dist-bar" }, items.map(([k, n]) => h("span", { style: `flex:${n};background:${colors[k] ?? "#55555c"}`, title: `${labels[k] ?? human(k)} ${fmt(n)}` }))),
        h("div", { class: "dist-legend" }, items.slice(0, 4).map(([k, n]) => h("span", {}, h("i", { style: `background:${colors[k] ?? "#55555c"}` }), `${labels[k] ?? human(k)} `, h("b", {}, fmt(n))))));
    };
    const step = ({ id, name, eng, q, n, unit, viz, cls = "", hot = hotK(id), body = null }) => {
      const ran = n != null && n !== 0 && n !== "—";
      return h("div", { class: `step ${cls} ${hot ? "hot" : ""} ${ran ? "ran" : ""}`, id: `rn-${id}` },
        h("span", { class: "step-dot" }),
        h("div", { class: "step-main" }, h("div", { class: "step-name" }, name, eng ? h("span", { class: `eng ${eng}` }, eng) : null), q ? h("div", { class: "step-q" }, q) : null),
        h("div", { class: "step-val" }, h("b", {}, n == null ? "—" : typeof n === "number" ? fmt(n) : n), unit ? h("span", {}, unit) : null),
        h("div", { class: "step-viz" }, viz),
        body ? h("div", { class: "step-body" }, body) : null);
    };
    const check = ([id, label]) => {
      const c = J.checks[id];
      return h("div", { class: `ck ${c ? "ran" : ""} ${hotK(id) ? "hot" : ""}`, title: c?.detail ?? label },
        h("span", { class: "ck-id" }, id.startsWith("L-") ? "" : id), h("span", { class: "ck-l" }, label),
        h("span", { class: "ck-n" }, c ? [fmt(c.examined), " → ", h("b", {}, fmt(c.fixed)), c.verified ? ` ✓${c.verified}` : "", c.rolledBack ? ` ↩${c.rolledBack}` : ""] : ""));
    };
    const topics = J.profile ? Object.entries(J.profile.topics ?? {}).filter(([, p]) => p >= 0.5).map(([k]) => human(k)).slice(0, 3).join(", ") : "";
    $("#river").replaceChildren(
      step({ id: "extract", name: "Extract", eng: "code", q: "Lines, positions and fonts become pieces", n: J.raw || null, unit: `pieces${J.pages ? ` from ${J.pages} pages` : ""}`, hot: this.busy && !J.raw }),
      step({ id: "stitch", name: "Stitch", eng: "jev", q: J.format === "pdf" ? "Does this piece continue in a later one?" : "PDF only", n: nodeN("stitch"), unit: J.joins ? `decisions · ${fmt(J.joins)} joined` : "decisions" }),
      step({ id: "profile", name: "Profile", eng: "jev", q: "What kind of document is this?", n: J.profile ? human(J.profile.doc_type) : null, unit: topics }),
      step({ id: "roles", name: "Roles", eng: "jev", q: "What is each block?", n: J.idle ? totalRoles : nodeN("roles"), unit: J.idle ? "blocks labeled" : "decisions", viz: bar(J.roles, ROLE_COLOR, ROLE_LABEL) }),
      step({ id: "levels", name: "If heading", eng: "jev", q: "How deep does it sit?", n: J.heads, unit: "headings", cls: "branch" }),
      step({ id: "modality", name: "If content", eng: "jev", q: "Must, may, or defines? Sets a deadline?", n: J.content, unit: "content blocks", viz: bar(J.mods, MOD_COLOR, MOD_LABEL), cls: "branch" }),
      step({ id: "stop", name: "Else", eng: "", q: "Footnotes, furniture, tables, contents: stop here", n: J.other, unit: "blocks", cls: "branch last dim", hot: false }),
      step({ id: "audit", name: "Audit", eng: "jev", q: "Eleven checks for what is still wrong", n: nodeN("audit"), unit: "decisions", body: h("div", { class: "cks" }, CHECKS.map(check)) }),
      step({ id: "loop", name: "Issue loop", eng: "jev", q: "Measure, route, fix, re-measure", n: J.loopRounds || null, unit: J.loopRounds ? `round${J.loopRounds > 1 ? "s" : ""}` : "", body: h("div", { class: "cks" }, LOOP.map(check)) }),
      step({ id: "health", name: "Health", eng: "code", q: "Open issues before and after the audit", n: J.health ? `${J.health.before ?? "…"} → ${J.health.after ?? "…"}` : null, unit: J.health?.verified ? `${J.health.verified} confirmed fine` : "", hot: false }),
      step({ id: "sections", name: "Sections", eng: "jev", q: "What does each section do?", n: J.sections || null, unit: "sections", viz: bar(J.secRoles, Object.fromEntries(Object.entries(J.secRoles).sort((a, b) => b[1] - a[1]).map(([k], i) => [k, SERIES[i] ?? "#55555c"])), {}) }),
    );
  }

  /** Every block on every page, colored by its role as Jev decides it (HTML documents: one bar per block). */
  drawMosaic() {
    const cv = $("#mosaic"), J = this.job;
    if (!cv || !J?.geo) return;
    const W = cv.parentElement.clientWidth - 2;
    const dpr = devicePixelRatio || 1;
    const ctx = cv.getContext("2d");
    const color = (id) => ROLE_COLOR[J.lab.get(id)] ?? "#26262a";
    const g = J.geo;
    if (g.pages?.length) {
      const pw = g.pages.length > 120 ? 40 : g.pages.length > 40 ? 52 : 74;
      const cols = Math.max(1, Math.floor((W + 6) / (pw + 6)));
      const ph = Math.round(pw * (g.pages[0].h / g.pages[0].w));
      const rows = Math.ceil(g.pages.length / cols);
      const Hh = rows * (ph + 6);
      cv.width = W * dpr; cv.height = Hh * dpr; cv.style.width = `${W}px`; cv.style.height = `${Hh}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, Hh);
      const origin = (p) => [((p - 1) % cols) * (pw + 6), Math.floor((p - 1) / cols) * (ph + 6)];
      for (const pg of g.pages) { const [x, y] = origin(pg.n); ctx.fillStyle = "#161618"; ctx.fillRect(x, y, pw, ph); }
      for (const b of g.blocks) {
        for (const pt of b.parts ?? [{ page: b.page, bbox: b.bbox }]) {
          if (!pt.bbox || !pt.page) continue;
          const pg = g.pages[pt.page - 1];
          const [x, y] = origin(pt.page);
          const k = pw / pg.w;
          ctx.fillStyle = color(b.id);
          ctx.fillRect(x + pt.bbox[0] * k, y + pt.bbox[1] * k, Math.max(1, (pt.bbox[2] - pt.bbox[0]) * k), Math.max(1, (pt.bbox[3] - pt.bbox[1]) * k));
        }
      }
    } else {
      // HTML: blocks flow like text, one bar per block, width by length.
      const lineH = 5, gap = 2;
      let x = 0, y = 0;
      const items = g.blocks.map((b) => ({ id: b.id, w: Math.max(4, Math.min(W * 0.5, Math.sqrt(b.len) * 4)) }));
      for (const it of items) { if (x + it.w > W) { x = 0; y += lineH + gap; } it.x = x; it.y = y; x += it.w + gap; }
      const Hh = y + lineH + 2;
      cv.width = W * dpr; cv.height = Hh * dpr; cv.style.width = `${W}px`; cv.style.height = `${Hh}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, Hh);
      for (const it of items) { ctx.fillStyle = color(it.id); ctx.fillRect(it.x, it.y, it.w, lineH); }
    }
  }

  /** The feed shows a sample of decisions as they land; under load it keeps up by showing every Nth one. */
  flushFeed() {
    const J = this.job, f = $("#dFeed");
    if (!J || !f) return;
    const pending = J.feed.slice(J.feedShown ?? 0);
    J.feedShown = J.feed.length;
    if (!pending.length) return;
    const step = Math.max(1, Math.ceil(pending.length / 14));
    const frag = document.createDocumentFragment();
    for (let i = 0; i < pending.length; i += step) frag.append(this.feedRow(pending[i]));
    if (step > 1) frag.append(h("div", { class: "df more" }, `+ ${fmt(pending.length - Math.ceil(pending.length / step))} more in this instant`));
    const stick = f.scrollTop + f.clientHeight >= f.scrollHeight - 60;
    f.append(frag);
    while (f.childElementCount > 220) f.firstElementChild.remove();
    if (stick) f.scrollTop = f.scrollHeight;
    $("#bFeedStats").textContent = fmt(J.feedTotal);
  }

  feedRow(x) {
    if (x.err) return h("div", { class: "df err" }, h("span", { class: "st" }, x.stage), x.err);
    const say = SAY[x.node]?.(x.k ?? "") ?? clip((x.q ?? "").replace(/`/g, ""), 70);
    return h("div", { class: `df n-${x.node}`, onclick: x.call ? () => this.app.showCallById(x.call) : null, title: "Open the Jev call" },
      h("span", { class: "q" }, say),
      h("span", { class: "a", style: `--c:${answerColor(x.a, x.node)}` }, answerText(x.a, x.node, x.k)),
      x.t ? h("span", { class: "t" }, clip(x.t, 90)) : null);
  }
}

const stat = (k, v, sub) => h("div", { class: "stat" }, h("span", { class: "k" }, k), h("b", { class: "v" }, v), h("span", { class: "sub" }, sub || "\u00a0"));

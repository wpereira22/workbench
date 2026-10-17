import { $, h, kids, fmt, pct, human, clip, esc, short, toast, tipHandlers, hideTip, showCall, streamPost,
  ROLE_COLOR, ROLE_LABEL, MOD_COLOR, MOD_LABEL, SECROLE_FAMILY, FAMILY_COLOR, FAMILY_LABEL, SERIES, CONTENT_ROLES } from "./ui.js";

const FORMAT_LABEL = { pdf: "PDF", html: "HTML", web: "Web" };
const FORCE = ["no legal force", "non-binding staff views", "agency interpretation", "proposed, not in force", "binding"];
const LEVEL_SIZE = [22, 19, 16.5, 15, 14];
const levelSize = (lv) => LEVEL_SIZE[Math.max(0, Math.min(LEVEL_SIZE.length - 1, lv ?? 2))];
const LEVEL_NAME = ["document title", "part / chapter", "section", "subsection", "minor heading"];
const CONTENT = CONTENT_ROLES;
const ISSUE_LABEL = { fragment: "stray fragments", dangling_hyphen: "dangling hyphens", empty_section: "empty headings", long_heading: "over-long headings", level_conflict: "level conflicts in a numbering family", numbering_conflict: "levels that contradict the numbering", low_confidence: "low-confidence roles" };
const CHECK_CALL = { running: "running-header check (R13)", tiebreak: "tie-break between two checks", runin: "run-in split (R12)", repeat: "repeat check (R9)", empty: "empty-heading check", peers: "peer-level check", split: "long-heading check", row: "row check (R8)", nesting: "nesting (R10)" };

/** Run-in headings split off a paragraph share its page position: give each piece its own slice of it
 *  (heading on top, sized by its share of the text, at least one line), so both can be seen and clicked. */
function splitSlices(blocks) {
  const out = new Map();
  const groups = new Map();
  for (const b of blocks) if (b.split && b.parts?.length) { const key = b.split.part === "heading" ? b.split.of : b.id; (groups.get(key) ?? groups.set(key, []).get(key)).push(b); }
  for (const g of groups.values()) {
    const base = g.find((b) => b.split.part === "text");
    const heads = g.filter((b) => b.split.part === "heading");
    const first = base?.parts?.[0];
    if (!base || !heads.length || !first?.bbox) continue;
    const [x0, y0, x1, y1] = first.bbox;
    const lineH = (y1 - y0) / Math.max(1, base.lines ?? 1);
    const total = g.reduce((a, b) => a + b.text.length, 0) || 1;
    let y = y0;
    for (const b of heads) {
      const yb = Math.min(y1 - lineH * 0.5, y + Math.max(lineH, (y1 - y0) * (b.text.length / total)));
      out.set(b.id, [{ ...first, bbox: [x0, y, x1, yb] }]);
      y = yb;
    }
    out.set(base.id, [{ ...first, bbox: [x0, y, x1, y1] }, ...base.parts.slice(1)]);
  }
  return out;
}
/** Matches the question in a Jev call that is about this block (it quotes the block's opening words). */
const mentions = (b) => (k, x) => JSON.stringify(x.instructions ?? "").includes(b.text.slice(0, 40).replace(/["\\]/g, ""));

export class LibraryView {
  constructor(app) {
    this.app = app;
    this.docs = [];
    this.cache = new Map();
    this.cur = null; // { doc, structure }
    this.mode = "roles";
    this.tab = "outline";
    this.sel = null;
    this.focus = null; // { kind: role|modality|family, key }
    this.live = new Map(); // docId -> progress during structuring
    this.overlays = new Map();
    this.filter = "all";
    this.busy = false;
  }

  mount(el, summary) {
    this.el = el;
    this.docs = summary;
    el.replaceChildren(
      h("aside", { class: "side" },
        h("div", { class: "side-label" }, h("span", {}, "Library"), h("span", { id: "libTitle" }),
          h("button", { class: "act", title: "Add a PDF or web page and watch it parse", onclick: () => this.openAdd() }, "Add")),
        h("div", { class: "filters", id: "libFilter" }),
        h("div", { class: "doclist", id: "docList" }),
        h("button", { class: "act side-foot", title: "Re-run Jev's structuring over every document, skipping the cache", onclick: () => this.restructure(null, true) }, "Re-structure all documents live"),
      ),
      h("section", { class: "viewer" },
        h("header", { class: "viewer-head", id: "viewerHead" }),
        h("div", { class: "viewer-body", id: "viewerBody" }, h("div", { class: "empty center" }, "Pick a document.")),
      ),
      h("aside", { class: "panel" },
        h("div", { class: "tabs", id: "libTabs" }),
        h("div", { class: "panel-body", id: "libPanel" }),
      ),
    );
    this.renderList();
    const first = this.docs.find((d) => d.id === "genius-act") ?? this.docs[0];
    if (first) this.open(first.id);
  }

  setSummary(summary) {
    this.docs = summary;
    this.renderList();
  }

  // ───────────── document list ─────────────

  renderList() {
    const docs = this.docs;
    const pages = docs.reduce((a, d) => a + d.pages, 0), blocks = docs.reduce((a, d) => a + d.blocks, 0);
    $("#libTitle").textContent = `${docs.length} · ${fmt(pages)} pages`;
    $("#libTitle").title = `${docs.length} documents · ${fmt(pages)} pages · ${fmt(blocks)} blocks`;
    const formats = ["all", ...new Set(docs.map((d) => d.format))];
    $("#libFilter").replaceChildren(...formats.map((f) => h("button", { class: this.filter === f ? "on" : "", onclick: () => ((this.filter = f), this.renderList()) }, f === "all" ? "All" : FORMAT_LABEL[f], h("span", { class: "tab-n" }, f === "all" ? docs.length : docs.filter((d) => d.format === f).length))));
    const list = docs.filter((d) => this.filter === "all" || d.format === this.filter);
    $("#docList").replaceChildren(...list.map((d) => {
      const live = this.live.get(d.id);
      const total = Object.values(d.roles).reduce((a, n) => a + n, 0);
      const fp = h("div", { class: "fingerprint", ...tipHandlers(() => Object.entries(d.roles).sort((a, b) => b[1] - a[1]).map(([r, n]) => `<i style="background:${ROLE_COLOR[r]}"></i>${ROLE_LABEL[r]} ${n}`).join("<br>")) },
        total ? Object.keys(ROLE_COLOR).filter((r) => d.roles[r]).map((r) => h("span", { style: `flex:${d.roles[r]};background:${ROLE_COLOR[r]}` })) : h("span", { style: "flex:1;background:var(--cell)" }));
      return h("button", { class: `docitem ${this.cur?.doc.id === d.id ? "on" : ""}`, onclick: () => this.open(d.id) },
        h("span", { class: "dt" }, d.short, d.health?.after ? h("i", { class: "hdot", title: `parse health: ${d.health.before} issues → ${d.health.after} open${d.health.verified ? `, ${d.health.verified} checked and confirmed by Jev` : ""}` }) : null),
        h("span", { class: "dm" }, live ? `structuring · ${live.stage ?? ""} ${fmt(live.labeled)}/${fmt(d.blocks)}` : `${d.issuer} · ${d.date?.slice(0, 4) ?? ""}`),
        live ? h("div", { class: "progress" }, h("span", { style: `width:${pct(live.labeled / Math.max(1, d.blocks))}` })) : fp,
      );
    }));
  }

  // ───────────── viewer ─────────────

  async open(id, blockId) {
    if (!this.cache.has(id)) this.cache.set(id, await fetch(`/api/doc/${id}`).then((r) => r.json()));
    const changed = this.cur?.doc.id !== id;
    this.cur = this.cache.get(id);
    this.byId = new Map(this.cur.doc.blocks.map((b) => [b.id, b]));
    if (changed) {
      this.sel = null;
      this.focus = null;
      this.renderList();
      this.renderViewer();
    }
    this.renderPanel();
    if (blockId) setTimeout(() => this.select(blockId, true), 60);
  }

  lab(bid) {
    return this.cur.structure?.blocks?.[bid] ?? null;
  }

  sectionOf(bid) {
    const sid = this.lab(bid)?.section;
    return this.cur.structure?.sections?.find((s) => s.id === sid) ?? null;
  }

  colorOf(bid) {
    const l = this.lab(bid);
    if (!l) return null;
    if (this.mode === "roles") return ROLE_COLOR[l.role];
    if (this.mode === "modality") return l.modality ? MOD_COLOR[l.modality] : null;
    if (this.mode === "sections") {
      if (l.role === "heading") return ROLE_COLOR.heading;
      if (!CONTENT.has(l.role)) return null;
      return FAMILY_COLOR[SECROLE_FAMILY(this.sectionOf(bid)?.role)];
    }
    return null;
  }

  inFocus(bid) {
    if (!this.focus) return true;
    const l = this.lab(bid);
    if (!l) return false;
    if (this.focus.kind === "role") return l.role === this.focus.key;
    if (this.focus.kind === "modality") return l.modality === this.focus.key;
    if (this.focus.kind === "family") return CONTENT.has(l.role) && SECROLE_FAMILY(this.sectionOf(bid)?.role) === this.focus.key;
    if (this.focus.kind === "deadline") return (l.deadline ?? 0) >= 0.5;
    return true;
  }

  renderViewer() {
    const { doc, structure: st } = this.cur;
    const p = st?.profile;
    const modes = [["roles", "Block roles"], ["modality", "Modality"], ["sections", "Section roles"], ...(doc.raw && doc.pages.length ? [["raw", "Raw cuts"]] : []), ["none", "Plain"]];
    if (this.mode === "raw" && !(doc.raw && doc.pages.length)) this.mode = "roles";
    $("#viewerHead").replaceChildren(
      h("div", { class: "vh-meta" },
        h("span", {}, [doc.issuer, doc.date, doc.pages.length ? `${doc.pages.length} pages` : FORMAT_LABEL[doc.format], doc.line_numbered ? "line-numbered bill" : null].filter(Boolean).join(" · ")),
        h("a", { href: doc.url, target: "_blank", rel: "noreferrer" }, "Source ↗")),
      h("h1", { class: "vh-title" }, doc.title),
      h("div", { class: "vh-profile" }, p ? [h("span", { title: `Jev, ${pct(p.doc_type_conf)} sure` }, human(p.doc_type)), h("span", {}, FORCE[p.legal_force_level] ?? "—"), ...Object.entries(p.topics ?? {}).filter(([, v]) => v >= 0.5).map(([k]) => h("span", {}, human(k)))] : h("span", { class: "warnc" }, "not structured yet")),
      h("div", { class: "vh-tools" },
        h("div", { class: "filters" }, modes.map(([k, l]) => h("button", { class: this.mode === k ? "on" : "", onclick: () => { this.mode = k; this.renderViewer(); this.renderPanel(); } }, l))),
        h("div", { class: "row gap6" },
          h("a", { class: "act", href: `/api/doc/${doc.id}/export`, download: `${doc.id}.reglens.json`, title: "The structured document as JSON: typed elements with their outline path, labels, page positions, and the Jev calls behind them" }, "JSON"),
          h("button", { class: "act", title: "Re-run Jev's structuring on this document live, skipping the cache", onclick: () => this.restructure([doc.id], true) }, "Re-structure live")),
      ),
      this.legend(),
    );
    const body = $("#viewerBody");
    this.overlays.clear();
    this.io?.disconnect();
    body.scrollTop = 0;
    if (doc.pages.length) this.renderPdf(body);
    else this.renderHtml(body);
  }

  legend() {
    const items = this.mode === "roles" ? Object.entries(ROLE_LABEL).map(([k, l]) => [ROLE_COLOR[k], l])
      : this.mode === "modality" ? Object.entries(MOD_LABEL).map(([k, l]) => [MOD_COLOR[k], l])
      : this.mode === "sections" ? [[ROLE_COLOR.heading, "heading"], ...Object.entries(FAMILY_LABEL).map(([k, l]) => [FAMILY_COLOR[k], l])]
      : this.mode === "raw" ? [["#9aa3b0", "piece as the extractor cut it"], ["#f2b84b", "pieces Jev stitched into one block"]] : [];
    return h("div", { class: "legend" }, items.map(([c, l]) => h("span", {}, h("i", { style: `background:${c}` }), l)));
  }

  renderPdf(body) {
    const { doc } = this.cur;
    const byPage = new Map();
    const push = (page, item) => (byPage.get(page) ?? byPage.set(page, []).get(page)).push(item);
    if (this.mode === "raw") {
      // The extractor's original cuts; pieces that belong to a stitched block point at it.
      const owner = new Map();
      for (const b of doc.blocks) if (b.parts?.length > 1) b.parts.forEach((pt, k) => owner.set(pt.id, { b, k }));
      for (const r of doc.raw) { const o = owner.get(r.id); push(r.page, { b: o?.b ?? r, part: { page: r.page, bbox: r.bbox }, k: o?.k ?? 0, n: o?.b.parts.length ?? 1, raw: r }); }
    } else {
      const slices = splitSlices(doc.blocks);
      for (const b of doc.blocks) {
        const parts = slices.get(b.id) ?? b.parts ?? [{ page: b.page, bbox: b.bbox }];
        parts.forEach((pt, k) => push(pt.page, { b, part: pt, k, n: parts.length }));
      }
    }
    const wrap = h("div", { class: "pages" });
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) this.fillPage(e.target, byPage.get(+e.target.dataset.page) ?? []);
    }, { root: body, rootMargin: "900px 0px" });
    for (const pg of doc.pages) {
      const el = h("div", { class: "page", "data-page": pg.n, style: `aspect-ratio:${pg.w}/${pg.h}` }, h("span", { class: "pno" }, pg.n));
      el._pg = pg;
      wrap.append(el);
      this.io.observe(el);
    }
    body.replaceChildren(wrap);
  }

  fillPage(el, items) {
    if (el._filled) return;
    el._filled = true;
    const pg = el._pg;
    el.append(h("img", { src: `/pages/${this.cur.doc.id}/${pg.n}.jpg`, loading: "lazy", alt: `page ${pg.n}` }));
    for (const { b, part, k, n, raw } of items) {
      const [x0, y0, x1, y1] = part.bbox;
      const o = h("div", {
        class: `ov ${n > 1 ? "multi" : ""} ${raw ? "rawcut" : ""} ${raw && n > 1 ? "stitched" : ""}`, "data-b": b.id,
        style: `left:${(x0 / pg.w) * 100}%;top:${(y0 / pg.h) * 100}%;width:${((x1 - x0) / pg.w) * 100}%;height:${((y1 - y0) / pg.h) * 100}%`,
        onclick: () => this.select(b.id),
        ...tipHandlers(() => (raw ? `<b>${n > 1 ? `piece ${k + 1} of ${n}, stitched by Jev` : "extracted piece"}</b><br>${esc(clip(raw.text, 160))}` : this.tipFor(b))),
      }, n > 1 && !raw ? h("span", { class: "partno" }, `${k + 1}/${n}`) : null);
      (this.overlays.get(b.id) ?? this.overlays.set(b.id, []).get(b.id)).push(o);
      this.paintOverlay(b.id);
      el.append(o);
    }
  }

  renderHtml(body) {
    const { doc } = this.cur;
    const col = h("div", { class: "reflow" });
    for (const b of doc.blocks) {
      const o = h("div", { class: "hblk", "data-b": b.id, onclick: () => this.select(b.id), ...tipHandlers(() => this.tipFor(b)) }, b.text);
      this.overlays.set(b.id, [o]);
      this.paintOverlay(b.id);
      col.append(o);
    }
    body.replaceChildren(col);
  }

  paintOverlay(bid) {
    const els = this.overlays.get(bid);
    if (!els) return;
    const l = this.lab(bid);
    const raw = this.mode === "raw";
    const c = raw ? null : this.colorOf(bid);
    const on = this.inFocus(bid);
    for (const o of els) {
      o.classList.toggle("pending", !l && !raw);
      o.classList.toggle("dim", !on && !raw);
      o.classList.toggle("sel", this.sel === bid);
      if (!raw) o.style.setProperty("--c", c ?? "transparent");
      if (o.classList.contains("hblk")) {
        o.dataset.role = l?.role ?? "";
        o.style.fontSize = l?.role === "heading" ? `${levelSize(l.level)}px` : "";
      }
    }
  }

  repaint() {
    for (const bid of this.overlays.keys()) this.paintOverlay(bid);
  }

  tipFor(b) {
    const l = this.lab(b.id);
    if (!l) return `<span class=m>not labeled yet</span><br>${esc(clip(b.text, 160))}`;
    const s = this.sectionOf(b.id);
    const sx = (b.split ? `<br><span class=m>${b.split.part === "heading" ? "run-in heading split off its text" : "text after a run-in heading"}</span>` : "") + (b.parts?.length > 1 && !b.split ? `<br><span class=m>stitched by Jev from ${b.parts.length} pieces${new Set(b.parts.map((p) => p.page)).size > 1 ? " across a page break" : ""}</span>` : "");
    return `<b>${ROLE_LABEL[l.role]}</b> ${pct(l.roleConf)}${l.role === "heading" ? ` · level ${l.level}` : ""}${l.modality ? ` · <b>${MOD_LABEL[l.modality]}</b>` : ""}${(l.deadline ?? 0) >= 0.5 ? " · deadline" : ""}<br>${esc(clip(b.text, 180))}${s ? `<br><span class=m>§ ${esc(clip(s.title, 70))}</span>` : ""}${sx}<br><span class=m>click to inspect</span>`;
  }

  select(bid, scroll = false) {
    const prev = this.sel;
    this.sel = bid;
    if (prev) this.paintOverlay(prev);
    let o = this.overlays.get(bid)?.[0];
    if (!o && this.cur.doc.pages.length) {
      // Page not rendered yet: fill it, then scroll to it.
      const b = this.byId.get(bid);
      const page = $(`.page[data-page="${b.page}"]`);
      if (page) {
        const items = [];
        const slices = splitSlices(this.cur.doc.blocks);
        for (const x of this.cur.doc.blocks) (slices.get(x.id) ?? x.parts ?? [{ page: x.page, bbox: x.bbox }]).forEach((pt, k, all) => pt.page === b.page && items.push({ b: x, part: pt, k, n: all.length }));
        this.fillPage(page, items);
        o = this.overlays.get(bid)?.[0];
      }
    }
    this.paintOverlay(bid);
    if (scroll && o) o.scrollIntoView({ block: "center", behavior: "smooth" });
    this.tab = "block";
    this.renderPanel();
  }

  // ───────────── side panel ─────────────

  renderPanel() {
    const tabs = [["outline", "Outline"], ["extracted", "Extracted"], ["pipeline", "Pipeline"], ["health", "Health"], ["block", "Block"]];
    $("#libTabs").replaceChildren(...tabs.map(([k, l]) => h("button", { class: this.tab === k ? "on" : "", onclick: () => { this.tab = k; this.renderPanel(); } }, l)));
    const body = $("#libPanel");
    const st = this.cur?.structure;
    if (!st && this.tab !== "block") return body.replaceChildren(h("div", { class: "empty" }, "Not structured yet. Use ↻ Re-structure live."));
    body.replaceChildren(...kids(this[`panel_${this.tab}`]()));
  }

  panel_outline() {
    const st = this.cur.structure;
    const secs = st.sections ?? [];
    return [
      h("div", { class: "muted small pad" }, `${secs.length} sections, built in code from the headings Jev found and the levels it assigned.`),
      h("div", { class: "outline" }, secs.map((s) => h("button", {
        class: "osec", style: `padding-left:${8 + Math.min(9, Math.max(0, s.level)) * 11}px`, title: `level ${s.level}`,
        onclick: () => this.select(s.heading ?? s.blocks?.[0], true),
      }, h("i", { style: `background:${s.role ? FAMILY_COLOR[SECROLE_FAMILY(s.role)] : "var(--cell)"}`, title: s.role ?? "" }), h("span", { class: "ot" }, s.title), h("span", { class: "on" }, s.n ?? s.blocks?.length ?? 0)))),
    ];
  }

  focusable(kind, key, label, n, total, color) {
    const on = this.focus?.kind === kind && this.focus?.key === key;
    return h("button", { class: `fbar ${on ? "on" : ""}`, onclick: () => { this.focus = on ? null : { kind, key }; this.repaint(); this.renderPanel(); } },
      h("span", { class: "fl" }, h("i", { style: `background:${color}` }), label),
      h("span", { class: "ft" }, h("span", { style: `width:${pct(n / Math.max(1, total))};background:${color}` })),
      h("span", { class: "fn" }, fmt(n)));
  }

  panel_extracted() {
    const { doc, structure: st } = this.cur;
    const labs = Object.values(st.blocks);
    const roles = {}, mods = {}, fams = {};
    for (const [bid, l] of Object.entries(st.blocks)) {
      roles[l.role] = (roles[l.role] ?? 0) + 1;
      if (l.modality) mods[l.modality] = (mods[l.modality] ?? 0) + 1;
      if (CONTENT.has(l.role)) { const f = SECROLE_FAMILY(this.sectionOf(bid)?.role); fams[f] = (fams[f] ?? 0) + 1; }
    }
    const content = labs.filter((l) => CONTENT.has(l.role)).length;
    const defs = doc.blocks.filter((b) => st.blocks[b.id]?.modality === "defines");
    const dls = doc.blocks.filter((b) => (st.blocks[b.id]?.deadline ?? 0) >= 0.5);
    const p = st.profile;
    const jump = (b) => h("button", { class: "sample", onclick: () => this.select(b.id, true) }, h("b", {}, b.page ? `p.${b.page}` : "¶"), clip(b.text, 150));
    return [
      h("h4", {}, "Document profile (S1)"),
      p ? h("div", { class: "kv" },
        h("div", {}, h("span", {}, "Type"), h("b", {}, `${human(p.doc_type)} · ${pct(p.doc_type_conf)}`)),
        h("div", {}, h("span", {}, "Legal force"), h("b", {}, FORCE[p.legal_force_level])),
        h("div", {}, h("span", {}, "Jurisdiction"), h("b", {}, human(p.jurisdiction)))) : null,
      p ? h("div", { class: "topics" }, Object.entries(p.topics).sort((a, b) => b[1] - a[1]).map(([k, v]) => h("div", { class: "tp" }, h("span", {}, human(k)), h("span", { class: "tb" }, h("span", { style: `width:${pct(v)};background:${v >= 0.5 ? SERIES[0] : "var(--line-2)"}` })), h("span", { class: "mono tiny" }, pct(v))))) : null,
      h("h4", {}, `Block roles (S2) · click to focus`),
      Object.keys(ROLE_LABEL).filter((r) => roles[r]).map((r) => this.focusable("role", r, ROLE_LABEL[r], roles[r], labs.length, ROLE_COLOR[r])),
      h("h4", {}, `Modality of ${fmt(content)} content blocks (S4)`),
      Object.keys(MOD_LABEL).filter((m) => mods[m]).map((m) => this.focusable("modality", m, MOD_LABEL[m], mods[m], content, MOD_COLOR[m])),
      this.focusable("deadline", "yes", "sets a deadline", dls.length, content, "#f2b84b"),
      h("h4", {}, "Content by section role (S5)"),
      Object.keys(FAMILY_LABEL).filter((f) => fams[f]).map((f) => this.focusable("family", f, FAMILY_LABEL[f], fams[f], content, FAMILY_COLOR[f])),
      h("h4", {}, `Definitions (${defs.length})`),
      h("div", { class: "samples" }, defs.slice(0, 40).map(jump)),
      h("h4", {}, `Deadlines and frequencies (${dls.length})`),
      h("div", { class: "samples" }, dls.slice(0, 40).map(jump)),
    ];
  }

  panel_pipeline() {
    const { doc, structure: st } = this.cur;
    const live = this.live.get(doc.id);
    const labs = Object.values(st.blocks);
    const roles = {};
    for (const l of labs) roles[l.role] = (roles[l.role] ?? 0) + 1;
    const heads = roles.heading ?? 0, content = [...CONTENT].reduce((a, r) => a + (roles[r] ?? 0), 0), other = labs.length - heads - content;
    const withText = (st.sections ?? []).filter((s) => s.role).length;
    const stage = (id, title, engine, detail, n, of, color) => h("div", { class: "pstage" },
      h("div", { class: "row between" }, h("b", {}, `${id} · ${title}`), h("span", { class: `eng ${engine}` }, engine)),
      h("div", { class: "muted small" }, detail),
      of != null ? h("div", { class: "pbar" }, h("span", { style: `width:${pct(n / Math.max(1, of))};background:${color ?? SERIES[0]}` })) : null,
      of != null ? h("div", { class: "mono tiny muted" }, `${fmt(n)} / ${fmt(of)}`) : null);
    const branch = (label, n, color, note) => h("div", { class: "pbranch" }, h("i", { style: `background:${color}` }), h("span", {}, label), h("b", {}, fmt(n)), h("span", { class: "muted tiny" }, note));
    return [
      h("p", { class: "muted small pad" }, "How this document was parsed. Code segments the file into blocks with exact positions; Jev decides what each block is, and later questions run only where earlier answers allow."),
      stage("E", "Extract", "code", `${doc.format === "pdf" ? `PyMuPDF lines → blocks by gaps, indents, enumerators, font changes${doc.line_numbered ? "; margin line numbers stripped" : ""}` : "HTML elements → blocks, with tag hints"} · ${fmt(doc.blocks.length)} blocks`),
      doc.raw && doc.format === "pdf" ? stage("S0", "Stitch", "jev", `with the whole page in view: is one of the next three pieces this piece's cut-off remainder? ${fmt(doc.raw.length)} pieces → ${fmt(st.stitched?.links?.length ?? 0)} joins → ${fmt(doc.blocks.length)} blocks`, live?.s0 ?? doc.raw.length, doc.raw.length, "#f2b84b") : null,
      doc.raw && doc.format === "pdf" ? h("div", { class: "samples", style: "margin:-2px 0 6px 14px" }, doc.blocks.filter((b) => b.parts?.length > 1).slice(0, 5).map((b) => h("button", { class: "sample", onclick: () => this.select(b.id, true) }, h("b", {}, `${b.parts.length} pieces`), clip(b.text, 110)))) : null,
      stage("S1", "Profile", "jev", st.profile ? `${human(st.profile.doc_type)} · ${FORCE[st.profile.legal_force_level]} · ${Object.values(st.profile.topics).filter((v) => v >= 0.5).length} topics` : "waiting", st.profile ? 1 : 0, 1),
      stage("S2", "Block roles", "jev", "every block, with its whole page in view: what is it?", live?.s2 ?? labs.length, doc.blocks.length),
      h("div", { class: "branches" },
        branch("heading → S3 level", heads, ROLE_COLOR.heading, "judged against every heading in the document"),
        branch("content → S4 modality + deadline", content, ROLE_COLOR.body, "body, list items, definitions, questions, quotes"),
        branch("everything else → stops here", other, "#4a515c", "footnotes, furniture, TOC, tables, front matter")),
      st.audit ? stage("A", "Audit & repair", "jev", `${st.audit.checks.length} checks · ${fmt(st.audit.fixes.filter((f) => !f.verified).length)} fixes${st.audit.loop?.length ? ` · issue loop ${Math.max(...st.audit.loop.map((x) => x.round))} round(s)` : ""} · parse health ${fmt(st.health.before.total)} → ${fmt(st.health.after.total)} open (see Health)`) : null,
      stage("O", "Outline", "code", `headings + levels → ${fmt(st.sections?.length ?? 0)} sections; each content block attached to its section`),
      stage("S5", "Section role + topics", "jev", "sections with substantive text", live?.s5 ?? withText, live?.s5total ?? withText, FAMILY_COLOR.rule),
      st.metrics ? h("div", { class: "muted small pad" }, `Last build: ${fmt(st.metrics.calls)} Jev calls in ${(st.metrics.wallMs / 1000).toFixed(1)} s · ${new Date(st.builtAt).toLocaleString()}`) : null,
    ];
  }

  panel_health() {
    const { structure: st } = this.cur;
    const hh = st.health, au = st.audit;
    if (!hh) return h("div", { class: "empty" }, "No audit yet. Re-structure this document to run it.");
    const open = hh.issues.filter((x) => !x.verified), verified = hh.issues.filter((x) => x.verified);
    const types = Object.keys(ISSUE_LABEL).filter((k) => hh.before[k] != null || hh.after[k] != null);
    const max = Math.max(1, ...types.map((k) => hh.before[k] ?? 0));
    const byId = this.byId;
    const jump = (bid, text, extra) => h("button", { class: "sample", onclick: () => this.select(bid, true) }, h("b", {}, byId.get(bid)?.page ? `p.${byId.get(bid).page}` : "¶"), text ?? clip(byId.get(bid)?.text ?? bid, 120), extra ?? null);
    const loop = au?.loop ?? [];
    return [
      h("div", { class: "health-head" }, h("div", { class: "eyebrow" }, "Parse health"),
        h("div", { class: "hh-n" }, h("span", { class: "muted" }, fmt(hh.before.total)), " → ", h("b", {}, fmt(hh.after.total)), h("span", { class: "muted small" }, " open issues, before → after Jev's audit")),
        hh.after.verified ? h("div", { class: "muted small" }, `${fmt(hh.after.verified)} more were flagged by the detectors, checked by Jev, and confirmed correct as they are (listed below with the reason)`) : null),
      h("div", { class: "hbars" }, types.map((k) => [k, ISSUE_LABEL[k]]).map(([k, l]) => h("div", { class: "hrow2" },
        h("span", { class: "hl2" }, l),
        h("span", { class: "hb2" }, h("i", { class: "b4", style: `width:${pct((hh.before[k] ?? 0) / max)}` }), h("i", { class: "af", style: `width:${pct((hh.after[k] ?? 0) / max)}` })),
        h("span", { class: "mono tiny" }, `${hh.before[k] ?? 0} → ${hh.after[k] ?? 0}`)))),
      h("h4", {}, "Audit checks (Jev decides; code applies)"),
      h("div", { class: "checks" }, (au?.checks ?? []).map((c) => h("div", { class: "chk", title: c.detail },
        h("span", { class: "mono tiny" }, c.id), h("span", { class: "small" }, c.label),
        h("span", { class: "mono tiny muted" }, `${fmt(c.examined)} → ${fmt(c.flagged)} → `, h("b", {}, fmt(c.fixed)), c.verified ? ` · ✓${fmt(c.verified)}` : "", c.rolledBack ? ` · ↩${fmt(c.rolledBack)}` : "")))),
      h("div", { class: "muted tiny pad" }, "examined → flagged → fixed · ✓ confirmed correct as is · ↩ undone because health got worse. Hover a check for what it asks."),
      loop.length ? [h("h4", {}, "Issue loop: measure → route → fix → re-measure"),
        h("div", { class: "loop" }, loop.map((x) => h("div", { class: `lrow ${x.rolledBack ? "rb" : ""}` },
          h("span", { class: "mono tiny muted" }, `round ${x.round}`), h("span", { class: "small" }, x.check),
          h("span", { class: "mono tiny" }, `${fmt(x.before)} → ${fmt(x.after)}`, x.rolledBack ? " ↩ rolled back" : ""))))] : null,
      h("h4", {}, `Still open (${open.length})`),
      open.length ? h("div", { class: "samples" }, open.slice(0, 150).map((x) => jump(x.block, `${ISSUE_LABEL[x.type] ?? x.type}${x.detail ? ` · ${x.detail}` : ""} · ${clip(byId.get(x.block)?.text ?? "", 80)}`))) : h("div", { class: "muted small pad" }, "Nothing open."),
      verified.length ? [h("h4", {}, `Checked and confirmed by Jev (${verified.length})`),
        h("div", { class: "samples" }, verified.slice(0, 150).map((x) => jump(x.block, `${ISSUE_LABEL[x.type] ?? x.type} · ${x.verified.check}: ${x.verified.note} · ${clip(byId.get(x.block)?.text ?? "", 70)}`,
          x.verified.call ? h("a", { class: "tiny", onclick: (e) => { e.stopPropagation(); showCall(x.verified.call, mentions(byId.get(x.block) ?? { text: "" })); } }, " call ↗") : null)))] : null,
      h("h4", {}, `Fixes applied (${au?.fixes.filter((f) => !f.verified).length ?? 0})`),
      h("div", { class: "samples" }, (au?.fixes ?? []).filter((f) => !f.verified).slice(0, 200).map((f) => jump(f.block, `${f.check} · ${f.detail}`))),
    ];
  }

  panel_block() {
    if (!this.sel || !this.cur) return h("div", { class: "empty" }, "Click any block on the page to see what Jev decided about it and why.");
    const b = this.byId.get(this.sel);
    const l = this.lab(b.id) ?? {};
    const s = this.sectionOf(b.id);
    const holder = h("div", {});
    const rows = [
      ["Page", b.page ?? "—"], ["Position", b.bbox ? `${b.zone} · x ${Math.round(b.bbox[0])}–${Math.round(b.bbox[2])}, y ${Math.round(b.bbox[1])}–${Math.round(b.bbox[3])}` : "—"],
      ["Font", b.rel_size ? `${b.rel_size}× body size${b.bold > 0.5 ? ", bold" : ""}` : "—"], ["HTML tag", b.tag ?? "—"], ["Repeats on pages", b.repeats ? "yes" : "no"],
    ];
    const out = [
      h("div", { class: "row between" }, h("div", { class: "eyebrow" }, `Block ${b.id}`), h("button", { class: "btn small ghost", onclick: () => this.select(b.id, true) }, "locate")),
      h("div", { class: "quote" }, b.text),
      h("h4", {}, "What Jev decided"),
      h("div", { class: "labels" },
        l.role ? h("div", { class: "lab" }, h("span", {}, "Role"), h("span", { class: "chip", style: `border-color:${ROLE_COLOR[l.role]}` }, h("i", { style: `background:${ROLE_COLOR[l.role]}` }), ROLE_LABEL[l.role]), h("span", { class: "mono tiny" }, pct(l.roleConf)), l.calls?.role ? h("a", { onclick: () => showCall(l.calls.role, (k, x) => x.instructions?.target === b.text.slice(0, 1500)) }, "call ↗") : null) : h("div", { class: "muted" }, "not labeled"),
        l.role === "heading" ? h("div", { class: "lab" }, h("span", {}, "Level"), h("b", {}, `${l.level} · ${LEVEL_NAME[l.level] ?? `depth ${l.level}`}`), l.levelWas != null && l.levelWas !== l.level ? h("span", { class: "mono tiny muted" }, `was ${l.levelWas}`) : null, l.calls?.nesting ? h("a", { onclick: () => showCall(l.calls.nesting, mentions(b)) }, "nesting call ↗") : l.calls?.level ? h("a", { onclick: () => showCall(l.calls.level, (k, x) => x.instructions?.target === b.text.slice(0, 1500)) }, "call ↗") : null) : null,
        l.modality ? h("div", { class: "lab" }, h("span", {}, "Modality (S4)"), h("span", { class: "chip", style: `border-color:${MOD_COLOR[l.modality]}` }, h("i", { style: `background:${MOD_COLOR[l.modality]}` }), MOD_LABEL[l.modality]), h("span", { class: "mono tiny" }, pct(l.modConf)), l.calls?.mod ? h("a", { onclick: () => showCall(l.calls.mod, (k, x) => x.instructions?.target === b.text.slice(0, 1500)) }, "call ↗") : null) : null,
        l.deadline != null ? h("div", { class: "lab" }, h("span", {}, "Deadline (S4)"), h("b", {}, `${pct(l.deadline)} yes`)) : null,
        s ? h("div", { class: "lab" }, h("span", {}, "Section"), h("span", { class: "small" }, [...(s.path ?? []), s.title].map((t) => clip(t, 40)).join(" › ")), s.role ? h("span", { class: "chip" }, human(s.role)) : null) : null,
      ),
      holder,
      this.auditTrail(b, l),
      b.stitched && !b.split ? [h("h4", {}, `Stitched by Jev (S0) from ${b.parts.length} extracted pieces`),
        h("div", { class: "samples" }, b.parts.map((pt, k) => {
          const r = this.cur.doc.raw?.find((x) => x.id === pt.id);
          const l = b.stitched.links[k - 1];
          return h("div", { class: "sample" }, h("b", {}, `${pt.id} · p.${pt.page}`), k ? h("span", { class: "chip tiny" }, `joined ${pct(l?.p)}`, l?.call ? h("a", { onclick: (e) => { e.stopPropagation(); showCall(l.call, (key, x) => x.instructions?.block?.text && r && (this.cur.doc.raw.find((y) => y.id === l.from)?.text ?? "").endsWith(x.instructions.block.text.replace(/^…/, ""))); } }, " call ↗") : null) : h("span", { class: "chip tiny" }, "first piece"), " ", clip(r?.text ?? "", 140));
        }))] : null,
      h("h4", {}, "Provenance (from extraction, no model)"),
      h("div", { class: "kv" }, rows.map(([k, v]) => h("div", {}, h("span", {}, k), h("b", {}, String(v))))),
    ];
    if (l.calls?.role) this.loadDist(l.calls.role, b, holder);
    return out;
  }

  /** Everything the audit did to this block, with the call behind each decision. */
  auditTrail(b, l) {
    const items = [];
    const link = (call, label = "call ↗") => (call ? h("a", { onclick: () => showCall(call, mentions(b)) }, label) : null);
    if (b.split) items.push(h("div", { class: "lab" }, h("span", {}, "Split"), h("span", { class: "small" }, b.split.part === "heading" ? `run-in heading split off the paragraph it labels (${b.split.of})` : "the text that follows a run-in heading"), link(l.calls?.runin ?? l.calls?.split)));
    if (b.duplicates?.length) items.push(h("div", { class: "lab" }, h("span", {}, "Folded in"), h("span", { class: "small" }, `${b.duplicates.length} other rendering${b.duplicates.length > 1 ? "s" : ""} of this title: ${b.duplicates.map((d) => `“${clip(d.text, 40)}”`).join(", ")}`)));
    if (l.runoff) items.push(h("div", { class: "lab" }, h("span", {}, "Runoff"), h("span", { class: "small" }, `${l.runoff.options.map((o) => ROLE_LABEL[o] ?? o).join(" vs ")}: was ${ROLE_LABEL[l.runoff.was] ?? l.runoff.was} ${pct(l.runoff.wasConf)} → ${ROLE_LABEL[l.role]} ${pct(l.roleConf)}`), link(l.runoff.call)));
    else if (l.roleWas && l.roleWas !== l.role) items.push(h("div", { class: "lab" }, h("span", {}, "Role changed"), h("span", { class: "small" }, `${ROLE_LABEL[l.roleWas] ?? l.roleWas} → ${ROLE_LABEL[l.role]}`), link(l.calls?.empty ?? l.calls?.repeat ?? l.calls?.role)));
    for (const [type, v] of Object.entries(l.verified ?? {})) items.push(h("div", { class: "lab" }, h("span", {}, "Confirmed"), h("span", { class: "small" }, `${ISSUE_LABEL[type] ?? type}: ${v.check} says ${v.note}`), link(v.call)));
    for (const [k, label] of Object.entries(CHECK_CALL)) if (l.calls?.[k] && !["runin", "split", "nesting"].includes(k) && !(l.roleWas && ["empty", "repeat"].includes(k))) items.push(h("div", { class: "lab" }, h("span", {}, "Audit"), h("span", { class: "small" }, label), link(l.calls[k])));
    return items.length ? [h("h4", {}, "Audit trail"), h("div", { class: "labels" }, items)] : null;
  }

  async loadDist(callId, b, holder) {
    const rec = await fetch(`/api/lineage/${callId}`).then((r) => (r.ok ? r.json() : null));
    if (!rec || this.sel !== b.id) return;
    const key = Object.keys(rec.questions).find((k) => rec.questions[k].instructions?.target === b.text.slice(0, 1500));
    const a = key && rec.answers[key];
    if (!a?.probabilities) return;
    const items = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 5);
    const top = items[0]?.[0];
    const note = top && top !== a.choice ? h("div", { class: "warnc tiny" }, `Close call: Jev picked “${ROLE_LABEL[a.choice] ?? a.choice}” (confidence ${pct(a.confidence)}) though “${ROLE_LABEL[top] ?? top}” has the highest probability.`) : a.confidence < 0.4 ? h("div", { class: "warnc tiny" }, `Low confidence (${pct(a.confidence)}): a borderline block.`) : null;
    holder.replaceChildren(...kids(note), h("div", { class: "probs" }, h("div", { class: "muted tiny" }, "role probabilities"), items.map(([k, p], i) => h("div", { class: i ? "" : "top" }, h("span", {}, ROLE_LABEL[k] ?? k), h("span", { class: "bar" }, h("span", { style: `width:${pct(p)};background:${ROLE_COLOR[k]}` })), h("span", { class: "p" }, pct(p))))));
  }

  // ───────────── live structuring ─────────────

  async restructure(ids, fresh) {
    if (this.busy) return;
    const targets = ids ?? this.docs.map((d) => d.id);
    if (!ids && !confirm(`Re-run Jev's structuring over all ${targets.length} documents, live (about 38K predicates, ~90 s, ~$0.40)?`)) return;
    this.busy = true;
    for (const id of targets) {
      const d = this.docs.find((x) => x.id === id);
      this.live.set(id, { labeled: 0, s2: 0, s5: 0, s5total: 0 });
      const c = this.cache.get(id);
      if (c) {
        c.structure = { profile: null, blocks: {}, sections: [], metrics: null };
        if (c.doc.raw) c.doc.blocks = c.doc.raw; // S0 starts again from the extractor's cuts
      }
      if (d) d.roles = {};
    }
    if (this.cur && targets.includes(this.cur.doc.id)) { this.repaint(); this.renderViewer(); }
    this.renderList();
    this.renderPanel();
    let raf = 0;
    const tick = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; this.repaint(); this.renderList(); if (this.tab !== "block") this.renderPanel(); }); };
    try {
      await streamPost("/api/library/structure", { ids: targets, fresh }, (ev) => this.onEvent(ev, tick));
    } catch (err) {
      toast(err.message);
    } finally {
      this.busy = false;
    }
  }

  onEvent(ev, tick) {
    if (ev.t === "metrics") return this.app.setMetrics?.(ev.m);
    if (ev.t === "lib_all_done") {
      this.live.clear();
      this.docs = ev.library;
      for (const id of [...this.cache.keys()]) this.cache.delete(id);
      if (this.cur) this.open(this.cur.doc.id).then(() => this.renderViewer());
      this.renderList();
      this.app.onLibraryChanged?.(ev.library);
      return;
    }
    if (ev.t === "fatal") return toast(ev.error);
    const id = ev.doc;
    if (!id) return;
    const c = this.cache.get(id);
    const st = c?.structure;
    const live = this.live.get(id);
    const d = this.docs.find((x) => x.id === id);
    if (ev.t === "lib_stitch" && live) { live.s0 = (live.s0 ?? 0) + ev.n; live.stage = "S0 stitch"; live.labeled = live.s0; }
    if (ev.t === "lib_stitched" && c) {
      c.doc.raw = c.doc.raw ?? c.doc.blocks;
      c.doc.blocks = ev.blocks.map((b) => ({ ...c.doc.raw.find((r) => r.id === b.id), ...b }));
      if (d) d.blocks = ev.blocks.length;
      if (live) { live.labeled = 0; live.stage = "S2 roles"; }
      if (this.cur === c) { this.byId = new Map(c.doc.blocks.map((b) => [b.id, b])); this.renderViewer(); }
    }
    if (ev.t === "lib_profile") { if (st) st.profile = ev.profile; if (d) d.profile = ev.profile; }
    if (ev.t === "lib_blocks") {
      for (const it of ev.items) {
        if (ev.stage === "S2") {
          live && live.labeled++, live && live.s2++;
          if (d) d.roles[it.role] = (d.roles[it.role] ?? 0) + 1;
          if (st) st.blocks[it.b] = { ...(st.blocks[it.b] ?? {}), role: it.role, roleConf: it.conf };
        } else if (st?.blocks[it.b]) Object.assign(st.blocks[it.b], ev.stage === "S3" ? { level: it.level } : { modality: it.modality, deadline: it.deadline });
      }
    }
    if (ev.t === "lib_outline" && st) st.sections = ev.sections.map((s) => ({ ...s, blocks: [] }));
    if (ev.t === "lib_stage" && ev.stage === "S5" && live) live.s5total = ev.total ?? 0;
    if (ev.t === "lib_section") {
      if (live) live.s5++;
      const s = st?.sections.find((x) => x.id === ev.section.id);
      if (s) Object.assign(s, ev.section);
    }
    tick();
  }

  // ───────────── add a document ─────────────

  /** Adding happens in Build, where the parse can be watched. */
  openAdd() {
    this.app.setMode("build");
  }
}

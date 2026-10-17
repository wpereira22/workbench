// Data: every piece Jev parsed, across the whole library, in one place. Lenses pick a kind of piece
// (definitions, obligations, deadlines…), facets narrow it, every row traces back to its page, and the
// current selection exports as CSV/JSON or becomes the scope of a new query.
import { $, h, kids, fmt, pct, human, clip, toast, short, ROLE_COLOR, MOD_COLOR, MOD_LABEL, ENGINE } from "./ui.js";

const KIND_LABEL = { paragraph: "paragraph", list_item: "list item", definition: "definition", question: "question", quote: "quote", field: "field", heading: "heading", footnote: "footnote", table_or_figure: "table / figure", toc_entry: "contents entry", front_matter: "front matter" };
const KIND_COLOR = { paragraph: ROLE_COLOR.body, list_item: ROLE_COLOR.list_item, definition: ROLE_COLOR.definition_entry, question: ROLE_COLOR.question, quote: ROLE_COLOR.quote, field: ROLE_COLOR.field, heading: ROLE_COLOR.heading, footnote: ROLE_COLOR.footnote, table_or_figure: ROLE_COLOR.table_or_figure, toc_entry: ROLE_COLOR.toc_entry, front_matter: ROLE_COLOR.front_matter };
const KIND_ROLE = { paragraph: "body", list_item: "list_item", definition: "definition_entry", question: "question", quote: "quote", field: "field" };
const FACET_LABEL = { doc: "Document", kind: "Kind", modality: "Modality", section_role: "Section role", topics: "Topic", doc_type: "Document type", year: "Year" };
const LENS_HINT = {
  all: "Every parsed piece except page furniture.",
  definitions: "Defined terms and what they mean, with sub-items attached to their term.",
  obligations: "Text that requires or forbids something (must / must not), with the sentence that introduces each item.",
  permissions: "Text that permits something or creates an exception or safe harbor.",
  deadlines: "Text that sets a deadline, time limit, or required frequency.",
  questions: "Questions the documents pose: requests for comment, FAQs, Q&As.",
  fields: "Labeled values such as “Frequency: Annual” or “Authority: 12 U.S.C. 5901”.",
  tables: "Rows rebuilt from tables, cell by cell.",
  headings: "Every heading in every outline.",
};

export class DataView {
  constructor(app) {
    this.app = app;
    this.lens = "obligations";
    this.filters = { doc: [], kind: [], modality: [], section_role: [], topics: [], doc_type: [], year: [] };
    this.q = "";
    this.res = null;
    this.rows = [];
    this.sel = null;
  }

  mount(el) {
    this.el = el;
    el.replaceChildren(
      h("aside", { class: "side facets", id: "dFacets" }),
      h("section", { class: "dwork" },
        h("div", { class: "lenses", id: "dLenses" }),
        h("div", { class: "dbar" },
          h("input", { class: "dsearch", id: "dSearch", placeholder: "Search the text", oninput: (e) => { clearTimeout(this.tq); this.tq = setTimeout(() => { this.q = e.target.value; this.load(); }, 220); } }),
          h("span", { class: "dhint", id: "dHint" }),
          h("div", { class: "row gap6" },
            h("a", { class: "act", id: "dCsv", title: "Every row of this selection" }, "CSV"),
            h("a", { class: "act", id: "dJson" }, "JSON"),
            h("button", { class: "btn small primary", onclick: () => this.toQuery(), title: "Structure these rows further: describe the columns you want" }, "Query these"))),
        h("div", { class: "dtable-wrap", id: "dTable" }),
        h("aside", { class: "drawer", id: "dDrawer" },
          h("button", { class: "icon-btn drawer-x", title: "Close (Esc)", onclick: () => this.closeDetail() }, "✕"),
          h("div", { class: "panel-body", id: "dDetail" })),
      ),
    );
    this.load();
  }

  invalidate() { this.res = null; if (this.el && !this.el.hidden) this.load(); }

  /** Called from elsewhere ("Its data ▦"): replace the filters and show. */
  show(filters = {}, lens) {
    for (const k of Object.keys(this.filters)) this.filters[k] = filters[k] ?? [];
    if (lens) this.lens = lens;
    this.load();
  }

  params(extra = {}) {
    const p = new URLSearchParams({ lens: this.lens, q: this.q, ...extra });
    for (const [k, vs] of Object.entries(this.filters)) for (const v of vs) p.append(k, v);
    return p;
  }

  async load(more = false) {
    const p = this.params({ offset: more ? this.rows.length : 0, limit: 200 });
    const res = await fetch(`/api/data?${p}`).then((r) => r.json());
    this.res = res;
    this.rows = more ? this.rows.concat(res.rows) : res.rows;
    $("#dCsv").href = `/api/data?${this.params({ format: "csv" })}`;
    $("#dJson").href = `/api/data?${this.params({ format: "json" })}`;
    this.render();
  }

  toggle(f, v) {
    const a = this.filters[f];
    const i = a.indexOf(v);
    if (i >= 0) a.splice(i, 1); else a.push(v);
    this.load();
  }

  render() {
    const R = this.res;
    $("#dLenses").replaceChildren(...Object.entries(R.lenses).map(([k, l]) => h("button", { class: `lens ${this.lens === k ? "on" : ""}`, onclick: () => { this.lens = k; this.load(); } }, h("span", {}, l.label), h("b", {}, fmt(l.n)))));
    $("#dHint").textContent = `${fmt(R.total)} rows · ${LENS_HINT[this.lens] ?? ""}`;
    const active = Object.entries(this.filters).flatMap(([f, vs]) => vs.map((v) => [f, v]));
    $("#dFacets").replaceChildren(...kids(
      h("div", { class: "side-label" }, h("span", {}, "Filter"), h("span", {}, `${fmt(R.total)} of ${fmt(R.lenses[this.lens]?.n)}`)),
      active.length ? h("div", { class: "active-f" }, active.map(([f, v]) => h("button", { class: "chip on", onclick: () => this.toggle(f, v) }, `${f === "doc" ? short(v) : human(v)} ✕`)), h("button", { class: "linkish tiny", onclick: () => { for (const k of Object.keys(this.filters)) this.filters[k] = []; this.load(); } }, "clear all")) : null,
      h("div", { class: "fscroll" }, Object.keys(FACET_LABEL).filter((f) => R.facets[f]?.length).map((f) => this.facet(f, R.facets[f]))),
    ));
    this.renderTable();
  }

  facet(f, entries) {
    const max = Math.max(1, ...entries.map(([, n]) => n));
    const open = this.open?.[f] ?? (f === "doc" || f === "kind" || f === "modality");
    const shown = entries.slice(0, this.more?.[f] ? 60 : 8);
    return h("div", { class: "facet" },
      h("button", { class: `facet-h ${open ? "open" : ""}`, onclick: () => { (this.open ??= {})[f] = !open; this.render(); } }, h("span", {}, FACET_LABEL[f]), h("span", { class: "chev" }, "›")),
      open ? [shown.map(([v, n]) => {
        const on = this.filters[f].includes(v);
        const color = f === "kind" ? KIND_COLOR[v] : f === "modality" ? MOD_COLOR[v] : "#6d8bff";
        return h("button", { class: `fv ${on ? "on" : ""}`, onclick: () => this.toggle(f, v) },
          h("span", { class: "fv-l" }, f === "doc" ? short(v) : f === "kind" ? KIND_LABEL[v] ?? human(v) : f === "modality" ? MOD_LABEL[v] ?? v : human(v)),
          h("span", { class: "fv-b" }, h("span", { style: `width:${pct(n / max)};background:${color}` })),
          h("span", { class: "fv-n" }, fmt(n)));
      }), entries.length > 8 ? h("button", { class: "linkish tiny", onclick: () => { (this.more ??= {})[f] = !this.more[f]; this.render(); } }, this.more?.[f] ? "fewer" : `all ${entries.length}`) : null] : null);
  }

  columns() {
    const where = { h: "Where", c: (r) => h("span", { class: "dwhere" }, h("b", {}, short(r.doc)), r.page ? ` p.${r.page}` : "", r.path ? h("span", { class: "muted" }, ` · ${clip(r.path, 70)}`) : null) };
    const text = { h: "Text", c: (r) => h("div", { class: "dtext" }, r.lead_in && r.kind === "list_item" ? h("span", { class: "leadin" }, `${clip(r.lead_in, 90)} `) : null, r.text) };
    const kind = { h: "Kind", c: (r) => h("span", { class: "kchip", style: `--c:${KIND_COLOR[r.kind] ?? "#4a515c"}` }, KIND_LABEL[r.kind] ?? r.kind) };
    const mod = { h: "Modality", c: (r) => (r.modality ? h("span", { class: "kchip", style: `--c:${MOD_COLOR[r.modality]}` }, MOD_LABEL[r.modality]) : "") };
    const dl = { h: "Deadline", c: (r) => (r.deadline ? h("span", { class: "kchip", style: "--c:#f2b84b" }, "deadline") : "") };
    switch (this.lens) {
      case "definitions": return [{ h: "Term", c: (r) => h("b", { class: "term" }, r.term ?? "—") }, text, where];
      case "obligations": case "permissions": return [mod, text, dl, where];
      case "deadlines": return [text, mod, where];
      case "questions": return [{ h: "Question", c: (r) => h("div", { class: "dtext" }, r.text) }, where];
      case "fields": return [{ h: "Label", c: (r) => h("b", {}, clip(r.text.split(/:\s/)[0], 60)) }, { h: "Value", c: (r) => h("div", { class: "dtext" }, r.text.split(/:\s/).slice(1).join(": ") || r.text) }, where];
      case "tables": return [{ h: "Cells", c: (r) => h("div", { class: "cells" }, r.text.split(" | ").map((c) => h("span", { class: "cell" }, clip(c, 140)))) }, where];
      case "headings": return [{ h: "Heading", c: (r) => h("div", { class: "dtext", style: `padding-left:${Math.min(8, r.level ?? 0) * 12}px` }, h("b", {}, r.text)) }, { h: "Level", c: (r) => h("span", { class: "mono tiny" }, r.level ?? "") }, where];
      default: return [kind, text, mod, where];
    }
  }

  renderTable() {
    const cols = this.columns();
    $("#dTable").replaceChildren(...kids(
      this.rows.length ? h("table", { class: "dtable" },
        h("thead", {}, h("tr", {}, cols.map((c) => h("th", {}, c.h)))),
        h("tbody", {}, this.rows.map((r) => h("tr", { class: this.sel === `${r.doc}/${r.id}` ? "on" : "", onclick: (e) => this.detail(r, e.currentTarget) }, cols.map((c) => h("td", {}, c.c(r))))))) : h("div", { class: "empty center" }, "Nothing matches these filters."),
      this.res.total > this.rows.length ? h("button", { class: "btn small show-more", onclick: () => this.load(true) }, `Show more (${fmt(this.res.total - this.rows.length)} left)`) : null,
    ));
  }

  closeDetail() {
    if (!this.sel) return;
    this.sel = null;
    $("#dDrawer")?.classList.remove("open");
    for (const tr of $("#dTable").querySelectorAll("tr.on")) tr.classList.remove("on");
  }

  detail(r, tr) {
    this.sel = `${r.doc}/${r.id}`;
    for (const x of $("#dTable").querySelectorAll("tr.on")) x.classList.remove("on");
    tr?.classList.add("on");
    $("#dDrawer").classList.add("open");
    const src = h("div", { class: "src" }, h("div", { class: "muted small" }, "loading source…"));
    this.app.sourcePreview({ doc: r.doc, src: { doc: r.doc, block: r.id }, text: r.text }, src);
    $("#dDetail").replaceChildren(...kids(
      h("div", { class: "eyebrow" }, `${short(r.doc)}${r.page ? ` · page ${r.page}` : ""}`),
      h("div", { class: "drawer-path" }, r.path),
      src,
      r.lead_in ? [h("h4", {}, "Introduced by"), h("div", { class: "quote small" }, r.lead_in)] : null,
      h("h4", {}, `What ${ENGINE.name} decided`),
      h("div", { class: "kv" },
        h("div", {}, h("span", {}, "Kind"), h("b", {}, `${KIND_LABEL[r.kind] ?? r.kind} · ${pct(r.role_p)}`)),
        r.term ? h("div", {}, h("span", {}, "Defines"), h("b", {}, r.term)) : null,
        r.modality ? h("div", {}, h("span", {}, "Modality"), h("b", {}, MOD_LABEL[r.modality])) : null,
        h("div", {}, h("span", {}, "Deadline"), h("b", {}, r.deadline ? "yes" : "no")),
        r.section_role ? h("div", {}, h("span", {}, "Section role"), h("b", {}, human(r.section_role))) : null,
        r.topics?.length ? h("div", {}, h("span", {}, "Topics"), h("b", {}, r.topics.map(human).join(", "))) : null,
        h("div", {}, h("span", {}, "Document"), h("b", {}, `${human(r.doc_type)} · ${r.year ?? ""}`))),
      h("div", { class: "row gap6", style: "margin-top:12px" },
        h("button", { class: "btn small", onclick: () => this.app.showInLibrary(r.doc, r.id) }, "Open in Documents")),
    ));
  }

  /** The current selection becomes the scope of a new query: same documents, same kinds of pieces. */
  toQuery() {
    const R = this.res;
    const docs = this.filters.doc.length ? this.filters.doc : R.facets.doc.length <= 6 ? R.facets.doc.map(([d]) => d) : [];
    const roles = (this.filters.kind.length ? this.filters.kind : R.facets.kind.map(([k]) => k)).map((k) => KIND_ROLE[k]).filter(Boolean);
    const modality = this.filters.modality.length ? this.filters.modality : ["obligations"].includes(this.lens) ? ["must", "must_not"] : this.lens === "permissions" ? ["may"] : this.lens === "definitions" ? [] : [];
    this.app.setScope({ docs, roles: [...new Set(roles)], modality, label: `${fmt(R.total)} ${R.lenses[this.lens].label.toLowerCase()}${docs.length ? ` in ${docs.map(short).join(", ")}` : ""}` });
  }
}

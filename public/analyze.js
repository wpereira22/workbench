import { $, h, kids, fmt, pct, human, clip, esc, short, toast, tipHandlers, showCall, streamPost, openModal, parsePartialJSON, SERIES, OTHER } from "./ui.js";
import { FlowGraph, optionColor, levelColor, segmentsOf } from "./flow.js";
import { renderView } from "./charts.js";

const STAGES = [["plan", "Plan", "claude"], ["exec", "Execute", "jev"], ["views", "Views", "code"], ["insights", "Insights", "claude"]];

/** Questions this library can answer that a reader skimming the documents could not. */
const IDEAS = [
  ["Compliance calendar", "List every deadline, time limit, and required frequency in the GENIUS Act and its implementing rules: who must act, what they must do, and how long they have."],
  ["Unfinished mandates", "Which GENIUS Act provisions direct a regulator to issue rules or take an action, and has any proposed rule addressed each one yet?"],
  ["Numbers that bind", "Collect every numeric threshold across the library (dollar amounts, percentages, ratios, day counts): what it limits, who it applies to, and where it comes from."],
  ["What agencies are unsure about", "Group the agencies' requests for comment by topic: what decision each question would inform, and where the final rules are most likely to change."],
  ["Who supervises whom", "Map which agency has authority over which kind of issuer or service provider, and where those authorities overlap or leave gaps."],
  ["U.S. vs. UK", "Where do the U.S. stablecoin rules and the UK FCA's cryptoasset promotion rules impose comparable obligations, and where does only one regime impose them?"],
  ["Exemptions and safe harbors", "Inventory every exemption and safe harbor: what it exempts, the conditions, and who can rely on it."],
  ["Penalties", "List every civil or criminal penalty: the conduct it punishes, the amount or tier, and who enforces it."],
];

export class AnalyzeView {
  constructor(app) {
    this.app = app;
    this.programs = [];
    this.R = null;
    this.tab = "flow";
    this.insp = { kind: "program" };
    this.busy = false;
  }

  mount(el, programs) {
    this.el = el;
    this.programs = programs;
    el.replaceChildren(
      h("aside", { class: "side" },
        h("button", { class: "newq", onclick: () => this.compose() }, h("span", {}, "+"), "New query"),
        h("div", { class: "side-label" }, h("span", {}, "Saved"), h("span", { id: "progCount" })),
        h("div", { class: "proglist", id: "progList" }),
      ),
      h("section", { class: "work" },
        h("div", { class: "qhome", id: "qHome" },
          h("div", { class: "qhome-inner" },
            h("h1", {}, "What do you want to know?"),
            h("p", { class: "qhome-sub" }, "Describe the dataset you want. Claude Code designs the columns, Jev answers every cell from the source text, and you get a table, charts, and a written answer."),
            h("form", { class: "composer", onsubmit: (e) => { e.preventDefault(); this.ask(); } },
              h("textarea", { id: "askQ", rows: 3, placeholder: "For every obligation on stablecoin issuers: who must act, what they must do, and by when", onkeydown: (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.ask(); } } }),
              h("div", { class: "composer-foot" }, h("span", { id: "askScope" }), h("button", { class: "btn primary", type: "submit" }, "Build it", h("kbd", {}, "⌘↵")))),
            h("div", { class: "section-label" }, "Or start from a question the library can answer"),
            h("div", { class: "ideas" }, IDEAS.map(([title, q]) => h("button", { class: "idea", onclick: () => this.compose(q) }, h("b", {}, title), h("span", {}, q)))),
          ),
        ),
        h("div", { class: "qrun", id: "qRun", hidden: true },
          h("header", { class: "work-head", id: "workHead" }),
          h("div", { class: "tabs", id: "workTabs" }),
          h("div", { class: "work-body" },
            h("div", { class: "pane", id: "paneFlow" },
              h("div", { class: "flowbox", id: "flowBox" }),
              h("div", { class: "feed-wrap" }, h("div", { class: "feed-h" }, h("span", {}, "What Jev is answering"), h("span", { class: "num", id: "feedStats" })), h("div", { class: "feed", id: "feed" })),
            ),
            h("div", { class: "pane scroll", id: "paneTable" }),
            h("div", { class: "pane scroll", id: "paneCharts" }),
            h("div", { class: "pane scroll", id: "paneAnswer" }),
          ),
        ),
      ),
      h("aside", { class: "panel insp", id: "inspPanel", hidden: true },
        h("button", { class: "icon-btn insp-x", title: "Hide this panel", onclick: () => { this.inspClosed = true; this.syncInsp(); } }, "✕"),
        h("div", { class: "panel-body", id: "inspector" })),
    );
    this.flow = new FlowGraph($("#flowBox"), {
      onSegment: (id, key, label) => this.segment(id, key, label),
      onNode: (id) => this.inspect({ kind: "node", id }),
      onSource: () => this.inspect({ kind: "program" }),
      onRelations: () => this.inspect({ kind: "relations" }),
    });
    this.renderList();
    this.renderTabs();
    this.renderHead();
    this.renderInspector();
    this.renderScope();
    this.setView("home");
  }

  /** Home (the composer) or the loaded run. */
  setView(v) {
    this.view = v;
    $("#qHome").hidden = v !== "home";
    $("#qRun").hidden = v !== "run";
    this.syncInsp();
    this.renderList();
  }

  /** The side panel shows the program and whatever was clicked. On the Answer tab it stays out of the way
   *  until a citation is clicked; the ✕ hides it until the next click. */
  syncInsp() {
    const show = this.view === "run" && Boolean(this.R?.program) && !this.inspClosed && (this.tab !== "answer" || this.insp.kind !== "program");
    const was = !$("#inspPanel").hidden;
    $("#inspPanel").hidden = !show;
    this.el.classList.toggle("with-insp", show);
    if (was !== show && this.view === "run" && this.tab === "flow") requestAnimationFrame(() => this.flow.draw());
  }

  /** Opens the composer, optionally with a question filled in. */
  compose(q) {
    this.app.setMode("query");
    this.setView("home");
    if (q != null) $("#askQ").value = q;
    $("#askQ").focus();
    if (q) $("#askQ").setSelectionRange(q.length, q.length);
  }

  renderScope() {
    const el = $("#askScope");
    if (!el) return;
    const sc = this.app.scope;
    el.replaceChildren(...(sc ? [h("span", { class: "scope-chip" }, `Over ${sc.label}`, h("button", { type: "button", title: "Query the whole library instead", onclick: () => this.app.setScope(null) }, "✕"))] : [h("span", { class: "muted small" }, "Runs over the whole library")]));
  }

  setPrograms(programs) {
    this.programs = programs;
    this.renderList();
  }

  renderList() {
    $("#progCount").textContent = this.programs.length;
    $("#progList").replaceChildren(...this.programs.map((p) =>
      h("button", { class: `progitem ${this.view === "run" && this.R?.programId === p.id ? "on" : ""}`, title: p.question, onclick: () => (this.R?.programId === p.id && (this.busy || this.R.program) ? this.setView("run") : this.run({ programId: p.id })) },
        h("span", { class: "pt" }, p.title),
        h("span", { class: "pq" }, `${p.lastRun ? `${fmt(p.lastRun.rows)} ${p.level}s` : `${p.level}s`} · ${p.nodes} questions, ${p.layers ?? "?"} layers`))));
  }

  // ───────────── running ─────────────

  ask() {
    const q = $("#askQ").value.trim();
    if (!q) return $("#askQ").focus();
    this.run({ question: q, scope: this.app.scope ?? undefined });
  }

  newRun(body) {
    return {
      programId: body.programId ?? null, question: body.question ?? this.programs.find((p) => p.id === body.programId)?.question ?? "", scope: body.scope ?? null,
      program: null, author: null, nodes: new Map(), rows: new Map(), order: [], nodeStats: {}, calls: new Map(),
      rel: { pairs: 0, possible: 0, candidates: 0, judged: 0, running: 0, dist: {} },
      stages: { plan: body.programId && !body.extend ? "skipped" : "running", exec: "idle", views: "idle", insights: "idle" }, extend: body.extend ?? null, followups: [],
      thinking: { plan: "", insights: "" }, llmChars: {}, edges: [], views: [], insights: null, filter: null, dsLimit: 150, metrics: null,
    };
  }

  async run(body) {
    if (this.busy) return toast("An analysis is already running.", "warn");
    if (!this.app.state.keys.typesafe) return this.app.openKey();
    this.busy = true;
    this.app.setActivity(body.extend ? "Claude Code is adding layers" : body.question ? "Claude Code is designing the query" : "Query running");
    const prev = this.R?.program;
    this.R = this.newRun(body);
    this.R.baseProgram = body.extend ? prev : null;
    this.inspClosed = false;
    this.setView("run");
    this.insp = { kind: "program" };
    $("#feed").replaceChildren();
    this.flow.set(null);
    clearInterval(this.planTimer);
    if (body.programId && !body.extend) $("#flowBox").replaceChildren(h("div", { class: "empty center" }, "Loading program…"));
    else {
      const t0 = Date.now();
      const what = body.extend ? `adding layers${body.extend.focus ? ` under “${body.extend.focus.label}”` : ""}` : null;
      $("#flowBox").replaceChildren(h("div", { class: "draft", id: "draft" }, h("div", { class: "draft-status", id: "draftStatus" }, "Claude Code is thinking…"), h("div", { id: "draftBody" })));
      this.planTimer = setInterval(() => {
        const el = $("#draftStatus");
        if (!el || this.R?.program) return clearInterval(this.planTimer);
        const sec = Math.round((Date.now() - t0) / 1000);
        el.textContent = what ? `Claude Code is ${what}${this.R.round ? ` · round ${this.R.round.i} of ${this.R.round.of}` : ""} · ${sec} s` : this.R.llmChars.plan ? `Claude Code is writing the program · ${sec} s` : `Claude Code is working out how to structure the question · ${sec} s`;
      }, 500);
    }
    for (const id of ["paneTable", "paneCharts", "paneAnswer"]) $(`#${id}`).replaceChildren();
    this.tab = "flow";
    this.renderTabs();
    this.renderHead();
    this.renderList();
    this.renderInspector();
    try {
      await streamPost("/api/run", { ...body, fresh: $("#liveToggle")?.checked ?? false }, (ev) => this.onEvent(ev));
    } catch (err) {
      toast(err.message);
    } finally {
      this.busy = false;
      this.app.setActivity(null);
      this.schedule(true);
      this.app.refreshState().then((st) => this.setPrograms(st.programs));
    }
  }

  schedule(now = false) {
    if (!this.raf) this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.renderHead();
      this.renderTabs();
      if (this.R?.program) this.flow.update({ units: this.R.order.length, nodes: this.R.nodeStats, rel: this.R.rel });
      if (this.tab === "table") this.renderTable();
    });
    if (now && this.tab === "table") this.renderTable();
  }

  onEvent(ev) {
    const R = this.R;
    const NS = (n) => (R.nodeStats[n] ??= { ran: 0, running: 0, skipped: 0, dist: {} });
    switch (ev.t) {
      case "stage": R.stages[ev.stage] = ev.status; if (ev.status === "running") this.app.setActivity({ plan: "Claude Code is designing the query", exec: "Jev is filling the table", insights: "Claude Code is writing the answer" }[ev.stage] ?? "Query running"); if (ev.stage === "insights" && ev.status === "running" && this.tab === "answer") this.renderAnswer(); break;
      case "llm_thinking":
        R.thinking[ev.phase] += ev.delta;
        if (ev.phase === "plan") { const t = $("#planThinking"); if (t) { t.textContent = R.thinking.plan.slice(-1600); t.scrollTop = t.scrollHeight; } }
        else if (this.tab === "answer") this.renderAnswer();
        break;
      case "llm_progress":
        R.llmChars[ev.phase] = ev.chars;
        if (ev.phase === "plan" && ev.delta) { R.planText = (R.planText ?? "") + ev.delta; this.renderDraft(); }
        break;
      case "saved_program": R.programId = ev.id; break;
      case "round": R.planText = ""; if ($("#draftStatus")) R.round = ev; break;
      case "extended": this.feed(`<span class=C>CLAUDE</span> added ${ev.nodes.length} question${ev.nodes.length > 1 ? "s" : ""}${ev.focus ? ` under <b>${esc(ev.focus)}</b>` : ""}: ${esc(ev.rationale ?? "")}`); break;
      case "program":
        R.program = ev.program; R.programId = ev.id; R.author = ev.author; R.question = ev.question; R.followups = ev.followups ?? [];
        R.nodes = new Map(ev.program.nodes.map((n) => [n.id, n]));
        for (const n of ev.program.nodes) R.nodeStats[n.id] = { ran: 0, running: 0, skipped: 0, dist: {} };
        if (ev.warnings?.length) toast(`Program adjusted: ${ev.warnings.join("; ")}`, "warn");
        this.flow.set(ev.program);
        if (this.view === "run") this.setView("run");
        this.renderInspector();
        break;
      case "units":
        for (const u of ev.units) R.rows.set(u.id, { ...u, values: {}, trace: {} });
        R.order = ev.units.map((u) => u.id);
        this.feed(`<span class=S>SOURCE</span> ${fmt(ev.units.length)} ${ev.level} rows pulled from the structured library`);
        break;
      case "pending":
        if (ev.meta?.perNode) for (const [n, c] of Object.entries(ev.meta.perNode)) NS(n).running += c;
        if (ev.meta?.layer === "rel") R.rel.running += ev.meta.pairs.length;
        break;
      case "call": R.calls.set(ev.id, ev); break;
      case "fail":
        if (ev.meta?.perNode) for (const [n, c] of Object.entries(ev.meta.perNode)) NS(n).running -= c;
        if (ev.meta?.layer === "rel") R.rel.running -= ev.meta.pairs.length;
        this.feed(`<span class=x>✕ ${esc(ev.stage)} · ${esc(ev.error)}</span>`);
        break;
      case "skipped": {
        const by = {};
        for (const it of ev.items) {
          NS(it.node).skipped++;
          const row = R.rows.get(it.unit);
          if (row) row.trace[it.node] = { status: "skipped" };
          by[it.node] = (by[it.node] ?? 0) + 1;
        }
        for (const [n, c] of Object.entries(by)) {
          const node = R.nodes.get(n);
          this.feed(`<span class=sk>↷ L${ev.layer} skip</span> <b>${esc(node.label)}</b> for ${c} row${c > 1 ? "s" : ""} <span class=t>(needs ${esc(node.when.map((w) => `${human(w.field)} ${w.op} ${w.values.join("/")}`).join(" & "))})</span>`);
        }
        break;
      }
      case "answers": {
        const byUnit = new Map();
        for (const it of ev.items) {
          const st = NS(it.node);
          st.running--;
          const row = R.rows.get(it.unit);
          if (!it.v) continue;
          st.ran++;
          const node = R.nodes.get(it.node);
          const k = node.kind === "noul" ? (it.v.p >= 0.5 ? "yes" : "no") : node.kind === "choice" ? it.v.choice : Math.max(0, Math.min(node.levels.length - 1, Math.round(it.v.score)));
          st.dist[k] = (st.dist[k] ?? 0) + 1;
          if (row) { row.values[it.node] = it.v; row.trace[it.node] = { status: "done", call: ev.call }; }
          (byUnit.get(it.unit) ?? byUnit.set(it.unit, []).get(it.unit)).push([node, it.v]);
        }
        const c = R.calls.get(ev.call);
        let shown = 0;
        for (const [uid, answers] of byUnit) {
          if (shown++ >= 3) break;
          const row = R.rows.get(uid);
          this.feed(`<span class=L>L${ev.layer}</span> <span class=u>${esc(row?.label ?? uid)}</span> <span class=q>“${esc(clip(row?.snippet ?? "", 70))}”</span> → ${answers.map(([n, v]) => `<b>${esc(n.label)}</b> ${esc(ans(n, v))}`).join(" · ")}`, ev.call);
        }
        if (byUnit.size > 3) this.feed(`<span class=t>   + ${byUnit.size - 3} more rows in this call · ${ev.items.length} predicates · ${c ? (c.cached ? "cache" : `${c.latencyMs} ms`) : ""}</span>`, ev.call);
        break;
      }
      case "relations_start":
        Object.assign(R.rel, { pairs: ev.pairs, possible: ev.possible, candidates: ev.candidates });
        this.feed(`<span class=R>PAIRS</span> ${fmt(ev.candidates)} candidate rows · ${fmt(ev.possible)} comparable pairs → judging the ${fmt(ev.pairs)} most similar`);
        break;
      case "relations":
        R.rel.judged += ev.items.length;
        R.rel.running -= ev.items.length;
        for (const it of ev.items) if (it.type) R.rel.dist[it.type] = (R.rel.dist[it.type] ?? 0) + 1;
        for (const it of ev.items.filter((x) => x.type && x.type !== ev.none).slice(0, 2)) this.feed(`<span class=R>PAIR</span> <span class=u>${esc(R.rows.get(it.a)?.label)}</span> ↔ <span class=u>${esc(R.rows.get(it.b)?.label)}</span> → <b>${esc(human(it.type))}</b> ${pct(it.conf)}`, it.call);
        break;
      case "dataset":
        for (const r of ev.dataset.rows) { const row = R.rows.get(r.id); if (row) Object.assign(row, { values: r.values, trace: r.trace, text: r.text, derived: r.derived, sectionHeading: r.sectionHeading }); }
        R.edges = ev.edges;
        break;
      case "views":
        R.views = ev.views;
        R.stages.views = "done";
        this.renderCharts();
        break;
      case "insights":
        R.insights = ev.insights;
        R.stages.insights = "done";
        this.renderAnswer();
        if (this.tab === "flow" && R.programId === this.R?.programId) this.show("answer");
        if (this.tab === "flow") this.feed(`<span class=C>CLAUDE</span> insights ready${ev.insights.cached ? " (cached for identical aggregates)" : ""} → Answer tab`);
        break;
      case "metrics": R.metrics = ev.m; break;
      case "done": R.metrics = ev.m; break;
      case "warn": toast(ev.message, "warn"); break;
      case "fatal": toast(ev.error); for (const k of Object.keys(R.stages)) if (R.stages[k] === "running") R.stages[k] = "idle"; break;
    }
    this.schedule();
  }

  /** Shows the program as Claude writes it, parsed out of the partial JSON as it streams. Rows are created once
   *  and updated in place, indented by how deep each question sits in the tree. */
  renderDraft() {
    const body = $("#draftBody");
    if (!body || this.draftRaf) return;
    this.draftRaf = requestAnimationFrame(() => {
      this.draftRaf = 0;
      const p = parsePartialJSON(this.R.planText ?? "");
      if (!p) return;
      if (!body._el) {
        body._el = { title: h("h2"), thesis: h("p", { class: "draft-thesis" }), nodes: h("div", { class: "draft-nodes" }), rows: new Map() };
        body.replaceChildren(body._el.title, body._el.thesis, body._el.nodes);
      }
      const E = body._el;
      const set = (el, v) => { v = v ?? ""; if (el.textContent !== v) el.textContent = v; };
      set(E.title, typeof p.title === "string" ? p.title : "");
      set(E.thesis, typeof p.thesis === "string" ? p.thesis : typeof p.rationale === "string" ? p.rationale : "");
      const known = (E.known ??= new Map(((this.R.program ?? this.R.baseProgram)?.nodes ?? []).map((n) => [n.id, n.depth]))); // persists across rounds
      for (const n of Array.isArray(p.nodes) ? p.nodes : []) {
        if (!n || typeof n.id !== "string" || !n.label) continue;
        const when = Array.isArray(n.when) ? n.when.filter((c) => c && typeof c.field === "string") : [];
        known.set(n.id, 1 + Math.max(0, ...when.filter((c) => known.has(c.field)).map((c) => known.get(c.field))));
        let row = E.rows.get(n.id);
        if (!row) {
          row = { kind: h("span", { class: "kind" }), label: h("b"), q: h("span", { class: "dq" }), cond: h("span", { class: "dc" }) };
          row.el = h("div", { class: "draft-node" }, row.kind, h("div", { class: "dn-main" }, row.label, row.cond, row.q));
          E.nodes.append(row.el);
          E.rows.set(n.id, row);
        }
        set(row.kind, `L${known.get(n.id)} ${n.kind ?? ""}`);
        set(row.label, n.label);
        set(row.q, typeof n.question === "string" ? n.question : "");
        set(row.cond, when.length ? `if ${when.map((c) => `${human(c.field)} ${c.op === "yes" ? "= yes" : c.op === "no" ? "= no" : c.op === "in" ? "is" : c.op === "not_in" ? "is not" : c.op ?? ""} ${Array.isArray(c.values) ? c.values.map(human).join(" / ") : ""}`.trim()).join(" and ")}` : "");
        row.el.style.setProperty("--d", Math.min(8, known.get(n.id) - 1));
      }
    });
  }

  feed(html, callId) {
    const f = $("#feed");
    const stick = f.scrollTop + f.clientHeight >= f.scrollHeight - 40;
    const line = h("div", { class: `fl ${callId ? "link" : ""}`, onclick: callId ? () => showCall(callId) : null });
    line.innerHTML = html;
    f.append(line);
    while (f.childElementCount > 400) f.firstElementChild.remove();
    if (stick) f.scrollTop = f.scrollHeight;
  }

  // ───────────── header / tabs ─────────────

  renderHead() {
    const R = this.R;
    const m = R?.metrics;
    const ms = (x) => (x == null ? "—" : x < 1000 ? `${x} ms` : `${(x / 1000).toFixed(1)} s`);
    const stage = STAGES.find(([k]) => R?.stages[k] === "running");
    const done = R && Object.values(R.stages).every((x) => x === "done" || x === "skipped");
    $("#workHead").replaceChildren(
      h("div", { class: "wh-meta" },
        R?.program ? h("span", {}, R.program.title) : h("span", {}, "New query"),
        R?.scope ? h("span", { class: "scope-chip" }, `over ${R.scope.label}`) : null,
        h("span", { class: `wh-state ${stage ? "live" : ""}` }, stage ? `${stage[1]}…` : done ? "Done" : "")),
      h("h1", {}, R ? R.question || "…" : ""),
      h("div", { class: "wh-foot" },
        h("div", { class: "metrics-inline" }, R?.program ? [
          h("span", {}, h("b", {}, fmt(R.order.length)), ` ${R.program.unit.level} rows`),
          h("span", {}, h("b", {}, R.program.nodes.length), ` questions in ${R.program.layers.length} layers`),
          R.followups?.length ? h("span", {}, h("b", {}, R.followups.length), ` follow-up${R.followups.length > 1 ? "s" : ""}`) : null,
          h("span", {}, h("b", {}, fmt(m?.predicates ?? null)), " decisions"),
          h("span", {}, h("b", {}, ms(m?.wallMs))),
          h("span", {}, h("b", {}, m ? `$${m.costUsd.toFixed(3)}` : "—"), m?.cacheHits ? ` Jev · ${fmt(m.cacheHits)} cached` : " Jev")] : null),
        R?.programId ? h("div", { class: "row gap" },
          h("label", { class: "fresh", title: "Skip the cache so every question is answered live by Jev" }, h("input", { type: "checkbox", id: "liveToggle" }), "live"),
          h("button", { class: "act", disabled: this.busy || !R.program, title: "Claude Code reads how Jev answered and adds layers where the program is shallowest", onclick: () => this.inspect({ kind: "deeper" }) }, "Go deeper"),
          h("button", { class: "btn small", disabled: this.busy, onclick: () => this.run({ programId: R.programId }) }, "Run again")) : null),
    );
  }

  renderTabs() {
    const R = this.R;
    const tabs = [["answer", "Answer", R?.insights ? "" : R?.stages.insights === "running" ? "…" : ""], ["table", "Table", R?.order.length ? fmt(R.order.length) : ""], ["charts", "Charts", R?.views.length || ""], ["flow", "Flow", ""]];
    $("#workTabs").replaceChildren(...tabs.map(([k, l, n]) => h("button", { class: this.tab === k ? "on" : "", onclick: () => this.show(k) }, l, n ? h("span", { class: "tab-n" }, n) : null)));
    for (const [k] of tabs) $(`#pane${k[0].toUpperCase() + k.slice(1)}`).hidden = this.tab !== k;
  }

  show(tab) {
    this.tab = tab;
    this.renderTabs();
    this.syncInsp();
    if (tab === "table") this.renderTable();
    if (tab === "charts") this.renderCharts();
    if (tab === "answer") this.renderAnswer();
    if (tab === "flow") this.flow.draw();
  }

  // ───────────── table ─────────────

  renderTable() {
    const R = this.R;
    const pane = $("#paneTable");
    if (!R?.program || !R.order.length) return pane.replaceChildren(h("div", { class: "empty center" }, "The table fills in as Jev answers."));
    const cols = R.program.nodes;
    let ids = R.order;
    if (R.filter) ids = ids.filter((id) => R.filter.ids.has(id));
    if (this.sortBy !== "doc" && !this.busy) {
      // Most relevant first: rows that got furthest through the program, then the ones with the most yeses.
      const score = new Map(ids.map((id) => {
        const vals = R.rows.get(id)?.values ?? {};
        let depth = 0, yes = 0;
        for (const [k, v] of Object.entries(vals)) { const n = R.nodes.get(k); if (!n) continue; depth = Math.max(depth, n.depth); if (n.kind === "noul" && v.p >= 0.5) yes++; }
        return [id, depth * 100 + yes];
      }));
      ids = [...ids].sort((a, b) => score.get(b) - score.get(a));
    }
    const shown = ids.slice(0, R.dsLimit);
    pane.replaceChildren(...kids(
      h("div", { class: "table-bar" },
        h("span", { class: "muted small" }, `${fmt(R.order.length)} rows × ${cols.length} columns. Click a row to trace it to its source.`),
        h("div", { class: "row gap" },
          h("div", { class: "filters" }, [["rel", "Most relevant first"], ["doc", "Document order"]].map(([k, l]) => h("button", { class: (this.sortBy ?? "rel") === k ? "on" : "", onclick: () => { this.sortBy = k; this.renderTable(); } }, l))),
          h("button", { class: "act", disabled: this.busy, onclick: () => this.exportData("csv") }, "CSV"), h("button", { class: "act", disabled: this.busy, onclick: () => this.exportData("json") }, "JSON")),
        R.filter ? h("span", { class: "filter-chip" }, `${clip(R.filter.label, 80)} · ${fmt(ids.length)} rows`, h("button", { onclick: () => { R.filter = null; this.renderTable(); } }, "✕")) : null),
      h("table", { class: "ds-table" },
        h("thead", {}, h("tr", {}, h("th", {}, "Row"), cols.map((n) => h("th", { title: n.question, onclick: () => this.inspect({ kind: "node", id: n.id }) }, h("span", { class: `kind k-${n.kind}` }, `L${n.depth}`), n.label)), R.program.relations?.enabled ? h("th", {}, "linked") : null)),
        h("tbody", {}, shown.map((id) => {
          const row = R.rows.get(id);
          return h("tr", { class: this.insp.kind === "row" && this.insp.id === id ? "on" : "", onclick: () => this.inspect({ kind: "row", id }) },
            h("td", { class: "ds-u" }, h("b", {}, row.label), h("span", {}, row.snippet ?? clip(row.text, 170))),
            cols.map((n) => h("td", {}, cell(n, row, this.busy))),
            R.program.relations?.enabled ? h("td", {}, row.derived?.linked ? h("span", { class: `cv ${row.derived.linked === "yes" ? "" : "no"}` }, row.derived.linked) : h("span", { class: "cv na" }, "·")) : null);
        })),
      ),
      ids.length > shown.length ? h("button", { class: "btn small show-more", onclick: () => { R.dsLimit += 400; this.renderTable(); } }, `Show more (${fmt(ids.length - shown.length)})`) : null,
    ));
  }

  /** The structured dataset Jev built: one row per unit, one column per question, plus the source. */
  exportData(format) {
    const R = this.R;
    const nodes = R.program.nodes;
    const value = (n, v) => (!v ? null : n.kind === "noul" ? (v.p >= 0.5 ? "yes" : "no") : n.kind === "choice" ? v.choice : n.levels[Math.max(0, Math.min(n.levels.length - 1, Math.round(v.score)))]);
    const rows = R.order.map((id) => {
      const r = R.rows.get(id);
      const out = { id, document: r.doc, label: r.label, section: r.sectionHeading ?? null, text: r.text ?? r.snippet };
      for (const n of nodes) { out[n.id] = value(n, r.values[n.id]); if (n.kind !== "choice" && r.values[n.id]) out[`${n.id}_p`] = n.kind === "noul" ? r.values[n.id].p : r.values[n.id].score; }
      if (R.program.relations?.enabled) out.linked = r.derived?.linked ?? null;
      return out;
    });
    const name = (R.program.title || "dataset").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    let blob;
    if (format === "json") blob = new Blob([JSON.stringify({ question: R.question, program: R.program.title, columns: nodes.map(({ id, label, kind, question, options, levels }) => ({ id, label, kind, question, options, levels })), rows }, null, 1)], { type: "application/json" });
    else {
      const cols = Object.keys(rows[0] ?? {});
      const cell = (v) => { const x = v == null ? "" : String(v); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
      blob = new Blob([[cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n")], { type: "text/csv" });
    }
    const a = h("a", { href: URL.createObjectURL(blob), download: `${name}.${format}` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ───────────── charts / answer ─────────────

  ctx() {
    const R = this.R;
    return {
      nodes: R.nodes, relOptions: R.program.relations?.options,
      onMark: (ids, label) => this.inspect({ kind: "rows", ids, label }),
      onUnit: (id) => this.inspect({ kind: "row", id }),
      onEdge: (e) => this.inspect({ kind: "pair", edge: e }),
    };
  }

  renderCharts() {
    const R = this.R;
    const pane = $("#paneCharts");
    if (!R?.views.length) return pane.replaceChildren(h("div", { class: "empty center" }, "Charts are computed in code once Jev has filled in the table."));
    const order = { stat: 0, coverage: 1 };
    const views = [...R.views].sort((a, b) => (order[a.type] ?? 2) - (order[b.type] ?? 2));
    pane.replaceChildren(h("div", { class: "views" }, views.map((v) => renderView(v, this.ctx()))));
  }

  renderAnswer() {
    const R = this.R;
    const pane = $("#paneAnswer");
    if (!R) return;
    if (!R.insights) {
      return pane.replaceChildren(h("article", { class: "brief" },
        h("div", { class: "brief-meta" }, "Answer"),
        h("p", { class: "brief-lead muted" }, R.stages.insights === "running" ? `Claude Code is reading the ${fmt(R.order.length)} rows Jev structured and writing the answer.` : "Written once Jev has filled in the table."),
        R.thinking.insights ? h("div", { class: "thinking live" }, R.thinking.insights.slice(-2000)) : null));
    }
    const ins = R.insights;
    const rowCite = (uid) => { const r = R.rows.get(uid); return r ? h("button", { onclick: () => this.inspect({ kind: "row", id: uid }), title: clip(r.text ?? r.snippet ?? "", 200) }, `¶ ${r.label}`) : null; };
    const viewCite = (vid) => h("button", { onclick: () => this.flashView(vid) }, `▦ ${clip(R.views.find((v) => v.id === vid)?.title ?? vid, 48)}`);
    pane.replaceChildren(h("article", { class: "brief" },
      h("div", { class: "brief-meta" }, ins.fallback ? "Computed from the views" : `Written by ${ins.model ?? "Claude"} from ${fmt(R.order.length)} rows Jev structured${ins.cached ? " · cached" : ""}`),
      h("p", { class: "brief-lead" }, ins.answer),
      ins.key_points?.length ? h("ol", { class: "points" }, ins.key_points.map((k) => h("li", {}, h("div", {}, h("div", { class: "pt-text" }, k.point), k.unit_ids?.length ? h("div", { class: "cites" }, k.unit_ids.slice(0, 4).map(rowCite)) : null)))) : null,
      ins.insights?.length ? [h("h3", {}, ins.key_points?.length ? "Behind the answer" : "Findings"), ins.insights.map((i) => h("section", { class: "finding" },
        h("h5", {}, i.title), h("p", {}, i.body),
        i.view_ids.length || i.unit_ids.length ? h("div", { class: "cites" }, i.view_ids.map(viewCite), i.unit_ids.slice(0, 4).map(rowCite)) : null))] : null,
      ins.caveats?.length || ins.next_questions?.length ? h("div", { class: "brief-foot" },
        h("div", {}, h("div", { class: "eyebrow" }, "Caveats"), h("ul", {}, (ins.caveats ?? []).map((c) => h("li", {}, c)))),
        h("div", {}, h("div", { class: "eyebrow" }, "Ask next"), h("ul", {}, (ins.next_questions ?? []).map((q) => h("li", {}, h("button", { class: "linkish", onclick: () => this.compose(q) }, q)))))) : null,
    ));
  }

  flashView(id) {
    this.show("charts");
    const el = $(`#view-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1600);
  }

  segment(id, key, label) {
    const R = this.R;
    if (id === "__source") return this.inspect({ kind: "program" });
    if (id === "__rel") return this.inspect({ kind: "relations", type: key });
    const node = R.nodes.get(id);
    const ids = R.order.filter((rid) => {
      const v = R.rows.get(rid).values[id];
      if (!v) return false;
      return node.kind === "noul" ? (v.p >= 0.5 ? "yes" : "no") === key : node.kind === "choice" ? v.choice === key : String(Math.round(v.score)) === key;
    });
    this.inspect({ kind: "rows", ids, label, node: id, key });
  }

  // ───────────── inspector ─────────────

  inspect(x) {
    this.insp = x;
    this.inspClosed = false;
    this.syncInsp();
    this.renderInspector();
    if (this.tab === "table") this.renderTable();
  }

  renderInspector() {
    const el = $("#inspector");
    const R = this.R;
    if (!R?.program) {
      return el.replaceChildren(h("div", { class: "empty" },
        h("p", {}, "Every analysis is a program: a set of questions Jev asks about each row, stacked in layers so narrow questions only run where earlier answers allow."),
        h("p", {}, "Pick one on the left, or ask a new question and Claude Code will design one."),
        h("p", { class: "muted small" }, "Click anything (a flow segment, a chart mark, a table row) and its details and source show up here.")));
    }
    el.replaceChildren(...kids(this[`insp_${this.insp.kind}`](this.insp)));
    el.scrollTop = 0;
  }

  insp_program() {
    const R = this.R, p = R.program;
    return [
      h("div", { class: "eyebrow" }, "Program"),
      h("h3", {}, p.title),
      h("p", { class: "small" }, p.thesis),
      h("h4", {}, "Rows"),
      h("p", { class: "small" }, p.unit.rationale),
      h("div", { class: "row wrap gap6" }, (p.unit.docs.length ? p.unit.docs : ["all documents"]).map((d) => h("span", { class: "chip tiny" }, short(d)))),
      p.unit.where.length ? h("div", { class: "mono tiny warnc", style: "margin-top:6px" }, "where ", p.unit.where.map(condText).join(" & ")) : null,
      p.doc_notes?.length ? [h("h4", {}, "Scope notes sent to Jev"), p.doc_notes.map((n) => h("div", { class: "scope" }, h("b", {}, short(n.doc)), " ", n.note))] : null,
      h("h4", {}, `Questions · ${p.nodes.length} in ${p.layers.length} layers`),
      p.nodes.map((n) => h("button", { class: `qnode ${n.gen ? "added" : ""}`, style: `margin-left:${(n.depth - 1) * 14}px;width:calc(100% - ${(n.depth - 1) * 14}px)`, onclick: () => this.inspect({ kind: "node", id: n.id }) },
        h("span", { class: `kind k-${n.kind}` }, `L${n.depth} ${n.kind}`), h("b", {}, n.label), h("span", { class: "small muted" }, clip(n.question, 110)),
        n.when.length ? h("span", { class: "mono tiny warnc" }, "if ", n.when.map(condText).join(" & ")) : null)),
      p.relations?.enabled ? [h("h4", {}, "Pairwise relations"), h("button", { class: "qnode", onclick: () => this.inspect({ kind: "relations" }) }, h("span", { class: "kind k-rel" }, "pairs"), h("b", {}, p.relations.label), h("span", { class: "small muted" }, p.relations.question))] : null,
      h("div", { class: "row gap6", style: "margin-top:14px" }, h("button", { class: "btn small ghost", onclick: () => { const { layers, ...rest } = p; openModal("Program JSON", p.title, h("pre", { class: "json" }, JSON.stringify(rest, null, 2))); } }, "{ } program JSON")),
    ];
  }

  insp_node({ id }) {
    const R = this.R, n = R.nodes.get(id), st = R.nodeStats[id];
    const segs = segmentsOf(n, st.dist);
    const total = segs.reduce((a, x) => a + x.n, 0);
    return [
      h("button", { class: "back", onclick: () => this.inspect({ kind: "program" }) }, "← program"),
      h("div", { class: "eyebrow" }, `Layer ${n.depth} · ${n.kind}`),
      h("h3", {}, n.label),
      h("div", { class: "quote" }, n.question),
      n.when.length ? h("p", { class: "small" }, "Runs only when ", h("span", { class: "mono warnc" }, n.when.map(condText).join(" & "))) : h("p", { class: "small muted" }, "Runs on every row."),
      n.why ? h("p", { class: "small muted" }, n.why) : null,
      h("div", { class: "row gap6" }, h("span", { class: "chip" }, `ran ${fmt(st.ran)}`), h("span", { class: "chip warn" }, `↷ skipped ${fmt(st.skipped)}`)),
      h("h4", {}, "Answers"),
      segs.map((sg) => h("button", { class: "fbar", onclick: () => this.segment(id, sg.key, `${n.label}: ${clip(sg.label, 50)}`) },
        h("span", { class: "fl" }, h("i", { style: `background:${sg.color}` }), clip(sg.label, 34)),
        h("span", { class: "ft" }, h("span", { style: `width:${pct(sg.n / Math.max(1, total))};background:${sg.color}` })),
        h("span", { class: "fn" }, fmt(sg.n)))),
      R.programId ? [h("h4", {}, "Go deeper"), h("p", { class: "small muted" }, "Click an answer above to see its rows and ask a follow-up about just those.")] : null,
      n.kind === "choice" ? [h("h4", {}, "Option definitions"), h("div", { class: "kv" }, n.options.map((o) => h("div", {}, h("span", {}, human(o.key)), h("b", { class: "small" }, o.description))))] : null,
    ];
  }

  insp_rows({ ids, label, node, key }) {
    const R = this.R;
    return [
      h("button", { class: "back", onclick: () => this.inspect({ kind: "program" }) }, "← program"),
      h("div", { class: "eyebrow" }, `${fmt(ids.length)} rows`),
      h("h3", {}, label),
      h("div", { class: "row gap6" }, h("button", { class: "btn small", onclick: () => { R.filter = { ids: new Set(ids), label }; this.show("table"); } }, "Filter the table to these")),
      node && R.programId ? this.deeperForm({ node, key, label: clip(label, 80) }, ids.length) : null,
      h("div", { class: "samples", style: "margin-top:10px" }, ids.slice(0, 80).map((id) => { const r = R.rows.get(id); return r ? h("button", { class: "sample", onclick: () => this.inspect({ kind: "row", id }) }, h("b", {}, r.label), clip(r.snippet ?? r.text, 140)) : null; })),
      ids.length > 80 ? h("div", { class: "muted small" }, `+ ${ids.length - 80} more in the table`) : null,
    ];
  }

  insp_row({ id }) {
    const R = this.R, row = R.rows.get(id);
    if (!row) return h("div", { class: "empty" }, "Row not found.");
    const note = R.program.doc_notes?.find((n) => n.doc === row.doc);
    const src = h("div", { class: "src" }, h("div", { class: "muted small" }, "loading source…"));
    this.app.sourcePreview(row, src);
    const edges = R.edges.filter((e) => e.a === id || e.b === id);
    return [
      h("button", { class: "back", onclick: () => this.inspect({ kind: "program" }) }, "← program"),
      h("div", { class: "eyebrow" }, row.label),
      h("div", { class: "muted small" }, row.sectionHeading ?? ""),
      src,
      h("div", { class: "row gap6 wrap" }, h("button", { class: "btn small", onclick: () => this.app.showInLibrary(row.src?.doc ?? row.doc, row.src?.block) }, "Open in Documents"),
        Object.entries(row.base ?? {}).filter(([k, v]) => v && ["doc_type", "legal_force", "modality", "section_role"].includes(k)).map(([k, v]) => h("span", { class: "chip tiny" }, `${human(k)}: ${human(v)}`))),
      note ? h("div", { class: "scope" }, h("b", {}, "scope_note "), note.note) : null,
      h("h4", {}, "Path through the program"),
      h("div", { class: "path" }, R.program.nodes.map((n) => {
        const v = row.values[n.id], tr = row.trace[n.id] ?? {};
        const status = v ? "done" : tr.status === "skipped" ? "skipped" : "idle";
        return h("div", { class: `step ${status}` }, h("div", { class: "dot" }, `L${n.depth}`),
          h("div", { class: "box" },
            h("div", { class: "row between" }, h("b", {}, n.label), status === "skipped" ? h("span", { class: "mono tiny warnc" }, "↷ skipped") : null),
            n.when.length ? h("div", { class: "mono tiny warnc" }, (status === "skipped" ? "condition failed: " : "because ") + n.when.map(condText).join(" & ")) : null,
            v ? probs(n, v) : null,
            v && tr.call ? h("a", { class: "tiny", onclick: () => showCall(tr.call, (k) => k === tr.key) }, `Jev call #${tr.call} ↗`) : null));
      })),
      edges.length ? [h("h4", {}, `Relationships (${edges.length})`), h("div", { class: "samples" }, edges.map((e) => { const o = R.rows.get(e.a === id ? e.b : e.a); return h("button", { class: "sample", onclick: () => this.inspect({ kind: "pair", edge: e }) }, h("b", {}, `${human(e.type)} ${pct(e.conf)}`), `${o?.label}: ${clip(o?.text ?? "", 110)}`); }))] : null,
    ];
  }

  insp_deeper() {
    const R = this.R;
    return [
      h("button", { class: "back", onclick: () => this.inspect({ kind: "program" }) }, "← program"),
      h("div", { class: "eyebrow" }, "Go deeper"),
      h("h3", {}, "Add layers to this program"),
      h("p", { class: "small muted" }, "Claude Code reads how Jev answered every question, finds where the program is shallow (big catch-all buckets, branches with no follow-up), and adds the next layers. Or click any segment in the Flow to drill into that branch."),
      this.deeperForm(null, R.order.length),
      R.followups?.length ? [h("h4", {}, "Earlier follow-ups"), R.followups.map((f) => h("div", { class: "scope" }, h("b", {}, f.focus ? `On ${f.focus}: ` : ""), f.request || "Claude chose", h("div", { class: "muted small" }, f.rationale)))] : null,
    ];
  }

  /** Ask a follow-up about a branch: it becomes new questions that run only on that branch's rows. */
  deeperForm(focus, n) {
    const ta = h("textarea", { rows: 3, placeholder: focus ? `Ask about these ${fmt(n)} rows, e.g. “who must act, and what triggers it?”` : "What should the next layers find out? Leave empty to let Claude choose." });
    const go = (request, rounds = 1) => this.run({ programId: this.R.programId, extend: { focus, request, rounds } });
    return h("form", { class: "deeper", onsubmit: (e) => { e.preventDefault(); go(ta.value); } },
      focus ? h("div", { class: "deeper-h" }, "Go deeper into this branch") : null,
      focus ? h("p", { class: "muted small" }, `New questions run only on these ${fmt(n)} rows; everything above them is served from the cache.`) : null,
      ta,
      h("div", { class: "row gap wrap" }, h("button", { class: "btn small primary", type: "submit", disabled: this.busy }, "Add layers"),
        h("button", { class: "act", type: "button", disabled: this.busy, onclick: () => go("") }, "Let Claude choose"),
        h("button", { class: "act", type: "button", disabled: this.busy, title: "Three rounds: after each, the grown program runs and Claude goes a level deeper where the new answers are still broad", onclick: () => go(ta.value, 3) }, "Three rounds deep")));
  }

  insp_pair({ edge: e }) {
    const R = this.R, a = R.rows.get(e.a), b = R.rows.get(e.b), r = R.program.relations;
    return [
      h("button", { class: "back", onclick: () => this.inspect({ kind: "relations" }) }, "← relations"),
      h("div", { class: "eyebrow" }, "Relationship"),
      h("h3", {}, `${human(e.type)} · ${pct(e.conf)}`),
      h("div", { class: "quote small" }, r.question),
      h("div", { class: "probs" }, r.options.map((o, i) => h("div", { class: o.key === e.type ? "top" : "" }, h("span", {}, human(o.key)), h("span", { class: "bar" }, h("span", { style: `width:${pct(e.probs?.[o.key] ?? 0)};background:${o.key === r.none_option ? OTHER : SERIES[[4, 2, 6][i] ?? i]}` })), h("span", { class: "p" }, pct(e.probs?.[o.key] ?? 0))))),
      h("h4", {}, `A · ${a?.label}`), h("button", { class: "quote link", onclick: () => this.inspect({ kind: "row", id: e.a }) }, a?.text),
      h("h4", {}, `B · ${b?.label}`), h("button", { class: "quote link", onclick: () => this.inspect({ kind: "row", id: e.b }) }, b?.text),
      e.call ? h("a", { class: "tiny", onclick: () => showCall(e.call) }, `Jev call #${e.call} ↗`) : null,
    ];
  }

  insp_relations({ type } = {}) {
    const R = this.R, r = R.program.relations;
    const edges = R.edges.filter((e) => !type || e.type === type).sort((x, y) => (y.conf ?? 0) - (x.conf ?? 0));
    return [
      h("button", { class: "back", onclick: () => this.inspect({ kind: "program" }) }, "← program"),
      h("div", { class: "eyebrow" }, "Pairwise relations"),
      h("h3", {}, r.label),
      h("div", { class: "quote small" }, r.question),
      h("div", { class: "row wrap gap6" }, h("span", { class: "chip" }, `${fmt(R.rel.candidates)} candidate rows`), h("span", { class: "chip" }, `${fmt(R.rel.possible)} comparable pairs`), h("span", { class: "chip" }, `${fmt(R.rel.judged)} judged (${r.pairs_per_row} most similar per row)`),
        r.block_by ? h("span", { class: "chip warn" }, `same ${human(r.block_by)} only`) : null, r.anchor_docs.length ? h("span", { class: "chip warn" }, `anchored on ${r.anchor_docs.map(short).join(", ")}`) : null),
      h("h4", {}, `${type ? human(type) : "Strongest"} edges (${edges.length})`),
      h("div", { class: "samples" }, edges.slice(0, 60).map((e) => h("button", { class: "sample", onclick: () => this.inspect({ kind: "pair", edge: e }) }, h("b", {}, `${human(e.type)} ${pct(e.conf)}`), `${R.rows.get(e.a)?.label} ↔ ${R.rows.get(e.b)?.label}`))),
    ];
  }
}

const condText = (c) => `${human(c.field)} ${({ yes: "= yes", no: "= no", in: `∈ {${c.values.map(human).join(", ")}}`, not_in: `∉ {${c.values.map(human).join(", ")}}`, gte: `≥ ${c.threshold}`, lte: `≤ ${c.threshold}` })[c.op]}`;

function ans(n, v) {
  if (n.kind === "noul") return `${v.p >= 0.5 ? "yes" : "no"} ${pct(v.p)}`;
  if (n.kind === "choice") return `${human(v.choice)} ${pct(v.conf)}`;
  return `${clip(n.levels[Math.round(v.score)], 28)}`;
}

function probs(n, v) {
  let items;
  if (n.kind === "noul") items = [["yes", v.p, SERIES[0]], ["no", 1 - v.p, OTHER]];
  else if (n.kind === "choice") items = Object.entries(v.probs ?? {}).map(([k, p]) => [human(k), p, optionColor(n, k)]).sort((a, b) => b[1] - a[1]).slice(0, 4);
  else items = Object.entries(v.probs ?? {}).map(([k, p]) => [n.levels[+k] ?? k, p, levelColor(n, k)]);
  const top = Math.max(...items.map((x) => x[1]));
  return h("div", { class: "probs" }, items.map(([k, p, c]) => h("div", { class: p === top ? "top" : "" }, h("span", {}, clip(k, 34)), h("span", { class: "bar" }, h("span", { style: `width:${pct(p)};background:${c}` })), h("span", { class: "p" }, pct(p)))));
}

function cell(n, row, busy) {
  const v = row.values[n.id], tr = row.trace[n.id];
  if (v) {
    if (n.kind === "noul") return h("span", { class: `cv ${v.p >= 0.5 ? "" : "no"}` }, h("span", { class: "pb" }, h("span", { style: `width:${pct(v.p)}` })), `${v.p >= 0.5 ? "yes" : "no"} ${pct(v.p)}`);
    if (n.kind === "choice") return h("span", { class: "cv", title: `confidence ${pct(v.conf)}` }, h("i", { style: `background:${optionColor(n, v.choice)}` }), human(v.choice));
    const i = Math.max(0, Math.min(n.levels.length - 1, Math.round(v.score)));
    return h("span", { class: "cv", title: n.levels[i] }, h("span", { class: "dots" }, n.levels.map((_, k) => h("span", { style: `color:${k <= i ? levelColor(n, i) : "var(--line-2)"}` }, "●"))), clip(n.levels[i], 24));
  }
  if (tr?.status === "skipped") return h("span", { class: "cv skip", title: "Condition not met, so this question never ran for this row" }, "↷");
  if (busy) return h("span", { class: "cv run" });
  return h("span", { class: "cv na" }, "·");
}

import { s, fmt, pct, human, clip, esc, SERIES, OTHER, seq, showTip, hideTip } from "./ui.js";

export const optionColor = (node, key) => {
  const i = node.options.findIndex((o) => o.key === key);
  return i >= 0 && i < SERIES.length ? SERIES[i] : OTHER;
};
export const levelColor = (node, i) => seq((+i + 1) / node.levels.length);

/** Segments of a node in a stable order: noul yes/no, choice options, score levels. */
export function segmentsOf(node, dist) {
  if (node.kind === "noul") return [{ key: "yes", label: "yes", color: SERIES[0] }, { key: "no", label: "no", color: OTHER }].map((x) => ({ ...x, n: dist[x.key] ?? 0 }));
  if (node.kind === "choice") return node.options.map((o) => ({ key: o.key, label: human(o.key), color: optionColor(node, o.key), n: dist[o.key] ?? 0 }));
  return node.levels.map((lv, i) => ({ key: String(i), label: lv, color: levelColor(node, i), n: dist[i] ?? 0 }));
}

function passes(c, parent, key) {
  if (parent.kind === "noul") return c.op === "yes" ? key === "yes" : c.op === "no" ? key === "no" : c.op === "in" ? c.values.includes(key) : true;
  if (parent.kind === "choice") return c.op === "in" ? c.values.includes(key) : c.op === "not_in" ? !c.values.includes(key) : true;
  const lvl = +key;
  return c.op === "gte" ? lvl >= c.threshold : c.op === "lte" ? lvl <= c.threshold : c.op === "in" ? c.values.includes(parent.levels[lvl]) : true;
}

const band = (x1, a0, a1, x2, b0, b1) => {
  const m = (x1 + x2) / 2;
  return `M${x1},${a0} C${m},${a0} ${m},${b0} ${x2},${b0} L${x2},${b1} C${m},${b1} ${m},${a1} ${x1},${a1} Z`;
};

export class FlowGraph {
  constructor(el, handlers) {
    this.el = el;
    this.handlers = handlers;
    this.program = null;
    this.stats = null;
    new ResizeObserver(() => this.draw()).observe(el);
  }

  set(program) {
    this.program = program;
    this.stats = null;
    this.draw();
  }

  update(stats) {
    this.stats = stats;
    this.draw();
  }

  draw() {
    const p = this.program;
    if (!p) return; // leave whatever the caller put here (e.g. the program draft) alone
    const st = this.stats ?? { units: 0, nodes: {}, rel: null };
    const nodeIds = new Set(p.nodes.map((n) => n.id));
    const cols = [[{ id: "__source" }], ...p.layers];
    const rel = p.relations?.enabled ? st.rel : null;
    if (p.relations?.enabled) cols.push([{ id: "__rel" }]);

    const barW = 14, top = 34, bottom = 14, gap = 44;
    // Deep programs scroll instead of squeezing: every layer keeps a readable column, every node a readable bar.
    const most = Math.max(...cols.map((c) => c.length));
    const W = Math.max(640, this.el.clientWidth, 230 + (cols.length - 1) * 210);
    const H = Math.max(300, this.el.clientHeight - (W > this.el.clientWidth ? 12 : 0), top + bottom + most * 40 + gap * (most - 1));
    const colW = (W - 40 - 190) / Math.max(1, cols.length - 1);
    const countOf = (n) => (n.id === "__source" ? st.units || 0 : n.id === "__rel" ? rel?.judged ?? 0 : (st.nodes[n.id]?.ran ?? 0) + (st.nodes[n.id]?.running ?? 0));
    // Square-root heights: a gate that keeps 1% of rows would otherwise leave later layers as slivers.
    // Segments inside a bar stay linear, and every segment is labeled with its exact count.
    const size = (n) => Math.sqrt(n);
    const maxCol = Math.max(1, ...cols.map((c) => c.reduce((a, n) => a + size(countOf(n)), 0)));
    const avail = H - top - bottom - gap * (Math.max(...cols.map((c) => c.length)) - 1);
    const k = Math.max(0.02, avail / maxCol);

    const pos = new Map();
    const out = [];
    const ribbons = [];
    cols.forEach((col, ci) => {
      const x = 20 + ci * colW;
      let y = top;
      for (const n of col) {
        const cnt = countOf(n);
        const hgt = Math.max(cnt ? 6 : 26, size(cnt) * k);
        pos.set(n.id, { x, y, h: hgt, cnt });
        y += hgt + gap;
      }
    });

    // Segments + labels for every node bar.
    const segPos = new Map(); // nodeId -> [{key, y0, y1, color, n}]
    for (const [id, P] of pos) {
      const node = id.startsWith("__") ? null : p.nodes.find((n) => n.id === id);
      let segs;
      if (id === "__source") segs = [{ key: "all", label: `${p.unit.level} rows`, color: "#8a8a93", n: P.cnt }];
      else if (id === "__rel") {
        const opts = p.relations.options;
        segs = opts.map((o, i) => ({ key: o.key, label: human(o.key), color: o.key === p.relations.none_option ? OTHER : SERIES[[4, 2, 6][i] ?? i], n: rel?.dist?.[o.key] ?? 0 }));
      } else segs = segmentsOf(node, st.nodes[id]?.dist ?? {});
      const total = segs.reduce((a, x) => a + x.n, 0);
      const running = node ? st.nodes[id]?.running ?? 0 : 0;
      let yy = P.y;
      const placed = [];
      for (const sg of segs) {
        if (!sg.n) continue;
        const hh = (sg.n / Math.max(1, P.cnt)) * P.h;
        placed.push({ ...sg, y0: yy, y1: yy + hh });
        yy += hh;
      }
      segPos.set(id, placed);
      // Title
      const title = id === "__source" ? "Source" : id === "__rel" ? p.relations.label || "Relations" : node.label;
      const sub = id === "__source" ? `${p.unit.docs.length ? `${p.unit.docs.length} documents` : "all documents"}${p.unit.where.length ? " · filtered on base layer" : ""}`
        : id === "__rel" ? (rel?.pairs ? `${fmt(rel.judged)}/${fmt(rel.pairs)} pairs judged` : "waiting for rows")
        : `L${node.depth} ${node.kind} · ran ${fmt(st.nodes[id]?.ran ?? 0)}${running ? ` · ${running} in flight` : ""}${st.nodes[id]?.skipped ? ` · ↷ ${fmt(st.nodes[id].skipped)} skipped` : ""}`;
      const fit = Math.max(12, Math.floor((colW - 18) / 6.3)); // chars that fit before the next column
      out.push(s("text", { x: P.x, y: P.y - 18, class: "fl-title", onclick: () => (node ? this.handlers.onNode?.(id) : id === "__rel" ? this.handlers.onRelations?.() : this.handlers.onSource?.()) }, clip(title, Math.floor(fit * 0.8)), s("title", {}, title)));
      out.push(s("text", { x: P.x, y: P.y - 6, class: `fl-sub ${running ? "live" : ""}` }, clip(sub, fit), s("title", {}, sub)));
      if (!placed.length) out.push(s("rect", { x: P.x, y: P.y, width: barW, height: P.h, rx: 3, class: "fl-empty" }));
      for (const sg of placed) {
        const r = s("rect", {
          x: P.x, y: sg.y0, width: barW, height: Math.max(1, sg.y1 - sg.y0 - (placed.length > 1 ? 1 : 0)), fill: sg.color, class: `fl-seg ${running ? "run" : ""}`,
          onmousemove: (e) => showTip(e, `<b>${esc(title)}</b><br>${esc(clip(sg.label, 90))}: ${fmt(sg.n)} · ${pct(sg.n / Math.max(1, total))}<br><span class=m>click for the rows</span>`),
          onmouseleave: hideTip,
          onclick: () => this.handlers.onSegment?.(id, sg.key, `${title}: ${clip(sg.label, 50)}`),
        });
        out.push(r);
        if (sg.y1 - sg.y0 >= 12) out.push(s("text", { x: P.x + barW + 6, y: (sg.y0 + sg.y1) / 2 + 4, class: "fl-seg-label" }, `${clip(sg.label, Math.max(10, Math.floor((colW - 70) / 6.3)))} · ${fmt(sg.n)}`));
      }
    }

    // Ribbons: from the parent segments that satisfy a node's condition into the node.
    const drawn = new Set();
    for (const n of p.nodes) {
      const T = pos.get(n.id);
      const cond = n.when.find((c) => nodeIds.has(c.field));
      const sources = [];
      if (!cond) for (const sg of segPos.get("__source") ?? []) sources.push({ from: pos.get("__source"), sg });
      else {
        const parent = p.nodes.find((x) => x.id === cond.field);
        for (const sg of segPos.get(parent.id) ?? []) if (passes(cond, parent, sg.key)) sources.push({ from: pos.get(parent.id), sg });
      }
      const tot = sources.reduce((a, x) => a + x.sg.n, 0);
      let ty = T.y;
      for (const { from, sg } of sources) {
        const th = tot ? (sg.n / tot) * T.h : T.h;
        ribbons.push(s("path", { d: band(from.x + barW, sg.y0, sg.y1, T.x, ty, ty + th), fill: sg.color, class: `fl-rib ${(st.nodes[n.id]?.running ?? 0) ? "live" : ""}` }));
        drawn.add(`${from.x}|${sg.key}|${sg.y0}`);
        ty += th;
      }
      if (n.when.some((c) => !nodeIds.has(c.field))) out.push(s("text", { x: T.x, y: T.y + T.h + 13, class: "fl-cond" }, `if ${n.when.filter((c) => !nodeIds.has(c.field)).map((c) => `${human(c.field)} ${c.op} ${c.values.join("/")}`).join(" & ")}`));
    }
    if (p.relations?.enabled) {
      const R = pos.get("__rel");
      const r = p.relations;
      const feeder = [r.block_by, ...r.candidates.map((c) => c.field)].find((f) => nodeIds.has(f));
      const parent = p.nodes.find((x) => x.id === feeder);
      const cond = r.candidates.find((c) => c.field === feeder);
      const srcs = (segPos.get(feeder) ?? []).filter((sg) => !cond || passes(cond, parent, sg.key));
      const tot = srcs.reduce((a, x) => a + x.n, 0);
      let ty = R.y;
      for (const sg of srcs) {
        const th = tot ? (sg.n / tot) * R.h : R.h;
        ribbons.push(s("path", { d: band(pos.get(feeder).x + barW, sg.y0, sg.y1, R.x, ty, ty + th), fill: sg.color, class: `fl-rib ${rel?.running ? "live" : ""}` }));
        drawn.add(`${pos.get(feeder).x}|${sg.key}|${sg.y0}`);
        ty += th;
      }
    }
    // Segments with nothing flowing out of them: the branches that stop.
    for (const n of p.nodes) {
      const hasChild = p.nodes.some((m) => m.when.some((c) => c.field === n.id)) || p.relations?.block_by === n.id || p.relations?.candidates?.some((c) => c.field === n.id);
      if (!hasChild) continue;
      for (const sg of segPos.get(n.id) ?? []) {
        const P = pos.get(n.id);
        if (!drawn.has(`${P.x}|${sg.key}|${sg.y0}`) && sg.y1 - sg.y0 >= 12) out.push(s("text", { x: P.x - 6, y: (sg.y0 + sg.y1) / 2 + 4, class: "fl-stop", "text-anchor": "end" }, "stops ■"));
      }
    }

    this.el.replaceChildren(s("svg", { width: W, height: H, class: "flow" }, ribbons, out));
  }
}

import { h, s, fmt, pct, human, clip, esc, short, SERIES, OTHER, seq, inkOn, tipHandlers, showTip, hideTip } from "./ui.js";

// ctx: { nodes: Map(id -> column), onMark(ids, label), onUnit(id), onEdge(edge) }

const fieldLabel = (ctx, f) => (f === "doc" ? "Document" : ctx.nodes.get(f)?.label ?? human(f));
const valueLabel = (ctx, f, k) => (f === "doc" ? short(k) : human(k));
const num = (v, measure) => (measure === "share" ? pct(v) : measure === "mean" ? (Math.round(v * 100) / 100).toString() : fmt(v));
const meanLabel = (ctx, v) => {
  const n = ctx.nodes.get(v.measure_field);
  return n?.kind === "noul" ? "share yes" : n?.kind === "score" ? `mean ${n.label.toLowerCase()} (0–${n.levels.length - 1})` : "mean";
};

export function renderView(v, ctx) {
  const card = h("section", { class: "view", id: `view-${v.id}`, "data-view": v.id },
    h("header", {}, h("div", { class: "vt" }, v.title), v.why ? h("div", { class: "vw" }, v.why) : null),
  );
  if (v.error) return card.append(h("div", { class: "empty" }, `Could not compute: ${v.error}`)), card;
  const body = ({ bar, heatmap, histogram, stat, table, network, coverage })[v.type]?.(v, ctx);
  card.classList.add(`v-${v.type}`);
  card.append(body ?? h("div", { class: "empty" }, "Unsupported view"));
  return card;
}

function bar(v, ctx) {
  if (!v.bars.length) return h("div", { class: "empty" }, "No rows matched.");
  const max = Math.max(...v.bars.map((b) => b.value), v.measure === "share" ? 1 : 0) || 1;
  const n = ctx.nodes.get(v.measure_field);
  const axis = v.measure === "mean" ? meanLabel(ctx, v) : v.measure === "share" ? "share of rows" : "rows";
  return h("div", { class: "hbar" },
    h("div", { class: "axis-note" }, `${fieldLabel(ctx, v.x)} · ${axis}`),
    v.bars.map((b) =>
      h("div", { class: "hrow", onclick: () => ctx.onMark(b.ids, `${v.title}: ${valueLabel(ctx, v.x, b.key)}`), ...tipHandlers(`<b>${esc(valueLabel(ctx, v.x, b.key))}</b><br>${num(b.value, v.measure)}${v.measure !== "count" ? ` · ${b.n} rows` : ""}<br><span class=m>click to see rows</span>`) },
        h("span", { class: "hl" }, clip(valueLabel(ctx, v.x, b.key), 28)),
        h("span", { class: "ht" }, h("span", { class: "hb", style: `width:${(b.value / max) * 100}%` })),
        h("span", { class: "hv" }, num(b.value, v.measure)),
      ),
    ),
  );
}

function coverage(v, ctx) {
  if (!v.bars.length) return h("div", { class: "empty" }, "No rows were compared.");
  const strong = human(v.strong ?? "match");
  return h("div", { class: "hbar" },
    h("div", { class: "axis-note" }, `${fieldLabel(ctx, v.x)} · share with a “${strong}” match · overall ${pct(v.covered / Math.max(1, v.total))} (${fmt(v.covered)}/${fmt(v.total)})`),
    v.bars.map((b) =>
      h("div", { class: "hrow", onclick: () => ctx.onMark(b.gaps, `${v.title}: ${valueLabel(ctx, v.x, b.key)} without a “${strong}” match`), ...tipHandlers(`<b>${esc(valueLabel(ctx, v.x, b.key))}</b><br>${b.covered} of ${b.n} have a “${esc(strong)}” match (${pct(b.value)})<br><span class=m>click to see the ${b.n - b.covered} without one</span>`) },
        h("span", { class: "hl" }, clip(valueLabel(ctx, v.x, b.key), 28)),
        h("span", { class: "ht cov" }, h("span", { class: "hb", style: `width:${b.value * 100}%` })),
        h("span", { class: "hv" }, `${b.covered}/${b.n}`),
      ),
    ),
  );
}

function heatmap(v, ctx) {
  if (!v.xs.length || !v.ys.length) return h("div", { class: "empty" }, "No rows matched.");
  const max = Math.max(...v.cells.map((c) => c.value)) || 1;
  const grid = h("div", { class: "hm", style: `grid-template-columns: minmax(90px, max-content) repeat(${v.xs.length}, minmax(34px, 1fr))` });
  grid.append(h("div", { class: "hm-corner" }, h("span", {}, `${fieldLabel(ctx, v.y)} ↓`), h("span", {}, `${fieldLabel(ctx, v.x)} →`)));
  for (const x of v.xs) grid.append(h("div", { class: "hm-x", title: human(x.label) }, h("span", {}, clip(valueLabel(ctx, v.x, x.key), 26))));
  for (const y of v.ys) {
    grid.append(h("div", { class: "hm-y", title: valueLabel(ctx, v.y, y.key) }, clip(valueLabel(ctx, v.y, y.key), 24)));
    for (const x of v.xs) {
      const c = v.cells.find((c) => c.x === x.key && c.y === y.key);
      const bg = c.n ? seq(0.12 + 0.88 * (c.value / max)) : "transparent";
      grid.append(
        h("div", {
          class: `hm-c ${c.n ? "" : "zero"}`,
          style: c.n ? `background:${bg};color:${inkOn(bg)}` : "",
          onclick: c.n ? () => ctx.onMark(c.ids, `${v.title}: ${valueLabel(ctx, v.x, x.key)} × ${valueLabel(ctx, v.y, y.key)}`) : null,
          ...tipHandlers(`<b>${esc(valueLabel(ctx, v.y, y.key))}</b> × <b>${esc(valueLabel(ctx, v.x, x.key))}</b><br>${c.n} rows${v.measure === "mean" ? ` · ${meanLabel(ctx, v)} ${num(c.value, "mean")}` : ""}`),
        }, c.n ? (v.measure === "mean" ? num(c.value, "mean") : c.n) : ""),
      );
    }
  }
  return h("div", { class: "hm-wrap" }, grid);
}

function histogram(v, ctx) {
  const max = Math.max(...v.bins.map((b) => b.n)) || 1;
  const n = ctx.nodes.get(v.x);
  return h("div", { class: "hist" },
    h("div", { class: "hist-cols", style: `grid-template-columns: repeat(${v.bins.length}, 1fr)` },
      v.bins.map((b, i) =>
        h("div", { class: "hc", onclick: b.n ? () => ctx.onMark(b.ids, `${v.title}: ${b.label}`) : null, ...tipHandlers(`<b>${esc(b.label)}</b><br>${b.n} rows · ${pct(b.n / (v.total || 1))}`) },
          h("span", { class: "hc-v" }, b.n || ""),
          h("span", { class: "hc-bar", style: `height:${(b.n / max) * 100}%;background:${n?.kind === "score" ? seq((i + 1) / v.bins.length) : SERIES[0]}` }),
        ),
      ),
    ),
    h("div", { class: "hist-labels", style: `grid-template-columns: repeat(${v.bins.length}, 1fr)` }, v.bins.map((b) => h("span", { title: b.label }, clip(b.label, 40)))),
  );
}

function stat(v, ctx) {
  const value = v.measure === "share" ? pct(v.value) : v.measure === "mean" ? (Math.round(v.value * 100) / 100).toString() : fmt(v.value);
  return h("div", { class: "stat", onclick: () => ctx.onMark(v.ids, v.title) },
    h("div", { class: "stat-v" }, value),
    h("div", { class: "stat-sub" }, `${fmt(v.n)} of ${fmt(v.of)} rows · click to see them`),
    h("div", { class: "stat-bar" }, h("span", { style: `width:${(v.n / (v.of || 1)) * 100}%` })),
  );
}

function table(v, ctx) {
  if (!v.rows.length) return h("div", { class: "empty" }, "No rows matched.");
  return h("div", { class: "vtable" },
    h("div", { class: "vt-head", style: `grid-template-columns: 1fr ${v.cols.map(() => "110px").join(" ")}` }, h("span", {}, "Unit"), v.cols.map((c) => h("span", {}, fieldLabel(ctx, c)))),
    v.rows.map((r) =>
      h("div", { class: "vt-row", style: `grid-template-columns: 1fr ${v.cols.map(() => "110px").join(" ")}`, onclick: () => ctx.onUnit(r.id) },
        h("span", { class: "vt-u" }, h("b", {}, r.label), h("span", {}, r.text)),
        r.cells.map((c) => h("span", { class: "vt-c" }, human(c))),
      ),
    ),
  );
}

// ───────── network: small force layout, deterministic seed ─────────

function layout(nodes, edges, W, H) {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  const P = nodes.map(() => ({ x: W / 2 + (rand() - 0.5) * W * 0.8, y: H / 2 + (rand() - 0.5) * H * 0.8, vx: 0, vy: 0 }));
  const E = edges.map((e) => [idx.get(e.a), idx.get(e.b)]).filter(([a, b]) => a != null && b != null);
  const k = Math.sqrt((W * H) / Math.max(1, nodes.length)) * 0.55;
  for (let it = 0; it < 320; it++) {
    const t = 1 - it / 320;
    for (let i = 0; i < P.length; i++) {
      for (let j = i + 1; j < P.length; j++) {
        let dx = P[i].x - P[j].x, dy = P[i].y - P[j].y;
        const d2 = dx * dx + dy * dy + 0.01;
        const f = (k * k) / d2;
        P[i].vx += dx * f * 0.02; P[i].vy += dy * f * 0.02;
        P[j].vx -= dx * f * 0.02; P[j].vy -= dy * f * 0.02;
      }
    }
    for (const [a, b] of E) {
      const dx = P[b].x - P[a].x, dy = P[b].y - P[a].y;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const f = (d - k) / d * 0.08;
      P[a].vx += dx * f; P[a].vy += dy * f; P[b].vx -= dx * f; P[b].vy -= dy * f;
    }
    for (const p of P) {
      p.vx += (W / 2 - p.x) * 0.004; p.vy += (H / 2 - p.y) * 0.004;
      p.x += Math.max(-12, Math.min(12, p.vx)) * t; p.y += Math.max(-12, Math.min(12, p.vy)) * t;
      p.vx *= 0.5; p.vy *= 0.5;
    }
  }
  const xs = P.map((p) => p.x), ys = P.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pad = 22;
  return P.map((p) => ({ x: pad + ((p.x - x0) / (x1 - x0 || 1)) * (W - 2 * pad), y: pad + ((p.y - y0) / (y1 - y0 || 1)) * (H - 2 * pad) }));
}

function network(v, ctx) {
  if (!v.edges.length) return h("div", { class: "empty" }, "No relationships found between these rows.");
  const W = 560, H = 360;
  const counts = new Map();
  for (const n of v.nodes) counts.set(n.group, (counts.get(n.group) ?? 0) + 1);
  // Fixed slots for the three largest groups (all-pairs safe), everything else folds to Other.
  const groups = [...counts].sort((a, b) => b[1] - a[1]).map(([g]) => g);
  const color = (g) => (groups.indexOf(g) < 3 ? SERIES[groups.indexOf(g)] : OTHER);
  const types = ctx.relOptions?.map((o) => o.key).filter((k) => v.types.includes(k)) ?? v.types;
  const widthOf = (t) => Math.max(1, 3 - types.indexOf(t) * 1.1);
  const P = layout(v.nodes, v.edges, W, H);
  const at = new Map(v.nodes.map((n, i) => [n.id, P[i]]));
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "net" });
  const edgeEls = v.edges.map((e) => {
    const a = at.get(e.a), b = at.get(e.b);
    const line = s("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: `ne t${types.indexOf(e.type)}`, "stroke-width": widthOf(e.type) });
    const hit = s("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "ne-hit",
      onmousemove: (ev) => showTip(ev, `<b>${esc(human(e.type))}</b> · ${pct(e.conf)}<br>${esc(label(e.a))}<br>↔ ${esc(label(e.b))}<br><span class=m>click to compare</span>`),
      onmouseleave: hideTip, onclick: () => ctx.onEdge(e) });
    return { e, line, hit };
  });
  const byId = new Map(v.nodes.map((n) => [n.id, n]));
  const label = (id) => byId.get(id)?.label ?? id;
  svg.append(...edgeEls.map((x) => x.line), ...edgeEls.map((x) => x.hit));
  for (const n of v.nodes) {
    const p = at.get(n.id);
    const deg = v.edges.filter((e) => e.a === n.id || e.b === n.id).length;
    svg.append(s("circle", {
      cx: p.x, cy: p.y, r: 4 + Math.min(4, deg), fill: color(n.group), class: "nn",
      onmousemove: (ev) => {
        showTip(ev, `<b>${esc(n.label)}</b><br>${deg} relationship${deg === 1 ? "" : "s"}<br><span class=m>click to trace</span>`);
        edgeEls.forEach((x) => x.line.classList.toggle("hot", x.e.a === n.id || x.e.b === n.id));
      },
      onmouseleave: () => { hideTip(); edgeEls.forEach((x) => x.line.classList.remove("hot")); },
      onclick: () => ctx.onUnit(n.id),
    }));
  }
  const legend = h("div", { class: "legend" },
    groups.slice(0, 3).map((g) => h("span", {}, h("i", { style: `background:${color(g)};border-radius:50%` }), g)),
    groups.length > 3 ? h("span", {}, h("i", { style: `background:${OTHER};border-radius:50%` }), `other (${groups.length - 3})`) : null,
    h("span", { class: "sep" }),
    types.map((t) => h("span", {}, h("b", { class: `lk t${types.indexOf(t)}`, style: `height:${widthOf(t)}px` }), `${human(t)} ${v.edges.filter((e) => e.type === t).length}`)),
  );
  return h("div", {}, legend, svg);
}

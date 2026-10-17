export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
}

/** Flattens and drops null/false so conditionals can be passed straight to replaceChildren. */
export const kids = (...xs) => xs.flat(Infinity).filter((x) => x != null && x !== false);

const SVGNS = "http://www.w3.org/2000/svg";
export function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}

export const pct = (x) => `${Math.round((x ?? 0) * 100)}%`;
export const fmt = (n) => (n == null ? "—" : n >= 10000 ? `${(n / 1000).toFixed(1)}K` : n.toLocaleString());
export const esc = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export const clip = (x, n) => (x && x.length > n ? x.slice(0, n - 1) + "…" : x ?? "");
export const human = (k) => String(k ?? "").replace(/_/g, " ");

/** Parses JSON that is still being written: closes the open string, drops a dangling key or partial
 *  token, and closes every open bracket. Returns null until there is something parseable. */
export function parsePartialJSON(t) {
  const stack = [];
  let inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") stack.pop();
  }
  let s = t.trimEnd();
  if (inStr) s = (esc ? s.slice(0, -1) : s) + '"';
  const close = stack.reverse().join("");
  const trims = [(x) => x, (x) => x.replace(/,\s*$/, ""), (x) => x.replace(/,?\s*"(?:[^"\\]|\\.)*"\s*:\s*$/, ""), (x) => x.replace(/,?\s*"(?:[^"\\]|\\.)*"\s*$/, ""), (x) => x.replace(/,?\s*[-\w.]+\s*$/, "")];
  for (let k = 0; k < 6; k++) {
    for (const f of trims) { try { return JSON.parse(f(s) + close); } catch {} }
    s = s.replace(/,?\s*(?:"(?:[^"\\]|\\.)*"|[-\w.]+)\s*:?\s*$/, "");
  }
  return null;
}

/** The decision model's display name ("Jev" or "OpenAI Decisions"), set from the server at boot. */
export const ENGINE = { name: "Jev" };

export const SHORT = {};
export const short = (id) => SHORT[id] ?? id;

// Categorical slots, dark steps (validated against the app surface). Fixed order, never cycled.
export const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
export const OTHER = "#4a515c";
// Sequential blue for magnitude on a dark surface: low recedes toward the surface.
const SEQ = ["#16243a", "#184f95", "#2a78d6", "#6da7ec", "#b7d3f6"];
export function seq(t) {
  const x = Math.max(0, Math.min(1, t)) * (SEQ.length - 1);
  const i = Math.min(SEQ.length - 2, Math.floor(x));
  const f = x - i;
  const a = SEQ[i].match(/\w\w/g).map((c) => parseInt(c, 16));
  const b = SEQ[i + 1].match(/\w\w/g).map((c) => parseInt(c, 16));
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(",")})`;
}
export const inkOn = (rgb) => {
  const [r, g, b] = rgb.match(/\d+/g).map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.55 ? "#0b0d12" : "#f3f5f8";
};

// One tooltip for the whole app.
let tip;
export function showTip(e, html) {
  tip ??= document.body.appendChild(h("div", { class: "tip" }));
  tip.innerHTML = html;
  tip.hidden = false;
  const pad = 14;
  const r = tip.getBoundingClientRect();
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
  tip.style.transform = `translate(${x}px, ${y}px)`;
}
export const hideTip = () => tip && (tip.hidden = true);
export const tipHandlers = (html) => ({ onmousemove: (e) => showTip(e, typeof html === "function" ? html() : html), onmouseleave: hideTip });

export function toast(msg, kind = "err") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), 7000);
}

// Modal (used for full Jev call records)
export function openModal(eyebrow, title, body) {
  $("#mEyebrow").textContent = eyebrow;
  $("#mTitle").textContent = title;
  $("#mBody").replaceChildren(...kids(body));
  $("#mBody").scrollTop = 0;
  $("#modal").showModal();
}

// Fixed colors per structural role and modality (identity follows the category, never its rank).
export const ROLE_COLOR = {
  heading: "#c98500", body: "#3987e5", list_item: "#199e70", definition_entry: "#2bb3c0", question: "#e66767", quote: "#a7b23a", field: "#c94fc9", footnote: "#9085e9",
  table_or_figure: "#d95926", toc_entry: "#d55181", page_furniture: "#4a515c", front_matter: "#727a86",
};
export const ROLE_LABEL = {
  heading: "heading", body: "body", list_item: "list item", definition_entry: "definition", question: "question", quote: "quote", field: "field", footnote: "footnote",
  table_or_figure: "table / figure", toc_entry: "TOC entry", page_furniture: "page furniture", front_matter: "front matter",
};
/** Roles that carry substance: they get modality labels and become analysis rows. */
export const CONTENT_ROLES = new Set(["body", "list_item", "definition_entry", "question", "quote", "field"]);
export const MOD_COLOR = { must: "#3987e5", must_not: "#e66767", may: "#199e70", defines: "#9085e9", context: "#4a515c" };
export const MOD_LABEL = { must: "must", must_not: "must not", may: "may / exempt", defines: "defines", context: "context" };
export const SECROLE_FAMILY = (r) =>
  ["scope", "definitions", "requirements", "prohibitions", "exemptions", "procedures", "supervision_enforcement"].includes(r) ? "rule" :
  r === "discussion" ? "discussion" : r === "request_for_comment" ? "comment" : r === "impact_analysis" ? "impact" : "other";
export const FAMILY_COLOR = { rule: "#3987e5", discussion: "#727a86", comment: "#d55181", impact: "#d95926", other: "#4a515c" };
export const FAMILY_LABEL = { rule: "rule text", discussion: "discussion", comment: "comment request", impact: "impact analysis", other: "other" };

/** Streams an NDJSON response into a handler. */
export async function streamPost(url, body, onEvent) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
}

/** Renders a Jev call record: every predicate in the packed request, with the answer. */
export async function showCall(callId, highlight) {
  const rec = await fetch(`/api/lineage/${callId}`).then((r) => (r.ok ? r.json() : null));
  if (!rec) return toast("That call's record is no longer available.", "warn");
  const n = Object.keys(rec.questions).length;
  const ans = (a) => (!a ? "—" : a.type === "noul" ? `${pct(a.noul)} yes` : a.type === "choice" ? `${human(a.choice)} · ${pct(a.confidence)}` : `level ${Math.round(a.score)} · ${pct(a.confidence)}`);
  const q = (x) => (typeof x.instructions === "string" ? x.instructions : x.instructions?.question ?? JSON.stringify(x.instructions));
  const tgt = (x) => {
    const i = x.instructions;
    if (typeof i !== "object") return null;
    const v = i.target ?? i.text ?? i.fragment ?? i.heading?.text ?? i.heading ?? i.block?.text ?? i.left?.text ?? i.requirement_a?.text ?? i.before?.text ?? i.occurrences?.[0]?.text;
    return typeof v === "string" ? v : null;
  };
  openModal(`${ENGINE.name} call #${rec.id}`, `${rec.stage} · ${rec.target}`, [
    h("div", { class: "row wrap gap6" }, h("span", { class: "chip" }, rec.model), h("span", { class: "chip" }, rec.cached ? "served from cache" : `${rec.latencyMs} ms`), h("span", { class: "chip" }, `${fmt(rec.usage?.input_tokens)} input tokens`), h("span", { class: "chip" }, `${n} predicates in one request`), h("span", { class: "chip mono" }, `key ${rec.cacheKey}`)),
    h("p", { class: "muted small" }, `${ENGINE.name} read the shared state once and answered every question below in parallel. Each question quotes the text it is about.`),
    h("table", { class: "rec-table" }, Object.entries(rec.questions).map(([k, x]) => {
      const t = tgt(x);
      const me = highlight && (highlight(k, x) ?? false);
      return h("tr", { class: me ? "me" : "" }, h("td", { class: "k" }, k), h("td", {}, q(x), t ? h("div", { class: "muted small tgt" }, clip(t, 220)) : null), h("td", { class: "a" }, ans(rec.answers?.[k])));
    })),
  ]);
}

// The library: documents extracted by scripts/extract.py, then structured by Jev.
//
// Structuring DAG, per document (the "parsing" prong):
//   S0 stitch       PDFs only: for every block, is one of the next blocks its cut-off remainder?
//   S1 profile      whole document: what kind of document is this, who issued it, how binding, what topics
//   S2 roles        every block: heading / body / list item / definition / question / quote / footnote / ...
//   S3 levels       if heading: how deep, judged against every heading in the document
//   S4 modality     if content: must / must not / may / defines / context, plus deadline
//   A  audit        a stack of Jev checks that repair the parse, then an issue-driven loop: code measures
//                   parse health, routes every open issue to the Jev check that resolves it, applies the
//                   answers, re-measures, and rolls back any check that made things worse
//   (code)          outline assembled from headings + levels; every content block gets a section
//   S5 sections     every section: role (requirements, definitions, preamble discussion...) + topics
// Every label keeps the id of the Jev call that produced it, and every block keeps its page + bbox.
import { readFile, writeFile, readdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { yes } from "./jev.mjs";

export const TOPICS = {
  stablecoins: "Stablecoins or payment stablecoins",
  reserves_redemption: "Reserve assets, redemption, or backing of tokens",
  licensing: "Licensing, registration, charters, or approval to operate",
  custody: "Custody or safekeeping of digital assets or keys",
  aml_bsa: "Anti-money laundering, sanctions, Bank Secrecy Act, or customer identification",
  securities_status: "Whether digital assets are securities or commodities",
  market_structure: "Exchanges, brokers, trading platforms, or market structure",
  bank_activities: "What banks may do with crypto or digital assets",
  tax: "Tax treatment of digital assets",
  consumer_protection: "Consumer or investor protection, disclosures, or marketing",
};

const ROLES = {
  heading: "A heading or title that labels a part of the document",
  body: "A sentence or paragraph of the document's own substantive text, including full sentences set inside a table",
  list_item: "An item in an enumerated or bulleted list, such as (1), (A), (i), or a bullet",
  definition_entry: "A glossary, acronym, or definition-list entry: a short term followed by what it means",
  question: "A question the document poses: an FAQ or Q&A question, or a numbered question asking for public comment",
  field: "A labeled data field: a short label and its value, such as “Frequency: Annual”, “Authority: 12 U.S.C. 5901”, or “Date: March 7, 2025”",
  quote: "A block quotation, epigraph, or pull quote set apart from the document's own text, or the line attributing it",
  footnote: "A footnote or endnote, usually starting with a number and in smaller type",
  page_furniture: "Running header or footer, page number, printing code, or a short label printed in the page margin beside the text column (in_page_margin)",
  toc_entry: "A table of contents entry",
  table_or_figure: "Short table cells and column headers, chart or figure labels, figure or table titles, or data source notes",
  front_matter: "Cover page text, agency name block, contact details, signatures, or other boilerplate",
};
/** Roles that carry the document's substance: these get modality labels and become analysis rows. */
export const CONTENT_ROLES = new Set(["body", "list_item", "definition_entry", "question", "quote", "field"]);
const isContent = (role) => CONTENT_ROLES.has(role);

const LEVELS = ["Document title", "Part, title, or chapter", "Section or article", "Subsection", "Minor heading or inline label"];

const MODALITY = {
  must: "Requires someone to do something",
  must_not: "Forbids someone from doing something",
  may: "Permits something, or creates an exception or safe harbor",
  defines: "Defines what a term means",
  context: "Explanation, background, analysis, or cross-reference with no rule of its own",
};

const SECTION_ROLES = {
  scope: "States purpose, scope, or who is covered",
  definitions: "Defines terms",
  requirements: "Imposes duties on regulated parties",
  prohibitions: "Forbids conduct",
  exemptions: "Creates exceptions, exemptions, or safe harbors",
  procedures: "Application, approval, filing, or administrative procedures",
  supervision_enforcement: "Supervision, examination, enforcement, or penalties",
  discussion: "Background, rationale, or discussion rather than rule text",
  request_for_comment: "Requests public comment on questions",
  impact_analysis: "Regulatory, economic, or paperwork burden analysis",
  other: "Something else",
};

const PACK = 16;
const MAX_LEVEL = 12;
const pct = (x) => `${Math.round((x ?? 0) * 100)}%`;
const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + " …" : s ?? "");
const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
/** The top three options of a choice answer, so later checks can run a focused runoff between them. */
const topOf = (a) => (a?.probabilities ? Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, p]) => [k, r3(p)]) : null);

export const SCHEMA_INFO = { ROLES, LEVELS, MODALITY, SECTION_ROLES, TOPICS };

export class Library {
  constructor(dir) {
    this.dir = dir;
    this.docs = new Map(); // id -> { doc, structure }
  }

  async load() {
    for (const id of (await readdir(this.dir)).sort()) {
      const f = join(this.dir, id, "doc.json");
      if (!existsSync(f)) continue;
      const doc = JSON.parse(await readFile(f, "utf8"));
      const sf = join(this.dir, id, "structure.json");
      const structure = existsSync(sf) ? JSON.parse(await readFile(sf, "utf8")) : null;
      // The raw extraction stays available; the working block list is the one Jev stitched and audited.
      if (structure?.stitched?.blocks) {
        doc.raw = doc.blocks;
        doc.blocks = structure.stitched.blocks;
      }
      if (structure?.sections) for (const sec of structure.sections) sec.title = fixCaps(sec.title);
      // Builds saved before decisions were counted per stage: count them from the saved calls.
      if (structure?.metrics && structure.metrics.decisions == null) {
        const byStage = {};
        let decisions = 0;
        for (const rec of Object.values(structure.lineage ?? {})) { if (!rec) continue; const n = Object.keys(rec.questions ?? {}).length; decisions += n; byStage[rec.stage] = (byStage[rec.stage] ?? 0) + n; }
        Object.assign(structure.metrics, { decisions, byStage });
      }
      this.docs.set(id, { doc, structure });
    }
    return this;
  }

  summary() {
    return [...this.docs.values()].map(({ doc, structure: st }) => {
      const roles = {};
      if (st) for (const b of Object.values(st.blocks)) roles[b.role] = (roles[b.role] ?? 0) + 1;
      return {
        id: doc.id, title: doc.title, short: doc.short, issuer: doc.issuer, date: doc.date, format: doc.format, url: doc.url,
        pages: doc.pages.length, blocks: doc.blocks.length, rawBlocks: (doc.raw ?? doc.blocks).length, stitchedLinks: st?.stitched?.links?.length ?? 0, chars: doc.chars,
        structured: Boolean(st), profile: st?.profile ?? null,
        health: st?.health ? { before: st.health.before.total, after: st.health.after.total, verified: st.health.after.verified ?? 0 } : null,
        roles, sections: st?.sections.length ?? 0, metrics: st?.metrics ?? null,
      };
    });
  }

  /** Full document for the viewer: blocks + labels + outline (lineage stays server-side). */
  view(id) {
    const e = this.docs.get(id);
    if (!e) return null;
    const { lineage, stitched, ...st } = e.structure ?? {};
    return { doc: e.doc, structure: e.structure ? { ...st, stitched: stitched ? { links: stitched.links } : null } : null };
  }

  lineage(callId) {
    for (const { structure } of this.docs.values()) if (structure?.lineage?.[callId]) return structure.lineage[callId];
    return null;
  }

  async save(id) {
    const e = this.docs.get(id);
    // Write then rename, so an interrupted save never leaves a truncated file behind.
    const f = join(this.dir, id, "structure.json");
    await writeFile(`${f}.tmp`, JSON.stringify(e.structure));
    await rename(`${f}.tmp`, f);
  }
}

// ───────────────────────────── block features ─────────────────────────────

/** Marks blocks printed in a page margin beside the text column (public laws put notes in the outer margin:
 *  left on even pages, right on odd ones), from where multi-line body text starts and ends on each page. */
/** Text columns on a page: multi-line blocks grouped by their left (or right) edge, split wherever no block starts
 *  (ends) within 80pt. A column holds a fair share of the page's blocks and its blocks are wide (margin notes are
 *  narrow), so on a three-column Federal Register page the outer columns are text, not margin. */
function textEdge(bs, side) {
  const k = side === "left" ? 0 : 2;
  bs = [...bs].sort((a, c) => a.bbox[k] - c.bbox[k]);
  const groups = [[bs[0]]];
  for (let i = 1; i < bs.length; i++) (bs[i].bbox[k] - bs[i - 1].bbox[k] > 80 ? groups[groups.push([]) - 1] : groups[groups.length - 1]).push(bs[i]);
  const med = (xs) => xs.sort((a, c) => a - c)[Math.floor(xs.length / 2)];
  const cols = groups.filter((g) => g.length >= Math.max(2, 0.15 * bs.length) && med(g.map((b) => b.bbox[2] - b.bbox[0])) >= 110);
  const g = (side === "left" ? cols[0] : cols[cols.length - 1]) ?? bs;
  return med(g.map((b) => b.bbox[k]));
}

/** Marks blocks that sit entirely outside the text area: left of the leftmost text column, or right of the rightmost. */
function markMargins(raw) {
  const byPage = new Map();
  for (const b of raw) if (b.bbox && (b.lines ?? 1) > 1) (byPage.get(b.page) ?? byPage.set(b.page, []).get(b.page)).push(b);
  const left = new Map(), right = new Map();
  for (const [pg, bs] of byPage) { left.set(pg, textEdge(bs, "left")); right.set(pg, textEdge(bs, "right")); }
  for (const b of raw) {
    if (!b.bbox) continue;
    delete b.margin;
    if (left.has(b.page) && b.bbox[2] <= left.get(b.page) + 2) b.margin = "left";
    else if (right.has(b.page) && b.bbox[0] >= right.get(b.page) - 2 && (b.lines ?? 1) <= 3) b.margin = "right";
  }
}

/** Marks blocks right above a picture (figure and chart titles) and blocks printed on one (figure labels). */
function markGraphics(raw, doc) {
  for (const b of raw) {
    const gs = b.bbox ? doc.pages[b.page - 1]?.graphics ?? [] : [];
    if (!gs.length) continue;
    const [x0, y0, x1, y1] = b.bbox;
    const overlapX = (g) => Math.max(0, Math.min(x1, g[2]) - Math.max(x0, g[0])) >= 0.3 * Math.max(1, x1 - x0);
    if (gs.some((g) => overlapX(g) && g[1] >= y1 - 2 && g[1] - y1 <= 30)) b.graphic_below = true;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    if (gs.some((g) => cx > g[0] && cx < g[2] && cy > g[1] && cy < g[3])) b.on_graphic = true;
  }
}

function features(b) {
  const f = {};
  if (b.page) f.page = b.page;
  if (b.margin) f.in_page_margin = true;
  if (b.graphic_below) f.picture_directly_below = true;
  if (b.on_graphic) f.printed_on_a_picture = true;
  if (b.zone && b.zone !== "body") f.position = `${b.zone} of page`;
  if (b.rel_size) f.relative_font_size = b.rel_size;
  if (b.bold > 0.5) f.bold = true;
  if (b.repeats) f.repeats_on_many_pages = true;
  if (b.tag) f.html_tag = b.tag;
  if (b.in_footnotes) f.inside_footnotes_area = true;
  return f;
}

const tail = (t, n) => (t.length > n ? "…" + t.slice(-n) : t);
// Display-only repair for all-caps words split at a line wrap ("SE- CURITIES" -> "SECURITIES").
export const fixCaps = (t) => t.replace(/\b([A-Z]{1,})- ([A-Z]{2,})/g, "$1$2");
const words = (t) => t.trim().split(/\s+/).filter(Boolean).length;
const ends = (t) => /[.:;!?”"’)\]—]\s*$/.test(t.trim());

/** Joins two pieces of a block that a line wrap or page break cut apart, repairing hyphenation. */
function joinText(a, b) {
  const A = a.trimEnd(), B = b.trimStart();
  const m = A.match(/(\S+)-$/);
  if (m && /^[A-Za-z]/.test(B)) {
    const left = m[1].replace(/[^A-Za-z]/g, ""), right = (B.match(/^\S+/)?.[0] ?? "").replace(/[^A-Za-z]/g, "");
    const caps = left && right && left === left.toUpperCase() && right === right.toUpperCase();
    if (/^[a-z]/.test(B) || caps) return A.slice(0, -1) + B;
  }
  return `${A} ${B}`;
}

/** Context Jev sees for a chunk: every block on the pages it touches (PDF) or a window around it (HTML). */
function pageContext(all, chunk, max = 24000) {
  let ctx;
  if (chunk[0].page) {
    const pages = new Set(chunk.map((b) => b.page));
    ctx = all.filter((b) => pages.has(b.page)).map((b) => `[p${b.page}] ${clip(b.text, 400)}`);
  } else {
    const i0 = all.indexOf(chunk[0]);
    ctx = all.slice(Math.max(0, i0 - 12), i0 + chunk.length + 12).map((b) => clip(b.text, 400));
  }
  const out = [];
  let n = 0;
  for (const t of ctx) { if ((n += t.length) > max) break; out.push(t); }
  return out;
}

/** What a reader uses to see that two pieces belong together: same type, tight spacing, shared alignment. */
function layoutCues(a, c, doc) {
  const cue = { same_font_size_and_weight: Math.abs((a.rel_size ?? 1) - (c.rel_size ?? 1)) < 0.06 && (a.bold > 0.5) === (c.bold > 0.5) };
  if (a.bbox && c.bbox && a.page === c.page) {
    const lh = Math.max(1, (a.bbox[3] - a.bbox[1]) / Math.max(1, a.lines ?? 1));
    cue.vertical_gap_in_lines = Math.round(((c.bbox[1] - a.bbox[3]) / lh) * 10) / 10;
    const w = doc.pages[a.page - 1]?.w;
    const centered = (b) => w && Math.abs((b.bbox[0] + b.bbox[2]) / 2 - w / 2) < 0.04 * w && b.bbox[2] - b.bbox[0] < 0.75 * w;
    if (centered(a) && centered(c)) cue.both_centered_on_page = true;
  } else if (a.page && c.page && c.page !== a.page) cue.on_next_page = true;
  return cue;
}

/**
 * S0 (PDFs): the extractor cuts on font changes, gaps, and indents, so some sentences and headings
 * arrive in pieces. Jev reads each page and decides, for every block, whether one of the next three
 * blocks is its cut-off remainder (looking three ahead lets it skip margin notes and running headers).
 * A sentence that runs off the bottom of a page also gets the first text block of the next page as a
 * candidate, past the footnotes and the running header. Code merges the chains Jev confirmed; each
 * merged block keeps every original piece.
 */
async function stitch({ raw, doc, jev, run, keep, say }) {
  const links = [];
  let vetoed = 0;
  const idx = new Map(raw.map((b, i) => [b.id, i]));
  const bodySized = (b) => (b.rel_size ?? 1) >= 0.95 && b.zone === "body" && !b.margin;
  say({ t: "lib_stage", stage: "S0", status: "running", total: raw.length });
  await Promise.all(chunks(raw.map((b, i) => i), 12).map(async (ixs) => {
    const chunk = ixs.map((i) => raw[i]);
    const pages = new Set(chunk.map((b) => b.page));
    const next = Math.max(...pages) + 1;
    const ctx = pageContext(raw, chunk).concat(raw.filter((b) => b.page === next).slice(0, 5).map((b) => `[p${b.page}] ${clip(b.text, 400)}`));
    const qs = {};
    const candsOf = [];
    ixs.forEach((k, i) => {
      const cands = raw.slice(k + 1, k + 4);
      const b = raw[k];
      if (!ends(b.text) && bodySized(b) && !raw.slice(k + 1).some((c) => c.page === b.page && bodySized(c))) {
        const carry = raw.find((c, j) => j > k && c.page === b.page + 1 && bodySized(c) && !c.repeats);
        if (carry && !cands.includes(carry)) cands.push(carry);
      }
      candsOf[i] = cands;
      if (!cands.length) return;
      const crit = { none: "None: `block` is a complete unit, or every candidate begins its own new item, paragraph, heading, list entry, or footnote" };
      cands.forEach((c, j) => (crit[`next${j + 1}`] = `Candidate ${j + 1} is the cut-off remainder of \`block\`: the block stops mid-sentence, mid-word, or mid-heading and this candidate picks up exactly where it stopped. A candidate that begins with its own enumerator such as (A), (i), (1), 1., or a bullet, or that is a new heading, is never a remainder, except when \`block\` ends with a word that introduces that number, like TITLE, PART, SEC., or Section. A heading that wraps onto several lines is one heading`));
      qs[`s__${i}`] = { type: "choice", criteria: crit, instructions: {
        question: "When this PDF was split into blocks, some sentences and headings were cut in two at line wraps, small-caps changes, page breaks, or around margin notes. Is one of the candidates the cut-off remainder of `block`? Separate list items that continue a sentence grammatically are NOT remainders. Use `page_text` to see the layout.",
        block: { text: tail(b.text, 500), ...features(b) },
        candidates: cands.map((c, j) => ({ candidate: j + 1, text: clip(c.text, 300), ...features(c), ...layoutCues(b, c, doc) })),
      } };
    });
    if (!Object.keys(qs).length) return;
    const rec = await run.call(jev, { stage: "S0 stitch", target: `${doc.id}#${ixs[0]}`, state: { document: doc.title, page_text: ctx }, questions: qs, meta: { doc: doc.id, blocks: chunk.map((b) => b.id) } });
    keep(rec);
    const found = [];
    ixs.forEach((k, i) => {
      const a = rec?.answers?.[`s__${i}`];
      if (a && a.choice !== "none") {
        const to = candsOf[i][Number(a.choice.slice(4)) - 1];
        if (!to) return;
        if (!joinable(raw[k], to)) { vetoed++; return; } // an enumerated item is never the remainder of its lead-in
        const l = { from: raw[k].id, to: to.id, p: a.probabilities?.[a.choice] ?? a.confidence, call: rec.id };
        links.push(l);
        found.push(l);
      }
    });
    say({ t: "lib_stitch", items: found, n: ixs.length });
  }));

  // Each piece can continue only one block: keep the most confident claim (ties: the earlier block). Links are
  // sorted first, so the result never depends on which Jev call happened to finish first.
  links.sort((x, y) => idx.get(x.from) - idx.get(y.from) || idx.get(x.to) - idx.get(y.to));
  const into = new Map();
  for (const l of links) if (!into.has(l.to) || into.get(l.to).p < l.p) into.set(l.to, l);
  const next = new Map([...into.values()].map((l) => [l.from, l]));
  const blocks = [];
  for (const b of raw) {
    if (into.has(b.id)) continue; // already part of an earlier chain
    const chain = [b];
    const used = [];
    let cur = b;
    while (next.has(cur.id)) {
      const l = next.get(cur.id);
      used.push(l);
      cur = raw[idx.get(l.to)];
      chain.push(cur);
    }
    if (chain.length === 1) { blocks.push({ ...b, parts: [{ id: b.id, page: b.page, bbox: b.bbox }] }); continue; }
    blocks.push({
      ...b,
      text: chain.slice(1).reduce((t, c) => joinText(t, c.text), b.text),
      parts: chain.map((c) => ({ id: c.id, page: c.page, bbox: c.bbox })),
      stitched: { pieces: chain.length, links: used },
    });
  }
  say({ t: "lib_stage", stage: "S0", status: "done" });
  return { blocks, links, vetoed };
}


// ───────────────────────────── outline + parse health ─────────────────────────────

/** Outline, in code: headings open sections at their level; everything else attaches to the deepest open one. */
function buildOutline(blocks, st) {
  const sections = [];
  const stack = [];
  let cur = { id: "sec0", level: 0, title: "(before first heading)", heading: null, path: [], blocks: [], pages: new Set() };
  sections.push(cur);
  let carry = null; // bare enumerators like "II." belong to the heading that follows them
  for (const [bi, b] of blocks.entries()) {
    const lab = st.blocks[b.id];
    if (!lab) continue;
    if (lab.role === "heading" && /^([IVXLC]+|\d{1,2}|[A-Z])\.?$/.test(b.text.trim()) && st.blocks[blocks[bi + 1]?.id]?.role === "heading") {
      carry = { text: b.text.trim(), level: lab.level };
      lab.section = null;
      continue;
    }
    if (lab.role === "heading") {
      const level = carry?.level ?? lab.level ?? 2;
      const title = carry ? `${carry.text} ${b.text}` : b.text;
      carry = null;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      cur = { id: `sec${sections.length}`, level, title: clip(fixCaps(title), 160), heading: b.id, path: stack.map((x) => x.title), blocks: [], pages: new Set([b.page]) };
      sections.push(cur);
      stack.push(cur);
    } else if (lab.role !== "page_furniture") {
      cur.blocks.push(b.id);
      if (b.page) cur.pages.add(b.page);
    }
    lab.section = cur.id;
  }
  return sections.filter((x) => x.blocks.length || x.heading).map((x) => ({ ...x, pages: [...x.pages].filter(Boolean).sort((p, q) => p - q) }));
}

/** Numbering family of a heading ("SEC. N", "(a)", quoted "(1)", "1.2.1"...), so levels can be checked for consistency. */
function family(text) {
  const t = text.trim();
  const q = /^[‘'"“]/.test(t) ? "quoted " : "";
  const u = t.replace(/^[‘'"“]+/, "");
  const pats = [[/^TITLE\s+[IVXLC]+\b/i, "TITLE N"], [/^(SEC\.|SECTION)\s*\d/i, "SEC. N"], [/^PART\s+\d/i, "PART N"], [/^Subpart\s/i, "Subpart"], [/^CHAPTER\s/i, "CHAPTER N"], [/^§/, "§ N"],
    [/^\d+\.\d+\.\d+\s*\([a-z]\)/, "1.1.1(a)"], [/^\d+\.\d+\.\d+/, "1.1.1"], [/^\d+\.\d+/, "1.1"],
    [/^\((ii|iii|iv|vi|vii|viii|ix|xi|xii)\)/, "(i)"], [/^\([a-z]\)/, "(a)"], [/^\(\d+\)/, "(1)"], [/^\([A-Z]{2,}\)|^\((II|III|IV|VI)\)/, "(I)"], [/^\([A-Z]\)/, "(A)"],
    [/^[IVX]+\.\s/, "I."], [/^[A-Z]\.\s/, "A."], [/^[a-z]\.\s/, "a."], [/^\d+\.\s/, "1."]];
  for (const [re, name] of pats) if (re.test(u)) return q + name;
  return null;
}

export const ISSUE_TYPES = ["fragment", "dangling_hyphen", "empty_section", "long_heading", "numbering_conflict", "low_confidence"];

/**
 * Parse health: code-detectable symptoms of a bad parse, counted before and after the audit. An issue a
 * Jev check reviewed and confirmed as correct (a [Reserved] part is empty on purpose) stays listed, marked
 * verified with the check, probability, and call; `total` counts only open issues.
 */
export function health(blocks, st, sections) {
  const issues = [];
  const add = (type, block, detail) => {
    const v = st.blocks[block]?.verified?.[type];
    issues.push(v ? { type, block, detail, verified: v } : detail ? { type, block, detail } : { type, block });
  };
  const isShortItem = (b) => b && st.blocks[b.id]?.role === "list_item" && words(b.text) <= 4;
  for (const [bi, b] of blocks.entries()) {
    const l = st.blocks[b.id];
    if (!l) continue;
    const t = b.text.trim();
    const inShortList = l.role === "list_item" && (isShortItem(blocks[bi - 1]) || isShortItem(blocks[bi + 1]));
    const shortTail = !inShortList && words(t) <= 3 && !/[.:;!?)\]—”’"]$/.test(t) && !/^\(?[\divxlcIVXLC]+[.)]?$/.test(t);
    if ((["body", "list_item", "footnote", "question"].includes(l.role) && shortTail) || (l.role === "heading" && /^[a-z]/.test(t) && !/^[‘'"“]*[a-z]{1,4}[.)]\s|^[‘'"“]*\([a-z]{1,4}\)/.test(t))) add("fragment", b.id);
    if (["body", "list_item", "footnote", "heading", "question", "definition_entry"].includes(l.role) && /[A-Za-z]-$/.test(t)) add("dangling_hyphen", b.id);
    if (l.role === "heading" && words(t) > 30) add("long_heading", b.id);
    if ((l.roleConf ?? 1) < 0.45) add("low_confidence", b.id);
  }
  sections.forEach((x, i) => {
    if (!x.heading || x.level === 0) return;
    const next = sections[i + 1];
    if (!x.blocks.length && (!next || next.level <= x.level)) add("empty_section", x.heading);
  });
  // A numbered heading whose level contradicts its numbering: not level with the item its number continues,
  // or not one below the open item when it starts a sequence.
  for (const [bid, p] of numberingStack(blocks, st)) {
    if (["sibling", "child", "sibling_gap"].includes(p.rel) && st.blocks[bid].level !== p.level) add("numbering_conflict", bid, `its number puts it at level ${p.level} (${p.rel === "child" ? "first item under the open one" : "next in its sequence"}), not ${st.blocks[bid].level}`);
  }
  const counts = Object.fromEntries(ISSUE_TYPES.map((k) => [k, 0]));
  counts.total = 0;
  counts.verified = 0;
  for (const i of issues) {
    if (i.verified) counts.verified++;
    else { counts[i.type]++; counts.total++; }
  }
  return { issues, counts };
}


// ───────────────────────────── labeling passes (shared by the DAG and the audit) ─────────────────────────────

const neighbor = (list, i, dir, st) => {
  for (let j = i + dir; j >= 0 && j < list.length; j += dir) if (st.blocks[list[j].id]?.role !== "page_furniture") return j;
  return -1;
};
/** Nearest neighbor a piece of text could continue into: skips page furniture, and footnotes unless the piece is one. */
const textNeighbor = (list, i, dir, st) => {
  const self = st.blocks[list[i].id]?.role;
  for (let j = i + dir; j >= 0 && j < list.length; j += dir) {
    const r = st.blocks[list[j].id]?.role;
    if (r === "page_furniture" || (r === "footnote" && self !== "footnote")) continue;
    return j;
  }
  return -1;
};
const side = (b, st, extra) => (b ? { text: clip(b.text, 240), role: st.blocks[b.id]?.role ?? "unlabeled", ...extra } : null);

// A piece that opens with its own enumerator is a new item, never the remainder of the lead-in before it
// (unless the earlier piece ends with a word that introduces that number, like TITLE or SEC.).
const ENUM = /^[‘'"“]*(\(([a-zA-Z]{1,5}|\d{1,3})\)|SEC\.\s|Sec\.\s|§\s?\d)/;
// …or a cross-reference that names it: "except as provided in subparagraph" + "(A), a permitted issuer…".
const INTRO = /(\b(TITLE|PART|SEC\.|Sec\.|SECTION|Section|Subpart|subpart|CHAPTER|Chapter)|\b(sub)?(section|paragraph|clause|subclause|item|title|part|chapter|division)s?|\((?:[a-zA-Z]{1,5}|\d{1,3})\)\s+(and|or|through)|\b\d+[A-Za-z]?(\((?:[a-zA-Z]{1,5}|\d{1,3})\))+)\s*$/;
const joinable = (a, b) => !(ENUM.test(b.text.trim()) && !INTRO.test(a.text.trim()));

async function labelRoles(cx, list, all, stage) {
  const { st, jev, run, keep, say, ask, docTitle, id } = cx;
  await Promise.all(chunks(list, PACK).map(async (chunk, ci) => {
    const r = await run.call(jev, { stage, target: `${id}#${stage}${ci}`, state: { document: docTitle, page_text: pageContext(all, chunk) },
      questions: Object.fromEntries(chunk.map((b, i) => [`role__${i}`, { type: "choice", criteria: ROLES, instructions: ask("What is this block of text? Use `page_text` to see where it sits on the page.", b) }])), meta: { doc: id, blocks: chunk.map((b) => b.id) } });
    keep(r);
    say({ t: "lib_blocks", stage: "S2", items: chunk.map((b, i) => {
      const a = r?.answers?.[`role__${i}`];
      st.blocks[b.id] = { ...(st.blocks[b.id] ?? {}), role: a?.choice ?? "body", roleConf: a?.confidence ?? 0, roleTop: topOf(a), calls: { ...(st.blocks[b.id]?.calls ?? {}), role: r?.id } };
      return { b: b.id, role: st.blocks[b.id].role, conf: st.blocks[b.id].roleConf };
    }) });
  }));
}

async function labelModality(cx, list, all, stage) {
  const { st, jev, run, keep, say, ask, docTitle, id } = cx;
  const content = list.filter((b) => isContent(st.blocks[b.id]?.role));
  for (const b of list) if (st.blocks[b.id] && !isContent(st.blocks[b.id].role)) Object.assign(st.blocks[b.id], { modality: null, deadline: null });
  await Promise.all(chunks(content, PACK).map(async (chunk, ci) => {
    const r = await run.call(jev, { stage, target: `${id}#${stage}${ci}`, state: { document: docTitle, page_text: pageContext(all, chunk) },
      questions: Object.fromEntries(chunk.flatMap((b, k) => [
        [`mod__${k}`, { type: "choice", criteria: MODALITY, instructions: ask("What does this block do? A list item that continues a sentence imposing a duty counts as that duty.", b) }],
        [`dl__${k}`, { type: "noul", instructions: ask("Does this block set a deadline, time limit, or required frequency?", b) }]])), meta: { doc: id, blocks: chunk.map((b) => b.id) } });
    keep(r);
    say({ t: "lib_blocks", stage: "S4", items: chunk.map((b, k) => {
      const a = r?.answers?.[`mod__${k}`];
      Object.assign(st.blocks[b.id], { modality: a?.choice ?? null, modConf: a?.confidence ?? null, deadline: yes(r?.answers?.[`dl__${k}`]) });
      st.blocks[b.id].calls.mod = r?.id;
      return { b: b.id, modality: st.blocks[b.id].modality, deadline: st.blocks[b.id].deadline };
    }) });
  }));
}

function outlineContext(all, st) {
  return all.filter((b) => st.blocks[b.id]?.role === "heading").slice(0, 700).map((b) => `${b.page ? `p${b.page} ` : ""}${clip(b.text, 110)}${b.rel_size ? ` [size ${b.rel_size}${b.bold > 0.5 ? ", bold" : ""}]` : b.tag ? ` [<${b.tag}>]` : ""}`);
}

const LEVEL_Q = "How high in the document's hierarchy is this heading? Compare it with `all_headings_in_order` so that headings of the same kind get the same level throughout the document. If `target_features.html_tag` is h1–h6, that is the publisher's own heading level: a deeper tag (h4 under h3) means a deeper level, and the same tag means the same level.";

async function labelLevels(cx, list, all, stage) {
  const { st, jev, run, keep, say, ask, docTitle, id } = cx;
  const heads = list.filter((b) => st.blocks[b.id]?.role === "heading");
  if (!heads.length) return;
  const ctx = outlineContext(all, st);
  await Promise.all(chunks(heads, 24).map(async (hs, ci) => {
    const r = await run.call(jev, { stage, target: `${id}#${stage}${ci}`, state: { document: docTitle, all_headings_in_order: ctx },
      questions: Object.fromEntries(hs.map((b, k) => [`level__${k}`, { type: "score", criteria: LEVELS, instructions: ask(LEVEL_Q, b) }])), meta: { doc: id, blocks: hs.map((b) => b.id) } });
    keep(r);
    say({ t: "lib_blocks", stage: "S3", items: hs.map((b, k) => {
      const a = r?.answers?.[`level__${k}`];
      Object.assign(st.blocks[b.id], { level: a ? Math.round(a.score) : 2, levelScore: a?.score ?? null });
      st.blocks[b.id].calls.level = r?.id;
      return { b: b.id, level: st.blocks[b.id].level };
    }) });
  }));
}

/** Blocks in document order, so follow-up questions are packed the same way whatever order Jev calls finish in. */
const inOrder = (list, bs) => { const pos = new Map(list.map((b, i) => [b.id, i])); return [...bs].sort((x, y) => (pos.get(x.id) ?? 0) - (pos.get(y.id) ?? 0)); };

/** After a role change: headings need a level, content needs modality, everything else loses both. */
async function relabel(cx, changed, list) {
  const { st } = cx;
  changed = inOrder(list, changed);
  await labelLevels(cx, changed.filter((b) => st.blocks[b.id]?.role === "heading" && st.blocks[b.id].level == null), list, "A relabel levels");
  await labelModality(cx, changed, list, "A relabel modality");
}

// ───────────────────────────── block surgery ─────────────────────────────

/** Merges blocks (in list order) into the first one; labels come from the longest member. */
function mergeBlocks(group, st) {
  const ordered = [...group];
  const host = ordered.reduce((x, y) => (y.text.length > x.text.length ? y : x));
  const first = ordered[0];
  const parts = ordered.flatMap((b) => b.parts ?? (b.bbox ? [{ id: b.id, page: b.page, bbox: b.bbox }] : []));
  const links = ordered.flatMap((b) => b.stitched?.links ?? []);
  const merged = { ...first, text: ordered.slice(1).reduce((t, c) => joinText(t, c.text), first.text), parts, stitched: { pieces: Math.max(parts.length, ordered.length), links, audited: true } };
  const lab = { ...st.blocks[host.id], calls: { ...(st.blocks[host.id]?.calls ?? {}) } };
  for (const b of ordered) delete st.blocks[b.id];
  st.blocks[merged.id] = lab;
  return merged;
}

/** Applies merge groups to the list: each group becomes one block at its first member's position. */
function applyMerges(list, groups, st) {
  const replaced = new Map();
  const merged = [];
  for (const g of groups) {
    if (g.length < 2 || g.some((b) => replaced.has(b.id))) continue;
    const m = mergeBlocks(g, st);
    g.forEach((b, k) => replaced.set(b.id, k === 0 ? m : null));
    merged.push({ block: m, members: g.length });
  }
  return { list: list.flatMap((b) => (replaced.has(b.id) ? (replaced.get(b.id) ? [replaced.get(b.id)] : []) : [b])), merged };
}

/** Splits a run-in heading off the text it labels. Both pieces keep the original's page position. */
function splitBlock(b, at, st, { p, call }) {
  const n = (b.splitN ?? 0) + 1;
  const hb = { ...b, id: `${b.id}h${n}`, text: b.text.slice(0, at).trim(), split: { of: b.id, part: "heading" } };
  delete hb.splitN;
  const tb = { ...b, text: b.text.slice(at).trim(), split: { of: b.id, part: "text" }, splitN: n };
  st.blocks[hb.id] = { role: "heading", roleConf: p, level: null, calls: { runin: call } };
  return [hb, tb];
}

// Run-in headings: a short title that opens a paragraph, set off by a dash or period ("(b) DEFINITIONS.—In
// this section…", "(a) General standards. —(1) …", "Risk-Reducing Features. This factor…"). Code finds the
// candidate cut; Jev decides whether it really is a heading.
const EN = String.raw`[‘'"“]*(?:\((?:[a-zA-Z]{1,6}|\d{1,3})\)\s*)`;
const RUNIN = [
  new RegExp(String.raw`^(${EN}*(?:SEC\.\s*\d+[A-Za-z]*\.\s*)?[A-Z][A-Z0-9 ,;:'’‘“”\-–/&().]*?[A-Z)]\.?\s?—)\s*\S`),
  new RegExp(String.raw`^(${EN}+[A-Z][^.—:]{2,100}?\.\s?—)\s*\S`),
  new RegExp(String.raw`^(${EN}+[A-Z][^.—:]{2,100}?\s—)\s*\S`),
  new RegExp(String.raw`^(${EN}?[A-Z][^.:;—]{2,80}?\.)\s+[A-Z(“"‘]`),
];
function runInCut(text) {
  const t = text.trim();
  for (const [k, re] of RUNIN.entries()) {
    const m = t.match(re);
    if (!m) continue;
    const head = m[1];
    const rest = t.slice(head.length).trim();
    // The text after a run-in heading reads as ordinary prose ("TITLE I—DEFINITIONS; RULEMAKING" is one heading).
    if (words(rest) < 4 || words(head) > 16 || !/[a-z]/.test(rest.slice(0, 40))) continue;
    if (k === 3) {
      // Period-delimited titles must look like titles: short, and either numbered or mostly capitalized.
      const numbered = /^[‘'"“]*\(/.test(head);
      const ws = head.replace(/^[‘'"“]*\(.*?\)\s*/, "").replace(/\.$/, "").split(/\s+/).filter((w) => w.length > 3);
      if (words(head) > (numbered ? 9 : 10) || !ws.length || /\d{4}|U\.S\.C|CFR|§/.test(head)) continue;
      if (!numbered && ws.filter((w) => /^[A-Z]/.test(w)).length / ws.length < 0.6) continue;
    }
    return head.length;
  }
  return null;
}
/** Legislative drafting convention: an all-caps title ending in ".—" with text after it is always a run-in heading. */
const conventionalRunIn = (text) => { const m = text.trim().match(RUNIN[0]); return Boolean(m) && runInCut(text) === m[1].length; };

/** Candidate places a long "heading" could end, for the split question. */
function cutPoints(text) {
  const pts = new Set();
  const rc = runInCut(text);
  if (rc) pts.add(rc);
  for (const re of [/\.\s?—/g, /—(?=[A-Z(])/g, /:\s/g, /\.\s(?=[A-Z(“"‘])/g]) {
    let m;
    while ((m = re.exec(text))) {
      const at = m.index + m[0].length;
      if (at > 3 && text.length - at > 20 && words(text.slice(0, at)) <= 25) pts.add(at);
    }
  }
  return [...pts].sort((a, b) => a - b).slice(0, 4);
}

// ───────────────────────────── A: audit & repair ─────────────────────────────

function newAudit(cx) {
  const audit = { checks: [], fixes: [], loop: [] };
  cx.st.audit = audit;
  return {
    audit,
    check(cid, label, detail) {
      const c = { id: cid, label, detail, examined: 0, flagged: 0, fixed: 0 };
      audit.checks.push(c);
      return c;
    },
    /** One fix record; `n` when a single record covers several changes (a pass that re-levels many headings). */
    fix(c, f, n = 1) { c.fixed += n; audit.fixes.push({ check: c.id, ...f, ...(n > 1 ? { count: n } : {}) }); },
    /** Jev reviewed a flagged issue and confirmed the parse is right as it is. */
    verify(c, block, type, p, call, note) {
      const l = cx.st.blocks[block];
      if (!l) return;
      (l.verified ??= {})[type] = { check: c.id, p: r3(p), call, note };
      c.verified = (c.verified ?? 0) + 1;
      audit.fixes.push({ check: c.id, block, verified: type, detail: note });
    },
    report(c) { cx.say({ t: "lib_audit", check: c }); },
  };
}

/** R3: re-verify every stitch from a second angle; cut the seams Jev now rejects. */
async function checkSeams(cx, A, list) {
  const { doc, st, raw, jev, run, keep, docTitle, id } = cx;
  const rawById = new Map(raw.map((b) => [b.id, b]));
  const c = A.check("R3", "Re-verify every stitch", "Each seam is asked again as a yes/no question; seams below 35% are cut");
  const seams = [];
  for (const b of list) b.stitched?.links?.forEach((l, k) => seams.push({ b, k, l }));
  c.examined = seams.length;
  const cut = new Map(); // block id -> Set(link index)
  await Promise.all(chunks(seams, PACK).map(async (sm, ci) => {
    const qs = {};
    sm.forEach(({ l }, i) => {
      const P = rawById.get(l.from), N = rawById.get(l.to);
      qs[`seam__${i}`] = { type: "noul", instructions: { question: "Is `after` the direct continuation of `before`: the same sentence, heading, list item, or footnote cut at a line wrap, page break, or around a margin note? Answer no if `after` is a separate item, heading, or paragraph that merely follows.", before: { text: tail(P.text, 300), ...features(P) }, after: { text: clip(N.text, 300), ...features(N), ...layoutCues(P, N, doc) } } };
    });
    const r = await run.call(jev, { stage: "A R3 seams", target: `${id}#seam${ci}`, state: { document: docTitle, page_text: pageContext(raw, sm.map(({ l }) => rawById.get(l.from))) }, questions: qs, meta: { doc: id } });
    keep(r);
    sm.forEach((x, i) => {
      const p = yes(r?.answers?.[`seam__${i}`]);
      if (p < 0.35) { c.flagged++; (cut.get(x.b.id) ?? cut.set(x.b.id, new Set()).get(x.b.id)).add(x.k); x.l.recheck = { p, call: r?.id }; }
    });
  }));
  const fresh = [];
  list = list.flatMap((b) => {
    const ks = cut.get(b.id);
    if (!ks) return [b];
    const lab = st.blocks[b.id];
    const segs = [];
    let curParts = [b.parts[0]], curLinks = [];
    b.stitched.links.forEach((l, k) => {
      if (ks.has(k)) { segs.push({ parts: curParts, links: curLinks }); curParts = [b.parts[k + 1]]; curLinks = []; }
      else { curParts.push(b.parts[k + 1]); curLinks.push(l); }
    });
    segs.push({ parts: curParts, links: curLinks });
    return segs.map((sg, si) => {
      const pieces = sg.parts.map((pt) => rawById.get(pt.id));
      const nb = { ...pieces[0], text: pieces.slice(1).reduce((t, x) => joinText(t, x.text), pieces[0].text), parts: sg.parts, stitched: sg.parts.length > 1 ? { pieces: sg.parts.length, links: sg.links } : undefined };
      if (si === 0) { st.blocks[nb.id] = lab; if (isContent(lab?.role)) fresh.push({ b: nb, mod: true }); }
      else fresh.push({ b: nb, role: true });
      A.fix(c, { block: nb.id, detail: `cut a stitch that failed re-verification (${pct([...ks].map((k) => b.stitched.links[k].recheck?.p ?? 0)[0])})` });
      return nb;
    });
  });
  await labelRoles(cx, fresh.filter((x) => x.role).map((x) => x.b), list, "A relabel roles");
  await relabel(cx, fresh.map((x) => x.b), list);
  A.report(c);
  return list;
}

/** R1 + R2: is this block a fragment of a neighbor? If so, which one? Then merge. */
async function checkFragments(cx, A, list) {
  const { doc, st, jev, run, keep, docTitle, id } = cx;
  const c1 = A.check("R1", "Find fragments", "Every block, with both neighbors and layout cues in view: is it an incomplete piece of a neighboring block?");
  const c2 = A.check("R2", "Attach fragments", "For each fragment: does it belong with the previous block or the next one? Options a structural rule forbids are never offered (an enumerated item is never the remainder of the lead-in before it)");
  const idx = list.map((b, i) => i).filter((i) => st.blocks[list[i].id]?.role !== "page_furniture");
  c1.examined = idx.length;
  const frag = [];
  const ctxOf = (i) => {
    const pi = textNeighbor(list, i, -1, st), ni = textNeighbor(list, i, 1, st);
    return { pi, ni, prev: side(list[pi], st, pi >= 0 ? layoutCues(list[pi], list[i], doc) : {}), next: side(list[ni], st, ni >= 0 ? layoutCues(list[i], list[ni], doc) : {}) };
  };
  await Promise.all(chunks(idx, PACK).map(async (ix, ci) => {
    const qs = {};
    ix.forEach((i, k) => {
      const { prev, next } = ctxOf(i);
      qs[`frag__${k}`] = { type: "noul", instructions: { question: "Is `target` an incomplete fragment: a piece of a heading, sentence, list item, or footnote whose other part is the previous or next block (for example a heading that wrapped onto two lines, or the tail of a sentence)? Answer no for complete units, page numbers, and short labels that stand on their own. A lead-in that ends with a dash or colon and introduces enumerated items such as (A), (i), or (1) is complete: those items are separate units.", target: clip(list[i].text, 600), target_features: { ...features(list[i]), role: st.blocks[list[i].id]?.role }, previous: prev, next } };
    });
    const r = await run.call(jev, { stage: "A R1 fragments", target: `${id}#frag${ci}`, state: { document: docTitle, page_text: pageContext(list, ix.map((i) => list[i])) }, questions: qs, meta: { doc: id } });
    keep(r);
    ix.forEach((i, k) => { if (yes(r?.answers?.[`frag__${k}`]) >= 0.5) frag.push({ i, p: yes(r.answers[`frag__${k}`]), call: r.id }); });
  }));
  frag.sort((x, y) => x.i - y.i);
  c1.flagged = frag.length;
  A.report(c1);
  c2.examined = frag.length;
  const join = []; // [i, j] pairs to merge (i < j)
  let removed = 0;
  await Promise.all(chunks(frag, PACK).map(async (fr, ci) => {
    const qs = {};
    const plan = [];
    fr.forEach(({ i }, k) => {
      const { pi, ni, prev, next } = ctxOf(i);
      const crit = {};
      if (pi >= 0 && joinable(list[pi], list[i])) crit.previous = "It continues or completes the previous block (the previous block is cut off and this is the rest)";
      if (ni >= 0 && joinable(list[i], list[ni])) crit.next = "The next block continues or completes it (this is cut off and the next block is the rest)";
      removed += (pi >= 0 && !crit.previous ? 1 : 0) + (ni >= 0 && !crit.next ? 1 : 0);
      if (!crit.previous && !crit.next) return;
      crit.neither = "Neither neighbor: it stands alone";
      qs[`att__${k}`] = { type: "choice", criteria: crit, instructions: { question: "`fragment` was judged to be an incomplete piece. Which neighbor is its other part?", fragment: clip(list[i].text, 600), fragment_features: features(list[i]), previous: prev, next } };
      plan.push([k, i, pi, ni]);
    });
    if (!plan.length) return;
    const r = await run.call(jev, { stage: "A R2 attach", target: `${id}#att${ci}`, state: { document: docTitle, page_text: pageContext(list, fr.map(({ i }) => list[i])) }, questions: qs, meta: { doc: id } });
    keep(r);
    for (const [k, i, pi, ni] of plan) {
      const a = r?.answers?.[`att__${k}`];
      if (a?.choice === "previous") join.push([pi, i]);
      if (a?.choice === "next") join.push([i, ni]);
    }
  }));
  c2.detail += ` (${removed} options removed by that rule)`;
  // Union the joins into groups (in list order), capped to keep merges local.
  const parent = list.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const [i, j] of join) parent[find(j)] = find(i);
  const groups = new Map();
  list.forEach((_, i) => { const r0 = find(i); (groups.get(r0) ?? groups.set(r0, []).get(r0)).push(i); });
  const gs = [...groups.values()].filter((g) => g.length >= 2 && g.length <= 8).map((g) => g.sort((x, y) => x - y).map((i) => list[i]).filter((b) => st.blocks[b.id]?.role !== "page_furniture"));
  const res = applyMerges(list, gs, st);
  for (const m of res.merged) A.fix(c2, { block: m.block.id, detail: `joined ${m.members} pieces: “${clip(m.block.text, 90)}”` });
  await labelModality(cx, res.merged.map((m) => m.block), res.list, "A relabel modality");
  A.report(c2);
  return res.list;
}

/** R4: a second opinion on doubtful roles, with the neighbors' labels in view. */
async function checkRoles(cx, A, list) {
  const { st, jev, run, keep, docTitle, id } = cx;
  const c = A.check("R4", "Second opinion on doubtful roles", "Low-confidence roles and anomalies (30-word headings, headings in the page margins or repeated on many pages, headings in list markup, body-sized footnotes, body text that repeats on every page) are asked again with the neighbors' labels in view");
  const suspects = list.map((b, i) => i).filter((i) => {
    const b = list[i], l = st.blocks[b.id];
    if (!l) return false;
    return (l.roleConf ?? 1) < 0.5 || (l.role === "heading" && words(b.text) > 30) || (l.role === "heading" && (b.repeats || b.margin || b.zone === "top" || b.zone === "bottom" || ["dt", "dd", "li"].includes(b.tag))) || (l.role === "footnote" && b.zone === "body" && (b.rel_size ?? 0) >= 0.95 && !/^[\[\d*†]/.test(b.text.trim())) || (isContent(l.role) && b.repeats);
  });
  c.examined = suspects.length;
  const changed = [];
  await Promise.all(chunks(suspects, PACK).map(async (ix, ci) => {
    const qs = {};
    ix.forEach((i, k) => {
      const pi = neighbor(list, i, -1, st), ni = neighbor(list, i, 1, st);
      qs[`role__${k}`] = { type: "choice", criteria: ROLES, instructions: { question: "What is `target`? Its neighbors are shown with the roles already assigned to them; use them and `page_text` to decide.", target: clip(list[i].text, 800), target_features: features(list[i]), previous: side(list[pi], st), next: side(list[ni], st) } };
    });
    const r = await run.call(jev, { stage: "A R4 roles", target: `${id}#r4${ci}`, state: { document: docTitle, page_text: pageContext(list, ix.map((i) => list[i])) }, questions: qs, meta: { doc: id } });
    keep(r);
    ix.forEach((i, k) => {
      const a = r?.answers?.[`role__${k}`];
      const l = st.blocks[list[i].id];
      if (!a) return;
      if (a.choice !== l.role) c.flagged++;
      if (a.choice !== l.role && (a.confidence ?? 0) >= (l.roleConf ?? 0)) {
        A.fix(c, { block: list[i].id, detail: `${l.role} → ${a.choice} (${pct(l.roleConf)} → ${pct(a.confidence)})` });
        Object.assign(l, { role: a.choice, roleConf: a.confidence, roleTop: topOf(a), roleWas: l.role });
        if (a.choice === "heading" && l.roleWas !== "heading") l.level = null;
        l.calls.role = r.id;
        changed.push(list[i]);
      } else if (a.choice === l.role && (a.confidence ?? 0) > (l.roleConf ?? 0)) Object.assign(l, { roleConf: a.confidence, roleTop: topOf(a) });
    });
  }));
  await relabel(cx, changed, list);
  A.report(c);
  return list;
}

/** R13: running headers and footers. The same line printed at a page edge on a run of pages is decided once,
 *  for the whole group, with every page it appears on in view: a per-block question can't see the pattern. */
async function checkRunningHeads(cx, A, list) {
  const { st, jev, run, keep, docTitle, id } = cx;
  const c = A.check("R13", "Running headers and footers", "Lines repeated at the top or bottom edge of many pages are judged once per group, with all their pages in view: running header or footer, or document content?");
  const norm = (t) => t.toLowerCase().replace(/\d+/g, "#").replace(/[\s\ufeff]+/g, " ").trim().slice(0, 80);
  const groups = new Map();
  for (const b of list) if (b.repeats && b.zone !== "body") { const k = `${b.zone}|${norm(b.text)}`; (groups.get(k) ?? groups.set(k, []).get(k)).push(b); }
  const todo = [...groups.values()].filter((g) => g.some((b) => st.blocks[b.id] && st.blocks[b.id].role !== "page_furniture"));
  c.examined = todo.length;
  await Promise.all(chunks(todo, PACK).map(async (gs, ci) => {
    const r = await run.call(jev, { stage: "A R13 running heads", target: `${id}#r13-${ci}`, state: { document: docTitle },
      questions: Object.fromEntries(gs.map((g, k) => {
        const pages = g.map((b) => b.page);
        return [`rh__${k}`, { type: "noul", instructions: { question: "This same line is printed at the edge of every page listed. Is it a running header or footer (a page label repeated across pages), rather than a heading or text that belongs where it stands?", text: clip(g[0].text, 200), edge: g[0].zone, printed_on_pages: pages.length > 12 ? `${pages.length} pages, ${pages[0]}–${pages[pages.length - 1]}` : pages.join(", "), current_labels: [...new Set(g.map((b) => st.blocks[b.id]?.role))].join(", ") } }];
      })), meta: { doc: id } });
    keep(r);
    gs.forEach((g, k) => {
      const p = yes(r?.answers?.[`rh__${k}`]);
      if (p < 0.6) return;
      c.flagged++;
      let n = 0;
      for (const b of g) {
        const l = st.blocks[b.id];
        if (!l || l.role === "page_furniture") continue;
        Object.assign(l, { roleWas: l.role, role: "page_furniture", roleConf: p, roleTop: null, level: null, modality: null, deadline: null });
        l.calls.running = r.id;
        n++;
      }
      if (n) A.fix(c, { block: g[0].id, detail: `“${clip(g[0].text, 50)}” on ${g.length} pages is a running ${g[0].zone === "top" ? "header" : "footer"}: ${n} block${n > 1 ? "s" : ""} relabeled (${pct(p)})` });
    });
  }));
  A.report(c);
  return list;
}

/** R8: rows. Cells printed side by side on one line (glossaries, tables, <dt>/<dd> pairs) arrive as separate
 *  blocks, often far apart in reading order when a table is read column by column. Code finds every line that
 *  holds a short cell with others beside it; Jev decides whether it is one glossary entry, one table row, or
 *  unrelated text that happens to share a line. Rows are rebuilt left to right. */
async function checkRows(cx, A, list) {
  const { st, jev, run, keep, docTitle, id } = cx;
  const c = A.check("R8", "Rebuild rows", "Short cells with other cells beside them on the same printed line (or <dt>/<dd> pairs): one glossary entry, one table row, a margin paragraph number and its paragraph, or separate?");
  // Cells can be mislabeled page furniture (a column of short codes); only the page edges are ruled out.
  const usable = (b) => b.bbox && b.zone === "body" && st.blocks[b.id]?.role !== "footnote";
  const vOverlap = (a, b) => Math.min(a.bbox[3], b.bbox[3]) - Math.max(a.bbox[1], b.bbox[1]) > 0.4 * Math.min(a.bbox[3] - a.bbox[1], b.bbox[3] - b.bbox[1]);
  const cands = [];
  const taken = new Set();
  const byPage = new Map();
  list.forEach((b) => { if (usable(b)) (byPage.get(b.page) ?? byPage.set(b.page, []).get(b.page)).push(b); });
  for (const bs of byPage.values()) {
    const sorted = [...bs].sort((a, b) => a.bbox[0] - b.bbox[0]);
    for (const a of sorted) {
      if (taken.has(a.id) || words(a.text) > 8) continue;
      // The cells to its right on the same line, left to right, not overlapping each other.
      const row = [a];
      for (const b of sorted) {
        if (b === a || taken.has(b.id) || !vOverlap(a, b) || b.bbox[0] < row[row.length - 1].bbox[2] - 2) continue;
        row.push(b);
        if (row.length >= 5) break;
      }
      if (row.length < 2) continue;
      row.forEach((b) => taken.add(b.id));
      cands.push(row);
    }
  }
  for (let i = 0; i + 1 < list.length; i++) if (list[i].tag === "dt" && list[i + 1].tag === "dd" && !taken.has(list[i].id)) cands.push([list[i], list[i + 1]]);
  c.examined = cands.length;
  const ok = [];
  await Promise.all(chunks(cands, PACK).map(async (rows, ci) => {
    const r = await run.call(jev, { stage: "A R8 rows", target: `${id}#r8${ci}`, state: { document: docTitle, page_text: pageContext(list, rows.map((x) => x[0])) },
      questions: Object.fromEntries(rows.map((cells, k) => [`row__${k}`, { type: "choice", criteria: {
        glossary_entry: "A term or acronym and what it means: one glossary or definition-list entry",
        table_row: "Cells of one row of a table",
        paragraph_number: "The first piece is the number of the paragraph beside it (paragraph numbers printed in the margin)",
        separate: "Separate pieces that only happen to sit on the same line",
      }, instructions: { question: "These pieces sit side by side on the same printed line, left to right. Are they one entry?", cells: cells.map((b) => ({ text: clip(b.text, 220), role: st.blocks[b.id]?.role, ...features(b) })) } }])), meta: { doc: id } });
    keep(r);
    // Jev's confidence is its margin over the runner-up; the decision uses the chosen option's probability.
    rows.forEach((cells, k) => { const a = r?.answers?.[`row__${k}`]; const p = a?.probabilities?.[a?.choice] ?? a?.confidence ?? 0; if (a && a.choice !== "separate" && p >= 0.5) ok.push({ cells, kind: a.choice, p, call: r.id }); });
  }));
  c.flagged = ok.length;
  const pos = new Map(list.map((b, i) => [b.id, i]));
  ok.sort((x, y) => Math.min(...x.cells.map((b) => pos.get(b.id))) - Math.min(...y.cells.map((b) => pos.get(b.id))));
  const replaced = new Map();
  for (const { cells, kind, p, call } of ok) {
    if (cells.some((b) => replaced.has(b.id))) continue;
    // The row sits where its first cell (in reading order) was.
    const ordered = [...cells].sort((a, b) => pos.get(a.id) - pos.get(b.id));
    const merged = mergeBlocks(ordered, st);
    merged.text = cells.map((b) => b.text.trim()).join(kind === "glossary_entry" ? " — " : kind === "paragraph_number" ? " " : " | ");
    const sentence = cells.some((b) => words(b.text) >= 8 && /[a-z]/.test(b.text));
    const hostRole = st.blocks[merged.id]?.role;
    const role = kind === "paragraph_number" ? (isContent(hostRole) || hostRole === "heading" ? hostRole : "body") : kind === "glossary_entry" ? (hostRole === "toc_entry" ? "toc_entry" : "definition_entry") : sentence ? "body" : "table_or_figure";
    st.blocks[merged.id] = { ...st.blocks[merged.id], role, roleConf: kind === "paragraph_number" ? Math.max(p, st.blocks[merged.id]?.roleConf ?? 0) : p, roleTop: kind === "paragraph_number" ? st.blocks[merged.id]?.roleTop ?? null : null, modality: role === "definition_entry" ? "defines" : isContent(role) ? st.blocks[merged.id]?.modality ?? null : null, level: role === "heading" ? st.blocks[merged.id]?.level ?? null : null, row: { cells: cells.length, kind } };
    st.blocks[merged.id].calls.row = call;
    ordered.forEach((b, k) => replaced.set(b.id, k === 0 ? merged : null));
    A.fix(c, { block: merged.id, detail: kind === "paragraph_number" ? `paragraph number joined to its paragraph: “${clip(merged.text, 90)}”` : `${kind.replace("_", " ")} (${cells.length} cells): “${clip(merged.text, 90)}”` });
  }
  A.report(c);
  return list.flatMap((b) => (replaced.has(b.id) ? (replaced.get(b.id) ? [replaced.get(b.id)] : []) : [b]));
}

/** Core of a title for spotting repeats: no page numbers or glued footnote marks, and "CHAPTER II X" reads as
 *  "II. X". The numbering stays: "H. Conclusion" and "5. Conclusion" are different sections. */
function coreTitle(t) {
  let s = t.toLowerCase().replace(/[\s.·…]+\d+\s*$/, "");
  s = s.replace(/\bchapter\s+([ivxlc\d]+)\b\.?/g, "$1.");
  s = s.replace(/^\s*([ivxlc\d]+\.)\s*(.*?)\s+\1\s*/, "$1 $2 ");
  s = s.replace(/([a-z])\d{1,3}\b/g, "$1");
  s = s.replace(/[^a-z0-9§()]+/g, " ").trim();
  // Text printed twice ("Introduction Introduction", "IV. Banking … Banking …") counts once.
  const w = s.split(" ");
  const head = w.length > 2 && /^([ivxlc]+|\d+|[a-z])$/.test(w[0]) ? 1 : 0;
  const rest = w.slice(head);
  if (rest.length >= 2 && rest.length % 2 === 0 && rest.slice(0, rest.length / 2).join(" ") === rest.slice(rest.length / 2).join(" ")) s = [...w.slice(0, head), ...rest.slice(0, rest.length / 2)].join(" ");
  return s;
}

/**
 * R9: a heading whose text appears more than once (Federal Register preambles list every heading up front;
 * reports print a chapter title twice on its opening page and again atop the first text page). One
 * comparative question per group: which occurrence is the real heading? Copies right next to it are
 * renderings of the same title and fold into it; copies elsewhere become contents entries or running headers.
 */
async function checkRepeats(cx, A, list) {
  const { st, jev, run, keep, docTitle, id } = cx;
  const c = A.check("R9", "Repeated headings", "Headings whose title occurs more than once (ignoring numbering, chapter labels, and page numbers): Jev compares all occurrences side by side and picks the real heading; nearby copies fold into it, distant ones become contents entries or running headers");
  // A bare label ("CHAPTER II", "PART 3") next to a heading with the same number is part of that title (code).
  const LABEL = /^(CHAPTER|PART|TITLE|ARTICLE|SECTION|ANNEX|APPENDIX)\s+([IVXLC]+|\d+|[A-Z])\.?$/i;
  const numOf = (t) => t.trim().match(/^(?:(?:CHAPTER|PART|TITLE|ARTICLE|SECTION|ANNEX|APPENDIX)\s+)?([IVXLC]+|\d+|[A-Z])[.:\s—-]/i)?.[1]?.toUpperCase();
  const folded = new Set();
  list.forEach((b, i) => {
    const m = b.text.trim().match(LABEL);
    if (!m || st.blocks[b.id]?.role !== "heading") return;
    for (const j of [neighbor(list, i, -1, st), neighbor(list, i, 1, st)]) {
      const h = list[j];
      if (!h || folded.has(h.id) || st.blocks[h.id]?.role !== "heading" || h.page !== b.page || numOf(`${h.text} `) !== m[2].toUpperCase()) continue;
      if (b.parts || b.bbox) h.parts = [...(h.parts ?? []), ...(b.parts ?? [{ id: b.id, page: b.page, bbox: b.bbox }])];
      h.duplicates = [...(h.duplicates ?? []), { id: b.id, text: b.text }];
      folded.add(b.id);
      delete st.blocks[b.id];
      A.fix(c, { block: h.id, detail: `bare label “${b.text.trim()}” is part of this title: folded in` });
      break;
    }
  });
  list = list.filter((b) => !folded.has(b.id));
  // A bare number on its own line ("b.", "II.", "(c)") is the start of the heading after it (code).
  const bare = [];
  list.forEach((b, i) => {
    if (st.blocks[b.id]?.role !== "heading" || !/^[‘'"“]*(\(?[a-zA-Z0-9]{1,4}[.)]|\([a-zA-Z0-9]{1,4}\)|\d+(\.\d+)+\.?)$/.test(b.text.trim())) return;
    const j = neighbor(list, i, 1, st);
    const h = list[j];
    if (h && st.blocks[h.id]?.role === "heading" && (h.page == null || h.page === b.page) && !bare.some((g) => g.includes(h))) bare.push([b, h]);
  });
  if (bare.length) {
    const lv = new Map(bare.map(([b, h]) => [b.id, st.blocks[h.id].level]));
    const res = applyMerges(list, bare, st);
    for (const m of res.merged) { Object.assign(st.blocks[m.block.id], { role: "heading", level: lv.get(m.block.id) ?? null }); A.fix(c, { block: m.block.id, detail: `bare number joined to its heading: “${clip(m.block.text, 60)}”` }); }
    list = res.list;
  }
  const occ = new Map();
  list.forEach((b, i) => { if (["heading", "toc_entry"].includes(st.blocks[b.id]?.role) && words(b.text) >= 2) { const k = coreTitle(b.text); if (k.length >= 4) (occ.get(k) ?? occ.set(k, []).get(k)).push(i); } });
  const tagged = (i) => /^h[1-6]$/.test(list[i].tag ?? "");
  let groups = [...occ.values()].filter((g) => g.length > 1 && g.some((i) => st.blocks[list[i].id].role === "heading"));
  c.examined = groups.length;
  // Trusted publisher markup is hard evidence: occurrences the publisher tagged as headings are headings (a rule's
  // preamble discussion and its rule text can share a title); untagged copies are contents entries or running heads.
  const byTag = cx.markup ? groups.filter((g) => g.some(tagged)) : [];
  for (const g of byTag) {
    for (const i of g) {
      const l = st.blocks[list[i].id];
      if (tagged(i)) { if (l.role !== "heading") { Object.assign(l, { roleWas: l.role, role: "heading", level: null }); A.fix(c, { block: list[i].id, detail: `“${clip(list[i].text, 60)}” is the tagged heading (restored)` }); } continue; }
      const role = list[i].zone === "top" || list[i].zone === "bottom" || list[i].repeats ? "page_furniture" : "toc_entry";
      if (l.role === role) continue;
      c.flagged++;
      Object.assign(l, { roleWas: l.role, role, roleTop: null });
      A.fix(c, { block: list[i].id, detail: `“${clip(list[i].text, 60)}” → ${role.replace("_", " ")} (the publisher tags another occurrence as the heading)` });
    }
  }
  groups = groups.filter((g) => !byTag.includes(g));
  const describe = (i) => {
    const b = list[i];
    const after = [];
    for (let j = i + 1; j < list.length && after.length < 2; j++) if (st.blocks[list[j].id]?.role !== "page_furniture") after.push({ text: clip(list[j].text, 120), role: st.blocks[list[j].id]?.role });
    return { text: clip(b.text, 160), at: `${b.page ? `page ${b.page}, ` : ""}${Math.round((100 * i) / list.length)}% of the way into the document`, ...features(b), current_role: st.blocks[b.id].role, followed_by: after };
  };

  const drop = new Set();
  await Promise.all(chunks(groups, PACK).map(async (gs, ci) => {
    const r = await run.call(jev, { stage: "A R9 repeats", target: `${id}#r9${ci}`, state: { document: docTitle, all_headings_in_order: outlineContext(list, st) },
      questions: Object.fromEntries(gs.map((g, k) => {
        const shown = g.slice(0, 6);
        const crit = Object.fromEntries(shown.map((i, n) => [`occurrence_${n + 1}`, `Occurrence ${n + 1} is the real heading: the text of that part of the document follows it`]));
        crit.several = "More than one is a real heading: the same title is reused for different parts of the document";
        crit.none = "None of them is a real heading: all are running headers or contents entries";
        return [`rep__${k}`, { type: "choice", criteria: crit, instructions: { question: "This title appears more than once. Which occurrence is the real heading that starts that part of the document? A table of contents is a run of entries near the start of the document, each followed by the next entry; the real heading appears where its part begins, later on, and may be followed by its own text or directly by its first subheading. Running headers repeat at the page edges. When several occurrences are renderings of one title close together (a chapter number line, a decorative repeat, a page title), pick the most complete one.", occurrences: shown.map((i, n) => ({ occurrence: n + 1, ...describe(i) })) } }];
      })), meta: { doc: id } });
    keep(r);
    gs.forEach((g, k) => {
      const a = r?.answers?.[`rep__${k}`];
      if (!a || a.choice === "several") return;
      const shown = g.slice(0, 6);
      const realIdx = a.choice === "none" ? -1 : Number(a.choice.split("_")[1]) - 1;
      const real = realIdx >= 0 ? shown[realIdx] : null;
      shown.forEach((i, n) => {
        const l = st.blocks[list[i].id];
        if (n === realIdx) {
          if (l.role !== "heading") { l.roleWas = l.role; l.role = "heading"; l.level = null; l.calls.repeat = r.id; A.fix(c, { block: list[i].id, detail: `“${clip(list[i].text, 60)}” is the real heading (restored)` }); }
          return;
        }
        c.flagged++;
        const near = real != null && Math.abs(i - real) <= 8 && (list[i].page == null ? Math.abs(i - real) <= 3 : Math.abs(list[i].page - list[real].page) <= 1) && st.blocks[list[i].id].role === "heading";
        if (near) {
          // Another rendering of the same title: fold its position into the real heading.
          const host = list[real];
          if (list[i].parts || list[i].bbox) host.parts = [...(host.parts ?? []), ...(list[i].parts ?? [{ id: list[i].id, page: list[i].page, bbox: list[i].bbox }])];
          host.duplicates = [...(host.duplicates ?? []), { id: list[i].id, text: list[i].text }];
          drop.add(list[i].id);
          delete st.blocks[list[i].id];
          A.fix(c, { block: host.id, detail: `“${clip(list[i].text, 60)}” is another rendering of this heading: folded in` });
          return;
        }
        const role = list[i].zone === "top" || list[i].zone === "bottom" || list[i].repeats ? "page_furniture" : "toc_entry";
        if (l.role === role) return;
        Object.assign(l, { roleWas: l.role, role, roleConf: a.confidence, roleTop: null });
        l.calls.repeat = r.id;
        A.fix(c, { block: list[i].id, detail: `“${clip(list[i].text, 60)}” → ${role.replace("_", " ")}` });
      });
    });
  }));
  list = list.filter((b) => !drop.has(b.id));
  await labelLevels(cx, list.filter((b) => st.blocks[b.id]?.role === "heading" && st.blocks[b.id].level == null), list, "A relabel levels");
  A.report(c);
  return list;
}

/** R12: split run-in headings off the text they label, so the outline sees them. Repeats on the text
 *  part, since provisions nest run-ins: "(b) Non-reserve assets. —(1) Applicable framework. —(i) A …". */
async function checkRunIns(cx, A, list) {
  const { st, jev, run, keep, docTitle, id } = cx;
  const c = A.check("R12", "Split run-in headings", "Paragraphs that open with their own title, set off by a dash or period (“(b) DEFINITIONS.—In this section…”): Jev confirms the title, code splits it off as a heading");
  const roleOk = (r) => r === "heading" || isContent(r);
  // A provision line that is only its title ("(3) MARKETING.—", "(a) Prohibitions. —") titles the text below it.
  const TITLE_ONLY = new RegExp(String.raw`^${EN}+(?:[A-Z][A-Z0-9 ,;:'’‘“”\-–/&().]*?[A-Z)]|[A-Z][^.—:]{2,100}?)\.?\s?—\s*$`);
  const titles = list.filter((b) => ["list_item", "body"].includes(st.blocks[b.id]?.role) && TITLE_ONLY.test(b.text.trim()) && words(b.text) <= 16);
  if (titles.length) {
    const changed = [];
    await Promise.all(chunks(titles, PACK).map(async (bs, ci) => {
      const r = await run.call(jev, { stage: "A R12 title lines", target: `${id}#r12t-${ci}`, state: { document: docTitle, page_text: pageContext(list, bs) },
        questions: Object.fromEntries(bs.map((b, k) => [`tl__${k}`, { type: "noul", instructions: { question: "Is `text` a heading line: the title of the provision whose text follows below it, with no text of its own?", text: clip(b.text, 300), current_role: st.blocks[b.id]?.role, ...features(b) } }])), meta: { doc: id } });
      keep(r);
      bs.forEach((b, k) => {
        const p = yes(r?.answers?.[`tl__${k}`]);
        if (p < 0.6) return;
        const l = st.blocks[b.id];
        Object.assign(l, { roleWas: l.role, role: "heading", roleConf: p, roleTop: null, level: null, modality: null, deadline: null });
        l.calls.runin = r?.id;
        changed.push(b);
        c.flagged++;
        A.fix(c, { block: b.id, detail: `title line “${clip(b.text, 60)}” is a heading (${pct(p)})` });
      });
    }));
    c.examined += titles.length;
    await labelLevels(cx, inOrder(list, changed), list, "A relabel levels");
  }
  let targets = list.filter((b) => roleOk(st.blocks[b.id]?.role) && runInCut(b.text) != null);
  let byConvention = 0;
  for (let pass = 1; pass <= 3 && targets.length; pass++) {
    c.examined += targets.length;
    const decided = new Map();
    for (const b of targets) if (conventionalRunIn(b.text)) { decided.set(b.id, { p: 1, call: null, convention: true }); byConvention++; }
    await Promise.all(chunks(targets.filter((b) => !decided.has(b.id)), PACK).map(async (bs, ci) => {
      const r = await run.call(jev, { stage: `A R12 run-ins p${pass}`, target: `${id}#r12-${pass}-${ci}`, state: { document: docTitle, page_text: pageContext(list, bs) },
        questions: Object.fromEntries(bs.map((b, k) => {
          const at = runInCut(b.text);
          return [`ri__${k}`, { type: "noul", instructions: { question: "Does `text` open with a run-in heading: a short title naming this provision or paragraph, set off by a dash or period, followed by the provision's own text? Answer yes only if `candidate_heading` is exactly that title. Answer no if it is the first sentence of ordinary text, a citation, or a definition's term inside its sentence.", text: clip(b.text, 700), candidate_heading: b.text.slice(0, at).trim(), text_after_it: clip(b.text.slice(at).trim(), 160), current_role: st.blocks[b.id]?.role, ...features(b) } }];
        })), meta: { doc: id } });
      keep(r);
      bs.forEach((b, k) => decided.set(b.id, { p: yes(r?.answers?.[`ri__${k}`]), call: r?.id }));
    }));
    const next = [];
    const fresh = [];
    list = list.flatMap((b) => {
      const d = decided.get(b.id);
      if (!d || d.p < 0.6) return [b];
      c.flagged++;
      const wasHeading = st.blocks[b.id].role === "heading";
      const [hb, tb] = splitBlock(b, runInCut(b.text), st, d);
      A.fix(c, { block: hb.id, detail: d.convention ? `split “${clip(hb.text, 70)}” off its text (drafting convention)` : `split “${clip(hb.text, 70)}” off its text (${pct(d.p)})` });
      fresh.push({ hb, tb, wasHeading });
      if (runInCut(tb.text) != null) next.push(tb);
      return [hb, tb];
    });
    // The text part of a former "heading" needs a role of its own; every text part needs fresh modality.
    await labelRoles(cx, fresh.filter((x) => x.wasHeading).map((x) => x.tb), list, "A relabel roles");
    await labelLevels(cx, fresh.map((x) => x.hb), list, "A relabel levels");
    await labelModality(cx, fresh.map((x) => x.tb), list, "A relabel modality");
    targets = next;
  }
  if (byConvention) c.detail += ` · ${byConvention} all-caps “TITLE.—” run-ins split by drafting convention without asking`;
  A.report(c);
  return list;
}

/** M1 (HTML): does the publisher's heading markup encode the outline? If so, nesting must respect it. */
async function checkMarkup(cx, A, list) {
  const { st, jev, run, keep, docTitle, id } = cx;
  cx.markup = false;
  const tagged = list.filter((b) => /^h[1-6]$/.test(b.tag ?? "") && st.blocks[b.id]?.role === "heading");
  if (cx.doc.format === "pdf" || tagged.length < 5) return;
  const c = A.check("M1", "Trust the publisher's heading tags?", "One question per HTML document: do its h1–h6 tags encode the outline? If yes, nesting answers that contradict the tags are never offered");
  const r = await run.call(jev, { stage: "A M1 markup", target: `${id}#m1`, state: { document: docTitle, tagged_headings_in_order: tagged.slice(0, 400).map((b) => `<${b.tag}> ${clip(b.text, 100)}`) },
    questions: { trust: { type: "noul", instructions: "Do the publisher's HTML heading tags in `tagged_headings_in_order` encode this document's outline, so that a deeper tag marks a deeper part of the document? Some numbering styles sharing one tag is fine." } }, meta: { doc: id } });
  keep(r);
  const p = yes(r?.answers?.trust);
  cx.markup = p >= 0.6;
  cx.st.markup = cx.markup;
  c.examined = tagged.length;
  c.flagged = cx.markup ? 0 : 1;
  c.detail += ` → ${cx.markup ? "trusted" : "not trusted"} (${pct(p)})`;
  A.report(c);
}

/**
 * R10: nesting. For every heading, Jev picks its parent from the open path above it. Code assigns parent
 * level + 1 (no depth cap). Options a hard rule rules out are never offered: a heading in the same
 * numbering style is a sibling, not a parent, and with trusted markup a deeper tag can't hold a shallower
 * one. When one option is left, code takes it without asking. Two rounds, so each round's paths reflect
 * the previous round's answers.
 */
async function checkNesting(cx, A, list, only = null) {
  const { st, jev, run, keep, docTitle, id } = cx;
  if (process.env.REGLENS_R10 === "off") return;
  const c = A.check("R10", "Nesting: which heading is this under?", "Headings the numbering can't place (unnumbered ones, sequences that start mid-way) pick their parent from the open path above; level = parent level + 1 (two rounds). Same-style headings and markup-contradicting parents are never offered");
  const heads = list.filter((b) => st.blocks[b.id]?.role === "heading");
  if (!heads.length) return A.report(c);
  const tag = (b) => (cx.markup && /^h[1-6]$/.test(b.tag ?? "") ? +b.tag[1] : null);
  const tags = heads.map(tag).filter((x) => x != null);
  const minTag = tags.length ? Math.min(...tags) : null;
  const admissible = (h, p) => {
    if (CONTENTS.test(p.text.trim())) return false; // a contents list never holds sections
    const fh = family(h.text), fp = family(p.text);
    if (fh && fh === fp) return false;
    const th = tag(h), tp = tag(p);
    if (th != null && tp != null && (tp > th || (tp === th && !(fh && fp)))) return false;
    return true;
  };
  const topOk = (h) => !(tag(h) != null && minTag != null && tag(h) > minTag);
  const desc = (b) => ({ text: clip(b.text, 140), ...(b.tag ? { html_tag: b.tag } : {}), ...(b.rel_size ? { relative_font_size: b.rel_size, bold: b.bold > 0.5 } : {}), numbering: family(b.text) ?? "none" });
  const level = new Map(heads.map((b) => [b.id, st.blocks[b.id].level ?? 2]));
  let forced = 0, asked = 0;
  for (let round = 1; round <= 2; round++) {
    const paths = [];
    const stack = [];
    for (const b of heads) {
      const lv = level.get(b.id);
      paths.push(stack.slice(-6));
      while (stack.length && level.get(stack[stack.length - 1].id) >= lv) stack.pop();
      stack.push(b);
    }
    heads.forEach((b, i) => { if (i > 0 && !paths[i].includes(heads[i - 1])) paths[i] = [...paths[i], heads[i - 1]].slice(-6); });
    c.examined += only ? heads.filter((h) => only.has(h.id)).length : heads.length;
    const parentOf = new Array(heads.length).fill(undefined);
    const ask = [];
    heads.forEach((h, i) => {
      if (only && !only.has(h.id)) return;
      const opts = paths[i].filter((p) => admissible(h, p));
      const top = topOk(h);
      if (opts.length + (top ? 1 : 0) === 1) { parentOf[i] = opts[0] ?? null; forced++; h._nest = "forced by structure"; return; }
      if (!opts.length && !top) return;
      ask.push({ i, opts, top });
    });
    await Promise.all(chunks(ask, 20).map(async (as, ci) => {
      const r = await run.call(jev, { stage: `A R10 nesting r${round}`, target: `${id}#r10-${round}-${ci}`, state: { document: docTitle, all_headings_in_order: outlineContext(list, st) },
        questions: Object.fromEntries(as.map(({ i, opts, top }, k) => {
          const crit = {};
          if (top) crit.top_level = "It is a top-level heading: it does not belong under any of these";
          opts.forEach((p, n) => (crit[`under_${n + 1}`] = `It belongs directly under option ${n + 1}`));
          return [`par__${k}`, { type: "choice", criteria: crit, instructions: { question: "Which of the open headings above does `heading` belong directly under? A heading with the same numbering style as an option's sibling belongs under that option's parent. Deeper HTML tags (h4 under h3) and smaller type mean deeper headings. A quoted heading (opening with ‘‘ or “) is text inserted into another law: it belongs under the heading of the amendment that inserts it.", heading: desc(heads[i]), open_headings_above: opts.map((p, n) => ({ option: n + 1, ...desc(p) })) } }];
        })), meta: { doc: id } });
      keep(r);
      as.forEach(({ i, opts }, k) => {
        const a = r?.answers?.[`par__${k}`];
        if (!a) return;
        asked++;
        parentOf[i] = a.choice === "top_level" ? null : opts[Number(a.choice.split("_")[1]) - 1] ?? null;
        heads[i]._nest = r.id;
      });
    }));
    const topLevel = Math.min(...heads.map((b) => level.get(b.id)));
    let changed = 0;
    heads.forEach((b, i) => {
      if (parentOf[i] === undefined) return;
      const nl = parentOf[i] ? Math.min(MAX_LEVEL, level.get(parentOf[i].id) + 1) : topLevel;
      if (nl !== level.get(b.id)) { level.set(b.id, nl); changed++; }
    });
    if (!changed) break;
  }
  let n = 0;
  for (const b of heads) {
    const l = st.blocks[b.id];
    if (l.level !== level.get(b.id)) { l.levelWas = l.level; l.level = level.get(b.id); n++; }
    if (b._nest && b._nest !== "forced by structure") l.calls.nesting = b._nest;
    delete b._nest;
  }
  c.flagged = n;
  c.detail += ` · ${asked} asked, ${forced} decided by structure`;
  if (n) A.fix(c, { block: heads[0]?.id, detail: `${n} of ${heads.length} heading levels re-derived from parent choices` }, n);
  A.report(c);
}

// ───────────────────────────── numbering: what is arithmetic happens in code ─────────────────────────────

const CONTENTS = /^(table of )?contents\b|^contents$/i;
// A label, its number, and then a title or punctuation (never a lowercase word: "Article 5 of Regulation …" is a reference).
const LABELED = /^([A-Za-z]+)\s+(\d+|[IVXLC]+|[A-Z])(?=\s*[:.—–-]|\s+[A-Z(“"]|\s*$)/;
const LABELS = new Set(["recommendation", "principle", "rule", "standard", "annex", "appendix", "schedule", "step", "division", "guideline", "requirement"]);
const ROMAN_DIGIT = { i: 1, v: 5, x: 10, l: 50, c: 100 };
function roman(s) {
  const t = s.toLowerCase();
  if (!/^[ivxlc]+$/.test(t)) return null;
  let n = 0;
  for (let i = 0; i < t.length; i++) { const v = ROMAN_DIGIT[t[i]], w = ROMAN_DIGIT[t[i + 1]] ?? 0; n += v < w ? -v : v; }
  return n > 0 && n < 90 ? n : null;
}
const letter = (c) => c.toLowerCase().charCodeAt(0) - 96;

/** Every way to read a provision's number: "(i)" is roman one or the letter after (h); "SEC. 4B" sits between 4 and 5. */
export function numberings(text) {
  const t = text.trim();
  const q = /^[‘'"“]/.test(t) ? "quoted " : "";
  const u = t.replace(/^[‘'"“]+/, "");
  const out = (fam, ord, extra) => ({ fam: q + fam, ord, ...extra });
  let m;
  // A section heading puts a period after its number ("SEC. 16.", "Section 4."); "Section 507 of title 11" is a reference.
  if ((m = u.match(/^(?:SEC\.|SECTION|Sec\.|Section)\s*(\d+)([A-Z]?)\.(\s|$)/))) return [out("SEC. N", +m[1] + (m[2] ? letter(m[2]) / 100 : 0))];
  if ((m = u.match(/^TITLE\s+([IVXLC]+)\b/))) return [out("TITLE N", roman(m[1]))];
  // "PART 247—…", "Chapter III", "Article 12 Scope" (but not the reference "Article 5 of Regulation …").
  if ((m = u.match(LABELED)) && ["part", "chapter", "article"].includes(m[1].toLowerCase()) && /^[IVXLC]+$|^\d+$/.test(m[2])) return [out(`${m[1].toUpperCase()} N`, /\d/.test(m[2]) ? +m[2] : roman(m[2]))];
  if ((m = u.match(/^Subpart\s+([A-Z])\b/))) return [out("Subpart A", letter(m[1]))];
  // Labeled sequences: "Recommendation 4: Governance", "Principle III. Fairness" (not "Annex 2 of …").
  if ((m = u.match(LABELED)) && LABELS.has(m[1].toLowerCase())) return [out(`${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} N`, /\d/.test(m[2]) ? +m[2] : roman(m[2]) ?? letter(m[2]))];
  if ((m = u.match(/^§+\s?(\d+)\.(\d+)\s/))) return [out("§ N", +m[2], { prefix: m[1] })];
  if ((m = u.match(/^(\d+(?:\.\d+)+)\.?\s*(\(([a-z])\))?/)) && /^\d+(\.\d+)+\.?(\s|\(|$)/.test(u)) {
    const parts = m[1].split(".");
    if (m[2]) return [out(`${parts.length}-level decimal (a)`, letter(m[3]), { prefix: m[1] })];
    return [out(`${parts.length}-level decimal`, +parts[parts.length - 1], { prefix: parts.slice(0, -1).join(".") })];
  }
  if ((m = u.match(/^\((\d{1,3})\)/))) return [out("(1)", +m[1])];
  // "(ii)" is roman two far more often than the double letter after "(hh)": offer both, the sequence decides.
  if ((m = u.match(/^\(([a-z])\1\)/))) { const r = roman(m[0].slice(1, -1)); return [...(r ? [out("(i)", r)] : []), out("(aa)", letter(m[1]))]; }
  if ((m = u.match(/^\(([A-Z])\1\)/))) { const r = roman(m[0].slice(1, -1)); return [...(r ? [out("(I)", r)] : []), out("(AA)", letter(m[1]))]; }
  if ((m = u.match(/^\(([a-z]{1,5})\)/))) {
    const r = roman(m[1]);
    return [...(r ? [out("(i)", r)] : []), ...(m[1].length === 1 ? [out("(a)", letter(m[1]))] : [])];
  }
  if ((m = u.match(/^\(([A-Z]{1,5})\)/))) {
    const r = roman(m[1]);
    return [...(r ? [out("(I)", r)] : []), ...(m[1].length === 1 ? [out("(A)", letter(m[1]))] : [])];
  }
  if ((m = u.match(/^(\d{1,3})\.\s/))) return [out("1.", +m[1])];
  // A number and a space before a capitalized title, as papers number their sections ("3 DEFI PROTOCOLS").
  if ((m = u.match(/^(\d{1,2})\s+(?=[A-Z])/)) && words(u) <= 12) return [out("N Title", +m[1])];
  if ((m = u.match(/^([IVXLC]{1,6})\.\s/))) { const r = roman(m[1]); return [...(r ? [out("I.", r)] : []), ...(m[1].length === 1 ? [out("A.", letter(m[1]))] : [])]; }
  if ((m = u.match(/^([A-Z])\.\s/))) return [out("A.", letter(m[1]))];
  if ((m = u.match(/^([ivxlc]{1,6})\.\s/))) { const r = roman(m[1]); return [...(r ? [out("i.", r)] : []), ...(m[1].length === 1 ? [out("a.", letter(m[1]))] : [])]; }
  if ((m = u.match(/^([a-z])\.\s/))) return [out("a.", letter(m[1]))];
  return [];
}

/**
 * The numbering stack, as a reader keeps it: (a) → (1) → (A) → (i). Walks headings and numbered content in
 * order. A provision whose number continues an open sequence ((B) after (A)) is that item's sibling; one that
 * starts a sequence ((1), (A), (i)) is a child of the innermost open item. Unnumbered headings are anchors at
 * the level Jev gave them. Returns, for every heading, how the numbering places it and at what level.
 * Orphans (a sequence that starts mid-way, like an inserted "(c)") and unnumbered headings are left to Jev.
 */
function numberingStack(list, st, markup = st.markup) {
  const stack = [];
  const placed = new Map();
  // With trusted markup, a tagged heading's parent is the innermost open heading with a shallower tag, or with the
  // same tag but another numbering style (publishers that stop at <h4> tag "1." and "a." alike). Everything opened
  // after that parent, tagged or not, is closed.
  const tagOf = (b) => (markup && /^h[1-6]$/.test(b.tag ?? "") ? +b.tag[1] : null);
  const closeTo = (t, fam) => {
    if (t == null) return;
    let j = stack.length - 1;
    for (; j >= 0; j--) { const e = stack[j]; if (e.tag != null && (e.tag < t || (fam && e.fam && e.tag === t && e.fam !== fam))) break; }
    stack.length = j + 1;
  };
  for (const b of list) {
    const l = st.blocks[b.id];
    if (!l || !(l.role === "heading" || isContent(l.role))) continue;
    const numbered = l.role === "heading" || l.role === "list_item" || /^[‘'"“]*\(/.test(b.text.trim());
    const ints = numbered ? numberings(b.text) : [];
    if (!ints.length) {
      if (l.role !== "heading") continue;
      if (b.split?.part === "heading") {
        // A run-in heading labels one paragraph: it sits directly under the innermost open heading or item, and
        // never closes anything above it.
        while (stack.length && stack[stack.length - 1].runIn) stack.pop();
        const level = Math.min(MAX_LEVEL, (stack.length ? stack[stack.length - 1].level : (l.level ?? 3) - 1) + 1);
        stack.push({ fam: null, ord: null, level, id: b.id, runIn: true });
        placed.set(b.id, { rel: "run-in", level });
        continue;
      }
      if (tagOf(b) != null) closeTo(tagOf(b), null);
      else while (stack.length && stack[stack.length - 1].level >= l.level) stack.pop();
      stack.push({ fam: null, ord: null, level: l.level, id: b.id, tag: tagOf(b), contents: CONTENTS.test(b.text.trim()) });
      placed.set(b.id, { rel: "anchor", level: l.level });
      continue;
    }
    // A contents list never holds sections, and a run-in heading never holds numbered items.
    while (stack.length && (stack[stack.length - 1].runIn || stack[stack.length - 1].contents)) stack.pop();
    let best = null;
    for (const it of ints) {
      let k = -1;
      for (let j = stack.length - 1; j >= 0; j--) if (stack[j].fam === it.fam && (it.prefix == null || stack[j].prefix === it.prefix)) { k = j; break; }
      const next = k >= 0 && Math.abs(it.ord - stack[k].ord - 1) < 1e-9 || (k >= 0 && it.fam.endsWith("SEC. N") && it.ord > stack[k].ord && it.ord - stack[k].ord < 1);
      const cand = next ? { rel: "sibling", rank: 4 } : it.ord === 1 ? { rel: "child", rank: 3 } : k >= 0 && it.ord > stack[k].ord ? { rel: "sibling_gap", rank: 2 } : { rel: "orphan", rank: 1 };
      if (!best || cand.rank > best.rank) best = { ...it, k, ...cand };
    }
    let level;
    if (best.rel === "sibling" || best.rel === "sibling_gap") { level = stack[best.k].level; stack.length = best.k; }
    else if (best.rel === "child") {
      if (l.role === "heading") closeTo(tagOf(b), best.fam);
      level = stack.length ? stack[stack.length - 1].level + 1 : l.level ?? 2;
    }
    else {
      level = l.role === "heading" ? l.level ?? 2 : (stack.length ? stack[stack.length - 1].level + 1 : 3);
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    }
    level = Math.min(MAX_LEVEL, level);
    stack.push({ fam: best.fam, ord: best.ord, prefix: best.prefix, level, id: b.id, tag: l.role === "heading" ? tagOf(b) : null });
    if (l.role === "heading") placed.set(b.id, { rel: best.rel, level, fam: best.fam });
  }
  return placed;
}

/** R11 (code): apply the numbering stack to every heading whose number places it. */
function applyNumbering(cx, A, list, c) {
  const { st } = cx;
  const placed = numberingStack(list, st);
  let n = 0;
  for (const [bid, p] of placed) {
    if (!["sibling", "child", "sibling_gap", "run-in"].includes(p.rel)) continue;
    const l = st.blocks[bid];
    if (l.level !== p.level) { l.levelWas ??= l.level; l.level = p.level; n++; }
  }
  if (c) {
    c.examined += placed.size;
    c.flagged += n;
    if (n) A.fix(c, { block: list.find((b) => placed.has(b.id))?.id, detail: `${n} heading levels set by their numbering (sibling of the previous item, or first child of the open one)` }, n);
  }
  return { placed, changed: n };
}

// ───────────────────────────── L: the issue-driven loop ─────────────────────────────
// Each handler takes the open issues of its types, asks Jev, and applies the answers. The loop measures
// health after every handler and rolls the handler back if it made the parse worse.

/** L-attach (fragments, dangling hyphens): which neighbor is the other part? Or is it complete as it is? */
async function fixAttach(cx, A, list, issues, c) {
  const { doc, st, jev, run, keep, docTitle, id } = cx;
  const ix = [...new Set(issues.map((x) => x.block))].map((bid) => list.findIndex((b) => b.id === bid)).filter((i) => i >= 0);
  c.examined += ix.length;
  const plan = [];
  const qs = {};
  ix.forEach((i, k) => {
    const pi = textNeighbor(list, i, -1, st), ni = textNeighbor(list, i, 1, st);
    const crit = {};
    if (pi >= 0 && joinable(list[pi], list[i])) crit.previous = "It continues or completes the previous block (the previous block is cut off and this is the rest)";
    if (ni >= 0 && joinable(list[i], list[ni])) crit.next = "The next block continues or completes it (this is cut off and the next block is the rest)";
    crit.complete = "It is complete as it is: a label, table cell, heading, or short item that stands on its own";
    qs[`att__${k}`] = { type: "choice", criteria: crit, instructions: { question: "This block looks incomplete (very short with no ending punctuation, a lowercase heading, or a line ending in a hyphen). Which neighbor is its other part, if any? A conjunction such as “or” or “and” standing between two list items ends the earlier item.", fragment: clip(list[i].text, 600), fragment_features: { ...features(list[i]), role: st.blocks[list[i].id]?.role }, previous: side(list[pi], st, pi >= 0 ? layoutCues(list[pi], list[i], doc) : {}), next: side(list[ni], st, ni >= 0 ? layoutCues(list[i], list[ni], doc) : {}) } };
    plan.push([k, i, pi, ni]);
  });
  const answers = {};
  await Promise.all(chunks(plan, PACK).map(async (ps, ci) => {
    const r = await run.call(jev, { stage: "A L attach", target: `${id}#Lat${cx.round}-${ci}`, state: { document: docTitle, page_text: pageContext(list, ps.map(([, i]) => list[i])) }, questions: Object.fromEntries(ps.map(([k]) => [`att__${k}`, qs[`att__${k}`]])), meta: { doc: id } });
    keep(r);
    for (const [k] of ps) answers[k] = { a: r?.answers?.[`att__${k}`], call: r?.id };
  }));
  const pairs = [];
  for (const [k, i, pi, ni] of plan) {
    // Drafting convention, not judgment: a lone "or" / "and" between list items ends the earlier item.
    if (/^[;,]?\s*(or|and|and\/or|but)\s*$/i.test(list[i].text.trim()) && pi >= 0) { pairs.push([pi, i]); continue; }
    const { a, call } = answers[k] ?? {};
    if (!a) continue;
    if (a.choice === "previous") pairs.push([pi, i]);
    else if (a.choice === "next") pairs.push([i, ni]);
    else if (a.choice === "complete" && (a.confidence ?? 0) >= 0.6) for (const x of issues.filter((x) => x.block === list[i].id)) A.verify(c, list[i].id, x.type, a.confidence, call, `complete as it is (${pct(a.confidence)})`);
  }
  c.flagged += pairs.length;
  const used = new Set();
  const groups = [];
  for (const [i, j] of pairs.sort((x, y) => x[0] - y[0])) {
    if (used.has(i) || used.has(j)) continue;
    used.add(i); used.add(j);
    groups.push([list[i], list[j]]);
  }
  const res = applyMerges(list, groups, st);
  for (const m of res.merged) A.fix(c, { block: m.block.id, detail: `round ${cx.round}: joined “${clip(m.block.text, 90)}”` });
  await labelModality(cx, res.merged.map((m) => m.block), res.list, "A relabel modality");
  return res.list;
}

/** L-split (over-long headings): where does the heading end? Or is the whole block text, or one long heading? */
async function fixLong(cx, A, list, issues, c) {
  const { st, jev, run, keep, docTitle, id } = cx;
  const bs = issues.map((x) => list.find((b) => b.id === x.block)).filter(Boolean);
  c.examined += bs.length;
  const fresh = [];
  const textParts = [];
  const decisions = new Map();
  await Promise.all(chunks(bs, PACK).map(async (cs, ci) => {
    const r = await run.call(jev, { stage: "A L split", target: `${id}#Lsp${cx.round}-${ci}`, state: { document: docTitle, page_text: pageContext(list, cs) },
      questions: Object.fromEntries(cs.map((b, k) => {
        const crit = {};
        cutPoints(b.text).forEach((at, n) => (crit[`cut_${n + 1}`] = `The heading is “${b.text.slice(0, at).trim()}” and the provision's text starts “${clip(b.text.slice(at).trim(), 60)}”`));
        crit.all_text = "There is no heading: the whole block is ordinary text";
        crit.all_heading = "It really is one long heading";
        return [`lh__${k}`, { type: "choice", criteria: crit, instructions: { question: "This block was labeled a heading but is very long. Where does its heading end?", text: clip(b.text, 900), ...features(b) } }];
      })), meta: { doc: id } });
    keep(r);
    cs.forEach((b, k) => decisions.set(b.id, { a: r?.answers?.[`lh__${k}`], call: r?.id }));
  }));
  list = list.flatMap((b) => {
    const d = decisions.get(b.id);
    if (!d?.a) return [b];
    const { a, call } = d;
    if (a.choice.startsWith("cut_")) {
      const at = cutPoints(b.text)[Number(a.choice.split("_")[1]) - 1];
      if (!at) return [b];
      c.flagged++;
      const [hb, tb] = splitBlock(b, at, st, { p: a.confidence, call });
      st.blocks[hb.id].level = st.blocks[b.id].level;
      Object.assign(st.blocks[b.id], { roleWas: "heading", role: ENUM.test(tb.text.trim()) ? "list_item" : "body", roleTop: null, level: null });
      textParts.push(tb);
      fresh.push(tb);
      A.fix(c, { block: hb.id, detail: `heading “${clip(hb.text, 60)}” split off its text` });
      return [hb, tb];
    }
    if (a.choice === "all_text") {
      c.flagged++;
      const l = st.blocks[b.id];
      Object.assign(l, { roleWas: l.role, role: ENUM.test(b.text.trim()) ? "list_item" : "body", roleConf: a.confidence, level: null });
      l.calls.split = call;
      fresh.push(b);
      A.fix(c, { block: b.id, detail: `not a heading: ${l.role}` });
      return [b];
    }
    if ((a.confidence ?? 0) >= 0.6) A.verify(c, b.id, "long_heading", a.confidence, call, `one long heading (${pct(a.confidence)})`);
    return [b];
  });
  await labelRoles(cx, textParts, list, "A relabel roles");
  await labelModality(cx, fresh, list, "A relabel modality");
  return list;
}

/** A check may overturn a role only with at least the confidence the role already has (or when that is low),
 *  and never a third time: two checks that disagree must not flip a block back and forth. */
const mayChange = (l, p) => (l.flips ?? 0) < 2 && ((p ?? 0) >= (l.roleConf ?? 0) || (l.roleConf ?? 0) < 0.45);

/** L-empty (headings with nothing under them): parent, split heading, empty by design, or not a heading? */
async function fixEmpty(cx, A, list, issues, c) {
  const { st, jev, run, keep, docTitle, id } = cx;
  const secs = buildOutline(list, st);
  const byId = new Map(list.map((b, i) => [b.id, i]));
  const headingAt = (j) => (j >= 0 && st.blocks[list[j].id]?.role === "heading" ? j : -1);
  const items = issues.map((x) => {
    const si = secs.findIndex((s) => s.heading === x.block);
    const i = byId.get(x.block);
    if (si < 0 || i == null) return null;
    return { x, sec: secs[si], i, nextHeading: headingAt(neighbor(list, i, 1, st)), prevHeading: headingAt(neighbor(list, i, -1, st)), following: secs.slice(si + 1, si + 4) };
  }).filter(Boolean);
  c.examined += items.length;
  if (!items.length) return list;
  const ctx = outlineContext(list, st);
  const answers = new Map();
  await Promise.all(chunks(items, PACK).map(async (em, ci) => {
    const r = await run.call(jev, { stage: "A L empty headings", target: `${id}#Lem${cx.round}-${ci}`, state: { document: docTitle, all_headings_in_order: ctx },
      questions: Object.fromEntries(em.map(({ sec, i, nextHeading, prevHeading, following }, k) => {
        const b = list[i];
        const crit = { parent: "A real heading that introduces the headings right after it: they are its subdivisions" };
        if (nextHeading >= 0) crit.first_line = "The first line of the next heading: one heading was split in two";
        if (prevHeading >= 0) crit.continues_previous = "The last line of the previous heading: one heading was split in two";
        Object.assign(crit, {
          empty_by_design: "A real heading that is empty on purpose, such as a [Reserved] part or a placeholder",
          figure_or_table: "A title or label inside a figure, chart, or table",
          text: "Not a heading: a sentence or lead-in that belongs to the text",
          running_header: "Not a heading: a running header or footer, or a note printed in the page margin",
          contents_entry: "Not a heading: an entry in a table of contents or list of sections",
        });
        const after = [];
        for (let j = i + 1; j < list.length && after.length < 3; j++) if (st.blocks[list[j].id]?.role !== "page_furniture") after.push({ text: clip(list[j].text, 140), role: st.blocks[list[j].id]?.role, ...features(list[j]) });
        const pj = neighbor(list, i, -1, st);
        return [`emp__${k}`, { type: "choice", criteria: crit, instructions: { question: "`heading` has no text under it before the next heading at the same or a higher level. What is it? `followed_by` shows the blocks right after it.", heading: { text: clip(b.text, 300), level: sec.level, ...features(b) }, preceded_by: side(list[pj], st), followed_by: after, next_headings: following.map((f) => ({ text: clip(f.title, 140), level: f.level })) } }];
      })), meta: { doc: id } });
    keep(r);
    em.forEach((it, k) => answers.set(it.x.block, { a: r?.answers?.[`emp__${k}`], call: r?.id }));
  }));

  // Every decision becomes an action. Actions are applied one at a time and each is kept only if parse health
  // does not get worse, so one wrong answer can't take the good ones down with it.
  const actions = [];
  const disputes = [];
  const relabel = (bid, role, p, call, why) => ({
    run: (L) => {
      const l = st.blocks[bid];
      if (!l) return null;
      Object.assign(l, { roleWas: l.role, role, roleConf: p, roleTop: null, level: null, flips: (l.flips ?? 0) + 1 });
      l.calls.empty = call;
      return { list: L, block: bid, fresh: bid, detail: why };
    },
  });
  const join = (ids, call) => ({
    run: (L) => {
      const members = ids.map((x) => L.find((b) => b.id === x));
      if (members.some((m) => !m)) return null;
      const level = st.blocks[ids[0]]?.level;
      const res = applyMerges(L, [members], st);
      const m = res.merged[0]?.block;
      if (!m) return null;
      Object.assign(st.blocks[m.id], { role: "heading", level });
      st.blocks[m.id].calls.empty = call;
      return { list: res.list, block: m.id, detail: `one heading split across lines, rejoined: “${clip(m.text, 70)}”` };
    },
  });
  const parent = (bid, call) => ({
    run: (L) => {
      const i = L.findIndex((b) => b.id === bid);
      const b = L[i], l = st.blocks[bid];
      if (!b || !l) return null;
      // A numbered parent takes everything up to its next sibling; an unnumbered one takes the next heading and the
      // rest of that heading's numbering sequence. Sub-headings move with their parents. A parent printed deeper than
      // the headings it introduces is first pulled up to their level.
      const fx = family(b.text);
      const firstNext = L.slice(i + 1).find((x) => st.blocks[x.id]?.role === "heading");
      if (firstNext && st.blocks[firstNext.id].level < l.level && !(fx && family(firstNext.text) === fx)) { l.levelWas ??= l.level; l.level = st.blocks[firstNext.id].level; }
      let moved = 0, seq;
      for (let j = i + 1; j < L.length; j++) {
        const lj = st.blocks[L[j].id];
        if (lj?.role !== "heading") continue;
        if (lj.level < l.level || (fx && family(L[j].text) === fx)) break;
        if (!fx && lj.level <= l.level) {
          const fj = family(L[j].text);
          if (seq === undefined) seq = fj;
          else if (!fj || fj !== seq) break;
        }
        lj.levelWas ??= lj.level; lj.level = Math.min(MAX_LEVEL, lj.level + 1); moved++;
      }
      l.calls.empty = call;
      return moved ? { list: L, block: bid, detail: `“${clip(b.text, 60)}” introduces what follows: ${moved} heading${moved > 1 ? "s" : ""} moved under it` } : null;
    },
  });
  for (const it of items) {
    const { a, call } = answers.get(it.x.block) ?? {};
    const b = list[it.i];
    const l = st.blocks[b.id];
    if (!a || !l) continue;
    if (a.choice === "parent") actions.push(parent(b.id, call));
    else if (a.choice === "first_line" && it.nextHeading >= 0) actions.push(join([b.id, list[it.nextHeading].id], call));
    else if (a.choice === "continues_previous" && it.prevHeading >= 0) actions.push(join([list[it.prevHeading].id, b.id], call));
    else if (a.choice === "empty_by_design") { if ((a.confidence ?? 0) >= 0.6) A.verify(c, b.id, "empty_section", a.confidence, call, `empty on purpose (${pct(a.confidence)})`); }
    else {
      const role = { figure_or_table: "table_or_figure", text: ENUM.test(b.text.trim()) ? "list_item" : "body", running_header: "page_furniture", contents_entry: "toc_entry" }[a.choice];
      if (!role) continue;
      if (!mayChange(l, a.confidence)) disputes.push({ b, i: it.i, proposed: role, why: a.choice, p: a.confidence, call });
      else actions.push(relabel(b.id, role, a.confidence, call, `“${clip(b.text, 60)}” is not a heading: → ${role.replace(/_/g, " ")}`));
    }
  }

  // Two checks disagree (the role check said heading with more confidence than this check's answer): a
  // tie-breaker with the readings and all the evidence side by side decides, and its answer is final.
  if (disputes.length) {
    const tieActions = new Map(); // dispute index -> action, applied in document order below
    await Promise.all(chunks(disputes, PACK).map(async (ds, ci) => {
      const r = await run.call(jev, { stage: "A L tie-break", target: `${id}#Ltb${cx.round}-${ci}`, state: { document: docTitle, page_text: pageContext(list, ds.map((d) => d.b)) },
        questions: Object.fromEntries(ds.map((d, k) => {
          const after = [];
          for (let j = d.i + 1; j < list.length && after.length < 3; j++) if (st.blocks[list[j].id]?.role !== "page_furniture") after.push({ text: clip(list[j].text, 140), role: st.blocks[list[j].id]?.role, ...features(list[j]) });
          const pj = neighbor(list, d.i, -1, st);
          const cur = st.blocks[d.b.id].role;
          // Both readings, plus whatever else the first labeling pass found plausible, plus running header at a page edge.
          const opts = [...new Set([cur, d.proposed, ...(st.blocks[d.b.id].roleTop ?? []).filter(([, p]) => p >= 0.08).map(([r]) => r), ...(d.b.zone && d.b.zone !== "body" ? ["page_furniture"] : [])])].filter((r) => ROLES[r]).slice(0, 4);
          d.opts = opts;
          return [`tb__${k}`, { type: "choice", criteria: Object.fromEntries(opts.map((r) => [r, ROLES[r]])), instructions: { question: `Two checks disagree about \`target\`: one reads it as ${cur.replace(/_/g, " ")}, the other as ${d.proposed.replace(/_/g, " ")}. Weigh its wording, its position and type, what comes right before and after it, and \`page_text\`.`, target: clip(d.b.text, 400), target_features: features(d.b), previous: side(list[pj], st), followed_by: after } }];
        })), meta: { doc: id } });
      keep(r);
      ds.forEach((d, k) => {
        const a = r?.answers?.[`tb__${k}`];
        const l = st.blocks[d.b.id];
        if (!a || !l) return;
        l.flips = 2; // settled
        l.calls.tiebreak = r.id;
        if (a.choice !== l.role) tieActions.set(disputes.indexOf(d), relabel(d.b.id, a.choice, a.confidence, r.id, `tie-break among ${d.opts.length}: “${clip(d.b.text, 50)}” is ${a.choice.replace(/_/g, " ")}, not a heading (${pct(a.confidence)})`));
        else if ((a.confidence ?? 0) >= 0.6 && d.b.zone !== "top" && d.b.zone !== "bottom" && !d.b.repeats) A.verify(c, d.b.id, "empty_section", a.confidence, r.id, `tie-break among ${d.opts.length}: a real heading with no text of its own (${pct(a.confidence)})`);
      });
    }));
    for (const k of [...tieActions.keys()].sort((x, y) => x - y)) actions.push(tieActions.get(k));
  }

  const total = (L) => health(L, st, buildOutline(L, st)).counts.total;
  const fresh = [];
  for (const act of actions) {
    const snapList = [...list], snapBlocks = structuredClone(st.blocks), before = total(list);
    const out = act.run(list);
    if (!out || total(out.list) > before) {
      list = snapList;
      st.blocks = snapBlocks;
      if (out) c.rolledBack = (c.rolledBack ?? 0) + 1;
      continue;
    }
    list = out.list;
    c.flagged++;
    if (out.fresh) fresh.push(out.fresh);
    A.fix(c, { block: out.block, detail: out.detail });
  }
  await labelModality(cx, list.filter((b) => fresh.includes(b.id)), list, "A relabel modality");
  return list;
}

/** L-number (numbering conflicts, code): a later fix moved an anchor, so re-apply the numbering stack. */
async function fixNumbering(cx, A, list, issues, c) {
  applyNumbering(cx, A, list, c);
  return list;
}

/** L-runoff (low-confidence roles): a focused choice between the two or three roles Jev was torn between. */
async function fixRunoff(cx, A, list, issues, c) {
  const { st, jev, run, keep, docTitle, id } = cx;
  const ix = issues.map((x) => list.findIndex((b) => b.id === x.block)).filter((i) => i >= 0);
  c.examined += ix.length;
  const changed = [];
  await Promise.all(chunks(ix, PACK).map(async (is, ci) => {
    const plan = is.map((i) => {
      const l = st.blocks[list[i].id];
      let opts = [...new Set([l.role, ...(l.roleTop ?? []).filter(([, p]) => p >= 0.08).map(([k]) => k)])].filter((k) => ROLES[k]).slice(0, 3);
      if (opts.length < 2) opts = Object.keys(ROLES);
      return { i, opts };
    });
    const r = await run.call(jev, { stage: "A L runoff", target: `${id}#Lro${cx.round}-${ci}`, state: { document: docTitle, page_text: pageContext(list, is.map((i) => list[i])) },
      questions: Object.fromEntries(plan.map(({ i, opts }, k) => {
        const pi = neighbor(list, i, -1, st), ni = neighbor(list, i, 1, st);
        return [`ro__${k}`, { type: "choice", criteria: Object.fromEntries(opts.map((o) => [o, ROLES[o]])), instructions: { question: "It was unclear what `target` is; it is one of these. Decide from its wording, its neighbors' roles, and where it sits on the page.", target: clip(list[i].text, 800), target_features: features(list[i]), previous: side(list[pi], st), next: side(list[ni], st) } }];
      })), meta: { doc: id } });
    keep(r);
    plan.forEach(({ i, opts }, k) => {
      const a = r?.answers?.[`ro__${k}`];
      if (!a) return;
      const l = st.blocks[list[i].id];
      const was = l.role;
      c.flagged++;
      if (a.choice !== was && (l.flips ?? 0) >= 2) return; // changed twice already in this loop: settled
      Object.assign(l, { role: a.choice, roleConf: a.confidence, runoff: { options: opts, was, wasConf: l.roleConf, call: r.id } });
      if (a.choice !== was) l.flips = (l.flips ?? 0) + 1;
      if (a.choice !== was) {
        l.roleWas = was;
        if (a.choice === "heading") l.level = null;
        changed.push(list[i]);
        A.fix(c, { block: list[i].id, detail: `${was} → ${a.choice} in a runoff of ${opts.length} (${pct(a.confidence)})` });
      } else if ((a.confidence ?? 0) >= 0.45) A.fix(c, { block: list[i].id, detail: `${was} confirmed in a runoff of ${opts.length} (${pct(a.confidence)})` });
    });
  }));
  await relabel(cx, changed, list);
  return list;
}

const HANDLERS = [
  { id: "L-attach", label: "Attach what is still broken", types: ["fragment", "dangling_hyphen"], run: fixAttach, detail: "Blocks still flagged as fragments or ending in a hyphen: which neighbor is the other part, or is it complete as it is?" },
  { id: "L-split", label: "Over-long headings", types: ["long_heading"], run: fixLong, detail: "Where does the heading end? Code offers the cut points (dashes, periods, colons); Jev picks one, or says it is all text or one long heading" },
  { id: "L-empty", label: "Empty headings", types: ["empty_section"], run: fixEmpty, detail: "A heading with nothing under it: parent of what follows, first line of a split heading, empty on purpose, or not a heading (figure label, text, running header, contents entry)?" },
  { id: "L-number", label: "Numbering conflicts (code)", types: ["numbering_conflict"], run: fixNumbering, detail: "A fix elsewhere moved a heading its numbered neighbors depend on: re-apply the numbering stack" },
  { id: "L-runoff", label: "Runoff for unsure roles", types: ["low_confidence"], run: fixRunoff, detail: "Blocks whose role Jev was unsure of: a focused choice between the two or three roles it was torn between, with the neighbors in view" },
];

async function issueLoop(cx, A, list) {
  const { st } = cx;
  const checks = new Map(HANDLERS.map((h) => [h.id, A.check(h.id, h.label, h.detail)]));
  const measure = () => health(list, st, buildOutline(list, st));
  for (let round = 1; round <= 6; round++) {
    cx.round = round;
    const start = measure();
    const open = start.issues.filter((x) => !x.verified);
    if (!open.length) break;
    let prev = start;
    for (const hd of HANDLERS) {
      const ids = new Set(list.map((b) => b.id));
      const mine = prev.issues.filter((x) => !x.verified && hd.types.includes(x.type) && ids.has(x.block));
      if (!mine.length) continue;
      const c = checks.get(hd.id);
      const snap = { list: [...list], blocks: structuredClone(st.blocks), fixes: A.audit.fixes.length, fixed: c.fixed, verified: c.verified ?? 0, flagged: c.flagged };
      list = await hd.run(cx, A, list, mine, c);
      const after = measure();
      if (after.counts.total > prev.counts.total) {
        // This handler made the parse worse: undo it, keep the record.
        list = snap.list;
        st.blocks = snap.blocks;
        A.audit.fixes.length = snap.fixes;
        c.rolledBack = (c.rolledBack ?? 0) + (c.fixed - snap.fixed);
        Object.assign(c, { fixed: snap.fixed, verified: snap.verified, flagged: snap.flagged });
        A.audit.loop.push({ round, check: hd.id, before: prev.counts.total, after: after.counts.total, rolledBack: true });
      } else {
        A.audit.loop.push({ round, check: hd.id, before: prev.counts.total, after: after.counts.total });
        prev = after;
      }
      A.report(c);
    }
    if (prev.counts.total >= start.counts.total && prev.counts.verified === start.counts.verified) break; // converged
  }
  return list;
}

async function auditRepair(cx, blocks) {
  const A = newAudit(cx);
  const isPdf = cx.doc.format === "pdf";
  let list = blocks;
  if (isPdf) list = await checkSeams(cx, A, list);
  if (isPdf) list = await checkFragments(cx, A, list);
  list = await checkRoles(cx, A, list);
  list = await checkRunningHeads(cx, A, list);
  await checkMarkup(cx, A, list);
  list = await checkRows(cx, A, list);
  list = await checkRepeats(cx, A, list);
  list = await checkRunIns(cx, A, list);
  // Numbering decides what is arithmetic; Jev nests the rest (unnumbered headings and orphans); numbering again.
  const c11 = A.check("R11", "Numbering stack (code)", "Headings whose number continues an open sequence are siblings of the previous item; ones that start a sequence ((1), (A), (i)) are first children of the open item. Roman-or-letter readings ((i) after (h)) are resolved by which one continues a sequence");
  const { placed } = applyNumbering(cx, A, list, c11);
  await checkNesting(cx, A, list, new Set([...placed].filter(([, p]) => !["sibling", "child", "sibling_gap", "run-in"].includes(p.rel)).map(([id]) => id)));
  applyNumbering(cx, A, list, c11);
  A.report(c11);
  return issueLoop(cx, A, list);
}

/** Runs the structuring DAG over one document. Emits events as labels land. */
export async function structureDoc({ library, id, jev, run, emit }) {
  const entry = library.docs.get(id);
  const doc = entry.doc;
  const raw = doc.raw ?? doc.blocks;
  markMargins(raw);
  markGraphics(raw, doc);
  const st = { builtAt: null, profile: null, blocks: {}, sections: [], lineage: {}, metrics: null, stitched: null };
  const t0 = Date.now();
  const keep = (rec) => rec && (st.lineage[rec.id] = run.lineage.get(rec.id));
  const say = (ev) => emit({ ...ev, doc: id });

  // S0 (PDFs only): let Jev decide where the extractor cut text that belongs together.
  let blocks = raw;
  if (doc.format === "pdf") {
    const { blocks: stitched, links, vetoed } = await stitch({ raw, doc, jev, run, keep, say });
    blocks = stitched;
    st.stitched = { blocks: stitched, links, vetoed };
    say({ t: "lib_stitched", blocks: stitched.map(({ id, page, bbox, parts, text, rel_size, stitched: sx }) => ({ id, page, bbox, parts, text, rel_size, stitched: sx ? { pieces: sx.pieces } : undefined })), links: links.length });
  }

  // S1: whole-document profile
  say({ t: "lib_stage", stage: "S1", status: "running" });
  const opening = blocks.slice(0, 80).map((b) => b.text).join("\n").slice(0, 6000);
  const q1 = {
    doc_type: { type: "choice", instructions: "What kind of document is this?", criteria: {
      statute: "An enacted law (public law)", bill: "Proposed legislation (a bill not yet enacted)", final_rule: "A final agency regulation",
      proposed_rule: "A proposed rule or notice of proposed rulemaking", interpretive_guidance: "Agency guidance, interpretive letter, or revenue ruling",
      staff_statement: "A statement of agency staff views", executive_order: "A presidential executive order", policy_report: "A policy or research report",
      press_release: "A press release or announcement" } },
    legal_force: { type: "score", instructions: "How much legal force does this document carry?", criteria: ["None: commentary, report, or announcement", "Non-binding staff or agency views", "Agency interpretation of existing law", "Proposed: not yet in force", "Binding law or final regulation"] },
    jurisdiction: { type: "choice", instructions: "Which jurisdiction does this document apply to?", criteria: { us_federal: "United States federal", us_state: "A U.S. state", eu: "European Union", international: "International standard-setting body" } },
  };
  for (const [k, v] of Object.entries(TOPICS)) q1[`topic_${k}`] = { type: "noul", instructions: `Is a substantial part of this document about: ${v}?` };
  const r1 = await run.call(jev, { stage: "S1 profile", target: id, state: { format: doc.format, pages: doc.pages.length || null, opening_text: opening }, questions: q1, meta: { doc: id } });
  keep(r1);
  if (r1) {
    const a = r1.answers;
    st.profile = {
      doc_type: a.doc_type?.choice, doc_type_conf: a.doc_type?.confidence, legal_force: yes(a.legal_force), legal_force_level: Math.round(a.legal_force?.score ?? 0),
      jurisdiction: a.jurisdiction?.choice, topics: Object.fromEntries(Object.keys(TOPICS).map((k) => [k, yes(a[`topic_${k}`])])), call: r1.id,
    };
    say({ t: "lib_profile", profile: st.profile });
  }
  say({ t: "lib_stage", stage: "S1", status: "done" });

  // S2 roles with the whole page as context -> S4 modality for content blocks, chunk by chunk.
  say({ t: "lib_stage", stage: "S2", status: "running", total: blocks.length });
  const docTitle = doc.title;
  const ask = (q, b) => ({ question: `${q} Answer about the block in \`target\` only; the rest of the state is context.`, target: b.text.slice(0, 1500), target_features: features(b) });
  await Promise.all(
    chunks(blocks, PACK).map(async (chunk, ci) => {
      const state = { document: docTitle, page_text: pageContext(blocks, chunk) };
      const q2 = {};
      chunk.forEach((b, i) => (q2[`role__${i}`] = { type: "choice", instructions: ask("What is this block of text? Use `page_text` to see where it sits on the page.", b), criteria: ROLES }));
      const r2 = await run.call(jev, { stage: "S2 roles", target: `${id}#${ci}`, state, questions: q2, meta: { doc: id, blocks: chunk.map((b) => b.id) } });
      keep(r2);
      const items = [];
      chunk.forEach((b, i) => {
        const a = r2?.answers?.[`role__${i}`];
        st.blocks[b.id] = { role: a?.choice ?? "body", roleConf: a?.confidence ?? 0, roleTop: topOf(a), calls: { role: r2?.id } };
        items.push({ b: b.id, role: st.blocks[b.id].role, conf: st.blocks[b.id].roleConf });
      });
      say({ t: "lib_blocks", stage: "S2", items });

      const content = chunk.map((b, i) => [b, i]).filter(([b]) => isContent(st.blocks[b.id].role));
      if (!content.length) return;
      const r4 = await run.call(jev, {
        stage: "S4 modality", target: `${id}#${ci}`, state,
        questions: Object.fromEntries(content.flatMap(([b], k) => [
          [`mod__${k}`, { type: "choice", instructions: ask("What does this block do? A list item that continues a sentence imposing a duty counts as that duty.", b), criteria: MODALITY }],
          [`dl__${k}`, { type: "noul", instructions: ask("Does this block set a deadline, time limit, or required frequency?", b) }],
        ])),
        meta: { doc: id, blocks: content.map(([b]) => b.id) },
      });
      keep(r4);
      say({ t: "lib_blocks", stage: "S4", items: content.map(([b], k) => {
        const a = r4?.answers?.[`mod__${k}`];
        Object.assign(st.blocks[b.id], { modality: a?.choice ?? null, modConf: a?.confidence ?? null, deadline: yes(r4?.answers?.[`dl__${k}`]) });
        st.blocks[b.id].calls.mod = r4?.id;
        return { b: b.id, modality: st.blocks[b.id].modality, deadline: st.blocks[b.id].deadline };
      }) });
    }),
  );
  say({ t: "lib_stage", stage: "S2", status: "done" });

  // S3: heading levels, judged with every heading in the document in view so the levels stay consistent.
  const heads = blocks.filter((b) => st.blocks[b.id].role === "heading");
  const outlineCtx = heads.slice(0, 700).map((b) => `${b.page ? `p${b.page} ` : ""}${clip(b.text, 110)}${b.rel_size ? ` [size ${b.rel_size}${b.bold > 0.5 ? ", bold" : ""}]` : b.tag ? ` [${b.tag}]` : ""}`);
  say({ t: "lib_stage", stage: "S3", status: "running", total: heads.length });
  await Promise.all(chunks(heads, 24).map(async (hs, ci) => {
    const r3 = await run.call(jev, {
      stage: "S3 levels", target: `${id}#h${ci}`, state: { document: docTitle, all_headings_in_order: outlineCtx },
      questions: Object.fromEntries(hs.map((b, k) => [`level__${k}`, { type: "score", criteria: LEVELS, instructions: ask(LEVEL_Q, b) }])),
      meta: { doc: id, blocks: hs.map((b) => b.id) },
    });
    keep(r3);
    say({ t: "lib_blocks", stage: "S3", items: hs.map((b, k) => {
      const a = r3?.answers?.[`level__${k}`];
      Object.assign(st.blocks[b.id], { level: a ? Math.round(a.score) : 2, levelScore: a?.score ?? null });
      st.blocks[b.id].calls.level = r3?.id;
      return { b: b.id, level: st.blocks[b.id].level };
    }) });
  }));
  say({ t: "lib_stage", stage: "S3", status: "done" });

  // Outline (code) -> parse health -> A: Jev audit & repair -> outline again -> health again.
  let sections = buildOutline(blocks, st);
  const before = health(blocks, st, sections);
  say({ t: "lib_health", phase: "before", counts: before.counts });
  const cx = { doc, st, jev, run, keep, say, raw, ask, docTitle, id };
  blocks = await auditRepair(cx, blocks);
  sections = buildOutline(blocks, st);
  const after = health(blocks, st, sections);
  st.health = { before: before.counts, after: after.counts, issues: after.issues.slice(0, 800) };
  say({ t: "lib_health", phase: "after", counts: after.counts });
  st.sections = sections;
  if (doc.format === "pdf") st.stitched.blocks = blocks;
  else st.stitched = { blocks, links: [] };
  say({ t: "lib_stitched", blocks: blocks.map(({ id, page, bbox, parts, text, rel_size, stitched: sx }) => ({ id, page, bbox, parts, text, rel_size, stitched: sx ? { pieces: sx.pieces } : undefined })), links: st.stitched.links.length });
  say({ t: "lib_outline", sections: st.sections.map(({ id, level, title, heading, path, blocks, pages }) => ({ id, level, title, heading, path, n: blocks.length, pages })) });

  // S5: section role + topics, only for sections that carry substantive content.
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const withText = st.sections.filter((s) => s.blocks.some((bid) => isContent(st.blocks[bid]?.role)));
  say({ t: "lib_stage", stage: "S5", status: "running", total: withText.length });
  await Promise.all(
    withText.map(async (s) => {
      const text = s.blocks.filter((bid) => isContent(st.blocks[bid]?.role)).map((bid) => byId.get(bid).text).join("\n").slice(0, 16000);
      const q5 = { role: { type: "choice", instructions: "What role does this section play?", criteria: SECTION_ROLES } };
      for (const [k, v] of Object.entries(TOPICS)) q5[`topic_${k}`] = { type: "noul", instructions: `Does this section address: ${v}?` };
      const r5 = await run.call(jev, { stage: "S5 sections", target: `${id}/${s.id}`, state: { document: docTitle, section_path: [...s.path, s.title], text }, questions: q5, meta: { doc: id, section: s.id } });
      keep(r5);
      if (!r5) return;
      s.role = r5.answers.role?.choice;
      s.roleConf = r5.answers.role?.confidence;
      s.topics = Object.fromEntries(Object.keys(TOPICS).map((k) => [k, yes(r5.answers[`topic_${k}`])]));
      s.call = r5.id;
      say({ t: "lib_section", section: { id: s.id, role: s.role, topics: s.topics } });
    }),
  );
  say({ t: "lib_stage", stage: "S5", status: "done" });

  st.builtAt = new Date().toISOString();
  const byStage = {};
  let decisions = 0;
  for (const rec of Object.values(st.lineage)) { if (!rec) continue; const n = Object.keys(rec.questions ?? {}).length; decisions += n; byStage[rec.stage] = (byStage[rec.stage] ?? 0) + n; }
  st.metrics = { wallMs: Date.now() - t0, calls: Object.keys(st.lineage).length, decisions, byStage, rawBlocks: raw.length, blocks: blocks.length, stitchedLinks: st.stitched?.links.length ?? 0, sections: st.sections.length };
  entry.structure = st;
  doc.raw = raw;
  doc.blocks = blocks;
  await library.save(id);
  say({ t: "lib_done", metrics: st.metrics });
  return st;
}

// ───────────────────────────── export: the document model ─────────────────────────────
// The parse as typed, traceable pieces: an outline tree, and every element with its kind, outline path,
// labels, page position, and the Jev calls behind it. This is what downstream programs (or anything
// else) consume, so they can restructure the data however they need without re-parsing.

const KIND = { heading: "heading", body: "paragraph", list_item: "list_item", definition_entry: "definition", question: "question", quote: "quote", field: "field", footnote: "footnote", table_or_figure: "table_or_figure", toc_entry: "toc_entry", front_matter: "front_matter", page_furniture: "page_furniture" };
const ENUMERATOR = /^[‘'"“]*((?:\((?:[a-zA-Z]{1,6}|\d{1,3})\))+|(?:SEC\.|Sec\.|SECTION|Section)\s*\d+[A-Za-z]*\.?|§+\s?[\d.]+[a-z]?|TITLE\s+[IVXLC]+|PART\s+\d+|[IVXLC]+\.|\d+(?:\.\d+)*\.?|[A-Za-z]\.)(?=\s|—|$)/;
/** The term a definition defines: “X” means…, X means…, or the left side of a glossary row. */
function definedTerm(text) {
  const t = text.trim();
  let m = t.match(/[‘“"']{1,2}([^’”"']{2,80})[’”"']{1,2}\s+(?:means|includes|refers to|has the meaning)/);
  if (m) return m[1];
  m = t.match(/^(?:\([^)]*\)\s*)*([A-Z][\w\s\-/]{1,60}?)\s+(?:means|includes|refers to)\b/);
  if (m) return m[1].trim();
  if (t.includes(" — ")) return t.split(" — ")[0].trim();
  return null;
}

export function exportDocument(entry) {
  const { doc, structure: st } = entry;
  if (!st) return null;
  const labels = st.blocks;
  const secById = new Map(st.sections.map((s) => [s.id, s]));
  const nodes = st.sections.map((s) => ({ id: s.id, level: s.level, title: s.title, heading: s.heading, role: s.role ?? null, topics: Object.entries(s.topics ?? {}).filter(([, p]) => p >= 0.5).map(([k]) => k), pages: s.pages, elements: s.blocks, children: [] }));
  const roots = [];
  const stack = [];
  for (const n of nodes) {
    while (stack.length && stack[stack.length - 1].level >= n.level) stack.pop();
    (stack.length ? stack[stack.length - 1].children : roots).push(n);
    stack.push(n);
  }
  const elements = [];
  const byElement = new Map();
  // Numbering stack, as a reader tracks it: (1) → (A) → (i). A numbered item's lead-in is the nearest open item
  // or paragraph above it in the stack that ends by introducing a list ("…shall—", "…as follows:").
  let open = [];
  for (const b of doc.blocks) {
    const l = labels[b.id];
    if (!l) continue;
    const sec = secById.get(l.section);
    if (l.role === "heading") open = [];
    const e = {
      id: b.id,
      kind: KIND[l.role] ?? l.role,
      text: b.text,
      section: l.section ?? null,
      path: sec ? [...sec.path, sec.title] : [],
      enumerator: b.text.trim().match(ENUMERATOR)?.[1] ?? null,
    };
    if (l.role === "heading") e.level = l.level;
    if (l.role === "definition_entry" || l.modality === "defines") { const t = definedTerm(b.text); if (t) e.term = t; }
    if (isContent(l.role)) {
      const fam = family(b.text);
      const lead = /[—:–]\s*$|-\s*$/.test(b.text);
      if (!fam && l.role !== "list_item") open = [{ id: b.id, fam: null, lead }];
      else {
        const k = fam ? open.findIndex((x) => x.fam === fam) : -1;
        if (k >= 0) open = open.slice(0, k);
        const parent = [...open].reverse().find((x) => x.lead);
        if (parent) e.lead_in = parent.id;
        // Items under a definition belong to its term ("(A) any technology—" under "blockchain").
        const owner = parent && byElement.get(parent.id);
        if (owner && !e.term && (owner.term || owner.term_of)) e.term_of = owner.term ?? owner.term_of;
        open.push({ id: b.id, fam, lead });
      }
    }
    e.labels = { role: l.role, role_p: r3(l.roleConf), ...(l.modality ? { modality: l.modality, modality_p: r3(l.modConf), deadline_p: r3(l.deadline) } : {}) };
    e.source = { ...(b.page ? { page: b.page, bbox: b.bbox } : {}), ...(b.parts?.length > 1 ? { pieces: b.parts.map(({ id, page, bbox }) => ({ id, page, bbox })) } : {}), ...(b.tag ? { html_tag: b.tag } : {}), ...(b.split ? { split_from: b.split.of } : {}), ...(b.duplicates ? { folded: b.duplicates.map((d) => d.id) } : {}) };
    const audit = { ...(l.roleWas ? { role_was: l.roleWas } : {}), ...(l.levelWas != null ? { level_was: l.levelWas } : {}), ...(l.runoff ? { runoff: l.runoff } : {}), ...(l.verified ? { verified: l.verified } : {}) };
    if (Object.keys(audit).length) e.audit = audit;
    e.calls = l.calls;
    elements.push(e);
    byElement.set(e.id, e);
  }
  return {
    schema: "reglens.document/1",
    id: doc.id, title: doc.title, short: doc.short, issuer: doc.issuer, date: doc.date, url: doc.url, format: doc.format, pages: doc.pages.length || null,
    profile: st.profile,
    parse: {
      built_at: st.builtAt, raw_blocks: (doc.raw ?? doc.blocks).length, elements: elements.length, sections: st.sections.length,
      health: st.health ? { before: st.health.before, after: st.health.after } : null,
      checks: (st.audit?.checks ?? []).map(({ id, label, examined, flagged, fixed, verified, rolledBack }) => ({ id, label, examined, flagged, fixed, ...(verified ? { verified } : {}), ...(rolledBack ? { rolled_back: rolledBack } : {}) })),
      jev_calls: st.metrics?.calls ?? null,
    },
    kinds: Object.fromEntries(Object.entries(KIND).map(([role, kind]) => [kind, ROLES[role]])),
    outline: roots,
    elements,
  };
}

/** Internals for test harnesses (A/B prompt checks, gold-set evaluation). */
export const _internals = { features, pageContext, layoutCues, chunks, markMargins, ROLES, MODALITY, family, buildOutline, numberingStack };

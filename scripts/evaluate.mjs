// Scores the structured library against answer keys the pipeline never sees:
//   1. Federal Register HTML: the publisher's own <h2>–<h6> tags. Do consecutive tagged headings nest the
//      same way in our outline (child / sibling / higher)? And are the tagged headings still headings?
//   2. Statute PDFs: printed indentation. Each level of a statute is indented one step further, so the
//      first-line indent of a numbered provision (measured from the page's text margin) is its depth.
//      Jev and the numbering stack never see the indent. Quoted (inserted) text is skipped: it is indented
//      to its depth in the law it amends, not in the bill.
// Usage: node scripts/evaluate.mjs [library dir]
import { join } from "node:path";
import { Library, numberings } from "../src/library.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const lib = await new Library(process.argv[2] ?? join(process.env.REGLENS_DATA_DIR ?? join(ROOT, "data"), "library")).load();
const rel = (d) => (d > 0 ? "child" : d === 0 ? "sibling" : "higher");
const out = { fr: {}, statutes: {}, health: {} };

for (const [id, { doc, structure: st }] of lib.docs) {
  if (!st) continue;
  const h = st.health;
  out.health[id] = h ? { before: h.before.total, open: h.after.total, verified: h.after.verified ?? 0 } : null;
  if (doc.format === "html" && (doc.raw ?? doc.blocks).some((b) => /^h[2-6]$/.test(b.tag ?? ""))) {
    const tagged = (doc.raw ?? doc.blocks).filter((b) => /^h[2-6]$/.test(b.tag ?? ""));
    const kept = tagged.filter((b) => st.blocks[b.id]?.role === "heading");
    // The Federal Register stops at <h4>: "1.", "a.", and "i." headings all get h4. Two h4 headings with different
    // numbering styles can be parent and child, so the tags can't score that transition; it is left out.
    let agree = 0, n = 0, skipped = 0;
    for (let i = 1; i < kept.length; i++) {
      const p = kept[i - 1], c = kept[i];
      const fp = numberings(p.text)[0]?.fam, fc = numberings(c.text)[0]?.fam;
      if (p.tag === c.tag && p.tag === "h4" && fp !== fc) { skipped++; continue; }
      n++;
      if (rel(+c.tag[1] - +p.tag[1]) === rel(st.blocks[c.id].level - st.blocks[p.id].level)) agree++;
    }
    out.fr[id] = { tagged: tagged.length, still_headings: kept.length, nesting_agree: agree, transitions: n, skipped };
  }
  if (doc.format === "pdf" && ["statute", "bill"].includes(st.profile?.doc_type)) {
    // Text margin, per page parity (printed laws alternate left and right pages): the left edge that wrapped lines
    // return to, from wide multi-line blocks (10th percentile, so narrow margin notes don't count).
    const xs = new Map();
    for (const b of doc.raw ?? doc.blocks) {
      const w = doc.pages[b.page - 1]?.w;
      if (b.bbox && (b.lines ?? 1) > 1 && w && b.bbox[2] - b.bbox[0] > 0.4 * w) (xs.get(b.page % 2) ?? xs.set(b.page % 2, []).get(b.page % 2)).push(b.bbox[0]);
    }
    // The smallest left edge that recurs (3+ blocks): one-off outliers don't count.
    const parity = new Map([...xs].map(([k, v]) => { const n = new Map(); for (const x of v) n.set(Math.round(x), (n.get(Math.round(x)) ?? 0) + 1); return [k, Math.min(...[...n].filter(([, c]) => c >= 3).map(([x]) => x))]; }));
    const margin = new Map(doc.pages.map((p) => [p.n, parity.get(p.n % 2)]).filter(([, m]) => m != null));
    const rawX = new Map((doc.raw ?? doc.blocks).map((b) => [b.id, b.x_first]));
    const xOf = (b) => rawX.get(b.parts?.[0]?.id ?? b.id) ?? b.x_first;
    // Centered headings and TITLE / PART banners carry no indent information.
    const centered = (b) => { const w = doc.pages[b.page - 1]?.w; return w && b.bbox && Math.abs((b.bbox[0] + b.bbox[2]) / 2 - w / 2) < 0.05 * w && b.bbox[0] - margin.get(b.page) > 40; };
    const heads = doc.blocks.filter((b) => st.blocks[b.id]?.role === "heading" && xOf(b) != null && margin.has(b.page) && numberings(b.text).length && !/^[‘'"“]/.test(b.text.trim()) && !centered(b) && !/^(TITLE|PART|CHAPTER|Subpart)\b/.test(b.text.trim()));
    let agree = 0, n = 0;
    const misses = [];
    for (let i = 1; i < heads.length; i++) {
      const p = heads[i - 1], c = heads[i];
      const di = (xOf(c) - margin.get(c.page)) - (xOf(p) - margin.get(p.page));
      const want = di > 6 ? "child" : di < -6 ? "higher" : "sibling";
      const got = rel(st.blocks[c.id].level - st.blocks[p.id].level);
      n++;
      if (want === got) agree++;
      else if (misses.length < 8) misses.push(`${p.text.slice(0, 40)} → ${c.text.slice(0, 40)}: indent says ${want}, outline says ${got}`);
    }
    out.statutes[id] = { numbered_headings: heads.length, nesting_agree: agree, transitions: n, misses };
  }
}
const pctf = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "—");
let a = 0, n = 0;
for (const [id, r] of Object.entries(out.fr)) { a += r.nesting_agree; n += r.transitions; console.log(`FR tags   ${id.padEnd(26)} nesting ${r.nesting_agree}/${r.transitions} = ${pctf(r.nesting_agree, r.transitions)} (${r.skipped} h4→h4 style changes not scorable) · tagged headings still headings ${r.still_headings}/${r.tagged}`); }
console.log(`FR tags   ALL nesting ${a}/${n} = ${pctf(a, n)}`);
for (const [id, r] of Object.entries(out.statutes)) {
  console.log(`indent    ${id.padEnd(26)} nesting ${r.nesting_agree}/${r.transitions} = ${pctf(r.nesting_agree, r.transitions)} over ${r.numbered_headings} numbered headings`);
  for (const m of r.misses) console.log(`            ✗ ${m}`);
}
const H = Object.values(out.health).filter(Boolean);
console.log(`health    ${H.reduce((s, x) => s + x.before, 0)} → ${H.reduce((s, x) => s + x.open, 0)} open · ${H.reduce((s, x) => s + x.verified, 0)} confirmed by Jev`);

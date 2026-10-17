// Scores the blind role samples: LIB=data/library SAMPLE=eval/roles-sample.json GOLD=eval/roles-labels.json node eval/score-roles.mjs
import { Library } from "../src/library.mjs";
import { readFileSync } from "node:fs";
const lib = await new Library(process.env.LIB).load();
const sample = JSON.parse(readFileSync(process.env.SAMPLE));
const gold = JSON.parse(readFileSync(process.env.GOLD));
const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
let ok = 0, n = 0; const miss = [], absorbed = [];
for (const x of sample) {
  const { doc, structure: st } = lib.docs.get(x.doc);
  const want = norm(x.text);
  // Same page (PDF) or nearby position (HTML); the closest block in relative position wins ties.
  const near = (b) => Math.abs(doc.blocks.indexOf(b) / doc.blocks.length - x.index / x.of);
  const pool = doc.blocks.filter((b) => (x.page == null || b.page === x.page) && st.blocks[b.id]).sort((a, b) => near(a) - near(b));
  const exact = pool.find((b) => norm(b.text) === want);
  if (!exact) {
    const holder = pool.find((b) => norm(b.text).includes(want));
    absorbed.push(`#${x.n} ${x.doc} “${x.text.slice(0, 40)}” ${holder ? `is now part of a ${st.blocks[holder.id].role}: “${holder.text.slice(0, 70)}”` : "was split or rewritten"}`);
    continue;
  }
  n++;
  const l = st.blocks[exact.id];
  if (gold[x.n].split("|").includes(l.role)) ok++; else miss.push(`#${x.n} ${x.doc} gold ${gold[x.n]} · got ${l.role} ${Math.round(l.roleConf * 100)}% | ${x.text.slice(0, 70)}`);
}
console.log(`role accuracy: ${ok}/${n} blocks that still stand alone · ${absorbed.length} now absorbed into a larger block`);
for (const m of miss) console.log("  ✗", m);
for (const a of absorbed) console.log("  ⊂", a);

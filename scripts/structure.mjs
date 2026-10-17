// Re-structures documents with Jev (same DAG as the app's "↻ all") and prints parse health per document.
// Usage: node --env-file-if-exists=.env scripts/structure.mjs [doc-id ...] [--events file.ndjson]
// Writes data/library/<id>/structure.json. Restart the server afterwards so it reloads the library.
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { Jev } from "../src/jev.mjs";
import { Run } from "../src/run.mjs";
import { Library, structureDoc, ISSUE_TYPES } from "../src/library.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const DATA = process.env.REGLENS_DATA_DIR ?? join(ROOT, "data");
const args = process.argv.slice(2);
const evIdx = args.indexOf("--events");
const events = evIdx >= 0 ? createWriteStream(args.splice(evIdx, 2)[1]) : null;
const library = await new Library(join(DATA, "library")).load();
const ids = args.length ? args : [...library.docs.keys()];
const jev = new Jev({
  apiKey: process.env.TYPESAFE_API_KEY,
  baseUrl: process.env.TYPESAFE_BASE_URL,
  model: process.env.JEV_MODEL ?? "jev-latest",
  maxRps: Number(process.env.JEV_MAX_RPS ?? 35),
  maxInflight: Number(process.env.JEV_MAX_INFLIGHT ?? 32),
  cacheDir: process.env.JEV_CACHE_DIR ?? join(ROOT, ".cache"),
});
let fails = 0;
const run = new Run((ev) => {
  if (ev.t === "fail") fails++;
  events?.write(JSON.stringify(ev) + "\n");
});
const t0 = Date.now();
const results = await Promise.allSettled(ids.map((id) => structureDoc({ library, id, jev, run, emit: (ev) => events?.write(JSON.stringify(ev) + "\n") })));
const failed = ids.filter((id, i) => results[i].status === "rejected");
for (const id of failed) console.error(`✗ ${id}: ${results[ids.indexOf(id)].reason?.stack ?? results[ids.indexOf(id)].reason}`);
const m = run.metrics();
const pad = (s, n) => String(s).padEnd(n), lp = (s, n) => String(s).padStart(n);
const T = ISSUE_TYPES;
console.log(pad("doc", 26), lp("before", 7), lp("open", 5), lp("verif", 6), "  ", T.map((t) => lp(t.slice(0, 8), 9)).join(""), lp("blocks", 7), lp("sects", 6));
const tot = { before: 0, after: 0, verified: 0 };
for (const id of ids.filter((x) => !failed.includes(x))) {
  const st = library.docs.get(id).structure;
  const h = st.health;
  tot.before += h.before.total; tot.after += h.after.total; tot.verified += h.after.verified ?? 0;
  console.log(pad(id, 26), lp(h.before.total, 7), lp(h.after.total, 5), lp(h.after.verified ?? 0, 6), "  ", T.map((t) => lp(h.after[t], 9)).join(""), lp(st.metrics.blocks, 7), lp(st.metrics.sections, 6));
}
console.log(pad("TOTAL", 26), lp(tot.before, 7), lp(tot.after, 5), lp(tot.verified, 6));
console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)}s · ${m.calls} calls (${m.cacheHits} cached) · ${m.predicates} decisions · ${m.inputTokens} new tokens · $${m.costUsd.toFixed(3)} · ${fails} failed calls`);
events?.end();

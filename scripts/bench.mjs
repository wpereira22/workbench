// Benchmark the compute layer: runs each program cold (every predicate live on Jev) and then
// warm (served from the materialized cache). Planning and insights are excluded so the numbers
// isolate Jev. Requires a structured library (data/library/*/structure.json).
// Usage: npm run bench                 # the example programs in programs/
//        npm run bench -- data/runs/<runId>.json   # a program the planner compiled
import { readFile, writeFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jev } from "../src/jev.mjs";
import { Run } from "../src/run.mjs";
import { prepareProgram, executeProgram, computeViews, setShortNames } from "../src/program.mjs";
import { Library } from "../src/library.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const DATA = process.env.REGLENS_DATA_DIR ?? join(ROOT, "data");
const library = await new Library(join(DATA, "library")).load();
setShortNames(Object.fromEntries([...library.docs.values()].map(({ doc }) => [doc.id, doc.short])));
if (![...library.docs.values()].some((d) => d.structure)) {
  console.error("The library isn't structured yet: open the app once (or POST /api/library/structure).");
  process.exit(1);
}

const files = process.argv.slice(2).length ? process.argv.slice(2) : (await readdir(join(ROOT, "programs"))).filter((f) => f.endsWith(".json")).sort().map((f) => join(ROOT, "programs", f));
const programs = await Promise.all(files.map(async (f) => { const j = JSON.parse(await readFile(f, "utf8")); return { name: j.question ?? f, program: j.program }; }));

const cacheDir = await mkdtemp(join(tmpdir(), "reglens-bench-"));
const jev = new Jev({
  apiKey: process.env.TYPESAFE_API_KEY,
  baseUrl: process.env.TYPESAFE_BASE_URL,
  model: process.env.JEV_MODEL ?? "jev-latest",
  maxRps: Number(process.env.JEV_MAX_RPS ?? 35),
  maxInflight: Number(process.env.JEV_MAX_INFLIGHT ?? 32),
  cacheDir,
});

const rows = [];
try {
  for (const { name, program } of programs) {
    const { program: p } = prepareProgram(program, [...library.docs.keys()]);
    for (const pass of ["cold", "warm"]) {
      const run = new Run(() => {});
      const { rows: data, edges, nodesById } = await executeProgram({ program: p, library, jev, run, emit: () => {} });
      computeViews(p, data, edges, nodesById);
      rows.push({ question: name, pass, units: data.length, edges: edges.length, ...run.metrics() });
    }
  }
} finally {
  await rm(cacheDir, { recursive: true, force: true });
}

const pad = (s, n) => String(s).slice(0, n).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
console.log(`\nmodel ${rows[0]?.model}   library ${library.docs.size} documents\n`);
console.log(pad("program", 44), pad("pass", 5), lpad("rows", 5), lpad("wall", 8), lpad("1st", 7), lpad("calls", 6), lpad("preds", 6), lpad("p50", 5), lpad("p95", 5), lpad("tokens", 8), lpad("cost $", 8), lpad("edges", 6));
for (const r of rows) {
  console.log(pad(r.question, 44), pad(r.pass, 5), lpad(r.units, 5), lpad(`${(r.wallMs / 1000).toFixed(2)}s`, 8), lpad(r.firstResultMs != null ? `${r.firstResultMs}ms` : "-", 7),
    lpad(r.calls, 6), lpad(r.predicates, 6), lpad(r.p50 ?? "-", 5), lpad(r.p95 ?? "-", 5), lpad(r.inputTokens, 8), lpad(r.costUsd.toFixed(4), 8), lpad(r.edges, 6));
}
const out = join(DATA, `bench-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
await writeFile(out, JSON.stringify(rows, null, 1));
console.log(`\nfull results → ${out}`);

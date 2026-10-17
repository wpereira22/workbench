import { createServer } from "node:http";
import { readFile, writeFile, mkdir, appendFile, readdir, rm } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { extname, join } from "node:path";
import { Jev } from "./src/jev.mjs";
import { Run } from "./src/run.mjs";
import { Library, structureDoc, exportDocument, SCHEMA_INFO } from "./src/library.mjs";
import { prepareProgram, executeProgram, computeViews, datasetForClient, setShortNames, evalCond, BASE_FIELDS } from "./src/program.mjs";
import { planProgram, extendProgram, writeInsights, fallbackInsights, planner } from "./src/planner.mjs";

const ROOT = new URL(".", import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 4317);
const DATA = process.env.REGLENS_DATA_DIR ?? join(ROOT, "data");
const LIB = join(DATA, "library");
const PROGRAMS = join(ROOT, "programs");
await mkdir(join(DATA, "runs"), { recursive: true });
await mkdir(PROGRAMS, { recursive: true });

const jev = new Jev({
  apiKey: process.env.TYPESAFE_API_KEY,
  baseUrl: process.env.TYPESAFE_BASE_URL,
  model: process.env.JEV_MODEL ?? "jev-latest",
  maxRps: Number(process.env.JEV_MAX_RPS ?? 35),
  maxInflight: Number(process.env.JEV_MAX_INFLIGHT ?? 32),
  cacheDir: process.env.JEV_CACHE_DIR ?? join(ROOT, ".cache"),
});
const manifest = JSON.parse(await readFile(join(ROOT, "sources/manifest.json"), "utf8"));
const library = await new Library(LIB).load();
const refreshNames = () => setShortNames(Object.fromEntries([...library.docs.values()].map(({ doc }) => [doc.id, doc.short])));
refreshNames();

async function loadPrograms() {
  const files = (await readdir(PROGRAMS)).filter((f) => f.endsWith(".json")).sort();
  return Promise.all(files.map(async (f) => ({ id: f.replace(/\.json$/, ""), ...JSON.parse(await readFile(join(PROGRAMS, f), "utf8")) })));
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

const runLineage = new Map(); // runId -> Map(callId -> record)

const questionWithFollowups = (saved) => (saved.followups?.length ? `${saved.question}\n\nFollow-ups the user asked by going deeper: ${saved.followups.map((f) => `${f.focus ? `[on ${f.focus}] ` : ""}${f.request || "(sharpen the answer)"}`).join("; ")}` : saved.question);

/** "Go deeper": run the program as it stands (from the cache) to see how Jev answered, have Claude add layers
 *  under the chosen branch, and save the grown program. New nodes are a new generation, asked in their own calls. */
async function extendSaved(saved, ext, emit, run) {
  const quiet = () => {};
  const { program } = prepareProgram(saved.program, [...library.docs.keys()]);
  const loud = run.emit;
  run.emit = quiet; // the pre-run is bookkeeping (served from the cache); the client sees only the real run
  let rows, nodesById;
  try { ({ rows, nodesById } = await executeProgram({ program, library, jev, run, emit: quiet })); } finally { run.emit = loud; }
  const stats = {};
  for (const n of program.nodes) {
    const d = (stats[n.id] = {});
    for (const r of rows) {
      const v = r.values[n.id];
      if (!v) continue;
      const k = n.kind === "noul" ? (v.p >= 0.5 ? "yes" : "no") : n.kind === "choice" ? v.choice : n.levels[Math.max(0, Math.min(n.levels.length - 1, Math.round(v.score)))];
      d[k] = (d[k] ?? 0) + 1;
    }
  }
  let focus = null, inFocus = rows.filter((r) => Object.keys(r.values).length);
  const fn = ext.focus?.node && nodesById.get(ext.focus.node);
  if (fn) {
    const key = String(ext.focus.key);
    const conds = fn.kind === "noul" ? [{ field: fn.id, op: key === "yes" ? "yes" : "no", values: [], threshold: 0.5 }]
      : fn.kind === "choice" ? [{ field: fn.id, op: "in", values: [key], threshold: 0 }]
      : [{ field: fn.id, op: "gte", values: [], threshold: +key - 0.5 }, { field: fn.id, op: "lte", values: [], threshold: +key + 0.5 }];
    inFocus = rows.filter((r) => conds.every((c) => evalCond(c, r, nodesById)));
    focus = { node: fn.id, conds, n: inFocus.length, label: ext.focus.label ?? `${fn.label} = ${key}` };
  }
  const step = Math.max(1, Math.floor(inFocus.length / 24));
  const samples = inFocus.filter((_, i) => i % step === 0).slice(0, 24).map((r) => ({ id: r.id, text: (r.leadIn ? `${r.leadIn} … ` : "") + r.text.slice(0, 420) }));
  const out = await extendProgram({ question: questionWithFollowups(saved), program, stats, focus, request: ext.request, samples, emit, run });

  const gen = 1 + Math.max(0, ...saved.program.nodes.map((n) => n.gen ?? 0));
  const taken = new Set([...saved.program.nodes.map((n) => n.id), ...Object.keys(BASE_FIELDS[program.unit.level])]);
  const rename = new Map();
  const added = [];
  for (const n of out.nodes ?? []) {
    let id = n.id, k = 2;
    while (taken.has(id)) id = `${n.id}_${k++}`;
    taken.add(id);
    rename.set(n.id, id);
    const when = (n.when ?? []).map((c) => ({ ...c, field: rename.get(c.field) ?? c.field }));
    const gated = when.some((c) => c.field === focus?.node || added.some((a) => a.id === c.field));
    added.push({ ...n, id, gen, when: focus && !gated ? [...focus.conds, ...when] : when });
  }
  if (!added.length) throw new Error("Claude Code proposed no new layers.");
  saved.program.nodes.push(...added);
  const viewIds = new Set(saved.program.views.map((v) => v.id));
  for (const v of out.views ?? []) {
    let id = v.id;
    while (viewIds.has(id)) id += "_x";
    viewIds.add(id);
    const f = (x) => rename.get(x) ?? x;
    saved.program.views.push({ ...v, id, x: f(v.x), y: f(v.y), measure_field: f(v.measure_field), where: (v.where ?? []).map((c) => ({ ...c, field: f(c.field) })) });
  }
  (saved.followups ??= []).push({ at: new Date().toISOString(), focus: focus?.label ?? null, request: ext.request?.trim() || "", rationale: out.rationale, nodes: added.map((n) => n.id) });
  await writeFile(join(PROGRAMS, `${saved.id}.json`), JSON.stringify({ question: saved.question, author: saved.author, program: saved.program, followups: saved.followups, lastRun: saved.lastRun }, null, 2));
  emit({ t: "extended", rationale: out.rationale, nodes: added.map((n) => n.id), focus: focus?.label ?? null });
}
let busy = null;

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".png": "image/png" };
const json = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const readBody = async (req) => {
  let s = "";
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
};
function stream(res) {
  res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
  return (ev) => res.write(JSON.stringify(ev) + "\n");
}
const lock = (res, what) => {
  if (busy) return json(res, 409, { error: `Busy: ${busy} is still running.` }), false;
  busy = what;
  return true;
};

function extract(ids) {
  return new Promise((resolve, reject) => {
    const p = spawn("python3", [join(ROOT, "scripts/extract.py"), join(ROOT, "sources/manifest.json"), join(ROOT, "sources/raw"), LIB, ...ids]);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.split("\n").filter(Boolean).pop() ?? `extract failed (${code})`))));
  });
}

/** New document (downloaded or uploaded): save it, extract it, and structure it, streaming every step. A file that
 *  isn't a PDF or web page, or that yields no text, is rejected and nothing is left behind. */
async function ingest({ buf, name, meta, emit, autoTitle = false }) {
  const isPdf = buf.subarray(0, 5).toString() === "%PDF-";
  const head = buf.subarray(0, 4000).toString().toLowerCase();
  if (!isPdf && !/<html|<!doctype html|<body/.test(head)) throw new Error("That isn't a PDF or a web page. (Some sites answer automated downloads with a challenge page; download it in your browser and upload the file instead.)");
  let id = slug(meta.short || name.replace(/\.\w+$/, "") || meta.title || "doc") || `doc-${Date.now()}`;
  if (manifest.documents.some((d) => d.id === id)) id = `${id}-${Date.now().toString(36)}`;
  const file = `${id}.${isPdf ? "pdf" : "html"}`;
  const entry = { id, title: meta.title || name.replace(/\.\w+$/, "").replace(/[-_]+/g, " "), short: meta.short || (meta.title || name).replace(/\.\w+$/, "").slice(0, 28), issuer: meta.issuer || "Uploaded", date: meta.date || new Date().toISOString().slice(0, 10), format: isPdf ? "pdf" : "html", file, url: meta.url ?? null, ...(autoTitle ? { auto_title: true } : {}) };
  await writeFile(join(ROOT, "sources/raw", file), buf);
  manifest.documents.push(entry);
  await writeFile(join(ROOT, "sources/manifest.json"), JSON.stringify(manifest, null, 2));
  const undo = async () => {
    manifest.documents = manifest.documents.filter((d) => d.id !== id);
    await writeFile(join(ROOT, "sources/manifest.json"), JSON.stringify(manifest, null, 2));
    await rm(join(ROOT, "sources/raw", file), { force: true });
    await rm(join(LIB, id), { recursive: true, force: true });
    library.docs.delete(id);
  };
  try {
    emit({ t: "add_status", status: "extracting", id });
    const log = (await extract([id])).trim();
    const doc = JSON.parse(await readFile(join(LIB, id, "doc.json"), "utf8"));
    if (!doc.blocks.length) throw new Error("No text found in that file.");
    if (autoTitle && doc.title) Object.assign(entry, { title: doc.title, short: doc.title.slice(0, 28) });
    await writeFile(join(ROOT, "sources/manifest.json"), JSON.stringify(manifest, null, 2));
    emit({ t: "add_status", status: "extracted", id, log, pages: doc.pages.length, blocks: doc.blocks.length, ocr: doc.pages.filter((p) => p.ocr).length });
    await library.load();
    refreshNames();
    elementIndex = null;
    emit({ t: "add_status", status: "structuring", id, library: library.summary() });
    await structure([id], { fresh: false, emit });
  } catch (err) {
    await undo();
    throw err;
  }
}

// ───── the aggregated parsed data: every element of every document, filterable, exportable ─────
let elementIndex = null;
function elements() {
  if (elementIndex) return elementIndex;
  const all = [];
  for (const [id, e] of library.docs) {
    const x = exportDocument(e);
    if (!x) continue;
    const secs = new Map(e.structure.sections.map((s) => [s.id, s]));
    const text = new Map(x.elements.map((el) => [el.id, el.text]));
    for (const el of x.elements) {
      if (el.kind === "page_furniture") continue;
      const s = secs.get(el.section);
      all.push({
        doc: id, short: x.short, doc_type: x.profile?.doc_type ?? null, issuer: x.issuer, year: x.date?.slice(0, 4) ?? null, format: x.format,
        id: el.id, kind: el.kind, text: el.text, path: el.path.slice(-3).join(" › "), enumerator: el.enumerator, term: el.term ?? el.term_of ?? null, level: el.level ?? null,
        lead_in: el.lead_in ? text.get(el.lead_in) ?? null : null, modality: el.labels.modality ?? null, deadline: (el.labels.deadline_p ?? 0) >= 0.5,
        role_p: el.labels.role_p, section_role: s?.role ?? null, topics: Object.entries(s?.topics ?? {}).filter(([, p]) => p >= 0.5).map(([k]) => k), page: el.source.page ?? null,
      });
    }
  }
  return (elementIndex = all);
}
const LENSES = {
  all: { label: "Everything", test: () => true },
  definitions: { label: "Definitions", test: (r) => r.kind === "definition" || r.modality === "defines" },
  obligations: { label: "Obligations", test: (r) => r.modality === "must" || r.modality === "must_not" },
  permissions: { label: "Permissions & exemptions", test: (r) => r.modality === "may" },
  deadlines: { label: "Deadlines", test: (r) => r.deadline },
  questions: { label: "Questions", test: (r) => r.kind === "question" },
  fields: { label: "Fields", test: (r) => r.kind === "field" },
  tables: { label: "Table rows", test: (r) => r.kind === "table_or_figure" && r.text.includes(" | ") },
  headings: { label: "Outline", test: (r) => r.kind === "heading" },
};
const FACETS = ["doc", "kind", "modality", "section_role", "doc_type", "year", "topics"];
function queryData(params) {
  const lens = LENSES[params.get("lens")] ?? LENSES.all;
  const want = Object.fromEntries(FACETS.map((f) => [f, params.getAll(f).filter(Boolean)]));
  const q = (params.get("q") ?? "").trim().toLowerCase();
  const hit = (r, f) => !want[f].length || (f === "topics" ? r.topics.some((t) => want[f].includes(t)) : want[f].includes(String(r[f])));
  const base = elements().filter((r) => lens.test(r) && (!q || r.text.toLowerCase().includes(q) || r.term?.toLowerCase().includes(q)));
  const rows = base.filter((r) => FACETS.every((f) => hit(r, f)));
  // Each facet counts over everything the other filters allow, so choices stay visible.
  const facets = Object.fromEntries(FACETS.map((f) => {
    const c = {};
    for (const r of base) if (FACETS.every((g) => g === f || hit(r, g))) for (const v of f === "topics" ? r.topics : [r[f]]) if (v != null && v !== "") c[v] = (c[v] ?? 0) + 1;
    return [f, Object.entries(c).sort((a, b) => b[1] - a[1])];
  }));
  return { lens: params.get("lens") ?? "all", lenses: Object.fromEntries(Object.entries(LENSES).map(([k, v]) => [k, { label: v.label, n: elements().filter(v.test).length }])), total: rows.length, facets, rows };
}
const csvCell = (v) => { const s = Array.isArray(v) ? v.join("; ") : v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

async function structure(ids, { fresh, emit }) {
  elementIndex = null;
  const run = new Run(emit, { fresh });
  const tick = setInterval(() => emit({ t: "metrics", m: run.metrics() }), 300);
  try {
    await Promise.all(ids.map((id) => structureDoc({ library, id, jev, run, emit })));
  } finally {
    clearInterval(tick);
  }
  emit({ t: "metrics", m: run.metrics() });
  emit({ t: "lib_all_done", library: library.summary() });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  try {
    if (path === "/api/state") {
      return json(res, 200, {
        collection: manifest.collection,
        keys: { typesafe: jev.configured },
        models: { jev: jev.model },
        planner: { cli: planner.cli, model: planner.lastModel, error: planner.lastError },
        library: library.summary(),
        schema: { roles: Object.keys(SCHEMA_INFO.ROLES), levels: SCHEMA_INFO.LEVELS, modality: Object.keys(SCHEMA_INFO.MODALITY), sectionRoles: Object.keys(SCHEMA_INFO.SECTION_ROLES), topics: SCHEMA_INFO.TOPICS },
        programs: (await loadPrograms()).map(({ id, question, author, program, lastRun }) => ({ id, question, author, title: program.title, level: program.unit.level, nodes: program.nodes.length, layers: prepareProgram(program, [...library.docs.keys()]).program.layers.length, lastRun: lastRun ?? null })),
      });
    }

    // The document model: typed elements + outline + labels + provenance, as a download.
    const exp = path.match(/^\/api\/doc\/([\w-]+)\/export$/);
    if (exp) {
      const e = library.docs.get(exp[1]);
      const out = e && exportDocument(e);
      if (!out) return json(res, 404, { error: "not structured" });
      res.writeHead(200, { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${exp[1]}.reglens.json"` });
      return res.end(JSON.stringify(out, null, 1));
    }
    if (path === "/api/data") {
      const out = queryData(url.searchParams);
      const fmtOut = url.searchParams.get("format");
      const cols = ["doc", "short", "kind", "term", "text", "lead_in", "modality", "deadline", "section_role", "path", "page", "year", "doc_type", "topics", "id"];
      if (fmtOut === "csv") {
        res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="reglens-${out.lens}.csv"` });
        return res.end([cols.join(","), ...out.rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n"));
      }
      if (fmtOut === "json") {
        res.writeHead(200, { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="reglens-${out.lens}.json"` });
        return res.end(JSON.stringify(out.rows, null, 1));
      }
      const offset = Number(url.searchParams.get("offset") ?? 0), limit = Math.min(500, Number(url.searchParams.get("limit") ?? 200));
      return json(res, 200, { ...out, rows: out.rows.slice(offset, offset + limit) });
    }
    if (path === "/api/export") {
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Content-Disposition": 'attachment; filename="library.reglens.ndjson"' });
      for (const e of library.docs.values()) { const out = exportDocument(e); if (out) res.write(JSON.stringify(out) + "\n"); }
      return res.end();
    }

    if (path.startsWith("/api/doc/")) {
      const v = library.view(decodeURIComponent(path.split("/").pop()));
      return v ? json(res, 200, v) : json(res, 404, { error: "not found" });
    }

    if (path.startsWith("/api/program/")) {
      const p = (await loadPrograms()).find((x) => x.id === decodeURIComponent(path.split("/").pop()));
      return p ? json(res, 200, p) : json(res, 404, { error: "not found" });
    }

    const pageMatch = path.match(/^\/pages\/([\w-]+)\/(\d+)\.jpg$/);
    if (pageMatch) {
      const f = join(LIB, pageMatch[1], "pages", `${pageMatch[2]}.jpg`);
      if (!existsSync(f)) return json(res, 404, { error: "no page" });
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=86400" });
      return createReadStream(f).pipe(res);
    }

    if (path === "/api/key" && req.method === "POST") {
      const { key } = await readBody(req);
      const probe = await fetch(`${jev.baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
      if (!probe.ok) return json(res, 400, { error: `TypeSafe rejected the key (HTTP ${probe.status}).` });
      jev.apiKey = key;
      const envPath = join(ROOT, ".env");
      const prev = existsSync(envPath) ? await readFile(envPath, "utf8") : "";
      await writeFile(envPath, /^TYPESAFE_API_KEY=.*$/m.test(prev) ? prev.replace(/^TYPESAFE_API_KEY=.*$/m, `TYPESAFE_API_KEY=${key}`) : `${prev}TYPESAFE_API_KEY=${key}\n`, { mode: 0o600 });
      return json(res, 200, { ok: true });
    }

    // Prong 1: structuring. Re-run Jev's structuring DAG over some or all documents, streaming labels.
    if (path === "/api/library/structure" && req.method === "POST") {
      const { ids, fresh } = await readBody(req);
      if (!lock(res, "structuring")) return;
      const emit = stream(res);
      try {
        await structure(ids?.length ? ids : [...library.docs.keys()], { fresh: Boolean(fresh), emit });
      } catch (err) {
        emit({ t: "fatal", error: err.message, status: err.status });
      } finally {
        busy = null;
        res.end();
      }
      return;
    }

    // Add a document by URL or by upload: save, extract (code), structure (Jev), all streamed.
    if (path === "/api/library/add" && req.method === "POST") {
      const b = await readBody(req);
      if (!/^https?:\/\//.test(b.url ?? "")) return json(res, 400, { error: "Give a URL to a PDF or web page." });
      if (!lock(res, "adding a document")) return;
      const emit = stream(res);
      try {
        emit({ t: "add_status", status: "downloading" });
        const r = await fetch(b.url, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh) RegLens/0.3" } });
        if (!r.ok) throw new Error(`Download failed: HTTP ${r.status}`);
        await ingest({ buf: Buffer.from(await r.arrayBuffer()), name: new URL(b.url).pathname.split("/").pop(), meta: b, emit });
      } catch (err) {
        emit({ t: "fatal", error: err.message });
      } finally {
        busy = null;
        res.end();
      }
      return;
    }
    // Remove a document: its source file, its extraction and structure, and its manifest entry.
    const del = path.match(/^\/api\/library\/([\w-]+)$/);
    if (del && req.method === "DELETE") {
      const id = del[1];
      const entry = manifest.documents.find((d) => d.id === id);
      if (!entry) return json(res, 404, { error: "No such document." });
      if (!lock(res, "removing a document")) return;
      try {
        manifest.documents = manifest.documents.filter((d) => d.id !== id);
        await writeFile(join(ROOT, "sources/manifest.json"), JSON.stringify(manifest, null, 2));
        await rm(join(ROOT, "sources/raw", entry.file), { force: true });
        await rm(join(LIB, id), { recursive: true, force: true });
        library.docs.delete(id);
        elementIndex = null;
        refreshNames();
        return json(res, 200, { ok: true, library: library.summary() });
      } finally {
        busy = null;
      }
    }
    if (path === "/api/library/upload" && req.method === "POST") {
      if (!lock(res, "adding a document")) return;
      const emit = stream(res);
      try {
        const parts = [];
        let size = 0;
        for await (const c of req) { size += c.length; if (size > 80e6) throw new Error("That file is over 80 MB."); parts.push(c); }
        const name = decodeURIComponent(req.headers["x-file-name"] ?? "upload.pdf");
        emit({ t: "add_status", status: "uploaded", bytes: size, name });
        await ingest({ buf: Buffer.concat(parts), name, meta: { title: url.searchParams.get("title") ?? "", short: url.searchParams.get("short") ?? "", issuer: url.searchParams.get("issuer") ?? "", date: url.searchParams.get("date") ?? "" }, emit, autoTitle: !url.searchParams.get("title") });
      } catch (err) {
        emit({ t: "fatal", error: err.message });
      } finally {
        busy = null;
        res.end();
      }
      return;
    }

    // Prong 2: intelligence. Plan (Claude Code) if needed, then execute (Jev), views (code), insights (Claude Code).
    if (path === "/api/run" && req.method === "POST") {
      const body = await readBody(req);
      if (!lock(res, "an analysis")) return;
      const emit = stream(res);
      const run = new Run(emit, { fresh: Boolean(body.fresh) });
      const runId = new Date().toISOString().replace(/[:.]/g, "-");
      const tick = setInterval(() => emit({ t: "metrics", m: run.metrics() }), 300);
      try {
        emit({ t: "run", runId });
        let saved = body.programId ? (await loadPrograms()).find((p) => p.id === body.programId) : null;
        if (!saved) {
          const question = body.question?.trim();
          if (!question) throw Object.assign(new Error("Ask a question first."), { status: 400 });
          emit({ t: "stage", stage: "plan", status: "running" });
          const program = await planProgram({ question, library, emit, run, scope: body.scope });
          const id = `${new Date().toISOString().slice(0, 10)}-${slug(program.title || question)}`;
          saved = { id, question, author: `planned by Claude Code${planner.lastModel ? ` (${planner.lastModel})` : ""}`, program };
          await writeFile(join(PROGRAMS, `${id}.json`), JSON.stringify({ question, author: saved.author, program }, null, 2));
          emit({ t: "stage", stage: "plan", status: "done" });
          emit({ t: "saved_program", id });
        } else if (body.extend) {
          emit({ t: "stage", stage: "plan", status: "running" });
          // Several rounds: each one re-runs the grown program, so Claude sees the new layers' answers and goes a level further.
          const rounds = Math.max(1, Math.min(5, body.extend.rounds ?? 1));
          for (let i = 0; i < rounds; i++) {
            if (rounds > 1) emit({ t: "round", i: i + 1, of: rounds });
            await extendSaved(saved, i ? { focus: body.extend.focus, request: "" } : body.extend, emit, run);
          }
          emit({ t: "stage", stage: "plan", status: "done" });
        } else emit({ t: "stage", stage: "plan", status: "skipped" });

        // A scope chosen in the Data view holds even if the plan drifts from it.
        const sc = body.scope;
        if (sc?.docs?.length) saved.program.unit.docs = sc.docs.filter((d) => library.docs.has(d));
        if (saved.program.unit.level === "paragraph") {
          const where = saved.program.unit.where ??= [];
          if (sc?.roles?.length && !where.some((c) => c.field === "role")) where.push({ field: "role", op: "in", values: sc.roles, threshold: 0 });
          if (sc?.modality?.length && !where.some((c) => c.field === "modality")) where.push({ field: "modality", op: "in", values: sc.modality, threshold: 0 });
        }
        const { program, warnings } = prepareProgram(saved.program, [...library.docs.keys()]);
        emit({ t: "program", id: saved.id, program, warnings, author: saved.author, question: saved.question, followups: saved.followups ?? [] });

        emit({ t: "stage", stage: "exec", status: "running" });
        const { rows, edges, nodesById } = await executeProgram({ program, library, jev, run, emit });
        emit({ t: "stage", stage: "exec", status: "done" });
        emit({ t: "dataset", dataset: datasetForClient(program, rows), edges });

        const views = computeViews(program, rows, edges, nodesById);
        emit({ t: "views", views });

        // Insights are cached by what Claude would read: same program + same aggregates = same answer.
        const insightKey = createHash("sha256").update(JSON.stringify({ writer: 3, q: saved.question, p: saved.program, v: views.map(({ id, type, bars, cells, bins, value, n, total, covered }) => ({ id, type, bars: bars?.map((b) => [b.key, b.value, b.n]), cells: cells?.map((c) => [c.x, c.y, c.n]), bins: bins?.map((b) => b.n), value, n, total, covered })) })).digest("hex").slice(0, 16);
        const insightFile = join(DATA, "insights", `${insightKey}.json`);
        let insights;
        if (body.insights === false) insights = fallbackInsights(views, "Written insights were skipped for this run.");
        else if (!body.fresh && existsSync(insightFile)) {
          insights = { ...JSON.parse(await readFile(insightFile, "utf8")), cached: true };
          emit({ t: "stage", stage: "insights", status: "done" });
        } else {
          emit({ t: "stage", stage: "insights", status: "running" });
          try {
            insights = await writeInsights({ question: questionWithFollowups(saved), program, views, rows, edges, nodesById, emit, run });
            insights.model = run.llm.model ?? planner.lastModel;
            await mkdir(join(DATA, "insights"), { recursive: true });
            await writeFile(insightFile, JSON.stringify(insights));
          } catch (err) {
            emit({ t: "warn", message: `Insights: ${err.message}` });
            insights = fallbackInsights(views, `Claude Code could not write insights (${err.message}). These are computed from the views.`);
          }
          emit({ t: "stage", stage: "insights", status: "done" });
        }
        emit({ t: "insights", insights });

        const m = run.metrics();
        emit({ t: "done", m });
        runLineage.set(runId, run.lineage);
        if (runLineage.size > 5) runLineage.delete(runLineage.keys().next().value);
        const lastRun = { at: new Date().toISOString(), rows: rows.length, predicates: m.predicates, wallMs: m.wallMs, costUsd: m.costUsd };
        await writeFile(join(PROGRAMS, `${saved.id}.json`), JSON.stringify({ question: saved.question, author: saved.author, program: saved.program, followups: saved.followups, lastRun }, null, 2));
        await writeFile(join(DATA, "runs", `${runId}.json`), JSON.stringify({ runId, programId: saved.id, question: saved.question, metrics: m, views, insights }));
        await appendFile(join(DATA, "runs.jsonl"), JSON.stringify({ at: lastRun.at, runId, programId: saved.id, rows: rows.length, edges: edges.length, metrics: m }) + "\n");
      } catch (err) {
        console.error(err);
        emit({ t: "fatal", error: err.message, status: err.status, provider: err.provider });
      } finally {
        clearInterval(tick);
        busy = null;
        res.end();
      }
      return;
    }

    if (path.startsWith("/api/lineage/")) {
      const id = path.split("/").pop();
      for (const m of [...runLineage.values()].reverse()) if (m.has(id)) return json(res, 200, m.get(id));
      const rec = library.lineage(id);
      return rec ? json(res, 200, rec) : json(res, 404, { error: "not found" });
    }

    const file = join(ROOT, "public", path === "/" ? "index.html" : path);
    if (!file.startsWith(join(ROOT, "public")) || !existsSync(file)) return json(res, 404, { error: "not found" });
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(await readFile(file));
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: err.message });
    else res.end();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const n = library.docs.size, s = [...library.docs.values()].filter((d) => d.structure).length;
  console.log(`RegLens → http://localhost:${PORT}   library ${s}/${n} structured · jev ${jev.configured ? "ready" : "NO KEY"} · planner: Claude Code CLI`);
});

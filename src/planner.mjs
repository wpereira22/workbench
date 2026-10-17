// Claude, through the local Claude Code CLI (your subscription login, no API key):
//   plan      question -> program (nodes, layers, relations, views), schema-validated
//   insights  computed aggregates + cited rows -> findings. Claude never reads the raw corpus here.
// Jev does all the per-unit judgment in between.
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { PROGRAM_SCHEMA, BASE_FIELDS, shortName } from "./program.mjs";

const CLI = process.env.CLAUDE_BIN ?? "claude";
const MODEL = process.env.PLANNER_MODEL ?? null; // null = whatever your Claude Code defaults to
const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + " …" : s ?? "");

export const planner = { cli: CLI, model: MODEL, lastModel: null, lastError: null };

/** Runs `claude -p` with a JSON schema; streams reasoning deltas; resolves with the structured output. */
function claudeStructured({ system, prompt, schema, emit, phase, run, effort }) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--json-schema", JSON.stringify(schema),
      "--tools", "", "--no-session-persistence", "--system-prompt", system];
    if (MODEL) args.push("--model", MODEL);
    if (effort) args.push("--effort", effort);
    const child = spawn(CLI, args, { cwd: tmpdir(), env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "", err = "", result = null, chars = 0;
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "stream_event" && ev.event?.type === "content_block_delta") {
          const dl = ev.event.delta;
          if (dl.type === "thinking_delta" && dl.thinking) emit({ t: "llm_thinking", phase, delta: dl.thinking });
          else if (dl.type === "text_delta" || dl.type === "input_json_delta") {
            const piece = dl.text ?? dl.partial_json ?? "";
            chars += piece.length;
            emit({ t: "llm_progress", phase, chars, delta: piece });
          }
        } else if (ev.type === "result") result = ev;
      }
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(new Error(`Could not start the Claude Code CLI (${CLI}): ${e.message}`)));
    child.on("close", (code) => {
      if (!result) return reject(new Error(`Claude Code exited (${code}) without a result. ${clip(err.trim(), 300)}`));
      const model = Object.keys(result.modelUsage ?? {})[0] ?? null;
      planner.lastModel = model ?? planner.lastModel;
      if (result.is_error) {
        const msg = result.result ?? "unknown error";
        planner.lastError = /authenticat|login|oauth/i.test(msg) ? "Claude Code is not logged in. Run `claude` in a terminal and type /login." : msg;
        return reject(Object.assign(new Error(planner.lastError), { status: 401, provider: "claude" }));
      }
      planner.lastError = null;
      const u = result.usage ?? {};
      run.llm.calls++;
      run.llm.inputTokens += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      run.llm.outputTokens += u.output_tokens ?? 0;
      run.llm.costUsd += result.total_cost_usd ?? 0; // notional on a subscription
      run.llm.model = model;
      emit({ t: "llm_done", phase, model, ms: result.duration_ms });
      const out = result.structured_output ?? (() => { try { return JSON.parse(result.result); } catch { return null; } })();
      if (!out) return reject(new Error(`Claude returned no structured ${phase}.`));
      resolve(out);
    });
    child.stdin.end(prompt);
  });
}

const PLANNER_SYSTEM = `You design analysis programs for RegLens, a semantic compute engine over a library of digital-asset and currency regulation: statutes, bills, proposed and final rules, agency guidance, staff statements, executive orders, and policy reports, from PDFs and web pages.

The library is already structured. A decision model (Jev) has labeled every block of every document (heading, body, list item, footnote, page furniture...), built each document's outline, and labeled each paragraph's modality (must, must_not, may, defines, context) and each section's role. Those labels are base fields you can filter and group on for free.

Jev is also the engine your program runs on. Jev never writes text. Given one unit (a paragraph, a section, or a whole document) and a question, it returns a calibrated decision:
- noul: probability that a yes/no statement is true
- choice: one option from a fixed set you define (with probabilities)
- score: a position on an ordered rubric of 2-6 levels you define
Each answer takes ~200ms and costs almost nothing, so programs can afford thousands. Jev judges one unit at a time; cross-unit relationships come only from the relations step, which judges pairs.

Turn the user's question into a program that restructures the library into a dataset that answers it: pick the unit of analysis, define the columns Jev fills in, gate narrow questions behind earlier answers with \`when\` conditions (nested ifs), optionally discover relationships between rows, and choose views.

What makes a good program:
- Decompose the question into structure, not retrieval. The answer should fall out of counts, cross-tabs, and edges.
- Build a decision tree as deep as the question needs. Depth is cheap: a node runs only on the rows that pass its conditions, so a question five layers down may run on a few dozen rows. Typical programs have 6-20 nodes in 3-7 layers.
- Layer 1 is usually one cheap gate (it runs on every row, so keep layer 1 to one or two nodes). Deeper layers classify what passed.
- Give branches their own follow-ups. After a choice node, an option that matters can open its own sub-questions (when: field in [that option]), and those can nest again; options that don't matter simply stop. Stop a branch when another question would not change the answer.
- Choice options must be mutually exclusive and cover the space (add a catch-all).
- Questions must be answerable from the unit text plus its document's scope_note. When an answer depends on scope, dates, or defined terms a paragraph won't restate, write doc_notes for those documents and reference \`scope_note\` in the question. Notes must be short, accurate, and factual.
- Prefer paragraph units for obligations and definitions, sections for topic-level comparisons, documents for regime-level comparisons. Filter paragraph programs with base fields (e.g. modality in [must, must_not, may, defines], section_role not_in [impact_analysis, request_for_comment]) and document lists to stay under ~1,500 units.
- Use relations for overlap, conflict, implementation, or "how does X relate to Y" questions. Block pairs by a choice node and use anchor_docs when one document is the subject; each candidate row is judged against its pairs_per_row most similar partners (3 is a good default; max_pairs up to 2000). With relations on, the derived field "linked" (yes/no) and the "coverage" view become available.
- Choose 3-6 views: a stat for the headline number, heatmaps for two dimensions, bars for rankings, a histogram for a score, a network when relations are on, a table for rows to read. Views may only reference fields that exist. Base fields like doc, issuer, doc_type, year, legal_force are good axes.

Conditions: {field, op, values, threshold}. field is a node id or base field. Ops: yes/no (probability vs threshold; use 0.5), in/not_in (option keys or base values), gte/lte (numeric). Unused parts: values [] and threshold 0.

Base fields by unit level:
${Object.entries(BASE_FIELDS).map(([lvl, f]) => `- ${lvl}: ${Object.entries(f).map(([k, d]) => `${k} (${d})`).join("; ")}`).join("\n")}`;

function catalog(library) {
  return [...library.docs.values()].map(({ doc, structure: st }) => {
    const p = st?.profile ?? {};
    const secs = (st?.sections ?? []).filter((s) => s.level <= 2 && s.blocks.length).slice(0, 18).map((s) => `    - ${"  ".repeat(Math.max(0, s.level - 1))}${clip(s.title, 90)} (${s.blocks.length} blocks${s.role ? `, ${s.role}` : ""})`).join("\n");
    const paras = st ? Object.values(st.blocks).filter((b) => b.role === "body" || b.role === "list_item").length : 0;
    return `- id: ${doc.id} | ${doc.short} | ${doc.title} | issuer ${doc.issuer} | ${doc.date} | ${doc.format}${doc.pages.length ? `, ${doc.pages.length} pages` : ""} | Jev: ${p.doc_type ?? "?"}, force ${p.legal_force_level ?? "?"}/4 | ${paras} paragraphs\n${secs}`;
  }).join("\n");
}

export async function planProgram({ question, library, emit, run, scope }) {
  const scoped = scope && (scope.docs?.length || scope.roles?.length || scope.modality?.length)
    ? `\n\nThe user scoped this question: ${[scope.docs?.length ? `only documents ${scope.docs.join(", ")}` : "", scope.roles?.length ? `only pieces whose role is ${scope.roles.join(", ")} (paragraph rows, filter on the base field "role")` : "", scope.modality?.length ? `only pieces whose modality is ${scope.modality.join(", ")}` : ""].filter(Boolean).join("; ")}. Respect it.`
    : "";
  const prompt = `Library (use these document ids):\n${catalog(library)}${scoped}\n\nQuestion: ${question}\n\nDesign the program.`;
  return claudeStructured({ system: PLANNER_SYSTEM, prompt, schema: PROGRAM_SCHEMA, emit, phase: "plan", run, effort: process.env.PLANNER_EFFORT ?? "medium" });
}

// ───────────────────────────── extend ─────────────────────────────

const EXTEND_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rationale", "nodes", "views"],
  properties: {
    rationale: { type: "string", description: "One or two sentences: what the new layers find out and why they sharpen the answer" },
    nodes: { ...PROGRAM_SCHEMA.properties.nodes, description: "Only the new nodes, in order. Each must be gated on the focus condition or on another new node" },
    views: { ...PROGRAM_SCHEMA.properties.views, description: "1-3 new views about the new nodes; [] if none" },
  },
};

const EXTEND_SYSTEM = `You extend an existing RegLens analysis program with deeper layers. ${PLANNER_SYSTEM.split("\n\nTurn the user's question")[0]}

The program has already run. You see its questions (nodes) with how Jev answered them across the rows, and sample rows from the branch being drilled into. Add new nodes that go deeper:
- Each new node runs only where it is gated: put the focus condition (given below) or a condition on another new node in its \`when\`. Reference existing node ids, base fields, or new nodes defined earlier in your list.
- Nest as deep as is useful, and give important options their own follow-ups. 1-10 new nodes.
- New ids must be snake_case and must not reuse existing ids or base field names.
- Write questions Jev can answer from one unit's text plus its document's scope_note.
- Add 1-3 views that show what the new layers found (often a heatmap of a new node against the branch's parent, bars, or a table of rows to read).`;

/** Adds layers to a program that has run: under one branch (focus), or wherever it is shallowest. */
export async function extendProgram({ question, program, stats, focus, request, samples, emit, run }) {
  const nodes = program.nodes.map((n) => ({
    id: n.id, label: n.label, kind: n.kind, depth: n.depth, question: n.question, when: n.when,
    answers: stats[n.id] ?? {}, ...(n.kind === "choice" ? { options: n.options.map((o) => o.key) } : n.kind === "score" ? { levels: n.levels } : {}),
  }));
  const ask = request?.trim()
    ? `The user's follow-up: ${request.trim()}`
    : focus
      ? "The user wants to go deeper here without a specific question. Add the layers that would most sharpen the answer to the original question for these rows."
      : "Find where the program is shallow (large catch-all buckets such as other/none, options holding most rows, yes-branches with no follow-up) and add the layers that would most sharpen the answer to the original question. Gate every new node on the branch it refines.";
  const prompt = [
    `Original question: ${question}`,
    `Program: ${program.title}. Rows: ${program.unit.level}s${program.unit.docs.length ? ` from ${program.unit.docs.join(", ")}` : ""}.`,
    `Existing nodes with Jev's answer counts:\n${JSON.stringify(nodes, null, 1)}`,
    focus ? `Focus: the ${focus.n} rows where ${focus.label}. Focus condition to gate on: ${JSON.stringify(focus.conds)}` : "Focus: none (whole program).",
    samples.length ? `Sample rows from the focus:\n${samples.map((r) => `- [${r.id}] ${r.text}`).join("\n")}` : "",
    ask,
    "Return only the new nodes and views.",
  ].filter(Boolean).join("\n\n");
  return claudeStructured({ system: EXTEND_SYSTEM, prompt, schema: EXTEND_SCHEMA, emit, phase: "plan", run, effort: process.env.PLANNER_EFFORT ?? "medium" });
}

// ───────────────────────────── insights ─────────────────────────────

export const INSIGHTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "key_points", "insights", "caveats", "next_questions"],
  properties: {
    answer: { type: "string", description: "2-5 sentences that answer the question as asked, in its own terms and in plain language. If it asks which/what/where/who/how, say the actual things (requirements, provisions, parties, numbers, deadlines) rather than how many there are. Use a count only to size the answer, never as the answer." },
    key_points: {
      type: "array",
      description: "The concrete items the question asks for, most important first (3-10). Each is one specific thing stated plainly with its substance, e.g. a requirement and its number or deadline, a party and its duty, a gap and what is missing.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["point", "unit_ids"],
        properties: {
          point: { type: "string", description: "One sentence, specific and self-contained; name the document or provision where it helps" },
          unit_ids: { type: "array", items: { type: "string" }, description: "Evidence row ids that state it" },
        },
      },
    },
    insights: {
      type: "array",
      description: "2-4 supporting patterns behind the answer (concentrations, gaps, overlaps, shifts). These come after the answer and support it.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "body", "view_ids", "unit_ids"],
        properties: {
          title: { type: "string", description: "A plain statement of the finding" },
          body: { type: "string", description: "2-3 sentences: what it means for the question, with the numbers that support it" },
          view_ids: { type: "array", items: { type: "string" } },
          unit_ids: { type: "array", items: { type: "string" }, description: "Row ids from the evidence list that support this" },
        },
      },
    },
    caveats: { type: "array", items: { type: "string" } },
    next_questions: { type: "array", items: { type: "string" }, description: "2-3 follow-up questions this dataset makes worth asking" },
  },
};

const INSIGHTS_SYSTEM = `You are the analyst at the end of a RegLens pipeline. A decision model (Jev) has read every unit of regulatory text and filled in a dataset for the user's question. You see the question, the program that built the dataset, aggregate views, and evidence rows: the actual text of the most relevant units with Jev's answers.

Answer the question the user asked. Lead with substance: the specific requirements, provisions, parties, numbers, deadlines, gaps, or differences the question is about, drawn from the evidence rows and cited by row id. A reader should be able to act on the answer without reading the charts. Statistics come second: use them to size, rank, or qualify the answer, not as the answer itself. Write like a sharp policy or compliance lead briefing a colleague: plain, concrete, no jargon about the pipeline.

If the question asks for a complete list and the evidence is a sample of the rows, give the most important items and say the full set is in the table (with its row count).

Rules: every number must come from the views or the evidence text. Cite only view ids and row ids that appear in the input. If the evidence can't fully answer the question, say what it does show and what is missing. Never write about how the evidence was packaged (which rows were quoted, sampled, or shown by id): the reader sees the full table, so refer to provisions by section and page instead. Jev's labels are probabilistic; mention uncertainty only where it changes the conclusion.`;

function compactView(v) {
  const r = (x) => (typeof x === "number" ? Math.round(x * 100) / 100 : x);
  if (v.error) return { id: v.id, title: v.title, error: v.error };
  const head = { id: v.id, type: v.type, title: v.title, why: v.why, x: v.x, y: v.y, measure: v.measure };
  if (v.type === "bar") return { ...head, bars: v.bars.slice(0, 15).map((b) => ({ label: b.label, value: r(b.value), n: b.n })) };
  if (v.type === "heatmap") return { ...head, cells: v.cells.filter((c) => c.n).map((c) => ({ x: c.x, y: c.y, value: r(c.value), n: c.n })) };
  if (v.type === "histogram") return { ...head, bins: v.bins.map((b) => ({ label: b.label, n: b.n })) };
  if (v.type === "stat") return { ...head, value: r(v.value), n: v.n, of: v.of };
  if (v.type === "coverage") return { ...head, bars: v.bars.slice(0, 15).map((b) => ({ label: b.label, share_covered: r(b.value), covered: b.covered, of: b.n })) };
  if (v.type === "table") return { ...head, cols: v.cols, rows: v.rows.slice(0, 12).map((x) => ({ id: x.id, label: x.label, cells: x.cells })) };
  if (v.type === "network") {
    const byType = {};
    for (const e of v.edges) byType[e.type] = (byType[e.type] ?? 0) + 1;
    return { ...head, edge_counts: byType, sample_edges: v.edges.slice(0, 25).map((e) => ({ a: e.a, b: e.b, type: e.type, conf: r(e.conf) })) };
  }
  return head;
}

export async function writeInsights({ question, program, views, rows, edges, nodesById, emit, run }) {
  const want = new Set();
  // The rows that answer the question best are the ones that passed the most layers of the program (every
  // gate said yes): the most specific matches. Take those first, spread across documents.
  const depth = (r) => Object.keys(r.values).reduce((d, k) => Math.max(d, nodesById.get(k)?.depth ?? 0), 0);
  const yeses = (r) => Object.entries(r.values).filter(([k, v]) => nodesById.get(k)?.kind === "noul" && v.p >= 0.5).length;
  const ranked = [...rows].filter((r) => Object.keys(r.values).length).sort((a, b) => depth(b) - depth(a) || yeses(b) - yeses(a));
  // Rows the views point at come first, so every row a table view lists is quoted in full.
  for (const v of views) {
    if (v.type === "table") v.rows.slice(0, 12).forEach((x) => want.add(x.id));
    if (v.type === "bar" || v.type === "coverage") v.bars.slice(0, 4).forEach((b) => (b.ids ?? []).slice(0, 3).forEach((id) => want.add(id)));
    if (v.type === "heatmap") [...v.cells].sort((a, b) => b.n - a.n).slice(0, 4).forEach((c) => c.ids.slice(0, 2).forEach((id) => want.add(id)));
    if (v.type === "stat") v.ids.slice(0, 3).forEach((id) => want.add(id));
  }
  [...edges].sort((a, b) => (b.conf ?? 0) - (a.conf ?? 0)).slice(0, 10).forEach((e) => { want.add(e.a); want.add(e.b); });
  const byDoc = new Map();
  for (const r of ranked) (byDoc.get(r.doc) ?? byDoc.set(r.doc, []).get(r.doc)).push(r);
  const queues = [...byDoc.values()];
  for (let i = 0; want.size < 150 && queues.some((q) => q.length); i++) { const q = queues[i % queues.length]; if (q.length) want.add(q.shift().id); }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const evidence = [...want].slice(0, 150).map((id) => {
    const row = byId.get(id);
    const values = {};
    for (const [k, v] of Object.entries(row.values)) {
      const n = nodesById.get(k);
      values[k] = n.kind === "noul" ? Math.round(v.p * 100) / 100 : n.kind === "choice" ? v.choice : n.levels[Math.round(v.score)];
    }
    return { id, source: `${shortName(row.doc)} · ${row.sectionHeading ?? ""}`, text: clip(row.text, 600), values };
  });
  const payload = {
    question,
    program: { title: program.title, thesis: program.thesis, unit: program.unit, nodes: program.nodes.map(({ id, label, kind, question: q, options, levels, when }) => ({ id, label, kind, question: q, options: options.map((o) => o.key), levels, when })) },
    dataset: { rows: rows.length, evaluated_per_node: Object.fromEntries(program.nodes.map((n) => [n.id, rows.filter((r) => r.values[n.id]).length])), relation_edges: edges.length },
    views: views.map(compactView),
    evidence,
  };
  const out = await claudeStructured({
    system: INSIGHTS_SYSTEM,
    prompt: JSON.stringify(payload),
    schema: INSIGHTS_SCHEMA,
    emit,
    phase: "insights",
    run,
    effort: process.env.INSIGHTS_EFFORT ?? "medium",
  });
  const validViews = new Set(views.map((v) => v.id));
  for (const i of out.insights) {
    i.view_ids = i.view_ids.filter((id) => validViews.has(id));
    i.unit_ids = i.unit_ids.filter((id) => byId.has(id));
  }
  for (const k of out.key_points ?? []) k.unit_ids = k.unit_ids.filter((id) => byId.has(id));
  return out;
}

export function fallbackInsights(views, reason) {
  const insights = [];
  for (const v of views) {
    if (v.type === "stat") insights.push({ title: v.title, body: `${v.measure === "share" ? Math.round(v.value * 100) + "%" : Math.round(v.value * 100) / 100} (${v.n} of ${v.of} rows).`, view_ids: [v.id], unit_ids: v.ids.slice(0, 5) });
    if (v.type === "bar" && v.bars.length) insights.push({ title: v.title, body: `Largest: ${v.bars.slice(0, 3).map((b) => `${b.label} (${Math.round(b.value * 100) / 100})`).join(", ")}.`, view_ids: [v.id], unit_ids: v.bars[0].ids.slice(0, 5) });
    if (v.type === "heatmap") {
      const top = [...v.cells].sort((a, b) => b.value - a.value)[0];
      if (top?.n) insights.push({ title: v.title, body: `Densest cell: ${top.x} × ${top.y} (${top.n} rows).`, view_ids: [v.id], unit_ids: top.ids.slice(0, 5) });
    }
    if (v.type === "network") insights.push({ title: v.title, body: `${v.edges.length} relationships: ${v.types.map((t) => `${v.edges.filter((e) => e.type === t).length} ${t}`).join(", ")}.`, view_ids: [v.id], unit_ids: [] });
  }
  return { answer: reason ?? "Computed directly from the views.", key_points: [], insights, caveats: [], next_questions: [], fallback: true };
}

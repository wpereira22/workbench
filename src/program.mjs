// A "program" is what the planner compiles a question into:
//   units      which pieces of the corpus become rows (paragraphs, sections or documents)
//   nodes      Jev predicates (noul / choice / score), each gated by `when` conditions on
//              earlier nodes, so they stack into layers of nested ifs
//   relations  an optional pairwise predicate that discovers edges between rows
//   views      aggregations over the resulting dataset (bar, heatmap, histogram, network, stat, table)
// Execution turns unstructured text into a table with lineage; views and insights read the table.

import { exportDocument } from "./library.mjs";

// ───────────────────────────── schema ─────────────────────────────

const str = { type: "string" };
const strArr = { type: "array", items: str };
const obj = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

const CONDITION = obj({
  field: { ...str, description: "A node id or a base field name" },
  op: { type: "string", enum: ["yes", "no", "in", "not_in", "gte", "lte"] },
  values: { ...strArr, description: "For in / not_in: option keys or base-field values. Otherwise []" },
  threshold: { type: "number", description: "For yes/no: probability cutoff (use 0.5). For gte/lte: the number. Otherwise 0" },
});
const OPTION = obj({ key: { ...str, description: "snake_case key" }, description: str });

export const PROGRAM_SCHEMA = obj({
  title: { ...str, description: "Short name for this analysis" },
  thesis: { ...str, description: "One or two sentences: how this structure answers the question" },
  unit: obj({
    level: { type: "string", enum: ["paragraph", "section", "document"] },
    docs: { ...strArr, description: "Document ids to include; [] means all" },
    where: { type: "array", items: CONDITION, description: "Filters on base fields only" },
    rationale: str,
  }),
  doc_notes: {
    type: "array",
    description: "Scope facts Jev needs but a single unit won't state (who a rule covers, key defined terms). Injected into every Jev call for that document as `scope_note`. [] if none",
    items: obj({ doc: str, note: str }),
  },
  nodes: {
    type: "array",
    items: obj({
      id: { ...str, description: "snake_case, unique, not a base field name" },
      label: { ...str, description: "2-4 word column name" },
      kind: { type: "string", enum: ["noul", "choice", "score"] },
      question: { ...str, description: "Self-contained question Jev answers about one unit" },
      options: { type: "array", items: OPTION, description: "choice only (2-10 options, mutually exclusive, include an 'other' or 'none' when needed); [] otherwise" },
      levels: { ...strArr, description: "score only: 2-6 ordered level descriptions, low to high; [] otherwise" },
      when: { type: "array", items: CONDITION, description: "All must hold for the node to run on a unit. Reference only earlier nodes or base fields. [] = runs on every unit" },
      why: str,
    }),
  },
  relations: obj({
    enabled: { type: "boolean" },
    label: str,
    question: { ...str, description: "How requirement A relates to requirement B, answered as a choice" },
    options: { type: "array", items: OPTION },
    none_option: { ...str, description: "The option key meaning 'no meaningful relationship'" },
    candidates: { type: "array", items: CONDITION, description: "Which rows can participate" },
    anchor_docs: { ...strArr, description: "If non-empty, every pair must include a row from one of these documents" },
    block_by: { ...str, description: "Only pair rows that share this field's value (a choice node or base field), or '' for no blocking" },
    cross_document: { type: "boolean", description: "Only pair rows from different documents" },
    pairs_per_row: { type: "integer", description: "For each candidate row, how many of its most similar partners Jev judges (lexical similarity picks them). 3 is a good default" },
    max_pairs: { type: "integer", description: "Overall cap on pairs, at most 2000" },
  }),
  views: {
    type: "array",
    items: obj({
      id: str,
      type: { type: "string", enum: ["bar", "heatmap", "histogram", "network", "stat", "table", "coverage"], description: "coverage = share of rows (after where) that found the strongest relation option (the first option) with some partner, grouped by x; needs relations" },
      title: str,
      why: { ...str, description: "What the reader should learn from it" },
      x: { ...str, description: "bar/heatmap/coverage: categorical field; histogram: numeric field; network: field used to color nodes; else ''. With relations on, derived fields 'linked' (yes/no: found the strongest relation option, e.g. implements) and 'related' (yes/no: any relation) are available" },
      y: { ...str, description: "heatmap: second categorical field; else ''" },
      where: { type: "array", items: CONDITION },
      measure: { type: "string", enum: ["count", "mean", "share"] },
      measure_field: { ...str, description: "For mean: a numeric field (noul or score node). For table: sort field. Else ''" },
      top: { type: "integer", description: "Max bars / rows to show; 0 for default" },
    }),
  },
});

// ───────────────────────────── base fields ─────────────────────────────

const DOC_FIELDS = {
  doc: "document id",
  doc_type: "statute, bill, final_rule, proposed_rule, interpretive_guidance, staff_statement, executive_order, policy_report, press_release",
  issuer: "Congress, White House, Treasury, Federal Reserve, SEC, OCC, FinCEN, IRS, NYDFS",
  legal_force: "none, staff_views, interpretation, proposed, binding",
  year: "publication year, e.g. 2025",
  format: "pdf, html, web",
};
export const BASE_FIELDS = {
  paragraph: {
    ...DOC_FIELDS,
    section: "title of the paragraph's section (from the outline Jev built)",
    section_role: "scope, definitions, requirements, prohibitions, exemptions, procedures, supervision_enforcement, discussion, request_for_comment, impact_analysis, other",
    role: "body, list_item, definition_entry (glossary or definition-list entry), question (FAQ, Q&A, or request-for-comment question), quote, field (a labeled value such as \"Frequency: Annual\")",
    modality: "must, must_not, may, defines, context",
    deadline: "sets a deadline, time limit or frequency (yes/no)",
    page: "PDF page number (PDFs only)",
  },
  section: {
    ...DOC_FIELDS,
    section: "section title",
    section_role: "scope, definitions, requirements, prohibitions, exemptions, procedures, supervision_enforcement, discussion, request_for_comment, impact_analysis, other",
  },
  document: DOC_FIELDS,
};

// ───────────────────────────── validation ─────────────────────────────

/** Normalizes a program, drops what can't run, and computes layers. Returns { program, warnings }. */
export function prepareProgram(input, docIdList) {
  const warnings = [];
  const p = structuredClone(input);
  const docIds = new Set(docIdList);
  p.unit.docs = (p.unit.docs ?? []).filter((d) => docIds.has(d) || (warnings.push(`unknown document "${d}"`), false));
  p.doc_notes = (p.doc_notes ?? []).filter((n) => docIds.has(n.doc) || (warnings.push(`doc note for unknown document "${n.doc}"`), false));
  const base = BASE_FIELDS[p.unit.level];
  p.unit.where = (p.unit.where ?? []).filter((c) => base[c.field] || (warnings.push(`unit filter on unknown base field "${c.field}"`), false));

  const nodes = new Map();
  for (const n of p.nodes ?? []) {
    if (!/^[a-z][a-z0-9_]*$/.test(n.id) || nodes.has(n.id) || base[n.id]) { warnings.push(`dropped node with bad or duplicate id "${n.id}"`); continue; }
    if (n.kind === "choice" && (n.options?.length ?? 0) < 2) { warnings.push(`dropped choice node "${n.id}" with <2 options`); continue; }
    if (n.kind === "score" && ((n.levels?.length ?? 0) < 2 || n.levels.length > 10)) { warnings.push(`dropped score node "${n.id}" with bad levels`); continue; }
    n.when = (n.when ?? []).filter((c) => nodes.has(c.field) || base[c.field] || (warnings.push(`node "${n.id}": dropped condition on "${c.field}" (must be an earlier node or base field)`), false));
    n.depth = 1 + Math.max(0, ...n.when.filter((c) => nodes.has(c.field)).map((c) => nodes.get(c.field).depth));
    nodes.set(n.id, n);
  }
  p.nodes = [...nodes.values()];
  const maxDepth = Math.max(0, ...p.nodes.map((n) => n.depth));
  p.layers = Array.from({ length: maxDepth }, (_, i) => p.nodes.filter((n) => n.depth === i + 1));

  const known = (f) => !f || nodes.has(f) || base[f] || (["linked", "related"].includes(f) && p.relations?.enabled);
  const r = p.relations;
  if (r?.enabled) {
    r.candidates = (r.candidates ?? []).filter((c) => known(c.field));
    r.anchor_docs = (r.anchor_docs ?? []).filter((d) => docIds.has(d));
    if (!known(r.block_by)) { warnings.push(`relations: unknown block_by "${r.block_by}"`); r.block_by = ""; }
    r.max_pairs = Math.max(1, Math.min(2000, r.max_pairs || 1200));
    r.pairs_per_row = Math.max(1, Math.min(10, r.pairs_per_row || 3));
    if ((r.options?.length ?? 0) < 2) { warnings.push("relations disabled: needs at least 2 options"); r.enabled = false; }
  }
  p.views = (p.views ?? []).filter((v) => {
    const ok = known(v.x) && known(v.y) && known(v.measure_field) && (v.where ?? []).every((c) => known(c.field));
    if (!ok) warnings.push(`dropped view "${v.title}" (unknown field)`);
    if ((v.type === "network" || v.type === "coverage") && !p.relations?.enabled) { warnings.push(`dropped ${v.type} view "${v.title}" (relations disabled)`); return false; }
    return ok;
  });
  return { program: p, warnings };
}

// ───────────────────────────── field access ─────────────────────────────

const levelLabel = (levels, score) => levels[Math.max(0, Math.min(levels.length - 1, Math.round(score)))];

/** Categorical value of a field for a row, or null if unknown / not evaluated. */
export function catValue(row, field, nodesById) {
  if (field in row.base) return row.base[field];
  if (row.derived && field in row.derived) return row.derived[field];
  const v = row.values[field];
  if (!v) return null;
  const n = nodesById.get(field);
  if (n.kind === "noul") return v.p >= 0.5 ? "yes" : "no";
  if (n.kind === "choice") return v.choice;
  return levelLabel(n.levels, v.score);
}

/** Numeric value: noul -> probability, score -> level index (may be fractional), base numeric. */
export function numValue(row, field, nodesById) {
  if (field in row.base) return typeof row.base[field] === "number" ? row.base[field] : null;
  if (row.derived && field in row.derived) return null;
  const v = row.values[field];
  if (!v) return null;
  const n = nodesById.get(field);
  if (n.kind === "noul") return v.p;
  if (n.kind === "score") return v.score;
  return v.conf ?? null;
}

export function evalCond(c, row, nodesById) {
  const t = c.threshold || 0.5;
  switch (c.op) {
    case "yes": {
      const x = numValue(row, c.field, nodesById);
      if (x != null && !(c.field in row.base)) return x >= t;
      return catValue(row, c.field, nodesById) === "yes";
    }
    case "no": {
      const x = numValue(row, c.field, nodesById);
      if (x != null && !(c.field in row.base)) return x < t;
      return catValue(row, c.field, nodesById) === "no";
    }
    case "in": return c.values.includes(catValue(row, c.field, nodesById));
    case "not_in": { const v = catValue(row, c.field, nodesById); return v != null && !c.values.includes(v); }
    case "gte": { const x = numValue(row, c.field, nodesById); return x != null && x >= c.threshold; }
    case "lte": { const x = numValue(row, c.field, nodesById); return x != null && x <= c.threshold; }
  }
  return false;
}

export const describeCond = (c) =>
  ({ yes: `${c.field} = yes`, no: `${c.field} = no`, in: `${c.field} ∈ {${c.values.join(", ")}}`, not_in: `${c.field} ∉ {${c.values.join(", ")}}`, gte: `${c.field} ≥ ${c.threshold}`, lte: `${c.field} ≤ ${c.threshold}` })[c.op];

// ───────────────────────────── units ─────────────────────────────

let SHORT = {};
export const setShortNames = (m) => (SHORT = m);
export const shortName = (id) => SHORT[id] ?? id;
const FORCE = ["none", "staff_views", "interpretation", "proposed", "binding"];
const CONTENT = new Set(["body", "list_item", "definition_entry", "question", "quote", "field"]);
const clipT = (t, n) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

/** Rows come from the structured library: paragraphs are Jev-labeled body/list blocks, sections come
 *  from the outline Jev built, documents are whole files. Each row keeps a pointer to its source block. */
export function resolveUnits(program, library) {
  const { level, docs, where } = program.unit;
  const units = [];
  for (const [id, { doc, structure: st }] of library.docs) {
    if ((docs.length && !docs.includes(id)) || !st) continue;
    const p = st.profile ?? {};
    const docBase = { doc: id, doc_type: p.doc_type ?? null, issuer: doc.issuer, legal_force: FORCE[p.legal_force_level] ?? null, year: doc.date?.slice(0, 4) ?? null, format: doc.format };
    const byId = new Map(doc.blocks.map((b) => [b.id, b]));
    const content = (bids) => bids.filter((bid) => CONTENT.has(st.blocks[bid]?.role));
    // A list item read alone ("(B) chapter 2 of title I…") needs the sentence that introduces it.
    const leadIn = level === "paragraph" ? new Map(exportDocument({ doc, structure: st }).elements.filter((e) => e.lead_in).map((e) => [e.id, byId.get(e.lead_in)?.text])) : new Map();
    if (level === "document") {
      const text = doc.blocks.filter((b) => CONTENT.has(st.blocks[b.id]?.role) || st.blocks[b.id]?.role === "heading").map((b) => b.text).join("\n");
      const first = doc.blocks.find((b) => CONTENT.has(st.blocks[b.id]?.role));
      units.push({ id, doc: id, docTitle: doc.title, section: null, label: doc.short, text, base: docBase, src: { doc: id, block: first?.id ?? null, page: first?.page ?? null } });
      continue;
    }
    for (const s of st.sections) {
      const cb = content(s.blocks);
      if (!cb.length) continue;
      const path = [...s.path, s.title].join(" › ");
      const sbase = { ...docBase, section: s.title, section_role: s.role ?? null };
      if (level === "section") {
        const b0 = byId.get(s.heading ?? cb[0]);
        units.push({ id: `${id}/${s.id}`, doc: id, docTitle: doc.title, section: `${id}/${s.id}`, sectionHeading: path, label: `${doc.short} · ${clipT(s.title, 44)}`,
          text: cb.map((bid) => byId.get(bid).text).join("\n"), base: sbase, src: { doc: id, block: b0.id, page: b0.page ?? null } });
        continue;
      }
      for (const bid of cb) {
        const b = byId.get(bid);
        const lab = st.blocks[bid];
        units.push({ id: `${id}/${bid}`, doc: id, docTitle: doc.title, section: `${id}/${s.id}`, sectionHeading: path,
          label: b.page ? `${doc.short} p.${b.page}` : `${doc.short} · ${clipT(s.title, 28)}`, text: b.text, ...(leadIn.get(bid) ? { leadIn: clipT(leadIn.get(bid), 400) } : {}),
          base: { ...sbase, role: lab.role, modality: lab.modality ?? null, deadline: lab.deadline == null ? null : lab.deadline >= 0.5 ? "yes" : "no", page: b.page ? String(b.page) : null },
          src: { doc: id, block: bid, page: b.page ?? null } });
      }
    }
  }
  const noNodes = new Map();
  return units.filter((u) => where.every((c) => evalCond(c, { base: u.base, values: {} }, noNodes)));
}

// ───────────────────────────── execution ─────────────────────────────

const PARA_BATCH = 12; // paragraphs per packed request
const PAIR_BATCH = 6; // pairs per packed request
const clip = (s, n) => (s.length > n ? s.slice(0, n) + " …" : s);

// Packed calls quote the target text in the instruction and keep the batch as context.
// Pointing at `units[i]` by index alone drifts badly (measured: 9 of 12 wrong on Reg S-P),
// while quoting matches one-call-per-paragraph answers at ~30% fewer tokens.
function jevQuestion(node, target, leadIn) {
  const q = target != null ? { question: `${node.question} Answer about the paragraph in \`target\` only; \`units\` in the state is surrounding context.${leadIn ? " `target` continues the sentence in `lead_in`." : ""}`, target, ...(leadIn ? { lead_in: leadIn } : {}) } : node.question;
  if (node.kind === "noul") return { type: "noul", instructions: q };
  if (node.kind === "choice") return { type: "choice", instructions: q, criteria: Object.fromEntries(node.options.map((o) => [o.key, o.description])) };
  return { type: "score", instructions: q, criteria: node.levels };
}

function readAnswer(node, a) {
  if (!a) return null;
  if (node.kind === "noul") return { p: a.noul };
  if (node.kind === "choice") return { choice: a.choice, conf: a.confidence, probs: a.probabilities };
  return { score: a.score, conf: a.confidence, probs: a.probabilities };
}

function batchesFor(level, units, notes) {
  const note = (doc) => (notes.has(doc) ? { scope_note: notes.get(doc) } : {});
  if (level !== "paragraph") {
    return units.map((u) => ({ id: u.id, units: [u], state: level === "document" ? { document: u.docTitle, ...note(u.doc), text: u.text.slice(0, 100000) } : { document: u.docTitle, ...note(u.doc), section: u.sectionHeading, text: u.text.slice(0, 60000) } }));
  }
  const bySection = new Map();
  for (const u of units) (bySection.get(u.section) ?? bySection.set(u.section, []).get(u.section)).push(u);
  const out = [];
  for (const [sid, list] of bySection) {
    for (let i = 0; i < list.length; i += PARA_BATCH) {
      const chunk = list.slice(i, i + PARA_BATCH);
      out.push({ id: `${sid}#${i / PARA_BATCH}`, units: chunk, state: { document: chunk[0].docTitle, ...note(chunk[0].doc), section: chunk[0].sectionHeading, units: chunk.map((u) => u.text) } });
    }
  }
  return out;
}

export async function executeProgram({ program, library, jev, run, emit }) {
  const nodesById = new Map(program.nodes.map((n) => [n.id, n]));
  const units = resolveUnits(program, library);
  const rows = new Map(units.map((u) => [u.id, { ...u, values: {}, trace: {} }]));
  emit({ t: "units", level: program.unit.level, units: units.map((u) => ({ id: u.id, doc: u.doc, label: u.label, snippet: clip(u.text, 160), base: u.base, src: u.src })) });

  const level = program.unit.level;
  const batches = batchesFor(level, units, new Map(program.doc_notes.map((n) => [n.doc, n.note])));

  // Each batch flows through the layers on its own, so the DAG streams instead of waiting on barriers.
  await Promise.all(
    batches.map(async (batch) => {
      for (let li = 0; li < program.layers.length; li++) {
        // Layers added later by "go deeper" (gen > 0) are asked in their own calls, so the calls of the
        // program as it was stay byte-identical and keep coming from the cache.
        const gens = [...new Set(program.layers[li].map((n) => n.gen ?? 0))].sort((a, b) => a - b);
        for (const gen of gens) {
          const layerNodes = program.layers[li].filter((n) => (n.gen ?? 0) === gen);
          const qs = {};
          const plan = [];
          const skipped = [];
          batch.units.forEach((u, i) => {
            const row = rows.get(u.id);
            for (const node of layerNodes) {
              const failed = node.when.find((c) => !evalCond(c, row, nodesById));
              if (failed) {
                row.trace[node.id] = { status: "skipped", because: describeCond(failed) };
                skipped.push({ unit: u.id, node: node.id });
                continue;
              }
              const key = level === "paragraph" ? `${node.id}__${i}` : node.id;
              qs[key] = jevQuestion(node, level === "paragraph" ? u.text : null, level === "paragraph" ? u.leadIn : null);
              plan.push({ key, unit: u.id, node: node.id });
            }
          });
          if (skipped.length) emit({ t: "skipped", layer: li + 1, items: skipped });
          if (!plan.length) continue;
          for (const p of plan) rows.get(p.unit).trace[p.node] = { status: "running" };
          const rec = await run.call(jev, {
            stage: `L${li + 1}`,
            target: batch.id,
            state: batch.state,
            questions: qs,
            meta: { layer: li + 1, units: [...new Set(plan.map((p) => p.unit))], perNode: plan.reduce((a, p) => ((a[p.node] = (a[p.node] ?? 0) + 1), a), {}) },
          });
          const items = [];
          for (const p of plan) {
            const row = rows.get(p.unit);
            const v = rec ? readAnswer(nodesById.get(p.node), rec.answers?.[p.key]) : null;
            if (v) {
              row.values[p.node] = v;
              row.trace[p.node] = { status: "done", call: rec.id, key: p.key };
            } else row.trace[p.node] = { status: "error" };
            items.push({ unit: p.unit, node: p.node, v });
          }
          run.markResult();
          emit({ t: "answers", layer: li + 1, call: rec?.id ?? null, items });
        }
      }
    }),
  );

  const edges = program.relations?.enabled ? await executeRelations({ program, rows, nodesById, jev, run, emit }) : [];
  return { rows: [...rows.values()], edges, nodesById };
}

async function executeRelations({ program, rows, nodesById, jev, run, emit }) {
  const r = program.relations;
  const notes = new Map(program.doc_notes.map((n) => [n.doc, n.note]));
  const cands = [...rows.values()].filter((row) => r.candidates.every((c) => evalCond(c, row, nodesById)));
  const anchor = new Set(r.anchor_docs);
  // Candidate pairs: blocked (same block_by value, cross-document, anchored), then ranked by
  // lexical similarity so each row is judged against its most similar partners, not a random one.
  const vec = tfidf(cands);
  const eligible = (a, b) => {
    if (a.id === b.id || (r.cross_document && a.doc === b.doc)) return false;
    if (anchor.size && !anchor.has(a.doc) && !anchor.has(b.doc)) return false;
    if (anchor.size && anchor.has(a.doc) && anchor.has(b.doc)) return false;
    if (r.block_by) {
      const va = catValue(a, r.block_by, nodesById);
      if (va == null || va !== catValue(b, r.block_by, nodesById)) return false;
    }
    return true;
  };
  const heads = anchor.size ? cands.filter((c) => anchor.has(c.doc)) : cands;
  const seen = new Set();
  let possible = 0;
  const ranked = [];
  for (const a of heads) {
    const partners = cands.filter((b) => eligible(a, b));
    possible += partners.length;
    partners
      .map((b) => [b, cosine(vec.get(a.id), vec.get(b.id))])
      .sort((x, y) => y[1] - x[1])
      .slice(0, r.pairs_per_row)
      .forEach(([b, sim]) => {
        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        if (!seen.has(key)) seen.add(key), ranked.push({ pair: [a, b], sim });
      });
  }
  const total = anchor.size ? possible : Math.round(possible / 2);
  const picked = ranked.sort((x, y) => y.sim - x.sim).slice(0, r.max_pairs).map((x) => x.pair);
  emit({ t: "relations_start", candidates: cands.length, pairs: picked.length, possible: total });

  const criteria = Object.fromEntries(r.options.map((o) => [o.key, o.description]));
  const edges = [];
  const batches = [];
  for (let i = 0; i < picked.length; i += PAIR_BATCH) batches.push(picked.slice(i, i + PAIR_BATCH));
  await Promise.all(
    batches.map(async (batch, bi) => {
      const qs = {};
      const side = (row) => ({ source: `${row.docTitle} — ${row.sectionHeading ?? ""}`, ...(notes.has(row.doc) ? { scope_note: notes.get(row.doc) } : {}), text: clip(row.text, 2500) });
      batch.forEach(([a, b], k) => {
        qs[`rel__${k}`] = { type: "choice", instructions: { question: `Compare \`requirement_a\` with \`requirement_b\`. ${r.question}`, requirement_a: side(a), requirement_b: side(b) }, criteria };
      });
      const rec = await run.call(jev, {
        stage: "Relations",
        target: `pairs#${bi}`,
        state: { task: "Compare pairs of regulatory requirements", documents: [...new Set(batch.flatMap(([a, b]) => [a.docTitle, b.docTitle]))] },
        questions: qs,
        meta: { layer: "rel", pairs: batch.map(([a, b]) => [a.id, b.id]) },
      });
      const items = batch.map(([a, b], k) => {
        const ans = rec?.answers?.[`rel__${k}`];
        const e = { a: a.id, b: b.id, type: ans?.choice ?? null, conf: ans?.confidence ?? null, probs: ans?.probabilities ?? null, call: rec?.id ?? null };
        if (e.type && e.type !== r.none_option) edges.push(e);
        return e;
      });
      emit({ t: "relations", items, none: r.none_option });
    }),
  );
  // linked: the row's strongest relation (first option, e.g. "implements") was found for at least one partner.
  const strong = r.options[0].key;
  const linked = new Set(edges.filter((e) => e.type === strong).flatMap((e) => [e.a, e.b]));
  const any = new Set(edges.flatMap((e) => [e.a, e.b]));
  const judged = new Set(picked.flatMap(([a, b]) => [a.id, b.id]));
  for (const row of cands) row.derived = judged.has(row.id) ? { linked: linked.has(row.id) ? "yes" : "no", related: any.has(row.id) ? "yes" : "no" } : { linked: null, related: null };
  return edges;
}

const STOP = new Set("the of and to a in or for is be by that this any as with on an such under are shall may which not its it from at other than each have has been will including who whose".split(" "));
function tfidf(rows) {
  const docs = rows.map((r) => (r.text.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? []).filter((w) => !STOP.has(w)));
  const df = new Map();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const N = rows.length;
  const out = new Map();
  rows.forEach((r, i) => {
    const tf = new Map();
    for (const w of docs[i]) tf.set(w, (tf.get(w) ?? 0) + 1);
    let norm = 0;
    const v = new Map();
    for (const [w, c] of tf) { const x = c * Math.log(1 + N / df.get(w)); v.set(w, x); norm += x * x; }
    norm = Math.sqrt(norm) || 1;
    for (const [w, x] of v) v.set(w, x / norm);
    out.set(r.id, v);
  });
  return out;
}
const cosine = (a, b) => {
  if (!a || !b) return 0;
  const [s, l] = a.size < b.size ? [a, b] : [b, a];
  let d = 0;
  for (const [w, x] of s) d += x * (l.get(w) ?? 0);
  return d;
};

// ───────────────────────────── views ─────────────────────────────

const inc = (m, k, id) => {
  const e = m.get(k) ?? m.set(k, { n: 0, sum: 0, ids: [] }).get(k);
  e.n++;
  e.ids.push(id);
  return e;
};

/** Pure code over the dataset: every mark carries the row ids behind it. */
export function computeViews(program, rows, edges, nodesById) {
  const labelFor = (field, value) => {
    const n = nodesById.get(field);
    if (field === "doc") return shortName(value);
    if (n?.kind === "choice") return value;
    return value;
  };
  return program.views.map((v) => {
    const base = { id: v.id, type: v.type, title: v.title, why: v.why, x: v.x, y: v.y, measure: v.measure, measure_field: v.measure_field };
    const sel = rows.filter((row) => v.where.every((c) => evalCond(c, row, nodesById)));
    try {
      if (v.type === "bar") {
        const m = new Map();
        for (const row of sel) {
          const k = catValue(row, v.x, nodesById);
          if (k == null) continue;
          const e = inc(m, k, row.id);
          if (v.measure === "mean") e.sum += numValue(row, v.measure_field, nodesById) ?? 0;
        }
        const evaluated = rows.filter((row) => catValue(row, v.x, nodesById) != null).length || 1;
        let bars = [...m].map(([k, e]) => ({ key: k, label: labelFor(v.x, k), value: v.measure === "mean" ? e.sum / e.n : v.measure === "share" ? e.n / evaluated : e.n, n: e.n, ids: e.ids }));
        bars.sort((a, b) => b.value - a.value);
        if (v.top > 0) bars = bars.slice(0, v.top);
        return { ...base, bars, total: sel.length };
      }
      if (v.type === "heatmap") {
        const xs = new Map(), ys = new Map(), cells = new Map();
        for (const row of sel) {
          const kx = catValue(row, v.x, nodesById), ky = catValue(row, v.y, nodesById);
          if (kx == null || ky == null) continue;
          xs.set(kx, (xs.get(kx) ?? 0) + 1);
          ys.set(ky, (ys.get(ky) ?? 0) + 1);
          const e = inc(cells, `${kx}\u0000${ky}`, row.id);
          if (v.measure === "mean") e.sum += numValue(row, v.measure_field, nodesById) ?? 0;
        }
        const order = (m) => [...m].sort((a, b) => b[1] - a[1]).map(([k]) => k);
        const X = order(xs), Y = order(ys);
        const out = [];
        for (const kx of X) for (const ky of Y) {
          const e = cells.get(`${kx}\u0000${ky}`);
          out.push({ x: kx, y: ky, value: e ? (v.measure === "mean" ? e.sum / e.n : e.n) : 0, n: e?.n ?? 0, ids: e?.ids ?? [] });
        }
        return { ...base, xs: X.map((k) => ({ key: k, label: labelFor(v.x, k) })), ys: Y.map((k) => ({ key: k, label: labelFor(v.y, k) })), cells: out, total: sel.length };
      }
      if (v.type === "histogram") {
        const n = nodesById.get(v.x);
        const vals = sel.map((row) => [row.id, numValue(row, v.x, nodesById)]).filter(([, x]) => x != null);
        let bins;
        if (n?.kind === "score") {
          bins = n.levels.map((label, i) => ({ label, lo: i - 0.5, hi: i + 0.5, n: 0, ids: [] }));
          for (const [id, x] of vals) { const b = bins[Math.max(0, Math.min(bins.length - 1, Math.round(x)))]; b.n++; b.ids.push(id); }
        } else {
          bins = Array.from({ length: 10 }, (_, i) => ({ label: `${i * 10}–${i * 10 + 10}%`, lo: i / 10, hi: (i + 1) / 10, n: 0, ids: [] }));
          for (const [id, x] of vals) { const b = bins[Math.min(9, Math.floor(x * 10))]; b.n++; b.ids.push(id); }
        }
        return { ...base, bins, total: vals.length };
      }
      if (v.type === "coverage") {
        const m = new Map();
        for (const row of sel) {
          const k = catValue(row, v.x, nodesById);
          const l = row.derived?.linked;
          if (k == null || l == null) continue;
          const e = m.get(k) ?? m.set(k, { n: 0, covered: 0, ids: [], gaps: [] }).get(k);
          e.n++;
          if (l === "yes") e.covered++, e.ids.push(row.id);
          else e.gaps.push(row.id);
        }
        let bars = [...m].map(([k, e]) => ({ key: k, label: labelFor(v.x, k), value: e.covered / e.n, n: e.n, covered: e.covered, ids: e.ids, gaps: e.gaps }));
        bars.sort((a, b) => b.n - a.n);
        if (v.top > 0) bars = bars.slice(0, v.top);
        const tot = bars.reduce((a, b) => a + b.n, 0), cov = bars.reduce((a, b) => a + b.covered, 0);
        return { ...base, bars, total: tot, covered: cov, strong: program.relations.options[0].key };
      }
      if (v.type === "stat") {
        const evaluated = v.measure === "share" ? rows.length : null;
        const value = v.measure === "mean" ? sel.reduce((a, row) => a + (numValue(row, v.measure_field, nodesById) ?? 0), 0) / (sel.length || 1) : v.measure === "share" ? sel.length / (evaluated || 1) : sel.length;
        return { ...base, value, n: sel.length, of: rows.length, ids: sel.map((r) => r.id) };
      }
      if (v.type === "table") {
        const f = v.measure_field;
        let list = [...sel];
        if (f) list.sort((a, b) => (numValue(b, f, nodesById) ?? -1) - (numValue(a, f, nodesById) ?? -1));
        list = list.slice(0, v.top > 0 ? v.top : 25);
        const cols = [v.x, v.y, f].filter(Boolean);
        return { ...base, cols, rows: list.map((row) => ({ id: row.id, label: row.label, text: clip(row.text, 260), cells: cols.map((c) => catValue(row, c, nodesById) ?? (numValue(row, c, nodesById)?.toFixed?.(2) ?? "—")) })), total: sel.length };
      }
      if (v.type === "network") {
        const ids = new Set(sel.map((r) => r.id));
        const es = edges.filter((e) => ids.has(e.a) && ids.has(e.b));
        const used = new Set(es.flatMap((e) => [e.a, e.b]));
        const byId = new Map(rows.map((r) => [r.id, r]));
        const nodes = [...used].map((id) => {
          const row = byId.get(id);
          return { id, label: row.label, doc: row.doc, group: v.x ? catValue(row, v.x, nodesById) ?? "—" : shortName(row.doc) };
        });
        const types = [...new Set(es.map((e) => e.type))];
        return { ...base, nodes: nodes.map((n) => ({ ...n, group: v.x === "doc" ? shortName(n.doc) : n.group })), edges: es.map((e) => ({ a: e.a, b: e.b, type: e.type, conf: e.conf })), types, total: es.length };
      }
    } catch (err) {
      return { ...base, error: err.message };
    }
    return { ...base, error: "unsupported view" };
  });
}

/** Compact dataset for the client. */
export function datasetForClient(program, rows) {
  return {
    columns: program.nodes.map((n) => ({ id: n.id, label: n.label, kind: n.kind, depth: n.depth, options: n.options, levels: n.levels })),
    rows: rows.map((r) => ({ id: r.id, doc: r.doc, label: r.label, section: r.section, sectionHeading: r.sectionHeading ?? null, src: r.src, text: r.text.slice(0, 1500), base: r.base, derived: r.derived ?? null, values: r.values, trace: r.trace })),
  };
}

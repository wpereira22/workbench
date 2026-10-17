import { PRICE_PER_INPUT_TOKEN } from "./jev.mjs";

// Lineage records keep the full questions and answers but not the (large) state,
// which is recoverable from the corpus.
export const slimRecord = ({ id, stage, target, cacheKey, questions, answers, model, usage, latencyMs, cached, startedAt }) => ({
  id, stage, target, cacheKey, questions, answers, model, usage, latencyMs, cached, startedAt,
});

const short = (s, n) => (typeof s === "string" ? (s.length > n ? s.slice(0, n - 1) + "…" : s) : null);
/** A compact view of a call's questions and answers, streamed so the UI can show decisions as they land. */
export function peek(rec) {
  return Object.entries(rec.questions ?? {}).slice(0, 24).map(([k, q]) => {
    const i = q.instructions;
    const question = typeof i === "string" ? i : i?.question;
    const target = typeof i === "object" ? i.target ?? i.text ?? i.fragment ?? i.heading?.text ?? i.block?.text ?? i.cells?.[0]?.text ?? i.occurrences?.[0]?.text ?? i.requirement_a?.text : null;
    const a = rec.answers?.[k];
    const ans = !a ? null : a.type === "noul" ? { p: Math.round(a.noul * 100) / 100 } : a.type === "choice" ? { c: a.choice, p: Math.round((a.probabilities?.[a.choice] ?? a.confidence ?? 0) * 100) / 100 } : { s: Math.round(a.score * 10) / 10 };
    return { k, kind: q.type, q: short(question, 110), t: short(typeof target === "string" ? target : null, 90), a: ans };
  });
}

/** Tracks everything a run did: calls, predicates, tokens, latency, cache hits, lineage. */
export class Run {
  constructor(emit, { fresh = false } = {}) {
    this.emit = emit;
    this.fresh = fresh; // bypass cache reads, so every predicate hits Jev live
    this.t0 = Date.now();
    this.calls = 0;
    this.predicates = 0;
    this.cacheHits = 0;
    this.inputTokens = 0;
    this.latencies = [];
    this.firstResultMs = null;
    this.errors = 0;
    this.lineage = new Map();
    this.model = null;
    this.llm = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
  }

  /** One Jev request. Emits a light event; the full record stays server-side in `lineage`. */
  async call(jev, { stage, target, state, questions, meta }) {
    const n = Object.keys(questions).length;
    this.emit({ t: "pending", stage, target, n, meta });
    try {
      const rec = await jev.ask({ stage, target, state, questions, fresh: this.fresh });
      this.calls++;
      this.predicates += n;
      if (rec.cached) this.cacheHits++;
      else {
        this.inputTokens += rec.usage?.input_tokens ?? 0;
        this.latencies.push(rec.latencyMs);
      }
      this.model ??= rec.model;
      this.lineage.set(rec.id, slimRecord(rec));
      this.emit({ t: "call", id: rec.id, stage, target, n, latencyMs: rec.latencyMs, cached: rec.cached, tokens: rec.usage?.input_tokens ?? 0, meta, peek: peek(rec) });
      return rec;
    } catch (err) {
      this.errors++;
      this.emit({ t: "fail", stage, target, n, error: err.message, status: err.status, meta });
      if ([401, 402, 403].includes(err.status)) throw err; // fatal: bad key or no credits, never save a half-labeled result
      return null;
    }
  }

  addLlmUsage(usage, { inPerM, outPerM }) {
    if (!usage) return;
    const inTok = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
    this.llm.calls++;
    this.llm.inputTokens += inTok;
    this.llm.outputTokens += usage.output_tokens ?? 0;
    this.llm.costUsd += ((usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) * 1.25 + (usage.cache_read_input_tokens ?? 0) * 0.1) * inPerM / 1e6 + (usage.output_tokens ?? 0) * outPerM / 1e6;
  }

  markResult() {
    this.firstResultMs ??= Date.now() - this.t0;
  }

  metrics() {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
    return {
      wallMs: Date.now() - this.t0,
      firstResultMs: this.firstResultMs,
      calls: this.calls,
      predicates: this.predicates,
      cacheHits: this.cacheHits,
      inputTokens: this.inputTokens,
      costUsd: this.inputTokens * PRICE_PER_INPUT_TOKEN,
      p50: pct(0.5),
      p95: pct(0.95),
      errors: this.errors,
      model: this.model,
      llm: { ...this.llm },
    };
  }
}

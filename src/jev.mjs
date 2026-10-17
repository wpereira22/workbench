// Decision-model client: global rate limiting, retries, disk cache, lineage. Two providers speak the same idea —
// shared evidence plus a batch of named yes/no, choice, and score questions, answered with probabilities:
//   typesafe  TypeSafe Jev           POST {base}/v1/systemone  { model, state, questions{key: q} }
//   openai    OpenAI Decisions API   POST {base}/v1/decisions  { model, input, questions[{name, ...}] }
// The rest of the code speaks Jev's format (noul/choice/score, criteria, answers keyed by name). For OpenAI the
// request is translated on the way out and the answers on the way back, so nothing above this file changes.
// Answers are cached by a hash of the exact request sent, so the two providers never share cache entries.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PROVIDERS = {
  typesafe: { label: "Jev", baseUrl: "https://api.typesafe.ai", path: "/v1/systemone", model: "jev-latest", keyVar: "TYPESAFE_API_KEY", price: 0.042, maxQuestions: Infinity },
  openai: { label: "OpenAI Decisions", baseUrl: "https://api.openai.com", path: "/v1/decisions", model: "gpt-6-luna", keyVar: "OPENAI_API_KEY", price: 0.1, maxQuestions: 200 },
};

/** Which provider this process uses: DECISIONS_PROVIDER, else whichever key is set (TypeSafe first). */
export const PROVIDER = (() => {
  const p = (process.env.DECISIONS_PROVIDER ?? "").toLowerCase();
  if (PROVIDERS[p]) return p;
  return !process.env.TYPESAFE_API_KEY && process.env.OPENAI_API_KEY ? "openai" : "typesafe";
})();
export const ENGINE = PROVIDERS[PROVIDER];
/** Dollars per input token for the active provider (output is free on both). */
export const PRICE_PER_INPUT_TOKEN = ENGINE.price / 1e6;

export class JevError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Jev's `state` object as the text OpenAI takes for `input`: one labeled section per field. */
const asText = (v) => (typeof v === "string" ? v : JSON.stringify(v));
function stateToInput(state) {
  if (state == null) return "";
  if (typeof state !== "object") return String(state);
  return Object.entries(state).map(([k, v]) => `${k}:\n${asText(v)}`).join("\n\n");
}
/** Jev instructions may be an object ({ question, target, page_text… }); OpenAI wants one string. The fields keep
 *  their names, since the questions refer to them (`target`, `page_text`). */
function instructionsToText(ins) {
  if (typeof ins === "string") return ins;
  const { question, ...rest } = ins ?? {};
  return [question ?? "", ...Object.entries(rest).filter(([, v]) => v != null).map(([k, v]) => `${k}: ${asText(v)}`)].filter(Boolean).join("\n\n");
}
function toOpenAIQuestion(name, q) {
  const instructions = instructionsToText(q.instructions);
  if (q.type === "noul") return { type: "predicate", name, instructions };
  if (q.type === "choice") {
    const crit = Array.isArray(q.criteria) ? Object.fromEntries(q.criteria.map((c) => [c, c])) : q.criteria ?? {};
    return { type: "choice", name, instructions, choices: Object.entries(crit).map(([value, description]) => ({ value, description: String(description) })) };
  }
  const levels = Array.isArray(q.criteria) ? q.criteria : Object.values(q.criteria ?? {});
  return { type: "score", name, instructions, levels: levels.map((l) => ({ label: String(l).slice(0, 80), description: String(l) })) };
}
/** OpenAI answers back into Jev's shapes: noul probability, choice/score probabilities keyed by value/index. */
function fromOpenAIAnswer(a) {
  if (!a || a.type === "refusal") return null;
  if (a.type === "predicate") return { type: "noul", noul: a.probability };
  if (a.type === "choice") return { type: "choice", choice: a.choice, confidence: a.confidence, probabilities: Object.fromEntries((a.probabilities ?? []).map((p) => [p.value, p.probability])) };
  if (a.type === "score") {
    const probs = a.probabilities ?? [];
    return { type: "score", score: a.score, confidence: a.confidence, probabilities: Object.fromEntries(probs.map((p) => [String(p.value), p.probability])), legend: Object.fromEntries(probs.map((p) => [String(p.value), p.label])) };
  }
  return null;
}

export class Jev {
  constructor({ provider = PROVIDER, apiKey, baseUrl, model, maxRps = 35, maxInflight = 32, cacheDir }) {
    this.provider = provider;
    this.engine = PROVIDERS[provider];
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || this.engine.baseUrl).replace(/\/$/, "");
    this.model = model || this.engine.model;
    this.maxRps = maxRps;
    this.maxInflight = maxInflight;
    this.cacheDir = cacheDir;
    this.inflight = 0;
    this.sent = []; // timestamps of recent sends, for the rps window
    this.waiters = [];
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  async #slot() {
    for (;;) {
      const now = Date.now();
      this.sent = this.sent.filter((t) => now - t < 1000);
      if (this.inflight < this.maxInflight && this.sent.length < this.maxRps) {
        this.inflight++;
        this.sent.push(now);
        return;
      }
      const wait = this.sent.length >= this.maxRps ? 1000 - (now - this.sent[0]) + 2 : 25;
      await new Promise((r) => {
        const t = setTimeout(r, wait);
        this.waiters.push(() => (clearTimeout(t), r()));
      });
    }
  }

  #release() {
    this.inflight--;
    this.waiters.splice(0).forEach((w) => w());
  }

  #cachePath(key) {
    return join(this.cacheDir, key.slice(0, 2), `${key}.json`);
  }

  /** The request body this provider takes, for one batch of questions (Jev format in). */
  #body(state, questions) {
    if (this.provider === "openai") return { model: this.model, input: stateToInput(state), questions: Object.entries(questions).map(([k, q]) => toOpenAIQuestion(k, q)) };
    return { model: this.model, state, questions };
  }

  /** Posts one request (with cache and retries) and returns { model, answers (Jev format, keyed), usage }. */
  async #post(body, fresh) {
    // Clipping text can cut a surrogate pair (math symbols, emoji) in half; both APIs reject lone surrogates, so
    // every string is made well-formed. Clean requests serialize exactly as before, so their cache entries still hit.
    const payload = JSON.stringify(body, (k, v) => (typeof v === "string" ? v.toWellFormed() : v));
    const key = createHash("sha256").update(payload).digest("hex");
    if (this.cacheDir && !fresh) {
      try {
        return { ...JSON.parse(await readFile(this.#cachePath(key), "utf8")), cached: true, latencyMs: 0, key };
      } catch {}
    }
    if (!this.apiKey) throw new JevError(`${this.engine.keyVar} is not set`, 401);

    let attempt = 0;
    for (;;) {
      await this.#slot();
      const t0 = performance.now();
      let res;
      try {
        res = await fetch(`${this.baseUrl}${this.engine.path}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: payload,
        });
      } catch (err) {
        res = { ok: false, status: 0, statusText: err.message, headers: new Headers(), text: async () => err.message };
      } finally {
        this.#release();
      }
      const latencyMs = Math.round(performance.now() - t0);

      if (res.ok) {
        const json = await res.json();
        let answers = json.answers, usage = json.usage;
        if (this.provider === "openai") {
          answers = Object.fromEntries((json.answers ?? []).map((a) => [a.name, fromOpenAIAnswer(a)]).filter(([n, a]) => n && a));
          // Cached input tokens are free on OpenAI; count only what is billed.
          const cachedTokens = usage?.input_tokens_details?.cached_tokens ?? 0;
          usage = { input_tokens: Math.max(0, (usage?.input_tokens ?? 0) - cachedTokens), cached_input_tokens: cachedTokens, raw: usage };
        }
        const result = { model: json.model, answers, usage };
        if (this.cacheDir) {
          await mkdir(join(this.cacheDir, key.slice(0, 2)), { recursive: true });
          await writeFile(this.#cachePath(key), JSON.stringify(result));
        }
        return { ...result, cached: false, latencyMs, attempts: attempt + 1, key };
      }

      const retryable = res.status === 0 || res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= 6) {
        const detail = (await res.text()).slice(0, 500);
        throw new JevError(`${this.engine.label} HTTP ${res.status}: ${detail}`, res.status);
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoff = retryAfter > 0 ? retryAfter * 1000 : Math.min(8000, 250 * 2 ** attempt) * (0.5 + Math.random());
      await new Promise((r) => setTimeout(r, backoff));
      attempt++;
    }
  }

  /**
   * Evaluate one state against a map of questions (Jev format).
   * Returns a lineage record: the exact request, the answers, and how it was produced.
   */
  async ask({ state, questions, stage, target, fresh = false }) {
    const record = { id: randomUUID().slice(0, 8), stage, target, questions, startedAt: Date.now() };
    // OpenAI takes at most 200 questions per request: larger batches go out in parts and are merged.
    const keys = Object.keys(questions);
    const parts = [];
    for (let i = 0; i < keys.length; i += this.engine.maxQuestions) parts.push(Object.fromEntries(keys.slice(i, i + this.engine.maxQuestions).map((k) => [k, questions[k]])));
    const results = await Promise.all(parts.map((qs) => this.#post(this.#body(state, qs), fresh)));
    const sum = (f) => results.reduce((a, r) => a + (r.usage?.[f] ?? 0), 0);
    return {
      ...record,
      cacheKey: results[0]?.key.slice(0, 12),
      model: results[0]?.model,
      answers: Object.assign({}, ...results.map((r) => r.answers ?? {})),
      usage: { ...results[0]?.usage, input_tokens: sum("input_tokens") },
      cached: results.every((r) => r.cached),
      latencyMs: Math.max(...results.map((r) => r.latencyMs)),
      attempts: Math.max(...results.map((r) => r.attempts ?? 1)),
    };
  }
}

/** One client for this process, configured from the environment (see .env.example). */
export function createDecisionClient({ cacheDir } = {}) {
  const env = process.env;
  return new Jev({
    provider: PROVIDER,
    apiKey: env[ENGINE.keyVar],
    baseUrl: PROVIDER === "openai" ? env.OPENAI_BASE_URL : env.TYPESAFE_BASE_URL,
    model: env.DECISIONS_MODEL ?? (PROVIDER === "typesafe" ? env.JEV_MODEL : undefined),
    maxRps: Number(env.DECISIONS_MAX_RPS ?? env.JEV_MAX_RPS ?? 35),
    maxInflight: Number(env.DECISIONS_MAX_INFLIGHT ?? env.JEV_MAX_INFLIGHT ?? 32),
    cacheDir: env.DECISIONS_CACHE_DIR ?? env.JEV_CACHE_DIR ?? cacheDir,
  });
}

/** Probability that an answer is "yes"/"high", normalized to 0..1 regardless of type. */
export function yes(answer) {
  if (!answer) return 0;
  if (answer.type === "noul") return answer.noul;
  if (answer.type === "score") {
    const levels = Object.keys(answer.legend ?? answer.probabilities ?? {}).length;
    return levels > 1 ? answer.score / (levels - 1) : 0;
  }
  return answer.confidence ?? 0;
}

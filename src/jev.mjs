// Minimal TypeSafe Jev client: global rate limiting, retries, disk cache, lineage.
// API: POST {base}/v1/systemone  { model, state, questions } -> { model, answers, usage }
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PRICE_PER_INPUT_TOKEN = 0.042 / 1e6; // $0.042 per Mtok input, output free

export class JevError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class Jev {
  constructor({ apiKey, baseUrl = "https://api.typesafe.ai", model = "jev-latest", maxRps = 35, maxInflight = 32, cacheDir }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
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

  /**
   * Evaluate one state against a map of questions.
   * Returns a lineage record: the exact request, the answers, and how it was produced.
   */
  async ask({ state, questions, stage, target, fresh = false }) {
    const body = { model: this.model, state, questions };
    // Clipping text can cut a surrogate pair (math symbols, emoji) in half; Jev rejects lone surrogates, so every
    // string is made well-formed. Clean requests serialize exactly as before, so their cache entries still hit.
    const payload = JSON.stringify(body, (k, v) => (typeof v === "string" ? v.toWellFormed() : v));
    const key = createHash("sha256").update(payload).digest("hex");
    const record = { id: randomUUID().slice(0, 8), stage, target, cacheKey: key.slice(0, 12), questions, startedAt: Date.now() };

    if (this.cacheDir && !fresh) {
      try {
        const hit = JSON.parse(await readFile(this.#cachePath(key), "utf8"));
        return { ...record, ...hit, cached: true, latencyMs: 0 };
      } catch {}
    }
    if (!this.apiKey) throw new JevError("TYPESAFE_API_KEY is not set", 401);

    let attempt = 0;
    for (;;) {
      await this.#slot();
      const t0 = performance.now();
      let res;
      try {
        res = await fetch(`${this.baseUrl}/v1/systemone`, {
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
        const result = { model: json.model, answers: json.answers, usage: json.usage };
        if (this.cacheDir) {
          await mkdir(join(this.cacheDir, key.slice(0, 2)), { recursive: true });
          await writeFile(this.#cachePath(key), JSON.stringify(result));
        }
        return { ...record, ...result, cached: false, latencyMs, attempts: attempt + 1 };
      }

      const retryable = res.status === 0 || res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= 6) {
        const detail = (await res.text()).slice(0, 500);
        throw new JevError(`Jev HTTP ${res.status}: ${detail}`, res.status);
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoff = retryAfter > 0 ? retryAfter * 1000 : Math.min(8000, 250 * 2 ** attempt) * (0.5 + Math.random());
      await new Promise((r) => setTimeout(r, backoff));
      attempt++;
    }
  }
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

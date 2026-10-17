// A "dataset" question — hundreds of judgments, then counts — put to one long-context Claude call.
// Claude reads every paragraph of the five documents (same 1,988 as RegLens, in order, with ids) and lists
// every paragraph that imposes a requirement or prohibition on a payment stablecoin issuer, with a topic.
// Compare with the RegLens program "Issuer obligations register (eval)". Scored by eval/score-dataset.mjs.
// Usage (server running): node eval/dataset-question.mjs [out.json]
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const out = process.argv[2] ?? "eval/dataset-question-claude.json";
const TOPICS = JSON.parse(readFileSync("eval/issuer-topics.json", "utf8"));
const res = await fetch("http://localhost:4317/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ programId: "2026-10-04-genius-act-mandates-vs-proposed-rule-coverage", insights: false }) });
const rows = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.t === "dataset").dataset.rows;
const NAMES = { "genius-act": "GENIUS Act (Public Law 119-27)", "fed-genius-nprm": "Federal Reserve proposed rule (Regulation UU)", "fed-genius-applications": "Federal Reserve applications proposal", "treasury-issuance-nprm": "Treasury proposed rule on issuance (part 1523)", "treasury-state-cert": "Treasury interim final rule on State certification (part 1522)" };
let corpus = "", doc = null;
for (const r of rows) {
  if (r.doc !== doc) { doc = r.doc; corpus += `\n\n===== ${NAMES[doc] ?? doc} =====\n`; }
  corpus += `[${r.id}] (${r.section ?? ""}) ${r.text}\n`;
}
const question = `Across these five documents, which paragraphs impose a requirement or prohibition on a payment stablecoin issuer (including an applicant to become one, or an issuer's subsidiary): something the issuer must do or must not do? Count a paragraph only if it itself imposes the requirement; not if it only binds regulators or other parties, or merely describes, defines, permits, or explains. List EVERY such paragraph by its id, not a sample, and give each one topic. Then give the count per topic.`;
const schema = { type: "object", additionalProperties: false, required: ["paragraphs", "counts"], properties: {
  paragraphs: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "topic"], properties: { id: { type: "string" }, topic: { type: "string", enum: TOPICS.map(([k]) => k) } } } },
  counts: { type: "array", items: { type: "object", additionalProperties: false, required: ["topic", "count"], properties: { topic: { type: "string" }, count: { type: "integer" } } } },
} };
const system = `You are a regulatory analyst. Answer only from the documents provided, citing paragraphs by the id in brackets. Topics: ${TOPICS.map(([k, d]) => `${k} = ${d}`).join("; ")}.`;
const prompt = `Documents (every paragraph, in order):\n${corpus}\n\nQuestion: ${question}`;
const t0 = Date.now();
const result = await new Promise((resolve, reject) => {
  const child = spawn(process.env.CLAUDE_BIN ?? "claude", ["-p", "--output-format", "json", "--json-schema", JSON.stringify(schema), "--tools", "", "--no-session-persistence", "--system-prompt", system], { cwd: tmpdir(), env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  let so = "", se = "";
  child.stdout.on("data", (d) => (so += d));
  child.stderr.on("data", (d) => (se += d));
  child.on("close", (code) => { try { resolve(JSON.parse(so)); } catch { reject(new Error(`exit ${code}: ${se.slice(0, 400)} ${so.slice(0, 400)}`)); } });
  child.stdin.end(prompt);
});
const u = result.usage ?? {};
const summary = { seconds: Math.round((Date.now() - t0) / 100) / 10, model: Object.keys(result.modelUsage ?? {})[0], input_tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output_tokens: u.output_tokens, notional_cost_usd: result.total_cost_usd, listed: result.structured_output?.paragraphs?.length, stated_counts: result.structured_output?.counts, error: result.is_error ? result.result : null };
console.log(JSON.stringify(summary, null, 1));
writeFileSync(out, JSON.stringify({ summary, output: result.structured_output }, null, 1));

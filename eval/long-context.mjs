// RegLens vs. one long-context Claude call on the same exhaustive question.
// Claude reads every paragraph of the documents (in order, with section paths and paragraph ids) and lists
// every GENIUS Act provision that requires a regulator to issue, adopt, or amend rules. Scored against
// eval/rulemaking-key.json, the same key eval/rag-baseline.py uses. Runs on the local Claude Code CLI.
// Usage (server running): node eval/long-context.mjs [all|genius] [out.json]
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const scope = process.argv[2] ?? "all";
const out = process.argv[3] ?? `eval/long-context-${scope}.json`;
const KEY = new Set(JSON.parse(readFileSync("eval/rulemaking-key.json", "utf8")));
// A list item that is a mandate only with its lead-in counts if Claude cites the lead-in instead.
const LEAD = { "genius-act/b513": "genius-act/b515" };

const res = await fetch("http://localhost:4317/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ programId: "2026-10-04-genius-act-mandates-vs-proposed-rule-coverage", insights: false }) });
const events = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const rows = events.find((e) => e.t === "dataset").dataset.rows.filter((r) => scope === "all" || r.doc === "genius-act");
const NAMES = { "genius-act": "GENIUS Act (Public Law 119-27)", "fed-genius-nprm": "Federal Reserve proposed rule (Regulation UU)", "fed-genius-applications": "Federal Reserve applications proposal", "treasury-issuance-nprm": "Treasury proposed rule on issuance (part 1523)", "treasury-state-cert": "Treasury interim final rule on State certification (part 1522)" };
let corpus = "", doc = null;
for (const r of rows) {
  if (r.doc !== doc) { doc = r.doc; corpus += `\n\n===== ${NAMES[doc] ?? doc} =====\n`; }
  corpus += `[${r.id}] (${r.section ?? ""}) ${r.text}\n`;
}
const question = "Which provisions of the GENIUS Act require a federal regulator (or Treasury, FinCEN, or the Stablecoin Certification Review Committee) to issue, adopt, or amend rules or regulations, and what deadline does each carry? List every such provision, not a sample. Count only provisions that require it (shall/must), not ones that merely permit it (may).";
const schema = { type: "object", additionalProperties: false, required: ["mandates"], properties: { mandates: { type: "array", items: { type: "object", additionalProperties: false, required: ["paragraph_id", "section", "regulator", "what_rule", "clock"], properties: { paragraph_id: { type: "string", description: "The [id] of the paragraph that imposes the requirement" }, section: { type: "string" }, regulator: { type: "string" }, what_rule: { type: "string" }, clock: { type: "string", description: "What starts the deadline and how long, or 'none'" } } } } } };
const system = "You are a regulatory analyst. Answer only from the documents provided. Cite each provision by the paragraph id shown in brackets.";
const prompt = `Documents (every paragraph, in order):\n${corpus}\n\nQuestion: ${question}`;
console.log(`${scope}: ${rows.length} paragraphs, ${prompt.length.toLocaleString()} characters (~${Math.round(prompt.length / 4 / 1000)}K tokens)`);

const t0 = Date.now();
const result = await new Promise((resolve, reject) => {
  const child = spawn(process.env.CLAUDE_BIN ?? "claude", ["-p", "--output-format", "json", "--json-schema", JSON.stringify(schema), "--tools", "", "--no-session-persistence", "--system-prompt", system], { cwd: tmpdir(), env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  let so = "", se = "";
  child.stdout.on("data", (d) => (so += d));
  child.stderr.on("data", (d) => (se += d));
  child.on("close", (code) => { try { resolve(JSON.parse(so)); } catch { reject(new Error(`exit ${code}: ${se.slice(0, 400)} ${so.slice(0, 400)}`)); } });
  child.stdin.end(prompt);
});
const ms = Date.now() - t0;
const items = result.structured_output?.mandates ?? [];
const cited = new Set(items.map((m) => (m.paragraph_id.includes("/") ? m.paragraph_id : `genius-act/${m.paragraph_id}`)).map((id) => LEAD[id] ?? id));
const hit = [...KEY].filter((k) => cited.has(k));
const extra = [...cited].filter((c) => !KEY.has(c));
const u = result.usage ?? {};
const summary = {
  scope, paragraphs: rows.length, seconds: Math.round(ms / 100) / 10, model: Object.keys(result.modelUsage ?? {})[0],
  input_tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output_tokens: u.output_tokens,
  notional_cost_usd: result.total_cost_usd, listed: items.length, found: `${hit.length}/${KEY.size}`, missed: [...KEY].filter((k) => !cited.has(k)), not_in_key: extra,
};
console.log(JSON.stringify(summary, null, 1));
writeFileSync(out, JSON.stringify({ summary, items }, null, 1));

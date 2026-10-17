"""Scores the issuer-obligations "dataset question" for RegLens and for one long-context Claude call.

Answer key: 200 paragraphs drawn at random (seeded) from the 1,988, labeled blind
(eval/issuer-sample-labels.json): Y = operative text that itself binds an issuer; D = describes an
issuer requirement without imposing it (preamble: "§ 247.11(f) would require..."); N = neither;
G = genuinely ambiguous, left out of scoring. Strict scoring counts only Y as positive (what the
question literally asked); broad scoring also counts D (what an analyst would want).
"""
import json
from collections import Counter

labels = json.load(open("eval/issuer-sample-labels.json"))
reglens = json.load(open("eval/dataset-question-reglens.json"))
claude = json.load(open("eval/dataset-question-claude.json"))
rl_pos = {k for k, v in reglens.items() if (v.get("p") or 0) >= 0.5}
cl_items = claude["output"]["paragraphs"]
cl_pos = {i["id"] for i in cl_items}
N = len(reglens)

def score(pos, positive):
    tp = fp = fn = tn = 0
    for pid, lab in labels.items():
        if lab == "G": continue
        truth, pred = lab in positive, pid in pos
        tp += truth and pred; fp += pred and not truth; fn += truth and not pred; tn += not truth and not pred
    return tp, fp, fn, tn

print(f"Listed as issuer obligations across all {N} paragraphs: RegLens {len(rl_pos)}, Claude {len(cl_pos)}")
for name, positive in [("strict (Y only)", {"Y"}), ("broad (Y + D)", {"Y", "D"})]:
    truth_n = sum(1 for l in labels.values() if l in positive)
    scored = sum(1 for l in labels.values() if l != "G")
    print(f"\n{name}: {truth_n} positives in the {scored} scored sample paragraphs -> about {round(truth_n / scored * N)} in the full set")
    for sysname, pos in [("RegLens", rl_pos), ("Claude long-context", cl_pos)]:
        tp, fp, fn, tn = score(pos, positive)
        print(f"  {sysname:20s} recall {tp}/{tp + fn} = {tp / max(1, tp + fn):.0%}   precision {tp}/{tp + fp} = {tp / max(1, tp + fp):.0%}   agree {tp + tn}/{scored}")
s = claude["summary"]
stated = {c["topic"]: c["count"] for c in s.get("stated_counts") or []}
listed = Counter(i["topic"] for i in cl_items)
print(f"\nClaude: {s['seconds']} s, {s['input_tokens']:,} tokens in, {s['output_tokens']:,} out, ${s['notional_cost_usd']:.2f} at API rates")
print("Claude's stated counts vs. the paragraphs it actually listed:", {t: (stated.get(t), listed.get(t, 0)) for t in sorted(set(stated) | set(listed))})
print("Overlap between the two systems' lists:", len(rl_pos & cl_pos))

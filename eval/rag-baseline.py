"""RegLens vs. a retrieval (RAG) baseline on one exhaustive question.

Question: "Which provisions of the GENIUS Act require a federal regulator to issue rules or
regulations, and what deadline does each carry?"

Answer key (eval/rulemaking-key.json): 17 GENIUS paragraphs, found by pattern-matching every
"shall ... issue/promulgate/prescribe/adopt/amend ... regulations/rules" sentence (with the lead-in a
list item hangs from), then read and judged by hand. Borderline paragraphs left out: an authority
grant (b389), a procedure for how rules are issued (b503), and a constraint on a rule's content (b256).

RegLens rows come from the saved mandates program, replayed from the cache (no cost):
the rulemaking branch, narrowed by its "how binding" question to shall-type mandates.
The RAG baseline ranks the same paragraphs with BM25, as a retriever would.

Usage (server running): python3 eval/rag-baseline.py
"""
import json, math, re, urllib.request
from collections import Counter

PROGRAM = "2026-10-04-genius-act-mandates-vs-proposed-rule-coverage"
QUESTION = "Which provisions of the GENIUS Act require a federal regulator to issue rules or regulations, and what deadline does each carry?"
KEY = set(json.load(open("eval/rulemaking-key.json")))

req = urllib.request.Request("http://localhost:4317/api/run", data=json.dumps({"programId": PROGRAM}).encode(), headers={"Content-Type": "application/json"})
events = [json.loads(l) for l in urllib.request.urlopen(req).read().decode().splitlines() if l.strip()]
rows = next(e for e in events if e["t"] == "dataset")["dataset"]["rows"]

def val(r, k):
    v = r["values"].get(k)
    return None if not v else v.get("choice", v.get("p"))

found = {r["id"] for r in rows if r["doc"] == "genius-act" and val(r, "directive_type") == "rulemaking"
         and val(r, "rule_obligation_force") in ("shall_issue", "shall_amend_existing", "mixed_shall_and_may")}
print(f"RegLens: {len(KEY & found)}/{len(KEY)} of the key, in {len(found)} rows flagged")

STOP = set("a an the of to and or in on for by with is are be which what each does do any that this from as at it its their there these those such may shall".split())
tok = lambda t: [w for w in re.findall(r"[a-z0-9]+", (t or "").lower()) if w not in STOP]

def bm25(corpus, q, k1=1.5, b=0.75):
    docs = [tok(c["text"]) for c in corpus]
    n, avg = len(docs), sum(map(len, docs)) / len(docs)
    df = Counter(w for d in docs for w in set(d))
    def score(d):
        tf = Counter(d)
        return sum(math.log(1 + (n - df[w] + .5) / (df[w] + .5)) * tf[w] * (k1 + 1) / (tf[w] + k1 * (1 - b + b * len(d) / avg)) for w in tok(q) if w in tf)
    return [corpus[i]["id"] for i in sorted(range(n), key=lambda i: -score(docs[i]))]

for name, corpus in [("5 documents", rows), ("GENIUS Act only", [r for r in rows if r["doc"] == "genius-act"])]:
    ranked = bm25(corpus, QUESTION)
    hits = " · ".join(f"top-{k}: {len(KEY & set(ranked[:k]))}/{len(KEY)}" for k in (10, 20, 50))
    print(f"BM25 over {name}: {hits} · top-{max(ranked.index(t) for t in KEY) + 1} needed to see all")

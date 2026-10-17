# RegLens

Semantic compute over digital-asset and currency regulation, powered by [TypeSafe Jev](https://docs.typesafe.ai)
(fast, calibrated yes/no, choice, and score decisions) and Claude through your local **Claude Code CLI**
(no Anthropic API key needed).

It has four workspaces:
- **Build:** drop a PDF (scanned or not) or HTML file, or paste a link, and watch Jev parse it live.
  - The parse reads as a program: each step is the question Jev asks ("What is each block?"), with the IF heading / IF content / ELSE branches beneath it. Steps light up as their answers land.
  - Alongside: the audit checks and issue loop, open issues counting down, every page's blocks coloring in as roles are decided, and a feed of each question Jev answers.
- **Documents:** every page with Jev's labels drawn on it, the outline, parse health, and each block's audit trail.
- **Data:** every parsed piece across the library: definitions, obligations, permissions, deadlines, questions, fields, table rows, outline.
  - Filter by document, kind, modality, section role, topic, year; every row traces to its page; export CSV/JSON.
  - "Query these →" turns the selection into the scope of a new query.
- **Query:** describe the dataset you want, on the Query home or in the top bar (⌘K, from anywhere). The home lists ready-made questions the library can answer.
  - Claude Code designs the columns as layered Jev questions; Jev fills every cell while the if-statement flow animates.
  - You get a written answer, a table (most relevant rows first; CSV/JSON export), and charts.

## Library: parsing documents into pieces

Code finds the evidence (positions, fonts, tags, numbering). Jev makes the judgments. Every label keeps the Jev call
that produced it, and every block keeps its exact page position.

| Step | Engine | What happens |
|---|---|---|
| E Extract | code | **PDFs** (PyMuPDF): lines become blocks with exact coordinates, based on gaps, indents, enumerators, and font changes. Bill line numbers are stripped and overprinted text is deduplicated. Each block records its first-line indent, whether it sits in the outer page margin (margin notes), and whether a picture sits right below it or under it (figure titles and labels). Running headers are lines repeated at the page edge on a run of pages. Page images are rendered for the viewer. **HTML**: elements and text-bearing leaf divs become blocks, keeping their tags. Site chrome (hover help, tooltips, modals) is dropped. |
| S0 Stitch | Jev | *PDFs only*: with the whole page in view, is one of the next three blocks this block's cut-off remainder? A sentence that runs off the page also gets the first text block of the next page as a candidate, past footnotes and the running header. A code rule vetoes joining an enumerated item to its lead-in. |
| S1 Profile | Jev | Whole document: type, legal force, jurisdiction, topics. |
| S2 Roles | Jev | Every block, with its page in view, gets one of 12 roles: heading, body, list item, definition, question, quote, field ("Frequency: Annual"), footnote, table/figure, contents entry, page furniture, front matter. |
| S3 Levels | Jev | First-pass heading depth, with all headings in view. |
| S4 Modality | Jev | Content blocks: must, must not, may, defines, context; plus a deadline flag. |
| A Audit & repair | Jev + code | A stack of checks repairs the parse, then an issue-driven loop runs until parse health stops improving (below). |
| O Outline | code | Headings and levels become a section tree; everything else attaches to its section. |
| S5 Sections | Jev | Section role (rule text, discussion, comment request, impact analysis...) and topics. |

### The audit stack

| Check | Engine | What it decides |
|---|---|---|
| R3 | Jev | Re-verify every stitch from a second angle; cut the seams that fail. |
| R1, R2 | Jev | Is this block a fragment? Which neighbor is its other part? Options that structure rules out are never offered. |
| R4 | Jev | Second opinion on doubtful roles, with the neighbors' labels in view. |
| R13 | Jev | Lines repeated at a page edge, judged once per group with all their pages listed: running header or real content? |
| M1 | Jev | HTML: do the publisher's h1–h6 tags encode the outline? If so, they become hard evidence. |
| R8 | Jev | Cells printed side by side on one line, found anywhere on the page even when a table is read column by column: one glossary entry, one table row, or unrelated? Rows are rebuilt left to right. |
| R9 | Jev + code | Titles that occur more than once (contents lists, chapter cover pages, running titles): which occurrence is the real heading? Nearby copies fold into it. Bare labels ("CHAPTER II", "b.") join the heading they belong to. |
| R12 | Jev + code | Run-in headings ("(b) DEFINITIONS.—In this section…", "Risk-Reducing Features. This factor…") are split off the text they label, and title-only lines become headings. All-caps "TITLE.—" run-ins follow legislative drafting convention, so code splits them without asking. |
| R11 | code | The numbering stack, as a reader keeps it: (a) → (1) → (A) → (i). A number that continues an open sequence makes a sibling; (1), (A), (i) start a child. Roman-or-letter readings ("(i)" after "(h)") are settled by which reading continues a sequence. "SEC. 4B" sits between 4 and 5; § numbers and decimal outlines (4.5.1) count. |
| R10 | Jev | Headings the numbering can't place (unnumbered ones, sequences that start mid-way) pick their parent from the open path above. Options that contradict the numbering or trusted markup are never offered; if only one option is left, code takes it. |

**The loop.** Code measures parse health, then routes every open issue to a check:
- **Fragments and dangling hyphens:** which neighbor is the other part, or is it complete as it is?
- **Over-long headings:** where does the heading end?
- **Empty headings:** a parent of what follows, a heading split across lines, empty on purpose, or not a heading at all?
- **Numbering conflicts:** re-apply the numbering stack.
- **Unsure roles:** a runoff between the two or three roles Jev was torn between.

Health is re-measured after every check, and any check that made the parse worse is rolled back. Empty-heading decisions are applied, measured, and kept or undone one at a time. When two checks disagree, a tie-break question with all the evidence decides, and its answer is final. A block whose role has changed twice is settled. Issues that Jev reviewed and confirmed as correct (a "[Reserved]" part is empty on purpose) stay listed as **confirmed**, with the reason and the call.

**The split of labor.** What is arithmetic or convention happens in code: numbering sequences, drafting conventions (a lone "or" between items ends the earlier one), bare labels. Judgment goes to Jev. Every code rule is narrow and named in the audit trail.

**Reproducible.** Answers are applied in document order, never in the order Jev calls happen to finish. The same input therefore produces the same parse, and a rebuild is served entirely from cache: 19 documents in under 2 seconds, $0.

### Measured

Two answer keys the pipeline never optimizes against:
- **Statute indentation.** Each level of a printed statute is indented one step, so the first-line indent of a numbered provision, measured from the page's text margin, is its depth. Jev and the numbering stack never see it.
  - GENIUS Act: **99.4%** of 322 heading transitions agree. The two misses involve the legislative-history line at the very end.
  - CLARITY Act: **98.7%** of 225. Quoted amendatory text is excluded, since it is indented to its depth in the law it amends.
- **Federal Register tags.** **96.4%** of 196 transitions between tagged headings agree (93–99% per document). The Federal Register stops at `<h4>` for "1.", "a.", and "i.", so those 18 transitions can't be scored.
  - The publisher's tags are also used as evidence once M1 judges them trustworthy, so this key is not fully independent.

**Roles.** On a random blind sample of 100 blocks labeled by hand (`eval/`), **97 of 98** blocks that still stand alone have the right role; the other two are now correctly joined or split. The miss is a cell of the PWG report's recommendations table.

**Same document, two formats.** The Treasury rule is in the library twice, as Federal Register HTML and as the three-column print PDF, parsed independently. Matched block by block, **95%** get the same role, and **47 of 47** HTML headings are also headings in print. Most of the rest are paragraphs that open "First, … Second, … Finally, …", which one parse calls body text and the other list items.

**Parse health.** Code detects the symptoms of a bad parse: stray fragments, dangling hyphens, empty headings, over-long headings, levels that contradict the numbering, and unsure roles. Across the 24 documents they go from 824 to **30 open**, with 26 more confirmed correct by Jev. Most of the open ones are table cells and FCA Handbook annex stubs.
- **Can be gamed.** A stand-in that answers at random also drives open issues toward zero, by demoting headings. That is why the answer keys above, not this count, measure quality.

**Against retrieval and long context.** One exhaustive question, scored against a hand-checked key of the 17 GENIUS Act provisions that require a regulator to issue rules (`eval/rulemaking-key.json`):

| | Found | Time | Cost per question |
|---|---|---|---|
| Retrieval (BM25, top 20 of the 1,988 paragraphs) | 4 / 17 | instant | ~0 |
| Retrieval, top 50 | 11 / 17 | instant | ~0 |
| Claude reading all five documents in one prompt (289K tokens) | 17 / 17 | 231 s | $6.73 at API rates |
| RegLens, first run | 17 / 17 | 216 s | $0.15 Jev + ~$3 of Claude for the plan and the answer |
| RegLens, every rerun and re-slice | 17 / 17 | 0.4 s | $0 |

Retrieval misses most of the list because the mandates are worded a dozen ways and some only read as mandates with their lead-in. A frontier model reading everything finds them all, at a price that grows with the corpus and is paid again for every question; the whole library (~1.1M tokens) no longer fits in one prompt. RegLens reads the corpus once per question at Jev prices, keeps every judgment as a row with its page and call, and serves follow-ups from the cache (`eval/rag-baseline.py`, `eval/long-context.mjs`).

**When the answer is a dataset.** The same five documents, but a question whose answer runs to hundreds of rows: every paragraph that imposes a requirement on a stablecoin issuer, by topic. Scored on 200 paragraphs drawn at random and labeled blind (`eval/issuer-sample-labels.json`; about 380 such paragraphs exist when preamble descriptions of proposed requirements count, about 280 when only operative text does):

| | Found (recall) | Precision | Time | Cost |
|---|---|---|---|---|
| Claude reading all five documents in one prompt | 68% | 100% | 893 s | $10.83 at API rates |
| RegLens (2,435 Jev decisions) | 89% | 85% | 24 s | $0.05 |

With 17 answers, a frontier model reading everything found them all; with a few hundred, its list stopped about a third short, while every paragraph still got its own decision in RegLens. Most of RegLens's extra rows are preamble paragraphs that describe a proposed requirement rather than impose one (`eval/dataset-question.mjs`, `eval/score-dataset.py`). The sample holds 37 positives, so these rates are ±15 points; the labels were written by Claude, which if anything favors Claude's reading.

**Cost.** A cold build of all 24 documents (703 pages) is about 5,900 Jev calls, 82K decisions, and 38M input tokens: **$1.58**, about a fifth of a cent per page. A single new document typically builds in 2–30 seconds for a few cents.

```bash
node scripts/evaluate.mjs                           # answer keys + parse health for data/library
node --env-file-if-exists=.env scripts/structure.mjs [ids…]   # rebuild with Jev, print health per document
```

### Unseen documents

To test generality, five documents the pipeline had never seen went in through the app's own add path, before any tuning:
- the Federal Register *print* edition of the Treasury rule (three columns; its HTML version is in the library, so the two can be compared);
- the FSB's stablecoin recommendations (a policy report);
- an arXiv paper on DeFi (two columns, math symbols);
- the UK FCA's policy statement PS23/6;
- a scanned copy of OCC Interpretive Letter 1184: a synthetic scan, rendered with skew and speckle, with no text layer.

MiCA from EUR-Lex, FATF, BIS, SEC, and IOSCO block automated downloads.

| | First pass (no changes) | After the fixes it exposed |
|---|---|---|
| Roles, blind sample of 40 | 37 / 40 | 26 / 29 still standalone; 10 of 11 absorbed blocks correctly joined to their paragraphs |
| Print edition vs. HTML of the same rule: headings recovered | 21 / 48 | 42 / 50 |
| …and nesting agreement on matched headings | 18 / 20 | 41 / 41 |

What the unseen documents exposed, and what changed:
- **Extraction:**
  - Federal Register print style marks headings in *italic* and separates paragraphs only by first-line indent.
  - Papers number sections "3 DEFI PROTOCOLS".
  - Reports use "Recommendation 4:".
  - "Table of Contents" headings must never hold sections.
  - Margin paragraph numbers ("5.20") belong to their paragraphs.
- **Scanned pages:** read with Tesseract's word table. Low-confidence words (specks) are dropped before lines are rebuilt.
- **Columns:** the page-margin test took the median left edge of a page's paragraphs as the text margin. On a three-column Federal Register page that is the middle column, so about 900 blocks in four multi-column documents were marked as margin notes, and real headings ("A. Regulatory Flexibility Act") were demoted to page furniture. The margin is now measured from the outermost text column (paragraphs grouped by edge; a column's blocks must be wide, which margin notes are not). Open issues in those documents fell from 40 to 20.
- **Robustness:**
  - Text with math symbols could produce invalid Unicode; Jev rejected those requests until they were made well-formed.
  - A download that returns a challenge page instead of the document is now rejected cleanly.

### What's still open
- **Tables with irregular cells:** the PWG recommendations table, FCA's decision tables.
- **FCA Handbook annexes:** rule stubs like "2.2.20 G …" and empty annex headings.
- **Diagram labels (PWG report):** "Payment setup" in the stablecoin-minting diagram, which is drawn from small icons rather than an image.
- **Genuinely ambiguous lines:** a bill's back-page title, "Presidential Documents", and a few lines where Jev's runoff stays unsure.

## The document model (export)

`⇩ JSON` in the viewer, `GET /api/doc/<id>/export`, or `GET /api/export` for the whole library as NDJSON. Each
document (`reglens.document/1`) has three parts:
- **`outline`:** the section tree, each section with its role and topics.
- **`elements`:** every piece, in order, with:
  - `kind`: paragraph, list_item, definition, question, quote, field, heading, footnote, table_or_figure, toc_entry, front_matter, page_furniture
  - `text`, `path` (the outline path), `enumerator`, `level` for headings
  - `lead_in` for numbered items: the sentence that introduces them ("The term 'Bank Secrecy Act' means—")
  - `term` for definitions
  - `labels`: role, modality, deadline, with probabilities
  - `source`: page, bounding box, the pieces it was stitched from, html tag, the block it was split from
  - `audit`: what the audit changed, and why
  - `calls`: the Jev calls behind every label
- **`parse`:** health, every check's counts, and the number of Jev calls.

## Analyze: answering questions

A question becomes a **program**. Claude Code designs it, Jev runs it, and code aggregates it.
- **Rows** are paragraphs, sections, or documents from the structured library, filtered on base fields for free: role, modality, section role, document type, issuer, year…
  - A list item travels with its lead-in sentence, so "(B) chapter 2 of title I…" is judged as part of "The term 'Bank Secrecy Act' means—".
- **Nodes** are Jev questions stacked in layers with `when` conditions (nested ifs: *is it an obligation? → what type? → if notification → notify whom?*). Depth is cheap, since a node runs only on the rows that pass its conditions, so programs are trees of 3–7 layers whose branches get their own follow-ups.
- **Go deeper** grows a program after it has run. Click any segment of the Flow and ask a follow-up about just those rows, or let Claude find the shallow spots (big catch-all buckets, branches with no follow-up), for one round or three. Claude sees how Jev answered every question before adding layers. New questions are asked in their own Jev calls, so everything that already ran comes from the cache.
- **Relations** judge pairs of rows (implements / related, consistent / conflicting...). Pairs are blocked by a category and ranked by lexical similarity.
- **Views** are stats, heatmaps, bars, histograms, networks, coverage bars, and tables, computed in code.
- **Answers** are written by Claude from the aggregates and up to 150 evidence rows: every row a table view lists, then the units that passed the most layers of the program, spread across documents. The answer leads with substance (the specific requirements, numbers, parties, or gaps the question asks about, each cited to its row), then the patterns behind it.

The workspace has four tabs: **Answer**, **Table**, **Charts** (every mark clicks through to its rows), and **Flow** (each
question split by its answers, with a live feed of raw answers). The side panel opens when you click a citation, row, or
mark, and traces it back to its page.

Example analyses (in `programs/`): GENIUS Act implementation tracker, bank crypto stance over time, definition drift,
AML obligations, and two programs Claude Code planned from plain-English questions (foreign issuers, staking).

## Run it

Requirements:
- Node 22+.
- Python 3 with `pymupdf`, `beautifulsoup4`, and `lxml`, for extraction.
- The `claude` CLI, logged in (`claude` then `/login`).
- Tesseract (`brew install tesseract`), only for scanned PDFs.
- A decision-model key in `.env` (copy `.env.example`), or paste it into the key dialog from the header pill:
  - **OpenAI Decisions API:** `DECISIONS_PROVIDER=openai` and `OPENAI_API_KEY`. Uses `gpt-6-luna` at `/v1/decisions`.
  - **TypeSafe Jev:** `DECISIONS_PROVIDER=typesafe` and `TYPESAFE_API_KEY`.

```bash
npm start            # http://localhost:4317
```

**Choosing the decision model.** The pipeline is written against one question format: shared evidence plus a batch of named yes/no (`noul`), choice, and score questions, answered with probabilities. Both providers take that shape. `src/jev.mjs` sends Jev's format as is, and for OpenAI translates on the way out and back:

| | TypeSafe Jev | OpenAI Decisions API |
|---|---|---|
| Endpoint | `/v1/systemone` | `/v1/decisions` |
| Shared evidence | `state` (object) | `input` (the same fields, as labeled text) |
| Questions | map of name → question | list, each with a `name` (at most 200 per request; larger batches are split) |
| Yes/no | `noul` → `{ noul }` | `predicate` → `{ probability }` |
| Choice / score | `criteria` → probabilities by key | `choices` / `levels` → probabilities by value |
| Refusals | — | dropped; the question is treated as unanswered |
| Price (input tokens) | $0.042 / M | $0.10 / M (cached input free) |

Answers are cached by a hash of the exact request sent, so switching providers never mixes their answers; the first run on a new provider is a cold build. The measurements in this README were made with Jev.

To rebuild from the raw sources:

```bash
python3 scripts/extract.py sources/manifest.json sources/raw data/library   # extraction (code)
node --env-file-if-exists=.env scripts/structure.mjs                         # structuring (decision model)
```

## Notes from building it

- **Measure against keys the system can't game.** Parse health is a useful router for the loop, but a random answerer
  can drive it to zero. Printed indentation and publisher tags caught what health could not:
  - a dropped "(i)/(ii)" ambiguity;
  - "Section 507 of title 11" read as a section heading;
  - the Federal Register's § headings missing from extraction entirely (they sit in bare `<div>`s).
- **Ask Jev local and comparative questions.** "Which occurrence is the real heading?" and "which open heading is this
  under?" beat "what level is this?". When the evidence is a pattern across pages, ask once per group: "this line is
  printed atop pages 145–164: running header?"
- **Jev's confidence is a margin, not a probability.** 53% vs 47% comes back as confidence 0.07. Thresholds that act
  on a choice use the chosen option's probability. The unsure-role flag uses the margin.
- **Don't let two checks fight.** Without a tie-break and a flip limit, the empty-heading check and the role runoff
  flipped "Trends in Crypto Lending" back and forth forever.
- **Apply answers in document order.** Applying answers as calls finished made results depend on network timing:
  equal-confidence stitches, overlapping rows. The same input then produced different parses and new, uncached calls.
- **Precise prompts beat compact ones.** Moving role definitions and stitch rules out of each question and into
  shared state cut tokens 13–40%. But it changed 4–10% of answers, mostly for the worse (more false joins), so the
  precise prompts stay.
- **Packed calls must quote their target.** Referring to rows by index (`` `units[3]` ``) drifted badly: 9 of 12
  answers were wrong. Quoting each row's text matched one-call-per-row answers at ~30% fewer tokens.

## Layout

```
sources/          manifest.json + raw PDFs/HTML
scripts/          extract.py (segmentation, OCR for scans), structure.mjs (Jev structuring CLI), evaluate.mjs (answer keys), bench.mjs
eval/             blind role samples, hand-labeled (100 from the tuning set, 40 from unseen documents) + scorer
src/library.mjs   structuring DAG, audit stack + issue loop, numbering stack, outline, export
src/program.mjs   program schema, rows, layered execution, relations, views
src/planner.mjs   Claude Code CLI: plan + insights (streamed)
src/jev.mjs       Jev client: rate limits, retries, cache
server.mjs        NDJSON streaming API
public/           UI (vanilla JS): build.js (live parse), library.js (documents), data.js (aggregated data), analyze.js (query)
programs/         saved analyses
```

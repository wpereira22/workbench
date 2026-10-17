// Base layer (Graph 1): raw regulation text -> semantic structure (doc profile, section roles,
// topics, paragraph modality). Runs once; results are materialized and every program can
// filter or group on them without new model calls.
import { yes } from "./jev.mjs";
import { Run } from "./run.mjs";

export const TOPICS = {
  security_program: "Information security programs, safeguards, or controls",
  personal_data: "Collection, use, sharing, or disclosure of personal information",
  children: "Children or minors",
  notice_consent: "Notices to individuals or obtaining their consent",
  email_marketing: "Commercial email messages",
  phone_marketing: "Telemarketing, sales calls, or robocalls",
  advertising: "Advertising claims, endorsements, testimonials, or reviews",
  incidents_breaches: "Security incidents, data breaches, or notifying people about them",
  identity_theft: "Detecting or preventing identity theft",
  health: "Health information, patients, or healthcare organizations",
  customer_identity: "Identifying customers or their beneficial owners",
  reporting_disclosure: "Reporting or disclosing information to regulators, investors, or the public",
  vendors: "Service providers, vendors, or other third parties",
  recordkeeping: "Recordkeeping, documentation, or retention",
};

const ROLES = {
  scope: "States the purpose or scope, or who the rule applies to",
  definitions: "Defines terms used in the rule",
  requirements: "Imposes duties: things regulated parties must do",
  prohibitions: "Forbids specific conduct",
  exemptions: "Creates exceptions, exemptions, or safe harbors",
  procedures: "Administrative mechanics: effective dates, compliance dates, severability",
  guidance: "Advisory guidance or illustrative examples rather than binding rules",
};

const MODALITY = {
  must: "Requires someone to do something",
  must_not: "Forbids someone from doing something",
  may: "Permits something, or creates an exception or safe harbor",
  defines: "Defines what a term means",
  context: "A heading, cross-reference, example, or background with no rule of its own",
};

const CHUNK = 25; // paragraphs per packed request
const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const sectionText = (s, max = 60000) => s.paragraphs.join("\n").slice(0, max);
const clip = (s, n) => (s.length > n ? s.slice(0, n) + " …" : s);

// ───────────────────────────── Graph 1: parse ─────────────────────────────

export async function runParse({ corpus, jev, emit }) {
  const run = new Run(emit);
  const out = { docs: {}, builtAt: new Date().toISOString() };

  await Promise.all(
    corpus.map(async (doc) => {
      const d = (out.docs[doc.id] = { profile: null, sections: {} });

      // P1: whole-document profile. What kind of document is this?
      const opening = doc.sections.flatMap((s) => [s.heading, ...s.paragraphs]).join("\n").slice(0, 8000);
      const p1 = await run.call(jev, {
        stage: "P1 profile",
        target: doc.id,
        state: { section_headings: doc.sections.map((s) => s.heading), opening_text: opening },
        questions: {
          kind: {
            type: "choice",
            instructions: "What kind of legal document is this?",
            criteria: {
              binding_rule: "A binding regulation that imposes legal requirements",
              guidance: "Agency guides or interpretations that are advisory rather than binding",
              disclosure_item: "Specifies what a company must disclose in its filings or reports",
            },
          },
          regulator: {
            type: "choice",
            instructions: "Which regulator issued this document?",
            criteria: {
              FTC: "Federal Trade Commission",
              HHS: "Department of Health and Human Services",
              SEC: "Securities and Exchange Commission",
              FinCEN: "Financial Crimes Enforcement Network (Treasury)",
              other: "Another agency",
            },
          },
          domain: {
            type: "choice",
            instructions: "What is the primary subject area of this document?",
            criteria: {
              privacy: "Privacy of personal information",
              security: "Information security and cybersecurity",
              marketing: "Marketing, advertising, and sales practices",
              financial_crime: "Fraud, identity theft, and anti-money-laundering",
              health: "Healthcare information",
              securities: "Securities markets and investor disclosure",
            },
          },
          has_definitions: { type: "noul", instructions: "Does this document contain a section that defines terms?" },
        },
      });
      if (p1) {
        const a = p1.answers;
        d.profile = { kind: a.kind?.choice, regulator: a.regulator?.choice, domain: a.domain?.choice, hasDefinitions: yes(a.has_definitions), lineage: [p1.id] };
        emit({ t: "profile", docId: doc.id, profile: d.profile });
      }

      // P2: every section: role + topic tags + burden, all speculative in one call.
      await Promise.all(
        doc.sections.map(async (sec) => {
          const questions = {
            role: { type: "choice", instructions: "What role does this section play in the regulation?", criteria: ROLES },
            burden: {
              type: "score",
              instructions: "How much compliance work does this section create for regulated parties?",
              criteria: ["None: no obligations", "Light: a one-off or narrow obligation", "Moderate: several operational obligations", "Heavy: an ongoing program with many obligations"],
            },
          };
          for (const [k, v] of Object.entries(TOPICS)) questions[`topic_${k}`] = { type: "noul", instructions: `Does this section address: ${v}?` };

          const p2 = await run.call(jev, {
            stage: "P2 section",
            target: sec.id,
            state: { document: doc.title, section: sec.heading, text: sectionText(sec) },
            questions,
          });
          const s = (d.sections[sec.id] = { role: null, topics: {}, burden: null, paragraphs: sec.paragraphs.map(() => ({})), lineage: [] });
          if (!p2) return;
          const a = p2.answers;
          s.role = a.role?.choice;
          s.roleProbs = a.role?.probabilities;
          s.burden = yes(a.burden);
          for (const k of Object.keys(TOPICS)) s.topics[k] = yes(a[`topic_${k}`]);
          s.lineage.push(p2.id);
          emit({ t: "section", sectionId: sec.id, role: s.role, topics: s.topics, burden: s.burden });

          // P3: conditional branch. Definitions sections get term detection; everything else
          // gets modality + deadline per paragraph. Paragraphs are packed into one request
          // and referenced by path, so one call carries dozens of predicates.
          const isDefs = s.role === "definitions" && (d.profile?.hasDefinitions ?? 1) > 0.3;
          await Promise.all(chunks(sec.paragraphs, CHUNK).map(async (chunk, ci) => {
            const base = ci * CHUNK;
            const qs = {};
            chunk.forEach((_, i) => {
              // Quote the target; the chunk in the state is context (index-only references drift).
              const ask = (q) => ({ question: `${q} Answer about the paragraph in \`target\` only; \`paragraphs\` in the state is surrounding context.`, target: chunk[i] });
              if (isDefs) {
                qs[`p${i}_defines`] = { type: "noul", instructions: ask("Does this paragraph introduce and define a new term?") };
              } else {
                qs[`p${i}_modality`] = { type: "choice", instructions: ask("What does this paragraph do? A list item that continues a sentence imposing a duty counts as that duty."), criteria: MODALITY };
                qs[`p${i}_deadline`] = { type: "noul", instructions: ask("Does this paragraph set a deadline, time limit, or required frequency?") };
              }
            });
            const p3 = await run.call(jev, {
              stage: isDefs ? "P3 definitions" : "P3 modality",
              target: sec.id,
              state: { document: doc.title, section: sec.heading, paragraphs: chunk },
              questions: qs,
            });
            if (!p3) return;
            s.lineage.push(p3.id);
            chunk.forEach((_, i) => {
              const a = p3.answers;
              const para = s.paragraphs[base + i];
              if (isDefs) {
                para.modality = yes(a[`p${i}_defines`]) > 0.5 ? "defines" : "context";
              } else {
                para.modality = a[`p${i}_modality`]?.choice;
                para.deadline = yes(a[`p${i}_deadline`]);
              }
              para.lineage = p3.id;
            });
            emit({ t: "paragraphs", sectionId: sec.id, from: base, paragraphs: s.paragraphs.slice(base, base + chunk.length) });
          }));
        }),
      );
    }),
  );

  out.metrics = run.metrics();
  out.lineage = Object.fromEntries(run.lineage);
  emit({ t: "done", m: out.metrics });
  return out;
}

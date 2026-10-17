// Fetches 10 real regulations from the official eCFR API and flattens them into
// section/paragraph JSON. Segmentation is deterministic (the § headings); all
// semantic structure is added later by Jev in the parse DAG.
import { writeFile, mkdir } from "node:fs/promises";

const DOCS = [
  { id: "ftc-safeguards", citation: "16 CFR Part 314", title: "FTC Safeguards Rule", title_no: 16, q: "part=314" },
  { id: "coppa", citation: "16 CFR Part 312", title: "Children's Online Privacy Protection Rule (COPPA)", title_no: 16, q: "part=312" },
  { id: "can-spam", citation: "16 CFR Part 316", title: "CAN-SPAM Rule", title_no: 16, q: "part=316" },
  { id: "red-flags", citation: "16 CFR Part 681", title: "Identity Theft Red Flags Rule", title_no: 16, q: "part=681" },
  { id: "telemarketing", citation: "16 CFR Part 310", title: "Telemarketing Sales Rule", title_no: 16, q: "part=310" },
  { id: "endorsements", citation: "16 CFR Part 255", title: "Guides Concerning Endorsements and Testimonials in Advertising", title_no: 16, q: "part=255" },
  { id: "hipaa-security", citation: "45 CFR Part 164, Subpart C", title: "HIPAA Security Rule", title_no: 45, q: "part=164&subpart=C" },
  { id: "hipaa-breach", citation: "45 CFR Part 164, Subpart D", title: "HIPAA Breach Notification Rule", title_no: 45, q: "part=164&subpart=D" },
  { id: "sec-cyber", citation: "17 CFR 229.106", title: "SEC Regulation S-K Item 106: Cybersecurity", title_no: 17, q: "section=229.106" },
  { id: "cdd-rule", citation: "31 CFR 1010.230", title: "FinCEN Customer Due Diligence Rule", title_no: 31, q: "section=1010.230" },
  { id: "reg-sp", citation: "17 CFR 248.30", title: "SEC Regulation S-P §248.30 (2024 amendments): Safeguards, Incident Response & Customer Notice", title_no: 17, q: "section=248.30" },
  { id: "reg-bi", citation: "17 CFR 240.15l-1", title: "SEC Regulation Best Interest", title_no: 17, q: "section=240.15l-1" },
];

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#8212;": "—", "&#8211;": "–", "&#167;": "§" };
const decode = (s) =>
  s.replace(/&(?:amp|lt|gt|quot|apos|#x?[0-9a-fA-F]+);/g, (m) =>
    ENTITIES[m] ?? String.fromCodePoint(m[2] === "x" ? parseInt(m.slice(3, -1), 16) : Number(m.slice(2, -1))));
const clean = (s) => decode(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

async function latestDate(titleNo) {
  const res = await fetch("https://www.ecfr.gov/api/versioner/v1/titles.json");
  const { titles } = await res.json();
  return titles.find((t) => t.number === titleNo).up_to_date_as_of;
}

function parseSections(xml) {
  const sections = [];
  // DIV8 = sections, DIV9 = appendices; neither nests inside the other.
  const re = /<(DIV8|DIV9)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  for (const [, , attrs, body] of xml.matchAll(re)) {
    const n = /\bN="([^"]+)"/.exec(attrs)?.[1] ?? "";
    const heading = clean(/<HEAD>([\s\S]*?)<\/HEAD>/.exec(body)?.[1] ?? n);
    const paragraphs = [];
    const blockRe = /<(P|FP|HD1|HD2|HD3|NOTE|TR)\b[^>]*>([\s\S]*?)<\/\1>/g;
    for (const [, tag, inner] of body.matchAll(blockRe)) {
      const text =
        tag === "TR"
          ? [...inner.matchAll(/<T[DH]\b[^>]*>([\s\S]*?)<\/T[DH]>/g)].map((m) => clean(m[1])).filter(Boolean).join(" | ")
          : clean(inner);
      if (text && text.length > 1) paragraphs.push(text);
    }
    if (/\[Reserved\]/i.test(heading) && paragraphs.length === 0) continue;
    sections.push({ n, heading, paragraphs });
  }
  return sections;
}

await mkdir(new URL("../corpus/", import.meta.url), { recursive: true });
const index = [];
for (const doc of DOCS) {
  const date = await latestDate(doc.title_no);
  const url = `https://www.ecfr.gov/api/versioner/v1/full/${date}/title-${doc.title_no}.xml?${doc.q}`;
  const res = await fetch(url, { headers: { "Accept-Encoding": "gzip" } });
  if (!res.ok) throw new Error(`${doc.id}: HTTP ${res.status}`);
  const xml = await res.text();
  const sections = parseSections(xml).map((s, i) => ({ id: `${doc.id}/s${i}`, ...s }));
  const humanUrl = `https://www.ecfr.gov/current/title-${doc.title_no}/${doc.q.startsWith("section") ? "section-" + doc.q.split("=")[1] : "part-" + doc.q.split("=")[1].split("&")[0]}`;
  const { citation } = doc;
  const out = { id: doc.id, title: doc.title, citation, asOf: date, source: humanUrl, sections };
  await writeFile(new URL(`../corpus/${doc.id}.json`, import.meta.url), JSON.stringify(out, null, 1));
  const paras = sections.reduce((a, s) => a + s.paragraphs.length, 0);
  index.push({ id: doc.id, title: doc.title, citation, sections: sections.length, paragraphs: paras });
  console.log(`${doc.id.padEnd(16)} ${String(sections.length).padStart(3)} sections ${String(paras).padStart(4)} paragraphs  (${date})`);
}
await writeFile(new URL("../corpus/index.json", import.meta.url), JSON.stringify(index, null, 1));

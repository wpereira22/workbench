#!/usr/bin/env python3
"""Deterministic extraction: source files -> blocks with provenance.

Every block keeps where it came from (page + bounding box for PDFs, element tag for HTML) so
anything Jev later says about it can be traced back to the exact spot in the original.
No semantics here: deciding what a block *is* (heading, footnote, running header...) is Jev's job.

usage: extract.py <manifest.json> <raw_dir> <out_dir> [doc_id ...]
"""
import json, re, sys, statistics
from collections import Counter
from pathlib import Path

import fitz  # PyMuPDF
from bs4 import BeautifulSoup

ZOOM = 1.3  # page image scale for the viewer
ENUM = re.compile(r"^[‘'\"“]*(\(?[a-zA-Z0-9]{1,5}\)|SEC\.|Sec\.|SECTION|§|[IVX]{1,5}\.\s|[A-Z]\.\s|\d{1,2}\.\s|[•▪◦●\-–]\s)")
TRAILING_LINENO = re.compile(r"\s+(\d{1,2})$")


def clean(s):
    return re.sub(r"\s+", " ", s.replace("­", "")).strip()


def join_lines(lines):
    out = ""
    for t in lines:
        t = t.strip()
        if not t:
            continue
        if out.endswith("-") and t[:1].islower():
            out = out[:-1] + t  # de-hyphenate "stak-" + "ing"
        else:
            out = (out + " " + t) if out else t
    return clean(out)


def union(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


# ───────────────────────────── PDF ─────────────────────────────

OCR_JUNK = re.compile(r"[^\w“”\"'(§$%]{1,3}")
OCR_LEAD = re.compile(r"^(?:[^\w“”\"'(§$%\s]{1,3}\s+)+")


def tessdata():
    """Where Tesseract keeps its language data, if it is installed (for scanned pages)."""
    import os, shutil
    for p in [os.environ.get("TESSDATA_PREFIX"), "/opt/homebrew/share/tessdata", "/usr/local/share/tessdata", "/usr/share/tesseract-ocr/5/tessdata", "/usr/share/tesseract-ocr/4.00/tessdata", "/usr/share/tessdata"]:
        if p and os.path.exists(os.path.join(p, "eng.traineddata")):
            return p
    return None


def ocr_page(page, tess):
    """Scanned page -> text lines, via the Tesseract CLI's word table: every word comes with a box and a confidence,
    so specks and smudges read as low-confidence junk can be dropped before lines are rebuilt."""
    import subprocess, tempfile, os
    zoom = 300 / 72
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), colorspace=fitz.csGRAY)
    with tempfile.TemporaryDirectory() as tmp:
        img = os.path.join(tmp, "p.png")
        pix.save(img)
        env = {**os.environ, "TESSDATA_PREFIX": tess}
        out = subprocess.run(["tesseract", img, "stdout", "--psm", "3", "-l", "eng", "tsv"], capture_output=True, text=True, env=env).stdout
    rows = [r.split("\t") for r in out.splitlines()[1:]]
    lines = {}
    for r in rows:
        if len(r) < 12 or r[0] != "5":
            continue
        word, conf = r[11].strip(), float(r[10])
        if not word or conf < 55 or (conf < 75 and sum(c.isalnum() for c in word) < 3):
            continue
        x, y, w, h = (int(v) / zoom for v in r[6:10])
        key = (r[2], r[3], r[4])  # block, paragraph, line
        lines.setdefault(key, []).append((x, y, w, h, word))
    out_lines = []
    for ws in lines.values():
        ws.sort()
        x0, y0 = min(w[0] for w in ws), min(w[1] for w in ws)
        x1, y1 = max(w[0] + w[2] for w in ws), max(w[1] + w[3] for w in ws)
        text = " ".join(w[4] for w in ws)
        if sum(c.isalnum() for c in text) < 2:
            continue
        hs = sorted(w[3] for w in ws)
        out_lines.append({"text": text, "bbox": [x0, y0, x1, y1], "size": round(hs[len(hs) // 2] * 0.85, 1), "bold": 0.0, "italic": 0.0, "block": 0})
    out_lines.sort(key=lambda l: (round(l["bbox"][1] / 4), l["bbox"][0]))
    return out_lines


def pdf_lines(doc):
    """All text lines with geometry and font features, in reading order per page. Scanned pages (an image and no
    text layer) are read with Tesseract OCR when it is installed."""
    pages = []
    tess = tessdata()
    for pno, page in enumerate(doc):
        ocr = bool(len(page.get_text().strip()) < 20 and page.get_images() and tess)
        if ocr:
            pages.append({"w": page.rect.width, "h": page.rect.height, "lines": ocr_page(page, tess), "images": len(page.get_images()), "graphics": [], "ocr": True})
            continue
        d = page.get_text("dict", sort=False)
        lines = []
        for bi, b in enumerate(d["blocks"]):
            if b["type"] != 0:
                continue
            for l in b["lines"]:
                # Some PDFs overprint text (a shadow or bold effect): the same run appears twice at the same spot.
                seen, spans = set(), []
                for sp in l["spans"]:
                    if not sp["text"].strip():
                        continue
                    # OCR reads specks and smudges as stray punctuation: drop tokens with no letters or digits.
                    if ocr and OCR_JUNK.fullmatch(sp["text"].strip()):
                        continue
                    key = (sp["text"].strip(), round(sp["bbox"][0]), round(sp["bbox"][1]))
                    if key in seen:
                        continue
                    seen.add(key)
                    spans.append(sp)
                if not spans:
                    continue
                text = "".join(s["text"] for s in spans)
                if ocr:
                    text = OCR_LEAD.sub("", text)
                    if sum(c.isalnum() for c in text) < 2:
                        continue
                size = statistics.median(s["size"] for s in spans)
                total = max(1, sum(len(s["text"]) for s in spans))
                bold = sum(len(s["text"]) for s in spans if s["flags"] & 16 or "Bold" in s["font"]) / total
                italic = sum(len(s["text"]) for s in spans if s["flags"] & 2 or "Italic" in s["font"] or "Oblique" in s["font"]) / total
                lines.append({"text": text, "bbox": list(l["bbox"]), "size": round(size, 1), "bold": round(bold, 2), "italic": round(italic, 2), "block": bi})
        # Overprinted text (shadow/bold effects) arrives as a second identical line at the same spot: drop it.
        kept = []
        for l in lines:
            t = l["text"].strip()
            def overlap(a, b):
                ix = max(0, min(a[2], b[2]) - max(a[0], b[0])); iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
                inter = ix * iy
                area = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1])) or 1
                return inter / area
            # ...or as a shorter copy of a longer line drawn over it ("Table of Recommendations" under
            # "Table of Recommendations......"): keep the longer one.
            hit = next((i for i, k in enumerate(kept) if overlap(k["bbox"], l["bbox"]) > 0.6 and (k["text"].strip().startswith(t) or t.startswith(k["text"].strip()))), None)
            if hit is not None:
                if len(t) > len(kept[hit]["text"].strip()):
                    kept[hit] = l
                continue
            kept.append(l)
        # Pictures big enough to be figures (charts, diagrams): where they sit tells a figure title from a heading.
        graphics = []
        for im in ([] if ocr else page.get_image_info()):
            x0, y0, x1, y1 = im["bbox"]
            if x1 - x0 >= 40 and y1 - y0 >= 40:
                graphics.append([round(v, 1) for v in (x0, y0, x1, y1)])
        pages.append({"w": page.rect.width, "h": page.rect.height, "lines": kept, "images": sum(1 for b in d["blocks"] if b["type"] == 1), "graphics": graphics, "ocr": ocr})
    return pages


MARGIN_NO = re.compile(r"^\s*(\d{1,2})\s*$")


def is_margin_number(l, page_w):
    m = MARGIN_NO.match(l["text"])
    return bool(m) and 1 <= int(m.group(1)) <= 30 and l["bbox"][2] < 0.3 * page_w


def is_line_numbered(pages):
    """Bills print 1-25 line numbers in the left margin as their own text lines."""
    total = hits = 0
    for p in pages:
        for l in p["lines"]:
            total += 1
            hits += is_margin_number(l, p["w"])
    return total > 50 and hits / total > 0.25


def segment_pdf(pages):
    numbered = is_line_numbered(pages)
    sizes = [l["size"] for p in pages for l in p["lines"]]
    body = statistics.median(sizes) if sizes else 10
    blocks = []
    for pno, p in enumerate(pages):
        cur = None
        ocr = p.get("ocr", False)

        def flush():
            nonlocal cur
            if cur and cur["lines"]:
                text = join_lines(cur["lines"])
                if text:
                    blocks.append({"page": pno + 1, "bbox": [round(v, 1) for v in union(cur["boxes"])], "text": text,
                                   "size": round(statistics.median(cur["sizes"]), 1), "bold": round(sum(cur["bolds"]) / len(cur["bolds"]), 2),
                                   "italic": round(sum(cur["italics"]) / len(cur["italics"]), 2),
                                   "lines": len(cur["lines"]), "x_first": round(cur["boxes"][0][0], 1)})
            cur = None

        prev = None
        for l in p["lines"]:
            text = l["text"]
            if numbered and is_margin_number(l, p["w"]):
                continue
            t = text.strip()
            if not t:
                continue
            new = cur is None or prev is None
            # Fragments on the same visual line (small caps, font switches) belong together.
            same_line = not new and min(l["bbox"][3], prev["bbox"][3]) - max(l["bbox"][1], prev["bbox"][1]) > 0.5 * min(l["bbox"][3] - l["bbox"][1], prev["bbox"][3] - prev["bbox"][1]) and 0 <= l["bbox"][0] - prev["bbox"][2] < 15
            if same_line:
                cur["lines"][-1] = cur["lines"][-1].rstrip() + " " + text.strip()
                cur["boxes"].append(l["bbox"])
                prev = {**l, "bbox": union([prev["bbox"], l["bbox"]]), "size": prev["size"], "bold": prev["bold"], "italic": prev.get("italic", 0)}
                continue
            if not new:
                gap = l["bbox"][1] - prev["bbox"][3]
                lh = max(1.0, prev["bbox"][3] - prev["bbox"][1])
                # OCR estimates a size per line and groups lines unreliably: allow size jitter, ignore its blocks.
                size_change = abs(l["size"] - prev["size"]) > (0.2 * prev["size"] if ocr else 0.9)
                bold_change = abs(l["bold"] - prev["bold"]) > 0.6
                # A line set entirely in italics next to a roman one: an italic heading (Federal Register print style).
                italic_change = (prev.get("italic", 0) >= 0.9 and l.get("italic", 0) <= 0.2) or (prev.get("italic", 0) <= 0.2 and l.get("italic", 0) >= 0.9 and len(t.split()) <= 14)
                # A first-line indent starts a new paragraph when the block's other lines share a left edge.
                body_left = min(b[0] for b in cur["boxes"][1:]) if len(cur["boxes"]) >= 2 else None
                para_indent = body_left is not None and 3 < l["bbox"][0] - body_left < 40
                # ...or when a line that stops well short of the column is followed by an indented one.
                width = l["bbox"][2] - l["bbox"][0]
                para_indent = para_indent or (3 < l["bbox"][0] - prev["bbox"][0] < 40 and l["bbox"][2] > prev["bbox"][2] + 0.15 * width)
                other_block = (not numbered) and not ocr and l["block"] != prev["block"]
                big_gap = gap > (1.2 if numbered else 0.55) * lh
                side_by_side = l["bbox"][0] > prev["bbox"][2] or l["bbox"][2] < prev["bbox"][0]  # margin notes
                starts_item = bool(ENUM.match(t)) and (prev["text"].rstrip().endswith((".", ";", ":", "—", "and", "or")) or l["bbox"][0] - prev["bbox"][0] > 6 or prev["bbox"][0] - l["bbox"][0] > 6)
                new = size_change or bold_change or italic_change or para_indent or other_block or big_gap or side_by_side or starts_item
            if new:
                flush()
                cur = {"lines": [], "boxes": [], "sizes": [], "bolds": [], "italics": []}
            cur["lines"].append(text)
            cur["boxes"].append(l["bbox"])
            cur["sizes"].append(l["size"])
            cur["bolds"].append(l["bold"])
            cur["italics"].append(l.get("italic", 0))
            prev = l
        flush()

    # Running headers/footers: same text (digits masked) near the page edge on many pages.
    norm = lambda s: re.sub(r"\d+", "#", s.lower())[:80]
    edge = Counter()
    for b in blocks:
        h = pages[b["page"] - 1]["h"]
        if b["bbox"][1] < 0.13 * h or b["bbox"][3] > 0.92 * h:
            edge[norm(b["text"])] += 1
    n_pages = len(pages)
    for b in blocks:
        h = pages[b["page"] - 1]["h"]
        b["zone"] = "top" if b["bbox"][1] < 0.13 * h else "bottom" if b["bbox"][3] > 0.92 * h else "body"
        # Chapter-specific running headers repeat on a run of pages, not on a quarter of the document.
        b["repeats"] = n_pages > 2 and edge[norm(b["text"])] >= max(3, 0.05 * n_pages) and b["zone"] != "body"
        b["rel_size"] = round(b["size"] / body, 2)
    return blocks, numbered


def pdf_title(doc, blocks):
    """An uploaded file's title: the PDF's own title metadata if it reads like one, else the largest text on page 1."""
    t = clean((doc.metadata or {}).get("title") or "")
    if len(t) >= 8 and not re.search(r"\.(docx?|pdf|indd)$|^untitled|^microsoft word", t, re.I):
        return t[:160]
    first = [b for b in blocks if b["page"] == 1 and len(b["text"]) >= 6]
    if not first:
        return None
    return max(first, key=lambda b: (b["size"], -b["bbox"][1]))["text"][:160]


def render_pages(doc, out):
    out.mkdir(parents=True, exist_ok=True)
    for i, page in enumerate(doc):
        f = out / f"{i + 1}.jpg"
        if f.exists():
            continue
        pix = page.get_pixmap(matrix=fitz.Matrix(ZOOM, ZOOM), alpha=False)
        f.write_bytes(pix.tobytes("jpeg", jpg_quality=72))


# ───────────────────────────── HTML ─────────────────────────────

TAGS = ["h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "pre", "tr", "dt", "dd"]


def main_container(soup, fmt_hint):
    if fmt_hint == "fr":
        return soup.body or soup
    cands = soup.find_all(["main", "article", "div", "section"])
    return max(cands, key=lambda e: sum(len(p.get_text()) for p in e.find_all("p"))) if cands else soup


def segment_html(html, fr=False):
    soup = BeautifulSoup(html, "lxml")
    for bad in soup(["script", "style", "nav", "noscript", "header", "footer", "form", "button"]):
        bad.decompose()
    # Site help that isn't part of the document: hover descriptions, tooltips, modals, screen-reader-only text.
    for bad in soup.find_all(class_=re.compile(r"(^|[-_])(tooltip|popover|modal|sr-only|visually-hidden)($|[-_])|fr-seal-desc")):
        bad.decompose()
    root = main_container(soup, "fr" if fr else "")
    blocks = []
    # Text can also sit directly in a div with no block children (the Federal Register prints each rule section's
    # number and subject that way): those leaf divs are blocks too.
    BLOCKISH = set(TAGS) | {"div", "ul", "ol", "table", "dl", "section", "article", "blockquote"}
    leaf_div = lambda e: e.name == "div" and not e.find(lambda t: t.name in BLOCKISH) and len(clean(e.get_text(" "))) >= 2
    for el in root.find_all(lambda e: e.name in TAGS or leaf_div(e)):
        if el.find_parent(TAGS) and el.name != "tr":
            continue  # nested (e.g. p inside li): the outer element carries the text
        if el.name == "tr":
            text = " | ".join(clean(td.get_text(" ")) for td in el.find_all(["td", "th"]))
        else:
            text = clean(el.get_text(" "))
        if not text or len(text) < 2:
            continue
        cls = " ".join(el.get("class") or [])
        parent_cls = " ".join(" ".join(p.get("class") or []) for p in el.parents if p.name == "div")[:200]
        blocks.append({"page": None, "bbox": None, "text": text, "tag": el.name, "cls": clean(cls)[:60],
                       "in_footnotes": "footnote" in parent_cls, "zone": "body", "repeats": False})
    # A section number followed by its subject ("§ 247.11" + "Reserve assets.") is one heading line.
    out = []
    for b in blocks:
        if out and "section-subject" in b["cls"] and "sectno" in out[-1]["cls"]:
            out[-1] = {**out[-1], "text": f'{out[-1]["text"]} {b["text"]}', "cls": "sectno section-subject"}
            continue
        out.append(b)
    return out


# ───────────────────────────── main ─────────────────────────────

def main():
    manifest, raw, out_root = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    only = set(sys.argv[4:])
    m = json.loads(manifest.read_text())
    for d in m["documents"]:
        if only and d["id"] not in only:
            continue
        src = raw / d["file"]
        out = out_root / d["id"]
        out.mkdir(parents=True, exist_ok=True)
        meta = {k: d[k] for k in ("id", "title", "short", "issuer", "date", "format", "url")}
        if d["format"] == "pdf":
            doc = fitz.open(src)
            pages = pdf_lines(doc)
            blocks, numbered = segment_pdf(pages)
            if d.get("auto_title"):
                meta["title"] = pdf_title(doc, blocks) or meta["title"]
            render_pages(doc, out / "pages")
            meta["pages"] = [{"n": i + 1, "w": p["w"], "h": p["h"], "images": p["images"], "graphics": p["graphics"], **({"ocr": True} if p["ocr"] else {})} for i, p in enumerate(pages)]
            meta["line_numbered"] = numbered
            meta["zoom"] = ZOOM
        elif d["format"] == "html":
            blocks = segment_html(src.read_text(errors="ignore"), fr=d["file"].startswith("fr-"))
            meta["pages"] = []
        else:  # web capture: [[tag, text], ...]
            j = json.loads(src.read_text())
            blocks = [{"page": None, "bbox": None, "text": clean(t), "tag": tag, "cls": "", "in_footnotes": bool(re.match(r"^\[\d+\]", t)), "zone": "body", "repeats": False} for tag, t in j["blocks"]]
            meta["pages"] = []
        for i, b in enumerate(blocks):
            b["id"] = f"b{i}"
        meta["blocks"] = blocks
        meta["chars"] = sum(len(b["text"]) for b in blocks)
        (out / "doc.json").write_text(json.dumps(meta, ensure_ascii=False))
        print(f"{d['id']:26} {d['format']:5} pages={len(meta['pages']):4} blocks={len(blocks):5} chars={meta['chars']:7}" + ("  (line-numbered)" if meta.get("line_numbered") else ""), flush=True)


if __name__ == "__main__":
    main()

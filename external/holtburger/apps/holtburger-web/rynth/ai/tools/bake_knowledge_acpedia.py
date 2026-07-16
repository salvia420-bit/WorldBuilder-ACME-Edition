#!/usr/bin/env python3
"""bake_knowledge_acpedia.py — bake the AI director's knowledge corpus
(knowledge.acpedia.json, gitignored like other baked data) from the acpedia
wikidump.

Input (defaults match this laptop's checkout; override with flags):
  --history  acpediaorg-20210615-history.xml  (1.4 GB FULL-history dump —
             streamed with iterparse; each page's LATEST revision is chosen
             by timestamp, the dump's revision order is not chronological)
  --index    acpedia_index.jsonl              ({title, redirect?, ns} rows —
             redirect rows become aliases of their target article)

Output: a JSON array of {title, aliases?, text} rows — exactly the
FileKnowledgeProvider corpus shape (rynth/ai/tools/knowledge.js:46-52).
URLs are omitted deliberately: the director's LLM cannot browse, and they
cost ~40% of the file.

Only ns=0 non-redirect articles with a usable cleaned summary are kept.
Wikitext cleanup is best-effort: templates/tables/refs/files stripped,
links reduced to their labels, first prose lines kept up to --max-chars.

Run:  python3 rynth/ai/tools/bake_knowledge_acpedia.py
      (from apps/holtburger-web/; ~2-4 min, streaming, low memory)
"""

import argparse
import html
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

MW_NS = "{http://www.mediawiki.org/xml/export-0.6/}"

DEFAULT_ACPD = "/home/wbterminal/WorldBuilder-ACME-Edition/external/acpedia"
DEFAULT_HISTORY = os.path.join(
    DEFAULT_ACPD, "acpediaorg-20210615-wikidump", "acpediaorg-20210615-history.xml"
)
DEFAULT_INDEX = os.path.join(DEFAULT_ACPD, "acpedia_index.jsonl")
DEFAULT_OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "knowledge.acpedia.json")

RE_COMMENT = re.compile(r"<!--.*?-->", re.S)
RE_REF = re.compile(r"<ref[^>/]*/>|<ref[^>]*>.*?</ref>", re.S | re.I)
RE_TAGBLOCK = re.compile(r"<(gallery|nowiki|pre|source|syntaxhighlight)[^>]*>.*?</\1>", re.S | re.I)
RE_HTML_TAG = re.compile(r"<[^>]+>")
RE_TABLE = re.compile(r"\{\|.*?\|\}", re.S)
RE_TEMPLATE = re.compile(r"\{\{[^{}]*\}\}", re.S)
RE_FILELINK = re.compile(r"\[\[(?:File|Image):[^\[\]]*(?:\[\[[^\[\]]*\]\][^\[\]]*)*\]\]", re.I)
RE_LINK_PIPED = re.compile(r"\[\[[^\[\]|]*\|([^\[\]]*)\]\]")
RE_LINK_PLAIN = re.compile(r"\[\[([^\[\]]*)\]\]")
RE_EXTLINK_LABELED = re.compile(r"\[https?://\S*\s+([^\]]*)\]")
RE_EXTLINK_BARE = re.compile(r"\[?https?://\S+\]?")
RE_QUOTES = re.compile(r"'{2,}")
RE_REDIRECT = re.compile(r"^\s*#redirect", re.I)

# Line prefixes that are markup/structure, not prose. Bullets (*/#) are NOT
# skipped — creature/quest pages keep their drop- and walkthrough-notes in
# bullet lists; their markers are stripped in summarize() instead.
SKIP_LINE = ("=", ":", ";", "|", "!", "{", "}", "----")

# Infobox template params worth keeping when a page is template-only prose
# (creatures/items/dungeons/quests are ~all {{Creature|...}}-style boxes).
# Rendered in this order as "Key: value | ...".
INFOBOX_KEYS = [
    "Class", "Subclass", "Boss", "Level", "Health", "XP", "Loot Tier",
    "Weaknesses", "Attacks", "Coordinates", "Location", "Route",
    "Quest Type", "Level Restriction", "Rewards", "Value", "Skill",
    "Spells", "Wield Requirements",
]


def _split_top_level(body):
    """Split a template body on '|' at brace/bracket depth 0."""
    parts, depth, buf = [], 0, []
    i = 0
    while i < len(body):
        two = body[i : i + 2]
        if two in ("{{", "[["):
            depth += 1
            buf.append(two)
            i += 2
            continue
        if two in ("}}", "]]"):
            depth -= 1
            buf.append(two)
            i += 2
            continue
        c = body[i]
        if c == "|" and depth == 0:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(c)
        i += 1
    parts.append("".join(buf))
    return parts


def _clean_value(v):
    v = RE_TEMPLATE.sub("", v)  # nested item-list templates -> drop
    v = RE_LINK_PIPED.sub(r"\1", v)
    v = RE_LINK_PLAIN.sub(r"\1", v)
    v = RE_QUOTES.sub("", v)
    v = re.sub(r"\s+", " ", v).strip()
    return "" if v in ("--", "-", "?") else v


def infobox_facts(text):
    """Harvest whitelisted key=value params from top-level {{...}} templates."""
    facts = {}
    i = 0
    while True:
        start = text.find("{{", i)
        if start < 0:
            break
        depth, j = 0, start
        while j < len(text):  # scan to the matching }}
            if text.startswith("{{", j):
                depth += 1
                j += 2
            elif text.startswith("}}", j):
                depth -= 1
                j += 2
                if depth == 0:
                    break
            else:
                j += 1
        for part in _split_top_level(text[start + 2 : j - 2])[1:]:
            if "=" not in part:
                continue
            k, _, v = part.partition("=")
            k, v = k.strip(), _clean_value(v)
            if v and k in INFOBOX_KEYS and k not in facts:
                facts[k] = v
        i = j
    return " | ".join(f"{k}: {facts[k]}" for k in INFOBOX_KEYS if k in facts)


def clean_wikitext(text):
    t = RE_COMMENT.sub("", text)
    t = RE_REF.sub("", t)
    t = RE_TAGBLOCK.sub("", t)
    for _ in range(6):  # nested templates strip inside-out
        t, n = RE_TEMPLATE.subn("", t)
        if not n:
            break
    t = RE_TABLE.sub("", t)
    t = RE_FILELINK.sub("", t)
    t = RE_LINK_PIPED.sub(r"\1", t)
    t = RE_LINK_PLAIN.sub(r"\1", t)
    t = RE_EXTLINK_LABELED.sub(r"\1", t)
    t = RE_EXTLINK_BARE.sub("", t)
    t = RE_HTML_TAG.sub(" ", t)
    t = RE_QUOTES.sub("", t)
    return html.unescape(t)


def summarize(text, max_chars):
    facts = infobox_facts(text)
    out = []
    total = len(facts)
    for raw in clean_wikitext(text).splitlines():
        line = raw.strip()
        if not line or line.startswith(SKIP_LINE):
            continue
        line = line.lstrip("*# ").strip()
        if not line:
            continue
        out.append(line)
        total += len(line) + 1
        if total >= max_chars:
            break
    prose = re.sub(r"\s+", " ", " ".join(out)).strip()
    s = f"{facts}. {prose}".strip(". ") if facts else prose
    return s[:max_chars]


def load_aliases(index_path):
    aliases = {}
    try:
        with open(index_path, encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                tgt = row.get("redirect")
                src = row.get("title")
                if tgt and src and row.get("ns") == "0" and src != tgt:
                    aliases.setdefault(tgt, []).append(src)
    except OSError as e:
        print(f"warn: no alias index ({e})", file=sys.stderr)
    return aliases


def latest_revision_text(page):
    best_ts, best_text = "", None
    for rev in page.iterfind(f"{MW_NS}revision"):
        ts = rev.findtext(f"{MW_NS}timestamp") or ""
        if ts >= best_ts:
            text = rev.findtext(f"{MW_NS}text")
            if text is not None:
                best_ts, best_text = ts, text
    return best_text


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--history", default=DEFAULT_HISTORY)
    ap.add_argument("--index", default=DEFAULT_INDEX)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--max-chars", type=int, default=300)
    ap.add_argument("--min-chars", type=int, default=40)
    args = ap.parse_args()

    aliases = load_aliases(args.index)
    entries = []
    pages = kept = 0

    for _, elem in ET.iterparse(args.history):
        if elem.tag != f"{MW_NS}page":
            continue
        pages += 1
        if pages % 5000 == 0:
            print(f"  …{pages} pages, {kept} kept", file=sys.stderr)
        try:
            if elem.findtext(f"{MW_NS}ns") == "0" and elem.find(f"{MW_NS}redirect") is None:
                title = (elem.findtext(f"{MW_NS}title") or "").strip()
                text = latest_revision_text(elem)
                if title and text and not RE_REDIRECT.match(text):
                    summary = summarize(text, args.max_chars)
                    if len(summary) >= args.min_chars:
                        row = {"title": title, "text": summary}
                        if title in aliases:
                            row["aliases"] = sorted(aliases[title])
                        entries.append(row)
                        kept += 1
        finally:
            elem.clear()  # streaming: don't accumulate the tree

    entries.sort(key=lambda r: r["title"].lower())
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(entries, f, ensure_ascii=False, separators=(",", ":"))
    size_mb = os.path.getsize(args.out) / 1e6
    print(f"{kept} articles from {pages} pages -> {args.out} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()

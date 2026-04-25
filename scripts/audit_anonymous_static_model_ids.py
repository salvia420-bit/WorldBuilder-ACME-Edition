#!/usr/bin/env python3
"""
audit_anonymous_static_model_ids.py

Cross-references every model_id referenced by static envcell objects
(in envcell_components_full.jsonl) against the canonical_enrichment.json
ontology to produce a full inventory of which model_ids are still
anonymous, how often each appears, and where they live.

Outputs (under pipeline_data/reference/):
  - anonymous_static_model_ids_full.jsonl   (one row per unique model_id)
  - anonymous_static_model_ids_full.tsv     (same, tab-separated, named first)
  - anonymous_static_model_ids_full_summary.json
"""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

REPO = Path("/home/salvia420/WorldBuilder-ACME-Edition")
ENVCELL_PATH = REPO / "pipeline_data/reference/envcell_components_full.jsonl"
CANONICAL_PATH = REPO / "pipeline_data/enrichment/canonical_enrichment.json"

OUT_DIR = REPO / "pipeline_data/reference"
OUT_JSONL = OUT_DIR / "anonymous_static_model_ids_full.jsonl"
OUT_TSV = OUT_DIR / "anonymous_static_model_ids_full.tsv"
OUT_SUMMARY = OUT_DIR / "anonymous_static_model_ids_full_summary.json"


def id_space(model_id: int) -> str:
    top = (model_id >> 24) & 0xFF
    if top == 0x02:
        return "Setup"
    if top == 0x01:
        return "GfxObj"
    return f"Other(0x{top:02X})"


def build_canonical_index(canonical_path: Path) -> dict[int, dict]:
    """setupDid -> aggregated entry (multiple wcids can share one setup)."""
    raw = json.loads(canonical_path.read_text())
    by_setup: dict[int, dict] = {}
    for entry in raw.get("entries", []):
        sd = entry.get("setupDid")
        if sd is None:
            continue
        sd = int(sd)
        bucket = by_setup.setdefault(
            sd,
            {
                "setup_did": sd,
                "names": [],
                "wcids": [],
                "types": set(),
                "architectures": set(),
                "biomes": set(),
                "behaviors": set(),
                "creature_families": set(),
            },
        )
        name = entry.get("name") or entry.get("canonical_name")
        if name and name not in bucket["names"]:
            bucket["names"].append(name)
        wcid = entry.get("wcid")
        if wcid is not None:
            bucket["wcids"].append(int(wcid))
        for key, target in (
            ("type", "types"),
            ("architecture", "architectures"),
            ("behavior", "behaviors"),
            ("creature_family", "creature_families"),
        ):
            v = entry.get(key)
            if v:
                bucket[target].add(v)
        biome = entry.get("biome")
        if isinstance(biome, list):
            for b in biome:
                bucket["biomes"].add(b)
        elif isinstance(biome, str):
            bucket["biomes"].add(biome)
    # serialize sets to sorted lists
    for b in by_setup.values():
        for k in ("types", "architectures", "biomes", "behaviors", "creature_families"):
            b[k] = sorted(b[k])
    return by_setup


def aggregate(envcell_path: Path) -> dict[int, dict]:
    """For each model_id, count static occurrences, anchor uses, and
    distinct landblocks / components / cells touching it."""
    agg: dict[int, dict] = {}

    def bucket(mid: int) -> dict:
        b = agg.get(mid)
        if b is None:
            b = {
                "static_occurrences": 0,
                "anchor_occurrences": 0,
                "landblocks": set(),
                "components": set(),
                "cells": set(),
                "example_landblocks": [],
            }
            agg[mid] = b
        return b

    n_rows = 0
    with envcell_path.open(encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            n_rows += 1
            lb = row.get("landblockId")
            comp_id = row.get("componentId")

            anchor = row.get("anchor") or {}
            if anchor.get("classIdSpace") == "model_id" and anchor.get("classId") is not None:
                b = bucket(int(anchor["classId"]))
                b["anchor_occurrences"] += 1
                if lb is not None:
                    b["landblocks"].add(lb)
                if comp_id is not None:
                    b["components"].add(comp_id)

            for cell in row.get("cells", []) or []:
                cell_id = cell.get("cellId")
                for o in cell.get("staticObjects", []) or []:
                    if o.get("classIdSpace") != "model_id":
                        continue
                    cid = o.get("classId")
                    if cid is None:
                        continue
                    b = bucket(int(cid))
                    b["static_occurrences"] += 1
                    if lb is not None:
                        b["landblocks"].add(lb)
                        if len(b["example_landblocks"]) < 5 and lb not in b["example_landblocks"]:
                            b["example_landblocks"].append(lb)
                    if comp_id is not None:
                        b["components"].add(comp_id)
                    if cell_id is not None:
                        b["cells"].add(cell_id)

    print(f"  scanned {n_rows} envcell component rows")
    return agg


def main() -> None:
    print(f"Loading canonical enrichment: {CANONICAL_PATH}")
    canonical = build_canonical_index(CANONICAL_PATH)
    print(f"  canonical setupDids: {len(canonical)}")

    print(f"Aggregating envcell static + anchor model_ids: {ENVCELL_PATH}")
    agg = aggregate(ENVCELL_PATH)
    print(f"  unique model_ids: {len(agg)}")

    rows: list[dict] = []
    for mid, b in agg.items():
        space = id_space(mid)
        canonical_entry = canonical.get(mid)
        known = canonical_entry is not None
        row = {
            "model_id_hex": f"0x{mid:08X}",
            "model_id_int": mid,
            "id_space": space,
            "static_occurrences": b["static_occurrences"],
            "anchor_occurrences": b["anchor_occurrences"],
            "distinct_landblocks": len(b["landblocks"]),
            "distinct_components": len(b["components"]),
            "distinct_cells": len(b["cells"]),
            "example_landblocks": b["example_landblocks"][:5],
            "known": known,
            "name": canonical_entry["names"][0] if (known and canonical_entry["names"]) else None,
            "names_all": canonical_entry["names"] if known else [],
            "wcids": canonical_entry["wcids"] if known else [],
            "types": canonical_entry["types"] if known else [],
            "architectures": canonical_entry["architectures"] if known else [],
            "biomes": canonical_entry["biomes"] if known else [],
            "behaviors": canonical_entry["behaviors"] if known else [],
            "creature_families": canonical_entry["creature_families"] if known else [],
        }
        rows.append(row)

    rows.sort(key=lambda r: (-r["static_occurrences"], r["model_id_int"]))

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    with OUT_JSONL.open("w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    print(f"Wrote {OUT_JSONL} ({len(rows)} rows)")

    tsv_cols = [
        "model_id_hex",
        "id_space",
        "known",
        "name",
        "static_occurrences",
        "anchor_occurrences",
        "distinct_landblocks",
        "distinct_components",
        "types",
        "architectures",
        "biomes",
    ]
    with OUT_TSV.open("w") as f:
        f.write("\t".join(tsv_cols) + "\n")
        for r in rows:
            line = []
            for c in tsv_cols:
                v = r.get(c)
                if isinstance(v, list):
                    v = ",".join(str(x) for x in v)
                elif v is None:
                    v = ""
                line.append(str(v))
            f.write("\t".join(line) + "\n")
    print(f"Wrote {OUT_TSV}")

    total_static = sum(r["static_occurrences"] for r in rows)
    total_anchor = sum(r["anchor_occurrences"] for r in rows)

    by_space = defaultdict(lambda: {"unique": 0, "known": 0, "anonymous": 0,
                                    "static_occurrences": 0, "anonymous_static_occurrences": 0})
    for r in rows:
        s = by_space[r["id_space"]]
        s["unique"] += 1
        s["static_occurrences"] += r["static_occurrences"]
        if r["known"]:
            s["known"] += 1
        else:
            s["anonymous"] += 1
            s["anonymous_static_occurrences"] += r["static_occurrences"]

    top_anonymous = [
        {
            "model_id_hex": r["model_id_hex"],
            "id_space": r["id_space"],
            "static_occurrences": r["static_occurrences"],
            "distinct_landblocks": r["distinct_landblocks"],
            "example_landblocks": r["example_landblocks"],
        }
        for r in rows if not r["known"]
    ][:50]

    summary = {
        "envcell_source": str(ENVCELL_PATH),
        "canonical_source": str(CANONICAL_PATH),
        "unique_model_ids": len(rows),
        "total_static_occurrences": total_static,
        "total_anchor_occurrences": total_anchor,
        "by_id_space": dict(by_space),
        "anonymous_share_of_static_occurrences": (
            sum(r["static_occurrences"] for r in rows if not r["known"]) / total_static
            if total_static else 0.0
        ),
        "top_50_anonymous_by_occurrence": top_anonymous,
    }
    OUT_SUMMARY.write_text(json.dumps(summary, indent=2))
    print(f"Wrote {OUT_SUMMARY}")
    print()
    print("Summary:")
    print(json.dumps({k: v for k, v in summary.items() if k != "top_50_anonymous_by_occurrence"}, indent=2))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
audit_anonymous_static_model_ids_v2.py

Same envcell scan as v1, but cross-references against the union of
  - pipeline_data/enrichment/canonical_enrichment.json   (LSD + ACE-master)
  - pipeline_data/enrichment/ace_world_setup_names.json  (full ACE world DB)

Reports the delta: how many anonymous setups got rescued by adding the
ACE world DB source.

Outputs:
  pipeline_data/reference/anonymous_static_model_ids_full_v2.jsonl
  pipeline_data/reference/anonymous_static_model_ids_full_v2.tsv
  pipeline_data/reference/anonymous_static_model_ids_full_v2_summary.json
"""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

REPO = Path("/home/salvia420/WorldBuilder-ACME-Edition")
ENVCELL_PATH = REPO / "pipeline_data/reference/envcell_components_full.jsonl"
CANONICAL_PATH = REPO / "pipeline_data/enrichment/canonical_enrichment.json"
ACE_WORLD_PATH = REPO / "pipeline_data/enrichment/ace_world_setup_names.json"

OUT_DIR = REPO / "pipeline_data/reference"
OUT_JSONL = OUT_DIR / "anonymous_static_model_ids_full_v2.jsonl"
OUT_TSV = OUT_DIR / "anonymous_static_model_ids_full_v2.tsv"
OUT_SUMMARY = OUT_DIR / "anonymous_static_model_ids_full_v2_summary.json"


def id_space(model_id: int) -> str:
    top = (model_id >> 24) & 0xFF
    if top == 0x02:
        return "Setup"
    if top == 0x01:
        return "GfxObj"
    return f"Other(0x{top:02X})"


def load_canonical(path: Path) -> dict[int, dict]:
    raw = json.loads(path.read_text())
    by_setup: dict[int, dict] = {}
    for entry in raw.get("entries", []):
        sd = entry.get("setupDid")
        if sd is None:
            continue
        sd = int(sd)
        b = by_setup.setdefault(sd, {
            "names": [], "wcids": [],
            "types": set(), "architectures": set(),
            "biomes": set(), "behaviors": set(), "creature_families": set(),
        })
        nm = entry.get("name") or entry.get("canonical_name")
        if nm and nm not in b["names"]:
            b["names"].append(nm)
        if entry.get("wcid") is not None:
            b["wcids"].append(int(entry["wcid"]))
        for k, t in (("type", "types"), ("architecture", "architectures"),
                     ("behavior", "behaviors"), ("creature_family", "creature_families")):
            v = entry.get(k)
            if v:
                b[t].add(v)
        biome = entry.get("biome")
        if isinstance(biome, list):
            b["biomes"].update(biome)
        elif isinstance(biome, str) and biome:
            b["biomes"].add(biome)
    for b in by_setup.values():
        for k in ("types", "architectures", "biomes", "behaviors", "creature_families"):
            b[k] = sorted(b[k])
    return by_setup


def load_ace_world(path: Path) -> dict[int, dict]:
    raw = json.loads(path.read_text())
    by_setup_str: dict = raw.get("by_setup_did", {})
    return {int(k): v for k, v in by_setup_str.items()}


def aggregate(envcell_path: Path) -> dict[int, dict]:
    agg: dict[int, dict] = {}

    def bucket(mid: int) -> dict:
        b = agg.get(mid)
        if b is None:
            b = {"static_occurrences": 0, "anchor_occurrences": 0,
                 "landblocks": set(), "components": set(), "cells": set(),
                 "example_landblocks": []}
            agg[mid] = b
        return b

    with envcell_path.open(encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
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
    return agg


def display_name(canon: dict | None, ace: dict | None) -> tuple[str | None, str]:
    if canon and canon["names"]:
        return canon["names"][0], "canonical"
    if ace and ace.get("names"):
        return ace["names"][0], "ace_world_db_string"
    if ace and ace.get("class_names"):
        return ace["class_names"][0], "ace_world_db_class_name"
    return None, "none"


def main() -> None:
    print("Loading canonical_enrichment.json ...")
    canonical = load_canonical(CANONICAL_PATH)
    print(f"  setupDids: {len(canonical)}")

    print("Loading ace_world_setup_names.json ...")
    ace_world = load_ace_world(ACE_WORLD_PATH)
    print(f"  setupDids: {len(ace_world)}")

    print("Aggregating envcell static + anchor model_ids ...")
    agg = aggregate(ENVCELL_PATH)
    print(f"  unique model_ids: {len(agg)}")

    rows = []
    for mid, b in agg.items():
        space = id_space(mid)
        canon = canonical.get(mid) if space == "Setup" else None
        ace = ace_world.get(mid) if space == "Setup" else None
        nm, src = display_name(canon, ace)
        known_canonical = canon is not None
        known_ace = ace is not None
        known = nm is not None
        # union of tags
        types = list(canon["types"]) if canon else []
        architectures = list(canon["architectures"]) if canon else []
        biomes = list(canon["biomes"]) if canon else []
        behaviors = list(canon["behaviors"]) if canon else []
        creature_families = list(canon["creature_families"]) if canon else []
        weenie_types = ace.get("weenie_types", []) if ace else []
        wcids = sorted(set((canon["wcids"] if canon else []) + (ace.get("wcids", []) if ace else [])))

        rows.append({
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
            "name": nm,
            "name_source": src,
            "known_canonical": known_canonical,
            "known_ace_world": known_ace,
            "names_canonical": canon["names"] if canon else [],
            "names_ace_world": ace.get("names", []) if ace else [],
            "class_names_ace_world": ace.get("class_names", []) if ace else [],
            "wcids": wcids,
            "weenie_types_ace_world": weenie_types,
            "types": types,
            "architectures": architectures,
            "biomes": biomes,
            "behaviors": behaviors,
            "creature_families": creature_families,
        })

    rows.sort(key=lambda r: (-r["static_occurrences"], r["model_id_int"]))

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    with OUT_JSONL.open("w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    print(f"Wrote {OUT_JSONL} ({len(rows)} rows)")

    cols = ["model_id_hex", "id_space", "known", "name_source", "name",
            "static_occurrences", "anchor_occurrences", "distinct_landblocks",
            "distinct_components", "wcids", "weenie_types_ace_world",
            "types", "architectures", "biomes"]
    with OUT_TSV.open("w") as f:
        f.write("\t".join(cols) + "\n")
        for r in rows:
            line = []
            for c in cols:
                v = r.get(c)
                if isinstance(v, list):
                    v = ",".join(str(x) for x in v)
                elif v is None:
                    v = ""
                line.append(str(v))
            f.write("\t".join(line) + "\n")
    print(f"Wrote {OUT_TSV}")

    by_space = defaultdict(lambda: {
        "unique": 0,
        "known": 0,
        "anonymous": 0,
        "static_occurrences": 0,
        "anonymous_static_occurrences": 0,
        "by_source": defaultdict(int),
    })
    rescued_by_ace = []
    for r in rows:
        s = by_space[r["id_space"]]
        s["unique"] += 1
        s["static_occurrences"] += r["static_occurrences"]
        s["by_source"][r["name_source"]] += 1
        if r["known"]:
            s["known"] += 1
            if not r["known_canonical"] and r["known_ace_world"]:
                rescued_by_ace.append(r)
        else:
            s["anonymous"] += 1
            s["anonymous_static_occurrences"] += r["static_occurrences"]

    rescued_by_ace.sort(key=lambda r: -r["static_occurrences"])
    rescued_static_total = sum(r["static_occurrences"] for r in rescued_by_ace)

    summary = {
        "envcell_source": str(ENVCELL_PATH),
        "canonical_source": str(CANONICAL_PATH),
        "ace_world_source": str(ACE_WORLD_PATH),
        "unique_model_ids": len(rows),
        "total_static_occurrences": sum(r["static_occurrences"] for r in rows),
        "by_id_space": {k: {**v, "by_source": dict(v["by_source"])}
                         for k, v in by_space.items()},
        "rescued_by_ace_world_db": {
            "count": len(rescued_by_ace),
            "static_occurrences": rescued_static_total,
            "top_25": [
                {"model_id_hex": r["model_id_hex"], "name": r["name"],
                 "name_source": r["name_source"],
                 "static_occurrences": r["static_occurrences"],
                 "distinct_landblocks": r["distinct_landblocks"],
                 "wcids": r["wcids"][:5]}
                for r in rescued_by_ace[:25]
            ],
        },
        "top_25_remaining_anonymous": [
            {"model_id_hex": r["model_id_hex"], "id_space": r["id_space"],
             "static_occurrences": r["static_occurrences"],
             "distinct_landblocks": r["distinct_landblocks"],
             "example_landblocks": r["example_landblocks"]}
            for r in rows if not r["known"]
        ][:25],
    }
    OUT_SUMMARY.write_text(json.dumps(summary, indent=2))
    print(f"Wrote {OUT_SUMMARY}")
    print()
    print(json.dumps({k: v for k, v in summary.items()
                      if k not in ("top_25_remaining_anonymous",)},
                     indent=2)[:4000])


if __name__ == "__main__":
    main()

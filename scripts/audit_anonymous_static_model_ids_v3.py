#!/usr/bin/env python3
"""
audit_anonymous_static_model_ids_v3.py

Adds Setup -> Parts (GfxObj) inheritance on top of v2:
  - canonical_enrichment.json         (LSD + ACE-master)
  - ace_world_setup_names.json        (full ACE world DB)
  - setup_parts.jsonl                 (portal.dat Setup -> Parts)

A GfxObj inherits names/tags from every Setup that includes it as a Part,
when at least one such Setup is named.

Outputs:
  pipeline_data/reference/anonymous_static_model_ids_full_v3.jsonl
  pipeline_data/reference/anonymous_static_model_ids_full_v3.tsv
  pipeline_data/reference/anonymous_static_model_ids_full_v3_summary.json
"""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

REPO = Path("/home/salvia420/WorldBuilder-ACME-Edition")
ENVCELL_PATH = REPO / "pipeline_data/reference/envcell_components_full.jsonl"
CANONICAL_PATH = REPO / "pipeline_data/enrichment/canonical_enrichment.json"
ACE_WORLD_PATH = REPO / "pipeline_data/enrichment/ace_world_setup_names.json"
SETUP_PARTS_PATH = REPO / "pipeline_data/reference/setup_parts.jsonl"

OUT_DIR = REPO / "pipeline_data/reference"
OUT_JSONL = OUT_DIR / "anonymous_static_model_ids_full_v3.jsonl"
OUT_TSV = OUT_DIR / "anonymous_static_model_ids_full_v3.tsv"
OUT_SUMMARY = OUT_DIR / "anonymous_static_model_ids_full_v3_summary.json"


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
    return {int(k): v for k, v in raw.get("by_setup_did", {}).items()}


def load_parts_index(path: Path) -> tuple[dict[int, list[int]], dict[int, list[int]]]:
    """Return (setup -> parts list, gfx_to_setups map)."""
    setup_to_parts: dict[int, list[int]] = {}
    gfx_to_setups: dict[int, list[int]] = defaultdict(list)
    with path.open(encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            setup = int(row["setupIdInt"])
            parts = [int(p) for p in row.get("partsInt", [])]
            setup_to_parts[setup] = parts
            for p in parts:
                if setup not in gfx_to_setups[p]:
                    gfx_to_setups[p].append(setup)
    return setup_to_parts, dict(gfx_to_setups)


def setup_display_name(canon: dict | None, ace: dict | None) -> tuple[str | None, str]:
    if canon and canon.get("names"):
        return canon["names"][0], "canonical"
    if ace and ace.get("names"):
        return ace["names"][0], "ace_world_db_string"
    if ace and ace.get("class_names"):
        return ace["class_names"][0], "ace_world_db_class_name"
    return None, "none"


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


def main() -> None:
    print("Loading sources...")
    canonical = load_canonical(CANONICAL_PATH)
    ace_world = load_ace_world(ACE_WORLD_PATH)
    setup_to_parts, gfx_to_setups = load_parts_index(SETUP_PARTS_PATH)
    print(f"  canonical setupDids:    {len(canonical):,}")
    print(f"  ace world setupDids:    {len(ace_world):,}")
    print(f"  setup -> parts entries: {len(setup_to_parts):,}")
    print(f"  gfx -> parent setups:   {len(gfx_to_setups):,}")

    print(f"Aggregating envcell statics: {ENVCELL_PATH}")
    agg = aggregate(ENVCELL_PATH)
    print(f"  unique model_ids: {len(agg):,}")

    rows = []
    for mid, b in agg.items():
        space = id_space(mid)
        # Direct lookup (Setups only)
        direct_canon = canonical.get(mid) if space == "Setup" else None
        direct_ace = ace_world.get(mid) if space == "Setup" else None
        direct_name, direct_src = setup_display_name(direct_canon, direct_ace)

        # Inherited lookup (GfxObjs reach through gfx_to_setups; Setups also
        # benefit when they appear as parts of OTHER setups, e.g. composite weapons)
        parent_setups = gfx_to_setups.get(mid, []) if space == "GfxObj" else []
        inherited: list[dict] = []
        if direct_name is None and parent_setups:
            for ps in parent_setups:
                p_canon = canonical.get(ps)
                p_ace = ace_world.get(ps)
                p_name, p_src = setup_display_name(p_canon, p_ace)
                if p_name:
                    inherited.append({
                        "parent_setup": f"0x{ps:08X}",
                        "name": p_name,
                        "source": p_src,
                    })

        # Final naming decision
        if direct_name:
            name = direct_name
            name_source = direct_src
        elif inherited:
            # Pick the parent that's most strongly named: prefer canonical over ace
            sorted_inh = sorted(inherited, key=lambda x: 0 if x["source"] == "canonical" else 1)
            name = sorted_inh[0]["name"]
            name_source = "inherited:" + sorted_inh[0]["source"]
        else:
            name = None
            name_source = "none"

        # Tag aggregation (direct first, then merge inherited if direct empty)
        types: list[str] = []
        architectures: list[str] = []
        biomes: list[str] = []
        behaviors: list[str] = []
        creature_families: list[str] = []
        wcids_set: set[int] = set()
        if direct_canon:
            types.extend(direct_canon["types"])
            architectures.extend(direct_canon["architectures"])
            biomes.extend(direct_canon["biomes"])
            behaviors.extend(direct_canon["behaviors"])
            creature_families.extend(direct_canon["creature_families"])
            wcids_set.update(direct_canon["wcids"])
        if direct_ace:
            wcids_set.update(direct_ace.get("wcids", []))
        if not types and inherited:
            for ih in inherited:
                ps_int = int(ih["parent_setup"], 16)
                p_canon = canonical.get(ps_int)
                if p_canon:
                    for v in p_canon["types"]:
                        if v not in types: types.append(v)
                    for v in p_canon["architectures"]:
                        if v not in architectures: architectures.append(v)
                    for v in p_canon["biomes"]:
                        if v not in biomes: biomes.append(v)
                    for v in p_canon["behaviors"]:
                        if v not in behaviors: behaviors.append(v)
                    for v in p_canon["creature_families"]:
                        if v not in creature_families: creature_families.append(v)

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
            "known": name is not None,
            "name": name,
            "name_source": name_source,
            "direct_name": direct_name,
            "direct_source": direct_src,
            "parent_setups": [f"0x{ps:08X}" for ps in parent_setups[:8]],
            "parent_setup_count": len(parent_setups),
            "inherited_names": inherited[:5],
            "wcids": sorted(wcids_set),
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
            "parent_setup_count", "wcids", "types", "architectures", "biomes"]
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
    rescued_by_inheritance = []
    for r in rows:
        s = by_space[r["id_space"]]
        s["unique"] += 1
        s["static_occurrences"] += r["static_occurrences"]
        s["by_source"][r["name_source"]] += 1
        if r["known"]:
            s["known"] += 1
            if r["name_source"].startswith("inherited:"):
                rescued_by_inheritance.append(r)
        else:
            s["anonymous"] += 1
            s["anonymous_static_occurrences"] += r["static_occurrences"]

    rescued_by_inheritance.sort(key=lambda r: -r["static_occurrences"])

    summary = {
        "envcell_source": str(ENVCELL_PATH),
        "canonical_source": str(CANONICAL_PATH),
        "ace_world_source": str(ACE_WORLD_PATH),
        "setup_parts_source": str(SETUP_PARTS_PATH),
        "unique_model_ids": len(rows),
        "total_static_occurrences": sum(r["static_occurrences"] for r in rows),
        "by_id_space": {k: {**v, "by_source": dict(v["by_source"])}
                         for k, v in by_space.items()},
        "rescued_by_inheritance": {
            "count": len(rescued_by_inheritance),
            "static_occurrences": sum(r["static_occurrences"] for r in rescued_by_inheritance),
            "top_25": [
                {"model_id_hex": r["model_id_hex"], "id_space": r["id_space"],
                 "name": r["name"], "name_source": r["name_source"],
                 "parent_setups": r["parent_setups"][:3],
                 "static_occurrences": r["static_occurrences"]}
                for r in rescued_by_inheritance[:25]
            ],
        },
        "top_25_remaining_anonymous": [
            {"model_id_hex": r["model_id_hex"], "id_space": r["id_space"],
             "static_occurrences": r["static_occurrences"],
             "distinct_landblocks": r["distinct_landblocks"],
             "parent_setup_count": r["parent_setup_count"]}
            for r in rows if not r["known"]
        ][:25],
    }
    OUT_SUMMARY.write_text(json.dumps(summary, indent=2))
    print(f"Wrote {OUT_SUMMARY}")
    print()
    print(json.dumps({k: v for k, v in summary.items()
                      if k not in ("top_25_remaining_anonymous", "rescued_by_inheritance")},
                     indent=2))


if __name__ == "__main__":
    main()

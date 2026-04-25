#!/usr/bin/env python3
"""
audit_anonymous_static_model_ids_v4.py

Adds DAT-derived classification signals on top of v3:
  - canonical_enrichment.json
  - ace_world_setup_names.json
  - setup_parts.jsonl                      (Setup -> Parts inheritance)
  - classification_signals.json            (NEW: building / scenery setup IDs
                                             from LandBlockInfo + Scene tables)

A model_id can now be "categorized" even if it has no name, by being
flagged as a building shell or as scenery via DAT structural metadata.

Outputs:
  pipeline_data/reference/anonymous_static_model_ids_full_v4.jsonl
  pipeline_data/reference/anonymous_static_model_ids_full_v4.tsv
  pipeline_data/reference/anonymous_static_model_ids_full_v4_summary.json
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
SIGNALS_PATH = REPO / "pipeline_data/reference/classification_signals.json"

OUT_DIR = REPO / "pipeline_data/reference"
OUT_JSONL = OUT_DIR / "anonymous_static_model_ids_full_v4.jsonl"
OUT_TSV = OUT_DIR / "anonymous_static_model_ids_full_v4.tsv"
OUT_SUMMARY = OUT_DIR / "anonymous_static_model_ids_full_v4_summary.json"


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


def load_parts_index(path: Path) -> dict[int, list[int]]:
    gfx_to_setups: dict[int, list[int]] = defaultdict(list)
    with path.open(encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            setup = int(row["setupIdInt"])
            for p in row.get("partsInt", []):
                p = int(p)
                if setup not in gfx_to_setups[p]:
                    gfx_to_setups[p].append(setup)
    return dict(gfx_to_setups)


def load_signals(path: Path) -> tuple[set[int], set[int]]:
    raw = json.loads(path.read_text(encoding="utf-8-sig"))
    bldg = {int(s, 16) for s in raw.get("buildingModelIds", [])}
    scen = {int(s, 16) for s in raw.get("scenerySetupIds", [])}
    return bldg, scen


def setup_display_name(canon, ace):
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
    gfx_to_setups = load_parts_index(SETUP_PARTS_PATH)
    building_ids, scenery_ids = load_signals(SIGNALS_PATH)
    print(f"  canonical setupDids:    {len(canonical):,}")
    print(f"  ace world setupDids:    {len(ace_world):,}")
    print(f"  gfx -> parents:         {len(gfx_to_setups):,}")
    print(f"  building model IDs:     {len(building_ids):,}")
    print(f"  scenery setup IDs:      {len(scenery_ids):,}")

    print("Aggregating envcell statics...")
    agg = aggregate(ENVCELL_PATH)
    print(f"  unique model_ids: {len(agg):,}")

    rows = []
    for mid, b in agg.items():
        space = id_space(mid)
        direct_canon = canonical.get(mid) if space == "Setup" else None
        direct_ace = ace_world.get(mid) if space == "Setup" else None
        direct_name, direct_src = setup_display_name(direct_canon, direct_ace)

        parent_setups = gfx_to_setups.get(mid, []) if space == "GfxObj" else []
        inherited = []
        if direct_name is None and parent_setups:
            for ps in parent_setups:
                p_canon = canonical.get(ps)
                p_ace = ace_world.get(ps)
                p_name, p_src = setup_display_name(p_canon, p_ace)
                if p_name:
                    inherited.append({"parent_setup": f"0x{ps:08X}",
                                      "name": p_name, "source": p_src})

        if direct_name:
            name = direct_name
            name_source = direct_src
        elif inherited:
            sorted_inh = sorted(inherited, key=lambda x: 0 if x["source"] == "canonical" else 1)
            name = sorted_inh[0]["name"]
            name_source = "inherited:" + sorted_inh[0]["source"]
        else:
            name = None
            name_source = "none"

        # ─── DAT classification signals ─────────────────
        # A Setup is direct-classified if it appears in building/scenery
        # set. A GfxObj is inherited-classified if any parent Setup is.
        is_building = mid in building_ids
        is_scenery = mid in scenery_ids
        building_via_parent = (
            space == "GfxObj"
            and not is_building
            and any(ps in building_ids for ps in parent_setups)
        )
        scenery_via_parent = (
            space == "GfxObj"
            and not is_scenery
            and any(ps in scenery_ids for ps in parent_setups)
        )

        category_signals = []
        if is_building:
            category_signals.append("Building")
        if is_scenery:
            category_signals.append("Scenery")
        if building_via_parent:
            category_signals.append("Building(inherited)")
        if scenery_via_parent:
            category_signals.append("Scenery(inherited)")

        # categorized = even if unnamed, we know what kind of thing it is
        categorized = bool(category_signals) or name is not None
        category_source = (
            name_source if name else
            "dat:" + ",".join(category_signals) if category_signals else
            "none"
        )

        # tags from canonical (direct or inherited)
        types: list[str] = []
        if direct_canon:
            types.extend(direct_canon["types"])
        if not types and inherited:
            for ih in inherited:
                ps_int = int(ih["parent_setup"], 16)
                p_canon = canonical.get(ps_int)
                if p_canon:
                    for v in p_canon["types"]:
                        if v not in types:
                            types.append(v)
        # If still no type but we have a DAT category signal, add it
        if not types:
            for sig in category_signals:
                # normalize "Building(inherited)" -> "Building", etc.
                norm = sig.split("(")[0]
                if norm == "Building":
                    if "Structure" not in types:
                        types.append("Structure")
                elif norm == "Scenery":
                    if "Scenery" not in types:
                        types.append("Scenery")

        rows.append({
            "model_id_hex": f"0x{mid:08X}",
            "model_id_int": mid,
            "id_space": space,
            "static_occurrences": b["static_occurrences"],
            "anchor_occurrences": b["anchor_occurrences"],
            "distinct_landblocks": len(b["landblocks"]),
            "distinct_components": len(b["components"]),
            "example_landblocks": b["example_landblocks"][:5],
            "named": name is not None,
            "categorized": categorized,
            "name": name,
            "name_source": name_source,
            "category_signals": category_signals,
            "category_source": category_source,
            "is_building": is_building,
            "is_scenery": is_scenery,
            "building_via_parent": building_via_parent,
            "scenery_via_parent": scenery_via_parent,
            "parent_setup_count": len(parent_setups),
            "wcids": sorted(set(
                (direct_canon["wcids"] if direct_canon else []) +
                (direct_ace.get("wcids", []) if direct_ace else [])
            )),
            "types": types,
        })

    rows.sort(key=lambda r: (-r["static_occurrences"], r["model_id_int"]))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with OUT_JSONL.open("w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    print(f"Wrote {OUT_JSONL} ({len(rows)} rows)")

    cols = ["model_id_hex", "id_space", "named", "categorized",
            "name_source", "category_source", "name",
            "static_occurrences", "distinct_landblocks",
            "is_building", "is_scenery",
            "building_via_parent", "scenery_via_parent",
            "parent_setup_count", "types"]
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
        "named": 0,
        "categorized_only": 0,
        "uncategorized": 0,
        "static_occurrences": 0,
        "uncategorized_static_occurrences": 0,
        "by_category_source": defaultdict(int),
    })
    rescued_by_signals = []
    for r in rows:
        s = by_space[r["id_space"]]
        s["unique"] += 1
        s["static_occurrences"] += r["static_occurrences"]
        s["by_category_source"][r["category_source"]] += 1
        if r["named"]:
            s["named"] += 1
        elif r["categorized"]:
            s["categorized_only"] += 1
            rescued_by_signals.append(r)
        else:
            s["uncategorized"] += 1
            s["uncategorized_static_occurrences"] += r["static_occurrences"]

    rescued_by_signals.sort(key=lambda r: -r["static_occurrences"])

    summary = {
        "envcell_source": str(ENVCELL_PATH),
        "sources": {
            "canonical": str(CANONICAL_PATH),
            "ace_world": str(ACE_WORLD_PATH),
            "setup_parts": str(SETUP_PARTS_PATH),
            "signals": str(SIGNALS_PATH),
        },
        "unique_model_ids": len(rows),
        "total_static_occurrences": sum(r["static_occurrences"] for r in rows),
        "by_id_space": {k: {**v, "by_category_source": dict(v["by_category_source"])}
                         for k, v in by_space.items()},
        "rescued_by_dat_signals": {
            "count": len(rescued_by_signals),
            "static_occurrences": sum(r["static_occurrences"] for r in rescued_by_signals),
            "top_25": [
                {"model_id_hex": r["model_id_hex"], "id_space": r["id_space"],
                 "category_signals": r["category_signals"],
                 "static_occurrences": r["static_occurrences"],
                 "distinct_landblocks": r["distinct_landblocks"]}
                for r in rescued_by_signals[:25]
            ],
        },
        "top_25_remaining_unknown": [
            {"model_id_hex": r["model_id_hex"], "id_space": r["id_space"],
             "static_occurrences": r["static_occurrences"],
             "distinct_landblocks": r["distinct_landblocks"],
             "parent_setup_count": r["parent_setup_count"]}
            for r in rows if not r["categorized"]
        ][:25],
    }
    OUT_SUMMARY.write_text(json.dumps(summary, indent=2))
    print(f"Wrote {OUT_SUMMARY}")
    print()
    print(json.dumps({k: v for k, v in summary.items()
                      if k not in ("top_25_remaining_unknown", "rescued_by_dat_signals")},
                     indent=2))


if __name__ == "__main__":
    main()

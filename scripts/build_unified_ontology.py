#!/usr/bin/env python3
"""
build_unified_ontology.py

Merges every available ontology source into a single JSON document indexed
by setup_did, gfx_obj_id, and wcid.

Inputs (each optional — missing sources degrade gracefully):
  - pipeline_data/enrichment/canonical_enrichment.json
  - pipeline_data/enrichment/ace_world_setup_names.json
  - pipeline_data/reference/setup_parts.jsonl
  - pipeline_data/reference/classification_signals.json
  - pipeline_data/reference/ontology_geometry.csv

Output:
  pipeline_data/enrichment/unified_ontology.json

Schema:
  {
    "version": "2.0",
    "generated": "...",
    "sources": [...],
    "stats": {...},
    "by_setup_did":   { "<setup_did_int>": entry, ... },
    "by_gfx_obj_id":  { "<gfx_id_int>":   entry, ... },
    "by_wcid":        { "<wcid_int>":     wcid_entry, ... }
  }
"""

from __future__ import annotations

import csv
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

REPO = Path("/home/salvia420/WorldBuilder-ACME-Edition")
ENRICHMENT_DIR = REPO / "pipeline_data/enrichment"
REFERENCE_DIR = REPO / "pipeline_data/reference"

CANONICAL_PATH = ENRICHMENT_DIR / "canonical_enrichment.json"
ACE_WORLD_PATH = ENRICHMENT_DIR / "ace_world_setup_names.json"
SETUP_PARTS_PATH = REFERENCE_DIR / "setup_parts.jsonl"
SIGNALS_PATH = REFERENCE_DIR / "classification_signals.json"
GEOMETRY_CSV = REFERENCE_DIR / "ontology_geometry.csv"

OUT_PATH = ENRICHMENT_DIR / "unified_ontology.json"


def id_space(model_id: int) -> str:
    top = (model_id >> 24) & 0xFF
    if top == 0x02: return "Setup"
    if top == 0x01: return "GfxObj"
    return f"Other(0x{top:02X})"


def load_json(path: Path):
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8-sig"))


def load_canonical_index(path: Path):
    """Returns by_setup_did and by_wcid index."""
    raw = load_json(path)
    by_setup: dict[int, dict] = {}
    by_wcid: dict[int, dict] = {}
    if raw is None:
        return by_setup, by_wcid
    for entry in raw.get("entries", []) or []:
        wcid = entry.get("wcid")
        sd = entry.get("setupDid")
        nm = entry.get("name") or entry.get("canonical_name")
        biome = entry.get("biome")
        biomes = biome if isinstance(biome, list) else ([biome] if biome else [])

        if wcid is not None:
            by_wcid[int(wcid)] = {
                "wcid": int(wcid),
                "name": nm,
                "weenie_type": entry.get("weenieType"),
                "setup_did": int(sd) if sd is not None else None,
                "type": entry.get("type"),
                "architecture": entry.get("architecture"),
                "biome": biomes,
                "behavior": entry.get("behavior"),
                "creature_family": entry.get("creature_family"),
                "level": entry.get("level"),
                "difficulty_tier": entry.get("difficulty_tier"),
                "tag_sources": entry.get("tag_sources") or {},
                "tags": entry.get("tags") or [],
                "_source": "canonical_enrichment",
            }

        if sd is None:
            continue
        sd = int(sd)
        bucket = by_setup.setdefault(sd, {
            "names": [], "wcids": [], "types": set(),
            "architectures": set(), "biomes": set(),
            "behaviors": set(), "creature_families": set(),
            "weenie_types": set(),
        })
        if nm and nm not in bucket["names"]:
            bucket["names"].append(nm)
        if wcid is not None:
            bucket["wcids"].append(int(wcid))
        for k, t in (("type", "types"), ("architecture", "architectures"),
                     ("behavior", "behaviors"), ("creature_family", "creature_families")):
            v = entry.get(k)
            if v: bucket[t].add(v)
        for b in biomes:
            if b: bucket["biomes"].add(b)
        wt = entry.get("weenieType")
        if wt is not None: bucket["weenie_types"].add(int(wt))

    for b in by_setup.values():
        for k in ("types", "architectures", "biomes", "behaviors",
                  "creature_families", "weenie_types"):
            b[k] = sorted(b[k])
    return by_setup, by_wcid


def load_ace_world(path: Path):
    """setup_did -> {wcids, names, class_names, weenie_types}"""
    raw = load_json(path)
    if raw is None:
        return {}
    return {int(k): v for k, v in raw.get("by_setup_did", {}).items()}


def load_setup_parts(path: Path):
    """Returns (setup -> parts list, gfx -> parent setups)."""
    setup_to_parts: dict[int, list[int]] = {}
    gfx_to_setups: dict[int, list[int]] = defaultdict(list)
    if not path.exists():
        return setup_to_parts, dict(gfx_to_setups)
    with path.open(encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            setup = int(row["setupIdInt"])
            parts = [int(p) for p in row.get("partsInt", []) or []]
            setup_to_parts[setup] = parts
            for p in parts:
                if setup not in gfx_to_setups[p]:
                    gfx_to_setups[p].append(setup)
    return setup_to_parts, dict(gfx_to_setups)


def load_signals(path: Path):
    raw = load_json(path)
    if raw is None:
        return set(), set()
    bldg = {int(s, 16) for s in raw.get("buildingModelIds", []) or []}
    scen = {int(s, 16) for s in raw.get("scenerySetupIds", []) or []}
    return bldg, scen


def load_geometry(path: Path):
    out: dict[int, dict] = {}
    if not path.exists():
        return out
    with path.open(encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            try:
                oid = int(r["ObjectId"], 16)
            except (KeyError, ValueError):
                continue
            out[oid] = {
                "geom_category": r.get("Category") or "Unknown",
                "geom_scale": r.get("Scale") or "Unknown",
                "geom_max_dimension": _f(r.get("MaxDimension")),
                "geom_aspect_ratio": _f(r.get("AspectRatio")),
                "geom_part_count": _i(r.get("PartCount")),
                "geom_poly_count": _i(r.get("PolyCount")),
                "geom_tags": [t for t in (r.get("Tags") or "").split(";") if t],
                "geom_classification_source": r.get("ClassificationSource") or "",
            }
    return out


def _f(v):
    try: return float(v) if v not in (None, "") else None
    except (TypeError, ValueError): return None


def _i(v):
    try: return int(v) if v not in (None, "") else None
    except (TypeError, ValueError): return None


def main() -> None:
    print("Loading sources...")
    canonical_by_setup, canonical_by_wcid = load_canonical_index(CANONICAL_PATH)
    ace_world = load_ace_world(ACE_WORLD_PATH)
    setup_to_parts, gfx_to_setups = load_setup_parts(SETUP_PARTS_PATH)
    building_ids, scenery_ids = load_signals(SIGNALS_PATH)
    geometry = load_geometry(GEOMETRY_CSV)

    print(f"  canonical setupDids:  {len(canonical_by_setup):,}")
    print(f"  canonical wcids:      {len(canonical_by_wcid):,}")
    print(f"  ace world setupDids:  {len(ace_world):,}")
    print(f"  setup_parts setups:   {len(setup_to_parts):,}")
    print(f"  gfx -> parent setups: {len(gfx_to_setups):,}")
    print(f"  building / scenery:   {len(building_ids):,} / {len(scenery_ids):,}")
    print(f"  geometry entries:     {len(geometry):,}")

    # ── Setup-keyed entries ───────────────────────────────
    all_setups = (set(canonical_by_setup) | set(ace_world)
                  | set(setup_to_parts) | set(geometry.keys())
                  | {sid for sid in scenery_ids if (sid >> 24) == 0x02})

    by_setup_did: dict[str, dict] = {}
    for sd in sorted(all_setups):
        if (sd >> 24) != 0x02:
            continue  # safeguard

        canon = canonical_by_setup.get(sd)
        ace = ace_world.get(sd)

        # name
        if canon and canon["names"]:
            name, name_source = canon["names"][0], "canonical"
        elif ace and ace.get("names"):
            name, name_source = ace["names"][0], "ace_world_db_string"
        elif ace and ace.get("class_names"):
            name, name_source = ace["class_names"][0], "ace_world_db_class_name"
        else:
            name, name_source = None, "none"

        names_all = list(canon["names"]) if canon else []
        for n in (ace.get("names", []) if ace else []):
            if n not in names_all: names_all.append(n)

        wcids = sorted(set(
            (canon["wcids"] if canon else []) +
            (ace.get("wcids", []) if ace else [])
        ))
        weenie_types = sorted(set(
            (canon["weenie_types"] if canon else []) +
            (ace.get("weenie_types", []) if ace else [])
        ))

        types = list(canon["types"]) if canon else []
        architectures = list(canon["architectures"]) if canon else []
        biomes = list(canon["biomes"]) if canon else []
        behaviors = list(canon["behaviors"]) if canon else []
        creature_families = list(canon["creature_families"]) if canon else []

        is_building = sd in building_ids
        is_scenery = sd in scenery_ids
        if not types:
            if is_building: types.append("Structure")
            if is_scenery and "Scenery" not in types: types.append("Scenery")

        g = geometry.get(sd, {})
        geom_category = g.get("geom_category", "Unknown")
        # Last-resort type from geometry
        if not types and geom_category not in ("", "Unknown"):
            types.append(geom_category)

        parts = setup_to_parts.get(sd, [])

        if name is not None:
            resolution_source = name_source
        elif is_building or is_scenery:
            resolution_source = "dat_signal"
        elif geom_category not in ("", "Unknown"):
            resolution_source = "geometry"
        else:
            resolution_source = "none"

        by_setup_did[str(sd)] = {
            "model_id_int": sd,
            "model_id_hex": f"0x{sd:08X}",
            "id_space": "Setup",
            "name": name,
            "name_source": name_source,
            "names_all": names_all,
            "class_names": ace.get("class_names", []) if ace else [],
            "wcids": wcids,
            "weenie_types": weenie_types,
            "types": types,
            "architectures": architectures,
            "biomes": biomes,
            "behaviors": behaviors,
            "creature_families": creature_families,
            "is_building": is_building,
            "is_scenery": is_scenery,
            "parts_count": len(parts),
            "geom_category": geom_category,
            "geom_scale": g.get("geom_scale", "Unknown"),
            "geom_max_dimension": g.get("geom_max_dimension"),
            "geom_aspect_ratio": g.get("geom_aspect_ratio"),
            "geom_part_count": g.get("geom_part_count"),
            "geom_poly_count": g.get("geom_poly_count"),
            "geom_classification_source": g.get("geom_classification_source", ""),
            "resolved": (name is not None) or (is_building or is_scenery)
                          or (geom_category not in ("", "Unknown")),
            "resolution_source": resolution_source,
        }

    # ── GfxObj-keyed entries (with Setup→Parts inheritance) ─
    all_gfx = (set(gfx_to_setups)
               | {gid for gid in geometry.keys() if (gid >> 24) == 0x01}
               | {gid for gid in building_ids if (gid >> 24) == 0x01}
               | {gid for gid in scenery_ids if (gid >> 24) == 0x01})

    by_gfx_obj_id: dict[str, dict] = {}
    for gid in sorted(all_gfx):
        if (gid >> 24) != 0x01:
            continue

        parents = gfx_to_setups.get(gid, [])
        # Pick best parent name (prefer canonical)
        best_parent_name = None
        best_parent_source = None
        best_parent_id = None
        for ps in parents:
            ps_entry = by_setup_did.get(str(ps))
            if ps_entry and ps_entry["name"]:
                # prefer canonical over ace
                if ps_entry["name_source"] == "canonical":
                    best_parent_name = ps_entry["name"]
                    best_parent_source = ps_entry["name_source"]
                    best_parent_id = ps
                    break
                if best_parent_name is None:
                    best_parent_name = ps_entry["name"]
                    best_parent_source = ps_entry["name_source"]
                    best_parent_id = ps

        if best_parent_name:
            name = best_parent_name
            name_source = "inherited:" + best_parent_source
        else:
            name = None
            name_source = "none"

        # Tag inheritance: take the parent that has tags
        types: list[str] = []
        architectures: list[str] = []
        biomes: list[str] = []
        behaviors: list[str] = []
        creature_families: list[str] = []
        for ps in parents:
            ps_entry = by_setup_did.get(str(ps))
            if not ps_entry:
                continue
            for v in ps_entry["types"]:
                if v not in types: types.append(v)
            for v in ps_entry["architectures"]:
                if v not in architectures: architectures.append(v)
            for v in ps_entry["biomes"]:
                if v not in biomes: biomes.append(v)
            for v in ps_entry["behaviors"]:
                if v not in behaviors: behaviors.append(v)
            for v in ps_entry["creature_families"]:
                if v not in creature_families: creature_families.append(v)

        is_building = gid in building_ids
        is_scenery = gid in scenery_ids
        building_via_parent = (not is_building
                                and any(ps in building_ids for ps in parents))
        scenery_via_parent = (not is_scenery
                                and any(ps in scenery_ids for ps in parents))
        if not types:
            if is_building or building_via_parent:
                types.append("Structure")
            if (is_scenery or scenery_via_parent) and "Scenery" not in types:
                types.append("Scenery")

        g = geometry.get(gid, {})
        geom_category = g.get("geom_category", "Unknown")
        if not types and geom_category not in ("", "Unknown"):
            types.append(geom_category)

        if name is not None:
            resolution_source = name_source
        elif is_building or is_scenery or building_via_parent or scenery_via_parent:
            resolution_source = "dat_signal"
        elif geom_category not in ("", "Unknown"):
            resolution_source = "geometry"
        else:
            resolution_source = "none"

        by_gfx_obj_id[str(gid)] = {
            "model_id_int": gid,
            "model_id_hex": f"0x{gid:08X}",
            "id_space": "GfxObj",
            "name": name,
            "name_source": name_source,
            "parent_setups": [f"0x{ps:08X}" for ps in parents],
            "parent_setups_int": parents,
            "best_parent_setup": f"0x{best_parent_id:08X}" if best_parent_id else None,
            "types": types,
            "architectures": architectures,
            "biomes": biomes,
            "behaviors": behaviors,
            "creature_families": creature_families,
            "is_building": is_building,
            "is_scenery": is_scenery,
            "building_via_parent": building_via_parent,
            "scenery_via_parent": scenery_via_parent,
            "geom_category": geom_category,
            "geom_scale": g.get("geom_scale", "Unknown"),
            "geom_max_dimension": g.get("geom_max_dimension"),
            "geom_aspect_ratio": g.get("geom_aspect_ratio"),
            "geom_part_count": g.get("geom_part_count"),
            "geom_poly_count": g.get("geom_poly_count"),
            "geom_classification_source": g.get("geom_classification_source", ""),
            "resolved": (name is not None)
                          or (is_building or is_scenery
                              or building_via_parent or scenery_via_parent)
                          or (geom_category not in ("", "Unknown")),
            "resolution_source": resolution_source,
        }

    # ── wcid-keyed entries (canonical only) ─────────────
    by_wcid: dict[str, dict] = {str(k): v for k, v in canonical_by_wcid.items()}

    # ── Stats ────────────────────────────────────────────
    setup_resolution_sources = defaultdict(int)
    setup_named = 0
    setup_resolved = 0
    for e in by_setup_did.values():
        setup_resolution_sources[e["resolution_source"]] += 1
        if e["name"]: setup_named += 1
        if e["resolved"]: setup_resolved += 1

    gfx_resolution_sources = defaultdict(int)
    gfx_named = 0
    gfx_resolved = 0
    for e in by_gfx_obj_id.values():
        gfx_resolution_sources[e["resolution_source"]] += 1
        if e["name"]: gfx_named += 1
        if e["resolved"]: gfx_resolved += 1

    payload = {
        "version": "2.0",
        "generated": datetime.now(timezone.utc).isoformat(),
        "sources": {
            "canonical_enrichment": str(CANONICAL_PATH),
            "ace_world_setup_names": str(ACE_WORLD_PATH),
            "setup_parts": str(SETUP_PARTS_PATH),
            "classification_signals": str(SIGNALS_PATH),
            "ontology_geometry": str(GEOMETRY_CSV),
        },
        "stats": {
            "setups": {
                "total": len(by_setup_did),
                "named": setup_named,
                "resolved": setup_resolved,
                "by_resolution_source": dict(setup_resolution_sources),
            },
            "gfx_objs": {
                "total": len(by_gfx_obj_id),
                "named": gfx_named,
                "resolved": gfx_resolved,
                "by_resolution_source": dict(gfx_resolution_sources),
            },
            "wcids": {"total": len(by_wcid)},
        },
        "by_setup_did": by_setup_did,
        "by_gfx_obj_id": by_gfx_obj_id,
        "by_wcid": by_wcid,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, indent=2))
    print(f"\nWrote {OUT_PATH}")
    print(f"  setups:   {len(by_setup_did):,} ({setup_named:,} named, {setup_resolved:,} resolved)")
    print(f"  gfx_objs: {len(by_gfx_obj_id):,} ({gfx_named:,} named, {gfx_resolved:,} resolved)")
    print(f"  wcids:    {len(by_wcid):,}")


if __name__ == "__main__":
    main()

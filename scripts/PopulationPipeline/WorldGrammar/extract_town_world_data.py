#!/usr/bin/env python3
"""
Filter retail world exports down to curated surface-town landblocks.

This stage uses the checked-in town kit index as the source of truth for which
retail landblocks count as towns. By default it excludes interior cells so the
town model stays focused on exterior town grammar; interiors can be added later
with --include-interiors for a dedicated pass.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
REFERENCE_DIR = ROOT / "pipeline_data" / "reference"
TOWN_KIT_DIR = ROOT / "town_kits"

DEFAULT_RAW_JSONL = REFERENCE_DIR / "raw_world_facts_full_with_components_v2.jsonl"
DEFAULT_COMPONENT_JSONL = REFERENCE_DIR / "envcell_components_full.jsonl"
DEFAULT_TOWN_INDEX = TOWN_KIT_DIR / "index.json"

DEFAULT_OUT_RAW = REFERENCE_DIR / "world_grammar_town_surface_raw_world_facts.jsonl"
DEFAULT_OUT_COMPONENT = REFERENCE_DIR / "world_grammar_town_surface_envcell_components.jsonl"
DEFAULT_OUT_SUMMARY = REFERENCE_DIR / "world_grammar_town_surface_manifest.json"
DEFAULT_EXCLUDED_TOWNS: set[str] = set()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Filter raw retail exports to curated town landblocks.")
    parser.add_argument("--raw-jsonl", type=Path, default=DEFAULT_RAW_JSONL)
    parser.add_argument("--component-jsonl", type=Path, default=DEFAULT_COMPONENT_JSONL)
    parser.add_argument("--town-index", type=Path, default=DEFAULT_TOWN_INDEX)
    parser.add_argument("--out-raw-jsonl", type=Path, default=DEFAULT_OUT_RAW)
    parser.add_argument("--out-component-jsonl", type=Path, default=DEFAULT_OUT_COMPONENT)
    parser.add_argument("--out-summary", type=Path, default=DEFAULT_OUT_SUMMARY)
    parser.add_argument("--town-name", action="append", default=[], help="Only include the named town. Repeatable.")
    parser.add_argument("--exclude-town", action="append", default=[], help="Exclude the named town. Repeatable.")
    parser.add_argument("--include-interiors", action="store_true", help="Keep interior cell rows/components too.")
    parser.add_argument("--fringe-radius", type=int, default=1, help="Expand each curated town by this many landblocks using civic-fringe heuristics. Use 0 to disable.")
    return parser.parse_args()


def parse_hexish(value) -> int | None:
    if value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.startswith("0x"):
        return int(value, 16)
    return int(value)


def is_interior_cell(cell_id_value) -> bool:
    cell_id = parse_hexish(cell_id_value)
    return cell_id is not None and cell_id >= 0x0100


def load_selected_town_landblocks(index_path: Path, include_names: set[str], exclude_names: set[str]) -> tuple[dict[str, list[list[int]]], set[tuple[int, int]]]:
    with index_path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)

    towns_meta = data.get("towns", {})
    selected: dict[str, list[list[int]]] = {}
    selected_landblocks: set[tuple[int, int]] = set()
    for town_name, meta in towns_meta.items():
        if include_names and town_name not in include_names:
            continue
        if town_name in exclude_names:
            continue

        town_file = TOWN_KIT_DIR / meta["file"]
        with town_file.open("r", encoding="utf-8") as handle:
            town_data = json.load(handle)
        landblocks = town_data.get("landblocks", [])
        selected[town_name] = landblocks
        for lb_x, lb_y in landblocks:
            selected_landblocks.add((int(lb_x), int(lb_y)))

    return selected, selected_landblocks


def build_surface_landblock_stats(raw_jsonl: Path) -> dict[tuple[int, int], dict]:
    stats: dict[tuple[int, int], dict] = {}
    with raw_jsonl.open("r", encoding="utf-8-sig") as src:
        for line in src:
            if not line.strip():
                continue
            row = json.loads(line)
            if is_interior_cell(row.get("cellId")):
                continue
            lb_key = (int(row["landblockX"]), int(row["landblockY"]))
            bucket = stats.get(lb_key)
            if bucket is None:
                bucket = {
                    "rows": 0,
                    "buildings": 0,
                    "vendors": 0,
                    "doors": 0,
                    "portals": 0,
                    "lifestones": 0,
                    "creatures": 0,
                    "hotspots": 0,
                    "encounters": 0,
                }
                stats[lb_key] = bucket

            bucket["rows"] += 1
            if row.get("sourceTable") == "landblock_info_building":
                bucket["buildings"] += 1
            elif row.get("sourceTable") == "encounter":
                bucket["encounters"] += 1

            type_id = row.get("typeId")
            if type_id is None:
                continue
            type_id = int(type_id)
            if type_id == 12:
                bucket["vendors"] += 1
            elif type_id == 19:
                bucket["doors"] += 1
            elif type_id == 7:
                bucket["portals"] += 1
            elif type_id == 25:
                bucket["lifestones"] += 1
            elif type_id == 10:
                bucket["creatures"] += 1
            elif type_id == 13:
                bucket["hotspots"] += 1
    return stats


def is_town_fringe_candidate(stats: dict) -> bool:
    if not stats or stats["rows"] <= 0:
        return False
    if stats["vendors"] > 0 or stats["lifestones"] > 0:
        return True
    if stats["buildings"] > 0 and (stats["doors"] > 0 or stats["portals"] > 0):
        return True
    if stats["doors"] >= 4 and stats["rows"] >= 15:
        return True
    return False


def expand_town_landblocks(
    towns: dict[str, list[list[int]]],
    raw_jsonl: Path,
    fringe_radius: int,
) -> tuple[dict[str, list[list[int]]], set[tuple[int, int]], dict]:
    expanded = {name: [list(lb) for lb in landblocks] for name, landblocks in towns.items()}
    current = {tuple(lb) for lbs in towns.values() for lb in lbs}
    if fringe_radius <= 0:
        return expanded, set(current), {"expanded_landblocks": 0, "per_town_added": {}}

    landblock_stats = build_surface_landblock_stats(raw_jsonl)
    added_by_town: dict[str, list[list[int]]] = {name: [] for name in towns}
    accepted_global: set[tuple[int, int]] = set(current)

    for town_name, landblocks in towns.items():
        candidates: set[tuple[int, int]] = set()
        for lb_x, lb_y in landblocks:
            for dx in range(-fringe_radius, fringe_radius + 1):
                for dy in range(-fringe_radius, fringe_radius + 1):
                    candidate = (int(lb_x) + dx, int(lb_y) + dy)
                    if candidate in accepted_global:
                        continue
                    candidates.add(candidate)

        accepted_local = []
        for candidate in sorted(candidates):
            if is_town_fringe_candidate(landblock_stats.get(candidate)):
                accepted_local.append(candidate)
                accepted_global.add(candidate)

        for lb in accepted_local:
            expanded[town_name].append([lb[0], lb[1]])
            added_by_town[town_name].append([lb[0], lb[1]])

    return expanded, accepted_global, {
        "expanded_landblocks": len(accepted_global) - len(current),
        "per_town_added": {name: lbs for name, lbs in added_by_town.items() if lbs},
    }


def filter_raw_jsonl(
    src_path: Path,
    dst_path: Path,
    selected_landblocks: set[tuple[int, int]],
    include_interiors: bool,
) -> dict:
    stats = {
        "scanned_rows": 0,
        "kept_rows": 0,
        "excluded_non_town": 0,
        "excluded_interior": 0,
        "class_space_counts": Counter(),
        "source_db_counts": Counter(),
        "source_table_counts": Counter(),
        "weenie_type_counts": Counter(),
        "town_landblock_counts": Counter(),
    }

    dst_path.parent.mkdir(parents=True, exist_ok=True)
    with src_path.open("r", encoding="utf-8-sig") as src, dst_path.open("w", encoding="utf-8") as dst:
        for line in src:
            if not line.strip():
                continue
            stats["scanned_rows"] += 1
            row = json.loads(line)
            lb_key = (int(row["landblockX"]), int(row["landblockY"]))
            if lb_key not in selected_landblocks:
                stats["excluded_non_town"] += 1
                continue
            if not include_interiors and is_interior_cell(row.get("cellId")):
                stats["excluded_interior"] += 1
                continue

            dst.write(json.dumps(row, ensure_ascii=True) + "\n")
            stats["kept_rows"] += 1
            stats["class_space_counts"][row.get("classIdSpace") or "unknown"] += 1
            stats["source_db_counts"][row.get("sourceDb") or "unknown"] += 1
            stats["source_table_counts"][row.get("sourceTable") or "unknown"] += 1
            if row.get("typeId") is not None:
                stats["weenie_type_counts"][int(row["typeId"])] += 1
            stats["town_landblock_counts"][f"{lb_key[0]},{lb_key[1]}"] += 1

    return stats


def filter_component_jsonl(
    src_path: Path,
    dst_path: Path,
    selected_landblocks: set[tuple[int, int]],
    include_interiors: bool,
) -> dict:
    stats = {
        "scanned_components": 0,
        "kept_components": 0,
        "excluded_non_town": 0,
        "excluded_interior": 0,
        "component_kind_counts": Counter(),
        "anchor_source_table_counts": Counter(),
    }

    dst_path.parent.mkdir(parents=True, exist_ok=True)
    with src_path.open("r", encoding="utf-8-sig") as src, dst_path.open("w", encoding="utf-8") as dst:
        for line in src:
            if not line.strip():
                continue
            stats["scanned_components"] += 1
            row = json.loads(line)
            lb_key = (int(row["landblockX"]), int(row["landblockY"]))
            if lb_key not in selected_landblocks:
                stats["excluded_non_town"] += 1
                continue

            anchor = row.get("anchor") or {}
            if not include_interiors and is_interior_cell(anchor.get("cellId")):
                stats["excluded_interior"] += 1
                continue

            dst.write(json.dumps(row, ensure_ascii=True) + "\n")
            stats["kept_components"] += 1
            stats["component_kind_counts"][row.get("componentKind") or "unknown"] += 1
            stats["anchor_source_table_counts"][anchor.get("sourceTable") or "unknown"] += 1

    return stats


def compact_counter(counter: Counter, limit: int | None = None) -> list[dict]:
    items = counter.most_common(limit)
    return [{"value": key, "count": count} for key, count in items]


def main() -> None:
    args = parse_args()

    include_names = {name.strip() for name in args.town_name if name.strip()}
    exclude_names = set(DEFAULT_EXCLUDED_TOWNS)
    exclude_names.update(name.strip() for name in args.exclude_town if name.strip())
    towns, _ = load_selected_town_landblocks(args.town_index, include_names, exclude_names)
    if not towns:
        raise SystemExit("No towns selected.")
    towns, landblocks, expansion = expand_town_landblocks(towns, args.raw_jsonl, args.fringe_radius)

    print("=" * 72)
    print("  Town World Data Extractor")
    print("=" * 72)
    print(f"  Towns            : {len(towns)}")
    print(f"  Town landblocks  : {len(landblocks)}")
    print(f"  Fringe radius    : {args.fringe_radius}")
    print(f"  Fringe added     : {expansion['expanded_landblocks']}")
    print(f"  Include interiors: {args.include_interiors}")
    print(f"  Raw input        : {args.raw_jsonl}")
    print(f"  Components input : {args.component_jsonl}")
    print(f"  Raw output       : {args.out_raw_jsonl}")
    print(f"  Components output: {args.out_component_jsonl}")
    print()

    raw_stats = filter_raw_jsonl(args.raw_jsonl, args.out_raw_jsonl, landblocks, args.include_interiors)
    component_stats = filter_component_jsonl(args.component_jsonl, args.out_component_jsonl, landblocks, args.include_interiors)

    summary = {
        "mode": "town_with_interiors" if args.include_interiors else "town_surface_only",
        "default_excluded_towns": sorted(DEFAULT_EXCLUDED_TOWNS),
        "fringe_radius": args.fringe_radius,
        "fringe_added_landblocks": expansion["expanded_landblocks"],
        "fringe_added_by_town": expansion["per_town_added"],
        "town_count": len(towns),
        "towns": {name: {"landblocks": lbs} for name, lbs in sorted(towns.items())},
        "landblock_count": len(landblocks),
        "raw": {
            **raw_stats,
            "class_space_counts": compact_counter(raw_stats["class_space_counts"]),
            "source_db_counts": compact_counter(raw_stats["source_db_counts"]),
            "source_table_counts": compact_counter(raw_stats["source_table_counts"]),
            "weenie_type_counts": compact_counter(raw_stats["weenie_type_counts"]),
            "top_landblocks": compact_counter(raw_stats["town_landblock_counts"], limit=50),
        },
        "components": {
            **component_stats,
            "component_kind_counts": compact_counter(component_stats["component_kind_counts"]),
            "anchor_source_table_counts": compact_counter(component_stats["anchor_source_table_counts"]),
        },
        "paths": {
            "raw_jsonl": str(args.out_raw_jsonl),
            "component_jsonl": str(args.out_component_jsonl),
        },
    }
    for key in ("class_space_counts", "source_db_counts", "source_table_counts", "weenie_type_counts", "town_landblock_counts"):
        raw_stats.pop(key, None)
    for key in ("component_kind_counts", "anchor_source_table_counts"):
        component_stats.pop(key, None)

    args.out_summary.parent.mkdir(parents=True, exist_ok=True)
    with args.out_summary.open("w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)

    print("Summary")
    print(f"  Raw kept rows    : {summary['raw']['kept_rows']:,}")
    print(f"  Components kept  : {summary['components']['kept_components']:,}")
    print(f"  Top class spaces : {summary['raw']['class_space_counts'][:4]}")
    print(f"  Top source tables: {summary['raw']['source_table_counts'][:4]}")
    print(f"  Manifest         : {args.out_summary}")


if __name__ == "__main__":
    main()

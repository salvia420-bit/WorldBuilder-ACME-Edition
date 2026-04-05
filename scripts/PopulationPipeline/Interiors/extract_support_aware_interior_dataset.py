#!/usr/bin/env python3
"""
Build a first-pass support-aware interior dataset from retail exports.

This extractor is intentionally conservative. It only emits high-confidence
supported-prop rows when a prop has a direct linked parent that is itself
classified as a support-capable object. Support-object rows are broader and are
meant to seed later structural/support modeling work.
"""

from __future__ import annotations

import argparse
import json
import math
import re
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
REFERENCE_DIR = ROOT / "pipeline_data" / "reference"
ENRICHMENT_DIR = ROOT / "pipeline_data" / "enrichment"

DEFAULT_RAW_JSONL = REFERENCE_DIR / "raw_world_facts_full_with_components_v2.jsonl"
DEFAULT_COMPONENT_JSONL = REFERENCE_DIR / "envcell_components_full.jsonl"
DEFAULT_GROUNDING_JSONL = REFERENCE_DIR / "world_grammar_grounding_table.jsonl"
DEFAULT_WCID_TYPES_JSON = REFERENCE_DIR / "wcid_types_cache.json"
DEFAULT_CANONICAL_ENRICHMENT_JSON = ENRICHMENT_DIR / "canonical_enrichment.json"

DEFAULT_OUT_SUPPORT_JSONL = REFERENCE_DIR / "interior_support_objects_highconf.jsonl"
DEFAULT_OUT_PROP_JSONL = REFERENCE_DIR / "interior_supported_props_highconf.jsonl"
DEFAULT_OUT_SUMMARY_JSON = REFERENCE_DIR / "interior_support_dataset_highconf_summary.json"
DEFAULT_OUT_REVIEW_JSONL = REFERENCE_DIR / "interior_supported_prop_candidates_review.jsonl"


SUPPORT_NAME_HINTS = {
    "hook_floor": ("hook floor",),
    "hook_ceiling": ("hook ceiling",),
    "hook_wall": ("hook",),
    "shelf_like": ("bookshelf", "book shelf", "bookcase", "shelf"),
    "table_like": ("table",),
    "desk_like": ("desk",),
    "bed_like": ("bed",),
    "altar_like": ("altar",),
    "container_top": ("chest", "cabinet", "crate", "barrel"),
    "wall_fixture": ("torch", "sconce", "candlestick"),
}

PROP_NAME_HINTS = {
    "bottle_like": ("bottle",),
    "book_like": ("book",),
    "scroll_like": ("scroll",),
    "gem_like": ("gem",),
    "candle_like": ("candle", "candlestick"),
    "bowl_like": ("bowl",),
    "food_like": ("food",),
}

SUPPORT_WEENIE_TYPES = {20, 21, 24, 26, 56, 57}
PROP_WEENIE_TYPES = {8, 18, 34, 38, 44}
LOOT_CONTAINER_NAME_HINTS = (
    "chest",
    "storage",
    "sack",
    "cache",
    "coffer",
    "crate",
    "barrel",
    "treasure",
    "locker",
)
STATIC_SETUP_NAME_RULES = (
    ("bookcase", "shelf_like"),
    ("bookshelf", "shelf_like"),
    ("book shelf", "shelf_like"),
    ("desk", "desk_like"),
    ("alchemy table", "table_like"),
    ("table", "table_like"),
    ("altar", "altar_like"),
    ("bed", "bed_like"),
    ("torch", "wall_fixture"),
    ("sconce", "wall_fixture"),
)
STATIC_SETUP_EXCLUDE_HINTS = (
    "portable igloo",
    "unstable portal",
    "stone tablet",
    "eastern temple tablet",
    "unstable mana stone",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract a first-pass support-aware interior dataset.")
    parser.add_argument("--raw-jsonl", type=Path, default=DEFAULT_RAW_JSONL)
    parser.add_argument("--component-jsonl", type=Path, default=DEFAULT_COMPONENT_JSONL)
    parser.add_argument("--grounding-jsonl", type=Path, default=DEFAULT_GROUNDING_JSONL)
    parser.add_argument("--wcid-types-json", type=Path, default=DEFAULT_WCID_TYPES_JSON)
    parser.add_argument("--canonical-enrichment-json", type=Path, default=DEFAULT_CANONICAL_ENRICHMENT_JSON)
    parser.add_argument("--out-support-jsonl", type=Path, default=DEFAULT_OUT_SUPPORT_JSONL)
    parser.add_argument("--out-prop-jsonl", type=Path, default=DEFAULT_OUT_PROP_JSONL)
    parser.add_argument("--out-summary-json", type=Path, default=DEFAULT_OUT_SUMMARY_JSON)
    parser.add_argument("--out-review-jsonl", type=Path, default=DEFAULT_OUT_REVIEW_JSONL)
    return parser.parse_args()


def parse_hexish(value) -> int | None:
    if value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.startswith("0x"):
        return int(value, 16)
    return int(value)


def iter_jsonl(path: Path):
    with path.open("r", encoding="utf-8-sig") as handle:
        for line in handle:
            line = line.strip()
            if line:
                yield json.loads(line)


def load_grounding(path: Path) -> dict[int, dict]:
    rows: dict[int, dict] = {}
    if not path.exists():
        return rows
    for row in iter_jsonl(path):
        if row.get("class_space") != "wcid":
            continue
        rows[int(row["class_id"])] = row
    return rows


def load_json_dict(path: Path) -> dict:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def load_component_cells(path: Path) -> tuple[dict[int, dict], dict[tuple[int, int, int], dict]]:
    components: dict[int, dict] = {}
    cells: dict[tuple[int, int, int], dict] = {}
    if not path.exists():
        return components, cells

    for idx, row in enumerate(iter_jsonl(path), start=1):
        component_id = int(row["componentId"])
        component_info = {
            "componentId": component_id,
            "componentKind": row.get("componentKind"),
            "landblockId": row.get("landblockId"),
            "landblockX": int(row["landblockX"]),
            "landblockY": int(row["landblockY"]),
            "anchor": row.get("anchor"),
            "cellCount": int(row.get("cellCount", 0)),
            "staticObjectCount": int(row.get("staticObjectCount", 0)),
            "boundsLocal": row.get("boundsLocal") or {},
        }
        components[component_id] = component_info

        for cell in row.get("cells", []):
            cell_num = parse_hexish(cell.get("cellNumber"))
            if cell_num is None:
                continue
            cells[(component_info["landblockX"], component_info["landblockY"], cell_num)] = {
                "cellNumber": cell.get("cellNumber"),
                "cellId": cell.get("cellId"),
                "componentInfo": component_info,
                "origin": {
                    "x": float(cell.get("x", 0.0)),
                    "y": float(cell.get("y", 0.0)),
                    "z": float(cell.get("z", 0.0)),
                },
                "rotation": {
                    "qw": float(cell.get("qw", 1.0)),
                    "qx": float(cell.get("qx", 0.0)),
                    "qy": float(cell.get("qy", 0.0)),
                    "qz": float(cell.get("qz", 0.0)),
                },
                "staticObjectCount": int(cell.get("staticObjectCount", 0)),
                "staticObjects": cell.get("staticObjects") or [],
                "portalCount": len(cell.get("portalRefs", [])),
                "visibleCellCount": len(cell.get("visibleCellRefs", [])),
            }
        if idx % 1000 == 0:
            print(f"  Components loaded: {idx:,}")

    return components, cells


def build_canonical_index(canonical_enrichment: dict) -> dict[int, dict]:
    entries = canonical_enrichment.get("entries")
    if not isinstance(entries, list):
        return {}

    index: dict[int, dict] = {}
    for entry in entries:
        for key in ("class_id", "wcid"):
            raw_value = entry.get(key)
            if raw_value is None:
                continue
            try:
                index[int(raw_value)] = entry
            except (TypeError, ValueError):
                continue
    return index


def build_setup_name_index(canonical_enrichment: dict) -> dict[int, str]:
    entries = canonical_enrichment.get("entries")
    if not isinstance(entries, list):
        return {}

    setup_name_counts: dict[int, Counter] = {}
    for entry in entries:
        raw_setup = entry.get("setupDid")
        if raw_setup is None:
            continue
        name = entry.get("name") or entry.get("canonical_name")
        if not isinstance(name, str) or not name.strip():
            continue
        setup_did = int(raw_setup)
        bucket = setup_name_counts.setdefault(setup_did, Counter())
        bucket[name.strip()] += 1

    result: dict[int, str] = {}
    for setup_did, counts in setup_name_counts.items():
        result[setup_did] = counts.most_common(1)[0][0]
    return result


def normalized_name(raw_row: dict, grounding_row: dict | None, canonical_entry: dict | None) -> str:
    for value in (
        raw_row.get("name"),
        raw_row.get("className"),
        raw_row.get("aceFriendlyName"),
        grounding_row.get("preferred_name") if grounding_row else None,
        grounding_row.get("ace_friendly_name") if grounding_row else None,
        grounding_row.get("ace_class_name") if grounding_row else None,
        canonical_entry.get("name") if canonical_entry else None,
        canonical_entry.get("canonical_name") if canonical_entry else None,
    ):
        if isinstance(value, str) and value.strip():
            return value.strip().lower()
    return ""


def tokenize_name(name: str) -> tuple[str, ...]:
    return tuple(token for token in re.split(r"[^a-z0-9]+", name.lower()) if token)


def name_has_hint(name: str, hint: str) -> bool:
    if not name or not hint:
        return False
    if " " in hint:
        pattern = r"\b" + re.escape(hint) + r"\b"
        return re.search(pattern, name) is not None
    tokens = tokenize_name(name)
    return hint in tokens


def is_loot_container_name(name: str) -> bool:
    return any(name_has_hint(name, hint) for hint in LOOT_CONTAINER_NAME_HINTS)


def classify_support(row: dict, grounding_row: dict | None, canonical_entry: dict | None) -> tuple[str | None, float, str]:
    weenie_type = int(row.get("weenieType") or row.get("typeId") or 0)
    name = normalized_name(row, grounding_row, canonical_entry)

    if weenie_type == 56:
        if "hook floor" in name:
            return "hook_floor", 0.99, "weenie_type_56+name"
        if "hook ceiling" in name:
            return "hook_ceiling", 0.99, "weenie_type_56+name"
        return "hook_wall", 0.95, "weenie_type_56"

    for support_class, hints in SUPPORT_NAME_HINTS.items():
        if any(name_has_hint(name, hint) for hint in hints):
            base_conf = 0.80
            if support_class in {"shelf_like", "desk_like", "table_like"}:
                base_conf = 0.86
            elif support_class in {"container_top", "altar_like", "bed_like"}:
                base_conf = 0.76
            elif support_class == "wall_fixture":
                base_conf = 0.72
            return support_class, base_conf, "name_hint"

    if weenie_type in SUPPORT_WEENIE_TYPES:
        if weenie_type == 21:
            return "container_top", 0.58, "weenie_type"
        if weenie_type == 20:
            return "container_top", 0.60, "weenie_type"
        if weenie_type == 57:
            return "container_top", 0.65, "weenie_type"
    return None, 0.0, "unclassified"


def classify_prop(row: dict, grounding_row: dict | None, canonical_entry: dict | None) -> tuple[str | None, float, str]:
    weenie_type = int(row.get("weenieType") or row.get("typeId") or 0)
    name = normalized_name(row, grounding_row, canonical_entry)

    for prop_class, hints in PROP_NAME_HINTS.items():
        if any(name_has_hint(name, hint) for hint in hints):
            return prop_class, 0.82, "name_hint"

    if weenie_type in PROP_WEENIE_TYPES:
        return f"type_{weenie_type}", 0.55, "weenie_type"
    return None, 0.0, "unclassified"


def classify_static_support_name(name: str) -> tuple[str | None, float, str]:
    lower_name = name.strip().lower()
    if not lower_name:
        return None, 0.0, "unclassified"
    if any(name_has_hint(lower_name, hint) for hint in STATIC_SETUP_EXCLUDE_HINTS):
        return None, 0.0, "excluded_name"
    for hint, support_class in STATIC_SETUP_NAME_RULES:
        if name_has_hint(lower_name, hint):
            return support_class, 0.72, "static_setup_name"
    return None, 0.0, "unclassified"


def yaw_deg(row: dict) -> float:
    if row.get("yawDeg") is not None:
        return float(row["yawDeg"])
    qw = float(row.get("qw", 1.0))
    qx = float(row.get("qx", 0.0))
    qy = float(row.get("qy", 0.0))
    qz = float(row.get("qz", 0.0))
    siny_cosp = 2.0 * (qw * qz + qx * qy)
    cosy_cosp = 1.0 - 2.0 * (qy * qy + qz * qz)
    return math.degrees(math.atan2(siny_cosp, cosy_cosp))


def angle_delta_deg(a: float, b: float) -> float:
    delta = (a - b + 180.0) % 360.0 - 180.0
    return delta


def interior_only(row: dict) -> bool:
    cell_id = parse_hexish(row.get("cellId"))
    return cell_id is not None and cell_id >= 0x0100


def build_scene_id(row: dict) -> str:
    return f"{row['landblockId']}:{row['cellId']}"


def build_room_context(row: dict, component_info: dict | None, cell_info: dict | None) -> dict:
    return {
        "portalCountInCell": int(cell_info.get("portalCount", 0)) if cell_info else 0,
        "visibleCellCount": int(cell_info.get("visibleCellCount", 0)) if cell_info else 0,
        "staticObjectCountInCell": int(cell_info.get("staticObjectCount", 0)) if cell_info else 0,
        "staticObjectCountInComponent": int(component_info.get("staticObjectCount", 0)) if component_info else 0,
        "cellCountInComponent": int(component_info.get("cellCount", 0)) if component_info else 0,
        "componentKind": row.get("envCellComponentKind"),
    }


def build_scene_key(row: dict) -> tuple[int, int, str, int | None]:
    return (
        int(row["landblockX"]),
        int(row["landblockY"]),
        row["cellId"],
        int(row["envCellComponentId"]) if row.get("envCellComponentId") is not None else None,
    )


def build_support_object_row(
    row: dict,
    support_class: str,
    support_confidence: float,
    support_mode: str,
    grounding_row: dict | None,
    component_info: dict | None,
    cell_info: dict | None,
) -> dict:
    return {
        "sceneId": build_scene_id(row),
        "landblockId": row["landblockId"],
        "landblockX": int(row["landblockX"]),
        "landblockY": int(row["landblockY"]),
        "cellId": row["cellId"],
        "componentId": row.get("envCellComponentId"),
        "componentKind": row.get("envCellComponentKind"),
        "roomFrame": {
            "origin": cell_info.get("origin") if cell_info else None,
            "rotation": cell_info.get("rotation") if cell_info else None,
        },
        "object": {
            "guid": row.get("guid"),
            "classIdSpace": row.get("classIdSpace"),
            "classId": row.get("classId"),
            "wcid": row.get("wcid"),
            "weenieType": row.get("weenieType") or row.get("typeId"),
            "name": grounding_row.get("preferred_name") if grounding_row else (row.get("name") or row.get("className")),
            "positionLocal": {
                "x": float(row.get("localX", 0.0)),
                "y": float(row.get("localY", 0.0)),
                "z": float(row.get("z", 0.0)),
            },
            "rotation": {
                "qw": float(row.get("qw", 1.0)),
                "qx": float(row.get("qx", 0.0)),
                "qy": float(row.get("qy", 0.0)),
                "qz": float(row.get("qz", 0.0)),
            },
        },
        "supportClass": support_class,
        "supportConfidence": round(support_confidence, 4),
        "supportInferenceMode": support_mode,
        "geometry": {
            "componentBoundsLocal": component_info.get("boundsLocal") if component_info else None,
        },
        "context": build_room_context(row, component_info, cell_info),
    }


def build_supported_prop_row(
    row: dict,
    prop_class: str,
    prop_confidence: float,
    prop_mode: str,
    prop_grounding: dict | None,
    parent_row: dict,
    parent_support_class: str,
    parent_support_confidence: float,
    parent_support_mode: str,
    parent_grounding: dict | None,
    component_info: dict | None,
    cell_info: dict | None,
) -> dict:
    prop_yaw = yaw_deg(row)
    parent_yaw = yaw_deg(parent_row)
    dx = float(row.get("localX", 0.0)) - float(parent_row.get("localX", 0.0))
    dy = float(row.get("localY", 0.0)) - float(parent_row.get("localY", 0.0))
    dz = float(row.get("z", 0.0)) - float(parent_row.get("z", 0.0))
    same_cell = row.get("cellId") == parent_row.get("cellId")
    relation_kind = "hook_attached" if parent_support_class.startswith("hook_") else "linked_child_of_support"
    relation_confidence = min(prop_confidence, parent_support_confidence)

    return {
        "sceneId": build_scene_id(row),
        "landblockId": row["landblockId"],
        "landblockX": int(row["landblockX"]),
        "landblockY": int(row["landblockY"]),
        "cellId": row["cellId"],
        "componentId": row.get("envCellComponentId"),
        "componentKind": row.get("envCellComponentKind"),
        "prop": {
            "guid": row.get("guid"),
            "classIdSpace": row.get("classIdSpace"),
            "classId": row.get("classId"),
            "wcid": row.get("wcid"),
            "weenieType": row.get("weenieType") or row.get("typeId"),
            "name": prop_grounding.get("preferred_name") if prop_grounding else None,
            "propClass": prop_class,
            "propConfidence": round(prop_confidence, 4),
            "propInferenceMode": prop_mode,
            "positionLocal": {
                "x": float(row.get("localX", 0.0)),
                "y": float(row.get("localY", 0.0)),
                "z": float(row.get("z", 0.0)),
            },
            "rotation": {
                "qw": float(row.get("qw", 1.0)),
                "qx": float(row.get("qx", 0.0)),
                "qy": float(row.get("qy", 0.0)),
                "qz": float(row.get("qz", 0.0)),
            },
        },
        "supportParent": {
            "guid": parent_row.get("guid"),
            "classIdSpace": parent_row.get("classIdSpace"),
            "classId": parent_row.get("classId"),
            "wcid": parent_row.get("wcid"),
            "weenieType": parent_row.get("weenieType") or parent_row.get("typeId"),
            "name": parent_grounding.get("preferred_name") if parent_grounding else (parent_row.get("name") or parent_row.get("className")),
            "supportClass": parent_support_class,
            "supportConfidence": round(parent_support_confidence, 4),
            "supportInferenceMode": parent_support_mode,
        },
        "supportRelation": {
            "kind": relation_kind,
            "confidence": round(relation_confidence, 4),
            "relativePosition": {"x": round(dx, 4), "y": round(dy, 4), "z": round(dz, 4)},
            "relativeYawDeg": round(angle_delta_deg(prop_yaw, parent_yaw), 4),
            "heightAboveSupportPlane": round(dz, 4),
            "sameCell": same_cell,
            "supportInferenceMode": "graph_link",
        },
        "roomContext": build_room_context(row, component_info, cell_info),
        "validation": {
            "hasDirectParentGuid": parent_row.get("guid") is not None,
            "sameCell": same_cell,
            "componentMatchesParent": row.get("envCellComponentId") == parent_row.get("envCellComponentId"),
        },
    }


def build_review_prop_candidate_row(
    row: dict,
    prop_class: str,
    prop_confidence: float,
    prop_mode: str,
    prop_grounding: dict | None,
    parent_row: dict,
    parent_support_class: str,
    parent_support_confidence: float,
    parent_support_mode: str,
    parent_grounding: dict | None,
    component_info: dict | None,
    cell_info: dict | None,
    relation_confidence: float,
    relation_mode: str,
    competing_parent_count: int,
) -> dict:
    base = build_supported_prop_row(
        row,
        prop_class,
        prop_confidence,
        prop_mode,
        prop_grounding,
        parent_row,
        parent_support_class,
        parent_support_confidence,
        parent_support_mode,
        parent_grounding,
        component_info,
        cell_info,
    )
    base["supportRelation"]["kind"] = "geometry_candidate"
    base["supportRelation"]["confidence"] = round(relation_confidence, 4)
    base["supportRelation"]["supportInferenceMode"] = relation_mode
    dz = float(row.get("z", 0.0)) - float(parent_row.get("z", 0.0))
    horiz = math.hypot(
        float(row.get("localX", 0.0)) - float(parent_row.get("localX", 0.0)),
        float(row.get("localY", 0.0)) - float(parent_row.get("localY", 0.0)),
    )
    base["validation"]["competingParentCount"] = competing_parent_count
    base["validation"]["verticalOffsetOk"] = dz >= -0.25
    base["validation"]["horizontalDistance"] = round(horiz, 4)
    base["validation"]["reviewOnly"] = True
    return base


def supported_prop_relation_valid(row: dict, parent_row: dict) -> tuple[bool, str]:
    if row.get("cellId") != parent_row.get("cellId"):
        return False, "different_cell"
    if row.get("envCellComponentId") != parent_row.get("envCellComponentId"):
        return False, "different_component"
    dz = float(row.get("z", 0.0)) - float(parent_row.get("z", 0.0))
    if dz < -0.25:
        return False, "below_parent_plane"
    return True, "ok"


def find_geometry_support_candidate(
    row: dict,
    support_candidates: list[tuple[int, dict, str | None, float, str, dict | None, dict | None]],
) -> tuple[tuple[int, dict, str, float, str, dict | None] | None, int]:
    x = float(row.get("localX", 0.0))
    y = float(row.get("localY", 0.0))
    z = float(row.get("z", 0.0))
    ranked: list[tuple[float, float, float, int, dict, str, float, str, dict | None]] = []

    for support_guid, support_row, support_class, support_conf, support_mode, support_grounding, _canonical_entry in support_candidates:
        if support_class is None or support_guid == int(row.get("guid") or -1):
            continue
        support_name = normalized_name(support_row, support_grounding, None)
        if support_class == "container_top" and is_loot_container_name(support_name):
            continue
        sx = float(support_row.get("localX", 0.0))
        sy = float(support_row.get("localY", 0.0))
        sz = float(support_row.get("z", 0.0))
        dz = z - sz
        if dz < -0.25 or dz > 1.5:
            continue
        horiz = math.hypot(x - sx, y - sy)
        if horiz > 1.5:
            continue

        score = horiz + dz * 0.25
        if support_class == "container_top":
            score += 1.0
        elif support_class in {"table_like", "desk_like", "altar_like", "shelf_like"}:
            score -= 0.25
        ranked.append((score, horiz, dz, support_guid, support_row, support_class, support_conf, support_mode, support_grounding))

    if not ranked:
        return None, 0

    ranked.sort(key=lambda item: item[0])
    best = ranked[0]
    support_guid, support_row, support_class, support_conf, support_mode, support_grounding = (
        best[3],
        best[4],
        best[5],
        best[6],
        best[7],
        best[8],
    )
    return (support_guid, support_row, support_class, support_conf, support_mode, support_grounding), max(len(ranked) - 1, 0)


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=True) + "\n")


def main() -> None:
    args = parse_args()
    grounding_by_wcid = load_grounding(args.grounding_jsonl)
    canonical_enrichment = load_json_dict(args.canonical_enrichment_json)
    canonical_by_wcid = build_canonical_index(canonical_enrichment)
    setup_name_by_model_id = build_setup_name_index(canonical_enrichment)
    _wcid_types = load_json_dict(args.wcid_types_json)
    component_by_id, cells_by_lb_cell = load_component_cells(args.component_jsonl)

    raw_rows_by_guid: dict[int, dict] = {}
    support_rows: list[dict] = []
    prop_rows: list[dict] = []
    review_rows: list[dict] = []

    stats = {
        "scanned_rows": 0,
        "interior_rows": 0,
        "support_objects_emitted": 0,
        "supported_props_emitted": 0,
        "skipped_non_interior": 0,
        "skipped_non_wcid": 0,
        "skipped_non_instance": 0,
        "skipped_no_guid": 0,
        "support_class_counts": Counter(),
        "prop_class_counts": Counter(),
        "support_inference_mode_counts": Counter(),
        "prop_inference_mode_counts": Counter(),
        "prop_rejection_reason_counts": Counter(),
        "review_candidate_emitted": 0,
        "review_candidate_support_class_counts": Counter(),
        "review_candidate_prop_class_counts": Counter(),
        "static_support_objects_emitted": 0,
    }

    for idx, row in enumerate(iter_jsonl(args.raw_jsonl), start=1):
        stats["scanned_rows"] += 1
        if row.get("sourceTable") != "landblock_instance":
            stats["skipped_non_instance"] += 1
            continue
        if row.get("classIdSpace") != "wcid":
            stats["skipped_non_wcid"] += 1
            continue
        if not interior_only(row):
            stats["skipped_non_interior"] += 1
            continue
        if row.get("guid") is None:
            stats["skipped_no_guid"] += 1
            continue

        stats["interior_rows"] += 1
        raw_rows_by_guid[int(row["guid"])] = row
        if idx % 100000 == 0:
            print(f"  Raw rows scanned: {idx:,}  interior objects kept: {len(raw_rows_by_guid):,}")

    support_cache: dict[int, tuple[str | None, float, str, dict | None, dict | None]] = {}
    prop_cache: dict[int, tuple[str | None, float, str, dict | None, dict | None]] = {}
    supports_by_scene: dict[tuple[int, int, str, int | None], list[tuple[int, dict, str | None, float, str, dict | None, dict | None]]] = {}

    for idx, (guid, row) in enumerate(raw_rows_by_guid.items(), start=1):
        wcid = int(row.get("wcid") or row.get("classId") or 0)
        grounding_row = grounding_by_wcid.get(wcid)
        canonical_entry = canonical_by_wcid.get(wcid)

        support_class, support_conf, support_mode = classify_support(row, grounding_row, canonical_entry)
        prop_class, prop_conf, prop_mode = classify_prop(row, grounding_row, canonical_entry)
        support_cache[guid] = (support_class, support_conf, support_mode, grounding_row, canonical_entry)
        prop_cache[guid] = (prop_class, prop_conf, prop_mode, grounding_row, canonical_entry)
        scene_key = build_scene_key(row)
        supports_by_scene.setdefault(scene_key, []).append(
            (guid, row, support_class, support_conf, support_mode, grounding_row, canonical_entry)
        )

        cell_num = parse_hexish(row.get("cellId"))
        cell_info = cells_by_lb_cell.get((int(row["landblockX"]), int(row["landblockY"]), cell_num or -1))
        component_info = component_by_id.get(int(row["envCellComponentId"])) if row.get("envCellComponentId") is not None else None

        if support_class is not None:
            support_rows.append(
                build_support_object_row(
                    row,
                    support_class,
                    support_conf,
                    support_mode,
                    grounding_row,
                    component_info,
                    cell_info,
                )
            )
            stats["support_objects_emitted"] += 1
            stats["support_class_counts"][support_class] += 1
            stats["support_inference_mode_counts"][support_mode] += 1
        if idx % 100000 == 0:
            print(f"  Support classification rows processed: {idx:,}")

    print("  Building static support candidates from envcell components")
    for component_info in component_by_id.values():
        pass
    for (landblock_x, landblock_y, cell_num), cell_info in cells_by_lb_cell.items():
        static_objects = cell_info.get("staticObjects") or []
        if not static_objects:
            continue
        component_info = cell_info.get("componentInfo")
        for static_idx, static_obj in enumerate(static_objects, start=1):
            if static_obj.get("classIdSpace") != "model_id":
                continue
            class_id = int(static_obj.get("classId") or 0)
            setup_name = setup_name_by_model_id.get(class_id)
            if not setup_name:
                continue
            support_class, support_conf, support_mode = classify_static_support_name(setup_name)
            if support_class is None:
                continue
            row = {
                "guid": None,
                "classIdSpace": "model_id",
                "classId": class_id,
                "wcid": None,
                "weenieType": None,
                "name": setup_name,
                "landblockId": component_info.get("landblockId") if component_info else None,
                "landblockX": landblock_x,
                "landblockY": landblock_y,
                "cellId": cell_info.get("cellNumber"),
                "envCellComponentId": component_info.get("componentId") if component_info else None,
                "envCellComponentKind": component_info.get("componentKind") if component_info else None,
                "localX": float(static_obj.get("x", 0.0)),
                "localY": float(static_obj.get("y", 0.0)),
                "z": float(static_obj.get("z", 0.0)),
                "qw": 1.0,
                "qx": 0.0,
                "qy": 0.0,
                "qz": 0.0,
            }
            scene_key = build_scene_key(row)
            supports_by_scene.setdefault(scene_key, []).append(
                (-static_idx, row, support_class, support_conf, support_mode, None, None)
            )
            support_rows.append(
                build_support_object_row(
                    row,
                    support_class,
                    support_conf,
                    support_mode,
                    None,
                    component_info,
                    cell_info,
                )
            )
            stats["support_objects_emitted"] += 1
            stats["static_support_objects_emitted"] += 1
            stats["support_class_counts"][support_class] += 1
            stats["support_inference_mode_counts"][support_mode] += 1

    for idx, (guid, row) in enumerate(raw_rows_by_guid.items(), start=1):
        prop_class, prop_conf, prop_mode, prop_grounding, _canonical_entry = prop_cache[guid]
        if prop_class is None:
            continue

        parent_guids = row.get("parentGuids") or []
        if len(parent_guids) != 1:
            continue
        parent_guid = int(parent_guids[0])
        parent_row = raw_rows_by_guid.get(parent_guid)
        if parent_row is None:
            continue

        parent_support_class, parent_support_conf, parent_support_mode, parent_grounding, _ = support_cache.get(
            parent_guid, (None, 0.0, "missing", None, None)
        )
        if parent_support_class is None:
            parent_support_class = None

        cell_num = parse_hexish(row.get("cellId"))
        cell_info = cells_by_lb_cell.get((int(row["landblockX"]), int(row["landblockY"]), cell_num or -1))
        component_info = component_by_id.get(int(row["envCellComponentId"])) if row.get("envCellComponentId") is not None else None

        if parent_support_class is not None:
            relation_valid, rejection_reason = supported_prop_relation_valid(row, parent_row)
            if relation_valid:
                prop_rows.append(
                    build_supported_prop_row(
                        row,
                        prop_class,
                        prop_conf,
                        prop_mode,
                        prop_grounding,
                        parent_row,
                        parent_support_class,
                        parent_support_conf,
                        parent_support_mode,
                        parent_grounding,
                        component_info,
                        cell_info,
                    )
                )
                stats["supported_props_emitted"] += 1
                stats["prop_class_counts"][prop_class] += 1
                stats["prop_inference_mode_counts"]["graph_link"] += 1
                if idx % 100000 == 0:
                    print(f"  Prop relation rows processed: {idx:,}  emitted: {len(prop_rows):,}")
                continue
            stats["prop_rejection_reason_counts"][rejection_reason] += 1

        scene_key = build_scene_key(row)
        review_candidate, competing_parent_count = find_geometry_support_candidate(row, supports_by_scene.get(scene_key, []))
        if review_candidate is not None:
            candidate_guid, candidate_row, candidate_support_class, candidate_support_conf, candidate_support_mode, candidate_grounding = review_candidate
            relation_confidence = min(prop_conf, candidate_support_conf) * 0.7
            review_rows.append(
                build_review_prop_candidate_row(
                    row,
                    prop_class,
                    prop_conf,
                    prop_mode,
                    prop_grounding,
                    candidate_row,
                    candidate_support_class,
                    candidate_support_conf,
                    candidate_support_mode,
                    candidate_grounding,
                    component_info,
                    cell_info,
                    relation_confidence,
                    "geometry_nearest",
                    competing_parent_count,
                )
            )
            stats["review_candidate_emitted"] += 1
            stats["review_candidate_prop_class_counts"][prop_class] += 1
            stats["review_candidate_support_class_counts"][candidate_support_class] += 1
        if idx % 100000 == 0:
            print(f"  Prop relation rows processed: {idx:,}  emitted: {len(prop_rows):,}")

    write_jsonl(args.out_support_jsonl, support_rows)
    write_jsonl(args.out_prop_jsonl, prop_rows)
    write_jsonl(args.out_review_jsonl, review_rows)

    summary = {
        "raw_jsonl": str(args.raw_jsonl),
        "component_jsonl": str(args.component_jsonl),
        "grounding_jsonl": str(args.grounding_jsonl),
        "support_output_jsonl": str(args.out_support_jsonl),
        "prop_output_jsonl": str(args.out_prop_jsonl),
        "review_output_jsonl": str(args.out_review_jsonl),
        "counts": {
            "scanned_rows": stats["scanned_rows"],
            "interior_rows": stats["interior_rows"],
            "support_objects_emitted": stats["support_objects_emitted"],
            "static_support_objects_emitted": stats["static_support_objects_emitted"],
            "supported_props_emitted": stats["supported_props_emitted"],
            "review_candidate_emitted": stats["review_candidate_emitted"],
            "skipped_non_interior": stats["skipped_non_interior"],
            "skipped_non_wcid": stats["skipped_non_wcid"],
            "skipped_non_instance": stats["skipped_non_instance"],
            "skipped_no_guid": stats["skipped_no_guid"],
        },
        "support_class_counts": dict(stats["support_class_counts"].most_common()),
        "prop_class_counts": dict(stats["prop_class_counts"].most_common()),
        "support_inference_mode_counts": dict(stats["support_inference_mode_counts"].most_common()),
        "prop_inference_mode_counts": dict(stats["prop_inference_mode_counts"].most_common()),
        "prop_rejection_reason_counts": dict(stats["prop_rejection_reason_counts"].most_common()),
        "review_candidate_prop_class_counts": dict(stats["review_candidate_prop_class_counts"].most_common()),
        "review_candidate_support_class_counts": dict(stats["review_candidate_support_class_counts"].most_common()),
        "notes": [
            "This is a first-pass high-confidence extractor.",
            "Supported-prop rows currently require exactly one direct parentGuid whose parent is support-classified.",
            "Supported-prop rows are rejected when the parent is in a different cell/component or when the prop sits below the parent plane.",
            "Review candidates are same-cell, same-component geometric nearest-support guesses and are not yet training-grade labels.",
            "Name hints are used, but hook classes are grounded directly by weenie type 56 and ACE enum-backed names.",
            "Static DAT-only support furniture is not yet promoted into supported-prop parent inference.",
        ],
    }
    args.out_summary_json.parent.mkdir(parents=True, exist_ok=True)
    with args.out_summary_json.open("w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)

    print("Support-aware interior extraction complete")
    print(f"  Support rows: {len(support_rows):,}")
    print(f"  Prop rows:    {len(prop_rows):,}")
    print(f"  Review rows:  {len(review_rows):,}")
    print(f"  Support JSONL: {args.out_support_jsonl}")
    print(f"  Prop JSONL:    {args.out_prop_jsonl}")
    print(f"  Review JSONL:  {args.out_review_jsonl}")
    print(f"  Summary JSON:  {args.out_summary_json}")


if __name__ == "__main__":
    main()

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
DEFAULT_OUT_SILVER_JSONL = REFERENCE_DIR / "interior_supported_props_silver.jsonl"
DEFAULT_OUT_SUMMARY_JSON = REFERENCE_DIR / "interior_support_dataset_highconf_summary.json"
DEFAULT_OUT_REVIEW_JSONL = REFERENCE_DIR / "interior_supported_prop_candidates_review.jsonl"
DEFAULT_OUT_CANDIDATES_JSONL = REFERENCE_DIR / "interior_supported_prop_candidates_ranked.jsonl"
DEFAULT_OUT_MOTIFS_JSONL = REFERENCE_DIR / "interior_supported_prop_motifs.jsonl"


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
    parser.add_argument("--out-silver-jsonl", type=Path, default=DEFAULT_OUT_SILVER_JSONL)
    parser.add_argument("--out-summary-json", type=Path, default=DEFAULT_OUT_SUMMARY_JSON)
    parser.add_argument("--out-review-jsonl", type=Path, default=DEFAULT_OUT_REVIEW_JSONL)
    parser.add_argument("--out-candidates-jsonl", type=Path, default=DEFAULT_OUT_CANDIDATES_JSONL)
    parser.add_argument("--out-motifs-jsonl", type=Path, default=DEFAULT_OUT_MOTIFS_JSONL)
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


def is_document_like_prop(row: dict) -> bool:
    name = (row.get("name") or row.get("className") or "").strip().lower()
    if not name:
        return False
    document_hints = (
        "book",
        "note",
        "paper",
        "parchment",
        "tome",
        "scroll",
        "journal",
        "log",
        "manual",
        "guide",
    )
    return any(name_has_hint(name, hint) or name.startswith(hint) for hint in document_hints)


def is_potion_like_prop(row: dict) -> bool:
    name = (row.get("name") or row.get("className") or "").strip().lower()
    if not name:
        return False
    potion_hints = (
        "philter",
        "potion",
        "elixir",
        "draught",
        "tonic",
        "vial",
    )
    return any(name_has_hint(name, hint) or name.startswith(hint) for hint in potion_hints)


def semantic_prop_bucket(row: dict) -> str | None:
    if is_document_like_prop(row):
        return "document_like"
    if is_potion_like_prop(row):
        return "potion_like"
    prop_class = row.get("propClass")
    if isinstance(prop_class, str) and prop_class.strip():
        return prop_class.strip()
    return None


def preferred_display_name(row: dict, grounding_row: dict | None) -> str | None:
    for value in (
        grounding_row.get("preferred_name") if grounding_row else None,
        grounding_row.get("ace_friendly_name") if grounding_row else None,
        grounding_row.get("ace_class_name") if grounding_row else None,
        row.get("name"),
        row.get("className"),
        row.get("aceFriendlyName"),
    ):
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


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


def quaternion_conjugate(qw: float, qx: float, qy: float, qz: float) -> tuple[float, float, float, float]:
    return qw, -qx, -qy, -qz


def rotate_vector_by_quaternion(
    vx: float, vy: float, vz: float, qw: float, qx: float, qy: float, qz: float
) -> tuple[float, float, float]:
    ix = qw * vx + qy * vz - qz * vy
    iy = qw * vy + qz * vx - qx * vz
    iz = qw * vz + qx * vy - qy * vx
    iw = -qx * vx - qy * vy - qz * vz
    rx = ix * qw + iw * -qx + iy * -qz - iz * -qy
    ry = iy * qw + iw * -qy + iz * -qx - ix * -qz
    rz = iz * qw + iw * -qz + ix * -qy - iy * -qx
    return rx, ry, rz


def object_local_to_cell_local(row: dict, point_local: dict | None) -> dict | None:
    if not isinstance(point_local, dict):
        return None
    px = float(point_local.get("x", 0.0))
    py = float(point_local.get("y", 0.0))
    pz = float(point_local.get("z", 0.0))
    qw = float(row.get("qw", 1.0))
    qx = float(row.get("qx", 0.0))
    qy = float(row.get("qy", 0.0))
    qz = float(row.get("qz", 0.0))
    rx, ry, rz = rotate_vector_by_quaternion(px, py, pz, qw, qx, qy, qz)
    return {
        "x": float(row.get("localX", 0.0)) + rx,
        "y": float(row.get("localY", 0.0)) + ry,
        "z": float(row.get("z", 0.0)) + rz,
    }


def cell_local_to_object_local(row: dict, point_cell: dict | None) -> dict | None:
    if not isinstance(point_cell, dict):
        return None
    dx = float(point_cell.get("x", 0.0)) - float(row.get("localX", 0.0))
    dy = float(point_cell.get("y", 0.0)) - float(row.get("localY", 0.0))
    dz = float(point_cell.get("z", 0.0)) - float(row.get("z", 0.0))
    qw = float(row.get("qw", 1.0))
    qx = float(row.get("qx", 0.0))
    qy = float(row.get("qy", 0.0))
    qz = float(row.get("qz", 0.0))
    cq_w, cq_x, cq_y, cq_z = quaternion_conjugate(qw, qx, qy, qz)
    rx, ry, rz = rotate_vector_by_quaternion(dx, dy, dz, cq_w, cq_x, cq_y, cq_z)
    return {"x": rx, "y": ry, "z": rz}


def best_support_surface_hint(row: dict) -> dict | None:
    hints = row.get("supportSurfaceHints")
    if hints is None:
        hints = (row.get("geometry") or {}).get("supportSurfaceHints")
    if isinstance(hints, dict):
        hint_list = [hints]
    elif isinstance(hints, list):
        hint_list = [hint for hint in hints if isinstance(hint, dict)]
    else:
        hint_list = []
    if not hint_list:
        return None
    top_planes = [hint for hint in hint_list if hint.get("surfaceClass") == "top_plane"]
    if top_planes:
        return top_planes[0]
    return hint_list[0]


def support_anchor_metrics(prop_row: dict, support_row: dict) -> dict:
    prop_point = {
        "x": float(prop_row.get("localX", 0.0)),
        "y": float(prop_row.get("localY", 0.0)),
        "z": float(prop_row.get("z", 0.0)),
    }
    anchor = {
        "x": float(support_row.get("localX", 0.0)),
        "y": float(support_row.get("localY", 0.0)),
        "z": float(support_row.get("z", 0.0)),
    }
    support_surface_hint = best_support_surface_hint(support_row)
    if support_surface_hint is not None:
        surface_origin = object_local_to_cell_local(support_row, support_surface_hint.get("originLocal"))
        if surface_origin is not None:
            anchor = surface_origin

    dx = prop_point["x"] - anchor["x"]
    dy = prop_point["y"] - anchor["y"]
    dz = prop_point["z"] - anchor["z"]
    horiz = math.hypot(dx, dy)
    metrics = {
        "anchorX": anchor["x"],
        "anchorY": anchor["y"],
        "anchorZ": anchor["z"],
        "horizontalDistance": horiz,
        "heightAboveSupportPlane": dz,
        "hasSurfaceHint": support_surface_hint is not None,
        "withinSurfaceFootprint": False,
        "surfaceFootprintOverflow": None,
    }

    if support_surface_hint is None:
        return metrics

    prop_local = cell_local_to_object_local(support_row, prop_point)
    origin_local = support_surface_hint.get("originLocal") or {}
    extent_local = support_surface_hint.get("extentLocal") or {}
    if prop_local is None:
        return metrics

    # Terminal-side supportSurfaceHints already emit half-extents for the top plane.
    half_x = max(float(extent_local.get("x", 0.0)), 0.0)
    half_y = max(float(extent_local.get("y", 0.0)), 0.0)
    rel_x = float(prop_local["x"]) - float(origin_local.get("x", 0.0))
    rel_y = float(prop_local["y"]) - float(origin_local.get("y", 0.0))
    overflow_x = max(abs(rel_x) - half_x, 0.0)
    overflow_y = max(abs(rel_y) - half_y, 0.0)
    overflow = math.hypot(overflow_x, overflow_y)
    metrics["withinSurfaceFootprint"] = overflow <= 0.15
    metrics["surfaceFootprintOverflow"] = overflow
    return metrics


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
            "aabbLocal": row.get("aabbLocal"),
            "supportSurfaceHints": row.get("supportSurfaceHints"),
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
    support_metrics = support_anchor_metrics(row, parent_row)

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
            "name": preferred_display_name(row, prop_grounding),
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
            "heightAboveSupportPlane": round(float(support_metrics["heightAboveSupportPlane"]), 4),
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
    support_metrics = support_anchor_metrics(row, parent_row)
    horiz = float(support_metrics["horizontalDistance"])
    base["validation"]["competingParentCount"] = competing_parent_count
    base["validation"]["verticalOffsetOk"] = float(support_metrics["heightAboveSupportPlane"]) >= -0.25
    base["validation"]["horizontalDistance"] = round(horiz, 4)
    base["validation"]["heightAboveSupportPlane"] = round(float(support_metrics["heightAboveSupportPlane"]), 4)
    base["validation"]["hasSurfaceHint"] = bool(support_metrics["hasSurfaceHint"])
    base["validation"]["withinSurfaceFootprint"] = bool(support_metrics["withinSurfaceFootprint"])
    if support_metrics["surfaceFootprintOverflow"] is not None:
        base["validation"]["surfaceFootprintOverflow"] = round(float(support_metrics["surfaceFootprintOverflow"]), 4)
    base["validation"]["reviewOnly"] = True
    return base


def classify_candidate_tier(
    prop_row: dict,
    support_class: str,
    support_name: str,
    support_mode: str,
    horizontal_distance: float,
    dz: float,
    competing_parent_count: int,
    candidate_score: float,
) -> tuple[str, bool]:
    furniture_like = support_class in {"table_like", "desk_like", "altar_like", "shelf_like"}
    if furniture_like and support_mode == "static_setup_name":
        if horizontal_distance <= 0.9 and 0.0 <= dz <= 0.35 and competing_parent_count == 0 and candidate_score >= 0.72:
            return "silver_static", True
        if (
            support_class == "shelf_like"
            and support_name.strip().lower() == "bookcase"
            and is_document_like_prop(prop_row)
            and horizontal_distance <= 1.3
            and 0.0 <= dz <= 0.18
            and competing_parent_count <= 1
            and candidate_score >= 0.9
        ):
            return "silver_static", True
        if horizontal_distance <= 1.35 and 0.0 <= dz <= 0.5 and competing_parent_count <= 1 and candidate_score >= 0.58:
            return "bronze_static", False
    if support_class == "container_top":
        if horizontal_distance <= 0.9 and 0.0 <= dz <= 0.2 and competing_parent_count == 0 and candidate_score >= 0.62:
            return "bronze_container", False
    return "review_only", False


def build_ranked_candidate_row(
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
    row_out = build_review_prop_candidate_row(
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
        relation_confidence,
        relation_mode,
        competing_parent_count,
    )
    return row_out


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
        metrics = support_anchor_metrics(row, support_row)
        dz = float(metrics["heightAboveSupportPlane"])
        if dz < -0.25 or dz > 1.5:
            continue
        horiz = float(metrics["horizontalDistance"])
        if horiz > 1.5 and not metrics["withinSurfaceFootprint"]:
            continue

        score = horiz + dz * 0.25
        if support_class == "container_top":
            score += 1.0
        elif support_class in {"table_like", "desk_like", "altar_like", "shelf_like"}:
            score -= 0.25
        if metrics["hasSurfaceHint"]:
            score -= 0.18
        if metrics["withinSurfaceFootprint"]:
            score -= 0.22
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


def rank_support_candidates(
    row: dict,
    support_candidates: list[tuple[int, dict, str | None, float, str, dict | None, dict | None]],
    top_k: int = 3,
) -> list[dict]:
    ranked: list[dict] = []

    for support_guid, support_row, support_class, support_conf, support_mode, support_grounding, _canonical_entry in support_candidates:
        if support_class is None or support_guid == int(row.get("guid") or -1):
            continue
        support_name = normalized_name(support_row, support_grounding, None)
        if support_class == "container_top" and is_loot_container_name(support_name):
            continue
        metrics = support_anchor_metrics(row, support_row)
        dz = float(metrics["heightAboveSupportPlane"])
        if dz < -0.25 or dz > 1.75:
            continue
        horiz = float(metrics["horizontalDistance"])
        if horiz > 2.5 and not metrics["withinSurfaceFootprint"]:
            continue

        score = support_conf
        score += max(0.0, 1.25 - horiz) * 0.22
        score += max(0.0, 0.5 - abs(dz - 0.12)) * 0.18
        if support_mode == "static_setup_name":
            score += 0.08
        if support_class in {"table_like", "desk_like", "altar_like"}:
            score += 0.06
        elif support_class == "shelf_like":
            score += 0.05
        elif support_class == "container_top":
            score -= 0.12
        if support_class == "bed_like":
            score -= 0.08
        if metrics["hasSurfaceHint"]:
            score += 0.08
        if metrics["withinSurfaceFootprint"]:
            score += 0.14
        overflow = metrics["surfaceFootprintOverflow"]
        if overflow is not None:
            score -= min(float(overflow), 1.5) * 0.1

        ranked.append(
            {
                "score": score,
                "horizontalDistance": horiz,
                "dz": dz,
                "hasSurfaceHint": bool(metrics["hasSurfaceHint"]),
                "withinSurfaceFootprint": bool(metrics["withinSurfaceFootprint"]),
                "surfaceFootprintOverflow": metrics["surfaceFootprintOverflow"],
                "support_guid": support_guid,
                "support_row": support_row,
                "support_class": support_class,
                "support_conf": support_conf,
                "support_mode": support_mode,
                "support_grounding": support_grounding,
            }
        )

    ranked.sort(key=lambda item: (-item["score"], item["horizontalDistance"], abs(item["dz"])))
    return ranked[:top_k]


def quantize_value(value: float, step: float) -> float:
    return round(round(value / step) * step, 3)


def median_value(values: list[float]) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    mid = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0


def build_semantic_support_priors(candidate_rows: list[dict]) -> dict[tuple, dict]:
    buckets: dict[tuple, list[dict]] = {}
    for row in candidate_rows:
        support_parent = row.get("supportParent") or {}
        support_relation = row.get("supportRelation") or {}
        validation = row.get("validation") or {}
        if support_relation.get("candidateRank") != 1:
            continue
        if support_parent.get("classIdSpace") != "model_id":
            continue
        if support_parent.get("supportInferenceMode") != "static_setup_name":
            continue
        if not validation.get("sameCell", True):
            continue
        semantic_bucket = semantic_prop_bucket(row.get("prop") or {})
        if semantic_bucket is None:
            continue
        key = (
            support_parent.get("classIdSpace"),
            support_parent.get("classId"),
            support_parent.get("supportClass"),
            semantic_bucket,
        )
        buckets.setdefault(key, []).append(row)

    priors: dict[tuple, dict] = {}
    for key, rows in buckets.items():
        if len(rows) < 3:
            continue
        horizontal_distances = [float(row["validation"]["horizontalDistance"]) for row in rows]
        heights = [float(row["supportRelation"]["heightAboveSupportPlane"]) for row in rows]
        priors[key] = {
            "count": len(rows),
            "medianHorizontalDistance": round(median_value(horizontal_distances), 4),
            "medianHeightAboveSupportPlane": round(median_value(heights), 4),
            "minHeightAboveSupportPlane": round(min(heights), 4),
            "maxHeightAboveSupportPlane": round(max(heights), 4),
            "supportName": rows[0]["supportParent"].get("name"),
            "examplePropNames": [row["prop"].get("name") for row in rows[:5]],
        }
    return priors


def apply_semantic_support_priors(candidate_rows: list[dict], semantic_support_priors: dict[tuple, dict]) -> int:
    promoted_count = 0
    for row in candidate_rows:
        support_parent = row.get("supportParent") or {}
        support_relation = row.get("supportRelation") or {}
        validation = row.get("validation") or {}
        if validation.get("promotionEligible"):
            continue
        if support_relation.get("candidateRank") != 1:
            continue
        semantic_bucket = semantic_prop_bucket(row.get("prop") or {})
        key = (
            support_parent.get("classIdSpace"),
            support_parent.get("classId"),
            support_parent.get("supportClass"),
            semantic_bucket,
        )
        prior = semantic_support_priors.get(key)
        if prior is None:
            continue

        support_class = support_parent.get("supportClass")
        horizontal_distance = float(validation.get("horizontalDistance", 0.0))
        height_above_support = float(support_relation.get("heightAboveSupportPlane", 0.0))
        competing_parent_count = int(validation.get("competingParentCount", 0) or 0)
        if (
            support_class == "shelf_like"
            and semantic_bucket == "document_like"
            and prior["count"] >= 5
            and competing_parent_count == 0
            and 0.0 <= height_above_support <= 0.12
            and horizontal_distance <= 1.6
        ):
            support_relation["candidateTier"] = "silver_static"
            support_relation["semanticPriorKey"] = {
                "supportClassIdSpace": key[0],
                "supportClassId": key[1],
                "supportClass": key[2],
                "propSemanticBucket": key[3],
            }
            validation["promotionEligible"] = True
            promoted_count += 1
    return promoted_count


def build_candidate_motif_rows(candidate_rows: list[dict]) -> list[dict]:
    buckets: dict[tuple, list[dict]] = {}
    for row in candidate_rows:
        rel = row["supportRelation"]["relativePosition"]
        key = (
            row["supportParent"]["classIdSpace"],
            row["supportParent"]["classId"],
            row["supportParent"]["supportClass"],
            row["prop"]["propClass"],
            quantize_value(float(rel["x"]), 0.5),
            quantize_value(float(rel["y"]), 0.5),
            quantize_value(float(rel["z"]), 0.15),
            quantize_value(float(row["supportRelation"]["relativeYawDeg"]), 30.0),
        )
        buckets.setdefault(key, []).append(row)

    motif_rows: list[dict] = []
    for key, rows in buckets.items():
        if len(rows) < 2:
            continue
        support_space, support_class_id, support_class, prop_class, qx, qy, qz, qyaw = key
        top_tiers = Counter(row["supportRelation"].get("candidateTier", "unknown") for row in rows)
        motif_rows.append(
            {
                "motifKey": {
                    "supportClassIdSpace": support_space,
                    "supportClassId": support_class_id,
                    "supportClass": support_class,
                    "propClass": prop_class,
                    "relativePositionBucket": {"x": qx, "y": qy, "z": qz},
                    "relativeYawBucket": qyaw,
                },
                "count": len(rows),
                "candidateTierCounts": dict(top_tiers.most_common()),
                "exampleSceneIds": [row["sceneId"] for row in rows[:5]],
                "supportName": rows[0]["supportParent"].get("name"),
                "examplePropName": rows[0]["prop"].get("name"),
                "promotionEligibleCount": sum(1 for row in rows if row["validation"].get("promotionEligible")),
            }
        )

    motif_rows.sort(key=lambda row: (-row["count"], -row["promotionEligibleCount"], row["motifKey"]["supportClass"]))
    return motif_rows


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
    silver_rows: list[dict] = []
    review_rows: list[dict] = []
    candidate_rows: list[dict] = []
    motif_rows: list[dict] = []

    stats = {
        "scanned_rows": 0,
        "interior_rows": 0,
        "support_objects_emitted": 0,
        "supported_props_emitted": 0,
        "silver_props_emitted": 0,
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
        "candidate_rows_emitted": 0,
        "review_candidate_support_class_counts": Counter(),
        "review_candidate_prop_class_counts": Counter(),
        "candidate_tier_counts": Counter(),
        "motif_rows_emitted": 0,
        "static_support_objects_emitted": 0,
        "semantic_support_prior_counts": {},
        "semantic_support_prior_promotions": 0,
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
                "qw": float(static_obj.get("qw", 1.0)),
                "qx": float(static_obj.get("qx", 0.0)),
                "qy": float(static_obj.get("qy", 0.0)),
                "qz": float(static_obj.get("qz", 0.0)),
                "yawDeg": static_obj.get("yawDeg"),
                "aabbLocal": static_obj.get("aabbLocal"),
                "supportSurfaceHints": static_obj.get("supportSurfaceHints"),
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

        cell_num = parse_hexish(row.get("cellId"))
        cell_info = cells_by_lb_cell.get((int(row["landblockX"]), int(row["landblockY"]), cell_num or -1))
        component_info = component_by_id.get(int(row["envCellComponentId"])) if row.get("envCellComponentId") is not None else None

        parent_row = None
        parent_support_class = None
        parent_support_conf = 0.0
        parent_support_mode = "missing"
        parent_grounding = None
        parent_guids = row.get("parentGuids") or []
        if len(parent_guids) == 1:
            parent_guid = int(parent_guids[0])
            parent_row = raw_rows_by_guid.get(parent_guid)
            if parent_row is not None:
                parent_support_class, parent_support_conf, parent_support_mode, parent_grounding, _ = support_cache.get(
                    parent_guid, (None, 0.0, "missing", None, None)
                )

        if parent_row is not None and parent_support_class is not None:
            relation_valid, rejection_reason = supported_prop_relation_valid(row, parent_row)
            if relation_valid:
                promoted_row = build_supported_prop_row(
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
                promoted_row["supportRelation"]["candidateTier"] = "gold_graph"
                promoted_row["supportRelation"]["candidateRank"] = 1
                promoted_row["supportRelation"]["candidateScore"] = round(min(prop_conf, parent_support_conf), 4)
                promoted_row["validation"]["promotionEligible"] = True
                prop_rows.append(promoted_row)
                candidate_rows.append(promoted_row)
                stats["supported_props_emitted"] += 1
                stats["candidate_rows_emitted"] += 1
                stats["candidate_tier_counts"]["gold_graph"] += 1
                stats["prop_class_counts"][prop_class] += 1
                stats["prop_inference_mode_counts"]["graph_link"] += 1
                if idx % 100000 == 0:
                    print(f"  Prop relation rows processed: {idx:,}  emitted: {len(prop_rows):,}")
                continue
            stats["prop_rejection_reason_counts"][rejection_reason] += 1

        scene_key = build_scene_key(row)
        ranked_candidates = rank_support_candidates(row, supports_by_scene.get(scene_key, []), top_k=3)
        if ranked_candidates:
            top_score = ranked_candidates[0]["score"]
            second_score = ranked_candidates[1]["score"] if len(ranked_candidates) > 1 else None
            for candidate_rank, candidate in enumerate(ranked_candidates, start=1):
                competing_parent_count = max(len(ranked_candidates) - 1, 0)
                if second_score is not None and candidate_rank == 1 and second_score >= top_score - 0.03:
                    competing_parent_count = max(competing_parent_count, 1)
                prop_name_for_tier = (
                    (prop_grounding.get("preferred_name") if prop_grounding else None)
                    or row.get("name")
                    or row.get("className")
                    or row.get("aceFriendlyName")
                )
                candidate_tier, promotion_eligible = classify_candidate_tier(
                    {"name": prop_name_for_tier, "className": row.get("className")},
                    candidate["support_class"],
                    candidate["support_row"].get("name") or candidate["support_row"].get("className") or "",
                    candidate["support_mode"],
                    candidate["horizontalDistance"],
                    candidate["dz"],
                    competing_parent_count,
                    candidate["score"],
                )
                relation_confidence = min(prop_conf, candidate["support_conf"]) * 0.7
                candidate_row = build_ranked_candidate_row(
                    row,
                    prop_class,
                    prop_conf,
                    prop_mode,
                    prop_grounding,
                    candidate["support_row"],
                    candidate["support_class"],
                    candidate["support_conf"],
                    candidate["support_mode"],
                    candidate["support_grounding"],
                    component_info,
                    cell_info,
                    relation_confidence,
                    "geometry_nearest",
                    competing_parent_count,
                )
                candidate_row["supportRelation"]["candidateRank"] = candidate_rank
                candidate_row["supportRelation"]["candidateScore"] = round(candidate["score"], 4)
                candidate_row["supportRelation"]["candidateTier"] = candidate_tier
                candidate_row["validation"]["hasSurfaceHint"] = candidate["hasSurfaceHint"]
                candidate_row["validation"]["withinSurfaceFootprint"] = candidate["withinSurfaceFootprint"]
                if candidate["surfaceFootprintOverflow"] is not None:
                    candidate_row["validation"]["surfaceFootprintOverflow"] = round(
                        float(candidate["surfaceFootprintOverflow"]), 4
                    )
                candidate_row["validation"]["promotionEligible"] = promotion_eligible
                candidate_rows.append(candidate_row)
                stats["candidate_rows_emitted"] += 1
                stats["candidate_tier_counts"][candidate_tier] += 1
        if idx % 100000 == 0:
            print(f"  Prop relation rows processed: {idx:,}  emitted: {len(prop_rows):,}")

    semantic_support_priors = build_semantic_support_priors(candidate_rows)
    stats["semantic_support_prior_counts"] = {
        f"{key[0]}:{key[1]}:{key[2]}:{key[3]}": prior["count"] for key, prior in semantic_support_priors.items()
    }
    stats["semantic_support_prior_promotions"] = apply_semantic_support_priors(candidate_rows, semantic_support_priors)
    silver_rows = [
        row
        for row in candidate_rows
        if row.get("supportRelation", {}).get("kind") == "geometry_candidate"
        and row.get("supportRelation", {}).get("candidateTier") == "silver_static"
        and row.get("validation", {}).get("promotionEligible")
    ]
    review_rows = [row for row in candidate_rows if row.get("supportRelation", {}).get("candidateRank") == 1]
    stats["silver_props_emitted"] = len(silver_rows)
    stats["review_candidate_emitted"] = len(review_rows)
    stats["candidate_rows_emitted"] = len(candidate_rows)
    stats["candidate_tier_counts"] = Counter(
        row.get("supportRelation", {}).get("candidateTier", "unknown") for row in candidate_rows
    )
    stats["review_candidate_prop_class_counts"] = Counter(
        row.get("prop", {}).get("propClass") for row in review_rows if row.get("prop", {}).get("propClass")
    )
    stats["review_candidate_support_class_counts"] = Counter(
        row.get("supportParent", {}).get("supportClass")
        for row in review_rows
        if row.get("supportParent", {}).get("supportClass")
    )

    write_jsonl(args.out_support_jsonl, support_rows)
    write_jsonl(args.out_prop_jsonl, prop_rows)
    write_jsonl(args.out_silver_jsonl, silver_rows)
    write_jsonl(args.out_review_jsonl, review_rows)
    write_jsonl(args.out_candidates_jsonl, candidate_rows)
    motif_rows = build_candidate_motif_rows(candidate_rows)
    write_jsonl(args.out_motifs_jsonl, motif_rows)
    stats["motif_rows_emitted"] = len(motif_rows)

    summary = {
        "raw_jsonl": str(args.raw_jsonl),
        "component_jsonl": str(args.component_jsonl),
        "grounding_jsonl": str(args.grounding_jsonl),
        "support_output_jsonl": str(args.out_support_jsonl),
        "gold_output_jsonl": str(args.out_prop_jsonl),
        "silver_output_jsonl": str(args.out_silver_jsonl),
        "review_output_jsonl": str(args.out_review_jsonl),
        "candidates_output_jsonl": str(args.out_candidates_jsonl),
        "motifs_output_jsonl": str(args.out_motifs_jsonl),
        "counts": {
            "scanned_rows": stats["scanned_rows"],
            "interior_rows": stats["interior_rows"],
            "support_objects_emitted": stats["support_objects_emitted"],
            "static_support_objects_emitted": stats["static_support_objects_emitted"],
            "gold_props_emitted": stats["supported_props_emitted"],
            "silver_props_emitted": stats["silver_props_emitted"],
            "review_candidate_emitted": stats["review_candidate_emitted"],
            "candidate_rows_emitted": stats["candidate_rows_emitted"],
            "motif_rows_emitted": stats["motif_rows_emitted"],
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
        "candidate_tier_counts": dict(stats["candidate_tier_counts"].most_common()),
        "review_candidate_prop_class_counts": dict(stats["review_candidate_prop_class_counts"].most_common()),
        "review_candidate_support_class_counts": dict(stats["review_candidate_support_class_counts"].most_common()),
        "semantic_support_prior_counts": stats["semantic_support_prior_counts"],
        "semantic_support_prior_promotions": stats["semantic_support_prior_promotions"],
        "notes": [
            "This is a first-pass high-confidence extractor.",
            "Supported-prop rows currently require a direct parentGuid with valid same-cell/component geometry.",
            "Ranked candidate rows provide weak-supervision tiers instead of collapsing ambiguous props into one guessed parent.",
            "Supported-prop rows are rejected when the parent is in a different cell/component or when the prop sits below the parent plane.",
            "Review candidates are same-cell, same-component geometric nearest-support guesses and are not yet training-grade labels.",
            "Name hints are used, but hook classes are grounded directly by weenie type 56 and ACE enum-backed names.",
            "Static DAT-only support furniture participates in weak parent inference, but only repeated semantic priors can promote geometric candidates into silver labels.",
        ],
    }
    args.out_summary_json.parent.mkdir(parents=True, exist_ok=True)
    with args.out_summary_json.open("w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)

    print("Support-aware interior extraction complete")
    print(f"  Support rows: {len(support_rows):,}")
    print(f"  Gold rows:    {len(prop_rows):,}")
    print(f"  Silver rows:  {len(silver_rows):,}")
    print(f"  Review rows:  {len(review_rows):,}")
    print(f"  Candidate rows: {len(candidate_rows):,}")
    print(f"  Motif rows:   {len(motif_rows):,}")
    print(f"  Support JSONL: {args.out_support_jsonl}")
    print(f"  Gold JSONL:    {args.out_prop_jsonl}")
    print(f"  Silver JSONL:  {args.out_silver_jsonl}")
    print(f"  Review JSONL:  {args.out_review_jsonl}")
    print(f"  Candidates JSONL: {args.out_candidates_jsonl}")
    print(f"  Motifs JSONL:  {args.out_motifs_jsonl}")
    print(f"  Summary JSON:  {args.out_summary_json}")


if __name__ == "__main__":
    main()

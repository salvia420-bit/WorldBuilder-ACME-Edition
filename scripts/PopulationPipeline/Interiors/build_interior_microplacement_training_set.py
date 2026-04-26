#!/usr/bin/env python3
"""
Build a weighted interior micro-placement training set from support-aware labels.

This stage is intentionally simple: it merges the currently available tiered
label outputs (gold / bootstrap / silver / bronze), flattens the fields that
matter for training, and assigns a per-example evidence weight so weaker
geometry-only rows can still participate without pretending they are perfect.
"""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
REFERENCE_DIR = ROOT / "pipeline_data" / "reference"
DEFAULT_LSD_PARTIAL_DIR = ROOT / "external" / "LSD-Partial-2025-02-23_16-15" / "weenies"
DEFAULT_COMPONENT_JSONL = REFERENCE_DIR / "envcell_components_full.jsonl"
DEFAULT_SUPPORT_OBJECTS_JSONL = REFERENCE_DIR / "fullworld_interior_support_objects_highconf_v3.jsonl"
DEFAULT_INTERIOR_CELL_SIZE = 24.0

DEFAULT_GOLD_JSONL = REFERENCE_DIR / "town_interior_supported_props_highconf.jsonl"
DEFAULT_BOOTSTRAP_JSONL = REFERENCE_DIR / "interior_supported_props_bootstrap.jsonl"
DEFAULT_SILVER_JSONL = REFERENCE_DIR / "town_interior_supported_props_silver.jsonl"
DEFAULT_BRONZE_JSONL = REFERENCE_DIR / "town_interior_supported_props_bronze.jsonl"
DEFAULT_OUT_JSONL = REFERENCE_DIR / "town_interior_microplacement_training.jsonl"
DEFAULT_OUT_SUMMARY_JSON = REFERENCE_DIR / "town_interior_microplacement_training_summary.json"

DEFAULT_TIER_WEIGHTS = {
    "gold_graph": 1.0,
    "bootstrap_reviewed": 1.0,
    "silver_static": 0.75,
    "bronze_static": 0.35,
    "bronze_container": 0.3,
}
MAX_SIBLING_CONTEXT_ITEMS = 8


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a weighted interior micro-placement training set.")
    parser.add_argument("--gold-jsonl", type=Path, default=DEFAULT_GOLD_JSONL)
    parser.add_argument("--bootstrap-jsonl", type=Path, default=DEFAULT_BOOTSTRAP_JSONL)
    parser.add_argument("--silver-jsonl", type=Path, default=DEFAULT_SILVER_JSONL)
    parser.add_argument("--bronze-jsonl", type=Path, default=DEFAULT_BRONZE_JSONL)
    parser.add_argument("--component-jsonl", type=Path, default=DEFAULT_COMPONENT_JSONL)
    parser.add_argument("--support-objects-jsonl", type=Path, default=DEFAULT_SUPPORT_OBJECTS_JSONL)
    parser.add_argument("--lsd-partial-weenies-dir", type=Path, default=DEFAULT_LSD_PARTIAL_DIR)
    parser.add_argument("--out-jsonl", type=Path, default=DEFAULT_OUT_JSONL)
    parser.add_argument("--out-summary-json", type=Path, default=DEFAULT_OUT_SUMMARY_JSON)
    parser.add_argument("--include-bronze", action="store_true", help="Include bronze rows in the emitted training set.")
    parser.add_argument(
        "--min-weight",
        type=float,
        default=0.0,
        help="Drop rows whose computed evidence weight is below this threshold.",
    )
    parser.add_argument(
        "--require-within-footprint",
        action="store_true",
        help="Keep only rows that fit within the inferred support footprint.",
    )
    parser.add_argument(
        "--max-horizontal-distance",
        type=float,
        default=None,
        help="Keep only rows whose support horizontal distance is at or below this threshold.",
    )
    parser.add_argument(
        "--max-abs-height-above-support",
        type=float,
        default=None,
        help="Keep only rows whose absolute heightAboveSupportPlane is at or below this threshold.",
    )
    parser.add_argument(
        "--max-competing-parents",
        type=int,
        default=None,
        help="Keep only rows whose competingParentCount is at or below this threshold.",
    )
    parser.add_argument(
        "--exclude-landblock-id",
        action="append",
        default=[],
        help="Exclude rows from the given landblock id, e.g. 0x934B. Repeatable.",
    )
    parser.add_argument(
        "--exclude-anchor-model-id",
        action="append",
        default=[],
        help="Exclude rows whose component anchor model_id matches this value. Repeatable.",
    )
    return parser.parse_args()


def iter_jsonl(path: Path):
    if not path.exists():
        return
    with path.open("r", encoding="utf-8-sig") as handle:
        for line in handle:
            line = line.strip()
            if line:
                yield json.loads(line)


def parse_hexish(value) -> int | None:
    if value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.startswith("0x"):
        return int(value, 16)
    return int(value)


def load_component_anchor_models(path: Path) -> dict[int, int | None]:
    component_anchor = {}
    if not path.exists():
        return component_anchor
    for row in iter_jsonl(path):
        component_id = int(row["componentId"])
        anchor = row.get("anchor") or {}
        class_space = anchor.get("classIdSpace")
        class_id = anchor.get("classId")
        component_anchor[component_id] = int(class_id) if class_space == "model_id" and class_id is not None else None
    return component_anchor


def load_component_cells(path: Path) -> dict[tuple[int, str], dict]:
    cells = {}
    if not path.exists():
        return cells
    for row in iter_jsonl(path):
        component_id = int(row["componentId"])
        for cell in row.get("cells", []):
            cell_id = str(cell.get("cellNumber") or cell.get("cellId") or "").strip()
            if not cell_id:
                continue
            cells[(component_id, cell_id)] = {
                "x": float(cell.get("x", 0.0)),
                "y": float(cell.get("y", 0.0)),
                "z": float(cell.get("z", 0.0)),
                "qw": float(cell.get("qw", 1.0)),
                "qx": float(cell.get("qx", 0.0)),
                "qy": float(cell.get("qy", 0.0)),
                "qz": float(cell.get("qz", 0.0)),
            }
    return cells


def load_hook_type_index(weenies_dir: Path) -> dict[int, int]:
    hook_types: dict[int, int] = {}
    if not weenies_dir.exists():
        return hook_types
    for path in weenies_dir.glob("*.json"):
        try:
            row = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            continue
        wcid = row.get("wcid")
        if wcid is None:
            continue
        for stat in row.get("intStats") or []:
            if not isinstance(stat, dict):
                continue
            if int(stat.get("key", -1)) == 151:
                hook_types[int(wcid)] = int(stat.get("value", 0) or 0)
                break
    return hook_types


def quaternion_conjugate(qw: float, qx: float, qy: float, qz: float) -> tuple[float, float, float, float]:
    return (qw, -qx, -qy, -qz)


def rotate_vector_by_quaternion(px: float, py: float, pz: float, qw: float, qx: float, qy: float, qz: float):
    ix = qw * px + qy * pz - qz * py
    iy = qw * py + qz * px - qx * pz
    iz = qw * pz + qx * py - qy * px
    iw = -qx * px - qy * py - qz * pz
    rx = ix * qw + iw * -qx + iy * -qz - iz * -qy
    ry = iy * qw + iw * -qy + iz * -qx - ix * -qz
    rz = iz * qw + iw * -qz + ix * -qy - iy * -qx
    return rx, ry, rz


def cell_local_to_room_local(cell: dict, point_local: dict) -> dict:
    dx = float(point_local.get("x", 0.0)) - float(cell.get("x", 0.0))
    dy = float(point_local.get("y", 0.0)) - float(cell.get("y", 0.0))
    dz = float(point_local.get("z", 0.0)) - float(cell.get("z", 0.0))
    qw = float(cell.get("qw", 1.0))
    qx = float(cell.get("qx", 0.0))
    qy = float(cell.get("qy", 0.0))
    qz = float(cell.get("qz", 0.0))
    cq_w, cq_x, cq_y, cq_z = quaternion_conjugate(qw, qx, qy, qz)
    rx, ry, rz = rotate_vector_by_quaternion(dx, dy, dz, cq_w, cq_x, cq_y, cq_z)
    return {"x": rx, "y": ry, "z": rz}


def object_local_to_cell_local(row: dict, point_object: dict | None) -> dict | None:
    if not isinstance(point_object, dict):
        return None
    px = float(point_object.get("x", 0.0))
    py = float(point_object.get("y", 0.0))
    pz = float(point_object.get("z", 0.0))
    qw = float(((row.get("object") or {}).get("rotation") or {}).get("qw", 1.0))
    qx = float(((row.get("object") or {}).get("rotation") or {}).get("qx", 0.0))
    qy = float(((row.get("object") or {}).get("rotation") or {}).get("qy", 0.0))
    qz = float(((row.get("object") or {}).get("rotation") or {}).get("qz", 0.0))
    rx, ry, rz = rotate_vector_by_quaternion(px, py, pz, qw, qx, qy, qz)
    pos = ((row.get("object") or {}).get("positionLocal") or {})
    return {
        "x": float(pos.get("x", 0.0)) + rx,
        "y": float(pos.get("y", 0.0)) + ry,
        "z": float(pos.get("z", 0.0)) + rz,
    }


def best_support_surface_hint_from_support_row(row: dict) -> dict | None:
    geom = row.get("geometry") or {}
    hints = geom.get("supportSurfaceHints")
    if isinstance(hints, dict):
        hint_list = [hints]
    elif isinstance(hints, list):
        hint_list = [hint for hint in hints if isinstance(hint, dict)]
    else:
        hint_list = []
    if not hint_list:
        return None
    top_planes = [hint for hint in hint_list if hint.get("surfaceClass") == "top_plane"]
    return top_planes[0] if top_planes else hint_list[0]


def support_anchor_from_support_row(row: dict) -> dict:
    pos = ((row.get("object") or {}).get("positionLocal") or {})
    anchor = {"x": float(pos.get("x", 0.0)), "y": float(pos.get("y", 0.0)), "z": float(pos.get("z", 0.0))}
    hint = best_support_surface_hint_from_support_row(row)
    if hint is not None:
        surface_origin = object_local_to_cell_local(row, hint.get("originLocal"))
        if surface_origin is not None:
            anchor = surface_origin
    return anchor


def load_support_object_index(path: Path) -> dict[tuple[str, int, str, str, int], list[dict]]:
    index: dict[tuple[str, int, str, str, int], list[dict]] = {}
    if not path.exists():
        return index
    for row in iter_jsonl(path):
        obj = row.get("object") or {}
        key = (
            str(row.get("sceneId")),
            int(row.get("componentId") or -1),
            str(row.get("cellId") or ""),
            str(obj.get("classIdSpace") or ""),
            int(obj.get("classId") or -1),
        )
        index.setdefault(key, []).append(row)
    return index


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=True) + "\n")


def review_key(row: dict) -> str:
    value = row.get("reviewKey")
    if isinstance(value, str) and value.strip():
        return value
    prop = row.get("prop") or {}
    support = row.get("supportParent") or {}
    rel = row.get("supportRelation") or {}
    return "|".join(
        [
            str(row.get("sceneId")),
            str(prop.get("guid")),
            str(rel.get("candidateRank")),
            f"{support.get('classIdSpace')}:{support.get('classId')}",
        ]
    )


def tier_rank(label_tier: str) -> int:
    ordering = {
        "bootstrap_reviewed": 5,
        "gold_graph": 4,
        "silver_static": 3,
        "bronze_static": 2,
        "bronze_container": 1,
    }
    return ordering.get(label_tier, 0)


def support_footprint_hint(row: dict) -> dict | None:
    validation = row.get("validation") or {}
    overflow = validation.get("surfaceFootprintOverflow")
    if overflow is None and not validation.get("withinSurfaceFootprint"):
        return None
    return {
        "withinSurfaceFootprint": bool(validation.get("withinSurfaceFootprint")),
        "surfaceFootprintOverflow": float(overflow or 0.0),
    }


def rounded_or_none(value, digits: int = 4):
    if value is None:
        return None
    return round(float(value), digits)


def local_position_from_prop_and_relation(prop: dict, rel_pos: dict) -> tuple[dict | None, dict | None]:
    prop_local = prop.get("positionLocal") or {}
    if not isinstance(prop_local, dict):
        return None, None
    prop_x = prop_local.get("x")
    prop_y = prop_local.get("y")
    prop_z = prop_local.get("z")
    if prop_x is None or prop_y is None or prop_z is None:
        return None, None
    support_x = float(prop_x) - float(rel_pos.get("x", 0.0))
    support_y = float(prop_y) - float(rel_pos.get("y", 0.0))
    support_z = float(prop_z) - float(rel_pos.get("z", 0.0))
    return (
        {
            "x": rounded_or_none(prop_x),
            "y": rounded_or_none(prop_y),
            "z": rounded_or_none(prop_z),
        },
        {
            "x": rounded_or_none(support_x),
            "y": rounded_or_none(support_y),
            "z": rounded_or_none(support_z),
        },
    )


def support_group_key(row: dict) -> str | None:
    support = row.get("support") or {}
    anchor = row.get("supportAnchorLocal") or {}
    if not isinstance(anchor, dict):
        return None
    if any(anchor.get(axis) is None for axis in ("x", "y", "z")):
        return None
    return "|".join(
        [
            str(row.get("sceneId")),
            str(row.get("componentId")),
            str(row.get("cellId")),
            f"{support.get('classIdSpace')}:{support.get('classId')}",
            f"{float(anchor['x']):.3f}",
            f"{float(anchor['y']):.3f}",
            f"{float(anchor['z']):.3f}",
        ]
    )


def build_cell_geometry(component_cells: dict[tuple[int, str], dict], row: dict) -> dict | None:
    component_id = row.get("componentId")
    cell_id = str(row.get("cellId") or "").strip()
    prop_local = row.get("propPositionLocal") or {}
    support_local = row.get("supportAnchorLocal") or {}
    if component_id is None or not cell_id or not isinstance(prop_local, dict) or not isinstance(support_local, dict):
        return None
    cell = component_cells.get((int(component_id), cell_id))
    if cell is None:
        return None

    def xy(cursor: dict) -> tuple[float, float]:
        return float(cursor.get("x", 0.0) or 0.0), float(cursor.get("y", 0.0) or 0.0)

    cell_x = float(cell["x"])
    cell_y = float(cell["y"])
    prop_x, prop_y = xy(prop_local)
    support_x, support_y = xy(support_local)

    prop_room = cell_local_to_room_local(cell, {"x": prop_x, "y": prop_y, "z": float((prop_local or {}).get("z", 0.0) or 0.0)})
    support_room = cell_local_to_room_local(cell, {"x": support_x, "y": support_y, "z": float((support_local or {}).get("z", 0.0) or 0.0)})

    def encode_point(room_point: dict) -> dict:
        local_x = float(room_point["x"])
        local_y = float(room_point["y"])
        dist_w = local_x
        dist_e = DEFAULT_INTERIOR_CELL_SIZE - local_x
        dist_s = local_y
        dist_n = DEFAULT_INTERIOR_CELL_SIZE - local_y
        corners = (
            (0.0, 0.0),
            (DEFAULT_INTERIOR_CELL_SIZE, 0.0),
            (0.0, DEFAULT_INTERIOR_CELL_SIZE),
            (DEFAULT_INTERIOR_CELL_SIZE, DEFAULT_INTERIOR_CELL_SIZE),
        )
        corner_dists = [((local_x - cx) ** 2 + (local_y - cy) ** 2) ** 0.5 for cx, cy in corners]
        center_x = local_x - (DEFAULT_INTERIOR_CELL_SIZE * 0.5)
        center_y = local_y - (DEFAULT_INTERIOR_CELL_SIZE * 0.5)
        return {
            "localX": rounded_or_none(local_x),
            "localY": rounded_or_none(local_y),
            "distWest": rounded_or_none(dist_w),
            "distEast": rounded_or_none(dist_e),
            "distSouth": rounded_or_none(dist_s),
            "distNorth": rounded_or_none(dist_n),
            "nearestCornerDistance": rounded_or_none(min(corner_dists)),
            "centerOffsetX": rounded_or_none(center_x),
            "centerOffsetY": rounded_or_none(center_y),
        }

    return {
        "cellOriginLocal": {
            "x": rounded_or_none(cell_x),
            "y": rounded_or_none(cell_y),
            "z": rounded_or_none(cell.get("z", 0.0)),
        },
        "cellSize": DEFAULT_INTERIOR_CELL_SIZE,
        "rotation": {
            "qw": rounded_or_none(cell.get("qw", 1.0), 6),
            "qx": rounded_or_none(cell.get("qx", 0.0), 6),
            "qy": rounded_or_none(cell.get("qy", 0.0), 6),
            "qz": rounded_or_none(cell.get("qz", 0.0), 6),
        },
        "prop": encode_point(prop_room),
        "support": encode_point(support_room),
    }


def attach_support_geometry(training_rows: list[dict], support_index: dict[tuple[str, int, str, str, int], list[dict]]) -> int:
    attached = 0
    for row in training_rows:
        support = row.get("support") or {}
        key = (
            str(row.get("sceneId")),
            int(row.get("componentId") or -1),
            str(row.get("cellId") or ""),
            str(support.get("classIdSpace") or ""),
            int(support.get("classId") or -1),
        )
        candidates = support_index.get(key) or []
        if not candidates:
            continue
        anchor = row.get("supportAnchorLocal") or {}
        target_x = float(anchor.get("x", 0.0) or 0.0)
        target_y = float(anchor.get("y", 0.0) or 0.0)
        best = None
        best_dist = None
        for candidate in candidates:
            cand_anchor = support_anchor_from_support_row(candidate)
            dist = math.hypot(float(cand_anchor["x"]) - target_x, float(cand_anchor["y"]) - target_y)
            if best_dist is None or dist < best_dist:
                best = candidate
                best_dist = dist
        if best is None:
            continue
        hint = best_support_surface_hint_from_support_row(best)
        extent_local = (hint or {}).get("extentLocal") or {}
        half_x = max(float(extent_local.get("x", 0.0) or 0.0), 0.0)
        half_y = max(float(extent_local.get("y", 0.0) or 0.0), 0.0)
        target = row.get("target") or {}
        dx = float(target.get("dx", 0.0) or 0.0)
        dy = float(target.get("dy", 0.0) or 0.0)
        row["supportGeometry"] = {
            "anchorLocal": support_anchor_from_support_row(best),
            "halfExtentX": rounded_or_none(half_x),
            "halfExtentY": rounded_or_none(half_y),
            "normalizedDx": rounded_or_none(dx / half_x) if half_x > 1e-6 else None,
            "normalizedDy": rounded_or_none(dy / half_y) if half_y > 1e-6 else None,
            "edgeDistances": {
                "west": rounded_or_none(dx + half_x) if half_x > 0 else None,
                "east": rounded_or_none(half_x - dx) if half_x > 0 else None,
                "south": rounded_or_none(dy + half_y) if half_y > 0 else None,
                "north": rounded_or_none(half_y - dy) if half_y > 0 else None,
            },
            "matchDistance": rounded_or_none(best_dist or 0.0),
            "supportName": ((best.get("object") or {}).get("name")),
        }
        attached += 1
    return attached


def training_row(row: dict, source_name: str) -> dict:
    prop = row.get("prop") or {}
    support = row.get("supportParent") or {}
    relation = row.get("supportRelation") or {}
    validation = row.get("validation") or {}
    rel_pos = relation.get("relativePosition") or {}
    tier = str(relation.get("candidateTier") or source_name)
    weight = DEFAULT_TIER_WEIGHTS.get(tier, 0.0)
    prop_local, support_anchor_local = local_position_from_prop_and_relation(prop, rel_pos)

    out = {
        "trainingKey": review_key(row),
        "labelTier": tier,
        "evidenceWeight": weight,
        "labelSource": source_name,
        "sceneId": row.get("sceneId"),
        "landblockId": row.get("landblockId"),
        "landblockX": row.get("landblockX"),
        "landblockY": row.get("landblockY"),
        "cellId": row.get("cellId"),
        "componentId": row.get("componentId"),
        "componentKind": row.get("componentKind"),
        "prop": {
            "guid": prop.get("guid"),
            "classIdSpace": prop.get("classIdSpace"),
            "classId": prop.get("classId"),
            "wcid": prop.get("wcid"),
            "name": prop.get("name"),
            "propClass": prop.get("propClass"),
            "propInferenceMode": prop.get("propInferenceMode"),
            "sourceKind": prop.get("sourceKind"),
        },
        "support": {
            "guid": support.get("guid"),
            "classIdSpace": support.get("classIdSpace"),
            "classId": support.get("classId"),
            "wcid": support.get("wcid"),
            "name": support.get("name"),
            "supportClass": support.get("supportClass"),
            "supportInferenceMode": support.get("supportInferenceMode"),
            "sourceKind": support.get("sourceKind"),
        },
        "target": {
            "dx": float(rel_pos.get("x", 0.0)),
            "dy": float(rel_pos.get("y", 0.0)),
            "dz": float(rel_pos.get("z", 0.0)),
            "relativeYawDeg": float(relation.get("relativeYawDeg", 0.0)),
            "heightAboveSupportPlane": float(relation.get("heightAboveSupportPlane", 0.0)),
        },
        "propPositionLocal": prop_local,
        "supportAnchorLocal": support_anchor_local,
        "validation": {
            "sameCell": bool(validation.get("sameCell")),
            "componentMatchesParent": bool(validation.get("componentMatchesParent")),
            "verticalOffsetOk": bool(validation.get("verticalOffsetOk")),
            "horizontalDistance": float(validation.get("horizontalDistance", 0.0)),
            "competingParentCount": int(validation.get("competingParentCount", 0) or 0),
            "hasSurfaceHint": bool(validation.get("hasSurfaceHint")),
        },
        "roomContext": row.get("roomContext") or {},
    }
    footprint = support_footprint_hint(row)
    if footprint is not None:
        out["validation"].update(footprint)
    out["supportKey"] = support_group_key(out)
    return out


def sibling_context_item(row: dict) -> dict:
    target = row.get("target") or {}
    return {
        "trainingKey": row.get("trainingKey"),
        "propClass": (row.get("prop") or {}).get("propClass"),
        "propName": (row.get("prop") or {}).get("name"),
        "sourceKind": (row.get("prop") or {}).get("sourceKind"),
        "labelTier": row.get("labelTier"),
        "evidenceWeight": float(row.get("evidenceWeight", 1.0)),
        "dx": float(target.get("dx", 0.0)),
        "dy": float(target.get("dy", 0.0)),
        "heightAboveSupportPlane": float(target.get("heightAboveSupportPlane", 0.0)),
        "relativeYawDeg": float(target.get("relativeYawDeg", 0.0)),
        "horizontalDistance": float((row.get("validation") or {}).get("horizontalDistance", 0.0)),
    }


def attach_support_context(training_rows: list[dict]) -> dict[str, int]:
    groups: dict[str, list[dict]] = {}
    for row in training_rows:
        key = row.get("supportKey")
        if not isinstance(key, str) or not key:
            continue
        groups.setdefault(key, []).append(row)

    supports_with_siblings = 0
    max_group_size = 0
    rows_with_siblings = 0
    for key, rows in groups.items():
        max_group_size = max(max_group_size, len(rows))
        if len(rows) > 1:
            supports_with_siblings += 1
        items = [sibling_context_item(row) for row in rows]
        for row in rows:
            target_key = row.get("trainingKey")
            siblings = [item for item in items if item["trainingKey"] != target_key]
            siblings.sort(key=lambda item: (item["horizontalDistance"], abs(item["heightAboveSupportPlane"]), item["trainingKey"]))
            siblings = siblings[:MAX_SIBLING_CONTEXT_ITEMS]
            row["supportContext"] = {
                "supportKey": key,
                "siblingCount": len(items) - 1,
                "items": siblings,
            }
            if siblings:
                rows_with_siblings += 1

    return {
        "support_groups": len(groups),
        "supports_with_siblings": supports_with_siblings,
        "rows_with_sibling_context": rows_with_siblings,
        "max_rows_per_support_group": max_group_size,
    }


def attach_nearby_support_context(training_rows: list[dict]) -> dict[str, int]:
    groups: dict[str, dict] = {}
    for row in training_rows:
        key = row.get("supportKey")
        if not isinstance(key, str) or not key:
            continue
        if key not in groups:
            support = row.get("support") or {}
            anchor = row.get("supportAnchorLocal") or {}
            groups[key] = {
                "sceneId": row.get("sceneId"),
                "componentId": row.get("componentId"),
                "cellId": row.get("cellId"),
                "supportClass": support.get("supportClass"),
                "x": float(anchor.get("x", 0.0) or 0.0),
                "y": float(anchor.get("y", 0.0) or 0.0),
            }

    by_cell: dict[tuple[str, int, str], list[tuple[str, dict]]] = {}
    for key, info in groups.items():
        by_cell.setdefault((str(info["sceneId"]), int(info["componentId"] or -1), str(info["cellId"])), []).append((key, info))

    rows_with_nearby = 0
    for row in training_rows:
        key = row.get("supportKey")
        if not isinstance(key, str) or key not in groups:
            continue
        info = groups[key]
        current_x = float(info["x"])
        current_y = float(info["y"])
        nearby = []
        for other_key, other in by_cell.get((str(info["sceneId"]), int(info["componentId"] or -1), str(info["cellId"])), []):
            if other_key == key:
                continue
            dx = float(other["x"]) - current_x
            dy = float(other["y"]) - current_y
            nearby.append(
                {
                    "supportKey": other_key,
                    "supportClass": other.get("supportClass"),
                    "dx": rounded_or_none(dx),
                    "dy": rounded_or_none(dy),
                    "distance": rounded_or_none(math.hypot(dx, dy)),
                }
            )
        nearby.sort(key=lambda item: (item["distance"], item["supportKey"]))
        row["nearbySupportContext"] = {
            "count": len(nearby),
            "items": nearby[:4],
        }
        if nearby:
            rows_with_nearby += 1
    return {
        "rows_with_nearby_support_context": rows_with_nearby,
    }


def annotate_hook_types(training_rows: list[dict], hook_types: dict[int, int]) -> dict[str, int]:
    prop_rows = 0
    support_rows = 0
    for row in training_rows:
        prop = row.get("prop") or {}
        prop_wcid = prop.get("wcid")
        if prop_wcid is not None and int(prop_wcid) in hook_types:
            prop["lsdHookType"] = int(hook_types[int(prop_wcid)])
            prop["isHookPlacable"] = True
            prop_rows += 1
        else:
            prop["lsdHookType"] = None
            prop["isHookPlacable"] = False
        support = row.get("support") or {}
        support_wcid = support.get("wcid")
        if support_wcid is not None and int(support_wcid) in hook_types:
            support["lsdHookType"] = int(hook_types[int(support_wcid)])
            support["isHookPlacable"] = True
            support_rows += 1
        else:
            support["lsdHookType"] = None
            support["isHookPlacable"] = False
    return {
        "rows_with_prop_hook_type": prop_rows,
        "rows_with_support_hook_type": support_rows,
    }


def main() -> None:
    args = parse_args()
    excluded_landblocks = {value.strip().lower() for value in args.exclude_landblock_id if value.strip()}
    excluded_anchor_model_ids = {
        int(parse_hexish(value))
        for value in args.exclude_anchor_model_id
        if value is not None and str(value).strip()
    }
    component_anchor_models = (
        load_component_anchor_models(args.component_jsonl) if excluded_anchor_model_ids else {}
    )
    component_cells = load_component_cells(args.component_jsonl)
    support_index = load_support_object_index(args.support_objects_jsonl)
    hook_types = load_hook_type_index(args.lsd_partial_weenies_dir)

    source_specs = [
        ("gold_graph", args.gold_jsonl, True),
        ("bootstrap_reviewed", args.bootstrap_jsonl, True),
        ("silver_static", args.silver_jsonl, True),
        ("bronze_static", args.bronze_jsonl, args.include_bronze),
    ]

    chosen: dict[str, dict] = {}
    stats = {
        "source_row_counts": Counter(),
        "kept_label_tier_counts": Counter(),
        "prop_class_counts": Counter(),
        "support_class_counts": Counter(),
        "source_kind_counts": Counter(),
    }

    for source_name, path, enabled in source_specs:
        if not enabled or not path.exists():
            continue
        for row in iter_jsonl(path):
            flattened = training_row(row, source_name)
            if flattened["evidenceWeight"] < args.min_weight:
                continue
            key = flattened["trainingKey"]
            previous = chosen.get(key)
            if previous is not None and tier_rank(previous["labelTier"]) >= tier_rank(flattened["labelTier"]):
                continue
            chosen[key] = flattened
            stats["source_row_counts"][source_name] += 1

    training_rows = sorted(chosen.values(), key=lambda row: (row.get("sceneId") or "", str(row["trainingKey"])))
    if args.require_within_footprint:
        training_rows = [row for row in training_rows if row["validation"].get("withinSurfaceFootprint")]
    if args.max_horizontal_distance is not None:
        training_rows = [
            row for row in training_rows if float(row["validation"].get("horizontalDistance", 0.0)) <= args.max_horizontal_distance
        ]
    if args.max_abs_height_above_support is not None:
        training_rows = [
            row
            for row in training_rows
            if abs(float(row["target"].get("heightAboveSupportPlane", 0.0))) <= args.max_abs_height_above_support
        ]
    if args.max_competing_parents is not None:
        training_rows = [
            row for row in training_rows if int(row["validation"].get("competingParentCount", 0)) <= args.max_competing_parents
        ]
    if excluded_landblocks:
        training_rows = [
            row
            for row in training_rows
            if str(row.get("landblockId") or "").strip().lower() not in excluded_landblocks
        ]
    if excluded_anchor_model_ids:
        training_rows = [
            row
            for row in training_rows
            if component_anchor_models.get(int(row.get("componentId") or -1)) not in excluded_anchor_model_ids
        ]

    rows_with_cell_geometry = 0
    for row in training_rows:
        cell_geometry = build_cell_geometry(component_cells, row)
        if cell_geometry is not None:
            row["cellGeometry"] = cell_geometry
            rows_with_cell_geometry += 1

    rows_with_support_geometry = attach_support_geometry(training_rows, support_index)
    context_stats = attach_support_context(training_rows)
    nearby_support_stats = attach_nearby_support_context(training_rows)
    hook_stats = annotate_hook_types(training_rows, hook_types)

    for row in training_rows:
        stats["kept_label_tier_counts"][row["labelTier"]] += 1
        stats["prop_class_counts"][row["prop"]["propClass"]] += 1
        stats["support_class_counts"][row["support"]["supportClass"]] += 1
        stats["source_kind_counts"][row["prop"].get("sourceKind") or "unknown"] += 1

    write_jsonl(args.out_jsonl, training_rows)

    summary = {
        "gold_jsonl": str(args.gold_jsonl),
        "bootstrap_jsonl": str(args.bootstrap_jsonl),
        "silver_jsonl": str(args.silver_jsonl),
        "bronze_jsonl": str(args.bronze_jsonl),
        "out_jsonl": str(args.out_jsonl),
        "counts": {
            "training_rows_emitted": len(training_rows),
            "rows_with_cell_geometry": rows_with_cell_geometry,
            "rows_with_support_geometry": rows_with_support_geometry,
            **context_stats,
            **nearby_support_stats,
            **hook_stats,
        },
        "source_row_counts": dict(stats["source_row_counts"].most_common()),
        "kept_label_tier_counts": dict(stats["kept_label_tier_counts"].most_common()),
        "prop_class_counts": dict(stats["prop_class_counts"].most_common()),
        "support_class_counts": dict(stats["support_class_counts"].most_common()),
        "source_kind_counts": dict(stats["source_kind_counts"].most_common()),
        "tier_weights": DEFAULT_TIER_WEIGHTS,
        "include_bronze": args.include_bronze,
        "min_weight": args.min_weight,
        "require_within_footprint": args.require_within_footprint,
        "max_horizontal_distance": args.max_horizontal_distance,
        "max_abs_height_above_support": args.max_abs_height_above_support,
        "max_competing_parents": args.max_competing_parents,
        "exclude_landblock_id": sorted(excluded_landblocks),
        "exclude_anchor_model_id": [hex(value) for value in sorted(excluded_anchor_model_ids)],
    }
    args.out_summary_json.parent.mkdir(parents=True, exist_ok=True)
    with args.out_summary_json.open("w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)

    print("Interior micro-placement training set complete")
    print(f"  Training rows: {len(training_rows):,}")
    print(f"  Output JSONL:  {args.out_jsonl}")
    print(f"  Summary JSON:  {args.out_summary_json}")


if __name__ == "__main__":
    main()

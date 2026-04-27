#!/usr/bin/env python3
"""
extract_component_linked_tensors.py
==================================

Build component-linked training tensors from:
  - export-raw-world-facts JSONL
  - export-envcell-components JSONL

This keeps EnvCell-linked structure as a hard join instead of forcing the model
to rediscover it from disconnected rows.
"""

import argparse
import json
import math
import os
from collections import defaultdict

import numpy as np


BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
REFERENCE_DIR = os.path.join(BASE_DIR, "pipeline_data", "reference")

DEFAULT_RAW_JSONL = os.path.join(REFERENCE_DIR, "raw_world_facts_full_with_components_v2.jsonl")
DEFAULT_COMPONENT_JSONL = os.path.join(REFERENCE_DIR, "envcell_components_full.jsonl")
DEFAULT_OUT_NPZ = os.path.join(REFERENCE_DIR, "component_linked_unified_tensors.npz")
DEFAULT_OUT_VOCAB = os.path.join(REFERENCE_DIR, "component_linked_unified_vocab.json")

LB_SIZE = 192.0
MAX_OBJECTS_PER_LB = 256
OBJECT_FEATURE_DIM = 14
BASE_CONTEXT_DIM = 20
EXTENDED_CONTEXT_DIM = 31

PAD_TOKEN = 0
STOP_TOKEN = 1
FIRST_REAL_TOKEN = 2
TARGET_TOKEN_MODES = ("exact", "abstract_ace")

SOURCE_DB_CODES = {"dat": 1, "ace": 2}
CLASS_SPACE_CODES = {"model_id": 1, "wcid": 2}
COMPONENT_KIND_CODES = {
    None: 0,
    "surface_anchor_component": 1,
    "unanchored_envcell_component": 2,
}
SCENE_KIND_OUTDOOR = 0
SCENE_KIND_INTERIOR_ANCHORED = 1
SCENE_KIND_INTERIOR_UNANCHORED = 2

RAW_SCAN_PROGRESS_EVERY = 100000
COMPONENT_SCAN_PROGRESS_EVERY = 10000

VIEW_STRATEGIES = (
    "xy",
    "yx",
    "component",
    "radial",
    "interior_source",
    "serpentine",
)
DEFAULT_VIEWS_PER_LANDBLOCK = len(VIEW_STRATEGIES)
ABSTRACT_ACE_SPACE = "ace_abstract"


def iter_jsonl(path):
    with open(path, "r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if line:
                yield json.loads(line)


def parse_hexish(value):
    if value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.startswith("0x"):
        return int(value, 16)
    return int(value)


def build_class_vocab(class_keys):
    class_keys = sorted(class_keys)
    key_to_idx = {(space, class_id): i + FIRST_REAL_TOKEN for i, (space, class_id) in enumerate(class_keys)}
    idx_to_key = {idx: [space, class_id] for (space, class_id), idx in key_to_idx.items()}
    idx_to_key[PAD_TOKEN] = ["special", -1]
    idx_to_key[STOP_TOKEN] = ["special", -2]
    return key_to_idx, idx_to_key


def canonical_class_key(row, target_token_mode):
    class_space = row.get("classIdSpace")
    class_id = row.get("classId")
    if class_space is None or class_id is None:
        return None

    if target_token_mode == "exact":
        return (class_space, int(class_id))
    if target_token_mode != "abstract_ace":
        raise ValueError(f"Unknown target token mode: {target_token_mode}")

    if class_space == "model_id":
        return ("model_id", int(class_id))
    if class_space != "wcid":
        return (class_space, int(class_id))

    source_table = row.get("sourceTable") or "unknown"
    type_id = int(row.get("typeId") or row.get("weenieType") or 0)
    component_kind = row.get("envCellComponentKind") or "none"
    source_db = row.get("sourceDb") or "unknown"
    cell_id = parse_hexish(row.get("cellId")) or 0
    interior_flag = "interior" if cell_id >= 0x0100 else "surface"
    abstract_label = f"{source_db}|{source_table}|type_{type_id}|{component_kind}|{interior_flag}"
    return (ABSTRACT_ACE_SPACE, abstract_label)


def scan_component_jsonl(path, target_token_mode, rows_by_component, stats_by_component):
    """Iterate the envcell components export.

    Builds the per-component table (anchor, bounds, portal counts, …) used as
    the lookup for context features. Also harvests every static object inside
    every cell as an interior row tuple in the same shape `scan_raw_jsonl`
    produces, appending into `rows_by_component` / `stats_by_component`. This
    is the load-bearing change for full interior coverage: ACE-dynamic interior
    rows alone covered ~7K of 16K components; static furniture fills the rest.

    Both data sources use the same component-local coordinate frame for x/y/z,
    so positions are appended without further transform.
    """
    component_entries = []
    component_class_keys = set()
    component_count = 0
    static_rows_emitted = 0

    for component_count, row in enumerate(iter_jsonl(path), start=1):
        anchor = row.get("anchor") or {}
        anchor_class_space = anchor.get("classIdSpace")
        anchor_class_id = int(anchor["classId"]) if anchor.get("classId") is not None else None
        anchor_row = {
            "classIdSpace": anchor_class_space,
            "classId": anchor_class_id,
            "sourceDb": anchor.get("sourceDb"),
            "sourceTable": anchor.get("sourceTable"),
            "typeId": anchor.get("typeId"),
            "envCellComponentKind": row.get("componentKind"),
            "cellId": anchor.get("cellId"),
        }
        anchor_class_key = None
        if anchor_class_space is not None and anchor_class_id is not None:
            anchor_class_key = canonical_class_key(anchor_row, target_token_mode)
            component_class_keys.add(anchor_class_key)

        bounds = row.get("boundsLocal") or {}
        component_id = int(row["componentId"])
        component_kind_code = COMPONENT_KIND_CODES.get(row.get("componentKind"), 0)
        component_entries.append({
            "component_id": component_id,
            "component_kind": component_kind_code,
            "landblock_x": int(row["landblockX"]),
            "landblock_y": int(row["landblockY"]),
            "cell_count": int(row.get("cellCount", 0)),
            "static_object_count": int(row.get("staticObjectCount", 0)),
            "entry_count": len(anchor.get("entryCellIds", [])),
            "anchor_class_key": anchor_class_key,
            "anchor_pos": (
                float(anchor.get("x", 0.0)),
                float(anchor.get("y", 0.0)),
                float(anchor.get("z", 0.0)),
            ),
            "bounds": (
                float(bounds.get("minX", 0.0)),
                float(bounds.get("minY", 0.0)),
                float(bounds.get("minZ", 0.0)),
                float(bounds.get("maxX", 0.0)),
                float(bounds.get("maxY", 0.0)),
                float(bounds.get("maxZ", 0.0)),
            ),
            "portal_ref_count": sum(len(cell.get("portalRefs", [])) for cell in row.get("cells", [])),
        })

        for cell in row.get("cells", []):
            cell_id = parse_hexish(cell.get("cellId")) or 0
            if cell_id < 0x0100:
                continue
            for obj in cell.get("staticObjects", []):
                cls_id_raw = obj.get("classId")
                if cls_id_raw is None:
                    continue
                cls_id = int(cls_id_raw)
                cls_space = obj.get("classIdSpace") or "model_id"
                static_canonical_key = canonical_class_key({
                    "classIdSpace": cls_space,
                    "classId": cls_id,
                    "sourceDb": "dat",
                    "sourceTable": "envcell_static",
                    "typeId": 0,
                    "envCellComponentKind": row.get("componentKind"),
                    "cellId": cell.get("cellId"),
                }, target_token_mode)
                if static_canonical_key is not None:
                    component_class_keys.add(static_canonical_key)

                local_x = float(obj.get("x", 0.0))
                local_y = float(obj.get("y", 0.0))
                local_z = float(obj.get("z", 0.0))
                yaw_deg = float(obj.get("yawDeg", 0.0))
                source_db_code = SOURCE_DB_CODES.get("dat", 0)
                class_space_code = CLASS_SPACE_CODES.get(cls_space, 0)

                row_tuple = (
                    local_x,
                    local_y,
                    local_z,
                    cls_id,
                    cls_space,
                    cls_id,
                    static_canonical_key,
                    class_space_code,
                    yaw_deg,
                    0.0,
                    source_db_code,
                    cell_id,
                    0.0,
                    0.0,
                    component_kind_code,
                    component_id,
                )
                rows_by_component[component_id].append(row_tuple)
                _accumulate_stats(stats_by_component[component_id], (
                    source_db_code, cls_space, component_id, cell_id,
                    0.0, 0.0, 0, 0, "envcell_static",
                ))
                static_rows_emitted += 1

        if component_count % COMPONENT_SCAN_PROGRESS_EVERY == 0:
            print(f"  Components scanned: {component_count:,} ({static_rows_emitted:,} static rows so far)")

    return component_entries, component_class_keys, component_count, static_rows_emitted


def _empty_stats():
    return {
        "count": 0,
        "dat_count": 0,
        "ace_count": 0,
        "model_id_count": 0,
        "wcid_count": 0,
        "linked_count": 0,
        "interior_count": 0,
        "terrain_delta_sum": 0.0,
        "slope_sum": 0.0,
        "parent_count_sum": 0.0,
        "child_count_sum": 0.0,
        "building_count": 0,
        "encounter_count": 0,
        "instance_count": 0,
    }


def _accumulate_stats(stats, row_data):
    (source_db_code, class_space, component_id, cell_id,
     terrain_delta_z, slope_deg, parent_count, child_count, source_table) = row_data
    stats["count"] += 1
    if source_db_code == SOURCE_DB_CODES["dat"]:
        stats["dat_count"] += 1
    elif source_db_code == SOURCE_DB_CODES["ace"]:
        stats["ace_count"] += 1
    if class_space == "model_id":
        stats["model_id_count"] += 1
    elif class_space == "wcid":
        stats["wcid_count"] += 1
    if component_id is not None:
        stats["linked_count"] += 1
    if cell_id >= 0x0100:
        stats["interior_count"] += 1
    stats["terrain_delta_sum"] += terrain_delta_z
    stats["slope_sum"] += slope_deg
    stats["parent_count_sum"] += parent_count
    stats["child_count_sum"] += child_count
    if source_table == "landblock_info_building":
        stats["building_count"] += 1
    elif source_table == "encounter":
        stats["encounter_count"] += 1
    elif source_table == "landblock_instance":
        stats["instance_count"] += 1


def scan_raw_jsonl(path, target_token_mode):
    raw_class_keys = set()
    rows_by_lb = defaultdict(list)
    stats_by_lb = defaultdict(_empty_stats)
    rows_by_component = defaultdict(list)
    stats_by_component = defaultdict(_empty_stats)
    raw_count = 0

    for raw_count, row in enumerate(iter_jsonl(path), start=1):
        lb_key = (int(row["landblockX"]), int(row["landblockY"]))
        class_space = row.get("classIdSpace")
        class_id = int(row["classId"]) if row.get("classId") is not None else None
        canonical_key = canonical_class_key(row, target_token_mode)
        if canonical_key is not None:
            raw_class_keys.add(canonical_key)

        local_x = float(row.get("localX", 0.0))
        local_y = float(row.get("localY", 0.0))
        z = float(row.get("z", 0.0))
        yaw_deg = float(row.get("yawDeg", 0.0))
        type_id = float(row.get("typeId", 0.0) or 0.0)
        cell_id = parse_hexish(row.get("cellId")) or 0
        terrain_delta_z = float(row.get("terrainDeltaZ", 0.0))
        slope_deg = float(row.get("slopeDeg", 0.0))
        source_db_code = SOURCE_DB_CODES.get(row.get("sourceDb"), 0)
        class_space_code = CLASS_SPACE_CODES.get(class_space, 0)
        component_kind_code = COMPONENT_KIND_CODES.get(row.get("envCellComponentKind"), 0)
        component_id = int(row["envCellComponentId"]) if row.get("envCellComponentId") is not None else None
        parent_count = len(row.get("parentGuids", []))
        child_count = len(row.get("childGuids", []))
        source_table = row.get("sourceTable")

        row_tuple = (
            local_x,
            local_y,
            z,
            class_id or 0,
            class_space,
            class_id,
            canonical_key,
            class_space_code,
            yaw_deg,
            type_id,
            source_db_code,
            cell_id,
            terrain_delta_z,
            slope_deg,
            component_kind_code,
            component_id,
        )
        rows_by_lb[lb_key].append(row_tuple)

        stat_data = (source_db_code, class_space, component_id, cell_id,
                     terrain_delta_z, slope_deg, parent_count, child_count, source_table)
        _accumulate_stats(stats_by_lb[lb_key], stat_data)

        # Interior rows additionally bucket into per-component sequences when a
        # component link is known. Components that span multiple landblocks still
        # group cleanly because component_id is globally unique.
        if cell_id >= 0x0100 and component_id is not None:
            rows_by_component[component_id].append(row_tuple)
            _accumulate_stats(stats_by_component[component_id], stat_data)

        if raw_count % RAW_SCAN_PROGRESS_EVERY == 0:
            print(f"  Raw rows scanned: {raw_count:,}")

    return rows_by_lb, stats_by_lb, rows_by_component, stats_by_component, raw_class_keys, raw_count


def build_component_tables(component_entries, class_key_to_idx):
    component_entries.sort(key=lambda entry: entry["component_id"])
    component_id_to_index = {}

    component_ids = np.full(len(component_entries), -1, dtype=np.int64)
    component_kind = np.zeros(len(component_entries), dtype=np.int8)
    component_lb_coords = np.zeros((len(component_entries), 2), dtype=np.int16)
    component_cell_count = np.zeros(len(component_entries), dtype=np.int16)
    component_static_count = np.zeros(len(component_entries), dtype=np.int32)
    component_entry_count = np.zeros(len(component_entries), dtype=np.int16)
    component_anchor_class_idx = np.full(len(component_entries), -1, dtype=np.int32)
    component_anchor_pos = np.zeros((len(component_entries), 3), dtype=np.float32)
    component_bounds = np.zeros((len(component_entries), 6), dtype=np.float32)
    component_portal_ref_count = np.zeros(len(component_entries), dtype=np.int32)

    for i, entry in enumerate(component_entries):
        component_id = entry["component_id"]
        component_id_to_index[component_id] = i
        component_ids[i] = component_id
        component_kind[i] = entry["component_kind"]
        component_lb_coords[i] = [entry["landblock_x"], entry["landblock_y"]]
        component_cell_count[i] = entry["cell_count"]
        component_static_count[i] = entry["static_object_count"]
        component_entry_count[i] = entry["entry_count"]
        if entry["anchor_class_key"] is not None:
            component_anchor_class_idx[i] = class_key_to_idx.get(entry["anchor_class_key"], -1)
        component_anchor_pos[i] = entry["anchor_pos"]
        component_bounds[i] = entry["bounds"]
        component_portal_ref_count[i] = entry["portal_ref_count"]

    return {
        "component_id_to_index": component_id_to_index,
        "component_ids": component_ids,
        "component_kind": component_kind,
        "component_lb_coords": component_lb_coords,
        "component_cell_count": component_cell_count,
        "component_static_count": component_static_count,
        "component_entry_count": component_entry_count,
        "component_anchor_class_idx": component_anchor_class_idx,
        "component_anchor_pos": component_anchor_pos,
        "component_bounds": component_bounds,
        "component_portal_ref_count": component_portal_ref_count,
    }


def structural_signature(stats):
    row_count = max(stats["count"], 1)
    linked_ratio = stats["linked_count"] / row_count
    interior_ratio = stats["interior_count"] / row_count
    dat_ratio = stats["dat_count"] / row_count
    model_ratio = stats["model_id_count"] / row_count
    activity_level = (
        int(stats["building_count"] > 0) +
        int(stats["encounter_count"] > 0) +
        int(stats["instance_count"] > 0)
    )

    return (
        min(int(math.log2(row_count + 1)), 8),
        min(int(linked_ratio * 6.0), 5),
        min(int(interior_ratio * 6.0), 5),
        0 if dat_ratio < 0.35 else 1 if dat_ratio < 0.65 else 2,
        0 if model_ratio < 0.35 else 1 if model_ratio < 0.65 else 2,
        activity_level,
    )


def build_structural_weights(populated_lbs, stats_by_lb):
    signature_counts = defaultdict(int)
    signatures = {}

    for lb_key in populated_lbs:
        signature = structural_signature(stats_by_lb[lb_key])
        signatures[lb_key] = signature
        signature_counts[signature] += 1

    raw_weights = []
    for lb_key in populated_lbs:
        freq = signature_counts[signatures[lb_key]]
        raw_weights.append(1.0 / math.sqrt(freq))

    raw_weights = np.asarray(raw_weights, dtype=np.float32)
    mean_weight = float(np.mean(raw_weights)) if len(raw_weights) else 1.0
    if mean_weight <= 0:
        mean_weight = 1.0

    normalized = raw_weights / mean_weight
    boosted = []
    for base_weight, lb_key in zip(normalized, populated_lbs):
        stats = stats_by_lb[lb_key]
        row_count = max(stats["count"], 1)
        linked_ratio = stats["linked_count"] / row_count
        interior_ratio = stats["interior_count"] / row_count
        density_ratio = stats["count"] / max(MAX_OBJECTS_PER_LB - 1, 1)

        if linked_ratio > 0.0:
            base_weight *= 1.35
        if interior_ratio >= 0.5:
            base_weight *= 1.15
        if density_ratio > 1.0:
            base_weight *= min(1.30, 1.0 + 0.12 * math.log2(density_ratio + 1.0))
        boosted.append(base_weight)

    return np.clip(np.asarray(boosted, dtype=np.float32), 0.75, 4.0)


def sorted_view_rows(rows, strategy):
    if strategy == "xy":
        return sorted(rows, key=lambda row: (row[0], row[1], row[2], row[3]))
    if strategy == "yx":
        return sorted(rows, key=lambda row: (row[1], row[0], row[2], row[3]))
    if strategy == "component":
        return sorted(rows, key=lambda row: (row[14] is None, row[14] or -1, row[0], row[1], row[2], row[3]))
    if strategy == "radial":
        cx = LB_SIZE * 0.5
        cy = LB_SIZE * 0.5
        return sorted(
            rows,
            key=lambda row: (
                (row[0] - cx) ** 2 + (row[1] - cy) ** 2,
                math.atan2(row[1] - cy, row[0] - cx),
                row[2],
                row[3],
            ),
        )
    if strategy == "interior_source":
        return sorted(
            rows,
            key=lambda row: (
                0 if row[10] >= 0x0100 else 1,
                row[9],
                row[13],
                row[0],
                row[1],
                row[2],
                row[3],
            ),
        )
    if strategy == "serpentine":
        bucketed = defaultdict(list)
        for row in rows:
            bucketed[int(row[1] // 16.0)].append(row)
        ordered = []
        for stripe_idx in sorted(bucketed):
            stripe_rows = sorted(bucketed[stripe_idx], key=lambda row: (row[0], row[2], row[3]))
            if stripe_idx % 2 == 1:
                stripe_rows.reverse()
            ordered.extend(stripe_rows)
        return ordered
    raise ValueError(f"Unknown view strategy: {strategy}")


def compute_chunk_offsets(row_count, chunk_capacity):
    if row_count <= 0:
        return [0]

    chunk_count = max(1, math.ceil(row_count / chunk_capacity))
    if chunk_count == 1:
        return [0]

    max_start = max(row_count - chunk_capacity, 0)
    offsets = []
    for chunk_idx in range(chunk_count):
        if chunk_count == 1:
            start = 0
        else:
            start = round((max_start * chunk_idx) / max(chunk_count - 1, 1))
        offsets.append(int(start))

    deduped = []
    seen = set()
    for start in offsets:
        if start not in seen:
            deduped.append(start)
            seen.add(start)
    return deduped


def _build_base_context_block(stats, total_object_count):
    """First 16 dims of the context vector.

    Only the first two slots (landblock-position placeholders, filled by
    the caller) carry information available at inference time. Slots 2–15
    used to encode scene-aggregate stats (dat/ace/wcid counts, building
    count, slope sums, etc.) but those are derived from the scene that the
    model is asked to *generate*, so feeding them at training time induced
    train/test distribution shift — the model learned to rely on features
    that inference cannot supply, and at sampling time it received zeros
    or worse, garbage from the legacy 235-dim context truncated to 31
    dims, producing the v2/v3 vocab-collapse failure mode.

    Zeroed here so training and inference see the same feature surface.
    """
    return np.zeros(16, dtype=np.float32)


def _serialize_chunk(chunk_rows, class_key_to_idx, component_id_to_index,
                     norm_x, norm_y, norm_z):
    """Serialize an ordered list of rows into the (MAX_OBJECTS_PER_LB, 14) tensor.

    norm_x / norm_y / norm_z are callables that map raw row coordinates to [0, 1]
    relative to the sequence's coordinate frame (landblock or component bounds).
    """
    seq = np.zeros((MAX_OBJECTS_PER_LB, OBJECT_FEATURE_DIM), dtype=np.float32)
    comp_idx = np.full(MAX_OBJECTS_PER_LB, -1, dtype=np.int32)
    linked = 0
    for obj_idx, row in enumerate(chunk_rows):
        canonical_key = row[6]
        class_space_code = row[7]
        yaw_rad = math.radians(row[8])
        type_id = row[9]
        source_db_code = row[10]
        cell_id = row[11]
        terrain_delta_z = row[12]
        slope_deg = row[13]
        component_kind_code = row[14]
        component_id = row[15]
        class_token = class_key_to_idx.get(canonical_key, PAD_TOKEN)
        is_interior = 1.0 if cell_id >= 0x0100 else 0.0

        seq[obj_idx] = np.array([
            float(class_token),
            float(class_space_code),
            norm_x(row[0]),
            norm_y(row[1]),
            norm_z(row[2]),
            math.sin(yaw_rad),
            math.cos(yaw_rad),
            type_id / 255.0,
            float(source_db_code),
            cell_id / 65535.0,
            terrain_delta_z / 64.0,
            slope_deg / 90.0,
            float(component_kind_code),
            is_interior,
        ], dtype=np.float32)

        if component_id is not None:
            mapped = component_id_to_index.get(component_id, -1)
            comp_idx[obj_idx] = mapped
            if mapped >= 0:
                linked += 1
    return seq, comp_idx, linked


def _scene_kind_block(scene_kind, *, span_x_norm=0.0, span_y_norm=0.0,
                      span_z_norm=0.0, cell_count_norm=0.0,
                      density_norm=0.0, portal_degree_norm=0.0):
    """Last 11 dims of the unified context: scene_kind one-hot + interior context.

    Layout:
      [0:3]  scene_kind one-hot (outdoor / interior_anchored / interior_unanchored)
      [3]    is_interior flag (redundant w/ one-hot but cheap and matches token dim 13)
      [4]    component span x (normalized)
      [5]    component span y (normalized)
      [6]    component span z (normalized)
      [7]    component cell count (normalized)
      [8]    component object density per cell (normalized)
      [9]    mean per-cell portal degree (normalized)
      [10]   reserved (0.0)
    """
    block = np.zeros(11, dtype=np.float32)
    block[scene_kind] = 1.0
    if scene_kind != SCENE_KIND_OUTDOOR:
        block[3] = 1.0
        block[4] = span_x_norm
        block[5] = span_y_norm
        block[6] = span_z_norm
        block[7] = cell_count_norm
        block[8] = density_norm
        block[9] = portal_degree_norm
    return block


def build_unified_tensors(
    rows_by_lb,
    stats_by_lb,
    rows_by_component,
    stats_by_component,
    class_key_to_idx,
    component_data,
    views_per_landblock,
):
    """Emit landblock (outdoor-only) sequences plus per-component interior sequences.

    Output shape matches the legacy single-array layout — both scene types share
    the same arrays and are distinguished by the `scene_kind` slot of the context
    vector and by an explicit `scene_kinds` parallel array.
    """
    populated_lbs = sorted(rows_by_lb.keys())
    view_count = max(1, min(int(views_per_landblock), len(VIEW_STRATEGIES)))
    chunk_capacity = MAX_OBJECTS_PER_LB - 1
    component_id_to_index = component_data["component_id_to_index"]
    component_bounds = component_data["component_bounds"]
    component_kind = component_data["component_kind"]
    component_cell_count = component_data["component_cell_count"]
    component_static_count = component_data["component_static_count"]
    component_portal_ref_count = component_data["component_portal_ref_count"]
    component_lb_coords_arr = component_data["component_lb_coords"]

    contexts = []
    sequences = []
    seq_lengths = []
    component_index_by_object = []
    lb_coords = []
    sample_weights = []
    scene_kinds = []
    structural_weights = build_structural_weights(populated_lbs, stats_by_lb)

    linked_objects = 0
    chunked_views = 0
    max_chunks_per_view = 1
    landblock_examples = 0
    component_examples = 0
    landblocks_emitted = 0
    components_emitted = 0
    components_skipped_unknown_id = 0
    components_skipped_empty = 0

    # ── Outdoor landblock sequences ─────────────────────────────────────────
    for lb_idx, (lb_x, lb_y) in enumerate(populated_lbs):
        all_rows = rows_by_lb[(lb_x, lb_y)]
        # Interior rows now have their own per-component sequences. Strip them
        # from landblock sequences so each physical object appears in exactly
        # one training example.
        outdoor_rows = [row for row in all_rows if row[11] < 0x0100]
        if not outdoor_rows:
            continue
        landblocks_emitted += 1

        stats = stats_by_lb[(lb_x, lb_y)]
        base_context = _build_base_context_block(stats, len(all_rows))
        base_context[0] = lb_x / 254.0
        base_context[1] = lb_y / 254.0
        scene_kind_block = _scene_kind_block(SCENE_KIND_OUTDOOR)

        def norm_lb_x(x): return x / LB_SIZE
        def norm_lb_y(y): return y / LB_SIZE
        def norm_lb_z(z): return z / 512.0

        for view_idx in range(view_count):
            strategy = VIEW_STRATEGIES[view_idx]
            ordered_rows = sorted_view_rows(outdoor_rows, strategy)
            chunk_offsets = compute_chunk_offsets(len(ordered_rows), chunk_capacity)
            if len(chunk_offsets) > 1:
                chunked_views += 1
            max_chunks_per_view = max(max_chunks_per_view, len(chunk_offsets))

            for chunk_idx, start in enumerate(chunk_offsets):
                chunk_rows = ordered_rows[start:start + chunk_capacity]
                ctx = np.zeros(EXTENDED_CONTEXT_DIM, dtype=np.float32)
                ctx[:16] = base_context
                ctx[16] = view_idx / max(view_count - 1, 1)
                ctx[17] = VIEW_STRATEGIES.index(strategy) / max(len(VIEW_STRATEGIES) - 1, 1)
                ctx[18] = chunk_idx / max(len(chunk_offsets) - 1, 1)
                ctx[19] = len(chunk_rows) / max(len(ordered_rows), 1)
                ctx[20:31] = scene_kind_block

                seq, comp_idx, n_linked = _serialize_chunk(
                    chunk_rows, class_key_to_idx, component_id_to_index,
                    norm_lb_x, norm_lb_y, norm_lb_z,
                )
                linked_objects += n_linked
                stop_index = len(chunk_rows)
                seq[stop_index, 0] = STOP_TOKEN

                contexts.append(ctx)
                sequences.append(seq)
                seq_lengths.append(stop_index + 1)
                component_index_by_object.append(comp_idx)
                lb_coords.append((lb_x, lb_y))
                sample_weights.append(structural_weights[lb_idx])
                scene_kinds.append(SCENE_KIND_OUTDOOR)
                landblock_examples += 1

    # ── Interior component sequences ────────────────────────────────────────
    for component_id in sorted(rows_by_component.keys()):
        rows = rows_by_component[component_id]
        if not rows:
            components_skipped_empty += 1
            continue
        comp_table_idx = component_id_to_index.get(component_id)
        if comp_table_idx is None:
            components_skipped_unknown_id += 1
            continue

        bounds = component_bounds[comp_table_idx]
        comp_kind_code = int(component_kind[comp_table_idx])
        cell_count = int(component_cell_count[comp_table_idx])
        portal_refs_total = int(component_portal_ref_count[comp_table_idx])
        static_count = int(component_static_count[comp_table_idx])
        comp_lb_x = int(component_lb_coords_arr[comp_table_idx][0])
        comp_lb_y = int(component_lb_coords_arr[comp_table_idx][1])

        # Per Q2: inherit the parent landblock's outdoor stats so the interior
        # context includes terrain/biome signal from the surrounding world.
        # Fall back to the component's own stats if the parent landblock has no
        # rows (rare but possible for orphan components).
        parent_lb_stats = stats_by_lb.get((comp_lb_x, comp_lb_y))
        comp_stats = stats_by_component[component_id]
        inherited_stats = parent_lb_stats if (parent_lb_stats and parent_lb_stats["count"] > 0) else comp_stats

        base_context = _build_base_context_block(inherited_stats, max(static_count, len(rows)))
        base_context[0] = comp_lb_x / 254.0
        base_context[1] = comp_lb_y / 254.0

        span_x = max(float(bounds[3] - bounds[0]), 1e-3)
        span_y = max(float(bounds[4] - bounds[1]), 1e-3)
        span_z = max(float(bounds[5] - bounds[2]), 1e-3)
        density = (static_count / max(cell_count, 1))
        mean_portal_degree = (portal_refs_total / max(cell_count, 1))
        scene_kind = (
            SCENE_KIND_INTERIOR_ANCHORED
            if comp_kind_code == COMPONENT_KIND_CODES["surface_anchor_component"]
            else SCENE_KIND_INTERIOR_UNANCHORED
        )
        scene_kind_block = _scene_kind_block(
            scene_kind,
            span_x_norm=min(span_x / 200.0, 1.0),
            span_y_norm=min(span_y / 200.0, 1.0),
            span_z_norm=min(span_z / 100.0, 1.0),
            cell_count_norm=min(cell_count / 64.0, 1.0),
            density_norm=min(density / 4.0, 1.0),
            portal_degree_norm=min(mean_portal_degree / 8.0, 1.0),
        )

        # Component-local normalization: clamp to [0, 1] in case rare rows fall
        # outside the reported bounds (defensive — should be rare).
        def norm_comp_x(x, bx=float(bounds[0]), sx=span_x):
            return max(0.0, min(1.0, (x - bx) / sx))
        def norm_comp_y(y, by=float(bounds[1]), sy=span_y):
            return max(0.0, min(1.0, (y - by) / sy))
        def norm_comp_z(z, bz=float(bounds[2]), sz=span_z):
            return max(0.0, min(1.0, (z - bz) / sz))

        ordered_rows = sorted_view_rows(rows, "component")
        chunk_offsets = compute_chunk_offsets(len(ordered_rows), chunk_capacity)
        if len(chunk_offsets) > 1:
            chunked_views += 1
        max_chunks_per_view = max(max_chunks_per_view, len(chunk_offsets))

        for chunk_idx, start in enumerate(chunk_offsets):
            chunk_rows = ordered_rows[start:start + chunk_capacity]
            ctx = np.zeros(EXTENDED_CONTEXT_DIM, dtype=np.float32)
            ctx[:16] = base_context
            ctx[16] = 0.0
            ctx[17] = VIEW_STRATEGIES.index("component") / max(len(VIEW_STRATEGIES) - 1, 1)
            ctx[18] = chunk_idx / max(len(chunk_offsets) - 1, 1)
            ctx[19] = len(chunk_rows) / max(len(ordered_rows), 1)
            ctx[20:31] = scene_kind_block

            seq, comp_idx, n_linked = _serialize_chunk(
                chunk_rows, class_key_to_idx, component_id_to_index,
                norm_comp_x, norm_comp_y, norm_comp_z,
            )
            linked_objects += n_linked
            stop_index = len(chunk_rows)
            seq[stop_index, 0] = STOP_TOKEN

            contexts.append(ctx)
            sequences.append(seq)
            seq_lengths.append(stop_index + 1)
            component_index_by_object.append(comp_idx)
            lb_coords.append((comp_lb_x, comp_lb_y))
            sample_weights.append(1.0)
            scene_kinds.append(scene_kind)
            component_examples += 1
        components_emitted += 1

    return {
        "populated_lbs": populated_lbs,
        "contexts": np.asarray(contexts, dtype=np.float32),
        "sequences": np.asarray(sequences, dtype=np.float32),
        "seq_lengths": np.asarray(seq_lengths, dtype=np.int32),
        "component_index_by_object": np.asarray(component_index_by_object, dtype=np.int32),
        "lb_coords": np.asarray(lb_coords, dtype=np.int16),
        "sample_weights": np.asarray(sample_weights, dtype=np.float32),
        "scene_kinds": np.asarray(scene_kinds, dtype=np.int8),
        "linked_objects": linked_objects,
        "views_per_landblock": view_count,
        "chunked_views": chunked_views,
        "max_chunks_per_view": max_chunks_per_view,
        "landblock_examples": landblock_examples,
        "component_examples": component_examples,
        "landblocks_emitted": landblocks_emitted,
        "components_emitted": components_emitted,
        "components_skipped_unknown_id": components_skipped_unknown_id,
        "components_skipped_empty": components_skipped_empty,
    }


def save_outputs(out_npz, out_vocab, class_key_to_idx, idx_to_key, lb_data, component_data, target_token_mode):
    os.makedirs(os.path.dirname(out_npz), exist_ok=True)

    np.savez_compressed(
        out_npz,
        contexts=lb_data["contexts"],
        sequences=lb_data["sequences"],
        seq_lengths=lb_data["seq_lengths"],
        lb_coords=lb_data["lb_coords"],
        sample_weights=lb_data["sample_weights"],
        scene_kinds=lb_data["scene_kinds"],
        component_index_by_object=lb_data["component_index_by_object"],
        component_ids=component_data["component_ids"],
        component_kind=component_data["component_kind"],
        component_lb_coords=component_data["component_lb_coords"],
        component_cell_count=component_data["component_cell_count"],
        component_static_count=component_data["component_static_count"],
        component_entry_count=component_data["component_entry_count"],
        component_anchor_class_idx=component_data["component_anchor_class_idx"],
        component_anchor_pos=component_data["component_anchor_pos"],
        component_bounds=component_data["component_bounds"],
        component_portal_ref_count=component_data["component_portal_ref_count"],
    )

    vocab = {
        "special_tokens": {"PAD": PAD_TOKEN, "STOP": STOP_TOKEN},
        "vocab_size": len(class_key_to_idx) + FIRST_REAL_TOKEN,
        "class_key_to_idx": {f"{space}:{class_id}": idx for (space, class_id), idx in class_key_to_idx.items()},
        "idx_to_class_key": {str(idx): value for idx, value in idx_to_key.items()},
        "source_db_codes": SOURCE_DB_CODES,
        "class_space_codes": CLASS_SPACE_CODES,
        "component_kind_codes": {str(k): v for k, v in COMPONENT_KIND_CODES.items()},
        "scene_kind_codes": {
            "outdoor": SCENE_KIND_OUTDOOR,
            "interior_anchored": SCENE_KIND_INTERIOR_ANCHORED,
            "interior_unanchored": SCENE_KIND_INTERIOR_UNANCHORED,
        },
        "object_feature_dim": OBJECT_FEATURE_DIM,
        "max_objects_per_lb": MAX_OBJECTS_PER_LB,
        "context_dim": EXTENDED_CONTEXT_DIM,
        "views_per_landblock": lb_data["views_per_landblock"],
        "view_strategies": list(VIEW_STRATEGIES[:lb_data["views_per_landblock"]]),
        "target_token_mode": target_token_mode,
        "context_feature_names": [
            "lb_x",
            "lb_y",
            "object_count",
            "dat_ratio",
            "ace_ratio",
            "model_ratio",
            "wcid_ratio",
            "linked_ratio",
            "interior_ratio",
            "terrain_delta_mean",
            "slope_mean",
            "parent_count_mean",
            "child_count_mean",
            "building_count_mean",
            "encounter_count_mean",
            "instance_count_mean",
            "view_ordinal",
            "view_strategy",
            "chunk_ordinal",
            "chunk_coverage",
            "scene_kind_outdoor",
            "scene_kind_interior_anchored",
            "scene_kind_interior_unanchored",
            "is_interior",
            "component_span_x",
            "component_span_y",
            "component_span_z",
            "component_cell_count",
            "component_object_density",
            "component_mean_portal_degree",
            "reserved",
        ],
    }
    with open(out_vocab, "w", encoding="utf-8") as f:
        json.dump(vocab, f, indent=2)


def parse_args():
    parser = argparse.ArgumentParser(description="Build component-linked tensors from raw world facts + EnvCell components.")
    parser.add_argument("--raw-jsonl", default=DEFAULT_RAW_JSONL, help="Path to export-raw-world-facts JSONL")
    parser.add_argument("--component-jsonl", default=DEFAULT_COMPONENT_JSONL, help="Path to export-envcell-components JSONL")
    parser.add_argument("--out-npz", default=DEFAULT_OUT_NPZ, help="Output NPZ path")
    parser.add_argument("--out-vocab", default=DEFAULT_OUT_VOCAB, help="Output vocab JSON path")
    parser.add_argument("--views-per-landblock", type=int, default=DEFAULT_VIEWS_PER_LANDBLOCK, help="Number of structurally distinct sequence views to emit per landblock")
    parser.add_argument("--target-token-mode", choices=TARGET_TOKEN_MODES, default="exact",
                        help="exact keeps raw WCIDs/model IDs; abstract_ace collapses ACE WCIDs into structural classes")
    return parser.parse_args()


def main():
    args = parse_args()

    print("=" * 72)
    print("  Component-Linked Tensor Extractor")
    print("=" * 72)
    print(f"  Raw facts     : {args.raw_jsonl}")
    print(f"  Components    : {args.component_jsonl}")
    print(f"  Output NPZ    : {args.out_npz}")
    print(f"  Output vocab  : {args.out_vocab}")
    print(f"  Token mode    : {args.target_token_mode}")
    print()

    if not os.path.exists(args.raw_jsonl):
        raise SystemExit(f"Missing raw facts JSONL: {args.raw_jsonl}")
    if not os.path.exists(args.component_jsonl):
        raise SystemExit(f"Missing component JSONL: {args.component_jsonl}")

    print("[1/4] Streaming JSONL inputs...")
    rows_by_component = defaultdict(list)
    stats_by_component = defaultdict(_empty_stats)
    component_entries, component_class_keys, component_count, static_rows_emitted = scan_component_jsonl(
        args.component_jsonl, args.target_token_mode,
        rows_by_component, stats_by_component,
    )
    rows_by_lb, stats_by_lb, _rbc_unused, _sbc_unused, raw_class_keys, raw_count = scan_raw_jsonl(
        args.raw_jsonl, args.target_token_mode,
    )
    # Merge ACE-dynamic interior rows from raw_world_facts into the per-component
    # containers populated by scan_component_jsonl.
    for cid, rows in _rbc_unused.items():
        rows_by_component[cid].extend(rows)
    for cid, stats in _sbc_unused.items():
        merged = stats_by_component[cid]
        for key, value in stats.items():
            merged[key] = merged.get(key, 0) + value
    print(f"  Raw rows                  : {raw_count:,}")
    print(f"  Components                : {component_count:,}")
    print(f"  Static interior rows      : {static_rows_emitted:,}")
    print(f"  Interior comps with rows  : {len(rows_by_component):,}  (was 7,092 with ACE-only)")
    print()

    print("[2/4] Building vocabulary + component tables...")
    class_key_to_idx, idx_to_key = build_class_vocab(raw_class_keys | component_class_keys)
    component_data = build_component_tables(component_entries, class_key_to_idx)
    print(f"  Vocab size    : {len(class_key_to_idx) + FIRST_REAL_TOKEN:,}")
    print()

    print("[3/4] Building unified tensors (landblock + component)...")
    lb_data = build_unified_tensors(
        rows_by_lb,
        stats_by_lb,
        rows_by_component,
        stats_by_component,
        class_key_to_idx,
        component_data,
        args.views_per_landblock,
    )
    print(f"  Landblocks emitted    : {lb_data['landblocks_emitted']:,}")
    print(f"  Landblock examples    : {lb_data['landblock_examples']:,}")
    print(f"  Components emitted    : {lb_data['components_emitted']:,}")
    print(f"  Component examples    : {lb_data['component_examples']:,}")
    print(f"  Components w/o table  : {lb_data['components_skipped_unknown_id']:,}")
    print(f"  Components empty rows : {lb_data['components_skipped_empty']:,}")
    print(f"  Total examples        : {len(lb_data['contexts']):,}")
    print(f"  Views / LB            : {lb_data['views_per_landblock']}")
    print(f"  Linked objs           : {lb_data['linked_objects']:,}")
    print(f"  Chunked views         : {lb_data['chunked_views']:,}")
    print(f"  Max chunks/view       : {lb_data['max_chunks_per_view']}")
    print(f"  Context dim           : {EXTENDED_CONTEXT_DIM}")
    print()

    print("[4/4] Saving outputs...")
    save_outputs(args.out_npz, args.out_vocab, class_key_to_idx, idx_to_key, lb_data, component_data, args.target_token_mode)
    size_mb = os.path.getsize(args.out_npz) / 1024 / 1024
    print(f"  NPZ size      : {size_mb:.1f} MB")
    print("  Done.")


if __name__ == "__main__":
    main()

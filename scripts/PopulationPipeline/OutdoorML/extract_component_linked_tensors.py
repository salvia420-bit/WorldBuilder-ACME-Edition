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
DEFAULT_OUT_NPZ = os.path.join(REFERENCE_DIR, "component_linked_tensors.npz")
DEFAULT_OUT_VOCAB = os.path.join(REFERENCE_DIR, "component_linked_vocab.json")

LB_SIZE = 192.0
MAX_OBJECTS_PER_LB = 256
OBJECT_FEATURE_DIM = 14

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


def scan_component_jsonl(path, target_token_mode):
    component_entries = []
    component_class_keys = set()
    component_count = 0

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
        component_entries.append({
            "component_id": int(row["componentId"]),
            "component_kind": COMPONENT_KIND_CODES.get(row.get("componentKind"), 0),
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
        if component_count % COMPONENT_SCAN_PROGRESS_EVERY == 0:
            print(f"  Components scanned: {component_count:,}")

    return component_entries, component_class_keys, component_count


def scan_raw_jsonl(path, target_token_mode):
    raw_class_keys = set()
    rows_by_lb = defaultdict(list)
    stats_by_lb = defaultdict(lambda: {
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
    })
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

        rows_by_lb[lb_key].append((
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
        ))

        stats = stats_by_lb[lb_key]
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

        if raw_count % RAW_SCAN_PROGRESS_EVERY == 0:
            print(f"  Raw rows scanned: {raw_count:,}")

    return rows_by_lb, stats_by_lb, raw_class_keys, raw_count


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


def build_landblock_tensors(rows_by_lb, stats_by_lb, class_key_to_idx, component_id_to_index, views_per_landblock):
    populated_lbs = sorted(rows_by_lb.keys())
    view_count = max(1, min(int(views_per_landblock), len(VIEW_STRATEGIES)))
    chunk_capacity = MAX_OBJECTS_PER_LB - 1
    contexts = []
    sequences = []
    seq_lengths = []
    component_index_by_object = []
    lb_coords = []
    sample_weights = []
    structural_weights = build_structural_weights(populated_lbs, stats_by_lb)

    linked_objects = 0
    chunked_views = 0
    max_chunks_per_view = 1

    for lb_idx, (lb_x, lb_y) in enumerate(populated_lbs):
        rows = rows_by_lb[(lb_x, lb_y)]
        stats = stats_by_lb[(lb_x, lb_y)]
        row_count = max(stats["count"], 1)
        base_context = np.array([
            lb_x / 254.0,
            lb_y / 254.0,
            len(rows) / MAX_OBJECTS_PER_LB,
            stats["dat_count"] / row_count,
            stats["ace_count"] / row_count,
            stats["model_id_count"] / row_count,
            stats["wcid_count"] / row_count,
            stats["linked_count"] / row_count,
            stats["interior_count"] / row_count,
            stats["terrain_delta_sum"] / row_count,
            (stats["slope_sum"] / row_count) / 90.0,
            stats["parent_count_sum"] / row_count,
            stats["child_count_sum"] / row_count,
            stats["building_count"] / row_count,
            stats["encounter_count"] / row_count,
            stats["instance_count"] / row_count,
        ], dtype=np.float32)

        for view_idx in range(view_count):
            strategy = VIEW_STRATEGIES[view_idx]
            ordered_rows = sorted_view_rows(rows, strategy)
            chunk_offsets = compute_chunk_offsets(len(ordered_rows), chunk_capacity)
            if len(chunk_offsets) > 1:
                chunked_views += 1
            max_chunks_per_view = max(max_chunks_per_view, len(chunk_offsets))

            for chunk_idx, start in enumerate(chunk_offsets):
                chunk_rows = ordered_rows[start:start + chunk_capacity]
                seq = np.zeros((MAX_OBJECTS_PER_LB, OBJECT_FEATURE_DIM), dtype=np.float32)
                comp_idx = np.full(MAX_OBJECTS_PER_LB, -1, dtype=np.int32)
                ctx = np.zeros(20, dtype=np.float32)
                ctx[:16] = base_context
                ctx[16] = view_idx / max(view_count - 1, 1)
                ctx[17] = VIEW_STRATEGIES.index(strategy) / max(len(VIEW_STRATEGIES) - 1, 1)
                ctx[18] = chunk_idx / max(len(chunk_offsets) - 1, 1)
                ctx[19] = len(chunk_rows) / max(len(ordered_rows), 1)

                for obj_idx, row in enumerate(chunk_rows):
                    class_space = row[4]
                    class_id = row[5]
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
                    class_key = canonical_key
                    class_token = class_key_to_idx.get(class_key, PAD_TOKEN)
                    local_x = row[0]
                    local_y = row[1]
                    z = row[2]
                    is_interior = 1.0 if cell_id >= 0x0100 else 0.0

                    seq[obj_idx] = np.array([
                        float(class_token),
                        float(class_space_code),
                        local_x / LB_SIZE,
                        local_y / LB_SIZE,
                        z / 512.0,
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
                        comp_idx[obj_idx] = component_id_to_index.get(component_id, -1)
                        if comp_idx[obj_idx] >= 0:
                            linked_objects += 1

                stop_index = len(chunk_rows)
                seq[stop_index, 0] = STOP_TOKEN

                contexts.append(ctx)
                sequences.append(seq)
                seq_lengths.append(stop_index + 1)
                component_index_by_object.append(comp_idx)
                lb_coords.append((lb_x, lb_y))
                sample_weights.append(structural_weights[lb_idx])

    return {
        "populated_lbs": populated_lbs,
        "contexts": np.asarray(contexts, dtype=np.float32),
        "sequences": np.asarray(sequences, dtype=np.float32),
        "seq_lengths": np.asarray(seq_lengths, dtype=np.int32),
        "component_index_by_object": np.asarray(component_index_by_object, dtype=np.int32),
        "lb_coords": np.asarray(lb_coords, dtype=np.int16),
        "sample_weights": np.asarray(sample_weights, dtype=np.float32),
        "linked_objects": linked_objects,
        "views_per_landblock": view_count,
        "chunked_views": chunked_views,
        "max_chunks_per_view": max_chunks_per_view,
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
        "object_feature_dim": OBJECT_FEATURE_DIM,
        "max_objects_per_lb": MAX_OBJECTS_PER_LB,
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
    component_entries, component_class_keys, component_count = scan_component_jsonl(args.component_jsonl, args.target_token_mode)
    rows_by_lb, stats_by_lb, raw_class_keys, raw_count = scan_raw_jsonl(args.raw_jsonl, args.target_token_mode)
    print(f"  Raw rows      : {raw_count:,}")
    print(f"  Components    : {component_count:,}")
    print()

    print("[2/4] Building vocabulary + component tables...")
    class_key_to_idx, idx_to_key = build_class_vocab(raw_class_keys | component_class_keys)
    component_data = build_component_tables(component_entries, class_key_to_idx)
    print(f"  Vocab size    : {len(class_key_to_idx) + FIRST_REAL_TOKEN:,}")
    print()

    print("[3/4] Building landblock tensors...")
    lb_data = build_landblock_tensors(
        rows_by_lb,
        stats_by_lb,
        class_key_to_idx,
        component_data["component_id_to_index"],
        args.views_per_landblock,
    )
    print(f"  Landblocks    : {len(lb_data['populated_lbs']):,}")
    print(f"  Examples      : {len(lb_data['contexts']):,}")
    print(f"  Views / LB    : {lb_data['views_per_landblock']}")
    print(f"  Linked objs   : {lb_data['linked_objects']:,}")
    print(f"  Chunked views : {lb_data['chunked_views']:,}")
    print(f"  Max chunks/view: {lb_data['max_chunks_per_view']}")
    print()

    print("[4/4] Saving outputs...")
    save_outputs(args.out_npz, args.out_vocab, class_key_to_idx, idx_to_key, lb_data, component_data, args.target_token_mode)
    size_mb = os.path.getsize(args.out_npz) / 1024 / 1024
    print(f"  NPZ size      : {size_mb:.1f} MB")
    print("  Done.")


if __name__ == "__main__":
    main()

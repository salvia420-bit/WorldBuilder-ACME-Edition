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

DEFAULT_RAW_JSONL = os.path.join(REFERENCE_DIR, "raw_world_facts_full.jsonl")
DEFAULT_COMPONENT_JSONL = os.path.join(REFERENCE_DIR, "envcell_components_full.jsonl")
DEFAULT_OUT_NPZ = os.path.join(REFERENCE_DIR, "component_linked_tensors.npz")
DEFAULT_OUT_VOCAB = os.path.join(REFERENCE_DIR, "component_linked_vocab.json")

LB_SIZE = 192.0
MAX_OBJECTS_PER_LB = 256
OBJECT_FEATURE_DIM = 14

PAD_TOKEN = 0
STOP_TOKEN = 1
FIRST_REAL_TOKEN = 2

SOURCE_DB_CODES = {"dat": 1, "ace": 2}
CLASS_SPACE_CODES = {"model_id": 1, "wcid": 2}
COMPONENT_KIND_CODES = {
    None: 0,
    "surface_anchor_component": 1,
    "unanchored_envcell_component": 2,
}

RAW_SCAN_PROGRESS_EVERY = 100000
COMPONENT_SCAN_PROGRESS_EVERY = 10000


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


def scan_component_jsonl(path):
    component_entries = []
    component_class_keys = set()
    component_count = 0

    for component_count, row in enumerate(iter_jsonl(path), start=1):
        anchor = row.get("anchor") or {}
        anchor_class_space = anchor.get("classIdSpace")
        anchor_class_id = int(anchor["classId"]) if anchor.get("classId") is not None else None
        if anchor_class_space is not None and anchor_class_id is not None:
            component_class_keys.add((anchor_class_space, anchor_class_id))

        bounds = row.get("boundsLocal") or {}
        component_entries.append({
            "component_id": int(row["componentId"]),
            "component_kind": COMPONENT_KIND_CODES.get(row.get("componentKind"), 0),
            "landblock_x": int(row["landblockX"]),
            "landblock_y": int(row["landblockY"]),
            "cell_count": int(row.get("cellCount", 0)),
            "static_object_count": int(row.get("staticObjectCount", 0)),
            "entry_count": len(anchor.get("entryCellIds", [])),
            "anchor_class_key": (anchor_class_space, anchor_class_id) if anchor_class_space is not None and anchor_class_id is not None else None,
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


def scan_raw_jsonl(path):
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
        if class_space is not None and class_id is not None:
            raw_class_keys.add((class_space, class_id))

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


def build_landblock_tensors(rows_by_lb, stats_by_lb, class_key_to_idx, component_id_to_index):
    populated_lbs = sorted(rows_by_lb.keys())
    contexts = np.zeros((len(populated_lbs), 16), dtype=np.float32)
    sequences = np.zeros((len(populated_lbs), MAX_OBJECTS_PER_LB, OBJECT_FEATURE_DIM), dtype=np.float32)
    seq_lengths = np.zeros(len(populated_lbs), dtype=np.int32)
    component_index_by_object = np.full((len(populated_lbs), MAX_OBJECTS_PER_LB), -1, dtype=np.int32)

    dropped_objects = 0
    linked_objects = 0

    for lb_idx, (lb_x, lb_y) in enumerate(populated_lbs):
        rows = rows_by_lb[(lb_x, lb_y)]
        rows.sort(key=lambda row: (row[0], row[1], row[2], row[3]))
        stats = stats_by_lb[(lb_x, lb_y)]
        row_count = max(stats["count"], 1)

        contexts[lb_idx] = np.array([
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

        n = min(len(rows), MAX_OBJECTS_PER_LB - 1)
        for obj_idx, row in enumerate(rows[:n]):
            class_space = row[4]
            class_id = row[5]
            class_space_code = row[6]
            yaw_rad = math.radians(row[7])
            type_id = row[8]
            source_db_code = row[9]
            cell_id = row[10]
            terrain_delta_z = row[11]
            slope_deg = row[12]
            component_kind_code = row[13]
            component_id = row[14]
            class_key = (class_space, class_id) if class_space is not None and class_id is not None else None
            class_token = class_key_to_idx.get(class_key, PAD_TOKEN)
            local_x = row[0]
            local_y = row[1]
            z = row[2]
            is_interior = 1.0 if cell_id >= 0x0100 else 0.0

            sequences[lb_idx, obj_idx] = np.array([
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
                component_index_by_object[lb_idx, obj_idx] = component_id_to_index.get(component_id, -1)
                if component_index_by_object[lb_idx, obj_idx] >= 0:
                    linked_objects += 1

        if len(rows) >= MAX_OBJECTS_PER_LB:
            dropped_objects += len(rows) - (MAX_OBJECTS_PER_LB - 1)

        sequences[lb_idx, n, 0] = STOP_TOKEN
        seq_lengths[lb_idx] = n + 1

    return {
        "populated_lbs": populated_lbs,
        "contexts": contexts,
        "sequences": sequences,
        "seq_lengths": seq_lengths,
        "component_index_by_object": component_index_by_object,
        "dropped_objects": dropped_objects,
        "linked_objects": linked_objects,
    }


def save_outputs(out_npz, out_vocab, class_key_to_idx, idx_to_key, lb_data, component_data):
    os.makedirs(os.path.dirname(out_npz), exist_ok=True)

    np.savez_compressed(
        out_npz,
        contexts=lb_data["contexts"],
        sequences=lb_data["sequences"],
        seq_lengths=lb_data["seq_lengths"],
        lb_coords=np.array(lb_data["populated_lbs"], dtype=np.int16),
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
    }
    with open(out_vocab, "w", encoding="utf-8") as f:
        json.dump(vocab, f, indent=2)


def parse_args():
    parser = argparse.ArgumentParser(description="Build component-linked tensors from raw world facts + EnvCell components.")
    parser.add_argument("--raw-jsonl", default=DEFAULT_RAW_JSONL, help="Path to export-raw-world-facts JSONL")
    parser.add_argument("--component-jsonl", default=DEFAULT_COMPONENT_JSONL, help="Path to export-envcell-components JSONL")
    parser.add_argument("--out-npz", default=DEFAULT_OUT_NPZ, help="Output NPZ path")
    parser.add_argument("--out-vocab", default=DEFAULT_OUT_VOCAB, help="Output vocab JSON path")
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
    print()

    if not os.path.exists(args.raw_jsonl):
        raise SystemExit(f"Missing raw facts JSONL: {args.raw_jsonl}")
    if not os.path.exists(args.component_jsonl):
        raise SystemExit(f"Missing component JSONL: {args.component_jsonl}")

    print("[1/4] Streaming JSONL inputs...")
    component_entries, component_class_keys, component_count = scan_component_jsonl(args.component_jsonl)
    rows_by_lb, stats_by_lb, raw_class_keys, raw_count = scan_raw_jsonl(args.raw_jsonl)
    print(f"  Raw rows      : {raw_count:,}")
    print(f"  Components    : {component_count:,}")
    print()

    print("[2/4] Building vocabulary + component tables...")
    class_key_to_idx, idx_to_key = build_class_vocab(raw_class_keys | component_class_keys)
    component_data = build_component_tables(component_entries, class_key_to_idx)
    print(f"  Vocab size    : {len(class_key_to_idx) + FIRST_REAL_TOKEN:,}")
    print()

    print("[3/4] Building landblock tensors...")
    lb_data = build_landblock_tensors(rows_by_lb, stats_by_lb, class_key_to_idx, component_data["component_id_to_index"])
    print(f"  Landblocks    : {len(lb_data['populated_lbs']):,}")
    print(f"  Linked objs   : {lb_data['linked_objects']:,}")
    print(f"  Dropped objs  : {lb_data['dropped_objects']:,}")
    print()

    print("[4/4] Saving outputs...")
    save_outputs(args.out_npz, args.out_vocab, class_key_to_idx, idx_to_key, lb_data, component_data)
    size_mb = os.path.getsize(args.out_npz) / 1024 / 1024
    print(f"  NPZ size      : {size_mb:.1f} MB")
    print("  Done.")


if __name__ == "__main__":
    main()

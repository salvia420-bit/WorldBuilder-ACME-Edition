#!/usr/bin/env python3
"""
build_atlas_context.py
======================

Combines V6 objectives O2 (feature vocabs) and O3 (tensor augmentation):

  1. Pass 1 over atlas_describe_v1.jsonl — tally each categorical/multi-hot
     vocab, take top-N by frequency, reserve id 0 for <UNK/missing>, write
     atlas_feature_vocabs_v1.json.

  2. Pass 2 — for every row in component_linked_unified_v4_tensors.npz,
     look up the LB's atlas record and produce four aligned arrays:
       atlas_ids[N, 8]          int32
       atlas_scalars[N, 5]      float32
       atlas_poi_categories[N, 32]  float32
       atlas_material_tags[N, 16]   float32

     Row order is preserved — existing seq_lengths, sequences, sample_weights,
     lb_coords align without reshuffling. LBs missing from the atlas dump
     fall back to all-UNK / all-zero.

  3. Writes component_linked_unified_v5_atlas_tensors.npz (V4 keys +
     atlas arrays) and component_linked_unified_v5_atlas_vocab.json (V4
     vocab + an "atlas" block carrying feature_dims, embedding_dims,
     vocab_caps, and the atlas_feature_vocabs payload).

V6 schema:

  Categorical (id-table → embedding inside trainer):
    regionName            cap  80, embed 16
    townName              cap 256, embed 16
    culture               cap  16, embed  8
    biome                 cap  24, embed  8
    settlementHint        cap  12, embed  4
    dominantArchitecture  cap  24, embed  8
    struct_architecture   cap  24, embed  8  (mode over body_structures)
    struct_roofShape      cap  16, embed  4  (mode over body_structures)

  Scalars / bool / multi-hot:
    hasRoad                 1 dim
    biomeConfidence         1 dim   (clipped [0,1])
    log1p(structureCount)   1 dim
    log1p(knownPoiCount)    1 dim
    gazetteerNotes_present  1 dim
    poi_categories         32 dim   (multi-hot, top-32 by freq)
    material_tags          16 dim   (multi-hot, top-16 by freq, union of top-3 structures)

Embedding output width (post-trainer): 16+16+8+8+4+8+8+4 = 72
Scalar/bool/multi-hot block: 1+1+1+1+1+32+16 = 53
EXTENDED_CONTEXT_DIM(V6) = 31 (V4 base) + 72 + 53 = 156
"""

import argparse
import json
import os
import sys
from collections import Counter
from typing import Iterable

import numpy as np


CATEGORICAL_FIELDS = (
    # (vocab_key, source_path_in_atlas_json, vocab_cap, embed_dim)
    ("regionName",           ("context", "regionName"),            80, 16),
    ("townName",             ("context", "townName"),             256, 16),
    ("culture",              ("context", "culture"),               16,  8),
    ("biome",                ("context", "biome"),                 24,  8),
    ("settlementHint",       ("context", "settlementHint"),        12,  4),
    ("dominantArchitecture", ("context", "dominantArchitecture"),  24,  8),
    ("struct_architecture",  ("__structures_mode__", "architecture"), 24, 8),
    ("struct_roofShape",     ("__structures_mode__", "roofShape"),  16,  4),
)

POI_CATEGORIES_KEY = "poi_categories"
POI_CATEGORIES_CAP = 32
MATERIAL_TAGS_KEY = "material_tags"
MATERIAL_TAGS_CAP = 16

CATEGORICAL_ORDER = [name for name, *_ in CATEGORICAL_FIELDS]


def _get_path(d: dict, path: tuple[str, ...]):
    cur = d
    for p in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(p)
    return cur


def _structure_mode(structs: list[dict], field: str) -> str | None:
    if not structs:
        return None
    counts: Counter = Counter()
    for s in structs:
        v = s.get(field)
        if v:
            counts[v] += 1
    if not counts:
        return None
    return counts.most_common(1)[0][0]


def _structure_material_tags(structs: list[dict]) -> list[str]:
    tags: list[str] = []
    for s in structs[:3]:
        for m in (s.get("materialTags") or []):
            if m:
                tags.append(m)
    return tags


def _structure_poi_categories(record: dict) -> list[str]:
    cats: list[str] = []
    for poi in (record.get("context", {}).get("knownPois") or []):
        for c in (poi.get("categories") or []):
            if c:
                cats.append(c)
    return cats


def iter_atlas(path: str) -> Iterable[dict]:
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            yield json.loads(line)


def _value_for_field(record: dict, source_path: tuple[str, ...]) -> str | None:
    if source_path[0] == "__structures_mode__":
        structs = record.get("body_structures") or []
        return _structure_mode(structs, source_path[1])
    return _get_path(record, source_path)


def build_vocabs(atlas_path: str) -> dict:
    print(f"[build_atlas] Pass 1: building vocabs from {atlas_path}", file=sys.stderr)
    cat_counters: dict[str, Counter] = {name: Counter() for name, *_ in CATEGORICAL_FIELDS}
    poi_counter: Counter = Counter()
    mat_counter: Counter = Counter()
    n_rows = 0
    for rec in iter_atlas(atlas_path):
        n_rows += 1
        for vocab_key, src_path, _cap, _embed in CATEGORICAL_FIELDS:
            v = _value_for_field(rec, src_path)
            if isinstance(v, str) and v:
                cat_counters[vocab_key][v] += 1
        for c in _structure_poi_categories(rec):
            poi_counter[c] += 1
        for m in _structure_material_tags(rec.get("body_structures") or []):
            mat_counter[m] += 1
    print(f"[build_atlas]   scanned {n_rows:,} rows", file=sys.stderr)

    vocabs: dict = {}
    for vocab_key, _src, cap, embed in CATEGORICAL_FIELDS:
        top = [v for v, _c in cat_counters[vocab_key].most_common(cap - 1)]
        values = ["<UNK>"] + top
        vocabs[vocab_key] = {
            "unk_id": 0,
            "vocab_cap": cap,
            "embed_dim": embed,
            "values": values,
        }
        print(f"[build_atlas]   {vocab_key:25s} distinct={len(cat_counters[vocab_key])}, "
              f"kept={len(values)} (cap {cap})", file=sys.stderr)
    vocabs[POI_CATEGORIES_KEY] = {
        "vocab_cap": POI_CATEGORIES_CAP,
        "values": [v for v, _c in poi_counter.most_common(POI_CATEGORIES_CAP)],
    }
    vocabs[MATERIAL_TAGS_KEY] = {
        "vocab_cap": MATERIAL_TAGS_CAP,
        "values": [v for v, _c in mat_counter.most_common(MATERIAL_TAGS_CAP)],
    }
    print(f"[build_atlas]   poi_categories distinct={len(poi_counter)}, "
          f"kept={len(vocabs[POI_CATEGORIES_KEY]['values'])}", file=sys.stderr)
    print(f"[build_atlas]   material_tags  distinct={len(mat_counter)}, "
          f"kept={len(vocabs[MATERIAL_TAGS_KEY]['values'])}", file=sys.stderr)
    return vocabs


def _value_to_id(vocabs: dict, key: str, value) -> int:
    if not isinstance(value, str) or not value:
        return 0
    values = vocabs[key]["values"]
    try:
        return values.index(value)
    except ValueError:
        return 0


def build_atlas_arrays(atlas_path: str, lb_coords: np.ndarray, vocabs: dict):
    """Pass 2: emit aligned arrays for every row in lb_coords."""
    print(f"[build_atlas] Pass 2: indexing atlas by LB", file=sys.stderr)
    atlas_by_lb: dict[tuple[int, int], dict] = {}
    for rec in iter_atlas(atlas_path):
        atlas_by_lb[(int(rec["lbX"]), int(rec["lbY"]))] = rec
    print(f"[build_atlas]   indexed {len(atlas_by_lb):,} LBs", file=sys.stderr)

    poi_index = {v: i for i, v in enumerate(vocabs[POI_CATEGORIES_KEY]["values"])}
    mat_index = {v: i for i, v in enumerate(vocabs[MATERIAL_TAGS_KEY]["values"])}

    n = len(lb_coords)
    ids = np.zeros((n, len(CATEGORICAL_FIELDS)), dtype=np.int32)
    scalars = np.zeros((n, 5), dtype=np.float32)
    poi_mh = np.zeros((n, POI_CATEGORIES_CAP), dtype=np.float32)
    mat_mh = np.zeros((n, MATERIAL_TAGS_CAP), dtype=np.float32)

    miss = 0
    for i in range(n):
        x, y = int(lb_coords[i, 0]), int(lb_coords[i, 1])
        rec = atlas_by_lb.get((x, y))
        if rec is None:
            miss += 1
            continue
        for j, (vocab_key, src_path, _cap, _embed) in enumerate(CATEGORICAL_FIELDS):
            v = _value_for_field(rec, src_path)
            ids[i, j] = _value_to_id(vocabs, vocab_key, v)

        ctx = rec.get("context", {}) or {}
        scalars[i, 0] = 1.0 if ctx.get("hasRoad") else 0.0
        bc = ctx.get("biomeConfidence")
        try:
            scalars[i, 1] = float(min(1.0, max(0.0, bc))) if bc is not None else 0.0
        except (TypeError, ValueError):
            scalars[i, 1] = 0.0
        sc = ctx.get("structureCount") or 0
        scalars[i, 2] = float(np.log1p(max(0, int(sc))))
        kp = ctx.get("knownPoiCount") or 0
        scalars[i, 3] = float(np.log1p(max(0, int(kp))))
        gn = ctx.get("gazetteerNotes")
        scalars[i, 4] = 1.0 if (isinstance(gn, str) and gn) else 0.0

        for c in _structure_poi_categories(rec):
            j = poi_index.get(c)
            if j is not None:
                poi_mh[i, j] = 1.0
        for m in _structure_material_tags(rec.get("body_structures") or []):
            j = mat_index.get(m)
            if j is not None:
                mat_mh[i, j] = 1.0

    print(f"[build_atlas]   missing-from-atlas rows: {miss}/{n}", file=sys.stderr)
    return ids, scalars, poi_mh, mat_mh, miss


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--atlas", default="pipeline_data/reference/atlas_describe_v1.jsonl")
    ap.add_argument("--v4-tensors",
                    default="pipeline_data/reference/component_linked_unified_v4_tensors.npz")
    ap.add_argument("--v4-vocab",
                    default="pipeline_data/reference/component_linked_unified_v4_vocab.json")
    ap.add_argument("--out-tensors",
                    default="pipeline_data/reference/component_linked_unified_v5_atlas_tensors.npz")
    ap.add_argument("--out-vocab",
                    default="pipeline_data/reference/component_linked_unified_v5_atlas_vocab.json")
    ap.add_argument("--out-feature-vocabs",
                    default="pipeline_data/reference/atlas_feature_vocabs_v1.json")
    args = ap.parse_args()

    if not os.path.exists(args.atlas):
        print(f"[build_atlas] ERROR: atlas file not found: {args.atlas}", file=sys.stderr)
        return 1

    vocabs = build_vocabs(args.atlas)
    os.makedirs(os.path.dirname(args.out_feature_vocabs), exist_ok=True)
    with open(args.out_feature_vocabs, "w", encoding="utf-8") as f:
        json.dump(vocabs, f, ensure_ascii=False, indent=2)
    print(f"[build_atlas] wrote {args.out_feature_vocabs}", file=sys.stderr)

    print(f"[build_atlas] loading V4 tensors from {args.v4_tensors}", file=sys.stderr)
    v4 = np.load(args.v4_tensors, allow_pickle=False)
    lb_coords = v4["lb_coords"]
    print(f"[build_atlas]   {len(lb_coords):,} rows", file=sys.stderr)

    ids, scalars, poi_mh, mat_mh, miss = build_atlas_arrays(args.atlas, lb_coords, vocabs)

    print(f"[build_atlas] writing {args.out_tensors}", file=sys.stderr)
    out = {k: v4[k] for k in v4.files}
    out["atlas_ids"] = ids
    out["atlas_scalars"] = scalars
    out["atlas_poi_categories"] = poi_mh
    out["atlas_material_tags"] = mat_mh
    np.savez(args.out_tensors, **out)
    print(f"[build_atlas]   atlas_ids        shape={ids.shape} dtype={ids.dtype}", file=sys.stderr)
    print(f"[build_atlas]   atlas_scalars    shape={scalars.shape} dtype={scalars.dtype}", file=sys.stderr)
    print(f"[build_atlas]   atlas_poi_categories shape={poi_mh.shape}", file=sys.stderr)
    print(f"[build_atlas]   atlas_material_tags  shape={mat_mh.shape}", file=sys.stderr)

    print(f"[build_atlas] writing {args.out_vocab}", file=sys.stderr)
    with open(args.v4_vocab, "r", encoding="utf-8") as f:
        v4_vocab = json.load(f)
    v4_vocab.setdefault("context_feature_names", [])
    feature_dims = {
        "atlas_ids": list(ids.shape[1:]),
        "atlas_scalars": list(scalars.shape[1:]),
        "atlas_poi_categories": list(poi_mh.shape[1:]),
        "atlas_material_tags": list(mat_mh.shape[1:]),
    }
    embedding_dims = {name: embed for name, _src, _cap, embed in CATEGORICAL_FIELDS}
    vocab_caps = {name: cap for name, _src, cap, _embed in CATEGORICAL_FIELDS}
    v4_vocab["atlas"] = {
        "categorical_field_order": CATEGORICAL_ORDER,
        "feature_dims": feature_dims,
        "embedding_dims": embedding_dims,
        "vocab_caps": vocab_caps,
        "scalar_field_order": [
            "hasRoad", "biomeConfidence",
            "log1p_structureCount", "log1p_knownPoiCount",
            "gazetteerNotes_present",
        ],
        "poi_categories_cap": POI_CATEGORIES_CAP,
        "material_tags_cap": MATERIAL_TAGS_CAP,
        "missing_atlas_rows": int(miss),
        "feature_vocabs": vocabs,
    }
    with open(args.out_vocab, "w", encoding="utf-8") as f:
        json.dump(v4_vocab, f, ensure_ascii=False, indent=2)
    print(f"[build_atlas] done", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

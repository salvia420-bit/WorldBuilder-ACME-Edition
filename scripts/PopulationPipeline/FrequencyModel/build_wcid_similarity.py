#!/usr/bin/env python3
"""
build_wcid_similarity.py
========================

Build a label-free WCID similarity artifact from retail landblock co-presence.

Each WCID is represented by the set of landblocks it appears in. Similarity is
computed with cosine similarity over binary landblock membership:

    sim(a, b) = shared_landblocks(a, b) / sqrt(df(a) * df(b))

Only top-k similar neighbors are retained for each WCID.
"""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter, defaultdict
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[3]
REFERENCE_DIR = BASE_DIR / "pipeline_data" / "reference"

DEFAULT_LANDBLOCK_REFERENCE_JSON = REFERENCE_DIR / "dereth_landblock_reference_counts.json"
DEFAULT_OUTPUT_JSON = REFERENCE_DIR / "dereth_wcid_similarity.json"


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build WCID similarity from retail landblock co-presence.")
    parser.add_argument("--landblock-reference-json", type=Path, default=DEFAULT_LANDBLOCK_REFERENCE_JSON)
    parser.add_argument("--out-json", type=Path, default=DEFAULT_OUTPUT_JSON)
    parser.add_argument("--top-k", type=int, default=24)
    parser.add_argument("--min-shared-landblocks", type=int, default=2)
    parser.add_argument("--min-similarity", type=float, default=0.08)
    parser.add_argument(
        "--max-unique-per-landblock",
        type=int,
        default=64,
        help="Skip extremely dense landblocks beyond this many unique WCIDs to avoid noisy pair explosions",
    )
    return parser.parse_args()


def build_similarity(reference_doc: dict, top_k: int, min_shared_landblocks: int, min_similarity: float, max_unique_per_landblock: int) -> dict:
    landblocks = reference_doc["landblocks"]
    document_frequency: Counter[int] = Counter()
    pair_shared: Counter[tuple[int, int]] = Counter()
    skipped_dense_landblocks = 0

    for rows in landblocks.values():
        wcids = sorted(int(wcid) for wcid in rows.keys())
        if not wcids:
            continue
        for wcid in wcids:
            document_frequency[wcid] += 1
        if len(wcids) > max_unique_per_landblock:
            skipped_dense_landblocks += 1
            continue
        for idx, left in enumerate(wcids):
            for right in wcids[idx + 1 :]:
                pair_shared[(left, right)] += 1

    neighbors: dict[int, list[dict]] = defaultdict(list)
    for (left, right), shared in pair_shared.items():
        if shared < min_shared_landblocks:
            continue
        left_df = document_frequency[left]
        right_df = document_frequency[right]
        if left_df == 0 or right_df == 0:
            continue
        similarity = shared / math.sqrt(left_df * right_df)
        if similarity < min_similarity:
            continue
        left_row = {
            "wcid": right,
            "similarity": round(similarity, 6),
            "shared_landblocks": shared,
            "other_document_frequency": right_df,
        }
        right_row = {
            "wcid": left,
            "similarity": round(similarity, 6),
            "shared_landblocks": shared,
            "other_document_frequency": left_df,
        }
        neighbors[left].append(left_row)
        neighbors[right].append(right_row)

    sparse_neighbors = {}
    for wcid, rows in neighbors.items():
        sparse_neighbors[str(wcid)] = sorted(
            rows,
            key=lambda row: (row["similarity"], row["shared_landblocks"], -row["other_document_frequency"]),
            reverse=True,
        )[:top_k]

    return {
        "metadata": {
            "source_landblock_reference": str(DEFAULT_LANDBLOCK_REFERENCE_JSON),
            "landblock_count": len(landblocks),
            "unique_wcid_count": len(document_frequency),
            "pair_count": len(pair_shared),
            "skipped_dense_landblocks": skipped_dense_landblocks,
            "top_k": top_k,
            "min_shared_landblocks": min_shared_landblocks,
            "min_similarity": min_similarity,
            "max_unique_per_landblock": max_unique_per_landblock,
            "formula": "shared_landblocks(a,b) / sqrt(df(a) * df(b))",
        },
        "document_frequency": {str(wcid): int(df) for wcid, df in document_frequency.items()},
        "similarity": sparse_neighbors,
    }


def main() -> None:
    args = parse_args()
    reference_doc = load_json(args.landblock_reference_json)
    result = build_similarity(
        reference_doc=reference_doc,
        top_k=args.top_k,
        min_shared_landblocks=args.min_shared_landblocks,
        min_similarity=args.min_similarity,
        max_unique_per_landblock=args.max_unique_per_landblock,
    )
    args.out_json.parent.mkdir(parents=True, exist_ok=True)
    with args.out_json.open("w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)
    print(
        json.dumps(
            {
                "out_json": str(args.out_json),
                "unique_wcid_count": result["metadata"]["unique_wcid_count"],
                "pair_count": result["metadata"]["pair_count"],
                "sparse_neighbor_count": len(result["similarity"]),
                "skipped_dense_landblocks": result["metadata"]["skipped_dense_landblocks"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()

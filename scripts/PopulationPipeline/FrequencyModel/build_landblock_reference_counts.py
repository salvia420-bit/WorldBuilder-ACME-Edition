#!/usr/bin/env python3
"""
build_landblock_reference_counts.py
==================================

Build a sparse retail reference keyed by landblock for WCID counts.

This is used by the landblock-aware frequency evaluator so generated objects are
judged against what is locally present in retail Dereth, not only global counts.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[3]
REFERENCE_DIR = BASE_DIR / "pipeline_data" / "reference"

DEFAULT_RAW_FACTS = REFERENCE_DIR / "raw_world_facts_full_with_components_v2.jsonl"
DEFAULT_OUTPUT_JSON = REFERENCE_DIR / "dereth_landblock_reference_counts.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build sparse retail WCID counts per landblock.")
    parser.add_argument("--raw-facts", type=Path, default=DEFAULT_RAW_FACTS)
    parser.add_argument("--out-json", type=Path, default=DEFAULT_OUTPUT_JSON)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    by_landblock: dict[str, Counter[int]] = defaultdict(Counter)
    total_wcid_rows = 0

    with args.raw_facts.open("r", encoding="utf-8-sig") as f:
        for line in f:
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get("classIdSpace") != "wcid":
                continue
            class_id = row.get("classId")
            landblock_id = row.get("landblockId")
            if class_id is None or not landblock_id:
                continue
            by_landblock[str(landblock_id)] [int(class_id)] += 1
            total_wcid_rows += 1

    sparse = {
        landblock_id: {str(wcid): count for wcid, count in counter.items()}
        for landblock_id, counter in by_landblock.items()
    }

    doc = {
        "metadata": {
            "source": str(args.raw_facts),
            "landblock_count": len(sparse),
            "total_wcid_rows": total_wcid_rows,
        },
        "landblocks": sparse,
    }

    args.out_json.parent.mkdir(parents=True, exist_ok=True)
    with args.out_json.open("w", encoding="utf-8") as f:
        json.dump(doc, f)

    print(
        json.dumps(
            {
                "out_json": str(args.out_json),
                "landblock_count": len(sparse),
                "total_wcid_rows": total_wcid_rows,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()

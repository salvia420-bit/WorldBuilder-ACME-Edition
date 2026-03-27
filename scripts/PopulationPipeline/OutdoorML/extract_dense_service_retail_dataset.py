#!/usr/bin/env python3
"""
extract_dense_service_retail_dataset.py - Retail dense service benchmark set
===========================================================================

Extract dense, service-bearing retail landblocks into a compact dataset for
the next clustering/supervision pass. This is intentionally analysis-oriented:
it captures composition features and context so later scripts can derive
data-driven dense-town subtypes without reparsing the full retail SQL dump.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from extract_placement_tensors import (  # noqa: E402
    BASE_DIR,
    DEFAULT_RETAIL_SQL,
    DIFFICULTY_GRADIENT,
    HEIGHTS_PATH,
    build_context_vector,
    build_cultural_zones,
    load_difficulty_grid,
    load_height_grid,
    load_wcid_types,
    parse_retail_sql,
)
from housing_linker import classify_slumlord_house_type  # noqa: E402
from settlement_signatures import classify_service_style, classify_settlement_signature  # noqa: E402


OUTPUT_DIR = os.path.join(BASE_DIR, "pipeline_data", "reference")
DEFAULT_JSON_OUT = os.path.join(OUTPUT_DIR, "dense_service_retail_dataset.json")
DEFAULT_NPZ_OUT = os.path.join(OUTPUT_DIR, "dense_service_retail_dataset.npz")

FEATURE_LABELS = (
    "object_count",
    "unique_wcids",
    "creature_count",
    "portal_count",
    "vendor_count",
    "lifestone_count",
    "door_count",
    "housing_count",
    "service_count",
    "link_parent_count",
    "link_child_count",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract retail dense-service benchmark landblocks")
    parser.add_argument("--retail-sql", default=DEFAULT_RETAIL_SQL, help="Path to retail ACE world SQL dump")
    parser.add_argument("--dense-threshold", type=int, default=20, help="Minimum outdoor objects to count as dense")
    parser.add_argument("--json-out", default=DEFAULT_JSON_OUT, help="JSON output path")
    parser.add_argument("--npz-out", default=DEFAULT_NPZ_OUT, help="NPZ output path")
    return parser.parse_args()


def family_counts_for_landblock(insts: list[dict], wcid_types: dict[int, int]) -> Counter:
    counts: Counter[str] = Counter()
    for inst in insts:
        wcid = int(inst["wcid"])
        wtype = int(wcid_types.get(wcid, 0))
        if wtype == 10:
            counts["creature"] += 1
        elif wtype == 7:
            counts["portal"] += 1
        elif wtype == 12:
            counts["vendor"] += 1
        elif wtype == 25:
            counts["lifestone"] += 1
        elif wtype == 19:
            counts["door"] += 1
        elif wtype == 55:
            house_type = classify_slumlord_house_type(wcid)
            counts["housing"] += 1
            if house_type:
                counts[f"housing_{house_type.lower()}"] += 1
            else:
                counts["housing_unknown"] += 1
    return counts


def main() -> None:
    args = parse_args()
    if not os.path.exists(args.retail_sql):
        raise SystemExit(f"Retail SQL not found: {args.retail_sql}")

    print("=" * 72)
    print("  Retail Dense-Service Dataset Extractor")
    print("=" * 72)

    print("\n[1/4] Loading retail world data...")
    instances_by_lb, links, _ = parse_retail_sql(args.retail_sql)
    wcid_types = load_wcid_types(args.retail_sql)

    print("\n[2/4] Loading context inputs...")
    heights = load_height_grid(HEIGHTS_PATH)
    difficulty_grid = load_difficulty_grid(DIFFICULTY_GRADIENT)
    culture_grid = build_cultural_zones()

    parent_guids = {row["parent_guid"] for row in links}
    child_guids = {row["child_guid"] for row in links}
    instance_counts = {
        lb: sum(1 for inst in insts if not inst.get("is_indoor", False))
        for lb, insts in instances_by_lb.items()
    }

    print("\n[3/4] Building dense-service examples...")
    rows: list[dict] = []
    feature_rows: list[list[float]] = []
    context_rows: list[np.ndarray] = []

    for (lb_x, lb_y), raw_insts in sorted(instances_by_lb.items()):
        insts = [inst for inst in raw_insts if not inst.get("is_indoor", False)]
        if len(insts) < args.dense_threshold:
            continue

        counts = family_counts_for_landblock(insts, wcid_types)
        service_count = counts["portal"] + counts["vendor"] + counts["lifestone"]
        if service_count <= 0:
            continue

        family_labels = sorted(label for label, count in counts.items() if count > 0 and not label.startswith("housing_"))
        for house_label in ("housing_cottage", "housing_villa", "housing_mansion", "housing_unknown"):
            if counts[house_label] > 0:
                family_labels.append(house_label)
        signature = classify_settlement_signature(family_labels, len(insts))
        service_style = classify_service_style(family_labels)
        unique_wcids = len({int(inst["wcid"]) for inst in insts})
        link_parent_count = sum(1 for inst in insts if int(inst["guid"]) in parent_guids)
        link_child_count = sum(1 for inst in insts if int(inst["guid"]) in child_guids)

        row = {
            "lb_x": lb_x,
            "lb_y": lb_y,
            "object_count": len(insts),
            "unique_wcids": unique_wcids,
            "settlement_signature": signature,
            "service_style": service_style,
            "family_counts": {
                key: int(counts[key])
                for key in (
                    "creature",
                    "portal",
                    "vendor",
                    "lifestone",
                    "door",
                    "housing",
                    "housing_cottage",
                    "housing_villa",
                    "housing_mansion",
                    "housing_unknown",
                )
            },
            "link_parent_count": link_parent_count,
            "link_child_count": link_child_count,
        }
        rows.append(row)
        feature_rows.append(
            [
                float(len(insts)),
                float(unique_wcids),
                float(counts["creature"]),
                float(counts["portal"]),
                float(counts["vendor"]),
                float(counts["lifestone"]),
                float(counts["door"]),
                float(counts["housing"]),
                float(service_count),
                float(link_parent_count),
                float(link_child_count),
            ]
        )
        context_rows.append(
            build_context_vector(
                lb_x,
                lb_y,
                heights,
                difficulty_grid,
                culture_grid,
                instance_counts,
            ).astype(np.float32)
        )

    print("\n[4/4] Saving outputs...")
    os.makedirs(os.path.dirname(args.json_out), exist_ok=True)
    with open(args.json_out, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "retail_sql": args.retail_sql,
                "dense_threshold": args.dense_threshold,
                "feature_labels": list(FEATURE_LABELS),
                "rows": rows,
            },
            handle,
            indent=2,
        )
    np.savez_compressed(
        args.npz_out,
        features=np.asarray(feature_rows, dtype=np.float32),
        contexts=np.asarray(context_rows, dtype=np.float32),
        coords=np.asarray([(row["lb_x"], row["lb_y"]) for row in rows], dtype=np.int32),
    )

    signature_counts = Counter(row["settlement_signature"] for row in rows)
    style_counts = Counter(row["service_style"] for row in rows)
    print(f"  Dense service landblocks: {len(rows)}")
    print("  Top signatures:")
    for label, count in signature_counts.most_common(8):
        print(f"    {label:24s} {count:5d}")
    print("  Service styles:")
    for label, count in style_counts.most_common():
        print(f"    {label:24s} {count:5d}")
    print(f"  JSON: {args.json_out}")
    print(f"  NPZ:  {args.npz_out}")


if __name__ == "__main__":
    main()

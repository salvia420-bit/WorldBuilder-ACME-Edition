#!/usr/bin/env python3
"""
extract_settlement_planner_tensors.py - Retail -> Settlement Planner Tensors
===========================================================================

Build compact landblock-level supervision for a two-stage OutdoorML planner.
The planner predicts settlement archetype plus coarse family-count bins so the
scene generator can be conditioned on an explicit composition plan instead of
inferring town structure implicitly from the token stream.
"""

from __future__ import annotations

import json
import os
import sys
from collections import Counter

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from extract_placement_tensors import (  # noqa: E402
    BASE_DIR,
    DEFAULT_RETAIL_SQL,
    HEIGHTS_PATH,
    DIFFICULTY_GRADIENT,
    build_context_vector,
    build_cultural_zones,
    load_difficulty_grid,
    load_height_grid,
    parse_retail_sql,
    load_wcid_names,
    load_wcid_types,
)
from settlement_signatures import (  # noqa: E402
    SERVICE_MOTIF_LABELS,
    SERVICE_STYLE_LABELS,
    SETTLEMENT_ARCHETYPE_LABELS,
    classify_settlement_signature,
    classify_service_motif,
    classify_service_style,
    family_labels_for_landblock,
    settlement_archetype_from_signature,
)

OUTPUT_DIR = os.path.join(BASE_DIR, "pipeline_data", "reference")
OUTPUT_NPZ = os.path.join(OUTPUT_DIR, "settlement_planner_tensors.npz")
OUTPUT_META = os.path.join(OUTPUT_DIR, "settlement_planner_vocab.json")

PLANNER_FAMILY_LABELS = (
    "creature",
    "portal",
    "vendor",
    "lifestone",
    "door",
    "housing",
)


def count_bin(count: int) -> int:
    if count <= 0:
        return 0
    if count == 1:
        return 1
    if count <= 3:
        return 2
    return 3


def family_count_bins(insts: list[dict], wcid_types: dict[int, int]) -> np.ndarray:
    counts = Counter()
    for label in family_labels_for_landblock(insts, wcid_types):
        if label.startswith("housing_"):
            counts["housing"] += 1
        elif label in counts or label in PLANNER_FAMILY_LABELS:
            counts[label] += 1

    bins = np.zeros(len(PLANNER_FAMILY_LABELS), dtype=np.int64)
    for i, label in enumerate(PLANNER_FAMILY_LABELS):
        bins[i] = count_bin(counts.get(label, 0))
    return bins


def main() -> None:
    retail_sql = os.environ.get("ACE_RETAIL_SQL", DEFAULT_RETAIL_SQL)

    print("=" * 72)
    print("  Settlement Planner Tensor Extractor")
    print("  Retail SQL -> Planner Supervision")
    print("=" * 72)

    print("\n[1/4] Loading retail landblocks...")
    instances_by_lb, _, _ = parse_retail_sql(retail_sql)

    print("\n[2/4] Loading auxiliary inputs...")
    wcid_types = load_wcid_types(retail_sql)
    _ = load_wcid_names(retail_sql)
    heights = load_height_grid(HEIGHTS_PATH)
    difficulty_grid = load_difficulty_grid(DIFFICULTY_GRADIENT)
    culture_grid = build_cultural_zones()

    populated_lbs = sorted(
        lb for lb, insts in instances_by_lb.items()
        if any(not inst.get("is_indoor", False) for inst in insts)
    )
    instance_counts = {
        lb: sum(1 for inst in insts if not inst.get("is_indoor", False))
        for lb, insts in instances_by_lb.items()
    }

    contexts = np.zeros((len(populated_lbs), 235), dtype=np.float32)
    archetypes = np.zeros(len(populated_lbs), dtype=np.int64)
    service_styles = np.zeros(len(populated_lbs), dtype=np.int64)
    service_motifs = np.zeros(len(populated_lbs), dtype=np.int64)
    family_bins = np.zeros((len(populated_lbs), len(PLANNER_FAMILY_LABELS)), dtype=np.int64)

    print("\n[3/4] Building planner examples...")
    archetype_counts = Counter()
    service_style_counts = Counter()
    service_motif_counts = Counter()
    for idx, (lb_x, lb_y) in enumerate(populated_lbs):
        insts = [inst for inst in instances_by_lb[(lb_x, lb_y)] if not inst.get("is_indoor", False)]
        family_labels = family_labels_for_landblock(insts, wcid_types)
        signature = classify_settlement_signature(family_labels, len(insts))
        archetype = settlement_archetype_from_signature(signature)
        service_style = classify_service_style(family_labels)
        service_motif = classify_service_motif(family_labels, len(insts))
        archetype_counts[archetype] += 1
        service_style_counts[service_style] += 1
        service_motif_counts[service_motif] += 1

        contexts[idx] = build_context_vector(
            lb_x,
            lb_y,
            heights,
            difficulty_grid,
            culture_grid,
            instance_counts,
        )
        archetypes[idx] = SETTLEMENT_ARCHETYPE_LABELS.index(archetype)
        service_styles[idx] = SERVICE_STYLE_LABELS.index(service_style)
        service_motifs[idx] = SERVICE_MOTIF_LABELS.index(service_motif)
        family_bins[idx] = family_count_bins(insts, wcid_types)

        if (idx + 1) % 1000 == 0:
            print(f"  {idx + 1}/{len(populated_lbs)} landblocks")

    print("\n[4/4] Saving planner tensors...")
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    np.savez_compressed(
        OUTPUT_NPZ,
        contexts=contexts,
        archetypes=archetypes,
        service_styles=service_styles,
        service_motifs=service_motifs,
        family_bins=family_bins,
        lb_coords=np.array(populated_lbs, dtype=np.int32),
    )
    with open(OUTPUT_META, "w") as f:
        json.dump(
            {
                "archetype_labels": list(SETTLEMENT_ARCHETYPE_LABELS),
                "service_style_labels": list(SERVICE_STYLE_LABELS),
                "service_motif_labels": list(SERVICE_MOTIF_LABELS),
                "family_labels": list(PLANNER_FAMILY_LABELS),
                "count_bins": ["0", "1", "2-3", "4+"],
            },
            f,
            indent=2,
        )

    print("\nSummary")
    print(f"  Planner landblocks: {len(populated_lbs)}")
    print(f"  Context dim:        {contexts.shape[1]}")
    for label, count in sorted(archetype_counts.items(), key=lambda item: (-item[1], item[0])):
        print(f"  {label:24s} {count:5d}")
    print("  Service styles:")
    for label, count in sorted(service_style_counts.items(), key=lambda item: (-item[1], item[0])):
        print(f"    {label:22s} {count:5d}")
    print("  Service motifs:")
    for label, count in sorted(service_motif_counts.items(), key=lambda item: (-item[1], item[0])):
        print(f"    {label:22s} {count:5d}")
    print(f"  Tensors: {OUTPUT_NPZ}")
    print(f"  Meta:    {OUTPUT_META}")


if __name__ == "__main__":
    main()

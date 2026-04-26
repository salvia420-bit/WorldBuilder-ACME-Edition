#!/usr/bin/env python3
"""
Build a support-level arrangement dataset with explicit negative candidates.

This sits above the micro-placement rows. Each output row represents a single
support surface plus the authored/observed positive items on that support and a
small set of grounded negatives:

- off-edge perturbations relative to the same support
- sibling-collision perturbations on the same support
- borrowed items from nearby supports in the same cell
"""

from __future__ import annotations

import argparse
import json
import math
import random
from collections import Counter, defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
REFERENCE_DIR = ROOT / "pipeline_data" / "reference"
DEFAULT_INPUT_JSONL = REFERENCE_DIR / "fullworld_interior_microplacement_training_silverbronze_v3_no_xarabydun_no_housinganchors.jsonl"
DEFAULT_OUT_JSONL = REFERENCE_DIR / "fullworld_interior_support_arrangements_v1.jsonl"
DEFAULT_OUT_SUMMARY_JSON = REFERENCE_DIR / "fullworld_interior_support_arrangements_v1_summary.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build support-level arrangement dataset.")
    parser.add_argument("--input-jsonl", type=Path, default=DEFAULT_INPUT_JSONL)
    parser.add_argument("--out-jsonl", type=Path, default=DEFAULT_OUT_JSONL)
    parser.add_argument("--out-summary-json", type=Path, default=DEFAULT_OUT_SUMMARY_JSON)
    parser.add_argument("--max-positives-per-support", type=int, default=12)
    parser.add_argument("--max-negatives-per-support", type=int, default=18)
    parser.add_argument("--seed", type=int, default=20260406)
    return parser.parse_args()


def iter_jsonl(path: Path):
    with path.open("r", encoding="utf-8-sig") as handle:
        for line in handle:
            line = line.strip()
            if line:
                yield json.loads(line)


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=True) + "\n")


def rounded(value: float | None, digits: int = 4):
    if value is None:
        return None
    return round(float(value), digits)


def candidate_from_row(row: dict, label: int, source: str) -> dict:
    prop = row.get("prop") or {}
    target = row.get("target") or {}
    return {
        "trainingKey": row.get("trainingKey"),
        "label": label,
        "candidateSource": source,
        "prop": {
            "classIdSpace": prop.get("classIdSpace"),
            "name": prop.get("name"),
            "wcid": prop.get("wcid"),
            "classId": prop.get("classId"),
            "propClass": prop.get("propClass"),
            "sourceKind": prop.get("sourceKind"),
            "lsdHookType": prop.get("lsdHookType"),
            "isHookPlacable": bool(prop.get("isHookPlacable")),
        },
        "placement": {
            "dx": float(target.get("dx", 0.0)),
            "dy": float(target.get("dy", 0.0)),
            "heightAboveSupportPlane": float(target.get("heightAboveSupportPlane", 0.0)),
            "relativeYawDeg": float(target.get("relativeYawDeg", 0.0)),
        },
        "evidenceWeight": float(row.get("evidenceWeight", 1.0)),
        "labelTier": row.get("labelTier"),
    }


def support_signature(row: dict) -> dict:
    support = row.get("support") or {}
    support_geom = row.get("supportGeometry") or {}
    cell_geom = row.get("cellGeometry") or {}
    support_cell = (cell_geom.get("support") or {})
    return {
        "supportKey": row.get("supportKey"),
        "sceneId": row.get("sceneId"),
        "landblockId": row.get("landblockId"),
        "componentId": row.get("componentId"),
        "cellId": row.get("cellId"),
        "support": {
            "classIdSpace": support.get("classIdSpace"),
            "name": support.get("name"),
            "wcid": support.get("wcid"),
            "classId": support.get("classId"),
            "supportClass": support.get("supportClass"),
            "sourceKind": support.get("sourceKind"),
            "lsdHookType": support.get("lsdHookType"),
            "isHookPlacable": bool(support.get("isHookPlacable")),
        },
        "supportGeometry": support_geom,
        "cellGeometry": {
            "support": support_cell,
        },
        "roomContext": row.get("roomContext") or {},
    }


def off_edge_negative(row: dict, direction: str) -> dict | None:
    support_geom = row.get("supportGeometry") or {}
    half_x = float(support_geom.get("halfExtentX", 0.0) or 0.0)
    half_y = float(support_geom.get("halfExtentY", 0.0) or 0.0)
    if half_x <= 1e-6 or half_y <= 1e-6:
        return None
    base = candidate_from_row(row, 0, f"negative_off_edge_{direction}")
    dx = float(base["placement"]["dx"])
    dy = float(base["placement"]["dy"])
    spill = 0.25
    if direction == "east":
        dx = half_x + spill
    elif direction == "west":
        dx = -(half_x + spill)
    elif direction == "north":
        dy = half_y + spill
    else:
        dy = -(half_y + spill)
    base["placement"]["dx"] = rounded(dx)
    base["placement"]["dy"] = rounded(dy)
    return base


def sibling_collision_negative(row: dict, siblings: list[dict]) -> dict | None:
    if not siblings:
        return None
    base = candidate_from_row(row, 0, "negative_sibling_collision")
    sibling = siblings[0]
    placement = sibling.get("placement") or {}
    base["placement"]["dx"] = rounded(float(placement.get("dx", 0.0)))
    base["placement"]["dy"] = rounded(float(placement.get("dy", 0.0)))
    base["placement"]["heightAboveSupportPlane"] = rounded(float(placement.get("heightAboveSupportPlane", 0.0)))
    base["placement"]["relativeYawDeg"] = rounded(float(placement.get("relativeYawDeg", 0.0)), 2)
    return base


def borrowed_nearby_support_negative(source_row: dict, donor_row: dict) -> dict:
    donor_prop = donor_row.get("prop") or {}
    donor_target = donor_row.get("target") or {}
    return {
        "trainingKey": f"{source_row.get('trainingKey')}|borrow|{donor_row.get('trainingKey')}",
        "label": 0,
        "candidateSource": "negative_nearby_support_borrow",
        "prop": {
            "name": donor_prop.get("name"),
            "wcid": donor_prop.get("wcid"),
            "classId": donor_prop.get("classId"),
            "propClass": donor_prop.get("propClass"),
            "sourceKind": donor_prop.get("sourceKind"),
            "lsdHookType": donor_prop.get("lsdHookType"),
            "isHookPlacable": bool(donor_prop.get("isHookPlacable")),
        },
        "placement": {
            "dx": rounded(float(donor_target.get("dx", 0.0))),
            "dy": rounded(float(donor_target.get("dy", 0.0))),
            "heightAboveSupportPlane": rounded(float(donor_target.get("heightAboveSupportPlane", 0.0))),
            "relativeYawDeg": rounded(float(donor_target.get("relativeYawDeg", 0.0)), 2),
        },
        "evidenceWeight": float(donor_row.get("evidenceWeight", 1.0)),
        "labelTier": donor_row.get("labelTier"),
    }


def summarize_positive_geometry(candidates: list[dict]) -> dict:
    if not candidates:
        return {"positiveCount": 0}
    xs = [float((cand.get("placement") or {}).get("dx", 0.0)) for cand in candidates]
    ys = [float((cand.get("placement") or {}).get("dy", 0.0)) for cand in candidates]
    hs = [float((cand.get("placement") or {}).get("heightAboveSupportPlane", 0.0)) for cand in candidates]
    min_pair = None
    for i, a in enumerate(candidates):
        ax = float((a.get("placement") or {}).get("dx", 0.0))
        ay = float((a.get("placement") or {}).get("dy", 0.0))
        for b in candidates[i + 1 :]:
            bx = float((b.get("placement") or {}).get("dx", 0.0))
            by = float((b.get("placement") or {}).get("dy", 0.0))
            dist = math.hypot(ax - bx, ay - by)
            if min_pair is None or dist < min_pair:
                min_pair = dist
    return {
        "positiveCount": len(candidates),
        "dxMean": rounded(sum(xs) / len(xs)),
        "dyMean": rounded(sum(ys) / len(ys)),
        "heightMean": rounded(sum(hs) / len(hs)),
        "dxMin": rounded(min(xs)),
        "dxMax": rounded(max(xs)),
        "dyMin": rounded(min(ys)),
        "dyMax": rounded(max(ys)),
        "minPairDistance": rounded(min_pair) if min_pair is not None else None,
    }


def main() -> None:
    args = parse_args()
    rng = random.Random(args.seed)

    support_groups: dict[str, list[dict]] = defaultdict(list)
    cell_groups: dict[tuple[str, int, str], list[dict]] = defaultdict(list)
    for row in iter_jsonl(args.input_jsonl):
        support_key = row.get("supportKey")
        if not isinstance(support_key, str) or not support_key:
            continue
        support_groups[support_key].append(row)
        cell_key = (str(row.get("sceneId")), int(row.get("componentId") or -1), str(row.get("cellId")))
        cell_groups[cell_key].append(row)

    arrangement_rows = []
    negative_source_counts = Counter()
    positive_class_counts = Counter()
    skipped_supports = 0
    for support_key, rows in sorted(support_groups.items()):
        if not rows:
            continue
        rows = sorted(rows, key=lambda row: (str(row.get("trainingKey")),))
        if len(rows) > args.max_positives_per_support:
            rows = rows[: args.max_positives_per_support]
        first = rows[0]
        signature = support_signature(first)
        positives = [candidate_from_row(row, 1, "positive_observed") for row in rows]
        if not positives:
            skipped_supports += 1
            continue

        negatives = []
        # 1. Same-support off-edge and collision negatives.
        for row, positive in zip(rows, positives):
            siblings = [cand for cand in positives if cand["trainingKey"] != positive["trainingKey"]]
            direction = rng.choice(("east", "west", "north", "south"))
            off_edge = off_edge_negative(row, direction)
            if off_edge is not None:
                negatives.append(off_edge)
                negative_source_counts[off_edge["candidateSource"]] += 1
            collision = sibling_collision_negative(row, siblings)
            if collision is not None:
                negatives.append(collision)
                negative_source_counts[collision["candidateSource"]] += 1

        # 2. Borrow props from nearby supports in the same cell.
        cell_key = (str(first.get("sceneId")), int(first.get("componentId") or -1), str(first.get("cellId")))
        donor_rows = [row for row in cell_groups.get(cell_key, []) if row.get("supportKey") != support_key]
        rng.shuffle(donor_rows)
        for donor in donor_rows[: max(2, min(6, len(rows)))]:
            borrowed = borrowed_nearby_support_negative(first, donor)
            negatives.append(borrowed)
            negative_source_counts[borrowed["candidateSource"]] += 1

        # Deduplicate candidates by prop identity + placement.
        dedup = {}
        for cand in negatives:
            placement = cand.get("placement") or {}
            prop = cand.get("prop") or {}
            key = (
                cand.get("candidateSource"),
                prop.get("wcid"),
                prop.get("classId"),
                rounded(placement.get("dx")),
                rounded(placement.get("dy")),
                rounded(placement.get("heightAboveSupportPlane")),
                rounded(placement.get("relativeYawDeg"), 2),
            )
            dedup[key] = cand
        negatives = list(dedup.values())
        negatives.sort(key=lambda cand: (cand.get("candidateSource"), str(cand.get("trainingKey"))))
        negatives = negatives[: args.max_negatives_per_support]

        for cand in positives:
            positive_class_counts[(cand.get("prop") or {}).get("propClass") or "<none>"] += 1

        arrangement_rows.append(
            {
                **signature,
                "arrangementSummary": summarize_positive_geometry(positives),
                "positives": positives,
                "negatives": negatives,
            }
        )

    write_jsonl(args.out_jsonl, arrangement_rows)
    summary = {
        "input_jsonl": str(args.input_jsonl),
        "out_jsonl": str(args.out_jsonl),
        "counts": {
            "support_arrangements": len(arrangement_rows),
            "supports_skipped": skipped_supports,
            "positive_candidates": sum(len(row["positives"]) for row in arrangement_rows),
            "negative_candidates": sum(len(row["negatives"]) for row in arrangement_rows),
        },
        "negative_source_counts": dict(negative_source_counts.most_common()),
        "positive_prop_class_counts": dict(positive_class_counts.most_common()),
        "max_positives_per_support": args.max_positives_per_support,
        "max_negatives_per_support": args.max_negatives_per_support,
        "seed": args.seed,
    }
    args.out_summary_json.parent.mkdir(parents=True, exist_ok=True)
    with args.out_summary_json.open("w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)

    print("Interior support arrangement dataset complete")
    print(f"  Support rows:      {len(arrangement_rows):,}")
    print(f"  Positive samples:  {summary['counts']['positive_candidates']:,}")
    print(f"  Negative samples:  {summary['counts']['negative_candidates']:,}")
    print(f"  Output JSONL:      {args.out_jsonl}")
    print(f"  Summary JSON:      {args.out_summary_json}")


if __name__ == "__main__":
    main()

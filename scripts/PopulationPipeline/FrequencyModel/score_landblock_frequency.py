#!/usr/bin/env python3
"""
score_landblock_frequency.py
============================

Landblock-aware frequency evaluator.

Scores generated SQL by comparing each landblock's generated WCID counts
against the retail reference counts for that same landblock, while applying
frequency-aware reward and penalty weights.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[3]
REFERENCE_DIR = BASE_DIR / "pipeline_data" / "reference"

DEFAULT_WEIGHTS_JSON = REFERENCE_DIR / "dereth_frequency_weights.json"
DEFAULT_LANDBLOCK_REFERENCE_JSON = REFERENCE_DIR / "dereth_landblock_reference_counts.json"


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def normalize_landblock_id(value) -> str:
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.lower().startswith("0x"):
            return f"0x{stripped[2:].upper()}"
        if stripped.isdigit():
            return f"0x{int(stripped):04X}"
        return f"0x{stripped.upper()}"
    return f"0x{int(value):04X}"


def landblock_id_from_obj_cell_id(obj_cell_id: int) -> str:
    return f"0x{((int(obj_cell_id) >> 16) & 0xFFFF):04X}"


def parse_generated_sql_by_landblock(sql_path: Path) -> dict[str, Counter[int]]:
    counts_by_lb: dict[str, Counter[int]] = defaultdict(Counter)
    current_table = None

    with sql_path.open("r", encoding="utf-8", errors="replace") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line:
                continue
            if line.startswith("INSERT INTO `landblock_instance`"):
                current_table = "landblock_instance"
                continue
            if line.startswith("INSERT INTO `encounter`"):
                current_table = "encounter"
                continue
            if line.startswith("INSERT INTO `"):
                current_table = None
                continue
            if not line.startswith("(") or current_table is None:
                continue

            parts = line.rstrip(",;").strip("()").split(",", 5)
            if current_table == "landblock_instance" and len(parts) >= 3:
                try:
                    wcid = int(parts[1])
                    obj_cell_id = int(parts[2])
                    lbid = landblock_id_from_obj_cell_id(obj_cell_id)
                    counts_by_lb[lbid][wcid] += 1
                except ValueError:
                    pass
            elif current_table == "encounter" and len(parts) >= 3:
                try:
                    lbid = normalize_landblock_id(parts[1])
                    wcid = int(parts[2])
                    counts_by_lb[lbid][wcid] += 1
                except ValueError:
                    pass

    return counts_by_lb


def evaluate_landblocks(generated: dict[str, Counter[int]], reference_doc: dict, weights: dict) -> dict:
    reference_landblocks = {
        normalize_landblock_id(lbid): Counter({int(wcid): int(count) for wcid, count in rows.items()})
        for lbid, rows in reference_doc["landblocks"].items()
    }

    total_score = 0.0
    matched_reward = 0.0
    overgen_penalty = 0.0
    missing_penalty = 0.0
    landblock_rows = []
    top_overgenerated = []

    for lbid in sorted(set(reference_landblocks) | set(generated)):
        ref_counts = reference_landblocks.get(lbid, Counter())
        gen_counts = generated.get(lbid, Counter())
        lb_score = 0.0
        lb_reward = 0.0
        lb_over = 0.0
        lb_missing = 0.0

        for wcid in set(ref_counts) | set(gen_counts):
            ref = ref_counts.get(wcid, 0)
            gen = gen_counts.get(wcid, 0)
            meta = weights.get(str(wcid))
            reward_weight = float(meta["reward_weight"]) if meta else 0.25
            penalty_weight = float(meta["wrong_penalty_weight"]) if meta else 1.0

            matched = min(ref, gen)
            excess = max(gen - ref, 0)
            missing = max(ref - gen, 0)

            reward = matched * reward_weight
            over_pen = excess * penalty_weight
            miss_pen = missing * reward_weight * 0.35

            lb_score += reward - over_pen - miss_pen
            lb_reward += reward
            lb_over += over_pen
            lb_missing += miss_pen

            if excess > 0:
                top_overgenerated.append({
                    "landblock": lbid,
                    "wcid": wcid,
                    "name": meta.get("name") if meta else None,
                    "weenie_type_name": meta.get("weenie_type_name") if meta else None,
                    "generated": gen,
                    "reference": ref,
                    "excess": excess,
                    "penalty": round(over_pen, 3),
                })

        total_score += lb_score
        matched_reward += lb_reward
        overgen_penalty += lb_over
        missing_penalty += lb_missing

        if gen_counts or ref_counts:
            landblock_rows.append({
                "landblock": lbid,
                "score": round(lb_score, 3),
                "matched_reward": round(lb_reward, 3),
                "overgeneration_penalty": round(lb_over, 3),
                "missing_penalty": round(lb_missing, 3),
                "generated_total": int(sum(gen_counts.values())),
                "reference_total": int(sum(ref_counts.values())),
                "generated_unique": int(len(gen_counts)),
                "reference_unique": int(len(ref_counts)),
            })

    return {
        "generated_landblocks": len(generated),
        "reference_landblocks": len(reference_landblocks),
        "total_score": round(total_score, 3),
        "matched_reward": round(matched_reward, 3),
        "overgeneration_penalty": round(overgen_penalty, 3),
        "missing_penalty": round(missing_penalty, 3),
        "worst_landblocks": sorted(landblock_rows, key=lambda row: row["score"])[:25],
        "best_landblocks": sorted(landblock_rows, key=lambda row: row["score"], reverse=True)[:25],
        "top_overgenerated": sorted(top_overgenerated, key=lambda row: row["penalty"], reverse=True)[:50],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Landblock-aware frequency scoring for generated world SQL.")
    parser.add_argument("sql_path", type=Path)
    parser.add_argument("--weights-json", type=Path, default=DEFAULT_WEIGHTS_JSON)
    parser.add_argument("--landblock-reference-json", type=Path, default=DEFAULT_LANDBLOCK_REFERENCE_JSON)
    parser.add_argument("--out-json", type=Path, default=None)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    generated = parse_generated_sql_by_landblock(args.sql_path)
    weights_doc = load_json(args.weights_json)
    reference_doc = load_json(args.landblock_reference_json)
    summary = evaluate_landblocks(generated, reference_doc, weights_doc["weights"])
    summary["sql_path"] = str(args.sql_path)
    if args.out_json:
        with args.out_json.open("w", encoding="utf-8") as f:
            json.dump(summary, f, indent=2)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()

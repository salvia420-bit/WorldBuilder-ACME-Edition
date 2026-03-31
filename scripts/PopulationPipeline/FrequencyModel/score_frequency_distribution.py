#!/usr/bin/env python3
"""
score_frequency_distribution.py
===============================

Evaluate a generated world SQL file against Dereth's reference WCID
distribution using the standalone frequency-aware weights artifact.

This is not a full spatial fidelity metric. It is a first-pass evaluator for:
  - overgeneration of common infrastructure/service objects
  - underrepresentation of rare-but-meaningful classes
  - overall frequency alignment against retail-derived reference counts
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[3]
REFERENCE_DIR = BASE_DIR / "pipeline_data" / "reference"

DEFAULT_REFERENCE_COUNTS = REFERENCE_DIR / "dereth_object_counts.json"
DEFAULT_WEIGHTS_JSON = REFERENCE_DIR / "dereth_frequency_weights.json"


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def parse_generated_sql(sql_path: Path) -> Counter[int]:
    counts: Counter[int] = Counter()
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

            parts = line.rstrip(",;").strip("()").split(",", 4)
            if current_table == "landblock_instance" and len(parts) >= 2:
                try:
                    counts[int(parts[1])] += 1
                except ValueError:
                    pass
            elif current_table == "encounter" and len(parts) >= 3:
                try:
                    counts[int(parts[2])] += 1
                except ValueError:
                    pass

    return counts


def build_reference_counts(rows: list[dict]) -> Counter[int]:
    counts: Counter[int] = Counter()
    for row in rows:
        if row.get("classIdSpace") != "wcid":
            continue
        counts[int(row["classId"])] = int(row["count"])
    return counts


def evaluate_distribution(generated_counts: Counter[int], reference_counts: Counter[int], weights: dict) -> dict:
    total_score = 0.0
    matched_reward = 0.0
    overgen_penalty = 0.0
    missing_penalty = 0.0

    top_overgenerated = []
    top_underrepresented = []
    top_positive = []

    all_wcids = set(reference_counts) | set(generated_counts)
    for wcid in all_wcids:
        ref = reference_counts.get(wcid, 0)
        gen = generated_counts.get(wcid, 0)
        meta = weights.get(str(wcid))
        if meta is None:
            reward_weight = 0.25
            wrong_penalty_weight = 1.0
            name = None
            weenie_type_name = None
        else:
            reward_weight = float(meta["reward_weight"])
            wrong_penalty_weight = float(meta["wrong_penalty_weight"])
            name = meta.get("name")
            weenie_type_name = meta.get("weenie_type_name")

        matched = min(ref, gen)
        excess = max(gen - ref, 0)
        missing = max(ref - gen, 0)

        reward = matched * reward_weight
        excess_penalty = excess * wrong_penalty_weight
        # Missing counts matter, but more softly than unsupported generation.
        miss_pen = missing * reward_weight * 0.35
        net = reward - excess_penalty - miss_pen

        total_score += net
        matched_reward += reward
        overgen_penalty += excess_penalty
        missing_penalty += miss_pen

        if excess > 0:
            top_overgenerated.append({
                "wcid": wcid,
                "name": name,
                "weenie_type_name": weenie_type_name,
                "generated": gen,
                "reference": ref,
                "excess": excess,
                "penalty": round(excess_penalty, 3),
            })
        if missing > 0:
            top_underrepresented.append({
                "wcid": wcid,
                "name": name,
                "weenie_type_name": weenie_type_name,
                "generated": gen,
                "reference": ref,
                "missing": missing,
                "penalty": round(miss_pen, 3),
            })
        if matched > 0:
            top_positive.append({
                "wcid": wcid,
                "name": name,
                "weenie_type_name": weenie_type_name,
                "generated": gen,
                "reference": ref,
                "matched": matched,
                "reward": round(reward, 3),
            })

    return {
        "generated_total_wcid_rows": int(sum(generated_counts.values())),
        "generated_unique_wcids": int(len(generated_counts)),
        "reference_total_wcid_rows": int(sum(reference_counts.values())),
        "reference_unique_wcids": int(len(reference_counts)),
        "total_score": round(total_score, 3),
        "matched_reward": round(matched_reward, 3),
        "overgeneration_penalty": round(overgen_penalty, 3),
        "missing_penalty": round(missing_penalty, 3),
        "top_overgenerated": sorted(top_overgenerated, key=lambda row: row["penalty"], reverse=True)[:25],
        "top_underrepresented": sorted(top_underrepresented, key=lambda row: row["penalty"], reverse=True)[:25],
        "top_positive_matches": sorted(top_positive, key=lambda row: row["reward"], reverse=True)[:25],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Score generated world SQL with frequency-aware WCID weighting.")
    parser.add_argument("sql_path", type=Path, help="Generated SQL file to evaluate")
    parser.add_argument("--reference-counts", type=Path, default=DEFAULT_REFERENCE_COUNTS)
    parser.add_argument("--weights-json", type=Path, default=DEFAULT_WEIGHTS_JSON)
    parser.add_argument("--out-json", type=Path, default=None)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    generated_counts = parse_generated_sql(args.sql_path)
    reference_counts = build_reference_counts(load_json(args.reference_counts))
    weights_doc = load_json(args.weights_json)
    summary = evaluate_distribution(generated_counts, reference_counts, weights_doc["weights"])
    summary["sql_path"] = str(args.sql_path)
    if args.out_json:
        with args.out_json.open("w", encoding="utf-8") as f:
            json.dump(summary, f, indent=2)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()

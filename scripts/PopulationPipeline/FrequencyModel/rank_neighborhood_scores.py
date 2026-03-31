#!/usr/bin/env python3
"""
rank_neighborhood_scores.py
===========================

Run the neighborhood frequency scorer across multiple generated SQL files and
print a ranked comparison table using normalized metrics.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[3]
REFERENCE_DIR = BASE_DIR / "pipeline_data" / "reference"

DEFAULT_WEIGHTS_JSON = REFERENCE_DIR / "dereth_frequency_weights.json"
DEFAULT_LANDBLOCK_REFERENCE_JSON = REFERENCE_DIR / "dereth_landblock_reference_counts.json"
DEFAULT_SIMILARITY_JSON = REFERENCE_DIR / "dereth_wcid_similarity.json"
SCORER_PATH = Path(__file__).with_name("score_neighborhood_frequency.py")


def load_scorer_module():
    spec = importlib.util.spec_from_file_location("score_neighborhood_frequency", SCORER_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rank generated SQL files with the neighborhood frequency scorer.")
    parser.add_argument("sql_paths", nargs="+", type=Path, help="One or more generated SQL files to score")
    parser.add_argument("--weights-json", type=Path, default=DEFAULT_WEIGHTS_JSON)
    parser.add_argument("--landblock-reference-json", type=Path, default=DEFAULT_LANDBLOCK_REFERENCE_JSON)
    parser.add_argument("--similarity-json", type=Path, default=DEFAULT_SIMILARITY_JSON)
    parser.add_argument("--radius", type=int, default=1)
    parser.add_argument("--neighborhood-cap", type=int, default=8)
    parser.add_argument("--similarity-credit-ratio", type=float, default=0.3)
    parser.add_argument("--similarity-penalty-ratio", type=float, default=0.55)
    parser.add_argument(
        "--sort-by",
        type=str,
        default="score_per_row",
        choices=("score_per_row", "score_per_landblock", "total_score", "over_penalty_per_row"),
    )
    parser.add_argument("--out-json", type=Path, default=None)
    return parser.parse_args()


def format_table(rows: list[dict], sort_by: str) -> str:
    ordered = sorted(rows, key=lambda row: row[sort_by], reverse=True)
    headers = [
        ("label", 34),
        ("rows", 9),
        ("lbs", 7),
        ("score/row", 11),
        ("score/lb", 11),
        ("over/row", 10),
        ("mix/lb", 9),
    ]
    lines = []
    lines.append("  ".join(name.ljust(width) for name, width in headers))
    lines.append("  ".join("-" * width for _, width in headers))
    for row in ordered:
        line = "  ".join(
            [
                row["label"][:34].ljust(34),
                str(row["generated_rows"]).rjust(9),
                str(row["generated_landblocks"]).rjust(7),
                f'{row["score_per_row"]:.6f}'.rjust(11),
                f'{row["score_per_landblock"]:.6f}'.rjust(11),
                f'{row["over_penalty_per_row"]:.6f}'.rjust(10),
                f'{row["mix_reward_per_landblock"]:.6f}'.rjust(9),
            ]
        )
        lines.append(line)
    return "\n".join(lines)


def main() -> None:
    args = parse_args()
    scorer = load_scorer_module()
    weights_doc = scorer.load_json(args.weights_json)
    reference_doc = scorer.load_json(args.landblock_reference_json)
    similarity_doc = scorer.load_json(args.similarity_json)
    reference_landblocks = scorer.build_reference_landblocks(reference_doc)

    rows = []
    for sql_path in args.sql_paths:
        generated = scorer.parse_generated_sql_by_landblock(sql_path)
        summary = scorer.evaluate_neighborhoods(
            generated=generated,
            reference_landblocks=reference_landblocks,
            weights=weights_doc["weights"],
            similarity_doc=similarity_doc,
            radius=args.radius,
            neighborhood_cap=args.neighborhood_cap,
            similarity_credit_ratio=args.similarity_credit_ratio,
            similarity_penalty_ratio=args.similarity_penalty_ratio,
        )
        generated_rows = sum(sum(counter.values()) for counter in generated.values())
        generated_landblocks = len(generated)
        row = {
            "label": sql_path.stem,
            "sql_path": str(sql_path),
            "generated_rows": generated_rows,
            "generated_landblocks": generated_landblocks,
            "total_score": summary["total_score"],
            "matched_reward": summary["matched_reward"],
            "similarity_matched_reward": summary["similarity_matched_reward"],
            "mix_matched_reward": summary["mix_matched_reward"],
            "overgeneration_penalty": summary["overgeneration_penalty"],
            "missing_penalty": summary["missing_penalty"],
            "score_per_row": summary["total_score"] / generated_rows if generated_rows else 0.0,
            "score_per_landblock": summary["total_score"] / generated_landblocks if generated_landblocks else 0.0,
            "over_penalty_per_row": summary["overgeneration_penalty"] / generated_rows if generated_rows else 0.0,
            "mix_reward_per_landblock": summary["mix_matched_reward"] / generated_landblocks if generated_landblocks else 0.0,
        }
        rows.append(row)

    print(format_table(rows, args.sort_by))

    if args.out_json:
        payload = {
            "sort_by": args.sort_by,
            "radius": args.radius,
            "neighborhood_cap": args.neighborhood_cap,
            "similarity_credit_ratio": args.similarity_credit_ratio,
            "similarity_penalty_ratio": args.similarity_penalty_ratio,
            "results": sorted(rows, key=lambda row: row[args.sort_by], reverse=True),
        }
        args.out_json.parent.mkdir(parents=True, exist_ok=True)
        with args.out_json.open("w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)


if __name__ == "__main__":
    main()

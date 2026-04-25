#!/usr/bin/env python3
"""
Build pairwise support/object ranking comparisons.

Each row compares one positive object against one confuser object on the same support.
The target is always that the positive should outrank the confuser.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
REFERENCE_DIR = ROOT / "pipeline_data" / "reference"

DEFAULT_INPUT_JSONL = REFERENCE_DIR / "fullworld_interior_support_object_selection_v2.jsonl"
DEFAULT_OUT_JSONL = REFERENCE_DIR / "fullworld_interior_support_object_pairwise_v2.jsonl"
DEFAULT_OUT_SUMMARY_JSON = REFERENCE_DIR / "fullworld_interior_support_object_pairwise_v2_summary.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build pairwise support/object ranking dataset.")
    parser.add_argument("--input-jsonl", type=Path, default=DEFAULT_INPUT_JSONL)
    parser.add_argument("--out-jsonl", type=Path, default=DEFAULT_OUT_JSONL)
    parser.add_argument("--out-summary-json", type=Path, default=DEFAULT_OUT_SUMMARY_JSON)
    parser.add_argument("--max-negatives-per-positive", type=int, default=4)
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


def object_signature(obj: dict) -> dict:
    return {
        "objectKey": obj.get("objectKey"),
        "classIdSpace": obj.get("classIdSpace"),
        "classId": obj.get("classId"),
        "wcid": obj.get("wcid"),
        "preferredName": obj.get("preferredName"),
        "propClass": obj.get("propClass"),
        "sourceKind": obj.get("sourceKind"),
        "lsdHookType": obj.get("lsdHookType"),
        "isHookPlacable": obj.get("isHookPlacable"),
        "weenieType": obj.get("weenieType"),
        "groundingConfidence": obj.get("groundingConfidence"),
        "groundingNameSource": obj.get("groundingNameSource"),
        "enrichmentType": obj.get("enrichmentType"),
        "enrichmentTags": list(obj.get("enrichmentTags") or []),
        "semanticSummary": obj.get("semanticSummary"),
        "unifiedOntology": obj.get("unifiedOntology"),
    }


def main() -> None:
    args = parse_args()
    out_rows = []
    support_rows = 0
    pair_rows = 0
    skipped_no_neg = 0

    for row in iter_jsonl(args.input_jsonl):
        positives = row.get("positiveObjects") or []
        negatives = row.get("negativeObjects") or []
        if not positives or not negatives:
            skipped_no_neg += 1
            continue
        support_rows += 1
        negatives = negatives[: max(1, args.max_negatives_per_positive * len(positives))]
        for pos in positives:
            pos_obj = object_signature(pos.get("object") or {})
            pos_key = pos_obj.get("objectKey")
            confusers = []
            for neg in negatives:
                neg_obj = object_signature(neg.get("object") or {})
                if neg_obj.get("objectKey") == pos_key:
                    continue
                confusers.append(neg)
            confusers = confusers[: args.max_negatives_per_positive]
            for neg in confusers:
                neg_obj = object_signature(neg.get("object") or {})
                out_rows.append(
                    {
                        "landblockId": row.get("landblockId"),
                        "sceneId": row.get("sceneId"),
                        "supportKey": row.get("supportKey"),
                        "support": row.get("support") or {},
                        "supportGeometry": row.get("supportGeometry") or {},
                        "cellGeometry": row.get("cellGeometry") or {},
                        "roomContext": row.get("roomContext") or {},
                        "arrangementSummary": row.get("arrangementSummary") or {},
                        "positiveObject": pos_obj,
                        "negativeObject": neg_obj,
                        "positiveEvidenceWeight": float(pos.get("evidenceWeight", 1.0)),
                        "negativeEvidenceWeight": float(neg.get("evidenceWeight", 1.0)),
                        "negativeReason": neg.get("candidateReason"),
                    }
                )
                pair_rows += 1

    write_jsonl(args.out_jsonl, out_rows)
    summary = {
        "input_jsonl": str(args.input_jsonl),
        "out_jsonl": str(args.out_jsonl),
        "counts": {
            "support_rows_with_pairs": support_rows,
            "pair_rows": pair_rows,
            "support_rows_skipped_no_negatives": skipped_no_neg,
        },
        "max_negatives_per_positive": args.max_negatives_per_positive,
    }
    args.out_summary_json.parent.mkdir(parents=True, exist_ok=True)
    with args.out_summary_json.open("w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)

    print("Interior support/object pairwise dataset complete")
    print(f"  Pair rows:        {pair_rows:,}")
    print(f"  Output JSONL:     {args.out_jsonl}")
    print(f"  Summary JSON:     {args.out_summary_json}")


if __name__ == "__main__":
    main()

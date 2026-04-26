#!/usr/bin/env python3
"""
Build a curated support-scene review subset for human authored-scene labeling.

This is intentionally different from the raw extractor review packets. It works
at the support-scene level and surfaces supports whose object selection and
arrangement are most likely to be informative for semantic fine-tuning.
"""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter, defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
REFERENCE_DIR = ROOT / "pipeline_data" / "reference"

DEFAULT_SELECTION_JSONL = REFERENCE_DIR / "fullworld_interior_support_object_selection_v1.jsonl"
DEFAULT_ARRANGEMENT_JSONL = REFERENCE_DIR / "fullworld_interior_support_arrangements_v1.jsonl"
DEFAULT_OUT_JSONL = REFERENCE_DIR / "interior_support_scene_review_packets_v1.jsonl"
DEFAULT_OUT_SUMMARY_JSON = REFERENCE_DIR / "interior_support_scene_review_packets_v1_summary.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build curated support-scene review packets.")
    parser.add_argument("--selection-jsonl", type=Path, default=DEFAULT_SELECTION_JSONL)
    parser.add_argument("--arrangement-jsonl", type=Path, default=DEFAULT_ARRANGEMENT_JSONL)
    parser.add_argument("--out-jsonl", type=Path, default=DEFAULT_OUT_JSONL)
    parser.add_argument("--out-summary-json", type=Path, default=DEFAULT_OUT_SUMMARY_JSON)
    parser.add_argument("--max-packets", type=int, default=800)
    parser.add_argument("--max-per-landblock", type=int, default=16)
    parser.add_argument("--max-per-support-class", type=int, default=300)
    parser.add_argument("--max-per-pattern", type=int, default=4)
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


def object_display_name(obj: dict) -> str:
    return str(obj.get("preferredName") or obj.get("propClass") or obj.get("objectKey") or "<unnamed>")


def support_display_name(support: dict) -> str:
    return str(support.get("preferredName") or support.get("supportClass") or support.get("objectKey") or "<unnamed-support>")


def candidate_sort_key(candidate: dict):
    obj = candidate.get("object") or {}
    return (
        -float(candidate.get("evidenceWeight", 0.0)),
        object_display_name(obj),
        str(obj.get("objectKey") or ""),
    )


def arrangement_index(path: Path) -> dict[str, dict]:
    return {str(row.get("supportKey")): row for row in iter_jsonl(path)}


def review_score(row: dict, arrangement_row: dict | None) -> tuple[float, dict]:
    support = row.get("support") or {}
    positives = row.get("positiveObjects") or []
    negatives = row.get("negativeObjects") or []
    summary = row.get("arrangementSummary") or {}
    support_geom = row.get("supportGeometry") or {}

    named_positive_count = sum(1 for cand in positives if (cand.get("object") or {}).get("preferredName"))
    non_static_positive_count = sum(1 for cand in positives if (cand.get("object") or {}).get("propClass") not in (None, "static_clutter"))
    wcid_positive_count = sum(1 for cand in positives if (cand.get("object") or {}).get("wcid") is not None)
    semantic_positive_count = sum(1 for cand in positives if (cand.get("object") or {}).get("semanticSummary"))
    support_named = bool(support.get("preferredName"))
    support_area = float(support_geom.get("halfExtentX", 0.0) or 0.0) * float(support_geom.get("halfExtentY", 0.0) or 0.0) * 4.0
    positive_count = len(positives)
    negative_count = len(negatives)
    min_pair_distance = summary.get("minPairDistance")
    support_class = str(support.get("supportClass") or "<none>")

    score = 0.0
    score += named_positive_count * 5.0
    score += non_static_positive_count * 4.0
    score += wcid_positive_count * 4.0
    score += semantic_positive_count * 1.0
    score += max(0, positive_count - 1) * 2.0
    score += min(negative_count, 8) * 0.2
    score += 2.0 if support_named else 0.0
    score += 1.5 if support_class == "table_like" else 0.0
    score += 1.0 if support_class == "shelf_like" else 0.0
    if min_pair_distance is not None and float(min_pair_distance) < 0.35:
        score += 1.5
    if support_area > 2.5:
        score += 0.5
    if arrangement_row and any((cand.get("prop") or {}).get("wcid") is not None for cand in arrangement_row.get("positives") or []):
        score += 1.0

    features = {
        "namedPositiveCount": named_positive_count,
        "nonStaticPositiveCount": non_static_positive_count,
        "wcidPositiveCount": wcid_positive_count,
        "semanticPositiveCount": semantic_positive_count,
        "positiveCount": positive_count,
        "negativeCount": negative_count,
        "supportNamed": support_named,
        "supportArea": rounded(support_area),
        "minPairDistance": rounded(min_pair_distance),
    }
    return score, features


def build_packet(row: dict, arrangement_row: dict | None) -> dict:
    support = row.get("support") or {}
    positives = sorted(row.get("positiveObjects") or [], key=candidate_sort_key)
    negatives = sorted(row.get("negativeObjects") or [], key=candidate_sort_key)
    score, features = review_score(row, arrangement_row)
    packet_key = f"{row.get('sceneId')}|{row.get('supportKey')}"

    positive_preview = []
    for cand in positives[:8]:
        obj = cand.get("object") or {}
        sem = obj.get("semanticSummary") or {}
        positive_preview.append(
            {
                "objectKey": obj.get("objectKey"),
                "displayName": object_display_name(obj),
                "propClass": obj.get("propClass"),
                "wcid": obj.get("wcid"),
                "weenieType": obj.get("weenieType"),
                "dominantLsdHookType": sem.get("dominantLsdHookType"),
                "signatureKey": sem.get("signatureKey"),
                "evidenceWeight": rounded(cand.get("evidenceWeight")),
            }
        )

    negative_preview = []
    for cand in negatives[:8]:
        obj = cand.get("object") or {}
        sem = obj.get("semanticSummary") or {}
        negative_preview.append(
            {
                "candidateReason": cand.get("candidateReason"),
                "objectKey": obj.get("objectKey"),
                "displayName": object_display_name(obj),
                "propClass": obj.get("propClass"),
                "wcid": obj.get("wcid"),
                "weenieType": obj.get("weenieType"),
                "dominantLsdHookType": sem.get("dominantLsdHookType"),
                "signatureKey": sem.get("signatureKey"),
                "evidenceWeight": rounded(cand.get("evidenceWeight")),
            }
        )

    support_sem = support.get("semanticSummary") or {}
    positive_pattern = tuple(
        sorted(
            (
                (cand.get("object") or {}).get("objectKey")
                or object_display_name(cand.get("object") or {})
            )
            for cand in positives
        )
    )
    pattern_key = "|".join(
        [
            str(support.get("supportClass") or "<none>"),
            str(support_sem.get("signatureKey") or "<none>"),
            ";".join(positive_pattern[:12]),
        ]
    )
    return {
        "supportReviewKey": packet_key,
        "supportPatternKey": pattern_key,
        "sceneId": row.get("sceneId"),
        "landblockId": row.get("landblockId"),
        "componentId": row.get("componentId"),
        "cellId": row.get("cellId"),
        "supportKey": row.get("supportKey"),
        "reviewPriorityScore": rounded(score),
        "reviewFeatures": features,
        "support": {
            "objectKey": support.get("objectKey"),
            "displayName": support_display_name(support),
            "supportClass": support.get("supportClass"),
            "sourceKind": support.get("sourceKind"),
            "wcid": support.get("wcid"),
            "dominantWeenieType": support_sem.get("dominantWeenieType"),
            "dominantLsdHookType": support_sem.get("dominantLsdHookType"),
            "signatureKey": support_sem.get("signatureKey"),
        },
        "supportGeometry": {
            "halfExtentX": rounded((row.get("supportGeometry") or {}).get("halfExtentX")),
            "halfExtentY": rounded((row.get("supportGeometry") or {}).get("halfExtentY")),
            "normalizedDx": rounded((row.get("supportGeometry") or {}).get("normalizedDx")),
            "normalizedDy": rounded((row.get("supportGeometry") or {}).get("normalizedDy")),
            "edgeDistances": {
                "west": rounded((((row.get("supportGeometry") or {}).get("edgeDistances") or {}).get("west"))),
                "east": rounded((((row.get("supportGeometry") or {}).get("edgeDistances") or {}).get("east"))),
                "south": rounded((((row.get("supportGeometry") or {}).get("edgeDistances") or {}).get("south"))),
                "north": rounded((((row.get("supportGeometry") or {}).get("edgeDistances") or {}).get("north"))),
            },
        },
        "roomContext": row.get("roomContext") or {},
        "arrangementSummary": row.get("arrangementSummary") or {},
        "positivePreview": positive_preview,
        "negativePreview": negative_preview,
        "recommendedAction": "review_support_scene",
        "reviewQuestions": [
            "Should this support be active or empty?",
            "Is the positive object set retail-authored and semantically coherent?",
            "Are there missing, incorrect, or overly dense objects on this support?",
        ],
    }


def main() -> None:
    args = parse_args()
    arrangement_by_support = arrangement_index(args.arrangement_jsonl)

    packets = []
    for row in iter_jsonl(args.selection_jsonl):
        arrangement_row = arrangement_by_support.get(str(row.get("supportKey")))
        packets.append(build_packet(row, arrangement_row))

    packets.sort(
        key=lambda row: (
            -float(row.get("reviewPriorityScore", 0.0)),
            str((row.get("support") or {}).get("supportClass") or ""),
            str(row.get("supportKey") or ""),
        )
    )

    kept = []
    by_landblock = Counter()
    by_support_class = Counter()
    by_pattern = Counter()
    for row in packets:
        landblock_id = str(row.get("landblockId") or "")
        support_class = str((row.get("support") or {}).get("supportClass") or "<none>")
        pattern_key = str(row.get("supportPatternKey") or "")
        if by_landblock[landblock_id] >= args.max_per_landblock:
            continue
        if by_support_class[support_class] >= args.max_per_support_class:
            continue
        if by_pattern[pattern_key] >= args.max_per_pattern:
            continue
        kept.append(row)
        by_landblock[landblock_id] += 1
        by_support_class[support_class] += 1
        by_pattern[pattern_key] += 1
        if len(kept) >= args.max_packets:
            break

    write_jsonl(args.out_jsonl, kept)
    summary = {
        "selection_jsonl": str(args.selection_jsonl),
        "arrangement_jsonl": str(args.arrangement_jsonl),
        "out_jsonl": str(args.out_jsonl),
        "counts": {
            "all_packets": len(packets),
            "kept_packets": len(kept),
        },
        "support_class_counts": dict(sorted(by_support_class.items())),
        "top_patterns": [{"value": key, "count": count} for key, count in by_pattern.most_common(20)],
        "top_landblocks": [{"value": key, "count": count} for key, count in by_landblock.most_common(20)],
        "top_priority_examples": [
            {
                "supportReviewKey": row.get("supportReviewKey"),
                "reviewPriorityScore": row.get("reviewPriorityScore"),
                "supportClass": (row.get("support") or {}).get("supportClass"),
                "displayName": (row.get("support") or {}).get("displayName"),
                "positiveCount": (row.get("reviewFeatures") or {}).get("positiveCount"),
                "namedPositiveCount": (row.get("reviewFeatures") or {}).get("namedPositiveCount"),
            }
            for row in kept[:20]
        ],
    }
    args.out_summary_json.parent.mkdir(parents=True, exist_ok=True)
    with args.out_summary_json.open("w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)

    print("Interior support scene review packets complete")
    print(f"  All packets:   {len(packets):,}")
    print(f"  Kept packets:  {len(kept):,}")
    print(f"  Output JSONL:  {args.out_jsonl}")
    print(f"  Summary JSON:  {args.out_summary_json}")


if __name__ == "__main__":
    main()

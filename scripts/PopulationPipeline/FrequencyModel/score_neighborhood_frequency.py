#!/usr/bin/env python3
"""
score_neighborhood_frequency.py
===============================

Neighborhood-aware frequency evaluator.

Instead of requiring an object to appear in the exact same retail landblock,
this evaluator aggregates reference WCID counts from nearby landblocks within a
configurable radius and scores generated output against that local prior.
"""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter, defaultdict
from functools import lru_cache
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[3]
REFERENCE_DIR = BASE_DIR / "pipeline_data" / "reference"

DEFAULT_WEIGHTS_JSON = REFERENCE_DIR / "dereth_frequency_weights.json"
DEFAULT_LANDBLOCK_REFERENCE_JSON = REFERENCE_DIR / "dereth_landblock_reference_counts.json"
DEFAULT_SIMILARITY_JSON = REFERENCE_DIR / "dereth_wcid_similarity.json"


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


def parse_landblock_xy(landblock_id: str) -> tuple[int, int]:
    value = int(normalize_landblock_id(landblock_id), 16)
    return (value >> 8) & 0xFF, value & 0xFF


def make_landblock_id(x: int, y: int) -> str:
    return f"0x{((x & 0xFF) << 8 | (y & 0xFF)):04X}"


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


def build_reference_landblocks(reference_doc: dict) -> dict[str, Counter[int]]:
    return {
        normalize_landblock_id(lbid): Counter({int(wcid): int(count) for wcid, count in rows.items()})
        for lbid, rows in reference_doc["landblocks"].items()
    }


def weighted_jaccard_similarity(left: Counter[int], right: Counter[int], weights: dict) -> float:
    union_wcids = set(left) | set(right)
    if not union_wcids:
        return 1.0
    numerator = 0.0
    denominator = 0.0
    for wcid in union_wcids:
        meta = weights.get(str(wcid))
        weight = float(meta["reward_weight"]) if meta else 0.25
        left_value = left.get(wcid, 0)
        right_value = right.get(wcid, 0)
        numerator += min(left_value, right_value) * weight
        denominator += max(left_value, right_value) * weight
    if denominator <= 0:
        return 0.0
    return numerator / denominator


def neighbor_ids(center_lbid: str, radius: int) -> list[str]:
    x, y = parse_landblock_xy(center_lbid)
    ids = []
    for dx in range(-radius, radius + 1):
        for dy in range(-radius, radius + 1):
            nx = x + dx
            ny = y + dy
            if 0 <= nx <= 255 and 0 <= ny <= 255:
                ids.append(make_landblock_id(nx, ny))
    return ids


def build_similarity_lookup(similarity_doc: dict) -> dict[int, list[dict]]:
    lookup: dict[int, list[dict]] = {}
    for wcid_str, rows in similarity_doc.get("similarity", {}).items():
        try:
            lookup[int(wcid_str)] = rows
        except ValueError:
            continue
    return lookup


def region_landblock_ids(lb_x_min: int, lb_x_max: int, lb_y_min: int, lb_y_max: int) -> list[str]:
    ids = []
    for x in range(lb_x_min, lb_x_max + 1):
        for y in range(lb_y_min, lb_y_max + 1):
            ids.append(make_landblock_id(x, y))
    return ids


def evaluate_neighborhoods(
    generated: dict[str, Counter[int]],
    reference_landblocks: dict[str, Counter[int]],
    weights: dict,
    similarity_doc: dict,
    radius: int,
    neighborhood_cap: int,
    similarity_credit_ratio: float,
    similarity_penalty_ratio: float,
    expected_landblocks: list[str] | None = None,
) -> dict:
    similarity_lookup = build_similarity_lookup(similarity_doc)

    @lru_cache(maxsize=None)
    def neighborhood_reference(lbid: str) -> Counter[int]:
        counter: Counter[int] = Counter()
        for neighbor_lbid in neighbor_ids(lbid, radius):
            counter.update(reference_landblocks.get(neighbor_lbid, Counter()))
        if neighborhood_cap > 0:
            for wcid in list(counter.keys()):
                if counter[wcid] > neighborhood_cap:
                    counter[wcid] = neighborhood_cap
        return counter

    total_score = 0.0
    matched_reward = 0.0
    similarity_matched_reward = 0.0
    mix_matched_reward = 0.0
    overgen_penalty = 0.0
    missing_penalty = 0.0
    landblock_rows = []
    top_overgenerated = []
    top_similarity_supported = []
    top_mix_supported = []

    @lru_cache(maxsize=None)
    def nearby_reference_landblocks(lbid: str) -> tuple[tuple[str, tuple[tuple[int, int], ...]], ...]:
        rows = []
        for neighbor_lbid in neighbor_ids(lbid, radius):
            ref_counter = reference_landblocks.get(neighbor_lbid)
            if ref_counter:
                rows.append((neighbor_lbid, tuple(sorted(ref_counter.items()))))
        return tuple(rows)

    evaluated_lbs = set(generated)
    if expected_landblocks is not None:
        evaluated_lbs.update(normalize_landblock_id(lbid) for lbid in expected_landblocks)

    for lbid in sorted(evaluated_lbs):
        gen_counts = generated.get(lbid, Counter())
        ref_counts = neighborhood_reference(lbid)
        lb_score = 0.0
        lb_reward = 0.0
        lb_similarity_reward = 0.0
        lb_mix_reward = 0.0
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
            similarity_support_available = 0.0
            similarity_supported = 0.0
            average_similarity = 0.0

            if excess > 0:
                support_parts = []
                for neighbor in similarity_lookup.get(wcid, []):
                    other_wcid = int(neighbor["wcid"])
                    nearby_count = ref_counts.get(other_wcid, 0)
                    if nearby_count <= 0:
                        continue
                    similarity = float(neighbor["similarity"])
                    other_meta = weights.get(str(other_wcid))
                    supporter_weight = float(other_meta["reward_weight"]) if other_meta else 0.25
                    equivalent_support = nearby_count * similarity * supporter_weight
                    if equivalent_support <= 0:
                        continue
                    support_parts.append((equivalent_support, similarity, other_wcid))
                if support_parts:
                    similarity_support_available = sum(part[0] for part in support_parts)
                    similarity_supported = min(excess, similarity_support_available)
                    weighted_similarity_sum = sum(part[0] * part[1] for part in support_parts)
                    average_similarity = weighted_similarity_sum / similarity_support_available

            reward = matched * reward_weight
            similarity_reward = similarity_supported * reward_weight * similarity_credit_ratio * average_similarity
            unsupported_excess = max(excess - similarity_supported, 0.0)
            similarity_mismatch_pen = similarity_supported * penalty_weight * similarity_penalty_ratio * (1.0 - average_similarity)
            over_pen = unsupported_excess * penalty_weight + similarity_mismatch_pen
            miss_pen = missing * reward_weight * 0.15

            lb_score += reward + similarity_reward - over_pen - miss_pen
            lb_reward += reward
            lb_similarity_reward += similarity_reward
            lb_over += over_pen
            lb_missing += miss_pen

            if excess > 0:
                top_overgenerated.append({
                    "landblock": lbid,
                    "wcid": wcid,
                    "name": meta.get("name") if meta else None,
                    "weenie_type_name": meta.get("weenie_type_name") if meta else None,
                    "generated": gen,
                    "reference_neighborhood": ref,
                    "similarity_support_available": round(similarity_support_available, 3),
                    "similarity_supported": round(similarity_supported, 3),
                    "average_similarity": round(average_similarity, 3),
                    "excess": excess,
                    "penalty": round(over_pen, 3),
                })
            if similarity_supported > 0:
                top_similarity_supported.append({
                    "landblock": lbid,
                    "wcid": wcid,
                    "name": meta.get("name") if meta else None,
                    "weenie_type_name": meta.get("weenie_type_name") if meta else None,
                    "generated": gen,
                    "reference_neighborhood": ref,
                    "similarity_support_available": round(similarity_support_available, 3),
                    "similarity_supported": round(similarity_supported, 3),
                    "average_similarity": round(average_similarity, 3),
                    "similarity_reward": round(similarity_reward, 3),
                    "similarity_mismatch_penalty": round(similarity_mismatch_pen, 3),
                })

        best_mix_similarity = 0.0
        best_mix_density = 0.0
        best_mix_landblock = None
        gen_total = sum(gen_counts.values())
        if gen_total > 0:
            for ref_lbid, ref_items in nearby_reference_landblocks(lbid):
                ref_counter = Counter(dict(ref_items))
                ref_total = sum(ref_counter.values())
                if ref_total <= 0:
                    continue
                mix_similarity = weighted_jaccard_similarity(gen_counts, ref_counter, weights)
                density_ratio = min(gen_total, ref_total) / max(gen_total, ref_total)
                mix_score = mix_similarity * math.sqrt(density_ratio)
                if mix_score > best_mix_similarity * math.sqrt(best_mix_density if best_mix_density > 0 else 0):
                    best_mix_similarity = mix_similarity
                    best_mix_density = density_ratio
                    best_mix_landblock = ref_lbid

        if best_mix_landblock is not None:
            lb_mix_reward = best_mix_similarity * math.sqrt(best_mix_density) * 4.0
            lb_score += lb_mix_reward
            top_mix_supported.append({
                "landblock": lbid,
                "best_reference_landblock": best_mix_landblock,
                "mix_similarity": round(best_mix_similarity, 3),
                "density_ratio": round(best_mix_density, 3),
                "mix_reward": round(lb_mix_reward, 3),
                "generated_total": int(gen_total),
            })

        total_score += lb_score
        matched_reward += lb_reward
        similarity_matched_reward += lb_similarity_reward
        mix_matched_reward += lb_mix_reward
        overgen_penalty += lb_over
        missing_penalty += lb_missing
        landblock_rows.append({
            "landblock": lbid,
            "score": round(lb_score, 3),
            "matched_reward": round(lb_reward, 3),
            "similarity_matched_reward": round(lb_similarity_reward, 3),
            "mix_matched_reward": round(lb_mix_reward, 3),
            "overgeneration_penalty": round(lb_over, 3),
            "missing_penalty": round(lb_missing, 3),
            "generated_total": int(sum(gen_counts.values())),
            "neighborhood_reference_total": int(sum(ref_counts.values())),
            "generated_unique": int(len(gen_counts)),
            "neighborhood_reference_unique": int(len(ref_counts)),
        })

    return {
        "generated_landblocks": len(generated),
        "evaluated_landblocks": len(evaluated_lbs),
        "reference_landblocks": len(reference_landblocks),
        "radius": radius,
        "neighborhood_cap": neighborhood_cap,
        "similarity_credit_ratio": similarity_credit_ratio,
        "similarity_penalty_ratio": similarity_penalty_ratio,
        "total_score": round(total_score, 3),
        "matched_reward": round(matched_reward, 3),
        "similarity_matched_reward": round(similarity_matched_reward, 3),
        "mix_matched_reward": round(mix_matched_reward, 3),
        "overgeneration_penalty": round(overgen_penalty, 3),
        "missing_penalty": round(missing_penalty, 3),
        "worst_landblocks": sorted(landblock_rows, key=lambda row: row["score"])[:25],
        "best_landblocks": sorted(landblock_rows, key=lambda row: row["score"], reverse=True)[:25],
        "top_overgenerated": sorted(top_overgenerated, key=lambda row: row["penalty"], reverse=True)[:50],
        "top_similarity_supported": sorted(top_similarity_supported, key=lambda row: row["similarity_reward"], reverse=True)[:50],
        "top_mix_supported": sorted(top_mix_supported, key=lambda row: row["mix_reward"], reverse=True)[:50],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Neighborhood-aware frequency scoring for generated world SQL.")
    parser.add_argument("sql_path", type=Path)
    parser.add_argument("--weights-json", type=Path, default=DEFAULT_WEIGHTS_JSON)
    parser.add_argument("--landblock-reference-json", type=Path, default=DEFAULT_LANDBLOCK_REFERENCE_JSON)
    parser.add_argument("--similarity-json", type=Path, default=DEFAULT_SIMILARITY_JSON)
    parser.add_argument("--radius", type=int, default=1, help="Neighborhood radius in landblocks")
    parser.add_argument(
        "--neighborhood-cap",
        type=int,
        default=8,
        help="Cap per-WCID neighborhood reference counts to avoid giant retail totals overpowering local plausibility",
    )
    parser.add_argument(
        "--similarity-credit-ratio",
        type=float,
        default=0.3,
        help="Fraction of exact-match reward granted to generated WCIDs that are unsupported exactly but supported by mathematically similar nearby WCIDs",
    )
    parser.add_argument(
        "--similarity-penalty-ratio",
        type=float,
        default=0.55,
        help="Residual penalty fraction applied to similarity-supported mismatches so nearby plausibility softens but does not erase wrong-class generation",
    )
    parser.add_argument("--out-json", type=Path, default=None)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    generated = parse_generated_sql_by_landblock(args.sql_path)
    weights_doc = load_json(args.weights_json)
    reference_doc = load_json(args.landblock_reference_json)
    similarity_doc = load_json(args.similarity_json)
    reference_landblocks = build_reference_landblocks(reference_doc)
    summary = evaluate_neighborhoods(
        generated=generated,
        reference_landblocks=reference_landblocks,
        weights=weights_doc["weights"],
        similarity_doc=similarity_doc,
        radius=args.radius,
        neighborhood_cap=args.neighborhood_cap,
        similarity_credit_ratio=args.similarity_credit_ratio,
        similarity_penalty_ratio=args.similarity_penalty_ratio,
    )
    summary["sql_path"] = str(args.sql_path)
    if args.out_json:
        with args.out_json.open("w", encoding="utf-8") as f:
            json.dump(summary, f, indent=2)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()

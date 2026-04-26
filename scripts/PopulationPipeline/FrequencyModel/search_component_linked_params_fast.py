#!/usr/bin/env python3
"""
Fast parameter search for component-linked checkpoints.

This samples generation-time parameters and scores them with the lightweight
comparator on a tiny fixed landblock set so we can quickly find better
inference settings for a specific checkpoint.
"""

from __future__ import annotations

import argparse
import json
import random
from datetime import datetime, timezone
from pathlib import Path

from compare_component_linked_checkpoints_fast import (
    ROOT,
    fixed_regions,
    load_module,
    BENCHMARK_PATH,
    SCORER_PATH,
    select_landblocks,
    generate_counts_for_contexts,
    summarize_region,
)

import numpy as np
import torch


REFERENCE_DIR = ROOT / "pipeline_data" / "reference"
DEFAULT_PARAMS_JSON = REFERENCE_DIR / "frequency_search_best_candidate_20260331.json"
DEFAULT_OUTPUT_ROOT = ROOT / "pipeline_data" / "search_runs"


def utc_now_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fast search over component-linked inference params")
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--params-json", type=Path, default=DEFAULT_PARAMS_JSON)
    parser.add_argument("--candidates", type=int, default=24)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--max-steps", type=int, default=32)
    parser.add_argument("--max-landblocks", type=int, default=4)
    parser.add_argument("--require-cuda", action="store_true", default=True)
    parser.add_argument("--no-require-cuda", action="store_false", dest="require_cuda")
    parser.add_argument("--outdir", type=Path, default=None)
    return parser.parse_args()


def sample_candidate(rng: random.Random, baseline: dict) -> dict:
    def clamp(value, low, high, digits=3):
        return round(max(low, min(high, value)), digits)

    top_k_choices = [16, 24, 32, 48]
    if int(baseline["top_k"]) in top_k_choices:
        top_k_choices.extend([int(baseline["top_k"])] * 3)
    top_k = rng.choice(top_k_choices)

    candidate = {
        "temperature": clamp(rng.uniform(float(baseline["temperature"]) - 0.04, float(baseline["temperature"]) + 0.04), 0.92, 1.1),
        "top_k": top_k,
        "nucleus_p": clamp(rng.uniform(float(baseline["nucleus_p"]) - 0.02, float(baseline["nucleus_p"]) + 0.02), 0.92, 0.995),
        "frequency_penalty": clamp(rng.uniform(float(baseline["frequency_penalty"]) - 0.08, float(baseline["frequency_penalty"]) + 0.08), 0.02, 0.36),
        "min_objects": max(5, min(9, int(baseline["min_objects"]) + rng.choice([-1, 0, 0, 1]))),
        "adaptive_min_objects_bonus": max(0, min(3, int(baseline["adaptive_min_objects_bonus"]) + rng.choice([-1, 0, 1]))),
        "pad_logit_bias": clamp(rng.uniform(float(baseline["pad_logit_bias"]) - 0.25, float(baseline["pad_logit_bias"]) + 0.25), 0.6, 1.5),
        "stop_logit_bias": clamp(rng.uniform(float(baseline["stop_logit_bias"]) - 0.18, float(baseline["stop_logit_bias"]) + 0.18), 0.25, 0.95),
        "housing_logit_bias": clamp(rng.uniform(float(baseline["housing_logit_bias"]) - 0.08, float(baseline["housing_logit_bias"]) + 0.08), -0.15, 0.2),
        "housing_flatness_threshold": clamp(rng.uniform(float(baseline["housing_flatness_threshold"]) - 0.06, float(baseline["housing_flatness_threshold"]) + 0.06), 0.5, 0.75),
        "housing_difficulty_ceiling": clamp(rng.uniform(float(baseline["housing_difficulty_ceiling"]) - 0.06, float(baseline["housing_difficulty_ceiling"]) + 0.06), 0.5, 0.75),
        "housing_min_placements": max(0, min(3, int(baseline["housing_min_placements"]) + rng.choice([-1, 0, 0, 1]))),
        "max_housing_per_lb": max(0, min(2, int(baseline["max_housing_per_lb"]) + rng.choice([-1, 0, 1]))),
        "inject_town_lifestones": rng.choice([bool(baseline["inject_town_lifestones"]), bool(baseline["inject_town_lifestones"]), not bool(baseline["inject_town_lifestones"])]),
        "town_service_min_objects": max(10, min(24, int(baseline["town_service_min_objects"]) + rng.choice([-4, -2, 0, 0, 2, 4]))),
        "inject_town_vendors": rng.choice([bool(baseline["inject_town_vendors"]), bool(baseline["inject_town_vendors"]), not bool(baseline["inject_town_vendors"])]),
        "town_vendor_min_objects": max(12, min(28, int(baseline["town_vendor_min_objects"]) + rng.choice([-4, -2, 0, 0, 2, 4]))),
    }
    if candidate["town_vendor_min_objects"] < candidate["town_service_min_objects"]:
        candidate["town_vendor_min_objects"] = candidate["town_service_min_objects"] + 2
    return candidate


def score_candidate_summary(summary: dict) -> tuple[float, float, float, float]:
    regions = summary["regions"]
    avg_score_per_row = sum(r["score_per_row"] for r in regions) / len(regions)
    avg_over_penalty = sum(r["over_penalty_per_row"] for r in regions) / len(regions)
    avg_model_id = sum(r["avg_model_id_tokens"] for r in regions) / len(regions)
    avg_rows = sum(r["avg_rows_per_generated_lb"] for r in regions) / len(regions)
    return (avg_score_per_row, -avg_over_penalty, -avg_model_id, avg_rows)


def main() -> None:
    args = parse_args()
    outdir = args.outdir or (DEFAULT_OUTPUT_ROOT / f"fast_component_search_{args.model.stem}_{utc_now_stamp()}")
    outdir.mkdir(parents=True, exist_ok=True)

    bench_module = load_module(BENCHMARK_PATH, "run_model_benchmark_fast_search")
    scorer = load_module(SCORER_PATH, "score_neighborhood_frequency_fast_search")
    train_module = bench_module.load_train_scene_placer_module()
    ScenePlacerTransformer = train_module.ScenePlacerTransformer
    default_config = train_module.DEFAULT_CONFIG

    device = torch.device("cuda" if args.require_cuda and torch.cuda.is_available() else "cpu")
    if args.require_cuda and device.type != "cuda":
        raise SystemExit("CUDA was requested with --require-cuda, but torch.cuda.is_available() is false.")

    baseline_params = bench_module.load_params(args.params_json)
    weights_doc = scorer.load_json(ROOT / "pipeline_data/reference/dereth_frequency_weights.json")
    reference_doc = scorer.load_json(ROOT / "pipeline_data/reference/dereth_landblock_reference_counts.json")
    similarity_doc = scorer.load_json(ROOT / "pipeline_data/reference/dereth_wcid_similarity.json")
    reference_landblocks = scorer.build_reference_landblocks(reference_doc)
    tensor_doc = np.load(bench_module.COMPONENT_TENSOR_PATH)

    state_dict = bench_module.load_state_dict(args.model, device)
    layout = bench_module.infer_model_layout(state_dict)
    schema = bench_module.detect_schema(layout)
    if schema != "component_linked":
        raise SystemExit(f"{args.model} is schema={schema}, expected component_linked")
    vocab_path, vocab = bench_module.load_vocab_for_schema(schema)

    config = dict(default_config)
    config["context_dim"] = layout["context_dim"]
    config["obj_dim"] = layout["obj_dim"]
    config["max_seq_len"] = layout["max_seq_len"]
    config["vocab_path"] = str(vocab_path)

    model = ScenePlacerTransformer(config).to(device)
    missing, unexpected = model.load_state_dict(state_dict, strict=False)
    real_missing = [key for key in missing if key not in {"causal_mask", "pos_encoding.pe"}]
    if real_missing or unexpected:
        raise RuntimeError(
            f"Checkpoint mismatch for {args.model}: missing={real_missing}, unexpected={list(unexpected)}"
        )
    model.eval()

    idx_to_class_key = {int(k): tuple(v) for k, v in vocab["idx_to_class_key"].items()}
    class_space_codes = {str(k): int(v) for k, v in vocab.get("class_space_codes", {}).items()}

    rng = random.Random(args.seed)
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)

    candidates = [{"candidate_id": "baseline", "params": baseline_params}]
    for idx in range(args.candidates):
        candidates.append({"candidate_id": f"cand_{idx:03d}", "params": sample_candidate(rng, baseline_params)})

    results = []
    regions = fixed_regions()

    for row in candidates:
        params = row["params"]
        candidate_summary = {
            "candidate_id": row["candidate_id"],
            "params": params,
            "regions": [],
        }

        for region in regions:
            region_contexts = bench_module._component_contexts_for_benchmark(tensor_doc, region)
            selected_contexts = select_landblocks(region_contexts, args.max_landblocks)

            started = datetime.now(timezone.utc)
            generated_by_lb, debug_rows = generate_counts_for_contexts(
                model=model,
                contexts_by_lb=selected_contexts,
                layout=layout,
                idx_to_class_key=idx_to_class_key,
                class_space_codes=class_space_codes,
                params=params,
                max_steps=args.max_steps,
                bench_module=bench_module,
                device=device,
            )
            elapsed_sec = (datetime.now(timezone.utc) - started).total_seconds()

            score_summary = scorer.evaluate_neighborhoods(
                generated=generated_by_lb,
                reference_landblocks=reference_landblocks,
                weights=weights_doc["weights"],
                similarity_doc=similarity_doc,
                radius=1,
                neighborhood_cap=8,
                similarity_credit_ratio=0.3,
                similarity_penalty_ratio=0.55,
                expected_landblocks=list(selected_contexts.keys()),
            )
            candidate_summary["regions"].append(
                summarize_region(region, generated_by_lb, debug_rows, score_summary, elapsed_sec)
            )

        ranking = score_candidate_summary(candidate_summary)
        candidate_summary["avg_score_per_row"] = round(ranking[0], 6)
        candidate_summary["avg_over_penalty_per_row"] = round(-ranking[1], 6)
        candidate_summary["avg_model_id_tokens"] = round(-ranking[2], 6)
        candidate_summary["avg_rows_per_generated_lb"] = round(ranking[3], 6)
        results.append(candidate_summary)

    results.sort(key=score_candidate_summary, reverse=True)

    payload = {
        "model": str(args.model),
        "seed": args.seed,
        "max_steps": args.max_steps,
        "max_landblocks": args.max_landblocks,
        "candidates_evaluated": len(results),
        "results": results,
    }

    output_path = outdir / "fast_component_linked_param_search.json"
    with output_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    print(f"Wrote {output_path}")
    print(json.dumps(results[:5], indent=2))


if __name__ == "__main__":
    main()

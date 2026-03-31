#!/usr/bin/env python3
"""
Focus evaluation around a target training epoch.

This script is intended for the high-leverage loop where the exact target epoch
may not have been checkpointed. It reads the training history, finds the
closest saved checkpoints around the target epoch, runs broader small-region
coverage than the tiny comparator alone, and searches inference parameters in a
neighborhood that preserves the known non-collapsed baseline.
"""

from __future__ import annotations

import argparse
import json
import random
import re
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch

from compare_component_linked_checkpoints_fast import (
    ROOT,
    BENCHMARK_PATH,
    SCORER_PATH,
    generate_counts_for_contexts,
    load_module,
    select_landblocks,
    summarize_region,
)


MODEL_DIR = ROOT / "pipeline_data" / "models"
LOG_DIR = MODEL_DIR / "logs"
REFERENCE_DIR = ROOT / "pipeline_data" / "reference"
DEFAULT_PARAMS_JSON = REFERENCE_DIR / "frequency_search_best_candidate_20260331.json"
OUTPUT_ROOT = ROOT / "pipeline_data" / "search_runs"


def utc_now_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Focus evaluation around a target checkpoint epoch")
    parser.add_argument(
        "--run-name",
        default="scene_placer_component_linked_continue_20260331T163030Z",
        help="Training lineage prefix used for checkpoint and log discovery.",
    )
    parser.add_argument("--target-epoch", type=int, default=254)
    parser.add_argument("--params-json", type=Path, default=DEFAULT_PARAMS_JSON)
    parser.add_argument("--candidates", type=int, default=16)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--max-steps", type=int, default=40)
    parser.add_argument(
        "--max-landblocks",
        type=int,
        default=8,
        help="Maximum landblocks per region. Use 0 to evaluate the full region slice.",
    )
    parser.add_argument("--require-cuda", action="store_true", default=True)
    parser.add_argument("--no-require-cuda", action="store_false", dest="require_cuda")
    parser.add_argument("--outdir", type=Path, default=None)
    return parser.parse_args()


def coverage_regions() -> list[dict]:
    return [
        {
            "name": "probe_5x5",
            "lb_x_min": 30,
            "lb_x_max": 34,
            "lb_y_min": 120,
            "lb_y_max": 124,
        },
        {
            "name": "region_a_4x4",
            "lb_x_min": 30,
            "lb_x_max": 33,
            "lb_y_min": 120,
            "lb_y_max": 123,
        },
        {
            "name": "region_b_4x4",
            "lb_x_min": 50,
            "lb_x_max": 53,
            "lb_y_min": 120,
            "lb_y_max": 123,
        },
        {
            "name": "region_c_4x4",
            "lb_x_min": 30,
            "lb_x_max": 33,
            "lb_y_min": 126,
            "lb_y_max": 129,
        },
    ]


def load_history_row(history_path: Path, target_epoch: int) -> dict:
    rows = json.loads(history_path.read_text())
    for row in rows:
        if int(row.get("epoch", -1)) == target_epoch:
            return row
    raise FileNotFoundError(f"Did not find epoch {target_epoch} in {history_path}")


def discover_bracketing_models(model_dir: Path, run_name: str, target_epoch: int) -> list[dict]:
    pattern = re.compile(rf"^{re.escape(run_name)}_resume_epoch_(\d+)\.pt$")
    checkpoint_rows = []
    for path in sorted(model_dir.glob(f"{run_name}_resume_epoch_*.pt")):
        match = pattern.match(path.name)
        if not match:
            continue
        checkpoint_epoch = int(match.group(1))
        checkpoint_rows.append(
            {
                "label": f"epoch_{checkpoint_epoch}",
                "epoch": checkpoint_epoch,
                "path": path,
                "distance": abs(checkpoint_epoch - target_epoch),
            }
        )

    selected: list[dict] = []
    before = [row for row in checkpoint_rows if row["epoch"] <= target_epoch]
    after = [row for row in checkpoint_rows if row["epoch"] >= target_epoch]
    if before:
        selected.append(before[-1])
    if after and (not selected or after[0]["path"] != selected[0]["path"]):
        selected.append(after[0])

    if not before or not after:
        global_pattern = re.compile(r"^(.*)_resume_epoch_(\d+)\.pt$")
        global_rows = []
        for path in sorted(model_dir.glob("*_resume_epoch_*.pt")):
            match = global_pattern.match(path.name)
            if not match:
                continue
            checkpoint_epoch = int(match.group(2))
            global_rows.append(
                {
                    "label": f"epoch_{checkpoint_epoch}",
                    "epoch": checkpoint_epoch,
                    "path": path,
                    "distance": abs(checkpoint_epoch - target_epoch),
                }
            )

        if not before:
            global_before = [row for row in global_rows if row["epoch"] <= target_epoch]
            if global_before:
                selected.append(global_before[-1])
        if not after:
            global_after = [row for row in global_rows if row["epoch"] >= target_epoch]
            if global_after:
                selected.append(global_after[0])

    best_path = model_dir / f"{run_name}_best.safetensors"
    if best_path.exists():
        selected.append(
            {
                "label": "best",
                "epoch": None,
                "path": best_path,
                "distance": None,
            }
        )

    final_path = model_dir / f"{run_name}_final.safetensors"
    if final_path.exists():
        selected.append(
            {
                "label": "final",
                "epoch": None,
                "path": final_path,
                "distance": None,
            }
        )

    deduped = []
    seen = set()
    for row in selected:
        key = str(row["path"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(row)
    return deduped


def infer_layout_for_focus(bench_module, state_dict: dict) -> dict:
    layout = {
        "context_dim": int(state_dict["ctx_proj.proj.0.weight"].shape[1]),
        "obj_dim": int(state_dict["obj_embed.continuous_proj.weight"].shape[1] + 1),
        "vocab_size": int(state_dict["wcid_head.bias"].shape[0]),
    }
    if "causal_mask" in state_dict:
        layout["max_seq_len"] = int(state_dict["causal_mask"].shape[0] - 1)
    elif "pos_encoding.pe" in state_dict:
        layout["max_seq_len"] = int(state_dict["pos_encoding.pe"].shape[1] - 1)
    else:
        layout["max_seq_len"] = 256
    return layout


def focused_baseline_params(path: Path) -> dict:
    payload = json.loads(path.read_text())
    params = dict(payload.get("params", payload))
    params.update(
        {
            "temperature": 1.0,
            "top_k": 0,
            "nucleus_p": 1.0,
            "frequency_penalty": 0.3,
            "min_objects": 5,
            "adaptive_min_objects_bonus": 2,
            "pad_logit_bias": 1.0,
            "stop_logit_bias": 0.5,
            "housing_logit_bias": 0.0,
            "housing_flatness_threshold": 0.6,
            "housing_difficulty_ceiling": 0.6,
            "housing_min_placements": 2,
            "max_housing_per_lb": 1,
        }
    )
    return params


def sample_candidate(rng: random.Random, baseline: dict) -> dict:
    def clamp(value: float, low: float, high: float, digits: int = 3) -> float:
        return round(max(low, min(high, value)), digits)

    top_k = rng.choice([0, 0, 0, 8, 16, 24])
    candidate = dict(baseline)
    candidate.update(
        {
            "temperature": clamp(rng.uniform(float(baseline["temperature"]) - 0.06, float(baseline["temperature"]) + 0.06), 0.92, 1.08),
            "top_k": top_k,
            "nucleus_p": clamp(rng.uniform(float(baseline["nucleus_p"]) - 0.04, float(baseline["nucleus_p"])), 0.96, 1.0),
            "frequency_penalty": clamp(rng.uniform(float(baseline["frequency_penalty"]) - 0.12, float(baseline["frequency_penalty"]) + 0.08), 0.1, 0.38),
            "min_objects": max(4, min(8, int(baseline["min_objects"]) + rng.choice([-1, 0, 0, 1]))),
            "adaptive_min_objects_bonus": max(0, min(3, int(baseline["adaptive_min_objects_bonus"]) + rng.choice([-1, 0, 1]))),
            "pad_logit_bias": clamp(rng.uniform(float(baseline["pad_logit_bias"]) - 0.25, float(baseline["pad_logit_bias"]) + 0.2), 0.75, 1.35),
            "stop_logit_bias": clamp(rng.uniform(float(baseline["stop_logit_bias"]) - 0.18, float(baseline["stop_logit_bias"]) + 0.18), 0.25, 0.8),
            "housing_logit_bias": clamp(rng.uniform(float(baseline["housing_logit_bias"]) - 0.08, float(baseline["housing_logit_bias"]) + 0.16), -0.1, 0.25),
            "housing_flatness_threshold": clamp(rng.uniform(float(baseline["housing_flatness_threshold"]) - 0.08, float(baseline["housing_flatness_threshold"]) + 0.06), 0.45, 0.7),
            "housing_difficulty_ceiling": clamp(rng.uniform(float(baseline["housing_difficulty_ceiling"]) - 0.08, float(baseline["housing_difficulty_ceiling"]) + 0.06), 0.45, 0.7),
            "housing_min_placements": max(0, min(3, int(baseline["housing_min_placements"]) + rng.choice([-1, 0, 0, 1]))),
            "max_housing_per_lb": max(0, min(2, int(baseline["max_housing_per_lb"]) + rng.choice([0, 0, 1]))),
            "inject_town_lifestones": rng.choice([True, True, False]),
            "inject_town_vendors": rng.choice([True, True, False]),
            "town_service_min_objects": max(10, min(22, int(baseline["town_service_min_objects"]) + rng.choice([-4, -2, 0, 0, 2]))),
            "town_vendor_min_objects": max(12, min(26, int(baseline["town_vendor_min_objects"]) + rng.choice([-4, -2, 0, 0, 2]))),
        }
    )
    if candidate["town_vendor_min_objects"] < candidate["town_service_min_objects"]:
        candidate["town_vendor_min_objects"] = candidate["town_service_min_objects"] + 2
    if candidate["top_k"] == 0:
        candidate["nucleus_p"] = 1.0
    return candidate


def score_summary(summary: dict) -> tuple[float, float, float, float, float]:
    regions = summary["regions"]
    avg_score_per_row = sum(row["score_per_row"] for row in regions) / len(regions)
    avg_score_per_lb = sum(row["score_per_landblock"] for row in regions) / len(regions)
    avg_over_penalty = sum(row["over_penalty_per_row"] for row in regions) / len(regions)
    avg_model_id = sum(row["avg_model_id_tokens"] for row in regions) / len(regions)
    avg_rows = sum(row["avg_rows_per_generated_lb"] for row in regions) / len(regions)
    return (avg_score_per_row, avg_score_per_lb, -avg_over_penalty, -avg_model_id, avg_rows)


def evaluate_candidate(
    model,
    layout: dict,
    idx_to_class_key: dict[int, tuple[str, int]],
    class_space_codes: dict[str, int],
    params: dict,
    max_steps: int,
    max_landblocks: int,
    bench_module,
    scorer,
    tensor_doc,
    reference_landblocks,
    weights_doc: dict,
    similarity_doc: dict,
    device: torch.device,
) -> dict:
    summary = {"params": params, "regions": []}
    for region in coverage_regions():
        region_contexts = bench_module._component_contexts_for_benchmark(tensor_doc, region)
        if max_landblocks > 0:
            selected_contexts = select_landblocks(region_contexts, max_landblocks)
        else:
            selected_contexts = dict(sorted(region_contexts.items()))

        started = datetime.now(timezone.utc)
        generated_by_lb, debug_rows = generate_counts_for_contexts(
            model=model,
            contexts_by_lb=selected_contexts,
            layout=layout,
            idx_to_class_key=idx_to_class_key,
            class_space_codes=class_space_codes,
            params=params,
            max_steps=max_steps,
            bench_module=bench_module,
            device=device,
        )
        elapsed_sec = (datetime.now(timezone.utc) - started).total_seconds()
        score = scorer.evaluate_neighborhoods(
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
        summary["regions"].append(summarize_region(region, generated_by_lb, debug_rows, score, elapsed_sec))

    summary["avg_score_per_row"] = round(sum(row["score_per_row"] for row in summary["regions"]) / len(summary["regions"]), 6)
    summary["avg_score_per_landblock"] = round(sum(row["score_per_landblock"] for row in summary["regions"]) / len(summary["regions"]), 6)
    summary["avg_over_penalty_per_row"] = round(sum(row["over_penalty_per_row"] for row in summary["regions"]) / len(summary["regions"]), 6)
    summary["avg_model_id_tokens"] = round(sum(row["avg_model_id_tokens"] for row in summary["regions"]) / len(summary["regions"]), 6)
    summary["avg_rows_per_generated_lb"] = round(sum(row["avg_rows_per_generated_lb"] for row in summary["regions"]) / len(summary["regions"]), 6)
    return summary


def main() -> None:
    args = parse_args()
    outdir = args.outdir or (OUTPUT_ROOT / f"focus_{args.run_name}_epoch{args.target_epoch}_{utc_now_stamp()}")
    outdir.mkdir(parents=True, exist_ok=True)

    history_path = LOG_DIR / args.run_name / "training_history.json"
    target_metrics = load_history_row(history_path, args.target_epoch)
    models = discover_bracketing_models(MODEL_DIR, args.run_name, args.target_epoch)
    if not models:
        raise SystemExit(f"No checkpoints discovered for run {args.run_name}")

    bench_module = load_module(BENCHMARK_PATH, "run_model_benchmark_focus_epoch")
    scorer = load_module(SCORER_PATH, "score_neighborhood_frequency_focus_epoch")
    train_module = bench_module.load_train_scene_placer_module()
    ScenePlacerTransformer = train_module.ScenePlacerTransformer
    default_config = train_module.DEFAULT_CONFIG

    device = torch.device("cuda" if args.require_cuda and torch.cuda.is_available() else "cpu")
    if args.require_cuda and device.type != "cuda":
        raise SystemExit("CUDA was requested with --require-cuda, but torch.cuda.is_available() is false.")

    baseline_params = focused_baseline_params(args.params_json)
    weights_doc = scorer.load_json(ROOT / "pipeline_data/reference/dereth_frequency_weights.json")
    reference_doc = scorer.load_json(ROOT / "pipeline_data/reference/dereth_landblock_reference_counts.json")
    similarity_doc = scorer.load_json(ROOT / "pipeline_data/reference/dereth_wcid_similarity.json")
    reference_landblocks = scorer.build_reference_landblocks(reference_doc)
    tensor_doc = np.load(bench_module.COMPONENT_TENSOR_PATH)

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    rng = random.Random(args.seed)

    payload = {
        "run_name": args.run_name,
        "target_epoch": args.target_epoch,
        "target_epoch_metrics": target_metrics,
        "baseline_params": baseline_params,
        "models": [],
    }

    for model_row in models:
        state_dict = bench_module.load_state_dict(model_row["path"], device)
        layout = infer_layout_for_focus(bench_module, state_dict)
        schema = bench_module.detect_schema(layout)
        if schema != "component_linked":
            raise SystemExit(f"{model_row['path']} is schema={schema}, expected component_linked")
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
                f"Checkpoint mismatch for {model_row['path']}: missing={real_missing}, unexpected={list(unexpected)}"
            )
        model.eval()

        idx_to_class_key = {int(k): tuple(v) for k, v in vocab["idx_to_class_key"].items()}
        class_space_codes = {str(k): int(v) for k, v in vocab.get("class_space_codes", {}).items()}

        baseline_summary = evaluate_candidate(
            model=model,
            layout=layout,
            idx_to_class_key=idx_to_class_key,
            class_space_codes=class_space_codes,
            params=baseline_params,
            max_steps=args.max_steps,
            max_landblocks=args.max_landblocks,
            bench_module=bench_module,
            scorer=scorer,
            tensor_doc=tensor_doc,
            reference_landblocks=reference_landblocks,
            weights_doc=weights_doc,
            similarity_doc=similarity_doc,
            device=device,
        )
        baseline_summary["candidate_id"] = "baseline"

        candidate_summaries = [baseline_summary]
        for candidate_idx in range(args.candidates):
            params = sample_candidate(rng, baseline_params)
            candidate_summary = evaluate_candidate(
                model=model,
                layout=layout,
                idx_to_class_key=idx_to_class_key,
                class_space_codes=class_space_codes,
                params=params,
                max_steps=args.max_steps,
                max_landblocks=args.max_landblocks,
                bench_module=bench_module,
                scorer=scorer,
                tensor_doc=tensor_doc,
                reference_landblocks=reference_landblocks,
                weights_doc=weights_doc,
                similarity_doc=similarity_doc,
                device=device,
            )
            candidate_summary["candidate_id"] = f"cand_{candidate_idx:03d}"
            candidate_summaries.append(candidate_summary)

        candidate_summaries.sort(key=score_summary, reverse=True)
        best_candidate = candidate_summaries[0]

        model_payload = {
            "label": model_row["label"],
            "epoch": model_row["epoch"],
            "path": str(model_row["path"]),
            "distance_from_target": model_row["distance"],
            "best_candidate": best_candidate,
            "baseline": baseline_summary,
            "top_candidates": candidate_summaries[:5],
        }
        payload["models"].append(model_payload)

        best_params_path = outdir / f"{model_row['label']}_best_params.json"
        best_params_path.write_text(json.dumps(best_candidate, indent=2), encoding="utf-8")

    output_path = outdir / "focus_checkpoint_epoch.json"
    output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {output_path}")
    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()

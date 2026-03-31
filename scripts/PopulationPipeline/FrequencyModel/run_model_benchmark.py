#!/usr/bin/env python3
"""
run_model_benchmark.py
======================

Run a fixed benchmark suite for a specific model checkpoint using a saved
generation-parameter preset, then score each region with the neighborhood
frequency evaluator.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
MODEL_DIR = ROOT / "pipeline_data" / "models"
REFERENCE_DIR = ROOT / "pipeline_data" / "reference"
OUTPUT_ROOT = ROOT / "pipeline_data" / "search_runs"
GENERATOR_PATH = ROOT / "scripts" / "PopulationPipeline" / "OutdoorML" / "generate_populated_world.py"
SCORER_PATH = Path(__file__).with_name("score_neighborhood_frequency.py")
DEFAULT_MODEL = MODEL_DIR / "scene_placer_final.pt"
DEFAULT_PARAMS_JSON = REFERENCE_DIR / "frequency_search_best_candidate_20260331.json"

DEFAULT_BENCHMARKS = [
    {"name": "region_a_400", "lb_x_min": 30, "lb_x_max": 49, "lb_y_min": 120, "lb_y_max": 139},
    {"name": "region_b_400", "lb_x_min": 50, "lb_x_max": 69, "lb_y_min": 120, "lb_y_max": 139},
    {"name": "region_c_100", "lb_x_min": 30, "lb_x_max": 39, "lb_y_min": 120, "lb_y_max": 129},
]


def utc_now_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def load_scorer_module():
    spec = importlib.util.spec_from_file_location("score_neighborhood_frequency", SCORER_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Benchmark one model checkpoint with a fixed parameter preset.")
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--params-json", type=Path, default=DEFAULT_PARAMS_JSON)
    parser.add_argument("--outdir", type=Path, default=None)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--progress-every", type=int, default=25)
    parser.add_argument("--landblock-batch-size", type=int, default=1)
    parser.add_argument("--require-cuda", action="store_true", default=True)
    parser.add_argument("--no-require-cuda", action="store_false", dest="require_cuda")
    return parser.parse_args()


def load_params(path: Path) -> dict:
    payload = json.loads(path.read_text())
    return payload.get("params", payload)


def ensure_outdir(args: argparse.Namespace) -> Path:
    if args.outdir:
        outdir = args.outdir
    else:
        outdir = OUTPUT_ROOT / f"model_benchmark_{args.model.stem}_{utc_now_stamp()}"
    outdir.mkdir(parents=True, exist_ok=True)
    return outdir


def write_json(path: Path, payload: dict | list) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)


def params_to_args(params: dict) -> list[str]:
    args = [
        "--temperature", str(params["temperature"]),
        "--top-k", str(params["top_k"]),
        "--nucleus-p", str(params["nucleus_p"]),
        "--frequency-penalty", str(params["frequency_penalty"]),
        "--min-objects", str(params["min_objects"]),
        "--adaptive-min-objects-bonus", str(params["adaptive_min_objects_bonus"]),
        "--pad-logit-bias", str(params["pad_logit_bias"]),
        "--stop-logit-bias", str(params["stop_logit_bias"]),
        "--housing-logit-bias", str(params["housing_logit_bias"]),
        "--housing-flatness-threshold", str(params["housing_flatness_threshold"]),
        "--housing-difficulty-ceiling", str(params["housing_difficulty_ceiling"]),
        "--housing-min-placements", str(params["housing_min_placements"]),
        "--max-housing-per-lb", str(params["max_housing_per_lb"]),
        "--town-service-min-objects", str(params["town_service_min_objects"]),
        "--town-vendor-min-objects", str(params["town_vendor_min_objects"]),
    ]
    args.append("--inject-town-lifestones" if params["inject_town_lifestones"] else "--no-inject-town-lifestones")
    args.append("--inject-town-vendors" if params["inject_town_vendors"] else "--no-inject-town-vendors")
    return args


def main() -> None:
    args = parse_args()
    outdir = ensure_outdir(args)
    params = load_params(args.params_json)
    scorer = load_scorer_module()

    weights_doc = scorer.load_json(ROOT / "pipeline_data/reference/dereth_frequency_weights.json")
    reference_doc = scorer.load_json(ROOT / "pipeline_data/reference/dereth_landblock_reference_counts.json")
    similarity_doc = scorer.load_json(ROOT / "pipeline_data/reference/dereth_wcid_similarity.json")
    reference_landblocks = scorer.build_reference_landblocks(reference_doc)

    manifest = {
        "started_at": utc_now_stamp(),
        "model": str(args.model),
        "params_json": str(args.params_json),
        "params": params,
        "seed": args.seed,
        "benchmarks": DEFAULT_BENCHMARKS,
    }
    write_json(outdir / "manifest.json", manifest)

    benchmark_rows = []
    total_generation_sec = 0.0

    for benchmark in DEFAULT_BENCHMARKS:
        sql_path = outdir / f"{benchmark['name']}.sql"
        summary_path = outdir / f"{benchmark['name']}_summary.json"
        log_path = outdir / f"{benchmark['name']}.log"

        cmd = [
            "python3",
            str(GENERATOR_PATH),
            "--model", args.model.name if args.model.parent == MODEL_DIR else str(args.model),
            "--output-sql", str(sql_path),
            "--summary-json", str(summary_path),
            "--progress-every", str(args.progress_every),
            "--landblock-batch-size", str(args.landblock_batch_size),
            "--seed", str(args.seed),
            "--lb-x-min", str(benchmark["lb_x_min"]),
            "--lb-x-max", str(benchmark["lb_x_max"]),
            "--lb-y-min", str(benchmark["lb_y_min"]),
            "--lb-y-max", str(benchmark["lb_y_max"]),
        ]
        if args.require_cuda:
            cmd.append("--require-cuda")
        cmd.extend(params_to_args(params))

        with log_path.open("w", encoding="utf-8") as log_file:
            subprocess.run(cmd, cwd=ROOT, stdout=log_file, stderr=subprocess.STDOUT, check=True)

        summary_doc = json.loads(summary_path.read_text())
        total_generation_sec += float(summary_doc.get("generation_time_sec", 0.0))
        generated = scorer.parse_generated_sql_by_landblock(sql_path)
        score_summary = scorer.evaluate_neighborhoods(
            generated=generated,
            reference_landblocks=reference_landblocks,
            weights=weights_doc["weights"],
            similarity_doc=similarity_doc,
            radius=1,
            neighborhood_cap=8,
            similarity_credit_ratio=0.3,
            similarity_penalty_ratio=0.55,
            expected_landblocks=scorer.region_landblock_ids(
                benchmark["lb_x_min"],
                benchmark["lb_x_max"],
                benchmark["lb_y_min"],
                benchmark["lb_y_max"],
            ),
        )

        generated_rows = sum(sum(counter.values()) for counter in generated.values())
        generated_landblocks = len(generated)
        benchmark_rows.append(
            {
                "name": benchmark["name"],
                "sql_path": str(sql_path),
                "summary_path": str(summary_path),
                "generation_time_sec": float(summary_doc.get("generation_time_sec", 0.0)),
                "generated_rows": generated_rows,
                "generated_landblocks": generated_landblocks,
                "score_per_row": score_summary["total_score"] / generated_rows if generated_rows else 0.0,
                "score_per_landblock": score_summary["total_score"] / score_summary["evaluated_landblocks"] if score_summary["evaluated_landblocks"] else 0.0,
                "over_penalty_per_row": score_summary["overgeneration_penalty"] / generated_rows if generated_rows else 0.0,
                "mix_reward_per_landblock": score_summary["mix_matched_reward"] / score_summary["evaluated_landblocks"] if score_summary["evaluated_landblocks"] else 0.0,
                "raw": score_summary,
            }
        )

    result = {
        "finished_at": utc_now_stamp(),
        "model": str(args.model),
        "params_json": str(args.params_json),
        "params": params,
        "elapsed_sec": total_generation_sec,
        "avg_score_per_row": sum(row["score_per_row"] for row in benchmark_rows) / len(benchmark_rows),
        "avg_score_per_landblock": sum(row["score_per_landblock"] for row in benchmark_rows) / len(benchmark_rows),
        "avg_over_penalty_per_row": sum(row["over_penalty_per_row"] for row in benchmark_rows) / len(benchmark_rows),
        "avg_mix_reward_per_landblock": sum(row["mix_reward_per_landblock"] for row in benchmark_rows) / len(benchmark_rows),
        "benchmarks": benchmark_rows,
    }
    write_json(outdir / "result.json", result)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()

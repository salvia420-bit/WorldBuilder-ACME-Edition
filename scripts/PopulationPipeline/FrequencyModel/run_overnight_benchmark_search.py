#!/usr/bin/env python3
"""
run_overnight_benchmark_search.py
=================================

Autonomous overnight search over generation parameters using fixed benchmark
regions and the neighborhood frequency scorer.

This does not retrain the model. It searches generation-time knobs, keeps a
leaderboard, and writes all artifacts to a timestamped output directory.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import random
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
MODEL_DIR = ROOT / "pipeline_data" / "models"
OUTPUT_ROOT = ROOT / "pipeline_data" / "search_runs"
SCORER_PATH = Path(__file__).with_name("score_neighborhood_frequency.py")
GENERATOR_PATH = ROOT / "scripts" / "PopulationPipeline" / "OutdoorML" / "generate_populated_world.py"
DEFAULT_MODEL = MODEL_DIR / "scene_placer_final.pt"

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
    parser = argparse.ArgumentParser(description="Run an overnight benchmark search over generation parameters.")
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--hours", type=float, default=8.0)
    parser.add_argument("--max-candidates", type=int, default=9999)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--require-cuda", action="store_true", default=True)
    parser.add_argument("--no-require-cuda", action="store_false", dest="require_cuda")
    parser.add_argument("--keep-top-k", type=int, default=8)
    parser.add_argument("--outdir", type=Path, default=None)
    parser.add_argument("--progress-every", type=int, default=25)
    parser.add_argument("--landblock-batch-size", type=int, default=1)
    parser.add_argument("--summary-json-name", type=str, default="search_summary.json")
    parser.add_argument("--leaderboard-json-name", type=str, default="leaderboard.json")
    return parser.parse_args()


def ensure_outdir(args: argparse.Namespace) -> Path:
    if args.outdir:
        outdir = args.outdir
    else:
        outdir = OUTPUT_ROOT / f"overnight_benchmark_search_{utc_now_stamp()}"
    outdir.mkdir(parents=True, exist_ok=True)
    return outdir


def write_json(path: Path, payload: dict | list) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)


def sample_candidate(rng: random.Random) -> dict:
    top_k = rng.choice([0, 16, 24, 32, 48])
    candidate = {
        "temperature": round(rng.uniform(0.88, 1.08), 3),
        "top_k": top_k,
        "nucleus_p": round(rng.uniform(0.92, 1.0), 3) if top_k == 0 else round(rng.uniform(0.94, 1.0), 3),
        "frequency_penalty": round(rng.uniform(0.18, 0.42), 3),
        "min_objects": rng.choice([4, 5, 6, 7]),
        "adaptive_min_objects_bonus": rng.choice([1, 2, 3]),
        "pad_logit_bias": round(rng.uniform(0.7, 1.4), 3),
        "stop_logit_bias": round(rng.uniform(0.25, 0.9), 3),
        "housing_logit_bias": round(rng.uniform(-0.1, 0.25), 3),
        "housing_flatness_threshold": round(rng.uniform(0.45, 0.72), 3),
        "housing_difficulty_ceiling": round(rng.uniform(0.45, 0.72), 3),
        "housing_min_placements": rng.choice([1, 2, 3]),
        "max_housing_per_lb": rng.choice([0, 1, 2]),
        "inject_town_lifestones": rng.choice([True, True, False]),
        "town_service_min_objects": rng.choice([12, 14, 15, 16, 18]),
        "inject_town_vendors": rng.choice([True, True, False]),
        "town_vendor_min_objects": rng.choice([16, 18, 20, 22, 24]),
    }
    if candidate["town_vendor_min_objects"] < candidate["town_service_min_objects"]:
        candidate["town_vendor_min_objects"] = candidate["town_service_min_objects"] + 2
    return candidate


def candidate_to_args(candidate: dict) -> list[str]:
    args = [
        "--temperature", str(candidate["temperature"]),
        "--top-k", str(candidate["top_k"]),
        "--nucleus-p", str(candidate["nucleus_p"]),
        "--frequency-penalty", str(candidate["frequency_penalty"]),
        "--min-objects", str(candidate["min_objects"]),
        "--adaptive-min-objects-bonus", str(candidate["adaptive_min_objects_bonus"]),
        "--pad-logit-bias", str(candidate["pad_logit_bias"]),
        "--stop-logit-bias", str(candidate["stop_logit_bias"]),
        "--housing-logit-bias", str(candidate["housing_logit_bias"]),
        "--housing-flatness-threshold", str(candidate["housing_flatness_threshold"]),
        "--housing-difficulty-ceiling", str(candidate["housing_difficulty_ceiling"]),
        "--housing-min-placements", str(candidate["housing_min_placements"]),
        "--max-housing-per-lb", str(candidate["max_housing_per_lb"]),
        "--town-service-min-objects", str(candidate["town_service_min_objects"]),
        "--town-vendor-min-objects", str(candidate["town_vendor_min_objects"]),
    ]
    args.append("--inject-town-lifestones" if candidate["inject_town_lifestones"] else "--no-inject-town-lifestones")
    args.append("--inject-town-vendors" if candidate["inject_town_vendors"] else "--no-inject-town-vendors")
    return args


def score_sort_key(row: dict) -> tuple[float, float, float]:
    return (
        row["avg_score_per_row"],
        -row["avg_over_penalty_per_row"],
        row["avg_mix_reward_per_landblock"],
    )


def render_leaderboard(rows: list[dict], limit: int = 10) -> str:
    headers = [
        ("rank", 4),
        ("candidate", 10),
        ("score/row", 11),
        ("over/row", 10),
        ("mix/lb", 9),
        ("sec", 8),
    ]
    lines = []
    lines.append("  ".join(name.ljust(width) for name, width in headers))
    lines.append("  ".join("-" * width for _, width in headers))
    for idx, row in enumerate(sorted(rows, key=score_sort_key, reverse=True)[:limit], start=1):
        lines.append(
            "  ".join(
                [
                    str(idx).rjust(4),
                    row["candidate_id"].ljust(10),
                    f'{row["avg_score_per_row"]:.6f}'.rjust(11),
                    f'{row["avg_over_penalty_per_row"]:.6f}'.rjust(10),
                    f'{row["avg_mix_reward_per_landblock"]:.6f}'.rjust(9),
                    f'{row["elapsed_sec"]:.1f}'.rjust(8),
                ]
            )
        )
    return "\n".join(lines)


def run_generation(cmd: list[str], log_path: Path) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("w", encoding="utf-8") as log_file:
        subprocess.run(cmd, cwd=ROOT, stdout=log_file, stderr=subprocess.STDOUT, check=True)


def evaluate_candidate(
    scorer,
    candidate_id: str,
    candidate: dict,
    model_path: Path,
    outdir: Path,
    require_cuda: bool,
    progress_every: int,
    landblock_batch_size: int,
    seed: int,
) -> dict:
    candidate_dir = outdir / candidate_id
    candidate_dir.mkdir(parents=True, exist_ok=True)
    write_json(candidate_dir / "params.json", candidate)

    benchmark_rows = []
    generation_total = 0.0

    weights_doc = scorer.load_json(ROOT / "pipeline_data/reference/dereth_frequency_weights.json")
    reference_doc = scorer.load_json(ROOT / "pipeline_data/reference/dereth_landblock_reference_counts.json")
    similarity_doc = scorer.load_json(ROOT / "pipeline_data/reference/dereth_wcid_similarity.json")
    reference_landblocks = scorer.build_reference_landblocks(reference_doc)

    for benchmark in DEFAULT_BENCHMARKS:
        bench_name = benchmark["name"]
        sql_path = candidate_dir / f"{bench_name}.sql"
        summary_path = candidate_dir / f"{bench_name}_summary.json"
        log_path = candidate_dir / f"{bench_name}.log"

        cmd = [
            "python3",
            str(GENERATOR_PATH),
            "--model",
            model_path.name if model_path.parent == MODEL_DIR else str(model_path),
            "--output-sql", str(sql_path),
            "--summary-json", str(summary_path),
            "--progress-every", str(progress_every),
            "--landblock-batch-size", str(landblock_batch_size),
            "--seed", str(seed),
            "--lb-x-min", str(benchmark["lb_x_min"]),
            "--lb-x-max", str(benchmark["lb_x_max"]),
            "--lb-y-min", str(benchmark["lb_y_min"]),
            "--lb-y-max", str(benchmark["lb_y_max"]),
        ]
        if require_cuda:
            cmd.append("--require-cuda")
        cmd.extend(candidate_to_args(candidate))

        run_generation(cmd, log_path)

        summary_doc = json.loads(summary_path.read_text())
        generation_total += float(summary_doc.get("generation_time_sec", 0.0))

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
        )
        generated_rows = sum(sum(counter.values()) for counter in generated.values())
        generated_landblocks = len(generated)
        benchmark_rows.append(
            {
                "name": bench_name,
                "sql_path": str(sql_path),
                "summary_path": str(summary_path),
                "generation_time_sec": float(summary_doc.get("generation_time_sec", 0.0)),
                "generated_rows": generated_rows,
                "generated_landblocks": generated_landblocks,
                "score_per_row": score_summary["total_score"] / generated_rows if generated_rows else 0.0,
                "score_per_landblock": score_summary["total_score"] / generated_landblocks if generated_landblocks else 0.0,
                "over_penalty_per_row": score_summary["overgeneration_penalty"] / generated_rows if generated_rows else 0.0,
                "mix_reward_per_landblock": score_summary["mix_matched_reward"] / generated_landblocks if generated_landblocks else 0.0,
                "raw": score_summary,
            }
        )

    avg_score_per_row = sum(row["score_per_row"] for row in benchmark_rows) / len(benchmark_rows)
    avg_score_per_landblock = sum(row["score_per_landblock"] for row in benchmark_rows) / len(benchmark_rows)
    avg_over_penalty_per_row = sum(row["over_penalty_per_row"] for row in benchmark_rows) / len(benchmark_rows)
    avg_mix_reward_per_landblock = sum(row["mix_reward_per_landblock"] for row in benchmark_rows) / len(benchmark_rows)

    result = {
        "candidate_id": candidate_id,
        "params": candidate,
        "elapsed_sec": generation_total,
        "avg_score_per_row": avg_score_per_row,
        "avg_score_per_landblock": avg_score_per_landblock,
        "avg_over_penalty_per_row": avg_over_penalty_per_row,
        "avg_mix_reward_per_landblock": avg_mix_reward_per_landblock,
        "benchmarks": benchmark_rows,
    }
    write_json(candidate_dir / "result.json", result)
    return result


def prune_candidates(rows: list[dict], outdir: Path, keep_top_k: int) -> None:
    ordered = sorted(rows, key=score_sort_key, reverse=True)
    keep_ids = {row["candidate_id"] for row in ordered[:keep_top_k]}
    for candidate_dir in outdir.iterdir():
        if not candidate_dir.is_dir():
            continue
        if candidate_dir.name in keep_ids:
            continue
        if candidate_dir.name.startswith("candidate_"):
            for child in candidate_dir.iterdir():
                if child.suffix in {".sql", ".log"}:
                    child.unlink(missing_ok=True)


def main() -> None:
    args = parse_args()
    outdir = ensure_outdir(args)
    rng = random.Random(args.seed)
    scorer = load_scorer_module()

    manifest = {
        "started_at": utc_now_stamp(),
        "model": str(args.model),
        "hours": args.hours,
        "max_candidates": args.max_candidates,
        "seed": args.seed,
        "benchmarks": DEFAULT_BENCHMARKS,
    }
    write_json(outdir / "manifest.json", manifest)

    deadline = time.time() + args.hours * 3600.0
    leaderboard: list[dict] = []
    candidate_index = 0

    while time.time() < deadline and candidate_index < args.max_candidates:
        candidate_id = f"candidate_{candidate_index:04d}"
        candidate = sample_candidate(rng)
        started = time.time()
        try:
            result = evaluate_candidate(
                scorer=scorer,
                candidate_id=candidate_id,
                candidate=candidate,
                model_path=args.model,
                outdir=outdir,
                require_cuda=args.require_cuda,
                progress_every=args.progress_every,
                landblock_batch_size=args.landblock_batch_size,
                seed=args.seed,
            )
            result["wallclock_sec"] = time.time() - started
            leaderboard.append(result)
            write_json(outdir / args.leaderboard_json_name, sorted(leaderboard, key=score_sort_key, reverse=True))
            write_json(
                outdir / args.summary_json_name,
                {
                    "updated_at": utc_now_stamp(),
                    "completed_candidates": len(leaderboard),
                    "remaining_hours_estimate": max(0.0, (deadline - time.time()) / 3600.0),
                    "best": sorted(leaderboard, key=score_sort_key, reverse=True)[:5],
                },
            )
            prune_candidates(leaderboard, outdir, args.keep_top_k)
            print(render_leaderboard(leaderboard, limit=8), flush=True)
        except subprocess.CalledProcessError as exc:
            failure = {
                "candidate_id": candidate_id,
                "params": candidate,
                "failed": True,
                "returncode": exc.returncode,
            }
            write_json(outdir / candidate_id / "result.json", failure)
        candidate_index += 1

    write_json(
        outdir / "done.json",
        {
            "finished_at": utc_now_stamp(),
            "completed_candidates": len(leaderboard),
            "best": sorted(leaderboard, key=score_sort_key, reverse=True)[:10],
        },
    )


if __name__ == "__main__":
    main()

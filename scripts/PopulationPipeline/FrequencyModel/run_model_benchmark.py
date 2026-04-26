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
import math
import random
import subprocess
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch


ROOT = Path(__file__).resolve().parents[3]
MODEL_DIR = ROOT / "pipeline_data" / "models"
REFERENCE_DIR = ROOT / "pipeline_data" / "reference"
OUTPUT_ROOT = ROOT / "pipeline_data" / "search_runs"
GENERATOR_PATH = ROOT / "scripts" / "PopulationPipeline" / "OutdoorML" / "generate_populated_world.py"
SCORER_PATH = Path(__file__).with_name("score_neighborhood_frequency.py")
DEFAULT_MODEL = MODEL_DIR / "scene_placer_final.pt"
DEFAULT_PARAMS_JSON = REFERENCE_DIR / "frequency_search_best_candidate_20260331.json"
LEGACY_VOCAB_PATH = REFERENCE_DIR / "placement_vocab.json"
COMPONENT_VOCAB_PATH = REFERENCE_DIR / "component_linked_vocab.json"
COMPONENT_TENSOR_PATH = REFERENCE_DIR / "component_linked_tensors.npz"
MAX_BENCHMARK_OBJECTS = 120

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


def load_train_scene_placer_module():
    train_path = ROOT / "scripts" / "PopulationPipeline" / "OutdoorML" / "train_scene_placer.py"
    spec = importlib.util.spec_from_file_location("train_scene_placer", train_path)
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


def load_state_dict(model_path: Path, device: torch.device) -> dict:
    if model_path.suffix == ".safetensors":
        from safetensors.torch import load_file
        return load_file(str(model_path), device=str(device))

    state = torch.load(model_path, map_location=device)
    if not isinstance(state, dict):
        raise ValueError(f"Unsupported checkpoint format: {model_path}")
    if "ema_state_dict" in state:
        return state["ema_state_dict"]
    if "model_state_dict" in state:
        return state["model_state_dict"]
    return state


def infer_model_layout(state_dict: dict) -> dict:
    context_weight = state_dict["ctx_proj.proj.0.weight"]
    cont_weight = state_dict["obj_embed.continuous_proj.weight"]
    vocab_bias = state_dict["wcid_head.bias"]
    causal_mask = state_dict["causal_mask"]
    return {
        "context_dim": int(context_weight.shape[1]),
        "obj_dim": int(cont_weight.shape[1] + 1),
        "vocab_size": int(vocab_bias.shape[0]),
        "max_seq_len": int(causal_mask.shape[0] - 1),
    }


def detect_schema(layout: dict) -> str:
    if layout["obj_dim"] > 10 or layout["vocab_size"] > 15000:
        return "component_linked"
    return "legacy"


def load_vocab_for_schema(schema: str) -> tuple[Path, dict]:
    vocab_path = COMPONENT_VOCAB_PATH if schema == "component_linked" else LEGACY_VOCAB_PATH
    return vocab_path, json.loads(vocab_path.read_text())


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


def apply_sampling_filters(logits: torch.Tensor, temperature: float, top_k: int, nucleus_p: float) -> torch.Tensor:
    if temperature <= 0:
        raise ValueError("temperature must be > 0")

    filtered = logits.clone() / temperature
    if 0 < top_k < filtered.numel():
        top_k_logits, top_k_indices = torch.topk(filtered, top_k)
        filtered = torch.full_like(filtered, float("-inf"))
        filtered.scatter_(0, top_k_indices, top_k_logits)

    if nucleus_p < 1.0:
        sorted_logits, sorted_indices = torch.sort(filtered, descending=True)
        cumulative_probs = torch.cumsum(torch.softmax(sorted_logits, dim=-1), dim=-1)
        sorted_indices_to_remove = cumulative_probs > nucleus_p
        sorted_indices_to_remove[1:] = sorted_indices_to_remove[:-1].clone()
        sorted_indices_to_remove[0] = False
        filtered[sorted_indices[sorted_indices_to_remove]] = float("-inf")
    return filtered


def _component_contexts_for_benchmark(tensor_doc: np.lib.npyio.NpzFile, benchmark: dict) -> dict[str, np.ndarray]:
    contexts = tensor_doc["contexts"]
    lb_coords = tensor_doc["lb_coords"]
    selected: dict[str, np.ndarray] = {}
    x_min = benchmark["lb_x_min"]
    x_max = benchmark["lb_x_max"]
    y_min = benchmark["lb_y_min"]
    y_max = benchmark["lb_y_max"]

    for idx, (lb_x, lb_y) in enumerate(lb_coords):
        lb_x = int(lb_x)
        lb_y = int(lb_y)
        if not (x_min <= lb_x <= x_max and y_min <= lb_y <= y_max):
            continue
        lbid = f"0x{((lb_x & 0xFF) << 8 | (lb_y & 0xFF)):04X}"
        if lbid not in selected:
            selected[lbid] = contexts[idx].astype(np.float32, copy=True)
    return selected


def benchmark_component_linked_model(
    args: argparse.Namespace,
    outdir: Path,
    params: dict,
    scorer,
    state_dict: dict,
    layout: dict,
    vocab_path: Path,
    vocab: dict,
) -> dict:
    train_module = load_train_scene_placer_module()
    ScenePlacerTransformer = train_module.ScenePlacerTransformer
    DEFAULT_CONFIG = train_module.DEFAULT_CONFIG

    config = dict(DEFAULT_CONFIG)
    config["context_dim"] = layout["context_dim"]
    config["obj_dim"] = layout["obj_dim"]
    config["max_seq_len"] = layout["max_seq_len"]
    config["vocab_path"] = str(vocab_path)
    model = ScenePlacerTransformer(config).to(args.device)
    missing, unexpected = model.load_state_dict(state_dict, strict=False)
    real_missing = [key for key in missing if key not in {"causal_mask", "pos_encoding.pe"}]
    if real_missing or unexpected:
        raise RuntimeError(f"Component-linked checkpoint mismatch: missing={real_missing}, unexpected={list(unexpected)}")
    model.eval()

    tensor_doc = np.load(COMPONENT_TENSOR_PATH)
    weights_doc = scorer.load_json(ROOT / "pipeline_data/reference/dereth_frequency_weights.json")
    reference_doc = scorer.load_json(ROOT / "pipeline_data/reference/dereth_landblock_reference_counts.json")
    similarity_doc = scorer.load_json(ROOT / "pipeline_data/reference/dereth_wcid_similarity.json")
    reference_landblocks = scorer.build_reference_landblocks(reference_doc)
    idx_to_class_key = {int(k): tuple(v) for k, v in vocab["idx_to_class_key"].items()}
    class_space_codes = {str(k): int(v) for k, v in vocab.get("class_space_codes", {}).items()}
    max_steps = min(layout["max_seq_len"], MAX_BENCHMARK_OBJECTS)

    benchmark_rows = []
    total_generation_sec = 0.0
    torch.manual_seed(args.seed)
    random.seed(args.seed)
    np.random.seed(args.seed)

    for benchmark in DEFAULT_BENCHMARKS:
        generated_counts_path = outdir / f"{benchmark['name']}_generated_counts.json"
        summary_path = outdir / f"{benchmark['name']}_summary.json"
        contexts_by_lb = _component_contexts_for_benchmark(tensor_doc, benchmark)
        generated_by_lb: dict[str, Counter[int]] = {}
        debug_rows = []
        started = time.perf_counter()

        for lbid, context in sorted(contexts_by_lb.items()):
            ctx = torch.from_numpy(context).float().unsqueeze(0).to(args.device)
            seq = torch.zeros(1, max_steps + 1, layout["obj_dim"], dtype=torch.float32, device=args.device)
            seq_mask = torch.zeros(1, max_steps + 1, dtype=torch.bool, device=args.device)
            seq_mask[:, 0] = True
            seq_len = 1
            token_freq = Counter()
            wcid_counter: Counter[int] = Counter()
            sampled_pad = 0
            sampled_stop = 0
            sampled_model_id = 0
            terminated_by_stop = False
            min_objects = int(params["min_objects"])

            for _step in range(max_steps):
                wcid_logits, pos_pred, rot_pred, link_pred = model(ctx, seq[:, :seq_len, :], mask=seq_mask[:, :seq_len])
                logits = wcid_logits[0, seq_len - 1, :].clone()
                pos = pos_pred[0, seq_len - 1, :]
                rot = rot_pred[0, seq_len - 1, :]
                link = torch.sigmoid(link_pred[0, seq_len - 1, 0]).item()

                for token_idx, count in token_freq.items():
                    if token_idx < logits.numel():
                        logits[token_idx] -= float(params["frequency_penalty"]) * math.log(count + 1.0)
                logits[0] -= float(params["pad_logit_bias"])
                if sum(wcid_counter.values()) < min_objects:
                    logits[1] = float("-inf")
                else:
                    logits[1] -= float(params["stop_logit_bias"])

                probs = torch.softmax(
                    apply_sampling_filters(
                        logits,
                        temperature=float(params["temperature"]),
                        top_k=int(params["top_k"]),
                        nucleus_p=float(params["nucleus_p"]),
                    ),
                    dim=-1,
                )
                token_idx = int(torch.multinomial(probs, 1).item())

                if token_idx == 1:
                    sampled_stop += 1
                    if sum(wcid_counter.values()) >= min_objects:
                        terminated_by_stop = True
                        break
                    continue
                if token_idx == 0:
                    sampled_pad += 1
                    continue

                class_space, class_id = idx_to_class_key.get(token_idx, ("special", -1))
                if class_space == "wcid":
                    wcid_counter[int(class_id)] += 1
                else:
                    sampled_model_id += 1

                seq[0, seq_len, :] = 0.0
                seq[0, seq_len, 0] = float(token_idx)
                seq[0, seq_len, 1] = float(class_space_codes.get(class_space, 0))
                if layout["obj_dim"] > 2:
                    seq[0, seq_len, 2] = float(pos[0].clamp(0.0, 1.0).item())
                if layout["obj_dim"] > 3:
                    seq[0, seq_len, 3] = float(pos[1].clamp(0.0, 1.0).item())
                if layout["obj_dim"] > 5:
                    seq[0, seq_len, 5] = float(rot[0].item())
                if layout["obj_dim"] > 6:
                    seq[0, seq_len, 6] = float(rot[1].item())
                if layout["obj_dim"] > 14:
                    seq[0, seq_len, 14] = float(link)
                seq_mask[0, seq_len] = True
                seq_len += 1
                token_freq[token_idx] += 1

            if wcid_counter:
                generated_by_lb[lbid] = wcid_counter
            debug_rows.append(
                {
                    "landblock": lbid,
                    "generated_rows": int(sum(wcid_counter.values())),
                    "generated_unique_wcids": len(wcid_counter),
                    "sampled_model_id_tokens": sampled_model_id,
                    "sampled_pad": sampled_pad,
                    "sampled_stop": sampled_stop,
                    "terminated_by_stop": terminated_by_stop,
                }
            )

        generation_time_sec = time.perf_counter() - started
        total_generation_sec += generation_time_sec
        score_summary = scorer.evaluate_neighborhoods(
            generated=generated_by_lb,
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
        generated_rows = sum(sum(counter.values()) for counter in generated_by_lb.values())
        generated_landblocks = len(generated_by_lb)
        counts_payload = {lbid: dict(sorted(counter.items())) for lbid, counter in sorted(generated_by_lb.items())}
        write_json(generated_counts_path, counts_payload)
        write_json(
            summary_path,
            {
                "schema": "component_linked",
                "model": str(args.model),
                "generation_time_sec": generation_time_sec,
                "conditioned_landblocks": len(contexts_by_lb),
                "generated_landblocks": generated_landblocks,
                "generated_rows": generated_rows,
                "debug": debug_rows,
            },
        )
        benchmark_rows.append(
            {
                "name": benchmark["name"],
                "sql_path": None,
                "generated_counts_path": str(generated_counts_path),
                "summary_path": str(summary_path),
                "generation_time_sec": generation_time_sec,
                "generated_rows": generated_rows,
                "generated_landblocks": generated_landblocks,
                "score_per_row": score_summary["total_score"] / generated_rows if generated_rows else 0.0,
                "score_per_landblock": score_summary["total_score"] / score_summary["evaluated_landblocks"] if score_summary["evaluated_landblocks"] else 0.0,
                "over_penalty_per_row": score_summary["overgeneration_penalty"] / generated_rows if generated_rows else 0.0,
                "mix_reward_per_landblock": score_summary["mix_matched_reward"] / score_summary["evaluated_landblocks"] if score_summary["evaluated_landblocks"] else 0.0,
                "raw": score_summary,
            }
        )

    return {
        "finished_at": utc_now_stamp(),
        "schema": "component_linked",
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


def main() -> None:
    args = parse_args()
    args.device = torch.device("cuda" if args.require_cuda and torch.cuda.is_available() else "cpu")
    if args.require_cuda and args.device.type != "cuda":
        raise SystemExit("CUDA was requested with --require-cuda, but torch.cuda.is_available() is false.")
    outdir = ensure_outdir(args)
    params = load_params(args.params_json)
    scorer = load_scorer_module()
    state_dict = load_state_dict(args.model, args.device)
    layout = infer_model_layout(state_dict)
    schema = detect_schema(layout)
    vocab_path, vocab = load_vocab_for_schema(schema)

    weights_doc = scorer.load_json(ROOT / "pipeline_data/reference/dereth_frequency_weights.json")
    reference_doc = scorer.load_json(ROOT / "pipeline_data/reference/dereth_landblock_reference_counts.json")
    similarity_doc = scorer.load_json(ROOT / "pipeline_data/reference/dereth_wcid_similarity.json")
    reference_landblocks = scorer.build_reference_landblocks(reference_doc)

    manifest = {
        "started_at": utc_now_stamp(),
        "model": str(args.model),
        "schema": schema,
        "layout": layout,
        "vocab_path": str(vocab_path),
        "params_json": str(args.params_json),
        "params": params,
        "seed": args.seed,
        "benchmarks": DEFAULT_BENCHMARKS,
    }
    write_json(outdir / "manifest.json", manifest)

    if schema == "component_linked":
        result = benchmark_component_linked_model(
            args=args,
            outdir=outdir,
            params=params,
            scorer=scorer,
            state_dict=state_dict,
            layout=layout,
            vocab_path=vocab_path,
            vocab=vocab,
        )
        write_json(outdir / "result.json", result)
        print(json.dumps(result, indent=2))
        return

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

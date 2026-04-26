#!/usr/bin/env python3
"""
Fast side-by-side comparator for component-linked OutdoorML checkpoints.

This intentionally samples only a small, fixed set of landblocks so we can get
checkpoint-to-checkpoint behavioral signal quickly without waiting for the full
benchmark sweep.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import random
import time
from collections import Counter
from pathlib import Path

import numpy as np
import torch


ROOT = Path(__file__).resolve().parents[3]
REFERENCE_DIR = ROOT / "pipeline_data" / "reference"
DEFAULT_PARAMS_JSON = REFERENCE_DIR / "frequency_search_best_candidate_20260331.json"
DEFAULT_OUTPUT_DIR = ROOT / "pipeline_data" / "search_runs"
BENCHMARK_PATH = Path(__file__).with_name("run_model_benchmark.py")
SCORER_PATH = Path(__file__).with_name("score_neighborhood_frequency.py")


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fast compare component-linked checkpoints")
    parser.add_argument("--model", type=Path, action="append", required=True,
                        help="Checkpoint path. Pass exactly two or more --model arguments.")
    parser.add_argument("--params-json", type=Path, default=DEFAULT_PARAMS_JSON)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--max-steps", type=int, default=32,
                        help="Hard generation cap per landblock.")
    parser.add_argument("--max-landblocks", type=int, default=4,
                        help="Maximum number of landblocks to test per region.")
    parser.add_argument("--require-cuda", action="store_true", default=True)
    parser.add_argument("--no-require-cuda", action="store_false", dest="require_cuda")
    parser.add_argument("--outdir", type=Path, default=None)
    return parser.parse_args()


def make_landblock_id(x: int, y: int) -> str:
    return f"0x{((x & 0xFF) << 8 | (y & 0xFF)):04X}"


def fixed_regions() -> list[dict]:
    return [
        {
            "name": "probe_2x2",
            "lb_x_min": 30,
            "lb_x_max": 31,
            "lb_y_min": 120,
            "lb_y_max": 121,
        },
        {
            "name": "region_4x4",
            "lb_x_min": 30,
            "lb_x_max": 33,
            "lb_y_min": 120,
            "lb_y_max": 123,
        },
    ]


def select_landblocks(contexts_by_lb: dict[str, np.ndarray], limit: int) -> dict[str, np.ndarray]:
    items = sorted(contexts_by_lb.items())
    return dict(items[:limit])


@torch.inference_mode()
def generate_counts_for_contexts(model, contexts_by_lb, layout, idx_to_class_key,
                                 class_space_codes, params, max_steps, bench_module,
                                 device: torch.device) -> tuple[dict[str, Counter[int]], list[dict]]:
    generated_by_lb: dict[str, Counter[int]] = {}
    debug_rows: list[dict] = []

    for lbid, context in sorted(contexts_by_lb.items()):
        ctx = torch.from_numpy(context).float().unsqueeze(0).to(device)
        seq = torch.zeros(1, max_steps + 1, layout["obj_dim"], dtype=torch.float32, device=device)
        seq_mask = torch.zeros(1, max_steps + 1, dtype=torch.bool, device=device)
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
                bench_module.apply_sampling_filters(
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

    return generated_by_lb, debug_rows


def summarize_region(region: dict, generated_by_lb: dict[str, Counter[int]], debug_rows: list[dict],
                     score_summary: dict, elapsed_sec: float) -> dict:
    generated_rows = sum(sum(counter.values()) for counter in generated_by_lb.values())
    generated_landblocks = len(generated_by_lb)
    return {
        "name": region["name"],
        "tested_landblocks": [row["landblock"] for row in debug_rows],
        "generation_time_sec": round(elapsed_sec, 3),
        "generated_landblocks": generated_landblocks,
        "generated_rows": generated_rows,
        "avg_rows_per_generated_lb": round(generated_rows / generated_landblocks, 3) if generated_landblocks else 0.0,
        "avg_unique_wcids_per_lb": round(sum(r["generated_unique_wcids"] for r in debug_rows) / len(debug_rows), 3) if debug_rows else 0.0,
        "avg_pad_samples": round(sum(r["sampled_pad"] for r in debug_rows) / len(debug_rows), 3) if debug_rows else 0.0,
        "avg_stop_samples": round(sum(r["sampled_stop"] for r in debug_rows) / len(debug_rows), 3) if debug_rows else 0.0,
        "avg_model_id_tokens": round(sum(r["sampled_model_id_tokens"] for r in debug_rows) / len(debug_rows), 3) if debug_rows else 0.0,
        "stop_terminated_lbs": sum(1 for r in debug_rows if r["terminated_by_stop"]),
        "score_total": round(score_summary["total_score"], 6),
        "score_per_row": round(score_summary["total_score"] / generated_rows, 6) if generated_rows else 0.0,
        "score_per_landblock": round(score_summary["total_score"] / score_summary["evaluated_landblocks"], 6)
        if score_summary["evaluated_landblocks"] else 0.0,
        "over_penalty_per_row": round(score_summary["overgeneration_penalty"] / generated_rows, 6) if generated_rows else 0.0,
        "mix_reward_per_landblock": round(score_summary["mix_matched_reward"] / score_summary["evaluated_landblocks"], 6)
        if score_summary["evaluated_landblocks"] else 0.0,
    }


def main() -> None:
    args = parse_args()
    if len(args.model) < 2:
        raise SystemExit("Pass at least two --model arguments.")

    bench_module = load_module(BENCHMARK_PATH, "run_model_benchmark_fast_compare")
    scorer = load_module(SCORER_PATH, "score_neighborhood_frequency_fast_compare")
    train_module = bench_module.load_train_scene_placer_module()
    ScenePlacerTransformer = train_module.ScenePlacerTransformer
    default_config = train_module.DEFAULT_CONFIG

    device = torch.device("cuda" if args.require_cuda and torch.cuda.is_available() else "cpu")
    if args.require_cuda and device.type != "cuda":
        raise SystemExit("CUDA was requested with --require-cuda, but torch.cuda.is_available() is false.")

    params = bench_module.load_params(args.params_json)
    weights_doc = scorer.load_json(ROOT / "pipeline_data/reference/dereth_frequency_weights.json")
    reference_doc = scorer.load_json(ROOT / "pipeline_data/reference/dereth_landblock_reference_counts.json")
    similarity_doc = scorer.load_json(ROOT / "pipeline_data/reference/dereth_wcid_similarity.json")
    reference_landblocks = scorer.build_reference_landblocks(reference_doc)
    tensor_doc = np.load(bench_module.COMPONENT_TENSOR_PATH)

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)

    regions = fixed_regions()
    comparison = {
        "seed": args.seed,
        "max_steps": args.max_steps,
        "max_landblocks": args.max_landblocks,
        "params_json": str(args.params_json),
        "params": params,
        "device": device.type,
        "regions": regions,
        "models": [],
    }

    for model_path in args.model:
        state_dict = bench_module.load_state_dict(model_path, device)
        layout = bench_module.infer_model_layout(state_dict)
        schema = bench_module.detect_schema(layout)
        if schema != "component_linked":
            raise SystemExit(f"{model_path} is schema={schema}, expected component_linked")
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
                f"Checkpoint mismatch for {model_path}: missing={real_missing}, unexpected={list(unexpected)}"
            )
        model.eval()

        idx_to_class_key = {int(k): tuple(v) for k, v in vocab["idx_to_class_key"].items()}
        class_space_codes = {str(k): int(v) for k, v in vocab.get("class_space_codes", {}).items()}

        model_result = {
            "model": str(model_path),
            "layout": layout,
            "regions": [],
        }

        for region in regions:
            region_contexts = bench_module._component_contexts_for_benchmark(tensor_doc, region)
            selected_contexts = select_landblocks(region_contexts, args.max_landblocks)

            started = time.perf_counter()
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
            elapsed_sec = time.perf_counter() - started

            expected_landblocks = list(selected_contexts.keys())
            score_summary = scorer.evaluate_neighborhoods(
                generated=generated_by_lb,
                reference_landblocks=reference_landblocks,
                weights=weights_doc["weights"],
                similarity_doc=similarity_doc,
                radius=1,
                neighborhood_cap=8,
                similarity_credit_ratio=0.3,
                similarity_penalty_ratio=0.55,
                expected_landblocks=expected_landblocks,
            )

            model_result["regions"].append(
                summarize_region(region, generated_by_lb, debug_rows, score_summary, elapsed_sec)
            )

        comparison["models"].append(model_result)

    if args.outdir:
        args.outdir.mkdir(parents=True, exist_ok=True)
        output_path = args.outdir / "fast_component_linked_compare.json"
        with output_path.open("w", encoding="utf-8") as f:
            json.dump(comparison, f, indent=2)
        print(f"Wrote {output_path}")

    print(json.dumps(comparison, indent=2))


if __name__ == "__main__":
    main()

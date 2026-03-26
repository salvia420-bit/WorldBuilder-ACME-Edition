#!/usr/bin/env python3
"""
Inspect first-token OutdoorML inference behavior on the fixed small probe region.

This is intended for the current PAD/STOP-collapse investigation. It reports
probability mass on the very first generated token for:
  - PAD
  - STOP
  - housing special tokens
  - real vocab tokens

It can load either:
  - inference weights such as scene_placer_best.pt
  - full training checkpoints such as resume.pt, using EMA or raw model weights

Defaults match the March 26, 2026 validated small-probe baseline so first-token
inspection stays aligned with the current non-collapsed inference path.
"""

import argparse
import json
import os
import sys
from collections import Counter

import numpy as np

try:
    import torch
except ImportError:
    print("ERROR: PyTorch not found.")
    sys.exit(1)


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(SCRIPT_DIR)))
MODEL_DIR = os.path.join(BASE_DIR, "pipeline_data", "models")
VOCAB_PATH = os.path.join(BASE_DIR, "pipeline_data", "reference", "placement_vocab.json")
HEIGHTS_PATH = os.path.join(BASE_DIR, "pipeline_data", "population_output", "vanquish_heights.json")
DIFFICULTY_GRADIENT = os.path.join(BASE_DIR, "pipeline_data", "enrichment", "difficulty_gradient.json")

sys.path.insert(0, SCRIPT_DIR)

from train_scene_placer import ScenePlacerTransformer, DEFAULT_CONFIG
from generate_populated_world import (
    PlacementGenerator,
    load_inference_state_dict,
    load_model_for_inference,
    load_ocean_mask,
)
from extract_placement_tensors import (
    build_context_vector,
    build_cultural_zones,
    load_difficulty_grid,
    load_height_grid,
    load_wcid_types,
)


def average(values):
    return float(sum(values) / max(len(values), 1))


def main() -> int:
    parser = argparse.ArgumentParser(description="Inspect OutdoorML first-token logits")
    parser.add_argument("--model", required=True,
                        help="Model file under pipeline_data/models/")
    parser.add_argument("--checkpoint-source", choices=("auto", "ema", "model"),
                        default="auto",
                        help="How to interpret .pt training checkpoints")
    parser.add_argument("--lb-x-min", type=int, default=30)
    parser.add_argument("--lb-x-max", type=int, default=34)
    parser.add_argument("--lb-y-min", type=int, default=120)
    parser.add_argument("--lb-y-max", type=int, default=124)
    parser.add_argument("--temperature", type=float, default=1.0)
    parser.add_argument("--top-k", type=int, default=0)
    parser.add_argument("--nucleus-p", type=float, default=1.0)
    parser.add_argument("--min-objects", type=int, default=5)
    parser.add_argument("--adaptive-min-objects-bonus", type=int, default=2)
    parser.add_argument("--pad-logit-bias", type=float, default=1.0)
    parser.add_argument("--stop-logit-bias", type=float, default=0.5)
    parser.add_argument("--housing-logit-bias", type=float, default=0.0)
    parser.add_argument("--housing-flatness-threshold", type=float, default=0.6)
    parser.add_argument("--housing-difficulty-ceiling", type=float, default=0.6)
    parser.add_argument("--housing-min-placements", type=int, default=2)
    parser.add_argument("--max-housing-per-lb", type=int, default=1)
    parser.add_argument("--top-tokens", type=int, default=8,
                        help="How many top tokens to print per landblock summary")
    parser.add_argument("--json-out", type=str, default=None,
                        help="Optional JSON output path")
    parser.add_argument("--require-cuda", action="store_true",
                        help="Fail fast if CUDA is unavailable instead of silently running on CPU")
    args = parser.parse_args()

    model_path = os.path.join(MODEL_DIR, args.model)
    if not os.path.exists(model_path):
        print(f"ERROR: Model not found: {model_path}")
        return 1

    with open(VOCAB_PATH, "r", encoding="utf-8") as f:
        vocab = json.load(f)

    config = DEFAULT_CONFIG.copy()
    cuda_available = torch.cuda.is_available()
    if args.require_cuda and not cuda_available:
        print("ERROR: CUDA was requested with --require-cuda, but torch.cuda.is_available() is false.")
        print("Refusing CPU fallback because first-token diagnostics can diverge from CUDA behavior.")
        return 1

    device = torch.device("cuda" if cuda_available else "cpu")
    if device.type != "cuda":
        print("WARNING: running first-token diagnostics on CPU fallback.")
        print("OutdoorML inference diagnostics are not guaranteed to match CUDA results.")
    model = ScenePlacerTransformer(config).to(device)
    state_dict, state_source = load_inference_state_dict(
        model_path, device, checkpoint_source=args.checkpoint_source
    )
    load_model_for_inference(model, state_dict, model_path)
    model.eval()

    heights = load_height_grid(HEIGHTS_PATH)
    difficulty_grid = load_difficulty_grid(DIFFICULTY_GRADIENT)
    culture_grid = build_cultural_zones()
    ocean_mask = load_ocean_mask(difficulty_grid) if difficulty_grid is not None else None
    wcid_types = load_wcid_types()

    generator = PlacementGenerator(
        model,
        vocab,
        device,
        temperature=args.temperature,
        top_k=args.top_k,
        nucleus_p=args.nucleus_p,
        min_objects=args.min_objects,
        wcid_types=wcid_types,
        pad_logit_bias=args.pad_logit_bias,
        stop_logit_bias=args.stop_logit_bias,
        adaptive_min_objects_bonus=args.adaptive_min_objects_bonus,
        housing_logit_bias=args.housing_logit_bias,
        housing_flatness_threshold=args.housing_flatness_threshold,
        housing_difficulty_ceiling=args.housing_difficulty_ceiling,
        housing_min_placements=args.housing_min_placements,
        max_housing_per_lb=args.max_housing_per_lb,
    )

    region_results = []
    argmax_counts = Counter()
    filtered_argmax_counts = Counter()

    for lb_x in range(args.lb_x_min, args.lb_x_max + 1):
        for lb_y in range(args.lb_y_min, args.lb_y_max + 1):
            if ocean_mask is not None and ocean_mask[lb_y, lb_x]:
                continue

            context = build_context_vector(
                lb_x, lb_y, heights, difficulty_grid, culture_grid, {}
            )
            first_step = generator.inspect_first_step(context, summary_top_k=args.top_tokens)
            raw_top = first_step["raw"]["top_tokens"][0] if first_step["raw"]["top_tokens"] else None
            filtered_top = first_step["filtered"]["top_tokens"][0] if first_step["filtered"]["top_tokens"] else None
            if raw_top:
                argmax_counts[(raw_top["kind"], raw_top["idx"], raw_top["wcid"])] += 1
            if filtered_top:
                filtered_argmax_counts[(filtered_top["kind"], filtered_top["idx"], filtered_top["wcid"])] += 1

            region_results.append({
                "lb_x": lb_x,
                "lb_y": lb_y,
                **first_step,
            })

    if not region_results:
        print("No non-ocean landblocks were found in the requested region.")
        return 1

    raw_pad = [r["raw"]["pad_mass"] for r in region_results]
    raw_stop = [r["raw"]["stop_mass"] for r in region_results]
    raw_housing = [r["raw"]["housing_mass"] for r in region_results]
    raw_real = [r["raw"]["real_mass"] for r in region_results]

    filtered_pad = [r["filtered"]["pad_mass"] for r in region_results]
    filtered_stop = [r["filtered"]["stop_mass"] for r in region_results]
    filtered_housing = [r["filtered"]["housing_mass"] for r in region_results]
    filtered_real = [r["filtered"]["real_mass"] for r in region_results]

    summary = {
        "model": args.model,
        "checkpoint_source": state_source,
        "region": {
            "lb_x_min": args.lb_x_min,
            "lb_x_max": args.lb_x_max,
            "lb_y_min": args.lb_y_min,
            "lb_y_max": args.lb_y_max,
        },
        "landblocks_analyzed": len(region_results),
        "sampling": {
            "temperature": args.temperature,
            "top_k": args.top_k,
            "nucleus_p": args.nucleus_p,
            "min_objects": args.min_objects,
            "adaptive_min_objects_bonus": args.adaptive_min_objects_bonus,
            "pad_logit_bias": args.pad_logit_bias,
            "stop_logit_bias": args.stop_logit_bias,
            "housing_logit_bias": args.housing_logit_bias,
            "housing_flatness_threshold": args.housing_flatness_threshold,
            "housing_difficulty_ceiling": args.housing_difficulty_ceiling,
            "housing_min_placements": args.housing_min_placements,
            "max_housing_per_lb": args.max_housing_per_lb,
        },
        "raw_avg": {
            "pad_mass": average(raw_pad),
            "stop_mass": average(raw_stop),
            "housing_mass": average(raw_housing),
            "real_mass": average(raw_real),
        },
        "filtered_avg": {
            "pad_mass": average(filtered_pad),
            "stop_mass": average(filtered_stop),
            "housing_mass": average(filtered_housing),
            "real_mass": average(filtered_real),
        },
        "raw_argmax_counts": [
            {"kind": kind, "idx": idx, "wcid": wcid, "count": count}
            for (kind, idx, wcid), count in argmax_counts.most_common(10)
        ],
        "filtered_argmax_counts": [
            {"kind": kind, "idx": idx, "wcid": wcid, "count": count}
            for (kind, idx, wcid), count in filtered_argmax_counts.most_common(10)
        ],
        "per_landblock": region_results,
    }

    print("=" * 72)
    print("  OutdoorML First-Token Debug")
    print("=" * 72)
    print(f"  Model:             {args.model}")
    print(f"  Weight source:     {state_source}")
    print(f"  Landblocks:        {len(region_results)}")
    print(f"  Region:            x={args.lb_x_min}..{args.lb_x_max}, y={args.lb_y_min}..{args.lb_y_max}")
    print()
    print("Average first-step probability mass:")
    print(f"  Raw      PAD={summary['raw_avg']['pad_mass']:.4f} STOP={summary['raw_avg']['stop_mass']:.4f} "
          f"HOUSING={summary['raw_avg']['housing_mass']:.4f} REAL={summary['raw_avg']['real_mass']:.4f}")
    print(f"  Filtered PAD={summary['filtered_avg']['pad_mass']:.4f} STOP={summary['filtered_avg']['stop_mass']:.4f} "
          f"HOUSING={summary['filtered_avg']['housing_mass']:.4f} REAL={summary['filtered_avg']['real_mass']:.4f}")
    print()
    print("Most common raw argmax tokens:")
    for item in summary["raw_argmax_counts"]:
        print(f"  {item['kind']:<16} idx={item['idx']:<5} wcid={item['wcid']:<7} count={item['count']}")
    print()
    print("Most common filtered argmax tokens:")
    for item in summary["filtered_argmax_counts"]:
        print(f"  {item['kind']:<16} idx={item['idx']:<5} wcid={item['wcid']:<7} count={item['count']}")
    print()
    print("Per-landblock top raw tokens:")
    for item in region_results:
        top_tokens = item["raw"]["top_tokens"][:args.top_tokens]
        token_str = ", ".join(
            f"{tok['kind']}[{tok['idx']}/{tok['wcid']}]={tok['prob']:.3f}"
            for tok in top_tokens
        )
        print(f"  LB ({item['lb_x']},{item['lb_y']}): {token_str}")

    if args.json_out:
        out_dir = os.path.dirname(os.path.abspath(args.json_out))
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
        with open(args.json_out, "w", encoding="utf-8") as f:
            json.dump(summary, f, indent=2)
        print()
        print(f"JSON written to {args.json_out}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""
Run the known small-region OutdoorML inference probe and emit easy-to-read output.

This wraps generate_populated_world.py with the fixed 5x5 region described in
the handoff docs so we can quickly test whether a checkpoint has moved beyond
PAD/STOP collapse. By default it requires CUDA because CPU fallback has produced
materially different density results on the same checkpoint.
"""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(SCRIPT_DIR)))
GENERATOR = os.path.join(SCRIPT_DIR, "generate_populated_world.py")
DEFAULT_OUT_DIR = os.path.join(BASE_DIR, "pipeline_data", "population_output", "probes")


def build_default_stem(model_name: str) -> str:
    stamp = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    safe_model = os.path.splitext(os.path.basename(model_name))[0]
    return f"probe_{safe_model}_{stamp}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the fixed 5x5 OutdoorML probe")
    parser.add_argument("--model", required=True,
                        help="Model weights file name in pipeline_data/models/")
    parser.add_argument("--out-dir", default=DEFAULT_OUT_DIR,
                        help="Directory for probe SQL, JSON, and console log")
    parser.add_argument("--temperature", type=float, default=1.0)
    parser.add_argument("--top-k", type=int, default=0)
    parser.add_argument("--nucleus-p", type=float, default=1.0)
    parser.add_argument("--frequency-penalty", type=float, default=0.3)
    parser.add_argument("--min-objects", type=int, default=5)
    parser.add_argument("--adaptive-min-objects-bonus", type=int, default=2)
    parser.add_argument("--pad-logit-bias", type=float, default=1.0)
    parser.add_argument("--stop-logit-bias", type=float, default=0.5)
    parser.add_argument("--housing-logit-bias", type=float, default=0.0)
    parser.add_argument("--housing-flatness-threshold", type=float, default=0.6)
    parser.add_argument("--housing-difficulty-ceiling", type=float, default=0.6)
    parser.add_argument("--housing-min-placements", type=int, default=2)
    parser.add_argument("--max-housing-per-lb", type=int, default=1)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--allow-cpu", action="store_true",
                        help="Permit CPU fallback; by default the probe requires CUDA")
    args = parser.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    stem = build_default_stem(args.model)
    sql_path = os.path.join(args.out_dir, f"{stem}.sql")
    summary_path = os.path.join(args.out_dir, f"{stem}.json")
    log_path = os.path.join(args.out_dir, f"{stem}.log")

    cmd = [
        sys.executable,
        GENERATOR,
        "--model", args.model,
        "--lb-x-min", "30",
        "--lb-x-max", "34",
        "--lb-y-min", "120",
        "--lb-y-max", "124",
        "--progress-every", "5",
        "--debug-landblocks", "25",
        "--temperature", str(args.temperature),
        "--top-k", str(args.top_k),
        "--nucleus-p", str(args.nucleus_p),
        "--frequency-penalty", str(args.frequency_penalty),
        "--min-objects", str(args.min_objects),
        "--adaptive-min-objects-bonus", str(args.adaptive_min_objects_bonus),
        "--pad-logit-bias", str(args.pad_logit_bias),
        "--stop-logit-bias", str(args.stop_logit_bias),
        "--housing-logit-bias", str(args.housing_logit_bias),
        "--housing-flatness-threshold", str(args.housing_flatness_threshold),
        "--housing-difficulty-ceiling", str(args.housing_difficulty_ceiling),
        "--housing-min-placements", str(args.housing_min_placements),
        "--max-housing-per-lb", str(args.max_housing_per_lb),
        "--seed", str(args.seed),
        "--output-sql", sql_path,
        "--summary-json", summary_path,
    ]
    if not args.allow_cpu:
        cmd.append("--require-cuda")

    print("=" * 72)
    print("  OutdoorML Small-Region Probe")
    print("=" * 72)
    print(f"  Model:       {args.model}")
    print("  Region:      lb_x=30..34, lb_y=120..124")
    print(f"  SQL out:     {sql_path}")
    print(f"  Summary out: {summary_path}")
    print(f"  Log out:     {log_path}")
    print()

    with open(log_path, "w", encoding="utf-8") as log_file:
        proc = subprocess.run(cmd, stdout=log_file, stderr=subprocess.STDOUT, text=True)

    with open(log_path, "r", encoding="utf-8") as log_file:
        sys.stdout.write(log_file.read())

    if proc.returncode != 0:
        print(f"\nProbe failed with exit code {proc.returncode}.")
        return proc.returncode

    if not os.path.exists(summary_path):
        print("\nProbe completed, but no summary JSON was produced.")
        return 1

    with open(summary_path, "r", encoding="utf-8") as f:
        summary = json.load(f)

    results = summary.get("results", {})
    print()
    print("Probe verdict:")
    print(f"  Raw generated: {results.get('raw_generated', 0)}")
    print(f"  Accepted:      {results.get('accepted_after_validation', 0)}")
    print(f"  PAD samples:   {results.get('pad_samples', 0)}")
    print(f"  STOP samples:  {results.get('stop_samples', 0)}")
    print(f"  Regular toks:  {results.get('regular_samples', 0)}")
    print(f"  Housing toks:  {results.get('housing_samples', 0)}")

    if results.get('raw_generated', 0) > 0:
        print("  Status:        checkpoint is producing real placement tokens")
    else:
        print("  Status:        still collapsed at inference")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

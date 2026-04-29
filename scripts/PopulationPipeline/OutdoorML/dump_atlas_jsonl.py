#!/usr/bin/env python3
"""
dump_atlas_jsonl.py
====================

Drives WorldBuilder.Terminal in --stdin JSON mode against a loaded project,
issues describe-landblock for every unique LB present in a V4-style tensors
NPZ, strips the verbose verbal/relations/validation blocks, and appends one
JSON line per LB to an output JSONL.

Idempotent: --resume skips LBs already present in the output file.

Output line schema:
  {"lbX": 200, "lbY": 140, "context": {...}, "body_structures": [{...}, ...]}

The body_structures slice is limited to the top-3 structures by
attributedCellCount and includes only architecture/stories/roofShape/
materialTags/tags. Verbal text, relations, and validation diagnostics are
discarded — V6 ingests only the structured fields.
"""

import argparse
import json
import os
import select
import signal
import subprocess
import sys
import time
from typing import Iterable

import numpy as np


KEEP_CONTEXT_FIELDS = (
    "regionName",
    "townName",
    "culture",
    "biome",
    "biomeConfidence",
    "hasRoad",
    "settlementHint",
    "dominantArchitecture",
    "structureCount",
    "knownPoiCount",
    "gazetteerNotes",
    "knownPois",
    "dominantTerrainTypes",
)

KEEP_STRUCTURE_FIELDS = (
    "architecture",
    "stories",
    "roofShape",
    "materialTags",
    "tags",
    "attributedCellCount",
)


def slim(resp: dict) -> dict:
    ctx = resp.get("context") or {}
    slim_ctx = {k: ctx.get(k) for k in KEEP_CONTEXT_FIELDS if k in ctx}
    structs = (resp.get("body") or {}).get("structures") or []
    structs_sorted = sorted(
        structs,
        key=lambda s: (s.get("attributedCellCount") or 0),
        reverse=True,
    )[:3]
    slim_structs = []
    for s in structs_sorted:
        slim_structs.append({k: s.get(k) for k in KEEP_STRUCTURE_FIELDS if k in s})
    return {
        "lbX": resp.get("lbX"),
        "lbY": resp.get("lbY"),
        "context": slim_ctx,
        "body_structures": slim_structs,
    }


def unique_lbs(npz_path: str) -> np.ndarray:
    d = np.load(npz_path, allow_pickle=False)
    coords = d["lb_coords"]
    return np.unique(coords, axis=0)


def already_dumped(out_path: str) -> set[tuple[int, int]]:
    seen: set[tuple[int, int]] = set()
    if not os.path.exists(out_path):
        return seen
    with open(out_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
                seen.add((int(o["lbX"]), int(o["lbY"])))
            except Exception:
                continue
    return seen


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tensor-path", default=os.path.join(
        os.path.dirname(__file__), "..", "..", "..",
        "pipeline_data", "reference", "component_linked_unified_v4_tensors.npz"))
    ap.add_argument("--terminal", default=os.path.join(
        os.path.dirname(__file__), "..", "..", "..",
        "WorldBuilder.Terminal", "bin", "Debug", "net8.0", "WorldBuilder.Terminal"))
    ap.add_argument("--project", required=True,
                    help="Path to the .wbproj project file")
    ap.add_argument("--out", default=os.path.join(
        os.path.dirname(__file__), "..", "..", "..",
        "pipeline_data", "reference", "atlas_describe_v1.jsonl"))
    ap.add_argument("--resume", action="store_true",
                    help="Skip LBs already present in --out")
    ap.add_argument("--limit", type=int, default=0,
                    help="Stop after N LBs (0 = no limit; useful for calibration)")
    ap.add_argument("--progress-every", type=int, default=200)
    args = ap.parse_args()

    coords = unique_lbs(os.path.abspath(args.tensor_path))
    print(f"[dump_atlas] {len(coords)} unique LBs in {args.tensor_path}",
          file=sys.stderr)

    seen = already_dumped(args.out) if args.resume else set()
    if seen:
        print(f"[dump_atlas] resume: {len(seen)} already dumped",
              file=sys.stderr)
    todo = [(int(x), int(y)) for x, y in coords if (int(x), int(y)) not in seen]
    if args.limit:
        todo = todo[: args.limit]
    print(f"[dump_atlas] {len(todo)} LBs to dump", file=sys.stderr)

    if not todo:
        print("[dump_atlas] nothing to do", file=sys.stderr)
        return 0

    proc = subprocess.Popen(
        [args.terminal, "--stdin", "--project", os.path.abspath(args.project)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        bufsize=0,
    )
    assert proc.stdin and proc.stdout and proc.stderr

    # Drain initial "ready" line.
    ready_line = proc.stdout.readline().decode("utf-8", errors="replace").strip()
    print(f"[dump_atlas] terminal: {ready_line}", file=sys.stderr)

    out_f = open(args.out, "a", encoding="utf-8", buffering=1)

    t0 = time.time()
    last_t = t0
    try:
        for i, (x, y) in enumerate(todo):
            req = json.dumps({
                "command": "describe-landblock",
                "lbX": x, "lbY": y, "includeFootprints": False,
            }) + "\n"
            proc.stdin.write(req.encode("utf-8"))
            proc.stdin.flush()
            line = proc.stdout.readline()
            if not line:
                print(f"[dump_atlas] terminal closed early at LB ({x},{y})",
                      file=sys.stderr)
                break
            try:
                resp = json.loads(line.decode("utf-8", errors="replace"))
            except Exception as e:
                print(f"[dump_atlas] bad JSON at ({x},{y}): {e}; line={line[:200]!r}",
                      file=sys.stderr)
                continue
            if resp.get("command") != "describe-landblock" or not resp.get("success"):
                err = resp.get("error", "<no error field>")
                print(f"[dump_atlas] describe failed at ({x},{y}): {err}",
                      file=sys.stderr)
                continue
            out_f.write(json.dumps(slim(resp), ensure_ascii=False) + "\n")
            if (i + 1) % args.progress_every == 0:
                now = time.time()
                rate = args.progress_every / max(1e-6, now - last_t)
                eta_s = (len(todo) - (i + 1)) / max(1e-6, rate)
                print(f"[dump_atlas] {i+1}/{len(todo)}  "
                      f"rate={rate:.1f} LB/s  eta={eta_s/60:.1f}min",
                      file=sys.stderr)
                last_t = now
    finally:
        try:
            proc.stdin.write(b'{"command":"exit"}\n')
            proc.stdin.flush()
        except Exception:
            pass
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
        out_f.close()

    elapsed = time.time() - t0
    print(f"[dump_atlas] done in {elapsed/60:.1f} min", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
build_bucket_to_wcid_resolver.py
=================================

For every abstract ACE bucket the model can emit, record the empirical
distribution of real wcids that collapsed into that bucket during training.

Output is a JSON table:

    {
      "buckets": {
        "<abstract_label>": {
          "total": int,
          "unique_wcids": int,
          "wcids": [[wcid, count], ...]   # sorted by count desc
        },
        ...
      },
      ...
    }

Inputs are the same JSONLs that `extract_component_linked_tensors.py` reads,
so the bucket strings are guaranteed to match the trained vocab as long as
both scripts use the same `canonical_class_key`.
"""

import argparse
import datetime as _dt
import json
import os
from collections import Counter, defaultdict

from extract_component_linked_tensors import (
    ABSTRACT_ACE_SPACE,
    DEFAULT_COMPONENT_JSONL,
    DEFAULT_RAW_JSONL,
    REFERENCE_DIR,
    canonical_class_key,
    iter_jsonl,
)


DEFAULT_OUT = os.path.join(REFERENCE_DIR, "component_linked_unified_abstract_ace_bucket_resolver.json")


def scan_raw(path, counts):
    n = 0
    hits = 0
    for n, row in enumerate(iter_jsonl(path), start=1):
        key = canonical_class_key(row, "abstract_ace")
        if key is None or key[0] != ABSTRACT_ACE_SPACE:
            continue
        if row.get("classIdSpace") != "wcid":
            continue
        wcid = row.get("classId")
        if wcid is None:
            continue
        counts[key[1]][int(wcid)] += 1
        hits += 1
        if n % 500_000 == 0:
            print(f"  raw rows scanned: {n:,} (wcid hits: {hits:,})")
    return n, hits


def scan_components(path, counts):
    n = 0
    hits = 0
    for n, row in enumerate(iter_jsonl(path), start=1):
        anchor = row.get("anchor") or {}
        if anchor.get("classIdSpace") != "wcid":
            continue
        wcid = anchor.get("classId")
        if wcid is None:
            continue
        anchor_row = {
            "classIdSpace": "wcid",
            "classId": int(wcid),
            "sourceDb": anchor.get("sourceDb"),
            "sourceTable": anchor.get("sourceTable"),
            "typeId": anchor.get("typeId"),
            "envCellComponentKind": row.get("componentKind"),
            "cellId": anchor.get("cellId"),
        }
        key = canonical_class_key(anchor_row, "abstract_ace")
        if key is None or key[0] != ABSTRACT_ACE_SPACE:
            continue
        counts[key[1]][int(wcid)] += 1
        hits += 1
        if n % 50_000 == 0:
            print(f"  components scanned: {n:,} (wcid anchors: {hits:,})")
    return n, hits


def build_table(counts):
    buckets = {}
    for label, wcid_counts in counts.items():
        ordered = wcid_counts.most_common()
        buckets[label] = {
            "total": sum(wcid_counts.values()),
            "unique_wcids": len(wcid_counts),
            "wcids": [[w, c] for w, c in ordered],
        }
    return buckets


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--raw-jsonl", default=DEFAULT_RAW_JSONL)
    ap.add_argument("--component-jsonl", default=DEFAULT_COMPONENT_JSONL)
    ap.add_argument("--out", default=DEFAULT_OUT)
    args = ap.parse_args()

    print(f"  Raw facts : {args.raw_jsonl}")
    print(f"  Components: {args.component_jsonl}")
    print(f"  Output    : {args.out}")
    print()

    counts = defaultdict(Counter)

    print("[1/3] Scanning raw world facts...")
    raw_rows, raw_hits = scan_raw(args.raw_jsonl, counts)
    print(f"  raw rows: {raw_rows:,}  wcid hits: {raw_hits:,}")

    print("[2/3] Scanning envcell components...")
    comp_rows, comp_hits = scan_components(args.component_jsonl, counts)
    print(f"  components: {comp_rows:,}  wcid anchors: {comp_hits:,}")

    print("[3/3] Writing resolver table...")
    buckets = build_table(counts)
    total_obs = sum(b["total"] for b in buckets.values())
    unique_wcids = len({w for b in buckets.values() for w, _ in b["wcids"]})
    singleton_buckets = sum(1 for b in buckets.values() if b["unique_wcids"] == 1)

    payload = {
        "version": 1,
        "generated": _dt.datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "target_token_mode": "abstract_ace",
        "sources": {
            "raw_jsonl": os.path.abspath(args.raw_jsonl),
            "component_jsonl": os.path.abspath(args.component_jsonl),
        },
        "stats": {
            "total_buckets": len(buckets),
            "total_wcid_observations": total_obs,
            "unique_wcids": unique_wcids,
            "buckets_with_one_wcid": singleton_buckets,
        },
        "buckets": dict(sorted(buckets.items())),
    }

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    print()
    print(f"  buckets:                {len(buckets):,}")
    print(f"  total wcid observations:{total_obs:,}")
    print(f"  unique wcids:           {unique_wcids:,}")
    print(f"  buckets with 1 wcid:    {singleton_buckets:,}")
    print(f"  wrote: {args.out}")


if __name__ == "__main__":
    main()

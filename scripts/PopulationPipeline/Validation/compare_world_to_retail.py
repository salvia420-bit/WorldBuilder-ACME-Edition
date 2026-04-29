#!/usr/bin/env python3
"""
compare_world_to_retail.py
==========================

Quantitative comparison between a model-generated world and the retail world
facts that produced its training data. Region of comparison is auto-derived
from the generated placements (only landblocks the model emitted to are
counted on either side), so a small-region run can be evaluated without
loading the full retail world for nothing.

Inputs:
  --generated  JSONL produced by `generate_populated_world.py --output-jsonl`
  --retail     raw_world_facts_full_with_components_v2.jsonl (or equivalent)

Outputs:
  --out-json   structured numbers (machine-readable, for tracking over time)
  --out-md     readable report (markdown)

Failure modes this catches by design:
  - wcid mode collapse / over-replication ("leather crafters everywhere")
  - wcid in wrong context ("Tumerok shaman in a Direlands wilderness LB")
  - density drift (per-LB object count deviating from retail)
  - surface/interior shift (e.g. "surface portals appearing in interior cells")
  - long-tail loss (model emits a small subset of retail's wcid universe)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import pickle
import sys
from collections import Counter, defaultdict
from pathlib import Path
from statistics import mean, median


def parse_hexish(value):
    if value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.startswith("0x"):
        try:
            return int(value, 16)
        except ValueError:
            return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def is_interior_cell(cell_id):
    """AC convention: the *low 16 bits* of cellId distinguish surface cells
    (1..0x40, the 8×8 outdoor grid) from interior cells (>= 0x0100). Both retail
    `cellId` and generated `cell_id` are full 32-bit values like 0xA9B40001, so
    the mask is required — without it every row reads as interior."""
    cid = parse_hexish(cell_id)
    return bool(cid is not None and (cid & 0xFFFF) >= 0x0100)


def stream_jsonl(path):
    with open(path, "r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def load_generated(path):
    """Return (per_lb_density, wcid_counts, wcid_by_lb, surface, interior, total)."""
    per_lb = Counter()
    wcid_counts = Counter()
    wcid_by_lb = defaultdict(set)
    surface = 0
    interior = 0
    total = 0
    region = set()
    for row in stream_jsonl(path):
        lb = (int(row["lb_x"]), int(row["lb_y"]))
        wcid = row.get("wcid")
        if not isinstance(wcid, int) or wcid < 0:
            continue
        per_lb[lb] += 1
        wcid_counts[wcid] += 1
        wcid_by_lb[lb].add(wcid)
        if is_interior_cell(row.get("cell_id")):
            interior += 1
        else:
            surface += 1
        total += 1
        region.add(lb)
    return per_lb, wcid_counts, wcid_by_lb, surface, interior, total, region


def load_retail(path, region, *, quiet=False):
    """Stream retail JSONL, keep only rows whose (lbX, lbY) is in `region`,
    keep only wcid-space rows (model can only resolve to wcids).

    Also accumulates `wcid_to_wtype_counts[wcid][wtype] -> count` so the caller
    can derive a wcid→modal-wtype lookup without a second pass over the file.

    `class_space_counts` tallies retail rows in-region by classIdSpace
    BEFORE the wcid filter, so callers can report wcid vs model_id vs
    ace_abstract vs building_model coverage of retail's full class space.
    """
    per_lb = Counter()
    wcid_counts = Counter()
    wcid_by_lb = defaultdict(set)
    wtype_counts = Counter()
    wcid_to_wtype_counts: dict[int, Counter] = defaultdict(Counter)
    class_space_counts: Counter = Counter()
    surface = 0
    interior = 0
    total = 0
    for n, row in enumerate(stream_jsonl(path), start=1):
        try:
            lb = (int(row["landblockX"]), int(row["landblockY"]))
        except (KeyError, TypeError, ValueError):
            continue
        if region and lb not in region:
            continue
        cls_space = row.get("classIdSpace") or "unknown"
        class_space_counts[cls_space] += 1
        if cls_space != "wcid":
            continue
        wcid = row.get("classId")
        try:
            wcid = int(wcid)
        except (TypeError, ValueError):
            continue
        per_lb[lb] += 1
        wcid_counts[wcid] += 1
        wcid_by_lb[lb].add(wcid)
        wtype = row.get("typeId") or row.get("weenieType") or 0
        try:
            wt = int(wtype)
            wtype_counts[wt] += 1
            wcid_to_wtype_counts[wcid][wt] += 1
        except (TypeError, ValueError):
            pass
        if is_interior_cell(row.get("cellId")):
            interior += 1
        else:
            surface += 1
        total += 1
        if n % 1_000_000 == 0 and not quiet:
            print(f"  retail rows scanned: {n:,}", file=sys.stderr)
    return (per_lb, wcid_counts, wcid_by_lb, wtype_counts,
            surface, interior, total, wcid_to_wtype_counts, class_space_counts)


# ─── Retail snapshot cache ──────────────────────────────────────────────
# Hot-loop callers (the in-terminal compare-to-retail command) may compare
# the same region many times in a row while tuning. The retail JSONL scan
# is by far the dominant cost. Cache the post-filter result keyed by
# (retail file path, region landblock set, retail file mtime+size).

CACHE_VERSION = 2  # bump when load_retail's return shape changes

def _region_cache_key(retail_path: Path, region: set) -> str:
    try:
        st = retail_path.stat()
        sig = f"{retail_path.resolve()}|{st.st_size}|{int(st.st_mtime)}"
    except OSError:
        sig = str(retail_path.resolve())
    region_sig = ",".join(f"{x}_{y}" for x, y in sorted(region))
    h = hashlib.sha1(f"{sig}|{region_sig}".encode("utf-8")).hexdigest()[:16]
    return f"retail_v{CACHE_VERSION}_{h}.pkl"

def _try_load_cache(cache_dir: Path, key: str, *, quiet=False):
    cache_file = cache_dir / key
    if not cache_file.exists():
        return None
    try:
        with cache_file.open("rb") as f:
            data = pickle.load(f)
        if not isinstance(data, dict) or data.get("v") != CACHE_VERSION:
            return None
        if not quiet:
            print(f"  retail cache hit: {cache_file}", file=sys.stderr)
        return data
    except (pickle.PickleError, EOFError, OSError):
        return None

def _store_cache(cache_dir: Path, key: str, payload: dict, *, quiet=False) -> None:
    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file = cache_dir / key
        tmp = cache_file.with_suffix(".tmp")
        with tmp.open("wb") as f:
            pickle.dump({"v": CACHE_VERSION, **payload}, f, protocol=pickle.HIGHEST_PROTOCOL)
        tmp.replace(cache_file)
        if not quiet:
            print(f"  retail cache stored: {cache_file}", file=sys.stderr)
    except OSError as ex:
        if not quiet:
            print(f"  retail cache store failed: {ex}", file=sys.stderr)

def load_retail_cached(retail_path: Path, region: set, cache_dir: Path | None,
                       *, quiet=False):
    """Wrapper around load_retail() with optional pickle cache.

    Returns (result_tuple, cache_hit). cache_hit is the authoritative signal
    for the C# wrapper's `retailCacheHit` telemetry — file-count heuristics
    in the caller would lie if a cache write silently failed."""
    if cache_dir is not None and region:
        key = _region_cache_key(retail_path, region)
        hit = _try_load_cache(cache_dir, key, quiet=quiet)
        if hit is not None:
            return ((hit["per_lb"], hit["wcid"], hit["wcid_by_lb"], hit["wtype"],
                     hit["surf"], hit["intr"], hit["total"], hit["w2wt"], hit["cls_space"]),
                    True)

    result = load_retail(retail_path, region, quiet=quiet)
    if cache_dir is not None and region:
        per_lb, wcid, wcid_by_lb, wtype, surf, intr, total, w2wt, cls_space = result
        _store_cache(cache_dir, key, {
            "per_lb": per_lb, "wcid": wcid, "wcid_by_lb": wcid_by_lb,
            "wtype": wtype, "surf": surf, "intr": intr, "total": total,
            "w2wt": w2wt, "cls_space": cls_space,
        }, quiet=quiet)
    return (result, False)


def density_stats(per_lb, region):
    """Per-LB density: for every LB in region, how many objects (0 allowed)."""
    counts = [per_lb.get(lb, 0) for lb in region]
    if not counts:
        return {"n": 0, "min": 0, "p50": 0, "mean": 0.0, "p95": 0, "max": 0, "total": 0}
    counts_sorted = sorted(counts)
    p50 = counts_sorted[len(counts_sorted) // 2]
    p95 = counts_sorted[int(0.95 * (len(counts_sorted) - 1))]
    return {
        "n": len(counts),
        "min": counts_sorted[0],
        "p50": p50,
        "mean": round(mean(counts), 2),
        "p95": p95,
        "max": counts_sorted[-1],
        "total": sum(counts),
    }


def jaccard(a: set, b: set) -> float:
    if not a and not b:
        return 1.0
    return len(a & b) / max(1, len(a | b))


def per_lb_jaccard(model_by_lb, retail_by_lb, region):
    """For each LB, compute Jaccard(model_wcids, retail_wcids); summarize."""
    js = []
    for lb in region:
        m = model_by_lb.get(lb, set())
        r = retail_by_lb.get(lb, set())
        if not m and not r:
            continue
        js.append(jaccard(m, r))
    if not js:
        return {"n": 0, "mean": None, "p50": None, "p10": None}
    js_sorted = sorted(js)
    return {
        "n": len(js),
        "mean": round(mean(js), 4),
        "p50": round(median(js), 4),
        "p10": round(js_sorted[max(0, int(0.10 * (len(js_sorted) - 1)))], 4),
    }


def over_under_table(model_counts, retail_counts, *, min_model=20, k=30):
    """Return (over, under, novel, missing).

    over:    wcids where model_count >> retail_count (over-replication risk)
    under:   wcids where model_count << retail_count (long-tail loss)
    novel:   wcids in model but absent from retail-in-region
    missing: wcids in retail-in-region but absent from model
    """
    eps = 1.0  # add-1 smoothing
    rows = []
    universe = set(model_counts) | set(retail_counts)
    for wcid in universe:
        m = model_counts.get(wcid, 0)
        r = retail_counts.get(wcid, 0)
        ratio = (m + eps) / (r + eps)
        rows.append((wcid, m, r, ratio))
    over = [row for row in rows if row[1] >= min_model and row[3] > 1.0]
    over.sort(key=lambda x: -x[3])
    under = [row for row in rows if row[2] >= min_model and row[3] < 1.0]
    under.sort(key=lambda x: x[3])
    novel = [(w, m) for (w, m, r, _) in rows if r == 0 and m > 0]
    novel.sort(key=lambda x: -x[1])
    missing = [(w, r) for (w, m, r, _) in rows if m == 0 and r > 0]
    missing.sort(key=lambda x: -x[1])
    return over[:k], under[:k], novel[:k], missing[:k]


def share_table(counts):
    total = sum(counts.values()) or 1
    return {k: counts[k] / total for k in counts}


def per_landblock_breakdown(region, m_per_lb, r_per_lb,
                            m_wcid_by_lb, r_wcid_by_lb):
    """Per-LB drill-down so a tuning agent can inspect outliers.

    Returned rows sort by abs(model - retail) density delta descending so the
    most-divergent landblocks float to the top. The agent loop is expected to
    consume this directly; we keep the row count == |region| (no truncation)
    because the caller knows the size of the region they asked about.
    """
    rows = []
    for lb in region:
        lbx, lby = lb
        m_count = m_per_lb.get(lb, 0)
        r_count = r_per_lb.get(lb, 0)
        m_set = m_wcid_by_lb.get(lb, set())
        r_set = r_wcid_by_lb.get(lb, set())
        novel = m_set - r_set
        missing = r_set - m_set
        rows.append({
            "lbX": lbx,
            "lbY": lby,
            "modelCount": m_count,
            "retailCount": r_count,
            "densityDelta": m_count - r_count,
            "modelWcidUnique": len(m_set),
            "retailWcidUnique": len(r_set),
            "wcidJaccard": round(jaccard(m_set, r_set), 4) if (m_set or r_set) else None,
            "novelInLb": len(novel),
            "missingInLb": len(missing),
        })
    rows.sort(key=lambda r: -abs(r["densityDelta"]))
    return rows


def class_space_summary(retail_class_counts: Counter, model_total: int):
    """Summarize retail classIdSpace distribution and the model's coverage.

    Today the v3 unified model only emits in the wcid space, so the
    'modelEmitted' bucket is reported as wcid-only. The retail bucket
    spans wcid + model_id + ace_abstract + building_model + ... and lets
    the caller see what fraction of retail's placements are classes the
    model doesn't yet emit at all.
    """
    retail_total = sum(retail_class_counts.values()) or 1
    return {
        "retail": {k: int(v) for k, v in retail_class_counts.items()},
        "retailTotal": int(retail_total),
        "retailFractions": {k: round(v / retail_total, 4) for k, v in retail_class_counts.items()},
        "modelEmitted": {"wcid": int(model_total)},
        "modelTotal": int(model_total),
        "coverageOfRetailWcid": (
            round(model_total / retail_class_counts["wcid"], 4)
            if retail_class_counts.get("wcid") else None
        ),
        "coverageOfRetailAll": round(model_total / retail_total, 4),
    }


def context_anomalies(model_by_lb, retail_by_lb, region):
    """For each LB, count model wcids that retail never put in *that* LB."""
    novel_per_lb = []
    total_novel = 0
    total_emitted = 0
    for lb in region:
        m = model_by_lb.get(lb, set())
        r = retail_by_lb.get(lb, set())
        novel = m - r
        total_novel += len(novel)
        total_emitted += len(m)
        if m:
            novel_per_lb.append(len(novel) / len(m))
    if not novel_per_lb:
        return {"frac": 0.0, "novel_unique": 0, "emitted_unique": 0}
    return {
        "frac": round(total_novel / max(1, total_emitted), 4),
        "novel_unique": total_novel,
        "emitted_unique": total_emitted,
    }


def render_md(report) -> str:
    out = []
    push = out.append

    push("# Generated vs Retail comparison\n")
    push(f"- Generated JSONL: `{report['inputs']['generated']}`")
    push(f"- Retail JSONL:    `{report['inputs']['retail']}`")
    push(f"- Region:          {report['region']['n_landblocks']} landblocks "
         f"(x∈[{report['region']['x_min']},{report['region']['x_max']}], "
         f"y∈[{report['region']['y_min']},{report['region']['y_max']}])\n")

    push("## Volumes")
    push(f"- Generated placements: **{report['volumes']['generated']:,}**")
    push(f"- Retail placements:    **{report['volumes']['retail']:,}**  (wcid-space only, in region)")
    delta = report['volumes']['density_delta_pct']
    push(f"- Density delta:        **{delta:+.1f}%** "
         f"(model={report['density']['model']['mean']} per LB, "
         f"retail={report['density']['retail']['mean']} per LB)\n")

    push("## Wcid coverage")
    cov = report['coverage']
    push(f"- Generated unique wcids: **{cov['model_unique']:,}**")
    push(f"- Retail unique wcids:    **{cov['retail_unique']:,}**  (in region)")
    if cov['retail_unique']:
        push(f"- Coverage ratio:         **{100*cov['model_unique']/cov['retail_unique']:.1f}%**")
    push(f"- Wcids in both:          {cov['both']:,}")
    push(f"- Novel to model:         {cov['novel']:,}  (model emits, retail-in-region does not)")
    push(f"- Missing from model:     {cov['missing']:,}  (retail has, model never emits)\n")

    push("## Per-LB density distribution")
    push("| stat | model | retail |")
    push("|---|---:|---:|")
    for stat in ("min", "p50", "mean", "p95", "max", "total"):
        push(f"| {stat} | {report['density']['model'][stat]} | {report['density']['retail'][stat]} |")
    push("")

    push("## Surface / interior split")
    s = report['surface_interior']
    push(f"- Model:  surface={s['model_surface']:,} ({s['model_surface_pct']:.1f}%), "
         f"interior={s['model_interior']:,} ({s['model_interior_pct']:.1f}%)")
    push(f"- Retail: surface={s['retail_surface']:,} ({s['retail_surface_pct']:.1f}%), "
         f"interior={s['retail_interior']:,} ({s['retail_interior_pct']:.1f}%)\n")

    push("## Per-LB wcid-set Jaccard (theme/context coherence)")
    j = report['lb_jaccard']
    push(f"- LBs scored:   {j['n']:,}")
    if j['mean'] is not None:
        push(f"- mean:         **{j['mean']}**  (1.0 = identical wcid sets per LB)")
        push(f"- median:       {j['p50']}")
        push(f"- p10:          {j['p10']}")
    push("")

    push("## Out-of-context placements")
    a = report['anomalies']
    push(f"- Fraction of model wcids per LB that retail never put in that LB: **{100*a['frac']:.1f}%**")
    push(f"  ({a['novel_unique']:,} novel-in-LB out of {a['emitted_unique']:,} unique LB-wcid pairs)\n")

    push("## Top weenieType share comparison")
    push("| weenieType | model % | retail % | delta |")
    push("|---:|---:|---:|---:|")
    rows = sorted(report['wtype_share'].items(),
                  key=lambda kv: -max(kv[1]['model'], kv[1]['retail']))[:15]
    for wtype, share in rows:
        push(f"| {wtype} | {100*share['model']:.2f}% | {100*share['retail']:.2f}% | "
             f"{100*(share['model']-share['retail']):+.2f} pp |")
    push("")

    def _wcid_table(title, rows, cols):
        push(f"### {title}")
        if not rows:
            push("_(none)_\n")
            return
        push("| " + " | ".join(cols) + " |")
        push("|" + "|".join("---:" for _ in cols) + "|")
        for row in rows:
            push("| " + " | ".join(str(c) for c in row) + " |")
        push("")

    push("## Wcid frequency anomalies")
    _wcid_table(
        f"Top {len(report['wcids']['over'])} over-represented (model >> retail, model≥{report['params']['over_min_model']})",
        report['wcids']['over'], ["wcid", "model", "retail", "ratio"],
    )
    _wcid_table(
        f"Top {len(report['wcids']['under'])} under-represented (retail >> model, retail≥{report['params']['over_min_model']})",
        report['wcids']['under'], ["wcid", "model", "retail", "ratio"],
    )
    _wcid_table(
        f"Top {len(report['wcids']['novel'])} novel (model emits, retail-in-region does not)",
        report['wcids']['novel'], ["wcid", "model count"],
    )
    _wcid_table(
        f"Top {len(report['wcids']['missing'])} missing (retail-in-region has, model never emits)",
        report['wcids']['missing'], ["wcid", "retail count"],
    )

    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--generated", required=True, type=Path,
                    help="Model placements JSONL (from generate_populated_world.py --output-jsonl)")
    ap.add_argument("--retail", type=Path,
                    default=Path("pipeline_data/reference/raw_world_facts_full_with_components_v2.jsonl"),
                    help="Retail truth JSONL")
    ap.add_argument("--out-json", type=Path, default=None)
    ap.add_argument("--out-md", type=Path, default=None)
    ap.add_argument("--anomaly-min-model", type=int, default=20,
                    help="Minimum model count to surface a wcid in over/under tables")
    ap.add_argument("--top-k", type=int, default=30,
                    help="How many rows per anomaly table")
    ap.add_argument("--retail-cache-dir", type=Path, default=None,
                    help="Directory for region-filtered retail snapshot cache (speeds up tight tuning loops)")
    ap.add_argument("--stdout-json", action="store_true",
                    help="Also print the JSON report to stdout (for subprocess consumers)")
    ap.add_argument("--no-md", action="store_true",
                    help="Skip writing the markdown report")
    ap.add_argument("--no-out-json", action="store_true",
                    help="Skip writing the JSON report to disk (hot-loop subprocess callers consume --stdout-json)")
    ap.add_argument("--no-per-lb", action="store_true",
                    help="Skip the per-landblock breakdown in the JSON output")
    ap.add_argument("--quiet", action="store_true",
                    help="Suppress progress output on stderr")
    args = ap.parse_args()

    if not args.generated.exists():
        raise SystemExit(f"Generated JSONL not found: {args.generated}")
    if not args.retail.exists():
        raise SystemExit(f"Retail JSONL not found: {args.retail}")

    def log(msg):
        if not args.quiet:
            print(msg, file=sys.stderr)

    log(f"[1/3] Loading generated: {args.generated}")
    m_per_lb, m_wcid, m_wcid_by_lb, m_surf, m_int, m_total, region = load_generated(args.generated)
    log(f"  generated rows: {m_total:,}  unique wcids: {len(m_wcid):,}  region: {len(region):,} LBs")

    log(f"[2/3] Streaming retail (region-filtered): {args.retail}")
    retail_result, retail_cache_hit = load_retail_cached(
        args.retail, region, args.retail_cache_dir, quiet=args.quiet
    )
    (r_per_lb, r_wcid, r_wcid_by_lb, r_wtype, r_surf, r_int, r_total,
     wcid_to_wtype_counts, r_class_space) = retail_result
    log(f"  retail rows in region: {r_total:,}  unique wcids: {len(r_wcid):,}"
        f"  cache: {'hit' if retail_cache_hit else 'miss'}")

    # Model JSONL doesn't carry weenieType; map each wcid to its most-common
    # wtype as observed in retail-in-region.
    log("[3/3] Computing comparisons...")
    wcid_to_wtype = {w: c.most_common(1)[0][0] for w, c in wcid_to_wtype_counts.items() if c}

    m_wtype = Counter()
    for w, n in m_wcid.items():
        m_wtype[wcid_to_wtype.get(w, -1)] += n

    over, under, novel, missing = over_under_table(
        m_wcid, r_wcid, min_model=args.anomaly_min_model, k=args.top_k
    )

    # Densities
    m_density = density_stats(m_per_lb, region)
    r_density = density_stats(r_per_lb, region)

    if r_density["mean"]:
        density_delta_pct = 100 * (m_density["mean"] - r_density["mean"]) / r_density["mean"]
    else:
        density_delta_pct = 0.0

    # Wtype share
    m_share = share_table(m_wtype)
    r_share = share_table(r_wtype)
    wtype_share = {
        wt: {"model": m_share.get(wt, 0.0), "retail": r_share.get(wt, 0.0)}
        for wt in set(m_share) | set(r_share)
    }

    # Region bbox
    xs = [lb[0] for lb in region]
    ys = [lb[1] for lb in region]
    region_bbox = {
        "n_landblocks": len(region),
        "x_min": min(xs) if xs else 0,
        "x_max": max(xs) if xs else 0,
        "y_min": min(ys) if ys else 0,
        "y_max": max(ys) if ys else 0,
    }

    # Coverage
    m_uniq = set(m_wcid)
    r_uniq = set(r_wcid)
    coverage = {
        "model_unique": len(m_uniq),
        "retail_unique": len(r_uniq),
        "both": len(m_uniq & r_uniq),
        "novel": len(m_uniq - r_uniq),
        "missing": len(r_uniq - m_uniq),
    }

    # Surface/interior
    m_si_total = max(1, m_surf + m_int)
    r_si_total = max(1, r_surf + r_int)
    surface_interior = {
        "model_surface": m_surf,
        "model_interior": m_int,
        "model_surface_pct": 100 * m_surf / m_si_total,
        "model_interior_pct": 100 * m_int / m_si_total,
        "retail_surface": r_surf,
        "retail_interior": r_int,
        "retail_surface_pct": 100 * r_surf / r_si_total,
        "retail_interior_pct": 100 * r_int / r_si_total,
    }

    report = {
        "inputs": {
            "generated": str(args.generated),
            "retail": str(args.retail),
        },
        "params": {
            "over_min_model": args.anomaly_min_model,
            "top_k": args.top_k,
        },
        "cache": {
            "retail_hit": bool(retail_cache_hit),
            "dir": str(args.retail_cache_dir) if args.retail_cache_dir else None,
        },
        "region": region_bbox,
        "volumes": {
            "generated": m_total,
            "retail": r_total,
            "density_delta_pct": round(density_delta_pct, 2),
        },
        "density": {"model": m_density, "retail": r_density},
        "coverage": coverage,
        "surface_interior": surface_interior,
        "lb_jaccard": per_lb_jaccard(m_wcid_by_lb, r_wcid_by_lb, region),
        "anomalies": context_anomalies(m_wcid_by_lb, r_wcid_by_lb, region),
        "class_space": class_space_summary(r_class_space, m_total),
        "wtype_share": wtype_share,
        "wcids": {
            "over": [[w, m, r, round(ratio, 3)] for (w, m, r, ratio) in over],
            "under": [[w, m, r, round(ratio, 3)] for (w, m, r, ratio) in under],
            "novel": [[w, n] for (w, n) in novel],
            "missing": [[w, n] for (w, n) in missing],
        },
    }

    if not args.no_per_lb:
        report["per_landblock"] = per_landblock_breakdown(
            region, m_per_lb, r_per_lb, m_wcid_by_lb, r_wcid_by_lb)

    if not args.no_out_json:
        out_json = args.out_json or args.generated.with_suffix(".comparison.json")
        out_json.parent.mkdir(parents=True, exist_ok=True)
        out_json.write_text(json.dumps(report, indent=2))
        log(f"  JSON report: {out_json}")

    if not args.no_md:
        out_md = args.out_md or args.generated.with_suffix(".comparison.md")
        out_md.parent.mkdir(parents=True, exist_ok=True)
        out_md.write_text(render_md(report))
        log(f"  MD report:   {out_md}")

    if args.stdout_json:
        sys.stdout.write(json.dumps(report))
        sys.stdout.write("\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()

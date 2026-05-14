#!/usr/bin/env python3
"""Phase B.4 — Rust ace-compat vs C# ACE-source diff.

Compares two directories of `0xXXXX.scenery.jsonl` files (Rust output
from `scenery-bake --mode ace-compat` vs C# output from
`scenery-cross-check`). Both should contain the SAME 169 files for the
13×13 Holtburg ring.

The C# probe deliberately omits the Collision() rejection step, so its
output is an UPPER BOUND on what Rust emits (Rust adds the same set
PLUS rejects on building-AABB and self-collision). The expected pattern
is therefore: every Rust placement should have a matching C# placement,
but C# will have extras corresponding to Rust's collision rejections.

Match rule per the brief:
   obj_id matches AND |Δx|, |Δy|, |Δz| < 1e-4
   AND |Δscale| < 1e-5 AND quat-dot > 0.9999

Reports byte-identical line count + match counts at multiple float
thresholds + set-difference (extra-in-C# / extra-in-Rust).

Run:
    python3 compare.py \
        --rust /mnt/wbterminal1/tmp/claude-scratch/scenery-bake/b4/ace-compat \
        --csharp /mnt/wbterminal1/tmp/claude-scratch/scenery-bake/b4/ace-csharp-bake \
        --report /mnt/wbterminal1/tmp/claude-scratch/scenery-bake/b4/parity-report.md
"""

import argparse
import json
import math
import os
import sys
from collections import defaultdict
from pathlib import Path


def load_jsonl(path):
    out = []
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        out.append(json.loads(line))
    return out


def placement_key(p):
    """Group by (obj_id, source_cell_x, source_cell_y, source_obj_idx)
    — this is the deterministic identity of the placement from the
    PRNG side. If two runs agree on this 4-tuple but disagree on
    position, it's a numerical drift bug; if they disagree on the
    4-tuple it's a missing/extra placement."""
    return (
        p["obj_id"],
        p["source_cell_x"],
        p["source_cell_y"],
        p["source_obj_idx"],
    )


def quat_dot(a, b):
    return a["qw"] * b["qw"] + a["qx"] * b["qx"] + a["qy"] * b["qy"] + a["qz"] * b["qz"]


def match_within(a, b, pos_eps, scale_eps, quat_eps):
    if a["obj_id"] != b["obj_id"]:
        return False
    dx = abs(a["x"] - b["x"])
    dy = abs(a["y"] - b["y"])
    dz = abs(a["z"] - b["z"])
    if max(dx, dy, dz) >= pos_eps:
        return False
    if abs(a["scale"] - b["scale"]) >= scale_eps:
        return False
    if abs(quat_dot(a, b)) <= quat_eps:
        return False
    return True


def fmt_pct(num, denom):
    if denom == 0:
        return "n/a"
    return f"{100.0 * num / denom:.3f}%"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rust", required=True)
    ap.add_argument("--csharp", required=True)
    ap.add_argument("--report", required=True)
    args = ap.parse_args()

    rust_dir = Path(args.rust)
    cs_dir = Path(args.csharp)
    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)

    # Discover LB files (one or both directories).
    lbs = set()
    for d in [rust_dir, cs_dir]:
        for f in d.glob("0x*.scenery.jsonl"):
            lbs.add(f.name)
    lbs = sorted(lbs)

    # Aggregates across all LBs.
    total_rust = 0
    total_cs = 0
    matched_strict = 0  # pos_eps=1e-4
    matched_loose = 0   # pos_eps=1e-2
    rust_only = 0
    cs_only = 0
    byte_identical_lbs = 0
    line_drift_lbs = 0  # same placement keys but different bytes
    set_drift_lbs = 0   # different placement keys

    # Sample diffs for the report.
    sample_drifts = []  # list of (lb_name, rust_line, cs_line)
    sample_rust_only = []  # rust placements with no C# match
    sample_cs_only = []  # cs placements with no rust match

    # Per-LB analysis.
    per_lb_rows = []

    for fname in lbs:
        rust_lines = (rust_dir / fname).read_text().splitlines() if (rust_dir / fname).exists() else []
        cs_lines = (cs_dir / fname).read_text().splitlines() if (cs_dir / fname).exists() else []

        rust_placements = [json.loads(l) for l in rust_lines if l.strip()]
        cs_placements = [json.loads(l) for l in cs_lines if l.strip()]

        total_rust += len(rust_placements)
        total_cs += len(cs_placements)

        # Byte-identical short-circuit: if the JSONLs are identical
        # bytes-for-bytes the LB matched perfectly.
        rust_text = "\n".join(rust_lines)
        cs_text = "\n".join(cs_lines)
        if rust_text == cs_text:
            byte_identical_lbs += 1
            matched_strict += len(rust_placements)
            matched_loose += len(rust_placements)
            per_lb_rows.append((fname, len(rust_placements), len(cs_placements), len(rust_placements), 0, 0))
            continue

        # Build placement-key indices.
        rust_by_key = defaultdict(list)
        cs_by_key = defaultdict(list)
        for p in rust_placements:
            rust_by_key[placement_key(p)].append(p)
        for p in cs_placements:
            cs_by_key[placement_key(p)].append(p)

        # Match strict (1e-4 position, 1e-5 scale, 0.9999 quat-dot).
        # For each shared key, try to pair one Rust placement with one
        # C# placement.
        lb_matched_strict = 0
        lb_matched_loose = 0
        lb_rust_only = 0
        lb_cs_only = 0
        for key in set(rust_by_key.keys()) | set(cs_by_key.keys()):
            r_list = rust_by_key.get(key, [])
            c_list = cs_by_key.get(key, [])
            # Pair greedily by index — both lists are tiny (typically 1).
            n = min(len(r_list), len(c_list))
            for i in range(n):
                a, b = r_list[i], c_list[i]
                if match_within(a, b, 1e-4, 1e-5, 0.9999):
                    lb_matched_strict += 1
                    lb_matched_loose += 1
                elif match_within(a, b, 1e-2, 1e-3, 0.999):
                    lb_matched_loose += 1
                    if len(sample_drifts) < 10:
                        sample_drifts.append((fname, a, b))
                else:
                    # Same key, totally different placement — record as
                    # set-different.
                    lb_rust_only += 1
                    lb_cs_only += 1
                    if len(sample_drifts) < 10:
                        sample_drifts.append((fname, a, b))
            # Extras on either side.
            for j in range(n, len(r_list)):
                lb_rust_only += 1
                if len(sample_rust_only) < 10:
                    sample_rust_only.append((fname, r_list[j]))
            for j in range(n, len(c_list)):
                lb_cs_only += 1
                if len(sample_cs_only) < 10:
                    sample_cs_only.append((fname, c_list[j]))

        matched_strict += lb_matched_strict
        matched_loose += lb_matched_loose
        rust_only += lb_rust_only
        cs_only += lb_cs_only

        # Classify LB.
        rust_keys = set(rust_by_key.keys())
        cs_keys = set(cs_by_key.keys())
        if rust_keys == cs_keys:
            line_drift_lbs += 1
        else:
            set_drift_lbs += 1

        per_lb_rows.append((
            fname,
            len(rust_placements),
            len(cs_placements),
            lb_matched_strict,
            lb_rust_only,
            lb_cs_only,
        ))

    # Build report.
    lines = []
    lines.append("# Scenery Bake — Phase B.4 Parity Report")
    lines.append("")
    lines.append(f"- Rust source: `{rust_dir}` (`scenery-bake --mode ace-compat`)")
    lines.append(f"- C# source:   `{cs_dir}` (`scenery-cross-check` — ACE.DatLoader + ported Scenery.Load)")
    lines.append(f"- LBs considered: **{len(lbs)}**")
    lines.append("")
    lines.append("## Headline")
    lines.append("")
    lines.append(f"- Rust placements:   **{total_rust}**")
    lines.append(f"- C# placements:     **{total_cs}**")
    lines.append(f"- Matched (strict):  **{matched_strict}** ({fmt_pct(matched_strict, total_rust)} of Rust)")
    lines.append(f"- Matched (loose):   **{matched_loose}** ({fmt_pct(matched_loose, total_rust)} of Rust)")
    lines.append(f"- Rust-only (no C# match):  **{rust_only}**")
    lines.append(f"- C#-only (no Rust match):  **{cs_only}**")
    lines.append("")
    lines.append("## Per-LB classification")
    lines.append("")
    lines.append(f"- Byte-identical LBs:         **{byte_identical_lbs}** / {len(lbs)}")
    lines.append(f"- Same keys, line drift LBs:  **{line_drift_lbs}** / {len(lbs)}")
    lines.append(f"- Different placement keys:   **{set_drift_lbs}** / {len(lbs)}")
    lines.append("")
    lines.append("## Match thresholds")
    lines.append("")
    lines.append("- **Strict**: |Δxyz| < 1e-4, |Δscale| < 1e-5, |q·q'| > 0.9999")
    lines.append("- **Loose**:  |Δxyz| < 1e-2, |Δscale| < 1e-3, |q·q'| > 0.999")
    lines.append("")
    lines.append("## Interpretation")
    lines.append("")
    if rust_only == 0 and matched_strict == total_rust:
        lines.append("**Rust is a STRICT SUBSET of C# at the algorithm level.** Every Rust")
        lines.append("placement has a strict-tolerance C# twin, and the C# extras")
        lines.append("correspond to the Rust pipeline's Collision() rejection (which")
        lines.append("the C# probe skips on purpose).")
    elif rust_only == 0:
        lines.append("Rust is a SUBSET of C#, but some placements drift beyond strict")
        lines.append("tolerance. Check the **Sample drifts** section.")
    else:
        lines.append("Rust emits placements that C# doesn't — investigate the")
        lines.append("**Sample Rust-only** section. (Note: with collision skipped on")
        lines.append("the C# side this should NOT happen if both ports are algorithmically")
        lines.append("equivalent.)")
    lines.append("")
    if sample_drifts:
        lines.append("## Sample drifts (paired placements with non-strict match)")
        lines.append("")
        for fname, a, b in sample_drifts:
            lines.append(f"- {fname} obj=`{a['obj_id']}` cell=({a['source_cell_x']},{a['source_cell_y']}) idx={a['source_obj_idx']}:")
            lines.append(f"   - Rust: x={a['x']} y={a['y']} z={a['z']} scale={a['scale']}")
            lines.append(f"   - C#:   x={b['x']} y={b['y']} z={b['z']} scale={b['scale']}")
        lines.append("")
    if sample_rust_only:
        lines.append("## Sample Rust-only placements (no matching C# key)")
        lines.append("")
        for fname, p in sample_rust_only:
            lines.append(f"- {fname} obj=`{p['obj_id']}` cell=({p['source_cell_x']},{p['source_cell_y']}) idx={p['source_obj_idx']} pos=({p['x']:.4f},{p['y']:.4f},{p['z']:.4f})")
        lines.append("")
    if sample_cs_only:
        lines.append("## Sample C#-only placements (Rust collision-rejected, most likely)")
        lines.append("")
        for fname, p in sample_cs_only:
            lines.append(f"- {fname} obj=`{p['obj_id']}` cell=({p['source_cell_x']},{p['source_cell_y']}) idx={p['source_obj_idx']} pos=({p['x']:.4f},{p['y']:.4f},{p['z']:.4f})")
        lines.append("")

    lines.append("## Per-LB delta (top 20 by Rust-only)")
    lines.append("")
    lines.append("| LB | Rust | C# | Matched | Rust-only | C#-only |")
    lines.append("|---|---|---|---|---|---|")
    sorted_rows = sorted(per_lb_rows, key=lambda r: -r[4])[:20]
    for r in sorted_rows:
        lines.append(f"| {r[0]} | {r[1]} | {r[2]} | {r[3]} | {r[4]} | {r[5]} |")
    lines.append("")
    lines.append("(Full per-LB CSV at `per-lb-delta.csv` in the same dir.)")
    lines.append("")

    report_path.write_text("\n".join(lines) + "\n")
    csv_path = report_path.parent / "per-lb-delta.csv"
    with csv_path.open("w") as f:
        f.write("lb,rust,csharp,matched_strict,rust_only,csharp_only\n")
        for r in per_lb_rows:
            f.write(",".join(str(x) for x in r) + "\n")

    print(f"wrote {report_path}")
    print(f"wrote {csv_path}")
    print(f"HEADLINE: rust={total_rust} cs={total_cs} matched_strict={matched_strict} rust_only={rust_only} cs_only={cs_only}")


if __name__ == "__main__":
    sys.exit(main())

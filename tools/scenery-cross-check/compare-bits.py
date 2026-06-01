#!/usr/bin/env python3
"""Phase-1 bit-identity check.

Compare two dirs of `--bits` scenery JSONL:
  arg1 = Rust  `scenery-bake --bits`     output dir
  arg2 = C#    `scenery-cross-check --bits` output dir

In --bits mode each f32 field (x,y,z,qw,qx,qy,qz,scale) is the raw IEEE-754
to_bits() value as a decimal uint (with -0 normalised to +0 on both sides).
Bit-identical fields => the Rust port computes EXACTLY what ACE Scenery.Load
computes; any field mismatch is a real value divergence, NOT formatting.
"""
import json
import sys
from pathlib import Path

FIELDS = ["x", "y", "z", "qw", "qx", "qy", "qz", "scale"]


def load(d):
    m = {}
    for f in sorted(Path(d).glob("0x*.scenery.jsonl")):
        for line in f.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            p = json.loads(line)
            k = (f.name, p["obj_id"], p["source_cell_x"], p["source_cell_y"], p["source_obj_idx"])
            m[k] = p
    return m


def main():
    rust, cs = load(sys.argv[1]), load(sys.argv[2])
    rk, ck = set(rust), set(cs)
    shared, only_r, only_c = rk & ck, rk - ck, ck - rk
    field_mismatch = 0
    samples = []
    for k in shared:
        diffs = [fld for fld in FIELDS if rust[k][fld] != cs[k][fld]]
        if diffs:
            field_mismatch += 1
            if len(samples) < 20:
                samples.append((k, {f: (rust[k][f], cs[k][f]) for f in diffs}))
    print(f"rust placements: {len(rust)}  cs placements: {len(cs)}  shared keys: {len(shared)}")
    print(f"rust-only keys: {len(only_r)}  cs-only keys: {len(only_c)}")
    print(f"shared placements with >=1 bit-different field: {field_mismatch}")
    verdict = "BIT-IDENTICAL" if (field_mismatch == 0 and not only_r and not only_c) else "DIVERGENT"
    print(f"=> {verdict}")
    for k, vals in samples:
        print(f"  {k[0]} obj={k[1]} cell=({k[2]},{k[3]}) idx={k[4]}")
        for fld, (rv, cv) in vals.items():
            print(f"     {fld}: rust_bits={rv} cs_bits={cv}")
    sys.exit(0 if verdict == "BIT-IDENTICAL" else 1)


if __name__ == "__main__":
    main()

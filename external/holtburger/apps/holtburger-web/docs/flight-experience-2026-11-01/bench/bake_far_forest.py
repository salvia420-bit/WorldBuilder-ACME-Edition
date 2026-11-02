#!/usr/bin/env python3
"""bake_far_forest.py — the FAR FOREST placement pack (flight experience Phase 2; client scene3d/far_forest.js).

Input: the shipped retail scenery bake, dist/scenery-retail/0xXXYY.scenery.jsonl (65,025 landblocks, the SAME
placements the near tier draws — lane B §1.1). Output: dist/farforest/
  models.json          [{id, placements, meanH}] — the far-visible models (index = the u8 model field below)
  r_XX_YY.bin          one file per 8x8-landblock region with any tree: little-endian records of 20 bytes:
                       f32 x, f32 y, f32 z (AC world metres), f32 scale, u8 model, u8 yaw (0..255 = 0..2π),
                       u16 reserved
  index.json           {regions: {"XX_YY": count}, recordBytes: 20, regionLb: 8}

Which models: the retail census (lane B, scratchpad/retail_objstats.txt): every model whose mean placed height is
>= MIN_HEIGHT_M, plus the swaying-tree setups the census reports at zero size (animated scenery: 0x02000493/94 —
their baked AABB is empty because the bake cannot pose them).

Usage: python3 -I bake_far_forest.py <scenery-retail dir> <objstats.txt> <out dir>
"""
import json
import math
import os
import re
import struct
import sys

MIN_HEIGHT_M = 4.0
EXTRA_TREES = {0x02000493, 0x02000494}
REC = struct.Struct("<ffffBBH")


def load_models(objstats_path):
    models = []
    for line in open(objstats_path):
        m = re.match(r"0x([0-9A-Fa-f]+)\s+(\d+)\s+meanH=([-0-9.]+)", line.strip())
        if not m:
            continue
        mid, n, h = int(m.group(1), 16), int(m.group(2)), float(m.group(3))
        if h >= MIN_HEIGHT_M or mid in EXTRA_TREES:
            models.append({"id": mid, "placements": n, "meanH": h})
    models.sort(key=lambda r: -r["placements"])
    return models[:255]


def yaw_of(qw, qx, qy, qz):
    # rotation about AC +z (z-up): the heading of the object's +y axis
    siny = 2.0 * (qw * qz + qx * qy)
    cosy = 1.0 - 2.0 * (qy * qy + qz * qz)
    a = math.atan2(siny, cosy)
    return int(round((a % (2 * math.pi)) / (2 * math.pi) * 256)) & 0xFF


def main():
    src, objstats, out = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(out, exist_ok=True)
    models = load_models(objstats)
    index_of = {m["id"]: i for i, m in enumerate(models)}
    regions = {}
    files = [f for f in os.listdir(src) if f.endswith(".scenery.jsonl")]
    files.sort()
    total = 0
    for n, fname in enumerate(files):
        m = re.match(r"0x([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})\.scenery\.jsonl$", fname)
        if not m:
            continue
        lbx, lby = int(m.group(1), 16), int(m.group(2), 16)
        if lbx > 0xFE or lby > 0xFE:
            continue
        key = (lbx >> 3, lby >> 3)
        with open(os.path.join(src, fname), "rb") as fh:
            for raw in fh:
                if not raw.strip():
                    continue
                # cheap pre-filter on the model id before the JSON parse
                mm = re.search(rb'"obj_id"\s*:\s*"0x([0-9A-Fa-f]+)"', raw)
                if not mm:
                    continue
                oid = int(mm.group(1), 16)
                if oid not in index_of:
                    continue
                r = json.loads(raw)
                x = lbx * 192.0 + float(r["x"])
                y = lby * 192.0 + float(r["y"])
                z = float(r["z"])
                sc = float(r.get("scale", 1.0) or 1.0)
                yaw = yaw_of(float(r.get("qw", 1.0)), float(r.get("qx", 0.0)), float(r.get("qy", 0.0)), float(r.get("qz", 0.0)))
                regions.setdefault(key, bytearray()).extend(REC.pack(x, y, z, sc, index_of[oid], yaw, 0))
                total += 1
        if n % 5000 == 0:
            print(f"[far_forest] {n}/{len(files)} landblocks, {total} placements", flush=True)
    idx = {}
    for (rx, ry), buf in regions.items():
        name = f"r_{rx:02X}_{ry:02X}.bin"
        with open(os.path.join(out, name), "wb") as fh:
            fh.write(buf)
        idx[f"{rx:02X}_{ry:02X}"] = len(buf) // REC.size
    with open(os.path.join(out, "models.json"), "w") as fh:
        json.dump([{"id": f"0x{m['id']:08X}", "placements": m["placements"], "meanH": m["meanH"]} for m in models], fh, indent=1)
    with open(os.path.join(out, "index.json"), "w") as fh:
        json.dump({"schema": "hb-farforest-v1", "recordBytes": REC.size, "regionLb": 8, "models": len(models),
                   "placements": total, "regions": idx}, fh)
    print(f"[far_forest] done: {total} placements of {len(models)} models in {len(regions)} regions -> {out}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Static census of HBG1 relief VARIANT (GEOMR, 0x0C) rows in an HBP1 dist.

Reads the pack containers directly (docs/reengineering/pass-02-world-pack-format.md
S2-S3 layout, as implemented in apps/holtburger-tools/src/pack_format.rs) and, for
every model carrying a relief variant, compares the variant payload's triangle
count against its co-located relief-free default (crates/holtburger-dat/src/hbg1.rs
parse_geom_section + Hbg1Mesh header).

No browser, no wasm: this is the bake artifact read at rest.
"""
import os, sys, struct, subprocess, json, collections

DIST = sys.argv[1] if len(sys.argv) > 1 else "dist"
PACKS = os.path.join(DIST, "packs")

HDR = 32
SEC_ENTRY = 16
FOOTER = 8
GEOM, GEOMR = 0x09, 0x0C
PAYLOAD_HEADER_LEN = 16


def sections(fh):
    """-> (kind_byte, origin, {sec_kind: (codec, off, stored, raw)})"""
    fh.seek(0)
    head = fh.read(HDR)
    if len(head) < HDR or head[:4] != b"HBP1":
        return None
    pack_kind = head[5]
    origin = struct.unpack_from("<I", head, 8)[0]
    nsec = struct.unpack_from("<H", head, 12)[0]
    nns = head[14]
    tbl_off = HDR + nns * 32
    fh.seek(tbl_off)
    tbl = fh.read(nsec * SEC_ENTRY)
    out = {}
    for i in range(nsec):
        k, codec, _pad, off, stored, raw = struct.unpack_from("<HBBIII", tbl, i * SEC_ENTRY)
        out[k] = (codec, off, stored, raw)
    return pack_kind, origin, out


def read_section(fh, ent):
    codec, off, stored, raw = ent
    fh.seek(off)
    body = fh.read(stored)
    if codec == 0:
        return body
    return subprocess.run(["zstd", "-d", "-c", "-q"], input=body,
                          stdout=subprocess.PIPE, check=True).stdout


def rows(payload):
    n = struct.unpack_from("<I", payload, 0)[0]
    out = {}
    for i in range(n):
        r = 4 + 16 * i
        fid, enc, _pad, off, size = struct.unpack_from("<IHHII", payload, r)
        out[fid] = (enc, off, size)
    return out


def mesh_stats(p):
    """kind-0 payload -> (vertex_count, index_count, subset_count, bbox extent)"""
    if len(p) < PAYLOAD_HEADER_LEN + 40 or p[:4] != b"HBG1":
        return None
    kind = p[4]
    if kind != 0:
        return None
    mh = PAYLOAD_HEADER_LEN
    vc, ic = struct.unpack_from("<II", p, mh)
    sc = struct.unpack_from("<H", p, mh + 8)[0]
    bmin = struct.unpack_from("<3f", p, mh + 12)
    bmax = struct.unpack_from("<3f", p, mh + 24)
    return vc, ic, sc, bmin, bmax


def main():
    packs = []
    for root, _dirs, files in os.walk(PACKS):
        for f in files:
            if f.endswith(".hbp"):
                packs.append(os.path.join(root, f))
    packs.sort()
    print(f"[census] {len(packs)} packs under {PACKS}", file=sys.stderr)

    with_geomr = []
    for i, path in enumerate(packs):
        with open(path, "rb") as fh:
            s = sections(fh)
        if not s:
            continue
        pack_kind, origin, secs = s
        if GEOMR in secs:
            with_geomr.append((path, pack_kind, origin, secs))
        if i % 10000 == 0:
            print(f"  scanned {i}", file=sys.stderr)
    print(f"[census] {len(with_geomr)} packs carry a GEOMR section", file=sys.stderr)

    variants = {}      # fid -> dict
    packs_by_fid = collections.defaultdict(list)
    total_rows = 0
    for path, pack_kind, origin, secs in with_geomr:
        with open(path, "rb") as fh:
            gp = read_section(fh, secs[GEOM]) if GEOM in secs else b""
            rp = read_section(fh, secs[GEOMR])
        grows = rows(gp) if gp else {}
        rrows = rows(rp)
        total_rows += len(rrows)
        for fid, (enc, off, size) in rrows.items():
            packs_by_fid[fid].append((origin, pack_kind, os.path.basename(path)))
            if fid in variants:
                continue
            vm = mesh_stats(rp[off:off + size])
            dm = None
            if fid in grows:
                _e, doff, dsize = grows[fid]
                dm = mesh_stats(gp[doff:doff + dsize])
            if not vm or not dm:
                continue
            ext = [dm[4][k] - dm[3][k] for k in range(3)]
            variants[fid] = {
                "id": f"0x{fid:08X}",
                "def_tris": dm[1] // 3,
                "var_tris": vm[1] // 3,
                "added_tris": (vm[1] - dm[1]) // 3,
                "def_verts": dm[0],
                "var_verts": vm[0],
                "subsets": dm[2],
                "extent_m": [round(e, 3) for e in ext],
                "max_extent_m": round(max(ext), 3),
                "def_bytes": dsize,
                "var_bytes": size,
            }
    for fid, v in variants.items():
        v["packs"] = len(packs_by_fid[fid])
        v["origins"] = sorted({o for o, _k, _n in packs_by_fid[fid]})[:8]

    print(f"[census] {total_rows} GEOMR rows / {len(variants)} distinct models", file=sys.stderr)
    out = sorted(variants.values(), key=lambda v: -v["added_tris"])
    json.dump({"dist": DIST, "geomr_rows": total_rows,
               "distinct_models": len(variants), "models": out},
              open(sys.argv[2], "w") if len(sys.argv) > 2 else sys.stdout, indent=1)


main()

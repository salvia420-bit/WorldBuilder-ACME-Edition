#!/usr/bin/env python3
"""polyfix — in-place repair of the appended-polygon sides/stippling defect.

The obj-import path (Chorizite DRW defaults) wrote every APPENDED drawn polygon
as sides_type=2 (two-sided-distinct) with neg_surface=-1 and stippling=9
(Positive|NoNeg). Retail D3DPolyRender::ConstructMesh (decomp @0x59dfa0, crash
proven in-client on the 1070, fault 0x59e560, 2026-08-15) dereferences
surfaces[neg_surface] with NO bounds check whenever sides_type==2, so every
patched GfxObj access-violates ~3s after world entry; the stipple bit would
additionally push the shell onto the stippled/alpha render path.

Fix per DRAWN polygon matching (sides_type==2 AND neg_surface==-1):
    stippling := 0, sides_type := 0 (single-sided), neg_surface := 0.
Wire layout is UNCHANGED: posUVIndices presence = !(stip&4) (bit clear before
and after); negUVIndices presence = (sides==2 && !(stip&8)) (absent before via
NoNeg, absent after via sides=0). So the record is patched in place through its
existing block chain — no re-import, no allocator involvement. Physics
polygons are never touched (carried verbatim from base; not ConstructMesh fed).

usage: polyfix.py {audit|fix} --dat <portal.dat> [--ids-file imports.jsonl]
Without --ids-file every 0x01 GfxObj in the dat is scanned (audit-safe; fix
only rewrites records that contain matching polygons).
"""
import argparse, json, struct, sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import datlib, gfxlib


def drawn_poly_offsets(data):
    """Parse a GfxObj record with gfxlib's proven readers, returning
    [(byte_offset, stip, sides, neg), ...] for each DRAWN polygon."""
    r = gfxlib.Rdr(data)
    r.u32(); flags = r.u32()
    nsurf = r.compressed()
    for _ in range(nsurf):
        r.u32()
    gfxlib.read_vertex_array(r)
    if flags & 0x1:
        n = r.compressed()
        for _ in range(n):
            r.u16(); gfxlib.read_polygon(r)
        gfxlib._bsp(r, "physics")
    r.vec3()
    out = []
    if flags & 0x2:
        n = r.compressed()
        for _ in range(n):
            r.u16()
            start = r.o
            p = gfxlib.read_polygon(r)
            out.append((start, p["stip"], p["sides"], p["neg"]))
        gfxlib._bsp(r, "drawing")
    if flags & 0x8:
        r.u32()
    if len(data) - r.o != 0:
        raise ValueError("record not fully consumed (tail=%d)" % (len(data) - r.o))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["audit", "fix"])
    ap.add_argument("--dat", required=True)
    ap.add_argument("--ids-file", default=None)
    a = ap.parse_args()

    dat = datlib.Dat(a.dat)
    if a.ids_file:
        gids = sorted({int(json.loads(l)["gfxObjId"], 16) for l in open(a.ids_file)
                       if json.loads(l).get("command") == "obj-import"})
    else:
        gids = sorted(k for k in dat.files if (k >> 24) == 0x01)

    fixmode = a.cmd == "fix"
    f = open(a.dat, "r+b") if fixmode else None
    bs = dat.blocksize
    total = recs = skipped = 0
    for gid in gids:
        if gid not in dat.files:
            continue
        raw = dat.get(gid)
        try:
            polys = drawn_poly_offsets(raw)
        except Exception as e:
            print("0x%08X: SKIP (%s)" % (gid, e))
            skipped += 1
            continue
        hits = [start for (start, stip, sides, neg) in polys
                if sides == 2 and neg == -1]
        if not hits:
            continue
        recs += 1
        total += len(hits)
        if not fixmode:
            continue
        buf = bytearray(raw)
        for start in hits:
            buf[start + 1] = 0                              # stippling
            struct.pack_into("<i", buf, start + 2, 0)       # sides_type
            struct.pack_into("<h", buf, start + 8, 0)       # neg_surface
        # write back through the record's existing block chain
        off, size, _ = dat.files[gid]
        chain, cur, need = [], off, size
        while need > 0:
            chain.append(cur)
            dat.f.seek(cur)
            nxt = struct.unpack("<I", dat.f.read(4))[0]
            need -= bs - 4
            if nxt == 0:
                break
            cur = nxt
        w = 0
        for b in chain:
            n = min(bs - 4, len(buf) - w)
            f.seek(b + 4)
            f.write(buf[w:w + n])
            w += n
            if w >= len(buf):
                break
        assert w >= len(buf), "chain shorter than record for 0x%08X" % gid
    if fixmode:
        f.flush(); os.fsync(f.fileno()); f.close()
    print("%s: %d bad polygons in %d records, %d skipped%s"
          % (a.cmd, total, recs, skipped, " — PATCHED" if fixmode else ""))


if __name__ == "__main__":
    main()

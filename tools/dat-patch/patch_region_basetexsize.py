#!/usr/bin/env python3
"""patch_region_basetexsize.py -- retarget the landscape composite size.

Region 0x13000000 . terrainInfo . landSurfaces . texMerge . baseTexSize is a
single u32 and it is the ceiling on terrain texel density for the whole
client:

  * TexMerge::UnPack (acclient.c:306032) reads it as the FIRST field of
    TexMerge:  `this->base_tex_size = *(_DWORD *)*addr`.
  * TexMerge::FillTempTexBuffer (:305935) allocates the one composite buffer
    as `operator new[](4 * base_tex_size * base_tex_size)`.
  * TexMerge::RestoreSurface (:306252) / MakeNewSurface (:306287) derive every
    composite's edge from it:
    `(base_tex_size >> ImageShift[fLandTextureScale]) / (did >> 28)`.
  * ImgTex::TileCSI (:365513) tiles the base terrain texture `texTiling`
    times per axis into that buffer, so the base terrain RenderSurfaces must
    be exactly base_tex_size / texTiling on a side (1024 at baseTexSize 2048,
    texTiling 2), and ImgTex::MergeTexture (:365632) walks the blend mask
    with the BASE texture's width as its row stride, so the 8 corner/side/
    road masks must match the base edge, not the composite edge.

So this tool is one third of the terrain 2x lane and is INERT (in fact
actively wrong) without the other two: bake the 29 bases at 1024 and the 8
masks at 1024 first (terrain_lane.py bake --size 1024 / alpha --size 1024).

The u32 is NOT located by a hardcoded offset.  The record is parsed forward
from byte 0 in ACE.DatLoader's RegionDesc field order (Entity/*.cs, mirrored
by DatReaderWriter dats.xml <type name="Region">) down to
LandSurf.TexMerge, and the tool prints the whole field trail it walked plus
the structure that follows the u32 (map counts, mask ids, terrain-texture
ids) so the location is checkable by eye as well as by the re-parse.

  probe   --dat D                    parse + report, touch nothing
  patch   --dat D [--value 2048] --apply
                                     in-place 4-byte rewrite + verify

An in-place rewrite is legitimate here precisely because a u32 -> u32 edit
cannot change the record length: no b-tree entry, free chain, block chain or
neighbouring record is touched, and `patch` proves it by byte-comparing the
whole record before and after (exactly 4 bytes may differ, at the offset the
parse pointed at).
"""
import argparse
import hashlib
import os
import struct
import sys

REGION_ID = 0x13000000
HDR = 0x140            # dat header offset


# ── refusals ────────────────────────────────────────────────────────────
# The retail dats and every shipped/served export are read-only ground truth.
FORBIDDEN = (
    "/home/wbterminal/ac_base_dats",
    "/mnt/wbterminal2/dat-patch-r7/export",
    "ace-r7-dats",
)


def guard(path):
    p = os.path.realpath(path)
    for bad in FORBIDDEN:
        if bad in p or p.startswith(bad):
            raise SystemExit("REFUSED: %s is protected (%s)" % (p, bad))
    st = os.stat(p)
    if st.st_nlink > 1:
        # the r7 export dats are hardlinked into the live ACE dat dir --
        # writing "a copy" with nlink>1 writes the served file too.
        raise SystemExit(
            "REFUSED: %s has %d hard links -- write it and you write every "
            "other name for the same inode (ace-r7-dats). Copy it first."
            % (p, st.st_nlink))
    return p


# ── dat plumbing: targeted b-tree descent + block-chain addressing ──────
class DatFile:
    def __init__(self, path, mode="rb"):
        self.path = path
        self.f = open(path, mode)
        self.f.seek(HDR)
        h = struct.unpack("<13I", self.f.read(52))
        self.blocksize = h[1]
        self.filesize = h[2]
        self.btree = h[8]

    def close(self):
        self.f.close()

    def _node(self, off):
        objsize = 4 * 0x3E + 4 + 24 * 0x3D
        return self._read_chain(off, objsize)[0]

    def _read_chain(self, off, size):
        """-> (bytes, [(file_pos, nbytes), ...]) so a payload offset can be
        mapped back to an absolute file position."""
        buf = bytearray()
        spans = []
        bs = self.blocksize
        pos = off
        remaining = size
        while remaining > 0:
            self.f.seek(pos)
            nxt = struct.unpack("<I", self.f.read(4))[0]
            take = remaining if nxt == 0 else min(bs - 4, remaining)
            spans.append((pos + 4, take))
            buf += self.f.read(take)
            remaining -= take
            if remaining and nxt == 0:
                raise IOError("block chain ended %d bytes early" % remaining)
            pos = nxt
        return bytes(buf[:size]), spans

    def find(self, oid):
        """B-tree DESCENT (entries are id-ordered) -> (flags, off, size, iter)."""
        node = self.btree
        while True:
            b = self._node(node)
            branches = struct.unpack_from("<62I", b, 0)
            cnt = struct.unpack_from("<I", b, 62 * 4)[0]
            base = 62 * 4 + 4
            i = 0
            while i < cnt:
                fl, eid, foff, fsize, date, itr = struct.unpack_from(
                    "<6I", b, base + i * 24)
                if oid == eid:
                    return fl, foff, fsize, itr
                if oid < eid:
                    break
                i += 1
            if branches[0] == 0:
                return None
            node = branches[i]

    def record(self, oid):
        e = self.find(oid)
        if e is None:
            raise SystemExit("0x%08X not present in %s" % (oid, self.path))
        flags, off, size, itr = e
        if flags & 1:
            raise SystemExit(
                "0x%08X is stored COMPRESSED (btree flags 0x%08X): an in-place "
                "u32 rewrite is meaningless. Patch before compression, or "
                "decompress/rewrite/recompress the record." % (oid, flags))
        data, spans = self._read_chain(off, size)
        return dict(flags=flags, offset=off, size=size, iteration=itr,
                    data=data, spans=spans)

    def file_pos(self, spans, payload_off):
        """payload byte index -> absolute file position."""
        seen = 0
        for pos, n in spans:
            if payload_off < seen + n:
                return pos + (payload_off - seen)
            seen += n
        raise IndexError(payload_off)


# ── RegionDesc parse (ACE.DatLoader/FileTypes/RegionDesc.cs order) ──────
class R:
    def __init__(self, b):
        self.b = b
        self.o = 0

    def u32(self):
        v = struct.unpack_from("<I", self.b, self.o)[0]
        self.o += 4
        return v

    def i32(self):
        v = struct.unpack_from("<i", self.b, self.o)[0]
        self.o += 4
        return v

    def f32(self):
        v = struct.unpack_from("<f", self.b, self.o)[0]
        self.o += 4
        return v

    def f64(self):
        v = struct.unpack_from("<d", self.b, self.o)[0]
        self.o += 8
        return v

    def pstr(self):
        n = struct.unpack_from("<H", self.b, self.o)[0]
        self.o += 2
        s = self.b[self.o:self.o + n].decode("latin-1")
        self.o += n
        return s

    def align(self):
        d = self.o % 4
        if d:
            self.o += 4 - d

    def lst(self, fn):
        return [fn() for _ in range(self.u32())]


def parse_region(data):
    """Walk to texMerge.baseTexSize and return the trail + its byte offset."""
    r = R(data)
    t = {}
    t["id"] = r.u32()
    t["regionNumber"] = r.u32()
    t["version"] = r.u32()
    t["regionName"] = r.pstr()
    r.align()
    # LandDefs
    ld = dict(numBlockLength=r.i32(), numBlockWidth=r.i32(),
              squareLength=r.f32(), lblockLength=r.i32(),
              vertexPerCell=r.i32(), maxObjHeight=r.f32(),
              skyHeight=r.f32(), roadWidth=r.f32())
    r.o += 4 * 256                      # LandHeightTable, fixed 256 floats
    t["landDefs"] = ld
    # GameTime
    r.f64(); r.u32(); r.f32(); r.u32()
    r.pstr(); r.align()
    n = r.u32()                                     # TimesOfDay
    for _ in range(n):
        r.f32(); r.u32(); r.pstr(); r.align()
    t["timesOfDay"] = n
    n = r.u32()                                     # DaysOfTheWeek
    for _ in range(n):
        r.pstr(); r.align()
    t["daysOfWeek"] = n
    n = r.u32()                                     # Seasons
    for _ in range(n):
        r.u32(); r.pstr(); r.align()
    t["seasons"] = n
    pm = r.u32()
    t["partsMask"] = pm
    if pm & 0x10:                                   # SkyDesc
        r.f64(); r.f64()
        dg = r.u32()
        for _ in range(dg):
            r.f32(); r.pstr(); r.align()
            for _ in range(r.u32()):                # SkyObject
                r.o += 9 * 4
            for _ in range(r.u32()):                # SkyTimeOfDay
                r.o += 11 * 4
                r.align()
                for _ in range(r.u32()):            # SkyObjectReplace
                    r.o += 6 * 4
        t["dayGroups"] = dg
    if pm & 0x01:                                   # SoundDesc
        n = r.u32()
        for _ in range(n):
            r.u32()
            for _ in range(r.u32()):                # AmbientSoundDesc
                r.o += 5 * 4
        t["ambientStbDescs"] = n
    if pm & 0x02:                                   # SceneDesc
        n = r.u32()
        for _ in range(n):
            r.u32()                                 # StbIndex
            ns = r.u32()                            # NB: read the count into a
            r.o += 4 * ns                           # temp -- `r.o += 4*r.u32()`
        t["sceneTypes"] = n                         # loses the count's 4 bytes
                                                    # (augmented assignment
                                                    # loads r.o before the RHS)
    # TerrainDesc
    n = r.u32()
    names = []
    for _ in range(n):
        names.append(r.pstr())
        r.align()
        r.u32()                                     # TerrainColor
        ns = r.u32()                                # SceneTypes count
        r.o += 4 * ns
    t["terrainTypes"] = n
    t["terrainTypeFirst3"] = names[:3]
    # LandSurf
    t["landSurfTypeOffset"] = r.o
    t["landSurfType"] = r.u32()                     # always 0 (no PalShift)
    # TexMerge
    t["baseTexSizeOffset"] = r.o
    t["baseTexSize"] = r.u32()
    t["cornerTerrainMaps"] = [dict(tcode=r.u32(), texGid="0x%08X" % r.u32())
                              for _ in range(r.u32())]
    t["sideTerrainMaps"] = [dict(tcode=r.u32(), texGid="0x%08X" % r.u32())
                            for _ in range(r.u32())]
    t["roadMaps"] = [dict(rcode=r.u32(), texGid="0x%08X" % r.u32())
                     for _ in range(r.u32())]
    td = []
    for _ in range(r.u32()):
        tt = r.u32()
        f = struct.unpack_from("<10I", data, r.o)
        r.o += 40
        td.append(dict(terrainType=tt, texGid="0x%08X" % f[0], texTiling=f[1],
                       detailTexTiling=f[8], detailTexGid="0x%08X" % f[9]))
    t["terrainDesc"] = td
    t["texMergeEndOffset"] = r.o
    t["recordLen"] = len(data)
    t["trailingBytes"] = len(data) - r.o
    return t


def sanity(t):
    """Structural assertions that make the located offset self-proving."""
    bad = []
    if t["id"] != REGION_ID:
        bad.append("record id 0x%08X != 0x13000000" % t["id"])
    if t["landSurfType"] != 0:
        bad.append("LandSurf.Type %d != 0 (PalShift variant, parse invalid)"
                   % t["landSurfType"])
    if t["baseTexSize"] not in (256, 512, 1024, 2048, 4096):
        bad.append("baseTexSize %d is not a plausible power of two"
                   % t["baseTexSize"])
    for k in ("cornerTerrainMaps", "sideTerrainMaps", "roadMaps"):
        if not t[k]:
            bad.append("%s is empty" % k)
        for m in t[k]:
            if not m["texGid"].startswith("0x05"):
                bad.append("%s holds %s, not a SurfaceTexture id" % (k, m["texGid"]))
    if not t["terrainDesc"]:
        bad.append("terrainDesc is empty")
    for d in t["terrainDesc"]:
        if not d["texGid"].startswith("0x05"):
            bad.append("terrainDesc %s is not a SurfaceTexture id" % d["texGid"])
        if d["texTiling"] not in (1, 2, 4, 8):
            bad.append("texTiling %d out of range" % d["texTiling"])
    # the record must end at TexMerge, or with exactly one RegionMisc (6 u32)
    if t["trailingBytes"] not in (0, 24):
        bad.append("%d bytes left after TexMerge (expect 0, or 24 for "
                   "RegionMisc)" % t["trailingBytes"])
    return bad


def report(t, tag=""):
    print("%sRegion 0x%08X  '%s'  version=%d  partsMask=0x%X  record=%d B"
          % (tag, t["id"], t["regionName"], t["version"], t["partsMask"],
             t["recordLen"]))
    print("%s  landDefs %dx%d blocks, square=%.1f, vertexPerCell=%d"
          % (tag, t["landDefs"]["numBlockLength"], t["landDefs"]["numBlockWidth"],
             t["landDefs"]["squareLength"], t["landDefs"]["vertexPerCell"]))
    print("%s  terrainTypes=%d %s ... timesOfDay=%d seasons=%d"
          % (tag, t["terrainTypes"], t["terrainTypeFirst3"], t["timesOfDay"],
             t["seasons"]))
    print("%s  @%d landSurf.Type = %d  (0 = TexMerge follows, no PalShift)"
          % (tag, t["landSurfTypeOffset"], t["landSurfType"]))
    print("%s  @%d texMerge.baseTexSize = %d   <== THE u32"
          % (tag, t["baseTexSizeOffset"], t["baseTexSize"]))
    print("%s  then: corner=%d side=%d road=%d terrainDesc=%d, "
          "TexMerge ends @%d (+%d trailing)"
          % (tag, len(t["cornerTerrainMaps"]), len(t["sideTerrainMaps"]),
             len(t["roadMaps"]), len(t["terrainDesc"]), t["texMergeEndOffset"],
             t["trailingBytes"]))
    print("%s  corner masks: %s" % (tag, [m["texGid"] for m in t["cornerTerrainMaps"]]))
    print("%s  side masks:   %s" % (tag, [m["texGid"] for m in t["sideTerrainMaps"]]))
    print("%s  road masks:   %s" % (tag, [m["texGid"] for m in t["roadMaps"]]))
    tl = sorted({d["texTiling"] for d in t["terrainDesc"]})
    print("%s  terrainDesc texTiling values: %s -> base terrain RS edge must be "
          "%s" % (tag, tl, ["%d" % (t["baseTexSize"] // x) for x in tl]))
    print("%s  first 3 terrain textures: %s"
          % (tag, [(d["terrainType"], d["texGid"]) for d in t["terrainDesc"][:3]]))


def probe(path):
    d = DatFile(path)
    try:
        rec = d.record(REGION_ID)
    finally:
        d.close()
    t = parse_region(rec["data"])
    print("dat: %s" % path)
    print("  btree: flags=0x%08X offset=0x%X size=%d iteration=%d  sha256=%s"
          % (rec["flags"], rec["offset"], rec["size"], rec["iteration"],
             hashlib.sha256(rec["data"]).hexdigest()[:16]))
    report(t, "  ")
    bad = sanity(t)
    print("  sanity: %s" % ("OK" if not bad else "FAILED " + "; ".join(bad)))
    return rec, t, bad


def patch(path, value, apply_it):
    path = guard(path)
    rec, t, bad = probe(path)
    if bad:
        raise SystemExit("refusing to patch a record that failed sanity")
    if value & (value - 1):
        raise SystemExit("baseTexSize %d is not a power of two" % value)
    if t["baseTexSize"] == value:
        print("\nalready %d -- nothing to do" % value)
        return
    off = t["baseTexSizeOffset"]
    print("\nplan: payload offset %d : %d -> %d" % (off, t["baseTexSize"], value))
    print("      base terrain RS edge must become %d, blend masks %d"
          % (value // 2, value // 2))
    if not apply_it:
        print("      (dry run -- pass --apply to write)")
        return
    before = rec["data"]
    d = DatFile(path, "r+b")
    try:
        fp = d.file_pos(rec["spans"], off)
        d.f.seek(fp)
        cur = struct.unpack("<I", d.f.read(4))[0]
        if cur != t["baseTexSize"]:
            raise SystemExit("file position %d holds %d, parse said %d -- abort"
                             % (fp, cur, t["baseTexSize"]))
        d.f.seek(fp)
        d.f.write(struct.pack("<I", value))
        d.f.flush()
        os.fsync(d.f.fileno())
        print("      wrote 4 bytes at file offset 0x%X" % fp)
    finally:
        d.close()
    # ── verify: re-read, re-parse, byte-compare ────────────────────────
    d = DatFile(path)
    try:
        rec2 = d.record(REGION_ID)
    finally:
        d.close()
    after = rec2["data"]
    diff = [i for i in range(min(len(before), len(after))) if before[i] != after[i]]
    t2 = parse_region(after)
    # the invariant is "nothing OUTSIDE the u32 moved" -- 1024 -> 2048 only
    # actually flips one byte, so demand containment, not equality
    ok = (len(before) == len(after)
          and diff and set(diff) <= set(range(off, off + 4))
          and t2["baseTexSize"] == value
          and rec2["size"] == rec["size"]
          and rec2["offset"] == rec["offset"]
          and rec2["flags"] == rec["flags"]
          and not sanity(t2))
    # every parsed field except baseTexSize must be identical
    a = dict(t); b = dict(t2)
    a.pop("baseTexSize"); b.pop("baseTexSize")
    ok = ok and a == b
    print("\nVERIFY")
    print("  record length %d -> %d" % (len(before), len(after)))
    print("  differing bytes: %s (must lie inside the u32 at %s)"
          % (diff, list(range(off, off + 4))))
    print("  btree entry unchanged: offset=0x%X size=%d flags=0x%08X"
          % (rec2["offset"], rec2["size"], rec2["flags"]))
    print("  re-parsed baseTexSize = %d" % t2["baseTexSize"])
    print("  all other parsed fields identical: %s" % (a == b))
    report(t2, "  ")
    print("  RESULT: %s" % ("PASS" if ok else "FAIL"))
    if not ok:
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["probe", "patch"])
    ap.add_argument("--dat", required=True)
    ap.add_argument("--value", type=int, default=2048)
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    if a.cmd == "probe":
        probe(a.dat)
    else:
        patch(a.dat, a.value, a.apply)


if __name__ == "__main__":
    main()

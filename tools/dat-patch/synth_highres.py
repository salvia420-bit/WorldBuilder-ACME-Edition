#!/usr/bin/env python3
"""synth_highres.py -- client_highres.dat reader, CI fixture generator and
real-file calibrator (G6 / r7.1).

The real EoR `client_highres.dat` was acquired 2026-08-17
(133,169,152 bytes, sha256 503e0828...e727) and every claim below has been
checked against it.  This tool has four jobs:

  survey   parse a REAL client_highres.dat end to end and diff it against the
           model the inventory report predicted.
  headers  dump that file's per-record header table (~210 KB of JSON) so the
           fixture can be rebuilt shape-exact on a machine without the dat.
  build    manufacture a SYNTHETIC client_highres.dat -- the CI fixture the
           lane is tested against when the real 127 MiB file is not to hand.
  verify   fingerprint + per-record validation of either.

It is also the shared library for `highres_lane.py`: RenderSurface record
parse/build, the in-format 2x upscalers, and the streaming dat writer.

FILE SHAPE (verified against the real dat)
------------------------------------------
  * header @0x140 (ACE DatLoader/DatDatabaseHeader.cs = client
    `DiskFileInfo_t`): filetype 0x5442, blockSize 1024, dataset 1
    (PORTAL_DATFILE), subset 0x69466948 ("HiFi") -- the values
    `CLCache::LoadHighResDat` passes to `DiskConInitInfo`
    (acclient.c:293705-293716).  The real file also carries
    EnginePackVersion 110 and the same VersionMajor GUID / VersionMinor
    0x1A01 as `client_portal.dat`, i.e. it is the same EoR build.
  * 2,294 RenderSurface (0x06) records plus one `0xFFFF0001` Iteration
    record and NOTHING else -- confirming trevis' b-tree type survey
    (#utilitybelt 2024-11-02) and the inventory report's S4c.
  * each record `u32 Id, DataCategory, Width, Height, PixelFormat, Length,
    SourceData[Length] [, u32 DefaultPaletteId]` (ACE
    `DatLoader/FileTypes/Texture.cs:Unpack`, DRW dats.xml).  All 2,294 parse
    with zero trailing bytes and a declared Length that matches the computed
    size for (format, w, h).

PIXELS (fixture only -- scaffolding, never shipping content)
-----------------------------------------------------------
A nearest upscale of the retail portal sibling's own bytes, done *in the
stored encoding*, exactly:

  * DXT1/DXT3/DXT5 -- a 2x nearest upscale is exactly representable in DXT:
    each output 4x4 block reuses the source block's endpoints and replicates
    the 2x2 index quadrant it covers.  No decode, no re-encode, no drift.
    (Proven byte-identical against PIL's independent DXT decoder on 60
    retail records.)
  * INDEX16/P8 -- index words replicated 2x2; DefaultPaletteId preserved
    verbatim, so the palette (and any recolour) still resolves.
  * R8G8B8 / A8R8G8B8 / A8 / CUSTOM_LSCAPE_* / R5G6B5 / A4R4G4B4 -- raw
    pixel bytes replicated 2x2.

Nothing is decoded to RGBA, so no PIL/numpy colour-space assumption can
corrupt the fixture, and memory stays O(one record).

`build --headers data/highres-eor2013-headers.json` reproduces the real
file's id set, dims, formats, data categories, palettes and payload lengths
EXACTLY (0 mismatches over all 2,294 records); without it, the fixture is
derived purely from the F1 degrade audit + the "2x the portal sibling" model
and lands within 13 dims / 2 formats / 11 ids of the real thing.

USAGE
-----
  python3 synth_highres.py survey  --dat REAL.dat [--out survey.json]
  python3 synth_highres.py headers --dat REAL.dat --out headers.json
  python3 synth_highres.py build   --out FIXTURE.dat [--headers headers.json]
                                   [--portal ~/ac_base_dats/client_portal.dat]
                                   [--audit .../degrade-chain-audit.json]
                                   [--manifest M.json] [--limit N]
  python3 synth_highres.py verify  --dat FILE [--manifest M] [--portal P]

Refuses to write inside ~/ac_base_dats or the r7 export/ship trees.
"""
import argparse
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# ---------------------------------------------------------------- constants
DAT_MAGIC = 0x00005442
BLOCK_SIZE = 1024
DATASET_PORTAL = 1
SUBSET_HIFI = 0x69466948          # 'HiFi' LE -- CLCache::LoadHighResDat
ITERATION_ID = 0xFFFF0001

# Real-file fingerprint.  The byte count was PREDICTED by the inventory report
# (S4a, subtraction from trevis' EoR dat totals) and the acquired EoR file
# matches it exactly.  The id count is the MEASURED one: 2,294, not the
# report's predicted 2,283 -- the real dat carries 11 RenderSurfaces that no
# portal SurfaceTexture chain names (see EXTRA_UNNAMED_IDS).
FINGERPRINT_BYTES = 133169152
FINGERPRINT_SHA256 = ("503e0828d14f2f9ccbc31431e1055ac1"
                      "88464bf4b499de37f4c3d5b2d9f3e727")
FINGERPRINT_IDS = 2294
FINGERPRINT_RECORDS = 2295            # + the 0xFFFF0001 iteration entry
PREDICTED_IDS = 2283                  # the inventory report's model

# RenderSurfaces present in the real client_highres.dat that no portal
# SurfaceTexture chain names.  10 of them are the 2x mip of `id + 1` (retail's
# own sibling convention); 0x060043EC is 512x512 DXT1 over a 512x512 DXT5
# portal record, i.e. 1:1 with a format change.
EXTRA_UNNAMED_IDS = (
    0x06003E0A, 0x06003E0C, 0x060043EC, 0x060045B3, 0x06005093, 0x06005095,
    0x06005097, 0x06005692, 0x06005694, 0x06005696, 0x06005698,
)

# ACE.Entity.Enum.SurfacePixelFormat (authoritative; note PFID_CUSTOM_RAW_JPEG
# is 500, not the 1000 in texture_lane.py's PF table).
PF_R8G8B8, PF_A8R8G8B8, PF_R5G6B5, PF_A4R4G4B4, PF_A8 = 20, 21, 23, 26, 28
PF_P8, PF_INDEX16 = 41, 101
PF_LSCAPE_RGB, PF_LSCAPE_ALPHA = 243, 244
PF_RAW_JPEG = 500
PF_DXT1, PF_DXT3, PF_DXT5 = 827611204, 861165636, 894720068

PALETTED = {PF_P8, PF_INDEX16}
DXT_BLOCK_BYTES = {PF_DXT1: 8, PF_DXT3: 16, PF_DXT5: 16}
BYTES_PER_PIXEL = {
    PF_R8G8B8: 3, PF_A8R8G8B8: 4, PF_R5G6B5: 2, PF_A4R4G4B4: 2, PF_A8: 1,
    PF_P8: 1, PF_INDEX16: 2, PF_LSCAPE_RGB: 3, PF_LSCAPE_ALPHA: 1,
}
PF_NAME = {
    PF_R8G8B8: "R8G8B8", PF_A8R8G8B8: "A8R8G8B8", PF_R5G6B5: "R5G6B5",
    PF_A4R4G4B4: "A4R4G4B4", PF_A8: "A8", PF_P8: "P8", PF_INDEX16: "INDEX16",
    PF_LSCAPE_RGB: "CUSTOM_LSCAPE_R8G8B8", PF_LSCAPE_ALPHA: "CUSTOM_LSCAPE_ALPHA",
    PF_RAW_JPEG: "CUSTOM_RAW_JPEG", PF_DXT1: "DXT1", PF_DXT3: "DXT3",
    PF_DXT5: "DXT5",
}

PROTECTED_PREFIXES = (
    os.path.expanduser("~/ac_base_dats"),
    "/mnt/wbterminal2/dat-patch-r7/export",
    "/mnt/wbterminal2/dat-patch-r7/ace-r7-dats",
    # the acquired EoR source dat -- read-only, never a write target
    "/mnt/wbterminal2/highres-acquisition",
)


# A record in the real client_highres.dat averages ~58 chained 1 KiB blocks,
# and the b-tree order is not the on-disk order, so walking all 2,294 records
# through datlib's seek-per-block reader is ~130k random 1 KiB reads -- ~10
# minutes on the external spinning drive the dat lives on.  One sequential
# read of the whole 127 MiB file is ~1-20 s.  Files above this bound (the
# 927 MiB portal) keep the normal streaming path.
PRELOAD_MAX = 256 << 20


def open_dat(path, preload=None):
    """datlib.Dat over `path`, optionally backed by one sequential slurp.

    Constructs the Dat without datlib.Dat.__init__ so the file object can be
    swapped for an in-memory buffer; read_raw/_read_dir/get are reused
    unchanged, so the parse is byte-for-byte the same code path.
    """
    import io
    import datlib
    size = os.path.getsize(path)
    if preload is None:
        preload = size <= PRELOAD_MAX
    d = datlib.Dat.__new__(datlib.Dat)
    if preload:
        with open(path, "rb") as fh:
            d.f = io.BytesIO(fh.read())
    else:
        d.f = open(path, "rb")
    d.f.seek(0x140)
    h = struct.unpack("<13I", d.f.read(52))
    d.filetype, d.blocksize, d.filesize, d.dataset, d.subset = h[:5]
    d.freehead, d.freetail, d.freecount, d.btree = h[5:9]
    d.files = {}
    d.flags = {}
    d._read_dir(d.btree)
    return d


def guard_write(path):
    real = os.path.abspath(path)
    for p in PROTECTED_PREFIXES:
        if real.startswith(os.path.abspath(p) + os.sep) or real == os.path.abspath(p):
            raise SystemExit("REFUSING to write inside protected tree %s: %s" % (p, real))
    return real


# --------------------------------------------------- RenderSurface record IO
def rs_expected_length(fmt, w, h):
    """Byte length of SourceData for (fmt, w, h)."""
    if fmt in DXT_BLOCK_BYTES:
        return max(1, (w + 3) // 4) * max(1, (h + 3) // 4) * DXT_BLOCK_BYTES[fmt]
    if fmt in BYTES_PER_PIXEL:
        return w * h * BYTES_PER_PIXEL[fmt]
    raise ValueError("no size rule for PixelFormat %d" % fmt)


def parse_rs(raw):
    """Parse a RenderSurface (0x06) record body.  Layout per ACE
    DatLoader/FileTypes/Texture.cs:Unpack + DRW dats.xml: Id, DataCategory,
    Width, Height, PixelFormat, Length, SourceData, and -- iff the format is
    P8/INDEX16 -- a trailing u32 DefaultPaletteId."""
    if raw is None or len(raw) < 24:
        return None
    oid, dcat, w, h, fmt, dlen = struct.unpack_from("<6I", raw, 0)
    if 24 + dlen > len(raw):
        raise ValueError("0x%08X truncated: len=%d record=%d" % (oid, dlen, len(raw)))
    data = raw[24:24 + dlen]
    pal = None
    if fmt in PALETTED:
        if 24 + dlen + 4 > len(raw):
            raise ValueError("0x%08X paletted but no DefaultPaletteId" % oid)
        (pal,) = struct.unpack_from("<I", raw, 24 + dlen)
    return dict(id=oid, dcat=dcat, w=w, h=h, fmt=fmt, dlen=dlen, data=data,
                palette=pal, tail=len(raw) - 24 - dlen - (4 if pal is not None else 0))


def build_rs(oid, dcat, w, h, fmt, data, palette=None):
    out = struct.pack("<6I", oid, dcat, w, h, fmt, len(data)) + data
    if fmt in PALETTED:
        if palette is None:
            raise ValueError("0x%08X paletted record needs a DefaultPaletteId" % oid)
        out += struct.pack("<I", palette)
    return out


# ------------------------------------------------------------ 2x upscalers
def _np():
    import numpy as np
    return np


def upscale_raw2(data, w, h, bpp):
    """2x nearest on raw pixel bytes."""
    np = _np()
    a = np.frombuffer(data, np.uint8)[:w * h * bpp].reshape(h, w, bpp)
    return np.repeat(np.repeat(a, 2, axis=0), 2, axis=1).tobytes()


def _unpack_bits(arr, nbits, count):
    """arr: (N, nbytes) uint8 -> (N, count) ints, `nbits` per value, LSB-first
    across the byte run (the D3D/DXT texel-index convention)."""
    np = _np()
    n = arr.shape[0]
    bits = np.unpackbits(arr, axis=1, bitorder="little")     # (N, nbytes*8)
    idx = np.arange(count) * nbits
    out = np.zeros((n, count), np.uint16)
    for b in range(nbits):
        out |= bits[:, idx + b].astype(np.uint16) << b
    return out


def _pack_bits(vals, nbits, nbytes):
    """(N, count) ints -> (N, nbytes) uint8, LSB-first."""
    np = _np()
    n, count = vals.shape
    bits = np.zeros((n, nbytes * 8), np.uint8)
    idx = np.arange(count) * nbits
    for b in range(nbits):
        bits[:, idx + b] = (vals >> b) & 1
    return np.packbits(bits, axis=1, bitorder="little")


def _quadrant_indices(src, bh, bw, bh2, bw2):
    """src: (bh, bw, 4, 4) texel indices -> (bh2, bw2, 4, 4) for a 2x nearest
    upscale.  Output block (BX,BY) covers output texels (4BX+c, 4BY+r), whose
    source texel is (2BX + c//2, 2BY + r//2); relative to source block
    (BX//2, BY//2) that is local (2*(BX%2) + c//2, 2*(BY%2) + r//2)."""
    np = _np()
    full = src.transpose(0, 2, 1, 3).reshape(bh * 4, bw * 4)     # (H_pad, W_pad)
    big = np.repeat(np.repeat(full, 2, axis=0), 2, axis=1)       # nearest 2x
    need_h, need_w = bh2 * 4, bw2 * 4
    if big.shape[0] < need_h or big.shape[1] < need_w:
        pad = np.zeros((need_h, need_w), big.dtype)
        pad[:big.shape[0], :big.shape[1]] = big[:need_h, :need_w]
        big = pad
    big = big[:need_h, :need_w]
    return big.reshape(bh2, 4, bw2, 4).transpose(0, 2, 1, 3)


def upscale_dxt2(data, w, h, fmt):
    """Exact 2x nearest upscale of DXT1/DXT3/DXT5 blocks, in compressed space.

    Endpoints are reused verbatim (so DXT1's colour0<=colour1 1-bit-alpha mode
    is preserved); only the texel index grid is nearest-doubled.  DXT3's
    4-bit-per-texel explicit alpha and DXT5's 3-bit alpha index grid get the
    same treatment."""
    np = _np()
    bb = DXT_BLOCK_BYTES[fmt]
    bw, bh = max(1, (w + 3) // 4), max(1, (h + 3) // 4)
    w2, h2 = w * 2, h * 2
    bw2, bh2 = max(1, (w2 + 3) // 4), max(1, (h2 + 3) // 4)
    blocks = np.frombuffer(data, np.uint8)[:bh * bw * bb].reshape(bh, bw, bb)

    # block-grid nearest 2x for the endpoint halves
    def grow_blockwise(x):
        g = np.repeat(np.repeat(x, 2, axis=0), 2, axis=1)
        out = np.zeros((bh2, bw2) + x.shape[2:], x.dtype)
        out[:min(bh2, g.shape[0]), :min(bw2, g.shape[1])] = \
            g[:bh2, :bw2]
        return out

    colour_off = bb - 8                        # 0 for DXT1, 8 for DXT3/DXT5
    out = np.zeros((bh2, bw2, bb), np.uint8)

    # --- colour half: 4 bytes endpoints + 4 bytes of 2-bit indices
    out[:, :, colour_off:colour_off + 4] = grow_blockwise(blocks[:, :, colour_off:colour_off + 4])
    cidx = _unpack_bits(blocks[:, :, colour_off + 4:colour_off + 8].reshape(-1, 4), 2, 16)
    cidx = cidx.reshape(bh, bw, 4, 4)
    cidx2 = _quadrant_indices(cidx, bh, bw, bh2, bw2)
    out[:, :, colour_off + 4:colour_off + 8] = \
        _pack_bits(cidx2.reshape(-1, 16), 2, 4).reshape(bh2, bw2, 4)

    if fmt == PF_DXT5:
        out[:, :, 0:2] = grow_blockwise(blocks[:, :, 0:2])      # a0, a1
        aidx = _unpack_bits(blocks[:, :, 2:8].reshape(-1, 6), 3, 16).reshape(bh, bw, 4, 4)
        aidx2 = _quadrant_indices(aidx, bh, bw, bh2, bw2)
        out[:, :, 2:8] = _pack_bits(aidx2.reshape(-1, 16), 3, 6).reshape(bh2, bw2, 6)
    elif fmt == PF_DXT3:
        aidx = _unpack_bits(blocks[:, :, 0:8].reshape(-1, 8), 4, 16).reshape(bh, bw, 4, 4)
        aidx2 = _quadrant_indices(aidx, bh, bw, bh2, bw2)
        out[:, :, 0:8] = _pack_bits(aidx2.reshape(-1, 16), 4, 8).reshape(bh2, bw2, 8)
    return out.tobytes()


def upscale2(data, w, h, fmt):
    """2x nearest upscale of a RenderSurface SourceData payload, in-format."""
    if fmt in DXT_BLOCK_BYTES:
        return upscale_dxt2(data, w, h, fmt)
    if fmt in BYTES_PER_PIXEL:
        return upscale_raw2(data, w, h, BYTES_PER_PIXEL[fmt])
    raise ValueError("cannot upscale PixelFormat %d (%s)"
                     % (fmt, PF_NAME.get(fmt, "?")))


# ---------------------------------------------------------------- dat writer
class DatWriter:
    """Streaming writer for a retail-reader-conformant dat.

    Records are appended one at a time (nothing is kept but a 24-byte
    directory tuple each); the b-tree is bulk-loaded and written at close().
    Block 0 holds the header; every other block is `u32 nextBlock` +
    (blockSize-4) payload bytes, terminated by nextBlock == 0 -- the layout
    datlib.Dat.read_raw / walk_check.py read back.
    """
    NODE_BRANCHES = 62
    NODE_MAX_ENTRIES = 61
    NODE_SIZE = 4 * 62 + 4 + 24 * 61          # 1716

    def __init__(self, path, dataset=DATASET_PORTAL, subset=SUBSET_HIFI,
                 block_size=BLOCK_SIZE, engine_version=110, game_version=0,
                 version_major=b"", version_minor=0, master_map_id=0):
        self.path = path
        self.bs = block_size
        self.dataset = dataset
        self.subset = subset
        self.engine_version = engine_version
        self.game_version = game_version
        self.version_major = (version_major + b"\0" * 16)[:16]
        self.version_minor = version_minor
        self.master_map_id = master_map_id
        self.f = open(path, "wb+")
        self.f.write(b"\0" * self.bs)          # block 0 = header block
        self.next_block = self.bs
        self.entries = []                      # (oid, flags, offset, size, date, iteration)

    # -- block plumbing -----------------------------------------------------
    def _write_chain(self, payload):
        bs, cap = self.bs, self.bs - 4
        nblocks = max(1, (len(payload) + cap - 1) // cap)
        start = self.next_block
        self.f.seek(start)
        for i in range(nblocks):
            nxt = 0 if i == nblocks - 1 else start + (i + 1) * bs
            chunk = payload[i * cap:(i + 1) * cap]
            self.f.write(struct.pack("<I", nxt))
            self.f.write(chunk)
            if len(chunk) < cap:
                self.f.write(b"\0" * (cap - len(chunk)))
        self.next_block = start + nblocks * bs
        return start

    def add(self, oid, payload, flags=0x20000, date=0, iteration=1):
        off = self._write_chain(payload)
        self.entries.append((oid, flags, off, len(payload), date, iteration))
        return off

    # -- b-tree -------------------------------------------------------------
    def _write_node(self, ents, children):
        node = bytearray(self.NODE_SIZE)
        if children:
            for i, c in enumerate(children):
                struct.pack_into("<I", node, i * 4, c)
        struct.pack_into("<I", node, 62 * 4, len(ents))
        base = 62 * 4 + 4
        for i, e in enumerate(ents):
            oid, flags, off, size, date, itr = e
            struct.pack_into("<6I", node, base + i * 24, flags, oid, off, size, date, itr)
        return self._write_chain(bytes(node))

    def _build_btree(self):
        ents = sorted(self.entries, key=lambda e: e[0])
        if len(ents) != len({e[0] for e in ents}):
            raise ValueError("duplicate ids in directory")
        children = None
        cap = self.NODE_MAX_ENTRIES
        while True:
            if len(ents) <= cap:
                return self._write_node(ents, children)
            nodes, seps = [], []
            i, n = 0, len(ents)
            while i < n:
                take = min(cap, n - i)
                if n - i - take == 1:          # never leave a dangling separator
                    take -= 1
                grp = ents[i:i + take]
                ch = children[i:i + take + 1] if children else None
                nodes.append(self._write_node(grp, ch))
                i += take
                if i < n:
                    seps.append(ents[i])
                    i += 1
            assert len(nodes) == len(seps) + 1, (len(nodes), len(seps))
            ents, children = seps, nodes

    # -- close --------------------------------------------------------------
    def close(self):
        root = self._build_btree()
        file_size = self.next_block
        self.f.seek(0)
        self.f.write(b"\0" * self.bs)
        # 0x100: the 4-byte marker every retail dat and every WBT-made highres
        # stub carries ahead of the header proper.
        self.f.seek(0x100)
        self.f.write(bytes([0x00, 0x50, 0x4C, 0x00]))
        # DatDatabaseHeader (ACE DatLoader/DatDatabaseHeader.cs = client
        # DiskFileInfo_t) @0x140.  Free list empty and parked at EOF -- the
        # DatExportFixer.PatchFreeBlocksBeforeExport convention; the retail
        # READ path never consults these fields.
        hdr = struct.pack(
            "<13I", DAT_MAGIC, self.bs, file_size, self.dataset, self.subset,
            file_size, file_size, 0, root, 0, 0, 0, self.master_map_id)
        hdr += struct.pack("<2I", self.engine_version, self.game_version)
        hdr += self.version_major
        hdr += struct.pack("<I", self.version_minor)
        self.f.seek(0x140)
        self.f.write(hdr)
        self.f.flush()
        os.fsync(self.f.fileno())
        self.f.close()
        return dict(root=root, file_size=file_size, records=len(self.entries))


def synth_fill(oid, fmt, w, h, palette_colors=None):
    """Deterministic synthetic SourceData of exactly the right length, for the
    handful of records the portal cannot source (no sibling, a format change,
    or a non-power-of-two size ratio).  Seeded by id, so a rebuilt fixture is
    byte-identical."""
    import numpy as np
    n = rs_expected_length(fmt, w, h)
    if fmt in PALETTED:
        ncol = len(palette_colors) if palette_colors else 256
        yy, xx = np.mgrid[0:h, 0:w]
        idx = ((xx + yy + (oid & 0xFF)) % max(1, ncol)).astype(np.int64)
        return (idx.astype("<u2") if fmt == PF_INDEX16
                else idx.astype(np.uint8)).tobytes()[:n]
    rng = np.random.default_rng(oid)
    return rng.integers(0, 256, n, dtype=np.uint8).tobytes()


def load_header_table(path):
    """Real-dat header table (from `synth_highres.py headers`) -> {id: dict}."""
    with open(path) as fh:
        doc = json.load(fh)
    recs = doc.get("records", doc)
    return {int(k, 16): v for k, v in recs.items()}


def cmd_headers(args):
    """Emit the per-record header table of a REAL client_highres.dat.

    ~200 KB of JSON that pins the real file's exact id set, dimensions,
    formats, data categories and default palettes -- small enough to keep in
    the repo, so `build --headers` can regenerate a shape-exact fixture on a
    machine that does not have the 127 MiB dat."""
    d = open_dat(args.dat)
    recs = {}
    for oid in sorted(i for i in d.files if i >> 24 == 0x06):
        r = parse_rs(d.get(oid))
        recs["0x%08X" % oid] = dict(w=r["w"], h=r["h"], fmt=r["fmt"],
                                    dcat=r["dcat"], pal=r["palette"],
                                    dlen=r["dlen"])
    itr = d.get(ITERATION_ID)
    doc = dict(source=os.path.abspath(args.dat),
               file_size=os.path.getsize(args.dat),
               dataset=d.dataset, subset="0x%08X" % d.subset,
               block_size=d.blocksize, record_count=len(d.files),
               iteration_record=(itr.hex() if itr else None),
               records=recs)
    with open(guard_write(args.out), "w") as fh:
        json.dump(doc, fh, indent=0)
    print("headers -> %s (%d records, %d bytes)"
          % (args.out, len(recs), os.path.getsize(args.out)))
    return 0


# ------------------------------------------------------------- lane id table
def load_chain_table(audit_path):
    """From the F1 degrade audit -> {highres_id: {sibling, lane, st, cls,
    r7_dim}}.

    `highres-only-absent` entries are highres ids the r7 chain STILL names;
    `dropped_from_retail` are the ones our importer collapsed away (the
    bake-both lane set).  Their union is the 2,283 distinct ids; the 1,342
    dropped ones are the r7.1 lane.
    """
    with open(audit_path) as fh:
        aud = json.load(fh)
    table = {}
    for st in aud["surface_textures"]:
        chain = [int(x, 16) for x in st["retail_chain"]]
        r7dims = {int(e["id"], 16): e.get("r7_dim") for e in st["entries"]}
        absent = [int(e["id"], 16) for e in st["entries"]
                  if e["status"] == "highres-only-absent"]
        dropped = [int(x, 16) for x in st["dropped_from_retail"]]
        for hid in set(absent) | set(dropped):
            sibs = [c for c in chain if c != hid]
            if not sibs:
                continue
            rec = table.setdefault(hid, dict(id=hid, sibling=sibs[0], lane=False,
                                             st=[], cls=st["cls"], r7_dim=None))
            rec["st"].append(st["st"])
            if hid in dropped:
                rec["lane"] = True
            rd = r7dims.get(sibs[0])
            if rd:
                rec["r7_dim"] = rd
    return table


# ------------------------------------------------------------------- build
def cmd_build(args):
    out = guard_write(args.out)
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)

    table = load_chain_table(args.audit)
    heads = load_header_table(args.headers) if args.headers else None
    ids = sorted(heads) if heads else sorted(table)
    if args.limit:
        ids = ids[:args.limit]
    print("chain table: %d distinct highres ids (%d in the r7.1 lane)"
          % (len(table), sum(1 for v in table.values() if v["lane"])))
    if heads:
        print("header table: %d ids -- fixture will be SHAPE-EXACT to the real dat"
              % len(heads))

    portal = open_dat(args.portal)
    # b-tree entry bitflags / date / iteration are carried through from the
    # portal sibling so the synthetic directory looks like retail's.  The flag
    # values retail uses (0x20000 / 0x30000 for content, 0x10000 for the
    # iteration entry) are exactly the set trevis' survey saw on a real
    # client_highres.dat.
    raw_dir = _raw_directory(args.portal)

    w = DatWriter(out)
    # iteration record, mirrored from the portal's own 0xFFFF0001
    itr_body = portal.get(ITERATION_ID)
    if itr_body:
        fl, _off, _sz, dt, it = raw_dir[ITERATION_ID]
        w.add(ITERATION_ID, itr_body, flags=fl, date=dt, iteration=it)

    manifest, fmt_hist, dim_hist, src_bytes, out_bytes = [], {}, {}, 0, 0
    n_synth = 0
    for hid in ids:
        rec = table.get(hid, dict(sibling=None, lane=False, cls=None, st=[],
                                  r7_dim=None))
        # retail's own convention: the portal sibling of a highres id is
        # id+1 in 2,254 of the 2,284 two-entry chains (F1 audit).  For ids no
        # SurfaceTexture names -- the 11 the real dat carries -- that is the
        # only handle we have, and it holds for 10 of them.
        sib = rec["sibling"] or (hid + 1)
        src = parse_rs(portal.get(sib))
        if heads is None:
            if src is None:
                raise SystemExit("portal sibling 0x%08X of 0x%08X missing" % (sib, hid))
            tw, th, tfmt = src["w"] * 2, src["h"] * 2, src["fmt"]
            tdcat, tpal = src["dcat"], src["palette"]
        else:
            hd = heads[hid]
            tw, th, tfmt, tdcat, tpal = hd["w"], hd["h"], hd["fmt"], hd["dcat"], hd["pal"]

        data, how = None, None
        if src is not None and src["fmt"] == tfmt and src["w"] and src["h"]:
            k = tw // src["w"]
            if k >= 1 and k & (k - 1) == 0 and th == src["h"] * k:
                data, cw, ch = src["data"], src["w"], src["h"]
                while (cw, ch) != (tw, th):
                    data = upscale2(data, cw, ch, tfmt)
                    cw, ch = cw * 2, ch * 2
                how = "portal-nearest-%dx" % k
                src_bytes += src["dlen"]
        if data is None:
            colors = None
            if tfmt in PALETTED and tpal:
                try:
                    import pallib
                    colors = pallib.palette_colors(portal, tpal)
                except Exception:                                 # noqa: BLE001
                    colors = None
            data = synth_fill(hid, tfmt, tw, th, colors)
            how = "synthetic-fill"
            n_synth += 1
        got = rs_expected_length(tfmt, tw, th)
        if len(data) != got:
            raise SystemExit("0x%08X produced %d bytes, expected %d"
                             % (hid, len(data), got))
        body = build_rs(hid, tdcat, tw, th, tfmt, data, palette=tpal)
        fl, _o, _s, dt, it = raw_dir.get(sib, (0x20000, 0, 0, 0, 1))
        w.add(hid, body, flags=fl, date=dt, iteration=it)
        out_bytes += len(body)
        fmt_hist[tfmt] = fmt_hist.get(tfmt, 0) + 1
        key = ("%dx%d -> %dx%d" % (src["w"], src["h"], tw, th) if src
               else "(no sibling) -> %dx%d" % (tw, th))
        dim_hist[key] = dim_hist.get(key, 0) + 1
        manifest.append(dict(
            id="0x%08X" % hid, sibling="0x%08X" % sib, lane=rec["lane"],
            cls=rec["cls"], st=rec["st"], fmt=tfmt, source=how,
            fmt_name=PF_NAME.get(tfmt, "0x%08X" % tfmt),
            portal_dim=("%dx%d" % (src["w"], src["h"]) if src else None),
            highres_dim="%dx%d" % (tw, th),
            r7_dim=rec["r7_dim"],
            palette=(None if tpal is None else "0x%08X" % tpal),
            data_category=tdcat, record_bytes=len(body)))
    info = w.close()
    if n_synth:
        print("%d record(s) filled synthetically (no usable portal source)" % n_synth)

    lane = [m for m in manifest if m["lane"]]
    exceeds = [m for m in lane if m["r7_dim"] and
               _dim_ge(m["highres_dim"], m["r7_dim"])]
    out_stat = os.path.getsize(out)
    summary = dict(
        tool="tools/dat-patch/synth_highres.py", generated_from=args.audit,
        portal=args.portal, out=out,
        records=info["records"], render_surfaces=len(manifest),
        lane_records=len(lane), passthrough_records=len(exceeds),
        file_size=out_stat, btree_root=info["root"],
        fingerprint=dict(expected_bytes=FINGERPRINT_BYTES,
                         expected_ids=FINGERPRINT_IDS,
                         delta_bytes=out_stat - FINGERPRINT_BYTES,
                         delta_pct=round(100.0 * (out_stat - FINGERPRINT_BYTES)
                                         / FINGERPRINT_BYTES, 2),
                         id_count_match=(len(manifest) == FINGERPRINT_IDS)),
        source_bytes=src_bytes, payload_bytes=out_bytes,
        formats={PF_NAME.get(k, str(k)): v for k, v in
                 sorted(fmt_hist.items(), key=lambda kv: -kv[1])},
        dim_transitions=dict(sorted(dim_hist.items(), key=lambda kv: -kv[1])))
    if args.manifest:
        mpath = guard_write(args.manifest)
        with open(mpath, "w") as fh:
            json.dump(dict(summary=summary, records=manifest), fh, indent=1)
        print("manifest -> %s" % mpath)
    print(json.dumps(summary, indent=1))
    return 0


def _dim_ge(a, b):
    aw, ah = (int(x) for x in a.split("x"))
    bw, bh = (int(x) for x in b.split("x"))
    return aw >= bw and ah >= bh


def _raw_directory(path):
    """Full b-tree walk keeping the entry bitflags/date/iteration datlib drops.
    -> {id: (flags, offset, size, date, iteration)}"""
    f = open(path, "rb")
    f.seek(0x140)
    h = struct.unpack("<13I", f.read(52))
    bs, root = h[1], h[8]
    objsize = 4 * 62 + 4 + 24 * 61
    out = {}

    def read_raw(off, size):
        buf = bytearray()
        f.seek(off)
        nxt = struct.unpack("<I", f.read(4))[0]
        rem = size
        while rem > 0:
            if nxt == 0:
                buf += f.read(rem)
                rem = 0
            else:
                buf += f.read(bs - 4)
                f.seek(nxt)
                nxt = struct.unpack("<I", f.read(4))[0]
                rem -= bs - 4
        return bytes(buf[:size])

    stack = [root]
    while stack:
        off = stack.pop()
        b = read_raw(off, objsize)
        br = struct.unpack_from("<62I", b, 0)
        cnt = struct.unpack_from("<I", b, 62 * 4)[0]
        base = 62 * 4 + 4
        for i in range(cnt):
            fl, oid, fo, fs, dt, it = struct.unpack_from("<6I", b, base + i * 24)
            out[oid] = (fl, fo, fs, dt, it)
        if br[0] != 0:
            stack.extend(br[i] for i in range(cnt + 1))
    f.close()
    return out


# ------------------------------------------------------------------ verify
def cmd_verify(args):
    d = open_dat(args.dat)
    size = os.path.getsize(args.dat)
    errs, warns = [], []
    print("== header ==")
    print("  filetype=0x%08X blocksize=%d fileSize=%d (actual %d)"
          % (d.filetype, d.blocksize, d.filesize, size))
    print("  dataset=%d subset=0x%08X btree=0x%X records=%d"
          % (d.dataset, d.subset, d.btree, len(d.files)))
    if d.filetype != DAT_MAGIC:
        errs.append("filetype 0x%08X != 0x%08X" % (d.filetype, DAT_MAGIC))
    if d.dataset != DATASET_PORTAL:
        errs.append("dataset %d != 1 (PORTAL_DATFILE)" % d.dataset)
    if d.subset != SUBSET_HIFI:
        errs.append("subset 0x%08X != 0x%08X ('HiFi')" % (d.subset, SUBSET_HIFI))
    if d.btree == 0:
        errs.append("btree root is 0 (empty stub)")
    if d.filesize != size:
        errs.append("header fileSize %d != actual %d" % (d.filesize, size))
    if size == FINGERPRINT_BYTES:
        import hashlib
        hsh = hashlib.sha256()
        with open(args.dat, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 22), b""):
                hsh.update(chunk)
        got = hsh.hexdigest()
        print("  size matches the EoR fingerprint; sha256 %s (%s)"
              % (got, "MATCH" if got == FINGERPRINT_SHA256 else "DIFFERENT BUILD"))

    rs = [i for i in d.files if i >> 24 == 0x06]
    other = [i for i in d.files if i >> 24 != 0x06 and i != ITERATION_ID]
    print("== inventory ==")
    print("  RenderSurface(0x06) = %d, iteration entry = %s, other = %d"
          % (len(rs), ITERATION_ID in d.files, len(other)))
    if other:
        warns.append("%d non-RenderSurface, non-iteration records "
                     "(a real client_highres.dat has none)" % len(other))
    if len(rs) != FINGERPRINT_IDS:
        warns.append("RenderSurface count %d != fingerprint %d"
                     % (len(rs), FINGERPRINT_IDS))
    print("  fileSize vs fingerprint %d: %+d bytes (%+.2f%%)"
          % (FINGERPRINT_BYTES, size - FINGERPRINT_BYTES,
             100.0 * (size - FINGERPRINT_BYTES) / FINGERPRINT_BYTES))

    print("== per-record parse ==")
    fmts, bad = {}, 0
    portal = open_dat(args.portal) if args.portal else None
    dim_bad = []
    for oid in sorted(rs):
        try:
            r = parse_rs(d.get(oid))
        except ValueError as e:
            errs.append(str(e))
            bad += 1
            continue
        if r["id"] != oid:
            errs.append("0x%08X id echo = 0x%08X" % (oid, r["id"]))
        if r["tail"] != 0:
            errs.append("0x%08X %d trailing bytes" % (oid, r["tail"]))
        exp = rs_expected_length(r["fmt"], r["w"], r["h"])
        if exp != r["dlen"]:
            errs.append("0x%08X len %d != %d for %dx%d %s"
                        % (oid, r["dlen"], exp, r["w"], r["h"],
                           PF_NAME.get(r["fmt"], r["fmt"])))
        if (r["fmt"] in PALETTED) != (r["palette"] is not None):
            errs.append("0x%08X palette-trailer/format mismatch" % oid)
        fmts[PF_NAME.get(r["fmt"], str(r["fmt"]))] = \
            fmts.get(PF_NAME.get(r["fmt"], str(r["fmt"])), 0) + 1
        if portal and args.manifest:
            pass
    print("  formats:", dict(sorted(fmts.items(), key=lambda kv: -kv[1])))

    if args.manifest:
        with open(args.manifest) as fh:
            man = json.load(fh)["records"]
        print("== manifest cross-check (dims/format per id) ==")
        for m in man:
            oid = int(m["id"], 16)
            if oid not in d.files:
                errs.append("%s in manifest but absent from dat" % m["id"])
                continue
            r = parse_rs(d.get(oid))
            if "%dx%d" % (r["w"], r["h"]) != m["highres_dim"]:
                dim_bad.append((m["id"], "%dx%d" % (r["w"], r["h"]), m["highres_dim"]))
            if r["fmt"] != m["fmt"]:
                errs.append("%s format %d != manifest %d" % (m["id"], r["fmt"], m["fmt"]))
        if dim_bad:
            errs.append("%d dim mismatches vs manifest, e.g. %s"
                        % (len(dim_bad), dim_bad[:3]))
        print("  %d manifest records checked, %d dim mismatches"
              % (len(man), len(dim_bad)))

    if portal:
        # Informational, NOT an error: the real dat itself breaks the 2x model
        # on 13 ids (11 are 1:1 with their portal sibling, one is 4x, one is
        # 16x/8x) and changes pixel format on 2, so a deviation here is a
        # finding about the content, not a defect in the file.
        print("== 2x-of-portal-sibling model ==")
        n_ok = n_skip = 0
        dev = []
        tbl = load_chain_table(args.audit) if args.audit else {}
        for oid in sorted(rs):
            sib = tbl.get(oid, {}).get("sibling")
            if sib is None:
                n_skip += 1
                continue
            p = parse_rs(portal.get(sib))
            r = parse_rs(d.get(oid))
            if p and (r["w"], r["h"]) == (p["w"] * 2, p["h"] * 2) and r["fmt"] == p["fmt"]:
                n_ok += 1
            else:
                dev.append("0x%08X (sibling 0x%08X)" % (oid, sib))
        print("  %d records are exactly 2x + same format; %d deviate; %d unmapped"
              % (n_ok, len(dev), n_skip))
        for x in dev[:15]:
            print("    dev " + x)

    print("== VERDICT: %s ==" % ("FAIL" if errs else "OK"))
    for e in errs[:20]:
        print("  ERR " + e)
    for wv in warns:
        print("  WARN " + wv)
    return 1 if errs else 0


# ------------------------------------------------------------------ survey
def cmd_survey(args):
    """Calibrate a REAL client_highres.dat against the model this tool
    synthesizes from (inventory report S4b: 'every record is 2x its portal
    sibling, same pixel format').  Reports every place the real file differs."""
    d = open_dat(args.dat)
    size = os.path.getsize(args.dat)
    table = load_chain_table(args.audit)
    portal = open_dat(args.portal)

    rs = sorted(i for i in d.files if i >> 24 == 0x06)
    other = sorted(i for i in d.files if i >> 24 != 0x06)
    named = set(table)
    extra = sorted(set(rs) - named)
    missing = sorted(named - set(rs))

    out = dict(
        dat=args.dat, file_size=size,
        header=dict(filetype="0x%08X" % d.filetype, block_size=d.blocksize,
                    header_file_size=d.filesize, dataset=d.dataset,
                    subset="0x%08X" % d.subset, btree="0x%X" % d.btree,
                    free_count=d.freecount),
        records=len(d.files), render_surfaces=len(rs),
        non_rendersurface=["0x%08X" % i for i in other],
        vs_inventory_report=dict(
            predicted_bytes=FINGERPRINT_BYTES, actual_bytes=size,
            predicted_ids=PREDICTED_IDS, actual_ids=len(rs),
            ids_not_named_by_any_portal_surfacetexture=["0x%08X" % i for i in extra],
            named_but_absent_from_highres=["0x%08X" % i for i in missing]),
    )

    fmt, dims, parse_err, tails = {}, {}, [], {}
    hdr = {}
    for oid in rs:
        try:
            r = parse_rs(d.get(oid))
        except ValueError as e:
            parse_err.append(str(e))
            continue
        if r["id"] != oid:
            parse_err.append("0x%08X id echo 0x%08X" % (oid, r["id"]))
        exp = rs_expected_length(r["fmt"], r["w"], r["h"])
        if exp != r["dlen"]:
            parse_err.append("0x%08X declared len %d != computed %d (%dx%d %s)"
                             % (oid, r["dlen"], exp, r["w"], r["h"],
                                PF_NAME.get(r["fmt"], r["fmt"])))
        tails[r["tail"]] = tails.get(r["tail"], 0) + 1
        n = PF_NAME.get(r["fmt"], "0x%08X" % r["fmt"])
        fmt[n] = fmt.get(n, 0) + 1
        dims["%dx%d" % (r["w"], r["h"])] = dims.get("%dx%d" % (r["w"], r["h"]), 0) + 1
        hdr[oid] = r
    out["parse"] = dict(errors=parse_err, trailing_byte_hist=tails,
                        formats=dict(sorted(fmt.items(), key=lambda kv: -kv[1])),
                        dims=dict(sorted(dims.items(), key=lambda kv: -kv[1])[:15]))

    # the 2x + same-format model, per chain
    ratios, fmt_changes, not_2x, lane_bytes, lane_n = {}, [], [], 0, 0
    for oid in rs:
        rec = table.get(oid)
        if rec is None or oid not in hdr:
            continue
        p = parse_rs(portal.get(rec["sibling"]))
        if p is None:
            continue
        r = hdr[oid]
        key = "%s:%s" % (_ratio(p["w"], r["w"]), _ratio(p["h"], r["h"]))
        ratios[key] = ratios.get(key, 0) + 1
        if (r["w"], r["h"]) != (p["w"] * 2, p["h"] * 2):
            not_2x.append(dict(id="0x%08X" % oid, sibling="0x%08X" % rec["sibling"],
                               portal="%dx%d" % (p["w"], p["h"]),
                               highres="%dx%d" % (r["w"], r["h"]),
                               lane=rec["lane"]))
        if r["fmt"] != p["fmt"]:
            fmt_changes.append(dict(id="0x%08X" % oid, sibling="0x%08X" % rec["sibling"],
                                    portal_fmt=PF_NAME.get(p["fmt"], p["fmt"]),
                                    highres_fmt=PF_NAME.get(r["fmt"], r["fmt"]),
                                    lane=rec["lane"]))
        if rec["lane"]:
            lane_n += 1
            lane_bytes += r["dlen"]
    out["model_check"] = dict(
        dim_ratio_hist=dict(sorted(ratios.items(), key=lambda kv: -kv[1])),
        not_exactly_2x=not_2x, format_changes=fmt_changes,
        lane_records_present=lane_n, lane_source_bytes=lane_bytes)

    print(json.dumps(out, indent=1))
    if args.out:
        with open(guard_write(args.out), "w") as fh:
            json.dump(out, fh, indent=1)
        print("survey -> %s" % args.out)
    return 1 if parse_err else 0


def _ratio(a, b):
    if a == 0:
        return "?"
    if b % a == 0:
        return "%dx" % (b // a)
    if a % b == 0:
        return "1/%d" % (a // b)
    return "%d->%d" % (a, b)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="synthesize a client_highres.dat")
    b.add_argument("--out", required=True)
    b.add_argument("--portal", default=os.path.expanduser("~/ac_base_dats/client_portal.dat"))
    b.add_argument("--audit", default="/mnt/wbterminal2/dat-patch-r7/degrade-chain-audit.json")
    b.add_argument("--manifest", default=None)
    b.add_argument("--headers", default=None,
                   help="real-dat header table (from `headers`) -> shape-exact fixture")
    b.add_argument("--limit", type=int, default=0, help="only the first N ids (smoke test)")
    b.set_defaults(fn=cmd_build)

    v = sub.add_parser("verify", help="fingerprint + per-record validation")
    v.add_argument("--dat", required=True)
    v.add_argument("--manifest", default=None)
    v.add_argument("--portal", default=None)
    v.add_argument("--audit", default="/mnt/wbterminal2/dat-patch-r7/degrade-chain-audit.json")
    v.set_defaults(fn=cmd_verify)

    s = sub.add_parser("survey", help="calibrate a REAL highres dat vs the model")
    s.add_argument("--dat", required=True)
    s.add_argument("--portal", default=os.path.expanduser("~/ac_base_dats/client_portal.dat"))
    s.add_argument("--audit", default="/mnt/wbterminal2/dat-patch-r7/degrade-chain-audit.json")
    s.add_argument("--out", default=None)
    s.set_defaults(fn=cmd_survey)

    hh = sub.add_parser("headers", help="dump a real highres dat's header table")
    hh.add_argument("--dat", required=True)
    hh.add_argument("--out", required=True)
    hh.set_defaults(fn=cmd_headers)

    args = ap.parse_args()
    sys.exit(args.fn(args))


if __name__ == "__main__":
    main()

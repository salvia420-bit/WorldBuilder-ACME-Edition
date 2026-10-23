#!/usr/bin/env python3
"""HBG1 v2 `?negFace` face-marker census of a pack dist, read at rest.

2026-10-22 (handoff HANDOFF-gpu-resident-statics-2026-10-22 §5 F7(a); runbook
docs/HBG1-negface-marker-2026-10-22.md). `?negFace` is default ON, and the wasm
bundle assembly serves a model under it only when the model's 0x01 GEOM payload
is HBG1 v2 (face-marked). This walks the packs THE MANIFEST'S world_index names
(not every file under packs/ — the CAS deploy is additive, so stale packs from
older indexes sit beside the live ones) and counts, per DISTINCT model id:

  * 0x01 GEOM rows by HBG1 version (1 = pre-marker, 2 = face-marked);
  * v2 rows carrying a MODEL_BACKFACE (0x08) subset, a NOPOS_SLOT0 (0x10)
    subset, and the NEG_FRONT_COPY (0x0010) payload flag;
  * GEOMR (0x0C) 0x01 rows by version (must match their GEOM rows);
  * 0x02 / 0x0D rows by version (stay v1 by design).

Byte layouts: crates/holtburger-dat/src/hbg1.rs (payload/mesh headers, subset
rows, parse_geom_section) and apps/holtburger-tools/src/pack_format.rs (HBP1
section table, HBSI1 pack table). No wasm, no browser, read-only.

Usage (from anywhere):
  python3 scripts/hbg1_face_census.py <dist-or-bake-out-dir> [--limit N]
                                      [--require-v2] [--json]
                                      [--diff <other-bake-out-dir>]
  --require-v2   exit 1 when any 0x01 GEOM/GEOMR row is not v2 (the post-
                 rebake gate; a pre-v2 dist fails it by construction).
  --limit N      scan only the first N packs of the index (smoke run).
  --diff OTHER   ALSO compare this bake against OTHER pack by pack (index
                 ordinal i against ordinal i) and section by section, on the
                 STORED bytes (fixed zstd level, so equal content = equal
                 bytes). Reports which section kinds differ; exits 1 when
                 anything other than GEOM (0x09) / GEOMR (0x0C) differs, or
                 the pack tables disagree on count/kind — i.e. the rebake
                 moved more than the face marker. REFS (0x08) is the one
                 expected passenger (2026-10-23, first full v5-vs-v4 run:
                 17,029 packs): a REFS pack table names its targets by
                 CONTENT hash, so every pack whose GEOM changed renames and
                 every pack that references it re-hashes its REFS. A REFS
                 delta counts as cascade only when its records are equal and
                 every changed entry names the SAME index ordinal in both
                 bakes; anything else is drift.
"""
import json
import os
import struct
import subprocess
import sys

try:  # optional fast path; falls back to the zstd CLI like scripts/relief/
    import zstandard  # type: ignore
except Exception:  # pragma: no cover
    zstandard = None

HBP_HEADER = 32
SEC_ENTRY = 16
HBSI_HEADER = 24
HBSI_PACK_ENTRY = 24
GEOM, GEOMR = 0x09, 0x0C

PAYLOAD_HEADER_LEN = 16
SUBSET_ROW_LEN = 16
FLAG_BAKED_LIGHT = 1 << 0
FLAG_IDX_U32 = 1 << 2
FLAG_NEG_FRONT_COPY = 1 << 4
SUB_MODEL_BACKFACE = 1 << 3
SUB_NOPOS_SLOT0 = 1 << 4


def die(msg):
    print(f"[hbg1-face-census] {msg}", file=sys.stderr)
    sys.exit(2)


def index_packs(root):
    """-> [(path, pack_kind)] in index ordinal order."""
    m = json.load(open(os.path.join(root, "manifest.json")))
    wi = m.get("world_index")
    if not wi:
        die("manifest.json has no world_index (a pack-less dist)")
    b = open(os.path.join(root, wi["url"]), "rb").read()
    if b[:4] != b"HBSI":
        die("world index: bad magic")
    count = struct.unpack_from("<I", b, 8)[0]
    out = []
    for i in range(count):
        off = HBSI_HEADER + i * HBSI_PACK_ENTRY
        h = b[off:off + 16].hex()
        out.append((os.path.join(root, "packs", h[:2], h + ".hbp"), b[off + 20]))
    return out


def index_pack_paths(root):
    return [p for p, _k in index_packs(root)]


def stored_sections(path):
    """-> {section_kind: stored bytes} (no decompression)."""
    with open(path, "rb") as fh:
        secs = sections(fh)
        if secs is None:
            return None
        out = {}
        for k, (_codec, off, stored, _raw) in secs.items():
            fh.seek(off)
            out[k] = fh.read(stored)
        return out


def _refs_of(path):
    """-> (pack table [(hash16, kind)], record bytes) of a pack's REFS, or None."""
    with open(path, "rb") as fh:
        secs = sections(fh)
        ent = secs.get(0x08) if secs else None
        if ent is None:
            return None
        raw = read_section(fh, ent)
    n = raw[0]
    table = [(raw[1 + 17 * j:17 + 17 * j], raw[17 + 17 * j]) for j in range(n)]
    pos = 1 + 17 * n
    count = struct.unpack_from("<I", raw, pos)[0]
    return table, raw[pos + 4:pos + 4 + count * 6]


def _refs_cascade_only(pa, pb, ord_a, ord_b):
    """True when the two REFS differ only by renamed targets at the same ordinals."""
    ra, rb = _refs_of(pa), _refs_of(pb)
    if ra is None or rb is None or ra[1] != rb[1] or len(ra[0]) != len(rb[0]):
        return False
    for (ha, ka), (hb, kb) in zip(ra[0], rb[0]):
        if ka != kb:
            return False
        if ha != hb and (ord_a.get(ha) is None or ord_a.get(ha) != ord_b.get(hb)):
            return False
    return True


def diff_bakes(root, other, limit):
    """Section-level delta of `root` against `other` (module docs, --diff)."""
    a, b = index_packs(root), index_packs(other)
    d = {"packs": [len(a), len(b)], "identical": 0, "differ": 0,
         "kind_mismatch": 0, "sections_differ": {}, "refs_cascade": 0, "refs_drift": 0}
    h16 = lambda p: bytes.fromhex(os.path.basename(p)[:32])  # noqa: E731
    ord_a = {h16(p): i for i, (p, _k) in enumerate(a)}
    ord_b = {h16(p): i for i, (p, _k) in enumerate(b)}
    n = min(len(a), len(b)) if limit is None else min(len(a), len(b), limit)
    for i in range(n):
        (pa, ka), (pb, kb) = a[i], b[i]
        if ka != kb:
            d["kind_mismatch"] += 1
            continue
        if os.path.basename(pa) == os.path.basename(pb):
            d["identical"] += 1  # CAS: same name = same bytes
            continue
        d["differ"] += 1
        sa, sb = stored_sections(pa), stored_sections(pb)
        if sa is None or sb is None:
            d["sections_differ"]["unreadable"] = d["sections_differ"].get("unreadable", 0) + 1
            continue
        for k in sorted(set(sa) | set(sb)):
            if sa.get(k) != sb.get(k):
                key = f"0x{k:02X}"
                d["sections_differ"][key] = d["sections_differ"].get(key, 0) + 1
                if k == 0x08:
                    if _refs_cascade_only(pa, pb, ord_a, ord_b):
                        d["refs_cascade"] += 1
                    else:
                        d["refs_drift"] += 1
    beyond = {k: v for k, v in d["sections_differ"].items() if k not in ("0x08", "0x09", "0x0C")}
    d["only_geom"] = (not beyond and d["refs_drift"] == 0 and d["kind_mismatch"] == 0
                      and len(a) == len(b))
    return d


def sections(fh):
    head = fh.read(HBP_HEADER)
    if len(head) < HBP_HEADER or head[:4] != b"HBP1":
        return None
    nsec = struct.unpack_from("<H", head, 12)[0]
    nns = head[14]
    fh.seek(HBP_HEADER + nns * 32)
    tbl = fh.read(nsec * SEC_ENTRY)
    out = {}
    for i in range(nsec):
        k, codec, _pad, off, stored, raw = struct.unpack_from("<HBBIII", tbl, i * SEC_ENTRY)
        out[k] = (codec, off, stored, raw)
    return out


def read_section(fh, ent):
    codec, off, stored, raw = ent
    fh.seek(off)
    body = fh.read(stored)
    if codec == 0:
        return body
    if zstandard is not None:
        return zstandard.ZstdDecompressor().decompress(body, max_output_size=max(raw, 1))
    return subprocess.run(["zstd", "-d", "-c", "-q"], input=body,
                          stdout=subprocess.PIPE, check=True).stdout


def geom_rows(payload):
    n = struct.unpack_from("<I", payload, 0)[0]
    for i in range(n):
        fid, enc, _pad, off, size = struct.unpack_from("<IHHII", payload, 4 + 16 * i)
        yield fid, enc, payload[off:off + size]


def part_info(p):
    """kind-0 payload -> (version, payload_flags, [subset flags]) or None."""
    if len(p) < PAYLOAD_HEADER_LEN + 44 or p[:4] != b"HBG1" or p[4] != 0:
        return None
    version, pflags = p[5], struct.unpack_from("<H", p, 6)[0]
    mh = PAYLOAD_HEADER_LEN
    vc, ic = struct.unpack_from("<II", p, mh)
    sc = struct.unpack_from("<H", p, mh + 8)[0]
    stream_off = struct.unpack_from("<I", p, mh + 36)[0]
    idx_bytes = (4 if pflags & FLAG_IDX_U32 else 2) * ic
    subs_off = (stream_off + 24 * vc + (4 * vc if pflags & FLAG_BAKED_LIGHT else 0)
                + ((idx_bytes + 3) & ~3))
    flags = [p[subs_off + s * SUBSET_ROW_LEN + 4] for s in range(sc)
             if subs_off + (s + 1) * SUBSET_ROW_LEN <= len(p)]
    return version, pflags, flags


def main():
    args = sys.argv[1:]
    if not args or args[0].startswith("-"):
        die("usage: hbg1_face_census.py <dist-or-bake-out-dir> [--limit N] "
            "[--require-v2] [--json]")
    root = args[0]
    limit = int(args[args.index("--limit") + 1]) if "--limit" in args else None
    require_v2 = "--require-v2" in args
    as_json = "--json" in args

    paths = index_pack_paths(root)
    if limit is not None:
        paths = paths[:limit]
    seen = {}       # (section, id) -> version
    c = {
        "packs_scanned": 0, "packs_missing": 0,
        "gfx_by_version": {}, "gfxr_by_version": {}, "other_by_version": {},
        "gfx_v2_backface": 0, "gfx_v2_nopos": 0, "gfx_v2_front_copy": 0,
        "geomr_version_drift": 0,
    }
    gfx_version = {}
    for i, path in enumerate(paths):
        if not os.path.exists(path):
            c["packs_missing"] += 1
            continue
        with open(path, "rb") as fh:
            secs = sections(fh)
            if not secs:
                continue
            c["packs_scanned"] += 1
            for kind in (GEOM, GEOMR):
                if kind not in secs:
                    continue
                for fid, enc, p in geom_rows(read_section(fh, secs[kind])):
                    if enc != 0x0001 or (kind, fid) in seen:
                        continue
                    prefix = fid >> 24
                    if prefix != 0x01:
                        if kind == GEOM and len(p) > 5:
                            seen[(kind, fid)] = p[5]
                            k = f"0x{prefix:02X}:v{p[5]}"
                            c["other_by_version"][k] = c["other_by_version"].get(k, 0) + 1
                        continue
                    info = part_info(p)
                    if info is None:
                        continue
                    version, pflags, flags = info
                    seen[(kind, fid)] = version
                    bucket = "gfx_by_version" if kind == GEOM else "gfxr_by_version"
                    c[bucket][f"v{version}"] = c[bucket].get(f"v{version}", 0) + 1
                    if kind == GEOM:
                        gfx_version[fid] = version
                        if version == 2:
                            c["gfx_v2_backface"] += any(f & SUB_MODEL_BACKFACE for f in flags)
                            c["gfx_v2_nopos"] += any(f & SUB_NOPOS_SLOT0 for f in flags)
                            c["gfx_v2_front_copy"] += bool(pflags & FLAG_NEG_FRONT_COPY)
                    elif fid in gfx_version and gfx_version[fid] != version:
                        c["geomr_version_drift"] += 1
        if (i + 1) % 2000 == 0:
            print(f"  scanned {i + 1}/{len(paths)}", file=sys.stderr)

    v1_gfx = c["gfx_by_version"].get("v1", 0) + c["gfxr_by_version"].get("v1", 0)
    c["verdict"] = ("v2 (face-marked): ?negFace serves every model" if v1_gfx == 0
                    and c["gfx_by_version"] else
                    "PRE-MARKER rows present: ?negFace sends those models to the runtime decode")
    fail = require_v2 and (v1_gfx > 0 or c["geomr_version_drift"] > 0
                           or not c["gfx_by_version"])
    if "--diff" in args:
        c["diff"] = diff_bakes(root, args[args.index("--diff") + 1], limit)
        fail = fail or not c["diff"]["only_geom"]
    if as_json:
        print(json.dumps(c, indent=2))
    else:
        for k, v in c.items():
            print(f"{k}: {v}")
    if fail:
        sys.exit(1)


if __name__ == "__main__":
    main()

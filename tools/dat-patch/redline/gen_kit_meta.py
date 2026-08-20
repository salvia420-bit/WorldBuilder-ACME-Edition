#!/usr/bin/env python3
"""gen_kit_meta.py -- emit acme-meta.json, the sidecar the in-game AcmeRedline
plugin needs to pre-flight a report before the player ever presses submit.

    python3 gen_kit_meta.py --tag acme-r9 \
        --portal  /path/to/kit/client_portal.dat \
        --highres /path/to/kit/client_highres.dat \
        --out     /path/to/kit/acme-meta.json

Output:
    {
      "kitTag": "acme-r9",
      "portalSha256":  "...",          # exactly what assemble_kit.sh checksums
      "highresSha256": "..." | null,
      "terrainProtectedRs": [ "0x06...", ... ],   # tools/dat-patch/terrain_protected_rs.txt
      "paletteRouteRs":     [ "0x06...", ... ],   # every 0x06 record whose format is INDEX16 or P8
      ...provenance...
    }

WHY the plugin wants this
  * terrainProtectedRs -- the player selects a patch of ground, the plugin can
    say "terrain is handled by a different lane" instead of queueing something
    that will be refused hours later.  The list is the same file the texture
    lanes refuse against (texture_lane.py:505-524, fill_import.py:77-101).
  * paletteRouteRs -- a palettized RenderSurface can never be DXT-converted
    without breaking ClothingTable subpalette recolours (fill_import.py:13-19),
    so "recolor" on one of these is a palette job, not a rebake, and the plugin
    can say so up front.
Both are ADVISORY.  queue_worker.py re-derives them from the dats and reports a
disagreement as guard-drift; the plugin's copy going stale is a nuisance, never
a correctness hole.

READ-ONLY on the dats.  Reads through tools/dat-patch/datlib.py, so it sees the
same records the client's b-tree walk does, including compressed ones.

The palette scan reads only the 24-byte RenderSurface header of each 0x06
record (texture_lane.rs_header layout, texture_lane.py:68-78) -- it never
inflates pixel payloads, so a full portal scan is seconds, not minutes.
"""
import argparse
import datetime
import hashlib
import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATPATCH = os.path.dirname(HERE)
sys.path.insert(0, DATPATCH)

import datlib                                        # noqa: E402

PROTECTED_PATH = os.path.join(DATPATCH, "terrain_protected_rs.txt")
PF_P8, PF_INDEX16 = 41, 101                          # texture_lane.py:54-64
PF_NAMES = {PF_P8: "P8", PF_INDEX16: "INDEX16"}


def sha256_file(path, chunk=1 << 22):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for c in iter(lambda: f.read(chunk), b""):
            h.update(c)
    return h.hexdigest()


def load_protected():
    """The same read texture_lane.py:505-510 and fill_import.py:77-80 do."""
    if not os.path.exists(PROTECTED_PATH):
        return []
    with open(PROTECTED_PATH) as f:
        return sorted({"0x%08X" % int(l, 16) for l in f
                       if l.strip() and not l.lstrip().startswith("#")})


def scan_palette_rs(dat_path):
    """-> ({rsHex: fmtName}, stats).  Every 0x06 record whose Format field is
    INDEX16(101) or P8(41)."""
    dat = datlib.Dat(dat_path)
    ids = sorted(i for i in dat.files if (i >> 24) == 0x06)
    out, unreadable = {}, 0
    for rid in ids:
        try:
            raw = dat.get(rid)
        except Exception:
            unreadable += 1
            continue
        if raw is None or len(raw) < 24:
            unreadable += 1
            continue
        fmt = struct.unpack_from("<I", raw, 16)[0]   # Id,DataCategory,W,H,Format
        if fmt in PF_NAMES:
            out["0x%08X" % rid] = PF_NAMES[fmt]
    return out, dict(renderSurfaceCount=len(ids), unreadable=unreadable,
                     recordCount=len(dat.files))


def build(tag, portal, highres=None):
    meta = dict(
        kitTag=tag,
        portalSha256=sha256_file(portal),
        highresSha256=sha256_file(highres) if highres else None,
    )
    prot = load_protected()
    pal_portal, st_portal = scan_palette_rs(portal)
    pal = dict(pal_portal)
    st_high = None
    if highres:
        pal_high, st_high = scan_palette_rs(highres)
        # A highres record SUPERSEDES the portal copy of the same id on a
        # patched client, so it wins here too.  An id that is palettized in the
        # portal but DXT in highres must NOT stay on the palette list.
        for rid in pal_high:
            pal[rid] = pal_high[rid]
        high_ids = set(pal_high)
        # ids present in highres at all, but not palettized there
        dat = datlib.Dat(highres)
        for rid in (i for i in dat.files if (i >> 24) == 0x06):
            h = "0x%08X" % rid
            if h not in high_ids and h in pal:
                del pal[h]

    meta["terrainProtectedRs"] = prot
    meta["paletteRouteRs"] = sorted(pal)
    meta["paletteRouteRsFormats"] = {k: pal[k] for k in sorted(pal)}
    meta["provenance"] = dict(
        generatedBy="tools/dat-patch/redline/gen_kit_meta.py",
        generatedAt=datetime.datetime.now(datetime.timezone.utc)
                    .strftime("%Y-%m-%dT%H:%M:%SZ"),
        portalPath=os.path.abspath(portal),
        portalBytes=os.path.getsize(portal),
        highresPath=os.path.abspath(highres) if highres else None,
        highresBytes=os.path.getsize(highres) if highres else None,
        terrainProtectedSource=os.path.relpath(PROTECTED_PATH, DATPATCH),
        portalStats=st_portal,
        highresStats=st_high,
        schemaNote="consumed by the AcmeRedline Chorizite plugin and re-checked "
                   "by tools/dat-patch/redline/queue_worker.py")
    return meta


def main(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tag", required=True, help="kit tag, e.g. acme-r9 "
                                                 "(same value as assemble_kit.sh --tag)")
    ap.add_argument("--portal", required=True)
    ap.add_argument("--highres", default=None)
    ap.add_argument("--out", default=None,
                    help="default: acme-meta.json beside --portal")
    a = ap.parse_args(argv)

    for p in (a.portal, a.highres):
        if p and not os.path.exists(p):
            raise SystemExit("missing dat: %s" % p)
    out = a.out or os.path.join(os.path.dirname(os.path.abspath(a.portal)),
                                "acme-meta.json")

    meta = build(a.tag, a.portal, a.highres)
    tmp = out + ".tmp"
    with open(tmp, "w") as f:
        json.dump(meta, f, indent=1)
    os.replace(tmp, out)

    print("kitTag              %s" % meta["kitTag"])
    print("portalSha256        %s" % meta["portalSha256"])
    print("highresSha256       %s" % (meta["highresSha256"] or "(none)"))
    print("terrainProtectedRs  %d" % len(meta["terrainProtectedRs"]))
    print("paletteRouteRs      %d of %d RenderSurfaces in the portal"
          % (len(meta["paletteRouteRs"]),
             meta["provenance"]["portalStats"]["renderSurfaceCount"]))
    fmts = {}
    for v in meta["paletteRouteRsFormats"].values():
        fmts[v] = fmts.get(v, 0) + 1
    print("                    %s" % (fmts or "-"))
    print("-> %s" % out)
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""terrain_lane.py -- the TERRAIN TEXTURE LANE (release roadmap lane 1).

Decomp constraint that shapes this whole lane (acclient.c):
  * TexMerge::FillTempTexBuffer allocates its merge buffer ONCE as
    4 * Region.baseTexSize^2 (:305935) and ImgTex::TileCSI (:365513) does raw
    4-byte-per-texel DWORD copies with block placement that assumes
    src_width == composite_width / texTiling EXACTLY.  With the retail Region
    (baseTexSize 1024, texTiling 2) every base terrain texture MUST stay
    512x512, and MUST stay 32-bit uncompressed (the merge path locks the
    surface and reads raw DWORDs -- DXT would be read as garbage/overrun).
  * Composite land surfaces are uploaded uncompressed per terrain-combination
    (ImgTex::CreateLScapeTexture -> custom_texture_table), so raising
    baseTexSize multiplies client address-space cost by the square -- that is
    a separately-gated EXPERIMENT, not this lane.

So this lane ships SAME-STRUCTURE textures: 512^2 A8R8G8B8 (format-preserving
import), rebuilt from the Remacri 2048^2 upscale SUPERSAMPLED back down to
512 (Lanczos) + the owner-approved legibility bake (exposure anchor, and the
two-band emboss only where the seam op finds real line structure).  The win
vs retail is a genuinely cleaner, crisper, brighter 512 -- and the shipped
UserPreferences snippet (LandscapeTextureDetail=0) stops the client from
halving it to 256 at the boot default.

Blend masks (corner/side/road maps) and detail textures are NOT touched:
masks must never be baked, and the 3 detail textures have no corpus.
Base terrain SurfaceTextures are single-entry in retail (verified) -- no
collapse step exists in this lane.

THE 2x LANE (--size 1024, D1/D2 of TASKLIST-2026-08-17 section D)
-----------------------------------------------------------------
`bake --size 1024` drops the final downsample one stop (2048 rewrap ->
1024 instead of 512) and `alpha --size 1024` upscales the 8 blend masks to
match.  Both are INERT until Region 0x13000000 baseTexSize is patched
1024 -> 2048 (tools/dat-patch/patch_region_basetexsize.py); the three sizes
are locked together by the retail merge path:

    base_tex_size (Region)  = dest composite edge  = 2048
    base terrain RS edge    = base_tex_size / texTiling(2)   = 1024
    blend/road alpha edge   = base terrain RS edge            = 1024

The second identity is ImgTex::TileCSI (acclient.c:365513): it copies
src_width x src_height DWORDs `tiling` times in each axis into a
dest_width-pitch buffer, so src_edge * tiling must equal dest_edge exactly.
The third is ImgTex::MergeTexture (:365632): the alpha cursor's ROW stride
is `v8` = the BASE texture's width (the rot switch at the top builds all
four rotation walks out of the base's width/height, never the alpha's), and
the column loop advances the cursor once per `dest_width/alpha_width`
texels.  A full pass therefore touches alpha_width * base_width bytes --
in bounds only when alpha_edge == base_edge.  Alpha smaller than the base
(e.g. leaving the masks at 512 under a 1024 base) walks off the end of a
262,144-byte record: that is the r6-clobber OOB, not a cosmetic mismatch.

Lane fold (r7.1 / take-5 driver), in this order and BEFORE the compress step
-- all three must land together or the client walks off the alpha record:

  python3 terrain_lane.py bake  --root <lane> --size 1024 \
      --corpus /mnt/wbterminal2/upscale-corpus/rewrap-out/out \
      --out    /mnt/wbterminal2/terrain-2x/base-1024
  python3 terrain_lane.py alpha --out /mnt/wbterminal2/terrain-2x/alpha-2x --size 1024
  render-surface-import  the 29 bases (A8R8G8B8) + 8 masks (LSCAPE_ALPHA),
      allowResize=true          [terrain_lane.py run --size 1024 does the bases]
  surface-texture-collapse the 8 blend STs to their portal entry (they are
      2-entry: index 0 is a 0x060073Ax client_highres.dat id, and
      ImgTex::GetSurfaceDID takes index 0 first -- a reachable 512 sibling
      under a 1024 base IS the OOB)
  python3 patch_region_basetexsize.py patch --dat <portal> --value 2048 --apply

Subcommands:
  derive  --root R --base DAT            Region -> terrain ST/RS mapping json
  bake    --root R [--variants]          29 baked 512 PNGs (+ board variants)
          [--size N --corpus DIR --out DIR]      ... or 29 baked N^2 PNGs
  alpha   --out DIR [--size N]           8 blend/road masks upscaled to N^2
  board   --root R [--rs 0x06..]         tiled A/B/C boards per texture
  run     --root R --patched DAT         import into patched dat + roundtrip
          [--size N --baked DIR]
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

BASE_PORTAL = "/home/wbterminal/ac_base_dats/client_portal.dat"
REGION_ID = 0x13000000
CORPUS = os.environ.get("DATPATCH_TERRAIN_CORPUS",
                        "/mnt/wbterminal2/upscale-corpus/out/terrain-remacri/")
WBT_RUN = ("DOTNET_ROLL_FORWARD=LatestMajor dotnet /home/wbterminal/"
           "WorldBuilder-ACME-Edition/WorldBuilder.Terminal/bin/Release/"
           "net8.0/WorldBuilder.Terminal.dll --stdin")
# EMBOSS IS OFF FOR TERRAIN -- board-proven 2026-08-15: on 2x2-tiled boards
# (board_0x06006D3F/42/6F) the low-band + AO terms paint broad diagonal
# light/dark blotches that repeat with the tile.  A wall is seen once; ground
# is tiled hundreds of times, so macro shading reads as a repeating stain.
# Terrain ships supersample + exposure anchor only.  (Flip to re-measure.)
TERRAIN_EMBOSS = False
SEAM_MIN_CARVED = 0.08
# terrain types whose look is water: never emboss, and keep retail exposure
# (1.0) -- a +15% brighter ocean reads as washed-out, not more legible.
WATER_RS = set()  # filled by derive from terrainType names


def wbt(cmds, timeout=1800):
    import subprocess
    inp = "\n".join(json.dumps(c) for c in cmds) + "\n"
    p = subprocess.run(WBT_RUN, shell=True, input=inp.encode(),
                       capture_output=True, timeout=timeout)
    outs = []
    for line in p.stdout.decode(errors="replace").splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                outs.append(json.loads(line))
            except ValueError:
                pass
    return outs


def derive(root):
    """Region record -> terrain.json: base STs (uses/tiling), ST->RS, water set."""
    os.makedirs(root, exist_ok=True)
    outs = wbt([dict(command="chorizite-parse-dat-record", datPath=BASE_PORTAL,
                     idHex="0x%08X" % REGION_ID, typeName="Region")])
    reg = next(o for o in outs if o.get("typeName") == "Region")
    tm = reg["fields"]["terrainInfo"]["landSurfaces"]["texMerge"]
    base = {}
    for e in tm["terrainDesc"]:
        tt = e["terrainTex"]
        st = "0x%08X" % tt["textureId"]["dataId"]
        base.setdefault(st, dict(uses=[], texTiling=tt["texTiling"]))
        base[st]["uses"].append(e["terrainType"])
    st_ids = sorted(base)
    st_outs = wbt([dict(command="chorizite-parse-dat-record", datPath=BASE_PORTAL,
                        idHex=st, typeName="SurfaceTexture") for st in st_ids])
    for o in st_outs:
        texs = (o.get("fields") or {}).get("textures") or []
        rss = ["0x%08X" % (t.get("dataId") if isinstance(t, dict) else t)
               for t in texs]
        oid = o.get("idHex")
        if oid in base:
            base[oid]["rs"] = rss
            assert len(rss) == 1, "base terrain ST %s not single-entry" % oid
    water = sorted({v["rs"][0] for v in base.values()
                    if any("Water" in u or "SeaSlime" in u for u in v["uses"])
                    and all("Water" in u or "Faux" in u or "SeaSlime" in u
                            for u in v["uses"])})
    blend = sorted({"0x%08X" % m["textureId"]["dataId"]
                    for k in ("cornerTerrainMaps", "sideTerrainMaps", "roadMaps")
                    for m in tm[k]})
    out = dict(baseTexSize=tm["baseTexSize"], base=base, waterRs=water,
               blendSts=blend,
               detailSts=sorted({"0x%08X" % e["terrainTex"]["detailTextureId"]["dataId"]
                                 for e in tm["terrainDesc"]
                                 if e["terrainTex"].get("detailTextureId")}))
    p = os.path.join(root, "terrain.json")
    json.dump(out, open(p, "w"), indent=1)
    rs_all = sorted({v["rs"][0] for v in base.values()})
    print("derive: %d base STs -> %d unique RS (%d water) -> %s"
          % (len(base), len(rs_all), len(water), p))
    return out


def _load(root):
    d = json.load(open(os.path.join(root, "terrain.json")))
    rs2use = {}
    for st, v in d["base"].items():
        rs2use.setdefault(v["rs"][0], []).extend(v["uses"])
    return d, rs2use


def _sha256(path):
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def bake(root, variants=False, size=None, corpus=None, outdir=None):
    """size=None -> the shipping 512 lane (retail dims, unchanged).
    size=N      -> the 2x lane: supersample the rewrap 2048 down to N and
                   carry the retail alpha channel up by NEAREST replication
                   (integer factor, so every retail alpha byte survives --
                   no resampler invents a value in a channel the merge path
                   never blends)."""
    import numpy as np
    from PIL import Image
    import matlib
    import legibility
    d, rs2use = _load(root)
    water = set(d["waterRs"])
    G = legibility.GAINSETS["mid"]
    src_corpus = corpus or CORPUS
    bdir = outdir or os.path.join(root, "baked" if not size else "baked-%d" % size)
    vdir = os.path.join(root, "variants")
    os.makedirs(bdir, exist_ok=True)
    if variants:
        os.makedirs(vdir, exist_ok=True)
    res = []
    for rs in sorted(rs2use):
        base = np.asarray(Image.open(os.path.join(root, "tex-base", rs + ".png")),
                          np.uint8)
        rp = os.path.join(src_corpus, rs + ".png")
        if not os.path.exists(rp):
            res.append(dict(rs=rs, status="SKIP", why="no corpus png"))
            continue
        rem = Image.open(rp)
        src_wh = rem.size
        rem = rem.convert("RGB")
        tgt = (size, size) if size else base.shape[1::-1]
        ss = np.asarray(rem.resize(tgt, Image.LANCZOS), np.uint8)
        if size and (size, size) != base.shape[1::-1]:
            bh, bw = base.shape[:2]
            assert size % bw == 0 and size % bh == 0, (
                "%s: %d is not an integer multiple of the retail %dx%d"
                % (rs, size, bw, bh))
            alpha_ch = np.asarray(
                Image.fromarray(base[:, :, 3], "L").resize(tgt, Image.NEAREST),
                np.uint8)
        else:
            alpha_ch = base[:, :, 3]
        ssf = np.dstack([ss, alpha_ch]).astype(np.float32) / 255.0
        basef = base.astype(np.float32) / 255.0
        is_water = rs in water
        lum_t = 1.0 if is_water else legibility.LUM_TARGET
        h = None
        cf = 0.0
        if TERRAIN_EMBOSS and not is_water:
            h = matlib.relief_height(ssf)
            cf = matlib.carved_fraction(h)
            if cf < SEAM_MIN_CARVED:
                h = None
        out, info = legibility.bake_texture(ssf, basef, h, G["g_hi"], G["g_lo"],
                                            G["a0"], lum_target=lum_t)
        u8 = (np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8)
        u8[:, :, 3] = alpha_ch               # alpha verbatim from retail
        op = os.path.join(bdir, rs + ".png")
        Image.fromarray(u8, "RGBA").save(op)
        if variants:
            ss_only, _ = legibility.bake_texture(ssf.copy(), basef, None,
                                                 0, 0, 0, lum_target=lum_t)
            v8 = (np.clip(ss_only, 0, 1) * 255 + 0.5).astype(np.uint8)
            v8[:, :, 3] = alpha_ch
            Image.fromarray(v8, "RGBA").save(os.path.join(vdir, rs + "_ss.png"))
        res.append(dict(rs=rs, status="OK", uses=sorted(set(rs2use[rs]))[:3],
                        water=is_water, embossed=h is not None,
                        carved=round(cf, 3), lum_target=lum_t,
                        lum_base=round(info["lum_base"], 4),
                        lum_after=round(info["lum_after"], 4),
                        # --- 2x-lane ledger fields -----------------------
                        retailW=int(base.shape[1]), retailH=int(base.shape[0]),
                        srcPng=rp, srcW=src_wh[0], srcH=src_wh[1],
                        srcSha256=_sha256(rp),
                        outPng=op, outW=int(u8.shape[1]), outH=int(u8.shape[0]),
                        outSha256=_sha256(op),
                        alphaFromRetail=("verbatim" if alpha_ch.shape == base.shape[:2]
                                         else "nearest-x%d"
                                              % (alpha_ch.shape[1] // base.shape[1])),
                        # decimating the upscaled alpha by the same integer
                        # factor must reproduce the retail bytes exactly
                        alphaRetailExact=bool(np.array_equal(
                            alpha_ch[::alpha_ch.shape[0] // base.shape[0],
                                  ::alpha_ch.shape[1] // base.shape[1]],
                            base[:, :, 3])),
                        targetFormat="PFID_A8R8G8B8",
                        expectPayloadBytes=int(u8.shape[0] * u8.shape[1] * 4),
                        expectRecordBytes=int(u8.shape[0] * u8.shape[1] * 4 + 24)))
        print("%s %-4s %dx%d water=%d emboss=%d carved=%.2f  %s"
              % (rs, res[-1]["status"], res[-1]["outW"], res[-1]["outH"],
                 is_water, h is not None, cf, ",".join(res[-1]["uses"])))
    lp = os.path.join(root, "bake_results.json" if not size
                      else "bake_results_%d.json" % size)
    json.dump(res, open(lp, "w"), indent=1)
    ok = sum(1 for r in res if r["status"] == "OK")
    print("bake: %d/%d ok -> %s (ledger %s)" % (ok, len(res), bdir, lp))


ALPHA_HEADER = 24                   # Id + DataCategory + W + H + Format + len
ALPHA_FORMAT = 0xF4                 # PFID_CUSTOM_LSCAPE_ALPHA, 1 byte/texel


def _read_alpha_rs(dat, rs_id):
    """Raw LSCAPE_ALPHA record -> (w, h, uint8 HxW).  Read straight out of the
    record instead of via an image exporter: the mask bytes ARE the payload
    (one byte per texel, no palette), so any decode step in between is a
    chance to lose a value."""
    import struct
    import numpy as np
    b = dat.get(rs_id)
    if b is None:
        return None
    _id, _cat, w, h, fmt, ln = struct.unpack_from("<6I", b, 0)
    assert fmt == ALPHA_FORMAT, "0x%08X is format 0x%X, not LSCAPE_ALPHA" % (rs_id, fmt)
    assert ln == w * h, "0x%08X length %d != %dx%d" % (rs_id, ln, w, h)
    assert len(b) == ALPHA_HEADER + ln, "0x%08X record %d bytes" % (rs_id, len(b))
    return w, h, np.frombuffer(b, np.uint8, count=ln,
                               offset=ALPHA_HEADER).reshape(h, w).copy()


def alpha(out, size=1024, portal=BASE_PORTAL):
    """D2: the 4 corner + 1 side + 3 road blend masks, upscaled to `size`.

    Method = BICUBIC on the single mask channel, then clamp to [0,255].
    Justification: these are not photographs and not hard stencils -- 52-95%
    of each mask is saturated 0/255 with an anti-aliased transition band that
    uses the full 0..255 range.  Bicubic keeps that band monotone and one
    band wide; Lanczos' longer kernel rings on the saturated plateaus (a
    ring in a BLEND WEIGHT prints as a halo of the wrong terrain along every
    transition, and clamping only hides half of it); bilinear widens the band
    and shifts the 50% contour.  An AI upscaler is wrong by construction --
    it hallucinates texture detail into a weight field.
    A NEAREST arm is written to <out>/nearest/ as the zero-risk fallback: at
    an integer factor it reproduces exactly what the retail client already
    does today (scale_up_alpha replication in ImgTex::MergeTexture), so it
    changes the blend geometry by nothing at all."""
    import numpy as np
    from PIL import Image
    import datlib
    os.makedirs(out, exist_ok=True)
    ndir = os.path.join(out, "nearest")
    os.makedirs(ndir, exist_ok=True)
    outs = wbt([dict(command="chorizite-parse-dat-record", datPath=portal,
                     idHex="0x%08X" % REGION_ID, typeName="Region")])
    reg = next(o for o in outs if o.get("typeName") == "Region")
    tm = reg["fields"]["terrainInfo"]["landSurfaces"]["texMerge"]
    kinds = [("corner", "cornerTerrainMaps"), ("side", "sideTerrainMaps"),
             ("road", "roadMaps")]
    sts = [(kind, "0x%08X" % m["textureId"]["dataId"])
           for kind, key in kinds for m in tm[key]]
    st_outs = {o.get("idHex"): o for o in
               wbt([dict(command="chorizite-parse-dat-record", datPath=portal,
                         idHex=st, typeName="SurfaceTexture")
                    for _k, st in sts])}
    dat = datlib.Dat(portal)
    res = []
    for kind, st in sts:
        o = st_outs.get(st) or {}
        texs = (o.get("fields") or {}).get("textures") or []
        dids = [(t.get("dataId") if isinstance(t, dict) else t) for t in texs]
        # ImgTex::GetSurfaceDID (acclient.c:366232): m_num==1 -> entry 0;
        # m_num==2 -> entry 0 unless Render::ShouldDropHighDetail().  The
        # index-0 sibling of every blend ST is a 0x060073Ax id that does NOT
        # live in client_portal.dat (it is a client_highres.dat record), so
        # the mask actually merged is the LAST entry.  A 2x lane that leaves
        # that highres sibling reachable ships a 512 alpha under a 1024 base
        # == the OOB read; see the module docstring.  Collapse the ST.
        present = [x for x in dids if dat.files.get(x) is not None]
        assert len(present) == 1, "%s: %d portal-resident entries" % (st, len(present))
        rs = present[0]
        w, h, px = _read_alpha_rs(dat, rs)
        assert size % w == 0 and size % h == 0, \
            "0x%08X %dx%d does not divide %d" % (rs, w, h, size)
        f = size // w
        im = Image.fromarray(px, "L")
        bic = np.clip(np.asarray(im.resize((size, size), Image.BICUBIC),
                                 np.float32), 0, 255).astype(np.uint8)
        nn = np.asarray(im.resize((size, size), Image.NEAREST), np.uint8)
        bp = os.path.join(out, "0x%08X.png" % rs)
        np_ = os.path.join(ndir, "0x%08X.png" % rs)
        Image.fromarray(bic, "L").save(bp)
        Image.fromarray(nn, "L").save(np_)
        res.append(dict(kind=kind, st=st, stEntries=["0x%08X" % x for x in dids],
                        highresSiblingAbsent=["0x%08X" % x for x in dids
                                              if dat.files.get(x) is None],
                        rs="0x%08X" % rs, retailW=w, retailH=h,
                        retailFormat="PFID_CUSTOM_LSCAPE_ALPHA",
                        retailRecordBytes=ALPHA_HEADER + w * h,
                        outW=size, outH=size, factor=f, method="bicubic+clamp",
                        outPng=bp, outSha256=_sha256(bp),
                        nearestPng=np_, nearestSha256=_sha256(np_),
                        expectPayloadBytes=size * size,
                        expectRecordBytes=ALPHA_HEADER + size * size,
                        retailMean=round(float(px.mean()), 3),
                        outMean=round(float(bic.mean()), 3),
                        outMin=int(bic.min()), outMax=int(bic.max()),
                        # nearest decimates back to the retail bytes exactly;
                        # bicubic must at least keep every saturated plateau
                        # texel saturated at the plateau's own centres
                        nearestRetailExact=bool(np.array_equal(nn[::f, ::f], px)),
                        satPreserved=round(float(
                            (bic[::f, ::f][px == 255] == 255).mean()
                            if (px == 255).any() else 1.0), 4),
                        zeroPreserved=round(float(
                            (bic[::f, ::f][px == 0] == 0).mean()
                            if (px == 0).any() else 1.0), 4)))
        print("%-6s %s ST %s  %dx%d -> %dx%d  mean %.1f -> %.1f  nnExact=%s"
              % (kind, res[-1]["rs"], st, w, h, size, size,
                 res[-1]["retailMean"], res[-1]["outMean"],
                 res[-1]["nearestRetailExact"]))
    lp = os.path.join(out, "alpha_ledger_%d.json" % size)
    json.dump(res, open(lp, "w"), indent=1)
    print("alpha: %d masks -> %s (ledger %s)" % (len(res), out, lp))
    return res


def board(root, only=None):
    """Per-RS board: 2x2-tiled BASE | BAKED (+ SS variant when present).
    Tiling on the board is the point -- terrain tiles 2x in-game, so grid
    artifacts and seams show here or nowhere."""
    import numpy as np
    from PIL import Image, ImageDraw
    d, rs2use = _load(root)
    bdir = os.path.join(root, "boards")
    os.makedirs(bdir, exist_ok=True)
    for rs in sorted(rs2use):
        if only and rs not in only:
            continue
        panels = []
        for tag, path in [("BASE", os.path.join(root, "tex-base", rs + ".png")),
                          ("SS", os.path.join(root, "variants", rs + "_ss.png")),
                          ("BAKED", os.path.join(root, "baked", rs + ".png"))]:
            if not os.path.exists(path):
                continue
            a = np.asarray(Image.open(path).convert("RGB"))
            t = np.tile(a, (2, 2, 1))
            im = Image.fromarray(t).resize((512, 512), Image.LANCZOS)
            dr = ImageDraw.Draw(im)
            dr.rectangle([0, 0, 150, 26], fill=(0, 0, 0))
            dr.text((8, 5), "%s %s" % (tag, rs), fill=(255, 255, 96))
            panels.append(np.asarray(im))
        if not panels:
            continue
        row = np.concatenate(panels, axis=1)
        Image.fromarray(row).save(os.path.join(bdir, "board_%s.png" % rs))
    print("boards -> %s" % bdir)


def run(root, patched, size=None, baked=None):
    """Import all baked PNGs into `patched` (format-preserving -> A8R8G8B8),
    then fixup + integrity + roundtrip.  No collapse: base terrain STs are
    single-entry in retail.

    size=None keeps the 512 lane's pin (allowResize=False -> the record's own
    retail dims).  size=N is the 2x lane: the record MUST grow to NxN, so
    allowResize goes true and the roundtrip asserts NxN."""
    import texture_lane as TL
    d, rs2use = _load(root)
    bdir = baked or os.path.join(root, "baked" if not size else "baked-%d" % size)
    exp = size or 512
    imports = [dict(idHex=rs, pngPath=os.path.join(bdir, rs + ".png"),
                    allowResize=bool(size))
               for rs in sorted(rs2use)
               if os.path.exists(os.path.join(bdir, rs + ".png"))]
    print("importing %d terrain RenderSurfaces (format-preserving) ..."
          % len(imports))
    outs = wbt([dict(command="render-surface-import", datPath=patched,
                     imports=imports)])
    imp = next((o for o in outs if o.get("command") == "render-surface-import"),
               None)
    res = dict(requested=len(imports),
               importResult={k: imp.get(k) for k in
                             ("writtenCount", "failCount", "requestedCount")}
               if imp else None,
               fails=[r for r in (imp or {}).get("records", [])
                      if r.get("status") == "FAIL"][:20])
    # format-preservation is the lane's core invariant -- verify per record
    fmt_bad = [r for r in (imp or {}).get("records", [])
               if r.get("status") != "FAIL" and not r.get("formatPreserved")]
    res["formatPreservedAll"] = not fmt_bad
    res["formatNotPreserved"] = [r.get("did") for r in fmt_bad]
    print("fixup (DRW leaf sentinels + arena) ...")
    res["fixup"] = TL.fixup_dat(patched)
    # roundtrip every record straight back out of the fixed dat
    checks = [o for o in
              wbt([dict(command="chorizite-parse-dat-record", datPath=patched,
                        idHex=i["idHex"], typeName="RenderSurface")
                   for i in imports])
              if o.get("command") == "chorizite-parse-dat-record"]
    rt_bad = []
    for o in checks:
        f = o.get("fields") or {}
        if (not o.get("success") or f.get("width") != exp
                or f.get("height") != exp
                or "A8R8G8B8" not in str(f.get("format"))):
            rt_bad.append(dict(id=o.get("idHex"), err=o.get("errorMessage"),
                               fmt=str(f.get("format")), w=f.get("width")))
    res["roundtrip"] = dict(checked=len(checks), bad=rt_bad)
    counts = wbt([dict(command="chorizite-list-dat-records", datPath=BASE_PORTAL,
                       typeName="RenderSurface"),
                  dict(command="chorizite-list-dat-records", datPath=patched,
                       typeName="RenderSurface")])
    cs = [o.get("recordCount") for o in counts
          if o.get("command") == "chorizite-list-dat-records"]
    res["integrity"] = dict(base=cs[0] if cs else None,
                            patched=cs[1] if len(cs) > 1 else None,
                            equal=len(cs) > 1 and cs[0] == cs[1])
    res["portal_mib"] = round(os.path.getsize(patched) / 2**20, 1)
    res["gate_ok"] = bool(res["importResult"]
                          and res["importResult"].get("failCount") == 0
                          and res["formatPreservedAll"]
                          and not rt_bad and res["integrity"]["equal"])
    json.dump(res, open(os.path.join(root, "run_results.json" if not size
                                    else "run_results_%d.json" % size), "w"),
              indent=1)
    print(json.dumps({k: res[k] for k in
                      ("importResult", "formatPreservedAll", "integrity",
                       "portal_mib", "gate_ok")}, indent=1))
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["derive", "bake", "alpha", "board", "run"])
    ap.add_argument("--root")
    ap.add_argument("--patched")
    ap.add_argument("--variants", action="store_true")
    ap.add_argument("--rs", action="append")
    ap.add_argument("--size", type=int,
                    help="2x lane: bake/import at NxN instead of the retail "
                         "512 (needs the Region baseTexSize patch to 2*N)")
    ap.add_argument("--corpus", help="override the upscale corpus dir")
    ap.add_argument("--out", help="output dir (bake: PNGs; alpha: masks)")
    ap.add_argument("--baked", help="run: baked PNG dir override")
    ap.add_argument("--portal", default=BASE_PORTAL,
                    help="alpha: dat to read the retail masks from (read-only)")
    a = ap.parse_args()
    if a.cmd == "derive":
        derive(a.root)
    elif a.cmd == "bake":
        bake(a.root, a.variants, size=a.size, corpus=a.corpus, outdir=a.out)
    elif a.cmd == "alpha":
        assert a.out, "--out required"
        alpha(a.out, size=a.size or 1024, portal=a.portal)
    elif a.cmd == "board":
        board(a.root, a.rs)
    elif a.cmd == "run":
        assert a.patched, "--patched required"
        run(a.root, a.patched, size=a.size, baked=a.baked)


if __name__ == "__main__":
    main()

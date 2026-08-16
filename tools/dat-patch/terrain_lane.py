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

Subcommands:
  derive  --root R --base DAT            Region -> terrain ST/RS mapping json
  bake    --root R [--variants]          29 baked 512 PNGs (+ board variants)
  board   --root R [--rs 0x06..]         tiled A/B/C boards per texture
  run     --root R --patched DAT         import into patched dat + roundtrip
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


def bake(root, variants=False):
    import numpy as np
    from PIL import Image
    import matlib
    import legibility
    d, rs2use = _load(root)
    water = set(d["waterRs"])
    G = legibility.GAINSETS["mid"]
    bdir = os.path.join(root, "baked")
    vdir = os.path.join(root, "variants")
    os.makedirs(bdir, exist_ok=True)
    if variants:
        os.makedirs(vdir, exist_ok=True)
    res = []
    for rs in sorted(rs2use):
        base = np.asarray(Image.open(os.path.join(root, "tex-base", rs + ".png")),
                          np.uint8)
        rp = os.path.join(CORPUS, rs + ".png")
        if not os.path.exists(rp):
            res.append(dict(rs=rs, status="SKIP", why="no corpus png"))
            continue
        rem = Image.open(rp).convert("RGB")
        ss = np.asarray(rem.resize(base.shape[1::-1], Image.LANCZOS), np.uint8)
        ssf = np.dstack([ss, base[:, :, 3]]).astype(np.float32) / 255.0
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
        u8[:, :, 3] = base[:, :, 3]          # alpha verbatim from retail
        Image.fromarray(u8, "RGBA").save(os.path.join(bdir, rs + ".png"))
        if variants:
            ss_only, _ = legibility.bake_texture(ssf.copy(), basef, None,
                                                 0, 0, 0, lum_target=lum_t)
            v8 = (np.clip(ss_only, 0, 1) * 255 + 0.5).astype(np.uint8)
            v8[:, :, 3] = base[:, :, 3]
            Image.fromarray(v8, "RGBA").save(os.path.join(vdir, rs + "_ss.png"))
        res.append(dict(rs=rs, status="OK", uses=sorted(set(rs2use[rs]))[:3],
                        water=is_water, embossed=h is not None,
                        carved=round(cf, 3), lum_target=lum_t,
                        lum_base=round(info["lum_base"], 4),
                        lum_after=round(info["lum_after"], 4)))
        print("%s %-4s water=%d emboss=%d carved=%.2f  %s"
              % (rs, res[-1]["status"], is_water, h is not None, cf,
                 ",".join(res[-1]["uses"])))
    json.dump(res, open(os.path.join(root, "bake_results.json"), "w"), indent=1)
    ok = sum(1 for r in res if r["status"] == "OK")
    print("bake: %d/%d ok -> %s" % (ok, len(res), bdir))


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


def run(root, patched):
    """Import all baked PNGs into `patched` (format-preserving -> A8R8G8B8),
    then fixup + integrity + roundtrip.  No collapse: base terrain STs are
    single-entry in retail."""
    import texture_lane as TL
    d, rs2use = _load(root)
    bdir = os.path.join(root, "baked")
    imports = [dict(idHex=rs, pngPath=os.path.join(bdir, rs + ".png"),
                    allowResize=False)
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
        if (not o.get("success") or f.get("width") != 512
                or f.get("height") != 512
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
    json.dump(res, open(os.path.join(root, "run_results.json"), "w"), indent=1)
    print(json.dumps({k: res[k] for k in
                      ("importResult", "formatPreservedAll", "integrity",
                       "portal_mib", "gate_ok")}, indent=1))
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["derive", "bake", "board", "run"])
    ap.add_argument("--root", required=True)
    ap.add_argument("--patched")
    ap.add_argument("--variants", action="store_true")
    ap.add_argument("--rs", action="append")
    a = ap.parse_args()
    if a.cmd == "derive":
        derive(a.root)
    elif a.cmd == "bake":
        bake(a.root, a.variants)
    elif a.cmd == "board":
        board(a.root, a.rs)
    elif a.cmd == "run":
        assert a.patched, "--patched required"
        run(a.root, a.patched)


if __name__ == "__main__":
    main()

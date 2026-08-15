"""legboards.py -- phone-first TODAY vs PATCHED boards for the legibility bake.

  BEFORE = retail GfxObj record + the retail 128^2 textures  (today's game)
  AFTER  = ladder arm C geometry (amp 0.20 wall classes, sculpted normals
           gain 2.5, 4x budget) + Remacri upscale with the LEGIBILITY BAKE

Identical camera AND identical light on both panels, always.  The light is a
pleasant neutral daylight: warm-white sun over the viewer's left shoulder,
sky-blue fill from above, ambient 0.55, light sky-gradient background.  Nothing
in the A/B is allowed to come from the lighting.

usage:
    python3 legboards.py <gid-hex> [gainset] [--gif]
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from PIL import Image, ImageDraw, ImageFont

import matlib

HERE = "/mnt/wbterminal2/dat-patch-legibility/"
matlib.CACHE = HERE + "hcache/"
matlib.DBCACHE = HERE + "dbcache/"

import legibility
import pipeline
import relief3d
import render3
import ladder

OUT = HERE + "out/"
os.makedirs(OUT, exist_ok=True)

BOARD_W = 1080
PANEL_H = {"hero": 700, "detail": 780, "graze": 640}

# ------------------------------------------------------------------ lighting
SUN_C = (1.00, 0.965, 0.895)          # warm white
FILL_C = (0.62, 0.74, 1.00)           # sky blue
AMB_C = (0.94, 0.965, 1.00)           # sky-tinted neutral
AMBIENT = 0.55
DIFFUSE = 0.62
FILL_AMT = 0.22
SKY = ((146, 188, 232), (226, 235, 240))   # top -> pale horizon

# camera-space light vectors: x right, y forward (into screen), z up
SUN_CAM = np.array([-0.46, -0.74, 0.49])
FILL_CAM = np.array([0.52, 0.30, 0.80])


def world_light(yaw_deg, pitch_deg, v_cam):
    R = render3.rot(np.radians(yaw_deg), np.radians(pitch_deg))
    w = R.T @ (v_cam / np.linalg.norm(v_cam))
    return tuple(w)


def rend(mesh, keys, tex, cam, size):
    return render3.render(
        mesh["V"], mesh["F"], mesh["UV"], mesh["NR"], keys, tex, size=size,
        yaw=np.radians(cam["yaw"]), pitch=np.radians(cam["pitch"]),
        fit=cam["fit"],
        light=world_light(cam["yaw"], cam["pitch"], SUN_CAM),
        fill_light=world_light(cam["yaw"], cam["pitch"], FILL_CAM),
        ambient=AMBIENT, diffuse=DIFFUSE, fill_amt=FILL_AMT,
        sun_color=SUN_C, fill_color=FILL_C, ambient_color=AMB_C,
        bg_grad=SKY, scale_pad=cam.get("pad", 1.06),
        cull=cam.get("cull", 0), near=cam.get("near"),
        far=cam.get("far"))


# ------------------------------------------------------------------- cameras
def _poly_geom(src, p):
    v = p["v"]
    V = np.array([src.P[i] for i in v])
    cen = V.mean(axis=0)
    n = np.cross(V[1] - V[0], V[2] - V[0])
    ln = np.linalg.norm(n)
    n = n / ln if ln > 1e-12 else np.array([0.0, 0.0, 1.0])
    area = 0.0
    for k in range(1, len(v) - 1):
        area += 0.5 * float(np.linalg.norm(
            np.cross(V[k] - V[0], V[k + 1] - V[0])))
    return cen, n, area, V


def face_on_yaw(n):
    """Yaw that puts a wall with OUTWARD world normal n square to the camera."""
    return float(np.degrees(np.arctan2(-n[0], -n[1])))


def outward(n, cen, mid):
    """Polygon winding is not reliably outward-facing; orient n away from the
    model centre so the camera ends up OUTSIDE the building (viewing the back
    face of the far wall through the near one was the r1 framing bug)."""
    d = np.asarray(cen) - np.asarray(mid)
    d[2] *= 0.15                      # height offset must not flip a wall
    return n if float(n @ d) >= 0 else -n


def fit_projected(V, yaw, pitch, size, margin=1.10):
    """Exact ortho fit: centre + radius that make the projected bbox fill
    `size` with `margin` slack.  (fit_of's half-diagonal leaves a sea of sky.)"""
    R = render3.rot(np.radians(yaw), np.radians(pitch))
    P = np.asarray(V) @ R.T
    mid = np.array([(P[:, 0].min() + P[:, 0].max()) / 2,
                    (P[:, 1].min() + P[:, 1].max()) / 2,
                    (P[:, 2].min() + P[:, 2].max()) / 2])
    dx = max(P[:, 0].max() - P[:, 0].min(), 1e-3)
    dz = max(P[:, 2].max() - P[:, 2].min(), 1e-3)
    W, H = size
    s = min(W / dx, H / dz) / margin
    rad = min(W, H) / (2.0 * s)
    return (R.T @ mid, rad)


def pick_opening(src, mid=None):
    """NoPos filler quads are the door/window OPENINGS.  Prefer a real window
    (sill clear of the ground) over a doorway: a doorway in a shell-only
    GfxObj is a hole straight through to the sky and frames badly."""
    lo_z = min(p[2] for p in src.P)
    win, door = (None, -1.0), (None, -1.0)
    for p in src.polys:
        if not p.get("invisible"):
            continue
        cen, n, area, V = _poly_geom(src, p)
        ext = V.max(0) - V.min(0)
        if ext[2] < 0.7:                       # skip slivers / floor hatches
            continue
        sill = float(V[:, 2].min()) - lo_z
        tgt = "win" if sill > 0.9 else "door"
        if tgt == "win" and area > win[1]:
            win = ((cen, n, area, V), area)
        if tgt == "door" and area > door[1]:
            door = ((cen, n, area, V), area)
    return win[0] if win[0] is not None else door[0]


def pick_wall(src, classes=ladder.WALL, prefer_wide=False):
    best, ba = None, -1.0
    for p in src.polys:
        if p.get("invisible") or p.get("excluded") or p.get("h") is None:
            continue
        if p.get("amp", 0.0) <= 0:
            continue
        if classes and p.get("cls") not in classes:
            continue
        cen, n, area, V = _poly_geom(src, p)
        s = area
        if abs(n[2]) > 0.75:                   # skip roofs/floors for grazing
            s *= 0.25
        if prefer_wide:
            # the grazing shot needs a BROAD, SQUAT wall.  Without this the
            # solver picks a spire face on 0x010014C3 -- huge area, but ~2 m
            # wide and 12 m tall -- and the crop is four poles against the sky.
            ext = V.max(0) - V.min(0)
            horiz = float(np.hypot(ext[0], ext[1]))
            s *= float(np.clip(horiz / 2.5, 0.15, 1.0))
            s *= float(np.clip(horiz / max(ext[2], 1e-3), 0.10, 1.0))
        if s > ba:
            ba, best = s, (cen, n, area, V)
    return best


def cameras(src, panel_h=None):
    panel_h = panel_h or PANEL_H
    V = np.array(src.P)
    lo, hi = V.min(0), V.max(0)
    mid = (lo + hi) / 2.0
    wall = pick_wall(src) or pick_wall(src, None)
    wcen, wn0, warea, WV = wall
    wn = outward(wn0, wcen, mid)

    # a. 3/4 whole building, silhouette against the sky
    hyaw = face_on_yaw(wn) + 38.0
    hero = dict(yaw=hyaw, pitch=15.0, pad=1.0, cull=1,
                fit=fit_projected(V, hyaw, 15.0, (BOARD_W, panel_h["hero"]),
                                  margin=1.13))

    # b. close crop at window/door scale, on the NEAREST vertical corner.
    #
    # First cut framed this on the biggest window.  Rejected by eye: the 4x
    # decimator merges vertices ACROSS source polygons, so around an opening it
    # emits a few huge triangles that fan from the window corners, sit proud of
    # the fine geometry and carry one neighbour's texture stretched over the
    # other -- a pale "ghost wedge" (LADDER.md blamed the ortho camera; it is
    # actually the mesh, it survives near+far clipping).  A corner crop shows
    # the same texture scale with clean geometry.  See REPORT.md.
    R = render3.rot(np.radians(hyaw), np.radians(15.0))
    PV = V @ R.T
    # only body vertices: on a spired model the nearest vertex overall is a
    # finial tip and the crop becomes two poles against the sky (0x010014C3).
    body = V[:, 2] <= lo[2] + 0.62 * (hi - lo)[2]
    score = PV[:, 1] - 0.15 * np.abs(PV[:, 0] - PV[:, 0].mean())
    score = np.where(body, score, np.inf)
    near_i = int(np.argmin(score))
    body_hi = float(V[body][:, 2].max()) if body.any() else hi[2]
    corner = np.array([V[near_i][0], V[near_i][1],
                       lo[2] + 0.72 * (body_hi - lo[2])])
    detail = dict(fit=(corner, 3.15), yaw=hyaw, pitch=8.0, pad=1.03, cull=1)

    # c. grazing view down a BROAD wall
    gw = pick_wall(src, prefer_wide=True) or wall
    gcen, gn0, garea, GV = gw
    gn = outward(gn0, gcen, mid)
    span = float(np.linalg.norm(GV.max(0) - GV.min(0)))
    graze = dict(fit=(gcen, max(1.8, 0.42 * span)),
                 yaw=face_on_yaw(gn) + 72.0, pitch=6.0, pad=1.03, cull=1)
    return dict(hero=hero, detail=detail, graze=graze)


# -------------------------------------------------------------------- labels
def _font(sz, bold=True):
    p = ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else
         "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
    try:
        return ImageFont.truetype(p, sz)
    except Exception:
        return ImageFont.load_default()


F_BIG = _font(42)
F_MED = _font(28)
F_SM = _font(22, False)
F_HDR = _font(34)
F_TINY = _font(19, False)


def bg_mask(img, grad):
    """True where the pixel is NOT the analytic sky gradient (= the model)."""
    a = np.asarray(img, np.int16)
    H = a.shape[0]
    top = np.array(grad[0], np.float32)
    bot = np.array(grad[1], np.float32)
    t = (np.arange(H, dtype=np.float32) / max(H - 1, 1))[:, None]
    bgr = np.round(((top[None, :] * (1 - t) + bot[None, :] * t) / 255.0
                    * 255.0)).astype(np.int16)
    d = np.abs(a - bgr[:, None, :]).max(axis=2)
    return d > 3


def panel_lum(img, grad):
    a = np.asarray(img, np.float32) / 255.0
    m = bg_mask(img, grad)
    if not m.any():
        return 0.0
    return float(legibility.lum(a)[m].mean())


def labelled(img, tag, sub, accent):
    """Panel with a big colour-coded caption bar under it."""
    w, h = img.size
    bar_h = 76
    out = Image.new("RGB", (w, h + bar_h), (24, 26, 32))
    out.paste(img, (0, 0))
    d = ImageDraw.Draw(out)
    d.rectangle([0, h, w, h + bar_h], fill=accent)
    d.text((22, h + 6), tag, font=F_BIG, fill=(255, 255, 255))
    d.text((24, h + 50), sub, font=F_SM, fill=(255, 255, 255))
    return out


def board(name, title, sub, pairs, footer):
    """pairs: list of (framing caption, before_img, after_img, lum_b, lum_a)"""
    W = BOARD_W
    blocks = []
    hdr = Image.new("RGB", (W, 132), (18, 20, 26))
    d = ImageDraw.Draw(hdr)
    d.text((22, 16), title, font=F_HDR, fill=(245, 246, 250))
    d.text((22, 62), sub, font=F_TINY, fill=(168, 176, 190))
    d.text((22, 92), footer, font=F_TINY, fill=(168, 176, 190))
    blocks.append(hdr)
    for cap, A, B, lb, la in pairs:
        cb = Image.new("RGB", (W, 56), (36, 40, 50))
        dd = ImageDraw.Draw(cb)
        dd.text((22, 12), cap, font=F_MED, fill=(226, 231, 240))
        blocks.append(cb)
        blocks.append(labelled(A, "TODAY",
                               "retail mesh + 128px textures     frame "
                               "luminance %.3f" % lb, (96, 100, 112)))
        blocks.append(labelled(B, "PATCHED",
                               "4x mesh + legibility-baked 512px textures    "
                               "frame luminance %.3f  (%+.1f%%)"
                               % (la, 100.0 * (la / max(lb, 1e-6) - 1.0)),
                               (26, 118, 72)))
    H = sum(b.size[1] for b in blocks) + 8 * (len(blocks) - 1)
    out = Image.new("RGB", (W, H), (18, 20, 26))
    y = 0
    for b in blocks:
        out.paste(b, (0, y))
        y += b.size[1] + 8
    p = OUT + name
    out.save(p)
    print("wrote", p, out.size)
    return p


def make_gif(name, A, B, ms=800):
    p = OUT + name
    a = stamp(A, "TODAY", (96, 100, 112)).convert(
        "P", palette=Image.ADAPTIVE, colors=180)
    b = stamp(B, "PATCHED", (26, 118, 72)).convert(
        "P", palette=Image.ADAPTIVE, colors=180)
    a.save(p, format="GIF", save_all=True, append_images=[b], duration=ms,
           loop=0, optimize=True)
    print("wrote", p, A.size)
    return p


def stamp(img, text, accent):
    im = img.copy()
    d = ImageDraw.Draw(im)
    w, h = im.size
    d.rectangle([0, h - 62, w, h], fill=accent)
    d.text((20, h - 56), text, font=F_BIG, fill=(255, 255, 255))
    return im


# ---------------------------------------------------------------------- main
def run(gid, gainset="mid", gif=True, framings=("hero", "detail", "graze")):
    name = "0x%08X" % gid
    G = legibility.GAINSETS[gainset]
    print("== %s  gains %s" % (name, G))
    rec = pipeline.P.gfx(gid)

    # ---- BEFORE: retail record, retail textures
    metasA, _ = ladder.build_metas(rec, "A")
    srcA = relief3d.SourceMesh.from_record(rec, metasA)
    texB, _ = pipeline.load_textures(metasA, remacri=False, max_side=1024)
    before = pipeline.original(srcA)
    keysB = pipeline.face_surface(srcA, before["poly"])

    # ---- AFTER: ladder arm C geometry + legibility-baked Remacri
    src, metas, h_full, res = ladder.build_arm(rec, "C")
    texR, _ = pipeline.load_textures(metas, remacri=True, max_side=1024)
    texA, infos = legibility.bake_all(texR, texB, metas, h_full,
                                      G["g_hi"], G["g_lo"], G["a0"])
    del texR
    keysA = pipeline.face_surface(src, res["poly"])

    cams = cameras(srcA)
    pairs, gifpair = [], {}
    CAPTION = {"hero": "a.  whole building, 3/4 view",
               "detail": "b.  close crop, window / door scale",
               "graze": "c.  grazing view down a wall"}
    for f in framings:
        cam = cams[f]
        size = (BOARD_W, PANEL_H[f])
        A = rend(before, keysB, texB, cam, size)
        B = rend(res, keysA, texA, cam, size)
        la, lb = panel_lum(B, SKY), panel_lum(A, SKY)
        print("   %-6s frame lum  before %.4f  after %.4f  (%+.1f%%)"
              % (f, lb, la, 100 * (la / max(lb, 1e-6) - 1)))
        A.save(OUT + "raw_%s_%s_%s_before.png" % (name, gainset, f))
        B.save(OUT + "raw_%s_%s_%s_after.png" % (name, gainset, f))
        pairs.append((CAPTION[f], A, B, lb, la))
        gifpair[f] = (A, B)

    emb = [v for v in infos.values() if v["embossed"]]
    if emb:
        rat = float(np.mean([v["lum_after"] / max(v["lum_base"], 1e-6)
                             for v in emb]))
        lum_line = ("%d carved textures, mean luminance %+.0f%% vs retail "
                    "(never darker)" % (len(emb), 100 * (rat - 1)))
    else:
        lum_line = "no carved textures on this model"
    p = board("board_%s_%s.png" % (name, gainset),
              "%s   TODAY vs PATCHED" % name,
              "legibility bake  g_hi=%.2f g_lo=%.2f a0=%.2f   |   geometry: "
              "4x displaced mesh, sculpted normals" % (G["g_hi"], G["g_lo"],
                                                       G["a0"]),
              pairs,
              "identical camera + identical daylight on both panels.  "
              + lum_line)
    gp = None
    if gif:
        key = "detail" if "detail" in gifpair else framings[0]
        A, B = gifpair[key]
        gp = make_gif("toggle_%s_%s.gif" % (name, gainset), A, B)
    with open(OUT + "lum_%s_%s.json" % (name, gainset), "w") as f:
        json.dump({("0x%08X" % k): v for k, v in infos.items()}, f, indent=1)
    return p, gp, infos


if __name__ == "__main__":
    gid = int(sys.argv[1], 16)
    gs = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("-") \
        else "mid"
    run(gid, gs, gif="--gif" in sys.argv)

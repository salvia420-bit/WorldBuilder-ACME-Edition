"""ladder.py -- STARKNESS LADDER: five cumulative intensity arms rendered as
A/B boards so the owner can pick a production recipe by eye.

    A  baseline-current   pilot recipe (seam height, class amps <= 0.08 m)
    B  amp-0.20           wall-class amplitude raised to 0.20 m
    C  B + sculpted       normal_gain 2.5 on carved shading normals
    D  C + cavity Remacri right panel textured with Remacri x4, seam-cavity
                          darkening baked into the albedo (dark_floor 0.60)
    E  D + silhouette     cottage only: r1 relief-plan geometry (plinth,
                          opening surrounds, belt course) as the source record

LEFT panel of every row is identical: the retail record with the base texture
-- what players see today.  Render-only study; no dat writes.

usage: python3 ladder.py 0x0100082E | 0x01000C17
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from PIL import Image, ImageDraw, ImageFont

import matlib

HERE = "/mnt/wbterminal2/dat-patch-legibility/"
matlib.CACHE = HERE + "hcache/"
matlib.DBCACHE = HERE + "dbcache/"

import gfxlib
import pipeline
import relief3d
import render3
import r2lib

WALL = {"Brick", "Stone", "Plank", "Timber"}
AMP_B = 0.20
GAIN_C = 2.5
DARK_FLOOR = 0.60
SEGMENTS = 16
MULT = 4.0
RELIEFGEN_DAT = "/mnt/wbterminal2/dat-patch-reliefgen/client_portal.dat"

PANEL = (520, 390)
STREET_PANEL = (520, 330)

try:
    FONT = ImageFont.truetype(
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 15)
    FONT_S = ImageFont.truetype(
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 13)
except Exception:
    FONT = FONT_S = ImageFont.load_default()


# --------------------------------------------------------------- arm builds
def build_metas(rec, arm):
    sids = set(rec["surfaces"])
    metas = pipeline.surface_meta(sids)
    h_full = {s: m["h"].copy() for s, m in metas.items()
              if m.get("h") is not None}
    # band-limit against a probe mesh (area/uv scales need a SourceMesh)
    probe = relief3d.SourceMesh.from_record(rec, metas)
    pipeline.bandlimit(probe, metas, probe.tri_count() * MULT, verbose=False)
    if arm >= "B":
        for m in metas.values():
            if m["cls"] in WALL and m.get("h") is not None:
                m["amp"] = AMP_B
    return metas, h_full


def build_arm(rec, arm):
    """-> (src, metas, h_full, res)"""
    metas, h_full = build_metas(rec, arm)
    src = relief3d.SourceMesh.from_record(rec, metas)
    # r1's importer wrote every polygon sides=Clockwise(2)+NoNeg(0x8): retail
    # renders those single-sided front-only, but from_record's excluded rule
    # (built for the base dat, where sides==2 means a two-surface sheet) pins
    # them.  Un-pin: they are ordinary walls in the r1 record.
    if arm == "E":
        for p in src.polys:
            if p["sides"] == 2 and (p["stip"] & 0x8) and not (p["stip"] & 0x4):
                m = metas.get(p["surf"]) or {}
                p["excluded"] = False
                p["amp"] = m.get("amp", 0.0)
                p["h"] = m.get("h")
    old = relief3d.MAX_AMPLITUDE_M
    relief3d.MAX_AMPLITUDE_M = AMP_B if arm >= "B" else 0.10
    try:
        res = pipeline.run(src, segments=SEGMENTS, mult=MULT, verbose=False,
                           normal_gain=GAIN_C if arm >= "C" else 1.0)
    finally:
        relief3d.MAX_AMPLITUDE_M = old
    return src, metas, h_full, res


def cavity_bake(tex, metas, h_full):
    """albedo *= dark_floor + (1-dark_floor) * height, carved surfaces only."""
    out = {}
    for sid, arr in tex.items():
        m = metas.get(sid) or {}
        h = h_full.get(sid)
        if arr is None or h is None or m.get("amp", 0.0) <= 0:
            out[sid] = arr
            continue
        H, W = arr.shape[:2]
        him = Image.fromarray((np.clip(h, 0, 1) * 255).astype(np.uint8))
        hr = np.asarray(him.resize((W, H), Image.BILINEAR), np.float32) / 255.0
        f = DARK_FLOOR + (1.0 - DARK_FLOOR) * hr
        a = arr.copy()
        a[:, :, :3] = a[:, :, :3] * f[:, :, None]
        out[sid] = a
    return out


# ----------------------------------------------------------------- cameras
def largest_carved_poly(src, classes=None):
    best, ba = None, -1.0
    for p in src.polys:
        if p.get("invisible") or p.get("excluded") or p.get("h") is None:
            continue
        if p.get("amp", 0.0) <= 0:
            continue
        if classes and p.get("cls") not in classes:
            continue
        v = p["v"]
        area = 0.0
        a = np.array(src.P[v[0]])
        for k in range(1, len(v) - 1):
            b = np.array(src.P[v[k]])
            c = np.array(src.P[v[k + 1]])
            area += 0.5 * np.linalg.norm(np.cross(b - a, c - a))
        if area > ba:
            ba, best = area, p
    return best


def cameras(gid, src):
    V = np.array(src.P)
    lo, hi = V.min(0), V.max(0)
    if gid == 0x0100082E:                       # r01's proven money shot
        close = dict(fit=(np.array([0.4, lo[1] + 0.7, 5.6]), 3.1),
                     yaw=8, pitch=8, light=(0.93, -0.30, 0.18))
    else:
        p = largest_carved_poly(src, classes=WALL) or largest_carved_poly(src)
        v = p["v"]
        a = np.array(src.P[v[0]])
        b = np.array(src.P[v[1]])
        c = np.array(src.P[v[2]])
        n = np.cross(b - a, c - a)
        n = n / max(np.linalg.norm(n), 1e-9)
        cen = np.mean([src.P[i] for i in v], axis=0)
        yaw = np.degrees(np.arctan2(-n[0], -n[1])) + 55.0
        up = np.array([0.0, 0.0, 1.0])
        t = np.cross(up, n)
        t = t / max(np.linalg.norm(t), 1e-9)
        L = 0.85 * t + 0.40 * n + 0.22 * up
        L = tuple(L / np.linalg.norm(L))
        close = dict(fit=(cen, 2.4), yaw=yaw, pitch=8, light=L)
    ext = hi - lo
    street = dict(fit=(np.array([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2,
                                 lo[2] + 0.35 * ext[2]]),
                       max(ext[0], ext[1]) * 0.62),
                  yaw=close["yaw"] - 25, pitch=5, light=close["light"])
    return close, street


def rend(V, F, UV, NR, keys, tex, cam, size):
    return render3.render(V, F, UV, NR, keys, tex, size=size,
                          yaw=np.radians(cam["yaw"]),
                          pitch=np.radians(cam["pitch"]),
                          fit=cam["fit"], light=cam["light"],
                          ambient=0.28, diffuse=1.35,
                          fill_light=r2lib.FILL, fill_amt=0.16)


def diff_pct(A, B):
    a = np.asarray(A, np.int16)
    b = np.asarray(B, np.int16)
    return float((np.abs(a - b).max(axis=2) > 8).mean() * 100.0)


# ------------------------------------------------------------------- board
def label_bar(text, w, h=26, bold=True, bg=(30, 32, 40)):
    im = Image.new("RGB", (w, h), bg)
    d = ImageDraw.Draw(im)
    d.text((8, 5), text, font=FONT if bold else FONT_S, fill=(235, 235, 240))
    return im


def run_model(gid):
    name = "0x%08X" % gid
    print("== %s" % name)
    P = pipeline.P
    rec = P.gfx(gid)

    # arm sources: E swaps the record for r1's relief-plan geometry (cottage)
    arms = ["A", "B", "C", "D"]
    rec_by_arm = {a: rec for a in arms}
    if gid == 0x0100082E and os.path.exists(RELIEFGEN_DAT):
        P2 = gfxlib.Portal(RELIEFGEN_DAT)
        rec_by_arm["E"] = P2.gfx(gid)
        arms.append("E")

    # LEFT panel: retail record, base texture (identical on every row)
    metasA, h_fullA = build_metas(rec, "A")
    srcA = relief3d.SourceMesh.from_record(rec, metasA)
    texL, _ = pipeline.load_textures(metasA, remacri=False)
    close, street = cameras(gid, srcA)
    o = pipeline.original(srcA)
    okeys = pipeline.face_surface(srcA, o["poly"])
    left = {"close": rend(o["V"], o["F"], o["UV"], o["NR"], okeys, texL,
                          close, PANEL),
            "street": rend(o["V"], o["F"], o["UV"], o["NR"], okeys, texL,
                           street, STREET_PANEL)}
    n0 = srcA.tri_count()

    stats = {}
    rows = {"close": [], "street": []}
    for arm in arms:
        src, metas, h_full, res = build_arm(rec_by_arm[arm], arm)
        mx, mean = r2lib.max_displacement(res)
        if arm >= "D":
            texR_raw, _ = pipeline.load_textures(metas, remacri=True)
            texR = cavity_bake(texR_raw, metas, h_full)
        else:
            texR, _ = pipeline.load_textures(metas, remacri=False)
        keys = pipeline.face_surface(src, res["poly"])
        st = dict(tris=len(res["F"]), mult=len(res["F"]) / max(n0, 1),
                  maxd=mx, meand=mean)
        for camname, cam, size in (("close", close, PANEL),
                                   ("street", street, STREET_PANEL)):
            R = rend(res["V"], res["F"], res["UV"], res["NR"], keys, texR,
                     cam, size)
            d = diff_pct(left[camname], R)
            st[camname] = d
            delta = r2lib.delta_image(left[camname], R, 4.0)
            lbl = ("%s   %d tris (%.2fx)   maxDisp %.3f m   diff %.1f%%"
                   % (ARMTITLE[arm], st["tris"], st["mult"], mx, d))
            row = r2lib.stack([label_bar(lbl, PANEL[0] * 3 + 16),
                               r2lib.side_by_side([left[camname], R, delta])],
                              gap=0)
            rows[camname].append(row)
            R.save(HERE + "raw_%s_%s_%s.png" % (name, arm, camname))
        stats[arm] = st
        print("   %s: %d tris %.2fx maxd %.3f close %.1f%% street %.1f%%"
              % (arm, st["tris"], st["mult"], mx, st["close"], st["street"]))

    for camname in ("close", "street"):
        hdr = label_bar(
            "STARKNESS LADDER  %s  [%s]   left = retail+base tex (today)  |  "
            "right = arm  |  |delta|x4.  %d source tris." % (name, camname, n0),
            PANEL[0] * 3 + 16, h=32)
        note = []
        if gid != 0x0100082E:
            note = [label_bar("row E (silhouette ops) omitted: no r1 relief "
                              "plan exists for this model", PANEL[0] * 3 + 16,
                              h=24, bold=False)]
        board = r2lib.stack([hdr] + rows[camname] + note, gap=6)
        out = HERE + "ladder_%s_%s.png" % (name, camname)
        board.save(out)
        print("   wrote %s" % out)
    return n0, stats


ARMTITLE = {
    "A": "A  baseline (pilot recipe, amp<=0.08m)",
    "B": "B  amp 0.20m wall classes",
    "C": "C  + sculpted normals (gain 2.5)",
    "D": "D  + Remacri w/ cavity bake (floor 0.60)",
    "E": "E  + r1 silhouette ops (plinth/surrounds/belt)",
}


if __name__ == "__main__":
    gid = int(sys.argv[1], 16)
    import json
    n0, stats = run_model(gid)
    with open(HERE + "stats_%08X.json" % gid, "w") as f:
        json.dump(dict(gid="0x%08X" % gid, src_tris=n0, arms=stats), f,
                  indent=1)

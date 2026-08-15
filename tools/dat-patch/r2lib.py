"""r2lib.py -- round-2 board compositor + shared measurement helpers."""
import os

import numpy as np
from PIL import Image

import board as B
import matlib
import pipeline
import relief3d
import render3

OUT = "/mnt/wbterminal2/dat-patch-concepts-r2-2026-08-14/"
os.makedirs(OUT, exist_ok=True)

LIGHT = (0.35, -0.90, 0.26)       # grazing: sells displacement under Gouraud
FILL = (-0.45, 0.40, 0.55)


def stats(src, res, metas):
    """Triangle multiplier + where the triangles landed, per class."""
    import collections
    base = collections.Counter()
    fin = collections.Counter()
    for p in src.polys:
        if p.get("invisible"):
            continue
        base[p["cls"]] += len(p["v"]) - 2
    for p in res["poly"]:
        fin[src.polys[p]["cls"]] += 1
    return base, fin


def height_thumb(m, size=112):
    """(albedo, height) thumbnail pair for one surface meta."""
    rs = m.get("rsId")
    if not rs:
        return None, None
    rgba, _ = matlib.load_tex(rs, False, 256)
    if rgba is None:
        return None, None
    alb = Image.fromarray((np.clip(rgba[:, :, :3], 0, 1) * 255).astype(np.uint8))
    alb = alb.resize((size, size), Image.NEAREST)
    h = m.get("h")
    if h is None:
        # show what the operator WOULD have carved, so a veto is evidence
        # rather than a blank -- this is the picture that argues the gate.
        hv = matlib.relief_height(rgba)
        if hv is None:
            hm = Image.new("RGB", (size, size), (190, 190, 190))
        else:
            a = (np.clip(hv, 0, 1) * 255).astype(np.uint8)
            rgb = np.stack([np.full_like(a, 255), a, a], -1)   # red = refused
            hm = Image.fromarray(rgb).resize((size, size), Image.NEAREST)
        return alb, hm
    if True:
        hm = Image.fromarray((np.clip(h, 0, 1) * 255).astype(np.uint8)).convert("RGB")
        hm = hm.resize((size, size), Image.NEAREST)
    return alb, hm


def gate_table(d, x, y, metas, src=None, w=700, title="gate -> height source"):
    f = B.F(12, mono=True)
    fb = B.F(12, mono=True, bold=True)
    d.text((x, y), title, font=B.F(14, True), fill=B.ACC2)
    y += 22
    d.text((x, y), "%-11s %-8s %-9s %6s %6s  %s" %
           ("surface", "class", "operator", "carve", "amp m", "why"), font=fb, fill=B.DIM)
    y += 17
    rows = sorted(metas.items(), key=lambda kv: (kv[1]["cls"] == "Flush", -kv[1]["carved"]))
    for sid, m in rows[:9]:
        col = B.GOOD if m["amp"] > 0 else B.DIM
        d.text((x, y), "0x%08X %-8s %-9s %6.2f %6.3f  %s" %
               (sid, m["cls"][:8], m["op"][:9], m["carved"], m["amp"],
                m["why"][:44]), font=f, fill=col)
        y += 16
    return y


def thumbs_strip(im, d, x, y, metas, keys, size=104, label=True):
    f = B.F(11, mono=True)
    for i, sid in enumerate(keys):
        m = metas.get(sid)
        if not m:
            continue
        alb, hm = height_thumb(m, size)
        if alb is None:
            continue
        px = x + i * (size * 2 + 18)
        im.paste(alb, (px, y))
        im.paste(hm, (px + size + 4, y))
        if label:
            d.text((px, y + size + 3), "%s %s" % (m["rsId"], m["op"]), font=f,
                   fill=B.DIM)
            d.text((px, y + size + 16), "%s carve=%.2f%s" % (
                m["cls"], m["carved"], "  (red = refused)" if m["amp"] <= 0 else ""),
                font=f, fill=B.ACC2 if m["amp"] > 0 else B.BAD)
    return y + size + 32


def ab_board(fname, title, subtitle, tag, imgA, imgB, capA, capB, metas,
             thumb_keys, notes, footer_text, tagcolor=B.ACC2, extra_imgs=None,
             afterlabel="AFTER  -  same texture, displaced mesh"):
    im, d = B.new_board(title, subtitle, tag, tagcolor)
    pw = 716
    innerA = B.panel(d, (28, 118, 28 + pw, 604), "BEFORE  -  retail record", capA, B.DIM)
    innerB = B.panel(d, (756, 118, 756 + pw, 604), afterlabel, capB, B.GOOD)
    B.paste_render(im, imgA, innerA)
    B.paste_render(im, imgB, innerB)
    y = 618
    gate_table(d, 28, y, metas)
    thumbs_strip(im, d, 560, y + 22, metas, thumb_keys[:2])
    if extra_imgs:
        x = 1010
        for img, lab in extra_imgs[:2]:
            t = img.copy()
            t.thumbnail((222, 150), Image.LANCZOS)
            im.paste(t, (x, y + 22))
            d.text((x, y + 24 + t.size[1]), lab, font=B.F(11, mono=True), fill=B.DIM)
            x += 232
    yy = 812
    B.bullets(d, 28, yy, notes[:4], w=700, title=None, font=B.F(13))
    if len(notes) > 4:
        B.bullets(d, 756, yy, notes[4:8], w=716, title=None, font=B.F(13))
    B.footer(d, 1000, footer_text)
    im.save(OUT + fname)
    print("wrote", OUT + fname)
    return im


def delta_image(A, Bimg, gain=4.0):
    """|AFTER - BEFORE| amplified: objective evidence of what the displacement
    changed, and where."""
    a = np.asarray(A, np.float32)
    b = np.asarray(Bimg, np.float32)
    d = np.clip(np.abs(b - a) * gain, 0, 255).astype(np.uint8)
    return Image.fromarray(d)


def render_pair(src, res, metas, tex, fit, size=(700, 500), yaw=25, pitch=12,
                light=LIGHT, ambient=0.32, diffuse=1.30, wire=False, **kw):
    o = pipeline.original(src)
    ka = dict(fit=fit, size=size, yaw=np.radians(yaw), pitch=np.radians(pitch),
              light=light, ambient=ambient, diffuse=diffuse, fill_light=FILL,
              fill_amt=0.16)
    ka.update(kw)
    A = render3.render(o["V"], o["F"], o["UV"], o["NR"],
                       pipeline.face_surface(src, o["poly"]), tex, **ka)
    B_ = render3.render(res["V"], res["F"], res["UV"], res["NR"],
                        pipeline.face_surface(src, res["poly"]), tex, wire=wire, **ka)
    return A, B_


def side_by_side(imgs, gap=8, bg=(14, 15, 20)):
    w = sum(i.size[0] for i in imgs) + gap * (len(imgs) - 1)
    h = max(i.size[1] for i in imgs)
    c = Image.new("RGB", (w, h), bg)
    x = 0
    for i in imgs:
        c.paste(i, (x, 0))
        x += i.size[0] + gap
    return c


def stack(imgs, gap=8, bg=(14, 15, 20)):
    w = max(i.size[0] for i in imgs)
    h = sum(i.size[1] for i in imgs) + gap * (len(imgs) - 1)
    c = Image.new("RGB", (w, h), bg)
    y = 0
    for i in imgs:
        c.paste(i, (0, y))
        y += i.size[1] + gap
    return c


def max_displacement(res):
    """How far the render mesh moved off the AUTHORED SURFACE, in metres --
    the number the physics invariant cares about (collision never moves).
    Measured as the distance from every emitted vertex to the plane of the
    source triangle it belongs to."""
    tri = res["tri"]
    V = res["V"]
    F = res["F"]
    worst = 0.0
    tot = 0.0
    n = 0
    frames = {}
    for fi in range(len(F)):
        ti = res["srctri"][fi] if "srctri" in res else None
        ti = ti if ti is not None else 0
        fr = frames.get(ti)
        if fr is None:
            fr = relief3d.TriFrame(tri[ti])
            frames[ti] = fr
        pts = V[F[fi]]
        dd = np.abs((pts - fr.p0) @ fr.plane_n)
        worst = max(worst, float(dd.max()))
        tot += float(dd.sum())
        n += 3
    return worst, tot / max(n, 1)


def pn_res(src, level=1):
    """PN-tessellated mesh in the same shape as pipeline.run()'s result."""
    V, F, UV, NR, PO = relief3d.pn_tessellate(src, level=level)
    return dict(V=V, F=F, UV=UV, NR=NR, poly=PO, src_tris=src.tri_count())


def plane_deviation(src, res):
    """Max/mean distance from the emitted vertices to the plane of the source
    polygon they came from (metres)."""
    planes = {}
    for pi, p in enumerate(src.polys):
        v = p["v"]
        if len(v) < 3:
            continue
        a = np.array(src.P[v[0]])
        b = np.array(src.P[v[1]])
        c = np.array(src.P[v[2]])
        n = np.cross(b - a, c - a)
        l = np.linalg.norm(n)
        if l < 1e-12:
            continue
        planes[pi] = (n / l, a)
    worst = 0.0
    tot = 0.0
    cnt = 0
    for fi, pi in enumerate(res["poly"]):
        pl = planes.get(int(pi))
        if pl is None:
            continue
        n, a = pl
        d = np.abs((res["V"][res["F"][fi]] - a) @ n)
        worst = max(worst, float(d.max()))
        tot += float(d.sum())
        cnt += 3
    return worst, tot / max(cnt, 1)

"""legibility.py -- the LEGIBILITY BAKE.

Replaces the starkness ladder's arm-D "cavity bake" (darken-only, micro-only,
DARK_FLOOR 0.60), which read as an exposure change / dirt and trended gloomy.

The legibility bake is:

  1. two-band split of the seam height field h (1 = proud face, 0 = groove):
         h_lo = gaussian(h, sigma_lo)            structure band
                 -- timbers, brick courses, shingle rows
         h_hi = h - gaussian(h, sigma_hi)        micro band
                 -- the individual joint lines
  2. SIGNED directional emboss from a fixed convention light in UV space,
     L_uv = normalise((-1,-1)) (top-left), which is how the original AC artists
     painted their own shading into these tiles:
         shade = 1 + g_hi*E(h_hi) + g_lo*E(h_lo) + a0*(h_lo - mean(h_lo))
     Every term is signed and mean-zero-ish: a raised texel gets BRIGHTER, a
     recessed one gets darker.  Nothing is darken-only.
  3. albedo' = softclip(albedo * shade), a smooth knee so near-white texels
     roll off instead of clipping to paper.
  4. HARD CONSTRAINT: mean-luminance renormalise so that
         mean_lum(albedo') = LUM_TARGET * mean_lum(BASE retail texture)
     with LUM_TARGET = 1.15 -- the patched texture is always slightly
     BRIGHTER than what ships today.  Solved by fixed-point iteration through
     the softclip so the guarantee survives the knee.

Gradients are normalised by a robust percentile of the emboss response so the
gains g_hi/g_lo mean the same thing on every texture regardless of how much
contrast its height field happens to carry.
"""
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

# --- gain sets swept by eye (see REPORT.md) -------------------------------
GAINSETS = {
    "soft":   dict(g_hi=0.25, g_lo=0.35, a0=0.10),
    "mid":    dict(g_hi=0.35, g_lo=0.50, a0=0.15),
    "strong": dict(g_hi=0.50, g_lo=0.70, a0=0.22),
}
SIGMA_LO_FRAC = 8.0 / 128.0
SIGMA_HI_FRAC = 2.0 / 128.0
LUM_TARGET = 1.15
KNEE = 0.82            # softclip knee: below this, linear
SHADE_SPAN = 0.60      # two-sided smooth clamp on the shade field
L_UV = np.array([-1.0, -1.0]) / np.sqrt(2.0)   # (u, v); v grows downward


def lum(a):
    return 0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]


def mean_lum(a, alpha_cut=0.5):
    """Mean luminance over the OPAQUE texels (alpha cutouts must not drag the
    average toward whatever the transparent border happens to store)."""
    if a is None:
        return None
    if a.shape[-1] >= 4:
        m = a[..., 3] >= alpha_cut
        if m.any():
            return float(lum(a[..., :3])[m].mean())
    return float(lum(a[..., :3]).mean())


def softclip(c, knee=KNEE):
    """Smooth roll-off above `knee` toward 1.0; identity below.  Keeps the
    bake from turning bright plaster into flat paper."""
    c = np.maximum(c, 0.0)
    hi = c > knee
    if hi.any():
        c = c.copy()
        x = (c[hi] - knee) / (1.0 - knee)
        c[hi] = knee + (1.0 - knee) * (1.0 - np.exp(-x))
    return c


def _emboss(band, limit=1.0):
    """Signed directional emboss of a height band, robustly normalised AND
    soft-limited.

    n ~ (-dh/du, -dh/dv, 1); with L = (Lu, Lv, Lz) the diffuse term carries
    -(gu*Lu + gv*Lv).  Positive => the texel faces the convention light.

    The soft limit is not cosmetic.  A seam field's gradient histogram is
    extremely heavy-tailed (the joint cores are near-step edges), so p98
    normalisation leaves peaks at 5-10x -- which drove shade negative and
    printed BLACK tree-branch blotches over the masonry: the exact "dirty,
    etched" failure the owner rejects.  tanh caps the tail without touching
    the body of the distribution.
    """
    gv, gu = np.gradient(band.astype(np.float32))
    e = -(gu * L_UV[0] + gv * L_UV[1])
    s = float(np.percentile(np.abs(e), 98.0))
    if s < 1e-8:
        return np.zeros_like(e)
    return limit * np.tanh(e / (s * limit))


def _resize_h(h, W, H):
    if h.shape[0] == H and h.shape[1] == W:
        return h.astype(np.float32)
    im = Image.fromarray((np.clip(h, 0, 1) * 255.0).astype(np.uint8))
    return np.asarray(im.resize((W, H), Image.BILINEAR), np.float32) / 255.0


def shade_field(h, W, H, g_hi, g_lo, a0):
    """The signed multiplicative shade field for one texture, at (H, W)."""
    hr = _resize_h(h, W, H)
    n = float(min(W, H))
    s_lo = max(1.0, SIGMA_LO_FRAC * n)
    s_hi = max(0.7, SIGMA_HI_FRAC * n)
    h_lo = ndi.gaussian_filter(hr, s_lo, mode="wrap")
    h_hi = hr - ndi.gaussian_filter(hr, s_hi, mode="wrap")
    shade = 1.0 + g_hi * _emboss(h_hi) + g_lo * _emboss(h_lo)
    if a0:
        ao = h_lo - float(h_lo.mean())
        d = float(np.percentile(np.abs(ao), 95.0))
        if d > 1e-6:
            shade = shade + a0 * np.clip(ao / d, -1.5, 1.5)
    # two-sided smooth clamp: shade never leaves (1-SHADE_SPAN, 1+SHADE_SPAN),
    # so no texel can be driven to black or to paper by the emboss alone.
    return 1.0 + SHADE_SPAN * np.tanh((shade - 1.0) / SHADE_SPAN)


def bake_texture(remacri, base, h, g_hi, g_lo, a0, lum_target=LUM_TARGET):
    """-> (baked RGBA float array, info dict).

    `remacri` is the upscaled albedo we are shipping, `base` the retail
    texture whose mean luminance is the exposure anchor, `h` the seam height
    field (None => no emboss, exposure match only)."""
    out = remacri.copy()
    H, W = out.shape[:2]
    lb = mean_lum(base) if base is not None else mean_lum(remacri)
    l_before = mean_lum(remacri)
    if h is not None:
        shade = shade_field(h, W, H, g_hi, g_lo, a0)
        out[:, :, :3] = out[:, :, :3] * shade[:, :, None]
    # --- exposure hard constraint: mean lum = lum_target * retail mean ----
    target = lum_target * lb
    g = 1.0
    rgb = out[:, :, :3]
    for _ in range(24):
        cand = softclip(rgb * g)
        tmp = out.copy()
        tmp[:, :, :3] = cand
        m = mean_lum(tmp)
        if abs(m - target) <= 1e-4 * max(target, 1e-3):
            break
        g *= target / max(m, 1e-6)
    out[:, :, :3] = np.clip(softclip(rgb * g), 0.0, 1.0)
    info = dict(lum_base=lb, lum_remacri=l_before, lum_after=mean_lum(out),
                exposure_gain=float(g), embossed=h is not None,
                size="%dx%d" % (W, H))
    return out, info


ML_SCALE = 0.45        # de-rate for albedo-polarity-contaminated height fields


def _derate(m):
    """DeepBump heights are inferred from the ALBEDO, so a dark plank "sinks"
    whether or not it is recessed; the same is true of a seam field whose
    carved fraction saturates (>=0.90 -- everything is groove).  Embossing
    those at full gain re-draws the albedo's own dark streaks as shading, which
    is precisely the "dirty" look.  Half gain, no AO term.  Measured on
    0x080006E8 (Plank, deepbump, carved 0.98): full gain turned a warm plank
    wall into black streaks."""
    op = (m or {}).get("op")
    cf = float((m or {}).get("carved", 0.0))
    return (op == "deepbump") or (cf >= 0.90)


def bake_all(tex_after, tex_base, metas, h_full, g_hi, g_lo, a0,
             lum_target=LUM_TARGET):
    """One texture at a time (2048^2 float RGBA is ~64 MB; this laptop has 8 GB
    and earlyoom).  Returns ({sid: rgba}, {sid: info})."""
    out, infos = {}, {}
    for sid, arr in tex_after.items():
        if arr is None:
            out[sid] = None
            continue
        m = metas.get(sid) or {}
        h = h_full.get(sid) if m.get("amp", 0.0) > 0 else None
        b = tex_base.get(sid)
        der = _derate(m) if h is not None else False
        k = ML_SCALE if der else 1.0
        a, info = bake_texture(arr, b, h, g_hi * k, g_lo * k,
                               0.0 if der else a0, lum_target)
        info["cls"] = m.get("cls", "?")
        info["op"] = m.get("op", "?")
        info["derated"] = der
        out[sid] = a
        infos[sid] = info
        del arr
    return out, infos

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
import os

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

# --- gain sets swept by eye (see REPORT.md) -------------------------------
GAINSETS = {
    "soft":   dict(g_hi=0.25, g_lo=0.35, a0=0.10),
    "mid":    dict(g_hi=0.35, g_lo=0.50, a0=0.15),
    "strong": dict(g_hi=0.50, g_lo=0.70, a0=0.22),
}

# --- colour anchor mode (I8, 2026-08-18) ------------------------------------
# "lum"     : historical behaviour -- ONE scalar gain solved so mean LUMINANCE
#             hits LUM_TARGET x retail.  Hue/chroma drift of the upscaler and the
#             softclip's highlight desaturation both survive it.
# "rgb"     : solve a gain PER CHANNEL against LUM_TARGET x retail's per-channel
#             mean.  Strict generalisation of "lum" (matching all three channels
#             implies the luminance match), so it can only reduce colour drift.
# "rgb+sat" : "rgb", then one chroma scale about per-texel luma solved so mean
#             saturation matches retail's.  Recovers the -5..-10% saturation
#             the owner measured on 2026-08-17.
# Default stays "lum" so an r7 re-run reproduces r7 byte-for-byte; the take-5
# driver sets DATPATCH_COLOR_ANCHOR=rgb+sat explicitly and the colour ledger
# records which mode produced the corpus.
COLOR_ANCHOR = os.environ.get("DATPATCH_COLOR_ANCHOR", "lum")
SAT_GAIN_MIN, SAT_GAIN_MAX = 0.80, 1.40   # never "enhance", only restore
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
    # wrap-aware gradient: np.gradient's one-sided border differences put a
    # 1-texel bright/dark pipe on every tile edge (up to ~35% of SHADE_SPAN)
    p = np.pad(band.astype(np.float32), 1, mode="wrap")
    gv, gu = np.gradient(p)
    gv, gu = gv[1:-1, 1:-1], gu[1:-1, 1:-1]
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


def opaque_mask(a, alpha_cut=0.5):
    """Boolean mask of the texels the anchor is allowed to average over."""
    if a is not None and a.shape[-1] >= 4:
        m = a[..., 3] >= alpha_cut
        if m.any():
            return m
    return np.ones(a.shape[:2], bool)


def _mlum(a, mask):
    """Mean luminance over `mask` (a bool array on a's grid)."""
    if a is None:
        return None
    return float(lum(a[..., :3])[mask].mean())


def _ref_mask(base, W, H, alpha_cut=0.5):
    """The texel population the anchor averages over, on a (H, W) grid.

    Taken from the RETAIL reference's alpha when that alpha is a real cutout,
    resampled (nearest) to the candidate's grid; otherwise everything.  A fully
    opaque or fully transparent reference carries no information, so it falls
    back to the whole frame rather than to an empty or degenerate set."""
    full = np.ones((H, W), bool)
    if base is None or base.shape[-1] < 4:
        return full
    m = base[..., 3] >= alpha_cut
    if m.all() or not m.any():
        return full
    if m.shape == (H, W):
        return m
    im = Image.fromarray((m.astype(np.uint8) * 255))
    r = np.asarray(im.resize((W, H), Image.NEAREST), np.uint8) >= 128
    return r if r.any() else full


def chan_means(a, mask=None):
    """Per-channel mean over the opaque texels -> float64[3]."""
    m = opaque_mask(a) if mask is None else mask
    rgb = a[..., :3]
    return np.array([float(rgb[..., c][m].mean()) for c in range(3)], np.float64)


def mean_sat(a, mask=None):
    """Mean HSV saturation ((max-min)/max) over the opaque texels."""
    m = opaque_mask(a) if mask is None else mask
    px = a[..., :3][m]
    if px.size == 0:
        return 0.0
    mx = px.max(1)
    mn = px.min(1)
    return float(np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0).mean())


def _sat_scale(rgb, s):
    """Scale chroma about per-texel luma (hue and luma preserved to first
    order; luma exactly, since sum(w)=1 and the operation is affine in c)."""
    L = lum(rgb)[..., None]
    return np.clip(L + s * (rgb - L), 0.0, 1.0)


def _solve_sat(rgb, mask, target_sat):
    """Bisect the chroma scale so mean saturation hits retail's.

    Monotone in s, so 14 bisection steps give ~1e-4 of the bracket.  Solved on
    a strided subsample (<=256k texels): the estimator's own error is ~0.1%,
    two orders below the ledger's tripwire band, and a full-resolution solve
    would cost more than the whole rest of the bake on a 2048^2 tile."""
    idx = np.nonzero(mask)
    n = idx[0].size
    if n == 0:
        return 1.0
    step = max(1, n // 262144)
    ys, xs = idx[0][::step], idx[1][::step]
    sub = rgb[ys, xs, :]
    L = (0.299 * sub[:, 0] + 0.587 * sub[:, 1] + 0.114 * sub[:, 2])[:, None]

    def f(s):
        px = np.clip(L + s * (sub - L), 0.0, 1.0)
        mx = px.max(1)
        mn = px.min(1)
        return float(np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0).mean())

    lo, hi = SAT_GAIN_MIN, SAT_GAIN_MAX
    if f(lo) >= target_sat:
        return lo
    if f(hi) <= target_sat:
        return hi
    for _ in range(14):
        mid = 0.5 * (lo + hi)
        if f(mid) < target_sat:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def bake_texture(remacri, base, h, g_hi, g_lo, a0, lum_target=LUM_TARGET,
                 color_anchor=None):
    """-> (baked RGBA float array, info dict).

    `remacri` is the upscaled albedo we are shipping, `base` the RETAIL
    texture that anchors exposure and colour, `h` the seam height field
    (None => no emboss, anchor only).

    `color_anchor` (default: module-level COLOR_ANCHOR / DATPATCH_COLOR_ANCHOR):
      lum      - historical scalar mean-luminance anchor (r7 semantics)
      rgb      - per-channel mean anchor against lum_target x retail
      rgb+sat  - rgb, then a chroma scale matching retail's mean saturation
    """
    mode = (color_anchor or COLOR_ANCHOR or "lum").lower()
    out = remacri.copy()
    H, W = out.shape[:2]
    # THE ANCHOR'S TWO POPULATIONS MUST BE THE SAME SET OF TEXELS.
    # (I8 root-cause, 2026-08-18.)  The retail export carries real cutout alpha;
    # the Remacri corpus comes back FULLY OPAQUE with the cutout region filled
    # with whatever the upscaler painted there (usually black, sometimes white)
    # -- the real alpha is transplanted back only AFTER this function returns
    # (texture_lane.run_lane).  Averaging the reference over its cutout and the
    # candidate over the whole frame compares different pictures, and the solver
    # dutifully drives the gain to whatever closes that gap: measured 16.45x on
    # 0x060066B8 (a creature tile shipped as a PURE WHITE silhouette in r7) and
    # 0.5x the other way where the fill is bright.  160 of the 2,192 shipped r7
    # bakes (7.3%) are outside a +-15% band around the 1.15 anchor for exactly
    # this reason.  So: when the reference has a cutout, that cutout defines the
    # population for BOTH sides.
    amask = _ref_mask(base, W, H)
    lb = _mlum(base, _ref_mask(base, base.shape[1], base.shape[0])) \
        if base is not None else _mlum(remacri, amask)
    l_before = _mlum(remacri, amask)
    if h is not None:
        shade = shade_field(h, W, H, g_hi, g_lo, a0)
        out[:, :, :3] = out[:, :, :3] * shade[:, :, None]

    if mode == "lum":
        # --- exposure hard constraint: mean lum = lum_target * retail mean ----
        target = lum_target * lb
        g = 1.0
        rgb = out[:, :, :3]
        for _ in range(24):
            cand = softclip(rgb * g)
            m = float(lum(cand)[amask].mean())
            if abs(m - target) <= 1e-4 * max(target, 1e-3):
                break
            g *= target / max(m, 1e-6)
        out[:, :, :3] = np.clip(softclip(rgb * g), 0.0, 1.0)
        gain_info = float(g)
        sat_gain = 1.0
    else:
        # --- colour anchor: per-channel means (and optionally saturation) ----
        ref = base if base is not None else remacri
        rmask = _ref_mask(base, ref.shape[1], ref.shape[0]) if base is not None else amask
        mask = amask
        t_chan = lum_target * chan_means(ref, rmask)
        t_sat = mean_sat(ref, rmask) if mode == "rgb+sat" else None
        gain = np.ones(3, np.float64)
        sat_gain = 1.0
        rounds = 3 if t_sat is not None else 1
        for r in range(rounds):
            base_rgb = out[:, :, :3]
            for _ in range(24):
                cand = softclip(base_rgb * gain[None, None, :])
                cur = np.array([float(cand[..., c][mask].mean())
                                for c in range(3)], np.float64)
                if np.all(np.abs(cur - t_chan) <= 1e-4 * np.maximum(t_chan, 1e-3)):
                    break
                gain = gain * (t_chan / np.maximum(cur, 1e-6))
            out[:, :, :3] = np.clip(softclip(base_rgb * gain[None, None, :]),
                                    0.0, 1.0)
            if t_sat is None or r == rounds - 1:
                break
            # chroma restore, then let the next round re-assert the channel
            # anchor (the anchor is the hard constraint and must have the last
            # word; the sat scale is luma-preserving so it converges fast).
            s = _solve_sat(out[:, :, :3], mask, t_sat)
            out[:, :, :3] = _sat_scale(out[:, :, :3], s)
            sat_gain *= s
            gain = np.ones(3, np.float64)
        # Gains compose non-linearly through the softclip and across rounds, so
        # the honest single number is the NET luminance the pass achieved.
        gain_info = float(_mlum(out, amask) / max(l_before, 1e-6))
    info = dict(lum_base=lb, lum_remacri=l_before,
                lum_after=_mlum(out, amask),
                exposure_gain=gain_info, sat_gain=float(sat_gain),
                color_anchor=mode, embossed=h is not None,
                anchor_mask_frac=float(amask.mean()),
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

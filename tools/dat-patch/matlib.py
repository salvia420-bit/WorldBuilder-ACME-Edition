"""matlib.py -- the WHETHER gate + the height source.

  gate   : Surface(0x08) -> ReliefClass  (curated table, then the SigLIP kNN
           corpus classification, then Surface-field vetoes)
  height : rsId -> per-texel height in [0,1], 1 = proud face, 0 = groove bottom
           ("macro" = seam + speckle suppression + pillow, ported from
           holtburger-dat/src/height_seam.rs, itself the winner of the 10-way
           bake-off in gfx-material-agent/relief_op.py)

Texture source order: Remacri 4x upscale if we have it, else the base DAT
re-export.  Both are RGBA PNGs keyed by RenderSurface(0x06) id.
"""
import json
import os

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

# Every external path is env-overridable so the same vendored modules run on a
# box without /mnt/wbterminal2 (the buildbox).  Defaults unchanged.
TEX_BASE = os.environ.get("DATPATCH_TEX_BASE",
                          "/mnt/wbterminal2/tex-reexport-2026-07-30/")
REMACRI = [d for d in os.environ.get(
    "DATPATCH_REMACRI",
    "/mnt/wbterminal2/upscale-corpus/out/statics-remacri/:"
    "/mnt/wbterminal2/upscale-corpus/out/tranche1-remacri/").split(":") if d]
CLASSES_JSON = os.environ.get(
    "DATPATCH_CLASSES_JSON",
    "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/"
    "data/tex-relief-classes.compact.json")
CURATED_JSON = os.environ.get("DATPATCH_CURATED_JSON",
                              "/mnt/wbterminal2/gfx-material-agent/table.json")
CACHE = os.environ.get("DATPATCH_HCACHE", "/mnt/wbterminal2/dpc-work/hcache/")

# ---- height_seam.rs constants (the SHIPPED tuning; relief_op.py's 0.25 full
# was superseded by 0.12).  Global and absolute: never per-texture normalised.
PRE_BLUR = 0.6            # texels, as shipped -- calibrated on 128^2 tiles
# ROUND-2 FIX: PRE_BLUR is an ABSOLUTE texel count, but every other constant in
# the operator is a FRACTION of the tile.  On a 512^2 tile (or a Remacri 4x
# upscale) a 0.6-texel blur no longer removes the sub-structure the constant was
# there to remove, the tophat then answers to noise instead of joints, and the
# field saturates (measured: gate-wall 0x080016D9 carved 1.00 with mean height
# 0.06 -- a rigid recession, i.e. displacement is a no-op again).  Scaling the
# blur with the tile makes the operator actually resolution-independent, and it
# is also what makes seam-on-Remacri agree with seam-on-base.
PRE_BLUR_REF = 128.0
GROOVE_FRACS = (0.006, 0.012, 0.020)
GROOVE_WEIGHT = (1.0, 0.85, 0.65)
GROOVE_MIN = 0.05
GROOVE_FULL = 0.12
SEAM_WHITE = 0.5
ALPHA_CUT = 0.5
COMPONENT_MIN_AREA_FRAC = 0.01
COMPONENT_MIN_ELONGATION = 3.0
PILLOW_FRAC = 0.03
PILLOW_SEED_T = 0.5

CODE2CLASS = {"S": "Stone", "B": "Brick", "T": "Timber", "P": "Plank",
              "H": "Shingle", "F": "Flush", "C": "Cloth", "V": "Foliage",
              "U": "Unknown"}
MACRO_OK = ("Stone", "Brick", "Timber", "Plank", "Shingle")

# Outward amplitude in metres per class.  MAX_AMPLITUDE_M = 0.10 is the ceiling
# (gfx_subdiv.rs); coursed masonry gets the most, planks a little less.
CLASS_AMP = {"Brick": 0.060, "Stone": 0.070, "Timber": 0.080, "Plank": 0.055,
             "Shingle": 0.070, "Flush": 0.0, "Cloth": 0.0, "Foliage": 0.0,
             "Unknown": 0.0}
MAX_AMPLITUDE_M = 0.10

_kNN = None
_cur = None


def _tables():
    global _kNN, _cur
    if _kNN is None:
        _kNN = json.load(open(CLASSES_JSON))["classes"]
        _cur = json.load(open(CURATED_JSON))["final"]
    return _kNN, _cur


def classify(sid, surf):
    """sid: int Surface id, surf: gfxlib.Portal.surface() dict.  -> (class, why)"""
    knn, cur = _tables()
    key = "0x%08X" % sid
    if surf is None:
        return "Flush", "no surface record"
    t = surf["type"]
    if t & 0x4:
        return "Flush", "veto:Base1ClipMap (alpha cutout card)"
    if not (t & 0x2):
        return "Flush", "veto:Base1Solid (no texture)"
    if surf["translucency"] > 0.0:
        return "Flush", "veto:translucent %.2f" % surf["translucency"]
    if surf["luminosity"] > 0.0:
        return "Flush", "veto:luminous %.2f" % surf["luminosity"]
    if key in cur:
        return cur[key], "curated table"
    rs = surf.get("rsId")
    if rs and rs in knn:
        return CODE2CLASS.get(knn[rs], "Unknown"), "kNN corpus"
    return "Unknown", "unclassified"


def amp_for(cls):
    return min(CLASS_AMP.get(cls, 0.0), MAX_AMPLITUDE_M)


# ------------------------------------------------------------------ textures
# Deblock pre-stage (block-artifact report 2026-08-17): when a directory of
# deblock.py-filtered sources is supplied, it outranks the raw re-export so
# every consumer (height pass included) sees the grid-free source.  Populate
# with `python3 deblock.py batch ... --out $DATPATCH_DEBLOCK_BASE`.
DEBLOCK_BASE = os.environ.get("DATPATCH_DEBLOCK_BASE", "")


def tex_path(rs, prefer_remacri=True):
    if prefer_remacri:
        for d in REMACRI:
            p = d + rs + ".png"
            if os.path.exists(p):
                return p, "remacri"
    if DEBLOCK_BASE:
        p = os.path.join(DEBLOCK_BASE, rs + ".png")
        if os.path.exists(p):
            return p, "deblock"
    p = TEX_BASE + rs + ".png"
    if os.path.exists(p):
        return p, "base"
    return None, None


_texcache = {}


def load_tex(rs, prefer_remacri=True, max_side=512):
    """RGBA float array in [0,1]; downsampled to <= max_side for the height
    pass (the operator's radii are FRACTIONS of the tile, so the field is
    resolution independent -- but a 2048^2 morphology pass is not free)."""
    k = (rs, prefer_remacri, max_side)
    if k in _texcache:
        return _texcache[k]
    p, src = tex_path(rs, prefer_remacri)
    if p is None:
        return None, None
    im = Image.open(p).convert("RGBA")
    if max_side and max(im.size) > max_side:
        f = max_side / max(im.size)
        im = im.resize((max(1, int(im.width * f)), max(1, int(im.height * f))),
                       Image.LANCZOS)
    a = np.asarray(im, dtype=np.float32) / 255.0
    _texcache[k] = (a, src)
    return a, src


def load_tex_full(rs, prefer_remacri=True, max_side=1024):
    """For RENDERING (not the height pass): keep it big-ish but bounded."""
    p, src = tex_path(rs, prefer_remacri)
    if p is None:
        return None, None
    im = Image.open(p).convert("RGBA")
    if max_side and max(im.size) > max_side:
        f = max_side / max(im.size)
        im = im.resize((max(1, int(im.width * f)), max(1, int(im.height * f))),
                       Image.LANCZOS)
    return np.asarray(im, dtype=np.float32) / 255.0, src


# ------------------------------------------------------------ seam operator
def _lum(rgba):
    return (0.299 * rgba[:, :, 0] + 0.587 * rgba[:, :, 1]
            + 0.114 * rgba[:, :, 2]).astype(np.float32)


def _radii(shape):
    n = min(shape)
    out = []
    for f, w in zip(GROOVE_FRACS, GROOVE_WEIGHT):
        r = max(1, int(round(f * n)))
        if not any(rr == r for rr, _ in out):
            out.append((r, w))
    return out


def seam_t(rgba):
    """Per-texel smoothstepped seam response in [0,1] (1 = joint core)."""
    lum = _lum(rgba)
    alpha = rgba[:, :, 3]
    sigma = PRE_BLUR * max(1.0, min(lum.shape) / PRE_BLUR_REF)
    pre = ndi.gaussian_filter(lum, sigma, mode="wrap")
    strength = np.zeros_like(pre)
    for r, w in _radii(pre.shape):
        k = 2 * r + 1
        closing = ndi.grey_closing(pre, size=(k, k), mode="wrap")
        opening = ndi.grey_opening(pre, size=(k, k), mode="wrap")
        s = w * np.maximum(closing - pre, SEAM_WHITE * (pre - opening))
        np.maximum(strength, s, out=strength)
    t = np.clip((strength - GROOVE_MIN) / max(GROOVE_FULL - GROOVE_MIN, 1e-6), 0, 1)
    t = t * t * (3.0 - 2.0 * t)
    t[alpha < ALPHA_CUT] = 0.0
    return t.astype(np.float32), alpha


def suppress_speckle(t):
    """Zero every seam component that is neither a NET (large) nor a LINE
    (elongated).  This is what returns speckled stucco to flat."""
    h, w = t.shape
    mask = t >= 0.01
    if not mask.any():
        return t
    lab, n = ndi.label(mask, structure=np.ones((3, 3), bool))
    if n == 0:
        return t
    min_area = max(48, int(h * w * COMPONENT_MIN_AREA_FRAC))
    sizes = np.bincount(lab.ravel())
    keep = np.zeros(n + 1, bool)
    objs = ndi.find_objects(lab)
    for i in range(1, n + 1):
        if sizes[i] >= min_area:
            keep[i] = True
            continue
        sl = objs[i - 1]
        sub = (lab[sl] == i)
        ys, xs = np.nonzero(sub)
        ys = ys.astype(np.float64)
        xs = xs.astype(np.float64)
        ys -= ys.mean()
        xs -= xs.mean()
        cov = np.array([[(xs * xs).mean(), (xs * ys).mean()],
                        [(xs * ys).mean(), (ys * ys).mean()]])
        ev = np.linalg.eigvalsh(cov)
        ev = np.clip(ev, 1e-9, None)
        if np.sqrt(ev[1] / ev[0]) >= COMPONENT_MIN_ELONGATION:
            keep[i] = True
    t = t.copy()
    t[~keep[lab]] = 0.0
    return t


def relief_height(rgba):
    """MACRO height: seam carve + pillow.  [] (None) == genuinely flat."""
    t, alpha = seam_t(rgba)
    t = suppress_speckle(t)
    if not (t > 0).any():
        return None
    seeds = t >= PILLOW_SEED_T
    if not seeds.any():
        h = 1.0 - t
    else:
        # distance transform, wrapped (textures tile): tile 3x3 and take the
        # centre.  scipy has no periodic EDT; a 3x3 tile is exact for any
        # distance below the tile size, and the pillow radius is ~3%.
        H, W = t.shape
        big = np.tile(~seeds, (3, 3))
        d = ndi.distance_transform_edt(big)[H:2 * H, W:2 * W]
        r = max(2.0, PILLOW_FRAC * min(H, W))
        s = np.clip(d / r, 0, 1)
        h = (s * s * (3.0 - 2.0 * s)) * (1.0 - t)
    h[alpha < ALPHA_CUT] = 1.0
    if not (h < 0.999).any():
        return None
    # --- plateau normalisation (round 2) -------------------------------------
    # On a high-contrast masonry texture the absolute knee saturates: EVERY
    # texel exceeds GROOVE_FULL, the pillow's distance transform is seeded
    # everywhere, and the field comes back ~0 everywhere -- i.e. the wall
    # recedes rigidly and displacement is a no-op again (measured on the gate
    # wall 0x080016D9: carved fraction 1.00, mean height 0.06).
    #
    # This does NOT reintroduce the per-texture-normalisation trap the doctrine
    # forbids, because it runs strictly AFTER the gate has already decided this
    # surface carves at all: it can change the SHAPE of a carve, never create
    # one.  A flat texture still returns None above and never reaches here.
    p90 = float(np.percentile(h, 90))
    if p90 < 0.95 and p90 > 1e-3:
        h = np.clip(h / p90, 0.0, 1.0)
    return h.astype(np.float32)


def height_for(rs, prefer_remacri=True, max_side=512):
    """Cached height field for a RenderSurface id.  Returns (h, src) or (None, src)."""
    os.makedirs(CACHE, exist_ok=True)
    tag = "%s_%s_%d" % (rs, "rem" if prefer_remacri else "base", max_side)
    p = CACHE + tag + ".npy"
    ps = CACHE + tag + ".src"
    if os.path.exists(p):
        src = open(ps).read().strip() if os.path.exists(ps) else "?"
        a = np.load(p)
        return (None if a.size == 0 else a), src
    rgba, src = load_tex(rs, prefer_remacri, max_side)
    if rgba is None:
        return None, None
    h = relief_height(rgba)
    np.save(p, h if h is not None else np.zeros(0, np.float32))
    open(ps, "w").write(src or "?")
    return h, src


def carved_fraction(h):
    return float((h < 0.85).mean()) if h is not None else 0.0


# ------------------------------------------------------- DeepBump (ML) lane
DBCACHE = os.environ.get("DATPATCH_DBCACHE", "/mnt/wbterminal2/dpc-work/dbcache/")
DBPY = os.environ.get("DATPATCH_DBPY",
                      "/mnt/wbterminal2/deepbump-eval/venv/bin/python")
DBSCRIPT = os.environ.get("DATPATCH_DBSCRIPT",
                          "/mnt/wbterminal2/dpc-work/db_height.py")
SEAM_WEAK = 0.08          # carved fraction below which "seam found no network"


def deepbump_height(rs, invert=False):
    """ML albedo -> normal -> Frankot-Chellappa height, in [0,1].

    Complementary to seam, and the class decides which:
      * seam   = thin-LINE structure (mortar, plank gaps, beam joints)
      * ML     = BROAD form shading (creature hide, rock faces, muscle)
    Measured on this corpus (see REPORT): DeepBump recovers muscle lobes and
    rock fissures that seam is structurally blind to, but on brick it inherits
    albedo polarity (a dark brick sinks) -- which is the trap seam was built to
    avoid.  So it is a FALLBACK for relief-allowed surfaces where seam finds no
    line network, never a replacement.
    """
    import subprocess
    p = DBCACHE + rs + ".npy"
    if not os.path.exists(p):
        try:
            subprocess.run([DBPY, DBSCRIPT, rs], capture_output=True)
        except OSError:
            return None      # no ONNX venv on this box: seam-only lane
    if not os.path.exists(p):
        return None
    h = np.load(p)
    if invert:
        h = 1.0 - h
    # ML height is scale-free; keep 1 = proud (its own convention already is)
    return h.astype(np.float32)


def height_route(rs, cls, prefer_remacri=False, max_side=512, allow_ml=True):
    """-> (height, operator, carved_fraction, tex_source)."""
    if cls not in MACRO_OK and cls != "Organic":
        return None, "veto", 0.0, None
    if cls == "Organic":
        h = deepbump_height(rs) if allow_ml else None
        return h, ("deepbump" if h is not None else "none"), carved_fraction(h), "base"
    h, src = height_for(rs, prefer_remacri, max_side)
    cf = carved_fraction(h)
    if cf >= SEAM_WEAK or not allow_ml:
        return h, ("seam" if h is not None else "none"), cf, src
    hm = deepbump_height(rs)
    if hm is None:
        return h, ("seam" if h is not None else "none"), cf, src
    return hm, "deepbump", carved_fraction(hm), "base"

#!/usr/bin/env python3
"""
terrain_macro — offline generator for the FAR-TERRAIN macro modulation array.

WHY THIS EXISTS
---------------
AC's ground textures are 32-256 px tiles stretched over 24 m cells. Past ~50 m
the client's detail-diffuse layer fades out (`uDetailTexFadeEnd`, terrain.js)
and every mip level above ~3 has averaged the tile down to a near-flat colour
patch. The result is the "mspaint" read the user reported: large uniform
colour fields with the retail TexMerge alpha masks drawing hard hand-drawn
borders along the 24 m cell grid.

This script bakes, PER TERRAIN FAMILY, a 1024x1024 tileable MODULATION map that
the terrain shader multiplies into the distant albedo (MODULATE2X: a texel of
0.5 is exactly 1.0x, i.e. neutral). It is NOT a replacement albedo:

  * the DAT still decides which terrain type is where — nothing about placement,
    codes, masks or blending changes;
  * the mean of every channel is pinned to 0.5, so the AVERAGE colour of a
    distant grass field is bit-preserved. Only its STRUCTURE changes.

That is what keeps WorldBuilder the source of truth while killing the flatness.

WHAT GOES INTO A MACRO
----------------------
Everything is derived from the shipped ground textures themselves
(`scene3d/assets/pbr_terrain/L<NN>_color_1k.png`, which is what the atlas
actually renders with when ?pbrTerrain is on — the default), so the palette
stays Dereth's:

  1. multi-octave periodic value-noise fBm  -> large-scale luminance patchiness
  2. ridged noise                           -> organic, non-blobby structure
     (reads as tree-cover / rock strata rather than as lava-lamp blobs)
  3. CHROMA remix: the family's own member layers have real hue spread
     (LushGrass vs PatchyGrassland vs Moss). Their mean colours are blended by a
     low-frequency mask, so distant grass drifts between the family's OWN
     authored greens instead of sitting on one average green.
  4. mid-scale grain lifted from the real tiles: each source tile, contrast-
     normalised to mean 1.0, tiled 4x and 8x across the macro. This is the
     "tile + noise remix at higher effective resolution" — real retail/CC0
     surface grain surviving out to a few hundred metres, where the mip chain
     had erased it.

All noise is PERIODIC (integer-lattice wrap), so the 1024^2 result tiles
seamlessly and the shader can sample it at two different world scales.

USAGE
-----
    python3 generate.py            # writes macro_<family>.png + manifest.json
    python3 generate.py --preview  # also writes preview_<family>.png (x2.5 gain)

Deterministic: fixed seeds per family, so a re-run is byte-identical.
"""

import json
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "pbr_terrain")
SIZE = 1024

# Terrain code -> family membership mirrors scene3d/terrain_families.js BASE_FAMILY.
# THE RULE (terrain_families.js): family membership is a property of the CODE.
# Water (16-20, 22) and olthoi (30) are deliberately absent: water is the water
# agent's surface and olthoi has no curated CC0 layer.
FAMILIES = {
    # name        source terrain codes         seed
    "grass":     ([1, 3, 9, 21, 28, 29],       11),
    "sand":      ([10, 11, 12],                22),
    "rock":      ([0, 13, 14],                 33),
    "snowice":   ([2, 15, 27],                 44),
    "swamp":     ([4, 23],                     55),
    "volcano":   ([6, 25, 26],                 66),
    "dirt":      ([5, 7, 8, 24, 31],           77),
}
# Slice order in the DataArrayTexture. Must match TERRAIN_MACRO_KEYS in adapter.js.
FAMILY_ORDER = ["grass", "sand", "rock", "snowice", "swamp", "volcano", "dirt"]

# Per-family amplitudes. Rock/volcano carry more macro contrast (real rock has
# strong strata); snow carries least (snowfields genuinely ARE flat, and noise
# on snow reads as dirt).
#            lum   chroma  grain  ridge
AMPS = {
    "grass":   (0.135, 0.085, 0.075, 0.055),
    "sand":    (0.080, 0.040, 0.060, 0.030),
    "rock":    (0.150, 0.055, 0.090, 0.075),
    "snowice": (0.055, 0.025, 0.040, 0.025),
    "swamp":   (0.130, 0.080, 0.070, 0.050),
    "volcano": (0.160, 0.070, 0.085, 0.080),
    "dirt":    (0.125, 0.070, 0.080, 0.055),
}


# ---------------------------------------------------------------- noise ------
def _periodic_value_noise(size, period, rng):
    """Bilinear value noise on an integer lattice of `period` cells, wrapping."""
    lat = rng.random((period, period)).astype(np.float32)
    # quintic fade for C1 continuity (same curve as fragFade in terrain.js)
    t = (np.arange(size, dtype=np.float32) / size) * period
    i0 = np.floor(t).astype(np.int32) % period
    i1 = (i0 + 1) % period
    f = t - np.floor(t)
    f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0)

    a = lat[np.ix_(i0, i0)]
    b = lat[np.ix_(i1, i0)]
    c = lat[np.ix_(i0, i1)]
    d = lat[np.ix_(i1, i1)]
    fx = f[:, None]
    fy = f[None, :]
    return (a * (1 - fx) * (1 - fy) + b * fx * (1 - fy)
            + c * (1 - fx) * fy + d * fx * fy)


def fbm(size, base_period, octaves, rng, gain=0.58, lacunarity=2):
    out = np.zeros((size, size), np.float32)
    amp, norm, period = 1.0, 0.0, base_period
    for _ in range(octaves):
        out += amp * _periodic_value_noise(size, period, rng)
        norm += amp
        amp *= gain
        period *= lacunarity
    out /= norm
    return out - out.mean()


def ridged(size, base_period, octaves, rng):
    out = np.zeros((size, size), np.float32)
    amp, norm, period = 1.0, 0.0, base_period
    for _ in range(octaves):
        n = _periodic_value_noise(size, period, rng)
        out += amp * (1.0 - np.abs(n * 2.0 - 1.0))
        norm += amp
        amp *= 0.55
        period *= 2
    out /= norm
    return out - out.mean()


# --------------------------------------------------------------- sources -----
def load_layer(code):
    for name in (f"L{code:02d}_color_1k.png", f"L{code:02d}_color.png"):
        p = os.path.join(SRC, name)
        if os.path.exists(p):
            im = Image.open(p).convert("RGB")
            return np.asarray(im, dtype=np.float32) / 255.0
    return None


def tiled_grain(tile, size, reps, rng):
    """Contrast-normalised (mean 1.0) luminance grain of `tile`, tiled `reps`x.

    Each repeat gets an independent 90-degree rotation + flip so the grid does
    not read as a grid. Cheap stand-in for real texture synthesis; at the
    distances this map is used it is indistinguishable from one."""
    cell = size // reps
    small = np.asarray(
        Image.fromarray((np.clip(tile, 0, 1) * 255).astype(np.uint8)).resize(
            (cell, cell), Image.LANCZOS),
        dtype=np.float32) / 255.0
    lum = small @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    lum = lum / max(lum.mean(), 1e-5)
    out = np.zeros((size, size), np.float32)
    for ry in range(reps):
        for rx in range(reps):
            v = np.rot90(lum, rng.integers(0, 4))
            if rng.integers(0, 2):
                v = v[:, ::-1]
            out[ry * cell:(ry + 1) * cell, rx * cell:(rx + 1) * cell] = v
    return out - out.mean()


# ----------------------------------------------------------------- build -----
def build_family(name, codes, seed):
    rng = np.random.default_rng(seed)
    amp_lum, amp_chroma, amp_grain, amp_ridge = AMPS[name]

    tiles = [t for t in (load_layer(c) for c in codes) if t is not None]
    if not tiles:
        print(f"  !! {name}: no source layers on disk, using noise only",
              file=sys.stderr)

    # --- 1/2. luminance fBm + ridged structure -------------------------------
    # base_period 4 (not 2): a 2x2 lattice is inherently mirror-symmetric and
    # the macro read as a lava lamp. 4 over a 96 m tile => ~24 m coarsest cell.
    lum = fbm(SIZE, 4, 6, rng)
    lum *= amp_lum / max(lum.std() * 2.2, 1e-5)
    rid = ridged(SIZE, 5, 4, rng)
    rid *= amp_ridge / max(rid.std() * 2.2, 1e-5)

    # --- 4. mid-scale grain from the real tiles ------------------------------
    grain = np.zeros((SIZE, SIZE), np.float32)
    if tiles:
        grain += 0.60 * tiled_grain(tiles[0], SIZE, 6, rng)
        grain += 0.40 * tiled_grain(tiles[min(1, len(tiles) - 1)], SIZE, 12, rng)
        # std-normalise, NOT max: a handful of outlier texels in the source tile
        # was scaling the whole grain layer to invisibility.
        g = grain.std()
        if g > 1e-5:
            grain *= (amp_grain / (g * 2.2))

    mono = lum + rid + grain          # shared across RGB -> pure value variation

    # --- 3. chroma remix across the family's own member colours --------------
    rgb = np.repeat(mono[:, :, None], 3, axis=2)
    if len(tiles) >= 2:
        means = np.array([t.reshape(-1, 3).mean(axis=0) for t in tiles],
                         dtype=np.float32)
        fam_mean = means.mean(axis=0)
        fam_mean = np.maximum(fam_mean, 1e-4)
        # per-member RATIO to the family mean, mean-centred -> a pure hue push
        ratios = means / fam_mean          # (n,3), each ~1.0
        # low-frequency selector picks which member this patch drifts toward
        # domain-warped selector: a plain low-frequency fBm gave round blobs.
        wx = fbm(SIZE, 3, 2, rng) * 0.45
        sel = fbm(SIZE, 5, 3, rng) + wx
        sel = (sel - sel.min()) / max(sel.max() - sel.min(), 1e-5)  # 0..1
        idx = np.clip((sel * len(tiles)).astype(np.int32), 0, len(tiles) - 1)
        # smooth between neighbouring members instead of hard-switching
        frac = np.clip(sel * len(tiles) - idx, 0.0, 1.0)
        idx2 = np.minimum(idx + 1, len(tiles) - 1)
        chroma = (ratios[idx] * (1.0 - frac[:, :, None])
                  + ratios[idx2] * frac[:, :, None]) - 1.0
        chroma -= chroma.reshape(-1, 3).mean(axis=0)
        # ATTENUATE ONLY, never amplify. `ratios` are the family's OWN member
        # colours, so interpolating between them can only ever produce a colour
        # a real Dereth layer already has. Scaling that spread UP would
        # extrapolate outside it -- and for grass the "less green" direction
        # extrapolates straight into magenta, which is the exact artefact the
        # user complained about in pass 1. min(1, ...) forbids it.
        cstd = chroma.reshape(-1, 3).std()
        if cstd > 1e-5:
            chroma *= min(1.0, amp_chroma / (cstd * 2.2))
        rgb = rgb + chroma

    # --- encode MODULATE2X, mean pinned to exactly 0.5 -----------------------
    rgb = rgb - rgb.reshape(-1, 3).mean(axis=0)
    # Soft-clip the tails. The fBm+ridge+grain sum is roughly Gaussian, so a
    # raw encode put a handful of texels at 0.0 => a 0.0x multiplier => a black
    # speck on a hillside. tanh is ~linear inside +-0.15 (where 99% of the
    # energy lives) and asymptotes at +-MACRO_CLIP, i.e. a bounded
    # [1-2*CLIP, 1+2*CLIP] multiplier before the shader's strength scale.
    MACRO_CLIP = 0.30
    out = 0.5 + MACRO_CLIP * np.tanh(rgb / MACRO_CLIP)
    # +-0.5 LSB triangular dither: the map is a smooth large-scale gradient and
    # 8-bit quantisation of a +-0.13 range would band visibly on a hillside.
    out += (rng.random((SIZE, SIZE, 3), dtype=np.float32)
            - rng.random((SIZE, SIZE, 3), dtype=np.float32)) / 512.0
    out = np.clip(out, 0.0, 1.0)
    return (out * 255.0 + 0.5).astype(np.uint8)


def main():
    preview = "--preview" in sys.argv
    manifest = {
        "note": "far-terrain macro modulation maps (MODULATE2X, 0.5 = neutral, "
                "linear/NoColorSpace, tileable). Generated by generate.py.",
        "size": SIZE,
        "encoding": "modulate2x",
        "slices": FAMILY_ORDER,
        "families": {},
    }
    for slot, name in enumerate(FAMILY_ORDER):
        codes, seed = FAMILIES[name]
        print(f"[{slot}] {name}: codes={codes}")
        px = build_family(name, codes, seed)
        Image.fromarray(px, "RGB").save(
            os.path.join(HERE, f"macro_{name}.png"), optimize=True)
        manifest["families"][name] = {"slice": slot, "codes": codes}
        if preview:
            amp = np.clip((px.astype(np.float32) - 128.0) * 2.5 + 128.0, 0, 255)
            Image.fromarray(amp.astype(np.uint8), "RGB").save(
                os.path.join(HERE, f"preview_{name}.png"))
    with open(os.path.join(HERE, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print("wrote", len(FAMILY_ORDER), "macro maps + manifest.json")


if __name__ == "__main__":
    main()

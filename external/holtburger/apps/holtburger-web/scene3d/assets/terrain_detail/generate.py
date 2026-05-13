#!/usr/bin/env python3
"""Phase 1.2 — procedural terrain detail-normal generator.

Produces 5 seamlessly-tileable 1024x1024 RGB normal-map PNGs for the
terrain ShaderMaterial's high-frequency normal overlay.

Per-tile pipeline:

    1. Build a deterministic grayscale heightmap from layered seamless
       value-noise (per-category octaves + a category-specific shaper:
       anisotropic stretch for sand, blade-mask for grass, ...).
    2. Finite-difference the heightmap into a normal map:
           nx = (h(x+1, y) - h(x-1, y)) * strength
           ny = (h(x, y+1) - h(x, y-1)) * strength
           nz = 1.0
       Normalise, encode as `(n * 0.5 + 0.5) * 255` so flat ground is
       the canonical (128, 128, 255) tangent-space normal.

Seams: value-noise lattice wraps with one row+column of padding (per
Phase 0.2's generator) so bilinear interpolation lands on the opposite
edge. Finite-difference uses `np.roll` so the gradient is also seamless.

    python3 generate.py     (regenerates all 5 PNGs in cwd)

Pillow + NumPy only. Deterministic — seeds + octave parameters baked
into the script.

Mapping to terrain-code slice indices (see ../../terrain.js docstring):

    0 = grass   → terrain_grass_normal.png
    1 = dirt    → terrain_dirt_normal.png
    2 = sand    → terrain_sand_normal.png
    3 = stone   → terrain_stone_normal.png
    4 = snow    → terrain_snow_normal.png
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

TILE = 1024
HERE = Path(__file__).parent


def _seamless_value_noise(rng: np.random.Generator, freq: int) -> np.ndarray:
    """Periodic value noise on TILE x TILE upsampled bilinearly from a
    freq x freq lattice. Lattice wraps so the upsampled image tiles
    seamlessly. Ported from Phase 0.2's generate.py."""
    lattice = rng.random((freq, freq), dtype=np.float32)
    pad = np.empty((freq + 1, freq + 1), dtype=np.float32)
    pad[:freq, :freq] = lattice
    pad[freq, :freq] = lattice[0, :]
    pad[:freq, freq] = lattice[:, 0]
    pad[freq, freq] = lattice[0, 0]
    xs = np.linspace(0, freq, TILE, endpoint=False, dtype=np.float32)
    ys = np.linspace(0, freq, TILE, endpoint=False, dtype=np.float32)
    x0 = xs.astype(np.int32)
    y0 = ys.astype(np.int32)
    fx = xs - x0
    fy = ys - y0
    out = np.empty((TILE, TILE), dtype=np.float32)
    for j in range(TILE):
        a = pad[y0[j], x0]
        b = pad[y0[j], x0 + 1]
        c = pad[y0[j] + 1, x0]
        d = pad[y0[j] + 1, x0 + 1]
        ab = a * (1 - fx) + b * fx
        cd = c * (1 - fx) + d * fx
        out[j] = ab * (1 - fy[j]) + cd * fy[j]
    return out


def _fbm(seed: int, freqs: list[int], weights: list[float]) -> np.ndarray:
    """Seamless fbm: sum of value-noise octaves at given lattice freqs."""
    rng = np.random.default_rng(seed)
    acc = np.zeros((TILE, TILE), dtype=np.float32)
    for f, w in zip(freqs, weights):
        acc += w * _seamless_value_noise(rng, f)
    acc -= acc.min()
    rng_max = acc.max()
    if rng_max > 1e-6:
        acc /= rng_max
    return acc


def _heightmap_to_normal(height: np.ndarray, strength: float = 4.0) -> np.ndarray:
    """Finite-difference a seamless heightmap into a tangent-space normal.
    Uses np.roll so the gradient wraps with the heightmap.

    Returns float32 (TILE, TILE, 3) with components in [-1, 1].
    """
    # Central difference, wrap on both axes.
    hx_p = np.roll(height, -1, axis=1)
    hx_n = np.roll(height, 1, axis=1)
    hy_p = np.roll(height, -1, axis=0)
    hy_n = np.roll(height, 1, axis=0)
    nx = -(hx_p - hx_n) * strength
    ny = -(hy_p - hy_n) * strength
    nz = np.ones_like(nx)
    norm = np.sqrt(nx * nx + ny * ny + nz * nz)
    return np.stack([nx / norm, ny / norm, nz / norm], axis=-1)


def _encode_normal(n: np.ndarray) -> np.ndarray:
    """Pack a (..., 3) float [-1,1] normal into uint8 RGB with flat = 128,128,255."""
    return np.clip((n * 0.5 + 0.5) * 255.0 + 0.5, 0, 255).astype(np.uint8)


def _save_normal(name: str, normal_uint8: np.ndarray) -> None:
    out = HERE / f"{name}.png"
    Image.fromarray(normal_uint8, mode="RGB").save(out, format="PNG", optimize=True)
    mean_b = int(normal_uint8[..., 2].mean())
    print(f"  wrote {out.name:32s}  meanB={mean_b}  (flat=255)")


# ---------------------------------------------------------------------
# Per-category heightmap generators.
# ---------------------------------------------------------------------


def grass_heightmap() -> np.ndarray:
    """Irregular blade-like pattern. Two octaves of dense noise mixed
    with a sparse threshold mask that simulates individual blades."""
    rng = np.random.default_rng(110011)
    fine = _seamless_value_noise(rng, 256)
    fine = (fine - fine.min()) / max(1e-6, (fine.max() - fine.min()))
    # Sparse blade mask: threshold a high-freq channel to ~15% coverage.
    blade_noise = _seamless_value_noise(rng, 384)
    blade_mask = (blade_noise > 0.78).astype(np.float32)
    # Combine: base ground micro-detail (40%) + raised blade bumps (60%).
    return 0.4 * fine + 0.6 * blade_mask


def dirt_heightmap() -> np.ndarray:
    """Fine isotropic grain — no dominant direction. Three octaves of
    high-freq noise summed."""
    return _fbm(seed=220022, freqs=[128, 256, 384], weights=[0.5, 0.3, 0.2])


def sand_heightmap() -> np.ndarray:
    """Anisotropic drift pattern. Base is fine isotropic grain; on top
    we lay long parallel ridges along the X axis to give the wind-drift
    look. The detail UV will be rotated at runtime by uWindDir so the
    drift direction tracks the wind uniform.
    """
    rng = np.random.default_rng(330033)
    # Fine grain base — sand particles.
    fine = _seamless_value_noise(rng, 384) * 0.3
    # Anisotropic drifts: cosine ridges along X, phase-jittered by a low
    # frequency along Y. ~12 ridges per tile so the player sees
    # several across a sample.
    xs = np.linspace(0, 2 * np.pi, TILE, endpoint=False, dtype=np.float32)
    ys = np.linspace(0, 2 * np.pi, TILE, endpoint=False, dtype=np.float32)
    jitter_x = _seamless_value_noise(rng, 8) * 2.0
    jitter_y = _seamless_value_noise(rng, 12) * 0.5
    # Ridge phase = 12*ys + jitter(x,y) so the ridges are roughly
    # constant-Y bands that wobble. (Y becomes "across the drift".)
    phase = 12.0 * ys[:, None] + jitter_x
    ridges = 0.5 + 0.5 * np.cos(phase + jitter_y)
    # Boost ridge contrast — sand drifts are sharp on the windward face.
    ridges = np.clip(ridges ** 1.6, 0.0, 1.0)
    return 0.3 * fine + 0.7 * ridges


def stone_heightmap() -> np.ndarray:
    """Crack + pebble pattern. Sparse high-contrast spots (pebbles)
    embedded in lower-freq noise (rock). Cracks come from thresholding
    a wide-band fbm and inverting the thin lines.
    """
    rng = np.random.default_rng(440044)
    # Pebble field: high-freq value noise with a contrast bump.
    pebbles_n = _seamless_value_noise(rng, 192)
    pebbles = np.clip((pebbles_n - 0.4) * 2.2, 0.0, 1.0)
    # Cracks: a different freq, thresholded around 0.5 to produce thin
    # lines, then inverted.
    cracks_n = _seamless_value_noise(rng, 96)
    crack_mask = ((cracks_n > 0.485) & (cracks_n < 0.515)).astype(np.float32)
    # Cracks should sit lower than the pebble plane (negative height).
    return 0.65 * pebbles - 0.45 * crack_mask + 0.4


def snow_heightmap() -> np.ndarray:
    """Drift + crystal pattern. Low-freq drifts (wind on snow) plus a
    sparse crystal-spike mask for sparkle reflections. Softer than
    sand — snow drifts are rounded.
    """
    rng = np.random.default_rng(550055)
    # Soft drifts: low-freq fbm, gently rolling.
    drifts = _fbm(seed=550055, freqs=[16, 64, 128], weights=[0.6, 0.25, 0.15])
    # Crystal spikes: very sparse high-freq peaks.
    spike_n = _seamless_value_noise(rng, 512)
    spikes = (spike_n > 0.93).astype(np.float32)
    return 0.8 * drifts + 0.4 * spikes


# ---------------------------------------------------------------------
# Per-category normal strength. Larger feature size on snow & sand
# (looser drifts), tighter on grass & dirt (high-frequency detail).
# ---------------------------------------------------------------------

STRENGTHS = {
    "terrain_grass_normal": 6.0,   # punchy — blade tips read crisp
    "terrain_dirt_normal": 5.0,    # fine — granular feel
    "terrain_sand_normal": 7.0,    # strong — drifts cast subtle shading
    "terrain_stone_normal": 8.0,   # high — pebbles + cracks
    "terrain_snow_normal": 4.0,    # softer — rounded drifts
}


def main() -> int:
    HERE.mkdir(parents=True, exist_ok=True)
    print(f"Generating Phase 1.2 terrain detail normals in {HERE}")
    print(f"  tile size: {TILE}x{TILE}  format: RGB normal (flat=128,128,255)")

    generators = [
        ("terrain_grass_normal", grass_heightmap),
        ("terrain_dirt_normal", dirt_heightmap),
        ("terrain_sand_normal", sand_heightmap),
        ("terrain_stone_normal", stone_heightmap),
        ("terrain_snow_normal", snow_heightmap),
    ]
    for name, fn in generators:
        h = fn()
        # Normalise heightmap to [0, 1] before differentiating so the
        # `strength` parameter is comparable across categories.
        h = (h - h.min()) / max(1e-6, (h.max() - h.min()))
        n = _heightmap_to_normal(h, strength=STRENGTHS[name])
        _save_normal(name, _encode_normal(n))

    return 0


if __name__ == "__main__":
    sys.exit(main())

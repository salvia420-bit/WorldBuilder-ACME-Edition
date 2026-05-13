#!/usr/bin/env python3
"""Phase 0.2 — procedural grayscale detail-tile generator.

Produces 5 seamlessly-tileable 512x512 grayscale PNG tiles used as
high-frequency overlays composited over the diffuse layer for surfaces
that carry the AC `Detail (0x20000)` surface_type bit.

Each tile is a deterministic mix of value-noise octaves plus a category-
specific shaping operator (anisotropy / directional warp / threshold).
All seeds, octave counts and shaping constants are baked into this
script so the output is exactly reproducible:

    python3 generate.py                            (regenerates all tiles in cwd)

Mean brightness is held near 0.5 so that the shader composite
`mix(diffuse, diffuse * detail, blendFactor)` neither darkens nor
brightens the surface on average — only modulates it.

Categories produced:
    generic-rough.png   — isotropic high-frequency value noise
    stone-grain.png     — coarser noise + slight thresholding (pebble feel)
    wood-grain.png      — anisotropic stripes (vertical grain)
    fabric-weave.png    — orthogonal weave pattern (warp+weft)
    sand-grain.png      — fine high-frequency noise (dense grain)

No external assets, no internet. Pillow + NumPy only.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image

TILE = 512
HERE = Path(__file__).parent


def _seamless_value_noise(rng: np.random.Generator, freq: int) -> np.ndarray:
    """Periodic value noise on a TILE x TILE grid, bilinearly upsampled
    from a freq x freq lattice. The lattice wraps so the upsampled image
    is exactly seamless when tiled."""
    lattice = rng.random((freq, freq), dtype=np.float32)
    # Pad with a wrap-around row+column so bilinear interp lands on the
    # opposite edge — guarantees seamless tiling.
    pad = np.empty((freq + 1, freq + 1), dtype=np.float32)
    pad[:freq, :freq] = lattice
    pad[freq, :freq] = lattice[0, :]
    pad[:freq, freq] = lattice[:, 0]
    pad[freq, freq] = lattice[0, 0]
    # Bilinear upsample.
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
    """Fractal Brownian motion: sum of value-noise octaves with given
    base frequencies and weights. Output is normalised to mean=0.5,
    contrast modest."""
    rng = np.random.default_rng(seed)
    acc = np.zeros((TILE, TILE), dtype=np.float32)
    for f, w in zip(freqs, weights):
        acc += w * _seamless_value_noise(rng, f)
    acc -= acc.mean()
    rms = np.sqrt((acc * acc).mean())
    if rms > 1e-6:
        acc /= rms
    # Normalise to mean ~0.5 with std ~0.15 so the composite stays mild.
    return np.clip(0.5 + 0.15 * acc, 0.0, 1.0)


def _save(name: str, gray: np.ndarray) -> None:
    arr = (gray * 255.0 + 0.5).astype(np.uint8)
    img = Image.fromarray(arr, mode="L")
    out = HERE / f"{name}.png"
    img.save(out, format="PNG", optimize=True)
    print(f"  wrote {out.name:24s}  mean={arr.mean():.1f}  std={arr.std():.1f}")


def generic_rough() -> np.ndarray:
    # Wide-band isotropic noise. Three octaves, balanced weights.
    return _fbm(seed=10001, freqs=[16, 64, 256], weights=[0.5, 0.3, 0.2])


def stone_grain() -> np.ndarray:
    # Coarser dominant frequency + a soft contrast bump so the highs and
    # lows separate into "pebbles" without going binary.
    base = _fbm(seed=20002, freqs=[8, 32, 128], weights=[0.55, 0.3, 0.15])
    contrast = (base - 0.5) * 1.4 + 0.5
    return np.clip(contrast, 0.0, 1.0)


def wood_grain() -> np.ndarray:
    # Strong vertical stripe field plus a soft ring-warp. Anisotropic.
    rng = np.random.default_rng(30003)
    base = _seamless_value_noise(rng, 128)
    # Stripes along Y: derive a sine wave whose phase wanders with X.
    xs = np.linspace(0, 2 * np.pi, TILE, endpoint=False, dtype=np.float32)
    ys = np.linspace(0, 2 * np.pi, TILE, endpoint=False, dtype=np.float32)
    # Wavy vertical grain — frequency 24 rings across the tile, phase
    # jittered by low-freq noise so it doesn't look like a barcode.
    jitter = _seamless_value_noise(rng, 8)
    phase = 24.0 * xs[None, :] + 1.5 * jitter
    stripes = 0.5 + 0.4 * np.cos(phase)
    grain = 0.7 * stripes + 0.3 * base
    # Mean-center + scale.
    grain -= grain.mean()
    rms = np.sqrt((grain * grain).mean())
    if rms > 1e-6:
        grain /= rms
    return np.clip(0.5 + 0.18 * grain, 0.0, 1.0)


def fabric_weave() -> np.ndarray:
    # Orthogonal warp + weft sine bands modulated by a low-freq noise
    # so it doesn't look too synthetic.
    rng = np.random.default_rng(40004)
    xs = np.linspace(0, 2 * np.pi, TILE, endpoint=False, dtype=np.float32)
    ys = np.linspace(0, 2 * np.pi, TILE, endpoint=False, dtype=np.float32)
    # 32 warp and 32 weft cycles per tile.
    warp = 0.5 + 0.35 * np.cos(32.0 * xs[None, :])
    weft = 0.5 + 0.35 * np.cos(32.0 * ys[:, None])
    weave = (warp + weft) * 0.5
    noise = _seamless_value_noise(rng, 16)
    out = 0.8 * weave + 0.2 * noise
    out -= out.mean()
    rms = np.sqrt((out * out).mean())
    if rms > 1e-6:
        out /= rms
    return np.clip(0.5 + 0.18 * out, 0.0, 1.0)


def sand_grain() -> np.ndarray:
    # Very high-frequency dense noise — small grain feel.
    return _fbm(seed=50005, freqs=[128, 256, 384], weights=[0.5, 0.3, 0.2])


def main() -> int:
    HERE.mkdir(parents=True, exist_ok=True)
    print(f"Generating Phase 0.2 detail tiles in {HERE}")
    _save("generic-rough", generic_rough())
    _save("stone-grain", stone_grain())
    _save("wood-grain", wood_grain())
    _save("fabric-weave", fabric_weave())
    _save("sand-grain", sand_grain())
    return 0


if __name__ == "__main__":
    sys.exit(main())

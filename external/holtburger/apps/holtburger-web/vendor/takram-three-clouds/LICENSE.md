# Third-party license attribution — vendor/takram-three-clouds

This directory vendors source from `@takram/three-clouds@0.7.6`
(https://github.com/takram-design-engineering/three-geospatial,
package `packages/clouds/`) for the volumetric cloud system. The
vendored source is unmodified as of 2026-05-15. See `CHANGELOG.md`
in this directory for upstream version history; see
`docs/skybox-volumetric-clouds-handoff-2026-05-15.md` in the repo
root for our integration plan (Clouds-A through Clouds-G).

The compiled runtime is loaded from CDN
(`https://cdn.jsdelivr.net/npm/@takram/three-clouds@0.7.6/...`) via
the importmap in `apps/holtburger-web/index.html`. The TypeScript
source in `src/` is kept side-by-side for future modification
(Clouds-B onward) and for type-check reference.

## Licenses

### `@takram/three-clouds` and `@takram/three-atmosphere` (vendored, CDN-loaded)

MIT License. Copyright (c) 2024 Shota Matsuda. See `LICENSE`
alongside this file for the full text. The compiled CDN modules
also carry the MIT terms.

### Bruneton precomputed atmospheric scattering (referenced via `shaders/bruneton-reference/`)

Copyright (c) 2017 Eric Bruneton. BSD-3-Clause license.
Source: https://github.com/ebruneton/precomputed_atmospheric_scattering

The GLSL files in `shaders/bruneton-reference/` are kept verbatim
(license header preserved in each `.glsl` file) for reference
during Clouds-B's Bruneton decoupling surgery. Once Clouds-B
ships, these files document what we replaced.

### Sébastien Hillaire TileableVolumeNoise (embedded in `src/shaders/tileableNoise.glsl`)

MIT License. Copyright (c) 2017 Sébastien Hillaire.
Source: https://github.com/sebh/TileableVolumeNoise
Full license header is preserved inside `src/shaders/tileableNoise.glsl`.

### `postprocessing` (pmndrs, peer dependency, CDN-loaded)

Zlib license. Copyright 2015-2025 Raoul van Rüschen.
Source: https://github.com/pmndrs/postprocessing
GPL/AGPL-compatible per https://www.gnu.org/licenses/license-list.html#Zlib.

### `tiny-invariant` (transitive dependency, CDN-loaded)

MIT License. Copyright (c) 2019 Alexander Reardon.
Source: https://github.com/alexreardon/tiny-invariant

### `type-fest` (transitive dependency, type-only)

CC0-1.0 / MIT dual-licensed. Copyright (c) Sindre Sorhus.
Source: https://github.com/sindresorhus/type-fest

## Compatibility with WorldBuilder-ACME-Edition AGPL-3.0

All upstream licenses listed above are AGPL-3.0-compatible.

- MIT — explicitly compatible per https://www.gnu.org/licenses/license-list.html#Expat
- BSD-3-Clause — explicitly compatible per https://www.gnu.org/licenses/license-list.html#ModifiedBSD
- Zlib — explicitly compatible per https://www.gnu.org/licenses/license-list.html#Zlib
- CC0-1.0 — explicitly compatible per https://www.gnu.org/licenses/license-list.html#CC0

Re-verify if any sub-dependency is added in future phases.

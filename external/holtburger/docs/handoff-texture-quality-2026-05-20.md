# Handoff — Texture quality (ground + buildings) — 2026-05-20

## The complaint

In the browser AC client at `?renderer=3d&quality=ultra&clouds=on&aurora=on`,
terrain looks low-detail / repetitive even after a chain of fixes; buildings
also visibly look low-texture. User has eyeballed every iteration on a
GTX 1070 Ti via the cloudflared HTTP tunnel
(`https://oops-guardian-refused-prepared.trycloudflare.com/apps/holtburger-web/index.html?...`)
served from the python http.server on `127.0.0.1:8765` →
`/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/`.

User has explicitly de-scoped sun motion + slope-based color overrides for
this thread — focus is purely on **per-surface texture quality** (sharpness,
detail, repetition).

## What AC textures actually are

Verified 2026-05-20 by reading `WorldBuilder.Terminal/TerrainTextureLoader.cs`
and dumping every retail terrain tile via the pkg-node wasm.

```
TerrainTex.TextureId (uint, 0x05xxxxxx)
  → SurfaceTexture (0x05) { Textures: List<uint of 0x06xxxxxx> }   // mip chain
    → RenderSurface (0x06) { Format: PFID, Width, Height, SourceData: byte[] }
       Format PFID enum:
         PFID_CUSTOM_LSCAPE_R8G8B8  (raw RGB — most landscape tiles)
         PFID_R8G8B8 / PFID_A8R8G8B8 / PFID_R5G6B5 / PFID_A8
         PFID_INDEX16 (palettized, needs a separate Palette lookup)
         PFID_DXT1 / PFID_DXT3 / PFID_DXT5
         PFID_CUSTOM_RAW_JPEG
```

The decode chain: take the last (highest-res) Texture in `SurfaceTexture.Textures`,
load the RenderSurface, decode per PFID → RGBA8 bytes.

**Empirically (all 33 retail terrain codes 2026-05-20):**
- Native size = **512×512 RGBA8**. NOT 256×256.
- All seamlessly tileable by design (retail edge-matches every tile).
- Per-tile feature density varies: grass / sand / dirt / rock have
  clear blade / grain / aggregate structure; snow / ice are nearly uniform.

Reference dumps + repro script live under
`/mnt/wbterminal1/tmp/claude-scratch/terrain-debug/`:
- `dump_lushgrass.cjs` — Node script that boots pkg-node wasm against
  `http://127.0.0.1:8765/dist/manifest.json`, calls `fetch_terrain_textures()`,
  pngjs-encodes each tile (LushGrass / Grassland / SemiBarrenRock /
  PatchyGrassland / ForestFloor / Ice / BarrenRock) to PNG.
- `check_tile_sizes.cjs` — same boot, just reports the size distribution
  for all 33 codes (confirmed `{ '512x512': 33 }`).
- `tile_3_LushGrass_512x512.png` etc — the actual reference tiles.
- `holtburg-reference.png` — `render-preview lbX:169 lbY:180 resolution:2048`
  from WB.Terminal (~9 MB PNG of the C# reference renderer's output).

WB.Terminal command set + invocation pattern is at
`~/.claude/skills/worldbuilder-terminal/skill.md` and the memory note
`reference_worldbuilder_terminal.md` / new `reference_ac_terrain_textures.md`.

## Terrain pipeline today (after this session)

| Layer | File:line | State |
|---|---|---|
| Wasm decode | `src/lib.rs:2511 fetch_terrain_textures` | 33 × 512×512 RGBA8 |
| JS atlas build | `scene3d/adapter.js:32 ATLAS_TILE_PX = 512` (was 256) | direct-memcpy of `tex.pixels` into a single `Uint8Array(layerStride × 33)` |
| Three texture | `scene3d/terrain.js:810` `new THREE.DataArrayTexture(bytes, 512, 512, 33)` | RGBAFormat / UnsignedByteType / SRGBColorSpace / RepeatWrapping / Linear+LinearMipmapLinear / generateMipmaps=true |
| Fragment shader | `scene3d/terrain.js:487 heitzSample`, `:552-555 4-corner blend` | Heitz tile-and-blend at hex rate 4 on the LB-continuous coord, variance-corrected, then bilinear-blended across the 4 cell corners |
| Mesh | `scene3d/adapter.js:landblockMeshToGeometry / subdividedLandblockMeshToGeometry` | 9×9 control grid + Catmull-Rom subdivision (subdivLevel=8 at ultra) |

### What's been verified working

1. `strings pkg/holtburger_web_bg.wasm | grep ...` — wasm carries the
   correct PFID decode + retail SurfaceTexture IDs.
2. Direct-memcpy fast path is selected for all 33 tiles (size matches
   ATLAS_TILE_PX). The canvas-resize fallback at `adapter.js:`~250-265 is
   defensive only.
3. `wasmExports.fetch_terrain_textures` returns 33 entries, all 512×512.
   `pixels` length = `width*height*4` exactly.
4. Reference C# render of Holtburg (`render-preview lbX:169 lbY:180`)
   shows the same overall look the browser produces — confirming the
   "low-texture" complaint is **not** a browser-only bug; the retail
   reference also has visible 24m tile repetition because of how the
   underlying tiles tile + how the 4-corner blend produces 24m diamond
   transitions.

### Recent commits (newest first)

- `8778765` chore(diag): gate per-tick / per-input traces behind
  DIAG_VERBOSE — wasm-side console spam silenced so DevTools is usable;
  bumped `index.html` import cache-bust to `?v=h3-quiet1`.
- `a595606` fix(terrain): stop downsampling retail tiles to 256, copy
  bytes direct — **the big quality win** for terrain. ATLAS_TILE_PX
  256 → 512 + direct memcpy of `tex.pixels` instead of
  `putImageData/drawImage/getImageData`. Drops the triple-sRGB
  roundtrip canvas inserted.
- `4cc8b14` fix(terrain): Heitz hex grid must use continuous LB coord,
  not cellUv — Heitz hex was resetting at every 24m cell boundary,
  trading the tile repeat for a hex-mismatch seam. Now uses the
  continuous LB-grid coord; RepeatWrapping handles edge wrap.
- `4edf1a0` feat(terrain): Heitz tile-and-blend kills 256² tile
  repetition — initial Heitz add (had the cellUv bug fixed by 4cc8b14).
- `857924e` fix(terrain): kill atlas bleed + lift player to visual
  surface — replaced the 6×6 packed CanvasTexture with a
  `THREE.DataArrayTexture` (one layer per terrain code, ClampToEdge per
  layer at the time; later moved to RepeatWrapping for Heitz). The
  packed atlas had been bleeding adjacent slots' colours into each cell
  at mip levels ≥3 because there was no gutter.

## What's still wrong (working hypotheses)

Despite the 512² upgrade, the user reports textures still look low-tex.
Buildings have the same vibe even though buildings use a separate
texture path. Candidates, ranked by suspected impact:

### H1. Anisotropic filtering is at 1× everywhere (likely big win)

Three.js textures default to `anisotropy = 1`. At grazing viewing angles
(walking on the ground, looking down a building wall) the GPU picks the
lower mip level → blurry stretched textures. Setting
`texture.anisotropy = renderer.capabilities.getMaxAnisotropy()` (16× on
the 1070) sharpens ALL grazing-angle samples dramatically.

**Where to set:**
- Terrain atlas: `scene3d/terrain.js:~810` after `new
  THREE.DataArrayTexture(...)`.
- Building/model albedo: `scene3d/adapter.js:629 surfacePixelsToTexture` —
  add `tex.anisotropy = anisoMax` after `tex.needsUpdate`. Same for
  `surfacePixelsToNormalTexture` (line 679) for consistency.
- Road overlay: `scene3d/terrain.js:~830` road CanvasTexture.

Three.js needs the renderer reference to query `getMaxAnisotropy()`; the
simplest pattern is to thread `scene3d.renderer` into these helpers, or
read once at scene init and pass through `opts`.

### H2. Buildings/models texture path may also be downsampling or palettizing

I haven't audited the building texture pipeline this session. Open
questions for the next session:

- What does the wasm `SurfacePixels` (`surfacePixelsToTexture`'s input)
  actually carry? Native source resolution, or downsampled? The wasm
  side may be picking the wrong mip level from the SurfaceTexture chain
  (e.g. mid-mip instead of `Textures.Last()` like the terrain path).
  Grep for whatever wasm function feeds `surfacePixelsToTexture`.
- Are building textures palettized (PFID_INDEX16)? If so the wasm
  decoder must apply the palette correctly. The C# code at
  `WorldBuilder.Terminal/TerrainTextureLoader.cs:181-189` lists every
  PFID branch; cross-check that the wasm has equivalent branches for
  all formats buildings use.
- `surfacePixelsToTexture` at `adapter.js:629` already does direct copy
  (no canvas roundtrip — good), but it has zero anisotropy (H1
  applies).

### H3. Heitz needs to extend to buildings, or terrain's heitzSample needs a higher hex rate

The Heitz layer is currently terrain-only. Even at 512², the underlying
tile is still visibly tile-able when sampled flat. Bumping the hex rate
in `heitzSample` from 4.0 to 6.0 or 8.0 would make patches smaller and
the repetition harder to spot, at the cost of slightly more visible hex
boundaries. The variance correction handles contrast loss but not
spatial regularity of the hex grid itself.

Buildings could benefit from the same treatment if their textures tile
visibly across long wall runs. Worth eyeballing first.

### H4. Mipmap quality / mipmap bias

`generateMipmaps = true` uses Three.js's default box-filter downsampling
which is mediocre. For sharp distant textures consider:

- Setting `texture.minFilter = LinearMipmapLinearFilter` (already set —
  good).
- Setting `material.toneMapped = true` (probably already is via the
  ACES/AGX pipeline).
- Considering a custom mipmap chain with a better filter
  (Catmull-Rom or Mitchell) — probably overkill until anisotropy is on.

### H5. DataArrayTexture mipmap support on this Three.js version

We're on Three.js r184 per memory `project_holtburger_clouds_a_done`.
`DataArrayTexture` mipmap auto-generation works in r184 but is worth
sanity-checking — print
`texture.mipmaps.length` after build to confirm a full chain was
generated. If it's just the base level, that explains "tex looks low
at distance".

## The bilinear-4-corner blend pattern is real and structural

The `scene3d/terrain.js:560-578` 4-corner weight blend (w00/w10/w01/w11
× the four `heitzSample` returns) produces visible 24 m diamond
transitions wherever adjacent cells have different terrain TYPES. This
exists in the C# reference too — it's a property of AC's
per-vertex-typed terrain combined with bilinear corner interpolation,
not a bug. No amount of Heitz / atlas / anisotropy work can eliminate
it; it would require a different blend topology (e.g. per-pixel
slope-aware code selection, or noise-warped type boundaries).

Out of scope per the user's de-scoping ("forget the cliffs"); flagged
here so the next session doesn't waste time chasing it.

## Tools available

- **WB.Terminal** for ground-truth reference rendering and texture
  dumping. Skill at `~/.claude/skills/worldbuilder-terminal/skill.md`.
  Useful commands for this thread:
  - `render-preview lbX:169 lbY:180 resolution:2048 outputPath:...` —
    Holtburg reference. Set `useSprites:true` for full-fidelity static
    site renderer (includes building sprites).
  - `get-terrain-data lbX:169 lbY:180` — per-vertex types + roads.
  - `get-terrain-layers lbX:169 lbY:180` — type histogram.
  - `export-textures outputDir:... minId:0x06004000 maxId:0x06005000` —
    bulk-export RenderSurface (0x06xxxxxx) PNGs. Doesn't take
    SurfaceTexture IDs.
  - `get-object-detail objectId:"0x02xxxxxx"` — model/GfxObj geometry
    + ontology. Useful for finding which Texture chain a specific
    building model uses.
- **pkg-node dump scripts** at
  `/mnt/wbterminal1/tmp/claude-scratch/terrain-debug/`. Pattern: load
  pkg-node wasm, init against the served manifest, call any wasm
  export, pngjs-encode results.
- **Browser cache-bust**: bump the `?v=` query on the `pkg/holtburger_web.js`
  import at `index.html:715` after each wasm rebuild so users don't have
  to manually hard-refresh.

## Repro / verify after changes

1. From `apps/holtburger-web/`:
   `export PATH=$HOME/.cargo/bin:$PATH && wasm-pack build --target web --out-dir pkg --release` (~1m45s on this machine).
2. Bump the `?v=` in `index.html:715`.
3. Existing tunnels: HTTP serves `pkg/` automatically from the
   running python http.server on 8765. Don't restart it; user reloads
   the browser tab and picks up the new bundle.
4. Smoke test (regex-only, no GPU needed):
   `node smoke_test.cjs --fast` — checks the source patterns the
   "Terrain atlas: DataArrayTexture + Heitz tile-and-blend" gate
   asserts.

## Recommended first move next session

Set `anisotropy = renderer.capabilities.getMaxAnisotropy()` on every
sampled texture (terrain DataArrayTexture, building albedo, road
overlay, normal map, height map). It's the cheapest, biggest
perceptual win for "things look blurry" complaints and applies to both
ground and buildings uniformly. Then re-eyeball; if anisotropy alone
hasn't closed the gap, dig into the building texture pipeline (H2) to
confirm what mip + format the wasm is delivering.

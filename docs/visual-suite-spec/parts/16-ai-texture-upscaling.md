I have everything I need — the ingest seam, decode internals, the scenery-fetch pattern to mirror, the LRU, the bake-CLI precedent, and the texture-format/palette path. Here is the buildable spec for my slice.

---

# Build Spec — Slice 16: AI Texture Upscaling (ISOLATED TRACK)

> **Isolation contract:** this track touches the rest of the Visual-Behavior Suite at **exactly two points** — (1) the pixel-swap ingest seam, and (2) the rule that the *classifier* (slice 03) reads ORIGINAL DAT pixels. It registers **no** `VisualComponent`, adds **no** `_chainBeforeCompile` patch, and never participates in the descriptor/archetype schema. It is a *source-pixel substitution*, not a shader effect.

## Goal

Replace each object's low-res DAT diffuse texels with an offline AI-upscaled version, delivered as a DID-keyed sidecar, swapped in at decode time, bounded by a VRAM LRU — **without** changing geometry, UVs, the material's shader program, `customProgramCacheKey`, collision, wire state, or the surface classification. AC textures are 32–256 px hand-painted/palettized; 4× upscaling spends VRAM (the idle resource on the 1070's 8 GB) for sharper objects at zero ALU cost.

The chain we are intercepting (verified in-tree):
`Surface (0x08)` → `SurfaceTexture (0x05).highest_res()` → `RenderSurface/Texture (0x06)` → `Texture::to_rgba8()` → RGBA8 → `surfacePixelsToTexture` → `DataTexture` → `MeshStandardMaterial.map`.
(`lib.rs:7367-7389`, `surface_texture.rs:29`, `texture.rs:295`, `adapter.js:888`.)

---

## Design

### D1. Model selection — **ESRGAN backbone + game-texture-tuned weights, run offline via ncnn-vulkan**

| Candidate | Verdict |
|---|---|
| **Real-ESRGAN (RRDBNet/ESRGAN backbone)** | **CHOSEN.** Its degradation model (JPEG + quantization noise) matches AC's `CustomRawJpeg` (PFID 500, `texture.rs:45`) + P8 palette banding. Richest ecosystem of *game-texture* finetunes (Remacri / Siax / NMKD class). `realesrgan-ncnn-vulkan` batches fast on the 1070; ONNX Runtime is the deterministic CI alternative. |
| SwinIR | Higher quality on natural photos but its classical-SR variants assume clean bicubic degradation; over-smooths AC's stylized flat art and is ~5–10× slower. Not worth it for an offline bake where the ESRGAN finetune ecosystem already targets our domain. |
| Generic bicubic/Lanczos | Baseline fallback only — used for **alpha** and as the `--no-model` debug path. |

**Decisions baked into the bake step (non-obvious, domain-specific):**
1. **Scale = 4×, clamped.** Output dim `min(srcDim*4, MAX_UP_DIM=1024)`. Skip sources `>256 px` (already adequate) and `≤4 px` / 1×1 solids.
2. **Alpha is upscaled SEPARATELY, NOT by the model.** SR models are RGB-only and soften edges; AC alpha drives `Base1ClipMap (0x4)` alpha-test (`lib.rs:7091`, `has_palette` ref pick `lib.rs:7425-7428`). Upscale alpha with **edge-preserving bicubic** (or nearest for hard masks) so the alphaTest 0.5 boundary stays crisp. Recombine RGB(model) + A(bicubic).
3. **Seamless-tile preservation.** Textures use `RepeatWrapping` (`adapter.js:917`). Upscale with **3×3 wrap-pad → upscale → center-crop** so tiling seams don't appear (this also satisfies the suite's "tiling-seam fix" effect for free).
4. **sRGB-space upscale.** Our RGBA8 is sRGB (`adapter.js:911`). Upscale in sRGB directly (do not linearize) so colors match the existing `colorSpace = SRGBColorSpace` upload.
5. **Operate on POST-palette RGBA8.** The bake decodes via `Texture::to_rgba8` at the `default_palette_id` (`texture.rs:358-373`) — the model never sees P8/Index16 indices, only resolved colors. This is the literal "upscale post-palette" rule.

### D2. Sidecar key + catalog (mirror `init_scenery_base_url`)

**Key by the RenderSurface/Texture DID (`0x06`, the `rs_id` resolved at `lib.rs:7370`)**, not the Surface DID (`0x08`). Rationale: the `0x06` Texture is the unique pixel payload — many `0x08` Surfaces and every inventory icon (`fetch_icon_pixels_impl`, `lib.rs:7609`, which takes a `0x06` directly) share them, so a `0x06`-keyed catalog dedups the bake AND upgrades icons for free.

New Rust module `upscale_fetch` mirroring `scenery_fetch` (`lib.rs:2069-2188`) verbatim in shape:

```rust
// lib.rs — new module, sibling of scenery_fetch
#[cfg(target_arch = "wasm32")]
mod upscale_fetch {
    thread_local! {
        static BASE_URL:  RefCell<Option<String>> = const { RefCell::new(None) };
        // did(0x06) -> Some(decoded sidecar) | None (negative: no sidecar)
        static CACHE:     RefCell<HashMap<u32, Option<UpscaledTex>>> = RefCell::new(HashMap::new());
        // one-shot catalog of which DIDs have sidecars (avoids 404 probing)
        static CATALOG:   RefCell<Option<HashMap<u32, CatEntry>>> = const { RefCell::new(None) };
    }
    pub struct UpscaledTex { pub w: u32, pub h: u32, pub fmt: u8, pub mips: u8, pub bytes: Vec<u8> }
    pub struct CatEntry    { pub w: u32, pub h: u32, pub fmt: u8, pub bytes_len: u32 }

    #[wasm_bindgen] pub fn init_upscale_base_url(url: String) { /* normalise trailing '/', store */ }
    #[wasm_bindgen] pub fn upscale_cache_size() -> usize { CACHE.with(|c| c.borrow().len()) }
    #[wasm_bindgen] pub fn clear_upscale_cache() { /* both maps */ }

    // Fetched ONCE (mirror SHA_LOGGED one-shot, lib.rs:2099-2102):
    //   {base}upscale-catalog.json  ->  { "0x060012AB": {w,h,fmt,bytes}, ... }
    pub async fn ensure_catalog(base: &str) -> Result<(), String> { /* fetch_bytes + serde */ }

    // Per-DID sidecar fetch+decode, negative-cached on catalog miss:
    //   {base}0xXXXXXXXX.tex.bin
    pub async fn ensure_upscaled(base: &str, tex_did: u32) -> Result<(), String> { /* ... */ }
    pub fn get(tex_did: u32) -> Option<...>; // sync read for the ingest seam
}
#[cfg(target_arch = "wasm32")]
pub use upscale_fetch::{init_upscale_base_url, upscale_cache_size, clear_upscale_cache};
```

**Sidecar binary `0xXXXXXXXX.tex.bin`** (`0x06` DID, 8 hex):
```
magic   u32  = 0x54584255  // "UBXT"
fmt     u32  // 0=RGBA8, 1=BC1, 2=BC3, 3=BC7   (see D3)
width   u32
height  u32
mipCount u32 // 1 = no chain; >1 = concatenated mip levels (BCn ships its own chain)
payload [u8] // mip-major; RGBA8 = w*h*4 per level, BCn = blocks per level
```
Catalog `upscale-catalog.json` is the index that lets the runtime decide-to-swap with **zero 404 probes** (the scenery path 404s per-LB at `lib.rs:2183`; we deliberately avoid that with the catalog one-shot).

JS wiring mirrors `statics.js:308/334`:
```js
const UPSCALE_BASE_URL = "../../dist/upscale/";   // sibling of SCENERY_BASE_URL
if (wasmExports.init_upscale_base_url) wasmExports.init_upscale_base_url(UPSCALE_BASE_URL);
```

### D3. DXT/BCn re-encode vs raw RGBA8 — **two-tier, BCn for production**

| Form | Bytes/px | 1024² resident VRAM (+mips) | Quality | Upload path |
|---|---|---|---|---|
| Raw RGBA8 | 4 | ~5.3 MB | lossless of model output | `DataTexture` (reuse `surfacePixelsToTexture`) |
| BC1 (s3tc, opaque) | 0.5 | ~0.67 MB | block artifacts, fine for diffuse | `CompressedTexture` |
| BC3 (s3tc, alpha) | 1.0 | ~1.3 MB | good w/ alpha | `CompressedTexture` |
| **BC7 (bptc)** | 1.0 | ~1.3 MB | **near-lossless** | `CompressedTexture` |

A 64² source upscaled 4× → 256² RGBA8 = 0.33 MB; the *original* 64² RGBA8 was ~0.02 MB. **Raw upscale is ~16× the original VRAM** — that's what would blow the budget. **BCn keeps the 4×-resolution texture at ≈ the original RGBA8 footprint or below**, which is the entire reason to compress.

**Decision: bake BC7 (bptc) primary, BC3/BC1 (s3tc) fallback, raw RGBA8 as dev/debug.** Pick the GPU-supported tier from the existing `quality.js` GPU-tier probe + `WEBGL_compressed_texture_s3tc` / `EXT_texture_compression_bptc` extension checks. Encode offline with `ispc_texcomp`/`bc7enc`. (KTX2+Basis is the standard-format alternative — chosen against to avoid shipping a transcoder; the 16-byte custom header above + `THREE.CompressedTexture` is enough.)

This forces the **swap-point choice** (D4): raw → Rust seam; BCn → JS seam (compressed textures cannot ride the RGBA8 `pixels` Vec).

### D4. The pixel-swap seam — **classify-then-swap, two phases**

The binding ordering constraint, from the actual code:

```
lib.rs:7381   rgba = tex.to_rgba8(...)           // decode original
lib.rs:7396   stats = compute_stats(&pixels,…)   // ← SurfaceStats from ORIGINAL
lib.rs:7398   (category, rough, nscale) = classify_with_overrides(...)   // ← classify ORIGINAL
              ─────────────  SWAP MUST GO HERE, AFTER 7398  ─────────────
lib.rs:7404   normal/height from luminance       // regenerate from UPSCALED
lib.rs:7412   SurfacePixels{ width, height, pixels, category, … }        // ship upscaled
```

> **Why not swap at 7381 as the doc shorthand says:** `compute_stats` (`lib.rs:7396`) runs *after* `to_rgba8`. Real-ESRGAN removes palette banding and injects high-frequency detail, which shifts mean luminance / gradient variance / edge density — flipping classifications (e.g. smooth-metal → rough-dirt). So the precise insertion is **after `classify_with_overrides` (lib.rs:7398)**, replacing only `pixels`/`width`/`height` and regenerating normal/height from the upscaled buffer. `category`, `roughness_override`, `normal_scale_override`, and the T/L/D triplet stay computed from the original.

**Phase 1 — raw RGBA8, Rust seam (proves the pipeline, matches the doc's `lib.rs:7381` reference):**
```rust
// inserted at lib.rs ~7411, after classify, before SurfacePixels{}
let (mut pixels, mut tex_w, mut tex_h) = (pixels, tex_w, tex_h);
if let Some(up) = upscale_fetch::get(rs_id) {        // rs_id resolved at 7370, fmt==RGBA8
    pixels = up.bytes; tex_w = up.w; tex_h = up.h;   // category already from original ✓
}
let (normal_pixels, height_pixels) = /* regenerate from (pixels, tex_w, tex_h) */;
```
and in the async wrapper `fetch_surface_pixels` (`lib.rs:7577`), alongside `ensure_walk_prefetched` (`:7581`):
```rust
let base = upscale_fetch::base();
if let Some(b) = base {
    upscale_fetch::ensure_catalog(&b).await.ok();
    upscale_fetch::ensure_upscaled(&b, rs_for(surface_did)).await.ok(); // warm cache for sync impl
}
```

**Phase 2 — BCn, JS seam (production, VRAM-correct):** Rust stays unchanged (classifies + returns original pixels). JS swaps in `_installFromPixels` (`materials.js:3125`, right before the `surfacePixelsToTexture(pixels, w, h)` call at `:3197`): if `UpscaleManager.has(rs_did)`, build a `THREE.CompressedTexture` from the sidecar instead of the `DataTexture`, copying `colorSpace=SRGB / flipY=false / wrap / anisotropy` **identically** from `adapter.js:911-918` (any mismatch misaligns UVs). The `category`/material flags from Rust (original) are untouched. This keeps WASM out of the BCn path entirely — maximal isolation.

The existing `downscaleRgba` hook (`adapter.js:902`, `setAdapterTextureDownscale`) is the in-tree precedent that pixels are already swapped at this exact seam — we are adding the *upscale* sibling.

### D5. Per-DID VRAM budget + LRU (mirror `landblock_lru.js`)

Two bounded caches:
- **Rust sidecar-bytes cache** (`upscale_fetch::CACHE`): bound by total decoded bytes; evict LRU when over `UPSCALE_RAM_BUDGET` (decoded sidecar RAM, not VRAM).
- **JS GPU LRU** `UpscaleTextureLRU` — the authoritative VRAM bound, modeled on `LandblockLRU` (`landblock_lru.js:66`):
  - keyed by `0x06` DID; tracks `{ tex, bytes, lastTouchMs }`. `bytes` comes from the catalog entry (`W*H*bpp*1.333`).
  - `touch(did)` on every material bind / visibility (cheap — 66 unique textures in the Holtburg ring, a few thousand full Dereth; the LRU bounds *unique textures*, not placements).
  - `tick()` (called from the per-frame LRU tick already in `index.js`): if `sumBytes > budget`, sort ascending by `lastTouchMs` (same as `landblock_lru.js:178`) and **evict**: `tex.dispose()` the upscaled handle and restore the material's `.map` to the original `DataTexture` (kept alongside, or lazily re-decoded via the unchanged original path). Re-entry re-swaps on next bind.
  - budget = `?upscaleBudget=<MB>` (default 256 MB on 8 GB; BC7 makes this hold thousands of textures). Disabled entirely with `?upscale=off`.

This reuses the suite's "cap = unique-driver count, not placements" principle (§5.3): upscaled-texture VRAM scales with unique `0x06` DIDs, which is tiny.

### D6. Offline bake CLI (mirror `scenery-bake.rs`)

New binary `apps/holtburger-tools/src/bin/texture-upscale-bake.rs` (+ optional `holtburger-texture-bake` crate), mirroring `scenery-bake.rs`'s determinism/hash-gate shell:
1. Enumerate target `0x06` Texture DIDs — either all textured `0x06` in `client_portal.dat`, or a scoped list from the classifier's `vfx sample --area holtburg` (slice 12) for the Holtburg-first ramp.
2. For each: `Texture::unpack` → `to_rgba8` at `default_palette_id` (post-palette RGBA8) → split RGB/alpha → 3×3 wrap-pad → shell to `realesrgan-ncnn-vulkan` (RGB) + bicubic (alpha) → center-crop → recombine → optional BCn encode → write `0xDID.tex.bin`.
3. Append `{did → CatEntry}` to `upscale-catalog.json`; emit `bake-source.sha256` (mirror `scenery-bake.rs` so a consuming server can verify base-DAT hash-match).
4. Deterministic: fixed model weights + fixed encoder flags; `--bits`-style reproducibility optional.

---

## Integration seams (file:line)

| Seam | Location | Change |
|---|---|---|
| Decode + classify (original) | `src/lib.rs:7381` `to_rgba8`, `:7396` `compute_stats`, `:7398` `classify_with_overrides` | **No change** to classify; swap inserted strictly *after* `:7398` |
| Pixel swap (Phase 1, raw) | `src/lib.rs:~7411` (before `SurfacePixels{}` at `:7412`) | swap `pixels/w/h` from `upscale_fetch::get(rs_id)`; regen normal/height |
| `rs_id` source | `src/lib.rs:7370` `surf_tex.highest_res()` | the `0x06` key for the sidecar |
| Async warm | `src/lib.rs:7577` `fetch_surface_pixels`, `:7581` `ensure_walk_prefetched` | add `ensure_catalog` + `ensure_upscaled` await |
| Icon free-upgrade | `src/lib.rs:7609` `fetch_icon_pixels_impl` (takes `0x06`) | same `upscale_fetch::get` swap → upscaled inventory icons |
| Fetch module to mirror | `src/lib.rs:2069-2188` `scenery_fetch`; `init_scenery_base_url` `:2131`; 404 negcache `:2183`; exports `:2432` | new `upscale_fetch` module + exports |
| Format enum / palette / dims | `crates/holtburger-dat/src/file_type/texture.rs:30` `SurfacePixelFormat`, `:93` `needs_palette`, `:280` `actual_dimensions`, `:358` P8 decode | bake reads these; runtime unchanged |
| Pixel swap (Phase 2, BCn) | `scene3d/materials.js:3125` `_installFromPixels`, `:3197` `surfacePixelsToTexture` call; import `:47` | build `CompressedTexture` from sidecar instead of `DataTexture` |
| Texture-flag template | `scene3d/adapter.js:888` `surfacePixelsToTexture`, `:911-918` SRGB/flipY/wrap/aniso; `:902` `downscaleRgba` precedent | copy flags identically onto the upscaled/compressed texture |
| Subpalette bypass | `scene3d/materials.js:1846` `getCachedPaletted` | dyed/recolor path must NOT use default-palette upscale |
| VRAM LRU template | `scene3d/landblock_lru.js:66` class, `:151` tick, `:178` LRU sort, `:197` evict/dispose | new `UpscaleTextureLRU` |
| Base-URL JS wiring | `scene3d/statics.js:308` `SCENERY_BASE_URL`, `:334` `init_scenery_base_url(...)` | add `UPSCALE_BASE_URL` + `init_upscale_base_url(...)` |
| Bake CLI precedent | `apps/holtburger-tools/src/bin/scenery-bake.rs`; `crates/holtburger-scenery-bake/` | new `texture-upscale-bake.rs` |
| Gauge / GPU tier | `scene3d/quality.js` GPU-tier + extension probe; `scene3d/diag.js` `renderer.info` | BCn tier selection + VRAM accounting readout |

---

## Edge cases & legacy-safety check (per THE RULE)

**THE RULE compliance — this is the safest effect in the suite:**
- **READS only** static DAT pixels (`Texture 0x06` payload, decoded post-palette) + offline-baked sidecar bytes. No server-replicated/mutable input, no clock even.
- **WRITES only** a client-owned `DataTexture`/`CompressedTexture` bound to `material.map` — a render resource the server neither stores nor replicates. Same UVs (0..1, just denser texels), same geometry, same vertex data.
- **Never touches:** wire value, physics/collision BSP, replicated transforms, light count, or `customProgramCacheKey` — *a bigger/compressed texture binds to the byte-identical shader program*, so there is **zero shader-link cost** and no relink (sidesteps both the light-pool relink and the cache-key-explosion corollaries entirely).

**Edge cases:**
1. **Classification poisoning** — MUST swap after `classify_with_overrides` (`lib.rs:7398`); a lint asserts the swap line is below the classify line. Bake must run on DAT pixels, never on prior bake output (`bake-source.sha256` gate enforces base-DAT-only).
2. **ClipMap alpha-test** (`Base1ClipMap 0x4`, `has_palette` ref pick `lib.rs:7425`) — alpha upscaled with edge-preserving bicubic, never the RGB model, so the alphaTest 100/200/0.5 boundary (`materials.js` parityV2) stays correct.
3. **SubPalette / dyed recolor** (`getCachedPaletted`, `materials.js:1846`; entity-owned recolor) — sidecars are baked at the DEFAULT palette; a post-shift recolor would be wrong, so the upscale swap is **bypassed when a non-default subpalette is applied** (and for entity-owned `_buildEntityOwnedFromPixels`). Catalog may flag such `0x06` DIDs `noUpscale`.
4. **Animated surfaces** (`collect_surface_anim_frames`, `lib.rs:7481`) — each frame is a distinct `0x06`; bake per-frame (keyed by each `0x06`) to keep sync, or skip animated DIDs (cheap, marked in catalog).
5. **Texture-flag drift** — upscaled texture MUST copy `colorSpace=SRGB / flipY=false / wrap / anisotropy` exactly from `adapter.js:911-918`; any mismatch flips/misaligns the surface.
6. **CustomRawJpeg dims** (`actual_dimensions`, `texture.rs:280`) — bake uses `actual_dimensions`, not the lying `0x0` header (the same bug fixed at `lib.rs:7373-7380`).
7. **Stale pkg / missing catalog** — no `init_upscale_base_url`, missing sidecar, or `?upscale=off` ⇒ `upscale_fetch::get` returns `None` ⇒ original pixels ship unchanged. Fully fail-soft, byte-identical to today.

---

## GPU cost

| Axis | Cost |
|---|---|
| ALU / fragment | **Zero.** Same sampler, same shader program, same draw call. It is not a shader effect. |
| Drawcalls / triangles | **Unchanged** (`renderer.info.render.*` identical). |
| Texture *count* | **Unchanged** — swap, not add (`renderer.info.memory.textures` flat). |
| VRAM bytes | The only cost. Raw RGBA8 ≈ 16× original (budget risk → Phase-1 only). **BC7 ≈ original RGBA8 footprint at 4× resolution** → effectively free. Bounded by `UpscaleTextureLRU` to `?upscaleBudget` (256 MB default of 8 GB). |
| Bandwidth | Marginally more mip-sampling traffic on larger textures; negligible at Holtburg's 66 unique textures, immaterial vs the CPU-bound ~20 fps ceiling. |

**Gauge protocol** (reuse slice 11 / `diag.js`): A/B `renderer.info` + rAF frame-time at the 222-placement Holtburg ref with `?upscale=off` vs `=on`. Expected Δframe ≈ 0 (texture-bound only on pathological scenes); the pass/fail meter is **VRAM residency vs budget**, tracked by our own catalog-byte accounting (three.js doesn't report texture bytes). Stay `< 75%` GPU/VRAM at full Dereth per §5.2.

---

## Build checklist (ordered)

**A — Offline bake (isolated, no client dependency):**
1. Add `apps/holtburger-tools/src/bin/texture-upscale-bake.rs` (mirror `scenery-bake.rs` CLI/determinism shell + `bake-source.sha256`).
2. Implement decode→split(RGB/alpha)→3×3 wrap-pad→`realesrgan-ncnn-vulkan`(RGB)+bicubic(alpha)→crop→recombine, on post-palette RGBA8 from `Texture::to_rgba8` (`texture.rs:295`, default palette). Skip `>256px`, `≤4px`, 1×1 solids, dyed/subpalette-flagged, animated (or per-frame).
3. Add BCn encoder step (BC7 primary via `ispc_texcomp`/`bc7enc`; BC1/BC3 fallback; `--raw` for RGBA8 debug). Emit `0xDID.tex.bin` (16-byte header + mip-major payload) + append `upscale-catalog.json`.
4. Bake the Holtburg ring `0x06` set first (scope via `vfx sample --area holtburg`); output to `dist/upscale/`.

**B — Rust runtime (Phase 1, raw RGBA8 swap):**
5. Add `mod upscale_fetch` (mirror `scenery_fetch` `lib.rs:2069`): `init_upscale_base_url`, `ensure_catalog`, `ensure_upscaled`, `get`, `clear_upscale_cache`, `upscale_cache_size`; `pub use` exports next to `lib.rs:2432`.
6. In `fetch_surface_pixels` (`lib.rs:7577`): after `ensure_walk_prefetched` (`:7581`), `await ensure_catalog` + `ensure_upscaled(rs_id)`.
7. In `fetch_surface_pixels_impl` at `~7411` (**after** `classify_with_overrides` `:7398`, before `SurfacePixels{}` `:7412`): swap `pixels/tex_w/tex_h` from `upscale_fetch::get(rs_id)` for `fmt==RGBA8`; regenerate `normal_pixels`/`height_pixels` (`:7404-7411`) from upscaled buffer. Apply identical swap in `fetch_icon_pixels_impl` (`:7609`).
8. Add legacy lint/test: assert swap-line > classify-line; assert `compute_stats` input is the original buffer (slice 13 hook).

**C — JS runtime (Phase 2, BCn + VRAM LRU):**
9. Add `UPSCALE_BASE_URL` + `init_upscale_base_url(...)` in `statics.js` (mirror `:308/:334`); guard for missing export (stale pkg).
10. Add `scene3d/upscale_manager.js`: catalog load, `CompressedTexture` builder copying `adapter.js:911-918` flags, `has(did)`, GPU-tier/extension gate from `quality.js`.
11. Hook `materials.js:3197` (`_installFromPixels`): if `UpscaleManager.has(rs_did)` build `CompressedTexture` instead of `DataTexture`; bypass for `getCachedPaletted` (`:1846`) + entity-owned (`_buildEntityOwnedFromPixels`).
12. Add `scene3d/upscale_lru.js` `UpscaleTextureLRU` (mirror `landblock_lru.js:66/151/178/197`): byte budget from catalog, `touch` on bind, evict→dispose→restore original `.map`; wire its `tick()` into the existing per-frame LRU tick in `index.js`.

**D — Flags, gauge, ramp:**
13. Parse `?upscale=on|off` + `?upscaleBudget=<MB>` (memoized, `tree_wind.js:15-56` pattern). Default OFF → Holtburg eye-test → default ON with `=off` escape.
14. Run `vfx gauge --ref holtburg` (slice 11): confirm Δframe≈0, VRAM `<75%`; emit the budget report.
15. Smoke: bare-default loads + spawns + 0 errors; `?upscale=off` byte-identical to pre-change; missing-catalog fail-soft verified.

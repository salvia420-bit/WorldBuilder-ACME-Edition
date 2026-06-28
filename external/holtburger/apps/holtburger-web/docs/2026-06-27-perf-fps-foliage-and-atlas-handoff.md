# Handoff — fps perf: foliage instancing (shipped) + static texture-atlas (foundation) — 2026-06-27

## TL;DR
Holtburg on the real GTX 1070 was **~1 fps**. Root-caused and **shipped a fix to ~8 fps** (8×), trees restored, white-wash fixed — all on `origin/master`. Then proved that pushing past ~8 fps is blocked by an architectural wall (per-LB LRU granularity defeats static batching). A texture-array static batcher was built + **proven visually correct**, but is a **near-no-op in its LRU-safe (per-LB) form**; the real win needs a **cross-LB merge with eviction-rebuild** — a deliberate, eye-tested session, not autonomous.

## Shipped (origin/master)
- `dd2b3bfe` — `worldLightScale` (white-wash de-bloom, default 0.4) + vanished-trees fix.
- `968139a4` — **foliage instancing**: the wind-tree *peel* (gated on `visualEnabled()`, default-on) de-instanced ~4,096 Holtburg trees into ~17k individual meshes. Gated the geometry peel on a new default-off `windGeoEnabled()` → trees stay frozen+instanced. **Measured 1→8 fps, T_cpu 968→73 ms.** `?treeWind=on`/`?windGeo=on` re-enable animated (slow) trees.

## Ground truth (real GTX 1070 / ANGLE-D3D11, Holtburg, quality=high)
- Pre-fix ~1 fps; `T_cpu 968 ms >> T_gpu 468 ms` → **CPU/draw-submission bound**. Bloom-off and half-res gave **no** fps gain (NOT fill/bloom-bound). Confirmed by the 33-agent perf sprint (`~/from-vm/perf-research/`).
- Post-foliage-fix ~8 fps; frame ~120 ms, balanced (`T_cpu ~75 / T_gpu ~80–120`). Remaining cost = **~5,400–6,100 unique-material static SINGLETON meshes** (one draw call each).
- **Dead-ends (measured, do NOT chase for fps):** shadows-off halves GPU but fps unchanged; `?visual=off` no change; matrix-freeze ~1%; atmosphere/bloom composer (and it preserves the takram look).

## Attempt 1 — ring singleton consolidation (REVERTED, no-op)
The boot ring marks its LBs baked, so the per-LB `consolidateStaticSingletons` never runs for the resident town. Fixed it to bucket the ring's singletons per-LB and consolidate. **Result: no-op** — only 13 BatchedMeshes formed; the singletons are almost all **unique-material** (material-keyed batching needs ≥2 sharing one material). The "210-material floor" is even tighter in Holtburg. Reverted.

## Attempt 2 — texture-array static batcher (BUILT, behind `?statAtlas=on`, default-off)
New module `scene3d/static_atlas.js` + integration in `scene3d/statics.js` (ring path, flag-gated; flag-off is byte-identical).
- **Spike (the de-risking):** the ~5,400 singletons reference only **353 unique textures**, ALL **RGBA8 `DataTexture`** (`image.data` accessible), ALL **ClampToEdge**, sRGB, `MeshStandardMaterial`/DoubleSide, across **20 power-of-2 size buckets**; only 21 transparent. They carry a `normalMap` (v1 drops it → slightly flatter).
- **Design:** bucket by texture size → pack each bucket's textures as layers of a `DataArrayTexture` → tag each vertex with its layer (`aLayer`) → merge the bucket's geometry into one mesh → a `MeshStandardMaterial` (PBR + atmosphere lighting) whose `map` is replaced by `sampler2DArray` via `onBeforeCompile` (mirrors terrain.js). sRGB decode is free via `colorSpace=SRGBColorSpace`.
- **Shader/build PROVEN CORRECT** on the 1070: `?statAtlas=on` renders indistinguishably from default, **zero shader/compile errors** (the 18 "Unable to serialize Texture" warnings are pre-existing, in both arms).
- **BUT near-no-op as built:** bucketed per-LB (for LRU eviction), only **26 atlas meshes** formed — within one LB too few singletons share a size. fps 7→9 = noise. Kept behind the flag as **proven foundation**, not a win.

## The real win (the wall) — cross-LB texture-array merge + eviction-rebuild
Both batching attempts are defeated by the same thing: **per-LB LRU eviction granularity**. The batchable structure is *cross-LB* (5,400 singletons → ~20 size buckets globally → ~20 draws), but a cross-LB merged mesh can't be evicted per-LB. The real fix:
1. Bucket the ring's singletons by **size globally** (~20 `DataArrayTexture` buckets) → ~20 merged meshes (reuse `static_atlas.js` — drop the per-LB key).
2. Add an **eviction-rebuild**: when a ring LB leaves the resident set, rebuild the affected size-bucket mesh(es) excluding that LB's geometry (or refcount per-LB sub-ranges within the merged buffer). This is the High-risk part (touches `world_stream.js` / `landblock_lru.js` eviction) and needs careful LB-crossing + memory-leak validation + a 1070 eye-test.
- Add the `normalMap` array (dual `DataArrayTexture`) for full fidelity once the merge lands.
- Expected: ~6,100 singleton draws → dozens; should recover toward the old ~22 fps.

## How to validate on the 1070 (recipe)
Chrome must run in the **interactive** session (SSH-launched headless = no GL/black 3D): `schtasks /create /tn X /tr C:\Temp\launch-wls.bat /sc once /st 00:00 /it /f & schtasks /run /tn X`; tunnel `ssh -fN -L 9333:127.0.0.1:9333 -R 8765:127.0.0.1:8765 young@<1070>`; laptop Playwright `connectOverCDP('http://127.0.0.1:9333')`. **Wait `window.__bootState==='ready'`** (not 'in-world' — atmosphere/`__set*` attach later). Metrics: `?renderDiag=on` → `window.__diag.render.meshNodes`; `?vfxGauge=on&vfxGaugeFence=on` → `__diag.vfxGauge` T_cpu/T_gpu; median frame time over a 12 s rAF window (low-end fps is integer-noisy). Scripts in this session's scratchpad: `drive-ab.mjs`, `measure2.mjs`, `validate-atlas.mjs`.

## Sprint artifacts
33-agent perf research (16 research + 16 verify + synthesis) at `~/from-vm/perf-research/` (`SYNTHESIS.md`).

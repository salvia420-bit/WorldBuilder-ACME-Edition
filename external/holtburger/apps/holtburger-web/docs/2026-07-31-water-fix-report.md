# Terrain WATER — bug hunt + fix report (2026-07-31)

Scope: make the terrain water effect correct and bug-free. Spec: water must
**rise and fall** *and* have a **surface movement** effect, **simultaneously**;
find and fix the interactions (player proximity / LOD, TexMerge, rebake) that
damage it.

**All production changes are JS + GLSL in one file** — `scene3d/terrain.js`.
No wasm rebuild, no Rust change, nothing else in the client touched.

| file | what |
|---|---|
| `scene3d/terrain.js` | all nine fixes (vertex GLSL, fragment GLSL, flag readers, opts, material uniforms) |
| `test_terrain_water.mjs` | **new** — 70 checks: shader-source contracts + a numeric proof of the LOD-crack property + the batched-mesh anchor guard |
| `test_terrain_water_gpu.html` | **new** — GPU harness that renders the real shader source; produces the before/after table in §3a and A/Bs by swapping the file |
| `docs/url-flags.md` | `waterScroll` / `waterEnv` / `strictWaterCodes` rows rewritten, `waterWave` row added |
| `docs/2026-07-31-water-fix-report.md` | this file |

Coexistence: agent 0A's `heights: Float32Array.from(wasmMesh.heights)` hunk in
the `lbMesh.userData` literal is preserved untouched, and the terrain-VFX
agent's `terrainVfx` / `terrainTrail*` doc rows are untouched. The parallel
terrain-VFX plan explicitly scopes water codes 16-20, 22, 23 to this work.

---

## 0. What water actually looked like before this change

Live headless session, quality=high, default flags, NW-corner open ocean
(LB `0x01AE0000`, terrain code 20 everywhere, 81/81 water vertices).
Uniform dump off a real terrain material:

```
uDisplacementEnabled 1   uWaterScrollEnabled 1   uWaterCodeMask 0x1F0000
uTexMergeEnabled     1   uPbrEnabled 1   uIblEnabled 1
uAcGouraudEnabled    1   uWaterEnvEnabled 1
```

Every water gate reads ON. In reality **exactly one of the three water
effects was running** (the vertex swell). The scroll and the sheen were both
dead, each killed by a *different* default-on feature that shipped after them.

---

## 1. Bugs found (root cause each)

### BUG 1 — TexMerge silently deletes the water UV scroll (world-wide, default-on)

**Root cause.** The retail TexMerge composite is the last word on terrain
albedo: it ends in `result = merged;`, discarding the bilinear blend above it.
But its own samples — the base slot and overlay slots 1..5 — were all taken at
the **unscrolled** `cellUv`. The scrolled `waterCellUv` existed and was
correct; it only ever reached the bilinear path, which TexMerge then threw
away. `texMerge` has been **default-ON since 2026-07-02**, so the water
surface has been frozen everywhere since that day.

This also explains the odd shape of the 2026-07-08 `waterScroll` work: that
fix correctly decoupled the scroll from `uDisplacementEnabled` and *validated
the uniforms* ("all 7 water materials `uWaterScrollEnabled=1`... Owed: 1070
pixel eye-test of the actual motion" — url-flags.md). The uniforms were right.
The pixels never moved.

**Measured, before the fix** (open ocean, 400×250 px water region, two frames
5 s apart, vertex swell frozen to isolate the surface):

| arm | meanAbsDiff | pixels changed |
|---|---|---|
| `uTexMergeEnabled = 1` (default) | **0.42** | **0.00 %** |
| `uTexMergeEnabled = 0` (forced) | 2.50 | 45.7 % |

**Fix.** Each merge slot picks the scrolled UV iff **its own atlas layer** is a
water code:
`atlasUvFor(layer, isWaterCode(layer) ? waterCellUv : cellUv)`.
Per-slot (not per-cell) is what keeps a water *overlay* flowing over a static
land *base* at a blended border. The alpha **mask** deliberately stays on the
unscrolled `cellUv` — the mask is the cell's authored coverage shape and must
not drift.

### BUG 2 — the water sheen never executed (default-on flag, unreachable branch)

**Root cause.** terrainplan s4's water sheen (scrolling wave normal + env
reflection + glint) was written inside
`if (uPbrEnabled > 0.5 && !acGouraud) { ... }`. `acGouraud` is
`uAcGouraudEnabled > 0.5`, and `terrainGouraud` is **default-ON** and
deliberately wins over PBR ("retail-look mode stays retail"). So in every
default session `uWaterEnvEnabled` read 1.0 while gating a branch that could
not be reached. A flag that documents itself as default-on and does nothing.

**Fix.** The sheen is now its own block *after* the PBR block, gated only on
`uWaterEnvEnabled && waterW > 0 && sheenFade > 0`, so it runs in **both**
shading modes. It
contributes a Blinn sun glint plus (under `ibl`) an env-cube sky reflection
into `iblSpec`, which is added outside the Gouraud multiply. To avoid
double-counting, the generic PBR env-specular term now stands down over water
by `(1 - waterW)`, and the PBR material NdotL/AO substitution fades out over
water by `waterW` (the nra layers for water codes are deliberately uncurated
in **both** texture arms — see `terrain_bc7.js`: "the water shader owns their
normal and roughness" — so applying them to water only flattens what the sheen
is computing).

**Follow-on found by actually looking at it.** The first live frame with the
sheen alive showed long white streaks radiating to the horizon across the whole
sea. Attributed by forcing `uWaterEnvEnabled = 0` live, which removed them
exactly: the wave normal is a finite-difference gradient of a ~3.3 m-period
noise field, point-sampled once per pixel with no derivative-aware filtering,
so past a few tens of metres a pixel spans many wave periods and the specular
term aliases. Rather than filter the noise, the sheen is now explicitly a
**near-camera** effect — `sheenFade = 1 - smoothstep(30, 160, vViewDepth)`
scales the normal's xy slope, raises the env mip from 0.6 to 4.0, and scales
the whole contribution. Beyond the fade the water reads as the plain retail
tile it always did, which is also the conservative answer. This is why
`sheen_gouraud` in the table below reads 2.81 rather than 13.28: most of the
frame at that camera is beyond 30 m, and it *should* be quiet there.

### BUG 3 — player proximity tore open water along the subdiv LOD seam

**Root cause.** `pickSubdivLevelForLb` gives the player's LB and ring-1
`halfLevel`, and everything at Chebyshev distance >= 2 factor 1. That boundary
is ~2 landblocks away and **moves with the player** (`lodRebake` is default-on
and re-bakes LBs as he walks). Static heights are crack-free across it because
the subdivided surface is *linear along every cell edge* (locked by
`terrain_subdiv::tests::lod_boundary_edges_coincide_across_factors`). The
water swell was a **raw per-vertex sine**, which is *not* linear along an
edge: the fine side's intermediate vertices sat off the coarse side's straight
chord, opening a gap in a nearly-flat surface viewed at a grazing angle.

Measured gap for the old wave, sampling every factor-8 vertex on a 24 m seam
edge across five values of `t`: **up to 0.096 m** for the reproduced case
(`test_terrain_water.mjs` Test 6 asserts this as the regression premise;
worst case over both wavelets ~0.23 m). The tear followed the player around
the world.

**Fix — lattice lock.** The swell is now evaluated at the four corners of the
enclosing **24 m control cell** and bilinearly interpolated
(`waterSwellLattice`). Bilinear restricted to an axis-aligned cell edge *is*
linear, so every subdivision factor reproduces the identical surface:
measured crack **0.0 m** (float-exact) at every `t` tested. Landblock seams are
also lattice lines (192 = 8 × 24) so cross-LB phase continuity is exact by
construction, not by convention.

Wavelengths were lengthened 63 m/48 m → **140 m/101 m** so a 24 m
reconstruction stays smooth (peak bilinear facet ~2-3 cm against a 0.241 m
envelope, inside the 0.4 m plan cap). The high-frequency motion the short
wavelengths used to supply now comes from the scroll and the sheen, which have
no geometry dependency and therefore no LOD constraint.

### BUG 4 — half the water animation died at quality low/mid

**Root cause (a).** `displacementEnabled = subdivLevel >= 2` — no rise/fall at
all on the `low` and `mid` presets. Justified originally ("24 m verts, the
wavelength would exceed the screen"), but it is exactly the same uniform that
produced BUG 3 at high/ultra.
**Root cause (b).** The **blue tint breath** — a pure per-pixel effect with no
geometry dependency — was *also* gated on `uDisplacementEnabled`, so it died
with it.

**Fix.** (a) The lattice lock makes the swell level-independent, so the subdiv
gate is meaningless and is gone; `uDisplacementEnabled` is now driven by a
plain `?waterWave=off` escape at every tier. (b) The tint moved onto
`uWaterScrollEnabled` with the rest of the surface animation. The fragment
stage no longer declares `uDisplacementEnabled` at all — it is now a
vertex-stage-only uniform.

The two gates are deliberately orthogonal, which is what the spec's "the two
effects must work TOGETHER" requires as a testable property:
`?waterWave=off` isolates the surface, `?waterScroll=off` isolates the
geometry, both off is the full static rollback.

### BUG 5 — POM fought the scroll (and would have swum on the BC7 arm)

**Root cause.** POM marches a height field and offsets `cellUv` *before every
sampler*. Two problems on water: (i) `waterCellUv` was derived **before** the
POM block, so the water tile was off-registration against albedo / nra / masks
whenever POM ran; (ii) a liquid surface has no parallax relief at all. The CC0
arm hid (ii) by accident — retail RGBA8 water layers carry `A=255`, so the
march exits at step 0 — but the **BC7 arm derives height from the retail
albedo**, so `?terrainBc7=on` would have marched a real height field over a
scrolling texture and made the flow swim.

**Fix.** Deliberate decision: **water bypasses POM.** `cellTouchesWater`
(any of the four corners) skips the march entirely — identical behaviour on
both texture arms, and a strict no-op wherever water is absent. `waterCellUv`
is now derived *after* the POM block, so on mixed cells it rides the same
parallax-adjusted `cellUv` as everything else.

### BUG 6 — one water set was answering two different questions (code 22 stayed static beside identical-looking flowing water)

**Root cause.** A single `uWaterCodeMask` drove *both* "does this BEHAVE like
water" (the vertical swell) and "does this LOOK like water" (scroll, tint,
sheen). Those have different right answers. `strictWaterCodes` is default-ON,
so the live set is retail's surface-characteristic set `{16-20}` — which
excludes **22 FauxWaterRunning**. But 22 is faux *running water* art, and on
the BC7 arm it shares one retail RenderSurface with **16 WaterRunning**
(`terrain_bc7.js` layer→rsId dedupe). So two cells drawn from the *same
texture* animated differently: a static "river" right next to a flowing one.
That is a direct contributor to the "water effect missing in places" report.
F12-5 had already identified the answer and deferred it ("keep-22-scroll-only
(faux running water) ... needs a 2nd mask").

**Fix — the second mask.**
`TERRAIN_WATER_CODES {16-20}` → `uWaterCodeMask`, vertex stage, the swell
(retail SurfChar decides what bobs).
`TERRAIN_WATER_SURFACE_CODES {16-20, 22}` → `uWaterSurfaceCodeMask`, fragment
stage, every surface site (the art decides what flows).
23 SeaSlime stays out of both — its art is slime and retail agrees.
`?strictWaterCodes=off` still collapses **both** to the legacy `{16-20,22,23}`,
so the escape keeps meaning exactly "restore pre-F12-5". Measured on GPU: code
22 scroll delta **44.10** (bit-for-bit the same as real water) with swell delta
**0.00**; code 23 delta **0.00**.

### BUG 7 — water treatments switched on cell-sized steps at shorelines

**Root cause.** The sheen keyed off `nearCode` (nearest bilinear corner) — a
hard switch at the cell midlines. The tint recomputed its own water fraction
inline. Different sites, different granularity, at exactly the place a player
looks at water most (the shore).

**Fix.** One `waterW` — the bilinear per-corner water fraction, using the same
four weights as the texture blend — computed once and reused by the tint, the
sheen, the PBR stand-down and the sheen weighting. Water treatments now fade in
across the waterline exactly like the texture blend.

### BUG 8 — every fresh landblock bake showed one frame of water at t=0

**Root cause.** New materials were built with `uTime: { value: 0.0 }` and only
picked up the shared clock on the next `tickTerrainUTime`. The bake pre-warm
draws the material before that, so every LB stream-in / LOD re-bake / LRU
unpark rendered one frame phase-torn against its already-resident neighbours —
a flicker along the new LB's seam every time terrain rebaked around the player.

**Fix.** `uTime` is seeded from `sharedTerrainTimeSec(scene3d)` (the same
`scene3d.frameTime.tsSec` snapshot `loop.js` pushes), so a fresh material is
phase-locked on its very first drawn frame.

### BUG 9 — the water code set differed between Node and the browser

**Root cause.** `readStrictWaterCodesFlag`'s no-browser branch fell through to
`false`, so the Node harness resolved `TERRAIN_WATER_CODES` to the legacy
7-code set `{16-20,22,23}` while a real page resolved the strict 5-code set
`{16-20}` (live uniform: `uWaterCodeMask == 0x1F0000`). Every sibling reader in
the file returns the *browser default* when `window` is absent; this one
silently disagreed, so any node-side test or capture probe reasoning about the
water mask was reasoning about a set the client never uses.

**Fix.** Returns `true` (the browser default) with no `window`, matching the
siblings. Caught by `test_terrain_water.mjs` Test 9.

### Maintainability: one water test, five sites

All five water sites (scroll UV, POM bypass, TexMerge composite, tint, sheen)
now go through a single `bool isWaterCode(int)` reading `uWaterCodeMask`.
Previously two of them had hardcoded ranges (the pre-F12-5 bug) and the rest
open-coded the mask test inline. `?strictWaterCodes` and any future
region-aware mask edit now move all five together; a test asserts no hardcoded
range survives in either shader stage.

---

## 2. Investigated and cleared (not bugs)

- **Animated-surface frame cycling** (`materialCache.tickAnimatedSurfaces`,
  loop.js). Operates on `_animatedMaterials`, a map of **model/setup**
  `MeshStandardMaterial`s keyed by `surfaceDid`, swapping `mat.map` at 4 fps.
  The terrain `ShaderMaterial` has no `.map` and is not in that map. It cannot
  fight the terrain scroll.
- **`uTime` reset by proximity systems.** `tickTerrainUTime` pushes one
  absolute wall-clock to every registered material each rAF; nothing resets it.
  `landblock_lru` park/unpark filters parked materials out of the registry and
  re-adds them on unpark — correct, since parked meshes are hidden, and an
  absolute clock has nothing to catch up.
- **Bake web-worker.** `bake_worker.js` contains no terrain and no material
  code; the terrain material is built only in `bakeTerrainForLandblock` on the
  main thread. Both worker and fallback paths are therefore identical here.
- **Batched cross-LB mesh** (`?terrainBatch`, **default-ON** — note the stale
  "default OFF" comment at the absorber call site). It derives its variant by
  anchored string replacement against 11 exact lines of this shader, several of
  them adjacent to the water code, and clones the uniform map (so
  `uTime`/`uWaterScrollEnabled`/`uDisplacementEnabled` propagate). All 11
  anchors are asserted to match exactly once by `test_terrain_water.mjs`
  Test 10, and `test_terrain_ring_batch.mjs` still passes.
- **Scroll wrap seam.** `fract(cellUv + t·(.05,.02))` feeding
  `fract(uv * tex_tiling)` is continuous *because* `tex_tiling` is an integer
  (retail 2) — the outer wrap point lands on an inner one. No seam. Locked by
  a comment, not a test (it depends on DAT data).

---

## 3. Verification

### Unit tests

```
test_terrain_water.mjs      70 passed, 0 failed   (new)
test_terrain_texmerge.mjs   33 passed, 0 failed
test_terrain_detail_tex.mjs 17 passed, 0 failed
test_terrain_palette.mjs    22 passed, 0 failed
test_terrain_ring_batch.mjs 23 passed, 0 failed
```

Pre-existing failure, **not** caused by this work:
`test_terrain_visual_z.mjs` — imports `getTerrainVisualZ`, which does not
exist at `HEAD` either (`git show HEAD:...terrain.js | grep -c` → 0). Stale
test for a removed export.

Also pre-existing per the 07-31 relief handoff and untouched here:
`terrain_subdiv::tests::triangle_corner_ring_matches_height_sampler`.

`node scripts/lint-url-flags.mjs`: 434 → 435 documented flags, undocumented
readers 9 → 8 (`waterWave` now has a row).

### Live pixel-diff (headless SwiftShader, 1280×720, quality=high)

Method: `Page.captureScreenshot` twice N seconds apart, decoded with a
minimal PNG reader, mean-abs RGB diff over a water-only region
(x 850-1250, y 180-430 — excludes HUD, compass and the player).
Location: NW open ocean, `@teleloc 0x01AE0001 100 100 6` (LB `0x01AE0000`,
terrain code 20 across all 81 vertices; the resident set also spans an
LOD boundary — LB (0,176) baked at subdiv 1 next to (0,174) at subdiv 2).

#### 3a. GPU harness — `test_terrain_water_gpu.html` (new)

The in-world route proved impractical to iterate on (SwiftShader needs ~4 min
per boot and the main thread blocks CDP for 30-90 s at a stretch), so the
primary evidence is a **GPU harness that renders the real shader source**.
It fetches `scene3d/terrain.js` at runtime and slices
`TERRAIN_VERTEX_GLSL` / `TERRAIN_FRAGMENT_GLSL` straight out of it, then binds
synthetic textures and the uniform values measured off an actual in-world
material (`uTexMergeEnabled 1`, `uAcGouraudEnabled 1`, `uPbrEnabled 1`,
`uIblEnabled 1`, `uWaterCodeMask 0x1F0000`). Because the source is fetched at
runtime it **A/Bs by swapping the file**, which is how the BEFORE column below
was produced (`git show HEAD:...terrain.js > scene3d/terrain.js`, reload,
restore).

Each arm renders the same mesh at `uTime = 0` and `uTime = 5` and reports mean
absolute RGB delta / share of pixels moved by more than 2/255. 256x256,
headless chromium, SwiftShader.

| arm | BEFORE (HEAD) | AFTER (fix) | reads |
|---|---|---|---|
| `scroll_texmerge_on` — the shipped default path | **0.00 / 0.00 %** | **44.10 / 33.36 %** | BUG 1: the scroll was dead, now it runs |
| `scroll_texmerge_off` — control | 44.04 / 33.36 % | 44.10 / 33.36 % | TexMerge no longer suppresses it |
| `sheen_gouraud` — sheen alone, retail-Gouraud mode | **0.00 / 0.00 %** | **2.81 / 18.65 %** | BUG 2: unreachable branch, now runs (13.28 / 30.28 % before the anti-alias distance fade was added) |
| `sheen_contribution_gouraud` — on vs off, same frame | **0.00 / 0.00 %** | **3.10 / 24.33 %** | it actually changes pixels (14.25 / 33.34 % pre-fade) |
| `all_three` — swell + scroll + sheen | **15.94** (= `swell_only` **exactly**) | **35.22** | BEFORE: only ONE of the three ran. AFTER: they compose |
| `swell_only_seg8` — subdiv factor 1 | 15.94 | 17.44 | |
| `swell_only_seg64` — subdiv factor 8 | 17.86 | 17.49 | AFTER: factor-independent |
| **`lod_identity_t3`** — factor 1 vs factor 8, same instant | **11.05 / 14.64 %** | **1.72 / 1.97 %** | BUG 3: the LOD tear, gone |
| `lod_identity_flat_baseline` — same two meshes, swell off | 1.87 / 1.91 % | 1.87 / 1.91 % | the floor: pure rasterisation noise |
| `faux22_scroll` — code 22 FauxWaterRunning | n/a (excluded) | **44.10 / 33.36 %** | BUG 6: flows like the water it is drawn from |
| `faux22_no_swell` — code 22 swell | n/a | **0.00 / 0.00 %** | ...and still does not bob |
| `slime23_static` — code 23 SeaSlime, all effects on | 0.00 / 0.00 % | 0.00 / 0.00 % | stays out of both sets |
| `scroll_off` — `?waterScroll=off` | 0.00 / 0.00 % | 0.00 / 0.00 % | rollback is exactly static |
| `land_no_anim` — code 5 | 0.00 / 0.00 % | 0.00 / 0.00 % | land never animates |
| `sheen_contribution_land` | 0.00 / 0.00 % | 0.00 / 0.00 % | sheen contributes nothing off water |

Two readings are worth stating plainly:

* **`all_three` BEFORE equals `swell_only` BEFORE to four decimals (15.9433).**
  That is the whole bug report in one number: with every water flag reading ON,
  exactly one of the three effects was contributing anything.
* **`lod_identity_t3` AFTER (1.72 / 1.97 %) is at or below the flat baseline
  (1.87 / 1.91 %).** Factor 1 and factor 8 now render the same surface at the
  same instant, to within the rasterisation noise two different tessellations
  of a *flat* plane already produce. BEFORE it was 6x the baseline.

Re-run: `python3 scripts/serve.py`, then load
`http://127.0.0.1:8765/apps/holtburger-web/test_terrain_water_gpu.html`
headless and read `window.__waterHarness` once `window.__waterHarnessDone`.

#### 3b. Live in-world, before and after

Headless SwiftShader, 1280x720, `quality=high`, all flags default, NW open
ocean (`@teleloc 0x01AE0001 100 100 6`; LB `0x01AE0000` is terrain code 20 at
all 81 vertices, and the resident set spans an LOD boundary — LB (0,176) baked
at subdiv 1 next to (0,174) at subdiv 2). Two `Page.captureScreenshot` frames
5-7 s apart, mean-abs RGB diff over a water-only region (x 850-1250,
y 180-430; excludes HUD, compass, player), decoded with a minimal PNG reader.
**The vertex swell is frozen (`uDisplacementEnabled = 0`) in both rows so the
measurement isolates the SURFACE animation** — the thing that was dead.

| | meanAbsDiff | pixels changed |
|---|---|---|
| BEFORE, `uTexMergeEnabled = 1` (the shipped default) | 0.42 | **0.00 %** |
| BEFORE, `uTexMergeEnabled = 0` (forced, control) | 2.50 | 45.7 % |
| **AFTER, `uTexMergeEnabled = 1` (the shipped default)** | **13.14** | **80.85 %** |

Live uniform confirmation on the final build (7 LBs + the cross-LB batch
material): `uDisplacementEnabled 1`, `uWaterScrollEnabled 1`,
`uWaterCodeMask 0x1F0000` (swell: 16-20), `uWaterSurfaceCodeMask 0x5F0000`
(surface: 16-20 **+ 22**), `uTime` advancing and seeded non-zero.

The live route also earned its keep beyond the numbers: it is how the sheen's
distance aliasing was found (see BUG 2's follow-on) — the GPU harness could not
have shown it, because the harness camera never looks 200 m down a sea.

---

## 4. Remaining known issues

1. **Shoreline cells that straddle an LOD boundary can still crack by up to
   half the swell amplitude (~0.12 m).** The lattice lock removes the open-water
   crack exactly, but the *classification* is still binary per vertex: if a
   fine LB's edge midpoint resamples to a land code while both its lattice
   endpoints are water, the fine side stays flat while the coarse side's chord
   is lifted. Fixing it properly means giving the vertex stage the same
   bilinear water fraction the fragment stage has — which needs `uVertexTypes`
   bound in the vertex shader *and* a matching anchored patch in
   `terrain_batch.js` for the `sampler2DArray` + `aLbSlot` form. Judged not
   worth the batching risk for a shoreline-only, sub-decimetre residual.
2. **Code 22 (`FauxWaterRunning`) shares a retail RenderSurface with code 16
   (`WaterRunning`) on the BC7 arm**, but `strictWaterCodes` (default-on)
   excludes 22 from the water mask. So two cells drawn from the *same texture*
   animate differently. That is the deliberate SurfChar-table decision recorded
   in F12-5, not a new regression — but it is the most likely thing to be
   flagged in a BC7 eye-test. The "keep-22-scroll-only" refinement (a second
   mask: scroll+tint but no swell) is still deferred.
3. **Lava is still dead code.** `TERRAIN_LAVA_CODES` is empty for Region 0x13.
   The branch is now lattice-locked too, so a region-aware extension inherits
   the crack-free property instead of re-opening the seam — but it has never
   been run.
4. **No real-GPU eye-test yet, and no post-fade in-world shot.** Everything
   above is SwiftShader + numeric. The final build (two masks + the sheen
   distance fade) is verified on GPU via `test_terrain_water_gpu.html` and by
   the unit tests, but the last in-world screenshot predates the sheen fade —
   the box ran out of RAM (555 MB free with the other terrain agents running)
   and the client stopped getting through terrain bake, so I stopped rather
   than OOM someone else's session. The remaining owed check is one look at
   open water on the `?terrainBc7=on&texBc7=on` hires arm (`:8767`) and on the
   GTX-1070, specifically: (a) does the 30-160 m sheen fade band read as a
   visible ring on a real GPU, and (b) does code 22 FauxWaterRunning now
   match its WaterRunning neighbours.
5. `uTime` is `performance.now()*0.001` and grows unbounded. At ~10⁵ s
   (≈28 h uninterrupted session) float32 quantisation of `uTime * 0.05` starts
   to make the scroll step visibly. Not worth fixing until sessions get that
   long; noted so nobody re-derives it from scratch.

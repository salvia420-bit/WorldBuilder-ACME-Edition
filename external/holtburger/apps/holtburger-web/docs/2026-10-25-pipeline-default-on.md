# The re-engineered pipeline on the 1070 — first runs, the gap to parity, and the flip to default-on (2026-10-25)

Owner ask: "lets deal with the reenginnered pipeline now and get that default on to see where we are at. and the
rest of the work. lets get this going and working and default on." After the first clean A/B the owner chose
**"Hold until parity"**: the chain stays opt-in until it is at least as fast as today's default. The fixes below
brought it there the same day, and the chain is now **DEFAULT-ON** (§7).

Box: the "1070" is an ASUS GL702VSK laptop (i7-7700HQ 4c/8t, 16 GB, GTX 1070), AC power, Best-performance power
overlay, built-in AUO panel at 120 Hz (WMI lists only 120/60; the NVIDIA panel overclock to 144 Hz is OFF by
the owner's choice — a 144 Hz run would move every rAF grid). Chrome 156.0.8078.47, ANGLE D3D11. Release wasm
rebuilt from HEAD 51044ec8: byte-identical to the served `pkg/` (serve.py's "stale" warning was a commit-date
false positive). Evidence tags: **[M]** measured, **[D]** derived.

## 1. What is in the tree now (uncommitted at time of writing)

| Change | Where | Tests |
|---|---|---|
| One reader for all seven stages, one shared default, the kill cascade, the slot grid's ring veto | `scene3d/pipeline_flags.js` (`PIPELINE_DEFAULT_ON`, `true` since §7), wired into `pack_fetch_controller.js`, `geom_bundles.js`, `bc7_textures.js`, `residency_grid.js`, `frame_work.js`, `pool_registry.js`, `index.js`, `index.html` | `harness/test_pipeline_flags.mjs` (both polarities, 134); every stage suite reads the constant and passes at both values; one check pins the shipped value |
| Ladder heap trigger re-class: the larger of 0.9×M1 and 0.65 × the reported `jsHeapSizeLimit` | `residency_grid.js` `ladderHeapTriggerBytes` | `harness/test_residency_grid.mjs` PART 9 |
| The grid honours `?objRadius`: object feeds gated by `objectBakeAllowed`, re-fired on every landblock crossing | `index.js` grid `feeds.fireLb` + `sgCtl.tick`, `residency_grid.js` `refireWindowFeeds` | `harness/test_residency_grid.mjs` (409) |
| Preview-born materials that expect a full tier are born with a shared flat normal map, so the NRA attach swaps a texture instead of compiling a USE_NORMALMAP program | `materials.js` `flatNormalPlaceholder` | `harness/test_tex_compressed_only.mjs` (125) |
| frame_work leaves BOOT on `ready` / the boot history, not only the transient `in-world` scalar (a session stuck in BOOT ran the 50 ms stream budget) | `frame_work.js` default `isInWorld` | `harness/test_frame_work.mjs` PART 6 (183) |
| Pools honour `?objRadius` hides: a sticky per-landblock hide (members carry `lbKey`; commit, re-adopt and the cell PVS respect it) | `pool_registry.js` `hideLb`/`showLb`, `tile_plan.js`, `object_radius.js`, `index.js` | `harness/test_draw_pools.mjs` PART 22 (475), `test_object_radius.mjs` (35) |
| Bench tools: experimental Chrome arms (`--angle` / `--disable-features` / `--extra-flags` for `hbsess`, `arm.chrome` for `hbbench`), page-side `__hbConsoleErrors` | `scripts/perf-worker/hbsess.mjs`, `hbbench.mjs`, `box/hbprobe-launch.bat` | used live |

The flip (§7) = `PIPELINE_DEFAULT_ON = true` + the url-flags rows + the test pin; turning it back off is the
same three edits.

## 2. First 1070 boots of the full chain [M]

`packSource, geomBundles, texCompressedOnly, slotGrid, frameWork, drawPools` (+ `reliefBundles` so relief stays on),
ultra, Holtburg, off-screen, uncapped:
- Boots clean, **0 console errors**, every stage armed (84 CAS objects verified / 0 mismatch, 36 live slots / 0
  desyncs, 1,738 bundles, relief armed with 1,681 relief models, 76 pools / 18 classes, runs live in 75).
- The frame matched the bare default's at the same orbit pose (including the building cutaway, which is normal).
- **Bug 1 — the ladder.** The chain sat at 1.59–1.61 GB `usedJSHeapSize` (bare: 0.98 GB) against a 4.40 GB
  `jsHeapSizeLimit`. The fixed trigger (0.9 × 1.6 GiB = 1.44 GB) held the ladder at R4 all session: textures
  demoted to previews (R1), lane T and W2 uploads suspended, frame_work in EMERGENCY, 788 pool members waiting
  on BC7. Re-classed (§1); afterwards rung 0, NORMAL, heap ~1.33 GB.

## 3. The A/B (hbbench, fresh profile per run, interleaved, 2 reps, frozen snapshot on :8766) [M]

| Arm | firstTurn | still | moving | tour fps / jank / h100 |
|---|---|---|---|---|
| bare ultra | 32.1 | 44.0 | 44.3 | 42.9 / 4,437 / 17.5 |
| chain ultra | 25.1 | 40.4 | 39.4 | 39.9 / 5,822 / 26.5 |
| bare high | 29.9 | 44.5 | 44.0 | 41.5 / 5,748 / 24.0 |
| chain high | 29.0 | 40.5 | 40.1 | 40.2 / 5,507 / 23.0 |

Chain −8 to −11 % still/moving at both presets (rep spread ≤ 1.3 fps), 0 errors everywhere. Bare high ≈ bare
ultra off-screen at 1280×720: this bench is CPU-bound.

## 4. The stage breakdown (same protocol, ultra) [M]

| Arm | still | moving | tour | first turn | draws |
|---|---|---|---|---|---|
| packs + bundles + relief + compressed | +1.0 % | −0.3 % | −0.2 % | −20 % (noise, §5) | 1,153 vs 1,146 |
| + slot grid + frame_work | −4.7 % | −7.7 % | −3.2 % | −27 % | 1,231 |
| + pools (the full chain) | −6.8 % | −9.5 % | −4.8 % | −12 % | 1,231 |

1. **Packs, bundles, relief and compressed textures are at parity** in steady play.
2. **The grid (+ frame_work) carries most of the loss.** Cause found [D, code read]: the grid was built before
   `?objRadius` (2026-10-04) and its feed called the statics/buildings loaders for every window landblock — 144 —
   while the legacy ring bakes objects only within the near radius (4 ⇒ 81 landblocks). cells.js collapses its
   own ring to 0 under the grid, so the legacy economies (object radius, the fog cap, the indoor collapse) all
   fell away. Fixed for the object radius (§1); the fog cap and indoor collapse are still owed.
3. **Pools add ~2 %**, and their members ignore object-radius hides (pools park per tile, not per landblock).

### 4b. The same breakdown after the fixes (snapshot `p0chain-fix1`: ladder, objRadius gate + crossing refire, BOOT exit, flat-normal placeholder) [M]

| Arm (ultra, 2 reps) | still | moving | tour fps / jank / h100 | first turn | draws |
|---|---|---|---|---|---|
| bare | 44.8 | 45.1 | 44.5 / 3,975 / 18.5 | 30.6 | 1,152 |
| chain | 44.8 (−0.2 %) | 44.4 (−1.7 %) | 45.1 (+1.3 %) / 3,949 / 16.0 | 32.0 (+4.6 %) | 1,140 |
| chain − pools | 44.3 (−1.2 %) | 44.7 (−0.9 %) | 46.1 (+3.5 %) / 3,202 / 14.0 | 27.2 | 1,132 |
| packs only | 44.0 (−2.0 %) | 44.4 (−1.7 %) | 43.4 (−2.7 %) / 4,500 / 22.5 | 25.8 | 1,150 |

The −8 to −11 % gap closed to within the rep spread; the chain now draws slightly less than bare. The
first-turn column still moves with the one-off compile stalls of §5. A fresh profile per run, so nothing here is
warm-cache flattery.

### 4c. The parity check (snapshot `p0chain-fix2` = fix1 + the pool per-landblock hide; ultra AND high) [M]

| Arm (2 reps) | still | moving | tour fps / jank / h100 | first turn | draws |
|---|---|---|---|---|---|
| bare ultra | 44.8 | 44.4 | 45.2 / 3,194 / 17 | 30.1 | 1,143 |
| chain ultra | 44.0 (−2.0 %) | 44.2 (−0.2 %) | 45.3 (+0.1 %) / 4,164 / 20 | 28.6 | 1,138 |
| bare high | 44.5 | 44.4 | 43.8 / 4,121 / 17 | 36.5 | 1,146 |
| chain high | 43.8 (−1.6 %) | 44.5 (+0.3 %) | 44.9 (+2.4 %) / 4,150 / 19 | 30.2 | 1,130 |

Moving and touring at parity on both presets; standing ~0.7 fps lower (the fix1 run read standing 44.8 = 44.8, so
this sits at the cross-run noise, not clearly zero); 0 console errors in every run.

## 5. The first-turn stall is pre-existing [M]

`gputrace.mjs` + `angleattr.py`, first 12 s sweep after boot:
- bare: 18 pixel shaders through D3DCompile (FXC) = 9.7 s, max 1.7 s for one; a 701 ms
  `Program::MainLinkLoadEvent::wait` on CrGpuMain (a draw beat its program's link).
- packs-only: 18 / 7.6 s / max 1.39 s; a 676 ms wait.
So the bench's first-turn deltas are one-off 0.5–1.3 s stalls landing differently per run, and the stall itself
is the client's biggest cold hitch on D3D11 — the target of the ANGLE backend experiment.

## 6. Visual parity and robustness [M]

Same four poses per arm (street north, street east, close south, high orbit), ultra, Holtburg, frames grabbed
inside the screen-target render.
- **Pin the sky first.** The first unpinned pair showed the distant conifers reddish-brown in the chain and dark
  teal in the default. That was the real day clock plus the per-session volumetric clouds and their shadows:
  with `?skytime=12&clouds=off&cloudShadow=off` the forest matches tree for tree, and the per-pose difference
  images are edges only (wind-swayed trees, grass blades).
- **Pond flecks are particles.** Lily-pad-like green flecks on the Holtburg pond came and went between runs in
  both arms; in one session per arm (default, chain, chain without pools) they show in a frame and are mostly gone
  4 s later.
- **The tent by the pond** looked darker in one chain frame. A ray probe at its pixels finds the same object in
  every arm (a plain building mesh, four non-emissive wood surfaces, not pooled), and three fresh sessions render
  it alike: lighting/shadow timing, not the chain.
- **Context loss on the chain** (`WEBGL_lose_context` lose + restore): restored, 14 textures rehydrated, 0 failed,
  0 restore failures, 0 console errors.
- **`__bc7Pending` on ~110–150 drawn materials is a stale flag.** A tier census of the chain found 144–148,
  static over 60 s with nothing queued or in flight. Probing the BC7 source for each one: 104 of 110 have the
  full record cached (96 already draw at its exact dims), 6 have an absent verdict, 0 in flight, 0 never asked.
  These are the floor-bias / front-side clones minted with `{...base.userData}` while the base was pending — the
  pre-chain defect `buildings.js` records as R1 (Linvak Tukal: 192 of 215 clones pending, 0 of their bases):
  `_repointAlbedoForDid` moves their map and leaves the flag. No pixels change; the cost is pool coverage (§8).
  The old stack (`?packSource=off&frameWork=off`, same pose) carries more of them: 189–193, of which 184 have the
  full record cached and 5 an absent verdict, 0 in flight.

## 7. The flip (2026-10-25) [M]

The owner's criterion was "at least as fast" at ultra and high. Across the two post-fix runs (§4b, §4c) the chain
reads still −0.2 % / −2.0 % (ultra) and −1.6 % (high), moving −1.7 % / −0.2 % (ultra) and +0.3 % (high), tour
+1.3 % / +0.1 % (ultra) and +2.4 % (high): every delta inside the run-to-run spread (≤ 1.3 fps), standing the only
one that leans negative, 0 console errors in every run, and the frames match (§6). On that reading the chain is at
parity, and `PIPELINE_DEFAULT_ON` is now `true`: absent flags read ON, `?<stage>=off` is the escape, and an off
stage cuts everything downstream (`?packSource=off&frameWork=off` restores the old stack in full).

## 8. Still owed

- **Pool coverage — the stale clone flag** (fix landed as `?bc7PendingByRs`, default ON, §9; bench pending). The chain's pool producer held 177 nodes out on `bc7Pending`
  (812 refusals, 309 stale re-offers in one session), because the node's material is a clone carrying the copied
  flag. They render through the building batches as in the old default, so nothing is missing, but the pools
  never take them. Fix: track pending per rsId in `bc7_textures.js` and have `bc7PendingOn` trust that over a
  copied flag (or clear the flag on the clone families at settle, before `_rsVerdictResolved`), then measure the
  draw delta.
- **The grid's fog cap and indoor collapse** for non-sealed interiors (the legacy ring's economies; sealed
  dungeons already collapse via `sealedCull`/`sealedEvict`).
- **Memory.** The chain holds more JS heap (Holtburg ~1.17–1.33 GB vs ~0.72–0.98 GB). The ladder trigger is now
  0.65 × the reported heap limit; a machine with a small limit will sit on the ladder's lower rungs sooner.
- The first-turn FXC compile stall (§5) is the same in both arms; it is the ANGLE-backend experiment's target.

## 9. After the flip: the stale-flag fix and experimental Chrome (2026-10-25)

**`?bc7PendingByRs` (DEFAULT ON, `=off` escape).** `upgradeMaterialToBc7` now opens a per-rsId wait where it
raises `__bc7Pending` and closes it where the verdict settles, before the refeed fires; `bc7PendingOn` ignores a
flag whose rsId has settled with no wait open (a copy on a clone), and a flag with no history still reads pending.
`harness/test_bc7_pending_by_rs.mjs` (28) pins it, every suite touching the BC7 path still passes (28 files), and
the url-flags row records it. The effect on pool coverage, draws and frames is measured below.
Live (chain default, Holtburg, pinned sky): pool hold-outs 181 → 16 (`bc7Pending` 135 → 0; the rest are
`offPage`, which wait on their full tier by design), page layers in use 59 → 80, 0 console errors [M].

**Pool page uploads (no flag — a correctness fix).** Probing the class pages live found diffuse layers written
but never sent: `admit` and `refeedRsId` marked a layer with `addLayerUpdate` and never moved the texture's
version, and three uploads only on a version change. So after a page's first upload, a member admitted later
drew from a layer the GPU never received, and a full tier landing on a pooled member never reached the screen.
Measured: 10 such layers, 16 visible instances on them (none in the four test poses, so no frame showed it).
`_queueLayerUpload` now marks the layer and moves the version (the atlas's `touchedDiff`/`touchedNra` rule), a
refeed also repacks the nra layer from the upgraded material, and the live re-probe reads 0 unsent layers over
20 s. `harness/test_pool_page_uploads.mjs` (16; 7 of them fail on the old code).

**Experimental Chrome — start checks on the 1070 (Chrome 156, chain default, ultra) [M].** Every arm boots to
`ready` with 0 console errors:

| Arm | Renderer string | Notable extensions |
|---|---|---|
| default (D3D11) + `--enable-webgl-draft-extensions` | Direct3D11 vs_5_0 ps_5_0 | adds `WEBGL_draw_instanced_base_vertex_base_instance` and `WEBGL_multi_draw_instanced_base_vertex_base_instance` |
| `--use-angle=gl` | OpenGL 4.5.0 | parallel shader compile present |
| `--use-angle=vulkan` | Vulkan 1.4.312 | **no `KHR_parallel_shader_compile`** |
| `--use-angle=d3d11on12` | Direct3D11on12 | boot to ready took 147 s (D3D11: ~70 s) |
| D3D11, `--disable-features=SkiaGraphite` | Direct3D11 | — |

A backend switch changes no pixels (same shaders, same textures), so it is the visual-neutral kind of gain, and
OpenGL and Vulkan skip FXC, the compiler behind the first-turn stall (§5). Owner, 2026-10-25: requiring a flag is
acceptable "if it merits it". The draft extensions would let batched draws take their instance index from
`baseInstance` instead of `gl_DrawID`, which ANGLE's D3D11 multi-draw loop pays for with a uniform-buffer update
per sub-draw; using them needs new draw code, so the `?terrainNoDrawId=off` arm prices the per-draw cost first.

**ANGLE backend bench (hbbench, 2 reps, fresh profile per run, snapshot `p0default-on`, ultra) [M]:**

| Backend | first turn | still | moving | tour fps / jank / h100 |
|---|---|---|---|---|
| D3D11 (stock) | 30.4 | 45.0 | 44.7 | 44.8 / 4,804 / 23 |
| **OpenGL** (`--use-angle=gl`) | **45.8 (+50 %)** | **47.4 (+5.2 %)** | **47.0 (+5.1 %)** | **48.4 (+8.2 %) / 3,008 / 13** |
| Vulkan | 29.6 | 30.2 (−33 %) | 32.1 (−28 %) | 33.7 (−25 %) / 4,865 / 16 |
| D3D11on12 | 15.2 | 31.4 (−30 %) | 32.2 (−28 %) | 35.5 (−21 %) / 13,209 / 76 |
| D3D11, Graphite off | 28.5 | 44.9 | 44.6 | 44.7 / 4,618 / 20 |

Rep spread ≤ 1.8 fps; 0 console errors in every run. OpenGL wins every phase, the first turn most (no FXC), with
~40 % less tour jank; Vulkan and D3D11on12 lose a quarter to a third; Skia Graphite on or off is noise. On the
owner's NVIDIA box this is a browser setting, not code: `chrome://flags/#use-angle` → OpenGL.

## 10. Pool nra pages at source resolution (2026-10-26)

**Why it was looked at.** In the first rep of the rest-of-work bench (`rest2`, snapshot `p0default-on`, high),
the chain default's tour jank read 5,634 against 3,296 for `packSource=off&frameWork=off`, at near-equal fps
(44.2 vs 45.2) [M, one rep; the run was cut short when the presence gate refused]. The snapshot is the first one
whose pool page uploads work (§9), so every admit now sends its layers.

**What the code does [C].** three r184 (`WebGLTextures.js`, the `isDataArrayTexture` branch) sends only the layers
in `layerUpdates`. It then calls `generateMipmap(TEXTURE_2D_ARRAY)`, which rebuilds the mips of EVERY layer in the
array. The pool's nra pages (RGBA8, `generateMipmaps = true`) were allocated at the class's diffuse dims. Under the
chain that is the x4 BC7 full tier, while every plane `packNraLayer` reads is smaller:
- the worker normal is half that tier (`texture_worker.js`, `want.nra = "half"` reads level 1);
- the seam height and the texchan roughness/AO are DAT size.

So each layer held 2x2 or 4x4 nearest-neighbour copies of every real texel. That multiplied three costs by 4 to 16:
the main-thread pack (`_liftChannel` plus the per-pixel loop), the upload (16 MiB per 2048² layer) and the
whole-page re-mip on every admit. The atlas has had the opposite rule since memory-1 (`?nraSourceRes`, default ON,
owner-approved), so the chain had also lost that rule's near-field look: the pool drew 2x2 normal blocks where the
chain's own singleton materials filter the real texels.

**Size [M + computed].** From the Holtburg class-page census (10-25, chain default):
- 19 classes, 54 layers, about 198 MiB of nra pages counting mips: 2048² 85 MiB, 1024² 69 MiB, 512² 35 MiB.
- At the planes' size, the f7 pages come to about 52 MiB if every member carries the half-res worker normal, and
  less where only DAT-size planes exist.
- One 2048² layer is 4 MiB instead of 16 MiB.

**Fix (`?nraSourceRes`, the same switch as the atlas).** A class page has one material, so it can't split by size
the way atlas buckets do (`|n<w>x<h>`). Instead its nra page holds the per-axis max of its members' asks
(`_nraAskFor`):
- An ask covers every plane the packer reads, the wasm-memo fallback included, clamped to the page.
- A larger member grows the page (`_fitNra` / `_resizeNra`), repacking every live layer from the material it keeps.
- The page never shrinks, a flat first member starts it at 1x1, and capacity keeps the page-dims arithmetic.
- `=off` gives the old dims byte for byte.

`harness/test_pool_nra_source_res.mjs` (47) pins it. `test_pool_page_uploads.mjs` now also accepts a re-allocated
page as "sent", since a new texture uploads in full. `test_draw_pools` (475) and `test_rsid_marker` (87) pass
unchanged; the full JS gate reads 903/903. Bench snapshot: `p0nra-src` (= `p0default-on` + this change).

**Owed on the 1070.**
- The tour-jank A/B: default against `nraSourceRes=off` on a snapshot with this change, plus the `statNra=off`
  diagnostic arm.
- The live census: `byClass[].nw/nh` and `layers.nraResizes`.
- A near-field look at relief on pooled statics. Expected: smoother, the chain's singleton look.

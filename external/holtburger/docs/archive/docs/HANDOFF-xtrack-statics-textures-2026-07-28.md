# HANDOFF — X-track: non-terrain texture modernization (buildings/statics)

**Date:** 2026-07-28 · **Plan:** `docs/terrainplan.md` §2 (X1–X6) · **Task list:** #5
**Prereq state:** terrain track (T1–T4 + water) is DONE, default-ON, pushed (`a6bc2d7f`,
`73d7e31b`, `6e0f8213`). This handoff covers the statics/buildings side.

---

## 0. FIRST ORDER OF BUSINESS — the statics-smear regression: FOUND, ROOT-CAUSED, FIXED

**Symptom (user-reported):** building textures (and other statics) render as smeared,
textureless streaks — Holtburg roofs were brown goo; tent canopies at Yaraq were giant
smeared blue arcs previously mistaken for sky/cloud artifacts.

**NOT caused by the terrain work.** Evidence: the smear is present in the retail-arm
screenshots taken 2026-07-28 *before* `?ibl`/`?pbrTerrain` existed in the tree
(session scratchpad `shots/yaraq-off.png`). A live same-camera A/B pinned it:
`?statAtlas=off` → crisp thatch/stone; default → smear
(scratchpad `ab-statatlas-on.png` / `ab-statatlas-off.png`).

**Root cause** (`scene3d/static_atlas.js`): the cross-LB statics texture-array atlas
samples `texture(uDiffuseArray, vec3(vMapUv, vLayer))` on a **ClampToEdge** array with
**no `fract()`**. Any member whose UVs tile past [0,1] clamps to the edge texel and
smears it across the face. Retail building surfaces tile hard (roof `u ≈ 6.75` —
terrainplan §X3), and **`?buildingBatch` (default-ON since 2026-07-14) feeds buildings
into exactly this atlas** — which is when whole buildings started smearing. RND-33
(2026-07-27) had already split WRAP vs CLAMP members into separate buckets (the
stateKey's trailing `w`/`c` field) but never gave the wrap bucket a wrapping sampler —
the keying half of the fix landed without the sampling half.

**Fix (this commit):** wrap buckets now sample
`textureGrad(uDiffuseArray, vec3(fract(vMapUv), vLayer), dFdx(vMapUv), dFdy(vMapUv))`
— `fract()` restores tiling; the *unwrapped* UV's derivatives keep mip selection
continuous across the fract seam (no per-tile min-mip seam sparkle). Two program
variants via `customProgramCacheKey` (`statAtlasArrayMatV3w`/`V3c`).

**Validated:** local quality=high boot, default flags — Holtburg buildings render
crisp thatch rows + stone detail with the atlas ON (`ab-statatlas-fixed.png`), zero
console errors. **Residual known trade:** a packed layer cannot bilinear-filter
across its own wrap seam → half-texel discontinuity per tile repeat; invisible on
edge-matched retail tiles. **Pending:** a quick 1070 real-GPU glance (SwiftShader
validated the logic, not the look at anisotropic grazing angles).

**Re-verify recipe:** boot `?quality=high`, `@telepoi Holtburg`, compare default vs
`?statAtlas=off` — they should now be near-identical (atlas arm loses normal maps,
see §3).

## 1. Why this blocked the X-track

X-track replaces the very textures this atlas packs. Judging CC0 substitutions or
ESRGAN upscales through a smearing sampler is meaningless — every "after" image would
have been corrupted by the addressing bug, not the texture content.

## 2. X-track plan (terrainplan §2, with session-learned anchors)

- **X1 census:** WB.Terminal `asset-used-by` reverse graph (`{"command":"asset-used-by",
  "datPath":…,"id":"0x08…"}`) → rank world-visible Surfaces by placement frequency;
  exclude icons/UI/clothing. Needs a project (`-p ~/projects/RetailSmoke/RetailSmoke.wbproj`).
  Output: ranked worklist + contact sheets (reuse the T2 pattern below).
- **X2 classify:** tiling-material vs unique-painted (windows/doors/signs painted INTO
  walls must NOT be replaced by tiling materials). Autocorrelation/FFT tiling-ness on
  buildbox CPU.
- **X3 substitute (tiling class):** CLIP-embedding match against ambientCG/PolyHaven
  CC0 (buildbox CPU is fine). REUSE the T2 curation infrastructure verbatim —
  `/mnt/wbterminal2/pbr-terrain/` has the API scripts, thumbnail-shortlist reviewing,
  retail-vs-CC0 contact sheets, and mean-luminance gain checks; §X3 preserves UVs
  exactly and derives tiling scale from retail UV density (the u≈6.75 fact).
- **X4 upscale (painted class + tail):** ESRGAN ×4 — `realesrgan-ncnn-vulkan` runs
  headless on the 1070 off-screen (fleet rules apply: never touch the person's
  chrome/session; batch it), or buildbox CPU overnight. This is ALSO the safe
  baseline that ships visible value first.
- **X5 material/atlas engineering:** the statics atlas is **albedo-only v1** — the
  atlased path silently DROPS each material's normalMap (static_atlas.js header),
  which reads flatter than the singleton path. Add parallel normal/roughness arrays
  sharing the ONE UV layout (mirror the terrain nra pack: normal XY + rough + AO in
  one RGBA array). Do it inside static_atlas.js, not ad hoc. Track unique-surface
  count before/after dedup. Respect the VFX invariants: no per-instance
  customProgramCacheKey, no light-count changes.
- **X6 render-only wall displacement:** LAST; evaluate terrain POM's results first.
  Physics polys/BSP untouched (GfxObj already splits render vs physics — terrainplan
  invariant 4).

## 3. Adjacent known issues to keep separate from X-track judgments

- Atlased statics have **no normal maps** (v1 albedo-only) → flatter than
  `?statAtlas=off`. That's X5's job, not a regression.
- `?walkInInstance` stays OFF by user directive (url-flags.md row) — its two visual
  trades are unrelated to textures.
- Terrain 1K tier is quality high/ultra only; `?atlasTilePx=512` for A/B parity runs.

## 4. Tooling that now exists (use it, don't rebuild it)

- `scripts/perf-worker/biome-eyetest.mjs` — the 1070 off-screen biome capture driver
  from the terrain campaign: CDP connect via the launch-task recipe
  (memory/fleet-runbooks.md MODE2i), login-race retry, **forced-noon injection**
  (freezes `skyLightingController.tick` and installs a Midsong state — no waiting
  ~40 min for server dawn; a Dereth day is 7620 s), streaming-settle polling,
  `@telepoi` spots (POIs land correctly; raw `@teleloc` into unstreamed landblocks
  falls through collision and strands the follow-cam top-down).
- POIs per biome from ACE MySQL (`points_of_interest` ⨝ `weenie_properties_position`,
  creds in `$ACERT/Config.js`) — the terrain session used Holtburg/Neydisa/Stonehold/Fiun.
- WB.Terminal map scan: `terrain-info` over a lbX/lbY grid finds biome exemplars
  (33-layer terrain codes); the same batched-JSON-stdin pattern works for any
  per-landblock census.
- `?nosw=1` on every dev URL; serve.py :8765; tunnel recipe for the 1070 in
  memory/fleet-runbooks.md. Kill test chrome ONLY by `--user-data-dir` match.

## 5. Suggested order

1. 1070 glance at the smear fix (one Holtburg capture, default flags).
2. X1 census + contact sheets → pick the top ~50 world-visible surfaces.
3. X4 ESRGAN baseline over that top-50 (fastest visible win, zero curation risk).
4. X5 normal/rough arrays for the statics atlas (unlocks the T3 env specular the
   terrain already enjoys — buildings currently read matte).
5. X2/X3 CC0 substitution for the tiling class, contact-sheet reviewed.
6. X6 only if POM's terrain results argue for real displacement.

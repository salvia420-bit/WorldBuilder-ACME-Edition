# Holtburger-quality sky in the retail client — buildable design (2026-08-21)

Data-only (route A of `takram-sky-in-retail-research.md`): one modified
`client_portal.dat`, no DLL, ships to every kit user. This doc turns the
verified constraints into a concrete build: a multi-layer NASA-derived cloud
stack, a Bruneton-baked day/night palette, and — the new lever verified here —
**retail's own per-day DayGroup hash as the "changing skies" engine**.
Target look: `/mnt/wbterminal2/dat-patch-ragdoll/sky-mockup/takram_sky_plate_v2.png`
(built by `make_sky_v2.py` in that dir: 3 altitude bands mirroring
holtburger's FAIR_LAYERS, Beer-powder-shaded low deck).

All constraints inherited from `docs/dat-patch/research/takram-sky-in-retail-research.md`
(GameSky::Draw at zfar*4 / DEPTHTEST_ALWAYS / painter's order; world-anchored
orientation — sky does NOT turn with you; camera-position-follow; altitude
lives in the GfxObj mesh; no shaders; no texture-size code cap). Not re-argued.

---
## 1. New verified facts this design is built on

### 1.1 DayGroup selection = deterministic per-in-game-day hash (VERIFIED)
`SkyDesc::CalcPresentDayGroup` (acclient.c:301664):

```c
n = current_day + days_per_year * current_year;          // GameTime
idx = floor( (uint32)(1782775218 * n - 1967253934) * 2^-32 * day_groups.m_num );
present_day_group = idx (0 if out of range);
```

- Called every sky tick via `CRegionDesc::CalcDayGroup` (acclient.c:298943)
  from `GameSky::UseTime` (acclient.c:308827, call at 308843) → the active
  DayGroup is a **pure function of the in-game day number** and flips exactly
  at day rollover (a hard cut mid-session; retail already behaves this way).
- The multiplicative hash is uniform over `m_num` — **each DayGroup is equally
  likely**. `DayGroup.chance_of_occur` is packed/unpacked but never read by
  selection (only refs: acclient.c:302418/302534/302676 = ctor/Pack/UnPack) —
  **weighting is done by slot duplication**, and retail itself does exactly
  that (below).
- `day_groups` is a growable SmartArray sized from the DAT record
  (`SkyDesc::UnPack` acclient.c:302822, `grow(count)` then per-entry
  `DayGroup::UnPack`) — **the DayGroup count is uncapped, we can author N**.
- In-game day length = **7620 s ≈ 2 h 07 m real time**; 360 days/year; 16 named
  times-of-day (Darktide…Gloaming-and-Half) — from the retail Region export
  (`region-export-json`, dat sha256 dc6e500b…, gameTime.dayLength=7620,
  daysPerYear=360). So a fresh sky roughly every 2 hours of play, identical
  for every player on the same server clock (day index derives from
  server-synced GameTime — UNVERIFIED exactly how ACE seeds the epoch, but
  the selection math itself is client-side and deterministic, so a
  "weather forecast by date" is computable offline).

### 1.2 Retail Dereth already IS a weighted weather ladder (VERIFIED)
Retail SkyDesc holds **20 DayGroups but only 4 distinct looks**
(region-export-json on `~/ac_base_dats/client_portal.dat`):
Sunny ×5, Clear ×3, Cloudy ×4, Rainy ×8 → 40 % rain days. Duplication = the
probability knob. Our plan replaces these 20 slots (and may grow the array)
with N distinct NASA-derived states, weighted the same way.

### 1.3 Retail sky asset anatomy (VERIFIED, via WBT read-only)
- Cloud dome `0x01004C36` (the Sunny scrolling cloud layer, tex_velocity
  (−0.013, 0.013), properties 0x2 hide-under-fog) is a **12-triangle faceted
  tent**: rim ring ±10 088 units at z = −400 (below horizon), mid ring
  ±5 045 @ z = 487.5, apex z = 780 (`obj-export` dump). Its Surface
  `0x080000D4` is `Base1Image, Alpha` (per-pixel-alpha blended) →
  SurfaceTexture `0x0500106E` → RenderSurface `0x06004B47` =
  **128×64 PFID_INDEX16**. That is the entire retail cloud: a paletted
  128×64 texture on 12 triangles. The quality headroom is enormous.
- Star shell `0x010015EF` uses Surface `0x0800004D` (Base1Image+Alpha).
  Sunny group stack (7 objects): sun-glow pair 0x010015EE/EF (always-on,
  SkyObjReplace keyframes rotate/luminosity them per time), two moons
  0x01001F67 (t 0.04–0.21, arc −20°..190°) / 0x01001F6A (t 0–0.23), the
  cloud dome, the sun `0x01001348` (t 0.16–0.94, arc −23°..203° — the
  begin/end_angle sun sweep), and a Setup 0x02000714 + PES 0x330007DB.
- Rainy groups (19 objects) additionally ship: a second cloud dome
  0x01004C35, **rain sheets** 0x01004C44 (tex_velocity (0.02, −1.7),
  properties 0x5) and 0x01004C42 ((0.02, −2.0), properties 0x4
  camera-follow) — fast vertical texture scroll = rain streaks — plus
  **lightning/overcast Setups** 0x02000588/589/BA6 with PES scripts
  0x33000428/42C/453 gated to begin/end_time windows. We inherit this whole
  storm vocabulary for free by copying and re-texturing.
- SkyTimeOfDay gradient: Sunny has 11 keyframes (begin 0…0.999) each with
  dirBright/dirColor/dirHeading/dirPitch, ambBright/ambColor,
  min/maxWorldFog + worldFogColor, and a `skyObjReplace[]` list
  (objectIndex, gfxObjId swap, rotate, transparent, luminosity, maxBright).
  Observed transparent values −1/0/100; scalar fields interpolate between
  keyframes (base doc), **gfxObjId swap is a discrete pop — UNVERIFIED
  whether any crossfade exists; schedule swaps at dark/low-contrast
  keyframes**.

### 1.4 Tooling gaps closed (VERIFIED in WBT source)
- **Mesh authoring is NOT a gap**: `obj-export` (JsonCommandProcessor.cs:4784)
  dumps any GfxObj to Wavefront .obj; `obj-import` (…:4811) builds a NEW
  GfxObj from an .obj with `surfaceDid`, `gfxObjId` (explicit id),
  `gfxObjOnly:true`, `overwrite`. Cloud domes are procedurally generated
  .obj files (a 40-line python script) → obj-import. **VERIFY item: that
  obj-import carries `vt` UV coordinates through to the GfxObj UV array**
  (it reports triangle/vertex counts; UV path unconfirmed until smoke-tested
  on a dat copy).
- `render-surface-import` (CommandEngine.DatBake.cs:88) does
  **format-conversion imports including DXT1/3/5** (in-tree BCnEncoder),
  `allowCreate:true` for brand-new 0x06 RenderSurface records, allowResize
  for new dimensions; block-compressed sizes must be multiples of 4; single
  records ≤ ~4.5 MB take the fast path (DatBake.cs:190) — **DXT5 2048² =
  4 MB fits; uncompressed A8R8G8B8 2048² = 16 MB does not** → bake DXT5.
- `region-import-json` (JsonCommandProcessor.cs:5794) validates + stages the
  whole Region into the project PortalDatDocument; `export` writes the
  modified portal dat. Round-trip parity is reported (packParity/packSha256).
- `surface-texture-collapse`, `import-texture`, `asset-refs`/`asset-used-by`
  for wiring Surface→SurfaceTexture→RenderSurface chains.

---
## 2. The NASA/takram raw material (what exists, how it "changes")

Inventory (all under `external/holtburger/apps/holtburger-web/`):

| Asset | What it is | Varies how |
|---|---|---|
| `assets/clouds/local_weather_nasa.png` (512², RGBA) | NASA Blue Marble `cloud_combined`-derived weather map; **R/G/B/A channels = per-layer coverage** (R low cumulus, G mid, B cirrus, A storm cores) — channel semantics from takram `CloudLayers.ts` + `cloud_overlay.js:403-421` ("real frontal systems; A = actual storm cores") | Static file; the SOURCE is global (Blue Marble cloud_combined, 8k+) → unlimited distinct crops; NASA also publishes **monthly** MODIS cloud-fraction maps → seasonal variants. **UNVERIFIED: the repo copy is one fixed crop; the generator `make_weather.py` lived in a scratchpad and is gone — must be rewritten (small: crop + per-étage channel split), noted in pipeline step 1.** |
| `assets/clouds/local_weather_dereth.png` | Biome-anchored map from retail terrain codes (desert clear, marsh/volcano stormy…) — `make_weather_dereth.py` over a get-terrain-layers dump (cloud_overlay.js:411-416) | Alternative source for "Dereth-plausible" coverage; same generator status |
| `assets/clouds/shape.bin` (128³), `shape_detail.bin` (32³), `turbulence.png`, `stbn.bin` | takram's 3D noise + blue noise for volumetric detail | Used only in the OFFLINE shading render (§4.2), never shipped |
| `scene3d/assets/atmosphere/*.exr` (transmittance, scattering, irradiance, single_mie, higher_order) | Precomputed **Bruneton LUTs** (atmosphere_runtime.js:3) | Fixed; sampled per sun elevation → the entire day palette |
| takram `stars.bin` — **9 096 Yale Bright Star Catalog entries** (atmosphere_sky.js:9-10; fetched from `DEFAULT_STARS_DATA_URL`, not vendored) | Star positions+magnitudes | Fixed catalog; rendered once to an equirect star plate |
| `scene3d/assets/moons/{albarel,rezarel}.png` (1024²) | AC-canon two moons, hi-res discs (ac_moons.js:1-35) | Fixed; direct texture source for retail moon billboards |
| `vendor/takram-three-clouds` layer definitions | FAIR: R 750 m/650 m, G 1000 m/1200 m, B 7500 m/500 m (CloudLayers.ts:31-68) + holtburger alto A 3500 m/600 m; STORM: deck lowered to 600 m, **Cb tower 600 m base / 6000 m tall, dense-base density profile, coverage keyed to the NASA A channel** (cloud_storm_look.js:60-96) | The altitude/density recipe our dome bands and offline renders copy |
| `scene3d/daygroup_weather.js` PROFILES (20 entries) | holtburger's own DayGroup-index → weather mapping (sunny/hazy/…/thunderstorm) | The naming/ladder template for §3.1 |

**The honest statement of "changing NASA data":** nothing in the repo
auto-updates. The variation we exploit is (a) the NASA source imagery is a
huge, real, non-repeating field — every DayGroup gets a **different crop** (and
optionally a different month), so no two authored skies share cloud shapes,
unlike tiled procedural noise; and (b) retail's per-day hash (§1.1) cycles
those authored states endlessly. "The sky changes" = real day-to-day rotation
through real-cloud-shaped states, not a live feed.

---
## 3. The design

### 3.1 The DayGroup ladder — 24 groups, 12 distinct skies
Replace retail's 20 slots with 24 (array is uncapped, §1.1; 24 keeps rain
odds near retail's 40 % while adding variety). Weight by duplication:

| Class | Distinct looks | Slots | NASA source per look |
|---|---|---|---|
| Clear | 2 | 4 | near-empty crops; cirrus wisps only |
| Scattered cumulus | 3 | 5 | low-coverage trade-wind crops |
| Broken / alto | 3 | 5 | mid-coverage frontal edges |
| Overcast | 2 | 4 | stratiform sheets (winter-month maps) |
| Rain | 1 | 4 | dense frontal crop + retail rain sheets |
| Storm | 1 | 2 | crop centered on an A-channel storm core; Cb band + lightning PES |

Every look uses a **different crop** of the Blue Marble / monthly MODIS field
(pipeline §4.1) — the "no two days stamped from the same noise" guarantee.
Rain/Storm groups clone retail's Rainy object list (rain sheets 0x01004C44/42
velocities, lightning Setups+PES windows, §1.3) with re-textured domes.
ACE cannot nudge selection (no sky/weather opcode — base doc dead-ends), but
because selection is a pure function of date, the ladder is globally
consistent and forecastable.

### 3.2 Per-group SkyObject stack (back-to-front, painter's order)
Draw order = array order (base doc). All domes: begin_time==end_time
(always-on), properties 0x2 (hide under fog), rim below horizon at z≈−400
like retail, radius ≈ 10 000 units.

| # | Object | Mesh (new GfxObj) | Texture | tex_velocity | SkyObjReplace keyframes |
|---|---|---|---|---|---|
| 0 | Star shell | dome, apex z≈1560, 32×8 segs | 2048² DXT5 star plate (Yale BSC + faint Milky Way band) | 0 | transparent: 100 % by day → 0 at night (retail already fades 0x010015EF this way) |
| 1 | Sun glow backplate | retail 0x010015EE pattern reused | soft scatter bloom | 0 | rotate tracks sun keyframes (retail does this) |
| 2 | Moons ×2 | retail billboards 0x01001F67/6A, re-textured | 1024² albarel/rezarel discs | 0 | retail time/arc windows kept |
| 3 | Sun disc | retail 0x01001348, re-textured | limb-darkened disc + glow | 0 | retail arc −23°..203°, t 0.16–0.94 |
| 4 | HIGH cirrus dome | apex z≈1300, shallow curvature | per-look 1024² DXT5, from NASA **B channel** | (0.0015, 0.0005) | dawn/dusk warm-variant gfxObjId swap (§3.4) |
| 5 | MID alto dome | apex z≈950 | per-look 1024² DXT5, NASA **G channel** | (−0.004, 0.006) | same |
| 6 | LOW cumulus dome (hero) | apex z≈650, strongest curvature | per-look 2048² DXT5, NASA **R channel**, Beer-powder shaded | (−0.013, 0.013) retail rate; storm ×1.6 | same + storm darkening via luminosity/maxBright |
| 7 | (storm only) Cb band | low dome variant with tall silhouettes baked in | NASA **A channel** cores, dense-base shading (cloud_storm_look.js profile) | (0.02, 0.02) | — |
| 8+ | (rain/storm) rain sheets + lightning | retail 0x01004C42/44 + Setups/PES verbatim | retail | retail | retail windows |

Differential scroll rates (slow cirrus → fast low deck) are the pseudo-depth
cue; real inter-layer parallax is out of scope for data-only (base doc).
Fill-rate: ~4 translucent dome layers ≈ retail Rainy's existing overdraw
budget (19 objects) — no new perf class, but confirm on the 1070 (§5).

### 3.3 Atmosphere palette — Bruneton → SkyTimeOfDay
Per look-class, author ~12 SkyTimeOfDay keyframes (retail Sunny uses 11) at
the retail begin values (0, 0.02, 0.16, 0.21, 0.27, 0.61, 0.84, 0.9, 0.96,
0.999 + 2 added around dawn/dusk for tighter color ramps). For each keyframe:
sample the takram Bruneton output (the `.exr` LUTs via a small offline
three.js/headless-holtburger scene, §4.2) at the corresponding sun elevation
(retail sun arc maps time→elevation linearly across t 0.16–0.94, §1.3) and
write:
- `dirColor/dirBright` = sun transmittance color at elevation;
- `ambColor/ambBright` = zenith irradiance;
- `worldFogColor` = horizon in-scatter color; `min/maxWorldFog` = aerial
  perspective distances (clear: 150/2400 like retail noon; storm: 40/600) —
  this is the DistanceFog lever from the base doc.
Overcast/storm classes get their own (grayer, dimmer) sampled sets. The
retail baseline for regression diffing comes from `region-day-night-curve` /
`region-skybox-snapshot` (JsonCommandProcessor.cs:5659).

### 3.4 Cloud textures — NASA coverage → shaded plates → dome UVs
Per look, per layer:
1. **Coverage**: crop the chosen NASA field region, per-étage channel split
   (rewritten `make_weather.py`, §2) → a 512–1024² coverage mask per layer.
2. **Shading**: offline takram render (§4.2) — the real volumetric renderer
   lights that coverage from below at three sun states (noon, low-warm,
   night-faint) → RGBA plates with per-pixel alpha = coverage, RGB =
   lit cloud (Beer-powder base darkening, silver linings). This is what makes
   the flat billboard READ volumetric — the volume is baked into the pixels
   (exactly the make_sky_v2.py mockup technique, upgraded from procedural
   noise to the real renderer + real NASA shapes).
3. **Projection**: map the plate to dome UVs azimuthal-equidistant about the
   zenith (no pinching at apex, matches how the dome mesh's `vt` are
   generated) and feather alpha→0 at the rim so the dome edge never shows.
4. **Day/dawn variants**: two baked lighting variants per layer texture
   (noon-neutral, dawn/dusk-warm). The SkyTimeOfDay `skyObjReplace.gfxObjId`
   swap flips each dome to its warm-variant GfxObj (same mesh, different
   Surface) for the t≈0.16–0.27 and 0.84–0.96 windows. **Swap is a pop
   (UNVERIFIED crossfade, §1.3) — swaps sit at keyframes where luminosity is
   simultaneously ramping, masking the cut.** If eye-test shows popping,
   fall back to one neutral texture + luminosity/maxBright tint only.

Budget: 12 looks × (2048² low + 1024² mid + 1024² cirrus) × 2 variants,
DXT5 ≈ 12 × 6 MB × 2 ≈ **144 MB** worst case; sharing cirrus plates across
looks in a class and dropping variants for overcast (no warm pass under
cloud) lands ~**80–100 MB portal.dat growth**. All records ≤ 4 MB (fast
write path, §1.4).

### 3.5 Stars, sun, moon
- Star plate: render Yale BSC 9 096 stars (takram stars.bin) + a faint
  galactic band to a 2048² plate (magnitude → point size/intensity),
  azimuthal projection, import over/alongside 0x0800004D's chain. The shell
  keeps retail's world-anchored frame — stars stay put when you turn.
- Moons: bake `albarel.png`/`rezarel.png` (1024²) into the two retail moon
  billboards' RenderSurfaces (allowResize from their retail dims).
- Sun: limb-darkened disc + transmittance-tinted glow texture for 0x01001348;
  keep the retail arc so `begin/end_angle` still sweeps it east→west.

---
## 4. Build pipeline (exact steps)

1. **Weather maps** (laptop, python/Pillow): rewrite `make_weather.py`
   (crop NASA Blue Marble cloud_combined / monthly MODIS cloud-fraction →
   per-étage RGBA channel split, thresholds per look class). Output:
   `weather_<look>.png` ×12. Source imagery download is the only network
   step; pin URLs + sha256 in the script (bake-source.sha256 discipline).
2. **Shaded plates** (buildbox T4 — real GPU): headless-holtburger scene
   (serve.py + `?nullRender=0` capture, or a standalone three.js script using
   `vendor/takram-three-clouds` + the `.exr` LUTs + `shape*.bin`): load each
   weather map, camera at ground looking up, orthographic-ish per-layer pass,
   render each layer in isolation at 3 sun states → `plate_<look>_<layer>_<light>.png`.
   Then azimuthal-remap + rim-feather (python).
3. **Palette table** (same scene): sample Bruneton at the keyframe sun
   elevations → `skytime_<class>.json` (dir/amb/fog rows).
4. **Dome meshes** (laptop, python): generate 4 dome .obj (star/cirrus/mid/low,
   32×8 segments, radii/apexes §3.2, azimuthal `vt`). Smoke-test
   `obj-import` UV carriage on a dat copy FIRST (§1.4 VERIFY).
5. **Land it in a WBT project** (never `~/ac_base_dats` — copies only):
   - `obj-import` each dome (`gfxObjOnly:true`, explicit `gfxObjId` in a
     free 0x01 range, `surfaceDid` = new Surfaces);
   - `render-surface-import` all plates (`allowCreate:true`, format DXT5) +
     `import-texture`/`surface-texture-collapse` to wire
     Surface(Base1Image+Alpha, translucency per layer)→SurfaceTexture→
     RenderSurface chains (mirror 0x080000D4's chain shape);
   - edit the exported region JSON (from `region-export-json`): 24 DayGroups
     per §3.1/3.2 tables + `skytime_<class>.json` gradients;
   - `region-import-json` (validate, then `apply:true`) → `export` → modified
     `client_portal.dat`; `region-diff` against retail for review.
6. **Verify**: `region-skybox-snapshot` at a grid of gameTimeSec values ×
   forced day indices (the hash is reproducible offline — precompute which
   date hits which group); pack-parity from region-import output.

## 5. Mandatory 1070 eye-test criteria (batched, off-screen, per §2 KEEP)
1. **Turn test**: sun/moon/star positions world-fixed while spinning the
   camera (UpdatePosition keeps orientation world-anchored — regression
   guard).
2. **Walk test**: no reachable horizon/dome edge; rim feather invisible at
   max fog distance.
3. **Day cycle**: full 2 h 07 m compressed pass (or server-time nudges):
   dawn→noon→dusk→night palette ramps smooth; gfxObj swap pops acceptable;
   star fade-in; moons on their arcs.
4. **Day-to-day**: step server date across ≥ 10 days → distinct looks appear
   with expected frequency (clear vs rain ratio ≈ ladder weights).
5. **Storm group**: rain sheets + lightning PES fire in their windows over
   the new Cb band; fps within retail-Rainy budget on the 1070 baseline.
6. Texture-size sanity on the res-4k-unlock path (2048 DXT5 loads on the
   GPU MaxTextureWidth check).

## 6. Honest quality ladder
**This data-only sky gets:** the takram day/night PALETTE (Bruneton-sampled
gradients + aerial-perspective fog), real NASA cloud SHAPES with baked
volumetric shading (silver linings, dark bases), three-band layered drift at
differential speeds, a real star catalog, canon hi-res moons, and genuinely
changing weather — 12 distinct skies rotating deterministically every in-game
day for every player. That is most of what a screenshot of holtburger's sky
shows (compare takram_sky_plate_v2.png — same technique).
**Missing vs holtburger, unfixable in data:** true volume (cloud edges don't
evolve — only scroll), self-shadowing that responds to sun angle beyond the
2 baked variants, ground cloud shadows, inter-layer parallax on movement, and
weather that transitions smoothly instead of cutting at day rollover.
**The optional DLL route adds:** a hooked GameSky::Draw drawing the same baked
assets as real domes at world radii → per-layer camera parallax, per-frame
sun-relative re-tint, smooth cross-day blends, and storm swaps on demand —
still baked (no shaders in-process), but with real depth. The out-of-process
companion (base doc route C) remains the only path to live volumetrics.

## 7. Open items / UNVERIFIED
- `obj-import` UV (`vt`) carriage into GfxObj — smoke-test before anything
  else (pipeline step 4).
- `skyObjReplace.gfxObjId` swap behavior (pop vs blend) and `transparent`
  value semantics (−1/0/100 observed) — eye-test on a dat copy.
- GameTime epoch sync between ACE and client (affects only whether all
  players share the same day index — retail behavior says yes).
- NASA monthly MODIS cloud-fraction availability at usable resolution for
  the seasonal-variant idea (nice-to-have; Blue Marble cloud_combined alone
  suffices for 12 distinct crops).
- Fill-rate of 4 stacked 2048² alpha domes on minimum-spec GPUs (retail
  Rainy already stacks ~5 translucent sky objects; measure, don't assume).
- Free 0x01/0x05/0x06/0x08 id ranges for the new records (asset-graph scan
  before allocation).

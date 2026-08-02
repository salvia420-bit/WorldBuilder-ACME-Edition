# Cloud storm look — WMO removal + queued 1070 eye-checks (2026-08-01)

## ⚡ LIVE 1070 SESSION FINDINGS (same day, owner-authorized agent session)

An owner-authorized live session on the 1070 (off-screen muted chrome, MODE2i)
validated and extended all of this. Screenshots taildropped to the redmi;
driver scripts in the session scratchpad (`boot/ev/evfile/snap/console.mjs`
+ `paint2.js` — CDP :9333 + playwright-core pattern).

**Validated live:**
- The storm↔fair edge-trigger WORKS in the wild: booted during a REAL server
  storm DayGroup (`is_storm=true`, coverage 0.7 self-applied), and
  `__setWeather({is_storm:false})` restored the fair look (0.5, alto deck) in
  one frame. Fair look = genuinely good cumulus field.
- Custom `localWeatherTexture` authoring works END-TO-END. The working upload
  path is `createImageBitmap(new ImageData(data,512,512), {premultiplyAlpha:
  'none'})` assigned to the EXISTING texture (`tex.image = bmp; tex.flipY=false;
  tex.needsUpdate=true`). ⚠ A 2D canvas CANNOT carry weather RGBA — canvases
  premultiply, so R/G/B are crushed wherever A≈0 (independent channels ≠
  canvas semantics). Duck-typed DataTexture (isDataTexture=true on a plain
  Texture) also failed (sampled black).
- Weather-texture mapping: cube-sphere UV (clouds.glsl getGlobeUv), repeat
  100 → ~100 km/tile, ~195 m/texel at 512². Sampled V is FLIPPED vs data row
  (paint at `row = 512 - v*512`). A solid-A diagnostic renders a spectacular
  dark ragged Cb underside — the tower layer reads dramatically when its
  channel coverage is broad; SPARSE sharp-cfw cells wash out with distance
  (mip pulls samples under the coverage threshold) — use broad patches (tens
  of km) for storm masses, not small cells.
- `coverageFilterWidth` floods empty-weather sky: `mix(localWeather, 1, cfw)`
  lifts zero-weather samples above threshold at cfw ≥ ~0.5. Discrete forms
  need cfw ≲ 0.2 on that layer.

**Bugs found live (not yet fixed):**
1. **Portal-space tunnel rig stuck visible after `@telepoi`** — giant blue
   UV-scroll rings wrapping the whole sky long after arrival at a9b40019
   (cleared by itself much later / on state change). `portalSpaceRig` in the
   main scene. Reproduce: telepoi, look up.
2. **`THREE.WebGLTextures: Trying to use 16 texture units while this GPU
   supports only 16`** — spamming EVERY frame on the 1070 at default flags.
   NOT the clouds material (it binds 11). Suspect terrain ShaderMaterial
   (CSM + detail + POM + cloud-shadow map). Some material is silently
   sampling a wrong texture unit — possible relation to past artifact
   reports. Needs a program-by-program sampler audit.
3. **Free camera above ~700 m breaks the cloud raymarch** — sky empties
   (clouds only at extreme horizon). cameraHeight patch reads the active
   camera correctly, so it's the fake-ECEF / in-layer branch (clouds.frag
   :745-795) interplay. Follow-cam players can't hit it today; matters for
   any future fly-cam or tall-vista work.

**Camera control (for future sessions):** `cameraSwitcher.followPitch` is
POSITIVE=look-down, NEGATIVE=look-up, clamp [-0.5, 1.4]; `followYaw` 0=north,
+π/2=east. TRUE free-cam: set `cameraSwitcher.mode = 'free'` (any unknown
string) — positionCamera has no else-branch, so `persp` position/lookAt are
yours; restore with `mode='follow'`. `setSkyTimeOverride(0.5)` pins noon.

Same-day context: the `&rain/&snow/&lightning` precip systems (`scene3d/weather/`)
were deleted this session, and the WMO weather→cloud-layer machinery
(`cloud_volume._applyWeatherToCloudLayers`: Espy LCL, étage bands, fractus/
humidity branches) followed it — that config was why `?cloudWeather=on` broke
the sky while `=off` looked right (two writers: cloud_overlay's tuned baseline
vs the WMO clobber).

New shape (all landed, `node test_cloud_storm_look.mjs` 29/29):
- `scene3d/cloud_storm_look.js` — the ONE layer writer. Two hand-tuned states:
  FAIR (takram DEFAULT cumulus/cirrus + the alto deck on channel A, coverage
  0.5 — i.e. the previously-good `cloudWeather=off` look) and STORM (cumulus
  deck 600/850 m, channel A → Cb tower 600 m→9.4 km, density at the 0.05
  soft-alpha ceiling, `shadow:true`, coverage 0.7, haze 3e-5→3e-4).
- Switch signal = the REAL DayGroup SkyObject storm scan (`is_storm`), edge-
  triggered in `cloud_volume.tick`. `?cloudWeather=off` freezes FAIR.
- `weather_state.js` kept (VFX weather inputs + storm flag path). Its
  lcl_m/etage_m/latitude outputs now have NO consumers — candidate for a
  later slim-down, not urgent.

## Queued eye-checks (owner 1070 batch — agent must NOT run these)

1. **Bare default fair look** — default URL + `?nosw=1`, spawn outdoors,
   daylight. Expect: the sky that previously required `?cloudWeather=off`
   (cumulus + thin cirrus + faint alto deck, coverage 0.5), 0 console errors.
   `window.__getWeather().is_storm` should read `false` on a clear DayGroup.
2. **Storm look morph** — console: `__setWeather({is_storm:true})`. Expect
   within a frame: overcast thickens (coverage 0.7), a towering Cb mass,
   terrain visibly darkens under it (Cb now casts shadow — new), ground haze
   denser. Then `__clearWeatherOverride('is_storm')` → full restore to (1).
   Watch for: opaque slab / hard edges (would mean the 0.05×8800 optical
   depth is still too much — tune `STORM_LAYERS[3].densityScale` down).
3. **Freeze escape** — `?cloudWeather=off&nosw=1` + the same `__setWeather`
   storm force: layers must NOT change.
4. **Natural storm** — if a storm DayGroup rotates in while logged in, confirm
   the morph fires without console intervention (edge detector on the W4 scan).

## Reference survey (2026-08-01, after the live session)

Owner asked for existing weather maps to reference instead of hand-authoring.
Findings:
- **NASA Blue Marble cloud coverage** (public domain, the source Skybolt's
  planetwide clouds use for their global coverage map) — real frontal
  systems, cyclone commas, cell clusters. **ADOPTED:** cropped the North
  Pacific storm track band, made tileable (roll-crossfade), split into our
  channel semantics → `assets/clouds/local_weather_nasa.png` behind strict
  opt-in `?wxMap=nasa` (fail-open to takram default; prebaked .bins +
  atmosphere EXRs untouched → cold load unaffected). Builder script:
  session scratchpad `make_weather.py` (re-run to retune thresholds/crop).
- **takram's own `Clouds-CustomLayers` story** — their authored alternative
  layers. Two useful recipes we don't use yet: a **custom `densityProfile`**
  (their A-layer ground fog: expTerm 1, exponent 1e-3, linear/constant 0 —
  height-shaped density falloff; our Cb could use a profile for a dense base
  + wispy anvil) and cumulus with `weatherExponent 0.6` + `shapeAmount 0.8`.
- **Skybolt architecture** (prograda.com blog): global 8k coverage (5 km/px)
  × tiling Worley detail modulation × Perlin cloud-type map, blended with a
  mean-preserving erosion remap. Their assets repo is MPL-2.0 + DVC-hosted
  (not trivially fetchable); the NASA source above is the same data anyway.
- **Nubis/Schneider convention** (Horizon/Decima, and most Unity/Godot demos):
  weather map channels = coverage / precipitation / cloud-type. Our
  per-layer-channel scheme is takram's own, so their textures don't drop in
  directly — but their *authoring* insight holds: storm cells are broad
  painted regions in a type/coverage channel, not point blobs.

## ⚡ LIVE SESSION 2 (same day): Cb/TCu PROVEN with ?wxMap=nasa

Owner asked for in-game proof of Cb/TCu. Achieved — shots on the redmi
(`pano-east.png` = the hero: a genuine towering cumulonimbus column;
`nasa-cb-final` / `nasa-tcu-final` = tall vs squat variants from the same
vantage; `nasa-cb-wall-v2` = the scattered-cumulus field the NASA map gives).

**Constants LANDED into cloud_storm_look.js from this session (31/31 tests):**
- STORM_COVERAGE 0.7 → **0.62** — at 0.7 the R/G cfw-0.6 flood lifts
  zero-weather sky to ~50% density (formless gray veil, the storm look's
  actual failure mode). Derivation in the constant's comment.
- Cb layer: height 8800 → **6000**, coverageFilterWidth 0.7 → **0.2**,
  **densityProfile inverted** (const 1.0, linear −0.55; takram's default
  0.75·h+0.25 is top-heavy → anvil-smear with no base). applyCloudLook now
  writes/resets densityProfile terms.

**Authoring techniques discovered (use these next time):**
- **Offset-drag scouting**: `effect.localWeatherOffset.set(du,dv)` drags the
  weather map over the world — park any texture region over the camera
  without flying. To sample texel T at your position: off = (T − t0)/512
  where t0 = fract(globeUv·100)·512.
- **Mapping calibrated (Holtburg)**: sampled data row = 512 − v_texel;
  Jacobian +1 km east = −5.69 texel-u, +1 km north = −5.69 texel-v
  (~176 m/texel at repeat 100).
- **Clouds vanish when the camera leaves the near-origin region** (~50 km+):
  flat-world drift up the ECEF sphere adds implied altitude (~500 m at
  80 km) and crosses the same break as the >700 m bug. Stay low and near
  the play area for shots; distant vistas also drown in aerial haze past
  ~10 km anyway — 8 km at ~200–300 m alt was the sweet spot.
- The two bright "clouds" that follow the camera are the MOONS (ac_moons
  billboards) — don't chase them (again).

## ⚡ LIVE SESSION 3 (same day): the ~2 s cloud "video loop" ROOT-CAUSED + FIXED

Owner hit the long-standing cloud cycling on the cloudflared check-out link.
Diagnosis on the 1070 (quality=high, same as owner's session):
- The 2026-07-12 stbn.bin fix IS deployed and loading (verified in-page:
  128×128×64, NearestFilter) — the asset was never the remaining problem.
- Root cause: `cloudsResolve.frag` variance clipping at takram's default
  `varianceGamma=2` clips history so hard against each frame's noisy
  raymarch neighborhood that temporal accumulation cannot converge; the
  deterministic `frame % 64` STBN slice cycle (64/~30 fps ≈ 2.1 s — the
  owner's "2 second loop") shows through regardless of noise quality.
- Fix (landed, cloud_volume.js constructor): varianceGamma 2 → **4**,
  `?cloudVarGamma=N` override. Measured (burst screenshots, mean
  interframe |Δ| over the sky band, static camera): γ2 = 2.02 with a
  strong stroboscopic wave (max 3.18); γ4 = **1.01 dead flat** (max
  1.12); γ8 = 1.11; γ8+α0.05 = 1.44 (worse — keep temporalAlpha 0.1).
  Snap-turn ghost probe: γ4 settle profile == γ2's (no smear penalty).
- Method note for future temporal bugs: `burst.mjs` + `cycle_metric.py`
  (session scratchpad) — timed screenshot bursts + interframe-diff series
  quantify flicker/cycling without eyes.
- **PART 2 (owner: "still happening")** — the clouds-resolve fix alone was
  insufficient because the **ShadowPass has its OWN temporal resolve** with
  even tighter defaults (γ=1, α=0.01): the terrain's cloud-shadow term
  pulsed on the same 64-frame cycle (ground "breathes"), which reads as
  cloud cycling when looking at the world. Fixed in the same
  cloud_volume.js block: shadow resolve γ→4 (same `?cloudVarGamma`), α
  0.01→0.05. Measured (terrain band 55–85%, ground-level Holtburg view):
  old defaults = sustained flat ~2.2 interframe churn that never decays;
  fixed = decays to ~0.85–1.2 (residual = NPCs/town motion). Sky band
  unaffected by the shadow knobs (control held at ~0.96).

## ⚡ SESSION 4 (same day): drift + biome-anchored `wxMap=dereth`

Owner: "the pattern shouldn't be frozen in place… chase the opportunity,
you have the terrain codes." Landed (no live testing — owner tests on the
cloudflared link):
- **Drift** (`?cloudDrift`, default ON): linear ~25 km/h for non-anchored
  maps; for the biome map a ±3 km Lissajous wobble instead — **linear
  drift and geographic anchoring are incompatible** (a translating offset
  slides the desert-clear zone onto the grasslands). Wobble is small vs
  the ~10 km biome blur, so geography holds while any given town's sky
  keeps changing (7/11-min periods + the storm cycle on top).
- **`wxMap=dereth`**: dumped `get-terrain-layers` for ALL 65,025 LBs via
  WB.Terminal (RetailSmoke project; `terrain_dump.jsonl`), classified
  terrain names → weather weights (SandYellow/Grey=clear, Marsh/Reedgrass
  =deck+storm, ObsidianPlain=storm cores, Snow/Ice=overcast veil, grass
  family=cumulus, water=maritime), splatted through the SAME cube-sphere
  texel transform the shader samples (1 LB ≈ 1.09 texels — the map is
  proportionate by construction), blurred ~2 km, and multiplied onto the
  NASA organic structure. Assets: `local_weather_dereth.png` (255 KB) +
  previews (`dereth-biome-preview.png` on the redmi — display is rotated
  vs a compass map, but splat/sample share one transform so in-game
  alignment is exact by construction; the one empirical anchor, the
  flipY row inversion, was proven live in session 2's bisect).
- **Teleport/portal semantics** (owner Q): no purge, ever — the sky is a
  pure function of camera position; telepoi/portals instantly show the
  destination's regional weather. `is_storm` remains GLOBAL (DayGroup) —
  regional storms would need a position-keyed storm signal (future).
- Terrain-name coverage check: any terrain name missing from the
  classifier defaults to plain cumulus — re-run the builder after
  worldgen terrain changes.

## Not implemented (needs owner decisions / eye-tests first)

- **Cloud-pattern variety**: the visible repetition is takram's 512² tiling
  `LocalWeather` texture with `localWeatherRepeat=100` and NO drift — we never
  set `effect.localWeatherVelocity` (pattern drift) or `shapeVelocity` (shape
  churn). Cheap, high-payoff knobs; need speed tuning by eye.
- **takram has NO precip/lightning** — clouds, cloud shadows, haze, light
  shafts only. If rain/snow/lightning return, revive the deleted
  `scene3d/weather/` systems from git history and drive them off the same
  `is_storm` edge this module uses.
- **Storm-onset smoothing** — the look currently STEPS on the storm edge.
  A coverage/altitude lerp over ~10 s would sell it; do after look sign-off.

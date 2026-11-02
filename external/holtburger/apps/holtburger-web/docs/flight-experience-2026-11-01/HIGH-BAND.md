# High band — above the clouds (flight experience Phase 4, 2026-11-01)

**Status: built.**
- Client: under `?flightView` (DEFAULT ON since 2026-11-01, `=off` escapes), which bundles the world tier, the far
  forests and the presence field.
- Clouds: `?cloudTrueHeight`, `?cloudHighBand` and `?cloudHighBandMarch` (2026-11-02), all default ON.
- Server: four ACE properties, all default 0 (off). They are set live on the laptop's server for testing:
  - `vehicle_ceiling_agl 5000`
  - `vehicle_climb_max 40`
  - `vehicle_derelict_high_agl 600`
  - `vehicle_high_band_agl 600`

  Revert any of them with `modifydouble <name> 0`.

Measured on the 1070: arm G (§ Measured below). Run log: `HANDOFF.md`.

WORKFLOW §5 Phase 4 asked eight questions. One section per question follows.

## 1. World-scale terrain

**Answer: a CDLOD world tier over baked whole-map grids** (`scene3d/world_terrain.js`, `?worldTier`, implied by
`?flightView`).

- **Data**: `crates/holtburger-dat/examples/bake_world_terrain.rs` reads the base DATs only (bake-base-dats-only) and
  writes the following files to `dist/world/` (8.1 MB):
  - `world_height.u8`: the 2041 × 2041 vertex grid of the whole map, as indices into the land-height table;
  - `world_types.u8`: terrain code, plus the road bit, plus a no-record bit;
  - `world_meta.json`: the height table;
  - `world_trees.u8`: 255², tall-tree count per landblock, from the far-forest census.

  The bake runs in 7 s: 65,025 landblocks, 0 missing, maximum 670 m. `bake-source.sha256` records the DATs it read.
- **Geometry**: one instanced draw of a 33 × 33 grid patch per selected node.
  - Leaf 768 m, 9 levels.
  - Root 196,608 m, centred so the ocean runs 74 km past every map edge. Off-map heights are sea level and off-map
    types are water, so the sea reaches the horizon.
  - Nodes refine on 3D distance (`R(level) = 1536 m × 2^level`), with a geomorph over the outer 25 % of each range,
    so levels meet crack-free.
  - Frustum-culled per node on the CPU. 40–120 nodes per frame.
- **Shading**: the same shading as the near ring.
  - Same texture atlas (`sampler2DArray`, per-code tiling).
  - 4-corner type blend; roads as lines (`smoothstep(0.12, 0.45)`).
  - Water: a Fresnel sky sheen plus a tight sun glint.
  - Forests: a canopy tint from `world_trees` (at this scale density is the signal, not instances).
  - The SHARED lighting and fog tail (`TERRAIN_SHARED_TAIL_GLSL`), so the three tiers light identically.
- **Hand-off** (revised 2026-11-02, `?lbBand`): the presence field (`lb_presence.js`, a 64 × 64-landblock RG8
  texture; G = near terrain drawn) decides where the tier discards. One shared rule (`LB_HANDOFF_GLSL`, the far ring
  uses it too): discard under a near-drawn landblock, except a 10 m band along an edge whose neighbour the near ring
  does NOT draw (its outer edge, a leading-edge hole, a parked tile), so the seam can never crack.
  - The first version kept that band along EVERY edge. The near ring draws 1 cm below grade (retail
    zFightTerrainAdjust) and the tiers' reversed-Z push is relative (mm at 100 m), so the band won the depth test: a
    19 m strip of flat, shadow-less ground centred on every landblock edge — the owner's "green lines in square
    shape on terrain" (on foot and in the whole low band). Between two near-drawn landblocks the near ring is
    watertight by itself, so no band belongs there. `?lbBand=all` reproduces the old rule, `none` drops the band.
  - Known: the tier still draws under the far ring's patches (there is no far-ring channel) and its alternating cell
    diagonal stands up to 1–11 m above the retail surface in ~8 % of the cells (retail picks the diagonal per cell),
    so it can poke through the far ring there. Under the far forest's canopy it did not show in the stills.
- **Program link off the frame**: three's `compileAsync` (KHR_parallel_shader_compile), with the mesh hidden until
  the link completes. A first-draw link is 0.5–1.7 s of FXC on the 1070.
- **The object window narrows with altitude** (`objRadiusForAgl`): page default below 600 m, 3 to 1.5 km, 2 to
  2.5 km, 1 above, with hysteresis. Arm G at 5 km with radius 2 still baked ~45 statics / buildings landblocks per 3 s
  for objects a few pixels across. The far forests carry the trees past the window on the presence complement.
- **The far ring above 700 m AGL** is hidden (released below 550 m). From altitude its 3 km square read as a pasted
  seam, and the world tier owns that area at that height.

## 2. Camera and depth

- **Far plane** = `quantizedFar(D)`.
  - `D = min(240 km, 8 km + 12 × AGL)`: 9 km at 80 m, 62 km at 4.5 km, 68 km at 5 km.
  - `quantizedFar(D)` is ≥ 1.25 D, in ×1.5 steps from 5 km, at most 250 km.
  - Raised at once, lowered after 3 s. Anything keyed on `camera.far` changes a handful of times per climb, not per
    frame.
- **Reversed-Z** with a float depth buffer is already on, so depth precision at 250 km is fine. The world tier adds a
  2.5e-6 push so the near rings win ties.
- **The log buffer fallback** (no EXT_clip_control, or `?reversedZ=off`): the world tier and the far-forest cards
  carry three's log-depth chunks (`withLogDepth`, shader_logdepth.js; the gate's L4 audit requires it). The world tier
  also has a `gl_FragDepth` twin of its push. Under reversed-Z both compile out, so the validated program is
  unchanged.
- **Consumers of near/far** (audited; `rg -n 'camera\.far|cameraFar' scene3d`):
  - **The cloud-shadow cascades**: takram `CascadedShadowMaps` with `maxFar` null follows `camera.far`.
    `cloud_overlay.js` pins `maxFar` to 5 km whenever far > 5 km, because cascades over 250 km would smear the
    shadows to nothing.
  - **The pmndrs effects and our VFX**: they read `camera.far` per frame (`setCameraFar` hooks: fx_distort,
    heat_haze; particle/decal/fx_fields read it per call), or use pmndrs' own `cameraNear`/`cameraFar` uniforms,
    which the EffectPass maintains.
  - **The horizon dissolve**: default OFF since 2026-08-02. It was dead past 833 m anyway, so it does not fight the
    world tier.
  - **The near-ring CSM**: its own split distances, not the camera far.

## 3. Fog and atmosphere

- **Range fog** (retail `SkyDesc::GetWorldFog`, in the shared terrain tail and on statics and models) would white out
  everything from altitude. While flying, `loop.js` blends today's band toward `near 0.35 D / far D` by the policy
  weight `w`.
  - `w` opens over 2.5 s, and only once the world tier has drawn 6 frames. The fog never opens onto the far ring's
    edge.
  - On foot `w` is 0 and nothing changes.
- **Layered haze** (`layered_haze.js`) is scaled by `1 − smoothstep(300 m, 1500 m, AGL)`. It reads every pixel past
  1.4 km as distance and would wash the far field flat.
- **takram's aerial perspective** reads depth and models altitude. It carries the physical haze to the horizon, so the
  continent recedes into blue from 5 km up without any authored ramp.

## 4. Clouds

- **The bug that blocked the whole band** (latent; not the flight work): clouds vanished once the camera climbed into
  the 750–2,200 m deck.
  - Cause: takram's `CloudsPass.update` → `copyCameraSettings` recomputes the camera height from a WGS-84 ellipsoid
    immediately before the march. In our frame that is AC z − 18 km, so the march always took the "below the clouds"
    branch.
  - Fix: `cloud_volume.js` wraps `copyCameraSettings`. Once the radial altitude (`AC z + d²/2R`, 177 m extra over
    Holtburg) is within 150 m of the layer bottom, it writes the true height (and zeroes the haze density that
    negative height always zeroed).
  - Flag: `?cloudTrueHeight`, default ON. On-foot frames keep takram's value.
- **The camera height** blends to the radial altitude by `w` (`__hbCloudRadialW`). The march geometry and the
  camera agree while climbing through a layer.
- **Storms flown through and from above, revised later the same night** (`cloud_storm_look.js lookLayers`). A 1070 A/B
  on a forced storm (`bench/cloud-ab-1070.mjs`) found the vertical streaks and the in-deck murk come from the
  cumulonimbus layer itself (not the light shafts, the march step or the shape detail). So above 900 m AGL (back
  below 700 m) the tower FADES OUT (density × 0.02) and the deck's tops round off (r / g shapeAlteringBias 0.7): you
  fly among the storm's cumulus deck and see it from above as separate rounded clouds with gaps onto the ground. The
  list below records the first version (height only), superseded.
- **Storms from above, first version** (`cloud_storm_look.js lookLayers`):
  - The storm look's cumulonimbus layer reaches 6.6 km (altitude 600 m + height 6,000 m). That is inside the cruise
    band, and from 4.8 km it read as streaky walls.
  - Above 1.8 km AGL (back below 1.4 km) a high-band blend eases over 10 s. It brings the tower layer's height down
    to 1,900 m (tops at 2.5 km), so the storm reads as a deck below the aircraft.
  - The look re-applies per 1 % step. Ground players never see it (blend 0 = the shipped table).
- **Shadows on the far terrain**: the world tier uses the shared tail, so it receives the same cloud-shadow term
  inside the 5 km cascade range. Past that, the aerial perspective dominates.
- **Cloud tops from above** (`?cloudHighBand`, default ON):
  - takram's temporal upscale refreshes one pixel per 4 × 4 block per frame and keeps the rest from history. From
    above, the tops showed salt-and-pepper speckle that never averaged out, even with a still camera for 24 s.
  - A looser history clip (γ 12) did not help. The upscale off did.
  - Above ~1.8 km AGL (the high-band blend > 0.65, back below 0.35) the clouds now march every pixel at half
    resolution: 4 × the march texels of the upscale. The 1070 held 27–28 fps at 5 km under its 30 fps cap.
  - The switch flips the resolve material's `TEMPORAL_UPSCALE` define. Its other variant is linked off the frame
    first (`compileAsync`), and the switch waits for it.
- **Vertical streaks: fixed in flight** (see the revised storm item above). From the ground the storm look is
  unchanged: its towers are what a player on foot should see.
  - Still seen 2026-11-02 at 5 km over the storm deck, in places (the desert edge, heading west): regular vertical
    "curtains" on the flanks of cumulus masses next to gaps. They are in the r / g deck itself (the base arm shows
    them), not the tower. Open.
- **The fair look from the air** (2026-11-02, `cloud_storm_look.js lookLayers`, the same `highBand` blend): fair
  weather's alto deck (3.5 km, 600 m, density 0.004) is a faint high veil from below, but from 4–5 km its path at
  grazing angles is kilometres long, so it covered the cumulus deck and the ground with one grey-lavender sheet.
  While the aircraft is up the alto deck thins (density × 0.1; × 0.25 still read as haze) and the cumulus tops round
  off as the storm deck's do (shapeAlteringBias 0.7). From above you now see the fair cumulus field with gaps onto
  the ground. Frame rate unchanged. Ground players never see it.
- **The high band's march, cheaper** (`?cloudHighBandMarch`, default ON, 2026-11-02). A live A/B mid-flight at 5 km
  (`bench/fps-ab-1070.mjs` run in-process by `flight-1070.mjs --ab`; vsync on, the 1070's 120 Hz screen; paired
  screenshots 0.7 s apart):

  | 5 km AGL | storm | fair |
  |---|---|---|
  | the every-pixel march as built | 39 fps | 33.5 fps |
  | light shafts off (the define, for reference) | 65 | 48 |
  | no ground-bounce samples | 46 | — |
  | **shipped: shafts × 0 (uniform) + no ground bounce** | **52–53** | **43–45** |
  | shipped, with the shafts back on | 44.7 | 42.7 |

  - The light shafts (the aerial perspective in cloud shadow, marched per pixel in 50 m steps growing × 1.01: ~160
    steps over the 20 km of a ray from 5 km) were the largest single cost, and the paired shots are
    indistinguishable from above. They go off through the same uniform `?cloudNight` already scales at night
    (`maxShadowLengthRayDistance` × 0: the march exits on its first step). One writer, no `SHADOW_LENGTH` define
    flip (that would relink the clouds program), the base restored on the way down.
  - The ground-bounce samples (`maxIterationCountToGround` 3 → 0) light the deck's undersides, which are out of view
    from above.
  - Rejected: a 400 m shaft step (45 fps), resolution 0.45 (58 fps with both, visibly grainier), fewer primary
    iterations or earlier termination (no change: the march ends before them).
  - The define-off arm is ~12 fps faster than the uniform: its shadow-length resolve passes stop too. Doing that
    would need the clouds program's other variant linked off the frame first, as the resolve's `TEMPORAL_UPSCALE`
    variant is.

## 5. Server (ACE fork, `~/ace-server`, branch `vehicles-2026-11-01`)

All four properties default to 0 (off), so the vanilla vehicles fork behaves as before.

| Property | What | Why |
|---|---|---|
| `vehicle_ceiling_agl` | flight ceiling (m AGL) for vehicles spawned from now on; 0 = the profile's own (Hellcat 450) | The ceiling was `VehicleProfile.CeilingAgl`. The profile travels in `VehicleProfileMsg`, so the capable client's predictor uses the same number (no client change). |
| `vehicle_climb_max` | climb rate cap (m/s), spawn-time; 0 = profile (20) | 40 m/s: ~2.1 min from the ground to 5 km at boost (pitch 25° at 111 m/s would give 47). Sink stays 25 m/s. |
| `vehicle_derelict_high_agl` | an empty vehicle above this AGL despawns 30 s after it went derelict | A derelict glides at idle with the nose 12.5° down (~6.5 m/s sink). From 5 km that is ~13 min and ~25 km of landblock loads (a 3 × 3 at every crossing) for nobody. 30 s later it is a dot. |
| `vehicle_high_band_agl` | above this AGL the pilot sees by 3D distance and `CheckMonsters` is skipped | ACE's first-sight test (`ObjectMaint.AddVisibleObject`) is 2D, so a pilot 5 km up was still sent every NPC and monster within 112.5 m (and landmarks within 350 m) of the point below: CreateObjects and client entities for things a few pixels across. In 3D, another aircraft alongside is still in sight. Nothing on the ground can reach a pilot 600 m up. |

Also, unconditionally: **the world edge**. `FlightModel.WorldMax` and the client's `flight_model.js` / `fall_model.js`
`WORLD_MAX` were 256 × 192 − 0.5, which is inside landblock 0xFF. That landblock does not exist: the map is 255
landblocks a side, and `VehicleStreaming`'s corridor already skips x/y > 254. They are now 255 × 192 − 0.5. From 5 km
the edge is in plain view, 4 minutes away at boost.

**What could not be made free, and why**: ACE's `LandblockManager.RelocateObjectForPhysics` always loads the 3 × 3
around a relocated player (`GetLandblock(id, true)`). The pilot's body and the vehicle object must live in a loaded
landblock, so a pilot crossing landblocks still loads 3 per crossing at any altitude. `vehicle_preload` keeps those
loads off the world thread, so skipping the corridor preload in the high band would only move the loads back onto it.
"Nearly free" needs an ACE-core change: a relocation without adjacents for a pilot above the band. It is not done;
the next step is to measure it with `@vehicles` costs. The other half of the question, the sight radius that "stops
admitting ground objects", is done: see `vehicle_high_band_agl` above.

Patches: see the README in `../vehicles-2026-11-01/ace/` (the high-band change is uncommitted in `~/ace-server` until
the owner says commit; `0004-*.diff` there is the working-tree diff).

## 6. Speed at altitude

**Decision: no vMax growth with altitude** (400 km/h boost stays the top speed).
- At 5 km the ground moves at a sixth of the angular rate it does at 80 m, so 400 km/h already feels slow up there.
- But the world is 49 km across: at 400 km/h the edge is under 4 minutes from the centre, and a faster aircraft only
  reaches the ocean sooner.
- Streaming is not the limit (the world tier needs no streaming). The server's speed cap (`vehicle_speed_cap`) and
  the predictor's golden trajectories are the constraint, and both stay as they are.

Revisit if the owner wants long-haul flights across the map: a speed-with-altitude term belongs in the flight model,
which means the golden trajectories and the parity tests change.

## 7. Retail clients

By analysis; no retail client was run this session.
- The stand-in (the Drudge Balloon setup at 0.3 scale) is an ordinary object at a high z in the outdoor cell under
  it. ACE sends it to retail observers that know it by landblock visibility.
- Retail draws it only inside its own degrade distance, so 4 km up it is simply not drawn. Nothing in retail
  physics acts on a server-placed object's z.
- The retail chat line ("A Hellcat roars overhead") uses a 3D distance of 250 m, so it never fires for a high
  aircraft. That is consistent: you can't hear an aircraft 4 km up.

## 8. Bail-out from the high band

- **Fall model** (`VehicleBailout.cs` / `fall_model.js`): terminal 50 m/s, the chute at 150 m AGL, 5 m/s under the
  canopy. From 5 km that is ~100 s of free fall plus ~25 s under the chute. There is no server-side timeout.
- **Client**: the bail-out animation work replaced the fall twin's fixed 120 s cut-off with the slowest possible
  descent: (AGL + 500 m) / 5 m/s + 120 s, between 5 and 60 min, so ~20 min from 5 km with the chute opened at the
  top. It also added the falling pose and the parachute pack (`?vehicleFallAnim`, default ON).
- **Measured** (arm I, 1070):
  - bail at 5,005 m AGL, 104 s of free fall, touchdown after 121 s;
  - all 10 pose checks pass (Falling + arms spread + pack in free fall; grip clip + hands on the risers + flat pack +
    canopy under the chute; released at touchdown);
  - the empty Hellcat despawned 30.0 s after the bail.
- **View during the fall**: the flight view stays on (it keys on the PLAYER's height when there is no aircraft, see
  `highSubjectAgl`) and eases back to the on-foot look below 35 m.
- **The empty aircraft**: with `vehicle_derelict_high_agl` it despawns 30 s after the bail (verified, arm I).
- **Other players' view of a faller**: `vehicle_fall_motion` (default off) broadcasts retail's Falling motion, so
  retail and flag-less clients see the falling pose too; capable clients draw it themselves.

## Measured (1070, MODE T, 30 fps off-screen cap)

Arm G (`bench/plan-fx-high.json`; `/mnt/wbterminal1/tmp/claude-scratch/flight-experience/1070-G-high/`):

| | |
|---|---|
| route | Holtburg → 3 km at 100 m → climb to 5,000 m AGL at ~40 m/s (2 min) → 6 km above the clouds → dive at 25 m/s → land; 37.3 km |
| prediction | 2 corrections (0.22 m) in 7.5 min, with the server's raised ceiling and climb |
| fps p50 / p5 | 26.2 / 12.9 (5 km: 27–29; low cruise 20–26) |
| main thread at 5 km (CPU profile) | weapon FX 12 % (fixed: far weapons tick every 30th frame), per-entity ticks ~15 % (the 3D sight stops new ground objects up there), render 24 % |
| world tier | 40–120 nodes per frame, data load 6 s on take-off (lazy) |
| far forest | 251 instance rebuilds in 37 km; at most 178k instances (the cap; it trims the farthest regions) |
| storm deck | 168 look re-applies while easing, 0 drift |
| cloud tops (arm I, `?cloudHighBand`) | prewarmed before take-off, one switch at ~2 km, smooth tops, worst frame after 60 s 125 ms (G: 786) |
| defaults, no flags (arm H) | the same high route: 3 corrections (0.06 m), server objects 1,145 (G 4,379), main thread 40 % idle at 5 km (G ~2.5 %), longest task 367 ms (G 1,284) |

Server cost: ACE logged no vehicle stall (> 50 ms tick) during arms G and H; the last was at 21:42, in a low-band arm. The remaining per-crossing cost is ACE's 3 × 3
relocation load (§5).

**On screen, uncapped, vsync on** (2026-11-02, owner OK; `flight-1070.mjs --uncapped --vsync --onscreen`, the
120 Hz screen, no screencast). By AGL band from the flight rows (`bench/band-summary.py`), the high route
(`plan-fx-high-short.json`, storm):

| Run | < 450 m | 0.45–1.8 km | 1.8–4.5 km | ≥ 4.5 km |
|---|---|---|---|---|
| U8: vsync OFF, screencast on | 40.5 fps, 661 ms of long tasks | 61.8 | 37.0, **87 s of long tasks in 181 s**, worst 1.6 s | 36.3, worst 2.0 s |
| U9a: vsync on, screencast on | 37.0 | 64.5 | 36.0, worst 92 ms | 38.2, worst 175 ms |
| U9c: vsync on, no screencast | 41.8 | **81.9** | 37.0 | 39.1, worst 75 ms |

- The 0.3–2 s stalls of U8 were the vsync-off launch, not the client: with `--disable-gpu-vsync` Chrome keeps
  queuing frames into a GPU that is already behind (the every-pixel march), and the main thread blocks for the
  backlog at the next GL round trip. With vsync (as a player runs Chrome) the same route had no long task above
  1.8 km.
- The CDP screencast (the bench's default video) cost 10–25 % of the frame rate: a GPU readback and a JPEG per
  frame. Q5 numbers are taken without it from now on (`--no-video`).
- The high band's frame after `?cloudHighBandMarch`: §4.

## Open / next

- The define-off light shafts in the high band (~12 fps more at 5 km), with the clouds program's other variant
  linked off the frame first.
- The curtain streaks on the storm deck's flanks seen from above, in places (§4).
- ACE-core relocation without adjacents for a pilot in the high band (the remaining server cost; measure first).
- A BC7-packed world albedo pyramid would make the far continent sharper than per-code atlas tiling can (the far
  continent is currently textured by type). The tiling is already mip-filtered.

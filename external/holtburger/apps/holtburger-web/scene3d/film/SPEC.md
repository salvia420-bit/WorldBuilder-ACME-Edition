# Film Mode — frozen contracts (v1, 2026-10-13)

> Asheron's Call **film mode** for holtburger-web: an optional, **default-OFF** (`?filmMode=on`), agentic
> cinematography mode. A Claude Code session (Opus 5.5 on the owner's subscription — **no Anthropic API calls
> anywhere in this code**) is the *director*; **JEV** (TypeSafe's System-One decision model, OpenRouter
> Decisions API) is the camera's *reflexes*; the web client is the *camera crew*. Nothing shows on screen:
> the browser runs off-screen on the GTX-1070 box, every HUD element is stripped from the frame, and the
> director drives the page over CDP.
>
> This file is the single source of truth for module boundaries. Implementers code against it. Changing a
> contract here requires the orchestrator.

---

## 0. Roles and the production model

| Layer | Who | Rate | Owns |
|---|---|---|---|
| Director (System Two) | Claude Code (`claude --agent film-director`, or the `film-mode` skill) | between takes | script → beat sheet → plan.json; site choice; per-shot **standing orders**; teleports (≈10 s each); reviews scout stills and contact sheets (the Read tool views JPEG/PNG) |
| Pilot (System One) | **JEV** `typesafe/jev-1.13` (OpenRouter `POST /api/alpha/decisions`) | ≈3–8 decisions/s, only when needed | tactical camera judgment near trees/walls/rocks/creatures/particle clouds: hold, drift, rise, sink, slow, back off; subject lost or briefly hidden; ignore/fade/reroute an occluder; framing nudges |
| Reflexes + flight | film runtime (code) | every frame | trajectory sampling, drone dynamics, residual smoothing, **hard safety clamp (always wins over JEV)**, recording |
| Perception | film runtime (code) | ≈10–20 Hz, budgeted | sphere sweeps / raycasts / particle queries → numbers → **bucketed words** for JEV |

Design rules taken from the JEV-plays-DOOM / jev-drone / jevs-fly prior art (2026-10-13 research):
code does the geometry, Jev does the judgment; state is words not floats; one judgment per question,
several independent questions per request; option criteria are written like specs with explicit boundaries;
the conservative default option goes first (Jev's first-option bias); Score answers are thresholded, never
interpolated; only consult Jev when a decision is needed and the bucketed scene changed; answers are tagged
with the scene sequence and stale ones are dropped; a commit window prevents dithering; a code reflex layer
always owns safety; the per-shot standing order is a sentence the director writes and Jev reads every tick.

**Teleports take ≈10 s** (portal tunnel ≥4 s + arrival + streaming). Everything streams around the PLAYER
(terrain/object rings, LRU, far ring, ACE creature visibility ≈3×3 landblocks with a 112.5 m first-sight clamp):
- The hidden player character is the **streaming dolly**. Before shooting at a site the director teleports it
  there and waits for the readiness gate (§3.4). Cameras stay within ≈3 landblocks (≈600 m) of the player
  outdoors and inside the player's landblock for dungeons. Grass (terrain_grass: dense to 48 m) and the server's
  nearby objects follow the player, so `film shoot` also HOPS it inside a site (`@teleloc`, `--hop`, default 40 m)
  to each outdoor shot's camera path (§6 CLI walk).
- **Shooting schedule ≠ edit order.** Shots are grouped by site, sites ordered to minimise teleports, every shot
  is its own take; assembly reorders takes into timeline order. Never record across a teleport.

**Capture reality (1070, measured):** real time is 22–31 fps at quality=mid 1280×633 ⇒ smooth 1080p/ultra must be
**stepped**: the camera advances on a film clock, the normal render loop is held, each frame is rendered on demand
with an explicit timestamp and encoded in-page with WebCodecs right after the final draw. Server-driven motion
(NPCs, the avatar) stays on the wall clock, so shots whose subject *moves* use `capture.mode:"realtime"`.

---

## 1. Frames, units, conventions (ALL modules)

- **World frame = AC global metres**: `x` east, `y` north, `z` up (right-handed). `wx = lbX*192 + localX`,
  `wy = lbY*192 + localY`, `z` absolute. Landblock/cell id `0xXXYYcccc`; `lbKey = (id & 0xFFFF0000) >>> 0`
  (ALWAYS `>>> 0`). Outdoor cell index `1 + floor(lx/24)*8 + floor(ly/24)`. EnvCell iff `(id & 0xFFFF) >= 0x100`.
  Dungeon cells may sit far outside their landblock square: take the landblock from the cell id, never from xy.
- Map coords: `ew = wx/240 − 101.95`, `ns = wy/240 − 101.95` (E/N positive). ACE `@tele 42.1N 33.6E` (NS first).
- **Heading `h`**: compass radians, clockwise from north (+y). `forward(h,p) = (sin h·cos p, cos h·cos p, sin p)`.
  (Wasm `LocalPlayerPose.heading` / `EntityManager.getHeading` are CCW yaw: compass = −yaw.)
- **Pitch `p`**: radians, + looks up, valid range **[−π/2, +π/2] inclusive** (straight down is legal).
- **Roll `r`**: radians, right-hand rotation about forward (clockwise as seen by the camera operator; top of frame
  moves right for r > 0).
- **Camera basis** `{right, forward, up}`: identity camera looks north (+y) with up = +z, right = +x.
  `right(h) = (cos h, −sin h, 0)`, `up(h,p,0) = (−sin h·sin p, −cos h·sin p, cos p)` — well-defined at p = ±π/2, so
  gimbal angles have **no singularity**; only *deriving* a heading from a vertical forward vector is ambiguous (§2.3).
- **Quaternion** `[w, x, y, z]` (AC frame) maps the identity camera basis to the actual basis.
- **three.js** (camera is unparented, outside `worldRoot`): position `acToThree(x,y,z) = [x, z, −y]`; orientation
  `q_three = qM ⊗ q_ac ⊗ qM⁻¹` with `qM = [√½, −√½, 0, 0]` (Rx(−90°)); three `Quaternion(x, y, z, w)` order.
  Identity AC camera ↔ identity three camera.
- **FOV**: vertical degrees. Never animate `near`/`far` (pmndrs copies them by value) — near 0.1, far 5000.
- Time: seconds (film time). Distances: metres. Angles in APIs: radians unless the name ends in `Deg`.
- Wasm boxes (`CollisionHit`, `LocalPlayerPose`, `LandblockMesh`, `EnvCellPlacement`) MUST be `.free()`d after
  copying fields. typeof-guard every wasm export (a stale pkg/ may lack it).
- Never call `camera.lookAt` with a fixed up vector near ±90° pitch (three r184 snaps north-up → flips).

## 1.1 Repository layout (HB = external/holtburger/apps/holtburger-web)

| Path | What | Loaded by |
|---|---|---|
| `scene3d/film/` | ALL in-page code + pure modules shared with Node (bundled by build-shell, swept by every lint) | page (lazy, `?filmMode=on`) and Node tools |
| `scene3d/film/{core,shots,drone,pilot}/` | pure math / shot grammar / flight model / JEV pilot logic | both |
| `scene3d/film/scene/` | perception & planning: `solver.js`, `dungeon_route.js`, `los.js` (pure, injected handle); `world_query.js`, `sensors.js`, `particles_query.js`, `terrain_corridor.js` (page adapters, injected deps; `world_query.js` also takes injected static-placement `catalogs`, built by `film/index.js` with world_query `createStaticCatalogs`, see below) | page (+tests with fakes) |
| `scene3d/film/runtime/` | camera owner, clean frame, film clock, take player, safety, recorder, look, world, JEV page bridge | page |
| `scene3d/film/index.js` | `installFilmMode(deps)` → `window.__film` | page |
| `scene3d/film/flags.js` | `filmModeEnabled(search)`, `filmDofEnabled(search)` (exact `=== "on"`, memoised, injectable, `_set…ForTest`) | page |
| `tools/film/` | Node-only: CLI `film.mjs`, `lib/` (cdp, jev, broker, session, shoot, ffmpeg, project), `audio/` (song DSP), `plan/` (schema/compile/edl), `sites/` (gazetteer), `data/concept_lexicon.json` | Node |
| `tests/film_<topic>.test.mjs` | node:assert/strict suites, registered in TIER5 of `harness/run-js-headless.mjs` | gate |
| `$REPO/.claude/skills/film-mode/SKILL.md`, `$REPO/.claude/agents/film-director.md` | Claude Code packaging (canonical; symlinked into `~/.claude/` by `tools/film/install-claude.sh`) | Claude Code |

Page modules MUST NOT import stateful scene3d modules (`terrain.js`, `statics.js`, `buildings.js`, `entities.js`,
`cells.js`, `index.js`, `camera.js`, `landblock_lru.js`, `particle_manager.js`) — dependencies arrive through
`installFilmMode({liveScene3d, THREE, sessionHandle, wasmExports, particleCull, ...})` or `window.liveScene3d`.
Importing dependency-free modules is fine: `../projectile_sweep.js`, `../pick_math.js`, `../camera_math.js`,
`../particles/time_rng.js`, `../particles/owner_registry.js`, `../sky_game_date.js` (`AC_DAY_LENGTH_S`, shots/drone.js),
`../night_ramp.js` (`nightFactorFromAuthoredPitch`, film/index.js), `../../rynth/indoor_router.js`,
`../../rynth/nav_frame.js`. `film/index.js` also dynamically imports the time-source seams (`../particles/time_rng.js`,
`../particles/particle_fx.js`, `../animated_scenery.js`; §4 items 6–7) and `../vfx_catalog.js`, which it only READS:
`vfxDescriptorFor(did)`, never `ensureVfxCatalog` (the import returns the same module instance the client's own VFX
paths fill: the statics bake and the entity spawns — tipFlex, weaponFx, gemSparkle; vfx_catalog.js is not modified).
No new file-backed `Worker`s (build-shell WORKER_ENTRIES).

**Static placement catalogs** (`scene/world_query.js` `catalogs`, built by `film/index.js` with
`createStaticCatalogs`): the client's VFX descriptor catalog (`vfxDescriptorFor` only) gives each placement its
archetype (tree vs rock) and, for catalogued models, its DAT-bounds size; `wasmExports.fetchSetupSelectionSphere`
sizes the other Setup DIDs (fetched once per DID, prefetched per landblock, boxes freed; each prefetch waits at most
3 s, and a DID still unsettled when a wait times out is remembered as stalled and never waited for again — its fetch
stays in flight and its size applies if it ever settles). A `staticsNear` query loads its landblocks (≤ 25)
concurrently, so it waits about one 3 s bound in total, not one per landblock. Per-kind defaults are the fallback.
`StaticFacts` (and `query.near` `statics`) carry `dimsSource: 'catalog'|'selectionSphere'|'default'`. An optional
collider source exists — `createStaticCatalogs({colliderOf})` → `catalogs.staticColliderOf(did)`, the physics-collider
reach in model metres, read by the scenery hit LABEL rule (§3.1; it never makes a fade) — but none is wired: the VFX
descriptors carry no collider data, so the reach comes from the size radius.
Degrade: only the client's own VFX paths load the catalog. The statics bake loads it for the GPU tree sway (default
on; off with `?treeWindGpu=off`, `?treeWind=on`, `?windGeo=on` or `?visual=off`) and for the `?windGeo=on` wind peel,
which has NO `?visual` gate; entity spawns load it for `?tipFlex`, `?weaponFx` and `?gemSparkle` (each default on under
`?visualAll`, all off under `?visual=off`). So the catalog stays empty exactly when `?windGeo=on` is absent and either
`?visual=off` is set or every other path is off (GPU tree sway off and `?tipFlex`, `?weaponFx`, `?gemSparkle` all off,
e.g. `?treeWindGpu=off&visualAll=off`). Then scenery reads as rock (a label only — v1 never fades procedural scenery,
§3.1) and a placed tree reads as a prop sized by its selection sphere, if any, so it fades only when that known size
passes the small-prop rule; otherwise the pilot reroutes. Flag off: neither the catalog read nor the sphere fetch
happens.

---

## 2. Pure modules (no DOM, no three, no wasm — node-testable ES modules)

Vectors are plain arrays `[x,y,z]`; functions return new arrays. Deterministic: seeded RNG only, no `Date.now()`.
Errors: throw `FilmError` subclasses with readable messages (defined in `scene3d/film/core/errors.js`:
`FilmError`, `FilmShotError`, `FilmPlanError`).

### 2.1 `core/vec3.js`
`v3(x,y,z)`, `add`, `sub`, `scale(a,s)`, `addScaled(a,b,s)`, `dot`, `cross`, `len`, `lenSq`, `dist`,
`norm` (zero → `[0,0,0]`), `lerp(a,b,t)`, `clampLen(a,max)`, `horiz(a)` (`[x,y,0]`), `angleBetween`,
`projectOnPlane(a,n)`, `rotateZ(a,ang)` (CCW about +z), `equalsApprox(a,b,eps=1e-9)`, `isFiniteV`.

### 2.2 `core/quat.js`
`qIdentity`, `qMul(a,b)`, `qConj`, `qNorm`, `qDot`, `qFromAxisAngle(axis,ang)`, `qRotate(q,v)`,
`qSlerp(a,b,t)` (shortest arc; nlerp fallback when nearly parallel), `qNlerp`, `qAngle(a,b)`,
`qEnsureContinuity(prev,q)`, `qFromBasis(right,forward,up)`, `qToBasis(q) → {right,forward,up}`,
`qSpline(qs, u)` (C¹ through keys; u ∈ [0,1] uniform over segments), `qToThree(q) → [x,y,z,w]` (§1 conjugation),
`qFromThree([x,y,z,w])`.

### 2.3 `core/gimbal.js`
- `forwardFromHP(h,p)`, `basisFromHPR(h,p,r)`, `quatFromHPR(h,p,r)`, `hprFromQuat(q, headingHint)` (cos p < 1e-6 →
  h = headingHint).
- `wrapPi(a)`, `unwrapAngle(a, ref)`, `shortestAngleDiff(a,b)`.
- `lookRotation(eye, target, {headingHint=0, roll=0, holdConeDeg=1.5}) → {h,p,r,q}` — stateless; heading from
  `atan2(dx,dy)` unless the target is inside the vertical hold cone, then `headingHint`. Never NaN (coincident
  points → p = 0, h = headingHint).
- `createLookController({maxYawRate=2.5, maxPitchRate=2.0, smoothTime=0.25, holdConeDeg=2,
  nadirMode='yaw-slew'}) → {reset(h,p,r), update(eye, target, dt, {roll, headingHint}) → {h,p,r,q}}` — stateful smooth
  look-at. `yaw-slew`: heading holds inside the cone, then slews to the new bearing at ≤ maxYawRate (at nadir this is
  a smooth image rotation — the drone "gimbal flip"); `pitch-through`: pitch continues past ±90° (image inverts; FPV
  flips; output keeps h continuous and reports p beyond ±π/2 only through q); `hold`: heading frozen until the cone
  is exited by 2×holdConeDeg. Guarantees continuity, |Δh| ≤ maxYawRate·dt + 1e-9, no NaN.
- `acToThreePos`, `threeToAcPos`, `acQuatToThree(q) → [x,y,z,w]`.

### 2.4 `core/spline.js`
`catmullRom(points, {alpha=0.5, closed=false}) → {sample(u), tangent(u), segments}`;
`makePath(points, {alpha, closed, samples=1024}) → Path {length, at(s), tangentAt(s), curvatureAt(s), uAt(s),
points}` (arc-length LUT, s clamped); `filletPolyline(points, radius, {arcSegments=8})` (each interior corner →
circular arc of radius `min(radius, 0.45·min(adjacent lengths))`; collinear untouched — 90° corridor turns become
arcs); `resamplePolyline(points, step)`; `bezier3(p0,p1,p2,p3,t)`; `polylineLength(points)`;
`speedLimitedProfile(path, {vmax, amax, alat=2.5}) → {duration, sAt(t)}` (curvature-limited `v ≤ √(alat/κ)`,
forward/backward passes, monotone).

### 2.5 `core/easing.js`
`linear, sineIn, sineOut, sineInOut, quadIn, quadOut, quadInOut, cubicIn, cubicOut, cubicInOut, quintInOut,
expoInOut, smoothstep, smootherstep` (f(0)=0, f(1)=1, monotone); `EASINGS` map; `ease(name)` (throws on unknown);
`minJerk(t)`; `trapezoidProfile(distance, vmax, amax) → {duration, s(t)}`;
`sCurveProfile(distance, vmax, amax, jmax) → {duration, s(t)}`; `holdEase(t, holdIn, holdOut, name)`.

### 2.6 `core/spring.js`
`critDamp(x, v, target, omega, dt) → {x, v}` (exact), `critDampV3`, `critDampAngle` (wrap-aware),
`smoothDamp(cur, target, vel, smoothTime, maxSpeed, dt) → {value, vel}`, `smoothDampV3`,
`createSecondOrder({f, zeta, r, dim=3}) → {reset(x), update(xTarget, dt) → y}` (stable via substeps).

### 2.7 `core/rng.js`, `core/noise.js`
`mulberry32(seed)`, `hashString(str) → uint32`, `rngRange(rng,a,b)`, `rngPick(rng,arr)`.
`createNoise1D(seed) → (t) → [−1,1]` (smooth, C¹), `fbm1D(noise, t, {octaves=3, lacunarity=2, gain=0.5})`,
`createShake({seed, amplitudeDeg=0.6, frequencyHz=1.2, posAmplitude=0.03, roughness=0.5}) → (t) →
{dh, dp, dr, dpos}` (radians / metres).

### 2.8 `core/units.js`
`LB_SIZE=192`, `CELL_SIZE=24`; `lbKeyOf(id)`, `lbXY(id)`, `isIndoorCell(id)`,
`worldFromLocal(cellOrLbId, lx, ly, lz) → [wx,wy,z]`, `localFromWorld(wx, wy, z) → {cellId, lbKey, lx, ly, z}`,
`landblockOfWorld(wx,wy) → lbKey`, `worldToMap(wx,wy) → {ns, ew}`, `mapToWorld(ns, ew) → [wx, wy]`,
`formatMap(ns, ew)`, `hex32(n)`, `headingQuat(compassRad) → {qw,qx,qy,qz}` (`qw=cos(θ/2)`, `qz=−sin(θ/2)`),
`telelocCmd(cellId, lx, ly, lz, compassRad?)` (`@teleloc 0x… x y z qw qx qy qz`, 2–4 decimals),
`teleMapCmd(ns, ew)` (`@tele 42.10N 33.60E`), `telepoiCmd(name)`.

### 2.9 `shots/trajectory.js`
- **Pose** `{t, pos:[x,y,z], h, p, r, q:[w,x,y,z], fov, focus?}` (AC; `focus` metres).
- **Trajectory** `{id, technique, family, duration, sample(t) → Pose, keyframes:[{t,pos,h,p,r,fov}], subject?,
  bounds, meta}` — `sample` is **pure in t** (random access for scouting); t clamps to [0, duration].
  `bounds = {maxLateral, maxRise, maxSink, minSpeedScale, maxSpeedScale, maxDistanceScale}` — how far the pilot may
  push this shot.
- `makeTrajectory({id, technique, family, duration, positionAt(t), orientAt(t, pos) → {h,p,r}|{q}, fovAt?(t),
  focusAt?(t), keyframes?, subject?, bounds?, meta?})` — fills `q`/hpr, throws `FilmShotError` on NaN.
- `timeWarp(traj, warp)`, `withOffset(traj, fn(t) → {dpos, dh, dp, dr, dfov})`,
  `concatTrajectories(list, {bridge:'cut'|'blend', blendSec=0.5})`,
  `bakeTrajectory(traj, fps) → {fps, frames, rows: Float64Array(frames×11)}` rows =
  `[t, x, y, z, qw, qx, qy, qz, fov, focus, roll]`; `tableChecksum(rows) → hex` (FNV-1a over 1 mm / 1e-4 quantisation);
  `trajectoryFromTable(table)` (replay: lerp position, slerp quaternion);
  `validateTrajectory(traj, {fps=30, maxLinearSpeed=80, maxAngularSpeedDeg=240}) → {ok, issues[]}`.

### 2.10 `shots/framing.js`
`FRAMINGS = {EWS: 8.0, WS: 2.5, FS: 1.15, MWS: 0.75, MS: 0.5, MCU: 0.33, CU: 0.2, ECU: 0.1}` (frame height = k·H).
`distanceForFraming(framing, H, fovDeg)` = `k·H/(2·tan(fov/2))`; `fovForFraming(framing, H, dist)`;
`aimPointForFraming(framing, subject)` (eye line ≈ 0.9H for MS..ECU; centre for FS/WS/EWS);
`thirdsAimOffset({side, vertical}, fovDeg, aspect) → {dh, dp}`; `leadRoomSide(velocity, camForward)`;
`projectToNdc(pose, point, fovDeg, aspect) → {x, y, depth, inFront}`;
`subjectScreenRect(pose, sphere, fovDeg, aspect) → {x0,y0,x1,y1,heightFrac}`;
`compositionMetrics(pose, subject, fovDeg, aspect, intent) → {ndc, heightFrac, sizeRatio, thirdsError, headroom,
horizonTiltDeg, inFrame}`.

### 2.11 `shots/registry.js` (+ `shots/index.js` registers everything)
- `registerTechnique(def)`, `getTechnique(id)`, `listTechniques({family}) → JSON-safe catalog`,
  `buildShot(spec, ctx) → Trajectory` (validates/fills params from the schema, attaches bounds and family, throws
  `FilmShotError` with a readable message on unknown ids / bad params).
- Def: `{id:'classic.dolly-in', family:'classic'|'drone'|'fpv', name, description, whenToUse,
  params:{name:{type:'number'|'string'|'boolean'|'enum'|'vec3', default, min, max, values, desc}},
  needs:{subject:boolean, path:boolean, indoor:boolean|null}, defaultBounds, build(spec, ctx) → Trajectory}`.
- **ShotSpec** `{technique, duration, params, framing?, subject?, fov?, roll?, ease?, seed?}`.
- **ShotContext** `{subject:{pos,radius,height,heading?,velocity?}|null, subjectAt?(t), anchor:[x,y,z],
  groundZ(x,y) → z|null, path?:[[x,y,z]...], aspect, fps, rng, sun?:{h,p},
  indoor?:{route?:[[x,y,z]], ceiling?(x,y) → z|null, floor?(x,y) → z|null}}`.
  `subjectAt(t)` MUST be **pure in t** (it feeds the pure `sample(t)`): for a live subject the page passes a
  reference track (§5.2 Take). The live, t-ignoring "where is it now" function is a separate take-player input
  (`take.liveSubject`), never a ShotContext field. `sun` = `{h, p}` radians (compass bearing TOWARD the sun, clockwise
  from north, and elevation), set by the page outdoors from the live sky; absent indoors, at night and before the sky
  state is readable.

### 2.12 Technique catalog (ids are API — the director writes them in plans)
`shots/classic.js` → `classic.*`: `static`, `pan`, `tilt`, `roll`, `zoom`, `dolly-in`, `dolly-out`, `truck`,
`pedestal`, `crane`, `arc`, `orbit`, `tracking-follow`, `tracking-lead`, `tracking-side`, `push-in`,
`pull-out-reveal`, `dolly-zoom`, `whip-pan`, `rack-focus`, `over-the-shoulder`, `pov`, `two-shot`, `establishing`,
`high-angle`, `low-angle`, `birds-eye`, `worms-eye`, `handheld`, `steadicam`, `snorricam`, `reveal-from-occluder`,
`time-lapse`, `hyperlapse`.
`shots/drone.js` → `drone.*`: `flyover`, `flythrough`, `orbit-poi`, `helix`, `dronie`, `boom-rise`,
`rising-reveal`, `tilt-reveal`, `top-down`, `top-down-rise`, `top-down-track`, `pass-over`, `parallax-slide`,
`terrain-skim`, `canyon-run`, `chase`, `lead`, `side-track`, `boomerang`, `fly-by`, `spiral-descent`, `pano-360`,
`hyperlapse-orbit`, `vertigo-drone`; and `fpv.*`: `fpv-dive`, `fpv-proximity`, `fpv-gap`, `fpv-flip`,
`fpv-corridor`.
Every technique: honours `duration`; keeps the subject in frame when `needs.subject` (inFront & |ndc| ≤ 1 for ≥95% of
samples unless it is a reveal); continuous, NaN-free; respects `ctx.groundZ` (+0.7 m) outdoors and
`ctx.indoor.ceiling/floor` when given; declares sensible `defaultBounds`; documents params in its schema.
`time-lapse`/`hyperlapse*` set `meta.timeLapse = {rate, unit:"game-days/s"}` (rate = game-days per film second, what
film_clock reads; sky time advanced by the runtime; `drone.hyperlapse-orbit` converts its `timeRate` param, in seconds
of the live sky clock per film second, ÷ `AC_DAY_LENGTH_S` = 7620); `rack-focus` writes the `focus` channel.
Path-flying drone / fpv builders report `meta.lengthM` and, when a speed profile flies the path, `meta.peakSpeed` (the
profile's peak) and `meta.overspeed` (the profile had to be time-compressed past its caps); the prepare-time flight
check (§3) reads them, also measures the peak on the baked nominal (orbits, helix, dronie… have no profile), and
dry-flies the nominal through the flight model (`FLIGHT_CHECK`), which catches moves limited by acceleration.

### 2.13 `drone/flight_model.js`
`DRONE_PRESETS = {cinema, heavy, fpv, indoor}`; `createDrone(presetOrConfig) → {reset(pose), step(targetPose, dt)
→ Pose, state()}` — jerk/accel/velocity-limited critically damped tracking; body attitude from acceleration (bank ∝
lateral accel, pitch ∝ forward accel, ≤ maxTiltDeg); camera = stabilised gimbal (lagged target orientation, pitch
limits [−90°, +30°]; horizon-roll FOLLOW ERROR (camera roll − the target's own roll, wrap-aware across ±180°) pulled
back inside ±rollLimitDeg (45°) while camera and target are within 72° of level, by a correction that turns the short
way and shares the gimbal's maxRateDeg budget: a deliberate roll (Dutch angle, barrel roll, inverted pitch-through
image) is carried, never clamped; the gimbal never rotates faster than maxRateDeg — cinema 120, heavy 80, indoor 90 °/s,
so a target that rolls faster is followed with lag, never a snap) or FPV hard mount (body attitude + uptilt).
`wind:{gustMps, seed}`. `presetForTrajectory(traj, {indoor})` picks the automatic preset (`traj.meta.flightPreset`
when it names one, fpv family → `fpv`, indoor → `indoor`, else `cinema`); `take.pilot.flightPreset` overrides it.
`flyTrajectory(traj, preset, fps) → Trajectory` (baked "real drone feel", same duration ± overrun allowed ≤ 10%).

### 2.14 `pilot/*` — JEV System-One pilot (pure; the bridge is injected)
- `sense_words.js` — `WORD_BOUNDS` (exported; criteria and code policy share them) and bucketers:
  `distanceWord(m)`: `touching` <0.75, `very close` <2, `close` <4, `near` <8, `medium` <16, `far` <40, else
  `clear`; `ttcWord(s)`: `imminent` <0.75, `soon` <2, `later` <5, else `none`; `bearingWord(deg)` (+ = right):
  `dead ahead` |b|<10, `ahead-left|right` <35, `left|right` <80, `behind-left|right` <150, else `behind`;
  `elevationWord(deg)`; `visibilityWord(frac)`: `fully hidden` <0.1, `mostly hidden` <0.4, `partly hidden` <0.8,
  else `clear`; `unseenWord(s)`: `not hidden`, `brief` <1, `a while` <3, else `long`; `sizeWord(ratio)`:
  `much too small` <0.5, `too small` <0.8, `right` ≤1.25, `too large` ≤2, else `much too large`;
  `offsetWord(ndcX, ndcY)`; `speedWord(mps)`; `sinceWord(s)`; `rankOf(word, scale)` helpers.
- `scene_state.js` — `buildPilotState(sensorFrame, {standingOrder, technique, goal, bounds, hasSubject,
  current:{maneuver, since, lateral, vertical}}) → state` (words only + the standing-order sentence):
  `{standing_order, shot:{technique, goal}, camera:{speed},
  obstacles:{far_left, left, ahead, right, far_right, above, below, left_side, right_side, behind} ("<range> <kind>"
  or "clear"), free_space:{level_ahead, above_ahead, below_ahead}, nearest:{kind, range, side},
  path_ahead:{contact_in, blocker}, subject:{visibility, unseen_for, in_frame, size, occluded_by},
  particles:{on_lens, in_view}, limits:{can_rise, can_sink, can_drift_left, can_drift_right, room_left, room_right,
  ceiling}, current:{maneuver, since}}`. `room_left`/`room_right` = the sensed free space beside the camera (never
  capped by the shot bounds); `can_drift_left`/`can_drift_right` = "yes" while more than 0.05 m (`BOUND_SLACK_M`) of
  `bounds.maxLateral` is left on that side (`current.lateral`, + = right) — the same yes/no gate as
  `can_rise`/`can_sink` against `maxRise`/`maxSink` (`current.vertical`), which also need the sensed room.
- `questions.js` — `PILOT_QUESTIONS` (Decisions-API `questions` object) and `questionsFor({hasSubject})`:
  `maneuver` (choice, conservative default first): `hold_path`, `drift_left`, `drift_right`, `rise`, `sink`,
  `slow_down`, `back_off`; `risk` (score, 3 levels: open / tight but manageable / about to hit); `subject_lost`
  (noul with explicit true/false criteria); `occluder_action` (choice): `ignore`, `fade`, `reroute`, `wait`;
  `framing` (choice): `keep`, `recenter`, `widen`, `tighten`. Criteria quote the state's exact words and
  WORD_BOUNDS (e.g. `rise` only when `free_space.above_ahead` is ≥ 2 buckets farther than `free_space.level_ahead`
  AND `limits.can_rise` is "yes" — the jev-drone lesson: vertical info + ceiling must be in state; `drift_left` /
  `drift_right` only when `limits.can_drift_left` / `can_drift_right` is "yes", the sensed room on that side
  (`room_left` / `room_right`) is ≥ "some" and that side (`obstacles.left` / `obstacles.right`) is ≥ "near").
- `policy_code.js` — `codePolicy(sensorFrame, state) → answers` in the **exact Decisions-API answer shape**
  (`{maneuver:{type:'choice', choice, confidence, probabilities}, risk:{type:'score', score, confidence,
  probabilities}, subject_lost:{type:'noul', noul}, ...}`): no-key fallback, test mock, shadow-agreement metric.
- `fingerprint.js` — `sceneFingerprint(state) → string` (stable stringify of words, minus `current`).
- `mapper.js` — `createResidualMapper({bounds, commitSec=1.0, overrideRisk=1.6, staleSec=0.6,
  minConfidence=0.45}) → {apply(answers, {sceneTime, now, sensorFrame}) → Setpoint, current(), reset()}`;
  **Setpoint** `{lateral (m, +right), vertical (m, +up), speedScale, distanceScale, framing:{dh,dp,dfovDeg},
  fadeIds:[], reroute:boolean, maneuver, source}`. Commit window; low-confidence answers decay toward neutral;
  stale answers ignored and can never increase descent; offsets clamp to bounds. `occluder_action` `fade` with no
  fadeable id in `sensorFrame.subject.occluderIds` (any procedural scenery tree or rock, a building, a big or unsized
  prop, an unresolvable static) sets `reroute = true` instead (counter `fadeFallbacks`), so a fade answer is never a
  no-op.
- `pilot.js` — `createPilot({bridge, mode:'jev'|'code'|'shadow', decisionHz=5, maxInFlight=2, minDispatchSec=0.12,
  consult:{withinM=6, unseenSec=1.0, framing:true}, reuseSec=2.0, mapper, log}) →
  {tick(sensorFrame, ctx, now) → {setpoint, telemetry}, tickStepped(sensorFrame, ctx, now) →
  Promise<{setpoint, telemetry}>, stats(), reset()}`; `bridge = {available, request({state, questions, seq}) →
  Promise<{answers, id?, usage?, ms?}>}` or null. Realtime: pipelined (≤ maxInFlight), sequence-numbered, only
  answers about a NEWER scene replace the current one. Stepped: awaits the bridge when a decision is due (film time is
  paused) — deterministic. Consult only when needed AND (fingerprint changed OR last answer older than reuseSec).
  `shadow`: act on code policy, also ask JEV, log agreement. Telemetry per decision `{seq, t, source:'jev'|'code'|
  'reuse'|'none', fingerprint, answers, latencyMs, costUsd, agreeWithCode}`.

### 2.15 `scene/solver.js`, `scene/dungeon_route.js`, `scene/los.js` (pure)
- `generateCandidates(intent, subject, ctx, {count=12, rng}) → [Pose]`; `scoreCandidate(metrics, intent) →
  {cost, reasons[]}`; `rankCandidates(cands, metricsArr, intent)`; `describeCandidate(metrics) → string` (words, for
  JEV choice criteria: the view with the sense_words visibility word, the clearance with the `WORD_BOUNDS` distance
  word leading and the metres, truncated into that band, as a detail — "nearest tree very close (1.5 m)" — so the
  words jev_tasks `PICK_INSTRUCTIONS` quotes (`PICK_HIDDEN_WORDS` / `PICK_TOO_CLOSE_WORDS`, generated from
  sense_words) appear verbatim). `intent = {framing, angle:'eye'|'high'|'low'|'top', side?, light?:'front'|'back'|'rim',
  minClearance, maxOcclusion}` (`light` needs `ctx.sun`).
- `doorwayControlPoints(graph, cellPath, {heightFrac=0.55, approach=1.2}) → [[x,y,z]]`;
  `planIndoorPath(graph, fromCell, toCell, {findPath, fillet=1.5}) → {points, cells}` (camera variant: drop edges
  allowed); `indoorCameraPath(points, {fillet}) → Path`. Graph = `rynth/indoor_router.js` graph
  (`Map<cellId,{pos, neighbors, exits, doors, floorZMin, floorZMax}>`; doors from `doorsFromRows`).
- `segmentBlocked(sh, from, to, {radius=0.25, subjectGuid=0, cellIds=null, layers, terrainZAt}) → {blocked, t,
  layer, point, normal}` — chunks per landblock (≤192 m), per-layer wasm sweeps (`sweepSphereAgainstBuildingMesh`,
  `…Statics`, `…Scenery`, `…CellMesh`, `…CellStatics`, `…Entities`, `…Objects` with missile_guid = subjectGuid), terrain
  via `projectileTerrainCrossing`; copies + frees every hit; embedded-start rule (`projectileHitStops`).
  `kindForLayer(layer, extra)` → `tree|rock|wall|building|prop|door|creature|terrain`.

---

## 3. Page runtime (`scene3d/film/runtime/`, loaded ONLY with `?filmMode=on`)

`scene3d/film/index.js` exports `installFilmMode({liveScene3d, THREE, sessionHandle, wasmExports, particleCull, log})
→ api` and installs `window.__film`; `particleCull` (optional, each key optional) = particle_manager.js
`{setParticleCullConfig, allParticleManagers}`, passed by the §4 item 1 seam (rendered takes and scout stills run the
RP6 particle cull with `recheckInterval: 1` and restore the previous interval; the particle query enumerates
`allParticleManagers()`). Every method is JSON-in / JSON-out (async where noted) and returns
`{ok:false, error:{name, code, message}, code}` instead of throwing. `prepare`, `rehearse`, `shoot` and `scout` are
mutually exclusive (`FILM_BUSY`). `pose`, `release`, `world.teleport` and `world.command` answer
`{ok:false, code:'FILM_BUSY'}` and do nothing while a take, prepare, shoot, rehearse or scout runs (the same guard for
all four, also through prepare's own awaits: never a teleport or an admin command recorded mid-take, or sent while
prepare reads the subject, sun and route); `abort()` and wait for `status().active === false` first.

| Method | Purpose |
|---|---|
| `status()` | `{ok, version, active, busy, runtimeReady, timeSources, cameraOwned, viewerCell, clean, cleanState, take, recorder, pilot, lastTake, clock, look, flags, bridge}` |
| `clean(on=true)` | strip HUD/DOM/overlays/brackets/bubbles/cursor; lock input; `false` restores |
| `own()` / `release()` | take/return the camera (`release` → FILM_BUSY while a take, prepare, shoot, rehearse or scout runs) |
| `pose(poseJson)` | set an absolute AC-frame pose now (FILM_BUSY while a take, prepare, shoot, rehearse or scout runs) |
| `world.teleport(cmd)` / `world.command(cmd)` | `sessionHandle.sendChat(cmd)` (commands must start with `@`; one line ≤ 200 chars; logout / DB-writing verbs refused). While a take, prepare, shoot, rehearse or scout runs both answer FILM_BUSY and send nothing. When idle, `teleport` then parks the film viewer cell (`camera_owner.parkCell`) → `{ok, cmd, viewerParked}`; `command` only sends |
| `world.ready(opts)` | async readiness gate report (§3.4) |
| `world.prewarm({points, radius})` | async: collision populate + heightmap corridor + statics/buildings/envcells for those LBs |
| `world.avatar(visible)` | hide/show the local player (film-hide term, shadows included) |
| `world.look(lookJson)` / `world.restoreLook()` | time of day, DayGroup, fog, exposure, grade, DoF (re-applying the fog already showing keeps its object: `applied.fog.changed:false`) |
| `world.actor(cueJson)` | emote / motion / face heading / move-to for the player-as-actor (realtime shots) |
| `query.subject(ref)`, `query.near({center, radius, kinds})`, `query.groundZ(x,y)` | live scene queries (`near` statics carry `dimsSource`) |
| `techniques()` | technique catalog |
| `scout(shotJson, {count, stills, width, intent})` | async: candidates + metrics (+ JPEG data URLs when `stills`), `sun:{available, reason, headingDeg, pitchDeg}`, `warnings[]` (an `intent.light` ignored without a usable sun) |
| `prepare(takeJson)` | build trajectory (technique spec or baked table), reset pilot/drone/safety, apply the look → the prepare summary (below) |
| `rehearse({fps, render, locked, maxOverrun})` | async: run the take stepped without capture → the take report fields + `realisedTable`, `checksum`, `pilotTelemetry`, `safetyEvents` |
| `shoot({fps, width, height, codec, bitrate, mode, locked})` | async: record the take → take report (below) |
| `recorder.drain({maxBytes})` | `{chunks:[{seq, b64, timestampUs, key}], done, stats}` |
| `abort()`, `logs({limit})`, `dispose()`, `recorder.stats()` | stop a running take at its next frame; last log entries; uninstall; encoder stats |

**Prepare summary** `{ok, shotId, technique, family, duration, fps, plannedFrames, preRollFrames, hasSubject, hasFocus,
fromTable, captureMode, pilotMode, bounds, reveal, timeLapse, nominalChecksum, validation, liveSubject, flight, subject,
route, sun, look}`:
- `validation` = `validateTrajectory` of the nominal `{ok, counts, issues:[{code, t, message}]}`; a drone / fpv path
  the flying preset cannot follow adds the issue `overspeed` `{code, t:null, message, preset, vmax, peakSpeed,
  limitedBy, minDurationSec, minDurationVerified, durationHelps, maxGapM?}` (`ok:false`; `maxGapM` = the DRY-flown
  gap when one was flown, sampled at `FLIGHT_CHECK.fps` — not the realised gap of a run, which the CLI's
  `tracking-gap` reports; the message names the fix — "an estimate" when the duration is not verified — and, when a
  non-linear ease speeds up the middle of the move, an ease hint).
- `flight` (drone / fpv, not a replayed table; else null) = `{preset, vmax, amax, peakSpeed, metaPeakSpeed,
  sampledPeakSpeed, lengthM, overspeed, limitedBy, profileOverspeed, minDurationSec, minDurationVerified,
  minDurationCheck, durationHelps, ease, gapToleranceM, dryFlight}`. `preset` is the one flown (`pilot.flightPreset`,
  else `presetForTrajectory`). `peakSpeed` = max(builder `meta.peakSpeed`, the peak measured on the baked nominal).
  `dryFlight` = the nominal flown through the preset's flight model the way a take flies it (reset with the path's
  feed-forward, re-set at declared cuts) at `FLIGHT_CHECK.fps` (10) — `{fps, frames, maxGapM, maxGapT, endGapM,
  peakAccel}` (craft-to-nominal gaps in metres; `peakAccel` = the nominal's peak acceleration) or null when no craft
  could be flown. `overspeed` = the speed check (peak or mean `lengthM` / duration > preset vmax × 1.02) OR a dry-flown
  gap above `FLIGHT_CHECK.gapToleranceM` (1 m; `gapToleranceM`); `limitedBy` = `'speed'` (the speed check failed),
  `'acceleration'` (only the gap failed: a move within vmax that turns or brakes harder than the preset's `amax`
  allows, e.g. a shortened boomerang or boom-rise) or null. The builder's `meta.overspeed` is reported only as
  `profileOverspeed` and fails the check only when no speed is measurable and nothing could be flown.
  `minDurationSec` (null when not overspeed) is searched by rebuilding the shot and dry-flying it on the 0.1 s grid,
  starting from an estimate (speed: the duration at which the move peaks at vmax, ≥ lengthM / vmax; acceleration:
  D·√(peakAccel / amax), ≤ 4·D; else 1.25·D) and bounded by `FLIGHT_CHECK.maxRebuilds` (6) rebuilds and
  `maxFlownSec` (360) s of dry-flown film time (deterministic work, never the wall clock). `minDurationCheck` =
  `'verified'` (`minDurationVerified:true`) only when the shot rebuilt at that duration passes both checks — within
  vmax and dry-flown within 1 m; `'unverified'` (`minDurationVerified:null`; `minDurationSec` is an estimate) when the
  budget runs out first or a rebuild throws; `'failed'` (`minDurationSec:null`, `minDurationVerified:false`,
  `durationHelps:false`) when lengthening lowers neither the peak nor the dry-flown gap (a speed param without a path,
  a non-linear ease, a followed subject). Only a take built from a ShotSpec is searched. A take with none to rebuild
  (a prebuilt `trajectory`) is `'unverified'` when the check made an estimate (`minDurationSec` set) and otherwise
  keeps `minDurationCheck`, `minDurationSec` and `minDurationVerified` null — e.g. only the dry-flown gap failed and
  the dry flight's `peakAccel` is within `amax`, so there is no acceleration estimate.
- `liveSubject` `{mode:'carry'|'aim'|'off', rotate, refHeadingDeg}` (null without a live subject, §5.2 Take);
  `sun` `{available, reason, headingDeg, pitchDeg}` (indoors: unavailable).

**Take report** (`shoot`; `rehearse` returns the same fields; a failed take answers `{ok:false, error}` with the partial
report in `error.details.partial`): `{ok, shotId, technique, family, mode, locked, fps, frames, durationSec (= frames /
fps), plannedFrames, overrunFrames, preRollFrames, progressReached, capped, aborted, realisedChecksum, nominalChecksum,
pilot, safety:{adjustedFrames, layerHits, events}, obstruction:{minVisibleFrac, framesHidden, framesOccluded,
maxUnseenSec, measuredFrames}, subjectMinVisibleFrac, subjectMaxUnseenSec, droppedFrames, grabbedFrames, realtime,
particleCull, environ, popInEvents, reveal, dof, faded, validation, flight, liveSubject, actor, recorder}`:
- `validation` = prepare's, verbatim; `flight` = prepare's check + `tracking: {frames, maxGapM, maxGapT, endGapM}`
  (how far the flown craft trailed its re-anchored nominal; `tracking` null on a locked replay); `flight` null for
  classic shots;
- `liveSubject` `{mode, rotate, frames, missingFrames, maxOffsetM, maxLagM, maxTurnDeg, refHeadingDeg}` (null without a
  live subject);
- `faded` `{entities, particles, statics, fallbackFrames}` (`fallbackFrames` = frames whose fade hid nothing and took
  the reroute bias instead);
- `environ` = the pre-roll AdminEnvirons fog wait `{checked, settled, waitedMs, polls, relit, timedOut, stalled,
  aborted, reason, state}` (rendered takes; ≤ 30 s);
- `realtime` (realtime takes, else null) `{wallSec, gridFrames, displayFrames, heldFrames, skippedDisplayFrames,
  undrawnDisplayFrames, backpressureFrames, tailFrames}`; `particleCull` `{recheckInterval, previous, restored}`
  (rendered takes with the seam).

Runtime modules (they receive deps; they never import stateful scene3d modules):
- `runtime/camera_owner.js` — owns `cameraSwitcher.persp` (never a new camera); per-instance wrap of
  `cameraSwitcher.positionCamera` (camDebug pattern, camera.js:1457); forces follow mode; writes
  `position = acToThree(pos)`, `quaternion = acQuatToThree(q)`, `fov` (+`updateProjectionMatrix` on change),
  `updateMatrixWorld(true)`; `camera.userData.csmFitFov` for fov > 75°; carries the film **viewer cell** via
  `sessionHandle.resolveViewerCell(prevEye, eye, 0.3, prevCell)` (sub-stepped for moves > 8 m) and publishes
  `scene3d.filmViewer = {cell}` (seed on cuts from the plan's cell); registers `liveScene3d.film = {preFrame(ts, dt),
  postRender(), holdLoop}`; on release restores `_prevEyeAc=null`, avatar opacity, followYaw/followPitch, deletes
  `filmViewer`. `parkCell()` → `{ok, parked, cell}` (called by `world.teleport` when idle): forgets the carried cell
  and any pending cut and deletes `filmViewer` while the camera stays owned, so cells.js follows the player-head walk
  while the next site loads; the next camera write re-seeds the cell (the plan cell after `setCutCell`, else the walk).
- `runtime/clean_frame.js` — §3.3.
- `runtime/film_clock.js` — film time; stepped frames via `liveScene3d.film.holdLoop = true` +
  `window.__renderOnce(tsMs)` with strictly increasing `tsMs = base + k·1000/fps` and an awaited post-render
  promise. Each `step()` publishes the frame time, then yields ONE animation frame (rAF; 50 ms setTimeout fallback;
  one MessageChannel task on a hidden page or with no rAF) BEFORE `__renderOnce(tsMs)`, so the client's rAF drivers
  (scenery wind, billboards, drains) advance once per film frame on the film clock; the first step's yield lets the
  pre-hold re-arm run, which parks on `holdLoop`, and the clock re-bases past it. During takes it installs
  `time_rng.setCurrentTime` (frame ts / 1000 for the wall-based particle modes; `_particleSimNowS` at begin + film
  elapsed under `?particleClock=sim`) + seeded `setRng`, `setFxTimeSource` / `setSceneryTimeSource` (the frame
  timestamp, ms), and the optional sky time (`timeOfDay`, `timeLapse` in game-days per film second); restores
  everything after. `end()` waits until `performance.now() > lastTs` (and past the film particle time under
  `?particleClock=sim`), clears `holdLoop`, and re-arms the loop with one bare `__renderOnce()` only when the realtime
  chain is dead (a step issued an explicit-ts render, or a realtime tick ran during the hold); otherwise the
  still-pending pre-hold re-arm resumes it (a second re-arm would run two rAF chains).
- `scene/world_query.js`, `scene/sensors.js`, `scene/particles_query.js`, `scene/terrain_corridor.js` — perception
  (SensorFrame §3.1). Budget ≤16 sweeps/frame round-robin; every value carries an age. world_query takes the
  injected static `catalogs` (§1.1: archetype + size, `dimsSource`) and resolves pilot fade keys of PLACED statics to
  live draws (`staticFadeTargets`; a scenery key resolves to nothing, §3.1). Indoors, the EnvCell list both the
  sensors and the safety reflex sweep defaults to world_query `renderSetCells(sh)`: a copy of `getViewerRenderSet()`
  (camera-rooted), else `getRenderSet(1)`; the sensors apply it when `ctx.indoor` and no `ctx.cellIds` (scout,
  pre-roll and take).
- `runtime/safety.js` — per frame after the pilot: sphere sweep prevEye→eye through all layers (radius ≥ near-plane
  corner distance at the shot fov + 0.05 skin), slide along hit normals, terrain floor (+0.7 m; never indoors),
  indoor `clipCameraToCellSpace` (cells: `ctx.cellIds`, else `renderSetCells(sh)`), near-lens particle hide via
  `emitter.filmHidden`. Reports `{adjusted, hits}`. `release()` runs BEFORE the take player restores its fades
  (reverse order of application).
- `runtime/take_player.js` — per frame: `nominal = traj.sample(progress)` → (live subject: re-anchor) → drone
  dynamics (drone/fpv families) → pilot residual (path-frame offsets; progress-rate scale) → safety →
  `camera_owner.write` → render → recorder grab. Records the realised table; `locked` replays a realised table without
  the pilot. Live subjects (§5.2 Take): the nominal is built against the pure reference track and re-anchored every
  frame to `take.liveSubject` — carry rigs (tags moving-subject, follow, body-rig, subject-is-camera) by translation
  plus travel-heading rotation, every other technique by re-aiming; a critically damped follower with velocity
  feed-forward eases server snaps in. A flown carry rig's craft is fed the full time derivative of the re-anchored
  pose (`liveDerivs`: reference travel + R_θ(nominal − reference travel) + the swing-rate θ̇ / θ̈ terms + the
  follower's ẋ / ẍ), and its swing round a turning subject speeds up only within amax − |subject acceleration| −
  1 m/s² per metre of the craft's radial error (`swingStep`, `LIVE_SUBJECT.swingRadialYield`): a turn sharper than the
  craft's amax freezes the swing until it is done. Pilot fades (`setpoint.fadeIds`): rig guids → `setFilmHidden`,
  particle keys → `emitter.filmHidden`, static placement keys → the statics seam (§4 items 4/7, SEAMS.md "Hides"),
  each restored exactly after the take; a reveal shot's own occluder is never faded, nor is a POINT subject's own body
  (take report `subjectBody`: the entities and fadeable placements whose footprint holds the subject's axis — the Life
  Stone a 1.2 m point subject is aimed at — resolved at the run's start; none for a point wider than 8 m, a guid,
  moving or path subject; the sensors count a ray it stops as seeing the subject); a fade that hides nothing takes
  the reroute bias that frame; the sensors see past what the take faded (`fadedIds`). Rendered takes run the particle
  cull with `recheckInterval: 1` (restored after) and first wait, for at most 30 s and only on the live loop (before the
  clock holds it), until an AdminEnvirons fog change has settled (report `environ`). **Realtime** takes run on
  requestAnimationFrame with the pipelined pilot but are RECORDED on the film grid: grid point n (film time n/fps) is
  grabbed from the first drawn display frame at wall time ≥ n/fps and stamped n/fps; a display frame covering several
  points is encoded once per point (held, `recorder.grab([t…])`), display frames between points are skipped, undrawn or
  backpressured points carry over to the next drawn frame, and points after the last display frame come from one final
  frame at the end pose — a constant-rate stream of ⌈wall·fps⌉ frames (the planned count at speed 1), `durationSec` =
  frames / fps, table rows at n/fps, counters in `report.realtime`.
- `runtime/recorder.js` — WebCodecs `VideoEncoder` (`avc1.640033`, `avc:{format:'annexb'}`; VP9 fallback raw
  frames for IVF in the CLI); `new VideoFrame(canvas, {timestamp, duration})` created **synchronously inside
  `postRender()`** (preserveDrawingBuffer is false); `grab(filmTimeSec | filmTimesSec[])` wraps the canvas once and
  encodes one re-stamped copy per extra time (`stats.heldFrames`); backpressure on `encodeQueueSize`; `frames`
  fallback = JPEG `canvas.toDataURL` in the same task.
- `runtime/look.js`, `runtime/world.js`, `runtime/jev_bridge_page.js` (§3.2).

### 3.1 SensorFrame
`{t, pose, speedMps, sectors:{far_left,left,center,right,far_right: {range, kind}}, freeAhead:{level, above, below},
sides:{left, right, up, down, back}, nearest:{range, kind, bearingDeg, elevDeg}, pathAhead:{ttc, kind},
subject:{visibleFrac, unseenSec, ndc:[x,y]|null, sizeRatio, occluderKind, occluderIds}|null, particles:{onLens:{family,
density}|null, inView:[{family, occludes, range}]}, limits:{canRise, canSink, roomLeft, roomRight, ceiling},
ages:{…}}` — ranges metres, `Infinity` = nothing within 25 m.
`subject.occluderIds` = what the pilot may fade: rig guids, particle keys, and the fade keys of PLACED statics
(LandBlockInfo stabs) `placement:<lbKey hex8>:object:<row>` — never the subject's own body (`ctx.subjectBodyIds`:
a subject ray it stops sees the subject). A static key appears only when world_query `describeHit`
names a placed tree or small prop unambiguously (candidates: the placements within 4 m of the hit):
- **Statics / building hits** (rays stop on the render bounds): the candidate whose axis is nearest relative to its
  radius (`staticHitScore` = axis distance ÷ radius), the hit inside its radius (score ≤ 1), no neighbour scoring
  within 0.25 of it (`STATIC_HIT_RULES`), and the placement a tree or a prop of KNOWN size (`dimsSource` not
  `'default'`) with max(radius, height/2) ≤ 2 m. Buildings never get a key.
- **Scenery hits** (procedural trees, bushes and rocks; rays stop on the physics colliders — trunk cylspheres and
  boulder spheres): NEVER a key in v1 (`FADEABLE_STATIC_SOURCES` = `['object']`). Limitation: the wasm CollisionHit
  carries only t / point / normal, no placement, and on real data geometry alone names the wrong placement — the main
  scenery boulder 0x02001065 (87 % of the collidable scenery rocks; two r 2.3 m spheres up to 1 m off its axis) handed
  its hits to a tree behind it, and multi-trunk trees (0x0200035F, 0x02000251, 0x020002DC) handed theirs to a
  neighbour, so fading that key read as a clear view while the real collider still blocked. `describeHit` only
  LABELS a scenery hit (kind + did, never a fade target): the placement whose axis is ABSOLUTELY nearest
  (`staticAxisDistance`) among those that could own the hit — within its plausible collider reach
  (`sceneryColliderReach`: the catalog collider when one is carried, else min(5.2 m tree / 2.1 m rock, max(1.35·r,
  r + 0.6 m)) × scale for model radius r, plus 0.3 m slack) and, with a usable hit normal, behind the hit along it
  (within 0.7 m × max(1, scale) of the inward normal line, `colliderSideFit`) — else the absolute-nearest axis
  (`SCENERY_HIT_RULES`). The sensors drop any id on a scenery-layer hit, so it is never in `occluderIds` and never
  seen through by `fadedIds`; `staticFadeTargets` resolves a scenery key to nothing. A procedural tree answered
  `fade` therefore reroutes (the mapper fallback below), exactly like a rock answered `reroute`.
  **v2:** exact scenery fades need a placement index on CollisionHit from the wasm scenery sweep (which scenery
  row's collider stopped the ray); the key would then name that row instead of a geometric guess.

Any other static occluder carries no id, so the mapper's reroute fallback applies (§2.14).
The sensor ctx accepts `fadedIds`: a subject ray stopped by an id the take has faded counts as clear.

### 3.2 JEV bridge (page ⇄ Node, key stays in Node)
The CLI exposes `window.__filmJev(json) → Promise<json>` with Playwright `page.exposeFunction` (connectOverCDP).
`jev_bridge_page.js`: `createPageBridge({timeoutMs}) → {available, request(payload) → Promise<{answers, usage, ms}>}`;
`available = typeof window.__filmJev === 'function'`; timeout 1.5 s realtime / 15 s stepped. No bridge → the pilot
runs `codePolicy`. The OpenRouter key NEVER enters the page.
**Wire envelope (frozen 2026-10-13 from `tools/film/lib/jev_broker.mjs`; the broker is the contract):** the page
calls `window.__filmJev(JSON.stringify({state, questions, seq}))` and the promise resolves to a JSON **string**
(the handler also accepts an already-structured object). Success: `{answers, usage:{inputTokens, outputTokens,
costUsd}, ms, seq, id, model}` — answers already normalised to the `codePolicy` shape (choice probabilities keyed by
option name, score probabilities keyed `"0".."n-1"`, `confidence` filled from probabilities when the API omits it; a
noul answer has only `{type:'noul', noul}`). Failure: `{error:{kind, message, retryable}, seq}` with `kind` ∈
`busy` (drop, retry next tick) | `disabled` | `budget` | `timeout` | `rate` | `server` | `network` | `too-large`
(payload > 48 KB; `seq` null) | `bad-request` | `bad-response` | `auth` | `credits` | `config` | `internal`. Any
failure ⇒ the pilot uses `codePolicy` for that tick (telemetry `source:'code'`). Never use integer-like choice
option keys (`"0"`, `"12"`): JS reorders them ascending and the conservative-first default is lost. The CLI sets the
broker's per-call limits: realtime `{timeoutMs:1200, maxRetries:0}`, stepped `{timeoutMs:4000, maxRetries:2}`.

### 3.3 Clean frame
Boot URL already carries `agent=1&hud=none&plugins=none` (canvas sizing latches at boot). At runtime: film CSS
(`cursor:none!important`, no canvas border, `image-rendering:auto`), deselect target + `selectionBracketLayer
.setDisplayOn(false)`, suppress speech bubbles for the take (wrap `entityManager.showSpeechBubble`, remove live
ones), nameplates off; input lock = `__inputFunnel.releaseHeld("film")` + `poison("gate")` + a window capture-phase
blocker (`stopImmediatePropagation` + `preventDefault`, wheel passive:false) for key*/pointer*/mouse*/click/
dblclick/auxclick/contextmenu/wheel/touch*/dragstart/drop, `cameraSwitcher._endFollowDrag?.()`, zero
`cameraSwitcher.keys`. `clean(false)` restores everything (unpoison, remove blockers, restore wrappers).

### 3.4 Readiness gate (`world.ready({lbKeys, interiorLb, settleSec=3, timeoutSec=90})`)
Passes when: the last `world.teleport` actually happened (portal entered, or `teleportGraceSec` = 8 s passed without
one); portal space inactive (`__isPortalSpaceActive() === false`); target LBs terrain baked + attached (a terrainGroup
mesh) + not parked (the interior landblock skips terrain unless `requireTerrainIndoors`); no
`terrain:|statics:|buildings:` keys in `_streamGuardState.inFlight`; `_pvsSweepIncomplete === false`; interiors:
`envCellLoadedLbs.has(lb)` and `__interiorBuildPending === false`; the player pose cell resolved (when the handle
exposes `getLocalPlayerPoseCellResolved`); scene-settle (terrainBakedLbs.size, staticsGroup.children.length,
cellContainers3d.size unchanged across 3×500 ms); then `settleSec`. Returns `{ok, checks:{teleport, portalSpace,
terrain, streamInFlight, pvsSweep, interior, player, settle, settleSec}, waitedMs, timedOut}`; never blocks past
`timeoutSec`.

---

## 4. Integration seams in existing files (orchestrator lane; each zero-cost when film is off)

1. `scene3d/index.js`: after `window.liveScene3d = liveScene3d` (~4531): `if (new URLSearchParams(window.location
   .search).get("filmMode") === "on") Promise.all([import("./film/index.js"), import("./particles/particle_manager.js")
   ]).then(([m, pm]) => m.installFilmMode({liveScene3d, THREE, sessionHandle: liveScene3d.sessionHandle, wasmExports:
   liveScene3d.wasmExports, particleCull: {setParticleCullConfig: pm.setParticleCullConfig, allParticleManagers:
   pm.allParticleManagers}})).catch(e => console.warn("[film] failed to load:", e))` (particle_manager.js is the SAME
   module instance entities.js / statics.js already load); `tick()`: `liveScene3dRef?.film?.preFrame?.(nowTs, dt)`
   right before `tickPerFrame`; `_postRenderStreamSlot()`: `liveScene3dRef?.film?.postRender?.()` first;
   `scheduleNext()`: `if (renderOnDemand || liveScene3dRef?.film?.holdLoop) return;`;
   `window.__renderOnce = (tsMs) => tick(Number.isFinite(tsMs) ? tsMs : performance.now())` (an explicit `tsMs`
   while `holdLoop` first cancels a pending re-arm).
2. `scene3d/cells.js` `updateViewerCell`: if `scene3d.filmViewer?.cell` is set, use it as the viewer cell (still
   `setViewerCell` + `publishViewerCell`).
3. `scene3d/entities.js`: `_filmHidden` term in `_applyEntityVisible`; `EntityManager.setFilmHidden(guid, on)`,
   `clearAllFilmHidden()`.
4. `scene3d/statics.js` `cullStaticsGroup`: honour `userData.__filmHidden` (set by the take player when the pilot
   fades a placed tree / prop placement node; SEAMS.md "Hides").
5. `scene3d/particles/particle_manager.js`: `allParticleManagers()`, `setParticleCullConfig({maxDistance,
   recheckInterval})` (returns previous), render-only `emitter.filmHidden` beside the cell-gate branch. Wired through
   item 1's `particleCull`: rendered takes (take_player) and scout stills set `recheckInterval: 1` and restore only the
   previous interval (maxDistance untouched); `particles_query` enumerates `managers: allParticleManagers`.
6. `scene3d/particles/particle_fx.js`: `setFxTimeSource(fn|null)` used by `particleFxFrame()` when `nowMs` is not
   finite; uniform `uFxNearFadeMin` floor (`nearFade = max(row, uFxNearFadeMin)`, uniform-only).
7. `scene3d/animated_scenery.js`: `setSceneryTimeSource(fn|null)` consulted by `_nowMs()`.
8. `scene3d/atmosphere_pipeline.js`: `?filmDof=on` builds a `DepthOfFieldEffect` once at construction (legacy list
   after horizonDissolve; split chain before fxGlow/bloom); `window.__dof {target, focusDistance, focusRange,
   bokehScale, enabled}`.
9. `docs/url-flags.md`: 6-column main-table rows for `filmMode` and `filmDof` (Default `off`, reader `=== "on"`),
   plus blockquoted §0 rows; rows for any new param a film driver emits.
10. `harness/run-js-headless.mjs`: TIER5 rows `{tier:5, flag:"filmMode(<topic>)", file:"tests/film_<topic>.test.mjs"}`.

## 5. Node tooling (`tools/film/`, ESM `.mjs`, Node 20)
CLI `tools/film/film.mjs` (`#!/usr/bin/env node`, WHY/WHAT/USAGE header, hand-rolled `--key=value` args, exported
`main()` behind the pathToFileURL main-guard, exit 0 ok / 1 finding / 2 usage-or-env):
`doctor`, `project init`, `techniques`, `song analyze`, `sites build|search|show`, `plan validate|compile`,
`jev ping|decide|task`, `browser check`, `boot`, `status`, `go`, `scout`, `rehearse`, `shoot`, `assemble`,
`contact-sheet`, `run` (authoritative usage: `node tools/film/film.mjs <cmd> --help`).
- JEV key: env `OPENROUTER_API_KEY` (fallback `OPENROUTER_KEY`, then `~/.config/holtburger-film/openrouter.key`,
  must be mode 600). Never logged, never sent to the page. Budget caps (`--jev-max-usd-per-hour`, default 2.00;
  `--jev-max-calls-per-min`, default 600).
- Browser: `playwright-core` `chromium.connectOverCDP(--cdp, default http://127.0.0.1:9333)`; Chrome-driving
  commands take `harness/lib/heavy_lock.mjs` `acquireHeavyLock({label})`; never launch a browser on the laptop.
- Output: project dirs default `/mnt/wbterminal2/film-projects/<name>/`; ffmpeg `/home/wbterminal/bin/ffmpeg`
  (override `--ffmpeg`/`FILM_FFMPEG`).

## 5.1 Owner decisions (2026-10-13 — binding)
- Film account: `phase4demo` (ACE accessLevel 5 = Admin; verified). The CLI defaults `--account=phase4demo`; the
  password is a run-time input only — never in docs, plans, logs or commits. Prefer env `FILM_PASSWORD`: a
  `--password=` argument is visible in `ps` / `/proc/<pid>/cmdline` while the command runs (the CLI never writes it;
  the heavy-lock record gets `--password=[redacted]`).
- **Depth of field ships in v1**: seam §4.8 (`?filmDof=on`) is required, the CLI `boot` URL always adds
  `filmDof=on`, `classic.rack-focus` must visibly pull focus (runtime drives `window.__dof` from the Pose `focus`
  channel; `look.dof` sets range/bokeh). The flag stays default-OFF for normal play.
- Gazetteer home: `/mnt/wbterminal2/film-projects/_gazetteer/`; 2021 acpedia lore is acceptable.
- Scenery bake: the shipped default (ace-compat) for now; the owner handles any retail promotion separately. Film
  reads obstruction data from whatever
  bake the client loaded, so code must not assume either.

## 5.2 Plan JSON v1, Timeline v1 and the Take object (frozen 2026-10-13 from `tools/film/plan/`)
The plan lane's code is the contract; full field reference = `PLAN_FIELDS` + `examplePlan()` in
`tools/film/plan/schema.mjs`, Timeline/Take = the header of `tools/film/plan/compile.mjs`.
- **Plan** (`validatePlan(plan, {registry, dryBuild})`, `normalizePlan(plan, {registry})`): `{version:1, title,
  kind?, format:{width=1920, height=1080, fps=30, capture='stepped'}, song?:{file?, analysis?, offsetSec=0},
  defaults?:{transition='cut', pilot:{mode='jev'}, look, framing?, ease?}, edit?:{fadeInSec, fadeOutSec},
  sites:[{id, name?, gazetteerId?, teleport:'@…', anchor:[x,y,z] | {cell, local}, cell?, indoor?, lbKeys?,
  interiorLb?, settleSec=0, ready:{settleSec=3, timeoutSec=90}, look?}], shots:[{id, site, technique,
  duration:{sec}|{beats}|{bars}, start?, params?, framing?, subject?, path?, route?, fov?, roll?, ease?, seed?,
  bounds?, transition? (INTO this shot), standingOrder (≤300 chars), pilot?, capture?, actor?, look?, cell?, lyric?,
  notes?}]}`. Subject kinds: `{kind:'point', pos, radius?, height?, heading?}` | `{kind:'entity', ref, moving=false,
  radius?, height?}` | `{kind:'player', moving?}` (normalized `moving: true` when the shot's actor walks —
  `actor.moveTo` / `actor.moves`; explicit wins) | `{kind:'path', points}`.
  `bounds` = §2.11 `ShotSpec.bounds` (partial `{maxLateral, maxRise, maxSink ≥ 0 m; minSpeedScale ∈ [0,1];
  maxSpeedScale ≥ 1; maxDistanceScale ≥ 1}`, keys/ranges of §2.9 `normalizeBounds`; missing keys = the technique's
  defaultBounds), default null. `capture.mode` default: explicit wins; else 'realtime' (`auto:true`) for a moving
  actor / `moving` entity or player, or — with the registry — a technique whose capture hint (`def.capture`,
  = `meta.capture`) is 'realtime' following an entity/player subject (the same hint on a point subject stays stepped
  and WARNS); else `format.capture`. `look.dof` follows the `window.__dof` setters (§4 item 8): focusDistance /
  bokehScale ≥ 0, focusRange > 0, `enabled` boolean, `target` THREE-world xyz | null. `dryBuild` builds each `{sec}`
  shot offline with a page-shaped ctx: a shot with a `route` gets `ctx.indoor.route` = a synthetic 2-leg L through
  the anchor (`DRY_ROUTE_LEG_M`), an indoor site `ctx.indoor = {}`; failures are warnings.
- **Timeline** (`compilePlan(plan, {song, registry})`): `{version:1, fps, width, height, duration, frames, song,
  fadeIn, fadeOut, items:[{shotId, siteId, editIn, editOut, editDuration, takeDuration, takeFrames, handleIn,
  handleOut, transitionIn, preRollSec, technique, family, captureMode, section, lyric, take, …}], schedule:[{siteId,
  teleport, anchor, cell, indoor, ready:{lbKeys (uint32), interiorLb, settleSec, timeoutSec}, prewarm:{points,
  radius}, shots:[ids], takeSec}], warnings:[{path, message}]}`. Cuts land on the song grid. A `{bars}` shot that
  starts on a downbeat, or within half a beat of one (`COMPILE_DEFAULTS.barLineTolBeats`), counts its bars from that
  downbeat, so a `song.offsetSec` copied to one decimal from `song analyze` still cuts on bar k + n. A shot that
  starts more than half a beat before the first downbeat (the pickup), or that opens the edit further than that
  inside a bar, counts its bars from the next downbeat, so the pickup joins it and the cut is a downbeat.
- **Take** = `item.take`, the exact argument of `window.__film.prepare(take)` (the page MUST accept this shape; a
  baked table `{table}` replay is the other accepted form): `{shotId, siteId, technique, family, spec (§2.11
  ShotSpec, spec.duration = takeDuration INCLUDING handles; spec.bounds = the shot's non-null `bounds` keys, absent
  when none), subject (plan subject above — the page resolves it:
  point → static ctx.subject; entity → worldQuery.subject(ref) + subjectAt(t) when moving; player → local player
  + subjectAt(t) when moving (its actor walks, or the take captures realtime; an explicit `moving: false` keeps it
  static); path → ctx.path), path, route:{fromCell, toCell}|null
  (indoor: planIndoorPath → ctx.indoor.route), standingOrder, goal, pilot:{mode,…}, capture:{mode, fps, width,
  height}, look (merged defaults ← site ← shot; applied by look.js before the take), actor (cue for world.actor),
  cell (seed of the film viewer cell on indoor sites), indoor, anchor (ShotContext.anchor), editOffsetSec
  (= handleIn), preRollSec (rendered, never recorded), showAvatar}`.
  **Live subjects.** A moving entity (`moving: true`) or a live player (`moving: true`, or — unless `moving: false` —
  an actor cue that walks or `capture.mode` 'realtime') gets a PURE reference `ctx.subject` / `ctx.subjectAt`: the
  prepare-time pose, extrapolated horizontally by its velocity when that is ≥ 0.3 m/s (else standing). Its live,
  t-ignoring function goes separately to the take player as `take.liveSubject`, which re-anchors the nominal every
  frame: carry rigs (tags moving-subject, follow, body-rig, subject-is-camera) by translation plus travel-heading
  rotation, all other techniques by re-aiming (prepare summary / take report `liveSubject`). **Pre-roll rule:** the
  pre-roll (reference held at p = 0) and frame 0 (still p = 0) settle the live-offset follower with offset velocity =
  the subject's velocity measured over the pre-roll MINUS the reference track's own velocity, so a subject that keeps
  walking through the pre-roll — at the reference heading or off it — gives no surge or drop-back at the take start,
  and one that stopped keeps the camera at rest; a flown live take re-sets the craft on the re-anchored start pose at
  frame 0; a subject that starts walking exactly at frame 0 is followed with the rig's normal (amax-limited) step
  response. **Flown carry rigs** feed the craft the full time derivative of the re-anchored pose as feed-forward:
  reference travel + R_θ(nominal − reference travel) + the swing-rate terms + the follower's ẋ / ẍ (so the frame-0
  reset and every step are exact for a subject walking off the reference heading). A flown swing round a turning
  subject only speeds up within amax − |subject acceleration| − 1 m/s² per metre of the craft's radial error; a turn
  sharper than the craft's amax freezes the swing until it is done. That is the craft's physical floor, measured with
  a 3 m/s subject turning at 90°/s (24 / 30 / 60 fps alike): on the cinema preset (amax 4 m/s²) a quarter turn keeps
  the camera–subject distance of drone.chase / lead / side-track within about ±15 % (0.86–1.14×; side-track turning
  one way reaches 1.155×, 0.5 % past the band) with the craft < 2 m off its re-anchored nominal, but a 180° U-turn
  takes chase down to 0.74× and lead up to 1.28× (26–28 % off; side-track 0.87–1.04×) with the craft 2.2–2.3 m
  behind; the heavy preset (amax 2.5 m/s²) leaves the band on a quarter turn (0.76–1.31×, 3.0–3.3 m behind). A
  realised gap above 2 m raises the CLI's `tracking-gap` warning (it names the live subject's turn for a carry rig):
  that is the signal to shoot again with a gentler move — a slower or wider subject turn, no U-turn under a chase /
  lead / side-track, the cinema preset rather than heavy — since a retake of the same plan repeats it. `ctx.sun` is
  set outdoors from the live sky (none indoors or at night).
  **Look:** a fog change is waited out before recording (≤ 30 s on the live loop, before the clock holds it; take
  report `environ`); re-applying the fog already showing is a no-op (`changed:false`); the retail fog roll-in stays on
  (the film never uses `?environRetail=off`, which snaps the fog on).
- CLI walk: per schedule entry teleport → `world.ready(entry.ready)` → `world.prewarm(entry.prewarm)` → per shot
  [hop] → `prepare(item.take)` → [`rehearse`] → `shoot({fps, width, height, codec, bitrate, mode: item.captureMode})`.
  Hop (`--hop`, default 40 m, 0 = off): an OUTDOOR shot without actor cues or a visible avatar whose camera path —
  built offline with the technique registry, its horizontal centroid (`standPointOf`) — lies farther than that from
  the player (`query.subject('player')`) moves it there between takes: settle → `@teleloc` at `query.groundZ` +
  0.5 m → `world.ready` again (best-effort: a failure warns; shoot-log `event:'hop'`, report `hop`).
  Before each teleport the CLI checks `__film.status()` and aborts any running take; after a failed take it calls
  `__film.abort()` and waits for an idle page. While it waits it polls `__film.status()` and RE-SENDS `__film.abort()`
  on every poll that still finds the page busy (at most `PAGE_ABORT_MAX` = 30, never after the ≈ 90 s idle wait):
  an abort that lands while index.js has `busy='shoot'` but the take player has no run yet is a no-op. A page that
  will not go idle is never teleported (the remaining shots fail at stage 'busy'). `world.prewarm` is best-effort (a
  warning, a `stage:'prewarm'` shoot-log row and a report note). A rehearsal always uses the stepped broker limits;
  a failed retake keeps the earlier attempt (`failedAttempts`). The page's validation / flight-check issues (prepare
  summary `validation.issues` incl. `overspeed` with `minDurationSec`, `flight`, `warnings`, and the same blocks on the
  rehearse result and take report) are surfaced by the CLI: one warning per issue per shot, and `issues` in
  reports/<shot>.json, every shoot-log.jsonl row, <shot>.rehearsal.json and the keepOrRetake input (`judgeInput`),
  keeping `limitedBy`, `minDurationSec`, `minDurationVerified` (null = not verified) and the dry-flown `maxGapM`.
  The CLI adds its own `tracking-gap` issue (t = `maxGapT`; `maxGapM` = the REALISED gap) when a flown rehearsal or
  take's `flight.tracking` trailed the plan by more than `FLIGHT_GAP_WARN_M` = 2 m, with or without an `overspeed`
  — one warning per run whose gap differs (rehearsal, take, each retake). They never fail or retake a take.

## 6. Rules for every implementer
- Parallel agents may read, edit and run TARGETED single tests only (`node test_x.mjs`). They must NOT run the full
  JS gate, cargo, wasm-pack or browsers. The orchestrator runs the full gate and builds ONCE, after merging, one at
  a time.
- No Anthropic API, no `@anthropic-ai/*`, no Anthropic keys anywhere. JEV only from Node.
- Pure modules: no `window`/`document`/`three`/wasm; deterministic. Page modules: deps injected; typeof-guard wasm.
- No `console.error` in normal operation (console allowlist); page logging via an injected `log` or `[film]`
  `console.warn` only for genuine faults.
- Flag readers exact-match `=== "on"` on the same line as `.get(...)`.
- Tests: `tests/film_<topic>.test.mjs`, `node:assert/strict`, local `check(name, fn)`, final
  `<suite>: N passed, M failed` + non-zero exit on failure, header comment (WHY, flag, DEFAULT OFF, `Run:`), must
  EXECUTE film code (no source-text pinning), no SKIP banners.
- Never touch `~/ace-server`; never start browsers/servers; never push or arm background git automation.

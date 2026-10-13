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
  outdoors and inside the player's landblock for dungeons.
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
| `scene3d/film/scene/` | perception & planning: `solver.js`, `dungeon_route.js`, `los.js` (pure, injected handle); `world_query.js`, `sensors.js`, `particles_query.js`, `terrain_corridor.js` (page adapters, injected deps) | page (+tests with fakes) |
| `scene3d/film/runtime/` | camera owner, clean frame, film clock, take player, safety, recorder, look, world, JEV page bridge | page |
| `scene3d/film/index.js` | `installFilmMode(deps)` → `window.__film` | page |
| `scene3d/film/flags.js` | `filmModeEnabled(search)`, `filmDofEnabled(search)` (exact `=== "on"`, memoised, injectable, `_set…ForTest`) | page |
| `tools/film/` | Node-only: CLI `film.mjs`, `lib/` (cdp, jev, broker, session, shoot, ffmpeg, project), `audio/` (song DSP), `plan/` (schema/compile/edl), `sites/` (gazetteer), `data/concept_lexicon.json` | Node |
| `tests/film_<topic>.test.mjs` | node:assert/strict suites, registered in TIER5 of `harness/run-js-headless.mjs` | gate |
| `$REPO/.claude/skills/film-mode/SKILL.md`, `$REPO/.claude/agents/film-director.md` | Claude Code packaging (canonical; symlinked into `~/.claude/` by `tools/film/install-claude.sh`) | Claude Code |

Page modules MUST NOT import stateful scene3d modules (`terrain.js`, `statics.js`, `buildings.js`, `entities.js`,
`cells.js`, `index.js`, `camera.js`, `landblock_lru.js`, `particle_manager.js`) — dependencies arrive through
`installFilmMode({liveScene3d, THREE, sessionHandle, wasmExports, ...})` or `window.liveScene3d`. Importing
dependency-free modules is fine: `../projectile_sweep.js`, `../pick_math.js`, `../camera_math.js`,
`../particles/time_rng.js`, `../particles/owner_registry.js`, `../../rynth/indoor_router.js`,
`../../rynth/nav_frame.js`. No new file-backed `Worker`s (build-shell WORKER_ENTRIES).

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
`time-lapse`/`hyperlapse*` set `meta.timeLapse = {rate}` (sky time advanced by the runtime);
`rack-focus` writes the `focus` channel.

### 2.13 `drone/flight_model.js`
`DRONE_PRESETS = {cinema, heavy, fpv, indoor}`; `createDrone(presetOrConfig) → {reset(pose), step(targetPose, dt)
→ Pose, state()}` — jerk/accel/velocity-limited critically damped tracking; body attitude from acceleration (bank ∝
lateral accel, pitch ∝ forward accel, ≤ maxTiltDeg); camera = stabilised gimbal (lagged target orientation, pitch
limits [−90°, +30°]) or FPV hard mount (body attitude + uptilt). `wind:{gustMps, seed}`.
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
- `scene_state.js` — `buildPilotState(sensorFrame, {standingOrder, technique, goal, current}) → state` (words only
  + the standing-order sentence): `{standing_order, shot:{technique, goal}, camera:{speed},
  obstacles:{far_left, left, ahead, right, far_right, above, below, left_side, right_side, behind} ("<range> <kind>"
  or "clear"), free_space:{level_ahead, above_ahead, below_ahead}, nearest:{kind, range, side},
  path_ahead:{contact_in, blocker}, subject:{visibility, unseen_for, in_frame, size, occluded_by},
  particles:{on_lens, in_view}, limits:{can_rise, can_sink, room_left, room_right, ceiling},
  current:{maneuver, since}}`.
- `questions.js` — `PILOT_QUESTIONS` (Decisions-API `questions` object) and `questionsFor({hasSubject})`:
  `maneuver` (choice, conservative default first): `hold_path`, `drift_left`, `drift_right`, `rise`, `sink`,
  `slow_down`, `back_off`; `risk` (score, 3 levels: open / tight but manageable / about to hit); `subject_lost`
  (noul with explicit true/false criteria); `occluder_action` (choice): `ignore`, `fade`, `reroute`, `wait`;
  `framing` (choice): `keep`, `recenter`, `widen`, `tighten`. Criteria quote the state's exact words and
  WORD_BOUNDS (e.g. `rise` only when `free_space.above_ahead` is ≥ 2 buckets farther than `free_space.level_ahead`
  AND `limits.can_rise` is "yes" — the jev-drone lesson: vertical info + ceiling must be in state).
- `policy_code.js` — `codePolicy(sensorFrame, state) → answers` in the **exact Decisions-API answer shape**
  (`{maneuver:{type:'choice', choice, confidence, probabilities}, risk:{type:'score', score, confidence,
  probabilities}, subject_lost:{type:'noul', noul}, ...}`): no-key fallback, test mock, shadow-agreement metric.
- `fingerprint.js` — `sceneFingerprint(state) → string` (stable stringify of words, minus `current`).
- `mapper.js` — `createResidualMapper({bounds, commitSec=1.0, overrideRisk=1.6, staleSec=0.6,
  minConfidence=0.45}) → {apply(answers, {sceneTime, now, sensorFrame}) → Setpoint, current(), reset()}`;
  **Setpoint** `{lateral (m, +right), vertical (m, +up), speedScale, distanceScale, framing:{dh,dp,dfovDeg},
  fadeIds:[], reroute:boolean, maneuver, source}`. Commit window; low-confidence answers decay toward neutral;
  stale answers ignored and can never increase descent; offsets clamp to bounds.
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
  JEV choice criteria). `intent = {framing, angle:'eye'|'high'|'low'|'top', side?, light?:'front'|'back'|'rim',
  minClearance, maxOcclusion}`.
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

`scene3d/film/index.js` exports `installFilmMode({liveScene3d, THREE, sessionHandle, wasmExports, log}) → api` and
installs `window.__film`. Every method is JSON-in / JSON-out (async where noted) and returns `{ok:false, error}`
instead of throwing.

| Method | Purpose |
|---|---|
| `status()` | `{ok, version, active, cameraOwned, clean, take, recorder, pilot, clock, flags}` |
| `clean(on=true)` | strip HUD/DOM/overlays/brackets/bubbles/cursor; lock input; `false` restores |
| `own()` / `release()` | take/return the camera |
| `pose(poseJson)` | set an absolute AC-frame pose now |
| `world.teleport(cmd)` | `sessionHandle.sendChat(cmd)` (commands must start with `@`) |
| `world.ready(opts)` | async readiness gate report (§3.4) |
| `world.prewarm({points, radius})` | async: collision populate + heightmap corridor + statics/buildings/envcells for those LBs |
| `world.avatar(visible)` | hide/show the local player (film-hide term, shadows included) |
| `world.look(lookJson)` / `world.restoreLook()` | time of day, DayGroup, fog, exposure, grade, DoF |
| `world.actor(cueJson)` | emote / motion / face heading / move-to for the player-as-actor (realtime shots) |
| `query.subject(ref)`, `query.near({center, radius, kinds})`, `query.groundZ(x,y)` | live scene queries |
| `techniques()` | technique catalog |
| `scout(shotJson, {count, stills, width})` | async: candidates + metrics (+ JPEG data URLs when `stills`) |
| `prepare(takeJson)` | build trajectory (technique spec or baked table), reset pilot/drone/safety |
| `rehearse({fps})` | async: run the take stepped without capture → realised table + pilot telemetry |
| `shoot({fps, width, height, codec, bitrate, mode, locked})` | async: record the take → take report |
| `recorder.drain({maxBytes})` | `{chunks:[{seq, b64, timestampUs, key}], done, stats}` |

Runtime modules (they receive deps; they never import stateful scene3d modules):
- `runtime/camera_owner.js` — owns `cameraSwitcher.persp` (never a new camera); per-instance wrap of
  `cameraSwitcher.positionCamera` (camDebug pattern, camera.js:1457); forces follow mode; writes
  `position = acToThree(pos)`, `quaternion = acQuatToThree(q)`, `fov` (+`updateProjectionMatrix` on change),
  `updateMatrixWorld(true)`; `camera.userData.csmFitFov` for fov > 75°; carries the film **viewer cell** via
  `sessionHandle.resolveViewerCell(prevEye, eye, 0.3, prevCell)` (sub-stepped for moves > 8 m) and publishes
  `scene3d.filmViewer = {cell}` (seed on cuts from the plan's cell); registers `liveScene3d.film = {preFrame(ts, dt),
  postRender(), holdLoop}`; on release restores `_prevEyeAc=null`, avatar opacity, followYaw/followPitch, deletes
  `filmViewer`.
- `runtime/clean_frame.js` — §3.3.
- `runtime/film_clock.js` — film time; stepped frames via `liveScene3d.film.holdLoop = true` +
  `window.__renderOnce(tsMs)` with strictly increasing `tsMs = base + k·1000/fps` and an awaited post-render
  promise; during takes installs `time_rng.setCurrentTime(() => filmMs/1000)` + seeded `setRng`,
  `setFxTimeSource(() => filmMs)`, `setSceneryTimeSource(() => filmMs)`; restores everything after; resumes the loop
  only once `performance.now() > lastTs`.
- `scene/world_query.js`, `scene/sensors.js`, `scene/particles_query.js`, `scene/terrain_corridor.js` — perception
  (SensorFrame §3.1). Budget ≤16 sweeps/frame round-robin; every value carries an age.
- `runtime/safety.js` — per frame after the pilot: sphere sweep prevEye→eye through all layers (radius ≥ near-plane
  corner distance at the shot fov + 0.05 skin), slide along hit normals, terrain floor (+0.7 m; never indoors),
  indoor `clipCameraToCellSpace`, near-lens particle hide via `emitter.filmHidden`. Reports `{adjusted, hits}`.
- `runtime/take_player.js` — per frame: `nominal = traj.sample(progress)` → drone dynamics (drone/fpv families) →
  pilot residual (path-frame offsets; progress-rate scale) → safety → `camera_owner.write` → render → recorder grab.
  Records the realised table; `locked` replays a realised table without the pilot.
- `runtime/recorder.js` — WebCodecs `VideoEncoder` (`avc1.640033`, `avc:{format:'annexb'}`; VP9 fallback raw
  frames for IVF in the CLI); `new VideoFrame(canvas, {timestamp, duration})` created **synchronously inside
  `postRender()`** (preserveDrawingBuffer is false); backpressure on `encodeQueueSize`; `frames` fallback = JPEG
  `canvas.toDataURL` in the same task.
- `runtime/look.js`, `runtime/world.js`, `runtime/jev_bridge_page.js` (§3.2).

### 3.1 SensorFrame
`{t, pose, speedMps, sectors:{far_left,left,center,right,far_right: {range, kind}}, freeAhead:{level, above, below},
sides:{left, right, up, down, back}, nearest:{range, kind, bearingDeg, elevDeg}, pathAhead:{ttc, kind},
subject:{visibleFrac, unseenSec, ndc:[x,y]|null, sizeRatio, occluderKind}|null, particles:{onLens:{family,
density}|null, inView:[{family, occludes, range}]}, limits:{canRise, canSink, roomLeft, roomRight, ceiling},
ages:{…}}` — ranges metres, `Infinity` = nothing within 25 m.

### 3.2 JEV bridge (page ⇄ Node, key stays in Node)
The CLI exposes `window.__filmJev(json) → Promise<json>` with Playwright `page.exposeFunction` (connectOverCDP).
`jev_bridge_page.js`: `createPageBridge({timeoutMs}) → {available, request(payload) → Promise<{answers, usage, ms}>}`;
`available = typeof window.__filmJev === 'function'`; timeout 1.5 s realtime / 15 s stepped. No bridge → the pilot
runs `codePolicy`. The OpenRouter key NEVER enters the page.

### 3.3 Clean frame
Boot URL already carries `agent=1&hud=none&plugins=none` (canvas sizing latches at boot). At runtime: film CSS
(`cursor:none!important`, no canvas border, `image-rendering:auto`), deselect target + `selectionBracketLayer
.setDisplayOn(false)`, suppress speech bubbles for the take (wrap `entityManager.showSpeechBubble`, remove live
ones), nameplates off; input lock = `__inputFunnel.releaseHeld("film")` + `poison("gate")` + a window capture-phase
blocker (`stopImmediatePropagation` + `preventDefault`, wheel passive:false) for key*/pointer*/mouse*/click/
dblclick/auxclick/contextmenu/wheel/touch*/dragstart/drop, `cameraSwitcher._endFollowDrag?.()`, zero
`cameraSwitcher.keys`. `clean(false)` restores everything (unpoison, remove blockers, restore wrappers).

### 3.4 Readiness gate (`world.ready({lbKeys, interiorLb, settleSec=3, timeoutSec=90})`)
Passes when: portal space inactive (`__isPortalSpaceActive() === false`); target LBs terrain baked + attached + not
parked; no `terrain:|statics:|buildings:` keys in `_streamGuardState.inFlight`; `_pvsSweepIncomplete === false`;
interiors: `envCellLoadedLbs.has(lb)` and `__interiorBuildPending === false`; scene-settle (terrainBakedLbs.size,
staticsGroup.children.length, cellContainers3d.size unchanged across 3×500 ms); then `settleSec`. Returns
`{ok, checks:{…each sub-check…}, waitedMs}`; never blocks past `timeoutSec`.

---

## 4. Integration seams in existing files (orchestrator lane; each zero-cost when film is off)

1. `scene3d/index.js`: after `window.liveScene3d = liveScene3d` (~4420): `if (filmModeEnabled()) import("./film/
   index.js").then(m => m.installFilmMode({liveScene3d, THREE, sessionHandle, wasmExports})).catch(e =>
   console.warn("[film] failed to load:", e))`; `tick()`: `liveScene3dRef?.film?.preFrame?.(nowTs, dt)` right
   before `tickPerFrame`; `_postRenderStreamSlot()`: `liveScene3dRef?.film?.postRender?.()` first;
   `scheduleNext()`: `if (renderOnDemand || liveScene3dRef?.film?.holdLoop) return;`;
   `window.__renderOnce = (tsMs) => tick(Number.isFinite(tsMs) ? tsMs : performance.now())`.
2. `scene3d/cells.js` `updateViewerCell`: if `scene3d.filmViewer?.cell` is set, use it as the viewer cell (still
   `setViewerCell` + `publishViewerCell`).
3. `scene3d/entities.js`: `_filmHidden` term in `_applyEntityVisible`; `EntityManager.setFilmHidden(guid, on)`,
   `clearAllFilmHidden()`.
4. `scene3d/statics.js` `cullStaticsGroup`: honour `userData.__filmHidden`.
5. `scene3d/particles/particle_manager.js`: `allParticleManagers()`, `setParticleCullConfig({maxDistance,
   recheckInterval})` (returns previous), render-only `emitter.filmHidden` beside the cell-gate branch.
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
`doctor`, `techniques`, `song analyze`, `sites build|search|show`, `plan validate|compile`, `jev ping|decide`,
`browser check`, `go`, `scout`, `rehearse`, `shoot`, `assemble`, `contact-sheet`, `run`.
- JEV key: env `OPENROUTER_API_KEY` (fallback `OPENROUTER_KEY`, then `~/.config/holtburger-film/openrouter.key`,
  must be mode 600). Never logged, never sent to the page. Budget caps (`--jev-max-usd-per-hour`, default 2.00;
  `--jev-max-calls-per-min`, default 600).
- Browser: `playwright-core` `chromium.connectOverCDP(--cdp, default http://127.0.0.1:9333)`; Chrome-driving
  commands take `harness/lib/heavy_lock.mjs` `acquireHeavyLock({label})`; never launch a browser on the laptop.
- Output: project dirs default `/mnt/wbterminal2/film-projects/<name>/`; ffmpeg `/home/wbterminal/bin/ffmpeg`
  (override `--ffmpeg`/`FILM_FFMPEG`).

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

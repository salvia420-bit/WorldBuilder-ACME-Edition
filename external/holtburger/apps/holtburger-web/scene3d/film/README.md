# scene3d/film — AC Film Mode (developer README)

Agentic cinematography for holtburger-web, **default OFF** (`?filmMode=on`, exact match). A Claude Code session (the
owner's subscription — no Anthropic API anywhere in this code) is the **director**: it turns a script or a song into
`plan.json`, picks sites, teleports the hidden player and drives the page over CDP with the Node CLI
`tools/film/film.mjs`. **JEV** (TypeSafe's System-One decision model on OpenRouter — the only metered API, its key
only in Node) is the camera's **reflexes** during a take; a code safety clamp always wins. Footage is captured on
the owner's GTX-1070 box, off-screen and muted, stepped on a film clock and encoded in-page with WebCodecs, HUD-free.

- Contracts (frozen, single source of truth): [`SPEC.md`](SPEC.md). Seam behaviour notes: [`runtime/SEAMS.md`](runtime/SEAMS.md).
- Director packaging: `$REPO/.claude/skills/film-mode/` (skill + `reference/`) and `$REPO/.claude/agents/film-director.md`,
  symlinked into `~/.claude/` by `tools/film/install-claude.sh` (the owner runs it; `--dry-run`, `--uninstall`).
- Background: `docs/HANDOFF-film-mode-2026-10-13.md`, `docs/film-mode-2026-10-13/{research_jev.md, recon/}`.

## Architecture

| Layer | Who | Rate | Code |
|---|---|---|---|
| Director (System Two) | Claude Code (`film-director` agent / `film-mode` skill) | between takes | `$REPO/.claude/…`, drives `tools/film/film.mjs` |
| Pilot (System One) | JEV `typesafe/jev-1.13`, OpenRouter `POST /api/alpha/decisions` | ≈ 3–8 decisions/s, only when needed | `pilot/*` (page) ⇄ `runtime/jev_bridge_page.js` ⇄ `window.__filmJev` ⇄ `tools/film/lib/jev_broker.mjs` → `jev.mjs` |
| Reflexes + flight | page code | every frame | `runtime/take_player.js`: trajectory → `drone/flight_model.js` → pilot residual → `runtime/safety.js` → `runtime/camera_owner.js` → render → `runtime/recorder.js` |
| Perception | page code | ≈ 10–20 Hz, ≤ 16 sweeps/frame | `scene/{world_query,sensors,los,particles_query,terrain_corridor}.js` → SensorFrame → `pilot/sense_words.js` words |
| Planning (pure) | page + Node | per shot | `shots/*` (63 techniques), `scene/{solver,dungeon_route}.js`, `core/*` |
| Tooling (Node) | the CLI | per command | `tools/film/{film.mjs, lib, plan, audio, sites, data}` |

Per stepped frame k (film time k/fps; the normal loop is held): `traj.sample(progress)` (re-anchored to a live
subject) → drone dynamics (drone/fpv) → pilot setpoint (awaited when a decision is due) → safety clamp →
`camera_owner.write` in `liveScene3d.film.preFrame` (before `tickPerFrame`, so culling/viewer cell/CSM see this
frame's pose) → one animation-frame yield in `film_clock.step()` (rAF-paced scenery wind / billboards / drains advance
on the film clock) → `window.__renderOnce(tsMs)` → `postRender` grabs `new VideoFrame(canvas)` in the same task →
encode. Realtime takes (server-driven moving subjects) run on requestAnimationFrame with the pipelined pilot instead,
but are RECORDED on the film grid: grid point n is the first drawn display frame at wall t ≥ n/fps, stamped n/fps. A
display frame covering several points is encoded once per point (held, `recorder.grab([t…])`); display frames between
points are skipped; undrawn or backpressured points carry over to the next drawn frame; points after the last frame
come from one final frame at the end pose. Every take is therefore a constant-rate stream of ⌈wall·fps⌉ frames (the
planned count at speed 1) that the CLI muxes with `-r fps`, and `report.realtime` holds the counters.
Moving subjects (an entity with `moving: true`, the walking or realtime-captured player) are no longer frozen at their
prepare-time pose: the shot is built against a pure reference track and the take re-anchors the nominal to the live
subject every frame (SPEC §5.2). `ShotContext.sun` is provided outdoors from the live sky (none indoors / at night),
so the solver's light intents (`front` / `back` / `rim`) work; scout warns when it cannot honour one.

Frames and units (SPEC §1): AC world metres `[x east, y north, z up]`, compass heading (CW from north), pitch
[−π/2, π/2], quaternions `[w,x,y,z]` in the AC frame; three mapping `acToThree = [x, z, −y]`, `q3 = qM·q·qM⁻¹`.
Page modules never import stateful scene3d modules — everything arrives through `installFilmMode(deps)`.

## Module map

### `scene3d/film/` (page; pure modules are shared with Node)

| File | Purpose |
|---|---|
| `SPEC.md` | frozen contracts: roles, frames, every module API, `window.__film`, seams, CLI, plan/timeline/take, owner decisions |
| `README.md` | this file |
| `flags.js` | `filmModeEnabled(search?)`, `filmDofEnabled(search?)` — exact `=== "on"`, memoised, `_set…ForTest` |
| `index.js` | `installFilmMode(deps)` → `window.__film` (wires every runtime piece; JSON-safe, never throws) |
| `core/errors.js` | `FilmError`, `FilmShotError`, `FilmPlanError`, `toErrorJSON` |
| `core/vec3.js` | 3-vector helpers |
| `core/quat.js` | quaternions (slerp, splines, continuity, three conversion) |
| `core/gimbal.js` | heading/pitch/roll ↔ quaternion, singularity-free basis, `lookRotation`, smooth look controller (nadir yaw-slew) |
| `core/spline.js` | Catmull-Rom, arc-length paths, corner fillets, curvature-limited speed profiles |
| `core/easing.js` | easing curves, min-jerk, trapezoid / S-curve profiles |
| `core/spring.js` | critically damped springs, smoothDamp, second-order dynamics |
| `core/rng.js` | seeded RNG (`mulberry32`, `hashString`, `seedOf`) |
| `core/noise.js` | smooth seeded noise, fBm, camera shake |
| `core/units.js` | landblock/cell ids, world ↔ local ↔ map coords, `@teleloc`/`@tele`/`@telepoi` strings |
| `shots/trajectory.js` | Pose/Trajectory types, `makeTrajectory`, combinators, bake/replay tables + checksum, validation |
| `shots/framing.js` | framings (EWS…ECU), distance for framing, projection, composition metrics |
| `shots/registry.js` | `defineTechnique`, `registerTechnique`, `getTechnique`, `listTechniques`, `buildShot`, `createRegistry` |
| `shots/classic.js` | the 34 `classic.*` techniques |
| `shots/drone.js` | the 24 `drone.*` and 5 `fpv.*` techniques |
| `shots/index.js` | registers every technique; re-exports the shot API |
| `drone/flight_model.js` | multirotor model (presets cinema/heavy/fpv/indoor), `createDrone`, `flyTrajectory`, `presetForTrajectory` |
| `pilot/sense_words.js` | `WORD_BOUNDS` and the number → word bucketers |
| `pilot/scene_state.js` | SensorFrame → words-only JEV state (+ the standing order) |
| `pilot/questions.js` | `PILOT_RULES`, `PILOT_QUESTIONS` (criteria generated from the rules), request/answer parsing |
| `pilot/policy_code.js` | deterministic code policy (same rules, Decisions-API answer shape), `answersAgree` |
| `pilot/fingerprint.js` | stable bucketed-scene fingerprint (answer reuse) |
| `pilot/mapper.js` | answers → bounded residual setpoint (commit window, confidence, staleness, rate limits, bounds) |
| `pilot/pilot.js` | the pilot loop: consult-when-needed, pipelined realtime / awaited stepped, jev/code/shadow, telemetry |
| `scene/world_query.js` | live scene facts: subjects, entities/statics/particles near, ground height, collision population; which static a hit names and its fade key (`describeHit`: statics / building hits by the axis nearest relative to the radius — `STATIC_HIT_RULES`; only a placed tree or a small prop of known size gets a key; scenery collider hits are only LABELLED, by the absolutely nearest placement axis that could own the hit — `SCENERY_HIT_RULES`, `staticAxisDistance` / `sceneryColliderReach` / `colliderSideFit` — and NEVER get a fade key in v1, `FADEABLE_STATIC_SOURCES`: the CollisionHit names no placement, so procedural trees and rocks are rerouted around; exact scenery fades need a placement index on CollisionHit from the wasm scenery sweep, SPEC §3.1) and live draws of placed statics (`staticFadeTargets`; a scenery key resolves to nothing); `createStaticCatalogs` (film/index.js injects it): READS scene3d/vfx_catalog.js `vfxDescriptorFor` (never writes or loads the catalog) for archetype + DAT size and calls wasm `fetchSetupSelectionSphere` per uncatalogued Setup DID (each prefetch bounded at 3 s; a DID that outlived one wait is stalled and never waited for again) — flag off, neither happens |
| `scene/sensors.js` | perception → SensorFrame (sectors, free space, sides, nearest, path contact, subject visibility; `occluderIds` = rig guids, particle keys and placed-static fade keys — a scenery collider hit never carries an id, so it is never seen through `fadedIds`; a ray stopped by the point subject's own body (`subjectBodyIds`) sees the subject) |
| `scene/los.js` | layered line-of-sight / clearance sweeps over the wasm collision layers (`segmentBlocked`) |
| `scene/particles_query.js` | particle clouds near the camera: on the lens, occluding the view |
| `scene/terrain_corridor.js` | residency-independent terrain heights for a flight corridor (wasm heightmaps) |
| `scene/solver.js` | camera-position candidates for a shot intent, scoring, worded descriptions (scout) |
| `scene/dungeon_route.js` | doorway control points, indoor camera paths with filleted corners (`planIndoorPath`) |
| `runtime/camera_owner.js` | owns the persp camera (per-instance `positionCamera` wrap), film viewer cell (`parkCell()` for world.teleport), `liveScene3d.film` hooks |
| `runtime/clean_frame.js` | HUD-free frame + input lock (and full restore) |
| `runtime/film_clock.js` | stepped film clock (`holdLoop` + one animation-frame yield + `__renderOnce(ts)` per frame), particle/FX/scenery time sources, time of day / time-lapse |
| `runtime/look.js` | per-take look: time of day, day group, fog, exposure, grade, bloom, vignette, DoF (snapshot + restore); re-applying the fog already showing keeps its object (`applied.fog.changed:false`), so only a real fog change makes the next take wait |
| `runtime/world.js` | teleport (admin commands, forbidden verbs refused), readiness gate, prewarm, avatar hide, player-as-actor |
| `runtime/safety.js` | the hard safety reflex (sphere sweep, slide, terrain floor, cell clip, lens particles) |
| `runtime/take_player.js` | plays a take: prepare (validation + the drone/fpv flight check: speed against the preset's vmax and a dry flight of the nominal through the flight model, `FLIGHT_CHECK`) / rehearse / shoot / locked replay, live-subject re-anchoring, pilot fades, realised table, take report, DoF focus driving. A rendered take first waits, for at most 30 s and only on the live loop, until an AdminEnvirons fog change has settled (report `environ` {checked, settled, waitedMs, polls, relit, timedOut, stalled, aborted, reason, state}); the rehearse result, the shoot report and a failed take's partial report carry `validation` (prepare's, verbatim) and `flight` (prepare's check + `tracking: {frames, maxGapM, maxGapT, endGapM}`, how far the flown craft trailed its re-anchored nominal; tracking null on a locked replay; flight null for classic shots) |
| `runtime/recorder.js` | WebCodecs recorder (avc1 → vp9 → JPEG frames fallback), drainable chunk queue; `grab(t \| [t…])` encodes held copies for the realtime grid |
| `runtime/jev_bridge_page.js` | page end of the JEV bridge (`window.__filmJev`; timeouts 1.5 s realtime / 15 s stepped) |
| `runtime/SEAMS.md` | the exact seam names and behaviours runtime code relies on |

### `tools/film/` (Node ≥ 20 only)

| File | Purpose |
|---|---|
| `film.mjs` | the CLI: doctor (CDP down → the full three-forward ssh tunnel line), project init, techniques, song analyze, sites build/search/show, plan validate/compile, jev ping/decide/task (pick, keep, site-fit, family), browser check, boot, status (`__film.status()` + camera/avatar/canvas probe; `--release` / `--own` / `--clean` / `--avatar`), go, scout, rehearse, shoot, assemble, contact-sheet, run (`--song-analysis` → plan steps, `--song-audio` → assemble); map positions print through `core/units.js` `formatMap` |
| `install-claude.sh` | symlink the skill + agent into `~/.claude` (idempotent; `--dry-run`, `--uninstall`; refuses real files) |
| `lib/args.mjs` | `--key=value` parsing, typed CLI errors / exit codes, secret scrubber, output channel |
| `lib/project.mjs` | project layout, `project init`, JSON helpers |
| `lib/session.mjs` | CDP attach (never launch), the film boot URL, `__film` calls with watchdogs, boot gate, mute, window/GPU probes, the `status` probe, the tunnel line, teleport + readiness wait |
| `lib/shoot.mjs` | walks the schedule: status check (aborts a leftover page take) → teleport → ready → prewarm (best-effort: an incomplete one warns, adds a shoot-log row and a report note) → prepare → [rehearse, always with the stepped JEV limits] → shoot + drain → mux → report → keep or retake. A failed take → `__film.abort()` + wait for an idle page, re-sending the abort while the page stays busy (≤ 30); a page that never goes idle is not teleported (remaining shots fail at 'busy'); a failed retake keeps the earlier attempt (`failedAttempts`). Surfaces the page's validation / overspeed (with `durationHelps`, `limitedBy`, `minDurationVerified`) / warning issues, plus a `tracking-gap` when a flown run's realised `flight.tracking` trailed the plan by more than `FLIGHT_GAP_WARN_M` (2 m) (`pageIssuesOf`), as warnings and as `issues` in the take report, shoot-log and rehearsal file; `<shot>.jev.jsonl` holds only that shot's broker requests |
| `lib/drain.mjs` | drains `recorder.drain` into `.h264` / `.ivf` / JPEG frames |
| `lib/ffmpeg.mjs` | ffmpeg/ffprobe resolution, bounded runner, take mux argv |
| `lib/contact_sheet.mjs` | contact-sheet ffmpeg argv (every-Nth frame tile) |
| `lib/decode_audio.mjs` | audio → mono Float32 PCM via ffmpeg |
| `lib/jev.mjs` | the JEV client: validation, retries, budget caps, key resolution, redaction |
| `lib/jev_broker.mjs` | the `window.__filmJev` handler (exposeFunction): validation, concurrency cap, telemetry |
| `lib/jev_tasks.mjs` | planning-time decisions: `pickCandidate`, `keepOrRetake`, `scoreSiteForLine`, `sectionTechniqueFamily`, `jevPing` |
| `plan/schema.mjs` | Plan JSON v1: `PLAN_FIELDS`, `normalizePlan`, `validatePlan`, `examplePlan` |
| `plan/compile.mjs` | plan + song → Timeline (beat grid, handles, pre-roll) + shooting schedule; `estimateShootTime` |
| `plan/edl.mjs` | assembly filter graph (cuts, xfades, fades, audio) and CMX3600 EDL |
| `audio/analyze.mjs` | `analyzeSong` / `analyzeSongFile` → SongAnalysis v1, `formatSongSummary` |
| `audio/fft.mjs`, `features.mjs`, `onset.mjs`, `tempo.mjs`, `structure.mjs`, `lyrics.mjs` | FFT/STFT; log-mel/chroma/MFCC/RMS; onset envelope; tempo/beats/downbeats/bars; sections/labels/roles; LRC + plain lyrics and alignment |
| `sites/sources.mjs`, `build.mjs`, `search.mjs` | gazetteer loaders, builder (teleport-ready sites), BM25F + lexicon search |
| `data/concept_lexicon.json` | 73 lyric-imagery concepts → AC terrain/biome/tags/kinds + suggested look and techniques |

## Page API — `window.__film` (`FILM_API_VERSION = "film-1"`)

Every method returns JSON-safe output and `{ok: false, error: {name, code, message}, code}` instead of throwing;
object arguments may also be passed as JSON strings. `prepare`, `rehearse`, `shoot` and `scout` are mutually
exclusive (`FILM_BUSY`); `pose`, `release`, `world.teleport` and `world.command` refuse with `FILM_BUSY` (and do
nothing) while a take, prepare, shoot, rehearse or scout runs — never a teleport or an admin command mid-take or while
prepare reads the world: `abort()` and wait for `status().active === false`. `status` and `recorder.drain` work any time (the CLI drains while a take records).

| Method | Does |
|---|---|
| `version` | `"film-1"` |
| `status()` | `{version, active, busy, runtimeReady, timeSources, cameraOwned, viewerCell, clean, cleanState, take, recorder, pilot, lastTake, clock, look, flags:{filmMode, filmDof, dof, dofEnabled, jevBridge}, bridge}` |
| `clean(on = true, {bubbles})` | strip HUD/overlays/brackets/bubbles/cursor and lock input; `clean(false)` restores |
| `own()` / `release()` | take / return the camera (`release` refuses with FILM_BUSY while a take / prepare / shoot / rehearse / scout runs) |
| `pose(pose, {cell})` | set an absolute AC pose `{pos, q \| h,p,r, fov, focus?}` now (FILM_BUSY while a take / prepare / shoot / rehearse / scout runs) |
| `world.teleport(cmd)` / `world.command(cmd)` | send an `@` admin command (single line ≤ 200; logout/DB-writing verbs refused). Both answer `{ok:false, code:'FILM_BUSY'}` and send nothing while a take / prepare / shoot / rehearse / scout runs. When idle, `teleport` then parks the film viewer cell (`camera_owner.parkCell`: `liveScene3d.filmViewer` deleted until the next camera write) and returns `{ok, cmd, viewerParked}` |
| `world.ready({lbKeys, interiorLb, settleSec, timeoutSec})` | the readiness gate report `{ok, checks, waitedMs, timedOut}` (`timedOut`: `timeoutSec` passed before every check held; SPEC §3.4) |
| `world.prewarm({points, radius, lbKeys?, interiorLb?})` | collision, heightmap corridor, statics/buildings/EnvCells around the points |
| `world.avatar(visible)` | hide/show the local player (film hide term, shadows included) |
| `world.look(look)` / `world.restoreLook()` | apply / undo a look |
| `world.actor(cue)` | `{emote, motion, face, moveTo, at}` for the player-as-actor |
| `query.subject(ref)` / `query.near({center, radius, kinds})` / `query.groundZ(x, y)` | live scene queries |
| `techniques({family})` | the technique catalog |
| `scout(take, {count, stills, width, intent})` | ranked camera candidates with metrics + worded descriptions (+ JPEG data-URL stills), `sun` and `warnings` (an `intent.light` ignored without a usable sun) |
| `prepare(take)` | resolve a compiled Take (or `{table}` replay): subject, path, indoor route, pilot, look → summary with `validation` (incl. a drone/fpv `overspeed` issue with `minDurationSec`: a path faster than the preset's vmax, or one the prepare-time dry flight trails by more than 1 m — an acceleration-limited move, `limitedBy`), `flight` (the check: `limitedBy`, `dryFlight`, `minDurationCheck` verified / unverified / failed), `liveSubject`, `sun` (SPEC §3) |
| `rehearse({fps, render, locked, maxOverrun})` | stepped dry run → report + `realisedTable` + `pilotTelemetry` + `safetyEvents`; the report carries `validation` (prepare's, verbatim) and `flight` (prepare's check + `tracking: {frames, maxGapM, maxGapT, endGapM}`; null for classic shots) |
| `shoot({fps, width, height, codec, bitrate, keyIntervalSec, mode, locked, includeTable, maxOverrun, clean})` | record the take → take report (same `validation` / `flight` blocks; a failed take's partial report in `error.details.partial` has them too). A rendered take (shoot, or a rendering rehearse) first waits, for at most 30 s and only on the live loop, until an AdminEnvirons fog change has settled → report `environ` |
| `recorder.drain({maxBytes})` / `recorder.stats()` | `{chunks:[{seq, b64, timestampUs, key}], done, stats}` |
| `abort()`, `logs({limit})`, `dispose()` | stop a take; last log entries; uninstall |

**Reading a take report** (rehearsal or shoot; full field list in SPEC §3): `frames` vs `plannedFrames`, `safety`,
`obstruction`, `pilot`; `liveSubject` `{mode: carry|aim, rotate, frames, missingFrames, maxOffsetM, maxLagM,
maxTurnDeg, refHeadingDeg}` — how far a moving subject drifted from the reference track the shot was built on
(`maxOffsetM`) and how far the camera's follower lagged it (`maxLagM`); `flight.tracking.maxGapM` / `endGapM` — how
far the flown drone trailed its nominal in this run (the realised gap; an `overspeed` issue in `validation` — a path
too fast for the preset, or an acceleration-limited move the prepare-time dry flight caught: `flight.limitedBy`,
`flight.dryFlight`, `flight.minDurationCheck` — explains a large gap; above 2 m the CLI's `rehearse` / `shoot` print a
`tracking-gap` warning, tools/film/lib/shoot.mjs `FLIGHT_GAP_WARN_M`); `faded`
`{entities, particles, statics, fallbackFrames}`; `environ` (did a fog change settle before recording);
`realtime` (grid counters of a realtime take).

Also on the page: `liveScene3d.film = {preFrame(tsMs, dt), postRender(), holdLoop}` and
`scene3d.filmViewer = {cell}` (published by the camera owner; `world.teleport` unpublishes it until the next camera
write), `window.__renderOnce(tsMs?)`,
`window.__filmJev(json)` (installed by the CLI with Playwright `exposeFunction`; absent ⇒ code policy) and
`window.__dof` (only with `?filmDof=on`). A non-enumerable `__film.__runtime` exposes the components to tests.

## Flags

| Flag | Default | Reader | Effect |
|---|---|---|---|
| `?filmMode=on` | off | `scene3d/index.js:4531`, `flags.js:42` (`=== "on"`) | lazily imports `film/index.js` (+ the resident `particles/particle_manager.js`) and installs `window.__film` |
| `?filmDof=on` | off (owner decision: in v1 for film, off for play) | `atmosphere_pipeline.js:879`, `flags.js:62` (`=== "on"`) | builds the DoF effect + `window.__dof` |

Rows (and the §0 adjudication) are in `docs/url-flags.md`. The CLI `boot` URL always carries both.

## Tests

All suites are `tests/film_<topic>.test.mjs` (node:assert/strict, executing the real modules with injected fakes),
registered in TIER5 of `harness/run-js-headless.mjs` as `filmMode(<topic>)`. Run ONE suite from
`apps/holtburger-web/`:

```bash
node tests/film_plan_schema.test.mjs
```

Parallel agents may read, edit and run TARGETED single tests only (`node test_x.mjs`). They must NOT run the full JS
gate, cargo, wasm-pack or browsers. The orchestrator runs the full gate and builds ONCE, after merging, one at a
time.

| Suite | Covers |
|---|---|
| `film_core_math` | errors, vec3, quat, easing, spring, rng, noise, units |
| `film_gimbal` | gimbal angles ↔ quaternions vs three.js, nadir behaviour of the look controller |
| `film_spline` | Catmull-Rom, arc length, fillets, speed profiles |
| `film_trajectory` | Trajectory purity, combinators, bake/replay tables, checksums, validation |
| `film_framing` | framing distances, projection, composition metrics |
| `film_registry` | technique definitions, params validation, `buildShot` |
| `film_shots_classic` | every `classic.*` technique (duration, continuity, subject in frame, ground, nadir tilt, focus channel) |
| `film_shots_drone` | every `drone.*` / `fpv.*` technique |
| `film_flight_model` | drone presets, limits, gimbal vs hard mount, `flyTrajectory` |
| `film_pilot_words` | word buckets, words-only state, criteria quote the bucket words |
| `film_pilot_policy` | code policy ⇔ criteria agreement (same rules) |
| `film_pilot_loop` | consult-when-needed, pipelining, stale answers, commit window, shadow agreement, telemetry |
| `film_scene_los` | layered segment sweeps (wasm fakes), hit copying/freeing |
| `film_scene_solver` | candidate generation, scoring, descriptions |
| `film_scene_dungeon` | doorway routes, filleted indoor paths |
| `film_perception` | world query (entities, statics, subjects, ground), particle queries, sensors → SensorFrame words |
| `film_terrain_corridor` | the private heightmap corridor |
| `film_runtime_camera` | flags, camera owner (wrap, write, viewer cell, release), film clock, clean frame, safety |
| `film_runtime_capture` | recorder (codec fallback, timestamps, drain chunking, backpressure, JPEG fallback), page JEV bridge, residual math, take player end to end |
| `film_runtime_world` | teleport, readiness gate, prewarm, avatar, actor, look |
| `film_api` | `window.__film` contract: every method present, never throws, JSON-safe, the CLI prepare → rehearse → shoot + drain flow, scout, DoF through the API |
| `film_hooks` | the eight seams in existing hot files (zero-cost when off) |
| `film_plan_schema` / `film_plan_compile` | plan validation messages; beat grid, handles, schedule, EDL/assembly |
| `film_audio_tempo` / `_structure` / `_lyrics` | the song analyser on synthetic audio and lyrics |
| `film_sites` | gazetteer loaders, builder, search |
| `film_jev_client` / `film_jev_broker` | the JEV client (budget, retries, redaction) and the page broker |
| `film_cli` / `film_cli_session` | every CLI subcommand with fakes (no browser, no network, fake ffmpeg); the session lib |
| `film_install_claude` | `tools/film/install-claude.sh` against temp HOMEs (idempotent, refusals, dry run, uninstall) |

## Integration seams in existing files (zero-cost when the flag is off)

From `git diff HEAD -- scene3d/index.js scene3d/cells.js scene3d/entities.js scene3d/statics.js scene3d/particles
scene3d/animated_scenery.js scene3d/atmosphere_pipeline.js` (449 insertions, 8 deletions); details in
`runtime/SEAMS.md`, pinned by `tests/film_hooks.test.mjs`.

| File | Seam | Flag off |
|---|---|---|
| `scene3d/index.js:4531` | `?filmMode=on` → `Promise.all([import("./film/index.js"), import("./particles/particle_manager.js")]).then(([m, pm]) => m.installFilmMode({liveScene3d, THREE, sessionHandle, wasmExports, particleCull: {setParticleCullConfig: pm.setParticleCullConfig, allParticleManagers: pm.allParticleManagers}}))` right after `window.liveScene3d` is set (particle_manager.js is the same module instance entities.js / statics.js load) | never imported; boot graph + modulepreload unchanged |
| `scene3d/index.js:2566` | `liveScene3dRef?.film?.preFrame?.(ts, dt)` before `tickPerFrame` (try/catch, warns once) | one property read |
| `scene3d/index.js:2368` | `_postRenderStreamSlot`: `film.postRender()` first (the recorder grabs the canvas in the same task) | one property read |
| `scene3d/index.js:2429` | `scheduleNext`: `if (renderOnDemand \|\| film.holdLoop) return` | one property read |
| `scene3d/index.js:3059` | `window.__renderOnce(tsMs)` takes an explicit timestamp; while `holdLoop` it cancels a pending re-arm | omitted ts = `performance.now()` as before |
| `scene3d/cells.js:2857` | `_filmViewerCell` — `updateViewerCell` roots `scene3d.filmViewer.cell` (or `window.liveScene3d.filmViewer`) as the viewer cell | a few property reads |
| `scene3d/entities.js:2979, 7165` | `_filmHidden` term in `_applyEntityVisible`; `EntityManager.setFilmHidden(guid, on)`, `clearAllFilmHidden()`; rebuilt rigs keep the hide | term always false |
| `scene3d/statics.js:4579` | `cullStaticsGroup` honours `userData.__filmHidden` (the film take player sets it when the pilot fades a placed tree / prop occluder) | marker never set |
| `scene3d/particles/particle_manager.js:1345, 1357, 2372` | `allParticleManagers()`, `setParticleCullConfig({maxDistance, recheckInterval})`, render-only `emitter.filmHidden`. Used through `particleCull`: rendered takes (take_player) and scout stills set `recheckInterval: 1` and restore only the previous interval; film/index.js builds the particle query with `managers: allParticleManagers` | unused |
| `scene3d/particles/particle_fx.js:533, 551` | `setFxTimeSource(fn \| null)`, `setFxNearFadeMin(m)` (uniform `uFxNearFadeMin`, default 0) | wall clock, floor 0 |
| `scene3d/animated_scenery.js:1210` | `setSceneryTimeSource(fn \| null)` consulted by `_nowMs()` | `performance.now()` |
| `scene3d/atmosphere_pipeline.js:875, 892, 1804` | `?filmDof=on` → one `DepthOfFieldEffect` (idle = out of the shader) + `window.__dof` handle; removed on dispose | nothing constructed |

Plus `harness/run-js-headless.mjs` (TIER5 rows) and `docs/url-flags.md` (the two flag rows). The particle time RNG
seam (`particles/time_rng.js setCurrentTime/setRng`) predates film mode.

## How to extend

**Add a technique.**
1. Write a definition in `shots/classic.js` (`DEFS`, mapped through `defineTechnique`) or `shots/drone.js`
   (`DRONE_TECHNIQUES` / `FPV_TECHNIQUES`): `{id: "<family>.<kebab-name>", family, name, description, whenToUse,
   params: {name: {type: number|string|boolean|enum|vec3, default, min, max, values, unit, desc}}, needs: {subject,
   path, indoor}, defaultBounds: {maxLateral, maxRise, maxSink, minSpeedScale, maxSpeedScale, maxDistanceScale},
   defaultDuration, defaultFraming, defaultFov?, defaultEase, capture: stepped|realtime, reveal, tags,
   build(spec, ctx) → makeTrajectory({...})}`. `shots/index.js` registers it; a malformed or duplicate definition
   throws at import.
2. `build` must be pure in t, honour `spec.duration`, stay NaN-free and continuous, respect `ctx.groundZ` (+0.7 m)
   outdoors and `ctx.indoor.ceiling/floor` indoors, keep the subject in frame (unless `reveal`), and write the
   `focus` channel only if it pulls focus.
3. Test it in `tests/film_shots_classic.test.mjs` or `film_shots_drone.test.mjs`; add the id to
   `KNOWN_TECHNIQUE_IDS` in `tools/film/plan/schema.mjs` (the no-registry fallback list) and to SPEC §2.12.
4. Docs: re-render the catalog part of `$REPO/.claude/skills/film-mode/reference/techniques.md` from
   `node tools/film/film.mjs techniques --json` (keep the hand-written "Director note" quotes inside entries) and add
   the id to its beat cheat-sheet if it fits one.

**Add a pilot question** (keep code and criteria in lock-step):
1. `pilot/questions.js`: the rule as data in `PILOT_RULES`, then the question (`choice` with the conservative option
   FIRST, `score` 2–10 levels low → high, or `noul` with explicit true/false criteria). Generate every boundary from
   `WORD_BOUNDS` (`quoteBand`, `bandList`) so the text quotes the state's exact words; one judgment per question;
   never integer-like choice keys. Gate it in `questionsFor` if it needs a subject.
2. If the state lacks the words, add them in `pilot/scene_state.js` (and the bucketer in `sense_words.js`, the
   measurement in `scene/sensors.js`). Raw numbers never go to JEV.
3. `pilot/policy_code.js`: evaluate the same `PILOT_RULES` on the same words and return the Decisions-API answer
   shape (`answersAgree` then measures shadow agreement for it automatically).
4. `pilot/mapper.js`: map the answer to a setpoint channel (bounded, rate-limited, stale-safe), and let
   `runtime/take_player.js` apply any new channel.
5. Tests: `film_pilot_words` (criteria quote the words), `film_pilot_policy` (code ⇔ criteria on boundary cases),
   `film_pilot_loop` (telemetry, agreement). Then document it in the skill's `reference/pilot.md`.

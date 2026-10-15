# Egg Orchard FPV run — design contract (2026-10-15, orchestrator)

Owner brief: replace the two Egg Orchard dungeon shots in the music edit with ONE JEV-piloted FPV run through the
Egg Orchard (landblock 0x002B) from the ENTRANCE DROP (0x002B0371) to the EXIT PORTAL at the bottom (0x002B0100,
"Surface", where the Olthoi Rippers — the eviscerator model —, larvae, eggs and the hive are), all monsters spawned,
the drone taking different lines past them (over / left / right), diving into the tunnel mouths built into the ground,
FPV tricks at the pit (and chimneys); APPENDED AFTER THE MUSIC with no music; the music edit is refitted (other trim
windows lengthened — never a speed change). Real FPV feel: propellers visible at the top of the frame, hard-mounted
up-tilted camera, banked turns, punchy throttle, gravity tricks (punch up, cut throttle, float, drop) — but NO fake
low-quality-link effects (no static, breakup, noise, colour bleed).

Research (read these): runtime `research-0.txt`, dungeon `research-1.txt`, edit/server `research-2.txt` in
/tmp/claude-1000/-home-wbterminal/f87d60b8-65a2-447a-9582-b19fdc7eaafc/scratchpad/ ; dungeon data + tools in
…/scratchpad/egg-orchard-dungeon/ (eo_fpv_route.json master, route_samples.json, monsters_in_the_way.json,
segments.json, images, py/eograph.py graph from the DAT parse /tmp/claude-1000/eo/parse_all.jsonl, py/clear.py
wall-clearance raycaster).

## 0. Ownership (parallel agents edit ONLY their own files; read anything)
| Area | Owner | Files |
|---|---|---|
| A. Plan pipeline | agent A | tools/film/plan/schema.mjs, compile.mjs, edl.mjs; tools/film/lib/shoot.mjs, session.mjs, film.mjs; .claude/skills/film-mode/reference/plan-format.md + workflow.md; tests film_plan_schema / film_plan_compile / film_cli / film_cli_session |
| B. Technique | agent B | scene3d/film/shots/fpv_tricks.js (new), shots/drone.js, shots/registry.js, shots/trajectory.js; techniques.md entry; tests film_fpv_tricks (new), film_shots_fpv_run (new), film_shots_drone, film_registry, film_trajectory |
| C. Page runtime | agent C | scene3d/film/runtime/take_player.js, runtime/lens_overlay.js (new), runtime/camera_owner.js, flags.js, film/index.js, pilot/mapper.js, pilot/pilot.js, docs url-flags.md (film rows); tests film_runtime_capture, film_runtime_overlay (new), film_runtime_camera, film_pilot_* |
| D. Egg Orchard route + JEV pass plan | agent D | research/egg-orchard-run/ (tools + data, on the live drive), tools/film/lib/jev.mjs (+ its task registry) ; tests film_jev_client / a new film_jev_pass_plan test |
| SPEC.md / README / skill SKILL.md / handoff | orchestrator (after merge) | — |

## 1. Plan fields (agent A implements validation + compile passthrough)
- `edit.tail = {from: "<shot id>", gapSec = 1.5, fadeOutSec = 3}` — shots from `from` on are the TAIL: not
  beat-snapped (exact seconds, snap 'none'), no `start`, no {beats}/{bars}; the music part compiles exactly as today
  (same items, same frames); `edit.fadeOutSec` applies to the last MUSIC shot (element-local fade); a `gapSec` black
  hold follows; the first tail shot's non-cut transition is a fade-IN from black/white (element-local); the program
  fade-out is `tail.fadeOutSec` on the last shot. Timeline gains `musicEnd: {sec, frame, fadeOutSec}`.
  Assembly: element-local fades (never chained global fade-out + fade-in), audio `atrim=duration=<musicEnd>,
  asetpts, afade out at musicEnd, apad=whole_dur=<total>` only when a tail exists; `-shortest` stays (audio now =
  program). No tail ⇒ byte-identical timeline / filter graph / EDL to today (regression test).
- `site.prime = ["@teleloc …", …]` (≤ 12 admin commands, each validated like a teleport): `film shoot` runs each
  BEFORE the site teleport, each followed by the readiness gate (goAndWait + readyTargets), logs event 'prime'; a
  failure warns only. `estimateShootTime` counts them. Purpose: walk the hidden player down the dungeon so ACE sends
  every creature on the route to the client (server PVS), then stand at the site teleport.
- `shot.overlay = {props: {style: "freestyle" | "cinewhoop", opacity?: 0..1, tint?: "#rrggbb"}}` → `item.take.overlay`
  (unknown keys warn).
- `shot.pilot.fade: "never" | "auto"` (validated enum; passed through to the page).
- `shot.path` with an indoor site: allowed (the run flies an explicit, offline-verified racing line; no route).
- Registry `list` params (agent B) must validate in `plan validate` (agent A: nothing to do if checkParams uses the
  registry's own validation; verify with a test).
- Film boot URL (session.mjs buildFilmUrl): add `filmProps=on` (props overlay only draws for shots with
  `overlay.props`) — plus the effect flags the effects audit decides (orchestrator will brief).

## 2. Technique `fpv.fpv-run` (agent B)
Context: `ctx.path` = the racing line, world [[x,y,z], …] (≥ 2; dense enough to be the line; the run's is
authored by agent D with pass lanes ALREADY baked in), or `ctx.indoor.route`. Duration D = spec.duration (≤ 600 s).
Params (scalars, catalogue-validated): `speed` 8 (cruise), `speedMax` 16, `amax` 9, `alat` 12, `cornerRadius` 2.0,
`lookAhead` 5, `uptiltDeg` 25, `lookAlongPath` 0.55, `bankGain` 1.2, `maxBankDeg` 60, `throttleBobM` 0.1,
`bobHz` 1.1, `wobbleDeg` 0.4, `propwashDeg` 0.8, `startHoldSec` 0.8 (hover at the start, idle bob), `ends`
'rest'|'cruise'. Lists (new registry param type `list` with an item schema, validated + shown in the catalogue):
- `zones: [{s0, s1, speed}]` — speed caps by arc length (the speed plan; outside zones `speed` applies).
- `tricks: [{type, s, …}]`, `s` = arc length (m) along the racing line where the trick starts. Types (deterministic,
  pure in t, C2-continuous position/velocity at both ends, quaternion-continuous orientation):
  `float` {rise (apex above the line, m), punchAccel, hangSec?} — punch up, cut throttle (free fall, a_z = −g), catch;
  forward motion continues along the line; `roll` {turns 1, dir 'left'|'right', durationSec}; `yaw-spin` {turns,
  durationSec}; `power-loop` {radius} — a vertical loop in the travel plane that leaves and re-joins the line at s
  (adds its time); `split-s` {radius} — half roll + half loop down, for a pit entry (only where the geometry allows;
  report skipped otherwise); `dive` {pitchDeg} — attitude keys for a steep drop on the line (nose down, uptilt
  visible, ballistic speed-up close to g); `dip` {depth}. The technique fits the speed profile to the time left after
  the tricks so the total is exactly D.
- Camera = FPV body attitude (pure in t): thrust-derived pitch (punch dips the view, braking flares it) + uptilt,
  mixed with the path pitch (`lookAlongPath`), look-ahead heading, coordinated bank, seeded throttle bob / prop-wash
  wobble (core/noise.js + specSeed). Trick quaternions compose on top.
- `meta`: `{flightPreset:'fpv', lengthM, peakSpeed, overspeed, tricks:[{type, s, t0, t1, skipped?, reason?}],
  lockWindows:[[t0,t1], …] (trick windows: the page freezes the pilot residual and pins speedScale = 1),
  validate:{maxAngularSpeedDeg: 900}, throttleAt? (optional fn for the overlay; else the page derives it)}`.
- `validateTrajectory` honours `traj.meta.validate` limits (agent B, trajectory.js).
- Acceptance (tests): exact duration; deterministic (same table checksum twice); C2 at trick joins; free-fall phase
  a_z within 0.3 m/s² of −g; `flyTrajectory(traj, 'fpv')` maxTrackingErrorM ≤ 0.6 on a synthetic run with every
  trick; jerk of the nominal ≤ 60 m/s³ outside free-fall onsets; validate ok with meta.validate; zones honoured
  (peak speed in a zone ≤ zone speed × 1.05 unless overspeed).

## 3. Page runtime (agent C)
- take_player: honour `traj.meta.lockWindows` (inside: pilot residual held at its entry value and eased to 0 over
  0.4 s, speedScale = 1); `fade()` refuses guids whose world-query kind is creature / npc / player; `pilot.fade:
  'never'` ⇒ mapper `limits.maxFadeIds = 0`; fix mapper.occluderIds to return [] for max ≤ 0 (verified bug,
  mapper.js:211); plumb mapper `limits` through pilotFactory (index.js:456-473).
- Lens overlay `runtime/lens_overlay.js`: separate three.js scene drawn after the composer in the grab listener,
  immediately BEFORE `recorder.grab` (so DoF/bloom/grade/fog/tone mapping never touch it); renderer state restored;
  2 front props top-left/top-right partly out of frame (fixed in camera space — hard mount), soft blurred disc +
  faint blade ghosts (+ optional arm stub), procedural textures (no assets), angle = 2π·(f0 + f1·throttle)·t from
  FILM time (deterministic; stepped and realtime identical), disc opacity mixes with throttle (chop = crisper blades);
  throttle from the drone state (|a + g ẑ|/g) or traj.meta.throttleAt. Gate: `?filmProps=on` (flags.js
  filmPropsEnabled, exact `=== "on"`) AND `take.overlay.props`. Report `overlay: {on, style}` in the take report.
  Nothing that imitates a video link (no noise, static, scanlines, colour bleed).
- Lights: while the film camera is owned, light-pool ranking uses the film eye, not the hidden player
  (camera_owner wraps cameraSwitcher.getPlayerWorldPosition, film-mode gated, restored on release) — so a run 400 m
  from the parked avatar keeps its torches lit.
- `take.path` on an indoor site reaches ctx.path (check resolveTake); the start cell = take.cell.

## 4. The run (agent D)
- Offline geometry (Python, from py/eograph.py + parse_all.jsonl): racing line from the drop (458.535, 8083.797,
  0.005 + 1.6 m) to the exit portal disc (9.704, 8142.688, −60.063, + ≈1.4 m centre, flying NORTH into it in cell
  0x002B0100), through the trench cells (0x375, 0x2C8, 0x152, 0x130, 0x122, 0x11B), the floor chute (0x2C3→0x2C2),
  chimney A (float), the pit (0x1D4 → 0x1A9), the ramp hall, the west egg chamber (float-up reveal over the eggs,
  larvae, hive, carve) — never the 0.75 m slivers over the mound crests; around the entry-hall props and the vent
  column in 0x163; 1.5–2.6 m above tunnel floors (vents flare above floor + 3.2 m).
- Monster passes: for each creature within 6 m of the line (monsters_in_the_way.json + monsters_vs_route.json), the
  side (over / left / right) is chosen by JEV at PLANNING time (Node; new task `film jev task pass-plan`, typed
  choice per creature with measured gaps as words + `previous_pass` for variety; criteria: a side needs gap ≥
  1.9 m incl. 0.3 m claw margin, over needs headroom ≥ 1.2 m above the creature top + 0.4 m below the ceiling; code
  rule fallback identical; costs ≈ $0.0002/decision), then baked into the line as raised-cosine lateral/vertical
  bumps, clearance ≥ creature radius + 1.0 m. Output: `passes.json` (creature, s, side, source jev|code, gaps).
- Tricks placed in tall spaces only: entry hall (punch-float over the mound, dive into the trench), −12 hall floor
  chute (cut throttle over the hole, 33° dive), chimney A (punch up ≈ 12–15 m, float, drop back), the PIT (roll or
  split-S over the edge if the 3 m lid allows, else a nose-over `dive`: 18 m free-fall-ish drop, pull out over the
  two Rippers), ramp hall swoop, −60 burrow dive / pop-ups, egg chamber float-up reveal, dive into the portal.
- Verify OFFLINE: build the shot with the real registry (fpv-run), dry-fly `flyTrajectory(traj,'fpv')`, sample at
  24 fps and check wall/floor/ceiling clearance (py/clear.py logic, ≥ 0.9 m in tunnels, ≥ 1.2 m in rooms) +
  props/statics (vents, columns) + creature boxes (≥ radius + 0.8 m); speeds within zones; tracking gap ≤ 0.6 m.
- Deliver `research/egg-orchard-run/run-shot.json` (the plan shot: technique fpv.fpv-run, path, params incl.
  zones/tricks, duration ≈ 100–130 s, capture stepped, pilot {mode:'jev', fade:'never', consult:{withinM:3}},
  bounds {maxLateral:1.0, maxRise:0.8, maxSink:0.5, minSpeedScale:0.85, maxSpeedScale:1.05}, overlay
  {props:{style:'freestyle'}}, standingOrder ≤ 300 chars, cell '0x002B0371'), `site.json` (the egg-orchard site:
  teleport = a bottom stand point ≥ 10 m from both Surface portals, prime = 6–7 PVS hops top→bottom (≥ 6 m from
  portals), indoor true, cell, interiorLb), `verify.json` + a short README.

# Flight experience — handoff (running log; started 2026-11-01)

Brief: `WORKFLOW.md` (this folder). Design notes: `FAR-FORESTS.md` (Phase 2), `HIGH-BAND.md` (Phase 4),
`EYETEST.md` (Phase 5). Bench: `bench/`.

## Session 1 (2026-11-01 evening)

### What the code says today (read before trusting WORKFLOW §3.1 — two of its rows are stale)

| WORKFLOW §3.1 row | Today |
|---|---|
| Geometry governor (`MAX_LIVE_GEOM` 8000) parks beyond-ring LBs, cut residency 200 → 35 | **Not on the default arm.** The slot grid (`scene3d/residency_grid.js`, `?slotGrid`, DEFAULT ON since 2026-10-25 with the whole pipeline chain) is the residency authority; the LRU runs ASSERT-ONLY and the governor is deleted on that arm. Even on the legacy arm the 2026-10-07 `lbRingProtect` exempts the whole drawn ring. H2's governor half is moot by construction; the 200 → 35 number predates both. |
| One residency radius, LRU sizing | The grid: 6×6 tiles of 2×2 LBs (12×12 LBs ⊇ the 11×11 ring), anchor `floor((lb−5)/2)`, shift ±1 tile per 2 LB, vacated tiles park after 2 s hysteresis, pressure ladder instead of a count cap. |
| `objRadius` hard toggle | Unchanged: hide at d > N+1, show at d ≤ N (Chebyshev, centre = the rig's landblock); the grid's feeds gate objects with the same `objectBakeAllowed`. |
| Far ring `discard` keyed on the near ring's effective radius | Unchanged: a SQUARE around `uPlayerLbXy` of half-size `uNearFadeLb` (= measured near radius + 0.45). Any near landblock inside the square that is not drawn (not yet baked at the leading edge, parked) is a HOLE: far discarded, near absent. |
| Vehicle lead point via `__worldStreamer.onPositionUpdate` | Unchanged (scene3d/vehicle/index.js tickPilot). It also stamps `landblockLru.noteServerLb(lead)` and emits `landblockChanged` for the lead LB. |

Other findings while reading:
- `far_terrain.js playerLb()` reads `scene3d.currentLandblockKey` (never written anywhere) → `playerLbKey`, which only
  `terrain.js reconcileTerrainLodForCentre` updates — and only when the quality tier subdivides (`opts.canSubdivide`).
  At a non-subdividing tier the far ring's centre (discard square, patch ring, radius-policy check) stays at the
  spawn landblock for the whole session.
- Every landblock crossing re-bakes the subdivision level of the 3×3 under the player (`tickTerrainLodRebake`,
  one LB per frame): in flight that is a terrain re-mesh at 0-400 m every ~1.7 s.
- The residency sampler has to treat an in-flight LOD re-bake as drawn: the re-bake clears `terrainBakedLbs` while
  the old mesh stays on screen.

### Phase 0 — instrumentation (landed, flagged)

- `scene3d/residency_log.js` — `?residencyLog=on` (exact-match opt-in, default OFF). A per-frame SAMPLER over the
  21×21 LBs around the rig: terrain baked / parked, statics / buildings baked, objRadius-hidden, far patch drawn /
  discarded, slot-grid tile LIVE; every change is an event, plus direct events from the bake guard (start / done /
  fail, cap / cooldown / in-flight skip counts), the vehicle lead LB and the terrain LOD re-bake swap.
  `window.__residency`: `.flips(windowSec)`, `.leadTimes()`, `.holes()`, `.rows()` (1 Hz: pose, speed, AGL, drawn
  counts, holes, bakes, grid counts, fps / p50 / p99 / max frame, tree coverage 0-1 / 1-3 / 3-10 km), `.summary()`
  (incl. long-animation-frame script attribution), `.dump()`.
- Hooks: `stream_bake_guard.js` (rlogBake / rlogBakeSkip), `far_terrain.js` (probe: centre, nearFadeLb, patch
  coverage), `terrain.js` (LOD swap event), `vehicle/index.js` (lead LB), `index.js` (the per-frame tick next to the
  LRU / grid tick; the grid module handed over for tile states).
- Test: `tests/residency_log.test.mjs` (22 checks: flag grammar, bit derivations, flips, a simulated flight with a
  leading-edge hole, lead times, park flicker), registered in `harness/run-js-headless.mjs`.
- Bench: `bench/flight-runner.mjs` (laptop, the vehicles runner + evals from this folder), `bench/flight.eval.js`
  (per-leg boost / AGL / throttle), `bench/residency-dump.eval.js`, `bench/plan-fx0-baseline.json`.

### Phase 0 — measurements

The laptop cannot run the bench any more at today's defaults: earlyoom killed the headless renderer twice at
2.6-2.8 GB RSS during the 400 km/h leg (ACE + MariaDB + the session leave ~3.5 GB). All measurements are on the 1070
(MODE T, off-screen, muted, 30 fps cap, fresh profile per arm, `?skytime=12`), driver `bench/flight-1070.mjs`, route
`bench/plan-fx-tour.json`: Holtburg → 5 km at 225° over the densest forest near Holtburg (lane B's tall-tree census:
17 LBs ≥ 80 tall trees) at 300 km/h → 5 km back at 45° at 400 km/h across Holtburg → land. 80 m AGL. Results in
`/mnt/wbterminal1/tmp/claude-scratch/flight-experience/1070-<arm>/` (result.json, residency.json, stills, frames).

**Arm A — today's defaults (2026-11-01 21:05):**

| | |
|---|---|
| flight | 12.75 km, 0 corrections, RTT 54 ms |
| object window drawn in flight | **0 of 81 landblocks from t = 41 s to 133 s** (19-51 near Holtburg at the start, 81 back at Holtburg) |
| object lead time | 73 of 90 crossings never had objects while the aircraft was there; the other 17: p50 −17 s |
| terrain lead time | p5 9.7 s, p50 13.9 s (terrain is ahead — over-provisioned) |
| tree coverage | 0-1 km 12.8 %, 1-3 km 0.8 %, 3-10 km 0 |
| flips (10 s) | objects 0, terrain 0 |
| hard object toggles | 146 (every appear / disappear is a pop) |
| bakes | 3,177 started (terrain p50 5 ms, statics p50 229 ms / p90 531 ms, buildings 4 ms), 24,528 cap skips |
| fps (30 cap) | p50 25.2, p5 13.7; worst frame p99 383 ms; max after the first minute 173 ms |
| console | the far ring's RADIUS POLICY VIOLATION, at the landing |

**Root cause of "trees only around Holtburg" (H1/H5 rejected, a NEW cause):** the object window (`?objRadius`) was
centred on the wasm RENDER SET, which stops following the aircraft in flight. Measured: 603 of 641 object-window
hides fired at Chebyshev distance 4 from the aircraft — inside the window, where the rule only ever hides beyond 5 —
and 690 of 777 statics attaches landed at d = 4 and were hidden on arrival. The trees were baked (the 2026-11-01
tours' "0.96 of the window baked" was true) and then hidden. Fix: `?objWindowRig` (DEFAULT ON, `=off` escape;
cells.js `objectWindowCentres`) centres the window on the rig's landblock (the slot grid's own centre) and ticks it
every frame from index.js.

**Arm B — today's defaults + the object-window fix (2026-11-01 21:13):**

| | Arm A | Arm B |
|---|---|---|
| object window drawn in flight | 0 / 81 | **62-80 / 81** |
| object lead time | 73 / 90 never; p50 −17 s | **all 90 ready; p5 5.7 s, p50 9.4 s** (min −0.8 s) |
| tree coverage 0-1 km / 1-3 km | 12.8 % / 0.8 % | **76.8 %** / 1.9 % |
| flips | 0 / 0 | 0 / 0 |
| hard object toggles | 146 | 721 (objects now really appear at the window edge → Q2 fades) |
| fps p50 / p5 (30 cap) | 25.2 / 13.7 | 22.7 / 11.3 (more objects drawn) |
| worst frame after the first minute | 173 ms | 301 ms |

Hypotheses after A/B: H1 (flashing = the window toggle sliding at speed): the flashing the owner saw was the window
hiding fresh bakes against a stale centre; with the fix there are no flips, and what remains are hard toggles at the
window edge (pops). H2 (governor parking / discard square): the governor is gone on the default arm; the discard
square still makes holes (the residency log counts them; most are past the fog's far). H3 (bake throughput): for
objects it was masked by H-new; terrain is 10 s ahead, objects 6-9 s ahead with the fix. H4 (two centres): replaced
by `?flightResidency` (one centre, forward bias). H5 (no far tier): confirmed — 1-3 km coverage 1.9 % even with the
fix, and the fog closes at ~1.5 km; the world tier and far forests are the answer.

### Phase 1 — what the arms after B showed

**Arm C (`flightView=on&flightResidency=on`, the first try, 21:21):** three bugs of mine, all visible in the data:
1. 166 object flips (10 s windows; A and B: 0) — the flight BIAS: the rounded lead (≤ 2 LB) oscillated with speed and
   heading, the object window jumped back and forth; neither lead time improved (objects p5 5.7 → 3.6 s, terrain p5 7.7
   → 3.7 s). Now `?flightBias` (opt-in, default OFF); `?flightResidency` centres on the aircraft.
2. 77 corrections (A/B: 0-6) and AGL "None" mid-flight — removing the lead hack also removed the wasm COLLISION terrain
   prefetch (world_stream's position path), so `terrainHeightAt` went blind and the predictor lost its floor. Now
   `?flightResidency` feeds the world streamer the AIRCRAFT's own landblock on each crossing (one honest centre:
   noteServerLb / landblockChanged mean what they say) and prefetches the collision 3x3 at the lead point only
   (`window.__ensureCollisionTerrain`).
3. The world tier never started (`initWorldTerrain` required `?worldTier`; `?flightView` now implies it).

**Arm D (the fixes, 21:33):** 0 / 0 flips, 0 console errors, corrections 2 (0.22 m), lead p5 terrain 3.1 s / objects
3.1 s, 0-1 km coverage 74 %. The 400 km/h still shows lit hills to the horizon instead of fog cut-outs. Probe from the
kept page (free camera, `bench/probe-1070.mjs`): from 4.6 km the whole continent (inner sea, islands, ocean to the
horizon with aerial perspective); policy state as designed (w 1, far 85 km, fog 22-62 km, radial camera height 4,777 m).
Found by the probe and fixed: water glint far too wide (a white sheet looking down) → Fresnel + a tight glint; roads as
dotted lines → a lower threshold; the inner rings as a square seam from altitude → the far ring hides above 700 m
AGL; and **clouds vanish once the camera climbs into the deck** — a latent bug, not the flight work: takram's
`CloudsPass.update` recomputes `cameraHeight` from a WGS-84 ellipsoid immediately before the march (in our frame
AC z − 18 km), and cloud_overlay.js's patch ran after the render, so the march always took the "below" branch. Fixed by
`?cloudTrueHeight` (DEFAULT ON) above the deck base only; on-foot frames keep takram's value, and the haze (which the
negative height always zeroed) stays zero.

**Arm E (+ far forests, the cloud fix, the Phase 3 altitude terms, 21:58):** the forest runs to the horizon (stills
`/mnt/wbterminal1/tmp/claude-scratch/flight-experience/1070-E-forest/`), 0 corrections; numbers below.

| | Arm A (today) | Arm E (all tiers) | Arm F (+ fixes) |
|---|---|---|---|
| tree coverage 0-1 / 1-3 / 3-10 km | 12.8 % / 0.8 % / 0 | **98 % / 93 % / 21 %** | **97 % / 91 % / 21 %** |
| flips (10 s) objects / terrain | 0 / 0 | 0 / 0 | 0 / 0 |
| hard / soft object toggles | 146 / 0 | 51 / 694 | 43 / 671 |
| lead p5 terrain / objects | 9.7 s / never (73 of 90) | 6.5 s / 5.5 s | 3.1 s / 3.1 s (min 2.5 s; Q4 ≥ 2 s holds) |
| holes in flight | (square discard) | counted wrong: the world tier was not a bit yet | **0** (186 hole frames, all on foot before take-off / after landing) |
| far-forest instance rebuilds | — | 1,144 | **80** (margin + 1.5 s throttle) |
| fps p50 / p5 (30 cap) | 25.2 / 13.7 | 24.9 / 12 | 23.6 / 9.9 |
| worst frame p99 / max after 60 s | 383 / 173 ms | 846 / 215 ms | 1,688 / 289 ms |

Arm F's 1.7 s frame came at take-off, from the far forest's first impostor bake: a synchronous link of the
MeshBasicMaterial program. Another program per model was possible, because disposing a model's materials dropped
three's last reference to the program. Now both bake programs, the card program and the world-tier program link off
the frame (`compileAsync`), and dummies keep them alive. The hole metric now counts the world tier (`WT` bit), and the
tree coverage counts only landblocks the retail census has trees in.

### Phase 4 — the high band (server + client), arms G and H

Server (ACE fork; details and the reasoning in HIGH-BAND.md §5). All properties default 0 (off). Built to a side
directory, deployed at 22:01 and 22:44 with nobody but `agentp10` online (stop-now, copy, start, ~20 s). Rollback:
`/mnt/wbterminal1/tmp/claude-scratch/ace-rollback-2026-11-01-pre-highband/` (the DLLs from before this session).
Set live on the laptop's server:
- `vehicle_ceiling_agl 5000`, `vehicle_climb_max 40` (spawn-time overrides of the profile, sent to the client in the
  profile message);
- `vehicle_derelict_high_agl 600` (an empty vehicle high up despawns after 30 s);
- `vehicle_high_band_agl 600` (the pilot sees by 3D distance and wakes no monsters);
- the world edge 256 × 192 → 255 × 192 (landblock 0xFF does not exist).

**Arm G (`flightView` + `flightResidency` flags, `bench/plan-fx-high.json`: Holtburg → 3 km low → climb to 5 km →
6 km above the clouds → dive back → land; 22:03):**
- 37.3 km, AGL median 2,682 m, **2 corrections (0.22 m)**: the predictor stays exact with the raised ceiling. The
  climb ran at ~40 m/s; spawn log: `(ceiling 5000 m AGL, climb 40 m/s)`.
- fps p50 26.2, p5 12.9 (better than low cruise: little to draw at altitude).
- From 4.6 km: the deck below with gaps onto lakes, sea and desert, cirrus above, the continent to the horizon
  (stills `1070-G-high/07-*.jpg`, `09-*.jpg`). At 270 m on the way down: forest to the horizon, hills, snowy peaks.
- The storm towers eased into a deck: 168 look re-applies, 0 drift.
- 145 object "flips". These are not oscillation: objects attached at the wider window faded out into their impostors
  within 10 s as the window narrowed during the climb (radius 3 at 600 m, 2 at 1.5 km). The metric counts
  show-then-hide.
- Frames up to 0.8 s at 5 km, with ~45 statics/buildings bakes per 3 s for a radius-2 window of objects 5 km below.
  Now a radius-1 band above 2.5 km.
- CPU profile at 5 km: weapon FX 12 % of the main thread (every wielded weapon below ticked every frame; now every
  30th frame beyond 300 m); per-entity ticks ~15 %. The 3D sight above 600 m stops new ground objects reaching the
  pilot.
- The cloud tops from above showed salt-and-pepper speckle, also with a still camera, from takram's temporal upscale
  (one fresh pixel per 4x4 block per frame). A looser history clip did not help; the upscale off did. Now
  `?cloudHighBand` (default ON): every pixel at half resolution above ~1.8 km AGL, with the resolve variant linked
  first. The 1070 held 27-28 fps at 5 km.
- The vertical streaks on the cloud flanks stay. They are in the march itself (also with the upscale off), so they go
  on the eye-test list.

Low-cruise profile (arm G, 100 m, 400 km/h): my tiers are not in the top 45. The time goes to:
- the render: 24 %;
- entity spawns as server objects arrive: 11 %;
- statics bakes with their shader prewarm: 7-8 %;
- the wasm message pump: 13 %.

**Arm H — the DEFAULTS (no flight flags in the URL), the same high route, after the G fixes (22:16):**

| | Arm G (flags) | Arm H (defaults + fixes) |
|---|---|---|
| prediction | 2 corrections, 0.22 m | 3 corrections, 0.06 m |
| server objects reaching the client | 4,379 | **1,145** (the 3D sight above 600 m) |
| main thread at 5 km (CPU profile, 7 s) | ~2.5 % idle; weapon FX 12 % | **40.5 % idle**; weapon FX off the top list |
| fps p50 / p5 | 26.2 / 12.9 | 26.7 / **16.5** |
| longest task / LoAF | 1,284 / 1,278 ms | **367 / 366 ms** |
| worst frame after 60 s | 786 ms | 525 ms |
| tree coverage 0-1 / 1-3 / 3-10 km (treed landblocks only, the census) | — | 78 % / 92 % / 54 % |
| lead p5 terrain / objects | 2.8 / 1.8 s | 6.3 / 1.7 s (objects: radius 1-2 at altitude, see below) |
| world tier data load (lazy, at take-off) | 6.0 s | 2.6 s |

- The 298 object "flips" in H are the 10 s flip window meeting a radius-1 window at 400 km/h. A landblock enters
  and leaves a radius-1 window in ~5 s, so show-then-hide falls inside 10 s by construction. The on/off counts stay
  balanced through the flight (no oscillation), and the far forest is the complement there. The metric was tuned for
  the radius-4 window (~15 s through it).
- The far ring's RADIUS POLICY VIOLATION fires once per tour: arm A at the landing (today's defaults), arms E-H once
  in flight. It is a debug assertion of the far ring (a far landblock seen by a near-ring system), transient and not
  visible. It predates this work; `?farDiag=off` silences it. Not chased.
- Not changed by this work: low cruise is still main-thread bound at ~1 % idle (render 29 %, the wasm message pump
  15 %, entity spawns, statics bakes with their shader prewarm). That is the client-wide frame budget, not the
  flight tiers (none of them in the top 45 functions).

**Arm I — bail-out from the high band, defaults + `?cloudHighBand` + the fall pose (22:31; `bench/plan-fx-bail.json`:
a low hop, land, re-spawn, then the vehicles bench's `vehicle-fall-pose.eval.js` climbs and bails):**
- Bail at **5,005 m AGL** (server log), free fall **104 s**, the chute at 150 m, touchdown after **121 s**.
- **All 10 fall-pose checks pass on the 1070**: Falling motion, arms spread and the pack packed in free fall; the
  canopy grip clip, hands up on the risers, the pack flattened and the canopy drawn under the chute; released and
  not falling after touchdown. Human male fit, pack 0.34 × 0.38 × 0.15 m.
- The empty Hellcat despawned 30.0 s after the bail ("derelict high", `vehicle_derelict_high_agl 600`).
- `?cloudHighBand`: the resolve variant was prewarmed before take-off; one switch on the climb, between 1.9 and
  2.6 km. The deck from above is SMOOTH (stills `1070-I-bail/07-*.jpg`, `13-*.jpg`; compare G's `09-*.jpg`). No
  hitch at the switch: the worst frame after the first minute is **125 ms**, the best of all arms (G 786, H 525).
- fps p50 26.7, p5 14.4; tree coverage (treed landblocks) 99 % / 93 % / 33 %; terrain flips 0.

ACE vehicle tests (`dotnet test … --filter Vehicles`, Debug): 9 / 9 pass with the high-band and fall-motion changes.
The server now runs that build (deployed 22:30, the third restart tonight; `vehicle_fall_motion` left at its default,
off).

**The full JS gate** (`capped-build node harness/run-js-headless.mjs`, once, at 22:40): 977 passed, 1 failed of 978.
- The failure was the gate's L4 log-depth audit (`test_shader_logdepth.mjs`). The world tier's and the far forest's
  ShaderMaterials carried the reversed-Z handling but not the log-depth chunks, which the log buffer fallback needs
  (a GPU without EXT_clip_control, or `?reversedZ=off`).
- Fixed: both are wrapped in `withLogDepth`, and the world tier has a `gl_FragDepth` twin of its depth push. Under
  reversed-Z all of it compiles out.
- Re-run through the harness: the audit plus every affected entry pass (11 / 11), so all 978 pass now.
- **Arm J** (`bench/plan-fx-smoke.json`, `--flags reversedZ=off`, 22:59) is the GPU smoke of the fallback:
  - both programs linked;
  - no shader / program errors (only the known far-ring assertion);
  - 0 corrections, coverage 98 % / 95 % / 33 %;
  - the same look as arm H at the same height (stills `1070-J-logdepth-smoke/03-*.jpg` vs `1070-H-defaults-high/03-*.jpg`).

## State at the end of the session (2026-11-01 ~23:00)

Default ON now (each with an `=off` escape):
- `flightView`, which bundles `worldTier`, `farForest` and `lbFade`;
- `flightResidency`;
- `objWindowRig`;
- `cloudTrueHeight`;
- `cloudHighBand`;
- `vehicleFallAnim` (the bail-out agent).

Opt-in on purpose: `residencyLog` (instrumentation), `objFade` (unwired), `flightBias` (measured negative).

Acceptance (WORKFLOW §2):

| | Verdict | Evidence |
|---|---|---|
| Q1 trees to ≥ 3 km | **met** | the far forests to 4.5-8 km; tree coverage 1-3 km 91-93 %, 3-10 km 21-54 % (impostors past ~5 km thin into the canopy tint) |
| Q2 no popping | **mostly; eye test** | the window edge is a presence crossfade with the impostors: soft 671-1,521 vs hard 43-230 toggles per tour (arm A: 146 hard, 0 soft). The remaining hard ones are not localized yet (`?residencyLog` STATE events carry them) |
| Q3 no terrain flicker / holes | **met** | terrain flips 0 in every arm; 0 holes in flight (hole frames only on foot before take-off) |
| Q4 lead p5 ≥ 2 s at 400 km/h | **met for terrain**, objects borderline at altitude | terrain p5 5.5-6.3 s; objects p5 2.5 s low (arm I), 1.7 s with the radius-1 window at 5 km (objects there are a few px) |
| Q5 ≥ 60 fps cruise, p99 ≤ 33 ms, no frame > 100 ms after 1 min | **not met (client-wide)** | the 1070 under its 30 fps off-screen cap: p50 26-27, worst frame after 60 s 125 ms (arm I), was 173 ms on today's defaults (arm A). Low cruise is main-thread bound in pre-existing systems (render, the wasm message pump, spawns, bakes); none of the flight tiers is in the top 45 functions |
| Q6 high band ≥ 4,500 m AGL | **met** | 5,000 m reached in 3 arms, above the deck, continent to the horizon, down again without holes |
| Q7 no on-foot regression | **met by construction; eye test** | the policy weight is 0 on foot (the player's height, never the chase camera's); the presence field changes the far-ring hand-off on foot too, per landblock instead of a square (fewer holes) |
| Q8 retail compatibility | **unchanged** | all server changes behind properties defaulting off (§ HIGH-BAND 5, 7) |

Next steps, in order:
1. The owner's eye test (EYETEST.md).
2. The storm look's vertical streaks / curtains from above and inside (HIGH-BAND §4).
3. The low-cruise frame budget (not the flight tiers).
4. ACE: a relocation without adjacents above the band.
5. A commit of `~/ace-server` + the patch regeneration when the owner says.

Decisions from WORKFLOW §9 that I took under the session's agency grant ("you have agency to improve user
experience"). All are reversible, and EYETEST.md asks the owner about each:
1. **Trees**:
   - real trees within the object window: 4 landblocks low, narrowing with altitude (3 / 2 / 1);
   - impostors to 4.5 km at low altitude, out to 8 km from 2.5 km up.
2. **High band**:
   - ceiling 5,000 m AGL (the existing AGL model, not a level ceiling);
   - climb 40 m/s;
   - no speed growth with altitude.
3. **Ground interaction for a high pilot**: dropped above 600 m. The pilot sees by 3D distance and wakes no
   monsters. Both are properties, set live, 0 = off.
4. **The look**:
   - the storm's towers flatten into a deck above 1.8 km;
   - the every-pixel cloud march above the deck;
   - ocean to the horizon (the world tier runs 74 km past every map edge).
5. **Defaults**: the validated flags went default ON under the project rule (a validated gate ships default-on with
   an `=off` escape).

## Session 1, continued (2026-11-01 23:00 → night): Q5 work and the storm look

The owner: on-screen, uncapped fps runs are allowed from 01:30 to 05:30 NST. A clock monitor tracks the window, and
`bench/flight-1070.mjs --uncapped --onscreen` refuses outside it. Cloud fixes are in scope and may apply widely.

**Where the low-cruise frame goes** (arm H, 1070, CPU profile at 100 m / 400 km/h; ~1 % idle under the 30 fps cap):

| Share of the main thread | What |
|---|---|
| render | 25-29 % |
| async wasm streaming decode | 9-15 % |
| statics bakes + program prewarm / deferred links | 12-16 % (links: cold shader cache in every bench run — a returning player's cache is warm) |
| texture uploads | 5-7 % |
| entity spawns + ticks | 5-10 % |

None of the flight tiers is in the top functions. The continuous load is streaming at speed. The long frames come
from the bursts when the window advances: about 25 bakes, tile moves and attaches landing in the same second.

**Changes** (all measured on the 1070, capped, off-screen; arms K-O):
- `?flightLight` (default ON). While the aircraft is airborne above 40 m: no building interiors (EnvCells: a decode,
  a bake and a lights rescan on every crossing) and no wall-collision AABB prefetch. Both load at the first position
  update on the ground. The world streamer's call sequence is unchanged; the drift guard pins it.
- The object window drops to radius 3 while airborne in the low band (49 landblocks of real meshes instead of 81). The
  far forests carry the trees beyond on the presence crossfade. Bands above: 3 / 2 / 1 at 600 / 1,500 / 2,500 m.
- `?flightPrewarm` (default ON, only on a vehicles page). 20 s into the world, the flight tiers prefetch at idle:
  world grids and program, far-forest index and programs, and the 64 impostors trickled one at a time.
  - Arm K, cold take-off: a 3 s frame starved the server of inputs past 2.5 s, and the predictor took a 34 m
    correction.
  - Arm L: 0 corrections, longest task 583 ms (K 1,496), lead p5 8.0 / 3.7 s (K 2.9 / 2.4).
- The static atlas's 10 Hz pass has per-tick budgets: 4 ms of normal/rough/AO repacks and 6 ms of bucket compaction,
  the rest next tick. It was every pending layer and every dirty bucket in one call (a 210 ms span in arm H). This
  helps on foot too.
- The near grid freezes above 3 km AGL (thaws below 2.5 km). The world tier draws the ground there, and every grid
  move re-baked tiles nobody can tell apart (arm N: ~25 bakes and 12 tile moves in one second at 5 km, a 0.5 s frame).
- Tried and REVERTED: a 4-in-flight cap on stream bakes while airborne. It also throttles terrain: lead p5 dropped to
  1.7 / 1.3 s and hole frames rose 89 → 435 (arm M vs J).

**The storm, flown through** (owner: "if you have to fix clouds etc thats not out of scope"). The 1070 A/B
(`bench/cloud-ab-1070.mjs`, a forced storm on a kept page, 1.2 km and 5 km) found:
- the vertical streaks are NOT the light shafts, the march step (15 m / 900 iterations), nor the shape detail;
- they are the cumulonimbus layer: the 2D weather map extruded through 6 km with a sharp coverage edge;
- inside it (0.6-6.6 km) the view is a featureless murk.

So while the aircraft is up (blend 0 → 1 above 900 m AGL, back below 700 m, eased over 10 s):
- the tower FADES OUT (density × 0.02, height 6,000 → 1,900 m);
- the cumulus deck's tops round off (r / g shapeAlteringBias 0.35 → 0.7);
- a wider coverage filter was rejected: it closed the gaps into one overcast sheet.

The result (arm N stills): at 1.7 km you fly in soft cloud with the deck around you; at 4.7 km there is a deck of
separate rounded cumulus with gaps onto the ground, no streaks, no speckle. The every-pixel march (`?cloudHighBand`)
keeps its own above-deck blend at 1.8 km. Ground players never see either.

**Measurement caveat**: the driver's exact rAF recorder is valid only on uncapped runs. Under the 30 fps cap, rAF
ticks at the display rate while the loop renders every other tick, so a capped run's `frames` block is NOT frame
time. Capped runs use the residency rows (`fps`, `frameMax`).

### Q5 measured on screen, uncapped (owner OK; 2026-11-02 from 00:17 NST)

Setup: `bench/flight-1070.mjs --uncapped --onscreen --owner-ok --profile-dir night`.
- The window is maximized on the owner's 1920 × 1050 screen, still `--mute-audio`.
- `?targetFps=0` + `--disable-frame-rate-limit --disable-gpu-vsync`.
- A reused Chrome profile gives a WARM shader cache, as a returning player has.
- Route: `plan-fx-tour-settle.json` (the low tour: 300 then 400 km/h at ~90 m AGL, 12.8 km).
- Frame times come from the driver's exact rAF recorder (valid uncapped).

| Run | What | Flight fps (mean) | p50 / p99 | After the first minute: fps / p99 / max | On foot (standing, Holtburg) |
|---|---|---|---|---|---|
| U0 | cold cache, residency log on | 37.5 | 24.1 / 75.1 ms | 40.4 / 54.8 / 199 ms | (cold, prefetch running) |
| U1 | warm, no log | 39.8 | 23.2 / 65.9 ms | 40.6 / 54.4 / 119 ms | 44.2 fps |
| U2 | + the punch disarm while airborne, the bound height sampler, the far-forest / world-tier allocation cuts | **42.8** | 22.1 / 55.6 ms | **43.0 / 51.0 / 105 ms** (one frame > 100 ms) | 44.3 fps |
| U3 | A/B: `?objRadius=2` everywhere | 45.2 | 21.0 / 53.7 ms | 45.4 / 50.8 / 104 ms | 49.5 fps |
| U4 | U2 + the flight entity horizon (450 m) | **45.1** | 21.1 / 53.0 ms | **45.3 / 49.0 / 97 ms — no frame > 100 ms** | 46.5 fps |
| U6 | U4 + the origin-first entity tick gate | 44.8 | 21.2 / 53.0 ms | 45.3 / 49.0 / **84 ms** | 45.4 fps |
| U7 | U6 + the terrain VFX hold while airborne | 44.6 | 21.1 / 54.3 ms | 45.6 / 51.4 / 87.6 ms, no frame > 100 ms | 45.4 fps |
| V1 | U7 + the green-lines fix (`?lbBand=open`) | 45.0 | 21.0 / 53.3 ms | 45.5 / 50.1 / 123 ms (one frame > 100 ms) | 47.9 fps |

⚠ All rows above ran with vsync OFF and the CDP screencast ON; see "The night's last runs" below for what each did
to the numbers.

What the profiles say (U1p, a CPU profile on foot and two at cruise):
- The main thread is ~99 % busy on foot AND in flight, so the client is CPU-bound at ~22-23 ms per frame on this box.
- About half of that is render submission (three.js + the draw executor, uniform uploads) and ~20 % is native time
  (WebGL/ANGLE calls, GC).
- Flight now costs ~3 % more per frame than standing in Holtburg. Q5's 60 fps is a client-wide CPU budget, not a
  flight cost: the same bar fails on foot.

Found and fixed on the way:
- `tickPortalPunch` (the doorway punch into building interiors) ran terrain line-of-sight rays over every aperture of
  Holtburg's still-resident interiors every frame in flight: ~6 % of the main thread. It is disarmed while airborne
  (`?flightLight`), the same path as indoors.
- Its height sampler read `window.__sessionHandle.terrainHeightAt` through the rejection-feedback Proxy on every sample
  (the trap alone was 1.7 %). The method is now bound once, which helps on foot too.

More found and fixed with the uncapped profiles (U4-U7):
- **The entity census at 100 m AGL**: 842-923 entities resident, ~13k part meshes in the scene. The frustum from an
  aircraft takes in kilometres of ground, and every rig in it was submitted (~40 part draws per humanoid, a few pixels
  each). While airborne, rigs beyond 450 m of the camera are no longer submitted (`FLIGHT_ENTITY_CULL_M`, entities.js
  tickEntityRenderVisibility). Vehicles, the local player, wielded children and light-bearing rigs are exempt
  (tests/entity_cell_cull.test.mjs C11). U2 → U4: 42.8 → 45.1 fps, and no frame > 100 ms after the first minute.
- **The entity tick gate** (`_shouldTickEntityHoisted`, 6 % of a frame in the profile) composed every rig's world
  matrix, with a ground-height sample in the visual-ground updateMatrix, just to read its origin for a 120 m test. Now
  `root.position` through the group's matrix decides, and a rig that passes is updated exactly as before. The `=off`
  path is mirrored, and tests/rust_rig_parity.test.mjs G pins them identical. Within noise in fps (U6); a cheaper
  frame on foot in towns.
- **The near-ground terrain VFX** (grass, pebbles, the trail) re-scattered around the pilot every frame at
  400 km/h: 2.8 %. It holds while airborne (`terrain_vfx.js`, the same `?flightLight` band).

Draws per frame at cruise: ~360-410 calls, 4.5 M triangles. The remaining frame is three's per-object work (scene
traversal of ~13k objects, uniform uploads, ~25 µs per draw through ANGLE) and the composer. It is flat: no single
system is above ~9 %.

## The night's last runs (2026-11-02, 00:50 → 02:30 NST): the green lines, two measurement traps, the high band's frame

The owner opened the 1070 for on-screen uncapped runs at any hour ("onscreen 1070 uncapped fps testing now
available"); the clock monitor was stopped.

### The owner's "green lines in square shape on terrain" — fixed, verified

- **Cause** (an Opus 5.5 agent, no subagents, investigated and fixed it; verified here): a regression of this
  session's presence-field hand-off. Under every near-drawn landblock the far ring and the world tier kept a 10 m
  band along EVERY edge. The near ring draws 1 cm below grade (retail zFightTerrainAdjust) and their reversed-Z
  push is relative (mm at 100 m), so the band won the depth test: a 19 m strip of flat, shadow-less far ground
  centred on every landblock edge, a lime grid on foot and in the whole low band.
- **Fix** (`?lbBand`, default `open`; `lb_presence.js` `LB_HANDOFF_GLSL`, one rule for both tiers, plus a CPU
  mirror): the band only along edges where the near ring ENDS. Between two near-drawn landblocks the near ring is
  watertight by itself. `=all` reproduces the old rule, `none` drops the band (the crack A/B).
  `tests/lb_handoff_band.test.mjs` (37 checks).
- **Verified** (V1, on screen, same route and frames as U1): U1's landing still shows the lime grid across the
  hills; V1's has none. On foot, U1's hard line past the player is gone. 0 console errors.
- Known, left open: the world tier still draws under the far ring's patches and its alternating cell diagonal can
  poke through where it stands higher (HIGH-BAND §1).

### Two measurement traps (everything before U9 carried both)

1. **Vsync off made the altitude stalls.** U8 (the high route, storm) with `--disable-gpu-vsync
   --disable-frame-rate-limit` broke into 0.3–2 s stalls above 1.8 km: 87 s of long tasks in 181 s. The same route
   with vsync on (U9a; `--vsync` = `?targetFps=0` only, as a player runs Chrome): no long task above 1.8 km, worst
   frame 92 ms (1.8–4.5 km). With vsync off Chrome keeps queuing frames into a GPU that is already behind, and the
   main thread blocks for the backlog at the next GL round trip.
2. **The bench's video cost 10–25 %.** The CDP screencast (a GPU readback + a JPEG per frame) was on by default.
   U9a → U9c (vsync on, screencast off): < 450 m 37.0 → 41.8 fps, 0.45–1.8 km 64.5 → 81.9 fps. Q5 runs now use
   `--vsync --no-video`.
- The 1070's screen is 120 Hz, so with vsync a frame presents on 8.3 ms steps: a 22 ms frame shows as 25 ms.

### The high band's frame (GPU: the every-pixel cloud march)

A live A/B mid-flight at 5 km (`bench/fps-ab-1070.mjs`, run in-process by `flight-1070.mjs --ab` — a second node job
alongside the run is refused by the laptop's one-heavy-job guard; paired screenshots 0.7 s apart, since the chase view
moves at 400 km/h). Full table: HIGH-BAND §4.
- The light shafts were the largest single cost (39 → 65 fps over the storm deck without them) and are invisible
  from above. `?cloudHighBandMarch` (default ON) turns them off in the high band through the uniform `?cloudNight`
  already scales (`maxShadowLengthRayDistance` × 0; one writer, no define flip, restored on the way down) and drops
  the ground-bounce samples (they light the deck's undersides).
- Result at 5 km: storm 39 → 52–53 fps, fair 33.5 → 43–45 fps.

### The fair look from the air

Fair weather's alto deck (3.5 km, density 0.004) is a faint veil from below; from 4–5 km it lay over the whole view
as one grey-lavender sheet. While the aircraft is up it thins (× 0.1) and the cumulus tops round off as the storm
deck's do. U12 stills: towering cumulus beside you at 1.6 km, a sea of clouds from 2.6 km, a bright cloud field to
the horizon at 5 km. Frame rate unchanged.

| U12 (fair, vsync, no video; new march + look) | < 450 m | 0.45–1.8 km | 1.8–4.5 km | ≥ 4.5 km |
|---|---|---|---|---|
| fps median | 44.5 | 78.2 | 37.3 | 43.6 |
| worst rAF window | 167 ms | 83 ms | 300 ms | 83 ms |

### Bench changes tonight

- `flight-1070.mjs`: `--vsync` (uncapped without the vsync-off switches), `--fair` (force fair weather), `--ab ARMS
  --ab-agl M [--ab-fair ARMS]` (the A/B mid-flight; ends the route early through `window.__vehicleRun.stop`), and a
  run that ends in the air now re-homes the character before Chrome closes. Without it the server unseated the body
  onto the ocean below; the next login landed in the sanctuary, its @teleloc and vehicle spawn failed (U9b).
- `fps-ab-1070.mjs` (module + CLI), `band-summary.py` (fps by AGL band from the flight rows), `plan-fx-high-short.json`,
  `plan-fx-high-ab.json` (two 10 km squares at 5 km).

### The owner's YouTube film (2026-11-02, 02:15 → 04:30 NST)

The request: Holtburg → the desert; two players killed with the gun, from the pilot's view AND from a player's view
behind them with the Hellcat coming at them; the ascent to the ceiling; through the clouds; over a body of water; the
jump and the parachute down into a town, and the end. Later: cuts are fine as long as it is in-game footage. 60 fps
dropped as a goal ("the fps is ok for now").

**Output**: `/mnt/wbterminal2/film-projects/hellcat-2026-11-02/edit/hellcat-youtube.mp4` — 1920x1080, 30 fps, H.264
High (CRF 17), silent, ~2:35, a title card over the opening, dissolves between time jumps, cuts in the action.
The takes, their beat events and the edit list sit next to it (`takes/`, `edit/edl.json`).

**How it was shot** (`bench/film-hellcat-1070.mjs` + `film-hellcat.eval.js`, cut by `film-hellcat-assemble.py`):
- Three logged-in pages in the 1070's off-screen, muted test Chrome, each in its own off-screen window: the pilot
  (`agentp10`) and two victims, the level-1 characters "Funnel Probe" (`agentp07`) and "Funnel Probe Two"
  (`agentp08`); ACE shows admin-account characters with a "+".
- Recording: film mode's own WebCodecs recorder (`scene3d/film/runtime/recorder.js`, H.264 1920x1080) on
  `ensureFilmHooks(liveScene3d).addPostRender` — the vehicle's camera owner shares those hooks — on a fixed 30 fps
  grid (a slow frame is held). The canvas only: no HUD in the picture.
- Takes: A = the whole flight from Holtburg (chase view); K = the kills from the cockpit; B = the ground view, victim
  1's page recording with its camera parked 6 m behind the player; D = the bail into Al-Arqas.
- The kill site: a rise at 48 m, 1.4 km north-east of Samsur, with a valley 26 m lower along the last 60-200 m of the
  approach from Holtburg, so the Hellcat at its 30 m floor fires at -2°. Take A's flat site left the floor 30 m
  above the targets: the required nose angle swept -15 → -25° in a second and the gun never lined up.
- Server (ACE, both default off, set for the shoot and set back afterwards): `vehicle_gun_players` (the gun hits
  players on foot through their own damage path) and `vehicle_observer_sight_radius`.

**Found on the way**
- The CDP video drain shares the SSH tunnel with the game's websocket. Drained during take A (6 MB a call), it
  delayed the pilot's inputs: hundreds of prediction corrections, some over 100 m. The takes after it drain once the
  action is over (3.4 MB/s then).
- **ACE crashed at 03:23** (down ~6 min): take A's eval ended with the Hellcat still flying, it drifted into the map's
  north-east corner, and when the pilot's session dropped `Unseat` put the body in landblock (254, 254), whose
  adjacents ACE cannot load (`LandblockManager.GetLandblock` IndexOutOfRange on the world thread). Fixed: the body's
  placement is clamped to landblocks 1-253. Deployed at 03:29 (rollback copies under
  `/mnt/wbterminal1/tmp/claude-scratch/ace-rollback-2026-11-02-*`); the pilot's saved position was reset to
  Holtburg in the DB while the server was down. The film driver now despawns before closing.
- **The far-forest impostors were grey cards** for every tree the near tier had not already loaded:
  `far_forest.js` passed the `surfacePixelsFetcher` FACTORY to the material cache, so every miss came back as the
  grey fallback (white-ish in the desert sun — the specks on the desert horizon in the film). Fixed (the fetcher
  instance; a part that still falls back is left out of the bake), `tests/far_forest.test.mjs` FF-SRC. The film's
  desert shots still carry the specks.
- Open: the observer sight radius did not reach victim 1 after its teleport (in take B the Hellcat shows ~1 s before
  the pass); the eval misses a death whose corpse arrives out of sight (the server log has every corpse).

### The film reshoot (2026-11-02, 05:00 → 12:00 NST) — "a lot of issues with freezing"

Diagnosis: the encode was fine; the FOOTAGE froze. Two defects: world freezes (take A's climb / clouds / sea / ceiling, up to
10 s: prediction stalls from live CDP drains sharing the SSH tunnel with the game websocket) and recorder holds (repeated
frames). Root cause of the holds (take A3's shooter): the UNCAPPED recorded page saturates the 1070 and starves the
WebCodecs encoder's input copies (queue into the thousands, NVENC idle). Fix: `film-hellcat-1070.mjs --rec-cap 30` (now the
DEFAULT for every take: a 30 fps runtime cap + a sequential grid sampler), drain only after a take, despawn before the flush.
A held slot is RE-ENCODED, so it is not md5-identical: `bench/film-qa.py` now counts SOFT HOLDS (diff < 0.1, or < 40 % of the
local motion for a keyframe-coded copy) in moving windows (`motion` >= 0.5), with `--strict` for a smoothed master; by it the
first cut's "clean" take-A lift-off and forests were 41 % held. New `bench/film-smooth.py`: rebuilds held runs of <= 5 frames
by motion interpolation (minterpolate fed only the 4 frames around each gap; skips camera switches / too-fast A→B jumps);
`film-hellcat-assemble.py --smooth` (per-segment `"smooth": false` opt-out). Limit: in fast low cockpit flight the in-betweens
of large near objects double (cacti, rocks) — those shots are cut as recorded.
Takes (project `/mnt/wbterminal2/film-projects/hellcat-2026-11-02/takes/`): A3 (journey + climb + clouds + ceiling, pilot page
only) and A3a; B2 (ground view on the green player's page, camera behind the blue one; ACE grants the observer radius only on
the observer's own CELL CHANGE and admits <= 24 new objects per crossing, so the driver steps the observer across a cell line
until nothing new arrives — Hellcat first seen at 364 m); D2 → D2-2 → D2-3 (fresh pilot page + an unrecorded rehearsal bail
links every near-ground shader first: no stall; landing 9 m from the aim on the Al-Arqas oasis grass; --bitrate 10 M).
Master v2 = `edit/hellcat-youtube-v2.mp4` (154.7 s, every shot strict-clean bar fades; Taildropped). Its known residue: a
one-frame flash at 0:57, warped in-betweens in the K cockpit shots, a seam / dither whiteout in the cloud entry, a one-frame
camera pop at the jump, the film opens just after lift-off, the second kill falls out of frame. A v3 cut (fixes chosen, not
encoded) was stopped on the owner's call.
Client bugs found by the footage, fixed (tests: vehicle_bail_handoff H1-H9 new, lb_presence P3c; full gate 981 PASS):
- The "water quad" = a SKY HOLE: `lb_presence.js` kept stale "near terrain drawn" claims for landblocks left > 12 LB behind (a
  frozen high-altitude grid, then a re-home); the world tier discarded them and takram's dark planet ground showed through.
  Claims outside the drive square are re-checked against the real reads (a small out-of-square set, rebuilt on centre moves).
- Bail: the seat release arrives before the Bail event — the fall twin now keeps the aircraft's velocity (no 440 m snap at
  the chute), the fall pose is interpolated between fixed steps (no alternate-frame judder), and a BAIL_HANDOFF keeps the chase
  camera, dead-reckons the empty aircraft at >= its bail speed and blends 1.2 s into the fall camera (no vanished aircraft /
  camera pop); continuity bounded in tests (no backward step, <= 1.5x frame-to-frame).
- Review fixes: an airborne teleport no longer re-locks the body to the empty seat (client `onTeleport` + ACE patch 0005),
  dispose during a hand-off clears the lock, a ground exit no longer flashes the aircraft at its old parked spot, and the
  observer track's playback clock slews (<= 10 %) instead of jumping a fresh track ~4 m in one frame.

## State at the end of the night (2026-11-02 ~04:30 NST)

New default-ON tonight (each with an `=off` escape): `lbBand=open` (the green-lines fix), `cloudHighBandMarch`; the
fair look's high band (alto veil thinned, tops rounded) rides the existing `flightView` blend. Fixed without a flag:
the far-forest impostor bake (grey cards). ACE: two new properties for the film, both back at their defaults
(`vehicle_gun_players` false, `vehicle_observer_sight_radius` 0), and the edge-clamp crash fix (deployed); the server
change is committed in `~/ace-server` (`00521d9`) and travels as `../vehicles-2026-11-01/ace/0004-Vehicles-holtburger-fork-the-high-band-the-bail-out-.patch`.

| | Verdict | Evidence |
|---|---|---|
| Q1 trees to ≥ 3 km | **met**, and now textured everywhere | the impostor bake fix: before it, a login away from Holtburg baked 60 / 64 models grey (white specks in the desert) |
| Q2 no popping | **mostly; eye test** | unchanged since the presence crossfade |
| Q3 no terrain flicker / holes | **met** | + the owner's green grid fixed (`lbBand`), verified V1 |
| Q4 lead p5 ≥ 2 s at 400 km/h | **met** (terrain), objects borderline at altitude | arm O: 8.4 / 2.6 s low; U13 (full high route) 1.7 / -0.04 s with the radius-1 window at 5 km |
| Q5 frame rate | **dropped by the owner** ("getting 60 fps is no longer a goal the fps is ok for now") | on screen, vsync, no video: ~42-50 fps low cruise, ~77-82 fps at 0.45-1.8 km, ~37-42 fps climbing 1.8-4.5 km, 44-53 fps at 5 km |
| Q6 high band ≥ 4,500 m AGL | **met** | 5,000 m in every high run; the fair look from above fixed tonight |
| Q7 no on-foot regression | **met; eye test** | the green grid was an on-foot regression of the presence field — fixed |
| Q8 retail compatibility | **unchanged** | every server change behind a property defaulting off |

Next:
1. The owner's eye test (EYETEST.md, items 6b-6d new).
2. The define-off light shafts in the high band (+12 fps at 5 km) with the clouds program's other variant prewarmed.
3. The storm deck's curtain streaks seen from above, in places.
4. The observer sight radius after a teleport (the film's ground view).

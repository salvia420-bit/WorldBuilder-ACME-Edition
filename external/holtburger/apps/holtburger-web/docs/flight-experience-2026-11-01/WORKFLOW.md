# Flight experience — workflow for a dedicated session (written 2026-11-01)

Goal: make flying in holtburger-web look and feel high quality — the world stays full of trees and terrain at speed,
nothing flashes in and out, landblocks never flicker or arrive late — and open a new flight band far above today's,
roughly 10x the current ceiling, so a pilot can climb through the cloud deck and fly above the clouds.

Owner's words (2026-11-01, after the 1070 tours): "im not seeing many trees during the actual tour, only around
holtburg, and those trees flash in and out, landblocks flicker or are slow to stream in. we need a comprehensive
solution … investigate the experience at much higher altitudes, maybe over 10x what we have today, the idea being that
one can fly above the clouds."

This is a new session's brief. Read it all before running anything; every section is load-bearing.

---

## 1. Read first (in this order)

1. `~/CLAUDE.md` — laptop rules (8 GB). One heavy job at a time, `capped-build`, never `cargo --workspace`.
2. This file.
3. The vehicles work it builds on: `../vehicles-2026-11-01/HANDOFF.md` (session 2 section especially),
   `../vehicles-2026-11-01/DESIGN.md` (decisions 1-53), `../vehicles-2026-11-01/EYETEST.md`.
4. Memory: `~/.claude/projects/-home-wbterminal/memory/fleet-runbooks.md` (the 1070 — MODE T rules) and `ace-live.md`
   (ACE restart recipe). `MEMORY.md` is read-only.
5. The streaming / LOD modules named in §3 — read the header comment of each before changing anything; they carry the
   history of why each number is what it is.

## 2. What "high quality" means here — acceptance criteria

Measured on the 1070 (the owner-baseline GPU) at `quality=high`, with the instrumentation from Phase 0. Numbers are the
proposed bar; the owner may move them (§9).

| # | Criterion | Bar (proposed) |
|---|---|---|
| Q1 | **Trees where retail has trees**, low band (30-450 m AGL, today's envelope) | Trees visible out to ≥ 3 km (near: real meshes; far: impostors), everywhere the retail scenery tables place them — not only near towns |
| Q2 | **No popping / flashing** | 0 visible flips of an object or landblock that stays in range: anything that appears stays until it leaves range, and every appear / disappear at a range boundary is a fade (crossfade / dither), never a hard toggle |
| Q3 | **No terrain flicker, no holes** | 0 frames with a near/far seam gap or a landblock toggling between representations while in view |
| Q4 | **Streaming keeps ahead** | at 400 km/h, terrain + near objects for the landblock under the aircraft resident ≥ 2 s before arrival (lead time p5 ≥ 2 s); far tiers never empty ahead of the aircraft |
| Q5 | **Frame rate** | cruise ≥ 60 fps, frame-time p99 ≤ 33 ms, no frame > 100 ms after the first minute (uncapped runs need the owner's OK, §6) |
| Q6 | **High band** | climb to ≥ 4,500 m AGL (10x today's 450 m ceiling) and cruise above the cloud deck; the whole continent reads correctly to the horizon; climbing through and descending out of the clouds looks right; descent restores full detail without pops |
| Q7 | **Nothing regresses on foot** | the on-foot experience (Holtburg orbit, a town walk) is unchanged or better: same fps, no new pops |
| Q8 | **Retail compatibility** | unchanged: retail clients still connect and see the stand-in; any server change stays behind a property defaulting off |

## 3. What is already known (facts, with where they come from)

### 3.1 The pipeline today (read the code before trusting these)

| Fact | Where |
|---|---|
| One residency radius: `RESIDENCY_RADIUS_LB = 5` → an 11x11 terrain ring ≈ 960 m horizon; reaper keep-zone 8; LRU sizing radius 6 (cap 203 LBs) | `scene3d/residency.js` (header table) |
| Objects (statics + buildings, which include ALL procedural scenery = trees) only within `?objRadius` (default **4** = 9x9; the vehicle tours used **3**), hidden beyond N+1 with spatial hysteresis, shown again at ≤ N — a **hard visibility toggle**, no fade | `scene3d/object_radius.js` |
| Retail itself builds statics / buildings / scenery ONLY on the 3x3 around the viewer (LScape block sizes; `CLandBlock::init_static_objs` gate) — far trees are a BEYOND-RETAIL feature ("retail = correctness oracle, renderer = modern GPU") | `object_radius.js` FIDELITY note (acclient.c symbols cited) |
| Geometry governor: when live geometry > `MAX_LIVE_GEOM` (8000) it PARKS the oldest beyond-ring landblocks; on a long tour it cut resident LBs 200 → 35 (effective radius ~3) | `scene3d/landblock_lru.js:320-345`; `far_terrain.js` "effective radius" note |
| Far Composite Ring: beyond the near ring, terrain-only 4x4-LB patches with a baked albedo, default radius 8 LB (1,536 m), ON since 2026-10-08; owner found distant hills "drawn with ms paint". Near/far overlap resolved by `discard` keyed on the near ring's EFFECTIVE radius | `scene3d/far_terrain.js`, `far_terrain_flags.js`, url-flags `farRing` / `farRadius` |
| Retail range fog in the terrain shader (`?terrainFog`), `farFogFrac` fog-before-edge invariant | `terrain_shared_glsl.js`, url-flags `farFogFrac` |
| Main camera: `PerspectiveCamera(60, …, 0.1, 5000)` — far plane **5 km**; reversed-Z is on | `scene3d/index.js:1906`; cloud_edge_resolve stats `reversedDepth: true` |
| Volumetric clouds (takram): layers at **750 m** (650 thick), **1,000 m** (1,200 thick), 3,500 m (thin), 7,500 m (cirrus); temporal upscale 1 px per 4x4 per frame (`?cloudEdgeResolve` fixes silhouettes, DEFAULT ON) | `scene3d/cloud_storm_look.js:49-91`, `cloud_volume.js`, `cloud_edge_resolve.js` |
| Deterministic scenery placement already exists as a bake (retail `get_land_scenes` rules, three modes) | `crates/holtburger-scenery-bake/` |
| Statics billboard LOD (retail GfxObj degrade billboards) exists for near statics | `scene3d/statics.js` `tickStaticsBillboards`, url-flag `billboard` |
| Stream-bake guard: 6 non-urgent bakes in flight, extra fires DROPPED; `?objRefire` (DEFAULT ON since 2026-11-01) re-fires the object window's unbaked landblocks every 250 ms, ahead-of-travel first | `scene3d/stream_bake_guard.js`, `scene3d/object_refire.js` |
| The vehicle module feeds the world streamer a LOAD POINT 6 s ahead of the aircraft via `__worldStreamer.onPositionUpdate`: it moves the bake priority centre and fires `landblockChanged` twice per lead change (clears plugin zone state) — the agent recommended a dedicated residency hint | `scene3d/vehicle/index.js` tickPilot; `scene3d/world_stream.js:259, :326` |
| Server flight envelope (profile data): floor 30 m, ceiling **450 m** AGL, climb ≤ 20 m/s, pitch ≤ 25°, vMax 111 m/s (cap property); server corridor preload 6 s, pilot sight 350 m | ACE `Vehicles/VehicleProfile.cs`, `VehicleStreaming.cs` |

### 3.2 Evidence from the 2026-11-01 tours (1070, MODE T, 30 fps off-screen cap)

- Tours E (objRefire + cloudEdgeResolve ON) / F (baseline): statics baked in the 7x7 object window during flight
  0.96 / 0.63 — the window is now mostly filled, yet the owner still sees few trees: **the window itself is the limit**
  (3-4 landblocks ≈ 600-770 m, while from 70-100 m AGL the eye sees kilometres).
- Owner: trees **flash in and out**, landblocks **flicker** or arrive late. Not yet root-caused. Candidates: the
  objRadius hard toggle at N+1 / N while the window slides at 80-110 m/s; governor parking churn at speed; LRU
  evict → re-bake cycles (cap 203 vs a long corridor); the near/far `discard` threshold moving with the effective
  radius; the lead point re-centring priorities; bake worker / main-thread fallback (`[bake_worker_client] …
  main-thread fallback` in the console).
- A console error fires at the cockpit-view switch in every tour: `[far_terrain] RADIUS POLICY VIOLATION — a far-ring
  landblock reached a near-ring system`. Unexplained; likely tied to where the camera vs the player stand.
- After login / teleport the client's spawn pipeline is congested: entity rigs p50 3.3 s / p90 15.5 s / max 45 s
  (`?spawnTrace=1`, vehicles decision 53).
- Media: `/mnt/wbterminal1/tmp/claude-scratch/vehicles/1070-tour-{a..f}*/` (stills, `frames/` + `frames.json`,
  `*.mp4`; tour E = the current defaults, `hellcat-1070-final.mp4`).

## 4. Hypotheses to test first (Phase 0/1)

H1. Flashing trees = the `objRadius` hard toggle at the window edges plus the window sliding at flight speed (a
landblock crosses N+1 → hidden, a lead re-centre brings it back to ≤ N → shown).
H2. Flicker / late landblocks = the governor parking the trailing (and, at speed, the lateral) ring and the near/far
`discard` threshold following the effective radius, so representations swap in view.
H3. Late arrival = bake throughput (guard cap 6, decode admission, bake worker), not fetch — measure queue depth and
per-stage time per landblock.
H4. The lead point (`onPositionUpdate` with a cell 6 s ahead) fights the player-centred systems (objRadius window,
governor, reaper) — two centres, each correct alone.
H5. Few trees far = by design (objects only within the window; far ring is terrain albedo only) — needs a new tier,
not a tuning.

Each hypothesis gets a yes/no from instrumentation (Phase 0), not from reading code.

## 5. Phases

### Phase 0 — Instrument and baseline (no behaviour change)

1. **Residency event log** (client, behind `?residencyLog=on`): one ring buffer of `{t, lb, kind, from, to, reason}` for
   every terrain / statics / buildings / far-patch state change — bake requested / dropped / started / done, show / hide
   (objRadius), park / unpark (governor), evict, near↔far representation switch, and the centre(s) in force (player LB,
   lead LB, priority centre). `window.__residency.events()`, `.flips(windowSec)` (= landblocks that changed visibility
   more than once while within range = flicker), `.leadTimes()` (time a landblock became ready minus time the aircraft
   entered it).
2. **Tree coverage, near and far**: per second, fraction of landblocks within 0-1 km / 1-3 km / 3-10 km of the aircraft
   whose retail scenery (from the scenery bake) is drawn at any LOD. Generalise the tour's 7x7 metric.
3. **Frame timing**: rAF frame times with phase markers; long-animation-frame attribution; CPU profile hooks (the
   perf-worker tooling in `scripts/perf-worker/` already has profile / tourprof).
4. **Extend the 1070 tour** (`../vehicles-2026-11-01/bench/vehicle-1070.mjs`): fixed `?skytime=12`, fresh profile per
   arm, routes as plan files (cruise 300 km/h at 80 m AGL / boost 400 km/h / a long straight over forested country /
   a town pass), per-second metrics rows, the residency log dumped at the end, stills at fixed moments, video.
5. **Baseline**: run the tour at today's defaults; also on foot (Holtburg orbit + a walk) for Q7. Record everything in
   `bench/` under this folder and summarise in `HANDOFF.md` here.

Exit: H1-H5 each answered with numbers; a flicker count and a lead-time distribution for the baseline.

### Phase 1 — Kill the flicker and late streaming (low band)

Fix what Phase 0 proves, in this order of preference: remove the double-centre (one residency centre for flight —
the aircraft — with a velocity-aware forward bias inside the residency policy, replacing the vehicle's
`onPositionUpdate` lead hack); replace every hard visibility toggle at a range boundary with a fade (a dithered crossfade —
needs a shader variant shared by every faded material plus a per-instance fade value, e.g. an instance attribute or
uniform; or alpha-to-coverage where MSAA is on — respect the vfx-write-invariant: never change light counts or
per-instance `customProgramCacheKey`, the #1 cold-load cost); make the governor
speed-aware (park behind the aircraft first, never ahead or lateral within range); size the LRU for a corridor, not a
disc, while flying. Each change behind a flag, A/B'd on the 1070 with the Phase 0 metrics.

Exit: Q2-Q4 met at 300 and 400 km/h on the baseline routes; Q7 unchanged.

### Phase 2 — Far forests (the tier that does not exist yet)

Design first (a short design doc in this folder, owner-readable), then build:
- **Placement**: per landblock, the deterministic scenery list (positions, object ids, scale, rotation) from the
  scenery bake — in Rust/wasm (memory rule: system work in Rust, three.js only renders), cached per landblock, cheap
  enough to compute for hundreds of landblocks ahead. Pre-bake into the dist if computing at runtime is too slow.
- **Rendering**: GPU-instanced impostors (octahedral or a few-view billboard atlas) baked once per tree model from the
  retail GfxObjs (an offline bake step, like the far-ring albedo), one draw per model per patch, distance-based density
  and a crossfade into the near real-mesh trees at the objRadius boundary (no pop at the handover).
- **Range**: out to the far-ring radius at first (1.5 km), then further as the far terrain extends (Phase 4).
- Budget: decide draw / instance / VRAM budgets on the 1070 before scaling the range.

Exit: Q1 met at low altitude; Q2 holds across the near↔far tree handover; Q5 holds.

### Phase 3 — One altitude- and speed-aware LOD policy

One function, `policy(agl, speed, heading)` → radii / budgets for: near terrain ring, object window, far forests,
far terrain, server sight / corridor (via the profile or a server hint), cloud quality. Today these are separate
constants in five modules; flight needs them to move together (e.g. at 2 km AGL the near ring and object window are
useless and their budget belongs to the far tiers). Lives in `scene3d/residency.js` (extend its "one policy" design),
URL-overridable per term for A/B. Smooth transitions as AGL changes (hysteresis + fades).

Exit: a climb from 30 m to the Phase-4 ceiling and back shows no pops and no budget spikes.

### Phase 4 — The high band: above the clouds (10x ceiling)

Investigate first, then build what the investigation recommends. The questions:
- **World-scale terrain.** From 4.5 km AGL the eye sees the whole continent (Dereth is 255 x 255 landblocks ≈ 49 km;
  the geometric horizon at 4.5 km is ~240 km). Today's tiers end at 1.5 km (far ring) and the camera far plane at 5 km.
  Candidate: a world-scale CDLOD / geometry-clipmap terrain over a baked world height + albedo pyramid (WorldBuilder
  already generates tile pyramids — `worldbuilder-terminal` skill; or extend the far-ring albedo bake), with the near
  ring and far ring as its finest levels; an ocean plane to the horizon beyond the world's edge. Forest density at
  this scale = albedo / canopy tint, not instances.
- **Camera and depth**: far plane 5 km → tens of km (reversed-Z is on; check every consumer that copies near/far:
  CSM, SSAO, aerial perspective, depth-keyed effects, `pmndrs` passes copy near/far by value).
- **Fog and atmosphere**: retail range fog (hundreds of metres) would white out the world from altitude — fog must
  become a function of altitude (and hand over to takram's aerial perspective, which is built for this).
- **Clouds**: flying through the 750-2,200 m deck and above it — takram's clouds are geospatial and support cameras
  above layers; measure the cost from above, cloud shadows on the far terrain, the look of the deck from above at
  noon / dusk, and what the temporal upscale does at high camera speed (the edge resolve covers silhouettes).
- **Server (ACE fork)**: the ceiling (profile `CeilingAgl` 450 → ≥ 4,500 m) and climb performance (20 m/s → ~4 min to
  4.5 km; decide); what the server should do for a pilot far above the ground — today the pilot's body relocation
  loads and ticks a 3x3 of landblocks and the corridor preloads 6 s ahead at any altitude, none of which the pilot can
  see from 4 km; an altitude band where the server stops preloading / waking landblocks for that pilot (and its sight
  radius stops admitting ground objects) could make high-altitude flight nearly free server-side. Every server change
  behind a property defaulting off; ACE patches regenerated (`../vehicles-2026-11-01/ace/README.md`).
- **Speed at altitude**: above the clouds there is little to stream; decide whether vMax grows with altitude.
- **Retail clients**: a stand-in 4 km up is beyond retail draw distance — confirm nothing breaks (retail chat line,
  observers).
- **Bail-out from the high band**: a 4.5 km free fall at 50 m/s terminal ≈ 90 s; the chute at 150 m — check the fall
  model, camera and canopy over that length.

Exit: Q6 met; an investigation note in this folder records each question's answer and the measured costs.

### Phase 5 — Owner eye test and ship

Batched 1070 session (EYETEST-style checklist in this folder: what to look for, URLs, flags); flags that pass go
DEFAULT ON (project rule: validated gates ship default-on with an `=off` escape); docs (`docs/url-flags.md` rows for
every flag), handoff, commit / push only when the owner says so.

## 6. Rules and practicalities

- **Laptop**: `~/CLAUDE.md`. Heavy = wasm-pack / cargo / dotnet builds / the full JS gate / any headless Chrome / ffmpeg
  encodes. One at a time, `capped-build`. Kill rust-analyzer before Rust builds. Release wasm only for measurements
  (`env PATH="/home/wbterminal/.cargo/bin:/usr/local/bin:/usr/bin:/bin" capped-build wasm-pack build --target web
  --out-dir pkg-x --release`, then sync into `pkg/`). The bake web-worker holds its own wasm: reload after a rebuild.
  `?nosw=1` on every dev URL.
- **The 1070 (owner's desktop)**: MODE T only (off-screen, `--mute-audio`, launched by the box's hidden hbprobe task).
  The launch gate refuses while the owner is active; the override file is written ONLY when the owner asks for a run in
  the current conversation. Kill test Chrome by profile path, never by image name. The off-screen tab is capped at
  30 fps (owner rule); an uncapped timing run needs the owner's OK. Screens: the display turns off after 10 min idle;
  drivers hold a `navigator.wakeLock` for their run. Accounts: `agentp10` / `agentp09` (bots), never `tailnet1`.
  Tunnel: `ssh -fN -L 9333:127.0.0.1:9333 -R 8765:127.0.0.1:8765 -R 8080:127.0.0.1:8080 young@100.127.215.75`.
- **Media to the owner's phone** (Taildrop `tailscale file cp … redmi-note-13-5g:`) only when the owner asks, and
  only what they ask for (2026-11-01: "taildrop just the video").
- **Live ACE** runs on this laptop: restart only with nobody logged in (`ACE_Log.txt` `[LOGIN]` without `[LOGOUT]`),
  build to a side directory, keep a rollback copy, tell the owner when you restart.
- **Flags**: every behaviour change behind a URL flag following `docs/url-flags.md` conventions (beware the
  `!== "off"` default-on footgun when you mean opt-in).
- **Truth sources**: retail decomp (`~/ac-headers/acclient.c`, `rg -a`) for what retail does; the code for what we do;
  agent citations are hypotheses until read.
- **Commit / push** only when the owner asks.

## 7. Parallel agents (optional, for the investigation phases)

Worth it for Phase 0 code reading and the Phase 2 / Phase 4 design surveys; never for measurements (only the
orchestrator drives the 1070 and runs heavy jobs). Suggested lanes, disjoint file scopes:

| Lane | Scope | Deliverable |
|---|---|---|
| A — flicker / streaming | residency.js, object_radius.js, landblock_lru.js, stream_bake_guard.js, world_stream.js, cells.js, far_terrain*.js | a map of every visibility / residency transition and its trigger; the residency event-log patch (flagged) |
| B — far forests | crates/holtburger-scenery-bake, statics.js (billboards), static_batch_x.js, the GPU batch kit | a far-forest design note: placement source, impostor bake, instancing, crossfade, budgets |
| C — high band, client | camera / depth consumers, terrain fog, takram atmosphere + clouds, far terrain, WorldBuilder tile pyramids | a world-scale terrain + altitude rendering design note with the risks named |
| D — high band, server | ACE fork Vehicles/*, LandblockManager, ObjectMaint | an altitude-band server note: what to stop doing above X m, cost model |

Every agent prompt carries this rule verbatim (from `~/CLAUDE.md`):

> Parallel agents may read, edit and run TARGETED single tests only (`node test_x.mjs`). They must NOT run the full JS
> gate, cargo, wasm-pack or browsers. The orchestrator runs the full gate and builds ONCE, after merging, one at a time.

Plus: no 1070 / CDP / tunnels / Chrome; no ACE restarts; no commits, pushes or self-armed automation; edits only in the
lane's files and behind flags. Use Opus 5.5 for these lanes; Haiku 5.5 for community-Discord archive searches (the FTS
recipe is in `MEMORY.md` §4).

## 8. Deliverables (this folder)

- `HANDOFF.md` — running log: what was measured, changed, verified; next steps.
- `bench/` — tour plans, eval scripts, the residency-log analysis.
- Design notes: `FAR-FORESTS.md` (Phase 2), `HIGH-BAND.md` (Phase 4, incl. server).
- `EYETEST.md` — the batched owner checklist (Phase 5).
- Flags documented in `docs/url-flags.md`; tests registered in `harness/run-js-headless.mjs` (an unregistered test
  fails the gate's hygiene check).

## 9. Decisions that are the owner's (ask, don't assume)

1. How far trees should be visible at low altitude (Q1's 3 km) and the GPU budget for it on the 1070.
2. The high-band ceiling (≥ 4,500 m?) and climb performance; whether speed may grow with altitude.
3. Whether the server may drop ground interaction for a pilot in the high band (no sight of ground objects, no
   landblock loads).
4. The look above the clouds (time of day, cloud coverage) and whether the world edge shows ocean to the horizon.
5. The default flips after the eye test.

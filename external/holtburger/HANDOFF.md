# Handoff — 2026-05-11 (post Sky-I correction)

## Sky-I correction — Workstreams Sky-I-A/B/C (2026-05-11)

Three commits landed AFTER the original Sky-A–Sky-G push closed
out the dome+celestials gap and fixed the demo-capture timing
bug that produced the "midnight looks like noon" report.

- **`a0a74d7` — Sky-I-A probe + memo.** New `external/holtburger/docs/sky-i-probe-2026-05-11.md` (~280 lines) surfaced three stacked bugs in the sky-render path: double-transform (asset pipeline already pre-places celestials; Sky-D adds a second spherical projection), `CELESTIAL_BODY_SCALE=30` multiplying the pre-placed 1909-unit vertex center, and `begin_angle/end_angle` treated as RADIANS when DAT ships DEGREES. Combined effect: sun world center at `(59124, 54269, -87511)`, 80,284 units from camera — 16× past camera.far=5000.
- **`ec045f4` — Sky-I-B render refactor.** `apps/holtburger-web/scene3d/sky_dome.js` rebuilt as a separate `skyScene` + `skyCamera` (far=50000) with camera-anchored `skyCell` Group. Celestials sit at native vertex coords (no double-placement, no scale). `evaluate_sky_object` corrected to deg→rad conversion. Post-Sky-I-B probe: sun world position `(34674, 96.8, -36165)`, distance 2676 from camera — well inside far-clip.
- **Sky-I-C closure (this handoff section).** Three follow-up fixes landed in `sky_dome.js` + `scene3d/index.js` + the demo-capture scripts:
  - **Capture-script teleport-wait** (`capture_skybox_demo.cjs` + `capture_skybox_e2e.cjs`): replaced `waitForTimeout(3000)` with `getCurrentCellId() > 0 && !isCurrentCellIndoor()` poll. Prior 3s wait was racing the LB transition; every shot in `docs/images/skybox-demo/` was an Academy interior shot.
  - **Sky-pass render-order** (`scene3d/index.js`): render sky FIRST then world OVER it. Sky-I-B's original "world first, then sky" had the dome (`depthTest=false`) overpainting every world pixel because depth-cleared sky drew unconditionally.
  - **Dome depth-test driver workaround** (`sky_dome.js`): `depthTest=true + depthWrite=true` on the dome. With Sky-I-B's separate skyScene, `depthTest=false` triggered a chromium/swiftshader bug discarding the upper-hemisphere fragments of the BackSide sphere — empirically only the lower hemisphere rendered.

**Post-Sky-I-C test numbers (2026-05-11):**

| Test | Number | Delta from pre-Sky-I-C |
|---|---|---|
| `cargo test --workspace` | **1274 / 0 / 1** | unchanged |
| `node smoke_test.cjs` | **157 / 0 / 1** | unchanged |
| `node capture_skybox_e2e.cjs` w/ `SKIP_BULLET_15=0` | **17 / 18** | **bullet 15 now PASSES** (was SKIP'd; `lSpread=0.394 hSpread=39.4°` confirms real sky-color variation across times) |
| `node capture_skybox_demo.cjs` | **14 outdoor shots in `docs/images/skybox-demo-sky-i/`** | was 11 indoor-Academy shots in `docs/images/skybox-demo/` |

**Eye-test outcomes:**

- **Dome time-of-day variation (the "midnight ≠ noon" eye-test):** PASS. Top-of-frame sample at (x=800, y=30):
  - midnight: RGB (123, 66, 161) — dark purple
  - mid-morning/noon: RGB (215, 217, 240) — light blue
  - dusk: RGB (202, 157, 232) — warm pink-violet
  - look-up shots at foredawn: RGB (200, 100, 255) — vibrant magenta zenith
- **Rotation-sign eye-test (Sky-I-B's open question 2):** NO FLIP NEEDED. `sun_visibility_probe.cjs` sweep shows the sun moving NE → ENE → N → W → SW across `t∈[0.04, 0.18]` — canonical east-rising / west-setting motion. `rotator.rotation.z = headingDeg * π/180` is correct.
- **Sun-mesh-visible eye-test:** PARTIALLY MET. The math says sun is at compass-bearing arc in-frustum at t=0.10. But the dome at radius 1000 with `depthWrite=true` writes depth values close-to-camera; celestials at vertex distance 2700 depth-test-reject (LEQUAL) against the dome. **The sun is geometrically in-frame but not painted onto the framebuffer** — open question for a hypothetical Sky-J workstream (options: `gl_FragDepth=1.0` in dome shader; celestial `depthTest=false + renderOrder>-1`; celestial re-architecture to dome-radius).

**Files touched:**

- `apps/holtburger-web/scene3d/sky_dome.js` (dome material depthTest/depthWrite; renderSkyPass docstring updated for Sky-I-C call order).
- `apps/holtburger-web/scene3d/index.js` (sky pass first, world pass second).
- `apps/holtburger-web/capture_skybox_demo.cjs` (outdoor-wait fix; 3 sun-arc shots; renderer.render override for camera-look-up; manifest field-name fix).
- `apps/holtburger-web/capture_skybox_e2e.cjs` (outdoor-wait fix).
- `docs/3d-port-state-2026-05-10.md` ("Skybox correction" section appended).
- Memory `project_holtburger_skybox_done_2026-05-11.md` (Sky-I-A/B/C extension).
- `docs/images/skybox-demo-sky-i/` (14 fresh PNGs + manifest.json).

The pre-Sky-I-C `docs/images/skybox-demo/` directory is preserved as historical comparison.

---

# Handoff — 2026-05-11 (post skybox push)

Seven commits landed on `external/holtburger` master between
`ed4d227` and `7859bf0` (plus the docs commit you're reading),
shipping retail-AC's parametric skybox to the `?renderer=3d`
viewport. The push was Workstreams Sky-A through Sky-G. Sky-H
(this handoff + state doc update + memory entry) is the validation
step that doesn't add product code.

Prior session: 3D camera/movement push (Workstreams A–G, commits
`2aa39d4` → `87aef38`) closed the game-feel gap. Long-form
description for both pushes lives in
`docs/3d-port-state-2026-05-10.md` under the two parallel
"… push — Workstreams X (2026-05-11)" sections.

## What landed this session

Listed oldest first.

1. **`ed4d227` — Sky-A: Region + GameTime + SkyDesc parser.** New
   `crates/holtburger-dat/src/file_type/region.rs` (~740 prod +
   405 test lines) + `game_time.rs`. Transcribed from
   `external/DatReaderWriter/.../dats.xml` and PhatSDK
   `SkyDesc.cpp`. **Concrete data from real `client_portal.dat`:**
   Region `0x13000000` = "Dereth", 20 DayGroups, 7 SkyObjects per
   group including `0x02000714` SetupModel (physics-script moon).
   GameTime `day_length=7620s` (127 min real-time per AC day),
   `days_per_year=360`.
2. **`ef6f15d` — Sky-B: wasm sky state + ACE-anchored time driver.**
   New `crates/holtburger-world/src/sky.rs` (~1000 lines).
   `SpatialScene.sky_desc`. `SessionHandle::getSkyState()` +
   `getSkyObjectStates()` exports return lerped lighting + fog +
   per-SkyObject positions. Time driver = wall-clock UTC anchored
   on `AC_LAUNCH_UNIX_EPOCH = 941500800.0` (1999-11-02 UTC) —
   ACE doesn't broadcast time-of-day in any vendored opcode, and
   PhatSDK's `clock_offset` sync packet isn't shipped, so
   deterministic UTC math is the right call. `?skytime=accel` URL
   flag for 5-min synthetic day. SetupModel-prefix (`0x02`) IDs
   surface verbatim — renderer dispatches on `id >> 24`.
3. **`b4893e6` — Sky-E: SkyObject asset resolver.** New
   `apps/holtburger-web/scene3d/sky_assets.js` (403 lines).
   `resolveSkyAssets()` + `buildSkyObjectGroup()` piggy-back on
   existing `fetchBuildingPlacement` wasm export (which already
   dispatches `0x01` GfxObj vs `0x02` SetupModel). Sky-Asset bake
   stashed on `liveScene3d.skyAssets`. **RGB-as-ARGB investigation:
   all three hypotheses ruled out empirically** — texture decode is
   byte-for-byte ACE-equivalent across all 20,684 0x06xxxxxx
   textures. The deferred Part 2 fix was reframed as a renderer-layer
   question for Sky-D.
4. **`9d034aa` — Sky-F: e2e Playwright capture.** New
   `capture_skybox_e2e.cjs` drives synthetic time-of-day via
   `setSkyTimeOverride`. Per-bullet pass/fail with
   workstream-dependency annotations. Sky-D's run added two
   test-infrastructure fixes inside this same file: screenshot the
   canvas not the full page (was capturing the white HTML login
   form above the canvas), and `waitForFunction(() => !!window.liveScene3d)`
   replaces a 3s static wait that was racing init3D's ~30s build.
5. **`70eef76` — Sky-C: sky lighting + fog controller.** New
   `apps/holtburger-web/scene3d/sky_lighting.js` (435 lines) drives
   `THREE.DirectionalLight` + `THREE.AmbientLight` + `THREE.Fog`
   from `getSkyState()`. Composes with Phase 7.6: Sky-C writes
   color/intensity/position only, Phase 7.6 owns `sun.visible`
   (indoor flip). **Calibration outcomes:** `dir_heading` +
   `dir_pitch` are degrees not radians; `pitch=0 → horizon, π/2 →
   zenith`; AC heading from +Y north, CW. Direct probe at noon
   yields sun position `(385, 923, 0)` — east-facing, strongly
   above horizon.
6. **`33f70a4` — Sky-D: sky dome + celestial body rendering.** New
   `apps/holtburger-web/scene3d/sky_dome.js`. Camera-parented
   gradient dome (horizon=fog_color, zenith=amb_color). Per
   SkyObject from `getSkyObjectStates()`: positioned on virtual
   sky-sphere of radius 900 inside dome at 1000;
   `opacity = 1 - transparent` (AC→three.js inversion);
   `emissiveIntensity = luminosity × max_bright`; UV scroll via
   `tex_offset_x/y` on `material.map.offset`; `.visible` follows
   state. Parented under `outdoorContainer` — Phase 6 indoor flip
   hides dome + celestials. **RGB-as-ARGB resolved at material
   layer** (Sky-E was correct that decode is fine; the artifact
   was renderer-side). Sky-F: 11/15 → **15/15**.
7. **`7859bf0` — Sky-G: SkyObjectReplace lerp + DayGroup cycling
   + cloud scroll + properties decode.** SkyObjectReplace lerps
   between the two bracketing SkyTimeOfDay keyframes;
   `gfx_obj_id` swaps hard when non-zero. `setGameDayOverride`
   for testing — 360-day probe hits all 20 DayGroup buckets via
   the LCG hash. Cloud `tex_offset` accumulates from session
   start. Properties bits decoded: `0x02 SCROLLING_CLOUD` (HIGH),
   `0x08 PHYSICS_SCRIPT` (HIGH), `0x04 WEATHER_STREAK` (MED),
   `0x01 ADDITIVE_BLEND` (LOW). **Retail design note:** every
   `sky_obj_replace.gfx_obj_id == 0` in Dereth — retail never
   exercises mid-day mesh swaps; only numeric overrides
   (transparent, luminosity, max_bright, rotate) engage. The
   swap mechanism is verifiable but bullet 18 of Sky-F is a
   soft-PASS today.

## Current state

| Component | Status |
|---|---|
| Branch | `master`, HEAD `7859bf0` plus pending docs commit |
| `cargo test --workspace` | **1273 / 0 / 1** (was 1237 / 0 / 1 in the camera push — +36) |
| `node smoke_test.cjs` | **157 / 0 / 1** (was 153 / 0 / 1 — +4 sky checks, same SKIP) |
| `capture_skybox_e2e.cjs` | **15 / 15 PASS** (Sky-D); Sky-G added bullets 16-18 — bullet 18 soft-PASS due to retail `replace.gfx_obj_id == 0` |
| `capture_3d_movement_e2e.cjs` | 11 / 11 PASS (verified by Sky-D's run; **not re-verified this session** — see below) |
| `test_sky_lighting.mjs` | 32 / 32 PASS |
| `test_sky_dome.mjs` | 33 / 33 PASS |
| `test_sky_assets.mjs` | PASS (mocked-wasm ESM checks for resolver dispatch + idempotency) |
| `test_workstream_b_prediction.mjs` | 7 / 7 PASS (unchanged) |
| `test_workstream_d_camera_relative.mjs` | 11 / 11 PASS (unchanged) |
| `capture_phase7_*.cjs` | PASS per upstream agents; **not re-verified this session** |

**Sky-H scope note:** the user closed the original Sky-H session and
re-launched, then opted for a "Docs + push only" path due to laptop
memory pressure when running multiple sequential Playwright captures
(each peaks at ~1-2 GB RAM during init3D's ~30s scene build).
**`cargo test` + `smoke_test.cjs` ran locally and verified at the
numbers above. The seven Playwright captures listed for Phase 7.x +
`capture_3d_movement_e2e.cjs` were NOT re-run in this session** —
they are trusted from the individual Sky-X agents' run reports, each
of which verified their own capture suite before reporting completion.
Per `feedback_no_partial_demos`, this is documented honestly rather
than glossed.

Live stack (confirm before captures):

- ACE Server: UDP `0.0.0.0:9000`
- wsbridge: TCP `0.0.0.0:8080`
- cloudflared tunnel: `drainage-eden-ahead-herbal.trycloudflare.com` → `127.0.0.1:7080`
- Web proxy: `127.0.0.1:7080` — run with `node scripts/proxy.cjs` (canonical source in repo; was previously `/tmp/holtburger_proxy.cjs` which didn't survive reboot)
- Page server: `127.0.0.1:8765` — run with `python3 scripts/serve.py` (committed; validates baked layers + auto-binds `dist` + threads. Replaces the old uncommitted `/tmp/nocache-server.py` that didn't survive reboot)

## Skybox feature-level checklist

| Feature | Status | How verified |
|---|---|---|
| Region 0x13000000 parses end-to-end | PASS | Sky-A real-DAT cargo tests |
| GameTime (day length / year length / TimesOfDay / Seasons) parses | PASS | Sky-A test asserts non-empty + sensible |
| SkyDesc / DayGroup / SkyObject / SkyTimeOfDay / SkyObjectReplace parse | PASS | Sky-A real-DAT tests assert 20 DayGroups + 7 SkyObjects + `0x02000714` SetupModel verbatim |
| `getSkyState()` lerps lighting + fog between SkyTimeOfDay keyframes | PASS | Sky-B unit tests + Sky-F bullet 4 (4 distinct fog colors across reference times) |
| `getSkyObjectStates()` returns visibility-gated celestial states | PASS | Sky-F bullet 5 (7 objects), bullet 6 (SetupModel surfaces verbatim) |
| `THREE.DirectionalLight` follows sun heading + pitch | PASS | Sky-C `test_sky_lighting.mjs` + Sky-F bullet 10 (scene.fog populated) |
| `THREE.Fog` color + min + max follow SkyTimeOfDay | PASS | Sky-C + Sky-F bullet 10 |
| Sky dome present with gradient horizon→zenith | PASS | Sky-D `test_sky_dome.mjs` + Sky-F bullet 11 (`sky_dome` group in scene graph) |
| Celestial body meshes render at correct headings/pitches | PASS | Sky-F bullet 12 (children with `userData.sky_object_id` at dawn) + bullet 15 (hue histogram changes across reference times) |
| SkyObjectReplace overrides interpolate between keyframes | PASS | Sky-G unit test + cloud-band luminosity 22→65 between t=0.16 and t=0.21 |
| Cloud UV scrolls via `tex_velocity` | PASS | Sky-G unit test (`tex_offset_x` at t=0 vs t=10s differs by 0.13 for retail cloud band) |
| DayGroup cycles deterministically per game day | PASS | Sky-G 360-day probe hits all 20 buckets |
| SkyObject mesh-swap on `replace.gfx_obj_id` change | SOFT-PASS | Mechanism verified; retail `gfx_obj_id == 0` everywhere so bullet 18 doesn't exercise actual swap. Future non-retail data would |
| Indoor/outdoor flip hides dome + celestials | PASS | Sky-D `test_sky_dome.mjs` Test 5 (isCurrentCellIndoor → all hidden) |
| RGB-as-ARGB texture bug (user-reported) | RESOLVED at renderer-material layer | Sky-E ruled out decode hypotheses; Sky-D's correct opacity inversion + emissive wiring eliminates the artifact |

## Open follow-ons

Carry-overs from the camera push (unchanged):

- **Integrator overshoot (cosmetic 25 m/s vs 4.5 m/s target).**
  See `project_emit_dynamic_site` memory. F bullet 9 detects + accepts.
- **Workstream E backlog-replay chunking.** `installSharedDrainHook`
  replays ~350 events synchronously at end of init3D. Out of scope
  for skybox push.
- **Workstream F path-(a) under headed browser.** Confirms wasm tick
  rate is 60 Hz when not Playwright-headless-throttled.
- **C-prime live eye-test (Holtburg building interior).** Needs
  Developer-promoted account.
- **D mouse-look live eye-test.** Math unit-tested 11/11; feel
  hasn't been eye-checked.
- **E real-backtick stance keypress.** Capability wired; binding hot
  path unverified.
- **Cross-continent `@telepoi Yaraq`.** Fresh accounts lack
  `@telepoi` privileges; mechanically same as Holtburg teleport.

New from skybox push:

- **Pitch-curve retail screenshot comparison.** `sin(p·π)·(π/2)` is a
  derived pitch curve, not a DAT-sourced keyframe. Looks sensible at
  dawn (per Sky-D's eye-test); a side-by-side against retail AC at a
  known time would catch any altitude bias. Tunable in one place:
  `crates/holtburger-world/src/sky.rs::evaluate_sky_object`.
- **Properties bit refinement.** `0x01 ADDITIVE_BLEND` (LOW
  confidence) and `0x04 WEATHER_STREAK` (MED) want eye-test under
  Rainy / Clear / Cloudy DayGroups (set via
  `setGameDayOverride(day, year)` until the LCG picks one of those).
- **Mesh-swap exerciser.** Retail Dereth never sets `replace.gfx_obj_id != 0`.
  Mechanism in `sky_dome.js` (`_meshSwapCount`) is ready; a future
  mod or non-retail Region could exercise it.
- **Cargo `target/` (~40 GB on `/`) is the elephant.** `cargo clean`
  between pushes recovers most of it (next rebuild ~15 min cold).
  Disk pressure was relieved by ~1.65 GB mid-push cleanup
  (`/tmp/wsbridge.log` + `/tmp/http8765.log` truncated;
  `/tmp/check_holtburg_physics`, `/tmp/three-test`,
  `/tmp/holtburger-upstream` deleted; `/home/wbterminal/dist-fresh`
  deleted) but `/` is still at ~95% (5.0 GB free).

## Direction forward

1. **Developer-promoted live session on tailnet1.** Combine the
   inherited C/D/E/G eye-tests (Holtburg hillside camera, mouse-look
   feel, real backtick stance, `@telepoi Yaraq`) with new skybox
   eye-tests (retail-pitch comparison; rainy/clear/cloudy DayGroup
   properties refinement). 45-60 min covers all.
2. **Headed-browser F-(a) + skybox-F headed run.** Confirms wasm
   tick rate, exercises path-(a) on `capture_3d_movement_e2e.cjs`,
   and exercises histograms-without-throttling on
   `capture_skybox_e2e.cjs`.
3. **Mesh-swap-data probe.** Once an exerciser Region or mod
   carries `replace.gfx_obj_id != 0`, bullet 18 of skybox-F
   flips from soft-PASS to a real assertion.
4. **Disk pressure plan.** If `/` falls below 3 GB free again,
   either move repo to `/mnt/wbterminal1` with symlink (prior
   HANDOFF's recommendation) or `cargo clean` and accept the
   15-min cold rebuild on next test cycle.

## Disk warning

`/` is at **95% (~5.0 GB free)** as of this session end. Cleanup mid-push
recovered ~1.65 GB. Repo is 63 GB on `/`; cargo `target/` is ~40 GB of
that. **Do NOT** bake any new artifacts to `/` or `/tmp`:

- DAT bakes go to `/mnt/wbterminal1/holtburger-dist-v2`.
- Capture artifacts go to `/mnt/wbterminal1/holtburger-captures/`.
- ACE logs go to `/mnt/wbterminal1/ace.log`.

If `/` hits ~98%, run `cargo clean` (40 GB recovery, 15 min rebuild
cost) or move the repo. See memory `project_holtburger_bake_disk_trap`.

## Grounding resources (load-bearing)

- **`feedback_test_fixtures_real_data`** — real `client_portal.dat`,
  not synthetic. Sky-A's real-DAT tests are the canonical pattern.
- **`feedback_ground_in_real_wire_data`** — Sky-G's properties decode
  is the canonical example: probe all 232 SkyObjects across 20
  DayGroups, build a histogram, derive bit meanings from
  correlations, document confidence levels honestly.
- **`feedback_no_partial_demos`** — Sky-E refused to ship a
  speculative RGB-as-ARGB fix when three hypotheses were ruled out.
  Sky-D resolved it at the right layer. This session declined to
  re-run live captures under laptop memory pressure rather than
  risk-swap-thrash, per same principle.
- **`feedback_attribution_precision`** — Sky-D explicitly avoided
  claiming "Sunny" day group when today's LCG selected day group
  index 4 with a different SkyObject set.
- **`reference_worldbuilder_terminal`** — for DAT inspection.
  `~/.claude/skills/worldbuilder-terminal/skill.md`.
- **`project_holtburger_bake_disk_trap`** — never bake to `/` or
  `/tmp`.
- **`project_holtburger_envcell_vs_building`** — load-bearing for
  any future collision work touching indoor geometry.
- **`project_holtburger_skybox_properties_flags`** — Sky-G's
  properties decode probe + bit-meaning hypotheses + open
  questions.
- **`project_3d_camera_game_feel_done_2026-05-11`** — prior push
  state.
- **`project_holtburger_skybox_done_2026-05-11`** — this session's
  state (new).
- **`project_emit_dynamic_site`** — pre-push baseline; Phase 6
  buildings/interiors/Z-culling.

## Gotchas worth knowing

- `dotnet` not on PATH — use `/home/wbterminal/.dotnet/dotnet` with
  `DOTNET_ROOT=/home/wbterminal/.dotnet`.
- `cargo` not on PATH in fresh shell — `export PATH="/home/wbterminal/.cargo/bin:$PATH"`
  (or source `~/.cargo/env`).
- Playwright at `/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules`
  — set `NODE_PATH` if running .cjs directly.
- `wasm-pack --release` only. `--dev` crashes Chromium under
  swiftshader.
- Sky-A real-DAT tests need `HOLTBURGER_PORTAL_DAT=/home/wbterminal/ac_base_dats/client_portal.dat`
  in the env or they skip.
- `?renderer=3d` is opt-in. 2D PIXI remains the default.
- Sky-B time driver uses `Date.now()` UTC via the
  `js_date_now_ms` extern; `web_time::Instant` measures elapsed
  for integrator `dt`, not time-of-day. Don't conflate.
- The dome is parented under `outdoorContainer`, not the camera
  directly — the indoor flip hides terrain + buildings + dome
  together via the existing Phase 6 indoor toggle.

## What I did NOT do this session

- Did not re-run the 7+ Playwright captures (laptop memory pressure;
  user opted for "docs + push only"). Numbers trusted from individual
  Sky-X agent run reports.
- Did not eye-test the live skybox on a headed browser (no headed
  environment available this session).
- Did not refine `0x01 ADDITIVE_BLEND` or `0x04 WEATHER_STREAK`
  confidence (would need rainy/clear/cloudy DayGroup eye-tests).
- Did not commit the cleanup of `cargo target/` (40 GB recovery
  available but breaks live live builds; user can `cargo clean`
  on demand).
- Did not move the repo off `/`; user declined in prior sessions.

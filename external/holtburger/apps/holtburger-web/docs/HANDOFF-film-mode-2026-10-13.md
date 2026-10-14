# HANDOFF — Asheron's Call FILM MODE (started 2026-10-13; implementation completed 2026-10-14)

**Status (2026-10-14): implementation COMPLETE, wired in behind `?filmMode=on` (default OFF), every film suite and
the full JS gate green, adversarially reviewed and fixed over four rounds. The ONLY step left is the owner-run
1070 eye-test batch (§8 / step 7) — it was never run by an agent (owner rule). Nothing is committed yet.**
The original 2026-10-13 pause text is kept below §0 as history; §0 supersedes §4–§5 where they disagree.

## 0. Status 2026-10-14 — what exists now, how it was verified, what is left

### 0.1 Delivered (all under `apps/holtburger-web` unless absolute)
| Area | Where | Size |
|---|---|---|
| Page runtime + pure modules | `scene3d/film/**` (core, shots, drone, pilot, scene, runtime, `index.js`, `flags.js`) | ~30k lines |
| Node tooling | `tools/film/**` (`film.mjs` CLI with 21 subcommands, `lib/`, `audio/`, `plan/`, `sites/`, `data/`, `install-claude.sh`) | ~14.6k lines |
| Gate suites | 33 × `tests/film_*.test.mjs`, all registered in TIER5 (`filmMode(<topic>)`) | ~27k lines |
| Integration seams (existing files) | `scene3d/{index,cells,entities,statics,animated_scenery,atmosphere_pipeline}.js`, `scene3d/particles/{particle_manager,particle_fx}.js` — each zero-cost / byte-identical when film is off (`tests/film_hooks.test.mjs`) | +~450 lines |
| Flags | `?filmMode=on`, `?filmDof=on` (both exact `=== "on"`, default OFF) — rows in `docs/url-flags.md` §4 + §0 | |
| Contracts | `scene3d/film/SPEC.md` (kept in sync with the code: §3.2 JEV envelope, §5.2 Plan/Timeline/Take, seams, live subjects, fades), `scene3d/film/runtime/SEAMS.md`, `scene3d/film/README.md` | |
| Claude packaging | `$REPO/.claude/skills/film-mode/` (SKILL.md + reference/{workflow,plan-format,pilot,music-video,techniques,1070}.md), `$REPO/.claude/agents/film-director.md`, installer `tools/film/install-claude.sh` | |
| Site gazetteer | built: `/mnt/wbterminal2/film-projects/_gazetteer/film_gazetteer.jsonl` (5,419 sites: 61 towns, 1,400 dungeons, 1,578 POIs, 1,967 landmarks, 13 regions, 400 wilderness) — `film sites build --spawns` to rebuild | |

### 0.2 Verification
- Every film suite passes standalone (each < ~6 s); full gate `capped-build node harness/run-js-headless.mjs --quiet`:
  **728 passed, 0 failed, 0 skipped** (2026-10-14, final tree, all 33 film suites included). `--coverage`: 0 unregistered. `lint-url-flags` (+`--strict`), `audit-flag-defaults
  --mismatch`, `lint-event-consumers`, `gen-modulepreload --check`: all exit 0. `lint-harness-params` exits 1 on 4
  PRE-EXISTING dead params in non-film harness files (`flag`, `kickDance`, `other`, `x`) — not film-related; every
  param of the film boot URL has a reader and a docs row (checked by hand).
- Real ffmpeg 7.0.2 smoke of the assembly graph (dissolve/cut/fade/gaps): output frames = `timeline.frames`.
- Adversarial review (`docs/film-mode-2026-10-13/review/`): 6 dimensions → 47 findings, 2–3 independent refuters
  each → 39 confirmed (several duplicates), 8 refuted; fixed in 4 rounds, every fix cluster independently checked
  (mutation checks against /tmp copies). Records: `review-2026-10-14.json`, `round{1..4}-fix-results-2026-10-14.json`.
- NOT verified (needs the owner's 1070 session): anything GPU/browser — WebCodecs on the real canvas, DoF look,
  stepped clock against the real loop, CDP drain throughput, the pass-over image at nadir, JEV live calls.

### 0.3 Decisions made during the build (now in SPEC; do not re-derive)
- **Scenery fades are OFF in v1.** A wasm `CollisionHit` has no placement identity, and geometric attribution
  proved unreliable on real census data (a boulder next to a tree produced a false clear view). Fades work for
  placed (Stab) trees/props of known size, entities and particle smoke; procedural trees/rocks are rerouted around.
  **v2:** add a scenery placement index to `CollisionHit` (wasm scenery sweep) for exact fades.
- Live (moving) subjects: tracking/chase rigs are re-anchored to the live subject every frame with an exact
  feed-forward; a subject turning ≥ ~90°/s can push flown side-track/chase rigs outside ±15 % (the CLI prints a
  `tracking-gap` warning > 2 m).
- Prepare runs an acceleration-aware **dry-fly** flight check (10 Hz) and reports `overspeed` with a verified minimum
  duration; the realised gap can be larger than the dry-flown one (fpv-dive up to ~+90 %).
- Realtime capture records on the film grid (constant rate, re-stamped frames) so the constant-fps mux is exact.
- The stepped clock yields one rAF per film frame (rAF-driven subsystems advance), keeps the `particleClock=sim`
  clock continuous, and never leaves two rAF chains.
- Fog looks: re-applying the same fog is a no-op; takes wait (≤ 30 s, reported) for the retail fog transition.
- `world.teleport` / `world.command` refuse with FILM_BUSY during prepare/rehearse/shoot/scout; teleports park the
  film viewer cell. The particle-cull seam is passed through `installFilmMode` deps (recheck every frame in takes).
- Plans: an indoor/outdoor technique mismatch the page cannot build is a validation ERROR; `{bars}` shots starting
  before the first downbeat count from it (half-beat tolerance); `bounds` and the technique `capture:'realtime'`
  hint are honoured.
- CLI: `film status [--release|--own]`, `film jev task <pick|keep|site-fit|family>`, `run --song-analysis/--song-audio`;
  password only from `--password`/`FILM_PASSWORD`, scrubbed everywhere incl. the heavy-lock owner file.

### 0.4 What is left (owner)
1. Install the director packaging: `tools/film/install-claude.sh --dry-run`, then without `--dry-run` (symlinks
   `~/.claude/skills/film-mode` and `~/.claude/agents/film-director.md`; refuses to clobber real files).
2. 1070 test Chrome: add `--enable-automation` to `launch-wls.bat` so `browser check`/`boot` can verify
   `--mute-audio` (else pass `--assume-muted`); boot also mutes the page's own AudioManager.
3. JEV key for metered runs: `OPENROUTER_API_KEY` env (or `~/.config/holtburger-film/openrouter.key`, mode 600).
   Without a key the pilot uses its code policy (same rules, no cost).
4. The §8 eye-test batch on the 1070 (owner-requested session only): `reference/1070.md` in the skill has the
   runbook, the boot URL and a validated eye-test plan. `film status` records the per-item status JSON.
5. Commit when satisfied (nothing was committed by the agents; ~110 new/changed files under `external/holtburger/` plus
   `.claude/skills/film-mode/` and `.claude/agents/film-director.md` (one repo: WorldBuilder-ACME-Edition); `install-claude.sh` must keep
   its exec bit). `docs/film-mode-2026-10-13/wip/hooks-lane-WIP-untested.patch` is superseded by the tree.

### 0.5 Known non-blocking limitations (documented in SPEC/skill)
Scenery fades (above); a scenery LABEL can read 'tree' for a boulder beside a tree (labels only, never keys);
fpv hard-mount path techniques fly > 240°/s on some paths (pre-existing feel, nominal validates); depth of field in
the default legacy pass blurs the pre-aerial scene (`clouds=on` gives the full chain — owner's call, GPU cost);
`lint-harness-params` pre-existing failure (above). Session note: on 2026-10-14 the laptop paused ~3 h and the
Claude process exited twice; workflow resume-by-cache replays only an in-order prefix, so for pipelines continue
from the journal (`review/round*-fix-results*.json` show the pattern) instead of resuming.

---
## (history) 2026-10-13 pause text
**Status at pause: research + recon DONE, contracts FROZEN, implementation ~15% (partial, untested, NOT wired in).**
Nothing in that commit changed the running client: every existing file was byte-identical to its parent commit;
the new code under `scene3d/film/` and `tools/film/` was imported by nothing yet and had no gate suites.
Paused by the owner ("this seems like an overnight job … wrap up and write a handoff").

## 1. The goal (owner's words)
> make an "asheron's call film mode" for holtburger web, it's an optional mode that will use Claude 5.5 and JEV
> (make sure you know what JEV is) to help record video footage. its meant to be agentic so nothing shows up on
> the screen, a basic idea of a script is pasted into the agent, it gets broken down into a filming plan. if its a
> video that goes along with music, it can identify the song structure and identify sites that correspond to the
> lyrics. worldbuilder.terminal has an ontology that might be useful for this latter part. all the most common
> filming techniques should be available. this is a code only session where you are encouraged to use opus 5.5
> agents, the 1070 testing will come later. the program will have a good sense of the physobjs, particle effects
> etc which could obstruct the camera view, it can move through dungeons and shift camera angles smoothly even at
> a 90 degree angle. it has the capability to capture drone style shots and has advanced drone filming techniques

Clarifications given mid-session (binding):
1. "jev is a new ai on openrouter" — TypeSafe's System-One decision model (see `film-mode-2026-10-13/research_jev.md`).
2. "it wouldnt be using the claude API, it would be interacting through a claude subscription, e.g. no api usage.
   jev would have api usage though" → the **director is a Claude Code session** (agent + skill); **no Anthropic API
   anywhere in code**; only JEV makes metered calls, from Node.
3. "for jev it more like, has some idea how close it is to trees, the side of a wall etc, research jev playing doom"
   → **JEV = the camera's real-time reflexes** (System One), DOOM/jev-drone style.
4. "we can't instantly teleport … claude would teleport between locations, would take like 10 seconds" →
   **shoot by location** (schedule ≠ edit order), never record across a teleport.

## 2. Read these first (in order)
1. `scene3d/film/SPEC.md` — the frozen contracts (roles, frames, layout, every module API, page API
   `window.__film`, integration seams, CLI, rules). **Single source of truth.**
2. `docs/film-mode-2026-10-13/research_jev.md` — verified JEV Decisions API contract + DOOM/drone prior-art lessons.
3. `docs/film-mode-2026-10-13/recon/pilot_design.md` — the JEV pilot design distilled from that prior art.
4. `docs/film-mode-2026-10-13/recon/*.md` — ten VERIFIED recon maps (file:line cited) of the subsystems film mode
   touches: `recon_camera` (camera/loop seams, frames, one-frame lag), `recon_dungeons` (EnvCells, viewer cell,
   portal graph, indoor_router), `recon_terrain` (streaming is player-centred, heights for any LB), `recon_physobj`
   (entity registry, wasm sweeps, occluder fading), `recon_particles` (emitter enumeration, clocks, time of day,
   DoF recipe), `recon_hud` (every on-screen element, input lock, resolution, portal tunnel), `recon_capture`
   (CDP driving, WebCodecs rationale, 1070 numbers), `recon_world` (teleports, cloak, emotes, extras), `recon_wbt`
   (WBT ontology + gazetteer data inventory), `recon_conv` (tests/gate/lints/packaging conventions). Raw JSON +
   `fmt.py` alongside (`python3 fmt.py recon_render.json 1 all` = the camera map).

## 3. Architecture in one screen (details: SPEC)
| Layer | Who | Rate | Owns |
|---|---|---|---|
| Director (System Two) | Claude Code: `claude --agent film-director` / skill `film-mode` | between takes | script → beat sheet → `plan.json`; sites; per-shot standing orders; teleports; reviews stills/contact sheets |
| Pilot (System One) | JEV `typesafe/jev-1.13` (`POST /api/alpha/decisions`) | ~3–8 Hz, only when needed | hold/drift/rise/sink/slow/back-off; subject lost?; ignore/fade/reroute occluder; framing |
| Reflexes + flight | `scene3d/film/runtime` | every frame | trajectory, drone dynamics, residual smoothing, **safety clamp (always wins)**, recording |
| Perception | `scene3d/film/scene` | 10–20 Hz | wasm sphere sweeps + ray fans + particle queries → bucketed words |
Key decisions (do not re-derive): AC world metres (x E, y N, z up), heading compass CW, pitch [−90°,+90°] with a
singularity-free gimbal basis, three mapping `acToThree=[x,z,−y]`, `q3 = qM·q·qM⁻¹`; drive the existing persp
camera via a per-instance `positionCamera` wrap; pose BEFORE `tickPerFrame` (pre-tick hook) to avoid one-frame
cull lag; film carries its own viewer cell (`resolveViewerCell(prevEye→eye, prevCell)`) for dungeons; the player
is the streaming dolly (stay ≤3 LB outdoors / inside the dungeon LB); **stepped capture** (1070 measured 22–31 fps
at mid) with `holdLoop` + `__renderOnce(ts)` + WebCodecs `VideoFrame(canvas)` inside `postRender`; JEV key only in
Node, exposed to the page as `window.__filmJev` via Playwright `exposeFunction`; flag `?filmMode=on` (exact).
Layout: page code `scene3d/film/**` (bundled + linted), Node tooling `tools/film/**`, suites
`tests/film_<topic>.test.mjs` (must be registered in TIER5), Claude packaging `$REPO/.claude/{skills/film-mode,
agents/film-director.md}` symlinked into `~/.claude/`.

## 4. Lane status at pause
Import-smoke (every file below imports cleanly in Node 20): `node <script>` loop over the dirs — 16/16 OK.
Core math spot-check vs real three.js: `basisFromHPR`/`quatFromHPR`/`acQuatToThree` exact to **4.4e-16** over 75
poses incl. pitch ±90° (the gimbal convention works).

| Lane | Files present | State | Missing |
|---|---|---|---|
| core (`scene3d/film/core`) | errors, vec3, quat, gimbal, easing, spring, rng | written, smoke OK, **no tests** | `spline.js`, `noise.js`, `units.js`; tests `film_core_math`, `film_gimbal`, `film_spline` |
| audio (`tools/film/audio`) | fft, features, onset, tempo, structure | written, smoke OK, **no tests** | `lyrics.mjs`, `analyze.mjs`, `tools/film/lib/decode_audio.mjs`; tests `film_audio_{tempo,structure,lyrics}` |
| jev (`tools/film/lib`) | jev.mjs (1076 l), jev_broker.mjs, jev_tasks.mjs | written, smoke OK, **no tests, unreviewed** | tests `film_jev_client`, `film_jev_broker` |
| sites (`tools/film/sites`) | sources.mjs (718 l) | written, smoke OK | `build.mjs`, `search.mjs`, `tools/film/data/concept_lexicon.json`, fixtures, `film_sites` test |
| hooks (8 existing hot files) | — | drafted (+413 l) but untested → **reverted from the tree**, saved as `docs/film-mode-2026-10-13/wip/hooks-lane-WIP-untested.patch` (`git apply --check` passes on this commit) | review + `tests/film_hooks.test.mjs` + targeted regression suites; apply only after `scene3d/film/index.js` exists (its lazy import would fail esbuild resolution in test_build_shell otherwise) |
| plan, shots-core, pilot, classic, drone+flight, scene-pure, perception, runtime-camera, runtime-capture/API, CLI, docs/Claude packaging | — | **not started** | everything |

## 5. How to resume (exact steps)
Rules that bound every step: `~/CLAUDE.md` (one heavy job at a time; parallel agents run TARGETED single tests
only; orchestrator runs gate/builds once, capped). The parallel-agent rule is already verbatim in every lane prompt.
1. **Relaunch the build workflows** from `docs/film-mode-2026-10-13/workflows/` (paths inside already point at this
   folder): `Workflow({scriptPath: "<HB>/docs/film-mode-2026-10-13/workflows/2-build-chain.js"})`, likewise
   `2-build-tools.js` and `2-build-hooks-sites.js` — three concurrent workflows (4 CPUs ⇒ 2 agents each; memory was
   fine at ~3.4 GB free). Before launching, edit the four partially-done lanes so they FINISH instead of rewriting:
   - chain script `L_CORE`: prepend "Files errors/vec3/quat/gimbal/easing/spring/rng.js already exist — read, keep,
     fix if wrong; write spline/noise/units and all three test files."
   - tools script `L_AUDIO`: "fft/features/onset/tempo/structure.mjs exist — keep/fix; write lyrics, analyze,
     decode_audio and tests."; `L_JEV`: "jev/jev_broker/jev_tasks.mjs exist — review against research_jev.md, fix,
     write the tests."
   - hooks-sites script `L_SITES`: "sources.mjs exists — keep/fix; write build/search/lexicon/fixtures/tests.";
     `L_HOOKS`: "start by reviewing and re-applying `wip/hooks-lane-WIP-untested.patch` (`git apply`), then finish,
     test and regression-test." Move the hooks lane AFTER the runtime-capture lane if you want the index.js lazy
     import to resolve immediately.
2. **Then the two lanes never launched** (prompts in §7): CLI (`tools/film/film.mjs` + `lib/`) and docs/Claude
   packaging (skill + agent + install script + README). `docs/film-mode-2026-10-13/wip/skill_draft.md` is a start.
3. **Register** every `tests/film_*.test.mjs` in `harness/run-js-headless.mjs` TIER5 before the closing `];`
   (~line 1037): `{ tier: 5, flag: "filmMode(<topic>)", file: "tests/film_<topic>.test.mjs" }`. The coverage guard
   FAILS the gate on unregistered suites — register in the same commit that adds them. Suites must execute code
   (suite-hygiene PURE-PIN ratchet), no SKIP banners.
4. **Docs rows** once the readers exist: `docs/url-flags.md` §4 6-column rows for `filmMode` and `filmDof`
   (Default `off`, reader `=== "on"` opt-in, Where = reader file:line) + blockquoted `> |` §0 rows (class
   "Harness / boot contract params": flipping on would hijack a human session).
5. **Review workflow** (adversarial, per finding 2–3 verifiers) over the merged diff, dimensions: contract
   conformance & cross-module wiring; camera/gimbal/trajectory/flight math; page integration seams (zero-cost
   off, right objects); JEV usage (shapes vs research_jev.md, criteria quality, key never in page, budget/errors);
   Node tooling (CLI flows, ffmpeg args, DSP, gazetteer); conventions/gate readiness (registration, lints, hygiene,
   console, no stateful imports, no new Workers, no modulepreload change). Then fix lanes.
6. **Orchestrator checks, one at a time** (capped): `node harness/run-js-headless.mjs --coverage`; the full gate
   `capped-build node harness/run-js-headless.mjs --quiet`; `node ../../scripts/lint-url-flags.mjs` (and
   `--strict`); `node ../../scripts/audit-flag-defaults.mjs`; `node ../../scripts/lint-event-consumers.mjs`;
   `node ../../scripts/lint-harness-params.mjs`; `node scripts/gen-modulepreload.mjs --check`.
7. **1070 eye-test batch** — owner-requested run only (memory `no-agent-eyetests`), off-screen + `--mute-audio`,
   film account `phase4demo` (§6; never `tailnet1`, the human's account there). Checklist in §8.

## 6. Owner decisions (answered 2026-10-13, after the pause)
1. **Film account = `phase4demo`** (owner). Verified read-only against `ace_auth.account`: accessLevel **5 (Admin)**,
   which covers `@teleloc` / `@telepoi` / `@teledungeon` / `@createliveops` (Developer), `@cloak on` (Sentinel) and
   `@attackable off` / `@tele` (Advocate). The password is supplied at run time (CLI `--account/--password`) and
   is NEVER written into docs, plans or commits. It is a single-login account: nobody else may be logged in on it
   during a shoot (~25–65 s gap after a disconnect; `SessionHandle.disconnect()` shortens it).
2. **Depth of field is IN v1** (owner). Integration seam 8 (`?filmDof=on` → one `DepthOfFieldEffect` +
   `window.__dof`) is required, the CLI `boot` URL always adds `filmDof=on`, `classic.rack-focus` must be visibly
   working, and §8 item 8 is a mandatory 1070 check. The flag itself stays default-OFF for normal play (zero cost,
   avoids the ~3 s shader compile outside film sessions).
3. **Gazetteer home `/mnt/wbterminal2/film-projects/_gazetteer/` approved; 2021 acpedia lore approved** (owner).
4. **Scenery bake — DEFAULT for now** (owner, 2026-10-13: "default … ill deal with that later"; the retail
   promotion is the owner's separate task, not part of film mode). Default
   `dist/scenery` is the shipped *ace-compat* bake; `?sceneryBake=retail` is today's opt-in A/B that follows
   acclient.c `CLandBlock::get_land_scenes` exactly (frequency gate, 5 m road band, building-cell and slope tests,
   retail orientation): +17.9% placements around Holtburg (denser forests, no trees on roads / steep slopes /
   building cells) and it matches where live ACE places its physics scenery; it lives on the scratch HDD and is
   pending the owner's A/B eye-test (url-flags.md §`sceneryBake`). Recommendation: film on **retail** once that A/B
   passes and the bake is moved into the SSD dist (`scripts/dist_ssd.py stage --activate`); until then use the
   default. Film obstruction data is always taken from whatever bake the client loaded (the wasm scenery colliders
   follow the same files), so either choice is internally consistent.

## 7. Prompts for the two lanes not yet written (paste into a workflow with the PRE text from 2-build-tools.js)
**CLI lane** — files `tools/film/film.mjs` (`#!/usr/bin/env node`, WHY/WHAT/USAGE header, hand-rolled `--key=value`
args, exported `main()` behind the pathToFileURL main-guard, exit 0/1/2) + `tools/film/lib/{project,session,shoot,
ffmpeg,drain,contact_sheet}.mjs`; tests `tests/film_cli.test.mjs`. Subcommands: `doctor` (node ≥20, ffmpeg
encoders, playwright-core resolvable, CDP reachable, JEV key via `resolveJevKey` + optional `--ping`, gazetteer,
disk); `project init <name>` (default root `/mnt/wbterminal2/film-projects`); `techniques [--family] [--json]`
(import `scene3d/film/shots/index.js`); `song analyze <audio> [--lyrics] [--out]`; `sites build|search|show`;
`plan validate|compile` (real registry; prints `estimateShootTime`); `jev ping|decide`; `browser check`;
`boot` (connectOverCDP default `http://127.0.0.1:9333`; open the film URL
`?nosw=1&agent=1&hud=none&plugins=none&filmMode=on&filmDof=on&autoLogin=1&account=phase4demo&password=…&autoSpawn=first&quality=…&renderScale=1&adaptiveRes=off&radialFog=on&objRadius=off&fogRingCap=off&punchSidedness=on&particleClock=sim&frameBudget=off&maxTickDist=400&dynLod=off`;
`Emulation.setDeviceMetricsOverride` for exact output size; gate on `__bootStateHistory` in-world +
`__sceneReadyEverFired` + `liveScene3d` + `__film`; install the JEV broker (`exposeFunction('__filmJev')`) BEFORE
takes; `__film.clean(true)`, `own()`, `world.avatar(false)`, `@cloak on`, `@attackable off`); `go <site|@cmd>`
(teleport then poll `world.ready`); `scout` (save stills + metrics, optional `pickCandidate`); `rehearse`;
`shoot` (per schedule: go → prewarm → prepare → [rehearse] → shoot while draining `recorder.drain` into
`takes/<shot>.h264` (or IVF for vp9 / JPEG frames) → ffmpeg mux to mp4 → take report; optional `keepOrRetake`
retakes); `assemble` (`buildAssembly` → ffmpeg; + CMX3600 EDL); `contact-sheet <video>` (ffmpeg select+tile → jpg
for the director to Read); `run <project>`. Chrome-driving commands take `harness/lib/heavy_lock.mjs`
`acquireHeavyLock`. Never launch a browser on the laptop. Tests with an injected fake `chromium`/page and a fake
ffmpeg script that records argv.
**Docs/Claude lane** — `$REPO/.claude/skills/film-mode/SKILL.md` (+ `reference/{workflow,plan-format,pilot,
music-video,techniques,1070}.md`), `$REPO/.claude/agents/film-director.md` (frontmatter name/description/tools/
`model: opus`; embeds `~/CLAUDE.md` laptop rules verbatim + no push / no self-armed git), `tools/film/
install-claude.sh` (idempotent symlinks into `~/.claude/skills/film-mode` and `~/.claude/agents/`),
`scene3d/film/README.md`, url-flags rows (§5 step 4). The skill teaches: the pipeline (intake → song analyze →
beat sheet → `sites search` per lyric concept → plan.json → validate/compile → owner-requested 1070 session → go
per site (~10 s) → scout stills → rehearse risky shots → shoot → contact-sheet review → retakes → assemble),
cinematography rules (cut on beats/downbeats; energy → camera speed; chorus = biggest moves/reveals; verse =
intimate; bridge = contrast; intro = establishing/tilt-reveal; outro = dronie/pull-out; 180° rule; motivated
movement), and how to write **standing orders** for JEV (one concrete sentence with distances and priorities;
name what may be faded vs avoided).

## 8. 1070 eye-test checklist (queued; owner-run)
Boot: the CLI `boot` URL above at 1920×1080, `quality=high`, account `phase4demo`. For each item record pass/fail + the
`__film.status()` JSON.
1. HUD-free frame: no toolbar/radar/chat/brackets/bubbles/cursor/canvas border; canvas exactly 1920×1080
   (`__renderScaleState().drawingBuffer`).
2. `own()`/`release()`: camera holds the film pose; release restores follow mode, avatar visible, no stuck keys.
3. Straight-down tilt (`classic.tilt` 0° → −90°) and `drone.pass-over`: no flip/jump at nadir; yaw-slew reads as a
   smooth image rotation.
4. Dungeon `fpv.fpv-corridor` through a 90° turn (e.g. Holtburg dungeon 0x01F6): rooms stay drawn (film viewer
   cell carried), no wall clipping, smooth heading through the turn.
5. Pilot near trees (Holtburg outskirts): JEV decisions logged (`dumpTelemetry`), drift/rise chosen sensibly, no
   collisions (safety adjustments counted), code-policy agreement rate.
6. Stepped take 10 s @30 fps: 300 frames, playable mp4, foliage/water/particles animate at real speed (film clock),
   no hitch after the cut (pre-roll).
7. Teleport + readiness: `go` to a second site, ready report ≤ ~15 s, no pop-in in the next take.
8. **Mandatory (DoF is in v1):** `?filmDof=on` + `classic.rack-focus` — focus pulls foreground → subject, no depth
   artefacts (log depth), no change at all with the flag off, compile hitch only on first use.

## 9. What this commit contains
- `scene3d/film/SPEC.md`; partial `scene3d/film/core/*.js`; partial `tools/film/{audio,lib,sites}/*.mjs`.
- `docs/film-mode-2026-10-13/`: `research_jev.md`, `recon/` (maps + raw JSON + fmt.py + pilot_design.md),
  `workflows/` (the 3 recon + 3 build workflow scripts with every lane prompt), `wip/` (hooks patch, skill draft).
- No gate suites, no registry/lint/docs-row changes, no edits to existing files.

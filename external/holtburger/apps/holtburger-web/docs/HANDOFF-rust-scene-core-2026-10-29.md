# HANDOFF — Rust scene core: round 2 closed, first real-GPU numbers, round 3 re-planned (2026-10-29)

Continues `docs/HANDOFF-rust-scene-core-2026-10-26.md` (its RESUME HERE list, steps 0–8). Plan + lanes:
`docs/2026-10-26-rust-scene-core.md`. **Round 3 plan: `docs/2026-10-29-round3-gpu-driven.md`** (start there).

Owner direction this session (relaying the upstream holtburger author, whose JS/Electron renderer runs 100–500 fps on a
~4-year-old GPU): *"You won't get good results copying AC's renderer. It was made for a CPU-dominant / fixed-function era.
Don't over-index on acclient's renderer; use modern GPU-driven design based on your needs."* Retail stays the correctness
oracle for WHAT is drawn; HOW is ours. The owner's goal for the next sessions: finish this wrap-up, then run round 3 and
everything it entails, so we have a complete picture of where the renderer should be.

Evidence tags: **[M]** measured, **[D]** derived. Run dirs: `$RC = /mnt/wbterminal1/tmp/claude-scratch/perf/rc-rust-scene-core-2026-10-29`,
`$S = /mnt/wbterminal1/tmp/claude-scratch/rustcore-2026-10-29`.

## RESUME HERE

1. **The 1070 went offline at ~23:42 on 10-29** (tailscale "offline"; it dropped mid-bench, right after a test Chrome
   died). When it is back, in this order (fleet runbook `memory/fleet-runbooks.md`; MODE T off-screen + muted; kill test
   Chrome only by user-data-dir; never touch the owner's Chrome):
   - re-open the tunnel (`-L 9333 -R 8765 -R 8080 -R 8766`), restart the frozen snapshot server if the laptop rebooted
     (`cd /mnt/wbterminal2/hb-snap/rc-20261029 && setsid nohup python3 scripts/serve.py --bind 127.0.0.1 --port 8766`),
     check `hbwho.ps1` (Seagate Toolkit, Roblox, input) and write `gate-owner-ok.txt` only on the owner's word;
   - **RC-BENCH v2 reps 2–3** on that SAME snapshot (`hbbench.mjs --arms arms-rc-rust-scene-core-v2.json --reps 2 …
     --port 8766 --uncapped`; rep 1 is in `$RC/bench2/`). The snapshot is rep 1's build: empty-flag defaults = 17 flags
     incl. `rustParticles`, so it pools with rep 1. Apply the batch's pre-written rules (queue file RC-BENCH). Patch
     `docs/2026-10-29-round3-gpu-driven.md` §1.1's placeholder table and the queue file's RC-BENCH `result`;
   - make a NEW snapshot of the current tree (`scripts/perf-worker/hb-mksnap.sh <name>`, then replace its `pkg` symlink
     by a real copy of `pkg/`) for everything below; arms on it must name every flag they depend on;
   - `rustEntityWorld=on` arm(s) on the new build, gated on `__entityWorld.stats().projections === 1`, renders > 0
     (every earlier arm measured the walk half only — the projection never installed until the 10-29 fix);
   - a `rustWorld=on` boot + hop: `__rustWorld.stats()` must read `poolHideOrphan: 0`, mismatches 0, integrity 0
     (`scripts/perf-worker/rust-scene-core-diag.eval.js`; `-1` = pkg predates the category);
   - RC-TRACE (`gputrace.mjs`, now raw-CDP-capable), RC-CENSUS (defaults vs `drawExec=off` + the tagged profile),
     RC-EYE (`scripts/perf-worker/rc-eye.mjs` per arm after `hbsess.mjs boot --no-orbit --flags 'renderDiag=on&skytime=13[&allOff]'`,
     then `python3 -I scripts/perf-worker/rc_eye_diff.py <A> <B> <out>`; the owner looks at the pairs).
2. **Then round 3**, `docs/2026-10-29-round3-gpu-driven.md` §3, starting at R3-0 (harness v2 + clean baseline B0).

## What was done (10-29)

Handoff steps 0–7, in the owner's order, with the 1070 used where it beat SwiftShader (owner: "why we using swiftshader
when we have 1070"):

| Step | Result |
|---|---|
| 0 bring-up | laptop had rebooted: ACE (FIFO holder + `dotnet ACE.Server.dll`), serve.py restarted; branch + 13:30 pkg confirmed |
| 1 executor re-validation | `draw_exec_smoke` PASS (5 arms hash-identical, `vaoFixLate` 0, glError 0). Holtburg boot moved to the **1070** (RC-BOOT): `verify(120)` 28,888 + 86,202 checks, **0 fails**, `texDemoted` 0, console errors 0; `census(60)` 1,079 draws/frame. The laptop smoke now reads `census` / `verify(N)` / `texDemoted` (`--dx-census`, `--dx-verify`, `drawExecBar`) |
| 2 release wasm | `pkg-rel-20261029` (adds `SceneWorld`), then `pkg-rel-20261029b` (lane W fixes): 7,872,222 B in `pkg/`, stamp **`wasmrev-20261029b`**; previous pkgs `pkg-prev-20261029-presceneworld`, `pkg-prev-20261029-preW`. Every `tests/rust_*` suite + motion smoke + objRadius green against it (`$S/suites-pkg-rel-20261029b.log`) |
| 3 full JS gate | **925 / 925** (`$S/jsgate-20261030b.log`). The first run (922/924) found: `freeze_world_roots` F8 broken by R4's install line placement (moved below the freeze block), `hot_terrain_shared` 123 s > the 120 s per-test limit (the gate now takes a per-entry `timeoutMs`; this entry 300 s), and `tests/rust_entity_world.test.mjs` UNREGISTERED (now tier 5) |
| 4 rustWorld hop | on the **1070**: Holtburg 107 audits → `@telepoi Shoushi` + standing: 794 audits, full audit with matrices 20 ms, **0 mismatches, 0 integrity**, `filmHeld` 0. The 10-26 laptop "OOM" and our first post-hop "hang" were the diag read returning `audit()`'s whole arena over CDP — the diag reads now return `{mismatches, report}` only |
| 5 review round 2 | workflow, 10 finders + 2 skeptics each: 19 findings, **9 confirmed, 1 contested, 9 refuted**; nothing confirmed in X2 (default-ON executor) or F2. Fixed by fresh lane agents, each independently verified with mutation checks (`$S/review_r2.json`, `$S/fix_r2.json`): see §Fixes |
| 6 two one-line findings | atlas GC now `bm.dispose()` (geometry once + matrices / indirect / colors textures; `harness/test_tex_compressed_only.mjs` 126/0, fails on the old line); `"use strict"` in `?hotMatVariant`'s generated mirror (`tests/hot_mat_variant.test.mjs` [6], fails before) |
| 7 commit + push | this commit; `scripts/proxy.cjs` stays uncommitted (an earlier session's tunnel fix) |

### Fixes from the round-2 review and the 1070

- **DEFAULT-PATH PIXEL BUG (pre-existing, found by the lane W review):** `?objRadius` (default 4) forgot a hidden,
  then evicted landblock without lifting the pool registry's sticky hide, so its pooled statics stayed invisible for the
  session when the player came back. `object_radius.js` `_forget` now calls `_poolShowLb` (fail-soft; flips nothing on a
  parked / released tile). `test_object_radius.mjs` 45/0 (5 fail on the old file); world fixture `objrPool`.
- Lane W: new audit category `poolHideOrphan` (registry hide with no objr hide; Rust + JS model + fixtures + cargo
  tests), 5 kernel unit tests for unpinned ops (CELL_PVS / SEC_CELLS, INST_SNAP / GEOM_SNAP, LRU_DROP_POOL), stale-pkg
  ABI message. `cargo test -p holtburger-scene` green (53 unit + parity); shadow suite 156/0, no SKIP.
- Lane R4: `?rustEntityWorld`'s projection now installs (index.js, below the freeze block; the rig-build path got
  `scene3dForBuilders`, which has no renderer / scene, so only the walk half ever ran); stand-in pools no longer keep
  despawned rigs reachable (`restore()` clears them); a cold record now needs a hot confirmation in a later render (three's
  per-frame `WebGLObjects.update` memo after a shadow raster skipped uploads). Suite 98/0 (was 84), 37/44 mutants.
- Lane X2: `__drawExec.census()` hung the live page (its name regex backtracked catastrophically on long hex-ish names:
  29 chars → 0.65 s). Linear `censusName()`, equal to the old regex on 20,000 random names; `draw_exec` 403/0.
- Tooling: playwright-core 1.59.1's `connectOverCDP` hangs on the box's Chrome 156 once it lists `browser_ui` targets.
  `scripts/perf-worker/lib/cdp_raw.mjs` (raw CDP over Playwright's bundled `ws`), `cdp-eval.mjs`; `hbsess.mjs` /
  `gputrace.mjs` fall back to it after 15 s. Also `loaf-stalls.eval.js`, `rc-eye.mjs`, `rc_eye_diff.py`, `arms-rc-bisect.json`.

## The 1070 numbers (first real-GPU measurements of the scene core)

- **First bench (rep 1) was contaminated:** Seagate Toolkit held a core at 100% (stopped on the owner's word ~23:00), and
  the same arm swung 27–41 fps between sessions. Its "defaults regress + 17 s stalls" reading did not reproduce.
- **CPU profiles, 3 interleaved pairs at the Holtburg orbit** (`$RC/profile/`; pair 1 still had Toolkit running): main-thread
  busy **defaults 28.2 / 31.1 / 25.9 vs all-off 31.2 / 31.7 / 30.5 ms/frame (−2.72 mean; −2.58 over pairs 2–3)**. Every stage-1
  lane saves time — draw loop −1.0, native −0.7, cull −0.3, rig pose −0.3, sort −0.27, material sync −0.19, terrain VFX
  −0.16 … — except **`rustParticles`: +1.13 ms** (2.34 / 2.54 / 2.44 vs 1.23 / 1.40 / 1.30), all in the bridge's per-emitter
  marshalling (`scene3d/rust/particles.js` `tick`, `dynamicInputs`) plus wasm. LoAF windows: defaults 32.0 / 35.5 / 36.1 fps
  vs all-off 27.2 / 32.9 / 28.0; no multi-second stall in 240 s.
- **RC-BENCH v2 rep 1, quiet box** (`$RC/bench2/`): defaults **45.1 / 45.7 / 42.9** fps (still / moving / tour, p99 36.6 ms) vs
  all-off **37.1 / 36.5 / 37.6** (p99 62.8); `rustParticles=off` 44.7 / 45.5 / 45.9; `drawExec=off` 38.8 / 39.9 / 39.9;
  `rigMeshAlias=on` 37.6 / 34.2 / 39.6. Reps 2–3 owed (RESUME 1).
- **Decisions:** the 16 other stage-1 defaults stay ON (rule: defaults ≥ all-off − spread on every measure). **`rustParticles`
  is DEFAULT OFF again** (one reader line, `=on` opts in; url-flags row says why); reps 2–3 can re-flip it only by a real
  delta. `drawExec` stays ON (rule: noexec would have to beat defaults). `rigMeshAlias` stays OFF (it lost fps).

## Round 3 (re-planned) and the references

- `docs/2026-10-29-round3-gpu-driven.md`: 5 analysts + 3 independent plans (WebGL2-max / WebGPU / measure-first) + 3 judges
  + synthesis, then merged with the WebAC / OpenAC lessons and checked twice. Spine: WebGL2-max's build order on
  measure-first's harness. R3-0 harness v2 + baseline B0 → R3-1 1070 anatomy session (+ the WebAC A/B) → R3-2 cash what is
  built → R3-3 GPU batch kit (proved on animated scenery) → R3-4 entity batch (palette texture-array layers, state rows,
  GPU pose rows) → R3-5 interior batch per landblock → R3-6 retire occlusion proxies → R3-7 GPU particles → R3-8
  checkpoint → gated R3-9..R3-12 (WebGPU only after the draws collapse). Projection [D]: 1,079 → ~350–450 draws,
  −3…−4.3 ms main, ~50–60 fps standing at Holtburg ultra.
- `docs/2026-10-29-webac-openac-renderer-lessons.md` (10 agents, 230 claims checked): both clients share our retail-shaped
  costs; neither is GPU-driven. WebAC (three.js too) gets ~800 draws by drawing less (retail 3x3 object ring, no
  shadows / post); OpenAC hides per-part commands behind Vulkan MDI. Lessons folded into round 3; WebAC can run on the 1070
  as the same-stack A/B the upstream Electron renderer would have been (steps in its §5.1).
- Correction for the owner: retail builds statics / buildings / scenery only on the **3x3** full-detail ring
  (`init_buildings` / `init_static_objs` gated on `side_cell_count == 8`); `object_radius.js`'s comment and the url-flags
  `objRadius` row are wrong, and our default 4 = 81 landblocks. Pricing it is an M1 arm; changing it is the owner's call.

## State of the box and the laptop

- Laptop: ACE + serve.py :8765 up; snapshot server :8766 (`hb-snap/rc-20261029`) up until the next reboot; tunnels to the
  1070 died with the box.
- 1070: offline since ~23:42. Owner override `gate-owner-ok.txt` expires 03:40Z 10-30. The idle watcher (`hbidle`) was
  restarted (its heartbeat had been stale for ~3.8 days). Seagate Toolkit and Roblox were stopped on the owner's word.

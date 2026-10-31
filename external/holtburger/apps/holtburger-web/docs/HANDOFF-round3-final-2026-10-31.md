# HANDOFF — Rust scene core + round 3 (GPU-driven), FINAL (2026-10-26 → 2026-10-31)

This closes the effort. Owner, 2026-10-31: *"1070 isnt coming back so we have to make some assumptions here. write a
handoff with the remaining items, we will keep all winners and otherwise consider the goal concluded. we will wrap up in
a decent fashion. then we must analyze all our work over the last 6 days and commit, push, or merge to origin/master"*.

Branch `rustcore-2026-10-26` (owner's fork) fast-forwarded into `origin/master` at the end of this session. Earlier
handoffs, in order: `HANDOFF-rust-scene-core-2026-10-26.md`, `-10-29.md`, `-10-30.md` (its 10-31 sections are the
day-by-day log). Plan: `docs/2026-10-29-round3-gpu-driven.md`. 1070 queues: `docs/reengineering/queue-1070/batch-R3-*.json`
(S2 holds every 10-31 result and rule D1b).

## 1. What ships (default ON on master)

| Flag | Since | Evidence |
|---|---|---|
| Rust scene core (16 flags): `rustRig`, `rustEntityCull`, `anchorOffGraph`, `staticMatrixFreeze`, `poolSizeToContent`, `rustCull`, `rustAnimScenery`, `rustAnimSceneryGate`, `rustTerrainFx`, `hotMatVariant`, `hotDrawSort`, `hotCloudPush`, `hotTerrainTime`, `hotNightRamp`, `drawExec`, `drawExecRigs` | 2026-10-26 | exact parity suites (node + release wasm), RC-BOOT on the 1070 2026-10-29 PASS (drawExec verify 0 fails), url-flags rows |
| `freezeWorldRoots` | 2026-10-30 | D1 (45/45 valid arm-reps): moving +1.6 fps |
| `drawExecSwitch` (same-program material switch in the draw executor) | 2026-10-31 | S2-DXSW, 3 quiet reps, D1b vs mean(A, A-AA): still +1.25±0.55 / moving +1.20±0.93 / tour +1.43±1.00 fps, renderJs −0.42 ms; GL call stream identical to stock (tests/draw_exec_switch.test.mjs, draw_exec.test.mjs [switch] arm, smoke frame hashes) |
| `orbRender=canvas` (vitals-orb liquid in one canvas per vessel; escape `?orbRender=svg`) | 2026-10-31 | S2-ORB, 3 quiet reps: still +4.18±0.27 / moving +3.65±0.74 / tour +3.75±0.63 fps, the same as hiding the orbs (+3.55 / +3.42 / +4.75); look PASS by the orchestrator (owner-delegated: *"u can eyeball it and pass it yourself"*) on the parity smoke at DPR 1 / 2 |

Expected at Holtburg ultra 1080p on the 1070: ~52 fps defaults before round 3 → **~57-58 fps** with the round-3 winners
(+1.6 moving, +~1.3, +~3.8; the gains share the main thread, so they add roughly, not exactly).

**ASSUMPTION (owner, box gone):** `orbRender=canvas` ships on the S2-ORB numbers of its first build (45e439f0, 1x backing).
The look-parity fix (01ede174) supersamples the backing 2x (1.5x at DPR >= 1.5): 4x raster area per vessel (132x132 at
DPR 1). Per tick it is still a handful of Canvas2D drawImage / clip / stroke calls on three small canvases; the priced cost
was the SVG repaint, which the fix does not bring back. S2-ORB2 (A / A-AA / OC / HO-off) would have confirmed it; if a
later 1070 run shows the supersampled build losing the gain, drop the supersample factor to 1.5x / 1x first.

## 2. Built, measured, parked (default OFF, code kept)

| Flag | Result (S2-QUIET, 3 reps, D1b) | Why it did not win |
|---|---|---|
| `entityBatch` (R3-4) | still −1.25±1.41 / moving −0.25±1.53 / tour −1.48±1.45; −111 draws | renderJs fell only ~0.5 ms; batch building while streaming costs tour fps |
| `interiorBatch` (R3-5) | +0.85±0.77 / +0.28±1.29 / −1.48±1.00; −291 draws | same; plus the 128 MiB kit cap fills in dungeons (TownNetwork: 4,651 refused admits) |
| `gpuParticles` (R3-7a) | −5.3 / −4.2 / −1.2 (loss); renderJs +1.3 ms | the record / row texture uploads and vertex-shader sim cost more than the JS path |
| `hudDiet` (+ bisect flags) | within noise | the orb levers did not reach the repaint cost; the canvas renderer did |
| Stack of the four | −3.7 / −2.5 / −8.3 (loss) | the above, compounded |
| `orbHz=15`, `orbCaustics=off` (existing knobs) | +1.7 / +1.4 / +1.8 and ~0 | superseded by the canvas renderer (orbHz adds nothing on canvas) |

Earlier losers were DELETED after D1 (2026-10-30): `rustEntityWorld`, `uploadWarmDraw` (and `rigMeshAlias`, `drawExecRuns`
in phase A). The D1 "no change" flags stay default OFF: `rigPoseSkip`, `animSceneryBatch`, `skipEmptyPasses` (outdoor),
`occlusionCull=rigs`, `cellStaticMerge`, `statArrayMerge`, `hotTerrainShared`, `hotWeaponFxSync`, `hotGrassCull`.

**The lesson of round 3 (measured, not assumed):** the 1070 frame is bound by the main thread (~20 ms/frame), and that
time is NOT per-draw: renderJs has a ~5 ms fixed intercept, three's per-material switch path was ~5 ms, raw GL submission
is ~0.4 us per draw (M1a-WEBGPU) against ~13 us of three.js JS per draw call. Cutting draws by 40% (the stack) bought
~1 ms of renderJs. What paid: removing per-frame work outright (the orbs' SVG repaint) and making three's per-draw state
work cheaper without changing what it does (drawExecSwitch). Analysis: `/mnt/wbterminal1/tmp/claude-scratch/rustcore-2026-10-29/r3-batching/renderjs/`.

## 3. Bugs found, not fixed (owner-facing)

1. **Default-ON env-cell pools pool almost nothing.** A cell's shell surfaces are offered once at build, usually with the
   <=128 px preview texture, so the pools refuse them; when the full texture lands, `poolAtlasRefeed` drops every parked
   env-cell surface as "stale" (`scene3d/pool_producer.js` ~:852: env-cell nodes never have a parent). 5 of 6 laptop boots
   pooled 0 of 279 shells. Reproduction + fix sketch: `/mnt/wbterminal1/tmp/claude-scratch/rustcore-2026-10-29/r3-batching/pools-indoor/`.
   Impact: modest (the shells stay on per-cell fused meshes); fix if the pools are kept.
2. **Entity batch rows after a WebGL context loss** (flag OFF by default): the 1070 read `verify().rowMismatches` 8 after a
   lose / restore (0 before). Node did not reproduce it (300 fuzz runs). `verify()` now classifies each mismatch (83cf8f98);
   the 1070 read script is ready: `/mnt/wbterminal1/tmp/claude-scratch/perf/r3-s2/chk/ctxdiag.js` (+ `eb-ctx/` lane notes).
3. **GPU batch kit cap / fragmentation** (flags OFF): the shared 128 MiB cap is exhausted in dense places and pages stay
   reserved but mostly free after churn (TownNetwork: 134 MB reserved / 94 MB live). The interior batch's texture-swap
   churn is fixed (1dd3b2cd); compaction is not built.
4. **drawExecSwitch reaches ~45 switches / frame on the 1070** against ~368 state-only draws per frame the census implied;
   `stats.switchGate` / `census(n).switches` (c7aee13f) say where the rest go. The lane's guess: most are real program
   changes (~159 live programs). Read script ready: `/mnt/wbterminal1/tmp/claude-scratch/perf/r3-s2/chk/dxcensus.js`.
5. Pre-existing flag-off findings from the lanes (unchanged, owner decision): interior clones lack the light-clamp chain;
   POM not applied on cloned interior materials; the AFK show tween clobbers the camera fade; pool unpark staleness;
   pool-feed visibility race; objRadius hideLb taking pooled shells.

## 4. Remaining items (not run: the 1070 went offline 2026-10-31 ~20:50 and is not coming back for this effort)

In priority order, with the exact recipes in the S2 / M1 / S1 queues:
1. **S2-ORB2** — re-price the shipped (supersampled) canvas orbs vs `?orbRender=svg` (arm A is now canvas: an SVG arm must
   say `orbRender=svg`).
2. **DXCENSUS** — `chk/dxcensus.js` on an `hbsess` boot: decides whether drawExecSwitch has more to give (fix the gate
   reasons) or is exhausted (then the lever is fewer programs: fold define variants into uniforms).
3. **Eye stills of the new defaults** for the record (`rc-eye.mjs` after `hbanatomy --attach … --daygroup 0`; hbsess does
   NOT pin the DayGroup — the 10-31 unpinned stills differ by weather).
4. **CTXDIAG** — the entity-batch context-loss classification (bug 2).
5. M1 pricing items for owner decisions (c) partDegrade, (d) per-tier targets, (g) objRadius, (h): M1a-BENCH rep 3,
   M1b-FEATURES, -STRUCTURE, -OCC, -OBJRADIUS, -LINVAK, -HOUR22, M1a-ANATOMY (H0, Q-high, A-720), M1a-SWEEP x2. Done:
   M1a-CEILING (R8 PROCEED), M1a-LAYERMIP (PASS: 192 levels byte-equal), M1a-WEBGPU (data), M1c-WEBAC (closed by the owner).
6. S2-LINVAK, S2-DUNGEON (incl. STACK-512), S2-ANATOMY reps 2-3 — only if the parked batches are revisited.
7. S1-INDOOR (+ S1-PRE laptop tab check) — the only measurement that can decide `skipEmptyPasses` (indoors).
8. M1d-OPENAC — owner HOLD.
Chain scripts that ran them (reuse: they wait, log, and stop on a STOP file): `/mnt/wbterminal1/tmp/claude-scratch/perf/r3-s2/run_v*.sh`;
D1b scorer: `.../r3-s2/tools/d1b.py <bench dir>`.

## 5. Next levers if the work resumes (from the measurements)

1. Fewer shader programs (fold define variants — clip map, bias, luminosity, patch bits — into uniforms) so more material
   switches are same-program and drawExecSwitch-eligible; or a program-change fast path (bigger exactness job).
2. Chunk buckets (148 BatchedMesh draws at ~15-25 us each) → class-material draws.
3. The remaining HUD raster (CrGpuMain RASTER ~2.3 ms / present before the canvas orbs; re-measure).
4. The parked batches only after 1-3 move the binding cost (their draw cuts are real but not where the frame goes).

## 6. Box and laptop state at close

- **1070 (offline):** the gate override `D:\Temp\hbbench\gate-owner-ok.txt` was written until 2026-10-31 23:30 −02:30 (it
  expires by itself; delete it at the next session). After any box reboot: `schtasks /run /tn hbidlewatch` — today's rule-V
  idle readings were stale for hours because it had not restarted (check `hbage` in `hbwho` is small). Seagate Toolkit and
  Roblox were stopped on the owner's word (they restart with Windows).
- **Laptop:** ACE (UDP 9000/9001), serve.py :8765 (live tree), wsbridge :8080 as before; snapshot server :8766 on
  `r3i-20261031`. Snapshots `/mnt/wbterminal2/hb-snap/r3b…r3j-20261031` can be deleted. **Snapshot trap:** `hb-mksnap.sh`
  COPIES `scene3d/`, `app/ ui/ plugins/` and top-level files but SYMLINKS `harness/ tests/ docs/ tools/` into the live tree:
  never write under those in a snapshot (it writes the live tree).
- **pkg/ is gitignored:** after pulling master, rebuild the wasm (`capped-build wasm-pack build --target web --out-dir pkg
  --release` from apps/holtburger-web, env PATH prefix per memory) — the Rust scene core (crates/holtburger-scene,
  apps/holtburger-web/src) is part of this merge; a stale pkg is a silent boot failure.

## 7. Owner directions that shaped the decisions (verbatim)

- *"we arent skipping things or trimming our plans"*; *"go with the winning settings for all this work we are doing. we have
  to progress here"*; *"first turn isnt that big a deal … im looking for overall fps improvement"* (rule D1: still / moving /
  tour fps decide, looks for the record).
- *"if we can make use of them by thinking about them then they arent invalid for our purposes"* and *"anything above noise
  is technically an improvement no?"* (rule D1b: paired standard error, not 2x the worst A/A gap).
- *"make the orbs cheaper"*; *"u can eyeball it and pass it yourself"*; *"hold off on that one"* (OpenAC).
- *"1070 isnt coming back … we will keep all winners and otherwise consider the goal concluded."*

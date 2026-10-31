# HANDOFF — Round 3 phase A merged; D1 decided; M1 overnight; four lanes building (2026-10-30)

Continues `docs/HANDOFF-rust-scene-core-2026-10-29.md`. Plan: `docs/2026-10-29-round3-gpu-driven.md`. Branch
`rustcore-2026-10-26` on the owner's fork, HEAD **`6ec85b20`** (one squashed commit on top of `95240def`; pushed).
`scripts/proxy.cjs` stays uncommitted (an earlier session's tunnel fix).

Owner direction this session: *"kill toolkit and lets measure the other run and go with the winning settings for all
this work we are doing. we have to progress here"*. So the 1070 now runs one interleaved decision bench over every built,
default-OFF perf flag (`batch-R3-D1`), and the winners flip to default ON under a rule written before the run.

Evidence tags: **[M]** measured, **[D]** derived. `$S = /mnt/wbterminal1/tmp/claude-scratch/rustcore-2026-10-29`,
`$RC = /mnt/wbterminal1/tmp/claude-scratch/perf/rc-rust-scene-core-2026-10-29`, `$D1 = /mnt/wbterminal1/tmp/claude-scratch/perf/r3-d1`.

## RESUME HERE (updated 2026-10-30 ~21:00; owner /goal: "finish remaining work")

> **10-31 update: read "Laptop 10-31 (batch reworks verified in real boots)" at the end first.** Items 1-3 below are done
> (round-3 checkpoint `0d1cb56b` pushed, then the interior-batch rework commit on top). What is left needs the 1070 (offline
> since 10-31 ~00:34): the M1 re-runs and the decision bench on a new snapshot.

**State at the update.** D1 done and applied (below). Running:
- 1070 chain 2 (`$D1/run_chain2.sh`, log `$D1/chain2.log`): G1-BENCH grass price (`batch-R3-G1`: A, A-AA,
  terrainGrassDensity=0.2, terrainGrass=off; 3 reps; out `/mnt/wbterminal1/tmp/claude-scratch/perf/r3-g1/bench`), then
  it exits (STOP-chain2 set).
- 1070 chain 3 (`/mnt/wbterminal1/tmp/claude-scratch/perf/run_chain3.sh`, log `.../perf/chain3.log`; stop with
  `touch .../perf/STOP-chain3`): M1a-CEILING x3 (R8 gate for R3-4 / R3-5) -> M1a-BENCH -> M1b-FEATURES -> M1a-ANATOMY
  (A, H0-hudNone, Q-high, A-720) -> LAYERMIP -> SWEEP orbit + street -> WEBGPU -> M1b-STRUCTURE -> M1b-OCC ->
  M1b-OBJRADIUS -> M1b-LINVAK -> M1b-HOUR22 (~9 h, out `/mnt/wbterminal1/tmp/claude-scratch/perf/r3-m1/`). After 22:30 the
  override is gone: hbgate refuses while the owner uses the box, so a step can fail to launch; re-run it later.
- Laptop workflows (results under `/home/wbterminal/.claude/projects/-home-wbterminal/7f6af0ca-e85d-4fea-a0ad-b5dce5e55800/subagents/workflows/`):
  grass `wf_09ec682f-306` (built + verified, then REMOVED on the owner's word; patch saved), delete `wf_e1aaa793-184`
  (rustEntityWorld + uploadWarmDraw; MERGED), R3-7a `wf_8210eab7-808` (?gpuParticles), M1c driver `wf_ab6582a6-4a9`
  (scripts/perf-worker/m1c-webac.mjs).

**Next, in order:**
1. Merge the four lanes (forOrchestrator texts: url-flags rows, gate entries, modulepreload regen + test_build_shell
   count, plan / docs lines). Uncommitted already: `freezeWorldRoots` DEFAULT ON (reader, test F1, index.js comment,
   url-flags row, fps_arms_smoke reference run `?freezeWorldRoots=off`), D1 / G1 queue results, plan §1 D1 paragraph.
2. Laptop window (ONLY when no 1070 bench runs): full JS gate (capped-build); smokes one at a time:
   grass_gpu_smoke, gpu_particles_smoke, gpu_batch_smoke, fps_arms_smoke, laptop `?rigPoseSkip=on` boot; S1-PRE laptop
   tab check; WebAC setup (M1c forOrchestrator); new snapshot (hb-mksnap + real pkg) + `--check-snapshot` for every queue.
3. Commit + push (rustcore-2026-10-26).
4. 1070 chain 4 (G2 dropped: G1 showed grass costs no measurable fps; owner "ok well we keep the grass the way it was
   before then"; the lane-G build is removed, patch in `$S/grass-g1/`): P (gpuParticles on vs defaults, Holtburg + Linvak), S1-INDOOR (skipEmptyPasses indoors),
   the rustWorld=on hop audit (poolHideOrphan 0), M1c WebAC x3 interleaved with our H arms.
5. Decide R3-4 / R3-5 from R8 (`hbreport.py ceiling`): PROCEED -> build; RE-SCOPE -> re-plan. R3-6: the cell-proxy half
   stays (D1 O-rigs: +114 draws, +0.6-0.8 ms render JS); the rig half after R3-4 + R3-5. R3-7b: particle buckets are
   ~8.5 draws/frame at Holtburg (census), so the merge is worth <= ~6 draws there; build it only if Linvak / combat
   census shows more. R3-11: binding thread is MAIN, so its GPU-fill levers are not first.
6. Owner decisions still open: (c) partDegrade, (d) per-tier targets (from M1 floors), (g) objRadius, (h), (i) OpenAC.

**Key measurements tonight [M]:** D1 (clean box): defaults 51.7 / 49.7 / 53.6 fps; only freezeWorldRoots won (moving
+1.6); uploadWarmDraw / rustEntityWorld lost tour fps (-1.7 / -1.8). D1 anatomy (A x3, A-AA x3): **binding thread =
main** (main busy 19.0-20.2 ms/frame, CrGpuMain 14.3-16.3, GPU 13.3-13.9); calibration 12.2-13.0 us renderJs per
info.call, 5.9-7.2 us CrGpuMain WEBGL per real draw. Owner census (A r1, 1,097 draws/frame): cell statics 314, entity
part-surfaces 285, chunk buckets 148, occlusion proxies 124, cell surfaces 65, statics other 50, buildings 26,
pools 23, animated scenery 19, particle buckets 8.5. Per-pass GPU: main RenderPass 11.1 ms, post EffectPass 1.6 ms.

## What was done (10-30)

- **Round 3 phase A + two fix rounds**, every lane verified independently with mutation checks:
  - phase A (workflow wf_0fccc9c6-2d3): lanes H (harness v2), P (?rigPoseSkip, rigMeshAlias deleted), D (drawExecRuns
    deleted), R (?skipEmptyPasses, ?uploadWarmDraw, far-fog parity test), T (object-ring text, ?occlusionCull=rigs),
    K (GPU batch kit + ?animSceneryBatch);
  - fix round a2 (wf_7cc201d4-c4d): H2, K2 (incl. a DEFAULT-PATH fix: re-shown animated critter ghost under
    ?animSceneryBucketVis), R2, W2 (NEW ?bakeFallbackWaves), S, Q (S1 queue);
  - cleanup a3 (wf_36fdf29c-111, `$S/round3-a3/`): Q2 (S1 queue defects + s1.eval.js / s1_eval_report.py /
    s1_queue.test.mjs), H3 (harness test gaps, webgpu_probe kill leak, every anatomy rep feeds R3 (i), one queue item
    per report), K3 (no GL deletes of lost-context objects, per-UPLOAD-frame budget with deferred geometry tickets, S1
    timings), R3 (uploadWarmDraw test gaps, evicted roots released on removal), W3 (MessageChannel yield, no nested-timer
    clamp), S2 (rigPoseSkip bridge LRU drift closed).
- Merged at the orchestrator: url-flags §13 rows, plan built-state / proof sentences, S1 queue reader pattern
  (`kitContextGeneration\(`), gate entry `s1Queue`. modulepreload up to date (468). **Full JS gate 940/940**
  (`$S/jsgate-20261030-a3.log`).
- **RC-BENCH v2 reps 2-3** (`$RC/bench3/`, `--compat v1`, frozen rep-1 snapshot): 22/22 arm-reps INVALID under rule V
  [M]: Seagate Toolkit back at ~1 core (restarted with the 11:40 reboot), the owner at the box, the owner's Chrome at
  1-2 cores in 4 reps, gpu3d_other 6-18% in 4 reps. Same-arm swing up to 18 fps. Recorded in plan §1.1 and the RC queue's
  RC-BENCH `result`; 10-29 defaults unchanged. As-run reading (no rule): defaults beat all-off on moving / tour in 3/3
  reps; `rustParticles=off` beat the snapshot defaults on tour in 3/3 (supports the 10-29 flip); ~1,100 draws/frame and a
  0.7-2.5 s first-turn freeze in every arm.
- Snapshot **`/mnt/wbterminal2/hb-snap/r3d1-20261030`** of the merged, gated tree (real release pkg copy, 7,872,222 B,
  wasm_profile release); `--check-snapshot` passes for the M1, S1 and D1 queues.
- Owner asked: Seagate Toolkit killed on the 1070 (~15:40; it autostarts with Windows); Claude Code `idleCompaction`
  turned off in `~/.claude/settings.json`.

## Follow-ups from the a3 verifiers (non-blocking, not yet done)

- uploadWarmDraw: `noteRemoved` releases a root that MOVES under a non-listened node still in the scene (every wielded
  item: entities.js `mount.add(c.root)`), so it is warmed only via the wielder's walk / the watch (8-50 frames later in
  probes). Fix: defer the release decision to the next tick and re-queue a root that reached the scene again. Also an
  untested overflow loop (:374, mutant E23).
- s1.eval.js / s1_eval_report.py: add `yieldVia === "MessageChannel"` to the BFW checks; fixtures for `waves < calls +
  split` and `yields > waves - calls`; ctxloss fakes that fail the resets / generation / end-error reads (these edits
  need the queue's `evalScripts.sha256` updated via `$S/round3-a3/Q2/gen_q2.py`). Same-landblock laptop-room hop
  counts as landed before the teleport.
- hbbench `endInfo` hook (end-of-arm `__rigPoseSkip.stats()` on scored arms); hbreport r3_keep hitch branch
  (`predict.kind: "hitch"`); anatomy reps scoped per queue item; noisy-box fallback for anatomy reps.
- K3: `delete mesh.onBeforeRender` instead of own-property restore; assert per-phase timings; note in the kit header
  that `disposeOnLiveContext` strips every foreign-generation dispose listener.
- rigPoseSkip: probe `n > 0 ? 1 : n` (NaN edge, unreachable today); `keyChanged` comment.

## State of the box and the laptop

- Laptop: ACE (UDP 9000/9001), serve.py :8765 (live tree), wsbridge :8080, snapshot server **:8766 = r3d1-20261030**
  (log `/mnt/wbterminal2/hb-snap/r3d1-20261030.serve.log`). `serve.py --check` validates and EXITS; start it again
  without `--check` to serve.
- 1070: tunnel `-L 9333 -R 8765 -R 8080 -R 8766` open; **owner override `gate-owner-ok.txt` until 22:30 (-02:30)**,
  written because a mid-run hbgate refusal would stop the bench; delete it when D1 ends. Toolkit off until the next
  reboot. idlewatch (`hbidlewatch` task) running.

## Overnight 10-30 -> 10-31 (status at 03:45)

**1070: offline since ~00:34** (tailscale "offline"). Completed before that: G1 grass price (grass costs no fps; owner kept grass;
lane-G build removed, patch in `$S/grass-g1/`), M1c WebAC rep 1 (owner closed M1c: WebAC 58.2 fps / 906 draws vs ours 56.3 / 651
at ultra and 79.6 / 481 at retail scope; both ~12-16 us of main JS per draw), **M1a-CEILING R8 = PROCEED** (re-run WITHOUT
--uncapped: uncapped, Chrome's VizCompositorThread spins ~70k tasks/s and fills the trace after 10 s; V2 merge per blend class:
main world render -55%, CrGpuMain WEBGL -66%; V1 merge per material WORSE), M1a-BENCH partial (reps 1-2: Q-low +8-11 fps,
Q-mid +3.5-6, Q-high = ultra, 720p = 1080p (not fill-bound), **hud=none +3.9 / +2.8 / +4.1 fps real**, nullRender ~72 fps).
Failed on the offline box (re-run when it is back): M1a-BENCH rep 3, M1b-FEATURES, M1a-ANATOMY x4, LAYERMIP, SWEEP x2, WEBGPU,
M1b-STRUCTURE, M1b-OCC, M1b-OBJRADIUS, M1b-LINVAK, M1b-HOUR22 (`/mnt/wbterminal1/tmp/claude-scratch/perf/run_chain4_rest.sh`
holds the order; its outputs under `.../perf/r3-m1/` are failure records). When the box returns: tunnel, hbwho (Toolkit restarts
with Windows), re-serve snapshot as needed.

**Laptop, merged since the 22:00 handoff (uncommitted):** lane DEL (rustEntityWorld + uploadWarmDraw deleted), freezeWorldRoots
DEFAULT ON, R3-7a `?gpuParticles` (+ smoke fix: the shader now has its own range-reduced sin / cos, SwiftShader's builtin
is ~1.3e-4 off; S7 was a smoke camera bug), M1c driver `scripts/perf-worker/m1c-webac.mjs` (own profile C:\Temp\hbm1c-webac;
WebAC stack stopped, box profile removed), R3-4 `?entityBatch` (+ picking.js P1, dismember.js P6, drawlist-census P12), R3-5
`?interiorBatch` (+ landblock_lru.js hooks). Smokes PASS: gpu_batch (harness fixes: interval polling, three/addons import map),
fps_arms, gpu_particles, entity_batch, interior_batch (punch check made relative to legacy). Full JS gate 957/958 then the
missing NEEDS_BROWSER entry fixed (re-run the gate before committing).

**First real boot (laptop, `entityBatch=on&interiorBatch=on&gpuParticles=on`, 0 console errors) found two integration gaps**,
now in workflow `wf_52698fbc-4fb`: (1) `?interiorBatch` disarms under the DEFAULT-ON env-cell draw pools, yet the pools leave its
target (cell-static props, 314 draws at the orbit) on the legacy producer; (2) `?entityBatch` admits ~208 MB of layers for 60
entities, 50 pageFull refusals, 3 context resets, 0 rigs batched at the end. Control boot without entityBatch: 0 context losses,
214 s vs 750 s, so the batch footprint is the likely cause. HUD diet lane `wf_41651891-d3c` building (bisect flags + `?hudDiet`).

**Next 1070 session:** finish M1 (list above), then a decision bench on a NEW snapshot of the merged tree: A, A-AA, EB
(entityBatch), IB (interiorBatch), GP (gpuParticles), HUD bisect arms + hudDiet; Holtburg + Linvak crowd + one dungeon; owner rule:
overall fps wins ship (look stills for the record).

## Laptop 10-31 (batch reworks verified in real boots)

Since `0d1cb56b` (uncommitted until the commit that adds this section): `?interiorBatch` takes AO / roughness / emissive members
(packExtState texels 2-3, class map sets `|xm…`), the kit pages are demand-sized (the old allocator reserved the whole 128 MiB cap
with 99% empty slots because the fake GL's MAX_ARRAY_TEXTURE_LAYERS was 0), page-full waits, the interior diag `meshes:
{ built, suppressed }`, and `laptop-rust-boot-smoke.mjs --teleloc "<cell> <x> <y> <z>"`.

Real laptop boots (SwiftShader, `--quality low --render-scale 0.25`, logs `$S/r3-batching/bootlogs/`) [M]:
- **both batches, Holtburg outdoors** (`r3-ib-pages2`, 360 s): 0 console / page errors. entityBatch: 14 rigs active, 127 draws,
  `verify()` 0 / 0 / 0 / 0 / 0, 0 demotes, 0 context resets, 0 page-full waits, 0 refused layers (kit 104 MB live of the 128 MiB
  cap, ~67 MB of it entity layers). interiorBatch: 1 LB planned, chunks overlap 1 + building 1, 0 activations: outdoors, the chunk
  cells are not shown, so the chunk waits (by design, header "overlap per legacy mesh").
- **interiorBatch, inside `@teleloc 0xA9B40121 104.5 135.7 67.0`** (`r3-ib-room`, 300 s): **170 of 291 legacy meshes drawn batched**
  (the rest wait for their batches to come on screen), 125 slots (all with AO + roughness, 4 emissive), bitMismatch 0, giveUps 0,
  pageFull 0, 0 errors. 8 texture replans at boot (`replan:map`: texture swaps while streaming; limit 64).
- An earlier boot (both batches) was killed by the system earlyoom (not the cgroup), with 0.7 GB available: SwiftShader's GPU
  process holds ~2 GB and the renderer ~1.3-1.4 GB in these boots, and the idle tsserver (Claude's LSP) held 1.1 GB. With the
  tsserver stopped the boots finish with ~1.3 GB to spare. Watch `free -m` before a batch boot.

Open from these boots (none blocks the 1070 bench): a texture swap re-plans the whole chunk (teardown + rebuild); on the 1070
this is a boot-time cost to watch in the IB arm (`textureReplans`, `teardowns`). `pools.cells` read 0 in the room boot (38 outdoors).


**Ready for the 1070 (2026-10-31):** committed `9315dfd7` (gate 966/966, pushed). Snapshot **`/mnt/wbterminal2/hb-snap/r3b-20261031`**
(from 9315dfd7, real release pkg copy; passes `--check-snapshot` for the M1, S1, D1, G1 and S2 queues). Decision-bench queue
**`docs/reengineering/queue-1070/batch-R3-S2-2026-10-31.json`**: S2-PRE; S2-BENCH at Holtburg (A, A-AA, EB-on, IB-on, GP-on, HD-on,
HP-off, HO-off, HC-off, HN, H0 ceiling, STACK; 3 reps, ~3.3 h); S2-ANATOMY; S2-LINVAK (6 arms); S2-DUNGEON (TownNetwork, 5 arms);
S2-EYE; S2-REPORT. Rule D1 (still / moving / tour fps decide; looks for the record). Each arm has a gate, so an arm whose flag did
nothing on the box is INVALID, not an A/A. When the box is back: tunnel, hbwho (Toolkit), serve the snapshot on :8766 (stop the
r3d1 server first), then the M1 re-runs (`run_chain4_rest.sh` order; they can use the new snapshot, all readers pass), then S2.

## 1070 session 2026-10-31 (owner present; noisy box accepted)

Owner: *"it will be slightly noisy but will show directional improvement so we go with that"* → gate override until
18:00 -02:30 (D:\Temp\hbbench\gate-owner-ok.txt); Roblox + Seagate Toolkit (app, service, service process) killed on the
owner's word. Commits today: `f83477d7` (entity batch AO / roughness / emissive-alias parts; 1070 live-tree boot at ultra:
39 rigs active, 113 map leaves batched, verify all 0, the default 128 MiB kit cap FULL: 44 leaves legacy for pageFull →
S2 arms EB-512 / STACK-512), `4a967837` (review fixes; gate 967/967). Snapshot **r3c-20261031** (f83477d7) on :8766.
- **S2-BENCH rep 1 only** (14 arms; A / A-AA differ by up to 6 fps under the owner's use: fps per flag is not decidable
  here; draws and renderJs are). Out `/mnt/wbterminal1/tmp/claude-scratch/perf/r3-s2/bench`. Reps 2-3 are replaced by a
  quiet-window bench of the decisive arms (S2-QUIET).
- **Noisy-window chain** `/mnt/wbterminal1/tmp/claude-scratch/perf/r3-s2/run_noisy.sh` (log `noisy.log`): LAYERMIP, WEBGPU,
  real-GPU batch checks on r3c (`chk/`: gpuParticles self-check, interior batch in room a9b40121 and TownNetwork, a context
  loss / restore with all three batches on), rc-eye stills A / EB / IB / GP / HD (`eye/`), S2-ANATOMY rep 1, M1a-ANATOMY x4,
  M1a-SWEEP x2. During its hbsess part :8765 serves r3c, then the live tree again.
- **M1d-OPENAC: owner HOLD** ("hold off on that one"; ownerDecision in the M1 queue).
- **Outstanding-items audit** (workflow, 2026-10-31; `/tmp/.../scratchpad/outstanding.json` is session scratch, the gist):
  superseded / done: RC-BOOT, RC-PROFILE, RC-TRACE, RC-CENSUS, RC-BENCH, S1-BENCH, S1-ANATOMY, S1-ENTITYBATCH,
  S2-INTERIORBATCH-REF; obsolete: S1-CTX (gated animSceneryBatch only; the S2 batches get their own ctx check in `chk/`);
  moot under the owner's fps rule (bakeFallbackWaves is fps-flat): S1-ROUTE, S1-BW0, S1-DIAG, RC-EYE; still to run:
  the M1 fps items (quiet window), **S1-PRE + S1-INDOOR** (the only measurement that can decide skipEmptyPasses; S1-PRE's
  laptop tab logs a second account in at the bench spot, so it runs only when no 1070 item runs), S1-EYE, S1-FARFOG-OPT.
- **Pools bug found (default-on env-cell pools; not fixed, owner-facing).** A cell's shell surfaces are offered once, at
  build, usually still with the <=128 px preview texture, so the pools refuse them (`offPage` / `needsResample`); when the
  full texture lands, `poolAtlasRefeed` drops every parked env-cell surface as "stale" because env-cell nodes never have a
  parent (`scene3d/pool_producer.js:852`, comment assumes an evicted LB). 5 of 6 laptop boots today pooled 0 of 279 shells.
  Reproduction (real cells.js + pools via tests/interior_batch_rig.mjs):
  `/mnt/wbterminal1/tmp/claude-scratch/rustcore-2026-10-29/r3-batching/pools-indoor/repro_preview_race.{mjs,out}`.
  Fix sketch there (re-offer after atlasRefeed, re-fuse the cell, re-plan the interior batch). Deferred until S2 decides
  `?interiorBatch`: it already takes the shells the pools refuse, so if it flips ON the fix matters much less.

### 2026-10-31 findings from the 1070 checks and the render-JS analysis

- **1070 real-GPU checks (r3c, `r3-s2/chk/`):** M1a-LAYERMIP PASS (24 textures, 192 levels byte-equal, copyTexSubImage3D and
  blit, sensitivity controls detected); gpuParticles self-check true, 0 patch failures, 2,824 emitters; interior batch in room
  a9b40121 240 / 291 legacy meshes batched and at TownNetwork 315 / 411 (3 chunks active), bitMismatch 0, giveUps 0 — but
  **texture-swap churn** (room 33 / TownNetwork 62 texture re-plans, cap 64; fixed by 1dd3b2cd on r3d) and **the shared
  128 MiB kit cap exhausted at TownNetwork** (134 MB reserved / 94 MB live, 4,651 refused admits; 82 interior members and
  3,965 entity leaves legacy for pageFull) → S2-DUNGEON / S2-LINVAK gained STACK-512 arms; kit fragmentation (reserved >>
  live after churn) is a follow-up if the settle fix does not cure it. **Context loss / restore** (all three batches): the
  client recovers (lost → restored 3.0 s → 20 / 20 rehydrated), interior and particles clean, **entity batch verify()
  rowMismatches 8 after the restore** (0 before): lane `eb-ctx` investigating.
- **M1a-WEBGPU:** raw submission CPU per draw ~0.4 us (WebGL2 drawElements, WebGPU bundles), ~1 us (WebGPU drawIndexed),
  against ~13 us of three.js renderJs per info.call: the GL call is ~3% of a draw.
- **Why the stack's 41% fewer draws bought ~9% renderJs** (analysis lane, scratch `r3-batching/renderjs/`): renderJs has a
  ~4.9-5.2 ms fixed intercept (quiet-box D1 regression; marginal 7.9-8.7 us per info.call); the "22 walks" are one world walk
  (14.9 of 15.8 ms) plus 21 tiny ones (~1 ms); **three's per-material SWITCH path (setProgram + uniform refresh) is ~5 ms /
  frame** (~434 switches over ~1,097 draws, only 66 useProgram); batching mostly removed cheap same-material continuations
  (~2.5-3 us) while ~197 BatchedMesh calls (148 chunk buckets) cost ~15-25 us each; batch draws bypass draw_exec's fast path.
  Ranked levers: (1) a same-program material-switch fast path in draw_exec, GL stream identical (−2…−3 ms [D]) — lane
  `dx-switch` building `?drawExecSwitch` (default OFF); (2) chunk buckets → class-material draws (−2 ms [D]); (3) finish the
  entity / interior batches (−1.2…−1.5 ms each [D]); (4) entity batch as a plain Mesh draw_exec accepts (−0.2 ms); (5) fewer
  bloom mip walks (−0.1 ms, look change); detaching parked leaves (−0.1…−0.2 ms, high risk) and cheaper class materials (~0)
  are not worth it.

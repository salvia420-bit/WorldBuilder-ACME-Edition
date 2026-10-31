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

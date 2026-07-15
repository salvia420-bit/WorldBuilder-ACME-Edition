# HANDOFF — the particle cull is FIXED (+42% fps in town). Next: is every particle drawn TWICE?

**Date:** 2026-07-15 · **Box:** wbterminal laptop → 1070 (tailscale, CDP :9333, real GPU) · **Self-contained.**
Supersedes `HANDOFF-perf-particles-rp6-leak-2026-07-15.md` (its ⭐ lead is DONE; its *cause* was wrong — §1).
Full detail + every number: `RESULTS-task9-rp6-cull-authority-2026-07-15.md`.
REPO=`/home/wbterminal/WorldBuilder-ACME-Edition`, HOLT=`$REPO/external/holtburger/apps/holtburger-web`,
net-review=`$REPO/external/holtburger/scripts/net-review`. Tree clean; everything below is on `origin/master`.

---
## 0. TL;DR — where we are

- **The RP6 particle leak is FIXED and it was worth real frames: fps 32.3 → ~46 (+42%), draws/frame
  574 → 237 (−59%), median frame 33.3 → 24.9 ms**, at a settled pinned Cragstone on the real GPU.
  A/B/A-validated (`e79951e9`, `2373208c`).
- **The cause was NOT "the flip only fires on TRANSITION"** — the theory three sessions chased. It was
  **TWO WRITERS of one `mesh.visible`**: `cullStaticsGroup` rewrote it EVERY frame from a frustum-only
  test, RP6 wrote it per-transition from its own rAF. The per-frame writer always won. §1.
- **⭐ THE OPEN LEAD: each visible particle appears to cost ~2 draws/frame, not 1 (§3).** If real, there
  is a second render pass nobody has accounted for — and the ruling that killed that idea used a hook
  the last handoff itself admitted mis-fires. Method to settle it is in §3; it is cheap.
- **`?particleInstancing` must NOT be retired** on the last handoff's prediction — measured, the prize is
  not zero (§4 #1).
- **`?staticScripts=off` is broken as a "floor"** and something is built on it (§4 #2).
- **The 5-town outdoor-run battery cannot see a particle change** — by construction, not by accident.
  Do not A/B particles with it (§2 rule 3).

## 1. WHAT WAS REFUTED / CORRECTED (do not re-inherit any of it)

| Claim (and where it came from) | Verdict |
|---|---|
| "RP6 leaks because the visibility flip fires only on TRANSITION while meshes carry `frustumCulled=false`" (prior handoff §3) | **RIGHT SYMPTOM, WRONG CAUSE.** The real cause: `_staticParticleManager` is built with `scene: scene3d.staticsGroup` (statics.js `_ensureStaticParticleManager`, :3779 at this commit), so `emitParticle()` parents every slot mesh as a DIRECT CHILD of that group — and `cullStaticsGroup` rewrote `node.visible` from a FRUSTUM-ONLY test EVERY frame (tickPerFrame), while RP6 wrote only on a transition, from its own rAF (`_spLoop`), every `_RP6.recheckInterval` ticks. Two writers; the per-frame one wins. `cullStaticsGroup` has NO distance horizon by default (`CULL_DIST_SQ === Infinity`) while RP6 also culls past 220 m, so the particles the two tests DISAGREE about — in frustum, past the cap, frozen mid-air — are exactly what leaked. |
| "fix (c) `frustumCulled=true` … doesn't fix the 220m-cap case" (prior handoff §3) | **CORRECT, and now explained:** three's frustum test IS the test that was resurrecting them. |
| "the extra ~169 draws are entity particles" (MINE, first cut of RESULTS §0b) | **REFUTED.** `tickEntityRenderVisibility` (entities.js:2134; writer at `_applyEntityVisible` :2043) iterates `entityMap` and writes only `inst.root.visible` via `_applyEntityVisible`. It never touches particle meshes. Not a second writer. |
| "floor is 181 (`?staticScripts=off` deletes the effects entirely), so instancing captures 95% of the available win" (url-flags `particleInstancing` row) | **NOT REPRODUCIBLE.** Measured at the pinned Cragstone: `anchors=0` but **586 emitters survive, 2872 particles draw, 5925 draws/frame, 5.86 fps** — ~8× WORSE than the default 237/46. The "95%" has no basis until someone re-derives a real floor. |
| "expect `?particleInstancing` to be worth ~nothing after the cull fix ⇒ retire it" (prior handoff §0/§3) | **DOES NOT HOLD.** Drawable particle meshes measured Cragstone 24, **Holtburg 225**, Shoushi 12. A scene DID draw 225 — the prize is not zero. (Attribution to Holtburg-the-place NOT established: those stops were unpinned. §5.2) |
| "§5.1 the A/B's ~2400 particle draws don't reconcile with the 152-mesh probe" (prior handoff) | **MOOT as posed.** The ~2400 WAS the leak. Post-fix, particle draws at the pinned pose are 24. |

## 2. HARD-WON MEASUREMENT RULES (new ones; the prior handoff's §2 all still stand)

1. **A regression test can be GREEN ON BROKEN SOURCE — always run it against the bug.** My first draft
   passed its headline guard pre-fix: it anchored an emitter 1200 m out, but an emitter culled from BIRTH
   never runs `updateParticles()`, so its meshes were never POSITIONED and sat at the local origin — the
   culler was testing a sphere at the camera, not the disputed one. Reproduce the FIELD condition IN ORDER
   (emit while visible+near, THEN retreat past the cap) and assert the **preconditions** (`placed=2/2`,
   `wanted=2/2`) so the guard cannot pass for the wrong reason. This is the prior handoff's §2 rule 1
   biting the person who had just read it.
2. **`particleType: 0` is `Unknown`, not `Still` (Still is 1).** The `Unknown` arm of `particle.update()`
   LEAVES `mesh.position` UNCHANGED, so an emitter built with 0 parks every particle at the local origin
   regardless of its anchor — silently voiding any test that depends on placement. **The comment
   `particleType: 0 /* Still */` is still WRONG in `test_particle_billboard.mjs`** (harmless there: its
   emitter sits at the origin anyway). That is where I inherited it.
3. **The outdoor-run battery CANNOT see a particle change.** Its generator picks a clear start "≥40 m out
   with no static within 25 m" down a 1–2 km obstacle-free corridor, and `default_script` emitters hang
   off statics — so the RUN phase traverses empty terrain: ~260–310 draws/frame out there vs ~574 in
   town. Measured: fps median 38.63 → 38.17 across 5 towns = flat, while the same fix is +42% in town.
   It is a terrain-streaming instrument. Use `town-fps-probe.mjs` at a pinned town pose.
4. **A cross-page-load A/B IS callable when it is an A/B/A and the effect dwarfs the spread.** Both FIXED
   legs agreed to **0.04%** on draws with identical p50/p95 → no drift → the PREFIX leg's 2.4× is real.
   Better: make the confound cut AGAINST you. FIXED had MORE particles than PREFIX (2451/9037 vs
   2158/7864) and FIXED2 had FEWER emitters (2125), and both still drew 2.4× less — a stochastic-plateau
   story would have to make the heavier scene cheaper.
5. **`fpsP50`/`fpsP95` in the battery are FRAME TIMES IN MS, not fps** (battery-outdoor-run.mjs:475 —
   percentiles of sorted rAF deltas; only `fps` is fps). Lower is better. They quantise to vsync:
   16.7 = 60 fps, 25 = 40, 33.3 = 30, 50 = 20. I mislabeled my own comparison table before catching it.
6. **`renderer.info.render.frame` is NOT reset by `info.reset()`** — it is cumulative since page load
   (reset() zeroes calls/triangles/points/lines only). Diff it yourself or use rAF count as the
   denominator. Pair with the known trap: `info.autoReset` defaults TRUE and zeroes counts per frame.
7. **Every probe bail MUST close its page first.** `tailnet1` is single-login: a page leaked by an abort
   stays logged in, and the NEXT run boots into a starved world (measured: emitters 563 / liveParticles
   197 vs 1893 / 5764 at the same pinned pose) and fails to settle too, or is rejected outright as
   `__bootState === "error"` — an abort that manufactures the next abort, looking like a boot bug.

## 3. ⭐ THE OPEN LEAD — is every visible particle submitted TWICE per frame?

**The evidence.** Reconciling the three measured legs as `draws = k*particles + nonParticle`:

| k | nonParticle draws implied (FIXED / PREFIX / FIXED2) | verdict |
|---|---|---|
| 1 | 212.9 / **381.9** / 217.0 | PREFIX ~169 out — **inconsistent** |
| 2 | 188.9 / **189.9** / 197.0 | all within ~4% — **consistent** |

and the arm delta implies `k = (573.9−236.9)/(192−24) = **2.01**`.

**Why it matters.** k≈2 means a second pass is submitting every particle again. That would (a) double the
value of every particle-draw saving, (b) re-open **"a second world render was ruled OUT"** from the
`particleInstancing` row — a ruling made with the per-object `onBeforeRender` hook the prior handoff
itself flagged as MIS-FIRING (§5.4: it attributed only 118 of 1574 draws, suspected duplicate three
module instances). A ruling from a broken instrument is not a ruling.

**Why it is NOT settled.** Three points fitting one free parameter is weak, and the FIXED↔FIXED2 pair
(Δparticles=4) cannot resolve k locally against ~4% non-particle noise. **Do not quote k=2.**

**How to settle it — a WITHIN-page-load A/B (the gold standard; immune to every confound in
settle.mjs's header):** settle at a pinned pose → sample draws/frame → force every `__particle` mesh
invisible IN-PAGE → re-sample → restore. `Δdraws / Δparticles` is k, measured in one scene with no
reload, no plateau, no pose variance. **Gotcha:** a naive `visible=false` is undone for UN-culled
emitters by `particle.js setTranslucency` (:110 sets `visible = true` whenever translucency < 1) on the
next tick — gate it inside the manager, or stub `ParticleManager.tick` for the sample window.
Do it at a HIGH-particle pose (Holtburg, ~225) so Δparticles dwarfs the noise; Cragstone's 24 will not.

## 4. REMAINING TASKS

1. **Decide `?particleInstancing` — but measure at HOLTBURG, pinned, first.** The prior handoff said
   retire it; that prediction fails (Cragstone 24 vs Holtburg 225 drawable). Re-measure the batching win
   on top of the correct cull at a high-particle PINNED pose (single-page-load A/B/A via
   `particle-instancing-ab.mjs`). Deciding from Cragstone alone repeats this chain's signature error.
   NOTE it composes with §3: if k≈2, instancing's prize is double what the mesh count suggests.
2. **`?staticScripts=off` is broken** (§1). Unverified mechanism: `_rp6ShouldCull` BAILS OPEN
   (`if (!parent) return false`) for an emitter with no usable anchor, so whatever survives the flag is
   never culled and every particle draws. Two things fall out: the flag is useless as a floor, and
   "an emitter with no parent is never culled" may be a live cost in the DEFAULT config too — worth a
   census of parentless emitters.
3. **#4 (inherited)** — framed brazier-flame hero shot + the 62-town walk, owed before any default flip.
   Parity is still proven by counts + identical frames, **not by seeing fire**. Select by `defaultScriptId`
   for a known brazier PES and raycast for line-of-sight.
4. **#6 (inherited)** — static script ANCHORS leak (138 → 631 over a tour) while emitters are reaped.
   LOW impact (Groups issue no draws). **Do not conflate with the particle draw cost.**

## 5. RESIDUALS / UNKNOWNS (honest loose ends)

1. **9 unowned drawable particle meshes — seen ONCE, never reproduced.** `orphan-particle-probe.mjs` at
   the pinned Cragstone: `drawable=24` = `15 occupied-slot + 0 free-slot + 9 owned by NOTHING` (parented
   to `statics`, `__particle`-stamped, in no emitter's `parts[]` **or** `partStorage`, opacity ≈0.2,
   scattered ≤600 units). Their emitter is gone from `particleTable`, so after this fix nothing will ever
   hide them (`cullStaticsGroup` was incidentally frustum-culling them before — that accidental safety
   net is gone BY DESIGN). **But `orphan-growth-probe.mjs` measured `ORPHAN=0` at the same POI, same
   flags, same `drawable=24`, and 0 at every stop of a 4-POI tour (0→0→0→0)** — so they are rare/transient
   (an emitter mid-teardown), NOT accumulating. The two probes disagree; that is recorded, not laundered.
   If someone picks it up: **both** teardown paths (tick()'s auto-finish removal :1170 and
   `destroyParticleEmitter` :1357) detach only `e.parts` and walk `partStorage` for **materials only** —
   and the auto-finish comment itself says "PartStorage may still hold mesh refs that were never claimed".
2. **"Holtburg 225" is a real settled number but NOT an established property of Holtburg.** Only the
   Cragstone rows used `pinPose`; the tour stops were `@telepoi` landings, and §2 rule 6 of the prior
   handoff says placement dominates VISIBLE particles (73% spread) and draws (186%) at a FIXED POI. It
   could be where the camera happened to land. Travel also reaps emitters (1879 → 1060 → 847 → 864 across
   those stops). Enough for "don't retire the flag"; not enough for "Holtburg is dense".
3. **Yaraq's battery result is unattributed** — fps 22.57 → 38.17, draws 744 → 288, the only big move in
   the 5-town run. Its arm-A leg followed a session abort, with 232 long-tasks vs 153 and a different heap
   trajectory. **Do not quote it.** Sawato hung on arm A entirely (eval-timeout, main-thread hang) and is
   unpaired — worth a look on its own.
4. **`_RP6_MAX_DIST_SQ` (particle_manager.js:131) is still dead** — computed, never read; the distance
   gate recomputes `slack` inline. Pre-existing. The constant is not the knob it looks like.
5. **The `blockingParticleParity` source-grep assertions in `test_a11_s0_blocking_particle.mjs` fail
   (45/3) on a CLEAN tree.** Pre-existing, verified against `bbd8586f`. Not mine, not investigated.
6. **The architectural cure already exists in-repo.** `entities.js _applyEntityVisible` composes
   `_stateVisible` (state) and `_renderCullHidden` (cull) into one `want` — its own comment calls state
   "producer #1". That is the pattern statics/particles lacked, and it is what made this a one-line-class
   bug. If a THIRD writer of particle `visible` ever appears, compose; do not race.

## 6. HARNESS (all on master, `net-review/`)

- **`town-fps-probe.mjs`** — **THE instrument for a particle change.** Frame time + draws + culled/drawable
  particle census at a SETTLED, PINNED town pose. `LABEL=X POI=Cragstone PIN_POSE="0xbb9f0040 169.36
  168.25 54.01" SAMPLE_S=40 OUT=/mnt/wbterminal2/tmp/x.json node town-fps-probe.mjs`; `EXTRA_Q="k=v"` for
  extra flags. Every bail closes the page (§2 rule 7).
- **`orphan-particle-probe.mjs`** — classifies every drawable particle mesh in staticsGroup by owner
  (occupied slot / free slot left visible / no owner). **`orphan-growth-probe.mjs`** — the same count
  across a POI tour in ONE page load (an orphan count is a property of the scene graph, not of where the
  camera looks — which is what makes it readable across POIs despite the pose confound).
- **`test_particle_rp6_cull_authority.mjs`** (in `$HOLT/`) — 16 checks; drives the REAL manager + the REAL
  `cullStaticsGroup`, because the bug lived in the SEAM and mocking either side asserts it away. Verified
  to FAIL on pre-fix source. `node test_particle_rp6_cull_authority.mjs` from `$HOLT/`.
- Inherited and still true: **`settle.mjs`** (read its header — it documents all four confounds with the
  numbers), **`particle-instancing-ab.mjs`** (single-page-load A/B/A), **`culled-draw-probe.mjs`** (its
  printed VERDICT line lies — arbitrary `>200` threshold; read the ratio).
- **A/B arms:** `/mnt/wbterminal2/tmp/{townfps-prefix,townfps-fixed,townfps-fixed2,townfps-floor}.json`,
  `{ab-prefix,ab-fixed}.json` + `*-wrapper.log`, `PREFIX-samples-*.jsonl`, `FIXED-samples-*.jsonl`.

## 7. OPS / GIT

- **1070:** `schtasks /run /tn cdpwbclaude` (headless, muted, off-screen, `--user-data-dir=C:\Temp\cdpwb-claude`);
  tunnel `ssh -fN -L 9333:127.0.0.1:9333 -R 8765:127.0.0.1:8765 young@100.127.215.75`. Assert
  `UNMASKED_RENDERER == "ANGLE (NVIDIA ... GTX 1070 ... Direct3D11)"`. Kill test chrome by
  `cdpwb-claude` cmdline match ONLY — **a person uses that box**.
- **`serve.py --check` VALIDATES AND EXITS (no server)** — it is not a server flag; run bare `serve.py`
  to serve. Its "pkg wasm predates the last Rust-touching commit" warning fired here and the rebuilt
  release wasm came out **byte-identical** (`cmp` clean) — so prior numbers were not wasm-confounded.
  Rebuild anyway when it fires (2m50s); the alternative is measuring the wrong path.
- **Do NOT use `git stash` for A/B in this repo.** It carries 3 pre-existing stash entries; a `git stash
  push` with paths relative to the wrong cwd fails silently, and the follow-up `git stash pop` then pops
  SOMEONE ELSE'S stash into your tree (conflicts in cells.js + scripts/diag/*). Recovered with
  `git checkout HEAD -- <paths>`, all 3 stashes intact. **A/B with plain file copies** (`git show
  <sha>:<path> > <path>`), which is also what makes a source A/B safe: JS is served LIVE by serve.py, so
  no rebuild is needed between arms.
- **`pgrep -f X` / `pkill -f X` where X appears in your own command line = self-kill, exit 144.** Bit
  twice (`rust-analyzer`, `serve.py`). Use `pgrep -x`, or resolve the PID from `ss`.
- Direct push to `origin/master` works (confirmed again this session). This session:
  `e79951e9` the fix + regression test + RESULTS · `2373208c` the fps A/B/A + town-fps-probe ·
  `16c3cf95` the 337-vs-168 residual + `?staticScripts=off` correction. This handoff is UNCOMMITTED at
  time of writing — commit it.

# RESULTS — task #9: the RP6 particle visibility leak is FIXED

**Date:** 2026-07-15 · **Box:** wbterminal laptop → 1070 (tailscale, CDP :9333, real GPU, release wasm)
Executes the ⭐ open lead of `HANDOFF-perf-particles-rp6-leak-2026-07-15.md` §3.

---
## 0. TL;DR

- **The leak is real, it is fixed, and its CAUSE WAS NOT THE ONE IN THE HANDOFF.** The handoff (and the
  three sessions before it) blamed "the visibility flip fires only on TRANSITION". That is a true
  statement about the code and it is NOT what was resurrecting the particles.
- **Actual cause: TWO WRITERS of the same `mesh.visible`.** `_staticParticleManager` is constructed with
  `scene: scene3d.staticsGroup` (statics.js:3761), so `emitParticle()` adds every per-slot particle mesh as
  a **direct child of staticsGroup**. `cullStaticsGroup` (statics.js) walks `group.children` and writes
  `node.visible = want` from a **frustum-only** test, **every frame**, from `tickPerFrame`. RP6 wrote only
  on a cull TRANSITION, from its **own rAF** (`_spLoop`, statics.js:4407), every `_RP6.recheckInterval`
  ticks. The per-frame writer wins, always.
- **Why that produced exactly the observed population.** `cullStaticsGroup` has no distance horizon by
  default (`CULL_DIST_SQ === Infinity` unless `?cullDist=N`); RP6 additionally culls past
  `_RP6.maxDistance` (220 m). The particles the two tests DISAGREE about — in frustum, past the cap,
  frozen mid-air — are precisely the ones that leaked. This is also why the handoff's candidate fix (c)
  (`frustumCulled = true`) was correctly diagnosed as "doesn't fix the 220 m-cap case": three's own frustum
  test is the same test that was already resurrecting them.
- **MEASURED (1070, pinned Cragstone): parts of CULLED emitters `VISIBLE = 0`, was 140 of 2824.**
- **Draw win at the pinned pose: 152 → 24 drawable particle meshes.**
- **⚠ The handoff's expectation that `?particleInstancing` is now worth ~nothing DOES NOT HOLD.** See §4.

## 0b. DOES IT MOVE FPS? YES — IN TOWN. (added 2026-07-15, after the first writeup)

**Settled, pinned Cragstone (`0xbb9f0040 169.36 168.25 54.01`), 1070 real GPU, release wasm, weather
off, shipping defaults (NOTE: `buildingBatch` ON — the older probes passed `buildingBatch=off`, which is
why their totals are ~1600 and these are ~240). `town-fps-probe.mjs`, 40 s of rAF deltas each:**

| leg | fps | p50 frame | p95 frame | draws/frame | culled-but-drawing | drawable particles | emitters / liveParticles |
|---|---|---|---|---|---|---|---|
| FIXED | 45.94 | 24.9 ms | 25.1 ms | 236.9 | 0 | 24 | 2451 / 9037 |
| **PREFIX** | **32.28** | **33.3 ms** | **41.7 ms** | **573.9** | **180** | 192 | 2158 / 7864 |
| FIXED2 (return-to-A) | 47.04 | 24.9 ms | 25.1 ms | 237.0 | 0 | 20 | 2125 / — |

**fps 32.3 → ~46 (+42%), draws/frame 574 → 237 (−59%), median frame 33.3 ms → 24.9 ms (30 → 40 fps).**

Why this is callable despite being a cross-page-load A/B (§2 rule 2): it is an **A/B/A** (rule 3) and the
two FIXED legs agree to **0.04%** on draws (236.9 vs 237.0) with identical p50/p95 — the scene did not
drift under us. And the confound cuts the WRONG way for a false positive: FIXED had MORE particles than
PREFIX (2451/9037 vs 2158/7864) and FIXED2 had FEWER emitters than PREFIX (2125 vs 2158), yet both FIXED
legs drew 2.4× less. A stochastic-plateau explanation would have to make the heavier scene cheaper.

**⚠ THE 5-TOWN OUTDOOR-RUN BATTERY SHOWS ~NOTHING — AND THAT IS EXPECTED, NOT A CONTRADICTION.**
`battery-outdoor-run.mjs` over Yaraq/Samsur/Holtburg/Sawato/Nanto (`--runS 60`, weather off, real GPU):
fps median across POIs 38.63 → 38.17, i.e. flat; per-POI Holtburg +9.2%, Nanto +4.7%, Samsur −7.5%,
Yaraq +69% (see below), Sawato unpaired (arm A hung: eval-timeout). Draws/frame were FLAT or slightly up
at 3 of 4 paired POIs (261→276, 310→311, 227→244). **The battery cannot see this fix by construction:**
its generator picks a clear start "≥40 m out with no static within 25 m" and a 1–2 km obstacle-free
corridor, and static `default_script` emitters hang off statics — so the RUN phase deliberately traverses
empty terrain. Measured: ~260–310 draws/frame out there vs ~574 (pre-fix) at the settled town centre.
It is a terrain-streaming instrument and it barely contains particles. **Do not use it to A/B a particle
change; use `town-fps-probe.mjs` at a pinned town pose.**
Yaraq is the one battery POI with a big move (fps 22.57→38.17, draws 744→288) and it is also the LEAST
trustworthy pairing in the set: its arm-A run came after a session abort, with 232 long-tasks vs 153 and
a different heap trajectory. **Unattributed — do not quote it.**

### 0c. The "337 vs 168" residual — resolved to a candidate, and my first hypothesis was WRONG

Draws fell 337 but staticsGroup drawable particles only fell 168 (192 → 24), so ~169 draws/frame came
off something the particle counter did not count.

- **REFUTED — "it's entity particles."** I first guessed that `_setPartsVisible` (which lives in
  `ParticleManager`, shared by `_staticParticleManager` and `entities.js _worldParticleManager`) was
  closing the same two-writer race in `entitiesGroup`, since `loop.js` registers an entities culler.
  **Code says no:** `tickEntityRenderVisibility` (entities.js:2134) iterates `entityMap` and writes
  visibility ONLY via `_applyEntityVisible` → `inst.root.visible` — the rig root. It never touches
  particle meshes parented into `entitiesGroup`. Not a second writer. (Worth stealing from that file,
  though: it composes `_stateVisible` and `_renderCullHidden` into one `want` — "producer #1" per its
  own comment. That is the pattern statics/particles lacked, and is exactly this bug's cure.)
- **CANDIDATE (fits, not independently confirmed): each drawable particle mesh costs ~2 draws/frame.**
  Reconciling the three legs as `draws = k*particles + nonParticle`:
  - k=1 → nonParticle = 212.9 / **381.9** / 217.0 — the PREFIX leg is ~169 out. Inconsistent.
  - k=2 → nonParticle = 188.9 / **189.9** / 197.0 — all three agree within ~4%. Consistent.
  - and the arm delta implies k = (573.9−236.9)/(192−24) = **2.01**.
  Caveat: three points fitting one free parameter is weak, and the FIXED↔FIXED2 pair (Δparticles=4)
  does not resolve k locally. A k≈2 would mean each visible particle is submitted in TWO passes per
  displayed frame — which would RE-OPEN the "second world render" that the `?particleInstancing` row
  ruled out, because that ruling used the per-object `onBeforeRender` hook the handoff itself later
  flagged as MIS-FIRING (§5.4: it attributed only 118 of 1574 draws). Do not treat either as settled.

**⚠ `?staticScripts=off` DOES NOT DO WHAT url-flags SAYS — do not use it as a "floor".** The row claims
it "deletes the effects entirely" with a draw floor of 181. Measured at the pinned Cragstone on the fixed
build, it is a PESSIMISATION: `anchors=0` (static-script emitters really are gone) but **586 emitters
survive, 2872 particle meshes draw, 5925 draws/frame, 5.86 fps** — ~8× worse than the default config's
237 draws / 46 fps. It is not the sky chain (`attachSkyParticleChain` honours the same kill switch,
statics.js:4017). Likely mechanism, unverified: `_rp6ShouldCull` BAILS OPEN (`if (!parent) return false`)
for an emitter with no usable anchor, so whatever survives the flag is never culled and every particle
draws. This voids the "floor is 181 ⇒ instancing captures 95% of the available win" claim in that row.
Attempted as the decisive test of k above; it cannot serve as one, since it changes the scene wholesale.

## 1. THE FIX (2 files, always-on, no flag)

1. **`statics.js cullStaticsGroup`** — skip `userData.__particle === true` /
   `userData.isParticleInstanced === true` nodes. RP6 is the sole owner of particle visibility; this pass
   must not be a second writer. Skipping BEFORE `tested` also keeps its diag counts about real statics
   (consistent with the census particle fix `de24059d`).
2. **`particle_manager.js tick()`** — the cull is now AUTHORITATIVE PER TICK: while `_rp6Culled`, occupied
   slots are re-asserted invisible EVERY tick (new `_setPartsVisible`, reads before it writes). The
   transition block now handles only the RE-ENTRY (culled → visible) direction. This is the handoff's
   preferred fix (a), and it generalises the re-hide that already existed on the stopped-drain path — whose
   comment named the exact reason (`particle.js setTranslucency` flips a living slot back to visible) but
   scoped the cure to the drain window.

Fix 1 is what closes the measured leak. Fix 2 is what makes the cull hold against ANY future per-frame
writer — including the `setTranslucency` path — instead of hoping. Both are cheap; `_setPartsVisible`
compares before writing, so steady state dirties nothing (~17k compares/frame at Cragstone ≈ 50 µs,
against 128 draw calls saved).

## 2. VALIDATION

### 2a. Regression test — `apps/holtburger-web/test_particle_rp6_cull_authority.mjs` (16 checks)
Drives the **REAL** `ParticleManager` and the **REAL** `cullStaticsGroup` against one shared
`staticsGroup`. No replica of either: the bug lived in the SEAM between them, and mocking either side
asserts the seam away. Verified to **FAIL on pre-fix source** (5 checks red) and pass after:

| guard | HEAD (pre-fix) | fixed |
|---|---|---|
| 1. statics cull does not resurrect distance-culled particles | **FAIL** `visible=2/2` | OK `visible=0/2` |
| 1b. still hidden after 30 more statics-cull frames | **FAIL** `visible=2/2` | OK `visible=0/2` |
| 2. one tick re-hides after a hostile per-frame writer, NO transition | **FAIL** `visible=2/2` | OK `visible=0/2` |
| 3. statics cull still tests REAL statics (skip is particle-scoped) | **FAIL** `tested=4` | OK `tested=2 culled=1` |
| 3. particles stay hidden through the real-statics pass | **FAIL** `visible=2/2` | OK `visible=0/2` |
| 4. re-entry still restores particles (cull stays reversible) | OK | OK |

Full particle suite green after the fix: `test_particles` 58/58, `test_particle_billboard` 8/8,
`test_particle_clock` 45/45, `test_particle_owner` 42/42, `test_a11_s4_particle_degrade` 30/30,
`test_vfx_particle_install` 49/49. (`test_a11_s0_blocking_particle` is 45/3 — the 3
`blockingParticleParity` source-grep failures are PRE-EXISTING, confirmed identical on a clean tree.)

### 2b. Live — `culled-draw-probe.mjs`, 1070, release wasm, pinned pose
```
POI=Cragstone PIN_POSE="0xbb9f0040 169.36 168.25 54.01" node culled-draw-probe.mjs
SETTLED @Cragstone after 61s (plateau from ~t+22s, held 38s): emitters=1893 anchors=138
  liveParticles=5764 terrEverBaked=121 entRoots=51 pose=0xbb9f0040 (169.36,168.25,54.01) hdg=0

emitters=1893  culled=1886  notCulled=7
parts of CULLED    emitters: total=5749 inScene=5749 VISIBLE(=drawing)=0     <-- was 140 of 2824
parts of NOTCULLED emitters: total=15   inScene=15   VISIBLE(=drawing)=15
drawable particle meshes in staticsGroup = 24                                <-- was 152
```
**Read the ratio, not the probe's verdict line** (§2 rule 10 — its `culled_visible > 200` threshold is
arbitrary, so at 0 it now prints the "instancing is dropping live particles" verdict, which is nonsense
here). Why this is trustworthy despite the ~25% plateau stochasticity: `culled_visible` is an
**invariant inside ONE page load** (a ratio: of the parts belonging to culled emitters, how many draw?),
not a cross-page-load draw count. It is 0 out of 5749 — and this run had **2× MORE** culled parts than
the handoff's (5749 vs 2824), so a surviving leak would have shown MORE leakage, not zero. All 15
legitimately-live particles still draw, so the cull dropped nothing real.

## 3. WHAT THE HANDOFF GOT WRONG (and how it was caught)

The handoff's §2 rule 1 — *"a confident number against the WRONG QUESTION is worse than no number"* — bit
this session too, in the regression test itself. Recorded because the trap is subtle and repeatable:

- **Draft 1 of the test was GREEN against BROKEN source** on its headline guard. It anchored an emitter
  1200 m away and asserted the statics cull didn't resurrect it. It passed — because the emitter was
  culled from BIRTH, so `updateParticles()` never ran, so its slot meshes were never POSITIONED and sat at
  the local origin. `cullStaticsGroup` was therefore testing a sphere at the camera, not the disputed one.
  The fix: reproduce the FIELD condition in order — emit **while visible and near** (meshes get placed),
  THEN retreat past the cap. The test now asserts `placed=2/2` and `wanted=2/2` (the statics pass really
  does want them visible) as **load-bearing preconditions**, green on BOTH arms, so the guard cannot
  silently pass for the wrong reason again.
- **`particleType: 0` is `Unknown`, NOT `Still`** (Still is 1). The `Unknown` arm of `particle.update()`
  *leaves `mesh.position` unchanged*, so an emitter built with 0 parks every particle at the local origin
  regardless of its anchor — silently voiding any test that depends on particle placement. The mislabeled
  comment `particleType: 0 /* Still */` was inherited from `test_particle_billboard.mjs`, which never
  noticed because its emitter is anchored at the origin anyway. **That comment is still wrong in that
  file.**

## 4. ⭐ THE OPEN LEAD — do NOT retire `?particleInstancing` on Cragstone data

The handoff §3 predicted: *"re-measure `?particleInstancing` on top of a correct cull to learn what
batching is ACTUALLY worth — likely ~nothing ⇒ retire the flag."* **The tour says otherwise.** Drawable
particle meshes (= particle draw calls) on the FIXED build, one page load, `orphan-growth-probe.mjs`:

| POI | emitters | particle meshes in group | **drawable** |
|---|---|---|---|
| Cragstone (1st) | 1879 | 5705 | **24** |
| Holtburg | 1060 | 1610 | **225** |
| Shoushi | 847 | 406 | **12** |
| Cragstone (2nd) | 864 | 409 | **24** |

At Cragstone's pinned pose the remaining batching prize really is ~24 draws → "retire it" looks right.
**At Holtburg 225 particle meshes still draw**, and instancing would collapse those to ~1 per gfxobj. So
the prize is NOT zero. Deciding the flag's fate from the Cragstone pose alone would be the exact error
this whole handoff chain is about. **Re-measure at Holtburg** (single-page-load A/B/A, pinned pose)
before retiring anything.

**⚠ CAVEAT ON THAT TABLE — the tour stops were NOT pinned.** Only the Cragstone row above comes from a
`pinPose` run; Holtburg/Shoushi/the second Cragstone were `@telepoi` landings, and §2 rule 6 says player
placement dominates VISIBLE particles (73% spread) and draws (186% spread) at a FIXED POI. So "225" is a
real settled measurement — a scene DID draw 225 particle meshes, which is all the "don't retire it" claim
needs — but **the attribution to Holtburg-the-place is NOT established**: it could be where `@telepoi`
happened to drop the camera. Travel also reaps emitters (1879 → 1060 → 847 → 864 across these stops), so
the later rows carry a smaller emitter population than the first. Pin the pose before quoting any of
these as a property of a POI.

## 5. RESIDUALS / HONEST LOOSE ENDS

1. **9 unowned drawable particle meshes, seen ONCE, not reproduced.** `orphan-particle-probe.mjs` at the
   pinned Cragstone found `drawable=24` split `15 occupied-slot + 0 free-slot + 9 owned by NOTHING` —
   parented to `statics`, carrying `__particle`, in no emitter's `parts[]` **or** `partStorage`, opacity
   ≈0.2, scattered up to 600 units out. Their emitter is gone from `particleTable`, so after this fix
   nothing will ever hide them (before it, `cullStaticsGroup` was incidentally frustum-culling them — that
   accidental safety net is now gone, by design). **But `orphan-growth-probe.mjs` measured `ORPHAN=0` at
   the same POI with the same flags and the same `drawable=24`, and 0 at every stop of a 4-POI tour
   (0 → 0 → 0 → 0).** So they are rare/transient (an emitter mid-teardown), NOT accumulating. Both probes
   are committed; the disagreement is real and unexplained — do not launder it into a story either way.
   A plausible source if someone picks it up: **both** teardown paths (tick()'s auto-finish removal
   :1173 and `destroyParticleEmitter` :1361) detach only `e.parts` and walk `partStorage` for **materials
   only**, never detaching storage meshes — and the auto-finish comment even says "PartStorage may still
   hold mesh refs that were never claimed". Related to handoff task #6; do NOT conflate with the draw cost.
2. **Handoff §5.1 (the A/B magnitude that would not reconcile) is now moot as posed** — it compared a
   ~2400-draw A/B against a 152-mesh probe. With the cull correct, particle draws at the pinned pose are
   24. The old ~2400 was the leak.
3. **`_RP6_MAX_DIST_SQ` (particle_manager.js:131) is still dead** — computed, never read (the distance
   gate recomputes `slack` inline). Pre-existing; flagged by tsserver. Untouched here.
4. **The rebuilt release wasm is BYTE-IDENTICAL to the pre-existing pkg** (`cmp` clean), despite serve.py
   warning it predated a Rust-touching commit (`0c466f3f`, holtburger-core client). So the prior session's
   numbers were not wasm-confounded. Rebuild anyway when the warning fires — it is cheap (2m50s) and the
   alternative is measuring the wrong path.
5. **Not done from handoff §4:** task #4 (brazier hero shot + 62-town walk) and task #6 (anchor leak).
   Untouched.
6. **`?staticScripts=off` is broken as a measurement floor** (§0c) — 5925 draws / 5.86 fps where the doc
   promises a 181-draw floor. Its own row's "instancing captures 95% of the available win" rests on that
   number. Worth its own look; not chased here.
7. **Is k≈2 real?** (§0c) If each visible particle really is submitted twice per displayed frame, there is
   a second pass nobody has accounted for, and the cheap prize is halving it. The clean way to settle k
   without a page reload: at a pinned pose, sample draws, then force every `__particle` mesh invisible
   in-page and re-sample — a WITHIN-page-load A/B, immune to every confound in settle.mjs's header.
   (Naive `visible=false` will be undone for un-culled emitters by `particle.js setTranslucency`, so gate
   it at the manager or stub the tick for the sample window.)

## 6. HARNESS ADDED (`net-review/`)

- **`town-fps-probe.mjs`** — frame time + draws at a SETTLED, PINNED town-centre pose. THE instrument for
  a particle change; the outdoor-run battery is NOT (§0b). Every early exit closes the page first:
  tailnet1 is single-login, so a page leaked by a bail starves the next run (measured: emitters 563 /
  liveParticles 197 vs 1893 / 5764 at the same pinned pose) or gets it rejected outright as
  `__bootState === "error"` — an abort that manufactures the next abort. Both of its bails leaked a page
  before this was fixed, and both symptoms were observed.
- **`orphan-particle-probe.mjs`** — classifies every drawable particle mesh in staticsGroup by owner
  (occupied slot / free slot left visible / no owner). Answers a question; prints no verdict.
- **`orphan-growth-probe.mjs`** — the same count across a POI tour in ONE page load. Orphan count is a
  structural property of the scene graph, not of where the camera looks, which is what makes it readable
  across POIs despite the pose confound that voids cross-POI DRAW comparisons.

## 7. OPS

- 1070 bring-up per the handoff: `schtasks /run /tn cdpwbclaude`, tunnel `-L 9333 -R 8765`. Test chrome
  matched by `--user-data-dir=C:\Temp\cdpwb-claude` ONLY; the person's chrome untouched.
- `serve.py --check` **validates and EXITS (no server)** — it is not a server flag. Run bare `serve.py` to
  actually serve. (`--help` says so; worth knowing before you conclude the server died.)
- **Do NOT use `git stash` for A/B in this repo.** It carries 3 pre-existing stash entries; a `git stash
  push` with paths relative to the wrong cwd fails silently, and the follow-up `git stash pop` then pops
  SOMEONE ELSE'S stash into your tree (conflicts in cells.js + scripts/diag/*). Recovered via
  `git checkout HEAD -- <paths>` with all 3 stashes intact. A/B with plain file copies instead.
- `pgrep -f X` / `pkill -f X` where X appears in your own command line = self-kill, exit 144. Bit twice
  (`rust-analyzer`, `serve.py`). Use `pgrep -x`, or match by PID from `ss`.

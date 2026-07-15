# HANDOFF — both DoubleSide two-passes are FIXED. The frame is now CPU-BOUND IN three's SUBMISSION.

**Date:** 2026-07-15 · **Box:** wbterminal laptop → 1070 (tailscale, CDP :9333, real GPU) · **Self-contained.**
Supersedes `HANDOFF-perf-doubleside-twopass-2026-07-15.md` (its ⭐ §5.1 is DONE) and, transitively,
`HANDOFF-perf-particles-second-pass-2026-07-15.md`. Read those two only for the reasoning trail; every
number that matters is restated here, and the ones they got wrong are corrected in §1.
REPO=`/home/wbterminal/WorldBuilder-ACME-Edition`, HOLT=`$REPO/external/holtburger/apps/holtburger-web`,
net-review=`$REPO/external/holtburger/scripts/net-review`. Tree clean; all on `origin/master` (`933fa807`).

---
## 0. TL;DR — where we are

- **Both halves of three's DoubleSide two-pass are fixed.** Particles (`8806e130`, pixel-identical, no
  flag) and surfaces (`446e5b4c`, `?surfaceSinglePass`, **default ON**, `=off` escapes). At a settled
  Holtburg the draw budget went **2,168 → 1,924 draws/frame** and **renderCPU 39.94 → 28.72 ms/frame**.
- **The surface half is a PARITY FIX, not a trade** — retail draws a two-sided surface ONCE with
  `CULLMODE_NONE`; the back-then-front two-pass is a three-ism with no retail counterpart. §2.
- **⭐ THE LEAD: the frame is CPU-BOUND INSIDE `renderer.render()` — ~25 ms of a ~33 ms frame, at ~1,920
  draws.** Not fill, not shaders, not particles. The next lever is **draw-call COUNT**. §3.
- **A second, possibly bigger lead falls out of the same measurement: ~66 µs per draw is ~10× what a draw
  call costs.** Something per-object per-frame is expensive in three's submission, and the prime suspect
  (`needsUpdate` → program re-resolve) is a pattern that may exist ELSEWHERE in this codebase. §3.2.
- **A parity gap worth real fps, already written and REVERTED — `?perPolyCull`. Treat it as the HARD one.**
  We draw every surface `DoubleSide` while retail culls per polygon; the flag exists and its semantics match
  the decomp, but per the **user, first-hand: it "breaks the rendering of the inside of buildings viewed from
  the outside"**. That may mean our winding is wrong — or that the cull is RIGHT and retail pairs it with
  something we lack. Settle that before chasing the fps. §3.3.
- **`draw-budget-probe.mjs` is committed and UNRUN.** It is the first thing to run. §3.1.

## 1. WHAT WAS REFUTED / CORRECTED (do not re-inherit any of it)

| Claim (and where it came from) | Verdict |
|---|---|
| "the scene-wide flip is worth **+32% fps**" (prior handoff §5.1) | **DOUBLE-COUNTED.** That was measured against the UNFIXED baseline and included the particle fix, which had already shipped. The honest incremental (particles already fixed, one page load) is 20.75 → 30.16 fps, reproduced at +54.8% and +40.5%. |
| "the win is **fill rate**, so it scales with translucent screen coverage" (MY first draft of the url-flags row + materials.js comment) | **REFUTED, by measurement not argument.** Both paths rasterize the SAME fragments — BackSide-then-FrontSide covers exactly what one DoubleSide pass does — so there is no overdraw to save. Wall time INSIDE `renderer.render()` (which returns at SUBMIT, before the GPU runs) falls **39.94 → 24.26 ms/frame** while the frame falls 49.9 → 33.3: **~95% of the win is CPU submission.** The conclusion "it scales with translucent coverage" survives, but for the wrong reason (more translucent meshes = more double-submits), and the fill story would have sent the next session hunting shaders. |
| "flipping it is **NOT safe** — 3,688 px change, needs judgment" (prior handoff §5.1) | **INVERTED BY THE DECOMP.** Retail's `D3DPolyRender::DrawPolyInternal` (acclient.c:455306) picks ONE cull mode and issues ONE draw. Single-pass is what the retail client PUT ON SCREEN; the two-pass is our deviation. The changed pixels move TOWARD parity. §2. |
| "the fix has landed (funnel patched, 10/10 tests green)" (MY belief, mid-session) | **FALSE, and only the FIELD caught it.** `readSurfaceUnifiedFlag()` is default-OFF, so entities.js takes a LEGACY inline ladder that never reaches `applySurfaceRenderState` — the funnel I had patched. **403 of 451 meshes were still double-submitted**; the probe still found 26 materials to flip and **+40% fps still sitting there** after the "fix". §6 rule 1. |
| "our read path IGNORES the DAT's per-poly `SidesType`, so honouring it is a big new plumbing project" (MY first draft of §3.3, ~an hour before this was committed) | **FALSE — and it is instructive HOW.** `sidesTypes` is fully plumbed wasm→JS and `?perPolyCull` has existed since 2026-05-28. My "it appears only in the dat-WRITE crate" came from a grep run as `rg -rn …` — i.e. **`-r n` = `--replace n`**, which silently rewrote every match, so `poly.sides_type` PRINTED as `poly.n` and the read-path hits were truncated away by `head`. MEMORY.md warns about this exact footgun and I hit it anyway. The lead survived only because I verified the claim before shipping the handoff. **Never pass `-r` unless you mean --replace.** |
| "+45% fps" as a general figure | **SCENE-DEPENDENT — DO NOT QUOTE IT BARE.** It was measured with a large translucent creature in frame. Cragstone's two paths differ by **22 px, max delta 1** — nothing translucent on screen ⇒ nothing to save. |

## 2. WHAT LANDED, AND WHAT IT IS WORTH

**`8806e130` particles** — `mat.forceSinglePass = true` on the per-slot clone + the instanced bucket.
Always-on, no flag: a particle is a FLAT quad (222/222 meshes, 6 verts), so the dropped pass was entirely
face-culled and emitted no fragments. **k (draws per visible particle) 2.01 → 1.00**, verified by the same
instrument on both sides. **Pixel-identical: EXACTLY 0 px**, with a 0-px control at both ends.

**`446e5b4c` surfaces** — `applyRetailSinglePass(mat)` at the three ladders that actually decide
`transparent`: `applySurfaceRenderState` (materials.js), the `_materialFromFlags` legacy opts ladder
(materials.js), and **the legacy paletted/dyed ladder in entities.js — the one that actually runs**.
`?surfaceSinglePass=off` restores three's two-pass.

**The parity argument (this is the load-bearing part, and it is from the decomp, not from taste):**
```c
// D3DPolyRender::DrawPolyInternal — acclient.c:455306
if ( override_cull_state_0 || p->sides_type == 1 )
    RenderDeviceD3D::SetCullMode(..., CULLMODE_NONE);   // two-sided -> cull nothing
else
    RenderDeviceD3D::SetCullMode(..., CULLMODE_CW);
...
RenderDeviceD3D::DrawPrimitiveUP(D3DPT_TRIANGLEFAN, p->num_pts - 2, ...);   // ONCE
```
`CullModeType` = acclient.h:5294 (`CULLMODE_NONE=1, CW=2, CCW=3`). The 3 `DrawPrimitiveUP` sites in that
function are **mutually-exclusive vertex-format branches** (detail-texturing), not repeat draws — checked.
One cull mode, one draw. **there is no back-then-front two-pass anywhere in retail.**

**Numbers (1070, settled Holtburg, `particleInstancing=off`, weather off):**

| | draws/f | tris/f | renderCPU/f | fps | p50 |
|---|---|---|---|---|---|
| before both fixes (`?surfaceSinglePass=off`) | 2168.3 | 461,327 | **39.94 ms** | 21.27 | 49.9 ms |
| after both fixes (default) | **1924.1** | 444,096 | **28.72 ms** | 27.6 | 33.4 ms |

⚠ Those two rows are DIFFERENT PAGE LOADS, so the absolute fps gap is directional only (settle.mjs §4:
the plateau alone is worth ~25%). What is trustworthy is the **within-page-load** A/B that produced them:
scene-wide flip = **−236 draws / −15.7 ms renderCPU / 20.75 → 30.16 fps**, A2 drift 0.00 fps, and a
**0-material PLACEBO arm moved −0.06 fps**. After the fix the same arm finds **−4.8 draws** — i.e. nothing
left. That pair (big before, ~0 after, same instrument) is the real proof the source change landed.

**Eye test — 3 settled POIs, 0-px-control instrument, both arms rendered in ONE synchronous instant so
scene state is identical BY CONSTRUCTION** (`singlepass-eyetest.mjs`; PNGs at
`/mnt/wbterminal2/tmp/eyetest-tour/<POI>-{A-twopass,B-singlepass,D-diff-x8}.png`):

| POI | px changed | max delta | what changed |
|---|---|---|---|
| Holtburg | 3,730 (0.726%) | 101 | **ONE translucent creature** |
| Shoushi | 1,778 (0.346%) | 94 | **ONE translucent creature** |
| Cragstone | 22 (0.004%) | **1** | nothing (nothing translucent in frame) |

No world geometry, no glitches; single-pass reads slightly more saturated. Yaraq **did not settle and was
SKIPPED, not counted** (§5.3).

## 3. ⭐ THE LEAD — the frame is CPU-bound in submission

### 3.1 Attack draw-call COUNT. Measure first; `draw-budget-probe.mjs` is committed and UNRUN.
`renderCPU` is **~25 ms of a ~33 ms frame** at ~1,920 draws/frame, settled Holtburg, on a GTX 1070. The
GPU is not the problem and neither are shaders — three's CPU-side submission is. Everything below the fold
follows from that one number.

**`draw-budget-probe.mjs`** (on master, **never run** — I wrote it and the session ended on the surface
fix) hides one subtree at a time INSIDE one page load and reports what each costs, plus a census of plain
`Mesh` vs `BatchedMesh` vs `InstancedMesh`. The gap between "**2,271 plain meshes**" and "what they would
cost batched" IS the prize. `GROUPS=statics,entities,terrain,worldRoot POI=Holtburg node draw-budget-probe.mjs`.
**Run it before picking a target.** Memory's standing lead ("instanced anim-scenery, 2×fps live-proven
07-02") points the same way and is the obvious first candidate — but this chain's signature error is
picking the target from the last session's intuition instead of from a census. Do not repeat it.

### 3.2 ⭐⭐ ~66 µs per draw is ~10× a draw call — find out what three is doing per object
The scene-wide flip removed **236 draws and 15.7 ms of CPU**. That is **~66 µs per removed draw**, and a
bare draw call costs single-digit µs. So the cost was NOT the draw calls: it was whatever three does
*around* them. Prime suspect, unproven: the branch sets `material.needsUpdate = true` **twice per object
per frame** (three.module.js:18068/18072), and `needsUpdate` bumps `material.version`, which forces
`getProgram` to re-resolve — a path that builds a **program cache-key STRING** per call.

**Why this is possibly bigger than batching:** if a per-frame `needsUpdate` write is that expensive, then
**any** per-frame `needsUpdate` writer in this codebase is paying the same tax, and the two-pass was only
one of them. `rg -n 'needsUpdate\s*=\s*true' scene3d/` and ask of each: does this run per FRAME, or once?
The particle path alone had several. **Isolate the cost first** (a micro-bench: N materials, flip
`needsUpdate` per frame vs not, measure `render()` wall time) — do not refactor on a suspicion. If it is
confirmed, it is a whole-codebase lever, not a local one.

### 3.3 ⭐⭐ `?perPolyCull` ALREADY EXISTS, is default-OFF, and is gated on an eye-test we can now run
We draw **every** surface `DoubleSide` (materials.js :2235, :2268, :2603, :3491, …) while retail culls per
polygon — so we rasterize back faces retail never draws, on **all** opaque geometry, not just translucent.
That is both a parity deviation and a standing tax.

**The fix is already written.** `Polygon` carries `SidesType` typed `CullMode` (`dats.xml:2533`; enum :172
— `Landblock=0, None=1, Clockwise=2, CounterClockwise=3`), the wasm exposes it as `wasmMesh.sidesTypes`
(1 byte/tri), and `adapter.js:731` implements **`?perPolyCull=on`** (T2, 2026-05-28): single-sided polys
(`sides_type != 1`) render `FrontSide` with REVERSED winding, bucketed by `(surfaceIndex, cullMode)` so
each pair gets its own geometry + material side. **Its semantics already match the decomp exactly** —
`adapter.js:758` `dbl = sidesTypes[t] === 1` against retail's `p->sides_type == 1 → CULLMODE_NONE` (§2).
Same reading, arrived at independently.

**⚠⚠ IT IS NOT A FREE FLIP — IT WAS TRIED, IT WAS REVERTED, AND THE USER HAS SEEN IT BREAK. READ THIS
BEFORE TOUCHING IT.**

**USER, 2026-07-15 (first-hand, and the most specific account we have):** *"perpolycull breaks the
rendering of the inside of buildings viewed from the outside etc."* Take this as the primary description
of the failure — it is sharper than the url-flags row's "wrongly-wound building/static polys", and it
points at a MECHANISM rather than at bad data: with everything `DoubleSide` you see a building's interior
surfaces through/from outside, and per-poly culling removes exactly those back faces. **So before writing
this off as "winding is broken", establish which it is:**
- **(a) our winding/triangulation is wrong** for those polys (the url-flags reading), OR
- **(b) the culling is CORRECT and something else was relying on those back faces being drawn.**
  **There is real evidence for (b), and it names the missing partner: `?portalStencil`.** That flag
  (default-OFF, milestone 1, 2026-07-05) is described as *"draws building interiors through their
  door/window apertures from an OUTDOOR camera — the GPU realization of retail's screen-space portal clip
  (`PView::GetClip`) + per-aperture depth-punch (`DrawPortalPolyInternal`)"*. So **retail's mechanism for
  seeing inside a building from outside is the PORTAL CLIP — not two-sided back faces.** Today we are
  DoubleSide everywhere and portalStencil is off, so whatever interior visibility we currently get from
  outside is not the retail mechanism; per-poly culling removes it and the interiors break.
  ⇒ **The two flags are probably COUPLED and should be evaluated TOGETHER, not one at a time.** That would
  explain why it reads as "geometry went missing" while each individual poly is drawn exactly as retail
  draws it. **Do not conflate "the picture got worse" with "the cull is wrong."** (Coupling is inferred
  from the two rows + the decomp, NOT measured — test it, do not inherit it.)

History: a 2026-05-28 1070 **headless** eye-test flipped it default-ON; **reverted 2026-07-06** after the
**R9 290** showed dropped/inside-out building+static polys — the 2026-07-02 "half-missing forge" class.
Off = everything `DoubleSide` (historically safe).

**Note the asymmetry, because it is the lesson:** a headless eye-test PASSED it; a HUMAN looking at a
screen caught it. It failed not because of the GPU but because nobody diffed the arms pixel-for-pixel.
**That is now cheap:** `singlepass-eyetest.mjs` renders both arms in ONE synchronous instant (scene state
identical BY CONSTRUCTION, 0-px control at both ends) + an ×8 diff heatmap + cluster coordinates, so
`EXTRA_Q="perPolyCull=on"` vs off would localize **exactly which polys vanish, at which POI, as pixels** —
and, per the user's account, **frame a building from outside**, which is where it is known to show.
Settle the (a)/(b) question first; the fps is worthless if the cull is right for the wrong picture.
⚠ Do NOT reason about the enum from its name: `dats.xml` reads `NegUVIndices` only
`if SidesType == CullMode.Clockwise`, so a `Clockwise` poly is a genuinely two-textured polygon while
`None`(1) means "cull nothing". Confirm against retail + ACE's DatLoader before trusting any mapping.
Expect the win where geometry is dense, and note it composes with §3.1 (it SPLITS buckets by cull mode, so
it can ADD draw calls even as it removes fragments — measure `draws` AND `renderCPU`, not just fps).

### 3.4 Nineteen `render()` calls per frame, one of which re-renders the world (inherited, unexplained)
`renders/rAF = 19`, stable across every arm (`info.render.frame` increments once per top-level `render()`;
NOT reset by `info.reset()`). Attribution (`particle-pass-attrib.mjs`): main scene @960x535 (1 call/f,
~2,318 draws), `sky_scene` (1 call/f, 4 draws), an ORTHO downsample chain @480x268→…→4x3 (~2 calls/f each,
1–2 draws — ~16 of the 19 calls), and **main scene @1112x619: 0.01 calls/f but ~2,800 draws when it fires**
— a FULL world re-render at a different resolution, ~1 frame in 100, from `atmosphere_pipeline.js:702` →
`EffectComposer.render` → `RenderPass.render`. On a frame that is now known CPU-bound, an occasional extra
whole-frame submission is a plausible hitch source. Nobody has explained what resizes to 1112x619.

## 4. OTHER WORK (inherited, still owed)

1. **Decide `?particleInstancing` at HOLTBURG, pinned.** Its prize is now **1 draw per particle** (the
   double is gone, and it was free — no additive-only restriction, no per-instance colour trick). Drawable
   particle meshes measured Cragstone 24 / Holtburg 225 / Shoushi 12, so the flag is NOT worth ~nothing —
   but that attribution to Holtburg-the-place is still unpinned (§5.4). Single-page-load A/B/A via
   `particle-instancing-ab.mjs`. **Note it composes with §3.1: instancing IS draw-call batching**, so run
   the census first and decide this as part of that plan, not separately.
2. **`?staticScripts=off` is broken.** `anchors=0` but 586 emitters survive → 5,925 draws/f, 5.86 fps
   (~8× WORSE than default). Unverified mechanism: `_rp6ShouldCull` BAILS OPEN (`if (!parent) return false`)
   for an emitter with no usable anchor. Two things fall out: the flag is useless as a "floor" (so the
   url-flags "captures 95% of the available win" claim still has no basis), and **"an emitter with no
   parent is never culled" may be a live cost in the DEFAULT config** — worth a census of parentless
   emitters.
3. **Brazier-flame hero shot + the 62-town walk** (inherited, owed before any further default flip).
   Particle parity is still proven by counts + identical frames, **not by seeing fire**. Select by
   `defaultScriptId` for a known brazier PES and raycast for line-of-sight. NOTE `singlepass-eyetest.mjs`
   now gives you a POI-tour + PNG harness that would make this cheap.
4. **Static script ANCHORS leak** (138 → 631 over a tour) while emitters are reaped. LOW impact (Groups
   issue no draws). **Do not conflate with particle draw cost.**
5. **`surfaceUnified` is default-OFF, so the "WRONG reading" is what ships.** Discovered while chasing §1's
   missed ladder: entities.js's legacy paletted ladder is the LIVE path, and its own comment says it omits
   the luminous `emissiveMap`, which "washes a COLOURED dyed-luminous surface to white … kept here only
   for byte-identical flag-off rollback" (the correct reading lives in `applySurfaceRenderState`, taken
   only when `?surfaceUnified=on`). So a known-wrong parity reading is the default today, and the fix
   exists behind a default-OFF flag. Not investigated; not mine; flagging it because the url-flags row
   reads as though the unified path were the shipped one.

## 5. RESIDUALS / UNKNOWNS (honest loose ends)

1. **1 mesh is STILL double-submitted at Holtburg** — `MeshStandardMaterial x1`, unnamed, so un-traced.
   Negligible (−4.8 draws) but it is a real hole in the coverage assertion. If you touch this, name it:
   the census prints `stillTwoPass` material names, and an unnamed material means somebody built a
   `MeshStandardMaterial` without a `.name` (first candidate: the `fallbackMaterial` at
   materials.js:2023 — the 0xFF "no surface" / failed-DID bucket, `color: 0x888888`). Coverage is
   **1, was 451**.
2. **Another transparent ladder exists at entities.js:14433 / :14514 / :14583 and I did NOT patch it.**
   The coverage assertion says only 1 mesh remains AT HOLTBURG, so either that ladder is not live there or
   its materials are not DoubleSide — **unverified at other POIs**. Re-run the coverage line at a dungeon /
   Shoushi / Yaraq before assuming the fix is complete everywhere.
3. **Yaraq did not settle in 240 s — and this is now the SECOND session it has misbehaved** (the 5-town
   battery's Yaraq arm-A followed a session abort and its result is unattributed; Sawato hung on arm A
   entirely). Cragstone also failed to settle once here (240 s) and correctly aborted. Not investigated.
   A POI that cannot settle is a hole in every "toured N POIs" claim, including §2's eye test.
4. **"Holtburg 225 drawable particles" is still NOT an established property of Holtburg** (inherited). All
   runs here were also **unpinned**; the emitter plateau ranged **255 → 811 across my six runs** at the
   same POI, which is worse spread than settle.mjs's documented ~25%. `pinPose` for Cragstone is known
   (`0xbb9f0040 169.36 168.25 54.01`); **there is still no pinned pose for Holtburg** — derive one before
   any cross-load Holtburg claim.
5. **fps DRIFTS UPWARD within a page load; draws do not.** A2-vs-A drift measured **0.00, +1.65, +2.33,
   +3.32 fps** across four runs (up to **+12%**), while draws drifted 2.7–7.2 (**≤0.3%**) in the same runs.
   ⇒ **Use `draws` and `renderCPU` for anything under ~15%; fps is only safe when the effect dwarfs the
   drift** (the scene-wide flip's +45% did). A single-arm fps delta of "+13.6%" in the post-fix verify run
   was pure drift — the draws (−4.8) told the truth.
6. **`_RP6_MAX_DIST_SQ` (particle_manager.js:131) is still dead** — computed, never read; the typescript
   diagnostic fires on every edit to that file. Pre-existing. Not the knob it looks like.
7. **Pre-existing test failures, verified NOT mine by running them against clean source:**
   `test_a11_s0_blocking_particle.mjs` **45/3** (all 3 are `blockingParticleParity` source-greps against
   entities.js/statics.js/play_effect_vfx.js) and `test_a15_q1_entity_buffer_caps.mjs` **17/2** (both
   `deferredSpawns` assertions — **identical 17/2 on pre-fix source**). `test_materials_paletted_lru.mjs`
   and `test_phase7_{4b,batch9}_entity_*.mjs` need env setup (`THREE_PATH=…`) and did not run at all.
8. **The 9 unowned drawable particle meshes** (inherited, seen ONCE, never reproduced; `ORPHAN=0` at every
   stop of a 4-POI tour). Unchanged.
9. **MEMORY.md is 24,835 bytes, over its own 24,400-byte load budget** (its header asks that this be
   reported rather than silently edited). Still over.

## 6. MEASUREMENT RULES (new this session; the prior three handoffs' rules all still stand)

1. **FIELD-VERIFY A FIX; NEVER TRUST THE SITE LIST.** THE rule of this session. The surface fix "landed",
   the unit tests were 10/10 green, and **403 of 451 meshes were still broken** because the live path was a
   legacy ladder behind a default-OFF flag I never looked at. Grepping creation sites tells you what you
   PATCHED; it cannot tell you what RUNS. Ask the LIVE SCENE the renderer's own question — "which
   materials still satisfy three's condition?" — and make the probe **NAME them**. That coverage assertion
   is 15 lines (`forcesinglepass-ab.mjs`, `stillTwoPass`) and it is the only reason this shipped working.
2. **Build a PLACEBO arm into every A/B.** After the particle fix, the probe's "particles" arm flipped **0**
   materials and moved **−0.06 fps** — an unplanned placebo proving the harness has no systematic bias, for
   free. An arm that SHOULD do nothing is worth as much as the arm that should do something.
3. **`renderer.render()` wall time is the CPU-vs-GPU discriminator, and it is ~10 lines.** render() returns
   at SUBMIT, before the GPU executes ⇒ its duration is CPU cost. Wrap it, accumulate, divide by rAF count.
   This is what turned "the win is fill rate" (wrong, and would have sent the next session after shaders)
   into "~95% of the win is CPU submission" (right, and names the next lever). **Measure the mechanism; do
   not narrate one from the deltas.**
4. **A default-ON flag needs its OFF arm TESTED.** `?surfaceSinglePass=off` really restoring the two-pass is
   a guard, because an escape hatch that silently does nothing is worse than no hatch — it invites "just
   turn it off" as a rollback that doesn't roll back.
5. **Import the constant; never retype the bit.** `test_surface_single_pass.mjs` first hardcoded
   `TRANSLUCENT = 0x4` — that is `Base1ClipMap`, which decodes to `transparent = FALSE` — so its
   "translucent" material was never transparent and the double-submit guard passed **VACUOUSLY** (a
   non-transparent material trivially submits once). The precondition caught it. `SURFACE_TYPE.Translucent`
   is `0x10` and is exported; import it.
6. **`rg -rn` IS `--replace n`.** I hit this despite MEMORY.md warning about it explicitly: `rg -rn 'paletted-' …`
   silently rewrote every match to `n` and I nearly concluded the paletted material didn't exist. **Never
   pass `-r` unless you mean --replace.** Plain `rg -n` is unredacted.
7. **On Windows, a process-match query MATCHES ITSELF.** `Get-CimInstance Win32_Process | Where CommandLine
   -like '*cdpwb-claude*'` returns your own `cmd.exe` + `powershell.exe`, so the count can never reach 0 and
   reads as "cleanup failed". Verify with the actual target (`Get-Process chrome`). Same family as the
   `pgrep -f` self-kill footgun already in memory.
8. **`tailnet1` is single-login and the gap is REAL: wait 45–60 s between runs.** Three runs died
   `__bootState==='error'` here on back-to-back launches even though every probe closes its page on bail.

## 7. HARNESS (all on master, `net-review/`)

- **`draw-budget-probe.mjs`** — ⭐ **UNRUN.** Per-subtree draw attribution by hiding one group at a time in
  ONE page load + a plain-Mesh/BatchedMesh/InstancedMesh census. The next session should start here.
- **`forcesinglepass-ab.mjs`** — the perf A/B/C/A (baseline / particles / scene-wide / restored) with
  **`renderCPU` (CPU-vs-GPU)** and the **COVERAGE ASSERTION** (`stillTwoPass`, names what is still
  double-submitted). `EXTRA_Q="surfaceSinglePass=off"` gives the pre-fix baseline.
- **`forcesinglepass-parity.mjs`** — the 0-px-control pixel-parity instrument (two renders in ONE
  synchronous instant). **`singlepass-eyetest.mjs`** — the same idea, but writes PNGs + an ×8 diff heatmap
  + cluster locations, and tours POIs (`POIS=Holtburg,Cragstone,Shoushi`). Use it for §4 #3's hero shot.
- **`particle-k-probe.mjs`** — "what does a particle cost" (k), A/B/A in one page load. **`particle-pass-attrib.mjs`**
  — wraps `render()`, buckets draws PER PASS keyed by (scene, camera, target), stamped with the JS
  call-site stack. The tool that replaces the blind `onBeforeRender` hook.
- Inherited: **`settle.mjs`** (read its header — four confounds with numbers), **`town-fps-probe.mjs`**,
  **`orphan-{particle,growth}-probe.mjs`**, **`particle-instancing-ab.mjs`**, **`culled-draw-probe.mjs`**
  (its printed VERDICT line lies — read the ratio).
- **Tests** (`$HOLT/`): `test_surface_single_pass.mjs` (10), `test_particle_single_pass.mjs` (11),
  `test_particle_rp6_cull_authority.mjs` (16) — all verified to FAIL on their respective pre-fix sources.
- **Artifacts:** `/mnt/wbterminal2/tmp/{particle-k-holtburg,particle-k-holtburg-FIXED,particle-pass-attrib,
  fsp-ab,fsp-ab-incremental,fsp-cpu,fsp-verify,fsp-verify2,fsp-parity}.json` + `*.log`;
  `/mnt/wbterminal2/tmp/eyetest-tour/` (the 3-POI A/B/diff PNGs).

## 8. OPS / GIT

- **1070:** `schtasks /run /tn cdpwbclaude` (headless, muted, off-screen, `--user-data-dir=C:\Temp\cdpwb-claude`);
  tunnel `ssh -fN -L 9333:127.0.0.1:9333 -R 8765:127.0.0.1:8765 young@100.127.215.75`. Every probe here
  **refuses to publish a number** unless `UNMASKED_RENDERER` is the GTX 1070. Kill test chrome by
  `cdpwb-claude` cmdline match ONLY — **a person uses that box** — and verify with `Get-Process chrome`
  (§6 rule 7).
- No wasm rebuild is needed for any of this: JS is served LIVE by serve.py (`scripts/serve.py` → :8765).
  `dist` is a symlink to `/mnt/wbterminal2/holtburger-dist`.
- **Do NOT use `git stash` for A/B in this repo** (3 pre-existing stash entries; a mis-pathed push + pop
  rolls SOMEONE ELSE's stash into your tree). A/B with plain file copies: `git show <sha>:<path> > <path>`
  — which is exactly how both regression tests were run against their bugs.
- This session: `8806e130` particle double-submit fix + test + probes · `f67b0160` its handoff ·
  `446e5b4c` the surface parity fix + `?surfaceSinglePass` + test + coverage assertion · `933fa807` the
  interim handoff update. Direct push to `origin/master` works.

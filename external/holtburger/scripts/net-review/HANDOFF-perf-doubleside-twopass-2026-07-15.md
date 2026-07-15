# HANDOFF — the ⭐ lead is CLOSED: every particle WAS drawn twice. It was three's DoubleSide two-pass.

**Date:** 2026-07-15 · **Box:** wbterminal laptop → 1070 (tailscale, CDP :9333, real GPU) · **Self-contained.**
Supersedes `HANDOFF-perf-particles-second-pass-2026-07-15.md` (its ⭐ lead is DONE; k=2 was REAL, and it was
not a second pass — §1). REPO=`/home/wbterminal/WorldBuilder-ACME-Edition`,
HOLT=`$REPO/external/holtburger/apps/holtburger-web`, net-review=`$REPO/external/holtburger/scripts/net-review`.
Tree clean; everything below is on `origin/master` (`8806e130`).

---
## 0. TL;DR — where we are

- **k=2 was REAL and it is FIXED.** Every visible particle cost **2.01** draw calls; it now costs **1.00**.
  Measured by the same instrument on both sides, A/B/A **within one page load** (drift 0.1%). §2.
- **It was never a second pass.** The world renders ONCE per frame (composer passes `[]`, shadowMap off).
  The doubling is INSIDE that single `render()` call: three r184 submits a material twice — BackSide then
  FrontSide — when `transparent && side === DoubleSide && !forceSinglePass` (three.module.js:18065).
  `forceSinglePass` appeared **nowhere** in this repo. Three sessions hunted a second pass; there isn't one.
- **Fix:** `mat.forceSinglePass = true` on the particle material clone + the instanced bucket. Always-on, no
  flag. **Pixel-identical — verified, not argued** (0 px, with a 0-px control at both ends). §3.
  Worth **−8.8% draws / +21% fps** at Holtburg.
- **⭐ THE OPEN LEAD: the SAME bug is live on 451 NON-particle meshes — worth −18.9% draws / +32% fps,
  but it CHANGES PIXELS (3,688 px, 0.72%). Not safe to flip blind. §5.1 — it is the biggest measured fps
  lever on the table.**
- **`renders/rAF = 19`.** Nineteen top-level `renderer.render()` calls per frame. Mostly a tiny ortho
  downsample chain, but nobody has ever accounted for them, and one of them is a **full ~2,800-draw world
  re-render at a different resolution** that fires ~1 frame in 100 (§5.2).
- The prior row's "second world render was ruled OUT / maxDrawsPerObj/frame=1" was measured with an
  instrument that **structurally cannot see this** (§1). Right conclusion, no evidence.

## 1. WHAT WAS REFUTED / CORRECTED (do not re-inherit any of it)

| Claim (and where it came from) | Verdict |
|---|---|
| "k≈2 means a second pass is submitting every particle again" (prior handoff §3) | **HALF RIGHT — and the wrong half is the expensive one.** k IS 2.01 (confirmed directly, §2). But there is NO second pass: `renderer.info.render.frame` shows the MAIN scene rendered once per rAF, `ls.composer.passes` is `[]`, `shadowMap.enabled` is false, and per-pass attribution puts **all** of the loss inside ONE `render()` call (428.3 draws lost for 228.1 particles = 1.88/particle in that single pass). The doubling is three's `renderObject` two-pass, not a pass of ours. |
| "a second world render was ruled OUT — per-object tally: multi-draw objects=0, **maxDrawsPerObj/frame=1** in both arms" (url-flags `particleInstancing` row) | **THE CONCLUSION IS RIGHT; THE EVIDENCE IS VOID — and `maxDrawsPerObj/frame=1` is simply FALSE.** three calls `object.onBeforeRender` ONCE (three.module.js:18058) and THEN issues the TWO `renderBufferDirect` calls (:18065). A per-object hook therefore reports 1 while `info.render.calls` counts 2 — the instrument is blind to the exact thing it was used to rule out. This is the SECOND time this hook has misled (the prior handoff §5.4 already flagged it mis-firing). **Attribute draws by DIFFERENCE, never by a hook.** |
| "`?particleInstancing`'s prize is double what the mesh count suggests, if k≈2" (prior handoff §4 #1) | **NO LONGER — the double is gone, and it was free.** Instancing's prize is now 1 draw per particle. It was never necessary to capture the doubling: `forceSinglePass` gets it with no additive-only restriction, no per-instance colour trick, no runtime-gate risk. |
| "the ~169-draw residual under k=1 is unexplained" (prior handoff §3 table) | **DISSOLVED.** It was the arithmetic of fitting k=1 to a k=2 world. The direct particles-hidden floor is measured, not inferred: **1,904.2** draws at Holtburg. |
| "expect `?particleInstancing` to be worth ~nothing ⇒ retire it" (two handoffs ago) | **STILL DOES NOT HOLD** (unchanged from the prior handoff — 225 drawable at Holtburg vs 24 at Cragstone). Undecided; §4 #2. |

## 2. WHAT THE NUMBERS ARE (1070, real GPU, settled Holtburg, `particleInstancing=off`, weather off)

**k, measured directly — A/B/A inside ONE page load** (`particle-k-probe.mjs`). Hide every particle mesh,
diff draws, divide by the particle delta. No reload → none of settle.mjs's four confounds apply.

| source | A draws/f | B (particles hidden) | A2 | **k(A vs B)** | k(A2 vs B) | A/A2 drift |
|---|---|---|---|---|---|---|
| pre-fix  | 2362.5 | 1904.2 | 2359.8 | **2.01** | 1.99 | 2.7 draws (0.1%) |
| post-fix | 2154.8 | 1917.1 | 2157.5 | **1.00** | 1.00 | 2.7 draws (0.1%) |

**The fix's value — arms in ONE page load** (`forcesinglepass-ab.mjs`, A2 drift **−0.03 fps / +2.7 draws**):

| arm | draws/f | fps | p50 | vs baseline |
|---|---|---|---|---|
| A baseline | 2365.3 | 16.47 | 58.4 ms | — |
| **B particles forceSinglePass** | 2156.5 | **19.92** | 50.0 ms | **−8.8% draws, +21% fps** |
| C scene-wide forceSinglePass | 1918.4 | **21.76** | 33.4 ms | −18.9% draws, **+32% fps** (⚠ changes pixels — §5.1) |
| A2 restored | 2368.0 | 16.44 | 58.4 ms | drift ≈ 0 |

**Do NOT quote the pre-fix vs post-fix fps across page loads** (16.47 → 21.93 looks like +33%): different
page loads settle to different emitter plateaus (614 vs 811 here) and settle.mjs §4 says that is worth ~25%.
The defensible number is the **within-page-load +21%**.

## 3. WHY THE FIX IS SAFE (the part that is verified rather than argued)

`forceSinglePass = true` keeps `side = DoubleSide` and `transparent = true`; it only stops three from
submitting the mesh a second time. Three independent legs:

1. **Pixel diff = EXACTLY 0** (`forcesinglepass-parity.mjs`). Renders the scene twice inside ONE
   synchronous moment — no rAF, no tick, no clock advance — so scene state is identical BY CONSTRUCTION and
   every differing pixel is attributable to the render path alone. Control pairs at the START and END both
   differ by 0 px, so the instrument resolves a single pixel. Reproduced across two runs.
2. **Geometry**: a particle is a FLAT quad (census: 222/222 live meshes, 6 verts, coplanar). Back and front
   never overlap, so at any angle one of the two passes is entirely face-culled — it was a draw call that
   drew nothing. The two-pass only *means* something for closed geometry.
3. **Retail**: two-sided means `CULLMODE_NONE` (acclient.h:5296) set once via
   `RenderDeviceD3D::SetCullMode`, and the surface is drawn ONCE. The back-then-front two-pass is a
   three-ism with **no retail counterpart** — so this is a parity FIX, not a parity risk.

⚠ **The safety rests on preconditions, and `test_particle_single_pass.mjs` guards them, not just the flag:**
it asserts the material is STILL transparent+DoubleSide (a FrontSide "fix" would pass a naive flag check
while dropping real fragments), that three's OWN predicate now yields 1 submit, and that the geometry is a
flat quad. If particles ever gain real 3D geometry, guard 5 fails and the pixel-identity claim must be
**re-derived, not re-assumed**.

## 4. REMAINING TASKS

1. **⭐ §5.1 — the scene-wide two-pass.** Biggest measured fps lever available (+32%). Needs judgment, not a
   flag flip.
2. **Decide `?particleInstancing` at HOLTBURG, pinned** (inherited, unchanged). Its prize is now 1 draw per
   particle — re-measure on top of the correct cull AND the single-pass fix before deciding.
3. **`?staticScripts=off` is broken** (inherited). `anchors=0` but 586 emitters survive → 5,925 draws/f,
   5.86 fps. Unverified mechanism: `_rp6ShouldCull` BAILS OPEN (`if (!parent) return false`) for an emitter
   with no usable anchor. Worth a census of parentless emitters — it may be a live cost in the DEFAULT config.
4. **Inherited #4** — framed brazier-flame hero shot + the 62-town walk, owed before any default flip.
   Parity is still proven by counts + identical frames, **not by seeing fire**.
5. **Inherited #6** — static script ANCHORS leak (138 → 631 over a tour) while emitters are reaped. LOW
   impact (Groups issue no draws). Do not conflate with particle draw cost.

## 5. THE NEW LEADS

### 5.1 ⭐ 451 non-particle meshes are ALSO double-submitted — +32% fps, but it is NOT free
`?particleInstancing=off`, settled Holtburg: **451 of 2,266** non-particle drawn meshes are
transparent+DoubleSide. Flipping them scene-wide is worth **−18.9% draws / +32% fps (p50 58.4 → 33.4 ms)** —
but it **changes 3,688 px (0.72%, max channel delta 106)**. That number is trustworthy (same 0-px-control
instrument), and it is attributed: `sceneWide` and `nonParticlesOnly` produce the **identical** diff, so
particles contribute exactly 0 and all of it is world/entity surfaces. Those are **closed** geometry where
back-then-front ordering is doing real work — this is the case the two-pass exists for.

Do NOT flip it blind. Sensible attack:
- These are AC `Surface` **Translucent**-flag materials (materials.js `_materialFromFlags`). Retail draws
  them ONCE with a single `CullModeType` — so ask what retail's cull mode actually IS per surface
  (`D3DPolyRender::SetSurface`, acclient.c:454385) instead of porting three's habit. **If retail draws them
  single-pass, the 3,688 changed pixels may be a parity FIX, not a regression** — the pixels three produces
  today are not automatically the correct ones.
- Split the 451 by geometry: any that are flat/planar are provably safe (the particle argument verbatim).
- The remainder need the eye test (§ the 1070 batched-eyetest discipline) on a framed shot, not a count.

### 5.2 Nineteen `renderer.render()` calls per frame, and one of them re-renders the world
`renders/rAF = 19`, stable across every arm (`info.render.frame` increments once per top-level `render()`,
three.module.js:17632 — and it is NOT reset by `info.reset()`). Per-pass attribution (`particle-pass-attrib.mjs`):
- main scene @960x535 — 1.0 call/f, ~2,318 draws/f · `sky_scene` — 1.0 call/f, 4 draws/f
- an ORTHO downsample chain @480x268→240→120→60→30→15→8x5→4x3 — ~2 calls/f EACH, 1–2 draws each (~16 of
  the 19 calls; cheap, but that is where the count goes)
- **⚠ main scene @1112x619 — 0.01 calls/f but 28.1 draws/f amortized ⇒ ~2,800 draws when it fires.** A FULL
  world re-render at a DIFFERENT resolution, ~1 frame in 100, from the same call site
  (`atmosphere_pipeline.js:702` → `EffectComposer.render` → `RenderPass.render`). Nobody has accounted for
  this. It is a plausible hitch source and it costs a whole extra frame's draws when it fires. Find out what
  resizes to 1112x619 and why it re-renders the world.

## 6. HARD-WON MEASUREMENT RULES (new; the prior two handoffs' rules all still stand)

1. **Attribute draws by DIFFERENCE, never by a per-object hook.** `object.onBeforeRender` fires ONCE per
   object per pass (three.module.js:18058) and three then issues TWO `renderBufferDirect` calls (:18065) —
   any hook-based tally is structurally blind to the doubling. This hook has now produced two wrong rulings.
   Turn the thing OFF and diff `info.render.calls`; that is what the object actually cost.
2. **The gold-standard visual A/B: render twice in ONE synchronous moment.** `render → readRenderTargetPixels
   → flip → render → read`. No rAF, no tick ⇒ scene state identical by construction ⇒ every differing pixel
   is the render path. A screenshot A/B cannot do this: the first cut of `forcesinglepass-ab.mjs` froze the
   particle sim and STILL diffed 16.3% of pixels, because the rest of the world animates. **Always pair it
   with a control pair (render twice, change nothing) — it must be 0 px, or the instrument is void.**
3. **Discard the FIRST render into a fresh target.** grab#1 vs grab#2 differ on 6.0% of pixels (max 22) with
   nothing changed; every later pair is exactly 0 — atmosphere/temporal state converges on the first render.
   A first cut declared itself VOID on exactly that artifact.
4. **`forceSinglePass` is invisible to every source-grep you would think to run.** It is a three.js *default*
   (`false`), so the bug is the ABSENCE of a line. `rg forceSinglePass` returning 0 hits reads as "not
   relevant here" and actually means "every transparent DoubleSide material in this repo is drawn twice".
   When a renderer behaviour is suspected, read three's condition and evaluate it against the live
   materials — do not grep our source for a flag we never wrote.
5. **Flip material properties with `needsUpdate = true`,** or the program is not re-resolved and the arm
   silently measures the old path.
6. **Import three by its EXACT importmap specifier** (`https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.module.js`,
   index.html:951) inside `page.evaluate`. It is already in the module registry so you get the SAME instance;
   any other specifier gives a second copy whose classes fail every `instanceof` inside the renderer. `THREE`
   is NOT exposed as a global.
7. **A unit test can reproduce a RENDERER bug without a renderer** — encode three's predicate verbatim
   (`transparent && side===DoubleSide && !forceSinglePass ? 2 : 1`) and assert over the real manager's real
   materials. It reported `submits/frame: 2,2` on pre-fix source. No GPU, no page, no flake.
8. **`particleInstancingEnabled()` reads BARE `location.search`** (particle_manager.js:164) — that is
   `globalThis.location`, NOT `window.location`, and node defines neither. Unset, it throws, is swallowed,
   and memoizes `_INST_ON = false` **at module scope for the whole process**. Set `globalThis.location`
   BEFORE the first import or any instancing test silently tests nothing. (Guard 6 caught this only because
   it fails loudly when no bucket is built instead of skipping.)

## 7. RESIDUALS / UNKNOWNS (honest loose ends)

1. **All of the prior handoff's §5 residuals stand unchanged and un-investigated**: the 9 unowned drawable
   particle meshes (seen once, never reproduced, `ORPHAN=0` at every stop of a 4-POI tour); "Holtburg 225" is
   still NOT an established property of Holtburg (these runs were also **unpinned** — same caveat, and the
   emitter plateau ranged 338→811 across my four runs); Yaraq's battery result is unattributed; Sawato hung
   on arm A and is unpaired.
2. **`_RP6_MAX_DIST_SQ` (particle_manager.js:131) is still dead** — computed, never read. Pre-existing; the
   typescript diagnostic fires on every edit to that file. Not the knob it looks like.
3. **`test_a11_s0_blocking_particle.mjs` still fails 45/3** on a clean tree. **Re-confirmed unrelated here by
   inspection, not by inheritance:** all 3 are `blockingParticleParity` source-grep assertions against
   `entities.js` / `statics.js` / `play_effect_vfx.js` — three files this change does not touch.
4. **The 1.88-vs-2.01 gap.** Per-pass attribution says the main pass loses 1.88 draws per particle while the
   whole-frame k is 2.01; the remainder is the rare 1112x619 world re-render (§5.2) contributing its own
   amortized 0.12. That reconciles, but it was not independently confirmed — if you need k per-pass to the
   second decimal, measure it, do not take 1.88+0.12 on faith.
5. **`noSurfaceParticleMaterial()`** (the shared invisible material) is transparent but default FrontSide, so
   it never double-submitted and was deliberately left alone. If anyone makes it DoubleSide, it joins the bug.

## 8. HARNESS (all on master, `net-review/`)

- **`particle-k-probe.mjs`** — **THE instrument for "what does a particle cost".** A/B/A in one page load:
  settles, hides every particle mesh, diffs draws, reports k + the topology that would EXPLAIN k>1
  (composer passes, shadowMap/CSM, castShadow census). `POI=Holtburg ARM_S=20 OUT=/mnt/wbterminal2/tmp/k.json
  node particle-k-probe.mjs`. It hides by redefining `visible` as an accessor that swallows writes — that
  defeats EVERY writer (including `setTranslucency`, which undoes a plain `visible=false` on the next tick)
  while leaving tick()'s CPU work identical, so the delta is purely GPU submission.
- **`particle-pass-attrib.mjs`** — wraps `renderer.render()` and buckets draws PER PASS by diffing
  `info.render.calls`, keyed by (scene, camera, render target) and stamped once with the JS call-site stack.
  Answers "which pass drew this" with a source location. This is the tool that replaces the blind hook.
- **`forcesinglepass-ab.mjs`** — the perf A/B/C/A (baseline / particles / scene-wide / restored) + the
  material census. **`forcesinglepass-parity.mjs`** — the 0-px-control pixel-parity instrument (§6 rule 2).
- **`test_particle_single_pass.mjs`** (in `$HOLT/`, 11 checks) — verified to FAIL on pre-fix source (6 fail,
  guard 4 reporting `submits/frame: 2,2`). `node test_particle_single_pass.mjs` from `$HOLT/`.
- Inherited and still true: **`settle.mjs`** (read its header), **`town-fps-probe.mjs`**,
  **`orphan-particle-probe.mjs`** / **`orphan-growth-probe.mjs`**, **`particle-instancing-ab.mjs`**,
  **`culled-draw-probe.mjs`** (its printed VERDICT line lies — read the ratio).
- **Artifacts:** `/mnt/wbterminal2/tmp/{particle-k-holtburg,particle-k-holtburg-FIXED,particle-pass-attrib,fsp-ab,fsp-parity}.json`
  + `*.log`, `fsp-frozen-{A-doubleside,B-singlepass}.png` (the 16.3%-diff screenshots that motivated §6 rule 2).

## 9. OPS / GIT

- **1070:** `schtasks /run /tn cdpwbclaude` (headless, muted, off-screen, `--user-data-dir=C:\Temp\cdpwb-claude`);
  tunnel `ssh -fN -L 9333:127.0.0.1:9333 -R 8765:127.0.0.1:8765 young@100.127.215.75`. Assert
  `UNMASKED_RENDERER == "ANGLE (NVIDIA ... GTX 1070 ... Direct3D11)"` — every probe here refuses to publish a
  number otherwise. Kill test chrome by `cdpwb-claude` cmdline match ONLY — **a person uses that box**.
- **`tailnet1` is single-login: wait ~45–60 s between runs.** Two runs here died `__bootState==='error'` on
  back-to-back launches. Every probe's bails close the page (prior §2 rule 7) and it is still not enough —
  the gap is real. A probe that dies before `page.close()` starves the NEXT run instead of itself.
- No wasm rebuild is needed for any of this: JS is served LIVE by serve.py. `dist` is a symlink to
  `/mnt/wbterminal2/holtburger-dist`.
- **Do NOT use `git stash` for A/B in this repo** (3 pre-existing stash entries; a mis-pathed push +
  pop rolls SOMEONE ELSE'S stash into your tree). A/B with plain file copies: `git show <sha>:<path> > <path>`
  — which is exactly how `test_particle_single_pass.mjs` was run against the bug.
- This session: `8806e130` the fix + regression test + probes + the url-flags correction.

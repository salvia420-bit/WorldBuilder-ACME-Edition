# HANDOFF — holtburger-web perf: the particle draw cost is a BROKEN CULL, not a batching problem

**Date:** 2026-07-15 · **Box:** wbterminal laptop → 1070 (tailscale, CDP :9333) · **Self-contained.**
Supersedes `HANDOFF-perf-statics-atlas-starvation-2026-07-14.md` (its ⭐ lead is REFUTED — see §1).
REPO=`/home/wbterminal/WorldBuilder-ACME-Edition`, HOLT=`$REPO/external/holtburger/apps/holtburger-web`,
net-review=`$REPO/external/holtburger/scripts/net-review`. Tree clean; everything below is on `origin/master`.

---
## 0. TL;DR — where we are

- **The previous ⭐ lead ("statics atlas-starvation") does not exist.** The atlas is healthy and fully
  fed. The "~1000 eligible statics bypassing the atlas" were **particle billboards** miscounted by the
  census. With particles excluded, `eligible == 0` and the only un-atlased statics are the 18 wind-sway
  ones the atlas passes through *by design*. Fixed at the source so it cannot regenerate (`de24059d`).
- **The real cost is particles — and it is a CULL BUG, not a batching problem.** Measured at a settled
  Cragstone: **140 of 152 drawn particles (92%) belong to emitters RP6 has ALREADY CULLED.** They keep
  submitting because the visibility flip fires only on TRANSITION while every particle mesh carries
  `frustumCulled=false`.
- **⭐ THE OPEN LEAD: fix the RP6 visibility leak (§3).** It should capture ~the whole particle draw win
  with none of `?particleInstancing`'s baggage, and it fixes ALPHA particles too (instancing skips them).
- **`?particleInstancing` (shipped, default-OFF) is MIS-FRAMED.** Its win is ~92% cull-fix, ~8% batching.
  After §3 lands it may be worth ~nothing — **expect to retire it, not ship it**. Its real value was as the
  instrument that exposed the leak. **Do not flip its default.**
- **Measurement here was the actual bottleneck.** Three separate wrong conclusions were published before
  the tooling was good enough to see straight. §2 is the important part of this document.

## 1. WHAT WAS REFUTED / CORRECTED (do not re-inherit any of it)

| Claim (and where it came from) | Verdict |
|---|---|
| "Statics atlas is STARVED; ~1000 eligible statics bypass it; expected prize ~1000 draws" (prior handoff §2) | **FALSE.** With `?staticScripts=off` the eligible count is **exactly 0**; atlas counters are byte-identical with particles on/off. Every "eligible static" was a particle billboard. (`9baa72b2`) |
| "The statics bake runs in the bake worker, which has its own module instance" (prior handoff §2) | **FALSE.** `bake_worker.js` imports only wasm decode fns + `bake_transfer` serializers — **no THREE, no staticsGroup, no atlas**. The bake is 100% main-thread. The prior session's zero counters had a mundane cause: one probe sat on the `else` of a **default-ON** flag (dead code), the other on the per-LB path, which is silent at a teleport-in town where the **ring** bakes. |
| "only 49 of ~121 resident LBs feed the atlas → starvation" | **FALSE.** `_atlasBakedLbs` only records LBs that landed ≥1 successful atlas node; LBs with no atlasable singleton never join. Expected shape. |
| "121 resident landblocks" (read as residency all session, incl. prior handoff) | **FALSE.** `terrainBakedLbs` is **CUMULATIVE** — measured 121 → 242 → 363 across a POI tour; it never shrinks. It is "LBs EVER baked". Do not use it as a residency predicate. |
| "draws swing 279↔1850 at the SAME POI ⇒ atlas-consumption state" (prior handoff §1) | **FALSE cause.** It is the live particle count, which tracks the emitter attach ramp + player pose. |
| "Facing does NOT change draws" (L2 handoff rule) | **HALF FALSE.** True for statics (distance cull). **False for particles** — RP6 is a FRUSTUM test, so yaw changes particle draws. Spin-averaging cancels yaw; it does **not** cancel position. |
| "?particleInstancing saves −593 draws (−91.8%, −2400)" (my own, `b60e2085`) | **NOT DEFENSIBLE as batching.** −593 was one sample of a 2.5×-variable quantity (`f81b1ef2`); the later −2400 is ~92% a cull fix (`52cf1f03`). Quote neither. |
| "RP6's visibility flip leaks" | **TRUE** — but it was asserted with no measurement (`b60e2085`), wrongly retracted (`41ba7a72`), then un-retracted on a proper test (`52cf1f03`). See §2 rule 1. |

## 2. HARD-WON MEASUREMENT RULES (this is the valuable part — do not relearn these)

1. **A confident number against the WRONG QUESTION is worse than no number — it closes the
   investigation.** The RP6-leak retraction rested on a probe that counted meshes *visible-but-DEAD*
   (`LEAKED=0`, true but irrelevant) and never tested meshes *live-but-owned-by-a-CULLED-emitter* —
   exactly the population that leaks. It read as rigorous and was wrong. Always state the predicate your
   probe actually tests, then ask whether it is the one in dispute.
2. **NEVER A/B across page loads.** Two runs, same pinned pose, same flags, both properly settled, still
   differ **~25%** (draws 1590.3 vs 1996). The emitter plateau is stochastic (2451/2502/2505/2579/2582
   from a CONSTANT 138 anchors) and emission is RNG-driven (`time_rng.js`). Use
   `particle-instancing-ab.mjs`'s **single-page-load A/B/A**: the two OFF legs agree to **0.0%**.
3. **Always run A/B/A, never A/B.** The return-to-A leg is what proves the scene did not drift under you.
   Without it a single A/B just relocates the confound. Void the comparison if the OFF legs disagree.
4. **Settle is not "terrain stable".** Static emitters attach on a TIME-SLICED ramp
   (t+9s 133 → t+17s 2354 → t+34s 2579, then FLAT for 70s+ with zero drift). The tail moves only
   +47/+29 per ~5s, so any *tolerance* predicate fires mid-ramp. `settle.mjs` demands **EXACT** equality
   held 20s behind a 60s floor — and even 40s/10s was not enough (it split 2451 vs 2579).
5. **Report the settled state next to EVERY number** (emitters, liveParticles, anchors, entRoots,
   terrEverBaked, POSE). A non-comparable run must be visible, not silent.
6. **Player POSE dominates particle draws.** Across settled runs: emitters varied 5%, liveParticles 6%,
   but VISIBLE particles **73%** (696/900/1208) and draws **186%** (537/933/1538). Pin it (`pinPose` →
   `@teleloc`); `@telepoi` does not land identically.
7. **Force `?rain=off&snow=off&lightning=off` for any visual A/B.** `weather/{rain,snow}.js` are their own
   camera-following InstancedMesh systems no gameplay flag touches, but they start/stop between runs and
   read as "the other arm has extra white particles". Cost two false alarms.
8. **Read diagnostics AFTER the sample, not at flip time.** Buckets build lazily on the next tick, so a
   flip-time read shows `buckets=0` even when they populate — which makes "ON draws almost nothing"
   indistinguishable from "ON has no buckets at all".
9. **Session history bleeds.** `autoSpawn=first` spawns at the character's SAVED position — which our own
   `@telepoi` probes mutate — and `terrainBakedLbs` is cumulative. Travel also REAPS emitters
   (2582 → 1577 → 1108 over a tour), so a run that spawns far and teleports in plateaus LOWER. Use
   `settleNormalized` (teleport → reload → settle) when comparing across loads is unavoidable.
10. **Ops:** close stale CDP pages and wait ~45s between arms or the 2nd `tailnet1` login is rejected
    (`__bootState==='error'`, looks like a boot bug). Automated verdict lines lie — my own culled-draw
    probe printed the WRONG verdict because its threshold was arbitrary; read the ratio, not the label.

## 3. ⭐ THE OPEN LEAD — fix the RP6 visibility leak (task #9)

**Ground truth** (settled Cragstone, pinned pose, per-mesh path, `culled-draw-probe.mjs`):
```
emitters=1161  culled=1153  notCulled=8
parts of CULLED    emitters: total=2824  inScene=2824  VISIBLE(=drawing)=140
parts of NOTCULLED emitters: total=24    inScene=24    VISIBLE(=drawing)=12
drawable particle meshes in staticsGroup = 152
```
**140 of 152 drawn particles (92%) belong to emitters RP6 already culled.** The transition block
(`particle_manager.js` tick, `if (nowCulled !== wasCulled)`) only touches slots occupied AT THAT MOMENT,
and `particle.js` `setTranslucency` (~:95) sets `mesh.visible` from translucency — so slots drift back to
visible while the emitter stays culled, and `frustumCulled=false` means three never saves us.

**Candidate fixes, cheapest first:**
- **(a) PREFERRED — make the cull authoritative per tick, not per transition:** while `_rp6Culled`, force
  `parts` invisible. The manager **already does exactly this** in its stopped-drain path ("re-hide any
  occupied slots"), so the pattern and its justification are in-file.
- (b) gate at the write site: `particle.js` must not set `visible=true` when its emitter is culled.
- (c) set `frustumCulled=true` on world-anchored particles. Weaker: doesn't fix the 220m-cap case, costs a
  per-mesh sphere test, and the sky chain (`attachSkyParticleChain`) shares the manager.

**Validate with `particle-instancing-ab.mjs` (A/B/A, single page load).** Expect the OFF arm's particle
draws to collapse toward the ON arm's number **without instancing**. Then re-measure `?particleInstancing`
on top of a correct cull to learn what batching is ACTUALLY worth — likely ~nothing ⇒ **retire the flag**.

## 4. REMAINING TASKS

- **#9 (⭐ above)** — fix the RP6 visibility leak. Blocks any particle perf claim.
- **#4** — framed brazier-flame hero shot A/B before any default flip. Parity so far is proven by counts +
  identical frames, **not by seeing fire**: every teleport lands the camera in terrain, and the
  "most particles" heuristic keeps selecting lava vents / foliage emitters. Select by `defaultScriptId`
  for a known brazier PES and raycast for line-of-sight. Use the pinned pose (~2400 visible particles),
  not a quiet corner — the matching `fire2-{ON,OFF}.png` frames had only ~35 particles.
  **Also still owed before any default flip: the 62-town walk.**
- **#6** — static script ANCHORS leak: they accumulate 138 → 631 over a tour while their emitters are
  correctly reaped (2582 → 1577 → 1108). LOW impact (Groups issue no draws) — memory/traversal only.
  **Do not conflate with the particle draw cost.** Both add sites stamp `userData.landblockId`
  (`statics.js:4079`/`:4222`); the P4/R-10 comments say the LRU's staticsGroup sweep should reap them, so
  either it isn't running or it misses anchors without a landblockId. Note `terrainBakedLbs` is cumulative
  (§1) so it cannot serve as the reap predicate.

## 5. RESIDUALS / UNKNOWNS (honest loose ends)

1. **The A/B's particle draw magnitude does not reconcile with the culled probe.** The A/B session
   (emitters=2582, liveParticles=9570) showed OFF=2613.8 draws vs ON=214 ⇒ ~2400 particle draws. The
   culled probe (emitters=1161, liveParticles=2848) found only **152** drawable particles. Scaling 152 by
   3.4× gives ~517, not 2400. Either the visible fraction varies far more than linearly with the plateau,
   or something else in the OFF arm draws. **Re-measure both on ONE scene** (the A/B/A harness can do it)
   before trusting any particle draw magnitude.
2. **Why is the emitter plateau stochastic at all?** 1161/2451/2502/2505/2579/2582 from a CONSTANT 138
   anchors, stable within a session. What varies per session — CallPES loop arms? RNG in the chain walk?
3. **`terrainBakedLbs` never shrinks** (121→242→363). Is the LRU evicting at all, or is the set simply
   "ever baked" by design? If eviction is silently not running, that is its own lever.
4. **The `Object3D.prototype.onBeforeRender` hook mis-fires** — attributed only 118 of 1574 draws
   (entities/particles missing) while the per-instance hook worked. Suspect duplicate three module
   instances. Don't reuse that variant without fixing it.
5. **`_RP6_MAX_DIST_SQ` (particle_manager.js:131) is dead** — pre-existing, computed and never read; the
   distance gate recomputes `slack` inline. Harmless, but it means the constant is not the knob it looks like.
6. **All static emitters are `persistent`** (`persistent == emitters`, `stopped == 0` at every POI):
   `totalParticles==0 && totalSeconds==0`, so none auto-finish — removal is eviction-only. Worth knowing
   before touching emitter lifetime.

## 6. HARNESS (all on master, `net-review/`)

- **`settle.mjs`** — THE shared settle predicate. `settleAt(page, poi, {pinPose, log})`, `worldState(page)`,
  `WEATHER_OFF`, `settleNormalized`. Read its header: it documents all four confounds with the numbers.
- **`particle-instancing-ab.mjs`** — the ONLY valid particle A/B. Single-page-load A/B/A with a drift gate.
  `POI=Cragstone PIN_POSE="0xbb9f0040 169.36 168.25 54.01" node particle-instancing-ab.mjs out.json`
- **`steadyframe-sizing.mjs`** — census/draws; now uses `settleAt`, forces weather off, reports settle
  state + `particleMeshes/particleBuckets/particleInstances` separately from `eligible`.
- **Runtime hooks (shipped, diagnostic):** `window.__setParticleInstancing(bool)`,
  `window.__particleInstancingDiag()`, `window.__atlasStats()`.
- Scratch probes worth re-creating if needed (they were session-local): `culled-draw-probe.mjs` (§3 ground
  truth), `ramp-probe.mjs` (the attach curve), `plateau-probe.mjs` (POI tour).
- **1070 bring-up:** `schtasks /run /tn cdpwbclaude` (→ `C:\Temp\launch-claude.bat`, headless + muted +
  `--user-data-dir=C:\Temp\cdpwb-claude`). NOTE it still picks the **real NVIDIA GPU** —
  `--enable-unsafe-swiftshader` is only a fallback permit. Tunnel `-L 9333 -R 8765` to
  `young@100.127.215.75`. Cleanup: kill by `cdpwb-claude` cmdline match ONLY, never `taskkill /IM chrome.exe`.
  A PERSON uses that box: off-screen/headless only, always muted.
- Raw data: `/mnt/wbterminal2/tmp/{inst-ab,inst-ab2,culled-draw,ramp,plateau,repro-*,pin-*,attrib*}.json` + `*.png`.

## 7. OPS / GIT

- **Direct push to `origin/master` WORKS.** The prior handoff's "push is blocked, use a PR" is wrong: no
  rulesets (`[]`), master is **not protected** (`404 Branch not protected`), and 8 pushes landed this
  session with no workaround. The old `remote: fatal error in commit_refs` was a **transient GitHub
  server-side error** misread as branch protection appearing.
- `external/holtburger` is NOT a submodule — it is a tracked subdirectory of the one repo (shared `.git`),
  which is why it reports the same remote.
- This session: `9baa72b2` refute-atlas · `b60e2085` ?particleInstancing (default-OFF) · `0a9be2be` A/B
  notes · `41ba7a72` retract (WRONG) · `f81b1ef2` −593 was one sample · `de24059d` census particle fix ·
  `aed9c640` settle.mjs · `b536625a` A/B/A infra + arm mismatch · `52cf1f03` un-retract the leak.
- **This handoff is UNCOMMITTED at time of writing** — commit it.

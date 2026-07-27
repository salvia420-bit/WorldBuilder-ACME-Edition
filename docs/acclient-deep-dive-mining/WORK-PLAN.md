# holtburger-web — overarching work plan from the acclient deep-dive mining

Evidence base: 8 agent findings files (~264 tasks) over 16 source artifacts, the
orchestrator `VERIFICATION-LOG.md`, one headless live run
(`PHY-07-LIVE-RUN-2026-07-26.md`), and a **256-question live questionnaire
answered in full** (2026-07-27, all 20 KEY items answered, 72 free-text notes).

The questionnaire is what makes this a plan rather than a list. Reading source
can only establish what the code says; 36% of answers came back `unsure` and 12%
`not tested`, and that is a feature — the 56 `yes` and 61 `no` answers that
remain are the ones we can actually build on.

Client under test: 1070 box, release wasm, weather/rain/snow/lightning off,
clouds on, low textures, both with and without `?nosw=1`.

---

## THE HEADLINE: the original "we can run through doors, trees, rocks" is THREE
## different bugs, not one

The five collision questions were deliberately split by code path. The answers
separate cleanly, and the split is the finding:

| Question | Answer | Meaning |
|---|---|---|
| **COL-01** procedural trees/rocks stop you? | **NO** (sev 1) | No collision feed exists — architectural gap |
| **COL-02** building walls / placed statics stop you? | **YES** (sev 0) | This path works correctly |
| **COL-03** closed doors stop you? | **NO** (sev 2) | **Regression** — measured working 2026-07-20 |
| **COL-04** creatures block you? | unsure — "*I can push monsters out of the way, normal retail behavior*" | Probably fine; needs a targeted check |
| **COL-05** terrain holds you up? | **PARTLY** (sev 1) — "*affects monsters more than my player rig*" | Mostly fine for the player |

`COL-01 = NO` alongside `COL-02 = YES` is **exactly the DAT-01 signature**, which
the questionnaire predicted verbatim as "the single most useful thing you can
tell us". It confirms, from live behaviour, what code reading found: procedural
scenery is a render-only path (`LandblockScenerySoa`, `lib.rs:4128`, carries no
physics field), while buildings/statics go through
`insert_static_physics_bsp` and work. Retail makes each tree a real `CPhysicsObj`
(acclient.c:352708-352718).

**Doors are a separate problem and must not be folded into the scenery work.**
A live functional block at the Holtburg grocer door `0x7A9B401F` was measured on
2026-07-20; it is gone now. That is a regression inside a one-week window
containing the threads work (`pkg.bak-pre-threads-2026-07-24`) and the
shard/stream work (`pkg-s3w`, `pkg-shards`, `pkg-prof`, 07-23…07-25).

---

## TIER 0 — confirmed defect, named cause, small fix. Do these first.

### P0.1 — Gate outdoor landblock streaming off inside dungeons · PHY-25 · S
**The only severity-3 answer in the entire questionnaire.** TER-06: inside a
dungeon the client still hitches as if streaming outdoor terrain — *"the most
serious issue we have"*. TER-07 (sev 2) corroborates: dungeon frame rate is worse
than the visible geometry justifies, while *"outdoors has always worked better
despite being much more demanding on paper"*.
Retail gates this off — `UpdateLoadPoint` is outdoor-only. This is an S-sized
task already sitting in the physics findings, and it is the single highest
pain-to-cost ratio item in the plan. Caveat from the user's note: recent work has
improved it, so re-measure before and after rather than assuming the old baseline.

### P0.2 — Bisect the door-collision regression · COL-03 · S to M
**RESOLVED 2026-07-27 — premise refuted; see VERIFICATION-LOG §COL-03.** The
bisect ran over seven builds 07-20 → current: every arm blocks the door
head-on; there is no regression and no suspect commit. The real defect is that
the door collider is a swept circle at the door's origin
(`entity_collision.rs:120-126` TODO) — only the degenerate head-on approach
blocks; a ±0.45 m lateral approach slides around the circle into the shop.
Replacement task: implement the entity physics-BSP sweep arm (M), regression
test pinned at ±0.45 m offset, never head-on. COL-22 lead found in passing:
door Setup `0x020019FF`'s selectionSphere (r 0.892) sits at the hinge, so
far-side leaf clicks miss.

**Follow-up "doorframe gap" also CLOSED 2026-07-27 — premise refuted; see
VERIFICATION-LOG §"Doorframe gap".** The +0.45 m lateral that "continues over
outdoor terrain to y 67" is correct behaviour: the grocer building is rotated
**−45°**, its SE wall runs NE, and the mover is deflected by the doorway's NE
jamb at (82.33, 34.32), slides along the OUTSIDE of that wall at exactly one
capsule radius, and rounds the E corner (86.60, 38.59) into open ground. Zero
trace samples across nine walks land inside the building shell. Head-on stays
**0.883 m** (the 0.40 + 0.48 circle) with BSP fully resident before contact —
no migration to 0.69. Two corrections that outlive the item: (1) the
`system.rs:4783-4886` "integrator arm" everything cites is **dead code** —
`USE_UNIFIED_TRANSITION` routes the live mover to
`find_transitional_position_dispatch` (`system.rs:6629`), so collision work
belongs in `spatial/transition.rs` + `spatial/faithful_bridge.rs`; (2) the
third-person camera still clips on the coarse per-part building AABB
(`camera.js:1353`), which over-bounds a 45°-rotated building by up to 4.9 m —
S-sized deletion, needs a 1070 eye test.

### P0.3 — Guard the degenerate follow-camera basis · LIVE-03 · S
COL-08 (sev 2) confirms live what the headless run measured: the camera reaches a
state with **no usable horizontal heading** — forward components exactly `(0,0)`
— and turning stops working. Any consumer normalising that vector divides by
zero. This silently poisoned the headless harness's own turn loop, so it costs us
test reliability as well as gameplay.

### P0.4 — Icon cache: cap it and stop latching failures · LEAK-03 · S/M
RQ-32 (sev 2): icons fail to load and then **stay broken for the whole session** —
precisely the predicted symptom. `ui/ac_icon_cache.js:29` is an uncapped `Map` of
base64 data URLs (~30 MB ceiling), never cleared, failures latch forever, and
`iconCacheSize()` has zero consumers. Retail's parity ceiling is 400 shells.

### P0.5 — Fix the jump-block ordinal range · ERA-01 / ERA-02 · S
Verified by the orchestrator against ACE's end-of-retail table: our range
`0x10000128..=0x10000131` is the 2013 window applied to 2015 IDs. It blocks
**TripleThrustLow/Med/High** and lets **MagicPowerUp08/09/10Purple**
(`0x132`-`0x134`) through; the intended window is `0x12B..=0x134`. The adjacent
range `0x6F..=0x78` is correct because it sits below the `0x10F` shift boundary —
that internal inconsistency is the fingerprint. Duplicated at
`motion_interp.rs:266`/`:269` with a test pinning the wrong arm, so fix all three.
COL-26 (sev 1) is the live tell. ERA-02 adds 2015's two new jump blocks
(`Sanctuary 0x10000057`, `AI_TelegraphCast 0x1000019B`).

---

## TIER 1 — the architectural gap

### P1.1 — Give procedural scenery a collision representation · DAT-01 · L
Confirmed live by the COL-01/COL-02 contrast. This is the big one and it is
genuinely large: scenery is thousands of instances per landblock, so the retail
answer (every tree a real `CPhysicsObj`) needs a residency strategy, not a naive
port. Note `holtburger-scenery-bake/src/aabb.rs` already computes world-frame XY
AABBs per placement **at bake time** for placement rejection — that machinery is a
natural starting point, but it is currently discarded rather than shipped.
Corroborating live answers: COL-17 (sev 2) *"can just walk and jump up very steep
cliffs I have no business traversing"*; COL-29 (sev 2) rocks sitting in paths.

**PHASE 1 LANDED 2026-07-27 — design in `DAT-01-design.md`, ledger in
VERIFICATION-LOG §DAT-01. Four premises above are corrected:**
(1) retail scenery has **no physics BSP** — every scenery `GfxObj` measured
reports `physicsBSP: None`, so `CPhysicsObj::FindObjCollisions`
(`acclient.c:316229-316281`) falls to its **cylsphere** rung. The existing
`insert_static_physics_bsp` arm cannot be the feed; a cylsphere narrow phase
must be written. (2) The `aabb.rs` boxes bound the *foliage*, not the trunk —
4.5× to **12.4×** the cylsphere radius — so they are a broad phase only; shipped
as the collider they would make one pine a 27 m wall. (3) **42% of placements
(33/79 sampled, incl. the single most common model) have no collider at all** in
retail and must be filtered per-`CSetup`, or we ship solid grass. (4) **COL-17
does not belong here** — it is terrain slope (PHY-06/PHY-21, Tier 3); do not
expect DAT-01 to move it. Bake side now emits the previously-discarded box as
six appended V3 `aabb_*` JSONL fields with zero placement drift (freeze hash
unchanged); phases 2a-2e are the client consumption, and a full `dist/` re-bake
(phase 3) is only needed once phase 2 validates.

**PHASE 2 LANDED 2026-07-27 (2a-2e, uncommitted) — ledger in
VERIFICATION-LOG §DAT-01 PHASE 2.** Client now carries a per-landblock
`SceneryColliderBatch` (SoA, one row per primitive), the ported `CCylSphere`
*and* `CSphere` narrow phases, a per-DID ladder classifier, the wasm
`populateSceneryCollidersForLandblock` ingest of the V3 `aabb_*` fields, and an
integrator arm behind **`USE_SCENERY_COLLISION` = false**. Shipped wasm
4,906,246 B release. Live-validated: boots clean on bare defaults with the arm
inert on the pre-V3 `dist/`; against the real V3 rebake the ingest stages
**exactly** the census-predicted collider counts (46/71 on `0xA9B3`, 0/8 on
`0xAAB4`), drains, double-registers on re-stage, and purges to zero through
`clear_landblocks_collision`.

**Two more of this section's premises are now refuted, and one trap is worth
carrying forward:**
(5) *"scenery has no physics BSP"* — **REFUTED at world scale**: 23 of 176 DIDs
do (0.5% of real placements). Rung 1 short-circuits retail's ladder and four
models carry a BSP *alongside* cylspheres, so the classifier must test BSP
FIRST. Rung 1 is classified and **DEFERRED** (blocked on `CellPhysicsBsp.scale`
being hard-coded 1.0 and on that machinery being live-by-default — see the
ledger's TODO).
(6) *"42% of placements have no collider"* — **REFUTED, understated**: the real
figure is **59.7%** (95% CI [58.05, 61.39]) over 115,415 real placements, and
rung 3 (`CSetup.spheres`, 6.1%, 19 DIDs) exists and is now ported too. Also:
`height == 0 && radius == 0` is NOT a valid no-collider predicate — 19
*colliding* DIDs satisfy it. Ground truth:
`/mnt/wbterminal2/buildbox-2026-07-27/census/census-summary.md`.
(7) **TRAP — `system.rs:4783-4886` is DEAD CODE.** The outdoor-static AABB
sweep + static-BSP push-out reads like the natural home for any new outdoor
collision arm, but `advance_local_pose_for_manual_drive_slice` returns at
`:4221` under `USE_UNIFIED_TRANSITION`. The live path is
`find_transitional_position_dispatch`. Any flag-gated arm added anywhere in
this file must ship an **unconditional** reachability counter (see
`sceneryArmEvals`), because "flag off" and "flag in dead code" are otherwise
indistinguishable.

Remaining: **phase 3** — the full-world V3 re-bake is **DONE and staged** at
`/mnt/wbterminal2/buildbox-2026-07-27/rebake/staging/` (195,076 files,
validated additive, zero drift); it needs the `dist/` swap. **Phase 4** — flip
`USE_SCENERY_COLLISION` to `true` and run the lateral-offset approach at a
known tree plus the "can still walk through grass" negative test, reading
`__diag.collision.residency().sceneryNarrowHits`; the arm's per-tick cost is
still **unmeasured**, which is the sole reason it ships gated.

---

## TIER 2 — the lighting and terrain-shading campaign

Five separate sev-2 answers share one root cause and should be run as one
project, not five tickets. Retail **baked static lighting into vertex colours**
(`SetStaticLightingVertexColors` / `burnedInStaticLights`); we run every static
light live through a 32-slot pool.

- RQ-05 (sev 2) — dungeon lamps light the nearest thing to the camera, not their
  own room: *"lights only light up when it gets close, breaks immersion"*
- RQ-07 (sev 2) — lights pop on/off as the camera turns: *"meeting halls are a
  great example… walking behind the sitting benches can turn off lights"*
- RQ-20 (sev 2) — terrain reads flat and uniformly lit, not retail's faceted
  per-vertex look: *"flat and uniform, boring"*
- RQ-18 (sev 2) — terrain texturing looks blocky rather than blended
- RQ-04 (sev 2) — *"nights are basically day… no stars or anything to indicate night"*

Tasks: **RND-04** (bake static lighting to vertex colours, in Rust), **RND-20/21**
(faceted terrain shading), **RND-05/03** (light selection churn), **RND-11/12**
(night/ambient floor — retail's `LSCAPE_LIGHT_MINIMUM = 0.2`), **RND-30/33**
(terrain texture blending).

⚠ **Process note, in the user's words:** on the blocky terrain texturing —
*"many dedicated sessions and no agent has ever successfully helped me."* Do not
attack this by eyeballing screenshots again. Ground it in real DAT data: dump
retail's actual terrain texture blend for a known landblock via
WorldBuilder.Terminal and diff against ours numerically. This is a
`ground-in-real-wire-data` problem, not a shader-tweaking problem.

Also here: **RQ-08** (sev 2) foliage alpha shows a faint box/halo in both
wireframe and textured. **CHECKED 2026-07-27 — NOT a flag promotion (see
VERIFICATION-LOG §RQ-08): do not flip `surfaceParityV2`** (it is inert without
default-OFF `surfaceUnified`; the default ladder already alpha-tests at 0.5;
retail's paletted ref 0.392 is *looser*; static_atlas hard-resets the ref
anyway). The real unimplemented retail behavior is ClipMap's
`SetAlphaBlendEnable(1)` alongside the test — split that piece onto the legacy
ladder + static_atlas after a hasPalette census (RND-08/33, new work).

**RND-08/33 LANDED 2026-07-27 (uncommitted, JS only — see VERIFICATION-LOG
§RND-08/33).** Census: 721 of 6,152 `client_portal.dat` surfaces carry
`Base1ClipMap` — **518 paletted** (PFID_INDEX16 → ref 0.392) and **203
non-paletted** (DXT5/A8R8G8B8/DXT1/DXT3/A4R4G4B4/R8G8B8 → ref 0.784), so the
shipped 0.5 was wrong for both classes. One shared
`applyClipMapRenderState` now serves all THREE ladders (the plan named two; the
third is `entities.js:5187` `_applyPalettedSurfaceRenderState`) and
`static_atlas.js` buckets on the exact ref + blend state instead of a boolean.
**Premise correction:** the blend is `BLEND_ONE`/`BLEND_INVSRCALPHA`, not
SRCALPHA/INVSRCALPHA — `enum BlendMode` (`acclient.h:5193-5211`) is not
D3DBLEND, and 2 is ONE. Depth writes stay ON. `?clipMapParity=off|ref` are the
A/B arms; the 1070 fringe eye-test is queued with task 3b. RND-33
(stipple→WRAP/CLAMP) is **still open** — it needs a new wasm-side bit and was
not touched here. Newly opened residual: retail alpha-tests `ClipMap+Alpha`
(22) and `ClipMap+Additive` (31) too, which our `else if` ladder still swallows.

---

## TIER 3 — movement fidelity

Live-confirmed, all sev 2 unless noted, and all pointing at the faithful
transition driver's outdoor arm:

- **COL-15** — no downhill slide: *"nothing seems to keep me held to the ground
  going downhill… inertia carries me into the air, lacking any sliding down
  cliffs like in retail"* → PHY-11 / PHY-13
- **COL-17** — can climb cliffs that should be untraversable → PHY-06 / PHY-21
- **COL-16** (sev 1) — stairs and thresholds wonky; *"cliff edges shouldn't let me
  run over them"*
- **COL-10** — walking animation wrong; **walking backwards breaks the animation
  completely** (idle pose, not T-pose) → OQ-3
- **COL-09 / COL-19 / COL-20** (sev 1) — speed likely too fast on low-level
  characters; turning *"not buttery smooth like retail"*; creatures *"a bit over
  eager to run before completely facing"*
- **COL-21** (sev 2) — sticky-melee regressed: works up close, fails from range
- **CQ-06** (sev 1) — corpses *"flicker back to idle after death animation"*

Sequencing: the walk-speed question (OQ-3) should be settled **first** — it is
cheap, and if our base speed is wrong then every other movement judgement here is
being made against a distorted baseline.

**OQ-3 SETTLED 2026-07-27 (see VERIFICATION-LOG §OQ-3): base RUN speed is
correct** (7.785 m/s measured vs 7.787 expected at run skill 105, 0.02%) —
COL-09's premise is refuted and Tier 3 may proceed on this baseline. WALK is
genuinely broken (body 2.60 m/s from the DAT anim vs stateGroundSpeed 3.12 →
clip plays 1.2× travel = foot-slide; backstep worse) and is the likely COL-10
root cause — but it is a client/server-skew FORK needing a decision, not a
constant fix. Camera-side lead: `camera.js:1772` flat 4.5 m/s prediction speed.

**COL-10 walk fork DECIDED + FIXED + LIVE-VALIDATED 2026-07-27 — Tier 3 is now
fully unblocked on a sound speed baseline** (see VERIFICATION-LOG §COL-10). User
picked option 1: the **body adopts retail's `WalkAnimSpeed` 3.1199999 m/s**
(`acclient.c:343561`, ACE `MotionInterp.cs:684-685` identical → the fix REMOVES
client/server skew). Three call sites in `holtburger-core` now read the existing
`WALK_ANIM_SPEED` const instead of the DAT-derived `base_walk_forward_speed()`:
the live interpreted lane (`motion_interp.rs:1831`), the legacy lane
(`common.rs:854-858`), and the autonomous MoveTo Walk arm (`system.rs:4047`).
Measured live on the release wasm (4,947,030 B), 6/6 movement-gated arms:
**walk 3.094–3.113 m/s** (target 3.1200, was 2.6027) and **backstep
2.031–2.044 m/s** (target 2.0280); run unchanged and internally consistent
(16.06 = 4.0 × run_rate 4.02). The
anim-side needed NO edit — `cycleTimeScale = stateGroundSpeed / cycleBaseSpeed`
was already 3.12/2.6017 = 1.199x, which is only correct now that the body moves
at 3.12; the handoff's "backstep timescale 0.78 vs correct 0.65" INVERTS under
this decision (0.78 is the correct value; 0.65 was the option-2 target).
Sidestep was checked and is NOT the same bug — it already derives from the
constant (walk strafe 1.56 m/s), no change. Remaining COL-10 symptom to re-test
with a renderer: the *backwards animation* complaint (idle pose) — the speed half
is now right, the clip-selection half is unverified.

**Camera-side lead DONE 2026-07-27 — but it was DEAD CODE** (see
VERIFICATION-LOG §"camera.js flat prediction speed"). The unit conflation was
real and is now fixed in three JS sites (base run speed × run-rate scalar,
mirroring the Rust split), yet `_advancePrediction` was retired from `tick()`
on 2026-06-29 and the 2D sprite predictor it mirrors is unreachable (nothing
ever populates `entityMap` in `index.html`), so **no live behaviour changed**.
Do not count this against COL-09/COL-19.

---

## TIER 4 — state and lifetime correctness

- **P4.1 · LEAK-01 · M** — NQ-19 (sev 2): *"items have been placed in packs and
  didn't appear later."* Nine per-GUID bridge maps have zero removals while the
  fan-out beside them prunes eight siblings. Via ACE guid reuse this is a
  **stale-data** bug, not just a leak — exactly the symptom retail's §3 predicted.
- **P4.2 · CORE-01 + NET-06 · M — file as ONE task.** The two agents contradicted
  each other and both were right about different runtimes: `net_worker.rs:359`
  says *"TimeSync is dropped"* in the **wasm** client, while `holtburger-core`'s
  runtime consumes it (`runtime.rs:119`). So the browser never has a server clock
  and permanently uses a UNIX-epoch wall-clock fallback, while ACE stamps in
  `PortalYearTicks` — domains ~47 years apart. NQ-08: buff timers *"probably not
  working correctly."*
- **P4.3 · LEAK-02 · S** — `EntityManager.remove()` early-returns before purging
  the park maps, reproducing retail's bucket-miss bug line for line. The
  retail-faithful 25 s expiry already exists, is headless-verified, and is
  default-OFF behind `?preCreateBuffer`. **Promote it.**
- **P4.4 · investigate, not client-side** — COL-24 (sev 2): creatures frozen in
  place, and *"creatures that shouldn't be there like moarsman north of Holtburg
  in the river… a corruption in ACE server?"* Treat as a server/data
  investigation. Do **not** edit `~/ace-server` (vanilla rule) — diagnose against
  the shard DB.

---

## TIER 5 — instrumentation debt (unblocks everything above)

These are small, and every one of them is a case where we currently **cannot
tell** whether something works:

- **P5.1 · S** — Expose the wasm collision self-tests and residency counters to
  JS. `populateStaticsAabbsForLandblock`, `holtburg_static_object_count`,
  `holtburg_test_collision_clamp_axis_aligned`, `holtburg_test_collision_slide_along_wall`
  all exist in `pkg/holtburger_web.d.ts` but are unreachable from `window`. This
  would have answered the entire collision question in one call instead of a
  90-minute headless run.
- **P5.2 · S** — Fix `capture_audio_leak.cjs`: it samples `usedJSHeapSize` for
  120 s **without** `--enable-precise-memory-info`, which `harness/perf-walk.mjs:98`
  does pass. Its "no leak" verdicts **cannot fail** and are unproven. Gates two
  other tasks (LEAK-04, half of LEAK-06).
- **P5.3 · S** — Pinned-entry counter on the surface cache (PAL-01). Over-budget
  operation is legal by design, so a leaked handle is currently indistinguishable
  from healthy operation.
- **P5.4 · M** — `symbols.tsv` from `acclient.txt` (TOOL-01). The PDB is absent
  but unnecessary: the 82 MB dump already holds 16,232 `S_GPROC32` records,
  **27,568 line/address blocks** over **1,137 source paths**, and the
  `portal/engine/game/ac` layer split. One awk pass gives VA → original
  `file:line`. Proven valuable already: it showed retail's primary leak is a
  PORTAL→AC **layer-boundary omission**, not a typo — a distinction invisible
  without it, and directly analogous to our wasm↔JS boundary.
- **P5.5 · S** — Movement/heading sanity gates in every behavioural harness. Our
  own rig reported `BLOCKED (plateau)` when the player simply never moved.

---

## TIER 6 — plugin API / rynthsuite

**P6.1 · CORE-07 · M — promotion, not a rewrite.** Retail exposed ONE host object
(`IAsheronsCall`, 52 slots, 16 `E_FAIL` stubs — with `GetCombatMode`/`GetVendorID`
COMDAT-folded into a body returning `S_OK` without writing the out-param, so
callers cannot detect the hole) plus ~12 callbacks, only two eatable, both chat.

We have three competing facades, and the most complete — `rynth/webhost.js` — is
an independent re-derivation of `IAsheronsCall` with retail's method names and
the two patterns retail needed and lacked: **capability probing** and **frozen
per-tick snapshots**. Make it the one versioned `client` facade, keep the
loader's eatable bus, add retail's two chat hooks (inbound `AddTextToScroll`,
outbound `OnChatCommand` — we have neither direction), make `client.ui` real (it
is three no-op stubs with zero callers), and declare capabilities in the manifest
— which also feeds retail's server-side plugin-manifest query `0x02AE`/`0x02AF`,
spec'd on both sides and implemented on neither.

Live context: GQ-01 — *"the plugin hud is obsolete generally."* This tier is
where the rynthsuite/rynth-ai integration lands, so its API shape should be
settled before more plugin surface is written against the current three.

---

## Deliberately NOT doing

- **DAT-09 scenery freq-cull noise** — our noise is loop-invariant where retail
  strength-reduced `(kq + 23399)`. But it is inherited from ACE, so fixing only
  the client **desyncs us from the server**. Needs a joint decision first.
- **"Fixing" `AtlatlCombat 0x8000013b`** — it is correct; the 2013 doc's `0x138`
  is the stale value. Changing it breaks every atlatl animation.
- **`ClientAction` +3 shift** — that namespace did **not** shift. The 2013 PDB
  shows `0x1000010E` carrying both `Motion_SkillHealSelf` and
  `PlayerOption_HearGeneralChat`.
- **Per-landblock hitch as a pure parity target** — TER-02: the hitch *"occurs in
  retail!"*, so replicating retail will not remove it. Retail's version even
  leaked PvP information (a hitch announced another player entering the dungeon).
  Fix it as a product decision, not a fidelity one.
- Binary-patch-era machinery, DirectSound/D3D device state, scatter-gather
  `WSABUF`s, GLS/registry auth, DDD `.dat` writes.

---

## Sequencing rationale

1. **Tier 5 partly first.** P5.1 and P5.5 are hours of work and make Tiers 0-3
   testable instead of arguable. Doing them first is what stops the next round of
   findings needing another 256-question questionnaire.
2. **Then Tier 0**, cheapest-first: P0.1 is the user's worst pain and an S-sized
   named fix. P0.2 is a bisect over builds we already archived.
3. **Then Tier 1**, which is the only genuinely large item and benefits from
   P5.1's instrumentation existing.
4. **Tier 2 as a campaign**, grounded in DAT data rather than screenshots.
5. **Tier 3 after settling walk speed (OQ-3)**, so judgements aren't made against
   a distorted baseline.
6. **Tier 6 before more plugin surface accretes** against three facades.

## Confidence labelling

Every item above is tagged by how it is known:
- **Live-confirmed** — a questionnaire answer or the headless run observed it:
  P0.1, P0.2, P0.3, P0.4, P1.1, all of Tier 2, all of Tier 3, P4.1, P4.4.
- **Read-verified by the orchestrator** — re-opened and checked: P0.5, P4.2,
  P4.3, P5.1, P5.2, P5.4.
- **Agent-reported, not yet verified** — everything not named above. Treat as
  leads. Of the top-ranked agent leads spot-checked during this operation, roughly
  a third were wrong, so verify before starting any of them.

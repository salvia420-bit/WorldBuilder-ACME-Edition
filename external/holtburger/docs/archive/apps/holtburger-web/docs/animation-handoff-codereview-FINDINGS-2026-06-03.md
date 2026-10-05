# Animation Handoff — Lead Code Review (2026-06-03)

**Reviewing:** `/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/docs/animation-handoff-codereview-2026-06-03.md`
**Against:** HEAD of `external/holtburger` (commits `c18c158e` locomotion fix + `4453d5a5` secondary fixes, both checked out).
**Mode:** code-based only — no 1070, no browser, no dev server.

---

## 1. Verdict

**The handoff is substantially accurate and its ranked plan is sound — with one material exception that changes the headline conclusion: the doc's marquee next-step (step 2, "feed velScale `actual` from the wasm `stateGroundSpeed` getter instead of the rig-XZ EMA") is already implemented at HEAD.** The getter is the *primary* actual-speed source (`entities.js:6989`), the rig-XZ EMA is a *demoted fallback* (`entities.js:6991-6993`), the local guid genuinely feeds it non-zero forward state (`entities.js:4607-4608`), and all of the sibling impl-handoff doc's three "must-fix" plumbing blockers (opts threading, `playerRunRate` shape, `forward_speed` double-count) are resolved. **The single most important finding: the residual "run looks like walking" issue is no longer a code/plumbing problem — it is gated solely on `VEL_SCALE_ON` staying default-OFF (`entities.js:314`) pending one GPU eye-test, after which the default should be flipped.** Everything else in the doc — the locomotion-dispatch fix, the MotionCommand constants, the KIND_POSITION/KIND_MOTION skip logic, the run-vs-walk clip resolution, and both `4453d5a5` secondary fixes — is confirmed correct against the code, with only minor line-number drift.

---

## 2. Doc-claim accuracy table

| # | Claim | Verdict | Evidence (file:line) |
|---|-------|---------|----------------------|
| 1 | Local guid in entityMap = `getLocalPlayerGuid()` = `0x50000007`, driven by `setMotion`; KIND_POSITION skip keyed on it | **Confirmed (mechanism); uncertain (hex values)** | Mechanism: `camera.js:1495-1498,1509`; `entities.js:4462`. No guid literal exists anywhere — grep for `0x50000007`/`0x50000127` is zero hits; the hex values are live-data assertions, not code-verifiable. |
| 2 | KIND_POSITION skipped for local guid (`loop.js:1211/1378`); KIND_MOTION not skipped (`loop.js:1232/1402`) | **Confirmed** | `loop.js:1211` and `:1378` gate `setPose` on `!isLocalPlayerGuid(g)`; KIND_MOTION branches at `:1232/:1402` are unguarded (actual `setMotion` at `:1238/:1406`). |
| 3 | velScale default-OFF: `VEL_SCALE_ON` needs `?velScale=on`; tick gate needs `base>0 && _locoCycleKey` | **Confirmed** | `VEL_SCALE_ON` at `entities.js:314` (doc's "~310" is the comment block at 305; const is 314). Tick gate at `entities.js:6969`. |
| 4 | velScale `actual` reads from rig-XZ EMA (`inst._emaSpeed`, ~6984) and reads ~0; feeding from `stateGroundSpeed` is a TODO | **REFUTED / STALE** | At HEAD the getter is **primary**: `entities.js:6989` `let actualSpeed = this._resolveStateGroundSpeed(inst)`; EMA is **fallback only** at `entities.js:6991-6993`. EMA assignment is at `6963-6964`, not 6984. This is the most material drift in the doc. |
| 5 | `base` resolves to 4.0 (RunAnimSpeed); `cycleTimeScale = clamp(actual/base,0.25,4.0) = 0.25` when actual≈0 | **Confirmed** | Clamp at `animation.js:269-281`. `base` is data-derived (not hardcoded): `cycle_base_speed` chains velocity → MotionKinematics at `lib.rs:4680-4717`; `RUN_ANIM_SPEED=4.0` at `lib.rs:25840`. 4.0 is an observed value, correctly framed. |
| 6 | MotionCommand constants (RunForward `0x44000007`, WalkForward `0x45000005`, etc.) match the enum | **Confirmed** | Bit-exact in `camera.js:1500-1506`, `lib.rs` state-ground-speed branch, and cross-checked against `animation-deep-dive-2026-06-02.md:316,784-786` (acclient.c anchored). |
| — | `cycle_base_speed` step-2 (MotionKinematics) is consumed (contra older impl-handoff "PROVIDED-BUT-NOT-CONSUMED") | **Confirmed; older doc refuted** | `lib.rs:4701-4711` chains step1 velocity → step2 kinematics; only step3 GetAnimDist deferred. The codereview doc under review is the accurate one. |

**Highlighted refutation:** Claim 4 is the one stale claim — it tells the reader to *wire* the getter, when the getter is already wired and primary.

---

## 3. The locomotion-dispatch fix (`c18c158e`)

**Correct and low-risk. Clears for merge.**

- **Mapping is bit-exact** (`camera.js:1500-1506`): forward+run→RunForward `0x44000007`, forward+walk→WalkForward `0x45000005`, back→WalkBackwards `0x45000006`, strafe-R/L→SideStep `0x6500000F`/`0x65000010`, turn-R/L→Turn `0x6500000D`/`0x6500000E`, idle→Ready `0x41000003`. Axes verified un-swapped (`camera.js:1402-1404`: W=+forward, D=+right, E=+right). Forward-dominant priority is sensible.
- **Sig-change gate** (`camera.js:1461-1462`) suppresses per-frame spam yet fires on every real intent change, including W-release→Ready (keyup `:1538`, onBlur `:1544` force the idle sig).
- **`setMotion` is idempotent** on `(cmd, stance)` — cacheKey includes both (`entities.js:4590,4610`).
- **Stance** via `em.getStance(g) || 0x8000003D` (NonCombat) exactly mirrors the jump dispatch contract (`index.html:8384-8389`).
- **Mirrors jump correctly** — jump lives at `index.html:8376-8412` (a one-shot overlay, distinct cmd `0x2500003B`); the two coexist.
- **No regression**: only the single local guid is touched (remotes still driven by `loop.js:1402-1411` KIND_MOTION); `setMotion` writes no pose, so `loop.js:1378`'s local KIND_POSITION skip keeps the wasm integrator the sole owner of local position.

**One genuinely uncertain item:** backstep dispatches WalkBackwards `0x45000006` for the *local visual clip* (correct — the server wire command goes separately via `setMovementInput` at `camera.js:1464`). Whether the live player MotionTable resolves a distinct backpedal cycle vs. falling through to fadeOut cannot be confirmed from code alone (needs the MT dump the deep-dive defers at `:1068`). Behaviorally harmless either way.

---

## 4. The velScale T1 next-step (doc step 2)

**The proposed plan is sufficient — and already landed in code. The minimal correct change to make "run no longer looks like a walk" is effectively merged; the only remaining action is the eye-test-gated flip of `VEL_SCALE_ON`.**

Full-run trace verified end-to-end at HEAD:
1. `camera.js:1509` dispatches `em.setMotion(0x50000007, RunForward 0x44000007, stance)`.
2. `setMotion` classifies it `'run'` and, under `VEL_SCALE_ON`, **stashes `inst._forwardCommand = 0x44000007` and `inst._forwardSpeed = inst._motionSpeed ?? 1.0` for the local guid** (`entities.js:4607-4608`). **This answers the doc's load-bearing open question directly: yes, the local guid feeds `stateGroundSpeed` non-zero forward state.**
3. The tick calls `_resolveStateGroundSpeed(inst)` (`entities.js:6989` → `4417-4442`), which reads `wasmExports.stateGroundSpeed(0x44000007, 1.0, 0, 0, run_rate)` → `4.0` (`lib.rs:4784`, `RUN_ANIM_SPEED=4.0`).
4. `cycleBaseSpeed=4.0` (`lib.rs:4701-4711`), so `cycleTimeScale(4.0,4.0)=1.0` (`animation.js:280`), applied **once** without `motionSpeed` re-multiply because `speedFromGetter` is true (`entities.js:7006-7008`).

**Prerequisites the doc asked to verify — all confirmed present at HEAD:**
- Getter + `playerRunRate` threaded into init3D opts: `index.html:1013/1020/1024` (import destructure) and `6662/6666/6670` (opts pass-through). *(Impl-handoff must-fix #1: resolved.)*
- `playerRunRate` is a **free** `#[wasm_bindgen]` export `player_run_rate_export()` at `lib.rs:25865`, consumed as a free fn `rrFn()` at `entities.js:4428-4431` — shapes match. *(Must-fix #2: resolved.)*
- No `forward_speed` double-count on the getter path (`entities.js:7007` ternary). *(Must-fix #3: resolved.)*

**Two real residual gaps (both minor, neither blocks the flip for the dominant forward case):**
- **Pure sidestep still rides the EMA.** `camera.js:1502-1503` dispatches SideStep as the *forward* command; `_resolveStateGroundSpeed` reads sidestep from `inst._sidestepCommand` (`entities.js:4421`), which only `setSidestepLayer` populates — so a camera-dispatched pure strafe makes the getter return null and falls back to EMA. Harmless (sidestep `|velocity|`≈0, `cycleTimeScale` no-ops), but a command-slotting inconsistency.
- **EMA-fallback branch retains an admitted-suspect `*motionSpeed` double-count** (`entities.js:7002-7005`), only reachable when the getter returns null.

**Net:** Reframe doc step 2 from "wire the getter" to "the getter path is implemented; run one targeted `?velScale=on` eye-test on the 1070, then flip the default at `entities.js:314`."

---

## 5. Run-vs-walk clip + deferred items + `4453d5a5` secondary fixes

**Run-vs-walk clip resolution — CORRECT.** `setMotion(RunForward 0x44000007)` builds a distinct cache slot via `AnimationCache.makeKey` (`entities.js:4590`; format `setupId:mtableId:motionCmd:stance` at `animation.js:377-378`) → wasm `motion_data_for_cycle` with `cycle_key` masked `& 0x00FF_FFFF` (`motion_table.rs:345`), so RunForward→`0x07` and WalkForward→`0x05` are distinct cycles → the actual RUN `0x03xxxxxx` Animation DID (`lib.rs:4930-4931`). RunForward never resolves a walk clip.

**Deferred items — all correctly scoped and reasonably deferred:**
- **MoveTo→RunForward hardcode** (`lib.rs:29603-29606`): the `MoveToParameters` bitfield (walk_run_threshold, distance) IS parsed (`motion.rs:332-340`) and merely unbound — a consumer-only gap. Low severity, affects only AI-pathed creature gait, never the player.
- **PhysicsScript DefaultScript** (`lib.rs:29185`): the wire field is a `PScriptType` enum per `acclient.h:33153`, currently passed raw to `fetchPhysicsScript` (`entities.js:2338`) which expects a `0x33` DID. Low severity (main PlayEffect/GetScript path already correct); note the test fixture `description.rs:1338` `Some(0x33000001)` is itself misleading.
- **Backward(-1) hooks dropped on reverse-baked segments**: `build_concatenated_motion_frames` (`lib.rs:4984-4990`) reverses frame *order* but not hook *direction*; `entities.js:7331` unconditionally drops `direction===-1`. This is genuinely *inverted* vs. retail `execute_hooks` for reverse segments. Low severity (~200/6419 hooks, mostly doors/levers), eye-test-gated.
- **T9 MotionState machine**: out of scope, scope-gate first — agreed.

**`4453d5a5` secondary fixes — both CORRECT and self-contained:**
- **#1 `resolve_did_degrade` multi-part guard** (`lib.rs:5502`): `if setup.parts.len() != 1 { return 0; }` preserves the frames↔parts invariant; the JS spawn LOD path routes through `fetch_entity_degrade_for_distance`, which honors the 0 return (`entities.js:1651`), so the guard fully mitigates the multi-part collapse. *(Coverage gap: no unit test was added despite the "headless-validatable" label — the guard is `cfg(test)`-reachable; a 2-part-returns-0 / 1-part-returns-degrade test would make the claim true.)*
- **#2 SoundTable uniform selection** (`sound_table_cache.js:228`): `Math.floor((entries.length-1)*this._rng())` is a bit-faithful port of retail `GetSound` (`acclient.c:383446`); `probability_` is correctly relegated to a separate caller-side playback gate (`entities.js:6114,7558`). *(Nit: `Math.random()`'s `[0,1)` vs retail `RollDice(0,1]` inclusive negligibly under-weights the last entry — within retail's own quirk territory.)*

---

## 6. Prioritized issues

| Sev | Title | Location | Recommendation |
|-----|-------|----------|----------------|
| **High** | Doc step 2 is stale: getter-substitution is already implemented & primary; real residual is the default-OFF flag + eye-test, not code | `docs/animation-handoff-codereview-2026-06-03.md:18,23` | Update lines 18 & 23: getter is primary (`entities.js:6989`), EMA is fallback (`:6992`), `_forwardCommand` is stashed for the local guid (`:4607-4608`), and threading/shape/double-count are all resolved (`index.html:6666/6670`, `lib.rs:25865`, `entities.js:7007`). Reframe residual as "eye-test, then flip `VEL_SCALE_ON` at `entities.js:314`." |
| **Low** | Sibling impl-handoff doc's 3 "must-fixes" + "baseSpeed chain unconsumed" are all resolved at HEAD; a reviewer reading both will be confused | `docs/animation-impl-t1-t8-handoff-2026-06-03.md:161-176` | Add a dated addendum marking must-fixes #1/#2/#3 and the step-2 kinematics wiring resolved (cite `index.html:6666/6670`, `lib.rs:25865`, `entities.js:7007`, `lib.rs:4708`). |
| **Low** | No unit test for the `resolve_did_degrade` multi-part guard despite "headless-validatable" label | `src/lib.rs:5468-5528` | Add a host test: 2-part SetupModel → returns 0; 1-part → returns `parts[0]` degrade. |
| **Low** | Pure-sidestep velScale rides the EMA — `camera.js` dispatches strafe as the forward command and never stashes `_sidestepCommand`/`_sidestepSpeed` the getter reads | `entities.js:4421`; `camera.js:1502-1503` | Either route strafe through `setSidestepLayer` so `_sidestepCommand` is set, or document that local-rig sidestep intentionally rides the (no-op) EMA. Not required before flipping for forward run/walk. |
| **Low** | Orbit-mode toggle leaves the rig frozen on the last loco clip (`_dispatchMovement` returns before the rig dispatch when `computeMovementFromKeys` is null) | `camera.js:1460` | Optional polish: dispatch Ready once on entering orbit. Cosmetic, pre-existing in spirit. |
| **Low** | Sig gate's `lastInputSig` advances only on `setMovementInput` success, so the rig dispatch is ungated in the harmless pre-EnteredWorld window | `camera.js:1465` | Optional: move `lastInputSig` assignment after the try/catch. Benign (local entity absent pre-world; `setMotion` idempotent). Leave as-is unless tightening. |
| **Nit** | Line-number drift in several doc anchors (1–19 lines), none material | `docs/…:31` | Optionally tighten: `VEL_SCALE_ON`=314, base gate=6969, EMA assign=6963 / fallback read=6992, KIND_MOTION `setMotion`=1238/1406, KIND_POSITION skip=1211/1378 (latter two already exact). |
| **Nit** | Loco dispatch silently swallows `getStance`/`setMotion` errors where jump logs them | `camera.js:1508` | Optional one-shot guarded warn (like the `_dispatchWarned` latch at `camera.js:1471`). Diagnostics nicety. |
| **Nit** | SoundTable uniform pick: `Math.random()` `[0,1)` slightly under-weights the last entry vs retail inclusive `RollDice` | `sound_table_cache.js:228` | No change; faithful to retail. Note only if an exact-distribution test is ever written. |

No blocker- or merge-stopping issues. `c18c158e` and `4453d5a5` are correct as shipped.

---

## 7. Recommended action plan

1. **Update the handoff doc (high priority, the one real correction).** Rewrite step 2 and the "Key facts" velScale bullets to reflect that the `stateGroundSpeed` getter is already primary (`entities.js:6989`), the EMA is a fallback (`:6992`), and `_forwardCommand`/`_forwardSpeed` are stashed for the local guid (`:4607-4608`). State that the only remaining gate for the run-vs-walk fix is the GPU eye-test, not plumbing.
2. **Add a dated addendum to `animation-impl-t1-t8-handoff-2026-06-03.md`** marking must-fixes #1/#2/#3 and the baseSpeed step-2 wiring as resolved at HEAD (anchors above), so the two docs no longer contradict.
3. **Merge `c18c158e` + `4453d5a5`** — both verified correct and regression-free.
4. **Run one targeted eye-test on the 1070 with `?velScale=on`** (the genuine residual): confirm a held-W run plays at `ts≈1.0` and no longer looks like a walk.
5. **If the eye-test passes, flip `VEL_SCALE_ON` default-on at `entities.js:314`.** If it fails, the EMA-fallback `*motionSpeed` double-count caveat (`entities.js:7002-7005`) is the first suspect to revisit.
6. **Add the cheap headless coverage** the secondary fix claimed: a `resolve_did_degrade` multi-part unit test (`lib.rs:5468-5528`).
7. **Defer (correctly scoped, eye-test-gated):** MoveTo walk/run gate (`lib.rs:29603`), PhysicsScript `PScriptType` resolution (`lib.rs:29185`), backward(-1) hook direction remap (`lib.rs:4984` + `entities.js:7331`), and the sidestep velScale axis (`entities.js:4421`). Scope-gate T9 before starting.

# WS02 — Final cast gesture (0x40 substate) parity + return-to-Ready

**Investigator:** WS02 (deep-investigator, GCE buildbox, 2026-07-12)
**Charter:** Trace what the SERVER echo of the class-0x40 final cast gesture does on the
LOCAL rig; fix double-play / restart / stuck-clamp; ensure a clean landing in Magic-stance
Ready after completion **and** cancel/fizzle. Derive the exact ACE windup/cast/finish wire
sequence from source.
**Confidence:** HIGH. Every hop is grounded in three sources (ACE reference source, our
Rust+JS, DAT bytes via the WB.Terminal oracle) and a passing pure-JS logic test.
**Baseline read:** `external/holtburger` working tree, `pkg/` as-shipped. All cites opened
live this session (line numbers re-verified against the foundation doc).

---

## 0. TL;DR

The final cast gesture (e.g. MagicBlast `0x4000002B`) is a **class-0x40 substate**. ACE puts
it in the wire `forward_command` slot and echoes it back to the caster
(`EnqueueBroadcast(sendSelf=true)`). Because `is_action_motion_command` returns **false** for
the magic-gesture band (`0x1E..0x39`), the Rust filter (`lib.rs:40930-40933`) does **NOT**
divert it to `KIND_MOTION_ACTION` (where the swing-echo dedup lives). It rides
**`KIND_MOTION`** as the locomotion `motion_command`. On the local player it passes
`FORCE_MOTION_LOCAL` → `em.setMotion(local, 0x2B, Magic)` → `_tryPlayLink` → (UNIFIED_CAST
default-on) a Rust `_unifiedSeq` one-shot that the tick poses **exclusively** (suppressing the
mixer). Meanwhile `playCastSequence` **already predicted** the same gesture as a mixer `swing:`
overlay. Result: the cast gesture **double-plays / restarts ~RTT late**, and the echo's replay
leaves a **clamped/half-blended final frame**. Windups don't have this bug — they are class
0x10 (Action) so they DO get diverted to `KIND_MOTION_ACTION` and are deduped.

The FinishCast **Ready** echo (`forward_command=0x0003`) is a gait-locomotion command
(`isLocalGaitLocomotionCmd`→true) so it is **skipped for the local player** — the return to
Ready relies entirely on the client-side `_swingRestoreTimer`, which fires at the *un-scaled*
`dur` while the clip plays at `2×`, holding the clamped frame ~`dur/2` too long.

**Fix (JS-only, no wasm rebuild):** (1) dedup the local player's own cast-gesture `KIND_MOTION`
echo via the existing `consumeLocalSwingEcho` (expanding the raw low16 to the full key the
chain noted); (2) make the swing/cast Ready-restore timer respect the effective playback speed
so the return happens when the clip actually finishes. Both under `?castGestureParity` (default
ON, `=off` = byte-identical rollback). Remote casters are untouched.

---

## 1. VERIFIED FINDINGS

### 1.1 ACE wire sequence — derived from source (the exact windup/cast/finish messages)

`FastTick => IsPKType` and `IsPKType => PlayerKillerStatus == PK || PKLite`
(`Player_Tick.cs:154`; `Player_Combat.cs` — decomp symbol `n`). **Our vanilla test char is
non-PK ⇒ `FastTick=false` ⇒ the NON-FastTick path is live.** Both paths, however, agree on the
key fact: the **cast gesture always lands in `ForwardCommand`**.

**Windup gestures** — `Player_Magic.cs:605-646 DoWindupGestures`:
- non-FastTick (live): `windupTime = EnqueueMotionMagic(castChain, windupGesture, CastSpeed)`
  per gesture (`:636`). `EnqueueMotionMagic` builds `new Motion(MotionStance.Magic,
  motionCommand, speed)` → gesture is the **ForwardCommand** (`WorldObject_Networking.cs:1080`),
  broadcast only `if (player.MagicState.IsCasting)` (`:1085-1089`).
- FastTick: `EnqueueMotionAction(castChain, spell.Formula.WindupGestures, CastSpeed,
  MotionStance.Magic, checkCasting:true)` (`:645`). `EnqueueMotionAction` builds `new
  Motion(stance, MotionCommand.Ready, speed)` then `motion.MotionState.AddCommand(...)` per
  gesture (`:1235-1238`) → gestures go in the **Commands (action) list**, ForwardCommand=Ready.

**Cast gesture** — `Player_Magic.cs:648-689 DoCastGesture`, `MagicState.CastGesture =
spell.Formula.CastGesture` (`:650`):
- non-FastTick (live): `castTime = EnqueueMotionMagic(castChain, MagicState.CastGesture,
  CastSpeed)` (`:685`) → cast gesture is the **ForwardCommand**.
- FastTick: `EnqueueMotion(castChain, MagicState.CastGesture, CastSpeed, true, null, true)`
  (`:683`); `EnqueueMotion` with `castGesture=true` forces `stance = MotionStance.Magic` and
  `new Motion(stance, motionCommand, speed)` → still **ForwardCommand**
  (`WorldObject_Networking.cs:1095-1120`).

**Finish** — `Player_Magic.cs:935-991 FinishCast`:
- non-FastTick (live): `EnqueueBroadcastMotion(new Motion(MotionStance.Magic,
  MotionCommand.Ready, 1.0f))` immediately (`:978-979`), then `AddDelaySeconds(1.0f)` →
  `SendUseDoneEvent()` (`:982-986`). So **Ready is broadcast right after the cast gesture's
  own anim length**, and UseDone lands ~1.0s later (the recoil).
- FastTick: `EnqueueMotion(actionChain, MotionCommand.Ready, 1.0f, true, castGesture, false,
  fastbuff)` (`:960`).

**Self-inclusion (decisive):** `EnqueueBroadcastMotion` → `EnqueueBroadcast(msg)` →
`EnqueueBroadcast(bool sendSelf=true, …)` which does `self.Session.Network.EnqueueSend(msgs)`
(`WorldObject_Networking.cs:1418-1432`; range variant `:1380-1385` also sends to self). **The
caster receives its own windup/cast/Ready UpdateMotions.** This is the same path that makes
`@animation Sitting` play on the local avatar — a forced `Motion` via `EnqueueBroadcastMotion`
(foundation §1.4 "1070 eye-test PASSED 2026-06-10", loop.js:199-201).

> Net live sequence to the caster (non-PK): `UpdateMotion(fwd=MagicPowerUpNN)` ×windups →
> `UpdateMotion(fwd=CastGesture)` → `UpdateMotion(fwd=Ready)`. All are server-authored
> (`is_autonomous=false`; foundation loop.js:183-193, ACE `MovementData.cs:20`).

### 1.2 Our Rust classifier proves the cast gesture is NOT an action → it rides KIND_MOTION

`is_action_motion_command` (`crates/holtburger-world/src/player/types.rs:367-387`):
```rust
0x4000_0000 => matches!(full & 0x0000_FFFF, 0x0016..=0x001D | 0x00D3 | 0x00E0 | 0x00E1),
```
- Cast gesture MagicBlast `0x4000002B`: class `0x40`, low16 `0x2B` ∉ that set ⇒ **false**.
- Windup MagicPowerUp01 `0x1000006F`: class `0x10` ⇒ **true** (first arm, `:370`).

Consequences:
- `lib.rs:40906-40934` filters `forward_command` ONLY when
  `expand_motion_command_low16(raw).is_some_and(is_action_motion_command)` (`:40930-40933`).
  Cast gesture → `is_action`=false ⇒ `!false=true` ⇒ **KEPT** as `motion_command_u16 = 0x2B`
  and emitted as `KIND_MOTION` (`lib.rs:41100,41130 motion_command: u32::from(motion_command_u16)`
  — the **raw low16 `0x2B`**, un-expanded).
- `EntityMotionSnapshot::from_movement_event` surfaces `KIND_MOTION_ACTION` from
  `forward_command` ONLY when `is_action_motion_command(full)` (`entity.rs:184-186`). Cast
  gesture ⇒ false ⇒ **no KIND_MOTION_ACTION**. Windups ⇒ true ⇒ KIND_MOTION_ACTION (the
  deduped path).

**So: windups → `KIND_MOTION_ACTION` (deduped). Cast gesture → `KIND_MOTION` (NOT deduped).**
Confirmed the charter's premise verbatim.

### 1.3 DAT ground truth (WB.Terminal oracle, player MT `0x09000001`)

`MotionStance.Magic = 0x80000049` (`ACE.Entity/Enum/MotionStance.cs:23`) → low16 `0x0049`
(matches foundation index.html:2855).

Oracle dump `chorizite-parse-dat-record … 0x09000001 MotionTable`:
- **[CORRECTED per VERDICT mustFix #1 — re-derived from the oracle this session]** The
  `links` map is keyed `links[(stanceLo8 << 16) | TARGET_cmdLo16][fromCmd_FULL32 = 0x41000003
  Ready] = node`, i.e. there is a **separate outer key per target gesture**, not one
  `0x490003` bucket. For Magic (stance `0x49`) the present outer keys are
  `0x490003` (Ready), the cast-gesture band **`0x49002B..0x490039`** (MagicBlast..MagicPray —
  independently confirmed present), an unused-by-any-spell `0x490136..0x490139` set, plus
  eat/drink/castspell/wand (`0x4900d3/0x4900e0/0x4900e1`) and a few locomotion targets. The
  war windups `MagicPowerUp01..10` (`0x49006F..0x490078`) and the colored windups
  (`0x49011F..0x490134`) are **NOT present in the Magic-stance links at all** (oracle-verified
  absent) — they resolve via the style-default (Ready) path. The two conclusions the fix
  rests on are UNAFFECTED and re-confirmed: the cast-gesture clip **IS resolvable** (outer key
  `0x49002B` exists → the double play is genuinely visible) and the Magic-Ready **idle cycle
  exists** (see next bullet → clean return target). NB: the original inverted phrasing here
  ("outer key `0x490003` … hosts windups+casts as inner keys") is inherited from FOUNDATION
  §1.3 line 84 ("links[(stance,Ready)][fullCmd]") — flag upstream.
- **`cycles` key format `(stanceLo16<<16)|cmdLo16`; `0x490003` (Magic-Ready idle) EXISTS.**
  So `setMotion(Ready, Magic)` lands on a real Magic-stance idle — no "idle-pose drop" from a
  missing cycle.
- Magic-stance cycles also include `0x49002B..0x490039` (the magic gestures as **held
  substate cycles**) — i.e. retail's substate model is "transition link + held substate
  cycle", matching `RawMotionState::ApplyMotion` (acclient.c:332855-332920, foundation §2.2).
  Our client approximates the held cycle with the link clip's clamped final frame.

`data/spell-cast-sequence.json` (6,266 spells) confirms the JSON stores gestures as **full
32-bit** commands:
- **Every** `castGesture.motion` is class `0x40` with low16 ∈ **`{0x2B..0x39}`** (14 distinct
  values; e.g. `0x40000031` MagicHeal, `0x40000033` MagicRecoilMissile).
- **Every** windup is class `0x10` with low16 ∈ `{0x70,0x72,0x74,0x76,0x78,0x132}` — `0x132`
  is `MagicPowerUp08Purple`, i.e. **void spells use colored powerups that are still class
  0x10 (Action)** → deduped exactly like war windups. No cast gesture and no windup overlap.

### 1.4 The LOCAL rig double-drives the cast gesture (no dedup)

`loop.js` recv dispatch: `kind===KIND_MOTION → _armMotion` (`:2708-2709`);
`KIND_MOTION_ACTION → _armMotionAction` (`:2710-2711`).

`_armMotion` (`loop.js:2528-2564`):
```js
const forceLocal = FORCE_MOTION_LOCAL_ON && !isAuto && !isLocalGaitLocomotionCmd(motionCmd);
if (forceLocal || !isLocalPlayerGuid(motionGuid)) { em.setMotion(motionGuid, motionCmd, st, …); }
else if (st !== 0) { em.setLocalStance(motionGuid, st); }
```
- `FORCE_MOTION_LOCAL_ON = true` (hardcoded, `loop.js:202`).
- cast gesture echo: `isAuto=false` (server-forced), `isLocalGaitLocomotionCmd(0x2B)` →
  `0x2B ∉ _LOCAL_GAIT_LOCOMOTION_LOWS` ⇒ **false** (`loop.js:218-230`). ⇒ **forceLocal=true**
  ⇒ `em.setMotion(local, 0x2B, Magic)` fires on the local rig.
- `setMotion` classifies `0x2B` → `cast` (`CAST_COMMANDS`, `entities.js:2141`) → `_tryPlayLink(
  inst, …, READY_SUBSTATE, 0x4000002B, Magic)` and returns (`entities.js:7819-7853`).
- `_tryPlayLink` with **UNIFIED_CAST default-on** (`entities.js:633`, `UNIFIED_DEFAULT`) builds a
  Rust `_unifiedSeq` one-shot (`clearOnDone:true`) and returns before the mixer overlay
  (`entities.js:9632-9659`). The tick poses `_unifiedSeq` **exclusively, suppressing the
  mixer, for the local guid too** (no local-guid guard; verified in `EntityManager.tick`
  `entities.js:~12010-12036`).

Meanwhile `playCastSequence` (`entities.js:6728-6912`) already played that same cast gesture
via `setSwingMotion` → a mixer `swing:` overlay (`LoopOnce`, `clampWhenFinished=true`,
`entities.js:7220-7252`) at click time.

**There is NO dedup on the `KIND_MOTION` path.** The swing-echo dedup
(`noteLocalSwingPrediction`/`consumeLocalSwingEcho`, `entities.js:6619-6637`) is wired ONLY into
`_armMotionAction` (`loop.js:2605-2606`). The chain DOES note the cast-gesture prediction
(`entities.js:6812`, when `CAST_SPEED !== 1.0`; default 2.0) — but nothing consumes it on the
`KIND_MOTION` path. Additionally, the note stores the **full** command (`0x40000035`) while
`KIND_MOTION` delivers the **raw low16** (`0x35`), so even a naive consume would miss without
expansion.

### 1.5 Return-to-Ready relies on a client timer that over-holds the clamp

- FinishCast Ready echo → `KIND_MOTION` `motion_command=0x0003`. `isLocalGaitLocomotionCmd(
  0x0003)` → `0x0003 ∈ _LOCAL_GAIT_LOCOMOTION_LOWS` ⇒ **true** ⇒ `forceLocal=false` ⇒ for the
  local player it hits `else if (st!==0) em.setLocalStance(Magic)` (`loop.js:2558-2563`). **The
  server Ready does NOT drive the local rig's motion_command** — only the stance.
- So the local return is the client `_swingRestoreTimer` (`entities.js:7325-7334`):
  `restoreDelayMs = max(80, round(dur*1000))` then `setMotion(g, CMD_LOW_READY, stance)`. But
  the clip plays at `swingSpeed = _motionSpeed * opts.speed = 2.0` (`entities.js:7243-7246`),
  finishing at `dur/2` real seconds. The timer fires at `dur`, so the clamped final frame is
  held ~`dur/2` (~0.3–0.5s) **too long**, and during `(dur/2, dur)` the restored base cycle
  (Magic-Ready idle) blends ~50/50 with the clamped cast pose (`_suppressBaseCycleForOverlay`
  restores the base at clip-finish, `entities.js:9831-9869`). Retail returns to Ready ~one
  cast-gesture-length after the gesture starts (`FinishCast` broadcasts Ready right after the
  cast gesture's own `EnqueueMotionMagic` anim length, §1.1).

### 1.6 Fizzle / cancel path

`cancelCastSequence` (`entities.js:6927-6939`) bumps `_castSequenceToken`, clears
`_castBusyUntilMs`, and `setMotion(guid, 0x0003, stance)` → crossfades to Magic-Ready (stops
the clamped overlay; `crossFadeTo` stops `currentAction`). ACE fizzle still runs the full
gesture chain + FinishCast (fizzle is decided at spell resolution, after the cast gesture), so
the caster still receives the **cast-gesture echo** around fizzle time. **Without the fix**,
that echo replays the cast gesture *after* the fizzle recoil already set Ready — the rig jerks
back into the cast pose. **With the fix** (§3) the echo is swallowed, so the fizzle lands in
Ready cleanly with no extra patch.

---

## 2. ROOT CAUSES

| # | Symptom (charter) | Mechanism (proven) |
|---|---|---|
| RC1 | **double-play / restart** of the final cast gesture on the local rig | The 0x40 cast-gesture substate is not action-class (`is_action_motion_command`=false, `types.rs:384`), so it is not diverted to the deduped `KIND_MOTION_ACTION` path (`entity.rs:184-186`, `lib.rs:40930-40933`). It rides `KIND_MOTION`, hits `forceLocal` (`loop.js:2546-2557`, FORCE_MOTION_LOCAL_ON=true), and `setMotion`→`_tryPlayLink`→`_unifiedSeq` (UNIFIED_CAST default-on, `entities.js:9632-9659`) **replays** the gesture `playCastSequence` already predicted — with **no dedup** on this path. §1.2, §1.4. |
| RC2 | **stuck / clamped final frame** | Two independent overlays for one gesture: the chain's mixer `swing:` clamp (`entities.js:7233`) and the echo's `_unifiedSeq` (poses exclusively then `clearOnDone` hands back to the still-clamped mixer). Even single-play, the Ready-restore timer over-holds the clamp by `dur/2` and blends against the restored base. §1.4, §1.5. |
| RC3 | **doesn't land in Magic-Ready cleanly after complete/cancel** | FinishCast's server Ready is skipped for the local player (gait-locomotion command, `loop.js:2558-2563`); return depends on the client timer whose delay ignores playback speed (`entities.js:7325-7328`). Fizzle adds a post-recoil echo replay (RC1). §1.5, §1.6. |

DAT-proven guardrails: the Magic-Ready **idle cycle exists** (`cycles[0x490003]`), so
`setMotion(Ready)` cannot drop to rest pose; the fix's return target is real (§1.3).

---

## 3. PATCH PLAN

**Disposition:** JS-only, **no wasm rebuild**. One flag `?castGestureParity` (default **ON**,
`=off` = byte-identical rollback). Correctness fixes grounded in retail behavior; a 1070
eye-test is queued (§5) to confirm the visual before the integration owner locks default-ON.
Remote casters are untouched (local-guid-gated). Reuses the existing dedup machinery.

### Patch A — `scene3d/loop.js`: flag + magic-gesture predicate (near `isLocalGaitLocomotionCmd`, ~L218-230)

```diff
 const _LOCAL_GAIT_LOCOMOTION_LOWS = new Set([
   0x0003, 0x0004, 0x0005, 0x0006, 0x0007, 0x0008,
   0x000d, 0x000e, 0x000f, 0x0010, 0x0015,
 ]);
 function isLocalGaitLocomotionCmd(cmd) {
   // ...unchanged...
   const low = (cmd >>> 0) & 0xffff;
   if (low === 0) return true;
   return _LOCAL_GAIT_LOCOMOTION_LOWS.has(low);
 }
+
+// WS02 (2026-07-12) — `?castGestureParity` (default ON, `=off` = byte-identical).
+// The FINAL cast GESTURE is a class-0x40 magic substate (MagicBlast..MagicPray,
+// low16 0x2B..0x39; ACE puts it in the wire forward_command slot,
+// Player_Magic.cs:685 / WorldObject_Networking.cs:1080). It is NOT action-class
+// (is_action_motion_command=false, types.rs:384), so lib.rs:40930-40933 does NOT
+// divert it to KIND_MOTION_ACTION — it rides KIND_MOTION as the locomotion
+// motion_command and (server-forced ⇒ !isAuto) reaches the local rig via
+// forceLocal. But playCastSequence ALREADY predicts that gesture
+// (entities.js:6811 setSwingMotion) and notes it (entities.js:6812
+// noteLocalSwingPrediction), so the echo is a redundant SECOND play with NO
+// dedup (the swing-echo dedup only runs on the KIND_MOTION_ACTION path used by
+// the windups). Consume the note here to swallow the local echo. Remote casters
+// are untouched (they need the echo to animate). Empirically the band 0x2B..0x39
+// covers EVERY cast gesture and NO windup across all 6,266 spells
+// (test_ws02_cast_echo_dedup.mjs T6).
+const CAST_GESTURE_PARITY_ON = (() => {
+  try {
+    if (typeof window === "undefined" || !window.location) return false;
+    return (
+      new URLSearchParams(window.location.search).get("castGestureParity")?.toLowerCase() !== "off"
+    );
+  } catch (_) {
+    return true; // non-browser (headless source-eval harness): default ON
+  }
+})();
+// Magic cast-gesture substate low-16 band (MagicBlast 0x2B .. MagicPray 0x39).
+function isLocalPredictedCastGestureLow(low) { return low >= 0x2b && low <= 0x39; }
```
> Note the non-browser branch returns `true` (default-on) to match the source-eval headless
> harness convention used elsewhere; a `?castGestureParity=off` still forces off in-browser.

### Patch B — `scene3d/loop.js`: dedup the local cast-gesture echo in `_armMotion` (~L2541, after `isAuto`)

```diff
   const isAuto = !!upd.isAutonomous;
+  // WS02: swallow the LOCAL player's own cast-gesture KIND_MOTION echo — the
+  // client already predicted it (playCastSequence). See CAST_GESTURE_PARITY_ON.
+  if (CAST_GESTURE_PARITY_ON && isLocalPlayerGuid(motionGuid)) {
+    const low = motionCmd & 0xffff;
+    if (isLocalPredictedCastGestureLow(low)) {
+      // KIND_MOTION delivers the raw low16; the chain noted the FULL 0x40-class
+      // command — expand to match (types.rs:130 same mapping).
+      const fullGesture = (0x40000000 | low) >>> 0;
+      if (em.consumeLocalSwingEcho?.(motionGuid, fullGesture)) {
+        // Predicted → drop the redundant echo (no double-play/restart/clamp).
+        // Keep the server stance authoritative like the skip-branch below.
+        if (st !== 0) em.setLocalStance?.(motionGuid, st);
+        return;
+      }
+      // No prediction (playCastSequence early-returned: table-not-loaded first
+      // frame / F8-4 busy window) → fall through so the echo is the single
+      // animation source. Fail-open, never silent.
+    }
+  }
   // FORCE_MOTION_LOCAL (B5#2 + SG-B): when ON, a server-FORCED
   const forceLocal =
     FORCE_MOTION_LOCAL_ON &&
     !isAuto &&
     !isLocalGaitLocomotionCmd(motionCmd);
```

### Patch C — `scene3d/entities.js`: Ready-restore timer respects playback speed (~L7324-7328)

```diff
     } else {
+      // WS02: the clip plays at `swingSpeed` (CAST_SPEED=2.0 for casts, L7243),
+      // so it FINISHES at dur/swingSpeed real seconds. Restoring at the
+      // un-scaled `dur` held the clamped final cast frame ~dur/2 too long (a
+      // mushy half-blend vs the restored base once the clip ended). Divide by
+      // the effective speed so Ready-restore fires when the clip actually ends
+      // (retail returns to Ready ~one cast-gesture-length after the gesture
+      // starts, FinishCast Player_Magic.cs:978). Melee (swingSpeed=1.0) is
+      // byte-identical. Gated with the same flag for one-toggle rollback.
+      const _effSpeed = (CAST_GESTURE_PARITY_ON && Number.isFinite(swingSpeed) && swingSpeed > 0)
+        ? swingSpeed : 1.0;
       const restoreDelayMs = Math.max(
         80,
-        Math.round(((Number.isFinite(dur) && dur > 0) ? dur : (clip.duration || 0.4)) * 1000),
+        Math.round((((Number.isFinite(dur) && dur > 0) ? dur : (clip.duration || 0.4)) * 1000) / _effSpeed),
       );
       inst._swingRestoreTimer = setTimeout(() => {
```
> `entities.js` needs the same `CAST_GESTURE_PARITY_ON` flag read (add the identical IIFE near
> the other entities.js flags, e.g. beside `HOOK_DRAIN_ON` ~L1157, and reference it here). If
> the integration owner prefers to keep entities.js flag-free, Patch C can drop the flag guard
> and always divide by `swingSpeed` — melee stays byte-identical (speed 1.0) and only cast
> timing changes, which is the intended correctness fix.

### `docs/url-flags.md` — new row (drafted)

```
| `castGestureParity` | on | Final cast-gesture (0x40 substate) parity + clean return-to-Ready. The final cast gesture rides KIND_MOTION (not the deduped KIND_MOTION_ACTION path, because is_action_motion_command=false for the 0x2B..0x39 magic band), so the server echo re-plays the gesture playCastSequence already predicted → double-play/restart + over-held clamped final frame. `on`: swallow the LOCAL player's own cast-gesture echo (consumeLocalSwingEcho, loop.js _armMotion) and scale the Ready-restore timer by playback speed (entities.js). `off`: byte-identical prior behavior. Local-only; remote casters unchanged. Refs: Player_Magic.cs:685/978, WorldObject_Networking.cs:1080/1418, types.rs:367-387, lib.rs:40906-40934, entities.js:6619-6637/7325. | Cast a multi-windup war bolt standing still: arms rise once, the final throw plays once, rig settles to Magic-Ready with no second twitch and no held final frame. Compare `=off`: a second cast-gesture twitch ~RTT after the throw and a ~0.3-0.5s held final pose. |
```

### Considered and rejected
- **Rust-side fix** (divert the 0x40 magic band to `KIND_MOTION_ACTION` so it inherits the
  existing dedup, or special-case the local guid in `lib.rs:40906-40934`): needs a wasm
  rebuild, changes remote surfacing semantics, and touches the C1/B9 gait-regression guard in
  `entity.rs`/`types.rs`. Higher blast radius for no extra benefit — the JS dedup already
  exists and is local-scoped. Rejected in favor of Patches A/B.
- **Let the FinishCast Ready echo drive the local return** (retail-exact): would require
  passing a Ready `KIND_MOTION` through `forceLocal` for the local player, which fights the B9
  gait predictor (the predictor also issues Ready when idle). Too risky for an improvement
  pass; the client restore timer (Patch C) is the minimal, safe path.

---

## 4. TESTS

### 4.1 Pure-JS logic test (written + PASSING on this box)

`test_ws02_cast_echo_dedup.mjs` (delivered below; run from anywhere with the repo reachable, or
copy `data/spell-cast-sequence.json` beside it). Validates, in isolation:
- **T1** predicted cast-gesture echo is deduped → **0** redundant `setMotion` (no double-play),
  stance kept.
- **T2** un-predicted gesture (busy-window/table-miss) falls through → echo plays (single-play
  fallback, never silent).
- **T3** remote guid never gated.
- **T4** windups (`0x70/0x78`) + locomotion (`0x03/0x04/0x07`) excluded from the band.
- **T5** low16→full expansion matches the JSON's stored full commands.
- **T6** the band `[0x2B,0x39]` covers **every** cast gesture and **no** windup across the
  real `data/spell-cast-sequence.json` (6,255 casts / 7,248 windups scanned).

Observed result on the buildbox: **ALL PASS**.

```js
// test_ws02_cast_echo_dedup.mjs — run: node test_ws02_cast_echo_dedup.mjs
// (full source in the packet dir sibling / reproduced from WS02 scratch; replicates
//  entities.js:6619-6637 note/consume + the Patch-B gate, and asserts against the real JSON.)
```
> Full source lives at `~/spellcast-fanout/test_ws02_cast_echo_dedup.mjs` on the buildbox and
> should be committed as `apps/holtburger-web/test_ws02_cast_echo_dedup.mjs` on the laptop.
> It has no three.js/WebGL dependency (mirrors the existing `test_ac_*.mjs` data-level style).

### 4.2 Existing test to keep green
`node test_ac_cast_over_locomotion.mjs` — the DAT-level assertion that Magic-stance cast+walk
layers coexist. Unaffected by Patches A/B/C (they only change local echo handling / restore
timing, not the data shape). Re-run after integration.

### 4.3 TODO-FOR-LAPTOP — headless double-play capture recipe

No live ACE / browser on this box. On the laptop:

1. `python3 external/holtburger/scripts/serve.py` → :8765.
2. Baseline (flag OFF, reproduce the bug):
   `http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&renderOnDemand=1&netDrainHz=30&autoLogin=1&account=X&password=X&autoSpawn=first&kickDance=1&agent=1&castGestureParity=off`
   - Poll `window.__bootState==='in-world'`.
   - Instrument the double-play directly (no GPU needed):
     ```js
     // count local cast-gesture plays: chain (setSwingMotion) vs echo (_tryPlayLink)
     window.__ws02 = { swing: 0, link: 0 };
     const em = window.__entityManager /* or scene handle */;
     const g = window.__localPlayerGuid >>> 0;
     const _sm = em.setSwingMotion.bind(em);
     em.setSwingMotion = (guid, cmd, opts) => {
       if ((guid>>>0)===g && ((cmd&0xffff)>=0x2b && (cmd&0xffff)<=0x39)) window.__ws02.swing++;
       return _sm(guid, cmd, opts);
     };
     const _tpl = em._tryPlayLink.bind(em);
     em._tryPlayLink = (inst, s, m, from, to, st, o) => {
       if ((inst.guid>>>0)===g && ((to&0xffff)>=0x2b && (to&0xffff)<=0x39)) window.__ws02.link++;
       return _tpl(inst, s, m, from, to, st, o);
     };
     ```
   - Cast a war bolt with windups (LSD known-good, foundation §5). Expect **`swing===1` and
     `link>=1`** (the echo double-play) with `castGestureParity=off`.
3. Fixed (flag ON, default): reload without `&castGestureParity=off`. Expect **`swing===1` and
   `link===0`** (echo swallowed). Console: no `[motion-link] … → 4000002b/…` line for the
   local guid; the `consumeLocalSwingEcho` swallow path taken.
4. Return-to-Ready timing: log `performance.now()` at the cast-gesture `setSwingMotion` and at
   the `_swingRestoreTimer` `setMotion(Ready)` fire; with the fix the delta ≈ `dur/2` (clip
   length at 2×), not `dur`.
5. Fizzle path: force a fizzle (low mana / missing component) and confirm no post-recoil cast
   twitch and a clean Magic-Ready landing (flag on vs off).
6. Acceptance: bare-default URL (no WS02 flag) loads, spawns, casts, **0 console errors**, and
   `?castGestureParity=off` is byte-identical to pre-patch.

---

## 5. EYE-TEST QUEUE (1070 GPU box — batched, do NOT run here)

| Flag combo | Spell | Expected visual |
|---|---|---|
| default (all on) | 3-windup war bolt, standing still | Arms rise through the windups, the final throw plays **once**, rig settles to Magic-Ready idle — **no** second cast twitch ~RTT later, **no** frozen/held final frame. |
| `?castGestureParity=off` | same | The old behavior: a second cast-gesture play/restart shortly after the throw, and the final cast pose held ~0.3-0.5s before snapping to idle (A/B comparison confirms the fix). |
| default | Wedding Bliss 1708 (3-windup self chain) | Full self-cast chain plays once; clean return to Magic-Ready; useful because it's the established slideCast validation spell. |
| default | void spell (colored powerup, low16 0x132) on a void-trained char | Void windups (class 0x10) still animate + dedup normally; final void gesture plays once and returns clean (confirms the colored-powerup band is unaffected). |
| default | fizzle a war bolt (drain mana) | Windup/throw, then fizzle recoil to Magic-Ready with **no** post-recoil cast twitch. |
| default | cast then immediately move (tap W at the throw) | Movement cleanly takes over (locomotion), no lingering clamped cast pose. |

---

## 6. RISKS + INTERACTIONS

**Files this workstream would touch:**
- `scene3d/loop.js` — Patches A + B (flag, predicate, `_armMotion` dedup). **Primary.**
- `scene3d/entities.js` — Patch C (Ready-restore timer speed scaling; + optional flag read).
- `docs/url-flags.md` — new `castGestureParity` row.
- `apps/holtburger-web/test_ws02_cast_echo_dedup.mjs` — new test (add on laptop).
- **No `src/lib.rs` / Rust change ⇒ no wasm rebuild.**

**Risks (all low, all flag-reversible):**
- R1: If a local cast is NOT predicted (F8-4 busy window early-return `entities.js:6766`, or
  first-frame table-miss `getCastSequence`=null `entities.js:6744`), Patch B falls through and
  the echo plays as the single source — **desired** (no silent gesture loss). Covered by test
  T2.
- R2: `noteLocalSwingPrediction` is only called when `CAST_SPEED !== 1.0` (`entities.js:6812`).
  Default `CAST_SPEED=2.0`, so notes are made and dedup works. If someone forces `CAST_SPEED=1.0`
  the note isn't made ⇒ Patch B falls through ⇒ echo plays (double-play returns at that non-default
  setting). Optional hardening: drop the `CAST_SPEED !== 1.0` guard at `entities.js:6812` so the
  note is unconditional — but that also changes windup dedup at speed 1.0; left out to keep the
  change minimal. Flagged for the integration owner.
- R3: Patch C changes cast return timing for **every** swing/cast that runs at speed≠1.0. Melee
  (`swingSpeed=1.0`) is byte-identical; hasted attacks return slightly sooner (more correct).
  Behind the flag.
- R4: The magic band `0x2B..0x39` is DAT-proven exhaustive over all 6,266 spells and disjoint
  from windups (T6). If a future spell-cast-sequence regen introduced a cast gesture outside
  that band, T6 would fail — the test is the guardrail.

**Cross-workstream interactions (order integration so these don't collide):**
- **Any WS editing `loop.js` `_armMotion` / KIND_MOTION dispatch / `forceLocal`** (movement WSs,
  `forceMotionLocal`, `slideCast`/`castMove` follow-ups): Patch B inserts a new early-return at
  the top of `_armMotion`. Coordinate the insertion point.
- **WS editing `playCastSequence` / `noteLocalSwingPrediction` / `setSwingMotion`** (windup WS,
  recast/queue WS08/WS14, CAST_SPEED WS): Patch B depends on the chain's `noteLocalSwingPrediction`
  (`entities.js:6812`) and Patch C on `swingSpeed` (`entities.js:7243`). If those move, re-verify.
- **Remote-caster WS06/WS07:** my change is local-guid-gated; remote cast gestures keep flowing
  through the unchanged `KIND_MOTION`→`_tryPlayLink`→`_unifiedSeq` path. No overlap, but they
  share the same `_armMotion` function — merge carefully.
- **Any WS touching the Rust `is_action_motion_command` / `expand_motion_command_low16` /
  `lib.rs:40906-40934` filter:** if the cast gesture's wire-surfacing (KIND_MOTION vs
  KIND_MOTION_ACTION) changes, Patch B's premise changes — re-coordinate (Patch B assumes the
  cast gesture arrives as `KIND_MOTION` with a raw low16).
- **`UNIFIED_CAST` / `unifiedMotion` WS:** the double-play visibility is amplified by UNIFIED_CAST
  (default-on) posing `_unifiedSeq` exclusively. The dedup (Patch B) fixes it regardless of the
  unified flag state (it prevents the echo from ever reaching `setMotion`).

---

## 7. Reproduction of the delivered test source

`test_ws02_cast_echo_dedup.mjs` (buildbox `~/spellcast-fanout/`), verified PASS:

- Replicates `entities.js:6619-6637` (`noteLocalSwingPrediction`/`consumeLocalSwingEcho`) and
  the Patch-B gate, then asserts T1–T6 above, including a scan of the real
  `data/spell-cast-sequence.json`. No browser/WebGL. Copy into `apps/holtburger-web/` on the
  laptop and wire into the JS test set.

```
T1 predicted cast-gesture echo is deduped ....... PASS (0 redundant setMotion)
T2 un-predicted gesture still plays .............. PASS
T3 remote caster echo never touched .............. PASS
T4 windups + locomotion excluded from band ....... PASS
T5 low16→full expansion ........................... PASS
T6 band covers all casts / no windups (real JSON)  PASS (6255 casts / 7248 windups)
ALL PASS
```

---

```json
{"workstream":"WS02","title":"Final cast gesture (0x40 substate) parity + return-to-Ready","packetPath":"/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/docs/spellcasting-packets-2026-07-12/WS02-cast-substate-parity.md","confidence":"high","keyFindings":["The final cast gesture is a class-0x40 substate (MagicBlast..MagicPray, low16 0x2B..0x39). ACE puts it in wire forward_command (Player_Magic.cs:685) and echoes to the caster (EnqueueBroadcast sendSelf=true, WorldObject_Networking.cs:1418).","is_action_motion_command returns false for 0x2B..0x39 (types.rs:384), so lib.rs:40930-40933 does NOT divert the cast gesture to the deduped KIND_MOTION_ACTION path — it rides KIND_MOTION with a raw low16, unlike windups (class 0x10, deduped).","On the local rig the cast-gesture echo passes forceLocal (FORCE_MOTION_LOCAL_ON=true, loop.js:202) and setMotion->_tryPlayLink->_unifiedSeq (UNIFIED_CAST default-on) REPLAYS the gesture playCastSequence already predicted, with NO dedup on the KIND_MOTION path => double-play/restart/clamp.","FinishCast Ready is a gait-locomotion cmd (0x0003) so it is skipped for the local player (loop.js:2558-2563); return-to-Ready relies on the client _swingRestoreTimer which uses un-scaled dur while the clip plays at 2x, over-holding the clamped final frame ~dur/2.","DAT oracle (re-derived this session) confirms player MT 0x09000001 links are keyed links[(stance<<16)|TARGET_cmd][fromCmd=0x41000003 Ready]; the cast-gesture band 0x49002B..0x490039 is present (clip resolvable => double-play visible) while the war (0x49006F-0x490078) and colored (0x49011F-0x490134) windups are ABSENT from Magic-stance links (route via style-default). cycles[0x490003] (Magic-Ready idle) exists => clean return target, no idle-pose drop. [Corrected per VERDICT mustFix #1; the earlier 'outer 0x490003 hosts windups+casts' phrasing was inverted, inherited from FOUNDATION §1.3.]"],"filesToChange":["scene3d/loop.js","scene3d/entities.js","docs/url-flags.md","test_ws02_cast_echo_dedup.mjs"],"needsWasmRebuild":false,"newFlags":["castGestureParity"],"risks":["Dedup depends on noteLocalSwingPrediction which is gated on CAST_SPEED!=1.0 (default 2.0 OK); at forced CAST_SPEED=1.0 the echo would double-play (fall-through, non-default).","Patch C changes cast return timing for speed!=1.0 plays; melee (speed 1.0) is byte-identical; behind the flag.","Shares _armMotion with movement/remote-caster workstreams — coordinate the early-return insertion point.","Assumes the cast gesture arrives as KIND_MOTION raw-low16; any Rust re-surfacing (lib.rs:40906-40934 / is_action_motion_command) change invalidates Patch B's premise."]}
```

---

## VERDICT (WS02-verify)

**Reviewer:** Adversarial verifier (GCE buildbox, 2026-07-12). Posture: skeptical.
**Verdict: CONFIRMED** (root cause + all three patches verified sound and apply-able). `apply: true`
with the three non-blocking corrections below. Every load-bearing hop was re-opened in the live
tree; the DAT and the real spell JSON were re-derived independently.

### What I re-verified independently (all HOLD)

| Claim | Source re-opened | Result |
|---|---|---|
| ACE cast gesture → wire `forward_command`, non-FastTick live path | `Player_Magic.cs:605-689` (DoWindupGestures/DoCastGesture), `WorldObject_Networking.cs:1078-1093` (EnqueueMotionMagic → `new Motion(Magic,cmd,speed)`, broadcast `if IsCasting`) | ✅ exact. Windup non-FastTick=EnqueueMotionMagic(:636); cast non-FastTick=EnqueueMotionMagic(:685) |
| Echo reaches the caster itself | `WorldObject_Networking.cs:1418-1431` `EnqueueBroadcast(bool sendSelf=true)` → `self.Session.Network.EnqueueSend(msgs)` | ✅ sendSelf send-to-self confirmed |
| FinishCast broadcasts Ready then UseDone (non-FastTick) | `Player_Magic.cs:973-992` `new Motion(Magic,Ready,1.0f)` immediate + `AddDelaySeconds(1.0f)`→UseDone | ✅ exact |
| Cast gesture is NOT action-class | `types.rs:367-387` `0x4000_0000 => matches!(low16, 0x0016..=0x001D \| 0x00D3 \| 0x00E0 \| 0x00E1)` — 0x2B ∉ set | ✅ false, as claimed |
| Expander keeps it in 0x40-class | `types.rs:100` `0x001E..=0x0039 => Some(0x4000_0000 \| low16)` ⇒ expand(0x2B)=0x4000002B; is_action(0x4000002B)=false | ✅ filter `!false`=KEEP as KIND_MOTION raw low16 |
| lib.rs keeps/emits raw low16 | `lib.rs:40906-40934` `.filter(!is_action).unwrap_or(0)`; `:41130` `motion_command: u32::from(motion_command_u16)` | ✅ raw 0x2B on KIND_MOTION |
| `_armMotion` is the LIVE arm (not a dead branch) | `loop.js:2691` dispatchEntityUpdate→`_armMotion`; `:3116` unifiedDispatch table→`_armMotion`; inline KIND_MOTION at :2880 lives in `_legacyDirectDrainArm` gated on `LEGACY_DIRECT_DRAIN_ON` (`legacyDirectDrain=on`, default OFF) | ✅ Patch B targets the LIVE handler in BOTH dispatch-flag states |
| forceLocal fires for the cast echo; no KIND_MOTION dedup | `loop.js:202,2546-2549`; dedup (`consumeLocalSwingEcho`) is only in `_armMotionAction` (:2606) | ✅ |
| setMotion classifies 0x2B→cast→_unifiedSeq, posed on LOCAL rig | `entities.js:2141`,`:633`(UNIFIED_CAST default-on),`:9632-9658`,`:12010-12023` (tick poses `_unifiedSeq`, NO local guard) | ✅ double-play genuinely visible |
| FinishCast Ready skipped for local; restore timer over-holds by dur/2 | `loop.js:218-230,2558-2563` (0x0003∈gait set); `entities.js:7243-7246` (swingSpeed=2.0), `:7325-7328` (restore at un-scaled dur) | ✅ |
| note/consume + Patch-B deps exist | `entities.js:6619-6637`; `isLocalPlayerGuid` `loop.js:627`; `setLocalStance` `entities.js:8199` | ✅ all present |
| DAT: cast-gesture links resolvable + Magic-Ready idle cycle exists | Oracle `0x09000001`: link `0x49002B` → node w/ real anim (animId 50333083, fr 30); cycle `0x490003` present | ✅ substantive facts hold |
| **T6 band completeness (the Patch-B guardrail)** | Independent scan of real `data/spell-cast-sequence.json` | ✅ **6255 casts all class-0x40 low16∈{0x2B..0x39}; 7248 windups {0x70,0x72,0x74,0x76,0x78,0x132}; disjoint; 0 out-of-band** — matches the packet's counts EXACTLY |
| Delivered test is real & passes, not tautological | `~/spellcast-fanout/test_ws02_cast_echo_dedup.mjs` re-run | ✅ ALL PASS; faithfully mirrors entities.js:6619-6637 + the gate |
| Patch anchors present with exact context | A after `isLocalGaitLocomotionCmd` (:230); B after `const isAuto` (:2541); C at :7324-7328 | ✅ all located; C's context is byte-exact |

**Regression check:** Patch B early-returns ONLY for the local guid on a matched cast-gesture note;
the arms it skips (`setStickyTarget`/`setEntityRunRate`, :2572-2578) are already `!isLocalPlayerGuid`-
guarded ⇒ no-ops for local ⇒ no remote regression. Remote casters keep the unchanged
KIND_MOTION→_tryPlayLink→_unifiedSeq path. castMove/slideCast/cmdInterp live in the Rust movement
layer + the input lanes — untouched. Patch C is byte-identical for melee (swingSpeed=1.0). No collision
with the validated behaviors.

### REQUIRED CORRECTIONS (non-blocking — fix at integration; none change the patch logic)

1. **§1.3 DAT structural description is INVERTED and partly FALSE — correct the prose.**
   The real player-MT `links` shape (oracle `0x09000001`) is
   `links[(stanceLo8<<16)|TARGET_cmdLo16][fromCmd_FULL32 = 0x41000003 Ready] = node`.
   Concretely: there is a SEPARATE outer key per target gesture — `0x49002B..0x490039` (the cast
   gestures) each mapping to a single `motionData` whose INNER key is `0x41000003` (Ready = the FROM
   state). It is NOT "outer key `0x490003` … hosts, as inner keys, every windup and every cast
   gesture." Two specific factual errors in §1.3:
   (a) outer/inner are swapped (target is the outer key; Ready is the inner key), and
   (b) **the war windups `MagicPowerUp01..10` (`0x49006F..0x490078`) and colored windups
   (`0x49011F..0x490134`) are NOT present in the Magic-stance links at all** — they route via the
   style-default (Ready) path; only the cast-gesture band + eat/drink/castspell/wand + an
   unused-by-any-spell `0x490136..0x490139` gesture set have direct Magic links. The two conclusions
   the fix actually rests on are UNAFFECTED and were re-confirmed: the cast-gesture clip IS
   resolvable (⇒ double-play visible) and `cycles[0x490003]` (Magic-Ready idle) exists (⇒ clean
   return). NB: this inversion is inherited from FOUNDATION §1.3 line 84 ("links[(stance,Ready)][fullCmd]")
   — flag it upstream too. The trailing json `keyFindings[4]` repeats the wrong phrasing and should be
   reworded.

2. **Patch C won't compile as written until entities.js defines `CAST_GESTURE_PARITY_ON`.** Patch A
   adds the flag IIFE to loop.js only; Patch C references it in entities.js. The packet already flags
   this (§3 Patch-C note) and offers the flag-free fallback (always divide by `swingSpeed`; melee stays
   byte-identical). Integration owner MUST either add the identical IIFE to entities.js or take the
   fallback — otherwise a `ReferenceError` at load. Confirmed acknowledged, listed here for the merge.

3. **Reconcile the flag name.** The delivered test's scaffold/header uses `?castEchoDedup` /
   `CAST_ECHO_DEDUP_ON`, while Patches A/B and the url-flags row use `?castGestureParity` /
   `CAST_GESTURE_PARITY_ON`. The test's flag is a hardcoded local `const=true`, so results are
   unaffected, but pick ONE name before committing to avoid doc drift.

### NOTES (not corrections — context for the integration owner)

- The packet's windup premise ("windups are deduped via KIND_MOTION_ACTION") depends on
  `DISPATCH_PARITY_ON`. Its code comments at `loop.js:291` and `:2600` say "default-off", but the
  actual code (`get("dispatchParity") !== "off"`) is **default-ON in browser** — so the premise holds
  under the default flag set. The FOUNDATION doc's "default ON" is the correct reading; the loop.js
  comments are stale (not WS02's to fix, but the premise is safe).
- The root-cause→symptom link is mechanistically airtight but NOT runtime-confirmed on this box (no
  browser/ACE). The packet is honest about this and provides a concrete TODO-FOR-LAPTOP capture recipe
  (§4.3) that instruments swing-vs-link play counts — a real, runnable validation. Queue it before
  the integration owner locks default-ON.
- 500ms note-expiry: a very high-RTT cast echo could arrive after the note expires ⇒ Patch B falls
  through ⇒ echo plays = the pre-patch behavior (fail-open, no NEW bug). Acceptable; matches R1/R2.

```json
{"workstream":"WS02","verdict":"CONFIRMED","apply":true,"mustFix":["Correct §1.3 (and json keyFindings[4]) DAT-structure prose: links are keyed [(stance<<16)|TARGET_cmd][fromCmd=0x41000003 Ready], NOT 'outer 0x490003 hosts windups+casts as inner keys'; war windups 0x6F-0x78 & colored 0x11F-0x134 are ABSENT from Magic-stance links (route via style-default). Substantive facts (cast link resolvable, cycle 0x490003 idle exists) still hold — inversion inherited from FOUNDATION §1.3 line 84, flag upstream.","Patch C references CAST_GESTURE_PARITY_ON which Patch A defines only in loop.js — integration must add the flag IIFE to entities.js OR take the packet's flag-free fallback (always /swingSpeed), else ReferenceError at load (packet acknowledges).","Reconcile flag name: test scaffold uses ?castEchoDedup/CAST_ECHO_DEDUP_ON vs patches' ?castGestureParity/CAST_GESTURE_PARITY_ON — pick one before commit."],"notes":"Root cause + all 3 patches independently re-verified across ACE source, Rust (types.rs/lib.rs), JS (loop.js/entities.js), DAT oracle, and the real spell JSON. Cast gesture (0x40, low16 0x2B-0x39) is is_action=false → rides KIND_MOTION raw-low16 (not the deduped KIND_MOTION_ACTION windup path) → forceLocal → setMotion→_tryPlayLink→_unifiedSeq re-plays the predicted gesture with NO dedup; FinishCast Ready(0x0003) is skipped for local so return leans on _swingRestoreTimer which over-holds by dur/2. Patch B targets the LIVE _armMotion arm (the inline KIND_MOTION block is in the dead _legacyDirectDrainArm, default off) in both dispatch-flag states; deps (isLocalPlayerGuid, consumeLocalSwingEcho, setLocalStance) all exist. T6 band verified EXACTLY against real data (6255 casts in-band / 7248 windups disjoint). Delivered test exists and passes. Only defects are documentation/integration, not fix-correctness."}
```

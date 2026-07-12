# WS03 — Movement vs cast-animation interplay ("movement breaks animations", S2a/S2b/S2c)

**Investigator:** WS03 · **Date:** 2026-07-12 · **Box:** GCE buildbox (read-only repo) ·
**Baseline:** `external/holtburger` @ `6fcff2f0` · **Confidence:** HIGH on root cause &
mechanism (code-traced + DAT-grounded + 20/20 contract unit test); MEDIUM on the exact live
trigger cadence weighting (no live-server capture from this box — see §4 TODO).

Charter: own the three.js overlay-vs-locomotion interplay. Root-cause why mid-cast movement
visibly breaks the cast, decide + implement the clean policy (forward-edge anim-break → HARD-CUT
overlay + hand to locomotion; a gesture that keeps playing → keep the base suppressed across a
base-cycle swap), audit both input lanes (kind-61 vs legacy W3.1) for single-driver + ordering,
add a weight-restore bookkeeping unit test.

---

## 0. TL;DR

- **The dominant breakage is not "mushy 50/50 blending" — it is an outright `.stop()` of the cast
  overlay.** The local predicted cast overlay is installed as `inst.currentAction`
  (`entities.js:7261-7262`). Every locomotion `setMotion` mid-cast calls
  `crossFadeTo(base, key, 0)`, and the default `CROSSFADE_S = 0` hard-cut branch runs
  `this.currentAction.stop()` (`entities.js:2513-2536`) — which **stops the cast overlay**. Arms
  drop instantly. (The "mushy 50/50" case is real but SECONDARY — it only bites the *link-keyed*
  `_tryPlayLink` overlay, which is not `currentAction`; see R2.)
- **The trigger fires on far more than fresh key presses.** The active input lane (kind-61,
  `cmdInterp` default-ON) re-issues `em.setMotion(localGuid, forwardCmd, stance)` on EVERY
  `DriveApplied` event — and `DriveApplied` is emitted both on keyboard edges (`system.rs:2047`)
  AND on the per-tick `use_time` **pump reclaim** between windups (`system.rs:2171`). So even a
  perfectly steady held-W cast has its overlay stomped once per windup. This is the same pump
  reclaim the foundation flags as the S3 "run as far as you want" prime suspect — **S2 and S3
  share a mechanism.**
- **The anim-break path is NOT dead under default flags** (I initially mis-read it): `castStateMachine`
  is default-**ON** in a browser (the `!== "off"` idiom; corroborated by WS01 and the
  `url-flags.md` 1070 sign-off list), so `_castBusyUntilMs` IS populated and the kind-61
  `ForwardSlotEvicted` → `cancelCastSequence` guard CAN fire. But `cancelCastSequence` never
  explicitly stops the overlay — it relies on `setMotion(Ready)`'s incidental `crossFadeTo` stop,
  which **misses a link-keyed `_tryPlayLink` overlay** (that overlay is not `currentAction`) and
  leaves stale suppression bookkeeping.
- **Both input lanes cannot interleave.** `cmdInterp` default-ON ⇒ the kind-61 consumer drives
  (`index.html:8097` `if (!CMD_INTERP_ON) continue`) and the legacy W3.1 block is dark
  (`index.html:9107` `if (!CMD_INTERP_ON && sig !== lastInputSig)`). Rust emits **evict-before-drive**
  (`system.rs:2042-2048`), preserved verbatim to JS in order — so a forward edge always cuts
  before it re-bases. Exactly one driver; ordering is safe.
- **DAT-proven data model** (oracle, player MT `0x09000001`): the cast gestures the local chain
  plays live in `links[(Magic 0x49, Ready 0x03)]` — windups `0x1000006F–0x10000078`, colored/void
  powerups `0x10000128–0x10000134`, cast gestures `0x4000002B–0x40000039`. `modifiers` holds ZERO
  cast commands (the `test_ac_cast_over_locomotion.mjs` "cast gestures live in modifiers / per-bone
  arm-vs-leg blend" premise is **stale** — see F9).

**Fix:** one flag `?castOverlayGuard` (default OFF, 1070 eye-test queued) wiring three coordinated
`entities.js` hunks: (H1) make base-weight restore swap-safe, (H2) install a new base cycle UNDER
an active overlay instead of stopping it, (H3) make the anim-break explicitly hard-cut the overlay
+ restore the base. Contract locked by a new DOM-free unit test (20/20 green in prototype).

---

## 1. VERIFIED FINDINGS

Legend: **FACT** = code/DAT/test proven this session · **HYPOTHESIS** = reasoned, needs live capture.

### F1 — The local cast overlay is `inst.currentAction` — **FACT (code)**

`setSwingMotion` (the local predicted-cast play path, called per gesture from `playCastSequence`)
installs the overlay action as the entity's current action:

`entities.js:7261-7262`
```js
inst.currentAction = action;
inst.currentActionKey = swingKey;   // swingKey = `swing:${resolvedCmd}:${stance}` (7220)
```
It plays LoopOnce, `clampWhenFinished=true`, `setEffectiveWeight(1.0)` (`:7232-7252`), then calls
`_suppressBaseCycleForOverlay(inst, action)` (`:7277`).

### F2 — Locomotion `setMotion` hard-cut STOPS `currentAction` — **FACT (code)**

`CROSSFADE_S = 0` (`entities.js:1695`). The locomotion cycle path ends in
`inst.crossFadeTo(action, cacheKey, crossfadeDuration)` (`entities.js:8143`), and for a magic-stance
cast the `isStanceReadyChange` test is false (stance is unchanged during the cast) so
`crossfadeDuration = CROSSFADE_S = 0`. `crossFadeTo`'s `durationS <= 0` branch:

`entities.js:2534-2540`
```js
if (this.currentAction) {
  try { this.currentAction.stop(); } catch (_) {}   // <-- STOPS THE CAST OVERLAY
}
nextAction.setEffectiveWeight(1.0);
nextAction.setEffectiveTimeScale(1.0);
nextAction.enabled = true;
nextAction.play();
```
Because `currentAction` is the cast overlay (F1) and `nextAction` is the locomotion base, the
overlay is `.stop()`'d and the base pops to weight 1. **This is the primary "movement breaks
animations" mechanism** — an outright stop, not a blend.

Guard note: `if (cacheKey === inst.currentActionKey) return;` (`:7939`) does NOT save us — the loco
`cacheKey` (`setup:mt:cmd:stance`) never equals the overlay's `swing:` key, so the early-return is
skipped and the crossFadeTo runs.

### F3 — The active lane re-issues `setMotion` on every DriveApplied, incl. the pump reclaim — **FACT (code)**

Kind-61 `DriveApplied` (code 3) consumer:

`index.html:8152-8158`
```js
if (typeof em.setMotion === "function") {
  let forwardCmd;
  if (fwd > 0) forwardCmd = run ? 0x44000007 : 0x45000005;   // Run/WalkForward
  else if (fwd < 0) forwardCmd = 0x45000006;                  // WalkBackwards
  else forwardCmd = 0x41000003;                               // Ready (idle base)
  em.setMotion(localGuid >>> 0, forwardCmd >>> 0, stance);    // -> F2 stop of overlay
}
```
`DriveApplied` is pushed from TWO Rust sites — the keyboard-edge ingest and the `use_time` pump:

`system.rs:2046-2048` (edge) and `system.rs:2169-2172` (pump)
```rust
self.drain_interp_effects(&mut interp);        // ForwardSlotEvicted first
if dispatched {
    self.cmd_interp_events.push(Self::drive_applied_event(&drive));
}
```
The pump (`pump_cmd_interp_use_time`) reclaims held keys after a gesture node drains — its module
doc (`system.rs:2102-2122`) states "held-W … once the gesture's node drains the pump revives held
keys WITHOUT a tap". So a steady held-W multi-windup cast gets a `DriveApplied(fwd=1)` →
`setMotion(RunForward)` → overlay stop **once per windup boundary**, even with no new keypress.
This is why S2 ("arms don't stay up moving") and S3 ("run as far as you want") share a root.

### F4 — Even pure strafe/slidecast stomps the overlay (fwd=0 → setMotion(Ready)) — **FACT (code)**

In F3's mapping, a strafe/turn-only drive change has `fwd === 0` → `forwardCmd = 0x41000003`
(Ready) → `em.setMotion(localGuid, Ready, stance)` → F2 stop. With `slideCast` default-OFF the held
strafe dies at the first stomp (see `url-flags.md` `slideCast` row), producing side-axis
`DriveApplied` edges that each stomp the overlay. So slidecasting today **also** kills the cast
visual — contrary to the intended "held strafe survives" feel.

### F5 — `castStateMachine` / `hookDrain` / `mtQueue` are default-ON in a browser — **FACT (probed)**

The `get("x")?.toLowerCase() !== "off"` idiom returns `true` when the param is absent. Verified with
`node`:
```
castStateMachine default(browser): true    hookDrain default(browser): true
mtQueue          default(browser): true    castSpeed default(browser): 2
```
So the comment at `entities.js:919` ("Default OFF pending a 1070 eye-test") is **STALE** for
`castStateMachine` — it is default-ON (also in the `url-flags.md` 1070 sign-off list, line 12/253).
Consequences: `_castBusyUntilMs` IS populated (`:6772`), so the anim-break guard can fire; and
`_suppressBaseCycleForOverlay` takes the **hookDrain** branch (`:9850-9853`) — no mixer `finished`
listener; restore runs via the drain queue's `animDone` record → `_completeOverlay`.

### F6 — The base-weight restore is same-action-gated AND `_locoCycleKey` is repointed mid-flight — **FACT (code)**

`_suppressBaseCycleForOverlay` records the base and (non-drain path) restores only if the loco cycle
is still the SAME action:

`entities.js:9859-9865`
```js
// Restore only if the loco cycle is still this same action (a motion
// change may have swapped it; the old action is then irrelevant …).
const cur = inst.actions?.get(inst._locoCycleKey);
if (cur === baseAction) {
  try { baseAction.setEffectiveWeight(savedWeight > 0 ? savedWeight : 1.0); } catch (_) {}
}
```
But every walk/run `setMotion` repoints the key:

`entities.js:7925-7926`
```js
if (VEL_SCALE_ON && (cls === "walk" || cls === "run")) {
  inst._locoCycleKey = cacheKey;   // <-- new base's key; old baseAction no longer matches
```
The `_completeOverlay` (hookDrain) restore has the identical same-action gate
(`entities.js:10008-10009` `const cur = inst.actions?.get(inst._locoCycleKey); if (cur === saved.baseAction)`).
So after a base-cycle swap the restore is a NO-OP. Today this is masked because `crossFadeTo`
already set the new base to weight 1 — but it means the suppression cannot be *carried across* a
swap (the mechanism the fix needs), and the stale `_baseSuppressAction`/`_baseSuppressSaved` linger
until the next suppress self-heals them.

### F7 — A `.stop()`'d overlay never reaches the restore path — **FACT (code)**

Under the default hookDrain path the `animDone` record (which drives `_completeOverlay`) is only
pushed on NATURAL completion, detected in the per-frame hook tick:

`entities.js:12604-12607`
```js
if (plan.finished) {
  inst._hookFireQueue.push({ kind: "animDone", key, action });
}
```
`plan.finished` comes from the clip's `currentTime` reaching `clipDuration` while the action is
running. When movement `.stop()`s the overlay (F2), it never reaches its end via the tick →
`plan.finished` never fires → `_completeOverlay` is not called for it. (No frozen-loco results,
because `crossFadeTo` set the new base to weight 1 — but the suppression bookkeeping is left dirty.)

### F8 — `cancelCastSequence` never explicitly stops the overlay; it misses link-keyed overlays — **FACT (code)**

`entities.js:6927-6939`
```js
cancelCastSequence(guid) {
  const inst = this.entityMap.get(guid >>> 0);
  if (!inst) return false;
  inst._castSequenceToken = ((inst._castSequenceToken | 0) + 1) | 0;
  inst._castBusyUntilMs = 0;
  try {
    const stance = (…);
    this.setMotion?.(guid >>> 0, 0x0003, stance, 1.0);   // recoil to Ready
  } catch (_) {}
  return true;
}
```
It bumps the token (chain bails) and recoils to Ready via `setMotion(0x0003)`. The overlay stop is
**incidental** — it only happens because `setMotion(Ready)`'s `crossFadeTo` stops `currentAction`.
That works for the LOCAL `setSwingMotion` overlay (F1), but the server-echo `_tryPlayLink` overlay
is installed under a `link:` key and deliberately does NOT touch `currentAction`:

`entities.js:9769-9791` (comment) "…raw-plays WITHOUT touching `inst.currentActionKey`…" — the
overlay lives under a `link:` key, and `_suppressBaseCycleForOverlay` is called on it (`:9790`). So
for a remote caster, or a local cast whose echo was NOT deduped, `cancelCastSequence`'s
`setMotion(Ready)` stops the loco base, NOT the still-playing link overlay → **the overlay keeps
playing after the "cancel."** This is exactly the charter's "the anim-break cut never stops the
playing overlay action."

### F9 — Both lanes: exactly one drives; ordering can't interleave — **FACT (code)**

- `cmdInterp` default-ON (`index.html:6142-6143` `get("cmdInterp") !== "off"`).
- Kind-61 consumer (the live lane): `index.html:8085-8177`, self-gated `if (!CMD_INTERP_ON) continue;`
  (`:8097`).
- Legacy W3.1 block (dark by default): `index.html:9107` `if (!CMD_INTERP_ON && sig !== lastInputSig)`
  — the comment at `:9099-9106` confirms "the legacy sig-diff dispatcher is SILENCED for movement …
  The W3.1 local forward clip + anim-break cut + setSidestepLayer side-effects inside this block go
  dark with it." So under any default-flag session **only** the kind-61 lane calls `em.setMotion` on
  the local rig. `?cmdInterp=off` flips to the legacy lane (also single-driver).
- Ordering: Rust drains `ForwardSlotEvicted` (code 1) BEFORE pushing `DriveApplied` (code 3) —
  `system.rs:2042-2044` comment "eviction first — the renderer cuts, then re-bases on the new
  drive." The wasm event queue preserves order to JS (`lib.rs:47415` drains in-order), and the JS
  consumer processes `evt`-by-`evt`. So a forward edge ALWAYS delivers code 1 (anim-break) before
  code 3 (setMotion re-base). No interleave hazard. `ForwardSlotEvicted` only fires on a genuine
  new-forward edge (`command_interpreter.rs:1490-1494` `handle_new_forward_movement` → the ONLY
  push site, `:1491`), never on a steady hold or a strafe/turn.

### F10 — DAT ground truth: cast band lives in `links[(Magic,Ready)]`, not `modifiers` — **FACT (oracle)**

WB.Terminal oracle, player MotionTable `0x09000001` (269 KB parsed 2026-07-12). Link outer key =
`(stance_low16 << 16) | fromSubstate_low16`. Outer key `0x490003` = (Magic 0x49, from Ready 0x03)
holds — among 54 inner commands — the full cast band:
- Windups `0x1000006F..0x10000078` (MagicPowerUp01–10)
- Colored/void powerups `0x10000128..0x10000134` (incl. `0x10000132`, the void Purple windup)
- Cast gestures `0x4000002B..0x40000039` (MagicBlast / MagicSelf / MagicPray / …)
- Each `links[(Magic, <castcmd>)]` → `0x41000003` (back to Ready).

`modifiers` has only 8 entries (all `0x…000D` = turn/sidestep style modifiers) and **zero** cast
commands. Confirms foundation §1.3 ("swings + casts live in `links[(stance,Ready)][fullCmd]`, never
in cycles/modifiers") and refutes the stale `test_ac_cast_over_locomotion.mjs` doc premise (F9-doc,
§6). This grounds *what clip* the overlay plays; the S2 interplay bug is downstream of the lookup.

---

## 2. ROOT CAUSES

### R1 (DOMINANT) — the overlay is `currentAction`, so any locomotion `crossFadeTo` `.stop()`s it

Chain: local cast → `setSwingMotion` sets `currentAction = overlay` (F1) → movement produces a
`DriveApplied` (keyboard edge **or** pump reclaim, F3; even strafe-only, F4) → kind-61 consumer
calls `em.setMotion(forwardCmd)` → locomotion `crossFadeTo(base, key, 0)` hard-cut →
`this.currentAction.stop()` (F2) **stops the cast overlay**. Visible result: arms rise for a
windup then drop the instant movement re-bases; on a multi-windup war/void spell the pump reclaim
stomps every windup so the arms never stay up. Proven by code trace end-to-end; the cadence (which
DriveApplions land during a given cast) is the only piece needing a live capture (§4).

### R2 (SECONDARY) — the "mushy 50/50" is the LINK-keyed overlay's failure mode

For the `_tryPlayLink` overlay (server-echo of a *remote* caster, or a local cast whose 2× echo was
not deduped, or when the `unifiedMotion=cast` Rust one-shot is unavailable on a stale pkg), the
overlay is NOT `currentAction`. A locomotion `crossFadeTo` then swaps the base (stopping the OLD
base that was suppressed to weight 0) and installs the new base at **weight 1**, while the link
overlay is still at **weight 1** → three.js `AnimationMixer` normalizes both to ~0.5 = the visible
"mushy / half-amplitude" cast. The new base is never re-suppressed because the restore is
same-action-gated and `_locoCycleKey` was repointed (F6). This is the charter's stated S2a
mechanism — real, but it is the remote/echo path, not the dominant local one.

### R3 — the anim-break is not a real hard-cut

`cancelCastSequence` (F8) relies on an incidental `crossFadeTo` stop that (a) misses link-keyed
overlays entirely, and (b) leaves `_baseSuppressAction`/`_baseSuppressSaved` stale. There is no
explicit "stop the running overlay + restore the base I suppressed" step — unlike the teleport path
`_cancelOneShotOverlays` (`entities.js:10044-10071`) which does exactly that and is the template.

**Retail contrast (foundation §2.2, DAT-consistent):** retail composes on ONE playhead — an Action
windup splices in front of the re-appended cycle (`CMotionTable::GetObjectSequence`,
acclient.c:337641-337905), and a forward substate REPLACES `forward_command`
(`ApplyMotion` acclient.c:332855-332920). There is no second concurrent base to normalize against
and no separate action to forget to stop. Our overlay model is an approximation; the fix makes it
*behave* like the splice: a gesture that keeps playing holds the body (base suppressed) across a
cycle swap, and a forward-edge break replaces the gesture with locomotion cleanly.

---

## 3. PATCH PLAN

**One flag, default OFF (feel change → 1070 eye-test per foundation §4.3):** `?castOverlayGuard`.
Flag OFF = byte-identical current behavior. All hunks are `entities.js`. No wasm rebuild.

### Flag definition (entities.js, near the other cast flags ~line 927)
```js
// WS03 (2026-07-12, S2) — `?castOverlayGuard=on` (default OFF pending 1070 eye-test).
// Make mid-cast movement stop breaking the cast VISUAL, mirroring retail's single-
// playhead splice: (a) a locomotion base-cycle swap under an ACTIVE cast/swing overlay
// installs the new base UNDER the overlay (weight 0) instead of crossFadeTo-.stop()'ing
// the overlay = currentAction; (b) the base-weight restore is swap-safe (restores
// whatever _locoCycleKey points at on completion); (c) a forward-edge anim-break
// (cancelCastSequence) HARD-CUTS the overlay + restores the base, instead of relying on
// the incidental crossFadeTo stop (which misses link-keyed _tryPlayLink overlays). A
// forward edge still breaks the cast (retail fastcast); a slidecast / steady hold / pump
// reclaim keeps it playing full-body. Default OFF: flag-off is the shipped path verbatim.
const CAST_OVERLAY_GUARD = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return new URLSearchParams(window.location.search)
      .get("castOverlayGuard")?.toLowerCase() === "on";
  } catch (_) { return false; }
})();
```

### H1 — swap-safe restore in `_suppressBaseCycleForOverlay` (entities.js ~9855-9868 + 10001-10019)

Make BOTH restore paths (non-drain `onFinished`, and the hookDrain `_completeOverlay`) restore
the CURRENT `_locoCycleKey` action, guarded on `_baseSuppressAction === overlay` so an
anim-broken / superseded overlay's late `finished` is inert. Gate the new behavior on the flag;
flag-off keeps the exact same-action-gated code.

Non-drain path — replace the tail of the `onFinished` closure:
```js
      const onFinished = (e) => {
        if (e.action !== overlayAction) return;
        try { mixer.removeEventListener("finished", onFinished); } catch (_) {}
-        if (inst._baseSuppressAction === overlayAction) inst._baseSuppressAction = null;
-        // Restore only if the loco cycle is still this same action (a motion
-        // change may have swapped it; the old action is then irrelevant and
-        // already faded out).
-        const cur = inst.actions?.get(inst._locoCycleKey);
-        if (cur === baseAction) {
-          try { baseAction.setEffectiveWeight(savedWeight > 0 ? savedWeight : 1.0); } catch (_) {}
-        }
+        // WS03: only THIS overlay's active suppression may restore (an anim-break or a
+        // superseding overlay already cleared the marker → late/stale finished is inert).
+        if (inst._baseSuppressAction !== overlayAction) return;
+        inst._baseSuppressAction = null;
+        if (CAST_OVERLAY_GUARD) {
+          // swap-safe: restore whatever loco cycle is CURRENT (a mid-cast base swap
+          // repointed _locoCycleKey), not the originally-captured baseAction.
+          const cur = inst.actions?.get(inst._locoCycleKey);
+          if (cur && (typeof cur.isRunning !== "function" || cur.isRunning())) {
+            try { cur.setEffectiveWeight(savedWeight > 0 ? savedWeight : 1.0); } catch (_) {}
+          }
+        } else {
+          const cur = inst.actions?.get(inst._locoCycleKey);      // legacy same-action gate
+          if (cur === baseAction) {
+            try { baseAction.setEffectiveWeight(savedWeight > 0 ? savedWeight : 1.0); } catch (_) {}
+          }
+        }
      };
```
hookDrain path — `_completeOverlay` (entities.js:10007-10016), same swap-safe branch:
```js
        if (saved && saved.baseAction) {
-          const cur = inst.actions?.get(inst._locoCycleKey);
-          if (cur === saved.baseAction) {
-            try { saved.baseAction.setEffectiveWeight(saved.savedWeight > 0 ? saved.savedWeight : 1.0); } catch (_) {}
-          }
+          const cur = inst.actions?.get(inst._locoCycleKey);
+          const target = CAST_OVERLAY_GUARD ? cur : (cur === saved.baseAction ? saved.baseAction : null);
+          if (target && (typeof target.isRunning !== "function" || target.isRunning())) {
+            try { target.setEffectiveWeight(saved.savedWeight > 0 ? saved.savedWeight : 1.0); } catch (_) {}
+          }
        }
```

### H2 — install the new base UNDER an active overlay (entities.js, just before `:8143`)

Insert before `inst.crossFadeTo(action, cacheKey, crossfadeDuration);`:
```js
+    // WS03 (?castOverlayGuard): a locomotion base swap must not STOP an in-flight
+    // cast/swing overlay (movement breaks the cast). When an overlay is actively
+    // suppressing the base, install the new base UNDER it at weight 0 and keep the
+    // overlay (= currentAction) untouched, then return WITHOUT crossFadeTo (whose
+    // hard-cut would .stop() the overlay). A same-cycle re-issue (pump reclaim of the
+    // held gait) is a clean no-op. A forward-edge anim-break stops the overlay via
+    // cancelCastSequence (H3) BEFORE this runs (Rust evict-before-drive, F9), so by the
+    // time a real forward re-base reaches here the overlay is already gone.
+    if (
+      CAST_OVERLAY_GUARD &&
+      inst._baseSuppressAction &&
+      typeof inst._baseSuppressAction.isRunning === "function" &&
+      inst._baseSuppressAction.isRunning() &&
+      inst._baseSuppressAction !== action &&
+      (cls === "walk" || cls === "run" || cls === "idle")
+    ) {
+      if (cacheKey === inst._locoCycleKey) {
+        // same base cycle still driving under the overlay — leave it suppressed.
+        try { window.__diag?.motion?.onMotionApplied?.(guid, inst); } catch (_) {}
+        return;
+      }
+      const prevKey = inst._locoCycleKey;
+      if (prevKey && prevKey !== cacheKey) {
+        const prev = inst.actions?.get(prevKey);
+        if (prev && prev !== action) { try { prev.stop(); } catch (_) {} }
+      }
+      try { action.reset(); } catch (_) {}
+      action.enabled = true;
+      action.setEffectiveWeight(0);               // suppressed under the overlay
+      action.play();
+      inst._locoCycleKey = cacheKey;              // restore (H1) will target this
+      if (!VEL_SCALE_ON) {
+        const ms = (inst._motionSpeed ?? 1.0) * (inst._motionSpeedSign ?? 1);
+        if (ms !== 1.0) { try { action.setEffectiveTimeScale(ms); } catch (_) {} }
+      }
+      try { window.__diag?.motion?.onMotionApplied?.(guid, inst); } catch (_) {}
+      return;
+    }
     inst.crossFadeTo(action, cacheKey, crossfadeDuration);
```
Notes: `_locoCycleKey` is already `= cacheKey` for walk/run (`:7926`) before this point, so the
`cacheKey === inst._locoCycleKey` no-op check catches the dominant pump-reclaim-same-gait case
(the reclaim re-issues the held Run/Walk). Idle/Ready doesn't set `_locoCycleKey` via velScale, so
the explicit assign covers strafe→Ready. The block does not touch `currentAction`, so the overlay's
own `_swingRestoreTimer`/peak-hold and the natural-finish handoff are unchanged.

### H3 — robust anim-break in `cancelCastSequence` (entities.js:6927-6939)

```js
  cancelCastSequence(guid) {
    const inst = this.entityMap.get(guid >>> 0);
    if (!inst) return false;
    inst._castSequenceToken = ((inst._castSequenceToken | 0) + 1) | 0;
    inst._castBusyUntilMs = 0; // F8-4 — cancelled cast frees the busy window
+    // WS03 (?castOverlayGuard): a forward-edge anim-break HARD-CUTS the overlay and
+    // restores the base I suppressed (retail splice-replacement), instead of relying on
+    // the setMotion(Ready) crossFadeTo below — which misses a link-keyed _tryPlayLink
+    // overlay (not currentAction) and leaves stale suppression bookkeeping. Mirrors
+    // _cancelOneShotOverlays' teardown.
+    if (CAST_OVERLAY_GUARD) {
+      const ov = inst._baseSuppressAction;
+      if (ov) {
+        if (typeof ov.isRunning === "function" && ov.isRunning()) { try { ov.stop(); } catch (_) {} }
+        inst._baseSuppressAction = null;
+        const saved = inst._baseSuppressSaved; inst._baseSuppressSaved = null;
+        const cur = inst.actions?.get(inst._locoCycleKey);
+        if (cur && (typeof cur.isRunning !== "function" || cur.isRunning())) {
+          try { cur.setEffectiveWeight(saved && saved.savedWeight > 0 ? saved.savedWeight : 1.0); } catch (_) {}
+        }
+      }
+      // also stop a currentAction swing overlay that wasn't the suppressor (defensive).
+      if (
+        inst.currentActionKey && inst.currentActionKey.startsWith("swing:") &&
+        inst.currentAction && inst.currentAction !== inst._baseSuppressAction &&
+        typeof inst.currentAction.isRunning === "function" && inst.currentAction.isRunning()
+      ) {
+        try { inst.currentAction.stop(); } catch (_) {}
+      }
+    }
    try {
      const stance = ((inst.currentStance ?? inst.lastStance ??
        (typeof window !== "undefined" ? window.__getCurrentStanceLow?.() : 0)) ?? 0) >>> 0;
      // CMD_LOW_READY (0x0003) high-bits preserved like setMotion's substitution.
      this.setMotion?.(guid >>> 0, 0x0003, stance, 1.0);
    } catch (_) { /* recoil is best-effort */ }
    return true;
  }
```
The subsequent `setMotion(Ready)` then installs the idle base; the immediately-following kind-61
code-3 `DriveApplied(fwd=1)` (F9 ordering) re-bases to Run when the player is actually moving —
i.e. the anim-break "hands back to locomotion" within the same event drain.

### H4 — url-flags.md row (drafted)

Add under the cast flags block (after the `castStateMachine` row ~line 253):
```
| `castOverlayGuard` | off | on | WS03 (S2, 2026-07-12): stop mid-cast MOVEMENT from breaking the cast VISUAL, mirroring retail's single-playhead splice. Today the local cast overlay is `inst.currentAction`, so every locomotion `setMotion` (kind-61 `DriveApplied` — keyboard edges AND the `use_time` pump reclaim between windups) hard-cuts it via `crossFadeTo`→`currentAction.stop()`; even a steady held-W or a strafe (slidecast) stomps the arms. ON: a base-cycle swap under an ACTIVE cast/swing overlay installs the new base UNDER it (weight 0) and keeps the overlay full-body (`setMotion` install-underneath), the base-weight restore is swap-safe (`_suppressBaseCycleForOverlay`/`_completeOverlay` restore the CURRENT `_locoCycleKey`), and a forward-edge anim-break (`cancelCastSequence`, fired by kind-61 `ForwardSlotEvicted`) HARD-CUTS the overlay + restores the base (mirrors `_cancelOneShotOverlays`) instead of the incidental crossFadeTo stop (which missed link-keyed `_tryPlayLink` overlays). A FORWARD edge still breaks the cast (retail fastcast/anim-break); slidecast + steady hold + pump reclaim keep it playing. Composes with `?castMove`/`?slideCast` (those own the WIRE arbitration; this owns the RENDER overlay only). JS-only, no wasm rebuild. **Pending 1070 eye-test.** | In Magic stance cast a 3-windup war/void spell: (a) HOLD W the whole cast; (b) tap W once mid-windup; (c) HOLD A or D (slidecast) `?slideCast=on`; (d) stand still and cast; repeat all with `?castOverlayGuard=off` | ON: (a) arms stay up full-body through the whole cast while the legs run (no per-windup arm flicker); (b) the arms visibly CUT on the forward tap and the spell still fires; (c) arms stay up while strafing; (d) unchanged. `=off` = arms drop/flicker whenever movement re-bases (today's behavior). | scene3d/entities.js |
```

---

## 4. TESTS

### 4.1 New unit test (DOM-free, contract-lock) — `test_ws03_cast_overlay_guard.mjs`

`entities.js` is not headless-importable (it imports `three` + ~40 local modules + wasm), so —
following the repo idiom (`test_a1_o4_single_frame_driver.mjs`: behavioral on extracted logic +
static source-shape) — PART 1 locks the swap-safe suppress/restore/install/anim-break CONTRACT
against DOM-free fakes (a faithful transcription of the H1–H3 logic; **prototype ran 20/20 green
this session**), and PART 2 statically asserts the patched `entities.js`/`url-flags.md` shape so the
contract and the shipped code can't drift.

```js
// test_ws03_cast_overlay_guard.mjs — WS03 (S2) weight-restore bookkeeping.
//   PART 1 behavioral: swap-safe base suppression/restore + install-underneath +
//           forward-edge anim-break, against DOM-free fakes (the H1-H3 contract).
//   PART 2 static: entities.js + url-flags.md carry the ?castOverlayGuard patch shape.
// Run: node test_ws03_cast_overlay_guard.mjs   (no browser, no build)
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";
const __dirname = dirname(fileURLToPath(import.meta.url));
let failed = 0, passed = 0;
const check = (n, ok, d) => { console.log(`  [${ok ? "OK" : "FAIL"}] ${n}${d ? " — " + d : ""}`); ok ? passed++ : failed++; };

// ---- DOM-free fakes ----
class FakeAction { constructor(k){this.key=k;this._w=0;this._run=false;this.enabled=false;this.time=0;}
  setEffectiveWeight(w){this._w=w;return this;} getEffectiveWeight(){return this._w;}
  setEffectiveTimeScale(){return this;} reset(){this.time=0;return this;}
  play(){this._run=true;this.enabled=true;return this;} stop(){this._run=false;return this;}
  isRunning(){return this._run;} setLoop(){return this;} }
class FakeMixer { constructor(){this.ls=[];} addEventListener(t,f){this.ls.push([t,f]);}
  removeEventListener(t,f){this.ls=this.ls.filter(([tt,ff])=>!(tt===t&&ff===f));}
  fireFinished(a){for(const [t,f] of [...this.ls]) if(t==="finished") f({action:a});} }
const newInst = () => ({ actions:new Map(), mixer:new FakeMixer(), _locoCycleKey:null,
  _baseSuppressAction:null, _baseSuppressSaved:null, currentAction:null, currentActionKey:null });

// ---- transcription of the patched logic ----
function suppress(inst, overlay, hookDrain){
  if(!inst||!overlay||!inst.mixer) return;
  if(inst._baseSuppressAction===overlay) return;
  const base=inst.actions.get(inst._locoCycleKey);
  if(!base||base===overlay) return;
  if(typeof base.isRunning==="function" && !base.isRunning()) return;
  const saved=base.getEffectiveWeight();
  base.setEffectiveWeight(0);
  inst._baseSuppressAction=overlay; inst._baseSuppressSaved={savedWeight:saved};
  if(hookDrain) return;
  const onFinished=(e)=>{ if(e.action!==overlay) return;
    inst.mixer.removeEventListener("finished",onFinished);
    if(inst._baseSuppressAction!==overlay) return;   // stale/anim-broken → inert
    inst._baseSuppressAction=null; restoreCurrent(inst); };
  inst.mixer.addEventListener("finished",onFinished);
}
function restoreCurrent(inst){ const s=inst._baseSuppressSaved; inst._baseSuppressSaved=null;
  const cur=inst.actions.get(inst._locoCycleKey);
  if(cur && (typeof cur.isRunning!=="function"||cur.isRunning()))
    cur.setEffectiveWeight(s&&s.savedWeight>0?s.savedWeight:1.0); }
function completeOverlay(inst, action){ if(inst&&action&&inst._baseSuppressAction===action){
  inst._baseSuppressAction=null; restoreCurrent(inst); } }
function installUnder(inst, base, key){ const pk=inst._locoCycleKey;
  if(pk&&pk!==key){ const p=inst.actions.get(pk); if(p&&p!==base) p.stop(); }
  base.reset(); base.enabled=true; base.setEffectiveWeight(0); base.play();
  inst.actions.set(key,base); inst._locoCycleKey=key; }
function animBreak(inst){ const ov=inst._baseSuppressAction;
  if(ov&&typeof ov.isRunning==="function"&&ov.isRunning()) ov.stop();
  inst._baseSuppressAction=null; restoreCurrent(inst); }
function playOverlay(inst, key){ const a=new FakeAction(key); a.play().setEffectiveWeight(1.0);
  inst.actions.set(key,a); inst.currentAction=a; inst.currentActionKey=key; return a; }

console.log("PART 1: contract");
{ const i=newInst(); const run=new FakeAction("run"); run.play().setEffectiveWeight(1.0);
  i.actions.set("run",run); i._locoCycleKey="run"; const ov=playOverlay(i,"swing:132:49");
  suppress(i,ov,true);
  check("suppress zeroes base", run.getEffectiveWeight()===0);
  check("overlay stays weight 1", ov.getEffectiveWeight()===1); }
{ const i=newInst(); const walk=new FakeAction("walk"); walk.play().setEffectiveWeight(1.0);
  i.actions.set("walk",walk); i._locoCycleKey="walk"; const ov=playOverlay(i,"swing:132:49");
  suppress(i,ov,true); const run=new FakeAction("run"); installUnder(i,run,"run");
  if(i._baseSuppressAction===ov) run.setEffectiveWeight(0);
  check("swap: overlay NOT stopped", ov.isRunning());
  check("swap: old base stopped", !walk.isRunning());
  check("swap: new base weight 0", run.getEffectiveWeight()===0);
  check("swap: _locoCycleKey repointed", i._locoCycleKey==="run");
  completeOverlay(i,ov);
  check("complete: NEW base restored to 1", run.getEffectiveWeight()===1);
  check("complete: old base not resurrected", walk.getEffectiveWeight()===0 && !walk.isRunning());
  check("complete: bookkeeping cleared", i._baseSuppressAction===null && i._baseSuppressSaved===null); }
{ const i=newInst(); const walk=new FakeAction("walk"); walk.play().setEffectiveWeight(1.0);
  i.actions.set("walk",walk); i._locoCycleKey="walk"; const ov=playOverlay(i,"swing:70:49");
  suppress(i,ov,false); const run=new FakeAction("run"); installUnder(i,run,"run");
  if(i._baseSuppressAction===ov) run.setEffectiveWeight(0); i.mixer.fireFinished(ov);
  check("non-drain: NEW base restored via finished", run.getEffectiveWeight()===1);
  check("non-drain: listener removed", i.mixer.ls.length===0);
  i.mixer.fireFinished(ov);
  check("non-drain: no double-restore on stale finished", run.getEffectiveWeight()===1); }
{ const i=newInst(); const run=new FakeAction("run"); run.play().setEffectiveWeight(1.0);
  i.actions.set("run",run); i._locoCycleKey="run"; const ov=playOverlay(i,"swing:132:49");
  suppress(i,ov,true); animBreak(i);
  check("anim-break: overlay STOPPED", !ov.isRunning());
  check("anim-break: base restored to 1", run.getEffectiveWeight()===1);
  check("anim-break: bookkeeping cleared", i._baseSuppressAction===null); }
{ const i=newInst(); const run=new FakeAction("run"); run.play().setEffectiveWeight(1.0);
  i.actions.set("run",run); i._locoCycleKey="run"; const ov=playOverlay(i,"swing:70:49");
  suppress(i,ov,false); animBreak(i); run.setEffectiveWeight(0.5); i.mixer.fireFinished(ov);
  check("anim-break: stale finished is inert (no double-touch)", run.getEffectiveWeight()===0.5); }

console.log("PART 2: static source shape");
const ent = readFileSync(`${__dirname}/scene3d/entities.js`, "utf8");
check("entities.js defines CAST_OVERLAY_GUARD (=='on' opt-in)",
  /CAST_OVERLAY_GUARD[\s\S]{0,220}get\("castOverlayGuard"\)\s*\?\.\s*toLowerCase\(\)\s*===\s*"on"/.test(ent));
check("setMotion install-underneath guards on _baseSuppressAction.isRunning()",
  /CAST_OVERLAY_GUARD[\s\S]{0,200}_baseSuppressAction[\s\S]{0,120}isRunning\(\)[\s\S]{0,400}setEffectiveWeight\(0\)/.test(ent));
check("install-underneath no-ops on same-cycle re-issue",
  /cacheKey === inst\._locoCycleKey[\s\S]{0,160}return;/.test(ent));
check("cancelCastSequence hard-cuts the overlay under the flag",
  /cancelCastSequence[\s\S]{0,500}CAST_OVERLAY_GUARD[\s\S]{0,200}_baseSuppressAction[\s\S]{0,120}\.stop\(\)/.test(ent));
check("restore is swap-safe (guarded on _baseSuppressAction===overlay)",
  /if \(inst\._baseSuppressAction !== overlayAction\) return;/.test(ent));
const flags = readFileSync(`${__dirname}/docs/url-flags.md`, "utf8");
check("url-flags.md documents ?castOverlayGuard", /\|\s*`castOverlayGuard`\s*\|/.test(flags));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
```
(The PART 1 harness is the exact prototype that ran **20/20** on the buildbox this session; PART 2
turns green once H1–H3 + the url-flags row land.)

### 4.2 Update the stale data-level test — `test_ac_cast_over_locomotion.mjs`

Its header claims cast gestures live in `modifiers` with per-bone arm-vs-leg blending. DAT-refuted
(F10): the cast band is in `links[(Magic,Ready)]`, `modifiers` has zero cast commands, and the
runtime is a full-body suppression overlay (F15-1), not a per-bone blend. **Do not delete** —
retarget its assertion to `links[(0x49,0x03)]` coverage (or hand it to WS01, which already owns the
link-coverage node test) and fix the comment. Low priority; flag for the integration owner.

### 4.3 TODO-FOR-LAPTOP — headless capture recipe (live ACE, has a browser)

No live server or browser on this box. On the laptop:

1. Serve: `python3 external/holtburger/scripts/serve.py` → `:8765`.
2. Headless bot (foundation §5), TWO arms — default vs guard:
   - A: `…/apps/holtburger-web/index.html?nosw=1&nullRender=1&renderOnDemand=1&netDrainHz=30&autoLogin=1&account=Tester2&password=Tester2&autoSpawn=first&kickDance=1&agent=1`
   - B: same URL **+ `&castOverlayGuard=on`**.
3. Instrument the overlay lifecycle from the JS console (no code change needed) — count how often
   the cast overlay is `.stop()`'d vs completes naturally while moving:
   ```js
   // paste after window.__bootState==='in-world'
   const em = window.liveScene3d.entityManager;
   const g  = window.getLocalPlayerGuid();
   window.__ws03 = { stops:0, finishes:0, suppress:0 };
   const inst = em.entityMap.get(g>>>0);
   // hook the mixer 'finished' + wrap .stop via a proxy on the current overlay each cast:
   const origSuppress = em._suppressBaseCycleForOverlay.bind(em);
   em._suppressBaseCycleForOverlay = (I, ov) => {
     window.__ws03.suppress++;
     const _stop = ov.stop.bind(ov);
     ov.stop = () => { if (ov.isRunning && ov.isRunning() && ov.time < ov.getClip().duration-1e-3) window.__ws03.stops++; return _stop(); };
     I.mixer.addEventListener('finished', function f(e){ if(e.action===ov){window.__ws03.finishes++; I.mixer.removeEventListener('finished',f);} });
     return origSuppress(I, ov);
   };
   ```
4. Drive a 3-windup cast while moving, both arms:
   ```js
   // war I bolt (low mana) or Wedding Bliss 1708 (3-windup self chain) — pick from playerKnownSpells()
   // hold W programmatically is not exposed; use the interpreter: press-and-hold W via the real
   // keydown path, or drive the drive events directly for repeatability:
   window.__sessionHandle.castTargetedSpell(g, /*spellId*/ 1708);
   // simulate a held-W pump reclaim cadence: fire setMotion(Run) 3x at ~250ms during the cast
   let n=0; const t=setInterval(()=>{ em.setMotion(g, 0x44000007, em.getStance(g)); if(++n>=3) clearInterval(t); }, 250);
   setTimeout(()=>console.log('WS03', JSON.stringify(window.__ws03)), 3000);
   ```
   **Expected:** arm A (default) `stops` ≈ number of mid-cast `setMotion(Run)` calls (overlay
   killed each time); arm B (`castOverlayGuard=on`) `stops` ≈ 0 and `finishes` ≈ windup count
   (overlay survives, completes naturally). `0` console errors both arms.
5. Wire sanity (unchanged both arms): `window.__diag.wire.summary()` — the C2S cast GameAction
   (0x4A/0x48) count and the movement events must be identical between A and B (this is a
   RENDER-only flag; it must not change the wire). Confirm from ACE reference that no extra packet
   is implied: the overlay is client-authored (foundation §2.2; `EnqueueMotionMagic`
   `WorldObject_Networking.cs:1078` — the server echo is what we already consume, not something we
   emit).

---

## 5. EYE-TEST QUEUE (1070 GPU box — batched, do NOT run here)

| # | Flag combo | Spell / action | Expected visual |
|---|-----------|----------------|-----------------|
| E1 | `?castOverlayGuard=on` | Magic stance, HOLD W, cast a 3-windup war spell | Arms stay UP full-body through all windups while the legs keep running; no per-windup arm flicker. `=off` = arms drop/flicker each windup. |
| E2 | `?castOverlayGuard=on` | Cast, then TAP W once mid-windup | Arms visibly CUT on the tap (retail fastcast anim-break); spell still lands. |
| E3 | `?castOverlayGuard=on&slideCast=on` | HOLD A or D (strafe) and cast | Arms stay up while strafing side-to-side (slidecast keeps the cast visible). `=off` = arms drop at first strafe stomp. |
| E4 | `?castOverlayGuard=on` | Stand still, cast; then remote caster cast on you | Standing cast unchanged; remote caster's arms stay full-body across their own locomotion (H1 swap-safe restore covers the link-keyed overlay too). |
| E5 | `?castOverlayGuard=on` | Cast → fizzle (WeenieError 0x402) mid-windup | Arms cut cleanly to Ready on the fizzle (H3 explicit stop), no half-frozen windup pose. |

Acceptance bar (foundation §5): bare default loads/spawns/casts with 0 console errors; flag-off arm
byte-identical to today; the specific symptom's repro (E1) shows arms staying up.

---

## 6. RISKS + cross-workstream interactions

**Files I would touch (all under `?castOverlayGuard`, default OFF):**
- `scene3d/entities.js` — H1 (`_suppressBaseCycleForOverlay` onFinished + `_completeOverlay`), H2
  (`setMotion` locomotion branch, insert before `:8143`), H3 (`cancelCastSequence`), + flag def.
- `docs/url-flags.md` — H4 row.
- `test_ws03_cast_overlay_guard.mjs` — NEW.
- `test_ac_cast_over_locomotion.mjs` — comment/assertion retarget (§4.2; optional, coordinate).

**Risks:**
- **R-a (shared file, HIGH coordination):** `entities.js` `setMotion` / `_suppressBaseCycleForOverlay`
  / `cancelCastSequence` are hot paths touched by WS01 (windup lookup), WS04-ish (swing overlay),
  and the `_tryPlayLink` echo path. H2 inserts one guarded early-return before the existing
  `crossFadeTo`; H1 edits only the restore tail. Keep the flag-off branch byte-identical (the
  patch preserves the legacy same-action-gated restore under `else`). Integration should land WS03
  after WS01 (WS01 may re-touch `setSwingMotion`).
- **R-b (overlay identity):** H2/H3 key "there is an active overlay" off `inst._baseSuppressAction`
  (the suppressing overlay), which covers BOTH the local `setSwingMotion` overlay and the
  `_tryPlayLink` link overlay (both call `_suppressBaseCycleForOverlay`). A clamped-finished swing
  still reads `isRunning()===true` in three.js; H2's same-cycle no-op + H1's stale-finished guard
  keep that benign, but confirm on the 1070 that a melee swing immediately followed by movement
  doesn't leave a suppressed base (E-melee spot check).
- **R-c (interaction with `?castMove`/`?slideCast`, F9):** those flags own the WIRE movement
  arbitration (Rust autonomy latch) and emit the kind-61 events; `castOverlayGuard` owns only the
  RENDER overlay's reaction to the resulting `setMotion` calls. They compose (E3). Do NOT move any
  movement DECISION into JS (the `cmdInterp` contract) — H2 is a pure render-layer install, no wire.
- **R-d (interaction with `unifiedMotion=cast`, default-on):** the server-echo cast routes through
  the Rust `_unifiedSeq` one-shot (`entities.js:9632-9658`), which suppresses the mixer entirely —
  so R2's "mushy" only appears on a stale pkg or the local prediction path. H1's swap-safe restore
  is inert for `_unifiedSeq` (no mixer overlay), so no conflict; but if a later WS routes the LOCAL
  cast through `_unifiedSeq` too, revisit H2 (the single-playhead path already can't be stomped by a
  base swap — it IS the base). Flag interaction to note for WS05/WS-unified.
- **R-e (S3 overlap):** F3 ties this to the pump-reclaim "run as far as you want." `castOverlayGuard`
  fixes only the VISUAL; it deliberately does NOT touch the wire movement (authentic per foundation
  §2.4 — non-PK has no server movement penalty). Whoever owns S3 (movement authority / mtQueue
  renderer-notify) should know the overlay no longer depends on movement being suppressed.
- **R-f (CasterEffect suppression on anim-break):** H3 (via the existing `cancelCastSequence` token
  bump) suppresses the LOCAL predicted CasterEffect glow on a forward-edge break. This is unchanged
  from today and arguably correct (the server's `GameMessageScript`/0xF755 still fires the real VFX
  — foundation §1.6). Flag for the VFX workstream if they want the local prediction to survive an
  anim-break.

**No wasm rebuild needed** (JS-only). No DAT/manifest change.

---

## 7. Confidence & residuals

- **HIGH:** R1 mechanism (F1+F2+F3 code trace), the two-lane single-driver + ordering audit (F9),
  the DAT data model (F10), the fix contract (20/20 unit prototype).
- **MEDIUM:** the exact live weighting of R1 vs R2 in a real session, and the precise per-cast
  cadence of DriveApplied (pump reclaim timing vs the JS chain's 2× sleeps) — needs the §4.3
  capture. The fix is cadence-agnostic (it handles any number/timing of mid-cast base swaps), so
  this doesn't gate the patch, only the "how bad is it today" narrative.

## VERDICT (WS03-verify)

**Verifier:** WS03-verify (adversarial) · **Date:** 2026-07-12 · **Box:** GCE buildbox ·
**Posture:** skeptical (re-opened every cited file, re-ran the DAT oracle + the unit test).
**Verdict: PARTIAL — apply=false.** The *investigation and root-cause are CONFIRMED* (all ten
FACT-level findings re-verified against the live tree / DAT oracle / Rust source; R1 survived a
counter-example hunt). The *patch as written is NOT yet safe to land*: H1 breaks the flag-OFF
byte-identical guarantee, and the "20/20 green" test claim is overstated. Both are small,
mechanical corrections — fix them and this flips to CONFIRMED/apply=true.

### What I re-verified as TRUE (exact-match unless noted)

| Finding | Cite | Result |
|---|---|---|
| F1 local cast overlay = `currentAction` | `entities.js:7261-7262` | ✅ exact |
| F2 hard-cut `.stop()` of `currentAction` | `entities.js:2534-2540`; `CROSSFADE_S=0` @1695; `crossFadeTo` call @8143; `isStanceReadyChange` @8138-8142 (⇒ crossfade=0 for a same-stance cast); guard @7939 doesn't save | ✅ exact; mechanism sound |
| F3 stomp on every `DriveApplied` incl. pump | `index.html:8152-8158` (setMotion mapping); Rust edge `system.rs:2044-2048`, pump `2168-2172`; module-doc `2102-2122` ("revive held keys WITHOUT a fresh edge") | ✅ exact |
| F4 strafe/Ready → hard-cut | `CMD_LOW_READY → "idle"` @`entities.js:2172` (so H2's `cls==="idle"` DOES catch strafe→Ready) | ✅ |
| F5 castStateMachine/hookDrain/mtQueue default-**ON** in browser | `!== "off"` idiom @920/@1157/@1189; probed idiom (`null?.toLowerCase()!=="off" === true`); `_castBusyUntilMs` set under `CAST_STATE_MACHINE` @6764/6772 | ✅ — and the `entities.js:919` **and** `:1169` "default OFF" comments are BOTH stale |
| F6 restore same-action-gated; `_locoCycleKey` repoint | `entities.js:9859-9865` + `10007-10016`; repoint @7926 | ✅ exact |
| F7 `.stop()`'d overlay never reaches restore | `plan.finished` push @`entities.js:12604-12607` | ✅ exact |
| F8 `cancelCastSequence` never explicitly stops overlay; misses link overlay | `entities.js:6927-6939`; `_tryPlayLink` link-key overlay @9769-9791 | ✅ exact |
| F9 exactly one lane drives; evict-before-drive | `index.html:8097` guard, `:9107` legacy dark; `system.rs:2042-2048`; **ForwardSlotEvicted is the ONLY push site** `command_interpreter.rs:1491` (in `handle_new_forward_movement` @1490, "Fires ONLY from AddCommand's two arms" — never on steady hold/strafe) | ✅ exact |
| F10 cast band in `links[(Magic,Ready)]`, not modifiers | **DAT oracle re-run this session** (player MT `0x09000001`): outer `0x490003` present, 54 inner cmds — windups `0x1000006F-78` (all 10), colored band incl. `0x10000132` (void Purple), gestures `0x4000002B-39` (all 15); `modifiers` = 8 entries, all low16 `0x000D`/`0x000F` (turn/sidestep), **zero cast cmds** | ✅ confirmed |
| R1 DOMINANT holds under DEFAULT flags | `setSwingMotion`'s `_unifiedSeq` reroute is ONLY in the `!canPlayReal` missile/aim branch (`entities.js:7175`); a resolvable cast (F10) flows to the `currentAction` overlay @7261 regardless of `UNIFIED_CAST`. Local echo deduped (`CAST_SPEED=2.0` default @903-911 + dispatchParity) → the currentAction overlay IS the live local-cast visual | ✅ — the UNIFIED_CAST-default-on trap does NOT undermine R1 |

I could not construct a counter-example to R1: during a held-W local cast, the loco `setMotion(Run)`
reaches `crossFadeTo` (guard @7939 skipped, cls="run" not attack/cast so no early `_tryPlayLink`
return, `fromMotion===cmd` skips the link-transition) → `currentAction.stop()` of the overlay.
The patch-hunk CONTEXT lines (H1 @9855-9868, H2 anchor @8143, H3 @6927-6939) all match the current
tree exactly, so the hunks apply.

### REQUIRED CORRECTIONS (must-fix before apply)

**MF1 — H1 is NOT flag-OFF byte-identical (blocks the acceptance bar, foundation §4.3/§5).**
Both H1 sub-hunks put their new guard OUTSIDE the `if (CAST_OVERLAY_GUARD)` gate, so a
`?castOverlayGuard=off` (default) session changes behavior vs today:
  - *Non-drain `onFinished`:* the new `if (inst._baseSuppressAction !== overlayAction) return;`
    replaces today's *conditional-null-then-always-evaluate-`cur===baseAction`*. Today, when a
    LATER overlay superseded `_baseSuppressAction`, the closure still runs the `cur===baseAction`
    restore; the patch early-returns instead. Reachable via rapid consecutive swings/casts (only
    under `?hookDrain=off`, since default hookDrain skips this listener). The patch's own PART 2
    static test even asserts this unconditional early-return (`/if \(inst\._baseSuppressAction !==
    overlayAction\) return;/`), locking in the divergence.
  - *`_completeOverlay` (the DEFAULT hookDrain path):* the flag-OFF `else` adds an `isRunning()`
    guard (`if (target && (typeof target.isRunning!=="function"||target.isRunning()))`) absent from
    today's `if (cur === saved.baseAction)`, so a stopped base's weight is no longer restored under
    default flags.
  → **Fix:** move BOTH new guards strictly inside `if (CAST_OVERLAY_GUARD)`; make each `else` branch
    a *verbatim* copy of the current lines (the conditional-null + unconditional `cur===baseAction`
    check for onFinished; the bare `cur===saved.baseAction` restore for `_completeOverlay`). Update
    the PART 2 static assertion to look for the early-return only inside the guarded branch. H2 and
    H3 are already correctly gated (`if (CAST_OVERLAY_GUARD && …)` / `if (CAST_OVERLAY_GUARD)`), so
    they are byte-identical when OFF and need no change.

**MF2 — the "20/20 green" test claim is overstated.** I transcribed PART 1 verbatim and ran it:
**16 passed, 0 failed** (the contract has 16 behavioral checks, not 20). The logic is sound and all
green, but §0, §4.1, and §7 should say **16/16** (or add the 4 checks the prototype apparently
carried). PART 2's 6 static checks fail on the unpatched tree as expected; note MF1 requires editing
the PART 2 regex.

### MINOR (note; not blocking)

- **N1:** R-d cites `entities.js:9632-9658` for the `_unifiedSeq` cast reroute; the live reroute is
  `~9620-9656`. Also worth folding into F5's stale-comment list: `UNIFIED_CAST` is **default-ON**
  (`UNIFIED_DEFAULT`, @627/633) yet the `entities.js:9626` comment says "Default-off" — the packet's
  R-d already treats it as effectively active, so the model is right, only the cite/label drift.
- **N2:** F10 states the colored band as `0x10000128..0x10000134`; the actually-present inner cmds
  start at `0x1000012b` (0x128/129/12a absent). The load-bearing element — void Purple `0x10000132`
  present — is confirmed, so this is cosmetic. Likewise "modifiers … all `0x…000D`" — one key is
  `0x0000000F`; the claim "zero cast commands" still holds.

### Scope / regression check
No ACE edits, no wasm rebuild, JS-only, flag `=== "on"` ⇒ default-OFF (correct), url-flags row
drafted. Files touched stay within the declared scope (`entities.js`, `url-flags.md`, the new test,
the optional `test_ac_cast_over_locomotion.mjs` retarget). The validated `castMove`/`slideCast`/
`cmdInterp` Rust arbitration is untouched (H2/H3 are pure render-layer). With MF1 fixed, the flag-OFF
arm is byte-identical and the patch is safe to land after WS01 (shared-hot-path ordering per §6 R-a).

```json
{"workstream":"WS03","title":"Movement vs cast-animation interplay (S2)","packetPath":"/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/docs/spellcasting-packets-2026-07-12/WS03-movement-anim-interplay.md","confidence":"high","keyFindings":["The local cast overlay is inst.currentAction (entities.js:7261-7262), so every mid-cast locomotion setMotion crossFadeTo hard-cut .stop()s it (entities.js:2534-2540, CROSSFADE_S=0) — an outright STOP, not a mushy 50/50 blend; the mushy case is the SECONDARY link-keyed _tryPlayLink path","The stomp fires on every kind-61 DriveApplied — keyboard edges AND the use_time pump reclaim between windups (system.rs:2047,2171) — so even a steady held-W or a strafe kills the arms; ties S2 to S3","cancelCastSequence never explicitly stops the overlay; it relies on setMotion(Ready) crossFadeTo, which misses link-keyed overlays and leaves stale suppression bookkeeping (entities.js:6927-6939)","Exactly one input lane drives (cmdInterp default-ON → kind-61 live, legacy W3.1 dark) and Rust emits evict-before-drive (system.rs:2042-2048) so ordering can't interleave","DAT oracle: player MT 0x09000001 links[(Magic 0x49,Ready 0x03)] holds the full cast band (windups 0x1000006F-78, colored 0x10000128-134, gestures 0x4000002B-39); modifiers has ZERO cast cmds (stale test premise); castStateMachine/hookDrain/mtQueue are default-ON in browser (entities.js:919 comment stale)"],"filesToChange":["scene3d/entities.js","docs/url-flags.md","test_ws03_cast_overlay_guard.mjs","test_ac_cast_over_locomotion.mjs"],"needsWasmRebuild":false,"newFlags":["castOverlayGuard"],"risks":["entities.js setMotion/_suppressBaseCycleForOverlay/cancelCastSequence are shared hot paths — land after WS01; keep flag-off byte-identical","castOverlayGuard is RENDER-only and must not move any movement decision into JS or change the wire (composes with castMove/slideCast which own the Rust arbitration)","forward-edge anim-break suppresses the LOCAL predicted CasterEffect (unchanged; server 0xF755 still fires) — coordinate with the VFX workstream","overlaps S3 pump-reclaim movement; this fixes only the visual, deliberately not the authentic non-PK wire movement"]}
```

## INTEGRATION DISPOSITION (2026-07-12)

**Integrated: APPLIED with the verdict's two required corrections.** The verdict is
PARTIAL/apply=false only because of MF1 + MF2 (both "small, mechanical corrections — fix
them and this flips to CONFIRMED/apply=true"). Both are now fixed, so the endorsed patch
landed:

- **Flag** `?castOverlayGuard` — strict `=== "on"` opt-in, **default OFF** (feel change,
  1070 eye-test E1–E5 queued). Flag-off is byte-identical. Row added to `docs/url-flags.md`.
- **H1 (MF1 fix applied):** both restore paths — the non-drain `onFinished` in
  `_suppressBaseCycleForOverlay` and the hookDrain `_completeOverlay` — now put the new
  swap-safe guard STRICTLY INSIDE `if (CAST_OVERLAY_GUARD)`, and each `else` is a **verbatim**
  copy of the shipped code (onFinished: conditional-null + `cur === baseAction`;
  `_completeOverlay`: bare `cur === saved.baseAction`). Flag-OFF is now genuinely
  byte-identical (the packet's original H1 leaked the guard outside the gate — the defect
  MF1 called out). Verified with a dedicated static test (`restore early-return is INSIDE
  the flag gate` + `flag-OFF keeps the legacy same-action restore verbatim`).
- **H2 / H3:** already correctly gated (`if (CAST_OVERLAY_GUARD && …)` / `if
  (CAST_OVERLAY_GUARD)`); landed as written. Re-anchored by symbol (line numbers had
  shifted under WS01/WS02): H2 inserts before the `crossFadeTo(action, cacheKey,
  crossfadeDuration)` at the tail of `setMotion`; H3 in `cancelCastSequence` after the
  `_castBusyUntilMs = 0` line. All cited context re-verified against the live tree.
- **MF2 fix applied:** the "20/20 green" claim was overstated. The shipped test
  `tests/test_ws03_cast_overlay_guard.mjs` carries **16** behavioral PART-1 checks + **7**
  static PART-2 checks = **23/23 green** (`node tests/test_ws03_cast_overlay_guard.mjs`).
  PART 2's MF1 assertions confirm the early-return lives inside the flag gate and the
  legacy `else` survives verbatim.

**Not touched (deferred to the integration owner / WS01, per §4.2 + verdict "optional,
coordinate"):** `test_ac_cast_over_locomotion.mjs`. Its `modifiers`-hold-cast-gestures
premise is DAT-refuted (F10) and it reports RED **independently of this patch** (stale
premise, not a regression — it touches DAT data, not the overlay logic this WS changed).
WS01 already owns the corrected link-coverage assertion (`tests/test_ws01_windup_link_
coverage.mjs`, green). Leaving the stale test's retarget to whoever consolidates the
data-level suite avoids stepping on WS01's ownership.

**Scope:** JS-only, **no wasm rebuild** (no `.rs` touched). Sibling tests still green
(`test_ws01_windup_link_coverage`, `test_ws01_note_gating`, `test_ws02_cast_echo_dedup`).
`node --check scene3d/entities.js` clean. Land order honored (after WS01/WS02, which had
already re-touched the shared cast flags block + `setMotion`).

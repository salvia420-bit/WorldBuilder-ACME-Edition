# WS01 — Local windup gesture reliability ("arms don't always rise", S1a/S1b/S1e)

**Investigator:** WS01 · **Date:** 2026-07-12 · **Box:** GCE buildbox (read-only repo) ·
**Baseline:** `external/holtburger` @ `6fcff2f0` · **Confidence:** HIGH on root cause, MEDIUM on
exact live repro weighting (no live-server capture from this box — see §4 TODO).

Charter: own `playCastSequence → setSwingMotion → classifyMotionCommandTyped → wasm
lookupMotionLinkForSwing`. Verify player MT `0x09000001` link coverage of every cast-sequence
gesture (colored powerup band + talisman casts), fix the stance-falsy wasm bypass, the async
clip fetch racing short sleeps, and the F8-4 busy-window eating recasts. Add cheap link-miss
counters.

---

## 0. TL;DR

- **The link-miss hypothesis (S1a) is REFUTED for a player casting their own spells.** All **20**
  distinct gestures the cast-sequence JSON can emit are present in the player MotionTable's
  from-Ready link map for the Magic stance — including `0x10000132` (void Purple windup) and the
  entire talisman cast band `0x4000002B–0x40000039`. **DAT-proven + node-test-proven.**
- **The real "arms don't always rise" mechanism is a prediction-only animation path with silent
  failure modes.** On the local ACE box (near-zero RTT) the server's gesture echo is *reliably
  swallowed* by the default-ON `dispatchParity` dedup, so `playCastSequence` is the **sole**
  animator — and it (a) fire-and-forgets an async clip bake that can outlive a 50 ms windup sleep,
  (b) can look up the gesture under a **stale/NonCombat stance** (which carries *zero* magic
  gestures), and (c) **notes the prediction unconditionally even when it silently no-op'd**, which
  removes the echo safety net.
- **Three flags the code comments call "default OFF" are actually default-ON** in a browser
  (`castSpeed`, `castStateMachine`, `dispatchParity` all use the `!== "off"` idiom). This is
  corroborated by the 2026-07-11 USER 1070 SIGN-OFF list in `url-flags.md`. So the busy-window, the
  2× cast speed, and the echo dedup are all LIVE by default — which is exactly the combination that
  produces the intermittent symptom.

---

## 1. VERIFIED FINDINGS

### F1 — Player MT `0x09000001` links EVERY emitted cast gesture (S1a refuted) — **FACT (DAT + code + test)**

DAT oracle dump of player MotionTable `0x09000001` (269 KB, parsed 2026-07-12). Link outer key =
`(stance_low16 << 16) | from_substate_low16`; the Magic stance is low16 `0x0049`; swings/casts live
under `from-substate = Ready (0x0003)` (matches `lib.rs:7538-7541` and `entities.js:7199`
`fromMotion: READY_SUBSTATE`).

`links[(0x0049 << 16) | 0x0003]` inner MotionCommand keys (54 total) include the full bands:
```
windups : 0x1000006F..0x10000078 (MagicPowerUp01-10)  +  0x1000012B..0x10000134 (colored)
casts   : 0x4000002B..0x40000039 (MagicBlast..MagicPray, talisman)
```
Cross-checking against the 20 distinct motions the JSON actually emits (extracted from all 6,266
`sequences`):

| kind | distinct motions emitted by JSON | all linked from-Ready(Magic)? |
|---|---|---|
| windup | `0x10000070 0x10000072 0x10000074 0x10000076 0x10000078 0x10000132` | **YES (6/6)** |
| cast | `0x4000002B 2C 2D 2E 2F 30 31 33 34 35 36 37 38 39` | **YES (14/14)** |

`node test_ws01_windup_link_coverage.mjs` → `PASS: all 20 emitted gestures are linked from-Ready in
Magic stance (0x49).` Spell 2331 (`windup 0x10000132 MagicPowerUp08Purple → cast 0x40000035
MagicTransfer`), spell 1708 (Wedding Bliss, 3× windup), and spell 99 (war Blast) all resolve.

> **The charter's worry about the "colored band `0x10000128–0x1000012A`" is a red herring:** those
> three IDs are **TripleThrust melee attacks** (`lib.rs:7444` `0x1000011F..0x1000012A :
> Double/TripleSlash + Double/TripleThrust`), NOT magic powerups. The colored *magic* powerups
> begin at `0x1000012B`, and the JSON never emits `0x128/129/12A`. Confirmed both absent-from-link
> AND absent-from-emitted. **No unlinked gesture exists for the player's own casts.**

### F2 — The wasm lookup ALWAYS keys from Ready; retail's via-Ready fallback is therefore already effectively present — **FACT (code + decomp)**

`SessionHandle::lookupMotionLinkForSwing` (`src/lib.rs:33791-33810`) → `classify_motion_link_for_swing`
(`src/lib.rs:7522-7576`). Verbatim key construction (`:7533-7545`):
```rust
let resolved_stance = if stance == 0 { mtable.default_style } else { stance };
let outer_key = ((resolved_stance & 0xFFFF) << 16) | (MOTION_LINK_FROM_READY & 0xFFFF); // &0xFFFF = 0x0003
let inner_map = mtable.links.get(&outer_key)?;      // miss → None
let motion_data = inner_map.get(&command)?;          // full 32-bit command; miss → None
```
It walks `links[(stance, Ready)][fullCommand]` directly — **there is no deeper multi-hop fallback**.
Retail `CMotionTable::GetObjectSequence` (`acclient.c:337641`, re-read 2026-07-12) keys from the
*current* substate and falls back through `default_style` (`:337726-337734`):
```c
motiona = get_link(v8, v7->style, new_substate, ..., motion, speed_mod);   // direct
if ( !motiona && v11 != v7->style ) {
    motiona = get_link(v8, v7->style, new_substate, 1.0, v8->default_style, 1.0);   // curr → default
    link2   = get_link(v8, v8->default_style, mtype2, 1.0, v11, 1.0);               // default → action
}
```
**Because our wasm keys from Ready and every player cast gesture is *directly* in the from-Ready map
(F1), our outcome already matches retail for a stationary caster (whose substate IS Ready).**
Porting the multi-hop `default_style` route would be **dead code for the player MT** — nothing the
JSON emits is unreachable from Ready. (Kept as an explicit non-need; re-evaluate only if a future
creature-caster MT is found whose magic gestures live off-Ready.)

### F3 — NonCombat stance carries ZERO magic gestures → a stance mismatch is a silent miss — **FACT (DAT + test)**

`links[(0x003D << 16) | 0x0003]` (NonCombat from-Ready) has 125 inner keys but **none** of the
magic windup/cast commands the JSON emits:
```
0x10000070 inMagic=True inNonCombat=False     0x4000002B inMagic=True inNonCombat=False
0x10000072 inMagic=True inNonCombat=False     0x4000002E inMagic=True inNonCombat=False
0x10000078 inMagic=True inNonCombat=False     0x40000035 inMagic=True inNonCombat=False
0x10000132 inMagic=True inNonCombat=False     0x40000039 inMagic=True inNonCombat=False
```
Test: `PASS: 0 of 20 emitted magic gestures resolve under NonCombat (0x3d)`. **So if the gesture
lookup runs with the wrong (NonCombat) stance, `lookupMotionLinkForSwing` returns `None` → coarse
fallback → `canPlayReal === false` → SILENT NO-OP** (`entities.js:7163-7183`).

### F4 — `setSwingMotion` derives stance from a mutable field that can be stale/wrong — **FACT (code)**

`entities.js:7143-7147`:
```js
const stance =
  ((inst.currentStance ?? inst.lastStance ?? (typeof window !== "undefined" ? window.__getCurrentStanceLow?.() : 0)) ?? 0) >>> 0;
...
const result = classifyMotionCommandTyped(mtableId, stance, motionCmd >>> 0);
```
- `inst.currentStance` is stamped by `setMotion` (`:7701`) and `setLocalStance` (`:8218/8227`) from
  whatever `motionStance` the *last* motion carried.
- The `??` chain only falls through on **null/undefined** — a truthy-but-wrong `0x003D` (NonCombat)
  is used directly and never consults the (correct) `__getCurrentStanceLow()` fallback.
- `__getCurrentStanceLow()` itself defaults to `0x003D` (`index.html:2825`) and only advances on a
  kind=5 stance confirmation. So the value fed to the lookup is **never literally 0 in a browser**
  (the charter's "stance-falsy" framing) — the real failure mode is a **wrong** stance, not a zero
  one.
- The `?castMove`/kind=61 DriveApplied consumer re-stamps `inst.currentStance` on every move with
  `em.getStance(localGuid) || 0x8000003D` (`index.html:8143-8157`): if `getStance` is ever falsy
  (spawn / pre-first-combat-mode) it stamps **NonCombat**, which then sticks until the next
  magic-stance `setLocalStance`.

**Net:** in steady-state magic mode the happy path holds (stance stays `0x…49`), but there is a real
window — first cast after spawn/relog, or after a `getStance`-falsy locomotion stamp — where a cast
prediction runs under NonCombat and silently no-ops (F3). **The `entities.js:2277` guard `... &&
stance && ...` is a second, narrower bypass** (skips wasm entirely on falsy stance) but is largely
shadowed by the `0x003D` default; fixing 2277 alone does NOT fix magic casts because `default_style`
is NonCombat.

### F5 — On the local box, `dispatchParity` swallows the echo, so the prediction is the SOLE animator — **FACT (code + node)**

`dispatchParity` gates `consumeLocalSwingEcho` in the KIND_MOTION_ACTION arm (`loop.js:2605-2610`).
The note has a **500 ms** expiry (`entities.js:6623`). On the dev laptop ACE is local (RTT ≈ 0), so
the windup echo arrives well within 500 ms and is consumed → **no `setMotion` from the echo path**.
The only thing that can raise the arms is `playCastSequence`'s own `setSwingMotion`.

> **Comment-vs-code drift (verify-your-cites, project law):** `loop.js:291` comment says
> `?dispatchParity=on (default-off)`, but the code at `:304` is `.get("dispatchParity")?.toLowerCase()
> !== "off"` → **default-ON**. `node` confirms: `no-param dispatchParity !== off : true`. Foundation
> §1.5 and `url-flags.md:12` (2026-06-17 "now default-ON" list) both confirm default-ON. The inline
> comment is stale.

### F6 — `noteLocalSwingPrediction` fires UNCONDITIONALLY, even when the prediction silently no-op'd — **FACT (code)**

`entities.js:6811-6812`:
```js
this.setSwingMotion(g, motionU32, { speed: CAST_SPEED });     // async, NOT awaited
if (CAST_SPEED !== 1.0) this.noteLocalSwingPrediction?.(motionU32);   // fires regardless of success
```
`setSwingMotion` returns nothing and is fire-and-forget; the note is recorded synchronously. So when
`setSwingMotion` silently no-ops (F3 stance miss, F7 cold-fetch race, any link miss), the note is
**still** placed, and F5's dedup then swallows the only other chance to animate. **Result: arms
don't rise for that gesture.** This is the single highest-value bug in the chain.

### F7 — `setSwingMotion` fire-and-forget bake can outlive the windup sleep — **FACT (code)**

`playCastSequence` deliberately does not await `setSwingMotion` and paces the chain with
`setTimeout(max(50, durationS*1000/CAST_SPEED))` (`entities.js:6816`). `setSwingMotion` awaits
`animationCache.get(...)` (`entities.js:7188-7201`), which on a **cold** entry calls the wasm
`fetchEntityAnimationKeyframes` to bake the clip (`animation.js:603-619`). On the first cast of a
given gesture the bake can exceed a 50 ms sleep, so the gesture's `action.play()` lands **after** the
chain moved on (or after `cancelCastSequence` recoiled to Ready — and `setSwingMotion` has **no
cancellation-token awareness**, so it plays a stale windup pose late). The cache is promise-keyed and
idempotent (`animation.js:593-601`), so a prefetch at chain start is a clean fix.

### F8 — `castSpeed` and `castStateMachine` are ALSO default-ON despite "Default OFF" comments — **FACT (node + url-flags)**

`entities.js:903-911` (`CAST_SPEED`) and `:920-927` (`CAST_STATE_MACHINE`) both use the `!== "off"`
idiom. `node` verification:
```
no-param castSpeed !== off        : true   → CAST_SPEED = 2.0 (default-ON)
no-param castStateMachine !== off : true   → CAST_STATE_MACHINE = true (default-ON)
```
Corroborated by `url-flags.md:12` (`castSpeed`, `castStateMachine`, `castFizzle` in the "now
default-ON, signed off 2026-07-11" list) and foundation §1.2 ("CAST_SPEED = 2.0 default"). The inline
`entities.js` comments ("Default OFF pending a 1070 eye-test") are **stale**. Consequences: `CAST_SPEED
!= 1.0` is always true → F6's note always fires; the busy window (F9) is always active.

### F9 — The F8-4 busy window drops recasts unconditionally; UseDone (kind=14) clears it — **FACT (code)**

`entities.js:6764-6772`: any re-entry while `now < inst._castBusyUntilMs` returns early (drops the
local prediction), window = `min(12000, estMs / CAST_SPEED)` (~0.8–1.6 s typical at 2×). Cleared by
UseDone kind=14 → `clearCastBusy` (`index.html:7851-7860`), fizzle → `cancelCastSequence`
(`:7832-7842`), and the kind=61/W3.1 anim-break cut. Because it does not key on spellId, a **legit
different-spell weave** within the window is dropped, and its arms then depend entirely on the echo
path (F5) — which, if a *stale same-command note* is still alive, is itself swallowed. This is the
"busy window eating server-accepted recasts" the charter names. (Not catastrophic when the echo is
un-noted, but a real feel/reliability gap; interacts with WS08/WS14 recast work.)

### F10 — Classification of the emitted commands is correct — **FACT (code)**

`classify_command_kind` (`lib.rs:7440-7505`): `0x4xxxxxxx → ("cast", None)`; `0x1000006F/70/72/74/76/78`
and `0x10000132` have no height bucket → `("swing", None)`. `canPlayReal` accepts `kind ∈
{swing,cast}` (`entities.js:7163-7167`). So *when the stance is right and the clip is warm*, every
emitted gesture classifies and plays. The failures are stance/timing/dedup, not classification.

---

## 2. ROOT CAUSES (mechanism, ranked)

**RC-1 (primary, intermittent) — prediction-only path + unconditional note + silent no-op.**
On the local box the echo is swallowed (F5), so `playCastSequence` is the only animator. Its
`setSwingMotion` can silently no-op via a cold-fetch race (F7) or a stale/NonCombat stance (F3+F4),
yet `noteLocalSwingPrediction` fires anyway (F6), swallowing the echo safety net. → arms don't rise,
intermittently, exactly matching "not *always* rising." Proven by code trace; the exact
race-vs-stance weighting needs a live capture (§4).

**RC-2 (secondary, narrow) — stance mismatch.** First cast after spawn/relog or after a
`getStance`-falsy locomotion stamp runs the lookup under NonCombat, which has zero magic gestures
(F3). DAT-proven that this is a hard miss.

**RC-3 (tertiary, feel) — busy window drops legit recasts** (F9), leaving them to the echo path,
which a stale note can swallow.

**NOT a cause (refuted):** unlinked emitted gestures (F1 — all 20 linked), the colored
`0x128–0x12A` band (melee, never emitted), and any need for a via-Ready fallback port (F2 — already
effectively present).

---

## 3. PATCH PLAN (minimal, flag-gated per url-flags conventions)

All hunks are `scene3d/entities.js` unless noted. New consts go beside the existing cast flags
(~`entities.js:895-927`). Diag counters (Patch E) are diag-only → no flag (§4.3 "HUD/UI-only skip
flags"). **Recommend one umbrella flag `?castReliability` (default-ON, `=off` escape) for A+B+C** —
they are a cohesive "make the local cast prediction actually animate" fix and eye-test together; the
laptop may split into `castStance`/`castPrefetch`/`castEchoFallback` if the A/B needs to isolate.

### New consts (add after `CAST_STATE_MACHINE`, ~`entities.js:927`)
```js
// WS01 (2026-07-12) — `?castReliability=off` to disable (DEFAULT-ON). Bundles three
// correctness fixes to the LOCAL cast prediction so the arms actually rise: (a) look the
// gesture up under the Magic stance explicitly; (b) prefetch every chain clip up front; (c)
// only note the swing-echo dedup when the prediction will actually animate. `=off` = today.
const CAST_RELIABILITY = (() => {
  try {
    return typeof window !== "undefined" && window.location &&
      new URLSearchParams(window.location.search).get("castReliability")?.toLowerCase() !== "off";
  } catch (_) { return false; }
})();
// WS01 — `?castBusyScope=on` (DEFAULT-OFF, feel): scope the F8-4 busy drop to the SAME spellId
// so a different-spell weave still animates locally. Rides `?castStateMachine`.
const CAST_BUSY_SCOPE = (() => {
  try {
    return typeof window !== "undefined" && window.location &&
      new URLSearchParams(window.location.search).get("castBusyScope")?.toLowerCase() === "on";
  } catch (_) { return false; }
})();
// WS01 — the only magic stance retail uses (low16; wasm masks &0xFFFF). index.html:2856.
const CAST_MAGIC_STANCE = 0x0049;
```

### Patch A — pass the Magic stance explicitly (fixes RC-2)

`setSwingMotion` accepts an `opts.stance` override; `playCastSequence` supplies `CAST_MAGIC_STANCE`.
```diff
@@ entities.js:7143 (setSwingMotion)
-    const stance =
-      ((inst.currentStance ?? inst.lastStance ?? (typeof window !== "undefined" ? window.__getCurrentStanceLow?.() : 0)) ?? 0) >>> 0;
+    // WS01: a caller may pin the stance (the cast chain always uses Magic 0x0049) so a stale
+    // `inst.currentStance` (e.g. NonCombat, which carries NO magic gestures — DAT-verified vs
+    // player MT 0x09000001) can't make the from-Ready link lookup silently miss.
+    const stance =
+      (((opts && opts.stance) ? (opts.stance >>> 0) : 0) ||
+       ((inst.currentStance ?? inst.lastStance ?? (typeof window !== "undefined" ? window.__getCurrentStanceLow?.() : 0)) ?? 0)) >>> 0;
```

*(Secondary, optional — the charter's literal `entities.js:2277` fix. Include only alongside A; on
its own it does NOT fix magic casts because `default_style` is NonCombat.)*
```diff
@@ entities.js:2277 (classifyMotionCommandTyped)
-  if (wasmReady && motionTableId && stance && motionCmd) {
+  // WS01: don't bypass the wasm lookup on a falsy stance — the wasm resolves stance==0 to the
+  // MotionTable default_style (lib.rs classify_motion_link_for_swing), strictly more resolvable
+  // than the coarse fallback. (Cast gestures still need the explicit Magic stance — see
+  // setSwingMotion opts.stance — since default_style is NonCombat.)
+  if (wasmReady && motionTableId && motionCmd) {
```

### Patch B — prefetch all chain clips at chain start (fixes RC-1 cold-fetch race)

New helper + a call before the paced loop. Cache is promise-keyed/idempotent, so the per-gesture
`setSwingMotion` below reuses these exact entries (same `fromMotion: READY_SUBSTATE`, same stance,
same meta).
```diff
@@ entities.js:6824 (just before `for (const gesture of (seq.windupGestures || []))`)
+    // WS01: warm the animationCache for EVERY gesture up front, in parallel, so the
+    // fire-and-forget bake in setSwingMotion can't outlive a min-50ms windup sleep and leave
+    // the arms unraised. Await-capped so a slow/hung bake never blocks the cast.
+    if (CAST_RELIABILITY) { try { await this._prefetchCastClips(g, seq); } catch (_) {} }
     // Chain: windup gestures in order, then the cast gesture.
     for (const gesture of (seq.windupGestures || [])) {
```
New method (place next to `setSwingMotion`):
```js
// WS01 (2026-07-12) — pre-bake every clip a cast chain will need so setSwingMotion hits a warm,
// promise-keyed cache (animation.js:593) instead of racing a cold bake against a 50ms sleep.
async _prefetchCastClips(guid, seq) {
  const inst = this.entityMap.get(guid >>> 0);
  const fetchKeyframes = this.wasmExports?.fetchEntityAnimationKeyframes;
  if (!inst || typeof fetchKeyframes !== "function" || !this.animationCache) return;
  const setupId  = (inst.meta?.modelId ?? inst.meta?.setupId ?? 0) >>> 0;
  const mtableId = (inst.meta?.mtableId ?? 0) >>> 0;
  const opts = {
    modelChanges:   inst.meta?.modelChanges ?? new Uint32Array(0),
    textureChanges: inst.meta?.textureChanges ?? new Uint32Array(0),
    paletteId:      (inst.meta?.paletteId ?? 0) >>> 0,
    paletteSubsFlat: inst.meta?.subPalettes ?? new Uint32Array(0),
    fromMotion: READY_SUBSTATE,
  };
  const gestures = [...(seq.windupGestures || [])];
  if (seq.castGesture) gestures.push(seq.castGesture);
  const toU32 = (m) => {
    if (typeof m === "number") return m >>> 0;
    const s = String(m); const p = (s.startsWith("0x") || s.startsWith("0X")) ? parseInt(s, 16) : parseInt(s, 10);
    return Number.isFinite(p) && p >= 0 ? (p >>> 0) : 0;
  };
  const warms = [];
  for (const gz of gestures) {
    const c = window.__classifyMotionCommandTyped?.(mtableId, CAST_MAGIC_STANCE, toU32(gz.motion));
    if (c && c.source === "wasm-link" && (c.resolvedCommand >>> 0) !== 0) {
      warms.push(this.animationCache.get(setupId, mtableId, c.resolvedCommand >>> 0, CAST_MAGIC_STANCE, fetchKeyframes, opts).catch(() => {}));
    }
  }
  if (!warms.length) return;
  // Cap so a hung bake never blocks casting (~200ms is imperceptible vs a ~2s cast).
  await Promise.race([Promise.all(warms), new Promise((r) => setTimeout(r, 200))]);
}
```

### Patch C — note the prediction ONLY when it will animate (fixes RC-1 echo-swallow)

Replace `entities.js:6811-6812`. A synchronous `classifyMotionCommandTyped` pre-check mirrors
`canPlayReal` without awaiting the bake; the note is placed only when the gesture resolves, so a
failed prediction leaves the echo as the safety net.
```diff
@@ entities.js:6811 (inside playGesture)
-        this.setSwingMotion(g, motionU32, { speed: CAST_SPEED });
-        if (CAST_SPEED !== 1.0) this.noteLocalSwingPrediction?.(motionU32);
+        const mtableId = (inst.meta?.mtableId ?? 0) >>> 0;
+        const c = CAST_RELIABILITY
+          ? window.__classifyMotionCommandTyped?.(mtableId, CAST_MAGIC_STANCE, motionU32)
+          : null;
+        const willPlay = !CAST_RELIABILITY ||
+          !!(c && (c.kind === "swing" || c.kind === "cast") && (c.resolvedCommand >>> 0) !== 0 && c.source === "wasm-link");
+        this._castDiag("attempts"); if (!willPlay) this._castDiag("linkOrStanceMiss");
+        this.setSwingMotion(g, motionU32, CAST_RELIABILITY
+          ? { speed: CAST_SPEED, stance: CAST_MAGIC_STANCE }
+          : { speed: CAST_SPEED });
+        // Only note the prediction when it will actually animate — otherwise the default-ON
+        // dispatchParity echo dedup swallows the server echo too and NOTHING raises the arms.
+        if (CAST_SPEED !== 1.0 && willPlay) this.noteLocalSwingPrediction?.(motionU32);
```

### Patch D — scope the busy drop to the same spellId (fixes RC-3; feel-gated)

```diff
@@ entities.js:6764 (playCastSequence F8-4 gate)
     if (CAST_STATE_MACHINE) {
       const nowMs = performance.now();
-      if (inst._castBusyUntilMs && nowMs < inst._castBusyUntilMs) {
-        return; // already casting — ignore the recast
-      }
+      // WS01: `?castBusyScope=on` restricts the drop to a repeat of the SAME spell (spam-click
+      // protection); a different-spell weave the server will accept still animates locally.
+      const sameSpell = !CAST_BUSY_SCOPE || (inst._castBusySpellId === (spellId >>> 0));
+      if (sameSpell && inst._castBusyUntilMs && nowMs < inst._castBusyUntilMs) {
+        this._castDiag("busyDropped");
+        return; // already casting this spell — ignore the recast
+      }
       let estMs = 0;
       for (const gz of (seq.windupGestures || [])) estMs += (+gz.durationS || 0.6) * 1000;
       if (seq.castGesture) estMs += (+seq.castGesture.durationS || 0.6) * 1000;
       inst._castBusyUntilMs = nowMs + Math.min(12000, estMs / CAST_SPEED);
+      inst._castBusySpellId = (spellId >>> 0);
     }
```

### Patch E — cheap cast diag counters (diag-only, no flag; coordinate schema with WS16)

```js
// WS01 (2026-07-12) — cheap link-miss / reliability counters. WS16 owns the final
// `window.__diag.cast` schema; this lazy-inits and merges so multiple workstreams can attach.
_castDiag(field) {
  try {
    if (typeof window === "undefined") return;
    const d = (window.__diag || (window.__diag = {}));
    const c = (d.cast || (d.cast = { attempts: 0, linkOrStanceMiss: 0, busyDropped: 0, echoSwallowed: 0 }));
    c[field] = (c[field] | 0) + 1;
  } catch (_) {}
}
```
(Optionally bump `echoSwallowed` in `loop.js:2606` when `consumeLocalSwingEcho` returns true, to
measure how often the echo is deduped — one line, diag-only.)

### url-flags.md rows (drafted, format `| Flag | Values | Default | Effect | Where |`)
```
| `castReliability` | `off` to disable | **on** | WS01: make the LOCAL cast prediction actually raise the arms — (a) pass the Magic stance (0x0049) explicitly to setSwingMotion so a stale inst.currentStance=NonCombat can't miss the from-Ready magic link (NonCombat carries 0 magic gestures — DAT-verified vs player MT 0x09000001); (b) prefetch/warm every chain clip up front (await-capped 200ms) so the fire-and-forget bake can't outlive a min-50ms windup sleep; (c) only noteLocalSwingPrediction when the gesture actually resolves, so the default-ON dispatchParity echo dedup can't swallow the server echo when the prediction silently no-op'd. `=off` = pre-WS01 behavior. Pending 1070 eye-test. | scene3d/entities.js |
| `castBusyScope` | `on` to enable | off | WS01: scope the F8-4 cast-busy drop to the SAME spellId (spam-click protection only) so a different-spell recast the server will accept still animates its windup locally. Rides `?castStateMachine`. `=on` pending 1070 recast-feel eye-test. | scene3d/entities.js |
```

---

## 4. TESTS

### 4.1 Node unit test (data-level, runs on this box) — ADD `test_ws01_windup_link_coverage.mjs`

Proves F1 + F3. Written and **PASSING** on this box today (against the real
`data/spell-cast-sequence.json` + a DAT-oracle-captured link fixture):
```
PASS: all 20 emitted gestures are linked from-Ready in Magic stance (0x49).
PASS: 0 of 20 emitted magic gestures resolve under NonCombat (0x3d) — stance mismatch = silent miss, confirmed.
ALL PASS
```
Test source (drop into `apps/holtburger-web/`; fixture regen recipe in 4.3):
```js
import fs from "node:fs";
const REPO = process.env.HOLT || ".";
const seqs = JSON.parse(fs.readFileSync(`${REPO}/data/spell-cast-sequence.json`)).sequences;
const fix  = JSON.parse(fs.readFileSync("tests/fixtures/ws01_player_mt_fromReady.json"));
const magic     = new Set(fix.magicStance_0x49.map((s) => parseInt(s, 16) >>> 0));
const noncombat = new Set(fix.nonCombatStance_0x3d.map((s) => parseInt(s, 16) >>> 0));
const norm = (m) => { const s = String(m); return (s.toLowerCase().startsWith("0x") ? parseInt(s,16) : parseInt(s,10)) >>> 0; };
const emitted = new Set();
for (const e of Object.values(seqs)) {
  for (const wg of e.windupGestures || []) emitted.add(norm(wg.motion));
  if (e.castGesture?.motion != null) emitted.add(norm(e.castGesture.motion));
}
let fail = 0;
const missMagic = [...emitted].filter((m) => !magic.has(m));
if (missMagic.length) { fail++; console.log("FAIL unlinked in Magic:", missMagic.map((m)=>"0x"+m.toString(16))); }
else console.log(`PASS: all ${emitted.size} emitted gestures linked from-Ready in Magic (0x49).`);
const magicClass = [...emitted].filter((m) => (m & 0xf0000000) === 0x10000000 || (m & 0xf0000000) === 0x40000000);
const ncResolvable = magicClass.filter((m) => noncombat.has(m));
if (ncResolvable.length) { fail++; console.log("FAIL magic resolves under NonCombat:", ncResolvable.map((m)=>"0x"+m.toString(16))); }
else console.log(`PASS: 0 of ${magicClass.length} emitted magic gestures resolve under NonCombat (0x3d).`);
process.exit(fail ? 1 : 0);
```
Fixture (`tests/fixtures/ws01_player_mt_fromReady.json`, captured today) — arrays elided for brevity;
regen via 4.3. Shape:
```json
{ "magicStance_0x49": ["0x1000006f", "...", "0x44000007"], "nonCombatStance_0x3d": ["0x...", "..."] }
```

### 4.2 Node behavior test (logic-level) — recommend `test_ws01_note_gating.mjs`
Stub an `EntityManager`-like object with a fake `classifyMotionCommandTyped` that returns
`source:"coarse-fallback"` for one gesture and `"wasm-link"` for another; assert Patch C calls
`noteLocalSwingPrediction` **only** for the resolvable one (i.e. the echo remains un-noted for the
miss). Pure JS, no wasm needed.

### 4.3 TODO-FOR-LAPTOP — regenerate the link fixture from the DAT oracle (keeps 4.1 non-stale)
```bash
echo '{"command":"chorizite-parse-dat-record","datPath":"/home/wbterminal/ac_base_dats/client_portal.dat","idHex":"0x09000001","typeName":"MotionTable"}' \
 | DOTNET_ROLL_FORWARD=LatestMajor dotnet /home/wbterminal/WorldBuilder-ACME-Edition/WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll --stdin \
 | tail -1 | python3 -c 'import sys,json; \
   mt=json.load(sys.stdin)["fields"]["links"]; \
   g=lambda st: sorted("0x%08x"%(int(x)&0xffffffff) for x in mt[str((st<<16)|0x3)]["motionData"]); \
   print(json.dumps({"magicStance_0x49":g(0x49),"nonCombatStance_0x3d":g(0x3d)},indent=1))' \
 > tests/fixtures/ws01_player_mt_fromReady.json
```

### 4.4 TODO-FOR-LAPTOP — live headless repro of the symptom + fix (needs live ACE)
Foundation §5 headless bot. **Bare default** first, then `?castReliability=off` vs on.
```
URL: http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&renderOnDemand=1&netDrainHz=30&autoLogin=1&account=X&password=X&autoSpawn=first&kickDance=1&agent=1
```
Console instrumentation to drive + observe (poll `window.__bootState==='in-world'` first):
```js
// 1) Force a cold-cache first cast right after entering magic mode (the RC-1/RC-2 window).
window.__diag.cast && (window.__diag.cast.attempts = 0, window.__diag.cast.linkOrStanceMiss = 0);
// arm+cast a known-good war Blast (spell 99) at self or a target guid:
const g = window.getLocalPlayerGuid();
window.__sessionHandle.castTargetedSpell(g, 99);          // or via combat-bar arm + click
// 2) After ~2.5s read the counters:
console.log('cast diag:', JSON.stringify(window.__diag.cast));
// EXPECT (bug, ?castReliability=off): occasional linkOrStanceMiss>0 on the first post-spawn cast,
//   and/or a visibly late/absent arm-raise on the FIRST cast of each distinct gesture (cold bake).
// EXPECT (fix, default/on): linkOrStanceMiss==0, arms rise on every cast incl. the first.
// 3) Recast-eat repro: cast spell A, then within ~1s cast a DIFFERENT spell B.
//   ?castStateMachine on + castBusyScope off  → B's local windup dropped (busyDropped++).
//   ?castBusyScope=on                          → B animates; busyDropped unchanged for B.
```
Also capture, per foundation §1.5, whether the UpdateMotion windup echo carries stance 0 vs
`0x80000049` (drives whether the echo path can independently raise arms) — read
`__diag.wire.summary()` around a cast and grep for 0xF74C.

---

## 5. EYE-TEST QUEUE (1070 GPU box — batch, do NOT run here)

| # | Flag combo | Spell / action | Expected visual |
|---|---|---|---|
| E1 | bare default (all WS01 fixes ON) | Enter magic mode, immediately cast war Blast (spell 99) at a target | Arms rise on the **first** cast (no cold-bake miss); windup → blast gesture → bolt launches after the gesture, not during. |
| E2 | `?castReliability=off` (A/B control) | same as E1, repeated ~10× incl. first-after-relog | Reproduce the bug: occasional first-cast / first-of-gesture arms-don't-rise. Confirms the fix delta. |
| E3 | default | Void self-buff spell 2331 (single Purple windup `0x10000132` → MagicTransfer) | Purple powerup windup + transfer gesture both play (colored-band coverage in the live rig). |
| E4 | default | Wedding Bliss 1708 (3× windup self chain) | All three windups animate in sequence (no mid-chain drop from the fetch race). |
| E5 | `?castBusyScope=on` vs off | Cast spell A, then a DIFFERENT spell B within ~1s | on: B's windup animates locally; off: B shows no local windup until the echo. Judge which recast feel is preferred (feeds WS08/WS14). |
| E6 | default + `?castMove` dance | Multi-windup war spell while tapping W/A/D (slidecast) | Fixes must not regress the strafecast dance — the anim-break cut (`cancelCastSequence`) still cleanly cuts on a forward tap. |

---

## 6. RISKS + cross-workstream interactions

**Files WS01 would touch (for integration ordering):**
- `scene3d/entities.js` — Patches A, B, C, D, E + new consts. **Primary.**
- `scene3d/loop.js` — Patch E optional one-liner (`echoSwallowed` counter at `:2606`). Shared with
  WS-echo/dispatch work.
- `index.html` — **no functional change required**; optional: correct the stale
  "Default OFF" nature of `castSpeed`/`castStateMachine` is a *comment/doc* fix, not code.
- `docs/url-flags.md` — 2 new rows (§3). Doc-only.
- `tests/…` — new `.mjs` + fixture (§4). Test-only.
- **No wasm rebuild required** — the wasm `lookupMotionLinkForSwing` is already correct (F1/F2);
  all fixes are JS-side. This keeps WS01 out of the single-rebuild integration bottleneck (§4.4 law).

**Risks:**
- **R1 (low):** Patch A pins the cast lookup to Magic stance. Safe because the server only accepts a
  cast in Magic stance and `picking.js:602` gates the send on `isInMagicStance()`. If a plugin ever
  fires `playCastSequence` outside magic mode, the gesture would previously have missed anyway; now
  it force-resolves the magic clip on a non-magic rig — cosmetically odd but harmless, and still
  behind `?castReliability=off`.
- **R2 (low):** Patch C's synchronous `classifyMotionCommandTyped` pre-check duplicates the wasm
  lookup `setSwingMotion` also runs (2× per gesture). The lookup is a cheap in-memory `HashMap` walk
  on an already-cached MotionTable; negligible. If measured hot, thread the result into
  `setSwingMotion` instead.
- **R3 (low):** Patch B's 200 ms await cap adds ≤200 ms to the *first* cast of a session (cache
  cold). Imperceptible vs a ~2 s cast; zero on warm casts. Never blocks (capped).
- **R4 (medium, cross-WS):** the note-gating (C) changes which echoes get deduped — coordinate with
  whoever owns `dispatchParity`/`consumeLocalSwingEcho` (echo/remote-caster WS, likely WS06/WS07).
  If they change the dedup window or make the echo the primary animator, C's "note only on success"
  still composes (it strictly *reduces* false dedups).
- **R5 (cross-WS):** `window.__diag.cast` schema — **coordinate with WS16** (diag/telemetry owner).
  Patch E uses a defensive lazy-init merge so WS16 can own/extend the object; field names
  (`attempts/linkOrStanceMiss/busyDropped/echoSwallowed`) are a proposal.
- **R6 (cross-WS):** busy-window scoping (D) touches recast feel — hand off the E5 finding to
  WS08/WS14 (recast/queue feel) before flipping `castBusyScope` default.
- **R7 (doc-drift, low):** three inline comments (`entities.js:896`, `:913`, `loop.js:291`) say
  "Default OFF" for flags that are default-ON. Not a code bug (behavior matches url-flags + the
  2026-07-11 sign-off) but misleading; recommend a one-line comment correction during integration.

---

## Evidence index (re-verify before patching — cites opened live 2026-07-12)
- `entities.js:6728-6912` playCastSequence · `:6764-6772` busy window · `:6811-6812` note ·
  `:6825-6831` chain · `:6927-6939` cancelCastSequence · `:7138-7337` setSwingMotion ·
  `:7163-7183` canPlayReal/no-op lattice · `:7199` fromMotion READY · `:2272-2330`
  classifyMotionCommandTyped · `:2277` stance guard · `:6368-6377` getStance · `:6619-6637` dedup ·
  `:8199-8228` setLocalStance · `:903-927` CAST_SPEED/CAST_STATE_MACHINE defaults.
- `src/lib.rs:33791-33810` lookupMotionLinkForSwing · `:7522-7576` classify_motion_link_for_swing ·
  `:7434` MOTION_LINK_FROM_READY=0x41000003 · `:7440-7505` classify_command_kind.
- `index.html:2825/2855-2874` stance consts · `:4108-4126` local kind=5 → setLocalStance ·
  `:7832-7860` fizzle/UseDone clear · `:8085-8177` kind=61 DriveApplied · `:8143-8157` getStance||NonCombat.
- `loop.js:291-309` dispatchParity default · `:2585-2627` _armMotionAction echo.
- `animation.js:564-619` cache.get (promise-keyed, idempotent).
- `acclient.c:337641-337760` GetObjectSequence (via-default-style fallback `:337726-337734`) ·
  `:337585` get_link.
- DAT oracle: player MT `0x09000001` from-Ready(0x0003): Magic(0x49)=54 keys, NonCombat(0x3d)=125
  keys; all 20 JSON-emitted gestures ∈ Magic, 0 ∈ NonCombat (node test PASS).

```json
{"workstream":"WS01","title":"Local windup gesture reliability (arms not rising, S1a/S1b/S1e)","packetPath":"/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/docs/spellcasting-packets-2026-07-12/WS01-windup-link-reliability.md","confidence":"high","keyFindings":["S1a REFUTED: all 20 gestures the cast-sequence JSON emits (incl 0x10000132 + talisman 0x4000002B-39) are linked from-Ready in player MT 0x09000001 Magic stance; the colored 0x128-12A band is melee TripleThrust, never emitted","wasm lookupMotionLinkForSwing already keys from-Ready and needs no via-Ready fallback port for the player MT","RC-1: on the local box (RTT~0) dispatchParity dedup (default-ON) swallows the server echo, so playCastSequence is the sole animator, yet it notes the prediction UNCONDITIONALLY even when setSwingMotion silently no-ops (cold-bake race or stale/NonCombat stance) -> arms don't rise","NonCombat from-Ready carries ZERO magic gestures (DAT-proven) so a stance mismatch is a hard silent miss; setSwingMotion derives stance from a mutable field that can be stale","castSpeed, castStateMachine, dispatchParity all say 'Default OFF' in comments but are default-ON via the !==\"off\" idiom (node-verified; url-flags 2026-07-11 sign-off confirms)"],"filesToChange":["scene3d/entities.js","scene3d/loop.js","docs/url-flags.md","tests/test_ws01_windup_link_coverage.mjs","tests/fixtures/ws01_player_mt_fromReady.json"],"needsWasmRebuild":false,"newFlags":["castReliability","castBusyScope"],"risks":["note-gating changes which echoes dedup - coordinate with dispatchParity/echo owner (WS06/WS07)","__diag.cast schema - coordinate with WS16","busy-window scoping touches recast feel - hand E5 to WS08/WS14","Patch A pins cast lookup to Magic stance (safe: server+picking gate casts on magic stance)","stale 'Default OFF' comments on default-ON cast flags (doc-drift, not code bug)"]}
```

---

## VERDICT (WS01-verify)

**Verifier:** adversarial WS01-verify · **Date:** 2026-07-12 · **Box:** GCE buildbox (read-only
repo, DAT oracle live) · **Verdict: PARTIAL** — the *diagnosis* is empirically CONFIRMED end-to-end;
the *patch plan* needs 3 corrections before it is project-law-clean. **apply: true** (integrate the
core A/B/C/D/E patches WITH the fixes below).

### What I independently re-verified (all CONFIRMED)

Every load-bearing claim was re-checked by opening the live file and/or re-running the oracle — not
by trusting the packet.

- **F1 (the whole S1a refutation) — CONFIRMED by my own DAT dump + JSON extraction, not the packet's
  fixture.** I re-ran the oracle on player MT `0x09000001` (269 227 bytes; `defaultStyle: NonCombat`),
  extracted `links[(0x49<<16)|0x3]` = **54** inner keys and `links[(0x3d<<16)|0x3]` = **125** keys, and
  independently parsed all **6266** entries of `data/spell-cast-sequence.json` → exactly **6 windups**
  (`0x10000070/72/74/76/78/132`) + **14 casts** (`0x4000002B–2F,30,31,33–39`). **All 20 ∈ Magic
  from-Ready; 0 ∈ NonCombat.** `0x10000128` is absent-as-magic (melee TripleThrust per
  `lib.rs:7444/7485`), `0x1000012B` and `0x10000132` present. The packet's numbers are exact.
- **F2** — `classify_motion_link_for_swing` (`lib.rs:7522-7576`): masks `stance & 0xFFFF`
  (`:7541`), keys only from Ready (`MOTION_LINK_FROM_READY=0x41000003` `:7434`), no multi-hop
  `default_style` fallback. Confirmed. The DAT-side bake helpers ALSO mask `stance & 0xFFFF`
  (`:6440/6452/6959`), so Patch A passing low16 `0x0049` resolves the **identical** clip as the
  current full `0x80000049` — **no bake regression**.
- **F3/F4** — NonCombat from-Ready carries 0 magic gestures (my dump). `setSwingMotion` stance from
  `inst.currentStance` (`:7143-7144`); kind=61 code-3 arm stamps `em.getStance(localGuid) ||
  0x8000003d` (index.html:8143-8147) → NonCombat when `getStance` is falsy. `defaultStyle=NonCombat`
  DAT-confirmed. **Extra corroboration the packet under-sells:** the send-gate `isInMagicStance()`
  (picking.js:602) reads the *index.html module var* `currentStanceLow`, a DIFFERENT variable from the
  entity field `inst.currentStance` the animation reads — so the cast can legally SEND (stance var =
  Magic) while the gesture lookup MISSES (entity field = stale NonCombat). This decoupling makes RC-2
  more plausible, not less.
- **F5** — `DISPATCH_PARITY_ON` = `…get("dispatchParity") !== "off"` (loop.js:304) = **default-ON**
  despite the `:291` "default-off" comment; 500 ms note expiry (`:6623`); gate at `loop.js:2605-2610`.
  Confirmed. (Note: the echo is swallowed even at *retail* RTT — RTT rarely >500 ms — so the
  prediction is effectively the SOLE animator universally, not only on the local box. That
  *strengthens* RC-1 and the value of Patch C.)
- **F6/F7/F9/F10** — note fires unconditionally (`:6811-6812`), fire-and-forget bake vs `max(50,…)`
  sleep (`:6816`), promise-keyed idempotent cache (`animation.js:564-619`), busy window (`:6764-6772`)
  cleared by UseDone kind=14→`clearCastBusy` / fizzle 0x0402→`cancelCastSequence` (index.html), and
  `classify_command_kind` (`lib.rs:7440-7505`) all confirmed verbatim.
- **F8** — `CAST_SPEED`/`CAST_STATE_MACHINE` use the `!== "off"` idiom (`entities.js:903-927`) =
  default-ON; `url-flags.md:12` lists `castSpeed`/`castStateMachine`/`castFizzle`/`dispatchParity` in
  the "Now default-ON" sign-off. The inline "Default OFF" comments are stale. Confirmed.
- **Patch contexts A/B/C/D** all exact-match the current tree at the cited lines. **Patch A is
  backward-compatible** — I enumerated all 6 `setSwingMotion` callers (picking.js:1053/1160,
  index.html:5986/8709, the holdAtPeak caller, the cast path); only the cast path passes `opts.stance`,
  every other caller leaves it undefined → the `(opts && opts.stance) ? … : 0 || (existing chain)`
  fallback preserves today's behavior byte-for-byte. **Patch C cannot double-play**: `willPlay` is a
  strict superset condition of `canPlayReal`, so `setSwingMotion` plays ⟹ `willPlay` true ⟹ note placed
  ⟹ echo deduped; a miss ⟹ note skipped ⟹ echo survives. No regression to castMove/slideCast/cmdInterp
  (those files untouched). **Patch D** default-OFF (`castBusyScope`) → original behavior when off.
- **Tests real & runnable** — I rebuilt the §4.3 fixture from the oracle (magic=54, nc=125) and ran
  the §4.1 test **verbatim** in /tmp: `PASS: all 20 emitted gestures linked from-Ready in Magic
  (0x49).` / `PASS: 0 of 20 emitted magic gestures resolve under NonCombat (0x3d).` — matching the
  packet's transcript exactly.

### REQUIRED CORRECTIONS (mustFix before integration)

1. **DROP or FLAG-GATE the Patch A secondary hunk (`entities.js:2277`).** As written it removes
   `stance &&` from the `classifyMotionCommandTyped` guard **unconditionally** (no `CAST_RELIABILITY`
   gate). That is a GLOBAL default-mode behavior change: `classifyMotionCommandTyped` is on the
   remote-swing / echo (`_armMotionAction`→`setMotion`→`_tryPlayLink`) and melee paths too, so a
   `stance==0` command that previously coarse-fell-through to a no-op would now resolve via
   `default_style` and animate. That may be *desirable* (more faithful), but it changes default remote
   rendering and per foundation §4.3 must ride a flag pending eye-test. **It is NOT needed for the cast
   fix** — Patch A's `opts.stance=0x0049` already guarantees a nonzero stance on the cast path, so the
   `:2277` guard passes without touching it. Recommend: remove this hunk from WS01 (or spin it into its
   own flagged workstream). The A/B/C cast fix stands entirely without it.

2. **Ship `castReliability` DEFAULT-OFF pending the batched 1070 eye-test, then flip.** The packet
   ships it default-ON *and* queues E1/E2 eye-tests (§5) — internally contradictory. The established
   project workflow (url-flags.md:12) is that EVERY prior cast flag (`castSpeed`, `castStateMachine`,
   `castFizzle`) shipped **default-OFF first**, was eye-tested 2026-07-11, and only THEN flipped to
   default-ON. WS01 has NO live/eye-test validation yet (buildbox has no browser; §4.4/§5 are TODO).
   Follow the same path: `castReliability` **default-OFF** now, flip to default-ON after the batched
   eye-test passes. (`castBusyScope` is already correctly default-OFF.) Update the §3 const, the §3
   url-flags row Default column, and the §0/TL;DR wording accordingly.

3. **The §4.1/§4.2 tests + `tests/fixtures/ws01_player_mt_fromReady.json` do NOT exist anywhere on the
   box** (`find /home/wbterminal /tmp` → nothing). §4.1 presents a PASS transcript as if from a
   persistent artifact. The read-only constraint explains why they aren't committed, and I confirmed
   the LOGIC is correct by re-running it, but the packet should downgrade "Written and PASSING on this
   box today" → "logic independently re-verified by WS01-verify; artifacts to be authored+committed at
   integration (fixture via the §4.3 recipe, which I confirmed works)."

### Non-blocking notes

- The low16-vs-full stance change (Patch A) creates a *second* cache entry for the same clip
  (key includes raw stance) — memory-only, LRU-evicted, not a correctness bug.
- R2's duplicate `classifyMotionCommandTyped` in Patch C is a cheap in-memory HashMap walk — fine;
  if ever hot, thread the result into `setSwingMotion` instead (packet already says this).
- RC-1 vs RC-2 weighting genuinely needs the §4.4 live capture (especially whether the UpdateMotion
  windup echo carries stance `0` vs `0x80000049`, which decides whether the echo path could ever
  independently raise arms). The packet is appropriately honest (MEDIUM confidence on weighting).

**Bottom line:** the diagnosis is correct and DAT-proven; S1a is genuinely refuted; the A/B/C/D/E
patches are sound, apply cleanly, and don't regress the validated paths. Apply them **after** dropping
the unflagged `:2277` hunk and setting `castReliability` default-OFF-pending-eye-test.

```json
{"workstream":"WS01","verdict":"PARTIAL","apply":true,"mustFix":["DROP or flag-gate the Patch A secondary hunk at entities.js:2277 — it removes `stance &&` from the classifyMotionCommandTyped guard UNCONDITIONALLY, a global default-mode change to remote-swing/echo/melee rendering that violates foundation §4.3 and is NOT needed for the cast fix (Patch A opts.stance already pins a nonzero stance)","Ship castReliability DEFAULT-OFF pending the batched 1070 eye-test then flip, per the established workflow (castSpeed/castStateMachine/castFizzle all shipped off-first, flipped 2026-07-11); shipping default-ON while queuing an eye-test is self-contradictory and has no live validation yet","The §4.1/§4.2 tests + tests/fixtures/ws01_player_mt_fromReady.json exist nowhere on the box; downgrade the 'Written and PASSING' claim to 'logic re-verified, artifacts to be committed at integration' (the §4.3 fixture recipe was confirmed to work)"],"notes":"Diagnosis CONFIRMED independently: DAT oracle re-dump (Magic 0x49=54 keys, NonCombat 0x3d=125 keys) + independent parse of all 6266 spell-cast-sequence.json entries prove all 20 emitted gestures (6 windups+14 casts incl 0x10000132) are linked from-Ready in Magic and 0 resolve under NonCombat — S1a genuinely refuted. F2-F10 verified verbatim at cited lines; F5/F8 default-ON drift confirmed vs url-flags.md:12. All Patch A/B/C/D contexts exact-match the tree; Patch A backward-compat across all 6 setSwingMotion callers; Patch C cannot double-play (willPlay superset of canPlayReal); low16 stance safe (DAT helpers mask &0xFFFF). §4.1 test re-run verbatim = PASS. Root cause (prediction-only path + unconditional note + silent no-op via cold-bake race / stale NonCombat stance) holds; RC-1/RC-2 weighting needs the §4.4 live capture (honestly flagged MEDIUM)."}
```

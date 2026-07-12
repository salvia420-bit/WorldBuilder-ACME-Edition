# WS16 — Cast diagnostics surface + headless regression harness

**Workstream:** WS16 (own *measurability*).
**Baseline:** `external/holtburger` @ `6fcff2f0` (clean tree), pkg wasm v6 (manifest `WASM_EXPORT_MANIFEST_VERSION = 6`).
**Author box:** GCE buildbox. All file:line cites re-opened live 2026-07-12; DAT claims grounded via the WB.Terminal oracle; wire-behavior claims grounded in the ACE reference (`external/ACE/Source`).
**Deliverables in this packet:** (1) `window.__diag.cast` surface (`scene3d/diag/cast.js`, full file inline §3.1), (2) `probe_cast_matrix.cjs` (full file inline §3.4), (3) how other workstreams assert against `__diag.cast` (§7), (4) node unit test (`test_cast_diag.mjs`, full file inline §4.1, **28/28 PASS on this box**), (5) eye-test queue (§5), (6) risks + file touch-list (§6).

**One-paragraph thesis.** The local cast animation is a JS wall-clock chain (`playCastSequence`) whose every failure mode is a *silent no-op* from outside — a stance-falsy skip, a MotionTable link miss, a cold `animationCache` race, a busy-window early-return, an echo double-play, an anim-break cut. Today there is **no cast diag surface** (foundation §1.6: "There is NO dedicated cast diag surface today"). WS16 adds one — default-ON, read-cheap, observation-only (byte-identical to behavior) — plus a headless probe that drives a war+void matrix on live ACE and emits PASS/DRIFT per check. It changes **no cast behavior**; it only makes the S1/S2/S3 symptoms measurable so the other 15 workstreams can prove their fixes.

---

## 1. VERIFIED FINDINGS

Each claim is `file:line` + a short quote from the **live** file (re-opened today). **[FACT]** = directly read/executed; **[HYP]** = reasoned, not yet runtime-proven (needs the laptop).

### 1.1 The diag registration convention (what WS16 must mirror) — **[FACT]**
- `scene3d/diag.js:57` `installDiag()` builds `window.__diag`, then a fixed attach loop wires each surface: `diag.js:468-486` iterates `[["placements", _attachPlacements], … ["combat", _attachCombat], …]` calling `fn?.(diag)` under a try/catch. Adding a surface = import `attachCast` (`diag.js:38`-style line) + one row in that array. Quote (`diag.js:487-489`): `try { fn?.(diag); } catch (e) { console.warn(\`[diag] attach ${name} failed:\`, e); }`.
- Each surface module exports `attach<Name>(diag)` and assigns `diag.<name> = <obj>` at the end. Confirmed in `scene3d/diag/motion.js:114` `export function attachMotion(diag) {` … `:515 diag.motion = motion;` and `scene3d/diag/combat.js:142` `export function attachCombat(diag) {` … `:591 diag.combat = combat;`.
- **Hook-call convention is unconditional optional-chaining** (no flag): `index.html:6934` `try { window.__diag?.wire?.onEvent?.(evt); } catch (_) {}` and `index.html:8604` `window.__diag?.combat?.onAimLevel?.({…})`. No `__diag` surface is behind a URL flag. ⇒ WS16's hooks are the same shape and need **no new flag**.
- Plugin-bus subscription pattern (for the `spellCastInitiated` enrichment): `combat.js:619-653` `_installSneakSubscription()` polls `window.__pluginClient.events.on(...)` every 500 ms up to `SUB_POLL_MAX_TICKS = 60` (`combat.js:20`), idempotent, survives `reset()`. WS16 copies this verbatim for `spellCastInitiated`.

### 1.2 The cast chain state WS16 exposes lives on the EntityInstance — **[FACT]**
`scene3d/entities.js::playCastSequence` (`entities.js:6728`):
- **Cancellation token** `inst._castSequenceToken` — `entities.js:6777-6778` `const token = ((inst._castSequenceToken | 0) + 1) | 0; inst._castSequenceToken = token;`. Every `await` rechecks it (`:6784`, `:6820`, `:6884`).
- **Busy window** `inst._castBusyUntilMs` — set `entities.js:6772` `inst._castBusyUntilMs = nowMs + Math.min(12000, estMs / CAST_SPEED);`; the early-return gate is `:6766-6768` `if (inst._castBusyUntilMs && nowMs < inst._castBusyUntilMs) { return; // already casting — ignore the recast }`.
- **spellId + gesture index**: the chain loops `for (const gesture of (seq.windupGestures || []))` (`:6825`) then `if (seq.castGesture) { await playGesture(seq.castGesture); }` (`:6829-6831`). `playGesture` calls `this.setSwingMotion(g, motionU32, { speed: CAST_SPEED })` (`:6811`). The gesture **index is not tracked today** — WS16 threads it through the hook.
- **CasterEffect** emit at chain end: `entities.js:6885-6897` `if ((seq.casterEffect | 0) !== 0) { … window.__pluginClient.events.emit("playEffect", { targetGuid: g, scriptId: (seq.casterEffect|0)>>>0, speed: … formulaScale … }); }`, guarded by the token recheck `:6884 if (inst._castSequenceToken !== token) return;`.
- **Chain complete** clears the busy window: `entities.js:6911 if (inst) inst._castBusyUntilMs = 0;`.
- The 4 early-return fallbacks (all silent, all after `getCastSequence`): `!spellId` (`:6733-6738`), `!seq` table-not-loaded/unknown (`:6744-6750`), `setSwingMotion` not a function (`:6754-6759`), busy-window (`:6766-6768`). **These are S1(e)/S1(b) suppression paths — invisible today.**

### 1.3 The link-resolution miss-lattice (the S1(a) "arms not rising" mechanism) — **[FACT]**
`entities.js::setSwingMotion` (`entities.js:7138`):
- `const result = classifyMotionCommandTyped(mtableId, stance, motionCmd >>> 0);` (`:7147`).
- The play gate: `entities.js:7163-7167` `const canPlayReal = result && (result.kind === "swing" || result.kind === "cast") && (result.resolvedCommand >>> 0) !== 0 && result.source === "wasm-link";`.
- **Every miss is a silent `return`** — `:7169` `if (!canPlayReal || typeof fetchKeyframes !== "function") { … return; }`; cache throw `:7202-7208 return;`; null clip `:7211-7218 return;`. Quote (`:7178-7183`): "when no real MotionTable link/clip resolves, the entity now plays NO gesture (the pose was a placeholder)".
- **`stance` falsy short-circuits the wasm path**: `classifyMotionCommandTyped` only calls the wasm when `wasmReady && motionTableId && stance && motionCmd` (`entities.js:2277`). A falsy `stance` ⇒ `source: "coarse-fallback"` (`:2328`) ⇒ `canPlayReal` false ⇒ silent no-op. `stance` is `inst.currentStance ?? inst.lastStance ?? window.__getCurrentStanceLow?.()` (`:7143-7144`), `?? 0`.
- The **hit** site (what WS16 counts as a "hit"): after fetch, `action.reset(); action.play();` at `entities.js:7251-7252`, followed by `inst.currentActionKey = swingKey;` (`:7262`).
- ⇒ WS16 adds one `onLinkResolve` call right after `canPlayReal` is computed (recording outcome+reason keyed by `(stance, cmd)`), so misses stop being invisible.

### 1.4 Echo-vs-prediction dedup counters — **[FACT]**
- Note side: `entities.js:6619-6624` `noteLocalSwingPrediction(cmd)` stores `this._localSwingEchoes.set(c, performance.now() + 500)`; called from the cast chain **only when `CAST_SPEED !== 1.0`** (`entities.js:6812`).
- Consume side: `scene3d/loop.js:2605-2610` inside `_armMotionAction` — `if (DISPATCH_PARITY_ON && actionCmd !== 0 && em.consumeLocalSwingEcho?.(actionGuid, actionCmd)) { /* swallow */ }`. `DISPATCH_PARITY_ON` default-ON (`loop.js:300`; url-flags row `dispatchParity`). `consumeLocalSwingEcho` (`entities.js:6629-6637`) deletes the record and returns whether it was live.
- ⇒ WS16 adds `onEchoNote`/`onEchoConsume` at these two sites.

### 1.5 Movement-arbitration state is reachable via wasm getters — **[FACT]**
- Existing free-fn diag getters in `src/lib.rs`: `movementPendingMotionsDiag` (`lib.rs:934-937`, the completion-node queue depth — "a cast stomp raises it, the authored budget drains it", `:928-930`); `reclaimCauseDiag` (`lib.rs:945-950`, packs `(useTime<<16)|edge`); `localPoseSnapDiag`/`leashEchoDiag` (`:958-971`). All ride v6 additively — `:909-913` "RIDES v6 (no bump — purely additive, diagnostics-only)".
- Stamp site: `lib.rs:47401-47405` in the `SessionCommand::TickMovement` `Ok(())` arm — `MOVEMENT_PENDING_MOTIONS_DIAG.store(movement.local_registry_pending_motions(w.player.guid) as u32, …);`. `movement` is the `MovementSystem` handle (`handle.rs:421` delegates to `system.rs:6673`).
- The autonomy **latch** is a field on `MovementSystem`: `system.rs:1505 last_move_was_autonomous: bool` (lowered from the wire by `note_server_authored_motion`, `system.rs:1902-1903`; raised on every local edge, url-flags `castMove` row). Predicates `cast_move_enabled()`/`slide_cast_enabled()` at `system.rs:1858/1868`.
- The **forward-slot occupancy** is the interpreter's forward command: `system.rs:1462 command_interpreter: Option<CommandInterpreter>`; read as `interp.forward_command` (`system.rs:2244`), an `Option<InterpretedForwardCommand>` with variants `WalkForward | RunForward | Substate(u32) | None` (`interp_state.rs:31-39`). **A cast gesture parks a `Substate(cmd)` in that slot at zero locomotion — that IS the SLIDECAST mechanism** (`interp_state.rs:34-36` "retail stores ANY 0x40000000-class substate in the single forward slot … evicting locomotion; zero velocity").
- JS reaches free fns via `window.__hbWasm`: `index.html:1292 import * as __hbWasmNs from "./pkg/holtburger_web.js…"`; the surface is built at `index.html:2061-2140` with a typeof guard per getter, e.g. `:2118-2123 …(typeof __hbWasmNs?.movementPendingMotionsDiag === "function" ? { movementPendingMotionsDiag: () => __hbWasmNs.movementPendingMotionsDiag() >>> 0 } : {})`.
- ⇒ WS16 adds ONE new getter `castArbitrationDiag()` (latch + forward-slot packed), stamped alongside the existing one. This is the **only** piece needing a wasm rebuild; the JS surface reads it *and the existing getters* and degrades to `null` when absent (so the JS half ships independently of the rebuild).

### 1.6 Cast lifecycle wire-events (the timeline stamps) — **[FACT]**
- **Requested/sent** (all cast entry points converge on `playCastSequence`): click-to-cast `picking.js:673-701` — `doCast()` calls `sessionHandle.castTargetedSpell(guid, spellId)` (`:674`) then `em.playCastSequence(localGuid, spellId)` (`:694`); plugin/hotbar path `plugins/api.js castSpell` (foundation §1.1) also calls `playCastSequence`. `picking.js:652-668` emits `spellCastInitiated {spellId,targetGuid,attackerGuid,school,shape,level}` — the enrichment source.
- **Fizzle**: `index.html:7832-7842` — `if (errCode === 0x0402) { … em.cancelCastSequence(lg); }` (kind=13 WeenieError). Grounded server-side: ACE `Player_Magic.cs:917-918 EnqueueBroadcast(new GameMessageScript(Guid, PlayScript.Fizzle, 0.5f)); SendWeenieError(WeenieError.YourSpellFizzled);` (`0x0402`, `WeenieError.cs:266`).
- **UseDone**: `index.html:7854-7860` — `em.clearCastBusy(lg);` (kind=14). Grounded: ACE `Player_Use.cs:247-250 SendUseDoneEvent(...) → new GameEventUseDone(Session, errorType)`, enqueued from `FinishCast()` (`Player_Magic.cs:964`).
- **Anim-break cut**: `index.html:8105-8124` — kind=61 `ForwardSlotEvicted` (code 1) → `em.cancelCastSequence(localGuid)` under the busy-window guard.
- **cancelCastSequence** itself: `entities.js:6927-6939` bumps the token and recoils `this.setMotion?.(guid, 0x0003, stance, 1.0)` (Ready).

### 1.7 DAT ground truth for the war/void gesture ids (the counter keys) — **[FACT, oracle-verified]**
Component table `0x0E00000F` (WB.Terminal `chorizite-parse-dat-record` … `SpellComponentTable`), scarab `gesture` + `time` (`_time` = per-component windup duration, foundation §2.3):
| Scarab | gesture (dec) | gesture (hex) | `time` (s) |
|---|---|---|---|
| Lead | 2147483648 | `0x80000000` (no windup) | 0 |
| Iron | 268435568 | `0x10000070` (MagicPowerUp02) | 1.0795 |
| Copper | 268435570 | `0x10000072` | 2.0192 |
| Silver | 268435572 | `0x10000074` | 2.875 |
| Gold | 268435574 | `0x10000076` | 3.6765 |
| Pyreal | 268435576 | `0x10000078` (MagicPowerUp10) | 4.4408 |

Standard scarabs ⇒ the `0x1000006F..0x78` band (foundation's war band). **Player MT `0x09000001` carries a link entry for every id in both the standard band (`0x6F..0x78`, each 1 occurrence) AND the colored/void band (`0x10000128..0x10000134`, present)** — verified by grepping the oracle's MotionTable dump (269 330 bytes). The JSON generator bakes these exactly: `getCastSequence(2331)` (void, `data/spell-cast-sequence.json`) = `windupGestures:[{motion:"0x10000132", name:"MagicPowerUp08Purple", durationS:3.6765}], castGesture:{motion:"0x40000035", name:"MagicTransfer"}, targetEffect:74, formulaScale:1`; `getCastSequence(1708)` (Wedding Bliss) = 3 windups (`0x10000076, 0x10000078, 0x10000078`) + cast `0x4000002D`.

### 1.8 ACE wire/timing ground truth for the probe's DRIFT tolerances — **[FACT, ACE ref]**
- **CastSpeed = 2.0** (`Player_Magic.cs:603 public static float CastSpeed = 2.0f;`); client mirrors it (`entities.js:903 CAST_SPEED`, url-flags `castSpeed` default-ON). Each gesture duration ≈ authored `GetAnimationLength(MT, Magic, cmd, speed) / CastSpeed`.
- **One motion per gesture, EMPTY axes, MotionStance.Magic** (`WorldObject_Networking.cs:1078 EnqueueMotionMagic → new Motion(MotionStance.Magic, motionCommand, speed); EnqueueBroadcastMotion(motion)`). Windup order then cast: `DoWindupGestures` (`Player_Magic.cs:605-646`, skipped for `FastCast`) → `DoCastGesture` (`:648-689`).
- **Effect scripts**: `WorldObject_Magic.cs:356-367 DoSpellEffects` — CasterEffect `GameMessageScript(caster.Guid, spell.CasterEffect, spell.Formula.Scale)` (gated `!IsProjectile || !projectileHit`); TargetEffect on the target (gated `projectileHit`). Confirms the client synthesizes CasterEffect locally (foundation §1.2) and defers TargetEffect (attribution TODO).
- **Fizzle circle is PK-only**: `Player_Magic.cs:870-885 if (dist > Windup_MaxMove && PlayerKillerStatus != PlayerKillerStatus.NPK) { … }` (`Windup_MaxMove = 6.0f`, `:373`). ⇒ probe must NOT expect a movement fizzle on the (NPK) test char (foundation §1.4 guardrail).

---

## 2. ROOT CAUSES (mechanisms this surface makes measurable)

WS16 does not *fix* the symptoms — it instruments them. For each charter symptom, the mechanism + the exact counter that isolates it:

- **S1(a) "arms not rising" (esp. void colored powerups).** Mechanism: `setSwingMotion` silently returns whenever `lookupMotionLinkForSwing(mt, stance, cmd)` returns `None` or `stance` is falsy (§1.3). The **raw DAT is not the culprit** — §1.7 proves player MT `0x09000001` carries both the war band and the colored void band (`0x10000132` is present). So the failure, if real, is a **runtime resolution** issue (stance value passed at cast time, the Ready-substate fallback the wasm single-link lookup may lack, or a cold `animationCache` fetch outliving a short windup sleep). **Isolated by:** `__diag.cast.linkStats({castOnly:true})` — a non-zero `miss` on `0x10000132` under a non-`0x…49` stance key is the smoking gun; the `reasons` breakdown (`stance-falsy` vs `not-wasm-link` vs `null-clip`) says which of the three.
- **S1(b) cold-fetch race.** `setSwingMotion` is deliberately not awaited (`entities.js:6804-6811`); the per-gesture sleep is `Math.max(50, dur*1000/CAST_SPEED)` (`:6816`). A cold `animationCache.get` can outlive a 50 ms floor. **Isolated by:** the timeline's `windups[i].at` deltas vs the authored `durationS` — a windup with no link `hit` recorded before the next gesture stamp = the race.
- **S1(e) busy-window / dropped-UseDone suppression.** `playCastSequence` early-returns on `inst._castBusyUntilMs` (`:6766`); if a UseDone (kind=14) is dropped, the window (capped 12 s) can wedge a server-accepted recast into a silent no-op. **Isolated by:** `__diag.cast.summary().suppress.busyWindow` + the timeline `outcome:"suppressed"` record.
- **S2 "movement breaks animations".** Mechanism: the three.js overlay model vs retail full-body splice (foundation S2(a)); a mid-cast forward edge evicts the forward slot → `cancelCastSequence` cut (§1.6, kind=61). **Isolated by:** `movementSnapshot()` (`latchAutonomous`, `forwardSlot === "substate"` while a gesture holds it, `pendingMotions` queue depth) correlated against the timeline `cancelCause:"anim-break"`.
- **S3 "run as far as you want".** Mechanism: FU-A-dormant + `use_time` reclaim revives held keys between windups (foundation §1.4 KNOWN GAP). **Isolated by:** `movementSnapshot().reclaimCause.useTime` incrementing *during* a multi-windup cast, while `pendingMotions` drains between windups — the exact retail-vs-client divergence, now a number.

**Proven where feasible:** §1.7 (DAT presence of both gesture bands) and §1.8 (ACE wire timing) are oracle/reference-proven. The runtime resolution outcomes (does `0x10000132` actually `hit` at cast time?) are **[HYP]** until the laptop runs `probe_cast_matrix.cjs` — that is precisely what the probe measures (see §4.2 recipe).

---

## 3. PATCH PLAN

Conventions honored (foundation §4): **no new URL flag** (observation-only surface, matches the 17 existing `__diag` surfaces — none are flag-gated; the flag-off arm is byte-identical *by construction* since no hook mutates cast behavior). **No default-behavior change.** One additive wasm getter rides v6 (**no manifest bump**, `movementPendingMotionsDiag` precedent) and is the sole reason `needsWasmRebuild=true`; the JS half degrades gracefully without it. All JS hooks are unconditional optional-chained calls (`window.__diag?.cast?.onX?.()`), exactly like `__diag?.wire?.onEvent?.()` / `__diag?.combat?.onAimLevel?.()`.

### 3.0 Files touched (see §6 for the integration ordering)
| File | Change | Kind |
|---|---|---|
| `scene3d/diag/cast.js` | **NEW** surface (§3.1) | JS, additive |
| `scene3d/diag.js` | import + 1 attach-loop row (§3.2) | JS, additive |
| `scene3d/entities.js` | 6 hook calls in `playCastSequence`, 1 in `setSwingMotion`, 1 in `cancelCastSequence`, 1 in `noteLocalSwingPrediction` (§3.3) | JS, additive |
| `index.html` | 3 hook calls (fizzle/UseDone/kind-61) + 1 `__hbWasm` getter row (§3.3) | JS, additive |
| `scene3d/loop.js` | 1 hook call in `_armMotionAction` (§3.3) | JS, additive |
| `scene3d/picking.js` | *(optional)* 1 `t_sent` stamp — recommended SKIP (see §3.3) | JS, additive |
| `src/lib.rs` | 1 static + 1 `castArbitrationDiag` fn + 1 stamp line (§3.5) | Rust, additive |
| `crates/holtburger-core/src/client/movement/handle.rs` | 1 delegating accessor (§3.5) | Rust, additive |
| `crates/holtburger-core/src/client/movement/system.rs` | 1 `cast_arbitration_diag` method (§3.5) | Rust, additive |
| `probe_cast_matrix.cjs` | **NEW** probe (§3.4) | test tooling |
| `test_cast_diag.mjs` | **NEW** node unit test (§4.1) | test |
| `docs/url-flags.md` | **no row** (no flag). One-line note only if desired (§3.6) | doc |

### 3.1 NEW file: `scene3d/diag/cast.js`
Authored + syntax-checked (`node --check`) + unit-tested on this box (28/28, §4.1). Full content:

```javascript
// scene3d/diag/cast.js — spell-cast pipeline observability (WS16)
//
// The cast animation is a JS wall-clock chain (entities.js::playCastSequence)
// gated on wasm MotionTable link resolution (setSwingMotion →
// classifyMotionCommandTyped → lookupMotionLinkForSwing). Every failure in
// that chain is a SILENT no-op from outside (foundation §1.3, S1 map): a
// stance-falsy skip, a link miss, a cold animationCache race, a busy-window
// early-return, or an echo double-play. This surface makes each of those
// measurable without changing any cast behavior.
//
// Same "no cheating" stance as motion.js / combat.js: every hook records
// state the runtime already committed (the gesture it TRIED, the link
// outcome it GOT, the token it bumped). Cost per hook fire is O(1) — a Map
// get + a ring push; a full multi-windup war cast fires ~6 hooks total.
//
// Default-ON, no URL flag (matches the other 17 __diag surfaces — pure
// observation, never alters the cast; the flag-off arm is byte-identical by
// construction because no hook mutates cast behavior). Heavy reads (the
// movement-arbitration wasm poll) are ON-DEMAND getters, so nothing runs
// per-frame; `?renderDiag` is not required.
//
// Devtools entry points exposed on `__diag.cast`:
//   state(guid?)          — live chain state {spellId, gestureIndex, token,
//                           busyUntilMs, phase} for one guid or all
//   timelineTail(n=10)    — last N per-cast timeline records (armed→sent→
//                           windup_n→cast→casterEffect→UseDone/fizzle)
//   lastTimeline(guid?)   — most recent record with computed deltas (ms)
//   linkStats({castOnly}) — per-(stance, gesture-id) link hit/miss counts
//                           with miss-reason breakdown
//   echoStats()           — echo-vs-prediction dedup counters
//   movementSnapshot()    — on-demand read of the wasm arbitration getters
//                           (latch / forward-slot / pending-motions / reclaims)
//   summary()             — one-line rollup for operators + probes
//   assertLastCast(spec)  — PASS/DRIFT check helper for probe_cast_matrix.cjs
//   reset()               — zero all counters/rings (keeps subscription)

const MAX_TIMELINE = 64;          // bounded ring of completed/aborted casts
const MAX_WINDUP_STAMPS = 16;     // per-cast windup stamp cap (retail max ~10)
const SUB_POLL_MAX_TICKS = 60;    // ~30s @ 500ms — give up if never logged in

// performance.now() exists in browsers and Node ≥16; fall back for safety.
function _now() {
  try {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
  } catch (_) { /* fall through */ }
  return Date.now();
}

function _hex(u32) {
  return "0x" + ((u32 >>> 0).toString(16).padStart(8, "0"));
}

// Cast-class gesture bands (mirror scene3d/diag/motion.js CAST set + the
// full-32-bit cast gesture class 0x40000000). Used to filter linkStats to
// cast gestures only. Windup band low16 0x6F..0x78 (MagicPowerUp01..10),
// colored band 0x128..0x134, aim/cast-substate 0x2B..0x39, plus the
// 0x40000000-class final cast gestures (MagicBlast/Self/Transfer/etc).
function _isCastGestureCmd(cmd) {
  const c = cmd >>> 0;
  const cls = c & 0xff000000;
  if (cls === 0x40000000) return true;             // final cast gesture class
  if (cls === 0x10000000) {                          // Action-class windups
    const low = c & 0xffff;
    if (low >= 0x6f && low <= 0x78) return true;    // MagicPowerUp01..10
    if (low >= 0x128 && low <= 0x134) return true;  // colored (void) powerups
  }
  return false;
}

export function attachCast(diag) {
  const cast = {
    // ── live chain state (one entry per guid currently/last casting) ──
    // { spellId, token, busyUntilMs, gestureIndex, gestureCount, phase,
    //   startedAt } where phase ∈ requested|windup|cast|effect|done|
    //   fizzled|cancelled|suppressed.
    chains: new Map(),

    // ── bounded ring of per-cast timeline records ──
    // { guid, spellId, school, shape, level, fastCast, leadOnly,
    //   t_requested, t_sent, windups:[{i, cmd, name, t}], t_cast,
    //   t_casterEffect, t_done, t_useDone, t_fizzle, outcome,
    //   suppressedReason, cancelCause }
    timeline: [],

    // ── link-resolution counters, per (stance, gesture-id) ──
    // Map<stance_u32, Map<cmd_u32, {hit, miss, reasons:{...}}>>. Populated
    // from setSwingMotion for EVERY swing/cast; linkStats({castOnly}) filters
    // to cast gestures. WS01 owns the canonical gesture-id→name naming; this
    // surface keys on the raw u32 and humanizes lazily via
    // data/motion-command-names.json.
    links: new Map(),

    // ── echo-vs-prediction dedup counters (foundation §1.5) ──
    echo: { noted: 0, consumedHit: 0, consumedMiss: 0 },

    // ── early-return / suppression counters (S1(e), S1(b)) ──
    suppress: { noSpell: 0, tableNotLoaded: 0, noSetSwing: 0, busyWindow: 0 },

    // ── aggregate lifecycle counters ──
    counters: {
      requested: 0, chainsStarted: 0, chainsCompleted: 0,
      chainsCancelled: 0, fizzles: 0, useDones: 0, casterEffects: 0,
    },

    _motionNames: null,   // lazy humanization table (shared shape w/ combat.js)

    // ────────────────────────────────────────────────────────────────
    // Lifecycle hooks — called from entities.js::playCastSequence.
    // Every one is optional-chained at the call site, so a missing surface
    // is a no-op. None mutate cast behavior.
    // ────────────────────────────────────────────────────────────────

    /** Top of playCastSequence, BEFORE any early return. spellId may be 0. */
    onCastRequested(meta) {
      if (!meta) return;
      const g = (meta.guid >>> 0);
      this.counters.requested += 1;
      const rec = {
        guid: g,
        spellId: (meta.spellId | 0) || 0,
        school: meta.school ?? null,
        shape: meta.shape ?? null,
        level: meta.level ?? null,
        fastCast: meta.fastCast ?? null,
        leadOnly: meta.leadOnly ?? null,
        t_requested: _now(),
        t_sent: meta.t_sent ?? null,
        windups: [],
        t_cast: null,
        t_casterEffect: null,
        t_done: null,
        t_useDone: null,
        t_fizzle: null,
        outcome: "pending",
        suppressedReason: null,
        cancelCause: null,
      };
      this.chains.set(g, {
        spellId: rec.spellId, token: null, busyUntilMs: null,
        gestureIndex: -1, gestureCount: null, phase: "requested",
        startedAt: rec.t_requested, _rec: rec,
      });
    },

    /** An armed-spell click routed through picking.js (plugin-bus). Enriches
     *  the open record with school/shape/level BEFORE the chain runs. */
    onSpellCastInitiated(meta) {
      if (!meta) return;
      const g = (meta.attackerGuid >>> 0) || (meta.guid >>> 0);
      const chain = this.chains.get(g);
      const rec = chain?._rec;
      if (rec) {
        if (meta.school != null) rec.school = meta.school;
        if (meta.shape != null) rec.shape = meta.shape;
        if (meta.level != null) rec.level = meta.level;
        if (rec.t_armed == null) rec.t_armed = _now();
      }
    },

    /** Any of the fallback early-returns fired (no spellId / table not loaded
     *  / no setSwingMotion / busy-window). reason ∈ the suppress keys. */
    onCastSuppressed(meta) {
      if (!meta) return;
      const g = (meta.guid >>> 0);
      const reason = meta.reason;
      if (reason && this.suppress[reason] !== undefined) this.suppress[reason] += 1;
      const chain = this.chains.get(g);
      if (chain?._rec) {
        chain._rec.outcome = "suppressed";
        chain._rec.suppressedReason = reason ?? "unknown";
        chain._rec.t_done = _now();
        this._commit(chain._rec);
      }
      this.chains.delete(g);
    },

    /** Chain committed to running (past all early returns): token bumped,
     *  busy window set, windup count known. */
    onChainStart(meta) {
      if (!meta) return;
      const g = (meta.guid >>> 0);
      this.counters.chainsStarted += 1;
      let chain = this.chains.get(g);
      if (!chain) { this.onCastRequested({ guid: g, spellId: meta.spellId }); chain = this.chains.get(g); }
      chain.token = (meta.token | 0);
      chain.busyUntilMs = (meta.busyUntilMs != null) ? +meta.busyUntilMs : null;
      chain.gestureCount = (meta.windupCount | 0) + (meta.hasCast ? 1 : 0);
      chain.phase = "windup";
      if (chain._rec) {
        chain._rec.t_sent = chain._rec.t_sent ?? _now();
        chain._rec.fastCast = meta.fastCast ?? chain._rec.fastCast;
        chain._rec.leadOnly = meta.leadOnly ?? chain._rec.leadOnly;
      }
    },

    /** One windup or the cast gesture fired (setSwingMotion was called). */
    onGesture(meta) {
      if (!meta) return;
      const g = (meta.guid >>> 0);
      const chain = this.chains.get(g);
      if (!chain) return;
      chain.gestureIndex = (meta.index | 0);
      chain.phase = meta.isCast ? "cast" : "windup";
      const rec = chain._rec;
      if (!rec) return;
      if (meta.isCast) {
        rec.t_cast = _now();
      } else if (rec.windups.length < MAX_WINDUP_STAMPS) {
        rec.windups.push({ i: (meta.index | 0), cmd: (meta.motion >>> 0), name: meta.name ?? null, t: _now() });
      }
    },

    /** CasterEffect PlayScript emitted at chain end. */
    onCasterEffect(meta) {
      if (!meta) return;
      const g = (meta.guid >>> 0);
      this.counters.casterEffects += 1;
      const chain = this.chains.get(g);
      if (chain?._rec) chain._rec.t_casterEffect = _now();
      if (chain) chain.phase = "effect";
    },

    /** Chain reached the end normally. */
    onChainComplete(meta) {
      if (!meta) return;
      const g = (meta.guid >>> 0);
      this.counters.chainsCompleted += 1;
      const chain = this.chains.get(g);
      if (chain?._rec) {
        chain._rec.t_done = _now();
        if (chain._rec.outcome === "pending") chain._rec.outcome = "complete";
        this._commit(chain._rec);
      }
      if (chain) chain.phase = "done";
      this.chains.delete(g);
    },

    /** cancelCastSequence bumped the token (fizzle / UseDone / anim-break). */
    onChainCancel(meta) {
      if (!meta) return;
      const g = (meta.guid >>> 0);
      this.counters.chainsCancelled += 1;
      const chain = this.chains.get(g);
      if (chain?._rec) {
        chain._rec.outcome = "cancelled";
        chain._rec.cancelCause = meta.cause ?? "unknown";
        chain._rec.t_done = chain._rec.t_done ?? _now();
        this._commit(chain._rec);
      }
      if (chain) chain.phase = "cancelled";
      this.chains.delete(g);
    },

    /** WeenieError 0x0402 fizzle landed (index.html kind=13). */
    onFizzle(meta) {
      const g = (meta?.guid >>> 0) || 0;
      this.counters.fizzles += 1;
      const chain = this.chains.get(g);
      if (chain?._rec) chain._rec.t_fizzle = _now();
    },

    /** UseDone landed (index.html kind=14) — server finished the action. */
    onUseDone(meta) {
      const g = (meta?.guid >>> 0) || 0;
      this.counters.useDones += 1;
      const chain = this.chains.get(g);
      if (chain?._rec) chain._rec.t_useDone = _now();
    },

    // ── link-resolution hook (setSwingMotion) ──
    /** outcome ∈ "hit"|"miss"; reason ∈ not-wasm-link|kind-mismatch|
     *  resolved-zero|no-fetchKeyframes|null-clip|cache-throw|stance-falsy. */
    onLinkResolve(meta) {
      if (!meta) return;
      const stance = (meta.stance >>> 0);
      const cmd = (meta.cmd >>> 0);
      let row = this.links.get(stance);
      if (!row) { row = new Map(); this.links.set(stance, row); }
      let cell = row.get(cmd);
      if (!cell) { cell = { hit: 0, miss: 0, reasons: {} }; row.set(cmd, cell); }
      if (meta.outcome === "hit") {
        cell.hit += 1;
      } else {
        cell.miss += 1;
        const r = meta.reason ?? "unknown";
        cell.reasons[r] = (cell.reasons[r] ?? 0) + 1;
      }
    },

    // ── echo-dedup hooks ──
    onEchoNote(_cmd) { this.echo.noted += 1; },
    onEchoConsume(meta) {
      if (meta?.hit) this.echo.consumedHit += 1;
      else this.echo.consumedMiss += 1;
    },

    // ────────────────────────────────────────────────────────────────
    // Read-side getters
    // ────────────────────────────────────────────────────────────────

    _commit(rec) {
      this.timeline.push(rec);
      if (this.timeline.length > MAX_TIMELINE) this.timeline.shift();
    },

    state(guid) {
      if (guid != null) {
        const c = this.chains.get(guid >>> 0);
        return c ? { ...c, _rec: undefined } : null;
      }
      const out = {};
      for (const [g, c] of this.chains) out[_hex(g)] = { ...c, _rec: undefined };
      return out;
    },

    /** Add computed inter-stamp deltas (ms) to a raw timeline record. */
    _withDeltas(rec) {
      if (!rec) return null;
      const base = rec.t_requested ?? rec.t_sent ?? 0;
      const d = (t) => (t == null ? null : Math.round((t - base) * 10) / 10);
      const windupDeltas = rec.windups.map((w) => ({ i: w.i, cmd: _hex(w.cmd), name: w.name, at: d(w.t) }));
      return {
        guid: _hex(rec.guid),
        spellId: rec.spellId,
        school: rec.school, shape: rec.shape, level: rec.level,
        fastCast: rec.fastCast, leadOnly: rec.leadOnly,
        outcome: rec.outcome,
        suppressedReason: rec.suppressedReason,
        cancelCause: rec.cancelCause,
        deltasMs: {
          armed: d(rec.t_armed),
          sent: d(rec.t_sent),
          windups: windupDeltas,
          cast: d(rec.t_cast),
          casterEffect: d(rec.t_casterEffect),
          done: d(rec.t_done),
          useDone: d(rec.t_useDone),
          fizzle: d(rec.t_fizzle),
        },
      };
    },

    timelineTail(n = 10) {
      const k = Math.max(0, Math.min(n | 0, this.timeline.length));
      return this.timeline.slice(this.timeline.length - k).map((r) => this._withDeltas(r));
    },

    lastTimeline(guid) {
      for (let i = this.timeline.length - 1; i >= 0; i--) {
        const r = this.timeline[i];
        if (guid == null || (r.guid >>> 0) === (guid >>> 0)) return this._withDeltas(r);
      }
      // Fall back to a live (not-yet-committed) chain record.
      if (guid != null) {
        const c = this.chains.get(guid >>> 0);
        if (c?._rec) return this._withDeltas(c._rec);
      }
      return null;
    },

    linkStats(opts) {
      const castOnly = !!(opts && opts.castOnly);
      const out = {};
      for (const [stance, row] of this.links) {
        const cells = {};
        for (const [cmd, cell] of row) {
          if (castOnly && !_isCastGestureCmd(cmd)) continue;
          cells[_hex(cmd)] = {
            name: this._motionNames ? (this._motionNames[_hex(cmd)] ?? null) : null,
            hit: cell.hit, miss: cell.miss,
            reasons: { ...cell.reasons },
          };
        }
        if (Object.keys(cells).length) out[_hex(stance)] = cells;
      }
      return out;
    },

    echoStats() { return { ...this.echo }; },

    /** ON-DEMAND read of the wasm movement-arbitration getters. Zero cost
     *  until called. Degrades gracefully: any getter absent (stale pkg/) →
     *  its field is null. `castArbitrationDiag` is the WS16 addition (packs
     *  the autonomy latch + interpreter forward-slot occupancy). The others
     *  already exist (foundation §1.4). */
    movementSnapshot() {
      const w = (typeof window !== "undefined") ? window : null;
      const hb = w && w.__hbWasm ? w.__hbWasm : null;
      const call = (fn) => {
        try { return (hb && typeof hb[fn] === "function") ? hb[fn]() : null; }
        catch (_) { return null; }
      };
      const arb = call("castArbitrationDiag");
      let latch = null, forwardSlot = null, heldSubstate = null, castMove = null, slideCast = null;
      if (typeof arb === "number") {
        latch = (arb & 0x1) ? 1 : 0;
        castMove = (arb & 0x2) ? 1 : 0;
        slideCast = (arb & 0x4) ? 1 : 0;
        const occ = (arb >> 4) & 0x3;
        forwardSlot = ["none", "walk", "run", "substate"][occ] ?? "none";
        if (occ === 3) heldSubstate = _hex(0x40000000 | ((arb >>> 16) & 0xffff));
      }
      return {
        // WS16 new getter (rides wasm v6, no manifest bump; needs rebuild):
        latchAutonomous: latch,          // 1 = raw keyboard drives; 0 = server-echo (a cast gesture lowered it)
        forwardSlot,                     // none|walk|run|substate — "substate" = a cast gesture holds the slot at 0 loco (SLIDECAST)
        heldSubstate,                    // the gesture cmd occupying the forward slot, if substate
        castMoveEnabled: castMove,
        slideCastEnabled: slideCast,
        // Existing getters (foundation §1.4):
        pendingMotions: call("movementPendingMotionsDiag"),   // completion-node queue depth (a cast stomp raises it)
        reclaimCause: (() => {
          const rc = call("reclaimCauseDiag");
          if (typeof rc !== "number") return null;
          return { edge: rc & 0xffff, useTime: (rc >>> 16) & 0xffff };
        })(),
      };
    },

    summary() {
      const c = this.counters;
      // Roll up link hit/miss over cast gestures only.
      let castHit = 0, castMiss = 0;
      for (const [, row] of this.links) {
        for (const [cmd, cell] of row) {
          if (!_isCastGestureCmd(cmd)) continue;
          castHit += cell.hit; castMiss += cell.miss;
        }
      }
      return {
        requested: c.requested,
        chainsStarted: c.chainsStarted,
        chainsCompleted: c.chainsCompleted,
        chainsCancelled: c.chainsCancelled,
        fizzles: c.fizzles,
        useDones: c.useDones,
        casterEffects: c.casterEffects,
        suppress: { ...this.suppress },
        castLink: { hit: castHit, miss: castMiss },
        echo: { ...this.echo },
        liveChains: this.chains.size,
        timelineDepth: this.timeline.length,
      };
    },

    /** Probe helper — assert the most-recent cast for `guid` against a spec.
     *  Returns { pass:boolean, checks:[{name, pass, detail}] }.
     *  spec = { minWindups, expectCast, maxCastMs, expectCasterEffect,
     *           forbidSuppressed, expectOutcome, maxLinkMiss }. */
    assertLastCast(guid, spec) {
      spec = spec || {};
      const tl = this.lastTimeline(guid);
      const checks = [];
      const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: detail ?? null });
      if (!tl) {
        add("has-timeline", false, "no cast record for guid");
        return { pass: false, checks };
      }
      if (spec.forbidSuppressed) add("not-suppressed", tl.outcome !== "suppressed", tl.suppressedReason);
      if (spec.expectOutcome) add(`outcome=${spec.expectOutcome}`, tl.outcome === spec.expectOutcome, tl.outcome);
      if (spec.minWindups != null) add(`>=${spec.minWindups}-windups`, tl.deltasMs.windups.length >= spec.minWindups, `${tl.deltasMs.windups.length}`);
      if (spec.expectCast) add("cast-gesture-played", tl.deltasMs.cast != null, `at ${tl.deltasMs.cast}ms`);
      if (spec.maxCastMs != null && tl.deltasMs.cast != null) add(`cast<=${spec.maxCastMs}ms`, tl.deltasMs.cast <= spec.maxCastMs, `${tl.deltasMs.cast}ms`);
      if (spec.expectCasterEffect) add("caster-effect-fired", tl.deltasMs.casterEffect != null, `at ${tl.deltasMs.casterEffect}ms`);
      if (spec.maxLinkMiss != null) {
        const s = this.summary().castLink;
        add(`link-miss<=${spec.maxLinkMiss}`, s.miss <= spec.maxLinkMiss, `miss=${s.miss} hit=${s.hit}`);
      }
      const pass = checks.every((c) => c.pass);
      return { pass, checks, timeline: tl };
    },

    reset() {
      this.chains.clear();
      this.timeline.length = 0;
      this.links.clear();
      this.echo.noted = this.echo.consumedHit = this.echo.consumedMiss = 0;
      for (const k of Object.keys(this.suppress)) this.suppress[k] = 0;
      for (const k of Object.keys(this.counters)) this.counters[k] = 0;
    },
  };

  // Lazily fetch the motion-command-name table (same file combat.js uses) to
  // humanize gesture ids in linkStats/timeline. Non-fatal on failure.
  try {
    if (typeof fetch === "function") {
      fetch("./data/motion-command-names.json", { cache: "force-cache" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { cast._motionNames = j || null; })
        .catch(() => {});
    }
  } catch (_) { /* Node / no fetch — humanization stays null */ }

  diag.cast = cast;

  // Subscribe to the picking.js `spellCastInitiated` emit for school/shape
  // enrichment (mirror combat.js's poll-until-available pattern). This is
  // enrichment only — the direct playCastSequence hooks are authoritative and
  // cover the plugin/hotbar paths too.
  _activeCast = cast;
  _installInitiatedSubscription();
}

// Module-scope subscription state (survives reset(), idempotent).
let _activeCast = null;
let _initiatedInstalled = false;
let _initiatedPollTimer = null;
const _initiatedHandler = (meta) => {
  try { _activeCast?.onSpellCastInitiated?.(meta?.detail ?? meta); } catch (_) {}
};
function _installInitiatedSubscription() {
  if (_initiatedInstalled) return;
  // Browser-only: no plugin bus in Node (unit tests) — skip the poll so we
  // never leave a setInterval keeping the process alive.
  if (typeof window === "undefined") return;
  const tryHook = () => {
    try {
      const client = (typeof window !== "undefined") ? window.__pluginClient : null;
      if (!client?.events?.on) return false;
      client.events.on("spellCastInitiated", _initiatedHandler);
      _initiatedInstalled = true;
      return true;
    } catch (_) { return false; }
  };
  if (!tryHook()) {
    let ticks = 0;
    _initiatedPollTimer = setInterval(() => {
      if (tryHook()) { try { clearInterval(_initiatedPollTimer); } catch (_) {} _initiatedPollTimer = null; return; }
      ticks += 1;
      if (ticks >= SUB_POLL_MAX_TICKS) {
        try { clearInterval(_initiatedPollTimer); } catch (_) {}
        _initiatedPollTimer = null;
      }
    }, 500);
  }
}
```

### 3.2 `scene3d/diag.js` — register the surface (2 hunks)
```diff
@@ scene3d/diag.js  (import block, near line 45)
 import { attachCombat as _attachCombat } from "./diag/combat.js";
+import { attachCast as _attachCast } from "./diag/cast.js";
 import { attachPalettes as _attachPalettes } from "./diag/palettes.js";
@@ scene3d/diag.js  (attach loop, near line 481)
     ["combat",     _attachCombat],
+    ["cast",       _attachCast],
     ["palettes",   _attachPalettes],
```

### 3.3 `scene3d/entities.js` / `index.html` / `scene3d/loop.js` — the hooks
All are additive optional-chained calls. Exact current-code context shown; `+` lines are the additions.

**(a) `playCastSequence` — requested + suppression stamps (`entities.js:6728-6772`):**
```diff
   async playCastSequence(guid, spellId) {
     const g = guid >>> 0;
     const inst = this.entityMap.get(g);
     if (!inst) return;
+    // WS16 diag: open the cast record BEFORE any early return (spellId may be 0).
+    try { window.__diag?.cast?.onCastRequested?.({ guid: g, spellId }); } catch (_) {}
     // Fallback path A: missing spellId → vibe-pose.
     if (!spellId) {
+      try { window.__diag?.cast?.onCastSuppressed?.({ guid: g, spellId, reason: "noSpell" }); } catch (_) {}
       return;
     }
     const seq = getCastSequence(spellId);
     if (!seq) {
+      try { window.__diag?.cast?.onCastSuppressed?.({ guid: g, spellId, reason: "tableNotLoaded" }); } catch (_) {}
       return;
     }
     if (typeof this.setSwingMotion !== "function") {
+      try { window.__diag?.cast?.onCastSuppressed?.({ guid: g, spellId, reason: "noSetSwing" }); } catch (_) {}
       return;
     }
     if (CAST_STATE_MACHINE) {
       const nowMs = performance.now();
       if (inst._castBusyUntilMs && nowMs < inst._castBusyUntilMs) {
+        try { window.__diag?.cast?.onCastSuppressed?.({ guid: g, spellId, reason: "busyWindow" }); } catch (_) {}
         return; // already casting — ignore the recast
       }
```
> NOTE on the 3 `return;` lines above: in the live file each is preceded by the 4-line WS-B teardown comment block (`entities.js:6734-6737`, `:6746-6749`, `:6755-6758`). Insert the `onCastSuppressed` line immediately before the bare `return;` in each block.

**(b) `playCastSequence` — chain start (after the token bump, `entities.js:6777-6778`):**
```diff
     const token = ((inst._castSequenceToken | 0) + 1) | 0;
     inst._castSequenceToken = token;
+    // WS16 diag: chain committed past all early returns.
+    try {
+      window.__diag?.cast?.onChainStart?.({
+        guid: g, spellId, token,
+        busyUntilMs: inst._castBusyUntilMs ?? null,
+        windupCount: (seq.windupGestures || []).length,
+        hasCast: !!seq.castGesture,
+        fastCast: seq.fastCast, leadOnly: seq.leadOnly,
+      });
+    } catch (_) {}
```

**(c) `playCastSequence` — per-gesture stamps.** Thread the index through the windup/cast loop (`entities.js:6825-6831`):
```diff
-    for (const gesture of (seq.windupGestures || [])) {
-      const ok = await playGesture(gesture);
+    const _windups = seq.windupGestures || [];
+    for (let _i = 0; _i < _windups.length; _i++) {
+      const gesture = _windups[_i];
+      try { window.__diag?.cast?.onGesture?.({ guid: g, index: _i, motion: gesture.motion, name: gesture.name, isCast: false }); } catch (_) {}
+      const ok = await playGesture(gesture);
       if (!ok) return; // cancelled or entity vanished
     }
     if (seq.castGesture) {
+      try { window.__diag?.cast?.onGesture?.({ guid: g, index: _windups.length, motion: seq.castGesture.motion, name: seq.castGesture.name, isCast: true }); } catch (_) {}
       await playGesture(seq.castGesture);
     }
```

**(d) `playCastSequence` — casterEffect + complete (`entities.js:6885-6911`):**
```diff
     if (inst._castSequenceToken !== token) return;
     if ((seq.casterEffect | 0) !== 0) {
       try {
         if ( … window.__pluginClient.events.emit … ) {
           window.__pluginClient.events.emit("playEffect", { … });
+          try { window.__diag?.cast?.onCasterEffect?.({ guid: g, scriptId: (seq.casterEffect|0)>>>0, scale: seq.formulaScale }); } catch (_) {}
         }
       } catch (err) { … }
     }
     // F8-4 — chain completed: clear the cast-busy window …
     if (inst) inst._castBusyUntilMs = 0;
+    try { window.__diag?.cast?.onChainComplete?.({ guid: g }); } catch (_) {}
   }
```

**(e) `cancelCastSequence` — cancel stamp (`entities.js:6927-6939`).** Add an optional `cause` param so callers tag anim-break vs fizzle vs UseDone:
```diff
-  cancelCastSequence(guid) {
+  cancelCastSequence(guid, cause) {
     const inst = this.entityMap.get(guid >>> 0);
     if (!inst) return false;
     inst._castSequenceToken = ((inst._castSequenceToken | 0) + 1) | 0;
     inst._castBusyUntilMs = 0;
+    try { window.__diag?.cast?.onChainCancel?.({ guid: guid >>> 0, cause: cause ?? "cancel" }); } catch (_) {}
     try { … this.setMotion?.(guid >>> 0, 0x0003, stance, 1.0); } catch (_) {}
     return true;
   }
```
> The existing callers keep working (arg is optional). Recommended cause tags at the 3 call sites: `index.html:7838` `cancelCastSequence(lg, "fizzle")`, `index.html:8122` `cancelCastSequence(localGuid, "anim-break")`, `index.html:9186` (legacy W3.1) `cancelCastSequence(localGuid, "anim-break")`.

**(f) `setSwingMotion` — link-resolution counter (`entities.js:7163-7169`):**
```diff
     const canPlayReal =
       result &&
       (result.kind === "swing" || result.kind === "cast") &&
       (result.resolvedCommand >>> 0) !== 0 &&
       result.source === "wasm-link";
     const fetchKeyframes = this.wasmExports?.fetchEntityAnimationKeyframes;
+    // WS16 diag: record the link outcome per (stance, gesture-id). Miss-reason
+    // is derived from the same predicate the play-gate uses — no behavior change.
+    try {
+      if (window.__diag?.cast?.onLinkResolve) {
+        let reason = null;
+        if (canPlayReal && typeof fetchKeyframes === "function") reason = null;         // hit (pending fetch)
+        else if (!stance) reason = "stance-falsy";
+        else if (result?.source !== "wasm-link") reason = "not-wasm-link";
+        else if (result?.kind !== "swing" && result?.kind !== "cast") reason = "kind-mismatch";
+        else if ((result?.resolvedCommand >>> 0) === 0) reason = "resolved-zero";
+        else if (typeof fetchKeyframes !== "function") reason = "no-fetchKeyframes";
+        window.__diag.cast.onLinkResolve({
+          guid: g, cmd: (motionCmd >>> 0), stance, mtableId,
+          outcome: (canPlayReal && typeof fetchKeyframes === "function") ? "hit" : "miss",
+          reason,
+        });
+      }
+    } catch (_) {}
     if (!canPlayReal || typeof fetchKeyframes !== "function") {
```
> The two *later* miss paths (cache throw `:7202`, null clip `:7212`) can optionally emit a refined `onLinkResolve({outcome:"miss", reason:"cache-throw"|"null-clip"})` in their catch/guard for full fidelity — recommended but not required (the primary gate above already catches the dominant S1(a) case). If added, note they'd double-count the same (stance,cmd) as a prior "hit"; prefer emitting only in the terminal miss branches and moving the primary emit to *after* a successful `action.play()` (`:7252`). **Simplest correct wiring:** keep the single emit above (it records the *play-gate* outcome, which is exactly the S1(a) signal). Integration may refine.

**(g) `noteLocalSwingPrediction` — echo note (`entities.js:6619-6624`):**
```diff
   noteLocalSwingPrediction(cmd) {
     const c = (cmd >>> 0) || 0;
     if (c === 0) return;
     if (!this._localSwingEchoes) this._localSwingEchoes = new Map();
     this._localSwingEchoes.set(c, performance.now() + 500);
+    try { window.__diag?.cast?.onEchoNote?.(c); } catch (_) {}
   }
```

**(h) `loop.js::_armMotionAction` — echo consume (`loop.js:2605-2611`):**
```diff
   if (DISPATCH_PARITY_ON && actionCmd !== 0 &&
       em.consumeLocalSwingEcho?.(actionGuid, actionCmd)) {
+    try { window.__diag?.cast?.onEchoConsume?.({ cmd: actionCmd, hit: true }); } catch (_) {}
     // F6-2: optimistic local swing already played …
   } else if (actionCmd !== 0 && typeof em.setMotion === "function") {
```

**(i) `index.html` — fizzle / UseDone stamps (`index.html:7832-7860`):**
```diff
     if (errCode === 0x0402) {
       try {
         if (new URLSearchParams(window.location.search).get("castFizzle") !== "off") {
           const em = window.liveScene3d?.entityManager;
           const lg = (getLocalPlayerGuid?.() ?? 0) >>> 0;
+          try { window.__diag?.cast?.onFizzle?.({ guid: lg }); } catch (_) {}
           if (em && lg && typeof em.cancelCastSequence === "function") {
-            em.cancelCastSequence(lg);
+            em.cancelCastSequence(lg, "fizzle");
           }
         }
       } catch (_) {}
     }
@@ (kind === 14 UseDone, ~line 7854)
     try {
       const em = window.liveScene3d?.entityManager;
       const lg = (getLocalPlayerGuid?.() ?? 0) >>> 0;
+      try { window.__diag?.cast?.onUseDone?.({ guid: lg }); } catch (_) {}
       if (em && lg && typeof em.clearCastBusy === "function") {
         em.clearCastBusy(lg);
       }
     } catch (_) {}
```

**(j) `index.html` — `__hbWasm.castArbitrationDiag` getter (`index.html:2118-2123`, alongside the existing rider):**
```diff
           ...(typeof __hbWasmNs?.movementPendingMotionsDiag === "function"
             ? { movementPendingMotionsDiag: () => __hbWasmNs.movementPendingMotionsDiag() >>> 0 }
             : {}),
+          // WS16 diag rider (rides v6, no manifest bump): autonomy latch +
+          // interpreter forward-slot occupancy packed into one u32.
+          ...(typeof __hbWasmNs?.castArbitrationDiag === "function"
+            ? { castArbitrationDiag: () => __hbWasmNs.castArbitrationDiag() >>> 0 }
+            : {}),
```

**(k) `picking.js` — OPTIONAL `t_sent` refinement.** Recommended **SKIP**: `playCastSequence` is called one statement after `castTargetedSpell` (`picking.js:674→694`), so `onCastRequested`'s stamp is within microseconds of the wire send; the sub-ms gap isn't worth a 4th touched call-site. If precise wire-send timing is ever needed, add `window.__diag?.cast?.onCastRequested?.({guid: localGuid, spellId, t_sent: performance.now()})` at `picking.js:674` — but the `onChainStart` `t_sent` fallback already covers it.

### 3.4 NEW file: `probe_cast_matrix.cjs` (full file inline in §4.3; syntax-checked `node --check` OK)

### 3.5 Rust: the `castArbitrationDiag` getter (the one wasm change)
Mirrors `movementPendingMotionsDiag` exactly. Rides manifest v6 (additive, no bump — `lib.rs:909-913` precedent). **Needs a wasm rebuild** (integration owns the single rebuild, foundation §4.4).

**`src/lib.rs`** — static + fn (insert after `movement_pending_motions_diag`, `lib.rs:937`):
```diff
 #[wasm_bindgen(js_name = movementPendingMotionsDiag)]
 pub fn movement_pending_motions_diag() -> u32 {
     MOVEMENT_PENDING_MOTIONS_DIAG.load(std::sync::atomic::Ordering::Relaxed)
 }
+
+/// WS16 diag (2026-07-12) — packed movement-arbitration snapshot for the
+/// cast surface. Rides v6 (additive, diagnostics-only; same contract as
+/// MOVEMENT_PENDING_MOTIONS_DIAG). Bit layout:
+///   bit0  last_move_was_autonomous (latch: 1=raw keyboard drives)
+///   bit1  cast_move_enabled
+///   bit2  slide_cast_enabled
+///   bits4-5 forward-slot occupancy: 0=none 1=walk 2=run 3=substate
+///   bits16-31 low16 of the held substate cmd (when occupancy==3)
+static CAST_ARBITRATION_DIAG: std::sync::atomic::AtomicU32 =
+    std::sync::atomic::AtomicU32::new(0);
+
+#[wasm_bindgen(js_name = castArbitrationDiag)]
+pub fn cast_arbitration_diag() -> u32 {
+    CAST_ARBITRATION_DIAG.load(std::sync::atomic::Ordering::Relaxed)
+}
```

**`src/lib.rs`** — stamp it in the `TickMovement` `Ok(())` arm (next to the existing store, `lib.rs:47401`):
```diff
                                 MOVEMENT_PENDING_MOTIONS_DIAG.store(
                                     movement.local_registry_pending_motions(w.player.guid)
                                         as u32,
                                     std::sync::atomic::Ordering::Relaxed,
                                 );
+                                CAST_ARBITRATION_DIAG.store(
+                                    movement.cast_arbitration_diag(),
+                                    std::sync::atomic::Ordering::Relaxed,
+                                );
```

**`crates/holtburger-core/src/client/movement/handle.rs`** — delegating accessor (after `local_registry_pending_motions`, `handle.rs:423`):
```diff
     pub fn local_registry_pending_motions(&self, local_guid: Guid) -> usize {
         self.inner.local_registry_pending_motions(local_guid)
     }
+
+    /// WS16 diag forward: packed autonomy-latch + interpreter forward-slot
+    /// occupancy for the cast surface (see `MovementSystem::cast_arbitration_diag`).
+    pub fn cast_arbitration_diag(&self) -> u32 {
+        self.inner.cast_arbitration_diag()
+    }
```

**`crates/holtburger-core/src/client/movement/system.rs`** — the method (near `local_registry_pending_motions`, `system.rs:6680`; `InterpretedForwardCommand` is already imported at `system.rs:11`):
```diff
     pub(crate) fn local_registry_pending_motions(&self, local_guid: Guid) -> usize {
         …
     }
+
+    /// WS16 diag: pack the movement-arbitration snapshot the cast surface
+    /// reads. Latch is always meaningful; forward-slot occupancy is the
+    /// interpreter's single forward slot (populated under ?cmdInterp=on, the
+    /// default) — a cast gesture parks a Substate there at zero locomotion
+    /// (the SLIDECAST mechanism, interp_state.rs:34-36).
+    pub(crate) fn cast_arbitration_diag(&self) -> u32 {
+        let mut out: u32 = 0;
+        if self.last_move_was_autonomous { out |= 0x1; }
+        if self.cast_move_enabled() { out |= 0x2; }
+        if self.slide_cast_enabled() { out |= 0x4; }
+        let (occ, sub) = match self
+            .command_interpreter
+            .as_ref()
+            .and_then(|it| it.forward_command)
+        {
+            Some(InterpretedForwardCommand::WalkForward) => (1u32, 0u32),
+            Some(InterpretedForwardCommand::RunForward) => (2u32, 0u32),
+            Some(InterpretedForwardCommand::Substate(cmd)) => (3u32, cmd & 0xffff),
+            None => (0u32, 0u32),
+        };
+        out |= (occ & 0x3) << 4;
+        out |= (sub & 0xffff) << 16;
+        out
+    }
```
> Verify at integration: `CommandInterpreter.forward_command` is read as a plain field at `system.rs:2244` (`interp.forward_command`), so it's in-module-accessible; if it's private, add a `pub(crate) fn forward_command(&self) -> Option<InterpretedForwardCommand>` accessor on `CommandInterpreter` and call that instead. `InterpretedForwardCommand` derives `Copy` (it's a small enum) so the `and_then` copy is fine.

### 3.6 `docs/url-flags.md`
**No new row** — WS16 adds no URL flag (observation-only, matching every existing `__diag` surface). If the maintainers want a discoverability note, add one line under the diagnostics section (NOT a flag row): *"`window.__diag.cast` — spell-cast pipeline observability (chain state, per-cast timeline, link hit/miss, echo dedup, movement-arbitration snapshot). Default-ON, read-cheap; see `scene3d/diag/cast.js`."* Drafted here for the integrator's convenience; strictly optional.

---

## 4. TESTS

### 4.1 NEW node unit test: `test_cast_diag.mjs` — **RUN ON THIS BOX: 28/28 PASS**
Mirrors `test_ac_spell_cast_sequence.mjs`'s plain-`check()` harness; imports `attachCast` and drives the hooks with synthetic cast data (a complete void cast, a stance-falsy link-miss repro, a busy-window suppression, a fizzle-cancel, echo counters, `assertLastCast` PASS+DRIFT, graceful `movementSnapshot` with no wasm, and `reset`). Run: `cd apps/holtburger-web/ && node test_cast_diag.mjs`.

```javascript
// WS16 — scene3d/diag/cast.js unit tests (headless, no browser).
//
// Run with:
//   cd apps/holtburger-web/
//   node test_cast_diag.mjs
//
// Drives the __diag.cast surface hooks with synthetic cast data and asserts
// the chain state, per-cast timeline, link-resolution counters, echo-dedup
// counters, and the assertLastCast probe helper. Exits non-zero on failure.
// Mirrors test_ac_spell_cast_sequence.mjs's plain-node check() harness.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modUrl = "file://" + resolvePath(__dirname, "scene3d/diag/cast.js");
const { attachCast } = await import(modUrl);

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}

console.log("===========================================================");
console.log("WS16 — __diag.cast surface unit tests");
console.log("===========================================================");

const diag = {};
attachCast(diag);
const cast = diag.cast;

check("attachCast installs diag.cast", cast && typeof cast === "object");
check("hooks are callable", typeof cast.onCastRequested === "function" && typeof cast.onGesture === "function");

const G = 0x50000123;   // synthetic local player guid

// ── Scenario 1: a 1-windup void cast (spell 2331, colored powerup) that
//    resolves its links and completes normally. ──
cast.onCastRequested({ guid: G, spellId: 2331, school: 2, shape: "Self", level: 7, fastCast: false });
check("requested opens a live chain", cast.state(G)?.phase === "requested");
cast.onChainStart({ guid: G, spellId: 2331, token: 5, busyUntilMs: 1000, windupCount: 1, hasCast: true, fastCast: false });
check("chainStart records token", cast.state(G)?.token === 5);
check("chainStart computes gestureCount=2", cast.state(G)?.gestureCount === 2);
// windup gesture 0x10000132 (MagicPowerUp08Purple) resolves (hit)
cast.onLinkResolve({ guid: G, cmd: 0x10000132, stance: 0x8000_0049, mtableId: 0x09000001, outcome: "hit" });
cast.onGesture({ guid: G, index: 0, motion: 0x10000132, name: "MagicPowerUp08Purple", isCast: false });
check("gesture advances index", cast.state(G)?.gestureIndex === 0);
// cast gesture 0x40000035 (MagicTransfer) resolves (hit)
cast.onLinkResolve({ guid: G, cmd: 0x40000035, stance: 0x8000_0049, mtableId: 0x09000001, outcome: "hit" });
cast.onGesture({ guid: G, index: 1, motion: 0x40000035, name: "MagicTransfer", isCast: true });
check("cast phase set", cast.state(G)?.phase === "cast");
cast.onCasterEffect({ guid: G, scriptId: 74, scale: 1.0 });
cast.onChainComplete({ guid: G });
check("complete clears live chain", cast.state(G) === null);

{
  const tl = cast.lastTimeline(G);
  check("timeline: outcome complete", tl?.outcome === "complete", tl?.outcome);
  check("timeline: 1 windup stamp", tl?.deltasMs?.windups?.length === 1, `${tl?.deltasMs?.windups?.length}`);
  check("timeline: cast delta present", tl?.deltasMs?.cast != null);
  check("timeline: casterEffect delta present", tl?.deltasMs?.casterEffect != null);
  check("timeline: windup cmd humanized to hex", tl?.deltasMs?.windups?.[0]?.cmd === "0x10000132");
}

// ── Scenario 2: link MISS on the colored windup (the S1(a) void repro). ──
const G2 = 0x50000222;
cast.onCastRequested({ guid: G2, spellId: 2331, school: 2, shape: "Self", level: 7 });
cast.onChainStart({ guid: G2, spellId: 2331, token: 1, busyUntilMs: 1000, windupCount: 1, hasCast: true });
cast.onLinkResolve({ guid: G2, cmd: 0x10000132, stance: 0, mtableId: 0x09000001, outcome: "miss", reason: "stance-falsy" });
cast.onGesture({ guid: G2, index: 0, motion: 0x10000132, name: "MagicPowerUp08Purple", isCast: false });
cast.onLinkResolve({ guid: G2, cmd: 0x40000035, stance: 0, mtableId: 0x09000001, outcome: "miss", reason: "stance-falsy" });
cast.onGesture({ guid: G2, index: 1, motion: 0x40000035, name: "MagicTransfer", isCast: true });
cast.onChainComplete({ guid: G2 });
{
  const ls = cast.linkStats({ castOnly: true });
  const cell = ls["0x00000000"]?.["0x10000132"];
  check("linkStats records the miss under stance 0", cell?.miss === 1, JSON.stringify(cell));
  check("linkStats captures miss reason", cell?.reasons?.["stance-falsy"] === 1);
  const s = cast.summary();
  check("summary rolls up cast link miss", s.castLink.miss === 2 && s.castLink.hit === 2, JSON.stringify(s.castLink));
}

// ── Scenario 3: busy-window suppression (S1(e)). ──
const G3 = 0x50000333;
cast.onCastRequested({ guid: G3, spellId: 7 });
cast.onCastSuppressed({ guid: G3, spellId: 7, reason: "busyWindow" });
check("suppression counted", cast.summary().suppress.busyWindow === 1);
check("suppressed cast committed to timeline", cast.lastTimeline(G3)?.outcome === "suppressed");
check("suppressed chain cleared", cast.state(G3) === null);

// ── Scenario 4: fizzle mid-cast cancels the chain (S2(b)). ──
const G4 = 0x50000444;
cast.onCastRequested({ guid: G4, spellId: 9 });
cast.onChainStart({ guid: G4, spellId: 9, token: 2, windupCount: 0, hasCast: true });
cast.onFizzle({ guid: G4 });
cast.onChainCancel({ guid: G4, cause: "fizzle" });
{
  const tl = cast.lastTimeline(G4);
  check("fizzle recorded on timeline", tl?.deltasMs?.fizzle != null);
  check("cancel cause captured", tl?.cancelCause === "fizzle", tl?.cancelCause);
  check("fizzle + cancel counters", cast.summary().fizzles === 1 && cast.summary().chainsCancelled === 1);
}

// ── Scenario 5: echo-dedup counters. ──
cast.onEchoNote(0x10000132);
cast.onEchoConsume({ cmd: 0x10000132, hit: true });
cast.onEchoConsume({ cmd: 0x40000035, hit: false });
{
  const e = cast.echoStats();
  check("echo noted/consumed counters", e.noted === 1 && e.consumedHit === 1 && e.consumedMiss === 1, JSON.stringify(e));
}

// ── Scenario 6: assertLastCast probe helper (PASS + DRIFT). ──
{
  const good = cast.assertLastCast(G, { forbidSuppressed: true, minWindups: 1, expectCast: true, expectCasterEffect: true, expectOutcome: "complete" });
  check("assertLastCast PASS on the good complete cast", good.pass === true, JSON.stringify(good.checks.filter((c) => !c.pass)));
  const bad = cast.assertLastCast(G3, { forbidSuppressed: true, expectCast: true });
  check("assertLastCast DRIFT on the suppressed cast", bad.pass === false);
}

// ── Scenario 7: movementSnapshot degrades gracefully with no wasm. ──
{
  const snap = cast.movementSnapshot();
  check("movementSnapshot returns an object with null wasm", snap && snap.latchAutonomous === null && snap.pendingMotions === null);
}

// ── Scenario 8: reset() zeroes counters, keeps the surface. ──
cast.reset();
{
  const s = cast.summary();
  check("reset zeroes counters", s.requested === 0 && s.chainsCompleted === 0 && s.castLink.miss === 0);
  check("reset clears timeline", cast.timelineTail(10).length === 0);
}

// ── Summary ──
console.log("");
console.log(`Cases: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
else console.log("All WS16 __diag.cast tests PASS.");
```

Observed output on this box:
```
Cases: 28 passed, 0 failed
All WS16 __diag.cast tests PASS.
```

### 4.2 TODO-FOR-LAPTOP — headless validation recipe
No live ACE and no browser on the buildbox, so the runtime resolution of S1(a) is deferred. On the laptop (1070 Chrome over CDP, live vanilla ACE udp 9000/9001):

1. **Rebuild wasm** (the `castArbitrationDiag` getter): from `apps/holtburger-web/`, `kill $(pgrep -f rust-analyzer)` then the foundation §4.4 `capped-build wasm-pack build --target web --out-dir pkg --dev` — ONCE, integration-owned. (The JS half works without this; `movementSnapshot().latchAutonomous` just reads `null` until the rebuild lands.)
2. **Serve**: `python3 external/holtburger/scripts/serve.py` → :8765.
3. **Node unit test** (cheap, no browser): `cd apps/holtburger-web/ && node test_cast_diag.mjs` → expect `28 passed, 0 failed`. Also re-run the sibling `node test_ac_spell_cast_sequence.mjs` (unchanged; confirms the JSON contract the probe leans on).
4. **Manual devtools smoke** (bare-default URL, `?nosw=1`): log in, spawn, `@telepoi holtburg`, enter Magic stance, arm a war bolt via the combat bar, click a mob. Then in console:
   - `__diag.cast.summary()` → `requested≥1`, `chainsCompleted≥1`, `suppress.busyWindow` low, `castLink.miss === 0` (if 0 → arms resolved; if >0 → the S1(a) bug is live and `__diag.cast.linkStats({castOnly:true})` names the gesture + reason).
   - `__diag.cast.lastTimeline()` → inspect `deltasMs`: `windups[]` populated, `cast` present, `casterEffect` present for spells with a caster effect, `useDone` ≥ `cast`.
   - `__diag.cast.movementSnapshot()` while holding W mid-cast → expect `forwardSlot:"substate"` (gesture holds the slot) and `latchAutonomous:0` during the gesture; `reclaimCause.useTime` ticking between windups is the S3 leak.
5. **Automated matrix**: `K1_CDP_URL=http://127.0.0.1:9223 CAST_SPELLS="1:target,1708:self,2331:self" node probe_cast_matrix.cjs`. Expect `drift: 0`. Exit code 2 = at least one DRIFT (inspect the `DRIFT [...]` lines). Add void ids to `CAST_SPELLS` once a void-trained char is confirmed via `__pluginClient.player.knownSpells()`.
   - **Expected observations** (from ACE ref §1.8): each spell plays `windupGestures.length` windups then a cast gesture; `cast` delta ≤ `totalDurationS*1000/2.0*1.6`; `casterEffect` fires for spells with `casterEffect!=0`; **no** movement-fizzle on the NPK test char (do not expect one); `useDone` after `cast`.

### 4.3 NEW file: `probe_cast_matrix.cjs` (syntax-checked `node --check` OK; spell-parse smoke OK)
```javascript
// probe_cast_matrix.cjs — WS16 headless cast-regression harness.
//
// RUNS ON THE LAPTOP (live vanilla ACE on udp 9000/9001 + the 1070 Chrome
// over CDP). Authored + syntax-checked on the buildbox; the live drive is a
// laptop task (see the TODO-FOR-LAPTOP recipe in WS16-diag-harness.md).
//
// What it does (mirrors k1_drive_combat.cjs's connect→login→spawn→teleport
// scaffold, then drives a configurable war+void spell list):
//   1. Connect over CDP, cache-bust, login, spawn, @telepoi holtburg.
//   2. Learn the test spells (@addspell) + a nearby target (@create) for the
//      targeted-bolt cases.
//   3. For each spell: __diag.cast.reset(), fire the cast, wait out the
//      chain, then read __diag.cast + emit PASS/DRIFT lines per check:
//        gesture-played · timing-in-tolerance · caster-effect-seen ·
//        link-resolved (no silent no-op) · UseDone-ordering · projectile-moved
//   4. Print a matrix summary + exit non-zero on any DRIFT.
//
// The checks are self-calibrating: expected windup count + total duration
// come from the page's own getCastSequence(spellId), so adding a spell to
// CAST_SPELLS needs no code change here.
//
// Config (env):
//   K1_CDP_URL   CDP endpoint            (default http://127.0.0.1:9223)
//   K1_PAGE_URL  app URL (append flags)  (default http://localhost:7080/apps/holtburger-web/index.html)
//   CAST_ACCOUNT / CAST_PASSWORD         (default tailnet1/tailnet1)
//   CAST_SPELLS  csv "id:self|target"    (default war bolts + a void/self set)
//   CAST_TOL     timing tolerance factor (default 1.6 — CastSpeed 2.0 + RTT slack)

const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const CDP_URL = process.env.K1_CDP_URL || "http://127.0.0.1:9223";
const PAGE_URL = process.env.K1_PAGE_URL || "http://localhost:7080/apps/holtburger-web/index.html";
const ACCOUNT = process.env.CAST_ACCOUNT || "tailnet1";
const PASSWORD = process.env.CAST_PASSWORD || "tailnet1";
const TOL = Number(process.env.CAST_TOL || "1.6");
const OUT_DIR = process.env.CAST_OUT_DIR || "/mnt/wbterminal1/tmp/claude-scratch/ws16";
const HB_PREFIX = "http://localhost:7080/apps/holtburger-web/";

// Default matrix: War bolts (targeted) + Void/self-buff (self). "self" casts
// promote to targeted-at-own-guid client-side (foundation §1.1). Void needs a
// void-trained char; swap in real void ids on the test char.
//   1708 = Wedding Bliss (3-windup self chain — the slideCast validation spell)
//   2331 = single Purple windup + MagicTransfer (colored-band void repro)
const DEFAULT_SPELLS = "1:target,1708:self,2331:self";
const SPELLS = (process.env.CAST_SPELLS || DEFAULT_SPELLS)
  .split(",").map((s) => s.trim()).filter(Boolean)
  .map((tok) => {
    const [id, mode] = tok.split(":");
    return { spellId: Number(id), mode: (mode || "target").toLowerCase() };
  });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let DRIFT = 0, CHECKS = 0;
function line(spellId, name, pass, detail) {
  CHECKS += 1;
  if (!pass) DRIFT += 1;
  console.log(`  ${pass ? "PASS" : "DRIFT"} [spell ${spellId}] ${name}${detail ? " — " + detail : ""}`);
}

async function attemptLogin(page, attempt) {
  console.log(`# login attempt ${attempt}`);
  await page.fill('input[name="account"]', ACCOUNT);
  await page.fill('input[name="password"]', PASSWORD);
  await page.fill('input[name="bridge_url"]', "ws://127.0.0.1:8080/");
  await page.fill('input[name="server_host"]', "127.0.0.1");
  await page.fill('input[name="server_port"]', "9000");
  await page.click("#login-form button[type=submit]", { noWaitAfter: true }).catch(() => null);
  try { await page.waitForSelector("#selection:not([hidden])", { timeout: 25_000 }); return true; }
  catch (_) { return false; }
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  let page = ctx.pages().find((p) => p.url().startsWith(HB_PREFIX)) || await ctx.newPage();

  // ── cache-bust + reload ──
  await page.goto("about:blank");
  const cdp = await page.context().newCDPSession(page);
  try { await cdp.send("Network.clearBrowserCache"); } catch (_) {}
  await page.evaluate(async () => {
    if ("serviceWorker" in navigator) {
      for (const r of await navigator.serviceWorker.getRegistrations()) { try { await r.unregister(); } catch (_) {} }
    }
    if ("caches" in window) { for (const k of await caches.keys()) { try { await caches.delete(k); } catch (_) {} } }
  }).catch(() => {});
  // ?nosw=1 per project law; default flags otherwise (bare-default acceptance bar).
  const url = PAGE_URL + (PAGE_URL.includes("?") ? "&" : "?") + "nosw=1&v=" + Date.now();
  console.log(`reload: ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  page.on("console", (m) => { if (/error|fizzle|cast|spell|warn/i.test(m.text())) console.log(`[browser ${m.type()}] ${m.text()}`); });
  page.on("pageerror", (e) => console.error(`[pageerror] ${e.message}`));

  await page.waitForFunction(() => { const r = document.getElementById("results"); return r && /PASS/.test(r.innerHTML); }, { timeout: 30_000 });
  console.log("smoke: PASS");

  // ── login (retry for the double-connect kick) ──
  let loggedIn = false;
  for (let a = 1; a <= 3 && !loggedIn; a += 1) {
    loggedIn = await attemptLogin(page, a);
    if (!loggedIn) { console.log("  waiting 12s for ACE to drop stale session…"); await sleep(12_000); }
  }
  if (!loggedIn) { console.error("FAIL: login never reached selection"); await browser.close(); process.exit(1); }
  await page.locator("#character-ul button[data-id]").first().click();
  await page.waitForFunction(() => { const s = document.getElementById("login-status"); return s && /InWorld|Spawned/.test(s.innerText); }, { timeout: 25_000 });
  console.log("spawned");
  try { await page.waitForSelector("#post-spawn:not([hidden])", { timeout: 8_000 }); } catch (_) {}

  const sendChat = (l) => page.evaluate((x) => window.__sessionHandle?.sendChat?.(x), l);
  await sendChat("@telepoi holtburg");
  await sleep(4_000);

  // Ensure the caster is in Magic stance (stance low16 0x0049).
  await page.evaluate(() => {
    const low = window.__getCurrentStanceLow?.();
    if ((low & 0xffff) !== 0x49) window.__sessionHandle?.sendChat?.("/mode magic");
  });
  await sleep(1_500);

  // Learn the test spells + spawn a target for the targeted cases.
  for (const { spellId } of SPELLS) { await sendChat(`@addspell ${spellId}`); await sleep(600); }
  const needTarget = SPELLS.some((s) => s.mode === "target");
  if (needTarget) { await sendChat("@create 7 3"); await sleep(3_000); }

  // Preload the cast-sequence table so getCastSequence is populated + find a target.
  const setup = await page.evaluate(async () => {
    try { const m = await import("./ui/ac_spell_cast_sequence.js"); if (m.getCastSequence) m.getCastSequence(1); } catch (_) {}
    const localGuid = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;
    let target = null;
    const em = window.liveScene3d?.entityManager;
    if (em?.entityMap) {
      for (const [g] of em.entityMap) { if ((g >>> 0) !== localGuid && (g >>> 0) >= 0x80000000) { target = g >>> 0; } }
    }
    return { localGuid, target, castDiag: !!window.__diag?.cast };
  });
  console.log(`localGuid=0x${(setup.localGuid >>> 0).toString(16)} target=${setup.target ? "0x" + setup.target.toString(16) : "(none)"} __diag.cast=${setup.castDiag}`);
  if (!setup.castDiag) { console.error("FAIL: window.__diag.cast surface absent — is scene3d/diag/cast.js wired?"); await browser.close(); process.exit(1); }

  console.log("\n=== CAST MATRIX ===");
  for (const { spellId, mode } of SPELLS) {
    // Expected shape from the page's own generated table.
    const exp = await page.evaluate(async (id) => {
      const m = await import("./ui/ac_spell_cast_sequence.js");
      const e = m.getCastSequence(id);
      return e ? { windups: e.windupGestures.length, total: e.totalDurationS, casterEffect: e.casterEffect | 0, fastCast: !!e.fastCast } : null;
    }, spellId);
    if (!exp) { line(spellId, "in-cast-sequence-table", false, "getCastSequence returned null"); continue; }

    const tgt = mode === "target" ? setup.target : setup.localGuid;
    if (mode === "target" && !tgt) { line(spellId, "has-target", false, "no creature spawned"); continue; }

    // Reset the surface, fire the cast, wait out the chain (+ RTT + UseDone).
    await page.evaluate(() => window.__diag.cast.reset());
    const aceCastSpeed = 2.0; // ACE Player_Magic.CastSpeed; the client paces at CAST_SPEED too.
    const waitMs = Math.max(1500, Math.round((exp.total * 1000 / aceCastSpeed) + 2500));
    await page.evaluate(({ g, id }) => {
      window.liveScene3d?.entityManager?.setSelectedTarget?.(g >>> 0);
      window.__sessionHandle?.castTargetedSpell?.(g >>> 0, id);
    }, { g: tgt, id: spellId });
    await sleep(waitMs);

    const res = await page.evaluate(({ id, localGuid }) => {
      const c = window.__diag.cast;
      const tl = c.lastTimeline(localGuid);
      const snap = c.movementSnapshot();
      const summary = c.summary();
      return { tl, snap, summary };
    }, { id: spellId, localGuid: setup.localGuid });
    const tl = res.tl;

    // ── Checks ──
    if (!tl) { line(spellId, "cast-recorded", false, "no __diag.cast timeline for local player"); continue; }
    line(spellId, "not-suppressed", tl.outcome !== "suppressed", tl.suppressedReason || "");
    // gesture played: expected windup count (fastCast/leadOnly ⇒ 0) + a cast stamp
    line(spellId, "windups-played", tl.deltasMs.windups.length >= exp.windups, `got ${tl.deltasMs.windups.length}/${exp.windups}`);
    line(spellId, "cast-gesture-played", tl.deltasMs.cast != null, tl.deltasMs.cast != null ? `at ${tl.deltasMs.cast}ms` : "MISSING (silent no-op?)");
    // timing within tolerance of the CastSpeed-scaled authored duration
    const budget = Math.round(exp.total * 1000 / 2.0 * TOL);
    if (tl.deltasMs.cast != null) line(spellId, "timing-in-tolerance", tl.deltasMs.cast <= budget, `cast ${tl.deltasMs.cast}ms <= ${budget}ms`);
    // link resolution: no cast-gesture silent no-op (miss count over cast band)
    line(spellId, "links-resolved", res.summary.castLink.miss === 0, `miss=${res.summary.castLink.miss} hit=${res.summary.castLink.hit}`);
    // effect script seen (only when the spell has a caster effect)
    if (exp.casterEffect !== 0) line(spellId, "caster-effect-seen", tl.deltasMs.casterEffect != null, tl.deltasMs.casterEffect != null ? `at ${tl.deltasMs.casterEffect}ms` : "no CasterEffect emit");
    // UseDone ordering: if a UseDone arrived, it should be at/after the cast gesture
    if (tl.deltasMs.useDone != null && tl.deltasMs.cast != null) line(spellId, "usedone-after-cast", tl.deltasMs.useDone >= tl.deltasMs.cast - 50, `useDone ${tl.deltasMs.useDone}ms vs cast ${tl.deltasMs.cast}ms`);
    // movement-arbitration snapshot (informational — records the latch/slot at read time)
    console.log(`    arb: latch=${res.snap.latchAutonomous} fwdSlot=${res.snap.forwardSlot} pending=${res.snap.pendingMotions} reclaim=${JSON.stringify(res.snap.reclaimCause)}`);
    // projectile moved (targeted bolts only, best-effort): a missile entity gained velocity
    if (mode === "target") {
      const moved = await page.evaluate(() => {
        const em = window.liveScene3d?.entityManager; if (!em?.entityMap) return null;
        for (const [, inst] of em.entityMap) { if (inst?.isMissile || inst?.physicsState === "Missile") return true; }
        return false;
      });
      if (moved !== null) line(spellId, "projectile-present", moved === true, moved ? "" : "no missile entity seen (may have already impacted)");
    }
  }

  const shot = path.join(OUT_DIR, "cast-matrix-final.png");
  await page.screenshot({ path: shot }).catch(() => null);
  console.log(`\nscreenshot: ${shot}`);
  console.log("\n=== SUMMARY ===");
  console.log(`checks: ${CHECKS}  drift: ${DRIFT}`);
  await browser.close();
  process.exit(DRIFT > 0 ? 2 : 0);
})();
```

---

## 5. EYE-TEST QUEUE (1070 GPU box — batched; do NOT run a solo 1070 session per foundation §4.3)

WS16 is observation-only, so it has **no visual of its own** — but the surface is the *instrument* for the batched 1070 A/B the other workstreams owe. Queue these combos with the expected `__diag.cast` reading recorded alongside the eyeshot:

| # | Flag combo (bare default unless noted) | Visual to watch | `__diag.cast` expected reading |
|---|---|---|---|
| E1 | bare default, war bolt on a mob | arms rise through the windup, bolt launches, recoil | `linkStats({castOnly}).miss===0`; `lastTimeline().deltasMs` windups+cast+casterEffect all present |
| E2 | bare default, **void** self-buff (colored powerup `0x10000132`) | arms rise on the Purple windup | `linkStats` shows a `hit` on `0x10000132`; if a `miss` appears here with reason `stance-falsy`/`not-wasm-link`, that IS the S1(a) void bug |
| E3 | bare default, hold-W through a 3-windup cast (spell 1708) | held-W dies at the first gesture, stays dead | `movementSnapshot().forwardSlot==="substate"` during gestures; `reclaimCause.useTime` ticking between windups = S3 leak visible |
| E4 | `?slideCast=on`, hold strafe + cast | continuous strafe slide | `forwardSlot==="substate"` while sidestep survives; correlate with WS on slidecast |
| E5 | fizzle a cast (move a PK char >6m, or force `WeenieError 0x0402`) | windup cuts, no success glow | `lastTimeline().cancelCause==="fizzle"`, `deltasMs.fizzle` set, `casterEffect` absent |
| E6 | spam-click one spell during recoil | one windup, not N stacked | `summary().suppress.busyWindow` increments; only 1 `chainsStarted` per accepted cast |

Deliver these as a queued batch to whoever runs the next 1070 pass; WS16's contribution is that each row now has a **numeric** expected alongside the eyeball.

---

## 6. RISKS + INTERACTIONS

### 6.1 Risks
- **R1 (low): wasm rebuild coupling.** `castArbitrationDiag` needs the single integration rebuild (foundation §4.4). Mitigated: the JS surface typeof-guards the getter and returns `null` when absent — the entire JS half (surface + all timeline/link/echo data) ships and works on the *current* pkg; only `movementSnapshot().latchAutonomous/forwardSlot` read `null` until the rebuild. No manifest bump (rides v6). If the rebuild is deferred, everything else still functions.
- **R2 (low): `cancelCastSequence(guid, cause)` arg addition.** Adding an optional 2nd param is backward-compatible (existing 1-arg callers unaffected). The 3 call sites that pass `cause` are cosmetic (tag only). If a WS touches those exact lines, coordinate the `cause` string; a plain `cancelCastSequence(guid)` still works and tags `cause:"cancel"`.
- **R3 (low): link-counter double-count.** The single `onLinkResolve` emit records the *play-gate* outcome. The optional refined emits in the two later miss branches (cache-throw/null-clip) could double-count a (stance,cmd) already counted as a "hit". §3.3(f) recommends the single-emit wiring to avoid this; integration may refine to a post-`play()` hit emit if full fidelity is wanted.
- **R4 (very low): timeline ring memory.** Bounded at 64 casts × ~16 windup stamps — a few KB, never grows. `reset()` zeroes it.
- **R5 (very low): subscription leak in tests.** Handled — `_installInitiatedSubscription` early-returns under Node (`typeof window === "undefined"`), so no dangling `setInterval`. Verified: the unit test exits 0 cleanly.
- **R6 (naming): gesture-id → name coordination with WS01.** `linkStats`/`timeline` key on the raw u32 and humanize via `data/motion-command-names.json` (the same table combat.js uses). WS01 owns the canonical naming; if WS01 renames the map or the field, update the fetch path in `cast.js` (single line, `attachCast` bottom).

### 6.2 Interactions / files touched (for safe integration ordering)
Every file WS16 would touch (nothing edited yet — packet only):
- **NEW, no conflict:** `scene3d/diag/cast.js`, `probe_cast_matrix.cjs`, `test_cast_diag.mjs`.
- **`scene3d/diag.js`** — 2 additive lines (import + attach row). No other WS should need this file; low conflict.
- **`scene3d/entities.js`** — additive hooks in `playCastSequence` (6728-6911), `setSwingMotion` (7163), `cancelCastSequence` (6927), `noteLocalSwingPrediction` (6619). ⚠ **High-traffic file** — WS01 (link naming), WS08/WS14 (recast feel), and any WS altering `playCastSequence`/`setSwingMotion` will co-edit. WS16's hooks are pure inserts at stable anchor points (top-of-fn, post-token-bump, the windup loop, the canPlayReal gate); merge by anchoring on the symbols, not line numbers. If another WS restructures `playCastSequence`, keep the `onCastRequested`(top)/`onChainStart`(post-token)/`onGesture`(loop)/`onChainComplete`(end) ordering.
- **`index.html`** — additive hooks in the kind=13/14/61 wire handlers (7808-8177) + one `__hbWasm` getter row (2118). ⚠ Co-edited by movement/cast WSs touching the recv loop; inserts are localized.
- **`scene3d/loop.js`** — 1 additive line in `_armMotionAction` (2605). Low conflict.
- **`src/lib.rs`** — 1 static + 1 fn + 1 stamp line. ⚠ Any WS adding a wasm diag getter co-edits this region (2118-region JS + 47401-region stamp); all such riders are additive to v6 — order doesn't matter, just don't clobber the `pkg/` between builds (integration owns the single rebuild).
- **`crates/holtburger-core/src/client/movement/handle.rs` + `system.rs`** — 1 accessor each. ⚠ The movement crate is the hottest Rust surface for the movement WSs; WS16's additions are read-only accessors (no state mutation) at the bottom of the impl blocks — minimal conflict, but coordinate the rebuild.
- **`docs/url-flags.md`** — no row (optional 1-line diagnostics note only).

**Coordination asks:**
- **WS01** (link naming): agree the counter is keyed on raw gesture u32 + humanized via `data/motion-command-names.json`; WS01's canonical names flow through that table. `__diag.cast.linkStats()` is the shared read surface for "did gesture X resolve?".
- **Movement WSs** (castMove/slideCast/cmdInterp): `movementSnapshot()` is the shared read for latch/forward-slot/reclaim state — use it to assert your arbitration changes instead of adding parallel getters.
- **Recast/feel WSs** (WS08/WS14): `summary().suppress.busyWindow` + timeline `outcome:"suppressed"` measure the busy-window gate you may tune.

---

## 7. HOW OTHER WORKSTREAMS ASSERT AGAINST `__diag.cast` (charter deliverable 3)

`__diag.cast` is the shared contract. Patterns:

**A. "Did the arms actually rise?" (S1 — link resolution).**
```js
window.__diag.cast.reset();
// … drive the cast …
const s = window.__diag.cast.summary();
assert(s.castLink.miss === 0);                       // no silent no-op on any cast gesture
// which gesture failed + why:
const misses = window.__diag.cast.linkStats({ castOnly: true });
// → { "0x80000049": { "0x10000132": { hit: 1, miss: 0, reasons: {} }, … } }
```

**B. "Did the full chain play in order and on time?" (per-cast timeline).**
```js
const tl = window.__diag.cast.lastTimeline(localGuid);
// tl.deltasMs = { armed, sent, windups:[{i,cmd,name,at}], cast, casterEffect, done, useDone, fizzle }
assert(tl.deltasMs.windups.length === expectedWindups);
assert(tl.deltasMs.cast != null);                    // cast gesture fired
assert(tl.deltasMs.cast <= totalDurationS*1000/2.0*1.6);  // CastSpeed 2.0 + slack
assert(tl.outcome === "complete");
```

**C. One-call PASS/DRIFT (probes).**
```js
const r = window.__diag.cast.assertLastCast(localGuid, {
  forbidSuppressed: true, minWindups: 1, expectCast: true,
  expectCasterEffect: true, expectOutcome: "complete", maxLinkMiss: 0,
});
// r = { pass, checks:[{name,pass,detail}], timeline }
```

**D. "Is movement leaking through the cast?" (S2/S3 — arbitration).**
```js
const m = window.__diag.cast.movementSnapshot();
// m = { latchAutonomous, forwardSlot: "none"|"walk"|"run"|"substate",
//       heldSubstate, castMoveEnabled, slideCastEnabled,
//       pendingMotions, reclaimCause:{edge,useTime} }
// During a gesture, forwardSlot should be "substate" (gesture holds the slot).
// reclaimCause.useTime ticking between windups = the S3 reclaim leak.
```

**E. "Was the recast swallowed?" (busy-window / suppression).**
```js
const s = window.__diag.cast.summary();
// s.suppress = { noSpell, tableNotLoaded, noSetSwing, busyWindow }
// s.requested vs s.chainsStarted → how many casts were requested vs actually ran.
```

**F. "Is the echo dedup working?" (double-play).**
```js
const e = window.__diag.cast.echoStats();  // { noted, consumedHit, consumedMiss }
// noted>0 & consumedHit>0 → predictions are being deduped against server echoes.
```

Live chain state (for a running cast): `window.__diag.cast.state(guid)` → `{ spellId, token, busyUntilMs, gestureIndex, gestureCount, phase }`. All getters are safe to call every frame (O(1) reads); `movementSnapshot()` is the only one that touches wasm and is still cheap (three atomic loads).

---

## VERDICT (WS16-verify)

**Verdict: PARTIAL — apply the JS half as-is; the ONE Rust code change (`castArbitrationDiag`) will NOT compile as written and MUST be corrected before the wasm rebuild.**

Adversarial re-verification on the GCE buildbox, 2026-07-12, against the live clean tree `@ 6fcff2f0` (confirmed baseline; tree clean except untracked docs). Every load-bearing cite was re-opened, key patch contexts diffed against live code, the unit test re-run, and the DAT/JSON claims re-grounded via the oracle.

### What VERIFIED CORRECT (the bulk of WS16 — CONFIRMED)

- **§1.1 diag-registration convention — all anchors accurate.** `installDiag` at `diag.js:57`; attach loop rows `["combat", _attachCombat]` (:481) / `["palettes", _attachPalettes]` (:482) with the §3.2 insert point between them; try/catch quote at `:487`; `attachMotion`/`diag.motion` (motion.js:114/515), `attachCombat`/`diag.combat` (combat.js:142/591); subscription pattern (`SUB_POLL_MAX_TICKS` :20, `_installSneakSubscription` :619, `events.on` :626); unconditional optional-chain hook shapes at `index.html:6934` (`__diag?.wire?.onEvent`) and `:8604` (`__diag?.combat?.onAimLevel`). §3.2 patch context matches live **exactly**.
- **§1.2 `playCastSequence` — all anchors accurate.** Function at `entities.js:6728`; token bump :6777-6778; busy-window gate :6766 / set :6772; windup loop `for (const gesture of (seq.windupGestures || []))` :6825; `if (seq.castGesture)` :6829-6831; `setSwingMotion(g, motionU32, {speed: CAST_SPEED})` :6811; casterEffect token-recheck :6884, emit :6885-6908; complete clears busy :6911; the four silent early-returns at :6733/:6744/:6754/:6766. §3.3(a-d) patch contexts match; the §3.3(a) NOTE **honestly flags** that the diff condenses the 4-line WS-B teardown comment blocks and tells the integrator to insert before the bare `return;` in each — correct.
- **§1.3 `setSwingMotion` link-gate — accurate.** `canPlayReal` at :7163-7167, play gate `if (!canPlayReal || typeof fetchKeyframes !== "function")` :7169, hit site `action.reset(); action.play()` :7251-7252, `currentActionKey` :7262, stance derivation :7143-7144. §3.3(f) context matches and the miss-reason derivation logic (`!stance → stance-falsy`, then source/kind/resolved-zero/no-fetch) is sound and orders the most-informative reason first.
- **§1.4 echo dedup — accurate, and the `dispatchParity` default resolved in the packet's favor.** `noteLocalSwingPrediction` :6620, `consumeLocalSwingEcho` :6633, `loop.js` consume site :2605-2606. **`DISPATCH_PARITY_ON` IS default-ON** — the definition at `loop.js:300` returns `get("dispatchParity") !== "off"` and url-flags.md lists it in the "Now default-ON" set. The inline comment at `loop.js:2600` ("default-off") is STALE; the packet correctly cited the authoritative definition, not the comment. Good tradecraft.
- **§1.6 wire events — accurate.** Fizzle `0x0402` at `index.html:7832`, cancel at :7838; UseDone/`clearCastBusy` :7854-7858; kind=61 `ForwardSlotEvicted` handler :8085, cancel :8122; all **three** `cancelCastSequence` sites (7838 / 8122 / 9186) match the §3.3(e) note **exactly**. `picking.js` `doCast` :673, `castTargetedSpell` :674, `playCastSequence` :694, `spellCastInitiated` emit :654. `cancelCastSequence` at :6927 with the §3.3(e) optional-`cause` arg being backward-compatible.
- **§1.7 DAT ground truth — oracle-CONFIRMED to the decimal.** Ran the WB.Terminal oracle on `SpellComponentTable 0x0E00000F`: Lead `0x80000000`/0, Iron `0x10000070`/1.0795455, Copper `0x10000072`/2.0192308, Silver `0x10000074`/2.875, Gold `0x10000076`/3.6764705, Pyreal `0x10000078`/4.4407897 — every row matches the packet table. `data/spell-cast-sequence.json` (`_spell_count: 6266`, container key `sequences`) confirms spell **2331** = windup `0x10000132` "MagicPowerUp08Purple" (3.6765s) + cast `0x40000035` "MagicTransfer", school 2 / Self / level 7. The packet author genuinely did the DAT work — **no fabrication**.
- **Tests — re-run and PASS.** Extracted `cast.js` + `test_cast_diag.mjs` verbatim from this packet to a temp dir and ran on the buildbox (node v20.20.2): **28 passed, 0 failed**, exactly as claimed. `cast.js` and `probe_cast_matrix.cjs` both pass `node --check`. The process **exits cleanly** (confirms R5 — the `typeof window === "undefined"` early-return prevents a dangling `setInterval`). String-hex motion coercion verified: `"0x10000132" >>> 0 === 0x10000132`, so the timeline windup stamps humanize correctly even though the JSON `motion` field is a hex string.
- **`movementSnapshot()` bit-decode is consistent with the documented Rust layout** (bit0 latch / bit1 castMove / bit2 slideCast / bits4-5 occupancy / bits16-31 low16 substate) — the JS side honors the *contract* independent of the Rust bug below.

### DEFECT — MUST-FIX (blocks the wasm rebuild)

**§1.5 / §3.5: the `castArbitrationDiag` getter will NOT compile as written.** The proposed body does:

```rust
self.command_interpreter.as_ref().and_then(|it| it.forward_command)   // it: &CommandInterpreter
```

but **`CommandInterpreter` has no `forward_command` field or accessor.** Verified against the live struct (`command_interpreter.rs:426`): its fields are `smartbox_present, player_present, substate_list, turn_list, sidestep_list, autonomy_level, controlled_by_server, hold_run, …, honor_autonomy_latch, …` — no `forward_command`. The only `forward_command` in that file are (a) doc-comments, (b) a *trait* method `player_forward_command(&self) -> Option<u32>` (different name **and** type), and (c) test-mock fields of type `Option<u32>`.

`forward_command: Option<InterpretedForwardCommand>` is a field on a **different type — `InterpretedState`** (`interp_state.rs:57`, `pub forward_command`). The packet's cite "read as `interp.forward_command` (system.rs:2244)" is a **misread**: at `system.rs:2244` the local `interp` is bound from the fn signature `interpreted_drive_state(interp: Option<&InterpretedState>, …)` (`system.rs:2233`) — it is an `&InterpretedState`, **not** the `self.command_interpreter` `CommandInterpreter`. The §3.5 integration hedge ("if it's private, add an accessor on `CommandInterpreter`") does not save this, because the state does not live on `CommandInterpreter` at all.

**Impact scope:** bits 0-2 (`last_move_was_autonomous` field :1505, `cast_move_enabled()` :1858, `slide_cast_enabled()` :1868 — all valid direct `self.` access) are correct and compile. **Only** the forward-slot-occupancy half (bits 4-5 + 16-31) is broken — which is unfortunately the *headline* WS16 signal (`movementSnapshot().forwardSlot === "substate"` = the SLIDECAST / S2 / S3 instrument). Because this getter is the **sole** reason for `needsWasmRebuild=true`, and §4.2 step-1 instructs the laptop to build it as-is, applying the packet verbatim **would fail the integration `wasm-pack` build.**

**Precise correction (all symbols re-verified reachable from `&MovementSystem`):** the interpreted forward command lives in the per-player registry minterp, reached exactly as the existing dispatch code does at `system.rs:2769-2772` / `:5691-5694` — so the getter needs a **guid parameter** (like its sibling `local_registry_pending_motions(local_guid)`):

```rust
pub(crate) fn cast_arbitration_diag(&self, local_guid: Guid) -> u32 {
    let mut out: u32 = 0;
    if self.last_move_was_autonomous { out |= 0x1; }
    if self.cast_move_enabled()      { out |= 0x2; }
    if self.slide_cast_enabled()     { out |= 0x4; }
    let fwd = self.movement_managers            // field: system.rs:1403
        .get(&local_guid)
        .and_then(|m| m.motion_interp_ref())    // movement_manager.rs:722 -> Option<&MotionInterp>
        .and_then(|mi| mi.interpreted_state.forward_command); // interp_state.rs:57 (pub); already read as &minterp.interpreted_state at system.rs:2772
    let (occ, sub) = match fwd {
        Some(InterpretedForwardCommand::WalkForward)   => (1u32, 0u32),
        Some(InterpretedForwardCommand::RunForward)    => (2u32, 0u32),
        Some(InterpretedForwardCommand::Substate(cmd)) => (3u32, cmd & 0xffff),
        None => (0u32, 0u32),
    };
    out |= (occ & 0x3) << 4;
    out |= (sub & 0xffff) << 16;
    out
}
```

- `handle.rs` delegator must also take `local_guid: Guid` and forward it.
- `lib.rs` stamp becomes `movement.cast_arbitration_diag(w.player.guid)` (mirrors the adjacent `MOVEMENT_PENDING_MOTIONS_DIAG.store(movement.local_registry_pending_motions(w.player.guid) …)` at `lib.rs:47401-47405`).
- The `#[wasm_bindgen(js_name = castArbitrationDiag)]` free-fn / static / JS decode are all fine as-is (the atomic just carries the packed u32). No manifest bump — the additive-rider claim holds.
- Behavioral note (not a bug): `motion_interp_ref()` is `None` until the minterp is lazily created, so `forwardSlot` reads `"none"` until the player first moves/casts — acceptable for a diagnostic.

### MINOR / NON-BLOCKING notes for the integrator

1. **Path convention:** §3.0/§3.5 mix HOLT-relative (`src/lib.rs` = `apps/holtburger-web/src/lib.rs`) with **repo-root-relative** (`crates/holtburger-core/src/client/movement/{handle,system}.rs` — these are NOT under `apps/holtburger-web/`; `crates/` does not exist there). Both resolve to real files; just don't look for `crates/` under HOLT.
2. **Stale inline comments the packet correctly stepped around** (recorded so nobody "fixes" WS16 based on them): `loop.js:2600` says `dispatchParity` "default-off" and `index.html:7830` says `castFizzle` "default-off" — **both stale**; the live logic (`!== "off"`) and url-flags.md make both default-ON. Packet cited the authoritative sources. No action for WS16.
3. **§3.3(f) `onLinkResolve` placement** fires before the (default-off) `UNIFIED_MISSILE` cycle diversion, so a miss later rescued by the unified-cycle path still counts as `miss`. Only reachable under `?unifiedMotion` for missile *cycles*, never for cast gestures — a non-issue for the S1(a) signal.
4. **§3.3(i) `onFizzle`** sits inside the `castFizzle !== "off"` gate, so `?castFizzle=off` won't increment `summary().fizzles`. Cosmetic; bare-default (the acceptance bar) works.

### Regression / scope check
No cast **behavior** is changed by the JS half — every hook is an unconditional optional-chained `window.__diag?.cast?.onX?.()` wrapped in `try/catch`, byte-identical to the existing `__diag?.wire?.onEvent?.()` pattern; the flag-off arm is byte-identical by construction. The `cancelCastSequence(guid, cause)` 2nd arg is backward-compatible. No `castMove`/`slideCast`/`cmdInterp` logic is touched. No ACE-reference edits. No other workstream's validated behavior is at risk. The only cross-cutting concern is the shared wasm rebuild, which every diag-rider WS coordinates.

### Bottom line
The JS diagnostics surface, the probe, the unit test, and every data/wire claim are **CONFIRMED and shippable as-is** — this is a high-quality, honestly-hedged packet. The single Rust getter is the lone defect, from a genuine misread of `system.rs:2244`; it is fully fixable with the correction above (all symbols verified) and MUST be corrected before the integration `wasm-pack` build, or the getter dropped (the JS surface degrades to `null` gracefully). `apply:true` is contingent on that mustFix.

---

```json
{"workstream":"WS16","title":"Cast diagnostics surface + headless regression harness","packetPath":"/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/docs/spellcasting-packets-2026-07-12/WS16-diag-harness.md","confidence":"high","keyFindings":["No cast diag surface exists today (foundation §1.6); WS16 adds window.__diag.cast — default-ON, read-cheap, observation-only, matching the 17 existing surfaces","Every cast failure mode is a silent no-op: setSwingMotion returns on any link miss / stance-falsy (entities.js:7163-7169) and playCastSequence has 4 silent early-returns (6733-6768) — WS16 counts all of them","DAT oracle proves player MT 0x09000001 carries link entries for BOTH the war band (0x1000006F..78) AND the colored/void band (0x10000128..0x134, incl 0x10000132 used by void spell 2331) — so void 'arms not rising' is a runtime-resolution question, not a missing-table-entry one; linkStats({castOnly}) isolates it","Movement-arbitration is exposable via a new castArbitrationDiag() wasm getter (latch last_move_was_autonomous system.rs:1505 + interpreter forward-slot interp_state.rs:31-39) riding v6 additively next to movementPendingMotionsDiag — the JS surface degrades to null without it","ACE ref grounds the probe tolerances: CastSpeed=2.0 (Player_Magic.cs:603), one EMPTY-axes Magic motion per gesture (WorldObject_Networking.cs:1078), CasterEffect via Formula.Scale (WorldObject_Magic.cs:356-367), fizzle-circle is PK-only (Player_Magic.cs:870-885)","Node unit test test_cast_diag.mjs PASSES 28/28 on the buildbox; cast.js and probe_cast_matrix.cjs both pass node --check"],"filesToChange":["scene3d/diag/cast.js (NEW)","scene3d/diag.js","scene3d/entities.js","index.html","scene3d/loop.js","src/lib.rs","crates/holtburger-core/src/client/movement/handle.rs","crates/holtburger-core/src/client/movement/system.rs","probe_cast_matrix.cjs (NEW)","test_cast_diag.mjs (NEW)","docs/url-flags.md (optional 1-line note, no flag row)"],"needsWasmRebuild":true,"newFlags":[],"risks":["castArbitrationDiag needs the single integration wasm rebuild (rides v6, no manifest bump) — JS half ships independently and reads null until then","entities.js/index.html are high-traffic co-edited files; WS16 hooks are additive inserts at stable symbol anchors, merge by symbol not line number","optional cancelCastSequence(guid,cause) 2nd arg — backward-compatible, coordinate cause tags at the 3 call sites","link-counter refinement (cache-throw/null-clip branches) could double-count vs the play-gate emit — single-emit wiring recommended in §3.3(f)","gesture-id→name humanization coordinates with WS01's canonical naming via data/motion-command-names.json"]}
```

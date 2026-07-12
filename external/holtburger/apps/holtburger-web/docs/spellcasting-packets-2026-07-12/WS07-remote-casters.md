# WS07 — Remote caster rendering (S1d)

**Investigator:** WS07 deep-dive, buildbox, 2026-07-12.
**Charter:** Remote mages must visibly wind up and cast. Remove the retired `setCastPose`
dead branch; derive from ACE exactly what a remote observer receives for a multi-windup
cast; audit our pipeline against it (stamp dedup, 0x40 final-gesture path, stance at
mid-cast spawn, castAxes strafe overlay); fix provable gaps; write a laptop capture recipe
for the rest.

**Baseline:** `external/holtburger` @ `6fcff2f0` (clean tree). All cites opened live this
session. DAT ground truth via the WB.Terminal oracle on `client_portal.dat`.

**Bottom line:** The remote-cast render pipeline is **structurally sound and mostly works**.
The `setCastPose` branch is genuinely dead (unreachable no-op) and its removal is a
byte-identical cleanup — but the early `return` next to it is **load-bearing** and must
stay. The final `0x40` gesture and the windups render through two *different* routes that
both terminate at `setMotion`'s cast branch; the DAT confirms every gesture's link exists.
The one genuinely open question — **can the 15-bit stamp dedup drop windup 2/3 of a
non-PK cast?** — hinges on a single line of ACE.Entity `Motion.cs` that is **absent from
this partial ACE checkout**, so it is escalated to a decisive two-bot laptop capture. A
**proven** gap exists for **PK/FastTick** casters (batched windups collapse to the newest
+ play same-tick without sequencing), but that path is PK-only and entangled with the
dormant `mtQueue` completion clock.

Confidence: **high** on the pipeline trace, dead-code removal, and DAT; **medium** on the
non-PK windup-drop question (needs capture); **high** that no *default-behavior* change is
required for the live non-PK box beyond the cleanup.

---

## 0. The pipeline in one picture (verified this session)

```
ACE server (per gesture)                          holtburger-web
─────────────────────────                         ──────────────────────────────────────
NON-PK caster (FastTick=false):
 DoWindupGestures → per windup:                   protocol unpack (InterpretedMotionState)
   EnqueueMotionMagic(windup)  ── UpdateMotion ─►    current_style=0x49(Magic)
   new Motion(Magic, MagicPowerUpNN)                 forward_command / commands[]
   (SEPARATE broadcast, spaced by animLength)  ─►  from_movement_event (entity.rs:151)
 DoCastGesture:                                       action_command (Action-class 0x10)  ─► KIND_MOTION_ACTION (kind=8)
   EnqueueMotionMagic(CastGesture)                    forward_command (SubState 0x40)      ─► KIND_MOTION       (kind=5)
   new Motion(Magic, MagicBlast 0x4000002B)      ─► lib.rs surfacing:
                                                       action  : 15-bit stamp dedup (:41231) → _armMotionAction (loop.js:2585)
PK/FastTick caster (FastTick=true):                    final   : locomotion slot, NOT filtered (:40930) → _armMotion (loop.js:2528)
 DoWindupGestures →                               ─► both → em.setMotion(cmd, stance) (entities.js:7615)
   EnqueueMotionAction(ALL windups)                    classifyMotionCommand → "cast" (:2141)
   (ONE broadcast, commands[] list)                    → _tryPlayLink(Ready→cmd, stance) (:9569)
 DoCastGesture: EnqueueMotion(CastGesture)        ─► animationCache.get → links[(Magic,Ready)][fullCmd] → LoopOnce overlay
```

The dead `setCastPose` branch in `dispatchRemoteSwing` (a `damageTaken`/`evadedAttacker`
reaction, **not** on this path) plays no part and can be removed.

---

## 1. VERIFIED FINDINGS

Each finding is tagged **[FACT]** (proven from code/DAT this session) or **[HYP]**
(hypothesis needing the laptop capture).

### F1 [FACT] `setCastPose` is a fully retired no-op; the `dispatchRemoteSwing` magic branch is dead code.
- `entities.js:6666-6669`:
  > `// setCastPose (the both-arms-up vibe-pose one-shot) RETIRED 2026-06-18`
  > `// (WS-B teardown). Superseded by playCastSequence's real ACE-derived`
  > `// gesture chain + the Rust motion authority; its fallback callers now no-op.`
- `rg setCastPose scene3d/entities.js` returns **only comments** — there is **no method
  definition**. So `em.setCastPose` is `undefined`.
- `index.html:8654-8659`:
  ```js
  if (MAGIC_STANCES.has(stance)) {
    if (typeof em.setCastPose === "function") {   // undefined → false → NEVER runs
      em.setCastPose(g);
    }
    return;
  }
  ```
  `typeof undefined === "function"` is `false`, so the call at :8656 is **unreachable**.
  The branch is dead. **Removing the call is byte-identical.**

### F2 [FACT] The early `return` in that branch is LOAD-BEARING — it prevents a melee misfire on casters.
- `dispatchRemoteSwing` (`index.html:8549-8712`) is invoked only from the combat-reaction
  handler (`index.html:8714-8719`) on `eventName === "damageTaken"` / `"evadedAttacker"`.
- After the magic guard, the function falls through to a **melee** dispatch:
  `index.html:8687-8707` `else { … resolvedMotion = getCombatManeuver(stance, …); }` then
  `:8708 em.setSwingMotion(g, resolvedMotion)`.
- Stance is stored as the **low-16** value everywhere (see F7): `getStance` returns `0x49`
  for a mage, and `MAGIC_STANCES = new Set([0x0049])` (`index.html:2855-2857`). So
  `MAGIC_STANCES.has(0x49)` is **true** and the `return` fires. **If the whole `if` block
  were deleted, a Magic-stance attacker would fall into `getCombatManeuver` and dispatch a
  melee maneuver on a caster.** (In practice usually masked by the `swingFresh` early-return
  at :8599-8613, but not guaranteed — the correct fix keeps the guard.)

### F3 [FACT] The final cast gesture (`0x40` substate) renders via the KIND_MOTION locomotion path, NOT KIND_MOTION_ACTION.
- The action predicate `is_action_motion_command` **excludes** the magic gesture substates:
  `crates/holtburger-world/src/player/types.rs:384`:
  ```rust
  0x4000_0000 => matches!(full & 0x0000_FFFF, 0x0016..=0x001D | 0x00D3 | 0x00E0 | 0x00E1),
  ```
  MagicBlast `0x4000002B`, MagicSelf* `0x2C–0x32`, MagicTransfer `0x35`, MagicPray `0x39`
  (all low-16 in `0x1E..0x39`) return **false** — confirmed by the sibling test
  `aim_states_and_magic_substates_blocked` (types.rs:421-426 asserts `0x4000002B` blocks jump,
  i.e. is a substate not an action).
- Therefore in the lib.rs locomotion emit, the final gesture is **NOT filtered out** of the
  forward slot (`lib.rs:40930-40933` filter drops only `is_action_motion_command`), so
  `motion_command_u16 = forward_command.raw()` = `0x002B`.
- The KIND_MOTION `EntityUpdate` is pushed **unconditionally** (`lib.rs:41099-41131`,
  `motion_command: u32::from(motion_command_u16)`), so `0x2B` reaches JS.
- `loop.js:_armMotion:2528-2557` (remote guid → not skipped) → `em.setMotion(guid, 0x2B,
  0x49, speed)`.
- `classifyMotionCommand(0x2B)` → `"cast"` (`CAST_COMMANDS` includes `0x002B`,
  `entities.js:1433`) → cast branch (`entities.js:7819`) →
  `expandActionCommandLow16(0x2B)` = `0x4000002B` (`entities.js:2233-2235`, `0x16..0x39` →
  `0x40` class) → `_tryPlayLink(inst, …, READY_SUBSTATE=0x0003, 0x4000002B, 0x49)`
  (`entities.js:7848-7849`). **Charter question answered: YES, the final `0x40` gesture
  renders via KIND_MOTION → classifyMotionCommand cast branch.**

### F4 [FACT] The windups (`0x10` Action-class) render via KIND_MOTION_ACTION → setMotion cast branch.
- `MagicPowerUp01..10` = `0x1000006F..0x78` and colored `0x1000012B..0x134` carry the
  Action bit (`CommandMask.Action = 0x10000000`, `melt/.../CommandMasks.cs:11`); they expand
  to class `0x10` (`types.rs:140,157`) and `is_action_motion_command` returns **true**
  (`types.rs:370`).
- `from_movement_event` surfaces the newest Action-class command as `snapshot.action_command`
  (entity.rs:178-182 via `newest_action_command`, OR entity.rs:184-216 from `forward_command`
  when it is itself Action-class), then lib.rs emits `KIND_MOTION_ACTION` (kind=8,
  `lib.rs:41258-41296`) with 15-bit stamp dedup (`lib.rs:41231-41250`,
  `is_newer_u16(seq, prev)`).
- `loop.js:_armMotionAction:2585-2626` fires for **every guid including local**, routing
  `em.setMotion(actionGuid, actionCmd, actionStance, speed)` → same cast branch as F3 →
  `_tryPlayLink`.

### F5 [FACT] The player MotionTable has links for EVERY magic gesture under (Magic, Ready) — DAT-proven.
- Oracle: `chorizite-parse-dat-record … 0x09000001 MotionTable`. The `links` outer key format
  is `(stanceLow16 << 16) | substateLow16`; **Magic+Ready = `0x490003` = 4784131** is present.
- `links["4784131"].motionData` (54 inner links) contains, verified by decode:
  - **All green windups** `0x1000006F..0x10000078` (class 0x10).
  - **Purple windups** `0x1000012B`, `0x10000132`, `0x10000134` … (class 0x10).
  - **All final gestures** `0x4000002B` (MagicBlast) … `0x40000039` (MagicPray) (class 0x40),
    incl. MagicTransfer `0x40000035`, MagicRecoilMissile `0x40000033`.
- So the render can resolve a clip for *every* magic gesture **iff** it is handed
  `(stance=0x49, from=Ready 0x03, fullCmd)`. **Independently corroborated by WS01** (high
  confidence): "all 20 gestures the cast-sequence JSON emits … are linked from-Ready in
  player MT 0x09000001 Magic stance". **Corollary (WS01, DAT-proven):** NonCombat from-Ready
  carries **zero** magic gestures — a wrong stance = hard silent miss.

### F6 [FACT] The exact ACE wire behavior for a remote observer — two divergent paths gated on `FastTick => IsPKType`.
- `FastTick` is defined `Player_Tick.cs:154`: `public bool FastTick => IsPKType;`. So the
  wire shape **differs by PK status** (corroborated by WS06 + WS08).
- **NON-PK caster (FastTick=false — the vanilla / this-box default):**
  `Player_Magic.cs:635-636` windups use `EnqueueMotionMagic(castChain, windupGesture,
  CastSpeed)` **once per windup**; `:685` the final gesture uses `EnqueueMotionMagic`.
  `WorldObject_Networking.cs:1078-1093`:
  ```csharp
  var motion = new Motion(MotionStance.Magic, motionCommand, speed);
  …
  if (this is Player player && player.MagicState.IsCasting)
      EnqueueBroadcastMotion(motion);          // one UpdateMotion per gesture
  actionChain.AddDelaySeconds(animLength);      // spaced by the gesture length
  ```
  ⇒ **3 windups = 3 separate `UpdateMotion` broadcasts**, each with `current_style=Magic`,
  spaced in time, then a 4th for the final gesture. Corroborated verbatim by the `slideCast`
  url-flags row: *"NPK: one stomp per windup, `EnqueueMotionMagic` WorldObject_Networking.cs:1078"*.
- **PK caster (FastTick=true):** `Player_Magic.cs:645` windups use
  `EnqueueMotionAction(castChain, spell.Formula.WindupGestures, …)`
  (`WorldObject_Networking.cs:1231-1273`): builds **one** `Motion` with `MotionCommand.Ready`
  forward + `motion.MotionState.AddCommand(this, windup, …)` for **each** windup → **one
  broadcast whose `commands[]` list holds ALL windups**; `:683` the final gesture uses
  `EnqueueMotion(…, half:true)`. Corroborated by the `slideCast` row: *"PK/FastTick:
  windup-start stomp `EnqueueMotionAction` :1231 + the cast-gesture stomp + FinishCast"*.
- **Placement (proven from `RawMotionState.ApplyMotion`, ACE `RawMotionState.cs:66-95`):**
  `CommandMask.Action (0x10)` → `AddAction` (the `commands[]`/Actions list, stamped);
  `CommandMask.SubState (0x40)` → `ForwardCommand`. So windups belong in the Actions list and
  the final gesture in `forward_command` — **matching our two surfacing routes (F3/F4).**
- **Client-side dedup our port mirrors (decomp `move_to_interpreted_state`,
  acclient.c:344396-344418):** walks the actions list; an action plays **only if its 15-bit
  stamp is newer** than the object's `server_action_stamp` (half-window `0x3FFF`). Same math
  as our `is_newer_u16` (`crates/holtburger-common/src/sequence.rs`). **An action whose stamp
  is not newer is DROPPED.**

### F7 [FACT] Stance is stored as low-16 `0x49` end-to-end; it is reliably present on every cast broadcast + on mid-cast spawn.
- Wire `current_style` is the packed low-16: `MotionStance::interpreted()` = `self & 0xFFFF`
  (`protocol/.../types.rs:102-104`), and `MotionStance::Magic = 0x8000_0049` (types.rs:88) →
  `0x0049` on the wire (`motion.rs:71` reads a u16).
- lib.rs carries it verbatim: KIND_MOTION `motion_stance: u32::from(data.current_style)`
  (`lib.rs:41131`); KIND_MOTION_ACTION `motion_stance: u32::from(data.current_style)`
  (`lib.rs:41288`). JS `setMotion` stores `inst.currentStance = stance` (entities.js:7701);
  `getStance` returns it (entities.js:6375).
- **Every** cast `UpdateMotion` uses `new Motion(MotionStance.Magic, …)` (F6), so
  `current_style=0x49` is present on **every** windup and final-gesture broadcast — the
  first gesture a mid-cast-spawn observer receives already stamps the Magic stance onto
  `currentStance`, so `_tryPlayLink` gets `0x49`. Mid-cast **spawn** additionally carries the
  object's `CurrentMotionState` as MovementData in ObjectCreate
  (`WorldObject_Networking.cs:309-320` `new MovementData(this, CurrentMotionState)`), parsed
  by `from_object_description` (entity.rs:275-323), so the stance is available before the
  first windup too. **Charter question answered: YES, stance is available at mid-cast spawn
  (verified low-risk; capture item C-3 confirms).**

### F8 [FACT] The `castAxes` remote strafe/turn overlay for slidecasting remotes exists and is default-ON.
- `lib.rs:41355-41384` surfaces the remote `sidestep_command` / `turn_command` axes the
  forward slot drops, into the `MOTION_AXES` side-channel (`pollMotionAxes`).
- `loop.js:drainMotionAxes:410-441` (default-ON, see F9) drains it: sidestep →
  `em.setSidestepLayer(guid, sideCmd, stance)` (strafe-cast footwork overlay); turn-in-place
  → `em.setMotion(guid, turnCmd, stance)` when idle. Remote guid only (`:424` skips local).
- **Charter question answered: YES, the castAxes strafe overlay works for slidecasting
  remotes** (a held-strafe remote caster shows footwork). Default-ON.

### F9 [FACT] Multiple cast-render flags whose loop.js comments say "default OFF" are actually default-ON — doc drift, not code bug.
- `CAST_AXES_ON` (`loop.js:399-408`) and `MULTI_ACTION_ON` (`loop.js:246-255`) use the
  `get(flag)?.toLowerCase() !== "off"` idiom = **default-ON**, but their doc comments
  (`loop.js:392,397` and `:239,242`) say "default OFF". The authoritative `docs/url-flags.md`
  line 12 lists **both** under "**Now default-ON**", and the table rows confirm current
  `on`: `multiAction` (:268), `castAxes` (:283). `dispatchParity`, `serverSwing`, `mtQueue`,
  `remoteInterp` are likewise default-ON (`url-flags.md:12,14,551,559,541`).
- **Independently corroborated by WS01** ("castSpeed, castStateMachine, dispatchParity all
  say 'Default OFF' in comments but are default-ON"). This is a shared, campaign-wide
  doc-drift finding.

### F10 [FACT] Remote-caster TURN is already correct (server KIND_TURN), consistent with WS06.
- WS06 (high confidence): "Remote casters already re-face correctly off the server KIND_TURN
  (meleeFaceTarget excludes casts by design, entities.js:7832) — they do NOT cast at empty
  air". The observer receives the caster's own `TurnToObject` (ACE re-rotates before the
  final gesture, `Player_Magic.cs` Rotate/TurnTo) as KIND_TURN (`lib.rs:41161`) →
  `loop.js:_armTurn:2629-2638` (remote-only) → `em.applyTurnDirective`. **WS07 confirms: no
  `_armTurn` change needed; remote turn is not a WS07 gap.** (WS06 explicitly rejected
  Approach B / no `_armTurn` edit — we agree.)

### F11 [HYP — needs capture] Can the stamp dedup drop windup 2/3 of a NON-PK cast?
- For NON-PK, the 3 windups arrive as **3 separate broadcasts** (F6). Our surfacing depends
  on which wire slot the ACE.Entity `Motion(stance, cmd)` **constructor** places an
  Action-class windup into — and **that file (`ACE.Entity`/`ACE.Server.Entity` `Motion.cs`,
  `MotionState.cs`, `MovementData.cs`) is ABSENT from this partial ACE checkout** (only the
  Physics `RawMotionState`/`MotionState` and the enums are present; `MovementData` is
  referenced at `WorldObject_Networking.cs:309,320` and `Motion.cs:162-166` is cited in the
  `slideCast` url-flags row, but the type is not in-tree). Two outcomes:
  - **(a) windup lands in `forward_command`** (Action-class value in the forward slot).
    `from_movement_event` surfaces it via the forward branch (entity.rs:184-216) with
    `action_sequence = data.movement_sequence` — the per-broadcast u16 ACE **increments each
    `UpdateMotion`** (the code comment at entity.rs:204-208 states exactly this). ⇒ windup1
    (seq N) < windup2 (N+1) < windup3 (N+2), all `is_newer` ⇒ **all 3 play. SAFE.**
  - **(b) windup lands in the single-item `commands[]` list.** `newest_action_command`
    surfaces it with `action_sequence = item.sequence()` — the `MotionItem` 15-bit stamp. If
    ACE assigns a **fresh-Motion-reset** stamp (e.g. `0` for each new `Motion` object), then
    windup2/windup3 carry the SAME stamp as windup1 ⇒ `is_newer(0,0)=false` ⇒ **windups 2 & 3
    DROPPED** ⇒ arms rise once instead of three times = the S1 "arms not always rising"
    symptom for remote casters.
- The lib.rs dedup (`MOTION_ACTION_STAMPS`, lib.rs:41231-41250) and the JS dedup
  (`drainMotionActions` `_actionStamps`, loop.js:385-387) are **robust to (a)**; the risk is
  **only (b) with a non-incrementing per-Motion stamp**. This is the single decisive open
  question and is escalated to capture **C-1**.

### F12 [FACT — PK-gated, sequencing gap] PK/FastTick multi-windup collapses to one visible gesture.
- PK windups arrive **batched in one broadcast's `commands[]`** (F6). Our surfacing:
  - `newest_action_command` (entity.rs:117-149) returns **only the highest-stamp item** →
    the **last** windup goes out as KIND_MOTION_ACTION; windups 1..n-1 are dropped from the
    main path.
  - The remainder queue to the `MOTION_ACTIONS` side-channel (lib.rs:41330-41353), drained by
    `drainMotionActions` (loop.js:367-390, default-ON per F9) — **but each is played with
    `em.setMotion` in the SAME tick** (loop.js:388), so they **stomp each other as overlays
    (last wins)**; there is no completion-gated sequencing. Net: a PK 3-windup cast shows
    ~one gesture.
- Correct sequencing needs the retail per-object motion queue completion clock — the
  **dormant `?mtQueue` / `motion_table_manager.rs` completion-clock shim** (foundation §1.4,
  url-flags `mtQueue` :559/:784, `USE_MOTION_TABLE_QUEUE` :433). That is cross-workstream
  and out of a minimal WS07 scope. **PK-only** (our live vanilla box defaults non-PK), so it
  is NOT the primary live symptom, but it matters for PvP casting feel (foundation §4b: "PvP
  casting feel is THE credibility bar"). Documented, deferred with an eye-test (E-2).

---

## 2. ROOT CAUSES (per charter symptom)

**Charter Q: "does the dispatchRemoteSwing magic branch call the retired setCastPose no-op?"**
→ **YES, confirmed dead (F1).** Mechanism: `em.setCastPose` is undefined post-2026-06-18
teardown; the `typeof … === "function"` guard makes the call unreachable. **Root cause of the
dead code: leftover from the Wave-13/42 vibe-pose era, superseded by the UpdateMotion path.**
Remove the call; keep the `return` (F2).

**Charter Q: "does the stamp dedup drop windup 2 of 3?"**
→ **Non-PK: NOT proven to drop; robust if the stamp increments (F11).** The only drop path is
ACE assigning a non-incrementing per-`Motion` stamp to windups placed in `commands[]` — which
cannot be confirmed from the in-tree source and needs capture C-1. **PK/FastTick: YES, proven
collapse to one gesture (F12)** — mechanism is `newest_action_command` + same-tick
`drainMotionActions` overlay stomping, absent the `mtQueue` sequencer.

**Charter Q: "does the final 0x40 gesture render via KIND_MOTION locomotion + classifyMotionCommand cast branch?"**
→ **YES, fully traced + DAT-confirmed (F3, F5).** `is_action_motion_command` deliberately
excludes `0x1E..0x39`, so the substate stays in the forward slot → KIND_MOTION →
`_armMotion` → `setMotion` cast branch → `_tryPlayLink(Magic, Ready, 0x4000002B)` → the DAT
link exists. No gap.

**Charter Q: "is stance available when a mage already mid-cast streams in?"**
→ **YES, verified low-risk (F7).** `current_style=0x49` rides every cast broadcast and the
ObjectCreate MovementData at spawn. Capture C-3 confirms empirically.

**Charter Q: "does the castAxes strafe overlay work for slidecasting remotes?"**
→ **YES, default-ON (F8).** `drainMotionAxes` → `setSidestepLayer` for remote sidestep.

---

## 3. PATCH PLAN

Convention (foundation §4.3): dead-code / doc-comment fixes with byte-identical arm behavior
ship **without a flag**. No default-behavior change is proposed for the live non-PK box. All
diffs are unified hunks against the live `6fcff2f0` tree; apply on the laptop.

### PATCH 1 — Remove the dead `setCastPose` call; keep the load-bearing guard. (index.html)

Behavior-identical (the call was unreachable, F1). Keeps the `return` (F2). No flag.

```diff
--- a/apps/holtburger-web/index.html
+++ b/apps/holtburger-web/index.html
@@ -8651,12 +8651,17 @@
-                      // the right placeholder until the wire-side spell
-                      // identification lands.
-                      if (MAGIC_STANCES.has(stance)) {
-                        if (typeof em.setCastPose === "function") {
-                          em.setCastPose(g);
-                        }
-                        return;
-                      }
+                      // WS07 (2026-07-12): remote cast gestures render entirely
+                      // via the UpdateMotion action path — windups arrive as
+                      // KIND_MOTION_ACTION and the final 0x40 gesture as
+                      // KIND_MOTION, both routing through setMotion's cast
+                      // branch → _tryPlayLink. dispatchRemoteSwing (a
+                      // damageTaken/evadedAttacker melee-reaction) has NO role
+                      // for magic. setCastPose was retired to a no-op
+                      // 2026-06-18 (entities.js:6666), so the old guarded call
+                      // was already dead; removed. The early return STAYS and is
+                      // LOAD-BEARING: without it a Magic-stance attacker falls
+                      // into the melee getCombatManeuver branch below and would
+                      // dispatch a sword-swing maneuver on a caster.
+                      if (MAGIC_STANCES.has(stance)) {
+                        return;
+                      }
```

> Optional companion cleanup (same file, non-functional): the comment block at
> `index.html:8624-8653` still narrates the `setCastPose` "arms-up vibe pose" as the magic
> behavior. It is now stale; trim/rewrite to describe the UpdateMotion-action path. Left out
> of the core hunk to keep the diff minimal — flag it for the integration owner.

### PATCH 2 — Fix stale "default OFF" comments on default-ON cast-render flags. (loop.js) — doc-only

No behavior change (comments only). Aligns the source with `docs/url-flags.md`. Coordinate
with WS01 (same doc-drift finding) so we touch these comment blocks once.

```diff
--- a/apps/holtburger-web/scene3d/loop.js
+++ b/apps/holtburger-web/scene3d/loop.js
@@ -239,4 +239,4 @@
-// Multi-action motion queue (2026-06-06, approach B) — `?multiAction=on` (default
-// OFF) FIFO-plays the Action-class `commands` list (emotes / gestures) that the
+// Multi-action motion queue (2026-06-06, approach B) — `?multiAction` (DEFAULT-ON
+// per docs/url-flags.md; `=off` to disable) FIFO-plays the Action-class `commands`
+// list (emotes / gestures) that the
 // single motion_command path drops, drained from the wasm `pollMotionActions`
@@ -392,4 +392,4 @@
-// Casting-ingredient axes (2026-06-06) — `?castAxes=on` (default OFF) surfaces
+// Casting-ingredient axes (2026-06-06) — `?castAxes` (DEFAULT-ON per
+// docs/url-flags.md; `=off` to disable) surfaces
 // the remote sidestep + turn axes the single forward_command path drops, so a
```
(and delete the now-wrong "Default OFF: needs a 1070 eye-test" sentences at `:242-243` and
`:397-398`.)

### PATCH 3 — (OPTIONAL, diag-only, supports the capture) add a remote-cast diag counter. (entities.js / loop.js)

There is "NO dedicated cast diag surface today" (foundation §1.6). A tiny counter makes the
C-1 capture directly observable (windup KIND_MOTION_ACTION count vs final-gesture count per
guid). HUD/diag-only → no flag (foundation §4.3). Sketch (wire into the existing `__diag`):

```js
// in _armMotionAction, after em.setMotion for a magic-stance action:
try {
  const low = actionCmd & 0xffff;
  if ((low >= 0x6f && low <= 0x78) || (low >= 0x12b && low <= 0x134)) {
    window.__diag?.cast?.onRemoteWindup?.({ guid: actionGuid, cmd: actionCmd, seq: /*stamp*/ });
  }
} catch (_) {}
// in _armMotion cast branch (or setMotion) for a magic final gesture (0x2b..0x39):
```
This is a *scaffold*; the real `__diag.cast` schema is WS16's domain (coordinate — see
Risks). Do not land ahead of WS16 without agreeing the schema.

### PATCH 4 — (CONTINGENT on capture C-1 = outcome (b)) defensive windup-stamp fallback. DO NOT LAND until proven.

If C-1 shows non-PK windups arrive in `commands[]` with a **non-incrementing** stamp
(F11-b), add a flag-gated fallback in `from_movement_event`: when the newest Action-class
command is a **magic windup** (low-16 `0x6F..0x78` or `0x12B..0x134`) whose `item.sequence()`
is **not newer** than the last, fall back to the per-broadcast `movement_sequence` as the
dedup stamp (mirroring the forward-command branch already at entity.rs:211). Ship default-OFF
under a new flag (`castWindupSeq`) with a url-flags row + the C-1 capture as the validation
recipe. **Needs a wasm rebuild.** Deferred — do not implement speculatively (charter: fix
only what's proven; and a speculative dedup change risks double-play on the safe path (a)).

---

## 4. TESTS

### 4.1 Rust unit tests (cheap: `capped-build cargo test -p holtburger-world`)

Add to `crates/holtburger-world/src/entity.rs` `#[cfg(test)]` (siblings of the existing
`invalid_movement_surfaces_newest_action_command_expanded` :435 and
`forward_command_eat_surfaces_as_action_runforward_stays_locomotion` :599):

- `magic_windup_in_forward_command_surfaces_as_action_with_movement_seq` — build a
  `MovementEventData` (Invalid) with `forward_command = MagicPowerUp01 (0x6F)`,
  `current_style = Magic`, `movement_sequence = N`; assert `from_movement_event` yields
  `action_command == 0x1000006F`, `action_sequence == Some(N)` (the F11-a safe path).
- `magic_final_gesture_stays_out_of_action_slot` — `forward_command = MagicBlast (0x2B)`;
  assert `snapshot.action_command == None` and `snapshot.forward_command == Some(0x2B)` (F3
  — the final gesture must flow via KIND_MOTION, not the action path).
- `magic_windups_batched_in_commands_collapse_to_newest` — three `MotionItem`s
  (0x6F/seq5, 0x70/seq6, 0x71/seq7) in one `commands[]`; assert `newest_action_command`
  returns `(0x10000071, 7, _)` — **documents the F12 PK collapse** so a future sequencing fix
  has a pinned baseline.

### 4.2 Rust dedup pin (cheap: `capped-build cargo test -p holtburger-common`)

`crates/holtburger-common/src/sequence.rs` already pins `is_newer_u16` wrap behavior. Add
`three_increasing_stamps_all_pass_then_a_repeat_is_dropped` asserting
`is_newer(N+1,N) && is_newer(N+2,N+1) && !is_newer(N+2,N+2)` — the exact windup-dedup
invariant (documents that outcome (b)'s repeated-stamp windup is dropped).

### 4.3 JS DAT-level test (`node test_ws07_remote_cast_links.mjs`)

Mirror the existing `test_ac_cast_over_locomotion.mjs` pattern (shell to a
`holtburger-dat` example, or parse the oracle JSON) and assert the runtime **links** path
(not `modifiers`): `links[(Magic 0x49, Ready 0x03)].motionData` contains every
`0x1000006F..0x78`, the purple band `0x1000012B..0x134`, and every final gesture
`0x4000002B..0x40000039` — the F5 result, pinned so a DAT swap can't silently break remote
casting. (This complements WS01's local-windup coverage test; scope it to the remote-path
commands to avoid duplication — coordinate with WS01 on a shared fixture.)

### 4.4 TODO-FOR-LAPTOP — decisive two-bot live capture (resolves F11 / F12 / F7)

**Environment:** laptop with live vanilla ACE (udp 9000/9001), two accounts. NO live ACE is
reachable from the buildbox, so this MUST run on the laptop.

**Setup**
1. Serve: `python3 external/holtburger/scripts/serve.py` → `:8765`.
2. **Bot O (observer)** — headless, renders wire:
   `http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&renderOnDemand=1&netDrainHz=30&autoLogin=1&account=Tester2&password=Tester2&autoSpawn=first&kickDance=1&agent=1`
3. **Bot C (caster)** — a magic-trained char, spawned within O's PVS (same landblock, ≤20m).
   Use the known 3-windup self chain **Wedding Bliss 1708** (used for the slideCast live
   validation) or a low-mana war bolt chain. Poll `window.__bootState==='in-world'` on both.

**Instrument Bot O's console BEFORE the cast (tap the wasm action stream):**
```js
// Capture every KIND_MOTION_ACTION + KIND_MOTION for the caster guid.
window.__ws07 = { rows: [], casterGuid: 0 };
const casterName = "Tester1";                       // Bot C's char
window.__ws07.casterGuid = liveScene3d.entityManager.findGuidByName(casterName) >>> 0;
// Hook the two arms non-invasively via a MutationObserver on the diag, OR add a
// console tap: temporarily wrap em.setMotion to log cast-class dispatches.
const em = liveScene3d.entityManager;
const _sm = em.setMotion.bind(em);
em.setMotion = (guid, cmd, stance, spd) => {
  if ((guid>>>0) === window.__ws07.casterGuid) {
    const low = cmd & 0xffff;
    const kind = ((low>=0x6f&&low<=0x78)||(low>=0x12b&&low<=0x134)) ? "WINDUP"
               : ((low>=0x2b&&low<=0x39)) ? "FINAL" : "loco";
    window.__ws07.rows.push({ t: performance.now(), cmd: cmd>>>0, low, stance: stance>>>0, kind });
  }
  return _sm(guid, cmd, stance, spd);
};
```
Also enable the raw wire tap if available: `window.__diag?.wire?.summary()` before/after, and
watch console for `[motion-link] no MotionTable link…` warns (entities.js:9611 — a miss).

**Drive the cast from Bot C's console:**
```js
// self-buff (Wedding Bliss 1708) or war bolt on Bot O:
window.__sessionHandle.castTargetedSpell(<selfGuidOrTargetGuid>, 1708);
```

**Observations that resolve each question**
- **C-1 (F11 — the decisive one):** after a 3-windup cast, inspect
  `window.__ws07.rows.filter(r=>r.kind==="WINDUP")`. **Expected PASS:** exactly **3** WINDUP
  rows with the three distinct scarab commands, in order, ~`animLength/CastSpeed` apart
  (≈0.3–0.6s). **FAIL (F11-b):** only **1** WINDUP row (windups 2 & 3 dropped by the stamp
  dedup) → land PATCH 4 (`castWindupSeq`). Cross-check the raw stamps: if you also add a
  temporary `console.log` of `snap.action_sequence` in the wasm emit (or read the
  `pollMotionActions` flat buffer via `window.__sessionHandle.pollMotionActions()` on a
  paused tick), confirm whether the three windups carry **increasing** stamps (a → safe) or a
  **repeated** stamp (b → the drop).
- **C-1b (slot check):** with a wire-level dump (chorizite/`__diag.wire` or a wireshark on
  9000/9001), confirm whether each windup arrives in the InterpretedMotionState
  `forward_command` (u16 `0x6F`) or the `commands[]` list. Forward → outcome (a); commands →
  outcome (b). This is the single fact absent from the in-tree ACE source.
- **C-2 (F12 — PK path):** repeat with **Bot C flagged PK** (`@pk` or a PK char) so
  `FastTick=true`. **Expected:** the windups arrive **batched in one UpdateMotion**; with
  default flags the observer shows ~**one** windup gesture (the collapse). Confirms F12 and
  scopes the `mtQueue` sequencing work.
- **C-3 (F7 — mid-cast spawn):** have Bot C **begin casting out of O's PVS**, then teleport O
  adjacent mid-windup (`@teleloc`/`@telepoi`). **Expected:** O's rig for C is in Magic stance
  (arms-ready) and the remaining windups/final gesture animate — i.e. `getStance(cGuid)===0x49`
  and no `[motion-link]` stance-miss warning.
- **C-4 (F8 — remote slidecast):** Bot C **holds a strafe key while casting** (with
  `?slideCast=on` on C). On O, confirm the caster's rig shows sidestep footwork during the
  windups (the `setSidestepLayer` overlay) — default `?castAxes` on.

**Acceptance:** bare-default URL on O loads, spawns, 0 console errors; C-1 shows 3 windup
rows (or, if 1, PATCH 4 is justified and its flag-off arm is byte-identical).

---

## 5. EYE-TEST QUEUE (1070 GPU box — batched, do NOT run here)

- **E-1 (PATCH 1 regression sanity):** Default flags. A remote mage casts a multi-windup war
  spell at you; simultaneously it takes/deals melee-range damage events. **Expected:** the
  caster's arms wind up + cast (UpdateMotion path); **no** sword-swing maneuver ever appears
  on the caster (the guard's `return` holds). Compare against the pre-patch build — must be
  visually identical (byte-identical arm).
- **E-2 (F12 / PK sequencing — gated on `mtQueue` work, cross-workstream):** PK caster (or
  server `spellcast` FastTick), 3-windup cast, observer. Flag combos:
  `?multiAction=on` (default) vs a future `?mtQueue`-sequenced build. **Expected with
  sequencing:** three distinct windup pumps in order; **without:** ~one gesture. Queue this
  behind the `mtQueue`/`motion_table_manager` completion-clock integration, not WS07 alone.
- **E-3 (F8 remote slidecast footwork):** `?castAxes=on` (default) vs `?castAxes=off`. Remote
  caster strafes while casting. **Expected on:** visible strafe footwork under the cast
  overlay; **off:** feet planted. Confirms the default-ON choice feels right.
- **E-4 (PATCH 4, only if C-1 = outcome b):** `?castWindupSeq=on` vs `off`. Remote 3-windup
  cast. **Expected on:** three windup pumps; **off (byte-identical):** the drop reproduced.

---

## 6. RISKS + cross-workstream interactions

**Files I would touch (for integration ordering):**
- `apps/holtburger-web/index.html` — PATCH 1 (dead-branch removal, dispatchRemoteSwing magic
  arm), optional comment cleanup. **Shared with WS06 (picking/turn), WS08 (kind=13/14
  handler), WS14 (UI/toast).** PATCH 1 touches only lines 8624-8659 (the magic reaction arm);
  low collision risk, but sequence after any structural edit to `dispatchRemoteSwing`.
- `apps/holtburger-web/scene3d/loop.js` — PATCH 2 (comment-only) + optional PATCH 3 diag.
  **Shared with WS06 (`_armTurn`), WS01 (flag-comment drift).** Comment-only ⇒ trivial merge;
  coordinate the flag-comment fix with WS01 so we edit each block once.
- `apps/holtburger-web/scene3d/entities.js` — optional PATCH 3 diag scaffold only. **Heavily
  shared (WS01 setSwingMotion/cast, WS06 face, WS08 busy-window).** Prefer to keep WS07 out of
  entities.js entirely unless PATCH 3 lands; if it does, it is additive `__diag` only.
- `crates/holtburger-world/src/entity.rs` — TEST additions (§4.1) + CONTINGENT PATCH 4.
  **PATCH 4 needs a wasm rebuild** and would touch the surfacing logic shared by all remote
  motion (swings/eat/emotes) — land only if C-1 proves the drop, and gate it.
- `crates/holtburger-common/src/sequence.rs` — TEST addition only (§4.2).
- `docs/url-flags.md` — a row for `castWindupSeq` **iff** PATCH 4 lands.
- New tests: `test_ws07_remote_cast_links.mjs` (+ shared fixture with WS01).

**Interactions / risks:**
- **WS01 (windup link reliability):** We agree on the DAT Magic-stance link coverage (F5) and
  the stale default-OFF comments (F9). WS01 owns the LOCAL predicted cast (`playCastSequence`
  / `setSwingMotion`); WS07 owns the REMOTE echo (`_armMotion*` → `setMotion`). **The dedup
  boundary is shared:** WS01's "note-gating changes which echoes dedup — coordinate with
  WS06/WS07" risk is real. My PATCH 4 (if landed) changes the *stamp source* for magic
  windups; it must not fight WS01's `noteLocalSwingPrediction`/`dispatchParity` echo-swallow.
  **Land WS01's window/note-model change first, then rebase PATCH 4.** Share the
  DAT-link fixture.
- **WS06 (facing/turn):** No conflict. WS06 keeps `_armTurn` remote-only (rejected Approach B);
  WS07 confirms remote-caster turn already works via KIND_TURN (F10). Neither of us edits
  `_armTurn`. Reconciled.
- **WS08 (cast lifecycle):** No direct code overlap. Both cite `FastTick=>IsPKType`. WS08
  touches `index.html` kind=13/14 handler; WS07 PATCH 1 touches a different region (magic
  reaction arm). Sequence both index.html edits to avoid churn, but they don't collide.
- **WS16 (diag surface):** PATCH 3's `__diag.cast` schema is WS16's domain — do **not** land
  PATCH 3 ahead of an agreed schema; it's optional scaffolding for the capture.
- **`mtQueue` / motion-queue workstream:** F12's proper fix (windup sequencing for PK) belongs
  to the dormant `mtQueue`/`motion_table_manager` completion clock. WS07 documents + pins it
  (test §4.1) but does not attempt it. Flag any `mtQueue` activation to re-run E-2.
- **General guardrail:** WS07 proposes **no default-behavior change** for the live non-PK box
  (PATCH 1 byte-identical, PATCH 2 comment-only). PATCH 4 is contingent + flag-gated. This
  keeps the improvement pass minimal and reversible (foundation §4.8).

---

## 7. Verification log (what was actually opened/run this session)

- Read: `index.html:2837-2869` (stances), `:8540-8719` (dispatchRemoteSwing); `entities.js:6368-6377`
  (getStance), `:6650-6690` (setCastPose retirement), `:2103-2238` (classify + expand), `:1400-1458`
  (ATTACK/CAST sets), `:7615-7854` (setMotion cast branch), `:9569-9740` (_tryPlayLink); `loop.js:239-441`
  (flags + drains), `:2470-2639` (_armMotion/_armMotionAction/_armTurn).
- Read: `lib.rs:40890-41134` (KIND_MOTION locomotion emit + filter), `:41200-41386`
  (KIND_MOTION_ACTION stamp dedup + multi-action queue + MOTION_AXES).
- Read (Rust): `crates/holtburger-world/src/entity.rs:100-273` (from_movement_event +
  newest_action_command); `player/types.rs:90-265` (expand_motion_command_low16), `:340-387`
  (is_action_motion_command); `protocol/.../types.rs:73-105,226-389` (MotionStance,
  InterpretedMotionState, MotionItem), `.../messages/motion.rs:1-104` (MovementEventData).
- Read (ACE): `Player_Magic.cs:600-689` (DoWindupGestures/DoCastGesture),
  `WorldObject_Networking.cs:1078-1325` (EnqueueMotionMagic/Motion/Action + EnqueueBroadcastMotion),
  `Physics/Animation/RawMotionState.cs` (ApplyMotion class routing), `Player_Tick.cs:154`
  (FastTick), `MotionStance.cs`/`MotionCommand.cs` (enum values), `melt/.../CommandMasks.cs`.
  **Absent from tree:** ACE.Entity `Motion.cs`/`MotionState.cs`/`MovementData.cs`,
  `GameMessageUpdateMotion` (only referenced) — the F11 gap.
- Decomp: `acclient.c:344372-344426` (move_to_interpreted_state action stamp dedup).
- DAT oracle: parsed MotionTable `0x09000001`; decoded `links[0x490003].motionData` (54 links)
  — all green/purple windups + all `0x2B..0x39` final gestures present (F5).
- Cross-read sibling packets WS01/WS06/WS08 for corroboration (all consistent).

---

```json
{"workstream":"WS07","title":"Remote caster rendering (S1d)","packetPath":"/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/docs/spellcasting-packets-2026-07-12/WS07-remote-casters.md","confidence":"high","keyFindings":["dispatchRemoteSwing magic branch is confirmed DEAD: em.setCastPose is undefined (retired 2026-06-18), so the typeof-guarded call at index.html:8656 is unreachable — but the early return next to it is LOAD-BEARING (without it a Magic-stance attacker falls into the melee getCombatManeuver branch). Remove the call, keep the return.","Final 0x40 cast gesture renders via KIND_MOTION (not KIND_MOTION_ACTION): is_action_motion_command (types.rs:384) deliberately excludes magic substates 0x1E-0x39, so MagicBlast stays in forward_command → _armMotion → setMotion cast branch → _tryPlayLink(Magic,Ready,0x4000002B). DAT-confirmed the link exists.","Windups render via KIND_MOTION_ACTION (Action-class 0x10) → _armMotionAction → same setMotion cast branch. DAT oracle: player MT 0x09000001 links[(0x49,0x03)] has ALL green+purple windups AND all 0x2B-0x39 final gestures (corroborates WS01).","ACE wire diverges on FastTick=>IsPKType: non-PK (this box) sends 3 SEPARATE UpdateMotion windups via EnqueueMotionMagic (WorldObject_Networking.cs:1078); PK sends ALL windups batched in one commands[] list via EnqueueMotionAction (:1231).","OPEN (needs 2-bot capture): non-PK windup slot (forward_command→movement_seq=SAFE vs commands[]→MotionItem stamp=drop-risk) is unresolvable — ACE.Entity Motion.cs is absent from the partial checkout. Our dedup is robust IF the stamp increments.","PROVEN PK-only gap: newest_action_command collapses batched windups to the newest; the rest drain via multiAction (default-ON) but play same-tick as stomping overlays — ~1 gesture. Fix needs the dormant mtQueue completion clock (cross-workstream).","Stance is low16 0x49 end-to-end and rides every cast broadcast + ObjectCreate MovementData, so mid-cast spawn has stance (verified low-risk). castAxes remote strafe overlay (setSidestepLayer) works and is default-ON. Multiple loop.js 'default OFF' comments are stale (default-ON per url-flags.md) — same drift WS01 found."],"filesToChange":["apps/holtburger-web/index.html","apps/holtburger-web/scene3d/loop.js","apps/holtburger-web/crates/holtburger-world/src/entity.rs (tests; +contingent PATCH4)","apps/holtburger-web/crates/holtburger-common/src/sequence.rs (test)","apps/holtburger-web/test_ws07_remote_cast_links.mjs (new)","apps/holtburger-web/docs/url-flags.md (only if PATCH4 lands)"],"needsWasmRebuild":false,"newFlags":["castWindupSeq (CONTINGENT — only if capture C-1 proves non-PK windup drop; default-OFF)"],"risks":["PATCH1 must KEEP the magic-stance early return (load-bearing anti-melee-misfire guard); a naive full-block deletion regresses.","F11 non-PK windup-drop is unproven from in-tree source (ACE.Entity Motion.cs absent) — do NOT ship PATCH4 speculatively; gate on the 2-bot capture.","Shared dedup boundary with WS01 (dispatchParity/noteLocalSwingPrediction) — land WS01 window/note-model first, then rebase any PATCH4.","index.html dispatchRemoteSwing arm is shared with WS06/WS08/WS14 — sequence index.html edits.","PATCH3 __diag.cast schema is WS16's domain — do not land ahead of it.","PK windup sequencing (F12) is entangled with the dormant mtQueue/motion_table_manager completion clock — defer, re-run E-2 when mtQueue activates."]}
```

---

## VERDICT (WS07-verify)

**Verifier:** adversarial re-check, buildbox, 2026-07-12. Baseline confirmed `6fcff2f0`
(clean tree, HEAD matches). Every load-bearing cite was re-opened live; the DAT oracle
result (F5) and the ACE wire divergence (F6) were **independently reproduced**, not
taken on the packet's word.

**Verdict: CONFIRMED — apply the two landable patches (PATCH 1 + PATCH 2).** F1–F10 all
hold against the live tree; the two patches are byte-identical / comment-only, apply with
exact context, stay in scope, and cannot regress castMove/slideCast/cmdInterp (those live
in the Rust movement crate + input lanes, untouched). PATCH 3/4 are correctly deferred.
The one **material correction** is that F11 is *more resolved* than the packet claims — the
packet under-states its own certainty (details below); this does **not** change any action.

### What I re-verified (all CONFIRMED)

- **F1 (dead `setCastPose`)** — CONFIRMED. `rg setCastPose scene3d/entities.js` → only
  comments, **no method definition** anywhere (`em.setCastPose` is `undefined`). The
  `index.html:8654-8659` block matches the packet verbatim; `typeof undefined === "function"`
  is false so the call is unreachable. Removal is byte-identical. *(New observation, not a
  defect: there is a SECOND safe-no-op call site the packet doesn't mention —
  `picking.js:696` `em?.setCastPose?.(localGuid)` (optional-chain no-op). It's the LOCAL
  cast path, out of WS07's remote scope; flag it for a future cleanup sweep, not this patch.)*
- **F2 (load-bearing `return`)** — CONFIRMED. `dispatchRemoteSwing` (defined `index.html:8549`)
  has **exactly two callers** — `:8715` (`damageTaken`) and `:8719` (`evadedAttacker`); no
  other invocations. `MAGIC_STANCES = new Set([0x0049])` at `index.html:2855-2857` (exact).
  Deleting the whole `if` block (rather than just the inner call) would drop a Magic-stance
  attacker through `RANGED_STANCES` (0x49 absent) into the melee `else` → `getCombatManeuver`
  (`:8701`) → a sword-swing on a caster. PATCH 1 correctly keeps the `return`. The
  `swingFresh` early-return (`:8599-8613`) *usually* masks this because `_lastServerSwingMs`
  is stamped on the cast success path — packet's "usually masked but not guaranteed" is fair.
- **F3 (final 0x40 via KIND_MOTION)** — CONFIRMED. `types.rs:384`
  `0x4000_0000 => matches!(full & 0xFFFF, 0x0016..=0x001D | 0x00D3 | 0x00E0 | 0x00E1)` (exact);
  MagicBlast low-16 `0x2B` is NOT in the set → not an action → the lib.rs locomotion filter
  (`src/lib.rs:40930-40934`, drops only `is_action_motion_command`) passes it through →
  KIND_MOTION. JS chain confirmed: `CAST_COMMANDS` includes `0x002B` (`entities.js:~1433`);
  `expandActionCommandLow16(0x2B)` → `0x4000002B` via `isUseClass` (0x16..0x39, `entities.js:~2235`).
  `_armMotion` (`loop.js:2528-2557`) routes remote guids to `em.setMotion`.
- **F4 (windups via KIND_MOTION_ACTION)** — CONFIRMED. `is_action_motion_command` line 370
  `0x1000_0000 => true` (windups are top-byte 0x10). Surfaced via `from_movement_event`
  (`entity.rs:151`) → lib.rs KIND_MOTION_ACTION emit (`:41258-41296`) with `is_newer_u16`
  stamp dedup (`:41231-41250`). `_armMotionAction` (`loop.js:2585-2627`) fires for every guid
  incl. local → `em.setMotion` cast branch. (Packet said `:2585-2626`; actual `-2627`. Trivial.)
- **F5 (DAT link coverage)** — **INDEPENDENTLY REPRODUCED.** Ran the oracle on
  `client_portal.dat 0x09000001`; parsed `links[0x490003]` (Magic,Ready) `motionData` = **54
  keys**, containing **10/10** green windups `0x1000006F..78`, **10/10** purple band
  `0x1000012B..134`, and **15/15** finals `0x4000002B..39`. Matches the packet exactly.
- **F6 (ACE wire divergence)** — CONFIRMED against ACE source. `Player_Tick.cs:154`
  `public bool FastTick => IsPKType;` (exact). `Player_Magic.cs:635-636` — non-PK issues
  **one `EnqueueMotionMagic` per windup** inside `foreach ... if (!FastTick)`; `:644-645` —
  PK issues **one `EnqueueMotionAction(..., WindupGestures, ...)`** batching all windups;
  `:685` — non-PK final gesture via `EnqueueMotionMagic`. `WorldObject_Networking.cs:1078-1093`
  (EnqueueMotionMagic), `:1231-1273` (EnqueueMotionAction: `new Motion(stance, Ready)` +
  `AddCommand` per windup), `:1306-1325` (EnqueueBroadcastMotion). All confirmed.
- **F7 (stance low-16 0x49)** — CONFIRMED. `motion_stance: u32::from(data.current_style)`
  on both emits (`lib.rs:41288` action / locomotion emit). Rides every cast broadcast.
- **F8 (castAxes remote strafe)** — CONFIRMED. `CAST_AXES_ON` (`loop.js:399-408`) = default-ON;
  `drainMotionAxes` (`:410-441`) → `setSidestepLayer` for remote sidestep, skips local (`:424`).
- **F9 (stale "default OFF" comments)** — CONFIRMED. `MULTI_ACTION_ON` (`loop.js:246-255`) and
  `CAST_AXES_ON` (`:399-408`) both use `?.toLowerCase() !== "off"` (default-ON) while their
  comments say "default OFF". `docs/url-flags.md:12` lists both (+ dispatchParity/serverSwing/
  mtQueue) under "**Now default-ON**"; rows 268/283 show `on`. PATCH 2 context matches lines
  239-241 and 392-393 exactly. *(Aside, pre-existing, out of scope: the url-flags.md TABLE
  rows 268/283 descriptions are themselves stale — "Allow concurrent combat actions" /
  "Debug: visualize cast projection axes" — not the actual multiAction/castAxes behavior. Not
  WS07's to fix, but worth a campaign note.)*
- **F10 (remote turn)** — CONFIRMED. `_armTurn` (`loop.js:2629-2638`) is remote-only
  (`!isLocalPlayerGuid`) → `applyTurnDirective`. No WS07 change needed.
- **F12 (PK collapse)** — plausible & PK-only; `newest_action_command` (`entity.rs:117-149`)
  keeps the highest-stamp item, `drainMotionActions` (`loop.js:367-390`) plays the remainder
  same-tick via `em.setMotion` (`:388`) = overlay stomp. Correctly deferred to `mtQueue`.

### Test-plan premises — CHECKED, real

The two Rust sibling tests the plan extends **exist exactly as cited**:
`invalid_movement_surfaces_newest_action_command_expanded` (`entity.rs:435`),
`forward_command_eat_surfaces_as_action_runforward_stays_locomotion` (`entity.rs:599`);
`is_newer_u16` (`sequence.rs:7`, with wrap/half-range tests). The proposed
`test_ws07_remote_cast_links.mjs` does not yet exist (it's new) and the referenced pattern
`test_ac_cast_over_locomotion.mjs` **does** exist. The §4.3 DAT-link assertion is DAT-proven
(F5 reproduced). Note the tests are **written but not landed** — this is an investigation
packet, so that's expected, but a reviewer should not read §4 as "tests pass" (they are not
yet compiled/run). The proposed assertions are sound given the verified code.

### MATERIAL CORRECTION — F11 is more resolved than the packet states

The packet frames F11 as "**the single decisive open question … unresolvable from in-tree
source … medium confidence**," pinned on ACE.Entity `Motion.cs` being absent. Two refinements:

1. **The slot question IS resolvable from present source.** Non-PK windups go through
   `EnqueueMotionMagic` = `new Motion(MotionStance.Magic, windup, speed)` — the **identical
   3-arg constructor** used by `EnqueueMotion_Force(NonCombat, Eat)`, which *our own*
   `entity.rs:188-201` comment documents (verified, review B6) lands the command in the wire
   **`forward_command`** slot. The `EnqueueMotionAction` contrast is airtight: it deliberately
   passes `MotionCommand.Ready` as the constructor's forward command and then calls
   `MotionState.AddCommand(...)` per windup (`WorldObject_Networking.cs:1235-1238`) — which is
   only meaningful if the 3-arg constructor sets `ForwardCommand` (not `Commands`). And
   `ApplyPhysicsMotion` (`:1335`) reads `motion.MotionState.ForwardCommand` to apply a single
   broadcast. Conclusion: **non-PK windups land in `forward_command` = outcome (a)**, surfaced
   by the forward branch (`entity.rs:184-216`) with `action_sequence = data.movement_sequence`.
   This is derivation from source, not a coin-flip needing a capture.
2. **The only genuinely unclosed link** is whether `movement_sequence` (the object-movement
   header seq, wire slot 1) **increments across the 3 separate non-PK broadcasts**. That is
   standard AC/ACE protocol (`GetNextSequence(ObjectMovement)` per `UpdateMotion`), and
   `entity.rs:204-208` asserts it, but the `GameMessageUpdateMotion` source (which calls
   GetNext) **is** absent from this partial ACE checkout, and this ACE tree is
   identifier-mangled (`SequenceType`/`GameMessageUpdateMotion` both render as `n`), so I could
   not read the bump line directly. If the seq increments (near-certain), all 3 windups pass
   `is_newer_u16` → **outcome (a) is SAFE and remote non-PK casters DO raise arms 3×.**

**Net:** downgrade F11 from "decisive/unresolvable/medium" to "**strongly favors (a) SAFE;
the laptop capture C-1 is confirmatory, not the sole arbiter**." The packet's *action* is
unchanged and correct: **do NOT ship PATCH 4** (it's only needed for the disfavored outcome
(b), and shipping it speculatively risks double-play on the safe path). Keep the capture as
a belt-and-suspenders confirmation; do not gate the two clean patches on it.

### Minor packet defect (non-blocking)

- The trailing JSON `filesToChange` prefixes the crate paths with `apps/holtburger-web/`
  (`apps/holtburger-web/crates/holtburger-world/src/entity.rs`). The crates live at the
  **repo root** (`crates/holtburger-world/...`, `crates/holtburger-common/...`); the packet
  **body** cites them correctly, only the JSON block is wrong. Cosmetic — fix for accuracy.

### Regression / scope check — PASS

PATCH 1 touches only `index.html:8654-8659` (a `damageTaken`/`evadedAttacker` melee-reaction
arm); PATCH 2 is comment-only in `loop.js`. Neither touches the Rust movement crate, the
input lanes, or `entities.js` cast machinery, so castMove / slideCast / cmdInterp and the
KIND_MOTION_ACTION dedup are untouched. `index.html` is shared with WS06/WS08/WS14 — sequence
the `index.html` edits, but PATCH 1's region does not collide with the kind=13/14 handler or
the picking/turn code. No default-behavior change on the live non-PK box.

```json
{"workstream":"WS07","verdict":"CONFIRMED","apply":true,"mustFix":["Fix the trailing-JSON filesToChange path prefix: crates are at repo-root crates/holtburger-world & crates/holtburger-common, NOT apps/holtburger-web/crates/... (packet BODY is correct; only the JSON block is wrong).","Downgrade F11's framing: the non-PK windup SLOT is resolvable from present source — EnqueueMotionMagic uses the identical new Motion(stance,cmd,speed) forward-command constructor as the VERIFIED Eat path (EnqueueMotion_Force -> forward_command), so outcome (a)=SAFE is strongly favored; the only unclosed link is the per-broadcast movement_sequence increment (standard AC protocol, GameMessageUpdateMotion source absent). Keep capture C-1 as confirmatory, not 'decisive/unresolvable'. Action (defer PATCH 4) unchanged."],"notes":"F1-F10 all re-verified against the live 6fcff2f0 tree; F5 DAT link coverage (54 keys, all windups+finals) INDEPENDENTLY REPRODUCED via the oracle, F6 ACE divergence (FastTick=>IsPKType, EnqueueMotionMagic-per-windup vs EnqueueMotionAction-batch, Player_Magic.cs:635/645/685) INDEPENDENTLY CONFIRMED from source. PATCH 1 (remove dead setCastPose call, keep load-bearing return) is byte-identical and applies with exact context; PATCH 2 (stale default-OFF comment fix) is comment-only and matches lines 239-241/392-393. dispatchRemoteSwing has exactly 2 callers; MAGIC_STANCES=Set([0x0049]) at 2855-2857. Test-plan sibling tests (entity.rs:435/599, sequence.rs:7) exist as cited but the new WS07 tests are NOT yet landed (investigation packet). Two non-blocking corrections: JSON path prefix, and F11 is more resolved than stated (strongly favors SAFE outcome a). Also noted: a 2nd safe-no-op setCastPose call site at picking.js:696 (local path, out of scope) the packet omits. PATCH 3/4 correctly deferred. No regression to castMove/slideCast/cmdInterp or KIND_MOTION_ACTION dedup."}
```

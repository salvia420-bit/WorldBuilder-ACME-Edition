# WS06 — Turn-to-face correctness for casts

Investigator packet, 2026-07-12. Baseline `external/holtburger` (tree per foundation).
All cites opened live this session; ACE = `external/ACE/Source` (reference only).

**One-line verdict:** the local caster faces the target *correctly at cast-send*
(bearing math verified), but it **never re-faces during/after the windup chain**.
Vanilla ACE re-rotates the caster before the final cast gesture and broadcasts that
`TurnToObject` to the caster himself; our wasm surfaces it as `KIND_TURN` for the local
guid, and `loop.js _armTurn` **drops it (remote-only)**. Fix = a flag-gated client-side
re-face at the final gesture, via the *proven* `setMovementInput` turn path (the only
thing that can rotate the integrator-owned local rig). Remote casters already re-face
correctly off the server directive.

---

## 1. VERIFIED FINDINGS

### 1.1 The local cast face-to-target — what it does today
- **`castFaceTarget` is default-ON.** `picking.js:51-56`:
  `new URLSearchParams(...).get("castFaceTarget") !== "off"` → true when absent.
  (The `docs/url-flags.md:270` row still reads *"Default-off, pending 1070 eye-test"* —
  **stale**; the top-of-file "Now default-ON" list at `url-flags.md:12` correctly
  includes it. Doc drift, flagged in §3.5.)
- **`turnToFaceThenAct` faces first, then acts** (`picking.js:415-462`). It:
  1. `if (!enabled) { act(); return; }` (:416-419) — flag-off ⇒ immediate cast.
  2. `if (manualMovementHeld()) { act(); return; }` (:427-430) — a held WASD key owns
     the drive (kite-safe; the comment cites retail raw-input-cancels-MoveTo
     acclient.c:339240). **No turn while moving.**
  3. Otherwise a `requestAnimationFrame` loop drives `setMovementInput(0,0, turnDelta>0?1:-1, false)`
     (:458) until `|turnDelta| <= 0.05` rad **or** `FACE_TURN_TIMEOUT_MS = 800` (:452-453,
     :31), then `setMovementInput(0,0,0,false)` and `act()`.
  → So at **cast-send** time the caster's heading is on-target (unless a 800 ms timeout
    on a wildly off-angle target). `act()` = `castTargetedSpell(guid, spellId)` then
    `em.playCastSequence(localGuid, spellId)` (`picking.js:673-701`).

### 1.2 The turn is a smooth HEADING rotation, NOT a turn-in-place animation
- The local rig heading is **owned entirely by the wasm integrator**. KIND_POSITION is
  *skipped* for the local guid (`loop.js:2853-2870`, `if (!isLocalPlayerGuid(g))`), and
  `applyLocalPlayerPoseFromIntegrator` rebuilds the rig quaternion **yaw-only from
  `pose.heading`** every rAF (`rust_pose.js:79-88`: `qw=cos(h/2), qz=sin(h/2)`).
  ⇒ The only way to rotate the local rig is to move the integrator heading, i.e.
  `setMovementInput` (turn axis). This is *why* `turnToFaceThenAct` uses that path and
  the earlier wasm `turnToEntity`/`turnToHeading` Pursuit path was abandoned
  (`picking.js:436-438` note; wasm methods live but `?wasmPursuit`-gated, `lib.rs:32427-32454`).
- **No leg-shuffle turn cycle plays.** The `cmdInterp` DriveApplied consumer
  (`index.html:8137-8173`, code61===3) unpacks only `fwd`,`side`,`run` from the packed
  payload — the **turn axis (bits 16-23) is never read** — and a turn-only drive
  (`fwd===0`) maps to `forwardCmd = 0x41000003` (Ready idle, :8156). So during the
  face-turn the rig **pivots with an idle pose**; the rotation itself is smooth
  (incremental per-frame, not a snap), but there is no `TurnRight`/`TurnLeft` cycle.
  (Confirmed: `?cmdInterp` default-ON since 2026-07-03, foundation 1.4.)

### 1.3 The facing bearing math is CORRECT (no sign bug) — "bolt not sideways" at send
- `turnToFaceThenAct` uses `turnDelta = normalizeAngle(atan2(dx, dy) - pose.heading)`
  (`picking.js:449-451`), with `dx,dy` in AC-world (`entityAcPosition` returns
  `inst.root.position` which is AC-frame, `picking.js:126-131` + :114-127 note;
  `playerWorldPose` returns AC-world x/y + integrator heading, :160-173).
- **The wasm heading is the compass convention**, authoritatively documented at
  `lib.rs:29002`: *"yaw=0 → facing +Y (north); yaw=π/2 → facing +X (east)"*. So AC-world
  forward(θ) = `(sinθ, cosθ)` [x=East, y=North], and the bearing that faces `(dx,dy)` is
  exactly `atan2(dx, dy)`. **Match ⇒ correct.**
- ⚠ Do not be misled by `camera.js:1046` (*"AC forward = (−sinθ,+cosθ)"*): that comment
  describes the **three.js camera frame**, which *negates* `pose.heading` (`camera.js:1051`
  `h = -poseH`). It is a different frame; it does **not** contradict `lib.rs:29002`.
  The `meleeFaceTarget` branch's `atan2(-dx,dy)` (`entities.js:7837`) operates on the
  three.js **rig-quaternion** frame (it `.set()`s the quaternion directly), also a
  different representation — not evidence of a bug here.
- Corroboration: this is the same path that passed the **missile face-target eye-test
  2026-06-11** (`picking.js:26-29`, `MISSILE_FACE_TARGET = true`). Node test §4 proves
  `forward(atan2(dx,dy)) · targetDir == 1` for all quadrants (23/23 pass).

### 1.4 The projectile trajectory is SERVER-authored (facing is cosmetic to it)
- A missile's only motion datum is the ObjectCreate PhysicsDesc launch velocity
  (`entities.js:4019-4045`; foundation 1.5). It is seeded as `lastVel` + `_ballistic`
  and integrated in JS; ACE never streams in-flight position for MISSILE.
- ⇒ The bolt **always flies toward the target's launch-time position regardless of
  caster facing.** "Bolt launches sideways" is therefore a **visual artifact of a stale
  caster heading** (the bolt spawns at/near the caster and departs toward the target; a
  mis-faced caster makes it appear to leave from the side/back), *not* a wrong trajectory.

### 1.5 Vanilla ACE DOES send TurnTo to the caster — at start AND before the gesture
Read in full from `Player_Magic.cs`:
- **Cast start:** `CreatePlayerSpell` → `var rotateTime = Rotate(rotateTarget)`
  (`Player_Magic.cs:166`, non-FastTick) / `TurnTo_Magic(target)` (:189, FastTick).
- **Before the final cast gesture:** `DoCastSpell` — *"do second rotate, if applicable"*
  — `if (checkAngle && !IsWithinAngle(target))` → `Rotate(target)` (`:766`, non-FastTick,
  delays the gesture by `rotateTime`) / `TurnTo_Magic(target)` (`:776`, FastTick).
  `IsWithinAngle` compares `GetAngle(target)` vs `spellcast_max_angle` (`:717-744`).
- **Between windups (FastTick path):** `DoWindup` re-faces if out of angle
  (`:206-218`: `TurnTo_Magic(target)` or `PendingTurnRelease`).
- `Rotate()` → `TurnToObject(target)` → `new Motion(this, target, MovementType.TurnToObject)`
  → `EnqueueBroadcastMotion(turnToMotion)` (`Creature_Navigation.cs:142-180`, :127-135).
- **The caster receives its own turn.** `EnqueueBroadcastMotion` (`WorldObject_Networking.cs:1306-1325`)
  → `EnqueueBroadcast(msg)` → params overload (`:1413-1416`) → `EnqueueBroadcast(true, msgs)`
  → **`sendSelf` sends to `this` as Player** (`:1428-1432`, `self.Session.Network.EnqueueSend`).
- **Which path is live on our vanilla server:** `FastTick => IsPKType`
  (`Player_Tick.cs:154`); `IsPKType => PK || PKLite` (`Player_Combat.cs:1023`). Non-PK
  (the vanilla default) ⇒ **non-FastTick** ⇒ the retail-style `Rotate()` broadcasts.
  Either way, `TurnToObject` (0xF74C `UpdateMotion`) is broadcast **to the caster**.
- **Discord lore corroboration** (foundation 4b): "the client is told to animate the
  movement of someone turning to another person when a person is casting a spell on them"
  — observers see the caster turn; that is exactly this `TurnToObject` broadcast.

### 1.6 Our wasm surfaces the caster's own TurnTo as KIND_TURN — then JS DROPS it
- The `GameMessage::UpdateMotion` recv arm fires for **all** UpdateMotion incl. the local
  player's (`lib.rs:40866-40883` explicitly cites BroadcastMovement including the
  originator). UpdateMotion is **not** routed to the world handler dispatcher
  (`lib.rs:37290-37295`), so it reaches this arm with no self-guid filter.
- The arm emits a `KIND_TURN` (kind=9) EntityUpdate **with `guid = data.guid`** (the local
  guid), heading as an AC z-up quaternion (`qw=cos(h/2), qz=sin(h/2)`), `omega_z`=turn
  speed (`lib.rs:41142-41200`; source doc `:22731-22752`).
- **`loop.js _armTurn` (`:2629-2638`) drops it for the local guid:**
  `if (!isLocalPlayerGuid(turnGuid) && ... em.applyTurnDirective(...))`. Comment: *"Remote-only;
  the local player owns its own facing."* → the server's re-face is discarded for self.
- Even if applied, it *couldn't* rotate the local rig: `applyTurnDirective` sets
  `_serverTargetQuat`+`_headingEaseInit` (`entities.js:8507-8524`) and the tick slerp
  (`entities.js:11875-11900`) is **not** isRemote-gated — BUT for the local player it is
  overwritten every rAF by `applyLocalPlayerPoseFromIntegrator` (§1.2). So **applying the
  server KIND_TURN to the local guid is a dead end** (Approach B, rejected in §3).

### 1.7 Remote casters — verified they re-face correctly, do NOT cast at empty air
- `meleeFaceTarget` **excludes casts by design**: `entities.js:7832`
  `if (MELEE_FACE_TARGET && cls === "attack" && ...)` — `cls === "cast"` is never
  snap-faced. Comment (:7830): *"Attack only (casters keep their windup heading)."*
  Corroborated `url-flags.md:247`.
- But remote casters re-face via the **server directive**: for a remote guid, `_armTurn`
  **applies** the `KIND_TURN` → `applyTurnDirective` → `_serverTargetQuat` → tick slerp
  rotates the rig root (`entities.js:11875-11900`; `?turnOmega` default-ON caps the rate,
  `url-flags.md:549`). So when the target strafes beyond `spellcast_max_angle` and ACE
  broadcasts the pre-gesture `TurnToObject`, the **remote caster turns to face it** — it
  does **not** cast at empty air. Within the angle tolerance ACE sends no re-face and the
  remote holds its windup heading — which is **authentic** (matches the server).
- Remote turn-in-place **footwork** (leg cycle) plays under `?castAxes` (`loop.js:434-440`,
  `setMotion(guid, turnCmd, stance)` gated on no forward command). **`castAxes` reader
  defaults ON** (`loop.js:399-408`, `!== "off"`; listed in `url-flags.md:12`). NOTE its
  inline comment (`loop.js:392-398` "Default OFF … needs a 1070 eye-test") is **stale**.

### 1.8 DAT ground truth (WB.Terminal oracle, player MT 0x09000001)
- 366 cycles / 318 link outer keys. Magic stance (0x49) has the cast-gesture links,
  e.g. `0x0049002B` (MagicBlast final gesture), `0x004900E0/E1`, the AimLevel/gesture
  band `0x0049002C-0x00490031`, plus `0x00490003` (Ready) and `0x00490005/0007`
  (walk/run). ⇒ The final blast gesture *is* linkable in Magic stance (setSwingMotion
  can resolve it); the facing problem is orthogonal to gesture playback.

---

## 2. ROOT CAUSES

**RC-1 (charter core — multi-windup mis-face / "bolt sideways"):** During the JS
wall-clock windup chain `playCastSequence` (~1–3 s; `entities.js:6728-6912`), the local
caster **never re-faces**. It faces once at click (`turnToFaceThenAct`), sends the cast,
then chains gestures; ACE's mid-/pre-gesture `TurnToObject` re-face — which our wasm
surfaces as `KIND_TURN` for the local guid (§1.6) — is dropped by `_armTurn` (remote-only).
If the target strafes during the windup, the caster stays frozen at the click-time
heading and the (server-authored, correctly-aimed) bolt visually launches at an angle
from the caster's front. **Proven** by code trace (§1.1/1.5/1.6) + ACE source + the
server-authored-velocity fact (§1.4).

**RC-2 (charter Q1 — "turn animation vs snap"):** The local face-turn is a smooth heading
rotation but plays **no turn-in-place leg cycle** — the DriveApplied consumer never reads
the turn axis and idles the base clip on a turn-only drive (`index.html:8137-8173`).
Cosmetic; the caster pivots with an idle pose. **Proven** by code trace (§1.2).

**Not a bug:** the bearing formula (`atan2(dx,dy)`) is correct for the documented compass
heading convention (§1.3) — a plausible-looking `-dx` "fix" would *introduce* a mirror
error. Remote-caster empty-air casting is **already handled** by the server-driven
`KIND_TURN` re-face (§1.7).

---

## 3. PATCH PLAN (minimal, flag-gated, reversible)

**Decision (charter):** re-face the local caster at the **final gesture**, gated behind a
new default-OFF `?castReface`, using the **proven `setMovementInput` turn path** — NOT by
applying the server KIND_TURN to the local guid (§1.6 dead end). Fire-and-forget so the
turn runs concurrently with the cast-gesture overlay (caster pivots while blasting —
matches ACE's concurrent `Rotate()`+gesture). Kite-safe: `turnToFaceThenAct` already
skips while a movement key is held.

### 3.1 New flag — `scene3d/picking.js` (after `CAST_FACE_TARGET`, ~:56)
```diff
 const CAST_FACE_TARGET = (() => {
   try {
     return typeof window !== "undefined" &&
       new URLSearchParams(window.location.search).get("castFaceTarget") !== "off";
   } catch { return false; }
 })();
+
+// F8-6 (WS06, 2026-07-12) — re-face the local caster at the FINAL cast gesture.
+// Vanilla ACE re-rotates the caster before the cast gesture if the target moved
+// beyond spellcast_max_angle (Player_Magic.cs:762 Rotate()/TurnTo_Magic) and
+// broadcasts TurnToObject to the caster HIMSELF (self-inclusive EnqueueBroadcast,
+// WorldObject_Networking.cs:1428). Our wasm surfaces that as KIND_TURN for the
+// local guid, but loop.js _armTurn drops it (remote-only) and the local rig
+// heading is integrator-owned (applyLocalPlayerPoseFromIntegrator) — so only
+// setMovementInput can rotate it. We re-run the proven turn-in-place drive right
+// before the final gesture. Default-OFF (touches the motion pipeline mid-cast →
+// 1070 eye-test; a turn edge could trip an FU-A control reclaim, ADJ-15 Q3).
+// (?castReface=on)
+const CAST_REFACE = (() => {
+  try {
+    return typeof window !== "undefined" &&
+      new URLSearchParams(window.location.search).get("castReface") === "on";
+  } catch { return false; }
+})();
```

### 3.2 Thread target + hook into the cast chain — `scene3d/entities.js`
Signature (`:6728`) + fire the hook immediately before the final gesture (`:6829-6831`):
```diff
-  async playCastSequence(guid, spellId) {
+  async playCastSequence(guid, spellId, opts) {
```
```diff
     if (seq.castGesture) {
+      // WS06 (2026-07-12): client re-face at the final gesture (ACE's second
+      // Rotate before the cast gesture, Player_Magic.cs:762). Fire-and-forget so
+      // the turn runs CONCURRENTLY with the gesture overlay. No-op unless the
+      // caller supplied a hook (flag-gated in picking.js). Token-guarded so a
+      // preempted/fizzled chain doesn't re-face.
+      if (inst._castSequenceToken === token &&
+          typeof opts?.onBeforeCastGesture === "function") {
+        try { opts.onBeforeCastGesture(); } catch (_) { /* never break the chain */ }
+      }
       await playGesture(seq.castGesture);
     }
```
(Backward-compatible: existing callers pass no `opts` → `opts?.onBeforeCastGesture`
undefined → no-op. The plugin/api + hotbar cast paths are unaffected.)

### 3.3 Pass the hook from the click-to-cast path — `scene3d/picking.js` (in `doCast`, ~:693-697)
```diff
                 const em = liveScene3d?.entityManager;
                 if (em?.playCastSequence) {
-                  em.playCastSequence(localGuid, spellId);
+                  em.playCastSequence(localGuid, spellId, {
+                    // WS06: re-face toward the target's CURRENT position right
+                    // before the final gesture. turnToFaceThenAct reads the live
+                    // target pos each frame and skips if a movement key is held
+                    // (kite-safe). No-op `act`. Flag-off (CAST_REFACE=false) makes
+                    // turnToFaceThenAct return immediately — byte-identical.
+                    onBeforeCastGesture: () =>
+                      turnToFaceThenAct(guid, () => {}, CAST_REFACE),
+                  });
                 } else {
```
`guid` (target), `turnToFaceThenAct`, and `CAST_REFACE` are all in scope in the click
handler closure. With `CAST_REFACE=false`, `turnToFaceThenAct(...,false)` hits
`if (!enabled) { act(); return; }` — a single no-op call, no `setMovementInput`.

### 3.4 `docs/url-flags.md` — new row (draft)
```
| `castReface` | `on` | off | F8-6 (WS06, 2026-07-12): re-face the local caster toward the target's CURRENT position right before the FINAL cast gesture, so a multi-windup war/void cast whose target strafed mid-windup doesn't blast out of a frozen click-time heading. Vanilla ACE re-rotates the caster before the cast gesture when the target moved beyond `spellcast_max_angle` (Player_Magic.cs:762 `Rotate()`/`TurnTo_Magic`), broadcasting `TurnToObject` to the caster himself (WorldObject_Networking.cs:1428); our wasm surfaces it as KIND_TURN for the local guid but `_armTurn` drops it (remote-only) and the local rig heading is integrator-owned, so we re-run the proven `setMovementInput` turn (same mechanism as `castFaceTarget`/`missileFaceTarget`) fire-and-forget, concurrent with the gesture overlay. Kite-safe: skipped while a manual movement key is held. Default-OFF pending 1070 eye-test (turn edge could trip an FU-A control reclaim, ADJ-15 Q3). `=off`/absent = byte-identical (an extra no-op hook call). | scene3d/picking.js + scene3d/entities.js (playCastSequence) |
```

### 3.5 Doc-only drift to correct (no behavior change)
- `url-flags.md:270` `castFaceTarget` row says *"Default-off, pending 1070 eye-test"* —
  stale; code is default-ON (`picking.js:51`, P16 2026-07-04). Update the row.
- `loop.js:392-398` `castAxes` inline comment says *"Default OFF (needs a 1070
  eye-test)"* — stale; the reader defaults ON (`loop.js:403`) and it's in the
  `url-flags.md:12` default-ON list. Update the comment.

### 3.6 Rejected alternative (documented so it isn't re-attempted)
**Approach B: relax `_armTurn`'s `!isLocalPlayerGuid` guard to apply the server
`KIND_TURN` to the local caster during a cast.** More retail-faithful on paper (it's
literally the server directive), but a **dead end**: the local rig heading is rebuilt from
the integrator every rAF (`applyLocalPlayerPoseFromIntegrator`, `rust_pose.js:79-88`), so
`applyTurnDirective`'s `_serverTargetQuat` slerp is overwritten each frame. Making it work
would require feeding the server heading into the wasm integrator — a wire→movement
control migration far beyond an "improvement pass," and overlapping WS on the movement
crate. Keep the client-side `setMovementInput` re-face (Approach A).

### Needs wasm rebuild? **No.** All three code hunks are pure JS (picking.js + entities.js).

---

## 4. TESTS

### 4.1 Node unit test (pure-JS math) — VALIDATED THIS SESSION (23/23 pass)
Ran on the buildbox: `node test_ws06_cast_facing.mjs` → `23 passed, 0 failed`. It mirrors
`turnToFaceThenAct`'s bearing (`atan2(dx,dy)`) + the compass convention (`lib.rs:29002`)
and proves: (a) N/E/S/W bearings; (b) **`forward(atan2(dx,dy))·targetDir == 1` for every
quadrant** — the "bolt not sideways at send" invariant; (c) turn-delta sign drives the
short way; (d) the convergence loop settles facing the target; (e) a proposed
`refaceNeeded(heading,dx,dy,thr)` fires when the target strafes past tolerance and stays
quiet within it (authentic to `IsWithinAngle`). Full source below — drop as
`apps/holtburger-web/test_ws06_cast_facing.mjs` at implementation time (I did not add it
to the repo per the read-only mandate).

```js
// WS06 — cast facing math validation. node test_ws06_cast_facing.mjs
let pass = 0, fail = 0;
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
function check(name, cond){ if(cond){pass++;}else{fail++;console.error("FAIL:",name);} }
function normalizeAngle(a){ while(a>Math.PI)a-=2*Math.PI; while(a<-Math.PI)a+=2*Math.PI; return a; }
const bearingToTarget = (dx, dy) => Math.atan2(dx, dy);          // picking.js:451
const forward = (h) => ({ x: Math.sin(h), y: Math.cos(h) });    // lib.rs:29002 compass
check("north dx=0,dy=+ -> 0", approx(bearingToTarget(0,10),0));
check("east  dx=+,dy=0 -> +pi/2", approx(bearingToTarget(10,0),Math.PI/2));
check("west  dx=-,dy=0 -> -pi/2", approx(bearingToTarget(-10,0),-Math.PI/2));
check("south dx=0,dy=- -> pi", approx(Math.abs(bearingToTarget(0,-10)),Math.PI));
for (const [dx,dy] of [[10,0],[0,10],[-7,3],[4,-9],[-5,-5],[8,8],[0.1,-12],[13,0.2]]) {
  const L=Math.hypot(dx,dy), h=bearingToTarget(dx,dy), f=forward(h);
  check(`facing (${dx},${dy}) forward·dir==1`, approx(f.x*(dx/L)+f.y*(dy/L),1,1e-9));
}
function turnStep(heading, dx, dy){
  const d=normalizeAngle(bearingToTarget(dx,dy)-heading);
  if (Math.abs(d)<=0.05) return 0; return d>0?1:-1;
}
check("north facing, east target -> +1", turnStep(0,10,0)===1);
check("north facing, west target -> -1", turnStep(0,-10,0)===-1);
check("east facing, north target -> -1", turnStep(Math.PI/2,0,10)===-1);
check("aligned -> 0", turnStep(0,0,10)===0);
function simulateFace(h0,dx,dy,rate=0.15,maxIter=500){
  let h=h0;
  for(let i=0;i<maxIter;i++){ const s=turnStep(h,dx,dy); if(s===0)return h;
    const d=normalizeAngle(bearingToTarget(dx,dy)-h); h=normalizeAngle(h+s*Math.min(rate,Math.abs(d))); }
  return h;
}
for (const [dx,dy] of [[10,0],[-10,0],[3,-8],[-6,-2],[9,5]]) {
  const hf=simulateFace(1.3,dx,dy), f=forward(hf), L=Math.hypot(dx,dy);
  check(`converge faces (${dx},${dy})`, f.x*(dx/L)+f.y*(dy/L) > Math.cos(0.06));
}
function refaceNeeded(heading,dx,dy,thr){ return Math.abs(normalizeAngle(bearingToTarget(dx,dy)-heading))>thr; }
const THR=5*Math.PI/180;
check("reface fires when target strafed 90deg", refaceNeeded(0,10,0.5,THR)===true);
check("no reface within tolerance", refaceNeeded(0,0.05,10,THR)===false);
console.log(`\nWS06 cast-facing: ${pass} passed, ${fail} failed`);
process.exit(fail===0?0:1);
```

### 4.2 TODO-FOR-LAPTOP — headless / live capture recipe
- **Serve:** `python3 external/holtburger/scripts/serve.py` → `:8765`.
- **Bot URL (baseline, castReface OFF):**
  `http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&renderOnDemand=1&netDrainHz=30&autoLogin=1&account=X&password=X&autoSpawn=first&kickDance=1&agent=1`
- **A) Confirm the caster's own TurnTo arrives (wire truth):** in the JS console, tap the
  wire summary while casting a multi-windup war bolt at a moving target:
  `window.__diag.wire.summary()` — look for `UpdateMotion (0xF74C)` frames addressed to
  the **local guid** during the windup (ACE `Rotate()`/`TurnToObject`). Cross-check the
  wasm surfaced it: instrument `loop.js _armTurn` (temp `console.log` on the local-guid
  branch it currently drops) to count dropped local KIND_TURNs per cast. **Expected:**
  ≥1 dropped local KIND_TURN when the target strafes mid-windup; 0 when it stands still.
- **B) Repro the mis-face:** spawn near a mob, arm a war bolt (LSD low-mana war I bolt;
  or Wedding Bliss 1708 = 3-windup for a long chain), `castTargetedSpell(guid, spellId)`,
  and **strafe the target 90° during the windup** (drive the mob or use a second client).
  Sample the local heading vs the target bearing right at gesture time:
  `em.getHeading(localGuid)` vs `atan2(dx,dy)` from `getLocalPlayerPose()` +
  `entityMap.get(target).root.position`. **Expected (OFF):** |Δ| grows to the strafe
  angle (caster frozen). **Expected (ON, `&castReface=on`):** |Δ| collapses toward 0 at
  the final gesture; the bolt visibly departs from the caster's front.
- **C) Flag-off parity:** with `?castReface=off` (or absent), assert byte-identical
  behavior to today (the hook is a single no-op call) — combat-bar arm bytes + cast wire
  packet unchanged.

---

## 5. EYE-TEST QUEUE (1070 GPU box — batched; do not run locally)

1. **`?castReface=on`** — multi-windup war bolt (or Wedding Bliss 1708) at a target that
   **strafes ~90° during the windup**. *Expected:* the caster smoothly re-faces the
   target right before the final blast; the bolt departs from the front, not the flank.
   *Watch for:* the turn edge triggering an FU-A control reclaim (`__cmdInterpReclaims`
   counter, `index.html:8131`) or a spurious cast-gesture cut. A/B vs `=off`.
2. **`?castReface=on` + held-strafe kite** — hold a strafe key while casting. *Expected:*
   **no** auto-re-face (kite preserved; `manualMovementHeld` short-circuit), and the
   held-strafe slide is unaffected (interaction with `?slideCast`).
3. **(Polish, separate change) turn-in-place LEG cycle for the local caster.** Today the
   re-face pivots with an idle pose (§1.2). Prototype: extend the DriveApplied consumer
   (`index.html:8137`) to unpack the turn axis and, on a turn-only drive
   (`fwd===0 && side===0 && turn!==0`), `em.setMotion(localGuid, TurnRight/TurnLeft, stance)`
   (player MT 0x09000001 has the cycles). *Expected:* legs shuffle during the turn.
   **Gate separately** (`?localTurnCycle`) — it changes *all* local turning, not just
   casts; do not fold into `castReface`.

---

## 6. RISKS + cross-workstream interactions

**Files this WS would touch** (for integration ordering):
- `scene3d/picking.js` — new `CAST_REFACE` const + `onBeforeCastGesture` hook in `doCast`.
- `scene3d/entities.js` — `playCastSequence` signature (+`opts`) + the pre-gesture hook.
- `docs/url-flags.md` — new `castReface` row + two stale-doc fixes (§3.5).
- (impl only) new `test_ws06_cast_facing.mjs`.

**Risks:**
- **R1 — mid-cast `setMovementInput` raising the autonomy latch.** The re-face drives the
  turn axis during the cast; a turn *edge* could trip the FU-A control reclaim
  (`index.html:8125-8136`, code61===2; foundation ADJ-15 Q3 open). Turn is **not** a
  forward edge, so the ForwardSlotEvicted anim-break (code61===1) won't fire — but this
  is exactly why `castReface` ships **default-OFF pending the eye-test**.
- **R2 — target-position freshness.** `turnToFaceThenAct` reads the live target position;
  if the target despawned mid-windup it stops cleanly (`entityAcPosition` null → `act()`).
  No crash path.
- **R3 — interaction with `entities.js` ownership.** `playCastSequence` lives in the
  Wave-18 VFX/cast region also touched by **WS02/WS05/WS08** (cast-chain pacing, fizzle,
  recast). My change is a *single additive hook* right before the existing
  `playGesture(seq.castGesture)` and a token guard — no reordering of the chain, no VFX
  change. Land after any structural cast-chain refactor to avoid a merge on the same lines.
- **R4 — `_armTurn` is shared with WS07 (remote caster turn).** I do **not** modify
  `_armTurn` (Approach B rejected). WS07 owns the remote-caster turn-in-place / heading
  path; my finding (§1.7) that remote casters already re-face off the server directive
  should be reconciled with WS07's remote-turn work.
- **R5 — doc drift (§3.5)** is cosmetic but touches `url-flags.md`, which many WS edit;
  make those two edits atomic with the row add to avoid churn.

**No interaction with:** the wasm/Rust movement crates (no rebuild), the projectile/
ballistic path (WS10 owns launch-time targeting; my §1.4 finding — velocity is
server-authored — is input for WS10, not changed here).

---

## VERDICT (WS06-verify)

**Verdict: CONFIRMED — apply: true. No hard blockers.** Adversarial re-verification on
2026-07-12 opened every cited file live, re-ran the greps/oracle, traced whole functions,
and cross-checked decomp ⇄ ACE ⇄ our code. The root cause is real, the mechanism explains
the symptom (no counter-example found), the three patch hunks apply exactly against the
current tree, the change is minimal / flag-gated default-OFF / byte-identical when off /
no ACE edit / no wasm rebuild, and the node test is real and passes 23/23.

### What I independently re-verified (all CONFIRMED)
- **Facing bearing math is correct (not a bug).** `picking.js:51-56` (`CAST_FACE_TARGET`
  default-ON), `:415-462` (`turnToFaceThenAct`: flag-off→act; `manualMovementHeld()`
  short-circuit :427-430; rAF loop `turnDelta = normalizeAngle(atan2(dx,dy) - heading)`
  :451; `FACE_TURN_TIMEOUT_MS=800` :31/:453; `setMovementInput(0,0,±1,false)` :458),
  `entityAcPosition` :126-131 + `playerWorldPose` :160-173 (both AC-world frame),
  `MISSILE_FACE_TARGET=true` :29. Compass convention `lib.rs:29002` verbatim
  (*"yaw=0 → +Y north; π/2 → +X east"*). Node test `23 passed, 0 failed` (re-ran on box).
  The `meleeFaceTarget` `atan2(-dx,dy)` (`entities.js:7839`, rig-quaternion frame) and the
  `camera.js` `-poseH` are different representations — correctly NOT treated as a sign bug.
- **ACE re-faces the caster and broadcasts it to the caster HIMSELF.** `Player_Magic.cs`:
  cast-start `Rotate(rotateTarget)` :166 (non-FastTick, ActionChain `AddDelaySeconds`) /
  `TurnTo_Magic(target)` :189 (FastTick); pre-gesture `DoCastSpell` "do second rotate"
  `if (checkAngle && !IsWithinAngle(target))` :762 → `Rotate(target)` :766 / `TurnTo_Magic`
  :776; `IsWithinAngle` vs `spellcast_max_angle` :717/:738; `DoWindup` re-face :206-217.
  `Creature_Navigation.cs` `Rotate` :142 → `TurnToObject` :148 → `EnqueueBroadcastMotion`
  :134. `WorldObject_Networking.cs` `EnqueueBroadcastMotion` :1306 → `EnqueueBroadcast` →
  `EnqueueBroadcast(bool sendSelf=true,…)` :1418 → **`if (sendSelf) self.Session.Network.
  EnqueueSend(msgs)` :1428-1431** (caster is a Player ⇒ receives its own TurnTo). Path
  selection: `Player_Tick.cs:154 FastTick => IsPKType`, `Player_Combat.cs:1023 IsPKType =>
  PK || PKLite` ⇒ non-PK vanilla uses the `Rotate()` broadcast. **Fully confirmed.**
- **Our wasm surfaces the caster's own TurnTo as a LOCAL KIND_TURN, and JS drops it.**
  `lib.rs` UpdateMotion recv arm fires for the local guid (comment cites `BroadcastMovement
  … EnqueueBroadcast(true,…) includes the originator`, ~:40866); the TurnToObject arm emits
  `kind:ENTITY_UPDATE_KIND_TURN, guid:u32::from(data.guid), qw:cos(h/2), qz:sin(h/2),
  omega_z:turn_speed` (~:41150). `loop.js:2632-2637 _armTurn`: *"Remote-only; the local
  player owns its own facing."* `if (!isLocalPlayerGuid(turnGuid) && … applyTurnDirective)`
  — self is dropped. (A second inline KIND_TURN site at loop.js:3000-3008 drops local too.)
- **Approach-B dead-end premise holds.** Local KIND_POSITION is skipped
  (`loop.js:2859 if (!isLocalPlayerGuid(g))`), and `applyLocalPlayerPoseFromIntegrator`
  (`loop.js:718`, called every rAF at :2009) rewrites the local rig via `setPose(...)` from
  the integrator (`rust_pose.js:79-88` yaw-only `qw=cos(h/2), qz=sin(h/2)`). The remote
  heading slerp (`entities.js:11875-11900`) is inert for local (no `_serverTargetQuat`
  armed). ⇒ `setMovementInput` is the only lever — the fix's choice is right.
- **RC-2 (no turn-in-place leg cycle).** DriveApplied consumer `index.html:8137-8173`
  unpacks only `fwd`(bits0-7)/`side`(8-15)/`run`(24-31) from `u32Payload2`; the turn axis
  (bits 16-23) is never read, and a turn-only drive (`fwd===0`) → `forwardCmd=0x41000003`
  (Ready idle, :8156). Confirmed cosmetic; correctly gated separately (§5.3).
- **DAT ground truth (WB.Terminal oracle, player MT 0x09000001).** **366 cycles / 318
  links** — matches §1.8 exactly. Magic-stance (0x49) outer link keys present include
  `0x49002b` (MagicBlast final gesture), `0x490003` (Ready), `0x490005/0x490007`
  (walk/run), `0x4900e0/0x4900e1`, and the `0x49002c-0x490031`+`0x490032-0x490039` gesture
  band. ⇒ the final blast gesture IS linkable in Magic stance; facing is orthogonal to
  gesture playback, as claimed.
- **Patch applies + conventions.** Hunk §3.1 context (`CAST_FACE_TARGET` IIFE :51-56),
  §3.2 (`async playCastSequence(guid, spellId)` :6728 + `if (seq.castGesture){ await
  playGesture(seq.castGesture); }` :6829-6831), §3.3 (`em.playCastSequence(localGuid,
  spellId)` at :694, exact surrounding context) all match the live tree verbatim. Both
  real `playCastSequence` callers pass no `opts` (`picking.js:694`, `plugins/api.js:486`)
  ⇒ backward-compat / flag-off byte-identical is correct. `guid`, `turnToFaceThenAct`,
  `CAST_REFACE` are all in the click-handler lexical scope. No wasm rebuild.
- **Doc-drift §3.5 both real.** `url-flags.md:270` `castFaceTarget` row still reads
  *"Default-off, pending 1070 eye-test"* while `:12` (Now-default-ON list) and the code
  say ON; `loop.js` `castAxes` comment (~:392) says *"default OFF"* while its reader
  (`CAST_AXES_ON`, `!== "off"`) defaults ON and it's in the `:12` list. Correct to fix.

### Non-blocking observations (recommend, do NOT gate apply)
1. **Concurrent vs delayed gesture.** ACE's non-FastTick path DELAYS the cast gesture
   until the rotate completes (`ActionChain.AddDelaySeconds(rotateTime)`,
   `Player_Magic.cs:168-169`); the fix runs the re-face fire-and-forget *concurrent* with
   the final gesture. That is closer to the FastTick `TurnTo_Magic` shape than to the
   non-PK path our vanilla server actually uses. Cosmetically fine for a client visual
   (caster pivots while blasting), but the eye-test (queue #1) should confirm it reads
   right and doesn't look like the blast fires before the turn settles.
2. **Re-face turn loop outlives a mid-gesture fizzle.** Once `onBeforeCastGesture` launches
   the `turnToFaceThenAct` rAF loop, that loop has no `_castSequenceToken` / abort check of
   its own — it keeps driving `setMovementInput` turn until aligned or the 800 ms timeout
   even if `cancelCastSequence` bumps the token during the final gesture (fizzle/recast).
   Benign (bounded ≤800 ms, still faces the intended target) and only when `castReface=on`,
   but consider passing the token/an abort predicate into the `step()` guard for tidiness.
   OPTIONAL.
3. **Scope: click-to-cast only.** `plugins/api.js:486` and the hotbar bridge pass no
   `opts`, so hotbar/plugin casts get no re-face. Acknowledged by the packet; acceptable
   for an improvement pass, but worth stating in the url-flags row that the re-face is
   click-path only.
4. **Minor cite drift (cosmetic).** `WorldObject_Networking.cs` overload cites are ~2-3
   lines low (params overload actually :1418, sendSelf :1428-1431 vs the packet's
   :1413-1416 / :1428-1432); `loop.js` castAxes reader is at ~:401-411 not :399-408. All
   symbols resolve; no impact on the argument.
5. **Symptom linkage.** "Bolt launches sideways" is the charter's facing-correctness
   framing, not one of the user's three verbatim symptoms — it is legitimately in WS06's
   scope, just note it's an inferred sub-symptom, not a directly-reported one.

### Regression / cross-WS check
Flag-off (`castReface` absent/`=off`) reduces the whole change to one no-op call
(`turnToFaceThenAct(...,false)` → `if(!enabled){act();return;}`) ⇒ castMove/slideCast/
cmdInterp and the combat-bar arm bytes are untouched. `_armTurn` is NOT modified (Approach
B correctly rejected — reconcile the §1.7 remote-re-face finding with WS07). The
`playCastSequence` edit is a single additive, token-guarded hook + optional `opts` param;
land it after any structural cast-chain refactor by WS02/WS05/WS08. Make the two §3.5
doc fixes atomic with the row add (WS05/WS07 also touch url-flags.md).

```json
{"workstream":"WS06","verdict":"CONFIRMED","apply":true,"mustFix":[],"notes":"All load-bearing claims re-verified live: facing math correct (23/23 node test re-run); ACE Rotate/TurnTo_Magic broadcasts TurnToObject to the caster himself (WorldObject_Networking.cs:1428 sendSelf, non-PK vanilla path via FastTick=>IsPKType); wasm emits local KIND_TURN (lib.rs:~41150) which loop.js:2634 _armTurn drops (remote-only); local rig is integrator-owned (applyLocalPlayerPoseFromIntegrator every rAF) so Approach B is correctly rejected; DAT oracle confirms 366 cycles/318 links with magic-stance 0x49002b/0x490003 present. All 3 patch hunks apply exactly against the current tree; default-OFF castReface makes flag-off byte-identical; no wasm rebuild; both doc-drift claims (url-flags.md:270, loop.js castAxes comment) are real. Non-blocking: (1) fire-and-forget re-face is concurrent with the final gesture vs ACE's delay-then-gesture on the non-PK path; (2) the turn rAF loop has no token/abort guard so it outlives a mid-gesture fizzle (bounded 800ms, benign) - consider threading the token in; (3) re-face is click-path only (plugin/hotbar pass no opts); (4) minor +2-3 line cite drift on a few ACE overloads. Land after WS02/WS05/WS08 cast-chain work; reconcile the remote-re-face finding with WS07; keep the _armTurn guard (no edit)."}
```

---

```json
{"workstream":"WS06","title":"Turn-to-face correctness for casts","packetPath":"/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/docs/spellcasting-packets-2026-07-12/WS06-facing-and-turn.md","confidence":"high","keyFindings":["Local caster faces correctly at cast-SEND (bearing atan2(dx,dy) is right for the compass heading convention lib.rs:29002; 23/23 node tests pass) but NEVER re-faces during the windup chain","Vanilla ACE re-rotates the caster before the final cast gesture (Player_Magic.cs:762 Rotate/TurnTo_Magic) and broadcasts TurnToObject to the caster HIMSELF (EnqueueBroadcast sendSelf, WorldObject_Networking.cs:1428); FastTick=>IsPKType so non-PK vanilla uses the retail Rotate() path","Our wasm surfaces the caster's own TurnTo as KIND_TURN for the local guid (lib.rs:41161), but loop.js _armTurn:2634 DROPS it (remote-only) and the local rig heading is integrator-owned so a server heading cannot drive it","Projectile trajectory is server-authored (ObjectCreate velocity, entities.js:4019) so bolts always fly at the target; 'bolt sideways' is a cosmetic stale-caster-heading artifact","Remote casters already re-face correctly off the server KIND_TURN (meleeFaceTarget excludes casts by design, entities.js:7832) — they do NOT cast at empty air","Local face-turn plays NO turn-in-place leg cycle: DriveApplied consumer never unpacks the turn axis (index.html:8137), idles the base clip on a turn-only drive"],"filesToChange":["scene3d/picking.js","scene3d/entities.js","docs/url-flags.md"],"needsWasmRebuild":false,"newFlags":["castReface"],"risks":["mid-cast setMovementInput turn edge could trip an FU-A control reclaim (ADJ-15 Q3) — hence default-OFF + eye-test","playCastSequence is shared with WS02/WS05/WS08 cast-chain work — land the additive hook after any structural refactor","_armTurn is shared with WS07 remote-caster turn — Approach B (apply server KIND_TURN to local) rejected, no _armTurn edit; reconcile remote re-face finding with WS07","turn-in-place leg-cycle polish must gate separately (changes all local turning, not just casts)"]}
```

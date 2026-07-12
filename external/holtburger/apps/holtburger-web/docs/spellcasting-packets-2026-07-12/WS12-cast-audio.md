# WS12 — Casting audio (windup / cast / fizzle / launch / impact)

**Scope:** own the cast soundscape. Verify the gesture anims' authored sound hooks
actually FIRE for one-shot cast overlays (windup hum/chant, final gesture, fizzle,
projectile launch/impact), including `timeScale>1` (CAST_SPEED 2×), and local-vs-remote
symmetry. Verify `soundTableDid` plumbing for player rigs.

**Baseline:** `external/holtburger` (read-only), files opened live 2026-07-12. DAT ground
truth via the `dat-tool` binary + WB.Terminal oracle against
`~/ac_base_dats/client_portal.dat`. Decomp `~/ac-headers/acclient.{c,h}`. ACE reference
`external/ACE/Source`.

**Bottom line (confidence HIGH):** The **windup hum DOES fire** and is retail-faithful —
proven end-to-end from DAT raw bytes → wasm decode → JS drain → `audioManager.play`. It is
a `SoundTweaked` (hookType 21) hook playing wave **`0x0A000390`** with `prob=1.0` (always)
and a **building volume ramp 0.2→0.6**, and it does **not** depend on `soundTableDid`. The
**final cast gesture anims carry NO sound hooks** — the "release" sound is by design
PScript-driven (CasterEffect / projectile), owned by WS08/WS09/WS10. **Fizzle** is a
**0xF755 PlayScript** (not 0xF750 Sound). The only genuine in-domain WS12 gaps are small:
(a) a mid-cast fizzle/interrupt lets the current windup's trailing hum hooks keep firing
(overlay isn't stopped); (b) a latent double-hum under the non-default `?castSpeed=off`;
(c) the animation `SoundTable(2)` executor lacks the local-player fallback its two siblings
already have. Concrete minimal, reversible diffs below.

---

## 0. How the cast soundscape is wired (verified map)

| Sound | Wire / source | Fires via | Needs `soundTableDid`? | Owner |
|---|---|---|---|---|
| **Windup hum/chant** | Anim `SoundTweaked`(21) hook on MagicPowerUp anim, wave `0x0A000390` | `entities.js` `_tickAnimationHooks`→`_fireHook` type 21 | **No** (inline wave DID) | **WS12** ✅ works |
| **Final cast gesture** | *nothing baked in the gesture anim* | — | — | by design silent |
| **Cast "release"/glow** | Spell `CasterEffect` PScript (0xF755, only 74/6266 spells) | `playEffect`→`play_effect_vfx.js` PScript Sound hooks | No (PScript wave DIDs) | WS08/WS09 |
| **Fizzle** | `GameMessageScript(caster, PlayScript.Fizzle, 0.5)` = **0xF755** | `index.html:7373`→`playEffect`→PScript Sound hooks | No | WS08 (+WS12 cancel) |
| **Projectile launch whoosh** | projectile `DefaultScript`/creation PScript on the missile entity | spawn PScript chain | No (PScript) | WS10 |
| **Projectile impact** | `GameMessageSound(projectile, Sound.Collision, 1.0)` = **0xF750** | `index.html:8253` GMS drain → `resolveSound(projectile.soundTableDid, …)` | **Yes (projectile's)** | WS10 |
| **Resist** | `GameMessageSound(target, Sound.ResistSpell, 1.0)` = **0xF750** | GMS drain → `resolveSound(target.soundTableDid, …)` | **Yes (target's)** | WS14/WS08 |

The distinction that matters for WS12: **`Sound`(1) and `SoundTweaked`(21) hooks carry an
inline Wave DID** and play directly; **`SoundTable`(2) hooks carry a Sound *enum*** resolved
through the entity's SoundTable. The magic gesture anims use only `SoundTweaked` → the
windup hum is independent of `soundTableDid`.

---

## 1. VERIFIED FINDINGS (evidence: file:line + quote / DAT bytes)

### F1 — The windup hum is a `SoundTweaked` hook, wave `0x0A000390`, prob 1.0, building volume (DAT-proven)

Player MotionTable `0x09000001`, links outer key **`0x490003`** decodes to **(Magic stance
`0x49`, Ready substate `0x03`)** — the magic-gesture bucket (confirms foundation §1.3
`links[(stance,Ready)][fullCmd]`). Its inner keys and target anims (DAT oracle
`motion-table-anim-hooks` + manual key-decode):

- Windups `0x1000006F..0x10000078` (MagicPowerUp01-10) → **all → anim `0x030005A0`** (fr 24)
- Colored windups `0x1000012B..0x10000134` (Purple/void band) → **all → anim `0x03000848`** (fr 24)
- Final cast gestures `0x4000002B..0x40000038` → anims `0x0300059B`, `..59A`, `..596`, …

Raw bytes of anim `0x030005A0` (via `dat-tool export … 0x030005A0`, 58 600 B, `flags=2,
num_parts=34, num_frames=60` = **2.5 s @ 24 fps**), per-frame hook parse:

```
frame  0  SoundTweaked  gid 0x0A000390  [off4=1.0  off8=0.9  off12=0.2]
frame 15  SoundTweaked  gid 0x0A000390  [off4=1.0  off8=0.9  off12=0.3]
frame 30  SoundTweaked  gid 0x0A000390  [off4=1.0  off8=0.9  off12=0.4]
frame 53  SoundTweaked  gid 0x0A000390  [off4=1.0  off8=0.9  off12=0.5]
frame 57  SoundTweaked  gid 0x0A000390  [off4=1.0  off8=0.9  off12=0.6]
```

Anim `0x03000848` (void/colored) is **byte-identical in hook layout** (same wave, same
ramp). On-disk field order is `[gid@0, prob@4, prio@8, vol@12]`:

- **prob = off4 = 1.0** → the hum *always* plays (no probability roll).
- **prio = off8 = 0.9** — corroborated by the decomp default: `SoundTweakedHook` ctor sets
  `LODWORD(this->prio) = 1063675494` = `0x3F666666` = **0.9** and `prob = 0x3F800000` = 1.0
  (`acclient.c:342198-342203`). off8=0.9 == default prio ⇒ field order confirmed.
- **vol = off12 = 0.2→0.6** (building) — the iconic AC power-up crescendo.

Decomp semantics: `struct SoundTweakedHook : CAnimHook { IDClass gid_; float prio; float
prob; float vol; }` (`acclient.h:57422-57428`); `SoundTweakedHook::Execute →
SoundManager::PlaySoundA(this->gid_, physobj, this->prio, this->prob, this->vol)`
(`acclient.c:342207-342210`). `gid_` is a **Wave DID played directly** (vs `SoundTableHook`
whose `sound_type_` is an enum resolved through the object's sound table,
`acclient.c:342219`). Wave `0x0A000390` is a valid Wave record (verified present).

### F2 — The final cast gesture anims carry NO sound hooks (DAT-proven)

Final-gesture anims `0x0300059B` (0x4000002B), `0x0300059A`, `0x03000596` (0x40000038) carry
**only** `CreateParticle`(13) + `StopParticle`(15) — zero `Sound`/`SoundTweaked`/`SoundTable`.
Confirmed by both the per-frame oracle dump and the whole-MT census: of 767 hooks in
`0x09000001`, the 24 `SoundTweaked` all sit on windup-class anims (`0x030005A0`, `0x03000848`,
`0x0300078E`, `0x030008DC/9BF/9C0`), none on the `0x40`-class cast gestures; the 2 plain
`Sound` hooks are on `0x03000C21/C22` (non-magic). ⇒ **there is no "final gesture sound" at
the anim-hook layer, by design.** The audible release is the CasterEffect/projectile PScript.

### F3 — `_fireHook` correctly handles the `SoundTweaked`(21) path (code + decomp match)

`entities.js:12962-13027`: reads `hook.soundWaveId` (Wave DID), rolls
`soundProbability` (`probability >= 1.0` short-circuits — so prob=1.0 always fires),
uses `soundVolume` as gain (so the 0.2→0.6 ramp is honored), records `soundPriority`
(unused — our HRTF mixer has no priority bus), and plays with `followGuid: inst.guid` so
the panner tracks the caster. Wasm getters `AnimationHookJs::{sound_wave_id@0,
sound_probability@4, sound_priority@8, sound_volume@12}` (`lib.rs:18661-18731`) match the
on-disk layout in F1. The A-DIR gate `if ((hook.direction|0) === -1) return;`
(`entities.js:12717`) drops only Backward hooks; the windup hooks are all `direction=1`
(Forward, verified in raw bytes) → they pass.

### F4 — The overlay drain fires the hum at the right clip-relative moments under CAST_SPEED (code + timing proof)

`setSwingMotion` (`entities.js:7138-7342`) stashes the timeline and seeds the epoch:

```js
7228  if (Array.isArray(entry.hooks) && entry.hooks.length > 0) {
7229    inst.hookTimelines.set(swingKey, entry.hooks);
7231  inst.actionLastHookTime.set(swingKey, -1);
```

and plays the LoopOnce overlay at
`timeScale = (clip.duration / dur) * swingSpeed`, `swingSpeed = motionSpeed * opts.speed`
where `opts.speed = CAST_SPEED` (`:7243-7249`, `:6811`). Because three.js `action.time` is
**clip-local** and the baked `hook.time = timeInClipS` (`animation.js:804`) is in the same
clip domain, hooks fire when `action.time` crosses them regardless of `timeScale` — under
CAST_SPEED=2 they fire at the correct clip fractions, compressed into wall time. The
`-1` seed makes the frame-0 hook fire (`_fireHooksInRange` uses `t <= lowExclusive`, so
`0 > -1`; `:12662`). `_tickAnimationHooks` (`:12542-12643`) walks **every** action incl.
overlays; `HOOK_DRAIN_ON` (default-ON, see F6) adds the **finish-drain** so the trailing
frame-53/57 hooks still fire if the LoopOnce ends between two rAFs (`planHookWindows` →
`hook_windows.js:62-71`). Elegant consequence: overlay wall-duration = `dur/swingSpeed`
matches the chain's per-gesture sleep `durationS/CAST_SPEED` (`:6816`), so consecutive
windups' hums don't pile up. **My headless test reproduces all of this against the real
planner — 7/7 pass (see §4).**

### F5 — Local ↔ remote symmetry holds

- **Local caster:** prediction path `playCastSequence`→`setSwingMotion` plays the overlay
  and stashes hooks (F4). The matching server echo is deduped (`noteLocalSwingPrediction`
  `:6812` under `dispatchParity`) so the hum isn't double-played.
- **Remote caster:** gesture arrives as KIND_MOTION_ACTION (kind=8) →
  `loop.js:_armMotionAction` → `em.setMotion` → `_tryPlayLink`, which stashes the SAME
  hooks and seeds the SAME `-1` epoch (`entities.js:9708-9711`) and drains through the SAME
  `_tickAnimationHooks`. ⇒ remote casters' windup hums fire identically. The dead
  `setCastPose` branch (foundation §1.5) does not affect audio.

### F6 — Relevant flags are default-ON (the inline "default OFF" comments are stale)

`url-flags.md:12` "Now default-ON" list + rows confirm: `castSpeed`(→2.0),
`castStateMachine`, `castFizzle`, `castAxes`, `dispatchParity`, `hookDrain`(:561),
`scriptQueue`(:560). The code predicate `get("hookDrain")?.toLowerCase() !== "off"`
(`entities.js:1160-1162`) and `CAST_SPEED = …?.toLowerCase() !== "off" ? 2.0 : 1.0`
(`:903-907`) both default truthy; the introduction-era `// Default OFF` comments at
`:896`, `:913`, `:1141` are historical and were flipped after their eye-tests. Foundation
§1.2 independently states CAST_SPEED default = 2.0. **So the drain runs with `hookDrain`
finish-drain ON by default — the windup hum's trailing hooks are covered by default.**

### F7 — Player-rig `soundTableDid` plumbing (verified; not needed for the hum)

`inst.soundTableDid = (meta.soundTableDid ?? 0) >>> 0` (`entities.js:3851`), fed from the
wire `EntityUpdate.soundTableDid` = `PropertyDataId::SoundTable`. The wasm resolver
`resolve_sound_table_did(stable_id, setup_id)` (`lib.rs:27351-27388`) implements retail's
two-source chain (wire STABLE else Setup `default_sound_table`). The main ObjectCreate
KIND_SPAWN path (`lib.rs:39697` handler, `:40133-40156`) applies a **local-player humanoid
fallback**: `if stb == 0 && is_local_player { DEFAULT_HUMANOID_SOUND_TABLE (0x2000_0001) }`.
Belt-and-suspenders on the JS side: `index.html:8312-8318` sets
`inst.soundTableDid = 0x20000001` for the local player on the first 0xF750 GMSound. So the
**local player gets a working sound table**. Remote players keep whatever the wire/Setup
provides (often 0 for character composites). **Note:** the magic gesture anims carry no
`SoundTable(2)` hooks (F2), so the windup hum is unaffected by any of this — it plays even
when `soundTableDid == 0`.

### F8 — Fizzle is a 0xF755 PlayScript, not a 0xF750 Sound (ACE-proven)

`Player_Magic.cs:879` and `:917`: `EnqueueBroadcast(new GameMessageScript(Guid,
PlayScript.Fizzle, 0.5f));` (+ `SendWeenieError(WeenieError.YourSpellFizzled)`). So the
fizzle "phbbt" rides the **Fizzle PScript's own Sound hooks** resolved through the caster's
PhysicsScriptTable — the same 0xF755 → `playEffect` → `play_effect_vfx.js` path
(`index.html:7373-7391`), **owned by WS08/WS09**. The charter's "0xF750 Sound event" guess
is **incorrect** for fizzle. (0xF750 GMSound *is* used for Resist and projectile Collision.)

### F9 — Audio is gated on a user gesture

`AudioManager` defers AudioContext creation until `notifyUserGesture()`; `play()` is a
no-op before then (`audio_manager.js:16-20`). Real players unlock on the login click;
**headless bots must trigger a gesture** or all cast audio (incl. the hum) is silent. The
manager + `soundTableCache` are attached by default (`index.js:4417-4424, 4795-4802`).

---

## 2. ROOT CAUSES (per symptom in charter)

**RC1 — "Do the windup hum/chant sounds fire?" → YES, proven.** Mechanism: `SoundTweaked`
wave `0x0A000390` at 5 windup frames, prob 1.0, drained through `_fireHook` type 21 under
the default `hookDrain`+`castSpeed` flags. No `soundTableDid` dependency. Not a bug. (F1,
F3, F4, §4 test.)

**RC2 — "Final gesture sound?" → none at the anim layer, by design.** The `0x40`-class
cast gesture anims have zero sound hooks (F2). The release soundscape is
CasterEffect/projectile PScript-driven — but `casterEffect` is set for only **74 / 6266**
spells (`spell-cast-sequence.json:_caster_effect_count`), so most war/void bolts have **no
caster-side release sound** and rely entirely on the **projectile** (launch whoosh + impact
Collision) owned by WS10. This is authentic — verify the projectile side is loud enough
(WS10), don't invent a caster-side release.

**RC3 — Fizzle interrupt leaves the hum ringing (real, minor, in-domain).**
`cancelCastSequence` (`entities.js:6927-6939`) bumps `_castSequenceToken` and recoils via
`setMotion(Ready)` but **does not stop the currently-playing windup overlay action**. That
LoopOnce action stays in `inst.actions` and keeps `isRunning()`, so `_tickAnimationHooks`
keeps draining its remaining `SoundTweaked` hooks — and the `hookDrain` finish-drain even
fires the trailing frame-53/57 hooks as it clamps. Net: on a mid-windup fizzle you briefly
hear the hum finish its 0.2→0.6 ramp *after* the cast was cancelled, whereas retail cuts the
spliced gesture clean. Audible artifact, low severity (hum is quiet, overlay clamps fast at
2× under CAST_SPEED).

**RC4 — Double windup-hum under `?castSpeed=off` (real, non-default).**
`noteLocalSwingPrediction` is gated on `CAST_SPEED !== 1.0` (`entities.js:6812`). Under
`?castSpeed=off` (CAST_SPEED=1.0) the local prediction overlay plays (F4) AND the server
echo is *not* deduped → `_tryPlayLink` plays a SECOND windup overlay → **two overlapping
`SoundTweaked` streams = double hum** (and a double gesture). Only under the non-default
flag; cross-cuts WS06/dispatch, flagged there.

**RC5 — Player `SoundTable(2)` anim-hook path lacks the local-player fallback (latent).**
`_fireHook` type 2 (`entities.js:12766-12772`) reads `inst.soundTableDid`, and on `== 0`
silently no-ops — unlike the 0xF750 GMSound drain (`index.html:8312`) and the wasm spawn
(`lib.rs:40151`) which both backfill the local player to `0x20000001`. If the deployed
`pkg/` predates the 2026-06-09 wasm fallback, a player anim carrying a `SoundTable(2)` hook
(emotes etc.) is silent until the first GMSound. **Does NOT affect cast audio** (magic
gestures have no type-2 hooks) but it is exactly the "verify soundTableDid plumbing for
player entities" gap the charter names.

---

## 3. PATCH PLAN (minimal, reversible; per foundation §4 conventions)

> All diffs touch **`scene3d/entities.js`** only. None require a wasm rebuild. Nothing here
> changes the default hum behavior except P2 (zero-risk audio backfill, ships default-ON per
> the HUD-fixes convention). P1 is a feel change → flag default-OFF pending a 1070 eye-test.

### P1 — Stop the in-flight cast overlay on cancel so the hum cuts on fizzle/interrupt (flag `?castCancelStops`, default OFF)

Fixes RC3. Reuses the existing overlay-stop primitive shape (`_cancelOneShotOverlays`
`entities.js:10044`, but that one is `MT_QUEUE_ON`-gated and success=false-notifies for the
teleport path — we want an unconditional stop of the cast/swing overlays only).

```js
// entities.js — cancelCastSequence (current, :6927-6939)
  cancelCastSequence(guid) {
    const inst = this.entityMap.get(guid >>> 0);
    if (!inst) return false;
    inst._castSequenceToken = ((inst._castSequenceToken | 0) + 1) | 0;
    inst._castBusyUntilMs = 0; // F8-4 — cancelled cast frees the busy window
+   // WS12 (?castCancelStops, default OFF): retail REPLACES the spliced gesture
+   // on interrupt; our overlay otherwise keeps running and its trailing
+   // SoundTweaked windup-hum hooks (0x0A000390, frames 53/57) fire AFTER the
+   // fizzle. Stop the running cast/swing LoopOnce overlays so their hooks stop
+   // draining. The base-cycle weight restore rides _completeOverlay (same as
+   // the finished-listener / hookDrain path). Visual: the overlay clamp is
+   // replaced by an immediate cut to the Ready recoil below — matches retail.
+   if (CAST_CANCEL_STOPS && inst.actions && inst.mixer) {
+     for (const [key, action] of inst.actions) {
+       if (!action || action.loop !== THREE.LoopOnce) continue;
+       if (typeof action.isRunning === "function" && !action.isRunning()) continue;
+       if (!(key.startsWith("swing:") || key.startsWith("link:"))) continue; // cast/attack overlays only
+       try { this._completeOverlay(inst, key, action, false); action.stop(); } catch (_) {}
+     }
+   }
    try {
      const stance = ((inst.currentStance ?? inst.lastStance ??
        ...
```

New flag constant (near the other cast flags, ~`entities.js:920`):

```js
// WS12 (2026-07-12) — ?castCancelStops (default OFF): on cancelCastSequence
// (fizzle 0x0402 / UseDone / recast preempt), STOP the running cast/swing
// overlay so its trailing windup-hum SoundTweaked hooks don't fire after the
// cancel (retail replaces the spliced gesture; acclient.c GetObjectSequence
// remove_cyclic_anims). Default OFF — feel/visual change (overlay cut) →
// 1070 eye-test. Audio-only variant: instead of action.stop(), just
// `inst.hookTimelines.delete(key)` (mutes trailing hooks, leaves the clamp).
const CAST_CANCEL_STOPS = (() => {
  try {
    return typeof window !== "undefined" && window.location &&
      new URLSearchParams(window.location.search).get("castCancelStops")?.toLowerCase() === "on";
  } catch (_) { return false; }
})();
```

**`url-flags.md` row (drafted):**

| `castCancelStops` | `on` | off | WS12: on cancelCastSequence (fizzle 0x0402 / UseDone / recast), stop the running cast/swing LoopOnce overlay so its trailing windup-hum SoundTweaked hooks (wave 0x0A000390) don't keep firing after the cast was cancelled — matches retail's gesture replace. Feel/visual change (overlay cut vs clamp). Pending 1070 eye-test. | scene3d/entities.js |

*Note:* if the eye-test dislikes the visual cut, ship the **audio-only variant** (replace
`action.stop()` with `inst.hookTimelines.delete(key)`) which mutes the trailing hum but
leaves the visual clamp untouched — that variant is zero-visual-risk and could ship
default-ON.

### P2 — Local-player humanoid SoundTable fallback in the anim-hook `SoundTable(2)` executor (zero-risk, audio-only, default-ON)

Fixes RC5; closes the one anim-hook path that lacks the fallback its two siblings already
have (`index.html:8312`, `lib.rs:40151`). Not cast-critical, but it is the charter's
explicit "verify/fix player soundTableDid plumbing" ask, and it is genuinely zero-risk
(only converts a *silent no-op* into a play for the local player, never changes a
non-zero table).

```js
// entities.js — _fireHook, hookType === 2 (current, :12766-12773)
    if (hookType === 2) {
      const soundEnum = hook.soundEnum >>> 0;
      if (soundEnum === 0 || !cache || !audioMgr) return;
-     const stbDid = inst.soundTableDid >>> 0;
+     let stbDid = inst.soundTableDid >>> 0;
+     // WS12 (2026-07-12): mirror the 0xF750 GMSound + wasm-spawn local-player
+     // fallback (index.html:8312 / lib.rs:40151) — the local player's Setup is
+     // a clothing composite that often omits default_sound_table, so a stale
+     // pkg (or a spawn path that seeds 0) leaves player SoundTable(2) anim
+     // hooks silent. Backfill to the canonical humanoid table for the LOCAL
+     // player only; remote entities keep 0 = genuinely no SoundTable.
+     if (stbDid === 0) {
+       const lpg = (typeof window !== "undefined" && typeof window.getLocalPlayerGuid === "function")
+         ? (window.getLocalPlayerGuid() >>> 0) : 0;
+       if (lpg && (inst.guid >>> 0) === lpg) {
+         inst.soundTableDid = 0x20000001;
+         stbDid = 0x20000001;
+       }
+     }
      if (stbDid === 0) {
        // No SoundTable on this entity's weenie. Silent no-op — normal.
        return;
      }
```

No new flag (zero-risk audio backfill = HUD/UI-fix convention, ships default-ON). No
`url-flags.md` row required; add a one-line note to `docs/audio-*` if a changelog is kept.

### P3 — (coordination only, no WS12 code) Double-hum under `?castSpeed=off`

RC4 is a dispatch/echo-dedup issue (WS06). Recommended there: call
`noteLocalSwingPrediction(motionU32)` **unconditionally** in `playCastSequence.playGesture`
(drop the `CAST_SPEED !== 1.0` guard at `entities.js:6812`), so the echo is deduped at 1×
too. Flag under the existing `dispatchParity`. WS12 flags the audio symptom; WS06 owns the
fix.

---

## 4. TESTS

### 4.1 Headless unit test (proposed new file `test_cast_audio_hooks.mjs`) — VALIDATED PASSING

Pure-JS, imports the **real** `scene3d/hook_windows.js` planner, replicates the
`_fireHooksInRange` range-walk + `_fireHook` type-21 A-DIR/prob gate, and simulates the
LoopOnce overlay drain at CAST_SPEED. I ran it against the live planner on this box:
**7/7 pass.**

```
WS12 cast-audio windup-hum drain (headless)
  [OK] CAST_SPEED=2: all 5 hum hooks fire exactly once — fired=5
  [OK] CAST_SPEED=2: waves are all 0x0A000390
  [OK] CAST_SPEED=2: volume ramp preserved 0.2..0.6 in order
  [OK] frame-0 hum fires (lastTime=-1 seed)
  [OK] timeScale=5 (compressed windup): all 5 fire once — fired=5
  [OK] 30fps drain: trailing (2.208s, 2.375s) hooks still fire — fired=5
  [OK] no double-fire across fine 90fps ticks — times=5

7 passed, 0 failed
```

Full source (to be created at `apps/holtburger-web/test_cast_audio_hooks.mjs` on the laptop;
change the import to the repo-relative `"./scene3d/hook_windows.js"`):

```js
// WS12 — headless verification that the windup-hum SoundTweaked hooks drain
// exactly once each across a simulated cast overlay at CAST_SPEED=2, using the
// REAL pure planner (scene3d/hook_windows.js). No THREE / no wasm / no browser.
// Ground truth (DAT raw bytes, anim 0x030005A0 @ 24fps, 60f=2.5s clip):
//   SoundTweaked wave 0x0A000390 @ frames 0/15/30/53/57, [gid, prob=1.0, prio=0.9, vol 0.2..0.6]
import { planHookWindows } from "./scene3d/hook_windows.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? (passed += 1) : (failed += 1);
}
const HUM = [
  { time: 0/24,  hookType:21, direction:1, soundProbability:1.0, soundVolume:0.2, soundWaveId:0x0a000390 },
  { time: 15/24, hookType:21, direction:1, soundProbability:1.0, soundVolume:0.3, soundWaveId:0x0a000390 },
  { time: 30/24, hookType:21, direction:1, soundProbability:1.0, soundVolume:0.4, soundWaveId:0x0a000390 },
  { time: 53/24, hookType:21, direction:1, soundProbability:1.0, soundVolume:0.5, soundWaveId:0x0a000390 },
  { time: 57/24, hookType:21, direction:1, soundProbability:1.0, soundVolume:0.6, soundWaveId:0x0a000390 },
];
const CLIP = 60/24;
function fireRange(tl, low, high, fired, rng) {
  for (const h of tl) {
    if (h.time <= low) continue;
    if (h.time > high) break;
    if ((h.direction|0) === -1) continue;               // A-DIR
    if (!(h.soundProbability >= 1.0 || rng() < h.soundProbability)) continue;
    fired.push(h);
  }
}
function simulateOverlay(timeScale, dtWall, rng = () => 0) {
  let lastTime = -1, actionTime = 0, running = true; const fired = []; let g = 0;
  while (g++ < 100000) {
    actionTime = Math.min(CLIP, actionTime + dtWall * timeScale);
    running = actionTime < CLIP;
    const plan = planHookWindows({ lastTime, currentTime: actionTime, clipDuration: CLIP, isRunning: running, isLoopOnce: true });
    for (const w of plan.windows) fireRange(HUM, w[0], w[1], fired, rng);
    if (running) lastTime = actionTime; else if (plan.drainedTo !== null) lastTime = plan.drainedTo;
    if (!running) break;
  }
  return fired;
}
console.log("WS12 cast-audio windup-hum drain (headless)");
{ const f = simulateOverlay(2.0, 1/60);
  check("CAST_SPEED=2: all 5 hum hooks fire exactly once", f.length === 5, `fired=${f.length}`);
  check("CAST_SPEED=2: waves are all 0x0A000390", f.every(h => h.soundWaveId === 0x0a000390));
  check("CAST_SPEED=2: volume ramp preserved 0.2..0.6 in order",
    JSON.stringify(f.map(h=>h.soundVolume)) === JSON.stringify([0.2,0.3,0.4,0.5,0.6])); }
{ const f = simulateOverlay(2.0, 1/60); check("frame-0 hum fires (lastTime=-1 seed)", f.some(h => h.time === 0)); }
{ const f = simulateOverlay(5.0, 1/60); check("timeScale=5 (compressed windup): all 5 fire once", f.length === 5, `fired=${f.length}`); }
{ const f = simulateOverlay(2.0, 1/30);
  check("30fps drain: trailing (2.208s,2.375s) hooks still fire", f.length === 5 && f.some(h => Math.abs(h.time - 57/24) < 1e-6), `fired=${f.length}`); }
{ const f = simulateOverlay(2.0, 1/90); const t = f.map(h=>h.time);
  check("no double-fire across fine 90fps ticks", new Set(t).size === t.length && t.length === 5, `times=${t.length}`); }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
```

If P1 lands, add a regression asserting no hook fires after `cancelCastSequence` — but that
needs the EntityManager (THREE/mixer), so it belongs in the headless-chromium recipe below,
not a pure-JS unit test.

### 4.2 DAT-parity check (re-runnable ground truth, no repo edit)

```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger
./target/release/dat-tool export /home/wbterminal/ac_base_dats/client_portal.dat 0x030005A0 -o /tmp/a.bin
# parse: expect SoundTweaked gid 0x0A000390 @ frames 0/15/30/53/57, [prob 1.0, prio 0.9, vol 0.2..0.6]
# (parser in this packet's F1; identical for 0x03000848)
```

### 4.3 TODO-FOR-LAPTOP — headless-chromium validation recipe

No live ACE / browser on this box. On the laptop:

1. Serve: `python3 external/holtburger/scripts/serve.py` → :8765.
2. Bot URL (bare defaults + audio probe):
   `http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&renderOnDemand=1&netDrainHz=30&autoLogin=1&account=X&password=X&autoSpawn=first&kickDance=1&agent=1`
3. Poll `window.__bootState === 'in-world'`.
4. **Unlock audio (F9):** the autoLogin click may not count as a gesture — force it:
   `window.liveScene3d.audioManager.notifyUserGesture()` then confirm
   `window.liveScene3d.audioManager._ctx?.state === 'running'`.
5. Baseline counters:
   `const em = window.liveScene3d.entityManager; const before = em._soundTweakedHookFires|0;`
6. Cast a **war bolt** (low mana on the test char) at a target:
   `window.__sessionHandle.castTargetedSpell(<targetGuid>, <warBoltSpellId>)`.
   Expected: `em._soundTweakedHookFires` increases by ≥5 per windup within the windup window;
   `em._soundHookFires` unchanged by the *gesture* (final gesture has no Sound hook).
7. Confirm the wave: monkey-patch `audioManager.play` to log `did` — expect `0x0A000390`
   (167773072) five times per windup with `opts.gain` stepping 0.2→0.6, `followGuid` = local
   player guid. (`?renderDiag=on` + `window.__diag` surfaces are available.)
8. **Void spell** (needs a void-trained char): expect the SAME wave `0x0A000390` (colored
   windup `0x03000848` shares it) — hum parity war↔void.
9. **Fizzle** (drain mana / low skill, or inject `WeenieError.YourSpellFizzled`): with P1
   `?castCancelStops=on`, assert `em._soundTweakedHookFires` STOPS climbing at the cancel
   instant (no trailing ramp); with the flag off (default) it climbs to the windup's frame-57.
   Independently confirm the fizzle PScript (0xF755 PlayScript.Fizzle) plays its own sound —
   coordinate WS08.
10. **Remote symmetry:** a second bot casts near the first; assert the observer's
    `_soundTweakedHookFires` climbs for the remote caster's guid (KIND_MOTION_ACTION path).
11. **Double-hum check (RC4):** reload with `?castSpeed=off`, cast once, assert
    `_soundTweakedHookFires` per windup is ~5 (single overlay), NOT ~10 (double) — this is the
    WS06 regression.

---

## 5. EYE-TEST QUEUE (1070 GPU box — do NOT run here; batched)

| # | Flag combo | Expected observation |
|---|---|---|
| E1 | bare default (`castSpeed`, `hookDrain` on) | War bolt windup: audible building "power-up" hum (wave 0x0A000390), volume swells 0.2→0.6 across the windup, panned at the caster; distinct hum per windup, no pile-up; NO extra sound on the final blast gesture itself. |
| E2 | `?castCancelStops=on` (P1) vs default | Fizzle a spell mid-windup (walk out of range / drain mana): with the flag the hum cuts cleanly at the fizzle + the fizzle PScript sound plays; default lets the current windup's hum finish its ramp after the cancel. Confirm the visual cut is acceptable (else switch P1 to the audio-only `hookTimelines.delete` variant). |
| E3 | void-trained char, default | Void spell windup hum == war hum (same wave/ramp); colored powerup band resolves. |
| E4 | `?castSpeed=off` (RC4) | Listen for a doubled/louder hum on the LOCAL caster (prediction+echo). If present, confirms RC4; validates P3 once WS06 lands. |
| E5 | remote caster (2 clients) | Observer hears the remote caster's windup hum tracking their position (panner follows). |

---

## 6. RISKS + cross-workstream interactions

**Files WS12 would touch (for integration ordering):**
- `scene3d/entities.js` — P1 (`cancelCastSequence` + new `CAST_CANCEL_STOPS` const) and P2
  (`_fireHook` type-2 fallback). **Overlaps:** WS01 (setSwingMotion / link classify), WS03
  (overlay/base-cycle suppression, `_completeOverlay`), WS08 (cancelCastSequence lifecycle).
  P1 edits the same method (`cancelCastSequence`) WS08 may touch → **coordinate the hunk**.
- `docs/url-flags.md` — one new row (`castCancelStops`) for P1.
- (proposed new) `test_cast_audio_hooks.mjs` — no conflicts.

**Risks:**
- **R1 (P1 visual):** stopping the overlay changes the on-cancel visual from a clamp to an
  immediate cut. Mitigated by flag-default-OFF + the audio-only fallback variant. Interacts
  with WS03's `_suppressBaseCycleForOverlay` restore — P1 routes through `_completeOverlay`
  (the same restore path `hookDrain` uses) so it should not double-restore, but verify with
  WS03.
- **R2 (P2 scope):** only backfills the LOCAL player, only when `soundTableDid == 0`. Cannot
  regress a valid table. Independent of cast audio.
- **R3 (pkg staleness):** F7/RC5 assume the deployed `pkg/` includes the 2026-06-09 wasm
  `sound_table_did` fallback. If the integration rebuild is skipped, the local player's table
  relies solely on the JS fallbacks (P2 + `index.html:8312`) — which is exactly why P2 is
  worth landing. No WS12 change needs a rebuild.

**Cross-workstream dependencies (WS12 confirms the anim-hook layer; these own the rest):**
- **WS08 (cast-lifecycle):** owns the **fizzle sound** (0xF755 PlayScript.Fizzle → PScript
  Sound hooks) and the CasterEffect release PScript. WS12 confirms the fizzle is NOT a 0xF750
  Sound and that the gesture anim has no release sound — the audible fizzle/release is 100%
  PScript. Verify `PlayScript.Fizzle` (0x51) resolves to a PScript that carries a Sound hook.
- **WS09 (vfx/effects):** the CasterEffect/TargetEffect PScript Sound hooks flow through the
  same `_fireHook` executor — WS12's Sound/SoundTweaked/SoundTable dispatch is shared infra;
  no divergence expected.
- **WS10 (projectiles):** owns **launch whoosh** (projectile DefaultScript/creation PScript)
  and **impact** (`GameMessageSound(projectile, Sound.Collision)` = 0xF750 →
  `resolveSound(projectile.soundTableDid, Collision)`). **Action item for WS10:** verify the
  war-bolt projectile weenie carries `PropertyDataId::SoundTable` (else impact is silent —
  the projectile spawn uses the generic `resolve_sound_table_did`, no local-player-style
  fallback). Since most spells have no CasterEffect (RC2), the projectile is the primary
  release soundscape.
- **WS06 (facing/dispatch):** owns RC4/P3 (double-hum under `?castSpeed=off` from
  prediction+echo not deduped at 1×).
- **WS11 (timing):** the hum tempo is governed by the `dur_MT (2.5s)` vs `durationS_json`
  mismatch (F4 note) — the hum spacing between consecutive windups has minor overlap/gap
  depending on the spell's JSON duration. Not a WS12 bug (fixing it = re-pacing the whole
  cast chain); noted for WS11's timing-parity pass.

---

## VERDICT (WS12-verify)

**Verdict: CONFIRMED — apply=true.** Reviewer: adversarial-verify pass, buildbox, 2026-07-12.
Every load-bearing claim was re-derived from primary sources (raw DAT bytes, retail decomp,
ACE reference, live tree) — not taken on the packet's word. The packet is unusually rigorous;
it survived a deliberate attempt to break its central field-order claim.

### What I independently re-verified (all PASS)

**F1 — windup hum, triple-source proof.** The load-bearing claim (wave `0x0A000390`, frames
0/15/30/53/57, **prob=1.0 → always fires**, prio=0.9, vol ramp 0.2→0.6) is confirmed by FOUR
independent sources that agree:
1. **Oracle** (`chorizite-parse-dat-record` MotionTable `0x09000001`): outer key `0x490003`
   → windups `0x1000006F..78` all → anim `0x030005A0`; colored `0x1000012B..134` all →
   `0x03000848`; finals `0x4000002B..38` → `0x300059B/59A/…/596`. Exactly as F1/F2 map.
2. **Oracle Animation parse** of `0x030005A0`: 5 `SoundTweaked` hooks at partFrames
   **0/15/30/53/57**, all `direction=Forward` (the oracle drops the gid/prob/prio/vol payload).
3. **Raw DAT bytes** (`dat-tool export … 0x030005A0`, 58600 B — matches): anchoring on gid
   `0x0A000390` found 5 hits, each `hookType=21 dir=1  gid=0x0a000390  off4=1.0000 off8=0.9000
   off12=0.2/0.3/0.4/0.5/0.6`. Values verbatim as claimed.
4. **Retail decomp** `SoundTweakedHook::UnPack` (acclient.c:343129-343139) reads disk order
   **gid, prob, prio, vol** → off4=**prob**, off8=**prio**. This *vindicates* the packet's
   field labeling. I initially flagged this as a suspected swap (I mis-remembered ACE's
   order); ACE does **not** parse this hook at all (server-side), and holtburger's Rust getter
   (`lib.rs:18661-18735`) reads `soundProbability` from `hook_data[4..8]`, `soundPriority` from
   `[8..12]`, `soundVolume` from `[12..16]` — with an in-code comment: *"The C# DAT readers
   (melt/DRW/Chorizite) MISLABEL these and we inherited the swap — corrected here."* That is
   exactly why the ORACLE (C#-derived) hides the fields while holtburger is retail-correct.
   **The prob=1.0-always-fires conclusion is bulletproof.**

**F2** — final-gesture anims `0x0300059B`/`0x03000596` carry ONLY CreateParticle+StopParticle,
zero Sound/SoundTweaked (oracle census confirmed). Link mapping confirmed. ✔
**F3** — `_fireHook` type-21 (entities.js:12962-13006): reads `soundWaveId`, short-circuits
`probability >= 1.0` (always fires), gain=`soundVolume`; A-DIR gate `(hook.direction|0)===-1`
at entities.js:**12717** (windups are dir=1, pass). Wasm getters confirmed at the *exact* cited
`lib.rs:18661`. ✔  (Note: the JS raw-byte fallback parser entities.js:10903-10909 uses the same
`@0/@4/@8/@12` mapping — belt-and-suspenders.)
**F4** — setSwingMotion hook stash + `-1` seed at entities.js:7228-7231, `{speed: CAST_SPEED}`
timeScale, chain sleep `÷CAST_SPEED`. I **re-ran the §4.1 unit test against the real
`hook_windows.js`** (copied to /tmp, repo untouched): **7/7 PASS reproduced.** ✔
**F5** — `_tryPlayLink` stashes the same hooks + `-1` seed at entities.js:9708-9711 → remote
symmetry holds. ✔
**F6** — flags default-ON: `castSpeed` = `…!=="off" ? 2.0 : 1.0` (entities.js:904), `hookDrain`
= `…!=="off"` (entities.js:1157). The inline "default OFF" comments ARE stale, as claimed. ✔
**F7/P2** — the local-player `soundTableDid=0x20000001` backfill on 0xF750 exists verbatim at
index.html:~8313-8319 (using `window.getLocalPlayerGuid`, which is defined at index.html:2990/3008);
P2 faithfully mirrors it into the type-2 executor. ✔
**F8** — ACE `Player_Magic.cs:879` and `:917` both `EnqueueBroadcast(new GameMessageScript(Guid,
PlayScript.Fizzle, 0.5f))` (+`:918` `YourSpellFizzled`) → fizzle IS 0xF755 PlayScript, not
0xF750 Sound. Charter guess correctly refuted. index.html PlayEffect(kind 30) bridge ≈:7371
(comment names opcode 0xF755). ✔
**RC2** — `spell-cast-sequence.json`: `_caster_effect_count:74`, `_spell_count:6266` — exact. ✔
**RC3/RC4/RC5** — cancelCastSequence (entities.js:6927-6938) has no `action.stop()` (RC3 real);
`noteLocalSwingPrediction` guarded on `CAST_SPEED!==1.0` at :6812 (RC4 real, non-default only);
type-2 executor silent-no-ops on `stbDid===0` at :12766 (RC5 real). ✔

### Patch apply-check
- **P1** (`?castCancelStops`, default OFF): insertion context matches the current tree exactly;
  `_completeOverlay(inst,key,action,finished)` exists (entities.js:10001) with the used
  signature and does **not** mutate `inst.actions` (verified — no delete/set; `action.stop()`
  fires no `'finished'`), so no iterate-while-mutate hazard. `inst.actions` is a Map (:2365);
  `THREE.LoopOnce` in scope (:562); swingKey/linkKey use `swing:`/`link:` prefixes (:7220/:9663).
  Flag const follows the house pattern. Correctly flag-default-OFF (feel/visual) + audio-only
  fallback documented. **Applies & sound.**
- **P2** (default-ON, zero-risk): anchor `const stbDid = inst.soundTableDid >>> 0;` is verbatim
  at entities.js:12766; conversion to `let` + local-only backfill mirrors the proven
  index.html:8313 pattern; cannot regress a non-zero table. **Applies & sound.**

### Minor corrections / notes (non-blocking; do NOT gate apply)
1. **Line-cite drift (cosmetic):** index.html fizzle-bridge is ~:7371 (pkt says :7373);
   local-player backfill is ~:8313-8319 (pkt says :8312-8318); `lib.rs:18661` is specifically
   the `soundWaveId` getter with the SoundTweaked getter block spanning ~18626-18735. Substance
   unaffected.
2. **"PROVEN end-to-end" wording:** verified at DAT→wasm-getter→JS-bake→JS-drain code+data
   level and by the 7/7 planner test; the *live-browser tick* (audioManager.play actually
   sounding) is necessarily deferred to the §4.3 laptop recipe (no browser on this box). The
   packet discloses this honestly — not an over-claim, but read "proven" as "proven up to the
   runtime tick."
3. **F2 whole-MT census** (24 SoundTweaked / 2 plain Sound on `0x03000C21/C22`) was not
   exhaustively re-run; the load-bearing half (final cast gestures carry NO sound hooks) IS
   directly verified.
4. **Baker-double watch (for the laptop pass):** the Magic link anims list `0x030005A0` TWICE
   (transition @−60fps + main @+60fps). If the overlay baker concatenates both segments' hooks,
   a windup could fire ~10 SoundTweaked (double hum) even at default. The §4.3 recipe step 6/11
   already counts `_soundTweakedHookFires` and asserts ≈5 (not ≈10), so this is covered by the
   existing validation — flag it explicitly when running the laptop capture.
5. **P1 simplification (optional):** the existing `_cancelOneShotOverlays`-style primitive at
   entities.js:~10022 already "stops every RUNNING THREE.LoopOnce overlay"; P1 could
   parameterize it (skip the MT_QUEUE gate / success=false notify) instead of duplicating the
   loop. Purely a cleanliness nit — coordinate with WS03 as the packet already flags.

**Bottom line:** the WS12 diagnosis is correct and well-grounded; the two diffs are minimal,
reversible, correctly flagged, and apply cleanly. Ship both (P1 stays default-OFF pending the
batched 1070 eye-test; P2 ships default-ON). No required fixes block application.

```json
{"workstream":"WS12","title":"Casting audio (windup/cast/fizzle/launch/impact)","packetPath":"/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/docs/spellcasting-packets-2026-07-12/WS12-cast-audio.md","confidence":"high","keyFindings":["Windup hum PROVEN working: SoundTweaked(21) wave 0x0A000390 on anims 0x030005A0 (war) & 0x03000848 (void), frames 0/15/30/53/57, prob=1.0 (always fires), building volume 0.2->0.6; plays via _fireHook type 21, does NOT need soundTableDid; fires at correct clip-relative moments under CAST_SPEED=2 with hookDrain finish-drain — validated by 7/7 headless test vs the real planner","Final cast gesture anims (0x0300059B/9A/96) carry NO sound hooks (only CreateParticle/StopParticle) — the release sound is PScript/projectile-driven by design; casterEffect set for only 74/6266 spells so war/void rely on the projectile (WS10)","Fizzle is a 0xF755 PlayScript.Fizzle (Player_Magic.cs:879/917), NOT a 0xF750 Sound — charter guess corrected; fizzle sound rides the PScript's own Sound hooks (WS08)","cancelCastSequence does not stop the in-flight windup overlay, so its trailing SoundTweaked hum hooks keep firing after a fizzle/interrupt (RC3) — flag-gated fix P1","Local player soundTableDid is plumbed (wasm is_local_player humanoid fallback lib.rs:40151 + JS index.html:8312); local/remote hum symmetry holds via _tryPlayLink hook stash entities.js:9708-9711"],"filesToChange":["scene3d/entities.js","docs/url-flags.md","test_cast_audio_hooks.mjs (new)"],"needsWasmRebuild":false,"newFlags":["castCancelStops"],"risks":["P1 changes on-cancel visual (overlay cut vs clamp) — default-OFF + audio-only fallback variant; coordinate cancelCastSequence hunk with WS08 and _completeOverlay restore with WS03","P2 backfills only the local player when soundTableDid==0 — cannot regress a valid table; independent of cast audio","F7/RC5 assume deployed pkg includes the 2026-06-09 wasm sound_table_did fallback; P2 is the JS safety net if the rebuild is skipped"]}
```

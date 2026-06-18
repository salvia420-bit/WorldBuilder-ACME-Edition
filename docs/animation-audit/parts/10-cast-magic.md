I have everything needed. Here is the audit.

---

# CAST / Magic Animation Audit — holtburger browser client

**Scope:** how casts resolve to motions; the `castSpeed` / `castStateMachine` / `castAxes` / `castFaceTarget` / `castFizzle` flags; whether casts share the one-shot path. All citations are `file:line` under `external/holtburger/apps/holtburger-web/`. Retail comparison from `/home/wbterminal/ac-headers/acclient.c`.

## What exists

There is **no single cast authority**. A magic cast can be driven by **four distinct, independently-maintained mechanisms**, chosen by *who* cast and *where the data came from*:

| # | Mechanism | File:line | Drives | Engine |
|---|-----------|-----------|--------|--------|
| 1 | `playCastSequence(guid, spellId)` | `scene3d/entities.js:5735` | **Local player** cast (the only path that knows the SpellId) | JS `async`/`setTimeout` chain reading a generated JSON table; calls #2 per gesture |
| 2 | `setSwingMotion(guid, cmd, opts)` | `scene3d/entities.js:6014` | Per-gesture playback for #1 **and** local melee/missile one-shots | `classifyMotionCommandTyped` → `animationCache` → manual `mixer.clipAction` LoopOnce |
| 3 | `setMotion` `cls==="cast"` → `_tryPlayLink` | `scene3d/entities.js:6638`, `:8145` | **Server-broadcast** cast clips (`UpdateMotion` kind=5) and remote casters | A *second*, parallel LoopOnce-overlay implementation |
| 4 | `setCastPose` + `_tickCastTween` | `scene3d/entities.js:5650`, `:6359` | Fallback "vibe pose" (both arms rotated −π/2) when SpellId/table/clip is missing | Hand-rolled triangle-wave quaternion slerp — **bypasses AnimationMixer entirely** |

Supporting data + flags:
- `ui/ac_spell_cast_sequence.js` — lazy-loads `data/spell-cast-sequence.json` (a **6,266-spell**, 2.1 MB generated table; `getCastSequence` at `:228`).
- Cast flags: `castSpeed` (`entities.js:601`), `castStateMachine` (`entities.js:618`), `castFaceTarget` (`picking.js:42`), `castAxes` (`loop.js:358`), `castFizzle` (`index.html:10614`).
- `CAST_COMMANDS` set (`entities.js:1073`) — 38 MotionCommand low-16s (MagicBlast 0x2B…, PowerUp01..10 0x6F–0x78, CastSpell 0xD3, purple variants 0x12B–0x134).

## How it works (file:line)

**Local cast dispatch** — `scene3d/picking.js:783-811`:
```
doCast() = { sessionHandle.castTargetedSpell(guid, spellId);   // picking.js:784  → server
             em.playCastSequence(localGuid, spellId)           // picking.js:804  → animation
             ?? em.setCastPose(localGuid); }                    // picking.js:806  fallback
turnToFaceThenAct(guid, doCast, CAST_FACE_TARGET);             // picking.js:811
```

**`playCastSequence`** — `scene3d/entities.js:5735-5912`:
1. Fallbacks to `setCastPose` if `!spellId` (`:5740`), table not loaded / spell absent (`:5748-5752`), or `setSwingMotion` missing (`:5755`).
2. State-machine gate: if `_castBusyUntilMs` is in the future, **drop the recast** (`:5762-5766`); else arm the busy window sized to the chain duration `/ CAST_SPEED`, capped 12 s (`:5770`).
3. Monotonic cancellation token `_castSequenceToken` (`:5775`) re-checked before/after each gesture (`:5784`, `:5820`).
4. Chain: each `windupGestures[]` then `castGesture` via `playGesture` → `setSwingMotion(g, motionU32, {speed: CAST_SPEED})` (**not awaited**; paced by `setTimeout(durationS*1000/CAST_SPEED)`, `:5811-5817`).
5. On completion fire `casterEffect` as a synthetic `playEffect` event (`:5893`), then clear the busy window (`:5911`).

**Per-gesture / shared one-shot** — `setSwingMotion` `entities.js:6014-6207`: `classifyMotionCommandTyped(mtableId,stance,cmd)` (`:6023`) must return `kind==="swing"||"cast"` with `source==="wasm-link"` (`:6039-6043`), else falls to `setSwingPose` vibe tween (`:6046`). On success: `animationCache.get` → `mixer.clipAction` → `LoopOnce`/`clampWhenFinished` → `setEffectiveTimeScale((clip.duration/dur)*swingSpeed)` (`:6088-6108`), with an auto-restore `setTimeout` back to Ready (`:6194-6199`).

**Server-broadcast cast** — `setMotion` classifies via `CAST_COMMANDS` → `"cast"` (`entities.js:1783`), then routes through the **separate** overlay path `_tryPlayLink` (`:6638-6657`, `:6778-6785` → `:8145`). On a missing MT link it logs `"swing/cast/eat will not play"` (`:8182-8190`).

**Remote caster (casting AT you)** — `index.html:11350-1354`: `MAGIC_STANCES` → `em.setCastPose(g)` and `return` — vibe-pose only, because the `damageTaken` payload carries no SpellId (`:11336-1349`); the real gesture, if any, only appears later via `UpdateMotion` → `_tryPlayLink`.

**The flags:**
- **`castSpeed`** (`entities.js:601-616`): ×2 clip `timeScale` and ÷2 sleep so a level-7 war spell's ~7 s client windup matches the server's ~3.5 s; also suppresses the wire echo via `noteLocalSwingPrediction` (`:5812`).
- **`castStateMachine`** (`entities.js:618-632`): the `_castBusyUntilMs` debounce above; cleared early by `clearCastBusy` (`:5917`, on `UseDone` `index.html:10643`) and `cancelCastSequence` (`:5927`).
- **`castFaceTarget`** (`picking.js:42-47`): wraps `doCast` in `turnToFaceThenAct` (ACE `Rotate()` before windup).
- **`castFizzle`** (`index.html:10614-10628`): on `WeenieError 0x0402` (YourSpellFizzled) → `cancelCastSequence` so the rig doesn't finish the windup / flash the success glow.
- **`castAxes`** (`loop.js:358-407`): `drainMotionAxes` polls the wasm `pollMotionAxes` side-channel to render remote strafe footwork (`setSidestepLayer`) + turn-in-place (`setMotion`) during a cast; drained at `loop.js:1783`.

## Fragility & workarounds

1. **The documented defaults are wrong — every cast flag is silently ON.** All five use the opt-**out** form `get(...) !== "off"`, which returns `true` when the param is absent (verified `entities.js:611,628`; `picking.js:45`; `loop.js:369`; `index.html:10620`). Contrast the genuinely opt-in `remoteInterp` at `loop.js:420` (`=== "on"`). Yet the comments uniformly claim **"default OFF pending a 1070 eye-test"** (`entities.js:601,618`; `picking.js:38-41`; `loop.js:363`; `index.html:10616-1617`). So `castSpeed=2.0`, the cast state machine, turn-to-face, and fizzle-cancel are **all live in production by default**, the opposite of the stated intent. Anyone reasoning about cast behavior from the comments will be wrong.

2. **Four overlapping playback engines, two of them not even using the mixer.** `_tryPlayLink` (server) and `setSwingMotion` (local) are near-duplicate LoopOnce implementations that must be hand-kept in sync — different cache keys (`link:` vs `swing:`), different restore timers, different hook registration, different speed math. On top sit two hand-rolled "vibe pose" fallbacks (`setCastPose`/`_tickCastTween` `:6359`, `setSwingPose`) that slerp arm quaternions **outside** AnimationMixer and must be manually nulled everywhere a real clip starts (`_castTween = null` appears at `:5779, 5931, 6122, 6647, 6785`). Miss one site and "both arms stick out through the spell animation" (`:6645-6646`).

3. **Casts only animate fully for the local player.** Only `picking.js` has the SpellId, so only the local player gets the real scarab-windup chain. Remote casters fall back to the arms-up vibe pose (`index.html:11350`) because "`damageTaken` doesn't carry a SpellId" (`:11341-1344`, `entities.js:5728`) — an acknowledged wire-protocol gap with an open TODO to thread `prj_spell_id` (`entities.js:5871-1877`).

4. **Timing is reconstructed client-side, not authored.** The chain paces itself with `setTimeout(durationS/CAST_SPEED)` (`:5816`) instead of clip/sequence frame data; the `castSpeed=2.0` hack exists purely to stop the projectile launching "while the character is still mid-windup" (`:603-604`). The busy window is a 12 s safety cap (`:5770`) guarding against a dropped `UseDone`.

5. **`setCastPose` no-ops on non-humans** (`<16 parts`, `:5653-5654`) — monsters/creatures get *nothing* on the fallback path, mirroring the death/door breakage the brief describes.

6. **Cancellation is token-racing, not state.** `_castSequenceToken` is bumped on every recast/fizzle (`:5775,5930`); aborts are detected only at the next `await` boundary (`:5784,5820`). The success-glow guard (`:5884`) exists specifically because a fizzle mid-cast-gesture otherwise still flashed the success VFX (`:5878-1883`).

## Retail (acclient) comparison

Retail has **exactly one** motion authority, and a cast is not special-cased anywhere in it:

- **Single entrypoint:** every motion — locomotion, melee swing, **cast gesture**, eat, door, death — is a `u32 MotionCommand` fed to `CMotionInterp::DoMotion(motion, params)` (`acclient.c:344600`) → `adjust_motion` → `DoInterpretedMotion`. The Action-class bit `0x10000000` and a hard queue cap (`GetNumActions >= 6` → error 69, `:344650`) are built in — this *is* retail's "cast state machine," applied uniformly to all actions (holtburger reinvents a per-cast `_castBusyUntilMs` instead).
- **Single sequencer:** `CMotionTable::GetObjectSequence` (`acclient.c:337641`) resolves any motion against the same `MotionTable` (style/substate defaults + `get_link` `:337585`) and builds **one** `CSequence` via `CSequence::remove_cyclic_anims` then `add_motion(...)` for pre-link/link/cycle (`:337736-1741`). The magic 0x40-modifier-class gestures walk the identical `links[(style,substate)]` lookup as a 0x10 attack swing.
- **Full-body by construction:** `remove_cyclic_anims` (`:337737`) drops the locomotion cycle before adding the action — so retail swings/casts are full-body automatically. holtburger has to bolt this on with the `?fullBodyOneShot` flag + `_suppressBaseCycleForOverlay` (`entities.js:592, 6141`) precisely because three.js's `AnimationMixer` weight-blends overlay+base to ~50/50 (`entities.js:586-590`).
- **Windup chain is server-broadcast motions, not a client JSON table.** Retail's scarab→`MagicPowerUp0X`→`MagicBlast` sequence arrives as ordinary `UpdateMotion` packets, each replayed through the *same* `DoMotion`. holtburger instead ships a 6,266-entry generated `spell-cast-sequence.json` and a bespoke async orchestrator to *predict* that chain locally (`entities.js:5695-1709`).
- **No vibe-pose concept exists in retail** — a missing link entry simply yields no anim; retail never hand-slerps arm bones as a placeholder.

## Consolidation recommendations

1. **Fix the flag defaults first (cheap, high-signal).** Either flip the five cast flags to opt-in `=== "on"` to match their "default OFF pending eye-test" comments, or delete the comments and treat them as shipped. Today the code and the documentation disagree, so no one can know what the client actually does at cast time. (`entities.js:611,628`; `picking.js:45`; `loop.js:369`; `index.html:10620`.)
2. **Collapse to one one-shot engine.** `setSwingMotion` and `_tryPlayLink` are the same operation (fetch link clip → LoopOnce overlay → restore). Merge them so local-prediction and server-echo casts/swings share one code path with one cache-key scheme, one restore timer, one hook-registration site. This directly removes the "keep five `_castTween = null` sites in sync" hazard.
3. **Build a real sequence player, not a `setTimeout` chain.** Mirror `GetObjectSequence`/`CSequence`: assemble the windup→cast gestures into a single ordered clip-sequence the mixer advances, so timing comes from frame data (and `remove_cyclic_anims` semantics come free) instead of `castSpeed=2.0` fudging. This subsumes `castSpeed` entirely.
4. **Delete both vibe-pose fallbacks** (`setCastPose`/`_tickCastTween`, `setSwingPose`) once the link path is reliable and works for non-humans — they exist only to paper over `AnimationMixer` not being a sequence interpreter, and they silently do nothing for creatures (the exact failure class the audit targets).
5. **Make casts SpellId-addressable on the wire** so remote casters animate identically to the local player (resolves the `index.html:11350` vibe-pose fallback and the `prj_spell_id` TODO at `entities.js:5871`).
6. **Reframe `castStateMachine`/`castFizzle` as one motion-queue state**, not a cast-only debounce — retail's single action queue with completion/cancel events (`MotionDone` `acclient.c:343641`) already covers fizzle, recast, and `UseDone` uniformly. A unified interpreter would get fizzle-cancel for free instead of via a 0x0402-WeenieError special case.

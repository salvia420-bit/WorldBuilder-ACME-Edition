I now have the complete end-to-end picture. Here is the audit.

---

# DEATH / DYING ANIMATION AUDIT — holtburger browser client

**Scope:** `plugins/combat-hud.js` `onDeath`, `scene3d/entities.js` death-motion path, `scene3d/loop.js` dispatch, `index.html` death event, vs. retail `CMotionTable`/`CMotionInterp` in `acclient.c`.

## What exists

Death in holtburger is split across **three mutually-unaware mechanisms**, none of which is a death "authority":

1. **`combat-hud.js onDeath` — a pure DOM overlay for the LOCAL PLAYER only.** It draws the "You died." cream-serif card and a timer-driven narrative ("Entering portal space…" → "Resurrecting…"). It never touches any rig, mixer, or animation. (`plugins/combat-hud.js:1086`, `:1054`, `:82`)

2. **The `kind=29` death wire event** (`GameMessage::PlayerKilled`) in `index.html`, which only emits a `"death"` bus event (consumed by #1) and a typed `dispatchCombatHandlePlayerDeath`. **No rig/animation side-effect whatsoever.** (`index.html:10151`)

3. **The `Dead (0x0011)` MotionCommand**, which is the *only* thing that animates a body. It arrives as an ordinary `UpdateMotion` (KIND_MOTION) and is treated by `entities.js` as a **"stationary held cycle" — identical to Sitting/Sleeping/Crouch** — routed through the locomotion cycle path, not any death-specific code. The "falls over" transition, if it appears at all, is an *optional, best-effort link overlay* fetched on the side. (`scene3d/entities.js:1164`, `:1168`, `:1808`)

The corpse itself is a **completely separate server-spawned object** — `class Corpse extends Static {}` (`plugins/world-objects/corpse.js:3`), a loot container with no rig, no motion, no relationship to the dying creature.

## How it works (file:line)

**A. Local-player death overlay (combat-hud)**
- `index.html:10151-10164` — `evt.kind === 29` → `events.emit("death", {victimGuid, killerGuid, message})`.
- `combat-hud.js:1223` — `pc.events.on("death", onDeath)`.
- `combat-hud.js:1086-1093` — `onDeath` filters `victim === localGuid`; if not the local player it **returns immediately** (so a monster death does nothing here). Local player → `showDeathOverlay("You died.")`.
- `combat-hud.js:1054-1084` — builds the DOM card and a `setTimeout` chain (`deathPhaseTimers`) for the narrative. Comment at `:1035-1046` admits the real portal/resurrect bus events "are pending wasm-side surfacing", so the cadence is faked with timers. **No rig involvement at any point.**

**B. The body's death motion (`Dead 0x0011`) — entities.js cycle path**
- Wire → `loop.js:2128 _armMotion` → for any non-local guid (a monster), `em.setMotion(guid, motionCmd, stance, speed)` (`loop.js:2150-2157`).
- `entities.js:6602` — `const cls = classifyMotionCommand(cmd)`.
- `classifyMotionCommand` (`:1745`): `Dead 0x0011` is in `STATIONARY_COMMANDS` (`:1168-1170`), so `:1808` returns **`"walk"`**. It is explicitly *not* attack/cast.
- Because `cls === "walk"`, setMotion **skips** the attack/cast `_tryPlayLink` branch (`:6638-6658`) and falls into the **locomotion cycle path** (`:6659+`):
  - `:6700` `if (cacheKey === inst.currentActionKey) return;`
  - `:6711-6724` — **optional collapse link:** if `inst.lastMotionCommand` (the creature's previous motion) is known and differs, it fires `this._tryPlayLink(inst, setupId, mtableId, fromMotion, cmd /*Dead*/, stance)` — *not awaited*, fire-and-forget.
  - `:6727-6747` — separately and asynchronously, it fetches the **Dead held-pose cycle** clip via `animationCache.get(...)`.
  - `:6760-6764` — if no clip resolves, `inst.fadeOutCurrent(CROSSFADE_S)` → rig snaps to bare rest pose (no death pose at all).
  - `:6868` — otherwise `inst.crossFadeTo(action, cacheKey, crossfadeDuration)` with `CROSSFADE_S = 0` (`:1337`) → a **hard cut** to the held Dead cycle.
- The collapse link, if it exists, plays through `_tryPlayLink` (`:8145`) as a **`THREE.LoopOnce` overlay** with `clampWhenFinished = false` (`:8200-8201`), under key `link:<from>-><to>:<stance>` (`:8195`) — i.e. it is weight-blended on the `AnimationMixer`, the **exact same overlay machinery used for attack swings and casts**.

**Net runtime behaviour:** the held Dead pose (LoopRepeat) hard-cuts in at frame 0 *simultaneously* with the LoopOnce collapse overlay fading in on top. The two are blended by the mixer rather than sequenced. When the overlay's `finished` fires, its weight drops and the held pose shows through.

## Fragility & workarounds

1. **Two decoupled "deaths."** The death *event* (kind=29) animates nothing; the death *motion* (`Dead`) is a separate, unordered wire message. Nothing couples them: a monster can show "Dead" pose without any death event, or a death event can fire with the body never receiving `Dead` (it would just keep standing until despawn). This is the core "breaks independently" symptom.

2. **Death == Sitting, by classification.** `Dead 0x0011` is bucketed with Sitting/Sleeping/Crouch in `STATIONARY_COMMANDS` (`:1168-1170`) and the comment at `:1164` states the *intent* is only that "the corpse maintains its slumped pose until despawn" — i.e. the author models death as a *static held pose*, not a fall-over. The collapse only appears via the generic cycle-transition link, which was added for locomotion, not death.

3. **Collapse and final pose blend instead of sequence.** Because the Dead cycle (`crossFadeTo`, hard cut at `:6868`) and the collapse link (`_tryPlayLink` LoopOnce overlay, `:8200`) are **two independent mixer actions started concurrently**, the fall-over and the dead pose run on top of each other (weight blend) rather than play-then-hold. There is no guarantee the cycle waits for the collapse to finish.

4. **Two async races.** The cycle clip (`:6735`) and the link clip (`:8150`) are fetched in *separate* un-coordinated `animationCache.get` promises. Either can resolve first; the entity can despawn between them (guarded ad-hoc at `:6758`, `:8167`).

5. **Silent no-collapse on first motion.** The link only fires if `fromMotion !== 0` (`:6712`) — a creature whose first observed motion is `Dead` (spawned already-dead, or motion history lost) gets **no transition**, just the snap. Missing link entries also no-op silently for non-attack classes (`:8169-8191` only warns for attack/cast).

6. **Hard cut everywhere.** `CROSSFADE_S = 0` (`:1337`) forces death (like all locomotion) to a hard pose swap; any smoothness depends entirely on whether an authored link clip happens to exist.

7. **Overlay can be cancelled out from under the death.** `_cancelOneShotOverlays` (`:4117`, `:4174`) nukes in-flight LoopOnce overlays on teleport/exit-world snaps — a death that coincides with a position snap can lose its collapse overlay.

## Retail (acclient) comparison

Retail has **one** motion authority and death is just another input to it:

- Every motion — locomotion, attack, cast, emote, **and `Dead`** — enters through `MotionTableManager::PerformMotion` → **`CMotionTable::DoObjectMotion`** (`acclient.c:330225`, definition `:339023`), which calls the single resolver **`CMotionTable::GetObjectSequence`** (`:337641`). The result is queued into the one animation queue via `add_to_queue` (`:330227`). There is no death special-case.
- `Dead` is a `0x40000011` (class `0x40`) command, so it takes the `if ( motion & 0x40000000 )` branch (`:337763`). There retail:
  1. Looks up the **destination cycle** (`linka = cycles[...]`, `:337765`).
  2. Computes the **transition/link** `motionb = CMotionTable::get_link(style, current_substate, …, motion, speed)` (`:337785`) — the collapse animation *from whatever the creature was doing → Dead*.
  3. Builds **ONE `CSequence`**: `add_motion(sequence, motionb …)` (the collapse) **then** `add_motion(sequence, linka …)` (the held dead pose) (`:337799`, `:337810`) — sequential, in a single sequence, with `num_anims` accounting (`:337811+`).
- `get_link` (`:337585`) is a two-level hash `links[(style<<16)|from_substate][to_motion]` — the same link table holtburger's `_tryPlayLink` targets, but in retail the link and the destination are **frames of one sequence**, advanced by the sequence interpreter, never two blended actions.

**Key divergence:** retail plays `[collapse frames] → [held pose]` as one deterministic, ordered sequence through the same interpreter every object uses. holtburger reproduces the *destination pose* on the locomotion cycle path and the *collapse* as an optional, racy, weight-blended attack-style overlay — so death's "fall over" shares part of the attack one-shot infrastructure (`_tryPlayLink`/LoopOnce overlay) but its final pose shares the locomotion infrastructure, and the two are never composed into a single timeline.

**Does death share the attack/one-shot path?** Partially, and incoherently:
- The **held Dead pose** → locomotion cycle path (`crossFadeTo`, LoopRepeat) — *not* the attack path.
- The **collapse transition** → `_tryPlayLink` LoopOnce overlay — *the exact same code as attack swings and casts* (`:6653` for attacks vs `:6723` for the cycle-transition link both call `_tryPlayLink`).
- In retail both are one sequence; here they are two subsystems stitched at runtime by the mixer's weight blend.

## Consolidation recommendations

1. **Make `Dead` flow through the single sequence resolver, not the cycle bucket.** Port `GetObjectSequence`'s `0x40000000` branch (`acclient.c:337763-337811`) so `Dead` produces an ordered `[link → cycle]` sequence. Remove `0x0011` from `STATIONARY_COMMANDS` (`entities.js:1170`) and route it through the same sequence builder used for all motions.

2. **Replace the concurrent overlay+cycle blend with a real sequence.** Today the collapse (`_tryPlayLink`, `:8145`) and held pose (`crossFadeTo`, `:6868`) are two mixer actions; that is the root of "fall-over and dead-pose fight each other." A `CSequence`-equivalent (queue of clips advanced by one interpreter) makes collapse-then-hold deterministic and eliminates the two-promise race (`:6735` vs `:8150`).

3. **Couple the death event and death motion under one authority.** kind=29 (`index.html:10151`) and `Dead` motion (`loop.js:2150`) should converge on a single death handler so the body reliably collapses when the server says it died — instead of the body relying on a separately-broadcast, unordered `UpdateMotion`.

4. **This is the same fix the attack/missile/door cases need.** All of these symptoms ("upper-body-only swings", "missiles with no animation", "door/death break independently") trace to the same root: holtburger has *no single sequence interpreter*; it scatters motion across `classifyMotionCommand` buckets (`:1745-1827`) that each pick a different three.js mechanism (LoopRepeat cycle, LoopOnce overlay, `crossFadeTo`, vibe tween). Consolidating onto a `CMotionInterp`/`CMotionTable`-style sequence authority (one `GetObjectSequence` → one queued `CSequence` per object, `acclient.c:337641`/`:330225`) fixes death and the others together rather than per-symptom.

5. **Lowest-risk first step:** introduce a sequence wrapper around `_tryPlayLink` + cycle so that, for *any* command with both a link and a destination, the destination does not start until the link's `finished` fires — turning the current weight-blend into a true sequence. Death is the cleanest pilot because its destination is a static pose (no gait phase to preserve).

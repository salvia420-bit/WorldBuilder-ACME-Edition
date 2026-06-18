I have everything I need. The investigation is complete and cross-verified across the web client, the retail decompile, and the ACE server reference. Here is the audit.

---

# Missile/Projectile Attack Animation Audit — holtburger-web

**Assignment:** Why the projectile fires but no draw/release animation plays; where the missile `MotionCommand` fails to resolve to a clip.

**One-line answer:** The missile fire animation in retail *is* the **aim-level command** (`AimLevel`/`AimHigh*`/`AimLow*` = `0x4000001e…2a`), which is a class-`0x40` **cycle**. The web client dispatches it through the **swing-link** path (`setSwingMotion` → `lookupMotionLinkForSwing`), which only searches `MotionTable.links` (action clips), never `cycles`. The lookup structurally cannot hit, so it falls through to `setSwingPose` — a 300 ms triangle-wave arm tween that *no-ops entirely on non-human rigs*. The projectile still appears because it is a **separate server-spawned entity**, fully decoupled from the attacker's motion.

---

## What exists

The missile attack is spread across **five** independent code paths with no shared authority:

| Concern | File | Symbol |
|---|---|---|
| Command classifier (Set-based) | `scene3d/entities.js:1745` | `classifyMotionCommand` |
| "Missile attack 1/2/3" + "Missile shoot" command set | `scene3d/entities.js:1049-1056` | `ATTACK_COMMANDS` (`0x61`, `0xD0`–`0xD2`) |
| Aim-level pose command set | `scene3d/entities.js:1303-1310` | `CYCLE_HELD_COMMANDS` (`0x1E`–`0x2A`) |
| Aim-level resolver (the actual fire motion) | `ui/ac_aim_level_for_velocity.js:80-149` | `AIM_MOTIONS`, `getAimLevelForVelocity`, `getAimLevelForBallisticArc` |
| Local fire path | `scene3d/picking.js:1001-1167` | missile branch of `fireAttackOnSelectedTarget` |
| Remote/monster fire path | `index.html:11356-11408` | `dispatchRemoteSwing` (RANGED_STANCES arm) |
| Swing/clip dispatch | `scene3d/entities.js:6014` | `setSwingMotion` |
| Action-link clip resolver | `scene3d/entities.js:8145` | `_tryPlayLink` |
| Vibe-pose fallback | `scene3d/entities.js:5603` | `setSwingPose` |
| Projectile spawn (decoupled) | `scene3d/entities.js:3374-3400` | F3-1 ballistic seed |

**Note the dead code:** `ATTACK_COMMANDS` carefully enumerates `MissileAttack1/2/3` (`0xD0`–`0xD2`) and `Shoot` (`0x61`) at `entities.js:1050,1056` — but **nothing in the fire path ever dispatches those commands**. The actual missile fire dispatches an **aim-level** command instead (see below), so the `0xD0`–`0xD2` entries are inert for missiles.

---

## How it works (file:line)

### The local fire flow (`picking.js`)

1. `picking.js:1044` — `getCombatManeuver(...)` is called for the CombatManeuverTable lookup, but the comment at `1006-1014` documents that **retail CMT `0x30000000` has ZERO rows for ranged stances** (`dump_cmt_ranged_rows.rs` audit), so `motionCmd` is always `0`/none for bows.
2. `picking.js:1101-1107` — falls back to `getAimLevelForBallisticArc({origin,target,projectileSpeed})`, returning one of 13 `AIM_MOTIONS` (`0x4000001e…2a`).
3. `picking.js:1114` — `const finalMotion = motionCmd || aimMotion;` → because `motionCmd===0`, **`finalMotion` is always the aim-level command**.
4. `picking.js:1145` — `sessionHandle.missileAttack(targetGuid, safeHeight, slider)` fires the wire action → **server spawns the projectile** (this is the only thing that works).
5. `picking.js:1147-1148` — `em.setSwingMotion(localGuid, finalMotion)` attempts the animation with the aim-level command.
6. `picking.js:1150` — `em.noteLocalSwingPrediction(finalMotion)` **suppresses the server's UpdateMotion echo** (see fragility #2).

### Where the command fails to resolve (`setSwingMotion`)

`setSwingMotion` (`entities.js:6014`) is hard-wired to the **swing/action-link** lookup:

- `entities.js:6023` — `classifyMotionCommandTyped(mtableId, stance, motionCmd)` calls the wasm `lookupMotionLinkForSwing(mt, stance, cmd)` (`entities.js:1921`), which mirrors the C# `MotionClassifySwing` oracle and **only walks `MotionTable.links[(stance, Ready)][cmd]`** (the swing/action table).
- The aim-level command is a **class-`0x40` cycle** living in `MotionTable.cycles`, **not** in `links`. So `lookupMotionLinkForSwing` returns `None` → coarse fallback (`entities.js:1959-1971`) with `kind = classifyMotionCommand(0x1E) = "walk"` (it's in `CYCLE_HELD_COMMANDS`, `entities.js:1809`) and `source = "coarse-fallback"`.
- `entities.js:6039-6043` — `canPlayReal` requires **`kind === "swing"||"cast"` AND `source === "wasm-link"`**. The aim-level result satisfies *neither*.
- `entities.js:6045-6048` — therefore: `this.setSwingPose(g); return;`

This is the **exact resolution failure point**: an aim-level *cycle* command is forced through a *swing-link* classifier, and `canPlayReal` rejects it 100% of the time.

### What `setSwingPose` actually does

`entities.js:5603-5626` — `setSwingPose` is a placeholder "vibe pose": it rotates `parts[13]` (RIGHT_UPPER_ARM) by `-π/2` over a 300 ms triangle wave. Critically, `entities.js:5606-5607`:
```js
const isHuman = inst.parts && inst.parts.length >= 16;
if (!isHuman) return;
```
**For non-human rigs (most monster archers), it silently no-ops** — the archer plays *nothing*.

### The remote/monster path is identical

`index.html:11356-11382` (RANGED_STANCES branch) computes `resolvedMotion = getAimLevelForVelocity(v)` (`11380`), then `index.html:11404-11405` calls `em.setSwingMotion(g, resolvedMotion)` — same aim-level-into-swing-link mismatch, same `setSwingPose` fallback at `11406-11407`.

### The projectile (why it fires anyway)

`entities.js:3374-3400` (F3-1) — the projectile is a **separate entity** the server creates via `LaunchProjectile` and streams as `KIND_SPAWN` with `PhysicsState::Missile (0x40)`. The client seeds `lastVel` from the spawn launch velocity and flags `_ballistic` for per-frame integration. It is **entirely independent of the attacker's animation pipeline** — which is why the arrow flies even though the bow never visibly draws.

---

## Fragility & workarounds

1. **Cycle-vs-link category error (root cause).** Aim-level commands are class `0x40` cycles, but the fire path routes them through the action-link resolver (`setSwingMotion`/`lookupMotionLinkForSwing`). The "30 BowCombat both-missing" parity rows celebrated at `entities.js:1912-1913` are this bug being *measured and accepted as correct* — the link lookup is *supposed* to miss for bows, because bow attacks were never links.

2. **The echo-suppression kills the only correct fallback.** When the server broadcasts `UpdateMotion(aimLevel)`, `loop.js:2211-2212` routes it through `em.setMotion` → `classifyMotionCommand(0x1E)="walk"` → the **cycle path**, which *would* resolve `cycles[(stance,AimLevel)]`. But `noteLocalSwingPrediction` (`entities.js:5583-5588`) + `consumeLocalSwingEcho` (`loop.js:2205-2211`) **swallow that echo** for the local player to avoid "double-play." The local fire is left with only the failed `setSwingPose`.

3. **`setSwingPose` no-ops on non-humans** (`entities.js:5606-5607`) — monster archers, undead, golems with bows animate nothing.

4. **`expandActionCommandLow16` cannot reconstruct the missile class.** `entities.js:1872-1879` only prefixes ranges `0x50–0x78`, `0x11F–0x134` (→`0x10`) and `0x16–0x39` (→`0x40`). `MissileAttack1/2/3` (`0xD0`–`0xD2`) fall in **none** of these, so a bare low-16 `0xD0` passes through **unchanged** (no class byte), and any link lookup keyed on `0xD0` instead of `0x100000d0` misses. The dead `0xD0`–`0xD2` entries in `ATTACK_COMMANDS` are doubly broken.

5. **The 3-leg retail sequence is shredded into 3 misclassifying paths.** Retail fires `aimLevel → Reload → Ready`. In the web client each leg is classified independently and incompatibly:
   - `aimLevel` (`0x4000001e`) → `setSwingMotion`/links → **miss → vibe**.
   - `Reload` (`0x40000016`) → it's in `INTERACTION_COMMANDS` (`entities.js:1203`) → classified `"attack"` (`entities.js:1805`) → `_tryPlayLink` → links lookup → **miss** (it's a cycle) → `[motion-link] no MotionTable link…` warning (`entities.js:8182-8189`) → no anim.
   - `Ready` (`0x40000003`) → `"idle"` → cycle path → resolves. Only the *rest* pose works.
   There is no sequencer holding these together; even when a leg resolves, an aim *cycle* would loop forever (LoopRepeat) because nothing chains it to the next leg.

6. **Flag soup masking the hole.** `FULL_BODY_ONE_SHOT`, `?dispatchParity`, `?serverSwing`, `?mtClassFallback`, `?launcherVelocityTable`, `?projectileGravity`, `?missileFaceTarget` all gate fragments of this path. Default-off flags (`dispatchParity` at `loop.js:2205`) mean default-mode combat and flagged combat resolve differently, so "it works on my URL" is unreliable.

---

## Retail (acclient) comparison

Retail has **one** motion authority: `CMotionTable::GetObjectSequence` (`acclient.c:337641`), invoked via `CMotionInterp`/`CPhysicsObj::DoMotion`. It dispatches **every** command — locomotion, stance, aim, attack, cast — by the **high bits of the 32-bit command**:

- **`0x80000000` (style/stance change):** `acclient.c:337699` — chains `pre_link → style-link → cycle`.
- **`0x40000000` (cycle/modifier — this is the aim class):** `acclient.c:337763-337765` — looks up `cycles[(style, motion & 0xFFFFFF)]`, builds a transition link from the current substate via `get_link`, and adds link + cycle. **`AimLevel 0x4000001e` resolves here, from `cycles`.**
- **`0x10000000` (action — attacks/`Shoot`/`MissileAttack`):** `acclient.c:337842-337855` — looks up the base `cycles[(style, substate)]`, fetches the one-shot link via `get_link(style, substate, motion)` (`acclient.c:337848`), and chains **link clip → base cycle** (`add_motion` at `337854-337855`).

`get_link` (`acclient.c:337585`) is the single link resolver: `links[(style<<16)|substate][motion]`. `is_allowed` (`acclient.c:337560`) gates modifier persistence. There is **no separate "swing vs cycle vs pose" dispatch** — the table layout (`cycles` keyed by `(style<<16)|cmd`, `links` keyed by `(style<<16)|substate`→`cmd`) and the high-bit class fully determine resolution.

**The retail/ACE missile sequence** (`Player_Missile.cs:LaunchMissile`, lines 207-269):
```
aimLevel = GetAimLevel(aimVelocity)                       // 0x4000001e (cycle)
launchTime = EnqueueMotionPersist(actionChain, aimLevel)  // (1) DRAW+AIM+RELEASE — the visible fire motion
   ... after launchTime ...
   LaunchProjectile(...)                                  // (2) spawn arrow + GameMessageSound, timed to the aim clip
EnqueueMotionPersist(actionChain, stance, Reload, animSpeed) // (3) Reload cycle 0x40000016 — pull next arrow
EnqueueMotionPersist(actionChain, stance, Ready)            // (4) Ready 0x40000003
```
Exact enum values (`ACE MotionCommand.cs`): `Reload=0x40000016` (L29), `AimLevel=0x4000001e` (L37), `Shoot=0x10000061` (L104), `MissileAttack1/2/3=0x100000d0/d1/d2` (L215-217).

**The decisive contrast:** Retail's fire animation is a `0x40000000` **cycle** resolved from the `cycles` table, with the projectile launch *timed to that cycle's length* (`launchTime`), all on one `CMotionInterp` timeline. The web client routes the same command through a `links`-only swing resolver that is *structurally incapable* of reading `cycles`, then decouples the projectile entirely. `MissileAttack1/2/3` (the `0x10` action commands the web client *does* model) aren't even what ACE broadcasts for player bow fire — they're vestigial.

---

## Consolidation recommendations

1. **Build one `GetObjectSequence` equivalent and route every command through it.** Mirror `acclient.c:337641`: dispatch by high-bit class — `0x40000000` → `cycles[(style, cmd)]`; `0x10000000` → `get_link(style, substate, cmd)` then chain link→base-cycle; `0x80000000` → stance chain. Delete the parallel reimplementations: `classifyMotionCommand` (Set soup, `entities.js:1745`), `classifyMotionCommandTyped`, `setSwingMotion`, `_tryPlayLink`, `setSwingPose`, `setCastPose`. These are 5+ partial ports of *one* retail function, and the missile bug is exactly the seam between two of them.

2. **Resolve aim-level commands from `cycles`, not `links`.** The single fix that makes missiles draw: when the command class is `0x40` (or specifically `AimLevel`/`AimHigh*`/`AimLow*`/`Reload`), look it up in the cycle table the same way `setMotion`'s "walk" branch already does (`entities.js:6659+`). The data is there — the wasm `fetchEntityAnimationKeyframes` cycle path already resolves it; only `setSwingMotion`'s links-only `canPlayReal` gate (`entities.js:6039-6043`) blocks it.

3. **Sequence the legs.** A real motion authority must enqueue `aimLevel → Reload → Ready` as a chain (retail `CMotionInterp::add_to_queue`), playing each cycle to its `num_anims`/length, then transitioning. Today each leg is an independent `setMotion`/`setSwingMotion` call with no ordering, and a resolved aim cycle would loop forever.

4. **Stop suppressing the server echo when local prediction can't resolve.** `noteLocalSwingPrediction` (`entities.js:5583`) is premised on the local swing having played. For missiles it never does. Either (a) don't predict missiles locally and let the authoritative `UpdateMotion(aimLevel)` drive the cycle path, or (b) make the echo-suppression conditional on `canPlayReal` actually succeeding.

5. **Time the projectile to the motion.** Retail launches the arrow at `launchTime` = aim-clip length (`Player_Missile.cs:227-244`). Once a single timeline owns the aim cycle, gate the `_ballistic` projectile's visible release on the same clock instead of spawning it independently on `KIND_SPAWN` (`entities.js:3374-3400`).

6. **Delete the vestigial `0xD0`–`0xD2`/`Shoot 0x61` attack entries** (`entities.js:1049-1056`) or wire them to `expandActionCommandLow16` (`entities.js:1872-1879`) with correct `0x10` class reconstruction — but only if a data audit shows creature missile tables actually key attacks there. For player bows, ACE proves the fire motion is the aim cycle, not these.

**Bottom line for this assignment:** the missile `MotionCommand` fails to resolve at `entities.js:6039-6048` — `setSwingMotion` rejects the aim-level command because it is a cycle being asked of a links-only resolver — and the only path that *could* resolve it (the server-echo cycle path) is deliberately suppressed at `picking.js:1150` / `loop.js:2205-2211`. The arrow flies because it's a separate server-spawned ballistic entity that never consults the animation system at all.

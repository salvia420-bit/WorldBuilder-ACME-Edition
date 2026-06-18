I now have a complete, evidence-backed picture. Writing the structured audit.

---

# DOORS & STATICS Animation Audit — holtburger browser client

**Scope:** `scene3d/buildings.js`, `scene3d/cells.js` (+ the door-open handler in `index.html` and `scene3d/statics.js` they hand off to). Compared against the entity attack motion path (`scene3d/entities.js`) and retail `CMotionInterp`/`CMotionTable` (`/home/wbterminal/ac-headers/acclient.c`).

**Bottom-line answer to the assignment:** Door-open is a **completely separate code path** from entity motion. It uses **neither a mixer nor a MotionTable** — it is a bespoke, **instantaneous two-state rotation snap** (`rotation = Math.PI/2 | 0`) fired from a network-event handler, with no interpolation, no clock, and no animation over time. Cell statics and outdoor statics **never animate at all** (zero `AnimationMixer`/`clipAction` in `statics.js`). This is a third disjoint mechanism alongside the entity attack path (which *does* use `AnimationMixer` + `MotionTable` links). Retail drives all three through **one** authority.

---

## What exists

Three unrelated "animation" mechanisms touch doors/statics, none shared with each other or with entity motion:

1. **A dead door-rotation scaffold in `buildings.js`** — an elaborate per-part hinge-wrapper Group tree with a `doorRotationRad` field, built "for Phase 7.3+ door rotation," but never driven.
2. **An instant rotation snap in `index.html`** — the real door-open behaviour, a `DoorStateChanged` (event kind 15) handler that hard-sets `.rotation`/`.rotation.z` to one of two fixed values.
3. **No static motion** — `cells.js` cell-statics and `statics.js` outdoor statics are plain static meshes. `statics.js` ports only the *particle* half of retail's `animate_static_object`, not the keyframe-motion half.

For contrast, entity attacks live in a **fourth** mechanism: a per-entity `THREE.AnimationMixer` with crossfade weight-blending driven by `MotionTable` clip lookups (`entities.js`).

---

## How it works (file:line)

### Doors — the scaffold (built, never used)
- `buildings.js:342-470` `buildOneBuilding` constructs `placementGroup → hingeWrapper (per part) → surfaceMesh`. Each hinge wrapper gets `userData.doorRotationRad = 0` (`buildings.js:419-421`) — "Phase 7.3+ door rotation reads/writes this. closed = 0."
- **It is dead code.** `grep doorRotationRad` across the entire web root returns exactly one hit: the write-to-zero at `buildings.js:420`. It is never read and never updated anywhere. The whole hinge-wrapper "door-rotation contract" the module-doc header repeatedly defends (`buildings.js:6-18, 31-41, 130-134, 1059-1061`) is unwired.

### Doors — the real path (instant snap, `index.html`)
- Entry point: WorldEvent `kind === 15` `DoorStateChanged` (`index.html:10647-10792`). Driven by an ACE `SetState` packet (ETHEREAL bit), **not** by any per-frame clock.
- The "animation" is two constants:
  - `index.html:10669` — `const rotation = doorState === "open" ? Math.PI / 2 : 0;`
- Applied to up to three different objects, hard-set, no tween:
  - 2D door entity sprite: `entry.sprite.rotation = rotation` (`index.html:10702`)
  - 2D building static door part: `matchedPart.sprite.rotation = rotation` (`index.html:10767`)
  - **3D path:** `inst.root.rotation.z = doorState === "open" ? -Math.PI / 2 : 0` (`index.html:10784`) — rotates the **door entity's** `THREE.Group` root, **not** the `buildings.js` hinge wrapper.
- Part matching: O(1) `handle.getBuildingPartForDoor(doorGuid)` wasm lookup (`index.html:10722-10745`) with an O(N) spatial fallback `findClosestBuildingPart` — a 5 m-radius nearest-sprite heuristic (`index.html:6667-6706`).
- The 3D code itself admits the hinge is faked: *"Hinge frame from SetupModel still TODO … rotating around the root's local origin is a visible approximation … Doors with a centred origin will spin in place"* (`index.html:10773-10780`).

### Statics — no motion
- Cell statics: built as plain `THREE.Mesh` children with a fixed `position/quaternion/scale` decomposed once (`cells.js:635-665`). Visibility is toggled by the portal BFS (`cells.js:792-981`, `tickCellVisibility3D`) but geometry never animates.
- Outdoor statics: `grep -c "AnimationMixer|mixer|clipAction" statics.js` → **0**. `statics.js` only advances a `ParticleManager` per frame (`tickStaticParticles`, `statics.js:3085-3116`), explicitly mirroring **only** retail `animate_static_object`'s `UpdateParticles` (cites `acclient.c:321191-321193`) — and pointedly **not** the `CPartArray::Update` motion half.

### Entity attack path (the thing doors/statics do NOT share)
- Per-entity `THREE.AnimationMixer` (`entities.js:376-420`, instance fields `entities.js:1984-1992`).
- Crossfade weight-blend engine: `crossFadeTo(nextAction, key, durationS)` → `currentAction.crossFadeTo(...)` (`entities.js:2139-2225`).
- Swing/cast clips resolved from `MotionTable.links[(stance, Ready)][cmd]` via `classifyMotionCommandTyped` (`entities.js:1312-1314, 1884-1930`) and played as LoopOnce overlays.

---

## Fragility & workarounds

- **Three door code paths kept in sync by hand.** The 2D door-entity sprite, the 2D building-part sprite, and the 3D entity root are each rotated by separate statements in the same handler (`index.html:10702 / 10767 / 10784`), each with its own matching/caching logic (`__doorBuildingParts`, `getBuildingPartForDoor`, `findClosestBuildingPart`). Any new renderer path needs a fourth parallel write.
- **A whole dead subsystem.** The `buildings.js` hinge-wrapper tree + `doorRotationRad` exists solely to support door rotation, yet the door path rotates the entity root instead. Dead weight that still constrains other decisions — the module refuses `InstancedMesh` batching *to preserve this unused contract* (`buildings.js:31-41, 130-134`).
- **Doors don't animate, they teleport.** Two states, instant `±π/2`, no interpolation. No swing arc, no easing, no open/close duration. A hard pop.
- **Hinge is geometry-luck, not data.** Because there's no SetupModel hinge-frame extraction, doors whose mesh origin isn't on the hinge edge "spin in place" (`index.html:10773-10780`). The correct hinge data exists in the DAT but is unused.
- **Statics that should move are frozen.** Any animated static (machinery, swinging signage, animated scenery) is inert — `statics.js` implements particle emission but not part-array motion, the exact half of `animate_static_object` that would move them.
- **The entity path's mirror-image fragility confirms the root cause.** Because attacks ride a `AnimationMixer` *weight blend*, a swing overlay co-runs with the locomotion cycle and three.js normalizes them ~50/50, so "a drudge's overhead smash looks like a wiggle," then pops to base pose in one frame (`entities.js:584-591`). The fix shipped as an opt-in flag `?fullBodyOneShot` that ramps the base weight to 0 — a manual re-implementation of retail's `remove_cyclic_anims`. Doors dodge this by using no mixer at all; statics dodge it by not animating. Same disease (no sequence authority), three different symptomatic hacks.

---

## Retail (acclient) comparison

Retail has exactly **one** motion authority, and doors + statics are first-class users of it — identical to creature attacks.

- **Single entry point for every object:** `CPhysicsObj::DoMotion(motion, params, send_event)` (`acclient.c:317315`). A creature swing and a door open both call this with a motion command.
- **One interpreter:** `CMotionInterp::DoMotion` / `DoInterpretedMotion` / `PerformMovement` (`acclient.c:344600 / 343975 / 339200`).
- **One table lookup that builds a real sequence:** `CMotionTable::DoObjectMotion(motion, curr_state, sequence, speed_mod, num_anims)` (`acclient.c:339023`, declared `:6899`) — resolves the motion command against the object's MotionTable and produces a `CSequence` of animation frames (with links/cycles, the same `get_link`/`GetObjectSequence` machinery at `:6892-6893`).
- **One per-frame tick for everything:** `CPhysics::UseTime` iterates all physics objects through `CPhysicsObj::update_object` (`acclient.c:311375`) **and** every animating static through `CPhysicsObj::animate_static_object` over `CPhysics::static_animating_objects` (`acclient.c:311382-311386`).
- **Doors/statics advance via the same part-array animation as creatures:** `animate_static_object` (`acclient.c:321150`) calls `CPartArray::Update(quantum)` (`acclient.c:321180`), then `Frame::grotate` for spin (omega), then particles/scripts. The door's swing is the keyframe sequence interpolated over `quantum` each frame — **time-based, hinge baked into the DAT animation**, no origin guesswork.

| Aspect | holtburger door/static | retail (acclient) |
|---|---|---|
| Authority | none — per-feature ad hoc | `CMotionTable::DoObjectMotion` (one) |
| Door open | instant `rotation.z = ±π/2` snap (`index.html:10669-10784`) | motion cmd → `CSequence`, interpolated per frame |
| Driver | network-event handler, no clock | `CPhysics::UseTime` per-frame tick (`:311382`) |
| Hinge | faked at mesh origin (`index.html:10773`) | authored in the animation keyframes (`CPartArray::Update`) |
| Statics motion | none (`statics.js` mixer count = 0) | `animate_static_object` → `CPartArray::Update` (`:321180`) |
| Shared with attacks? | no — 4 disjoint paths | yes — same `DoMotion`/`DoObjectMotion` |

---

## Consolidation recommendations

1. **Adopt one motion authority and route doors + statics + creatures through it.** Port the `CMotionTable`/`CMotionInterp`/`CSequence` triad (`acclient.c:339023`, `344600`, `:6892-6900`) as a single JS motion interpreter. A door open becomes "submit motion command → `DoObjectMotion` builds a `CSequence` → tick advances it," byte-for-byte the same call a creature attack makes. This is the structural fix the buildings.js header keeps gesturing at but never built.

2. **Replace the instant door snap with a sequence play.** Delete the two-state `rotation = π/2 | 0` writes (`index.html:10669, 10702, 10767, 10784`) in favour of issuing the door's DAT-authored open/close motion to the unified interpreter. This automatically gives an interpolated swing **and** uses the real hinge frame, retiring the "spins in place" approximation (`index.html:10773-10780`).

3. **Add the `CPartArray::Update` half to the static animator.** `statics.js` already ticks particles per frame in the retail-correct pass (`statics.js:3085-3094`); extend that tick to advance part-array motion for animating statics (mirror `acclient.c:321180`), and register doors+animated-statics in one "animating objects" list ticked once per frame (mirror `CPhysics::static_animating_objects`, `acclient.c:311382-311386`). This also lets the scattered self-managed rAF loops (`_bbLoop`, `_spLoop` in `statics.js`) collapse into the single loop.

4. **Unify the entity attack path onto the same authority.** The `AnimationMixer` crossfade (`entities.js:2139-2225`) is the source of the half-amplitude-swing bug (`entities.js:584-591`); a `CSequence`-style "one-shot replaces cycle" model fixes that *and* makes doors/attacks/statics one code path instead of four. The `?fullBodyOneShot` flag is already a hand-rolled `remove_cyclic_anims` — formalize it as the interpreter's default.

5. **Delete or wire the dead scaffold.** Either drive `buildings.js`'s hinge-wrapper tree + `doorRotationRad` (`buildings.js:400-421`) from the new motion tick, or remove it. Today it is pure dead weight that also blocks `InstancedMesh` building batching for no live benefit (`buildings.js:31-41`).

**Net:** the fragility is structural, not per-feature — there is no motion authority, so doors got a snap, statics got nothing, and attacks got a mixer, each with its own breakage. Retail proves one `DoMotion → DoObjectMotion → CSequence → per-frame CPartArray::Update` pipeline covers all three. Consolidating onto it is what ends the piecemeal rework.

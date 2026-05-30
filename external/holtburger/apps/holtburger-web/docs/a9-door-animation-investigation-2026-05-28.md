# A9 — Door animation investigation

Goal: understand what's currently shipped, what retail does, and what the actual gap is — before touching code. User flag: a previous agent applied a 90° rotate to "fix" Academy walk-through, which is the wrong layer.

## What ACE expects

`Source/ACE.Server/WorldObjects/Door.cs:18-19` declares:

```csharp
private static readonly Motion motionOpen   = new Motion(MotionStance.NonCombat, MotionCommand.On);
private static readonly Motion motionClosed = new Motion(MotionStance.NonCombat, MotionCommand.Off);
```

`MotionCommand` enum values (`ACE.Entity/Enum/MotionCommand.cs:18-19`):
- `On  = 0x4000000b` — door open
- `Off = 0x4000000c` — door closed

So in retail, doors DO have motion tables. ACE sets `CurrentMotionState` on open/close and the client is expected to look up the link clip for the transition and play it (hinge swing animation with proper keyframes).

## What the wire layer actually delivers

ACE doesn't broadcast an `UpdateMotion` packet for door open/close. Instead it flips the `Ethereal` bit on the door's `PhysicsState` and broadcasts a `SetState` packet (`Door.cs::Open()` line ~96 flips `Ethereal=true`; collision shape becomes pass-through).

The wasm bridge decodes that as a custom `DoorStateChanged` event:
- `apps/holtburger-web/src/lib.rs:9970+` — "derives `DoorState::Open` from `PhysicsState::ETHEREAL` per ACE's `Door.cs::Open()` — Ethereal=true is the open signal."
- Surfaced to JS as `kind=15` client event with `u32Payload=guid`, `u32Payload2=1|0` for open/closed.

JS handler at `index.html:9117-9270`:
1. Extracts `doorGuid`, `doorState`.
2. Sets `entry.sprite.rotation = ±π/2` (2D Pixi sprite).
3. Looks up the matching building part via wasm `getBuildingPartForDoor` (or `findClosestBuildingPart` fallback).
4. Rotates the matched building part's sprite by `±π/2`.
5. Sets `inst.root.rotation.z = doorState === "open" ? -π/2 : 0` (3D path — the hack the user flagged).

## The dual-geometry problem

Doors exist in TWO places:

1. **As entities**: each door is a `WorldObject` with its own GUID + (presumably) a SetupModel. Spawned via the normal entity pipeline.
2. **As building static parts**: door polygons are also baked into the parent building's outer mesh. The wasm `register_door_part(door_guid, building_id, part_index)` maps the entity GUID to a specific part-index in the building's bake (`lib.rs:9778`).

This duplication is why the existing index.html code rotates BOTH the door entity sprite AND the matched building part sprite. Each lives in its own scene graph.

For the 3D path:
- The current hack rotates `inst.root` (the entity's THREE.Group root).
- But the door's visible geometry might be in the BUILDING's THREE.Mesh — not the entity. So rotating `inst.root` rotates an empty (or barely-populated) Group, and the visible building polys stay still.
- Inline comment at `index.html:9252-9258` openly acknowledges this: *"Hinge frame from SetupModel still TODO ... for most doors the origin sits on the hinge edge of the mesh, so this swings the door open. Doors with a centred origin will spin in place; refine via SetupModel hingeFrame extraction in a follow-up."*

So the 90° hack only "works" cosmetically for doors whose entity geometry includes the visible door — and even then it's instantaneous (no animation), arbitrary 90°, and around the wrong pivot.

## What about collision?

The user's "trouble getting through them" was almost certainly collision, not visual. Collision is handled SEPARATELY by the wasm at `lib.rs:25262`:

```
[phase6.E] DoorStateChanged 0x{:08X} state={:?} → set_door_aabb_active(bid={:?}, pidx={}, active={}) flipped={}
```

When `Ethereal=true` arrives, the wasm flips the corresponding `building_aabb_index` entry's `active=false`, removing the door from collision tests. The visual rotation is purely cosmetic. The previous agent's 90° hack didn't fix collision — that part was already working via the AABB toggle.

If the user was still bumping into doors after the rotate hack, the collision side is the real bug (door's AABB not being properly toggled on the wasm side for that specific building or door). That's a different investigation.

## What retail actually does (per Joe Trevis + ACE behavior)

Doors have a SetupModel with multiple parts. One part is the hinge-anchored "door panel" with a frame offset placing its origin on the hinge edge. The MotionTable has:
- Cycles: idle Closed, idle Open
- Links: `(NonCombat, Ready) → On` (swing-open animation), `(NonCombat, Ready) → Off` (swing-closed animation)

The link clips contain keyframes that animate the door part from closed to open over ~400-700ms. Same machinery as `_tryPlayLink` already uses for combat swings and gesture overlays.

## Three fix options

### Option D-A — Motion-table-driven animation (the "correct" fix)

1. Verify door entities spawn with their setupId + mtableId in the KIND_SPAWN payload (likely already do — doors are normal WorldObjects).
2. On `kind=15 DoorStateChanged`, call:
   ```js
   em.setMotion(doorGuid, doorState === "open" ? 0x4000000b /* On */ : 0x4000000c /* Off */, 0x8000003D /* NonCombat */);
   ```
3. `setMotion` routes through `_tryPlayLink` which fetches the link clip from the door's motion table. The clip drives the entity's parts via the existing animation pipeline.
4. Remove the entity-root rotation hack at `index.html:9262`.
5. Decide what to do about the building's static door part — either:
   - **Option D-A1**: hide the building's door part once the entity is spawned (entity owns visuals); requires per-part visibility toggle on the building mesh.
   - **Option D-A2**: rotate the building's door part to match the entity's current pose every frame; requires per-frame sync, defeats the static-bake optimization.
   - **Option D-A3**: exclude door polys from the building's static bake entirely (Rust side); the entity is the only visual.

**Pros:** correct behavior, swings smoothly, hinge offset comes from the SetupModel.
**Cons:** spans 4 subsystems (entity-spawn, kind=15 handler, motion-link, building-bake or building-part-hide). Multi-day. Requires verifying every door entity actually has a usable motion table (some Holtburg cottage doors might be SetupModel-only without a MotionTable, in which case fall back to a tween).

### Option D-B — Tween the existing rotation around the SetupModel hinge frame

1. Keep the kind=15 → state-derived flow but extract the hinge frame from the SetupModel.
2. Replace the instantaneous `inst.root.rotation.z = ±π/2` with a tween over ~400ms around the hinge axis.
3. Tween the building part sprite in parallel (same `±π/2` target, same duration).

**Pros:** correctly pivots around the hinge (no more spin-in-place); animated; localised change.
**Cons:** still hard-coded 90°; some doors don't swing 90° (double doors that swing inward, blocks at 80°); no motion-table-driven keyframes (no easing curve from retail data).

### Option D-C — Audit and fix the collision side first

The user's symptom ("trouble getting through them") is a collision bug, not a rotation bug. Before any visual work:
1. Verify `set_door_aabb_active(bid, pidx, active=false)` actually fires for Academy doors when they open.
2. Verify the player's collision query consults the per-door AABB exclusion list.
3. Verify the open-door exclusion AABB is positioned correctly (the wasm log at `lib.rs:25313` notes "added cell-mesh exclusion AABB @ global ...").

If collision is broken, fixing the rotation is cosmetic theatre. The Academy walk-through bug was a real shipping issue and a 90° rotate doesn't address it.

## Recommendation

**Start with D-C** (collision audit). Run the Academy reproducer, watch the `[phase6.E] DoorStateChanged` logs, verify `set_door_aabb_active` fires with `flipped=true`. If collision IS working but the player still can't walk through, that's a different bug (player-collision query or AABB geometry mismatch). If collision is NOT working, fix it first — the visual rotate isn't load-bearing.

**Then D-B** (hinge-frame tween) as a Phase-1 visual win — proper pivot, animated swing, no motion-table dependency. Single-file change in `index.html:9259-9265` plus a wasm getter for the hinge frame (`get_door_setup_hinge_frame(setupId, partIdx) -> [x, y, z, qx, qy, qz, qw]`).

**Defer D-A** (motion-table-driven) until D-B is shipped and the dual-geometry question is resolved. The right answer is probably D-A3 (Rust-side: exclude door polys from building bake; entity owns the visual), but that's a bake-pipeline change with downstream effects.

## Concrete next steps

1. **Reproduce the Academy walk-through bug** — Boot into the academy, target a door, `/open` it (or click), try to walk through.
2. **Capture the diagnostic** — `[phase6.E] DoorStateChanged` log line + `set_door_aabb_active` log line should both appear with `flipped=true`. If they don't, that's the bug.
3. **If collision logs look right** — check `building_aabb_index` for the academy's LB 0x8602 (memory [AC Training Academy = LB 0x8602]). Does the door's AABB match the visible door's world position? Off-by-one in the AABB encoding could leave a tiny collision sliver after the entity is marked Ethereal.
4. **Visual hack rollback** — once collision is verified, the previous agent's 90° rotation hack can be reverted; the user's complaint was conflating two issues (collision + visual).

## Files to study before fixing

- `apps/holtburger-web/index.html:9117-9270` — kind=15 handler (the hack site).
- `apps/holtburger-web/src/lib.rs:9970-10170` — wasm-side DoorStateChanged derivation + rotation test.
- `apps/holtburger-web/src/lib.rs:25240-25320` — collision AABB toggle on door state change.
- `apps/holtburger-web/scene3d/buildings.js:370-405` — building static-part wrapper construction (`doorRotationRad` field at line 380).
- `/home/wbterminal/ace-server/Source/ACE.Server/WorldObjects/Door.cs` — authoritative server behavior.
- `/home/wbterminal/ace-server/Source/ACE.Entity/Enum/MotionCommand.cs:18-19` — MotionCommand.On/Off enum values.

## Decision needed

The user flagged the visual hack as "not correct" but the underlying complaint was walk-through (collision). Before any code change:

1. Is the actual symptom (a) doors look ugly when opening, (b) can't walk through open doors, or (c) both?
2. If (b) or (c): the collision audit (D-C) is mandatory first.
3. If only (a): D-B (hinge-frame tween) is the smallest correct fix; D-A is the proper-but-multi-day answer.

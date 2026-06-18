// ─────────────────────────────────────────────────────────────────────────
// QUARANTINED 2D PIXI door code — retired 2026-06-18 (2D-PIXI-retirement, W6).
//
// This is the 2D PIXI door-sprite-rotation path extracted verbatim from
// index.html's kind=15 (DoorStateChanged) handler + the findClosestBuildingPart
// spatial helper. Preserved here as REFERENCE per RULINGS.md item 2 (managed
// /legacy quarantine, not a hard delete). It is NOT imported or wired — it
// references the 2D `liveScene` closure (PIXI building sprites / buildingMap)
// which no longer exists once the 2D renderer is stripped.
//
// What replaced it: the 3D path (kept in index.html) rotates the door entity's
// THREE.Group root (inst.root.rotation.z) or, under ?unifiedMotion=door (now
// default-on), plays the door's real On/Off swing via the Rust MotionSequence
// authority (em3d.playDoorMotion). The shared bits that STAYED in index.html:
// the window.__doorStates.set(doorGuid, doorState) write (module-scope Map,
// GROUND-TRUTH §3.1) and the kind=15 door-state console.log.
//
// Verified at extraction (2026-06-18): findClosestBuildingPart,
// __doorBuildingParts, entry.__doorState, and the handle.getBuildingPartForDoor
// CALL had ZERO 3D/scene3d readers (the scene3d/buildings.js mentions are
// comments). This CORRECTS GROUND-TRUTH §6.1's "getBuildingPartForDoor used by
// both" — in JS it was 2D-only. The Rust export handle.getBuildingPartForDoor
// is untouched (still available for any future 3D use).
// ─────────────────────────────────────────────────────────────────────────

// ── Spatial fallback: find the building's static door PIXI sprite nearest the
//    door entity, so the kind=15 handler could rotate it to match the swing.
//    Used only when handle.getBuildingPartForDoor (the O(1) indexed lookup)
//    missed (ObjectCreate/AABB-drain race, or admin-spawned dynamic dungeons).
//    Closure dep: `liveScene` (2D PIXI). Returns {container, sprite} or null.
function findClosestBuildingPart(doorEntry) {
  if (!liveScene || !liveScene.buildingMap) return null;
  if (!doorEntry || !doorEntry.sprite) return null;
  const doorX = doorEntry.sprite.x;
  const doorY = doorEntry.sprite.y;
  // Skip pre-spawn / placeholder positions (entityMap entry exists at (0, 0)
  // until the first PrivateUpdatePosition).
  if (doorX === 0 && doorY === 0) return null;
  let best = null;
  let bestDist = Infinity;
  for (const [, buildingContainer] of liveScene.buildingMap) {
    // Cheap pre-filter: skip buildings whose pivot is >30 m from the door.
    const bdx = buildingContainer.x - doorX;
    const bdy = buildingContainer.y - doorY;
    if (bdx * bdx + bdy * bdy > 900) continue;
    const cosR = Math.cos(buildingContainer.rotation);
    const sinR = Math.sin(buildingContainer.rotation);
    for (const sprite of buildingContainer.children) {
      const wx = buildingContainer.x + sprite.x * cosR - sprite.y * sinR;
      const wy = buildingContainer.y + sprite.x * sinR + sprite.y * cosR;
      const dx = wx - doorX;
      const dy = wy - doorY;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDist) {
        bestDist = d2;
        best = { container: buildingContainer, sprite, d2 };
      }
    }
  }
  // 25 m^2 = 5 m radius. Beyond that we'd match a structural sprite that just
  // happens to be closest in a small map; rotating it would visibly mis-fire.
  return best && best.d2 < 25 ? best : null;
}

// ── The 2D branch of the kind=15 (DoorStateChanged) handler. Inputs from the
//    recv-loop scope: doorGuid, doorState ("open"/"closed"), rotation
//    (Math.PI/2 on open, 0 on close), handle, liveScene, window.entityMap,
//    window.__doorStates (still written by the kept shared line),
//    window.__doorBuildingParts (this 2D-only sprite cache).
function applyDoor2dSpriteRotation(doorGuid, doorState, rotation, handle) {
  if (window.liveScene) {
    if (!window.liveScene.doorStates) {
      window.liveScene.doorStates = window.__doorStates;
    }
  }
  // Track which building-part sprite (if any) we rotated for this door so the
  // close-state branch unrotates the right one even if the door entity moved.
  if (!window.__doorBuildingParts) {
    window.__doorBuildingParts = new Map();
  }
  let matchedPart = null;
  if (window.entityMap && window.entityMap.get) {
    const entry = window.entityMap.get(doorGuid);
    if (entry) {
      entry.__doorState = doorState;
      // Rotate the door entity's own PIXI sprite around its centre (Z radians).
      if (entry.sprite) {
        entry.sprite.rotation = rotation;
      }
      if (doorState === "open") {
        // Try the wasm-side O(1) indexed lookup first; spatial scan is fallback.
        let resolved = null;
        if (typeof handle.getBuildingPartForDoor === "function") {
          try {
            const ref = handle.getBuildingPartForDoor(doorGuid);
            if (ref) {
              const lbHex = (ref.landblockId >>> 0).toString(16).padStart(8, "0");
              const modelHex = (ref.modelId >>> 0).toString(16).padStart(8, "0");
              const buildingKey =
                `${lbHex}_${ref.originX.toFixed(2)}_${ref.originY.toFixed(2)}_${modelHex}`;
              const buildingContainer =
                liveScene && liveScene.buildingMap ? liveScene.buildingMap.get(buildingKey) : null;
              if (buildingContainer) {
                const partSprite = buildingContainer.children.find(
                  (c) => c.__partIndex === ref.partIndex,
                );
                if (partSprite) {
                  resolved = { container: buildingContainer, sprite: partSprite };
                }
              }
            }
          } catch (err) {
            console.warn(
              `[phase6.E] getBuildingPartForDoor(0x${doorGuid.toString(16)}) failed:`,
              err,
            );
          }
        }
        matchedPart = resolved || findClosestBuildingPart(entry);
        if (matchedPart) {
          window.__doorBuildingParts.set(doorGuid, matchedPart.sprite);
        }
      } else {
        const cached = window.__doorBuildingParts.get(doorGuid);
        if (cached) matchedPart = { sprite: cached };
      }
    }
  }
  if (matchedPart && matchedPart.sprite) {
    matchedPart.sprite.rotation = rotation;
  }
  return matchedPart;
}

export { findClosestBuildingPart, applyDoor2dSpriteRotation };

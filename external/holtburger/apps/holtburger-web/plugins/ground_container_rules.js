// plugins/ground_container_rules.js — when the external-container window
// opens, closes and refuses (OpenAC comparison round 5, 2026-10-08). Pure;
// imported by container-panel.js, corpse-loot-bar.js, item_drag.js,
// scene3d/picking.js and the world-use leaf.
//
// RETAIL (acclient.c):
//   * One ground object at a time. `ClientUISystem::OnViewContents`
//     (:402688) stores every ViewContents but raises the window only for
//     `requestedGroundObject`, which `ItemHolder::AttemptSetGroundObject`
//     (:432235) sets when the player Uses an unowned, uncontained, openable
//     container (`CPlayerSystem::UsingItem` :400488-400494). ACE also sends
//     a ViewContents for each pack inside an opened chest and for the
//     player's own packs (pickup, vendor purchase, login); those never take
//     the window. Replacing the ground object tells the server about the old
//     one (`SetGroundObject` :401660-401666, Event_NoLongerViewingContents).
//   * Range. `gmExternalContainerUI::SetGroundObject` (:253157) registers an
//     object range handler with the container's `_useRadius`, use radii,
//     3-D, every 1 s; out of range or a missing object (`ObjectsInRange`
//     :436730) closes the window (`OnObjectRangeExit` :253227).
//   * Openable. `pwd._bitfield & 1` (BF_OPENABLE); a Locked property update
//     rewrites it (`OnStatUpdated` bool 3 → `SetOpenable(val == 0)`,
//     :437080-437084).
//   * Using a locked container prints "The %s is locked" (text type 0x1A)
//     after the Use is sent (`AttemptSetGroundObject` :432280); vanilla ACE
//     sends only the OpenFailDueToLock sound.
//
// Flags (default ON, `=off` / `0` / `false` escapes): `groundObjectGate`,
// `groundContainerRange`, `containerDropRule`, `lockedContainerNotice`.

/** ODF bits (acclient.h PublicWeenieDesc::BitfieldIndex). */
export const ODF_OPENABLE = 0x00000001;
export const ODF_REQUIRES_PACKSLOT = 0x00800000;
/** ACE's IsWithinUseRadiusOf default when an object has no UseRadius. */
export const DEFAULT_USE_RADIUS = 0.6;
/** Centre-distance slack used only when either body's size is unknown. */
export const NO_DIMS_SLACK_M = 1.5;
/**
 * Slack on top of the use radius. Retail closes at exactly `_useRadius`
 * (and ACE's heartbeat does too, on the server position); our local pose and
 * Setup sizes can differ from the server's by a little, and a close right
 * after a MoveTo that stopped on the boundary would be worse than a window
 * that lingers for the last quarter metre.
 */
export const RANGE_SLACK_M = 0.25;

function flagOn(name, search) {
  let s = search;
  if (typeof s !== "string") {
    try { s = globalThis.location?.search ?? ""; } catch (_) { s = ""; }
  }
  try {
    const v = new URLSearchParams(s).get(name);
    if (v == null) return true;
    return !["off", "0", "false"].includes(String(v).toLowerCase());
  } catch (_) {
    return true;
  }
}

/** `?groundObjectGate` — only a world object's ViewContents opens the window. */
export const groundObjectGateEnabled = (search) => flagOn("groundObjectGate", search);
/** `?groundContainerRange` — the retail 1 s range close. */
export const groundContainerRangeEnabled = (search) => flagOn("groundContainerRange", search);
/** `?containerDropRule` — a 3D drop on a closed / locked container is refused. */
export const containerDropRuleEnabled = (search) => flagOn("containerDropRule", search);
/** `?lockedContainerNotice` — "The X is locked" after using a locked one. */
export const lockedContainerNoticeEnabled = (search) => flagOn("lockedContainerNotice", search);

/**
 * Is this the kind of object retail makes the ground object: a world object
 * (it has a landblock) that nothing contains or wields?
 * @param {{landblock?:number, containerId?:number, wielderId?:number}} o
 */
export function isLandscapeGroundObject({ landblock = 0, containerId = 0, wielderId = 0 } = {}) {
  return (landblock >>> 0) !== 0 && (containerId >>> 0) === 0 && (wielderId >>> 0) === 0;
}

/** The ground object a new one replaces (0 = none, or the same one again). */
export function replacedGroundObject(prev, next) {
  const p = (prev >>> 0) || 0;
  return p && p !== ((next >>> 0) || 0) ? p : 0;
}

/**
 * The facts `isLandscapeGroundObject` reads, from the session handle.
 * `null` when the handle predates the getters (stale pkg / test stub): the
 * caller then keeps the old "every ViewContents opens" behaviour.
 */
export function groundObjectFacts(h, guid) {
  if (typeof h?.objectPosition !== "function") return null;
  const g = guid >>> 0;
  let landblock = 0;
  try {
    const pos = Array.from(h.objectPosition(g) || []);
    landblock = pos.length ? Number(pos[0]) >>> 0 : 0;
  } catch (_) {}
  const iid = (stype) => {
    try { return (h.objectInstanceIdProperty?.(g, stype) >>> 0) || 0; } catch (_) { return 0; }
  };
  return { landblock, containerId: iid(2), wielderId: iid(3) };
}

/**
 * Retail `Position::cylinder_distance` (acclient.c:467221), as in
 * vendor_range.js: the 3-D origin distance minus both radii, combined with
 * the vertical gap between the two cylinders.
 */
export function cylinderDistance(r1, h1, p1, r2, h2, p2) {
  const dx = p2.x - p1.x, dy = p2.y - p1.y, dz = p2.z - p1.z;
  const radial = Math.sqrt(dx * dx + dy * dy + dz * dz) - (r1 + r2);
  const vgap = p1.z <= p2.z ? p2.z - (p1.z + h1) : p1.z - (p2.z + h2);
  if (vgap <= 0) {
    return radial <= 0 ? -Math.sqrt(vgap * vgap + radial * radial) : radial;
  }
  return radial > 0 ? Math.sqrt(vgap * vgap + radial * radial) : vgap;
}

/**
 * The once-a-second range verdict for the open ground container.
 * @param {{useRadius?:number, containerPos?:{x,y,z}|null, playerPos?:{x,y,z}|null,
 *          containerDims?:number[]|null, playerDims?:number[]|null, seen?:boolean}} o
 *   `seen` = the container has had a world position since the window opened.
 * @returns {"unknown"|"ok"|"close"}
 */
export function groundContainerRangeVerdict({
  useRadius, containerPos = null, playerPos = null, containerDims = null, playerDims = null, seen = false,
} = {}) {
  if (!playerPos) return "unknown";
  // A missing object is out of range (ObjectsInRange returns 0), but only
  // once we have seen it: its position may not have arrived yet.
  if (!containerPos) return seen ? "close" : "unknown";
  const r = Number.isFinite(useRadius) && useRadius > 0 ? useRadius : DEFAULT_USE_RADIUS;
  const cr = Number(containerDims?.[0]), pr = Number(playerDims?.[0]);
  if (cr > 0 && pr > 0) {
    const d = cylinderDistance(pr, Number(playerDims[1]) || 0, playerPos,
                               cr, Number(containerDims[1]) || 0, containerPos);
    return d > r + RANGE_SLACK_M ? "close" : "ok";
  }
  const d = Math.hypot(containerPos.x - playerPos.x, containerPos.y - playerPos.y, containerPos.z - playerPos.z);
  return d > r + NO_DIMS_SLACK_M ? "close" : "ok";
}

/** `[landblock, x, y, z]` (landblock-local, Z-up) → a world point; null when unplaced. */
export function landblockToWorld(arr) {
  if (!arr || typeof arr.length !== "number" || arr.length < 4) return null;
  const lb = Number(arr[0]) >>> 0;
  if (lb === 0) return null;
  return {
    x: ((lb >>> 24) & 0xff) * 192 + Number(arr[1]),
    y: ((lb >>> 16) & 0xff) * 192 + Number(arr[2]),
    z: Number(arr[3]),
  };
}

/**
 * BF_OPENABLE, with a live Locked property winning over the creation-time
 * bit (retail OnStatUpdated bool 3 → SetOpenable(!locked)).
 */
export function containerOpenable(odf, lockedBool) {
  if (typeof lockedBool === "boolean") return !lockedBool;
  return ((odf >>> 0) & ODF_OPENABLE) !== 0;
}

/**
 * Retail `ACCWeenieObject::IsContainer` (acclient.c:220515):
 * BF_REQUIRES_PACKSLOT, or an items / containers capacity.
 */
export function isContainerObject({ odf = 0, itemsCapacity = 0, containersCapacity = 0 } = {}) {
  return ((odf >>> 0) & ODF_REQUIRES_PACKSLOT) !== 0 || (itemsCapacity | 0) !== 0 || (containersCapacity | 0) !== 0;
}

/**
 * The line retail prints after using a container it cannot open
 * (`AttemptSetGroundObject`, :432280), or null. Only for the use
 * `CPlayerSystem::UsingItem` treats as opening a container: useable, not a
 * targeted use, a container the player does not own, and not a creature.
 */
export function groundContainerUseNotice({
  isContainer = false, owned = false, useable, openable = true, isCreature = false, name = "",
} = {}) {
  if (!isContainer || owned || openable || isCreature) return null;
  // ItemUses::IsUseable (:296802) is `!(bitfield & 1)`; an absent
  // ItemUseable is 0, i.e. usable.
  const u = useable == null || !Number.isFinite(+useable) ? 0 : useable >>> 0;
  if ((u & 1) !== 0) return null;          // USEABLE_NO
  if ((u & 0xffff0000) !== 0) return null; // ItemUses::IsUseable_Targeted
  return `The ${name || "container"} is locked`;
}

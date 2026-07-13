// C2 (2026-07-12) — retail target-cycling math, import-free so it loads
// under plain node for unit tests (same pattern as camera_math.js).
//
// Mirrors CPlayerSystem::SelectNext (acclient.c:397944) and its helpers
// GetWeightedZDistance / Get2DDistance / CPlayerSystem::Farther
// (acclient.c:395854 / :395854 / :395865). The keybind dispatch that wraps
// these primitives (NextMonster tries the incremental step, then re-issues
// with extreme=1 to wrap) lives in the EntityManager.cycleTarget consumer
// and mirrors acclient.c:399692-399746.
//
// Selection state + the HUD/ring live in scene3d/entities.js; this file is
// only the ordering + candidate math (pure, testable, no THREE/DOM).

// UI_SELECTION_TYPE (acclient.h:3041). We support MONSTER + PLAYER (the two
// combat-relevant cycles) + a synthetic "any" that takes every attackable
// object. ITEM/COMPASS/CORPSE cycles are out of scope for C2.
export const SELECTION_TYPE = Object.freeze({
  MONSTER: "monster",
  PLAYER: "player",
  ANY: "any",
});

// ACE ItemType.Creature (ItemType.cs:13) — the "this object is a creature"
// bit carried on spawn meta's `itemType`.
export const ITEM_TYPE_CREATURE = 0x00000010;
// ObjectDescriptionFlag bits (ObjectDescriptionFlag.cs).
export const ODF_PLAYER = 0x00000008;     // is a player
export const ODF_ATTACKABLE = 0x00000010; // server-marked attackable
export const ODF_CORPSE = 0x00002000;     // a corpse, never a live target

// Weighted-Z factor from GetWeightedZDistance (acclient.c:395854) — the
// retail cycle ranks by horizontal 2D distance + |dz| * 1.2 so a mob one
// floor up sorts behind one at eye level.
export const Z_WEIGHT = 1.2;

/**
 * Retail CPlayerSystem::Farther (acclient.c:395865):
 *   dist_a > dist_b || (dist_a == dist_b && id_a > id_b)
 * — strict "a is farther than b", with the object id as the deterministic
 * tie-break when two candidates sit at the same weighted distance.
 */
export function farther(distA, idA, distB, idB) {
  if (distA > distB) return true;
  if (distA < distB) return false;
  return (idA >>> 0) > (idB >>> 0);
}

/**
 * Weighted distance used for cycle ordering — 2D horizontal distance plus a
 * 1.2× vertical penalty. `pose` / `tpos` are `{x, y, z}` in the same frame
 * (AC world coords). Mirrors Get2DDistance + GetWeightedZDistance.
 */
export function weightedDistance(pose, tpos) {
  const dx = pose.x - tpos.x;
  const dy = pose.y - tpos.y;
  const dz = pose.z - tpos.z;
  return Math.sqrt(dx * dx + dy * dy) + Math.abs(dz) * Z_WEIGHT;
}

/**
 * True when a candidate's spawn meta passes the selection-type filter.
 * `meta` supplies `{itemType, objDescFlags}` (both default 0). Mirrors the
 * per-type switch in SelectNext (acclient.c:398049-398120):
 *   - MONSTER: attackable creature, not a player, not a corpse.
 *   - PLAYER:  carries the Player ODF bit, not a corpse.
 *   - ANY:     any attackable non-corpse.
 * Corpses are always excluded (they leave the live cycle).
 *
 * @param {{itemType?:number, objDescFlags?:number}} meta
 * @param {string} type — a SELECTION_TYPE value
 */
export function matchesSelectionType(meta, type) {
  const it = (meta?.itemType >>> 0) || 0;
  const odf = (meta?.objDescFlags >>> 0) || 0;
  if ((odf & ODF_CORPSE) !== 0) return false;
  switch (type) {
    case SELECTION_TYPE.PLAYER:
      return (odf & ODF_PLAYER) !== 0;
    case SELECTION_TYPE.ANY:
      return (odf & ODF_ATTACKABLE) !== 0;
    case SELECTION_TYPE.MONSTER:
    default:
      // Creature bit + attackable + NOT a player (players cycle separately).
      return (
        (it & ITEM_TYPE_CREATURE) !== 0 &&
        (odf & ODF_ATTACKABLE) !== 0 &&
        (odf & ODF_PLAYER) === 0
      );
  }
}

/**
 * Core SelectNext ordering (acclient.c:397944-398210), factored pure.
 *
 * @param {Array<{guid:number, dist:number}>} candidates — already filtered
 *        to the wanted selection type (attackable, live). May contain the
 *        current selection and the local player; both are handled here.
 * @param {number} currentGuid — the currently selected guid (0 if none).
 * @param {number} selfGuid — the local player's guid (always skipped).
 * @param {boolean} closer — retail `_closer`: true = step toward the nearer
 *        neighbour (and, in the extreme/no-selection case, pick the nearest).
 * @param {boolean} extreme — retail `_extreme`: ignore the current selection
 *        and jump to the absolute nearest (closer) / farthest (!closer). This
 *        is the wrap-around fallback the keybind dispatch issues.
 * @returns {number} the guid to select, or 0 when nothing qualifies (retail
 *        leaves selectedID unchanged and the dispatch then wraps).
 */
export function computeSelectNext(candidates, currentGuid, selfGuid, closer, extreme) {
  const self = (selfGuid >>> 0) || 0;
  const cur = (currentGuid >>> 0) || 0;
  const list = [];
  for (const c of candidates) {
    const g = (c.guid >>> 0) || 0;
    if (g === 0 || g === self) continue; // retail skips playerID
    list.push({ guid: g, dist: c.dist });
  }

  // Is the current selection still a live candidate we can step from? Only
  // relevant when we are NOT wrapping (extreme).
  let curEntry = null;
  if (!extreme && cur !== 0) {
    for (const c of list) {
      if (c.guid === cur) { curEntry = c; break; }
    }
  }

  let best = 0;
  let bestDist = 0;

  if (curEntry) {
    const distToBeat = curEntry.dist;
    if (closer) {
      // NextMonster incremental: the candidate immediately CLOSER than the
      // current selection = the MAX (dist,id) among those not-farther-than
      // current. curBestDist seeds at 0 and rises toward distToBeat.
      bestDist = 0;
      for (const c of list) {
        if (c.guid === cur) continue;
        if (farther(c.dist, c.guid, distToBeat, cur)) continue; // must be <= current
        if (best === 0 || farther(c.dist, c.guid, bestDist, best)) {
          best = c.guid; bestDist = c.dist;
        }
      }
    } else {
      // PreviousMonster incremental: the candidate immediately FARTHER than
      // the current selection = the MIN (dist,id) among those strictly
      // farther. curBestDist seeds large and lowers.
      bestDist = Infinity;
      for (const c of list) {
        if (c.guid === cur) continue;
        if (!farther(c.dist, c.guid, distToBeat, cur)) continue; // must be > current
        if (best === 0 || !farther(c.dist, c.guid, bestDist, best)) {
          best = c.guid; bestDist = c.dist;
        }
      }
    }
  } else {
    // Extreme wrap OR no live current selection: pick the global extreme.
    // closer=true → nearest; closer=false → farthest.
    for (const c of list) {
      if (best === 0) { best = c.guid; bestDist = c.dist; continue; }
      if (closer) {
        if (!farther(c.dist, c.guid, bestDist, best)) { best = c.guid; bestDist = c.dist; }
      } else {
        if (farther(c.dist, c.guid, bestDist, best)) { best = c.guid; bestDist = c.dist; }
      }
    }
  }

  return best >>> 0;
}

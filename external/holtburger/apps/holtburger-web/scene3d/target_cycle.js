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

export const ODF_PLAYER_KILLER = 0x00000020; // PK
export const ODF_FREE_PK_STATUS = 0x00200000;
export const ODF_PKLITE_STATUS = 0x02000000;

/**
 * Retail `ClientCombatSystem::ObjectIsAttackable` (acclient.c:407410), the
 * gate `ExecuteAttack` (acclient.c:408640) applies to the selected target
 * before it sends a Targeted{Melee,Missile}Attack. OpenAC ports it verbatim
 * (SelectedObjectHealthPolicy.ObjectIsAttackable). In order:
 *   1. not a Creature (ItemType 0x10) → NOT attackable. A door is ItemType
 *      Misc, so it is never a target even though ACE stamps Attackable on
 *      some doors and items.
 *   2. target or player in free-PK status → attackable.
 *   3. a player target → both PK, or both PK-lite.
 *   4. a pet (owned summon) → no. The spawn meta carries no pet owner, so a
 *      `petOwner` field is honoured only when present.
 *   5. otherwise the Attackable ODF bit (0x10).
 * An unknown target (no meta) is not attackable, the same as retail's missing
 * weenie object.
 *
 * @param {{itemType?:number, objDescFlags?:number, petOwner?:number}|null} target
 * @param {{objDescFlags?:number}|null} player the local player's meta
 */
export function objectIsAttackable(target, player) {
  if (!target) return false;
  const it = (target.itemType >>> 0) || 0;
  if ((it & ITEM_TYPE_CREATURE) === 0) return false;
  const todf = (target.objDescFlags >>> 0) || 0;
  if ((todf & ODF_FREE_PK_STATUS) !== 0) return true;
  if (!player) return false;
  const podf = (player.objDescFlags >>> 0) || 0;
  if ((podf & ODF_FREE_PK_STATUS) !== 0) return true;
  if ((todf & ODF_PLAYER) !== 0) {
    if ((todf & ODF_PLAYER_KILLER) !== 0 && (podf & ODF_PLAYER_KILLER) !== 0) return true;
    return (todf & ODF_PKLITE_STATUS) !== 0 && (podf & ODF_PKLITE_STATUS) !== 0;
  }
  if ((target.petOwner >>> 0) !== 0) return false;
  return (todf & ODF_ATTACKABLE) !== 0;
}

/**
 * Bug 10 (2026-10-07) — does selecting `target` show (and query) a health
 * meter? Retail `gmToolbarUI::HandleSelectionChanged` (acclient.c:241923-
 * 241930) sends `CM_Combat::Event_QueryHealth` only when the object is a
 * player (`IsPlayer`), has a pet owner, or `ClientCombatSystem::
 * ObjectIsAttackable`; anything else (a non-attackable NPC such as the
 * Reformed Bandit) shows no meter. OpenAC: Core/Combat/
 * SelectedObjectHealthPolicy.ShouldQueryHealth — same three tests.
 *
 * @param {{itemType?:number, objDescFlags?:number, petOwner?:number}|null} target
 * @param {{objDescFlags?:number}|null} player the local player's meta
 */
export function shouldQueryHealth(target, player) {
  if (!target) return false;
  const odf = (target.objDescFlags >>> 0) || 0;
  if ((odf & ODF_PLAYER) !== 0) return true;
  if ((target.petOwner >>> 0) !== 0) return true;
  return objectIsAttackable(target, player);
}

/**
 * Bug 9 (2026-10-07) — retail `ItemUses::IsUseable` (acclient.c:296802):
 * an object can be Used unless bit 0 (USEABLE_NO) of its ItemUseable
 * bitfield is set. The retail descriptor defaults the field to 0, so an
 * absent value (undefined/null) is usable. OpenAC ClientObject.IsUseable.
 * @param {number|null|undefined} useable PropertyInt.ItemUseable (16)
 */
export function itemIsUseable(useable) {
  if (useable == null || !Number.isFinite(+useable)) return true;
  return ((useable >>> 0) & 1) === 0;
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

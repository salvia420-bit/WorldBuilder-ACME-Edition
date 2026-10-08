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
//
// A3-selection (2026-10-08) adds the rest of the retail selection rules as
// pure helpers: the radar-range / radar-visibility candidate gate
// (`cycleCandidateOk`), combat auto-target (`autoTargetChoice`), the
// out-of-range drop (`selectionRangeExit`) and the wielded-item attack
// redirect (`resolveAttackTarget`). The radar range helpers moved here from
// plugins/radar.js (which re-exports them) so both share one definition.

// UI_SELECTION_TYPE (acclient.h:3041). We support MONSTER + PLAYER (the two
// combat-relevant cycles) + a synthetic "any" that takes every attackable
// object, plus COMPASS_COMBAT: SELECTION_TYPE_COMPASS_ITEM (2) as
// ClientCombatSystem::AutoTarget issues it in melee/missile mode
// (acclient.c:408728, filter :398090-398106). ITEM/CORPSE cycles are out of
// scope.
export const SELECTION_TYPE = Object.freeze({
  MONSTER: "monster",
  PLAYER: "player",
  ANY: "any",
  COMPASS_COMBAT: "compassCombat",
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
 * Corpses are always excluded (they leave the live cycle). This is the
 * type-only rule `?cycleRadarFilter=off` keeps (COMPASS_COMBAT reads as
 * MONSTER here); the retail gate is `cycleCandidateOk` below.
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
export const ODF_UI_HIDDEN = 0x00000080;      // never shown / cycled
export const ODF_VENDOR = 0x00000200;
export const ODF_LIFESTONE = 0x00004000;
export const ODF_PORTAL = 0x00040000;
export const ODF_FREE_PK_STATUS = 0x00200000;
export const ODF_PKLITE_STATUS = 0x02000000;
export const ODF_BINDSTONE = 0x08000000;

/** CPlayerSystem::GetRadarRadius (acclient.c:395871): 75 m out, 25 m in. */
export const RADAR_RANGE_OUTDOOR = 75;
export const RADAR_RANGE_INDOOR = 25;

/** An outdoor LandCell (cell index 1..0x40 — SmartBox::is_player_outside). */
export function isOutdoorCell(cellId) {
  const c = (cellId >>> 0) & 0xffff;
  return c >= 1 && c <= 0x40;
}

/** CPlayerSystem::GetRadarRadius. */
export function radarRangeForCell(cellId) {
  return isOutdoorCell(cellId) ? RADAR_RANGE_OUTDOOR : RADAR_RANGE_INDOOR;
}

/**
 * ACCWeenieObject::InqShowableOnRadar (acclient.c:436764): RadarBehavior
 * (PropertyInt ShowableOnRadar 133) ∈ {ShowMovement 2, ShowAttacking 3,
 * ShowAlways 4}. An absent value is retail's descriptor default 0 — hidden.
 */
export function isShowableOnRadar(radarBehavior) {
  const b = Number(radarBehavior);
  return b === 2 || b === 3 || b === 4;
}

/**
 * NOT retail: the radar's heuristic for a wasm bundle that cannot report the
 * RadarBehavior at all (stale pkg/) — living things, vendors, portals and
 * lifestones, the classes ACE stamps ShowableOnRadar on.
 */
export function fallbackRadarShowable(odf, itemType) {
  if (odf & (ODF_UI_HIDDEN | ODF_CORPSE)) return false;
  if (odf & (ODF_PLAYER | ODF_VENDOR | ODF_PORTAL | ODF_LIFESTONE)) return true;
  return (itemType & ITEM_TYPE_CREATURE) !== 0;
}

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
 * Retail anchors the step on ANY selected object that is in a cell — it does
 * not have to pass the selection-type filter — with its own weighted distance
 * as `distToBeat` (:398012-398020); with nothing selected it anchors on
 * `prevSelectedID` (:398004). With an anchor, `_closer` keeps the largest
 * distance not farther than the anchor (one step INWARD, Previous Monster)
 * and `!_closer` the smallest distance strictly farther (one step OUTWARD,
 * Next Monster). With no anchor, or `_extreme`, `_closer` is flipped and the
 * seeds reset (:398029), so closer picks the nearest and !closer the
 * farthest.
 *
 * @param {Array<{guid:number, dist:number}>} candidates — already filtered
 *        to the wanted selection type (attackable, live). May contain the
 *        anchor and the local player; both are handled here.
 * @param {{guid:number, dist:number}|number|null} anchor — the selected (or
 *        previously selected) object and its weighted distance, whether or
 *        not it is a candidate; null when there is none. A bare guid is the
 *        pre-2026-10-08 rule (`?retailSelectNext=off`): it anchors only when
 *        that guid is itself in `candidates`.
 * @param {number} selfGuid — the local player's guid (always skipped).
 * @param {boolean} closer — retail `_closer`.
 * @param {boolean} extreme — retail `_extreme`: ignore the anchor and jump to
 *        the absolute nearest (closer) / farthest (!closer). This is the
 *        wrap-around fallback the keybind dispatch issues.
 * @returns {number} the guid to select, or 0 when nothing qualifies (retail
 *        leaves selectedID unchanged and the dispatch then wraps).
 */
export function computeSelectNext(candidates, anchor, selfGuid, closer, extreme) {
  const self = (selfGuid >>> 0) || 0;
  const list = [];
  for (const c of candidates) {
    const g = (c.guid >>> 0) || 0;
    if (g === 0 || g === self) continue; // retail skips playerID
    list.push({ guid: g, dist: c.dist });
  }

  // Resolve the anchor. Only relevant when we are NOT wrapping (extreme).
  let cur = 0;
  let distToBeat = 0;
  if (!extreme && anchor != null) {
    if (typeof anchor === "object") {
      const g = (anchor.guid >>> 0) || 0;
      if (g !== 0 && Number.isFinite(anchor.dist)) { cur = g; distToBeat = anchor.dist; }
    } else {
      const g = (anchor >>> 0) || 0;
      for (const c of list) {
        if (g !== 0 && c.guid === g) { cur = g; distToBeat = c.dist; break; }
      }
    }
  }

  let best = 0;
  let bestDist = 0;

  if (cur !== 0) {
    if (closer) {
      // Previous Monster step: the candidate immediately CLOSER than the
      // anchor = the MAX (dist,id) among those not-farther-than the anchor.
      // curBestDist seeds at 0 and rises toward distToBeat.
      bestDist = 0;
      for (const c of list) {
        if (c.guid === cur) continue; // retail :398159 skips oldObjID
        if (farther(c.dist, c.guid, distToBeat, cur)) continue; // must be <= anchor
        if (best === 0 || farther(c.dist, c.guid, bestDist, best)) {
          best = c.guid; bestDist = c.dist;
        }
      }
    } else {
      // Next Monster step: the candidate immediately FARTHER than the
      // anchor = the MIN (dist,id) among those strictly farther.
      // curBestDist seeds large and lowers.
      bestDist = Infinity;
      for (const c of list) {
        if (c.guid === cur) continue;
        if (!farther(c.dist, c.guid, distToBeat, cur)) continue; // must be > anchor
        if (best === 0 || !farther(c.dist, c.guid, bestDist, best)) {
          best = c.guid; bestDist = c.dist;
        }
      }
    }
  } else {
    // Extreme wrap OR no anchor: pick the global extreme.
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

/**
 * selection-3 (2026-10-08) — the per-candidate gate inside retail
 * CPlayerSystem::SelectNext (acclient.c:398049-398155), over values the
 * caller resolves (`ctx`):
 *   common — not UI-hidden (`SLOBYTE(bitfield) >= 0`, ODF 0x80, :398123),
 *            not a corpse, not mounted on a wielder, drawn (retail tests
 *            CLOAKED state 0x100000; `stateVisible` also covers NoDraw /
 *            Hidden), and within radar range by 2D distance only
 *            (`GetRadarRadius() >= Get2DDistance`, :398153-398155).
 *   MONSTER (3) — ObjectIsAttackable, not a vendor, shown on radar, not a
 *            fellow (:398079-398089). So a mutual-PK player is IN and a pet
 *            is OUT.
 *   PLAYER (4) — a player shown on radar (:398074-398077).
 *   COMPASS_COMBAT (2, melee/missile mode) — shown on radar or a
 *            lifestone/portal/bindstone (bitfield & 0x8044000), then
 *            ObjectIsAttackable, not a fellow, not a vendor (:398090-398106;
 *            the REPORT_COLLISIONS_AS_ENVIRONMENT physics state is not in the
 *            spawn meta and is not tested).
 *   ANY — the synthetic "any attackable object" cycle.
 *
 * @param {{itemType?:number, objDescFlags?:number, petOwner?:number}|null} meta
 * @param {{playerMeta?:object|null, isFellow?:boolean,
 *          showable?:boolean|(() => boolean), stateVisible?:boolean,
 *          attached?:boolean, dist2d:number, range:number}} ctx
 *        `showable` may be a thunk so the caller's wasm lookup runs only for
 *        candidates that pass every cheaper rule.
 * @param {string} type — a SELECTION_TYPE value
 */
export function cycleCandidateOk(meta, ctx, type) {
  const odf = (meta?.objDescFlags >>> 0) || 0;
  if (ctx.attached) return false;
  if (ctx.stateVisible === false) return false;
  if ((odf & (ODF_UI_HIDDEN | ODF_CORPSE)) !== 0) return false;
  if (!(ctx.dist2d <= ctx.range)) return false;
  const showable = () =>
    (typeof ctx.showable === "function" ? ctx.showable() : ctx.showable) === true;
  switch (type) {
    case SELECTION_TYPE.PLAYER:
      return (odf & ODF_PLAYER) !== 0 && showable();
    case SELECTION_TYPE.ANY:
      return (odf & ODF_ATTACKABLE) !== 0;
    case SELECTION_TYPE.COMPASS_COMBAT:
      return (
        objectIsAttackable(meta, ctx.playerMeta ?? null) &&
        !ctx.isFellow &&
        (odf & ODF_VENDOR) === 0 &&
        ((odf & (ODF_LIFESTONE | ODF_PORTAL | ODF_BINDSTONE)) !== 0 || showable())
      );
    case SELECTION_TYPE.MONSTER:
    default:
      return (
        objectIsAttackable(meta, ctx.playerMeta ?? null) &&
        (odf & ODF_VENDOR) === 0 &&
        !ctx.isFellow &&
        showable()
      );
  }
}

/** CharacterOption::AutoTarget (holtburger-common character.rs:131). */
export const CHARACTER_OPTION_AUTO_TARGET = 0x0d;
/** PropertyInstanceId::CurrentAttacker (PlayerDesc IID 0xB). */
export const PROP_IID_CURRENT_ATTACKER = 11;
/** ClientCombatSystem::AutoTarget: `cur_time - lastAttackedTime < 15.0`. */
export const AUTO_TARGET_ATTACKER_WINDOW_MS = 15000;

/**
 * selection-2 (2026-10-08) — retail combat auto-target decision.
 * `ClientCombatSystem::RecvNotice_SelectionChanged` (acclient.c:408741): when
 * the selection becomes empty, a pending `targetWillinglyLost` mark (set by a
 * deliberate deselect) is consumed instead; otherwise, in Melee (2) or
 * Missile (4) mode with PlayerModule::AutoTarget on, it runs `AutoTarget`
 * (:408690): the current attacker (PlayerDesc IID 0xB) when it attacked
 * within 15 s and its weenie still exists and is not being removed, else
 * SelectNext(1, 1, COMPASS_ITEM) — the closest valid combat target. The
 * defender-notification and SetCombatMode callers pass `willinglyLost:false`
 * (they never test the mark). Magic and peace mode never auto-target.
 *
 * @returns {"consume-mark"|"none"|"attacker"|"closest"}
 */
export function autoTargetChoice({
  combatMode, autoTargetOn, willinglyLost,
  attackerGuid, attackerLive, msSinceAttacked,
}) {
  if (willinglyLost) return "consume-mark";
  const mode = (combatMode >>> 0) || 0;
  if ((mode !== 2 && mode !== 4) || !autoTargetOn) return "none";
  if (((attackerGuid >>> 0) || 0) !== 0 && attackerLive &&
      msSinceAttacked < AUTO_TARGET_ATTACKER_WINDOW_MS) {
    return "attacker";
  }
  return "closest";
}

/**
 * selection-4 (2026-10-08) — retail drops a selection that leaves radar
 * range. `CPlayerSystem::RecvNotice_SetSelectedItem` (acclient.c:398637)
 * registers a 1 s range handler on any selection the player does not own
 * (75 m out / 25 m in, XY distance only); on failure
 * `CPlayerSystem::OnObjectRangeExit` (:398710-398737) keeps it while it is
 * still drawn on screen (`SmartBox::is_selected_object_in_view`) and
 * otherwise clears it with SetSelectedObject(0, 0).
 *
 * @param {{xyDist:number, range:number, inView:boolean, exempt:boolean}} s
 * @returns {boolean} true when the selection should be dropped
 */
export function selectionRangeExit({ xyDist, range, inView, exempt }) {
  return !exempt && xyDist > range && !inView;
}

/**
 * selection-6 (2026-10-08) — retail `ClientCombatSystem::GetAttackTarget`
 * (acclient.c:407570-407597): nothing selected, or a selection the player
 * owns (its Container IID 2 or Wielder IID 3 is the player), attacks nobody;
 * a selected object with a physics parent (a monster's wielded weapon)
 * attacks the parent, and only while the parent's weenie exists; anything
 * else is attacked as selected. The selection itself never moves.
 *
 * @returns {number} the guid to attack, or 0
 */
export function resolveAttackTarget({
  sel, me, ownerContainer, ownerWielder, attachedParentGuid, parentKnown,
}) {
  const g = (sel >>> 0) || 0;
  if (g === 0) return 0;
  const self = (me >>> 0) || 0;
  if (self !== 0 && (((ownerContainer >>> 0) || 0) === self || ((ownerWielder >>> 0) || 0) === self)) {
    return 0;
  }
  const parent = (attachedParentGuid >>> 0) || 0;
  if (parent !== 0) return parentKnown ? parent : 0;
  return g;
}

//! Per-house access restrictions (housing-3, 2026-10-08, round 4).
//!
//! Retail keeps a `RestrictionDB` (acclient.h `RestrictionDB`:
//! `_bitmask`, `_monarch_iid`, `PHashTable<guid, perm> _table`) on every
//! house object's `PublicWeenieDesc` (`pwd._db`) next to the owner
//! (`pwd._house_owner_iid`). It arrives with the house's CreateObject
//! (WeenieHeaderFlag HouseRestrictions) and is replaced by
//! `GameEvent::HouseUpdateRestrictions` (0x0248) through
//! `ClientHousingSystem::Handle_House__Recv_UpdateRestrictions`
//! (acclient.c:430582): ignore a zero / own-player sender, run the
//! per-object 1-byte timestamp check
//! (`WTimeStamper::UpdateHouseRestrictionTS`, :716249), then
//! `ACCWeenieObject::SetRestrictions` (:430489).
//!
//! The decision retail's cell barrier asks
//! (`CObjCell::check_entry_restrictions` → `ACCWeenieObject::CanMoveInto`,
//! :438410) is [`can_move_into`] / [`RestrictionDb::is_allowed_in`]. It is
//! deliberately NOT wired into collision here (landdefs-terrain-2 stays
//! deferred) — this module only stores the data and answers the question.

use crate::WorldState;
use crate::entity::Entity;
use holtburger_common::Guid;
use holtburger_common::properties::{ObjectDescriptionFlag, WorldObjectExt as _};
use holtburger_protocol::messages::house::events::HouseUpdateRestrictionsEventData;
use holtburger_protocol::messages::object::messages::description::HouseRestrictionsData;
use std::collections::BTreeMap;

/// `RestrictionDB::_bitmask` bit 0: the house is open to the public
/// (ACE writes `Convert.ToUInt32(OpenStatus)` in this slot).
pub const RESTRICTION_DB_OPEN_BIT: u32 = 0x1;

/// Retail `RestrictionDB` — the access list of one house.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RestrictionDb {
    /// Wire version (ACE `0x10000002`).
    pub version: u32,
    /// `_bitmask` — bit 0 = open to the public.
    pub bitmask: u32,
    /// `_monarch_iid` — allegiance access (0 = none).
    pub monarch_id: u32,
    /// `_table` — guest guid → permission (0 = dwelling access only,
    /// 1 = storage access as well).
    pub table: BTreeMap<u32, u32>,
}

impl RestrictionDb {
    /// From the CreateObject `PublicWeenieDesc` HouseRestrictions block.
    /// Pre-versioned payloads (high word 0) carried only the open flag.
    pub fn from_pwd(data: &HouseRestrictionsData) -> Self {
        let bitmask = data.bitmask.unwrap_or(if data.open_house == Some(true) {
            RESTRICTION_DB_OPEN_BIT
        } else {
            0
        });
        Self {
            version: data.version,
            bitmask,
            monarch_id: data.monarch_id.map(u32::from).unwrap_or(0),
            table: data.entries.iter().copied().collect(),
        }
    }

    /// From a `HouseUpdateRestrictions` (0x0248) payload.
    pub fn from_update(data: &HouseUpdateRestrictionsEventData) -> Self {
        Self {
            version: data.version,
            bitmask: data.open_status,
            monarch_id: u32::from(data.monarch_id),
            table: data.guests.clone(),
        }
    }

    /// `_bitmask & 1`.
    pub fn is_open(&self) -> bool {
        self.bitmask & RESTRICTION_DB_OPEN_BIT != 0
    }

    /// Retail `RestrictionDB::IsAllowedIn` (acclient.c:473082): open house
    /// → yes; else the mover's monarch equals a non-zero `_monarch_iid`
    /// → yes; else a non-zero mover listed in `_table` → yes; else no.
    pub fn is_allowed_in(&self, guest: u32, guest_monarch: u32) -> bool {
        if self.is_open() {
            return true;
        }
        if self.monarch_id != 0 && guest_monarch == self.monarch_id {
            return true;
        }
        guest != 0 && self.table.contains_key(&guest)
    }
}

/// Retail `WTimeStamper::UpdateHouseRestrictionTS` (acclient.c:716249):
/// a 1-byte wrap-around "not older" test. With `|ts − cur| > 127` the
/// incoming stamp is older when `cur < ts` (it wrapped), otherwise when
/// `ts < cur`. An equal stamp is accepted.
pub fn house_restriction_ts_accepts(current: u8, incoming: u8) -> bool {
    let diff = (i32::from(incoming) - i32::from(current)).abs();
    let older = if diff > 127 {
        current < incoming
    } else {
        incoming < current
    };
    !older
}

/// The decision half of retail `ACCWeenieObject::CanMoveInto`
/// (acclient.c:438410): no owner, the owner himself, or no RestrictionDB
/// → allowed; otherwise [`RestrictionDb::is_allowed_in`]. (Retail also
/// plays the house's `pwd._pscript` on a refusal unless the player's
/// DisableHouseRestrictionEffects option is set — a caller concern.)
pub fn can_move_into(
    house_owner: u32,
    db: Option<&RestrictionDb>,
    mover: u32,
    mover_monarch: u32,
) -> bool {
    if house_owner == 0 || house_owner == mover {
        return true;
    }
    match db {
        Some(db) => db.is_allowed_in(mover, mover_monarch),
        None => true,
    }
}

/// Retail `ACCWeenieObject::CanBypassMoveRestrictions` (acclient.c:436967):
/// the mover's `pwd._bitfield` has BOTH Admin (0x100000) and
/// ImmuneCellRestrictions (0x400000).
pub fn can_bypass_move_restrictions(mover_flags: ObjectDescriptionFlag) -> bool {
    mover_flags.contains(ObjectDescriptionFlag::ADMIN)
        && mover_flags.contains(ObjectDescriptionFlag::IMMUNE_CELL_RESTRICTIONS)
}

impl Entity {
    /// `pwd._house_owner_iid` (PropertyInstanceId::HouseOwner — hydrated
    /// from the PWD and kept current by PublicUpdateInstanceID); 0 = none.
    pub fn house_owner_iid(&self) -> u32 {
        self.house_owner_id().map(u32::from).unwrap_or(0)
    }

    /// Retail `UpdateHouseRestrictionTS` + `SetRestrictions`: applies `db`
    /// when `ts` is not older than this object's stamp. Returns whether it
    /// was applied.
    pub fn apply_house_restrictions_update(&mut self, ts: u8, db: RestrictionDb) -> bool {
        if !house_restriction_ts_accepts(self.house_restriction_ts, ts) {
            return false;
        }
        self.house_restriction_ts = ts;
        self.house_restriction_db = Some(db);
        true
    }

    /// [`can_move_into`] against this house object's owner and DB.
    pub fn house_can_move_into(&self, mover: u32, mover_monarch: u32) -> bool {
        can_move_into(
            self.house_owner_iid(),
            self.house_restriction_db.as_ref(),
            mover,
            mover_monarch,
        )
    }
}

impl WorldState {
    /// Retail `ClientHousingSystem::Handle_House__Recv_UpdateRestrictions`
    /// (acclient.c:430582): a zero sender or the local player is ignored;
    /// an unknown object is ignored; otherwise the per-object TS check
    /// then the DB replace. Returns whether the DB was stored.
    pub fn apply_house_update_restrictions(
        &mut self,
        data: &HouseUpdateRestrictionsEventData,
    ) -> bool {
        let sender = data.object_guid;
        if sender == Guid::NULL || sender == self.player.guid {
            return false;
        }
        let Some(entity) = self.entities.get_mut(sender) else {
            return false;
        };
        let db = RestrictionDb::from_update(data);
        entity.apply_house_restrictions_update(data.sequence, db)
    }

    /// Would the house object `house` let `mover` (with allegiance monarch
    /// `mover_monarch`) into its cells? `None` when the object is unknown.
    pub fn house_allows(&self, house: Guid, mover: u32, mover_monarch: u32) -> Option<bool> {
        self.entities
            .get(house)
            .map(|entity| entity.house_can_move_into(mover, mover_monarch))
    }

    /// [`Self::house_allows`] for the local player: mover = the player
    /// guid, monarch = the player's PropertyInstanceId::Monarch (0 when not
    /// known), and the Admin + ImmuneCellRestrictions bypass applied first.
    pub fn house_allows_player(&self, house: Guid) -> Option<bool> {
        let player = self.entities.get(self.player.guid);
        if player.is_some_and(|p| can_bypass_move_restrictions(p.flags)) {
            return self.entities.get(house).map(|_| true);
        }
        let monarch = player
            .and_then(|p| p.monarch_id())
            .map(u32::from)
            .unwrap_or(0);
        self.house_allows(house, u32::from(self.player.guid), monarch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::position::WorldPosition;
    use holtburger_common::properties::PropertyInstanceId;
    use holtburger_protocol::messages::object::messages::description::ObjectDescriptionData;

    const PLAYER: Guid = Guid(0x5000_0001);
    const OWNER: u32 = 0x5000_0002;
    const GUEST: u32 = 0x5000_0003;
    const STRANGER: u32 = 0x5000_0004;
    const MONARCH: u32 = 0x5000_0005;
    const HOUSE: Guid = Guid(0x7A1B_2C3D);

    fn db(open: bool, monarch: u32, guests: &[(u32, u32)]) -> RestrictionDb {
        RestrictionDb {
            version: 0x1000_0002,
            bitmask: u32::from(open),
            monarch_id: monarch,
            table: guests.iter().copied().collect(),
        }
    }

    fn update(
        ts: u8,
        sender: Guid,
        open: u32,
        guests: &[(u32, u32)],
    ) -> HouseUpdateRestrictionsEventData {
        HouseUpdateRestrictionsEventData {
            sequence: ts,
            object_guid: sender,
            version: 0x1000_0002,
            open_status: open,
            monarch_id: Guid(MONARCH),
            guests: guests.iter().copied().collect(),
        }
    }

    fn world_with_house(owner: u32, restrictions: Option<HouseRestrictionsData>) -> WorldState {
        let mut state = WorldState::synthetic();
        state.seed_local_player_entity(PLAYER, "Player", WorldPosition::default());
        let mut house = Entity::new(HOUSE, "Cottage".to_string(), WorldPosition::default());
        let mut desc = ObjectDescriptionData::default();
        desc.public_weenie_desc.guid = HOUSE;
        desc.public_weenie_desc.house_owner = (owner != 0).then_some(Guid(owner));
        desc.public_weenie_desc.house_restrictions = restrictions;
        house.apply_description(&desc);
        state.entities.insert(house);
        state
    }

    fn pwd_restrictions(open: bool, monarch: u32, guests: &[(u32, u32)]) -> HouseRestrictionsData {
        HouseRestrictionsData {
            version: 0x1000_0002,
            bitmask: Some(u32::from(open)),
            monarch_id: Some(Guid(monarch)),
            open_house: None,
            bucket_count: 0,
            entries: guests.to_vec(),
        }
    }

    #[test]
    fn is_allowed_in_truth_table() {
        let private = db(false, MONARCH, &[(GUEST, 0)]);
        assert!(private.is_allowed_in(GUEST, 0), "listed guest");
        assert!(private.is_allowed_in(STRANGER, MONARCH), "allegiance access");
        assert!(!private.is_allowed_in(STRANGER, 0), "stranger");
        assert!(!private.is_allowed_in(STRANGER, 0x5000_0099), "other monarch");
        assert!(!private.is_allowed_in(0, 0), "zero mover never matches the table");

        let open = db(true, 0, &[]);
        assert!(open.is_allowed_in(STRANGER, 0), "open house admits anyone");

        // A zero _monarch_iid never matches a mover with no monarch.
        let no_monarch = db(false, 0, &[]);
        assert!(!no_monarch.is_allowed_in(STRANGER, 0));
    }

    #[test]
    fn can_move_into_owner_and_unowned() {
        let private = db(false, 0, &[]);
        assert!(can_move_into(OWNER, Some(&private), OWNER, 0), "owner always passes");
        assert!(can_move_into(0, Some(&private), STRANGER, 0), "no owner → no barrier");
        assert!(can_move_into(OWNER, None, STRANGER, 0), "no DB → no barrier");
        assert!(!can_move_into(OWNER, Some(&private), STRANGER, 0));
    }

    #[test]
    fn bypass_needs_admin_and_immune() {
        assert!(!can_bypass_move_restrictions(ObjectDescriptionFlag::ADMIN));
        assert!(!can_bypass_move_restrictions(ObjectDescriptionFlag::IMMUNE_CELL_RESTRICTIONS));
        assert!(can_bypass_move_restrictions(
            ObjectDescriptionFlag::ADMIN | ObjectDescriptionFlag::IMMUNE_CELL_RESTRICTIONS
        ));
    }

    #[test]
    fn ts_check_matches_retail_wraparound() {
        assert!(house_restriction_ts_accepts(0, 1));
        assert!(house_restriction_ts_accepts(5, 5), "equal is accepted");
        assert!(!house_restriction_ts_accepts(5, 4), "older rejected");
        assert!(house_restriction_ts_accepts(250, 3), "wrapped forward is newer");
        assert!(!house_restriction_ts_accepts(3, 250), "wrapped backward is older");
        assert!(!house_restriction_ts_accepts(0, 200), "retail: |200−0|>127 and 0<200 → older");
        assert!(house_restriction_ts_accepts(0, 127));
    }

    #[test]
    fn create_object_hydrates_owner_and_db() {
        let state = world_with_house(OWNER, Some(pwd_restrictions(false, MONARCH, &[(GUEST, 1)])));
        let house = state.entities.get(HOUSE).expect("house");
        assert_eq!(house.house_owner_iid(), OWNER);
        assert_eq!(
            house.properties.iids.get(&PropertyInstanceId::HouseOwner).copied(),
            Some(Guid(OWNER))
        );
        let stored = house.house_restriction_db.as_ref().expect("db hydrated");
        assert_eq!(stored.table.get(&GUEST), Some(&1));
        assert_eq!(stored.monarch_id, MONARCH);
        assert!(!stored.is_open());
        assert_eq!(state.house_allows(HOUSE, GUEST, 0), Some(true));
        assert_eq!(state.house_allows(HOUSE, STRANGER, 0), Some(false));
        assert_eq!(state.house_allows(HOUSE, STRANGER, MONARCH), Some(true));
        assert_eq!(state.house_allows(Guid(0x7000_0001), STRANGER, 0), None);
        // The local player (not a guest, no monarch) is refused.
        assert_eq!(state.house_allows_player(HOUSE), Some(false));
    }

    #[test]
    fn legacy_pwd_open_flag_maps_to_bitmask() {
        let legacy = HouseRestrictionsData {
            version: 1,
            bitmask: None,
            monarch_id: None,
            open_house: Some(true),
            bucket_count: 0,
            entries: Vec::new(),
        };
        let db = RestrictionDb::from_pwd(&legacy);
        assert!(db.is_open());
        assert_eq!(db.monarch_id, 0);
    }

    #[test]
    fn update_replaces_db_with_newer_ts_and_ignores_older() {
        let mut state = world_with_house(OWNER, Some(pwd_restrictions(false, 0, &[])));
        assert_eq!(state.house_allows(HOUSE, STRANGER, 0), Some(false));

        // ts 1 > initial 0: the house opens.
        assert!(state.apply_house_update_restrictions(&update(1, HOUSE, 1, &[])));
        assert_eq!(state.house_allows(HOUSE, STRANGER, 0), Some(true));
        let house = state.entities.get(HOUSE).unwrap();
        assert_eq!(house.house_restriction_ts, 1);

        // ts 3: private again, GUEST listed.
        assert!(state.apply_house_update_restrictions(&update(3, HOUSE, 0, &[(GUEST, 0)])));
        assert_eq!(state.house_allows(HOUSE, STRANGER, 0), Some(false));
        assert_eq!(state.house_allows(HOUSE, GUEST, 0), Some(true));

        // A late ts 2 (older) must not reopen it.
        assert!(!state.apply_house_update_restrictions(&update(2, HOUSE, 1, &[])));
        assert_eq!(state.house_allows(HOUSE, STRANGER, 0), Some(false));
        assert_eq!(state.entities.get(HOUSE).unwrap().house_restriction_ts, 3);
    }

    #[test]
    fn update_from_player_zero_or_unknown_sender_is_ignored() {
        let mut state = world_with_house(OWNER, Some(pwd_restrictions(false, 0, &[])));
        assert!(!state.apply_house_update_restrictions(&update(1, PLAYER, 1, &[])));
        assert!(!state.apply_house_update_restrictions(&update(1, Guid::NULL, 1, &[])));
        assert!(!state.apply_house_update_restrictions(&update(1, Guid(0x7000_0009), 1, &[])));
        assert_eq!(state.house_allows(HOUSE, STRANGER, 0), Some(false));
    }

    #[test]
    fn re_create_keeps_the_stamp_but_takes_the_new_pwd_db() {
        let mut state = world_with_house(OWNER, Some(pwd_restrictions(false, 0, &[])));
        assert!(state.apply_house_update_restrictions(&update(9, HOUSE, 0, &[])));
        let mut desc = ObjectDescriptionData::default();
        desc.public_weenie_desc.guid = HOUSE;
        desc.public_weenie_desc.house_owner = Some(Guid(OWNER));
        desc.public_weenie_desc.house_restrictions = Some(pwd_restrictions(true, 0, &[]));
        state.entities.get_mut(HOUSE).unwrap().apply_description(&desc);
        let house = state.entities.get(HOUSE).unwrap();
        assert!(house.house_restriction_db.as_ref().unwrap().is_open());
        assert_eq!(house.house_restriction_ts, 9);
    }
}

//! Housing barriers inside the faithful transition (landdefs-terrain-2,
//! 2026-10-08): retail `CObjCell::check_entry_restrictions`
//! (acclient.c:347103).
//!
//! ## Retail call chain (all read in `~/ac-headers/acclient.c`)
//! * `CEnvCell::find_env_collisions` (347829) and
//!   `CLandCell::find_env_collisions` (355015) call
//!   `check_entry_restrictions` before anything else; a result other than
//!   OK ends that cell's collision pass (`CLandCell::find_collisions`
//!   354887, `CEnvCell::find_collisions` 347810).
//! * `check_entry_restrictions`: when the mover's weenie is a player
//!   (`object_info.state & IS_PLAYER`) that cannot bypass
//!   (`ACCWeenieObject::CanBypassMoveRestrictions`, 436967: Admin AND
//!   ImmuneCellRestrictions) and the cell's `restriction_obj` is set, the
//!   cell refuses (Collided) when that object is unknown
//!   (`CPhysicsObj::GetObjectA` null), has no weenie, or its
//!   `CanMoveInto(mover)` is false (`ACCWeenieObject::CanMoveInto` 438410 →
//!   `RestrictionDB::IsAllowedIn` 473082, ported in `crate::house`). A
//!   refusal first runs the cell's `handle_move_restriction`.
//! * Where the ids come from: an EnvCell carries its own `restriction_obj`;
//!   a landcell's is looked up in the landblock's
//!   `CLandBlockInfo::restriction_table` (`GetRestrictionIID` 351250,
//!   stamped by `CLandBlock::init_static_objs` 352870-352880). Both are
//!   kept by `SpatialScene` (`cell_restriction`).
//! * `CLandCell::handle_move_restriction` (355063) sets an axis-aligned
//!   collision normal from the cell centre toward the mover;
//!   `CEnvCell::handle_move_restriction` (347848) does nothing.
//!
//! The decomp reads the object table as an ambient global. The bridge's
//! cells are cached `'static` handles that cannot borrow the world, so, as
//! with `obj_collision`'s overlay, the mover and the house objects near it
//! are resolved from the `WorldState` once per transition
//! (`TransitionEnv::house_barrier_overlay`) and installed for the driver's
//! cells until the guard drops.
//!
//! Not ported: on a refusal retail also plays the house's `pwd._pscript` on
//! the mover unless the DisableHouseRestrictionEffects option is set
//! (CanMoveInto 438440-438455). That is a visual effect and waits for an
//! eye-test.
//!
//! `?houseBarriers=off` drops the whole pass (no overlay is installed).

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use holtburger_dat::transition::objcell::{ObjectManager, PhysicsObjRef, WeenieObjRef};
use holtburger_dat::transition::types::CTransition;

use crate::house::{RestrictionDb, can_move_into};

thread_local! {
    static HOUSE_BARRIERS: Cell<bool> = const { Cell::new(true) };
    static OVERLAY: RefCell<Option<Rc<BarrierOverlay>>> = const { RefCell::new(None) };
}

/// `?houseBarriers` — enforce housing barriers in the faithful transition.
/// Default ON; `=off` is the escape.
pub fn house_barriers_enabled() -> bool {
    HOUSE_BARRIERS.with(|c| c.get())
}

/// Set the switch for this thread (wasm is single-threaded; each `cargo
/// test` runs on its own thread).
pub fn set_house_barriers(on: bool) {
    HOUSE_BARRIERS.with(|c| c.set(on));
}

/// The mover as `check_entry_restrictions` and `CanMoveInto` read it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BarrierMover {
    /// `mover->id`.
    pub id: u32,
    /// The mover's allegiance monarch (0 = none).
    pub monarch: u32,
    /// `CanBypassMoveRestrictions`: Admin AND ImmuneCellRestrictions.
    pub can_bypass: bool,
}

/// One house object as `ACCWeenieObject::CanMoveInto` reads it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HouseBarrier {
    /// `pwd._house_owner_iid` (0 = unowned).
    pub owner: u32,
    /// `pwd._db` (`None` = no RestrictionDB).
    pub db: Option<RestrictionDb>,
}

struct MoverWeenie(BarrierMover);

impl WeenieObjRef for MoverWeenie {
    fn can_bypass_move_restrictions(&self) -> bool {
        self.0.can_bypass
    }
    /// A player has no house owner, so `CanMoveInto` falls through to
    /// `return 1` (acclient.c:438466). Never asked: the mover is not a
    /// restriction object.
    fn can_move_into(&self, _other: &dyn WeenieObjRef) -> bool {
        true
    }
    fn object_id(&self) -> u32 {
        self.0.id
    }
    fn monarch_id(&self) -> u32 {
        self.0.monarch
    }
}

struct HouseWeenie(HouseBarrier);

impl WeenieObjRef for HouseWeenie {
    fn can_bypass_move_restrictions(&self) -> bool {
        false
    }
    fn can_move_into(&self, other: &dyn WeenieObjRef) -> bool {
        can_move_into(self.0.owner, self.0.db.as_ref(), other.object_id(), other.monarch_id())
    }
}

struct BarrierObj {
    id: u32,
    weenie: Rc<dyn WeenieObjRef>,
}

impl PhysicsObjRef for BarrierObj {
    fn id(&self) -> u32 {
        self.id
    }
    fn has_parent(&self) -> bool {
        false
    }
    fn weenie(&self) -> Option<Rc<dyn WeenieObjRef>> {
        Some(self.weenie.clone())
    }
    /// The barrier objects only answer `GetObjectA`; they are never
    /// collided (the house object is ethereal, and the mover is excluded).
    fn find_obj_collisions(&self, _transition: &mut CTransition) -> i32 {
        1
    }
}

/// The object table `check_entry_restrictions` resolves through for one
/// transition: the mover plus every house object the nearby cells are
/// restricted to that the client knows. A guid missing here is what
/// retail's null `GetObjectA` means: the cell refuses.
pub struct BarrierOverlay {
    mover_id: u32,
    objects: HashMap<u32, Rc<dyn PhysicsObjRef>>,
}

impl BarrierOverlay {
    pub fn new(mover: BarrierMover, houses: impl IntoIterator<Item = (u32, HouseBarrier)>) -> Self {
        let mut objects: HashMap<u32, Rc<dyn PhysicsObjRef>> = HashMap::new();
        for (guid, house) in houses {
            objects.insert(
                guid,
                Rc::new(BarrierObj {
                    id: guid,
                    weenie: Rc::new(HouseWeenie(house)),
                }),
            );
        }
        objects.insert(
            mover.id,
            Rc::new(BarrierObj {
                id: mover.id,
                weenie: Rc::new(MoverWeenie(mover)),
            }),
        );
        Self {
            mover_id: mover.id,
            objects,
        }
    }

    /// The mover's guid (`transition->object_info.object`).
    pub fn mover_id(&self) -> u32 {
        self.mover_id
    }
}

impl ObjectManager for BarrierOverlay {
    fn get_object_a(&self, iid: u32) -> Option<Rc<dyn PhysicsObjRef>> {
        self.objects.get(&iid).cloned()
    }
}

/// Installs an overlay for the current thread and restores the previous
/// one on drop.
pub struct BarrierOverlayGuard(Option<Rc<BarrierOverlay>>);

impl BarrierOverlayGuard {
    pub fn install(overlay: Rc<BarrierOverlay>) -> Self {
        Self(OVERLAY.with(|c| c.replace(Some(overlay))))
    }
}

impl Drop for BarrierOverlayGuard {
    fn drop(&mut self) {
        let prev = self.0.take();
        OVERLAY.with(|c| *c.borrow_mut() = prev);
    }
}

/// The overlay installed for the running transition (`None` = no barrier
/// pass: test envs, `?houseBarriers=off`, or no restricted cell nearby).
pub(crate) fn installed_overlay() -> Option<Rc<BarrierOverlay>> {
    OVERLAY.with(|c| c.borrow().clone())
}

/// `CLandCell::handle_move_restriction` (acclient.c:355063): the
/// collision normal for a landcell refusal. `offset` is the mover's
/// current position relative to the cell centre
/// (`Position::get_offset(&this->pos, &curr_pos)`). Inside the cell's
/// north–south band (|y| ≤ 12) the normal is −X when the mover is west of
/// the cell and +X otherwise; north of it +Y, south of it −Y.
pub fn landcell_restriction_normal(offset_x: f32, offset_y: f32) -> (f32, f32) {
    // flt_844CF0 = 24.0 * 0.5 (acclient.c:787134).
    const HALF: f32 = 12.0;
    if offset_y >= -HALF {
        if offset_y <= HALF {
            (if offset_x < -HALF { -1.0 } else { 1.0 }, 0.0)
        } else {
            (0.0, 1.0)
        }
    } else {
        (0.0, -1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MOVER: u32 = 0x5000_0001;
    const OWNER: u32 = 0x5000_0002;
    const GUEST: u32 = 0x5000_0003;
    const MONARCH: u32 = 0x5000_0005;
    const HOUSE: u32 = 0x73B9_C04E;

    fn private_house() -> HouseBarrier {
        HouseBarrier {
            owner: OWNER,
            db: Some(RestrictionDb {
                version: 0x1000_0002,
                bitmask: 0,
                monarch_id: MONARCH,
                table: [(GUEST, 0)].into_iter().collect(),
            }),
        }
    }

    fn allowed(overlay: &BarrierOverlay, mover: u32) -> bool {
        let house = overlay.get_object_a(HOUSE).expect("house resolves");
        let mover = overlay.get_object_a(mover).expect("mover resolves");
        house
            .weenie()
            .expect("house weenie")
            .can_move_into(mover.weenie().expect("mover weenie").as_ref())
    }

    #[test]
    fn the_overlay_answers_can_move_into_for_its_mover() {
        let mover = |id, monarch| BarrierMover {
            id,
            monarch,
            can_bypass: false,
        };
        let stranger = BarrierOverlay::new(mover(MOVER, 0), [(HOUSE, private_house())]);
        assert!(!allowed(&stranger, MOVER), "a stranger is refused");
        let vassal = BarrierOverlay::new(mover(MOVER, MONARCH), [(HOUSE, private_house())]);
        assert!(allowed(&vassal, MOVER), "allegiance access");
        let guest = BarrierOverlay::new(mover(GUEST, 0), [(HOUSE, private_house())]);
        assert!(allowed(&guest, GUEST), "a listed guest");
        let owner = BarrierOverlay::new(mover(OWNER, 0), [(HOUSE, private_house())]);
        assert!(allowed(&owner, OWNER), "the owner");
        assert!(stranger.get_object_a(0x7000_0001).is_none(), "an unknown object stays unknown");
        assert_eq!(stranger.mover_id(), MOVER);
    }

    #[test]
    fn landcell_restriction_normal_is_axis_aligned() {
        assert_eq!(landcell_restriction_normal(-14.0, 0.0), (-1.0, 0.0), "west of the cell");
        assert_eq!(landcell_restriction_normal(14.0, 3.0), (1.0, 0.0), "east of the cell");
        assert_eq!(landcell_restriction_normal(0.0, 0.0), (1.0, 0.0), "inside: retail's +X default");
        assert_eq!(landcell_restriction_normal(-14.0, 13.0), (0.0, 1.0), "north wins over west");
        assert_eq!(landcell_restriction_normal(14.0, -13.0), (0.0, -1.0), "south wins over east");
        assert_eq!(landcell_restriction_normal(5.0, 12.0), (1.0, 0.0), "the band edge is inclusive");
    }

    #[test]
    fn the_guard_restores_the_previous_overlay() {
        assert!(installed_overlay().is_none());
        {
            let _g = BarrierOverlayGuard::install(Rc::new(BarrierOverlay::new(
                BarrierMover::default(),
                [],
            )));
            assert!(installed_overlay().is_some());
        }
        assert!(installed_overlay().is_none());
    }
}

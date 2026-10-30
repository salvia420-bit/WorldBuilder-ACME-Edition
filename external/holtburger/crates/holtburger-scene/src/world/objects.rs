//! The mirror of one three.js r184 `BatchedMesh` (a chunk bucket, atlas
//! bucket, pool or building batch): its instance table (`_instanceInfo` +
//! `_availableInstanceIds`), its geometry table (`_geometryInfo` +
//! `_availableGeometryIds`) and the f32 matrices three stored, plus what the
//! kernel adds per instance — attribution (landblock, tile, cell) and the
//! visibility it DERIVES from residency events.
//!
//! three hands out the smallest freed id first and appends otherwise
//! (`addInstance` / `addGeometry` sort their free lists and `shift()`), so a
//! `BTreeSet` of free ids predicts every id exactly; the kernel counts any id
//! the stream reports that it did not predict (`slotDesync` / `gidDesync`).

use std::collections::BTreeSet;

use super::events::NONE;

/// `new Matrix4()` as three stores it at `addInstance`.
pub const IDENTITY_F32: [f32; 16] = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];

/// One instance slot (`_instanceInfo[i]` and the kernel's view of it).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Slot {
    /// `_instanceInfo[i].active`.
    pub active: bool,
    /// `_instanceInfo[i].geometryIndex`.
    pub gid: u32,
    /// The visibility the kernel DERIVED from residency / visibility events.
    pub vis: bool,
    /// The last raw `setVisibleAt` (a diagnostic mirror; never an input to `vis`).
    pub raw: bool,
    /// The landblock membership key (chunk / atlas `ATTR_LB`, pool `POOL_ATTR`), or [`NONE`].
    pub lb: u32,
    /// A pool member's grid tile, or [`NONE`].
    pub tile: u32,
    /// A pool member's cell id, or [`NONE`].
    pub cell: u32,
    /// A pool member's LIVE flip has run (`commit()`); always true for other kinds.
    pub committed: bool,
    /// A pool member's cell is outside the PVS set (the registry's `hiddenCells`).
    pub hidden_cell: bool,
    /// The matrix three stored for the instance (`_matricesTexture` row).
    pub m: [f32; 16],
}

impl Slot {
    /// What three's `addInstance(gid)` creates: active, visible, identity matrix.
    pub fn fresh(gid: u32) -> Slot {
        Slot {
            active: true,
            gid,
            vis: true,
            raw: true,
            lb: NONE,
            tile: NONE,
            cell: NONE,
            committed: true,
            hidden_cell: false,
            m: IDENTITY_F32,
        }
    }

    /// A hole left by an id the kernel did not predict (inactive, NOT free:
    /// three's free list would not hold it either).
    pub fn gap() -> Slot {
        Slot { active: false, ..Slot::fresh(0) }
    }
}

/// One geometry range (`_geometryInfo[gid]`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Geom {
    pub active: bool,
    /// `geometryInfo.start` (index start when indexed, else vertex start).
    pub start: f64,
    /// `geometryInfo.count`.
    pub count: f64,
}

/// One tracked draw object.
#[derive(Clone, Debug, Default)]
pub struct DrawObject {
    /// [`super::events::KIND_CHUNK`] …
    pub kind: u32,
    /// A building batch's landblock (`TRACK`), else [`NONE`].
    pub lb: u32,
    /// A pool's registry id, else [`NONE`].
    pub reg: u32,
    pub slots: Vec<Slot>,
    /// Inactive ids three would hand out again (`_availableInstanceIds`).
    pub free: BTreeSet<u32>,
    pub geoms: Vec<Geom>,
    /// `_availableGeometryIds`.
    pub free_geoms: BTreeSet<u32>,
}

impl DrawObject {
    pub fn new(kind: u32, lb: u32, reg: u32) -> DrawObject {
        DrawObject { kind, lb, reg, ..DrawObject::default() }
    }

    /// The id three's `addInstance` hands out next.
    pub fn next_instance_id(&self) -> u32 {
        match self.free.first() {
            Some(&id) => id,
            None => self.slots.len() as u32,
        }
    }

    /// The id three's `addGeometry` hands out next.
    pub fn next_geometry_id(&self) -> u32 {
        match self.free_geoms.first() {
            Some(&id) => id,
            None => self.geoms.len() as u32,
        }
    }

    /// The slot at `iid` when it is active.
    pub fn active_slot(&self, iid: u32) -> Option<&Slot> {
        self.slots.get(iid as usize).filter(|s| s.active)
    }

    /// The slot at `iid` when it is active (mutable).
    pub fn active_slot_mut(&mut self, iid: u32) -> Option<&mut Slot> {
        self.slots.get_mut(iid as usize).filter(|s| s.active)
    }

    /// Put `slot` at `iid`, filling any gap with [`Slot::gap`].
    pub fn set_slot(&mut self, iid: u32, slot: Slot) {
        let i = iid as usize;
        while self.slots.len() < i {
            self.slots.push(Slot::gap());
        }
        if i == self.slots.len() {
            self.slots.push(slot);
        } else {
            self.slots[i] = slot;
        }
    }

    /// Put `g` at `gid`, filling any gap with inactive (non-free) ranges.
    pub fn set_geom(&mut self, gid: u32, g: Geom) {
        let i = gid as usize;
        while self.geoms.len() <= i {
            self.geoms.push(Geom::default());
        }
        self.geoms[i] = g;
    }

    /// three r184 `setInstanceCount`: drop trailing free ids.
    pub fn pop_trailing_free(&mut self) {
        while let Some(last) = self.slots.len().checked_sub(1) {
            if self.free.remove(&(last as u32)) {
                self.slots.pop();
            } else {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_follow_threes_free_lists() {
        let mut o = DrawObject::new(1, NONE, NONE);
        assert_eq!(o.next_instance_id(), 0);
        for i in 0..4 {
            o.set_slot(i, Slot::fresh(0));
        }
        assert_eq!(o.next_instance_id(), 4);
        // delete 3, 2, 0 (in that order): smallest free first, then append
        for i in [3u32, 2, 0] {
            o.slots[i as usize].active = false;
            o.free.insert(i);
        }
        assert_eq!(o.next_instance_id(), 0);
        // setInstanceCount pops 3 and 2 (trailing), keeps 0
        o.pop_trailing_free();
        assert_eq!(o.slots.len(), 2);
        assert_eq!(o.free.iter().copied().collect::<Vec<_>>(), vec![0]);
        assert_eq!(o.next_instance_id(), 0);
    }

    #[test]
    fn gaps_are_inactive_and_not_free() {
        let mut o = DrawObject::new(1, NONE, NONE);
        o.set_slot(3, Slot::fresh(7));
        assert_eq!(o.slots.len(), 4);
        assert!(!o.slots[1].active && o.free.is_empty());
        assert_eq!(o.next_instance_id(), 4);
        assert!(o.active_slot(1).is_none() && o.active_slot(3).is_some());
        o.set_geom(2, Geom { active: true, start: 6.0, count: 3.0 });
        assert_eq!(o.geoms.len(), 3);
        assert_eq!(o.next_geometry_id(), 3);
    }
}

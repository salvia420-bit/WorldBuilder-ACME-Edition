//! LayoutDesc (DAT type 0x21, ID range `0x21000000..=0x21FFFFFF`).
//!
//! UI screen layout descriptor — a tree of `ElementDesc` nodes with
//! per-state property/media overrides. Lives in
//! `client_local_English.dat`. DRW calls this `LayoutDesc` /
//! `DB_TYPE_UI_LAYOUT`.
//!
//! Wire layout (DRW `<type name="LayoutDesc">`):
//!
//! ```text
//!   u32         id                                   (DBObj.HasId)
//!   u32         width
//!   u32         height
//!   u8          bucket_size_index
//!   CompressedUInt num_elements
//!   [u32 key + ElementDesc; num_elements]
//! ```
//!
//! And `ElementDesc`:
//!
//! ```text
//!   StateDesc           state_desc          (variable size; needs master)
//!   u32                 read_order
//!   u32                 element_id
//!   u32                 element_type
//!   u32                 base_element
//!   u32                 base_layout_id
//!   u32                 default_state       (UIStateId)
//!
//!   // Maskmap fields, gated on `state_desc.incorporation_flags`.
//!   // Each field is present iff the corresponding bit is set:
//!   //   X=0x2, Y=0x4, Width=0x8, Height=0x10, ZLevel=0x20.
//!   u32?                x
//!   u32?                y
//!   u32?                width
//!   u32?                height
//!   u32?                z_level
//!
//!   u32                 left_edge
//!   u32                 top_edge
//!   u32                 right_edge
//!   u32                 bottom_edge
//!
//!   u8                  _states_bucket_size
//!   CompressedUInt      num_states
//!   [u32 + StateDesc; num_states]            // Dictionary, no header
//!
//!   u8                  _children_bucket_size
//!   CompressedUInt      num_children
//!   [u32 + ElementDesc; num_children]        // RECURSIVE — Dictionary
//! ```

use crate::file_type::{MasterProperty, StateDesc};
use binrw::io::Seek;
use std::collections::HashMap;
use std::io::Read;

mod incorporation_flags {
    pub const X: u32 = 0x02;
    pub const Y: u32 = 0x04;
    pub const WIDTH: u32 = 0x08;
    pub const HEIGHT: u32 = 0x10;
    pub const Z_LEVEL: u32 = 0x20;
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ElementDesc {
    pub state_desc: StateDesc,
    pub read_order: u32,
    pub element_id: u32,
    pub element_type: u32,
    pub base_element: u32,
    pub base_layout_id: u32,
    pub default_state: u32,
    pub x: Option<u32>,
    pub y: Option<u32>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub z_level: Option<u32>,
    pub left_edge: u32,
    pub top_edge: u32,
    pub right_edge: u32,
    pub bottom_edge: u32,
    pub states: HashMap<u32, StateDesc>,
    pub children: HashMap<u32, ElementDesc>,
}

impl ElementDesc {
    pub fn read_le<R: Read + Seek>(
        reader: &mut R,
        master: &MasterProperty,
    ) -> binrw::BinResult<Self> {
        use binrw::BinRead;

        let state_desc = StateDesc::read_le(reader, master)?;
        let flags = state_desc.incorporation_flags;

        let read_order = u32::read_le(reader)?;
        let element_id = u32::read_le(reader)?;
        let element_type = u32::read_le(reader)?;
        let base_element = u32::read_le(reader)?;
        let base_layout_id = u32::read_le(reader)?;
        let default_state = u32::read_le(reader)?;

        let x = if flags & incorporation_flags::X != 0 {
            Some(u32::read_le(reader)?)
        } else {
            None
        };
        let y = if flags & incorporation_flags::Y != 0 {
            Some(u32::read_le(reader)?)
        } else {
            None
        };
        let width = if flags & incorporation_flags::WIDTH != 0 {
            Some(u32::read_le(reader)?)
        } else {
            None
        };
        let height = if flags & incorporation_flags::HEIGHT != 0 {
            Some(u32::read_le(reader)?)
        } else {
            None
        };
        let z_level = if flags & incorporation_flags::Z_LEVEL != 0 {
            Some(u32::read_le(reader)?)
        } else {
            None
        };

        let left_edge = u32::read_le(reader)?;
        let top_edge = u32::read_le(reader)?;
        let right_edge = u32::read_le(reader)?;
        let bottom_edge = u32::read_le(reader)?;

        // States dictionary (header: u8 bucket + u8 count per ACE
        // ElementDesc.UnpackElementDesc).
        let _states_bucket = u8::read(reader)?;
        let num_states = u8::read(reader)? as usize;
        let mut states = HashMap::with_capacity(num_states);
        for _ in 0..num_states {
            let key = u32::read_le(reader)?;
            let value = StateDesc::read_le(reader, master)?;
            states.insert(key, value);
        }

        // Children dictionary — recursive ElementDesc, same shape.
        let _children_bucket = u8::read(reader)?;
        let num_children = u8::read(reader)? as usize;
        let mut children = HashMap::with_capacity(num_children);
        for _ in 0..num_children {
            let key = u32::read_le(reader)?;
            let value = ElementDesc::read_le(reader, master)?;
            children.insert(key, value);
        }

        Ok(Self {
            state_desc,
            read_order,
            element_id,
            element_type,
            base_element,
            base_layout_id,
            default_state,
            x,
            y,
            width,
            height,
            z_level,
            left_edge,
            top_edge,
            right_edge,
            bottom_edge,
            states,
            children,
        })
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LayoutDesc {
    pub id: u32,
    pub width: u32,
    pub height: u32,
    pub elements: HashMap<u32, ElementDesc>,
}

impl LayoutDesc {
    /// Parse from raw bytes given a pre-parsed MasterProperty (the
    /// singleton 0x39000001 needed to resolve BaseProperty type
    /// tags inside the recursive Element/State tree).
    pub fn unpack(data: &[u8], master: &MasterProperty) -> binrw::BinResult<Self> {
        let mut cursor = binrw::io::Cursor::new(data);
        Self::read_le(&mut cursor, master)
    }

    pub fn read_le<R: Read + Seek>(
        reader: &mut R,
        master: &MasterProperty,
    ) -> binrw::BinResult<Self> {
        use binrw::BinRead;

        let id = u32::read_le(reader)?;
        let width = u32::read_le(reader)?;
        let height = u32::read_le(reader)?;

        // Elements dictionary (u8 bucket + u8 count per ACE LayoutDesc).
        let _bucket = u8::read(reader)?;
        let num_elements = u8::read(reader)? as usize;
        let mut elements = HashMap::with_capacity(num_elements);
        for _ in 0..num_elements {
            let key = u32::read_le(reader)?;
            let value = ElementDesc::read_le(reader, master)?;
            elements.insert(key, value);
        }

        Ok(Self {
            id,
            width,
            height,
            elements,
        })
    }
}

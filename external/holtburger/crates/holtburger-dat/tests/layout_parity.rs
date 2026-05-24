//! Parse every retail LayoutDesc record from `client_local_English.dat`
//! and assert shape invariants. Requires both portal.dat (for the
//! MasterProperty record needed to resolve BaseProperty type keys) and
//! local_English.dat (the actual Layout records). Skipped when either
//! `HOLTBURGER_PORTAL_DAT` or `HOLTBURGER_LOCAL_DAT` is unset.

use binrw::io::Cursor;
use holtburger_dat::file_type::{LayoutDesc, MasterProperty};
use holtburger_dat::{DatDatabase, DatFileType};

mod common;
use common::get_portal_dat_path;

fn get_local_dat_path() -> Option<std::path::PathBuf> {
    std::env::var_os("HOLTBURGER_LOCAL_DAT").map(std::path::PathBuf::from)
}

/// Retail Layout parity. Validates every Layout record in
/// `client_local_English.dat` parses cleanly with the ACE-derived
/// wire-format (StateDesc is a Dictionary with u8 counts; LayoutDesc
/// uses u8 element count; StringInfo is the 12-byte ACE shape).
#[test]
fn all_retail_layouts_parse() {
    let Some(portal_path) = get_portal_dat_path() else {
        println!("Skipping Layout parity: portal.dat not found");
        return;
    };
    let Some(local_path) = get_local_dat_path() else {
        println!("Skipping Layout parity: HOLTBURGER_LOCAL_DAT unset");
        return;
    };

    // Build the MasterProperty record from portal.dat.
    let portal = DatDatabase::new(&portal_path).expect("open portal.dat");
    let master_bytes = portal
        .get_file(0x39000001)
        .expect("read MasterProperty 0x39000001");
    let master = MasterProperty::read_le(&mut Cursor::new(&master_bytes))
        .expect("parse MasterProperty");

    // Walk every Layout record in local_English.dat.
    let local = DatDatabase::new(&local_path).expect("open local_English.dat");
    let local_kind = local.dat_kind();

    let mut layout_ids: Vec<u32> = local
        .files
        .keys()
        .copied()
        .filter(|&id| DatFileType::from_id_in_dat(id, local_kind) == DatFileType::Layout)
        .collect();
    layout_ids.sort_unstable();

    assert!(
        !layout_ids.is_empty(),
        "expected at least one Layout record in local_English.dat",
    );

    let mut total_elements: usize = 0;
    let mut total_states: usize = 0;
    let mut total_children: usize = 0;
    let mut total_properties: usize = 0;
    let mut total_media: usize = 0;
    let mut full_parse_count: usize = 0;
    let mut string_info_blocked: usize = 0;
    let mut size_mismatch_blocked: usize = 0;

    fn walk(
        elements: &std::collections::HashMap<u32, holtburger_dat::file_type::ElementDesc>,
        states: &mut usize,
        children: &mut usize,
        properties: &mut usize,
        media: &mut usize,
    ) {
        for e in elements.values() {
            *properties += e.state_desc.properties.len();
            *media += e.state_desc.media.len();
            for s in e.states.values() {
                *states += 1;
                *properties += s.properties.len();
                *media += s.media.len();
            }
            *children += e.children.len();
            walk(&e.children, states, children, properties, media);
        }
    }

    // Layout records that include a StringInfo BaseProperty cannot be
    // fully parsed yet — see the StringInfo error path in
    // master_property.rs for the scope rationale. Those records get
    // counted in `string_info_blocked` rather than panicking the test
    // so D3 ships a real parity signal for the records we CAN handle
    // (and surfaces the blocked count for the StringInfo follow-on
    // spike to chase down).
    for id in &layout_ids {
        let bytes = local.get_file(*id).unwrap_or_else(|e| {
            panic!("read Layout 0x{id:08X}: {e}");
        });
        let mut cursor = Cursor::new(&bytes);
        match LayoutDesc::read_le(&mut cursor, &master) {
            Ok(layout) => {
                assert_eq!(layout.id, *id, "Layout 0x{id:08X} self-id mismatch");
                let consumed = cursor.position() as usize;
                if consumed != bytes.len() {
                    // Parser returned Ok but didn't consume all bytes —
                    // likely a Layout-level shape difference we haven't
                    // modeled (extra trailer? misread count?). Bucket
                    // alongside the StringInfo gap for the follow-on
                    // spike rather than asserting.
                    size_mismatch_blocked += 1;
                    continue;
                }
                total_elements += layout.elements.len();
                walk(
                    &layout.elements,
                    &mut total_states,
                    &mut total_children,
                    &mut total_properties,
                    &mut total_media,
                );
                full_parse_count += 1;
            }
            Err(e) => {
                let msg = format!("{e}");
                let known_gap = msg.contains("StringInfo")
                    || msg.contains("unknown MasterProperty key")
                    || msg.contains("unknown MediaType")
                    || msg.contains("unknown BasePropertyType")
                    || msg.contains("duplicate-type mismatch")
                    || msg.contains("failed to fill whole buffer")
                    || msg.contains("exceeds sanity cap");
                if known_gap {
                    string_info_blocked += 1;
                    // Print first few failing samples for diagnosis.
                    if string_info_blocked <= 3 {
                        eprintln!("  Layout 0x{id:08X} blocked: {e}");
                    }
                } else {
                    panic!("parse Layout 0x{id:08X} ({} bytes): {e}", bytes.len());
                }
            }
        }
    }

    println!(
        "Layout parity: {fp}/{total} records fully parsed. \
         Totals: {te} top-level elements, {tc} child elements (recursive), {ts} states, {tp} BaseProperty overrides, {tm} MediaDescs",
        fp = full_parse_count,
        total = layout_ids.len(),
        te = total_elements,
        tc = total_children,
        ts = total_states,
        tp = total_properties,
        tm = total_media,
    );

    assert_eq!(
        full_parse_count,
        layout_ids.len(),
        "expected ALL retail Layouts to parse cleanly — got {full_parse_count}/{}, {string_info_blocked} blocked, {size_mismatch_blocked} size-mismatch",
        layout_ids.len(),
    );
}

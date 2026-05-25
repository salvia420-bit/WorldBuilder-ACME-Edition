// Dump gmPaperDollUI (LayoutDesc 0x21000024) so the inventory-plugin
// consumer can confirm element_id → Y mapping matches what its
// hand-tuned PAPERDOLL_SLOTS table expects.
//
// Run: cargo run --release --example paperdoll_layout_dump
//
// Requires: client_portal.dat at /home/wbterminal/ac_base_dats/
// and client_local_English.dat alongside it. Adjust paths if needed.

use std::fs;

const PORTAL_DAT: &str = "/home/wbterminal/ac_base_dats/client_portal.dat";
const LOCAL_DAT: &str = "/home/wbterminal/ac_base_dats/client_local_English.dat";
const PAPERDOLL_LAYOUT_ID: u32 = 0x21000024;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    use holtburger_dat::{DatDatabase, file_type::{LayoutDesc, MasterProperty}};

    let portal = DatDatabase::new(PORTAL_DAT)?;
    let master_bytes = portal.get_file(0x39000001)?;
    let master = MasterProperty::unpack(&master_bytes)?;

    let local = DatDatabase::new(LOCAL_DAT)?;
    let layout_bytes = local.get_file(PAPERDOLL_LAYOUT_ID)?;
    let layout = LayoutDesc::unpack(&layout_bytes, &master)?;

    println!(
        "LayoutDesc 0x{:08X} — {}x{} — {} top-level elements",
        layout.id, layout.width, layout.height, layout.elements.len(),
    );

    // Print full recursive tree, marking element_id + y / top_edge.
    fn dump_el(el: &holtburger_dat::file_type::ElementDesc, depth: usize) {
        let pad = "  ".repeat(depth);
        println!(
            "{pad}element_id=0x{:08X} type={} y={:?} top_edge={} x={:?} left_edge={} w={:?} h={:?}",
            el.element_id, el.element_type,
            el.y, el.top_edge, el.x, el.left_edge, el.width, el.height,
        );
        let mut kids: Vec<_> = el.children.values().collect();
        kids.sort_by_key(|e| e.read_order);
        for c in kids { dump_el(c, depth + 1); }
    }

    let mut top: Vec<_> = layout.elements.values().collect();
    top.sort_by_key(|e| e.read_order);
    for e in top { dump_el(e, 0); }

    // Bonus: list PAPERDOLL_SLOTS element_ids and what the layout
    // says their Y is, so the JS consumer's expected values are clear.
    println!("\n=== PAPERDOLL_SLOTS Y from LayoutDesc ===");
    for (id_hex, name) in PAPERDOLL_ELEMS {
        let id = u32::from_str_radix(&id_hex[2..], 16)?;
        let found = find_by_id(&layout, id);
        match found {
            Some(el) => println!(
                "  {id_hex} ({name}): y={:?} top_edge={} x={:?} left_edge={}",
                el.y, el.top_edge, el.x, el.left_edge,
            ),
            None => println!("  {id_hex} ({name}): NOT FOUND in layout"),
        }
    }

    let _ = layout_bytes; // silence unused warning if any
    let _ = fs::metadata(PORTAL_DAT)?; // sanity
    Ok(())
}

fn find_by_id<'a>(
    layout: &'a holtburger_dat::file_type::LayoutDesc,
    target: u32,
) -> Option<&'a holtburger_dat::file_type::ElementDesc> {
    fn walk<'a>(el: &'a holtburger_dat::file_type::ElementDesc, target: u32) -> Option<&'a holtburger_dat::file_type::ElementDesc> {
        if el.element_id == target { return Some(el); }
        for c in el.children.values() {
            if let Some(found) = walk(c, target) { return Some(found); }
        }
        None
    }
    for el in layout.elements.values() {
        if let Some(found) = walk(el, target) { return Some(found); }
    }
    None
}

const PAPERDOLL_ELEMS: &[(&str, &str)] = &[
    ("0x100005AB", "Head"),
    ("0x100001DA", "Necklace"),
    ("0x100001E1", "Earring (L)"),
    ("0x100005AE", "Upper arm (L)"),
    ("0x100005AC", "Chest armor"),
    ("0x100001E2", "Chest under"),
    ("0x10000596", "Right hand"),
    ("0x100005E9", "Wand/staff"),
    ("0x100005AF", "Lower arm (L)"),
    ("0x100005AD", "Abdomen"),
    ("0x10000595", "Shield"),
    ("0x1000050E", "Aetheria"),
    ("0x100001DB", "Ring (R)"),
    ("0x100005B0", "Gloves"),
    ("0x100001DD", "Ring (L)"),
    ("0x10000597", "Missile"),
    ("0x100005B1", "Upper leg"),
    ("0x100001E3", "Underpants"),
    ("0x100005B2", "Lower leg"),
    ("0x100001DC", "Bracelet (R)"),
    ("0x100001DE", "Bracelet (L)"),
    ("0x100005B3", "Boots"),
];

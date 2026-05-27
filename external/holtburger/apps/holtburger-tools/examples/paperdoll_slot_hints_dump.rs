// Wave 16 — Dump slot-hint icon DIDs from gmPaperDollUI LayoutDesc 0x21000024.
//
// The hint icons (helmet/sword/ring/etc. silhouettes shown in empty
// paperdoll slots) live in each slot ElementDesc's default StateDesc
// as DataId BaseProperty values (not in gmPaperDollUI code, not in
// docs). This walks the layout, locates each of the 22
// PAPERDOLL_SLOTS elements, and prints every property whose master
// type is DataId (or any 0x06xxxxxx value found in Integer/Enum
// slots) plus the property name resolved via MasterProperty.
//
// Run: cargo run --release --example paperdoll_slot_hints_dump
//
// Requires: client_portal.dat at /home/wbterminal/ac_base_dats/
// and client_local_English.dat alongside it.

use holtburger_dat::{DatDatabase, file_type::{LayoutDesc, MasterProperty, ElementDesc, StateDesc, BaseProperty, BasePropertyType}};

const PORTAL_DAT: &str = "/home/wbterminal/ac_base_dats/client_portal.dat";
const LOCAL_DAT: &str = "/home/wbterminal/ac_base_dats/client_local_English.dat";
const PAPERDOLL_LAYOUT_ID: u32 = 0x21000024;

// 22 paperdoll slot element IDs from inventory.js PAPERDOLL_SLOTS.
// The dumper resolves each slot's UI_ItemList_ItemSlotID enum to the
// nested element that carries the hint-icon Background DataId.
const PAPERDOLL_ELEMS: &[(&str, &str, u32)] = &[
    ("0x100001DA", "Necklace",         0x00008000),
    ("0x1000058E", "Trinket",          0x04000000),
    ("0x10000595", "Aetheria Blue",    0x10000000),
    ("0x10000596", "Aetheria Yellow",  0x20000000),
    ("0x10000597", "Aetheria Red",     0x40000000),
    ("0x100005AB", "Head",             0x00000001),
    ("0x100005E9", "Cloak",            0x08000000),
    ("0x100005AE", "Upper arm",        0x00000800),
    ("0x100005AC", "Chest armor",      0x00000200),
    ("0x100001E2", "Shirt",            0x00000002),
    ("0x100005AF", "Lower arm",        0x00001000),
    ("0x100005AD", "Abdomen",          0x00000400),
    ("0x100001DD", "Bracelet (R)",     0x00020000),
    ("0x100001DB", "Bracelet (L)",     0x00010000),
    ("0x100005B1", "Upper leg",        0x00002000),
    ("0x100001E3", "Pants",            0x00000040),
    ("0x100001DE", "Ring (R)",         0x00080000),
    ("0x100001DC", "Ring (L)",         0x00040000),
    ("0x100005B0", "Gloves",           0x00000020),
    ("0x100005B2", "Lower leg",        0x00004000),
    ("0x100001E1", "Shield",           0x00200000),
    ("0x100005B3", "Boots",            0x00000100),
];

// Property name for UI_ItemList_ItemSlotID (dict key in slot states).
const PROP_ITEM_SLOT_ID: u32 = 0x1000000E;

fn main() -> Result<(), Box<dyn std::error::Error>> {
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

    // Build a lookup of property-name → text label from master.enum_mapper.
    let prop_name = |id: u32| -> String {
        master.enum_mapper.id_to_string_map.get(&id).cloned()
            .unwrap_or_else(|| format!("0x{id:08X}"))
    };

    println!("\n=== Walking 22 paperdoll slot elements for DataId hint icons ===\n");

    let mut found = 0usize;
    let mut report = Vec::<(String, String, u32, Vec<(u32, String, u32)>)>::new();

    for (id_hex, name, equip_mask) in PAPERDOLL_ELEMS {
        let id = u32::from_str_radix(&id_hex[2..], 16)?;
        let el = match find_by_id(&layout, id) {
            Some(e) => e,
            None => {
                println!("{id_hex} ({name}): NOT FOUND in layout");
                continue;
            }
        };
        let mut hits: Vec<(u32, String, u32)> = Vec::new();
        println!(
            "{id_hex} ({name}) eq=0x{:08X}  default_state=0x{:08X}  states={}",
            equip_mask, el.default_state, el.states.len()
        );
        // The element has its own state_desc.properties AND a map of
        // additional states (Normal/MouseOver/etc.).
        dump_state(&el.state_desc, &master, &prop_name, "  base:    ", &mut hits);
        for (sid, sd) in &el.states {
            dump_state(sd, &master, &prop_name, &format!("  state {sid:08X}: "), &mut hits);
        }
        // Also dump any child elements (some slots wrap an UIItem child
        // that holds the icon).
        for (cid, child) in &el.children {
            println!("  child element 0x{cid:08X} (type={}):", child.element_type);
            dump_state(&child.state_desc, &master, &prop_name, "    base:    ", &mut hits);
            for (sid, sd) in &child.states {
                dump_state(sd, &master, &prop_name, &format!("    state {sid:08X}: "), &mut hits);
            }
        }
        if !hits.is_empty() {
            found += 1;
        }
        report.push((id_hex.to_string(), name.to_string(), *equip_mask, hits));
        println!();
    }

    println!("=== Summary: {}/22 slots had at least one DataId in state ===\n", found);
    println!("| Slot | EquipMask | Hint DIDs | PropertyNames |");
    println!("|---|---|---|---|");
    for (id_hex, name, eq, hits) in &report {
        if hits.is_empty() {
            println!("| {name} ({id_hex}) | 0x{eq:08X} | NONE | — |");
        } else {
            let dids = hits.iter()
                .map(|(_,_,did)| format!("0x{did:08X}"))
                .collect::<Vec<_>>().join(", ");
            let names = hits.iter()
                .map(|(_,n,_)| n.clone())
                .collect::<Vec<_>>().join(", ");
            println!("| {name} ({id_hex}) | 0x{eq:08X} | {dids} | {names} |");
        }
    }

    Ok(())
}

fn dump_state(
    sd: &StateDesc,
    master: &MasterProperty,
    prop_name: &impl Fn(u32) -> String,
    prefix: &str,
    hits: &mut Vec<(u32, String, u32)>,
) {
    if sd.properties.is_empty() { return; }
    for (dict_key, val) in &sd.properties {
        // Look up the master property entry to learn the property's
        // type & name (the dict_key is typically a property-name id).
        let desc = master.properties.get(dict_key);
        let name = desc.map(|d| prop_name(d.name)).unwrap_or_else(|| prop_name(*dict_key));
        match val {
            BaseProperty::DataId(d) => {
                println!("{prefix}prop=0x{dict_key:08X} ({name}) DataId=0x{d:08X}");
                hits.push((*dict_key, name, *d));
            }
            BaseProperty::Integer(i) if (*i as u32) >> 24 == 0x06 => {
                println!("{prefix}prop=0x{dict_key:08X} ({name}) Integer=0x{:08X} (looks like 0x06 DID)", *i as u32);
                hits.push((*dict_key, name, *i as u32));
            }
            BaseProperty::Enum(e) if (*e) >> 24 == 0x06 => {
                println!("{prefix}prop=0x{dict_key:08X} ({name}) Enum=0x{e:08X} (looks like 0x06 DID)");
                hits.push((*dict_key, name, *e));
            }
            BaseProperty::Bool(b) => {
                println!("{prefix}prop=0x{dict_key:08X} ({name}) Bool={b}");
            }
            BaseProperty::Integer(i) => {
                println!("{prefix}prop=0x{dict_key:08X} ({name}) Integer={i}");
            }
            BaseProperty::Float(f) => {
                println!("{prefix}prop=0x{dict_key:08X} ({name}) Float={f}");
            }
            BaseProperty::Enum(e) => {
                println!("{prefix}prop=0x{dict_key:08X} ({name}) Enum=0x{e:08X}");
            }
            BaseProperty::InstanceId(iid) => {
                println!("{prefix}prop=0x{dict_key:08X} ({name}) InstanceId=0x{iid:08X}");
            }
            BaseProperty::StringInfo { string_id, table_id, .. } => {
                println!("{prefix}prop=0x{dict_key:08X} ({name}) StringInfo str=0x{string_id:08X} tbl=0x{table_id:08X}");
            }
            BaseProperty::Color { r, g, b, a } => {
                println!("{prefix}prop=0x{dict_key:08X} ({name}) Color rgba=({r},{g},{b},{a})");
            }
            BaseProperty::Vector { x, y, z } => {
                println!("{prefix}prop=0x{dict_key:08X} ({name}) Vector=({x},{y},{z})");
            }
            BaseProperty::Bitfield32(bf) => {
                println!("{prefix}prop=0x{dict_key:08X} ({name}) Bitfield32=0x{bf:08X}");
            }
            BaseProperty::Bitfield64(bf) => {
                println!("{prefix}prop=0x{dict_key:08X} ({name}) Bitfield64=0x{bf:016X}");
            }
            BaseProperty::Array(a) => {
                println!("{prefix}prop=0x{dict_key:08X} ({name}) Array(len={})", a.len());
            }
            BaseProperty::Struct(s) => {
                println!("{prefix}prop=0x{dict_key:08X} ({name}) Struct(keys={})", s.len());
            }
        }
    }
    let _ = (BasePropertyType::Bool, ElementDesc { state_desc: sd.clone(), read_order: 0, element_id: 0, element_type: 0, base_element: 0, base_layout_id: 0, default_state: 0, x: None, y: None, width: None, height: None, z_level: None, left_edge: 0, top_edge: 0, right_edge: 0, bottom_edge: 0, states: Default::default(), children: Default::default() });
}

fn find_by_id<'a>(
    layout: &'a LayoutDesc,
    target: u32,
) -> Option<&'a ElementDesc> {
    fn walk<'a>(el: &'a ElementDesc, target: u32) -> Option<&'a ElementDesc> {
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

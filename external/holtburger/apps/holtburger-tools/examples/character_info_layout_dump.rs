// Dump gmCharacterInfoUI (LayoutDesc 0x2100001A, the parent panel) and
// its three tab content layouts:
//   - gmAttributeUI       0x2100002C
//   - gmSkillUI           0x2100002D
//   - gmCharacterTitleUI  0x2100005E
//
// Provides element_id → position mapping for the character-info plugin's
// Option B layout port (tab strip + per-tab content + attribute rows +
// skill rows + title rows).

const PORTAL_DAT: &str = "/home/wbterminal/ac_base_dats/client_portal.dat";
const LOCAL_DAT: &str = "/home/wbterminal/ac_base_dats/client_local_English.dat";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    use holtburger_dat::{DatDatabase, file_type::{LayoutDesc, MasterProperty}};

    let portal = DatDatabase::new(PORTAL_DAT)?;
    let master = MasterProperty::unpack(&portal.get_file(0x39000001)?)?;
    let local = DatDatabase::new(LOCAL_DAT)?;

    for id in [0x2100001Au32, 0x2100002Cu32, 0x2100002Du32, 0x2100005Eu32] {
        println!("\n──────────────────────────────────────────────────────────");
        let bytes = local.get_file(id)?;
        let layout = LayoutDesc::unpack(&bytes, &master)?;
        println!(
            "LayoutDesc 0x{:08X} — {}x{} — {} top-level elements ({} bytes)",
            layout.id, layout.width, layout.height, layout.elements.len(), bytes.len(),
        );

        fn dump_el(el: &holtburger_dat::file_type::ElementDesc, depth: usize) {
            let pad = "  ".repeat(depth);
            let states = if el.states.is_empty() { String::new() } else { format!(" states={}", el.states.len()) };
            println!(
                "{pad}id=0x{:08X} type={} pos=({:?},{:?}) edge=({},{}) size=({:?}×{:?}) edges=R{} B{} default_state={} read_order={}{} children={}",
                el.element_id, el.element_type,
                el.x, el.y, el.left_edge, el.top_edge,
                el.width, el.height, el.right_edge, el.bottom_edge,
                el.default_state, el.read_order, states,
                el.children.len(),
            );
            let mut kids: Vec<_> = el.children.values().collect();
            kids.sort_by_key(|e| e.read_order);
            for c in kids { dump_el(c, depth + 1); }
        }

        let mut top: Vec<_> = layout.elements.values().collect();
        top.sort_by_key(|e| e.read_order);
        for el in top { dump_el(el, 0); }
    }
    Ok(())
}

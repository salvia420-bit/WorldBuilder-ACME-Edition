// Dump gmConfigUI (LayoutDesc 0x21000029) so the options-panel plugin
// can confirm element_id → position mapping for the 8-tab strip,
// content area, and Cancel/Apply/OK buttons. Also dump the per-tab
// content sub-layout 0x21000293 for reference (G3-pending: StateDesc
// not serialized via fetch_layout yet).

const PORTAL_DAT: &str = "/home/wbterminal/ac_base_dats/client_portal.dat";
const LOCAL_DAT: &str = "/home/wbterminal/ac_base_dats/client_local_English.dat";
const OPTIONS_LAYOUT_ID: u32 = 0x21000029;
const OPTIONS_TAB_CONTENT_LAYOUT_ID: u32 = 0x21000293;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    use holtburger_dat::{DatDatabase, file_type::{LayoutDesc, MasterProperty}};

    let portal = DatDatabase::new(PORTAL_DAT)?;
    let master = MasterProperty::unpack(&portal.get_file(0x39000001)?)?;
    let local = DatDatabase::new(LOCAL_DAT)?;

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

    fn dump_layout(local: &DatDatabase, portal: &DatDatabase, master: &MasterProperty, id: u32, label: &str) -> Result<(), Box<dyn std::error::Error>> {
        // Layouts can live in either client_local_English or client_portal;
        // try both before reporting NotFound.
        let bytes = match local.get_file(id) {
            Ok(b) => b,
            Err(_) => match portal.get_file(id) {
                Ok(b) => b,
                Err(e) => {
                    println!("\n=== {label} LayoutDesc 0x{:08X} — NOT FOUND ({e:?}) ===", id);
                    return Ok(());
                }
            },
        };
        let layout = LayoutDesc::unpack(&bytes, master)?;
        println!(
            "\n=== {label} LayoutDesc 0x{:08X} — {}x{} — {} top-level elements ({} bytes) ===",
            layout.id, layout.width, layout.height, layout.elements.len(), bytes.len(),
        );
        let mut top: Vec<_> = layout.elements.values().collect();
        top.sort_by_key(|e| e.read_order);
        for el in top { dump_el(el, 0); }
        Ok(())
    }

    dump_layout(&local, &portal, &master, OPTIONS_LAYOUT_ID, "gmConfigUI")?;
    dump_layout(&local, &portal, &master, OPTIONS_TAB_CONTENT_LAYOUT_ID, "Tab content sub-layout")?;
    Ok(())
}

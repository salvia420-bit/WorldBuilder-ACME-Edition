// Survey all elements in gmInventoryUI (0x21000023) and gmPaperDollUI
// (0x21000024) so we can see which hand-tuned positions in
// inventory.js correspond to layout elements.
//
// Run: cargo run --release --example inventory_layouts_dump

const PORTAL_DAT: &str = "/home/wbterminal/ac_base_dats/client_portal.dat";
const LOCAL_DAT: &str = "/home/wbterminal/ac_base_dats/client_local_English.dat";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    use holtburger_dat::{DatDatabase, file_type::{LayoutDesc, MasterProperty}};

    let portal = DatDatabase::new(PORTAL_DAT)?;
    let master = MasterProperty::unpack(&portal.get_file(0x39000001)?)?;
    let local = DatDatabase::new(LOCAL_DAT)?;

    for id in [0x21000023u32, 0x21000024u32] {
        let bytes = local.get_file(id)?;
        let layout = LayoutDesc::unpack(&bytes, &master)?;
        println!("\n===== LayoutDesc 0x{:08X} — {}x{} — {} top-level elements =====",
            layout.id, layout.width, layout.height, layout.elements.len());
        let mut top: Vec<_> = layout.elements.values().collect();
        top.sort_by_key(|e| e.read_order);
        for el in top { dump_el(el, 0); }
    }
    Ok(())
}

fn dump_el(el: &holtburger_dat::file_type::ElementDesc, depth: usize) {
    let pad = "  ".repeat(depth);
    println!(
        "{pad}id=0x{:08X} type={} pos=({:?},{:?}) edge=({},{}) size=({:?}×{:?}) edges=R{} B{} children={}",
        el.element_id, el.element_type,
        el.x, el.y, el.left_edge, el.top_edge,
        el.width, el.height, el.right_edge, el.bottom_edge,
        el.children.len(),
    );
    let mut kids: Vec<_> = el.children.values().collect();
    kids.sort_by_key(|e| e.read_order);
    for c in kids { dump_el(c, depth + 1); }
}

//! Dump surface 0x080003E4 (Beaten Doll part_1, a luminous Base1ClipMap that
//! renders as a white box) — texture format, indices, and palette alphas — to
//! diagnose whether the clipmap's alpha cutout is recoverable from the DAT or
//! the palette is genuinely opaque.
//!
//! Usage: cargo run -p holtburger-dat --example dump_surface_80003e4 -- [portal_dat]
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::{Palette, Surface, SurfacePixelFormat, SurfaceTexture, Texture};
use std::collections::BTreeSet;
use std::env;

fn dump_palette(dat: &DatDatabase, pid: u32, indices: &BTreeSet<u8>) {
    if pid == 0 {
        return;
    }
    let pbytes = match dat.get_file(pid) {
        Ok(b) => b,
        Err(e) => {
            println!("palette {pid:#010X}: ERR {e}");
            return;
        }
    };
    let pal = match Palette::unpack(&pbytes) {
        Ok(p) => p,
        Err(e) => {
            println!("palette {pid:#010X}: unpack ERR {e}");
            return;
        }
    };
    println!("=== Palette {pid:#010X} ({} colors) ===", pal.colors.len());
    // overall alpha stats
    let (mut a_min, mut a_max, mut a0) = (255u32, 0u32, 0u32);
    for &c in &pal.colors {
        let a = (c >> 24) & 0xFF;
        a_min = a_min.min(a);
        a_max = a_max.max(a);
        if a == 0 {
            a0 += 1;
        }
    }
    println!("  alpha range [{a_min}, {a_max}], {a0} entries with alpha==0 / {} total", pal.colors.len());
    // always show the first 16 entries (Index16 all-zero texture only uses idx 0)
    for i in 0..16usize.min(pal.colors.len()) {
        let c = pal.colors[i];
        println!(
            "  [{i:3}] {c:#010X}  (a={}, r={}, g={}, b={})",
            (c >> 24) & 0xFF,
            (c >> 16) & 0xFF,
            (c >> 8) & 0xFF,
            c & 0xFF
        );
    }
    // per-index colour for the indices this texture actually uses
    for &idx in indices {
        let c = pal.colors.get(idx as usize).copied().unwrap_or(0);
        println!(
            "  idx {idx:3} -> {c:#010X}  (a={}, r={}, g={}, b={})",
            (c >> 24) & 0xFF,
            (c >> 16) & 0xFF,
            (c >> 8) & 0xFF,
            c & 0xFF
        );
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let path = args
        .first()
        .map(|s| s.as_str())
        .unwrap_or("/home/wbterminal/ac_base_dats/client_portal.dat");
    let dat = DatDatabase::new(path).expect("open dat");

    let surf_id = 0x0800_03E4u32;
    let bytes = dat.get_file(surf_id).expect("get surface");
    let surf = Surface::unpack(&bytes).expect("unpack surface");
    println!("=== Surface {surf_id:#010X} ===");
    println!("surface_type = {:#010X}", surf.surface_type);
    println!("color_value  = {:?}", surf.color_value.map(|c| format!("{c:#010X}")));
    println!(
        "translucency = {}, luminosity = {}, diffuse = {}",
        surf.translucency, surf.luminosity, surf.diffuse
    );
    let (tex_ref, pal_ref) = match &surf.texture_refs {
        Some(t) => (t.orig_texture_id, t.orig_palette_id),
        None => {
            println!("no texture_refs");
            return;
        }
    };
    println!("orig_texture_id = {tex_ref:#010X}, orig_palette_id = {pal_ref:#010X}");

    // resolve the texture chain: 0x05 SurfaceTexture -> 0x06 Texture
    let tex_id = if (tex_ref >> 24) == 0x05 {
        let stb = dat.get_file(tex_ref).expect("get surfacetexture");
        let st = SurfaceTexture::unpack(&stb).expect("unpack surfacetexture");
        println!(
            "SurfaceTexture {tex_ref:#010X} -> textures {:?}",
            st.textures.iter().map(|t| format!("{t:#010X}")).collect::<Vec<_>>()
        );
        st.textures[0]
    } else {
        tex_ref
    };

    let tb = dat.get_file(tex_id).expect("get texture");
    let tex = Texture::unpack(&tb).expect("unpack texture");
    println!("=== Texture {tex_id:#010X} ===");
    println!(
        "format = {:?} ({:#X}), {}x{}, source_data.len = {}, default_palette_id = {:?}",
        tex.format(),
        tex.format_raw,
        tex.width,
        tex.height,
        tex.source_data.len(),
        tex.default_palette_id.map(|p| format!("{p:#010X}"))
    );

    let indices: BTreeSet<u8> = if matches!(tex.format(), SurfacePixelFormat::P8) {
        tex.source_data.iter().copied().collect()
    } else {
        BTreeSet::new()
    };
    println!("unique P8 indices ({}): {:?}", indices.len(), indices);
    if tex.source_data.len() <= 256 {
        println!("source_data bytes: {:?}", tex.source_data);
    }

    for pid in [tex.default_palette_id.unwrap_or(0), pal_ref, 0x0400_10BE, 0x0400_0DC0] {
        dump_palette(&dat, pid, &indices);
    }
}

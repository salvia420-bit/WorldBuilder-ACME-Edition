//! bake_world_terrain — the whole-world terrain grids for the flight-experience WORLD TIER
//! (docs/flight-experience-2026-11-01, Phase 4; client `apps/holtburger-web/scene3d/world_terrain.js`).
//!
//! The near ring and the far composite ring fetch terrain per landblock (~2 KB each, 6-9 ms cold), which
//! cannot scale to the 65,025 landblocks visible from 4.5 km. This bakes the whole map ONCE, from the base
//! DATs only (project rule *bake-base-dats-only*), into two vertex grids the client loads as textures:
//!
//!   world_height.u8   2041 x 2041 bytes — the LandHeightTable INDEX of every terrain vertex (the exact
//!                     retail decode is `table[index]`, `holtburger_dat::landblock::decode_land_height`)
//!   world_types.u8    2041 x 2041 bytes — terrain type (bits 0-4) | road (bits 5-6) | 0x80 = no record (sea)
//!   world_meta.json   dimensions, the 256-entry LandHeightTable, missing-landblock count, layout notes
//!
//! Layout: row-major, ROW = global vertex y (AC +y north, row 0 = the south edge), COLUMN = global vertex x
//! (AC +x east). Global vertex (gx, gy) = (lbX * 8 + vx, lbY * 8 + vy); a vertex shared by two landblocks
//! (vx = 8 of one, vx = 0 of the next) is taken from the landblock that owns it as vertex 0, so the grid is
//! continuous. Landblocks 0x00..=0xFE on each axis (0x__FF ids are not world landblocks); 255 * 8 + 1 = 2041.
//! A landblock with no CellLandblock record is ocean: height index 0, type 20 (WaterDeepSea) | 0x80.
//!
//! Usage:
//!   capped-build cargo run -p holtburger-dat --release --example bake_world_terrain -- <out_dir>
//! Then `sha256sum ~/ac_base_dats/client_cell_1.dat ~/ac_base_dats/client_portal.dat > <out_dir>/bake-source.sha256`.

use binrw::io::Cursor;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::Region;
use holtburger_dat::landblock::CellLandblock;
use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;

const LB_COUNT: usize = 255; // 0x00..=0xFE
const DIM: usize = LB_COUNT * 8 + 1; // 2041
const SEA_TYPE: u8 = 20; // WaterDeepSea
const NO_RECORD: u8 = 0x80;

fn main() -> ExitCode {
    let out_dir = match std::env::args().nth(1) {
        Some(d) => PathBuf::from(d),
        None => {
            eprintln!("usage: bake_world_terrain <out_dir>");
            return ExitCode::from(2);
        }
    };
    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/wbterminal".into());
    let portal = std::env::var("HOLTBURGER_PORTAL_DAT").map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(&home).join("ac_base_dats/client_portal.dat"));
    let cell = std::env::var("HOLTBURGER_CELL_DAT").map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(&home).join("ac_base_dats/client_cell_1.dat"));
    if !portal.to_string_lossy().contains("ac_base_dats") || !cell.to_string_lossy().contains("ac_base_dats") {
        eprintln!("refusing: bake from the base DATs only (~/ac_base_dats), got {portal:?} / {cell:?}");
        return ExitCode::from(2);
    }
    let pdat = match DatDatabase::new(&portal) {
        Ok(d) => d,
        Err(e) => { eprintln!("open {portal:?}: {e}"); return ExitCode::from(2); }
    };
    let region_bytes = match pdat.get_file(0x1300_0000) {
        Ok(b) => b,
        Err(e) => { eprintln!("region 0x13000000: {e}"); return ExitCode::from(2); }
    };
    let region = match Region::unpack(&mut Cursor::new(&region_bytes)) {
        Ok(r) => r,
        Err(e) => { eprintln!("parse region: {e}"); return ExitCode::from(2); }
    };
    let table: Vec<f32> = region.land_defs.land_height_table.to_vec();
    let cdat = match DatDatabase::new(&cell) {
        Ok(d) => d,
        Err(e) => { eprintln!("open {cell:?}: {e}"); return ExitCode::from(2); }
    };

    let mut heights = vec![0u8; DIM * DIM];
    let mut types = vec![SEA_TYPE | NO_RECORD; DIM * DIM];
    let mut missing = 0usize;
    let mut present = 0usize;
    let mut max_h = 0.0f32;
    for lbx in 0..LB_COUNT {
        for lby in 0..LB_COUNT {
            let id: u32 = ((lbx as u32) << 24) | ((lby as u32) << 16) | 0xFFFF;
            let clb = match cdat.get_file(id).ok().and_then(|b| CellLandblock::unpack(&b).ok()) {
                Some(c) => c,
                None => { missing += 1; continue; }
            };
            present += 1;
            for vx in 0..9usize {
                for vy in 0..9usize {
                    // a shared edge vertex belongs to the landblock that has it as vertex 0, unless this is the
                    // last landblock on that axis (or the neighbour has no record and never writes it)
                    let gx = lbx * 8 + vx;
                    let gy = lby * 8 + vy;
                    let i = gy * DIM + gx;
                    let owned_x = vx < 8 || lbx == LB_COUNT - 1;
                    let owned_y = vy < 8 || lby == LB_COUNT - 1;
                    if !(owned_x && owned_y) && (types[i] & NO_RECORD) == 0 {
                        continue; // the neighbour that owns this vertex already wrote it
                    }
                    let idx = clb.height[vx * 9 + vy];
                    heights[i] = idx;
                    let t = clb.terrain_type(vx, vy) & 0x1F;
                    let r = clb.road_type(vx, vy) & 0x03;
                    types[i] = t | (r << 5);
                    let h = table.get(idx as usize).copied().unwrap_or(idx as f32 * 2.0);
                    if h > max_h { max_h = h; }
                }
            }
        }
    }
    if let Err(e) = std::fs::create_dir_all(&out_dir) {
        eprintln!("mkdir {out_dir:?}: {e}");
        return ExitCode::from(2);
    }
    let write = |name: &str, bytes: &[u8]| -> std::io::Result<()> {
        let mut f = std::fs::File::create(out_dir.join(name))?;
        f.write_all(bytes)
    };
    if let Err(e) = write("world_height.u8", &heights).and_then(|_| write("world_types.u8", &types)) {
        eprintln!("write: {e}");
        return ExitCode::from(2);
    }
    let table_json: Vec<String> = table.iter().map(|v| format!("{v}")).collect();
    let meta = format!(
        "{{\n \"schema\": \"hb-world-terrain-v1\",\n \"width\": {DIM},\n \"height\": {DIM},\n \"landblocks\": {LB_COUNT},\n \
         \"cellSizeM\": 24,\n \"layout\": \"row = global vertex y (south to north), col = global vertex x (west to east); vertex (lbX*8+vx, lbY*8+vy)\",\n \
         \"types\": \"bits 0-4 terrain type, bits 5-6 road, 0x80 = no CellLandblock record (ocean)\",\n \
         \"present\": {present},\n \"missing\": {missing},\n \"maxHeightM\": {max_h},\n \
         \"landHeightTable\": [{}]\n}}\n",
        table_json.join(", ")
    );
    if let Err(e) = write("world_meta.json", meta.as_bytes()) {
        eprintln!("write meta: {e}");
        return ExitCode::from(2);
    }
    eprintln!("[bake_world_terrain] {DIM}x{DIM} vertices, {present} landblocks, {missing} missing (ocean), max height {max_h} m -> {out_dir:?}");
    ExitCode::SUCCESS
}

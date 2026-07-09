//! probe_walkin — replay the walk-in repro (@teleloc 0xA9B4001E 87 129.5 66.05)
//! against real DAT data, natively: build CellMembership + cell AABBs for every
//! EnvCell in LB 0xA9B4 exactly the way `fetchEnvCellsInLandblock` does, then
//! call `entered_envcell_for_outdoor_pose` and print per-cell verdicts for the
//! Holtburg blacksmith (0xA9B40100).
use holtburger_common::position::WorldPosition;
use holtburger_common::{Aabb, Guid, Vector3};
use holtburger_dat::file_type::{EnvCell, Environment};
use holtburger_dat::DatDatabase;
use holtburger_world::spatial::{CellMembership, SpatialScene, PLAYER_CAPSULE_RADIUS};
use std::collections::HashMap;
use std::io::Cursor;

fn main() {
    let cell_dat = DatDatabase::new("/home/wbterminal/ac_base_dats/client_cell_1.dat").unwrap();
    let portal = DatDatabase::new("/home/wbterminal/ac_base_dats/client_portal.dat").unwrap();
    let lb: u32 = 0xA9B4;
    let lb_high = lb << 16;
    let lb_x = ((lb >> 8) & 0xFF) as f32 * 192.0;
    let lb_y = (lb & 0xFF) as f32 * 192.0;

    let mut env_cache: HashMap<u32, Environment> = HashMap::new();
    let mut scene = SpatialScene::new();
    let mut loaded = 0usize;
    let mut with_membership = 0usize;
    let mut diag_lines: Vec<String> = vec![];

    for low in 0x0100u32..0x0200 {
        let did = lb_high | low;
        let Ok(bytes) = cell_dat.get_file(did) else { continue };
        let Ok(ec) = EnvCell::unpack(&mut Cursor::new(bytes)) else { continue };
        let env_id = 0x0D00_0000u32 | ec.environment_id as u32;
        if !env_cache.contains_key(&env_id) {
            if let Ok(eb) = portal.get_file(env_id) {
                if let Ok(e) = Environment::unpack(&mut Cursor::new(eb)) {
                    env_cache.insert(env_id, e);
                }
            }
        }
        let Some(env) = env_cache.get(&env_id) else { continue };
        let Some(cs) = env.cells.get(&(ec.cell_structure as u32)) else { continue };

        let origin = Vector3::new(
            ec.position.origin.x + lb_x,
            ec.position.origin.y + lb_y,
            ec.position.origin.z,
        );
        let orientation = ec.position.orientation;

        // AABB from the cellstruct's drawing vertices transformed to world —
        // same vertex set the render-mesh bbox in fetchEnvCellsInLandblock
        // bounds.
        let mut aabb = Aabb::empty();
        for v in cs.vertex_array.vertices.values() {
            let local = Vector3::new(v.origin.x, v.origin.y, v.origin.z);
            let w = orientation.rotate_vector(local) + origin;
            aabb.expand_to_include_point(w);
        }
        if aabb.is_empty() {
            continue;
        }
        scene.insert_cell_aabb(did, aabb.clone());
        loaded += 1;

        if let Some(tree) = &cs.cell_bsp {
            scene.insert_cell_membership(
                did,
                CellMembership {
                    tree: tree.clone(),
                    origin,
                    orientation,
                },
            );
            with_membership += 1;
        }

        if low == 0x0100 {
            diag_lines.push(format!(
                "cell 0x{did:08X}: env=0x{env_id:08X} cs={} origin=({:.2},{:.2},{:.2}) q=({:.3},{:.3},{:.3},{:.3}) has_cell_bsp={} aabb=({:.1},{:.1},{:.1})..({:.1},{:.1},{:.1})",
                ec.cell_structure,
                origin.x, origin.y, origin.z,
                orientation.w, orientation.x, orientation.y, orientation.z,
                cs.cell_bsp.is_some(),
                aabb.min.x, aabb.min.y, aabb.min.z, aabb.max.x, aabb.max.y, aabb.max.z
            ));
        }
    }

    println!("loaded {loaded} cells, {with_membership} with membership BSP");
    for l in &diag_lines {
        println!("{l}");
    }

    // The repro pose: outdoor cell 0x001E, standing inside the blacksmith.
    let pose = WorldPosition {
        landblock_id: Guid(lb_high | 0x001E),
        coords: Vector3::new(87.0, 129.5, 66.06),
        rotation: holtburger_common::Quaternion::identity(),
    };
    let global = pose.global_coords();
    println!(
        "probe pose: lb=0x{:08X} local=(87,129.5,66.06) global=({:.2},{:.2},{:.2}) is_indoors={}",
        pose.landblock_id.0, global.x, global.y, global.z, pose.is_indoors()
    );

    // Per-cell verdict for the blacksmith specifically.
    let bs = lb_high | 0x0100;
    if let Some(m) = scene.cell_membership(bs) {
        let local = m.world_to_local(global);
        let point_in = m.tree.point_inside_cell(&local);
        let verdict = m.tree.sphere_intersects_cell(&local, PLAYER_CAPSULE_RADIUS);
        println!(
            "blacksmith 0x{bs:08X}: local=({:.3},{:.3},{:.3}) point_inside_cell={point_in} sphere_verdict={verdict:?}",
            local.x, local.y, local.z
        );
    } else {
        println!("blacksmith 0x{bs:08X}: NO membership entry");
    }

    match scene.entered_envcell_for_outdoor_pose(&pose, PLAYER_CAPSULE_RADIUS) {
        Some(c) => println!("entered_envcell_for_outdoor_pose -> Some(0x{c:08X})  ✅ flip fires"),
        None => println!("entered_envcell_for_outdoor_pose -> None  ❌ flip does NOT fire"),
    }
}

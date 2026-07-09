// FAITHFUL multi-cell walk sim of the fix. Load ALL env847 cells into a real SpatialScene
// (world-frame AABBs + triangles + portals, like the live bake). Then walk the player with
// per-tick current_cell re-derivation + per-cell triangle clamp, applying the FIX's relaxed-net
// rule (relax containment for interior-doorway cells too). Sweep many start cells x many headings;
// flag any tick sequence whose center ends OUTSIDE every cell's AABB while is_indoors stays latched.
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::{Environment, EnvCell};
use holtburger_common::{Triangle, Vector3, Quaternion, Guid, Aabb};
use holtburger_common::position::WorldPosition;
use holtburger_world::SpatialScene;
use holtburger_world::spatial::{clamp_delta_against_cell_walls_with_normal, clamp_delta_to_cell_interior, PLAYER_CAPSULE_RADIUS, PLAYER_CAPSULE_HEIGHT};
use std::io::Cursor;

fn main(){
    let cd=DatDatabase::new("/home/wbterminal/ac_base_dats/client_cell_1.dat").unwrap();
    let pd=DatDatabase::new("/home/wbterminal/ac_base_dats/client_portal.dat").unwrap();
    let env=Environment::unpack(&mut Cursor::new(pd.get_file(0x0D00_034Fu32).unwrap())).unwrap();
    let lbh=0xA9B4_0000u32;
    let lboff=(169.0f32*192.0, 180.0f32*192.0); // global offset of LB 0xA9B4
    let mut scene=SpatialScene::new();
    // cell_id_low -> (interior_only, aabb_global, has_outdoor)
    let mut cellmeta:Vec<(u32,bool,Aabb,bool)>=vec![];
    for cid in 256u32..=272 {
        let Ok(b)=cd.get_file(lbh|cid) else {continue;};
        let Ok(ec)=EnvCell::unpack(&mut Cursor::new(b)) else {continue;};
        let cs=ec.cell_structure as u32; let o=ec.position.origin; let q=ec.position.orientation;
        let Some(c)=env.cells.get(&cs) else {continue;};
        let full=lbh|cid;
        let has_outdoor=ec.portals.iter().any(|p|(p.other_cell_id as u32)>=0xFFFE);
        // global-frame triangles + AABB
        let(mut a,mut bb,mut d,mut f,mut g,mut h)=(f32::MAX,f32::MIN,f32::MAX,f32::MIN,f32::MAX,f32::MIN);
        for poly in c.physics_polygons.values(){
            if poly.num_pts<3{continue;}
            let mut wv=vec![];let mut ok=true;
            for &vid in &poly.vertex_ids{if let Some(v)=c.vertex_array.vertices.get(&(vid as u16)){let r=q.rotate_vector(Vector3::new(v.origin.x,v.origin.y,v.origin.z));let gv=Vector3::new(o.x+r.x+lboff.0,o.y+r.y+lboff.1,o.z+r.z);a=a.min(gv.x);bb=bb.max(gv.x);d=d.min(gv.y);f=f.max(gv.y);g=g.min(gv.z);h=h.max(gv.z);wv.push(gv);}else{ok=false;break;}}
            if !ok||wv.len()<3{continue;}
            for i in 1..wv.len()-1{scene.insert_cell_triangle(full,Triangle::new(wv[0],wv[i],wv[i+1]));}
        }
        if a>bb{continue;}
        let aabb=Aabb::new(Vector3::new(a,d,g),Vector3::new(bb,f,h));
        scene.insert_cell_aabb(full,aabb);
        // portals: insert edges (cell low -> neighbor low or 0xFFFF)
        for p in &ec.portals { scene.insert_cell_portal(full, lbh|(p.other_cell_id as u32 & 0xFFFF)); }
        cellmeta.push((cid, !has_outdoor, aabb, has_outdoor));
    }
    let all_aabbs:Vec<Aabb>=cellmeta.iter().map(|c|c.2).collect();
    let bxn=all_aabbs.iter().map(|a|a.min.x).fold(f32::MAX,f32::min);
    let bxx=all_aabbs.iter().map(|a|a.max.x).fold(f32::MIN,f32::max);
    let byn=all_aabbs.iter().map(|a|a.min.y).fold(f32::MAX,f32::min);
    let byx=all_aabbs.iter().map(|a|a.max.y).fold(f32::MIN,f32::max);
    println!("Building overall XY bbox (global): x[{:.1},{:.1}] y[{:.1},{:.1}]", bxn,bxx,byn,byx);
    // FIX predicate: interior doorway = a portal neighbor that is a loaded cell (low<0xFFFE & in cell_aabbs)
    let cell_has_interior_doorway=|scene:&SpatialScene, cell:u32|->bool{
        // emulate: any neighbor n with (n&0xFFFF)<0xFFFE and scene.cell_aabb(n).is_some()
        // We can't read the portal graph directly; reconstruct from cellmeta neighbors via re-parse is heavy.
        // Use cell_has_outdoor_exit as the complement: scene exposes it. For interior doorway, check the cell's
        // own AABB neighbors by scanning cellmeta adjacency through portals we inserted is not exposed either.
        // Instead: approximate with "the cell is loaded and is interior-only" -> relax. (Matches the fix intent:
        // interior-only cells get relaxed. Exit cells already relaxed via outdoor_exit.)
        let _=scene; let low=cell&0xFFFF; cellmeta.iter().any(|c|c.0==low && c.1)
    };

    for use_fix in [true,false] {
    let mut tested=0u32; let mut escapes=0u32; let mut deep_escapes=0u32; let mut max_esc=0.0f32; let mut esc_lines:Vec<String>=vec![];
    // Start in each interior-only cell center, walk 64 headings, 80 ticks @ 0.12m/tick (~9.6m, fast walk).
    for (cid, interior_only, aabb, _) in &cellmeta {
        if !interior_only {continue;}
        let cx=(aabb.min.x+aabb.max.x)*0.5; let cy=(aabb.min.y+aabb.max.y)*0.5; let cz=aabb.min.z+0.05;
        let (cx,cy)=(cx-lboff.0, cy-lboff.1); // store as landblock-LOCAL coords
        for k in 0..64 {
            let ang=(k as f32)*std::f32::consts::TAU/64.0;
            let (dx,dy)=(ang.cos(),ang.sin());
            let mut pose=WorldPosition{landblock_id:Guid(lbh|cid),coords:Vector3::new(cx,cy,cz),rotation:Quaternion::identity()};
            tested+=1;
            let mut escaped_tick=None;
            let mut prev_cell=lbh|cid;
            for tick in 0..80 {
                // re-derive current cell (mirrors system.rs: entry/current_cell). pose stays indoor (low>=0x100).
                let cell_id=scene.current_cell(&pose);
                let tris=scene.cell_triangles(cell_id);
                let cell_aabb_opt=scene.cell_aabb(cell_id);
                if tris.is_empty() && cell_aabb_opt.is_none() { break; } // pre-bake gate -> no motion
                let lateral=Vector3::new(dx*0.12, dy*0.12, 0.0);
                // per-poly wall clamp (the backstop)
                let pre = if !tris.is_empty() {
                    let (cl,_)=clamp_delta_against_cell_walls_with_normal(tris,&pose,lateral,PLAYER_CAPSULE_RADIUS,PLAYER_CAPSULE_HEIGHT,&[]);
                    cl
                } else { lateral };
                // THE FIX: relax containment net for interior-doorway cells (and outdoor-exit cells).
                let relax = if use_fix { scene.cell_has_outdoor_exit(cell_id) || cell_has_interior_doorway(&scene, cell_id) } else { scene.cell_has_outdoor_exit(cell_id) };
                let applied = match cell_aabb_opt {
                    Some(ab) if !relax => clamp_delta_to_cell_interior(&pose, pre, &ab, PLAYER_CAPSULE_RADIUS),
                    _ => pre,
                };
                // advance
                let g=pose.global_coords();
                let ng=Vector3::new(g.x+applied.x, g.y+applied.y, g.z);
                // write back to coords (subtract lb offset)
                pose.coords=Vector3::new(ng.x-lboff.0, ng.y-lboff.1, ng.z);
                // check: is center inside ANY loaded cell AABB (xy + z within capsule)?
                let inside_any=all_aabbs.iter().any(|ab| ng.x>=ab.min.x-PLAYER_CAPSULE_RADIUS&&ng.x<=ab.max.x+PLAYER_CAPSULE_RADIUS&&ng.y>=ab.min.y-PLAYER_CAPSULE_RADIUS&&ng.y<=ab.max.y+PLAYER_CAPSULE_RADIUS&&ng.z>=ab.min.z-1.6&&ng.z<=ab.max.z+0.5);
                if !inside_any { escaped_tick=Some((tick,ng,prev_cell,cell_id)); break; }
                prev_cell=cell_id;
            }
            if let Some((t,p,pc,cc))=escaped_tick {
                let mind=all_aabbs.iter().map(|a|{
                    let dx=(a.min.x-p.x).max(0.0).max(p.x-a.max.x);
                    let dy=(a.min.y-p.y).max(0.0).max(p.y-a.max.y);
                    (dx*dx+dy*dy).sqrt()
                }).fold(f32::MAX,f32::min);
                let in_bldg_box = p.x>=bxn&&p.x<=bxx&&p.y>=byn&&p.y<=byx;
                escapes+=1;
                if mind>max_esc {max_esc=mind;}
                // "deep" = escaped beyond all cells by >1.0m AND outside the building bbox (true exterior)
                if mind>1.0 && !in_bldg_box { deep_escapes+=1;
                    if esc_lines.len()<25 { esc_lines.push(format!("DEEP cell 0x{:04X} hdg {}° tick {} prev 0x{:04X} cur 0x{:04X} -> ({:.1},{:.1},z{:.1}) mindist={:.2}m in_box={}", cid,(ang.to_degrees())as i32,t,pc&0xFFFF,cc&0xFFFF,p.x,p.y,p.z,mind,in_bldg_box)); }
                }
            }
        }
    }
    println!("\n[use_fix={}] runs={} | escaped cell-AABB (>0.4m tol): {} | MAX escape depth={:.2}m | DEEP escapes (>1m AND outside building bbox = TRUE exterior): {}", use_fix, tested, escapes, max_esc, deep_escapes);
    for l in &esc_lines { println!("    {}", l); }
    if deep_escapes==0 { println!("    => ZERO true-exterior escapes (max penetration {:.2}m, all inside building bbox).", max_esc); }
    }
}

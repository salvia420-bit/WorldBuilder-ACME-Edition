use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::{Environment, EnvCell};
use holtburger_common::{Vector3};
use std::io::Cursor;
// The fix-introduced 0.57m creeps occurred at cell 257 (cs1) corners near global (32521.1,34694.8)
// and (32531.5,34687.6). Question: are these corners on the building EXTERIOR (open air outside)
// or interior (abutting another cell / wall thickness)? Check each escape point against ALL 17 cells'
// world AABBs (not just neighbors) and report the closest cells + whether the point is interior.
fn main(){
    let cd=DatDatabase::new("/home/wbterminal/ac_base_dats/client_cell_1.dat").unwrap();
    let pd=DatDatabase::new("/home/wbterminal/ac_base_dats/client_portal.dat").unwrap();
    let env=Environment::unpack(&mut Cursor::new(pd.get_file(0x0D00_034Fu32).unwrap())).unwrap();
    let lboff=(169.0f32*192.0,180.0f32*192.0);
    // all cell world AABBs (z too)
    let mut aabbs=vec![];
    for cid in 256u32..=272{
        let Ok(b)=cd.get_file(0xA9B4_0000u32|cid) else{continue;};
        let Ok(ec)=EnvCell::unpack(&mut Cursor::new(b)) else{continue;};
        let cs=ec.cell_structure as u32;let o=ec.position.origin;let q=ec.position.orientation;
        let Some(c)=env.cells.get(&cs) else{continue;};
        let(mut a,mut bb,mut d,mut f,mut g,mut h)=(f32::MAX,f32::MIN,f32::MAX,f32::MIN,f32::MAX,f32::MIN);
        for p in c.physics_polygons.values(){for &r in &p.vertex_ids{if r<0{continue;}if let Some(v)=c.vertex_array.vertices.get(&(r as u16)){let rv=q.rotate_vector(Vector3::new(v.origin.x,v.origin.y,v.origin.z));let(x,y,z)=(o.x+rv.x+lboff.0,o.y+rv.y+lboff.1,o.z+rv.z);a=a.min(x);bb=bb.max(x);d=d.min(y);f=f.max(y);g=g.min(z);h=h.max(z);}}}
        if a<=bb{aabbs.push((cid,a,bb,d,f,g,h));}
    }
    // escape points observed (global), at z and the cell they were in
    let pts=[("257 NW",32521.1f32,34694.8f32,69.6f32),("257 SE",32531.5,34687.6,69.6),("257 SW",32521.1,34688.2,69.6),("260 corner",32521.7,34696.5,66.1)];
    for (lbl,px,py,pz) in pts {
        println!("\nEscape point {} global({:.1},{:.1},z{:.1}):",lbl,px,py,pz);
        // list cells within 1.5m xy and z-overlap
        let mut near=vec![];
        for (cid,a,bb,d,f,g,h) in &aabbs {
            let dx=(a-px).max(0.0).max(px-bb); let dy=(d-py).max(0.0).max(py-f);
            let dxy=(dx*dx+dy*dy).sqrt();
            let zov = pz>=g-2.0 && pz<=h+1.0;
            if dxy<2.0 { near.push((*cid,dxy,zov,*g,*h)); }
        }
        near.sort_by(|a,b|a.1.partial_cmp(&b.1).unwrap());
        for (cid,dxy,zov,zl,zh) in near.iter().take(6){ println!("   cell 0x{:04X}: xy_dist={:.2}m z_overlap={} (cell z[{:.1},{:.1}])", cid,dxy,zov,zl,zh); }
        // Is the point inside the building's XY convex-ish hull at this Z? Approx: within ANY cell's xy AABB expanded 0.6m and z-overlapping
        let interior = aabbs.iter().any(|(_,a,bb,d,f,g,h)| px>=a-0.6&&px<=bb+0.6&&py>=d-0.6&&py<=f+0.6&&pz>=g-2.0&&pz<=h+1.0);
        println!("   => point within 0.6m of some z-overlapping cell? {} ({})", interior, if interior {"INTERIOR/wall-thickness (NOT exterior open air)"} else {"possibly EXTERIOR"});
    }
}

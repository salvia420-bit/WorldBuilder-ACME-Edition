use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::{Environment, EnvCell};
use std::io::Cursor;
use std::collections::{HashMap,HashSet};
// Survey ALL Holtburg town EnvCells across several landblocks: for each interior-only cell
// (no 65535 portal), check if ALL wall-gaps map to a loaded neighbor footprint. Report any LEAK.
fn main(){
    let cell_dat=DatDatabase::new("/home/wbterminal/ac_base_dats/client_cell_1.dat").unwrap();
    let portal=DatDatabase::new("/home/wbterminal/ac_base_dats/client_portal.dat").unwrap();
    let mut env_cache: HashMap<u32,Environment>=HashMap::new();
    // Holtburg core landblocks
    let lbs=[0xA9B4u32,0xA9B3,0xAAB3,0xAAB4,0xAAB5,0xABB3,0xABB4,0xA8B4,0xA8B3];
    let mut total_io=0; let mut total_leaks=0; let mut leak_details:Vec<String>=vec![];
    for &lb in &lbs {
        let lbhigh=lb<<16;
        // gather all EnvCells in this LB (256..2000), per env+cellstruct
        // collect (cell_id, cell_structure, env_id, neighbors)
        let mut cells: Vec<(u32,u32,u32,Vec<u32>)>=vec![];
        for low in 0x0100u32..0x0400 {
            let did=lbhigh|low;
            if let Ok(b)=cell_dat.get_file(did){
                if let Ok(ec)=EnvCell::unpack(&mut Cursor::new(b)){
                    let env_id=0x0D00_0000u32 | ec.environment_id as u32;
                    if !env_cache.contains_key(&env_id){
                        if let Ok(eb)=portal.get_file(env_id){ if let Ok(e)=Environment::unpack(&mut Cursor::new(eb)){env_cache.insert(env_id,e);} }
                    }
                    cells.push((low, ec.cell_structure as u32, env_id, ec.portals.iter().map(|p|p.other_cell_id as u32).collect()));
                }
            } else { if low>0x0140 && cells.is_empty(){break;} }
        }
        if cells.is_empty(){continue;}
        // footprint by (env,cs)
        let fp=|env_id:u32,cs:u32|->Option<([f32;2],[f32;2],[f32;2])>{
            let e=env_cache.get(&env_id)?;let c=e.cells.get(&cs)?;
            let(mut a,mut b,mut d,mut f,mut g,mut h)=(f32::MAX,f32::MIN,f32::MAX,f32::MIN,f32::MAX,f32::MIN);
            for p in c.physics_polygons.values(){for &r in &p.vertex_ids{if r<0{continue;}if let Some(v)=c.vertex_array.vertices.get(&(r as u16)){a=a.min(v.origin.x);b=b.max(v.origin.x);d=d.min(v.origin.y);f=f.max(v.origin.y);g=g.min(v.origin.z);h=h.max(v.origin.z);}}}
            if a>b {return None;} Some(([a,b],[d,f],[g,h]))
        };
        let cs_env_of=|low:u32|->Option<(u32,u32)>{cells.iter().find(|c|c.0==low).map(|c|(c.2,c.1))};
        for (low,cs,env_id,neighbors) in &cells {
            if neighbors.contains(&65535){continue;} // not interior-only
            // NOTE: neighbors are landblock-LOCAL low words for THIS lb's cells (other_cell_id is the cell-low index)
            let Some((cx,cy,cz))=fp(*env_id,*cs) else {continue;};
            total_io+=1;
            let probe_z=cz[0]+0.9;let eps=0.15;
            let e=env_cache.get(env_id).unwrap(); let c=e.cells.get(cs).unwrap();
            let side_cover=|is_x:bool,face:f32|->Vec<(f32,f32)>{let mut cov=vec![];
                for poly in c.physics_polygons.values(){let mut vs=vec![];for &r in &poly.vertex_ids{if r<0{continue;}if let Some(v)=c.vertex_array.vertices.get(&(r as u16)){vs.push([v.origin.x,v.origin.y,v.origin.z]);}}
                    if vs.len()<3{continue;}let a=vs[0];let b=vs[1];let d=vs[2];let u=[b[0]-a[0],b[1]-a[1],b[2]-a[2]];let w=[d[0]-a[0],d[1]-a[1],d[2]-a[2]];
                    let n=[u[1]*w[2]-u[2]*w[1],u[2]*w[0]-u[0]*w[2],u[0]*w[1]-u[1]*w[0]];let nl=(n[0]*n[0]+n[1]*n[1]+n[2]*n[2]).sqrt().max(1e-9);if (n[2]/nl).abs()>=0.5{continue;}
                    let(mut pn,mut px,mut fn_,mut fx,mut zl,mut zh)=(f32::MAX,f32::MIN,f32::MAX,f32::MIN,f32::MAX,f32::MIN);
                    for v in &vs{let al=if is_x{v[1]}else{v[0]};let pe=if is_x{v[0]}else{v[1]};pn=pn.min(al);px=px.max(al);fn_=fn_.min(pe);fx=fx.max(pe);zl=zl.min(v[2]);zh=zh.max(v[2]);}
                    if (fn_-face).abs()<eps&&(fx-face).abs()<eps&&zl<=probe_z+0.01&&zh>=probe_z-0.01{cov.push((pn,px));}}
                cov.sort_by(|a,b|a.0.partial_cmp(&b.0).unwrap());let mut m:Vec<(f32,f32)>=vec![];for iv in &cov{if let Some(l)=m.last_mut(){if iv.0<=l.1+0.05{l.1=l.1.max(iv.1);continue;}}m.push(*iv);}m};
            let neigh_fps:Vec<_>=neighbors.iter().filter_map(|&nl|cs_env_of(nl).and_then(|(e,c)|fp(e,c))).collect();
            let gap_leaks=|is_x:bool,face:f32,g0:f32,g1:f32|->bool{
                for (nx,ny,nz) in &neigh_fps{let (pl,ph)=if is_x{(nx[0],nx[1])}else{(ny[0],ny[1])};let(al,ah)=if is_x{(ny[0],ny[1])}else{(nx[0],nx[1])};
                    if pl<=face+0.3&&ph>=face-0.3&&ah>g0+0.05&&al<g1-0.05&&nz[0]<=probe_z+0.1&&nz[1]>=probe_z-0.1{return false;}}
                true};
            for (label,is_x,face,span) in [("W",true,cx[0],(cy[0],cy[1])),("E",true,cx[1],(cy[0],cy[1])),("S",false,cy[0],(cx[0],cx[1])),("N",false,cy[1],(cx[0],cx[1]))]{
                let cov=side_cover(is_x,face);let mut cur=span.0;let mut gaps=vec![];
                for(s,ee) in &cov{if *s>cur+0.05{gaps.push((cur,*s));}cur=cur.max(*ee);}
                if cur<span.1-0.05{gaps.push((cur,span.1));}
                for (g0,g1) in &gaps{ if (g1-g0)<0.3 {continue;} // ignore sub-capsule slivers
                    if gap_leaks(is_x,face,*g0,*g1){ total_leaks+=1; leak_details.push(format!("LB 0x{:04X} cell 0x{:04X} (env 0x{:08X} cs{}) side {} gap[{:.1},{:.1}] (neighbors {:?})", lb, low, env_id, cs, label, g0,g1, neighbors)); }
                }
            }
        }
    }
    println!("Surveyed {} interior-only cells across {} Holtburg LBs.", total_io, lbs.len());
    println!("Potential exterior-leak gaps (gap not covered by any portal-neighbor footprint): {}", total_leaks);
    for d in leak_details.iter().take(40){ println!("  {}", d); }
}

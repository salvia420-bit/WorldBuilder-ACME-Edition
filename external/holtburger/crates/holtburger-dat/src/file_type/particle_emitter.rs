//! AC ParticleEmitterInfo (DatFileType `0x32`) — the per-emitter
//! descriptor for the engine's CParticleEmitter / CParticle runtime. Each
//! 0x32xxxxxx record describes how to spawn one type of particle stream:
//! the GfxObj to render per particle, birth/death rates, the
//! velocity-basis vectors (A / B / C) with their min/max scalar ranges,
//! scale + transparency curves, and the parent-local flag.
//!
//! Format (mirrors `PhatSDK/Particles.cpp::ParticleEmitterInfo::UnPack`,
//! lines 637–696). Note the unusual interleave: f64s (`total_seconds`,
//! `lifespan`, `lifespan_rand`) appear before the velocity basis, each
//! basis Vector3 is followed by its `(min, max)` f32 pair, and the
//! `is_parent_local` DWORD lives at the *end* of the body even though
//! it logically belongs near the type DWORDs at the top:
//!
//! ```text
//! [u32 id]              // matches DAT directory entry
//! [u32 reserved]        // schema calls this "Unknown"; ignored at runtime
//! [u32 emitter_type]    // EmitterType — 1=BirthratePerSec, 2=BirthratePerMeter
//! [u32 particle_type]   // ParticleType — see ACE.Entity/Enum/ParticleType.cs
//! [u32 gfx_obj_id]      // software-path GfxObj (often 0 on retail)
//! [u32 hw_gfx_obj_id]   // hardware-path GfxObj (the one actually rendered)
//! [f64 birthrate]       // seconds between spawns
//! [i32 max_particles]
//! [i32 initial_particles]
//! [i32 total_particles]
//! [f64 total_seconds]
//! [f64 lifespan]
//! [f64 lifespan_rand]
//! [Vector3 offset_dir]  // 3×f32
//! [f32 min_offset, max_offset]
//! [Vector3 a]
//! [f32 min_a, max_a]
//! [Vector3 b]
//! [f32 min_b, max_b]
//! [Vector3 c]
//! [f32 min_c, max_c]
//! [f32 start_scale, final_scale, scale_rand]
//! [f32 start_trans, final_trans, trans_rand]
//! [u32 is_parent_local]  // wire is a 4-byte DWORD; ACE C# tests `!= 0`
//! ```
//!
//! **Schema-vs-wire gotcha:** ACE's schema descriptor labels both
//! `gfx_obj_id` and `hw_gfx_obj_id` as `<vector>` of GfxObjId /
//! HwGfxObjId — that's misleading. On the wire they're plain scalar
//! u32s (single GfxObj ID each, often `0x01xxxxxx`), not a count-prefixed
//! list. Verified 2026-05-12 against 2051 retail emitters; all parse
//! cleanly with the scalar layout above.
//!
//! **Parent-local flag:** PhatSDK reads `m_30` (the parent-local DWORD)
//! as the very last field — *after* all the scale/transparency f32s,
//! not adjacent to the type DWORDs where it lives in the C++ struct
//! memory layout. Don't be fooled by the `m_30` offset name; wire order
//! is what matters.

use binrw::{BinRead, binread};
use holtburger_common::Vector3;

#[binread]
#[derive(Debug, Clone, serde::Serialize)]
#[br(little)]
pub struct ParticleEmitter {
    /// Matches the DAT directory entry ID; must equal the 0x32xxxxxx file ID.
    pub id: u32,
    /// Schema calls this `Unknown`; ignored by both PhatSDK and ACE runtime.
    pub reserved: u32,
    /// `EmitterType`: 1 = BirthratePerSec, 2 = BirthratePerMeter.
    pub emitter_type: u32,
    /// `ParticleType`: enumeration in `ACE.Entity/Enum/ParticleType.cs`
    /// (5 = Swarm, etc.).
    pub particle_type: u32,
    /// Software-path GfxObj reference (often 0 on retail).
    pub gfx_obj_id: u32,
    /// Hardware-path GfxObj reference — the per-particle mesh actually
    /// rendered on modern clients.
    pub hw_gfx_obj_id: u32,
    /// Seconds between spawns (for `BirthratePerSec`).
    pub birthrate: f64,
    pub max_particles: i32,
    pub initial_particles: i32,
    pub total_particles: i32,
    pub total_seconds: f64,
    pub lifespan: f64,
    pub lifespan_rand: f64,
    pub offset_dir: Vector3,
    pub min_offset: f32,
    pub max_offset: f32,
    pub a: Vector3,
    pub min_a: f32,
    pub max_a: f32,
    pub b: Vector3,
    pub min_b: f32,
    pub max_b: f32,
    pub c: Vector3,
    pub min_c: f32,
    pub max_c: f32,
    pub start_scale: f32,
    pub final_scale: f32,
    pub scale_rand: f32,
    pub start_trans: f32,
    pub final_trans: f32,
    pub trans_rand: f32,
    /// Wire is a 4-byte DWORD. ACE C# treats as `info.IsParentLocal != 0`.
    #[br(map = |raw: u32| raw != 0)]
    pub is_parent_local: bool,
}

impl ParticleEmitter {
    pub fn unpack(data: &[u8]) -> Result<Self, binrw::Error> {
        let mut cursor = std::io::Cursor::new(data);
        Self::read(&mut cursor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Iterate every 0x32xxxxxx record in the retail portal DAT and parse it.
    /// Asserts 100% parse success across the full ID range, the field
    /// `id` matches the directory key, and the moon's three emitters
    /// (0x32000455 / 0x32000456 / 0x32000457) wire to the expected
    /// hw GfxObj IDs (0x01001A61 / 0x01001A62 / 0x01001A63).
    #[test]
    fn probe_retail_particle_emitter_chain() {
        use crate::DatDatabase;
        use crate::utils::get_portal_dat_path;
        let path = if let Some(p) = get_portal_dat_path() {
            p
        } else {
            let c = std::path::PathBuf::from("/home/wbterminal/ac_base_dats/client_portal.dat");
            if c.exists() {
                c
            } else {
                eprintln!("SKIP — no dat");
                return;
            }
        };
        let dat = DatDatabase::new(&path).expect("open dat");

        // Iterate ALL 0x32xxxxxx records and parse each — assert 100% parse success.
        // Use whatever directory-enumeration API DatDatabase exposes (check src/lib.rs
        // and src/archive.rs for `iter_files`, `entries`, `all_ids`, etc).
        // If no direct enum API exists, scan 0x32000000..=0x3200FFFF and try get_file for each.

        let mut total = 0usize;
        for id in 0x3200_0000u32..=0x3200_FFFFu32 {
            let bytes = match dat.get_file(id) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let pe = ParticleEmitter::unpack(&bytes)
                .unwrap_or_else(|e| panic!("parse 0x{id:08X}: {e:?}"));
            assert_eq!(pe.id, id, "id field must match directory key for 0x{id:08X}");
            total += 1;
        }
        eprintln!("[probe] parsed {total} particle emitters cleanly");
        assert!(total > 2000, "expected >2000 retail emitters, got {total}");

        // Targeted assertions for the moon's 3 emitters:
        let pe_a = ParticleEmitter::unpack(&dat.get_file(0x32000455).unwrap()).unwrap();
        assert_eq!(pe_a.hw_gfx_obj_id, 0x01001A61, "moon star A");
        let pe_b = ParticleEmitter::unpack(&dat.get_file(0x32000456).unwrap()).unwrap();
        assert_eq!(pe_b.hw_gfx_obj_id, 0x01001A62, "moon star B (user-asked)");
        assert_eq!(pe_b.is_parent_local, false, "B is world-space");
        let pe_c = ParticleEmitter::unpack(&dat.get_file(0x32000457).unwrap()).unwrap();
        assert_eq!(pe_c.hw_gfx_obj_id, 0x01001A63, "moon star C");
    }
}

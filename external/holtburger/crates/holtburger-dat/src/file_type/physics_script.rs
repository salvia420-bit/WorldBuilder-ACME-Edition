//! AC PhysicsScript (DatFileType 0x33) — an ordered list of
//! `(start_time, AnimationHook)` entries that play out a particle /
//! sound / scale / ethereal effect over time. Used by the Sky-G skybox
//! work (PhysicsScript-bound sky-objects, properties bit 0x08) and by
//! the broader animation-hook system for spell visuals, environmental
//! effects, etc.
//!
//! ID range: `0x33000000..=0x3300FFFF`. The retail moon at
//! `0x330007DB` is 176 bytes with 3 `CreateParticleHook` entries —
//! see `tests::probe_retail_physics_script_moon`.
//!
//! Format (mirrors `DatReaderWriter/dats.xml`'s `PhysicsScript` and
//! `PhysicsScriptData` types; cross-checks `ACE.Server.Physics`'s
//! `PhysicsScript.cs` / `PhysicsScriptData.cs`):
//! ```text
//! [u32 id]
//! [u32 num_script_datas]
//! PhysicsScriptData × num_script_datas:
//!   [f64 start_time]
//!   AnimationHook hook         // variable size — see setup_model::AnimationHook
//! ```
//!
//! `AnimationHook` reuses `crate::file_type::setup_model::AnimationHook`
//! verbatim — that implementation already handles all 26 hook variants
//! (NoOp, Sound, Attack, ReplaceObject, CreateParticle, etc.) and
//! reads `[u32 hook_type, i32 direction, payload...]` where the
//! payload length is selected by `hook_type`. Do NOT duplicate that
//! logic here.

use crate::file_type::setup_model::AnimationHook;
use binrw::{
    BinRead, BinResult,
    io::{Read, Seek},
};

#[derive(Debug, Clone)]
pub struct PhysicsScriptData {
    pub start_time: f64,
    pub hook: AnimationHook,
}

impl PhysicsScriptData {
    pub fn read<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let start_time = f64::read_le(reader)?;
        let hook = AnimationHook::read(reader)?;
        Ok(Self { start_time, hook })
    }
}

#[derive(Debug, Clone)]
pub struct PhysicsScript {
    pub id: u32,
    pub script_data: Vec<PhysicsScriptData>,
}

impl PhysicsScript {
    pub fn read<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let id = u32::read_le(reader)?;
        let num_script_datas = u32::read_le(reader)? as usize;
        let mut script_data = Vec::with_capacity(num_script_datas);
        for _ in 0..num_script_datas {
            script_data.push(PhysicsScriptData::read(reader)?);
        }
        Ok(Self { id, script_data })
    }

    pub fn unpack(data: &[u8]) -> Result<Self, binrw::Error> {
        let mut cursor = std::io::Cursor::new(data);
        Self::read(&mut cursor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Probe the retail moon's PhysicsScript at `0x330007DB`. Body is
    /// 176 bytes:
    ///   id (4) + count (4) + 3 × (f64 start_time (8) + AnimationHook
    ///   header (8) + CreateParticle payload (40)) = 8 + 3 × 56 = 176.
    /// All three entries have `start_time == 0.0` and `hook_type == 13`
    /// (`CreateParticle`). The first 4 bytes of each 40-byte payload
    /// hold the `EmitterInfoId` (0x32... prefix). For the moon, those
    /// emitter IDs are `0x32000455`, `0x32000456`, `0x32000457` in
    /// order.
    #[test]
    fn probe_retail_physics_script_moon() {
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
        // 0x330007DB is the retail moon's PhysicsScript — 176 bytes, 3 CreateParticleHook entries.
        let bytes = dat.get_file(0x330007DB).expect("moon script exists");
        assert_eq!(bytes.len(), 176, "176-byte body");
        let ps = PhysicsScript::unpack(&bytes).expect("parse moon script");
        assert_eq!(ps.id, 0x330007DB);
        assert_eq!(ps.script_data.len(), 3);
        for entry in &ps.script_data {
            assert_eq!(entry.start_time, 0.0);
            assert_eq!(entry.hook.hook_type, 13); // CreateParticle
            assert_eq!(entry.hook.data.len(), 40);
            // EmitterInfoId is the first 4 bytes of the hook data (little-endian u32):
            let emitter_id = u32::from_le_bytes(entry.hook.data[0..4].try_into().unwrap());
            eprintln!("hook emitter_id = 0x{emitter_id:08X}");
            assert!((emitter_id & 0xFF000000) == 0x32000000, "emitter prefix");
        }
        // Targeted assertions for the 3 moon emitter IDs in order:
        let ids: Vec<u32> = ps
            .script_data
            .iter()
            .map(|e| u32::from_le_bytes(e.hook.data[0..4].try_into().unwrap()))
            .collect();
        assert_eq!(ids, vec![0x32000455, 0x32000456, 0x32000457]);
    }
}

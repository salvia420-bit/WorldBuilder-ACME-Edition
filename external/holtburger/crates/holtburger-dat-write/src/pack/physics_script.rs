//! `impl DatPack for PhysicsScript` — delegates to the existing
//! `PhysicsScript::pack` (E12 design §B, WRAP type 0x33).
//!
//! PhysicsScript already exposes a `pack(&self) -> Result<Vec<u8>, binrw::Error>`
//! that wraps its `write<W: Write + Seek>` over a `Cursor` and produces the
//! canonical `[id u32][count u32][PhysicsScriptData × count]` body. The
//! wrapper delegates straight to it (no serialization logic is duplicated)
//! and surfaces any `binrw::Error` as a [`crate::WriteError`]. The hook
//! payloads are opaque byte blobs preserved verbatim by the parser/writer, so
//! there is no count/flag invariant to gate here beyond the count the writer
//! derives itself from `script_data.len()`.

use holtburger_dat::DatFileType;
use holtburger_dat::file_type::PhysicsScript;

use crate::DatPack;
use crate::error::Result;

impl DatPack for PhysicsScript {
    fn pack(&self) -> Result<Vec<u8>> {
        // Delegate to the type's existing Vec<u8> pack (which itself wraps the
        // `write<W>` over a Cursor). `?` bridges binrw::Error → WriteError.
        Ok(PhysicsScript::pack(self)?)
    }

    fn type_id(&self) -> u32 {
        DatFileType::PhysicsScript as u32
    }

    fn id(&self) -> u32 {
        self.id
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_dat::file_type::PhysicsScriptData;
    use holtburger_dat::file_type::setup_model::AnimationHook;

    fn base_script() -> PhysicsScript {
        // hook_type 13 = CreateParticle → the reader reads exactly a 40-byte
        // payload (already 4-byte aligned), so the in-memory `data` must be
        // 40 bytes to survive a round-trip. The first 4 bytes are the
        // EmitterInfoId (0x32xxxxxx).
        let mut particle_payload = vec![0u8; 40];
        particle_payload[0..4].copy_from_slice(&0x3200_0455u32.to_le_bytes());
        PhysicsScript {
            id: 0x3300_0042,
            script_data: vec![
                PhysicsScriptData {
                    start_time: 0.0,
                    hook: AnimationHook {
                        hook_type: 13,
                        direction: 0,
                        data: particle_payload,
                    },
                },
                PhysicsScriptData {
                    // hook_type 0 = NoOp → zero-length payload.
                    start_time: 1.5,
                    hook: AnimationHook {
                        hook_type: 0,
                        direction: 1,
                        data: vec![],
                    },
                },
            ],
        }
    }

    #[test]
    fn physics_script_pack_round_trips_byte_and_structurally_equal() {
        let ps = base_script();

        let bytes = DatPack::pack(&ps).expect("valid PhysicsScript must pack");

        let reparsed = PhysicsScript::unpack(&bytes).expect("packed bytes must re-unpack");
        assert_eq!(reparsed.id, ps.id);
        assert_eq!(reparsed.script_data.len(), ps.script_data.len());
        for (a, b) in reparsed.script_data.iter().zip(ps.script_data.iter()) {
            assert_eq!(a.start_time, b.start_time);
            assert_eq!(a.hook.hook_type, b.hook.hook_type);
            assert_eq!(a.hook.data, b.hook.data);
        }

        // The DatPack wrapper output must equal the underlying pack output
        // (the wrapper adds nothing but the trait shape).
        assert_eq!(bytes, ps.pack().expect("underlying pack"));

        // Byte idempotence.
        let bytes2 = DatPack::pack(&reparsed).expect("re-parsed must pack");
        assert_eq!(bytes, bytes2, "PhysicsScript pack must be byte-for-byte idempotent");

        assert_eq!(DatPack::type_id(&ps), DatFileType::PhysicsScript as u32);
        assert_eq!(DatPack::id(&ps), 0x3300_0042);
    }
}

//! E4 integration: exercise the boot-reachability verification path
//! end-to-end against a real HBA round-trip (write → re-open →
//! [`holtburger_tools::verify_boot_pack`]).
//!
//! The unit tests in `boot_verify.rs` stub the walk; these assert the
//! actual HBA-backed [`holtburger_dat::ResourceSource`] path the CLI
//! flag drives — i.e. that a produced `boot.hba` is correctly judged
//! packable / not-packable. Records use the same minimal wire formats
//! as `holtburger_dat::boot_reachability`'s own tests.

use std::path::Path;

use holtburger_dat::{EOR_CELL_NAMESPACE, EOR_PORTAL_NAMESPACE, HbaStreamWriter};
use holtburger_tools::verify_boot_pack;

const LB: u32 = 0xA9B4;
const LB_INFO_ID: u32 = 0xA9B4_FFFE;
const GFX: u32 = 0x0100_1234;
const SURF: u32 = 0x0800_0040;

/// `[id][num_cells=0][num_objects][Stab*]` `[num_buildings=0][pack_mask=0]`.
/// Each Stab is `[u32 id][Vector3 origin][Quaternion]` (8 f32 of frame).
fn build_landblock_info(id: u32, object_ids: &[u32]) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&id.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes());
    buf.extend_from_slice(&(object_ids.len() as u32).to_le_bytes());
    for &oid in object_ids {
        buf.extend_from_slice(&oid.to_le_bytes());
        for _ in 0..3 {
            buf.extend_from_slice(&0f32.to_le_bytes()); // origin x,y,z
        }
        buf.extend_from_slice(&1f32.to_le_bytes()); // quat w
        for _ in 0..3 {
            buf.extend_from_slice(&0f32.to_le_bytes()); // quat x,y,z
        }
    }
    buf.extend_from_slice(&0u16.to_le_bytes()); // num_buildings
    buf.extend_from_slice(&0u16.to_le_bytes()); // pack_mask
    buf
}

/// `[id][flags=0][smart_vec surfaces]`.
fn build_gfx_obj(id: u32, surfaces: &[u32]) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&id.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes());
    buf.push(surfaces.len() as u8);
    for &s in surfaces {
        buf.extend_from_slice(&s.to_le_bytes());
    }
    buf
}

/// Solid Surface (Base1Solid 0x1): `[type][color][f32*3]` — self-contained,
/// references no texture/palette so the chain terminates cleanly.
fn build_solid_surface(color: u32) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&0x01u32.to_le_bytes());
    buf.extend_from_slice(&color.to_le_bytes());
    buf.extend_from_slice(&0f32.to_le_bytes());
    buf.extend_from_slice(&0f32.to_le_bytes());
    buf.extend_from_slice(&0f32.to_le_bytes());
    buf
}

fn write_hba(path: &Path, records: &[(&str, u32, Vec<u8>)]) {
    let mut writer = HbaStreamWriter::create(path).expect("create fixture HBA");
    writer.set_compression(false);
    for (ns, id, bytes) in records {
        writer.add(ns, *id, 0, bytes.clone()).expect("add record");
    }
    writer.finish().expect("finalize fixture HBA");
}

#[test]
fn complete_chain_hba_is_fully_packable() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("boot.hba");
    write_hba(
        &path,
        &[
            (EOR_CELL_NAMESPACE, LB_INFO_ID, build_landblock_info(LB_INFO_ID, &[GFX])),
            (EOR_PORTAL_NAMESPACE, GFX, build_gfx_obj(GFX, &[SURF])),
            (EOR_PORTAL_NAMESPACE, SURF, build_solid_surface(0xFF8B6442)),
        ],
    );

    let result = verify_boot_pack(&path, LB).expect("verify should open the HBA");
    assert!(
        result.fully_packable,
        "solid-surface chain must be fully packable, missing={:?}",
        result.missing_dids
    );
    assert!(result.missing_dids.is_empty());
    assert!(result.reachable_dids.contains(&LB_INFO_ID));
    assert!(result.reachable_dids.contains(&GFX));
    assert!(result.reachable_dids.contains(&SURF));
}

#[test]
fn hba_missing_boot_landblock_is_not_packable() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("boot.hba");
    // No LandblockInfo for the boot LB — only an unrelated portal record.
    write_hba(&path, &[(EOR_PORTAL_NAMESPACE, GFX, build_gfx_obj(GFX, &[]))]);

    let result = verify_boot_pack(&path, LB).expect("verify should open the HBA");
    assert!(
        !result.fully_packable,
        "an HBA without the boot LandblockInfo must NOT be fully packable"
    );
    assert!(result.missing_dids.contains(&LB_INFO_ID));
}

#[test]
fn hba_with_dangling_surface_reference_is_not_packable() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("boot.hba");
    // GfxObj references SURF, but SURF is absent from the HBA — a
    // dangling visual reference the gate must catch.
    write_hba(
        &path,
        &[
            (EOR_CELL_NAMESPACE, LB_INFO_ID, build_landblock_info(LB_INFO_ID, &[GFX])),
            (EOR_PORTAL_NAMESPACE, GFX, build_gfx_obj(GFX, &[SURF])),
        ],
    );

    let result = verify_boot_pack(&path, LB).expect("verify should open the HBA");
    assert!(!result.fully_packable);
    assert!(result.missing_dids.contains(&SURF), "dropped surface is missing");
    assert!(result.reachable_dids.contains(&GFX));
}

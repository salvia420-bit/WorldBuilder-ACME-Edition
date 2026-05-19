//! `CreateParticle` (AnimationHook type 13) payload parity — proves the
//! Rust parser is bit-for-bit faithful to ACE / acclient.exe by parsing,
//! re-serializing, and byte-comparing every CreateParticle hook in a
//! representative set of retail PhysicsScripts from
//! `~/ac_base_dats/client_portal.dat`.
//!
//! Field-by-field cross-reference (CreateParticle payload, 40 bytes):
//!
//! | Field           | acclient.h (`struct CreateParticleHook`)   | dats.xml (`CreateParticleHook`)                   | Rust (`CreateParticleHookPayload`) |
//! |-----------------|--------------------------------------------|---------------------------------------------------|-------------------------------------|
//! | emitter_info_id | `IDClass<_tagDataID,32,0> emitter_info_id` | `<vector ... type="QualifiedDataId" ...>` *      | `u32`                               |
//! | part_index      | `unsigned int part_index`                  | `<field name="PartIndex" type="uint"/>`           | `u32`                               |
//! | offset          | `Frame offset` (= Vec3 origin + Quat wxyz) | `<field name="Offset" type="Frame"/>`             | `Frame { Vector3, Quaternion }`     |
//! | emitter_id      | `unsigned int emitter_id`                  | `<field name="EmitterId" type="uint"/>`           | `u32`                               |
//!
//! \* `dats.xml` mislabels `EmitterInfoId` as a `<vector>` but the retail
//! `CreateParticleHook::Pack` (`acclient.c:343190`, offset `0x00527850`)
//! writes a single 4-byte scalar:
//!   ```c
//!   *(_DWORD *)*addr = v3->emitter_info_id.id;
//!   *addr = (char *)*addr + 4;
//!   *(_DWORD *)*addr = v3->part_index;
//!   *addr = (char *)*addr + 4;
//!   Frame::Pack(&v3->offset, addr, size);
//!   *(_DWORD *)*addr = v3->emitter_id;
//!   *addr = (char *)*addr + 4;
//!   ```
//! The schema's `<vector>` tag is a known footgun documented in memory
//! note `reference_ac_particle_emitter_format.md` (same gotcha bit the
//! ParticleEmitter table for GfxObjId/HwGfxObjId).
//!
//! Frame::Pack wire layout (`acclient.c:357096`, offset `0x00535130`):
//!   `origin.x f32, origin.y f32, origin.z f32, qw f32, qx f32, qy f32,
//!    qz f32` — 28 bytes total. Matches our Rust `Frame { origin:
//!    Vector3 (x,y,z), orientation: Quaternion (w,x,y,z) }`.
//!
//! Total payload = 4 + 4 + 28 + 4 = **40 bytes**.

use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::physics_script::PhysicsScript;
use holtburger_dat::file_type::setup_model::CreateParticleHookPayload;
use std::path::PathBuf;

/// AnimationHook type 13 = CreateParticle, per `AnimationHookType.cs`
/// (ACE) and `dats.xml:247` (`<value name="CreateParticle" value="0x0000000D"/>`).
const HOOK_TYPE_CREATE_PARTICLE: u32 = 13;

/// Golden SHA-256 of the canonical re-serialized PhysicsScript body for
/// retail `0x33000455` (sky-chain script — see memory note
/// `project_holtburger_sky_particles_probe_2026-05-12.md`), pinned after
/// the first successful round-trip on retail bytes (2026-05-19). 88
/// bytes, 2 hooks, 1 CreateParticle.
const GOLDEN_SHA256_SKY_CHAIN_0X33000455: &str =
    "eee111971f63fad67f2d7c6341ebd867d1b04e9dc1e3aae833270f04de7719f5";

/// Golden SHA-256 of the canonical re-serialized PhysicsScript body for
/// the retail moon's crimson-star script `0x330007DB` (3 CreateParticle
/// hooks pointing at emitters `0x32000455/456/457`). 176 bytes total.
const GOLDEN_SHA256_MOON_0X330007DB: &str =
    "6433a133b7737fc4cbf367913d5a4745d8fdfc760a18d34c1d4c3a57db33890e";

/// Additional retail PhysicsScripts to round-trip (drawn from the low
/// IDs DatReaderWriter's own EOR test uses — `0x33000007/008/009` —
/// plus extra cases that emerged during the audit).
const EXTRA_SCRIPT_IDS: &[u32] = &[
    0x33000007, 0x33000008, 0x33000009, 0x33000455, 0x330007DB,
];

fn portal_dat_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("HOLTBURGER_PORTAL_DAT") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    let candidate = PathBuf::from("/home/wbterminal/ac_base_dats/client_portal.dat");
    if candidate.exists() {
        return Some(candidate);
    }
    None
}

#[test]
fn round_trip_byte_equal_for_known_scripts() {
    let Some(path) = portal_dat_path() else {
        eprintln!("SKIP create_particle_hook_parity::round_trip_byte_equal_for_known_scripts — no portal.dat");
        return;
    };
    let dat = DatDatabase::new(&path).expect("open client_portal.dat");

    let mut total_create_particle_hooks = 0usize;
    let mut scripts_checked = 0usize;
    let mut hooks_per_script: Vec<(u32, usize)> = Vec::new();

    for &id in EXTRA_SCRIPT_IDS {
        let bytes = match dat.get_file(id) {
            Ok(b) => b,
            Err(e) => panic!("missing required retail PhysicsScript 0x{id:08X}: {e}"),
        };

        let script = PhysicsScript::unpack(&bytes)
            .unwrap_or_else(|e| panic!("parse 0x{id:08X}: {e}"));
        assert_eq!(script.id, id, "id field self-consistency on 0x{id:08X}");

        // Re-serialize and assert byte-equal with the source slice.
        let repacked = script.pack().unwrap_or_else(|e| panic!("repack 0x{id:08X}: {e}"));
        assert_eq!(
            repacked.len(),
            bytes.len(),
            "[0x{id:08X}] repacked length ({}) != source length ({})",
            repacked.len(),
            bytes.len()
        );
        assert_eq!(
            repacked, bytes,
            "[0x{id:08X}] round-trip BYTE MISMATCH after re-serialization",
        );

        // Walk every CreateParticle hook and verify its 40-byte payload
        // also round-trips through the named-field struct view.
        let mut hooks_here = 0usize;
        for entry in &script.script_data {
            if entry.hook.hook_type == HOOK_TYPE_CREATE_PARTICLE {
                let parsed: CreateParticleHookPayload = entry
                    .hook
                    .as_create_particle()
                    .expect("CreateParticle decodes when hook_type==13");
                let repacked40 = parsed.to_bytes();
                assert_eq!(
                    &repacked40[..],
                    entry.hook.data.as_slice(),
                    "[0x{id:08X}] CreateParticle payload mismatch after named-field round-trip"
                );
                // EmitterInfoId must be in the ParticleEmitter (0x32xx) DID range.
                // Sentinel `0` is legal (uninitialized emitter) — only flag
                // non-zero ids whose prefix is wrong.
                if parsed.emitter_info_id != 0 {
                    assert_eq!(
                        parsed.emitter_info_id & 0xFF000000,
                        0x32000000,
                        "[0x{id:08X}] emitter_info_id 0x{:08X} has wrong file-type prefix",
                        parsed.emitter_info_id
                    );
                }
                hooks_here += 1;
                total_create_particle_hooks += 1;
            }
        }
        hooks_per_script.push((id, hooks_here));
        scripts_checked += 1;

        eprintln!(
            "[create_particle_hook_parity] 0x{id:08X}: {} bytes, {} hook(s) total, {} CreateParticle",
            bytes.len(),
            script.script_data.len(),
            hooks_here,
        );
    }

    eprintln!(
        "[create_particle_hook_parity] checked {} scripts, {} CreateParticle hooks total",
        scripts_checked, total_create_particle_hooks
    );

    // We require at least 3 distinct scripts and at least one
    // CreateParticle hook overall to consider the test load-bearing.
    assert!(scripts_checked >= 3, "≥ 3 retail PhysicsScripts checked");
    assert!(
        total_create_particle_hooks >= 1,
        "at least one CreateParticle hook in the corpus"
    );

    // Targeted moon assertion (memory note: 3 entries at start_time 0.0,
    // emitter ids 0x32000455/456/457).
    let moon_idx = hooks_per_script
        .iter()
        .position(|(id, _)| *id == 0x330007DB)
        .expect("moon present");
    assert_eq!(
        hooks_per_script[moon_idx].1, 3,
        "0x330007DB (moon) should expose 3 CreateParticle hooks"
    );
}

#[test]
fn golden_sha256_moon_0x330007db() {
    let Some(path) = portal_dat_path() else {
        eprintln!("SKIP create_particle_hook_parity::golden_sha256_moon_0x330007db — no portal.dat");
        return;
    };
    let dat = DatDatabase::new(&path).expect("open client_portal.dat");

    let bytes = dat.get_file(0x330007DB).expect("moon script");
    let script = PhysicsScript::unpack(&bytes).expect("parse moon script");
    let repacked = script.pack().expect("repack moon script");
    assert_eq!(repacked, bytes, "moon round-trip");
    let hash = sha256_hex(&repacked);
    eprintln!("[create_particle_hook_parity] sha256(0x330007DB) = {hash}");
    assert_eq!(
        hash, GOLDEN_SHA256_MOON_0X330007DB,
        "golden sha256 drifted for moon 0x330007DB — expected {GOLDEN_SHA256_MOON_0X330007DB}, got {hash}"
    );
}

#[test]
fn golden_sha256_sky_chain_0x33000455() {
    let Some(path) = portal_dat_path() else {
        eprintln!(
            "SKIP create_particle_hook_parity::golden_sha256_sky_chain_0x33000455 — no portal.dat"
        );
        return;
    };
    let dat = DatDatabase::new(&path).expect("open client_portal.dat");

    let bytes = dat.get_file(0x33000455).expect("sky chain script");
    let script = PhysicsScript::unpack(&bytes).expect("parse sky chain script");
    let repacked = script.pack().expect("repack sky chain");
    assert_eq!(repacked, bytes, "sky chain round-trip");
    let hash = sha256_hex(&repacked);
    eprintln!("[create_particle_hook_parity] sha256(0x33000455) = {hash}");
    assert_eq!(
        hash, GOLDEN_SHA256_SKY_CHAIN_0X33000455,
        "golden sha256 drifted for sky chain 0x33000455 — expected {GOLDEN_SHA256_SKY_CHAIN_0X33000455}, got {hash}"
    );
}

/// Exhaustive sweep — round-trip *every* retail PhysicsScript in the
/// dat, asserting byte-equal on those that contain at least one
/// CreateParticle hook. This is the broadest parity gate.
#[test]
fn round_trip_every_retail_physics_script() {
    let Some(path) = portal_dat_path() else {
        eprintln!(
            "SKIP create_particle_hook_parity::round_trip_every_retail_physics_script — no portal.dat"
        );
        return;
    };
    let dat = DatDatabase::new(&path).expect("open client_portal.dat");

    // PhysicsScript file_type prefix is 0x33. Enumerate all
    // `0x33xxxxxx` entries from the directory.
    let physics_script_ids: Vec<u32> = dat
        .files
        .keys()
        .copied()
        .filter(|id| (*id & 0xFF000000) == 0x33000000)
        .collect();

    let mut scripts_total = 0usize;
    let mut scripts_with_create_particle = 0usize;
    let mut create_particle_hooks_total = 0usize;
    let mut mismatched_ids: Vec<u32> = Vec::new();

    for id in physics_script_ids {
        let bytes = match dat.get_file(id) {
            Ok(b) => b,
            Err(_) => continue,
        };

        let script = match PhysicsScript::unpack(&bytes) {
            Ok(s) => s,
            Err(e) => panic!("parse failed for 0x{id:08X}: {e}"),
        };

        let repacked = match script.pack() {
            Ok(b) => b,
            Err(e) => panic!("repack failed for 0x{id:08X}: {e}"),
        };

        if repacked != bytes {
            mismatched_ids.push(id);
            continue;
        }
        scripts_total += 1;

        let mut has_cp = false;
        for entry in &script.script_data {
            if entry.hook.hook_type == HOOK_TYPE_CREATE_PARTICLE {
                let _ = entry
                    .hook
                    .as_create_particle()
                    .expect("named-field decode for hook_type==13");
                create_particle_hooks_total += 1;
                has_cp = true;
            }
        }
        if has_cp {
            scripts_with_create_particle += 1;
        }
    }

    eprintln!(
        "[create_particle_hook_parity] sweep: {} PhysicsScripts round-tripped clean, \
         {} contained ≥1 CreateParticle, {} CreateParticle hooks decoded total, \
         {} mismatches",
        scripts_total,
        scripts_with_create_particle,
        create_particle_hooks_total,
        mismatched_ids.len(),
    );

    if !mismatched_ids.is_empty() {
        let preview: Vec<String> = mismatched_ids
            .iter()
            .take(8)
            .map(|id| format!("0x{id:08X}"))
            .collect();
        panic!(
            "{} retail PhysicsScript(s) failed byte-equal round-trip; first 8: {}",
            mismatched_ids.len(),
            preview.join(", ")
        );
    }

    // Ground the corpus size — there are well over 1000 PhysicsScripts
    // in retail client_portal.dat, but only require ≥10 so the test
    // doesn't pass trivially on a stub fixture.
    assert!(
        scripts_total >= 10,
        "expected at least 10 retail PhysicsScripts to round-trip, got {scripts_total}"
    );
    assert!(
        create_particle_hooks_total >= 5,
        "expected at least 5 CreateParticle hooks in the corpus, got {create_particle_hooks_total}"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal pure-Rust SHA-256, copied from `region_sound_info_parity.rs`
// (same constraint: cannot add the `sha2` crate without touching
// Cargo.toml). Reference: FIPS 180-4 §6.2.
// ─────────────────────────────────────────────────────────────────────────────

const SHA256_K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    let bit_len = (bytes.len() as u64).wrapping_mul(8);
    let mut padded = bytes.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0x00);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in padded.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, word) in chunk.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes(word.try_into().unwrap());
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let mut a = h[0];
        let mut b = h[1];
        let mut c = h[2];
        let mut d = h[3];
        let mut e = h[4];
        let mut f = h[5];
        let mut g = h[6];
        let mut hh = h[7];

        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(SHA256_K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut out = String::with_capacity(64);
    for word in &h {
        out.push_str(&format!("{word:08x}"));
    }
    out
}

#[test]
fn sha256_self_test_against_known_vectors() {
    // FIPS 180-2 §B.1
    assert_eq!(
        sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(
        sha256_hex(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}

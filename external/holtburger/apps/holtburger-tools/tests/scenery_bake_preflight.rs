//! Integration tests for `scenery-bake`'s pre-flight integrity gate.
//!
//! Two scenarios are exercised end-to-end via the compiled
//! `scenery-bake` binary (located by `env!("CARGO_BIN_EXE_scenery-bake")`):
//!
//! 1. REJECT — a synthetic `client_portal.dat` containing a modder-
//!    allocated record id (`0x01FF_0001`) is rejected by the pre-flight
//!    integrity scan. The CLI exits non-zero and emits an error message
//!    that mentions both `modder-allocated` and the exact offending id.
//!
//! 2. ACCEPT + SIDECAR — three minimal synthetic DATs that contain only
//!    canonical record ids (no `0x__FFxxxx`) drive a clean bake against
//!    LB `0xA9B4`. The CLI exits 0, emits a `0xA9B4.scenery.jsonl`
//!    (empty, since the synthetic Region has no `scene_info`) and a
//!    `bake-source.sha256` sidecar that contains the SHA-256 hex digests
//!    of the three input DAT files.
//!
//! ## Fixture strategy
//!
//! Option A (fully synthetic) per task brief: we hand-roll three minimal-
//! valid DAT files via [`build_minimal_dat`]. The DAT format is a
//! sectored, B-tree-indexed binary store:
//!
//! - Bytes `[0x140..0x190]` are the `DatHeader` (80 bytes: 15 u32s +
//!   16-byte version string + 1 u32 minor).
//! - The root directory node lives at sector offset `0x400`. Sectors
//!   chain via a 4-byte `next_address` prefix; remaining
//!   `block_size - 4` bytes are payload. A `next_address` of `0` marks
//!   the chain terminator. With `block_size = 1024`, a single
//!   1716-byte directory node spans two chained sectors
//!   (`0x400`→`0x800`, `0x800`→terminator).
//! - Each directory entry (`DatFileEntry`) is 24 bytes:
//!   `bit_flags, id, offset, size, timestamp, version`.
//!
//! For the ACCEPT path we also embed a minimal `Region` payload at
//! offset `0xC00` so the binary's post-pre-flight `get_file(0x13000000)`
//! succeeds; the synthetic region has `parts_mask = 0` so
//! `bake_landblock` short-circuits to `Vec::new()` and we get an empty
//! JSONL — exactly what the test asserts.
//!
//! Cell.dat carries one minimal `CellLandblock` at `0xA9B4FFFF` so the
//! per-LB bake doesn't take the "skip — landblock not in cell.dat" path
//! (which would suppress the JSONL write).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use sha2::{Digest, Sha256};
use tempfile::TempDir;

// ---------------------------------------------------------------------
// DAT-format constants (mirrored from `holtburger-dat::lib.rs`).
// ---------------------------------------------------------------------

const DAT_HEADER_OFFSET: u64 = 0x140;
const DAT_MAGIC: u32 = 0x0000_5442;
const DIRECTORY_NODE_SIZE: usize = 1716;
const BRANCHES_COUNT: usize = 62;
const BLOCK_SIZE: u32 = 1024;

// Layout offsets (all sector starts are block-aligned multiples of
// `BLOCK_SIZE`).
const ROOT_SECTOR_OFFSET: u32 = 0x400;
const ROOT_SECTOR_TAIL_OFFSET: u32 = ROOT_SECTOR_OFFSET + BLOCK_SIZE; // 0x800
const DATA_SECTOR_OFFSET: u32 = ROOT_SECTOR_TAIL_OFFSET + BLOCK_SIZE; // 0xC00

/// One DAT-directory entry. Matches the `DatFileEntry` BinRead layout:
/// six little-endian u32s, 24 bytes total.
#[derive(Clone, Copy)]
struct EntryDescriptor {
    id: u32,
    offset: u32,
    size: u32,
}

impl EntryDescriptor {
    fn write_into(&self, buf: &mut Vec<u8>) {
        buf.extend_from_slice(&0u32.to_le_bytes()); // bit_flags (uncompressed)
        buf.extend_from_slice(&self.id.to_le_bytes());
        buf.extend_from_slice(&self.offset.to_le_bytes());
        buf.extend_from_slice(&self.size.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes()); // timestamp
        buf.extend_from_slice(&0u32.to_le_bytes()); // version
    }
}

/// Build a minimal-valid DAT file with the given entries.
///
/// `payloads` is parallel to `entries` and supplies the bytes that
/// `get_file(entry.id)` should yield. The first payload goes at sector
/// [`DATA_SECTOR_OFFSET`]; subsequent payloads are appended on
/// `BLOCK_SIZE` boundaries.
///
/// Returns the assembled file bytes. Caller writes them to disk.
fn build_minimal_dat(entries_and_payloads: &[(u32, Vec<u8>)]) -> Vec<u8> {
    // Pre-compute entry offsets so the directory node can reference them
    // before any payload bytes are appended.
    let mut next_payload_offset = DATA_SECTOR_OFFSET;
    let mut entries: Vec<EntryDescriptor> = Vec::new();
    let mut payload_sector_starts: Vec<u32> = Vec::new();
    for (id, payload) in entries_and_payloads {
        let payload_offset = next_payload_offset;
        payload_sector_starts.push(payload_offset);
        entries.push(EntryDescriptor {
            id: *id,
            offset: payload_offset,
            size: payload.len() as u32,
        });
        // Each payload occupies ceil(size / block_data_size) sectors,
        // each `BLOCK_SIZE` long.
        let block_data_size = (BLOCK_SIZE - 4) as usize;
        let sector_count = if payload.is_empty() {
            1
        } else {
            payload.len().div_ceil(block_data_size)
        };
        next_payload_offset += sector_count as u32 * BLOCK_SIZE;
    }

    let total_size = next_payload_offset as usize;

    let mut out = vec![0u8; total_size];

    // ---- Header at offset 0x140 -----------------------------------
    let header = build_dat_header(BLOCK_SIZE, ROOT_SECTOR_OFFSET, total_size as u32);
    out[DAT_HEADER_OFFSET as usize..DAT_HEADER_OFFSET as usize + header.len()]
        .copy_from_slice(&header);

    // ---- Directory node (one leaf, branches all zero) -------------
    let mut node = Vec::with_capacity(DIRECTORY_NODE_SIZE);
    // 62 zero branches.
    for _ in 0..BRANCHES_COUNT {
        node.extend_from_slice(&0u32.to_le_bytes());
    }
    // entry_count
    node.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    // entries
    for e in &entries {
        e.write_into(&mut node);
    }
    // Zero-pad up to DIRECTORY_NODE_SIZE so the BinRead consumer never
    // hits EOF mid-struct (entries beyond `entry_count` are never
    // touched, but the buffer must still be 1716 bytes long).
    node.resize(DIRECTORY_NODE_SIZE, 0);

    // ---- Write the directory node across two chained sectors ------
    // First sector at ROOT_SECTOR_OFFSET: [next_addr=0x800][1020 bytes of node]
    write_sector(
        &mut out,
        ROOT_SECTOR_OFFSET,
        ROOT_SECTOR_TAIL_OFFSET,
        &node[0..(BLOCK_SIZE - 4) as usize],
    );
    // Second sector at ROOT_SECTOR_TAIL_OFFSET: [next_addr=0][rest of node]
    let tail_len = DIRECTORY_NODE_SIZE - (BLOCK_SIZE - 4) as usize;
    write_sector(
        &mut out,
        ROOT_SECTOR_TAIL_OFFSET,
        0,
        &node[(BLOCK_SIZE - 4) as usize..(BLOCK_SIZE - 4) as usize + tail_len],
    );

    // ---- Write each payload across its block-chain ----------------
    for (idx, (_id, payload)) in entries_and_payloads.iter().enumerate() {
        let mut sector = payload_sector_starts[idx];
        let block_data_size = (BLOCK_SIZE - 4) as usize;
        let mut remaining = payload.as_slice();
        while !remaining.is_empty() {
            let take = remaining.len().min(block_data_size);
            let next_sector = if take == remaining.len() {
                0
            } else {
                sector + BLOCK_SIZE
            };
            write_sector(&mut out, sector, next_sector, &remaining[..take]);
            remaining = &remaining[take..];
            sector += BLOCK_SIZE;
        }
        // Edge case: zero-byte payload still consumes one terminator
        // sector (next_addr=0, data empty). The header pre-allocates the
        // sector but `write_sector` only writes the 4-byte pointer.
        if payload.is_empty() {
            write_sector(&mut out, payload_sector_starts[idx], 0, &[]);
        }
    }

    out
}

/// Write one sector starting at `sector_offset`. The sector begins with
/// a 4-byte little-endian `next_address` pointer, then up to
/// `BLOCK_SIZE - 4` bytes of `data`.
fn write_sector(out: &mut [u8], sector_offset: u32, next_address: u32, data: &[u8]) {
    let so = sector_offset as usize;
    out[so..so + 4].copy_from_slice(&next_address.to_le_bytes());
    out[so + 4..so + 4 + data.len()].copy_from_slice(data);
}

/// Build the 80-byte `DatHeader` blob.
fn build_dat_header(block_size: u32, root_offset: u32, file_size: u32) -> Vec<u8> {
    let mut b = Vec::with_capacity(80);
    b.extend_from_slice(&DAT_MAGIC.to_le_bytes()); // magic
    b.extend_from_slice(&block_size.to_le_bytes());
    b.extend_from_slice(&file_size.to_le_bytes());
    b.extend_from_slice(&1u32.to_le_bytes()); // dataset (portal=1)
    b.extend_from_slice(&0u32.to_le_bytes()); // subset
    b.extend_from_slice(&0u32.to_le_bytes()); // free_head
    b.extend_from_slice(&0u32.to_le_bytes()); // free_tail
    b.extend_from_slice(&0u32.to_le_bytes()); // free_count
    b.extend_from_slice(&root_offset.to_le_bytes()); // root_offset
    b.extend_from_slice(&0u32.to_le_bytes()); // new_lru
    b.extend_from_slice(&0u32.to_le_bytes()); // old_lru
    b.extend_from_slice(&0u32.to_le_bytes()); // use_lru
    b.extend_from_slice(&0u32.to_le_bytes()); // master_map_id
    b.extend_from_slice(&0u32.to_le_bytes()); // engine_version
    b.extend_from_slice(&0u32.to_le_bytes()); // game_version
    b.extend_from_slice(&[0u8; 16]); // version_string
    b.extend_from_slice(&0u32.to_le_bytes()); // version_minor
    assert_eq!(b.len(), 80, "DatHeader must be exactly 80 bytes");
    b
}

// ---------------------------------------------------------------------
// Synthetic Region payload (Dereth, 0x13000000) — minimum that
// `Region::unpack` accepts. Mirrors the synthesizer in
// `holtburger-dat/src/file_type/region.rs::tests::synthetic_minimal_region`.
// ---------------------------------------------------------------------

fn build_minimal_region(id: u32) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&id.to_le_bytes()); // id
    bytes.extend_from_slice(&1u32.to_le_bytes()); // region_number
    bytes.extend_from_slice(&0u32.to_le_bytes()); // version
    // region_name = "X" (1 byte + 1 align pad to reach a 4-aligned offset).
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.push(b'X');
    bytes.extend_from_slice(&[0u8; 1]); // pad to 4-byte alignment

    // LandDefs: 8 u32 + 256 f32.
    for _ in 0..8 {
        bytes.extend_from_slice(&0u32.to_le_bytes());
    }
    for _ in 0..256 {
        bytes.extend_from_slice(&0.0f32.to_le_bytes());
    }

    // GameTime: zero_time_of_year (f64) + zero_year + day_length (f32)
    // + days_per_year + year_spec(empty pstring) + 3 vec counts.
    bytes.extend_from_slice(&0.0f64.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&0.0f32.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&0u16.to_le_bytes()); // pstring len = 0
    bytes.extend_from_slice(&[0u8; 2]); // align pad to 4
    bytes.extend_from_slice(&0u32.to_le_bytes()); // num_times_of_day
    bytes.extend_from_slice(&0u32.to_le_bytes()); // num_days_of_week
    bytes.extend_from_slice(&0u32.to_le_bytes()); // num_seasons

    bytes.extend_from_slice(&0u32.to_le_bytes()); // parts_mask = 0 (no scene_info)

    // TerrainDesc: 0 types + LandSurf{0, TexMerge{0,0,0,0,0}}.
    bytes.extend_from_slice(&0u32.to_le_bytes()); // num_terrain_types
    bytes.extend_from_slice(&0u32.to_le_bytes()); // LandSurf.surf_type
    bytes.extend_from_slice(&0u32.to_le_bytes()); // TexMerge.base_tex_size
    bytes.extend_from_slice(&0u32.to_le_bytes()); // n corner
    bytes.extend_from_slice(&0u32.to_le_bytes()); // n side
    bytes.extend_from_slice(&0u32.to_le_bytes()); // n road
    bytes.extend_from_slice(&0u32.to_le_bytes()); // n terrain_desc
    bytes
}

// ---------------------------------------------------------------------
// Synthetic CellLandblock payload — minimum that `CellLandblock::unpack`
// accepts. 252 bytes: id (u32) + has_objects (u32) + 81 u16 terrain +
// 81 u8 height + 1 align pad.
// ---------------------------------------------------------------------

fn build_minimal_cell_landblock(id: u32) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(252);
    bytes.extend_from_slice(&id.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes()); // has_objects = 0
    for _ in 0..81 {
        bytes.extend_from_slice(&0u16.to_le_bytes()); // terrain[i] = 0
    }
    for _ in 0..81 {
        bytes.push(0); // height[i] = 0
    }
    bytes.push(0); // align pad
    assert_eq!(bytes.len(), 252);
    bytes
}

// ---------------------------------------------------------------------
// Locate the cargo-built `scenery-bake` binary. `CARGO_BIN_EXE_<name>`
// is set by cargo at compile time of the integration test.
// ---------------------------------------------------------------------

fn scenery_bake_bin() -> &'static str {
    env!("CARGO_BIN_EXE_scenery-bake")
}

/// Pick a writable scratch root. Per `feedback_use_external_drives_for_scratch`
/// the project prefers `/mnt/wbterminal1/tmp/claude-scratch/` for noisy
/// build artifacts. Fall back to `tempfile::TempDir` if that path isn't
/// available (e.g. CI), which keeps the test portable.
fn scratch_root() -> TempDirOrPath {
    let scratch = Path::new("/mnt/wbterminal1/tmp/claude-scratch/scenery-bake-test");
    if Path::new("/mnt/wbterminal1/tmp").is_dir() {
        let _ = fs::create_dir_all(scratch);
        if scratch.is_dir() {
            // Make a unique subdir per test run so parallel cargo-test
            // jobs don't stomp each other.
            let unique = scratch.join(format!(
                "run-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            fs::create_dir_all(&unique).expect("create scratch run dir");
            return TempDirOrPath::Path(unique);
        }
    }
    TempDirOrPath::Temp(tempfile::tempdir().expect("tempdir fallback"))
}

/// Light wrapper around either a `TempDir` (auto-cleaned) or a manually-
/// chosen path under `/mnt/wbterminal1/tmp/claude-scratch/` which we
/// best-effort delete on Drop.
enum TempDirOrPath {
    Temp(TempDir),
    Path(PathBuf),
}

impl TempDirOrPath {
    fn path(&self) -> &Path {
        match self {
            TempDirOrPath::Temp(t) => t.path(),
            TempDirOrPath::Path(p) => p,
        }
    }
}

impl Drop for TempDirOrPath {
    fn drop(&mut self) {
        if let TempDirOrPath::Path(p) = self {
            // Best-effort cleanup; ignore errors so a test failure isn't
            // masked by a stray PermissionDenied.
            let _ = fs::remove_dir_all(p);
        }
    }
}

fn sha256_hex_of_file(path: &Path) -> String {
    let mut hasher = Sha256::new();
    let bytes = fs::read(path).expect("read for hash");
    hasher.update(&bytes);
    hex::encode(hasher.finalize())
}

/// Write a DAT file at `path` containing the given entries.
fn write_dat(path: &Path, entries_and_payloads: &[(u32, Vec<u8>)]) {
    let bytes = build_minimal_dat(entries_and_payloads);
    let mut f = fs::File::create(path).expect("create dat");
    f.write_all(&bytes).expect("write dat");
    f.sync_all().expect("sync dat");
}

// =====================================================================
// TEST 1 — REJECT
// =====================================================================

#[test]
fn scenery_bake_preflight_rejects_modder_allocated_record_id() {
    let scratch = scratch_root();
    let dat_dir = scratch.path().join("dat_dir");
    fs::create_dir_all(&dat_dir).expect("create dat_dir");

    // Synthetic portal.dat: ONE entry with a modder-allocated id
    // (0x01FF_0001 — top byte 0x01 in content-prefix range, second
    // byte 0xFF). The pre-flight `first_modder_allocated_id` scan must
    // catch this.
    let bad_id: u32 = 0x01FF_0001;
    write_dat(
        &dat_dir.join("client_portal.dat"),
        &[(bad_id, b"unused-payload-bytes".to_vec())],
    );
    // The other two DATs must parse cleanly so the scan reaches them.
    // Empty (zero-entry) DATs satisfy `DatDatabase::new` without
    // contributing any keys to the scan.
    write_dat(&dat_dir.join("client_cell_1.dat"), &[]);
    write_dat(&dat_dir.join("client_local_English.dat"), &[]);

    let out_dir = scratch.path().join("out");
    fs::create_dir_all(&out_dir).expect("create out");

    let output = Command::new(scenery_bake_bin())
        .arg("--dat-dir")
        .arg(&dat_dir)
        .arg("--landblocks")
        .arg("0xA9B4")
        .arg("--out")
        .arg(&out_dir)
        .output()
        .expect("spawn scenery-bake");

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);

    assert!(
        !output.status.success(),
        "expected non-zero exit; stdout={stdout} stderr={stderr}"
    );

    // Error message must call out the modder-allocated record and the
    // exact id. Bake-cli wraps the bail! in anyhow's chained context;
    // both substrings must surface.
    let combined = format!("{stdout}\n{stderr}");
    assert!(
        combined.contains("modder-allocated"),
        "stderr missing `modder-allocated`; got: {combined}"
    );
    assert!(
        combined.contains("0x01FF0001"),
        "stderr missing the offending id `0x01FF0001`; got: {combined}"
    );
    // Sidecar must NOT have been emitted — the bake bailed pre-flight.
    let sidecar = out_dir.join("bake-source.sha256");
    assert!(
        !sidecar.exists(),
        "sidecar was emitted despite pre-flight rejection at {}",
        sidecar.display()
    );
}

// =====================================================================
// TEST 2 — ACCEPT + SIDECAR
// =====================================================================

#[test]
fn scenery_bake_preflight_accepts_clean_dats_and_emits_sidecar_with_hashes() {
    let scratch = scratch_root();
    let dat_dir = scratch.path().join("dat_dir");
    fs::create_dir_all(&dat_dir).expect("create dat_dir");

    // portal.dat: ONE canonical Region entry at 0x13000000.
    let portal_path = dat_dir.join("client_portal.dat");
    write_dat(
        &portal_path,
        &[(0x1300_0000, build_minimal_region(0x1300_0000))],
    );

    // cell.dat: ONE canonical CellLandblock at 0xA9B4FFFF (the LB we'll
    // bake against). Without this the bake would short-circuit with
    // "skipping" and never create the JSONL file.
    let cell_path = dat_dir.join("client_cell_1.dat");
    write_dat(
        &cell_path,
        &[(0xA9B4_FFFF, build_minimal_cell_landblock(0xA9B4_FFFF))],
    );

    // local.dat: empty (never read by scenery-bake).
    let local_path = dat_dir.join("client_local_English.dat");
    write_dat(&local_path, &[]);

    // Pre-compute the expected hashes BEFORE running the bake so the
    // sidecar assertion is deterministic.
    let expected_portal_hash = sha256_hex_of_file(&portal_path);
    let expected_cell_hash = sha256_hex_of_file(&cell_path);
    let expected_local_hash = sha256_hex_of_file(&local_path);

    let out_dir = scratch.path().join("out");
    fs::create_dir_all(&out_dir).expect("create out");

    let output = Command::new(scenery_bake_bin())
        .arg("--dat-dir")
        .arg(&dat_dir)
        .arg("--landblocks")
        .arg("0xA9B4")
        .arg("--out")
        .arg(&out_dir)
        .output()
        .expect("spawn scenery-bake");

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);

    assert!(
        output.status.success(),
        "expected exit 0; status={:?} stdout={stdout} stderr={stderr}",
        output.status
    );

    // JSONL output: present even when zero placements were emitted
    // (the binary writes an empty file when the synthetic region has
    // no scene_info).
    let jsonl_path = out_dir.join("0xA9B4.scenery.jsonl");
    assert!(
        jsonl_path.exists(),
        "expected JSONL at {} (stderr={stderr})",
        jsonl_path.display()
    );

    // Sidecar: must exist and contain all three content hashes.
    let sidecar_path = out_dir.join("bake-source.sha256");
    assert!(
        sidecar_path.exists(),
        "expected sidecar at {} (stderr={stderr})",
        sidecar_path.display()
    );
    let sidecar = fs::read_to_string(&sidecar_path).expect("read sidecar");

    // Each hex digest line: `<filename>\t<64-char-hex>`.
    let expect_lines = [
        format!("client_portal.dat\t{expected_portal_hash}"),
        format!("client_cell_1.dat\t{expected_cell_hash}"),
        format!("client_local_English.dat\t{expected_local_hash}"),
    ];
    for needle in &expect_lines {
        assert!(
            sidecar.contains(needle),
            "sidecar missing `{needle}`; full sidecar:\n{sidecar}"
        );
    }
    // Sidecar also carries region-did + bake-mode + tool versions.
    assert!(sidecar.contains("region-did\t0x13000000"));
    assert!(sidecar.contains("bake-mode\tace-compat"));
    assert!(sidecar.contains("scenery-bake-cli/0.1.0"));
}

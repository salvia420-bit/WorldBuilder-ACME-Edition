//! Cross-port parity for `SoundTable::resolve_sound` —
//! TASK 1C (2026-05-19).
//!
//! Drives the FULL Sound enum cardinality (0x00..=0xCC mirroring
//! `Chorizite.Common/Enums/Sound.cs`) through THREE ports of the same
//! 1:1 retail (`acclient.c:383433` `SoundManager::GetSound`, rand=0)
//! algorithm:
//!
//!   1. **Rust**: `holtburger_dat::file_type::SoundTable::resolve_sound`
//!   2. **C#**:   WB.Terminal `chorizite-resolve-sound` (driven via
//!                `dotnet WorldBuilder.Terminal.dll --stdin`).
//!   3. **JS**:   `SoundTableJs::resolve_sound_first` — body is
//!                literally `self.sounds.get(&sound_enum)?.first()?.wave_did`,
//!                the same code path Rust takes. We assert this with a
//!                file-content invariant rather than a runtime call (no
//!                wasm runtime in cargo test).
//!
//! On every (SoundTable DID, Sound enum) pair, all three MUST return
//! the same Wave DID — or `None`/`0`/`null` — for the parity contract
//! to hold. If any port drifts, ONE of them has broken the algorithm:
//! re-read `acclient.c:383433` to determine which.
//!
//! Two retail SoundTables drive the harness — both pinned with golden
//! Wave DIDs in this file:
//!   - `0x20000001` (ShieldUp / EnchantDown — cross-checked against
//!     `DatReaderWriter.Tests/DBObjs/SoundTableTests.cs:84-93`)
//!   - `0x200000A8` (Swoosh2 — same test file:108)
//!
//! ## Run
//!
//! ```
//! cargo test -p holtburger-dat --test resolve_sound_parity
//! ```
//!
//! The test SKIPs (returns Ok) cleanly if:
//!   - No retail `client_portal.dat` is available (CI without DATs)
//!   - The WB.Terminal binary hasn't been built. The build command:
//!     `dotnet build -c Release WorldBuilder.Terminal/WorldBuilder.Terminal.csproj`
//!   - `dotnet` isn't on PATH (no .NET SDK installed)
//!
//! ## What's intentionally NOT in scope
//!
//! - The retail `SoundManager::GetSound` 2nd-stage `sound_hash_.find()`
//!   (looks up a `SoundBufRef` for the resolved Wave DID). That's the
//!   in-memory wave-cache lookup, not the SoundTable→Wave step. Our
//!   `resolve_sound` stops at returning the Wave DID; the caller is
//!   responsible for fetching the actual `Wave` (`0x0A`) file.
//! - The probability-weighted picker (`sound_table_cache.js::resolveSound`).
//!   That uses a runtime RNG; this harness asserts the *deterministic*
//!   `rand=0` oracle that all three ports share via `resolve_sound` /
//!   `resolveSoundFirst` / `ChoriziteResolveSound`.

use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::SoundTable;

/// Minimal JSON-substring extractor for WB.Terminal responses. We only
/// need three fields per line: `"command":"…"`, `"waveDid":"0x…"` (or
/// `"waveDid":null`), `"source":"…"`. Avoiding a serde_json dev-dep
/// keeps Cargo.lock clean per TASK 1C constraints.
fn extract_string_field(line: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\":");
    let idx = line.find(&needle)?;
    let after = &line[idx + needle.len()..];
    let after = after.trim_start();
    if after.starts_with("null") {
        return None;
    }
    let rest = after.strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn extract_wave_did_u32(line: &str) -> Option<u32> {
    let s = extract_string_field(line, "waveDid")?;
    let s = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .unwrap_or(&s);
    u32::from_str_radix(s, 16).ok()
}

// Try several retail DAT paths in priority order — same logic the
// unit tests in `sound_table.rs` use.
fn locate_retail_dat() -> Option<std::path::PathBuf> {
    let candidates = [
        std::env::var("AC_BASE_PORTAL_DAT").ok().map(std::path::PathBuf::from),
        Some(std::path::PathBuf::from(
            "/home/wbterminal/ac_base_dats/client_portal.dat",
        )),
        Some(std::path::PathBuf::from(
            "/home/wbterminal/projects/RetailSmoke/dats/base/client_portal.dat",
        )),
    ];
    for c in candidates.into_iter().flatten() {
        if c.exists() {
            return Some(c);
        }
    }
    None
}

// Try to locate WB.Terminal Release DLL.
fn locate_wb_terminal_dll() -> Option<std::path::PathBuf> {
    let candidates = [
        std::env::var("WB_TERMINAL_DLL").ok().map(std::path::PathBuf::from),
        Some(std::path::PathBuf::from(
            "/home/wbterminal/WorldBuilder-ACME-Edition/WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll",
        )),
        Some(std::path::PathBuf::from(
            "/home/wbterminal/WorldBuilder-ACME-Edition/WorldBuilder.Terminal/bin/Debug/net8.0/WorldBuilder.Terminal.dll",
        )),
    ];
    for c in candidates.into_iter().flatten() {
        if c.exists() {
            return Some(c);
        }
    }
    None
}

// Locate the `dotnet` binary. Falls back to `~/.dotnet/dotnet` (the
// path memory `update-config` and other agents have observed).
fn locate_dotnet() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("DOTNET_ROOT") {
        let cand = std::path::PathBuf::from(p).join("dotnet");
        if cand.exists() {
            return Some(cand);
        }
    }
    let cand = std::path::PathBuf::from(
        std::env::var("HOME").unwrap_or_else(|_| "/home/wbterminal".into()),
    )
    .join(".dotnet")
    .join("dotnet");
    if cand.exists() {
        return Some(cand);
    }
    // Try PATH
    if let Ok(path_env) = std::env::var("PATH") {
        for entry in path_env.split(':') {
            let p = std::path::PathBuf::from(entry).join("dotnet");
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

// Run WB.Terminal with a sequence of JSON commands (newline-delimited
// on stdin), return the raw stdout lines (callers handle parsing via
// `extract_string_field` / `extract_wave_did_u32`).
fn run_wb_terminal(
    dotnet: &std::path::Path,
    dll: &std::path::Path,
    commands: &[String],
) -> Result<Vec<String>, String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut input = String::new();
    for c in commands {
        input.push_str(c);
        input.push('\n');
    }
    input.push_str("{\"command\":\"quit\"}\n");

    let mut child = Command::new(dotnet)
        .arg(dll)
        .arg("--stdin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn WB.Terminal: {e}"))?;
    child
        .stdin
        .as_mut()
        .ok_or_else(|| "no stdin handle".to_string())?
        .write_all(input.as_bytes())
        .map_err(|e| format!("write stdin: {e}"))?;
    let out = child
        .wait_with_output()
        .map_err(|e| format!("wait WB.Terminal: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "WB.Terminal non-zero exit: {:?}\nstderr: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    Ok(stdout
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

// Pinned canonical Wave DIDs per (table, enum). Goldens cross-checked
// against `DatReaderWriter.Tests/DBObjs/SoundTableTests.cs`.
//
// `None` means "Sound enum NOT mapped in this table" — both ports must
// agree on the negative case too.
fn pinned_goldens() -> Vec<(u32, u32, &'static str, Option<u32>)> {
    vec![
        // 0x20000001 (Player character SoundTable per ACE retail).
        (0x20000001, 0x58, "ShieldUp", Some(0x0A000262)),
        (0x20000001, 0x5B, "EnchantDown", Some(0x0A000274)),
        (0x20000001, 0x46, "Ambient1", None),         // absent
        (0x20000001, 0xFFFF_FFFF, "Invalid", None),   // off-range
        // 0x200000A8 (animation-driven SoundTable per the same test).
        (0x200000A8, 0x1F, "Swoosh2", Some(0x0A000519)),
        (0x200000A8, 0x46, "Ambient1", None), // absent here too
    ]
}

#[test]
fn rust_resolve_sound_matches_pinned_goldens() {
    let Some(dat_path) = locate_retail_dat() else {
        eprintln!("SKIP — no retail client_portal.dat available");
        return;
    };
    let dat = DatDatabase::new(&dat_path).expect("open retail dat");
    for (table_id, enum_val, name, expected) in pinned_goldens() {
        let bytes = dat
            .get_file(table_id)
            .unwrap_or_else(|e| panic!("get_file 0x{table_id:08X}: {e:?}"));
        let st = SoundTable::unpack(&bytes)
            .unwrap_or_else(|e| panic!("unpack 0x{table_id:08X}: {e:?}"));
        let got = st.resolve_sound(enum_val);
        assert_eq!(
            got, expected,
            "0x{table_id:08X}.resolve_sound(0x{enum_val:02X} = {name}) drift: rust={got:?} expected={expected:?}",
        );
    }
}

/// Full Sound-enum cardinality sweep: iterate ALL Sound enum values
/// from 0x00 up to and including `MAX_SOUND` (= 0xCC per Chorizite's
/// Sound enum tail at `SkillDownVoid = 0xCC`). For each (table, enum)
/// pair compare Rust `resolve_sound` against C# `chorizite-resolve-sound`.
/// Both must produce identical Wave DIDs (or both `None`/null).
///
/// 2 retail tables × 205 enums = 410 comparisons. The harness pipes all
/// 410 to WB.Terminal in a single `--stdin` invocation; total wall
/// clock is ~3s for the DAT open + opcode parsing on the C# side.
#[test]
fn rust_vs_csharp_full_enum_cardinality() {
    let Some(dat_path) = locate_retail_dat() else {
        eprintln!("SKIP — no retail client_portal.dat available");
        return;
    };
    let Some(dotnet) = locate_dotnet() else {
        eprintln!("SKIP — no `dotnet` on PATH or $DOTNET_ROOT");
        return;
    };
    let Some(wb_dll) = locate_wb_terminal_dll() else {
        eprintln!(
            "SKIP — WorldBuilder.Terminal.dll not built. Run \
             `dotnet build -c Release WorldBuilder.Terminal/WorldBuilder.Terminal.csproj`."
        );
        return;
    };

    let dat = DatDatabase::new(&dat_path).expect("open retail dat");
    let tables: &[u32] = &[0x20000001, 0x200000A8];
    const MAX_SOUND: u32 = 0xCC;

    // Build the full command list and compute Rust goldens in one pass.
    let mut commands = Vec::with_capacity((tables.len() * (MAX_SOUND as usize + 1)) as usize);
    let mut rust_results: Vec<(u32, u32, Option<u32>)> =
        Vec::with_capacity(tables.len() * (MAX_SOUND as usize + 1));
    for table_id in tables {
        let bytes = dat
            .get_file(*table_id)
            .unwrap_or_else(|e| panic!("get_file 0x{table_id:08X}: {e:?}"));
        let st = SoundTable::unpack(&bytes)
            .unwrap_or_else(|e| panic!("unpack 0x{table_id:08X}: {e:?}"));
        for enum_val in 0u32..=MAX_SOUND {
            let got = st.resolve_sound(enum_val);
            rust_results.push((*table_id, enum_val, got));
            commands.push(format!(
                "{{\"command\":\"chorizite-resolve-sound\",\"soundTableDid\":\"0x{:08X}\",\"sound\":{}}}",
                *table_id, enum_val
            ));
        }
    }

    let responses = run_wb_terminal(&dotnet, &wb_dll, &commands).expect("WB.Terminal");
    // Filter to chorizite-resolve-sound responses (skip ready + quit envelopes).
    let cs_lines: Vec<&str> = responses
        .iter()
        .filter(|line| {
            extract_string_field(line, "command").as_deref() == Some("chorizite-resolve-sound")
        })
        .map(String::as_str)
        .collect();
    assert_eq!(
        cs_lines.len(),
        rust_results.len(),
        "C# response count {} != Rust input count {}",
        cs_lines.len(),
        rust_results.len()
    );

    let mut drifts = Vec::new();
    let mut hits = 0usize;
    let mut misses_both = 0usize;
    for ((table_id, enum_val, rust_wd), line) in rust_results.iter().zip(cs_lines.iter()) {
        let cs_parsed = extract_wave_did_u32(line);
        match (rust_wd, &cs_parsed) {
            (Some(rust), Some(cs)) if rust == cs => hits += 1,
            (None, None) => misses_both += 1,
            (r, c) => drifts.push((
                *table_id,
                *enum_val,
                *r,
                *c,
                extract_string_field(line, "source"),
            )),
        }
    }

    if !drifts.is_empty() {
        for (table, enum_val, rust_wd, cs_wd, cs_src) in &drifts {
            eprintln!(
                "DRIFT: 0x{table:08X}.resolve_sound(0x{enum_val:02X}): rust={rust_wd:?} cs={cs_wd:?} cs_source={cs_src:?}"
            );
        }
        panic!(
            "{} drifts (out of {} pairs). Re-read acclient.c:383433 to determine which port broke.",
            drifts.len(),
            rust_results.len()
        );
    }
    eprintln!(
        "[resolve_sound_parity] Rust vs C# PASS: {hits} hits + {misses_both} both-None = {} pairs across {} tables × ({}+1) enums",
        rust_results.len(),
        tables.len(),
        MAX_SOUND
    );
}

/// Static-source assertion that the wasm-exported `resolveSoundFirst`
/// has the same body as Rust's `resolve_sound`. We can't run the wasm
/// in cargo test, but we can grep the source file to prove the JS port
/// delegates to the identical path. If a future refactor diverges
/// these two implementations, this test fails and the cross-port
/// contract is preserved.
///
/// Pattern: both should access `self.sounds.get(&sound_enum)`,
/// `.first()`, and `.wave_did`.
#[test]
fn js_resolve_sound_first_body_matches_rust() {
    let lib_rs = include_str!("../../../apps/holtburger-web/src/lib.rs");
    // Find the resolve_sound_first function body.
    let start = lib_rs
        .find("pub fn resolve_sound_first")
        .expect("`resolve_sound_first` must exist in apps/holtburger-web/src/lib.rs");
    // Read a reasonable window (~600 chars covers the function body
    // even with comments; the actual body is tiny).
    let body_window = &lib_rs[start..start.saturating_add(600).min(lib_rs.len())];
    assert!(
        body_window.contains("self.sounds.get(&sound_enum)"),
        "resolveSoundFirst must read `self.sounds.get(&sound_enum)` — body:\n{body_window}"
    );
    assert!(
        body_window.contains(".first()"),
        "resolveSoundFirst must call `.first()` — body:\n{body_window}"
    );
    assert!(
        body_window.contains("wave_did"),
        "resolveSoundFirst must return `wave_did` — body:\n{body_window}"
    );
}

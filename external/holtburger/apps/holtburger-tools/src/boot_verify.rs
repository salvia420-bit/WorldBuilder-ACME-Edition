//! E4 — boot-pack reachability verification for the CLI tools.
//!
//! The transitive boot-reachability walker
//! ([`holtburger_dat::walk_boot_reachability`] /
//! [`holtburger_dat::StripperManifest::verify_boot_reachability`])
//! answers a single question for a produced boot pack: **is the boot
//! landblock fully packable?** — i.e. does the archive contain every
//! GfxObj / Surface / SurfaceTexture / Texture / Palette record that
//! the spawn-area object placements transitively reference?
//!
//! Until E4 the walker had no binary caller. This module wires it into
//! `dat2hba --profile boot --verify-boot-reachability` and
//! `dat-shard --verify-boot-reachability`: after the tool has written
//! its HBA / `boot.hba`, the produced archive is re-opened as a
//! [`ResourceSource`] and the walk is run against it, printing a concise
//! report and letting CI gate the bake on `!fully_packable`.
//!
//! The verification is **read-only** and entirely additive — it never
//! mutates the produced archive and is only performed when the caller
//! opts in via the flag.

use std::path::Path;

use holtburger_dat::{BootReachability, HbaReader, StripperManifest};

use crate::error::{Result, ToolError};

/// How many DIDs to list inline in the report before truncating. The
/// walk can touch thousands of records; a capped list keeps CI logs
/// readable while still surfacing the first offenders.
pub const REPORT_DID_CAP: usize = 32;

/// Exit code emitted when a boot pack is verified and found **not**
/// fully packable. Distinct from `1` (the default `Result`-main error
/// code) so CI can tell a dangling-reference gate failure apart from a
/// tool crash / bad-args failure.
pub const EXIT_NOT_FULLY_PACKABLE: i32 = 3;

/// Open `hba_path` as a [`ResourceSource`] and run the boot-reachability
/// walk against it for `boot_landblock`. Read-only; does not mutate the
/// archive.
///
/// Returns the [`BootReachability`] result so callers can both render a
/// report and branch on `fully_packable`.
pub fn verify_boot_pack(hba_path: &Path, boot_landblock: u32) -> Result<BootReachability> {
    let reader = HbaReader::open(hba_path)
        .map_err(|e| ToolError::DatOpen(hba_path.to_path_buf(), e.to_string()))?;
    Ok(StripperManifest::verify_boot_reachability(
        &reader,
        boot_landblock,
    ))
}

/// Render a concise, deterministic report of a [`BootReachability`]
/// result to a string. Both binaries share this so their output stays
/// identical.
///
/// Lists are sorted (the walk stores DIDs in `BTreeSet`s) and capped at
/// [`REPORT_DID_CAP`]; the headline line is machine-greppable
/// (`fully_packable=<bool>`).
pub fn format_report(result: &BootReachability, boot_landblock: u32) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "boot-reachability: landblock=0x{boot_landblock:04X} fully_packable={} reachable={} missing={}\n",
        result.fully_packable,
        result.reachable_dids.len(),
        result.missing_dids.len(),
    ));
    out.push_str(&format_did_list("reachable", &result.reachable_dids));
    out.push_str(&format_did_list("missing", &result.missing_dids));
    out
}

fn format_did_list(label: &str, dids: &std::collections::BTreeSet<u32>) -> String {
    if dids.is_empty() {
        return format!("  {label}: (none)\n");
    }
    let mut out = format!("  {label} ({}):", dids.len());
    for did in dids.iter().take(REPORT_DID_CAP) {
        out.push_str(&format!(" 0x{did:08X}"));
    }
    if dids.len() > REPORT_DID_CAP {
        out.push_str(&format!(" … (+{} more)", dids.len() - REPORT_DID_CAP));
    }
    out.push('\n');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn report_headline_is_machine_greppable_when_packable() {
        let result = BootReachability {
            reachable_dids: BTreeSet::from([0xA9B4_FFFE, 0x0100_1234]),
            missing_dids: BTreeSet::new(),
            fully_packable: true,
        };
        let report = format_report(&result, 0xA9B4);
        assert!(report.contains("fully_packable=true"));
        assert!(report.contains("landblock=0xA9B4"));
        assert!(report.contains("reachable=2"));
        assert!(report.contains("missing=0"));
        assert!(report.contains("  missing: (none)"));
        // DIDs are zero-padded 8-hex uppercase.
        assert!(report.contains("0x01001234"));
    }

    #[test]
    fn report_lists_missing_dids_when_not_packable() {
        let result = BootReachability {
            reachable_dids: BTreeSet::from([0xA9B4_FFFE]),
            missing_dids: BTreeSet::from([0x0600_1000, 0x0500_1000]),
            fully_packable: false,
        };
        let report = format_report(&result, 0xA9B4);
        assert!(report.contains("fully_packable=false"));
        assert!(report.contains("missing=2"));
        // Sorted ascending by BTreeSet ordering.
        assert!(report.contains("missing (2): 0x05001000 0x06001000"));
    }

    #[test]
    fn report_caps_long_did_lists() {
        let reachable: BTreeSet<u32> = (0..(REPORT_DID_CAP as u32 + 5)).collect();
        let result = BootReachability {
            reachable_dids: reachable,
            missing_dids: BTreeSet::new(),
            fully_packable: true,
        };
        let report = format_report(&result, 0xA9B4);
        assert!(report.contains(&format!("(+{} more)", 5)));
        // The header still reports the true (uncapped) count.
        assert!(report.contains(&format!("reachable={}", REPORT_DID_CAP + 5)));
    }
}

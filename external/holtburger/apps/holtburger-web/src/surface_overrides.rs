//! Phase 1.5 — manual surface override layer (consulted BEFORE the
//! Phase 1.4 heuristic in `holtburger_dat::surface_classify::classify`).
//!
//! Source-of-truth JSON lives at `external/holtburger/data/surface_overrides.json`
//! and is baked into the wasm bundle via `include_str!` (small enough —
//! ~10 entries × ~300 bytes each). The native test target reads the
//! same file the same way, so unit tests assert against the shipped
//! data rather than a fixture.
//!
//! Schema (`Phase 1.5 Objectives #1`):
//!
//! ```json
//! {
//!   "version": 1,
//!   "overrides": {
//!     "0x06001234": {
//!       "category": "Stone",
//!       "roughness": 0.95,
//!       "normal_scale": 0.6,
//!       "notes": "Free-form authoring comment"
//!     }
//!   }
//! }
//! ```
//!
//! Fields are all optional except the surrounding DID key:
//! - `category` — `Option<SurfaceCategory>` parsed from the canonical
//!   label string (`"Stone"`, `"Wood"`, …, `"Generic"`); a missing key
//!   or explicit `null` means "fall through to the heuristic" (per
//!   §Phase 1.5 hand-off note 2).
//! - `roughness`, `normal_scale` — `Option<f32>` material-parameter
//!   overrides that JS-side `materials.js::_materialFromFlags` reads
//!   after applying the category default. Bypassing the category and
//!   tweaking just one number is supported (e.g. `0x080006E2` glass
//!   stays Generic but lowers roughness to 0.25).
//! - `notes` — free-form authoring comment, unparsed.
//!
//! Resilient behaviour (per §Phase 1.5 hand-off note 1):
//! - Missing file → empty map (impossible with `include_str!` but the
//!   shape of the loader stays compatible with a future "fetch at
//!   runtime" path).
//! - Malformed JSON → log the parse error and return an empty map.
//!   Never panic the renderer.
//! - Unknown category string → log and skip just that entry.

use holtburger_dat::surface_classify::SurfaceCategory;
use serde::Deserialize;
use std::collections::HashMap;

/// The bundled overrides JSON. Path is relative to this source file
/// (`external/holtburger/apps/holtburger-web/src/`).
#[cfg(any(target_arch = "wasm32", test))]
const OVERRIDES_JSON: &str = include_str!("../../../data/surface_overrides.json");

/// One row in the override map.
///
/// All fields optional — an entry with just `notes` is a documented
/// no-op (useful while authoring/iterating without losing context).
#[derive(Debug, Clone, Default)]
pub struct OverrideEntry {
    pub category: Option<SurfaceCategory>,
    pub roughness: Option<f32>,
    pub normal_scale: Option<f32>,
}

/// Raw on-disk shape — string category, optional fields, dropped notes.
#[derive(Debug, Deserialize)]
struct RawOverrideEntry {
    #[serde(default)]
    category: Option<serde_json::Value>,
    #[serde(default)]
    roughness: Option<f32>,
    #[serde(default)]
    normal_scale: Option<f32>,
    // notes intentionally not deserialized — read by humans only.
}

#[derive(Debug, Deserialize)]
struct RawOverrideDoc {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    overrides: HashMap<String, RawOverrideEntry>,
}

/// Map category label → enum. Mirrors `SurfaceCategory::label`.
fn category_from_label(s: &str) -> Option<SurfaceCategory> {
    match s {
        "Stone" => Some(SurfaceCategory::Stone),
        "Wood" => Some(SurfaceCategory::Wood),
        "Metal" => Some(SurfaceCategory::Metal),
        "Sand" => Some(SurfaceCategory::Sand),
        "Lava" => Some(SurfaceCategory::Lava),
        "Water" => Some(SurfaceCategory::Water),
        "Foliage" => Some(SurfaceCategory::Foliage),
        "Cloth" => Some(SurfaceCategory::Cloth),
        "Dirt" => Some(SurfaceCategory::Dirt),
        "Snow" => Some(SurfaceCategory::Snow),
        "Brick" => Some(SurfaceCategory::Brick),
        "Tile" => Some(SurfaceCategory::Tile),
        "Generic" => Some(SurfaceCategory::Generic),
        _ => None,
    }
}

/// Parse a `"0xAABBCCDD"` or `"AABBCCDD"` hex string into u32.
/// Returns `None` for unparseable input (caller skips the entry +
/// logs the warning).
fn parse_did(s: &str) -> Option<u32> {
    let stripped = s.trim_start_matches("0x").trim_start_matches("0X");
    u32::from_str_radix(stripped, 16).ok()
}

/// Resolve `category` JSON value. Accepts string labels and JSON null.
/// Unknown strings → None (per hand-off note 2 — null/missing means
/// "fall through to the heuristic", unknown strings get the same
/// treatment + a warning).
fn resolve_category(v: &Option<serde_json::Value>, did_label: &str) -> Option<SurfaceCategory> {
    let val = v.as_ref()?;
    if val.is_null() {
        return None;
    }
    let s = val.as_str()?;
    let cat = category_from_label(s);
    if cat.is_none() {
        log_warn(&format!(
            "surface_overrides: unknown category {:?} for {} — skipping field",
            s, did_label
        ));
    }
    cat
}

/// Parse the bundled JSON into an in-memory map. Resilient: malformed
/// JSON → empty map + logged error.
#[cfg(any(target_arch = "wasm32", test))]
pub fn load_overrides() -> HashMap<u32, OverrideEntry> {
    parse_overrides_str(OVERRIDES_JSON)
}

/// Inner helper exposed for tests so we can drive it with synthetic
/// inputs (round-trip, malformed JSON, unknown category, etc).
pub fn parse_overrides_str(json: &str) -> HashMap<u32, OverrideEntry> {
    let doc: RawOverrideDoc = match serde_json::from_str(json) {
        Ok(d) => d,
        Err(e) => {
            log_warn(&format!(
                "surface_overrides: failed to parse override JSON — returning empty map. Error: {}",
                e
            ));
            return HashMap::new();
        }
    };
    if doc.version != 1 {
        log_warn(&format!(
            "surface_overrides: unsupported version {} (expected 1) — proceeding anyway",
            doc.version
        ));
    }

    let mut out = HashMap::with_capacity(doc.overrides.len());
    for (did_str, raw) in doc.overrides {
        let Some(did) = parse_did(&did_str) else {
            log_warn(&format!(
                "surface_overrides: invalid DID key {:?} — skipping entry",
                did_str
            ));
            continue;
        };
        let entry = OverrideEntry {
            category: resolve_category(&raw.category, &did_str),
            roughness: raw.roughness,
            normal_scale: raw.normal_scale,
        };
        // Skip fully-empty entries (no fields populated). They're not
        // wrong — the JSON layer accepts notes-only rows — but storing
        // them is pure overhead at lookup time.
        if entry.category.is_none() && entry.roughness.is_none() && entry.normal_scale.is_none() {
            continue;
        }
        out.insert(did, entry);
    }
    out
}

/// Resilient lookup — call this from the renderer's per-surface path
/// before invoking the Phase 1.4 heuristic.
pub fn lookup(map: &HashMap<u32, OverrideEntry>, did: u32) -> Option<&OverrideEntry> {
    map.get(&did)
}

// --- logging shim --------------------------------------------------------

#[cfg(target_arch = "wasm32")]
fn log_warn(msg: &str) {
    // Reuse the `console.warn` glue. Avoids dragging `web_sys` into the
    // override module — extern is enough for diagnostics.
    web_console_warn(msg);
}

#[cfg(not(target_arch = "wasm32"))]
fn log_warn(msg: &str) {
    eprintln!("{}", msg);
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    #[wasm_bindgen::prelude::wasm_bindgen(js_namespace = console, js_name = warn)]
    fn web_console_warn(s: &str);
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_doc_yields_empty_map() {
        let m = parse_overrides_str(r#"{"version":1,"overrides":{}}"#);
        assert!(m.is_empty());
    }

    #[test]
    fn malformed_json_returns_empty() {
        let m = parse_overrides_str("not json at all {");
        assert!(m.is_empty());
    }

    #[test]
    fn unknown_category_skips_field_but_keeps_entry_if_other_fields_set() {
        let m = parse_overrides_str(
            r#"{"version":1,"overrides":{"0x06001234":{"category":"Plasma","roughness":0.5}}}"#,
        );
        let e = m.get(&0x06001234).expect("entry retained for roughness");
        assert!(e.category.is_none());
        assert_eq!(e.roughness, Some(0.5));
    }

    #[test]
    fn unknown_category_only_entry_dropped() {
        let m = parse_overrides_str(
            r#"{"version":1,"overrides":{"0x06001234":{"category":"Plasma"}}}"#,
        );
        // category was the only field — unknown → no fields → entry
        // dropped per the "skip fully-empty" guard.
        assert!(m.is_empty());
    }

    #[test]
    fn null_category_means_fallthrough() {
        let m = parse_overrides_str(
            r#"{"version":1,"overrides":{"0x06001234":{"category":null,"roughness":0.7}}}"#,
        );
        let e = m.get(&0x06001234).unwrap();
        assert!(e.category.is_none());
        assert_eq!(e.roughness, Some(0.7));
    }

    #[test]
    fn round_trips_all_canonical_labels() {
        let mut s = String::from(r#"{"version":1,"overrides":{"#);
        let labels = [
            "Stone", "Wood", "Metal", "Sand", "Lava", "Water", "Foliage", "Cloth", "Dirt", "Snow",
            "Brick", "Tile", "Generic",
        ];
        for (i, lbl) in labels.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            s.push_str(&format!(r#""0x06{:06X}":{{"category":"{}"}}"#, i + 1, lbl));
        }
        s.push_str("}}");
        let m = parse_overrides_str(&s);
        assert_eq!(m.len(), labels.len());
    }

    #[test]
    fn invalid_did_key_skipped() {
        let m = parse_overrides_str(
            r#"{"version":1,"overrides":{"not-a-did":{"category":"Stone"}}}"#,
        );
        assert!(m.is_empty());
    }

    #[test]
    fn parses_hex_with_and_without_prefix() {
        let m = parse_overrides_str(
            r#"{"version":1,"overrides":{
                "0x06001234":{"category":"Stone"},
                "06005678":{"category":"Wood"}
            }}"#,
        );
        assert!(m.contains_key(&0x06001234));
        assert!(m.contains_key(&0x06005678));
    }

    #[test]
    fn shipped_overrides_load_and_contain_seed_dids() {
        // The bundled JSON parses cleanly, contains all 5 wave-1
        // seed DIDs, and has at least 10 total entries.
        let m = load_overrides();
        assert!(
            m.len() >= 10,
            "expected at least 10 override entries, got {}",
            m.len()
        );
        let seeds = [
            0x080000DDu32,
            0x0800073Eu32,
            0x080008CAu32,
            0x080008F3u32,
            0x08000914u32,
        ];
        for did in seeds {
            assert!(
                m.contains_key(&did),
                "seed DID 0x{:08X} missing from shipped overrides",
                did
            );
        }
    }

    #[test]
    fn lookup_returns_entry_or_none() {
        let m = parse_overrides_str(
            r#"{"version":1,"overrides":{"0x06001234":{"category":"Stone"}}}"#,
        );
        assert!(lookup(&m, 0x06001234).is_some());
        assert!(lookup(&m, 0xDEADBEEF).is_none());
    }

    #[test]
    fn shipped_seed_categories_match_audit() {
        // Per §Phase 1.5 wave-1 seed table.
        let m = load_overrides();
        let expected: &[(u32, SurfaceCategory)] = &[
            (0x080000DD, SurfaceCategory::Generic),
            (0x0800073E, SurfaceCategory::Cloth),
            (0x080008CA, SurfaceCategory::Cloth),
            (0x080008F3, SurfaceCategory::Dirt),
            (0x08000914, SurfaceCategory::Stone),
        ];
        for (did, cat) in expected {
            let e = m.get(did).expect("seed DID present");
            assert_eq!(
                e.category,
                Some(*cat),
                "DID 0x{:08X} category mismatch",
                did
            );
        }
    }
}

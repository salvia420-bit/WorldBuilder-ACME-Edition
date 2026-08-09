//! T12 (ST2, `?packSource`) — wasm-bindgen glue between the JS
//! `PackFetchController` (scene3d/pack_fetch_controller.js, the sole
//! fetch authority when the flag is ON) and the Rust
//! `PackSource`/`CompositeSource` seam in holtburger-resource-http.
//!
//! Contract (pass 3 S1.1–S1.3):
//! - the CONTROLLER fetches and sha256-verifies every CAS object BEFORE
//!   these exports see a byte ("nothing renders from unverified bytes");
//! - `pack_source_init(index_bytes)` runs AFTER `init_resource_source`
//!   resolved: it parses the HBSI1 index, builds the (empty) PackSource
//!   pinned to it, and arms the composite read path inside the live
//!   `ManifestResourceSource` (pack → boot → shards; prefetch skips
//!   pack-served keys);
//! - `pack_source_insert(hash16_hex, bytes)` admits one verified pack
//!   (CRC + pinned-index membership re-checked Rust-side);
//! - OFF arm: none of these are called and every read path is
//!   byte-identical legacy behavior (the `packs: None` fast path).
//!
//! MAIN INSTANCE ONLY at T12: the bake worker keeps the pure legacy
//! path — worker pack LEASES are the ST7 (pass 6 D-03.3) machinery.

#![cfg(target_arch = "wasm32")]

use std::cell::RefCell;
use std::sync::Arc;

use holtburger_resource_http::pack::{PackSource, hash16_from_hex};
use wasm_bindgen::prelude::*;

use crate::global_source::try_global_source;

thread_local! {
    static PACK_SOURCE: RefCell<Option<Arc<PackSource>>> = const { RefCell::new(None) };
}

/// Parse an HBSI1 index, build the session-pinned `PackSource`, and arm
/// the composite seam on the live manifest source. Returns a small JSON
/// summary. Errors (string-typed, JS-thrown): bad index bytes, no live
/// manifest source (call `init_resource_source` first), or the v1
/// manifest path (no seam by design).
#[wasm_bindgen]
pub fn pack_source_init(index_bytes: &[u8]) -> Result<String, JsValue> {
    let source = try_global_source().ok_or_else(|| {
        JsValue::from_str("pack_source_init: init_resource_source must resolve first")
    })?;
    let pack = Arc::new(
        PackSource::from_index_bytes(index_bytes)
            .map_err(|e| JsValue::from_str(&format!("pack_source_init: {e}")))?,
    );
    if !source.attach_pack_source(pack.clone()) {
        return Err(JsValue::from_str(
            "pack_source_init: manifest v1 source has no pack seam (re-bake with v2)",
        ));
    }
    let idx = pack.index();
    let tiles = idx.tile_grid.iter().filter(|&&t| t != 0xFFFF).count();
    let summary = format!(
        "{{\"packs\":{},\"tiles\":{},\"interiors\":{},\"shared\":{},\"epoch\":{}}}",
        idx.packs.len(),
        tiles,
        idx.interiors.len(),
        idx.shared.len(),
        idx.epoch
    );
    PACK_SOURCE.with(|cell| {
        *cell.borrow_mut() = Some(pack);
    });
    Ok(summary)
}

/// Admit one controller-verified pack. `hash16_hex` is the 32-char CAS
/// name the controller verified the bytes against. Returns JSON
/// `{kind, recordsRegistered, duplicate}`.
#[wasm_bindgen]
pub fn pack_source_insert(hash16_hex: &str, bytes: Vec<u8>) -> Result<String, JsValue> {
    let hash = hash16_from_hex(hash16_hex)
        .map_err(|e| JsValue::from_str(&format!("pack_source_insert: {e}")))?;
    PACK_SOURCE.with(|cell| {
        let borrow = cell.borrow();
        let Some(pack) = borrow.as_ref() else {
            return Err(JsValue::from_str(
                "pack_source_insert: pack_source_init must run first",
            ));
        };
        let st = pack
            .insert_pack(hash, bytes)
            .map_err(|e| JsValue::from_str(&format!("pack_source_insert: {e}")))?;
        Ok(format!(
            "{{\"kind\":{},\"recordsRegistered\":{},\"duplicate\":{}}}",
            st.kind, st.records_registered, st.duplicate
        ))
    })
}

/// Diag snapshot (JSON), or `"null"` when the seam is unarmed (OFF arm).
/// Feeds `__hbFetch.packSource` on the controller's diag surface.
#[wasm_bindgen]
pub fn pack_source_stats() -> String {
    PACK_SOURCE.with(|cell| match cell.borrow().as_ref() {
        None => "null".to_string(),
        Some(pack) => {
            let s = pack.stats();
            format!(
                "{{\"packsResident\":{},\"records\":{},\"packFileBytes\":{},\"sectionBytes\":{},\"hits\":{},\"misses\":{}}}",
                s.packs_resident, s.records, s.pack_file_bytes, s.section_bytes, s.hits, s.misses
            )
        }
    })
}

/// True when the armed pack source can serve `(namespace, file_id)` right
/// now — harness/diag probe (e.g. asserting a ring record went pack-side).
#[wasm_bindgen]
pub fn pack_source_serves(namespace: &str, file_id: u32) -> bool {
    PACK_SOURCE.with(|cell| match cell.borrow().as_ref() {
        None => false,
        Some(pack) => pack.serves(holtburger_dat::ResourceKey::new(namespace, file_id)),
    })
}

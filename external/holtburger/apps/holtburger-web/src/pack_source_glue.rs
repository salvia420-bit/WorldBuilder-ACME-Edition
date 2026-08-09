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
                "{{\"packsResident\":{},\"records\":{},\"packFileBytes\":{},\"sectionBytes\":{},\"hits\":{},\"misses\":{},\
                 \"pinnedPacks\":{},\"pinnedBytes\":{},\"budgetBytes\":{},\"sectionBudgetBytes\":{},\
                 \"floorMs\":{},\"evictions\":{},\"evictDeferrals\":{},\"overBudget\":{},\
                 \"pvwRows\":{},\"texrefRows\":{}}}",
                s.packs_resident, s.records, s.pack_file_bytes, s.section_bytes, s.hits, s.misses,
                s.pinned_packs, s.pinned_bytes, s.budget_bytes, s.section_budget_bytes,
                s.floor_ms, s.evictions, s.evict_deferrals, s.over_budget,
                s.pvw_rows, s.texref_rows
            )
        }
    })
}

// ── T20 (ST7, `?slotGrid`) — PackStore residency policy exports ────────────
// Pass 6 D-06.5: pins are the ONLY cross-boundary lifetime signal (D-06.7 —
// idempotent per slot via the JS ledger, refcounted here). Budgets/floors
// are enforced Rust-side against caller-supplied clocks (JS holds policy
// time). Called only on the `?slotGrid=on` arm; the OFF arm never touches
// any of these and the store keeps its T12 grow-only behavior BELOW budget
// (enforcement only ever runs when the grid wiring drives it).

/// Pin a resident pack for a grid slot / the session. Returns false when
/// the hash is not resident (pin-before-admission is a caller bug — the
/// grid pins on STAGED, after `pack_source_insert`).
#[wasm_bindgen]
pub fn pack_source_pin(hash16_hex: &str) -> bool {
    let Ok(hash) = hash16_from_hex(hash16_hex) else { return false };
    PACK_SOURCE.with(|cell| match cell.borrow().as_ref() {
        None => false,
        Some(pack) => pack.pin_pack(&hash),
    })
}

/// Drop one pin; `now_ms` stamps the UseTime floor at refcount 0. Returns
/// false for an unpinned/non-resident hash (the JS ledger audits that as a
/// pin leak).
#[wasm_bindgen]
pub fn pack_source_unpin(hash16_hex: &str, now_ms: f64) -> bool {
    let Ok(hash) = hash16_from_hex(hash16_hex) else { return false };
    PACK_SOURCE.with(|cell| match cell.borrow().as_ref() {
        None => false,
        Some(pack) => pack.unpin_pack(&hash, now_ms),
    })
}

/// One budget-enforcement pass (glue calls after inserts/unpins + the 1 Hz
/// ladder tick). JSON `{evicted, deferred, stillOver}`.
#[wasm_bindgen]
pub fn pack_source_enforce(now_ms: f64) -> String {
    PACK_SOURCE.with(|cell| match cell.borrow().as_ref() {
        None => "null".to_string(),
        Some(pack) => {
            let r = pack.enforce_budget(now_ms);
            format!(
                "{{\"evicted\":{},\"deferred\":{},\"stillOver\":{}}}",
                r.evicted, r.deferred, r.still_over
            )
        }
    })
}

/// Ladder R3 lever: set/restore the pack + section budgets (bytes).
#[wasm_bindgen]
pub fn pack_source_set_budgets(budget_bytes: f64, section_budget_bytes: f64) {
    PACK_SOURCE.with(|cell| {
        if let Some(pack) = cell.borrow().as_ref() {
            pack.set_budgets(budget_bytes.max(1.0) as usize, section_budget_bytes.max(1.0) as usize);
        }
    });
}

/// Ladder R4 lever: lower the UseTime floor. Rust clamps to ≥ 5 s — a
/// floor can be lowered, NEVER zeroed (D-06.5).
#[wasm_bindgen]
pub fn pack_source_set_floor_ms(ms: f64) {
    PACK_SOURCE.with(|cell| {
        if let Some(pack) = cell.borrow().as_ref() {
            pack.set_floor_ms(ms);
        }
    });
}

/// Census accessor for `hb_mem_census` (packBytes / packSections rows —
/// pass 6 D-06.9.1). `None` = seam unarmed (rows read 0 with their budget;
/// the bake-worker instance is ALWAYS unarmed at T20, so its census reads
/// `packBytes: 0` by construction — the D-06.8 ownership rule).
pub(crate) fn pack_source_census() -> Option<holtburger_resource_http::pack::PackSourceStats> {
    PACK_SOURCE.with(|cell| cell.borrow().as_ref().map(|p| p.stats()))
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

// ── T15 (ST5, `?texCompressedOnly`) — PVW/TEXREF sync reads ────────────────
// Pass 5 D-05.5: the frame-1 material path reads the resident PVW preview
// SYNCHRONOUSLY (packs for the ring are resident before materials build —
// pass 3 S1.4). Both exports are cheap map lookups; the OFF arm never
// calls them (seam unarmed ⇒ empty/-1, the caller's legacy-route signal).

/// The PVW preview payload (raw HBC7 container bytes) for one
/// RenderSurface id. EMPTY Vec = not resident / seam unarmed — the caller
/// treats a TEXREF'd rsId with no PVW as LOUD deploy skew (pass 5
/// D-05.5.4: `texrefMissingPvw` must stay 0), never a silent RGBA8 route.
#[wasm_bindgen]
pub fn pack_pvw_blocks(rs_id: u32) -> Vec<u8> {
    PACK_SOURCE.with(|cell| match cell.borrow().as_ref() {
        None => Vec::new(),
        Some(pack) => pack.pvw_payload(rs_id).unwrap_or_default(),
    })
}

/// The TEXREF row for one RenderSurface id, packed as
/// `(tier_bits << 8) | dims`, or `-1` when no resident pack carries a
/// TEXREF for it (⇒ not world-texture content: equipment/dynamic stays on
/// the legacy lane).
#[wasm_bindgen]
pub fn pack_texref(rs_id: u32) -> i32 {
    PACK_SOURCE.with(|cell| match cell.borrow().as_ref() {
        None => -1,
        Some(pack) => match pack.texref(rs_id) {
            Some((tier, dims)) => ((tier as i32) << 8) | dims as i32,
            None => -1,
        },
    })
}

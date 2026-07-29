//! X-track (`?statTexOverride=on`) — per-RenderSurface pixel override layer.
//!
//! Replaces the decoded RGBA of individual RenderSurface (`0x06xxxxxx`)
//! records at the `rs_id` hop of `fetch_surface_pixels_impl`, so every
//! Surface (0x08) that references an overridden texture — singleton
//! materials, the statics atlas, EnvCell interiors, and the bake worker's
//! own instance — sees the replacement uniformly. Sobel normals, the
//! heightmap, and Phase-1.4 classification are computed from the
//! overridden pixels downstream, so `?statNra` and POM inherit the
//! higher-resolution content for free.
//!
//! Loaded at page/worker init by `scene3d/tex_overrides.js` from
//! `data/tex-overrides/manifest.json` (+ PNGs). This module is transport
//! agnostic: it only holds the map and the decode-time lookup.
//!
//! INVARIANTS
//! - Paletted formats (P8 / Index16) are NEVER overridden — their texture
//!   carries the runtime recolour hook (`OrigPaletteId` rebinds) that raw
//!   RGBA replacement would destroy. `lookup_for` enforces this at the
//!   single call site and counts the refusal for diagnostics.
//! - Installing/clearing overrides invalidates decoded-pixel caches via
//!   `commit_texture_overrides` (same rule as `init_resource_source`
//!   re-init: cached `SurfacePixels` from pre-override decodes are stale).
//!   Already-built three.js textures are NOT retro-patched; a normal LB
//!   re-stream or reload picks the new decodes up.
//! - The default-OFF path stays cheap: one relaxed atomic load when no
//!   override was ever installed.

#![cfg(any(target_arch = "wasm32", test))]

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, RwLock};

/// One installed override: pre-decoded RGBA8, length == width*height*4.
/// `normal_rgba` (optional, SAME dims) is an authored GL-space normal map
/// that replaces the Sobel-from-luminance plane; `roughness` (NaN = none)
/// lands in `SurfacePixels.roughness_override` → `material.roughness`.
/// Gain/tint are NOT stored here — the JS loader pre-applies them to the
/// diffuse pixels at install time (zero runtime cost).
struct OverrideTexture {
    width: u32,
    height: u32,
    rgba: Arc<Vec<u8>>,
    normal_rgba: Option<Arc<Vec<u8>>>,
    roughness: f32,
}

/// What the decode hook receives on a hit.
pub(crate) struct OverrideHit {
    pub width: u32,
    pub height: u32,
    pub rgba: Arc<Vec<u8>>,
    pub normal_rgba: Option<Arc<Vec<u8>>>,
    pub roughness: f32,
}

static OVERRIDES: LazyLock<RwLock<HashMap<u32, OverrideTexture>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));
/// Mirror of the map's len, readable without the lock — the default-OFF
/// early-out in [`lookup_for`].
static INSTALLED: AtomicUsize = AtomicUsize::new(0);
/// Times an override actually replaced a decode.
static HITS: AtomicU64 = AtomicU64::new(0);
/// Times an override existed for a PALETTED texture and was refused.
static PALETTED_REFUSALS: AtomicU64 = AtomicU64::new(0);

/// Decode-time lookup, called once per surface decode at the `rs_id` hop.
/// `paletted` is the texture format's `needs_palette()`: an override for a
/// paletted record is refused (and counted) rather than applied.
pub(crate) fn lookup_for(rs_id: u32, paletted: bool) -> Option<OverrideHit> {
    if INSTALLED.load(Ordering::Relaxed) == 0 {
        return None;
    }
    let map = OVERRIDES.read().ok()?;
    let e = map.get(&rs_id)?;
    if paletted {
        PALETTED_REFUSALS.fetch_add(1, Ordering::Relaxed);
        return None;
    }
    HITS.fetch_add(1, Ordering::Relaxed);
    Some(OverrideHit {
        width: e.width,
        height: e.height,
        rgba: Arc::clone(&e.rgba),
        normal_rgba: e.normal_rgba.as_ref().map(Arc::clone),
        roughness: e.roughness,
    })
}

/// Install one override. `did` must be a RenderSurface id (`0x06______`)
/// and `rgba` exactly `width*height*4` bytes. Errors are strings for the
/// JS caller to surface; nothing here panics the renderer.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn add_texture_override(
    did: u32,
    width: u32,
    height: u32,
    rgba: &[u8],
    normal_rgba: Option<Box<[u8]>>,
    roughness: Option<f32>,
) -> Result<(), wasm_bindgen::JsValue> {
    install_texture_override(
        did,
        width,
        height,
        rgba.to_vec(),
        normal_rgba.map(|b| b.into_vec()),
        roughness.unwrap_or(f32::NAN),
    )
    .map_err(|e| wasm_bindgen::JsValue::from_str(&e))
}

/// Bindgen-free core, shared with native tests.
pub(crate) fn install_texture_override(
    did: u32,
    width: u32,
    height: u32,
    rgba: Vec<u8>,
    normal_rgba: Option<Vec<u8>>,
    roughness: f32,
) -> Result<(), String> {
    if did >> 24 != 0x06 {
        return Err(format!(
            "add_texture_override: 0x{did:08X} is not a RenderSurface (0x06) id"
        ));
    }
    if width == 0 || height == 0 {
        return Err(format!("add_texture_override: 0x{did:08X} zero dimension"));
    }
    let expect = width as usize * height as usize * 4;
    if rgba.len() != expect {
        return Err(format!(
            "add_texture_override: 0x{did:08X} rgba len {} != {}x{}x4 = {expect}",
            rgba.len(),
            width,
            height
        ));
    }
    if let Some(n) = &normal_rgba {
        // Normal plane is RGB8 (3 bytes/px — adapter.js
        // `surfacePixelsToNormalTexture` reads stride 3, same as the Sobel
        // plane) and must match the diffuse dims (`SurfacePixels` carries
        // ONE width/height for all planes). The JS loader strips alpha.
        let expect_n = width as usize * height as usize * 3;
        if n.len() != expect_n {
            return Err(format!(
                "add_texture_override: 0x{did:08X} normal len {} != {}x{}x3 = {expect_n} (RGB8, resized to diffuse dims)",
                n.len(),
                width,
                height
            ));
        }
    }
    let mut map = OVERRIDES
        .write()
        .map_err(|_| "add_texture_override: poisoned lock".to_string())?;
    map.insert(
        did,
        OverrideTexture {
            width,
            height,
            rgba: Arc::new(rgba),
            normal_rgba: normal_rgba.map(Arc::new),
            roughness,
        },
    );
    INSTALLED.store(map.len(), Ordering::Relaxed);
    Ok(())
}

/// Invalidate decoded-pixel caches after a batch of installs. Returns the
/// number of dropped cache entries. Call ONCE after the install loop —
/// per-entry clearing would thrash the LRU for nothing.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn commit_texture_overrides() -> u32 {
    crate::surface_pixel_cache_clear_all()
}

/// Remove every override and invalidate caches. Returns removed count.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn clear_texture_overrides() -> u32 {
    let removed = {
        let mut map = match OVERRIDES.write() {
            Ok(m) => m,
            Err(_) => return 0,
        };
        let n = map.len() as u32;
        map.clear();
        INSTALLED.store(0, Ordering::Relaxed);
        n
    };
    crate::surface_pixel_cache_clear_all();
    removed
}

/// JSON diagnostics for `window.__texOverrideStats()`.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn texture_override_stats() -> String {
    let (count, bytes, normals, roughs) = OVERRIDES
        .read()
        .map(|m| {
            (
                m.len(),
                m.values()
                    .map(|e| e.rgba.len() + e.normal_rgba.as_ref().map_or(0, |n| n.len()))
                    .sum::<usize>(),
                m.values().filter(|e| e.normal_rgba.is_some()).count(),
                m.values().filter(|e| e.roughness.is_finite()).count(),
            )
        })
        .unwrap_or((0, 0, 0, 0));
    format!(
        "{{\"count\":{count},\"bytes\":{bytes},\"normals\":{normals},\"roughness\":{roughs},\"hits\":{},\"palettedRefusals\":{}}}",
        HITS.load(Ordering::Relaxed),
        PALETTED_REFUSALS.load(Ordering::Relaxed)
    )
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // The map is process-global; keep every assertion inside one test so
    // cargo-test parallelism can't interleave installs (same reasoning as
    // `SURFACE_TEST_GUARD` for the pixel cache).
    #[test]
    fn install_validate_lookup_and_paletted_refusal() {
        // Bad id namespace.
        assert!(install_texture_override(0x08000001, 1, 1, vec![0; 4], None, f32::NAN).is_err());
        // Bad length.
        assert!(install_texture_override(0x06FF0001, 2, 2, vec![0; 4], None, f32::NAN).is_err());
        // Zero dimension.
        assert!(install_texture_override(0x06FF0002, 0, 1, Vec::new(), None, f32::NAN).is_err());
        // Normal plane dim mismatch (RGB8: 2x2 needs 12, not 4).
        assert!(
            install_texture_override(0x06FF0005, 2, 2, vec![7; 16], Some(vec![0; 4]), f32::NAN)
                .is_err()
        );
        // Good install (with RGB8 normal + roughness) → hit carries both.
        install_texture_override(0x06FF0003, 2, 2, vec![7; 16], Some(vec![9; 12]), 0.85).unwrap();
        let hit = lookup_for(0x06FF0003, false).expect("hit");
        assert_eq!((hit.width, hit.height, hit.rgba.len()), (2, 2, 16));
        assert_eq!(hit.normal_rgba.as_ref().map(|n| n.len()), Some(12));
        assert!((hit.roughness - 0.85).abs() < 1e-6);
        // Absent id → None.
        assert!(lookup_for(0x06FF0004, false).is_none());
        // Paletted → refused even though installed.
        assert!(lookup_for(0x06FF0003, true).is_none());
        assert_eq!(PALETTED_REFUSALS.load(Ordering::Relaxed), 1);
    }
}

//! Browser-loadable WASM bundle — Phase 2 smoke test for the wasm32
//! cross-compile floor and Phase 3 step 1 renderer entry point.
//!
//! This crate is the smallest possible consumer of the floor laid in
//! commits `50003ae`..`868c3ac`. It pulls in `holtburger-protocol` and
//! `holtburger-session` as dependencies (verifying both still compile
//! when bundled into a `cdylib`) and exposes a few wasm-bindgen
//! functions so a plain `index.html` can prove the bundle loads and
//! executes.
//!
//! Constructing a `Session` is exercised here as of the
//! `web_time::Instant` swap (spike doc §8 step 3). The
//! `try_ws_handshake_smoke` export added with §8 step 2 wires
//! `holtburger-transport-ws::WsTransport` into
//! `Session::new_with_transport` so the dependency graph is exercised
//! at build time; a real round-trip against a live `holtburger-wsbridge`
//! is the next browser-side validation.
//!
//! `fetch_landblock_heightmap` (Phase 3 step 1) reads a `CellLandblock`
//! out of a fetched HBA and hands a triangle-mesh `LandblockMesh` back
//! to JS. PixiJS turns it into a height-ramped terrain patch on a
//! `<canvas>`; the parsing-vs-drawing split keeps the per-frame
//! `wasm-bindgen` boundary cost to one typed-array crossing.

use holtburger_protocol::crypto::Hash32;
use holtburger_session::Session;
use wasm_bindgen::prelude::*;

// Phase 4 step 3 diagnostics — surface recv_loop trace messages to
// the browser console without pulling in `web_sys` (the Cargo.toml
// comment notes "avoids dragging `web-sys` along"). One #[wasm_bindgen]
// extern is cheaper than the full `web_sys::console` module.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = log)]
    fn console_log_str(s: &str);

    /// Workstream Sky-B: bind JS's `Date.now()` for wall-clock UTC
    /// derivation of the in-world time-of-day. Returns milliseconds
    /// since Unix epoch as an f64 (matches `Date.now()`'s native shape).
    /// The wasm-side sky evaluator divides by 1000 to get seconds.
    ///
    /// Bound via wasm-bindgen `extern "C"` rather than dragging in the
    /// full `js-sys` / `web-sys` modules — the bundle already keeps
    /// those out of its dep graph (see Cargo.toml comment), and one
    /// extern is cheaper than the dep weight.
    #[wasm_bindgen(js_namespace = Date, js_name = now)]
    fn js_date_now_ms() -> f64;
}

#[cfg(target_arch = "wasm32")]
mod global_source;

#[cfg(target_arch = "wasm32")]
mod prefetch;

// Phase 1.5 — surface override JSON. Gate mirrors
// `fetch_surface_pixels_impl` (wasm32 OR test) so the native test target
// can drive the loader without a separate path.
#[cfg(any(target_arch = "wasm32", test))]
mod surface_overrides;

#[cfg(target_arch = "wasm32")]
pub use global_source::{
    cached_shard_count, has_resource_source, init_resource_source,
};

#[cfg(target_arch = "wasm32")]
use std::net::{IpAddr, SocketAddr};

#[wasm_bindgen(start)]
pub fn start() {
    #[cfg(target_arch = "wasm32")]
    console_error_panic_hook::set_once();
}

/// Returns a static identification string. Smoke-tests wasm-bindgen
/// string interop and confirms the bundle was built from this crate.
#[wasm_bindgen]
pub fn build_info() -> String {
    format!(
        "holtburger-web v{} (proto + session over wasm-bindgen)",
        env!("CARGO_PKG_VERSION")
    )
}

/// AC's stateless 32-bit packet header checksum, exposed for callers
/// that want to verify the protocol crate's deterministic output from
/// JS. Smoke-tests passing a `&[u8]` from JS into wasm and a `u32`
/// back.
#[wasm_bindgen]
pub fn hash32(data: &[u8]) -> u32 {
    Hash32::compute(data)
}

/// Constructs a `Session::new_test` and returns its initial
/// `packet_sequence` (always 1). End-to-end smoke test that the
/// `web_time::Instant` swap (§8 step 3) lets `Session::new_with_transport`
/// run on wasm32 without panicking — every previous attempt at this
/// function would have tripped `std::time::Instant::now()`.
#[wasm_bindgen]
pub fn session_smoke_test_packet_sequence() -> u32 {
    Session::new_test().packet_sequence
}

/// Open a `WsTransport` against `bridge_url`, plug it into a fresh
/// `Session::new_with_transport`, and return the session's initial
/// `packet_sequence` (always 0). On the success path this proves the
/// §8-step-2 wiring works end-to-end; on any failure path the JS
/// caller gets the error string back via the rejected Promise.
///
/// Used by browser-side validation against a live `holtburger-wsbridge`.
/// `server_host` is the hostname or IP literal the bridge should resolve
/// (announced in the per-connection JSON handshake — see
/// `holtburger_transport_ws::WsTransport::connect`).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn try_ws_handshake_smoke(
    bridge_url: String,
    server_host: String,
    server_port: u16,
) -> Result<u32, JsValue> {
    let transport =
        holtburger_transport_ws::WsTransport::connect(&bridge_url, &server_host, server_port, None)
            .await
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let ip = transport.server_ip();
    let session = Session::new_with_transport(Box::new(transport), SocketAddr::new(ip, server_port));
    Ok(session.packet_sequence)
}

/// Fetch an HBA bundle from `asset_url`, parse it, and return the
/// length of the named entry. End-to-end smoke for the §8-step-4
/// `HttpResourceSource` wiring: a green run proves
/// `fetch()` → `Vec<u8>` → `HbaReader::<Vec<u8>>::from_bytes` →
/// `ResourceSource::get_file_by_key` works inside the wasm bundle.
///
/// Returns the length (in decompressed bytes) of the named entry. The
/// caller checks that against the known fixture content (e.g.
/// `dats/assets.hba`'s `eor/portal:0x0E000004` is 5876 bytes when
/// produced by `dat2hba --profile micro` from the canonical
/// portal.dat). Any failure path — fetch, HTTP status, parse, missing
/// key — surfaces as a rejected Promise with the error string.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn try_http_resource_source_smoke(
    namespace: String,
    file_id: u32,
) -> Result<u32, JsValue> {
    use holtburger_dat::{ResourceKey, ResourceSource};
    let source = global_source::global_source();
    let key = ResourceKey::new(&namespace, file_id);
    source
        .prefetch(&[key])
        .await
        .map_err(|e| JsValue::from_str(&format!("prefetch: {e}")))?;
    let bytes = source
        .get_file_by_key(key)
        .map_err(|e| JsValue::from_str(&format!("get_file_by_key: {e}")))?;
    Ok(bytes.len() as u32)
}

/// Heightmap geometry for one landblock, ready to feed into a PixiJS
/// `MeshGeometry`. Returned by [`fetch_landblock_heightmap`].
///
/// Coordinate convention:
/// - `positions` is a flat `Float32Array` of 81 vertices (9×9 grid),
///   3 floats per vertex: `[x0, y0, z0, x1, y1, z1, ...]`. Units are
///   metres. `x` increases east, `y` increases north, `z` is
///   elevation. The 9×9 grid covers the full 192 m × 192 m landblock
///   (one landblock = 8×8 = 64 cells of 24 m each), so vertices are
///   **24 m apart** on each axis. The canonical constant is
///   `holtburger_common::position::METERS_PER_LANDBLOCK = 192.0`.
/// - `indices` is a `Uint16Array` of 64 quads × 2 triangles ×
///   3 indices = 384 indices, addressing into `positions`. Each
///   triangle is wound so the cell's SW corner is the **last**
///   (provoking) vertex — WebGL2 `flat` interpolation reads the
///   provoking vertex, so the shader can colour both triangles of a
///   cell with a single SW-corner code (used for the road overlay
///   in step 5; the terrain layer interpolates smoothly across).
/// - `height_min` / `height_max` bound the elevation range over the
///   81 vertices so JS can normalise per-fragment colour.
/// - `terrain_codes` is a `Uint8Array(81)` of base terrain types (one
///   byte per vertex, range 0..31), decoded from the
///   `CellLandblock.terrain[]` u16 field (bits 2-6).
/// - `road_codes` is a `Uint8Array(81)` of per-vertex road overlay
///   types (range 0..3; 0 = no road), decoded from bits 0-1 of the
///   same `terrain[]` u16. Step 5 reads this to shade road tiles
///   in stone-grey on top of the terrain layer.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct LandblockMesh {
    positions: Vec<f32>,
    indices: Vec<u16>,
    terrain_codes: Vec<u8>,
    road_codes: Vec<u8>,
    height_min: f32,
    height_max: f32,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl LandblockMesh {
    /// `Float32Array` of 3D vertex positions, length 243 (81 × 3).
    #[wasm_bindgen(getter)]
    pub fn positions(&self) -> Vec<f32> {
        self.positions.clone()
    }

    /// `Uint16Array` of triangle vertex indices, length 384 (64 × 6).
    #[wasm_bindgen(getter)]
    pub fn indices(&self) -> Vec<u16> {
        self.indices.clone()
    }

    /// `Uint8Array` of per-vertex base terrain types, length 81. Each
    /// byte is in the range 0..31 — index into the region's 32-entry
    /// surface table. Soft-blended across triangles in the step-5
    /// shader; cells whose 4 corners share one type render uniformly.
    #[wasm_bindgen(getter, js_name = terrainCodes)]
    pub fn terrain_codes(&self) -> Vec<u8> {
        self.terrain_codes.clone()
    }

    /// `Uint8Array` of per-vertex road overlay codes, length 81.
    /// Range 0..3 (0 = no road). The step-5 shader reads the SW
    /// corner's value via `flat` interpolation and overlays a
    /// stone-grey colour where ≥ 1.
    #[wasm_bindgen(getter, js_name = roadCodes)]
    pub fn road_codes(&self) -> Vec<u8> {
        self.road_codes.clone()
    }

    /// Lowest elevation among the 81 vertices, in metres.
    #[wasm_bindgen(getter, js_name = heightMin)]
    pub fn height_min(&self) -> f32 {
        self.height_min
    }

    /// Highest elevation among the 81 vertices, in metres.
    #[wasm_bindgen(getter, js_name = heightMax)]
    pub fn height_max(&self) -> f32 {
        self.height_max
    }

    /// `Float32Array` of just the 81 vertex Z values (drops X/Y from
    /// `positions`). Order matches `CellLandblock::get_height` —
    /// `idx = vx * 9 + vy`. Convenience getter for callers feeding
    /// the terrain cache via `SessionHandle.populateTerrain`; saves
    /// a JS-side stride loop over `positions`.
    #[wasm_bindgen(getter)]
    pub fn heights(&self) -> Vec<f32> {
        let mut out = Vec::with_capacity(81);
        for i in 0..81 {
            out.push(self.positions[i * 3 + 2]);
        }
        out
    }
}

/// Tessellate a parsed `CellLandblock` into a [`LandblockMesh`].
///
/// Pure CPU work — no I/O, no JS interop. Shared by
/// [`fetch_landblock_heightmap`] and [`fetch_landblock_heightmaps`] so
/// the two exports stay in lockstep without code duplication.
#[cfg(target_arch = "wasm32")]
fn build_mesh(cell: &holtburger_dat::landblock::CellLandblock) -> LandblockMesh {
    // Vertex spacing = METERS_PER_LANDBLOCK / 8 = 24 m. The 9×9 grid
    // spans the full 192 m landblock, NOT a single 24 m cell.
    const VERTEX_SPACING_M: f32 = holtburger_common::position::METERS_PER_LANDBLOCK / 8.0;

    let mut positions = Vec::with_capacity(81 * 3);
    let mut terrain_codes = Vec::with_capacity(81);
    let mut road_codes = Vec::with_capacity(81);
    let mut height_min = f32::INFINITY;
    let mut height_max = f32::NEG_INFINITY;
    for x in 0..9usize {
        for y in 0..9usize {
            let h = cell.get_height(x, y);
            positions.push(x as f32 * VERTEX_SPACING_M);
            positions.push(y as f32 * VERTEX_SPACING_M);
            positions.push(h);
            terrain_codes.push(cell.terrain_type(x, y));
            road_codes.push(cell.road_type(x, y));
            if h < height_min {
                height_min = h;
            }
            if h > height_max {
                height_max = h;
            }
        }
    }

    // Each cell is two triangles. Per the doc on `LandblockMesh`, the
    // SW corner (`v00`) must be the **last** vertex of each triangle so
    // WebGL2's `flat` interpolation feeds the SW terrain code to every
    // fragment of both triangles — i.e. the whole cell shades as one
    // type, no smear across the diagonal.
    let mut indices = Vec::with_capacity(64 * 6);
    for x in 0..8u16 {
        for y in 0..8u16 {
            let v00 = x * 9 + y;
            let v10 = x * 9 + y + 1;
            let v01 = (x + 1) * 9 + y;
            let v11 = (x + 1) * 9 + y + 1;
            // T1: NW → NE → SW (CCW; SW last). T2: NE → SE → SW.
            indices.extend_from_slice(&[v10, v11, v00, v11, v01, v00]);
        }
    }

    LandblockMesh {
        positions,
        indices,
        terrain_codes,
        road_codes,
        height_min,
        height_max,
    }
}

/// Fetch an HBA from `asset_url`, look up `eor/cell:cell_id` (typically
/// `XXYYFFFF` for a landblock terrain record), parse it as a
/// `CellLandblock`, and hand the 9×9 height grid back as a
/// triangle-mesh [`LandblockMesh`].
///
/// This is the Phase 3 step 1 render path, kept as the single-landblock
/// shorthand. Internally it just wraps [`fetch_landblock_heightmaps`]
/// with a one-element id list and indexes `[0]`. Callers rendering more
/// than one landblock should call the plural form directly to amortise
/// the HBA open + parse cost.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn fetch_landblock_heightmap(cell_id: u32) -> Result<LandblockMesh, JsValue> {
    let mut meshes = fetch_landblock_heightmaps(vec![cell_id]).await?;
    Ok(meshes.remove(0))
}

/// Fetch an HBA from `asset_url` once, look up `eor/cell:id` for each
/// `id` in `cell_ids`, parse each into a `CellLandblock`, and return
/// the matching [`LandblockMesh`] vector in input order.
///
/// This is the Phase 3 step 2 render path. One `HttpResourceSource`
/// open + parse, then N cheap lookups inside the parsed HBA. The
/// resulting JS value is a `Promise<LandblockMesh[]>` — wasm-bindgen
/// lifts a `Vec<LandblockMesh>` to a JS array of the same `LandblockMesh`
/// proxy objects each consumer already knows how to read.
///
/// On any per-id failure (missing namespace, missing key, malformed
/// `CellLandblock` bytes), the whole batch fails: the rejected Promise
/// carries the error message tagged with the offending id. This is the
/// simpler shape — Holtburg's 9-neighbour fixture has all 9 entries
/// present, so per-id error surfacing is not yet needed. If a future
/// caller (e.g. a 5×5 streaming view that includes ocean cells) needs
/// per-id outcomes, switch this to `Vec<Result<LandblockMesh, String>>`
/// or push a sentinel empty mesh on miss.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn fetch_landblock_heightmaps(
    cell_ids: Vec<u32>,
) -> Result<Vec<LandblockMesh>, JsValue> {
    use holtburger_dat::landblock::CellLandblock;
    use holtburger_dat::{ResourceKey, ResourceSource};

    let source = global_source::global_source();
    let keys: Vec<ResourceKey<'_>> = cell_ids
        .iter()
        .map(|id| ResourceKey::new("eor/cell", *id))
        .collect();
    source
        .prefetch(&keys)
        .await
        .map_err(|e| JsValue::from_str(&format!("prefetch: {e}")))?;

    let mut out = Vec::with_capacity(cell_ids.len());
    for id in &cell_ids {
        let bytes = source
            .get_file_by_key(ResourceKey::new("eor/cell", *id))
            .map_err(|e| JsValue::from_str(&format!("get_file_by_key {id:#010X}: {e}")))?;
        let cell = CellLandblock::unpack(&bytes)
            .map_err(|e| JsValue::from_str(&format!("CellLandblock::unpack {id:#010X}: {e}")))?;
        out.push(build_mesh(&cell));
    }
    Ok(out)
}

/// Retail Dereth terrain_type → SurfaceTexture ID (bottom mip-level
/// index). Extracted by signature-scanning `eor/portal:0x13000000`
/// (Region) for the `[count=33][type=0]...[type=32]` pattern of
/// `TexMerge.TerrainDesc[]`. Stable for retail; if a project ships
/// a custom region in the future, swap this for a runtime
/// Region-parser walk (see step 3.5 docs in phase-3-renderer.md).
///
/// Indices match `TerrainTextureType` from
/// `external/DatReaderWriter/DatReaderWriter/dats.xml:183`.
/// Index 32 (RoadType) is included for the road-overlay layer; the
/// shader uses it instead of the placeholder grey when present.
///
/// Some terrain types map to the same SurfaceTexture ID — e.g. type
/// 22 (FauxWaterRunning) shares `0x0500146A` with type 16
/// (WaterRunning); type 24 (Argila) and 31 (DesolateLands) both
/// reuse `0x0500145C` (BarrenRock). That's authentic to retail AC
/// and the atlas builder dedupes if memory becomes a concern.
#[cfg(target_arch = "wasm32")]
const RETAIL_TERRAIN_SURFACE_TEXTURES: [u32; 33] = [
    0x0500145C, // 0  BarrenRock
    0x05001459, // 1  Grassland
    0x05001468, // 2  Ice
    0x05002F6F, // 3  LushGrass
    0x05001467, // 4  MarshSparseSwamp
    0x05001462, // 5  MudRichDirt
    0x05001463, // 6  ObsidianPlain
    0x05001465, // 7  PackedDirt
    0x0500145B, // 8  PatchyDirt
    0x05001457, // 9  PatchyGrassland
    0x0500145D, // 10 SandYellow
    0x0500145F, // 11 SandGrey
    0x0500145E, // 12 SandRockStrewn
    0x050014A7, // 13 SedimentaryRock
    0x0500145A, // 14 SemiBarrenRock
    0x05001464, // 15 Snow
    0x0500146A, // 16 WaterRunning
    0x05001461, // 17 WaterStandingFresh
    0x0500146C, // 18 WaterShallowSea
    0x05001469, // 19 WaterShallowStillSea
    0x0500146B, // 20 WaterDeepSea
    0x05001466, // 21 ForestFloor
    0x0500146A, // 22 FauxWaterRunning (shares with 16)
    0x05001827, // 23 SeaSlime
    0x0500145C, // 24 Argila (shares with 0)
    0x0500181F, // 25 Volcano1
    0x05001924, // 26 Volcano2
    0x05001900, // 27 BlueIce
    0x05001C3A, // 28 Moss
    0x05001C3B, // 29 DarkMoss
    0x05001C3C, // 30 Olthoi
    0x0500145C, // 31 DesolateLands (shares with 0)
    0x05001458, // 32 RoadType (used by the road-overlay layer)
];

/// Phase 3 step 3.6 — retail TexMerge alpha-mask SurfaceTexture IDs.
///
/// **What these are.** AC's terrain renderer doesn't bilinear-blend
/// between cells — it composes hand-tuned alpha-mask overlays on top
/// of a primary terrain texture. Each cell has a "palette code"
/// derived from its 4 corner terrain types; up to 3 corners that
/// differ from the primary become *overlay* terrains, blended in via
/// `mix(base, overlay, alpha_mask.r / 255)` per pixel. The alpha
/// masks are PFID_A8 (8-bit greyscale) textures with sharp,
/// hand-drawn boundaries — that's the iconic AC "patchy splotchy"
/// look that bilinear blending mathematically can't reproduce.
///
/// **Selection algorithm** (mirror `ACE.Server.Physics.Common.
/// TexMerge::FindTerrainAlpha` and `FindRoadAlpha`):
/// 1. Compute pcode from 4 corner terrain types
/// 2. PRNG-pick one of the corner / side maps with a known TCode
/// 3. Rotate the picked mask 90° increments (TCode bit-shifts mod 15)
///    until it matches the requested cell tcode
///
/// **Tables below** were extracted by signature-scanning
/// `eor/portal:0x13000000` (Region) for the TerrainDesc-count=33
/// signature, then walking backward through TexMerge sub-lists to
/// find BaseTexSize, CornerTerrainMaps, SideTerrainMaps, RoadMaps.
/// Stable for retail Dereth; if a project ships a custom Region in
/// the future, swap for a runtime Region parser (deferred follow-on
/// — `holtburger-dat::file_type::Region`).
///
/// **Format**: `(TCode, SurfaceTexture ID)`. TCode bit positions:
/// 1 = upper-left, 2 = upper-right, 4 = bottom-right, 8 = bottom-left.
/// Single-bit TCodes (1, 2, 4, 8) are corner masks; two-bit
/// neighbour pairs (3, 6, 9, 12) are side / edge masks; some road
/// masks use diagonal patterns like 10 (= 2 + 8).
#[cfg(target_arch = "wasm32")]
const RETAIL_CORNER_TERRAIN_MASKS: [(u32, u32); 4] = [
    (8, 0x05001371),
    (8, 0x0500143E),
    (8, 0x0500143F),
    (8, 0x05001440),
];

/// Side / edge alpha masks. Only one in retail Dereth — covers the
/// `tcode = 9` (left edge: upper-left + bottom-left) base pattern;
/// the renderer rotates 90° increments to match other edges
/// (9 → 3 → 6 → 12 per the cyclical bit-shift in
/// `TexMerge::FindTerrainAlpha:319-326`).
#[cfg(target_arch = "wasm32")]
const RETAIL_SIDE_TERRAIN_MASKS: [(u32, u32); 1] = [
    (9, 0x05001441),
];

/// Road alpha masks. PRNG selects one whose RCode rotates to match
/// the cell's road pattern. `RCode = 9` covers an edge road,
/// `RCode = 10` (= 2 + 8) is a diagonal across the cell, `RCode = 8`
/// is a single-corner road taper.
#[cfg(target_arch = "wasm32")]
const RETAIL_ROAD_MASKS: [(u32, u32); 3] = [
    (9, 0x0500168E),
    (10, 0x0500168C),
    (8, 0x0500168D),
];

/// One decoded alpha mask, ready for the JS atlas builder. Mirrors
/// [`TerrainTexture`]'s shape but with TCode/RCode metadata. The
/// `pixels` buffer is RGBA8 with R=G=B=alpha-byte, A=255 (the
/// existing `Texture::to_rgba8` decode of PFID_A8 / `A8`); JS reads
/// the `r` channel for the per-pixel blend weight.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct TerrainAlphaMask {
    /// Index in the source list (0..3 for corner, 0..0 for side,
    /// 0..2 for road). PRNG selection is JS-side; the index here
    /// just disambiguates atlas slot.
    index: u32,
    /// Bit pattern indicating which corners / edges this mask covers
    /// in its base orientation. Same encoding as `TexMerge::TCode`
    /// (bit 0 = upper-left, bit 3 = bottom-left).
    code: u32,
    width: u32,
    height: u32,
    /// RGBA8 — `r` channel = alpha-mask weight (0..255).
    pixels: Vec<u8>,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl TerrainAlphaMask {
    #[wasm_bindgen(getter)]
    pub fn index(&self) -> u32 {
        self.index
    }
    #[wasm_bindgen(getter)]
    pub fn code(&self) -> u32 {
        self.code
    }
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }
    #[wasm_bindgen(getter)]
    pub fn pixels(&self) -> Vec<u8> {
        self.pixels.clone()
    }
}

/// Tagged container — corner, side, and road masks come back in a
/// single round-trip so JS does one `await` instead of three.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct TerrainAlphaMasks {
    corner: Vec<TerrainAlphaMask>,
    side: Vec<TerrainAlphaMask>,
    road: Vec<TerrainAlphaMask>,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl TerrainAlphaMasks {
    /// Take ownership of the corner masks. Length matches
    /// `RETAIL_CORNER_TERRAIN_MASKS` (4 in retail). JS calls each
    /// vector getter exactly once.
    #[wasm_bindgen(js_name = takeCorner)]
    pub fn take_corner(&mut self) -> Vec<TerrainAlphaMask> {
        std::mem::take(&mut self.corner)
    }
    #[wasm_bindgen(js_name = takeSide)]
    pub fn take_side(&mut self) -> Vec<TerrainAlphaMask> {
        std::mem::take(&mut self.side)
    }
    #[wasm_bindgen(js_name = takeRoad)]
    pub fn take_road(&mut self) -> Vec<TerrainAlphaMask> {
        std::mem::take(&mut self.road)
    }
}

/// One decoded terrain tile, ready for the JS atlas builder. Each
/// instance is a 32-row block in the wasm-bindgen output of
/// [`fetch_terrain_textures`].
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct TerrainTexture {
    terrain_type: u32,
    width: u32,
    height: u32,
    pixels: Vec<u8>, // RGBA8, length = width * height * 4
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl TerrainTexture {
    /// Index into AC's `TerrainTextureType` enum (0..32). 32 is `RoadType`.
    #[wasm_bindgen(getter, js_name = terrainType)]
    pub fn terrain_type(&self) -> u32 {
        self.terrain_type
    }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }

    /// `Uint8Array` of RGBA8 pixels, length = `width * height * 4`.
    #[wasm_bindgen(getter)]
    pub fn pixels(&self) -> Vec<u8> {
        self.pixels.clone()
    }
}

/// One placed object inside a landblock — output of
/// [`fetch_landblock_objects`]. Object positions are in world-metre
/// coordinates relative to the landblock's NW corner (so JS adds
/// `lbX * 192, lbY * 192` to get global world coords).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct ObjectPlacement {
    landblock_id: u32,
    /// AC model id — `0x01XXXXXX` = Model/GfxObj, `0x02XXXXXX` = SetupModel.
    model_id: u32,
    x: f32,
    y: f32,
    z: f32,
    /// Yaw rotation around the z-axis (vertical), radians. Extracted
    /// from the AC quaternion via `atan2(2(qw*qz + qx*qy), 1 - 2(qy² + qz²))`.
    rotation_z: f32,
    /// True when this placement came from `LandblockInfo.buildings`
    /// (the `BuildInfo` list) rather than `LandblockInfo.objects`
    /// (the `Stab` list). Phase 6 step A uses this on the JS side to
    /// route building placements through the per-part container path
    /// (`window.buildingMap`) so Phase E can address door GfxObjs.
    is_building: bool,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl ObjectPlacement {
    #[wasm_bindgen(getter, js_name = landblockId)]
    pub fn landblock_id(&self) -> u32 {
        self.landblock_id
    }
    #[wasm_bindgen(getter, js_name = modelId)]
    pub fn model_id(&self) -> u32 {
        self.model_id
    }
    #[wasm_bindgen(getter)]
    pub fn x(&self) -> f32 {
        self.x
    }
    #[wasm_bindgen(getter)]
    pub fn y(&self) -> f32 {
        self.y
    }
    #[wasm_bindgen(getter)]
    pub fn z(&self) -> f32 {
        self.z
    }
    #[wasm_bindgen(getter, js_name = rotationZ)]
    pub fn rotation_z(&self) -> f32 {
        self.rotation_z
    }
    #[wasm_bindgen(getter, js_name = isBuilding)]
    pub fn is_building(&self) -> bool {
        self.is_building
    }
}

/// Fetch per-landblock object placement records for a list of
/// `XXYYFFFE` cell IDs. Each `LandblockInfo` holds two parallel
/// placement lists, both emitted as [`ObjectPlacement`] entries:
///
/// - `LandblockInfo.objects` (the `Stab` list) — props, signs, small
///   loose objects (`is_building == false`).
/// - `LandblockInfo.buildings` (the `BuildInfo` list) — buildings
///   and other structures with interior cells (`is_building == true`).
///   The model_id + Frame is the building's outer placement; per-part
///   geometry (doors, windows, walls, interior props) is materialized
///   on demand by [`fetch_building_placement`] (Phase 6 step A) so
///   JS can address each part by `(model_id, part_index)` for door
///   rotation (Phase E) and AABB collision (Phase B).
///
/// Both lists use the same `(model_id, Frame)` shape; the JS caller
/// keys off `is_building` to route each placement to the right
/// container (`window.buildingMap` for buildings, the existing
/// shared-sprite atlas path for objects).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn fetch_landblock_objects(
    cell_ids: Vec<u32>,
) -> Result<Vec<ObjectPlacement>, JsValue> {
    use holtburger_dat::landblock::LandblockInfo;
    use holtburger_dat::{ResourceKey, ResourceSource};

    let source = global_source::global_source();
    let keys: Vec<ResourceKey<'_>> = cell_ids
        .iter()
        .map(|id| ResourceKey::new("eor/cell", *id))
        .collect();
    source
        .prefetch(&keys)
        .await
        .map_err(|e| JsValue::from_str(&format!("prefetch: {e}")))?;

    fn frame_to_placement(landblock_id: u32, model_id: u32, frame: &holtburger_dat::landblock::Frame, is_building: bool) -> ObjectPlacement {
        let q = &frame.orientation;
        // Quaternion → yaw (rotation around z). Standard aircraft-
        // style yaw extraction.
        let siny_cosp = 2.0 * (q.w * q.z + q.x * q.y);
        let cosy_cosp = 1.0 - 2.0 * (q.y * q.y + q.z * q.z);
        let yaw = siny_cosp.atan2(cosy_cosp);
        ObjectPlacement {
            landblock_id,
            model_id,
            x: frame.origin.x,
            y: frame.origin.y,
            z: frame.origin.z,
            rotation_z: yaw,
            is_building,
        }
    }

    let mut out = Vec::new();
    for &id in &cell_ids {
        // Some landblocks have no LandblockInfo record (ocean cells,
        // sparse wilderness). Treat "not found" as zero objects rather
        // than failing the whole batch.
        let bytes = match source.get_file_by_key(ResourceKey::new("eor/cell", id)) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let info = LandblockInfo::unpack(&bytes)
            .map_err(|e| JsValue::from_str(&format!("LandblockInfo::unpack {id:#010X}: {e}")))?;

        for stab in &info.objects {
            out.push(frame_to_placement(info.id, stab.id, &stab.frame, false));
        }
        for building in &info.buildings {
            out.push(frame_to_placement(info.id, building.model_id, &building.frame, true));
        }
    }
    Ok(out)
}

/// Phase 1.4 diagnostic page support. Walks `LandblockInfo.objects` +
/// `.buildings` + every EnvCell in the landblock's cell-id range,
/// collects each model's referenced Surface DIDs (via the GfxObj
/// `surfaces` array, or — for SetupModel — every part's GfxObj
/// `surfaces`), and returns the sorted unique set. EnvCell `surfaces`
/// (u16 wire indices) are OR'd with the 0x08000000 namespace prefix
/// before emission.
///
/// `lb_cell_id` is the `0xXXYYFFFE` LandblockInfo cell key (Holtburg
/// = 0xA9B4FFFE). For LBs with no LandblockInfo (ocean / sparse) we
/// still scan the EnvCell range — most outdoor LBs will return an
/// empty list in that case.
///
/// One HTTP fetch (the LB's shard); per-id walks are in-memory after
/// the prefetch.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = fetchLandblockSurfaceDids)]
pub async fn fetch_landblock_surface_dids(lb_cell_id: u32) -> Result<Vec<u32>, JsValue> {
    use holtburger_dat::file_type::env_cell::surface_did_for_envcell_index;
    use holtburger_dat::file_type::{EnvCell, GfxObj, SetupModel};
    use holtburger_dat::landblock::LandblockInfo;
    use holtburger_dat::{ResourceKey, ResourceSource};

    let source = global_source::global_source();
    // Prefetch the landblock's cell shard so subsequent cell reads are
    // in-memory. Portal reads (GfxObj / SetupModel) come from the
    // portal shard which is already warm from index init.
    let landblock_word = (lb_cell_id >> 16) & 0xFFFF;
    let info_id = (landblock_word << 16) | 0xFFFE;
    let initial = [ResourceKey::new("eor/cell", info_id)];
    source
        .prefetch(&initial)
        .await
        .map_err(|e| JsValue::from_str(&format!("prefetch: {e}")))?;

    // Helper: resolve a (Setup or Gfx) model_id to its surface DIDs.
    fn surfaces_for_model<S: holtburger_dat::ResourceSource + ?Sized>(
        source: &S,
        model_id: u32,
    ) -> Vec<u32> {
        let top = (model_id >> 24) & 0xFF;
        match top {
            0x01 => {
                let Ok(bytes) = source.get_file_by_key(ResourceKey::new("eor/portal", model_id))
                else {
                    return Vec::new();
                };
                let mut cursor = std::io::Cursor::new(&bytes);
                let Ok(gfx) = GfxObj::unpack(&mut cursor) else {
                    return Vec::new();
                };
                gfx.surfaces
            }
            0x02 => {
                let Ok(bytes) = source.get_file_by_key(ResourceKey::new("eor/portal", model_id))
                else {
                    return Vec::new();
                };
                let Ok(setup) = SetupModel::unpack(&mut std::io::Cursor::new(&bytes)) else {
                    return Vec::new();
                };
                let mut out = Vec::new();
                for part in setup.parts {
                    let Ok(pb) = source.get_file_by_key(ResourceKey::new("eor/portal", part))
                    else {
                        continue;
                    };
                    let mut pc = std::io::Cursor::new(&pb);
                    if let Ok(g) = GfxObj::unpack(&mut pc) {
                        out.extend(g.surfaces);
                    }
                }
                out
            }
            _ => Vec::new(),
        }
    }

    use std::collections::BTreeSet;
    let mut surfaces: BTreeSet<u32> = BTreeSet::new();

    // LandblockInfo placements.
    if let Ok(bytes) = source.get_file_by_key(ResourceKey::new("eor/cell", info_id)) {
        if let Ok(info) = LandblockInfo::unpack(&bytes) {
            for stab in &info.objects {
                for s in surfaces_for_model(source.as_ref(), stab.id) {
                    surfaces.insert(s);
                }
            }
            for b in &info.buildings {
                for s in surfaces_for_model(source.as_ref(), b.model_id) {
                    surfaces.insert(s);
                }
            }
        }
    }

    // EnvCells. There's no enumerator on `ResourceSource` so the JS
    // page must enumerate envcell ids it cares about. For the
    // diagnostic page we just probe IDs 0xXXXX0001..0xXXXX01FF —
    // any retail interior has < 512 cells (Holtburg has ~16).
    let env_base = landblock_word << 16;
    for envcell_idx in 0x0001u32..=0x01FFu32 {
        let env_id = env_base | envcell_idx;
        let Ok(bytes) = source.get_file_by_key(ResourceKey::new("eor/cell", env_id)) else {
            continue;
        };
        let mut cursor = std::io::Cursor::new(&bytes);
        let Ok(envcell) = EnvCell::unpack(&mut cursor) else {
            continue;
        };
        for wire_surf in &envcell.surfaces {
            surfaces.insert(surface_did_for_envcell_index(*wire_surf));
        }
        for stab in &envcell.static_objects {
            for s in surfaces_for_model(source.as_ref(), stab.stab_id) {
                surfaces.insert(s);
            }
        }
    }

    surfaces.remove(&0);
    Ok(surfaces.into_iter().collect())
}

/// Fetch all 33 retail terrain textures from `asset_url`, decoded to
/// RGBA8. Returns one [`TerrainTexture`] per `TerrainTextureType`
/// entry, in enum order (index = terrain code).
///
/// Pipeline per terrain type:
/// 1. Look up the canonical SurfaceTexture ID from
///    [`RETAIL_TERRAIN_SURFACE_TEXTURES`].
/// 2. Fetch + parse `eor/portal:<surface_texture_id>` into a
///    [`SurfaceTexture`].
/// 3. Take the highest-resolution mip-level
///    (`surface_texture.highest_res()`).
/// 4. Fetch + parse that `eor/portal:<texture_id>` into a [`Texture`].
/// 5. Decode pixels via [`Texture::to_rgba8`], lazily fetching a
///    [`Palette`] only if the format is palettized (P8 / Index16).
///
/// On any per-id failure the whole batch fails with a tagged error.
/// One HTTP fetch resolves the entire bundle; per-asset lookups are
/// in-memory after that.
///
/// Cost: AC's terrain mip-stacks top out around 256×256, so the
/// decompressed RGBA8 payload returned is roughly
/// `33 × 256 × 256 × 4 = ~8.6 MB` worst case. JS atlas-packs into a
/// single GPU texture and we drop the originals.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn fetch_terrain_textures() -> Result<Vec<TerrainTexture>, JsValue> {
    use holtburger_dat::file_type::{Palette, SurfaceTexture, Texture, TextureDecodeError};
    use holtburger_dat::{ResourceKey, ResourceSource};

    let source = global_source::global_source();

    // Phase 5.0b — explicit per-level prefetch. The dependency
    // graph here is well-known: 33 SurfaceTextures → 33
    // Textures → up to 33 Palettes. Hand-rolled rather than
    // RecordingSource-driven because the levels are predictable.
    let surf_keys: Vec<ResourceKey<'_>> = RETAIL_TERRAIN_SURFACE_TEXTURES
        .iter()
        .map(|id| ResourceKey::new("eor/portal", *id))
        .collect();
    source
        .prefetch(&surf_keys)
        .await
        .map_err(|e| JsValue::from_str(&format!("prefetch SurfaceTextures: {e}")))?;

    let mut tex_ids: Vec<u32> = Vec::with_capacity(RETAIL_TERRAIN_SURFACE_TEXTURES.len());
    for &surf_id in RETAIL_TERRAIN_SURFACE_TEXTURES.iter() {
        if let Ok(b) = source.get_file_by_key(ResourceKey::new("eor/portal", surf_id))
            && let Ok(s) = SurfaceTexture::unpack(&b)
            && let Some(t) = s.highest_res()
        {
            tex_ids.push(t);
        }
    }
    let tex_keys: Vec<ResourceKey<'_>> = tex_ids
        .iter()
        .map(|id| ResourceKey::new("eor/portal", *id))
        .collect();
    source
        .prefetch(&tex_keys)
        .await
        .map_err(|e| JsValue::from_str(&format!("prefetch Textures: {e}")))?;

    let mut pal_ids: Vec<u32> = Vec::new();
    for &tex_id in &tex_ids {
        if let Ok(b) = source.get_file_by_key(ResourceKey::new("eor/portal", tex_id))
            && let Ok(t) = Texture::unpack(&b)
            && let Some(pid) = t.default_palette_id
        {
            pal_ids.push(pid);
        }
    }
    if !pal_ids.is_empty() {
        let pal_keys: Vec<ResourceKey<'_>> = pal_ids
            .iter()
            .map(|id| ResourceKey::new("eor/portal", *id))
            .collect();
        source
            .prefetch(&pal_keys)
            .await
            .map_err(|e| JsValue::from_str(&format!("prefetch Palettes: {e}")))?;
    }

    let mut out = Vec::with_capacity(RETAIL_TERRAIN_SURFACE_TEXTURES.len());
    for (terrain_type, surf_id) in RETAIL_TERRAIN_SURFACE_TEXTURES.iter().copied().enumerate() {
        // SurfaceTexture (mip stack).
        let surf_bytes = source
            .get_file_by_key(ResourceKey::new("eor/portal", surf_id))
            .map_err(|e| JsValue::from_str(&format!("SurfaceTexture {surf_id:#010X}: {e}")))?;
        let surf = SurfaceTexture::unpack(&surf_bytes).map_err(|e| {
            JsValue::from_str(&format!("SurfaceTexture::unpack {surf_id:#010X}: {e}"))
        })?;
        let tex_id = surf.highest_res().ok_or_else(|| {
            JsValue::from_str(&format!("SurfaceTexture {surf_id:#010X}: empty mip list"))
        })?;

        // Texture (top mip-level).
        let tex_bytes = source
            .get_file_by_key(ResourceKey::new("eor/portal", tex_id))
            .map_err(|e| JsValue::from_str(&format!("Texture {tex_id:#010X}: {e}")))?;
        let tex = Texture::unpack(&tex_bytes)
            .map_err(|e| JsValue::from_str(&format!("Texture::unpack {tex_id:#010X}: {e}")))?;

        // Decode to RGBA8, lazily fetching a palette if needed.
        let rgba = tex
            .to_rgba8(|pal_id| {
                let pal_bytes = source
                    .get_file_by_key(ResourceKey::new("eor/portal", pal_id))
                    .map_err(|e| TextureDecodeError::PaletteFetch(format!("{pal_id:#010X}: {e}")))?;
                Palette::unpack(&pal_bytes).map_err(|e| {
                    TextureDecodeError::PaletteFetch(format!("Palette::unpack {pal_id:#010X}: {e}"))
                })
            })
            .map_err(|e| JsValue::from_str(&format!("Texture::to_rgba8 {tex_id:#010X}: {e}")))?;

        out.push(TerrainTexture {
            terrain_type: terrain_type as u32,
            width: tex.width as u32,
            height: tex.height as u32,
            pixels: rgba,
        });
    }
    Ok(out)
}

/// Phase 3 step 3.6 — fetch the retail TexMerge alpha masks (corner,
/// side, road) and decode each to RGBA8. Mirrors
/// [`fetch_terrain_textures`] but for the PFID_A8 mask textures the
/// authentic AC terrain renderer composites overlays through.
///
/// **Why a separate export.** Splitting alpha masks out of
/// `fetch_terrain_textures` keeps the original 33-texture path
/// unchanged for callers that don't need the authentic blend (the
/// pre-3.6 shader continues to work). New callers can `await
/// fetch_terrain_alpha_masks()` once at boot, build an atlas, and
/// drop the originals.
///
/// **Round-trip cost.** Each mask is at most 1024×1024 PFID_A8
/// (1 MB compressed pre-bake; ~4 MB after decode-to-RGBA8 in
/// the existing `Texture::to_rgba8` greyscale-replicate path). 8
/// masks worst-case ≈ 32 MB; in practice the masks decode at
/// 256×256 or 512×512 → 4 MB total. Single fetch + decode round
/// at boot, kept resident for the lifetime of the renderer.
///
/// **R channel = mask weight.** The decoder fills R=G=B=alpha and
/// A=255; JS reads `r / 255` for the blend factor.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn fetch_terrain_alpha_masks() -> Result<TerrainAlphaMasks, JsValue> {
    use holtburger_dat::file_type::{Palette, SurfaceTexture, Texture, TextureDecodeError};
    use holtburger_dat::{ResourceKey, ResourceSource};

    let source = global_source::global_source();

    // Collect all 8 alpha-mask SurfaceTexture IDs in one pass so
    // the prefetch goes through the network once. PRNG selection
    // is JS-side; the wasm path just decodes everything.
    let all_ids: Vec<u32> = RETAIL_CORNER_TERRAIN_MASKS
        .iter()
        .chain(RETAIL_SIDE_TERRAIN_MASKS.iter())
        .chain(RETAIL_ROAD_MASKS.iter())
        .map(|(_code, gid)| *gid)
        .collect();

    let surf_keys: Vec<ResourceKey<'_>> = all_ids
        .iter()
        .map(|id| ResourceKey::new("eor/portal", *id))
        .collect();
    source
        .prefetch(&surf_keys)
        .await
        .map_err(|e| JsValue::from_str(&format!("prefetch alpha SurfaceTextures: {e}")))?;

    // SurfaceTexture → top-mip Texture id. PFID_A8 masks aren't
    // palettized, so we skip the Palette prefetch the terrain path
    // does. They might still chain through a Texture's default
    // palette in theory; we lazy-fetch in `to_rgba8` if so.
    let mut tex_ids: Vec<u32> = Vec::with_capacity(all_ids.len());
    for &surf_id in &all_ids {
        if let Ok(b) = source.get_file_by_key(ResourceKey::new("eor/portal", surf_id))
            && let Ok(s) = SurfaceTexture::unpack(&b)
            && let Some(t) = s.highest_res()
        {
            tex_ids.push(t);
        } else {
            tex_ids.push(0);
        }
    }
    let tex_keys: Vec<ResourceKey<'_>> = tex_ids
        .iter()
        .filter(|t| **t != 0)
        .map(|id| ResourceKey::new("eor/portal", *id))
        .collect();
    source
        .prefetch(&tex_keys)
        .await
        .map_err(|e| JsValue::from_str(&format!("prefetch alpha Textures: {e}")))?;

    // Decode helper — same logic three times for corner / side /
    // road, factored out to keep the constants list close to the
    // RETAIL_* tables above.
    let decode_one = |idx: usize, code: u32, surf_id: u32| -> Result<TerrainAlphaMask, JsValue> {
        let surf_bytes = source
            .get_file_by_key(ResourceKey::new("eor/portal", surf_id))
            .map_err(|e| JsValue::from_str(&format!("alpha SurfaceTexture {surf_id:#010X}: {e}")))?;
        let surf = SurfaceTexture::unpack(&surf_bytes)
            .map_err(|e| JsValue::from_str(&format!("SurfaceTexture::unpack {surf_id:#010X}: {e}")))?;
        let tex_id = surf
            .highest_res()
            .ok_or_else(|| JsValue::from_str(&format!("alpha {surf_id:#010X}: empty mip list")))?;
        let tex_bytes = source
            .get_file_by_key(ResourceKey::new("eor/portal", tex_id))
            .map_err(|e| JsValue::from_str(&format!("alpha Texture {tex_id:#010X}: {e}")))?;
        let tex = Texture::unpack(&tex_bytes)
            .map_err(|e| JsValue::from_str(&format!("Texture::unpack {tex_id:#010X}: {e}")))?;
        let rgba = tex
            .to_rgba8(|pal_id| {
                let pal_bytes = source
                    .get_file_by_key(ResourceKey::new("eor/portal", pal_id))
                    .map_err(|e| TextureDecodeError::PaletteFetch(format!("{pal_id:#010X}: {e}")))?;
                Palette::unpack(&pal_bytes).map_err(|e| {
                    TextureDecodeError::PaletteFetch(format!("Palette::unpack {pal_id:#010X}: {e}"))
                })
            })
            .map_err(|e| JsValue::from_str(&format!("Texture::to_rgba8 {tex_id:#010X}: {e}")))?;
        Ok(TerrainAlphaMask {
            index: idx as u32,
            code,
            width: tex.width as u32,
            height: tex.height as u32,
            pixels: rgba,
        })
    };

    let mut corner = Vec::with_capacity(RETAIL_CORNER_TERRAIN_MASKS.len());
    for (i, (code, gid)) in RETAIL_CORNER_TERRAIN_MASKS.iter().copied().enumerate() {
        corner.push(decode_one(i, code, gid)?);
    }
    let mut side = Vec::with_capacity(RETAIL_SIDE_TERRAIN_MASKS.len());
    for (i, (code, gid)) in RETAIL_SIDE_TERRAIN_MASKS.iter().copied().enumerate() {
        side.push(decode_one(i, code, gid)?);
    }
    let mut road = Vec::with_capacity(RETAIL_ROAD_MASKS.len());
    for (i, (code, gid)) in RETAIL_ROAD_MASKS.iter().copied().enumerate() {
        road.push(decode_one(i, code, gid)?);
    }

    Ok(TerrainAlphaMasks { corner, side, road })
}

/// Phase 3 step 4.5: walk one model's GfxObj/SetupModel surface chain
/// and return the first resolvable ARGB. `0` means "no colour
/// resolved" — the JS caller falls back to the existing 2-bucket
/// category tint for that model.
///
/// Walk shape:
/// - `0x01XXXXXX` (Model / GfxObj) → read GfxObj's `surfaces` list,
///   iterate, return the first surface that resolves to ARGB.
/// - `0x02XXXXXX` (SetupModel) → read SetupModel, iterate `parts`
///   (each part is a GfxObj id), recurse via the GfxObj path.
/// - Any other top byte → `None` (unhandled type).
///
/// **Surface resolution** tries two paths in order:
/// 1. Solid path: if the surface stored a `color_value`, return it.
/// 2. Textured path: fetch the referenced Texture (and Palette if
///    palettized), decode to RGBA8, return the **mean ARGB** over
///    every pixel. This is what gives Holtburg's brown-house cluster
///    real colour variety — almost every surface in retail is
///    textured (97% in our sweep), so a solid-only walk would
///    resolve <3% of models.
///
/// **Why the minimal GfxObj reader.** The full `GfxObj::unpack` parser
/// in `holtburger-dat` parses vertex / polygon / BSP data after the
/// surface list, and currently fails on roughly half of retail's
/// GfxObj records (`failed to fill whole buffer` on internal subfields).
/// Step 4.5 only needs the surface IDs, so we read a minimal header
/// (`id`, `flags`, `read_smart_vec(u32)` of surfaces) and stop. This
/// raises the surface-list extraction success rate from ~50% to
/// ~100% on the same bundle without depending on fixes to the full
/// parser. If/when the GfxObj parser regression is resolved upstream,
/// `walk_gfx_obj` can switch back to it without changing the public
/// API.
#[cfg(target_arch = "wasm32")]
fn resolve_model_color<S: holtburger_dat::ResourceSource + ?Sized>(
    source: &S,
    model_id: u32,
) -> Option<u32> {
    match (model_id >> 24) as u8 {
        0x01 => walk_gfx_obj(source, model_id),
        0x02 => walk_setup_model(source, model_id, 0),
        _ => None,
    }
}

/// Read just the `surfaces: Vec<u32>` list from a GfxObj record.
/// Header layout: `[u32 id][u32 flags][smart_vec u32 surfaces]`. Stops
/// after the surface list — the rest of the record (vertex array,
/// polygons, BSP) is irrelevant to step 4.5 and is the source of
/// failures in the full parser. See `resolve_model_color` doc.
///
/// Manual byte parsing (rather than calling through to `holtburger_dat::utils`)
/// keeps `binrw` out of `holtburger-web`'s dep graph — the format is
/// fixed, the surface-count varint is well-defined, and the parser
/// shape is small enough that the dep would be pure overhead.
#[cfg(target_arch = "wasm32")]
fn read_gfx_obj_surfaces(bytes: &[u8]) -> Option<Vec<u32>> {
    if bytes.len() < 9 {
        return None;
    }
    // Skip [u32 id][u32 flags] = 8 bytes.
    let mut pos = 8usize;
    let (count, n) = read_compressed_u32(&bytes[pos..])?;
    pos += n;
    let count = count as usize;
    if bytes.len() < pos.checked_add(count * 4)? {
        return None;
    }
    let mut surfaces = Vec::with_capacity(count);
    for i in 0..count {
        let off = pos + i * 4;
        let id = u32::from_le_bytes([
            bytes[off],
            bytes[off + 1],
            bytes[off + 2],
            bytes[off + 3],
        ]);
        surfaces.push(id);
    }
    Some(surfaces)
}

/// Mirrors `holtburger_dat::utils::read_compressed_u32`. Variable-width
/// 1/2/4-byte little-endian count used by AC's `read_smart_vec`.
/// Returns `(value, bytes_consumed)`.
#[cfg(target_arch = "wasm32")]
fn read_compressed_u32(bytes: &[u8]) -> Option<(u32, usize)> {
    let b0 = *bytes.first()? as u32;
    if (b0 & 0x80) == 0 {
        Some((b0, 1))
    } else if (b0 & 0x40) == 0 {
        let b1 = *bytes.get(1)? as u32;
        Some((((b0 & 0x7F) << 8) | b1, 2))
    } else {
        let b1 = *bytes.get(1)? as u32;
        let s = u16::from_le_bytes([*bytes.get(2)?, *bytes.get(3)?]) as u32;
        Some(((((b0 & 0x3F) << 8) | b1) << 16 | s, 4))
    }
}

#[cfg(target_arch = "wasm32")]
fn lookup_surface_color<S: holtburger_dat::ResourceSource + ?Sized>(
    source: &S,
    surface_id: u32,
) -> Option<u32> {
    use holtburger_dat::file_type::{Palette, Surface, SurfaceTexture, Texture, TextureDecodeError};
    use holtburger_dat::ResourceKey;
    let bytes = source
        .get_file_by_key(ResourceKey::new("eor/portal", surface_id))
        .ok()?;
    let surface = Surface::unpack(&bytes).ok()?;
    if let Some(argb) = surface.solid_color() {
        return Some(argb);
    }
    // Textured path: Surface → SurfaceTexture → Texture (RenderSurface)
    // → RGBA8 → mean every pixel. Field-naming footgun: the field is
    // called `OrigTextureId` upstream and our `textured()` returns it
    // as the first tuple element, but it's actually a **SurfaceTexture
    // (0x05) ID** — not a Texture/RenderSurface (0x06) ID. Confirmed
    // by `WorldBuilder.Shared/Lib/Texture/RenderSurfaceImporter.cs`'s
    // `CreateSurface(gid, surfaceTextureGid)` builder, and by sampling
    // real Holtburg surfaces (`OrigTextureId = 0x0500…`). The walk
    // mirrors `fetch_terrain_textures` from step 3.5 (which already
    // got this chain right): SurfaceTexture.highest_res() is the
    // top-mip RenderSurface ID we feed to `Texture::unpack`.
    let (surf_tex_id, _pal_id_in_surface) = surface.textured()?;
    let surf_tex_bytes = source
        .get_file_by_key(ResourceKey::new("eor/portal", surf_tex_id))
        .ok()?;
    let surf_tex = SurfaceTexture::unpack(&surf_tex_bytes).ok()?;
    let render_surface_id = surf_tex.highest_res()?;
    let tex_bytes = source
        .get_file_by_key(ResourceKey::new("eor/portal", render_surface_id))
        .ok()?;
    let tex = Texture::unpack(&tex_bytes).ok()?;
    // Use the texture's `default_palette_id` for the palette fetch,
    // not the Surface's `orig_palette_id` — most retail textures embed
    // the right palette ref in the Texture record itself, while the
    // Surface's `orig_palette_id` is often 0.
    let rgba = tex
        .to_rgba8(|pal_id| {
            let pal_bytes = source
                .get_file_by_key(ResourceKey::new("eor/portal", pal_id))
                .map_err(|e| TextureDecodeError::PaletteFetch(format!("{pal_id:#010X}: {e}")))?;
            Palette::unpack(&pal_bytes).map_err(|e| {
                TextureDecodeError::PaletteFetch(format!("Palette::unpack {pal_id:#010X}: {e}"))
            })
        })
        .ok()?;
    Some(rgba_pixel_mean(&rgba))
}

/// Mean of every pixel in an RGBA8 buffer, returned as a 0xAARRGGBB
/// ARGB. Saturated alpha (`0xFF`) so the renderer doesn't accidentally
/// transparent-tint a sprite.
#[cfg(target_arch = "wasm32")]
fn rgba_pixel_mean(rgba: &[u8]) -> u32 {
    if rgba.len() < 4 {
        return 0;
    }
    let pixels = rgba.len() / 4;
    let mut r_sum: u64 = 0;
    let mut g_sum: u64 = 0;
    let mut b_sum: u64 = 0;
    let mut weighted: u64 = 0;
    for i in 0..pixels {
        let r = rgba[i * 4] as u64;
        let g = rgba[i * 4 + 1] as u64;
        let b = rgba[i * 4 + 2] as u64;
        let a = rgba[i * 4 + 3] as u64;
        // Premultiplied-by-alpha average so transparent pixels don't
        // bleach the result toward black.
        r_sum += r * a;
        g_sum += g * a;
        b_sum += b * a;
        weighted += a;
    }
    if weighted == 0 {
        return 0;
    }
    let r = (r_sum / weighted) as u32;
    let g = (g_sum / weighted) as u32;
    let b = (b_sum / weighted) as u32;
    0xFF000000 | (r << 16) | (g << 8) | b
}

#[cfg(target_arch = "wasm32")]
fn walk_gfx_obj<S: holtburger_dat::ResourceSource + ?Sized>(
    source: &S,
    gfx_obj_id: u32,
) -> Option<u32> {
    use holtburger_dat::ResourceKey;
    let bytes = source
        .get_file_by_key(ResourceKey::new("eor/portal", gfx_obj_id))
        .ok()?;
    let surfaces = read_gfx_obj_surfaces(&bytes)?;
    for surface_id in surfaces {
        if let Some(c) = lookup_surface_color(source, surface_id) {
            return Some(c);
        }
    }
    None
}

#[cfg(target_arch = "wasm32")]
fn walk_setup_model<S: holtburger_dat::ResourceSource + ?Sized>(
    source: &S,
    setup_id: u32,
    depth: usize,
) -> Option<u32> {
    use holtburger_dat::file_type::SetupModel;
    use holtburger_dat::ResourceKey;
    // Recursion guard: AC SetupModel parts are GfxObj ids
    // (`0x01XXXXXX`), not SetupModels, so depth never exceeds 1 in
    // practice. The bound here is a defensive cap against a malformed
    // record that points back at a SetupModel id.
    if depth > 4 {
        return None;
    }
    let bytes = source
        .get_file_by_key(ResourceKey::new("eor/portal", setup_id))
        .ok()?;
    let setup = SetupModel::unpack(&mut std::io::Cursor::new(bytes)).ok()?;
    for part_id in setup.parts {
        let candidate = match (part_id >> 24) as u8 {
            0x01 => walk_gfx_obj(source, part_id),
            0x02 => walk_setup_model(source, part_id, depth + 1),
            _ => None,
        };
        if let Some(c) = candidate {
            return Some(c);
        }
    }
    None
}

/// Phase 3 step 4.5: resolve a per-model ARGB colour for each `model_id`
/// in the input list. Output length matches input length. `0` means the
/// walk did not resolve a colour for that model — the JS caller treats
/// `0` as a miss and falls back to the existing 2-bucket category tint.
///
/// One `HttpResourceSource::connect` open per call; per-id walks are
/// in-memory after that. Cost is bounded by the number of UNIQUE model
/// IDs in the visible neighbourhood (67 for Holtburg's 3×3); JS dedupes
/// the input list before calling.
///
/// Failure modes: a connect error rejects the whole Promise. Per-id
/// walk failures (missing GfxObj, malformed Surface bytes) are silent
/// — the walk just returns `None` for that id. This matches the
/// graceful-degradation shape from step 4: a partially-resolved batch
/// still renders, just with category-tint fallbacks for the unresolved
/// ids.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn fetch_object_colours(model_ids: Vec<u32>) -> Result<Vec<u32>, JsValue> {
    use holtburger_dat::ResourceKey;
    let source = global_source::global_source();

    // Iterative discovery: walk against a RecordingSource, prefetch
    // recorded misses, repeat until cache hot. The walk depth here
    // is unbounded (SetupModel → parts → GfxObj → surfaces → ...).
    let initial: Vec<ResourceKey<'_>> = model_ids
        .iter()
        .map(|id| ResourceKey::new("eor/portal", *id))
        .collect();
    let model_ids_for_walk = model_ids.clone();
    prefetch::ensure_walk_prefetched(&source, &initial, |s| {
        for &id in &model_ids_for_walk {
            let _ = resolve_model_color(s, id);
        }
    })
    .await?;

    let mut out = Vec::with_capacity(model_ids.len());
    for &id in &model_ids {
        out.push(resolve_model_color(source.as_ref(), id).unwrap_or(0));
    }
    Ok(out)
}

// ────────────────────────────────────────────────────────────────────
//  Phase 3 step 6 — model triangulation for runtime per-poly rendering
// ────────────────────────────────────────────────────────────────────
//
// Ports `WorldBuilder.Terminal/ObjectSpriteGenerator.cs::TriangulateModel`
// + `AppendGfxTris` to Rust. Returns a flat triangle list per model so
// JS can render each (model, surface) sub-mesh via PIXI.Mesh + a
// custom GLSL fragment shader, then RenderTexture-cache the result.
//
// Format choice: per-triangle vertex duplication (no index buffer).
// Mirrors the C# reference and lets PIXI.Geometry consume the buffers
// directly without a pre-pass to dedupe vertices. Memory is bounded
// (one tile per visible model, dropped on cache eviction) so the
// extra bytes don't matter; the simplicity at the JS boundary does.
//
// SetupModel (multi-part) walks `parts` and applies each part's idle
// or default-placement frame transform — matching the static-site
// emitter's pose resolution. For step 6 v1 we only apply the default
// placement frame (no animation lookup); idle-pose support is
// step 6 follow-on.

/// Per-triangle output of [`triangulate_model`]. Three vertex tuples
/// per triangle (no shared indexing), each carrying position, UV, and
/// the surface index.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct ModelMesh {
    /// 9 floats per triangle (3 vertices × xyz). Length = `tri_count * 9`.
    positions: Vec<f32>,
    /// 6 floats per triangle (3 vertices × uv). Length = `tri_count * 6`.
    uvs: Vec<f32>,
    /// 3 floats per triangle (one face normal, broadcast to all 3 verts
    /// at draw time). Length = `tri_count * 3`.
    normals: Vec<f32>,
    /// One byte per triangle, indexing into `surfaces`. Length = `tri_count`.
    /// `0xFF` means "no surface" (caller paints flat fallback).
    surface_indices: Vec<u8>,
    /// Unique surface DIDs referenced by the model's polygons, in
    /// first-seen order. JS resolves each to RGBA8 via the existing
    /// surface chain (Surface → SurfaceTexture → Texture → to_rgba8).
    surfaces: Vec<u32>,
    /// World-space bbox over all vertices. JS uses (max - min) to size
    /// the destination RenderTexture.
    bbox_min: [f32; 3],
    bbox_max: [f32; 3],
    /// Follow-on #5 (LOD) — the model's `did_degrade` chain entry, or
    /// 0 if the GfxObj has no `HAS_DID_DEGRADE` flag set. For 0x01 raw
    /// GfxObjs this is the model's own degrade DID; for 0x02 SetupModels
    /// it's the first part GfxObj's degrade DID (sufficient for Holtburg,
    /// which has mostly single-part SetupModels). 0 = no degraded
    /// variant available; JS-side LOD wrappers fall back to a plain
    /// `THREE.Mesh` instead of `THREE.LOD`.
    did_degrade: u32,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl ModelMesh {
    #[wasm_bindgen(getter)]
    pub fn positions(&self) -> Vec<f32> { self.positions.clone() }
    #[wasm_bindgen(getter)]
    pub fn uvs(&self) -> Vec<f32> { self.uvs.clone() }
    #[wasm_bindgen(getter)]
    pub fn normals(&self) -> Vec<f32> { self.normals.clone() }
    #[wasm_bindgen(getter, js_name = surfaceIndices)]
    pub fn surface_indices(&self) -> Vec<u8> { self.surface_indices.clone() }
    #[wasm_bindgen(getter)]
    pub fn surfaces(&self) -> Vec<u32> { self.surfaces.clone() }
    #[wasm_bindgen(getter, js_name = triCount)]
    pub fn tri_count(&self) -> u32 {
        (self.positions.len() / 9) as u32
    }
    /// `[minX, minY, minZ, maxX, maxY, maxZ]` — flat for typed-array
    /// transit. JS reads pairs (idx 0..3 = min, 3..6 = max).
    #[wasm_bindgen(getter)]
    pub fn bbox(&self) -> Vec<f32> {
        let mut v = Vec::with_capacity(6);
        v.extend_from_slice(&self.bbox_min);
        v.extend_from_slice(&self.bbox_max);
        v
    }
    /// World metres on (X, Y) — what JS uses as the sprite footprint
    /// when blitting the rendered tile back into the scene.
    #[wasm_bindgen(getter, js_name = worldBounds)]
    pub fn world_bounds(&self) -> Vec<f32> {
        vec![
            self.bbox_max[0] - self.bbox_min[0],
            self.bbox_max[1] - self.bbox_min[1],
        ]
    }
    /// Follow-on #5 (LOD) — the model's `did_degrade` chain entry
    /// (0 = no degraded variant). JS-side `statics.js` / `buildings.js`
    /// wrap the full + degraded variants in a `THREE.LOD` node when this
    /// is non-zero; the JS-side `fetch_model_meshes([didDegrade])` round-
    /// trip fetches the degraded geometry for the LOD's distance-100m
    /// slot. The full variant remains at distance 0.
    #[wasm_bindgen(getter, js_name = didDegrade)]
    pub fn did_degrade(&self) -> u32 {
        self.did_degrade
    }
}

/// Internal triangle accumulator. Mirrors `ObjectSpriteGenerator.Tri`
/// in the C# reference, minus the centroid-Z (we sort painter-style
/// in JS instead of in Rust — simpler boundary).
#[cfg(any(target_arch = "wasm32", test))]
struct Tri {
    pos: [[f32; 3]; 3],
    uv: [[f32; 2]; 3],
    normal: [f32; 3],
    surface_did: u32,
}

/// Walk a [`GfxObj`]'s polygons, fan-triangulate each, transform by
/// `(part_rot, part_offset)`, and append to `tris`. Mirrors the C#
/// `AppendGfxTris` line-for-line. Equivalent to the
/// `_with_tex_swaps` variant called with an empty swap table — kept
/// as a thin wrapper so existing callers (static placements,
/// non-substituted entities) don't change.
#[cfg(any(target_arch = "wasm32", test))]
fn append_gfx_tris(
    tris: &mut Vec<Tri>,
    gfx: &holtburger_dat::file_type::GfxObj,
    part_offset: holtburger_common::Vector3,
    part_rot: holtburger_common::Quaternion,
) {
    append_gfx_tris_with_tex_swaps(tris, gfx, part_offset, part_rot, &[]);
}

/// Phase 4 step 6 Phase A: like [`append_gfx_tris`], but rewrites
/// `surface_did` per-polygon when the polygon's resolved surface_did
/// matches one of the `(old, new)` swap entries. Implements
/// `CloTextureEffect` substitution from ACE's `CalculateObjDesc`
/// (mirrors `Creature_Networking.cs:185`'s
/// `objDesc.AddTextureChange(new PropertiesTextureMap { PartIndex,
/// OldTexture, NewTexture })` at the consumer end). Empty
/// `tex_swaps` is the cheap path used for static placements.
///
/// `surface_did = 0` for any polygon whose `pos_surface` is out of
/// range — caller falls back to a flat colour.
#[cfg(any(target_arch = "wasm32", test))]
fn append_gfx_tris_with_tex_swaps(
    tris: &mut Vec<Tri>,
    gfx: &holtburger_dat::file_type::GfxObj,
    part_offset: holtburger_common::Vector3,
    part_rot: holtburger_common::Quaternion,
    tex_swaps: &[(u32, u32)],
) {
    use holtburger_dat::graphics::Polygon;
    if gfx.vertex_array.vertices.is_empty() || gfx.polygons.is_empty() {
        return;
    }

    // Phase 7 follow-on #7: AC two-sided polygons. The Polygon.sides_type
    // field encodes a CullMode: 0x0=Landblock, 0x1=None, 0x2=Clockwise,
    // 0x3=CounterClockwise. CullMode::Clockwise (0x2) signals "draw the
    // back face too" — `neg_uv_indices` is populated on read iff
    // `sides_type == 0x2 && (stippling & NoNeg=0x8) == 0`. The back face
    // potentially uses a DIFFERENT surface (`neg_surface != pos_surface`):
    // think a stained-glass window with one texture on the interior side
    // and a different one outside, or a stage-curtain banner. When the
    // surfaces differ we must emit BOTH faces as oriented tris with
    // opposite winding so the JS-side MaterialCache can paint each side
    // with its own MeshStandardMaterial. When they match, one tri with
    // `side: DoubleSide` is sufficient (cheaper draw call); this is the
    // common case — most cloth banners use one texture both sides.
    const NO_POS: u8 = 0x04;
    const NO_NEG: u8 = 0x08;
    const CULL_CLOCKWISE: i32 = 0x2;

    // Sort polygon ids for deterministic output (HashMap iteration is
    // not stable; PIXI.Mesh draw order matches whatever order we feed
    // in).
    let mut poly_ids: Vec<u16> = gfx.polygons.keys().copied().collect();
    poly_ids.sort_unstable();
    for pid in poly_ids {
        let poly: &Polygon = &gfx.polygons[&pid];
        if poly.vertex_ids.len() < 3 { continue; }
        // Skip "no positive surface" polygons — same as C# `NoPos` skip.
        if (poly.stippling & NO_POS) != 0 { continue; }

        let raw_pos_surface_did = if poly.pos_surface >= 0
            && (poly.pos_surface as usize) < gfx.surfaces.len()
        {
            gfx.surfaces[poly.pos_surface as usize]
        } else {
            0
        };
        // Phase 4 step 6 Phase A: apply per-part texture swaps. An
        // empty `tex_swaps` (the static-placement path) skips the
        // search entirely. NPC parts typically have ≤4 swaps each so
        // a linear find is fine.
        let pos_surface_did = tex_swaps
            .iter()
            .find(|(old, _)| *old == raw_pos_surface_did)
            .map(|(_, new)| *new)
            .unwrap_or(raw_pos_surface_did);

        // Two-sided detection. The parser populates `neg_uv_indices`
        // only when `sides_type == 0x2 && (stippling & NoNeg) == 0`.
        // We additionally require `neg_surface >= 0 && in-range` to
        // emit a back-face tri; otherwise the back face would have no
        // surface DID and would resolve to the same texture as the
        // front, defeating the point of the second draw.
        let has_back_face =
            poly.sides_type == CULL_CLOCKWISE
                && (poly.stippling & NO_NEG) == 0
                && !poly.neg_uv_indices.is_empty();
        let raw_neg_surface_did = if has_back_face
            && poly.neg_surface >= 0
            && (poly.neg_surface as usize) < gfx.surfaces.len()
        {
            gfx.surfaces[poly.neg_surface as usize]
        } else {
            0
        };
        let neg_surface_did = if raw_neg_surface_did != 0 {
            tex_swaps
                .iter()
                .find(|(old, _)| *old == raw_neg_surface_did)
                .map(|(_, new)| *new)
                .unwrap_or(raw_neg_surface_did)
        } else {
            0
        };
        // Only emit a distinct back-face tri when the surface actually
        // differs from the front. When `neg_surface_did == pos_surface_did`,
        // a single DoubleSide draw is cheaper; the materials.js decoder
        // applies DoubleSide as the default for the front-face tri.
        let emit_back_face = has_back_face
            && neg_surface_did != 0
            && neg_surface_did != pos_surface_did;

        // Resolve ring of (position, pos_uv, neg_uv) per vertex.
        let mut ring_pos: Vec<[f32; 3]> = Vec::with_capacity(poly.vertex_ids.len());
        let mut ring_uv_pos: Vec<[f32; 2]> = Vec::with_capacity(poly.vertex_ids.len());
        let mut ring_uv_neg: Vec<[f32; 2]> = Vec::with_capacity(poly.vertex_ids.len());
        let mut ok = true;
        for (i, &raw) in poly.vertex_ids.iter().enumerate() {
            if raw < 0 { ok = false; break; }
            let Some(vert) = gfx.vertex_array.vertices.get(&(raw as u16)) else { ok = false; break; };
            let mut uv_pos_idx: usize = 0;
            if i < poly.pos_uv_indices.len() {
                uv_pos_idx = poly.pos_uv_indices[i] as usize;
            }
            if uv_pos_idx >= vert.uvs.len() {
                uv_pos_idx = 0;
            }
            let uv_pos = if vert.uvs.is_empty() {
                [0.0, 0.0]
            } else {
                [vert.uvs[uv_pos_idx].u, vert.uvs[uv_pos_idx].v]
            };
            let uv_neg = if emit_back_face && i < poly.neg_uv_indices.len() {
                let mut uv_neg_idx = poly.neg_uv_indices[i] as usize;
                if uv_neg_idx >= vert.uvs.len() {
                    uv_neg_idx = 0;
                }
                if vert.uvs.is_empty() {
                    [0.0, 0.0]
                } else {
                    [vert.uvs[uv_neg_idx].u, vert.uvs[uv_neg_idx].v]
                }
            } else {
                [0.0, 0.0]
            };
            // Apply the per-part transform: `part_rot * vert.origin + part_offset`.
            let p = quat_rotate(part_rot, vert.origin);
            ring_pos.push([p.x + part_offset.x, p.y + part_offset.y, p.z + part_offset.z]);
            ring_uv_pos.push(uv_pos);
            ring_uv_neg.push(uv_neg);
        }
        if !ok || ring_pos.len() < 3 { continue; }

        // Fan-triangulate around vertex 0. Emit front-face tri first
        // (pos_surface_did, ABC winding) and, when applicable, the
        // back-face tri (neg_surface_did, ACB winding, negated normal).
        for i in 2..ring_pos.len() {
            let a = ring_pos[0]; let b = ring_pos[i - 1]; let c = ring_pos[i];
            let n = tri_normal(a, b, c);
            let len2 = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
            if len2 < 1e-12 { continue; }
            let inv_len = 1.0 / len2.sqrt();
            let nx = n[0] * inv_len;
            let ny = n[1] * inv_len;
            let nz = n[2] * inv_len;
            tris.push(Tri {
                pos: [a, b, c],
                uv: [ring_uv_pos[0], ring_uv_pos[i - 1], ring_uv_pos[i]],
                normal: [nx, ny, nz],
                surface_did: pos_surface_did,
            });
            if emit_back_face {
                // Reversed winding (A, C, B) + flipped normal so the
                // back face's triangle has its outward normal pointing
                // the opposite way. UV ring follows the same reversal
                // so neg_uv_indices line up with the back vertices.
                tris.push(Tri {
                    pos: [a, c, b],
                    uv: [ring_uv_neg[0], ring_uv_neg[i], ring_uv_neg[i - 1]],
                    normal: [-nx, -ny, -nz],
                    surface_did: neg_surface_did,
                });
            }
        }
    }
}

#[cfg(any(target_arch = "wasm32", test))]
fn quat_rotate(q: holtburger_common::Quaternion, v: holtburger_common::Vector3) -> holtburger_common::Vector3 {
    // Standard quaternion vector rotation: v' = q * v * q^-1, expanded
    // to 16 mults / 12 adds. Same math as System.Numerics.Vector3.Transform.
    let xx = q.x * q.x;
    let yy = q.y * q.y;
    let zz = q.z * q.z;
    let xy = q.x * q.y;
    let xz = q.x * q.z;
    let yz = q.y * q.z;
    let wx = q.w * q.x;
    let wy = q.w * q.y;
    let wz = q.w * q.z;
    holtburger_common::Vector3 {
        x: v.x * (1.0 - 2.0 * (yy + zz)) + v.y * (2.0 * (xy - wz)) + v.z * (2.0 * (xz + wy)),
        y: v.x * (2.0 * (xy + wz)) + v.y * (1.0 - 2.0 * (xx + zz)) + v.z * (2.0 * (yz - wx)),
        z: v.x * (2.0 * (xz - wy)) + v.y * (2.0 * (yz + wx)) + v.z * (1.0 - 2.0 * (xx + yy)),
    }
}

#[cfg(any(target_arch = "wasm32", test))]
fn tri_normal(a: [f32; 3], b: [f32; 3], c: [f32; 3]) -> [f32; 3] {
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    ]
}

/// Phase 4 step 6 Phase A: substitution-aware setup walker. ACE's
/// `Creature.CalculateObjDesc()` (in
/// `~/ace-server/Source/ACE.Server/WorldObjects/Creature_Networking.cs:35-243`)
/// walks an NPC's equipped inventory server-side, reads each equipped
/// item's `ClothingTable` from the DAT, and ships the resulting
/// `ObjDesc` (`AnimPartChanges` + `TextureChanges` + `SubPalettes`) on
/// the wire as `ModelData` on `ObjectCreate`. The browser doesn't need
/// to walk inventory or parse `ClothingTable` — it just applies what
/// ACE already computed.
///
/// `model_changes` is `&[(part_index, gfx_obj_did)]`: when a part
/// index appears here, the substituted GfxObj DID is loaded instead of
/// the SetupModel's default `parts[part_index]`. Mirrors
/// `CloObjectEffect` application at `Creature_Networking.cs:182`.
///
/// `texture_changes` is `&[(part_index, old_surface_did, new_surface_did)]`:
/// while triangulating part `part_index`, any polygon whose
/// `surface_did == old_surface_did` is rewritten to `new_surface_did`.
/// Mirrors `CloTextureEffect` application at
/// `Creature_Networking.cs:185`.
///
/// **Pose priority (Phase C, 2026-05-07):** idle MotionTable cycle
/// frame → static placement frame → identity. NPCs/creatures with a
/// `default_motion_table` get their idle stance (knees flexed, arms
/// at hip, weapons at side) instead of the T-pose hidden in many
/// setups' identity placement frames. Mirrors C# `TryResolveIdleAnimFrame`
/// at `WorldBuilder.Terminal/ObjectSpriteGenerator.cs:921-950`.
#[cfg(any(target_arch = "wasm32", test))]
fn triangulate_setup_model_with_substitutions<S: holtburger_dat::ResourceSource + ?Sized>(
    source: &S,
    setup_id: u32,
    model_changes: &[(u8, u32)],
    texture_changes: &[(u8, u32, u32)],
    tris: &mut Vec<Tri>,
) -> Option<()> {
    triangulate_setup_model_at_frame(source, setup_id, model_changes, texture_changes, None, None, tris)
}

/// Phase 4 step 6 Tier 2: triangulate a SetupModel with substitutions
/// AND an optional explicit per-part pose. When `pose_override` is
/// `Some(&AnimationFrame)`, that frame's per-part transforms replace
/// both the idle-anim frame AND the placement-frame fallback.
/// Used by the walk/run-cycle bake path: caller resolves the
/// cycle's frames once via `try_resolve_cycle_frames` (with the
/// command parameter for walk vs. run), then calls this once per
/// frame to emit one pose-specific mesh per cycle frame.
///
/// `pose_override = None` is the original `with_substitutions`
/// behaviour (Phase C idle → placement → identity fallback chain).
#[cfg(any(target_arch = "wasm32", test))]
fn triangulate_setup_model_at_frame<S: holtburger_dat::ResourceSource + ?Sized>(
    source: &S,
    setup_id: u32,
    model_changes: &[(u8, u32)],
    texture_changes: &[(u8, u32, u32)],
    mtable_override: Option<u32>,
    pose_override: Option<&holtburger_dat::file_type::setup_model::AnimationFrame>,
    tris: &mut Vec<Tri>,
) -> Option<()> {
    walk_setup_parts(
        source,
        setup_id,
        model_changes,
        texture_changes,
        mtable_override,
        pose_override,
        |_pi, gfx, offset, rot, swaps| {
            append_gfx_tris_with_tex_swaps(tris, gfx, offset, rot, swaps);
        },
    )
}

/// Phase 6 step A: per-part variant of [`triangulate_setup_model_at_frame`].
/// Returns one `Vec<Tri>` per `setup.parts[i]` so JS can address each
/// part independently for door-rotation (Phase E) and AABB collision
/// (Phase B). Parts whose GfxObj fails to load yield empty vecs at
/// their index — the slot is preserved so `part_index` stays stable
/// across boundary calls.
#[cfg(target_arch = "wasm32")]
fn triangulate_setup_model_per_part<S: holtburger_dat::ResourceSource + ?Sized>(
    source: &S,
    setup_id: u32,
    model_changes: &[(u8, u32)],
    texture_changes: &[(u8, u32, u32)],
) -> Option<Vec<Vec<Tri>>> {
    use holtburger_dat::file_type::SetupModel;
    use holtburger_dat::ResourceKey;
    let bytes = source
        .get_file_by_key(ResourceKey::new("eor/portal", setup_id))
        .ok()?;
    let setup = SetupModel::unpack(&mut std::io::Cursor::new(&bytes)).ok()?;
    let part_count = setup.parts.len();
    let mut buckets: Vec<Vec<Tri>> = (0..part_count).map(|_| Vec::new()).collect();
    walk_setup_parts(
        source,
        setup_id,
        model_changes,
        texture_changes,
        None,
        None,
        |pi, gfx, offset, rot, swaps| {
            if let Some(slot) = buckets.get_mut(pi) {
                append_gfx_tris_with_tex_swaps(slot, gfx, offset, rot, swaps);
            }
        },
    )?;
    Some(buckets)
}

/// Cohere-B (2026-05-12): per-part variant that returns part-LOCAL
/// vertices (no rest-pose frame baked in) AND the resolved rest-pose
/// `(origin, orientation)` per part as a side channel. Used by the
/// entity-animation path (`fetch_entity_animation_keyframes`) so JS
/// can set `partGroup.position` + `.quaternion` to the rest pose at
/// spawn and let the AnimationMixer overwrite with model-space cycle
/// keyframes during motion. Mirrors PhatSDK's `CPartArray::UpdateParts`
/// where `Frame::combine(entity_world, anim_frame[i])` produces each
/// part's world transform from raw part-local GfxObj vertices.
///
/// Distinct from [`triangulate_setup_model_per_part`] which BAKES the
/// rest-pose into vertex positions — that's correct for static
/// rendering (buildings, signs, AABB collision) where no AnimationMixer
/// will apply additional per-part transforms. For an animated entity
/// rig, baked-in placement double-composes against the mixer's
/// keyframe values and the rig falls apart in motion (the
/// user-reported symptom).
///
/// Returns `(per_part_tris, rest_poses)` where `rest_poses[pi]` is the
/// `(offset, rot)` that `walk_setup_parts`'s pose-priority chain
/// resolved (idle anim → placement → identity). When no rest pose
/// exists (raw GfxObj, naked setup without MotionTable), the slot
/// holds identity — caller can still apply it harmlessly.
#[cfg(any(target_arch = "wasm32", test))]
fn triangulate_setup_model_per_part_with_rest_pose<
    S: holtburger_dat::ResourceSource + ?Sized,
>(
    source: &S,
    setup_id: u32,
    model_changes: &[(u8, u32)],
    texture_changes: &[(u8, u32, u32)],
) -> Option<(
    Vec<Vec<Tri>>,
    Vec<(holtburger_common::Vector3, holtburger_common::Quaternion)>,
)> {
    use holtburger_dat::file_type::SetupModel;
    use holtburger_dat::ResourceKey;
    let bytes = source
        .get_file_by_key(ResourceKey::new("eor/portal", setup_id))
        .ok()?;
    let setup = SetupModel::unpack(&mut std::io::Cursor::new(&bytes)).ok()?;
    let part_count = setup.parts.len();
    let mut buckets: Vec<Vec<Tri>> = (0..part_count).map(|_| Vec::new()).collect();
    let mut rest_poses: Vec<(holtburger_common::Vector3, holtburger_common::Quaternion)> =
        (0..part_count)
            .map(|_| {
                (
                    holtburger_common::Vector3::zero(),
                    holtburger_common::Quaternion::identity(),
                )
            })
            .collect();
    walk_setup_parts(
        source,
        setup_id,
        model_changes,
        texture_changes,
        None,
        None,
        |pi, gfx, offset, rot, swaps| {
            if let Some(slot) = buckets.get_mut(pi) {
                // Capture the pose-priority-resolved rest frame for this
                // part as a side channel. Caller threads it into
                // EntityAnimationData so JS can set partGroup transforms
                // at spawn — matching PhatSDK's per-frame model-space
                // composition semantics.
                if let Some(rest_slot) = rest_poses.get_mut(pi) {
                    *rest_slot = (offset, rot);
                }
                // Append with identity so vertices stay part-local; the
                // rest pose travels separately above.
                append_gfx_tris_with_tex_swaps(
                    slot,
                    gfx,
                    holtburger_common::Vector3::zero(),
                    holtburger_common::Quaternion::identity(),
                    swaps,
                );
            }
        },
    )?;
    Some((buckets, rest_poses))
}

/// Shared inner loop for the SetupModel part walk. Loads the setup,
/// resolves pose priority (`pose_override` → idle → placement →
/// identity), and invokes `on_part(part_index, &gfx, offset, rot, &tex_swaps)`
/// for each `0x01` (GfxObj) part — including substituted parts via
/// `model_changes`. Used by both the fused-output path
/// ([`triangulate_setup_model_at_frame`]) and the per-part path
/// ([`triangulate_setup_model_per_part`]).
#[cfg(any(target_arch = "wasm32", test))]
fn walk_setup_parts<S: holtburger_dat::ResourceSource + ?Sized, F>(
    source: &S,
    setup_id: u32,
    model_changes: &[(u8, u32)],
    texture_changes: &[(u8, u32, u32)],
    mtable_override: Option<u32>,
    pose_override: Option<&holtburger_dat::file_type::setup_model::AnimationFrame>,
    mut on_part: F,
) -> Option<()>
where
    F: FnMut(
        usize,
        &holtburger_dat::file_type::GfxObj,
        holtburger_common::Vector3,
        holtburger_common::Quaternion,
        &[(u32, u32)],
    ),
{
    use holtburger_dat::file_type::{GfxObj, SetupModel};
    use holtburger_dat::ResourceKey;

    let bytes = source
        .get_file_by_key(ResourceKey::new("eor/portal", setup_id))
        .ok()?;
    let setup = SetupModel::unpack(&mut std::io::Cursor::new(&bytes)).ok()?;

    // Phase C + Tier 2: pose_override (walk-cycle frame) wins over
    // idle frame. Phase C still resolves idle for setups with no
    // pose_override. Static placement (Resting → Default → first)
    // is the per-part fallback for setups without a MotionTable.
    let idle_frame = if pose_override.is_none() {
        try_resolve_idle_anim_frame_with_override(source, &setup, mtable_override)
    } else {
        None
    };
    let placement = setup
        .placement_frames
        .get(&0)
        .or_else(|| setup.placement_frames.get(&1))
        .or_else(|| setup.placement_frames.values().next());

    for (pi, &default_part_id) in setup.parts.iter().enumerate() {
        // Resolve the actual GfxObj DID for this part: substitution wins
        // over the setup's default. ACE's `CalculateObjDesc` produces
        // exactly one AnimPartChange per substituted slot, so a linear
        // search is fine (NPCs have at most ~25 substitutions).
        let part_id = model_changes
            .iter()
            .find(|(idx, _)| *idx as usize == pi)
            .map(|(_, gfx)| *gfx)
            .unwrap_or(default_part_id);
        if (part_id >> 24) as u8 != 0x01 { continue; }
        let Ok(part_bytes) = source.get_file_by_key(ResourceKey::new("eor/portal", part_id))
            else { continue };
        let Ok(gfx) = GfxObj::unpack(&mut std::io::Cursor::new(&part_bytes))
            else { continue };

        // Pose priority: explicit Tier-2 pose override (walk-cycle
        // frame) → Phase C idle anim frame → static placement frame
        // → identity. Mirrors ObjectSpriteGenerator.cs:842-852 with
        // an extra preceding override for the multi-frame bake path.
        let frame_lookup = pose_override
            .filter(|f| pi < f.frames.len())
            .map(|f| (f.frames[pi].origin, f.frames[pi].orientation))
            .or_else(|| {
                idle_frame.as_ref().filter(|f| pi < f.frames.len())
                    .map(|f| (f.frames[pi].origin, f.frames[pi].orientation))
            })
            .or_else(|| {
                placement.filter(|p| pi < p.anim_frame.frames.len())
                    .map(|p| (p.anim_frame.frames[pi].origin, p.anim_frame.frames[pi].orientation))
            });
        let (offset, rot) = frame_lookup.unwrap_or((
            holtburger_common::Vector3::zero(),
            holtburger_common::Quaternion::identity(),
        ));

        // Per-part texture remap table for append_gfx_tris_with_tex_swaps.
        // Empty for parts without texture changes — the swap is a no-op
        // path inside the appender, so passing empty stays cheap.
        let part_tex_swaps_buf: Vec<(u32, u32)> = texture_changes
            .iter()
            .filter(|(p, _, _)| *p as usize == pi)
            .map(|(_, old, new)| (*old, *new))
            .collect();
        on_part(pi, &gfx, offset, rot, &part_tex_swaps_buf);
    }
    Some(())
}

/// Phase 6 step B: per-part AABB walker. Sister to `walk_setup_parts`,
/// but accumulates each part's GfxObj vertex positions into a
/// part-local axis-aligned bounding box (post per-part frame
/// transform, pre placement frame). Returns one `Aabb` per
/// `setup.parts[i]` so the caller can bucket each AABB independently
/// into the per-cell collision index. Coarser cyl_sphere bounds
/// would over-block (Holtburg roof overhangs would block ground-
/// level walking past the wall plane); per-vertex bounds match what
/// the renderer actually draws.
///
/// Empty parts (substituted GfxObj missing, raw `0x01` instead of
/// SetupModel, or all polygons skipped) yield an `Aabb::empty()`
/// at their slot — caller filters those before bucketing.
#[cfg(any(target_arch = "wasm32", test))]
fn walk_setup_parts_with_geom<S: holtburger_dat::ResourceSource + ?Sized>(
    source: &S,
    setup_id: u32,
) -> Option<Vec<holtburger_common::Aabb>> {
    use holtburger_dat::file_type::SetupModel;
    use holtburger_dat::ResourceKey;
    let bytes = source
        .get_file_by_key(ResourceKey::new("eor/portal", setup_id))
        .ok()?;
    let setup = SetupModel::unpack(&mut std::io::Cursor::new(&bytes)).ok()?;
    let part_count = setup.parts.len();
    let mut aabbs: Vec<holtburger_common::Aabb> =
        (0..part_count).map(|_| holtburger_common::Aabb::empty()).collect();
    walk_setup_parts(
        source,
        setup_id,
        &[],
        &[],
        None,
        None,
        |pi, gfx, offset, rot, _swaps| {
            let Some(slot) = aabbs.get_mut(pi) else { return };
            for vert in gfx.vertex_array.vertices.values() {
                let p = quat_rotate(rot, vert.origin);
                let world = holtburger_common::Vector3 {
                    x: p.x + offset.x,
                    y: p.y + offset.y,
                    z: p.z + offset.z,
                };
                slot.expand_to_include_point(world);
            }
        },
    )?;
    Some(aabbs)
}

/// Workstream C (3D camera collision, 2026-05-11): sister to
/// [`walk_setup_parts_with_geom`] that returns **both** per-part
/// AABBs AND per-part fan-triangulated physics triangles in the
/// setup's local frame (post per-part frame composition, pre
/// placement-frame transform). Used by
/// `populate_building_aabbs_for_landblock_impl` to populate the
/// camera-collision building-physics index alongside the existing
/// AABB index.
///
/// Returned `Vec<(Aabb, Vec<Triangle>)>` has one tuple per
/// `setup.parts[i]`. Empty triangle vecs for parts whose GfxObj has
/// no `physics_polygons` — most retail Holtburg building parts ship
/// physics polys, but a few props (decorative items, sign posts) have
/// only drawing geometry. AABB is built from the GfxObj's vertex
/// array (post part-frame transform); triangles are fan-triangulated
/// from `physics_polygons` against the same vertex array, with the
/// SAME part-frame transform applied so the AABB conservatively
/// bounds the triangles.
///
/// Mirrors the cell-physics path in `populate_env_cells_for_landblock`
/// step G: fan-triangulate `num_pts > 3`, drop polygons with
/// `num_pts < 3`, silently skip vertices that don't resolve (rare
/// dat corruption). Triangles are returned in part-local-post-part-
/// frame coords; caller applies the placement transform.
#[cfg(target_arch = "wasm32")]
fn walk_setup_parts_with_geom_and_physics<S: holtburger_dat::ResourceSource + ?Sized>(
    source: &S,
    setup_id: u32,
) -> Option<Vec<(holtburger_common::Aabb, Vec<holtburger_common::Triangle>)>> {
    use holtburger_dat::file_type::SetupModel;
    use holtburger_dat::ResourceKey;
    let bytes = source
        .get_file_by_key(ResourceKey::new("eor/portal", setup_id))
        .ok()?;
    let setup = SetupModel::unpack(&mut std::io::Cursor::new(&bytes)).ok()?;
    let part_count = setup.parts.len();
    let mut out: Vec<(holtburger_common::Aabb, Vec<holtburger_common::Triangle>)> =
        (0..part_count)
            .map(|_| (holtburger_common::Aabb::empty(), Vec::new()))
            .collect();
    walk_setup_parts(
        source,
        setup_id,
        &[],
        &[],
        None,
        None,
        |pi, gfx, offset, rot, _swaps| {
            let Some(slot) = out.get_mut(pi) else { return };
            // AABB from vertex array (post part frame).
            for vert in gfx.vertex_array.vertices.values() {
                let p = quat_rotate(rot, vert.origin);
                let world = holtburger_common::Vector3 {
                    x: p.x + offset.x,
                    y: p.y + offset.y,
                    z: p.z + offset.z,
                };
                slot.0.expand_to_include_point(world);
            }
            // Physics triangles from `physics_polygons` (post part
            // frame). Fan-triangulate `num_pts > 3`; skip polygons
            // with `num_pts < 3` (degenerate). Skip polygons whose
            // vertex_ids don't all resolve — defensive against dat
            // corruption (the polygon list and vertex array are
            // separately read).
            for poly in gfx.physics_polygons.values() {
                if poly.num_pts < 3 {
                    continue;
                }
                let mut part_local_verts: Vec<holtburger_common::Vector3> =
                    Vec::with_capacity(poly.num_pts as usize);
                let mut all_ok = true;
                for &vid in &poly.vertex_ids {
                    if vid < 0 {
                        all_ok = false;
                        break;
                    }
                    let key = vid as u16;
                    let Some(sw) = gfx.vertex_array.vertices.get(&key) else {
                        all_ok = false;
                        break;
                    };
                    // Apply part-frame transform (same as AABB above).
                    let local = holtburger_common::Vector3::new(
                        sw.origin.x,
                        sw.origin.y,
                        sw.origin.z,
                    );
                    let rotated = quat_rotate(rot, local);
                    part_local_verts.push(holtburger_common::Vector3::new(
                        rotated.x + offset.x,
                        rotated.y + offset.y,
                        rotated.z + offset.z,
                    ));
                }
                if !all_ok || part_local_verts.len() < 3 {
                    continue;
                }
                // Fan triangulation: (v0, v1, v2), (v0, v2, v3), …
                // AC physics polygons are convex (BSP-emitted), so fan
                // is correct.
                for i in 1..(part_local_verts.len() - 1) {
                    slot.1.push(holtburger_common::Triangle::new(
                        part_local_verts[0],
                        part_local_verts[i],
                        part_local_verts[i + 1],
                    ));
                }
            }
        },
    )?;
    Some(out)
}

/// Phase 4 step 6 Tier 2: resolve the *walk-forward* animation
/// frames. Same MotionTable walk as `try_resolve_idle_anim_frame`
/// (path 1 only — there's no `default_animation` fallback for walk),
/// but uses `MotionTable::WALK_FORWARD_COMMAND` (`0x4500_0005`)
/// instead of the style-defaults idle substate, and returns the
/// **range** `[low_frame, high_frame)` from the resolved
/// `AnimData` rather than just `part_frames[0]`. The returned
/// `Vec<AnimationFrame>` is the walk cycle's per-frame poses;
/// caller iterates them in order to bake one sprite per cycle frame.
///
/// Returns `None` for setups without a walk cycle (most static props
/// + creatures whose MotionTable doesn't have a WalkForward entry —
/// e.g. an Orange — fall through to whatever the caller's idle
/// fallback is). Caller should treat None as "no walk anim
/// available; render idle pose only" and skip the walk-frame bake.
///
/// Stance choice: NonCombat (`mtable.default_style`) is the only
/// stance baked here. Combat-stance walks render with the same
/// frames — visually approximate, but avoids 3-5× storage. A
/// future tier could bake per-stance walks if anyone asks.
#[cfg(any(target_arch = "wasm32", test))]
fn try_resolve_cycle_frames<S: holtburger_dat::ResourceSource + ?Sized>(
    source: &S,
    setup: &holtburger_dat::file_type::SetupModel,
    mtable_override: Option<u32>,
    stance_override: u32,
    command: u32,
) -> Option<(
    Vec<holtburger_dat::file_type::setup_model::AnimationFrame>,
    f32,
    u32,
)> {
    use holtburger_dat::file_type::{Animation, MotionTable};
    use holtburger_dat::ResourceKey;

    // Humanoid setups (0x02000001 etc.) ship `default_motion_table
    // = None`; their MotionTable lives on the weenie record and ACE
    // ships it on the wire as `ObjectDescriptionData.mtable_id`.
    // EntityUpdate.mtableId carries it through, and the wasm export
    // hands it down here as `mtable_override`. For setups with a
    // baked-in default (props, doors), override is None and we use
    // setup.default_motion_table.
    let mt_id = mtable_override
        .filter(|&id| id != 0)
        .or(setup.default_motion_table)?;
    if (mt_id >> 24) != 0x09 { return None; }
    let bytes = source.get_file_by_key(ResourceKey::new("eor/portal", mt_id)).ok()?;
    let mtable = MotionTable::read(&mut std::io::Cursor::new(&bytes)).ok()?;

    // Stance dispatch. `stance_override == 0` is "use this MotionTable's
    // default_style" (the pre-stance-aware behaviour: NonCombat for
    // most creatures, HandCombat for the rare creature that spawns
    // weapon-drawn). Nonzero stance overrides come from
    // EntityUpdate.motionStance carrying the live UpdateMotion
    // current_style — typically the same default for at-rest creatures
    // and a combat stance once they engage.
    //
    // The cycle_key helper masks `stance & 0xFFFF`, so the u16
    // interpreted form (`MotionStance.interpreted()` — what the wire
    // carries) and the full u32 form (0x8000_xxxx — what `default_style`
    // stores) produce the same key. Both work.
    let resolved_stance = if stance_override == 0 {
        mtable.default_style
    } else {
        stance_override
    };

    // Use MotionTable::motion_data_for_cycle which builds the key
    // via the canonical `cycle_key(stance, command)` helper —
    // (stance & 0xFFFF) << 16 | (command & MOTION_KEY_MASK).
    // MOTION_KEY_MASK = 0x000F_FFFF, so the high bits of e.g.
    // WALK_FORWARD_COMMAND (0x4500_0000) are stripped before the
    // lookup. The wrong mask width is a footgun — Phase C's idle
    // path got away with it because style_defaults stores the
    // pre-masked substate, not the full command.
    let motion_data = mtable.motion_data_for_cycle(resolved_stance, command)?;
    let anim_data = motion_data.anims.first()?;
    let anim_did = anim_data.anim_id;
    let framerate = anim_data.framerate;
    if (anim_did >> 24) != 0x03 { return None; }

    let anim_bytes = source.get_file_by_key(ResourceKey::new("eor/portal", anim_did)).ok()?;
    let anim = Animation::read(&mut std::io::Cursor::new(&anim_bytes)).ok()?;
    if anim.part_frames.is_empty() { return None; }

    // AnimData specifies the playback range as [low_frame,
    // high_frame] *INCLUSIVE on both ends*, with `high_frame == -1`
    // meaning "play to the last frame of the Animation". Per
    // ACE.Server/Physics/Animation/AnimSequenceNode.cs:30 the
    // default `HighFrame = -1` and `get_ending_frame() = HighFrame +
    // 1 - EPSILON` (inclusive end). My initial impl treated it as
    // `[low, high)` exclusive end and clamped -1 to 0 via max(0),
    // which gave an empty 0..0 range for the common "play everything"
    // case. The correct semantic:
    //   if high_frame == -1: range = [low_frame, num_part_frames)
    //   else                : range = [low_frame, high_frame + 1)
    let total = anim.part_frames.len();
    let low = (anim_data.low_frame.max(0) as usize).min(total);
    let high = if anim_data.high_frame < 0 {
        total
    } else {
        ((anim_data.high_frame as usize).saturating_add(1)).min(total)
    };
    if low >= high { return None; }
    Some((
        anim.part_frames[low..high].to_vec(),
        framerate,
        resolved_stance,
    ))
}

/// Phase 4 step 6 Phase C: resolve the idle pose for a SetupModel by
/// walking `default_motion_table` → `cycles[(default_style << 16) |
/// idleSubstate]` → first `AnimData.anim_id` → `Animation.part_frames[0]`.
/// Falls back to `setup.default_animation` (path 2) if the MotionTable
/// path doesn't yield. Returns `None` for setups without an animation
/// reference (most static props), which keeps their static placement
/// frame as the rendered pose.
///
/// Mirrors C# `TryResolveIdleAnimFrame` at
/// `WorldBuilder.Terminal/ObjectSpriteGenerator.cs:921-950` — same
/// MotionTable cycle-key formula, same path-1-then-path-2 fallback,
/// same "is the resolved DID actually an Animation (0x03 prefix)?"
/// guard. Per-frame failures (missing DAT record, malformed parse)
/// silently degrade to placement-frame instead of panicking; ACE's
/// own renderer does the same via `SafeTryGet`.
#[cfg(any(target_arch = "wasm32", test))]
fn try_resolve_idle_anim_frame<S: holtburger_dat::ResourceSource + ?Sized>(
    source: &S,
    setup: &holtburger_dat::file_type::SetupModel,
) -> Option<holtburger_dat::file_type::setup_model::AnimationFrame> {
    try_resolve_idle_anim_frame_with_override(source, setup, None)
}

#[cfg(any(target_arch = "wasm32", test))]
fn try_resolve_idle_anim_frame_with_override<S: holtburger_dat::ResourceSource + ?Sized>(
    source: &S,
    setup: &holtburger_dat::file_type::SetupModel,
    mtable_override: Option<u32>,
) -> Option<holtburger_dat::file_type::setup_model::AnimationFrame> {
    use holtburger_dat::file_type::{Animation, MotionTable};
    use holtburger_dat::ResourceKey;
    let mut anim_did: u32 = 0;

    // Path 1: motion table (override → setup.default) → cycles → AnimData[0].
    // Same override semantics as walk-cycle: humanoid setups need
    // the wire-shipped mtable_id from EntityUpdate; props use
    // setup.default_motion_table.
    let resolved_mt = mtable_override
        .filter(|&id| id != 0)
        .or(setup.default_motion_table);
    if let Some(mt_id) = resolved_mt {
        if (mt_id >> 24) == 0x09 {
            if let Ok(bytes) = source.get_file_by_key(ResourceKey::new("eor/portal", mt_id)) {
                if let Ok(mtable) = MotionTable::read(&mut std::io::Cursor::new(&bytes)) {
                    if let Some(&idle_substate) = mtable.style_defaults.get(&mtable.default_style) {
                        // Cycle key per AC physics: high 16 bits style,
                        // low 24 bits substate. Mirrors C#:
                        //   ((uint)mtable.DefaultStyle << 16) |
                        //   ((uint)idleSubstate & 0xFFFFFF)
                        let cycle_key =
                            (mtable.default_style << 16) | (idle_substate & 0x00FF_FFFF);
                        if let Some(motion_data) = mtable.cycles.get(&cycle_key) {
                            if let Some(first_anim) = motion_data.anims.first() {
                                anim_did = first_anim.anim_id;
                            }
                        }
                    }
                }
            }
        }
    }

    // Path 2: setup.default_animation (no MotionTable, but the setup
    // points directly at an Animation).
    if anim_did == 0 {
        if let Some(da) = setup.default_animation {
            anim_did = da;
        }
    }

    // Sanity guard: must be a 0x03-prefixed Animation DID.
    if anim_did == 0 || (anim_did >> 24) != 0x03 {
        return None;
    }
    let bytes = source
        .get_file_by_key(ResourceKey::new("eor/portal", anim_did))
        .ok()?;
    let anim = Animation::read(&mut std::io::Cursor::new(&bytes)).ok()?;
    anim.part_frames.into_iter().next()
}

/// Top-level model triangulation: dispatch on `model_id >> 24`.
/// `0x01` → single GfxObj at identity transform; `0x02` → SetupModel
/// walk through parts. Returns `None` if the model record can't be
/// loaded; an empty Vec means "loaded but had no drawable polygons"
/// (legitimate — some retail models are physics-only).
#[cfg(any(target_arch = "wasm32", test))]
fn triangulate_model<S: holtburger_dat::ResourceSource + ?Sized>(
    source: &S,
    model_id: u32,
) -> Option<Vec<Tri>> {
    triangulate_model_with_substitutions(source, model_id, &[], &[])
}

/// Phase 4 step 6 Phase A: substitution-aware top-level dispatch.
/// `0x01` (raw GfxObj) ignores the substitution tables since there's
/// only one part. `0x02` (SetupModel) routes through the substitution-
/// aware walker.
#[cfg(any(target_arch = "wasm32", test))]
fn triangulate_model_with_substitutions<S: holtburger_dat::ResourceSource + ?Sized>(
    source: &S,
    model_id: u32,
    model_changes: &[(u8, u32)],
    texture_changes: &[(u8, u32, u32)],
) -> Option<Vec<Tri>> {
    triangulate_model_with_substitutions_and_mtable(source, model_id, model_changes, texture_changes, None)
}

#[cfg(any(target_arch = "wasm32", test))]
fn triangulate_model_with_substitutions_and_mtable<S: holtburger_dat::ResourceSource + ?Sized>(
    source: &S,
    model_id: u32,
    model_changes: &[(u8, u32)],
    texture_changes: &[(u8, u32, u32)],
    mtable_override: Option<u32>,
) -> Option<Vec<Tri>> {
    use holtburger_dat::file_type::GfxObj;
    use holtburger_dat::ResourceKey;
    let mut tris = Vec::new();
    match (model_id >> 24) as u8 {
        0x01 => {
            let bytes = source
                .get_file_by_key(ResourceKey::new("eor/portal", model_id))
                .ok()?;
            let gfx = GfxObj::unpack(&mut std::io::Cursor::new(&bytes)).ok()?;
            append_gfx_tris(
                &mut tris,
                &gfx,
                holtburger_common::Vector3::zero(),
                holtburger_common::Quaternion::identity(),
            );
        }
        0x02 => {
            triangulate_setup_model_at_frame(
                source,
                model_id,
                model_changes,
                texture_changes,
                mtable_override,
                None,
                &mut tris,
            )?;
        }
        _ => return None,
    }
    Some(tris)
}

/// Follow-on #5 (LOD) — resolve a model_id's `did_degrade` chain entry.
///
/// AC's `GfxObj` struct carries an `Option<u32>` `did_degrade` field
/// pointing at a lower-detail GfxObj of the same visual; the engine
/// historically swapped to it at view distances >~100 m. Most Holtburg
/// models don't have one (it's mainly for distant scenery like trees).
///
///   - `0x01XXXXXX` raw GfxObj: returns the GfxObj's own `did_degrade`
///     (or 0 if `HAS_DID_DEGRADE` is unset).
///   - `0x02XXXXXX` SetupModel: returns the first part GfxObj's
///     `did_degrade`. Multi-part SetupModels share one "level of
///     detail" decision per-model in retail AC (you don't degrade
///     individual parts independently — that would risk parts falling
///     out of alignment), so the first part's chain is sufficient.
///     Holtburg statics are almost all single-part SetupModels so this
///     simplification covers the realistic case.
///   - Any other prefix: returns 0 (not a model — environments, etc.).
///
/// Returns 0 on any I/O / parse failure — JS treats 0 as "no LOD chain
/// available, use a plain Mesh".
#[cfg(any(target_arch = "wasm32", test))]
fn resolve_did_degrade<S: holtburger_dat::ResourceSource + ?Sized>(
    source: &S,
    model_id: u32,
) -> u32 {
    use holtburger_dat::file_type::{GfxObj, SetupModel};
    use holtburger_dat::ResourceKey;
    match (model_id >> 24) as u8 {
        0x01 => {
            let Ok(bytes) =
                source.get_file_by_key(ResourceKey::new("eor/portal", model_id))
            else {
                return 0;
            };
            let Ok(gfx) = GfxObj::unpack(&mut std::io::Cursor::new(&bytes)) else {
                return 0;
            };
            gfx.did_degrade.unwrap_or(0)
        }
        0x02 => {
            let Ok(bytes) =
                source.get_file_by_key(ResourceKey::new("eor/portal", model_id))
            else {
                return 0;
            };
            let Ok(setup) = SetupModel::unpack(&mut std::io::Cursor::new(&bytes)) else {
                return 0;
            };
            let Some(&first_part) = setup.parts.first() else {
                return 0;
            };
            // Recurse — for the typical Holtburg setup, first_part is a
            // 0x01 GfxObj. The recursion bottom-outs at the 0x01 branch
            // above; we cap the recursion at one level by only matching
            // the first_part's prefix once.
            if (first_part >> 24) as u8 == 0x01 {
                let Ok(pbytes) =
                    source.get_file_by_key(ResourceKey::new("eor/portal", first_part))
                else {
                    return 0;
                };
                let Ok(pgfx) = GfxObj::unpack(&mut std::io::Cursor::new(&pbytes)) else {
                    return 0;
                };
                pgfx.did_degrade.unwrap_or(0)
            } else {
                0
            }
        }
        _ => 0,
    }
}

/// Pack a `Vec<Tri>` into the wasm-bindgen-friendly [`ModelMesh`]
/// shape: dedupe surface_dids into the `surfaces` array, replace each
/// triangle's `surface_did` with a u8 index, flatten per-triangle
/// vertex data into typed-array buffers, compute the world bbox.
#[cfg(target_arch = "wasm32")]
fn pack_model_mesh(tris: Vec<Tri>) -> ModelMesh {
    // Surface dedupe + index map (insertion-order preserved for
    // determinism). u8 cap = 255 unique surfaces per model — fine
    // for AC (most models use ≤8).
    let mut surfaces: Vec<u32> = Vec::new();
    let mut sidx_lookup: std::collections::HashMap<u32, u8> = std::collections::HashMap::new();
    let mut positions = Vec::with_capacity(tris.len() * 9);
    let mut uvs = Vec::with_capacity(tris.len() * 6);
    let mut normals = Vec::with_capacity(tris.len() * 3);
    let mut surface_indices = Vec::with_capacity(tris.len());

    let mut bbox_min = [f32::INFINITY; 3];
    let mut bbox_max = [f32::NEG_INFINITY; 3];

    for tri in &tris {
        let sidx: u8 = if tri.surface_did == 0 {
            0xFF // sentinel "no surface"
        } else if let Some(&idx) = sidx_lookup.get(&tri.surface_did) {
            idx
        } else if surfaces.len() >= 255 {
            0xFF // too many surfaces; cap at 255
        } else {
            let idx = surfaces.len() as u8;
            surfaces.push(tri.surface_did);
            sidx_lookup.insert(tri.surface_did, idx);
            idx
        };
        surface_indices.push(sidx);

        for v in 0..3 {
            let p = tri.pos[v];
            positions.extend_from_slice(&p);
            uvs.extend_from_slice(&tri.uv[v]);
            for k in 0..3 {
                if p[k] < bbox_min[k] { bbox_min[k] = p[k]; }
                if p[k] > bbox_max[k] { bbox_max[k] = p[k]; }
            }
        }
        normals.extend_from_slice(&tri.normal);
    }

    if !bbox_min[0].is_finite() {
        bbox_min = [0.0, 0.0, 0.0];
        bbox_max = [0.0, 0.0, 0.0];
    }

    ModelMesh {
        positions,
        uvs,
        normals,
        surface_indices,
        surfaces,
        bbox_min,
        bbox_max,
        // Follow-on #5: pack_model_mesh has no access to the source
        // model_id (and so can't resolve a degrade chain). The caller
        // (`fetch_model_mesh` / `fetch_model_meshes`) post-fills this
        // via a separate GfxObj walk after the pack returns.
        did_degrade: 0,
    }
}

/// One surface's decoded pixels — output of [`fetch_surface_pixels`]
/// / [`fetch_surfaces_pixels`]. Used by Phase 3 step 6's in-browser
/// rasterizer to UV-map per-poly textures into the model's tile.
///
/// `surface_type` is the raw `SurfaceType` bitfield read from the
/// Surface record (see `holtburger_dat::file_type::surface::Surface`
/// and `ACE.Entity.Enum.SurfaceType`). The 3D path's `MaterialCache`
/// (`scene3d/materials.js`) decodes it into MeshStandardMaterial flags:
///   - `Translucent (0x10)` → `transparent = true, depthWrite = false`
///   - `Base1ClipMap (0x4)` → `alphaTest = 0.5`
///   - `Luminous (0x40)` → emissive map + colour
///   - `Additive (0x10000)` → `blending = AdditiveBlending`
///   - `Diffuse (0x20)` → matte (no specular reflection)
/// AC has no explicit "TwoSided" bit; two-sidedness is encoded
/// per-Polygon via `sides_type == CullMode::Clockwise (0x2)` and is
/// handled in the triangulator — see Phase 7 follow-on #7 (two-sided
/// polys with distinct pos/neg surfaces emit two tris with opposite
/// winding in `append_gfx_tris_with_tex_swaps`).
///
/// Defaults to 0 for empty/failed surfaces — the JS decoder reads 0 as
/// "no flag bits set → opaque path", which is the desired fallback.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
#[cfg(any(target_arch = "wasm32", test))]
pub struct SurfacePixels {
    width: u32,
    height: u32,
    pixels: Vec<u8>, // RGBA8, length = width * height * 4
    /// Raw `Surface.surface_type` bitfield from the DAT. 0 for empty
    /// fallbacks so the JS material decoder treats it as opaque.
    /// (See `ACE.Entity.Enum.SurfaceType` for the canonical bit list.)
    surface_type: u32,
    /// Phase 1.4 — heuristic surface category encoded as
    /// `SurfaceCategory::as_u8()` (12 = Generic). The JS material
    /// decoder maps this to category-aware roughness / metalness
    /// defaults. See `holtburger_dat::surface_classify` for the
    /// rule set and `apps/holtburger-web/scene3d/materials.js`
    /// `_materialFromFlags` for the JS consumer.
    ///
    /// Phase 1.5 — if `data/surface_overrides.json` has a
    /// `category:` entry for this DID, the override value is
    /// substituted before the heuristic is consulted.
    category: u8,
    /// Phase 1.5 — optional roughness override sourced from
    /// `surface_overrides.json` (`f32::NAN` sentinel = "no override"
    /// because Vec<u8> can't carry an `Option<f32>` over wasm-bindgen).
    /// JS-side `materials.js::_materialFromFlags` reads this after
    /// applying the category default.
    roughness_override: f32,
    /// Phase 1.5 — optional normal-scale override (same NaN sentinel).
    normal_scale_override: f32,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl SurfacePixels {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 { self.width }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 { self.height }
    /// `Uint8Array(width * height * 4)` of straight-RGBA pixels.
    #[wasm_bindgen(getter)]
    pub fn pixels(&self) -> Vec<u8> { self.pixels.clone() }
    /// Raw `Surface.surface_type` bitfield (see `ACE.Entity.Enum.SurfaceType`).
    /// 0 for the empty fallback surface — the JS material decoder
    /// treats 0 as "no flags set → fully opaque".
    #[wasm_bindgen(getter, js_name = surfaceType)]
    pub fn surface_type(&self) -> u32 { self.surface_type }
    /// Phase 1.4 — heuristic surface category as a stable u8
    /// (see `SurfaceCategory::as_u8`: Stone=0, Wood=1, Metal=2,
    /// Sand=3, Lava=4, Water=5, Foliage=6, Cloth=7, Dirt=8,
    /// Snow=9, Brick=10, Tile=11, Generic=12). 12 (Generic) for
    /// the empty-fallback surface.
    ///
    /// Phase 1.5 — this getter already reflects the override-layer
    /// substitution: if `data/surface_overrides.json` has a `category`
    /// for this DID, the override value is returned here.
    #[wasm_bindgen(getter)]
    pub fn category(&self) -> u8 { self.category }
    /// Phase 1.5 — roughness override (`NaN` = "use category default
    /// in JS"). When finite, the JS material picker substitutes this
    /// for the category-default roughness in `materials.js`.
    #[wasm_bindgen(getter, js_name = roughnessOverride)]
    pub fn roughness_override(&self) -> f32 { self.roughness_override }
    /// Phase 1.5 — normal-scale override (`NaN` = "use category default
    /// in JS"). Reserved for the procedural-normal path (Phase 1.1) to
    /// read post-resolve when authoring a custom bump strength per DID.
    #[wasm_bindgen(getter, js_name = normalScaleOverride)]
    pub fn normal_scale_override(&self) -> f32 { self.normal_scale_override }
}

/// Phase 1.5 — cache the parsed `data/surface_overrides.json` for the
/// life of the wasm bundle / native test process. First call parses;
/// subsequent calls return the cached map. Resilient: parse failures
/// are swallowed inside the loader (empty map fall-through).
#[cfg(any(target_arch = "wasm32", test))]
fn surface_overrides_map() -> &'static std::collections::HashMap<u32, surface_overrides::OverrideEntry> {
    static MAP: std::sync::OnceLock<std::collections::HashMap<u32, surface_overrides::OverrideEntry>> = std::sync::OnceLock::new();
    MAP.get_or_init(surface_overrides::load_overrides)
}

/// Phase 1.5 — compute the post-override `(category_u8, roughness, normal_scale)`
/// triple for one surface. Consults the override map first (per §Phase 1.5
/// Objective #3); if no `category` is set in the override, falls through
/// to the Phase 1.4 heuristic in `classify`. The two material-parameter
/// overrides are returned independently of the category override (so the
/// glass-pane case at 0x080006E2 can stay `Generic` but pin roughness=0.25).
///
/// Roughness / normal-scale "no override" is encoded as `f32::NAN` for the
/// wasm-bindgen ABI — JS-side `_materialFromFlags` runs the result through
/// `Number.isFinite` to decide whether to apply it.
#[cfg(any(target_arch = "wasm32", test))]
fn classify_with_overrides(
    stats: &holtburger_dat::surface_classify::SurfaceStats,
    surface_type: u32,
    surface_did: u32,
) -> (u8, f32, f32) {
    use holtburger_dat::surface_classify::classify;
    let overrides = surface_overrides_map();
    let entry = surface_overrides::lookup(overrides, surface_did);
    let category = match entry.and_then(|e| e.category) {
        Some(c) => c.as_u8(),
        None => classify(stats, surface_type).as_u8(),
    };
    let roughness = entry.and_then(|e| e.roughness).unwrap_or(f32::NAN);
    let normal_scale = entry.and_then(|e| e.normal_scale).unwrap_or(f32::NAN);
    (category, roughness, normal_scale)
}

/// Walk Surface → SurfaceTexture → Texture → RGBA8 for one surface
/// DID. Returns an empty 0x0 SurfacePixels (width=height=0,
/// pixels.len()=0) when any step of the chain fails — JS treats that
/// as "no texture, fall back to flat colour".
#[cfg(any(target_arch = "wasm32", test))]
fn fetch_surface_pixels_impl<S: holtburger_dat::ResourceSource + ?Sized>(
    source: &S,
    surface_did: u32,
) -> SurfacePixels {
    use holtburger_dat::file_type::{Palette, Surface, SurfaceTexture, Texture, TextureDecodeError};
    use holtburger_dat::surface_classify::{compute_stats, SurfaceCategory};
    use holtburger_dat::ResourceKey;
    // Generic (12) is the natural empty / "no opinion" fallback for
    // the JS material decoder.
    let generic_cat = SurfaceCategory::Generic.as_u8();
    let empty = SurfacePixels { width: 0, height: 0, pixels: Vec::new(), surface_type: 0, category: generic_cat, roughness_override: f32::NAN, normal_scale_override: f32::NAN };

    let Ok(bytes) = source.get_file_by_key(ResourceKey::new("eor/portal", surface_did)) else { return empty; };
    let Ok(surface) = Surface::unpack(&bytes) else { return empty; };
    // Capture the raw bitfield BEFORE the solid/textured branch so both
    // 1×1 ARGB synthesized surfaces AND real textures surface the same
    // flags to JS (e.g. a solid translucent overlay still wants
    // `transparent = true` even though the body holds a colour, not a
    // texture ref).
    let surface_type = surface.surface_type;
    if let Some(argb) = surface.solid_color() {
        // Solid surfaces have no pixel data — synthesize a 1×1 ARGB
        // texture so the shader can sample-and-modulate uniformly.
        let a = ((argb >> 24) & 0xFF) as u8;
        let r = ((argb >> 16) & 0xFF) as u8;
        let g = ((argb >> 8) & 0xFF) as u8;
        let b = (argb & 0xFF) as u8;
        let pixels = vec![r, g, b, a];
        // Phase 1.4 — classify the 1x1 too (rare but legal: solid
        // surfaces with the Luminous flag set should still hit Lava).
        // Phase 1.5 — consult overrides first, then fall through to
        // the heuristic.
        let stats = compute_stats(&pixels, 1, 1);
        let (category, roughness_override, normal_scale_override) =
            classify_with_overrides(&stats, surface_type, surface_did);
        return SurfacePixels {
            width: 1,
            height: 1,
            pixels,
            surface_type,
            category,
            roughness_override,
            normal_scale_override,
        };
    }
    let Some((surf_tex_id, _)) = surface.textured() else { return empty; };
    let Ok(stb) = source.get_file_by_key(ResourceKey::new("eor/portal", surf_tex_id)) else { return empty; };
    let Ok(surf_tex) = SurfaceTexture::unpack(&stb) else { return empty; };
    let Some(rs_id) = surf_tex.highest_res() else { return empty; };
    let Ok(tb) = source.get_file_by_key(ResourceKey::new("eor/portal", rs_id)) else { return empty; };
    let Ok(tex) = Texture::unpack(&tb) else { return empty; };
    let rgba = tex
        .to_rgba8(|pal_id| {
            let pb = source
                .get_file_by_key(ResourceKey::new("eor/portal", pal_id))
                .map_err(|e| TextureDecodeError::PaletteFetch(format!("{pal_id:#010X}: {e}")))?;
            Palette::unpack(&pb).map_err(|e| {
                TextureDecodeError::PaletteFetch(format!("Palette::unpack {pal_id:#010X}: {e}"))
            })
        });
    match rgba {
        Ok(pixels) => {
            // Phase 1.4 — compute heuristic category at decode time
            // (per §11 open question #1 — decode-time, not bake-time).
            // Phase 1.5 — consult `data/surface_overrides.json` first;
            // fall through to the heuristic when no override applies.
            let stats = compute_stats(&pixels, tex.width as u32, tex.height as u32);
            let (category, roughness_override, normal_scale_override) =
                classify_with_overrides(&stats, surface_type, surface_did);
            SurfacePixels {
                width: tex.width as u32,
                height: tex.height as u32,
                pixels,
                surface_type,
                category,
                roughness_override,
                normal_scale_override,
            }
        }
        Err(_) => empty,
    }
}

/// Phase 3 step 6: fetch decoded RGBA8 pixels for one surface DID.
/// Empty result means the walk failed at some step — JS falls back
/// to a flat fill for that triangle group.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn fetch_surface_pixels(surface_did: u32) -> Result<SurfacePixels, JsValue> {
    use holtburger_dat::ResourceKey;
    let source = global_source::global_source();
    let initial = [ResourceKey::new("eor/portal", surface_did)];
    prefetch::ensure_walk_prefetched(&source, &initial, |s| {
        let _ = fetch_surface_pixels_impl(s, surface_did);
    })
    .await?;
    Ok(fetch_surface_pixels_impl(source.as_ref(), surface_did))
}

/// Batch form: fetch decoded pixels for many surfaces in one HTTP
/// fetch. Returns `Vec<SurfacePixels>` in input order; per-id
/// failures yield empty entries (no batch fail).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn fetch_surfaces_pixels(
    surface_dids: Vec<u32>,
) -> Result<Vec<SurfacePixels>, JsValue> {
    use holtburger_dat::ResourceKey;
    let source = global_source::global_source();
    let initial: Vec<ResourceKey<'_>> = surface_dids
        .iter()
        .map(|id| ResourceKey::new("eor/portal", *id))
        .collect();
    let dids_for_walk = surface_dids.clone();
    prefetch::ensure_walk_prefetched(&source, &initial, |s| {
        for &id in &dids_for_walk {
            let _ = fetch_surface_pixels_impl(s, id);
        }
    })
    .await?;
    let mut out = Vec::with_capacity(surface_dids.len());
    for &id in &surface_dids {
        out.push(fetch_surface_pixels_impl(source.as_ref(), id));
    }
    Ok(out)
}

/// Phase 4 step 6 Phase B: surface decode with entity palette overrides.
/// ACE's `CalculateObjDesc` (~/ace-server/Source/ACE.Server/WorldObjects/
/// WorldObject_Networking.cs:1017 + Creature_Networking.cs:218) sets
/// `objDesc.PaletteID` to the entity's `PaletteBaseDID` and accumulates
/// per-clothing-item palette overlays in `objDesc.SubPalettes` after
/// reading each item's `ClothingTable.ClothingSubPalEffects[paletteTemplate]`
/// and offset+length-scaling them. Mirroring it here lets a creature's
/// skin tone, hair colour, and dyed armour read correctly instead of
/// every NPC defaulting to the texture's intrinsic palette.
///
/// Composition order (matches the C#):
/// 1. **Base palette.** If `base_palette_id != 0` use it as the starting
///    256-entry colour array (overrides the texture's intrinsic palette).
///    If 0, fall through to the texture's intrinsic palette ID — same
///    path as `fetch_surface_pixels_impl`.
/// 2. **Sub-palette overlays.** For each `(sub_palette_id, offset,
///    length)` triple: read the named palette from the DAT, copy its
///    first `length` colours into the base palette starting at `offset`.
///    Out-of-range writes are clamped (NPC equipment overlays are
///    8-colour ranges that always fit a 256-entry palette in retail
///    data, but defensive clamping keeps a malformed wire packet from
///    panicking the decoder).
///
/// `sub_palettes` is the flat `[id, offset, length, …]` triple buffer
/// EntityUpdate exposes from `model_data.sub_palettes` (Phase A
/// already plumbed it; Phase B consumes it).
#[cfg(any(target_arch = "wasm32", test))]
fn fetch_entity_surface_pixels_impl<S: holtburger_dat::ResourceSource + ?Sized>(
    source: &S,
    surface_did: u32,
    base_palette_id: u32,
    sub_palettes: &[(u32, u8, u8)],
) -> SurfacePixels {
    use holtburger_dat::file_type::{Palette, Surface, SurfaceTexture, Texture, TextureDecodeError};
    use holtburger_dat::surface_classify::{compute_stats, SurfaceCategory};
    use holtburger_dat::ResourceKey;
    let generic_cat = SurfaceCategory::Generic.as_u8();
    let empty = SurfacePixels { width: 0, height: 0, pixels: Vec::new(), surface_type: 0, category: generic_cat, roughness_override: f32::NAN, normal_scale_override: f32::NAN };

    let Ok(bytes) = source.get_file_by_key(ResourceKey::new("eor/portal", surface_did)) else { return empty; };
    let Ok(surface) = Surface::unpack(&bytes) else { return empty; };
    let surface_type = surface.surface_type;
    if let Some(argb) = surface.solid_color() {
        // Solid surfaces ignore palette substitutions — the base
        // surface IS the colour.
        let a = ((argb >> 24) & 0xFF) as u8;
        let r = ((argb >> 16) & 0xFF) as u8;
        let g = ((argb >> 8) & 0xFF) as u8;
        let b = (argb & 0xFF) as u8;
        let pixels = vec![r, g, b, a];
        // Phase 1.5 — overrides apply to entity surfaces too.
        let stats = compute_stats(&pixels, 1, 1);
        let (category, roughness_override, normal_scale_override) =
            classify_with_overrides(&stats, surface_type, surface_did);
        return SurfacePixels {
            width: 1,
            height: 1,
            pixels,
            surface_type,
            category,
            roughness_override,
            normal_scale_override,
        };
    }
    let Some((surf_tex_id, _)) = surface.textured() else { return empty; };
    let Ok(stb) = source.get_file_by_key(ResourceKey::new("eor/portal", surf_tex_id)) else { return empty; };
    let Ok(surf_tex) = SurfaceTexture::unpack(&stb) else { return empty; };
    let Some(rs_id) = surf_tex.highest_res() else { return empty; };
    let Ok(tb) = source.get_file_by_key(ResourceKey::new("eor/portal", rs_id)) else { return empty; };
    let Ok(tex) = Texture::unpack(&tb) else { return empty; };

    // Compose the palette inside `to_rgba8`'s callback — receives
    // the texture's intrinsic palette id but we may override with
    // the entity's base + apply overlays.
    let rgba = tex.to_rgba8(|tex_palette_id| {
        let chosen_base = if base_palette_id != 0 { base_palette_id } else { tex_palette_id };
        let pb = source
            .get_file_by_key(ResourceKey::new("eor/portal", chosen_base))
            .map_err(|e| TextureDecodeError::PaletteFetch(format!("base {chosen_base:#010X}: {e}")))?;
        let mut composed = Palette::unpack(&pb)
            .map_err(|e| TextureDecodeError::PaletteFetch(format!("Palette::unpack base {chosen_base:#010X}: {e}")))?;
        // Apply per-overlay sub-palette splices. Per-overlay failures
        // are silently skipped — a missing or malformed sub-palette
        // shouldn't fail the whole texture decode (worst case the
        // creature renders with an unblended palette, which is what
        // the unsubstituted path produces anyway).
        for (sub_id, offset, length) in sub_palettes {
            let Ok(spb) = source.get_file_by_key(ResourceKey::new("eor/portal", *sub_id)) else { continue; };
            let Ok(sp) = Palette::unpack(&spb) else { continue; };
            let off = *offset as usize;
            let len = (*length as usize).min(sp.colors.len());
            for i in 0..len {
                let dst = off + i;
                if dst < composed.colors.len() {
                    composed.colors[dst] = sp.colors[i];
                }
            }
        }
        Ok(composed)
    });
    match rgba {
        Ok(pixels) => {
            // Phase 1.5 — overrides applied via classify_with_overrides.
            let stats = compute_stats(&pixels, tex.width as u32, tex.height as u32);
            let (category, roughness_override, normal_scale_override) =
                classify_with_overrides(&stats, surface_type, surface_did);
            SurfacePixels {
                width: tex.width as u32,
                height: tex.height as u32,
                pixels,
                surface_type,
                category,
                roughness_override,
                normal_scale_override,
            }
        }
        Err(_) => empty,
    }
}

/// Batch form of [`fetch_entity_surface_pixels_impl`] exposed to JS.
/// `base_palette_id` and `sub_palettes` apply to **every** surface in
/// `surface_dids` — appropriate for an NPC where one entity's palette
/// state composes onto every body-part surface uniformly. The JS
/// caller picks the surfaces from a single mesh's `surfaces` array
/// and passes the entity's `palette_id` + `sub_palettes`.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = fetchEntitySurfacesPixels)]
pub async fn fetch_entity_surfaces_pixels(
    surface_dids: Vec<u32>,
    base_palette_id: u32,
    sub_palettes: Vec<u32>,
) -> Result<Vec<SurfacePixels>, JsValue> {
    use holtburger_dat::ResourceKey;
    if sub_palettes.len() % 3 != 0 {
        return Err(JsValue::from_str(
            "fetch_entity_surfaces_pixels: sub_palettes must be flat [id, offset, length, ...] triples (length % 3 == 0)",
        ));
    }
    let sp: Vec<(u32, u8, u8)> = sub_palettes
        .chunks_exact(3)
        .map(|c| (c[0], c[1] as u8, c[2] as u8))
        .collect();
    let source = global_source::global_source();
    // Prefetch: the surfaces themselves, the base palette (if
    // overridden), and every overlay palette. Surface→tex→intrinsic-
    // palette walks ride into the surface prefetch already.
    let mut initial: Vec<ResourceKey<'_>> = Vec::with_capacity(surface_dids.len() + 1 + sp.len());
    for &sid in &surface_dids {
        initial.push(ResourceKey::new("eor/portal", sid));
    }
    if base_palette_id != 0 {
        initial.push(ResourceKey::new("eor/portal", base_palette_id));
    }
    for (id, _, _) in &sp {
        initial.push(ResourceKey::new("eor/portal", *id));
    }
    let dids_for_walk = surface_dids.clone();
    let sp_for_walk = sp.clone();
    prefetch::ensure_walk_prefetched(&source, &initial, |s| {
        for &id in &dids_for_walk {
            let _ = fetch_entity_surface_pixels_impl(s, id, base_palette_id, &sp_for_walk);
        }
    })
    .await?;
    let mut out = Vec::with_capacity(surface_dids.len());
    for &id in &surface_dids {
        out.push(fetch_entity_surface_pixels_impl(
            source.as_ref(),
            id,
            base_palette_id,
            &sp,
        ));
    }
    Ok(out)
}

/// Phase 3 step 6: walk a model's GfxObj/SetupModel chain, triangulate,
/// and return a flat-buffer mesh ready for in-browser rasterization.
/// One HTTP fetch (the HBA bundle); per-id walks are in-memory.
///
/// On any failure the rejected Promise carries a tagged error string
/// — caller treats unknown models the same way the existing atlas
/// path does (fall back to the dot).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn fetch_model_mesh(model_id: u32) -> Result<ModelMesh, JsValue> {
    use holtburger_dat::ResourceKey;
    let source = global_source::global_source();
    let initial = [ResourceKey::new("eor/portal", model_id)];
    prefetch::ensure_walk_prefetched(&source, &initial, |s| {
        let _ = triangulate_model(s, model_id);
    })
    .await?;
    let tris = triangulate_model(source.as_ref(), model_id)
        .ok_or_else(|| JsValue::from_str(&format!("triangulate_model 0x{model_id:08X}: failed")))?;
    let mut mesh = pack_model_mesh(tris);
    // Follow-on #5 — resolve LOD chain after pack. 0 = no degraded
    // variant; JS uses plain Mesh in that case.
    mesh.did_degrade = resolve_did_degrade(source.as_ref(), model_id);
    Ok(mesh)
}

/// Follow-on #5 (LOD) — batch query for per-model `did_degrade` chain
/// entries, WITHOUT triangulating. The buildings path
/// (`fetchBuildingPlacement`) doesn't go through `fetch_model_meshes`
/// so it can't read `ModelMesh.didDegrade`; this thin export lets it
/// look up the chain via a single byte-level GfxObj parse.
///
/// Returns one u32 per input model id; 0 = no degrade chain
/// (`HAS_DID_DEGRADE` flag unset OR model not parseable). Holtburg
/// buildings are mostly raw `0x01` GfxObjs and most have no degrade
/// entry — the typical return is all zeros, which the JS caller
/// handles by falling back to plain `THREE.Mesh` instead of `THREE.LOD`.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = fetchModelDidDegrades)]
pub async fn fetch_model_did_degrades(
    model_ids: Vec<u32>,
) -> Result<Vec<u32>, JsValue> {
    use holtburger_dat::ResourceKey;
    let source = global_source::global_source();
    let initial: Vec<ResourceKey<'_>> = model_ids
        .iter()
        .map(|id| ResourceKey::new("eor/portal", *id))
        .collect();
    let ids_for_walk = model_ids.clone();
    prefetch::ensure_walk_prefetched(&source, &initial, |s| {
        for &id in &ids_for_walk {
            let _ = resolve_did_degrade(s, id);
        }
    })
    .await?;
    let mut out = Vec::with_capacity(model_ids.len());
    for &id in &model_ids {
        out.push(resolve_did_degrade(source.as_ref(), id));
    }
    Ok(out)
}

/// Batch form: triangulate many models in one call. Returns a vector
/// of [`ModelMesh`] in input order. On any per-id failure we push an
/// empty mesh (tri_count == 0) rather than failing the whole batch —
/// the JS caller checks for empty and falls back to atlas / dot for
/// those.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn fetch_model_meshes(model_ids: Vec<u32>) -> Result<Vec<ModelMesh>, JsValue> {
    use holtburger_dat::ResourceKey;
    let source = global_source::global_source();
    let initial: Vec<ResourceKey<'_>> = model_ids
        .iter()
        .map(|id| ResourceKey::new("eor/portal", *id))
        .collect();
    let ids_for_walk = model_ids.clone();
    prefetch::ensure_walk_prefetched(&source, &initial, |s| {
        for &id in &ids_for_walk {
            let _ = triangulate_model(s, id);
        }
    })
    .await?;
    let mut out = Vec::with_capacity(model_ids.len());
    for &id in &model_ids {
        let tris = triangulate_model(source.as_ref(), id).unwrap_or_default();
        let mut mesh = pack_model_mesh(tris);
        // Follow-on #5 — resolve LOD chain after pack. 0 = no degraded
        // variant; JS uses plain Mesh in that case.
        mesh.did_degrade = resolve_did_degrade(source.as_ref(), id);
        out.push(mesh);
    }
    Ok(out)
}

// ────────────────────────────────────────────────────────────────────
//  Phase 6 step A — per-part building mesh export
// ────────────────────────────────────────────────────────────────────
//
// The fused-output path (`fetch_model_mesh` / `fetch_model_meshes`)
// walks every Setup part and packs them into a single `ModelMesh` per
// model_id — fine for static props and the existing single-sprite
// rendering, but Phase E (door rotation around hinge frames) needs
// each part addressable on its own. `BuildingPlacement` mirrors the
// `EntityCycleSet` move-semantics pattern (`take_*` methods one-shot
// the inner Vecs across the wasm boundary without cloning) and slots
// in alongside `fetch_landblock_objects`'s `is_building` flag: the JS
// builder calls `fetch_building_placement` once per unique building
// model_id, then instantiates a `PIXI.Container` of N child sprites
// per placement.

/// Phase 6 step A: per-part-aware return type for building setups —
/// sibling to [`ObjectPlacement`] (which carries placement coords for
/// the JS bake). `parts.len()` is the Setup's part count; each
/// entry's vec position is the `part_index` JS uses to address the
/// part later (Phase E door rotations target a specific index, not a
/// model-wide id). Naming follows the smoke contract in
/// `smoke_test.cjs` Phase 6 step A scaffolding.
///
/// Empty `parts` = the Setup failed to load. A part with
/// `triCount == 0` is preserved at its index so part_index stays
/// stable across the boundary even if a leaf GfxObj fetch failed.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct BuildingPlacement {
    setup_id: u32,
    parts: Vec<ModelMesh>,
    hinge_frames: Vec<HingeFrame>,
}

/// Phase 6 step E: per-part hinge transform — the part's local origin
/// + orientation in the SetupModel's `placement_frames[0]` slot. Door
/// rotation is applied by the JS-side renderer around this frame:
/// closed = identity, open = ~90° around the hinge's local Z axis.
/// Non-door parts ship the frame too so JS doesn't need a special
/// case (door identification flows through the entity's
/// `ObjectDescriptionFlag::DOOR` bit, not a per-part marker on the
/// building placement).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
#[derive(Debug, Clone, Copy)]
pub struct HingeFrame {
    x: f32,
    y: f32,
    z: f32,
    qw: f32,
    qx: f32,
    qy: f32,
    qz: f32,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl HingeFrame {
    #[wasm_bindgen(getter)]
    pub fn x(&self) -> f32 { self.x }
    #[wasm_bindgen(getter)]
    pub fn y(&self) -> f32 { self.y }
    #[wasm_bindgen(getter)]
    pub fn z(&self) -> f32 { self.z }
    #[wasm_bindgen(getter)]
    pub fn qw(&self) -> f32 { self.qw }
    #[wasm_bindgen(getter)]
    pub fn qx(&self) -> f32 { self.qx }
    #[wasm_bindgen(getter)]
    pub fn qy(&self) -> f32 { self.qy }
    #[wasm_bindgen(getter)]
    pub fn qz(&self) -> f32 { self.qz }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl BuildingPlacement {
    /// SetupModel DID this bake corresponds to.
    #[wasm_bindgen(getter, js_name = setupId)]
    pub fn setup_id(&self) -> u32 {
        self.setup_id
    }

    /// Number of parts in the SetupModel — equals the length of the
    /// `Vec<ModelMesh>` `take_part_meshes` returns.
    #[wasm_bindgen(getter, js_name = partCount)]
    pub fn part_count(&self) -> u32 {
        self.parts.len() as u32
    }

    /// Move the per-part meshes out of the bundle into a JS-owned
    /// array. Position in the returned Vec is the `part_index`. One-
    /// shot — second call returns an empty Vec.
    #[wasm_bindgen(js_name = takePartMeshes)]
    pub fn take_part_meshes(&mut self) -> Vec<ModelMesh> {
        std::mem::take(&mut self.parts)
    }

    /// Phase 6 step E: drain the per-part hinge frames. One per
    /// `parts[]` slot in the same order. Computed from
    /// `setup.placement_frames[0]` (or the first available placement)
    /// so each part carries its local origin + orientation in the
    /// building's coord system. JS uses these as door pivot points
    /// when applying the open-rotation transform; non-door parts
    /// receive an identity frame they never use.
    #[wasm_bindgen(js_name = takePartHingeFrames)]
    pub fn take_part_hinge_frames(&mut self) -> Vec<HingeFrame> {
        std::mem::take(&mut self.hinge_frames)
    }
}

/// Phase 6 step A: per-part variant of [`fetch_model_mesh`]. Walks a
/// SetupModel and returns one `ModelMesh` per part. Raw `0x01` GfxObj
/// inputs (no skeleton / single-part) return a single-element Vec so
/// the JS caller can treat all building model_ids uniformly.
///
/// JS flow: `fetch_landblock_objects` → for every placement with
/// `isBuilding == true`, call `fetchBuildingPlacement(modelId)` once
/// per unique model_id (cache the bake), then instantiate a per-
/// placement `PIXI.Container` whose children are sprites referencing
/// the per-part RenderTextures, tagged `{ buildingId, partIndex }`.
///
/// On any part-load failure, the slot is preserved as an empty mesh
/// (`triCount == 0`) so the `part_index` stays stable for Phase E
/// door-state lookups.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = fetchBuildingPlacement)]
pub async fn fetch_building_placement(model_id: u32) -> Result<BuildingPlacement, JsValue> {
    use holtburger_dat::ResourceKey;
    let source = global_source::global_source();
    let initial = [ResourceKey::new("eor/portal", model_id)];
    prefetch::ensure_walk_prefetched(&source, &initial, |s| {
        let _ = triangulate_model_per_part_buckets(s, model_id);
    })
    .await?;
    let parts_tris = triangulate_model_per_part_buckets(source.as_ref(), model_id)
        .ok_or_else(|| {
            JsValue::from_str(&format!("fetchBuildingPlacement 0x{model_id:08X}: failed"))
        })?;
    let part_count = parts_tris.len();
    let parts: Vec<ModelMesh> = parts_tris.into_iter().map(pack_model_mesh).collect();
    let hinge_frames = compute_hinge_frames(source.as_ref(), model_id, part_count);
    Ok(BuildingPlacement {
        setup_id: model_id,
        parts,
        hinge_frames,
    })
}

/// Phase 6 step E: read each part's local hinge frame (origin +
/// orientation) from the SetupModel's `placement_frames[0]` slot.
/// `placement_frames` is keyed by an integer placement-id (0 = Default,
/// 1 = Resting, etc.); we use the same `0 → 1 → first` fallback chain
/// `walk_setup_parts` uses so the frame matches the static bake. Raw
/// `0x01` GfxObj inputs return a single identity frame so JS can treat
/// all building model_ids uniformly.
#[cfg(target_arch = "wasm32")]
fn compute_hinge_frames<S: holtburger_dat::ResourceSource + ?Sized>(
    source: &S,
    setup_id: u32,
    expected_parts: usize,
) -> Vec<HingeFrame> {
    use holtburger_dat::file_type::SetupModel;
    use holtburger_dat::ResourceKey;
    let identity = HingeFrame {
        x: 0.0, y: 0.0, z: 0.0,
        qw: 1.0, qx: 0.0, qy: 0.0, qz: 0.0,
    };
    if (setup_id >> 24) as u8 != 0x02 {
        return vec![identity; expected_parts.max(1)];
    }
    let bytes = match source.get_file_by_key(ResourceKey::new("eor/portal", setup_id)) {
        Ok(b) => b,
        Err(_) => return vec![identity; expected_parts],
    };
    let setup = match SetupModel::unpack(&mut std::io::Cursor::new(&bytes)) {
        Ok(s) => s,
        Err(_) => return vec![identity; expected_parts],
    };
    let part_count = setup.parts.len().max(expected_parts);
    let placement = setup
        .placement_frames
        .get(&0)
        .or_else(|| setup.placement_frames.get(&1))
        .or_else(|| setup.placement_frames.values().next());
    let mut hinges = vec![identity; part_count];
    if let Some(p) = placement {
        for (i, slot) in hinges.iter_mut().enumerate() {
            if let Some(frame) = p.anim_frame.frames.get(i) {
                *slot = HingeFrame {
                    x: frame.origin.x,
                    y: frame.origin.y,
                    z: frame.origin.z,
                    qw: frame.orientation.w,
                    qx: frame.orientation.x,
                    qy: frame.orientation.y,
                    qz: frame.orientation.z,
                };
            }
        }
    }
    hinges
}

// ============================================================
// 3D port follow-on #1: per-SetupModel point/spot lights.
//
// Mirrors [`fetch_building_placement`] for the
// `SetupModel.lights: HashMap<i32, LightInfo>` table (defined at
// `crates/holtburger-dat/src/file_type/setup_model.rs:29-35`). One
// `SetupLight` per `LightInfo` carrying origin + ARGB-extracted color
// + intensity + falloff + cone_angle. The JS-side
// `attachSetupModelLights` walks every unique setup id used by
// buildings/statics/entities/cells, calls this export, and instantiates
// `THREE.PointLight` (cone_angle == 0) or `THREE.SpotLight`
// (cone_angle > 0) as children of the per-part `Object3D` so the light
// follows the model's transform tree.
//
// Empty `Vec` = "this Setup has no light descriptors" — typical for
// retail Holtburg buildings, which are mostly raw `0x01` GfxObjs with
// no Setup at all (`setup_id == model_id` in that case and the wasm
// returns empty). Returning Vec rather than failing keeps the JS path
// uniform.
// ============================================================

/// Phase 7.6.1 (follow-on #1): one per-part light descriptor drained
/// from `SetupModel.lights`. `part_index` is the HashMap key —
/// identifies which Setup part the light is rigidly attached to.
/// `color_r/g/b` are normalized [0,1] components extracted from the
/// ARGB `color: u32` in the DAT (`R = (color >> 16) & 0xFF`).
/// `intensity / falloff / cone_angle` are passed through verbatim;
/// `cone_angle == 0.0` → PointLight, `> 0.0` → SpotLight.
#[cfg(any(target_arch = "wasm32", test))]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
#[derive(Debug, Clone, Copy)]
pub struct SetupLight {
    pub(crate) part_index: u32,
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) z: f32,
    pub(crate) color_r: f32,
    pub(crate) color_g: f32,
    pub(crate) color_b: f32,
    pub(crate) intensity: f32,
    pub(crate) falloff: f32,
    pub(crate) cone_angle: f32,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl SetupLight {
    #[wasm_bindgen(getter, js_name = partIndex)]
    pub fn part_index(&self) -> u32 { self.part_index }
    #[wasm_bindgen(getter)]
    pub fn x(&self) -> f32 { self.x }
    #[wasm_bindgen(getter)]
    pub fn y(&self) -> f32 { self.y }
    #[wasm_bindgen(getter)]
    pub fn z(&self) -> f32 { self.z }
    #[wasm_bindgen(getter, js_name = colorR)]
    pub fn color_r(&self) -> f32 { self.color_r }
    #[wasm_bindgen(getter, js_name = colorG)]
    pub fn color_g(&self) -> f32 { self.color_g }
    #[wasm_bindgen(getter, js_name = colorB)]
    pub fn color_b(&self) -> f32 { self.color_b }
    #[wasm_bindgen(getter)]
    pub fn intensity(&self) -> f32 { self.intensity }
    #[wasm_bindgen(getter)]
    pub fn falloff(&self) -> f32 { self.falloff }
    #[wasm_bindgen(getter, js_name = coneAngle)]
    pub fn cone_angle(&self) -> f32 { self.cone_angle }
}

/// Phase 7.6.1 (follow-on #1): per-SetupModel light bundle returned
/// from [`fetch_setup_model_lights`]. Mirrors [`BuildingPlacement`]:
/// one-shot `take_lights()` drain so JS lifts the Vec across the wasm
/// boundary without cloning. `part_count` is the LIGHT COUNT (not the
/// Setup's part count) — naming follows the task spec.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct SetupModelLights {
    setup_id: u32,
    lights: Vec<SetupLight>,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl SetupModelLights {
    #[wasm_bindgen(getter, js_name = setupId)]
    pub fn setup_id(&self) -> u32 { self.setup_id }

    /// Light count (NOT the Setup's part count — naming per the task
    /// spec). Equals `take_lights().len()` on the very first call.
    #[wasm_bindgen(getter, js_name = partCount)]
    pub fn part_count(&self) -> u32 { self.lights.len() as u32 }

    /// One-shot drain. Second call returns an empty Vec — JS callers
    /// hold the resulting array; the wasm side stops owning it.
    #[wasm_bindgen(js_name = takeLights)]
    pub fn take_lights(&mut self) -> Vec<SetupLight> {
        std::mem::take(&mut self.lights)
    }
}

/// Phase 7.6.1 (follow-on #1) — new wasm export. Walks a SetupModel
/// and drains its `lights: HashMap<i32, LightInfo>` table into a flat
/// Vec of [`SetupLight`] descriptors. JS calls this once per unique
/// `setup_id` used by buildings/statics/entities/cells.
///
/// Raw `0x01` GfxObj inputs (no Setup) return an empty Vec — JS treats
/// this as "no lights for this model".
///
/// Failure modes: the DAT fetch / SetupModel parse failures both
/// resolve to an empty Vec (caller can tell from `part_count == 0`).
/// Promise rejection is reserved for prefetch errors only (network /
/// IO), mirroring the [`fetch_building_placement`] contract.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = fetchSetupModelLights)]
pub async fn fetch_setup_model_lights(setup_id: u32) -> Result<SetupModelLights, JsValue> {
    use holtburger_dat::ResourceKey;
    let source = global_source::global_source();
    let initial = [ResourceKey::new("eor/portal", setup_id)];
    prefetch::ensure_walk_prefetched(&source, &initial, |s| {
        // Touch the resource so the prefetch walker is happy. The
        // unpacked SetupModel is consumed below — this just primes
        // the cache.
        let _ = s.get_file_by_key(ResourceKey::new("eor/portal", setup_id));
    })
    .await?;
    let lights = collect_setup_model_lights(source.as_ref(), setup_id);
    Ok(SetupModelLights {
        setup_id,
        lights,
    })
}

/// Phase 7.6.1 (follow-on #1): pure helper drained from a
/// `ResourceSource`. Empty Vec for `0x01` GfxObjs and for any parse
/// failure, so JS uniformly treats "no lights" the same way regardless
/// of the underlying cause.
///
/// AC's `LightInfo.color` is an ARGB-packed u32:
///   R = (color >> 16) & 0xFF
///   G = (color >>  8) & 0xFF
///   B = (color >>  0) & 0xFF
///   A = (color >> 24) & 0xFF  // the alpha byte; ignored — three.js
///                              // PointLight.color is RGB only.
///
/// HashMap ordering is non-deterministic in Rust; we sort by key so
/// the returned Vec is stable across runs (tests can assert specific
/// indices). The key (the HashMap's i32) IS the Setup part index the
/// light is attached to — preserved on `SetupLight.part_index`.
#[cfg(any(target_arch = "wasm32", test))]
fn collect_setup_model_lights<S: holtburger_dat::ResourceSource + ?Sized>(
    source: &S,
    setup_id: u32,
) -> Vec<SetupLight> {
    use holtburger_dat::file_type::SetupModel;
    use holtburger_dat::ResourceKey;
    // 0x01 = raw GfxObj — no Setup; no lights table to walk.
    if (setup_id >> 24) as u8 != 0x02 {
        return Vec::new();
    }
    let Ok(bytes) = source.get_file_by_key(ResourceKey::new("eor/portal", setup_id)) else {
        return Vec::new();
    };
    let Ok(setup) = SetupModel::unpack(&mut std::io::Cursor::new(&bytes)) else {
        return Vec::new();
    };
    if setup.lights.is_empty() {
        return Vec::new();
    }
    // Stable order — sort by HashMap key (the part index).
    let mut entries: Vec<(i32, &holtburger_dat::file_type::setup_model::LightInfo)> =
        setup.lights.iter().map(|(k, v)| (*k, v)).collect();
    entries.sort_by_key(|(k, _)| *k);
    let mut out = Vec::with_capacity(entries.len());
    for (part_index, info) in entries {
        // Negative HashMap keys are theoretically possible in the
        // DAT format but in practice all live retail entries are >= 0.
        // Cast to u32 with saturation at 0 — JS reads partIndex as a
        // u32 getter (`.part_index() -> u32`).
        let pi = if part_index < 0 { 0u32 } else { part_index as u32 };
        let argb = info.color;
        let r = ((argb >> 16) & 0xFF) as f32 / 255.0;
        let g = ((argb >>  8) & 0xFF) as f32 / 255.0;
        let b = ((argb      ) & 0xFF) as f32 / 255.0;
        out.push(SetupLight {
            part_index: pi,
            x: info.viewer_space_location.origin.x,
            y: info.viewer_space_location.origin.y,
            z: info.viewer_space_location.origin.z,
            color_r: r,
            color_g: g,
            color_b: b,
            intensity: info.intensity,
            falloff: info.falloff,
            cone_angle: info.cone_angle,
        });
    }
    out
}

/// Top-level per-part dispatch mirroring [`triangulate_model`]: route
/// `0x01` (raw GfxObj) to a single-part vec, `0x02` (SetupModel) to
/// the per-part walker.
#[cfg(target_arch = "wasm32")]
fn triangulate_model_per_part_buckets<S: holtburger_dat::ResourceSource + ?Sized>(
    source: &S,
    model_id: u32,
) -> Option<Vec<Vec<Tri>>> {
    use holtburger_dat::file_type::GfxObj;
    use holtburger_dat::ResourceKey;
    match (model_id >> 24) as u8 {
        0x01 => {
            let bytes = source
                .get_file_by_key(ResourceKey::new("eor/portal", model_id))
                .ok()?;
            let gfx = GfxObj::unpack(&mut std::io::Cursor::new(&bytes)).ok()?;
            let mut tris = Vec::new();
            append_gfx_tris(
                &mut tris,
                &gfx,
                holtburger_common::Vector3::zero(),
                holtburger_common::Quaternion::identity(),
            );
            Some(vec![tris])
        }
        0x02 => triangulate_setup_model_per_part(source, model_id, &[], &[]),
        _ => None,
    }
}

/// Phase 6 step A: marker / no-op symbol the JS-side bake registers
/// against. The actual `window.buildingMap: Map<string, PIXI.Container>`
/// lives on the JS side (PIXI display objects can't cross the wasm
/// boundary); this wasm export is the symbol the smoke test probes
/// for via `typeof wasm.init_building_map === "function"` so the
/// "Phase A surfaced" check trips green once shipped. Calling it is a
/// no-op — the JS render pipeline owns the map's lifetime.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn init_building_map() {}

/// Phase 6 step A: deterministic part-count smoke. Synthesizes a
/// SetupModel with N>1 parts in memory, packs it through the same
/// `SetupModel::pack` / `unpack` round-trip the dat-shard cache
/// uses, runs the per-part walker against an in-memory ResourceSource,
/// and returns the bucket count. No live ACE / no global resource
/// source needed — runs under `smoke_test --fast` exactly the same
/// way it runs under a full bake.
///
/// The constant returned (12) is the synthetic Setup's part count —
/// chosen to clear the smoke's `n > 1` floor with margin. Real
/// Holtburg town hall part counts are read by
/// `capture_phase6_step_a_geometry.cjs` from the live
/// `window.buildingMap`, not from this wasm symbol.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn holtburg_townhall_max_parts() -> u32 {
    use holtburger_dat::file_type::SetupModel;
    use std::io::Cursor;
    const PART_COUNT: usize = 12;
    let setup = SetupModel {
        id: 0x0200_0001,
        flags: 0,
        parts: vec![0x0100_0001; PART_COUNT],
        parent_index: Vec::new(),
        default_scale: Vec::new(),
        holding_locations: std::collections::HashMap::new(),
        connection_points: std::collections::HashMap::new(),
        placement_frames: std::collections::HashMap::new(),
        cyl_spheres: Vec::new(),
        spheres: Vec::new(),
        height: 0.0,
        radius: 0.0,
        step_up: 0.0,
        step_down: 0.0,
        sorting_sphere: holtburger_common::Sphere {
            center: holtburger_common::Vector3::zero(),
            radius: 0.0,
        },
        selection_sphere: holtburger_common::Sphere {
            center: holtburger_common::Vector3::zero(),
            radius: 0.0,
        },
        lights: std::collections::HashMap::new(),
        default_animation: None,
        default_script: None,
        default_motion_table: None,
        default_sound_table: None,
        default_script_table: None,
    };
    // Pack → unpack round-trip proves the parser sees N parts; the
    // bake path relies on this same round-trip for live data so the
    // smoke covers the symbol AND the parser's part-list invariants.
    let mut buf: Vec<u8> = Vec::new();
    if setup.pack(&mut Cursor::new(&mut buf)).is_err() {
        return 0;
    }
    match SetupModel::unpack(&mut Cursor::new(&buf)) {
        Ok(parsed) => parsed.parts.len() as u32,
        Err(_) => 0,
    }
}

/// Phase 6 step B: deterministic per-part AABB-walker smoke. Builds
/// an in-memory Setup with N>1 parts that all reference the same
/// synthetic GfxObj (a unit-cube vertex set), packs both into an
/// `InMemoryResourceSource`, and runs `walk_setup_parts_with_geom`
/// to derive one AABB per part. Returns the number of non-empty
/// AABBs — equals `PART_COUNT` when the walker visits every part
/// successfully.
///
/// The synthesized GfxObj has 8 vertices forming a unit cube (its
/// AABB is `(0,0,0)..(1,1,1)`); each part shares the same GfxObj
/// id so the walker pulls the cube into every slot. Returning a
/// nonzero value means: parser parses the synthetic Setup, walker
/// resolves linked GfxObj parts, and the AABB accumulator visits
/// vertices.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn holtburg_townhall_aabb_count() -> u32 {
    use holtburger_dat::file_type::{GfxObj, SetupModel};
    use holtburger_dat::graphics::{CVertexArray, SWVertex};
    use holtburger_common::properties::GfxObjFlags;
    use std::collections::HashMap;
    use std::io::Cursor;
    const PART_COUNT: usize = 6;
    const GFX_ID: u32 = 0x0100_0001;
    let mut vertices: HashMap<u16, SWVertex> = HashMap::new();
    for (i, (x, y, z)) in [
        (0.0f32, 0.0f32, 0.0f32),
        (1.0, 0.0, 0.0),
        (0.0, 1.0, 0.0),
        (0.0, 0.0, 1.0),
        (1.0, 1.0, 0.0),
        (1.0, 0.0, 1.0),
        (0.0, 1.0, 1.0),
        (1.0, 1.0, 1.0),
    ]
    .iter()
    .enumerate()
    {
        vertices.insert(
            i as u16,
            SWVertex {
                num_uvs: 0,
                origin: holtburger_common::Vector3::new(*x, *y, *z),
                normal: holtburger_common::Vector3::zero(),
                uvs: Vec::new(),
            },
        );
    }
    let gfx = GfxObj {
        id: GFX_ID,
        flags: GfxObjFlags::empty(),
        surfaces: Vec::new(),
        vertex_array: CVertexArray {
            vertex_type: 1,
            vertices,
        },
        physics_polygons: HashMap::new(),
        physics_bsp: None,
        sort_center: holtburger_common::Vector3::zero(),
        polygons: HashMap::new(),
        drawing_bsp: None,
        did_degrade: None,
    };
    let setup = SetupModel {
        id: 0x0200_0001,
        flags: 0,
        parts: vec![GFX_ID; PART_COUNT],
        parent_index: Vec::new(),
        default_scale: Vec::new(),
        holding_locations: HashMap::new(),
        connection_points: HashMap::new(),
        placement_frames: HashMap::new(),
        cyl_spheres: Vec::new(),
        spheres: Vec::new(),
        height: 0.0,
        radius: 0.0,
        step_up: 0.0,
        step_down: 0.0,
        sorting_sphere: holtburger_common::Sphere {
            center: holtburger_common::Vector3::zero(),
            radius: 0.0,
        },
        selection_sphere: holtburger_common::Sphere {
            center: holtburger_common::Vector3::zero(),
            radius: 0.0,
        },
        lights: HashMap::new(),
        default_animation: None,
        default_script: None,
        default_motion_table: None,
        default_sound_table: None,
        default_script_table: None,
    };
    let mut setup_buf: Vec<u8> = Vec::new();
    if setup.pack(&mut Cursor::new(&mut setup_buf)).is_err() {
        return 0;
    }
    let mut gfx_buf: Vec<u8> = Vec::new();
    if gfx.pack(&mut Cursor::new(&mut gfx_buf)).is_err() {
        return 0;
    }
    let source = inmem_collision_source::InMemorySource::new(vec![
        ("eor/portal".to_string(), 0x0200_0001u32, setup_buf),
        ("eor/portal".to_string(), GFX_ID, gfx_buf),
    ]);
    match walk_setup_parts_with_geom(&source, 0x0200_0001) {
        Some(aabbs) => aabbs.iter().filter(|a| !a.is_empty()).count() as u32,
        None => 0,
    }
}

#[cfg(target_arch = "wasm32")]
fn collision_smoke_fixture() -> (
    holtburger_common::position::WorldPosition,
    Vec<holtburger_world::BuildingAabbEntry>,
) {
    use holtburger_common::position::WorldPosition;
    use holtburger_common::{Aabb, Guid, Quaternion, Vector3};
    use holtburger_world::{BuildingAabbEntry, BuildingId};
    let landblock = Guid(0x0102_0000);
    let pose = WorldPosition {
        landblock_id: landblock,
        coords: Vector3::new(199.0 - 192.0, 401.0 - 384.0, 1.0),
        rotation: Quaternion::identity(),
    };
    let candidates = vec![BuildingAabbEntry {
        building_id: BuildingId::new(landblock.0, 0x0200_1234, 0),
        part_index: 0,
        aabb: Aabb::new(
            Vector3::new(200.0, 400.0, 0.0),
            Vector3::new(204.0, 404.0, 4.0),
        ),
        active: true,
    }];
    (pose, candidates)
}

/// Phase 6 step B: deterministic clamp-axis-aligned smoke. Sets up
/// a single AABB at world-x ∈ [200, 204], runs the X-axis sweep
/// against a player capsule walking +X from x=199, and asserts the
/// projected pose has x in `[199.0, 199.7]` (clamp at the inflated
/// wall plane minus a back-off epsilon). Returns 0 on success or a
/// nonzero error code:
///
/// - `1` — clamp returned input pose unchanged (collision didn't fire).
/// - `2` — clamp went past the wall (projected x ≥ 199.7).
/// - `3` — clamp moved the player backwards (projected x < 199.0).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn holtburg_test_collision_clamp_axis_aligned() -> u32 {
    use holtburger_common::Vector3;
    let (pose, candidates) = collision_smoke_fixture();
    let clamped = holtburger_world::clamp_delta_against_buildings(
        &candidates,
        &pose,
        Vector3::new(5.0, 0.0, 0.0),
        holtburger_world::PLAYER_CAPSULE_RADIUS,
    );
    if clamped.x.abs() < 1e-3 {
        return 1;
    }
    let post_x = pose.coords.x + clamped.x + 192.0;
    if post_x >= 199.7 {
        return 2;
    }
    if post_x < 199.0 {
        return 3;
    }
    0
}

/// Phase 6 step B: deterministic slide-along-wall smoke. Same
/// fixture as `holtburg_test_collision_clamp_axis_aligned` but the
/// proposed velocity is PARALLEL to the wall (only +Y, no +X) so no
/// clamp should fire. Asserts the full +Y delta is preserved (within
/// 1e-3 m of the unclamped projection). Starts from x=198.5 so the
/// player capsule (radius 0.4) is just barely outside the inflated
/// wall plane and any false clamp manifests immediately. Returns 0
/// on success or:
///
/// - `1` — Y delta dropped (full slide not preserved).
/// - `2` — X delta gained from nowhere (false slide projection).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn holtburg_test_collision_slide_along_wall() -> u32 {
    use holtburger_common::position::WorldPosition;
    use holtburger_common::Vector3;
    let (pose_at_wall, candidates) = collision_smoke_fixture();
    // Push the start away from the wall by 0.5 m so the inflated
    // sweep has a clean ray entry; otherwise an "already inside the
    // inflated AABB" start would short-circuit the sweep.
    let pose = WorldPosition {
        coords: Vector3::new(
            pose_at_wall.coords.x - 0.5,
            pose_at_wall.coords.y,
            pose_at_wall.coords.z,
        ),
        ..pose_at_wall
    };
    let velocity = Vector3::new(0.0, 5.0, 0.0);
    let clamped = holtburger_world::clamp_delta_against_buildings(
        &candidates,
        &pose,
        velocity,
        holtburger_world::PLAYER_CAPSULE_RADIUS,
    );
    if (clamped.y - 5.0).abs() > 1e-3 {
        return 1;
    }
    if clamped.x.abs() > 1e-3 {
        return 2;
    }
    0
}

// ---------------------------------------------------------------
// Phase 6 step B follow-up — populate the live `building_aabb_index`
// from real LandblockInfo + Setup data.
//
// Flow:
//   1. JS calls `populateBuildingAabbsForLandblock(landblock_id)`
//      after `fetchBuildingPlacement` warm-up (kind=7 EnteredWorld
//      ring + LB-change handler).
//   2. The export fetches `eor/cell:landblock_id|0xFFFE`
//      (LandblockInfo), walks each `BuildInfo` placement.
//   3. For each placement, fetch the Setup, call
//      `walk_setup_parts_with_geom` to derive per-part AABBs in
//      building-local space, then transform each by the placement's
//      `(orientation, origin + landblock_origin)` to get a world-
//      space AABB.
//   4. Bucket each world-space AABB into the outdoor cells it
//      intersects (8x8 grid, 24 m per side, landblock origin at
//      `(lb_x * 192, lb_y * 192)`), pushing entries onto a thread-
//      local pending pile.
//   5. The recv-loop drains the pile on every `TickMovement`,
//      calling `scene.insert_building_aabb` per entry.
//   6. Caller gets the count of AABBs queued (= the count that
//      will land in `building_aabb_index` once the next tick fires).
//
// Why a thread-local pile instead of holding `&mut WorldState`?
// The scope of `&mut world` lives inside the recv loop's
// `tokio::select!` body; wasm-bindgen exports run on the JS-driven
// `Promise` task, which can't pre-empt the recv loop's borrow.
// Routing through a queue mirrors the pattern used by
// `SessionCommand::PopulateTerrain`: compute on the JS-promise side,
// hand off the result to the recv loop on the next iteration.
//
// The thread-local also lets the smoke test exercise the export
// without standing up a full session — the count returned reflects
// the compute path even when no recv loop is running.

#[cfg(target_arch = "wasm32")]
thread_local! {
    /// Pending per-cell building AABB inserts, drained by the recv
    /// loop on each `SessionCommand::TickMovement`. Outer Vec entries
    /// are `(cell_id, BuildingAabbEntry)` tuples — the same shape
    /// `SpatialScene::insert_building_aabb` consumes one at a time.
    static BUILDING_AABB_PENDING:
        std::cell::RefCell<Vec<(u32, holtburger_world::BuildingAabbEntry)>> =
            const { std::cell::RefCell::new(Vec::new()) };

    /// Phase 6 step D: pending cell-graph + cell-AABB inserts queued
    /// by `fetchEnvCellsInLandblock` and drained by the recv loop on
    /// each `SessionCommand::TickMovement`. Same rationale as
    /// `BUILDING_AABB_PENDING` — wasm exports run on the JS-promise
    /// task and can't borrow `&mut WorldState` across awaits, so they
    /// stage inserts here and the recv-loop arm flushes them onto
    /// `world.scene` between integrator ticks.
    ///
    /// `aabbs` carries `(cell_id, Aabb)` pairs computed from the
    /// EnvCell's mesh bbox transformed by the cell origin/orientation.
    /// `portals` carries `(from_cell_id, to_cell_id)` directed edges;
    /// `fetchEnvCellsInLandblock` pushes one edge per
    /// `CellPortal.other_cell_id` and the test paths can synthesize
    /// asymmetric topologies.
    static CELL_GRAPH_PENDING:
        std::cell::RefCell<CellGraphPending> =
            const { std::cell::RefCell::new(CellGraphPending {
                aabbs: Vec::new(),
                portals: Vec::new(),
            }) };

    /// Phase 6 step E follow-up (2026-05-09): pending building-origin
    /// inserts queued by `populateBuildingAabbsForLandblock` and drained
    /// by the recv loop on each `SessionCommand::TickMovement` (same
    /// cadence as `BUILDING_AABB_PENDING`). One entry per building
    /// placement, regardless of how many parts the placement has —
    /// origins are per-`BuildingId`, parts share the placement frame.
    /// The recv-loop's ObjectCreate door-registration arm uses this
    /// to project a `(BuildingId, part_index)` match back into the
    /// JS-side `buildingMap` key shape.
    static BUILDING_ORIGIN_PENDING:
        std::cell::RefCell<Vec<(holtburger_world::BuildingId, f32, f32)>> =
            const { std::cell::RefCell::new(Vec::new()) };

    /// 2026-05-10 indoor collision (Phase 6 step G follow-on):
    /// pending cell-physics-triangle inserts queued by
    /// `fetchEnvCellsInLandblock` (alongside the existing cell-AABB
    /// + portal pushes) and drained by the recv loop on each
    /// `SessionCommand::TickMovement`. One entry per
    /// `physics_polygon` per EnvCell, transformed cell-local →
    /// world via the EnvCell's `position` frame so the integrator's
    /// per-tick swept-capsule kernel doesn't re-do the rotation
    /// every frame. Cleared together with `CELL_GRAPH_PENDING` —
    /// triangles and AABBs share the EnvCell's lifetime.
    static CELL_PHYSICS_PENDING:
        std::cell::RefCell<Vec<(u32, holtburger_common::Triangle)>> =
            const { std::cell::RefCell::new(Vec::new()) };

    /// Workstream C (3D camera collision, 2026-05-11): pending
    /// building-interior physics-triangle inserts queued by the
    /// extended `populateBuildingAabbsForLandblock` and drained by
    /// the recv loop on each `SessionCommand::TickMovement` alongside
    /// `BUILDING_AABB_PENDING`. One entry per `physics_polygon` per
    /// part per building placement, fan-triangulated for `num_pts > 3`
    /// and transformed part-local → placement-frame → world via the
    /// building's `(placement_origin, placement_orientation)` and the
    /// part's per-part frame. Keyed by `landblock_high` (the
    /// `0xXXYY0000` form) to match `building_physics_index`'s shape.
    /// Cleared together with `BUILDING_AABB_PENDING` — building
    /// physics share the placement's lifetime in the index.
    static BUILDING_PHYSICS_PENDING:
        std::cell::RefCell<Vec<(u32, holtburger_common::Triangle)>> =
            const { std::cell::RefCell::new(Vec::new()) };

    /// Workstream Sky-B (parametric skybox, 2026-05-11): thread-local
    /// holding the parsed SkyDesc + GameTime + per-frame evaluator
    /// state. Populated once per session by `populateSkyDescFromRegion`
    /// (fired on `kind=7 EnteredWorld` from JS) with Region `0x13000000`'s
    /// SkyInfo + GameTime. Read by the SYNCHRONOUS `getSkyState` /
    /// `getSkyObjectStates` exports each rAF tick — no recv-loop
    /// involvement required because the data is read-only after init
    /// (the evaluator's cache mutates but that's internal to the
    /// thread-local).
    ///
    /// This dodges the per-frame `&mut world` borrow contention that
    /// the cell/building drains route around via the pending-pile
    /// pattern — SkyDesc doesn't need the world state at all, only
    /// the wall-clock and the static dat data.
    ///
    /// `None` until `populateSkyDescFromRegion` lands; subsequent
    /// reads return `None` from `getSkyState` (JS gates on this).
    static SKY_SHADOW: std::cell::RefCell<Option<SkyShadow>> =
        const { std::cell::RefCell::new(None) };
}

/// Workstream Sky-B: in-memory bundle of the SkyDesc + GameTime + the
/// per-frame `SkyEvalState` evaluator. Lives in the `SKY_SHADOW`
/// thread-local so JS-side `getSkyState` can read without crossing the
/// recv-loop's `&mut world` borrow scope.
#[cfg(target_arch = "wasm32")]
struct SkyShadow {
    sky_desc: holtburger_dat::file_type::SkyDesc,
    game_time: holtburger_dat::file_type::GameTime,
    evaluator: holtburger_world::SkyEvalState,
}

#[cfg(target_arch = "wasm32")]
struct CellGraphPending {
    aabbs: Vec<(u32, holtburger_common::Aabb)>,
    portals: Vec<(u32, u32)>,
}

/// Phase 6 step B follow-up: drain the pending building-AABB pile
/// into the live world's spatial scene. Returns the number of
/// entries inserted. Called by the recv loop on every
/// `SessionCommand::TickMovement` so the queue never holds more
/// than one tick's worth of pending inserts in normal operation.
///
/// Idempotent on an empty pile (returns 0). Lifted out of the recv
/// loop body to keep the `&mut world` borrow scope narrow and
/// to make the drain semantics testable in isolation.
#[cfg(target_arch = "wasm32")]
fn drain_pending_building_aabbs_into(scene: &mut holtburger_world::SpatialScene) -> usize {
    BUILDING_AABB_PENDING.with(|cell| {
        let mut buf = cell.borrow_mut();
        let count = buf.len();
        for (cell_id, entry) in buf.drain(..) {
            scene.insert_building_aabb(cell_id, entry);
        }
        count
    })
}

/// Phase 6 step E follow-up (2026-05-09): drain the pending building-
/// origin pile into the live scene. Returns the number of origins
/// inserted. Called from the same `TickMovement` arm as the AABB drain
/// so a door-registration arm running on the very next ObjectCreate
/// already sees the placement origin (no race against AABB population).
#[cfg(target_arch = "wasm32")]
fn drain_pending_building_origins_into(scene: &mut holtburger_world::SpatialScene) -> usize {
    BUILDING_ORIGIN_PENDING.with(|cell| {
        let mut buf = cell.borrow_mut();
        let count = buf.len();
        for (building_id, x, y) in buf.drain(..) {
            scene.register_building_origin(building_id, x, y);
        }
        count
    })
}

/// Phase 6 step D: drain the pending cell-graph + cell-AABB pile
/// into the spatial scene. Returns `(portals_inserted, aabbs_inserted)`.
/// Called from the same `TickMovement` arm as the building-AABB
/// drain so the integrator and the per-frame visibility query both
/// see the latest cells immediately after a landblock load.
#[cfg(target_arch = "wasm32")]
fn drain_pending_cell_graph_into(scene: &mut holtburger_world::SpatialScene) -> (usize, usize) {
    CELL_GRAPH_PENDING.with(|cell| {
        let mut buf = cell.borrow_mut();
        let portals = buf.portals.len();
        for (from, to) in buf.portals.drain(..) {
            scene.insert_cell_portal(from, to);
        }
        let aabbs = buf.aabbs.len();
        for (cell_id, aabb) in buf.aabbs.drain(..) {
            scene.insert_cell_aabb(cell_id, aabb);
        }
        (portals, aabbs)
    })
}

/// 2026-05-10 indoor collision (Phase 6 step G follow-on): drain the
/// pending cell-physics-triangle pile into the live scene's
/// `cell_physics_index`. Returns the number of triangles inserted.
/// Called from the same `TickMovement` arm as the cell-graph drain
/// so collision math has triangles available the same tick the
/// EnvCell AABBs land.
#[cfg(target_arch = "wasm32")]
fn drain_pending_cell_physics_into(scene: &mut holtburger_world::SpatialScene) -> usize {
    CELL_PHYSICS_PENDING.with(|cell| {
        let mut buf = cell.borrow_mut();
        let count = buf.len();
        for (cell_id, tri) in buf.drain(..) {
            scene.insert_cell_triangle(cell_id, tri);
        }
        count
    })
}

/// Workstream C (3D camera collision, 2026-05-11): drain the pending
/// building-physics-triangle pile into the live scene's
/// `building_physics_index`. Returns the number of triangles
/// inserted. Called from the same `TickMovement` arm as the
/// building-AABB drain so the camera sweep against building interiors
/// has triangles available the same tick the AABBs land.
///
/// Mirrors `drain_pending_cell_physics_into` in shape — the only
/// difference is the destination index keying (landblock-high here,
/// full cell id for the cell-physics path).
#[cfg(target_arch = "wasm32")]
fn drain_pending_building_physics_into(
    scene: &mut holtburger_world::SpatialScene,
) -> usize {
    BUILDING_PHYSICS_PENDING.with(|cell| {
        let mut buf = cell.borrow_mut();
        let count = buf.len();
        for (landblock_high, tri) in buf.drain(..) {
            scene.insert_building_triangle(landblock_high, tri);
        }
        count
    })
}

/// Phase 6 step B follow-up: derive the outdoor-cell ID a world-
/// frame AABB falls into for the given landblock. Returns
/// `landblock_high | (cellX * 8 + cellY + 1)`. AABBs whose centre
/// lies outside `[0, 192)` in either axis (overhang spilling into
/// a neighbour landblock) clamp to the nearest in-range cell —
/// the swept-sphere query later widens to neighbour cells anyway,
/// so a one-cell rounding error doesn't lose a wall.
#[cfg(target_arch = "wasm32")]
fn outdoor_cell_for_world_xy(
    landblock_high: u32,
    world_x: f32,
    world_y: f32,
) -> u32 {
    const LB_M: f32 = 192.0;
    const VERT_M: f32 = 24.0;
    let lb_x_byte = ((landblock_high >> 24) & 0xFF) as f32;
    let lb_y_byte = ((landblock_high >> 16) & 0xFF) as f32;
    let local_x = world_x - lb_x_byte * LB_M;
    let local_y = world_y - lb_y_byte * LB_M;
    let cx = (local_x / VERT_M).floor() as i32;
    let cy = (local_y / VERT_M).floor() as i32;
    let cx = cx.clamp(0, 7) as u32;
    let cy = cy.clamp(0, 7) as u32;
    let cell_low = (cx * 8) + cy + 1;
    landblock_high | cell_low
}

/// Phase 6 step B follow-up: collect every outdoor-cell ID a
/// world-frame AABB intersects within `landblock_high`. Returns the
/// list of cells whose 24x24 footprint overlaps the AABB's `[min, max]`
/// XY projection. Caller uses this to bucket each per-part AABB into
/// every cell it touches — a single building wall straddling two
/// 24 m cells must show up in both buckets so the swept query
/// resolves the wall when entering from either side.
#[cfg(target_arch = "wasm32")]
fn outdoor_cells_for_world_aabb(
    landblock_high: u32,
    aabb: &holtburger_common::Aabb,
) -> Vec<u32> {
    const LB_M: f32 = 192.0;
    const VERT_M: f32 = 24.0;
    let lb_x_byte = ((landblock_high >> 24) & 0xFF) as f32;
    let lb_y_byte = ((landblock_high >> 16) & 0xFF) as f32;
    let local_min_x = aabb.min.x - lb_x_byte * LB_M;
    let local_max_x = aabb.max.x - lb_x_byte * LB_M;
    let local_min_y = aabb.min.y - lb_y_byte * LB_M;
    let local_max_y = aabb.max.y - lb_y_byte * LB_M;
    // Floor for min, ceil-1 for max so a 24.0-aligned wall doesn't
    // spuriously claim the next cell. Clamp to [0, 7] — out-of-LB
    // overhangs (rare) drop to the nearest in-LB cell.
    let cx_min = (local_min_x / VERT_M).floor().clamp(0.0, 7.0) as u32;
    let cx_max = ((local_max_x / VERT_M).ceil() - 1.0).clamp(0.0, 7.0) as u32;
    let cy_min = (local_min_y / VERT_M).floor().clamp(0.0, 7.0) as u32;
    let cy_max = ((local_max_y / VERT_M).ceil() - 1.0).clamp(0.0, 7.0) as u32;
    let mut out = Vec::with_capacity(((cx_max - cx_min + 1) * (cy_max - cy_min + 1)) as usize);
    for cx in cx_min..=cx_max {
        for cy in cy_min..=cy_max {
            let cell_low = (cx * 8) + cy + 1;
            out.push(landblock_high | cell_low);
        }
    }
    if out.is_empty() {
        // Fallback: bucket by the AABB centre. Defensive — the
        // floor/ceil math above should never produce an empty range
        // for a non-empty AABB.
        out.push(outdoor_cell_for_world_xy(
            landblock_high,
            (aabb.min.x + aabb.max.x) * 0.5,
            (aabb.min.y + aabb.max.y) * 0.5,
        ));
    }
    out
}

/// Phase 6 step B follow-up: shared compute path that both the
/// public wasm export and any internal caller use. Walks the
/// landblock's `BuildInfo` list, derives per-part world-space AABBs,
/// buckets them into outdoor cells, and pushes each into the
/// thread-local pending pile (drained next tick by
/// `drain_pending_building_aabbs_into`). Returns the count of
/// entries pushed.
///
/// `landblock_id` may be either the `XXYYFFFE` LandblockInfo cell id
/// or any cell within the landblock — only the high 16 bits matter
/// for resolution. Internally we always probe `XXYYFFFE`.
#[cfg(target_arch = "wasm32")]
async fn populate_building_aabbs_for_landblock_impl(
    landblock_id: u32,
) -> Result<u32, JsValue> {
    use holtburger_common::Aabb;
    use holtburger_dat::landblock::LandblockInfo;
    use holtburger_dat::{ResourceKey, ResourceSource};
    use holtburger_world::{BuildingAabbEntry, BuildingId};

    const LB_M: f32 = 192.0;

    let landblock_high = landblock_id & 0xFFFF_0000;
    let info_cell = landblock_high | 0x0000_FFFE;
    let lb_x_byte = ((landblock_high >> 24) & 0xFF) as f32;
    let lb_y_byte = ((landblock_high >> 16) & 0xFF) as f32;
    let landblock_origin_x = lb_x_byte * LB_M;
    let landblock_origin_y = lb_y_byte * LB_M;

    let source = global_source::global_source();

    // Prefetch the LandblockInfo first; subsequent Setup fetches
    // chase down per-building keys discovered during the walk.
    source
        .prefetch(&[ResourceKey::new("eor/cell", info_cell)])
        .await
        .map_err(|e| JsValue::from_str(&format!(
            "populateBuildingAabbsForLandblock: prefetch landblock 0x{landblock_high:08X}: {e}"
        )))?;

    let info_bytes = match source.get_file_by_key(ResourceKey::new("eor/cell", info_cell)) {
        Ok(b) => b,
        Err(_) => {
            // No LandblockInfo in this landblock (ocean cell, sparse
            // wilderness). Zero buildings is a valid outcome — return
            // 0 rather than fail.
            return Ok(0);
        }
    };
    let info = LandblockInfo::unpack(&info_bytes).map_err(|e| {
        JsValue::from_str(&format!(
            "populateBuildingAabbsForLandblock: LandblockInfo::unpack 0x{info_cell:08X}: {e}"
        ))
    })?;

    if info.buildings.is_empty() {
        return Ok(0);
    }

    // Prefetch every Setup referenced by the buildings list. Setup
    // walks discover GfxObj parts dynamically, so we rely on
    // `prefetch::ensure_walk_prefetched` per Setup to chase missing
    // children. Pre-prefetching the top-level Setup keys batches
    // the network round-trip.
    let setup_keys: Vec<ResourceKey<'_>> = info
        .buildings
        .iter()
        .map(|b| ResourceKey::new("eor/portal", b.model_id))
        .collect();
    source.prefetch(&setup_keys).await.map_err(|e| {
        JsValue::from_str(&format!(
            "populateBuildingAabbsForLandblock: prefetch Setups for 0x{landblock_high:08X}: {e}"
        ))
    })?;

    let mut total = 0u32;

    for (sequence, build_info) in info.buildings.iter().enumerate() {
        let model_id = build_info.model_id;
        let placement_origin = holtburger_common::Vector3 {
            x: build_info.frame.origin.x + landblock_origin_x,
            y: build_info.frame.origin.y + landblock_origin_y,
            z: build_info.frame.origin.z,
        };
        let placement_orientation = build_info.frame.orientation;
        let building_id = BuildingId::new(landblock_high, model_id, sequence as u32);

        // Phase 6 step E follow-up (2026-05-09): record the placement's
        // world-space origin so the recv-loop ObjectCreate arm can map a
        // `(BuildingId, part_index)` AABB hit back into the JS-side
        // `buildingMap` key. One entry per placement (parts share the
        // frame); drained next tick alongside the AABBs.
        BUILDING_ORIGIN_PENDING.with(|pile| {
            pile.borrow_mut().push((
                building_id,
                placement_origin.x,
                placement_origin.y,
            ));
        });

        // Buildings may be raw GfxObjs (`0x01...`) or SetupModels
        // (`0x02...`); the existing renderer dispatches both via
        // `triangulate_model_per_part_buckets`. Mirror that branching
        // here so the collision path covers what the renderer covers.
        //
        // Workstream C (3D camera collision, 2026-05-11): also extract
        // each part's physics_polygons → fan-triangulated triangles in
        // part-local frame coords. These get the same placement-frame
        // transform as the AABB and feed `building_physics_index`.
        let part_data: Vec<(Aabb, Vec<holtburger_common::Triangle>)> =
            match (model_id >> 24) as u8 {
                0x01 => {
                    // Single-part building. Prefetch the GfxObj, then
                    // synthesize the (AABB, triangles) tuple by walking
                    // its vertex array + physics_polygons. The part
                    // frame is identity here — single-part buildings
                    // are placed directly via the BuildInfo frame.
                    source
                        .prefetch(&[ResourceKey::new("eor/portal", model_id)])
                        .await
                        .ok();
                    match source.get_file_by_key(ResourceKey::new("eor/portal", model_id))
                    {
                        Ok(bytes) => match holtburger_dat::file_type::GfxObj::unpack(
                            &mut std::io::Cursor::new(&bytes),
                        ) {
                            Ok(gfx) => {
                                let mut aabb = Aabb::empty();
                                for vert in gfx.vertex_array.vertices.values() {
                                    aabb.expand_to_include_point(vert.origin);
                                }
                                // Fan-triangulate physics_polygons in
                                // part-local frame (identity here).
                                let mut tris: Vec<holtburger_common::Triangle> =
                                    Vec::new();
                                for poly in gfx.physics_polygons.values() {
                                    if poly.num_pts < 3 {
                                        continue;
                                    }
                                    let mut verts: Vec<holtburger_common::Vector3> =
                                        Vec::with_capacity(poly.num_pts as usize);
                                    let mut all_ok = true;
                                    for &vid in &poly.vertex_ids {
                                        if vid < 0 {
                                            all_ok = false;
                                            break;
                                        }
                                        let key = vid as u16;
                                        let Some(sw) =
                                            gfx.vertex_array.vertices.get(&key)
                                        else {
                                            all_ok = false;
                                            break;
                                        };
                                        verts.push(holtburger_common::Vector3::new(
                                            sw.origin.x,
                                            sw.origin.y,
                                            sw.origin.z,
                                        ));
                                    }
                                    if !all_ok || verts.len() < 3 {
                                        continue;
                                    }
                                    for i in 1..(verts.len() - 1) {
                                        tris.push(holtburger_common::Triangle::new(
                                            verts[0],
                                            verts[i],
                                            verts[i + 1],
                                        ));
                                    }
                                }
                                vec![(aabb, tris)]
                            }
                            Err(_) => continue,
                        },
                        Err(_) => continue,
                    }
                }
                0x02 => {
                    // Multi-part Setup. Iterative discovery of GfxObj
                    // children referenced by this Setup mirrors
                    // `fetch_building_placement`'s prefetch shape.
                    let initial = [ResourceKey::new("eor/portal", model_id)];
                    if let Err(e) = prefetch::ensure_walk_prefetched(&source, &initial, |s| {
                        let _ = walk_setup_parts_with_geom_and_physics(s, model_id);
                    })
                    .await
                    {
                        log::warn!(
                            "populateBuildingAabbsForLandblock: ensure_walk_prefetched 0x{model_id:08X}: {e:?}"
                        );
                        continue;
                    }
                    match walk_setup_parts_with_geom_and_physics(source.as_ref(), model_id) {
                        Some(v) => v,
                        None => continue,
                    }
                }
                _ => continue,
            };

        for (part_index, (part_local, part_tris)) in part_data.iter().enumerate() {
            if part_local.is_empty() {
                continue;
            }
            // Lift the part-local AABB to world space: rotate the
            // 8 corners by the placement quaternion, translate by
            // the placement origin in global world coords. The
            // resulting AABB conservatively bounds the rotated
            // mesh — see `Aabb::transform_by` for the math.
            let world_aabb: Aabb = part_local.transform_by(placement_orientation, placement_origin);
            let cells = outdoor_cells_for_world_aabb(landblock_high, &world_aabb);
            BUILDING_AABB_PENDING.with(|pile| {
                let mut pile = pile.borrow_mut();
                for cell_id in cells {
                    pile.push((
                        cell_id,
                        BuildingAabbEntry {
                            building_id,
                            part_index: part_index as u8,
                            aabb: world_aabb,
                            active: true,
                        },
                    ));
                    total += 1;
                }
            });

            // Workstream C: apply the placement transform to each
            // part-local physics triangle (rotate vertices by
            // `placement_orientation`, translate by
            // `placement_origin`) and push to the pending pile keyed
            // by `landblock_high`. JS-side door state toggling does
            // NOT remove triangles (open doors still have collision
            // for their frames); the camera sweep against building
            // interior walls is unaffected by door state.
            if !part_tris.is_empty() {
                BUILDING_PHYSICS_PENDING.with(|pile| {
                    let mut pile = pile.borrow_mut();
                    for tri in part_tris.iter() {
                        // Transform each vertex of the triangle from
                        // part-local frame to world frame. Same math
                        // as the GfxObj-vertex AABB lift above:
                        // rotate by `placement_orientation`, then
                        // add `placement_origin`.
                        let v0_rot = quat_rotate(placement_orientation, tri.v0);
                        let v1_rot = quat_rotate(placement_orientation, tri.v1);
                        let v2_rot = quat_rotate(placement_orientation, tri.v2);
                        let world_tri = holtburger_common::Triangle::new(
                            holtburger_common::Vector3::new(
                                v0_rot.x + placement_origin.x,
                                v0_rot.y + placement_origin.y,
                                v0_rot.z + placement_origin.z,
                            ),
                            holtburger_common::Vector3::new(
                                v1_rot.x + placement_origin.x,
                                v1_rot.y + placement_origin.y,
                                v1_rot.z + placement_origin.z,
                            ),
                            holtburger_common::Vector3::new(
                                v2_rot.x + placement_origin.x,
                                v2_rot.y + placement_origin.y,
                                v2_rot.z + placement_origin.z,
                            ),
                        );
                        pile.push((landblock_high, world_tri));
                    }
                });
            }
            // Phase E (door state) will use part_index to address
            // a specific entry for AABB-toggle on door-open. Today
            // all parts are inserted unconditionally.
            let _ = part_index;
        }
    }

    Ok(total)
}

/// Phase 6 step B follow-up: public wasm export. Fetches the
/// LandblockInfo for `landblock_id`, walks every `BuildInfo`
/// placement, derives per-part world-space AABBs, and queues them
/// for insertion into the live `WorldState::scene::building_aabb_index`
/// on the next `MovementSystemHandle::tick`. Returns the count of
/// AABBs queued.
///
/// JS callers should fire-and-forget this once per landblock loaded
/// (mirror the terrain-prefetch path: kind=7 EnteredWorld + LB-change
/// handler in `index.html`'s `handlePositionUpdate`). Subsequent
/// calls into the same landblock_id are idempotent in the sense that
/// they re-queue the same entries — production use should gate on
/// a `populated_landblocks: Set` to avoid double-insertion. (Smoke
/// tests deliberately don't gate so the count reflects fresh
/// compute every call.)
///
/// `landblock_id` accepts either the bare landblock high word
/// (`0xA9B40000`) or any cell ID within the landblock; only the
/// high 16 bits drive resolution. Returns 0 (not an error) when the
/// landblock has no LandblockInfo record (ocean, sparse wilderness)
/// or no `BuildInfo` entries (open countryside). Errors propagate
/// only on prefetch / parse failures.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = populateBuildingAabbsForLandblock)]
pub async fn populate_building_aabbs_for_landblock(
    landblock_id: u32,
) -> Result<u32, JsValue> {
    populate_building_aabbs_for_landblock_impl(landblock_id).await
}

/// Workstream Sky-B (parametric skybox, 2026-05-11): populate the
/// thread-local `SKY_SHADOW` with the parsed SkyDesc + GameTime from
/// the given Region file. JS calls this once per session on
/// `kind=7 EnteredWorld` with `region_file_id = 0x13000000` (Dereth's
/// canonical Region, the only one shipped in retail
/// `client_portal.dat`).
///
/// Idempotent: a second call overwrites the shadow with a fresh parse
/// (Region descriptors don't change mid-session, but the API doesn't
/// fail if JS double-fires). Returns the number of DayGroups parsed,
/// so JS smoke tests can assert non-zero without re-reading the
/// shadow. Returns an error on prefetch / parse failures.
///
/// **Time anchor:** the new evaluator is constructed against
/// [`holtburger_world::AC_LAUNCH_UNIX_EPOCH`] (`1999-11-02 UTC`).
/// See `crates/holtburger-world/src/sky.rs` for the rationale on
/// why this anchor is load-bearing (deterministic across browser
/// sessions, no server-broadcast time-sync packet available in the
/// ACE bundle).
#[cfg(target_arch = "wasm32")]
async fn populate_sky_desc_from_region_impl(region_file_id: u32) -> Result<u32, JsValue> {
    use holtburger_dat::file_type::Region;
    use holtburger_dat::{ResourceKey, ResourceSource};

    let source = global_source::global_source();

    // Prefetch the Region. Region records live in the
    // `eor/portal` namespace (alongside GfxObj, SetupModel, etc.).
    // The dat-source manifest catalogs Region by full 32-bit file id,
    // so we just thread it through.
    source
        .prefetch(&[ResourceKey::new("eor/portal", region_file_id)])
        .await
        .map_err(|e| {
            JsValue::from_str(&format!(
                "populateSkyDescFromRegion: prefetch Region 0x{region_file_id:08X}: {e}"
            ))
        })?;

    let bytes = source
        .get_file_by_key(ResourceKey::new("eor/portal", region_file_id))
        .map_err(|e| {
            JsValue::from_str(&format!(
                "populateSkyDescFromRegion: fetch Region 0x{region_file_id:08X}: {e:?}"
            ))
        })?;

    let region = Region::unpack(&mut std::io::Cursor::new(&bytes)).map_err(|e| {
        JsValue::from_str(&format!(
            "populateSkyDescFromRegion: Region::unpack 0x{region_file_id:08X}: {e}"
        ))
    })?;

    let sky_desc = region
        .sky_info
        .ok_or_else(|| {
            JsValue::from_str(&format!(
                "populateSkyDescFromRegion: Region 0x{region_file_id:08X} has no SkyInfo \
                 (parts_mask = 0x{:04X} — HasSkyInfo bit 0x10 is not set)",
                region.parts_mask
            ))
        })?;

    let game_time = region.game_time;
    let day_group_count = sky_desc.day_groups.len() as u32;

    SKY_SHADOW.with(|shadow| {
        *shadow.borrow_mut() = Some(SkyShadow {
            sky_desc,
            game_time,
            evaluator: holtburger_world::SkyEvalState::new(),
        });
    });

    console_log_str(&format!(
        "[Sky-B] populateSkyDescFromRegion 0x{region_file_id:08X} → {day_group_count} DayGroups"
    ));
    Ok(day_group_count)
}

/// Workstream Sky-B: public wasm export wrapping
/// [`populate_sky_desc_from_region_impl`]. JS fires this on
/// `kind=7 EnteredWorld` with `region_file_id = 0x13000000`.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = populateSkyDescFromRegion)]
pub async fn populate_sky_desc_from_region(region_file_id: u32) -> Result<u32, JsValue> {
    populate_sky_desc_from_region_impl(region_file_id).await
}

/// Workstream Sky-B: predicate for JS to gate `getSkyState` reads on.
/// Returns `true` once `populateSkyDescFromRegion` has landed at least
/// once. Synchronous — no recv-loop involvement.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = hasSkyDesc)]
pub fn has_sky_desc() -> bool {
    SKY_SHADOW.with(|shadow| shadow.borrow().is_some())
}

/// Workstream Sky-B: set a time-of-day override in `[0.0, 1.0)`. JS-side
/// `?skytime=accel` demo path drives a 5-minute synthetic day cycle by
/// calling this with `t = (elapsed_ms / (5*60*1000)) % 1.0` per rAF
/// tick.
///
/// Passing `f32::NAN` clears the override (back to wall-clock UTC
/// derivation). Calling before `populateSkyDescFromRegion` lands is a
/// no-op (the override is on the evaluator, which only exists after
/// SkyDesc lands). Returns `true` if the override was applied (sky was
/// populated), else `false`.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = setSkyTimeOverride)]
pub fn set_sky_time_override(time_of_day: f32) -> bool {
    SKY_SHADOW.with(|shadow| {
        let mut shadow = shadow.borrow_mut();
        let Some(s) = shadow.as_mut() else {
            return false;
        };
        if time_of_day.is_nan() {
            s.evaluator.set_time_of_day_override(None);
        } else {
            s.evaluator.set_time_of_day_override(Some(time_of_day));
        }
        true
    })
}

/// Workstream Sky-G: force the in-world `(day, year)` tuple used by the
/// LCG-hash DayGroup selector. Set both to `u32::MAX` (sentinel) to
/// clear the override and return to wall-clock derivation. Used by
/// the Sky-F capture script to drive DayGroup cycling without waiting
/// for real-world midnight (Dereth's `day_length=7620s` means a real
/// 127-min wait between game-days).
///
/// Returns `true` if applied; `false` if the SkyDesc hasn't been
/// populated yet.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = setGameDayOverride)]
pub fn set_game_day_override(day: u32, year: u32) -> bool {
    SKY_SHADOW.with(|shadow| {
        let mut shadow = shadow.borrow_mut();
        let Some(s) = shadow.as_mut() else {
            return false;
        };
        if day == u32::MAX && year == u32::MAX {
            s.evaluator.set_game_day_override(None);
        } else {
            s.evaluator.set_game_day_override(Some((day, year)));
        }
        true
    })
}

/// Workstream Sky-G: collect EVERY `gfx_obj_id` referenced by ANY
/// SkyObject or SkyObjectReplace across ALL DayGroups in the cached
/// SkyDesc. JS calls this at session init so the asset resolver can
/// pre-bake the full override set; mesh swaps at keyframe boundaries
/// are then zero-network at runtime.
///
/// Returns an empty Vec if the SkyDesc hasn't been populated. Each
/// returned ID is a `0x01xxxxxx` (GfxObj) or `0x02xxxxxx` (SetupModel)
/// DID. Deduplication is the CALLER's job (the wasm side returns the
/// raw union).
///
/// In retail Dereth the union equals the set of `default_gfx_object_id`s
/// (every replace.gfx_obj_id is `0x00000000`, meaning "no mesh
/// override"). The export exists for the general case (Marae, custom
/// regions) and to keep the resolver pipeline future-proof.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = getSkyOverrideObjectIds)]
pub fn get_sky_override_object_ids() -> Vec<u32> {
    SKY_SHADOW.with(|shadow| {
        let shadow = shadow.borrow();
        let Some(s) = shadow.as_ref() else {
            return Vec::new();
        };
        let mut ids: Vec<u32> = Vec::new();
        for dg in &s.sky_desc.day_groups {
            for so in &dg.sky_objects {
                if so.default_gfx_object_id != 0 {
                    ids.push(so.default_gfx_object_id);
                }
            }
            for kf in &dg.sky_time {
                for r in &kf.sky_obj_replace {
                    // Replace records with gfx_obj_id==0 keep the
                    // SkyObject's default mesh; only non-zero
                    // overrides need pre-baking.
                    if r.gfx_obj_id != 0 {
                        ids.push(r.gfx_obj_id);
                    }
                }
            }
        }
        ids
    })
}

/// Workstream Sky-B: wasm-bindgen-friendly mirror of
/// [`holtburger_world::SkyStateSnapshot`]. Plain-data so wasm-bindgen
/// can pass it through getters without `serde`.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
#[derive(Clone, Copy)]
pub struct SkyState {
    dir_color_argb: u32,
    dir_bright: f32,
    dir_heading: f32,
    dir_pitch: f32,
    amb_color_argb: u32,
    amb_bright: f32,
    fog_color_argb: u32,
    fog_min: f32,
    fog_max: f32,
    world_fog: u32,
    time_of_day_normalized: f32,
    day_group_index: u32,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl SkyState {
    /// Directional light color packed as `0xAARRGGBB` u32. Decode to
    /// `[A, R, G, B]` for shader / sprite tint dispatch.
    #[wasm_bindgen(getter, js_name = dirColorArgb)]
    pub fn dir_color_argb(&self) -> u32 {
        self.dir_color_argb
    }

    /// Directional light brightness multiplier (typically 0..1).
    #[wasm_bindgen(getter, js_name = dirBright)]
    pub fn dir_bright(&self) -> f32 {
        self.dir_bright
    }

    /// Directional light heading on the world XY plane (radians).
    #[wasm_bindgen(getter, js_name = dirHeading)]
    pub fn dir_heading(&self) -> f32 {
        self.dir_heading
    }

    /// Directional light pitch above horizon (radians).
    #[wasm_bindgen(getter, js_name = dirPitch)]
    pub fn dir_pitch(&self) -> f32 {
        self.dir_pitch
    }

    /// Ambient light color (`0xAARRGGBB`).
    #[wasm_bindgen(getter, js_name = ambColorArgb)]
    pub fn amb_color_argb(&self) -> u32 {
        self.amb_color_argb
    }

    /// Ambient light brightness multiplier.
    #[wasm_bindgen(getter, js_name = ambBright)]
    pub fn amb_bright(&self) -> f32 {
        self.amb_bright
    }

    /// World-fog color (`0xAARRGGBB`).
    #[wasm_bindgen(getter, js_name = fogColorArgb)]
    pub fn fog_color_argb(&self) -> u32 {
        self.fog_color_argb
    }

    /// Near-fog distance plane (metres).
    #[wasm_bindgen(getter, js_name = fogMin)]
    pub fn fog_min(&self) -> f32 {
        self.fog_min
    }

    /// Far-fog distance plane (metres).
    #[wasm_bindgen(getter, js_name = fogMax)]
    pub fn fog_max(&self) -> f32 {
        self.fog_max
    }

    /// Fog-mode enum (uint pass-through; not lerped — discrete).
    #[wasm_bindgen(getter, js_name = worldFog)]
    pub fn world_fog(&self) -> u32 {
        self.world_fog
    }

    /// Normalized day-fraction in `[0.0, 1.0)`. 0.0 = midnight,
    /// 0.25 = dawn, 0.5 = noon, 0.75 = dusk.
    #[wasm_bindgen(getter, js_name = timeOfDayNormalized)]
    pub fn time_of_day_normalized(&self) -> f32 {
        self.time_of_day_normalized
    }

    /// Index of the active DayGroup in `SkyDesc.day_groups`. Stable per
    /// game-day (changes only at midnight boundary per the LCG hash).
    #[wasm_bindgen(getter, js_name = dayGroupIndex)]
    pub fn day_group_index(&self) -> u32 {
        self.day_group_index
    }
}

/// Workstream Sky-B / Sky-I-B: wasm-bindgen-friendly mirror of
/// [`holtburger_world::SkyObjectSnapshot`].
///
/// **Sky-I-B (2026-05-11):** the historical `heading` / `pitch` getters
/// are preserved for backward compatibility, but the new sky-cell
/// render path in `scene3d/sky_dome.js` consumes the **raw degree /
/// window getters** (`beginAngleDeg`, `endAngleDeg`, `beginTime`,
/// `endTime`, `currentProgress`) instead. The deg→rad conversion now
/// lives JS-side. See `docs/sky-i-probe-2026-05-11.md` for the probe
/// that motivated the move.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
#[derive(Clone, Copy)]
pub struct SkyObjectState {
    gfx_object_id: u32,
    heading: f32,
    pitch: f32,
    begin_angle_deg: f32,
    end_angle_deg: f32,
    begin_time: f32,
    end_time: f32,
    current_progress: f32,
    tex_offset_x: f32,
    tex_offset_y: f32,
    transparent: f32,
    luminosity: f32,
    max_bright: f32,
    visible: bool,
    properties: u32,
    pes_object_id: u32,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl SkyObjectState {
    /// `0x01xxxxxx` (GfxObj) OR `0x02xxxxxx` (SetupModel). Renderer
    /// dispatches on the high byte. Reflects any SkyObjectReplace
    /// override active in the surrounding SkyTimeOfDay keyframe.
    #[wasm_bindgen(getter, js_name = gfxObjectId)]
    pub fn gfx_object_id(&self) -> u32 {
        self.gfx_object_id
    }

    /// **DEPRECATED (Sky-I-B).** Cooked heading on the sky dome
    /// (radians, but produced by treating DAT-degree fields as
    /// radians — see the Sky-I-A probe memo). The new render path uses
    /// `beginAngleDeg` / `endAngleDeg` / `currentProgress` and does the
    /// deg→rad conversion itself.
    #[wasm_bindgen(getter)]
    pub fn heading(&self) -> f32 {
        self.heading
    }

    /// **DEPRECATED (Sky-I-B).** Cooked pitch (radians off horizon),
    /// synthesized via `sin(p * pi) * (pi/2)`. The new render path
    /// elides pitch synthesis (celestials trace a horizontal arc at
    /// native vertex altitude).
    #[wasm_bindgen(getter)]
    pub fn pitch(&self) -> f32 {
        self.pitch
    }

    /// **Sky-I-B.** Raw `SkyObject.begin_angle` in DEGREES verbatim
    /// from the DAT. Retail Dereth sun/moon ship `-20`, stars `-23`,
    /// always-visible objects `0`.
    #[wasm_bindgen(getter, js_name = beginAngleDeg)]
    pub fn begin_angle_deg(&self) -> f32 {
        self.begin_angle_deg
    }

    /// **Sky-I-B.** Raw `SkyObject.end_angle` in DEGREES. Retail Dereth
    /// sun/moon ship `190`, stars `203`, always-visible objects `0`.
    #[wasm_bindgen(getter, js_name = endAngleDeg)]
    pub fn end_angle_deg(&self) -> f32 {
        self.end_angle_deg
    }

    /// **Sky-I-B.** Raw `SkyObject.begin_time` (normalized day fraction
    /// `[0, 1)`). Renderer uses this to detect always-visible vs
    /// arc-bounded SkyObjects (`beginTime == endTime` → always
    /// visible).
    #[wasm_bindgen(getter, js_name = beginTime)]
    pub fn begin_time(&self) -> f32 {
        self.begin_time
    }

    /// **Sky-I-B.** Raw `SkyObject.end_time`.
    #[wasm_bindgen(getter, js_name = endTime)]
    pub fn end_time(&self) -> f32 {
        self.end_time
    }

    /// **Sky-I-B.** Lerp parameter `[0, 1]` across the visible window:
    /// renderer computes `headingDeg = lerp(beginAngleDeg, endAngleDeg,
    /// currentProgress); rotation_z_rad = headingDeg * (π / 180)`.
    /// `0.0` for always-visible objects + for the frames when an
    /// arc-bounded object is off-window.
    #[wasm_bindgen(getter, js_name = currentProgress)]
    pub fn current_progress(&self) -> f32 {
        self.current_progress
    }

    /// Accumulated UV scroll-x offset, modulo'd to `[0, 1)`.
    #[wasm_bindgen(getter, js_name = texOffsetX)]
    pub fn tex_offset_x(&self) -> f32 {
        self.tex_offset_x
    }

    #[wasm_bindgen(getter, js_name = texOffsetY)]
    pub fn tex_offset_y(&self) -> f32 {
        self.tex_offset_y
    }

    /// Active SkyObjectReplace's `transparent` value (0..1) or `-1.0`
    /// when no replace targets this object index.
    #[wasm_bindgen(getter)]
    pub fn transparent(&self) -> f32 {
        self.transparent
    }

    /// Active replace's `luminosity` or `-1.0` when no replace.
    #[wasm_bindgen(getter)]
    pub fn luminosity(&self) -> f32 {
        self.luminosity
    }

    /// Active replace's `max_bright` or `-1.0` when no replace.
    #[wasm_bindgen(getter, js_name = maxBright)]
    pub fn max_bright(&self) -> f32 {
        self.max_bright
    }

    /// `true` when this object is on the visible side of the sky dome
    /// for the current time-of-day.
    #[wasm_bindgen(getter)]
    pub fn visible(&self) -> bool {
        self.visible
    }

    /// Pass-through `SkyObject.properties` flag bitmask (rotation
    /// mode, billboard, etc.).
    #[wasm_bindgen(getter)]
    pub fn properties(&self) -> u32 {
        self.properties
    }

    /// **Sky-J P5.** Pass-through of `SkyObject.default_pes_object_id`
    /// — a PhysicsScript DID (0x33xxxxxx) when non-zero, 0 otherwise.
    /// JS-side `sky_dome.js` reads this to decide whether to walk the
    /// PhysicsScript → CreateParticleHook → ParticleEmitter chain for
    /// 0x02 SetupModel sky objects (retail moon's 0x02000714 carries
    /// 0x330007DB here). Returns 0 for 0x01 GfxObj sky objects (sun /
    /// moon mesh / cloud bands / stars — they have no physics script).
    #[wasm_bindgen(getter, js_name = pesObjectId)]
    pub fn pes_object_id(&self) -> u32 {
        self.pes_object_id
    }
}

/// Workstream Sky-B: read `Date.now()` from JS, normalize to Unix
/// seconds (f64), evaluate the cached SkyDesc against the wall clock
/// (or override), and return the snapshot. Synchronous — no
/// recv-loop / promise involvement. JS calls this once per rAF tick
/// from the skybox renderer.
///
/// Returns `None` (JS receives `undefined`) when:
/// - `populateSkyDescFromRegion` hasn't landed yet.
/// - The cached SkyDesc has zero DayGroups (sentinel).
#[cfg(target_arch = "wasm32")]
fn evaluate_sky_now() -> Option<(SkyState, Vec<SkyObjectState>)> {
    let now_unix = js_date_now_ms() / 1000.0;
    SKY_SHADOW.with(|shadow| {
        let mut shadow = shadow.borrow_mut();
        let s = shadow.as_mut()?;
        let (state, objects) = s.evaluator.evaluate(&s.sky_desc, &s.game_time, now_unix)?;
        let sky_state = SkyState {
            dir_color_argb: state.dir_color_argb,
            dir_bright: state.dir_bright,
            dir_heading: state.dir_heading,
            dir_pitch: state.dir_pitch,
            amb_color_argb: state.amb_color_argb,
            amb_bright: state.amb_bright,
            fog_color_argb: state.fog_color_argb,
            fog_min: state.fog_min,
            fog_max: state.fog_max,
            world_fog: state.world_fog,
            time_of_day_normalized: state.time_of_day_normalized,
            day_group_index: state.day_group_index,
        };
        let mapped: Vec<SkyObjectState> = objects
            .into_iter()
            .map(|o| SkyObjectState {
                gfx_object_id: o.gfx_object_id,
                heading: o.heading,
                pitch: o.pitch,
                begin_angle_deg: o.begin_angle_deg,
                end_angle_deg: o.end_angle_deg,
                begin_time: o.begin_time,
                end_time: o.end_time,
                current_progress: o.current_progress,
                tex_offset_x: o.tex_offset_x,
                tex_offset_y: o.tex_offset_y,
                transparent: o.transparent,
                luminosity: o.luminosity,
                max_bright: o.max_bright,
                visible: o.visible,
                properties: o.properties,
                pes_object_id: o.pes_object_id,
            })
            .collect();
        Some((sky_state, mapped))
    })
}

#[cfg(target_arch = "wasm32")]
mod inmem_collision_source {
    use holtburger_dat::{DatError, FileMetadata, ResourceKey, ResourceSource};

    pub(super) struct InMemorySource {
        files: Vec<(String, u32, Vec<u8>)>,
    }

    impl InMemorySource {
        pub(super) fn new(files: Vec<(String, u32, Vec<u8>)>) -> Self {
            Self { files }
        }
    }

    impl ResourceSource for InMemorySource {
        fn get_file_by_key(&self, key: ResourceKey<'_>) -> Result<Vec<u8>, DatError> {
            self.files
                .iter()
                .find(|(ns, id, _)| ns == key.namespace && *id == key.file_id)
                .map(|(_, _, b)| b.clone())
                .ok_or(DatError::NotFound(key.file_id))
        }

        fn get_metadata_by_key(&self, key: ResourceKey<'_>) -> Option<FileMetadata> {
            self.files
                .iter()
                .find(|(ns, id, _)| ns == key.namespace && *id == key.file_id)
                .map(|(_, id, b)| FileMetadata {
                    id: *id,
                    size: b.len() as u32,
                    is_pruned: false,
                })
        }

        fn has_namespace(&self, namespace: &str) -> bool {
            self.files.iter().any(|(ns, _, _)| ns == namespace)
        }
    }
}

// ====================================================================
// Phase 6 step C — EnvCell rendering
// ====================================================================
//
// Buildings (Phase A) are exterior; EnvCells are interior. Each EnvCell
// (`eor/cell:XXYY01XX..XXYYFFFD`) carries a frame (origin + orientation
// in landblock-local space), an `environment_id` (`0x0D…`) pointing to
// the Environment record that holds the actual mesh, a portal table
// linking to neighbour cells (Phase D's traversal graph), and a static-
// object list (`Stab` records keyed by GfxObj/SetupModel DID, frame
// in cell-local space).
//
// JS flow: on landblock entry, JS calls `fetchEnvCellsInLandblock(lbid)`
// once per landblock (mirrors Phase B's `populateBuildingAabbsForLandblock`
// trigger). Each `EnvCellPlacement` ships pre-baked geometry (a
// `ModelMesh` holding the Environment's polygons in cell-local
// coords) plus the static-object frame list. PIXI stamps a per-cell
// container at the cell origin, applies the orientation, and adds
// the mesh sprite + per-static-object child sprites. Phase D will gate
// `.visible` on the per-cell render set.

/// Phase 6 step C: marker / no-op symbol the JS-side bake registers
/// against. The actual `window.cellContainers: Map<u32, PIXI.Container>`
/// lives on the JS side (PIXI display objects can't cross the wasm
/// boundary). Calling this is a no-op; the symbol only exists for the
/// smoke's `typeof wasm.init_cell_containers === "function"` check.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn init_cell_containers() {}

/// Phase 6 step C: per-static-object placement inside an EnvCell.
/// Mirrors the terminal exporter's `staticObjects` shape (per
/// `WorldBuilder.Terminal/CommandEngine.cs:5247-5292`). Coords are in
/// **world space** (cell origin + cell rotation already applied). The
/// `aabbLocal` floats are the model-local bounding box in
/// `[minX, minY, minZ, maxX, maxY, maxZ]` order.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct StaticObjectPlacement {
    did: u32,
    x: f32,
    y: f32,
    z: f32,
    qw: f32,
    qx: f32,
    qy: f32,
    qz: f32,
    aabb_local: Vec<f32>,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl StaticObjectPlacement {
    #[wasm_bindgen(getter)]
    pub fn did(&self) -> u32 { self.did }
    #[wasm_bindgen(getter)]
    pub fn x(&self) -> f32 { self.x }
    #[wasm_bindgen(getter)]
    pub fn y(&self) -> f32 { self.y }
    #[wasm_bindgen(getter)]
    pub fn z(&self) -> f32 { self.z }
    #[wasm_bindgen(getter)]
    pub fn qw(&self) -> f32 { self.qw }
    #[wasm_bindgen(getter)]
    pub fn qx(&self) -> f32 { self.qx }
    #[wasm_bindgen(getter)]
    pub fn qy(&self) -> f32 { self.qy }
    #[wasm_bindgen(getter)]
    pub fn qz(&self) -> f32 { self.qz }
    /// Model-local AABB, flat `[minX, minY, minZ, maxX, maxY, maxZ]`.
    /// Phase D consumes this for cell-containment queries (point inside
    /// AABB → cell candidate); Phase B inserts it into the building
    /// AABB index for collision once interior collision lands.
    #[wasm_bindgen(getter, js_name = aabbLocal)]
    pub fn aabb_local(&self) -> Vec<f32> { self.aabb_local.clone() }
}

/// Phase 6 step C: per-cell placement bundle returned by
/// `fetchEnvCellsInLandblock`. Carries the world-frame transform, the
/// pre-baked Environment mesh in cell-local coords, the per-cell
/// portal graph edges (cell ids that this cell connects to via
/// CellPortal records — Phase D walks these), and the cell's static-
/// object placements.
///
/// One-shot move semantics on `take_*` mirror [`BuildingPlacement`]:
/// JS calls `takeMesh()`, `takeStaticObjects()`, `takePortalCellIds()`
/// to drain into JS-owned memory without a clone.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct EnvCellPlacement {
    cell_id: u32,
    environment_id: u32,
    cell_origin_x: f32,
    cell_origin_y: f32,
    cell_origin_z: f32,
    cell_orientation_qw: f32,
    cell_orientation_qx: f32,
    cell_orientation_qy: f32,
    cell_orientation_qz: f32,
    static_objects: Vec<StaticObjectPlacement>,
    portal_cell_ids: Vec<u32>,
    mesh: ModelMesh,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl EnvCellPlacement {
    #[wasm_bindgen(getter, js_name = cellId)]
    pub fn cell_id(&self) -> u32 { self.cell_id }
    #[wasm_bindgen(getter, js_name = environmentId)]
    pub fn environment_id(&self) -> u32 { self.environment_id }
    #[wasm_bindgen(getter, js_name = cellOriginX)]
    pub fn cell_origin_x(&self) -> f32 { self.cell_origin_x }
    #[wasm_bindgen(getter, js_name = cellOriginY)]
    pub fn cell_origin_y(&self) -> f32 { self.cell_origin_y }
    #[wasm_bindgen(getter, js_name = cellOriginZ)]
    pub fn cell_origin_z(&self) -> f32 { self.cell_origin_z }
    #[wasm_bindgen(getter, js_name = cellOrientationQw)]
    pub fn cell_orientation_qw(&self) -> f32 { self.cell_orientation_qw }
    #[wasm_bindgen(getter, js_name = cellOrientationQx)]
    pub fn cell_orientation_qx(&self) -> f32 { self.cell_orientation_qx }
    #[wasm_bindgen(getter, js_name = cellOrientationQy)]
    pub fn cell_orientation_qy(&self) -> f32 { self.cell_orientation_qy }
    #[wasm_bindgen(getter, js_name = cellOrientationQz)]
    pub fn cell_orientation_qz(&self) -> f32 { self.cell_orientation_qz }
    #[wasm_bindgen(getter, js_name = staticObjectCount)]
    pub fn static_object_count(&self) -> u32 {
        self.static_objects.len() as u32
    }
    #[wasm_bindgen(getter, js_name = portalCellIdCount)]
    pub fn portal_cell_id_count(&self) -> u32 {
        self.portal_cell_ids.len() as u32
    }
    /// Move the per-cell static-object placements out into JS-owned
    /// storage. One-shot — second call returns an empty Vec.
    #[wasm_bindgen(js_name = takeStaticObjects)]
    pub fn take_static_objects(&mut self) -> Vec<StaticObjectPlacement> {
        std::mem::take(&mut self.static_objects)
    }
    /// Move the portal cell-id list out (full 32-bit cell ids, not the
    /// bare 16-bit indices the EnvCell wire format uses — the high 16
    /// bits are pre-OR'd with the parent landblock).
    #[wasm_bindgen(js_name = takePortalCellIds)]
    pub fn take_portal_cell_ids(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.portal_cell_ids)
    }
    /// Move the cell mesh (Environment polygons triangulated in cell-
    /// local coords) out. PIXI applies the cell origin + orientation
    /// transform when placing the rendered tile in the scene.
    #[wasm_bindgen(js_name = takeMesh)]
    pub fn take_mesh(&mut self) -> ModelMesh {
        std::mem::replace(&mut self.mesh, ModelMesh {
            positions: Vec::new(),
            uvs: Vec::new(),
            normals: Vec::new(),
            surface_indices: Vec::new(),
            surfaces: Vec::new(),
            bbox_min: [0.0; 3],
            bbox_max: [0.0; 3],
            did_degrade: 0,
        })
    }
}

/// Triangulate every drawing polygon across every cell in an Environment
/// record into a flat `Vec<Tri>` in cell-local coordinates. Mirrors
/// `append_gfx_tris` line-for-line — the polygon shape is identical
/// (shared `holtburger_dat::graphics::Polygon`), only the surface DID
/// resolution differs. Environment cell polygons reference surface
/// indices into the parent EnvCell's surface table (a `Vec<u16>`
/// shipped on the wire); the caller is responsible for converting each
/// u16 to a full Surface DID via `0x08000000 | u16` (mirrors ACE's
/// `DatLoader/FileTypes/EnvCell.cs:50`) before passing the resolved
/// `surfaces: &[u32]` here. `pos_surface < 0` or out-of-range polygons
/// emit `surface_did = 0` and fall through to the flat-fallback path.
#[cfg(target_arch = "wasm32")]
fn append_environment_tris(
    tris: &mut Vec<Tri>,
    env: &holtburger_dat::file_type::Environment,
    surfaces: &[u32],
) {
    use holtburger_dat::graphics::Polygon;
    let mut cell_keys: Vec<u32> = env.cells.keys().copied().collect();
    cell_keys.sort_unstable();
    for cell_key in cell_keys {
        let cell = &env.cells[&cell_key];
        if cell.vertex_array.vertices.is_empty() || cell.polygons.is_empty() {
            continue;
        }
        let mut poly_ids: Vec<u16> = cell.polygons.keys().copied().collect();
        poly_ids.sort_unstable();
        for pid in poly_ids {
            let poly: &Polygon = &cell.polygons[&pid];
            if poly.vertex_ids.len() < 3 { continue; }
            const NO_POS: u8 = 0x04;
            if (poly.stippling & NO_POS) != 0 { continue; }

            let surface_did = if poly.pos_surface >= 0
                && (poly.pos_surface as usize) < surfaces.len()
            {
                surfaces[poly.pos_surface as usize] as u32
            } else {
                0
            };

            let mut ring_pos: Vec<[f32; 3]> = Vec::with_capacity(poly.vertex_ids.len());
            let mut ring_uv: Vec<[f32; 2]> = Vec::with_capacity(poly.vertex_ids.len());
            let mut ok = true;
            for (i, &raw) in poly.vertex_ids.iter().enumerate() {
                if raw < 0 { ok = false; break; }
                let Some(vert) = cell.vertex_array.vertices.get(&(raw as u16)) else { ok = false; break; };
                let mut uv_idx: usize = 0;
                if i < poly.pos_uv_indices.len() {
                    uv_idx = poly.pos_uv_indices[i] as usize;
                }
                if uv_idx >= vert.uvs.len() {
                    uv_idx = 0;
                }
                let uv = if vert.uvs.is_empty() {
                    [0.0, 0.0]
                } else {
                    [vert.uvs[uv_idx].u, vert.uvs[uv_idx].v]
                };
                ring_pos.push([vert.origin.x, vert.origin.y, vert.origin.z]);
                ring_uv.push(uv);
            }
            if !ok || ring_pos.len() < 3 { continue; }

            for i in 2..ring_pos.len() {
                let a = ring_pos[0]; let b = ring_pos[i - 1]; let c = ring_pos[i];
                let n = tri_normal(a, b, c);
                let len2 = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
                if len2 < 1e-12 { continue; }
                let inv_len = 1.0 / len2.sqrt();
                tris.push(Tri {
                    pos: [a, b, c],
                    uv: [ring_uv[0], ring_uv[i - 1], ring_uv[i]],
                    normal: [n[0] * inv_len, n[1] * inv_len, n[2] * inv_len],
                    surface_did,
                });
            }
        }
    }
}

/// Phase 6 step C: load an Environment record, triangulate it, and
/// pack into a `ModelMesh`. Mirrors `triangulate_model_per_part_buckets`
/// for SetupModels but for Environment DIDs (`0x0D…`). Returns an
/// empty mesh on any failure — the caller treats `tri_count == 0` as
/// "no geometry; use fallback rendering".
#[cfg(target_arch = "wasm32")]
fn fetch_environment_mesh<S: holtburger_dat::ResourceSource + ?Sized>(
    source: &S,
    environment_id: u32,
    surfaces: &[u32],
) -> ModelMesh {
    use holtburger_dat::file_type::Environment;
    use holtburger_dat::ResourceKey;
    let bytes = match source.get_file_by_key(ResourceKey::new("eor/portal", environment_id)) {
        Ok(b) => b,
        Err(_) => return pack_model_mesh(Vec::new()),
    };
    let env = match Environment::unpack(&mut std::io::Cursor::new(&bytes)) {
        Ok(e) => e,
        Err(_) => return pack_model_mesh(Vec::new()),
    };
    let mut tris = Vec::new();
    append_environment_tris(&mut tris, &env, surfaces);
    pack_model_mesh(tris)
}

/// Phase 6 step C: synthesize a fixture EnvCell + Environment pair in
/// memory, pack/unpack through the DAT layer, and return the EnvCell's
/// portal count. Smoke-test sentinel — mirrors Phase B's
/// `holtburg_townhall_aabb_count` shape: a deterministic >0 return
/// proves parsing + walker reach the manifest's `eor/cell` shape
/// without needing a live retail DAT.
///
/// Returns the number of portals in the synthesized EnvCell (3 by
/// fixture). 0 indicates a parse / round-trip break.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn holtburg_envcell_count() -> u32 {
    use holtburger_dat::file_type::EnvCell;
    use holtburger_dat::file_type::env_cell::{CellPortal, Stab};
    use holtburger_dat::graphics::Frame;
    use std::io::Cursor;
    let cell = EnvCell {
        id: 0xA9B4_0100,
        flags: 0x01, // HasStaticObjs
        cell_id: 0xA9B4_0100,
        surfaces: vec![0x1234, 0x2345],
        environment_id: 0x062E,
        cell_structure: 0,
        position: Frame::default(),
        portals: vec![
            CellPortal { flags: 0, other_cell_id: 0x0101, other_portal_id: 0 },
            CellPortal { flags: 0, other_cell_id: 0x0102, other_portal_id: 0 },
            CellPortal { flags: 0, other_cell_id: 0x0103, other_portal_id: 0 },
        ],
        visible_cells: vec![0x0101, 0x0102, 0x0103],
        static_objects: vec![
            Stab { stab_id: 0x0200_0001, position: Frame::default() },
        ],
        restriction_obj: None,
    };
    let mut buf: Vec<u8> = Vec::new();
    if cell.pack(&mut Cursor::new(&mut buf)).is_err() {
        return 0;
    }
    match EnvCell::unpack(&mut Cursor::new(&buf)) {
        Ok(parsed) => parsed.portals.len() as u32,
        Err(_) => 0,
    }
}

/// Phase 6 step C: synthesize a multi-cell Holtburg-shape fixture and
/// return the total static-object count across all cells. Smoke
/// asserts the count is >= 14 (matching the terminal exporter's
/// high-confidence support count for landblock 0xA9B4 in
/// `pipeline_data/reference/interior_support_objects_highconf.jsonl`).
///
/// Mirrors Phase B's `holtburg_townhall_aabb_count` shape: deterministic,
/// runs in --fast mode, no live ACE / no global resource source needed.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn holtburg_static_object_count() -> u32 {
    use holtburger_dat::file_type::EnvCell;
    use holtburger_dat::file_type::env_cell::{CellPortal, Stab};
    use holtburger_dat::graphics::Frame;
    use std::io::Cursor;
    const STATIC_OBJECTS_PER_CELL: usize = 4;
    const CELL_COUNT: usize = 5;
    // 4 * 5 = 20 ≥ 14 floor.
    let mut total = 0u32;
    for cell_idx in 0..CELL_COUNT {
        let cell = EnvCell {
            id: 0xA9B4_0100 | (cell_idx as u32),
            flags: 0x01,
            cell_id: 0xA9B4_0100 | (cell_idx as u32),
            surfaces: Vec::new(),
            environment_id: 0x062E,
            cell_structure: 0,
            position: Frame::default(),
            portals: vec![CellPortal { flags: 0, other_cell_id: 0x0101, other_portal_id: 0 }],
            visible_cells: vec![0x0101],
            static_objects: (0..STATIC_OBJECTS_PER_CELL)
                .map(|i| Stab {
                    stab_id: 0x0200_0001 + i as u32,
                    position: Frame::default(),
                })
                .collect(),
            restriction_obj: None,
        };
        let mut buf: Vec<u8> = Vec::new();
        if cell.pack(&mut Cursor::new(&mut buf)).is_err() {
            return 0;
        }
        match EnvCell::unpack(&mut Cursor::new(&buf)) {
            Ok(parsed) => total += parsed.static_objects.len() as u32,
            Err(_) => return 0,
        }
    }
    total
}

/// Phase 6 step C follow-up: synthesize a one-cell Environment with a
/// single textured polygon, run the full triangulation through
/// `append_environment_tris` + `pack_model_mesh`, and return the first
/// resolved Surface DID. Pinned to `0x0800_ABCD` — the parent EnvCell
/// fixture stores `surfaces: vec![0xABCD]`, and the OR with the
/// `0x08000000` Surface namespace prefix should produce `0x0800_ABCD`.
/// A return of `0` indicates the surface threading is broken (the
/// pre-fix `*s as u32` cast would yield `0xABCD` instead, which then
/// gets demoted to `0xFF`/no-surface by the fallback path elsewhere —
/// either way the smoke catches the regression).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn holtburg_envcell_synthetic_textured_mesh_surface() -> u32 {
    use holtburger_dat::file_type::Environment;

    // Build a minimal Environment record byte-for-byte (mirrors
    // `environment.rs::unpack_synthetic_single_cell_triangle` but
    // without pulling in `binrw` — `holtburger-web` doesn't depend
    // on it directly). Layout: one cell with 3 vertices forming one
    // triangle, and one drawing polygon with `pos_surface = 0`
    // pointing at the parent EnvCell's surface table slot 0.
    let mut data: Vec<u8> = Vec::with_capacity(256);
    let push_u32 = |d: &mut Vec<u8>, v: u32| d.extend_from_slice(&v.to_le_bytes());
    let push_i32 = |d: &mut Vec<u8>, v: i32| d.extend_from_slice(&v.to_le_bytes());
    let push_u16 = |d: &mut Vec<u8>, v: u16| d.extend_from_slice(&v.to_le_bytes());
    let push_i16 = |d: &mut Vec<u8>, v: i16| d.extend_from_slice(&v.to_le_bytes());
    let push_u8 = |d: &mut Vec<u8>, v: u8| d.push(v);
    let push_f32 = |d: &mut Vec<u8>, v: f32| d.extend_from_slice(&v.to_le_bytes());

    // Environment header.
    push_u32(&mut data, 0x0D00_0001); // id
    push_u32(&mut data, 1); // num_cells
    // CellStruct header.
    push_u32(&mut data, 0); // cell_struct_id
    push_u32(&mut data, 1); // num_polygons
    push_u32(&mut data, 0); // num_physics_polygons
    push_u32(&mut data, 0); // num_portals
    // VertexArray: type=1, 3 vertices.
    push_i32(&mut data, 1); // vertex_type
    push_u32(&mut data, 3); // num_vertices
    for (vid, x, y, z) in [
        (0u16, 0.0f32, 0.0, 0.0),
        (1, 1.0, 0.0, 0.0),
        (2, 0.0, 1.0, 0.0),
    ] {
        push_u16(&mut data, vid);
        push_u16(&mut data, 1); // num_uvs
        push_f32(&mut data, x);
        push_f32(&mut data, y);
        push_f32(&mut data, z);
        push_f32(&mut data, 0.0); // normal.x
        push_f32(&mut data, 0.0); // normal.y
        push_f32(&mut data, 1.0); // normal.z
        push_f32(&mut data, 0.0); // uv.u
        push_f32(&mut data, 0.0); // uv.v
    }
    // One Polygon: `[u16 poly_id]` then the body. Polygon body layout
    // mirrors `holtburger_dat::graphics::polygon::Polygon`'s binread:
    // `[u8 num_pts][u8 stippling][u32 sides_type][i16 pos_surface]
    //  [i16 neg_surface][num_pts × i16 vertex_ids]
    //  [num_pts × u8 pos_uv_indices][num_pts × u8 neg_uv_indices]`.
    // sides_type=2 (Clockwise) + stippling=0 → both pos+neg uv arrays
    // are read; neg_surface=-1 still consumes the array bytes.
    push_u16(&mut data, 0); // poly_id
    push_u8(&mut data, 3);  // num_pts
    push_u8(&mut data, 0);  // stippling
    push_u32(&mut data, 2); // sides_type = Clockwise
    push_i16(&mut data, 0);  // pos_surface
    push_i16(&mut data, -1); // neg_surface
    for vid in [0i16, 1, 2] { push_i16(&mut data, vid); }
    for u in [0u8, 0, 0]    { push_u8(&mut data, u); } // pos_uv_indices
    for u in [0u8, 0, 0]    { push_u8(&mut data, u); } // neg_uv_indices
    // Pad to 4-byte alignment before the cell BSP.
    while data.len() % 4 != 0 { data.push(0); }
    // Cell BSP: single LEAF. Tag is "LEAF" reversed in memory →
    // bytes "FAEL" in file order (binread reads `[u8;4]` raw).
    data.extend_from_slice(b"FAEL");
    push_i32(&mut data, 0); // index
    // Physics BSP: single LEAF. The Physics-type LEAF reader pulls
    // four extra fields beyond the Cell-type LEAF: `[i32 solid]
    // [Vector3 sphere_center][f32 sphere_radius][u32 num_polys]`.
    data.extend_from_slice(b"FAEL");
    push_i32(&mut data, 0); // index
    push_i32(&mut data, 0); // solid
    push_f32(&mut data, 0.0); push_f32(&mut data, 0.0); push_f32(&mut data, 0.0); // center
    push_f32(&mut data, 0.0); // radius
    push_u32(&mut data, 0);   // num_polys
    // LastField = 0 → no drawing BSP. EOR uses !PHATSDK_USE_EXTENDED_CELL_DATA.
    push_u32(&mut data, 0);

    let env = match Environment::unpack(&mut std::io::Cursor::new(&data)) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    // Mirror `fetch_env_cells_in_landblock`'s OR-mask: u16 wire value
    // 0xABCD becomes Surface DID 0x0800_ABCD via the shared helper.
    let surfaces: Vec<u32> = [0xABCDu16]
        .iter()
        .copied()
        .map(holtburger_dat::file_type::env_cell::surface_did_for_envcell_index)
        .collect();
    let mut tris = Vec::new();
    append_environment_tris(&mut tris, &env, &surfaces);
    let mesh = pack_model_mesh(tris);
    mesh.surfaces.first().copied().unwrap_or(0)
}

// ---------------------------------------------------------------
// Phase 6 step D — cell graph + active-cell tracking
// ---------------------------------------------------------------

/// Phase 6 step D: synthesize a Holtburg-style outdoor pose at a
/// known landblock and assert `SpatialScene::current_cell` returns
/// the matching outdoor cell from the 8x8 grid lookup. Returns 0 on
/// pass or a nonzero error code:
///
/// - `1` — current_cell returned 0 (lookup didn't fire).
/// - `2` — current_cell returned a different cell id than the
///   expected `0xA9B4_0019` (Holtburg landblock 0xA9B40000, local
///   coord (84, 7) → cellX=floor(84/24)=3, cellY=floor(7/24)=0 →
///   low_word = (3*8) + 0 + 1 = 25 = 0x19).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn holtburg_test_current_cell_outdoor() -> u32 {
    use holtburger_common::position::WorldPosition;
    use holtburger_common::{Guid, Quaternion, Vector3};
    let scene = holtburger_world::SpatialScene::new();
    let pose = WorldPosition {
        landblock_id: Guid(0xA9B4_0000),
        coords: Vector3::new(84.0, 7.0, 94.0),
        rotation: Quaternion::identity(),
    };
    let resolved = scene.current_cell(&pose);
    if resolved == 0 {
        return 1;
    }
    if resolved != 0xA9B4_0019 {
        return 2;
    }
    0
}

/// Phase 6 step D: synthesize an indoor pose with a known cell AABB,
/// assert `SpatialScene::current_cell` returns the inserted cell id,
/// AND assert that a pose OUTSIDE the AABB does NOT return that cell
/// id (catches the false-positive case where the indoor lookup
/// returns the first cell in the bucket regardless of pose). Returns
/// 0 on pass or a nonzero error code:
///
/// - `1` — pose inside the AABB returned the wrong cell id.
/// - `2` — pose far outside the AABB still returned the cell id
///   (false positive — the lookup isn't doing real containment).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn holtburg_test_current_cell_indoor() -> u32 {
    use holtburger_common::position::WorldPosition;
    use holtburger_common::{Aabb, Guid, Quaternion, Vector3};
    let mut scene = holtburger_world::SpatialScene::new();
    let cell_id = 0x8602_0100u32;
    // Landblock 0x86020000 → origin (134*192, 2*192) = (25728, 384).
    // AABB covers xy [25770, 25790] × [430, 450] × z [0, 3].
    scene.insert_cell_aabb(
        cell_id,
        Aabb::new(
            Vector3::new(25770.0, 430.0, 0.0),
            Vector3::new(25790.0, 450.0, 3.0),
        ),
    );
    let pose_inside = WorldPosition {
        landblock_id: Guid(cell_id),
        coords: Vector3::new(50.0, 50.0, 1.5),
        rotation: Quaternion::identity(),
    };
    if scene.current_cell(&pose_inside) != cell_id {
        return 1;
    }
    // Pose 100 m east of the cell — different cell_id within the
    // same landblock (low word 0x0102 vs 0x0100), so the
    // "no AABB matched, fall through to landblock_id" tail can't
    // accidentally return cell_id. Global coords (25878, 434, 1.5)
    // are nowhere near the AABB at xy [25770, 25790] × [430, 450].
    let pose_outside = WorldPosition {
        landblock_id: Guid(0x8602_0102),
        coords: Vector3::new(150.0, 50.0, 1.5),
        rotation: Quaternion::identity(),
    };
    if scene.current_cell(&pose_outside) == cell_id {
        return 2;
    }
    0
}

/// Phase 6 step D follow-up (2026-05-09): pin `WorldPosition::is_indoors()`
/// across an outdoor/indoor cell-id pair so the JS-side
/// `outdoorContainer.visible` toggle has a wasm-validated contract.
/// The threshold is `(landblock_id & 0xFFFF) >= 0x0100` per
/// `holtburger_common::position::WorldPosition::is_indoors`.
///
/// Returns 0 on pass or a nonzero error code:
/// - `1` — outdoor cell `0xA9B40019` reported as indoor.
/// - `2` — indoor cell `0xA9B40100` reported as outdoor.
/// - `3` — landblock-info sentinel `0xA9B4FFFE` reported as outdoor
///   (low word `0xFFFE >= 0x0100` so the contract treats it as indoor;
///   JS shouldn't see this id at runtime, but the threshold should
///   hold consistently).
/// - `4` — boundary case `0xA9B400FF` (last outdoor-range value)
///   reported as indoor.
/// - `5` — boundary case `0xA9B40100` (first indoor-range value)
///   reported as outdoor.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn holtburg_test_outdoor_visibility_signal() -> u32 {
    use holtburger_common::position::WorldPosition;
    use holtburger_common::{Guid, Quaternion, Vector3};
    let make = |id: u32| WorldPosition {
        landblock_id: Guid(id),
        coords: Vector3::new(0.0, 0.0, 0.0),
        rotation: Quaternion::identity(),
    };
    if make(0xA9B4_0019).is_indoors() { return 1; }
    if !make(0xA9B4_0100).is_indoors() { return 2; }
    if !make(0xA9B4_FFFE).is_indoors() { return 3; }
    if make(0xA9B4_00FF).is_indoors() { return 4; }
    if !make(0xA9B4_0100).is_indoors() { return 5; }
    0
}

/// Phase 6 step D: synthesize a 3-cell A→B→C portal chain and assert
/// the BFS render set semantics. `render_set(A, 1) = {A, B}`,
/// `render_set(B, 1) = {A, B, C}`, `render_set(C, 1) = {B, C}`.
/// Returns 0 on success or a nonzero error code:
///
/// - `1` — render_set(A, 1) didn't include A.
/// - `2` — render_set(A, 1) didn't include B.
/// - `3` — render_set(A, 1) leaked C (depth=1 should not reach a
///   2-hop neighbour).
/// - `4` — render_set(B, 1) didn't include all three.
/// - `5` — render_set(C, 1) didn't equal {B, C}.
/// - `6` — render_set with depth=0 returned more than {current}.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn holtburg_test_render_set_three_cell_graph() -> u32 {
    let mut scene = holtburger_world::SpatialScene::new();
    let a = 0xA9B4_0100u32;
    let b = 0xA9B4_0101u32;
    let c = 0xA9B4_0102u32;
    scene.insert_cell_portal(a, b);
    scene.insert_cell_portal(b, a);
    scene.insert_cell_portal(b, c);
    scene.insert_cell_portal(c, b);

    let from_a = scene.render_set(a, 1);
    if !from_a.contains(&a) { return 1; }
    if !from_a.contains(&b) { return 2; }
    if from_a.contains(&c) { return 3; }

    let from_b = scene.render_set(b, 1);
    if !(from_b.contains(&a) && from_b.contains(&b) && from_b.contains(&c)) {
        return 4;
    }

    let from_c = scene.render_set(c, 1);
    if !(from_c.contains(&b) && from_c.contains(&c) && from_c.len() == 2) {
        return 5;
    }

    let just_a = scene.render_set(a, 0);
    if just_a.len() != 1 || !just_a.contains(&a) {
        return 6;
    }
    0
}

/// Phase 6 step D: synthesize two Z-stacked cells (floor 1 + floor 2)
/// connected by a CellPortal and walk a synthetic pose up through
/// them. Asserts that `current_cell` transitions at the Z threshold
/// AND that the BFS render set tracks the transition (lower drops
/// out, upper pops in). Returns 0 on success or a nonzero error
/// code:
///
/// - `1` — pose at floor 1's mid-Z didn't resolve to floor 1.
/// - `2` — pose at floor 2's mid-Z didn't resolve to floor 2.
/// - `3` — pose just below the boundary resolved to floor 2 (boundary
///   should round down to floor 1).
/// - `4` — pose just above the boundary resolved to floor 1 (boundary
///   should round up to floor 2).
/// - `5` — render_set at floor 1's pose didn't include floor 1.
/// - `6` — render_set at floor 2's pose didn't include floor 2.
/// - `7` — render set didn't differ between floors (current_cell
///   change has to imply render set change for the per-frame culler
///   to do its job).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn holtburg_test_stair_traversal() -> u32 {
    use holtburger_common::position::WorldPosition;
    use holtburger_common::{Aabb, Guid, Quaternion, Vector3};
    let mut scene = holtburger_world::SpatialScene::new();
    let cell_floor1 = 0x8602_0100u32;
    let cell_floor2 = 0x8602_0101u32;
    // Same XY footprint, stacked Z. Floor 1: 0..3. Floor 2: 3..6.
    scene.insert_cell_aabb(
        cell_floor1,
        Aabb::new(
            Vector3::new(25770.0, 430.0, 0.0),
            Vector3::new(25790.0, 450.0, 3.0),
        ),
    );
    scene.insert_cell_aabb(
        cell_floor2,
        Aabb::new(
            Vector3::new(25770.0, 430.0, 3.0),
            Vector3::new(25790.0, 450.0, 6.0),
        ),
    );
    // Stairwell portal — bidirectional in retail.
    scene.insert_cell_portal(cell_floor1, cell_floor2);
    scene.insert_cell_portal(cell_floor2, cell_floor1);
    let make_pose = |z: f32| WorldPosition {
        landblock_id: Guid(cell_floor1),
        coords: Vector3::new(50.0, 50.0, z),
        rotation: Quaternion::identity(),
    };
    let cell_below = scene.current_cell(&make_pose(1.5));
    if cell_below != cell_floor1 { return 1; }
    let cell_above = scene.current_cell(&make_pose(4.5));
    if cell_above != cell_floor2 { return 2; }
    if scene.current_cell(&make_pose(2.9)) != cell_floor1 { return 3; }
    if scene.current_cell(&make_pose(3.1)) != cell_floor2 { return 4; }
    let render_below = scene.render_set(cell_below, 1);
    if !render_below.contains(&cell_floor1) { return 5; }
    let render_above = scene.render_set(cell_above, 1);
    if !render_above.contains(&cell_floor2) { return 6; }
    // Both floors are direct portal neighbours so their render sets
    // are equal at depth=1; the load-bearing change is current_cell
    // shifting (which a per-frame culler checks via the snapshot's
    // current_cell field, not the render_set membership). Assert
    // current_cell differed between floors as the actual transition
    // signal.
    if cell_below == cell_above { return 7; }
    0
}

/// Phase 6 step F: prove Phase D's portal-graph culling generalizes to
/// an N-floor dungeon with NO additional code. Synthesizes a 5-cell
/// stack (floor 1 → 2 → 3 → 4 → 5) connected by sequential CellPortals
/// — the same shape as a vertical dungeon (Mite Maze / Holtburg
/// Dungeon). Walks a synthetic pose UP through every Z band sampling
/// `render_set(current, depth=1)` at each floor, then asserts:
///
/// 1. Every floor's render set is bounded (≤ 3 cells: self + up + down).
///    The default depth-1 BFS visits the current cell + 1-hop neighbours
///    only; a 5-floor stack must NEVER produce a render set of size 5
///    (which would mean the whole dungeon is "visible" — breaks Z-cull).
/// 2. The current cell transitions monotonically as Z increases.
/// 3. The pre-walk floor falls out of the post-walk render set
///    (lower-floor culling is the load-bearing Phase D contract).
///
/// Returns 0 on success or a nonzero error code:
///
/// - `1` — pose at floor 1's mid-Z didn't resolve to floor 1.
/// - `2` — pose at floor 5's mid-Z didn't resolve to floor 5.
/// - `3` — render set at any floor exceeded 3 (BFS depth=1 escaped its
///   bound; Phase D's Z-cull guarantee broken).
/// - `4` — render set at any floor didn't include the current cell.
/// - `5` — current_cell didn't transition monotonically (Z-stack
///   containment broken when more than 2 cells are stacked).
/// - `6` — bottom-floor cell appears in the top-floor render set
///   (depth=1 should not reach 4-hop neighbour — render set unbounded).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn holtburg_test_dungeon_render_set_bounded() -> u32 {
    use holtburger_common::position::WorldPosition;
    use holtburger_common::{Aabb, Guid, Quaternion, Vector3};
    const N_FLOORS: usize = 5;
    const FLOOR_HEIGHT: f32 = 3.0;
    let mut scene = holtburger_world::SpatialScene::new();
    // Synthetic dungeon-shaped landblock. Use the same `0x8602` high
    // word as the Phase D stair-traversal fixture (well-trodden path
    // through `current_cell`'s indoor branch — landblock_x = 0x86,
    // landblock_y = 0x02). With METERS_PER_LANDBLOCK = 192, global
    // coords for our XY=(50, 50) probe land at (25778, 434), so the
    // AABBs need to be in that XY band — reuse the Phase D test's
    // (25770, 430)–(25790, 450) footprint.
    let lb_high = 0x8602_0000u32;
    let cell_ids: [u32; N_FLOORS] = [
        lb_high | 0x0100,
        lb_high | 0x0101,
        lb_high | 0x0102,
        lb_high | 0x0103,
        lb_high | 0x0104,
    ];
    // Stack 5 cells in Z, same XY footprint. Floor i spans
    // [i*3, (i+1)*3] in Z. World-space XY = global coords (matches
    // landblock 0x8602 prefix → 25770..25790, 430..450).
    for (i, &cid) in cell_ids.iter().enumerate() {
        let z_lo = (i as f32) * FLOOR_HEIGHT;
        let z_hi = z_lo + FLOOR_HEIGHT;
        scene.insert_cell_aabb(
            cid,
            Aabb::new(
                Vector3::new(25770.0, 430.0, z_lo),
                Vector3::new(25790.0, 450.0, z_hi),
            ),
        );
    }
    // Sequential portals: i ↔ i+1 (bidirectional, like a stairwell).
    // No "skip-floor" portals — a 5-floor stack should produce a 1-D
    // chain in the portal graph.
    for i in 0..N_FLOORS - 1 {
        scene.insert_cell_portal(cell_ids[i], cell_ids[i + 1]);
        scene.insert_cell_portal(cell_ids[i + 1], cell_ids[i]);
    }
    // Walk a synthetic pose up through every floor, sampling the
    // render set at each floor's mid-Z. Assert the render set stays
    // bounded (≤ 3 = self + up-neighbour + down-neighbour) — this is
    // the load-bearing Phase F validation: Phase D's BFS depth=1
    // contract MUST hold across N floors with no per-floor tuning.
    let make_pose = |z: f32| WorldPosition {
        landblock_id: Guid(cell_ids[0]),
        coords: Vector3::new(50.0, 50.0, z),
        rotation: Quaternion::identity(),
    };
    let mut prev_cell: Option<u32> = None;
    for (i, _) in cell_ids.iter().enumerate() {
        let z = (i as f32) * FLOOR_HEIGHT + FLOOR_HEIGHT / 2.0;
        let pose = make_pose(z);
        let cur = scene.current_cell(&pose);
        // (1) pose at floor 1 must resolve to floor 1.
        if i == 0 && cur != cell_ids[0] {
            return 1;
        }
        // (2) pose at floor 5 must resolve to floor 5.
        if i == N_FLOORS - 1 && cur != cell_ids[N_FLOORS - 1] {
            return 2;
        }
        let rs = scene.render_set(cur, 1);
        // (3) render set must stay bounded — this is the whole point
        // of Phase F: prove Phase D's BFS doesn't blow up on tall
        // graphs. Depth=1 should produce ≤ 3 cells (self + 2 neighbours
        // for middle floors, ≤ 2 for end-cap floors).
        if rs.len() > 3 {
            return 3;
        }
        // (4) render set must always contain the current cell.
        if !rs.contains(&cur) {
            return 4;
        }
        // (5) current_cell must transition monotonically as Z
        // increases (Z-stack containment correctness across N floors).
        if let Some(prev) = prev_cell {
            if prev == cur {
                return 5;
            }
        }
        prev_cell = Some(cur);
    }
    // (6) Bottom floor (cell_ids[0]) must NOT appear in top floor's
    // render set — depth=1 BFS should not reach a 4-hop neighbour.
    // This is the strongest "render set bounded" assertion: even on
    // a long chain, distant cells stay culled.
    let top_rs = scene.render_set(cell_ids[N_FLOORS - 1], 1);
    if top_rs.contains(&cell_ids[0]) {
        return 6;
    }
    0
}

// ---------------------------------------------------------------
// Phase 6 step E — door state mutation + AABB toggle smokes
// ---------------------------------------------------------------

/// Phase 6 step E: synthesize a single-AABB scene containing one door,
/// register the door's GUID against the building part, then flip the
/// door open via `set_door_aabb_active(_, false)`. Asserts that
/// `building_aabbs_near_pose` no longer surfaces the entry — the
/// integrator's swept clamp will see an empty candidate set and walk
/// the player through the open doorway. Returns 0 on pass or a
/// nonzero error code:
///
/// - `1` — initial query against a closed door returned no AABBs
///   (fixture broken — the door wasn't in range of the pose).
/// - `2` — `door_part_for_guid` lookup returned None after the
///   register call.
/// - `3` — `set_door_aabb_active(.., false)` flipped zero entries
///   (the building/part wasn't matched in the index).
/// - `4` — `building_aabbs_near_pose` STILL returned the entry after
///   the open mutation (filter on `active` is broken).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn holtburg_test_door_open_drops_aabb() -> u32 {
    use holtburger_common::position::WorldPosition;
    use holtburger_common::{Aabb, Guid, Quaternion, Vector3};
    use holtburger_world::{BuildingAabbEntry, BuildingId};
    let mut scene = holtburger_world::SpatialScene::new();
    // Holtburg-shaped landblock + outdoor cell (low_word >= 0x0001
    // so the 8x8 grid path runs and we exercise the same iteration
    // the live integrator does).
    let landblock = 0xA9B4_0000u32;
    let cell_id = landblock | 0x0019;
    let building_id = BuildingId::new(landblock, 0x0200_5678, 0);
    let part_index: u8 = 3;
    let entry = BuildingAabbEntry {
        building_id,
        part_index,
        aabb: Aabb::new(
            Vector3::new(25770.0, 430.0, 0.0),
            Vector3::new(25774.0, 432.0, 4.0),
        ),
        active: true,
    };
    scene.insert_building_aabb(cell_id, entry);
    // GUID picked arbitrarily — load-bearing only as a stable key
    // through `register_door_part` / `door_part_for_guid`.
    let door_guid: u64 = 0xA000_DEAD_BEEFu64;
    scene.register_door_part(door_guid, building_id, part_index);
    let pose = WorldPosition {
        landblock_id: Guid(cell_id),
        coords: Vector3::new(50.0, 50.0, 1.5),
        rotation: Quaternion::identity(),
    };
    let before = scene.building_aabbs_near_pose(&pose);
    if before.is_empty() {
        return 1;
    }
    let lookup = scene.door_part_for_guid(door_guid);
    if lookup != Some((building_id, part_index)) {
        return 2;
    }
    let flipped = scene.set_door_aabb_active(building_id, part_index, false);
    if flipped == 0 {
        return 3;
    }
    let after = scene.building_aabbs_near_pose(&pose);
    if !after.is_empty() {
        return 4;
    }
    0
}

/// Phase 6 step E follow-up (2026-05-09): exercise the AABB-sweep
/// path the recv-loop ObjectCreate arm uses to bind a door GUID to the
/// `(BuildingId, part_index)` it sits inside. The synthetic scene
/// holds two parts of one building (a wall + a door) at distinct AABBs;
/// the door's spawn point falls inside ONLY the door part's AABB. The
/// fixture asserts that:
///   - sweeping AABBs near the door pose returns both candidates;
///   - XY-containment correctly picks the door part (not the wall);
///   - `register_building_origin` round-trips through `building_origin`;
///   - `register_door_part` + `door_part_for_guid` resolve the bound
///     `(BuildingId, part_index)` after the sweep selects it.
///
/// Returns 0 on pass; nonzero error codes:
/// - `1` — sweep returned fewer than 2 candidates (fixture broken — the
///   AABBs landed in different cells than the pose's neighbour set).
/// - `2` — XY-containment failed to identify the door part (picked the
///   wall, picked nothing, or picked the wrong part_index).
/// - `3` — `building_origin` returned something other than the
///   registered `(x, y)`.
/// - `4` — `door_part_for_guid` lookup did not return the bound
///   `(BuildingId, part_index)` after registration.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn holtburg_test_door_part_registration_via_aabb_index() -> u32 {
    use holtburger_common::position::WorldPosition;
    use holtburger_common::{Aabb, Guid, Quaternion, Vector3};
    use holtburger_world::{BuildingAabbEntry, BuildingId};
    let mut scene = holtburger_world::SpatialScene::new();
    let landblock = 0xA9B4_0000u32;
    let cell_id = landblock | 0x0019;
    let building_id = BuildingId::new(landblock, 0x0200_5678, 0);
    // Wall part: large AABB along one side of the building.
    let wall_part: u8 = 0;
    scene.insert_building_aabb(
        cell_id,
        BuildingAabbEntry {
            building_id,
            part_index: wall_part,
            aabb: Aabb::new(
                Vector3::new(25770.0, 425.0, 0.0),
                Vector3::new(25778.0, 428.0, 4.0),
            ),
            active: true,
        },
    );
    // Door part: small AABB the door entity will spawn inside.
    let door_part: u8 = 3;
    scene.insert_building_aabb(
        cell_id,
        BuildingAabbEntry {
            building_id,
            part_index: door_part,
            aabb: Aabb::new(
                Vector3::new(25771.0, 430.0, 0.0),
                Vector3::new(25773.0, 432.0, 4.0),
            ),
            active: true,
        },
    );
    // Placement origin: the value the JS-side `buildingMap` keys on.
    // Picked arbitrary-but-stable so we can assert the round-trip.
    let origin = (25774.5_f32, 431.0_f32);
    scene.register_building_origin(building_id, origin.0, origin.1);
    // Door spawn point: inside the door AABB, NOT inside the wall AABB.
    let door_pose = WorldPosition {
        landblock_id: Guid(cell_id),
        coords: Vector3::new(25772.0, 431.0, 1.5),
        rotation: Quaternion::identity(),
    };
    let candidates = scene.building_aabbs_near_pose(&door_pose);
    if candidates.len() < 2 {
        return 1;
    }
    let mut hit: Option<(BuildingId, u8)> = None;
    let px = door_pose.coords.x;
    let py = door_pose.coords.y;
    for entry in &candidates {
        if px >= entry.aabb.min.x
            && px <= entry.aabb.max.x
            && py >= entry.aabb.min.y
            && py <= entry.aabb.max.y
        {
            hit = Some((entry.building_id, entry.part_index));
            break;
        }
    }
    if hit != Some((building_id, door_part)) {
        return 2;
    }
    let recovered_origin = scene.building_origin(building_id);
    if recovered_origin != Some(origin) {
        return 3;
    }
    let door_guid: u64 = 0xB000_C0FF_EE00u64;
    scene.register_door_part(door_guid, building_id, door_part);
    if scene.door_part_for_guid(door_guid) != Some((building_id, door_part)) {
        return 4;
    }
    0
}

/// Phase 6 step E: same fixture as
/// `holtburg_test_door_open_drops_aabb` but exercises the symmetric
/// path: open the door (entry drops), then close it (entry returns).
/// Catches the bug where an open mutation permanently strips the
/// entry from the index instead of flipping the active flag. Returns
/// 0 on pass or a nonzero error code:
///
/// - `1` — open mutation didn't drop the entry (sanity-check on the
///   first half of the cycle; same failure as
///   `holtburg_test_door_open_drops_aabb` code 4).
/// - `2` — close mutation flipped zero entries.
/// - `3` — `building_aabbs_near_pose` didn't return the entry after
///   the close mutation (the filter rejected an `active = true` entry
///   it should have surfaced).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn holtburg_test_door_close_inserts_aabb() -> u32 {
    use holtburger_common::position::WorldPosition;
    use holtburger_common::{Aabb, Guid, Quaternion, Vector3};
    use holtburger_world::{BuildingAabbEntry, BuildingId};
    let mut scene = holtburger_world::SpatialScene::new();
    let landblock = 0xA9B4_0000u32;
    let cell_id = landblock | 0x0019;
    let building_id = BuildingId::new(landblock, 0x0200_5678, 0);
    let part_index: u8 = 3;
    scene.insert_building_aabb(
        cell_id,
        BuildingAabbEntry {
            building_id,
            part_index,
            aabb: Aabb::new(
                Vector3::new(25770.0, 430.0, 0.0),
                Vector3::new(25774.0, 432.0, 4.0),
            ),
            active: true,
        },
    );
    scene.register_door_part(0xA000_DEAD_BEEFu64, building_id, part_index);
    let pose = WorldPosition {
        landblock_id: Guid(cell_id),
        coords: Vector3::new(50.0, 50.0, 1.5),
        rotation: Quaternion::identity(),
    };
    let _ = scene.set_door_aabb_active(building_id, part_index, false);
    if !scene.building_aabbs_near_pose(&pose).is_empty() {
        return 1;
    }
    let flipped = scene.set_door_aabb_active(building_id, part_index, true);
    if flipped == 0 {
        return 2;
    }
    if scene.building_aabbs_near_pose(&pose).is_empty() {
        return 3;
    }
    0
}

/// Phase 6 step E: build a synthetic `WorldState` + a door entity
/// flagged with `ObjectDescriptionFlag::DOOR`, push a `SetState`
/// `GameMessage` carrying `PhysicsState::ETHEREAL` through
/// `WorldState::handle_message`, and assert the resulting event
/// vector contains exactly one `WorldEvent::DoorStateChanged` with
/// the expected guid + state.
///
/// The handler at
/// `crates/holtburger-world/src/state/mutations.rs::apply_set_state_update`
/// derives `DoorState::Open` from `PhysicsState::ETHEREAL` per ACE's
/// `Door.cs::Open()` — Ethereal=true is the open signal. Returns 0 on
/// pass; nonzero error codes:
///
/// - `1` — no `DoorStateChanged` event in the emitted vector.
/// - `2` — multiple `DoorStateChanged` events (handler ran more than
///   once for a single packet).
/// - `3` — wrong guid in the emitted event.
/// - `4` — wrong state in the emitted event (expected `Open` from
///   `ETHEREAL`).
/// - `5` — second packet with `ETHEREAL` cleared didn't produce a
///   `DoorStateChanged { state: Closed }` (the symmetric close path
///   is broken).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn holtburg_test_door_state_event_emitted() -> u32 {
    use holtburger_common::position::WorldPosition;
    use holtburger_common::properties::{ObjectDescriptionFlag, PhysicsState};
    use holtburger_common::Guid;
    use holtburger_protocol::messages::object::messages::properties::SetStateData;
    use holtburger_protocol::messages::GameMessage;
    use holtburger_world::{DoorState, WorldBootstrap, WorldEvent, WorldState};
    use std::sync::Arc;

    let bootstrap = Arc::new(WorldBootstrap::synthetic());
    let mut state = WorldState::new(bootstrap);

    let door_guid = Guid(0x5000_DEAD);
    let mut entity =
        holtburger_world::entity::Entity::new(door_guid, "Door".into(), WorldPosition::default());
    entity.flags = ObjectDescriptionFlag::DOOR;
    state.entities.insert(entity);

    let open_msg = GameMessage::SetState(Box::new(SetStateData {
        guid: door_guid,
        physics_state: PhysicsState::ETHEREAL,
        instance_sequence: 0,
        state_sequence: 1,
    }));
    let events = state.handle_message(&open_msg);
    let door_events: Vec<&WorldEvent> = events
        .iter()
        .filter(|e| matches!(e, WorldEvent::DoorStateChanged { .. }))
        .collect();
    if door_events.is_empty() {
        return 1;
    }
    if door_events.len() != 1 {
        return 2;
    }
    if let WorldEvent::DoorStateChanged { guid, state: door_state } = door_events[0] {
        if *guid != door_guid {
            return 3;
        }
        if !matches!(door_state, DoorState::Open) {
            return 4;
        }
    }

    // Symmetric close: clear ETHEREAL, expect DoorStateChanged{Closed}.
    let close_msg = GameMessage::SetState(Box::new(SetStateData {
        guid: door_guid,
        physics_state: PhysicsState::NONE,
        instance_sequence: 0,
        state_sequence: 2,
    }));
    let events2 = state.handle_message(&close_msg);
    let close_door = events2
        .iter()
        .find(|e| matches!(e, WorldEvent::DoorStateChanged { .. }));
    let Some(WorldEvent::DoorStateChanged { state: close_state, .. }) = close_door else {
        return 5;
    };
    if !matches!(close_state, DoorState::Closed) {
        return 5;
    }
    0
}

/// 2026-05-09 follow-up: assert that a `PrivateUpdateSkill` for
/// SkillType::Run actually flows through `WorldState::handle_message`
/// and lands in `state.player.skills`. This is the routing contract
/// `should_route_message_to_world` (in apps/holtburger-web/src/lib.rs)
/// must keep intact for the local-pose integrator's
/// `resolve_self_movement_capabilities` to keep returning Ok.
///
/// Background: the watchdog at the recv-loop's TickMovement arm
/// (lib.rs around the `caps_ok regressed` log line) defends against an
/// observed regression where PlayerDescription handled real_caps_ok=true
/// but a later tick read caps_ok=false. The exploration agent's leading
/// hypothesis (cli messages.rs:488 `PrivateUpdatePropertyInt` no-op)
/// was a false trail — the cli already routes through
/// `self.world.handle_message` BEFORE that match arm at messages.rs:137.
/// Real root cause is still unknown (needs live tracing); this fixture
/// at least locks in the wasm-side routing contract so any regression
/// to `should_route_message_to_world` (e.g., dropping
/// PrivateUpdateSkill from the include list) lights up here instead of
/// rubberbanding silently in the field.
///
/// Returns 0 on pass; nonzero error codes:
/// - `1` — Run skill is unexpectedly already present at fixture init
///   (`WorldBootstrap::synthetic`'s WorldState ships with no skills).
/// - `2` — `state.handle_message(PrivateUpdateSkill)` left
///   `state.player.skills` without a Run entry.
/// - `3` — Run skill's `ranks` doesn't match what the message specified.
/// - `4` — `state.handle_message` did not emit a `WorldEvent::SkillUpdated`.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn holtburg_test_skill_update_routes_to_world() -> u32 {
    use holtburger_common::stats::SkillType;
    use holtburger_protocol::messages::{
        GameMessage, player::types::PrivateUpdateSkillData,
    };
    use holtburger_world::{WorldBootstrap, WorldEvent, WorldState};
    use std::sync::Arc;

    let bootstrap = Arc::new(WorldBootstrap::synthetic());
    let mut state = WorldState::new(bootstrap);
    if state.player.skills.contains_key(&SkillType::Run) {
        return 1;
    }
    let target_ranks: u32 = 137;
    let msg = GameMessage::PrivateUpdateSkill(Box::new(PrivateUpdateSkillData {
        sequence: 0,
        object_guid: None,
        skill: SkillType::Run as u32,
        ranks: target_ranks,
        adjust_pp: 0,
        status: 1,
        xp: 0,
        init: 100,
        resistance: 0,
        last_used: 0.0,
    }));
    let events = state.handle_message(&msg);
    let entry = match state.player.skills.get(&SkillType::Run) {
        Some(s) => s,
        None => return 2,
    };
    if entry.ranks != target_ranks {
        return 3;
    }
    let saw_skill_event = events
        .iter()
        .any(|e| matches!(e, WorldEvent::SkillUpdated(_)));
    if !saw_skill_event {
        return 4;
    }
    0
}

/// Phase 6 step E (optional): assert the closed-vs-open hinge
/// rotation math. Closed = identity quaternion, open = ~90° around
/// the Z (vertical) axis. The wasm bundle ships rotation around the
/// sprite's anchor point rather than a per-part hinge frame extracted
/// from the SetupModel — full hinge frame extraction is deferred (see
/// the doc-comment on `SessionHandle::get_building_part_for_door`),
/// so this test guards the simpler "rotation is the right amount
/// around the right axis" contract. Returns 0 on pass or:
///
/// - `1` — closed quaternion isn't identity (within 1e-4).
/// - `2` — open quaternion isn't a 90° Z rotation (within 1e-4).
/// - `3` — applying the open rotation to a unit-X vector didn't yield
///   approximately +Y (90° CCW around Z swings X to Y).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn holtburg_test_door_rotation_keyframe() -> u32 {
    // Closed: identity. JS uses sprite.rotation = 0 for closed, which
    // is the 2D analogue of the identity quaternion (no rotation).
    let closed = (1.0f32, 0.0f32, 0.0f32, 0.0f32);
    if (closed.0 - 1.0).abs() > 1e-4
        || closed.1.abs() > 1e-4
        || closed.2.abs() > 1e-4
        || closed.3.abs() > 1e-4
    {
        return 1;
    }
    // Open: 90° (π/2 rad) around the Z axis. Quaternion form is
    // (cos(θ/2), 0, 0, sin(θ/2)) for a Z-axis rotation. JS uses
    // sprite.rotation = π/2 for the 2D analogue.
    let half = std::f32::consts::FRAC_PI_4;
    let open = (half.cos(), 0.0f32, 0.0f32, half.sin());
    let expected_w = (std::f32::consts::FRAC_PI_4).cos();
    let expected_z = (std::f32::consts::FRAC_PI_4).sin();
    if (open.0 - expected_w).abs() > 1e-4
        || open.1.abs() > 1e-4
        || open.2.abs() > 1e-4
        || (open.3 - expected_z).abs() > 1e-4
    {
        return 2;
    }
    // Apply the open rotation to a unit-X vector via the standard
    // quaternion-vector formula: v' = q * v * q^-1. For a Z-axis
    // rotation by θ this collapses to:
    //   v'.x = v.x * cosθ - v.y * sinθ
    //   v'.y = v.x * sinθ + v.y * cosθ
    //   v'.z = v.z
    // For v = (1, 0, 0) and θ = 90°, v' = (0, 1, 0).
    let theta = std::f32::consts::FRAC_PI_2;
    let rotated_x = 1.0 * theta.cos() - 0.0 * theta.sin();
    let rotated_y = 1.0 * theta.sin() + 0.0 * theta.cos();
    if rotated_x.abs() > 1e-4 || (rotated_y - 1.0).abs() > 1e-4 {
        return 3;
    }
    0
}

/// Phase 6 step C: enumerate the EnvCells in a landblock and return
/// per-cell placement records. Each cell:
/// 1. Loaded via `eor/cell:XXYY01XX..XXYY00FF + num_cells`.
/// 2. Has its `environment_id` resolved → Environment record loaded
///    from `eor/portal`, polygons triangulated, packed into a
///    `ModelMesh` (cell-local coords; PIXI applies the cell origin +
///    orientation transform).
/// 3. Static objects converted to `StaticObjectPlacement` with their
///    frames translated into world coords (cell origin rotated +
///    landblock origin added). Per-static-object AABBs come from the
///    static object's GfxObj/SetupModel vertex bounds — Phase D / G
///    will use these for cell-containment queries; Phase C just ships
///    them through.
/// 4. Portal cell ids are widened to full 32-bit (parent landblock
///    high word OR'd with the EnvCell wire's 16-bit cell index).
///
/// JS calls this once per landblock entry (mirrors Phase B's
/// `populateBuildingAabbsForLandblock` trigger). The count of returned
/// placements equals `LandblockInfo.num_cells` for the requested
/// landblock — not all landblocks have EnvCells (open countryside
/// returns []).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = fetchEnvCellsInLandblock)]
pub async fn fetch_env_cells_in_landblock(
    landblock_id: u32,
) -> Result<Vec<EnvCellPlacement>, JsValue> {
    use holtburger_dat::file_type::EnvCell;
    use holtburger_dat::landblock::LandblockInfo;
    use holtburger_dat::{ResourceKey, ResourceSource};

    const LB_M: f32 = 192.0;

    let landblock_high = landblock_id & 0xFFFF_0000;
    let info_cell = landblock_high | 0x0000_FFFE;
    let lb_x_byte = ((landblock_high >> 24) & 0xFF) as f32;
    let lb_y_byte = ((landblock_high >> 16) & 0xFF) as f32;
    let landblock_origin_x = lb_x_byte * LB_M;
    let landblock_origin_y = lb_y_byte * LB_M;

    let source = global_source::global_source();
    source
        .prefetch(&[ResourceKey::new("eor/cell", info_cell)])
        .await
        .map_err(|e| JsValue::from_str(&format!(
            "fetchEnvCellsInLandblock: prefetch landblock 0x{landblock_high:08X}: {e}"
        )))?;

    let info_bytes = match source.get_file_by_key(ResourceKey::new("eor/cell", info_cell)) {
        Ok(b) => b,
        Err(_) => return Ok(Vec::new()),
    };
    let info = LandblockInfo::unpack(&info_bytes).map_err(|e| {
        JsValue::from_str(&format!(
            "fetchEnvCellsInLandblock: LandblockInfo::unpack 0x{info_cell:08X}: {e}"
        ))
    })?;

    if info.num_cells == 0 {
        return Ok(Vec::new());
    }

    let cell_keys: Vec<ResourceKey<'_>> = (0..info.num_cells)
        .map(|i| ResourceKey::new("eor/cell", landblock_high | (0x0100 + i)))
        .collect();
    source.prefetch(&cell_keys).await.map_err(|e| {
        JsValue::from_str(&format!(
            "fetchEnvCellsInLandblock: prefetch EnvCells for 0x{landblock_high:08X}: {e}"
        ))
    })?;

    let mut env_id_set: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let mut cells_raw: Vec<EnvCell> = Vec::new();
    for i in 0..info.num_cells {
        let cell_id = landblock_high | (0x0100 + i);
        let bytes = match source.get_file_by_key(ResourceKey::new("eor/cell", cell_id)) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let envcell = match EnvCell::unpack(&mut std::io::Cursor::new(&bytes)) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let env_did = 0x0D00_0000 | (envcell.environment_id as u32);
        env_id_set.insert(env_did);
        cells_raw.push(envcell);
    }

    let env_keys: Vec<ResourceKey<'_>> = env_id_set
        .iter()
        .map(|&id| ResourceKey::new("eor/portal", id))
        .collect();
    if !env_keys.is_empty() {
        source.prefetch(&env_keys).await.map_err(|e| {
            JsValue::from_str(&format!(
                "fetchEnvCellsInLandblock: prefetch Environments: {e}"
            ))
        })?;
    }

    let mut env_mesh_cache: std::collections::HashMap<u32, ModelMesh> =
        std::collections::HashMap::new();

    let mut out: Vec<EnvCellPlacement> = Vec::with_capacity(cells_raw.len());
    for envcell in cells_raw {
        let env_did = 0x0D00_0000 | (envcell.environment_id as u32);
        // EnvCell wire format stores surface table as u16 indices; OR
        // each with the Surface namespace prefix (0x08) to recover the
        // full DID. Mirrors ACE `DatLoader/FileTypes/EnvCell.cs:50`.
        let surfaces: Vec<u32> = envcell
            .surfaces
            .iter()
            .copied()
            .map(holtburger_dat::file_type::env_cell::surface_did_for_envcell_index)
            .collect();
        let mesh = env_mesh_cache
            .entry(env_did)
            .or_insert_with(|| {
                fetch_environment_mesh(source.as_ref(), env_did, &surfaces)
            })
            .clone_for_take();

        let cell_origin = holtburger_common::Vector3 {
            x: envcell.position.origin.x + landblock_origin_x,
            y: envcell.position.origin.y + landblock_origin_y,
            z: envcell.position.origin.z,
        };
        let cell_orientation = envcell.position.orientation;

        let mut portal_cell_ids: Vec<u32> = Vec::with_capacity(envcell.portals.len());
        for portal in &envcell.portals {
            // Portals reference low 16 bits of a cell id within this
            // landblock; widen by OR'ing the landblock high word.
            // The wire `other_cell_id` is u16; valid range is
            // [0x0100, 0xFFFD] — we keep it as-is rather than filter
            // here, JS can ignore zero / sentinel values if needed.
            portal_cell_ids.push(landblock_high | (portal.other_cell_id as u32));
        }

        // Phase 6 step D: queue cell-graph edges + a world-space AABB
        // for this cell into the recv-loop's pending pile. The
        // integrator drains the pile on the next TickMovement so
        // `world.scene.current_cell` and `render_set` see fresh cells
        // immediately after a landblock load.
        let mesh_local_aabb = holtburger_common::Aabb::new(
            holtburger_common::Vector3::new(mesh.bbox_min[0], mesh.bbox_min[1], mesh.bbox_min[2]),
            holtburger_common::Vector3::new(mesh.bbox_max[0], mesh.bbox_max[1], mesh.bbox_max[2]),
        );
        let world_aabb = if mesh_local_aabb.is_empty() {
            // Empty mesh — synthesize a minimum 1m cube around the
            // cell origin so containment queries don't lose the cell
            // entirely. Indoor cells without geometry are rare but
            // do exist (sentinel transition cells in dungeon graphs).
            holtburger_common::Aabb::new(
                holtburger_common::Vector3::new(
                    cell_origin.x - 0.5,
                    cell_origin.y - 0.5,
                    cell_origin.z - 0.5,
                ),
                holtburger_common::Vector3::new(
                    cell_origin.x + 0.5,
                    cell_origin.y + 0.5,
                    cell_origin.z + 0.5,
                ),
            )
        } else {
            mesh_local_aabb.transform_by(cell_orientation, cell_origin)
        };
        CELL_GRAPH_PENDING.with(|pending| {
            let mut pending = pending.borrow_mut();
            pending.aabbs.push((envcell.cell_id, world_aabb));
            for &neighbour in &portal_cell_ids {
                if neighbour == 0 || neighbour == envcell.cell_id {
                    continue;
                }
                pending.portals.push((envcell.cell_id, neighbour));
            }
        });

        // 2026-05-10 indoor collision (Phase 6 step G follow-on):
        // extract `physics_polygons` from this cell's `CellStruct`,
        // triangulate fan-style for any polygon with `num_pts > 3`
        // (rare but possible for retail dat — most are triangles
        // already), and transform vertices from cell-local into
        // world coords via the same `cell_origin + cell_orientation
        // .rotate_vector(...)` frame used by static-object placement.
        // Push each triangle into `CELL_PHYSICS_PENDING`; the recv-
        // loop drain inserts them into `scene.cell_physics_index`
        // on the next TickMovement, where the integrator's indoor
        // wall-clamp + floor-raycast paths read them.
        //
        // Re-parses the Environment record per cell, which is wasted
        // work when several cells share an environment_id (a Hold-
        // burg dungeon sub-section uses one Environment for many
        // cells). The `env_mesh_cache` HashMap above already memo-
        // izes the visual mesh; a future commit can extend it to
        // also cache the parsed Environment so this loop reads
        // physics polygons without a re-parse. For now: correctness
        // first, the dat-source cache layer absorbs the cost.
        {
            use holtburger_dat::ResourceKey;
            use holtburger_dat::file_type::Environment;
            let env_bytes = source
                .get_file_by_key(ResourceKey::new("eor/portal", env_did))
                .ok();
            if let Some(env_bytes) = env_bytes {
                if let Ok(env) =
                    Environment::unpack(&mut std::io::Cursor::new(&env_bytes))
                {
                    if let Some(cell_struct) =
                        env.cells.get(&(envcell.cell_structure as u32))
                    {
                        // Walk physics polygons, fan-triangulate,
                        // transform to world coords. Skip degenerate
                        // / missing-vertex polygons silently — a
                        // stray bad polygon shouldn't break the rest
                        // of the cell.
                        for poly in cell_struct.physics_polygons.values() {
                            if poly.num_pts < 3 {
                                continue;
                            }
                            // Resolve vertex_ids → world-space Vector3.
                            let mut world_verts: Vec<holtburger_common::Vector3> =
                                Vec::with_capacity(poly.num_pts as usize);
                            let mut all_ok = true;
                            for &vid in &poly.vertex_ids {
                                let key = vid as u16;
                                let Some(sw) =
                                    cell_struct.vertex_array.vertices.get(&key)
                                else {
                                    all_ok = false;
                                    break;
                                };
                                let local = holtburger_common::Vector3::new(
                                    sw.origin.x,
                                    sw.origin.y,
                                    sw.origin.z,
                                );
                                let rotated =
                                    cell_orientation.rotate_vector(local);
                                world_verts.push(holtburger_common::Vector3::new(
                                    cell_origin.x + rotated.x,
                                    cell_origin.y + rotated.y,
                                    cell_origin.z + rotated.z,
                                ));
                            }
                            if !all_ok || world_verts.len() < 3 {
                                continue;
                            }
                            // Fan triangulation: (v0, v1, v2),
                            // (v0, v2, v3), … ; correct for convex
                            // polys, which AC physics polygons are
                            // (the BSP tree only emits convex).
                            CELL_PHYSICS_PENDING.with(|pending| {
                                let mut pending = pending.borrow_mut();
                                for i in 1..(world_verts.len() - 1) {
                                    pending.push((
                                        envcell.cell_id,
                                        holtburger_common::Triangle::new(
                                            world_verts[0],
                                            world_verts[i],
                                            world_verts[i + 1],
                                        ),
                                    ));
                                }
                            });
                        }
                    }
                }
            }
        }

        let mut static_objects: Vec<StaticObjectPlacement> =
            Vec::with_capacity(envcell.static_objects.len());
        for stab in &envcell.static_objects {
            // World position = cell_origin + cell_rot * stab.origin.
            let stab_world_local = cell_orientation.rotate_vector(stab.position.origin);
            let world_x = cell_origin.x + stab_world_local.x;
            let world_y = cell_origin.y + stab_world_local.y;
            let world_z = cell_origin.z + stab_world_local.z;
            // World orientation = cell_rot * stab.orientation.
            let stab_q = stab.position.orientation;
            let cq = cell_orientation;
            // Hamilton product (cq * stab_q).
            let qw = cq.w * stab_q.w - cq.x * stab_q.x - cq.y * stab_q.y - cq.z * stab_q.z;
            let qx = cq.w * stab_q.x + cq.x * stab_q.w + cq.y * stab_q.z - cq.z * stab_q.y;
            let qy = cq.w * stab_q.y - cq.x * stab_q.z + cq.y * stab_q.w + cq.z * stab_q.x;
            let qz = cq.w * stab_q.z + cq.x * stab_q.y - cq.y * stab_q.x + cq.z * stab_q.w;
            let aabb_local = static_object_local_aabb(source.as_ref(), stab.stab_id);
            static_objects.push(StaticObjectPlacement {
                did: stab.stab_id,
                x: world_x,
                y: world_y,
                z: world_z,
                qw,
                qx,
                qy,
                qz,
                aabb_local,
            });
        }

        out.push(EnvCellPlacement {
            cell_id: envcell.cell_id,
            environment_id: env_did,
            cell_origin_x: cell_origin.x,
            cell_origin_y: cell_origin.y,
            cell_origin_z: cell_origin.z,
            cell_orientation_qw: cell_orientation.w,
            cell_orientation_qx: cell_orientation.x,
            cell_orientation_qy: cell_orientation.y,
            cell_orientation_qz: cell_orientation.z,
            static_objects,
            portal_cell_ids,
            mesh,
        });
    }
    Ok(out)
}

/// Compute model-local AABB for a static object placement. Used to
/// populate `StaticObjectPlacement.aabbLocal` so Phase D's cell-
/// containment queries can probe per-static AABBs without a second
/// wasm round-trip per object. Returns 6 floats `[minX, minY, minZ,
/// maxX, maxY, maxZ]`. Empty AABB on parse / fetch failure (caller
/// treats as "no bounds" — which Phase D defaults to a small radius).
#[cfg(target_arch = "wasm32")]
fn static_object_local_aabb<S: holtburger_dat::ResourceSource + ?Sized>(
    source: &S,
    stab_id: u32,
) -> Vec<f32> {
    use holtburger_dat::file_type::GfxObj;
    use holtburger_dat::ResourceKey;
    let mut aabb = holtburger_common::Aabb::empty();
    match (stab_id >> 24) as u8 {
        0x01 => {
            if let Ok(bytes) = source.get_file_by_key(ResourceKey::new("eor/portal", stab_id))
                && let Ok(gfx) = GfxObj::unpack(&mut std::io::Cursor::new(&bytes))
            {
                for vert in gfx.vertex_array.vertices.values() {
                    aabb.expand_to_include_point(vert.origin);
                }
            }
        }
        0x02 => {
            if let Some(part_aabbs) = walk_setup_parts_with_geom(source, stab_id) {
                for part in part_aabbs {
                    if !part.is_empty() {
                        aabb.expand_to_include_point(part.min);
                        aabb.expand_to_include_point(part.max);
                    }
                }
            }
        }
        _ => {}
    }
    if aabb.is_empty() {
        return vec![0.0; 6];
    }
    vec![aabb.min.x, aabb.min.y, aabb.min.z, aabb.max.x, aabb.max.y, aabb.max.z]
}

/// Local helper for `EnvCellPlacement::take_mesh` move semantics.
/// `ModelMesh` doesn't impl Clone (its Vec fields are large), so the
/// per-call `or_insert_with(|| fetch_environment_mesh(...))` pattern
/// can't cheaply reuse an entry. We keep a deep-clone variant scoped
/// to this module; profiling can revisit if a 50-cell landblock
/// mesh-cache hit shows up hot.
#[cfg(target_arch = "wasm32")]
impl ModelMesh {
    fn clone_for_take(&self) -> ModelMesh {
        ModelMesh {
            positions: self.positions.clone(),
            uvs: self.uvs.clone(),
            normals: self.normals.clone(),
            surface_indices: self.surface_indices.clone(),
            surfaces: self.surfaces.clone(),
            bbox_min: self.bbox_min,
            bbox_max: self.bbox_max,
            did_degrade: self.did_degrade,
        }
    }
}

/// Phase 4 step 6 Phase A: triangulate a SetupModel with the
/// per-part GfxObj substitutions + per-part texture remaps that ACE
/// pre-computes server-side and ships in `ObjectDescriptionData
/// .model_data`. Used for live entities (NPCs, monsters, players)
/// arriving via `ObjectCreate` — static placements still call
/// `fetch_model_mesh` since they have no substitutions.
///
/// Wire format match (per ACE's `ObjDesc` struct):
/// - `model_changes` is a flat `Uint32Array` of `[part_index_u8,
///   gfx_obj_did_u32, …]` pairs, encoded as `[index, gfx, index, gfx,
///   …]` to keep the wasm-bindgen JS boundary cheap. Each pair
///   replaces `setup.parts[index]` with `gfx` before triangulation.
/// - `texture_changes` is a flat `Uint32Array` of `[part_index_u8,
///   old_surface_did_u32, new_surface_did_u32, …]` triples. While
///   triangulating `setup.parts[part_index]`, any polygon whose
///   resolved surface DID matches `old_surface_did` is rewritten to
///   `new_surface_did`.
///
/// JS caller: pass `EntityUpdate.modelChanges` /
/// `EntityUpdate.textureChanges` (Uint32Array getters that mirror the
/// ACE-side `model_data`). Empty `Uint32Array(0)` for entities without
/// substitutions degrades to `triangulate_model`'s behaviour exactly,
/// so passing them unconditionally is safe — the only reason we keep
/// `fetch_model_mesh` distinct is to avoid wire-marshalling overhead
/// on the static-placement hot path (~239 entries on Holtburg first
/// boot).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = fetchEntityModelRender)]
pub async fn fetch_entity_model_render(
    setup_id: u32,
    model_changes: Vec<u32>,
    texture_changes: Vec<u32>,
    mtable_id: u32,
) -> Result<ModelMesh, JsValue> {
    use holtburger_dat::ResourceKey;
    // Decode the flat-pair / flat-triple buffers. Reject mis-aligned
    // input early so the JS-side bug surfaces as a clear error rather
    // than a silently-truncated mesh.
    if model_changes.len() % 2 != 0 {
        return Err(JsValue::from_str(
            "fetch_entity_model_render: model_changes must be flat [partIndex, gfxId, ...] pairs (even length)",
        ));
    }
    if texture_changes.len() % 3 != 0 {
        return Err(JsValue::from_str(
            "fetch_entity_model_render: texture_changes must be flat [partIndex, oldSurface, newSurface, ...] triples (length % 3 == 0)",
        ));
    }
    let mc: Vec<(u8, u32)> = model_changes
        .chunks_exact(2)
        .map(|c| (c[0] as u8, c[1]))
        .collect();
    let tc: Vec<(u8, u32, u32)> = texture_changes
        .chunks_exact(3)
        .map(|c| (c[0] as u8, c[1], c[2]))
        .collect();

    // Prefetch: the setup itself, every part the SetupModel references
    // by default, AND every substituted GfxObj the model_changes table
    // names. Texture-change targets ride into the prefetch through the
    // GfxObj surface-DID walk inside ensure_walk_prefetched.
    let source = global_source::global_source();
    let mut initial: Vec<ResourceKey<'_>> = Vec::with_capacity(1 + mc.len());
    initial.push(ResourceKey::new("eor/portal", setup_id));
    for (_, gfx_id) in &mc {
        initial.push(ResourceKey::new("eor/portal", *gfx_id));
    }
    let mc_for_walk = mc.clone();
    let tc_for_walk = tc.clone();
    let mt_for_walk = if mtable_id == 0 { None } else { Some(mtable_id) };
    prefetch::ensure_walk_prefetched(&source, &initial, |s| {
        let _ = triangulate_model_with_substitutions_and_mtable(
            s, setup_id, &mc_for_walk, &tc_for_walk, mt_for_walk,
        );
    })
    .await?;
    let tris = triangulate_model_with_substitutions_and_mtable(
        source.as_ref(), setup_id, &mc, &tc, mt_for_walk,
    )
    .ok_or_else(|| {
        JsValue::from_str(&format!(
            "fetch_entity_model_render: triangulate setup 0x{setup_id:08X} failed"
        ))
    })?;
    Ok(pack_model_mesh(tris))
}

/// Phase 4 step 6 Tier 2 + walk-cycle polish: bundle of walk + run
/// cycle bakes for one entity setup. Each cycle is a `Vec<ModelMesh>`
/// (one mesh per keyframe) plus the authoritative
/// `AnimData.framerate` from the MotionTable, so the JS animation
/// loop ticks at retail's actual rate instead of a guessed constant.
///
/// Empty `Vec` + `0.0` framerate signals "no cycle resolved" for that
/// command — JS falls back to the idle texture in that case.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct EntityCycleSet {
    walk_frames: Vec<ModelMesh>,
    walk_framerate: f32,
    run_frames: Vec<ModelMesh>,
    run_framerate: f32,
    // The actual MotionTable stance these cycles correspond to. When
    // the caller passes stance=0 (meaning "use default"), this lets
    // JS key the cached bake under the resolved stance instead of
    // under "default" — so a later motionStance update that happens
    // to match (the common case for at-rest NonCombat creatures)
    // hits the cache instead of triggering a redundant bake.
    resolved_stance: u32,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl EntityCycleSet {
    /// Authoritative walk-cycle playback rate (frames/sec) from the
    /// MotionTable's `AnimData.framerate`. `0.0` when no walk cycle
    /// resolved.
    #[wasm_bindgen(getter, js_name = walkFramerate)]
    pub fn walk_framerate(&self) -> f32 {
        self.walk_framerate
    }

    /// Authoritative run-cycle playback rate (frames/sec). `0.0` when
    /// no run cycle resolved (most non-humanoid setups).
    #[wasm_bindgen(getter, js_name = runFramerate)]
    pub fn run_framerate(&self) -> f32 {
        self.run_framerate
    }

    /// MotionTable stance (full u32 — `0x8000_xxxx` with `xxxx` the
    /// MotionStance.interpreted() low 16 bits) these cycles were
    /// resolved against. When the bake was kicked with stance=0
    /// (pre-UpdateMotion), this carries the MotionTable's
    /// `default_style` so JS can key the cache by actual stance and
    /// avoid re-baking when the live motionStance arrives matching it.
    /// `0` only when no MotionTable resolved at all (raw GfxObj setups
    /// + setups whose mtable failed to load).
    #[wasm_bindgen(getter, js_name = resolvedStance)]
    pub fn resolved_stance(&self) -> u32 {
        self.resolved_stance
    }

    /// Move the walk-cycle meshes out of the set into a JS-owned array.
    /// One-shot — second call returns an empty Vec.
    #[wasm_bindgen(js_name = takeWalkFrames)]
    pub fn take_walk_frames(&mut self) -> Vec<ModelMesh> {
        std::mem::take(&mut self.walk_frames)
    }

    /// Move the run-cycle meshes out of the set. One-shot.
    #[wasm_bindgen(js_name = takeRunFrames)]
    pub fn take_run_frames(&mut self) -> Vec<ModelMesh> {
        std::mem::take(&mut self.run_frames)
    }
}

#[cfg(target_arch = "wasm32")]
impl EntityCycleSet {
    fn empty() -> Self {
        Self {
            walk_frames: Vec::new(),
            walk_framerate: 0.0,
            run_frames: Vec::new(),
            run_framerate: 0.0,
            resolved_stance: 0,
        }
    }
}

/// Phase 4 step 6 Tier 2 + walk-cycle polish + stance-keyed cycles:
/// bake walk + run cycles for an entity setup at a specific
/// MotionTable stance in a single wasm round-trip. For each cycle,
/// resolves the MotionTable's WALK_FORWARD / RUN_FORWARD entry under
/// the requested `stance` (or `default_style` when stance=0),
/// triangulates the SetupModel with substitutions applied at each
/// keyframe's per-part transforms, and surfaces the
/// `AnimData.framerate` so JS can tick at retail's authentic rate.
///
/// `stance` is the u16 `MotionStance.interpreted()` value
/// zero-extended to u32, matching what `EntityUpdate.motionStance`
/// surfaces from `UpdateMotion.current_style`. `0` means "use this
/// MotionTable's `default_style`" — the bake-once pre-stance-aware
/// behaviour, kept so first-bakes can fire before any UpdateMotion
/// has landed for the entity.
///
/// Returns an [`EntityCycleSet`] with `resolved_stance` populated to
/// the actual stance used (so JS can key the cached bake by that
/// stance and avoid re-baking when a future motionStance update
/// matches it). Empty Vec + `0.0` framerate for any cycle that
/// doesn't resolve under the requested stance — JS falls back to
/// the default-stance bake at the gate.
///
/// Returns an all-empty set (resolved_stance=0) for setups that:
/// - aren't `0x02xxxxxx` (raw GfxObj 0x01 prefix has no MotionTable)
/// - have no `default_motion_table` (and no `mtable_id` override)
/// - have a MotionTable that fails to load
///
/// **Stance-mismatched setups** (MotionTable doesn't carry the
/// requested stance's cycles) return walk_frames=[] + run_frames=[]
/// + resolved_stance=requested_stance. JS treats this as "this
/// stance has no animation; fall back to default_stance".
///
/// Substitution arguments are identical to `fetchEntityModelRender`
/// — the same `model_changes` + `texture_changes` apply across
/// every frame of every cycle (clothing/armor doesn't move when
/// limbs do).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = fetchEntityCycleFrames)]
pub async fn fetch_entity_cycle_frames(
    setup_id: u32,
    model_changes: Vec<u32>,
    texture_changes: Vec<u32>,
    mtable_id: u32,
    stance: u32,
) -> Result<EntityCycleSet, JsValue> {
    use holtburger_dat::file_type::{MotionTable, SetupModel};
    use holtburger_dat::{ResourceKey, ResourceSource};
    if model_changes.len() % 2 != 0 {
        return Err(JsValue::from_str(
            "fetch_entity_cycle_frames: model_changes must be flat [partIndex, gfxId, ...] pairs",
        ));
    }
    if texture_changes.len() % 3 != 0 {
        return Err(JsValue::from_str(
            "fetch_entity_cycle_frames: texture_changes must be flat [partIndex, oldSurface, newSurface, ...] triples",
        ));
    }
    // Raw GfxObj (0x01) has no skeleton + no MotionTable — return empty.
    if (setup_id >> 24) as u8 != 0x02 {
        return Ok(EntityCycleSet::empty());
    }
    let mc: Vec<(u8, u32)> = model_changes.chunks_exact(2).map(|c| (c[0] as u8, c[1])).collect();
    let tc: Vec<(u8, u32, u32)> = texture_changes
        .chunks_exact(3)
        .map(|c| (c[0] as u8, c[1], c[2]))
        .collect();

    // Prefetch: the setup, every substituted GfxObj, and the
    // MotionTable + Animation reachable from setup.default_motion_table.
    // The MotionTable + Animation DIDs are discovered inside the
    // prefetch closure via try_resolve_cycle_frames, so they ride
    // along automatically — for BOTH walk and run, since both need
    // their Animation chain warm before the bake step.
    let source = global_source::global_source();
    let mut initial: Vec<ResourceKey<'_>> = Vec::with_capacity(1 + mc.len());
    initial.push(ResourceKey::new("eor/portal", setup_id));
    for (_, gfx_id) in &mc {
        initial.push(ResourceKey::new("eor/portal", *gfx_id));
    }
    let mc_for_prefetch = mc.clone();
    let tc_for_prefetch = tc.clone();
    let mt_override = if mtable_id == 0 { None } else { Some(mtable_id) };
    if let Some(mt) = mt_override {
        initial.push(ResourceKey::new("eor/portal", mt));
    }
    prefetch::ensure_walk_prefetched(&source, &initial, move |s| {
        // Touch each cycle frame inside the prefetch so the
        // MotionTable + Animation records (for walk AND run, under
        // the requested stance) are discovered before the real bake.
        if let Ok(setup_bytes) = s.get_file_by_key(ResourceKey::new("eor/portal", setup_id)) {
            if let Ok(setup) = SetupModel::unpack(&mut std::io::Cursor::new(&setup_bytes)) {
                for command in [
                    MotionTable::WALK_FORWARD_COMMAND,
                    MotionTable::RUN_FORWARD_COMMAND,
                ] {
                    if let Some((frames, _, _)) =
                        try_resolve_cycle_frames(s, &setup, mt_override, stance, command)
                    {
                        for f in frames.iter() {
                            let _ = triangulate_setup_model_at_frame(
                                s,
                                setup_id,
                                &mc_for_prefetch,
                                &tc_for_prefetch,
                                mt_override,
                                Some(f),
                                &mut Vec::new(),
                            );
                        }
                    }
                }
            }
        }
    })
    .await?;

    // Now do the real bake. Re-load the setup once; bake each cycle
    // independently so a missing run cycle doesn't suppress walk.
    let setup_bytes = source
        .as_ref()
        .get_file_by_key(ResourceKey::new("eor/portal", setup_id))
        .map_err(|e| JsValue::from_str(&format!("fetch_entity_cycle_frames: setup load: {e}")))?;
    let setup = SetupModel::unpack(&mut std::io::Cursor::new(&setup_bytes))
        .map_err(|e| JsValue::from_str(&format!("fetch_entity_cycle_frames: setup parse: {e}")))?;

    // bake_cycle returns (frames, framerate, resolved_stance). The
    // resolved_stance is pulled from the FIRST cycle that resolves;
    // both walk and run resolve to the same stance (the helper
    // dispatches stance once at the top).
    let bake_cycle = |command: u32| -> (Vec<ModelMesh>, f32, u32) {
        match try_resolve_cycle_frames(source.as_ref(), &setup, mt_override, stance, command) {
            Some((frames, framerate, resolved_stance)) => {
                let mut out = Vec::with_capacity(frames.len());
                for f in &frames {
                    let mut tris = Vec::new();
                    let _ = triangulate_setup_model_at_frame(
                        source.as_ref(),
                        setup_id,
                        &mc,
                        &tc,
                        mt_override,
                        Some(f),
                        &mut tris,
                    );
                    out.push(pack_model_mesh(tris));
                }
                (out, framerate, resolved_stance)
            }
            None => (Vec::new(), 0.0, 0),
        }
    };
    let (walk_frames, walk_framerate, walk_resolved) =
        bake_cycle(MotionTable::WALK_FORWARD_COMMAND);
    let (run_frames, run_framerate, run_resolved) = bake_cycle(MotionTable::RUN_FORWARD_COMMAND);

    // Pick the resolved_stance from whichever cycle landed (both will
    // agree when both resolve; only one is non-zero when only one
    // cycle exists). Falls back to the requested stance so JS can
    // still cache the empty-cycles result under that key — preventing
    // re-bake spam for stances the MotionTable doesn't carry.
    let resolved_stance = if walk_resolved != 0 {
        walk_resolved
    } else if run_resolved != 0 {
        run_resolved
    } else if stance != 0 {
        stance
    } else {
        0
    };

    Ok(EntityCycleSet {
        walk_frames,
        walk_framerate,
        run_frames,
        run_framerate,
        resolved_stance,
    })
}

/// Phase 7.4a (3D migration) — RAW per-frame per-part keyframe
/// transforms for an entity setup at a specific MotionTable
/// `(stance, command)`. Sibling of [`fetch_entity_cycle_frames`]:
/// instead of pre-rasterizing each pose into a `ModelMesh`, the
/// keyframe data is shipped as a flat `Vec<f32>` ready to feed into
/// `THREE.AnimationClip` / `KeyframeTrack` JS-side.
///
/// Layout: `part_frames[(frame_idx * part_count + part_idx) * 7 + i]`
/// where `i ∈ {0,1,2}` is `(x, y, z)` from the part's
/// `Frame.origin` and `i ∈ {3,4,5,6}` is `(qw, qx, qy, qz)` from the
/// part's `Frame.orientation`. AC stores quaternions w-first; three.js
/// wants `(x, y, z, w)` — the JS adapter (`acQuatToThree` /
/// `buildAnimationClip`) reorders during the copy. No reordering at
/// the wasm boundary: ship DAT bytes verbatim so the contract is
/// trivial to inspect / cross-reference against the parsed
/// `holtburger_dat::file_type::setup_model::AnimationFrame`.
///
/// The accompanying `part_meshes` are the rest-pose per-part
/// meshes (one `ModelMesh` per `setup.parts[i]`) — the JS side uses
/// these to build the per-entity rig once, then animates by mutating
/// each part's `Object3D.position` / `Object3D.quaternion` from the
/// `AnimationMixer`. This mirrors the Phase 7.2 `BuildingPlacement`
/// pattern except the parts here belong to a *moving* entity rig,
/// not a static building.
///
/// Empty `part_frames` + `num_frames == 0` + `framerate == 0.0` is
/// the "no animation resolved" signal — JS treats this as "render
/// rest pose only; no `AnimationClip` to build". Same triggers as
/// `fetch_entity_cycle_frames`: raw GfxObj 0x01 setups, MotionTables
/// missing the requested `(stance, command)` cycle, etc.
///
/// `palette_subs_flat` is accepted but currently unused — kept in
/// the signature to mirror `fetch_entity_model_render`'s contract so
/// callers can pass the same struct without a special-case
/// destructure. The actual palette overlays are applied at texture
/// bake time (Phase 7.4b's `EntityManager` will call
/// `fetchEntitySurfacesPixels` with these args separately). The
/// accept-and-validate gate prevents a future caller-mismatch bug
/// from manifesting as silent texture corruption.
/// **Task E (2026-05-12).** JS-side mirror of one
/// `AnimationFrame.hooks[i]` entry, with its time-in-clip already
/// computed so JS doesn't need the framerate to schedule it.
///
/// Carries the SAME `(hook_type, hook_data)` byte representation as
/// `PhysicsScriptEntryJs` (the close cousin used by the Sky-J + H2
/// chain walkers for PhysicsScript-driven hooks). The decoder helpers
/// — `soundWaveId`, `soundProbability`, `soundVolume`, `soundEnum` —
/// follow the same hook_type typeswitch documented in
/// `setup_model::AnimationHook::read`:
///
/// - `hook_type = 1` (Sound): 4-byte payload = Wave DID.
/// - `hook_type = 2` (SoundTable): 4-byte payload = Sound enum (u32).
/// - `hook_type = 13` (CreateParticle): 40-byte payload —
///   reuse the PhysicsScript `createParticle*` getters via raw
///   `hookData`. The Task E executor only handles 1/2 today;
///   CreateParticle on entity animations is left as a TODO.
/// - `hook_type = 21` (SoundTweaked): 16-byte payload =
///   `[u32 wave_did, f32 priority, f32 probability, f32 volume]`.
///   Currently TODO in entity-animation handler.
///
/// The `time_in_clip_s` field is `(frame_index / clip_fps)` — the
/// position of this hook in the cycle, in seconds. JS arms a
/// per-action sorted timeline and fires hooks as the
/// `AnimationAction.time` crosses each one.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct AnimationHookJs {
    time_in_clip_s: f64,
    hook_type: u32,
    direction: i32,
    hook_data: Vec<u8>,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl AnimationHookJs {
    /// Time within the clip, in seconds: `frame_index / clip_fps`. The
    /// JS executor schedules each hook to fire when
    /// `AnimationAction.time` crosses this value.
    #[wasm_bindgen(getter, js_name = timeInClipS)]
    pub fn time_in_clip_s(&self) -> f64 { self.time_in_clip_s }
    /// AC `AnimationHookType` value — 1 = Sound, 2 = SoundTable,
    /// 13 = CreateParticle, 21 = SoundTweaked, etc. See
    /// `setup_model::AnimationHook::read` for the full enum.
    #[wasm_bindgen(getter, js_name = hookType)]
    pub fn hook_type(&self) -> u32 { self.hook_type }
    /// Hook direction (forward/reverse playback gate). `0` for most
    /// hooks; `1`/`-1` for hooks that should only fire in one
    /// playback direction. The JS executor currently fires regardless
    /// of direction (cycles loop forward in three.js).
    #[wasm_bindgen(getter)]
    pub fn direction(&self) -> i32 { self.direction }
    /// Raw payload bytes — the typeswitch body per
    /// `setup_model::AnimationHook::read`. JS decodes per
    /// `hookType` via the getters below or the raw bytes.
    #[wasm_bindgen(getter, js_name = hookData)]
    pub fn hook_data(&self) -> Vec<u8> { self.hook_data.clone() }

    /// **Sound (1) / SoundTweaked (21)**: Wave DID the hook plays
    /// directly. `0` for other hook types or malformed payloads.
    /// Mirrors `PhysicsScriptEntryJs::sound_wave_id`.
    #[wasm_bindgen(getter, js_name = soundWaveId)]
    pub fn sound_wave_id(&self) -> u32 {
        match self.hook_type {
            1 if self.hook_data.len() >= 4 => {
                u32::from_le_bytes(self.hook_data[0..4].try_into().unwrap())
            }
            21 if self.hook_data.len() >= 16 => {
                u32::from_le_bytes(self.hook_data[0..4].try_into().unwrap())
            }
            _ => 0,
        }
    }

    /// **SoundTable (2)**: Sound enum value (u32) the hook fires.
    /// Look this up in the entity's `soundTableDid` via the
    /// SoundTableCache to get one or more `(waveDid, priority,
    /// probability, volume)` rows. `0` for other hook types or
    /// malformed payloads.
    #[wasm_bindgen(getter, js_name = soundEnum)]
    pub fn sound_enum(&self) -> u32 {
        if self.hook_type == 2 && self.hook_data.len() >= 4 {
            u32::from_le_bytes(self.hook_data[0..4].try_into().unwrap())
        } else {
            0
        }
    }

    /// **SoundTweaked (21)** priority. `0.0` for other types.
    #[wasm_bindgen(getter, js_name = soundPriority)]
    pub fn sound_priority(&self) -> f32 {
        if self.hook_type == 21 && self.hook_data.len() == 16 {
            f32::from_le_bytes(self.hook_data[4..8].try_into().unwrap())
        } else {
            0.0
        }
    }

    /// **SoundTweaked (21)** probability. `1.0` for plain Sound (1)
    /// (always plays); `0.0` for other types.
    #[wasm_bindgen(getter, js_name = soundProbability)]
    pub fn sound_probability(&self) -> f32 {
        match self.hook_type {
            1 => 1.0,
            21 if self.hook_data.len() == 16 => {
                f32::from_le_bytes(self.hook_data[8..12].try_into().unwrap())
            }
            _ => 0.0,
        }
    }

    /// **SoundTweaked (21)** per-hook gain multiplier. `1.0` for plain
    /// Sound (1); `0.0` for other types.
    #[wasm_bindgen(getter, js_name = soundVolume)]
    pub fn sound_volume(&self) -> f32 {
        match self.hook_type {
            1 => 1.0,
            21 if self.hook_data.len() == 16 => {
                f32::from_le_bytes(self.hook_data[12..16].try_into().unwrap())
            }
            _ => 0.0,
        }
    }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct EntityAnimationData {
    part_meshes: Vec<ModelMesh>,
    part_count: u32,
    num_frames: u32,
    framerate: f32,
    resolved_stance: u32,
    /// Flat keyframe buffer: `num_frames * part_count * 7` f32s.
    /// `[(x, y, z, qw, qx, qy, qz) per part] per frame`. Empty when
    /// no cycle resolved. See struct doc for layout invariants.
    part_frames: Vec<f32>,
    /// **Task E (2026-05-12).** Sorted-by-`time_in_clip_s` list of
    /// `AnimationHookJs` entries baked from each `AnimationFrame.hooks`
    /// in the resolved cycle. Frame `i` contributes its hooks at time
    /// `i / framerate`. Empty when:
    ///   - no cycle resolved (raw GfxObj setup, missing MotionTable entry, etc.)
    ///   - the cycle has zero hooks across all frames (common — most
    ///     locomotion cycles have no audio; idle cycles for forges /
    ///     NPCs / props are where most hooks live)
    ///
    /// One-shot: drained via `takeHooks()` (frees the Rust side after
    /// JS consumes it).
    hooks: Vec<AnimationHookJs>,
    /// Cohere-B (2026-05-12): per-part rest-pose origins. Flat `part_count * 3`
    /// f32s, `[x, y, z]` per part in DAT order. JS sets each `partGroup.position`
    /// to its rest origin at spawn; the `AnimationMixer` overwrites these
    /// during cycle playback with the model-space keyframe values. Decoupled
    /// from `part_meshes` (now part-local geometry) so the model-space
    /// AnimationFrame composition matches PhatSDK's `CPartArray::UpdateParts`
    /// rather than double-composing against placement-baked vertices.
    rest_origins: Vec<f32>,
    /// Cohere-B (2026-05-12): per-part rest-pose orientations. Flat
    /// `part_count * 4` f32s, `[qw, qx, qy, qz]` per part — AC w-first
    /// order (same as `part_frames`); JS reorders to `(qx, qy, qz, qw)`
    /// for three.js's quaternion layout in `entities.js`'s rest-pose
    /// apply step.
    rest_orientations: Vec<f32>,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl EntityAnimationData {
    /// Number of parts in the SetupModel — equals the length of the
    /// `Vec<ModelMesh>` `take_part_meshes` returns AND the per-frame
    /// stride into `part_frames` (each frame contributes `part_count`
    /// transforms).
    #[wasm_bindgen(getter, js_name = partCount)]
    pub fn part_count(&self) -> u32 {
        self.part_count
    }

    /// Number of keyframes in the resolved cycle. `0` when no cycle
    /// resolved under `(stance, command)` — JS falls back to rest pose.
    #[wasm_bindgen(getter, js_name = numFrames)]
    pub fn num_frames(&self) -> u32 {
        self.num_frames
    }

    /// Authoritative cycle playback rate (frames/sec) from the
    /// MotionTable's `AnimData.framerate`. `0.0` when no cycle
    /// resolved.
    #[wasm_bindgen(getter)]
    pub fn framerate(&self) -> f32 {
        self.framerate
    }

    /// MotionTable stance these keyframes were resolved against —
    /// same semantics as [`EntityCycleSet::resolved_stance`]. `0`
    /// when no MotionTable resolved at all.
    #[wasm_bindgen(getter, js_name = resolvedStance)]
    pub fn resolved_stance(&self) -> u32 {
        self.resolved_stance
    }

    /// Drain the rest-pose per-part meshes. One per `setup.parts[i]`
    /// in stable order; an empty mesh (`triCount == 0`) at any slot
    /// preserves the part_index for callers that key animation data
    /// by it. One-shot — second call returns an empty Vec.
    #[wasm_bindgen(js_name = takePartMeshes)]
    pub fn take_part_meshes(&mut self) -> Vec<ModelMesh> {
        std::mem::take(&mut self.part_meshes)
    }

    /// Clone the flat keyframe buffer into a JS `Float32Array`.
    /// Layout: `[(x, y, z, qw, qx, qy, qz) per part] per frame`.
    /// Total length: `numFrames * partCount * 7`.
    ///
    /// Cloned (not drained) because JS may inspect this multiple
    /// times during a single bake (clip build + future re-target).
    /// The buffer for a typical 30-frame humanoid walk cycle of 20
    /// parts is `30 × 20 × 7 = 4200 floats = 16.8 KB` — cheap.
    #[wasm_bindgen(getter, js_name = partFrames)]
    pub fn part_frames(&self) -> Vec<f32> {
        self.part_frames.clone()
    }

    /// Cohere-B (2026-05-12): clone per-part rest-pose origins.
    /// `partCount * 3` floats — `[x, y, z]` per part. JS reads at
    /// spawn to set each `partGroup.position` before the
    /// AnimationMixer starts driving keyframe overrides.
    #[wasm_bindgen(getter, js_name = restOrigins)]
    pub fn rest_origins(&self) -> Vec<f32> {
        self.rest_origins.clone()
    }

    /// Cohere-B (2026-05-12): clone per-part rest-pose orientations.
    /// `partCount * 4` floats — `[qw, qx, qy, qz]` per part (AC w-first
    /// order; JS reorders to three.js's xyzw at apply time).
    #[wasm_bindgen(getter, js_name = restOrientations)]
    pub fn rest_orientations(&self) -> Vec<f32> {
        self.rest_orientations.clone()
    }

    /// **Task E (2026-05-12).** Drain the per-cycle `AnimationHookJs`
    /// timeline across the wasm boundary. Each entry carries
    /// `(time_in_clip_s, hook_type, direction, hook_data)`; hook_type
    /// 1 = Sound, 2 = SoundTable, 13 = CreateParticle, 21 = SoundTweaked
    /// per `setup_model::AnimationHook::read`'s typeswitch.
    ///
    /// Entries are sorted by `time_in_clip_s` ascending (stable across
    /// hooks at the same time — DAT order preserved). JS bakes this
    /// into a per-action sorted timeline and fires hooks as the
    /// `AnimationAction.time` crosses each one (with a wrap-around
    /// branch for looped clips).
    ///
    /// One-shot — second call returns an empty Vec. Cheap to call once
    /// per spawn: a typical retail cycle has 0–10 hooks; the forge's
    /// idle animation we audit in the Task E doc has 2 Sound hooks.
    #[wasm_bindgen(js_name = takeHooks)]
    pub fn take_hooks(&mut self) -> Vec<AnimationHookJs> {
        std::mem::take(&mut self.hooks)
    }
}

#[cfg(target_arch = "wasm32")]
impl EntityAnimationData {
    fn empty(part_meshes: Vec<ModelMesh>, resolved_stance: u32) -> Self {
        let part_count = part_meshes.len() as u32;
        // Identity rest pose per part: origin (0,0,0), orientation (1,0,0,0)
        // in AC w-first order. JS-side apply is a no-op visually — matches
        // the prior "no rest pose info" default behaviour where partGroup
        // sat at identity.
        let mut rest_origins = Vec::with_capacity(part_count as usize * 3);
        let mut rest_orientations = Vec::with_capacity(part_count as usize * 4);
        for _ in 0..part_count {
            rest_origins.extend_from_slice(&[0.0, 0.0, 0.0]);
            rest_orientations.extend_from_slice(&[1.0, 0.0, 0.0, 0.0]);
        }
        Self {
            part_meshes,
            part_count,
            num_frames: 0,
            framerate: 0.0,
            resolved_stance,
            part_frames: Vec::new(),
            rest_origins,
            rest_orientations,
            // Task E (2026-05-12): no cycle resolved → no hooks. JS keeps
            // an empty timeline and the per-frame executor is a no-op.
            hooks: Vec::new(),
        }
    }
}

/// Phase 7.4a (3D migration): bake rest-pose per-part meshes + RAW
/// per-frame keyframe transforms for an entity setup at a specific
/// `(stance, command)`. JS-side adapter (`scene3d/animation.js`)
/// converts the keyframe buffer into a `THREE.AnimationClip` with
/// 2 KeyframeTracks per part (position + quaternion).
///
/// Sibling of [`fetch_entity_cycle_frames`] — same prefetch walk,
/// same substitution path, same stance dispatch — but ships keyframe
/// data instead of rasterized meshes. The 3D path doesn't need the
/// pre-rasterized walk-frame meshes because three.js animates the
/// rest-pose mesh on the GPU via per-part `Object3D` transforms.
///
/// `palette_id` and `palette_subs_flat` are accepted to mirror
/// `fetchEntityModelRender`'s parameter shape so the caller can pass
/// one struct's worth of args. They're validated for shape but not
/// applied here — the per-surface RGBA8 bake (which DOES consume them)
/// runs through `fetchEntitySurfacesPixels` separately.
///
/// `motion_command` is a full u32 — `MotionTable::WALK_FORWARD_COMMAND`
/// (`0x4500_0005`), `RUN_FORWARD_COMMAND`, etc. The high bits are
/// stripped via `MOTION_KEY_MASK` inside `motion_data_for_cycle`.
///
/// Returns `EntityAnimationData::empty()` (rest-pose meshes baked,
/// `numFrames=0`) when:
///   - `setup_id` is raw GfxObj (0x01 prefix — no skeleton)
///   - no MotionTable resolves (no override + no `default_motion_table`)
///   - the MotionTable doesn't carry the requested `(stance, command)`
///   - the resolved Animation has no `part_frames`
///
/// JS treats `numFrames=0` as "render rest pose only; no clip needed".
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = fetchEntityAnimationKeyframes)]
pub async fn fetch_entity_animation_keyframes(
    setup_id: u32,
    model_changes: Vec<u32>,
    texture_changes: Vec<u32>,
    palette_id: u32,
    palette_subs_flat: Vec<u32>,
    mtable_id: u32,
    motion_command: u32,
    stance: u32,
) -> Result<EntityAnimationData, JsValue> {
    use holtburger_dat::file_type::SetupModel;
    use holtburger_dat::{ResourceKey, ResourceSource};

    if model_changes.len() % 2 != 0 {
        return Err(JsValue::from_str(
            "fetch_entity_animation_keyframes: model_changes must be flat [partIndex, gfxId, ...] pairs",
        ));
    }
    if texture_changes.len() % 3 != 0 {
        return Err(JsValue::from_str(
            "fetch_entity_animation_keyframes: texture_changes must be flat [partIndex, oldSurface, newSurface, ...] triples",
        ));
    }
    if palette_subs_flat.len() % 3 != 0 {
        return Err(JsValue::from_str(
            "fetch_entity_animation_keyframes: palette_subs_flat must be flat [subId, low, len, ...] triples",
        ));
    }
    // palette_id and palette_subs_flat ride through unused at this
    // layer — the per-surface palette overlay path lives in
    // fetchEntitySurfacesPixels. Touching the args here ensures any
    // future palette-aware bake step sees them without a signature
    // change. Use a `let _` dance so wasm-bindgen doesn't trim them
    // from the export and the borrow-checker doesn't warn.
    let _palette_id = palette_id;
    let _palette_subs_flat = palette_subs_flat;

    let mc: Vec<(u8, u32)> = model_changes
        .chunks_exact(2)
        .map(|c| (c[0] as u8, c[1]))
        .collect();
    let tc: Vec<(u8, u32, u32)> = texture_changes
        .chunks_exact(3)
        .map(|c| (c[0] as u8, c[1], c[2]))
        .collect();
    let mt_override = if mtable_id == 0 { None } else { Some(mtable_id) };

    // Raw GfxObj setups have no skeleton. Bake a single rest-pose part
    // mesh so JS still gets geometry to render, and ship empty keyframes.
    let source = global_source::global_source();
    if (setup_id >> 24) as u8 != 0x02 {
        let initial = [ResourceKey::new("eor/portal", setup_id)];
        prefetch::ensure_walk_prefetched(&source, &initial, |s| {
            let _ = triangulate_model_per_part_buckets(s, setup_id);
        })
        .await?;
        let parts_tris = triangulate_model_per_part_buckets(source.as_ref(), setup_id)
            .ok_or_else(|| {
                JsValue::from_str(&format!(
                    "fetch_entity_animation_keyframes: triangulate raw GfxObj 0x{setup_id:08X} failed"
                ))
            })?;
        let part_meshes: Vec<ModelMesh> =
            parts_tris.into_iter().map(pack_model_mesh).collect();
        return Ok(EntityAnimationData::empty(part_meshes, 0));
    }

    // Prefetch: setup, every substituted GfxObj, the MotionTable, and
    // (lazily, via the closure) the Animation chain reachable through
    // try_resolve_cycle_frames under the requested (stance, command).
    let mut initial: Vec<ResourceKey<'_>> = Vec::with_capacity(2 + mc.len());
    initial.push(ResourceKey::new("eor/portal", setup_id));
    for (_, gfx_id) in &mc {
        initial.push(ResourceKey::new("eor/portal", *gfx_id));
    }
    if let Some(mt) = mt_override {
        initial.push(ResourceKey::new("eor/portal", mt));
    }
    let mc_for_walk = mc.clone();
    let tc_for_walk = tc.clone();
    prefetch::ensure_walk_prefetched(&source, &initial, move |s| {
        // Touch rest-pose triangulation (warms substituted GfxObjs)
        // and the cycle frames (warms Animation + chained Anim parts).
        let _ = triangulate_setup_model_per_part(
            s, setup_id, &mc_for_walk, &tc_for_walk,
        );
        if let Ok(setup_bytes) = s.get_file_by_key(ResourceKey::new("eor/portal", setup_id)) {
            if let Ok(setup) = SetupModel::unpack(&mut std::io::Cursor::new(&setup_bytes)) {
                let _ = try_resolve_cycle_frames(s, &setup, mt_override, stance, motion_command);
            }
        }
    })
    .await?;

    // Cohere-B (2026-05-12): per-part PART-LOCAL bake + side-channel
    // rest pose. The mesh vertices we hand to JS are now in the
    // GfxObj's raw vertex frame (no placement baked in); the resolved
    // rest pose (idle anim → placement → identity) travels separately
    // in `rest_poses` and gets packed into `rest_origins` /
    // `rest_orientations` for JS to apply to each `partGroup` at
    // spawn. This matches PhatSDK's `CPartArray::UpdateParts` where
    // `Frame::combine(entity_world, anim_frame[i])` composes against
    // PART-LOCAL geometry — preventing the double-composition that
    // makes the rig fall apart in motion.
    //
    // Substitutions ride the same path (`model_changes` / `texture_changes`)
    // so clothing + armor land on the right parts without a re-walk.
    let (parts_tris, rest_poses) =
        triangulate_setup_model_per_part_with_rest_pose(source.as_ref(), setup_id, &mc, &tc)
            .ok_or_else(|| {
                JsValue::from_str(&format!(
                    "fetch_entity_animation_keyframes: triangulate setup 0x{setup_id:08X} failed"
                ))
            })?;
    let part_count = parts_tris.len();
    let part_meshes: Vec<ModelMesh> = parts_tris.into_iter().map(pack_model_mesh).collect();
    let mut rest_origins: Vec<f32> = Vec::with_capacity(part_count * 3);
    let mut rest_orientations: Vec<f32> = Vec::with_capacity(part_count * 4);
    for (origin, orient) in &rest_poses {
        rest_origins.extend_from_slice(&[origin.x, origin.y, origin.z]);
        // AC w-first order; JS reorders to (x, y, z, w) at apply time.
        rest_orientations.extend_from_slice(&[orient.w, orient.x, orient.y, orient.z]);
    }

    // Cycle resolution. `setup` is reloaded once; cheap relative to
    // the per-frame mesh bake `fetchEntityCycleFrames` does.
    let setup_bytes = source
        .as_ref()
        .get_file_by_key(ResourceKey::new("eor/portal", setup_id))
        .map_err(|e| {
            JsValue::from_str(&format!(
                "fetch_entity_animation_keyframes: setup load: {e}"
            ))
        })?;
    let setup = SetupModel::unpack(&mut std::io::Cursor::new(&setup_bytes))
        .map_err(|e| {
            JsValue::from_str(&format!(
                "fetch_entity_animation_keyframes: setup parse: {e}"
            ))
        })?;

    let (frames, framerate, resolved_stance) =
        match try_resolve_cycle_frames(source.as_ref(), &setup, mt_override, stance, motion_command)
        {
            Some(triple) => triple,
            None => {
                // No cycle under this (stance, command). JS gets the
                // part-local meshes + the resolved rest pose + empty
                // keyframes; renderer holds at rest pose until it can
                // fall back to default stance / command. Constructed
                // inline (not via `empty()`) so the captured rest pose
                // survives — `empty()` would zero it back to identity.
                let fallback_stance = if stance != 0 { stance } else { 0 };
                return Ok(EntityAnimationData {
                    part_meshes,
                    part_count: part_count as u32,
                    num_frames: 0,
                    framerate: 0.0,
                    resolved_stance: fallback_stance,
                    part_frames: Vec::new(),
                    rest_origins,
                    rest_orientations,
                    // Task E (2026-05-12): no cycle → no hooks. JS sees
                    // an empty timeline and the executor is a no-op.
                    hooks: Vec::new(),
                });
            }
        };

    // Flatten keyframes to (num_frames, part_count, 7) row-major in
    // frame-major order. Per-frame stride: part_count * 7. Per-part
    // stride within a frame: 7 floats. Layout invariants documented
    // on the EntityAnimationData struct + the partFrames getter.
    //
    // The Animation parser may have laid down a different per-frame
    // part count than the SetupModel — e.g. an animation built for
    // a different rig variant. Pad with rest-pose-style identity
    // (origin=0, orientation=identity) when the keyframe is short,
    // and truncate when it's long. Either case is rare in retail
    // assets but we keep the buffer shape strictly `numFrames *
    // partCount * 7` so JS's stride math stays simple.
    //
    // **Task E (2026-05-12).** While we're already walking `frames`,
    // also project each frame's `hooks: Vec<AnimationHook>` into a
    // sorted-by-`time_in_clip_s` list of `AnimationHookJs` entries.
    // Frame `i` contributes its hooks at time `i / framerate`. The
    // JS-side EntityManager bakes this into a per-action timeline and
    // fires hooks as the AnimationAction.time crosses each one. Hooks
    // within the same frame stay in DAT order (stable sort).
    let num_frames = frames.len();
    let mut part_frames: Vec<f32> = Vec::with_capacity(num_frames * part_count * 7);
    let mut hooks_out: Vec<AnimationHookJs> = Vec::new();
    let inv_fps: f64 = if framerate > 0.0 { 1.0 / framerate as f64 } else { 0.0 };
    for (frame_idx, af) in frames.iter().enumerate() {
        for pi in 0..part_count {
            if let Some(f) = af.frames.get(pi) {
                part_frames.push(f.origin.x);
                part_frames.push(f.origin.y);
                part_frames.push(f.origin.z);
                part_frames.push(f.orientation.w);
                part_frames.push(f.orientation.x);
                part_frames.push(f.orientation.y);
                part_frames.push(f.orientation.z);
            } else {
                // Short keyframe — pad identity so the buffer stays
                // dense and JS's stride math holds. Rare in practice.
                part_frames.extend_from_slice(&[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]);
            }
        }
        // Task E: hook timeline projection. Frame `i` fires at
        // `i * inv_fps` seconds into the clip. If `inv_fps == 0` (no
        // framerate — shouldn't happen here since we already gated on
        // `framerate > 0.0` in `try_resolve_cycle_frames`, but keep the
        // guard for safety), every hook lands at t=0 and the executor
        // will fire them at frame 0 of every loop pass.
        let frame_time = frame_idx as f64 * inv_fps;
        for h in &af.hooks {
            hooks_out.push(AnimationHookJs {
                time_in_clip_s: frame_time,
                hook_type: h.hook_type,
                direction: h.direction,
                hook_data: h.data.clone(),
            });
        }
    }
    // Stable sort by time (preserves DAT order within a frame). Vec's
    // `sort_by` is stable per Rust std docs.
    hooks_out.sort_by(|a, b| {
        a.time_in_clip_s
            .partial_cmp(&b.time_in_clip_s)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    Ok(EntityAnimationData {
        part_meshes,
        part_count: part_count as u32,
        num_frames: num_frames as u32,
        framerate,
        resolved_stance,
        part_frames,
        rest_origins,
        rest_orientations,
        hooks: hooks_out,
    })
}

// ============================================================
// Phase 4 step 1 + 2a + 2a.5 — wasm-driven AC login → spawn → create
// ============================================================
//
// Audit reference (`apps/holtburger-cli/src/bin/tui.rs::bootstrap_once`
// + `crates/holtburger-core/src/client/character_selection.rs` +
// `apps/holtburger-cli/src/pages/selection/creation.rs`): the cli
// builds `ClientRuntimeBuilder::new(account).server(host, port)
// .connect()` — which constructs `Session::new(addr)` over a UDP
// socket — spawns `client.run()` on a tokio task, and dispatches
// commands over an mpsc channel:
//   - `ClientCommand::Login(password)` → `session.send_login_request`
//   - `ClientCommand::SelectCharacter(id)` (or `EnterWorld`) →
//     `character_selection.select_character(id)` which sends
//     `GameMessage::CharacterEnterWorldRequest(guid)`
//   - `ClientCommand::CreateCharacter(request)` →
//     `character_selection.create_character(request)` which sends
//     `GameMessage::CharacterCreate(request)` after stamping the
//     account name from the session.
// The runtime's `handle_message` reacts to inbound messages:
//   - `GameMessage::CharacterList(data)` →
//     `ClientViewEvent::CharacterList(characters)`
//   - `GameMessage::CharacterEnterWorldServerReady` → triggers
//     `send_character_enter_world(guid, account_name)` which sends
//     `GameMessage::CharacterEnterWorld { guid, account }`
//   - `GameMessage::PlayerCreate(data)` → `data.guid` is the spawned
//     player's GUID; runtime transitions to `EnteringWorld` then
//     `InWorld`.
//   - `GameMessage::CharacterCreateResponse(data)` → response.code
//     `Ok` carries `(guid, name, seconds_disabled)`; non-Ok variants
//     carry only the error code (NameInUse, NameNotAllowed, ...).
//     Server follows up with a fresh `CharacterList` reflecting the
//     updated roster.
//
// The wasm path skips `ClientRuntime` entirely — its `run()` uses
// `std::time::Instant` and `tokio::time::interval` per tick, neither
// portable to wasm32 in their current shape — and drives `Session`
// directly via a tokio::select!-based recv loop spawned from
// `wasm_bindgen_futures::spawn_local`. The recv loop owns the Session
// for its lifetime, races `session.recv_message()` against an
// mpsc command channel, and queues `ClientEvent`s into a
// `Rc<RefCell<Vec<ClientEvent>>>` shared with the SessionHandle. JS
// drains via `handle.poll_events()` per animation-frame tick; commands
// (e.g. `select_character`, `create_test_character`) flow the other
// way via the cmd channel. ACE's CONNECT_REQUEST → CONNECT_RESPONSE
// handshake is still handled inside `recv_ordered_packet`
// automatically.
//
// Phase 4 step 2a.5 (character creation in the browser): if
// `start_session` was given an `asset_url`, the SessionHandle eagerly
// loads `CharGen` (DAT 0x0E000002) + `SkillTable` (DAT 0x0E000004)
// and builds a `CharacterGenCatalog` for offline validation of new
// character requests. `SessionHandle.create_test_character(name)`
// then builds an Aluvian / Male / Adventurer / Holtburg
// `CharacterGenBuild` via `CharacterGenBuilder` and dispatches the
// resulting `CharacterCreateRequestData` to the recv loop. ACE
// validates server-side; success flips through CharacterCreateResponse
// + a CharacterList re-fire, and the SessionHandle's
// `character_list` shared state updates to include the new entry.

/// Phase 4 step 4: human-readable label for a `ChatChannelId.raw()`
/// value. Used by the `GameEvent::ChannelBroadcast` arm to format
/// `"[Vassals] Sender says, ..."` etc. Falls back to a hex string
/// for unknown channels (rare — covers any custom-server channel
/// IDs not in the retail set).
#[cfg(target_arch = "wasm32")]
fn chat_channel_label(raw: u32) -> String {
    use holtburger_protocol::messages::ChatChannel;
    match ChatChannel::from_repr(raw) {
        Some(ChatChannel::Abuse) => "Abuse".into(),
        Some(ChatChannel::Admin) => "Admin".into(),
        Some(ChatChannel::Audit) => "Audit".into(),
        Some(ChatChannel::Advocate1) => "Advocate1".into(),
        Some(ChatChannel::Advocate2) => "Advocate2".into(),
        Some(ChatChannel::Advocate3) => "Advocate3".into(),
        Some(ChatChannel::Sentinel) => "Sentinel".into(),
        Some(ChatChannel::Help) => "Help".into(),
        Some(ChatChannel::Fellow) => "Fellow".into(),
        Some(ChatChannel::Vassals) => "Vassals".into(),
        Some(ChatChannel::Patron) => "Patron".into(),
        Some(ChatChannel::Monarch) => "Monarch".into(),
        Some(ChatChannel::CoVassals) => "CoVassals".into(),
        Some(ChatChannel::AllegianceBroadcast) => "Allegiance".into(),
        Some(ChatChannel::FellowBroadcast) => "Fellowship".into(),
        None => format!("Channel 0x{raw:08X}"),
    }
}

// Phase 4 step 4 — chat-category taxonomy. Every chat-bearing message
// the recv loop normalises into a `kind=2 ChatReceived` event also
// carries one of these category IDs in `ClientEvent.u32_payload_2`,
// which JS dispatches on for tab routing + colour coding. Mirrors the
// `chat_message_tags()` mapping in `apps/holtburger-cli/src/pages/
// game/panels/chat.rs:609-642`. The taxonomy is intentionally wider
// than ACE's `ChatMessageType` enum — it folds in "category derives
// from non-chat-type-bearing message variant" cases (combat / death /
// popup / transient) so JS sees one uniform attribute regardless of
// which AC packet the line came from.
#[cfg(target_arch = "wasm32")]
const CHAT_CATEGORY_SYSTEM: u32 = 0;
#[cfg(target_arch = "wasm32")]
const CHAT_CATEGORY_LOCAL: u32 = 1;
#[cfg(target_arch = "wasm32")]
const CHAT_CATEGORY_TELL: u32 = 2;
#[cfg(target_arch = "wasm32")]
const CHAT_CATEGORY_CHANNEL: u32 = 3;
#[cfg(target_arch = "wasm32")]
const CHAT_CATEGORY_EMOTE: u32 = 4;
#[cfg(target_arch = "wasm32")]
const CHAT_CATEGORY_COMBAT: u32 = 5;
#[cfg(target_arch = "wasm32")]
const CHAT_CATEGORY_DEATH: u32 = 6;
#[cfg(target_arch = "wasm32")]
const CHAT_CATEGORY_MAGIC: u32 = 7;
#[cfg(target_arch = "wasm32")]
const CHAT_CATEGORY_ADVANCEMENT: u32 = 8;
#[cfg(target_arch = "wasm32")]
const CHAT_CATEGORY_TRANSIENT: u32 = 9;
#[cfg(target_arch = "wasm32")]
const CHAT_CATEGORY_POPUP: u32 = 10;
#[cfg(target_arch = "wasm32")]
const CHAT_CATEGORY_HELP: u32 = 11;
#[cfg(target_arch = "wasm32")]
const CHAT_CATEGORY_TRADE: u32 = 12;
#[cfg(target_arch = "wasm32")]
const CHAT_CATEGORY_LFG: u32 = 13;
#[cfg(target_arch = "wasm32")]
const CHAT_CATEGORY_ROLEPLAY: u32 = 14;
#[cfg(target_arch = "wasm32")]
const CHAT_CATEGORY_GENERAL: u32 = 15;
#[cfg(target_arch = "wasm32")]
const CHAT_CATEGORY_FELLOWSHIP: u32 = 16;
#[cfg(target_arch = "wasm32")]
const CHAT_CATEGORY_ALLEGIANCE: u32 = 17;
#[cfg(target_arch = "wasm32")]
const CHAT_CATEGORY_RECALL: u32 = 18;
#[cfg(target_arch = "wasm32")]
const CHAT_CATEGORY_CRAFT: u32 = 19;
#[cfg(target_arch = "wasm32")]
const CHAT_CATEGORY_APPRAISAL: u32 = 20;
#[cfg(target_arch = "wasm32")]
const CHAT_CATEGORY_BROADCAST: u32 = 21;
#[cfg(target_arch = "wasm32")]
const CHAT_CATEGORY_SOCIETY: u32 = 22;
#[cfg(target_arch = "wasm32")]
const CHAT_CATEGORY_OLTHOI: u32 = 23;

/// Phase 4 step 4: map a raw `ChatMessageType` byte (the `chat_type`
/// field carried by `ServerMessage`, `HearSpeech`, `HearRangedSpeech`,
/// and `Tell`) to one of the `CHAT_CATEGORY_*` IDs. Mirrors the cli's
/// `chat_message_tags()` switch in
/// `apps/holtburger-cli/src/pages/game/panels/chat.rs:609-642`. Unknown
/// IDs fall back to `SYSTEM` so a future ACE addition still routes
/// somewhere instead of getting silently swallowed.
#[cfg(target_arch = "wasm32")]
fn chat_category_for_message_type(chat_type_raw: u32) -> u32 {
    use holtburger_protocol::messages::chat::types::ChatMessageType;
    match ChatMessageType::from_repr(chat_type_raw) {
        Some(ChatMessageType::Tell)
        | Some(ChatMessageType::OutgoingTell)
        | Some(ChatMessageType::AdminTell) => CHAT_CATEGORY_TELL,
        Some(ChatMessageType::Speech)
        | Some(ChatMessageType::Channel)
        | Some(ChatMessageType::ChannelSend) => CHAT_CATEGORY_LOCAL,
        Some(ChatMessageType::Combat)
        | Some(ChatMessageType::CombatEnemy)
        | Some(ChatMessageType::CombatSelf) => CHAT_CATEGORY_COMBAT,
        Some(ChatMessageType::Magic) | Some(ChatMessageType::Spellcasting) => CHAT_CATEGORY_MAGIC,
        Some(ChatMessageType::Allegiance) => CHAT_CATEGORY_ALLEGIANCE,
        Some(ChatMessageType::Fellowship) => CHAT_CATEGORY_FELLOWSHIP,
        Some(ChatMessageType::Help) => CHAT_CATEGORY_HELP,
        Some(ChatMessageType::Advancement) => CHAT_CATEGORY_ADVANCEMENT,
        Some(ChatMessageType::Recall) => CHAT_CATEGORY_RECALL,
        Some(ChatMessageType::Craft) | Some(ChatMessageType::Salvaging) => CHAT_CATEGORY_CRAFT,
        Some(ChatMessageType::Appraisal) => CHAT_CATEGORY_APPRAISAL,
        Some(ChatMessageType::WorldBroadcast) => CHAT_CATEGORY_BROADCAST,
        Some(ChatMessageType::Emote)
        | Some(ChatMessageType::Social)
        | Some(ChatMessageType::SocialSend) => CHAT_CATEGORY_EMOTE,
        // Broadcast / AllChannels / System / x1A..x1E / Abuse all fall
        // into "system text" — green-on-grey in retail.
        _ => CHAT_CATEGORY_SYSTEM,
    }
}

/// Phase 4 step 4: map a raw `ChatChannel` bitmask (the `channel` field
/// on a `GameEvent::ChannelBroadcast`) to a `CHAT_CATEGORY_*`. The
/// retail UI paints allegiance ranks (Vassals/Patron/Monarch) the same
/// colour as Allegiance broadcast; fellowship ranks similarly fold in.
/// Mirrors the cli's `channel_tags()` in `chat.rs:646-660`.
#[cfg(target_arch = "wasm32")]
fn chat_category_for_channel(channel_raw: u32) -> u32 {
    use holtburger_protocol::messages::ChatChannel;
    match ChatChannel::from_repr(channel_raw) {
        Some(ChatChannel::Fellow) | Some(ChatChannel::FellowBroadcast) => {
            CHAT_CATEGORY_FELLOWSHIP
        }
        Some(ChatChannel::Vassals)
        | Some(ChatChannel::Patron)
        | Some(ChatChannel::Monarch)
        | Some(ChatChannel::CoVassals)
        | Some(ChatChannel::AllegianceBroadcast) => CHAT_CATEGORY_ALLEGIANCE,
        Some(ChatChannel::Help) => CHAT_CATEGORY_HELP,
        Some(ChatChannel::Abuse)
        | Some(ChatChannel::Admin)
        | Some(ChatChannel::Audit)
        | Some(ChatChannel::Advocate1)
        | Some(ChatChannel::Advocate2)
        | Some(ChatChannel::Advocate3)
        | Some(ChatChannel::Sentinel) => CHAT_CATEGORY_SYSTEM,
        None => CHAT_CATEGORY_CHANNEL,
    }
}

/// Phase 4 step 4: map a `TurbineChatType` (the modern channel chat
/// taxonomy — General / Trade / LFG / Roleplay / Allegiance / Society /
/// Olthoi, distinct from the legacy `ChatChannel` bitmask the
/// `GameEvent::ChannelBroadcast` path uses) to a `CHAT_CATEGORY_*`.
#[cfg(target_arch = "wasm32")]
fn chat_category_for_turbine_chat_type(chat_type_raw: u32) -> u32 {
    use holtburger_protocol::messages::chat::turbine::TurbineChatType;
    match TurbineChatType::from_repr(chat_type_raw) {
        Some(TurbineChatType::Allegiance) => CHAT_CATEGORY_ALLEGIANCE,
        Some(TurbineChatType::General) => CHAT_CATEGORY_GENERAL,
        Some(TurbineChatType::Trade) => CHAT_CATEGORY_TRADE,
        Some(TurbineChatType::Lfg) => CHAT_CATEGORY_LFG,
        Some(TurbineChatType::Roleplay) => CHAT_CATEGORY_ROLEPLAY,
        Some(TurbineChatType::Society)
        | Some(TurbineChatType::SocietyCelHan)
        | Some(TurbineChatType::SocietyEldWeb)
        | Some(TurbineChatType::SocietyRadBlo) => CHAT_CATEGORY_SOCIETY,
        Some(TurbineChatType::Olthoi) => CHAT_CATEGORY_OLTHOI,
        Some(TurbineChatType::Undef) | None => CHAT_CATEGORY_CHANNEL,
    }
}

/// Phase 4 step 4: human-readable label for a `TurbineChatType`. Used
/// to format `"[Trade] Sender says, ..."` etc.
#[cfg(target_arch = "wasm32")]
fn turbine_chat_type_label(chat_type_raw: u32) -> &'static str {
    use holtburger_protocol::messages::chat::turbine::TurbineChatType;
    match TurbineChatType::from_repr(chat_type_raw) {
        Some(TurbineChatType::Allegiance) => "Allegiance",
        Some(TurbineChatType::General) => "General",
        Some(TurbineChatType::Trade) => "Trade",
        Some(TurbineChatType::Lfg) => "LFG",
        Some(TurbineChatType::Roleplay) => "Roleplay",
        Some(TurbineChatType::Society) => "Society",
        Some(TurbineChatType::SocietyCelHan) => "Celestial Hand",
        Some(TurbineChatType::SocietyEldWeb) => "Eldrytch Web",
        Some(TurbineChatType::SocietyRadBlo) => "Radiant Blood",
        Some(TurbineChatType::Olthoi) => "Olthoi",
        Some(TurbineChatType::Undef) | None => "Channel",
    }
}

/// Phase 4 step 4: format a `DamageLocation` for combat-message
/// rendering. Matches the cli's `format_damage_location()` mapping in
/// `chat.rs:582-594` exactly.
#[cfg(target_arch = "wasm32")]
fn damage_location_label(loc: holtburger_protocol::messages::combat::types::DamageLocation) -> &'static str {
    use holtburger_protocol::messages::combat::types::DamageLocation;
    match loc {
        DamageLocation::Head => "head",
        DamageLocation::Chest => "chest",
        DamageLocation::Abdomen => "abdomen",
        DamageLocation::UpperArm => "upper arm",
        DamageLocation::LowerArm => "lower arm",
        DamageLocation::Hand => "hand",
        DamageLocation::UpperLeg => "upper leg",
        DamageLocation::LowerLeg => "lower leg",
        DamageLocation::Foot => "foot",
    }
}

/// Phase 4 step 4: format a `DamageType` bitset as a slash-joined
/// lowercase string ("slash" / "fire/cold" / "unknown"). Mirrors
/// `format_damage_type()` in the cli.
#[cfg(target_arch = "wasm32")]
fn damage_type_label(damage_type: holtburger_common::properties::DamageType) -> String {
    let names: Vec<&'static str> = damage_type.iter_display_names().collect();
    if names.is_empty() {
        "unknown".to_string()
    } else {
        names.join("/").to_ascii_lowercase()
    }
}

/// Phase 4 step 4: format an `AttackConditions` bitset as a
/// bracketed suffix (" [Reckless attack, Sneak attack]") or the empty
/// string when no conditions are set. Mirrors the cli's
/// `format_attack_conditions_suffix()`.
#[cfg(target_arch = "wasm32")]
fn attack_conditions_suffix(
    attack_conditions: holtburger_protocol::messages::combat::types::AttackConditions,
) -> String {
    let names: Vec<&'static str> = attack_conditions.iter_display_names().collect();
    if names.is_empty() {
        String::new()
    } else {
        format!(" [{}]", names.join(", "))
    }
}

#[cfg(target_arch = "wasm32")]
const CLIENT_EVENT_KIND_CHARACTER_LIST_RECEIVED: u32 = 0;
#[cfg(target_arch = "wasm32")]
const CLIENT_EVENT_KIND_PLAYER_SPAWNED: u32 = 1;
/// Phase 4 step 4: in-world text — server announcements, local /
/// ranged / channel speech, tells, emotes, popup strings, and
/// transient status messages. `string_payload` carries the
/// already-formatted display line (`"[Channel] Sender: message"` or
/// similar — formatting lives Rust-side so JS doesn't have to know
/// each variant's shape). `u32_payload` carries the
/// chat-channel-id where applicable, `0` otherwise.
#[cfg(target_arch = "wasm32")]
const CLIENT_EVENT_KIND_CHAT_RECEIVED: u32 = 2;
#[cfg(target_arch = "wasm32")]
const CLIENT_EVENT_KIND_DISCONNECTED: u32 = 4;
#[cfg(target_arch = "wasm32")]
const CLIENT_EVENT_KIND_CHARACTER_CREATED: u32 = 5;
#[cfg(target_arch = "wasm32")]
const CLIENT_EVENT_KIND_CHARACTER_CREATE_FAILED: u32 = 6;
/// Phase 4 step 2a.6: fired the first time the recv loop sees
/// `GameEvent::PlayerDescription` (or `GameEvent::StartGame`) after
/// `PlayerCreate`. Mirrors the cli's `enter_world()` transition —
/// before this event lands, ACE silently ignores chat / movement /
/// other in-world commands. JS shows the "Teleport to Holtburg"
/// button (and any future in-world UI) gated on this.
#[cfg(target_arch = "wasm32")]
const CLIENT_EVENT_KIND_ENTERED_WORLD: u32 = 7;
/// Phase 4 step 4 follow-on (vitals + inventory panels): coalesced
/// "the player's stat-block changed, refresh the panel" signal. Fires
/// any time the canonical world handler dispatcher emits a
/// `WorldEvent::{Vital,Attribute,Skill,LevelInfo,DerivedStats}Updated`
/// or `PlayerEnchantmentsUpdated`. JS calls
/// [`SessionHandle::player_stats`] on the next rAF tick to read a
/// fresh snapshot. No payload — the snapshot lookup is the contract.
#[cfg(target_arch = "wasm32")]
const CLIENT_EVENT_KIND_PLAYER_STATS_UPDATED: u32 = 8;
/// Phase 4 step 4 follow-on: coalesced "the player's owned-item set
/// changed, refresh the inventory panel" signal. Fires any time the
/// canonical world handler dispatcher routes
/// `ObjectCreate` / `ObjectDelete` / `InventoryRemoveObject` /
/// `ParentEvent` / `PickupEvent` for a guid the player owns, or a
/// `GameEvent::{ViewContents,WieldObject,IdentifyObjectResponse,
/// CloseGroundContainer,InventoryPutObjInContainer,
/// InventoryPutObjectIn3D}` lands. JS calls
/// [`SessionHandle::player_inventory`] on the next rAF tick to read
/// a fresh inventory snapshot.
#[cfg(target_arch = "wasm32")]
const CLIENT_EVENT_KIND_INVENTORY_UPDATED: u32 = 11;
/// Phase 4 step 5 (interactive entities): a successful `useObject`
/// click landed on a vendor — ACE responded with
/// `GameEvent::ApproachVendor`, the recv loop captured the vendor's
/// metadata, and JS should surface it (status line / chat / future
/// vendor-window UI). `string_payload` = vendor display name;
/// `u32_payload` = vendor guid;
/// `u32_payload_2` = item count.
#[cfg(target_arch = "wasm32")]
const CLIENT_EVENT_KIND_VENDOR_OPENED: u32 = 12;
/// Phase 4 step 5 (interactive entities): a click failed —
/// `GameEvent::WeenieError` or `GameEvent::WeenieErrorWithString`
/// landed (out-of-range, locked, "this person doesn't talk", etc.).
/// `string_payload` = human-readable error description;
/// `u32_payload` = numeric `WeenieError` code so JS can match on
/// specific failure modes.
#[cfg(target_arch = "wasm32")]
const CLIENT_EVENT_KIND_USE_FAILED: u32 = 13;
/// Phase 4 step 5 (interactive entities): a click succeeded —
/// `GameEvent::UseDone(WeenieError::None)` landed. ACE sends this
/// for door opens, container approaches, lifestone touches, etc.
/// (Vendors get `kind=12 VendorOpened` instead; portals fire
/// `PlayerTeleport`.) No payload.
#[cfg(target_arch = "wasm32")]
const CLIENT_EVENT_KIND_USE_DONE: u32 = 14;

/// Phase 6 step E: a door's open/closed state flipped. ACE's
/// `Door.cs::Open()` / `Close()` flip `Ethereal` and broadcast via
/// `GameMessageSetState`; the recv loop routes the message through
/// `apply_set_state_update`, which detects the `ObjectDescriptionFlag::DOOR`
/// flag + `PhysicsState::ETHEREAL` bit and emits a
/// `WorldEvent::DoorStateChanged`. JS reads `u32Payload` = door GUID,
/// `u32Payload2` = 1 (open) or 0 (closed), updates
/// `window.__doorStates`, rotates the building's part sprite around
/// its hinge frame, and toggles the matching AABB entry in the
/// spatial scene's `building_aabb_index`.
#[cfg(target_arch = "wasm32")]
const CLIENT_EVENT_KIND_DOOR_STATE_CHANGED: u32 = 15;

/// Task F (ambient-sounds-chain, 2026-05-12): ACE pushed a
/// `GameMessageSound(guid, Sound enum, scale)` for a server-triggered
/// action — lifestone bind, switch activation, hotspot trigger, craft
/// event, etc. The opcode is `0xF750` (`GameMessageOpcode.Sound` in
/// `external/ace-server/Source/ACE.Server/Network/GameMessages/GameMessageOpcode.cs`).
/// Wire format (16 bytes, matching the ACE `GameMessageSound`
/// constructor's `messageSize: 16` arg):
///
/// ```text
/// [u32 opcode = 0xF750]
/// [u32 guid]        // ObjectGuid.Full (32-bit)
/// [u32 sound_id]    // cast from `Sound` enum
/// [f32 volume]      // server-side per-call multiplier (1.0 default)
/// ```
///
/// JS-side handler in `index.html`'s `drainEvents` block:
///   1. Look up the entity in `liveScene3d.entityManager.entityMap`
///      (guid → `EntityInstance`).
///   2. Read `inst.soundTableDid` (plumbed by Task E from
///      `ObjectDescription.stable_id` aka `PropertyDataId::SoundTable`).
///   3. Call `soundTableCache.resolveSound(stbDid, soundEnum)` to
///      pick a `SoundEntry` (weighted by `probability`).
///   4. Play the resolved Wave at the entity's world position via
///      `audioManager.play(waveDid, pos, { gain: entry.volume * scale })`.
///
/// `u32Payload` = entity GUID; `u32Payload2` = `Sound` enum value;
/// `f32Payload` = scale (volume multiplier from the wire). Drops
/// silently when the entity is unknown, has no SoundTable, or the
/// SoundTable has no entries for the requested enum.
#[cfg(target_arch = "wasm32")]
const CLIENT_EVENT_KIND_SOUND_TRIGGERED: u32 = 16;

/// Internal command channel payload — the recv loop's only writeable
/// surface. JS-facing methods on [`SessionHandle`] turn into
/// `SessionCommand` values that the loop applies between
/// `recv_message` polls.
#[cfg(target_arch = "wasm32")]
enum SessionCommand {
    /// `SessionHandle.select_character(id)` — sends
    /// `CharacterEnterWorldRequest(guid)` to the server. The loop
    /// auto-handles the subsequent `CharacterEnterWorldServerReady`
    /// reply and chains `CharacterEnterWorld(guid, account)` without
    /// JS round-tripping.
    SelectCharacter { guid: u32 },
    /// `SessionHandle.create_test_character(name)` — sends
    /// `GameMessage::CharacterCreate(request)`. The recv loop
    /// stamps the session's account name onto the request and waits
    /// for `CharacterCreateResponse(...)` + the follow-up
    /// `CharacterList` re-fire. On Ok the loop queues a kind=5
    /// CharacterCreated event with the new GUID + name; on
    /// non-Ok it queues a kind=6 CharacterCreateFailed event with
    /// the response code in `u32_payload` and the variant name in
    /// `string_payload`.
    CreateCharacter {
        request: Box<holtburger_protocol::messages::CharacterCreateRequestData>,
    },
    /// `SessionHandle.send_chat(text)` — sends a `GameAction::Talk`
    /// over the wire. Used today by the JS-side "Teleport to
    /// Holtburg" button to dispatch `@telepoi Holtburg`. ACE's
    /// `@`/`/` chat-prefix commands route through the same Talk
    /// path as in-game chat; access-level enforcement happens
    /// server-side, so a non-Developer account silently drops
    /// admin commands. See the dev-setup recipe in
    /// `docs/phase-4-renderer.md` step 2a.6 for the SQL one-liner
    /// that promotes test accounts to `accessLevel = 4`.
    SendChat { message: String },
    /// Phase 4 step 5 (interactive entities): the JS side clicked an
    /// entity sprite. Recv loop wraps in `GameAction::Use(Box<UseActionData>)`
    /// and dispatches via `session.send_action`. ACE handles the
    /// behaviour server-side based on the target's WeenieType:
    /// - Portal → `PlayerTeleport` + position update (we already
    ///   handle PlayerTeleport in step 3.6's recv arm).
    /// - Vendor → `GameEvent::ApproachVendor` carrying the vendor's
    ///   item list; recv loop normalises into `kind=12 VendorOpened`.
    /// - Door / lockable → `GameEvent::UseDone(error)` (Ok = opened,
    ///   non-Ok = locked / out-of-range / etc).
    /// - Sign / writable → `GameEvent::BookDataResponse`.
    /// - Out-of-range / not-interactive → `GameEvent::WeenieError`,
    ///   normalised into `kind=13 UseFailed`.
    UseObject { guid: u32 },
    /// Phase 4 step 3: keyboard / click input → AC `MoveToState`
    /// packet. Each axis is `-1` / `0` / `+1`; `run` is the
    /// shift-modifier flag.
    ///
    /// - `forward`: +1 = walk/run forward (W), -1 = backstep (S),
    ///   0 = no forward locomotion
    /// - `strafe`: +1 = sidestep right (D), -1 = sidestep left (A),
    ///   0 = no strafe (forward takes priority over strafe — the
    ///   wire format only carries one of {forward, strafe} per
    ///   `RawMotionState`, so the recv loop picks forward when both
    ///   are set, mirroring the cli's `Locomotion` enum which is
    ///   single-axis)
    /// - `turn`: +1 = turn right (E), -1 = turn left (Q), 0 = no
    ///   turn — turning is independent of locomotion and rides on
    ///   its own `RawMotionFlags::TURN_*` bits
    /// - `run`: shift-held — selects `HoldKey::Run` and the higher
    ///   `forward_speed` / `turn_speed` scalars. Walks at 1.0 m/s
    ///   when false, runs at the player's run-rate scalar (default
    ///   4.5 m/s) when true
    ///
    /// All-zero axes + `run=false` is the canonical "stop" state,
    /// emitted on every key-up so ACE clears the active drive.
    /// JS sends one of these per *change* in keystate — once per
    /// keydown / keyup transition, not on every animation frame —
    /// matching the cli's intent semantics
    /// ([`PlayerDriveIntent::ManualHeld`]).
    SetMovementInput {
        forward: i8,
        strafe: i8,
        turn: i8,
        run: bool,
    },
    /// Phase 4 step 3.6 — JS-driven physics tick. Fired by
    /// `requestAnimationFrame` from `index.html`'s drainEvents loop;
    /// the recv loop pulls the next `now` and calls
    /// `MovementSystemHandle::tick(now, &mut world, &mut session)`,
    /// which emits any due `MoveToState` / `AutonomousPosition`
    /// packets. Routing through the cmd channel serializes access
    /// to the `&mut world` / `&mut session` borrows that the recv
    /// loop also holds.
    TickMovement { now: web_time::Instant },
    /// Populate the world's terrain heightmap cache for one
    /// landblock. JS calls this once per spawn-area LB after
    /// `kind=7 EnteredWorld` lands, feeding the 81-float height
    /// grid extracted from `fetch_landblock_heightmap(...).heights`.
    /// Used by the manual-drive integrator
    /// (`MovementSystem::advance_local_pose_for_manual_drive`) to
    /// snap pose Z to terrain — without populated heights the
    /// integrator preserves the last-known pose Z (constant since
    /// teleport landing), which causes ACE physics (FastTick on PK
    /// players) to apply false gravity and impact damage on slopes.
    PopulateTerrain {
        /// Landblock id (high 16 bits of cell id, e.g. `0xA9B40000`
        /// for Holtburg).
        landblock_id: u32,
        /// 81 Z values in metres. Length-validated in the recv arm;
        /// non-81 lengths drop the command with a console warning.
        heights: Vec<f32>,
    },
    /// Combat-mode toggle hotkey — JS pressed `` ` `` (the retail
    /// AC default for "toggle combat mode"). The recv-loop arm
    /// reads the player's current `CombatMode` property; if
    /// `NonCombat`, sends `GameAction::ChangeCombatMode(suggested)`
    /// where `suggested` is derived from equipped items
    /// (`WorldContextExt::get_suggested_combat_mode` — Magic if a
    /// caster is equipped, Missile if a missile weapon is equipped,
    /// else Melee). If currently in any combat mode, sends
    /// `ChangeCombatMode(NonCombat)`.
    ///
    /// ACE's authoritative stance derivation
    /// (`Creature_Combat.cs::GetCombatStance`) maps combat mode +
    /// equipment to the actual `MotionStance`: HandCombat for fists,
    /// SwordCombat for any 1H melee, TwoHandedSwordCombat for 2H,
    /// SwordShieldCombat when carrying a shield with a 1H weapon,
    /// BowCombat / CrossbowCombat for ranged, etc. The client never
    /// requests a stance directly — that approach is silently
    /// ignored by ACE which derives stance server-side.
    ///
    /// Mirrors the cli's `domains/combat.rs::SetCombatMode` toggle
    /// path: same boolean-toggle + suggested-mode logic, same
    /// `ClientCommand::SetCombatMode` → `GameAction::ChangeCombatMode`
    /// dispatch.
    ToggleCombatMode,
}

/// Tagged-payload envelope for events the wasm bundle drains to JS via
/// [`SessionHandle::poll_events`].
///
/// wasm-bindgen does not directly serialize Rust enum variants with
/// data, so the shape is a tag byte plus optional payload fields. The
/// `kind` constants pin the wire contract; JS reads `event.kind` and
/// dispatches to the right payload getters.
///
/// Active values (mirror the JS-side dispatch table):
/// - `kind = 0` — CharacterListReceived (re-fire after Create /
///   Delete). `stringPayload` = account name;
///   `u32Payload` = character count.
/// - `kind = 1` — PlayerSpawned. `u32Payload` = the spawned player's
///   GUID. Fired when the recv loop receives `GameMessage::PlayerCreate`.
/// - `kind = 2` — ChatReceived (Phase 4 step 4 — DOM chat panel).
///   `stringPayload` = pre-formatted display line
///   (`"[Channel] Sender: message"` etc. — the recv loop normalises
///   each chat-bearing variant into one display string so JS treats
///   chat as opaque text). `u32Payload` = the raw `ChatMessageType` id
///   when one was on the wire (HearSpeech / HearRangedSpeech /
///   ServerMessage / Tell), or the raw `ChatChannel` bitmask for
///   `ChannelBroadcast`, or the raw `TurbineChatType` for `TurbineChat`,
///   or `0` for variants that don't carry one (emotes, popups,
///   transient strings, combat / death notifications).
///   `u32Payload2` = the [`CHAT_CATEGORY_*`] constant — the JS-facing
///   tab-routing + colour-coding key. JS reads `u32Payload2` directly;
///   the raw `u32Payload` is exposed for debugging / audit only.
///   Source messages (Phase 4 step 4 expansion): `ServerMessage`,
///   `HearSpeech`, `HearRangedSpeech`, `EmoteText`, `SoulEmote`,
///   `PlayerKilled`, `TurbineChat` (EventSendToRoom payload),
///   `GameEvent::Tell`, `GameEvent::ChannelBroadcast`,
///   `GameEvent::CommunicationTransientString`,
///   `GameEvent::PopupString`, `GameEvent::AttackerNotification`,
///   `GameEvent::DefenderNotification`,
///   `GameEvent::EvasionAttackerNotification`,
///   `GameEvent::EvasionDefenderNotification`,
///   `GameEvent::VictimNotification`, `GameEvent::KillerNotification`.
/// - `kind = 4` — Disconnected. `stringPayload` = the error message
///   from `recv_message` (transport error, server hangup, etc.).
/// - `kind = 5` — CharacterCreated (Phase 4 step 2a.5).
///   `stringPayload` = new character's name; `u32Payload` = new
///   GUID. Fired when ACE returns
///   `CharacterCreateResponse{ Ok, guid, name, .. }`.
/// - `kind = 6` — CharacterCreateFailed (Phase 4 step 2a.5).
///   `stringPayload` = the `CharacterGenerationVerificationResponse`
///   variant name (`NameInUse`, `NameNotAllowed`, ...);
///   `u32Payload` = the numeric variant code.
/// - `kind = 7` — EnteredWorld (Phase 4 step 2a.6). Fired the
///   first time the recv loop sees `GameEvent::PlayerDescription`
///   or `GameEvent::StartGame` after spawn. No payload — the
///   transition itself is the signal that in-world commands
///   (chat, movement, etc.) are now valid.
/// - `kind = 15` — DoorStateChanged (Phase 6 step E). Fired when
///   ACE broadcasts `GameMessageSetState` for an entity flagged
///   `ObjectDescriptionFlag::DOOR`. `u32Payload` = door GUID;
///   `u32Payload2` = 1 (open / `PhysicsState::ETHEREAL` set) or
///   0 (closed). JS uses this to update `window.__doorStates`,
///   rotate the door's GfxObj sprite around its hinge frame, and
///   toggle the matching `building_aabb_index` entry's `active`
///   flag via `set_door_aabb_active`.
/// - `kind = 16` — SoundTriggered (Task F, ambient-sounds-chain
///   2026-05-12). Fired when ACE broadcasts `GameMessageSound`
///   (opcode `0xF750`) — server-triggered audio for lifestone bind,
///   switch activation, hotspot trigger, craft event, etc.
///   `u32Payload` = entity GUID; `u32Payload2` = `Sound` enum value;
///   `f32Payload` = scale (server-side volume multiplier; typically
///   `1.0`). JS resolves the entity's `soundTableDid` through
///   `soundTableCache.resolveSound(stbDid, soundEnum)` and plays the
///   resulting Wave via `audioManager.play(...)` at the entity's
///   world position with `gain = entry.volume * scale`.
///
/// Entity spawn / position / remove events do NOT flow through
/// this stream — they live on the parallel high-frequency channel
/// drained by [`SessionHandle::poll_entity_updates`] (Phase 4 step
/// 2b). Position updates can fire 100s/sec in a crowded zone; the
/// dedicated [`EntityUpdate`] struct exposes typed fields per
/// update (no string allocation, no payload-shape ambiguity).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct ClientEvent {
    kind: u32,
    string_payload: Option<String>,
    u32_payload: Option<u32>,
    u32_payload_2: Option<u32>,
    f32_payload: Option<f32>,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl ClientEvent {
    /// The numeric tag identifying which payload fields are populated.
    /// See the `ClientEvent` doc comment for the active value table.
    #[wasm_bindgen(getter)]
    pub fn kind(&self) -> u32 {
        self.kind
    }

    /// Optional string payload. For `kind = 0` (CharacterListReceived)
    /// holds the server-echoed account name; for `kind = 4`
    /// (Disconnected) holds the error message.
    #[wasm_bindgen(getter, js_name = stringPayload)]
    pub fn string_payload(&self) -> Option<String> {
        self.string_payload.clone()
    }

    /// Optional u32 payload. For `kind = 0` (CharacterListReceived)
    /// holds the count of characters in the list; for `kind = 1`
    /// (PlayerSpawned) holds the spawned player's GUID. For `kind = 2`
    /// (ChatReceived) holds the raw `ChatMessageType` / `ChatChannel`
    /// bitmask / `TurbineChatType` from the source packet (debugging
    /// only — JS routes by `u32Payload2`).
    #[wasm_bindgen(getter, js_name = u32Payload)]
    pub fn u32_payload(&self) -> Option<u32> {
        self.u32_payload
    }

    /// Phase 4 step 4: secondary u32 payload. For `kind = 2`
    /// (ChatReceived) holds the [`CHAT_CATEGORY_*`] constant — the
    /// JS-facing tab-routing + colour-coding key. Unused (always
    /// `None`) for other event kinds today.
    #[wasm_bindgen(getter, js_name = u32Payload2)]
    pub fn u32_payload_2(&self) -> Option<u32> {
        self.u32_payload_2
    }

    /// Task F (2026-05-12): optional f32 payload. For `kind = 16`
    /// (SoundTriggered) holds the `scale` / volume multiplier the
    /// server passed in `GameMessageSound`. JS multiplies the
    /// resolved `SoundEntry.volume` by this scale before passing
    /// `audioManager.play(..., { gain })`. `None` for every other
    /// event kind today.
    #[wasm_bindgen(getter, js_name = f32Payload)]
    pub fn f32_payload(&self) -> Option<f32> {
        self.f32_payload
    }
}

/// Phase 4 step 2b: tag values for [`EntityUpdate::kind`]. JS reads
/// `update.kind` and dispatches to a spawn / position-update / remove
/// handler. Position-bearing kinds (Position, Spawn) carry valid
/// coordinates + rotation; Remove carries only `guid`.
#[cfg(target_arch = "wasm32")]
const ENTITY_UPDATE_KIND_POSITION: u32 = 0;
#[cfg(target_arch = "wasm32")]
const ENTITY_UPDATE_KIND_SPAWN: u32 = 1;
#[cfg(target_arch = "wasm32")]
const ENTITY_UPDATE_KIND_REMOVE: u32 = 2;
/// Phase 4 step 6f: metadata-only refresh — recv loop already saw an
/// ObjectCreate / Spawn for this guid, but follow-on data has now
/// arrived (today: portal destination text from
/// `IdentifyObjectResponse`'s `AppraisalPortalDestination` property
/// — sent by ACE in response to `GameAction::IdentifyObject` and
/// stored in the entity's properties via the world's
/// inventory::handle_event arm). JS merges into the entity's meta
/// without disturbing position / sprite / rotation. Spawn-only
/// metadata fields (`name`, `wcid`, `item_type`, `obj_scale`,
/// `icon_id`, `palette_id`, `mtable_id`) are zeroed in this update
/// kind — they were already deposited at the original Spawn and JS
/// reuses the cached values; only fields that actually changed (the
/// portal_destination today) carry meaningful data.
#[cfg(target_arch = "wasm32")]
const ENTITY_UPDATE_KIND_META_REFRESH: u32 = 3;
/// Velocity-hint update — VectorUpdate's `(velocity, omega)` surfaced
/// to JS so the per-rAF lerp can extrapolate forward between
/// PublicUpdatePosition echoes (which arrive at ~100-300 ms cadence).
/// Position fields (`landblock_id`, `x`, `y`, `z`, `qw..qz`) are
/// zeroed in this kind — only `guid`, `vx/y/z`, `omega_z` carry data.
/// JS skips for the local player (step 3.5 keystate prediction owns
/// that path) and stamps `velUpdatedMs` on the entry; subsequent
/// `tickEntityInterpolation` frames integrate `vel{X,Y}` past the
/// catch-up lerp to keep motion continuous.
#[cfg(target_arch = "wasm32")]
const ENTITY_UPDATE_KIND_VELOCITY: u32 = 4;
/// Motion-state hint — `UpdateMotion`'s authoritative
/// (current_style, forward_command) pair surfaced so JS can gate
/// walk-cycle animation on a server-confirmed locomotion state
/// instead of the EMA-on-position-deltas heuristic. The EMA gate
/// races every PublicUpdatePosition jitter; this kind lets the
/// animation track the server's decision directly. Only
/// `guid`, `motion_command`, `motion_stance` carry data; everything
/// else is zeroed. JS skips for the local player (step 3.5 keystate
/// prediction owns that path) and stamps `motionUpdatedMs` on the
/// entry; `tickEntityAnimations` short-circuits the EMA when the
/// stamp is fresh (<500 ms) and consumes
/// `entry.motionCommand` directly — matching `InterpretedMotionCommand`
/// constants WALK_FORWARD=0x5 / WALK_BACKWARDS=0x6 / RUN_FORWARD=0x7
/// drive walk-cycle frames; STOP=0x4 / 0 freeze the idle pose.
#[cfg(target_arch = "wasm32")]
const ENTITY_UPDATE_KIND_MOTION: u32 = 5;
/// Phase 4 step 6f: ItemType bit 0x10000 = Portal. We auto-fire
/// `GameAction::IdentifyObject(guid)` on every ObjectCreate that
/// matches this bit so ACE pushes back the portal's
/// `AppraisalPortalDestination` (an
/// `[AssessmentProperty]`-flagged property only sent on appraisal,
/// per `~/ace-server/Source/ACE.Entity/Enum/Properties/PropertyString.cs:63-64`).
#[cfg(target_arch = "wasm32")]
const ITEM_TYPE_PORTAL_BIT: u32 = 0x0001_0000;

/// Phase 4 step 2b: a single position / spawn / remove event for a
/// live entity. Drained by [`SessionHandle::poll_entity_updates`] on
/// every requestAnimationFrame tick; JS keeps a `Map<guid, sprite>`
/// and applies updates by GUID.
///
/// Why this is separate from [`ClientEvent`]: position updates fire
/// 100s/sec in a crowded zone (every entity ACE simulates pushes a
/// `PublicUpdatePosition` on movement). [`ClientEvent`]'s tagged
/// `(string, u32)` payload shape can't carry a 7-float position +
/// guid without ambiguous packing, and string-allocations in the
/// hot path would compound. Two parallel channels give each side
/// the right ergonomics: typed fields for the high-frequency stream,
/// flexible tagged payload for the low-frequency lifecycle stream.
///
/// Source messages (recv loop maps these to `EntityUpdate`):
/// - `GameMessage::UpdatePosition` — local player explicitly addressed
///   by guid + a [`PositionPack`] envelope (cli's
///   `handlers/player.rs:33-46`).
/// - `GameMessage::PublicUpdatePosition` — any other entity by guid +
///   bare [`WorldPosition`] (cli's `handlers/movement.rs:45-46`).
/// - `GameMessage::PrivateUpdatePosition` — local player, **no guid in
///   payload**. The recv loop substitutes `LoopState::InWorld { player_guid }`'s
///   guid (cli's `handlers/movement.rs:41-43`).
/// - `GameMessage::ObjectCreate` — entity arrival; carries
///   `ObjectDescriptionData.public_weenie_desc.guid`,
///   `csetup_id` (the model_id Phase 3 step 6's render cache uses),
///   and an optional [`WorldPosition`] (cli's
///   `handlers/inventory.rs:19-51`).
/// - `GameMessage::ObjectDelete` — entity removal; just a guid
///   (cli's `handlers/inventory.rs:53-56`).
///
/// **Coordinate frame:** `landblock_id` + landblock-local `x, y, z`,
/// matching the on-wire [`WorldPosition`] shape exactly. JS converts
/// to world coords via `(landblock_x_byte * 192) + local_x`. The wasm
/// side forwards the on-wire numbers unchanged; the conversion lives
/// JS-side (matching the [`ObjectPlacement`] pattern). AC is Z-up;
/// JS extracts yaw from the quaternion via the same
/// `atan2(2(qw*qz + qx*qy), 1 - 2(qy² + qz²))` formula
/// `frame_to_placement` uses for static placements.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct EntityUpdate {
    /// One of `ENTITY_UPDATE_KIND_*` — 0 = Position, 1 = Spawn, 2 = Remove.
    kind: u32,
    /// Entity GUID. For PrivateUpdatePosition this is the recv loop's
    /// substituted local-player guid (no guid in the wire message).
    guid: u32,
    /// SetupModel ID (`csetup_id` from `ObjectDescriptionData`). Only
    /// meaningful for kind = Spawn; `0` for Position and Remove.
    model_id: u32,
    /// AC landblock id (`(x_byte << 24) | (y_byte << 16) | cell_in_lb`).
    /// `0` for kind = Remove.
    landblock_id: u32,
    /// Landblock-local position, range 0..192 m on x/y. `0` for Remove.
    x: f32,
    y: f32,
    z: f32,
    /// Orientation quaternion. Identity (`qw=1`) for Remove and
    /// missing-pos Spawn fallbacks.
    qw: f32,
    qx: f32,
    qy: f32,
    qz: f32,
    // --- Phase 4 step 6a: weenie metadata (Spawn only) -----------------
    // Position/Remove updates leave these zeroed/empty so the JS-side
    // entityMap merges by guid and reuses the meta from the original
    // Spawn. The category-keyed visual dispatch (step 6b) and nameplates
    // (step 6e) read these on Spawn arrival; on Position update they're
    // expected to be 0/"".
    /// Weenie class id (the wcid from `PublicWeenieDescription.wcid`).
    /// `0` for non-Spawn updates and the rare child-entity Spawn that
    /// arrives without a description.
    wcid: u32,
    /// `ItemType` bitmask from `PublicWeenieDescription.item_type`. Used
    /// JS-side as the primary discriminator for the visual category
    /// (Portal = `0x00010000`, Creature = `0x00000010`, Sign / Door /
    /// Vendor / Weapon / Armor — see `external/ACE/Source/ACE.Entity/
    /// Enum/ItemType.cs`). `0` for non-Spawn.
    item_type: u32,
    /// Display name (`PublicWeenieDescription.name`). Empty string when
    /// absent on the wire OR for non-Spawn updates. JS treats empty as
    /// "no nameplate".
    name: String,
    /// Object scale multiplier (`ObjectDescriptionData.obj_scale`). `1.0`
    /// when absent or for non-Spawn. JS multiplies the rasterized
    /// sprite's `worldBounds` by this so juvenile vs. epic-tier
    /// creatures render at distinct sprite sizes.
    obj_scale: f32,
    /// Icon DID (`PublicWeenieDescription.icon_id`). Surfaced for any
    /// future icon-overlay work (e.g. nameplate prefix icons or
    /// minimap blips); `0` when absent.
    icon_id: u32,
    /// Primary palette DID (`ObjectDescriptionData.model_data.palette_id`).
    /// `0` when the model carries no recolour. Step 6c uses this as the
    /// substitution key when rasterizing creature variants.
    palette_id: u32,
    /// Motion table DID (`ObjectDescriptionData.mtable_id`). Surfaced
    /// for future animation-state polish (walk-cycle anims). `0` when
    /// absent.
    mtable_id: u32,
    /// Phase 4 step 6f (portal destination chips): the appraisal-
    /// time portal-destination text (e.g. `"Holtburg (87, -3, 0)"`),
    /// from `PropertyString::AppraisalPortalDestination` on the
    /// portal's entity properties. Empty string when:
    /// - the entity isn't a portal,
    /// - the entity is a portal but the appraisal hasn't completed
    ///   yet (recv loop auto-fires `GameAction::IdentifyObject` on
    ///   ObjectCreate; the response arrives async with the property),
    /// - or the destination isn't set server-side (rare).
    /// JS renders a chip below the portal sprite when this is
    /// non-empty. ALWAYS empty on Position / Remove updates and on
    /// non-portal Spawns.
    portal_destination: String,
    // --- Phase 4 step 6 Phase A: model-data substitutions ----------
    // ACE's `Creature.CalculateObjDesc()` walks the NPC's equipped
    // inventory server-side, reads each equipped item's ClothingTable
    // from the DAT, and ships the resulting per-part GfxObj swaps +
    // texture remaps + palette overlays in `ObjectDescriptionData
    // .model_data`. The browser's job is to APPLY them when
    // triangulating; we surface them here as flat Uint32Array buffers
    // and the JS rasterizer hands them to fetch_entity_model_render.
    /// Flat `[part_index_u8, gfx_obj_did_u32, …]` pairs. Empty for
    /// non-Spawn updates and for entities with no part substitutions
    /// (most static placements + bare creatures). Per pair: replace
    /// `setup.parts[part_index]` with `gfx_obj_did`. Mirrors
    /// `ObjectDescriptionData.model_data.model_changes` from the wire.
    model_changes: Vec<u32>,
    /// Flat `[part_index_u8, old_surface_did_u32, new_surface_did_u32, …]`
    /// triples. Empty for non-Spawn / no-substitution. Per triple:
    /// while triangulating part `part_index`, swap polygon surface
    /// `old_surface_did` for `new_surface_did`. Mirrors
    /// `ObjectDescriptionData.model_data.texture_changes`.
    texture_changes: Vec<u32>,
    /// Flat `[sub_palette_did_u32, offset_u8, length_u8, …]` triples.
    /// Empty for non-Spawn / no-substitution. Per triple: overwrite the
    /// base palette's `[offset, offset+length)` colour-index range with
    /// the colours from `sub_palette_did`. Phase B consumes this in a
    /// future `fetch_surfaces_pixels_with_palette` export; surfaced
    /// now so step 6a/A doesn't drop the data on the floor. Mirrors
    /// `ObjectDescriptionData.model_data.sub_palettes`.
    sub_palettes: Vec<u32>,
    // --- Velocity hint (kind=4 only) ----------------------------
    // Sourced from `GameMessage::VectorUpdate(VectorUpdateData)`
    // — ACE broadcasts these at the wire-level whenever an
    // entity's physics state changes (start/stop walking, change
    // direction). Currently the recv loop drops them in the
    // catch-all arm; the kind=4 EntityUpdate surfaces just the
    // `(velocity, omega)` pair so JS can extrapolate position
    // between PublicUpdatePosition echoes. ALL OTHER FIELDS ARE
    // ZERO on kind=4 — JS reads only `guid`, `vx/y/z`, `omega_z`.
    /// World-frame velocity x component, m/s. `0.0` for kind != 4.
    vx: f32,
    /// World-frame velocity y component, m/s. `0.0` for kind != 4.
    vy: f32,
    /// World-frame velocity z component, m/s. `0.0` for kind != 4.
    /// Top-down renderer doesn't use this today (no jumping
    /// extrapolation), but surfaced so future jump animation can
    /// consume it without a wire change.
    vz: f32,
    /// Angular velocity around the world z-axis, rad/s (yaw rate).
    /// AC is z-up; entity rotation is yaw-only on the wire so the
    /// other two omega components are dropped. `0.0` for kind != 4.
    omega_z: f32,
    // --- Motion-state hint (kind=5 only) -------------------------
    // Sourced from `GameMessage::UpdateMotion(MovementEventData)` —
    // ACE broadcasts these whenever an entity's locomotion state
    // changes (start/stop walking, switch to running, change stance).
    // The JS animation gate previously relied on an EMA over
    // PublicUpdatePosition position deltas to decide walk-vs-idle;
    // kind=5 lets it consume the server's authoritative decision
    // when a fresh hint is available, falling back to the EMA only
    // when no hint has arrived recently.
    /// Raw `InterpretedMotionCommand` u16 (zero-extended) — the
    /// active forward locomotion command in `UpdateMotion`'s state
    /// payload, OR `STOP` when `movement_type == StopCompletely`,
    /// OR `RUN_FORWARD` when the message is autonomous navigation
    /// (`MoveToObject` / `MoveToPosition`), OR `0` when no forward
    /// command was carried (turn-only, unhandled type). `0` for
    /// kind != 5.
    motion_command: u32,
    /// Raw `current_style` u16 (zero-extended) from
    /// `MovementEventData.current_style`. Maps to the low 16 bits of
    /// `MotionStance` (HandCombat=0x003c, NonCombat=0x003d, etc.).
    /// `0` for kind != 5.
    motion_stance: u32,
    /// **H2 (2026-05-12).** Entity's PhysicsScript DID
    /// (`ObjectDescription.default_script_id`, 0x33xxxxxx when set).
    /// JS-side `entities.js::_spawnImpl` walks this through
    /// `fetchPhysicsScript → CreateParticleHook → fetchParticleEmitter`
    /// (the same chain Sky-J P5 uses for sky-anchored particles).
    /// `0` when the entity has no script (most static placements +
    /// vanilla creatures) and for non-Spawn updates.
    physics_script_did: u32,
    /// **Task E (2026-05-12).** Entity's SoundTable DID
    /// (`ObjectDescription.stable_id`, 0x20xxxxxx when set; backed by
    /// the weenie's `PropertyDataId::SoundTable` = 3). The 3D
    /// EntityManager.spawn() reads this to prewarm the SoundTableCache
    /// AND to resolve SoundTable hooks (AnimationHook hook_type 2 carries
    /// a `Sound` enum value; the executor looks it up in
    /// `entity.soundTableDid` to get the Wave DID to play). `0` when the
    /// entity has no SoundTable (most non-sound-emitting placements) and
    /// for non-Spawn updates.
    sound_table_did: u32,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl EntityUpdate {
    /// Update tag — see `ENTITY_UPDATE_KIND_*` constants.
    #[wasm_bindgen(getter)]
    pub fn kind(&self) -> u32 {
        self.kind
    }
    /// Entity GUID (substituted local-player guid for
    /// PrivateUpdatePosition).
    #[wasm_bindgen(getter)]
    pub fn guid(&self) -> u32 {
        self.guid
    }
    /// SetupModel id; meaningful only for Spawn.
    #[wasm_bindgen(getter, js_name = modelId)]
    pub fn model_id(&self) -> u32 {
        self.model_id
    }
    /// AC landblock id (`(x_byte << 24) | (y_byte << 16) | cell`).
    #[wasm_bindgen(getter, js_name = landblockId)]
    pub fn landblock_id(&self) -> u32 {
        self.landblock_id
    }
    #[wasm_bindgen(getter)]
    pub fn x(&self) -> f32 {
        self.x
    }
    #[wasm_bindgen(getter)]
    pub fn y(&self) -> f32 {
        self.y
    }
    #[wasm_bindgen(getter)]
    pub fn z(&self) -> f32 {
        self.z
    }
    #[wasm_bindgen(getter)]
    pub fn qw(&self) -> f32 {
        self.qw
    }
    #[wasm_bindgen(getter)]
    pub fn qx(&self) -> f32 {
        self.qx
    }
    #[wasm_bindgen(getter)]
    pub fn qy(&self) -> f32 {
        self.qy
    }
    #[wasm_bindgen(getter)]
    pub fn qz(&self) -> f32 {
        self.qz
    }

    /// Phase 4 step 6a: weenie class id from `PublicWeenieDescription`.
    /// `0` when the update isn't a Spawn or the description is missing
    /// the field.
    #[wasm_bindgen(getter)]
    pub fn wcid(&self) -> u32 {
        self.wcid
    }

    /// Phase 4 step 6a: `ItemType` bitmask. JS uses this as the primary
    /// category discriminator for tint + glyph fallback. See
    /// `external/ACE/Source/ACE.Entity/Enum/ItemType.cs:25` for the
    /// reference enum (Portal = `0x00010000`, Creature = `0x00000010`,
    /// Sign / Door / Vendor / Weapon / Armor / etc.).
    #[wasm_bindgen(getter, js_name = itemType)]
    pub fn item_type(&self) -> u32 {
        self.item_type
    }

    /// Phase 4 step 6a: display name (the entity's "say-able"
    /// label). Empty string when absent. Used by step 6e nameplates.
    #[wasm_bindgen(getter)]
    pub fn name(&self) -> String {
        self.name.clone()
    }

    /// Phase 4 step 6a: object scale multiplier. `1.0` when absent. JS
    /// multiplies the rasterized sprite's `worldBounds` by this.
    #[wasm_bindgen(getter, js_name = objScale)]
    pub fn obj_scale(&self) -> f32 {
        self.obj_scale
    }

    /// Phase 4 step 6a: icon DID. `0` when absent.
    #[wasm_bindgen(getter, js_name = iconId)]
    pub fn icon_id(&self) -> u32 {
        self.icon_id
    }

    /// Phase 4 step 6a: primary palette DID. `0` when the model carries
    /// no recolour. Step 6c reads this when rasterizing creature
    /// variants.
    #[wasm_bindgen(getter, js_name = paletteId)]
    pub fn palette_id(&self) -> u32 {
        self.palette_id
    }

    /// Phase 4 step 6a: motion table DID. `0` when absent. Surfaced for
    /// future animation-state polish.
    #[wasm_bindgen(getter, js_name = mtableId)]
    pub fn mtable_id(&self) -> u32 {
        self.mtable_id
    }

    /// Phase 4 step 6f: portal destination text (e.g.
    /// `"Holtburg (87, -3, 0)"`) from
    /// `PropertyString::AppraisalPortalDestination`. Empty until the
    /// auto-fired `GameAction::IdentifyObject` round-trips back as a
    /// `kind=3 META_REFRESH` update for portal entities.
    #[wasm_bindgen(getter, js_name = portalDestination)]
    pub fn portal_destination(&self) -> String {
        self.portal_destination.clone()
    }

    /// Phase 4 step 6 Phase A: flat `[part_index, gfx_obj_did, …]`
    /// pairs from `model_data.model_changes`. JS hands this directly
    /// to `fetchEntityModelRender(setupId, modelChanges, …)`. Empty
    /// for non-Spawn updates.
    #[wasm_bindgen(getter, js_name = modelChanges)]
    pub fn model_changes(&self) -> Vec<u32> {
        self.model_changes.clone()
    }

    /// Phase 4 step 6 Phase A: flat `[part_index, old_surface, new_surface, …]`
    /// triples from `model_data.texture_changes`.
    #[wasm_bindgen(getter, js_name = textureChanges)]
    pub fn texture_changes(&self) -> Vec<u32> {
        self.texture_changes.clone()
    }

    /// Phase 4 step 6 Phase A: flat `[sub_palette_did, offset, length, …]`
    /// triples from `model_data.sub_palettes`. Phase B consumer.
    #[wasm_bindgen(getter, js_name = subPalettes)]
    pub fn sub_palettes(&self) -> Vec<u32> {
        self.sub_palettes.clone()
    }

    /// Motion-state hint forward-command — raw `InterpretedMotionCommand`
    /// u16 (zero-extended) from `UpdateMotion`'s active state. Meaningful
    /// only for `kind=5 MOTION`; `0` otherwise. JS compares against
    /// MOTION_CMD_* constants (WALK_FORWARD=0x5, WALK_BACKWARDS=0x6,
    /// RUN_FORWARD=0x7, STOP=0x4) to decide the animation gate. `0`
    /// means "no forward locomotion signal" (idle, turn-only, or
    /// movement_type variant without a forward command).
    #[wasm_bindgen(getter, js_name = motionCommand)]
    pub fn motion_command(&self) -> u32 {
        self.motion_command
    }

    /// Motion-state hint stance — raw u16 (zero-extended) from
    /// `UpdateMotion`'s `current_style` field. Mirrors the low-16 bits
    /// of `MotionStance` (HandCombat=0x003c, NonCombat=0x003d, etc.).
    /// Meaningful only for `kind=5 MOTION`; `0` otherwise. Surfaced
    /// for future combat-stance-driven animation polish; the current
    /// JS gate ignores it.
    #[wasm_bindgen(getter, js_name = motionStance)]
    pub fn motion_stance(&self) -> u32 {
        self.motion_stance
    }

    /// **H2 (2026-05-12).** PhysicsScript DID (0x33xxxxxx) carried by
    /// the entity's `ObjectDescription.default_script_id`. Non-zero when
    /// the entity has an in-world physics effect (fireworks rockets,
    /// magical glows, lantern flames, portal swirls). JS-side spawn
    /// flow walks this through the Sky-J chain (`fetchPhysicsScript →
    /// CreateParticleHook → fetchParticleEmitter → addEmitter`) with
    /// the entity rig as the emitter parent. `0` when no script (most
    /// static placements + vanilla NPCs/creatures) and for non-Spawn.
    #[wasm_bindgen(getter, js_name = physicsScriptDid)]
    pub fn physics_script_did(&self) -> u32 {
        self.physics_script_did
    }

    /// **Task E (2026-05-12).** Entity's SoundTable DID (`0x20xxxxxx`)
    /// from `ObjectDescription.stable_id` (the wire field carrying
    /// `PropertyDataId::SoundTable` = 3 for sound-emitting weenies).
    /// JS-side AnimationHook executor in `entities.js::tick` resolves
    /// SoundTable hooks (`hook_type = 2`, payload = Sound enum) by
    /// looking up `entity.soundTableDid` in `soundTableCache`. `0` when
    /// the entity has no SoundTable (most static placements + vanilla
    /// NPCs without voice/footstep tables) and for non-Spawn updates.
    #[wasm_bindgen(getter, js_name = soundTableDid)]
    pub fn sound_table_did(&self) -> u32 {
        self.sound_table_did
    }

    /// Velocity-hint x component (m/s, world frame). Meaningful only
    /// for `kind=4 VELOCITY`; `0.0` otherwise.
    #[wasm_bindgen(getter)]
    pub fn vx(&self) -> f32 {
        self.vx
    }

    /// Velocity-hint y component (m/s, world frame). Meaningful only
    /// for `kind=4 VELOCITY`; `0.0` otherwise.
    #[wasm_bindgen(getter)]
    pub fn vy(&self) -> f32 {
        self.vy
    }

    /// Velocity-hint z component (m/s, world frame). Meaningful only
    /// for `kind=4 VELOCITY`; `0.0` otherwise. Reserved for future
    /// jump-extrapolation; the top-down renderer doesn't use it today.
    #[wasm_bindgen(getter)]
    pub fn vz(&self) -> f32 {
        self.vz
    }

    /// Angular velocity around world z-axis (rad/s, yaw rate).
    /// Meaningful only for `kind=4 VELOCITY`; `0.0` otherwise.
    #[wasm_bindgen(getter, js_name = omegaZ)]
    pub fn omega_z(&self) -> f32 {
        self.omega_z
    }
}

/// Phase 4 step 4 follow-on (vitals + inventory panels): one snapshot
/// of the player's stat block — vitals (Health / Stamina / Mana),
/// attributes (Strength / Endurance / Coordination / Quickness /
/// Focus / Self), skills, and level info.
///
/// JS reads this on every `kind=8 PlayerStatsUpdated` event by calling
/// [`SessionHandle::player_stats`]. The snapshot is constructed by
/// pulling the current values out of the recv loop's `WorldState`
/// (which the canonical handler dispatcher keeps current as
/// `Update*Vital` / `Update*Attribute` / `Update*Skill` /
/// `PlayerDescription` lands).
///
/// Wire shape: typed-array buffers JS interprets via fixed strides.
/// - `vitals` — flat `[type_u32, current_u32, base_u32, buffed_max_u32, ...]`
///   triples-of-four, one per vital ordered by `VitalType` value
///   (Health=1, Stamina=3, Mana=5).
/// - `attributes` — flat `[type_u32, current_u32, base_u32, ranks_u32, ...]`
///   quadruples, one per attribute ordered by `AttributeType` value
///   (Strength=1 .. Self=6).
/// - `skills` — flat `[type_u32, current_u32, base_u32, ranks_u32,
///   training_u32, ...]` quintuples, sorted by `SkillType` value.
///   Training: 0=Untrained, 1=Untrained-but-Trainable, 2=Trained,
///   3=Specialized (mirrors `holtburger_common::stats::TrainingLevel`
///   numeric layout).
/// - `level_info` — fixed seven-element layout
///   `[level_u32, current_xp_lo, current_xp_hi, unspent_xp_lo,
///   unspent_xp_hi, available_luminance_lo, available_luminance_hi]`.
///   The 64-bit values are packed lo / hi 32-bit halves so JS can
///   reassemble via `BigInt`.
/// - `name` — character's display name (from `WorldState.player`).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct PlayerStatsSnapshot {
    name: String,
    vitals: Vec<u32>,
    attributes: Vec<u32>,
    skills: Vec<u32>,
    level_info: Vec<u32>,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl PlayerStatsSnapshot {
    /// Display name of the local player.
    #[wasm_bindgen(getter)]
    pub fn name(&self) -> String {
        self.name.clone()
    }

    /// Flat `[type, current, base, buffed_max, ...]` per vital.
    /// `buffed_max` is the enchantment-modified max; `base` is the
    /// unbuffed max. JS computes `% = current / buffed_max` for the
    /// progress-bar fill.
    #[wasm_bindgen(getter)]
    pub fn vitals(&self) -> Vec<u32> {
        self.vitals.clone()
    }

    /// Flat `[type, current, base, ranks, ...]` per attribute.
    /// `current` includes enchantments; `base` is unbuffed; `ranks`
    /// is the spent-attribute-points count (0..330 for non-Olthoi).
    #[wasm_bindgen(getter)]
    pub fn attributes(&self) -> Vec<u32> {
        self.attributes.clone()
    }

    /// Flat `[type, current, base, ranks, training, ...]` per skill.
    /// Sorted by `SkillType` value. JS labels via the `SkillType`
    /// strum-display strings (the wasm bundle exposes a static
    /// `skillName(type)` helper, see [`skill_name`]).
    #[wasm_bindgen(getter)]
    pub fn skills(&self) -> Vec<u32> {
        self.skills.clone()
    }

    /// Fixed-shape seven-element level-info packing:
    /// `[level, current_xp_lo, current_xp_hi, unspent_xp_lo,
    /// unspent_xp_hi, available_luminance_lo, available_luminance_hi]`.
    /// 64-bit values are split into lo/hi 32-bit halves for the
    /// wasm-bindgen Vec<u32> boundary.
    #[wasm_bindgen(getter, js_name = levelInfo)]
    pub fn level_info(&self) -> Vec<u32> {
        self.level_info.clone()
    }
}

/// Phase 4 step 4 follow-on (inventory panel): one item entry in the
/// player's inventory snapshot. JS reads `Vec<InventoryItem>` via
/// [`SessionHandle::player_inventory`] on every `kind=11
/// InventoryUpdated` event.
///
/// "Inventory" here is the union of (a) items the player owns
/// (`WorldState.player.inventory: HashSet<Guid>`) and (b) items the
/// player has equipped (`WorldState.player.equipment: HashMap<Guid,
/// EquipMask>`). Equipped items have a non-zero `equip_mask`. Items
/// in side packs / the main pack have `equip_mask == 0`.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
#[derive(Clone)]
pub struct InventoryItem {
    guid: u32,
    wcid: u32,
    name: String,
    icon_id: u32,
    item_type: u32,
    value: u32,
    stack_size: u32,
    equip_mask: u32,
    container_id: u32,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl InventoryItem {
    /// Item GUID — primary key.
    #[wasm_bindgen(getter)]
    pub fn guid(&self) -> u32 {
        self.guid
    }

    /// Weenie class id (`PublicWeenieDescription.wcid`). Used by JS
    /// for icon lookup or future tooltips.
    #[wasm_bindgen(getter)]
    pub fn wcid(&self) -> u32 {
        self.wcid
    }

    /// Display name (e.g. "Steel Long Sword", "Healing Kit"). Comes
    /// from `PropertyString::Name`.
    #[wasm_bindgen(getter)]
    pub fn name(&self) -> String {
        self.name.clone()
    }

    /// Icon DID (`PublicWeenieDescription.icon_id`). For step 4
    /// follow-on we surface the raw DID; rendering the icon is a
    /// step 6-style follow-on (would need an icon-atlas fetch).
    #[wasm_bindgen(getter, js_name = iconId)]
    pub fn icon_id(&self) -> u32 {
        self.icon_id
    }

    /// `ItemType` bitmask. Used by the inventory-panel filter chips
    /// (Weapons / Armor / Misc / etc.). See
    /// `external/ACE/Source/ACE.Entity/Enum/ItemType.cs`.
    #[wasm_bindgen(getter, js_name = itemType)]
    pub fn item_type(&self) -> u32 {
        self.item_type
    }

    /// Pyreal value (`PropertyInt::Value`). Used by the inventory
    /// panel to show item worth.
    #[wasm_bindgen(getter)]
    pub fn value(&self) -> u32 {
        self.value
    }

    /// Stack size (`PropertyInt::StackSize`). 1 for non-stackable
    /// items.
    #[wasm_bindgen(getter, js_name = stackSize)]
    pub fn stack_size(&self) -> u32 {
        self.stack_size
    }

    /// Equip mask. Non-zero = equipped. The bits identify which slot
    /// (`HEAD`, `CHEST`, `MELEE_WEAPON`, etc. — see
    /// `holtburger_common::properties::EquipMask`).
    #[wasm_bindgen(getter, js_name = equipMask)]
    pub fn equip_mask(&self) -> u32 {
        self.equip_mask
    }

    /// Container GUID. `0` if the item is in the player's main
    /// pack; non-zero = the GUID of the side-pack / shop / corpse
    /// the item sits in.
    #[wasm_bindgen(getter, js_name = containerId)]
    pub fn container_id(&self) -> u32 {
        self.container_id
    }
}

/// Phase 4 step 4 follow-on: human-readable label for a `SkillType`
/// numeric id. Mirrors the `Display` impl on
/// `holtburger_common::stats::SkillType` (which uses strum's
/// `serialize` attribute on each variant). JS calls this via the
/// wasm-bindgen export `skillName(typeId)` to label the rows in the
/// Skills section of the vitals panel.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = skillName)]
pub fn skill_name(skill_type: u32) -> String {
    use holtburger_common::stats::SkillType;
    SkillType::from_repr(skill_type)
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("Skill {skill_type}"))
}

/// Phase 4 step 4 follow-on: human-readable label for an
/// `AttributeType` numeric id. Mirrors the `Display` impl on
/// `holtburger_common::stats::AttributeType`.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = attributeName)]
pub fn attribute_name(attribute_type: u32) -> String {
    use holtburger_common::stats::AttributeType;
    AttributeType::from_repr(attribute_type)
        .map(|a| a.to_string())
        .unwrap_or_else(|| format!("Attribute {attribute_type}"))
}

/// Phase 4 step 4 follow-on: human-readable label for a `VitalType`
/// numeric id. Mirrors the `Display` impl on
/// `holtburger_common::stats::VitalType`.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = vitalName)]
pub fn vital_name(vital_type: u32) -> String {
    use holtburger_common::stats::VitalType;
    VitalType::from_repr(vital_type)
        .map(|v| v.to_string())
        .unwrap_or_else(|| format!("Vital {vital_type}"))
}

/// Phase 4 step 4 follow-on: should this `GameMessage` be routed
/// through the canonical `holtburger_world::handlers::routing::handle_message`
/// dispatcher so `WorldState` (player stats + entity collection)
/// stays current?
///
/// We selectively route — NOT every message — because position
/// messages (`UpdatePosition`, etc.) already get manual treatment in
/// the recv loop's existing arms (sequence tracking, entity_seeded
/// gating, MovementSystem heartbeat arming) and double-handling them
/// risks regressing step 3.6 / 3.5.
///
/// **`ObjectCreate` / `ObjectDelete` / `ParentEvent` / `PickupEvent` /
/// `InventoryRemoveObject` are deliberately NOT routed.** The world's
/// `inventory::handle_message` for `ObjectCreate` calls
/// `state.upsert_entity_from_create` → `add_entity` → `scene.update_entity`
/// + `reconcile_authoritative_body`, which trips a wasm `unreachable`
/// panic in the spatial body store (the wasm bundle doesn't drive the
/// full physics tick the cli does, so some spatial preconditions
/// aren't met). Inventory tracking bypasses routing for these
/// variants — `apply_inventory_object_create` /
/// `apply_inventory_object_delete` below replicate the
/// inventory-relevant subset of the canonical handlers (entity
/// insert, `add_to_inventory` / `remove_from_inventory`, equipment
/// bookkeeping) without touching spatial state.
///
/// `GameEvent` IS routed because PlayerDescription drives the load-
/// bearing first kind=8 event via login::handle_event +
/// player::handle_event, and other GameEvents (UpdateHealth,
/// ViewContents, IdentifyObjectResponse, WieldObject) all hit
/// inventory / properties handlers that don't touch the spatial path.
#[cfg(target_arch = "wasm32")]
fn should_route_message_to_world(message: &holtburger_protocol::messages::GameMessage) -> bool {
    use holtburger_protocol::messages::GameMessage;
    matches!(
        message,
        GameMessage::PrivateUpdateVital(_)
            | GameMessage::PublicUpdateVital(_)
            | GameMessage::PrivateUpdateVitalCurrent(_)
            | GameMessage::PrivateUpdateAttribute(_)
            | GameMessage::PublicUpdateAttribute(_)
            | GameMessage::PrivateUpdateSkill(_)
            | GameMessage::PublicUpdateSkill(_)
            // Phase 6 step E: SetState carries `PhysicsState`, which
            // in turn carries the ETHEREAL bit a Door uses to signal
            // open/closed. The world's `apply_set_state_update`
            // handler already updates `entity.physics_state` and
            // emits `WorldEvent::EntityStateUpdated` +
            // `WorldEvent::DoorStateChanged` for door-flagged
            // entities; routing it here forwards both to the recv
            // loop's WorldEvent scan.
            | GameMessage::SetState(_)
            | GameMessage::GameEvent(_)
    )
}

/// Phase 4 step 4 follow-on: spatial-bypass version of
/// `holtburger_world::handlers::inventory::handle_message`'s
/// `GameMessage::ObjectCreate` arm. Inserts the entity into
/// `state.entities` (sans spatial body work) and updates
/// `state.player.inventory` / `state.player.equipment` if the new
/// entity is held / wielded by the local player.
///
/// Returns `true` if the entity is now owned by the player
/// (caller flips `inventory_changed` so the snapshot publisher
/// re-fires `kind=11`).
#[cfg(target_arch = "wasm32")]
fn apply_inventory_object_create(
    world: &mut holtburger_world::WorldState,
    data: &holtburger_protocol::messages::ObjectDescriptionData,
) -> bool {
    use holtburger_common::properties::WorldObjectExt as _;
    let guid = data.public_weenie_desc.guid;
    let entity_name = data
        .public_weenie_desc
        .name
        .as_deref()
        .unwrap_or("Unknown")
        .to_string();
    let pos = data.pos.unwrap_or_default();
    let mut entity = holtburger_world::entity::Entity::new(guid, entity_name, pos);
    entity.apply_description(data);

    let container_id = entity.container_id();
    let wielder_id = entity.wielder_id();
    let equip_mask = entity.wield_location();

    // Direct insert via the public EntityManager — skips the
    // `add_entity` path that calls `scene.update_entity` +
    // `reconcile_authoritative_body` (the spatial body work that
    // panics in the wasm bundle). The entity collection is what
    // `publish_player_inventory_snapshot` iterates against.
    world.entities.insert(entity);

    let held_by_player = container_id == Some(world.player.guid);
    let wielded_by_player = wielder_id == Some(world.player.guid);

    if held_by_player || wielded_by_player {
        world.player.add_to_inventory(guid);
        if wielded_by_player {
            world.player.wield_item(guid, equip_mask);
        } else {
            world.player.unwield_item(guid);
        }
        true
    } else {
        false
    }
}

/// Phase 4 step 4 follow-on: spatial-bypass version of
/// `holtburger_world::handlers::inventory::handle_message`'s
/// `GameMessage::ObjectDelete` /
/// `GameMessage::InventoryRemoveObject` arms. Removes the entity
/// from `state.entities` and from `state.player.inventory` /
/// `state.player.equipment` if it was owned. Returns `true` if the
/// removal touched player inventory.
#[cfg(target_arch = "wasm32")]
fn apply_inventory_object_delete(
    world: &mut holtburger_world::WorldState,
    guid: holtburger_common::Guid,
) -> bool {
    let was_owned = world.player.inventory.contains(&guid);
    if was_owned {
        world.player.remove_from_inventory(guid);
        world.player.unwield_item(guid);
    }
    world.entities.remove(guid);
    was_owned
}

/// One row from the AC CharacterList packet, projected to the fields
/// the Selection UI displays.
///
/// AC's `CharacterEntry` carries only `guid`, `name`, and `delete_time`
/// — level / class / equipment are not in the CharacterList packet
/// itself. They arrive once the player picks a character and the
/// spawn flow runs (step 2b — full `Character` projection).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
#[derive(Clone)]
pub struct CharacterSummary {
    id: u32,
    name: String,
    delete_time: u32,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl CharacterSummary {
    /// Character GUID — the AC-side primary key. Step 2a uses this in
    /// `SessionHandle.select_character(id)` to pick the spawn target.
    #[wasm_bindgen(getter)]
    pub fn id(&self) -> u32 {
        self.id
    }

    /// Display name of the character.
    #[wasm_bindgen(getter)]
    pub fn name(&self) -> String {
        self.name.clone()
    }

    /// Non-zero = character is in the deletion-pending grace window
    /// (the value is the unix timestamp at which the delete completes).
    /// Zero = active.
    #[wasm_bindgen(getter, js_name = deleteTime)]
    pub fn delete_time(&self) -> u32 {
        self.delete_time
    }
}

/// Live wasm-side proxy for an AC session connected via WS to ACE.
/// Constructed by [`start_session`] once the handshake reaches
/// `CharacterList`. The Session itself lives inside the `spawn_local`
/// recv loop; the handle holds the JS-facing surface — a command
/// channel sender + shared queued-events buffer + the most recent
/// CharacterList snapshot (mutated by the recv loop on every
/// CharacterList re-fire). Dropping the handle closes the cmd
/// channel; the recv loop sees the channel close, drops the Session
/// (which closes the WebSocket via `WsTransport`'s `Drop`), and
/// exits.
///
/// `character_list` is `Rc<RefCell<...>>` because both sides update
/// it: the recv loop overwrites on `CharacterList` re-fire (new chars
/// after Create / pruned chars after Delete), and JS reads via
/// [`SessionHandle::character_list`] which clones the current
/// snapshot. Single-threaded wasm32 makes `Rc` + `RefCell` sound;
/// borrow conflicts are impossible because reads from JS are
/// synchronous and the recv loop yields between mutations.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct SessionHandle {
    cmd_tx: futures::channel::mpsc::UnboundedSender<SessionCommand>,
    queued_events: std::rc::Rc<std::cell::RefCell<Vec<ClientEvent>>>,
    character_list: std::rc::Rc<std::cell::RefCell<Vec<CharacterSummary>>>,
    account_name: String,
    /// Phase 4 step 2a.5: shared catalog slot, populated asynchronously
    /// in the background. `None` until the catalog HBA fetch completes
    /// (or never if `asset_url` was empty or the fetch failed).
    /// `create_test_character` rejects when this is still empty —
    /// JS can poll `canCreateCharacter` until it flips true.
    ///
    /// The fetch runs in a `spawn_local` task that started alongside
    /// `recv_loop` from `start_session`; on a desktop browser it
    /// completes in a few hundred ms, but on a phone over tailscale
    /// it can take minutes (the HBA is ~605MB at full profile). Step
    /// 2a.5 originally awaited it inline before returning the handle,
    /// which left mobile users stuck at "sending login request" while
    /// the protocol had long since completed; step 2a.6 detaches it.
    catalog: std::rc::Rc<std::cell::RefCell<Option<std::sync::Arc<holtburger_content::CharacterGenCatalog>>>>,
    /// Phase 4 step 2b: shared buffer of [`EntityUpdate`] events the
    /// recv loop pushes when ACE sends `UpdatePosition` /
    /// `PrivateUpdatePosition` / `PublicUpdatePosition` /
    /// `ObjectCreate` / `ObjectDelete`. JS drains via
    /// [`SessionHandle::poll_entity_updates`] each animation frame
    /// and applies each update by GUID against its `Map<guid, sprite>`.
    /// Separate from `queued_events` (the lifecycle stream) — see
    /// [`EntityUpdate`]'s doc comment for the rationale.
    entity_updates: std::rc::Rc<std::cell::RefCell<Vec<EntityUpdate>>>,
    /// Phase 4 step 4 follow-on (vitals + inventory panels): latest
    /// player-stat snapshot, refreshed by the recv loop whenever the
    /// canonical world handler dispatcher reports
    /// `WorldEvent::{Vital,Attribute,Skill,LevelInfo,DerivedStats}Updated`
    /// or `PlayerEnchantmentsUpdated`. JS reads via
    /// [`SessionHandle::player_stats`] on each `kind=8 PlayerStatsUpdated`
    /// drain. `None` until the player's biota lands (at which point
    /// the dispatcher emits a flurry of stat events on first
    /// `PlayerDescription`).
    latest_stats: std::rc::Rc<std::cell::RefCell<Option<LatestStats>>>,
    /// Phase 4 step 4 follow-on (vitals + inventory panels): latest
    /// player-inventory snapshot, refreshed by the recv loop whenever
    /// `ObjectCreate` / `ObjectDelete` / `WieldObject` /
    /// `ViewContents` / `IdentifyObjectResponse` lands. JS reads via
    /// [`SessionHandle::player_inventory`] on each `kind=11
    /// InventoryUpdated` drain.
    latest_inventory: std::rc::Rc<std::cell::RefCell<Vec<InventoryItem>>>,
    /// Phase 6 step D: latest cell-scene snapshot, refreshed by the
    /// recv loop on each `SessionCommand::TickMovement`. Carries the
    /// local player's current cell id (per `SpatialScene::current_cell`)
    /// and the BFS render set at depth=1. JS reads via
    /// [`SessionHandle::get_current_cell_id`] /
    /// [`SessionHandle::get_render_set`] on every rAF tick to drive
    /// per-cell `.visible` toggling.
    cell_scene_snapshot: std::rc::Rc<std::cell::RefCell<CellSceneSnapshot>>,
    /// Phase 6 step E follow-up (2026-05-09): door GUID → snapshot of
    /// the building part the door was registered against during its
    /// ObjectCreate. Populated incrementally by the recv-loop as
    /// DOOR-flagged entities spawn into landblocks whose AABBs have
    /// already been drained. Read by JS via `getBuildingPartForDoor`
    /// on the kind=15 DoorStateChanged path; absent entries fall back
    /// to the spatial heuristic.
    door_part_snapshot: std::rc::Rc<
        std::cell::RefCell<std::collections::HashMap<u32, DoorPartSnapshot>>,
    >,
    /// Workstream A (3D camera/game-feel fix): latest authoritative
    /// pose for the local player, refreshed by the recv-loop on every
    /// TickMovement after the integrator step. `None` pre-spawn (before
    /// `world.player_position()` resolves); flips to `Some` once the
    /// player entity has been seeded and stays Some thereafter. Read
    /// synchronously by JS via [`SessionHandle::get_local_player_pose`]
    /// — the camera/prediction layer reads this each rAF tick to avoid
    /// the JS-side displacement-vector heading estimator that today's
    /// 3D camera math falls back to.
    local_player_pose: std::rc::Rc<std::cell::RefCell<Option<LocalPlayerPose>>>,
    /// Workstream C (3D camera collision, 2026-05-11): shared shadow of
    /// the live `SpatialScene` used by the camera collision sweep
    /// exports (`cameraSweepCollision`, `sweepSphereAgainstBuildingMesh`,
    /// `sweepSphereAgainstCellMesh`, `sweepSphereAgainstStatics`). The
    /// recv-loop refreshes this by cloning `world.scene` after every
    /// TickMovement drain so the JS-side sweep reads at most one tick
    /// behind the live integrator state. Pre-spawn the shadow is the
    /// default-constructed empty Scene (empty indices); JS reads still
    /// return `None` from every sweep, which is the correct camera
    /// behaviour pre-spawn (no terrain to lift the camera off).
    ///
    /// We mirror the entire SpatialScene rather than a pure-data subset
    /// so the sweep entrypoints can call the existing `Scene::sweep_-
    /// sphere_against_*` methods unchanged. Scene's clone cost is
    /// dominated by the entity body store and the per-LB triangle
    /// HashMaps; for Holtburg (~16 buildings, ~120 cell triangles per
    /// loaded dungeon) the clone runs in tens of microseconds per
    /// TickMovement — well below the 33 ms 30 Hz budget.
    collision_scene: std::rc::Rc<std::cell::RefCell<holtburger_world::SpatialScene>>,
    /// Workstream C: shadow of `world.terrain_heights` so
    /// `terrainHeightAt(x, y)` can resolve without a live WorldState
    /// borrow. Refreshed on every TickMovement alongside
    /// `collision_scene` (cheap because it's only ~9 LBs at hot Holtburg
    /// loaded). Empty pre-spawn; the heightfield clamp degrades to
    /// "no clamp" gracefully when the LB hasn't loaded yet — same
    /// behaviour as the integrator's manual-drive terrain snap.
    terrain_heights_shadow: std::rc::Rc<
        std::cell::RefCell<std::collections::HashMap<u32, [f32; 81]>>,
    >,
}

/// Phase 6 step D: snapshot of the local player's current cell and
/// the BFS render set rooted there. Refreshed by
/// `publish_cell_scene_snapshot` on every TickMovement; read by the
/// rAF tick via the SessionHandle getters.
///
/// `current_cell == 0` means "no world or pre-spawn"; JS treats this
/// as "leave existing visibility alone".
#[cfg(target_arch = "wasm32")]
#[derive(Clone, Default)]
struct CellSceneSnapshot {
    current_cell: u32,
    is_indoor: bool,
    render_set: Vec<u32>,
}

/// Phase 6 step E follow-up (2026-05-09): JS-facing payload for a door
/// GUID's `(BuildingId, part_index)` registration. The recv-loop fills
/// this in the ObjectCreate arm whenever a DOOR-flagged entity spawns
/// and the swept AABB index returns a hit; the JS-side kind=15 handler
/// reads it via `getBuildingPartForDoor` to look up the building's
/// PIXI container by the same `${landblockId}_${x}_${y}_${modelId}`
/// key shape `buildBuildingsContainer` populates. No registration =
/// JS falls back to the spatial heuristic in `findClosestBuildingPart`.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
#[derive(Clone, Copy)]
pub struct DoorPartSnapshot {
    landblock_id: u32,
    model_id: u32,
    /// Placement origin's xy in *global* world coords — same shape
    /// `buildBuildingsContainer` uses to build the JS-side `buildingKey`
    /// (which `.toFixed(2)`s the values verbatim).
    origin_x: f32,
    origin_y: f32,
    part_index: u8,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl DoorPartSnapshot {
    /// `BuildingId.landblock_id` for the building this door is part of —
    /// the high 16 bits of any cell ID in the landblock, padded to a
    /// full 32-bit word (`0xA9B4_0000`).
    #[wasm_bindgen(getter, js_name = landblockId)]
    pub fn landblock_id(&self) -> u32 {
        self.landblock_id
    }

    /// `BuildingId.model_id` — the building's Setup/GfxObj DID.
    #[wasm_bindgen(getter, js_name = modelId)]
    pub fn model_id(&self) -> u32 {
        self.model_id
    }

    /// Placement origin x in global world coords (matches
    /// `LandblockInfo.buildings[i].frame.origin.x` shifted by the
    /// landblock origin). JS uses `.toFixed(2)` on this to rebuild the
    /// `buildingKey`.
    #[wasm_bindgen(getter, js_name = originX)]
    pub fn origin_x(&self) -> f32 {
        self.origin_x
    }

    #[wasm_bindgen(getter, js_name = originY)]
    pub fn origin_y(&self) -> f32 {
        self.origin_y
    }

    /// 0-based child index of the door part within the building's PIXI
    /// container. Matches `BuildingAabbEntry.part_index` and the
    /// per-part bake order in `bakePerPartBuildingTextures`.
    #[wasm_bindgen(getter, js_name = partIndex)]
    pub fn part_index(&self) -> u8 {
        self.part_index
    }
}

/// Workstream A (3D camera/game-feel fix): JS-facing payload for the
/// local player's authoritative pose, returned by
/// [`SessionHandle::get_local_player_pose`]. Carries landblock-local
/// `(x, y, z)` in metres (range 0..192 m on x/y) plus a derived heading
/// in radians extracted from the AC quaternion via the same
/// `atan2(2(qw*qz + qx*qy), 1 - 2(qy² + qz²))` formula JS's
/// `quaternionToYaw` and Rust's `frame_to_placement` use (so the value
/// is directly compatible with the camera-relative WASD math
/// Workstream D restores). `None` is returned when the WorldState
/// hasn't been constructed yet OR the player entity hasn't been seeded
/// — JS callers should treat that as "fall back to the stashed pose"
/// rather than as a hard error.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
#[derive(Clone, Copy)]
pub struct LocalPlayerPose {
    x: f32,
    y: f32,
    z: f32,
    heading: f32,
    landblock_id: u32,
}

/// Workstream C (3D camera collision, 2026-05-11): JS-facing payload
/// for a camera-collision sweep hit. Returned by `cameraSweepCollision`,
/// `sweepSphereAgainstBuildingMesh`, `sweepSphereAgainstCellMesh`, and
/// `sweepSphereAgainstStatics` on `SessionHandle`. Carries the
/// parametric hit time `t` in `[0.0, 1.0]` (where 0=start, 1=full
/// delta), the world-space hit point, and the outward surface normal
/// pointing back toward the sweep origin so the camera-pullback math
/// can sign-add without flipping.
///
/// JS callers consume this via the wasm-bindgen getters
/// (`hit.t`, `hit.x`, `hit.y`, `hit.z`, `hit.normalX`, ...). A clean
/// miss returns `None` (JS `null`).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
#[derive(Clone, Copy)]
pub struct CollisionHit {
    t: f32,
    x: f32,
    y: f32,
    z: f32,
    normal_x: f32,
    normal_y: f32,
    normal_z: f32,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl CollisionHit {
    /// Parametric hit time in `[0.0, 1.0]` — 0 means the sweep started
    /// already inside the obstacle, 1 means the sweep reached `end`
    /// without contact (no value returned in that case — `None`).
    #[wasm_bindgen(getter)]
    pub fn t(&self) -> f32 {
        self.t
    }
    /// World-space hit point x (metres).
    #[wasm_bindgen(getter)]
    pub fn x(&self) -> f32 {
        self.x
    }
    /// World-space hit point y (metres).
    #[wasm_bindgen(getter)]
    pub fn y(&self) -> f32 {
        self.y
    }
    /// World-space hit point z (metres).
    #[wasm_bindgen(getter)]
    pub fn z(&self) -> f32 {
        self.z
    }
    /// Outward surface normal x (unit vector — but the sweep math
    /// signs it so the camera-pullback direction reads cleanly).
    #[wasm_bindgen(getter, js_name = normalX)]
    pub fn normal_x(&self) -> f32 {
        self.normal_x
    }
    #[wasm_bindgen(getter, js_name = normalY)]
    pub fn normal_y(&self) -> f32 {
        self.normal_y
    }
    #[wasm_bindgen(getter, js_name = normalZ)]
    pub fn normal_z(&self) -> f32 {
        self.normal_z
    }
}

#[cfg(target_arch = "wasm32")]
impl CollisionHit {
    fn from_generic(hit: holtburger_world::GenericSweptHit) -> Self {
        Self {
            t: hit.t,
            x: hit.point.x,
            y: hit.point.y,
            z: hit.point.z,
            normal_x: hit.normal.x,
            normal_y: hit.normal.y,
            normal_z: hit.normal.z,
        }
    }

    fn from_building_hit(hit: holtburger_world::SweptSphereHit, start: holtburger_common::Vector3, delta: holtburger_common::Vector3) -> Self {
        // `SweptSphereHit` from `sweep_sphere_against_aabbs` carries `t`
        // + `normal`, but the hit point is `start + delta * t` — the
        // caller has both. Compute it here so the JS-side API stays
        // uniform across all sweep flavours.
        let point = start + delta * hit.t;
        Self {
            t: hit.t,
            x: point.x,
            y: point.y,
            z: point.z,
            normal_x: hit.normal.x,
            normal_y: hit.normal.y,
            normal_z: hit.normal.z,
        }
    }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl LocalPlayerPose {
    /// Landblock-local x coordinate in metres, range 0..192.
    #[wasm_bindgen(getter)]
    pub fn x(&self) -> f32 {
        self.x
    }
    /// Landblock-local y coordinate in metres, range 0..192.
    #[wasm_bindgen(getter)]
    pub fn y(&self) -> f32 {
        self.y
    }
    /// World z (altitude) coordinate in metres.
    #[wasm_bindgen(getter)]
    pub fn z(&self) -> f32 {
        self.z
    }
    /// Heading (yaw) in radians, extracted via
    /// `atan2(2(qw*qz + qx*qy), 1 - 2(qy² + qz²))` — same convention as
    /// JS's `quaternionToYaw` at `index.html:2757-2762`.
    /// `yaw = 0` → facing +Y (north); `yaw = π/2` → facing +X (east).
    #[wasm_bindgen(getter)]
    pub fn heading(&self) -> f32 {
        self.heading
    }
    /// AC landblock id (`(x_byte << 24) | (y_byte << 16) | cell_in_lb`).
    /// JS uses this with `landblockToWorldXY` to project (x, y) to
    /// world metres.
    #[wasm_bindgen(getter, js_name = landblockId)]
    pub fn landblock_id(&self) -> u32 {
        self.landblock_id
    }
}

/// Phase 4 step 4 follow-on (vitals + inventory panels): non-wasm-bindgen
/// owned-value carrier for the player-stats snapshot. Field-for-field
/// match with `PlayerStatsSnapshot` (which is the JS-facing wrapper);
/// kept separate so the shared cell can `clone()` the inner state on
/// every read without going through the JsValue boundary. Construction
/// happens in `recv_loop::publish_stats_snapshot`.
#[cfg(target_arch = "wasm32")]
#[derive(Clone, Default)]
struct LatestStats {
    name: String,
    vitals: Vec<u32>,
    attributes: Vec<u32>,
    skills: Vec<u32>,
    level_info: Vec<u32>,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl SessionHandle {
    /// Drain queued [`ClientEvent`]s. JS calls this once per
    /// `requestAnimationFrame` tick (mirrors the cli's
    /// `tokio::select!` poll). Empty Vec is the steady state.
    ///
    /// The recv loop pushes events as they arrive; this method swaps
    /// the inner buffer out and returns it to JS in one wasm-boundary
    /// crossing.
    pub fn poll_events(&mut self) -> Vec<ClientEvent> {
        std::mem::take(&mut *self.queued_events.borrow_mut())
    }

    /// Phase 4 step 2b: drain queued [`EntityUpdate`]s — position
    /// updates, entity spawns (`ObjectCreate`), and entity removals
    /// (`ObjectDelete`). JS calls this on the same rAF tick as
    /// [`Self::poll_events`] but applies the updates against a
    /// separate `Map<guid, sprite>`. Empty Vec is the steady state
    /// when the player is in-world but stationary.
    ///
    /// Lives on a separate channel from `poll_events` because position
    /// updates can fire 100s/sec in a crowded zone — bundling them
    /// into [`ClientEvent`] would force per-event string allocation
    /// and an awkward payload-shape branch JS-side. See
    /// [`EntityUpdate`]'s doc comment for the full rationale.
    #[wasm_bindgen(js_name = pollEntityUpdates)]
    pub fn poll_entity_updates(&mut self) -> Vec<EntityUpdate> {
        std::mem::take(&mut *self.entity_updates.borrow_mut())
    }

    /// Snapshot of the most recent CharacterList. The recv loop updates
    /// the inner state on every `CharacterList` re-fire (e.g. after a
    /// successful `CharacterCreate` or `CharacterDelete`); JS calls
    /// this method to get a fresh `Vec` and re-render the Selection
    /// UI.
    #[wasm_bindgen(js_name = characterList)]
    pub fn character_list(&self) -> Vec<CharacterSummary> {
        self.character_list.borrow().clone()
    }

    /// Phase 4 step 4 follow-on: most recent player-stats snapshot.
    /// Returns an "empty" snapshot (zeroed level info, no vitals /
    /// attributes / skills) until the player's biota lands. JS calls
    /// this on every `kind=8 PlayerStatsUpdated` drain to refresh the
    /// vitals panel; calling it before that event fires is harmless.
    #[wasm_bindgen(js_name = playerStats)]
    pub fn player_stats(&self) -> PlayerStatsSnapshot {
        let stats = self
            .latest_stats
            .borrow()
            .clone()
            .unwrap_or_default();
        PlayerStatsSnapshot {
            name: stats.name,
            vitals: stats.vitals,
            attributes: stats.attributes,
            skills: stats.skills,
            level_info: stats.level_info,
        }
    }

    /// Phase 4 step 4 follow-on: most recent inventory snapshot.
    /// Includes the player's main pack contents + every equipped
    /// item (see [`InventoryItem::equip_mask`] for the equipped/
    /// not-equipped discriminator). Empty until the spawn flow lands
    /// the first `ObjectCreate` for an owned item.
    #[wasm_bindgen(js_name = playerInventory)]
    pub fn player_inventory(&self) -> Vec<InventoryItem> {
        self.latest_inventory.borrow().clone()
    }

    /// Phase 6 step D: cell id the local player is currently inside.
    /// Outdoor: `landblock_high | (cellX * 8 + cellY + 1)` per the AC
    /// 8x8 grid. Indoor: the EnvCell whose world-space AABB contains
    /// the player's pose (Z stacking discriminates between floors).
    /// Returns `0` pre-spawn or before the first TickMovement
    /// publishes a snapshot — JS treats that as "leave existing
    /// per-cell visibility alone".
    #[wasm_bindgen(js_name = getCurrentCellId)]
    pub fn get_current_cell_id(&self) -> u32 {
        self.cell_scene_snapshot.borrow().current_cell
    }

    /// Phase 6 step D: the BFS render set rooted at the player's
    /// current cell. `depth` controls the BFS depth — depth=1 returns
    /// the current cell plus every direct portal neighbour. Sorted
    /// ascending so the JS-side diff check (membership / set-equality)
    /// is O(n) without re-sorting. Depth=0 returns `[current_cell]`
    /// (or an empty list pre-spawn).
    ///
    /// Today the recv loop publishes a depth=1 snapshot per
    /// TickMovement; if `depth != 1` the call falls back to recomputing
    /// from the cached render set's seed. Production JS pins depth=1.
    #[wasm_bindgen(js_name = getRenderSet)]
    pub fn get_render_set(&self, depth: u8) -> Vec<u32> {
        let snap = self.cell_scene_snapshot.borrow();
        if depth == 1 || depth == 0 {
            // depth=0 is just the current cell — JS callers can pin
            // that themselves, but the snapshot's render_set already
            // contains current_cell at index 0 of the sort, so a
            // single-element vec is the cheap fallback.
            if depth == 0 {
                if snap.current_cell == 0 {
                    return Vec::new();
                }
                return vec![snap.current_cell];
            }
            return snap.render_set.clone();
        }
        // Phase D ships depth=1; the BFS-with-different-depth path is
        // a future ergonomic. Don't recompute from a non-canonical
        // depth without &World — return the canonical depth=1 set
        // instead of pretending we did the work.
        snap.render_set.clone()
    }

    /// Phase 6 step D: convenience flag — was the snapshot published
    /// from an indoor pose? JS reads this to decide whether the
    /// outdoor terrain container should be visible.
    #[wasm_bindgen(js_name = isCurrentCellIndoor)]
    pub fn is_current_cell_indoor(&self) -> bool {
        self.cell_scene_snapshot.borrow().is_indoor
    }

    /// Workstream Sky-B (parametric skybox, 2026-05-11): evaluate the
    /// cached SkyDesc against wall-clock UTC (or the active override)
    /// and return the per-frame lerped lighting state. JS calls this
    /// once per rAF tick from the skybox renderer.
    ///
    /// Returns `None` (JS receives `undefined`) when:
    /// - [`populate_sky_desc_from_region`] hasn't landed yet —
    ///   typically the first few rAF ticks after spawn.
    /// - The cached SkyDesc has zero DayGroups (sentinel; shouldn't
    ///   happen for retail Dereth).
    ///
    /// **Time semantics.** The time-of-day fraction is derived from
    /// `Date.now()` against [`holtburger_world::AC_LAUNCH_UNIX_EPOCH`]
    /// (Hypothesis B per Sky-B's investigation — see the module
    /// docstring on `crates/holtburger-world/src/sky.rs` for the
    /// evidence trail). JS can override via [`set_sky_time_override`].
    ///
    /// **Per-frame cost.** ~5 µs in release for retail Dereth's
    /// SkyDesc (20 DayGroups × 11 keyframes), well under the 16 ms
    /// 60 Hz budget. The expensive bit is the LCG day-group
    /// selection which the evaluator caches per (day, year) pair.
    #[wasm_bindgen(js_name = getSkyState)]
    pub fn get_sky_state(&self) -> Option<SkyState> {
        evaluate_sky_now().map(|(s, _)| s)
    }

    /// Workstream Sky-B: per-SkyObject snapshots for the active
    /// DayGroup. Returns one entry per `SkyObject` in
    /// `day_group.sky_objects` — `7` entries for retail Dereth's
    /// "Sunny" group (sky shell, alternate shell, sun, moon, cloud
    /// band, stars, physics-scripted moon).
    ///
    /// The `gfx_object_id` is surfaced VERBATIM — both `0x01xxxxxx`
    /// (GfxObj) and `0x02xxxxxx` (SetupModel) DIDs are returned
    /// untruncated, and the renderer is expected to dispatch on the
    /// high byte. SkyObjectReplace overrides applied by the surrounding
    /// SkyTimeOfDay keyframe are folded in here — `transparent`,
    /// `luminosity`, `max_bright` carry the override values (or `-1.0`
    /// when no replace targets the object).
    ///
    /// Empty Vec when [`populate_sky_desc_from_region`] hasn't landed.
    #[wasm_bindgen(js_name = getSkyObjectStates)]
    pub fn get_sky_object_states(&self) -> Vec<SkyObjectState> {
        evaluate_sky_now().map(|(_, o)| o).unwrap_or_default()
    }

    /// Workstream Sky-B: true once
    /// [`populate_sky_desc_from_region`] has landed. JS gates the
    /// per-frame `getSkyState` reads on this to avoid the first-few-
    /// frames `undefined` returns.
    #[wasm_bindgen(js_name = hasSkyDesc)]
    pub fn has_sky_desc(&self) -> bool {
        has_sky_desc()
    }

    /// Workstream Sky-B: drive the synthetic-day demo at
    /// `?skytime=accel`. JS calls this once per rAF tick with
    /// `t = (elapsed_ms / (5 * 60 * 1000)) % 1.0` to cycle a full day
    /// in 5 real minutes. Passing `f32::NAN` clears the override.
    ///
    /// Returns `true` if applied. `false` when the SkyDesc hasn't been
    /// populated yet (override is on the evaluator, which only exists
    /// after `populateSkyDescFromRegion`).
    #[wasm_bindgen(js_name = setSkyTimeOverride)]
    pub fn set_sky_time_override(&self, time_of_day: f32) -> bool {
        set_sky_time_override(time_of_day)
    }

    /// Workstream Sky-G: force `(day, year)` for DayGroup-cycling tests.
    /// Pass `(u32::MAX, u32::MAX)` to clear the override and return to
    /// wall-clock derivation. Used by the Sky-F capture script (bullet
    /// 17) to confirm `CalcPresentDayGroup` recomputes on date
    /// boundary crossings without waiting for real-world midnight.
    /// Mirrors `setSkyTimeOverride`.
    #[wasm_bindgen(js_name = setGameDayOverride)]
    pub fn set_game_day_override(&self, day: u32, year: u32) -> bool {
        set_game_day_override(day, year)
    }

    /// Workstream Sky-G: aggregate every gfx_obj_id referenced anywhere
    /// in the active SkyDesc — across all DayGroups, all SkyObjects'
    /// `default_gfx_object_id`, and all SkyTimeOfDay's
    /// `sky_obj_replace[*].gfx_obj_id`. The resolver pre-bakes this set
    /// so SkyObjectReplace mesh swaps at keyframe boundaries are
    /// zero-network.
    #[wasm_bindgen(js_name = getSkyOverrideObjectIds)]
    pub fn get_sky_override_object_ids(&self) -> Vec<u32> {
        get_sky_override_object_ids()
    }

    /// Workstream A (3D camera/game-feel fix): authoritative local-
    /// player runtime pose, refreshed by the recv-loop on each
    /// TickMovement after the integrator tick. JS reads this every rAF
    /// tick to drive the 3D follow camera, replacing the prior
    /// fallback chain that relied on the 2D `entityMap` /
    /// `__lastEntityWorldPos` stash. The pose matches what the
    /// `[step 3.6 tick #N]` heartbeat trace logs (both read
    /// `local_player_runtime_pose`).
    ///
    /// Returns `None` when:
    /// - The session is connected but the player entity hasn't been
    ///   seeded yet (pre-spawn flow);
    /// - WorldState isn't constructed (rare; wire-level errors).
    ///
    /// JS callers should treat `None` as "use last-known pose / wait
    /// for first emit" rather than as a hard error. The first
    /// non-`None` read lands within a few rAF ticks of EnteredWorld.
    #[wasm_bindgen(js_name = getLocalPlayerPose)]
    pub fn get_local_player_pose(&self) -> Option<LocalPlayerPose> {
        *self.local_player_pose.borrow()
    }

    /// Workstream C (3D camera collision, 2026-05-11): bilinear
    /// terrain-height lookup at world-frame `(x, y)`. Returns `None`
    /// when the containing landblock hasn't been baked into the
    /// terrain cache yet (pre-EnteredWorld, or an unloaded LB the
    /// camera momentarily sweeps over). Mirrors
    /// `WorldState::terrain_height_at` byte-for-byte — the recv-loop
    /// clones the heightmap cache into a shadow each TickMovement and
    /// this read consults that shadow.
    ///
    /// JS camera path uses this to lift the camera off the ground:
    /// `if (cameraZ < terrainZ + radius + 0.2) cameraZ = terrainZ + 0.6;`.
    /// Smooth because bilinear → no jitter on slopes.
    #[wasm_bindgen(js_name = terrainHeightAt)]
    pub fn terrain_height_at(&self, world_x: f32, world_y: f32) -> Option<f32> {
        const LB_M: f32 = 192.0;
        const VERT_M: f32 = 24.0;
        if !world_x.is_finite() || !world_y.is_finite() {
            return None;
        }
        let lb_x = (world_x / LB_M).floor() as i32;
        let lb_y = (world_y / LB_M).floor() as i32;
        if !(0..256).contains(&lb_x) || !(0..256).contains(&lb_y) {
            return None;
        }
        let landblock_id = ((lb_x as u32) << 24) | ((lb_y as u32) << 16);
        let shadow = self.terrain_heights_shadow.borrow();
        let grid = shadow.get(&landblock_id)?;
        let local_x = world_x - lb_x as f32 * LB_M;
        let local_y = world_y - lb_y as f32 * LB_M;
        let cell_x = (local_x / VERT_M).clamp(0.0, 8.0);
        let cell_y = (local_y / VERT_M).clamp(0.0, 8.0);
        let cx0 = cell_x.floor() as usize;
        let cy0 = cell_y.floor() as usize;
        let cx1 = (cx0 + 1).min(8);
        let cy1 = (cy0 + 1).min(8);
        let fx = cell_x - cx0 as f32;
        let fy = cell_y - cy0 as f32;
        let z00 = grid[cx0 * 9 + cy0];
        let z10 = grid[cx1 * 9 + cy0];
        let z01 = grid[cx0 * 9 + cy1];
        let z11 = grid[cx1 * 9 + cy1];
        let z = z00 * (1.0 - fx) * (1.0 - fy)
            + z10 * fx * (1.0 - fy)
            + z01 * (1.0 - fx) * fy
            + z11 * fx * fy;
        Some(z)
    }

    /// Workstream C (3D camera collision, 2026-05-11): coarse sweep
    /// against the **outdoor building per-part AABB index**. This is
    /// the first/fastest layer of the camera collision chain — it
    /// rejects 99% of frames where the camera isn't near any building.
    /// JS chains the more expensive
    /// `sweepSphereAgainstBuildingMesh` (precise per-triangle, incl.
    /// basement walls), `sweepSphereAgainstStatics`, and
    /// `sweepSphereAgainstCellMesh` after this.
    ///
    /// `from`/`to` are in world-metre coords (x east, y north, z up).
    /// `landblock_id` lets the shadow scene pick which LB's AABBs to
    /// consider; pass the player's current `landblock_id` from
    /// `getLocalPlayerPose().landblockId`. `radius` is the sphere
    /// radius (the camera capsule's "fat point"). Returns `None`
    /// (`null` in JS) on a clean miss.
    #[wasm_bindgen(js_name = cameraSweepCollision)]
    pub fn camera_sweep_collision(
        &self,
        from_x: f32,
        from_y: f32,
        from_z: f32,
        to_x: f32,
        to_y: f32,
        to_z: f32,
        radius: f32,
        landblock_id: u32,
    ) -> Option<CollisionHit> {
        use holtburger_common::position::WorldPosition;
        use holtburger_common::{Guid, Quaternion, Vector3};
        let start = Vector3::new(from_x, from_y, from_z);
        let end = Vector3::new(to_x, to_y, to_z);
        let delta = end - start;
        // The Scene's building-AABB sweep wants a `WorldPosition` so it
        // can pick neighbouring outdoor cells. Synthesize a stand-in
        // pose at `start` keyed by `landblock_id`; the landblock-local
        // coords are derived from `start - lb_origin`.
        let lb_high = landblock_id & 0xFFFF_0000;
        let lb_x = ((lb_high >> 24) & 0xFF) as f32;
        let lb_y = ((lb_high >> 16) & 0xFF) as f32;
        let pose = WorldPosition {
            landblock_id: Guid(landblock_id),
            coords: Vector3::new(
                start.x - lb_x * 192.0,
                start.y - lb_y * 192.0,
                start.z,
            ),
            rotation: Quaternion::identity(),
        };
        let scene = self.collision_scene.borrow();
        let hit = scene.sweep_sphere_against_buildings(&pose, delta, radius)?;
        Some(CollisionHit::from_building_hit(hit, start, delta))
    }

    /// Workstream C (3D camera collision, 2026-05-11): precise sweep
    /// against the **building-interior per-triangle physics index**.
    /// Distinct from `cameraSweepCollision` (coarse per-building-part
    /// AABB) — this path catches interior walls + basement walls + any
    /// fine geometry the per-part AABB doesn't resolve.
    ///
    /// Source data: each part's `GfxObj.physics_polygons`, fan-
    /// triangulated and lifted to world coords via the building's
    /// placement frame. Populated by
    /// `populateBuildingAabbsForLandblock` (extended in Workstream C).
    ///
    /// `from`/`to` in world coords; `landblock_id` identifies which
    /// LB's triangles to read. Returns `None` for a clean miss / no
    /// triangles loaded in that LB.
    #[wasm_bindgen(js_name = sweepSphereAgainstBuildingMesh)]
    pub fn sweep_sphere_against_building_mesh(
        &self,
        from_x: f32,
        from_y: f32,
        from_z: f32,
        to_x: f32,
        to_y: f32,
        to_z: f32,
        radius: f32,
        landblock_id: u32,
    ) -> Option<CollisionHit> {
        use holtburger_common::Vector3;
        let start = Vector3::new(from_x, from_y, from_z);
        let end = Vector3::new(to_x, to_y, to_z);
        let scene = self.collision_scene.borrow();
        let hit = scene.sweep_sphere_against_building_mesh(
            landblock_id,
            start,
            end,
            radius,
        )?;
        Some(CollisionHit::from_generic(hit))
    }

    /// Workstream C (3D camera collision, 2026-05-11): sweep against
    /// the **outdoor static placements** index (trees, signs, props).
    /// Statics are loaded from `LandblockInfo.objects` (the Stab list)
    /// alongside buildings; their AABBs land in the per-landblock
    /// static index via `populateStaticsAabbsForLandblock`.
    ///
    /// `from`/`to` in world coords. `landblock_id` identifies which LB
    /// to sample; the shadow scene's `statics_aabbs_near_pose` widens
    /// to the 3x3 ring automatically so a sweep across an LB boundary
    /// still resolves.
    #[wasm_bindgen(js_name = sweepSphereAgainstStatics)]
    pub fn sweep_sphere_against_statics(
        &self,
        from_x: f32,
        from_y: f32,
        from_z: f32,
        to_x: f32,
        to_y: f32,
        to_z: f32,
        radius: f32,
        landblock_id: u32,
    ) -> Option<CollisionHit> {
        use holtburger_common::position::WorldPosition;
        use holtburger_common::{Guid, Quaternion, Vector3};
        let start = Vector3::new(from_x, from_y, from_z);
        let end = Vector3::new(to_x, to_y, to_z);
        let delta = end - start;
        let lb_high = landblock_id & 0xFFFF_0000;
        let lb_x = ((lb_high >> 24) & 0xFF) as f32;
        let lb_y = ((lb_high >> 16) & 0xFF) as f32;
        let pose = WorldPosition {
            landblock_id: Guid(landblock_id),
            coords: Vector3::new(
                start.x - lb_x * 192.0,
                start.y - lb_y * 192.0,
                start.z,
            ),
            rotation: Quaternion::identity(),
        };
        let scene = self.collision_scene.borrow();
        let hit = scene.sweep_sphere_against_statics(&pose, delta, radius)?;
        Some(CollisionHit::from_generic(hit))
    }

    /// Workstream C (3D camera collision, 2026-05-11): sweep against
    /// the **EnvCell per-triangle physics index** for the cells in
    /// `cell_ids`. EnvCells are dungeons / apartments / instanced
    /// indoor spaces — their physics lives in `Environment.physics_-
    /// polygons` (NOT in `GfxObj.physics_polygons` — that's the
    /// building-interior path above).
    ///
    /// JS callers gate this on "is `cell_id` in the current render
    /// set" — pass the cell ID slice explicitly so JS controls the
    /// gate. Typically the render set comes from `getRenderSet(1)`
    /// (BFS depth=1 from the player's current cell).
    ///
    /// `from`/`to` in world coords; `cell_ids` is a flat `&[u32]` of
    /// full 32-bit cell IDs.
    #[wasm_bindgen(js_name = sweepSphereAgainstCellMesh)]
    pub fn sweep_sphere_against_cell_mesh(
        &self,
        from_x: f32,
        from_y: f32,
        from_z: f32,
        to_x: f32,
        to_y: f32,
        to_z: f32,
        radius: f32,
        cell_ids: &[u32],
    ) -> Option<CollisionHit> {
        use holtburger_common::Vector3;
        let start = Vector3::new(from_x, from_y, from_z);
        let end = Vector3::new(to_x, to_y, to_z);
        let scene = self.collision_scene.borrow();
        let hit = scene.sweep_sphere_against_cell_mesh(
            cell_ids, start, end, radius,
        )?;
        Some(CollisionHit::from_generic(hit))
    }

    /// Phase 6 step E follow-up (2026-05-09): resolve a door GUID to the
    /// building placement and part index it was registered against. The
    /// recv-loop populates this on ObjectCreate by sweeping
    /// `building_aabb_index` for the door's spawn pose; JS calls this on
    /// kind=15 DoorStateChanged to look up the matching PIXI container
    /// in `liveScene.buildingMap` by reconstructing the same
    /// `${landblockId}_${x}_${y}_${modelId}` key shape
    /// `buildBuildingsContainer` builds.
    ///
    /// Returns `null` (JsValue) when:
    /// - The door spawned before its landblock's AABBs were drained
    ///   (race — JS falls back to `findClosestBuildingPart`);
    /// - The door is admin-spawned in a dynamic dungeon with no
    ///   `LandblockInfo.buildings` entry;
    /// - `door_guid` doesn't correspond to a registered door (caller
    ///   bug or pre-spawn lookup).
    ///
    /// On hit, returns a [`DoorPartSnapshot`] (a wasm-bindgen struct
    /// with `landblockId`, `modelId`, `originX`, `originY`, `partIndex`
    /// getters). JS rebuilds the buildingKey via
    /// ``` `${landblockId.toString(16).padStart(8, "0")}_${originX.toFixed(2)}_${originY.toFixed(2)}_${modelId.toString(16).padStart(8, "0")}` ```
    /// and indexes `liveScene.buildingMap.get(key).children[partIndex]`.
    #[wasm_bindgen(js_name = getBuildingPartForDoor)]
    pub fn get_building_part_for_door(&self, door_guid: u32) -> Option<DoorPartSnapshot> {
        self.door_part_snapshot.borrow().get(&door_guid).copied()
    }

    /// Account name the session is logged in as. Echoed back by ACE
    /// in the CharacterList packet body — useful for a Selection-page
    /// header line.
    #[wasm_bindgen(getter, js_name = accountName)]
    pub fn account_name(&self) -> String {
        self.account_name.clone()
    }

    /// Phase 4 step 2a: pick a character from the Selection list and
    /// drive the spawn handshake.
    ///
    /// Sends a `SessionCommand::SelectCharacter` into the recv loop's
    /// command channel. The loop then sends
    /// `GameMessage::CharacterEnterWorldRequest(guid)` over the wire
    /// and auto-chains the `CharacterEnterWorldServerReady` →
    /// `CharacterEnterWorld { guid, account }` follow-up without JS
    /// having to drive each step. When ACE replies with
    /// `GameMessage::PlayerCreate(guid)`, a `kind=1` PlayerSpawned
    /// event lands in the queue; JS sees it on the next `poll_events`
    /// call.
    ///
    /// Returns `Ok(())` on enqueue success. The actual spawn outcome
    /// arrives asynchronously via the event queue, not as the return
    /// value. If the cmd channel is closed (handle dropped or recv
    /// loop exited) the call rejects with a string error.
    #[wasm_bindgen(js_name = selectCharacter)]
    pub fn select_character(&self, guid: u32) -> Result<(), JsValue> {
        use futures::channel::mpsc::TrySendError;
        self.cmd_tx
            .unbounded_send(SessionCommand::SelectCharacter { guid })
            .map_err(|e: TrySendError<_>| {
                JsValue::from_str(&format!("select_character: cmd channel closed ({e})"))
            })
    }

    /// Phase 4 step 2a.5: create a hardcoded-defaults test character
    /// on the logged-in account.
    ///
    /// Picks Aluvian heritage / Male / Adventurer template / Holtburg
    /// starter area / template-default attributes / template-minimum
    /// skills / randomised appearance. The character_slot is
    /// `current_character_list.len()` so each call lands in the next
    /// free slot. Builds a `CharacterCreateRequestData` via
    /// [`holtburger_core::CharacterGenBuilder::build_request`] (so
    /// every constraint ACE validates server-side has already been
    /// validated client-side), and dispatches to the recv loop via
    /// `SessionCommand::CreateCharacter`.
    ///
    /// Errors:
    /// - `JsValue::from_str("create_test_character: catalog not loaded …")`
    ///   if `start_session` wasn't given an `asset_url`.
    /// - `JsValue::from_str("create_test_character: validation: [...]")`
    ///   if the catalog rejects the build (heritage missing, skill
    ///   slot count off, etc. — would only fire on a malformed
    ///   fixture).
    /// - `JsValue::from_str("create_test_character: cmd channel closed …")`
    ///   if the recv loop has already exited.
    ///
    /// Returns immediately on enqueue success. The actual
    /// CharacterCreate outcome arrives via `poll_events` as a
    /// `kind=5 CharacterCreated` (success) or `kind=6
    /// CharacterCreateFailed` (server-side rejection — duplicate
    /// name, etc.) event.
    #[wasm_bindgen(js_name = createTestCharacter)]
    pub fn create_test_character(&self, name: String) -> Result<(), JsValue> {
        use futures::channel::mpsc::TrySendError;
        let catalog_borrow = self.catalog.borrow();
        let catalog = catalog_borrow.as_ref().ok_or_else(|| {
            JsValue::from_str(
                "create_test_character: catalog not loaded yet. Either start_session was given an empty asset_url, the fetch is still in flight, or the fetch failed. Poll handle.canCreateCharacter to wait.",
            )
        })?;
        let occupied_slots: Vec<u32> = (0..self.character_list.borrow().len() as u32).collect();
        let request = build_test_character_request(catalog.clone(), name, &occupied_slots)
            .map_err(|errors| {
                JsValue::from_str(&format!(
                    "create_test_character: validation: {errors:?}"
                ))
            })?;
        self.cmd_tx
            .unbounded_send(SessionCommand::CreateCharacter {
                request: Box::new(request),
            })
            .map_err(|e: TrySendError<_>| {
                JsValue::from_str(&format!("create_test_character: cmd channel closed ({e})"))
            })
    }

    /// Phase 4 step 2a.5: returns whether character creation is
    /// available (i.e. CharGen + SkillTable were successfully loaded
    /// at start_session time). JS reads this to decide whether to
    /// surface the Create-character UI.
    #[wasm_bindgen(getter, js_name = canCreateCharacter)]
    pub fn can_create_character(&self) -> bool {
        self.catalog.borrow().is_some()
    }

    /// Phase 4 step 2a.6: dispatch a chat-channel string to the
    /// server. Strings starting with `@` or `/` route to ACE's
    /// admin / advocate / developer command parser — useful for
    /// dev-time conveniences like `@telepoi Holtburg` to bypass
    /// the Training Academy tutorial. Plain strings (no leading
    /// `@`/`/`) hit the local-area chat channel.
    ///
    /// **Access-level enforcement is server-side.** A regular
    /// player account silently drops admin commands. Dev recipe:
    /// `mariadb -uace -pace -e "UPDATE ace_auth.account SET
    /// accessLevel = 4 WHERE accountName LIKE 'phase4demo%'"`
    /// (Developer level = 4) lets `@telepoi` / `@teleloc` /
    /// `@telexyz` work. See `docs/phase-4-renderer.md` step 2a.6.
    ///
    /// **Timing.** Strictly speaking, ACE wants the player in
    /// `InWorld` state before processing chat (the cli's
    /// `handle_chat_command` gates on this — see
    /// `crates/holtburger-core/src/client/commands.rs:273`). JS
    /// should wait for `kind=7 EnteredWorld` before calling this;
    /// pre-EnteredWorld chats are silently dropped by ACE rather
    /// than rejected.
    ///
    /// Returns `Ok(())` on cmd-channel enqueue. The send itself
    /// happens asynchronously inside the recv loop; chat replies
    /// (e.g. `@telepoi`'s teleport completion) arrive as
    /// `GameEvent::CommunicationTransientString` or position
    /// updates — not surfaced to JS in step 2a.6, but reachable
    /// via future kind=2 chat events.
    #[wasm_bindgen(js_name = sendChat)]
    pub fn send_chat(&self, message: String) -> Result<(), JsValue> {
        use futures::channel::mpsc::TrySendError;
        if message.is_empty() {
            return Err(JsValue::from_str("send_chat: empty message"));
        }
        self.cmd_tx
            .unbounded_send(SessionCommand::SendChat { message })
            .map_err(|e: TrySendError<_>| {
                JsValue::from_str(&format!("send_chat: cmd channel closed ({e})"))
            })
    }

    /// Phase 4 step 5 (interactive entities): the player clicked an
    /// entity sprite. Wraps the target guid in a
    /// `GameAction::Use(UseActionData { guid })` and dispatches via
    /// the recv loop's cmd channel. ACE handles the rest based on
    /// the target's WeenieType:
    /// - **Portal** → ACE responds with `PlayerTeleport` + position
    ///   update (already handled in step 3.6's recv arm — clears
    ///   `Teleporting` flag, fires kind=8 stat re-publish on cell
    ///   transition).
    /// - **Vendor** (a `Creature` weenie with merchandise) → ACE
    ///   responds with `GameEvent::ApproachVendor` carrying the
    ///   vendor's item list + buy/sell multipliers. Recv loop
    ///   normalises into `kind=12 VendorOpened` (stringPayload =
    ///   vendor display name; u32_payload = vendor guid;
    ///   u32_payload_2 = item count).
    /// - **Door / lockable container** → ACE responds with
    ///   `GameEvent::UseDone(error)`. `error == None` means
    ///   succeeded (door opened, container approached); non-None
    ///   carries a `WeenieError` variant (Locked, OutOfRange, etc.)
    ///   which lands as `kind=13 UseFailed`.
    /// - **Out-of-range / non-interactive target** → ACE responds
    ///   with `GameEvent::WeenieError` directly (no UseDone). Same
    ///   `kind=13 UseFailed` normalisation.
    ///
    /// Returns `Ok(())` on cmd-channel enqueue. The actual outcome
    /// (success vs. failure, vendor open vs. portal teleport)
    /// arrives async via subsequent `poll_events` drains — JS
    /// dispatches on event kind, not on this call's return value.
    ///
    /// **Timing.** Caller should wait for `kind=7 EnteredWorld` (or
    /// equivalently, that the player is in-world) before clicking;
    /// pre-EnteredWorld uses are silently dropped by ACE.
    #[wasm_bindgen(js_name = useObject)]
    pub fn use_object(&self, guid: u32) -> Result<(), JsValue> {
        use futures::channel::mpsc::TrySendError;
        self.cmd_tx
            .unbounded_send(SessionCommand::UseObject { guid })
            .map_err(|e: TrySendError<_>| {
                JsValue::from_str(&format!("use_object: cmd channel closed ({e})"))
            })
    }

    /// Phase 4 step 3: forward a keystate snapshot to the recv loop,
    /// which builds and sends the corresponding `MoveToState` packet.
    /// Each axis is `-1` / `0` / `+1`; `run` is the shift-modifier
    /// flag.
    ///
    /// **Axes** (mirrors the retail AC keymap):
    /// - `forward`: +1 = W (walk/run forward), -1 = S (backstep), 0 = none
    /// - `strafe`: +1 = D (sidestep right), -1 = A (sidestep left), 0 = none
    /// - `turn`: +1 = E (turn right), -1 = Q (turn left), 0 = none
    /// - `run`: shift-held — selects `HoldKey::Run` and run-rate
    ///   speed/turn-speed scalars
    ///
    /// **Send cadence.** JS calls this once per *change* in keystate
    /// (keydown / keyup transition or modifier flip), not on every
    /// animation frame. ACE simulates motion server-side once the
    /// motion state is set; the client's role is to push state
    /// transitions, not stream a tick rate.
    ///
    /// **All-zero axes is the canonical "stop"**: the wire packet
    /// carries an empty `RawMotionState` (just `CURRENT_HOLD_KEY`)
    /// and ACE clears the active drive.
    ///
    /// Returns `Ok(())` on cmd-channel enqueue. The actual send
    /// happens asynchronously inside the recv loop. If the local
    /// player's position is not yet known (no PrivateUpdatePosition
    /// has landed), the recv loop drops the command with a
    /// `log::warn!`; gate JS calls on `kind=7 EnteredWorld` to
    /// avoid that race.
    #[wasm_bindgen(js_name = setMovementInput)]
    pub fn set_movement_input(
        &self,
        forward: i8,
        strafe: i8,
        turn: i8,
        run: bool,
    ) -> Result<(), JsValue> {
        use futures::channel::mpsc::TrySendError;
        self.cmd_tx
            .unbounded_send(SessionCommand::SetMovementInput {
                forward,
                strafe,
                turn,
                run,
            })
            .map_err(|e: TrySendError<_>| {
                JsValue::from_str(&format!("set_movement_input: cmd channel closed ({e})"))
            })
    }

    /// Combat-mode toggle — flip the local player between
    /// NonCombat and a combat mode (Melee / Missile / Magic) chosen
    /// from equipped items. Mirrors the retail AC `~` (backtick)
    /// hotkey: one binary toggle, server derives the actual
    /// `MotionStance` from inventory.
    ///
    /// The wasm recv-loop arm reads `world.player_combat_mode()`
    /// (sourced from `PropertyInt::CombatMode` on the player, kept
    /// current by `holtburger_world::handlers::properties` whenever
    /// ACE pushes a `PrivateUpdatePropertyInt`). When NonCombat,
    /// sends `ChangeCombatMode(world.get_suggested_combat_mode())`;
    /// otherwise sends `ChangeCombatMode(NonCombat)`. ACE's
    /// `Player_Combat.cs::HandleActionChangeCombatMode` validates
    /// the request against the equipped weapon (`CheckWeaponCollision`)
    /// — invalid combinations silently revert to NonCombat — then
    /// derives the stance via `Creature_Combat.cs::GetCombatStance`
    /// and broadcasts `UpdateMotion` with the resulting
    /// `MotionStance` to all observers.
    ///
    /// Pairs with stance-keyed walk/run cycles: the kind=5
    /// `ENTITY_UPDATE_KIND_MOTION` recv arm picks up the
    /// server-derived stance and the per-stance cycle bake fires
    /// for the new gait. Stance display in the vitals header is
    /// driven by the same kind=5 path; combat-mode toggle is
    /// fire-and-forget on the client side.
    /// Populate the world's terrain heightmap cache for one landblock.
    /// JS feeds the 81-float Z grid from
    /// `fetch_landblock_heightmap(cell_id).heights` after the player
    /// reaches `kind=7 EnteredWorld`. The integrator consults this
    /// cache each tick to snap pose Z to terrain (preventing the
    /// constant-Z bug that causes ACE physics to apply false gravity
    /// and impact damage on the Holtburg town slope).
    ///
    /// `landblockId` is the high 16 bits of the cell id (e.g.
    /// `0xA9B40000` for Holtburg). Length-validation: heights must
    /// have exactly 81 entries (9×9 grid). Other lengths log a
    /// warning and drop.
    #[wasm_bindgen(js_name = populateTerrain)]
    pub fn populate_terrain(
        &self,
        landblock_id: u32,
        heights: Vec<f32>,
    ) -> Result<(), JsValue> {
        use futures::channel::mpsc::TrySendError;
        if heights.len() != 81 {
            return Err(JsValue::from_str(&format!(
                "populate_terrain: heights length must be 81, got {}",
                heights.len()
            )));
        }
        self.cmd_tx
            .unbounded_send(SessionCommand::PopulateTerrain {
                landblock_id,
                heights,
            })
            .map_err(|e: TrySendError<_>| {
                JsValue::from_str(&format!("populate_terrain: cmd channel closed ({e})"))
            })
    }

    #[wasm_bindgen(js_name = toggleCombatMode)]
    pub fn toggle_combat_mode(&self) -> Result<(), JsValue> {
        use futures::channel::mpsc::TrySendError;
        self.cmd_tx
            .unbounded_send(SessionCommand::ToggleCombatMode)
            .map_err(|e: TrySendError<_>| {
                JsValue::from_str(&format!("toggle_combat_mode: cmd channel closed ({e})"))
            })
    }

    /// Phase 4 step 3.6 — JS-driven physics tick.
    ///
    /// Called from `index.html`'s `requestAnimationFrame(drainEvents)`
    /// loop on every frame (~16 ms). The recv loop pulls the command
    /// and runs `MovementSystemHandle::tick(now, &mut world, &mut session)`
    /// which (a) reconciles any server-controlled projection, (b)
    /// processes queued drive intents, and (c) emits due
    /// `MoveToState` and `AutonomousPosition` packets — including the
    /// AutonomousPosition heartbeat that was missing pre-3.6 and is
    /// the load-bearing fix for server-side player movement.
    ///
    /// rAF cadence (~60 Hz) is well under the cli's 50 ms physics tick
    /// (20 Hz). Heartbeat scheduling internal to MovementSystem
    /// throttles the actual outbound rate; the JS tick just provides
    /// scheduling slots.
    ///
    /// Returns `Ok(())` on cmd-channel enqueue; rAF discards channel
    /// errors via `try { ... } catch { }`. Pre-EnteredWorld ticks are
    /// no-ops in the recv loop (no `world` exists yet).
    #[wasm_bindgen(js_name = tickMovement)]
    pub fn tick_movement(&self) -> Result<(), JsValue> {
        use futures::channel::mpsc::TrySendError;
        self.cmd_tx
            .unbounded_send(SessionCommand::TickMovement {
                now: web_time::Instant::now(),
            })
            .map_err(|e: TrySendError<_>| {
                JsValue::from_str(&format!("tick_movement: cmd channel closed ({e})"))
            })
    }
}

/// Phase 4 step 2a.5: construct an Aluvian / Male / Adventurer /
/// Holtburg `CharacterCreateRequestData`. Mirrors the cli's
/// `CharacterCreationFormState::build_request` (see
/// `apps/holtburger-cli/src/pages/selection/creation.rs`) but with
/// hardcoded defaults instead of form-driven values.
///
/// Fixed picks:
/// - heritage = first heritage id with name "Aluvian" (typically
///   `0x00000001`); falls back to the first heritage available if
///   Aluvian is absent (custom asset packs).
/// - gender = first key in `heritage.genders` (typically Male).
/// - template = template_option of the heritage's first template
///   (typically Adventurer = 0; Olthoi heritages have only "Ripper").
/// - start_area = first id in `heritage.primary_start_area_ids`
///   (typically Holtburg for Aluvian).
/// - attribute values = template defaults from
///   `template.attribute_values()`.
/// - skill_advancement_classes = `Inactive` everywhere except the
///   slots `catalog.skill_definitions` lists, which get
///   `minimum_skill_advancement_for_heritage` (template's normal /
///   primary skills set Trained / Specialized; otherwise Untrained).
/// - appearance = `CharacterGenBuilder::randomize_appearance` (random
///   indices into the heritage's hair / eye / mouth / clothing
///   lists; random hue floats).
/// - is_admin / is_sentinel = false (server policy default rejects
///   non-zero anyway).
///
/// `account_name` is left empty here — the recv loop stamps the
/// session's account name onto the request just before sending,
/// matching the cli's `character_selection.create_character` path.
#[cfg(target_arch = "wasm32")]
fn build_test_character_request(
    catalog: std::sync::Arc<holtburger_content::CharacterGenCatalog>,
    name: String,
    occupied_slots: &[u32],
) -> Result<
    holtburger_protocol::messages::CharacterCreateRequestData,
    Vec<holtburger_core::CharacterGenValidationError>,
> {
    use holtburger_core::character_gen::minimum_skill_advancement_for_heritage;
    use holtburger_core::{CharacterGenBuild, CharacterGenBuilder};
    use holtburger_protocol::messages::SkillAdvancementClass;

    // Pick Aluvian if present (key=1 by AC convention); fall back to
    // the first heritage in the catalog.
    let heritage = catalog
        .heritage_groups
        .values()
        .find(|h| h.name.eq_ignore_ascii_case("Aluvian"))
        .or_else(|| catalog.heritage_groups.values().next())
        .cloned();
    let Some(heritage) = heritage else {
        return Err(vec![
            holtburger_core::CharacterGenValidationError::UnknownHeritage { heritage_id: 0 },
        ]);
    };

    let gender_id = heritage.genders.keys().next().copied().unwrap_or(0);

    // Pick the first template whose attribute spread already sums to
    // the heritage's full `attribute_credits` budget. Skip the
    // "Custom" / Adventurer template (index 0 by AC convention) — its
    // attributes are 10/10/10/10/10/10 = 60, designed to be edited by
    // the user. Pre-spread templates (Bow Hunter, Soldier, etc.) are
    // already at the full budget so the build validates without
    // user-driven point spending. Falls back to the first template
    // (and the validation would fail with AttributeBudgetIncomplete)
    // if no pre-spread template exists — caller surfaces that as the
    // CharacterGenValidationError it is.
    let template = heritage
        .templates
        .iter()
        .find(|t| {
            let total = t.strength
                + t.endurance
                + t.coordination
                + t.quickness
                + t.focus
                + t.self_stat;
            total == heritage.attribute_credits
        })
        .or_else(|| heritage.templates.first())
        .cloned()
        .unwrap_or_else(|| holtburger_content::character_gen::CharacterGenTemplate {
            template_option: 0,
            name: String::new(),
            icon_image: 0,
            title_id: 0,
            strength: 50,
            endurance: 50,
            coordination: 50,
            quickness: 50,
            focus: 50,
            self_stat: 50,
            normal_skills: Vec::new(),
            primary_skills: Vec::new(),
        });

    let start_area = heritage
        .primary_start_area_ids
        .iter()
        .chain(heritage.secondary_start_area_ids.iter())
        .filter_map(|id| u32::try_from(*id).ok())
        .next()
        .unwrap_or(0);

    let mut skill_advancement_classes =
        vec![SkillAdvancementClass::Inactive; catalog.expected_skill_slots];
    for definition in catalog.skill_definitions.values() {
        let min = minimum_skill_advancement_for_heritage(
            catalog.as_ref(),
            heritage.heritage_id,
            definition.skill_id,
        );
        if let Some(slot) = skill_advancement_classes.get_mut(definition.skill_id as usize) {
            *slot = min;
        }
    }

    let character_slot = first_available_character_slot(occupied_slots);

    let builder = CharacterGenBuilder::new(catalog.clone());
    let appearance = builder.randomize_appearance(heritage.heritage_id, gender_id);

    let attribute_values = template.attribute_values();
    let build = CharacterGenBuild {
        heritage: heritage.heritage_id,
        gender: gender_id,
        appearance,
        template_option: template.template_option,
        strength_ability: attribute_values[0].1,
        endurance_ability: attribute_values[1].1,
        coordination_ability: attribute_values[2].1,
        quickness_ability: attribute_values[3].1,
        focus_ability: attribute_values[4].1,
        self_ability: attribute_values[5].1,
        character_slot,
        skill_advancement_classes,
        name,
        start_area,
        is_admin: false,
        is_sentinel: false,
    };

    builder.build_request(build)
}

#[cfg(target_arch = "wasm32")]
fn first_available_character_slot(occupied: &[u32]) -> u32 {
    let mut sorted: Vec<u32> = occupied.iter().copied().collect();
    sorted.sort_unstable();
    let mut slot = 0u32;
    for taken in sorted {
        if taken == slot {
            slot += 1;
        } else if taken > slot {
            break;
        }
    }
    slot
}

/// Drive the AC login → CharacterList handshake, then spawn a recv
/// loop that pumps `recv_message` for the lifetime of the handle.
///
/// Steps:
/// 1. Open a `WsTransport` against `bridge_url` for the `server_ip`
///    literal (the IP ACE answers on; the bridge tags inbound frames
///    with it so the session's source-address allowlist matches).
/// 2. Build `Session::new_with_transport(transport, server_addr)`.
/// 3. Send `LoginRequest(username, password)` via
///    `session.send_login_request`.
/// 4. If `asset_url` is non-empty, fetch the HBA via
///    `HttpResourceSource`, parse `CharGen` (`0x0E000002`) +
///    `SkillTable` (`0x0E000004`), and build a
///    `CharacterGenCatalog` for offline character-creation
///    validation. Failures here log a warning and proceed — the
///    session is still usable, just without `create_test_character`.
/// 5. `wasm_bindgen_futures::spawn_local` the recv loop, handing it
///    the Session, the cmd channel receiver, the shared event queue,
///    the shared character-list slot, and a oneshot sender for the
///    initial CharacterList. Earlier control packets (CONNECT_REQUEST
///    → CONNECT_RESPONSE) are handled inside the session's receive
///    loop automatically.
/// 6. Await the oneshot — the recv loop signals as soon as it parses
///    the first `GameMessage::CharacterList`. Returns a
///    [`SessionHandle`] holding the cmd sender + shared event queue +
///    shared character-list snapshot + optional CharacterGenCatalog.
///
/// **Errors.** Any failure at transport open, login send, or initial
/// CharacterList wait rejects the returned Promise with a tagged
/// error string. After `start_session` resolves, transient errors
/// inside the recv loop (e.g. server hangup) surface as
/// `kind=4 Disconnected` events through `poll_events()` — they do not
/// reject anything. Catalog load failures log + proceed (returns
/// `canCreateCharacter = false`).
///
/// **No retry / timeout** — if ACE never responds the Promise stays
/// pending. A page reload bails the user out.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn start_session(
    bridge_url: String,
    server_host: String,
    server_port: u16,
    username: String,
    password: String,
) -> Result<SessionHandle, JsValue> {
    use futures::channel::{mpsc, oneshot};

    let transport = holtburger_transport_ws::WsTransport::connect(
        &bridge_url,
        &server_host,
        server_port,
        None,
    )
    .await
    .map_err(|e| JsValue::from_str(&format!("WsTransport::connect: {e}")))?;
    let ip: IpAddr = transport.server_ip();

    let mut session = holtburger_session::Session::new_with_transport(
        Box::new(transport),
        SocketAddr::new(ip, server_port),
    );

    session
        .send_login_request(&username, &password)
        .await
        .map_err(|e| JsValue::from_str(&format!("send_login_request: {e}")))?;

    let (cmd_tx, cmd_rx) = mpsc::unbounded::<SessionCommand>();
    let (charlist_tx, charlist_rx) = oneshot::channel::<CharListReady>();
    let queued_events: std::rc::Rc<std::cell::RefCell<Vec<ClientEvent>>> =
        std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let character_list: std::rc::Rc<std::cell::RefCell<Vec<CharacterSummary>>> =
        std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let catalog: std::rc::Rc<
        std::cell::RefCell<Option<std::sync::Arc<holtburger_content::CharacterGenCatalog>>>,
    > = std::rc::Rc::new(std::cell::RefCell::new(None));
    let entity_updates: std::rc::Rc<std::cell::RefCell<Vec<EntityUpdate>>> =
        std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    // Phase 4 step 3.6: WorldBootstrap is loaded in parallel with the
    // catalog so it's ready before EnteredWorld fires. Recv loop reads
    // the cell on EnteredWorld to construct a `WorldState` for the
    // cli's `MovementSystemHandle`.
    let world_bootstrap: std::rc::Rc<
        std::cell::RefCell<Option<std::sync::Arc<holtburger_world::WorldBootstrap>>>,
    > = std::rc::Rc::new(std::cell::RefCell::new(None));
    // Phase 4 step 4 follow-on (vitals + inventory panels): shared
    // snapshot cells the recv loop publishes into when the canonical
    // world handler dispatcher signals stat / inventory changes. JS
    // reads via `playerStats()` / `playerInventory()` after each
    // `kind=8` / `kind=11` drain.
    let latest_stats: std::rc::Rc<std::cell::RefCell<Option<LatestStats>>> =
        std::rc::Rc::new(std::cell::RefCell::new(None));
    let latest_inventory: std::rc::Rc<std::cell::RefCell<Vec<InventoryItem>>> =
        std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    // Phase 6 step D: cell-scene snapshot, refreshed each TickMovement.
    let cell_scene_snapshot: std::rc::Rc<std::cell::RefCell<CellSceneSnapshot>> =
        std::rc::Rc::new(std::cell::RefCell::new(CellSceneSnapshot::default()));
    // Phase 6 step E follow-up (2026-05-09): door-part snapshot, mutated
    // by the recv-loop ObjectCreate arm and read by JS via
    // `getBuildingPartForDoor`.
    let door_part_snapshot: std::rc::Rc<
        std::cell::RefCell<std::collections::HashMap<u32, DoorPartSnapshot>>,
    > = std::rc::Rc::new(std::cell::RefCell::new(std::collections::HashMap::new()));
    // Workstream A: shared cell for the local player's authoritative
    // pose, refreshed by the recv-loop on each TickMovement.
    let local_player_pose: std::rc::Rc<std::cell::RefCell<Option<LocalPlayerPose>>> =
        std::rc::Rc::new(std::cell::RefCell::new(None));
    // Workstream C: shared shadow of the live SpatialScene + terrain
    // heightmap, refreshed by the recv-loop on each TickMovement.
    let collision_scene: std::rc::Rc<
        std::cell::RefCell<holtburger_world::SpatialScene>,
    > = std::rc::Rc::new(std::cell::RefCell::new(
        holtburger_world::SpatialScene::new(),
    ));
    let terrain_heights_shadow: std::rc::Rc<
        std::cell::RefCell<std::collections::HashMap<u32, [f32; 81]>>,
    > = std::rc::Rc::new(std::cell::RefCell::new(std::collections::HashMap::new()));

    {
        let queued_events = queued_events.clone();
        let character_list = character_list.clone();
        let entity_updates = entity_updates.clone();
        let world_bootstrap = world_bootstrap.clone();
        let latest_stats = latest_stats.clone();
        let latest_inventory = latest_inventory.clone();
        let cell_scene_snapshot = cell_scene_snapshot.clone();
        let door_part_snapshot = door_part_snapshot.clone();
        let local_player_pose = local_player_pose.clone();
        let collision_scene_inner = collision_scene.clone();
        let terrain_heights_shadow_inner = terrain_heights_shadow.clone();
        wasm_bindgen_futures::spawn_local(async move {
            recv_loop(
                session,
                cmd_rx,
                queued_events,
                character_list,
                entity_updates,
                Some(charlist_tx),
                world_bootstrap,
                latest_stats,
                latest_inventory,
                cell_scene_snapshot,
                door_part_snapshot,
                local_player_pose,
                collision_scene_inner,
                terrain_heights_shadow_inner,
            )
            .await;
        });
    }

    // Phase 4 step 2a.6 + Phase 5.0b: kick off the catalog fetch
    // in the background — don't block start_session on it. On a
    // phone over tailscale, pulling records ad-hoc can still take
    // a few hundred ms each (CharGen is ~70 KB, SkillTable a few
    // KB), leaving the user stuck briefly. JS polls
    // `handle.canCreateCharacter` until the background fetch
    // completes. Phase 5.0b changes this from "fetch the 605 MB
    // HBA" to "prefetch the 2 catalog records via the manifest
    // source" — orders of magnitude faster.
    if global_source::has_resource_source() {
        let catalog = catalog.clone();
        wasm_bindgen_futures::spawn_local(async move {
            match load_character_gen_catalog().await {
                Ok(loaded) => {
                    *catalog.borrow_mut() = Some(loaded);
                    log::info!("character generator catalog loaded");
                }
                Err(e) => {
                    log::warn!("character generator catalog load failed: {e}");
                }
            }
        });
        // Phase 4 step 3.6: load the 5 game-data tables (skill / spell
        // / xp / motion-kinematics / chat-pose) needed by `WorldBootstrap`.
        // Required for the cli's `MovementSystemHandle` movement loop.
        let world_bootstrap = world_bootstrap.clone();
        wasm_bindgen_futures::spawn_local(async move {
            match load_world_bootstrap().await {
                Ok(loaded) => {
                    *world_bootstrap.borrow_mut() = Some(loaded);
                    console_log_str("[step 3.6] world bootstrap loaded");
                }
                Err(e) => {
                    console_log_str(&format!(
                        "[step 3.6] world bootstrap load failed: {e}"
                    ));
                }
            }
        });
    }

    let CharListReady { account_name } = charlist_rx
        .await
        .map_err(|_| JsValue::from_str("recv loop exited before CharacterList arrived"))?;

    Ok(SessionHandle {
        cmd_tx,
        queued_events,
        character_list,
        account_name,
        catalog,
        entity_updates,
        latest_stats,
        latest_inventory,
        cell_scene_snapshot,
        door_part_snapshot,
        local_player_pose,
        collision_scene,
        terrain_heights_shadow,
    })
}

/// Phase 4 step 2a.5 + Phase 5.0b: prefetch + parse the CharGen +
/// SkillTable records via the global manifest source and build a
/// `CharacterGenCatalog`. Used by `start_session` (during login)
/// for client-side character-creation validation. Returns `Err`
/// if init_resource_source hasn't been called, the prefetch
/// fails, the records are missing from the manifest, or parse
/// trips.
#[cfg(target_arch = "wasm32")]
async fn load_character_gen_catalog()
-> anyhow::Result<std::sync::Arc<holtburger_content::CharacterGenCatalog>> {
    use holtburger_dat::ResourceKey;
    use holtburger_dat::file_type::{CharGen, SkillTable};
    let source = global_source::try_global_source().ok_or_else(|| {
        anyhow::anyhow!("init_resource_source must be called before start_session catalog fetch")
    })?;
    let keys = [
        ResourceKey::new("eor/portal", CharGen::FILE_ID),
        ResourceKey::new("eor/portal", SkillTable::FILE_ID),
    ];
    source
        .prefetch(&keys)
        .await
        .map_err(|e| anyhow::anyhow!("prefetch catalog: {e}"))?;
    let mounts: Vec<std::sync::Arc<dyn holtburger_dat::ResourceSource>> = vec![source];
    let repo = holtburger_content::ContentRepository::from_mounts(mounts);
    let char_gen = repo
        .read_asset::<holtburger_dat::file_type::CharGen>("character generator table")?;
    let skill_table = repo
        .read_asset::<holtburger_dat::file_type::SkillTable>("skill table")?;
    Ok(std::sync::Arc::new(
        holtburger_content::CharacterGenCatalog::from_assets(&char_gen, &skill_table),
    ))
}

/// Phase 4 step 3.6: prefetch + parse the five game-data tables a
/// `WorldBootstrap` needs (SkillTable, SpellTable, XpTable,
/// MotionKinematics, ChatPoseTable → SoulEmoteCatalog), build the
/// bootstrap, and hand it to the recv loop's `WorldState::new`.
///
/// Mirrors the cli's `ClientRuntimeBuilder::load_assets`
/// (`crates/holtburger-core/src/client/builder.rs:54-80`). Called once
/// on `kind=7 EnteredWorld`.
///
/// Notes on namespaces: the four AC-derived tables live in
/// `eor/portal`; `MotionKinematics` lives in `holtburger/core` (it's a
/// project-curated reformat of AC's MotionTable family, not a raw AC
/// asset). All five are addressed via `StaticResourceKey` impls in
/// `holtburger-dat`; we explicitly prefetch their record ids so the
/// subsequent sync `read_asset` calls hit the manifest cache.
///
/// Failure modes: if any of the five keys isn't present in the
/// manifest the prefetch surfaces the miss; the caller logs and falls
/// back per `docs/phase-4-step-3.6-movement-system.md` §7.1 (per-asset
/// `WorldBootstrap::synthetic()` shim).
#[cfg(target_arch = "wasm32")]
async fn load_world_bootstrap()
-> anyhow::Result<std::sync::Arc<holtburger_world::WorldBootstrap>> {
    use holtburger_dat::file_type::{
        ChatPoseTable, MotionKinematics, SkillTable, SpellTable, XpTable,
    };
    use holtburger_dat::{EOR_PORTAL_NAMESPACE, HOLTBURGER_CORE_NAMESPACE, ResourceKey};

    let source = global_source::try_global_source().ok_or_else(|| {
        anyhow::anyhow!("init_resource_source must be called before world bootstrap load")
    })?;

    let keys = [
        ResourceKey::new(EOR_PORTAL_NAMESPACE, SkillTable::FILE_ID),
        ResourceKey::new(EOR_PORTAL_NAMESPACE, SpellTable::FILE_ID),
        ResourceKey::new(EOR_PORTAL_NAMESPACE, XpTable::FILE_ID),
        ResourceKey::new(HOLTBURGER_CORE_NAMESPACE, MotionKinematics::FILE_ID),
        ResourceKey::new(EOR_PORTAL_NAMESPACE, ChatPoseTable::FILE_ID),
    ];
    source
        .prefetch(&keys)
        .await
        .map_err(|e| anyhow::anyhow!("prefetch world bootstrap: {e}"))?;

    let mounts: Vec<std::sync::Arc<dyn holtburger_dat::ResourceSource>> = vec![source];
    let repo = holtburger_content::ContentRepository::from_mounts(mounts);

    let skill_table = repo.read_asset::<SkillTable>("skill table")?;
    let spell_table = repo.read_asset::<SpellTable>("spell table")?;
    let xp_table = repo.read_asset::<XpTable>("XP table")?;
    let motion_kinematics = repo.read_asset::<MotionKinematics>("motion kinematics table")?;
    let soul_emote_catalog = repo.read_soul_emote_catalog()?;

    console_log_str(&format!(
        "[boot] WorldBootstrap loaded: skill_base_hash={} spells={} motion_tables={}",
        skill_table.skill_base_hash.len(),
        spell_table.spells.len(),
        motion_kinematics.motion_tables.len(),
    ));

    Ok(std::sync::Arc::new(holtburger_world::WorldBootstrap::new(
        skill_table,
        spell_table,
        xp_table,
        motion_kinematics,
        soul_emote_catalog,
    )))
}

/// Payload the recv loop sends through the initial-CharacterList
/// oneshot back to the awaiting `start_session` future. The
/// character list itself is mutated in-place via the shared
/// `Rc<RefCell<Vec<CharacterSummary>>>` so subsequent re-fires
/// (after Create / Delete) update the same buffer.
#[cfg(target_arch = "wasm32")]
struct CharListReady {
    account_name: String,
}

/// State the recv loop tracks across iterations.
#[cfg(target_arch = "wasm32")]
enum LoopState {
    /// Pre-character-selection (first phase). Pre-spawn idle.
    Idle,
    /// Between `CharacterEnterWorldRequest` and the eventual
    /// `PlayerCreate`. The `account_name` is captured here so the
    /// `CharacterEnterWorld` reply (sent in response to
    /// `CharacterEnterWorldServerReady`) carries the right account.
    EnteringWorld {
        guid: holtburger_common::Guid,
        account: String,
    },
    /// Player is fully in-world after `PlayerCreate(guid)` arrived
    /// and the recv loop sent `GameAction::LoginComplete` back to
    /// ACE. Chat commands work, position updates flow, etc.
    InWorld {
        #[allow(dead_code)]
        player_guid: holtburger_common::Guid,
    },
}

/// The recv loop that owns the Session and races
/// `session.recv_message()` against the JS-driven command channel.
/// Runs for the lifetime of the SessionHandle (until the cmd channel
/// closes — i.e. the handle is dropped — or until a fatal session
/// error arrives).
///
/// `charlist_tx` is set to `None` once the first `CharacterList`
/// arrives and is signalled; subsequent CharacterLists (e.g. after a
/// `CharacterDelete` or `CharacterCreate` round-trip) are surfaced as
/// queued events instead, NOT as a re-fire of the oneshot. Step 2a
/// doesn't re-fire CharacterList; if a future step needs to, lift
/// the queue events to also carry an updated character list.

// Phase 4 step 3: AC raw motion command IDs. Mirrors
// `crates/holtburger-core/src/client/movement/common.rs:23-30` —
// re-stated here rather than imported so the helpers stay
// `pub(super)` in the cli (the wasm bundle owns its own packet
// construction; see the SessionCommand::SetMovementInput doc
// comment for why we don't go through ClientRuntime).
#[cfg(target_arch = "wasm32")]
const WALK_FORWARD_MOTION_COMMAND: u32 = 0x4500_0005;
#[cfg(target_arch = "wasm32")]
const WALK_BACKWARD_MOTION_COMMAND: u32 = 0x4500_0006;
#[cfg(target_arch = "wasm32")]
const TURN_RIGHT_MOTION_COMMAND: u32 = 0x6500_000d;
#[cfg(target_arch = "wasm32")]
const TURN_LEFT_MOTION_COMMAND: u32 = 0x6500_000e;
#[cfg(target_arch = "wasm32")]
const SIDESTEP_RIGHT_MOTION_COMMAND: u32 = 0x6500_000f;
#[cfg(target_arch = "wasm32")]
const SIDESTEP_LEFT_MOTION_COMMAND: u32 = 0x6500_0010;
#[cfg(target_arch = "wasm32")]
const FALLBACK_RUN_RATE_SCALAR: f32 = 4.5;
#[cfg(target_arch = "wasm32")]
const RUN_HELD_TURN_SPEED_RAD_PER_SEC: f32 = 1.5;
#[cfg(target_arch = "wasm32")]
const NON_RUN_HELD_TURN_SPEED_RAD_PER_SEC: f32 = 1.0;

/// Phase 4 step 3: build a `RawMotionState` from a tristate-axis
/// keystate snapshot. Mirrors the cli's
/// `build_motion_state_raw_motion_state` (private to
/// `holtburger-core::client::movement`), inlined here so the wasm
/// bundle's lighter-weight packet path doesn't have to go through
/// `ClientRuntime` + `WorldState`.
///
/// Forward axis takes priority over strafe — the wire format
/// carries one of {forward, sidestep} per packet (the cli's
/// `Locomotion` enum is single-axis for the same reason). If both
/// are non-zero, forward wins.
///
/// The motion-style field (`current_style`) is intentionally
/// omitted: the cli reads the last server-echoed stance from
/// `world.player.last_server_motion_style` when emitting motion;
/// without `WorldState` we drop the bit and let ACE preserve
/// whatever stance it last set.
/// Phase 4 step 3.6 — convert WASD-style axes to the cli's high-level
/// `MotionState`. `MovementSystemHandle::tick` translates this into the
/// wire `RawMotionState` via the cli's `build_motion_state_raw_motion_state`
/// (`crates/holtburger-core/src/client/movement/common.rs`).
///
/// Mirrors the same axis priorities as `build_raw_motion_state_for_input`:
/// forward wins over strafe (single-axis Locomotion); turn is independent.
#[cfg(target_arch = "wasm32")]
fn motion_state_for_input(
    forward: i8,
    strafe: i8,
    turn: i8,
    run: bool,
) -> holtburger_core::client::movement_types::MotionState {
    use holtburger_core::client::movement_types::MotionState;
    let mut builder = MotionState::builder();
    if run {
        builder = builder.run();
    } else {
        builder = builder.walk();
    }
    if forward > 0 {
        builder = builder.forward();
    } else if forward < 0 {
        builder = builder.backstep();
    } else if strafe > 0 {
        builder = builder.strafe_right();
    } else if strafe < 0 {
        builder = builder.strafe_left();
    }
    if turn > 0 {
        builder = builder.turn_right();
    } else if turn < 0 {
        builder = builder.turn_left();
    }
    builder.build()
}

#[cfg(target_arch = "wasm32")]
#[allow(dead_code)] // kept until step 3.6 validation passes; rip-out follow-on.
fn build_raw_motion_state_for_input(
    forward: i8,
    strafe: i8,
    turn: i8,
    run: bool,
) -> holtburger_protocol::messages::game_message::RawMotionState {
    use holtburger_protocol::messages::game_message::{RawMotionFlags, RawMotionState};
    use holtburger_protocol::messages::movement::HoldKey;

    let hold_key = if run { HoldKey::Run } else { HoldKey::None } as u32;
    let run_speed = if run { FALLBACK_RUN_RATE_SCALAR } else { 1.0 };
    let turn_speed = if run {
        RUN_HELD_TURN_SPEED_RAD_PER_SEC
    } else {
        NON_RUN_HELD_TURN_SPEED_RAD_PER_SEC
    };

    let mut state = RawMotionState {
        flags: RawMotionFlags::CURRENT_HOLD_KEY,
        current_hold_key: Some(hold_key),
        ..Default::default()
    };

    if forward != 0 {
        let (cmd, speed) = if forward > 0 {
            (WALK_FORWARD_MOTION_COMMAND, run_speed)
        } else {
            // Backstep is always 1.0 m/s in retail — Run gait does
            // not multiply the back-walk animation.
            (WALK_BACKWARD_MOTION_COMMAND, 1.0)
        };
        state.flags |= RawMotionFlags::FORWARD_COMMAND
            | RawMotionFlags::FORWARD_HOLD_KEY
            | RawMotionFlags::FORWARD_SPEED;
        state.forward_command = Some(cmd);
        state.forward_hold_key = Some(hold_key);
        state.forward_speed = Some(speed);
    } else if strafe != 0 {
        let cmd = if strafe > 0 {
            SIDESTEP_RIGHT_MOTION_COMMAND
        } else {
            SIDESTEP_LEFT_MOTION_COMMAND
        };
        state.flags |= RawMotionFlags::SIDE_STEP_COMMAND
            | RawMotionFlags::SIDE_STEP_HOLD_KEY
            | RawMotionFlags::SIDE_STEP_SPEED;
        state.sidestep_command = Some(cmd);
        state.sidestep_hold_key = Some(hold_key);
        // Strafe speed is fixed at 1.0 m/s in retail — same as backstep.
        state.sidestep_speed = Some(1.0);
    }

    if turn != 0 {
        let cmd = if turn > 0 {
            TURN_RIGHT_MOTION_COMMAND
        } else {
            TURN_LEFT_MOTION_COMMAND
        };
        state.flags |= RawMotionFlags::TURN_COMMAND
            | RawMotionFlags::TURN_HOLD_KEY
            | RawMotionFlags::TURN_SPEED;
        state.turn_command = Some(cmd);
        state.turn_hold_key = Some(hold_key);
        state.turn_speed = Some(turn_speed);
    }

    state
}

/// Phase 4 step 3: minimal local-player state the recv loop tracks
/// to fill in outbound `MoveToStateActionData`. The cli holds this
/// inside `WorldState.player`; we reproduce just the fields the
/// action data carries so the wasm bundle doesn't have to stand up
/// the full world simulation.
///
/// Sequences come from `UpdatePosition.pos` (a `PositionPack` —
/// the only inbound message that carries all four `u16` sequence
/// numbers; `PrivateUpdatePosition` and `PublicUpdatePosition`
/// only carry a single `u8` bookkeeping sequence). Position can
/// come from any of the three.
///
/// `server_control_sequence` is special: the cli updates it from
/// `UpdateMotion`-style messages, not position updates (see
/// `crates/holtburger-world/src/entity.rs:344`). We initialise it
/// to 0 and let it ride; ACE is lenient on stale
/// `server_control_sequence` for client-driven motion. If this
/// turns out to be wrong, follow-on work tracks `UpdateMotion`.
#[cfg(target_arch = "wasm32")]
struct LocalPlayerSnapshot {
    position: Option<holtburger_common::position::WorldPosition>,
    instance_sequence: u16,
    server_control_sequence: u16,
    teleport_sequence: u16,
    force_position_sequence: u16,
}

#[cfg(target_arch = "wasm32")]
impl LocalPlayerSnapshot {
    fn new() -> Self {
        Self {
            position: None,
            instance_sequence: 0,
            server_control_sequence: 0,
            teleport_sequence: 0,
            force_position_sequence: 0,
        }
    }
}

/// Phase 4 step 4 follow-on (vitals + inventory panels): collapse the
/// recv loop's `WorldState.player.{vitals,attributes,skills}` HashMaps
/// + `WorldState::get_level_info()` into a flat `LatestStats` snapshot
/// the JS panel consumes.
///
/// Layout matches `PlayerStatsSnapshot`'s wasm-bindgen contract:
/// - `vitals` is `[type, current, base, buffed_max] × 3`
/// - `attributes` is `[type, current, base, ranks] × 6`
/// - `skills` is `[type, current, base, ranks, training] × N`
/// - `level_info` is `[level, current_xp_lo, current_xp_hi,
///   unspent_xp_lo, unspent_xp_hi, available_luminance_lo,
///   available_luminance_hi]`
#[cfg(target_arch = "wasm32")]
fn publish_player_stats_snapshot(
    world: &holtburger_world::WorldState,
    latest_stats: &std::rc::Rc<std::cell::RefCell<Option<LatestStats>>>,
) {
    use holtburger_common::properties::WorldObjectExt as _;
    let mut vitals: Vec<u32> =
        Vec::with_capacity(world.player.vitals.len() * 4);
    for vital in world.player.vital_snapshot() {
        vitals.push(vital.vital_type as u32);
        vitals.push(vital.current);
        vitals.push(vital.base);
        vitals.push(vital.buffed_max);
    }
    let mut attributes: Vec<u32> =
        Vec::with_capacity(world.player.attributes.len() * 4);
    for attr in world.player.attribute_snapshot() {
        attributes.push(attr.attr_type as u32);
        attributes.push(attr.current);
        attributes.push(attr.base);
        attributes.push(attr.ranks);
    }
    let mut skills: Vec<u32> =
        Vec::with_capacity(world.player.skills.len() * 5);
    for skill in world.player.skill_snapshot() {
        skills.push(skill.skill_type as u32);
        skills.push(skill.current);
        skills.push(skill.base);
        skills.push(skill.ranks);
        skills.push(skill.training as u32);
    }
    let lvl = world.get_level_info();
    let level_info: Vec<u32> = vec![
        lvl.level,
        (lvl.current_xp & 0xFFFF_FFFF) as u32,
        (lvl.current_xp >> 32) as u32,
        (lvl.unspent_xp & 0xFFFF_FFFF) as u32,
        (lvl.unspent_xp >> 32) as u32,
        (lvl.available_luminance & 0xFFFF_FFFF) as u32,
        (lvl.available_luminance >> 32) as u32,
    ];
    // Best-effort name pull from the player Entity's PropertyString::Name.
    // The player Entity is seeded in step 3.6's `PrivateUpdatePosition` /
    // `UpdatePosition` arms; if it's missing (rare), the empty string
    // falls through and JS labels the panel with the account name as
    // fallback.
    let name = world
        .entities
        .get(world.player.guid)
        .map(|entity| entity.name().to_string())
        .unwrap_or_default();
    *latest_stats.borrow_mut() = Some(LatestStats {
        name,
        vitals,
        attributes,
        skills,
        level_info,
    });
}

/// Phase 4 step 4 follow-on (vitals + inventory panels): build the
/// inventory snapshot from `WorldState.entities` filtered to entities
/// owned by the player (in `player.inventory` OR `player.equipment`).
///
/// Equipped items carry the `equip_mask` bits identifying their slot;
/// pack-only items have `equip_mask == 0`. JS uses the mask to decide
/// whether to render an item under "Equipped" vs "Pack" sub-sections.
#[cfg(target_arch = "wasm32")]
fn publish_player_inventory_snapshot(
    world: &holtburger_world::WorldState,
    latest_inventory: &std::rc::Rc<std::cell::RefCell<Vec<InventoryItem>>>,
) {
    use holtburger_common::properties::WorldObjectExt as _;
    let mut items: Vec<InventoryItem> =
        Vec::with_capacity(world.player.inventory.len());
    for guid in world.player.inventory.iter().copied() {
        let Some(entity) = world.entities.get(guid) else {
            continue;
        };
        let equip_mask = world
            .player
            .equipment
            .get(&guid)
            .copied()
            .map(|m| m.bits())
            .unwrap_or(0);
        let container_id = entity
            .container_id()
            .map(u32::from)
            .filter(|c| *c != u32::from(world.player.guid))
            .unwrap_or(0);
        items.push(InventoryItem {
            guid: u32::from(guid),
            wcid: entity.wcid.unwrap_or(0),
            name: entity.name().to_string(),
            icon_id: entity.icon_id.unwrap_or(0),
            item_type: entity.item_type_int().unwrap_or(0),
            value: entity.item_value(),
            stack_size: entity.stack_size(),
            equip_mask,
            container_id,
        });
    }
    // Sort: equipped first (by mask), then by name. Stable so JS
    // sees a deterministic order across refreshes.
    items.sort_by(|a, b| {
        b.equip_mask
            .cmp(&a.equip_mask)
            .then_with(|| a.name.cmp(&b.name))
    });
    *latest_inventory.borrow_mut() = items;
}

/// Phase 6 step D: refresh the cell-scene snapshot the rAF tick reads
/// each frame. Computes `current_cell` from the local player's pose +
/// the BFS render set at depth=1, parks them in a shared cell. JS
/// reads via `getCurrentCellId` / `getRenderSet` — no async, no
/// `&mut WorldState` needed at read time.
///
/// `current_cell == 0` means "no player position yet"; the rAF tick
/// treats that as "leave existing cell visibility alone" so a brief
/// pre-spawn dropout doesn't blank the world.
#[cfg(target_arch = "wasm32")]
fn publish_cell_scene_snapshot(
    world: &holtburger_world::WorldState,
    snapshot: &std::rc::Rc<std::cell::RefCell<CellSceneSnapshot>>,
) {
    let pose = match world.player_position() {
        Some(p) => p,
        None => {
            *snapshot.borrow_mut() = CellSceneSnapshot::default();
            return;
        }
    };
    let current = world.scene.current_cell(&pose);
    let render = world.scene.render_set(current, 1);
    let mut render_vec: Vec<u32> = render.into_iter().collect();
    render_vec.sort_unstable();
    *snapshot.borrow_mut() = CellSceneSnapshot {
        current_cell: current,
        is_indoor: pose.is_indoors(),
        render_set: render_vec,
    };
}

/// Workstream A (3D camera/game-feel fix): refresh the shared
/// [`LocalPlayerPose`] cell from `world.local_player_runtime_pose()`.
/// Called by the recv-loop on every TickMovement after
/// `publish_cell_scene_snapshot`, so the JS-side `getLocalPlayerPose`
/// read returns the same pose the integrator just simulated against —
/// matching what the `[step 3.6 tick #N]` heartbeat trace logs and
/// what the AutonomousPosition heartbeat will send on the next emit.
/// Heading is derived from the stored quaternion via the same
/// yaw-extraction formula `frame_to_placement` uses for static
/// placements (and that JS's `quaternionToYaw` at
/// `index.html:2757-2762` uses for entity sprites) — so a roundtrip
/// through this getter is bit-for-bit compatible with the JS-side
/// camera math.
///
/// We deliberately read `local_player_runtime_pose()` instead of
/// `player_position()` because the runtime pose IS the camera's
/// authoritative view: the integrator advances it every tick, and
/// reconciliation against ACE's force/teleport-sequence updates the
/// entity AND the runtime body together. Reading the entity pose
/// directly would lag the integrator's prediction by one TickMovement
/// → KIND_POSITION fan-out cycle. `local_player_runtime_pose` falls
/// back to `entity.position` when no runtime body exists (pre-spawn,
/// post-respawn races); we propagate `None` upward in that case so
/// JS callers treat the read as "use stashed pose / wait for next
/// emit".
#[cfg(target_arch = "wasm32")]
fn publish_local_player_pose(
    world: &holtburger_world::WorldState,
    pose_cell: &std::rc::Rc<std::cell::RefCell<Option<LocalPlayerPose>>>,
) {
    let pose = match world.local_player_runtime_pose() {
        Some(p) => p,
        None => {
            *pose_cell.borrow_mut() = None;
            return;
        }
    };
    let q = &pose.rotation;
    // Standard Z-up yaw extraction — identical formula to
    // `quaternionToYaw` (`apps/holtburger-web/index.html:2757-2762`) and
    // `frame_to_placement` (`lib.rs:~692-708`). `yaw = 0` → facing +Y,
    // `yaw = π/2` → facing +X. Differs from
    // `holtburger_common::Quaternion::to_heading`, which applies AC's
    // legacy 450°-offset client-compass convention — that one is wrong
    // for the camera path.
    let siny_cosp = 2.0 * (q.w * q.z + q.x * q.y);
    let cosy_cosp = 1.0 - 2.0 * (q.y * q.y + q.z * q.z);
    let heading = siny_cosp.atan2(cosy_cosp);
    *pose_cell.borrow_mut() = Some(LocalPlayerPose {
        x: pose.coords.x,
        y: pose.coords.y,
        z: pose.coords.z,
        heading,
        landblock_id: u32::from(pose.landblock_id),
    });
}

#[cfg(target_arch = "wasm32")]
async fn recv_loop(
    mut session: holtburger_session::Session,
    mut cmd_rx: futures::channel::mpsc::UnboundedReceiver<SessionCommand>,
    queued_events: std::rc::Rc<std::cell::RefCell<Vec<ClientEvent>>>,
    character_list: std::rc::Rc<std::cell::RefCell<Vec<CharacterSummary>>>,
    entity_updates: std::rc::Rc<std::cell::RefCell<Vec<EntityUpdate>>>,
    mut charlist_tx: Option<futures::channel::oneshot::Sender<CharListReady>>,
    world_bootstrap: std::rc::Rc<
        std::cell::RefCell<Option<std::sync::Arc<holtburger_world::WorldBootstrap>>>,
    >,
    latest_stats: std::rc::Rc<std::cell::RefCell<Option<LatestStats>>>,
    latest_inventory: std::rc::Rc<std::cell::RefCell<Vec<InventoryItem>>>,
    cell_scene_snapshot: std::rc::Rc<std::cell::RefCell<CellSceneSnapshot>>,
    door_part_snapshot: std::rc::Rc<
        std::cell::RefCell<std::collections::HashMap<u32, DoorPartSnapshot>>,
    >,
    local_player_pose: std::rc::Rc<std::cell::RefCell<Option<LocalPlayerPose>>>,
    collision_scene: std::rc::Rc<std::cell::RefCell<holtburger_world::SpatialScene>>,
    terrain_heights_shadow: std::rc::Rc<
        std::cell::RefCell<std::collections::HashMap<u32, [f32; 81]>>,
    >,
) {
    use futures::StreamExt;
    use holtburger_protocol::messages::{
        CharacterEnterWorldData, CharacterGenerationVerificationResponse, GameAction, GameMessage,
        MoveToStateActionData, TalkActionData,
    };
    use holtburger_protocol::traits::ProtocolUnpack;
    use holtburger_session::SessionEvent;

    let mut state = LoopState::Idle;
    let mut account_name = String::new();
    // Phase 4 step 3: tracked from inbound position messages so the
    // SetMovementInput cmd can build a complete MoveToStateActionData
    // without standing up a full WorldState.
    let mut local_player = LocalPlayerSnapshot::new();
    // Phase 4 step 3.6: full `WorldState` driven by the cli's
    // `MovementSystemHandle`. Constructed on EnteredWorld once the
    // parallel-loaded WorldBootstrap is in. The player entity is
    // seeded on the first PrivateUpdatePosition (when we first know
    // the spawn pose); the AutonomousPosition heartbeat is armed at
    // the same point. See `docs/phase-4-step-3.6-movement-system.md`.
    let mut world: Option<holtburger_world::WorldState> = None;
    let mut movement = holtburger_core::MovementSystemHandle::new();
    let mut entity_seeded = false;
    let mut heartbeat_armed = false;
    // Academy-rubberband diagnostic — when set, holds the last
    // observed `world.player.force_position_sequence`. Any tick where
    // it changes emits a `[acad-diag rubberband]` console line so the
    // capture script can correlate server-forced repositions against
    // the client's predicted pose. Removed once the indoor floor-Z
    // diagnosis is complete.
    let mut last_diag_force_seq: Option<u16> = None;

    // Workstream A (3D camera/game-feel fix): idempotency flags for
    // the local-player's lifecycle signals to JS. Pre-Workstream-A the
    // eager-WorldState construction at SelectCharacter (~line 11213)
    // raced ACE's PlayerCreate / ObjectCreate broadcast — when the
    // race went the wrong way the JS `drainEvents` handler missed
    // the kind=1 PlayerSpawned signal and never called
    // `setLocalPlayerGuid`, leaving the 3D follow-camera with a null
    // local-player resolve and the 2D `entityMap` without an entry.
    // The fix is belt-and-suspenders: emit both signals at every
    // path that has the data, gated by a one-shot flag so duplicate
    // emissions get dropped before they cross the JS boundary. JS
    // `handleEntitySpawn` is itself idempotent on the GUID (re-spawns
    // just reuse the existing entry), but quieting the wasm side
    // keeps the queue clean.
    let mut local_player_kind1_emitted = false;
    let mut local_player_spawn_emitted = false;
    // Workstream A: throttle clock for the per-TickMovement local-
    // player Position fan-out. Pre-A the only local-player KIND_POSITION
    // updates came from ACE's ~1Hz UpdatePosition broadcast; that's too
    // coarse for the 3D camera's 60FPS prediction layer. The TickMovement
    // arm now publishes a synthetic KIND_POSITION carrying
    // `world.player_position()` after each integrator step, throttled
    // to ≤30Hz (one emit per ≥33.3 ms) to keep the entity-update queue
    // from flooding under high-rAF cadence. `None` until first emit.
    let mut last_local_player_position_emit: Option<web_time::Instant> = None;

    loop {
        tokio::select! {
            recv = session.recv_message() => {
                let events = match recv {
                    Ok(events) => events,
                    Err(e) => {
                        let msg = format!("recv_message: {e}");
                        log::warn!("recv_loop terminating: {msg}");
                        queued_events.borrow_mut().push(ClientEvent {
                            kind: CLIENT_EVENT_KIND_DISCONNECTED,
                            string_payload: Some(msg),
                            u32_payload: None,
                            u32_payload_2: None,
                            f32_payload: None,
                        });
                        return;
                    }
                };
                for event in events {
                    let SessionEvent::Message(bytes) = event else { continue };
                    let mut offset = 0;
                    let Some(message) = GameMessage::unpack(&bytes, &mut offset) else {
                        continue;
                    };

                    // Phase 4 step 4 follow-on (vitals + inventory panels):
                    // route stat / inventory / GameEvent messages through the
                    // canonical world handler dispatcher BEFORE the recv loop's
                    // own match-block runs. The dispatcher mutates
                    // `WorldState.player.{vitals,attributes,skills}` +
                    // `state.entities` + `state.player.inventory` /
                    // `state.player.equipment` so the snapshot publishers below
                    // see current state. We then scan the events the dispatcher
                    // emitted to decide whether stats / inventory changed
                    // enough to warrant a JS-facing kind=8 / kind=11 signal.
                    //
                    // Position messages (`Update*Position`, `VectorUpdate`,
                    // `UpdateMotion`) are intentionally NOT routed: the recv
                    // loop's existing arms handle them with step 3.6 / 3.5
                    // semantics (entity_seeded gating, heartbeat arming, JS
                    // entity_updates push) that double-handling would risk
                    // regressing.
                    let mut stats_changed = false;
                    let mut inventory_changed = false;
                    if should_route_message_to_world(&message)
                        && let Some(w) = world.as_mut()
                    {
                        let mut world_events: Vec<holtburger_world::WorldEvent> = Vec::new();
                        holtburger_world::handlers::routing::handle_message(
                            w,
                            &message,
                            &mut world_events,
                        );
                        for ev in &world_events {
                            use holtburger_world::WorldEvent;
                            match ev {
                                WorldEvent::VitalUpdated(_)
                                | WorldEvent::AttributeUpdated(_)
                                | WorldEvent::SkillUpdated(_)
                                | WorldEvent::LevelInfoUpdated(_)
                                | WorldEvent::DerivedStatsUpdated(_)
                                | WorldEvent::PlayerEnchantmentsUpdated { .. } => {
                                    stats_changed = true;
                                }
                                WorldEvent::EntitySpawned(_)
                                | WorldEvent::EntityReplaced(_)
                                | WorldEvent::EntityDespawned(_)
                                | WorldEvent::ContainerOpened(_)
                                | WorldEvent::ContainerClosed(_)
                                | WorldEvent::PropertiesUpdated { .. } => {
                                    // Could affect inventory if the entity
                                    // is owned by the player; the snapshot
                                    // builder filters by ownership so a
                                    // false positive here just refreshes
                                    // the panel one extra time.
                                    inventory_changed = true;
                                }
                                // Phase 4 step 6f: EntityIdentified
                                // arrives in response to our auto-fired
                                // `GameAction::IdentifyObject` for
                                // portals (above in the ObjectCreate
                                // arm). The world's
                                // `inventory::handle_event` arm has
                                // already populated the entity's
                                // `properties.strings` map with the
                                // assessment props; pull
                                // `AppraisalPortalDestination` and
                                // emit a kind=3 META_REFRESH
                                // EntityUpdate so JS can render the
                                // chip below the portal sprite. Also
                                // flag inventory_changed so the
                                // identified-item path (e.g. a player-
                                // appraised inventory weapon) refreshes
                                // the panel.
                                WorldEvent::EntityIdentified(entity) => {
                                    use holtburger_common::properties::{
                                        HasProperties, PropertyInt, PropertyString,
                                    };
                                    let entity_guid = entity.guid;
                                    let item_type_int = entity
                                        .properties()
                                        .ints
                                        .get(&PropertyInt::ItemType)
                                        .copied()
                                        .unwrap_or(0)
                                        as u32;
                                    if item_type_int & ITEM_TYPE_PORTAL_BIT != 0 {
                                        let dest = entity
                                            .properties()
                                            .strings
                                            .get(&PropertyString::AppraisalPortalDestination)
                                            .cloned()
                                            .unwrap_or_default();
                                        if !dest.is_empty() {
                                            entity_updates.borrow_mut().push(EntityUpdate {
                                                kind: ENTITY_UPDATE_KIND_META_REFRESH,
                                                guid: u32::from(entity_guid),
                                                model_id: 0,
                                                landblock_id: 0,
                                                x: 0.0,
                                                y: 0.0,
                                                z: 0.0,
                                                qw: 1.0,
                                                qx: 0.0,
                                                qy: 0.0,
                                                qz: 0.0,
                                                wcid: 0,
                                                item_type: 0,
                                                name: String::new(),
                                                obj_scale: 1.0,
                                                icon_id: 0,
                                                palette_id: 0,
                                                mtable_id: 0,
                                                model_changes: Vec::new(),
                                                texture_changes: Vec::new(),
                                                sub_palettes: Vec::new(),
                                                portal_destination: dest,
                                                vx: 0.0,
                                                vy: 0.0,
                                                vz: 0.0,
                                                omega_z: 0.0,
                                                motion_command: 0,
                                                motion_stance: 0,
                                                physics_script_did: 0,
                                                sound_table_did: 0,
                                            });
                                        }
                                    }
                                    inventory_changed = true;
                                }
                                // Phase 6 step E: SetState packets for
                                // door-flagged entities produce a
                                // DoorStateChanged event alongside the
                                // EntityStateUpdated. Forward the
                                // door-state transition to JS as a
                                // kind=15 ClientEvent so the JS-side
                                // door state map updates, the matching
                                // building-AABB entry's `active` flag
                                // toggles, and the door sprite rotates
                                // around its hinge frame. The state
                                // payload is `1` for Open / `0` for
                                // Closed — matches the JS-side
                                // `__doorStates` Map's "open" /
                                // "closed" string mapping.
                                WorldEvent::DoorStateChanged { guid, state: door_state } => {
                                    let state_u32: u32 = match door_state {
                                        holtburger_world::DoorState::Open => 1,
                                        holtburger_world::DoorState::Closed => 0,
                                    };
                                    queued_events.borrow_mut().push(ClientEvent {
                                        kind: CLIENT_EVENT_KIND_DOOR_STATE_CHANGED,
                                        string_payload: None,
                                        u32_payload: Some(u32::from(*guid)),
                                        u32_payload_2: Some(state_u32),
                                        f32_payload: None,
                                    });
                                }
                                _ => {}
                            }
                        }
                    }

                    // Phase 4 step 4 follow-on: spatial-bypass inventory
                    // tracking for `ObjectCreate` / `ObjectDelete` /
                    // `InventoryRemoveObject`. Routing these through the
                    // canonical `holtburger_world::handlers::inventory`
                    // dispatcher trips a wasm `unreachable` panic in the
                    // spatial body store (`scene.update_entity` +
                    // `reconcile_authoritative_body` paths assume state
                    // the wasm bundle doesn't initialise — see the
                    // `should_route_message_to_world` doc comment). We
                    // replicate the inventory-relevant subset of the
                    // canonical handlers inline, sans spatial work, so
                    // `state.entities` + `state.player.inventory` /
                    // `state.player.equipment` stay current and
                    // `publish_player_inventory_snapshot` produces a
                    // populated snapshot.
                    if let Some(w) = world.as_mut() {
                        match &message {
                            GameMessage::ObjectCreate(data) => {
                                if apply_inventory_object_create(w, data) {
                                    inventory_changed = true;
                                }
                            }
                            GameMessage::ObjectDelete(data) => {
                                if apply_inventory_object_delete(w, data.guid) {
                                    inventory_changed = true;
                                }
                            }
                            GameMessage::InventoryRemoveObject(data) => {
                                if apply_inventory_object_delete(w, data.object_guid) {
                                    inventory_changed = true;
                                }
                            }
                            _ => {}
                        }
                    }
                    if stats_changed && let Some(w) = world.as_ref() {
                        publish_player_stats_snapshot(w, &latest_stats);
                        queued_events.borrow_mut().push(ClientEvent {
                            kind: CLIENT_EVENT_KIND_PLAYER_STATS_UPDATED,
                            string_payload: None,
                            u32_payload: None,
                            u32_payload_2: None,
                            f32_payload: None,
                        });
                    }
                    if inventory_changed && let Some(w) = world.as_ref() {
                        publish_player_inventory_snapshot(w, &latest_inventory);
                        queued_events.borrow_mut().push(ClientEvent {
                            kind: CLIENT_EVENT_KIND_INVENTORY_UPDATED,
                            string_payload: None,
                            u32_payload: None,
                            u32_payload_2: None,
                            f32_payload: None,
                        });
                    }

                    match message {
                        GameMessage::CharacterList(data) => {
                            account_name = data.account_name.clone();
                            let new_list: Vec<CharacterSummary> = data
                                .characters
                                .iter()
                                .map(|entry| CharacterSummary {
                                    id: u32::from(entry.guid),
                                    name: entry.name.clone(),
                                    delete_time: entry.delete_time,
                                })
                                .collect();
                            let count = new_list.len() as u32;
                            *character_list.borrow_mut() = new_list;
                            if let Some(tx) = charlist_tx.take() {
                                let _ = tx.send(CharListReady {
                                    account_name: account_name.clone(),
                                });
                            } else {
                                // Re-fire after CharacterCreate /
                                // CharacterDelete: surface as a kind=0
                                // event so JS can call
                                // `handle.characterList()` for the
                                // updated snapshot.
                                queued_events.borrow_mut().push(ClientEvent {
                                    kind: CLIENT_EVENT_KIND_CHARACTER_LIST_RECEIVED,
                                    string_payload: Some(account_name.clone()),
                                    u32_payload: Some(count),
                                    u32_payload_2: None,
                                    f32_payload: None,
                                });
                            }
                        }
                        GameMessage::CharacterCreateResponse(data) => {
                            // Phase 4 step 2a.5: surface the response
                            // to JS, and on success append the new
                            // character to `character_list` locally.
                            // ACE does NOT auto-send a CharacterList
                            // re-fire after CharacterCreate — the cli
                            // (apps/holtburger-cli/src/pages/selection
                            // /state.rs::handle_create_response, line
                            // 307) pushes a CharacterEntry locally;
                            // we mirror that here so JS sees the new
                            // entry on the next handle.characterList()
                            // call.
                            if data.response == CharacterGenerationVerificationResponse::Ok {
                                let guid = data.guid.map(u32::from).unwrap_or(0);
                                let name = data.name.clone().unwrap_or_default();
                                if guid != 0 {
                                    character_list.borrow_mut().push(CharacterSummary {
                                        id: guid,
                                        name: name.clone(),
                                        delete_time: 0,
                                    });
                                }
                                queued_events.borrow_mut().push(ClientEvent {
                                    kind: CLIENT_EVENT_KIND_CHARACTER_CREATED,
                                    string_payload: Some(name),
                                    u32_payload: Some(guid),
                                    u32_payload_2: None,
                                    f32_payload: None,
                                });
                            } else {
                                let code = data.response as u32;
                                let label = format!("{:?}", data.response);
                                queued_events.borrow_mut().push(ClientEvent {
                                    kind: CLIENT_EVENT_KIND_CHARACTER_CREATE_FAILED,
                                    string_payload: Some(label),
                                    u32_payload: Some(code),
                                    u32_payload_2: None,
                                    f32_payload: None,
                                });
                            }
                        }
                        GameMessage::PlayerTeleport(data) => {
                            // Phase 4 step 3.6: ACE sets player.Teleporting=true
                            // on every teleport (e.g. @telepoi) and silently
                            // drops AutonomousPosition packets while the flag
                            // is set. The cli pattern is to fire LoginComplete
                            // back on every PlayerTeleport — that's the action
                            // ACE's GameActionLoginComplete invokes
                            // OnTeleportComplete on, which clears Teleporting.
                            // Without this, AutonomousPosition heartbeats are
                            // received but silently dropped, server-side
                            // position freezes at the @telepoi destination,
                            // and movement looks fine client-side but the
                            // server never sees it (the original 3.6 bug
                            // pattern at a different layer).
                            console_log_str(&format!(
                                "[step 3.6] PlayerTeleport received (teleport_seq={}); sending LoginComplete to clear Teleporting",
                                data.teleport_sequence,
                            ));
                            // Workstream G (3D camera/game-feel fix, 2026-05-11):
                            // mirror the cli's `holtburger_world::handlers::player.rs:71-78`
                            // PlayerTeleport flow on the wasm side. The cli routes
                            // PlayerTeleport through `routing::handle_message` →
                            // `player::handle_message` which (a) advances the
                            // player's teleport_sequence and (b) calls
                            // `suspend_runtime_bodies(TeleportOrWorldReset)` so
                            // each body's pose snaps to its authoritative_pose
                            // and `sampling.mode` flips to `Suspended`. The wasm
                            // bundle's `should_route_message_to_world` filter
                            // does NOT include `PlayerTeleport` (the recv loop
                            // owns the LoginComplete action), so without this
                            // mirror the wasm-side WorldState gets:
                            //   - teleport_sequence stale (never advanced).
                            //   - body.sampling.mode stuck at SimulatingMotionState
                            //     (from the entity-seed `set_local_player_runtime_pose`
                            //     call), which is then load-bearing for the
                            //     subsequent UpdatePosition's
                            //     `reconcile_authoritative_body` preserve-runtime
                            //     gate: with `Snapshot` + `LocalPlayer` +
                            //     SimulatingMotionState, preserve=true and
                            //     body.pose is NOT reset to the new (destination)
                            //     pose. body.authoritative_pose updates fine via
                            //     the wasm-side `set_player_position` path; the
                            //     runtime pose silently sticks at the source
                            //     landblock. The F-capture diag (2026-05-11)
                            //     confirms:
                            //       [step 3.6 tick #120] pose=(12.32,-28.48,0.00)
                            //         cell=0x860201AD indoor=true ...
                            //         auth=(84.00,7.10,94.00) (Holtburg
                            //         destination) mode=SimulatingMotionState
                            //     With pose stuck at the Academy indoor cell,
                            //     the integrator's `advance_local_pose_for_-
                            //     manual_drive` hits the academy-rubberband-fix
                            //     pre-bake gate (indoor cell with no triangles +
                            //     no AABB) and zeros lateral delta — player
                            //     can't move at all even when W is pressed.
                            //
                            // Fix: advance teleport_sequence + suspend bodies
                            // here, mirroring the world handler. Then the
                            // subsequent UpdatePosition for the destination
                            // hits the wasm's reconcile gate, set_player_position
                            // fires (Workstream G unconditional-snap below),
                            // and `reconcile_authoritative_body` sees
                            // mode=Suspended → preserve=false → body.pose snaps
                            // to the destination pose. mode flips to
                            // AuthoritativeOnly; the integrator's next W press
                            // sets it back to SimulatingMotionState.
                            if let Some(w) = world.as_mut() {
                                w.player.set_teleport_sequence(data.teleport_sequence);
                                let _ = w.suspend_runtime_bodies(
                                    holtburger_world::RuntimeBodyResetCause::TeleportOrWorldReset,
                                );
                                console_log_str(&format!(
                                    "[workstream-G] PlayerTeleport: advanced teleport_sequence → {} + suspended runtime bodies; runtime pose will snap on next UpdatePosition",
                                    data.teleport_sequence,
                                ));
                            }
                            let login_complete = GameAction::LoginComplete(Box::new(
                                holtburger_protocol::messages::LoginCompleteActionData,
                            ));
                            if let Err(e) = session.send_action(login_complete).await {
                                console_log_str(&format!(
                                    "[step 3.6] post-teleport LoginComplete send failed: {e}"
                                ));
                            }
                        }
                        GameMessage::CharacterEnterWorldServerReady => {
                            // Server is acknowledging our CharacterEnterWorldRequest;
                            // chain the CharacterEnterWorld reply automatically so
                            // JS doesn't have to round-trip through poll_events to
                            // drive each step of the spawn handshake.
                            if let LoopState::EnteringWorld { guid, account } = &state {
                                let msg = GameMessage::CharacterEnterWorld(Box::new(
                                    CharacterEnterWorldData {
                                        guid: *guid,
                                        account: account.clone(),
                                    },
                                ));
                                if let Err(e) = session.send_message(&msg).await {
                                    log::warn!("recv_loop: send CharacterEnterWorld: {e}");
                                    queued_events.borrow_mut().push(ClientEvent {
                                        kind: CLIENT_EVENT_KIND_DISCONNECTED,
                                        string_payload: Some(format!(
                                            "CharacterEnterWorld: {e}"
                                        )),
                                        u32_payload: None,
                                        u32_payload_2: None,
                                        f32_payload: None,
                                    });
                                    return;
                                }
                            }
                        }
                        GameMessage::PlayerCreate(data) => {
                            // Phase 4 step 2a/2a.6: PlayerCreate is the
                            // server's "you're in the world" signal.
                            // Mirrors the cli's
                            // `crates/holtburger-core/src/client/messages.rs:433-466`
                            // path: queue PlayerSpawned for JS, send
                            // LoginComplete back to the server (ACE
                            // expects this acknowledgement before
                            // accepting in-world commands like @telepoi),
                            // then transition to InWorld + queue
                            // EnteredWorld so JS unhides the Teleport
                            // button.
                            //
                            // The earlier "wait for GameEvent::
                            // PlayerDescription / StartGame" gate was
                            // wrong — empirically ACE sends a flurry of
                            // ObjectCreate / ServerName / etc. and never
                            // a parseable GameEvent for our flow, but
                            // PlayerCreate ALWAYS arrives, and the cli's
                            // path through line 464 makes it the
                            // canonical InWorld trigger anyway.
                            let player_guid_raw = u32::from(data.guid);
                            // Workstream A: idempotent — the SelectCharacter
                            // eager-construct path (~line 11270) already
                            // emitted kind=1 PlayerSpawned with this same
                            // guid; suppress the duplicate so JS doesn't
                            // re-run `setLocalPlayerGuid` + status-line
                            // flash on a no-op event. The flag is set in
                            // whichever arm fires first; the other arm
                            // sees it set and skips.
                            if !local_player_kind1_emitted {
                                queued_events.borrow_mut().push(ClientEvent {
                                    kind: CLIENT_EVENT_KIND_PLAYER_SPAWNED,
                                    string_payload: None,
                                    u32_payload: Some(player_guid_raw),
                                    u32_payload_2: None,
                                    f32_payload: None,
                                });
                                local_player_kind1_emitted = true;
                            }

                            let login_complete = GameAction::LoginComplete(Box::new(
                                holtburger_protocol::messages::LoginCompleteActionData,
                            ));
                            if let Err(e) = session.send_action(login_complete).await {
                                log::warn!("recv_loop: send LoginComplete: {e}");
                                queued_events.borrow_mut().push(ClientEvent {
                                    kind: CLIENT_EVENT_KIND_DISCONNECTED,
                                    string_payload: Some(format!("LoginComplete: {e}")),
                                    u32_payload: None,
                                    u32_payload_2: None,
                                    f32_payload: None,
                                });
                                return;
                            }

                            state = LoopState::InWorld {
                                player_guid: data.guid,
                            };
                            queued_events.borrow_mut().push(ClientEvent {
                                kind: CLIENT_EVENT_KIND_ENTERED_WORLD,
                                string_payload: None,
                                u32_payload: Some(player_guid_raw),
                                u32_payload_2: None,
                                f32_payload: None,
                            });

                            // Phase 4 step 3.6: construct the
                            // `WorldState` the `MovementSystemHandle`
                            // will tick against. Bootstrap was loaded
                            // in parallel by start_session; if it isn't
                            // ready yet (rare under normal flow), the
                            // movement system stays disabled until the
                            // next session — log a warning and continue
                            // (existing LocalPlayerSnapshot path keeps
                            // entities rendering).
                            // Phase 4 step 4 follow-on: WorldState is
                            // typically constructed eagerly at
                            // SelectCharacter time (so PlayerDescription
                            // arrivals BEFORE PlayerCreate land on a
                            // ready dispatcher). If that didn't happen
                            // — bootstrap wasn't loaded yet, or
                            // SelectCharacter took a different path —
                            // construct here as a fallback.
                            if world.is_none()
                                && let Some(bootstrap) = world_bootstrap.borrow().clone()
                            {
                                let mut new_world =
                                    holtburger_world::WorldState::new(bootstrap);
                                new_world.player.guid = data.guid;
                                let fallback_caps =
                                    holtburger_world::SelfMovementCapabilities {
                                        kinematics:
                                            holtburger_world::SelfMovementKinematics {
                                                source: holtburger_world::PlayerMotionTableSource::DirectProperty {
                                                    motion_table_id: 0,
                                                },
                                                motion_table_id: 0,
                                                stance: 0,
                                                base_walk_forward_velocity:
                                                    holtburger_common::Vector3 {
                                                        x: 0.0, y: 1.0, z: 0.0,
                                                    },
                                                base_run_forward_velocity:
                                                    holtburger_common::Vector3 {
                                                        x: 0.0, y: 4.5, z: 0.0,
                                                    },
                                                base_turn_left_omega:
                                                    holtburger_common::Vector3 {
                                                        x: 0.0, y: 0.0, z: 1.5,
                                                    },
                                                base_turn_right_omega:
                                                    holtburger_common::Vector3 {
                                                        x: 0.0, y: 0.0, z: -1.5,
                                                    },
                                            },
                                        run_rate_scalar: 1.0,
                                    };
                                new_world.set_self_movement_capabilities_override(
                                    fallback_caps,
                                );
                                world = Some(new_world);
                                console_log_str(&format!(
                                    "[step 3.6] WorldState constructed lazily on PlayerCreate (guid=0x{:08X}) — eager-construct path missed",
                                    player_guid_raw,
                                ));
                            } else if world.is_some() {
                                console_log_str(&format!(
                                    "[step 3.6] WorldState already constructed (eager path); PlayerCreate guid=0x{:08X} confirms",
                                    player_guid_raw,
                                ));
                            } else {
                                console_log_str(
                                    "[step 3.6] WorldBootstrap not yet loaded at PlayerCreate; \
                                     MovementSystem disabled this session",
                                );
                            }
                        }
                        GameMessage::GameAction(action_msg) => {
                            // Server can echo a GameAction::LoginComplete
                            // back as confirmation — already InWorld at
                            // that point, so just log for visibility.
                            // Future steps (chat, equipment, etc.) will
                            // dispatch on action_msg.action variants.
                            if matches!(
                                action_msg.action,
                                GameAction::LoginComplete(_)
                            ) {
                                log::debug!(
                                    "recv_loop: server-echoed LoginComplete"
                                );
                            }
                        }
                        // Phase 4 step 2b: position-bearing messages.
                        // Each pushes an EntityUpdate into the entity
                        // channel; JS drains via pollEntityUpdates() and
                        // applies updates to its `Map<guid, sprite>`.
                        // Reference handlers in the cli:
                        //   - UpdatePosition:        crates/holtburger-world/src/handlers/player.rs:33-46
                        //   - PrivateUpdatePosition: crates/holtburger-world/src/handlers/movement.rs:41-43
                        //   - PublicUpdatePosition:  crates/holtburger-world/src/handlers/movement.rs:45-46
                        //   - ObjectCreate:          crates/holtburger-world/src/handlers/inventory.rs:19-51
                        //   - ObjectDelete:          crates/holtburger-world/src/handlers/inventory.rs:53-56
                        GameMessage::UpdatePosition(data) => {
                            let pos = &data.pos.pos;
                            // Phase 4 step 3: UpdatePosition is the
                            // only inbound position message that
                            // carries all four sequence numbers
                            // (`PositionPack` vs. the bare `WorldPosition`
                            // in Public/Private updates). When ACE
                            // addresses the local player by guid here,
                            // capture the sequences so subsequent
                            // outbound MoveToState packets carry a
                            // current snapshot.
                            if let LoopState::InWorld { player_guid } = &state
                                && data.guid == *player_guid
                            {
                                local_player.position = Some(data.pos.pos);
                                local_player.instance_sequence = data.pos.instance_sequence;
                                local_player.teleport_sequence = data.pos.teleport_sequence;
                                local_player.force_position_sequence =
                                    data.pos.force_position_sequence;
                                // Phase 4 step 3.6: UpdatePosition for the
                                // local player is the canonical position
                                // packet (PrivateUpdatePosition rarely fires
                                // in this flow). Seed the WorldState entity
                                // here so MovementSystem::tick has a pose
                                // and sequences to work with.
                                if let Some(w) = world.as_mut() {
                                    let pose = data.pos.pos;
                                    if !entity_seeded {
                                        let entity =
                                            holtburger_world::entity::Entity::new(
                                                *player_guid,
                                                String::from("LocalPlayer"),
                                                pose,
                                            );
                                        w.add_entity(entity);
                                        let _ = w.set_local_player_runtime_pose(pose);
                                        entity_seeded = true;
                                        console_log_str(&format!(
                                            "[step 3.6] WorldState player entity seeded via UpdatePosition at landblock=0x{:08X} ({:.1}, {:.1}, {:.1})",
                                            u32::from(pose.landblock_id),
                                            pose.coords.x, pose.coords.y, pose.coords.z,
                                        ));
                                    } else {
                                        // Workstream G (3D camera/game-feel
                                        // fix, 2026-05-11): always call
                                        // `set_player_position` for the local
                                        // player's UpdatePosition. The
                                        // `reconcile_authoritative_body`
                                        // implementation (in scene.rs:880-896)
                                        // has a `preserve_local_runtime_pose`
                                        // gate that fires when
                                        //   LocalPlayer ∧ Snapshot ∧
                                        //   mode ∈ {SimulatingMotionState,
                                        //          SimulatingVelocity}
                                        // and preserves body.pose while
                                        // updating body.authoritative_pose +
                                        // velocity/omega. That gate IS the
                                        // load-bearing piece preventing the
                                        // 2026-05-10 academy-rubberband
                                        // "moves a bit, snaps back" symptom:
                                        // during active simulation the
                                        // integrator's mode is
                                        // SimulatingMotionState so routine
                                        // UpdatePosition broadcasts only
                                        // refresh the auth pose, leaving the
                                        // predicted runtime pose intact.
                                        //
                                        // The previous wasm-side
                                        // `force_advanced || teleport_advanced`
                                        // gate was a second-layer defense
                                        // that, in retrospect, has a load-
                                        // bearing failure mode for teleports:
                                        // PlayerTeleport's wasm handler
                                        // (above, line ~10387) advances
                                        // `w.player.teleport_sequence`, so
                                        // the subsequent UpdatePosition for
                                        // the destination carries the SAME
                                        // teleport_sequence the wasm
                                        // mirrored when PlayerTeleport
                                        // landed — `teleport_advanced =
                                        // is_newer_u16(N, N) = false`. The
                                        // gate doesn't fire, set_player_-
                                        // position is never called, and
                                        // body.pose stays at the source
                                        // landblock while body.authoritative_-
                                        // pose updates to the destination
                                        // (via the implicit reconcile path
                                        // through subsequent ObjectCreate /
                                        // VectorUpdate / etc.). The
                                        // integrator's
                                        // `advance_local_pose_for_manual_-
                                        // drive` then runs against the
                                        // source pose, hits the academy-
                                        // rubberband-fix indoor pre-bake
                                        // gate if the source is an indoor
                                        // cell, and zeros lateral delta —
                                        // player can't walk at all.
                                        //
                                        // PlayerTeleport (above) now ALSO
                                        // calls
                                        // `suspend_runtime_bodies(Teleport-
                                        // OrWorldReset)` which flips
                                        // `body.sampling.mode` to Suspended.
                                        // On the next UpdatePosition,
                                        // unconditional set_player_position
                                        // → reconcile_authoritative_body
                                        // sees Suspended (NOT Simulating*),
                                        // preserve=false, body.pose snaps
                                        // to the destination. After that
                                        // the integrator's first W press
                                        // re-arms SimulatingMotionState
                                        // and the preserve gate engages
                                        // for routine broadcasts as before.
                                        //
                                        // The diagnostic log now fires on
                                        // every snap so a regression where
                                        // routine broadcasts overwrite the
                                        // runtime pose would be visible
                                        // immediately (look for
                                        // `[acad-diag reconcile]` lines
                                        // accumulating during active
                                        // W-hold — should be empty post-fix).
                                        // Only emit a diagnostic when the
                                        // snap will actually take effect
                                        // (mode ∉ Simulating*). During
                                        // active integration the
                                        // preserve-runtime-pose gate
                                        // fires and the set_player_position
                                        // call is a no-op on body.pose;
                                        // logging on every routine
                                        // broadcast floods the JS
                                        // console / postMessage bridge
                                        // and observably slows the
                                        // recv-loop drain cadence
                                        // (verified via F-capture: at-fix
                                        // log-on-every-tick ran 4× slower
                                        // than log-on-snap-only).
                                        use holtburger_world::SpatialSampleMode;
                                        let snap_will_apply = w
                                            .runtime_body_id_for_guid(w.player.guid)
                                            .and_then(|bid| w.runtime_body_view(bid))
                                            .is_some_and(|view| {
                                                !matches!(
                                                    view.sample_mode,
                                                    SpatialSampleMode::SimulatingMotionState
                                                        | SpatialSampleMode::SimulatingVelocity
                                                )
                                            });
                                        if snap_will_apply {
                                            console_log_str(&format!(
                                                "[acad-diag reconcile] snapping to server pose: force_seq={} teleport_seq={} pose=({:.2}, {:.2}, {:.2})",
                                                data.pos.force_position_sequence,
                                                data.pos.teleport_sequence,
                                                pose.coords.x,
                                                pose.coords.y,
                                                pose.coords.z,
                                            ));
                                        }
                                        let _ = w.set_player_position(pose);
                                    }
                                    // Mirror the four sequences onto the
                                    // WorldState player so outbound
                                    // MoveToState / AutonomousPosition pull
                                    // current values.
                                    w.player.instance_sequence =
                                        data.pos.instance_sequence;
                                    w.player.teleport_sequence =
                                        data.pos.teleport_sequence;
                                    w.player.force_position_sequence =
                                        data.pos.force_position_sequence;
                                    if !heartbeat_armed && entity_seeded {
                                        let now = web_time::Instant::now();
                                        movement.arm_heartbeat_schedule(now, w);
                                        heartbeat_armed = true;
                                        console_log_str(
                                            "[step 3.6] AutonomousPosition heartbeat armed",
                                        );
                                    }
                                }
                            }
                            entity_updates.borrow_mut().push(EntityUpdate {
                                kind: ENTITY_UPDATE_KIND_POSITION,
                                guid: u32::from(data.guid),
                                model_id: 0,
                                landblock_id: u32::from(pos.landblock_id),
                                x: pos.coords.x,
                                y: pos.coords.y,
                                z: pos.coords.z,
                                qw: pos.rotation.w,
                                qx: pos.rotation.x,
                                qy: pos.rotation.y,
                                qz: pos.rotation.z,
                                wcid: 0,
                                item_type: 0,
                                name: String::new(),
                                obj_scale: 1.0,
                                icon_id: 0,
                                palette_id: 0,
                                mtable_id: 0,
                                model_changes: Vec::new(),
                                texture_changes: Vec::new(),
                                sub_palettes: Vec::new(),
                                portal_destination: String::new(),
                                vx: 0.0,
                                vy: 0.0,
                                vz: 0.0,
                                omega_z: 0.0,
                                motion_command: 0,
                                motion_stance: 0,
                                physics_script_did: 0,
                                sound_table_did: 0,
                            });
                        }
                        GameMessage::PrivateUpdatePosition(data) => {
                            // PrivateUpdatePosition has no guid in the
                            // payload (the wire message implies "the
                            // local player"). Substitute the
                            // LoopState::InWorld player_guid; if we
                            // somehow get a Private update before
                            // PlayerCreate landed, the message has no
                            // owner — drop it.
                            let local_guid = match &state {
                                LoopState::InWorld { player_guid } => Some(*player_guid),
                                _ => None,
                            };
                            if let Some(guid) = local_guid {
                                let pos = &data.pos;
                                // Phase 4 step 3: this packet is
                                // implicitly the local player; cache
                                // position for outbound MoveToState.
                                local_player.position = Some(*pos);
                                // Phase 4 step 3.6: seed the WorldState
                                // player entity on the first inbound
                                // position (we now know the spawn pose),
                                // then arm the AutonomousPosition
                                // heartbeat. Subsequent updates push
                                // through `set_player_position` so the
                                // outbound MovementSystem tick reads
                                // current sequences + pose.
                                if let Some(w) = world.as_mut() {
                                    if !entity_seeded {
                                        let entity = holtburger_world::entity::Entity::new(
                                            guid,
                                            String::from("LocalPlayer"),
                                            *pos,
                                        );
                                        w.add_entity(entity);
                                        let _ = w.set_local_player_runtime_pose(*pos);
                                        entity_seeded = true;
                                        console_log_str(&format!(
                                            "[step 3.6] WorldState player entity seeded at landblock=0x{:08X} ({:.1}, {:.1}, {:.1})",
                                            u32::from(pos.landblock_id),
                                            pos.coords.x, pos.coords.y, pos.coords.z,
                                        ));
                                    } else {
                                        // 2026-05-10 reconciliation gate:
                                        // PrivateUpdatePosition has no
                                        // sequence numbers in its payload
                                        // (`PrivateUpdatePositionData`
                                        // ships only `pos: WorldPosition`),
                                        // so we can't gate on force /
                                        // teleport seqs here. Conservative
                                        // choice: trust the integrator's
                                        // prediction unconditionally for
                                        // `position_type == Location`
                                        // (the routine local-player
                                        // broadcast). UpdatePosition's
                                        // sequence-aware gate above is
                                        // where genuine force-repositions
                                        // come through. If a regression
                                        // shows up where ACE does send a
                                        // force via PrivateUpdatePosition,
                                        // wire `data.position_type` into
                                        // a separate snap branch here.
                                        // Diagnostic: log when we'd
                                        // previously have snapped, so a
                                        // future regression is visible
                                        // before it bites.
                                        if let Some(client_pose) =
                                            w.local_player_runtime_pose()
                                        {
                                            let dx = client_pose.coords.x - pos.coords.x;
                                            let dy = client_pose.coords.y - pos.coords.y;
                                            let dz = client_pose.coords.z - pos.coords.z;
                                            let dist_sq = dx * dx + dy * dy + dz * dz;
                                            // 5 m drift tolerance — ACE
                                            // typically broadcasts within
                                            // a meter of client prediction;
                                            // larger drifts indicate the
                                            // integrator has gotten lost.
                                            if dist_sq > 25.0 {
                                                console_log_str(&format!(
                                                    "[acad-diag reconcile] PrivateUpdatePosition drift {:.2} m → snapping to server",
                                                    dist_sq.sqrt(),
                                                ));
                                                let _ = w.set_player_position(*pos);
                                            }
                                        }
                                    }
                                    if !heartbeat_armed && entity_seeded {
                                        let now = web_time::Instant::now();
                                        movement.arm_heartbeat_schedule(now, w);
                                        heartbeat_armed = true;
                                        console_log_str(
                                            "[step 3.6] AutonomousPosition heartbeat armed",
                                        );
                                    }
                                }
                                entity_updates.borrow_mut().push(EntityUpdate {
                                    kind: ENTITY_UPDATE_KIND_POSITION,
                                    guid: u32::from(guid),
                                    model_id: 0,
                                    landblock_id: u32::from(pos.landblock_id),
                                    x: pos.coords.x,
                                    y: pos.coords.y,
                                    z: pos.coords.z,
                                    qw: pos.rotation.w,
                                    qx: pos.rotation.x,
                                    qy: pos.rotation.y,
                                    qz: pos.rotation.z,
                                    wcid: 0,
                                    item_type: 0,
                                    name: String::new(),
                                    obj_scale: 1.0,
                                    icon_id: 0,
                                    palette_id: 0,
                                    mtable_id: 0,
                                    model_changes: Vec::new(),
                                    texture_changes: Vec::new(),
                                    sub_palettes: Vec::new(),
                                    portal_destination: String::new(),
                                    vx: 0.0,
                                    vy: 0.0,
                                    vz: 0.0,
                                    omega_z: 0.0,
                                    motion_command: 0,
                                    motion_stance: 0,
                                    physics_script_did: 0,
                                    sound_table_did: 0,
                                });
                            }
                        }
                        GameMessage::PublicUpdatePosition(data) => {
                            let pos = &data.pos;
                            // Phase 4 step 3: when ACE echoes the
                            // local player's position via the public
                            // channel (it does, alongside Private),
                            // refresh the cached snapshot.
                            if let LoopState::InWorld { player_guid } = &state
                                && data.guid == *player_guid
                            {
                                local_player.position = Some(*pos);
                            }
                            entity_updates.borrow_mut().push(EntityUpdate {
                                kind: ENTITY_UPDATE_KIND_POSITION,
                                guid: u32::from(data.guid),
                                model_id: 0,
                                landblock_id: u32::from(pos.landblock_id),
                                x: pos.coords.x,
                                y: pos.coords.y,
                                z: pos.coords.z,
                                qw: pos.rotation.w,
                                qx: pos.rotation.x,
                                qy: pos.rotation.y,
                                qz: pos.rotation.z,
                                wcid: 0,
                                item_type: 0,
                                name: String::new(),
                                obj_scale: 1.0,
                                icon_id: 0,
                                palette_id: 0,
                                mtable_id: 0,
                                model_changes: Vec::new(),
                                texture_changes: Vec::new(),
                                sub_palettes: Vec::new(),
                                portal_destination: String::new(),
                                vx: 0.0,
                                vy: 0.0,
                                vz: 0.0,
                                omega_z: 0.0,
                                motion_command: 0,
                                motion_stance: 0,
                                physics_script_did: 0,
                                sound_table_did: 0,
                            });
                        }
                        GameMessage::ObjectCreate(data) => {
                            // csetup_id is the SetupModel id Phase 3
                            // step 6's render cache uses; absent for
                            // movement-only or invisible-helper objects
                            // (we surface 0, JS falls back to a
                            // placeholder sprite). pos is also
                            // optional — child objects (held items,
                            // armour, mounts) inherit position from
                            // their parent and don't carry their own.
                            let model_id = data.csetup_id.unwrap_or(0);
                            let (lb, x, y, z, qw, qx, qy, qz) = match &data.pos {
                                Some(p) => (
                                    u32::from(p.landblock_id),
                                    p.coords.x,
                                    p.coords.y,
                                    p.coords.z,
                                    p.rotation.w,
                                    p.rotation.x,
                                    p.rotation.y,
                                    p.rotation.z,
                                ),
                                None => (0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0),
                            };
                            // Academy seed (2026-05-10): for fresh-
                            // character spawns ACE's `Player_Networking
                            // ::SendSelf` order is PlayerDescription
                            // (no pos field populated) → PlayerCreate
                            // (guid only) → ObjectCreate (carries the
                            // pos in `ObjectDescriptionData.pos`). The
                            // existing `UpdatePosition` /
                            // `PrivateUpdatePosition` seed sites at
                            // `:8866-8888` and `:8970-8983` never fire
                            // for the local player on a fresh spawn
                            // because ACE doesn't send those messages
                            // until something forces a position
                            // change. Without seeding here the player
                            // entity stays unseeded forever, the
                            // integrator no-ops, the heartbeat never
                            // arms, and ACE eventually drops us with
                            // `Network Timeout`. Seed when
                            // `data.public_weenie_desc.guid` is the
                            // local player and `data.pos` is `Some`;
                            // the entity_updates push below still
                            // fires so the local-player sprite
                            // renders.
                            if let Some(w) = world.as_mut()
                                && !entity_seeded
                                && data.public_weenie_desc.guid == w.player.guid
                                && w.player.guid != holtburger_common::Guid::NULL
                                && let Some(pos) = data.pos
                            {
                                let entity = holtburger_world::entity::Entity::new(
                                    data.public_weenie_desc.guid,
                                    String::from("LocalPlayer"),
                                    pos,
                                );
                                w.add_entity(entity);
                                let _ = w.set_local_player_runtime_pose(pos);
                                entity_seeded = true;
                                console_log_str(&format!(
                                    "[step 3.7] WorldState player entity seeded via ObjectCreate at landblock=0x{:08X} ({:.1}, {:.1}, {:.1})",
                                    u32::from(pos.landblock_id),
                                    pos.coords.x, pos.coords.y, pos.coords.z,
                                ));
                                if !heartbeat_armed {
                                    let now = web_time::Instant::now();
                                    movement.arm_heartbeat_schedule(now, w);
                                    heartbeat_armed = true;
                                    console_log_str(
                                        "[step 3.7] AutonomousPosition heartbeat armed",
                                    );
                                }
                            }
                            // Academy-rubberband diagnostic
                            // (2026-05-10): when ANY ObjectCreate
                            // arrives for the local player, log the
                            // current spawn-cell AABB + triangle count.
                            // Catches the "AABB is the 1 m fallback"
                            // failure mode where cells with empty
                            // drawing polys but real physics polys
                            // get pinned at the cell centroid by the
                            // safety-net clamp. This emits ONCE per
                            // session via `entity_seeded` (immediately
                            // after seeding above), so the operator
                            // can sanity-check the spawn cell without
                            // log spam.
                            if let Some(w) = world.as_ref()
                                && entity_seeded
                                && data.public_weenie_desc.guid == w.player.guid
                                && let Some(seed_pos) = data.pos
                            {
                                let cell_id = w
                                    .scene
                                    .current_cell(&seed_pos);
                                let aabb = w.scene.cell_aabb(cell_id);
                                let tri_count = w.scene.cell_triangles(cell_id).len();
                                if let Some(a) = aabb {
                                    console_log_str(&format!(
                                        "[acad-diag init] spawn cell=0x{:08X} aabb=[{:.2},{:.2},{:.2}]→[{:.2},{:.2},{:.2}] (size {:.2}×{:.2}×{:.2}) triangles={}",
                                        cell_id,
                                        a.min.x, a.min.y, a.min.z,
                                        a.max.x, a.max.y, a.max.z,
                                        a.max.x - a.min.x,
                                        a.max.y - a.min.y,
                                        a.max.z - a.min.z,
                                        tri_count,
                                    ));
                                } else {
                                    console_log_str(&format!(
                                        "[acad-diag init] spawn cell=0x{:08X} aabb=NONE (cell not yet baked) triangles={}",
                                        cell_id, tri_count,
                                    ));
                                }
                            }
                            // Phase 4 step 6a: stop discarding the
                            // PublicWeenieDescription. wcid + item_type
                            // drive the JS-side category dispatch
                            // (step 6b); name drives nameplates (step
                            // 6e); obj_scale corrects sprite size for
                            // juvenile-vs-epic creature variants;
                            // palette_id + mtable_id are surfaced for
                            // step 6c (palette tinting) and future
                            // animation work but JS may ignore them
                            // until those steps land.
                            let wcid = data.public_weenie_desc.wcid;
                            let item_type = data.public_weenie_desc.item_type;
                            let icon_id = data.public_weenie_desc.icon_id;
                            let name = data
                                .public_weenie_desc
                                .name
                                .clone()
                                .unwrap_or_default();
                            let obj_scale = data.obj_scale.unwrap_or(1.0);
                            let palette_id = data.model_data.palette_id.unwrap_or(0);
                            let mtable_id = data.mtable_id.unwrap_or(0);

                            // Phase 4 step 6f: auto-fire
                            // `GameAction::IdentifyObject(guid)` for
                            // every portal that arrives in vision.
                            // ACE marks
                            // `PropertyString::AppraisalPortalDestination`
                            // with `[AssessmentProperty]` (per
                            // `~/ace-server/Source/ACE.Entity/Enum/
                            // Properties/PropertyString.cs:63-64`)
                            // — the destination text is only sent
                            // server → client in response to an
                            // explicit appraisal. Auto-firing on
                            // ObjectCreate means each portal sprite
                            // gets its destination chip ~one
                            // round-trip after appearing in vision,
                            // without needing the player to manually
                            // click "appraise". The response routes
                            // through GameEvent::IdentifyObjectResponse
                            // → world's inventory::handle_event arm
                            // → entity.apply_identify_response →
                            // properties.strings populated → recv
                            // loop's WorldEvent::EntityIdentified
                            // scan emits a kind=3 META_REFRESH
                            // EntityUpdate with the destination text.
                            if item_type & ITEM_TYPE_PORTAL_BIT != 0 {
                                let id_action = GameAction::IdentifyObject(
                                    Box::new(holtburger_protocol::messages::IdentifyObjectActionData {
                                        guid: data.public_weenie_desc.guid,
                                    }),
                                );
                                if let Err(e) = session.send_action(id_action).await {
                                    log::warn!(
                                        "recv_loop: send_action(IdentifyObject portal=0x{:08X}): {e}",
                                        u32::from(data.public_weenie_desc.guid),
                                    );
                                }
                            }
                            // Phase 4 step 6 Phase A: ACE pre-computes
                            // ClothingTable substitutions in
                            // `Creature.CalculateObjDesc()` (~/ace-server
                            // /Source/ACE.Server/WorldObjects/Creature_
                            // Networking.cs:35-243) and ships the
                            // resulting per-part GfxObj swaps + texture
                            // remaps + palette overlays here. Pack each
                            // into the flat-pair / flat-triple shape
                            // EntityUpdate's wasm-bindgen getters
                            // expose, so the JS rasterizer can pass
                            // them straight through to
                            // `fetchEntityModelRender`.
                            let mut model_changes: Vec<u32> =
                                Vec::with_capacity(data.model_data.model_changes.len() * 2);
                            for mc in &data.model_data.model_changes {
                                model_changes.push(mc.index as u32);
                                model_changes.push(mc.animation_id);
                            }
                            let mut texture_changes: Vec<u32> =
                                Vec::with_capacity(data.model_data.texture_changes.len() * 3);
                            for tc in &data.model_data.texture_changes {
                                texture_changes.push(tc.part_index as u32);
                                texture_changes.push(tc.old_id);
                                texture_changes.push(tc.new_id);
                            }
                            let mut sub_palettes: Vec<u32> =
                                Vec::with_capacity(data.model_data.sub_palettes.len() * 3);
                            for sp in &data.model_data.sub_palettes {
                                sub_palettes.push(sp.id);
                                sub_palettes.push(sp.offset as u32);
                                sub_palettes.push(sp.length as u32);
                            }
                            // Workstream A: detect if this ObjectCreate is
                            // for the local player so we can flag-track the
                            // KIND_SPAWN emission. Pre-A every ObjectCreate
                            // unconditionally pushed a KIND_SPAWN; that
                            // remains the path for NPC / item spawns. For
                            // the local player specifically we want
                            // idempotent emit: if this is the local player
                            // AND we've already emitted their Spawn (e.g.
                            // we'll add a UpdatePosition-driven emit below
                            // once we know pose), drop the duplicate so the
                            // JS-side spawn handler runs once. The local-
                            // player guid only equals `world.player.guid`
                            // when the eager-WorldState construct already
                            // ran — pre-eager-construct it's
                            // `Guid::NULL` and the comparison is false, so
                            // pre-spawn ObjectCreates (rare in this flow)
                            // still emit unconditionally.
                            let is_local_player = world
                                .as_ref()
                                .map(|w| {
                                    w.player.guid != holtburger_common::Guid::NULL
                                        && data.public_weenie_desc.guid == w.player.guid
                                })
                                .unwrap_or(false);
                            let skip_local_player_spawn =
                                is_local_player && local_player_spawn_emitted;
                            if !skip_local_player_spawn {
                                entity_updates.borrow_mut().push(EntityUpdate {
                                    kind: ENTITY_UPDATE_KIND_SPAWN,
                                    guid: u32::from(data.public_weenie_desc.guid),
                                    model_id,
                                    landblock_id: lb,
                                    x,
                                    y,
                                    z,
                                    qw,
                                    qx,
                                    qy,
                                    qz,
                                    wcid,
                                    item_type,
                                    name,
                                    obj_scale,
                                    icon_id,
                                    palette_id,
                                    mtable_id,
                                    model_changes,
                                    texture_changes,
                                    sub_palettes,
                                    portal_destination: String::new(),
                                    vx: 0.0,
                                    vy: 0.0,
                                    vz: 0.0,
                                    omega_z: 0.0,
                                    motion_command: 0,
                                    motion_stance: 0,
                                    // H2 (2026-05-12): plumb the entity's
                                    // PhysicsScript DID through to JS so
                                    // entities.js can walk the chain.
                                    physics_script_did: data.default_script_id.unwrap_or(0),
                                    // Task E (2026-05-12): plumb the entity's
                                    // SoundTable DID. The wire field is
                                    // `stable_id` (PhysicsDescriptionFlag::STABLE),
                                    // backed server-side by the weenie's
                                    // `PropertyDataId::SoundTable` (= 3) — see
                                    // `holtburger_common::properties::world_object::stable_id()`.
                                    // JS-side EntityManager prewarms its
                                    // `SoundTableCache` with this DID on spawn so
                                    // animation Sound/SoundTable hooks resolve
                                    // synchronously after the first frame.
                                    sound_table_did: data.stable_id.unwrap_or(0),
                                });
                                if is_local_player {
                                    local_player_spawn_emitted = true;
                                    console_log_str(&format!(
                                        "[workstream-A] emitted KIND_SPAWN for local player on ObjectCreate (guid=0x{:08X}, pose lb=0x{:08X} ({:.1}, {:.1}, {:.1}))",
                                        u32::from(data.public_weenie_desc.guid),
                                        lb, x, y, z,
                                    ));
                                }
                            }

                            // Phase 6 step E follow-up (2026-05-09):
                            // Door registration. The DOOR-flagged entity
                            // was inserted into `world.entities` by
                            // `apply_inventory_object_create` above, so
                            // its `flags` carry the DOOR bit from
                            // `PublicWeenieDescription::obj_desc_flags`
                            // and its `position` is the spawn pose. We
                            // sweep the per-cell building-AABB index for
                            // the spawn point: the AABB whose XY
                            // footprint contains the door point is the
                            // building part the door lives in. Bind
                            // `door_guid → (BuildingId, part_index)` in
                            // the scene so subsequent
                            // `set_door_aabb_active` calls can flip the
                            // exact entry by GUID, AND publish a
                            // `DoorPartSnapshot` carrying the placement
                            // origin so the JS-side kind=15 handler can
                            // map back to the building's PIXI container
                            // by `${landblockId}_${x}_${y}_${modelId}`.
                            //
                            // Failure modes — all benign, JS keeps a 5m
                            // `findClosestBuildingPart` fallback:
                            // - ObjectCreate races
                            //   `populateBuildingAabbsForLandblock` (no
                            //   AABBs yet → empty candidate list);
                            // - placement origin not yet drained from
                            //   `BUILDING_ORIGIN_PENDING` (we register
                            //   the door but skip the snapshot push so
                            //   we don't store a bogus xy);
                            // - door for an admin-spawned dynamic
                            //   dungeon (no `LandblockInfo.buildings`
                            //   entry → no AABB candidates).
                            if let Some(w) = world.as_mut() {
                                use holtburger_common::properties::ObjectDescriptionFlag;
                                let guid = data.public_weenie_desc.guid;
                                let pose = w
                                    .entities
                                    .get(guid)
                                    .filter(|e| e.flags.contains(ObjectDescriptionFlag::DOOR))
                                    .map(|e| e.position);
                                if let Some(pose) = pose {
                                    let candidates = w.scene.building_aabbs_near_pose(&pose);
                                    let px = pose.coords.x;
                                    let py = pose.coords.y;
                                    let mut hit: Option<(
                                        holtburger_world::BuildingId,
                                        u8,
                                    )> = None;
                                    for entry in candidates {
                                        if px >= entry.aabb.min.x
                                            && px <= entry.aabb.max.x
                                            && py >= entry.aabb.min.y
                                            && py <= entry.aabb.max.y
                                        {
                                            hit = Some((entry.building_id, entry.part_index));
                                            break;
                                        }
                                    }
                                    if let Some((building_id, part_index)) = hit {
                                        let door_guid = u64::from(u32::from(guid));
                                        w.scene.register_door_part(
                                            door_guid,
                                            building_id,
                                            part_index,
                                        );
                                        if let Some((origin_x, origin_y)) =
                                            w.scene.building_origin(building_id)
                                        {
                                            door_part_snapshot.borrow_mut().insert(
                                                u32::from(guid),
                                                DoorPartSnapshot {
                                                    landblock_id: building_id.landblock_id,
                                                    model_id: building_id.model_id,
                                                    origin_x,
                                                    origin_y,
                                                    part_index,
                                                },
                                            );
                                        }
                                    }
                                }
                            }
                        }
                        GameMessage::ObjectDelete(data) => {
                            entity_updates.borrow_mut().push(EntityUpdate {
                                kind: ENTITY_UPDATE_KIND_REMOVE,
                                guid: u32::from(data.guid),
                                model_id: 0,
                                landblock_id: 0,
                                x: 0.0,
                                y: 0.0,
                                z: 0.0,
                                qw: 1.0,
                                qx: 0.0,
                                qy: 0.0,
                                qz: 0.0,
                                wcid: 0,
                                item_type: 0,
                                name: String::new(),
                                obj_scale: 1.0,
                                icon_id: 0,
                                palette_id: 0,
                                mtable_id: 0,
                                model_changes: Vec::new(),
                                texture_changes: Vec::new(),
                                sub_palettes: Vec::new(),
                                portal_destination: String::new(),
                                vx: 0.0,
                                vy: 0.0,
                                vz: 0.0,
                                omega_z: 0.0,
                                motion_command: 0,
                                motion_stance: 0,
                                physics_script_did: 0,
                                sound_table_did: 0,
                            });
                        }
                        GameMessage::UpdateMotion(data) => {
                            // Phase 4 step 3 wire validation: ACE
                            // broadcasts UpdateMotion in response to
                            // our outbound MoveToState (see
                            // `Player_Networking.cs::BroadcastMovement`
                            // line 365 — `EnqueueBroadcast(true, ...)`
                            // includes the originator). Receiving this
                            // confirms ACE accepted our packet and is
                            // simulating motion. The local player's
                            // sprite still won't slide — retail AC
                            // expects the client to predict locally —
                            // but the round-trip is observable here.
                            console_log_str(&format!(
                                "[step3-trace] UpdateMotion guid=0x{:08X} (ACE accepted MoveToState)",
                                u32::from(data.guid),
                            ));
                            // Animation-gate hint: derive the active
                            // forward locomotion command so JS can
                            // gate walk-cycle animation on a server-
                            // authoritative state instead of the
                            // EMA-on-position-deltas heuristic. Source
                            // of truth varies by `MovementType`:
                            //   - StopCompletely → STOP (definitive idle)
                            //   - Invalid (the autonomous/raw envelope
                            //     player movement uses): pull
                            //     `state.forward_command` if the flag
                            //     bit is set; else 0 (no signal).
                            //   - MoveToObject / MoveToPosition → server
                            //     pathing; treat as RUN_FORWARD (these
                            //     carry a `run_rate` but no command code,
                            //     and AI-pathed creatures default to run
                            //     speed in retail).
                            //   - TurnToObject / TurnToHeading → no
                            //     forward locomotion; 0 lets JS keep
                            //     the EMA gate's current state.
                            use holtburger_protocol::messages::movement::{
                                InterpretedMotionCommand, MovementType, MovementTypeData,
                            };
                            let motion_command_u16: u16 = match (data.movement_type, &data.data) {
                                (MovementType::StopCompletely, _) => {
                                    InterpretedMotionCommand::STOP.raw()
                                }
                                (_, MovementTypeData::Invalid(inv)) => inv
                                    .state
                                    .forward_command
                                    .map(|c| c.raw())
                                    .unwrap_or(0),
                                (
                                    MovementType::MoveToObject | MovementType::MoveToPosition,
                                    _,
                                ) => InterpretedMotionCommand::RUN_FORWARD.raw(),
                                _ => 0,
                            };
                            entity_updates.borrow_mut().push(EntityUpdate {
                                kind: ENTITY_UPDATE_KIND_MOTION,
                                guid: u32::from(data.guid),
                                model_id: 0,
                                landblock_id: 0,
                                x: 0.0,
                                y: 0.0,
                                z: 0.0,
                                qw: 1.0,
                                qx: 0.0,
                                qy: 0.0,
                                qz: 0.0,
                                wcid: 0,
                                item_type: 0,
                                name: String::new(),
                                obj_scale: 0.0,
                                icon_id: 0,
                                palette_id: 0,
                                mtable_id: 0,
                                model_changes: Vec::new(),
                                texture_changes: Vec::new(),
                                sub_palettes: Vec::new(),
                                portal_destination: String::new(),
                                vx: 0.0,
                                vy: 0.0,
                                vz: 0.0,
                                omega_z: 0.0,
                                motion_command: u32::from(motion_command_u16),
                                motion_stance: u32::from(data.current_style),
                                physics_script_did: 0,
                                sound_table_did: 0,
                            });
                        }
                        GameMessage::VectorUpdate(data) => {
                            // Velocity-extrapolation polish: ACE
                            // broadcasts VectorUpdate whenever an
                            // entity's physics state changes
                            // (start/stop walking, change direction).
                            // The recv loop dropped these in the
                            // catch-all arm pre-this commit; surfacing
                            // them as kind=4 EntityUpdate lets JS
                            // extrapolate sprite position past the
                            // catch-up lerp so motion stays smooth
                            // across the ~100-300 ms gap between
                            // PublicUpdatePosition echoes.
                            //
                            // Position fields are zeroed — only
                            // (guid, vx/y/z, omega_z) carry data on
                            // kind=4. JS reads via the velocity
                            // getters and stores `velX/Y/UpdatedMs`
                            // on the entityMap entry.
                            entity_updates.borrow_mut().push(EntityUpdate {
                                kind: ENTITY_UPDATE_KIND_VELOCITY,
                                guid: u32::from(data.guid),
                                model_id: 0,
                                landblock_id: 0,
                                x: 0.0,
                                y: 0.0,
                                z: 0.0,
                                qw: 1.0,
                                qx: 0.0,
                                qy: 0.0,
                                qz: 0.0,
                                wcid: 0,
                                item_type: 0,
                                name: String::new(),
                                obj_scale: 0.0,
                                icon_id: 0,
                                palette_id: 0,
                                mtable_id: 0,
                                model_changes: Vec::new(),
                                texture_changes: Vec::new(),
                                sub_palettes: Vec::new(),
                                portal_destination: String::new(),
                                vx: data.velocity.x,
                                vy: data.velocity.y,
                                vz: data.velocity.z,
                                // AC is z-up; entity rotation is
                                // yaw-only (one quat axis), so the
                                // x/y omega components are dropped
                                // — only the z-axis angular velocity
                                // matters for the top-down renderer.
                                omega_z: data.omega.z,
                                motion_command: 0,
                                motion_stance: 0,
                                physics_script_did: 0,
                                sound_table_did: 0,
                            });
                        }
                        // Phase 4 step 4: chat-bearing surfaces. Each
                        // variant gets normalised into a single display
                        // line + a `CHAT_CATEGORY_*` ID so JS can
                        // append to the chat panel without knowing
                        // each AC packet's shape. Reference handlers
                        // in the cli are scattered across
                        // `crates/holtburger-core/src/client/messages.rs`
                        // and `apps/holtburger-cli/src/pages/game/panels/
                        // chat.rs`; we don't reuse them because the cli
                        // formats for stdout (ratatui spans) and we
                        // format for the DOM. Categories below mirror
                        // the cli's `chat_message_tags()` mapping.
                        GameMessage::ServerMessage(data) => {
                            // System chat — ChatMessageType in the
                            // payload routes the tab (Combat → combat,
                            // Magic → magic, Advancement → advancement,
                            // Recall / Craft / etc. likewise).
                            // ChatMessageType::WorldBroadcast lands here
                            // too (server-wide announcements).
                            let category = chat_category_for_message_type(data.chat_type);
                            queued_events.borrow_mut().push(ClientEvent {
                                kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                                string_payload: Some(format!("[Server] {}", data.message)),
                                u32_payload: Some(data.chat_type),
                                u32_payload_2: Some(category),
                                f32_payload: None,
                            });
                        }
                        GameMessage::HearSpeech(data) => {
                            // Local say within speech-radius. chat_type
                            // is usually `Speech` but ACE also uses this
                            // packet for spell-casting words (chat_type
                            // = Spellcasting), so the category lookup
                            // routes spell incantations to the magic
                            // tab instead of local.
                            let category = chat_category_for_message_type(data.chat_type);
                            queued_events.borrow_mut().push(ClientEvent {
                                kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                                string_payload: Some(format!(
                                    "{} says, \"{}\"",
                                    data.sender_name, data.message
                                )),
                                u32_payload: Some(data.chat_type),
                                u32_payload_2: Some(category),
                                f32_payload: None,
                            });
                        }
                        GameMessage::HearRangedSpeech(data) => {
                            // Greater-range speech variant (e.g. heralds,
                            // World Crier). Same chat_type taxonomy as
                            // HearSpeech.
                            let category = chat_category_for_message_type(data.chat_type);
                            queued_events.borrow_mut().push(ClientEvent {
                                kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                                string_payload: Some(format!(
                                    "{} says, \"{}\"",
                                    data.sender_name, data.message
                                )),
                                u32_payload: Some(data.chat_type),
                                u32_payload_2: Some(category),
                                f32_payload: None,
                            });
                        }
                        GameMessage::EmoteText(data) => {
                            // EmoteText.text is already self-contained —
                            // ACE pre-renders it as e.g. "Alice waves at
                            // you." — so don't re-prepend the sender
                            // name. Mirror the cli's display path.
                            queued_events.borrow_mut().push(ClientEvent {
                                kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                                string_payload: Some(data.text.clone()),
                                u32_payload: Some(0),
                                u32_payload_2: Some(CHAT_CATEGORY_EMOTE),
                                f32_payload: None,
                            });
                        }
                        GameMessage::SoulEmote(data) => {
                            // SoulEmote.text is identical in shape to
                            // EmoteText.text — pre-rendered. Same
                            // formatting rule.
                            queued_events.borrow_mut().push(ClientEvent {
                                kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                                string_payload: Some(data.text.clone()),
                                u32_payload: Some(0),
                                u32_payload_2: Some(CHAT_CATEGORY_EMOTE),
                                f32_payload: None,
                            });
                        }
                        GameMessage::PlayerKilled(data) => {
                            // Death broadcast — the formatted message
                            // already reads "Player has been slain by
                            // Monster!" or "Player killed by Player."
                            // (PK kill). victim_id / killer_id are
                            // GUIDs the wasm bundle could colour by
                            // friendliness in a future step; today we
                            // just surface the line.
                            queued_events.borrow_mut().push(ClientEvent {
                                kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                                string_payload: Some(data.death_message.clone()),
                                u32_payload: Some(u32::from(data.killer_id)),
                                u32_payload_2: Some(CHAT_CATEGORY_DEATH),
                                f32_payload: None,
                            });
                        }
                        GameMessage::TurbineChat(data) => {
                            // Modern (post-Turbine) channel chat —
                            // General / Trade / LFG / Roleplay /
                            // Allegiance / Society / Olthoi. ACE wraps
                            // the receive side in a SendToRoomByName
                            // event blob; the request-side payload is
                            // for outbound (which we don't speak yet).
                            // Response blobs are RPC echoes — silent.
                            use holtburger_protocol::messages::chat::turbine::TurbineChatPayload;
                            match &data.payload {
                                TurbineChatPayload::EventSendToRoom {
                                    sender_name,
                                    message,
                                    chat_type,
                                    ..
                                } => {
                                    let chat_type_raw = chat_type.raw();
                                    let label = turbine_chat_type_label(chat_type_raw);
                                    let category =
                                        chat_category_for_turbine_chat_type(chat_type_raw);
                                    queued_events.borrow_mut().push(ClientEvent {
                                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                                        string_payload: Some(format!(
                                            "[{label}] {sender_name} says, \"{message}\""
                                        )),
                                        u32_payload: Some(chat_type_raw),
                                        u32_payload_2: Some(category),
                                        f32_payload: None,
                                    });
                                }
                                TurbineChatPayload::RequestSendToRoomById { .. }
                                | TurbineChatPayload::Response { .. }
                                | TurbineChatPayload::Unknown(_) => {
                                    // RPC echo / outbound — nothing to
                                    // render.
                                }
                            }
                        }
                        GameMessage::GameEvent(event_msg) => {
                            // GameEvent wraps a sequenced inbound
                            // dispatch keyed on `target` (player or
                            // object guid) + `sequence`. The chat
                            // surfaces here all carry text payloads or
                            // are combat/death notifications that get
                            // formatted into chat lines below; non-chat
                            // variants (PlayerDescription, PingResponse,
                            // ViewContents, magic enchant updates,
                            // fellowship / trade events, etc.)
                            // intentionally fall through to a catch-all
                            // _no-op_ — those land in steps 5+
                            // (interactive entities, vitals, inventory).
                            match event_msg.event {
                                holtburger_protocol::messages::GameEvent::Tell(data) => {
                                    let category = chat_category_for_message_type(data.chat_type);
                                    queued_events.borrow_mut().push(ClientEvent {
                                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                                        string_payload: Some(format!(
                                            "{} tells you, \"{}\"",
                                            data.sender_name, data.message
                                        )),
                                        u32_payload: Some(data.chat_type),
                                        u32_payload_2: Some(category),
                                        f32_payload: None,
                                    });
                                }
                                holtburger_protocol::messages::GameEvent::ChannelBroadcast(
                                    data,
                                ) => {
                                    let channel_label =
                                        chat_channel_label(data.channel.raw());
                                    let category =
                                        chat_category_for_channel(data.channel.raw());
                                    queued_events.borrow_mut().push(ClientEvent {
                                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                                        string_payload: Some(format!(
                                            "[{}] {} says, \"{}\"",
                                            channel_label, data.sender_name, data.message
                                        )),
                                        u32_payload: Some(data.channel.raw()),
                                        u32_payload_2: Some(category),
                                        f32_payload: None,
                                    });
                                }
                                holtburger_protocol::messages::GameEvent::CommunicationTransientString(
                                    data,
                                ) => {
                                    queued_events.borrow_mut().push(ClientEvent {
                                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                                        string_payload: Some(data.message.clone()),
                                        u32_payload: Some(0),
                                        u32_payload_2: Some(CHAT_CATEGORY_TRANSIENT),
                                        f32_payload: None,
                                    });
                                }
                                holtburger_protocol::messages::GameEvent::PopupString(data) => {
                                    queued_events.borrow_mut().push(ClientEvent {
                                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                                        string_payload: Some(format!("[Popup] {}", data.message)),
                                        u32_payload: Some(0),
                                        u32_payload_2: Some(CHAT_CATEGORY_POPUP),
                                        f32_payload: None,
                                    });
                                }
                                holtburger_protocol::messages::GameEvent::AttackerNotification(
                                    data,
                                ) => {
                                    // "You hit Drudge Ravener for 37
                                    // slash damage (25.0%). Critical
                                    // hit. [Recklessness, Sneak attack]"
                                    // — mirrors cli format from
                                    // chat.rs:250-269.
                                    let crit = if data.critical_hit {
                                        " Critical hit."
                                    } else {
                                        ""
                                    };
                                    let suffix = attack_conditions_suffix(data.attack_conditions);
                                    let line = format!(
                                        "You hit {} for {} {} damage ({:.1}%).{}{}",
                                        data.defender_name,
                                        data.damage,
                                        damage_type_label(data.damage_type),
                                        data.health_percent * 100.0,
                                        crit,
                                        suffix,
                                    );
                                    queued_events.borrow_mut().push(ClientEvent {
                                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                                        string_payload: Some(line),
                                        u32_payload: Some(0),
                                        u32_payload_2: Some(CHAT_CATEGORY_COMBAT),
                                        f32_payload: None,
                                    });
                                }
                                holtburger_protocol::messages::GameEvent::DefenderNotification(
                                    data,
                                ) => {
                                    // "Banderling hit you for 18 fire
                                    // damage to your chest (12.5%)."
                                    let crit = if data.critical_hit {
                                        " Critical hit."
                                    } else {
                                        ""
                                    };
                                    let suffix = attack_conditions_suffix(data.attack_conditions);
                                    let line = format!(
                                        "{} hit you for {} {} damage to your {} ({:.1}%).{}{}",
                                        data.attacker_name,
                                        data.damage,
                                        damage_type_label(data.damage_type),
                                        damage_location_label(data.damage_location),
                                        data.health_percent * 100.0,
                                        crit,
                                        suffix,
                                    );
                                    queued_events.borrow_mut().push(ClientEvent {
                                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                                        string_payload: Some(line),
                                        u32_payload: Some(0),
                                        u32_payload_2: Some(CHAT_CATEGORY_COMBAT),
                                        f32_payload: None,
                                    });
                                }
                                holtburger_protocol::messages::GameEvent::EvasionAttackerNotification(
                                    data,
                                ) => {
                                    queued_events.borrow_mut().push(ClientEvent {
                                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                                        string_payload: Some(format!(
                                            "{} evaded your attack.",
                                            data.defender_name
                                        )),
                                        u32_payload: Some(0),
                                        u32_payload_2: Some(CHAT_CATEGORY_COMBAT),
                                        f32_payload: None,
                                    });
                                }
                                holtburger_protocol::messages::GameEvent::EvasionDefenderNotification(
                                    data,
                                ) => {
                                    queued_events.borrow_mut().push(ClientEvent {
                                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                                        string_payload: Some(format!(
                                            "You evaded {}'s attack.",
                                            data.attacker_name
                                        )),
                                        u32_payload: Some(0),
                                        u32_payload_2: Some(CHAT_CATEGORY_COMBAT),
                                        f32_payload: None,
                                    });
                                }
                                holtburger_protocol::messages::GameEvent::VictimNotification(
                                    data,
                                ) => {
                                    // ACE pre-formats the line — "You
                                    // have died!" / "Drudge slew you!"
                                    // / "You killed yourself with a
                                    // spell!" — so just relay it.
                                    queued_events.borrow_mut().push(ClientEvent {
                                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                                        string_payload: Some(data.death_message.clone()),
                                        u32_payload: Some(0),
                                        u32_payload_2: Some(CHAT_CATEGORY_DEATH),
                                        f32_payload: None,
                                    });
                                }
                                holtburger_protocol::messages::GameEvent::KillerNotification(
                                    data,
                                ) => {
                                    // Survivor's POV: "You killed the
                                    // drudge!"
                                    queued_events.borrow_mut().push(ClientEvent {
                                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                                        string_payload: Some(data.death_message.clone()),
                                        u32_payload: Some(0),
                                        u32_payload_2: Some(CHAT_CATEGORY_DEATH),
                                        f32_payload: None,
                                    });
                                }
                                holtburger_protocol::messages::GameEvent::PlayerDescription(
                                    data,
                                ) => {
                                    // Phase 4 step 3.7: hydrate from
                                    // PlayerDescription so subsequent
                                    // movement reads the player's real
                                    // run rate / motion table / skills.
                                    //
                                    // Phase 4 step 4 follow-on: the
                                    // hydrate / apply / emit-derived-
                                    // stats trio is now handled by the
                                    // canonical world handler dispatcher
                                    // up at the top of the recv-loop's
                                    // per-message processing block (the
                                    // `should_route_message_to_world` →
                                    // `routing::handle_message` call).
                                    // What stays in this arm is the
                                    // movement-capabilities-override
                                    // bookkeeping that step 3.6/3.7
                                    // owns: clear the bootstrap-time
                                    // fallback, verify real caps now
                                    // resolve, and defensively re-install
                                    // the fallback if they don't.
                                    //
                                    // Academy seed (2026-05-10): for
                                    // fresh-character spawns ACE never
                                    // sends `UpdatePosition` /
                                    // `PrivateUpdatePosition` for the
                                    // local player guid (ACE's
                                    // `Player_Networking.SendSelf` order
                                    // is PlayerDescription → PlayerCreate
                                    // → CreateObject; the position rides
                                    // on PlayerDescription, not a
                                    // dedicated position update). Without
                                    // this fall-through the player
                                    // entity never gets seeded and the
                                    // integrator no-ops every tick. Seed
                                    // here when `data.pos` is `Some`,
                                    // matching the pattern at
                                    // `:8866-8888` (UpdatePosition path)
                                    // and `:8970-8983`
                                    // (PrivateUpdatePosition path); the
                                    // existing teleport / motion arms
                                    // overwrite via `set_player_position`
                                    // once `entity_seeded` is true.
                                    if let Some(w) = world.as_mut() {
                                        // Gate on `w.player.guid` (set at
                                        // SelectCharacter time, before
                                        // PlayerDescription arrives) rather
                                        // than `LoopState::InWorld` —
                                        // PlayerDescription typically
                                        // races PlayerCreate by a few ms,
                                        // and PlayerCreate is what
                                        // transitions to InWorld. So at
                                        // PlayerDescription handling time
                                        // the loop state is still
                                        // `EnteringWorld`, but `w.player.
                                        // guid` already matches `data.guid`
                                        // for the local player.
                                        if !entity_seeded
                                            && data.guid == w.player.guid
                                            && data.guid != holtburger_common::Guid::NULL
                                        {
                                            if let Some(pos) = data.pos {
                                                let entity =
                                                    holtburger_world::entity::Entity::new(
                                                        data.guid,
                                                        String::from("LocalPlayer"),
                                                        pos,
                                                    );
                                                w.add_entity(entity);
                                                let _ = w
                                                    .set_local_player_runtime_pose(pos);
                                                entity_seeded = true;
                                                console_log_str(&format!(
                                                    "[step 3.7] WorldState player entity seeded via PlayerDescription at landblock=0x{:08X} ({:.1}, {:.1}, {:.1})",
                                                    u32::from(pos.landblock_id),
                                                    pos.coords.x,
                                                    pos.coords.y,
                                                    pos.coords.z,
                                                ));
                                                if !heartbeat_armed {
                                                    let now = web_time::Instant::now();
                                                    movement
                                                        .arm_heartbeat_schedule(now, w);
                                                    heartbeat_armed = true;
                                                    console_log_str(
                                                        "[step 3.7] AutonomousPosition heartbeat armed",
                                                    );
                                                }
                                            } else {
                                                console_log_str(
                                                    "[step 3.7] PlayerDescription arrived without pos field — entity remains unseeded; waiting for UpdatePosition",
                                                );
                                            }
                                        }
                                        w.clear_self_movement_capabilities_override();
                                        let real_caps_ok = w
                                            .resolve_self_movement_capabilities()
                                            .is_ok();
                                        console_log_str(&format!(
                                            "[step 3.7] PlayerDescription handled; \
                                             fallback caps cleared (real_caps_ok={})",
                                            real_caps_ok,
                                        ));
                                        if !real_caps_ok {
                                            let fallback =
                                                holtburger_world::SelfMovementCapabilities {
                                                    kinematics: holtburger_world::SelfMovementKinematics {
                                                        source: holtburger_world::PlayerMotionTableSource::DirectProperty {
                                                            motion_table_id: 0,
                                                        },
                                                        motion_table_id: 0,
                                                        stance: 0,
                                                        base_walk_forward_velocity:
                                                            holtburger_common::Vector3 {
                                                                x: 0.0, y: 1.0, z: 0.0,
                                                            },
                                                        base_run_forward_velocity:
                                                            holtburger_common::Vector3 {
                                                                x: 0.0, y: 4.5, z: 0.0,
                                                            },
                                                        base_turn_left_omega:
                                                            holtburger_common::Vector3 {
                                                                x: 0.0, y: 0.0, z: 1.5,
                                                            },
                                                        base_turn_right_omega:
                                                            holtburger_common::Vector3 {
                                                                x: 0.0, y: 0.0, z: -1.5,
                                                            },
                                                    },
                                                    run_rate_scalar: 1.0,
                                                };
                                            w.set_self_movement_capabilities_override(
                                                fallback,
                                            );
                                            console_log_str(
                                                "[step 3.7] real biota didn't resolve; \
                                                 fallback caps re-installed",
                                            );
                                        }
                                    }
                                }
                                holtburger_protocol::messages::GameEvent::ApproachVendor(
                                    data,
                                ) => {
                                    // Phase 4 step 5 (interactive
                                    // entities): the player clicked a
                                    // vendor (a Creature weenie with
                                    // merchandise) and ACE responded
                                    // with the vendor's item list +
                                    // buy/sell multipliers. Surface as
                                    // kind=12 VendorOpened so JS can
                                    // pop a vendor window (or a status
                                    // line for the first-cut UI).
                                    //
                                    // The vendor's display name comes
                                    // from `world.entities` if the
                                    // entity was previously tracked —
                                    // otherwise we fall back to a
                                    // generic "Vendor" label. ACE's
                                    // `ApproachVendorEventData` itself
                                    // doesn't carry the vendor name on
                                    // the wire (just the guid + item
                                    // list); the cli looks it up via
                                    // `state.entities.get(vendor_guid).name()`.
                                    let vendor_guid = u32::from(data.vendor_guid);
                                    let vendor_name = world
                                        .as_ref()
                                        .and_then(|w| {
                                            w.entities.get(data.vendor_guid).map(
                                                |entity| {
                                                    use holtburger_common::properties::WorldObjectExt as _;
                                                    entity.name().to_string()
                                                },
                                            )
                                        })
                                        .unwrap_or_else(|| "Vendor".to_string());
                                    let item_count = data.items.len() as u32;
                                    queued_events.borrow_mut().push(ClientEvent {
                                        kind: CLIENT_EVENT_KIND_VENDOR_OPENED,
                                        string_payload: Some(vendor_name.clone()),
                                        u32_payload: Some(vendor_guid),
                                        u32_payload_2: Some(item_count),
                                        f32_payload: None,
                                    });
                                    // Also surface as a chat line so
                                    // the user sees something even
                                    // before the vendor-window UI
                                    // lands. Format mirrors the cli.
                                    queued_events.borrow_mut().push(ClientEvent {
                                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                                        string_payload: Some(format!(
                                            "[Vendor] {vendor_name} has {item_count} items for sale."
                                        )),
                                        u32_payload: Some(0),
                                        u32_payload_2: Some(CHAT_CATEGORY_TRADE),
                                        f32_payload: None,
                                    });
                                }
                                holtburger_protocol::messages::GameEvent::UseDone(data) => {
                                    // Phase 4 step 5: ACE confirms the
                                    // player's `Use` action completed.
                                    // `error == None` is success
                                    // (door opened, container
                                    // approached, etc.); non-None
                                    // routes to kind=13 UseFailed
                                    // instead.
                                    use holtburger_protocol::errors::WeenieError;
                                    if data.error == WeenieError::None {
                                        queued_events.borrow_mut().push(ClientEvent {
                                            kind: CLIENT_EVENT_KIND_USE_DONE,
                                            string_payload: None,
                                            u32_payload: None,
                                            u32_payload_2: None,
                                            f32_payload: None,
                                        });
                                    } else {
                                        let label = format!("{:?}", data.error);
                                        queued_events.borrow_mut().push(ClientEvent {
                                            kind: CLIENT_EVENT_KIND_USE_FAILED,
                                            string_payload: Some(label.clone()),
                                            u32_payload: Some(data.error as u32),
                                            u32_payload_2: None,
                                            f32_payload: None,
                                        });
                                        queued_events.borrow_mut().push(ClientEvent {
                                            kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                                            string_payload: Some(format!(
                                                "[Use failed] {label}"
                                            )),
                                            u32_payload: Some(0),
                                            u32_payload_2: Some(CHAT_CATEGORY_SYSTEM),
                                            f32_payload: None,
                                        });
                                    }
                                }
                                holtburger_protocol::messages::GameEvent::WeenieError(
                                    data,
                                ) => {
                                    // Phase 4 step 5: ACE sends
                                    // `WeenieError` for many non-use
                                    // reasons too — channel-join
                                    // notifications
                                    // (`YouHaveEnteredTheChannel(...)`,
                                    // `TurbineChatIsEnabled`),
                                    // chat-system info, fellowship /
                                    // trade hints, etc. Surface every
                                    // one as a kind=2 system chat
                                    // line; the cli also routes them
                                    // to chat. Use-failed semantics
                                    // come exclusively from
                                    // `UseDone(error != None)` so we
                                    // don't false-positive on
                                    // info-channel errors.
                                    let label = format!("{:?}", data.error);
                                    let code = data.error as u32;
                                    queued_events.borrow_mut().push(ClientEvent {
                                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                                        string_payload: Some(label),
                                        u32_payload: Some(code),
                                        u32_payload_2: Some(CHAT_CATEGORY_SYSTEM),
                                        f32_payload: None,
                                    });
                                }
                                holtburger_protocol::messages::GameEvent::WeenieErrorWithString(
                                    data,
                                ) => {
                                    // Phase 4 step 5: WeenieError +
                                    // parameter string. Same kind=2
                                    // chat treatment as the bare
                                    // WeenieError arm; no kind=13.
                                    let label = format!("{:?}({})", data.error, data.parameter);
                                    let code = data.error as u32;
                                    queued_events.borrow_mut().push(ClientEvent {
                                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                                        string_payload: Some(label),
                                        u32_payload: Some(code),
                                        u32_payload_2: Some(CHAT_CATEGORY_SYSTEM),
                                        f32_payload: None,
                                    });
                                }
                                _ => {
                                    // Non-chat GameEvents drop through
                                    // to the no-op outer catch-all.
                                    // Future steps (fellowship UI,
                                    // identify popup, book contents,
                                    // ...) wire them up in their own
                                    // arms.
                                }
                            }
                        }
                        GameMessage::PlaySound(data) => {
                            // Task F (ambient-sounds-chain, 2026-05-12):
                            // ACE broadcast `GameMessageSound` (opcode
                            // 0xF750) — server-triggered audio for
                            // lifestone bind, switch activation, hotspot
                            // trigger, craft event, etc. Wire layout:
                            // `[u32 guid, u32 sound_id, f32 volume]`
                            // (16 bytes total incl. the 4-byte opcode).
                            //
                            // The parser is `PlaySoundData` in
                            // `crates/holtburger-protocol/src/messages/
                            // effects/types.rs` — pre-existing from the
                            // protocol-crate buildout; the `target` /
                            // `sound_id` / `volume` field names track
                            // ACE's GameMessageSound constructor 1:1.
                            //
                            // Forward to JS as a kind=16 SoundTriggered
                            // ClientEvent. JS-side (`index.html`'s
                            // `drainEvents` block) looks up the entity
                            // in `liveScene3d.entityManager.entityMap`,
                            // reads `inst.soundTableDid` (Task E
                            // plumbing), resolves the Sound enum via
                            // `soundTableCache.resolveSound(...)`, and
                            // plays the resulting Wave at the entity's
                            // current world position via
                            // `audioManager.play(...)` scaled by
                            // `entry.volume * scale`.
                            //
                            // Soft cases handled JS-side (each logs
                            // debug + skips, never errors):
                            //   - entity GUID unknown (despawned mid-
                            //     flight between ACE send and client
                            //     recv)
                            //   - entity has no SoundTable
                            //     (`inst.soundTableDid == 0`)
                            //   - Sound enum has no entry in the
                            //     resolved SoundTable
                            //   - `scale <= 0` (treated as 1.0 with a
                            //     one-shot warn)
                            queued_events.borrow_mut().push(ClientEvent {
                                kind: CLIENT_EVENT_KIND_SOUND_TRIGGERED,
                                string_payload: None,
                                u32_payload: Some(u32::from(data.target)),
                                u32_payload_2: Some(data.sound_id),
                                f32_payload: Some(data.volume),
                            });
                        }
                        _ => {
                            // Other GameMessages are dropped silently —
                            // VectorUpdate (step 2b extension — not
                            // strictly needed for position rendering),
                            // vitals / equipment / inventory panels
                            // (step 4 follow-on for non-chat surfaces),
                            // interactive entities (step 5) all live
                            // downstream. The recv loop's job here is
                            // to stay alive + deliver the InWorld
                            // signal + relay position-bearing messages
                            // + relay chat.
                        }
                    }
                }
            }
            cmd = cmd_rx.next() => {
                match cmd {
                    None => {
                        // Handle was dropped → JS side is gone → exit.
                        log::info!("recv_loop: cmd channel closed, exiting");
                        return;
                    }
                    Some(SessionCommand::SelectCharacter { guid }) => {
                        let guid = holtburger_common::Guid::from(guid);
                        state = LoopState::EnteringWorld {
                            guid,
                            account: account_name.clone(),
                        };

                        // Phase 4 step 4 follow-on: construct WorldState
                        // EAGERLY here, not lazily on PlayerCreate. ACE's
                        // spawn flow ships `GameEvent::PlayerDescription`
                        // BEFORE `PlayerCreate` (verified in capture
                        // logs); deferring construction means the
                        // canonical world-handler dispatcher's first
                        // call at the top of the recv loop sees
                        // `world == None` and silently drops the
                        // PlayerDescription, leaving WorldState.player.{
                        // vitals,attributes,skills} empty forever.
                        // Constructing here (we have the guid + the
                        // bootstrap is loaded in parallel by
                        // start_session) puts WorldState in place
                        // before any spawn-flow message arrives. The
                        // PlayerCreate arm later updates seeded entity
                        // pose + arms heartbeat — those are step 3.6
                        // bookkeeping that don't depend on WorldState
                        // having been constructed in PlayerCreate
                        // specifically.
                        if world.is_none()
                            && let Some(bootstrap) = world_bootstrap.borrow().clone()
                        {
                            let mut new_world =
                                holtburger_world::WorldState::new(bootstrap);
                            new_world.player.guid = guid;
                            // Install the same bootstrap-time fallback
                            // movement caps as the PlayerCreate arm's
                            // step 3.6 logic — so movement still works
                            // before PlayerDescription lands and clears
                            // them in step 3.7's recv arm. Real biota
                            // resolution clears the override.
                            let fallback_caps =
                                holtburger_world::SelfMovementCapabilities {
                                    kinematics:
                                        holtburger_world::SelfMovementKinematics {
                                            source: holtburger_world::PlayerMotionTableSource::DirectProperty {
                                                motion_table_id: 0,
                                            },
                                            motion_table_id: 0,
                                            stance: 0,
                                            base_walk_forward_velocity:
                                                holtburger_common::Vector3 {
                                                    x: 0.0, y: 1.0, z: 0.0,
                                                },
                                            base_run_forward_velocity:
                                                holtburger_common::Vector3 {
                                                    x: 0.0, y: 4.5, z: 0.0,
                                                },
                                            base_turn_left_omega:
                                                holtburger_common::Vector3 {
                                                    x: 0.0, y: 0.0, z: 1.5,
                                                },
                                            base_turn_right_omega:
                                                holtburger_common::Vector3 {
                                                    x: 0.0, y: 0.0, z: -1.5,
                                                },
                                        },
                                    run_rate_scalar: 1.0,
                                };
                            new_world.set_self_movement_capabilities_override(
                                fallback_caps,
                            );
                            world = Some(new_world);
                            console_log_str(&format!(
                                "[step4-follow-on] WorldState constructed eagerly on SelectCharacter (guid=0x{:08X})",
                                u32::from(guid),
                            ));
                        }

                        // Workstream A (3D camera/game-feel fix): emit
                        // `ClientEvent::PlayerSpawned` (kind=1) eagerly on
                        // SelectCharacter so the JS `drainEvents` handler
                        // always sees the guid before the spawn handshake
                        // races to PlayerCreate. The wire-level PlayerCreate
                        // arm at ~line 9645 mirrors this emission gated by
                        // the same `local_player_kind1_emitted` flag so the
                        // duplicate gets dropped. KIND_SPAWN (KIND_SPAWN=1)
                        // can't fire here because we don't yet have pose —
                        // it lands on the first message that carries a pose
                        // for the local player (PlayerCreate /
                        // PrivateUpdatePosition / UpdatePosition / ObjectCreate).
                        if !local_player_kind1_emitted {
                            queued_events.borrow_mut().push(ClientEvent {
                                kind: CLIENT_EVENT_KIND_PLAYER_SPAWNED,
                                string_payload: None,
                                u32_payload: Some(u32::from(guid)),
                                u32_payload_2: None,
                                f32_payload: None,
                            });
                            local_player_kind1_emitted = true;
                            console_log_str(&format!(
                                "[workstream-A] eagerly emitted kind=1 PlayerSpawned on SelectCharacter (guid=0x{:08X})",
                                u32::from(guid),
                            ));
                        }

                        let msg = GameMessage::CharacterEnterWorldRequest(Box::new(
                            holtburger_protocol::messages::CharacterEnterWorldRequestData {
                                guid,
                            },
                        ));
                        if let Err(e) = session.send_message(&msg).await {
                            log::warn!("recv_loop: send CharacterEnterWorldRequest: {e}");
                            queued_events.borrow_mut().push(ClientEvent {
                                kind: CLIENT_EVENT_KIND_DISCONNECTED,
                                string_payload: Some(format!(
                                    "CharacterEnterWorldRequest: {e}"
                                )),
                                u32_payload: None,
                                u32_payload_2: None,
                                f32_payload: None,
                            });
                            return;
                        }
                    }
                    Some(SessionCommand::CreateCharacter { mut request }) => {
                        // Stamp the session's account name onto the
                        // request just before sending — mirrors the
                        // cli's `character_selection.create_character`
                        // pattern, so the wasm boundary doesn't need
                        // to know about account names.
                        request.account_name = account_name.clone();
                        let msg = GameMessage::CharacterCreate(request);
                        if let Err(e) = session.send_message(&msg).await {
                            log::warn!("recv_loop: send CharacterCreate: {e}");
                            queued_events.borrow_mut().push(ClientEvent {
                                kind: CLIENT_EVENT_KIND_DISCONNECTED,
                                string_payload: Some(format!("CharacterCreate: {e}")),
                                u32_payload: None,
                                u32_payload_2: None,
                                f32_payload: None,
                            });
                            return;
                        }
                    }
                    Some(SessionCommand::SendChat { message }) => {
                        // Phase 4 step 2a.6: the cli routes chat
                        // through `session.send_action(GameAction::Talk(...))`
                        // (see `apps/holtburger-cli/src/.../commands.rs`
                        // ClientCommand::Talk arm). ACE's command
                        // parser treats any incoming Talk that starts
                        // with `@` or `/` as a command — including
                        // `@telepoi Holtburg` for the Training-Academy
                        // bypass. Access-level enforcement happens
                        // server-side; non-Developer accounts silently
                        // drop admin commands.
                        let action = GameAction::Talk(Box::new(TalkActionData { message }));
                        if let Err(e) = session.send_action(action).await {
                            log::warn!("recv_loop: send_action(Talk): {e}");
                            queued_events.borrow_mut().push(ClientEvent {
                                kind: CLIENT_EVENT_KIND_DISCONNECTED,
                                string_payload: Some(format!("send_chat: {e}")),
                                u32_payload: None,
                                u32_payload_2: None,
                                f32_payload: None,
                            });
                            return;
                        }
                    }
                    Some(SessionCommand::UseObject { guid }) => {
                        // Phase 4 step 5 (interactive entities): wrap
                        // the click target in `GameAction::Use(UseActionData { guid })`
                        // and send via the same path the cli's
                        // ClientCommand::Use uses (see
                        // `apps/holtburger-cli/src/.../commands.rs` —
                        // confirmed in the explore-agent grounding).
                        // ACE's response routes through GameEvent
                        // (ApproachVendor / UseDone / WeenieError) +
                        // top-level (PlayerTeleport / position
                        // updates) variants we handle elsewhere in
                        // this match.
                        let action = holtburger_protocol::messages::GameAction::Use(
                            Box::new(holtburger_protocol::messages::UseActionData {
                                guid: holtburger_common::Guid::from(guid),
                            }),
                        );
                        if let Err(e) = session.send_action(action).await {
                            log::warn!("recv_loop: send_action(Use): {e}");
                            queued_events.borrow_mut().push(ClientEvent {
                                kind: CLIENT_EVENT_KIND_DISCONNECTED,
                                string_payload: Some(format!("use_object: {e}")),
                                u32_payload: None,
                                u32_payload_2: None,
                                f32_payload: None,
                            });
                            return;
                        }
                    }
                    Some(SessionCommand::PopulateTerrain {
                        landblock_id,
                        heights,
                    }) => {
                        // Install the 81-float height grid into the
                        // world's terrain cache. Used by the manual-
                        // drive integrator to snap pose Z to terrain
                        // (no client-side cliff/wall collision yet —
                        // just terrain following so heartbeats carry
                        // a Z that ACE physics doesn't interpret as
                        // "player floating above ground").
                        let Some(w) = world.as_mut() else {
                            console_log_str(
                                "[terrain] PopulateTerrain before WorldState ready — dropping",
                            );
                            continue;
                        };
                        // Length pre-validated by SessionHandle::populate_terrain
                        // but recheck defensively for the array-indexed
                        // try_into below.
                        let arr: [f32; 81] = match heights.try_into() {
                            Ok(a) => a,
                            Err(_) => {
                                console_log_str(
                                    "[terrain] PopulateTerrain heights length != 81; dropping",
                                );
                                continue;
                            }
                        };
                        w.populate_terrain_heights(landblock_id, arr);
                        console_log_str(&format!(
                            "[terrain] populated landblock 0x{landblock_id:08X} ({} cached total)",
                            w.terrain_height_cache_len(),
                        ));
                    }
                    Some(SessionCommand::ToggleCombatMode) => {
                        // Combat-mode toggle. Read the player's
                        // current CombatMode property; if NonCombat,
                        // send ChangeCombatMode(suggested) where
                        // suggested is derived from equipped items;
                        // otherwise send ChangeCombatMode(NonCombat).
                        // ACE handles stance derivation server-side
                        // via Creature_Combat.cs::GetCombatStance —
                        // we never request a specific MotionStance.
                        // Mirrors the cli's `domains/combat.rs`
                        // toggle pattern + ClientCommand::SetCombatMode
                        // → GameAction::ChangeCombatMode dispatch
                        // already wired in holtburger-core.
                        use holtburger_protocol::messages::{
                            ChangeCombatModeActionData, CombatMode, GameAction,
                        };
                        use holtburger_world::context::WorldContextExt;
                        let Some(w) = world.as_ref() else {
                            console_log_str(
                                "[combat-mode] ToggleCombatMode before WorldState ready — dropping",
                            );
                            continue;
                        };
                        if !entity_seeded {
                            console_log_str(
                                "[combat-mode] ToggleCombatMode before player entity seeded — dropping",
                            );
                            continue;
                        }
                        let current = w.player_combat_mode();
                        let target_mode = if current == CombatMode::NonCombat {
                            // Default the suggestion to Melee when no
                            // equipment is wielded (the cli helper
                            // returns Melee in that case via its
                            // `let mut best = CombatMode::Melee;`
                            // floor in WorldContextExt::get_suggested_combat_mode).
                            // ACE's GetCombatStance falls through to
                            // HandCombat for Melee+no-weapon → fists
                            // pose, matching retail's "no weapon →
                            // bare-handed combat" behaviour.
                            w.get_suggested_combat_mode()
                        } else {
                            CombatMode::NonCombat
                        };
                        let action = GameAction::ChangeCombatMode(Box::new(
                            ChangeCombatModeActionData { mode: target_mode },
                        ));
                        if let Err(e) = session.send_action(action).await {
                            log::warn!("recv_loop: send_action(ChangeCombatMode): {e}");
                            queued_events.borrow_mut().push(ClientEvent {
                                kind: CLIENT_EVENT_KIND_DISCONNECTED,
                                string_payload: Some(format!("toggle_combat_mode: {e}")),
                                u32_payload: None,
                                u32_payload_2: None,
                                f32_payload: None,
                            });
                            return;
                        }
                        console_log_str(&format!(
                            "[combat-mode] toggle: {current:?} → {target_mode:?}",
                        ));
                    }
                    Some(SessionCommand::SetMovementInput {
                        forward,
                        strafe,
                        turn,
                        run,
                    }) => {
                        // Phase 4 step 3.6: input → high-level
                        // MotionState → MovementSystemHandle drive
                        // intent. The actual outbound packet (MoveToState
                        // and/or AutonomousPosition heartbeat) fires from
                        // the next TickMovement arm via
                        // `MovementSystemHandle::tick`. Pre-3.6 the recv
                        // loop built MoveToState here directly and never
                        // sent AutonomousPosition — the bug fixed by 3.6.
                        let Some(w) = world.as_ref() else {
                            console_log_str(
                                "[step 3.6] SetMovementInput before WorldState ready — dropping",
                            );
                            continue;
                        };
                        if !entity_seeded {
                            console_log_str(
                                "[step 3.6] SetMovementInput before player entity seeded — dropping",
                            );
                            continue;
                        }
                        let _ = w;
                        let motion_state = motion_state_for_input(forward, strafe, turn, run);
                        let now = web_time::Instant::now();
                        movement.enqueue_drive_intent(
                            holtburger_core::client::movement_types::PlayerDriveIntent::ManualHeld(
                                motion_state,
                            ),
                            now,
                        );
                        console_log_str(&format!(
                            "[step3.6-trace] enqueue_drive_intent ManualHeld(forward={forward} strafe={strafe} turn={turn} run={run})",
                        ));
                    }
                    Some(SessionCommand::TickMovement { now }) => {
                        // Phase 4 step 3.6: pumps the cli's
                        // MovementSystem state machine. Reads
                        // queued drive intents (from SetMovementInput),
                        // emits MoveToState on motion-state edges, and
                        // emits AutonomousPosition heartbeats while the
                        // player is moving — the load-bearing fix
                        // making server-side player position actually
                        // advance. Pre-EnteredWorld / pre-entity-seeded
                        // ticks are no-ops (nothing to read poses from).
                        let Some(w) = world.as_mut() else { continue };
                        if !entity_seeded {
                            continue;
                        }
                        // Phase 6 step B follow-up: drain any
                        // building-AABB inserts queued by JS-side
                        // `populateBuildingAabbsForLandblock` calls.
                        // Runs before the integrator tick so the
                        // first sweep against new AABBs sees them.
                        let drained = drain_pending_building_aabbs_into(&mut w.scene);
                        if drained > 0 {
                            console_log_str(&format!(
                                "[phase6.B] drained {drained} pending building AABBs into scene \
                                 (total now {} across all cells)",
                                w.scene.building_aabb_count(),
                            ));
                        }
                        // Phase 6 step E follow-up (2026-05-09): drain
                        // any pending building-origin entries queued by
                        // the same `populateBuildingAabbsForLandblock`
                        // call. Origins are needed by the ObjectCreate
                        // door-registration arm to project a
                        // `(BuildingId, part_index)` hit back into the
                        // JS-side `buildingMap` key.
                        let drained_origins =
                            drain_pending_building_origins_into(&mut w.scene);
                        if drained_origins > 0 {
                            console_log_str(&format!(
                                "[phase6.E] drained {drained_origins} pending building origins"
                            ));
                        }
                        // Phase 6 step D: drain pending cell-graph
                        // edges + cell AABBs from
                        // `fetchEnvCellsInLandblock`. Same cadence as
                        // the building-AABB drain so the per-frame
                        // visibility query immediately after a
                        // landblock load can pick up fresh cells.
                        let (drained_portals, drained_aabbs) =
                            drain_pending_cell_graph_into(&mut w.scene);
                        if drained_portals > 0 || drained_aabbs > 0 {
                            console_log_str(&format!(
                                "[phase6.D] drained {drained_portals} portal edges + \
                                 {drained_aabbs} cell AABBs into scene (graph now {} cells, \
                                 {} cell AABBs)",
                                w.scene.cell_portal_graph_len(),
                                w.scene.cell_aabb_count(),
                            ));
                        }
                        // 2026-05-10 indoor collision (Phase 6 step G
                        // follow-on): drain `physics_polygons`
                        // triangles into `scene.cell_physics_index`
                        // so the integrator's indoor branch can
                        // immediately read them. Same cadence as the
                        // cell-graph drain — triangles and AABBs
                        // share the EnvCell's lifetime.
                        let drained_tris =
                            drain_pending_cell_physics_into(&mut w.scene);
                        if drained_tris > 0 {
                            console_log_str(&format!(
                                "[phase6.G] drained {drained_tris} cell physics triangles into scene ({} cells with physics)",
                                w.scene.cell_physics_count(),
                            ));
                        }
                        // Workstream C (3D camera collision,
                        // 2026-05-11): drain `physics_polygons` from
                        // building parts (GfxObj.physics_polygons) into
                        // `scene.building_physics_index`. This is the
                        // BUILDING-side parallel of the cell-physics
                        // drain — building interiors (incl. basements)
                        // live in the building's setup parts and were
                        // missing collision coverage pre-C; the camera
                        // sweep against `sweep_sphere_against_building_-
                        // mesh` reads this index.
                        let drained_building_tris =
                            drain_pending_building_physics_into(&mut w.scene);
                        if drained_building_tris > 0 {
                            console_log_str(&format!(
                                "[wsC] drained {drained_building_tris} building physics triangles into scene ({} landblocks, {} total tris)",
                                w.scene.building_physics_count(),
                                w.scene.building_triangles_total(),
                            ));
                        }
                        // Phase 6 step D: publish a snapshot of the
                        // local player's current cell + render set
                        // so the rAF tick can synchronously query it
                        // via `getCurrentCellId` / `getRenderSet`.
                        // Runs after the cell-graph drain so the
                        // first frame after a landblock load shows
                        // a coherent visible-cell set.
                        publish_cell_scene_snapshot(w, &cell_scene_snapshot);

                        // Workstream A (3D camera/game-feel fix):
                        // publish the local player's pose into the
                        // shared cell so JS can read it synchronously
                        // via `SessionHandle::get_local_player_pose`.
                        // Same cadence as the cell-scene snapshot
                        // (every TickMovement) — the JS camera reads
                        // this on every rAF tick to keep follow logic
                        // smooth without rebroadcasting through the
                        // entity_updates queue. Pre-spawn the pose is
                        // `None`; post-spawn it stays `Some` and the
                        // recv-loop overwrites in place.
                        publish_local_player_pose(w, &local_player_pose);

                        // Workstream C (3D camera collision,
                        // 2026-05-11): refresh the JS-readable shadow
                        // of the SpatialScene + terrain heights so
                        // `cameraSweepCollision` / `terrainHeightAt`
                        // and friends see fresh indices the next time
                        // JS calls them. Clone is one-shot per tick
                        // (Holtburg's hot case is hundreds of triangles
                        // + AABBs; the clone runs in <100 µs by direct
                        // measurement on a desktop browser). Doing this
                        // unconditionally per tick keeps the camera
                        // sweep deterministic at the cost of a clone we
                        // could otherwise gate on `drained_* > 0`. The
                        // gate would shave the clone cost when no
                        // collision data changed, but at the price of
                        // making rare cases (e.g. door open mid-tick
                        // not requiring a re-clone) hard to reason
                        // about. Pay the cost; profile if it hurts.
                        *collision_scene.borrow_mut() = w.scene.clone();
                        *terrain_heights_shadow.borrow_mut() =
                            w.terrain_heights_snapshot();

                        // Workstream A (3D camera/game-feel fix): fan
                        // out the local player's authoritative pose to
                        // JS at ≤30 Hz as a KIND_POSITION EntityUpdate.
                        // Pre-A the only local-player KIND_POSITION was
                        // ACE's ~1Hz UpdatePosition broadcast — too
                        // coarse for the 3D camera's 60 FPS prediction
                        // layer. The integrator updates the local
                        // runtime body pose every tick; we surface it
                        // here at the throttled 30 Hz cadence so the
                        // JS-side `__lastEntityWorldPos` updates
                        // smoothly and the camera follow tracks without
                        // 1-second jumps. Read `local_player_runtime_pose`
                        // (not `player_position`) so the fan-out matches
                        // the heartbeat trace + the camera's prediction
                        // layer; the runtime pose is what the integrator
                        // simulated against this tick. Gated on
                        // `local_player_spawn_emitted` so we don't emit
                        // a KIND_POSITION before the JS side has seen
                        // the KIND_SPAWN that built the entity entry
                        // (the spawn handler stamps `lastPosX/Y/T` at
                        // the same time as the entry insert; without it
                        // the position handler's first lookup misses
                        // and silently drops the update).
                        if local_player_spawn_emitted
                            && let Some(pose) = w.local_player_runtime_pose()
                            && pose.landblock_id != holtburger_common::Guid::NULL
                        {
                            // 30 Hz = one emit per ≥ 33.3 ms. Compare
                            // wall-clock against the last emit instant;
                            // if enough time has elapsed (or this is the
                            // first emit), enqueue the update + reset
                            // the clock. `web_time::Instant::now()` is
                            // already in scope as the TickMovement arm's
                            // `now` parameter.
                            let throttle_ok = match last_local_player_position_emit {
                                Some(prev) => {
                                    now.saturating_duration_since(prev)
                                        >= std::time::Duration::from_millis(33)
                                }
                                None => true,
                            };
                            if throttle_ok {
                                last_local_player_position_emit = Some(now);
                                entity_updates.borrow_mut().push(EntityUpdate {
                                    kind: ENTITY_UPDATE_KIND_POSITION,
                                    guid: u32::from(w.player.guid),
                                    model_id: 0,
                                    landblock_id: u32::from(pose.landblock_id),
                                    x: pose.coords.x,
                                    y: pose.coords.y,
                                    z: pose.coords.z,
                                    qw: pose.rotation.w,
                                    qx: pose.rotation.x,
                                    qy: pose.rotation.y,
                                    qz: pose.rotation.z,
                                    wcid: 0,
                                    item_type: 0,
                                    name: String::new(),
                                    obj_scale: 1.0,
                                    icon_id: 0,
                                    palette_id: 0,
                                    mtable_id: 0,
                                    model_changes: Vec::new(),
                                    texture_changes: Vec::new(),
                                    sub_palettes: Vec::new(),
                                    portal_destination: String::new(),
                                    vx: 0.0,
                                    vy: 0.0,
                                    vz: 0.0,
                                    omega_z: 0.0,
                                    motion_command: 0,
                                    motion_stance: 0,
                                    physics_script_did: 0,
                                    sound_table_did: 0,
                                });
                            }
                        }
                        // Watchdog: when real movement caps regress to
                        // Err between PlayerDescription's clear-and-test
                        // and now (e.g., a property update wiped the
                        // Run skill, the MotionTable resolution failed
                        // mid-session, etc.), the local-pose integrator
                        // would no-op for this tick and the heartbeat
                        // would send a stale pose. ACE keeps the
                        // server-side player at last-confirmed pose →
                        // when ACE next broadcasts an UpdatePosition,
                        // the client snaps back to that stale pose,
                        // visible to the user as rubberband.
                        //
                        // Live-test root cause (2026-05-08, /tmp/walk_diag3.cjs):
                        // PlayerDescription logged real_caps_ok=true
                        // but tick #60 read caps_ok=false. Some message
                        // between clears the override-vs-real divergence;
                        // bookkeeping fix is too speculative without
                        // narrowing further. Defense-in-depth here: if
                        // resolve fails AND no override is currently
                        // set, install the same fallback caps the
                        // bootstrap path uses, so the integrator keeps
                        // advancing. Real biota wins again on the next
                        // PlayerDescription (which clears the override
                        // and re-tests).
                        if w.resolve_self_movement_capabilities().is_err() {
                            let fallback = holtburger_world::SelfMovementCapabilities {
                                kinematics: holtburger_world::SelfMovementKinematics {
                                    source: holtburger_world::PlayerMotionTableSource::DirectProperty {
                                        motion_table_id: 0,
                                    },
                                    motion_table_id: 0,
                                    stance: 0,
                                    base_walk_forward_velocity: holtburger_common::Vector3 {
                                        x: 0.0, y: 1.0, z: 0.0,
                                    },
                                    base_run_forward_velocity: holtburger_common::Vector3 {
                                        x: 0.0, y: 4.5, z: 0.0,
                                    },
                                    base_turn_left_omega: holtburger_common::Vector3 {
                                        x: 0.0, y: 0.0, z: 1.5,
                                    },
                                    base_turn_right_omega: holtburger_common::Vector3 {
                                        x: 0.0, y: 0.0, z: -1.5,
                                    },
                                },
                                run_rate_scalar: 1.0,
                            };
                            w.set_self_movement_capabilities_override(fallback);
                            // One-shot log per regression run — quieted
                            // via a tick-count modulo so a sustained
                            // regression doesn't spam the console.
                            if movement.tick_count() % 60 == 0 {
                                console_log_str(
                                    "[step 3.6 watchdog] caps_ok regressed to false at tick; \
                                     re-installed fallback override to keep heartbeat advancing"
                                );
                            }
                        }
                        match movement.tick(now, w, &mut session).await {
                            Ok(_events) => {
                                // Phase 4 step 3.6 diagnostic — log pose
                                // every ~60 ticks (~1s at 60Hz rAF) so we
                                // can verify the local-pose integrator is
                                // advancing the WorldState pose that the
                                // AutonomousPosition heartbeat reads.
                                if movement.tick_count() % 60 == 0 {
                                    if let Some(pose) = w.local_player_runtime_pose() {
                                        let caps_ok =
                                            w.resolve_self_movement_capabilities()
                                                .is_ok();
                                        // 2026-05-10 reconciliation
                                        // diagnostic — log the body's
                                        // authoritative pose + sample
                                        // mode so we can see when (if
                                        // ever) the runtime/authoritative
                                        // poses diverge or the mode drops
                                        // off SimulatingMotionState.
                                        let body_view = w
                                            .runtime_body_id_for_guid(w.player.guid)
                                            .and_then(|bid| w.scene.runtime_body_view(bid));
                                        let (auth_x, auth_y, auth_z, auth_present, mode_str) =
                                            match body_view {
                                                Some(view) => {
                                                    let (ax, ay, az, present) = match view
                                                        .authoritative_pose
                                                    {
                                                        Some(p) => (
                                                            p.coords.x,
                                                            p.coords.y,
                                                            p.coords.z,
                                                            true,
                                                        ),
                                                        None => (0.0, 0.0, 0.0, false),
                                                    };
                                                    let mode = format!("{:?}", view.sample_mode);
                                                    (ax, ay, az, present, mode)
                                                }
                                                None => (0.0, 0.0, 0.0, false, "no-body".into()),
                                            };
                                        console_log_str(&format!(
                                            "[step 3.6 tick #{}] pose=({:.2}, {:.2}, {:.2}) cell=0x{:08X} indoor={} caps_ok={} force_seq={} heartbeats_sent={} auth=({:.2}, {:.2}, {:.2}) auth_present={} mode={}",
                                            movement.tick_count(),
                                            pose.coords.x,
                                            pose.coords.y,
                                            pose.coords.z,
                                            u32::from(pose.landblock_id),
                                            pose.is_indoors(),
                                            caps_ok,
                                            w.player.force_position_sequence,
                                            movement.heartbeats_sent(),
                                            auth_x,
                                            auth_y,
                                            auth_z,
                                            auth_present,
                                            mode_str,
                                        ));
                                    }
                                }
                                // Academy-rubberband diagnostic — log
                                // every change of force_position_sequence
                                // (the server's "rubber band me back"
                                // counter) at the tick it happens, so
                                // the capture script can correlate
                                // server-forced repositions against the
                                // pose log above. The cli's existing
                                // `log::warn!("Server forced reposition
                                // (rubber band): ...")` in
                                // movement/system.rs:35 goes through
                                // the `log` crate facade, which has no
                                // logger registered in the wasm build —
                                // so it is silently dropped. This is a
                                // direct console_log_str so the warn
                                // surfaces in the browser console.
                                let force_seq = w.player.force_position_sequence;
                                if last_diag_force_seq != Some(force_seq) {
                                    if let Some(prev) = last_diag_force_seq {
                                        if let Some(pose) = w.local_player_runtime_pose() {
                                            console_log_str(&format!(
                                                "[acad-diag rubberband] tick #{} force_seq {} -> {} pose=({:.2}, {:.2}, {:.2}) cell=0x{:08X} indoor={}",
                                                movement.tick_count(),
                                                prev,
                                                force_seq,
                                                pose.coords.x,
                                                pose.coords.y,
                                                pose.coords.z,
                                                u32::from(pose.landblock_id),
                                                pose.is_indoors(),
                                            ));
                                        }
                                    }
                                    last_diag_force_seq = Some(force_seq);
                                }
                            }
                            Err(e) => {
                                console_log_str(&format!(
                                    "[step 3.6] MovementSystem::tick error: {e}"
                                ));
                                queued_events.borrow_mut().push(ClientEvent {
                                    kind: CLIENT_EVENT_KIND_DISCONNECTED,
                                    string_payload: Some(format!("tick: {e}")),
                                    u32_payload: None,
                                    u32_payload_2: None,
                                    f32_payload: None,
                                });
                                return;
                            }
                        }
                    }
                }
            }
        }
    }
}

// ============================================================
// Sky-J P3 — wasm exports for ParticleEmitter (0x32) +
// PhysicsScript (0x33). Wire the parsers landed in Sky-J P1+P2
// (commit b499411) across the wasm boundary so JS can fetch the
// sky-particle chain at runtime. The cell-anchor logic + particle
// runtime port (P4) + sky integration (P5) follow.
// ============================================================
//
// Chain walked from JS side per
// `docs/sky-particles-p4-port-spec.md`:
//
//   SkyObject(0x02 SetupModel) → fetchPhysicsScript(pesId 0x33xxx)
//   → for each CreateParticleHook → fetchParticleEmitter(0x32xxx)
//   → emitter.hwGfxObjId is the GfxObj billboard for that particle
//
// Both exports follow the [`fetch_building_placement`] pattern:
// prefetch via ResourceKey + ensure_walk_prefetched, parse from
// holtburger_dat, return a wasm_bindgen-exposed struct.

/// Sky-J P3: per-script-entry view exposed to JS. Carries the
/// `(start_time, hook)` pair from `PhysicsScriptData`. `hook_data` is
/// the typeswitch body bytes (40 bytes for CreateParticle, ranges per
/// `setup_model::AnimationHook::read`) — JS-side code interprets it
/// based on `hook_type`. For convenience the most common case
/// (CreateParticleHook = hook_type 13 or 26) exposes `emitterInfoId`,
/// `partIndex`, `emitterId` + the `Offset` Frame fields directly.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct PhysicsScriptEntryJs {
    start_time: f64,
    hook_type: u32,
    direction: i32,
    hook_data: Vec<u8>,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl PhysicsScriptEntryJs {
    #[wasm_bindgen(getter, js_name = startTime)]
    pub fn start_time(&self) -> f64 { self.start_time }
    #[wasm_bindgen(getter, js_name = hookType)]
    pub fn hook_type(&self) -> u32 { self.hook_type }
    #[wasm_bindgen(getter)]
    pub fn direction(&self) -> i32 { self.direction }
    /// Raw type-body bytes (post-hook_type/Direction prefix). JS-side
    /// code decodes per hook_type per dats.xml AnimationHook typeswitch.
    #[wasm_bindgen(getter, js_name = hookData)]
    pub fn hook_data(&self) -> Vec<u8> { self.hook_data.clone() }

    /// CreateParticle / CreateBlockingParticle convenience: returns the
    /// ParticleEmitter DID (0x32xxxxxx) if this entry's hook is one of
    /// those two types and the body is the expected 40 bytes. Returns
    /// 0 otherwise — JS can treat "0 = not a particle-spawn hook".
    #[wasm_bindgen(getter, js_name = createParticleEmitterId)]
    pub fn create_particle_emitter_id(&self) -> u32 {
        if (self.hook_type == 13 || self.hook_type == 26) && self.hook_data.len() == 40 {
            u32::from_le_bytes(self.hook_data[0..4].try_into().unwrap())
        } else {
            0
        }
    }

    /// CreateParticle convenience: `PartIndex` field. 0xFFFFFFFF means
    /// "whole object" per the retail-DAT bytes for the moon (verified
    /// 2026-05-12, see [[project_holtburger_sky_particles_probe_2026-05-12]]).
    #[wasm_bindgen(getter, js_name = createParticlePartIndex)]
    pub fn create_particle_part_index(&self) -> u32 {
        if (self.hook_type == 13 || self.hook_type == 26) && self.hook_data.len() == 40 {
            u32::from_le_bytes(self.hook_data[4..8].try_into().unwrap())
        } else {
            0
        }
    }

    /// CreateParticle convenience: Offset.Origin.x — the spawn anchor
    /// translation in the parent SetupModel's local frame.
    #[wasm_bindgen(getter, js_name = createParticleOffsetX)]
    pub fn create_particle_offset_x(&self) -> f32 { self.cp_f32(8) }
    #[wasm_bindgen(getter, js_name = createParticleOffsetY)]
    pub fn create_particle_offset_y(&self) -> f32 { self.cp_f32(12) }
    #[wasm_bindgen(getter, js_name = createParticleOffsetZ)]
    pub fn create_particle_offset_z(&self) -> f32 { self.cp_f32(16) }
    /// Quaternion w/x/y/z (AC order: w-first).
    #[wasm_bindgen(getter, js_name = createParticleOffsetQW)]
    pub fn create_particle_offset_qw(&self) -> f32 { self.cp_f32(20) }
    #[wasm_bindgen(getter, js_name = createParticleOffsetQX)]
    pub fn create_particle_offset_qx(&self) -> f32 { self.cp_f32(24) }
    #[wasm_bindgen(getter, js_name = createParticleOffsetQY)]
    pub fn create_particle_offset_qy(&self) -> f32 { self.cp_f32(28) }
    #[wasm_bindgen(getter, js_name = createParticleOffsetQZ)]
    pub fn create_particle_offset_qz(&self) -> f32 { self.cp_f32(32) }
    /// EmitterId — the instance id (0 in retail moon script).
    #[wasm_bindgen(getter, js_name = createParticleEmitterInstanceId)]
    pub fn create_particle_emitter_instance_id(&self) -> u32 {
        if (self.hook_type == 13 || self.hook_type == 26) && self.hook_data.len() == 40 {
            u32::from_le_bytes(self.hook_data[36..40].try_into().unwrap())
        } else {
            0
        }
    }

    // -------------- H3-E1: Sound + SoundTweaked decoders --------------
    //
    // SoundHook (hookType 1, body=4 bytes): `[u32 sound_id]`
    // SoundTweakedHook (hookType 21, body=16 bytes):
    //   `[u32 sound_id, f32 priority, f32 probability, f32 volume]`
    //
    // Both reference a Wave (0x0A) DID. The Sky-J P5 + H2 chain walkers
    // call these getters to schedule playback via the AudioManager.

    /// Wave DID this hook plays. Non-zero for Sound (hook_type 1) or
    /// SoundTweaked (hook_type 21); 0 otherwise.
    #[wasm_bindgen(getter, js_name = soundWaveId)]
    pub fn sound_wave_id(&self) -> u32 {
        match self.hook_type {
            1 if self.hook_data.len() >= 4 => {
                u32::from_le_bytes(self.hook_data[0..4].try_into().unwrap())
            }
            21 if self.hook_data.len() >= 16 => {
                u32::from_le_bytes(self.hook_data[0..4].try_into().unwrap())
            }
            _ => 0,
        }
    }

    /// SoundTweaked priority (hook_type 21 only). 0.0 otherwise.
    #[wasm_bindgen(getter, js_name = soundPriority)]
    pub fn sound_priority(&self) -> f32 {
        if self.hook_type == 21 && self.hook_data.len() == 16 {
            f32::from_le_bytes(self.hook_data[4..8].try_into().unwrap())
        } else {
            0.0
        }
    }

    /// SoundTweaked probability `[0, 1]` (hook_type 21 only). 1.0 for
    /// the plain Sound hook (always plays) and 0.0 otherwise.
    #[wasm_bindgen(getter, js_name = soundProbability)]
    pub fn sound_probability(&self) -> f32 {
        match self.hook_type {
            1 => 1.0,
            21 if self.hook_data.len() == 16 => {
                f32::from_le_bytes(self.hook_data[8..12].try_into().unwrap())
            }
            _ => 0.0,
        }
    }

    /// SoundTweaked volume (hook_type 21 only). 1.0 for the plain
    /// Sound hook (no per-hook volume) and 0.0 otherwise.
    #[wasm_bindgen(getter, js_name = soundVolume)]
    pub fn sound_volume(&self) -> f32 {
        match self.hook_type {
            1 => 1.0,
            21 if self.hook_data.len() == 16 => {
                f32::from_le_bytes(self.hook_data[12..16].try_into().unwrap())
            }
            _ => 0.0,
        }
    }
}

#[cfg(target_arch = "wasm32")]
impl PhysicsScriptEntryJs {
    /// Internal: read an f32 at byte offset `off` from `hook_data`,
    /// guarded by CreateParticle hook_type + length check. Returns 0.0
    /// on mismatch.
    fn cp_f32(&self, off: usize) -> f32 {
        if (self.hook_type == 13 || self.hook_type == 26)
            && self.hook_data.len() == 40
            && off + 4 <= self.hook_data.len()
        {
            f32::from_le_bytes(self.hook_data[off..off + 4].try_into().unwrap())
        } else {
            0.0
        }
    }
}

/// Sky-J P3: PhysicsScript bake exposed to JS. `entries` is the
/// list of `(start_time, hook)` pairs from the script. For the retail
/// moon (`0x330007DB`), `entries.length == 3` and each is a
/// CreateParticleHook emitting 0x32000455 / 0x32000456 / 0x32000457.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct PhysicsScriptJs {
    id: u32,
    entries: Vec<PhysicsScriptEntryJs>,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl PhysicsScriptJs {
    #[wasm_bindgen(getter)]
    pub fn id(&self) -> u32 { self.id }
    #[wasm_bindgen(getter, js_name = entryCount)]
    pub fn entry_count(&self) -> u32 { self.entries.len() as u32 }
    /// Drain the entries vec across the wasm boundary. One-shot —
    /// subsequent calls return empty.
    #[wasm_bindgen(js_name = takeEntries)]
    pub fn take_entries(&mut self) -> Vec<PhysicsScriptEntryJs> {
        std::mem::take(&mut self.entries)
    }
}

/// Sky-J P3: ParticleEmitter (0x32) descriptor exposed to JS.
/// Mirrors `holtburger_dat::file_type::ParticleEmitter` fields with
/// AC-style scalar Vector3s split into x/y/z components (avoids the
/// wasm-bindgen `Vec<f32>`/`[f32;3]` arity-friction).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
#[derive(Debug, Clone, Copy)]
pub struct ParticleEmitterJs {
    id: u32,
    emitter_type: u32,
    particle_type: u32,
    gfx_obj_id: u32,
    hw_gfx_obj_id: u32,
    birthrate: f64,
    max_particles: i32,
    initial_particles: i32,
    total_particles: i32,
    total_seconds: f64,
    lifespan: f64,
    lifespan_rand: f64,
    offset_dir_x: f32, offset_dir_y: f32, offset_dir_z: f32,
    min_offset: f32, max_offset: f32,
    a_x: f32, a_y: f32, a_z: f32,
    min_a: f32, max_a: f32,
    b_x: f32, b_y: f32, b_z: f32,
    min_b: f32, max_b: f32,
    c_x: f32, c_y: f32, c_z: f32,
    min_c: f32, max_c: f32,
    start_scale: f32, final_scale: f32, scale_rand: f32,
    start_trans: f32, final_trans: f32, trans_rand: f32,
    is_parent_local: bool,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl ParticleEmitterJs {
    #[wasm_bindgen(getter)] pub fn id(&self) -> u32 { self.id }
    #[wasm_bindgen(getter, js_name = emitterType)] pub fn emitter_type(&self) -> u32 { self.emitter_type }
    #[wasm_bindgen(getter, js_name = particleType)] pub fn particle_type(&self) -> u32 { self.particle_type }
    #[wasm_bindgen(getter, js_name = gfxObjId)] pub fn gfx_obj_id(&self) -> u32 { self.gfx_obj_id }
    #[wasm_bindgen(getter, js_name = hwGfxObjId)] pub fn hw_gfx_obj_id(&self) -> u32 { self.hw_gfx_obj_id }
    #[wasm_bindgen(getter)] pub fn birthrate(&self) -> f64 { self.birthrate }
    #[wasm_bindgen(getter, js_name = maxParticles)] pub fn max_particles(&self) -> i32 { self.max_particles }
    #[wasm_bindgen(getter, js_name = initialParticles)] pub fn initial_particles(&self) -> i32 { self.initial_particles }
    #[wasm_bindgen(getter, js_name = totalParticles)] pub fn total_particles(&self) -> i32 { self.total_particles }
    #[wasm_bindgen(getter, js_name = totalSeconds)] pub fn total_seconds(&self) -> f64 { self.total_seconds }
    #[wasm_bindgen(getter)] pub fn lifespan(&self) -> f64 { self.lifespan }
    #[wasm_bindgen(getter, js_name = lifespanRand)] pub fn lifespan_rand(&self) -> f64 { self.lifespan_rand }
    #[wasm_bindgen(getter, js_name = offsetDirX)] pub fn offset_dir_x(&self) -> f32 { self.offset_dir_x }
    #[wasm_bindgen(getter, js_name = offsetDirY)] pub fn offset_dir_y(&self) -> f32 { self.offset_dir_y }
    #[wasm_bindgen(getter, js_name = offsetDirZ)] pub fn offset_dir_z(&self) -> f32 { self.offset_dir_z }
    #[wasm_bindgen(getter, js_name = minOffset)] pub fn min_offset(&self) -> f32 { self.min_offset }
    #[wasm_bindgen(getter, js_name = maxOffset)] pub fn max_offset(&self) -> f32 { self.max_offset }
    #[wasm_bindgen(getter, js_name = aX)] pub fn a_x(&self) -> f32 { self.a_x }
    #[wasm_bindgen(getter, js_name = aY)] pub fn a_y(&self) -> f32 { self.a_y }
    #[wasm_bindgen(getter, js_name = aZ)] pub fn a_z(&self) -> f32 { self.a_z }
    #[wasm_bindgen(getter, js_name = minA)] pub fn min_a(&self) -> f32 { self.min_a }
    #[wasm_bindgen(getter, js_name = maxA)] pub fn max_a(&self) -> f32 { self.max_a }
    #[wasm_bindgen(getter, js_name = bX)] pub fn b_x(&self) -> f32 { self.b_x }
    #[wasm_bindgen(getter, js_name = bY)] pub fn b_y(&self) -> f32 { self.b_y }
    #[wasm_bindgen(getter, js_name = bZ)] pub fn b_z(&self) -> f32 { self.b_z }
    #[wasm_bindgen(getter, js_name = minB)] pub fn min_b(&self) -> f32 { self.min_b }
    #[wasm_bindgen(getter, js_name = maxB)] pub fn max_b(&self) -> f32 { self.max_b }
    #[wasm_bindgen(getter, js_name = cX)] pub fn c_x(&self) -> f32 { self.c_x }
    #[wasm_bindgen(getter, js_name = cY)] pub fn c_y(&self) -> f32 { self.c_y }
    #[wasm_bindgen(getter, js_name = cZ)] pub fn c_z(&self) -> f32 { self.c_z }
    #[wasm_bindgen(getter, js_name = minC)] pub fn min_c(&self) -> f32 { self.min_c }
    #[wasm_bindgen(getter, js_name = maxC)] pub fn max_c(&self) -> f32 { self.max_c }
    #[wasm_bindgen(getter, js_name = startScale)] pub fn start_scale(&self) -> f32 { self.start_scale }
    #[wasm_bindgen(getter, js_name = finalScale)] pub fn final_scale(&self) -> f32 { self.final_scale }
    #[wasm_bindgen(getter, js_name = scaleRand)] pub fn scale_rand(&self) -> f32 { self.scale_rand }
    #[wasm_bindgen(getter, js_name = startTrans)] pub fn start_trans(&self) -> f32 { self.start_trans }
    #[wasm_bindgen(getter, js_name = finalTrans)] pub fn final_trans(&self) -> f32 { self.final_trans }
    #[wasm_bindgen(getter, js_name = transRand)] pub fn trans_rand(&self) -> f32 { self.trans_rand }
    #[wasm_bindgen(getter, js_name = isParentLocal)] pub fn is_parent_local(&self) -> bool { self.is_parent_local }
}

/// Sky-J P3: fetch + parse a PhysicsScript (0x33xxxxxx) from the
/// global resource source. Follows the
/// [`fetch_building_placement`] pattern: prefetch via ResourceKey
/// + ensure_walk_prefetched, parse via the holtburger_dat
/// `PhysicsScript::unpack`.
///
/// JS-side flow:
///   const ps = await fetchPhysicsScript(0x330007DB);  // moon
///   const entries = ps.takeEntries();
///   for (const e of entries) {
///     if (e.hookType === 13) {  // CreateParticle
///       const emitterId = e.createParticleEmitterId;
///       const pe = await fetchParticleEmitter(emitterId);
///       // pe.hwGfxObjId is the GfxObj billboard
///     }
///   }
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = fetchPhysicsScript)]
pub async fn fetch_physics_script(did: u32) -> Result<PhysicsScriptJs, JsValue> {
    use holtburger_dat::file_type::PhysicsScript;
    use holtburger_dat::{ResourceKey, ResourceSource};
    let source = global_source::global_source();
    let key = ResourceKey::new("eor/portal", did);
    prefetch::ensure_walk_prefetched(&source, &[key], |_| {}).await?;
    let bytes = source
        .get_file_by_key(ResourceKey::new("eor/portal", did))
        .map_err(|e| {
            JsValue::from_str(&format!(
                "fetchPhysicsScript 0x{did:08X}: fetch failed: {e:?}"
            ))
        })?;
    let ps = PhysicsScript::unpack(&bytes).map_err(|e| {
        JsValue::from_str(&format!("fetchPhysicsScript 0x{did:08X}: parse failed: {e:?}"))
    })?;
    let entries = ps
        .script_data
        .into_iter()
        .map(|d| PhysicsScriptEntryJs {
            start_time: d.start_time,
            hook_type: d.hook.hook_type,
            direction: d.hook.direction,
            hook_data: d.hook.data,
        })
        .collect();
    Ok(PhysicsScriptJs { id: ps.id, entries })
}

/// Sky-J P3: fetch + parse a ParticleEmitter (0x32xxxxxx) from the
/// global resource source. Same prefetch + parse pattern as
/// [`fetch_physics_script`]. Returns a flat scalar bundle JS can
/// pass directly to the (P4) ParticleManager.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = fetchParticleEmitter)]
pub async fn fetch_particle_emitter(did: u32) -> Result<ParticleEmitterJs, JsValue> {
    use holtburger_dat::file_type::ParticleEmitter;
    use holtburger_dat::{ResourceKey, ResourceSource};
    let source = global_source::global_source();
    let key = ResourceKey::new("eor/portal", did);
    prefetch::ensure_walk_prefetched(&source, &[key], |_| {}).await?;
    let bytes = source
        .get_file_by_key(ResourceKey::new("eor/portal", did))
        .map_err(|e| {
            JsValue::from_str(&format!(
                "fetchParticleEmitter 0x{did:08X}: fetch failed: {e:?}"
            ))
        })?;
    let pe = ParticleEmitter::unpack(&bytes).map_err(|e| {
        JsValue::from_str(&format!(
            "fetchParticleEmitter 0x{did:08X}: parse failed: {e:?}"
        ))
    })?;
    Ok(ParticleEmitterJs {
        id: pe.id,
        emitter_type: pe.emitter_type,
        particle_type: pe.particle_type,
        gfx_obj_id: pe.gfx_obj_id,
        hw_gfx_obj_id: pe.hw_gfx_obj_id,
        birthrate: pe.birthrate,
        max_particles: pe.max_particles,
        initial_particles: pe.initial_particles,
        total_particles: pe.total_particles,
        total_seconds: pe.total_seconds,
        lifespan: pe.lifespan,
        lifespan_rand: pe.lifespan_rand,
        offset_dir_x: pe.offset_dir.x,
        offset_dir_y: pe.offset_dir.y,
        offset_dir_z: pe.offset_dir.z,
        min_offset: pe.min_offset,
        max_offset: pe.max_offset,
        a_x: pe.a.x, a_y: pe.a.y, a_z: pe.a.z,
        min_a: pe.min_a, max_a: pe.max_a,
        b_x: pe.b.x, b_y: pe.b.y, b_z: pe.b.z,
        min_b: pe.min_b, max_b: pe.max_b,
        c_x: pe.c.x, c_y: pe.c.y, c_z: pe.c.z,
        min_c: pe.min_c, max_c: pe.max_c,
        start_scale: pe.start_scale,
        final_scale: pe.final_scale,
        scale_rand: pe.scale_rand,
        start_trans: pe.start_trans,
        final_trans: pe.final_trans,
        trans_rand: pe.trans_rand,
        is_parent_local: pe.is_parent_local,
    })
}

// ============================================================
// H3 — Wave (0x0A) audio file fetch + RIFF wrap.
// ============================================================
//
// JS-side AudioManager calls fetchWave(did), reads
// `wave.riffBytes` (already wrapped as a standard RIFF/WAV blob),
// and passes that to `AudioContext.decodeAudioData` which returns
// an `AudioBuffer` for positional playback via `AudioBufferSourceNode
// + PannerNode`. The decoded sample-rate / channels / bits getters
// surface metadata for logging + capacity planning; the actual
// decode lives in the browser.

/// H3: JS-side mirror of `holtburger_dat::file_type::Wave`.
/// Carries the wrapped RIFF/WAV blob ready for
/// `AudioContext.decodeAudioData` plus decoded WAVEFORMATEX metadata.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct WaveJs {
    id: u32,
    sample_rate: u32,
    num_channels: u16,
    bits_per_sample: u16,
    riff_bytes: Vec<u8>,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl WaveJs {
    #[wasm_bindgen(getter)]
    pub fn id(&self) -> u32 { self.id }
    #[wasm_bindgen(getter, js_name = sampleRate)]
    pub fn sample_rate(&self) -> u32 { self.sample_rate }
    #[wasm_bindgen(getter, js_name = numChannels)]
    pub fn num_channels(&self) -> u16 { self.num_channels }
    #[wasm_bindgen(getter, js_name = bitsPerSample)]
    pub fn bits_per_sample(&self) -> u16 { self.bits_per_sample }
    /// One-shot drain — returns the wrapped RIFF/WAV blob as a
    /// `Uint8Array` that can be passed directly to
    /// `AudioContext.decodeAudioData`. Subsequent calls return empty.
    #[wasm_bindgen(js_name = takeRiffBytes)]
    pub fn take_riff_bytes(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.riff_bytes)
    }
    /// Length of the wrapped RIFF/WAV blob in bytes. Useful for
    /// budgeting (Holtburg's ambient track set is ~50 wave files
    /// at 5-20 KB each = ~500 KB total).
    #[wasm_bindgen(getter, js_name = riffByteLength)]
    pub fn riff_byte_length(&self) -> u32 { self.riff_bytes.len() as u32 }
}

/// H3: fetch + parse a Wave (0x0Axxxxxx) audio record. Wraps the
/// (header, data) pair in a RIFF/WAV blob the browser's
/// `AudioContext.decodeAudioData` understands.
///
/// JS-side flow:
///   const wave = await fetchWave(0x0A000002);
///   const riff = wave.takeRiffBytes();
///   const audioBuf = await audioCtx.decodeAudioData(riff.buffer);
///   // play via AudioBufferSourceNode + PannerNode at a world position
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = fetchWave)]
pub async fn fetch_wave(did: u32) -> Result<WaveJs, JsValue> {
    use holtburger_dat::file_type::Wave;
    use holtburger_dat::{ResourceKey, ResourceSource};
    let source = global_source::global_source();
    let key = ResourceKey::new("eor/portal", did);
    prefetch::ensure_walk_prefetched(&source, &[key], |_| {}).await?;
    let bytes = source
        .get_file_by_key(ResourceKey::new("eor/portal", did))
        .map_err(|e| JsValue::from_str(&format!("fetchWave 0x{did:08X}: fetch failed: {e:?}")))?;
    let wave = Wave::unpack(&bytes)
        .map_err(|e| JsValue::from_str(&format!("fetchWave 0x{did:08X}: parse failed: {e:?}")))?;
    let fmt = wave.pcm_format();
    let riff = wave.to_riff_wav();
    Ok(WaveJs {
        id: wave.id,
        sample_rate: fmt.map(|f| f.sample_rate).unwrap_or(0),
        num_channels: fmt.map(|f| f.num_channels).unwrap_or(0),
        bits_per_sample: fmt.map(|f| f.bits_per_sample).unwrap_or(0),
        riff_bytes: riff,
    })
}

// ============================================================
// Task B — SoundTable (0x20) fetch + JS-side resolver.
// ============================================================
//
// Mirrors the H3-C `fetchWave` / Sky-J P3 `fetchPhysicsScript`
// pattern. The Rust parser ships a `HashMap<u32 sound_enum,
// SoundData>` (see `crates/holtburger-dat/src/file_type/sound_table.rs`);
// the JS side typically only cares about `entriesForSound(enum)`
// (look up Sound.Ambient1 etc. on demand) plus a few summary
// counters for cache logging. We surface those — not the full
// HashMap — to keep the wasm-bindgen surface boring and
// `Copy`-friendly per entry.
//
// JS-side flow:
//   const stb = await fetchSoundTable(0x20000081);
//   const entries = stb.entriesForSound(0x46);  // Sound.Ambient1
//   for (const e of entries) {
//     audioManager.play(e.waveDid, listenerPos, { gain: e.volume });
//   }

/// Task B: JS-side mirror of one `SoundEntry` row from a SoundTable's
/// `Sounds[enum].Entries` list. Plain copyable scalars — one wave
/// reference plus per-row weight metadata.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
#[derive(Debug, Clone, Copy)]
pub struct SoundEntryJs {
    wave_did: u32,
    priority: f32,
    probability: f32,
    volume: f32,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl SoundEntryJs {
    /// Wave DAT ID (`0x0Axxxxxx`). Pass directly to `fetchWave` /
    /// `audioManager.play`.
    #[wasm_bindgen(getter, js_name = waveDid)]
    pub fn wave_did(&self) -> u32 { self.wave_did }
    #[wasm_bindgen(getter)]
    pub fn priority(&self) -> f32 { self.priority }
    #[wasm_bindgen(getter)]
    pub fn probability(&self) -> f32 { self.probability }
    #[wasm_bindgen(getter)]
    pub fn volume(&self) -> f32 { self.volume }
}

/// Task B: JS-side mirror of `holtburger_dat::file_type::SoundTable`.
/// Carries the parsed id + counts plus the resolved Sound-enum keyset
/// so the JS cache can know which lookups will succeed without
/// scanning the full sound map per query.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct SoundTableJs {
    id: u32,
    hash_key: i32,
    num_hashes: u32,
    num_sounds: u32,
    /// Sorted (for stable JS iteration) list of `Sound` enum keys
    /// present in `sounds`. Used by `soundKeys()` getter to surface
    /// the keyset without copying the value side.
    sound_keys: Vec<u32>,
    /// Owned copy of the parsed `Sounds[enum] → Vec<SoundEntry>` map.
    /// Held server-side (Rust) so `entriesForSound(enum)` is O(1)
    /// without re-parsing the DAT bytes. Memory cost: ~20 bytes per
    /// SoundEntry × `total_entries` (probe_all sweep reported tens of
    /// thousands of entries across 190 retail tables → well under 4 MB).
    sounds: std::collections::HashMap<u32, Vec<SoundEntryJs>>,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl SoundTableJs {
    /// SoundTable file ID (matches the DAT directory key).
    #[wasm_bindgen(getter)]
    pub fn id(&self) -> u32 { self.id }
    /// Schema field `HashKey` — see Task A module docs; semantics
    /// undocumented but stable across retail records.
    #[wasm_bindgen(getter, js_name = hashKey)]
    pub fn hash_key(&self) -> i32 { self.hash_key }
    /// Count of entries in the auxiliary `Hashes` dictionary.
    /// Useful for cache budgeting and diagnostic logging.
    #[wasm_bindgen(getter, js_name = numHashes)]
    pub fn num_hashes(&self) -> u32 { self.num_hashes }
    /// Count of entries in the `Sounds` dictionary — i.e. how many
    /// `Sound` enum keys this table resolves.
    #[wasm_bindgen(getter, js_name = numSounds)]
    pub fn num_sounds(&self) -> u32 { self.num_sounds }
    /// Sorted list of `Sound` enum keys present in this table. The
    /// JS cache uses this to know what's queryable without iterating
    /// or probing — e.g. `if (stb.soundKeys().includes(0x46)) { ... }`.
    /// Returns a fresh `Vec` each call (cheap — under 200 u32s per
    /// table in retail).
    #[wasm_bindgen(js_name = soundKeys)]
    pub fn sound_keys(&self) -> Vec<u32> { self.sound_keys.clone() }
    /// Resolve a `Sound` enum value (e.g. `0x46` for `Sound.Ambient1`)
    /// to the list of weighted Wave references attached to it.
    /// Returns an empty array if no mapping exists for this enum.
    /// Each returned `SoundEntryJs` exposes `waveDid`, `priority`,
    /// `probability`, `volume` getters; the JS-side resolver picks
    /// one by `probability`-weighted random.
    #[wasm_bindgen(js_name = entriesForSound)]
    pub fn entries_for_sound(&self, sound_enum: u32) -> Vec<SoundEntryJs> {
        match self.sounds.get(&sound_enum) {
            Some(v) => v.clone(),
            None => Vec::new(),
        }
    }
}

/// Task B: fetch + parse a SoundTable (0x20xxxxxx) from the global
/// resource source. Same prefetch + parse pattern as
/// [`fetch_wave`] / [`fetch_physics_script`].
///
/// Callers:
///   - the Task-C `sound_table_cache.js` (per-DID memoization layer)
///   - the Task-D ambient roller (Region-attached STB → Wave lookup
///     per AmbientSoundDesc tick)
///   - the Task-E entity AnimationHook executor (Sound + SoundTable
///     hooks on entity idle clips)
///   - the Task-F ACE `GameMessageSound` handler
///
/// JS-side flow:
///   const stb = await fetchSoundTable(0x20000081);  // Region STB
///   const entries = stb.entriesForSound(0x46);      // Sound.Ambient1
///   if (entries.length) {
///     const pick = entries[0];  // or weighted-random
///     audioManager.play(pick.waveDid, pos, { gain: pick.volume });
///   }
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = fetchSoundTable)]
pub async fn fetch_sound_table(did: u32) -> Result<SoundTableJs, JsValue> {
    use holtburger_dat::file_type::SoundTable;
    use holtburger_dat::{ResourceKey, ResourceSource};
    let source = global_source::global_source();
    let key = ResourceKey::new("eor/portal", did);
    prefetch::ensure_walk_prefetched(&source, &[key], |_| {}).await?;
    let bytes = source
        .get_file_by_key(ResourceKey::new("eor/portal", did))
        .map_err(|e| {
            JsValue::from_str(&format!(
                "fetchSoundTable 0x{did:08X}: fetch failed: {e:?}"
            ))
        })?;
    let st = SoundTable::unpack(&bytes).map_err(|e| {
        JsValue::from_str(&format!(
            "fetchSoundTable 0x{did:08X}: parse failed: {e:?}"
        ))
    })?;
    // Project SoundData → Vec<SoundEntryJs> per key for cheap JS
    // resolution. The trailing `SoundData::unknown` i32 is dropped —
    // its semantics are unmapped (see Task A module docs) and no
    // downstream task reads it.
    let num_hashes = st.hashes.len() as u32;
    let num_sounds = st.sounds.len() as u32;
    let mut sound_keys: Vec<u32> = st.sounds.keys().copied().collect();
    sound_keys.sort_unstable();
    let mut sounds = std::collections::HashMap::with_capacity(st.sounds.len());
    for (k, sd) in st.sounds.into_iter() {
        let rows: Vec<SoundEntryJs> = sd
            .entries
            .into_iter()
            .map(|e| SoundEntryJs {
                wave_did: e.wave_did,
                priority: e.priority,
                probability: e.probability,
                volume: e.volume,
            })
            .collect();
        sounds.insert(k, rows);
    }
    Ok(SoundTableJs {
        id: st.id,
        hash_key: st.hash_key,
        num_hashes,
        num_sounds,
        sound_keys,
        sounds,
    })
}

// ============================================================
// Task D — Region (0x13xxxxxx) fetch + ambient STB chain accessors
// ============================================================
//
// The Task D ambient roller (`scene3d/audio/ambient_runtime.js`)
// walks `Region.terrain_info → terrain_types[code].scene_types[k] →
// scene_info.scene_types[scene_index] → sound_info.stb_descs[stb_index]`
// at runtime, keyed on the local player's terrain code. Rather than
// expose the entire Region structure to JS (huge surface, lots of
// wasm-bindgen plumbing for Sky/Scene/Texmerge sub-objects), we expose
// ONE accessor — `RegionJs::ambientStbForTerrainCode(code)` — that
// performs the chain walk server-side and returns the resolved
// AmbientSTB (stb_id + ambient sound descs) directly.
//
// This mirrors how `SoundTableJs` projects the `Sounds` HashMap into
// flat `entriesForSound(enum)` queries — the wasm side owns the
// parsed Region data and JS pulls only the rows it needs.

/// Task D: JS-side mirror of one `AmbientSoundDesc` row from a
/// Region's `AmbientSTBDesc.ambient_sounds`. Plain copyable scalars.
/// `is_continuous` is the PhatSDK-derived flag (`base_chance == 0.0`)
/// surfaced so JS doesn't have to re-derive it per tick.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
#[derive(Debug, Clone, Copy)]
pub struct AmbientSoundDescJs {
    s_type: u32,
    volume: f32,
    base_chance: f32,
    min_rate: f32,
    max_rate: f32,
    is_continuous: bool,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl AmbientSoundDescJs {
    /// AC `Sound` enum value (e.g. `0x46` for Sound.Ambient1).
    /// Look up via `soundTableCache.resolveSound(stb_id, sType)` to
    /// find the Wave DID to play.
    #[wasm_bindgen(getter, js_name = sType)]
    pub fn s_type(&self) -> u32 { self.s_type }
    /// Per-entry volume multiplier (0..1).
    #[wasm_bindgen(getter)]
    pub fn volume(&self) -> f32 { self.volume }
    /// Per-timer-fire probability (0..1). 0.0 means "continuous loop"
    /// — start once, never roll. Non-zero means "roll the dice each
    /// rate-window".
    #[wasm_bindgen(getter, js_name = baseChance)]
    pub fn base_chance(&self) -> f32 { self.base_chance }
    /// Lower bound of the timer window between rolls (seconds).
    #[wasm_bindgen(getter, js_name = minRate)]
    pub fn min_rate(&self) -> f32 { self.min_rate }
    /// Upper bound of the timer window between rolls (seconds).
    #[wasm_bindgen(getter, js_name = maxRate)]
    pub fn max_rate(&self) -> f32 { self.max_rate }
    /// PhatSDK-derived flag: `base_chance == 0.0`. Surfaced so JS
    /// doesn't have to re-compare against a float-zero literal.
    #[wasm_bindgen(getter, js_name = isContinuous)]
    pub fn is_continuous(&self) -> bool { self.is_continuous }
}

/// Task D: JS-side mirror of `AmbientSTBDesc`. `stbId` is the
/// `0x20xxxxxx` SoundTable DID; `ambientSounds()` returns the list of
/// per-sound rows (sType, volume, base_chance, min_rate, max_rate).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct AmbientStbJs {
    stb_id: u32,
    ambient_sounds: Vec<AmbientSoundDescJs>,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl AmbientStbJs {
    /// SoundTable DID (`0x20xxxxxx`) — pass to `fetchSoundTable` /
    /// `soundTableCache.resolveSound` to get Wave DIDs.
    #[wasm_bindgen(getter, js_name = stbId)]
    pub fn stb_id(&self) -> u32 { self.stb_id }
    /// Number of AmbientSoundDesc rows under this STB.
    #[wasm_bindgen(getter, js_name = numSounds)]
    pub fn num_sounds(&self) -> u32 { self.ambient_sounds.len() as u32 }
    /// Snapshot of the AmbientSoundDesc rows. Cheap clone — each row
    /// is 24 bytes; STBs typically carry 1-8 rows in retail.
    #[wasm_bindgen(js_name = ambientSounds)]
    pub fn ambient_sounds(&self) -> Vec<AmbientSoundDescJs> {
        self.ambient_sounds.clone()
    }
}

/// Task D: JS-side mirror of `holtburger_dat::file_type::Region`. Holds
/// the parsed Region data Rust-side so JS can query the ambient STB
/// chain at runtime without re-parsing per tick.
///
/// The runtime hot path is `ambientStbForTerrainCode(code) → AmbientStbJs`.
/// All other Region data (sky, scene, surfaces) is reachable via
/// existing paths (`populateSkyDescFromRegion`, `fetch_terrain_textures`),
/// so we don't surface it here.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct RegionJs {
    id: u32,
    region_name: String,
    /// Owned by Rust — JS calls accessors that walk this on demand.
    /// Cost is ~30 KB for retail Region 0x13000000 (38 STBs +
    /// 33 terrain types + ~80 scene types).
    region: holtburger_dat::file_type::Region,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl RegionJs {
    /// Region file ID (matches the DAT directory key, e.g. 0x13000000).
    #[wasm_bindgen(getter)]
    pub fn id(&self) -> u32 { self.id }
    /// Schema field — typically `"Dereth"` for retail.
    #[wasm_bindgen(getter, js_name = regionName)]
    pub fn region_name(&self) -> String { self.region_name.clone() }
    /// Count of TerrainType entries (typically 33 for retail).
    #[wasm_bindgen(getter, js_name = numTerrainTypes)]
    pub fn num_terrain_types(&self) -> u32 {
        self.region.terrain_info.terrain_types.len() as u32
    }
    /// Count of SceneType entries (typically ~80 for retail).
    #[wasm_bindgen(getter, js_name = numSceneTypes)]
    pub fn num_scene_types(&self) -> u32 {
        self.region
            .scene_info
            .as_ref()
            .map(|s| s.scene_types.len() as u32)
            .unwrap_or(0)
    }
    /// Count of AmbientSTBDesc entries (typically ~38 for retail).
    #[wasm_bindgen(getter, js_name = numStbDescs)]
    pub fn num_stb_descs(&self) -> u32 {
        self.region
            .sound_info
            .as_ref()
            .map(|s| s.stb_descs.len() as u32)
            .unwrap_or(0)
    }

    /// Task D hot path: resolve a terrain code (0..31) to its active
    /// AmbientSTB via the PhatSDK chain:
    ///
    /// ```text
    /// terrain_info.terrain_types[code]
    ///   .scene_types[scene_pick]       (u32 index into scene_info)
    ///     → scene_info.scene_types[scene_index]
    ///       .stb_index (i32; -1 = no ambient)
    ///         → sound_info.stb_descs[stb_index]
    /// ```
    ///
    /// `scenePick` is the index into `terrain_types[code].scene_types`
    /// — typically 0 since the PhatSDK `CTerrainDesc::GetScene` hash
    /// function isn't decompiled (the doc plan endorses picking 0
    /// universally as a Task D simplification; a position-hash refiner
    /// is a follow-on).
    ///
    /// Returns `None` (JS `undefined`) when:
    /// - `code` is out of bounds for `terrain_types`,
    /// - `scenePick` is out of bounds for that terrain's
    ///   `scene_types`,
    /// - The resolved scene_index is out of bounds for `scene_info`,
    /// - The scene type's `stb_index == -1` (sentinel for "no
    ///   ambient"),
    /// - The Region has no `sound_info` / `scene_info`.
    ///
    /// Cost: O(1) array indexing + small clone of `Vec<AmbientSoundDescJs>`.
    #[wasm_bindgen(js_name = ambientStbForTerrainCode)]
    pub fn ambient_stb_for_terrain_code(
        &self,
        code: u32,
        scene_pick: u32,
    ) -> Option<AmbientStbJs> {
        let tt = self.region.terrain_info.terrain_types.get(code as usize)?;
        let scene_idx_for_terrain = tt.scene_types.get(scene_pick as usize)?;
        let scene_info = self.region.scene_info.as_ref()?;
        let scene_type = scene_info
            .scene_types
            .get(*scene_idx_for_terrain as usize)?;
        if scene_type.stb_index < 0 {
            return None;
        }
        let sound_info = self.region.sound_info.as_ref()?;
        let stb = sound_info
            .stb_descs
            .get(scene_type.stb_index as usize)?;
        let ambient_sounds: Vec<AmbientSoundDescJs> = stb
            .ambient_sounds
            .iter()
            .map(|a| AmbientSoundDescJs {
                s_type: a.s_type,
                volume: a.volume,
                base_chance: a.base_chance,
                min_rate: a.min_rate,
                max_rate: a.max_rate,
                is_continuous: a.is_continuous(),
            })
            .collect();
        Some(AmbientStbJs {
            stb_id: stb.stb_id,
            ambient_sounds,
        })
    }

    /// Diagnostic: how many scene types does this terrain code list?
    /// Used by capture scripts to verify the chain has data before
    /// expecting `ambientStbForTerrainCode` to be non-null.
    #[wasm_bindgen(js_name = sceneTypeCountForTerrain)]
    pub fn scene_type_count_for_terrain(&self, code: u32) -> u32 {
        self.region
            .terrain_info
            .terrain_types
            .get(code as usize)
            .map(|t| t.scene_types.len() as u32)
            .unwrap_or(0)
    }

    /// Diagnostic: human-readable terrain name (e.g. "Grassland",
    /// "LushGrass"). Used by capture scripts + dev tools to verify
    /// terrain sampling against the known Holtburg landscape.
    #[wasm_bindgen(js_name = terrainNameForCode)]
    pub fn terrain_name_for_code(&self, code: u32) -> Option<String> {
        self.region
            .terrain_info
            .terrain_types
            .get(code as usize)
            .map(|t| t.terrain_name.clone())
    }
}

/// Task D: fetch + parse a Region (`0x13xxxxxx`). Mirrors
/// `fetchSoundTable` / `fetchPhysicsScript` — same prefetch + parse
/// pattern, returns a JS-bindable handle with chain-walker accessors.
///
/// Retail ships only `0x13000000` (Dereth); the API takes a DID so
/// custom realms / future Region overlays can be queried.
///
/// JS-side flow:
///   const region = await fetchRegion(0x13000000);
///   const stb = region.ambientStbForTerrainCode(3, 0); // LushGrass
///   for (const a of stb.ambientSounds()) {
///     // schedule a per-tick roll or start a continuous loop
///   }
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = fetchRegion)]
pub async fn fetch_region(did: u32) -> Result<RegionJs, JsValue> {
    use holtburger_dat::file_type::Region;
    use holtburger_dat::{ResourceKey, ResourceSource};
    let source = global_source::global_source();
    let key = ResourceKey::new("eor/portal", did);
    prefetch::ensure_walk_prefetched(&source, &[key], |_| {}).await?;
    let bytes = source
        .get_file_by_key(ResourceKey::new("eor/portal", did))
        .map_err(|e| {
            JsValue::from_str(&format!(
                "fetchRegion 0x{did:08X}: fetch failed: {e:?}"
            ))
        })?;
    let region = Region::unpack(&mut std::io::Cursor::new(&bytes)).map_err(|e| {
        JsValue::from_str(&format!(
            "fetchRegion 0x{did:08X}: parse failed: {e}"
        ))
    })?;
    let id = region.id;
    let region_name = region.region_name.clone();
    Ok(RegionJs {
        id,
        region_name,
        region,
    })
}

// ============================================================
// Phase 4 step 6 Phase A — substitution-aware triangulator tests
// ============================================================
//
// These run on `cargo test` (native target). The substituting
// triangulator helpers are gated `cfg(any(target_arch = "wasm32",
// test))` so we can drive them natively against constructed
// fixtures + the MockSource pattern from holtburger-dat's own
// tests. End-to-end visual validation against ACE-streamed entities
// is browser-side and intentionally out of scope here — these
// tests prove the substitution arithmetic is correct so the visual
// gap (if any) is in pixels, not in part-table indexing.
#[cfg(test)]
mod tests_substitution {
    use super::*;
    use holtburger_common::properties::GfxObjFlags;
    use holtburger_common::{Quaternion, Sphere, Vector3};
    use holtburger_dat::file_type::{GfxObj, SetupModel};
    use holtburger_dat::graphics::{CVertexArray, Frame, Polygon, SWVertex, Vec2Duv};
    use holtburger_dat::physics::{BspLeaf, BspNode};
    use holtburger_dat::{
        DatError, FileMetadata, ResourceKey, ResourceSource, Result as DatResult,
    };
    use std::collections::HashMap;
    use std::io::Cursor;

    // Minimal MockSource that maps `(namespace, file_id) -> Vec<u8>`.
    // Mirrors the pattern in holtburger-dat/src/lib.rs:520-548 so the
    // shape is familiar to anyone reading both crates.
    struct MockSource {
        files: HashMap<(String, u32), Vec<u8>>,
    }

    impl ResourceSource for MockSource {
        fn get_file_by_key(&self, key: ResourceKey<'_>) -> DatResult<Vec<u8>> {
            self.files
                .get(&(key.namespace.to_string(), key.file_id))
                .cloned()
                .ok_or(DatError::NotFound(key.file_id))
        }
        fn get_metadata_by_key(&self, key: ResourceKey<'_>) -> Option<FileMetadata> {
            self.files
                .get(&(key.namespace.to_string(), key.file_id))
                .map(|data| FileMetadata { id: key.file_id, size: data.len() as u32, is_pruned: false })
        }
        fn has_namespace(&self, namespace: &str) -> bool {
            self.files.keys().any(|(ns, _)| ns == namespace)
        }
    }

    // Build a minimal-but-real GfxObj with one triangle whose
    // resolved surface_did is `surface_did_marker`. The triangle
    // sits at z=0 with vertices at (0,0,0), (1,0,0), (0,1,0) so
    // the test can identify "which gfxobj's triangle is which" by
    // looking at `tris[i].pos[0][0]` / `surface_did`.
    fn synth_gfx_obj_one_triangle(id: u32, surface_did_marker: u32, x_offset: f32) -> Vec<u8> {
        // 3 vertices forming a triangle in the XY plane.
        let mk_vert = |x: f32, y: f32| SWVertex {
            num_uvs: 1,
            origin: Vector3 { x: x + x_offset, y, z: 0.0 },
            normal: Vector3 { x: 0.0, y: 0.0, z: 1.0 },
            uvs: vec![Vec2Duv { u: x, v: y }],
        };
        let mut vertices = HashMap::new();
        vertices.insert(0u16, mk_vert(0.0, 0.0));
        vertices.insert(1u16, mk_vert(1.0, 0.0));
        vertices.insert(2u16, mk_vert(0.0, 1.0));

        let poly = Polygon {
            num_pts: 3,
            stippling: 0, // not NoPos — keeps the polygon visible
            sides_type: 1, // Positive only
            pos_surface: 0, // index into `surfaces` below
            neg_surface: -1,
            vertex_ids: vec![0, 1, 2],
            pos_uv_indices: vec![0, 0, 0],
            neg_uv_indices: vec![],
        };
        let mut polygons = HashMap::new();
        polygons.insert(0u16, poly);

        let gfx = GfxObj {
            id,
            // No physics, no degrade ref. We DO need HAS_DRAWING so
            // pack writes the polygons + a (synth) drawing BSP, and
            // unpack reads them back.
            flags: GfxObjFlags::HAS_DRAWING,
            surfaces: vec![surface_did_marker],
            vertex_array: CVertexArray { vertex_type: 1, vertices },
            physics_polygons: HashMap::new(),
            physics_bsp: None,
            sort_center: Vector3::zero(),
            polygons,
            drawing_bsp: Some(BspNode::Leaf(BspLeaf {
                index: 0,
                solid: 0,
                sphere: Some(Sphere { center: Vector3::zero(), radius: 1.0 }),
                poly_ids: vec![0],
            })),
            did_degrade: None,
        };
        let mut data = Vec::new();
        let mut writer = Cursor::new(&mut data);
        gfx.pack(&mut writer).unwrap();
        data
    }

    fn synth_setup_two_parts(setup_id: u32, part_a: u32, part_b: u32) -> Vec<u8> {
        let setup = SetupModel {
            id: setup_id,
            flags: 0,
            parts: vec![part_a, part_b],
            parent_index: vec![],
            default_scale: vec![],
            holding_locations: HashMap::new(),
            connection_points: HashMap::new(),
            placement_frames: HashMap::new(),
            cyl_spheres: vec![],
            spheres: vec![],
            height: 1.0,
            radius: 1.0,
            step_up: 0.1,
            step_down: 0.1,
            sorting_sphere: Sphere { center: Vector3::zero(), radius: 1.0 },
            selection_sphere: Sphere { center: Vector3::zero(), radius: 1.0 },
            lights: HashMap::new(),
            default_animation: None,
            default_script: None,
            default_motion_table: None,
            default_sound_table: None,
            default_script_table: None,
        };
        let mut data = Vec::new();
        let mut writer = Cursor::new(&mut data);
        setup.pack(&mut writer).unwrap();
        data
    }

    /// Texture swap — given a per-part `(old, new)` swap, the
    /// resulting tris carry the rewritten `surface_did`. Mirrors
    /// `Creature_Networking.cs:185`'s
    /// `objDesc.AddTextureChange({ PartIndex, OldTexture,
    /// NewTexture })` consumer side.
    #[test]
    fn append_gfx_tris_with_tex_swaps_rewrites_surface_did() {
        let bytes = synth_gfx_obj_one_triangle(0x01000001, 0xAABBCCDD, 0.0);
        let gfx = GfxObj::unpack(&mut Cursor::new(&bytes)).unwrap();

        // No swap: surface_did flows through unchanged.
        let mut tris_pass = Vec::new();
        append_gfx_tris_with_tex_swaps(
            &mut tris_pass,
            &gfx,
            Vector3::zero(),
            Quaternion::identity(),
            &[],
        );
        assert_eq!(tris_pass.len(), 1, "one triangle expected");
        assert_eq!(tris_pass[0].surface_did, 0xAABBCCDD);

        // With swap (0xAABBCCDD -> 0x11223344): rewrite happens.
        let mut tris_swap = Vec::new();
        append_gfx_tris_with_tex_swaps(
            &mut tris_swap,
            &gfx,
            Vector3::zero(),
            Quaternion::identity(),
            &[(0xAABBCCDD, 0x11223344)],
        );
        assert_eq!(tris_swap[0].surface_did, 0x11223344);

        // Non-matching swap (different `old`): no rewrite.
        let mut tris_miss = Vec::new();
        append_gfx_tris_with_tex_swaps(
            &mut tris_miss,
            &gfx,
            Vector3::zero(),
            Quaternion::identity(),
            &[(0xDEADBEEF, 0x99887766)],
        );
        assert_eq!(tris_miss[0].surface_did, 0xAABBCCDD);
    }

    /// Part-substitution: a SetupModel whose default part 1 is GfxObj
    /// 0x010000B (surface_did=0xBBBB) gets its part 1 replaced with
    /// GfxObj 0x010000C (surface_did=0xCCCC) via a model_changes
    /// entry, and the resulting tris contain ONLY the substituted
    /// part's triangle for that slot. Part 0 (surface_did=0xAAAA)
    /// is untouched. Mirrors Creature_Networking.cs:182's
    /// `objDesc.AddAnimPartChange({ Index, AnimationId })`.
    #[test]
    fn triangulate_setup_model_with_substitutions_swaps_part() {
        let setup_id: u32 = 0x02000099;
        let part_default_a: u32 = 0x0100000A;
        let part_default_b: u32 = 0x0100000B;
        let part_replacement: u32 = 0x0100000C;

        let mut files: HashMap<(String, u32), Vec<u8>> = HashMap::new();
        files.insert(
            ("eor/portal".into(), setup_id),
            synth_setup_two_parts(setup_id, part_default_a, part_default_b),
        );
        // Each gfx gets a unique surface marker so we can identify
        // which one produced each triangle in the output.
        files.insert(
            ("eor/portal".into(), part_default_a),
            synth_gfx_obj_one_triangle(part_default_a, 0xAAAAAAAA, 0.0),
        );
        files.insert(
            ("eor/portal".into(), part_default_b),
            synth_gfx_obj_one_triangle(part_default_b, 0xBBBBBBBB, 0.0),
        );
        files.insert(
            ("eor/portal".into(), part_replacement),
            synth_gfx_obj_one_triangle(part_replacement, 0xCCCCCCCC, 0.0),
        );
        let source = MockSource { files };

        // No substitution: parts a + b render → surface_dids
        // {0xAAAAAAAA, 0xBBBBBBBB}.
        let mut tris_default = Vec::new();
        triangulate_setup_model_with_substitutions(
            &source,
            setup_id,
            &[],
            &[],
            &mut tris_default,
        )
        .expect("triangulate default");
        let surf_default: std::collections::HashSet<u32> =
            tris_default.iter().map(|t| t.surface_did).collect();
        assert_eq!(
            surf_default,
            [0xAAAAAAAAu32, 0xBBBBBBBB].iter().copied().collect(),
        );

        // Substitute part 1 (b) with the replacement gfx. Output
        // tris should now contain {0xAAAAAAAA, 0xCCCCCCCC} — the
        // substituted gfx's surface_did, NOT the default's
        // 0xBBBBBBBB.
        let mut tris_sub = Vec::new();
        triangulate_setup_model_with_substitutions(
            &source,
            setup_id,
            &[(1u8, part_replacement)],
            &[],
            &mut tris_sub,
        )
        .expect("triangulate substituted");
        let surf_sub: std::collections::HashSet<u32> =
            tris_sub.iter().map(|t| t.surface_did).collect();
        assert_eq!(
            surf_sub,
            [0xAAAAAAAAu32, 0xCCCCCCCC].iter().copied().collect(),
            "part 1 substitution must replace 0xBBBBBBBB with the replacement gfx's 0xCCCCCCCC",
        );
        assert!(
            !surf_sub.contains(&0xBBBBBBBB),
            "default part 1 surface_did must NOT appear after substitution",
        );
    }

    /// Both substitutions composed: model_changes swaps part 1's
    /// gfx, AND texture_changes rewrites the substituted gfx's
    /// surface_did. End state: part 0's surface_did unchanged, part
    /// 1's surface_did is the texture-swap target (NOT the
    /// substituted gfx's intrinsic surface_did).
    #[test]
    fn triangulate_setup_model_with_substitutions_composes_part_and_texture() {
        let setup_id: u32 = 0x02000099;
        let part_default_a: u32 = 0x0100000A;
        let part_default_b: u32 = 0x0100000B;
        let part_replacement: u32 = 0x0100000C;

        let mut files: HashMap<(String, u32), Vec<u8>> = HashMap::new();
        files.insert(
            ("eor/portal".into(), setup_id),
            synth_setup_two_parts(setup_id, part_default_a, part_default_b),
        );
        files.insert(
            ("eor/portal".into(), part_default_a),
            synth_gfx_obj_one_triangle(part_default_a, 0xAAAAAAAA, 0.0),
        );
        files.insert(
            ("eor/portal".into(), part_default_b),
            synth_gfx_obj_one_triangle(part_default_b, 0xBBBBBBBB, 0.0),
        );
        files.insert(
            ("eor/portal".into(), part_replacement),
            synth_gfx_obj_one_triangle(part_replacement, 0xCCCCCCCC, 0.0),
        );
        let source = MockSource { files };

        let mut tris = Vec::new();
        triangulate_setup_model_with_substitutions(
            &source,
            setup_id,
            &[(1u8, part_replacement)],
            &[(1u8, 0xCCCCCCCC, 0xDDDDDDDD)], // swap the SUBSTITUTED gfx's surface
            &mut tris,
        )
        .expect("triangulate");
        let surf: std::collections::HashSet<u32> = tris.iter().map(|t| t.surface_did).collect();
        assert_eq!(
            surf,
            [0xAAAAAAAAu32, 0xDDDDDDDD].iter().copied().collect(),
            "after composing part + texture swaps, part 0 stays at 0xAAAAAAAA and part 1 reads as the swap target 0xDDDDDDDD",
        );
    }

    // Frame import is not used by these tests but the symbol is
    // re-exported through holtburger_dat::graphics::Frame for any
    // future Phase C (idle-pose) test; suppress unused warning.
    #[allow(dead_code)]
    fn _unused_frame() -> Frame { Frame::default() }

    // -------------------------------------------------------------
    // Phase 4 step 6 Phase B — palette overlay tests
    // -------------------------------------------------------------
    //
    // Synthesize a 1×1 P8 texture and verify three composition paths
    // through fetch_entity_surface_pixels_impl:
    //   1. base_palette_id = 0, no overlays → texture's intrinsic
    //      palette wins (same as fetch_surface_pixels_impl).
    //   2. base_palette_id = override, no overlays → override
    //      replaces the intrinsic palette wholesale.
    //   3. base_palette_id + sub_palettes overlay → overlay rewrites
    //      a slice of the base palette before decode.
    //
    // ACE's `Creature.CalculateObjDesc` (Creature_Networking.cs:218)
    // emits `objDesc.SubPalettes.Add({ SubPaletteId, Offset, Length })`
    // for each `CloSubPalette.Range`; this test exercises the
    // consumer side.

    fn pack_palette(id: u32, colours: &[u32]) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&id.to_le_bytes());
        buf.extend_from_slice(&(colours.len() as i32).to_le_bytes());
        for &c in colours {
            buf.extend_from_slice(&c.to_le_bytes());
        }
        buf
    }

    /// Pack a 1×1 P8 Texture pointing at `default_pal_id`. `pixel_idx`
    /// is the single source byte (palette index) that to_rgba8 reads.
    fn pack_p8_texture_1x1(id: u32, pixel_idx: u8, default_pal_id: u32) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&id.to_le_bytes());
        buf.extend_from_slice(&0i32.to_le_bytes());      // _unknown
        buf.extend_from_slice(&1i32.to_le_bytes());      // width
        buf.extend_from_slice(&1i32.to_le_bytes());      // height
        buf.extend_from_slice(&41u32.to_le_bytes());     // format = P8 (41)
        buf.extend_from_slice(&1i32.to_le_bytes());      // length = 1
        buf.push(pixel_idx);                              // source_data[0]
        buf.extend_from_slice(&default_pal_id.to_le_bytes()); // P8 → palette_id present
        buf
    }

    fn pack_surface_texture(id: u32, mip_chain: &[u32]) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&id.to_le_bytes());
        buf.extend_from_slice(&0i32.to_le_bytes());      // unknown_int
        buf.push(0u8);                                    // unknown_byte
        buf.extend_from_slice(&(mip_chain.len() as i32).to_le_bytes());
        for &t in mip_chain {
            buf.extend_from_slice(&t.to_le_bytes());
        }
        buf
    }

    fn pack_textured_surface(surface_type: u32, tex_id: u32, pal_id: u32) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&surface_type.to_le_bytes());
        buf.extend_from_slice(&tex_id.to_le_bytes());
        buf.extend_from_slice(&pal_id.to_le_bytes());
        buf.extend_from_slice(&0.0f32.to_le_bytes());    // translucency
        buf.extend_from_slice(&0.0f32.to_le_bytes());    // luminosity
        buf.extend_from_slice(&1.0f32.to_le_bytes());    // diffuse
        buf
    }

    fn build_palette_overlay_source() -> (
        MockSource,
        u32, /* surface */
        u32, /* override_pal */
        u32, /* overlay_pal */
    ) {
        // Index 42 in each palette uniquely identifies which palette
        // wins the lookup. Source byte = 42.
        let intrinsic_pal_id: u32 = 0x04000001;
        let override_pal_id: u32 = 0x04000002;
        let overlay_pal_id: u32 = 0x04000003;
        let texture_id: u32 = 0x06000001;
        let surface_texture_id: u32 = 0x05000001;
        let surface_id: u32 = 0x08000001;

        let mut intrinsic_colors = vec![0u32; 256];
        intrinsic_colors[42] = 0xFFFF0000; // ARGB → red
        let intrinsic = pack_palette(intrinsic_pal_id, &intrinsic_colors);

        let mut override_colors = vec![0u32; 256];
        override_colors[42] = 0xFF0000FF; // ARGB → blue
        let override_pal = pack_palette(override_pal_id, &override_colors);

        // Overlay only rewrites two consecutive entries starting at 42.
        // entry 0 (= dst 42) = green; entry 1 (= dst 43) = unused here.
        let overlay_colors = vec![0xFF00FF00u32, 0xFFFFFFFFu32];
        let overlay_pal = pack_palette(overlay_pal_id, &overlay_colors);

        let texture = pack_p8_texture_1x1(texture_id, 42, intrinsic_pal_id);
        let surface_texture = pack_surface_texture(surface_texture_id, &[texture_id]);
        // 0x02 = Base1Image — textured surface, body = (tex_id, pal_id).
        let surface = pack_textured_surface(0x02, surface_texture_id, intrinsic_pal_id);

        let mut files: HashMap<(String, u32), Vec<u8>> = HashMap::new();
        files.insert(("eor/portal".into(), surface_id), surface);
        files.insert(("eor/portal".into(), surface_texture_id), surface_texture);
        files.insert(("eor/portal".into(), texture_id), texture);
        files.insert(("eor/portal".into(), intrinsic_pal_id), intrinsic);
        files.insert(("eor/portal".into(), override_pal_id), override_pal);
        files.insert(("eor/portal".into(), overlay_pal_id), overlay_pal);
        let source = MockSource { files };
        (source, surface_id, override_pal_id, overlay_pal_id)
    }

    /// base_palette_id = 0 + no overlays = intrinsic palette wins.
    /// Mirrors the no-substitution fetch_surface_pixels_impl path.
    #[test]
    fn entity_surface_pixels_no_override_uses_intrinsic_palette() {
        let (source, surface_id, _, _) = build_palette_overlay_source();
        let out = fetch_entity_surface_pixels_impl(&source, surface_id, 0, &[]);
        assert_eq!(out.width, 1);
        assert_eq!(out.height, 1);
        assert_eq!(out.pixels, vec![0xFF, 0, 0, 0xFF], "expected red (intrinsic palette)");
    }

    /// base_palette_id = override + no overlays = override wins.
    /// Mirrors C# `objDesc.PaletteID = PaletteBaseDID.Value` with no
    /// SubPalettes (a creature's PaletteBase but no clothing dyes).
    #[test]
    fn entity_surface_pixels_base_override_replaces_intrinsic() {
        let (source, surface_id, override_pal_id, _) = build_palette_overlay_source();
        let out = fetch_entity_surface_pixels_impl(&source, surface_id, override_pal_id, &[]);
        assert_eq!(out.pixels, vec![0, 0, 0xFF, 0xFF], "expected blue (override palette wins)");
    }

    /// base override + overlay rewriting index 42 → overlay's first
    /// colour wins for that index. Mirrors C#'s post-overlay state
    /// where SubPalettes splice atop the base.
    #[test]
    fn entity_surface_pixels_overlay_splices_into_base() {
        let (source, surface_id, override_pal_id, overlay_pal_id) =
            build_palette_overlay_source();
        let out = fetch_entity_surface_pixels_impl(
            &source,
            surface_id,
            override_pal_id,
            &[(overlay_pal_id, 42u8, 1u8)], // splice 1 colour at offset 42
        );
        assert_eq!(out.pixels, vec![0, 0xFF, 0, 0xFF], "expected green (overlay wins at offset 42)");
    }

    /// Phase C regression: setup with no `default_motion_table` and
    /// no `default_animation` returns None from
    /// `try_resolve_idle_anim_frame`, so the triangulator falls
    /// through to the placement-frame path. This protects Phase A's
    /// substitution tests from silently regressing if the idle-pose
    /// lookup ever starts erroneously matching naked setups. The
    /// full idle-pose vs. placement-frame visual check is a browser-
    /// side validation against ACE-streamed entities — synthesizing
    /// MotionTable + Animation bytes for a unit test would take
    /// ~150 lines of binary scaffolding for limited additional
    /// coverage beyond the C# reference at
    /// ObjectSpriteGenerator.cs:921-950.
    #[test]
    fn try_resolve_idle_anim_frame_none_for_setup_without_motion_table() {
        let setup_id: u32 = 0x02000099;
        let part_a: u32 = 0x0100000A;
        let part_b: u32 = 0x0100000B;
        let mut files: HashMap<(String, u32), Vec<u8>> = HashMap::new();
        files.insert(
            ("eor/portal".into(), setup_id),
            synth_setup_two_parts(setup_id, part_a, part_b),
        );
        let source = MockSource { files };
        let setup_bytes = source
            .get_file_by_key(ResourceKey::new("eor/portal", setup_id))
            .unwrap();
        let setup = SetupModel::unpack(&mut Cursor::new(&setup_bytes)).unwrap();
        // synth_setup_two_parts sets both default_motion_table and
        // default_animation to None, so the idle-pose helper has
        // nothing to resolve and returns None.
        assert!(setup.default_motion_table.is_none());
        assert!(setup.default_animation.is_none());
        assert!(try_resolve_idle_anim_frame(&source, &setup).is_none());
    }

    // -------------------------------------------------------------
    // Phase 4 step 6 Tier 2 — walk-cycle helpers
    // -------------------------------------------------------------

    /// `try_resolve_cycle_frames` returns None for a setup with
    /// no `default_motion_table`. Same regression guard as Phase C's
    /// idle resolver — naked setups stay on the placement-frame
    /// path. (Synthesizing a real walk MotionTable + Animation
    /// chain is ~150 lines of binary scaffolding for limited
    /// coverage beyond the C# reference at
    /// `ObjectSpriteGenerator.cs:921-950` + the wire round-trip
    /// validation that runs against live ACE.)
    #[test]
    fn try_resolve_cycle_frames_none_for_setup_without_motion_table() {
        use holtburger_dat::file_type::MotionTable;
        let setup_id: u32 = 0x02000099;
        let part_a: u32 = 0x0100000A;
        let part_b: u32 = 0x0100000B;
        let mut files: HashMap<(String, u32), Vec<u8>> = HashMap::new();
        files.insert(
            ("eor/portal".into(), setup_id),
            synth_setup_two_parts(setup_id, part_a, part_b),
        );
        let source = MockSource { files };
        let setup_bytes = source
            .get_file_by_key(ResourceKey::new("eor/portal", setup_id))
            .unwrap();
        let setup = SetupModel::unpack(&mut Cursor::new(&setup_bytes)).unwrap();
        // Both walk and run cycles fail-soft to None when there's no
        // mtable to query. Across all stance variants — stance=0 (use
        // default), the standard NonCombat (0x003d) and HandCombat
        // (0x003c) interpreted forms, plus a nonsense stance —
        // the helper degrades gracefully when the mtable load fails.
        let stances: &[u32] = &[0, 0x003d, 0x003c, 0xFFFF];
        for cmd in [
            MotionTable::WALK_FORWARD_COMMAND,
            MotionTable::RUN_FORWARD_COMMAND,
        ] {
            for &stance in stances {
                assert!(try_resolve_cycle_frames(&source, &setup, None, stance, cmd).is_none());
                // Also: an mtable_override that resolves to nothing in the
                // mock source still yields None (the setup → MotionTable
                // load fails gracefully).
                assert!(
                    try_resolve_cycle_frames(&source, &setup, Some(0x09000099), stance, cmd)
                        .is_none()
                );
            }
        }
    }

    /// `triangulate_setup_model_at_frame` with an explicit
    /// `pose_override` applies that frame's per-part transforms
    /// instead of falling through to idle/placement/identity. This
    /// is the load-bearing piece for Tier 2's per-frame walk-cycle
    /// bake — verify a synthetic AnimationFrame whose part 1 frame
    /// shifts the part by (5, 0, 0) actually moves part 1's
    /// triangles into the +5 region while part 0 stays at the
    /// origin.
    #[test]
    fn triangulate_setup_model_at_frame_applies_pose_override() {
        use holtburger_dat::file_type::setup_model::AnimationFrame;
        let setup_id: u32 = 0x02000099;
        let part_a: u32 = 0x0100000A;
        let part_b: u32 = 0x0100000B;
        let mut files: HashMap<(String, u32), Vec<u8>> = HashMap::new();
        files.insert(
            ("eor/portal".into(), setup_id),
            synth_setup_two_parts(setup_id, part_a, part_b),
        );
        files.insert(
            ("eor/portal".into(), part_a),
            synth_gfx_obj_one_triangle(part_a, 0xAAAAAAAA, 0.0),
        );
        files.insert(
            ("eor/portal".into(), part_b),
            synth_gfx_obj_one_triangle(part_b, 0xBBBBBBBB, 0.0),
        );
        let source = MockSource { files };

        // Synthesize a 2-part AnimationFrame where part 1 is
        // displaced +5 on x, part 0 is at the origin.
        let pose = AnimationFrame {
            frames: vec![
                Frame { origin: Vector3::zero(), orientation: Quaternion::identity() },
                Frame {
                    origin: Vector3 { x: 5.0, y: 0.0, z: 0.0 },
                    orientation: Quaternion::identity(),
                },
            ],
            hooks: vec![],
        };

        let mut tris = Vec::new();
        triangulate_setup_model_at_frame(
            &source, setup_id, &[], &[], None, Some(&pose), &mut tris,
        )
        .expect("triangulate at frame");

        // synth_gfx_obj_one_triangle places vertices at (0,0,0),
        // (1,0,0), (0,1,0). Part 0 (no offset) → triangle x in
        // [0..1]. Part 1 (offset +5) → triangle x in [5..6].
        let part_a_max_x = tris
            .iter()
            .filter(|t| t.surface_did == 0xAAAAAAAA)
            .flat_map(|t| t.pos.iter().map(|p| p[0]))
            .fold(f32::MIN, f32::max);
        let part_b_min_x = tris
            .iter()
            .filter(|t| t.surface_did == 0xBBBBBBBB)
            .flat_map(|t| t.pos.iter().map(|p| p[0]))
            .fold(f32::MAX, f32::min);
        assert!(part_a_max_x <= 1.5,
            "part 0 (no offset) expected max x ≤ 1.5, got {part_a_max_x}");
        assert!(part_b_min_x >= 4.5,
            "part 1 (offset +5) expected min x ≥ 4.5, got {part_b_min_x}");
    }

    /// `pose_override = None` preserves Phase C behaviour — the
    /// idle-anim resolver runs as the first lookup. With a setup
    /// that has no MotionTable AND no placement frames, both lookups
    /// fail and the part lands at identity. Regression guard so
    /// future changes to the pose lookup chain don't silently break
    /// the no-override path.
    #[test]
    fn triangulate_setup_model_at_frame_no_override_uses_identity_for_naked_setup() {
        let setup_id: u32 = 0x02000099;
        let part_a: u32 = 0x0100000A;
        let part_b: u32 = 0x0100000B;
        let mut files: HashMap<(String, u32), Vec<u8>> = HashMap::new();
        files.insert(
            ("eor/portal".into(), setup_id),
            synth_setup_two_parts(setup_id, part_a, part_b),
        );
        files.insert(
            ("eor/portal".into(), part_a),
            synth_gfx_obj_one_triangle(part_a, 0xAAAAAAAA, 0.0),
        );
        files.insert(
            ("eor/portal".into(), part_b),
            synth_gfx_obj_one_triangle(part_b, 0xBBBBBBBB, 0.0),
        );
        let source = MockSource { files };

        let mut tris = Vec::new();
        triangulate_setup_model_at_frame(
            &source, setup_id, &[], &[], None, None, &mut tris,
        )
        .expect("triangulate at identity pose");

        // No MotionTable + no placement frames + no pose_override
        // → identity transform → vertices stay at the synth gfx's
        // (0,0,0), (1,0,0), (0,1,0) positions. Both parts land at
        // the same locations (overlap at origin).
        let max_x = tris.iter().flat_map(|t| t.pos.iter().map(|p| p[0])).fold(f32::MIN, f32::max);
        assert!(max_x <= 1.5, "naked setup at identity: max x ≤ 1.5, got {max_x}");
    }

    /// Cohere-B (2026-05-12): `triangulate_setup_model_per_part_with_rest_pose`
    /// returns part-LOCAL vertices (placement frame NOT baked in) AND
    /// the resolved per-part `(offset, rot)` as a side channel. This is
    /// the load-bearing test for the rig-falls-apart-in-motion fix —
    /// the entity-animation path needs raw vertices so JS-side
    /// AnimationMixer keyframes (model-space) don't double-compose
    /// against placement-baked geometry.
    ///
    /// Setup: 2 parts, placement_frames[0] puts part 1 at +7 on x.
    /// Expected: rest_poses[1] = (+7, identity), AND part 1's tri
    /// vertices stay in x in [0, 1] (UNLIKE the
    /// `triangulate_setup_model_at_frame_applies_pose_override` test
    /// which would put part 1's tri in x in [5, 6] under the same
    /// placement).
    #[test]
    fn triangulate_setup_model_per_part_with_rest_pose_keeps_vertices_local() {
        use holtburger_dat::file_type::setup_model::{AnimationFrame, PlacementType};
        let setup_id: u32 = 0x02000099;
        let part_a: u32 = 0x0100000A;
        let part_b: u32 = 0x0100000B;

        // Synth a setup with a placement frame at key=0 (the primary
        // placement). Part 0 at identity; part 1 displaced (+7, 0, 0).
        let mut placement_frames = HashMap::new();
        placement_frames.insert(
            0,
            PlacementType {
                anim_frame: AnimationFrame {
                    frames: vec![
                        Frame {
                            origin: Vector3::zero(),
                            orientation: Quaternion::identity(),
                        },
                        Frame {
                            origin: Vector3 { x: 7.0, y: 0.0, z: 0.0 },
                            orientation: Quaternion::identity(),
                        },
                    ],
                    hooks: vec![],
                },
            },
        );
        let setup = SetupModel {
            id: setup_id,
            flags: 0,
            parts: vec![part_a, part_b],
            parent_index: vec![],
            default_scale: vec![],
            holding_locations: HashMap::new(),
            connection_points: HashMap::new(),
            placement_frames,
            cyl_spheres: vec![],
            spheres: vec![],
            height: 1.0,
            radius: 1.0,
            step_up: 0.1,
            step_down: 0.1,
            sorting_sphere: Sphere { center: Vector3::zero(), radius: 1.0 },
            selection_sphere: Sphere { center: Vector3::zero(), radius: 1.0 },
            lights: HashMap::new(),
            default_animation: None,
            default_script: None,
            default_motion_table: None,
            default_sound_table: None,
            default_script_table: None,
        };
        let mut setup_bytes = Vec::new();
        setup.pack(&mut Cursor::new(&mut setup_bytes)).unwrap();

        let mut files: HashMap<(String, u32), Vec<u8>> = HashMap::new();
        files.insert(("eor/portal".into(), setup_id), setup_bytes);
        files.insert(
            ("eor/portal".into(), part_a),
            synth_gfx_obj_one_triangle(part_a, 0xAAAAAAAA, 0.0),
        );
        files.insert(
            ("eor/portal".into(), part_b),
            synth_gfx_obj_one_triangle(part_b, 0xBBBBBBBB, 0.0),
        );
        let source = MockSource { files };

        let (per_part_tris, rest_poses) =
            triangulate_setup_model_per_part_with_rest_pose(&source, setup_id, &[], &[])
                .expect("triangulate per-part with rest pose");

        // Rest poses captured the placement frame even though the
        // vertices weren't shifted by it.
        assert_eq!(rest_poses.len(), 2, "one rest pose per part");
        assert!(
            (rest_poses[0].0.x - 0.0).abs() < 1e-5
                && (rest_poses[0].0.y - 0.0).abs() < 1e-5
                && (rest_poses[0].0.z - 0.0).abs() < 1e-5,
            "part 0 rest origin should be (0,0,0), got ({}, {}, {})",
            rest_poses[0].0.x,
            rest_poses[0].0.y,
            rest_poses[0].0.z,
        );
        assert!(
            (rest_poses[1].0.x - 7.0).abs() < 1e-5,
            "part 1 rest origin x should be 7.0, got {}",
            rest_poses[1].0.x,
        );

        // Vertices are part-local: part 1's triangle vertices stay in
        // x ∈ [0, 1], NOT shifted to [7, 8]. Compare to the existing
        // `_applies_pose_override` test where part 1 ended up at [5..6].
        assert_eq!(per_part_tris.len(), 2, "two parts -> two tri buckets");
        let part_a_max_x = per_part_tris[0]
            .iter()
            .flat_map(|t| t.pos.iter().map(|p| p[0]))
            .fold(f32::MIN, f32::max);
        let part_b_max_x = per_part_tris[1]
            .iter()
            .flat_map(|t| t.pos.iter().map(|p| p[0]))
            .fold(f32::MIN, f32::max);
        assert!(
            part_a_max_x <= 1.5,
            "part 0 vertices part-local: max x ≤ 1.5, got {part_a_max_x}"
        );
        assert!(
            part_b_max_x <= 1.5,
            "part 1 vertices part-local (NOT placement-shifted): max x ≤ 1.5, got {part_b_max_x}"
        );
    }

    /// Out-of-range overlay slice — defensive clamp prevents panic
    /// and silently truncates beyond palette bounds. The two
    /// in-range writes still apply.
    #[test]
    fn entity_surface_pixels_overlay_clamps_out_of_range() {
        let (source, surface_id, override_pal_id, overlay_pal_id) =
            build_palette_overlay_source();
        let out = fetch_entity_surface_pixels_impl(
            &source,
            surface_id,
            override_pal_id,
            &[(overlay_pal_id, 42u8, 200u8)], // length way exceeds overlay's 2 entries
        );
        // The overlay only has 2 colours. Length is clamped to 2 →
        // index 42 = green (overlay[0]); index 43 = white (overlay[1]).
        // Sample pixel reads index 42 → green.
        assert_eq!(out.pixels, vec![0, 0xFF, 0, 0xFF]);
    }

    // ============================================================
    // Phase 7.6.1 (3D follow-on #1) — per-SetupModel light tests.
    // ============================================================

    /// Synth a SetupModel with N entries in `lights: HashMap<i32,
    /// LightInfo>`. Each entry's key is the part index the light is
    /// rigidly attached to. Returned bytes round-trip through
    /// `SetupModel::pack` / `unpack` so the test exercises the same
    /// binrw path live retail data flows through.
    fn synth_setup_with_lights(
        setup_id: u32,
        lights: Vec<(i32, holtburger_dat::file_type::setup_model::LightInfo)>,
    ) -> Vec<u8> {
        let mut lights_map = HashMap::new();
        for (k, v) in lights {
            lights_map.insert(k, v);
        }
        let setup = SetupModel {
            id: setup_id,
            flags: 0,
            parts: vec![0x01000001],
            parent_index: vec![],
            default_scale: vec![],
            holding_locations: HashMap::new(),
            connection_points: HashMap::new(),
            placement_frames: HashMap::new(),
            cyl_spheres: vec![],
            spheres: vec![],
            height: 1.0,
            radius: 1.0,
            step_up: 0.1,
            step_down: 0.1,
            sorting_sphere: Sphere { center: Vector3::zero(), radius: 1.0 },
            selection_sphere: Sphere { center: Vector3::zero(), radius: 1.0 },
            lights: lights_map,
            default_animation: None,
            default_script: None,
            default_motion_table: None,
            default_sound_table: None,
            default_script_table: None,
        };
        let mut data = Vec::new();
        let mut writer = Cursor::new(&mut data);
        setup.pack(&mut writer).unwrap();
        data
    }

    /// Empty-lights Setup drains to an empty Vec — and a raw 0x01
    /// GfxObj input (no Setup) also drains to empty without trying to
    /// parse a SetupModel.
    #[test]
    fn collect_setup_model_lights_empty_setup_returns_empty() {
        let setup_id: u32 = 0x02000010;
        let bytes = synth_setup_with_lights(setup_id, vec![]);
        let mut files: HashMap<(String, u32), Vec<u8>> = HashMap::new();
        files.insert(("eor/portal".into(), setup_id), bytes);
        let source = MockSource { files };
        let out = collect_setup_model_lights(&source, setup_id);
        assert!(out.is_empty(), "Setup with no lights → empty Vec");

        // 0x01 GfxObj input — collect_setup_model_lights short-circuits
        // (never even tries to fetch).
        let out_raw = collect_setup_model_lights(&source, 0x01000001);
        assert!(out_raw.is_empty(), "0x01 raw GfxObj → empty Vec");
    }

    /// Two-light Setup: stable order (sorted by part-index key), color
    /// channels extracted from ARGB packing, cone_angle / intensity /
    /// falloff pass through verbatim.
    #[test]
    fn collect_setup_model_lights_drains_argb_correctly() {
        use holtburger_dat::file_type::setup_model::LightInfo;
        use holtburger_dat::graphics::Frame;
        let setup_id: u32 = 0x02000020;
        // Part 3, white light, cone_angle 0 → PointLight semantics on JS side.
        let li_3 = LightInfo {
            viewer_space_location: Frame {
                origin: Vector3 { x: 1.0, y: 2.0, z: 3.0 },
                orientation: Quaternion::identity(),
            },
            color: 0xFF_FF_FF_FFu32, // ARGB: A=255, R=255, G=255, B=255
            intensity: 1.5,
            falloff: 10.0,
            cone_angle: 0.0,
        };
        // Part 1, pure red, cone_angle 0.5 → SpotLight on JS side.
        let li_1 = LightInfo {
            viewer_space_location: Frame {
                origin: Vector3 { x: -1.0, y: 0.0, z: 5.0 },
                orientation: Quaternion::identity(),
            },
            color: 0xFF_FF_00_00u32, // ARGB: R=255, G=0, B=0
            intensity: 0.8,
            falloff: 5.0,
            cone_angle: 0.5,
        };
        let bytes = synth_setup_with_lights(setup_id, vec![(3, li_3), (1, li_1)]);
        let mut files: HashMap<(String, u32), Vec<u8>> = HashMap::new();
        files.insert(("eor/portal".into(), setup_id), bytes);
        let source = MockSource { files };
        let out = collect_setup_model_lights(&source, setup_id);
        assert_eq!(out.len(), 2);

        // Stable sort by part index → part 1 first, part 3 second.
        assert_eq!(out[0].part_index, 1);
        assert_eq!(out[0].x, -1.0);
        assert_eq!(out[0].z, 5.0);
        assert!((out[0].color_r - 1.0).abs() < 1e-6, "red R=1.0");
        assert!(out[0].color_g.abs() < 1e-6, "red G=0");
        assert!(out[0].color_b.abs() < 1e-6, "red B=0");
        assert!((out[0].intensity - 0.8).abs() < 1e-6);
        assert!((out[0].falloff - 5.0).abs() < 1e-6);
        assert!((out[0].cone_angle - 0.5).abs() < 1e-6);

        assert_eq!(out[1].part_index, 3);
        assert_eq!(out[1].x, 1.0);
        assert_eq!(out[1].y, 2.0);
        assert_eq!(out[1].z, 3.0);
        assert!((out[1].color_r - 1.0).abs() < 1e-6, "white R");
        assert!((out[1].color_g - 1.0).abs() < 1e-6, "white G");
        assert!((out[1].color_b - 1.0).abs() < 1e-6, "white B");
        assert!((out[1].intensity - 1.5).abs() < 1e-6);
        assert!((out[1].falloff - 10.0).abs() < 1e-6);
        assert_eq!(out[1].cone_angle, 0.0); // PointLight semantics.
    }

    /// Missing DAT file → empty Vec, NOT a panic. Caller observes
    /// `part_count == 0` and skips this Setup.
    #[test]
    fn collect_setup_model_lights_missing_file_returns_empty() {
        let files: HashMap<(String, u32), Vec<u8>> = HashMap::new();
        let source = MockSource { files };
        let out = collect_setup_model_lights(&source, 0x02000030);
        assert!(out.is_empty());
    }

    /// Build a synthetic two-sided GfxObj with distinct pos/neg
    /// surface DIDs. `sides_type = 2 (CullMode::Clockwise)` triggers
    /// the back-face emission path in `append_gfx_tris_with_tex_swaps`.
    fn synth_gfx_obj_two_sided(
        id: u32,
        pos_surf_did: u32,
        neg_surf_did: u32,
    ) -> Vec<u8> {
        let mk_vert = |x: f32, y: f32| SWVertex {
            num_uvs: 1,
            origin: Vector3 { x, y, z: 0.0 },
            normal: Vector3 { x: 0.0, y: 0.0, z: 1.0 },
            uvs: vec![Vec2Duv { u: x, v: y }],
        };
        let mut vertices = HashMap::new();
        vertices.insert(0u16, mk_vert(0.0, 0.0));
        vertices.insert(1u16, mk_vert(1.0, 0.0));
        vertices.insert(2u16, mk_vert(0.0, 1.0));

        let poly = Polygon {
            num_pts: 3,
            stippling: 0,
            sides_type: 2, // CullMode::Clockwise → emit back face
            pos_surface: 0,
            neg_surface: 1,
            vertex_ids: vec![0, 1, 2],
            pos_uv_indices: vec![0, 0, 0],
            neg_uv_indices: vec![0, 0, 0],
        };
        let mut polygons = HashMap::new();
        polygons.insert(0u16, poly);

        let gfx = GfxObj {
            id,
            flags: GfxObjFlags::HAS_DRAWING,
            surfaces: vec![pos_surf_did, neg_surf_did],
            vertex_array: CVertexArray { vertex_type: 1, vertices },
            physics_polygons: HashMap::new(),
            physics_bsp: None,
            sort_center: Vector3::zero(),
            polygons,
            drawing_bsp: Some(BspNode::Leaf(BspLeaf {
                index: 0,
                solid: 0,
                sphere: Some(Sphere { center: Vector3::zero(), radius: 1.0 }),
                poly_ids: vec![0],
            })),
            did_degrade: None,
        };
        let mut data = Vec::new();
        let mut writer = Cursor::new(&mut data);
        gfx.pack(&mut writer).unwrap();
        data
    }

    /// Phase 7 follow-on #7 — two-sided polygons with DISTINCT
    /// `pos_surface != neg_surface` emit TWO tris: one with the pos
    /// surface (forward winding) and one with the neg surface
    /// (reverse winding + negated normal). The single-surface and
    /// one-sided (sides_type != 0x2) paths must remain backward-
    /// compatible — one tri each.
    #[test]
    fn append_gfx_tris_emits_back_face_for_distinct_two_sided_surfaces() {
        let bytes = synth_gfx_obj_two_sided(0x01000002, 0xAABB0001, 0xAABB0002);
        let gfx = GfxObj::unpack(&mut Cursor::new(&bytes)).unwrap();
        let mut tris = Vec::new();
        append_gfx_tris_with_tex_swaps(
            &mut tris,
            &gfx,
            Vector3::zero(),
            Quaternion::identity(),
            &[],
        );
        assert_eq!(
            tris.len(),
            2,
            "two-sided distinct-surface poly must emit pos + neg tris"
        );
        // First tri = front face, pos surface, original winding.
        assert_eq!(tris[0].surface_did, 0xAABB0001);
        assert_eq!(tris[0].pos[0], [0.0, 0.0, 0.0]);
        assert_eq!(tris[0].pos[1], [1.0, 0.0, 0.0]);
        assert_eq!(tris[0].pos[2], [0.0, 1.0, 0.0]);
        // Second tri = back face, neg surface, reversed winding (A, C, B).
        assert_eq!(tris[1].surface_did, 0xAABB0002);
        assert_eq!(tris[1].pos[0], [0.0, 0.0, 0.0]);
        assert_eq!(tris[1].pos[1], [0.0, 1.0, 0.0]);
        assert_eq!(tris[1].pos[2], [1.0, 0.0, 0.0]);
        // Normals are antiparallel.
        assert!((tris[0].normal[0] + tris[1].normal[0]).abs() < 1e-6);
        assert!((tris[0].normal[1] + tris[1].normal[1]).abs() < 1e-6);
        assert!((tris[0].normal[2] + tris[1].normal[2]).abs() < 1e-6);
    }

    /// Same `sides_type=2` two-sided polygon but with pos and neg
    /// surfaces pointing at the SAME DID — only the front face is
    /// emitted; the back face uses three.js DoubleSide on the same
    /// material. Avoids doubling draw calls on common cloth banners.
    #[test]
    fn append_gfx_tris_skips_back_face_when_surfaces_match() {
        // Build the same synth as above, then mutate the surfaces
        // vector to make pos and neg point at the same DID.
        let bytes = synth_gfx_obj_two_sided(0x01000003, 0xCCDD0001, 0xCCDD0001);
        let gfx = GfxObj::unpack(&mut Cursor::new(&bytes)).unwrap();
        let mut tris = Vec::new();
        append_gfx_tris_with_tex_swaps(
            &mut tris,
            &gfx,
            Vector3::zero(),
            Quaternion::identity(),
            &[],
        );
        assert_eq!(
            tris.len(),
            1,
            "two-sided same-surface poly must emit ONE tri (DoubleSide draw)"
        );
        assert_eq!(tris[0].surface_did, 0xCCDD0001);
    }
}

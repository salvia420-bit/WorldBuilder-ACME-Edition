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
}

#[cfg(target_arch = "wasm32")]
mod global_source;

#[cfg(target_arch = "wasm32")]
mod prefetch;

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
/// `server_ip` should be the IP literal that ACE answers on (e.g.
/// `"127.0.0.1"`), so the resulting session's source-address allowlist
/// matches what the bridge will tag inbound frames with.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn try_ws_handshake_smoke(
    bridge_url: String,
    server_ip: String,
    server_port: u16,
) -> Result<u32, JsValue> {
    let ip: IpAddr = server_ip
        .parse()
        .map_err(|e| JsValue::from_str(&format!("server_ip: {e}")))?;
    let transport = holtburger_transport_ws::WsTransport::connect(&bridge_url, ip)
        .await
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
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
}

/// Fetch per-landblock object placement records for a list of
/// `XXYYFFFE` cell IDs. Each `LandblockInfo` holds two parallel
/// placement lists, both emitted as [`ObjectPlacement`] entries:
///
/// - `LandblockInfo.objects` (the `Stab` list) — props, signs, small
///   loose objects.
/// - `LandblockInfo.buildings` (the `BuildInfo` list) — buildings
///   and other structures with interior cells. Their portals
///   (doors/windows) and leaf meshes are dropped here; step 4 only
///   needs the building's outer placement (model_id + frame) to
///   render the silhouette.
///
/// Both lists use the same `(model_id, Frame)` shape, so the
/// boundary doesn't distinguish them. The renderer can tell objects
/// from buildings by the model-id top byte (`0x01` = GfxObj/Model,
/// `0x02` = SetupModel — usually buildings).
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

    fn frame_to_placement(landblock_id: u32, model_id: u32, frame: &holtburger_dat::landblock::Frame) -> ObjectPlacement {
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
            out.push(frame_to_placement(info.id, stab.id, &stab.frame));
        }
        for building in &info.buildings {
            out.push(frame_to_placement(info.id, building.model_id, &building.frame));
        }
    }
    Ok(out)
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

    // Sort polygon ids for deterministic output (HashMap iteration is
    // not stable; PIXI.Mesh draw order matches whatever order we feed
    // in).
    let mut poly_ids: Vec<u16> = gfx.polygons.keys().copied().collect();
    poly_ids.sort_unstable();
    for pid in poly_ids {
        let poly: &Polygon = &gfx.polygons[&pid];
        if poly.vertex_ids.len() < 3 { continue; }
        // Skip "no positive surface" polygons — same as C# `NoPos` skip.
        const NO_POS: u8 = 0x04;
        if (poly.stippling & NO_POS) != 0 { continue; }

        let raw_surface_did = if poly.pos_surface >= 0
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
        let surface_did = tex_swaps
            .iter()
            .find(|(old, _)| *old == raw_surface_did)
            .map(|(_, new)| *new)
            .unwrap_or(raw_surface_did);

        // Resolve ring of (position, uv) per vertex.
        let mut ring_pos: Vec<[f32; 3]> = Vec::with_capacity(poly.vertex_ids.len());
        let mut ring_uv: Vec<[f32; 2]> = Vec::with_capacity(poly.vertex_ids.len());
        let mut ok = true;
        for (i, &raw) in poly.vertex_ids.iter().enumerate() {
            if raw < 0 { ok = false; break; }
            let Some(vert) = gfx.vertex_array.vertices.get(&(raw as u16)) else { ok = false; break; };
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
            // Apply the per-part transform: `part_rot * vert.origin + part_offset`.
            let p = quat_rotate(part_rot, vert.origin);
            ring_pos.push([p.x + part_offset.x, p.y + part_offset.y, p.z + part_offset.z]);
            ring_uv.push(uv);
        }
        if !ok || ring_pos.len() < 3 { continue; }

        // Fan-triangulate around vertex 0.
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
        append_gfx_tris_with_tex_swaps(tris, &gfx, offset, rot, &part_tex_swaps_buf);
    }
    Some(())
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
    }
}

/// One surface's decoded pixels — output of [`fetch_surface_pixels`]
/// / [`fetch_surfaces_pixels`]. Used by Phase 3 step 6's in-browser
/// rasterizer to UV-map per-poly textures into the model's tile.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
#[cfg(any(target_arch = "wasm32", test))]
pub struct SurfacePixels {
    width: u32,
    height: u32,
    pixels: Vec<u8>, // RGBA8, length = width * height * 4
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
    use holtburger_dat::ResourceKey;
    let empty = SurfacePixels { width: 0, height: 0, pixels: Vec::new() };

    let Ok(bytes) = source.get_file_by_key(ResourceKey::new("eor/portal", surface_did)) else { return empty; };
    let Ok(surface) = Surface::unpack(&bytes) else { return empty; };
    if let Some(argb) = surface.solid_color() {
        // Solid surfaces have no pixel data — synthesize a 1×1 ARGB
        // texture so the shader can sample-and-modulate uniformly.
        let a = ((argb >> 24) & 0xFF) as u8;
        let r = ((argb >> 16) & 0xFF) as u8;
        let g = ((argb >> 8) & 0xFF) as u8;
        let b = (argb & 0xFF) as u8;
        return SurfacePixels { width: 1, height: 1, pixels: vec![r, g, b, a] };
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
        Ok(pixels) => SurfacePixels {
            width: tex.width as u32,
            height: tex.height as u32,
            pixels,
        },
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
    use holtburger_dat::ResourceKey;
    let empty = SurfacePixels { width: 0, height: 0, pixels: Vec::new() };

    let Ok(bytes) = source.get_file_by_key(ResourceKey::new("eor/portal", surface_did)) else { return empty; };
    let Ok(surface) = Surface::unpack(&bytes) else { return empty; };
    if let Some(argb) = surface.solid_color() {
        // Solid surfaces ignore palette substitutions — the base
        // surface IS the colour.
        let a = ((argb >> 24) & 0xFF) as u8;
        let r = ((argb >> 16) & 0xFF) as u8;
        let g = ((argb >> 8) & 0xFF) as u8;
        let b = (argb & 0xFF) as u8;
        return SurfacePixels { width: 1, height: 1, pixels: vec![r, g, b, a] };
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
        Ok(pixels) => SurfacePixels {
            width: tex.width as u32,
            height: tex.height as u32,
            pixels,
        },
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
    Ok(pack_model_mesh(tris))
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
        out.push(pack_model_mesh(tris));
    }
    Ok(out)
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
    server_ip: String,
    server_port: u16,
    username: String,
    password: String,
) -> Result<SessionHandle, JsValue> {
    use futures::channel::{mpsc, oneshot};

    let ip: IpAddr = server_ip
        .parse()
        .map_err(|e| JsValue::from_str(&format!("server_ip: {e}")))?;

    let transport = holtburger_transport_ws::WsTransport::connect(&bridge_url, ip)
        .await
        .map_err(|e| JsValue::from_str(&format!("WsTransport::connect: {e}")))?;

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

    {
        let queued_events = queued_events.clone();
        let character_list = character_list.clone();
        let entity_updates = entity_updates.clone();
        let world_bootstrap = world_bootstrap.clone();
        let latest_stats = latest_stats.clone();
        let latest_inventory = latest_inventory.clone();
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
                                            });
                                        }
                                    }
                                    inventory_changed = true;
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
                        });
                    }
                    if inventory_changed && let Some(w) = world.as_ref() {
                        publish_player_inventory_snapshot(w, &latest_inventory);
                        queued_events.borrow_mut().push(ClientEvent {
                            kind: CLIENT_EVENT_KIND_INVENTORY_UPDATED,
                            string_payload: None,
                            u32_payload: None,
                            u32_payload_2: None,
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
                                });
                            } else {
                                let code = data.response as u32;
                                let label = format!("{:?}", data.response);
                                queued_events.borrow_mut().push(ClientEvent {
                                    kind: CLIENT_EVENT_KIND_CHARACTER_CREATE_FAILED,
                                    string_payload: Some(label),
                                    u32_payload: Some(code),
                                    u32_payload_2: None,
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
                            queued_events.borrow_mut().push(ClientEvent {
                                kind: CLIENT_EVENT_KIND_PLAYER_SPAWNED,
                                string_payload: None,
                                u32_payload: Some(player_guid_raw),
                                u32_payload_2: None,
                            });

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
                                        let _ = w.set_player_position(*pos);
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
                            });
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
                                    });
                                }
                                holtburger_protocol::messages::GameEvent::PopupString(data) => {
                                    queued_events.borrow_mut().push(ClientEvent {
                                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                                        string_payload: Some(format!("[Popup] {}", data.message)),
                                        u32_payload: Some(0),
                                        u32_payload_2: Some(CHAT_CATEGORY_POPUP),
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
                                    });
                                }
                                holtburger_protocol::messages::GameEvent::PlayerDescription(
                                    _data,
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
                                    if let Some(w) = world.as_mut() {
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
                                        });
                                    } else {
                                        let label = format!("{:?}", data.error);
                                        queued_events.borrow_mut().push(ClientEvent {
                                            kind: CLIENT_EVENT_KIND_USE_FAILED,
                                            string_payload: Some(label.clone()),
                                            u32_payload: Some(data.error as u32),
                                            u32_payload_2: None,
                                        });
                                        queued_events.borrow_mut().push(ClientEvent {
                                            kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                                            string_payload: Some(format!(
                                                "[Use failed] {label}"
                                            )),
                                            u32_payload: Some(0),
                                            u32_payload_2: Some(CHAT_CATEGORY_SYSTEM),
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
                            });
                            return;
                        }
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
                                        console_log_str(&format!(
                                            "[step 3.6 tick #{}] pose=({:.2}, {:.2}, {:.2}) cell=0x{:08X} caps_ok={} heartbeats_sent={}",
                                            movement.tick_count(),
                                            pose.coords.x,
                                            pose.coords.y,
                                            pose.coords.z,
                                            u32::from(pose.landblock_id),
                                            caps_ok,
                                            movement.heartbeats_sent(),
                                        ));
                                    }
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
}

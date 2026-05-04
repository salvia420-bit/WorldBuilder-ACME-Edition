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
    asset_url: String,
    namespace: String,
    file_id: u32,
) -> Result<u32, JsValue> {
    use holtburger_dat::{ResourceKey, ResourceSource};
    let source = holtburger_resource_http::HttpResourceSource::connect(&asset_url)
        .await
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let bytes = source
        .get_file_by_key(ResourceKey::new(&namespace, file_id))
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
pub async fn fetch_landblock_heightmap(
    asset_url: String,
    cell_id: u32,
) -> Result<LandblockMesh, JsValue> {
    let mut meshes = fetch_landblock_heightmaps(asset_url, vec![cell_id]).await?;
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
    asset_url: String,
    cell_ids: Vec<u32>,
) -> Result<Vec<LandblockMesh>, JsValue> {
    use holtburger_dat::landblock::CellLandblock;
    use holtburger_dat::{ResourceKey, ResourceSource};

    let source = holtburger_resource_http::HttpResourceSource::connect(&asset_url)
        .await
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

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
    asset_url: String,
    cell_ids: Vec<u32>,
) -> Result<Vec<ObjectPlacement>, JsValue> {
    use holtburger_dat::landblock::LandblockInfo;
    use holtburger_dat::{ResourceKey, ResourceSource};

    let source = holtburger_resource_http::HttpResourceSource::connect(&asset_url)
        .await
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

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
pub async fn fetch_terrain_textures(
    asset_url: String,
) -> Result<Vec<TerrainTexture>, JsValue> {
    use holtburger_dat::file_type::{Palette, SurfaceTexture, Texture, TextureDecodeError};
    use holtburger_dat::{ResourceKey, ResourceSource};

    let source = holtburger_resource_http::HttpResourceSource::connect(&asset_url)
        .await
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

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
fn resolve_model_color<S: holtburger_dat::ResourceSource>(
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
fn lookup_surface_color<S: holtburger_dat::ResourceSource>(
    source: &S,
    surface_id: u32,
) -> Option<u32> {
    use holtburger_dat::file_type::{Palette, Surface, Texture, TextureDecodeError};
    use holtburger_dat::ResourceKey;
    let bytes = source
        .get_file_by_key(ResourceKey::new("eor/portal", surface_id))
        .ok()?;
    let surface = Surface::unpack(&bytes).ok()?;
    if let Some(argb) = surface.solid_color() {
        return Some(argb);
    }
    // Textured path: fetch Texture (and Palette if palettized), decode
    // to RGBA8, mean every pixel. Gives 97% of retail surfaces a real
    // representative colour — solid-only would resolve <3%.
    let (tex_id, _pal_id_in_surface) = surface.textured()?;
    let tex_bytes = source
        .get_file_by_key(ResourceKey::new("eor/portal", tex_id))
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
fn walk_gfx_obj<S: holtburger_dat::ResourceSource>(
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
fn walk_setup_model<S: holtburger_dat::ResourceSource>(
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
pub async fn fetch_object_colours(
    asset_url: String,
    model_ids: Vec<u32>,
) -> Result<Vec<u32>, JsValue> {
    let source = holtburger_resource_http::HttpResourceSource::connect(&asset_url)
        .await
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let mut out = Vec::with_capacity(model_ids.len());
    for &id in &model_ids {
        out.push(resolve_model_color(&source, id).unwrap_or(0));
    }
    Ok(out)
}

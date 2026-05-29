//! Retail terrain TexMerge **selection** logic (T1, 2026-05-28).
//!
//! AC's landscape renderer does NOT bilinear-blend between cells. Each 24 m
//! cell has a `pcode` packed from its 4 corner terrain types (+ road bits);
//! the renderer picks a base terrain texture plus up to 3 alpha-masked
//! *overlays* (one per corner that differs) and up to 2 road overlays, then
//! composites them with hand-authored A8 alpha masks selected by a PRNG and
//! rotated in 90° steps. That mask-driven compositing is the iconic AC
//! "patchy splotchy" boundary look that a 4-corner colour cross-dissolve
//! mathematically cannot reproduce.
//!
//! This module ports the **deterministic selection** half — `pcode →
//! TextureMergeInfo` (base + overlays + per-overlay alpha-mask index +
//! rotation, and the road overlays). It is a faithful port of
//! `ACE.Server.Physics.Common.TexMerge` (`GetTerrain` / `BuildTCodes` /
//! `GetRoadCode` / `FindTerrainAlpha` / `FindRoadAlpha`), with ONE correction
//! taken from the retail client decompile:
//!
//! **PRNG arithmetic.** ACE computes `1379576222 * pcode - 1372186442` in
//! `long` (64-bit, no wrap). The retail client (`acclient.c:304712,304781,
//! 304804` `TexMerge::FindTerrainAlpha`/`FindRoadAlpha`) computes it in
//! **32-bit unsigned** (`(double)(1379576222 * pcode - 1372186442)` where
//! `pcode` is `unsigned int`) — i.e. it WRAPS mod 2^32 before the
//! `* 2.3283064e-10` (≈ 2^-32) scale. The wrapping form is what makes the
//! result a well-distributed index in `[0, num)`; the `long` form does not.
//! We follow acclient (the canonical renderer). See
//! [`texmerge_prng`].
//!
//! The pixel **composite** (`TexMerge::Merge` / `FillTempTexBuffer` /
//! `ImgTex::MergeTexture`) lives only in the retail client (ACE's
//! `ImgTex.MergeTexture`/`CopyCSI` are server-side stubs) and depends on
//! tiling + mask-rotation pixel conventions that warrant visual
//! confirmation; it is intentionally NOT included here. This module is the
//! deterministic, fully unit-testable foundation the composite/atlas wiring
//! builds on.

/// 90° rotation steps applied to an alpha mask. Matches
/// `LandDefs.Rotation` (`Rot0=0 … Rot270=3`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum Rotation {
    Rot0 = 0,
    Rot90 = 1,
    Rot180 = 2,
    Rot270 = 3,
}

impl Rotation {
    fn from_steps(i: u32) -> Self {
        match i & 0x3 {
            0 => Rotation::Rot0,
            1 => Rotation::Rot90,
            2 => Rotation::Rot180,
            _ => Rotation::Rot270,
        }
    }
}

/// The pseudo-terrain code AC assigns to the road overlay's base texture.
/// (`LandDefs.TerrainType.RoadType = 0x20`.) Never appears as a 5-bit corner
/// code in `pcode`; used only as the `base_terrain` for an all-road cell.
pub const ROAD_TYPE: u8 = 0x20;

/// One alpha-masked terrain overlay layered atop [`TextureMergeInfo::base_terrain`].
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct TerrainOverlay {
    /// Terrain type (0..31) sampled for this overlay.
    pub terrain: u8,
    /// The cell `tcode` (corner/side bit pattern) this overlay covers.
    pub tcode: u32,
    /// Index into the combined alpha-mask list: corner masks at `[0, numCorner)`,
    /// side masks at `[4, 4+numSide)` (the retail `baseIdx` offset).
    pub alpha_index: usize,
    /// 90° rotation to apply to the chosen mask so it matches `tcode`.
    pub rotation: Rotation,
}

/// One alpha-masked road overlay.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct RoadOverlay {
    /// The cell road code this overlay covers.
    pub rcode: u32,
    /// Index into the road-mask list offset by 5 (`5 + idx`, retail convention),
    /// or `-1` when no road mask matched.
    pub alpha_index: i32,
    pub rotation: Rotation,
}

/// Full result of `pcode → texture merge` selection.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct TextureMergeInfo {
    /// The 4 corner terrain types `[sw, se, ne, nw]` (per AC bit layout).
    pub corners: [u8; 4],
    /// `true` when all four corners carry road — the whole cell is the road
    /// texture and no overlays apply.
    pub all_road: bool,
    /// Base terrain type the cell is primarily painted with (or [`ROAD_TYPE`]).
    pub base_terrain: u8,
    /// Up to 3 alpha-masked terrain overlays.
    pub overlays: Vec<TerrainOverlay>,
    /// Up to 2 road overlays (empty when the cell has no road).
    pub roads: Vec<RoadOverlay>,
}

/// The per-Region alpha-mask code tables. The retail Dereth Region ships the
/// values in [`TexMergeTables::retail`]; passing them in keeps the selection
/// pure and lets a future runtime Region parser supply custom sets.
#[derive(Debug, Clone, PartialEq)]
pub struct TexMergeTables {
    /// Base `TCode` of each corner alpha mask (retail: four masks, all `8`).
    pub corner_tcodes: Vec<u32>,
    /// Base `TCode` of each side alpha mask (retail: one mask, `9`).
    pub side_tcodes: Vec<u32>,
    /// Base `RCode` of each road alpha mask (retail: `[9, 10, 8]`).
    pub road_rcodes: Vec<u32>,
}

impl TexMergeTables {
    /// Retail Dereth Region (`0x13000000`) TexMerge code tables, mirroring the
    /// `RETAIL_*_MASKS` constants used by the wasm alpha-mask decoder.
    pub fn retail() -> Self {
        Self {
            corner_tcodes: vec![8, 8, 8, 8],
            side_tcodes: vec![9],
            road_rcodes: vec![9, 10, 8],
        }
    }
}

/// Extract the 4 corner terrain types from a `pcode`. 5 bits each at bit
/// offsets 15 / 10 / 5 / 0 (`TexMerge::GetTerrainCodes`).
pub fn terrain_codes(pcode: u32) -> [u8; 4] {
    [
        ((pcode >> 15) & 0x1F) as u8,
        ((pcode >> 10) & 0x1F) as u8,
        ((pcode >> 5) & 0x1F) as u8,
        (pcode & 0x1F) as u8,
    ]
}

/// The TexMerge index PRNG, ported from `acclient.c` (32-bit unsigned wrap,
/// then `* 2.3283064e-10` ≈ `2^-32`, then `* num`, floored). Returns an index
/// in `[0, num)` (0 when `num == 0`). NOTE: ACE's port uses 64-bit `long`
/// here, which diverges — acclient's wrapping form is canonical.
pub fn texmerge_prng(pcode: u32, num: usize) -> usize {
    if num == 0 {
        return 0;
    }
    let v = 1379576222u32.wrapping_mul(pcode).wrapping_sub(1372186442);
    let idx = ((v as f64) * 2.3283064e-10 * (num as f64)).floor() as i64;
    if idx < 0 || idx >= num as i64 {
        0
    } else {
        idx as usize
    }
}

/// Compute the road code(s) for a cell from the road bits in `pcode`
/// (`TexMerge::GetRoadCode`). Returns `([rcode0, rcode1], all_road)`.
pub fn road_code(pcode: u32) -> ([u32; 2], bool) {
    let mut mask = 0u32;
    if pcode & 0x0C00_0000 != 0 {
        mask = 1;
    }
    if pcode & 0x0300_0000 != 0 {
        mask |= 2;
    }
    if pcode & 0x00C0_0000 != 0 {
        mask |= 4;
    }
    if pcode & 0x0030_0000 != 0 {
        mask |= 8;
    }

    match mask {
        0xF => ([0, 0], true),
        0xE => ([6, 12], false),
        0xD => ([9, 12], false),
        0xB => ([9, 3], false),
        0x7 => ([3, 6], false),
        0x0 => ([0, 0], false),
        other => ([other, 0], false),
    }
}

/// `TexMerge::GetTerrain` + `BuildTCodes`: from a `pcode`, return the base
/// terrain type and the ordered list of `(overlay_terrain, tcode)` pairs
/// (0..3 of them).
pub fn get_terrain(pcode: u32) -> (u8, Vec<(u8, u32)>) {
    let pcodes = terrain_codes(pcode);

    // First repeated corner → BuildTCodes path.
    for i in 0..4 {
        for j in (i + 1)..4 {
            if pcodes[i] == pcodes[j] {
                return build_tcodes(&pcodes, i);
            }
        }
    }

    // All four corners distinct: base = corner 0, overlays = corners 1/2/3
    // with tcodes 2/4/8 (`1 << (i+1)`).
    (
        pcodes[0],
        vec![
            (pcodes[1], 1u32 << 1),
            (pcodes[2], 1u32 << 2),
            (pcodes[3], 1u32 << 3),
        ],
    )
}

/// `TexMerge::BuildTCodes`: base = the repeated terrain `pcodes[i]`; build up
/// to 2 overlays from the remaining distinct corners.
fn build_tcodes(pcodes: &[u8; 4], i: usize) -> (u8, Vec<(u8, u32)>) {
    let t1 = pcodes[i];
    let mut t2: u8 = 0;
    let mut tcode0: u32 = 0;
    let mut tcode1: u32 = 0;
    let mut overlay1: u8 = 0;
    let mut overlay2: u8 = 0;

    for k in 0..4 {
        if t1 == pcodes[k] {
            continue;
        }
        if tcode0 == 0 {
            tcode0 = 1u32 << k;
            t2 = pcodes[k];
            overlay1 = t2;
        } else {
            if t2 == pcodes[k] && tcode0 == (1u32 << (k - 1)) {
                tcode0 += 1u32 << k;
            } else {
                overlay2 = pcodes[k];
                tcode1 = 1u32 << k;
            }
            break;
        }
    }

    let mut overlays = Vec::new();
    if tcode0 != 0 {
        overlays.push((overlay1, tcode0));
    }
    if tcode1 != 0 {
        overlays.push((overlay2, tcode1));
    }
    (t1, overlays)
}

/// `TexMerge::FindTerrainAlpha`: pick an alpha mask (corner or side set) via
/// the PRNG and rotate it to match `tcode`. Returns `(rotation, alpha_index)`,
/// or `None` when no rotation matches (the whole merge then fails, matching
/// the canonical `return null`).
pub fn find_terrain_alpha(
    pcode: u32,
    tcode: u32,
    tables: &TexMergeTables,
) -> Option<(Rotation, usize)> {
    // Corner tcodes are single-bit (1/2/4/8) → CornerTerrainMaps (baseIdx 0);
    // anything else (side patterns) → SideTerrainMaps (baseIdx 4).
    let (maps, base_idx) = if tcode != 1 && tcode != 2 && tcode != 4 && tcode != 8 {
        (&tables.side_tcodes, 4usize)
    } else {
        (&tables.corner_tcodes, 0usize)
    };
    if maps.is_empty() {
        return None;
    }
    let prng = texmerge_prng(pcode, maps.len());
    let alpha_index = base_idx + prng;

    let mut alpha_code = maps[prng];
    let mut steps = 0u32;
    while alpha_code != tcode {
        alpha_code *= 2;
        if alpha_code >= 16 {
            alpha_code -= 15;
        }
        steps += 1;
        if steps >= 4 {
            return None;
        }
    }
    Some((Rotation::from_steps(steps), alpha_index))
}

/// `TexMerge::FindRoadAlpha`: scan road masks from a PRNG offset, rotating
/// each to match `rcode`. Returns `(rotation, alpha_index)`; `alpha_index`
/// is `-1` when no mask matches.
pub fn find_road_alpha(pcode: u32, rcode: u32, tables: &TexMergeTables) -> (Rotation, i32) {
    let num = tables.road_rcodes.len();
    if num == 0 {
        return (Rotation::Rot0, -1);
    }
    let prng = texmerge_prng(pcode, num);
    for i in 0..num {
        let idx = (i + prng) % num;
        let mut alpha_code = tables.road_rcodes[idx];
        for j in 0..4u32 {
            if alpha_code == rcode {
                return (Rotation::from_steps(j), (5 + idx) as i32);
            }
            alpha_code *= 2;
            if alpha_code >= 16 {
                alpha_code -= 15;
            }
        }
    }
    (Rotation::Rot0, -1)
}

/// Top-level `pcode → TextureMergeInfo` (mirrors `TexMerge::BuildTexture`).
/// Returns `None` only when a terrain overlay's alpha mask cannot be rotated
/// to match (the canonical `BuildTexture` returns null in that case).
pub fn texture_merge_info(pcode: u32, tables: &TexMergeTables) -> Option<TextureMergeInfo> {
    let corners = terrain_codes(pcode);
    let (rcode, all_road) = road_code(pcode);

    if all_road {
        return Some(TextureMergeInfo {
            corners,
            all_road: true,
            base_terrain: ROAD_TYPE,
            overlays: Vec::new(),
            roads: Vec::new(),
        });
    }

    let (base_terrain, overlay_codes) = get_terrain(pcode);

    let mut overlays = Vec::new();
    for (terrain, tcode) in overlay_codes {
        if tcode == 0 {
            break;
        }
        let (rotation, alpha_index) = find_terrain_alpha(pcode, tcode, tables)?;
        overlays.push(TerrainOverlay {
            terrain,
            tcode,
            alpha_index,
            rotation,
        });
    }

    let mut roads = Vec::new();
    for &rc in &rcode {
        if rc == 0 {
            break;
        }
        let (rotation, alpha_index) = find_road_alpha(pcode, rc, tables);
        roads.push(RoadOverlay {
            rcode: rc,
            alpha_index,
            rotation,
        });
    }

    Some(TextureMergeInfo {
        corners,
        all_road: false,
        base_terrain,
        overlays,
        roads,
    })
}

/// The atlas layer index AC reserves for the road texture (terrain code 32).
/// Distinct from [`ROAD_TYPE`] (0x20), which is the *pseudo-terrain* code in a
/// pcode; the renderer's atlas packs the road tile at layer 32.
pub const ROAD_ATLAS_LAYER: u8 = 32;

/// Sentinel for "no alpha mask" in a packed GPU record's mask-index byte
/// (the base layer has full coverage; absent overlays are flagged via the
/// validity byte). 255 because valid mask indices are 0..7.
pub const NO_ALPHA_MASK: u8 = 255;

/// Pack a cell's 4 corner terrain types + 4 corner road codes into a `pcode`,
/// matching acclient's `GetTerrainCodes` layout (`acclient.c:305304-305309`):
/// the 5-bit corner codes sit at bit offsets 15/10/5/0 and the 2-bit road
/// fields at offsets 26/24/22/20. **Corners are supplied in acclient's order
/// `[bit15, bit10, bit5, bit0]`** — i.e. the index `k` of each corner is the
/// one whose overlay tcode is `1 << k` (`BuildTCodes`), which by the alpha-mask
/// authoring is `[NW(1), NE(2), SE(4), SW(8)]`. `road[k]` (0..3) sits in the
/// same corner order; any nonzero value marks that corner as road (matches
/// `GetRoadCode`'s `pcode & mask != 0` test).
pub fn pack_pcode(corners: [u8; 4], road: [u8; 4]) -> u32 {
    let mut p = ((corners[0] as u32 & 0x1F) << 15)
        | ((corners[1] as u32 & 0x1F) << 10)
        | ((corners[2] as u32 & 0x1F) << 5)
        | (corners[3] as u32 & 0x1F);
    // Road 2-bit fields at offsets 26/24/22/20 (corner k → 26 - 2k), mirroring
    // GetRoadCode's masks 0x0C000000 / 0x03000000 / 0x00C00000 / 0x00300000.
    for (k, &r) in road.iter().enumerate() {
        p |= ((r as u32) & 0x3) << (26 - 2 * k);
    }
    p
}

/// One slot of a packed GPU merge record: `[atlas_layer, alpha_mask_index,
/// rotation, valid]`. `valid == 0` means the slot is empty (the shader skips
/// it). For the base slot `alpha_mask_index == NO_ALPHA_MASK` (full coverage).
pub type MergeSlot = [u8; 4];

/// Number of slots in a packed per-cell GPU record: 1 base + 3 terrain
/// overlays + 2 road overlays.
pub const MERGE_SLOTS: usize = 6;

/// Pack a [`TextureMergeInfo`] into [`MERGE_SLOTS`] fixed GPU slots for the
/// terrain shader. Slot 0 = base; slots 1..=3 = terrain overlays (padded with
/// empty slots); slots 4..=5 = road overlays.
///
/// `alpha_mask_index` is the layer into the combined alpha-mask
/// `sampler2DArray` the JS side builds: corner masks `[0,4)`, side mask at `4`,
/// road masks `[5,8)` — exactly the `alpha_index` values
/// [`find_terrain_alpha`]/[`find_road_alpha`] already produce.
pub fn pack_merge_record(info: &TextureMergeInfo) -> [MergeSlot; MERGE_SLOTS] {
    let mut slots = [[0u8; 4]; MERGE_SLOTS];
    // Slot 0 — base (always valid, no mask → full coverage).
    slots[0] = [info.base_terrain, NO_ALPHA_MASK, 0, 255];
    // Slots 1..=3 — terrain overlays.
    for (i, ov) in info.overlays.iter().take(3).enumerate() {
        slots[1 + i] = [ov.terrain, ov.alpha_index as u8, ov.rotation as u8, 255];
    }
    // Slots 4..=5 — road overlays (skip any whose alpha mask didn't match).
    let mut ri = 0usize;
    for road in info.roads.iter() {
        if road.alpha_index < 0 || ri >= 2 {
            continue;
        }
        slots[4 + ri] = [
            ROAD_ATLAS_LAYER,
            road.alpha_index as u8,
            road.rotation as u8,
            255,
        ];
        ri += 1;
    }
    slots
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pack 4 corner terrain types into the 5-bit-per-corner pcode layout.
    fn pack(sw: u8, se: u8, ne: u8, nw: u8) -> u32 {
        ((sw as u32 & 0x1F) << 15)
            | ((se as u32 & 0x1F) << 10)
            | ((ne as u32 & 0x1F) << 5)
            | (nw as u32 & 0x1F)
    }

    #[test]
    fn terrain_codes_extracts_four_corners() {
        let pcode = pack(3, 14, 9, 1);
        assert_eq!(terrain_codes(pcode), [3, 14, 9, 1]);
    }

    #[test]
    fn prng_matches_acclient_wrapping_arithmetic() {
        // Reference: acclient `(double)(1379576222 * pcode - 1372186442) *
        // 2.3283064e-10 * num`, 32-bit unsigned wrap. Recompute independently.
        for &pcode in &[1u32, 0x1234u32, 0x000A_9B40u32, 0x0FFF_FFFFu32, 0xDEAD_BEEFu32] {
            for &num in &[1usize, 3, 4] {
                let v = 1379576222u32.wrapping_mul(pcode).wrapping_sub(1372186442);
                let expect = {
                    let i = ((v as f64) * 2.3283064e-10 * num as f64).floor() as i64;
                    if i < 0 || i >= num as i64 { 0 } else { i as usize }
                };
                assert_eq!(texmerge_prng(pcode, num), expect, "pcode={pcode:#X} num={num}");
                assert!(texmerge_prng(pcode, num) < num, "prng must be in [0,num)");
            }
        }
        // The wrapping form differs from ACE's non-wrapping long form for
        // large pcodes — guard that we did NOT accidentally use long math.
        let big = 0x0FFF_FFFFu32;
        let wrap = 1379576222u32.wrapping_mul(big).wrapping_sub(1372186442);
        let nonwrap = (1379576222i64 * big as i64 - 1372186442) as f64;
        assert_ne!(
            wrap as f64, nonwrap,
            "wrap and long forms must differ for a large pcode (acclient vs ACE)"
        );
    }

    #[test]
    fn get_terrain_single_type_has_no_overlays() {
        // All four corners identical → base only, no overlays.
        let (base, overlays) = get_terrain(pack(3, 3, 3, 3));
        assert_eq!(base, 3);
        assert!(overlays.is_empty(), "uniform cell has no overlays: {overlays:?}");
    }

    #[test]
    fn get_terrain_all_distinct_uses_tcodes_2_4_8() {
        // Four distinct corners → base = corner 0, overlays carry tcodes 2,4,8.
        let (base, overlays) = get_terrain(pack(3, 1, 14, 9));
        assert_eq!(base, 3);
        assert_eq!(overlays, vec![(1, 2), (14, 4), (9, 8)]);
    }

    #[test]
    fn get_terrain_one_overlay_when_three_corners_share() {
        // sw repeated 3×, one different corner (nw, bit 3) → single overlay,
        // tcode = 8.
        let (base, overlays) = get_terrain(pack(3, 3, 3, 9));
        assert_eq!(base, 3);
        assert_eq!(overlays, vec![(9, 8)]);
    }

    #[test]
    fn find_terrain_alpha_corner_rotations() {
        // Retail corner masks all have base TCode 8; rotating 8 → 1 → 2 → 4.
        let t = TexMergeTables::retail();
        // pick a pcode whose PRNG picks corner mask 0 (TCode 8) — for any
        // pcode the corner mask TCode is 8, so the rotation depends only on
        // the requested tcode.
        let pcode = pack(3, 1, 1, 1); // base 1 (repeated), overlay sw=3 tcode... use direct call
        let (rot8, _) = find_terrain_alpha(pcode, 8, &t).unwrap();
        assert_eq!(rot8, Rotation::Rot0, "tcode 8 == mask base → no rotation");
        // 8 → 1 is one ×2/-15 step (8*2=16, 16-15=1).
        let (rot1, _) = find_terrain_alpha(pcode, 1, &t).unwrap();
        assert_eq!(rot1, Rotation::Rot90);
        // 8 → 1 → 2 (two steps).
        let (rot2, _) = find_terrain_alpha(pcode, 2, &t).unwrap();
        assert_eq!(rot2, Rotation::Rot180);
        // 8 → 1 → 2 → 4 (three steps).
        let (rot4, _) = find_terrain_alpha(pcode, 4, &t).unwrap();
        assert_eq!(rot4, Rotation::Rot270);
    }

    #[test]
    fn find_terrain_alpha_side_uses_baseidx_4() {
        // Side tcodes (e.g. 9) use the side map set at baseIdx 4. Retail side
        // mask base TCode is 9, so tcode 9 → Rot0, alpha_index 4 (4 + 0).
        let t = TexMergeTables::retail();
        let (rot, idx) = find_terrain_alpha(pack(3, 1, 14, 9), 9, &t).unwrap();
        assert_eq!(rot, Rotation::Rot0);
        assert_eq!(idx, 4, "side mask alpha_index = baseIdx(4) + prng(0)");
        // 9 → 3 → 6 → 12 rotation cycle (side cycle).
        assert_eq!(find_terrain_alpha(pack(3, 1, 14, 9), 3, &t).unwrap().0, Rotation::Rot90);
        assert_eq!(find_terrain_alpha(pack(3, 1, 14, 9), 6, &t).unwrap().0, Rotation::Rot180);
        assert_eq!(find_terrain_alpha(pack(3, 1, 14, 9), 12, &t).unwrap().0, Rotation::Rot270);
    }

    #[test]
    fn road_code_patterns() {
        // No road bits → no road.
        assert_eq!(road_code(pack(3, 3, 3, 3)), ([0, 0], false));
        // All four road corners (road bits in 0x0FF00000) → all_road.
        let all = 0x0FF0_0000 | pack(3, 3, 3, 3);
        assert_eq!(road_code(all), ([0, 0], true));
        // Single road corner (upper-left road bits 0x0C000000) → mask 1.
        let one = 0x0C00_0000 | pack(3, 3, 3, 3);
        assert_eq!(road_code(one), ([1, 0], false));
        // Three-corner road (1+2+3 → mask 0xE) → rcode [6, 12].
        let three = (0x0300_0000 | 0x00C0_0000 | 0x0030_0000) | pack(3, 3, 3, 3);
        assert_eq!(road_code(three), ([6, 12], false));
    }

    #[test]
    fn all_road_cell_is_pure_road_no_overlays() {
        // R4.a — the explicit all-road corner case (Chorizite FindRoadAlpha /
        // road_code mask == 0xF). When every corner carries road the cell must
        // render as pure road: base = ROAD_TYPE, and NO terrain overlays and NO
        // road overlays (the road IS the base, there is nothing to blend over
        // it). The terrain.js composite relies on this contract — its all-road
        // guard skips the overlay loop because the Rust selection emits none.
        let t = TexMergeTables::retail();

        // road_code: all_road is true iff the 4-corner road mask is exactly 0xF.
        assert_eq!(road_code(0x0FF0_0000).1, true, "mask 0xF -> all_road");
        for not_all in [0x0u32, 0x0C00_0000, 0x0300_0000, 0x00C0_0000, 0x0030_0000] {
            assert_eq!(
                road_code(not_all).1,
                false,
                "only mask 0xF is all_road (mask bits {not_all:#X})"
            );
        }
        // Three-of-four road corners is NOT all_road (one corner short of 0xF).
        let three = 0x0C00_0000 | 0x0300_0000 | 0x00C0_0000;
        assert_eq!(road_code(three).1, false, "3 road corners != all_road");

        // The all-road TextureMergeInfo: pure road, zero overlays, zero roads —
        // even when the underlying corner terrain types differ (road wins).
        let all_road = pack_pcode([3, 14, 9, 1], [1, 2, 3, 1]);
        let info = texture_merge_info(all_road, &t).unwrap();
        assert!(info.all_road, "every corner road -> all_road");
        assert_eq!(info.base_terrain, ROAD_TYPE, "base is the road pseudo-type");
        assert!(info.overlays.is_empty(), "all-road has no terrain overlays");
        assert!(info.roads.is_empty(), "all-road has no road overlays (road is the base)");

        // The packed GPU record: base slot = ROAD_ATLAS_LAYER, every other slot
        // invalid — so the shader's overlay loop is a guaranteed no-op.
        let slots = pack_merge_record(&info);
        assert_eq!(slots[0][0], ROAD_TYPE, "base slot byte = ROAD_TYPE");
        for s in &slots[1..] {
            assert_eq!(s[3], 0, "all-road: no valid overlay/road slot");
        }
    }

    #[test]
    fn texture_merge_info_end_to_end() {
        let t = TexMergeTables::retail();
        // A uniform grass cell: base only, no overlays, no road.
        let info = texture_merge_info(pack(3, 3, 3, 3), &t).unwrap();
        assert!(!info.all_road);
        assert_eq!(info.base_terrain, 3);
        assert!(info.overlays.is_empty());
        assert!(info.roads.is_empty());
        assert_eq!(info.corners, [3, 3, 3, 3]);

        // A two-terrain cell (grass base + one rock corner) → exactly 1 overlay.
        let info2 = texture_merge_info(pack(3, 3, 3, 14), &t).unwrap();
        assert_eq!(info2.base_terrain, 3);
        assert_eq!(info2.overlays.len(), 1);
        assert_eq!(info2.overlays[0].terrain, 14);
        assert_eq!(info2.overlays[0].tcode, 8);

        // An all-road cell → road texture base, no overlays.
        let road_cell = 0x0FF0_0000 | pack(3, 3, 3, 3);
        let info3 = texture_merge_info(road_cell, &t).unwrap();
        assert!(info3.all_road);
        assert_eq!(info3.base_terrain, ROAD_TYPE);
    }

    #[test]
    fn pack_pcode_round_trips_corners_and_road() {
        // Corners in acclient order [bit15, bit10, bit5, bit0].
        let p = pack_pcode([3, 14, 9, 1], [0, 0, 0, 0]);
        assert_eq!(terrain_codes(p), [3, 14, 9, 1]);
        // No road bits set.
        assert_eq!(road_code(p), ([0, 0], false));

        // Road on corner 0 (bit15 corner) → bits 0x0C000000 → road mask 1.
        let p_road0 = pack_pcode([3, 3, 3, 3], [1, 0, 0, 0]);
        assert_eq!(road_code(p_road0), ([1, 0], false));
        // Terrain codes survive the road bits.
        assert_eq!(terrain_codes(p_road0), [3, 3, 3, 3]);

        // All four corners road → all_road.
        let p_allroad = pack_pcode([3, 3, 3, 3], [1, 2, 3, 1]);
        assert_eq!(road_code(p_allroad), ([0, 0], true));

        // Road value width clamps to 2 bits; only nonzero-ness matters to
        // GetRoadCode but the packed bits must stay in the corner's field.
        let p_clamp = pack_pcode([0, 0, 0, 0], [3, 0, 0, 0]);
        assert_eq!(p_clamp & 0x0C00_0000, 0x0C00_0000);
        assert_eq!(p_clamp & 0x0300_0000, 0); // didn't bleed into corner 1's field
    }

    #[test]
    fn pack_merge_record_base_and_overlay_slots() {
        let t = TexMergeTables::retail();

        // Uniform cell → only the base slot is valid.
        let uniform = texture_merge_info(pack(3, 3, 3, 3), &t).unwrap();
        let slots = pack_merge_record(&uniform);
        assert_eq!(slots[0], [3, NO_ALPHA_MASK, 0, 255], "base = grass, no mask, valid");
        for s in &slots[1..] {
            assert_eq!(s[3], 0, "no overlays/roads → slot invalid");
        }

        // Two-terrain cell → base + 1 overlay.
        let two = texture_merge_info(pack(3, 3, 3, 14), &t).unwrap();
        let slots2 = pack_merge_record(&two);
        assert_eq!(slots2[0][0], 3); // base grass
        assert_eq!(slots2[0][3], 255);
        assert_eq!(slots2[1][0], 14, "overlay terrain = rock");
        assert_eq!(slots2[1][3], 255, "overlay slot valid");
        assert!(
            (slots2[1][1] as usize) < 5,
            "terrain overlay alpha index in corner/side range [0,5): got {}",
            slots2[1][1]
        );
        assert_eq!(slots2[2][3], 0, "only one overlay → slot 2 invalid");

        // All-road cell → base = road atlas layer, no overlays/roads slots.
        let road_cell = pack_pcode([3, 3, 3, 3], [1, 1, 1, 1]);
        let road_info = texture_merge_info(road_cell, &t).unwrap();
        assert!(road_info.all_road);
        let slots3 = pack_merge_record(&road_info);
        // all_road uses ROAD_TYPE(0x20) as base_terrain; the JS atlas maps that
        // to the road tile separately, but the packed byte is ROAD_TYPE here.
        assert_eq!(slots3[0][0], ROAD_TYPE);
    }
}

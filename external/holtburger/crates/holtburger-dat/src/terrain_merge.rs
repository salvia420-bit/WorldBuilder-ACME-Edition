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
}

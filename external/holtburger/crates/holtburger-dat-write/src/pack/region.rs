//! `impl DatPack for Region` — delegates to the new `Region::pack` (E12c
//! slice-3, WRITE-NEW type 0x13, the LARGEST dat-write type) and enforces the
//! `parts_mask` ↔ sub-record-presence invariant (E12 design §B.5).
//!
//! A Region's four optional sub-records (`SkyDesc`, `SoundDesc`, `SceneDesc`,
//! `RegionMisc`) are each gated, ON THE WIRE, by a single `parts_mask` bit:
//!
//! - `HasSkyInfo    = 0x10`  → `sky_info`
//! - `HasSoundInfo  = 0x01`  → `sound_info`
//! - `HasSceneInfo  = 0x02`  → `scene_info`
//! - `HasRegionMisc = 0x200` → `region_misc`
//!
//! `Region::unpack` reads each `Option` field iff its bit is set, so the
//! ONLY in-memory state that round-trips is `(bit set) iff (field is Some)`.
//! The guard rejects BOTH contradictions, fail-closed, BEFORE any bytes are
//! produced:
//!
//! - bit SET but field `None`   → the writer cannot emit the sub-record;
//! - bit CLEAR but field `Some` → the sub-record would silently never be
//!   written and the in-memory `Some` would vanish on the next read.
//!
//! Either way the record could not survive `unpack(pack(x)) == x`, so we
//! surface [`WriteError::InvariantViolation`] rather than emit bytes that
//! mis-parse.
//!
//! NOTE on ordering: `Region::pack` emits the optional blocks in WIRE order
//! `[Sky, Sound, Scene, (Terrain), Misc]` — NOT mask-bit order — exactly as
//! the reader consumes them. The unconditional `TerrainInfo` always lands
//! between SceneInfo and RegionMisc. That ordering is the parser's
//! responsibility and is covered by the byte-parity test below; this guard
//! only enforces the presence invariant.

use holtburger_dat::DatFileType;
use holtburger_dat::file_type::Region;
use holtburger_dat::file_type::region::{
    PARTS_MASK_HAS_REGION_MISC, PARTS_MASK_HAS_SCENE_INFO, PARTS_MASK_HAS_SKY_INFO,
    PARTS_MASK_HAS_SOUND_INFO,
};

use crate::DatPack;
use crate::error::{Result, WriteError};

impl DatPack for Region {
    fn pack(&self) -> Result<Vec<u8>> {
        // Fail closed: enforce parts_mask ↔ presence (both ways) before bytes.
        validate(self)?;

        let mut buf = Vec::new();
        Region::pack(self, &mut buf)?;
        Ok(buf)
    }

    fn type_id(&self) -> u32 {
        DatFileType::Region as u32
    }

    fn id(&self) -> u32 {
        // Region carries a leading `id` field in its body (DBObj.HasId) — the
        // first dword of the record — so it IS derivable from the record,
        // unlike Surface.
        self.id
    }
}

/// §B.5 — `parts_mask` bit ↔ optional sub-record presence must agree BOTH
/// ways for each of the four gated records. Returns `InvariantViolation`
/// (never panics) on the first disagreement.
fn validate(region: &Region) -> Result<()> {
    let type_id = DatFileType::Region as u32;
    let file_id = region.id;
    let mask = region.parts_mask;

    check_bit(
        type_id,
        file_id,
        "HasSkyInfo (0x10)",
        mask & PARTS_MASK_HAS_SKY_INFO != 0,
        region.sky_info.is_some(),
    )?;
    check_bit(
        type_id,
        file_id,
        "HasSoundInfo (0x01)",
        mask & PARTS_MASK_HAS_SOUND_INFO != 0,
        region.sound_info.is_some(),
    )?;
    check_bit(
        type_id,
        file_id,
        "HasSceneInfo (0x02)",
        mask & PARTS_MASK_HAS_SCENE_INFO != 0,
        region.scene_info.is_some(),
    )?;
    check_bit(
        type_id,
        file_id,
        "HasRegionMisc (0x200)",
        mask & PARTS_MASK_HAS_REGION_MISC != 0,
        region.region_misc.is_some(),
    )?;

    Ok(())
}

/// One bit ↔ presence check. `bit_set` is whether the parts_mask flag is set;
/// `present` is whether the corresponding `Option` field is `Some`. They MUST
/// match — a set bit with no field can't be written, and a clear bit with a
/// field would be dropped on the next read.
fn check_bit(
    type_id: u32,
    file_id: u32,
    name: &str,
    bit_set: bool,
    present: bool,
) -> Result<()> {
    match (bit_set, present) {
        (true, false) => Err(violation(
            type_id,
            file_id,
            format!(
                "parts_mask {name} is SET but the sub-record field is None \
                 (the writer cannot emit the sub-record)"
            ),
        )),
        (false, true) => Err(violation(
            type_id,
            file_id,
            format!(
                "parts_mask {name} is CLEAR but the sub-record field is Some \
                 (it would be silently dropped — record would not round-trip)"
            ),
        )),
        _ => Ok(()),
    }
}

fn violation(type_id: u32, file_id: u32, reason: String) -> WriteError {
    WriteError::InvariantViolation {
        type_id,
        file_id,
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_dat::file_type::game_time::GameTime;
    use holtburger_dat::file_type::region::{LandDefs, LandSurf, TerrainDesc, TexMerge};

    /// Locate retail `client_portal.dat`: the `HOLTBURGER_PORTAL_DAT` env var
    /// (via `holtburger_dat::utils::get_portal_dat_path`) first, then the
    /// canonical install path. Mirrors `region::tests::locate_portal_dat`.
    fn locate_portal_dat() -> Option<std::path::PathBuf> {
        if let Some(p) = holtburger_dat::utils::get_portal_dat_path() {
            return Some(p);
        }
        let canonical = std::path::PathBuf::from("/home/wbterminal/ac_base_dats/client_portal.dat");
        if canonical.exists() {
            return Some(canonical);
        }
        None
    }

    /// A minimal LandDefs (all-zero scalars + 256 zero heights) for synthetic
    /// fixtures.
    fn empty_land_defs() -> LandDefs {
        LandDefs {
            num_block_length: 0,
            num_block_width: 0,
            square_length: 0.0,
            l_block_length: 0,
            vertex_per_cell: 0,
            max_obj_height: 0.0,
            sky_height: 0.0,
            road_width: 0.0,
            land_height_table: vec![0.0; 256],
        }
    }

    /// A minimal GameTime — empty year_spec + empty lists.
    fn empty_game_time() -> GameTime {
        GameTime {
            zero_time_of_year: 0.0,
            zero_year: 0,
            day_length: 0.0,
            days_per_year: 0,
            year_spec: String::new(),
            times_of_day: Vec::new(),
            days_of_week: Vec::new(),
            seasons: Vec::new(),
        }
    }

    /// A minimal TerrainDesc — 0 terrain types + an empty LandSurf/TexMerge.
    fn empty_terrain_desc() -> TerrainDesc {
        TerrainDesc {
            terrain_types: Vec::new(),
            land_surfaces: LandSurf {
                surf_type: 0,
                tex_merge: TexMerge {
                    base_tex_size: 0,
                    corner_terrain_maps: Vec::new(),
                    side_terrain_maps: Vec::new(),
                    road_maps: Vec::new(),
                    terrain_desc: Vec::new(),
                },
            },
        }
    }

    /// A synthetic Region with `parts_mask == 0` (no optional sub-records).
    fn minimal_region() -> Region {
        Region {
            id: 0x1300_0000,
            region_number: 1,
            version: 0,
            region_name: "X".to_string(),
            land_defs: empty_land_defs(),
            game_time: empty_game_time(),
            parts_mask: 0,
            sound_info: None,
            scene_info: None,
            sky_info: None,
            terrain_info: empty_terrain_desc(),
            region_misc: None,
        }
    }

    /// THE LOAD-BEARING PROOF (GAUGE): unpack retail Region 0x13000000 from
    /// the real `client_portal.dat`, pack it through the guarded `DatPack`
    /// path, re-unpack and assert structural equality on the salient fields,
    /// then re-pack and assert the bytes are byte-for-byte identical to the
    /// first pack (idempotent). The byte parity vs the re-unpack→re-pack
    /// cycle is what proves every alignment pad, conditional block, and the
    /// i32 `stb_index` survive the inverse path.
    #[test]
    fn region_1_retail_byte_round_trips_through_datpack() {
        use holtburger_dat::DatDatabase;
        use std::io::Cursor;

        let Some(path) = locate_portal_dat() else {
            eprintln!(
                "[region_1_retail_byte_round_trips_through_datpack] SKIP — \
                 HOLTBURGER_PORTAL_DAT unset and no canonical client_portal.dat"
            );
            return;
        };
        let dat = DatDatabase::new(&path).expect("client_portal.dat should open");
        let retail_bytes = dat
            .get_file(0x1300_0000)
            .expect("Region 0x13000000 must exist in retail client_portal.dat");

        let region = Region::unpack(&mut Cursor::new(&retail_bytes))
            .expect("retail Region 0x13000000 must parse");

        // Pack through the guarded DatPack path.
        let packed = DatPack::pack(&region).expect("retail Region must pack through DatPack");

        // The packed body must be a PREFIX of the retail bytes: the parser
        // consumes the whole logical record but the DAT entry is padded with
        // trailing zeros to a BTree page boundary (see
        // region::tests::region_1_parse_lands_at_end_of_record). So compare
        // the packed length's worth of bytes, then assert the retail tail is
        // all-zero padding.
        assert!(
            packed.len() <= retail_bytes.len(),
            "packed Region ({} bytes) longer than retail entry ({} bytes)",
            packed.len(),
            retail_bytes.len()
        );
        assert_eq!(
            &packed[..],
            &retail_bytes[..packed.len()],
            "packed Region bytes diverge from retail within the logical record"
        );
        assert!(
            retail_bytes[packed.len()..].iter().all(|&b| b == 0),
            "retail bytes past the packed length are not all zero padding: {:02X?}",
            &retail_bytes[packed.len()..(packed.len() + 32).min(retail_bytes.len())]
        );

        // Re-unpack the packed bytes and assert structural equality on the
        // load-bearing fields.
        let reparsed =
            Region::unpack(&mut Cursor::new(&packed)).expect("packed Region must re-unpack");
        assert_eq!(reparsed.id, region.id);
        assert_eq!(reparsed.region_number, region.region_number);
        assert_eq!(reparsed.version, region.version);
        assert_eq!(reparsed.region_name, region.region_name);
        assert_eq!(reparsed.parts_mask, region.parts_mask);
        assert_eq!(
            reparsed.land_defs.land_height_table.len(),
            region.land_defs.land_height_table.len()
        );
        assert_eq!(reparsed.land_defs.land_height_table, region.land_defs.land_height_table);
        assert_eq!(reparsed.game_time.year_spec, region.game_time.year_spec);
        assert_eq!(reparsed.game_time.times_of_day.len(), region.game_time.times_of_day.len());
        assert_eq!(reparsed.game_time.days_of_week, region.game_time.days_of_week);
        assert_eq!(reparsed.game_time.seasons.len(), region.game_time.seasons.len());
        assert_eq!(reparsed.sky_info.is_some(), region.sky_info.is_some());
        assert_eq!(reparsed.sound_info.is_some(), region.sound_info.is_some());
        assert_eq!(reparsed.scene_info.is_some(), region.scene_info.is_some());
        assert_eq!(reparsed.region_misc.is_some(), region.region_misc.is_some());
        if let (Some(s), Some(rs)) = (&region.sky_info, &reparsed.sky_info) {
            assert_eq!(rs.day_groups.len(), s.day_groups.len(), "DayGroup count drifted");
        }
        if let (Some(s), Some(rs)) = (&region.scene_info, &reparsed.scene_info) {
            assert_eq!(rs.scene_types.len(), s.scene_types.len(), "SceneType count drifted");
            for (a, b) in s.scene_types.iter().zip(rs.scene_types.iter()) {
                assert_eq!(a.stb_index, b.stb_index, "SceneType.stb_index (i32) drifted");
            }
        }
        if let Some(rm) = &reparsed.region_misc {
            let orig = region.region_misc.as_ref().unwrap();
            assert_eq!(rm.version, orig.version);
            assert_eq!(rm.game_map_id, orig.game_map_id);
            assert_eq!(rm.autotest_map_id, orig.autotest_map_id);
            assert_eq!(rm.autotest_map_size, orig.autotest_map_size);
            assert_eq!(rm.clear_cell_id, orig.clear_cell_id);
            assert_eq!(rm.clear_monster_id, orig.clear_monster_id);
        }

        // Byte idempotence: re-packing the re-parsed record yields the same
        // bytes as the first pack.
        let packed2 = DatPack::pack(&reparsed).expect("re-parsed Region must pack");
        assert_eq!(
            packed, packed2,
            "Region pack must be byte-for-byte idempotent (unpack(pack(x)) re-packs identically)"
        );

        assert_eq!(DatPack::type_id(&region), DatFileType::Region as u32);
        assert_eq!(DatPack::id(&region), 0x1300_0000);

        eprintln!(
            "[region_1_retail_byte_round_trips_through_datpack] retail={} bytes, packed={} bytes, \
             padding={} bytes, parts_mask=0x{:04X}",
            retail_bytes.len(),
            packed.len(),
            retail_bytes.len() - packed.len(),
            region.parts_mask
        );
    }

    /// Synthetic parts_mask==0 Region must pack and round-trip cleanly (no
    /// optional sub-records). Keeps a minimal byte-round-trip anchor that does
    /// not depend on the retail dat being present.
    #[test]
    fn region_parts_mask_zero_round_trips() {
        use std::io::Cursor;

        let region = minimal_region();
        let packed = DatPack::pack(&region).expect("minimal Region must pack");

        let reparsed =
            Region::unpack(&mut Cursor::new(&packed)).expect("packed minimal Region must re-unpack");
        assert_eq!(reparsed.id, 0x1300_0000);
        assert_eq!(reparsed.region_number, 1);
        assert_eq!(reparsed.region_name, "X");
        assert_eq!(reparsed.parts_mask, 0);
        assert!(reparsed.sky_info.is_none());
        assert!(reparsed.sound_info.is_none());
        assert!(reparsed.scene_info.is_none());
        assert!(reparsed.region_misc.is_none());
        assert_eq!(reparsed.terrain_info.terrain_types.len(), 0);

        let packed2 = DatPack::pack(&reparsed).expect("re-parsed minimal Region must pack");
        assert_eq!(packed, packed2, "minimal Region pack must be byte-for-byte idempotent");
    }

    // ----- parts_mask ↔ presence negative guards (4 cases) -----

    #[test]
    fn negative_sky_bit_set_but_none_is_rejected() {
        let mut region = minimal_region();
        region.parts_mask = PARTS_MASK_HAS_SKY_INFO; // bit set, sky_info None
        let err = DatPack::pack(&region).expect_err("Sky bit set with None must be rejected");
        match err {
            WriteError::InvariantViolation { type_id, file_id, reason } => {
                assert_eq!(type_id, DatFileType::Region as u32);
                assert_eq!(file_id, 0x1300_0000);
                assert!(reason.contains("HasSkyInfo") && reason.contains("SET"), "reason: {reason}");
            }
            other => panic!("expected InvariantViolation, got {other:?}"),
        }
    }

    #[test]
    fn negative_sound_bit_clear_but_some_is_rejected() {
        use holtburger_dat::file_type::SoundDesc;
        let mut region = minimal_region();
        // parts_mask stays 0 (HasSoundInfo clear) but sound_info is Some.
        region.sound_info = Some(SoundDesc { stb_descs: Vec::new() });
        let err = DatPack::pack(&region).expect_err("Sound bit clear with Some must be rejected");
        match err {
            WriteError::InvariantViolation { reason, .. } => {
                assert!(
                    reason.contains("HasSoundInfo") && reason.contains("CLEAR"),
                    "reason: {reason}"
                );
            }
            other => panic!("expected InvariantViolation, got {other:?}"),
        }
    }

    #[test]
    fn negative_scene_bit_set_but_none_is_rejected() {
        let mut region = minimal_region();
        region.parts_mask = PARTS_MASK_HAS_SCENE_INFO; // set, scene_info None
        let err = DatPack::pack(&region).expect_err("Scene bit set with None must be rejected");
        assert!(matches!(err, WriteError::InvariantViolation { .. }));
    }

    #[test]
    fn negative_region_misc_bit_clear_but_some_is_rejected() {
        use holtburger_dat::file_type::RegionMisc;
        let mut region = minimal_region();
        // parts_mask stays 0 (HasRegionMisc clear) but region_misc is Some.
        region.region_misc = Some(RegionMisc {
            version: 1,
            game_map_id: 0,
            autotest_map_id: 0,
            autotest_map_size: 0,
            clear_cell_id: 0,
            clear_monster_id: 0,
        });
        let err =
            DatPack::pack(&region).expect_err("RegionMisc bit clear with Some must be rejected");
        match err {
            WriteError::InvariantViolation { reason, .. } => {
                assert!(
                    reason.contains("HasRegionMisc") && reason.contains("CLEAR"),
                    "reason: {reason}"
                );
            }
            other => panic!("expected InvariantViolation, got {other:?}"),
        }
    }
}

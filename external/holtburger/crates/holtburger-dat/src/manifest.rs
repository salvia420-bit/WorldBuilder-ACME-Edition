use crate::boot_reachability::{BootReachability, walk_boot_reachability};
use crate::file_type::{CharGen, ChatPoseTable, DatFileType, SkillTable, SpellTable, XpTable};
use crate::{EOR_CELL_NAMESPACE, EOR_PORTAL_NAMESPACE, ResourceSource};

/// A manifest that defines which file IDs and file types should be kept when stripping archives.
pub struct StripperManifest {
    pub keep_rules: Vec<ManifestRule>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestRule {
    pub namespace: Option<String>,
    pub file_type: Option<DatFileType>,
    pub file_id: Option<u32>,
}

impl Default for StripperManifest {
    fn default() -> Self {
        Self::new()
    }
}

impl StripperManifest {
    /// Returns the default manifest for a "Logic/Physics Only" (Lite) archive.
    pub fn logic_only() -> Self {
        let mut manifest = Self::new();
        for file_type in [
            DatFileType::Model,
            DatFileType::SetupModel,
            DatFileType::Audio,
            DatFileType::EnvCell,
            DatFileType::Table,
            DatFileType::Region,
            DatFileType::ParticleEmitter,
            DatFileType::PhysicsScript,
            DatFileType::PhysicsScriptTable,
            DatFileType::SoundTable,
            DatFileType::Landblock,
            DatFileType::LandblockInfo,
            DatFileType::IndoorCell,
            // Legacy inclusion preserved during the 2026-05-23 kind-aware
            // classifier migration. Pre-migration these ~6886 portal records
            // were silently bundled because the legacy `from_id` mis-classified
            // their prefixes (0x0F, 0x11, 0x14, 0x15, 0x22, 0x25, 0x27, 0x39,
            // 0x78) as IndoorCell. Keeping the same set here so the produced
            // boot.hba stays byte-stable. Audit which of these the holtburger
            // client actually needs and prune the unused ones in a follow-on.
            DatFileType::PaletteSet,
            DatFileType::DegradeInfo,
            DatFileType::Keymap,
            DatFileType::RenderTexture,
            DatFileType::EnumMapper,
            DatFileType::DataIDMapper,
            DatFileType::DualDataIDMapper,
            DatFileType::MasterProperty,
            DatFileType::DatabaseProperties,
        ] {
            manifest.keep_type(file_type);
        }

        manifest
    }

    /// Returns the manifest for the current TUI-oriented micro archive.
    pub fn micro() -> Self {
        let mut manifest = Self::new();
        for file_id in [
            CharGen::FILE_ID,
            ChatPoseTable::FILE_ID,
            SkillTable::FILE_ID,
            SpellTable::FILE_ID,
            XpTable::FILE_ID,
        ] {
            manifest.keep_namespaced_file(EOR_PORTAL_NAMESPACE, file_id);
        }

        manifest
    }

    /// Phase 5.0 obj 8 — bootstrap pack for the browser's manifest-
    /// mode resource source.
    ///
    /// Includes: the catalog tables every login needs (CharGen,
    /// SkillTable, SpellTable, XpTable, ChatPoseTable) plus the
    /// CellLandblock + LandblockInfo records for the 9-cell
    /// neighborhood around `boot_landblock`. Landblock IDs are
    /// `0xXXYY` where `XX/YY` are the world-grid coords; the
    /// terrain record is `0xXXYYFFFF` and LandblockInfo is
    /// `0xXXYYFFFE`.
    ///
    /// This is the same minimum-viable boot policy as
    /// `holtburger_tools::dat_shard::is_boot_essential`.
    ///
    /// Phase 5.1 (resolved): the transitive Surface/SurfaceTexture/
    /// Texture/Palette/GfxObj/SetupModel walk through the boot
    /// landblock's object placements now lives in the shared
    /// [`crate::boot_reachability`] module. The static manifest below
    /// still only *names* the catalog tables + the 9-cell terrain
    /// neighborhood (it can't know the placement-graph closure without
    /// reading the DAT). To audit whether a produced boot HBA actually
    /// contains every model/surface/texture/palette the spawn-area
    /// placements reference, call
    /// [`StripperManifest::verify_boot_reachability`] (or
    /// [`crate::walk_boot_reachability`] directly) against the packed
    /// archive — it answers "is the boot landblock fully packable?"
    /// with a read-only DFS. The walker is the shared building block;
    /// `dat-shard` and `dat2hba --profile boot` do **not** yet invoke
    /// it — wiring the audit into those tools (e.g. a `--verify-boot`
    /// flag that logs/fails on `!fully_packable`) is a follow-up. The
    /// walker only covers the *visual* record chain (model/surface/
    /// texture/palette); see [`BootReachability`] for the precise scope.
    pub fn boot(boot_landblock: u32) -> Self {
        let mut manifest = Self::new();
        for file_id in [
            CharGen::FILE_ID,
            ChatPoseTable::FILE_ID,
            SkillTable::FILE_ID,
            SpellTable::FILE_ID,
            XpTable::FILE_ID,
        ] {
            manifest.keep_namespaced_file(EOR_PORTAL_NAMESPACE, file_id);
        }
        // 9-cell neighborhood (boot landblock + 8 grid neighbors).
        let bx = (boot_landblock >> 8) & 0xFF;
        let by = boot_landblock & 0xFF;
        for dx in -1i32..=1 {
            for dy in -1i32..=1 {
                let nx = bx as i32 + dx;
                let ny = by as i32 + dy;
                if !(0..=255).contains(&nx) || !(0..=255).contains(&ny) {
                    continue;
                }
                let cell_id = ((nx as u32) << 8) | (ny as u32);
                manifest.keep_namespaced_file(EOR_CELL_NAMESPACE, (cell_id << 16) | 0xFFFF);
                manifest.keep_namespaced_file(EOR_CELL_NAMESPACE, (cell_id << 16) | 0xFFFE);
            }
        }
        manifest
    }

    /// Phase 5.1 — audit whether the boot landblock is *fully packable*
    /// against a packed resource source (typically the produced
    /// `boot.hba` opened as an [`crate::HbaReader`], which implements
    /// [`ResourceSource`]).
    ///
    /// Runs the read-only transitive reachability walk from the boot
    /// landblock's object placements (see
    /// [`crate::walk_boot_reachability`]) and returns the resulting
    /// [`BootReachability`]. `result.fully_packable` is the headline
    /// answer (covering the *visual* model/surface/texture/palette
    /// chain — see [`BootReachability`] for the exact scope);
    /// `result.missing_dids` lists any dangling references the static
    /// manifest failed to include.
    ///
    /// Read-only: this neither mutates the manifest nor the source.
    pub fn verify_boot_reachability<S: ResourceSource + ?Sized>(
        source: &S,
        boot_landblock: u32,
    ) -> BootReachability {
        walk_boot_reachability(source, boot_landblock)
    }

    pub fn new() -> Self {
        Self {
            keep_rules: Vec::new(),
        }
    }

    pub fn keep_type(&mut self, file_type: DatFileType) {
        self.keep_rules.push(ManifestRule {
            namespace: None,
            file_type: Some(file_type),
            file_id: None,
        });
    }

    pub fn keep_file(&mut self, file_id: u32) {
        self.keep_rules.push(ManifestRule {
            namespace: None,
            file_type: None,
            file_id: Some(file_id),
        });
    }

    pub fn keep_namespaced_type(&mut self, namespace: &str, file_type: DatFileType) {
        self.keep_rules.push(ManifestRule {
            namespace: Some(namespace.to_string()),
            file_type: Some(file_type),
            file_id: None,
        });
    }

    pub fn keep_namespaced_file(&mut self, namespace: &str, file_id: u32) {
        self.keep_rules.push(ManifestRule {
            namespace: Some(namespace.to_string()),
            file_type: None,
            file_id: Some(file_id),
        });
    }

    pub fn should_keep_entry(&self, namespace: &str, id: u32, file_type: DatFileType) -> bool {
        self.keep_rules.iter().any(|rule| {
            rule.namespace
                .as_deref()
                .is_none_or(|value| value == namespace)
                && rule.file_id.is_none_or(|value| value == id)
                && rule.file_type.is_none_or(|value| value == file_type)
        })
    }

    /// Returns true if the given file type should be kept according to this manifest.
    pub fn should_keep(&self, file_type: DatFileType) -> bool {
        self.keep_rules.iter().any(|rule| {
            rule.namespace.is_none() && rule.file_id.is_none() && rule.file_type == Some(file_type)
        })
    }

    /// Returns true if the given file should be kept according to this manifest.
    pub fn should_keep_file(&self, id: u32, file_type: DatFileType) -> bool {
        self.keep_rules.iter().any(|rule| {
            rule.namespace.is_none()
                && rule.file_id.is_none_or(|value| value == id)
                && rule.file_type.is_none_or(|value| value == file_type)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logic_manifest_keeps_table_type_without_exact_id() {
        let manifest = StripperManifest::logic_only();

        assert!(manifest.should_keep(DatFileType::Table));
        assert!(manifest.should_keep_file(0x0E00ABCD, DatFileType::Table));
        // H3 (2026-05-12): Wave/Audio (0x0A) is now kept in the
        // logic_only manifest so the JS-side AudioManager can fetch
        // ambient + entity sounds at runtime. Pre-H3 this assertion
        // read `!should_keep_file(...)` since audio wasn't shipped.
        assert!(manifest.should_keep_file(0x0A000001, DatFileType::Audio));
        // A type that's actively excluded — `Clothing` (0x10) is not
        // in logic_only — preserves the "negative" half of the original
        // invariant (catches accidental keep-all bugs).
        assert!(!manifest.should_keep_file(0x10000001, DatFileType::Clothing));
    }

    #[test]
    fn micro_manifest_keeps_required_table_ids_and_excludes_raw_motion_assets() {
        let manifest = StripperManifest::micro();

        assert!(manifest.should_keep_entry(
            EOR_PORTAL_NAMESPACE,
            CharGen::FILE_ID,
            DatFileType::Table
        ));
        assert!(manifest.should_keep_entry(
            EOR_PORTAL_NAMESPACE,
            ChatPoseTable::FILE_ID,
            DatFileType::Table
        ));
        assert!(manifest.should_keep_entry(
            EOR_PORTAL_NAMESPACE,
            SkillTable::FILE_ID,
            DatFileType::Table
        ));
        assert!(manifest.should_keep_entry(
            EOR_PORTAL_NAMESPACE,
            SpellTable::FILE_ID,
            DatFileType::Table
        ));
        assert!(manifest.should_keep_entry(
            EOR_PORTAL_NAMESPACE,
            XpTable::FILE_ID,
            DatFileType::Table
        ));
        assert!(!manifest.should_keep_entry(
            EOR_PORTAL_NAMESPACE,
            0x09000001,
            DatFileType::MotionTable
        ));
        assert!(!manifest.should_keep_entry(
            EOR_PORTAL_NAMESPACE,
            0x03000003,
            DatFileType::Animation
        ));
        assert!(!manifest.should_keep_entry("eor/cell", 0x09000001, DatFileType::MotionTable));
        assert!(!manifest.should_keep_entry(EOR_PORTAL_NAMESPACE, 0x0E000099, DatFileType::Table));
        assert!(!manifest.should_keep_entry(EOR_PORTAL_NAMESPACE, 0x01000001, DatFileType::Model));
    }

    #[test]
    fn boot_manifest_keeps_essentials_and_spawn_neighborhood() {
        let manifest = StripperManifest::boot(0xA9B4);
        // Catalog tables: included.
        assert!(manifest.should_keep_entry(
            EOR_PORTAL_NAMESPACE,
            CharGen::FILE_ID,
            DatFileType::Table
        ));
        assert!(manifest.should_keep_entry(
            EOR_PORTAL_NAMESPACE,
            SkillTable::FILE_ID,
            DatFileType::Table
        ));
        // Spawn landblock + LandblockInfo: included.
        assert!(manifest.should_keep_entry(
            EOR_CELL_NAMESPACE,
            0xA9B4_FFFF,
            DatFileType::Landblock
        ));
        assert!(manifest.should_keep_entry(
            EOR_CELL_NAMESPACE,
            0xA9B4_FFFE,
            DatFileType::LandblockInfo
        ));
        // Adjacent landblock terrain (NW neighbor 0xA8B3): included.
        assert!(manifest.should_keep_entry(
            EOR_CELL_NAMESPACE,
            0xA8B3_FFFF,
            DatFileType::Landblock
        ));
        // Far-away landblock: NOT included.
        assert!(!manifest.should_keep_entry(
            EOR_CELL_NAMESPACE,
            0x0000_FFFF,
            DatFileType::Landblock
        ));
        // Random portal record: NOT included.
        assert!(!manifest.should_keep_entry(
            EOR_PORTAL_NAMESPACE,
            0x0100_0827,
            DatFileType::Model
        ));
    }

    #[test]
    fn boot_manifest_clamps_at_world_edge() {
        // Top-left corner has only 4 in-bounds neighbors.
        let manifest = StripperManifest::boot(0x0000);
        assert!(manifest.should_keep_entry(
            EOR_CELL_NAMESPACE,
            0x0000_FFFF,
            DatFileType::Landblock
        ));
        assert!(manifest.should_keep_entry(
            EOR_CELL_NAMESPACE,
            0x0101_FFFF,
            DatFileType::Landblock
        ));
        // No (-1, -1) neighbor exists.
        assert!(!manifest.should_keep_entry(
            EOR_CELL_NAMESPACE,
            0xFFFF_FFFF,
            DatFileType::Landblock
        ));
    }

    #[test]
    fn namespaced_manifest_rules_can_target_custom_assets() {
        let mut manifest = StripperManifest::new();
        manifest.keep_namespaced_type("derived/test", DatFileType::Custom);

        assert!(manifest.should_keep_entry("derived/test", 0xDEADBEEF, DatFileType::Custom));
        assert!(!manifest.should_keep_entry(EOR_PORTAL_NAMESPACE, 0xDEADBEEF, DatFileType::Custom));
    }
}

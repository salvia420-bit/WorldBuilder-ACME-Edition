//! audit-polygon-sides — read-only DAT parity audit of polygon side/cull/
//! stippling/UV semantics across GfxObj constructed meshes + EnvCell shell
//! polygons.
//!
//! Lifted from upstream `merklejerk/holtburger`
//! `crates/holtburger-debug-harness/src/bin/audit_polygon_sides.rs` (M1 of
//! the 2026-06-07 port plan) and adapted to the fork:
//!   - `DatFileType::from_id` → `from_id_in_dat(id, DatKind)` — the fork's
//!     fix for the ~25% indoor-cell misclassification under the legacy
//!     heuristic dispatch (`file_type/mod.rs`); the upstream tool
//!     under-counts EnvCells without it.
//!   - polygon ids are sorted before recording so the sampled output is
//!     deterministic (the fork's parsers store polygons in a `HashMap`).
//!
//! Strictly diagnostic: opens an HBA, parses, tallies, prints to stdout.
//! No write / mutate / export. Covers GfxObj (`Model`) + EnvCell-shell
//! (`IndoorCell` → Environment → CellStruct) polygons; NOT SetupModel
//! sub-parts or terrain.
//!
//! Polygon-side ground truth (verified against retail `CPolygon::UnPack`,
//! `acclient.c:359809-359907`):
//!   - `stippling & 0x04` (NoPos) gates the positive-UV read.
//!   - `stippling & 0x08` (NoNeg) + `sides_type == 2` gates the negative-UV read.
//!   - `sides_type == 1` (None) aliases neg → pos.
//!   - when a side is read, its UV-index count must equal the vertex count.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Cursor;

use anyhow::{Context, Result};
use clap::Parser;
use holtburger_dat::file_type::{DatFileType, DatKind, EnvCell, Environment, GfxObj};
use holtburger_dat::graphics::Polygon;
use holtburger_dat::{EOR_CELL_NAMESPACE, EOR_PORTAL_NAMESPACE, HbaReader};

const STIPPLING_NO_POS: u8 = 0x04;
const STIPPLING_NO_NEG: u8 = 0x08;
const CULL_MODE_NONE: i32 = 1;
const CULL_MODE_CLOCKWISE: i32 = 2;
const CULL_MODE_COUNTER_CLOCKWISE: i32 = 3;
const SAMPLE_LIMIT: usize = 12;

#[derive(Parser, Debug)]
#[command(about = "Read-only audit of GfxObj + EnvCell polygon side/cull/stippling/UV parity")]
struct Args {
    /// Path to the HBA archive (e.g. assets.hba) to audit.
    #[arg(long)]
    dats: String,
}

#[derive(Default)]
struct PolygonSideAudit {
    total_polygons: usize,
    sides_type_counts: BTreeMap<i32, usize>,
    stippling_counts: BTreeMap<u8, usize>,
    no_pos_count: usize,
    no_neg_count: usize,
    malformed_positive_uv_count: usize,
    malformed_negative_uv_count: usize,
    counter_clockwise_samples: Vec<String>,
    no_pos_samples: Vec<String>,
    malformed_samples: Vec<String>,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let archive = HbaReader::open(&args.dats)
        .with_context(|| format!("failed to open HBA archive {}", args.dats))?;
    let mut gfx_obj_audit = PolygonSideAudit::default();
    let mut env_cell_audit = PolygonSideAudit::default();
    let mut visited_cell_structures = BTreeSet::new();

    for entry in archive.entries() {
        let entry = entry?;
        let namespace = entry.namespace_id()?;
        let ns = namespace.as_str();

        // GfxObj constructed-mesh polygons (portal namespace, Model type).
        if ns == EOR_PORTAL_NAMESPACE
            && DatFileType::from_id_in_dat(entry.file_id, DatKind::Portal) == DatFileType::Model
        {
            let bytes = archive.get_file_in_namespace(EOR_PORTAL_NAMESPACE, entry.file_id)?;
            let gfx_obj = GfxObj::unpack(&mut Cursor::new(bytes))
                .with_context(|| format!("failed to decode GfxObj 0x{:08X}", entry.file_id))?;
            for polygon_id in sorted_keys(gfx_obj.polygons.keys().copied()) {
                let polygon = &gfx_obj.polygons[&polygon_id];
                gfx_obj_audit.record(
                    format!("gfx-obj/0x{:08X}:polygon/{}", entry.file_id, polygon_id),
                    polygon,
                );
            }
            continue;
        }

        // EnvCell shell polygons (cell namespace, IndoorCell type) — resolve
        // through Environment → CellStruct. Each (environment, cell-structure)
        // pair is audited once.
        if ns == EOR_CELL_NAMESPACE
            && DatFileType::from_id_in_dat(entry.file_id, DatKind::Cell) == DatFileType::IndoorCell
        {
            let bytes = archive.get_file_in_namespace(EOR_CELL_NAMESPACE, entry.file_id)?;
            let env_cell = EnvCell::unpack(&mut Cursor::new(bytes))
                .with_context(|| format!("failed to decode EnvCell 0x{:08X}", entry.file_id))?;
            if env_cell.environment_id == 0 {
                continue;
            }
            let environment_id = 0x0D00_0000 | u32::from(env_cell.environment_id);
            let cell_structure_id = u32::from(env_cell.cell_structure);
            if !visited_cell_structures.insert((environment_id, cell_structure_id)) {
                continue;
            }
            let environment_bytes =
                archive.get_file_in_namespace(EOR_PORTAL_NAMESPACE, environment_id)?;
            let environment = Environment::unpack(&mut Cursor::new(environment_bytes))
                .with_context(|| format!("failed to decode Environment 0x{environment_id:08X}"))?;
            let Some(cell_structure) = environment.cells.get(&cell_structure_id) else {
                continue;
            };
            for polygon_id in sorted_keys(cell_structure.polygons.keys().copied()) {
                let polygon = &cell_structure.polygons[&polygon_id];
                env_cell_audit.record(
                    format!(
                        "env-cell/0x{:08X}:environment/0x{:08X}:cell-structure/0x{:04X}:polygon/{}",
                        entry.file_id, environment_id, cell_structure_id, polygon_id
                    ),
                    polygon,
                );
            }
        }
    }

    print_audit("gfx-obj constructed mesh polygons", &gfx_obj_audit);
    print_audit("env-cell shell polygons", &env_cell_audit);
    Ok(())
}

/// Deterministic ascending key order (parsers store polygons in a HashMap).
fn sorted_keys(keys: impl Iterator<Item = u16>) -> Vec<u16> {
    let mut v: Vec<u16> = keys.collect();
    v.sort_unstable();
    v
}

impl PolygonSideAudit {
    fn record(&mut self, sample_key: String, polygon: &Polygon) {
        self.total_polygons += 1;
        *self.sides_type_counts.entry(polygon.sides_type).or_default() += 1;
        *self.stippling_counts.entry(polygon.stippling).or_default() += 1;
        if (polygon.stippling & STIPPLING_NO_POS) != 0 {
            self.no_pos_count += 1;
            push_sample(&mut self.no_pos_samples, sample_key.clone());
        }
        if (polygon.stippling & STIPPLING_NO_NEG) != 0 {
            self.no_neg_count += 1;
        }
        if polygon.sides_type == CULL_MODE_COUNTER_CLOCKWISE {
            push_sample(&mut self.counter_clockwise_samples, sample_key.clone());
        }
        // Positive-UV side is read unless NoPos — its UV count must match
        // the vertex count.
        if (polygon.stippling & STIPPLING_NO_POS) == 0
            && polygon.pos_uv_indices.len() != polygon.vertex_ids.len()
        {
            self.malformed_positive_uv_count += 1;
            push_sample(
                &mut self.malformed_samples,
                format!("{sample_key}:malformed-positive-uv"),
            );
        }
        // Negative-UV side is read only for two-sided (sides_type==2) polys
        // without NoNeg.
        if polygon.sides_type == CULL_MODE_CLOCKWISE
            && (polygon.stippling & STIPPLING_NO_NEG) == 0
            && polygon.neg_uv_indices.len() != polygon.vertex_ids.len()
        {
            self.malformed_negative_uv_count += 1;
            push_sample(
                &mut self.malformed_samples,
                format!("{sample_key}:malformed-negative-uv"),
            );
        }
    }

    fn sides_type_count(&self, sides_type: i32) -> usize {
        self.sides_type_counts.get(&sides_type).copied().unwrap_or(0)
    }

    fn other_sides_type_count(&self) -> usize {
        self.sides_type_counts
            .iter()
            .filter(|(sides_type, _)| {
                !matches!(
                    **sides_type,
                    CULL_MODE_NONE | CULL_MODE_CLOCKWISE | CULL_MODE_COUNTER_CLOCKWISE
                )
            })
            .map(|(_, count)| count)
            .sum()
    }
}

fn print_audit(label: &str, audit: &PolygonSideAudit) {
    println!("{label}");
    println!("  totalPolygons={}", audit.total_polygons);
    println!(
        "  sidesType none={} clockwise={} counterClockwise={} other={}",
        audit.sides_type_count(CULL_MODE_NONE),
        audit.sides_type_count(CULL_MODE_CLOCKWISE),
        audit.sides_type_count(CULL_MODE_COUNTER_CLOCKWISE),
        audit.other_sides_type_count()
    );
    println!("  sidesTypeRaw={:?}", audit.sides_type_counts);
    println!("  stipplingRaw={:?}", audit.stippling_counts);
    println!(
        "  noPos={} noNeg={} malformedPositiveUv={} malformedNegativeUv={}",
        audit.no_pos_count,
        audit.no_neg_count,
        audit.malformed_positive_uv_count,
        audit.malformed_negative_uv_count
    );
    print_samples("counterClockwiseSamples", &audit.counter_clockwise_samples);
    print_samples("noPosSamples", &audit.no_pos_samples);
    print_samples("malformedSamples", &audit.malformed_samples);
}

fn print_samples(label: &str, samples: &[String]) {
    if samples.is_empty() {
        return;
    }
    println!("  {label}:");
    for sample in samples {
        println!("    {sample}");
    }
}

fn push_sample(samples: &mut Vec<String>, sample: String) {
    if samples.len() < SAMPLE_LIMIT {
        samples.push(sample);
    }
}

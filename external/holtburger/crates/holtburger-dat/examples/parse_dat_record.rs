//! parse_dat_record — Wave 2.D Rust side of the DAT parser parity diff.
//!
//! Mirrors the JSON envelope from WorldBuilder.Terminal's
//! `chorizite-parse-dat-record` command so the `validate_dat_parity.cjs`
//! Phase B field-tree diff can compare both oracles side-by-side.
//!
//! Output shape (camelCase keys for cross-port consistency with Chorizite):
//!
//! ```json
//! {
//!   "idHex":        "0x01001A62",
//!   "id":           16785506,
//!   "typeName":     "GfxObj",
//!   "fields":       { ... full holtburger-dat parser output ... },
//!   "errorMessage": null,
//!   "source":       "holtburger-dat::file_type::GfxObj"
//! }
//! ```
//!
//! Usage: `parse_dat_record <dat_path> <id_hex>`
//!
//! Type detection is by ID high-byte / suffix (same as
//! [`holtburger_dat::DatFileType::from_id`]). If a sample lands on a
//! prefix without a parser (e.g. 0x10 Clothing, 0x40 Font), the output
//! carries `typeName="Unsupported_0xNN"` and `fields=null`.

use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::{
    Animation, CharGen, ChatPoseTable, EnvCell, Environment, GfxObj, MotionTable,
    Palette, ParticleEmitter, PhysicsScript, PhysicsScriptTable, Region, Scene, SetupModel,
    SkillTable, SoundTable, SpellTable, Surface, SurfaceTexture, Texture, Wave, XpTable,
};
use holtburger_dat::landblock::{CellLandblock, LandblockInfo};
use serde::Serialize;
use std::env;
use std::process::ExitCode;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    id_hex: String,
    id: u32,
    type_name: String,
    fields: Option<serde_json::Value>,
    error_message: Option<String>,
    source: String,
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() != 2 {
        eprintln!("usage: parse_dat_record <dat_path> <id_hex>");
        return ExitCode::from(2);
    }
    let dat_path = &args[0];
    let id_str = args[1].trim_start_matches("0x").trim_start_matches("0X");
    let id = match u32::from_str_radix(id_str, 16) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("invalid hex id '{}': {e}", args[1]);
            return ExitCode::from(2);
        }
    };
    let id_hex = format!("0x{:08X}", id);

    let dat = match DatDatabase::new(dat_path) {
        Ok(d) => d,
        Err(e) => {
            emit_err(&id_hex, id, "Unknown", &format!("open dat: {e}"));
            return ExitCode::SUCCESS;
        }
    };

    let bytes = match dat.get_file(id) {
        Ok(b) => b,
        Err(e) => {
            emit_err(&id_hex, id, "Unknown", &format!("record not present: {e}"));
            return ExitCode::SUCCESS;
        }
    };

    let parsed = dispatch_parse(id, &bytes, dat_path);
    let out = Output {
        id_hex,
        id,
        type_name: parsed.type_name,
        fields: parsed.fields,
        error_message: parsed.error_message,
        source: parsed.source,
    };
    match serde_json::to_string(&out) {
        Ok(s) => {
            println!("{}", s);
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("serialize: {e}");
            ExitCode::from(3)
        }
    }
}

fn emit_err(id_hex: &str, id: u32, type_name: &str, msg: &str) {
    let out = Output {
        id_hex: id_hex.to_string(),
        id,
        type_name: type_name.to_string(),
        fields: None,
        error_message: Some(msg.to_string()),
        source: "holtburger-dat::DatDatabase".to_string(),
    };
    if let Ok(s) = serde_json::to_string(&out) {
        println!("{}", s);
    }
}

struct ParseOutcome {
    type_name: String,
    source: String,
    fields: Option<serde_json::Value>,
    error_message: Option<String>,
}

impl ParseOutcome {
    fn ok<T: Serialize>(type_name: &str, source: &str, value: &T) -> Self {
        match serde_json::to_value(value) {
            Ok(v) => ParseOutcome {
                type_name: type_name.to_string(),
                source: source.to_string(),
                fields: Some(v),
                error_message: None,
            },
            Err(e) => ParseOutcome {
                type_name: type_name.to_string(),
                source: source.to_string(),
                fields: None,
                error_message: Some(format!("serialize: {e}")),
            },
        }
    }

    fn err(type_name: &str, source: &str, msg: String) -> Self {
        ParseOutcome {
            type_name: type_name.to_string(),
            source: source.to_string(),
            fields: None,
            error_message: Some(msg),
        }
    }

    fn unsupported(type_name: &str) -> Self {
        ParseOutcome {
            type_name: type_name.to_string(),
            source: "(no parser)".to_string(),
            fields: None,
            error_message: Some(format!(
                "no holtburger-dat parser dispatch for type '{type_name}'"
            )),
        }
    }
}

fn dispatch_parse(id: u32, bytes: &[u8], dat_path: &str) -> ParseOutcome {
    // Cell-DAT vs portal-DAT disambiguation: when reading from
    // `client_cell_*.dat`, the high byte of `id` is the landblock-x
    // coordinate (not the AC type-prefix), so `0x200F0A0B` is *not* a
    // SoundTable record — it's the EnvCell at landblock `0x200F`,
    // cell `0x0A0B`. Without this hint, `from_id`-style prefix dispatch
    // routes the bytes through `SoundTable::unpack`, which fabricates
    // a hash-table capacity from the cell's coord bytes and allocates
    // ~18 GiB before crashing.
    //
    // Mirrors the heuristic in the Chorizite `DatDatabase` (it loads
    // per-DAT type registries instead of one global prefix table).
    let dat_is_cells = dat_path
        .rsplit(['/', '\\'])
        .next()
        .map(|n| {
            let lower = n.to_ascii_lowercase();
            lower.contains("client_cell_") || lower.contains("client_highres_")
        })
        .unwrap_or(false);

    let suffix = id & 0xFFFF;
    if suffix == 0xFFFF {
        let mut c = std::io::Cursor::new(bytes);
        return match <CellLandblock as binrw::BinRead>::read(&mut c) {
            Ok(v) => ParseOutcome::ok("LandBlock", "holtburger_dat::landblock::CellLandblock", &v),
            Err(e) => ParseOutcome::err(
                "LandBlock",
                "holtburger_dat::landblock::CellLandblock",
                format!("parse: {e}"),
            ),
        };
    }
    if suffix == 0xFFFE {
        return match LandblockInfo::unpack(bytes) {
            Ok(v) => ParseOutcome::ok(
                "LandBlockInfo",
                "holtburger_dat::landblock::LandblockInfo",
                &v,
            ),
            Err(e) => ParseOutcome::err(
                "LandBlockInfo",
                "holtburger_dat::landblock::LandblockInfo",
                format!("parse: {e:?}"),
            ),
        };
    }
    if id == 0xFFFF0001 {
        return ParseOutcome::unsupported("Iteration");
    }

    // EnvCell indoor cells: suffix is in [0x0001..=0xFFFD]. They live in
    // client_cell_1.dat, prefix isn't reliable (it's the landblock high
    // bytes). We catch them here.
    if suffix > 0 && suffix < 0xFFFE {
        let prefix = (id >> 24) as u8;
        // Two routes into EnvCell:
        //   (a) reading from `client_cell_*.dat` — prefix is landblock-x,
        //       NOT a type-prefix. Always EnvCell at this suffix range.
        //   (b) reading from `client_portal.dat` — prefix 0x0D is the
        //       EnvCell DBObj namespace (from_id handles it explicitly,
        //       see file_type/mod.rs:147). For non-portal prefixes (i.e.
        //       a coord-byte that doesn't collide with a known portal
        //       type), also bias to EnvCell here.
        if dat_is_cells || !is_portal_prefix(prefix) {
            let mut c = std::io::Cursor::new(bytes);
            return match EnvCell::unpack(&mut c) {
                Ok(v) => ParseOutcome::ok("EnvCell", "holtburger_dat::file_type::EnvCell", &v),
                Err(e) => ParseOutcome::err(
                    "EnvCell",
                    "holtburger_dat::file_type::EnvCell",
                    format!("parse: {e}"),
                ),
            };
        }
    }

    let prefix = (id >> 24) as u8;
    match prefix {
        0x01 => {
            let mut c = std::io::Cursor::new(bytes);
            match GfxObj::unpack(&mut c) {
                Ok(v) => ParseOutcome::ok("GfxObj", "holtburger_dat::file_type::GfxObj", &v),
                Err(e) => ParseOutcome::err("GfxObj", "holtburger_dat::file_type::GfxObj", format!("parse: {e}")),
            }
        }
        0x02 => {
            let mut c = std::io::Cursor::new(bytes);
            match SetupModel::unpack(&mut c) {
                Ok(v) => ParseOutcome::ok("Setup", "holtburger_dat::file_type::SetupModel", &v),
                Err(e) => ParseOutcome::err("Setup", "holtburger_dat::file_type::SetupModel", format!("parse: {e}")),
            }
        }
        0x03 => {
            let mut c = std::io::Cursor::new(bytes);
            match Animation::read(&mut c) {
                Ok(v) => ParseOutcome::ok("Animation", "holtburger_dat::file_type::Animation", &v),
                Err(e) => ParseOutcome::err("Animation", "holtburger_dat::file_type::Animation", format!("parse: {e}")),
            }
        }
        0x04 => match Palette::unpack(bytes) {
            Ok(v) => ParseOutcome::ok("Palette", "holtburger_dat::file_type::Palette", &v),
            Err(e) => ParseOutcome::err("Palette", "holtburger_dat::file_type::Palette", format!("parse: {e}")),
        },
        0x05 => match SurfaceTexture::unpack(bytes) {
            Ok(v) => ParseOutcome::ok("SurfaceTexture", "holtburger_dat::file_type::SurfaceTexture", &v),
            Err(e) => ParseOutcome::err("SurfaceTexture", "holtburger_dat::file_type::SurfaceTexture", format!("parse: {e}")),
        },
        0x06 | 0x07 => match Texture::unpack(bytes) {
            // Chorizite calls 0x06 records "RenderSurface" (matches the
            // seeds.json type name). Mirror that here.
            Ok(v) => ParseOutcome::ok("RenderSurface", "holtburger_dat::file_type::Texture", &v),
            Err(e) => ParseOutcome::err("RenderSurface", "holtburger_dat::file_type::Texture", format!("parse: {e}")),
        },
        0x08 => match Surface::unpack(bytes) {
            Ok(v) => ParseOutcome::ok("Surface", "holtburger_dat::file_type::Surface", &v),
            Err(e) => ParseOutcome::err("Surface", "holtburger_dat::file_type::Surface", format!("parse: {e}")),
        },
        0x09 => {
            let mut c = std::io::Cursor::new(bytes);
            match MotionTable::read(&mut c) {
                Ok(v) => ParseOutcome::ok("MotionTable", "holtburger_dat::file_type::MotionTable", &v),
                Err(e) => ParseOutcome::err("MotionTable", "holtburger_dat::file_type::MotionTable", format!("parse: {e}")),
            }
        }
        0x0A => match Wave::unpack(bytes) {
            Ok(v) => ParseOutcome::ok("Wave", "holtburger_dat::file_type::Wave", &v),
            Err(e) => ParseOutcome::err("Wave", "holtburger_dat::file_type::Wave", format!("parse: {e}")),
        },
        0x0D => {
            let mut c = std::io::Cursor::new(bytes);
            match EnvCell::unpack(&mut c) {
                Ok(v) => ParseOutcome::ok("EnvCell", "holtburger_dat::file_type::EnvCell", &v),
                Err(e) => ParseOutcome::err("EnvCell", "holtburger_dat::file_type::EnvCell", format!("parse: {e}")),
            }
        }
        0x0E => parse_table_record(id, bytes),
        0x0F | 0x1F => {
            let mut c = std::io::Cursor::new(bytes);
            match Environment::unpack(&mut c) {
                Ok(v) => ParseOutcome::ok("Environment", "holtburger_dat::file_type::Environment", &v),
                Err(e) => ParseOutcome::err("Environment", "holtburger_dat::file_type::Environment", format!("parse: {e}")),
            }
        }
        0x12 => {
            let mut c = std::io::Cursor::new(bytes);
            match Scene::unpack(&mut c) {
                Ok(v) => ParseOutcome::ok("Scene", "holtburger_dat::file_type::Scene", &v),
                Err(e) => ParseOutcome::err("Scene", "holtburger_dat::file_type::Scene", format!("parse: {e}")),
            }
        }
        0x13 => {
            let mut c = std::io::Cursor::new(bytes);
            match Region::unpack(&mut c) {
                Ok(v) => ParseOutcome::ok("Region", "holtburger_dat::file_type::Region", &v),
                Err(e) => ParseOutcome::err("Region", "holtburger_dat::file_type::Region", format!("parse: {e}")),
            }
        }
        0x20 => match SoundTable::unpack(bytes) {
            Ok(v) => ParseOutcome::ok("SoundTable", "holtburger_dat::file_type::SoundTable", &v),
            Err(e) => ParseOutcome::err("SoundTable", "holtburger_dat::file_type::SoundTable", format!("parse: {e}")),
        },
        0x32 => match ParticleEmitter::unpack(bytes) {
            Ok(v) => ParseOutcome::ok("ParticleEmitter", "holtburger_dat::file_type::ParticleEmitter", &v),
            Err(e) => ParseOutcome::err("ParticleEmitter", "holtburger_dat::file_type::ParticleEmitter", format!("parse: {e}")),
        },
        0x33 => match PhysicsScript::unpack(bytes) {
            Ok(v) => ParseOutcome::ok("PhysicsScript", "holtburger_dat::file_type::PhysicsScript", &v),
            Err(e) => ParseOutcome::err("PhysicsScript", "holtburger_dat::file_type::PhysicsScript", format!("parse: {e}")),
        },
        0x34 => {
            let mut c = std::io::Cursor::new(bytes);
            match PhysicsScriptTable::read(&mut c) {
                Ok(v) => ParseOutcome::ok("PhysicsScriptTable", "holtburger_dat::file_type::PhysicsScriptTable", &v),
                Err(e) => ParseOutcome::err("PhysicsScriptTable", "holtburger_dat::file_type::PhysicsScriptTable", format!("parse: {e}")),
            }
        }
        _ => ParseOutcome::unsupported(&format!("Unsupported_0x{:02X}", prefix)),
    }
}

fn is_portal_prefix(prefix: u8) -> bool {
    matches!(
        prefix,
        0x01 | 0x02
            | 0x03
            | 0x04
            | 0x05
            | 0x06
            | 0x07
            | 0x08
            | 0x09
            | 0x0A
            | 0x0D
            | 0x0E
            | 0x0F
            | 0x10
            | 0x12
            | 0x13
            | 0x1F
            | 0x20
            | 0x30
            | 0x31
            | 0x32
            | 0x33
            | 0x34
            | 0x40
    )
}

/// 0x0E table sub-dispatch — Chorizite splits these by file ID.
fn parse_table_record(id: u32, bytes: &[u8]) -> ParseOutcome {
    use binrw::BinRead;
    match id {
        0x0E000004 => {
            let mut c = std::io::Cursor::new(bytes);
            match SkillTable::read(&mut c) {
                Ok(v) => ParseOutcome::ok("SkillTable", "holtburger_dat::file_type::SkillTable", &v),
                Err(e) => ParseOutcome::err("SkillTable", "holtburger_dat::file_type::SkillTable", format!("parse: {e}")),
            }
        }
        0x0E000007 => {
            let mut c = std::io::Cursor::new(bytes);
            match ChatPoseTable::read(&mut c) {
                Ok(v) => ParseOutcome::ok("ChatPoseTable", "holtburger_dat::file_type::ChatPoseTable", &v),
                Err(e) => ParseOutcome::err("ChatPoseTable", "holtburger_dat::file_type::ChatPoseTable", format!("parse: {e}")),
            }
        }
        0x0E000014 => {
            let mut c = std::io::Cursor::new(bytes);
            match CharGen::read(&mut c) {
                Ok(v) => ParseOutcome::ok("CharGen", "holtburger_dat::file_type::CharGen", &v),
                Err(e) => ParseOutcome::err("CharGen", "holtburger_dat::file_type::CharGen", format!("parse: {e}")),
            }
        }
        0x0E000018 => {
            let mut c = std::io::Cursor::new(bytes);
            match XpTable::read(&mut c) {
                Ok(v) => ParseOutcome::ok("ExperienceTable", "holtburger_dat::file_type::XpTable", &v),
                Err(e) => ParseOutcome::err("ExperienceTable", "holtburger_dat::file_type::XpTable", format!("parse: {e}")),
            }
        }
        0x0E00000E => {
            let mut c = std::io::Cursor::new(bytes);
            match SpellTable::read(&mut c) {
                Ok(v) => ParseOutcome::ok("SpellTable", "holtburger_dat::file_type::SpellTable", &v),
                Err(e) => ParseOutcome::err("SpellTable", "holtburger_dat::file_type::SpellTable", format!("parse: {e}")),
            }
        }
        _ => ParseOutcome::unsupported(&format!("Table_0x{:08X}", id)),
    }
}

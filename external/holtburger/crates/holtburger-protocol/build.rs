//! PR 7 — Tier-1 codegen layer from Chorizite's `protocol.xml`.
//!
//! Parses `external/chorizite/Chorizite.ACProtocol/Chorizite.ACProtocol/protocol.xml`
//! and emits `$OUT_DIR/messages_generated.rs` containing:
//!
//! - All enums (with duplicate-discriminant aliases promoted to `pub const`).
//! - All "simple" datatypes — types whose body contains ONLY `<field>`
//!   children with primitive or already-emitted types. Conditional encoding
//!   (`<switch>`, `<if>`, `<mask>`, `<maskmap>`, `<subfield>`, `<table>`,
//!   `<vector>`, `<align>`) is DEFERRED to PR 7.2 — those entries are
//!   skipped with a doc-comment explaining why.
//! - All "simple" `<messages>`, `<gameactions>`, `<gameevents>` entries with
//!   an `OPCODE` constant + struct + `read_from()` function.
//!
//! Output goes to `$OUT_DIR` (Cargo convention) and is `include!()`-d from
//! `src/lib.rs::generated`. The hand-written `messages/*.rs` modules are NOT
//! touched; the generated layer is purely additive.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::env;
use std::fmt::Write as _;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use roxmltree::{Document, Node};

const PROTOCOL_XML_REL: &str =
    "../../../chorizite/Chorizite.ACProtocol/Chorizite.ACProtocol/protocol.xml";

fn main() {
    let crate_root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let xml_path = crate_root.join(PROTOCOL_XML_REL);

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed={}", xml_path.display());

    let xml_path_canon = xml_path
        .canonicalize()
        .unwrap_or_else(|e| panic!("Failed to canonicalize {}: {e}", xml_path.display()));

    let xml_src = fs::read_to_string(&xml_path_canon).unwrap_or_else(|e| {
        panic!("Failed to read protocol.xml at {}: {e}", xml_path_canon.display())
    });

    let line_offsets = build_line_offsets(&xml_src);

    let doc = Document::parse(&xml_src).expect("protocol.xml is not well-formed XML");
    let root = doc.root_element();

    let mut ctx = CodegenCtx::new(&xml_path_canon, &line_offsets);

    for child in root.children().filter(|n| n.is_element()) {
        if child.tag_name().name() == "enums" {
            ctx.process_enums(child);
        }
    }
    for child in root.children().filter(|n| n.is_element()) {
        if child.tag_name().name() == "types" {
            ctx.collect_typedefs(child);
        }
    }
    for child in root.children().filter(|n| n.is_element()) {
        if child.tag_name().name() == "types" {
            ctx.process_datatypes(child);
        }
    }
    for child in root.children().filter(|n| n.is_element()) {
        match child.tag_name().name() {
            "messages" => ctx.process_messages(child),
            "gameactions" => ctx.process_gameactions(child),
            "gameevents" => ctx.process_gameevents(child),
            _ => {}
        }
    }

    ctx.write_opcode_table();

    println!(
        "cargo:warning=holtburger-protocol/build.rs: emitted {} enums ({} aliases), {} datatypes ({} skipped), {} messages ({} skipped), {} gameactions ({} skipped), {} gameevents ({} skipped)",
        ctx.stats.enums_emitted,
        ctx.stats.enum_aliases_emitted,
        ctx.stats.datatypes_emitted,
        ctx.stats.datatypes_skipped,
        ctx.stats.messages_emitted,
        ctx.stats.messages_skipped,
        ctx.stats.gameactions_emitted,
        ctx.stats.gameactions_skipped,
        ctx.stats.gameevents_emitted,
        ctx.stats.gameevents_skipped,
    );

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let out_path = out_dir.join("messages_generated.rs");
    let mut out = fs::File::create(&out_path).unwrap();
    out.write_all(ctx.buf.as_bytes()).unwrap();
}

#[derive(Default)]
struct Stats {
    enums_emitted: usize,
    enum_aliases_emitted: usize,
    datatypes_emitted: usize,
    datatypes_skipped: usize,
    messages_emitted: usize,
    messages_skipped: usize,
    gameactions_emitted: usize,
    gameactions_skipped: usize,
    gameevents_emitted: usize,
    gameevents_skipped: usize,
}

struct CodegenCtx<'a> {
    buf: String,
    xml_path: &'a Path,
    line_offsets: &'a [usize],
    type_kind: HashMap<String, TypeKind>,
    opcode_index: Vec<(String, String, u32)>,
    stats: Stats,
}

#[derive(Clone, Debug)]
enum TypeKind {
    Primitive(&'static str),
    Struct,
    Enum(EnumRepr),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EnumRepr {
    U8,
    U16,
    U32,
    U64,
    I32,
    I64,
}

impl EnumRepr {
    fn rust_ty(self) -> &'static str {
        match self {
            EnumRepr::U8 => "u8",
            EnumRepr::U16 => "u16",
            EnumRepr::U32 => "u32",
            EnumRepr::U64 => "u64",
            EnumRepr::I32 => "i32",
            EnumRepr::I64 => "i64",
        }
    }
    fn byte_width(self) -> usize {
        match self {
            EnumRepr::U8 => 1,
            EnumRepr::U16 => 2,
            EnumRepr::U32 | EnumRepr::I32 => 4,
            EnumRepr::U64 | EnumRepr::I64 => 8,
        }
    }
    fn from_parent(parent: Option<&str>) -> Option<EnumRepr> {
        match parent? {
            "byte" => Some(EnumRepr::U8),
            "ushort" => Some(EnumRepr::U16),
            "uint" => Some(EnumRepr::U32),
            "ulong" => Some(EnumRepr::U64),
            "int" => Some(EnumRepr::I32),
            "long" => Some(EnumRepr::I64),
            _ => None,
        }
    }
}

#[derive(Clone, Copy)]
enum EmitKind {
    Datatype,
    MessageC2S,
    MessageS2C,
    GameAction,
    GameEvent,
}

impl EmitKind {
    fn label(self) -> &'static str {
        match self {
            EmitKind::Datatype => "datatype",
            EmitKind::MessageC2S => "messageC2S",
            EmitKind::MessageS2C => "messageS2C",
            EmitKind::GameAction => "gameaction",
            EmitKind::GameEvent => "gameevent",
        }
    }
    fn name_prefix(self) -> &'static str {
        // Disambiguate names that collide across sections:
        // - Login_LogOffCharacter exists in both `<c2s>` and `<s2c>`
        // - Fellowship_Quit exists in both `<gameactions>` and `<gameevents>`
        // - Datatypes are global (struct references), so no prefix.
        match self {
            EmitKind::Datatype => "",
            EmitKind::MessageC2S => "C2S_",
            EmitKind::MessageS2C => "S2C_",
            EmitKind::GameAction => "Action_",
            EmitKind::GameEvent => "Event_",
        }
    }
    fn bump_skipped(self, stats: &mut Stats) {
        match self {
            EmitKind::Datatype => stats.datatypes_skipped += 1,
            EmitKind::MessageC2S | EmitKind::MessageS2C => stats.messages_skipped += 1,
            EmitKind::GameAction => stats.gameactions_skipped += 1,
            EmitKind::GameEvent => stats.gameevents_skipped += 1,
        }
    }
    fn bump_emitted(self, stats: &mut Stats) {
        match self {
            EmitKind::Datatype => stats.datatypes_emitted += 1,
            EmitKind::MessageC2S | EmitKind::MessageS2C => stats.messages_emitted += 1,
            EmitKind::GameAction => stats.gameactions_emitted += 1,
            EmitKind::GameEvent => stats.gameevents_emitted += 1,
        }
    }
}

impl<'a> CodegenCtx<'a> {
    fn new(xml_path: &'a Path, line_offsets: &'a [usize]) -> Self {
        let mut ctx = Self {
            buf: String::with_capacity(512 * 1024),
            xml_path,
            line_offsets,
            type_kind: HashMap::new(),
            opcode_index: Vec::new(),
            stats: Stats::default(),
        };
        ctx.write_file_header();
        ctx
    }

    fn write_file_header(&mut self) {
        // NOTE: this file is consumed via `include!()` from inside an existing
        // module, so we use regular `//` comments (not `//!` which would be a
        // mid-module inner attribute and trigger E0753).
        writeln!(
            self.buf,
            "// AUTOGENERATED from `Chorizite.ACProtocol/protocol.xml` by `build.rs` — DO NOT EDIT BY HAND."
        )
        .unwrap();
        writeln!(
            self.buf,
            "// Source: {}",
            self.xml_path.display().to_string().replace('\\', "/")
        )
        .unwrap();
        writeln!(
            self.buf,
            "// Regenerate by re-running `cargo build -p holtburger-protocol`."
        )
        .unwrap();
        writeln!(self.buf, "//").unwrap();
        writeln!(
            self.buf,
            "// PR 7 foundation tier: emits enums + simple struct types + simple"
        )
        .unwrap();
        writeln!(
            self.buf,
            "// per-opcode messages. Conditional encoding is deferred (`// SKIPPED ...`)."
        )
        .unwrap();
        writeln!(self.buf).unwrap();
        writeln!(
            self.buf,
            "// A 4-byte-on-the-wire boolean. Decoded as `nonzero u32 -> true` per"
        )
        .unwrap();
        writeln!(
            self.buf,
            "// acclient.c:702448 + `chorizite-reading-guide-summary-2026-05-27.md` §2 row 10."
        )
        .unwrap();
        writeln!(self.buf, "pub type WireBool = bool;").unwrap();
        writeln!(self.buf).unwrap();

        for (name, rust_ty) in PRIMITIVE_BUILTINS {
            self.type_kind.insert((*name).to_string(), TypeKind::Primitive(rust_ty));
        }
    }

    // ENUMS -----------------------------------------------------------------

    fn process_enums(&mut self, enums_node: Node<'_, '_>) {
        writeln!(self.buf, "// === ENUMS ===\n").unwrap();
        for n in enums_node.children().filter(|n| n.is_element() && n.tag_name().name() == "enum") {
            self.emit_enum(n);
        }
    }

    fn emit_enum(&mut self, n: Node<'_, '_>) {
        let name = match n.attribute("name") {
            Some(v) => v.to_string(),
            None => return,
        };
        let parent = n.attribute("parent");
        let repr = match EnumRepr::from_parent(parent) {
            Some(r) => r,
            None => {
                writeln!(self.buf, "// SKIPPED enum {name}: unknown parent type {parent:?}\n").unwrap();
                return;
            }
        };

        // Dedup by discriminant.
        let mut seen_disc = BTreeSet::new();
        let mut variants: Vec<(String, i128, Option<String>)> = Vec::new();
        let mut aliases: Vec<(String, i128, String, Option<String>)> = Vec::new();
        for v in n.children().filter(|c| c.is_element() && c.tag_name().name() == "value") {
            let vname = match v.attribute("name") { Some(v) => v.to_string(), None => continue };
            let vraw = match v.attribute("value") { Some(v) => v, None => continue };
            let parsed = match parse_int_literal(vraw) {
                Some(p) => p,
                None => continue,
            };
            let text = v.attribute("text").map(|s| s.to_string());
            if seen_disc.insert(parsed) {
                variants.push((vname, parsed, text));
            } else {
                let canonical = variants.iter().find(|(_, d, _)| *d == parsed).map(|(n, _, _)| n.clone()).unwrap_or_else(|| "Unknown".to_string());
                aliases.push((vname, parsed, canonical, text));
            }
        }
        if variants.is_empty() {
            writeln!(self.buf, "// SKIPPED enum {name}: no parseable variants\n").unwrap();
            return;
        }

        writeln!(self.buf, "/// `{name}` enum from protocol.xml (parent `{}`).", parent.unwrap_or("?")).unwrap();
        if let Some(txt) = n.attribute("text") {
            writeln!(self.buf, "/// {}", escape_doc(txt)).unwrap();
        }
        writeln!(self.buf, "#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]").unwrap();
        writeln!(self.buf, "#[repr({})]", repr.rust_ty()).unwrap();
        writeln!(self.buf, "pub enum {name} {{").unwrap();
        for (vname, val, text) in &variants {
            if let Some(t) = text {
                writeln!(self.buf, "    /// {}", escape_doc(t)).unwrap();
            }
            writeln!(self.buf, "    {} = {},", sanitize_rust_keyword(vname), format_enum_literal(*val, repr)).unwrap();
        }
        writeln!(self.buf, "}}\n").unwrap();

        for (alias, _val, canonical, text) in &aliases {
            let canonical_id = sanitize_rust_keyword(canonical);
            let alias_const = sanitize_const_name(alias);
            if let Some(t) = text {
                writeln!(self.buf, "/// Alias of {name}::{canonical_id}. {}", escape_doc(t)).unwrap();
            } else {
                writeln!(self.buf, "/// Alias of {name}::{canonical_id}.").unwrap();
            }
            writeln!(self.buf, "pub const {name}_{alias_const}: {name} = {name}::{canonical_id};").unwrap();
            self.stats.enum_aliases_emitted += 1;
        }
        if !aliases.is_empty() {
            writeln!(self.buf).unwrap();
        }

        // read_from helper. Returns Ok(Ok(variant))/Ok(Err(raw)).
        let n_bytes = repr.byte_width();
        let read_expr = match repr {
            EnumRepr::U8 => "data[*offset]".to_string(),
            EnumRepr::U16 => "u16::from_le_bytes([data[*offset], data[*offset+1]])".to_string(),
            EnumRepr::U32 => "u32::from_le_bytes([data[*offset], data[*offset+1], data[*offset+2], data[*offset+3]])".to_string(),
            EnumRepr::I32 => "i32::from_le_bytes([data[*offset], data[*offset+1], data[*offset+2], data[*offset+3]])".to_string(),
            EnumRepr::U64 => "u64::from_le_bytes([data[*offset], data[*offset+1], data[*offset+2], data[*offset+3], data[*offset+4], data[*offset+5], data[*offset+6], data[*offset+7]])".to_string(),
            EnumRepr::I64 => "i64::from_le_bytes([data[*offset], data[*offset+1], data[*offset+2], data[*offset+3], data[*offset+4], data[*offset+5], data[*offset+6], data[*offset+7]])".to_string(),
        };
        writeln!(self.buf, "impl {name} {{").unwrap();
        writeln!(self.buf, "    /// Decode this enum from a little-endian wire stream at `*offset`.").unwrap();
        writeln!(self.buf, "    /// Returns `Ok(Ok(variant))` for known values, `Ok(Err(raw))` for unknown values.").unwrap();
        writeln!(self.buf, "    pub fn read_from(\n        data: &[u8],\n        offset: &mut usize,\n    ) -> Result<Result<{name}, {repr_ty}>, &'static str> {{", repr_ty = repr.rust_ty()).unwrap();
        writeln!(self.buf, "        if *offset + {n_bytes} > data.len() {{ return Err(\"truncated enum {name}\"); }}").unwrap();
        writeln!(self.buf, "        let raw = {read_expr}; *offset += {n_bytes};").unwrap();
        writeln!(self.buf, "        Ok(match raw {{").unwrap();
        for (vname, _val, _) in &variants {
            let vid = sanitize_rust_keyword(vname);
            writeln!(self.buf, "            x if x == {name}::{vid} as {} => Ok({name}::{vid}),", repr.rust_ty()).unwrap();
        }
        writeln!(self.buf, "            other => Err(other),").unwrap();
        writeln!(self.buf, "        }})\n    }}\n}}\n").unwrap();

        self.type_kind.insert(name, TypeKind::Enum(repr));
        self.stats.enums_emitted += 1;
    }

    // TYPEDEFS --------------------------------------------------------------

    fn collect_typedefs(&mut self, types_node: Node<'_, '_>) {
        for n in types_node.children().filter(|n| n.is_element() && n.tag_name().name() == "type") {
            let name = match n.attribute("name") { Some(v) => v, None => continue };
            if n.attribute("primitive").is_some() { continue; }
            let has_children = n.children().any(|c| c.is_element());
            if !has_children {
                if let Some(parent) = n.attribute("parent") {
                    if !self.type_kind.contains_key(name) {
                        if let Some(rust_ty) = self.resolve_primitive_chain(parent) {
                            self.type_kind.insert(name.to_string(), TypeKind::Primitive(rust_ty));
                        }
                    }
                }
            }
        }
    }

    fn resolve_primitive_chain(&self, name: &str) -> Option<&'static str> {
        match self.type_kind.get(name)? {
            TypeKind::Primitive(s) => Some(*s),
            _ => None,
        }
    }

    // DATATYPES -------------------------------------------------------------

    fn process_datatypes(&mut self, types_node: Node<'_, '_>) {
        writeln!(self.buf, "// === DATATYPES ===\n").unwrap();
        for n in types_node.children().filter(|n| n.is_element() && n.tag_name().name() == "type") {
            if n.attribute("primitive").is_some() { continue; }
            let has_children = n.children().any(|c| c.is_element());
            if !has_children { continue; }
            self.emit_message(n, EmitKind::Datatype);
        }
    }

    // MESSAGES --------------------------------------------------------------

    fn process_messages(&mut self, messages_node: Node<'_, '_>) {
        writeln!(self.buf, "// === MESSAGES (top-level C2S + S2C) ===\n").unwrap();
        for direction in messages_node.children().filter(|n| n.is_element()) {
            let kind = match direction.tag_name().name() {
                "c2s" => EmitKind::MessageC2S,
                "s2c" => EmitKind::MessageS2C,
                _ => continue,
            };
            writeln!(self.buf, "// ---- {} ----\n", direction.tag_name().name().to_uppercase()).unwrap();
            for n in direction.children().filter(|n| n.is_element() && n.tag_name().name() == "type") {
                self.emit_message(n, kind);
            }
        }
    }

    fn process_gameactions(&mut self, ga_node: Node<'_, '_>) {
        writeln!(self.buf, "// === GAMEACTIONS (C2S inside 0xF7B1) ===\n").unwrap();
        for n in ga_node.children().filter(|n| n.is_element() && n.tag_name().name() == "type") {
            self.emit_message(n, EmitKind::GameAction);
        }
    }

    fn process_gameevents(&mut self, ge_node: Node<'_, '_>) {
        writeln!(self.buf, "// === GAMEEVENTS (S2C inside 0xF7B0) ===\n").unwrap();
        for n in ge_node.children().filter(|n| n.is_element() && n.tag_name().name() == "type") {
            self.emit_message(n, EmitKind::GameEvent);
        }
    }

    // STRUCT EMITTER --------------------------------------------------------

    fn emit_message(&mut self, n: Node<'_, '_>, kind: EmitKind) {
        let raw_name = match n.attribute("name") { Some(v) => v.to_string(), None => return };
        let name = format!("{}{}", kind.name_prefix(), raw_name);
        let kind_str = kind.label();
        let opcode = n.attribute("type").and_then(parse_int_literal).and_then(|v| u32::try_from(v).ok());

        let unsupported = collect_unsupported(n);
        if !unsupported.is_empty() {
            writeln!(self.buf, "// SKIPPED {kind_str} {name}: deferred-tier features [{}] — port to PR 7.2.", unsupported.join(", ")).unwrap();
            kind.bump_skipped(&mut self.stats);
            return;
        }

        let fields = match self.collect_simple_fields(n) {
            Ok(f) => f,
            Err(reason) => {
                writeln!(self.buf, "// SKIPPED {kind_str} {name}: {reason} — port to PR 7.2.").unwrap();
                kind.bump_skipped(&mut self.stats);
                return;
            }
        };

        let pos = n.range();
        let lineno = line_of_offset(self.line_offsets, pos.start);
        writeln!(self.buf, "/// `{raw_name}` — generated from protocol.xml line {lineno}.").unwrap();
        if let Some(txt) = n.attribute("text") {
            writeln!(self.buf, "/// {}", escape_doc(txt)).unwrap();
        }
        if let Some(op) = opcode {
            writeln!(self.buf, "///\n/// Opcode: `0x{op:04X}` (see `{name}::OPCODE`).").unwrap();
        }
        writeln!(self.buf, "#[derive(Debug, Clone, PartialEq)]").unwrap();
        writeln!(self.buf, "pub struct {name} {{").unwrap();
        if fields.is_empty() {
            writeln!(self.buf, "    // No fields declared in protocol.xml for this opcode.").unwrap();
        }
        for f in &fields {
            if let Some(t) = &f.text {
                writeln!(self.buf, "    /// {}", escape_doc(t)).unwrap();
            }
            writeln!(self.buf, "    pub {}: {},", f.name_snake, f.rust_ty).unwrap();
        }
        writeln!(self.buf, "}}\n").unwrap();

        writeln!(self.buf, "impl {name} {{").unwrap();
        if let Some(op) = opcode {
            writeln!(self.buf, "    /// Wire opcode for this message (from protocol.xml `type=`).").unwrap();
            writeln!(self.buf, "    pub const OPCODE: u32 = 0x{op:04X};").unwrap();
            writeln!(self.buf).unwrap();
            self.opcode_index.push((kind_str.to_string(), raw_name.clone(), op));
        }
        writeln!(self.buf, "    /// Decode `{name}` from a little-endian wire stream at `*offset`.").unwrap();
        writeln!(self.buf, "    pub fn read_from(data: &[u8], offset: &mut usize) -> Result<Self, &'static str> {{").unwrap();
        if fields.is_empty() {
            writeln!(self.buf, "        let _ = (data, offset);").unwrap();
        }
        for f in &fields {
            emit_read_field(&mut self.buf, &f.name_snake, &f.field_kind);
        }
        writeln!(self.buf, "        Ok(Self {{").unwrap();
        for f in &fields {
            writeln!(self.buf, "            {},", f.name_snake).unwrap();
        }
        writeln!(self.buf, "        }})\n    }}").unwrap();
        writeln!(self.buf, "}}\n").unwrap();

        if matches!(kind, EmitKind::Datatype) {
            self.type_kind.insert(name, TypeKind::Struct);
        }
        kind.bump_emitted(&mut self.stats);
    }

    fn collect_simple_fields(&self, n: Node<'_, '_>) -> Result<Vec<SimpleField>, String> {
        let mut out = Vec::new();
        let mut seen_names: BTreeMap<String, usize> = BTreeMap::new();
        for c in n.children().filter(|c| c.is_element()) {
            let tag = c.tag_name().name();
            if tag != "field" {
                return Err(format!("unsupported child `<{tag}>`"));
            }
            let raw_name = c.attribute("name").ok_or_else(|| "<field> missing name".to_string())?;
            let raw_type = c.attribute("type").ok_or_else(|| format!("<field {raw_name}> missing type"))?;

            if c.children().any(|cc| cc.is_element()) {
                return Err(format!("field {raw_name}: nested element body (subfield/switch); deferred"));
            }

            let mut snake = to_snake_case(raw_name);
            let counter = seen_names.entry(snake.clone()).or_insert(0);
            if *counter > 0 {
                snake = format!("{snake}_{}", *counter + 1);
            }
            *counter += 1;
            let snake = sanitize_rust_keyword(&snake);

            let (rust_ty, field_kind) = match self.resolve_field(raw_type) {
                Some(p) => p,
                None => return Err(format!("field {raw_name}: type {raw_type:?} not in foundation tier")),
            };

            out.push(SimpleField { name_snake: snake, rust_ty, field_kind, text: c.attribute("text").map(|s| s.to_string()) });
        }
        Ok(out)
    }

    fn resolve_field(&self, raw_type: &str) -> Option<(String, FieldKind)> {
        match self.type_kind.get(raw_type)? {
            TypeKind::Primitive(rust_ty) => match *rust_ty {
                "u8" => Some(("u8".to_string(), FieldKind::PrimU8)),
                "u16" => Some(("u16".to_string(), FieldKind::PrimU16)),
                "u32" => Some(("u32".to_string(), FieldKind::PrimU32)),
                "u64" => Some(("u64".to_string(), FieldKind::PrimU64)),
                "i16" => Some(("i16".to_string(), FieldKind::PrimI16)),
                "i32" => Some(("i32".to_string(), FieldKind::PrimI32)),
                "i64" => Some(("i64".to_string(), FieldKind::PrimI64)),
                "f32" => Some(("f32".to_string(), FieldKind::PrimF32)),
                "f64" => Some(("f64".to_string(), FieldKind::PrimF64)),
                "bool" => Some(("WireBool".to_string(), FieldKind::Bool4Byte)),
                "String" => Some(("String".to_string(), FieldKind::String16)),
                "WString" => Some(("String".to_string(), FieldKind::WString)),
                "PackedDWORD" => Some(("u32".to_string(), FieldKind::PackedDword)),
                _ => None,
            },
            TypeKind::Enum(repr) => Some((raw_type.to_string(), FieldKind::Enum(raw_type.to_string(), *repr))),
            TypeKind::Struct => Some((raw_type.to_string(), FieldKind::Struct(raw_type.to_string()))),
        }
    }

    fn write_opcode_table(&mut self) {
        writeln!(self.buf, "// === OPCODE INDEX ===\n").unwrap();
        writeln!(self.buf, "/// All `(kind, bare_name, opcode)` tuples extracted from protocol.xml.").unwrap();
        writeln!(self.buf, "pub const OPCODE_INDEX: &[(&str, &str, u32)] = &[").unwrap();
        for (kind, name, op) in &self.opcode_index {
            writeln!(self.buf, "    ({:?}, {:?}, 0x{op:04X}),", kind, name).unwrap();
        }
        writeln!(self.buf, "];").unwrap();
    }
}

// FIELD KIND + READ EMITTER ------------------------------------------------

struct SimpleField {
    name_snake: String,
    rust_ty: String,
    field_kind: FieldKind,
    text: Option<String>,
}

#[derive(Debug, Clone)]
enum FieldKind {
    PrimU8,
    PrimU16,
    PrimU32,
    PrimU64,
    PrimI16,
    PrimI32,
    PrimI64,
    PrimF32,
    PrimF64,
    Bool4Byte,
    String16,
    WString,
    PackedDword,
    Enum(String, EnumRepr),
    Struct(String),
}

fn emit_read_field(buf: &mut String, snake: &str, kind: &FieldKind) {
    fn prelude(buf: &mut String, n_bytes: usize, label: &str, snake: &str) {
        writeln!(buf, "        if *offset + {n_bytes} > data.len() {{ return Err(\"truncated {label} field {snake}\"); }}").unwrap();
    }
    match kind {
        FieldKind::PrimU8 => {
            prelude(buf, 1, "u8", snake);
            writeln!(buf, "        let {snake}: u8 = data[*offset]; *offset += 1;").unwrap();
        }
        FieldKind::PrimU16 => {
            prelude(buf, 2, "u16", snake);
            writeln!(buf, "        let {snake}: u16 = u16::from_le_bytes([data[*offset], data[*offset+1]]); *offset += 2;").unwrap();
        }
        FieldKind::PrimU32 => {
            prelude(buf, 4, "u32", snake);
            writeln!(buf, "        let {snake}: u32 = u32::from_le_bytes([data[*offset], data[*offset+1], data[*offset+2], data[*offset+3]]); *offset += 4;").unwrap();
        }
        FieldKind::PrimU64 => {
            prelude(buf, 8, "u64", snake);
            writeln!(buf, "        let {snake}: u64 = u64::from_le_bytes([data[*offset], data[*offset+1], data[*offset+2], data[*offset+3], data[*offset+4], data[*offset+5], data[*offset+6], data[*offset+7]]); *offset += 8;").unwrap();
        }
        FieldKind::PrimI16 => {
            prelude(buf, 2, "i16", snake);
            writeln!(buf, "        let {snake}: i16 = i16::from_le_bytes([data[*offset], data[*offset+1]]); *offset += 2;").unwrap();
        }
        FieldKind::PrimI32 => {
            prelude(buf, 4, "i32", snake);
            writeln!(buf, "        let {snake}: i32 = i32::from_le_bytes([data[*offset], data[*offset+1], data[*offset+2], data[*offset+3]]); *offset += 4;").unwrap();
        }
        FieldKind::PrimI64 => {
            prelude(buf, 8, "i64", snake);
            writeln!(buf, "        let {snake}: i64 = i64::from_le_bytes([data[*offset], data[*offset+1], data[*offset+2], data[*offset+3], data[*offset+4], data[*offset+5], data[*offset+6], data[*offset+7]]); *offset += 8;").unwrap();
        }
        FieldKind::PrimF32 => {
            prelude(buf, 4, "f32", snake);
            writeln!(buf, "        let {snake}: f32 = f32::from_le_bytes([data[*offset], data[*offset+1], data[*offset+2], data[*offset+3]]); *offset += 4;").unwrap();
        }
        FieldKind::PrimF64 => {
            prelude(buf, 8, "f64", snake);
            writeln!(buf, "        let {snake}: f64 = f64::from_le_bytes([data[*offset], data[*offset+1], data[*offset+2], data[*offset+3], data[*offset+4], data[*offset+5], data[*offset+6], data[*offset+7]]); *offset += 8;").unwrap();
        }
        FieldKind::Bool4Byte => {
            prelude(buf, 4, "wire-bool", snake);
            writeln!(buf, "        let {snake}: WireBool = u32::from_le_bytes([data[*offset], data[*offset+1], data[*offset+2], data[*offset+3]]) != 0; *offset += 4;").unwrap();
        }
        FieldKind::String16 => {
            writeln!(buf, "        let {snake}: String = read_string16_le(data, offset)?;").unwrap();
        }
        FieldKind::WString => {
            writeln!(buf, "        let {snake}: String = read_wstring_le(data, offset)?;").unwrap();
        }
        FieldKind::PackedDword => {
            writeln!(buf, "        let {snake}: u32 = read_packed_dword(data, offset)?;").unwrap();
        }
        FieldKind::Enum(name, _repr) => {
            writeln!(buf, "        let {snake}_raw = {name}::read_from(data, offset)?;").unwrap();
            writeln!(buf, "        let {snake}: {name} = match {snake}_raw {{ Ok(v) => v, Err(_) => return Err(\"unknown {name} discriminant\") }};").unwrap();
        }
        FieldKind::Struct(name) => {
            writeln!(buf, "        let {snake}: {name} = {name}::read_from(data, offset)?;").unwrap();
        }
    }
}

// HELPERS ------------------------------------------------------------------

const PRIMITIVE_BUILTINS: &[(&str, &str)] = &[
    ("bool", "bool"),
    ("byte", "u8"),
    ("short", "i16"),
    ("ushort", "u16"),
    ("int", "i32"),
    ("uint", "u32"),
    ("long", "i64"),
    ("ulong", "u64"),
    ("float", "f32"),
    ("double", "f64"),
    ("string", "String"),
    ("WString", "WString"),
    ("ObjectId", "u32"),
    ("LandcellId", "u32"),
    ("PackedDWORD", "PackedDWORD"),
    ("DataId", "PackedDWORD"),
];

fn parse_int_literal(s: &str) -> Option<i128> {
    let s = s.trim();
    let (sign, body) = if let Some(stripped) = s.strip_prefix('-') {
        (-1i128, stripped)
    } else {
        (1i128, s)
    };
    let val = if let Some(hex) = body.strip_prefix("0x").or_else(|| body.strip_prefix("0X")) {
        i128::from_str_radix(hex, 16).ok()?
    } else {
        body.parse::<i128>().ok()?
    };
    Some(sign * val)
}

fn format_enum_literal(val: i128, repr: EnumRepr) -> String {
    match repr {
        EnumRepr::U8 => format!("0x{:02X}", val as u8),
        EnumRepr::U16 => format!("0x{:04X}", val as u16),
        EnumRepr::U32 => format!("0x{:08X}", val as u32),
        EnumRepr::U64 => format!("0x{:016X}", val as u64),
        EnumRepr::I32 => format!("{}", val as i32),
        EnumRepr::I64 => format!("{}", val as i64),
    }
}

fn escape_doc(text: &str) -> String {
    text.replace('\r', " ")
        .replace('\n', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn to_snake_case(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 4);
    let chars: Vec<char> = name.chars().collect();
    for (i, c) in chars.iter().enumerate() {
        if c.is_ascii_uppercase() {
            let prev = if i > 0 { Some(chars[i - 1]) } else { None };
            let next = chars.get(i + 1).copied();
            let boundary = match (prev, next) {
                (None, _) => false,
                (Some(p), _) if !p.is_ascii_alphanumeric() => false,
                (Some(p), _) if p.is_ascii_lowercase() => true,
                (Some(p), Some(n)) if p.is_ascii_uppercase() && n.is_ascii_lowercase() => true,
                _ => false,
            };
            if boundary { out.push('_'); }
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(*c);
        }
    }
    out
}

/// `Self`/`self`/`super`/`crate` are reserved AND cannot be `r#`-prefixed;
/// we suffix them with `_v` instead. Other keywords get the `r#` raw-id prefix.
/// `data`/`offset` collide with our generated `read_from` parameter names —
/// we suffix them so a field named `Offset` doesn't shadow `&mut usize`.
fn sanitize_rust_keyword(s: &str) -> String {
    match s {
        "Self" | "self" | "super" | "crate" => format!("{s}_v"),
        "data" | "offset" => format!("{s}_field"),
        "type" | "ref" | "mod" | "let" | "fn" | "use" | "as" | "in" | "where" | "match"
        | "if" | "else" | "loop" | "while" | "for" | "return" | "break" | "continue"
        | "move" | "static" | "const" | "struct" | "enum" | "trait" | "impl" | "pub"
        | "extern" | "unsafe" | "box" | "yield" | "do" | "async" | "await" | "dyn"
        | "abstract" | "final" | "override" | "priv" | "typeof" | "virtual" | "become"
        | "true" | "false" => format!("r#{s}"),
        _ => s.to_string(),
    }
}

/// Const names cannot use `r#` raw identifiers — append `_alias` instead
/// for any keyword-named alias.
fn sanitize_const_name(s: &str) -> String {
    match s {
        "Self" | "self" | "super" | "crate" | "type" | "ref" | "mod" | "let" | "fn"
        | "use" | "as" | "in" | "where" | "match" | "if" | "else" | "loop" | "while"
        | "for" | "return" | "break" | "continue" | "move" | "static" | "const"
        | "struct" | "enum" | "trait" | "impl" | "pub" | "extern" | "unsafe" | "box"
        | "yield" | "do" | "async" | "await" | "dyn" | "abstract" | "final" | "override"
        | "priv" | "typeof" | "virtual" | "become" | "true" | "false" => {
            format!("{s}_alias")
        }
        _ => s.to_string(),
    }
}

fn collect_unsupported(n: Node<'_, '_>) -> Vec<&'static str> {
    let mut out = Vec::new();
    for c in n.children().filter(|c| c.is_element()) {
        match c.tag_name().name() {
            "switch" => push_unique(&mut out, "switch"),
            "if" => push_unique(&mut out, "if"),
            "mask" => push_unique(&mut out, "mask"),
            "maskmap" => push_unique(&mut out, "maskmap"),
            "subfield" => push_unique(&mut out, "subfield"),
            "table" => push_unique(&mut out, "table"),
            "vector" => push_unique(&mut out, "vector"),
            "align" => push_unique(&mut out, "align"),
            _ => {}
        }
    }
    out
}

fn push_unique(v: &mut Vec<&'static str>, item: &'static str) {
    if !v.contains(&item) {
        v.push(item);
    }
}

fn build_line_offsets(src: &str) -> Vec<usize> {
    let mut out = vec![0usize];
    for (i, b) in src.bytes().enumerate() {
        if b == b'\n' {
            out.push(i + 1);
        }
    }
    out
}

fn line_of_offset(line_offsets: &[usize], offset: usize) -> usize {
    match line_offsets.binary_search(&offset) {
        Ok(idx) => idx + 1,
        Err(idx) => idx,
    }
}

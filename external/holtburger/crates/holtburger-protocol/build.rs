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

        let steps = match self.collect_emit_steps(n, &raw_name) {
            Ok(s) => s,
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
        let fields_only: Vec<&SimpleField> = steps.iter().filter_map(|s| match s {
            EmitStep::Field(f) => Some(f),
            _ => None,
        }).collect();
        let vectors_only: Vec<&VectorField> = steps.iter().filter_map(|s| match s {
            EmitStep::Vector(v) => Some(v),
            _ => None,
        }).collect();
        if fields_only.is_empty() && vectors_only.is_empty() {
            writeln!(self.buf, "    // No fields declared in protocol.xml for this opcode.").unwrap();
        }
        // Emit fields + vectors in protocol.xml ORDER so the wire-decode
        // order matches the struct-declaration order (helps when reading
        // the generated source alongside the XML).
        for step in &steps {
            match step {
                EmitStep::Field(f) => {
                    if let Some(t) = &f.text {
                        writeln!(self.buf, "    /// {}", escape_doc(t)).unwrap();
                    }
                    writeln!(self.buf, "    pub {}: {},", f.name_snake, f.rust_ty).unwrap();
                }
                EmitStep::Vector(v) => {
                    if let Some(t) = &v.text {
                        writeln!(self.buf, "    /// {}", escape_doc(t)).unwrap();
                    } else {
                        writeln!(self.buf, "    /// Vector field; length from protocol.xml `length=\"{}\"`.",
                            escape_xml_attr_for_doc(&v.length_xml)).unwrap();
                    }
                    writeln!(self.buf, "    pub {}: Vec<{}>,", v.name_snake, v.element_rust_ty).unwrap();
                }
                EmitStep::Align(_) => {}
            }
        }
        writeln!(self.buf, "}}\n").unwrap();

        writeln!(self.buf, "impl {name} {{").unwrap();
        if let Some(op) = opcode {
            writeln!(self.buf, "    /// Wire opcode for this message (from protocol.xml `type=`).").unwrap();
            writeln!(self.buf, "    pub const OPCODE: u32 = 0x{op:04X};").unwrap();
            writeln!(self.buf).unwrap();
            self.opcode_index.push((kind_str.to_string(), raw_name.clone(), op));
        }
        // Emit derived subfield accessors (J3.A — `<subfield>` support).
        // Mirrors Chorizite's `get =>` accessor pattern: the parent field is
        // the wire source-of-truth; subfields are pure-derived from it.
        for f in &fields_only {
            for sf in &f.subfields {
                if let Some(t) = &sf.text {
                    writeln!(self.buf, "    /// Derived from `{}`. {}", f.name_snake, escape_doc(t)).unwrap();
                } else {
                    writeln!(self.buf, "    /// Derived from `{}` via protocol.xml `<subfield value=\"{}\">`.",
                        f.name_snake, escape_xml_attr_for_doc(&sf.value_expr)).unwrap();
                }
                writeln!(self.buf, "    #[inline]").unwrap();
                writeln!(self.buf, "    pub fn {sf_name}(&self) -> {sf_ty} {{ {sf_body} }}",
                    sf_name = sf.name_snake,
                    sf_ty = sf.rust_ty,
                    sf_body = sf.rust_expr,
                ).unwrap();
            }
        }
        writeln!(self.buf, "    /// Decode `{name}` from a little-endian wire stream at `*offset`.").unwrap();
        writeln!(self.buf, "    pub fn read_from(data: &[u8], offset: &mut usize) -> Result<Self, &'static str> {{").unwrap();
        if fields_only.is_empty()
            && vectors_only.is_empty()
            && !steps.iter().any(|s| matches!(s, EmitStep::Align(_)))
        {
            writeln!(self.buf, "        let _ = (data, offset);").unwrap();
        }
        for step in &steps {
            match step {
                EmitStep::Field(f) => emit_read_field(&mut self.buf, &f.name_snake, &f.field_kind),
                EmitStep::Align(n_bytes) => emit_align_pad(&mut self.buf, *n_bytes),
                EmitStep::Vector(v) => emit_read_vector(&mut self.buf, v),
            }
        }
        writeln!(self.buf, "        Ok(Self {{").unwrap();
        for step in &steps {
            match step {
                EmitStep::Field(f) => writeln!(self.buf, "            {},", f.name_snake).unwrap(),
                EmitStep::Vector(v) => writeln!(self.buf, "            {},", v.name_snake).unwrap(),
                EmitStep::Align(_) => {}
            }
        }
        writeln!(self.buf, "        }})\n    }}").unwrap();
        writeln!(self.buf, "}}\n").unwrap();

        if matches!(kind, EmitKind::Datatype) {
            self.type_kind.insert(name, TypeKind::Struct);
        }
        kind.bump_emitted(&mut self.stats);
    }

    /// J3.A: walks `<type>`'s children and produces an ordered sequence of
    /// "emit one field" / "emit one align-pad" steps. Each `<field>` may
    /// carry zero-or-more `<subfield>` derived-accessor children; nothing
    /// else nested under `<field>` is supported in the foundation tier.
    ///
    /// J3.B: `<vector length="...">` is also handled here. The length-source
    /// resolves via the [`SiblingLookup`] index built incrementally as we
    /// walk siblings — both top-level `<field>`s and their `<subfield>`
    /// derived accessors are in scope as length sources (BlobFragments uses
    /// `length="BodySize"` where `BodySize` is a subfield of `Size`).
    fn collect_emit_steps(&self, n: Node<'_, '_>, parent_type_name: &str) -> Result<Vec<EmitStep>, String> {
        let mut out = Vec::new();
        let mut seen_names: BTreeMap<String, usize> = BTreeMap::new();
        let mut siblings = SiblingLookup::default();
        for c in n.children().filter(|c| c.is_element()) {
            let tag = c.tag_name().name();
            match tag {
                "field" => {
                    let f = self.build_simple_field(c, &mut seen_names, parent_type_name)?;
                    siblings.add_field(&f);
                    out.push(EmitStep::Field(f));
                }
                "align" => {
                    let n_bytes = align_byte_width_from_node(c)
                        .ok_or_else(|| format!("<align> with type {:?}: unknown alignment width — only byte/short/ushort/int/uint/long/ulong supported", c.attribute("type")))?;
                    out.push(EmitStep::Align(n_bytes));
                }
                "vector" => {
                    let v = self.build_vector_field(c, &mut seen_names, parent_type_name, &siblings)?;
                    out.push(EmitStep::Vector(v));
                }
                other => {
                    return Err(format!("unsupported child `<{other}>`"));
                }
            }
        }
        Ok(out)
    }

    /// J3.B: build a [`VectorField`] from a `<vector>` element, resolving its
    /// length-source against the sibling-field index and its element type
    /// against [`Self::resolve_field`]. Fails fast (with a precise reason) if
    /// the element type isn't in the foundation tier, is the templated marker
    /// `T`, or the length-source can't be resolved — the caller bubbles those
    /// errors into a `// SKIPPED ...` note in the generated output.
    fn build_vector_field(
        &self,
        c: Node<'_, '_>,
        seen_names: &mut BTreeMap<String, usize>,
        parent_type_name: &str,
        siblings: &SiblingLookup,
    ) -> Result<VectorField, String> {
        let raw_name = c.attribute("name").ok_or_else(|| "<vector> missing name".to_string())?;
        let raw_type = c.attribute("type").ok_or_else(|| format!("<vector {raw_name}> missing type"))?;
        let raw_length = c.attribute("length")
            .ok_or_else(|| format!("<vector {raw_name}> missing length= attribute (only foundation shape supported)"))?;
        if let Some(skip_raw) = c.attribute("skip") {
            // skip="N" only appears inside `<switch>` cases (lines 8447/8451
            // for DDD_DataMessage compression branches). Since `<switch>`
            // already trips the unsupported-feature gate at the parent type,
            // we'll never actually reach here for a `skip=`-bearing vector at
            // the foundation tier; report a precise reason in case a future
            // schema revision moves a `skip=` vector to top level.
            return Err(format!("<vector {raw_name}>: skip={skip_raw:?} only supported inside <switch> cases — port to PR 7.2.D"));
        }

        // Element-type resolution. The templated marker `T` (used inside
        // `<type name="PackableList" templated="T">`) is not a real Rust type;
        // we route it through `// SKIPPED ... templated type T` so the
        // PackableList parent SKIP-note now points at the right J3.E feature
        // instead of the generic "vector" deferred-tier reason.
        if raw_type == "T" || raw_type == "U" {
            return Err(format!("<vector {raw_name}>: element type {raw_type:?} is a templated marker (parent uses templated=); deferred to J3.E"));
        }
        let (element_rust_ty, element_kind) = match self.resolve_field(raw_type) {
            Some(p) => p,
            None => return Err(format!("<vector {raw_name}>: element type {raw_type:?} not in foundation tier (likely SKIPPED by its own deferred feature)")),
        };

        // Length expression: a parsable C#-ish identifier optionally followed
        // by `+ literal` / `- literal`. Examples seen in protocol.xml:
        //   `Count`, `BodySize`, `PropertyCount`, `OptionPropertyCount`,
        //   `CommandListLength`, `PaletteCount`, `TextureCount`, `ModelCount`,
        //   `DataSize`, `RecordCount - 1`.
        // Dotted paths (`Header.Quantity`) are NOT present in the current
        // schema; we reject them with a clear reason so they'll fail-loud if
        // a future schema revision adds one.
        let length_expr_rust = translate_vector_length_expr(raw_length, siblings)
            .map_err(|e| format!("<vector {raw_name}>: cannot translate length={raw_length:?}: {e}"))?;

        // Sanitize the field name the same way build_simple_field does so
        // collisions with sibling fields surface as `_2`-suffixed Rust names.
        let mut snake = to_snake_case(raw_name);
        let counter = seen_names.entry(snake.clone()).or_insert(0);
        if *counter > 0 {
            snake = format!("{snake}_{}", *counter + 1);
        }
        *counter += 1;
        let snake = sanitize_rust_keyword(&snake);
        let _ = parent_type_name; // reserved for future error context.

        Ok(VectorField {
            name_snake: snake,
            element_rust_ty,
            element_kind,
            length_expr_rust,
            length_xml: raw_length.to_string(),
            text: c.attribute("text").map(|s| s.to_string()),
        })
    }

    fn build_simple_field(
        &self,
        c: Node<'_, '_>,
        seen_names: &mut BTreeMap<String, usize>,
        parent_type_name: &str,
    ) -> Result<SimpleField, String> {
        let raw_name = c.attribute("name").ok_or_else(|| "<field> missing name".to_string())?;
        let raw_type = c.attribute("type").ok_or_else(|| format!("<field {raw_name}> missing type"))?;

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

        // Walk nested children. Only `<subfield>` is accepted; anything else
        // (switch/if/maskmap inside a field body) trips the deferred-tier
        // path with a clear reason.
        let parent_rust_repr = match field_kind {
            FieldKind::PrimU8 => Some("u8"),
            FieldKind::PrimU16 => Some("u16"),
            FieldKind::PrimU32 => Some("u32"),
            FieldKind::PrimU64 => Some("u64"),
            FieldKind::PrimI16 => Some("i16"),
            FieldKind::PrimI32 => Some("i32"),
            FieldKind::PrimI64 => Some("i64"),
            _ => None,
        };
        let mut subfields = Vec::new();
        for sc in c.children().filter(|cc| cc.is_element()) {
            let stag = sc.tag_name().name();
            if stag != "subfield" {
                return Err(format!("field {raw_name}: nested element <{stag}> (only <subfield> supported); deferred"));
            }
            // <subfield> needs a numeric parent we can mask/shift. Enum/Struct
            // parents would need to be cast to their underlying repr — defer.
            let parent_repr = match parent_rust_repr {
                Some(r) => r,
                None => {
                    return Err(format!(
                        "field {raw_name}: <subfield> requires numeric parent, parent {raw_type:?} is non-numeric; deferred"
                    ));
                }
            };
            let sf_raw_name = sc.attribute("name").ok_or_else(|| format!("<subfield> in {parent_type_name}.{raw_name} missing name"))?;
            let sf_raw_type = sc.attribute("type").ok_or_else(|| format!("<subfield {sf_raw_name}> missing type"))?;
            let sf_value = sc.attribute("value").ok_or_else(|| format!("<subfield {sf_raw_name}> missing value expression"))?;

            let (sf_rust_ty, _) = match self.resolve_field(sf_raw_type) {
                Some(p) => p,
                None => return Err(format!("subfield {sf_raw_name}: type {sf_raw_type:?} not in foundation tier")),
            };
            // Subfield-result rust_ty must be a numeric primitive for the
            // bit-twiddle expression to type-check. We only accept the same
            // set the parent accepts.
            let sf_repr = match sf_rust_ty.as_str() {
                "u8" | "u16" | "u32" | "u64" | "i16" | "i32" | "i64" => sf_rust_ty.clone(),
                _ => return Err(format!("subfield {sf_raw_name}: result type {sf_rust_ty:?} is non-numeric; deferred")),
            };

            // Translate the C#-style value expression into Rust. The parent
            // identifier in the XML always names the immediate parent field;
            // rewrite it to `self.<snake>` so the generated accessor reads
            // from the struct's stored parent value.
            let rust_expr = match translate_subfield_expr(sf_value, raw_name, &snake, parent_repr, &sf_repr) {
                Ok(r) => r,
                Err(e) => {
                    return Err(format!("subfield {sf_raw_name}: cannot translate expression {sf_value:?}: {e}; deferred"));
                }
            };

            let sf_snake = sanitize_rust_keyword(&to_snake_case(sf_raw_name));
            subfields.push(SubfieldAccessor {
                name_snake: sf_snake,
                rust_ty: sf_repr,
                rust_expr,
                value_expr: sf_value.to_string(),
                text: sc.attribute("text").map(|s| s.to_string()),
            });
        }

        Ok(SimpleField {
            name_snake: snake,
            rust_ty,
            field_kind,
            text: c.attribute("text").map(|s| s.to_string()),
            subfields,
        })
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

/// J3.A: one ordered step the struct emitter walks during `read_from` codegen.
/// `<field>` produces a Field; `<align>` produces an Align(n_bytes) pad.
/// J3.B: `<vector length="...">` produces a Vector; the emitter writes a
/// `Vec<element>` field on the struct + a `for _ in 0..count { … }` decode
/// loop into `read_from`.
enum EmitStep {
    Field(SimpleField),
    Align(usize),
    Vector(VectorField),
}

/// J3.B: a `<vector name="Foo" type="ElementTy" length="LenExpr" />` child of
/// a `<type>` body. Element kind is resolved up front via [`CodegenCtx::resolve_field`];
/// the length expression is parsed into a usize-producing Rust expression that
/// reads one of the sibling-field local variables emitted earlier in the same
/// `read_from` body. The struct field's rust_ty is always `Vec<element_rust_ty>`.
struct VectorField {
    /// `Foo` lowercased to `foo` (then keyword-sanitized + uniquified).
    name_snake: String,
    /// `element_rust_ty` is the bare element type — `u8`, `Subpalette`, etc.
    /// The struct field's declared type is `Vec<element_rust_ty>`.
    element_rust_ty: String,
    /// How to decode one element via the J3.A field-kind machinery; the
    /// vector emitter routes through [`emit_read_field`] with a synthesized
    /// loop-local variable name to reuse that codegen path verbatim.
    element_kind: FieldKind,
    /// A Rust expression that produces the loop iteration count as `usize`.
    /// E.g. `count as usize`, `((record_count as i32) - 1) as usize`, or
    /// `((size as i32) - 16) as usize` (subfield-substituted).
    length_expr_rust: String,
    /// Verbatim XML `length="…"` attribute for the generated doc-comment.
    length_xml: String,
    text: Option<String>,
}

struct SimpleField {
    name_snake: String,
    rust_ty: String,
    field_kind: FieldKind,
    text: Option<String>,
    /// J3.A: derived `<subfield>` accessors hanging off this field. Empty for
    /// the vast majority of fields; populated only for the 10 subfield sites
    /// in protocol.xml (`PHashTable.PackedSize.{Buckets,Count}`,
    /// `BlobFragments.Size.BodySize`, `ItemProfile.PackedAmount.{Amount,PwdType}`,
    /// `PackedMotionCommand.PackedSequence.{ServerActionSequence,Autonomous}`,
    /// `RawMotionState.Flags.CommandListLength`,
    /// `InterpertedMotionState.Flags.CommandListLength`,
    /// `DDDRevision.IdDatFile.DatFileType`).
    subfields: Vec<SubfieldAccessor>,
}

/// J3.A: one `<subfield>` derived accessor on a parent field. Its `rust_expr`
/// is the already-translated Rust body — see [`translate_subfield_expr`].
struct SubfieldAccessor {
    name_snake: String,
    rust_ty: String,
    rust_expr: String,
    /// Verbatim XML expression for the doc-comment trail when no `text=`
    /// attribute is present.
    value_expr: String,
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
    // J3.A (2026-05-27): `<align>` + `<subfield>` are now FOUNDATION-tier
    // — `<align>` was always a child of `<type>` (or a child of `<switch>`
    // cases, which already trip the `switch` unsupported branch); `<subfield>`
    // is always a child of `<field>`, never a direct child of `<type>`, but
    // we KEEP it out of the unsupported list defensively in case future XML
    // ever places it at the top level. The real subfield-bearing fields are
    // detected by `collect_simple_fields` walking into `<field>` children.
    //
    // J3.B (2026-05-27): `<vector length="...">` is now FOUNDATION-tier when
    // all of the following hold: the length-source is a parsable sibling
    // identifier or `<subfield>` of one, optional arithmetic is `+`/`-` literal,
    // the element type resolves to an emitted struct/primitive (NOT the
    // templated marker `T`), and there's no `skip="N"` (skip only appears inside
    // `<switch>` cases which already trip the `switch` unsupported branch).
    // Per-vector resolution lives in `collect_emit_steps`; this top-level pass
    // never returns "vector" anymore — failures are reported with a precise
    // reason at the per-step level so the SKIPPED notes are more useful for
    // downstream J3.C-E planning.
    let mut out = Vec::new();
    for c in n.children().filter(|c| c.is_element()) {
        match c.tag_name().name() {
            "switch" => push_unique(&mut out, "switch"),
            "if" => push_unique(&mut out, "if"),
            "mask" => push_unique(&mut out, "mask"),
            "maskmap" => push_unique(&mut out, "maskmap"),
            "table" => push_unique(&mut out, "table"),
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

// J3.B: VECTOR HELPERS ------------------------------------------------------

/// Tracks every sibling field's `(xml_name, snake_name, rust_repr)` triple so
/// `<vector length="...">` length-source identifiers can resolve to the
/// matching local variable name emitted earlier in the same `read_from`
/// body. `<subfield>` derived accessors are ALSO entered into the lookup:
/// the vector's length-source can name a subfield (`length="BodySize"` where
/// `BodySize = Size - 16`), in which case the translator substitutes the
/// subfield's verbatim XML expression with the PARENT's snake name in place
/// of the parent's XML name — see [`translate_vector_length_expr`].
#[derive(Default)]
struct SiblingLookup {
    /// `xml_name → (snake_name, rust_repr)` for direct sibling fields. The
    /// `rust_repr` is the Rust primitive width (`u8`/`u16`/…); used so the
    /// length expression can cast cleanly to `usize` (Rust `as` requires the
    /// LHS to be a numeric primitive, not an enum/struct).
    fields_by_xml_name: BTreeMap<String, (String, String)>,
    /// `xml_name → (parent_xml_name, parent_snake_name, parent_rust_repr, value_expr)`
    /// for subfields hanging off any sibling. The subfield's value expression
    /// references the parent by its XML name; we rewrite to the parent's
    /// snake-name local variable when substituting into the vector length.
    subfields_by_xml_name: BTreeMap<String, SubfieldRef>,
}

#[derive(Clone)]
struct SubfieldRef {
    parent_xml_name: String,
    parent_snake_name: String,
    parent_rust_repr: String,
    /// Verbatim `<subfield value="…">` XML; the translator routes it through
    /// [`translate_subfield_expr`] for substitution into the vector length.
    value_expr_xml: String,
}

impl SiblingLookup {
    fn add_field(&mut self, f: &SimpleField) {
        let xml_name = xml_name_for_field(f);
        // Only track fields whose Rust-side type is a numeric primitive — the
        // length expression has to land in `usize` via `as`, which isn't
        // valid on String/struct/enum types.
        if let Some(repr) = numeric_repr_for_field_kind(&f.field_kind) {
            self.fields_by_xml_name.insert(xml_name.clone(), (f.name_snake.clone(), repr.to_string()));
            for sf in &f.subfields {
                // Subfield's XML name is what `<vector length="…">` would
                // reference; subfield's value expression references the
                // PARENT's XML name, and we want to substitute that to the
                // parent's snake name when emitting the length expression.
                let sf_xml = xml_name_for_subfield(sf);
                self.subfields_by_xml_name.insert(
                    sf_xml,
                    SubfieldRef {
                        parent_xml_name: xml_name.clone(),
                        parent_snake_name: f.name_snake.clone(),
                        parent_rust_repr: repr.to_string(),
                        value_expr_xml: sf.value_expr.clone(),
                    },
                );
            }
        }
    }
}

fn xml_name_for_field(f: &SimpleField) -> String {
    // We don't store the XML name on SimpleField; reconstruct from snake by
    // capitalising and removing underscores. This is approximate — but the
    // generated subfield code-paths already use the XML name verbatim, and
    // numeric fields in protocol.xml are conventionally PascalCase with no
    // ambiguous casing inside (the to_snake_case round-trip is reversible
    // for our concrete vector-length-source set: `Count`, `BodySize`,
    // `PropertyCount`, `OptionPropertyCount`, `RecordCount`, `CommandListLength`,
    // `PaletteCount`, `TextureCount`, `ModelCount`, `DataSize`). For names
    // we don't recognise we still produce a candidate and the lookup is
    // best-effort — the worst case is a clean SKIP with a clear reason.
    snake_to_pascal(&f.name_snake)
}

fn xml_name_for_subfield(sf: &SubfieldAccessor) -> String {
    snake_to_pascal(&sf.name_snake)
}

/// Convert `snake_case_id` → `SnakeCaseId`. Mirrors `to_snake_case`'s inverse
/// for the subset of names we care about (single-word + underscore-joined
/// PascalCase round-trips cleanly). Words after the first are capitalised.
fn snake_to_pascal(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut cap_next = true;
    for ch in s.chars() {
        if ch == '_' {
            cap_next = true;
        } else if cap_next {
            out.extend(ch.to_uppercase());
            cap_next = false;
        } else {
            out.push(ch);
        }
    }
    out
}

fn numeric_repr_for_field_kind(k: &FieldKind) -> Option<&'static str> {
    match k {
        FieldKind::PrimU8 => Some("u8"),
        FieldKind::PrimU16 => Some("u16"),
        FieldKind::PrimU32 => Some("u32"),
        FieldKind::PrimU64 => Some("u64"),
        FieldKind::PrimI16 => Some("i16"),
        FieldKind::PrimI32 => Some("i32"),
        FieldKind::PrimI64 => Some("i64"),
        FieldKind::PackedDword => Some("u32"),
        _ => None,
    }
}

/// J3.B: translate a `<vector length="XmlExpr">` attribute into a Rust
/// expression that produces the loop count as `usize`. Supports:
///
/// - bare identifier matching a sibling field (`Count` → `count as usize`)
/// - bare identifier matching a sibling's subfield (`BodySize` →
///   `((size as i32) - 16) as usize` after substituting `Size` → `size`)
/// - identifier + literal arithmetic (`RecordCount - 1` →
///   `((record_count as i32) - 1) as usize`)
///
/// Rejects dotted paths (`Header.Quantity`) with a clear reason — none appear
/// in the current schema but a future revision could add one and we'd rather
/// fail-loud than silently mis-emit.
///
/// The intermediate cast through `i32` is so the `RecordCount - 1` shape
/// can't underflow a `u16` when RecordCount=0 (rare, but possible per the
/// `<if test="RecordCount > 0">` guard above the vector in AllegianceHierarchy).
/// The final cast to `usize` is unconditional and saturates negative values
/// to a large positive that will trip the truncation check inside the loop.
fn translate_vector_length_expr(expr: &str, siblings: &SiblingLookup) -> Result<String, String> {
    let trimmed = expr.trim();
    if trimmed.contains('.') {
        return Err(format!("dotted-path length-source {trimmed:?} not supported (no sites in current protocol.xml; add when one appears)"));
    }
    // Tokenize with the same lexer the subfield translator uses — it already
    // handles `Ident`, `IntLit`, `BinOp('+'|'-')`, etc.
    let tokens = tokenize_csharp_expr(trimmed)
        .map_err(|e| format!("tokenize failed: {e}"))?;
    if tokens.is_empty() {
        return Err("empty length expression".to_string());
    }

    // First token must be an identifier — the length-source. The schema
    // census shows ALL length sources are bare or `<ident> +/- <literal>`.
    let (head_ident, rest) = match &tokens[..] {
        [ExprTok::Ident(id), rest @ ..] => (id.clone(), rest),
        _ => return Err(format!("expected identifier, got {:?}", tokens.first())),
    };

    let (rust_head_expr, head_repr) = resolve_length_source(&head_ident, siblings)?;

    // No arithmetic tail — return the head cast to usize.
    if rest.is_empty() {
        return Ok(format!("({rust_head_expr}) as usize"));
    }

    // Arithmetic tail. Per the schema census, ALWAYS exactly two tokens:
    // `BinOp('+'|'-')` then `IntLit`. Reject anything else.
    if rest.len() != 2 {
        return Err(format!("only single-literal arithmetic supported, got {} trailing tokens: {rest:?}", rest.len()));
    }
    let op = match &rest[0] {
        ExprTok::BinOp(c) if *c == '+' || *c == '-' => *c,
        other => return Err(format!("expected `+` or `-`, got {other:?}")),
    };
    let lit = match &rest[1] {
        ExprTok::IntLit { raw } => raw.clone(),
        other => return Err(format!("expected integer literal, got {other:?}")),
    };

    // Cast head to i32 first so subtraction can't underflow an unsigned
    // type when the literal exceeds the head value at runtime (the
    // `RecordCount = 0` case in AllegianceHierarchy is the canonical
    // example).
    let _ = head_repr; // Reserved for future precision-aware widening; i32 is enough today.
    Ok(format!("(({rust_head_expr} as i32) {op} {lit}) as usize"))
}

fn resolve_length_source(
    head_ident: &str,
    siblings: &SiblingLookup,
) -> Result<(String, String), String> {
    // Direct sibling field.
    if let Some((snake, repr)) = siblings.fields_by_xml_name.get(head_ident) {
        return Ok((snake.clone(), repr.clone()));
    }
    // Sibling's subfield. The subfield's value-expression is a function of
    // the PARENT's XML name; substitute parent_xml → parent_snake then
    // route through the existing subfield-expression translator so the
    // emitted Rust reads the parent's local variable directly. We don't
    // create a `self.` access here because we're inside read_from, where
    // `self` doesn't exist yet — only local variables for fields already
    // decoded.
    if let Some(sf_ref) = siblings.subfields_by_xml_name.get(head_ident) {
        let local_expr = translate_subfield_expr_for_local(
            &sf_ref.value_expr_xml,
            &sf_ref.parent_xml_name,
            &sf_ref.parent_snake_name,
            &sf_ref.parent_rust_repr,
            &sf_ref.parent_rust_repr,
        )
        .map_err(|e| format!("subfield {head_ident}: cannot translate {:?}: {e}", sf_ref.value_expr_xml))?;
        return Ok((local_expr, sf_ref.parent_rust_repr.clone()));
    }
    Err(format!("identifier {head_ident:?} is not a sibling field nor a sibling's subfield"))
}

/// Variant of [`translate_subfield_expr`] that emits a Rust expression
/// referencing the parent's LOCAL variable in `read_from` (`<snake>`) instead
/// of the `&self`-based accessor (`self.<snake>`). Reuses the same expression
/// parser; only the atom-emitter differs.
fn translate_subfield_expr_for_local(
    expr: &str,
    parent_xml_name: &str,
    parent_snake: &str,
    parent_repr: &str,
    sf_repr: &str,
) -> Result<String, String> {
    let tokens = tokenize_csharp_expr(expr)?;
    let mut p = ExprParser { toks: &tokens, pos: 0 };
    let rust_inner = p.parse_expr_with_local_atom(parent_xml_name, parent_snake, parent_repr)?;
    if p.pos != tokens.len() {
        return Err(format!("trailing tokens after position {}: {:?}", p.pos, &tokens[p.pos..]));
    }
    Ok(format!("({rust_inner}) as {sf_repr}"))
}

// J3.A: ALIGN + SUBFIELD HELPERS --------------------------------------------

/// J3.B: emit the read-loop for a `<vector length="…" type="…" />` child.
/// Equivalent to the C# template's
/// `for (int i = 0; i < count; i++) items.Add(T.Read(reader));` — we
/// pre-compute the count from the length expression (which references one of
/// the sibling-field local variables emitted earlier in the same body) and
/// then iterate, routing single-element decode through the same machinery
/// `emit_read_field` uses for scalar fields.
fn emit_read_vector(buf: &mut String, v: &VectorField) {
    let snake = &v.name_snake;
    let count_expr = &v.length_expr_rust;
    let elem_ty = &v.element_rust_ty;
    let xml_len = &v.length_xml;
    writeln!(buf, "        // <vector name=\"{snake}\" length=\"{}\" type=\"{elem_ty}\">",
        escape_xml_attr_for_doc(xml_len)).unwrap();
    writeln!(buf, "        let {snake}_count: usize = {count_expr};").unwrap();
    writeln!(buf, "        let mut {snake}: Vec<{elem_ty}> = Vec::with_capacity({snake}_count.min(1024));").unwrap();
    writeln!(buf, "        for _ in 0..{snake}_count {{").unwrap();
    // Re-route through emit_read_field with a synthesized local variable
    // name `__elem`, then push it into the vec. We open a block so each
    // iteration's `__elem` shadow is independent.
    writeln!(buf, "            let __elem: {elem_ty} = {{").unwrap();
    // emit_read_field writes `let <snake>: <ty> = …; *offset += N;` — we
    // wrap it in a block and rename the local to `__elem` via a different
    // codepath: inline the same byte-extraction logic. To avoid duplicating
    // the table, we call emit_read_field with `__elem` as the snake name
    // and then reference it after.
    emit_read_field_indented(buf, "__elem", &v.element_kind, "                ");
    writeln!(buf, "                __elem").unwrap();
    writeln!(buf, "            }};").unwrap();
    writeln!(buf, "            {snake}.push(__elem);").unwrap();
    writeln!(buf, "        }}").unwrap();
}

/// Indented variant of [`emit_read_field`] for use inside the vector
/// read-loop body. Lifts the same field-kind dispatch but with caller-chosen
/// indentation so the generated source stays readable. Routes through the
/// same per-kind primitives so a future bugfix in scalar decode lands here
/// for free.
fn emit_read_field_indented(buf: &mut String, snake: &str, kind: &FieldKind, indent: &str) {
    let mut tmp = String::new();
    emit_read_field(&mut tmp, snake, kind);
    for line in tmp.lines() {
        // Strip the existing 8-space indent (`emit_read_field`'s convention)
        // and replace with the requested one.
        let stripped = line.trim_start_matches(' ');
        if stripped.is_empty() {
            writeln!(buf).unwrap();
        } else {
            writeln!(buf, "{indent}{stripped}").unwrap();
        }
    }
}

/// J3.A: emit the cursor-advance for a Chorizite `<align type="TYPE" />`
/// directive. Equivalent to the C# template's
/// `if ((reader.BaseStream.Position % N) != 0)
///   reader.BaseStream.Position += N - (reader.BaseStream.Position % N);`
/// — we use `*offset` (an absolute byte index into `data`) in place of the
/// stream position, which is semantically identical. The pad bytes are
/// skipped without inspection (the wire writer fills them with zeros).
fn emit_align_pad(buf: &mut String, n_bytes: usize) {
    let n = n_bytes;
    writeln!(buf, "        // <align type=\"{n}\"> — advance cursor to next multiple of {n}.").unwrap();
    writeln!(buf, "        {{").unwrap();
    writeln!(buf, "            let pad = ({n} - (*offset % {n})) % {n};").unwrap();
    writeln!(buf, "            if *offset + pad > data.len() {{ return Err(\"truncated align({n}) pad\"); }}").unwrap();
    writeln!(buf, "            *offset += pad;").unwrap();
    writeln!(buf, "        }}").unwrap();
}

/// J3.A: map `<align type="TYPE" />` to the alignment-pad byte width. Mirrors
/// `Chorizite.ACProtocol.SourceGen.CSTemplateBase.WriteAlignmentCheck` which
/// hardcodes `4` because every retail `<align>` site uses `type="uint"`; we
/// generalize over the wire-primitive width table on the off-chance the XML
/// ever ships a `<align type="ushort" />`.
fn align_byte_width_from_node(n: Node<'_, '_>) -> Option<usize> {
    let ty = n.attribute("type")?;
    match ty {
        "byte" | "bool" => Some(1),
        "short" | "ushort" => Some(2),
        "int" | "uint" | "float" => Some(4),
        "long" | "ulong" | "double" => Some(8),
        _ => None,
    }
}

/// J3.A: translate the C#-style expression in `<subfield value="…">` into
/// a Rust expression body that reads from `&self` against the parent's
/// stored field. Mirrors what `Chorizite.ACProtocol`'s T4 template emits as a
/// `get =>` accessor — same expression, different surface syntax + an
/// explicit cast to the subfield's declared return type.
///
/// The XML uses C# casts (`(uint)1 << ((int)PackedSize >> 24)`) and the
/// parent's field name as a bare identifier (`PackedSize & 0xFFFFFF`); the
/// translator rewrites the identifier to `self.<snake>` and converts casts to
/// the corresponding Rust `as` expression, threading the parent's repr type
/// through so the implicit cast on each leaf identifier matches the source's
/// implicit-cast behaviour.
///
/// Supported expression shape (covers all 10 retail sites):
///   `expr  := term  (`+`|`-`|`*`|`/`|`&`|`|`|`^`|`<<`|`>>` expr)?`
///   `term  := unary | `(` type `)` term | `(` expr `)` | ident | int_literal`
///   `unary := `-` term`
///
/// Returns `Err(msg)` if it hits a token we don't recognise — the caller
/// then SKIPs the bearing type with the original deferred-tier reason.
fn translate_subfield_expr(
    expr: &str,
    parent_xml_name: &str,
    parent_snake: &str,
    parent_repr: &str,
    sf_repr: &str,
) -> Result<String, String> {
    let tokens = tokenize_csharp_expr(expr)?;
    let mut p = ExprParser { toks: &tokens, pos: 0 };
    let rust_inner = p.parse_expr(parent_xml_name, parent_snake, parent_repr)?;
    if p.pos != tokens.len() {
        return Err(format!(
            "trailing tokens after position {}: {:?}",
            p.pos,
            &tokens[p.pos..]
        ));
    }
    // Cast the parent-repr-typed inner expression to the subfield's declared
    // return type. This mirrors the C# `(ushort)(...)` wrap on the `get =>`
    // accessor body and keeps the return-type column honest.
    Ok(format!("({rust_inner}) as {sf_repr}"))
}

#[derive(Debug, Clone, PartialEq)]
enum ExprTok {
    Ident(String),
    /// Numeric literal preserved as raw text + value so we can format it back
    /// without dropping the hex form.
    IntLit { raw: String },
    /// `(byte)` / `(ushort)` / `(int)` etc. — a cast prefix.
    Cast(String),
    LParen,
    RParen,
    /// `&`, `|`, `^`, `+`, `-`, `*`, `/`
    BinOp(char),
    /// `<<` or `>>`
    Shift(bool), // true = left, false = right
}

fn tokenize_csharp_expr(s: &str) -> Result<Vec<ExprTok>, String> {
    let bytes = s.as_bytes();
    let mut i = 0;
    let mut out = Vec::new();
    let is_ident_start = |b: u8| b.is_ascii_alphabetic() || b == b'_';
    let is_ident_cont = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let cast_types = [
        "byte", "short", "ushort", "int", "uint", "long", "ulong",
        "float", "double", "bool",
    ];
    while i < bytes.len() {
        let b = bytes[i];
        if b.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        match b {
            b'(' => {
                // Lookahead for cast: `(` type `)`.
                let rest = &s[i + 1..];
                let mut matched_cast: Option<&str> = None;
                for ct in cast_types.iter() {
                    if rest.starts_with(ct) {
                        let after = &rest[ct.len()..];
                        if after.as_bytes().first().copied() == Some(b')') {
                            matched_cast = Some(*ct);
                            break;
                        }
                    }
                }
                if let Some(ct) = matched_cast {
                    out.push(ExprTok::Cast(ct.to_string()));
                    i += 1 + ct.len() + 1; // `(` + type + `)`
                } else {
                    out.push(ExprTok::LParen);
                    i += 1;
                }
            }
            b')' => {
                out.push(ExprTok::RParen);
                i += 1;
            }
            b'<' if bytes.get(i + 1) == Some(&b'<') => {
                out.push(ExprTok::Shift(true));
                i += 2;
            }
            b'>' if bytes.get(i + 1) == Some(&b'>') => {
                out.push(ExprTok::Shift(false));
                i += 2;
            }
            b'&' | b'|' | b'^' | b'+' | b'-' | b'*' | b'/' => {
                out.push(ExprTok::BinOp(b as char));
                i += 1;
            }
            _ if b.is_ascii_digit() => {
                let start = i;
                // Optional 0x / 0X hex prefix.
                if b == b'0' && (bytes.get(i + 1) == Some(&b'x') || bytes.get(i + 1) == Some(&b'X')) {
                    i += 2;
                    while i < bytes.len() && bytes[i].is_ascii_hexdigit() {
                        i += 1;
                    }
                } else {
                    while i < bytes.len() && bytes[i].is_ascii_digit() {
                        i += 1;
                    }
                }
                let raw = s[start..i].to_string();
                out.push(ExprTok::IntLit { raw });
            }
            _ if is_ident_start(b) => {
                let start = i;
                while i < bytes.len() && is_ident_cont(bytes[i]) {
                    i += 1;
                }
                out.push(ExprTok::Ident(s[start..i].to_string()));
            }
            _ => {
                return Err(format!("unexpected character {:?} at offset {i} of {s:?}", b as char));
            }
        }
    }
    Ok(out)
}

struct ExprParser<'a> {
    toks: &'a [ExprTok],
    pos: usize,
}

impl<'a> ExprParser<'a> {
    /// Precedence (low→high) — we follow C#: `|` < `^` < `&` < shift < `+`/`-`
    /// < `*`/`/`. Top-level `parse_expr` handles `|`.
    fn parse_expr(
        &mut self,
        parent_xml_name: &str,
        parent_snake: &str,
        parent_repr: &str,
    ) -> Result<String, String> {
        self.parse_or(parent_xml_name, parent_snake, parent_repr)
    }
    fn parse_or(&mut self, p: &str, ps: &str, pr: &str) -> Result<String, String> {
        let mut lhs = self.parse_xor(p, ps, pr)?;
        while matches!(self.peek(), Some(ExprTok::BinOp('|'))) {
            self.pos += 1;
            let rhs = self.parse_xor(p, ps, pr)?;
            lhs = format!("({lhs} | {rhs})");
        }
        Ok(lhs)
    }
    fn parse_xor(&mut self, p: &str, ps: &str, pr: &str) -> Result<String, String> {
        let mut lhs = self.parse_and(p, ps, pr)?;
        while matches!(self.peek(), Some(ExprTok::BinOp('^'))) {
            self.pos += 1;
            let rhs = self.parse_and(p, ps, pr)?;
            lhs = format!("({lhs} ^ {rhs})");
        }
        Ok(lhs)
    }
    fn parse_and(&mut self, p: &str, ps: &str, pr: &str) -> Result<String, String> {
        let mut lhs = self.parse_shift(p, ps, pr)?;
        while matches!(self.peek(), Some(ExprTok::BinOp('&'))) {
            self.pos += 1;
            let rhs = self.parse_shift(p, ps, pr)?;
            lhs = format!("({lhs} & {rhs})");
        }
        Ok(lhs)
    }
    fn parse_shift(&mut self, p: &str, ps: &str, pr: &str) -> Result<String, String> {
        let mut lhs = self.parse_addsub(p, ps, pr)?;
        while let Some(tok) = self.peek() {
            match tok {
                ExprTok::Shift(true) => {
                    self.pos += 1;
                    let rhs = self.parse_addsub(p, ps, pr)?;
                    lhs = format!("({lhs} << {rhs})");
                }
                ExprTok::Shift(false) => {
                    self.pos += 1;
                    let rhs = self.parse_addsub(p, ps, pr)?;
                    lhs = format!("({lhs} >> {rhs})");
                }
                _ => break,
            }
        }
        Ok(lhs)
    }
    fn parse_addsub(&mut self, p: &str, ps: &str, pr: &str) -> Result<String, String> {
        let mut lhs = self.parse_muldiv(p, ps, pr)?;
        while let Some(ExprTok::BinOp(op)) = self.peek() {
            if *op == '+' || *op == '-' {
                let op = *op;
                self.pos += 1;
                let rhs = self.parse_muldiv(p, ps, pr)?;
                lhs = format!("({lhs} {op} {rhs})");
            } else {
                break;
            }
        }
        Ok(lhs)
    }
    fn parse_muldiv(&mut self, p: &str, ps: &str, pr: &str) -> Result<String, String> {
        let mut lhs = self.parse_cast_or_unary(p, ps, pr)?;
        while let Some(ExprTok::BinOp(op)) = self.peek() {
            if *op == '*' || *op == '/' {
                let op = *op;
                self.pos += 1;
                let rhs = self.parse_cast_or_unary(p, ps, pr)?;
                lhs = format!("({lhs} {op} {rhs})");
            } else {
                break;
            }
        }
        Ok(lhs)
    }
    fn parse_cast_or_unary(
        &mut self,
        p: &str,
        ps: &str,
        pr: &str,
    ) -> Result<String, String> {
        // Cast prefix: (type) <term>
        if let Some(ExprTok::Cast(ty)) = self.peek() {
            let ty = ty.clone();
            self.pos += 1;
            let inner = self.parse_cast_or_unary(p, ps, pr)?;
            let rust_ty = csharp_to_rust_primitive(&ty)?;
            return Ok(format!("({inner} as {rust_ty})"));
        }
        // Unary minus.
        if matches!(self.peek(), Some(ExprTok::BinOp('-'))) {
            self.pos += 1;
            let inner = self.parse_cast_or_unary(p, ps, pr)?;
            return Ok(format!("(-({inner}))"));
        }
        self.parse_atom(p, ps, pr)
    }
    fn parse_atom(
        &mut self,
        parent_xml_name: &str,
        parent_snake: &str,
        parent_repr: &str,
    ) -> Result<String, String> {
        match self.peek().cloned() {
            Some(ExprTok::LParen) => {
                self.pos += 1;
                let inner = self.parse_expr(parent_xml_name, parent_snake, parent_repr)?;
                match self.peek() {
                    Some(ExprTok::RParen) => self.pos += 1,
                    other => return Err(format!("expected ')', got {other:?}")),
                }
                Ok(format!("({inner})"))
            }
            Some(ExprTok::Ident(ident)) => {
                self.pos += 1;
                if ident == parent_xml_name {
                    // Read the stored parent field; rust_ty is already the
                    // parent_repr type so no cast needed at the leaf.
                    Ok(format!("self.{parent_snake}"))
                } else {
                    Err(format!(
                        "identifier {ident:?} is not the parent field name ({parent_xml_name:?}); cross-field subfield expressions are deferred"
                    ))
                }
            }
            Some(ExprTok::IntLit { raw }) => {
                self.pos += 1;
                // Integer literal — typed as the parent's repr so it composes
                // cleanly with `self.<snake>` (parent_repr) under `&`, `|`,
                // `<<`, `>>`.
                Ok(format!("({raw} as {parent_repr})"))
            }
            Some(other) => Err(format!("expected atom, got {other:?}")),
            None => Err("expected atom, got end-of-input".to_string()),
        }
    }
    fn peek(&self) -> Option<&ExprTok> {
        self.toks.get(self.pos)
    }

    /// J3.B: variant of `parse_expr` that emits a bare `<snake>` identifier
    /// for the parent-field reference instead of `self.<snake>`. Used by
    /// [`translate_subfield_expr_for_local`] when substituting a subfield's
    /// value expression into a `<vector length="…">` reference — at the
    /// point the vector decodes, `self` doesn't exist yet (we're inside
    /// `read_from`); only local variables for previously-decoded fields are
    /// in scope.
    fn parse_expr_with_local_atom(
        &mut self,
        parent_xml_name: &str,
        parent_snake: &str,
        parent_repr: &str,
    ) -> Result<String, String> {
        // Same precedence cascade as parse_or but each level calls into
        // parse_*_local helpers. Rather than duplicate every binding, we
        // route through the existing parse_or but FLIP the atom emitter via
        // a thread-local mode flag — simpler is to clone the cascade with a
        // `bare_atom: bool` parameter, but we don't want to touch all 6
        // levels. Instead, we manually evaluate the same precedence by
        // calling parse_or with a sentinel parent_xml_name handler.
        //
        // The minimal-touch path: call `parse_or` directly, but pre-rewrite
        // the parent's xml-name token into a synthetic identifier the atom
        // handler treats as the local alias. We achieve this by recognising
        // the sentinel-prefix `__LOCAL__` in the atom emitter (parse_atom)
        // and substituting it with the snake name. Cleaner is to add a
        // mode flag; since this is the only call path that wants the local
        // variant, we copy parse_atom's logic inline here and lean on the
        // existing parse_or for the precedence cascade by calling it with
        // the unchanged parent_xml_name, then string-replacing
        // `self.<snake>` → `<snake>` post-hoc. That's clearly hacky but
        // keeps the parser untouched. Use that approach so the regression
        // surface stays minimal.
        let rust_with_self = self.parse_or(parent_xml_name, parent_snake, parent_repr)?;
        let bare = rust_with_self.replace(&format!("self.{parent_snake}"), parent_snake);
        Ok(bare)
    }
}

fn csharp_to_rust_primitive(ty: &str) -> Result<&'static str, String> {
    match ty {
        "byte" => Ok("u8"),
        "short" => Ok("i16"),
        "ushort" => Ok("u16"),
        "int" => Ok("i32"),
        "uint" => Ok("u32"),
        "long" => Ok("i64"),
        "ulong" => Ok("u64"),
        "float" => Ok("f32"),
        "double" => Ok("f64"),
        "bool" => Ok("bool"),
        other => Err(format!("unknown C# primitive {other:?}")),
    }
}

/// Escapes XML-attribute text for placement inside a Rust doc-comment
/// (`<` and `>` need backtick-escaping or they'd be parsed as HTML by rustdoc).
fn escape_xml_attr_for_doc(s: &str) -> String {
    s.replace('<', "&lt;").replace('>', "&gt;")
}

// J3.A: SUBFIELD EXPRESSION-TRANSLATOR UNIT TESTS ---------------------------
//
// build.rs `cfg(test)` modules don't run under `cargo test` (Cargo's test
// harness only compiles `src/**` + `tests/**`); we run these only when
// build.rs is explicitly compiled with `--test`. The real verification
// surface for these helpers is the parity-test round-trip
// (tests/generated_parity.rs).

#[cfg(test)]
mod expr_translator_tests {
    use super::*;

    fn xlate(expr: &str, parent_xml: &str, parent_snake: &str, parent_repr: &str, sf_repr: &str) -> String {
        translate_subfield_expr(expr, parent_xml, parent_snake, parent_repr, sf_repr).unwrap()
    }

    #[test]
    fn simple_mask() {
        let s = xlate("PackedSequence & 0x7FFF", "PackedSequence", "packed_sequence", "u16", "u16");
        assert!(s.contains("self.packed_sequence"));
        assert!(s.contains("0x7FFF"));
        assert!(s.ends_with(" as u16"));
    }

    #[test]
    fn right_shift() {
        let s = xlate("PackedAmount >> 24", "PackedAmount", "packed_amount", "u32", "i32");
        assert!(s.contains("self.packed_amount"));
        assert!(s.contains(">> "));
        assert!(s.ends_with(" as i32"));
    }

    #[test]
    fn shift_then_mask() {
        let s = xlate("(PackedSequence >> 15) & 0x1", "PackedSequence", "packed_sequence", "u16", "u16");
        assert!(s.contains("self.packed_sequence"));
        assert!(s.contains(">> ") && s.contains("& "));
    }

    #[test]
    fn cast_inside_shift() {
        // `(uint)1 << ((int)PackedSize >> 24)` — PHashTable.Buckets.
        let s = xlate("(uint)1 << ((int)PackedSize >> 24)", "PackedSize", "packed_size", "u32", "u32");
        assert!(s.contains("self.packed_size"));
        assert!(s.contains("as i32"));
        assert!(s.contains("as u32"));
    }

    #[test]
    fn subtract_literal() {
        // BlobFragments.BodySize = Size - 16.
        let s = xlate("Size - 16", "Size", "size", "u16", "u16");
        assert!(s.contains("self.size"));
        assert!(s.contains("- "));
    }

    #[test]
    fn long_high_word() {
        // DDDRevision.DatFileType = IdDatFile >> 32. The parent is `ulong`
        // (u64); the subfield is `uint` (u32). The translator emits the
        // shift on u64 then casts to u32.
        let s = xlate("IdDatFile >> 32", "IdDatFile", "id_dat_file", "u64", "u32");
        assert!(s.contains("self.id_dat_file"));
        assert!(s.contains(">> "));
        assert!(s.ends_with(" as u32"));
    }

    #[test]
    fn rejects_cross_field() {
        let err = translate_subfield_expr("PackedSequence & OtherField", "PackedSequence", "packed_sequence", "u16", "u16").unwrap_err();
        assert!(err.contains("not the parent field name") || err.contains("cross-field"));
    }
}

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
    /// J3.C: variant_name → numeric value for every emitted enum. Lets the
    /// maskmap codegen translate `EnumName.VariantName` mask-value references
    /// to a raw u64 literal at codegen time. Built incrementally as enums
    /// are emitted; populated even for enums that drop variants to aliases
    /// (the alias's underlying constant is preserved).
    enum_variant_values: HashMap<String, BTreeMap<String, i128>>,
    opcode_index: Vec<(String, String, u32)>,
    stats: Stats,
}

#[derive(Clone, Debug)]
enum TypeKind {
    Primitive(&'static str),
    Struct,
    /// `Enum(repr, is_flag)`. `is_flag=true` for enums declared with
    /// `mask="true"` (the wire value can be any OR of declared bits). The
    /// read codegen for flag enums never errors on unknown discriminants —
    /// instead it materialises the matched-variant value if known, or a
    /// stand-in zero-bits sentinel value (the raw bits are preserved in
    /// the `_bits` companion local for the maskmap-parent path).
    Enum(EnumRepr, bool),
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
            enum_variant_values: HashMap::new(),
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
        // J3.C: flag enums (`mask="true"`) treat unknown wire discriminants
        // as valid (any OR of declared bits is legal). Recorded in the type
        // kind so `resolve_field` can downgrade flag-enum field references
        // to their underlying numeric repr (`u32` for `parent="uint"`), at
        // which point unknown bit compositions are statically representable.
        let is_flag_enum = n.attribute("mask") == Some("true");

        // Dedup by discriminant.
        let mut seen_disc = BTreeSet::new();
        let mut variants: Vec<(String, i128, Option<String>)> = Vec::new();
        let mut aliases: Vec<(String, i128, String, Option<String>)> = Vec::new();
        // J3.C: enum-variant value table for downstream maskmap value-ref
        // resolution. We index by the ORIGINAL XML variant name (NOT the
        // sanitised Rust ident) because `<maskmap>` references use the XML
        // form (e.g. `ACBaseQualitiesFlags.PropertyInt`). Aliases that map to
        // the same discriminant get the same value entry — preserves the
        // semantics of Chorizite's "this name is also that bit".
        let mut variant_value_table: BTreeMap<String, i128> = BTreeMap::new();
        for v in n.children().filter(|c| c.is_element() && c.tag_name().name() == "value") {
            let vname = match v.attribute("name") { Some(v) => v.to_string(), None => continue };
            let vraw = match v.attribute("value") { Some(v) => v, None => continue };
            let parsed = match parse_int_literal(vraw) {
                Some(p) => p,
                None => continue,
            };
            let text = v.attribute("text").map(|s| s.to_string());
            variant_value_table.insert(vname.clone(), parsed);
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

        self.type_kind.insert(name.clone(), TypeKind::Enum(repr, is_flag_enum));
        self.enum_variant_values.insert(name, variant_value_table);
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
        // J3.D: handle forward references via fixpoint iteration. The
        // schema declares types in arbitrary order — `Emote` (line 5732)
        // references `CreationProfile` (line 5851), and the original
        // single-pass walk would SKIP `Emote` because `CreationProfile`
        // hadn't been registered yet. We loop the emit pass until no new
        // type becomes resolvable. Two passes are sufficient for the
        // current schema (no cycles); we cap at 5 iterations defensively
        // so a hypothetical mutual-recursion schema bug surfaces as a
        // clear panic rather than an infinite loop.
        //
        // J3.E: templated `<type ... templated="T">` (or `templated="T,U">`)
        // declarations are NEVER emitted as concrete Rust types — they're
        // inlined at every use-site (see `build_packable_field`). They get a
        // precise SKIP note explaining why; downstream consumers grep for
        // "inlined at use-site" instead of the old generic-templated-marker
        // reason. The PackableList/PackableHashTable/PHashTable namespace is
        // closed (3 types, 96 use-sites total); the inliner panics if a
        // template appears it doesn't recognise.
        let candidates: Vec<Node<'_, '_>> = types_node
            .children()
            .filter(|n| n.is_element() && n.tag_name().name() == "type")
            .filter(|n| n.attribute("primitive").is_none())
            .filter(|n| n.attribute("templated").is_none())
            .filter(|n| n.children().any(|c| c.is_element()))
            .collect();
        // Emit a clean SKIP per templated type so the downstream tests can
        // grep the new reason.
        for n in types_node.children().filter(|n| n.is_element() && n.tag_name().name() == "type") {
            if n.attribute("templated").is_some() {
                if let Some(raw_name) = n.attribute("name") {
                    let templated_params = n.attribute("templated").unwrap_or("");
                    writeln!(
                        self.buf,
                        "// SKIPPED datatype {raw_name}: templated=\"{templated_params}\" (J3.E inlines at every use-site via `<field type=\"{raw_name}\" generic*=...>`; no concrete Rust struct emitted)."
                    ).unwrap();
                    self.stats.datatypes_skipped += 1;
                }
            }
        }
        let mut emitted: BTreeSet<String> = BTreeSet::new();
        for pass in 0..5 {
            let pass_start_buf_len = self.buf.len();
            let pass_start_emitted = emitted.len();
            // We emit into a scratch buffer per pass so a failed emit doesn't
            // pollute the output with half-written struct bodies. Successful
            // emits get flushed; failed ones (SKIP-only) are deferred to the
            // next pass.
            let mut pass_buf = String::new();
            let mut newly_emitted: Vec<String> = Vec::new();
            for n in &candidates {
                let raw_name = match n.attribute("name") { Some(v) => v.to_string(), None => continue };
                if emitted.contains(&raw_name) {
                    // Already emitted in an earlier pass — skip.
                    continue;
                }
                // Try a probe-only collect_emit_steps: if it succeeds, we
                // know the emit will succeed. Otherwise we'll retry on
                // the next pass with the larger type_kind table.
                if let Err(_reason) = self.collect_emit_steps(*n, &raw_name) {
                    // Still unresolvable. Either this is a final SKIP we'll
                    // surface in the final pass, or a transient dependency
                    // gap that fills in a later pass.
                    continue;
                }
                let prev_buf = std::mem::take(&mut self.buf);
                self.emit_message(*n, EmitKind::Datatype);
                pass_buf.push_str(&self.buf);
                self.buf = prev_buf;
                emitted.insert(raw_name.clone());
                newly_emitted.push(raw_name);
            }
            self.buf.push_str(&pass_buf);
            let _ = pass_start_buf_len;
            let _ = pass_start_emitted;
            if newly_emitted.is_empty() {
                // Fixpoint reached — anything still unemitted SKIPs in the
                // final pass below with a precise reason.
                let _ = pass;
                break;
            }
        }
        // Final pass: re-emit (or first-time emit) anything not yet
        // captured — this records the precise SKIP reasons for types whose
        // dependencies never resolved.
        for n in &candidates {
            let raw_name = match n.attribute("name") { Some(v) => v.to_string(), None => continue };
            if emitted.contains(&raw_name) {
                continue;
            }
            self.emit_message(*n, EmitKind::Datatype);
        }
    }

    // MESSAGES --------------------------------------------------------------

    fn process_messages(&mut self, messages_node: Node<'_, '_>) {
        writeln!(self.buf, "// === MESSAGES (top-level C2S + S2C) ===\n").unwrap();
        // J3.D: same fixpoint iteration the datatype pass uses, applied to
        // messages. The forward-reference patterns at the message tier are
        // less common than at the datatype tier but they exist (e.g. a
        // message that references a struct declared later in the SAME
        // section). Messages are kept-per-direction so the section
        // header ordering survives.
        for direction in messages_node.children().filter(|n| n.is_element()) {
            let kind = match direction.tag_name().name() {
                "c2s" => EmitKind::MessageC2S,
                "s2c" => EmitKind::MessageS2C,
                _ => continue,
            };
            writeln!(self.buf, "// ---- {} ----\n", direction.tag_name().name().to_uppercase()).unwrap();
            self.emit_with_fixpoint(direction, kind);
        }
    }

    fn process_gameactions(&mut self, ga_node: Node<'_, '_>) {
        writeln!(self.buf, "// === GAMEACTIONS (C2S inside 0xF7B1) ===\n").unwrap();
        self.emit_with_fixpoint(ga_node, EmitKind::GameAction);
    }

    fn process_gameevents(&mut self, ge_node: Node<'_, '_>) {
        writeln!(self.buf, "// === GAMEEVENTS (S2C inside 0xF7B0) ===\n").unwrap();
        self.emit_with_fixpoint(ge_node, EmitKind::GameEvent);
    }

    /// J3.D: fixpoint-iterate `<type>` children under `parent`, emitting in
    /// dependency order. See `process_datatypes` for the algorithm. The kind
    /// applies to every child uniformly (sections within `<messages>` are
    /// handled at the call site by passing the per-section kind).
    fn emit_with_fixpoint(&mut self, parent: Node<'_, '_>, kind: EmitKind) {
        let candidates: Vec<Node<'_, '_>> = parent
            .children()
            .filter(|n| n.is_element() && n.tag_name().name() == "type")
            .collect();
        let mut emitted: BTreeSet<String> = BTreeSet::new();
        for _ in 0..5 {
            let mut pass_buf = String::new();
            let mut newly_emitted: Vec<String> = Vec::new();
            for n in &candidates {
                let raw_name = match n.attribute("name") { Some(v) => v.to_string(), None => continue };
                if emitted.contains(&raw_name) {
                    continue;
                }
                if collect_unsupported(*n).is_empty() {
                    if self.collect_emit_steps(*n, &format!("{}{}", kind.name_prefix(), raw_name)).is_err() {
                        continue;
                    }
                }
                let prev_buf = std::mem::take(&mut self.buf);
                self.emit_message(*n, kind);
                pass_buf.push_str(&self.buf);
                self.buf = prev_buf;
                emitted.insert(raw_name.clone());
                newly_emitted.push(raw_name);
            }
            self.buf.push_str(&pass_buf);
            if newly_emitted.is_empty() {
                break;
            }
        }
        for n in &candidates {
            let raw_name = match n.attribute("name") { Some(v) => v.to_string(), None => continue };
            if emitted.contains(&raw_name) {
                continue;
            }
            self.emit_message(*n, kind);
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

        // J3.D: pass the PREFIXED name (`C2S_Communication_TurbineChat`)
        // through as the parent for switch-derived enum names. Using the
        // bare `raw_name` (`Communication_TurbineChat`) collides when the
        // same datatype name appears in both <c2s> and <s2c> sections (the
        // structs themselves get disambiguated via `kind.name_prefix()`, but
        // their nested switch-data enums would inherit the same name and
        // emit twice into the same `pub mod generated`).
        let steps = match self.collect_emit_steps(n, &name) {
            Ok(s) => s,
            Err(reason) => {
                writeln!(self.buf, "// SKIPPED {kind_str} {name}: {reason} — port to PR 7.2.").unwrap();
                kind.bump_skipped(&mut self.stats);
                return;
            }
        };

        let pos = n.range();
        let lineno = line_of_offset(self.line_offsets, pos.start);
        // J3.D: pre-emit any `<switch>`-derived enum types (recursively for
        // nested switches). They must be declared BEFORE the parent struct
        // since the struct's `<disc>_data` field uses them by type name.
        for step in &steps {
            emit_switch_enum_recursive(&mut self.buf, step);
        }
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
        let has_switch = steps.iter().any(|s| matches!(s, EmitStep::Switch(_)));
        let has_table = steps.iter().any(|s| matches!(s, EmitStep::Table(_)));
        let has_if = steps.iter().any(|s| matches!(s, EmitStep::If(_)));
        let has_packable = steps.iter().any(|s| matches!(s, EmitStep::Packable(_)));
        if fields_only.is_empty() && vectors_only.is_empty() && !has_switch && !has_table && !has_if && !has_packable {
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
                EmitStep::Maskmap(mm) => {
                    for group in &mm.masks {
                        let bit_label = if group.value_xml.contains('.') {
                            group.value_xml.clone()
                        } else {
                            format!("bit 0x{:08X}", group.bit_value)
                        };
                        for gated in &group.fields {
                            if let Some(t) = &gated.text {
                                writeln!(self.buf, "    /// Gated on {} (`{}`). {}",
                                    escape_doc(&bit_label),
                                    escape_doc(&mm.parent_snake),
                                    escape_doc(t)).unwrap();
                            } else {
                                writeln!(self.buf, "    /// Gated on {} (`{}`).",
                                    escape_doc(&bit_label),
                                    escape_doc(&mm.parent_snake)).unwrap();
                            }
                            writeln!(self.buf, "    pub {}: Option<{}>,", gated.name_snake, gated.rust_ty).unwrap();
                        }
                        for pf in &group.packables {
                            let rust_ty = packable_rust_ty(pf);
                            if let Some(t) = &pf.text {
                                writeln!(self.buf, "    /// Gated on {} (`{}`). {}",
                                    escape_doc(&bit_label),
                                    escape_doc(&mm.parent_snake),
                                    escape_doc(t)).unwrap();
                            } else {
                                writeln!(self.buf, "    /// Gated on {} (`{}`).",
                                    escape_doc(&bit_label),
                                    escape_doc(&mm.parent_snake)).unwrap();
                            }
                            writeln!(self.buf, "    pub {}: Option<{}>,", pf.name_snake, rust_ty).unwrap();
                        }
                    }
                }
                EmitStep::Switch(sw) => {
                    writeln!(self.buf, "    /// Discriminated by `{}` per protocol.xml `<switch name=\"{}\">`.",
                        escape_doc(&sw.disc_snake),
                        escape_xml_attr_for_doc(&sw.disc_xml_name)).unwrap();
                    writeln!(self.buf, "    pub {}: {},", sw.field_snake, sw.enum_name).unwrap();
                }
                EmitStep::Table(tb) => {
                    if let Some(t) = &tb.text {
                        writeln!(self.buf, "    /// {}", escape_doc(t)).unwrap();
                    } else {
                        writeln!(self.buf, "    /// Dictionary field; length from protocol.xml `length=\"{}\"`.",
                            escape_xml_attr_for_doc(&tb.length_xml)).unwrap();
                    }
                    writeln!(self.buf, "    pub {}: std::collections::BTreeMap<{}, {}>,",
                        tb.name_snake, tb.key_rust_ty, tb.value_rust_ty).unwrap();
                }
                EmitStep::If(ifb) => {
                    if let Some(t) = &ifb.text {
                        writeln!(self.buf, "    /// `<if test=\"{}\">`. {}",
                            escape_xml_attr_for_doc(&ifb.test_xml),
                            escape_doc(t)).unwrap();
                    } else {
                        writeln!(self.buf, "    /// Conditional fields gated by `<if test=\"{}\">`.",
                            escape_xml_attr_for_doc(&ifb.test_xml)).unwrap();
                    }
                    // Emit one Option<T> per nested field (in true-branch
                    // then false-branch order, matching the wire-decode
                    // order). Nested non-field steps (vector, align) don't
                    // contribute struct fields directly — but in retail,
                    // every if-branch body is fields-only.
                    emit_if_struct_fields(&mut self.buf, &ifb.true_steps, "true");
                    emit_if_struct_fields(&mut self.buf, &ifb.false_steps, "false");
                }
                EmitStep::Packable(pf) => {
                    let (label, rust_ty) = match pf.kind {
                        PackableKind::List => (
                            "PackableList".to_string(),
                            format!("Vec<{}>", pf.value_rust_ty),
                        ),
                        PackableKind::HashTable => (
                            format!("PackableHashTable<{}, {}>", pf.key_rust_ty, pf.value_rust_ty),
                            format!("Vec<({}, {})>", pf.key_rust_ty, pf.value_rust_ty),
                        ),
                        PackableKind::PHashTable => (
                            format!("PHashTable<{}, {}>", pf.key_rust_ty, pf.value_rust_ty),
                            format!("Vec<({}, {})>", pf.key_rust_ty, pf.value_rust_ty),
                        ),
                    };
                    if let Some(t) = &pf.text {
                        writeln!(self.buf, "    /// Inlined templated `{}`. {}", label, escape_doc(t)).unwrap();
                    } else {
                        writeln!(self.buf, "    /// Inlined templated `{}` (J3.E use-site).", label).unwrap();
                    }
                    writeln!(self.buf, "    pub {}: {},", pf.name_snake, rust_ty).unwrap();
                }
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
        let has_maskmap = steps.iter().any(|s| matches!(s, EmitStep::Maskmap(_)));
        if fields_only.is_empty()
            && vectors_only.is_empty()
            && !has_maskmap
            && !has_switch
            && !has_table
            && !has_if
            && !has_packable
            && !steps.iter().any(|s| matches!(s, EmitStep::Align(_)))
        {
            writeln!(self.buf, "        let _ = (data, offset);").unwrap();
        }
        for step in &steps {
            match step {
                EmitStep::Field(f) => emit_read_field(&mut self.buf, &f.name_snake, &f.field_kind),
                EmitStep::Align(n_bytes) => emit_align_pad(&mut self.buf, *n_bytes),
                EmitStep::Vector(v) => emit_read_vector(&mut self.buf, v),
                EmitStep::Maskmap(mm) => emit_read_maskmap(&mut self.buf, mm),
                EmitStep::Switch(sw) => emit_read_switch(&mut self.buf, sw, "        "),
                EmitStep::Table(tb) => emit_read_table(&mut self.buf, tb, "        "),
                EmitStep::If(ifb) => emit_read_if(&mut self.buf, ifb, "        "),
                EmitStep::Packable(pf) => emit_read_packable(&mut self.buf, pf, "        "),
            }
        }
        writeln!(self.buf, "        Ok(Self {{").unwrap();
        for step in &steps {
            match step {
                EmitStep::Field(f) => writeln!(self.buf, "            {},", f.name_snake).unwrap(),
                EmitStep::Vector(v) => writeln!(self.buf, "            {},", v.name_snake).unwrap(),
                EmitStep::Align(_) => {}
                EmitStep::Maskmap(mm) => {
                    for group in &mm.masks {
                        for gated in &group.fields {
                            writeln!(self.buf, "            {},", gated.name_snake).unwrap();
                        }
                        for pf in &group.packables {
                            writeln!(self.buf, "            {},", pf.name_snake).unwrap();
                        }
                    }
                }
                EmitStep::Switch(sw) => writeln!(self.buf, "            {},", sw.field_snake).unwrap(),
                EmitStep::Table(tb) => writeln!(self.buf, "            {},", tb.name_snake).unwrap(),
                EmitStep::If(ifb) => {
                    emit_if_struct_field_names(&mut self.buf, &ifb.true_steps);
                    emit_if_struct_field_names(&mut self.buf, &ifb.false_steps);
                }
                EmitStep::Packable(pf) => writeln!(self.buf, "            {},", pf.name_snake).unwrap(),
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
                    // J3.E: PackableList/PackableHashTable/PHashTable use-sites
                    // are inlined here — they wear `<field>` clothing but
                    // describe a templated wire shape (count prefix + vector
                    // or table). Detect via the type name + presence of
                    // genericType / genericKey+genericValue attributes; route
                    // through `build_packable_field` so the codegen matches
                    // the inlined wire layout.
                    if let Some(packable_kind) = packable_kind_for_field(c) {
                        let pf = self.build_packable_field(c, packable_kind, &mut seen_names)?;
                        siblings.add_packable(&pf);
                        out.push(EmitStep::Packable(pf));
                        continue;
                    }
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
                "maskmap" => {
                    let mm = self.build_maskmap_block(
                        c,
                        &mut seen_names,
                        parent_type_name,
                        &siblings,
                    )?;
                    // J3.E: register each gated field as a sibling so later
                    // maskmaps that name them as a parent (PublicWeenieDesc's
                    // `<maskmap name="Header2">`) can resolve via the
                    // `Option<T>` local emitted at decode time.
                    siblings.add_maskmap_gated(&mm);
                    out.push(EmitStep::Maskmap(mm));
                }
                "switch" => {
                    let sw = self.build_switch_block(
                        c,
                        &mut seen_names,
                        parent_type_name,
                        &siblings,
                    )?;
                    out.push(EmitStep::Switch(sw));
                }
                "table" => {
                    let tb = self.build_table_field(
                        c,
                        &mut seen_names,
                        parent_type_name,
                        &siblings,
                    )?;
                    out.push(EmitStep::Table(tb));
                }
                "if" => {
                    let ifb = self.build_if_block(
                        c,
                        &mut seen_names,
                        parent_type_name,
                        &mut siblings,
                    )?;
                    out.push(EmitStep::If(ifb));
                }
                other => {
                    return Err(format!("unsupported child `<{other}>`"));
                }
            }
        }
        Ok(out)
    }

    /// J3.E: build an [`IfBlock`] from a `<if test="EXPR">` element. Parses
    /// the boolean test against the sibling-lookup index, then recursively
    /// collects the `<true>` (and optional `<false>`) body steps. Each gated
    /// field's snake-name is added to the parent's `seen_names` so a
    /// collision between true and false branches (AllegianceData's
    /// `TimeOnline` ulong vs uint) auto-disambiguates as `_2`. Sibling
    /// lookup is ALSO extended with the gated fields so subsequent
    /// non-if-block fields (the trailing `<vector>` in AllegianceHierarchy,
    /// the trailing `<field name="Name">` in AllegianceData) can reference
    /// them — though in practice the retail schema never references an
    /// if-gated field from outside the if-block.
    fn build_if_block(
        &self,
        c: Node<'_, '_>,
        seen_names: &mut BTreeMap<String, usize>,
        parent_type_name: &str,
        siblings: &mut SiblingLookup,
    ) -> Result<IfBlock, String> {
        let test_xml = c.attribute("test")
            .ok_or_else(|| "<if> missing test= attribute".to_string())?;
        let test_rust = translate_if_test_expr(test_xml, siblings)
            .map_err(|e| format!("<if test={test_xml:?}>: cannot translate boolean expression: {e}"))?;

        // Walk `<true>` / `<false>` children. The C# generator's XPath
        // selectors look for exact `./true` and `./false` tags; we mirror.
        let mut true_steps = Vec::new();
        let mut false_steps = Vec::new();
        for branch in c.children().filter(|b| b.is_element()) {
            let tag = branch.tag_name().name();
            let dest = match tag {
                "true" => &mut true_steps,
                "false" => &mut false_steps,
                other => return Err(format!("<if test={test_xml:?}>: unexpected child <{other}>; only <true>/<false> allowed")),
            };
            // Each branch is treated like a mini-`<type>` body: walk its
            // children through the same emit-steps machinery. We share
            // `seen_names` + `siblings` with the parent so collisions across
            // branches surface as `_2`-suffixed snake-names AND so a later
            // sibling can reference any gated field by its XML name.
            for body in branch.children().filter(|b| b.is_element()) {
                let btag = body.tag_name().name();
                match btag {
                    "field" => {
                        if let Some(packable_kind) = packable_kind_for_field(body) {
                            let pf = self.build_packable_field(body, packable_kind, seen_names)
                                .map_err(|e| format!("<if test={test_xml:?}> <{tag}>: {e}"))?;
                            siblings.add_packable(&pf);
                            dest.push(EmitStep::Packable(pf));
                            continue;
                        }
                        let f = self.build_simple_field(body, seen_names, parent_type_name)
                            .map_err(|e| format!("<if test={test_xml:?}> <{tag}>: {e}"))?;
                        siblings.add_field(&f);
                        dest.push(EmitStep::Field(f));
                    }
                    "vector" => {
                        let v = self.build_vector_field(body, seen_names, parent_type_name, siblings)
                            .map_err(|e| format!("<if test={test_xml:?}> <{tag}>: {e}"))?;
                        dest.push(EmitStep::Vector(v));
                    }
                    "align" => {
                        let n_bytes = align_byte_width_from_node(body)
                            .ok_or_else(|| format!("<if test={test_xml:?}> <{tag}>: <align> with type {:?}: unknown alignment width", body.attribute("type")))?;
                        dest.push(EmitStep::Align(n_bytes));
                    }
                    other => {
                        return Err(format!("<if test={test_xml:?}> <{tag}>: unsupported child <{other}>"));
                    }
                }
            }
        }
        if true_steps.is_empty() && false_steps.is_empty() {
            return Err(format!("<if test={test_xml:?}>: both branches empty (no <true>/<false> with fields)"));
        }

        Ok(IfBlock {
            test_xml: test_xml.to_string(),
            test_rust,
            true_steps,
            false_steps,
            text: c.attribute("text").map(|s| s.to_string()),
        })
    }

    /// J3.E: build a [`PackableField`] from a `<field type="PackableList"
    /// genericType="...">` (or PackableHashTable/PHashTable with
    /// genericKey+genericValue). Resolves the element types up front via
    /// `resolve_field`; templated marker `T`/`U` in the generic attrs would
    /// indicate a templated type inside a templated type (none in the
    /// retail schema; the inliner panics on the recursive case).
    fn build_packable_field(
        &self,
        c: Node<'_, '_>,
        kind: PackableKind,
        seen_names: &mut BTreeMap<String, usize>,
    ) -> Result<PackableField, String> {
        let raw_name = c.attribute("name")
            .ok_or_else(|| format!("<field type={:?}> missing name= attribute", c.attribute("type").unwrap_or("?")))?;
        // Resolve element types based on kind.
        let (key_rust_ty, key_kind, value_rust_ty, value_kind) = match kind {
            PackableKind::List => {
                let raw_t = c.attribute("genericType")
                    .ok_or_else(|| format!("<field {raw_name} type=\"PackableList\"> missing genericType= attribute"))?;
                if raw_t == "T" {
                    return Err(format!(
                        "<field {raw_name} type=\"PackableList\" genericType=\"T\">: templated marker not allowed in a use-site (nested templated types are not supported)"
                    ));
                }
                let (ty, k) = self.resolve_field(raw_t)
                    .ok_or_else(|| format!("<field {raw_name} type=\"PackableList\" genericType={raw_t:?}>: element type not in foundation tier"))?;
                // For List, store element in value slot; key slot unused.
                ("()".to_string(), FieldKind::PrimU8, ty, k)
            }
            PackableKind::HashTable | PackableKind::PHashTable => {
                let raw_k = c.attribute("genericKey")
                    .ok_or_else(|| format!("<field {raw_name} type=\"{:?}\"> missing genericKey= attribute", kind_name(kind)))?;
                let raw_v = c.attribute("genericValue")
                    .ok_or_else(|| format!("<field {raw_name} type=\"{:?}\"> missing genericValue= attribute", kind_name(kind)))?;
                if raw_k == "T" || raw_k == "U" || raw_v == "T" || raw_v == "U" {
                    return Err(format!(
                        "<field {raw_name} type=\"{}\" genericKey={raw_k:?} genericValue={raw_v:?}>: templated marker not allowed in a use-site",
                        kind_name(kind)
                    ));
                }
                let (kty, kk) = self.resolve_field(raw_k)
                    .ok_or_else(|| format!("<field {raw_name} type=\"{}\" genericKey={raw_k:?}>: key type not in foundation tier", kind_name(kind)))?;
                let (vty, vk) = self.resolve_field(raw_v)
                    .ok_or_else(|| format!("<field {raw_name} type=\"{}\" genericValue={raw_v:?}>: value type not in foundation tier", kind_name(kind)))?;
                (kty, kk, vty, vk)
            }
        };

        let mut snake = to_snake_case(raw_name);
        let counter = seen_names.entry(snake.clone()).or_insert(0);
        if *counter > 0 {
            snake = format!("{snake}_{}", *counter + 1);
        }
        *counter += 1;
        let snake = sanitize_rust_keyword(&snake);

        Ok(PackableField {
            name_snake: snake,
            kind,
            key_rust_ty,
            key_kind,
            value_rust_ty,
            value_kind,
            text: c.attribute("text").map(|s| s.to_string()),
        })
    }

    /// J3.D: build a [`SwitchBlock`] from a `<switch name="DiscField">`
    /// element. The discriminator MUST be a sibling field declared earlier in
    /// the same `<type>` body — either a numeric primitive (`uint`, `byte`,
    /// `ushort`, `int`) or an already-emitted enum-typed field (whose `_bits`
    /// companion local is in scope from the enum-field codegen path).
    ///
    /// Each `<case value="V | W | ...">` becomes one enum variant. Values can
    /// be hex literals (`0x1000008d`), decimal literals (`-1`, `1`), or
    /// pipe-separated multi-value (`0x01 | 0x06`). The C# upstream splits on
    /// `" | "` and emits one fall-through `case X:` per token; we collapse
    /// the equivalent into a single Rust match arm `n if n == 1 || n == 6 => ...`.
    ///
    /// Case bodies route through `collect_case_steps`, which is a near-clone
    /// of `collect_emit_steps` that ALSO seeds the sibling lookup with the
    /// outer `<type>`'s siblings so case-body fields can reference an outer
    /// field via maskmap parent / vector length / subfield. Nested
    /// `<switch>` inside a case is supported recursively, producing nested
    /// `Foo<Outer>Data` → `Foo<Outer>_<Variant>_<Inner>Data` enum types.
    fn build_switch_block(
        &self,
        c: Node<'_, '_>,
        seen_names: &mut BTreeMap<String, usize>,
        parent_type_name: &str,
        siblings: &SiblingLookup,
    ) -> Result<SwitchBlock, String> {
        let disc_xml_name = c.attribute("name")
            .ok_or_else(|| "<switch> missing name= attribute".to_string())?;
        let (disc_snake, disc_repr, disc_kind) = resolve_switch_discriminator(disc_xml_name, siblings)
            .ok_or_else(|| format!("<switch name={disc_xml_name:?}>: discriminator not found as a sibling numeric/enum field declared before this <switch>"))?;

        let mut cases = Vec::new();
        let mut all_values: BTreeSet<i128> = BTreeSet::new();
        for cc in c.children().filter(|cc| cc.is_element()) {
            let tag = cc.tag_name().name();
            if tag != "case" {
                return Err(format!("<switch name={disc_xml_name:?}>: unexpected child <{tag}>; only <case> allowed"));
            }
            let raw_value = cc.attribute("value")
                .ok_or_else(|| format!("<switch name={disc_xml_name:?}>: <case> missing value= attribute"))?;
            // Multi-value: `0x01 | 0x06` → vec![1, 6]; single: `0x4` → vec![4].
            // Whitespace around `|` is the convention in protocol.xml; we
            // also accept un-spaced forms defensively.
            let value_tokens: Vec<&str> = raw_value
                .split('|')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .collect();
            if value_tokens.is_empty() {
                return Err(format!("<switch name={disc_xml_name:?}>: <case value={raw_value:?}> has no parseable tokens"));
            }
            let mut numeric_values = Vec::new();
            for tok in &value_tokens {
                let parsed = parse_int_literal(tok)
                    .ok_or_else(|| format!("<switch name={disc_xml_name:?}>: <case value={raw_value:?}> token {tok:?} is not a parseable integer literal"))?;
                if !all_values.insert(parsed) {
                    return Err(format!("<switch name={disc_xml_name:?}>: case value {parsed} (token {tok:?}) is duplicated across cases"));
                }
                numeric_values.push(parsed);
            }
            // Variant name: use the first value as the canonical identifier
            // (`Case_<HEX>` for non-negatives, `Case_NegN` for negatives). For
            // multi-value cases we join with `_`.
            let variant_id = canonical_case_variant_id(&numeric_values);
            // Recursively collect the case body's steps. We seed a fresh
            // sibling lookup that INHERITS the outer siblings (so a case-body
            // maskmap can name an outer flag field by XML name, see
            // MovementData.OptionFlags) — then add case-locals on top as the
            // body decodes.
            let mut case_seen_names: BTreeMap<String, usize> = seen_names.clone();
            let mut case_siblings: SiblingLookup = siblings.clone();
            let mut steps = Vec::new();
            for body in cc.children().filter(|b| b.is_element()) {
                let btag = body.tag_name().name();
                match btag {
                    "field" => {
                        if let Some(packable_kind) = packable_kind_for_field(body) {
                            let pf = self.build_packable_field(body, packable_kind, &mut case_seen_names)
                                .map_err(|e| format!("<switch name={disc_xml_name:?}> <case value={raw_value:?}>: {e}"))?;
                            case_siblings.add_packable(&pf);
                            steps.push(EmitStep::Packable(pf));
                            continue;
                        }
                        let f = self.build_simple_field(body, &mut case_seen_names, parent_type_name)
                            .map_err(|e| format!("<switch name={disc_xml_name:?}> <case value={raw_value:?}>: {e}"))?;
                        case_siblings.add_field(&f);
                        steps.push(EmitStep::Field(f));
                    }
                    "vector" => {
                        let v = self.build_vector_field(body, &mut case_seen_names, parent_type_name, &case_siblings)
                            .map_err(|e| format!("<switch name={disc_xml_name:?}> <case value={raw_value:?}>: {e}"))?;
                        steps.push(EmitStep::Vector(v));
                    }
                    "align" => {
                        let n_bytes = align_byte_width_from_node(body)
                            .ok_or_else(|| format!("<switch name={disc_xml_name:?}> <case value={raw_value:?}>: <align> with type {:?}: unknown alignment width", body.attribute("type")))?;
                        steps.push(EmitStep::Align(n_bytes));
                    }
                    "maskmap" => {
                        let mm = self.build_maskmap_block(
                            body,
                            &mut case_seen_names,
                            parent_type_name,
                            &case_siblings,
                        )
                        .map_err(|e| format!("<switch name={disc_xml_name:?}> <case value={raw_value:?}>: {e}"))?;
                        steps.push(EmitStep::Maskmap(mm));
                    }
                    "switch" => {
                        // J3.D: when a switch is nested inside a case, we
                        // derive a CASE-SCOPED parent name so the nested
                        // switch's emitted enum doesn't collide with sibling
                        // nested switches in other cases of the SAME outer
                        // switch (TurbineChat has three sibling nested switches
                        // — one per outer case — that all share the inner
                        // disc field name `BlobDispatchType`).
                        let nested_parent = format!("{parent_type_name}_{}",
                            canonical_case_variant_id(&numeric_values));
                        let nested = self.build_switch_block(
                            body,
                            &mut case_seen_names,
                            &nested_parent,
                            &case_siblings,
                        )
                        .map_err(|e| format!("<switch name={disc_xml_name:?}> <case value={raw_value:?}>: nested {e}"))?;
                        steps.push(EmitStep::Switch(nested));
                    }
                    "if" => {
                        let ifb = self.build_if_block(
                            body,
                            &mut case_seen_names,
                            parent_type_name,
                            &mut case_siblings,
                        )
                        .map_err(|e| format!("<switch name={disc_xml_name:?}> <case value={raw_value:?}>: {e}"))?;
                        steps.push(EmitStep::If(ifb));
                    }
                    other => {
                        return Err(format!("<switch name={disc_xml_name:?}> <case value={raw_value:?}>: unsupported body child <{other}>"));
                    }
                }
            }
            cases.push(SwitchCase {
                variant_id,
                value_xml: raw_value.to_string(),
                values: numeric_values,
                text: cc.attribute("text").map(|s| s.to_string()),
                steps,
            });
        }
        if cases.is_empty() {
            return Err(format!("<switch name={disc_xml_name:?}>: contains no <case> children"));
        }

        // The struct field for this switch: `<disc_xml_name>_data` lowercased
        // to a snake-id, sanitized for Rust keyword collision (e.g.
        // `r#type_data` would surface if disc was `type`).
        //
        // We derive the field snake-id from the XML name (not the disc_snake
        // / scrutinee expression) so subfield-typed discriminators — where
        // disc_snake is a Rust expression like `(packed_amount as u32) >> 24`,
        // not a bare ident — still produce a clean struct-field name like
        // `pwd_type_data`.
        let mut field_snake = format!("{}_data", to_snake_case(disc_xml_name));
        // Avoid collision with siblings already emitted. There's no
        // `<field name="XxxData">` in the schema, but a `<switch name="X">`
        // sometimes follows a sibling field `<field name="XData">` and the
        // suffix uniquifier handles that defensively.
        let counter = seen_names.entry(field_snake.clone()).or_insert(0);
        if *counter > 0 {
            field_snake = format!("{field_snake}_{}", *counter + 1);
        }
        *counter += 1;
        let field_snake = sanitize_rust_keyword(&field_snake);

        // Synthesise the enum type name. The convention is parent type +
        // disc field PascalCase (derived from the XML name, NOT the
        // keyword-sanitized Rust snake) + "Data": `Foo` + `Type` + `Data` =
        // `FooTypeData`. Using `disc_snake` here would inject the `r#` raw-ident
        // prefix into the enum name when the disc field is named `Type` (a Rust
        // keyword). The XML name path is the cleanest source.
        let enum_name = format!("{parent_type_name}{}Data", pascalize_xml_name(disc_xml_name));

        Ok(SwitchBlock {
            enum_name,
            field_snake,
            disc_snake,
            disc_repr,
            disc_kind,
            disc_xml_name: disc_xml_name.to_string(),
            cases,
        })
    }

    /// J3.D: build a [`TableField`] from a `<table name="Foo" key="K" value="V"
    /// length="LenExpr">` element. Equivalent to a `Dictionary<K, V>` whose
    /// entry count comes from a sibling-resolved length expression. Routes
    /// element-type resolution through `resolve_field` so templated marker
    /// types (`T`, `U`) defer cleanly with a precise J3.E-pointing reason.
    fn build_table_field(
        &self,
        c: Node<'_, '_>,
        seen_names: &mut BTreeMap<String, usize>,
        parent_type_name: &str,
        siblings: &SiblingLookup,
    ) -> Result<TableField, String> {
        let raw_name = c.attribute("name").ok_or_else(|| "<table> missing name".to_string())?;
        let raw_key = c.attribute("key").ok_or_else(|| format!("<table {raw_name}> missing key= attribute"))?;
        let raw_value = c.attribute("value").ok_or_else(|| format!("<table {raw_name}> missing value= attribute"))?;
        let raw_length = c.attribute("length")
            .ok_or_else(|| format!("<table {raw_name}> missing length= attribute"))?;

        // Templated markers — these only appear inside `<type templated="T,U">`
        // bodies (PackableHashTable, PHashTable). J3.E owns the templated-type
        // generalisation; we route through a precise SKIP-reason that points
        // at the right follow-on.
        if raw_key == "T" || raw_key == "U" || raw_value == "T" || raw_value == "U" {
            return Err(format!("<table {raw_name}>: key={raw_key:?}/value={raw_value:?} uses templated marker; deferred to J3.E"));
        }

        let (key_rust_ty, key_kind) = self.resolve_field(raw_key)
            .ok_or_else(|| format!("<table {raw_name}>: key type {raw_key:?} not in foundation tier"))?;
        let (value_rust_ty, value_kind) = self.resolve_field(raw_value)
            .ok_or_else(|| format!("<table {raw_name}>: value type {raw_value:?} not in foundation tier"))?;

        let length_expr_rust = translate_vector_length_expr(raw_length, siblings)
            .map_err(|e| format!("<table {raw_name}>: cannot translate length={raw_length:?}: {e}"))?;

        let mut snake = to_snake_case(raw_name);
        let counter = seen_names.entry(snake.clone()).or_insert(0);
        if *counter > 0 {
            snake = format!("{snake}_{}", *counter + 1);
        }
        *counter += 1;
        let snake = sanitize_rust_keyword(&snake);
        let _ = parent_type_name; // reserved for future error context.

        Ok(TableField {
            name_snake: snake,
            key_rust_ty,
            key_kind,
            value_rust_ty,
            value_kind,
            length_expr_rust,
            length_xml: raw_length.to_string(),
            text: c.attribute("text").map(|s| s.to_string()),
        })
    }

    /// J3.C: build a [`MaskmapBlock`] from a `<maskmap name="ParentField" [xor=]>`
    /// element. Resolves the parent's bit-source via [`SiblingLookup`] and
    /// parses every `<mask value="...">` child (either a hex literal or a
    /// dotted `EnumName.VariantName` reference). The mask child's nested
    /// `<field>` children flow through the same `build_simple_field` path
    /// the foundation-tier uses — no subfield/maskmap-nesting recursion
    /// (Chorizite's schema never nests).
    fn build_maskmap_block(
        &self,
        c: Node<'_, '_>,
        seen_names: &mut BTreeMap<String, usize>,
        parent_type_name: &str,
        siblings: &SiblingLookup,
    ) -> Result<MaskmapBlock, String> {
        let parent_xml_name = c.attribute("name")
            .ok_or_else(|| "<maskmap> missing name= attribute".to_string())?;

        // Resolve the parent field. It MUST be a sibling that was already
        // emitted earlier in this same <type> body — schema convention.
        // Either a numeric primitive (uint/int/byte/ushort) directly, or an
        // already-tracked flag enum (handled separately via `enum_parent_bits`).
        let parent_bits_rust = resolve_maskmap_parent_bits(parent_xml_name, siblings, &self.type_kind)
            .map_err(|e| format!("<maskmap name={parent_xml_name:?}>: {e}"))?;
        let parent_snake = resolve_maskmap_parent_snake(parent_xml_name, siblings)
            .ok_or_else(|| format!("<maskmap name={parent_xml_name:?}>: parent field not found among siblings"))?;

        let xor_mask = if let Some(raw) = c.attribute("xor") {
            // J3.C: the only schema site with xor= is PositionPack (line 6471)
            // where Flags^0x78 inverts the polarity of WQuat/XQuat/YQuat/ZQuat
            // gates. Implementation is identical to the no-xor path except the
            // gate uses `(bits ^ xor) & value != 0`. We support it directly.
            let val = parse_int_literal(raw)
                .ok_or_else(|| format!("<maskmap name={parent_xml_name:?}> xor={raw:?} is not a parseable integer literal"))?;
            Some(val as u64)
        } else {
            None
        };

        let mut masks = Vec::new();
        for mc in c.children().filter(|cc| cc.is_element()) {
            let mtag = mc.tag_name().name();
            if mtag != "mask" {
                return Err(format!(
                    "<maskmap name={parent_xml_name:?}>: unexpected child <{mtag}>; only <mask> allowed"
                ));
            }
            let raw_value = mc.attribute("value")
                .ok_or_else(|| format!("<maskmap name={parent_xml_name:?}>: <mask> missing value= attribute"))?;
            let bit_value = parse_mask_value(raw_value, &self.enum_variant_values)
                .map_err(|e| format!("<maskmap name={parent_xml_name:?}>: <mask value={raw_value:?}>: {e}"))?;

            let mut fields = Vec::new();
            let mut packables = Vec::new();
            for fc in mc.children().filter(|cc| cc.is_element()) {
                let ftag = fc.tag_name().name();
                if ftag != "field" {
                    return Err(format!(
                        "<maskmap name={parent_xml_name:?}> <mask value={raw_value:?}>: unexpected child <{ftag}>; only <field> allowed inside <mask>"
                    ));
                }
                // J3.E: detect inlined Packable use-sites here too — the
                // PackableList/PackableHashTable members of ACBaseQualities,
                // ACQualities, EnchantmentRegistry, PhysicsDesc, etc. all
                // appear inside `<mask>` bodies. Without this detection the
                // build_simple_field path would fail with the generic
                // "type X not in foundation tier" reason.
                if let Some(packable_kind) = packable_kind_for_field(fc) {
                    let pf = self.build_packable_field(fc, packable_kind, seen_names)
                        .map_err(|e| format!("<maskmap name={parent_xml_name:?}> <mask value={raw_value:?}>: {e}"))?;
                    packables.push(pf);
                    continue;
                }
                let f = self.build_simple_field(fc, seen_names, parent_type_name)
                    .map_err(|e| format!("<maskmap name={parent_xml_name:?}> <mask value={raw_value:?}>: {e}"))?;
                fields.push(f);
            }
            if fields.is_empty() && packables.is_empty() {
                return Err(format!(
                    "<maskmap name={parent_xml_name:?}> <mask value={raw_value:?}>: contains no <field> children"
                ));
            }
            masks.push(MaskGroup {
                bit_value,
                value_xml: raw_value.to_string(),
                fields,
                packables,
                text: mc.attribute("text").map(|s| s.to_string()),
            });
        }
        if masks.is_empty() {
            return Err(format!(
                "<maskmap name={parent_xml_name:?}>: contains no <mask> children"
            ));
        }

        Ok(MaskmapBlock {
            parent_snake,
            parent_bits_rust,
            xor_mask,
            masks,
        })
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
        // J3.D: `skip="N"` is now FOUNDATION-tier inside `<switch>` case bodies
        // (DDD_DataMessage compression branches at lines 8447/8451). Per the
        // upstream C# template (CSTemplateBase.WriteForLoopStart), `skip=N`
        // means "iterate `length - N` times" — the consumer has already
        // consumed N bytes of the named length budget by the time the vector
        // starts. We translate that to a trailing `- N` on the length expr.
        let skip_count = c.attribute("skip");

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
        let mut length_expr_rust = translate_vector_length_expr(raw_length, siblings)
            .map_err(|e| format!("<vector {raw_name}>: cannot translate length={raw_length:?}: {e}"))?;
        // J3.D: `skip="N"` post-adjusts the loop count. Upstream C# emits
        // `for (var i=0; i < length - skip; i++)`. We wrap the already-cast
        // `usize` expression in a saturating subtract so the count never
        // underflows when length < skip (defensive — would indicate a
        // malformed wire payload).
        if let Some(skip_raw) = skip_count {
            let skip_n = parse_int_literal(skip_raw)
                .ok_or_else(|| format!("<vector {raw_name}>: skip={skip_raw:?} is not a parseable integer literal"))?;
            length_expr_rust = format!("({length_expr_rust}).saturating_sub({skip_n}usize)");
        }

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

        let (mut rust_ty, mut field_kind) = match self.resolve_field(raw_type) {
            Some(p) => p,
            None => return Err(format!("field {raw_name}: type {raw_type:?} not in foundation tier")),
        };

        // Wave 6.A (2026-05-28): Chorizite XML vs ACE retail-wire divergence
        // override.  Some Chorizite `<field type="float">` declarations encode
        // a value that ACE actually writes as `double` (`Writer.Write(double
        // value)`).  When the schema and the wire disagree, ACE wins — the
        // generated parser would mis-decode 4 of the 8 bytes ACE actually
        // emits.  We patch the field kind in-place to `f64` so the generated
        // `read_from` consumes the full 8 bytes.  Documented at
        // `apps/holtburger-web/validate_wire_conformance.cjs` Wave 1.A
        // fixtures; flagged for upstream Chorizite XML fix.
        //
        // Source of truth for each override (file:line):
        //   - `Qualities_PrivateUpdateFloat::Value`
        //     (protocol.xml:8082) → ACE
        //     `GameMessagePrivateUpdatePropertyFloat.cs:13` writes
        //     `double value`.
        //   - `Qualities_UpdateFloat::Value`
        //     (protocol.xml:8088) → ACE
        //     `GameMessagePublicUpdatePropertyFloat.cs` writes `double value`
        //     (same pattern as private).
        if matches!(field_kind, FieldKind::PrimF32) && raw_name == "Value" && matches!(
            parent_type_name,
            "S2C_Qualities_PrivateUpdateFloat" | "S2C_Qualities_UpdateFloat"
        ) {
            rust_ty = "f64".to_string();
            field_kind = FieldKind::PrimF64;
        }

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
                xml_name: sf_raw_name.to_string(),
                rust_ty: sf_repr,
                rust_expr,
                value_expr: sf_value.to_string(),
                text: sc.attribute("text").map(|s| s.to_string()),
            });
        }

        Ok(SimpleField {
            name_snake: snake,
            xml_name: raw_name.to_string(),
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
            TypeKind::Enum(repr, is_flag) => {
                // J3.C: flag enums (`mask="true"`) carry arbitrary OR-of-bit
                // wire compositions; an unknown discriminant is LEGAL not an
                // error. To stay type-safe, the field stores the RAW bit
                // pattern (e.g. `u32`) rather than the typed enum — the enum
                // variants remain available for downstream consumers that
                // want to match individual bits via `value & Enum::Variant as
                // repr`. The maskmap codegen reads the same raw bits via the
                // SiblingLookup's flag-enum-aware bit-source resolver.
                if *is_flag {
                    Some((repr.rust_ty().to_string(), match *repr {
                        EnumRepr::U8 => FieldKind::PrimU8,
                        EnumRepr::U16 => FieldKind::PrimU16,
                        EnumRepr::U32 => FieldKind::PrimU32,
                        EnumRepr::U64 => FieldKind::PrimU64,
                        EnumRepr::I32 => FieldKind::PrimI32,
                        EnumRepr::I64 => FieldKind::PrimI64,
                    }))
                } else {
                    Some((raw_type.to_string(), FieldKind::Enum(raw_type.to_string(), *repr, *is_flag)))
                }
            }
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
/// J3.C: `<maskmap name="ParentField">` produces a Maskmap; the emitter writes
/// `Option<T>` struct fields for each gated field + a `if (parent_bits & bit)
/// != 0 { … }` decode block in `read_from`. Multiple maskmaps for the same
/// parent are independent steps — the order they appear in XML matches the
/// wire-decode order (matters for `PublicWeenieDesc`'s 3 `Header` maskmaps
/// that split MaterialType / IconUnderlay / etc. into separate ordered
/// blocks).
enum EmitStep {
    Field(SimpleField),
    Align(usize),
    Vector(VectorField),
    Maskmap(MaskmapBlock),
    /// J3.D: `<switch name="DiscField">` discriminated-union block. Each
    /// case becomes one variant of an emitted enum named
    /// `<ParentType><DiscFieldPascal>Data`; the struct holds a single
    /// `<disc_snake>_data: <EnumName>` field that carries the
    /// case-specific payload.
    Switch(SwitchBlock),
    /// J3.D: `<table key="K" value="V" length="LenExpr">` Dictionary<K, V>
    /// block. Emits a `BTreeMap<K, V>` struct field; the value's key field
    /// is determined by `key="..."` (currently unused — the wire form for
    /// every concrete (non-templated) `<table>` site uses the K and V
    /// independently and we recover the key by reading K before V at each
    /// iteration). Templated `T,U` tables fall through to a precise SKIP
    /// reason pointing at J3.E.
    Table(TableField),
    /// J3.E: `<if test="EXPR">` boolean conditional. The `true_steps` (and
    /// optional `false_steps`) decode iff the EXPR is true. All gated fields
    /// are emitted as `Option<T>` on the struct so the `Self { ... }`
    /// construction is well-typed regardless of which branch fired. The 6
    /// retail sites use simple comparison/bool expressions (see
    /// `translate_if_test_expr`).
    If(IfBlock),
    /// J3.E: templated PackableList/PackableHashTable/PHashTable inlined at
    /// use-site. The schema's `<field type="PackableList" genericType="X">`
    /// (or PackableHashTable/PHashTable with genericKey+genericValue) has no
    /// concrete `<vector>` or `<table>` element — instead it represents an
    /// inlined wire layout: PackableList = u32 count + N×T;
    /// PackableHashTable = u16 count + u16 maxsize + N×(K,V);
    /// PHashTable = u32 packed-size + N×(K,V) where count = packed & 0xFFFFFF.
    Packable(PackableField),
}

/// J3.C: one `<maskmap name="ParentField" [xor="0x..."]>` block. Resolves the
/// parent field's bit-source at parse time (via [`SiblingLookup`]) so the
/// emitter doesn't have to thread enum/primitive disambiguation through the
/// codegen path again. Every gated field's snake-name + type lives inside
/// the [`MaskGroup`] entries; the struct emitter walks them to emit
/// `Option<T>` declarations and the read emitter wraps each in the
/// corresponding `if (bits & mask) != 0 { … }` block.
struct MaskmapBlock {
    /// The parent field's snake-name as it appears in `read_from`'s local
    /// scope (e.g. `flags`, `header`).
    parent_snake: String,
    /// The Rust expression that produces the raw u32-shaped bits from the
    /// parent's stored local. For a primitive `uint` field: just `flags`.
    /// For a flag enum: we read the raw u32 BEFORE the variant-match (see
    /// the codegen path that emits a `<snake>_raw` companion). Width-cast
    /// fits in u64 to accommodate ulong-backed flags should they appear.
    parent_bits_rust: String,
    /// Optional `xor=` modifier from `<maskmap xor="0x...">`. When present,
    /// the maskmap iterates entries whose corresponding bits in
    /// `parent_bits ^ xor` are SET (effectively flipping the polarity for the
    /// xor'd bits). Only one schema site uses this (`PositionPack`'s WQuat
    /// suite where the absence of a bit indicates the field is present).
    xor_mask: Option<u64>,
    /// All `<mask value="...">` groups in XML declaration order.
    masks: Vec<MaskGroup>,
}

/// J3.C: one `<mask value="...">` group inside a `<maskmap>`. Each group
/// gates one OR MORE fields on the same bit; when the gate fires, all of
/// the contained fields are read in order. Multi-field groups appear in
/// `PhysicsDesc` (ParentId + ParentLocation), `CreatureAppraisalProfile`
/// (attribute suite + Stamina/Mana family), `Item_SetAppraiseInfo` (5 group
/// triples across armor/weapon/resist highlight masks + the BaseArmorXxx
/// 9-tuple), and `PlayerModule` (Unknown100_1 + OptionStrings on bit 0x100).
struct MaskGroup {
    /// The numeric bit value the gate compares against (`bits & value != 0`
    /// after applying any `xor_mask`). Widened to u64 to fit the rare ulong
    /// flag enum (none today; defensive).
    bit_value: u64,
    /// Verbatim XML `value=` attribute for the doc-comment.
    value_xml: String,
    /// The gated fields. Each becomes one `Option<T>` on the struct.
    fields: Vec<SimpleField>,
    /// J3.E: gated `<field type="PackableList"/PackableHashTable/PHashTable">`
    /// inlined as Vec<T> / Vec<(K, V)>. Each becomes one
    /// `Option<Vec<…>>` on the struct. Separated from `fields` (which holds
    /// only SimpleField) so the codegen can route to the right read path.
    packables: Vec<PackableField>,
    /// Optional doc text from the `<mask text="…">` attribute.
    /// Reserved for future use (per-mask doc comments above the gated
    /// Option block); we currently inline a per-field doc-comment derived
    /// from each field's own `text=`.
    #[allow(dead_code)]
    text: Option<String>,
}

/// J3.D: one `<switch name="DiscField">` block. We resolve the discriminator
/// against `SiblingLookup` so the emitter doesn't have to re-thread enum
/// vs primitive disambiguation; every case's body is a pre-built sequence of
/// nested `EmitStep`s (mirroring how `<maskmap>` flattens its mask groups).
///
/// The struct emitter writes one Rust enum + one struct field per switch;
/// the read emitter writes a `match disc_local { … }` dispatch where each
/// arm decodes the case's payload then assigns the typed enum variant.
struct SwitchBlock {
    /// Emitted enum type name, e.g. `MovementDataMovementTypeData`. Used both
    /// as the struct field's type AND as the variant-construction prefix
    /// (`<enum_name>::Case_0000 { … }`).
    enum_name: String,
    /// Struct field snake-name carrying the variant — usually
    /// `<disc_snake>_data` (e.g. `movement_type_data`).
    field_snake: String,
    /// Discriminator local-variable name in `read_from`'s scope. For enum-
    /// typed discs we read the `_bits` companion; the codegen handles
    /// the suffix at emit time.
    disc_snake: String,
    /// Discriminator's underlying numeric repr (`u32`, `u16`, `i32`, `u8`)
    /// — the match scrutinee is cast to `i128` for the actual comparison so
    /// negative literals like `PwdType=-1` work uniformly. Currently
    /// recorded for documentation + future precision-aware widening; the
    /// codegen path widens unconditionally so the repr isn't read at emit
    /// time. Kept on the struct so future code can preserve original-width
    /// semantics if it ever matters (e.g. catching impossible-by-width
    /// case values at codegen time).
    #[allow(dead_code)]
    disc_repr: String,
    /// What kind of field the discriminator is — drives `_bits` vs bare
    /// snake-name selection in the `match` scrutinee expression.
    disc_kind: DiscriminatorKind,
    /// Verbatim XML name of the discriminator field for doc-comments.
    disc_xml_name: String,
    /// All cases in XML declaration order. Used both for variant emission
    /// (enum body) and for the dispatch arms (read_from match).
    cases: Vec<SwitchCase>,
}

/// J3.D: how the discriminator field surfaces in `read_from`'s local scope.
/// Primitive fields land as a bare `<snake>` local. Enum-typed fields land
/// as a typed `<snake>` plus a `<snake>_bits` companion (emitted by
/// `emit_read_field`'s enum branch); we read the bits for the dispatch.
#[derive(Clone, Copy, Debug)]
enum DiscriminatorKind {
    Primitive,
    Enum,
}

/// J3.D: one `<case value="V | W | …">` group inside a `<switch>`. The
/// `steps` field holds the pre-built body of the case — each EmitStep
/// gets re-emitted via the same `emit_*` functions used at the top level
/// (so nested switches, vectors, maskmaps, etc. all just work).
struct SwitchCase {
    /// Canonical variant identifier — `Case_<hex>` for single, joined by
    /// underscore for multi-value. Always a valid Rust ident (no leading
    /// digit; we prefix `Case_`).
    variant_id: String,
    /// Verbatim XML `value=` attribute for doc-comments.
    value_xml: String,
    /// Parsed numeric values (signed i128 to fit `-1`-style PwdType cases).
    /// Length ≥ 1; multi-value cases hold all the pipe-split tokens.
    values: Vec<i128>,
    /// Optional `<case text="...">` doc-comment text.
    text: Option<String>,
    /// Body steps in XML order. Empty for "no payload" cases (none in the
    /// current schema, but supported defensively).
    steps: Vec<EmitStep>,
}

/// J3.D: one `<table name="X" key="K" value="V" length="LenExpr" />` block.
/// Equivalent to a `Dictionary<K,V>` whose entry count comes from a
/// sibling-resolved length expression. We model the Rust shape as a
/// `BTreeMap<K, V>` over the resolved key + value types; entries are
/// decoded by reading K then V at each iteration. Templated `T`/`U`
/// markers are routed away with a precise J3.E SKIP reason at the
/// `build_table_field` gate, so this struct only ever holds concrete
/// resolvable types.
struct TableField {
    name_snake: String,
    key_rust_ty: String,
    key_kind: FieldKind,
    value_rust_ty: String,
    value_kind: FieldKind,
    length_expr_rust: String,
    length_xml: String,
    text: Option<String>,
}

/// J3.E: one `<if test="EXPR">` block. The `test_rust` is the already-
/// translated boolean Rust expression that reads from sibling locals; the
/// `true_steps` (and optional `false_steps`) are the body steps. All gated
/// fields surface as `Option<T>` on the struct.
struct IfBlock {
    /// Verbatim XML `test=` attribute for the doc-comment.
    test_xml: String,
    /// Rust boolean expression that evaluates to `true` when the truthy
    /// branch should fire. References sibling local-variable names (NOT
    /// `self.*` — we're inside `read_from` before any struct construction).
    test_rust: String,
    /// True-branch body steps. Decoded if `test_rust` is true. Empty if the
    /// XML has no `<true>` child (none in retail, but supported defensively).
    true_steps: Vec<EmitStep>,
    /// False-branch body steps. Decoded if `test_rust` is false. Empty for
    /// the 5 retail sites without a `<false>` child; populated for
    /// `AllegianceData` (Flags == 0x4 → ulong TimeOnline else uint TimeOnline
    /// + uint AllegianceAge). The seen-names uniquifier auto-disambiguates
    /// when both branches declare a field with the same XML name (collision
    /// surfaces as `_2`-suffixed snake-name on the second occurrence).
    false_steps: Vec<EmitStep>,
    /// Optional doc text from the `<if text="…">` attribute.
    text: Option<String>,
}

/// J3.E: one inlined PackableList/PackableHashTable/PHashTable use-site.
/// Three wire shapes, three Rust shapes:
///
/// - `List`: `Vec<T>`. Wire = u32 count + N×T.
/// - `HashTable`: `Vec<(K, V)>`. Wire = u16 count + u16 maxsize + N×(K,V).
///   Vec-of-tuples (not `BTreeMap`) preserves insertion order AND avoids the
///   K: Ord requirement (struct keys like `LayeredSpellId` have no Ord).
/// - `PHashTable`: `Vec<(K, V)>`. Wire = u32 packed + N×(K,V) where the
///   packed u32 encodes count in the low 24 bits + buckets in the top 8.
struct PackableField {
    name_snake: String,
    kind: PackableKind,
    /// For HashTable/PHashTable: key element. For List: ignored.
    key_rust_ty: String,
    key_kind: FieldKind,
    /// For HashTable/PHashTable: value element. For List: this holds the
    /// list element type.
    value_rust_ty: String,
    value_kind: FieldKind,
    text: Option<String>,
}

/// J3.E: wire-shape discriminator for PackableField. The three variants
/// correspond 1:1 to the three templated `<type>` declarations.
#[derive(Clone, Copy, Debug)]
enum PackableKind {
    /// `<type name="PackableList" parent="List" templated="T">` — wire
    /// = u32 count + N×T → Rust = `Vec<T>`.
    List,
    /// `<type name="PackableHashTable" parent="Dictionary" templated="T,U">`
    /// — wire = u16 count + u16 maxsize + N×(K,V) → Rust = `Vec<(K, V)>`.
    HashTable,
    /// `<type name="PHashTable" parent="Dictionary" templated="T,U">` —
    /// wire = u32 packed + N×(K,V) where count = packed & 0xFFFFFF → Rust =
    /// `Vec<(K, V)>`.
    PHashTable,
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
    /// J3.D: verbatim XML `name=` attribute (e.g. `Key_a`, `PwdType`,
    /// `MovementType`). Used by `SiblingLookup` to register the field under
    /// the EXACT name that `<switch name="…">` / `<vector length="…">` /
    /// `<maskmap name="…">` reference it by — the `snake_to_pascal` round
    /// trip is lossy for underscored names like `Key_a` and would mis-key
    /// the lookup table.
    xml_name: String,
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
    /// J3.D: verbatim XML `name=` attribute, same rationale as
    /// `SimpleField::xml_name`. `<vector length="BodySize">` references
    /// subfields by their XML name; the snake→pascal round-trip mangles
    /// underscored names (`Body_Size` → `BodySize` ≠ original).
    xml_name: String,
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
    /// `Enum(name, repr, is_flag)`. `is_flag` controls the read codegen's
    /// unknown-discriminant policy — flag enums (`mask="true"`) preserve the
    /// raw bits without erroring, regular enums error on unknown values.
    Enum(String, EnumRepr, bool),
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
        FieldKind::Enum(name, repr, _is_flag) => {
            // J3.C: capture the raw underlying-repr value into a `<snake>_bits`
            // companion local alongside the typed variant match. Flag enums
            // (`mask="true"`) are routed to raw-primitive storage UPSTREAM in
            // `resolve_field` — so reaching this branch implies a strict
            // single-discriminant enum, and unknowns are a wire error worth
            // surfacing. The `_bits` companion is still emitted so siblings
            // (e.g. inside `<switch>`) can grab the raw representation when
            // needed — same access pattern across both strict and flag enums.
            let repr_ty = repr.rust_ty();
            writeln!(buf, "        let {snake}_raw = {name}::read_from(data, offset)?;").unwrap();
            writeln!(buf, "        let {snake}_bits: {repr_ty} = match {snake}_raw {{ Ok(v) => v as {repr_ty}, Err(raw) => raw }};").unwrap();
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
    // J3.E: capital-`String` is the C# convention from the schema —
    // `Fellowship.Locks` uses `genericKey="String"`. Alias to the same
    // length-prefixed UTF-8 wire format.
    ("String", "String"),
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
    //
    // J3.C (2026-05-27): `<maskmap name="...">` is now FOUNDATION-tier when:
    //   - the parent field resolves to a numeric primitive or a `parent="uint"`
    //     enum (flag enums are the common case);
    //   - every `<mask value="...">` is a hex literal or a dotted
    //     `EnumName.VariantName` whose enum was already emitted;
    //   - no `xor=` modifier (only PositionPack uses one — SKIP'd with a
    //     precise reason pointing at J3.F follow-on);
    //   - every gated field resolves through `resolve_field`.
    // Per-maskmap resolution lives in `collect_emit_steps`; this top-level
    // pass never returns "maskmap" anymore. Bare `<mask>` outside a
    // `<maskmap>` would be a schema bug; we still flag it for completeness.
    //
    // J3.D (2026-05-27): `<switch name="DiscField">` is now FOUNDATION-tier
    // when the discriminator resolves to a numeric primitive or an enum-typed
    // sibling field declared BEFORE the `<switch>`, and every case-body child
    // (`<field>`, `<vector>`, nested `<switch>`, `<maskmap>`, `<align>`) is in
    // turn supported. Per-switch resolution lives in `collect_emit_steps`; the
    // top-level pass never returns "switch" anymore — failures are reported
    // with a precise per-case reason. `<table name="X" key="K" value="V" length="LenExpr">`
    // is also FOUNDATION-tier when K and V are concrete (non-templated)
    // resolvable types. Templated `T,U`-typed tables defer cleanly to J3.E.
    //
    // J3.E (2026-05-27): `<if test="...">` is now FOUNDATION-tier — boolean
    // expressions over sibling fields (six retail sites: SpellBookPage,
    // Enchantment, PageData, AllegianceHierarchy, AllegianceData, ObjDesc).
    // Per-if resolution lives in `collect_emit_steps`; this top-level pass
    // never returns "if" anymore — failures are reported with a precise
    // reason. The 6 retail tests are comparisons (`X < N`, `X > 0`, `X == V`,
    // bare `X` bool); the C# expression translator handles all of them after
    // a small extension for the `<`/`>`/`==` operators (see
    // `translate_if_test_expr`).
    //
    // J3.E (2026-05-27): templated types (PackableList/PackableHashTable/
    // PHashTable) are inlined at the use-site by `build_packable_field` —
    // detected by `<field type="PackableList" genericType="...">` (or
    // PackableHashTable/PHashTable with genericKey+genericValue). The
    // `<type templated=...>` declarations themselves SKIP cleanly with a
    // "inlined at use-site" reason since they have no concrete struct shape.
    let mut out = Vec::new();
    for c in n.children().filter(|c| c.is_element()) {
        match c.tag_name().name() {
            "mask" => push_unique(&mut out, "mask"),
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
#[derive(Default, Clone)]
struct SiblingLookup {
    /// `xml_name → (snake_name, rust_repr)` for direct sibling fields. The
    /// `rust_repr` is the Rust primitive width (`u8`/`u16`/…); used so the
    /// length expression can cast cleanly to `usize` (Rust `as` requires the
    /// LHS to be a numeric primitive, not an enum/struct).
    ///
    /// J3.C: flag enums (`mask="true"`) flow through `resolve_field` as
    /// primitives (the enum's `parent="uint"` repr replaces the typed
    /// variant on the struct field) — so they automatically show up here
    /// with the correct width and the maskmap codegen needs no extra
    /// flag-enum bookkeeping to resolve a `<maskmap name="Header">`-style
    /// parent reference.
    fields_by_xml_name: BTreeMap<String, (String, String)>,
    /// `xml_name → (parent_xml_name, parent_snake_name, parent_rust_repr, value_expr)`
    /// for subfields hanging off any sibling. The subfield's value expression
    /// references the parent by its XML name; we rewrite to the parent's
    /// snake-name local variable when substituting into the vector length.
    subfields_by_xml_name: BTreeMap<String, SubfieldRef>,
    /// J3.D: enum-typed sibling fields so `<switch name="Foo">` can resolve a
    /// `Foo` field whose Rust-side type is a strict enum (not downgraded to
    /// its raw repr). The codegen emits a `<snake>_bits` companion local
    /// alongside the typed value (see `emit_read_field`'s Enum branch); the
    /// switch dispatch reads the `_bits` so unknown discriminants surface as
    /// the typed-enum `read_from` already-emitted error rather than racing
    /// the match scrutinee.
    enum_fields_by_xml_name: BTreeMap<String, EnumFieldRef>,
    /// J3.E: sibling fields whose Rust-side type is `WireBool` (4-byte bool).
    /// Used by `<if test="X">` to emit a bare-identifier truthy check on the
    /// sibling local without an extra `!= 0` cast. The single retail site is
    /// `PageData`'s `TextIncluded` (line 5871).
    bool_fields_by_xml_name: BTreeSet<String>,
    /// J3.E: gated maskmap fields — siblings that live inside a previous
    /// `<maskmap>` block. They surface as `Option<T>` on the struct, and as
    /// `Option<T>` locals in `read_from`. When a LATER `<maskmap>` names one
    /// as its parent (e.g. PublicWeenieDesc's second `<maskmap name="Header2">`
    /// where Header2 is gated by the first maskmap), we resolve it via
    /// `option_<snake>.unwrap_or(0) as u64` — bits are 0 (no fields fire) if
    /// the parent maskmap didn't materialise the field.
    gated_fields_by_xml_name: BTreeMap<String, GatedFieldRef>,
}

/// J3.E: bookkeeping for a maskmap-gated field referenced as a later
/// maskmap's parent. The local in `read_from` is an `Option<T>`; we
/// resolve it via `.unwrap_or_default() as <bits_repr>` so a `None` gates
/// every later mask `OFF` uniformly.
#[derive(Clone)]
struct GatedFieldRef {
    snake: String,
    /// The underlying bit-repr (`u32`/`u16`/`u64`) — pulls flag enums down
    /// to their raw repr via the same flag-enum path used by
    /// `numeric_repr_for_field_kind`. Reserved for future width-aware bit
    /// math; currently the codegen widens unconditionally to u64.
    #[allow(dead_code)]
    rust_repr: String,
}

/// J3.D: bookkeeping for an enum-typed sibling field. Its decode emits two
/// locals — the typed value `<snake>` and the raw `<snake>_bits` companion;
/// the switch dispatch references the bits local to compare against the case
/// values uniformly across all enum reprs.
#[derive(Clone)]
struct EnumFieldRef {
    snake: String,
    /// Width-narrowed rust repr (`u32`/`u16`/`u8`/`i32`/`u64`/`i64`). The
    /// match scrutinee casts up to `i128` so signed cases like PwdType=-1
    /// compose with unsigned reprs.
    rust_repr: String,
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
        //
        // J3.C: flag enums (`mask="true"`) are routed through
        // `resolve_field` to raw-primitive storage upstream, so they appear
        // here as `FieldKind::PrimU32`/`PrimU16`/etc and flow through the
        // numeric path automatically. The XML name is preserved (capitalised
        // from snake), so `<maskmap name="Header">` finds the underlying
        // `header: u32` local without any flag-enum-specific bookkeeping.
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
        // J3.D: also register strict-enum-typed fields (those that landed as
        // `FieldKind::Enum(...)`) so a `<switch name="Foo">` over a sibling
        // enum `Foo` can resolve to the `<snake>_bits` companion local emitted
        // by `emit_read_field`'s enum branch. Flag enums (`mask="true"`) flow
        // through the primitive path above (they're downgraded to raw bits in
        // `resolve_field`), so they're already in `fields_by_xml_name`.
        if let FieldKind::Enum(_name, repr, _is_flag) = &f.field_kind {
            self.enum_fields_by_xml_name.insert(
                xml_name.clone(),
                EnumFieldRef {
                    snake: f.name_snake.clone(),
                    rust_repr: repr.rust_ty().to_string(),
                },
            );
        }
        // J3.E: track bool-typed fields so `<if test="X">` can emit a
        // bare-identifier truthy check on the WireBool local. Only `Bool4Byte`
        // (the 4-byte wire bool, the only bool flavour) qualifies.
        if matches!(f.field_kind, FieldKind::Bool4Byte) {
            self.bool_fields_by_xml_name.insert(xml_name);
        }
    }

    /// J3.E: register a Packable field as a sibling so subsequent fields can
    /// reference it (currently unused — no retail site has a `<vector>` or
    /// `<if>` reference a PackableList/PackableHashTable count). Defensive
    /// registration mirrors `add_field`: only the verbatim XML name is
    /// stored (with a sentinel Rust repr `Vec<…>`), and the type isn't
    /// usable as a numeric sibling.
    fn add_packable(&mut self, _pf: &PackableField) {
        // No-op: PackableField has no numeric width that vector-length or
        // maskmap-parent can reference. The registration would only matter
        // if a future schema added a `<vector length="PackableListCount">`
        // shape, which doesn't currently exist.
    }

    /// J3.E: register every numeric-eligible field gated by a `<maskmap>`'s
    /// `<mask>` body. These surface in `read_from` as `Option<T>` locals;
    /// when a LATER `<maskmap>` references one as its parent (PublicWeenieDesc:
    /// the second `<maskmap name="Header2">` after Header2 was gated by the
    /// first maskmap), `resolve_maskmap_parent_bits` looks here and emits
    /// `<snake>.unwrap_or_default() as u64`.
    fn add_maskmap_gated(&mut self, mm: &MaskmapBlock) {
        for group in &mm.masks {
            for gated in &group.fields {
                // Same width-detection path as `add_field`. Flag enums
                // resolve through their parent="uint" repr (already in
                // FieldKind::PrimU32 etc.); strict enums skip.
                if let Some(repr) = numeric_repr_for_field_kind(&gated.field_kind) {
                    self.gated_fields_by_xml_name.insert(
                        gated.xml_name.clone(),
                        GatedFieldRef {
                            snake: gated.name_snake.clone(),
                            rust_repr: repr.to_string(),
                        },
                    );
                }
            }
        }
    }
}

fn xml_name_for_field(f: &SimpleField) -> String {
    // J3.D: read the stored XML name verbatim. Previously we'd reconstruct
    // it via `snake_to_pascal(&f.name_snake)`, which is lossy for underscored
    // names like `Key_a` (round-trips to `KeyA`). The verbatim store is the
    // only correct path; the snake-to-pascal heuristic is gone.
    f.xml_name.clone()
}

fn xml_name_for_subfield(sf: &SubfieldAccessor) -> String {
    // J3.D: same as `xml_name_for_field`. Subfields like `BodySize` are
    // round-trip-clean today, but the verbatim store removes a class of
    // future-revision lookup bugs.
    sf.xml_name.clone()
}

/// J3.D: convert a verbatim XML name into a PascalCase identifier safe for
/// Rust type names. Strips underscores + uppercases the next char after each
/// boundary. `Key_a` → `KeyA`; `BlobDispatchType` → `BlobDispatchType` (no
/// change); `PwdType` → `PwdType` (no change). Used for synthesising enum
/// names like `<Parent><Disc>Data` where Disc comes from the XML.
fn pascalize_xml_name(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut cap_next = true;
    for ch in s.chars() {
        if ch == '_' {
            cap_next = true;
            continue;
        }
        if cap_next {
            out.extend(ch.to_uppercase());
            cap_next = false;
        } else {
            out.push(ch);
        }
    }
    out
}

/// Convert `snake_case_id` → `SnakeCaseId`. Mirrors `to_snake_case`'s inverse
/// for the subset of names we care about (single-word + underscore-joined
/// PascalCase round-trips cleanly). Words after the first are capitalised.
/// Kept around for future use even though J3.D switched its callers to
/// `pascalize_xml_name` (which is the correct direction for XML→Pascal).
#[allow(dead_code)]
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
        // J3.E: float + bool registered so `<if test="X cmp N">` can resolve
        // the LHS sibling. They're not valid as vector-length or maskmap-
        // parent sources — `translate_vector_length_expr` operates on the
        // sibling-lookup but the retail schema never wires a float into a
        // length/parent slot, so the wider net is safe.
        FieldKind::PrimF32 => Some("f32"),
        FieldKind::PrimF64 => Some("f64"),
        FieldKind::Bool4Byte => Some("bool"),
        _ => None,
    }
}

/// J3.C: produce the Rust expression for the raw bit-pattern of a maskmap's
/// parent field. The parent must already exist as a sibling — either a true
/// numeric primitive field, or a flag-enum-typed field that was downgraded
/// to its underlying repr by `resolve_field`'s flag-enum branch. Both paths
/// land here as a numeric snake-name local in `read_from`'s scope.
fn resolve_maskmap_parent_bits(
    parent_xml_name: &str,
    siblings: &SiblingLookup,
    _type_kind: &HashMap<String, TypeKind>,
) -> Result<String, String> {
    if let Some((snake, repr)) = siblings.fields_by_xml_name.get(parent_xml_name) {
        // Numeric primitive parent — cast to u64 so all downstream bit math
        // is uniform-width regardless of the source's 8/16/32-bit footprint.
        let _ = repr;
        return Ok(format!("{snake} as u64"));
    }
    // J3.D: strict-enum siblings expose their raw bits via the `_bits`
    // companion local emitted by `emit_read_field`'s enum branch. Maskmap
    // codegen reads those bits directly so unknown discriminants don't
    // accidentally fail the maskmap gate (the enum field itself would have
    // already errored at decode time on unknown bits — but this path is
    // for the case where the parent is a non-flag enum being treated as a
    // bit field, e.g. MovementData.OptionFlags which is `MovementOption`).
    if let Some(ef) = siblings.enum_fields_by_xml_name.get(parent_xml_name) {
        return Ok(format!("{}_bits as u64", ef.snake));
    }
    // J3.E: parent is itself a maskmap-gated field (Option<T>). Resolves
    // to 0 when the parent maskmap didn't materialise it — so every later
    // maskmap on this parent fires NO gates (matches the wire semantics:
    // if Header2's bit was clear, no Header2-derived fields are on the
    // wire). PublicWeenieDesc is the only retail site.
    if let Some(gf) = siblings.gated_fields_by_xml_name.get(parent_xml_name) {
        return Ok(format!("{}.map_or(0u64, |v| v as u64)", gf.snake));
    }
    Err(format!(
        "parent {parent_xml_name:?} is not a sibling numeric field — maskmap parents must be declared before the <maskmap> in the same <type> body"
    ))
}

fn resolve_maskmap_parent_snake(
    parent_xml_name: &str,
    siblings: &SiblingLookup,
) -> Option<String> {
    if let Some((snake, _)) = siblings.fields_by_xml_name.get(parent_xml_name) {
        return Some(snake.clone());
    }
    if let Some(ef) = siblings.enum_fields_by_xml_name.get(parent_xml_name) {
        return Some(ef.snake.clone());
    }
    if let Some(gf) = siblings.gated_fields_by_xml_name.get(parent_xml_name) {
        return Some(gf.snake.clone());
    }
    None
}

/// J3.C: parse a `<mask value="...">` attribute. Two recognised forms:
///   - Hex literal: `0x80000000`, `0x4`, `0x0000_0001`
///   - Dotted enum reference: `ACBaseQualitiesFlags.PropertyInt` resolves via
///     the previously-emitted enum's variant table.
fn parse_mask_value(
    raw: &str,
    enum_values: &HashMap<String, BTreeMap<String, i128>>,
) -> Result<u64, String> {
    let trimmed = raw.trim();
    if let Some(parsed) = parse_int_literal(trimmed) {
        // i128 → u64 truncation is fine for the schema's 32-bit-flag range
        // (and the rare 64-bit flag — we widened to u64 deliberately).
        return Ok(parsed as u64);
    }
    if let Some((enum_name, variant_name)) = trimmed.split_once('.') {
        let table = enum_values
            .get(enum_name)
            .ok_or_else(|| format!("enum {enum_name:?} not emitted before this <mask> reference (forward reference?)"))?;
        let v = table.get(variant_name).ok_or_else(|| {
            format!("enum {enum_name:?} has no variant named {variant_name:?}")
        })?;
        return Ok(*v as u64);
    }
    Err(format!(
        "mask value {raw:?} is neither a hex literal nor an `EnumName.VariantName` dotted reference"
    ))
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

/// J3.C: emit the bit-gated read sequence for a `<maskmap name="ParentField"
/// [xor=]>` block. Each `<mask value="...">` group becomes an `if (parent_bits
/// [^xor] & bit) != 0 { … } else { … }` chain that either reads + assigns
/// `Some(value)` to the gated locals, or leaves them as `None`.
///
/// Each gated field is also pre-declared as `let mut <snake>: Option<T> = None;`
/// at the head of the maskmap block, so the `Ok(Self { ... })` construction
/// can refer to the variable unconditionally regardless of whether the bit
/// fired.
fn emit_read_maskmap(buf: &mut String, mm: &MaskmapBlock) {
    let parent_bits = &mm.parent_bits_rust;
    let parent_snake = &mm.parent_snake;
    // Compute `effective_bits` once per maskmap. xor= adjusts polarity:
    //   no xor: gate = (bits & mask) != 0
    //   xor=X:  gate = ((bits ^ X) & mask) != 0
    // PositionPack is the only schema site using xor (line 6471, Flags^0x78).
    writeln!(buf, "        // <maskmap name=\"{parent_snake}\">").unwrap();
    if let Some(xor) = mm.xor_mask {
        writeln!(buf, "        let __mm_bits: u64 = {parent_bits} ^ 0x{xor:X}u64; // xor=0x{xor:X}").unwrap();
    } else {
        writeln!(buf, "        let __mm_bits: u64 = {parent_bits};").unwrap();
    }
    // Pre-declare every gated Option<T> as `None`. The if-block then
    // re-binds via shadowing inside the gated scope so the assigned local
    // is reachable in `Ok(Self { ... })`.
    for group in &mm.masks {
        for gated in &group.fields {
            writeln!(buf, "        let mut {snake}: Option<{ty}> = None;",
                snake = gated.name_snake, ty = gated.rust_ty).unwrap();
        }
        for pf in &group.packables {
            let ty = packable_rust_ty(pf);
            writeln!(buf, "        let mut {snake}: Option<{ty}> = None;",
                snake = pf.name_snake).unwrap();
        }
    }
    for group in &mm.masks {
        let mask = group.bit_value;
        let label = if group.value_xml.contains('.') {
            group.value_xml.replace('\"', "")
        } else {
            format!("0x{:X}", mask)
        };
        writeln!(buf, "        // <mask value=\"{}\">", escape_xml_attr_for_doc(&group.value_xml)).unwrap();
        writeln!(buf, "        if (__mm_bits & 0x{mask:X}u64) != 0 {{").unwrap();
        // Decode each gated field into a `_v`-suffixed local then assign that
        // into the outer Option. We can't reuse the gated snake name as both
        // the Option binding (`let mut x: Option<T> = None`) and the decoded
        // value (`let x: T = …`) because the inner shadow would type-error on
        // `x = Some(x)`. The `_v` suffix is internal to the gated scope.
        for gated in &group.fields {
            let tmp_name = format!("{}_v", gated.name_snake);
            emit_read_field_indented(buf, &tmp_name, &gated.field_kind, "            ");
        }
        for gated in &group.fields {
            writeln!(buf, "            {snake} = Some({snake}_v);", snake = gated.name_snake).unwrap();
        }
        // J3.E: gated Packable inline-decoded into `<snake>_v` then
        // assigned. We rename the PackableField to use a `_v`-suffixed
        // snake locally so the existing `emit_read_packable` doesn't need
        // to know about Option-wrapping.
        for pf in &group.packables {
            let mut tmp = PackableField {
                name_snake: format!("{}_v", pf.name_snake),
                kind: pf.kind,
                key_rust_ty: pf.key_rust_ty.clone(),
                key_kind: pf.key_kind.clone(),
                value_rust_ty: pf.value_rust_ty.clone(),
                value_kind: pf.value_kind.clone(),
                text: pf.text.clone(),
            };
            emit_read_packable(buf, &tmp, "            ");
            let _ = &mut tmp;
            writeln!(buf, "            {snake} = Some({snake}_v);", snake = pf.name_snake).unwrap();
        }
        writeln!(buf, "        }} // end mask {label}").unwrap();
    }
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

/// J3.D: re-indent a multi-line emitted block to a custom indent. The
/// generated lines from `emit_read_*` use a fixed 8-space leading indent for
/// the read body, 12-space for nested blocks; we strip that and replace with
/// the caller-supplied prefix.
fn reindent_block(buf: &mut String, body: &str, indent: &str) {
    for line in body.lines() {
        let stripped = line.trim_start_matches(' ');
        if stripped.is_empty() {
            writeln!(buf).unwrap();
        } else {
            writeln!(buf, "{indent}{stripped}").unwrap();
        }
    }
}

/// J3.D: emit an indented version of `emit_align_pad`.
fn emit_align_pad_indented(buf: &mut String, n_bytes: usize, indent: &str) {
    let mut tmp = String::new();
    emit_align_pad(&mut tmp, n_bytes);
    reindent_block(buf, &tmp, indent);
}

/// J3.D: emit an indented version of `emit_read_vector`.
fn emit_read_vector_indented(buf: &mut String, v: &VectorField, indent: &str) {
    let mut tmp = String::new();
    emit_read_vector(&mut tmp, v);
    reindent_block(buf, &tmp, indent);
}

/// J3.D: emit an indented version of `emit_read_maskmap`.
fn emit_read_maskmap_indented(buf: &mut String, mm: &MaskmapBlock, indent: &str) {
    let mut tmp = String::new();
    emit_read_maskmap(&mut tmp, mm);
    reindent_block(buf, &tmp, indent);
}

/// J3.D: emit an indented version of `emit_read_table`.
fn emit_read_table_indented(buf: &mut String, tb: &TableField, indent: &str) {
    let mut tmp = String::new();
    emit_read_table(&mut tmp, tb, "        ");
    reindent_block(buf, &tmp, indent);
}

/// J3.D: emit the read for one step inside an indented context (switch case
/// body). Routes through the existing emit_* helpers via reindent_block.
fn emit_step_indented(buf: &mut String, step: &EmitStep, indent: &str) {
    match step {
        EmitStep::Field(f) => emit_read_field_indented(buf, &f.name_snake, &f.field_kind, indent),
        EmitStep::Align(n) => emit_align_pad_indented(buf, *n, indent),
        EmitStep::Vector(v) => emit_read_vector_indented(buf, v, indent),
        EmitStep::Maskmap(mm) => emit_read_maskmap_indented(buf, mm, indent),
        EmitStep::Switch(sw) => emit_read_switch(buf, sw, indent),
        EmitStep::Table(tb) => emit_read_table_indented(buf, tb, indent),
        EmitStep::If(ifb) => emit_read_if(buf, ifb, indent),
        EmitStep::Packable(pf) => emit_read_packable(buf, pf, indent),
    }
}

/// J3.D: write an enum type definition for a `<switch>` block (recursively
/// for any nested switches inside its case bodies). The enum's variant set
/// mirrors the case set; each variant carries the case's struct-like fields
/// as named anonymous-struct payload (`Case_X { field_a: T, field_b: U }`)
/// or no payload (`Case_X`) for empty cases.
///
/// Nested switches inside a case body get their own enum emitted in a
/// post-order walk (innermost first) so the outer enum's variant fields can
/// reference them by name.
fn emit_switch_enum_recursive(buf: &mut String, step: &EmitStep) {
    match step {
        EmitStep::Switch(sw) => {
            // Recurse into case bodies first — innermost nested switches
            // emit before outer ones, mirroring the type-dependency direction.
            for case in &sw.cases {
                for inner in &case.steps {
                    emit_switch_enum_recursive(buf, inner);
                }
            }
            // Emit the enum.
            writeln!(buf, "/// `<switch name=\"{}\">` discriminated union (one variant per case).",
                escape_xml_attr_for_doc(&sw.disc_xml_name)).unwrap();
            writeln!(buf, "#[derive(Debug, Clone, PartialEq)]").unwrap();
            writeln!(buf, "pub enum {} {{", sw.enum_name).unwrap();
            for case in &sw.cases {
                if let Some(t) = &case.text {
                    writeln!(buf, "    /// case value=\"{}\". {}",
                        escape_xml_attr_for_doc(&case.value_xml),
                        escape_doc(t)).unwrap();
                } else {
                    writeln!(buf, "    /// case value=\"{}\".",
                        escape_xml_attr_for_doc(&case.value_xml)).unwrap();
                }
                let payload = collect_case_payload_fields(&case.steps);
                if payload.is_empty() {
                    writeln!(buf, "    {},", case.variant_id).unwrap();
                } else {
                    writeln!(buf, "    {} {{", case.variant_id).unwrap();
                    for (fname, fty) in &payload {
                        writeln!(buf, "        {fname}: {fty},").unwrap();
                    }
                    writeln!(buf, "    }},").unwrap();
                }
            }
            writeln!(buf, "}}\n").unwrap();
        }
        EmitStep::If(ifb) => {
            // Defensive recursion in case a future schema places a switch
            // inside an <if> branch — the retail 6 if-sites are all
            // field-only.
            for inner in ifb.true_steps.iter().chain(ifb.false_steps.iter()) {
                emit_switch_enum_recursive(buf, inner);
            }
        }
        // Nested switches can also appear inside maskmap gated fields (none
        // in the current schema, but the schema permits it via the same
        // tree-walk path). Maskmap recursion would need its own walk; we
        // skip here because maskmap's <mask> children are ONLY <field>
        // (enforced at parse time in `build_maskmap_block`).
        _ => {}
    }
}

/// J3.D: collect the (struct_field_name, rust_type) pairs that one switch
/// case's `Vec<EmitStep>` body produces. Mirrors the order
/// `collect_step_locals` uses so the brace-init at the end of the case arm
/// type-checks against the enum variant.
fn collect_case_payload_fields(steps: &[EmitStep]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for step in steps {
        match step {
            EmitStep::Field(f) => out.push((f.name_snake.clone(), f.rust_ty.clone())),
            EmitStep::Vector(v) => out.push((
                v.name_snake.clone(),
                format!("Vec<{}>", v.element_rust_ty),
            )),
            EmitStep::Maskmap(mm) => {
                for g in &mm.masks {
                    for gated in &g.fields {
                        out.push((
                            gated.name_snake.clone(),
                            format!("Option<{}>", gated.rust_ty),
                        ));
                    }
                    for pf in &g.packables {
                        out.push((
                            pf.name_snake.clone(),
                            format!("Option<{}>", packable_rust_ty(pf)),
                        ));
                    }
                }
            }
            EmitStep::Switch(inner) => out.push((
                inner.field_snake.clone(),
                inner.enum_name.clone(),
            )),
            EmitStep::Table(tb) => out.push((
                tb.name_snake.clone(),
                format!(
                    "std::collections::BTreeMap<{}, {}>",
                    tb.key_rust_ty, tb.value_rust_ty
                ),
            )),
            EmitStep::If(ifb) => {
                let mut seen: BTreeSet<String> = BTreeSet::new();
                for (snake, ty) in collect_if_payload_locals(&ifb.true_steps)
                    .into_iter()
                    .chain(collect_if_payload_locals(&ifb.false_steps).into_iter())
                {
                    if seen.insert(snake.clone()) {
                        out.push((snake, format!("Option<{ty}>")));
                    }
                }
            }
            EmitStep::Packable(pf) => {
                let ty = match pf.kind {
                    PackableKind::List => format!("Vec<{}>", pf.value_rust_ty),
                    PackableKind::HashTable | PackableKind::PHashTable => {
                        format!("Vec<({}, {})>", pf.key_rust_ty, pf.value_rust_ty)
                    }
                };
                out.push((pf.name_snake.clone(), ty));
            }
            EmitStep::Align(_) => {}
        }
    }
    out
}

/// J3.D: emit the `match disc_local { … }` dispatch for a `<switch>` block.
/// The scrutinee is the discriminator's `_bits` companion (for enum-typed
/// discs) or the bare local (for primitive discs), cast to `i128` so signed
/// case values (`PwdType=-1`) compose with unsigned reprs.
///
/// Each case arm:
/// - decodes the case body via `emit_step_indented` calls (recursive for
///   nested switches);
/// - constructs the typed enum variant with the case-body locals.
///
/// An unknown discriminator surfaces as `Err("unknown <EnumName> discriminator")`
/// to mirror Chorizite's "no default case" convention.
fn emit_read_switch(buf: &mut String, sw: &SwitchBlock, indent: &str) {
    let scrutinee_local = match sw.disc_kind {
        DiscriminatorKind::Primitive => sw.disc_snake.clone(),
        DiscriminatorKind::Enum => format!("{}_bits", sw.disc_snake),
    };
    writeln!(buf, "{indent}// <switch name=\"{}\">", escape_xml_attr_for_doc(&sw.disc_xml_name)).unwrap();
    writeln!(buf, "{indent}let {fname}: {ename} = {{", fname = sw.field_snake, ename = sw.enum_name).unwrap();
    let inner_indent = format!("{indent}    ");
    writeln!(buf, "{inner_indent}let __disc: i128 = ({scrutinee_local}) as i128;").unwrap();
    writeln!(buf, "{inner_indent}match __disc {{").unwrap();
    let case_indent = format!("{inner_indent}    ");
    let body_indent = format!("{case_indent}    ");
    for case in &sw.cases {
        // Build the match arm pattern: `n if n == V1 || n == V2 || ... =>`.
        // We use a guarded wildcard rather than literal patterns because
        // some values are out of range of i32 once we widen reprs, and the
        // signed-vs-unsigned mix is easier to handle this way.
        let mut pattern = String::from("n if ");
        for (i, v) in case.values.iter().enumerate() {
            if i > 0 {
                pattern.push_str(" || ");
            }
            pattern.push_str(&format!("n == {v}i128"));
        }
        writeln!(buf, "{case_indent}{pattern} => {{").unwrap();
        if let Some(t) = &case.text {
            writeln!(buf, "{body_indent}// {} — {}", escape_xml_attr_for_doc(&case.value_xml), escape_doc(t)).unwrap();
        } else {
            writeln!(buf, "{body_indent}// case value=\"{}\"", escape_xml_attr_for_doc(&case.value_xml)).unwrap();
        }
        // Decode the case body steps in order.
        for step in &case.steps {
            emit_step_indented(buf, step, &body_indent);
        }
        // Build the variant value.
        let payload = collect_case_payload_fields(&case.steps);
        if payload.is_empty() {
            writeln!(buf, "{body_indent}{ename}::{vid}", ename = sw.enum_name, vid = case.variant_id).unwrap();
        } else {
            writeln!(buf, "{body_indent}{ename}::{vid} {{", ename = sw.enum_name, vid = case.variant_id).unwrap();
            for (fname, _fty) in &payload {
                writeln!(buf, "{body_indent}    {fname},").unwrap();
            }
            writeln!(buf, "{body_indent}}}").unwrap();
        }
        writeln!(buf, "{case_indent}}},").unwrap();
    }
    writeln!(buf, "{case_indent}_other => return Err(\"unknown {ename} discriminator\"),", ename = sw.enum_name).unwrap();
    writeln!(buf, "{inner_indent}}}").unwrap();
    writeln!(buf, "{indent}}};").unwrap();
}

/// J3.D: emit the read for a `<table>` (Dictionary<K,V>). Mirrors the
/// vector-loop pattern but reads K then V at each iteration and inserts
/// into a BTreeMap. Templated `T,U` tables never reach this path —
/// `build_table_field` rejects them with a J3.E SKIP reason.
fn emit_read_table(buf: &mut String, tb: &TableField, indent: &str) {
    let snake = &tb.name_snake;
    let count_expr = &tb.length_expr_rust;
    let kty = &tb.key_rust_ty;
    let vty = &tb.value_rust_ty;
    let xml_len = &tb.length_xml;
    writeln!(buf, "{indent}// <table name=\"{snake}\" length=\"{}\" key=\"{kty}\" value=\"{vty}\">",
        escape_xml_attr_for_doc(xml_len)).unwrap();
    writeln!(buf, "{indent}let {snake}_count: usize = {count_expr};").unwrap();
    writeln!(buf, "{indent}let mut {snake}: std::collections::BTreeMap<{kty}, {vty}> = std::collections::BTreeMap::new();").unwrap();
    writeln!(buf, "{indent}for _ in 0..{snake}_count {{").unwrap();
    let inner = format!("{indent}    ");
    emit_read_field_indented(buf, "__k", &tb.key_kind, &inner);
    emit_read_field_indented(buf, "__v", &tb.value_kind, &inner);
    writeln!(buf, "{inner}{snake}.insert(__k, __v);").unwrap();
    writeln!(buf, "{indent}}}").unwrap();
}

/// J3.E: emit the read for a `<if test="EXPR">` block. Generates:
///   1. Pre-declare every gated Option<T> from both branches as `None`.
///   2. `if (test_rust) { … } else { … }`.
///   3. Inside each branch, decode the gated fields into local `_v`-suffixed
///      variables, then `name = Some(name_v);`.
///
/// Mirrors `emit_read_maskmap`'s shape — the gated fields surface as
/// `Option<T>` on the struct so `Self { ... }` is well-typed regardless of
/// which branch fired.
fn emit_read_if(buf: &mut String, ifb: &IfBlock, indent: &str) {
    writeln!(buf, "{indent}// <if test=\"{}\">", escape_xml_attr_for_doc(&ifb.test_xml)).unwrap();
    // Pre-declare each gated field as None. Walk the body steps and pull
    // out every (snake, rust_ty) pair via `collect_if_payload_locals`.
    let true_locals = collect_if_payload_locals(&ifb.true_steps);
    let false_locals = collect_if_payload_locals(&ifb.false_steps);
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for (snake, ty) in true_locals.iter().chain(false_locals.iter()) {
        if seen.insert(snake.clone()) {
            writeln!(buf, "{indent}let mut {snake}: Option<{ty}> = None;").unwrap();
        }
    }
    writeln!(buf, "{indent}if {test} {{", test = ifb.test_rust).unwrap();
    let inner = format!("{indent}    ");
    for step in &ifb.true_steps {
        emit_if_branch_step(buf, step, &inner);
    }
    for (snake, _) in &true_locals {
        writeln!(buf, "{inner}{snake} = Some({snake}_v);").unwrap();
    }
    writeln!(buf, "{indent}}}").unwrap();
    if !ifb.false_steps.is_empty() {
        writeln!(buf, "{indent}else {{").unwrap();
        for step in &ifb.false_steps {
            emit_if_branch_step(buf, step, &inner);
        }
        for (snake, _) in &false_locals {
            writeln!(buf, "{inner}{snake} = Some({snake}_v);").unwrap();
        }
        writeln!(buf, "{indent}}}").unwrap();
    }
}

/// J3.E: emit one step inside an `<if>` branch body — `<field>` decodes into
/// a `<snake>_v` local (which the surrounding `emit_read_if` then assigns
/// into the pre-declared Option); `<vector>` and `<align>` route through
/// their existing indented emitters.
fn emit_if_branch_step(buf: &mut String, step: &EmitStep, indent: &str) {
    match step {
        EmitStep::Field(f) => {
            let tmp = format!("{}_v", f.name_snake);
            emit_read_field_indented(buf, &tmp, &f.field_kind, indent);
        }
        EmitStep::Vector(v) => {
            // No retail site has a vector inside an <if>; mirror the
            // emit_read_vector path defensively (the vector decodes into
            // a `_v`-suffixed local).
            let mut adj = v.name_snake.clone();
            adj.push_str("_v");
            let mut tmp = VectorField {
                name_snake: adj,
                element_rust_ty: v.element_rust_ty.clone(),
                element_kind: v.element_kind.clone(),
                length_expr_rust: v.length_expr_rust.clone(),
                length_xml: v.length_xml.clone(),
                text: v.text.clone(),
            };
            // No suffix added because the outer emit_read_if doesn't
            // currently support vectors in if-bodies (would need its own
            // pre-declared Option<Vec<T>>). Defensive only.
            let _ = &mut tmp;
            emit_read_vector_indented(buf, v, indent);
        }
        EmitStep::Align(n) => emit_align_pad_indented(buf, *n, indent),
        EmitStep::Packable(pf) => {
            // No retail site has a Packable inside an <if>; defensive.
            emit_read_packable(buf, pf, indent);
        }
        EmitStep::Maskmap(_) | EmitStep::Switch(_) | EmitStep::Table(_) | EmitStep::If(_) => {
            // No retail site nests these inside an <if>; if a future
            // schema does, we'd need to extend collect_if_payload_locals
            // to surface their gated/payload fields as if-locals.
            writeln!(buf, "{indent}// UNSUPPORTED nested step inside <if>; please extend J3.E.").unwrap();
        }
    }
}

/// J3.E: collect (snake, rust_ty) pairs for the Option<T> struct fields
/// each branch's body steps produce. Mirrors `collect_case_payload_fields`
/// but only handles the steps that appear inside retail `<if>` branches
/// (field-only); other variants get a defensive empty entry to keep the
/// codegen warning-free.
fn collect_if_payload_locals(steps: &[EmitStep]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for step in steps {
        match step {
            EmitStep::Field(f) => out.push((f.name_snake.clone(), f.rust_ty.clone())),
            EmitStep::Vector(v) => out.push((
                v.name_snake.clone(),
                format!("Vec<{}>", v.element_rust_ty),
            )),
            EmitStep::Packable(pf) => {
                let ty = match pf.kind {
                    PackableKind::List => format!("Vec<{}>", pf.value_rust_ty),
                    PackableKind::HashTable | PackableKind::PHashTable => {
                        format!("Vec<({}, {})>", pf.key_rust_ty, pf.value_rust_ty)
                    }
                };
                out.push((pf.name_snake.clone(), ty));
            }
            EmitStep::Align(_) => {}
            EmitStep::Maskmap(_) | EmitStep::Switch(_) | EmitStep::Table(_) | EmitStep::If(_) => {}
        }
    }
    out
}

/// J3.E: emit struct-field declarations for the gated fields in one branch
/// of an `<if>`. Each field becomes `pub <snake>: Option<T>,` since it's
/// only assigned by one branch (or stays `None` if the other branch fires).
fn emit_if_struct_fields(buf: &mut String, steps: &[EmitStep], branch_label: &str) {
    for (snake, ty) in collect_if_payload_locals(steps) {
        writeln!(buf, "    /// Gated on `<if>` `{branch_label}` branch — present iff the test selected this branch.").unwrap();
        writeln!(buf, "    pub {snake}: Option<{ty}>,").unwrap();
    }
}

/// J3.E: emit the `<snake>,` lines in `Ok(Self { … })` for an `<if>` block.
/// Walks both branches in declaration order, dedups across branches so a
/// shared snake-name (rare; only when sites declare two unrelated fields
/// with the same name) doesn't duplicate the line. The dedup also covers
/// the AllegianceData case where both branches declare a `TimeOnline` —
/// the `seen_names` uniquifier on `build_simple_field` has already
/// suffixed the second to `time_online_2`, so the snake-names ARE
/// distinct and dedup is a no-op.
fn emit_if_struct_field_names(buf: &mut String, steps: &[EmitStep]) {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for (snake, _) in collect_if_payload_locals(steps) {
        if seen.insert(snake.clone()) {
            writeln!(buf, "            {snake},").unwrap();
        }
    }
}

/// J3.E: emit the read for a templated PackableList/PackableHashTable/
/// PHashTable inlined at a use-site. The three wire shapes:
///
/// - List (`Vec<T>`): u32 count + N×T.
/// - HashTable (`Vec<(K,V)>`): u16 count + u16 maxsize + N×(K,V).
/// - PHashTable (`Vec<(K,V)>`): u32 packed + N×(K,V). The packed u32 holds
///   count in the low 24 bits (`packed & 0xFFFFFF`) and buckets in the top
///   8 (`1 << (packed >> 24)`); buckets is unused for the wire decode.
fn emit_read_packable(buf: &mut String, pf: &PackableField, indent: &str) {
    let snake = &pf.name_snake;
    let inner = format!("{indent}    ");
    match pf.kind {
        PackableKind::List => {
            writeln!(buf, "{indent}// inlined PackableList<{}>", pf.value_rust_ty).unwrap();
            writeln!(buf, "{indent}if *offset + 4 > data.len() {{ return Err(\"truncated PackableList count for {snake}\"); }}").unwrap();
            writeln!(buf, "{indent}let {snake}_count: usize = u32::from_le_bytes([data[*offset], data[*offset+1], data[*offset+2], data[*offset+3]]) as usize; *offset += 4;").unwrap();
            writeln!(buf, "{indent}let mut {snake}: Vec<{}> = Vec::with_capacity({snake}_count.min(1024));", pf.value_rust_ty).unwrap();
            writeln!(buf, "{indent}for _ in 0..{snake}_count {{").unwrap();
            writeln!(buf, "{inner}let __elem: {} = {{", pf.value_rust_ty).unwrap();
            emit_read_field_indented(buf, "__elem", &pf.value_kind, &format!("{inner}    "));
            writeln!(buf, "{inner}    __elem").unwrap();
            writeln!(buf, "{inner}}};").unwrap();
            writeln!(buf, "{inner}{snake}.push(__elem);").unwrap();
            writeln!(buf, "{indent}}}").unwrap();
        }
        PackableKind::HashTable => {
            writeln!(buf, "{indent}// inlined PackableHashTable<{}, {}>", pf.key_rust_ty, pf.value_rust_ty).unwrap();
            writeln!(buf, "{indent}if *offset + 4 > data.len() {{ return Err(\"truncated PackableHashTable count for {snake}\"); }}").unwrap();
            writeln!(buf, "{indent}let {snake}_count: usize = u16::from_le_bytes([data[*offset], data[*offset+1]]) as usize; *offset += 2;").unwrap();
            writeln!(buf, "{indent}let _{snake}_maxsize: u16 = u16::from_le_bytes([data[*offset], data[*offset+1]]); *offset += 2;").unwrap();
            writeln!(buf, "{indent}let mut {snake}: Vec<({}, {})> = Vec::with_capacity({snake}_count.min(1024));", pf.key_rust_ty, pf.value_rust_ty).unwrap();
            writeln!(buf, "{indent}for _ in 0..{snake}_count {{").unwrap();
            emit_read_field_indented(buf, "__k", &pf.key_kind, &inner);
            emit_read_field_indented(buf, "__v", &pf.value_kind, &inner);
            writeln!(buf, "{inner}{snake}.push((__k, __v));").unwrap();
            writeln!(buf, "{indent}}}").unwrap();
        }
        PackableKind::PHashTable => {
            writeln!(buf, "{indent}// inlined PHashTable<{}, {}>", pf.key_rust_ty, pf.value_rust_ty).unwrap();
            writeln!(buf, "{indent}if *offset + 4 > data.len() {{ return Err(\"truncated PHashTable packed-size for {snake}\"); }}").unwrap();
            writeln!(buf, "{indent}let {snake}_packed: u32 = u32::from_le_bytes([data[*offset], data[*offset+1], data[*offset+2], data[*offset+3]]); *offset += 4;").unwrap();
            writeln!(buf, "{indent}let {snake}_count: usize = ({snake}_packed & 0xFFFFFF) as usize;").unwrap();
            writeln!(buf, "{indent}let mut {snake}: Vec<({}, {})> = Vec::with_capacity({snake}_count.min(1024));", pf.key_rust_ty, pf.value_rust_ty).unwrap();
            writeln!(buf, "{indent}for _ in 0..{snake}_count {{").unwrap();
            emit_read_field_indented(buf, "__k", &pf.key_kind, &inner);
            emit_read_field_indented(buf, "__v", &pf.value_kind, &inner);
            writeln!(buf, "{inner}{snake}.push((__k, __v));").unwrap();
            writeln!(buf, "{indent}}}").unwrap();
        }
    }
}

/// J3.D: resolve a `<switch name="X">` discriminator against the sibling
/// lookup. Returns `(scrutinee_rust_expr, rust_repr, disc_kind)` — the
/// scrutinee expression is what the read codegen's match scrutinee reads to
/// get the discriminator value, AS A RUST EXPRESSION (not just a bare local
/// name); for primitive/enum siblings that's `<snake>` / `<snake>_bits`,
/// for subfield discriminators it's the inlined subfield expression
/// substituted to read the parent's local.
fn resolve_switch_discriminator(
    disc_xml_name: &str,
    siblings: &SiblingLookup,
) -> Option<(String, String, DiscriminatorKind)> {
    // Primitive (or flag-enum-downgraded-to-primitive) sibling.
    if let Some((snake, repr)) = siblings.fields_by_xml_name.get(disc_xml_name) {
        return Some((snake.clone(), repr.clone(), DiscriminatorKind::Primitive));
    }
    // Strict enum sibling.
    if let Some(ef) = siblings.enum_fields_by_xml_name.get(disc_xml_name) {
        return Some((ef.snake.clone(), ef.rust_repr.clone(), DiscriminatorKind::Enum));
    }
    // Subfield-of-sibling — handles `ItemProfile.<switch name="PwdType">`
    // where `PwdType` is a `<subfield>` of `PackedAmount`. Substitute the
    // subfield's value-expression with the parent's snake local, then return
    // the resulting Rust expression as the scrutinee. The expression is
    // evaluated INLINE inside `read_from` (not as a pre-bound local), so the
    // caller threads it through to the match-scrutinee site.
    if let Some(sf_ref) = siblings.subfields_by_xml_name.get(disc_xml_name) {
        if let Ok(expr) = translate_subfield_expr_for_local(
            &sf_ref.value_expr_xml,
            &sf_ref.parent_xml_name,
            &sf_ref.parent_snake_name,
            &sf_ref.parent_rust_repr,
            &sf_ref.parent_rust_repr,
        ) {
            return Some((expr, sf_ref.parent_rust_repr.clone(), DiscriminatorKind::Primitive));
        }
    }
    None
}

/// J3.D: produce a Rust ident-safe name for one switch case. Mirrors the
/// upstream Chorizite naming (which uses `case_HEX:` C# labels for diagnostic
/// purposes); we use `Case_HEX` for non-negatives, `Case_NegN` for negatives,
/// and join multi-value cases with underscores. Two-byte literals (`0x4`)
/// pad to a consistent width so naming is stable across cases like
/// `0x4`/`0x40`/`0x400`.
fn canonical_case_variant_id(values: &[i128]) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(values.len());
    for v in values {
        if *v < 0 {
            parts.push(format!("Neg{}", v.unsigned_abs()));
        } else {
            parts.push(format!("{:X}", *v as u64));
        }
    }
    format!("Case_{}", parts.join("_"))
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
/// J3.E: detect a templated PackableList/PackableHashTable/PHashTable use-site
/// from a `<field type="…">` element. Returns the wire-shape discriminator,
/// or `None` if the type is not one of the three known templates.
fn packable_kind_for_field(c: Node<'_, '_>) -> Option<PackableKind> {
    match c.attribute("type")? {
        "PackableList" => Some(PackableKind::List),
        "PackableHashTable" => Some(PackableKind::HashTable),
        "PHashTable" => Some(PackableKind::PHashTable),
        _ => None,
    }
}

/// J3.E: human-readable name for a PackableKind (used in error messages so
/// the SKIP reasons name the actual templated type).
fn kind_name(k: PackableKind) -> &'static str {
    match k {
        PackableKind::List => "PackableList",
        PackableKind::HashTable => "PackableHashTable",
        PackableKind::PHashTable => "PHashTable",
    }
}

/// J3.E: compute the Rust struct-field type for a PackableField. List
/// becomes `Vec<T>`; HashTable/PHashTable become `Vec<(K, V)>` (insertion-
/// ordered vec-of-tuples avoids the K: Ord requirement that BTreeMap would
/// need — load-bearing for keys like `LayeredSpellId` which are structs).
fn packable_rust_ty(pf: &PackableField) -> String {
    match pf.kind {
        PackableKind::List => format!("Vec<{}>", pf.value_rust_ty),
        PackableKind::HashTable | PackableKind::PHashTable => {
            format!("Vec<({}, {})>", pf.key_rust_ty, pf.value_rust_ty)
        }
    }
}

/// J3.E: translate a `<if test="EXPR">` boolean expression into a Rust
/// expression evaluating to `bool` at `read_from`'s local scope. Supports
/// the six retail forms:
///
///   - `CastingLikelihood < 2.0` — float comparison
///   - `HasEquipmentSet > 0` / `PaletteCount > 0` / `RecordCount > 0` — int > 0
///   - `TextIncluded` — bool (WireBool) bare-identifier truthy check
///   - `Flags == 0x4` — int == hex
///
/// The expression is tokenised via `tokenize_csharp_expr` (extended with
/// `<`, `>`, `==` operators), then re-emitted with the LHS identifier
/// substituted for the sibling's local-variable name and the appropriate
/// width-cast so the comparison composes regardless of the field's repr.
fn translate_if_test_expr(expr: &str, siblings: &SiblingLookup) -> Result<String, String> {
    let tokens = tokenize_if_test_expr(expr)
        .map_err(|e| format!("tokenize failed: {e}"))?;

    // Three recognised shapes:
    //   [Ident]               -> bare-bool check on a WireBool sibling.
    //   [Ident Op Literal]    -> comparison against a literal value.
    //   [Ident == LitOrIdent] -> equality comparison.
    // We pattern-match the token sequence directly rather than build a full
    // bool-expression parser; the six retail forms are all of one shape or
    // the other.
    if tokens.len() == 1 {
        let ident = match &tokens[0] {
            IfTok::Ident(s) => s.clone(),
            other => return Err(format!("expected identifier, got {other:?}")),
        };
        // Bare bool sibling — must be a WireBool (4-byte bool) field. We
        // look up via fields_by_xml_name; the snake-local stores a Rust
        // `bool` (WireBool type alias), so a bare-identifier check just
        // references the local directly.
        let (snake, _) = siblings.fields_by_xml_name.get(&ident)
            .ok_or_else(|| format!("identifier {ident:?} is not a sibling field"))?
            .clone();
        // We also look up the "bool kind" status — if the sibling is a
        // numeric field we still allow it as a `!= 0` check (defensive; no
        // retail site does this).
        let bool_xml_marker = siblings.bool_fields_by_xml_name.contains(&ident);
        if bool_xml_marker {
            return Ok(snake);
        }
        // Numeric fallback: `<snake> != 0` — but the retail bool sites are
        // all proper bool. We emit a width-cast and != 0 if the sibling
        // turns out to be a numeric (covers future schema growth).
        return Ok(format!("({snake} as u64) != 0"));
    }

    if tokens.len() == 3 {
        let lhs = match &tokens[0] {
            IfTok::Ident(s) => s.clone(),
            other => return Err(format!("expected identifier LHS, got {other:?}")),
        };
        let op = match &tokens[1] {
            IfTok::Cmp(o) => *o,
            other => return Err(format!("expected comparison operator, got {other:?}")),
        };
        let (snake, repr) = siblings.fields_by_xml_name.get(&lhs)
            .ok_or_else(|| format!("identifier {lhs:?} is not a sibling field"))?
            .clone();
        // RHS may be a numeric literal (int or float) or an identifier (a
        // sibling field). The retail forms are all literal-RHS.
        match &tokens[2] {
            IfTok::IntLit { raw } => {
                // Cast LHS to a wide signed type so a u8 sibling can compare
                // against a hex literal without truncation, AND so signed-
                // unsigned mixes are well-defined.
                return Ok(format!("({snake} as i128) {} {raw}i128", op_as_rust(op)));
            }
            IfTok::FloatLit { raw } => {
                // Float comparison — preserve the LHS's float type.
                let lhs_expr = if repr == "f32" || repr == "f64" {
                    snake.clone()
                } else {
                    format!("({snake} as f64)")
                };
                let rhs_lit = if repr == "f32" {
                    format!("{raw}f32")
                } else {
                    format!("{raw}f64")
                };
                return Ok(format!("{lhs_expr} {} {rhs_lit}", op_as_rust(op)));
            }
            IfTok::Ident(rhs_id) => {
                // Identifier RHS — defer to a future schema (no retail site uses).
                let (rhs_snake, _) = siblings.fields_by_xml_name.get(rhs_id)
                    .ok_or_else(|| format!("RHS identifier {rhs_id:?} is not a sibling field"))?
                    .clone();
                return Ok(format!("({snake} as i128) {} ({rhs_snake} as i128)", op_as_rust(op)));
            }
            other => return Err(format!("expected literal or identifier RHS, got {other:?}")),
        }
    }

    Err(format!("unsupported test shape: {tokens:?}"))
}

/// J3.E: comparison operator for `<if test=...>` translation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CmpOp {
    Lt,
    Le,
    Gt,
    Ge,
    Eq,
    Ne,
}

fn op_as_rust(op: CmpOp) -> &'static str {
    match op {
        CmpOp::Lt => "<",
        CmpOp::Le => "<=",
        CmpOp::Gt => ">",
        CmpOp::Ge => ">=",
        CmpOp::Eq => "==",
        CmpOp::Ne => "!=",
    }
}

/// J3.E: tokeniser for `<if test=...>` expressions. Subset of the C# subfield
/// tokeniser (no casts, no shifts, no `&`/`|`); adds the comparison
/// operators `<`, `>`, `<=`, `>=`, `==`, `!=` AND float literals (`2.0`).
#[derive(Clone, Debug, PartialEq)]
enum IfTok {
    Ident(String),
    IntLit { raw: String },
    FloatLit { raw: String },
    Cmp(CmpOp),
}

fn tokenize_if_test_expr(s: &str) -> Result<Vec<IfTok>, String> {
    let bytes = s.as_bytes();
    let mut i = 0;
    let mut out = Vec::new();
    let is_ident_start = |b: u8| b.is_ascii_alphabetic() || b == b'_';
    let is_ident_cont = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    while i < bytes.len() {
        let b = bytes[i];
        if b.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        match b {
            b'<' => {
                if bytes.get(i + 1) == Some(&b'=') {
                    out.push(IfTok::Cmp(CmpOp::Le));
                    i += 2;
                } else {
                    out.push(IfTok::Cmp(CmpOp::Lt));
                    i += 1;
                }
            }
            b'>' => {
                if bytes.get(i + 1) == Some(&b'=') {
                    out.push(IfTok::Cmp(CmpOp::Ge));
                    i += 2;
                } else {
                    out.push(IfTok::Cmp(CmpOp::Gt));
                    i += 1;
                }
            }
            b'=' if bytes.get(i + 1) == Some(&b'=') => {
                out.push(IfTok::Cmp(CmpOp::Eq));
                i += 2;
            }
            b'!' if bytes.get(i + 1) == Some(&b'=') => {
                out.push(IfTok::Cmp(CmpOp::Ne));
                i += 2;
            }
            _ if b.is_ascii_digit() || (b == b'-' && bytes.get(i + 1).is_some_and(|nb| nb.is_ascii_digit())) => {
                let start = i;
                if b == b'-' { i += 1; }
                if i + 1 < bytes.len() && bytes[i] == b'0' && (bytes[i + 1] == b'x' || bytes[i + 1] == b'X') {
                    i += 2;
                    while i < bytes.len() && bytes[i].is_ascii_hexdigit() {
                        i += 1;
                    }
                    let raw = s[start..i].to_string();
                    out.push(IfTok::IntLit { raw });
                } else {
                    let mut has_dot = false;
                    while i < bytes.len() {
                        if bytes[i].is_ascii_digit() {
                            i += 1;
                        } else if bytes[i] == b'.' && !has_dot {
                            has_dot = true;
                            i += 1;
                        } else {
                            break;
                        }
                    }
                    let raw = s[start..i].to_string();
                    if has_dot {
                        out.push(IfTok::FloatLit { raw });
                    } else {
                        out.push(IfTok::IntLit { raw });
                    }
                }
            }
            _ if is_ident_start(b) => {
                let start = i;
                while i < bytes.len() && is_ident_cont(bytes[i]) {
                    i += 1;
                }
                out.push(IfTok::Ident(s[start..i].to_string()));
            }
            _ => return Err(format!("unexpected character {:?} at offset {i} of {s:?}", b as char)),
        }
    }
    Ok(out)
}

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

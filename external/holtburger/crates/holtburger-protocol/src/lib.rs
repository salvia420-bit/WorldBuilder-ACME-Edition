pub mod errors;
pub mod messages;
pub mod opcodes;
pub mod test_helpers;

pub use opcodes::GameOpcode;
pub mod crypto;
pub mod test_fixtures;
pub mod traits;

/// **TEST-ONLY — QUARANTINED (A13-W5).** The runtime wire codec is the
/// hand-written `messages::*` tree (`messages/movement/actions.rs` for the
/// movement packs, `messages/game_action.rs` for dispatch). Nothing outside
/// `tests/` may wire `generated::*` types into a runtime path: field names
/// and shapes already drift from the runtime codec (e.g. generated
/// `JumpPack` uses Chorizite names `object_instance_sequence`… and stops at
/// the 24-byte pack, while runtime `JumpActionData` uses `instance_sequence`…
/// and carries the 8-byte object_guid+spell_id trailer that ACE
/// `GameActionJump.cs` reads after `JumpPack`). Byte-level compatibility of
/// the overlap is enforced by `tests/generated_parity.rs` (`w5_*` tests) —
/// if the shapes diverge those tests fail.
///
/// PR 7 — Tier-1 codegen layer parsed from
/// `external/chorizite/Chorizite.ACProtocol/Chorizite.ACProtocol/protocol.xml`
/// at build time.
///
/// Layout:
/// - `generated::*` — every supported enum, datatype struct, and message struct
///   from protocol.xml. Names are Chorizite's `Category_VerbNoun` PascalCase.
/// - `generated::OPCODE_INDEX` — a `&[(&str kind, &str name, u32 opcode)]`
///   slice used by the parity test to assert opcode-value match against the
///   hand-written `opcodes.rs::GameOpcode` enum.
///
/// The generated layer is purely ADDITIVE: when both a generated and a
/// hand-written reader exist for the same opcode (e.g. `0xF657
/// Login_SendEnterWorld` is both `generated::Login_SendEnterWorld` and
/// `messages::login::EnterWorld`), the hand-written one is the source of
/// truth — it has richer typing, intentional commented-out skips, and is
/// already wired into the wasm session handler.
///
/// Conditional-encoding cases (`<switch>`, `<if>`, `<mask>`/`<maskmap>`,
/// `<vector length="FieldName">`, `<subfield>`, `<table>`, `<align>`) are
/// DEFERRED to PR 7.2 — they are emitted as `// SKIPPED …` comments in the
/// generated file with a per-case reason.
#[allow(non_camel_case_types)]
#[allow(non_upper_case_globals)]
#[allow(non_snake_case)]
#[allow(dead_code)]
#[allow(unused_assignments)]
#[allow(unused_variables)]
#[allow(clippy::all)]
pub mod generated {
    use super::messages::utils;

    /// Re-export the generated read helpers under the module namespace so
    /// the generated source can call them without `super::` qualification.
    /// These wrap the existing hand-written read helpers — no new wire
    /// semantics, just a stable name for the codegen output.
    pub fn read_string16_le(
        data: &[u8],
        offset: &mut usize,
    ) -> Result<String, &'static str> {
        utils::read_string16(data, offset).ok_or("truncated string16 field")
    }

    /// Wire-WString reader. The retail wire form is UTF-16LE prefixed by a
    /// u16 character count (same length-escape convention as string16); for
    /// the foundation tier we delegate to the byte-string path because the
    /// vast majority of `WString`-typed fields in protocol.xml are either
    /// password (`Login_SendEnterWorld`) or chat-text (`TurbineChat`
    /// `<switch>` cases which we skip). When a real WString field gets wired
    /// we'll route this to a UTF-16 decoder in PR 7.2.
    pub fn read_wstring_le(
        data: &[u8],
        offset: &mut usize,
    ) -> Result<String, &'static str> {
        utils::read_string16(data, offset).ok_or("truncated wstring field")
    }

    /// Compressed DWORD reader. The Chorizite XML uses `PackedDWORD` for
    /// `DataId` and similar; the wire form is a low-16 prefix with a
    /// high-bit continuation that extends to a full u32. See
    /// `messages::utils::read_packed_data_id` for the canonical
    /// implementation — we wrap it with base_id=0 (the codegen layer doesn't
    /// know about base-id offsetting, which is a `Surface` / `Sound` /
    /// `Setup` DAT-id concern only).
    pub fn read_packed_dword(
        data: &[u8],
        offset: &mut usize,
    ) -> Result<u32, &'static str> {
        if *offset + 2 > data.len() {
            return Err("truncated packed_dword field");
        }
        Ok(utils::read_packed_data_id(data, offset, 0))
    }

    include!(concat!(env!("OUT_DIR"), "/messages_generated.rs"));
}

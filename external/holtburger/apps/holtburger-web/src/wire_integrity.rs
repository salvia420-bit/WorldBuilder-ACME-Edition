//! test-tooling-3 (2026-10-13): per-opcode wire-integrity counters for the
//! recv loop's inbound `GameMessage::unpack` (session/messages/mod.rs).
//!
//! Before this, the dispatcher dropped an undecodable message without a trace:
//! one short field in any sub-parser returns `None` through `?` (every
//! GameEvent arm is `XEventData::unpack(data, offset)?`) and the whole message
//! went with it. Nothing compared the final cursor with the message length
//! either, so a parser that stopped early (or ran past the end) was invisible,
//! and `__diag.wire` only counts what was DISPATCHED. Retail does not drop on
//! a short tail on at least one path: `CM_Fellowship::DispatchUI_FullUpdate`
//! (acclient.c:703588) ignores `Fellowship::UnPack`'s result and still calls
//! `Handle_Fellowship__FullUpdate`.
//!
//! Every inbound message is classified into one [`Outcome`] and tallied per
//! [`key`]. LOG-ONLY, like the `[seq-gap]` observer: it never drops,
//! reorders or alters a message. Read through `wire_integrity_json()` (wasm)
//! → `__diag.wire.integrity()` (scene3d/diag/wire.js), gated by ci-smoke S7.
//!
//! "Unknown" is decided from the raw opcode (`GameOpcode::from_repr` /
//! `GameEventOpcode::from_repr` = `None`), NOT from the `Unknown` variant:
//! `unpack` also builds `GameMessage::Unknown` on purpose for AccountBanned
//! and the 20 Wave-6.A Qualities opcodes. A validated Qualities wrap is a
//! decode; its `!consumed` raw-grab fallback is a decode failure disguised as
//! `Unknown` and counts as undecodable (`qualities_raw_wrap_decodes`).
//!
//! Same `wasm32 OR test` gate as `session_liveness` so the classifier is
//! unit-tested natively (`cargo test -p holtburger-web --lib wire_integrity`);
//! the recv loop that calls [`observe`] is wasm32-only.

use std::cell::RefCell;
use std::collections::BTreeMap;

use holtburger_protocol::messages::GameMessage;
use holtburger_protocol::messages::game_message::qualities_raw_wrap_decodes;
use holtburger_protocol::opcodes::{GameEventOpcode, GameOpcode};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

/// Top-level opcode of the ordered-GameEvent envelope.
const GAME_EVENT_OPCODE: u32 = 0xF7B0;

/// Key of a message too short to carry an opcode (< 4 bytes).
pub(crate) const RUNT_KEY: u32 = 0xFFFF_FFFF;

/// Key every NEW key folds into once a bucket holds [`KEY_CAP`] keys, so a
/// long session cannot grow the maps without bound.
pub(crate) const OVERFLOW_KEY: u32 = 0xFFFF_FFFE;

/// Distinct keys kept per bucket. The opcode space ACE actually sends is a
/// few hundred values in total.
pub(crate) const KEY_CAP: usize = 512;

/// What one inbound message's decode looked like.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// Decoded, and the cursor ended exactly at the message end.
    Ok,
    /// Decoded, but this many trailing bytes were never read (the parser
    /// stopped early, or an alignment pad it does not consume).
    ShortRead(usize),
    /// Decoded, but the cursor ended this many bytes PAST the message end.
    Overrun(usize),
    /// `unpack` returned `None` (the message was dropped), or a Qualities
    /// raw wrap whose codegen read failed.
    Undecodable,
    /// Top-level opcode not in `GameOpcode`.
    UnknownOpcode,
    /// 0xF7B0 GameEvent whose event type is not in `GameEventOpcode`.
    UnknownEvent,
}

fn read_u32(bytes: &[u8], at: usize) -> Option<u32> {
    let b = bytes.get(at..at.checked_add(4)?)?;
    Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

/// The tally key: the top-level opcode, or for a 0xF7B0 GameEvent
/// `0xF7B0_0000 | event_type` (the event type sits at bytes 12..16, after the
/// target guid and the sequence). Every `GameEventOpcode` is < 0x10000, so the
/// event type is masked to 16 bits to stay inside the 0xF7B0 namespace. A
/// GameEvent too short to carry its event type keys as plain 0xF7B0; a message
/// shorter than an opcode keys as [`RUNT_KEY`].
pub(crate) fn key(bytes: &[u8]) -> u32 {
    let Some(op) = read_u32(bytes, 0) else {
        return RUNT_KEY;
    };
    if op != GAME_EVENT_OPCODE {
        return op;
    }
    match read_u32(bytes, 12) {
        Some(event_type) => 0xF7B0_0000 | (event_type & 0xFFFF),
        None => op,
    }
}

/// Classify one inbound message. `parsed` / `offset` are exactly what
/// `GameMessage::unpack(bytes, &mut offset)` (starting at 0) produced.
pub(crate) fn classify(bytes: &[u8], parsed: Option<&GameMessage>, offset: usize) -> Outcome {
    let Some(message) = parsed else {
        return Outcome::Undecodable;
    };
    // `unpack` needs 4 bytes for the opcode before it can return `Some`.
    let Some(op) = read_u32(bytes, 0) else {
        return Outcome::Undecodable;
    };
    if GameOpcode::from_repr(op).is_none() {
        return Outcome::UnknownOpcode;
    }
    if op == GAME_EVENT_OPCODE
        && let Some(event_type) = read_u32(bytes, 12)
        && GameEventOpcode::from_repr(event_type).is_none()
    {
        return Outcome::UnknownEvent;
    }
    // A KNOWN opcode wrapped as `Unknown` on purpose: AccountBanned (tail
    // grabbed raw by design) is a decode; a Qualities wrap is one only when
    // its codegen reader accepts the payload.
    if matches!(message, GameMessage::Unknown(..)) && qualities_raw_wrap_decodes(bytes) == Some(false)
    {
        return Outcome::Undecodable;
    }
    match offset.cmp(&bytes.len()) {
        std::cmp::Ordering::Equal => Outcome::Ok,
        std::cmp::Ordering::Less => Outcome::ShortRead(bytes.len() - offset),
        std::cmp::Ordering::Greater => Outcome::Overrun(offset - bytes.len()),
    }
}

/// One key's tally in one bucket.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Tally {
    /// Messages.
    pub n: u64,
    /// Bytes this bucket failed to decode: the unread tail (short read), the
    /// overshoot (overrun), or the whole message (undecodable / unknown).
    pub bytes: u64,
    /// Length of the most recent message.
    pub last_len: usize,
}

/// The counters. Kept per wasm instance (the recv loop runs on the main
/// thread's instance only).
#[derive(Debug, Default)]
pub(crate) struct WireIntegrity {
    pub messages: u64,
    pub undecodable: BTreeMap<u32, Tally>,
    pub unknown: BTreeMap<u32, Tally>,
    pub short_read: BTreeMap<u32, Tally>,
    pub overrun: BTreeMap<u32, Tally>,
}

impl WireIntegrity {
    /// Tally one message. Returns `true` the first time `key` lands in the
    /// outcome's bucket (the caller warns once per key).
    pub(crate) fn record(&mut self, key: u32, len: usize, outcome: Outcome) -> bool {
        self.messages += 1;
        let (bucket, residue) = match outcome {
            Outcome::Ok => return false,
            Outcome::ShortRead(n) => (&mut self.short_read, n),
            Outcome::Overrun(n) => (&mut self.overrun, n),
            Outcome::Undecodable => (&mut self.undecodable, len),
            Outcome::UnknownOpcode | Outcome::UnknownEvent => (&mut self.unknown, len),
        };
        let key = if bucket.len() >= KEY_CAP && !bucket.contains_key(&key) {
            OVERFLOW_KEY
        } else {
            key
        };
        let t = bucket.entry(key).or_default();
        let first = t.n == 0;
        t.n += 1;
        t.bytes += residue as u64;
        t.last_len = len;
        first
    }

    /// `{"messages":N,"totals":{…},"undecodable":{"0xF7B001C0":{"n","bytes",
    /// "lastLen"}},"unknown":{…},"shortRead":{…},"overrun":{…}}`. Keys are
    /// `0x` + 8 upper-case hex digits.
    pub(crate) fn to_json(&self) -> String {
        use serde_json::{Map, Value, json};
        let bucket = |m: &BTreeMap<u32, Tally>| -> Value {
            let mut o = Map::new();
            for (k, t) in m {
                o.insert(
                    format!("0x{k:08X}"),
                    json!({ "n": t.n, "bytes": t.bytes, "lastLen": t.last_len }),
                );
            }
            Value::Object(o)
        };
        let total = |m: &BTreeMap<u32, Tally>| -> u64 { m.values().map(|t| t.n).sum() };
        json!({
            "messages": self.messages,
            "totals": {
                "undecodable": total(&self.undecodable),
                "unknown": total(&self.unknown),
                "shortRead": total(&self.short_read),
                "overrun": total(&self.overrun),
            },
            "undecodable": bucket(&self.undecodable),
            "unknown": bucket(&self.unknown),
            "shortRead": bucket(&self.short_read),
            "overrun": bucket(&self.overrun),
        })
        .to_string()
    }
}

/// The one-time console line for a key's first undecodable / overrun message.
/// Unknown opcodes and events already warn on every occurrence inside
/// `unpack`, and short reads are mostly benign alignment pads, so neither
/// adds a line here (they are in the JSON).
fn first_warning(key: u32, len: usize, outcome: Outcome, dropped: bool) -> Option<String> {
    match outcome {
        Outcome::Undecodable => Some(format!(
            "[wire-integrity] undecodable opcode=0x{key:08X} len={len} dropped={dropped} \
             (first for this key; counts: __diag.wire.integrity())"
        )),
        Outcome::Overrun(n) => Some(format!(
            "[wire-integrity] overrun opcode=0x{key:08X} len={len} by={n} \
             (first for this key; counts: __diag.wire.integrity())"
        )),
        _ => None,
    }
}

thread_local! {
    static STATE: RefCell<WireIntegrity> = RefCell::new(WireIntegrity::default());
}

/// Recv-loop hook: classify and tally one inbound message. Call it with the
/// exact `unpack` result BEFORE the `else` return, so dropped messages count.
/// Observation only. A replayed object blob (held-3) re-enters the recv path
/// and is counted again.
pub(crate) fn observe(bytes: &[u8], parsed: Option<&GameMessage>, offset: usize) {
    let outcome = classify(bytes, parsed, offset);
    let key = key(bytes);
    let first = STATE.with(|s| s.borrow_mut().record(key, bytes.len(), outcome));
    if !first {
        return;
    }
    if let Some(line) = first_warning(key, bytes.len(), outcome, parsed.is_none()) {
        warn_line(&line);
    }
}

// `log` is a wasm32-only dep of this crate; the native test build stays quiet.
#[cfg(target_arch = "wasm32")]
fn warn_line(line: &str) {
    log::warn!("{line}");
}
#[cfg(not(target_arch = "wasm32"))]
fn warn_line(_line: &str) {}

/// This instance's counters as JSON (see [`WireIntegrity::to_json`]).
pub(crate) fn snapshot_json() -> String {
    STATE.with(|s| s.borrow().to_json())
}

/// test-tooling-3 — the recv loop's wire-integrity counters as JSON, read on
/// demand by `__diag.wire.integrity()` (scene3d/diag/wire.js) and ci-smoke S7.
/// Additive, diagnostics-only (no manifest bump — the slowRunDiag precedent).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn wire_integrity_json() -> String {
    snapshot_json()
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_protocol::traits::ProtocolUnpack;

    /// 0xF7B0 GameEvent / 0x01C0 UpdateHealth: opcode, target guid, sequence,
    /// event type, then the event (object guid + f32 health) — 24 bytes.
    fn update_health() -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(&0xF7B0u32.to_le_bytes());
        b.extend_from_slice(&0x5000_0001u32.to_le_bytes());
        b.extend_from_slice(&7u32.to_le_bytes());
        b.extend_from_slice(&0x01C0u32.to_le_bytes());
        b.extend_from_slice(&0x8000_0123u32.to_le_bytes());
        b.extend_from_slice(&0.5f32.to_le_bytes());
        b
    }

    /// 0x02E1 Qualities_PrivateUpdateSkillAC (protocol.xml): byte Sequence,
    /// SkillId (i32), SkillAdvancementClass (u32).
    fn update_skill_ac(skill: i32, sac: u32) -> Vec<u8> {
        let mut b = 0x02E1u32.to_le_bytes().to_vec();
        b.push(5);
        b.extend_from_slice(&skill.to_le_bytes());
        b.extend_from_slice(&sac.to_le_bytes());
        b
    }

    /// `unpack` from 0 exactly as the recv loop does, then classify.
    fn run(bytes: &[u8]) -> (Outcome, u32) {
        let mut offset = 0;
        let parsed = GameMessage::unpack(bytes, &mut offset);
        (classify(bytes, parsed.as_ref(), offset), key(bytes))
    }

    #[test]
    fn wire_integrity_valid_update_health_is_ok() {
        assert_eq!(run(&update_health()), (Outcome::Ok, 0xF7B0_01C0));
    }

    #[test]
    fn wire_integrity_truncated_update_health_is_undecodable() {
        let mut b = update_health();
        b.truncate(b.len() - 2);
        let mut offset = 0;
        assert!(GameMessage::unpack(&b, &mut offset).is_none(), "the dispatcher drops it");
        assert_eq!(run(&b), (Outcome::Undecodable, 0xF7B0_01C0));
    }

    #[test]
    fn wire_integrity_unknown_opcode() {
        let mut b = 0xDEAD_BEEFu32.to_le_bytes().to_vec();
        b.extend_from_slice(&[1, 2, 3, 4]);
        assert_eq!(run(&b), (Outcome::UnknownOpcode, 0xDEAD_BEEF));
    }

    #[test]
    fn wire_integrity_unknown_game_event() {
        let mut b = update_health();
        b[12..16].copy_from_slice(&0xFFF0u32.to_le_bytes());
        assert_eq!(run(&b), (Outcome::UnknownEvent, 0xF7B0_FFF0));
    }

    #[test]
    fn wire_integrity_valid_qualities_wrap_is_ok_not_unknown() {
        // MeleeDefense (6), Specialized (3): unpack wraps it as Unknown on purpose.
        let b = update_skill_ac(6, 3);
        let mut offset = 0;
        assert!(matches!(
            GameMessage::unpack(&b, &mut offset),
            Some(GameMessage::Unknown(0x02E1, _))
        ));
        assert_eq!(run(&b), (Outcome::Ok, 0x02E1));
    }

    #[test]
    fn wire_integrity_malformed_qualities_wrap_is_undecodable() {
        // Missing SkillAdvancementClass: the `!consumed` raw-grab fallback.
        let mut b = update_skill_ac(6, 3);
        b.truncate(b.len() - 4);
        assert_eq!(run(&b), (Outcome::Undecodable, 0x02E1));
        // Unknown SkillId discriminant: also rejected by the codegen reader.
        assert_eq!(run(&update_skill_ac(9999, 3)), (Outcome::Undecodable, 0x02E1));
    }

    #[test]
    fn wire_integrity_account_banned_is_ok() {
        // 0xF7C1: u32 seconds + optional reason, tail grabbed raw by design.
        let mut b = 0xF7C1u32.to_le_bytes().to_vec();
        b.extend_from_slice(&3600u32.to_le_bytes());
        assert_eq!(run(&b), (Outcome::Ok, 0xF7C1));
    }

    #[test]
    fn wire_integrity_trailing_pad_is_short_read() {
        let mut b = update_health();
        b.extend_from_slice(&[0, 0, 0, 0]);
        assert_eq!(run(&b), (Outcome::ShortRead(4), 0xF7B0_01C0));
    }

    #[test]
    fn wire_integrity_overrun_and_runt() {
        let b = update_health();
        let parsed = {
            let mut o = 0;
            GameMessage::unpack(&b, &mut o)
        };
        assert_eq!(classify(&b, parsed.as_ref(), b.len() + 3), Outcome::Overrun(3));
        assert_eq!(key(&[0xB0, 0xF7]), RUNT_KEY);
        assert_eq!(run(&[0xB0, 0xF7]), (Outcome::Undecodable, RUNT_KEY));
        // A GameEvent too short for its event type keys as plain 0xF7B0.
        assert_eq!(run(&b[..10]), (Outcome::Undecodable, 0xF7B0));
    }

    #[test]
    fn wire_integrity_record_tallies_and_warns_once_per_key() {
        let mut w = WireIntegrity::default();
        assert!(!w.record(0x02CD, 40, Outcome::Ok));
        assert!(w.record(0xF7B0_01C0, 22, Outcome::Undecodable));
        assert!(!w.record(0xF7B0_01C0, 20, Outcome::Undecodable));
        assert!(w.record(0xF745, 44, Outcome::ShortRead(4)));
        assert!(!w.record(0xF745, 44, Outcome::ShortRead(4)));
        assert!(w.record(0xDEAD_BEEF, 8, Outcome::UnknownOpcode));
        assert_eq!(w.messages, 6);
        assert_eq!(
            w.undecodable[&0xF7B0_01C0],
            Tally { n: 2, bytes: 42, last_len: 20 }
        );
        assert_eq!(w.short_read[&0xF745], Tally { n: 2, bytes: 8, last_len: 44 });
        assert_eq!(w.unknown[&0xDEAD_BEEF].n, 1);
        assert!(w.overrun.is_empty());

        let v: serde_json::Value = serde_json::from_str(&w.to_json()).unwrap();
        assert_eq!(v["messages"], 6);
        assert_eq!(v["totals"]["undecodable"], 2);
        assert_eq!(v["totals"]["unknown"], 1);
        assert_eq!(v["totals"]["shortRead"], 2);
        assert_eq!(v["totals"]["overrun"], 0);
        assert_eq!(v["undecodable"]["0xF7B001C0"]["bytes"], 42);
        assert_eq!(v["shortRead"]["0x0000F745"]["lastLen"], 44);
        assert_eq!(v["unknown"]["0xDEADBEEF"]["n"], 1);
    }

    #[test]
    fn wire_integrity_key_cap_folds_new_keys_into_overflow() {
        let mut w = WireIntegrity::default();
        for k in 0..KEY_CAP as u32 {
            w.record(0x1_0000 + k, 8, Outcome::UnknownOpcode);
        }
        assert!(w.record(0x9_0000, 8, Outcome::UnknownOpcode), "first overflow");
        assert!(!w.record(0x9_0001, 8, Outcome::UnknownOpcode));
        // An existing key still counts under itself.
        assert!(!w.record(0x1_0000, 8, Outcome::UnknownOpcode));
        assert_eq!(w.unknown.len(), KEY_CAP + 1);
        assert_eq!(w.unknown[&OVERFLOW_KEY].n, 2);
        assert_eq!(w.unknown[&0x1_0000].n, 2);
    }

    #[test]
    fn wire_integrity_observe_feeds_snapshot() {
        // thread_local: each test thread starts from empty counters.
        let good = update_health();
        let mut bad = update_health();
        bad.truncate(bad.len() - 2);
        for b in [&good, &bad, &bad] {
            let mut offset = 0;
            let parsed = GameMessage::unpack(b, &mut offset);
            observe(b, parsed.as_ref(), offset);
        }
        let v: serde_json::Value = serde_json::from_str(&snapshot_json()).unwrap();
        assert_eq!(v["messages"], 3);
        assert_eq!(v["totals"]["undecodable"], 2);
        assert_eq!(v["undecodable"]["0xF7B001C0"]["n"], 2);
        assert_eq!(v["totals"]["shortRead"], 0);
    }

    #[test]
    fn wire_integrity_first_warning_only_for_silent_failures() {
        assert!(first_warning(0x1C0, 22, Outcome::Undecodable, true).is_some());
        assert!(first_warning(0x1C0, 22, Outcome::Overrun(2), false).is_some());
        assert!(first_warning(0x1C0, 22, Outcome::ShortRead(2), false).is_none());
        assert!(first_warning(0x1C0, 22, Outcome::UnknownOpcode, false).is_none());
        assert!(first_warning(0x1C0, 22, Outcome::Ok, false).is_none());
    }
}

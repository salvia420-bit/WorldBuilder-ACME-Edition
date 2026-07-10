#!/usr/bin/env node
// scripts/net-review/lint-wire-codec.mjs — W2 net-fixwave (2026-07-10):
// mechanical drift check of OUR wire-opcode enums against the vendored
// chorizite ACProtocol tables (the retail-shape reference).
//
// Compares by VALUE, not name (our enums use readable names; chorizite uses
// its generated ones):
//   FAIL  an opcode value in crates/holtburger-protocol/src/opcodes.rs that
//         chorizite's corresponding table does NOT contain — either a typo'd
//         hex (the drift this exists to catch) or a deliberate extension
//         (add it to KNOWN_EXTENSIONS with a reason).
//   INFO  chorizite values we don't enumerate — the S2C/action coverage gap
//         is a separate audit (unknown opcodes hit the dispatch fallthrough,
//         they don't mis-parse).
//
// Run: node scripts/net-review/lint-wire-codec.mjs  (exit 1 on FAIL)
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const JSON_PATH = path.join(
  ROOT,
  "apps/holtburger-web/data/chorizite/chorizite-acprotocol-opcodes.json",
);
const RS_PATH = path.join(ROOT, "crates/holtburger-protocol/src/opcodes.rs");

// Deliberate divergences from the chorizite tables, each with a reason.
// All four 2026-07-10 entries were VERIFIED against ACE (the wire truth):
// external/ACE/Source/ACE.Entity/PacketOpCodeNames.cs — the vendored
// chorizite tables are simply incomplete for them.
const KNOWN_EXTENSIONS = {
  GameOpcode: {
    0x0000: "None — internal heartbeat/logout sentinel, never on the wire",
    0xf753: "Evt_Movement__AutonomousPosition (ACE PacketOpCodeNames 63315) — chorizite C2S table lacks it",
  },
  GameActionOpcode: {
    0x021a: "Evt_Character__RemovePlayerPermission (ACE PacketOpCodeNames 538)",
  },
  GameEventOpcode: {
    0x00a0: "INVENTORY_SERVER_SAYS_FAILED_EVENT (ACE PacketOpCodeNames 160)",
    0x00b5: "BOOK_MODIFY_PAGE_RESPONSE_EVENT (ACE PacketOpCodeNames 181)",
  },
};

const chorizite = JSON.parse(fs.readFileSync(JSON_PATH, "utf8")).enums;
// GameOpcode mixes C2S and S2C top-level types; actions/events map 1:1.
const tables = {
  GameOpcode: new Map(
    [
      ...Object.entries(chorizite.C2SMessageType || {}),
      ...Object.entries(chorizite.S2CMessageType || {}),
    ].map(([hex, name]) => [parseInt(hex, 16), name]),
  ),
  GameActionOpcode: new Map(
    Object.entries(chorizite.GameActionType || {}).map(([h, n]) => [parseInt(h, 16), n]),
  ),
  GameEventOpcode: new Map(
    Object.entries(chorizite.GameEventType || {}).map(([h, n]) => [parseInt(h, 16), n]),
  ),
};

// Parse our enums: `pub enum Name {` blocks with `Variant = 0xHEX,` members.
const src = fs.readFileSync(RS_PATH, "utf8");
const ours = {}; // enumName → Map(value → variant)
let cur = null;
for (const line of src.split("\n")) {
  const em = line.match(/pub enum (\w+)/);
  if (em) {
    cur = em[1];
    ours[cur] = new Map();
    continue;
  }
  if (!cur) continue;
  const vm = line.match(/^\s*(\w+)\s*=\s*0[xX]([0-9a-fA-F]+)\s*,/);
  if (vm) ours[cur].set(parseInt(vm[2], 16), vm[1]);
  if (/^\}/.test(line)) cur = null;
}

let failures = 0;
for (const [enumName, ref] of Object.entries(tables)) {
  const mine = ours[enumName];
  if (!mine) {
    console.log(`FAIL  enum ${enumName} not found in opcodes.rs (parser drift?)`);
    failures += 1;
    continue;
  }
  let covered = 0;
  for (const [value, variant] of mine) {
    if (ref.has(value)) {
      covered += 1;
    } else if (
      Object.prototype.hasOwnProperty.call(KNOWN_EXTENSIONS[enumName] || {}, value)
    ) {
      covered += 1; // waived
    } else {
      console.log(
        `FAIL  ${enumName}::${variant} = 0x${value.toString(16).toUpperCase().padStart(4, "0")} ` +
          `not in the chorizite table — typo'd value or undeclared extension`,
      );
      failures += 1;
    }
  }
  const missing = [...ref.keys()].filter((v) => !mine.has(v)).length;
  console.log(
    `${enumName}: ${mine.size} enumerated, ${covered} chorizite-confirmed, ` +
      `${missing} chorizite values not enumerated (INFO — dispatch fallthrough covers them)`,
  );
}

// ── A15 (net-review 2026-07-09, landed 2026-07-10): frame.rs copy-sync ──
// crates/holtburger-transport-ws/src/frame.rs is a DELIBERATE copy of
// apps/holtburger-wsbridge/src/frame.rs (the wsbridge crate is native-only;
// depending on it would drag tokio/mio into the wasm32 build). Its header
// says "keep this file in sync" — this check makes that comment enforceable:
// the wire-shape consts must match by value, and the decode_frame bodies
// must match token-for-token (comments/whitespace/doc-comments ignored).
const FRAME_A = path.join(ROOT, "apps/holtburger-wsbridge/src/frame.rs");
const FRAME_B = path.join(ROOT, "crates/holtburger-transport-ws/src/frame.rs");
// Known, waived divergences (same spirit as KNOWN_EXTENSIONS above).
// encode_frame's guard drift was fixed 2026-07-10 (session 6) — the set is
// empty; add entries only with a written reason and a removal condition.
const FRAME_FN_WAIVERS = new Set([]);

function stripRustComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}
function rustConsts(src) {
  const out = new Map();
  for (const m of src.matchAll(/pub const (\w+):\s*\w+\s*=\s*([0-9_a-fx]+)/gi)) {
    out.set(m[1], m[2].replace(/_/g, ""));
  }
  return out;
}
function rustFnBody(src, name) {
  // From `pub fn name` to the matching close brace at column 0.
  const re = new RegExp(`pub fn ${name}\\b[\\s\\S]*?\\n\\}`, "m");
  const m = stripRustComments(src).match(re);
  return m ? m[0].replace(/\s+/g, " ").trim() : null;
}

try {
  const a = fs.readFileSync(FRAME_A, "utf8");
  const b = fs.readFileSync(FRAME_B, "utf8");
  const [ca, cb] = [rustConsts(a), rustConsts(b)];
  for (const [name, val] of ca) {
    if (!cb.has(name)) {
      console.log(`FAIL  frame.rs sync: const ${name} missing from transport-ws copy`);
      failures += 1;
    } else if (cb.get(name) !== val) {
      console.log(`FAIL  frame.rs sync: const ${name} drifted (${val} vs ${cb.get(name)})`);
      failures += 1;
    }
  }
  const fnNames = [...a.matchAll(/pub fn (\w+)/g)].map((m) => m[1]);
  let synced = 0;
  for (const fn of fnNames) {
    if (FRAME_FN_WAIVERS.has(fn)) continue;
    const [ba, bb] = [rustFnBody(a, fn), rustFnBody(b, fn)];
    if (bb == null) {
      console.log(`FAIL  frame.rs sync: fn ${fn} missing from transport-ws copy`);
      failures += 1;
    } else if (ba !== bb) {
      console.log(`FAIL  frame.rs sync: fn ${fn} bodies drifted (normalize+diff the two files)`);
      failures += 1;
    } else {
      synced += 1;
    }
  }
  console.log(
    `frame.rs copy-sync: ${ca.size} consts + ${synced} fn bodies in sync, ` +
      `${FRAME_FN_WAIVERS.size} waived`,
  );
} catch (e) {
  console.log(`FAIL  frame.rs sync check errored: ${e.message}`);
  failures += 1;
}

process.exit(failures ? 1 : 0);

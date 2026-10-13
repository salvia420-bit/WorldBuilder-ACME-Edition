// tests/diag_wire_integrity.test.mjs — test-tooling-3: `__diag.wire.integrity()`
// (scene3d/diag/wire.js) over the wasm recv loop's per-opcode wire-integrity
// counters (`wire_integrity_json`, src/wire_integrity.rs). The wasm export is
// faked with the exact JSON shape `WireIntegrity::to_json` emits; a stale pkg/
// (no export) must read null, never throw. Also pins the three wiring sites by
// source text: the index.html rider, the wasm export, and the recv-loop hook
// sitting BEFORE the dispatcher's `else` return (so dropped messages count).
//
// Run: node tests/diag_wire_integrity.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

globalThis.window = globalThis;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");

const { attachWire, readWireIntegrity } = await import("../scene3d/diag/wire.js");

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) passed += 1; else failed += 1;
}

// `WireIntegrity::to_json` field order and spelling.
const PAYLOAD = {
  messages: 1234,
  totals: { undecodable: 2, unknown: 1, shortRead: 3, overrun: 0 },
  undecodable: { "0xF7B001C0": { n: 2, bytes: 42, lastLen: 20 } },
  unknown: { "0xDEADBEEF": { n: 1, bytes: 8, lastLen: 8 } },
  shortRead: { "0x0000F745": { n: 3, bytes: 12, lastLen: 44 } },
  overrun: {},
};

// ── absent export (stale pkg/, pre-boot) ──
{
  delete window.__hbWasm;
  const diag = {};
  attachWire(diag);
  check("attaches integrity()", typeof diag.wire.integrity === "function");
  check("integrity() is null with no __hbWasm", diag.wire.integrity() === null);
  window.__hbWasm = { slowRunDiag: () => "{}" };
  check("integrity() is null when the rider is missing", diag.wire.integrity() === null);
}

// ── stubbed export ──
{
  let calls = 0;
  window.__hbWasm = { wire_integrity_json: () => { calls += 1; return JSON.stringify(PAYLOAD); } };
  const diag = {};
  attachWire(diag);
  const r = diag.wire.integrity();
  check("integrity() parses the export", r !== null && r.messages === 1234, JSON.stringify(r));
  check("integrity() reads on demand (one call per read)", calls === 1);
  check("totals pass through", r.totals.undecodable === 2 && r.totals.unknown === 1 && r.totals.shortRead === 3 && r.totals.overrun === 0);
  check("per-opcode GameEvent key", r.undecodable["0xF7B001C0"].n === 2 && r.undecodable["0xF7B001C0"].lastLen === 20);
  check("short-read bytes", r.shortRead["0x0000F745"].bytes === 12);
  // The ClientEvent counters are a different surface: reset() leaves the
  // wasm counters alone, and integrity() never touches `counters`.
  diag.wire.onEvent({ kind: 2, stringPayload: "hi" });
  diag.wire.reset();
  check("reset() does not clear the wasm counters", diag.wire.integrity()?.messages === 1234);
  check("summary() is unchanged by integrity()", diag.wire.summary().total === 0);
}

// ── fail-soft edge cases ──
{
  check("bad JSON is null", readWireIntegrity({ wire_integrity_json: () => "{not json" }) === null);
  check("payload without totals is null", readWireIntegrity({ wire_integrity_json: () => "{\"messages\":1}" }) === null);
  check("JSON null is null", readWireIntegrity({ wire_integrity_json: () => "null" }) === null);
  check("throwing export is null", readWireIntegrity({ wire_integrity_json: () => { throw new Error("x"); } }) === null);
  check("null surface is null", readWireIntegrity(null) === null);
  window.__hbWasm = { wire_integrity_json: () => { throw new Error("panic"); } };
  const diag = {};
  attachWire(diag);
  check("integrity() swallows a throwing export", diag.wire.integrity() === null);
}

// ── wiring, by source text ──
{
  const indexSrc = fs.readFileSync(path.join(APP, "index.html"), "utf8");
  check(
    "index.html exposes the rider, typeof-guarded against a stale pkg/",
    /typeof __hbWasmNs\?\.wire_integrity_json === "function"/.test(indexSrc) &&
      /wire_integrity_json: \(\) => __hbWasmNs\.wire_integrity_json\(\)/.test(indexSrc),
  );

  const rs = fs.readFileSync(path.join(APP, "src/wire_integrity.rs"), "utf8");
  check(
    "src/wire_integrity.rs exports wire_integrity_json via #[wasm_bindgen]",
    /#\[wasm_bindgen\]\s*\npub fn wire_integrity_json\(\) -> String/.test(rs),
  );

  const lib = fs.readFileSync(path.join(APP, "src/lib.rs"), "utf8");
  check(
    "lib.rs declares the module under the wasm32-or-test gate",
    /#\[cfg\(any\(target_arch = "wasm32", test\)\)\]\s*\nmod wire_integrity;/.test(lib),
  );

  const recv = fs.readFileSync(path.join(APP, "src/session/messages/mod.rs"), "utf8");
  const unpackAt = recv.indexOf("let parsed = GameMessage::unpack(&bytes, &mut offset);");
  const observeAt = recv.indexOf("crate::wire_integrity::observe(&bytes, parsed.as_ref(), offset);");
  const elseAt = recv.indexOf("let Some(message) = parsed else {");
  check(
    "recv loop observes the unpack result BEFORE the dropping else-return",
    unpackAt >= 0 && observeAt > unpackAt && elseAt > observeAt,
    `unpack=${unpackAt} observe=${observeAt} else=${elseAt}`,
  );
}

console.log(`\ndiag_wire_integrity: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

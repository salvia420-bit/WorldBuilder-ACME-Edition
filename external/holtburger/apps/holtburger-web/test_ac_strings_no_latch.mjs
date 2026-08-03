// R9 — string/keymap loaders must not latch a transient failure.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_ac_strings_no_latch.mjs
//
// This is the defect class this codebase has already learned twice and written
// down twice:
//
//   ui/ac_icon_cache.js  (P0.4 / LEAK-03, RQ-32): "We have no authoritative
//     'this icon does not exist' proof here, so failures go into a SEPARATE,
//     TTL'd negative map — never into the success cache."
//   ui/ac_layout.js      (loadLayout):            "**Failures are NOT cached.**
//     If fetch_layout returns null (e.g. because the `eor/local` shard hasn't
//     been prefetched yet — common for plugins that mount during early boot),
//     the next call retries."
//
// ui/ac_strings.js and ui/keymap.js did the opposite:
//
//   * `loadStringTable`  cached `new Map()` into `tables` on BOTH the
//     wasm-missing and the throw path → `acString()` returns null for that
//     table for the whole session, and options-panel.js's own retry
//     (`loadStringTable(0x23000004).then(reapply)`) can never recover it.
//   * `loadActionMap`    cached `{stringTableId: 0, actions: []}` the same way
//     → `window.__acKeybindings` stays empty, and keymap.js's
//     `isToggleAction` / `actionHashLabel` / `canUserBind` all degrade
//     permanently.
//   * `loadLanguageString` cached `""`.
//   * `loadRetailKeyMap` (keymap.js) has a second, subtler shape: the
//     wasm-missing branch is a SYNCHRONOUS early return inside the async IIFE,
//     so its `finally { retailKeyMapPromise = null }` runs BEFORE the
//     `retailKeyMapPromise = (async ...)()` assignment completes. The
//     assignment then re-pins the settled null promise and the
//     `if (retailKeyMapPromise) return retailKeyMapPromise` guard hands it out
//     forever. (ac_layout.js documents exactly this ordering hazard and fixes
//     it with an `await Promise.resolve()` at the top of the IIFE.)
//
// `fetch_string_table` is a real transient: it calls global_source() (panics
// pre-`init_resource_source`) and then `ensure_walk_prefetched(...).await?`,
// which rejects on any shard-fetch failure. `src/lib.rs` already returns
// `"[]"` for an AUTHORITATIVE DAT miss — that arm is a success and SHOULD be
// cached. Only the unproven failures must stay retryable.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

globalThis.window = {};
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };

const strings = await import("file://" + resolvePath(__dirname, "ui/ac_strings.js"));
const keymap = await import("file://" + resolvePath(__dirname, "ui/keymap.js"));

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  [OK] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name} — ${detail}`); }
}

console.log("===========================================================");
console.log("R9 — ac_strings / keymap: transient failures stay retryable");
console.log("===========================================================");

const REAL_TABLE = JSON.stringify([[0x014152D5, "Left Alt"], [0x00000001, "Fwd"]]);

// ── 1. loadStringTable: wasm not ready yet, then ready ────────────────────
{
  window.__hbWasm = {}; // no fetch_string_table — the early-boot condition
  const first = await strings.loadStringTable(0x23000005);
  check("pre-wasm loadStringTable resolves to an empty Map",
    first instanceof Map && first.size === 0, `size=${first?.size}`);

  window.__hbWasm = { fetch_string_table: async () => REAL_TABLE };
  const second = await strings.loadStringTable(0x23000005);
  check("post-wasm loadStringTable RETRIES and gets the real table",
    second instanceof Map && second.size === 2, `size=${second?.size}`);
  check("acString resolves after the retry",
    strings.acString(0x23000005, 0x014152D5) === "Left Alt",
    `got=${strings.acString(0x23000005, 0x014152D5)}`);
}

// ── 2. loadStringTable: one throw, then success ───────────────────────────
{
  let calls = 0;
  window.__hbWasm = {
    fetch_string_table: async () => {
      calls += 1;
      if (calls === 1) throw new Error("shard fetch failed (transient)");
      return REAL_TABLE;
    },
  };
  const first = await strings.loadStringTable(0x23000004);
  check("throwing loadStringTable resolves to an empty Map (fail-soft)",
    first instanceof Map && first.size === 0, `size=${first?.size}`);
  const second = await strings.loadStringTable(0x23000004);
  check("a later call retries after a throw",
    second instanceof Map && second.size === 2, `size=${second?.size} calls=${calls}`);
}

// ── 3. an AUTHORITATIVE empty result IS cached (no retry storm) ───────────
{
  let calls = 0;
  window.__hbWasm = { fetch_string_table: async () => { calls += 1; return "[]"; } };
  await strings.loadStringTable(0x23000099);
  await strings.loadStringTable(0x23000099);
  check("authoritative '[]' (DAT miss) is cached — exactly one wasm call",
    calls === 1, `calls=${calls}`);
}

// ── 4. loadLanguageString: transient failure stays retryable ──────────────
{
  let calls = 0;
  window.__hbWasm = {
    fetch_language_string: async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return "Choose a name";
    },
  };
  const first = await strings.loadLanguageString(0x31000019);
  check("throwing loadLanguageString fails soft to ''", first === "", `got=${JSON.stringify(first)}`);
  const second = await strings.loadLanguageString(0x31000019);
  check("a later loadLanguageString retries", second === "Choose a name", `got=${JSON.stringify(second)}`);
}

// ── 5. loadActionMap: pre-wasm, then real ─────────────────────────────────
{
  window.__hbWasm = {};
  const first = await strings.loadActionMap();
  check("pre-wasm loadActionMap resolves to an empty action list",
    Array.isArray(first.actions) && first.actions.length === 0,
    `actions=${first.actions?.length}`);

  window.__hbWasm = {
    fetch_string_table: async () => JSON.stringify([[0xAAAA0001, "Move Forward"]]),
    fetch_action_map: async () => JSON.stringify({
      string_table_data_id: 0x23000055,
      actions: [{ input_map: 1, action_hash: 0x1234, label_hash: 0xAAAA0001, toggle: 0 }],
    }),
  };
  const second = await strings.loadActionMap();
  check("post-wasm loadActionMap RETRIES and resolves the real map",
    second.actions.length === 1 && second.actions[0].label === "Move Forward",
    `actions=${second.actions.length} label=${second.actions[0]?.label}`);
}

// ── 6. keymap.loadRetailKeyMap: the pinned-promise shape ──────────────────
{
  window.__hbWasm = {}; // no fetch_key_map -> synchronous early return
  const first = await keymap.loadRetailKeyMap();
  check("pre-wasm loadRetailKeyMap resolves null", first === null, `got=${first}`);

  window.__hbWasm = {
    fetch_key_map: async () => JSON.stringify({
      devices: [{ type: 2 /* keyboard */ }],
      mappings: [{ input_map: 1, action_hash: 0x1234, device: 0, key: 0x11, shift: 0, ctrl: 0, alt: 0 }],
    }),
  };
  const second = await keymap.loadRetailKeyMap();
  check("post-wasm loadRetailKeyMap RETRIES (not pinned to the settled null promise)",
    second !== null && second.byActionHash instanceof Map,
    `got=${second === null ? "null (STILL PINNED)" : typeof second}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

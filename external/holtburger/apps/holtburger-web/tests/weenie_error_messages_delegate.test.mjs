// tests/weenie_error_messages_delegate.test.mjs — chat-errors-2 (2026-10-13).
//
// Retail ClientCommunicationSystem::HandleFailureEvent (acclient.c:413716)
// is the client's one WeenieError → text table. holtburger now carries it as
// the generated crates/holtburger-core/src/retail_failure_table.rs
// (scripts/gen_retail_failure_table.py), which the wasm chat line uses and
// the wasm `weenieErrorText(code, param)` export serves. The rejection
// toasts' own map (plugins/weenie_error_messages.js) diverged from retail
// (0x3A "You're dead!", 0x407/0x408 with an added period, 0x550 "Out of
// range!", 0x24 with a period); weenieErrorMessage now delegates to the
// export for every code retail prints, passing `_` for the `%s` slots so
// rejection_feedback.js's `_` → "that item" substitution still applies.
//
// The wasm export is stubbed with a JS mirror of the Rust lookup
// (errors.rs `retail_failure_line`) built from the checked-in table.
//
// Run: node tests/weenie_error_messages_delegate.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  WEENIE_ERROR_MESSAGES,
  weenieErrorMessage,
  retailWeenieErrorText,
  retailFailureTextEnabled,
} from "../plugins/weenie_error_messages.js";

const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

// --- the checked-in retail table, parsed -----------------------------------
const tableSrc = src("../../crates/holtburger-core/src/retail_failure_table.rs");
const TABLE = new Map();
for (const m of tableSrc.matchAll(/^ {4}\(0x([0-9A-F]+), "((?:[^"\\]|\\.)*)", 0x([0-9A-F]+)\),$/gm)) {
  TABLE.set(parseInt(m[1], 16), {
    text: m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
    type: parseInt(m[3], 16),
  });
}
const ITEM_FALLBACK = [0x4bf, 0x4c0];

// JS mirror of errors.rs `retail_failure_line` (TargetNotAcquired 0x42C reads
// as 0x403; an empty param prints "item" for 0x4BF / 0x4C0).
function stubWeenieErrorText(code, param) {
  let c = code >>> 0;
  if (c === 0x42c) c = 0x403;
  const row = TABLE.get(c);
  if (!row) return undefined;
  let p = param == null ? "" : String(param);
  if (!p && ITEM_FALLBACK.includes(c)) p = "item";
  return row.text.split("{}").join(p);
}

function withWasm(fn, body) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "__hbWasm");
  const prev = globalThis.__hbWasm;
  try {
    globalThis.__hbWasm = fn === undefined ? undefined : { weenieErrorText: fn };
    return body();
  } finally {
    if (had) globalThis.__hbWasm = prev;
    else delete globalThis.__hbWasm;
  }
}

function withSearch(search, body) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "location");
  const prev = globalThis.location;
  try {
    globalThis.location = { search };
    return body();
  } finally {
    if (had) globalThis.location = prev;
    else delete globalThis.location;
  }
}

test("the checked-in table parses: 341 retail cases, sorted, known spots", () => {
  assert.equal(TABLE.size, 341);
  const codes = [...TABLE.keys()];
  assert.deepEqual(codes, [...codes].sort((a, b) => a - b));
  assert.deepEqual(TABLE.get(0x414), { text: "You are not in an allegiance!", type: 0x1a });
  assert.deepEqual(TABLE.get(0x402), { text: "Your spell fizzled.", type: 7 });
  assert.equal(TABLE.get(0x24).text, "You can't jump while in the air");
  assert.equal(TABLE.has(0x4b8), false, "notice-only arm: no text");
});

test("with the export, weenieErrorMessage delegates and passes `_` for %s", () => {
  const calls = [];
  const spy = (code, param) => {
    calls.push([code, param]);
    return stubWeenieErrorText(code, param);
  };
  withSearch("", () =>
    withWasm(spy, () => {
      // The map's divergences give way to retail's words.
      assert.equal(weenieErrorMessage(0x3a), "You can't do that... you're dead!");
      assert.equal(weenieErrorMessage(0x407), "Your spell cannot be cast outside");
      assert.equal(weenieErrorMessage(0x408), "Your spell cannot be cast inside");
      assert.equal(weenieErrorMessage(0x550), "Out of Range!");
      assert.equal(weenieErrorMessage(0x24), "You can't jump while in the air");
      assert.equal(weenieErrorMessage(0x427), "You cannot merge different stacks!");
      // Codes the map never had now read as retail too.
      assert.equal(weenieErrorMessage(0x414), "You are not in an allegiance!");
      // `%s` slots come back as `_`, and the caller's substitution still works.
      const gifts = weenieErrorMessage(0x1e);
      assert.equal(gifts, "_ is too busy to accept gifts right now.");
      assert.equal(
        gifts.replace(/_/g, "that item"),
        "that item is too busy to accept gifts right now.",
      );
      assert.equal(
        weenieErrorMessage(0x510).replace(/_/g, "that item"),
        "You may not hook any more that item on your house.  You already have the maximum number of that item hooked or you are not permitted to hook any on your type of house.",
      );
      assert.deepEqual(calls[0], [0x3a, "_"]);
    }),
  );
});

test("codes retail prints nothing for keep the map / the synthetic fallback", () => {
  withSearch("", () =>
    withWasm(stubWeenieErrorText, () => {
      // 0x426 AttunedItem: no HandleFailureEvent case.
      assert.equal(TABLE.has(0x426), false);
      assert.equal(weenieErrorMessage(0x426), WEENIE_ERROR_MESSAGES[0x426]);
      assert.equal(weenieErrorMessage(0x0), "WeenieError 0x0000");
      assert.equal(weenieErrorMessage(0xbeef), "WeenieError 0xBEEF");
    }),
  );
});

test("a stale pkg (no export) or a throwing export keeps the old map", () => {
  withSearch("", () => {
    withWasm(undefined, () => {
      assert.equal(retailWeenieErrorText(0x3a), null);
      assert.equal(weenieErrorMessage(0x3a), WEENIE_ERROR_MESSAGES[0x3a]);
    });
    withWasm(() => {
      throw new Error("boom");
    }, () => {
      assert.equal(retailWeenieErrorText(0x3a), null);
      assert.equal(weenieErrorMessage(0x1d), "You're too busy!");
    });
    withWasm(() => 42, () => {
      assert.equal(retailWeenieErrorText(0x3a), null, "non-string result ignored");
    });
  });
});

test("?retailFailureText=off keeps the map and never calls the export", () => {
  let called = 0;
  const spy = (code, param) => {
    called += 1;
    return stubWeenieErrorText(code, param);
  };
  withSearch("?nosw=1&retailFailureText=off", () =>
    withWasm(spy, () => {
      assert.equal(weenieErrorMessage(0x3a), WEENIE_ERROR_MESSAGES[0x3a]);
      assert.equal(weenieErrorMessage(0x550), WEENIE_ERROR_MESSAGES[0x550]);
    }),
  );
  assert.equal(called, 0);
});

test("?retailFailureText reader: default on; off / 0 / false disable", () => {
  assert.equal(retailFailureTextEnabled(""), true);
  assert.equal(retailFailureTextEnabled("?nosw=1"), true);
  assert.equal(retailFailureTextEnabled("?retailFailureText=on"), true);
  for (const v of ["off", "0", "false"]) {
    assert.equal(retailFailureTextEnabled(`?retailFailureText=${v}`), false, v);
  }
  // Same spelling as the wasm reader (chat_format.rs, case-sensitive).
  assert.equal(retailFailureTextEnabled("?retailFailureText=OFF"), true);
  assert.equal(retailFailureTextEnabled("?a=1&retailFailureText=0"), false);
  withSearch("?retailFailureText=off", () => assert.equal(retailFailureTextEnabled(), false));
});

test("wiring: index.html exposes the guarded rider; rejection_feedback keeps `_`", () => {
  const html = src("index.html");
  assert.match(html, /typeof __hbWasmNs\?\.weenieErrorText === "function"/);
  assert.match(html, /weenieErrorText: \(code, param\) =>/);
  const rf = src("plugins/rejection_feedback.js");
  assert.match(rf, /weenieErrorMessage\(code >>> 0\)\.replace\(\/_\/g, "that item"\)/);
  const lib = src("src/lib.rs");
  assert.match(lib, /#\[wasm_bindgen\(js_name = weenieErrorText\)\]/);
});

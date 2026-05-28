// Wave 5.C (2026-05-28) — tradeskill plugin dispatch decision test.
//
// Run with:
//   cd /home/wbterminal/WorldBuilder-ACME-Edition && \
//     node external/holtburger/apps/holtburger-web/test_tradeskill.mjs
//
// Validates the pure exports of plugins/tradeskill.js:
//   - `nextStateForDrop(dropEvent, config)` — drop-event → action descriptor
//   - `decideTradeskillCall(action, client)` — action → wasm-call decision
//
// Covers the drag-end → useWithTarget call decision per the wave brief.
// Mirrors test_lifestone_popup.mjs (Wave 6.B) and test_hotbar_fire.mjs
// (Wave 3.A) for parity with sibling test files.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── jsdom-lite shim ──────────────────────────────────────────────
// tradeskill.js touches document.head/createElement on import (via
// ensureStyles call site inside mount() — not on import, but the file
// references `document` at module scope inside helpers). Install the
// shim before dynamic-import so import is harmless. We don't drive
// mount() here; we only exercise the pure helpers.
function installDomShim() {
  if (typeof globalThis.document !== "undefined") return;
  const elementProto = {
    appendChild() { return null; },
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    style: undefined,
  };
  function mkEl() {
    return Object.assign(Object.create(elementProto), {
      style: {},
      dataset: {},
      attrs: {},
      classList: {
        add() {}, remove() {}, contains() { return false; }, toggle() { return false; },
      },
    });
  }
  globalThis.document = {
    head: mkEl(),
    body: mkEl(),
    createElement: () => mkEl(),
    getElementById: () => null,
  };
  globalThis.window = globalThis;
}
installDomShim();

const url = pathToFileURL(
  resolvePath(__dirname, "plugins/tradeskill.js")
).href;
const {
  nextStateForDrop,
  decideTradeskillCall,
  manifest,
  DEFAULT_CONFIG,
  __resetWarningState,
} = await import(url);

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label}: expected ${e}, got ${a}`);
  }
}

console.log("===========================================================");
console.log("Wave 5.C — tradeskill plugin dispatch decision test");
console.log("===========================================================");

console.log("\n[1] Module surface");

check("exports manifest with id=tradeskill", () => {
  if (manifest.id !== "tradeskill") {
    throw new Error(`bad manifest.id: ${manifest.id}`);
  }
  if (!manifest.iconHidden) {
    throw new Error("manifest.iconHidden should be true (no bar icon)");
  }
  if (manifest.version !== "0.1.0") {
    throw new Error(`bad manifest.version: ${manifest.version}`);
  }
});

check("exports DEFAULT_CONFIG with requireConfirm=false", () => {
  if (DEFAULT_CONFIG.requireConfirm !== false) {
    throw new Error(
      `DEFAULT_CONFIG.requireConfirm should be false (mirror retail), got ${DEFAULT_CONFIG.requireConfirm}`,
    );
  }
});

check("exports nextStateForDrop + decideTradeskillCall", () => {
  if (typeof nextStateForDrop !== "function") {
    throw new Error("nextStateForDrop not exported");
  }
  if (typeof decideTradeskillCall !== "function") {
    throw new Error("decideTradeskillCall not exported");
  }
});

console.log("\n[2] nextStateForDrop — drop-event → action");

check("valid item-on-item drop → fire (default no-confirm)", () => {
  const out = nextStateForDrop(
    { sourceGuid: 0x50000111, targetGuid: 0x50000222 },
    {},
  );
  assertEq(out, {
    kind: "fire",
    sourceGuid: 0x50000111,
    targetGuid: 0x50000222,
  }, "fire decision");
});

check("missing sourceGuid → skip", () => {
  const out = nextStateForDrop({ targetGuid: 0x50000222 }, {});
  assertEq(out, { kind: "skip", reason: "missing-guid" }, "missing src");
});

check("missing targetGuid → skip", () => {
  const out = nextStateForDrop({ sourceGuid: 0x50000111 }, {});
  assertEq(out, { kind: "skip", reason: "missing-guid" }, "missing tgt");
});

check("0 sourceGuid → skip", () => {
  const out = nextStateForDrop({ sourceGuid: 0, targetGuid: 0x123 }, {});
  assertEq(out, { kind: "skip", reason: "missing-guid" }, "0 src");
});

check("source == target (self-drop) → skip", () => {
  const out = nextStateForDrop(
    { sourceGuid: 0x50000111, targetGuid: 0x50000111 },
    {},
  );
  assertEq(out, { kind: "skip", reason: "same-slot" }, "self-drop");
});

check("sourceIsEquipSlot → skip (paperdoll wield path owns this)", () => {
  const out = nextStateForDrop(
    {
      sourceGuid: 0x50000111,
      targetGuid: 0x50000222,
      sourceIsEquipSlot: true,
    },
    {},
  );
  assertEq(out, { kind: "skip", reason: "equip-slot" }, "src equip");
});

check("targetIsEquipSlot → skip (paperdoll wield path owns this)", () => {
  const out = nextStateForDrop(
    {
      sourceGuid: 0x50000111,
      targetGuid: 0x50000222,
      targetIsEquipSlot: true,
    },
    {},
  );
  assertEq(out, { kind: "skip", reason: "equip-slot" }, "tgt equip");
});

check("requireConfirm=true → confirm action", () => {
  const out = nextStateForDrop(
    { sourceGuid: 0x50000111, targetGuid: 0x50000222 },
    { requireConfirm: true },
  );
  assertEq(out, {
    kind: "confirm",
    sourceGuid: 0x50000111,
    targetGuid: 0x50000222,
  }, "confirm path");
});

check("guids coerced to u32 (high-bit signed → unsigned)", () => {
  const out = nextStateForDrop(
    { sourceGuid: 0x80000111, targetGuid: 0xFFFFFFFF },
    {},
  );
  if (out.kind !== "fire") throw new Error(`expected fire, got ${out.kind}`);
  if (out.sourceGuid !== (0x80000111 >>> 0)) {
    throw new Error(`src not u32: ${out.sourceGuid}`);
  }
  if (out.targetGuid !== (0xFFFFFFFF >>> 0)) {
    throw new Error(`tgt not u32: ${out.targetGuid}`);
  }
});

console.log("\n[3] decideTradeskillCall — wasm-export dispatch");

check("fire + client.player.useWithTarget → calls useWithTarget(src, tgt)", () => {
  const client = { player: { useWithTarget: () => {} } };
  const out = decideTradeskillCall(
    { kind: "fire", sourceGuid: 0x50000111, targetGuid: 0x50000222 },
    client,
  );
  assertEq(out, {
    called: "useWithTarget",
    args: [0x50000111, 0x50000222],
    warn: null,
  }, "fire dispatch");
});

check("fire WITHOUT useWithTarget (stale wasm) → warn, no call", () => {
  const out = decideTradeskillCall(
    { kind: "fire", sourceGuid: 0x111, targetGuid: 0x222 },
    {},
  );
  assertEq(out.called, null, "no call when export missing");
  if (!out.warn || !out.warn.includes("useWithTarget not available")) {
    throw new Error(`warn message missing or wrong: ${out.warn}`);
  }
});

check("fire with empty client.player → warn (defence-in-depth)", () => {
  const out = decideTradeskillCall(
    { kind: "fire", sourceGuid: 0x111, targetGuid: 0x222 },
    { player: {} },
  );
  assertEq(out.called, null, "no call when player has no method");
  if (!out.warn) throw new Error("warn missing");
});

check("confirm action → never dispatches (popup gate)", () => {
  const client = { player: { useWithTarget: () => {} } };
  const out = decideTradeskillCall(
    { kind: "confirm", sourceGuid: 0x111, targetGuid: 0x222 },
    client,
  );
  assertEq(out, { called: null, args: [], warn: null }, "confirm no-dispatch");
});

check("skip action → never dispatches", () => {
  const client = { player: { useWithTarget: () => {} } };
  const out = decideTradeskillCall(
    { kind: "skip", reason: "same-slot" },
    client,
  );
  assertEq(out, { called: null, args: [], warn: null }, "skip no-dispatch");
});

check("u32 coercion in args even when input is signed-looking", () => {
  const client = { player: { useWithTarget: () => {} } };
  const out = decideTradeskillCall(
    { kind: "fire", sourceGuid: 0x80000111 | 0, targetGuid: -1 },
    client,
  );
  if (out.args[0] !== (0x80000111 >>> 0)) {
    throw new Error(`src coerce: ${out.args[0]}`);
  }
  // -1 >>> 0 === 0xFFFFFFFF
  if (out.args[1] !== 0xFFFFFFFF) {
    throw new Error(`tgt coerce: ${out.args[1]}`);
  }
});

console.log("\n[4] End-to-end — drop → fire / drop → confirm / drop → skip");

check("e2e: default config, item-on-item drop → useWithTarget called", () => {
  __resetWarningState();
  const calls = [];
  const client = {
    player: {
      useWithTarget: (s, t) => calls.push(["useWithTarget", s >>> 0, t >>> 0]),
    },
  };
  const drop = { sourceGuid: 0x50000ABC, targetGuid: 0x50000DEF };
  const action = nextStateForDrop(drop, DEFAULT_CONFIG);
  if (action.kind !== "fire") throw new Error(`expected fire, got ${action.kind}`);
  const dispatch = decideTradeskillCall(action, client);
  if (dispatch.called === "useWithTarget") {
    client.player.useWithTarget(...dispatch.args);
  }
  assertEq(calls, [["useWithTarget", 0x50000ABC, 0x50000DEF]], "fire wire");
});

check("e2e: requireConfirm=true, drop → confirm (no immediate call)", () => {
  __resetWarningState();
  const calls = [];
  const client = {
    player: {
      useWithTarget: (s, t) => calls.push(["useWithTarget", s >>> 0, t >>> 0]),
    },
  };
  const drop = { sourceGuid: 0x50000111, targetGuid: 0x50000222 };
  const action = nextStateForDrop(drop, { requireConfirm: true });
  if (action.kind !== "confirm") {
    throw new Error(`expected confirm, got ${action.kind}`);
  }
  const dispatch = decideTradeskillCall(action, client);
  assertEq(dispatch.called, null, "confirm gates dispatch");
  assertEq(calls, [], "no wire yet");

  // Now the popup approves → re-decide with kind="fire"
  const fire = {
    kind: "fire",
    sourceGuid: action.sourceGuid,
    targetGuid: action.targetGuid,
  };
  const dispatch2 = decideTradeskillCall(fire, client);
  if (dispatch2.called === "useWithTarget") {
    client.player.useWithTarget(...dispatch2.args);
  }
  assertEq(calls, [["useWithTarget", 0x50000111, 0x50000222]], "fire after confirm");
});

check("e2e: missing wasm export → action decided, dispatch warns, no call", () => {
  __resetWarningState();
  const calls = [];
  const client = { player: {} };
  const drop = { sourceGuid: 0x50000111, targetGuid: 0x50000222 };
  const action = nextStateForDrop(drop, DEFAULT_CONFIG);
  if (action.kind !== "fire") throw new Error(`expected fire, got ${action.kind}`);
  const dispatch = decideTradeskillCall(action, client);
  assertEq(dispatch.called, null, "no call when export missing");
  if (!dispatch.warn) throw new Error("warn missing for stale wasm");
  assertEq(calls, [], "no wire");
});

check("e2e: self-drop → skip (no wire, no warn)", () => {
  __resetWarningState();
  const calls = [];
  const client = {
    player: {
      useWithTarget: (s, t) => calls.push(["useWithTarget", s >>> 0, t >>> 0]),
    },
  };
  const drop = { sourceGuid: 0x50000111, targetGuid: 0x50000111 };
  const action = nextStateForDrop(drop, DEFAULT_CONFIG);
  assertEq(action, { kind: "skip", reason: "same-slot" }, "self-drop skip");
  const dispatch = decideTradeskillCall(action, client);
  assertEq(dispatch, { called: null, args: [], warn: null }, "no-dispatch");
  assertEq(calls, [], "no wire");
});

check("e2e: paperdoll-equip-target drop → skip (wield path owns this)", () => {
  __resetWarningState();
  const calls = [];
  const client = {
    player: {
      useWithTarget: (s, t) => calls.push(["useWithTarget", s >>> 0, t >>> 0]),
    },
  };
  const drop = {
    sourceGuid: 0x50000111,
    targetGuid: 0x50000222,
    targetIsEquipSlot: true,
  };
  const action = nextStateForDrop(drop, DEFAULT_CONFIG);
  assertEq(action, { kind: "skip", reason: "equip-slot" }, "equip skip");
  const dispatch = decideTradeskillCall(action, client);
  assertEq(calls, [], "no wire (equip path owns)");
});

console.log("\n===========================================================");
console.log(`PASS: ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.log(`FAIL: ${failed}`);
  process.exit(1);
}

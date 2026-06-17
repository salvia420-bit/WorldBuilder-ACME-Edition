// Wave 6.B (2026-05-28) — lifestone-popup state-machine + dispatch test.
//
// Run with:
//   cd /home/wbterminal/WorldBuilder-ACME-Edition && \
//     node external/holtburger/apps/holtburger-web/test_lifestone_popup.mjs
//
// Validates two pure exports:
//   - `nextStateForAction(prev, event)` — state machine: idle ↔ open
//   - `decideLifestoneAction(action, client)` — dispatch decision
//     {called: "useObject"|"recallToLifestone"|null, args}
//
// Pattern mirrors test_hotbar_fire.mjs (Wave 3.A). The plugin's
// DOM-side mount() is exercised by the visual smoke; this test covers
// the load-bearing pure helpers without DOM/wasm.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── jsdom-lite shim ──────────────────────────────────────────────
// lifestone-popup.js touches document.head/createElement (for
// ensureStyles) on import — install the shim before dynamic-import
// keeps that side effect harmless. We don't drive mount() in this
// test; we only exercise the pure helpers.
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
  resolvePath(__dirname, "plugins/lifestone-popup.js")
).href;
const {
  nextStateForAction,
  decideLifestoneAction,
  formatSanctuaryStatus,
  manifest,
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
console.log("Wave 6.B — lifestone-popup state-machine + dispatch test");
console.log("===========================================================");

console.log("\n[1] Module surface");

check("exports manifest with id=lifestone-popup", () => {
  if (manifest.id !== "lifestone-popup") {
    throw new Error(`bad manifest.id: ${manifest.id}`);
  }
  if (!manifest.iconHidden) {
    throw new Error("manifest.iconHidden should be true (no bar icon)");
  }
  if (manifest.version !== "0.1.0") {
    throw new Error(`bad manifest.version: ${manifest.version}`);
  }
});

check("exports nextStateForAction + decideLifestoneAction", () => {
  if (typeof nextStateForAction !== "function") {
    throw new Error("nextStateForAction not exported");
  }
  if (typeof decideLifestoneAction !== "function") {
    throw new Error("decideLifestoneAction not exported");
  }
});

console.log("\n[1b] formatSanctuaryStatus — HUD rec #56");

check("null / no snapshot → not-yet-bound fallback", () => {
  assertEq(formatSanctuaryStatus(null), "Not yet bound to any sanctuary", "null");
  assertEq(formatSanctuaryStatus(undefined), "Not yet bound to any sanctuary", "undefined");
});

check("isBound=false → not-yet-bound fallback", () => {
  assertEq(
    formatSanctuaryStatus({ isBound: false, formatted: "65.5N, 30.3E, 12.0Z", townName: "Holtburg" }),
    "Not yet bound to any sanctuary",
    "unbound",
  );
});

check("bound with town → 'Currently bound to: <town> (<coords>)'", () => {
  assertEq(
    formatSanctuaryStatus({ isBound: true, formatted: "45.2N, 12.8E, 0.0Z", townName: "Holtburg" }),
    "Currently bound to: Holtburg (45.2N, 12.8E, 0.0Z)",
    "town",
  );
});

check("bound without town → coords only", () => {
  assertEq(
    formatSanctuaryStatus({ isBound: true, formatted: "65.5N, 30.3E, 12.0Z", townName: null }),
    "Currently bound to: 65.5N, 30.3E, 12.0Z",
    "coords-only",
  );
});

check("bound with indoor formatted string (no town) → coords only", () => {
  assertEq(
    formatSanctuaryStatus({ isBound: true, formatted: "Indoors [860201AD]" }),
    "Currently bound to: Indoors [860201AD]",
    "indoor",
  );
});

console.log("\n[2] nextStateForAction — idle → open transition");

check("idle + lifestoneClicked → open with guid", () => {
  const out = nextStateForAction(
    { kind: "idle" },
    { type: "lifestoneClicked", guid: 0x80000100 },
  );
  assertEq(out, {
    state: { kind: "open", guid: 0x80000100 },
    action: { kind: "none" },
  }, "open transition");
});

check("guid coerced to u32 in open state", () => {
  const out = nextStateForAction(
    { kind: "idle" },
    { type: "lifestoneClicked", guid: 0xFFFFFFFF },
  );
  assertEq(out.state, { kind: "open", guid: 0xFFFFFFFF >>> 0 }, "u32 guid");
});

check("idle + bind (spurious) → drop, stay idle", () => {
  const out = nextStateForAction(
    { kind: "idle" },
    { type: "bind" },
  );
  assertEq(out, {
    state: { kind: "idle" },
    action: { kind: "none" },
  }, "spurious bind drop");
});

check("idle + recall (spurious) → drop, stay idle", () => {
  const out = nextStateForAction(
    { kind: "idle" },
    { type: "recall" },
  );
  assertEq(out, {
    state: { kind: "idle" },
    action: { kind: "none" },
  }, "spurious recall drop");
});

check("idle + cancel (spurious) → drop, stay idle", () => {
  const out = nextStateForAction(
    { kind: "idle" },
    { type: "cancel" },
  );
  assertEq(out, {
    state: { kind: "idle" },
    action: { kind: "none" },
  }, "spurious cancel drop");
});

console.log("\n[3] nextStateForAction — open → idle transitions");

check("open + bind → idle, action={bind, guid}", () => {
  const out = nextStateForAction(
    { kind: "open", guid: 0x80000123 },
    { type: "bind" },
  );
  assertEq(out, {
    state: { kind: "idle" },
    action: { kind: "bind", guid: 0x80000123 },
  }, "bind dispatch");
});

check("open + recall → idle, action={recall}", () => {
  const out = nextStateForAction(
    { kind: "open", guid: 0x80000123 },
    { type: "recall" },
  );
  assertEq(out, {
    state: { kind: "idle" },
    action: { kind: "recall" },
  }, "recall dispatch");
});

check("open + cancel → idle, action={cancel}", () => {
  const out = nextStateForAction(
    { kind: "open", guid: 0x80000123 },
    { type: "cancel" },
  );
  assertEq(out, {
    state: { kind: "idle" },
    action: { kind: "cancel" },
  }, "cancel dispatch");
});

check("open + lifestoneClicked (re-click different lifestone) → re-open with new guid", () => {
  const out = nextStateForAction(
    { kind: "open", guid: 0x80000111 },
    { type: "lifestoneClicked", guid: 0x80000222 },
  );
  assertEq(out, {
    state: { kind: "open", guid: 0x80000222 },
    action: { kind: "none" },
  }, "re-click new lifestone");
});

console.log("\n[4] decideLifestoneAction — wasm-export dispatch");

check("bind action + client.player.useObject → calls useObject(guid)", () => {
  const client = { player: { useObject: () => {}, recallToLifestone: () => {} } };
  const out = decideLifestoneAction({ kind: "bind", guid: 0x80000456 }, client);
  assertEq(out, { called: "useObject", args: [0x80000456] }, "bind → useObject");
});

check("bind action without useObject → no-op (logged-out)", () => {
  const out = decideLifestoneAction({ kind: "bind", guid: 0x80000456 }, {});
  assertEq(out, { called: null, args: [] }, "bind no-client");
});

check("bind guid coerced to u32", () => {
  const client = { player: { useObject: () => {} } };
  const out = decideLifestoneAction({ kind: "bind", guid: 0xFFFFFFFF }, client);
  assertEq(out.args[0], 0xFFFFFFFF >>> 0, "bind u32 coerce");
});

check("recall action + client.player.recallToLifestone → calls recallToLifestone()", () => {
  const client = { player: { useObject: () => {}, recallToLifestone: () => {} } };
  const out = decideLifestoneAction({ kind: "recall" }, client);
  assertEq(out, { called: "recallToLifestone", args: [] }, "recall → recallToLifestone");
});

check("recall action without recallToLifestone → no-op (logged-out)", () => {
  const client = { player: { useObject: () => {} } };
  const out = decideLifestoneAction({ kind: "recall" }, client);
  assertEq(out, { called: null, args: [] }, "recall no-fn");
});

check("cancel action → never dispatches", () => {
  const client = { player: { useObject: () => {}, recallToLifestone: () => {} } };
  const out = decideLifestoneAction({ kind: "cancel" }, client);
  assertEq(out, { called: null, args: [] }, "cancel never dispatches");
});

check("none action → never dispatches", () => {
  const client = { player: { useObject: () => {}, recallToLifestone: () => {} } };
  const out = decideLifestoneAction({ kind: "none" }, client);
  assertEq(out, { called: null, args: [] }, "none never dispatches");
});

console.log("\n[5] End-to-end — click → bind / click → recall / click → cancel");

check("e2e: click → bind → useObject called with guid", () => {
  let state = { kind: "idle" };
  let calls = [];
  const client = {
    player: {
      useObject: (g) => calls.push(["useObject", g >>> 0]),
      recallToLifestone: () => calls.push(["recallToLifestone"]),
    },
  };
  // 1. Click lifestone
  let out = nextStateForAction(state, { type: "lifestoneClicked", guid: 0x8000ABCD });
  state = out.state;
  assertEq(state, { kind: "open", guid: 0x8000ABCD }, "after click");
  // 2. User picks Bind
  out = nextStateForAction(state, { type: "bind" });
  state = out.state;
  const dispatch = decideLifestoneAction(out.action, client);
  if (dispatch.called === "useObject") {
    client.player.useObject(...dispatch.args);
  }
  assertEq(calls, [["useObject", 0x8000ABCD]], "bind wire");
  assertEq(state, { kind: "idle" }, "closed after bind");
});

check("e2e: click → recall → recallToLifestone called", () => {
  let state = { kind: "idle" };
  let calls = [];
  const client = {
    player: {
      useObject: (g) => calls.push(["useObject", g >>> 0]),
      recallToLifestone: () => calls.push(["recallToLifestone"]),
    },
  };
  let out = nextStateForAction(state, { type: "lifestoneClicked", guid: 0x8000ABCD });
  state = out.state;
  out = nextStateForAction(state, { type: "recall" });
  state = out.state;
  const dispatch = decideLifestoneAction(out.action, client);
  if (dispatch.called === "recallToLifestone") {
    client.player.recallToLifestone(...dispatch.args);
  }
  assertEq(calls, [["recallToLifestone"]], "recall wire");
  assertEq(state, { kind: "idle" }, "closed after recall");
});

check("e2e: click → cancel → no wire packets sent", () => {
  let state = { kind: "idle" };
  let calls = [];
  const client = {
    player: {
      useObject: (g) => calls.push(["useObject", g >>> 0]),
      recallToLifestone: () => calls.push(["recallToLifestone"]),
    },
  };
  let out = nextStateForAction(state, { type: "lifestoneClicked", guid: 0x8000ABCD });
  state = out.state;
  out = nextStateForAction(state, { type: "cancel" });
  state = out.state;
  const dispatch = decideLifestoneAction(out.action, client);
  // dispatch.called should be null for cancel
  assertEq(dispatch, { called: null, args: [] }, "cancel no-dispatch");
  assertEq(calls, [], "no wire packets");
  assertEq(state, { kind: "idle" }, "closed after cancel");
});

console.log("\n===========================================================");
console.log(`PASS: ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.log(`FAIL: ${failed}`);
  process.exit(1);
}

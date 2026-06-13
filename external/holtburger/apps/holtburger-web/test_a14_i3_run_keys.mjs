// A14-I3 (2026-06-12 unification survey, Stage I3) — retail run keys.
//
// Survey: docs/2026-06-11-unification-survey/agents/A14-input-to-motion.md
// §4 Stage I3 (+ §3 rows 5/8); W5-REMAINDER row A14-I3.
//
// Retail computes the effective run gait as Shift XOR the persisted
// "Toggle Run" option (`CommandInterpreter::SetHoldRun`,
// acclient.c:716978 / 0x6B3370: `(hold_run==0) != (option==0)`), and has
// a bound-key autorun toggle (`ToggleAutoRun` → `SetAutoRun`,
// acclient.c:717657 / :718254) whose `auto_run` state forces forward+Run
// in `ApplyCurrentMovement` (acclient.c:717027-717064). Ours hardcoded
// `run = !shift` at four sites and had no autorun at all.
//
//   PART 1 — flag parse: `?retailRunKeys=on` matrix.
//   PART 2 — option read priority: wasm `isCharacterOptionEnabled(0x0A)`
//            (server-authoritative) > options-panel localStorage cache >
//            default TRUE (preserves run-by-default when untouched).
//   PART 3 — resolveRunModifier truth table: flag-off = legacy `!shift`
//            byte-identical; flag-on = shift XOR option.
//   PART 4 — static: all four run sites route through resolveRunModifier;
//            the keymap Autorun row + the index.html setAutoRun
//            typeof-guard (stale-pkg soft-degrade) are wired; the wasm
//            export + recv arm + MovementSystem field exist.
//
// The autorun MOTION half is wasm-side (MovementSystem::set_auto_run) and
// is pinned by 5 Rust tests in
// crates/holtburger-core/src/client/movement/system/tests.rs.
//
// Run:
//   cd apps/holtburger-web/
//   node test_a14_i3_run_keys.mjs

import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

// Import AFTER defining the harness (module is window-guarded; no DOM
// needed at import time).
const input = await import("./scene3d/input.js");
const {
  readRetailRunKeysFlag,
  retailRunKeysOn,
  resolveRunModifier,
  toggleRunOptionEnabled,
  RUN_AS_DEFAULT_MOVEMENT_OPTION,
  _resetRetailRunKeysForTest,
} = input;

function withEnv({ search = "", lsTable = null }, fn) {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
  const hadLs = Object.prototype.hasOwnProperty.call(globalThis, "localStorage");
  const prevWindow = globalThis.window;
  const prevLs = globalThis.localStorage;
  globalThis.window = { location: { search } };
  globalThis.localStorage = {
    getItem: (k) =>
      lsTable && Object.prototype.hasOwnProperty.call(lsTable, k)
        ? lsTable[k]
        : null,
  };
  _resetRetailRunKeysForTest();
  try {
    return fn();
  } finally {
    if (hadWindow) globalThis.window = prevWindow;
    else delete globalThis.window;
    if (hadLs) globalThis.localStorage = prevLs;
    else delete globalThis.localStorage;
    _resetRetailRunKeysForTest();
  }
}

// ---------------------------------------------------------------------
console.log("PART 1 — ?retailRunKeys flag parse");
// ---------------------------------------------------------------------

check("explicit search 'on' parses true", readRetailRunKeysFlag("?retailRunKeys=on") === true);
check("explicit search 'ON' parses true (case-fold)", readRetailRunKeysFlag("?retailRunKeys=ON") === true);
check("explicit search 'off' parses false", readRetailRunKeysFlag("?retailRunKeys=off") === false);
check("absent parses false (default-off)", readRetailRunKeysFlag("?foo=1") === false);
check("empty search parses false", readRetailRunKeysFlag("") === false);
check("no-window no-arg parses false (never throws)", (() => {
  _resetRetailRunKeysForTest();
  return readRetailRunKeysFlag() === false;
})());
check("option index is retail RunAsDefaultMovement 0x0A", RUN_AS_DEFAULT_MOVEMENT_OPTION === 0x0a);

// ---------------------------------------------------------------------
console.log("PART 2 — ToggleRun option read priority");
// ---------------------------------------------------------------------

withEnv({ search: "?retailRunKeys=on" }, () => {
  const handleOn = { isCharacterOptionEnabled: (idx) => idx === 0x0a };
  const handleOff = { isCharacterOptionEnabled: () => false };
  const handleThrows = {
    isCharacterOptionEnabled: () => {
      throw new Error("unknown index");
    },
  };
  check("handle getter true wins", toggleRunOptionEnabled(handleOn) === true);
  check("handle getter false wins", toggleRunOptionEnabled(handleOff) === false);
  check("no handle, no LS → default TRUE (run-by-default preserved)", toggleRunOptionEnabled(null) === true);
  check("handle getter throw falls through to default TRUE", toggleRunOptionEnabled(handleThrows) === true);
});

withEnv({
  search: "?retailRunKeys=on",
  lsTable: {
    holtburger_character_options_v1: JSON.stringify({ 10: false }),
  },
}, () => {
  check("LS cache false read when no handle (options-panel shape, key '10')", toggleRunOptionEnabled(null) === false);
  const handleOn = { isCharacterOptionEnabled: () => true };
  check("handle getter outranks the LS cache", toggleRunOptionEnabled(handleOn) === true);
});

withEnv({
  search: "?retailRunKeys=on",
  lsTable: { holtburger_character_options_v1: "{not json" },
}, () => {
  check("malformed LS JSON falls through to default TRUE", toggleRunOptionEnabled(null) === true);
});

// ---------------------------------------------------------------------
console.log("PART 3 — resolveRunModifier truth table");
// ---------------------------------------------------------------------

withEnv({ search: "" }, () => {
  check("flag OFF: no shift → run (legacy)", resolveRunModifier(false, null) === true);
  check("flag OFF: shift → walk (legacy)", resolveRunModifier(true, null) === false);
  // Flag off must NEVER consult the option (byte-identical guarantee).
  let consulted = false;
  const spyHandle = {
    isCharacterOptionEnabled: () => {
      consulted = true;
      return false;
    },
  };
  resolveRunModifier(false, spyHandle);
  check("flag OFF never consults the option", consulted === false);
  check("flag cache reports off", retailRunKeysOn() === false);
});

withEnv({ search: "?retailRunKeys=on" }, () => {
  const opt = (v) => ({ isCharacterOptionEnabled: () => v });
  // run = shift XOR option (retail SetHoldRun, acclient.c:716978)
  check("ON: option=1, shift=0 → run (== legacy default)", resolveRunModifier(false, opt(true)) === true);
  check("ON: option=1, shift=1 → walk (== legacy)", resolveRunModifier(true, opt(true)) === false);
  check("ON: option=0, shift=0 → walk (retail walk-by-default)", resolveRunModifier(false, opt(false)) === false);
  check("ON: option=0, shift=1 → run (shift promotes)", resolveRunModifier(true, opt(false)) === true);
  check("flag cache reports on", retailRunKeysOn() === true);
});

// ---------------------------------------------------------------------
console.log("PART 4 — static wiring");
// ---------------------------------------------------------------------

const indexSrc = readFileSync(joinPath(__dirname, "index.html"), "utf8");
const cameraSrc = readFileSync(joinPath(__dirname, "scene3d", "camera.js"), "utf8");
const keymapSrc = readFileSync(joinPath(__dirname, "ui", "keymap.js"), "utf8");
const libSrc = readFileSync(joinPath(__dirname, "src", "lib.rs"), "utf8");
const systemSrc = readFileSync(
  joinPath(__dirname, "..", "..", "crates", "holtburger-core", "src", "client", "movement", "system.rs"),
  "utf8",
);

check(
  "index.html has NO remaining legacy run assignment",
  !/const run = !keyState\.shift;/.test(indexSrc),
);
check(
  "index.html routes both run sites through __resolveRunModifier",
  (indexSrc.match(/__resolveRunModifier\(keyState\.shift, handle\)/g) || []).length === 2,
);
check(
  "camera.js has NO remaining legacy run assignment",
  !/const run = !k\.shift;/.test(cameraSrc),
);
check(
  "camera.js routes both run sites through resolveRunModifier",
  (cameraSrc.match(/resolveRunModifier\(k\.shift/g) || []).length === 2,
);
check(
  "keymap.js carries the rebindable Autorun local action (default KeyR)",
  /labelHash: "0xFF000015", label: "Autorun \(toggle\)", defaultCode: "KeyR"/.test(keymapSrc) &&
    /AUTORUN:\s+"0xFF000015"/.test(keymapSrc),
);
check(
  "index.html autorun toggle is flag-gated + typeof-guards setAutoRun",
  /RETAIL_RUN_KEYS_ON && !ev\.repeat && handle/.test(indexSrc) &&
    /typeof handle\.setAutoRun === "function"/.test(indexSrc),
);
check(
  "wasm bridge: setAutoRun export + SetAutoRun command + recv arm",
  /js_name = setAutoRun/.test(libSrc) &&
    /SetAutoRun \{ on: bool \}/.test(libSrc) &&
    /SessionCommand::SetAutoRun \{ on \}/.test(libSrc),
);
check(
  "MovementSystem carries auto_run + the overlay (retail ApplyCurrentMovement branch)",
  /auto_run: bool,/.test(systemSrc) &&
    /fn set_auto_run\(&mut self, on: bool\)/.test(systemSrc) &&
    /fn overlay_auto_run\(base: MotionState\)/.test(systemSrc),
);

// ---------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

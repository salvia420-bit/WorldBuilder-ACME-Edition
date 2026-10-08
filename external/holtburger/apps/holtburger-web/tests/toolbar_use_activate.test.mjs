// tests/toolbar_use_activate.test.mjs — items-3 follow-up (2026-10-08).
//
// The toolbar's Use button (plugins/target-bar.js onUseClick, retail
// gmToolbarUI 0x1000019D → ItemHolder::UseObject(selectedID),
// acclient.c:433354) sent a bare useObject even for an item in the pack, so
// a selected sword / shirt / kit did nothing (ACE has no wield path behind
// Use). It now takes the same route as a shortcut key and the selected-item
// Use button: plugins/inventory_helpers.js activateOrUse → window.__inventory
// .activateItem (wield / wear / salvage / target mode), and a plain Use only
// when that declines — a world object, or `?hotbarActivate=off` (the
// activateItem wrapper returns false). The DOM wiring is pinned by
// test_toolbar_mount_smoke.mjs.
//
// Run from apps/holtburger-web/:  node tests/toolbar_use_activate.test.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { activateOrUse } = await import(
  pathToFileURL(path.join(HERE, "..", "plugins", "inventory_helpers.js")).href
);

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
}

function rig(activateResult) {
  const log = [];
  return {
    log,
    activate: activateResult === undefined ? undefined : (g) => {
      log.push(["activate", g]);
      if (activateResult instanceof Error) throw activateResult;
      return typeof activateResult === "function" ? activateResult(g) : activateResult;
    },
    use: (g) => log.push(["use", g]),
  };
}

console.log("\n[1] routing");
check("an owned item activateItem handles → no Use event", () => {
  const r = rig(true);
  assert.equal(activateOrUse(0x60000001, r), "activated");
  assert.deepEqual(r.log, [["activate", 0x60000001]]);
});
check("activateItem declines (world object / ?hotbarActivate=off) → plain Use", () => {
  const r = rig(false);
  assert.equal(activateOrUse(0x80000AAA, r), "used");
  assert.deepEqual(r.log, [["activate", 0x80000AAA], ["use", 0x80000AAA]]);
});
check("only a literal `true` counts as handled (a truthy non-boolean is not)", () => {
  const r = rig(1);
  assert.equal(activateOrUse(5, r), "used");
});
check("no inventory plugin loaded → plain Use", () => {
  const r = rig(undefined);
  assert.equal(activateOrUse(7, r), "used");
  assert.deepEqual(r.log, [["use", 7]]);
});
check("activateItem throws → no follow-up Use (it may already have sent a wield)", () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const r = rig(new Error("boom"));
    assert.equal(activateOrUse(9, r), "none");
    assert.deepEqual(r.log, [["activate", 9]]);
  } finally { console.warn = warn; }
});
check("no selection / no use function → none", () => {
  const r = rig(false);
  assert.equal(activateOrUse(0, r), "none");
  assert.equal(r.log.length, 0);
  assert.equal(activateOrUse(3, { activate: () => false }), "none");
});
check("the guid is passed unsigned", () => {
  const r = rig(false);
  activateOrUse(-1, r);
  assert.deepEqual(r.log, [["activate", 0xFFFFFFFF], ["use", 0xFFFFFFFF]]);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);

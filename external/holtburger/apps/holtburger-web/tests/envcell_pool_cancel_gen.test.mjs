// tests/envcell_pool_cancel_gen.test.mjs — 2026-10-18 review §7 follow-up
// (stream-statics, 10-07 review §4; `?drawPools` only, default OFF).
//
// buildEnvCellsForLandblock's post-compile cancel path (the build's generation
// no longer matches) released the landblock's pooled cells unconditionally. A
// cancel because a NEWER build of the same landblock started is not an
// eviction: that build released this one's pooled cells at its own Step D
// ("RELEASE BEFORE RE-FEED") and may have fed its own since, so the old build's
// release took the newer build's interior out of the pools. The walls-first
// `dropOwnWalls` path was already generation-guarded; the cancel path now goes
// through `releaseCancelledBuildPools`, which releases only when the landblock
// has no generation (evicted).
//
//   C1 evicted (no generation): the pools are released
//   C2 superseded by a newer build (a newer generation): left alone
//   C3 the cancel branch calls the helper (and no bare release remains there)
//
// Run: node tests/envcell_pool_cancel_gen.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

globalThis.location = { search: "" };
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { releaseCancelledBuildPools } = await import("../scene3d/cells.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  [PASS] ${name}`); }
  catch (e) { failed += 1; console.log(`  [FAIL] ${name} — ${e.message}`); }
}

const LB = 0x86020000;
const recorder = () => {
  const calls = [];
  return { calls, release: (lb) => calls.push(lb >>> 0) };
};

check("C1 evicted (the landblock has no build generation): its pooled cells are released", () => {
  const r = recorder();
  const scene3d = { envCellBuildGen: new Map() };
  assert.equal(releaseCancelledBuildPools(scene3d, LB, r.release), true);
  assert.deepEqual(r.calls, [LB]);
});
check("C2 superseded by a newer build: the newer build's pooled cells stay", () => {
  const r = recorder();
  const scene3d = { envCellBuildGen: new Map([[LB, 7]]) };
  assert.equal(releaseCancelledBuildPools(scene3d, LB, r.release), false);
  assert.deepEqual(r.calls, []);
});
check("C3 the post-compile cancel branch goes through the helper", () => {
  const src = readFileSync(path.join(APP, "scene3d", "cells.js"), "utf8");
  const at = src.indexOf("if (scene3d.envCellBuildGen.get(lbKey) !== buildGen) {");
  assert.ok(at > 0, "anchor drifted");
  const branch = src.slice(at, src.indexOf("return", at));
  assert.match(branch, /releaseCancelledBuildPools\(scene3d, lbKey\);/);
  assert.doesNotMatch(branch, /^\s*releasePooledCellsForLb\(lbKey\);/m);
});

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);

// tests/shell_diag_guid_caps.test.mjs — 2026-10-18 review, SHELL-4 / SHELL-5.
//
// Two default-on diag surfaces kept one entry per guid for the whole session
// and never dropped any: `__diag.remoteSync.byGuid` (a 64-record ring per
// moving remote, ~13 KB at a full ring) and `__diag.motion.byGuid` (a current
// snapshot + 20 transitions per guid that ever changed cycle). Every monster
// respawn is a fresh guid, so a long session (roaming, a grind bot) grew the
// heap without bound. Both maps are now LRUs in Map insertion order: a touch
// re-inserts the entry, a new guid past the cap drops the least recently
// touched one.
//
// Real modules, imported: scene3d/diag/remote_sync.js, scene3d/diag/motion.js.
//
// Run from apps/holtburger-web/:  node tests/shell_diag_guid_caps.test.mjs

import assert from "node:assert/strict";
import { createRemoteSync, MAX_GUIDS } from "../scene3d/diag/remote_sync.js";
import { attachMotion } from "../scene3d/diag/motion.js";

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.stack || e.message}`); }
}

const BASE = 0x80000000;

console.log("\nSHELL-4: __diag.remoteSync keeps at most MAX_GUIDS remotes");
check("300 runners → the 256 most recently updated are kept, the rest counted as dropped", () => {
  assert.equal(MAX_GUIDS, 256);
  let now = 0;
  const rs = createRemoteSync(() => (now += 10));
  const run = (g) => rs.onWirePose(g, `R${g & 0xffff}`, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 4 });
  const KEEP = BASE; // a remote that keeps moving the whole time
  for (let i = 1; i <= 300; i += 1) {
    run(BASE + i);
    run(KEEP);
  }
  assert.equal(rs.byGuid.size, MAX_GUIDS);
  assert.ok(rs.byGuid.has(KEEP), "a remote updated all along is never the one dropped");
  assert.equal(rs.byGuid.get(KEEP).updates, 300, "and keeps its own tallies");
  assert.ok(rs.byGuid.has(BASE + 300) && rs.byGuid.has(BASE + 46), "the newest are kept");
  assert.ok(!rs.byGuid.has(BASE + 1) && !rs.byGuid.has(BASE + 45), "the least recently updated went first");
  const s = rs.summary();
  assert.equal(s.remotes, MAX_GUIDS);
  assert.equal(s.droppedRemotes, 301 - MAX_GUIDS);
  assert.ok(rs.tail.length <= 200, "the shared tail stays bounded");
  rs.reset();
  assert.equal(rs.byGuid.size, 0);
  assert.equal(rs.summary().droppedRemotes, 0);
});
check("cast hooks touch the same LRU (a casting remote is recent)", () => {
  const rs = createRemoteSync(() => 0);
  rs.onCastGesture(BASE, 0x4000002c, true, true, "Caster");
  for (let i = 1; i < MAX_GUIDS; i += 1) rs.onWirePose(BASE + i, "", { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 4 });
  rs.onCastAction(BASE, 0x1000006f, true, "Caster");
  rs.onWirePose(BASE + MAX_GUIDS, "", { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 4 });
  assert.ok(rs.byGuid.has(BASE), "the caster was touched last-but-one");
  assert.ok(!rs.byGuid.has(BASE + 1), "the oldest runner went instead");
  assert.equal(rs.byGuid.get(BASE).cast.gestures, 1);
  assert.equal(rs.byGuid.get(BASE).cast.actions, 1);
});
check("negative control: under the cap nothing is dropped", () => {
  const rs = createRemoteSync(() => 0);
  for (let i = 0; i < 10; i += 1) rs.onWirePose(BASE + i, "", { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 4 });
  assert.equal(rs.byGuid.size, 10);
  assert.equal(rs.summary().droppedRemotes, 0);
});

console.log("\nSHELL-5: __diag.motion keeps at most maxGuids entities");
const inst = (key, name) => ({ currentActionKey: key, meta: { name }, _unifiedLoco: null });
check("600 entities changing cycle → the 512 latest are kept, history intact", () => {
  const diag = {};
  attachMotion(diag);
  const m = diag.motion;
  assert.equal(m.maxGuids, 512);
  const KEEP = BASE;
  m.onMotionApplied(KEEP, inst("1:2:0x41000003:0x8000003d", "Keeper"));
  for (let i = 1; i <= 600; i += 1) {
    m.onMotionApplied(BASE + i, inst("1:2:0x45000005:0x8000003d", ""));
    m.onMotionApplied(KEEP, inst(`1:2:0x4500000${i % 2 ? 5 : 7}:0x8000003d`, "Keeper"));
  }
  assert.equal(m.byGuid.size, 512);
  assert.ok(m.byGuid.has(KEEP));
  assert.equal(m.byGuid.get(KEEP).history.length, m.maxPerGuidHistory, "the per-guid ring is unchanged");
  assert.ok(m.byGuid.has(BASE + 600) && !m.byGuid.has(BASE + 89), "least recent dropped first");
  assert.ok(m.byGuid.has(BASE + 90));
  assert.equal(m.coverageSummary().totalPlays > 600, true, "the coverage matrix still counts every play");
  m.reset();
  assert.equal(m.byGuid.size, 0);
});
check("a late name still fills in on a touched entry", () => {
  const diag = {};
  attachMotion(diag);
  diag.motion.onMotionApplied(BASE, inst("1:2:0x41000003:0x8000003d", ""));
  diag.motion.onMotionApplied(BASE, inst("1:2:0x41000003:0x8000003d", "Drudge Skulker"));
  assert.equal(diag.motion.snapshot(BASE).name, "Drudge Skulker");
  assert.equal(diag.motion.snapshot(BASE).history.length, 1, "an unchanged key pushes no transition");
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);

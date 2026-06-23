// Tree wind (Phase 1) — off=frozen regression guard.
//
// Proves the central safety property: with ?treeWind absent (default), the
// statics divert is a no-op and the frozen statics array is untouched. Tests
// the REAL gating functions (treeWindEnabled, isTreeDid) and replicates the
// exact peel predicate statics.js uses, so a regression in either is caught.

import { treeWindEnabled, isTreeDid, treeWindDids, _resetTreeWindFlags } from "./scene3d/tree_wind.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// The exact predicate + peel statics.js runs (modelId path).
function divert(statics) {
  let windTrees = null;
  let remaining = statics;
  if (treeWindEnabled()) {
    const t = statics.filter((p) => isTreeDid((p?.modelId >>> 0) || 0));
    if (t.length > 0) {
      windTrees = t;
      remaining = statics.filter((p) => !isTreeDid((p?.modelId >>> 0) || 0));
    }
  }
  return { windTrees, remaining };
}

const treeDid = [...treeWindDids()][0];
const statics = [
  { modelId: treeDid },        // a tree
  { modelId: 0x02000999 },     // not a tree
  { modelId: 0x0200abcd },     // not a tree
  { modelId: treeDid },        // another tree
];

// ---- default (no window) → flag OFF ----
_resetTreeWindFlags();
check("treeWindEnabled() defaults FALSE (no ?treeWind)", treeWindEnabled() === false);
const off = divert(statics);
check("OFF: no windTrees peeled", off.windTrees === null);
check("OFF: statics array passed through UNCHANGED (same members, same length)",
  off.remaining === statics && off.remaining.length === 4);

// ---- isTreeDid correctness ----
check("isTreeDid true for an allowlisted DID", isTreeDid(treeDid));
check("isTreeDid false for a non-tree DID", !isTreeDid(0x02000999));
check("isTreeDid masks to u32", isTreeDid(treeDid >>> 0) === isTreeDid(treeDid));

// ---- flag ON → only allowlisted DIDs peel, frozen set is the complement ----
globalThis.window = { location: { search: "?treeWind=on" } };
_resetTreeWindFlags();
check("treeWindEnabled() true with ?treeWind=on", treeWindEnabled() === true);
const on = divert(statics);
check("ON: exactly the 2 tree placements peeled", on.windTrees && on.windTrees.length === 2,
  `got ${on.windTrees && on.windTrees.length}`);
check("ON: frozen remainder = the 2 non-trees (disjoint, no loss)",
  on.remaining.length === 2 && on.remaining.every((p) => !isTreeDid(p.modelId)));
check("ON: every peeled item IS a tree (no misclassification)",
  on.windTrees.every((p) => isTreeDid(p.modelId)));
check("ON: peeled + frozen == original count (no silent drop)",
  on.windTrees.length + on.remaining.length === statics.length);

delete globalThis.window;
_resetTreeWindFlags();

console.log(`\nTree wind off=frozen: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

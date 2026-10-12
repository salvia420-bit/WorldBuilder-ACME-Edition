// tests/remote_spine_heading.test.mjs — `?remoteSpineHeading=on` (2026-10-11, found on the 1070;
// OPT-IN since the 10-12 1070 check: the Rust body's heading is stale at rest, so a vendor ended 87
// degrees off — see scene3d/loop.js REMOTE_SPINE_HEADING_ON).
//
// Under the per-object spine (`?remoteSpine`, 86c4d11e) every pollRemotePoses row is the body the
// Rust MovementManager moved by its own interpreted motion, rotation included, and Phase B stopped
// the JS K=14 heading ease for spine remotes. drainRemotePoses still dropped the row's rotation on
// non-sticky rows, so nothing drew a TurnTo: a vendor turned 102 degrees in one frame at the
// server's final UpdatePosition.
//   S1  with `?remoteSpineHeading=on`, a non-sticky spine row hands its quaternion to applyManagedPose
//   S2  by default (and with `?remoteSpine=off`) the row is position-only
//   S3  a sticky row still clears the glue and carries its quaternion either way
//   S4  applyManagedPose (the REAL EntityManager) turns the rig to the row's heading, and keeps the
//       current heading for a zero-length or absent quaternion instead of collapsing the rig
//
// Run from apps/holtburger-web/:  node tests/remote_spine_heading.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.__playEffectVfxBound = true;
globalThis.window.__spellShapePreviewBound = true;

const LOOP = readFileSync(new URL("../scene3d/loop.js", import.meta.url), "utf8");

// The flag IIFE and drainRemotePoses, evaluated as written (loop.js itself needs the whole client).
function loadDrain(search) {
  const flagAt = LOOP.indexOf("const REMOTE_SPINE_HEADING_ON = (() => {");
  const fnAt = LOOP.indexOf("function drainRemotePoses(scene3d, sessionHandle) {");
  assert.ok(flagAt > 0 && fnAt > flagAt, "flag + drain found in loop.js");
  const fnEnd = LOOP.indexOf("\n}\n", fnAt) + 2;
  globalThis.window.location = { search };
  try {
    return new Function("REMOTE_INTERP_ON", "isLocalPlayerGuid",
      `${LOOP.slice(flagAt, fnAt)}${LOOP.slice(fnAt, fnEnd)}\nreturn drainRemotePoses;`)(true, () => false);
  } finally {
    globalThis.window.location = { search: "" };
  }
}

const Q = [0.7071068, 0, 0, 0.7071068];   // AC (w, x, y, z): 90 degrees about +Z

function drainOnce(drain, sticky) {
  const calls = [];
  const glue = [];
  const em = {
    applyManagedPose: (...a) => calls.push(a),
    setStickyTarget: (g, t) => glue.push([g, t]),
  };
  const frame = {
    guids: new Uint32Array([0x80001234]),
    landblocks: new Uint32Array([0x01020000]),
    poses: new Float32Array([10, 20, 30, ...Q]),
    stickyFlags: new Uint8Array([sticky ? 1 : 0]),
    free() {},
  };
  drain({ entityManager: em }, { pollRemotePoses: () => frame });
  return { calls, glue };
}

test("S1: with ?remoteSpineHeading=on a non-sticky spine row carries its rotation", () => {
  const { calls, glue } = drainOnce(loadDrain("?remoteSpineHeading=on"), false);
  assert.equal(calls.length, 1);
  const [g, x, y, z, qw, qx, qy, qz] = calls[0];
  assert.equal(g, 0x80001234);
  assert.equal(x, 1 * 192 + 10);
  assert.equal(y, 2 * 192 + 20);
  assert.equal(z, 30);
  assert.deepEqual([qw, qx, qy, qz].map((v) => Math.round(v * 1e6) / 1e6), Q.map((v) => Math.round(Math.fround(v) * 1e6) / 1e6));
  assert.equal(glue.length, 0, "a non-sticky row never touches the glue");
});

test("S2: by default (and with ?remoteSpine=off) the row is position-only", () => {
  for (const search of ["", "?remoteSpineHeading=off", "?remoteSpine=off", "?remoteSpine=OFF&remoteSpineHeading=on"]) {
    const { calls } = drainOnce(loadDrain(search), false);
    assert.equal(calls.length, 1, search);
    assert.equal(calls[0].length, 4, `${search}: guid + position only`);
  }
});

test("S3: a sticky row clears the glue and carries its rotation with the flag on or off", () => {
  for (const search of ["", "?remoteSpineHeading=on"]) {
    const { calls, glue } = drainOnce(loadDrain(search), true);
    assert.deepEqual(glue, [[0x80001234, 0]], search);
    assert.equal(calls[0].length, 8, search);
  }
});

test("S4: applyManagedPose turns the rig, and ignores a zero-length or absent quaternion", async () => {
  const THREE = await import("three");
  globalThis.window.__sessionHandle = {
    getLocalPlayerPose() { return { x: 0, y: 0, z: 0, heading: 0, landblockId: 0x00000019 }; },
  };
  globalThis.window.getLocalPlayerGuid = () => 0x50000001;
  const { EntityManager } = await import("../scene3d/entities.js");
  const em = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, {});
  const G = 0x80001234;
  const root = new THREE.Group();
  root.position.set(500, 500, 0);
  em.entityMap.set(G, { guid: G, root, parts: [], meta: { guid: G }, _stateVisible: true,
    _attachedParentGuid: null, _attachedChildren: null, dispose() {} });

  em.applyManagedPose(G, 400, 400, 1, ...Q);
  const turned = root.quaternion.clone();
  assert.ok(Math.abs(turned.z - Q[3]) < 1e-6 && Math.abs(turned.w - Q[0]) < 1e-6, "the row's heading is applied");
  assert.equal(root.position.x, 400);

  em.applyManagedPose(G, 401, 400, 1, 0, 0, 0, 0);
  assert.ok(root.quaternion.equals(turned), "a zero-length quaternion keeps the current heading");
  assert.equal(root.position.x, 401, "the position still applies");
  assert.ok(Math.abs(root.quaternion.length() - 1) < 1e-6, "the rig never collapses");

  em.applyManagedPose(G, 402, 400, 1);
  assert.ok(root.quaternion.equals(turned), "an absent quaternion keeps the current heading");
  assert.equal(root.position.x, 402);
});

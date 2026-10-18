// tests/remote_settle.test.mjs — spawnz (2026-10-18), `?remoteSettle` (DEFAULT ON; `=off`/`0`/`false`).
//
// Owner report: "some monsters spawned up in the air while they were on a hill". ACE's scatter spawn
// keeps the generator's Z when the ground under the scattered spot is more than 10 m lower
// (`ScatterThreshold_Z`, ACE PhysicsObj.cs:1393-1440 — the live ACE_Log.txt holds 771 such spawns,
// 10–67 m up) and ACE never moves an idle creature, so the CreateObject arrives in the air. Retail's
// client drops it (enter_world placement, then gravity in UpdatePhysicsInternal, acclient.c:323441 /
// :317701). The fall itself lives in the wasm remote body (Rust tests:
// crates/holtburger-world/src/spatial/remote_settle_tests.rs). This file pins the JS half and the
// wasm wiring no Rust test reaches:
//   S1  rows for a rig still being built are parked (latest wins) and replayed at its spawn commit,
//       so the rig appears where the body landed, not at the floating CreateObject Z
//   S2  `?remoteSettle=off` / `=0` / `=false` park nothing (the legacy drop)
//   S3  a built rig takes the row directly; a non-finite row is never parked; `?remoteInterp=off`
//       parks nothing
//   S4  the wasm wiring: the flag, the per-slice settle call, the collision-residency marks (after
//       every building/static drain), and the Region made resident before heightmaps decode
//
// Run from apps/holtburger-web/:  node tests/remote_settle.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.__playEffectVfxBound = true;
globalThis.window.__spellShapePreviewBound = true;

const G = 0x8000b49c;
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

// A fresh EntityManager module per URL (the flags are read once at module load); `tag` makes the
// import URL unique so each search string gets its own module instance.
async function manager(search, tag) {
  const THREE = await import("three");
  globalThis.window.__sessionHandle = {
    getLocalPlayerPose() { return { x: 0, y: 0, z: 0, heading: 0, landblockId: 0x00000019 }; },
  };
  globalThis.window.getLocalPlayerGuid = () => 0x50000001;
  globalThis.window.location = { search };
  try {
    const { EntityManager } = await import(`../scene3d/entities.js?settle=${tag}`);
    const em = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, {});
    return { THREE, em };
  } finally {
    globalThis.window.location = { search: "" };
  }
}

// The minimal committed rig the other EntityManager tests use, standing at the floating Z.
function rig(THREE) {
  const root = new THREE.Group();
  root.position.set(500, 500, 40);
  return { guid: G, root, parts: [], meta: { guid: G }, _stateVisible: true,
    _attachedParentGuid: null, _attachedChildren: null, dispose() {} };
}

test("S1: rows for a rig still being built are parked (latest wins) and replayed at spawn commit", async () => {
  const { THREE, em } = await manager("", "s1");
  em.applyManagedPose(G, 500, 500, 39.5);
  em.applyManagedPose(G, 500, 500, 31.0);
  em.applyManagedPose(G, 500, 500, 25.2); // landed
  assert.ok(em._preCreate.hasFor(G, "managedPose"), "parked while the rig builds");
  assert.equal(em._preCreate.size(), 1, "dedupeKind: only the latest row is kept");

  const inst = rig(THREE);
  em.entityMap.set(G, inst);
  em._drainPreCreate(G);
  assert.equal(inst.root.position.z, 25.2, "the rig appears where the body landed");
  assert.equal(inst.root.position.x, 500);
  assert.equal(inst._serverTargetPos.z, 25.2, "the ease re-anchors on the landed pose");
  assert.ok((inst._wasmDriven | 0) > 0, "wasm ownership armed as for any managed row");
  assert.ok(!em._preCreate.hasFor(G), "consumed");
});

test("S2: ?remoteSettle=off / =0 / =false park nothing (the legacy drop)", async () => {
  for (const [search, tag] of [["?remoteSettle=off", "s2a"], ["?remoteSettle=0", "s2b"], ["?remoteSettle=FALSE", "s2c"]]) {
    const { em } = await manager(search, tag);
    em.applyManagedPose(G, 500, 500, 25.2);
    assert.ok(!em._preCreate.hasFor(G), search);
  }
});

test("S3: a built rig takes the row directly; non-finite rows and ?remoteInterp=off park nothing", async () => {
  const { THREE, em } = await manager("", "s3");
  const inst = rig(THREE);
  em.entityMap.set(G, inst);
  em.applyManagedPose(G, 501, 500, 25.2);
  assert.equal(inst.root.position.z, 25.2);
  assert.ok(!em._preCreate.hasFor(G), "nothing parked for a built rig");

  em.entityMap.delete(G);
  em.applyManagedPose(G, 501, 500, Number.NaN);
  assert.ok(!em._preCreate.hasFor(G), "a non-finite row is never parked");

  const off = await manager("?remoteInterp=off", "s3b");
  off.em.applyManagedPose(G, 501, 500, 25.2);
  assert.ok(!off.em._preCreate.hasFor(G), "no managed rows at all without the remote driver");
});

test("S4: the wasm wiring", () => {
  const ent = src("../scene3d/entities.js");
  assert.match(ent, /\.get\("remoteSettle"\)\?\.toLowerCase\(\);\s*return !\(v === "off" \|\| v === "0" \|\| v === "false"\);/,
    "JS reader: default on, off/0/false escape");
  assert.match(ent, /this\._preCreate\.enqueue\(g, "managedPose", \{ x: \+x, y: \+y, z: \+z \}, \{ dedupeKind: true \}\)/);
  assert.match(ent, /ev\.kind === "managedPose"\) \{[\s\S]{0,300}this\.applyManagedPose\(g, ev\.data\.x, ev\.data\.y, ev\.data\.z\)/);

  const lib = src("../src/lib.rs");
  assert.match(lib, /fn parse_remote_settle_flag\(search: &str\) -> bool \{[\s\S]{0,300}"remoteSettle=off" \| "remoteSettle=0" \| "remoteSettle=false"/);
  assert.match(lib, /set_remote_settle\(parse_remote_settle_flag\(&flag_search\(\)\)\)/);
  // Residency marks: each populate export marks its part only after it queued the geometry.
  assert.match(lib, /populate_building_aabbs_for_landblock_impl\(landblock_id\)\.await;\s*if queued\.is_ok\(\) \{\s*note_landblock_collision_part\(\s*landblock_id,\s*holtburger_world::spatial::LANDBLOCK_COLLISION_BUILDINGS/);
  assert.match(lib, /populate_statics_aabbs_for_landblock_impl\(landblock_id\)\.await;\s*if queued\.is_ok\(\) \{[\s\S]{0,400}LANDBLOCK_COLLISION_STATICS/);
  // The Region is resident before both terrain fetchers decode heights (table, not byte * 2).
  for (const fn of ["pub async fn fetch_landblock_heightmaps(", "pub async fn fetch_subdivided_landblocks("]) {
    const body = lib.slice(lib.indexOf(fn), lib.indexOf(fn) + 4000);
    const ensure = body.indexOf("ensure_region_resident(&source).await;");
    const resolve = body.indexOf("resolve_region_land_height_table()");
    assert.ok(ensure > 0 && resolve > ensure, `${fn} ensures the Region before decoding`);
  }

  const mv = src("../src/session/commands/movement.rs");
  const tris = mv.indexOf("drain_pending_building_physics_into(&mut w.scene)");
  const marks = mv.indexOf("drain_pending_landblock_collision_parts_into(&mut w.scene)");
  for (const drain of ["drain_pending_static_bsps_into(&mut w.scene)", "drain_pending_building_bsps_into(&mut w.scene)",
    "drain_pending_outdoor_overlap_bakes_into(&mut w.scene)", "drain_pending_building_aabbs_into(&mut w.scene)"]) {
    const at = mv.indexOf(drain);
    assert.ok(at > 0 && at < marks, `${drain} lands before the residency marks`);
  }
  assert.ok(tris > 0 && marks > tris, "marks drained after the building triangles");

  const rm = src("../../../crates/holtburger-world/src/state/remote_movement.rs");
  const step = rm.slice(rm.indexOf("pub fn step_remote_objects("));
  assert.ok(step.indexOf("start_remote_settles") > 0 &&
    step.indexOf("start_remote_settles") < step.indexOf("step_remote_position_managers"),
    "the settle starts before the slice moves the bodies (spine on and off)");
});

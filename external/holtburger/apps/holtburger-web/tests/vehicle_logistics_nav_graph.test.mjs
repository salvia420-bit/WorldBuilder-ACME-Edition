// tests/vehicle_logistics_nav_graph.test.mjs — F14 Logistics Nav Graph Validation Suite
// Verifies:
//   - logistics_nav_graph.json existence, schema, compact size, and dist/world mirror parity
//   - Determinism (zero Math.random() in baker + exact SHA-256 parity across re-bake)
//   - 101 canonical towns (60 Dereth + 41 Dericost aligned 1:1 with dericost_towns_index.json & TownRegistry)
//   - Strictly 11 Outer Ocean ports with (terrainCode & 0x1F) == 20 & trans-oceanic sea lane
//   - Road/spur slope bounds (<= 44 deg all, <= 25 deg std spurs, <= 40 deg 4WD-Low spurs), <= 96 m bridges
//   - Full multimodal reachability across all 101 towns & 11 ports + findRoadPath integration
//   - Strict Item 2 exclusion (0 Inner Sea / Port Yaraq / Port Direlands-East / 0x7A63 / 0x4866) + negative test

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bakeLogisticsNavGraph, OUTER_OCEAN_PORTS as BAKER_PORTS } from "../scripts/bake_logistics_nav_graph.mjs";
import { findRoadPath } from "../scene3d/vehicle/port_kinematics.js";
import { assertItem2Excluded, OUTER_OCEAN_PORTS } from "../harness/economy_e2e/e2e_helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");
const EXT_HOLTBURGER_ROOT = path.resolve(APP_ROOT, "..", "..");
const PRIMARY_JSON_PATH = path.join(APP_ROOT, "data", "logistics_nav_graph.json");
const MIRROR_JSON_PATH = path.join(EXT_HOLTBURGER_ROOT, "dist", "world", "logistics_nav_graph.json");
const DERICOST_TOWNS_PATH = path.join(EXT_HOLTBURGER_ROOT, "dist", "dericost", "towns", "dericost_towns_index.json");
const BAKER_SCRIPT_PATH = path.join(APP_ROOT, "scripts", "bake_logistics_nav_graph.mjs");

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [OK] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name}: ${e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e}`);
  }
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

console.log("=== vehicle_logistics_nav_graph.test.mjs ===");

let rawPrimary = "";
let graph = null;

await check("1. logistics_nav_graph.json exists, parses cleanly, < 5 MB, and mirrors dist/world", () => {
  assert.ok(existsSync(PRIMARY_JSON_PATH), `Missing primary nav graph: ${PRIMARY_JSON_PATH}`);
  rawPrimary = readFileSync(PRIMARY_JSON_PATH, "utf8");
  assert.ok(rawPrimary.length > 10000, "Nav graph JSON unexpectedly small");
  assert.ok(rawPrimary.length < 5 * 1024 * 1024, `Nav graph JSON too large: ${rawPrimary.length} bytes`);
  graph = JSON.parse(rawPrimary);
  assert.equal(graph.schema, "hb-logistics-nav-graph-v1");
  assert.equal(graph.version, 1);
  assert.equal(graph.dericostYOffset, 68928);

  if (existsSync(MIRROR_JSON_PATH)) {
    const rawMirror = readFileSync(MIRROR_JSON_PATH, "utf8");
    assert.equal(sha256(rawMirror), sha256(rawPrimary), "dist/world/logistics_nav_graph.json mirror differs from data/logistics_nav_graph.json");
  }
});

await check("2. Baker uses zero RNG and produces byte-for-byte deterministic output", () => {
  const bakerSrc = readFileSync(BAKER_SCRIPT_PATH, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\r\n]*/g, "");
  assert.equal(/Math\.random\s*\(/.test(bakerSrc), false, "bake_logistics_nav_graph.mjs must not call Math.random()");

  const rebake = bakeLogisticsNavGraph({ writeFiles: false });
  assert.equal(
    sha256(rebake.serialized),
    sha256(rawPrimary),
    "Re-baking logistics_nav_graph.json did not produce byte-for-byte identical output"
  );
});

await check("3. 101 towns (60 Dereth + 41 Dericost) align 1:1 with dericost_towns_index.json & TownRegistry", () => {
  assert.equal(graph.towns.length, 101);
  const dereth = graph.towns.filter((t) => t.continentId === 0);
  const dericost = graph.towns.filter((t) => t.continentId === 1);
  assert.equal(dereth.length, 60);
  assert.equal(dericost.length, 41);

  const ids = new Set(graph.towns.map((t) => t.townId));
  assert.equal(ids.size, 101);
  for (let id = 1; id <= 101; id++) assert.ok(ids.has(id), `Missing townId ${id}`);

  for (const t of graph.towns) {
    assert.ok(Number.isFinite(t.x) && Number.isFinite(t.y) && Number.isFinite(t.z), `Non-finite coords on ${t.name}`);
    assert.ok(typeof t.anchorLandblock === "string" && t.anchorLandblock.startsWith("0x"));
    assert.equal(
      t.anchorLandblockId,
      parseInt(t.anchorLandblock, 16) >>> 0,
      `Town ${t.townId} (${t.name}) anchorLandblockId ${t.anchorLandblockId} !== ${t.anchorLandblock}`
    );
    assert.ok(typeof t.nodeId === "string" && t.nodeId.startsWith("town_"));
  }
  for (const t of dericost) {
    assert.ok(t.y >= 68928, `Dericost town ${t.name} y=${t.y} < 68928`);
    assert.notEqual(
      t.anchorLandblockId & 0x8000,
      0,
      `Dericost town ${t.townId} (${t.name}) anchorLandblockId 0x${t.anchorLandblockId.toString(16)} missing 0x8000 bit`
    );
  }

  // Exact alignment with dericost_towns_index.json
  const idx = JSON.parse(readFileSync(DERICOST_TOWNS_PATH, "utf8"));
  assert.equal(idx.towns.length, 41);
  for (let i = 0; i < 41; i++) {
    const dt = idx.towns[i];
    const gt = dericost[i];
    assert.equal(gt.townId, 61 + i);
    assert.equal(gt.name, dt.name);
    assert.equal(gt.province, dt.province);
    assert.equal(gt.anchorLandblock, dt.serverCellId);
    assert.equal(
      gt.anchorLandblockId,
      parseInt(dt.serverCellId, 16) >>> 0,
      `Dericost town ${gt.townId} (${gt.name}) anchorLandblockId !== parseInt(${dt.serverCellId}, 16)`
    );
    assert.equal(gt.x, dt.x);
    assert.equal(gt.y, dt.y);
    assert.equal(gt.z, dt.z);
  }

  const t61 = graph.towns.find((t) => t.townId === 61);
  assert.equal(t61.name, "Vasmora");
  assert.equal(t61.anchorLandblock, "0x2CB28001");
  assert.equal(t61.anchorLandblockId, 0x2cb28001);

  // TownId 59 preserves TownRegistry anchorLandblock 0xB9730001 while snapping at (35676.6, 21712.5, 22.0)
  const t59 = graph.towns.find((t) => t.townId === 59);
  assert.equal(t59.name, "Yanshi North Outpost");
  assert.equal(t59.anchorLandblock, "0xB9730001");
  assert.equal(t59.x, 35676.6);
  assert.equal(t59.y, 21712.5);
  assert.equal(t59.z, 22.0);
});

await check("4. Strictly 11 Outer Ocean ports with (terrainCode & 0x1F) == 20 & NE<->Dericost sea lane", () => {
  assert.equal(graph.ports.length, 11);
  assert.equal(BAKER_PORTS.length, 11);
  const expectedNames = new Set(OUTER_OCEAN_PORTS.map((p) => p.name));
  const actualNames = new Set(graph.ports.map((p) => p.name));
  assert.deepEqual(actualNames, expectedNames);

  for (const p of graph.ports) {
    assert.equal(p.terrainCode & 0x1f, 20, `Port ${p.name} terrainCode ${p.terrainCode} invalid`);
    assert.equal(p.basin, "outer_ocean");
    assert.equal(
      p.landblockId,
      parseInt(p.lb, 16) >>> 0,
      `Port ${p.name} landblockId ${p.landblockId} !== ${p.lb}`
    );
    if (p.continentId === 1) {
      assert.notEqual(p.landblockId & 0x8000, 0, `Dericost port ${p.name} missing 0x8000 bit`);
    }
    assert.ok(Number.isFinite(p.seaX) && Number.isFinite(p.seaY));
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  }

  const transOcean = graph.seaLanes.find((l) => l.from === "port_1" && l.to === "port_2");
  assert.ok(transOcean, "Missing NE Marine Terminal <-> Dericost Landing sea lane");
  assert.equal(transOcean.fromLb, "0xEAF9");
  assert.equal(transOcean.toLb, "0x600D8001");
  assert.ok(transOcean.lengthM >= 30000 && transOcean.lengthM <= 50000, `Unexpected trans-oceanic length ${transOcean.lengthM}`);
  assert.ok(Array.isArray(transOcean.waypoints) && transOcean.waypoints.length >= 2);
});

await check("5. Road/spur slope bounds, road vertex counts, bridges <= 96 m, and island landings", () => {
  assert.equal(graph.summary.derethRoadVertices, 7945);
  assert.equal(graph.summary.dericostRoadVertices, 16643);
  assert.equal(graph.summary.roadVertexCount, 24588);
  assert.ok(graph.edges.length > 100);

  for (const e of graph.edges) {
    assert.ok(typeof e.gradeDeg === "number" && Number.isFinite(e.gradeDeg), `Missing gradeDeg on ${e.id}`);
    assert.ok(e.gradeDeg <= 44.0, `Edge ${e.id} gradeDeg ${e.gradeDeg} > 44`);
    assert.ok(typeof e.lengthM === "number" && e.lengthM >= 0);
    if (e.mode === "road" && e.isBridge) {
      assert.ok(e.lengthM <= 96.0, `Bridge edge ${e.id} length ${e.lengthM} > 96 m`);
    }
    if (e.mode === "spur") {
      if (e.is4wdLow) {
        assert.ok(e.gradeDeg <= 40.05, `4WD-Low spur ${e.id} grade ${e.gradeDeg} > 40`);
      } else {
        assert.ok(e.gradeDeg <= 25.05, `Standard spur ${e.id} grade ${e.gradeDeg} > 25`);
      }
    }
    if (e.mode === "sea") {
      assert.equal(e.gradeDeg, 0);
    }
  }

  for (const steepId of [37, 41, 42]) {
    const t = graph.towns.find((x) => x.townId === steepId);
    assert.equal(t.reachability, "spur_4wd_low_40deg", `Expected 4WD-Low spur for ${t.name}`);
  }
  assert.ok(graph.edges.some((e) => e.isFord), "Expected ford edges for Port Direlands-South");

  const landings = graph.nodes.filter((n) => n.kind === "coastal_landing");
  assert.equal(landings.length, 2, "Expected Halaetan & Aerlinthe coastal_landing nodes");
});

await check("6. All 101 towns & 11 ports are mutually reachable + findRoadPath works", () => {
  const adj = new Map();
  for (const n of graph.nodes) adj.set(n.id, []);
  for (const e of graph.edges) {
    assert.ok(adj.has(e.from) && adj.has(e.to), `Edge ${e.id} references unknown node`);
    adj.get(e.from).push(e.to);
    adj.get(e.to).push(e.from);
  }

  const visited = new Set(["town_1"]);
  const queue = ["town_1"];
  for (let i = 0; i < queue.length; i++) {
    for (const nxt of adj.get(queue[i])) {
      if (!visited.has(nxt)) {
        visited.add(nxt);
        queue.push(nxt);
      }
    }
  }

  for (const t of graph.towns) {
    assert.ok(visited.has(t.nodeId), `Unreachable town: ${t.townId} ${t.name}`);
  }
  for (const p of graph.ports) {
    assert.ok(visited.has(p.nodeId), `Unreachable port: ${p.portId} ${p.name}`);
  }

  // Verify port_kinematics.findRoadPath works directly on the baked graph
  const holtburgToEasthamPort = findRoadPath(graph, "town_1", "port_3");
  assert.ok(holtburgToEasthamPort.length >= 2, "findRoadPath failed for Holtburg -> Port Eastham");
  const neToDericost = findRoadPath(graph, "port_1", "port_2");
  assert.ok(neToDericost.length >= 2, "findRoadPath failed for NE Marine Terminal -> Dericost Landing");
});

await check("7. Strict Item 2 exclusion (zero Inner Sea tokens + assertItem2Excluded + negative guard)", () => {
  const lower = rawPrimary.toLowerCase();
  for (const forbidden of ["port yaraq", "portyaraq", "direlands-east", "direlands east", "inner_sea", "innersea", "0x7a63", "0x4866"]) {
    assert.equal(lower.includes(forbidden), false, `Forbidden Item 2 token '${forbidden}' found in JSON`);
  }

  const res = assertItem2Excluded(graph);
  assert.equal(res.towns, 101);
  assert.equal(res.derethCount, 60);
  assert.equal(res.dericostCount, 41);
  assert.equal(res.ports, 11);

  // Negative test: synthetic Item 2 injection MUST be rejected
  const badGraph = {
    towns: graph.towns,
    ports: graph.ports,
    seaLanes: [
      ...graph.seaLanes,
      { from: "Port Yaraq", to: "Port Direlands-East", fromLb: "0x7A63", toLb: "0x4866", mode: "sea", basin: "inner_sea" },
    ],
  };
  assert.throws(() => assertItem2Excluded(badGraph), /Forbidden Item 2|Inner Sea/i);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

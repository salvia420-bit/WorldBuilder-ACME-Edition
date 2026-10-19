// tests/passability_overlay.test.mjs — scene3d/passability_overlay.js, ground
// too steep to walk up tinted red around the player (VTank / RynthAi
// ShowTerrainPassability, 2026-10-19).
//
//   • the rule: unit normal z < FLOOR_Z (cos 48.4°, the f32 acclient
//     PhysicsGlobals::floor_z) per TRIANGLE, on the game's per-cell diagonal;
//   • the builder against an independent reference built from
//     scene3d/terrain_oracle.js (cellSwToNeCut + triangleGradInCell, the
//     validated port of the wasm terrain code) over random heights;
//   • the threshold on both sides (27.00 vs 27.03 m rise per 24 m cell);
//   • landblock crossing, missing landblocks, the lift over the drawn ground;
//   • the THREE layer (real `three` from node_modules): one draw call,
//     rebuilt only on a cell move of `rebuildCells` or a heights change;
//   • the page attach on a fake window: no timer while hidden, outdoors only,
//     portal space hides it, a scene swap re-attaches, dispose cleans up.
//
// Run from apps/holtburger-web/:  node tests/passability_overlay.test.mjs

import assert from "node:assert/strict";
import * as THREE from "three";

const P = await import("../scene3d/passability_overlay.js");
const { cellSwToNeCut, triangleGradInCell } = await import("../scene3d/terrain_oracle.js");

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 5).join("\n       ") : e}`);
  }
}
const near = (a, b, eps, msg) => assert.ok(Number.isFinite(a) && Math.abs(a - b) <= eps, `${msg || "near"}: ${a} vs ${b} (±${eps})`);

/** A landblock's 81 heights from f(vx, vy) (idx = vx·9 + vy, terrain.js). */
const heights = (f) => {
  const h = new Float32Array(81);
  for (let vx = 0; vx < 9; vx++) for (let vy = 0; vy < 9; vy++) h[vx * 9 + vy] = f(vx, vy);
  return h;
};
/** Deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** A global cell whose game cut is `swNe` (searched near a start cell). */
function cellWithCut(swNe, gx0 = 800, gy0 = 800) {
  for (let d = 0; d < 64; d++) {
    for (let gx = gx0; gx < gx0 + 8; gx++) {
      const gy = gy0 + d;
      if ((gx & 7) < 7 && (gy & 7) < 7 && cellSwToNeCut(gx, gy) === swNe) return { gx, gy };
    }
  }
  throw new Error("no cell found");
}
const LB = 192;

console.log("— the rule");

await check("FLOOR_Z is the f32 acclient floor_z (cos 48.38°); the walkable test is nz ≥ FLOOR_Z", () => {
  assert.equal(P.FLOOR_Z, Math.fround(0.66417414618662751));
  near(Math.acos(P.FLOOR_Z) * (180 / Math.PI), 48.381, 0.001, "angle");
  // a pure east slope: rise per 24 m cell 27.00 m is walkable, 27.03 m is not
  assert.ok(P.triangleNormalZ(27.0, 0) >= P.FLOOR_Z, `27.00 → ${P.triangleNormalZ(27.0, 0)}`);
  assert.ok(P.triangleNormalZ(27.03, 0) < P.FLOOR_Z, `27.03 → ${P.triangleNormalZ(27.03, 0)}`);
  assert.equal(P.triangleNormalZ(-27.03, 0), P.triangleNormalZ(27.03, 0), "downhill = uphill");
  // a diagonal slope: |grad| decides (19.0/19.0 walkable, 19.2/19.2 not)
  assert.ok(P.triangleNormalZ(19.0, 19.0) >= P.FLOOR_Z);
  assert.ok(P.triangleNormalZ(19.2, -19.2) < P.FLOOR_Z);
  assert.equal(P.triangleNormalZ(0, 0), 1, "flat");
  // a hole in the heights is never steep
  assert.equal(P.cellSteepMask(NaN, 0, 0, 0, true), 0);
});

await check("the cut decides which triangles are steep (one raised NE corner: SW→NE both halves, SE→NW only the NE half)", () => {
  // SW→NE: SE half (SW, SE, NE) rises 40 m north; NW half (SW, NE, NW) 40 m east → both steep
  assert.equal(P.cellSteepMask(0, 0, 0, 40, true), 3);
  // SE→NW: SW half (SW, SE, NW) is flat; NE half (SE, NE, NW) rises 40 m both ways → only it
  assert.equal(P.cellSteepMask(0, 0, 0, 40, false), 2);
  // and a raised SW corner the other way round
  assert.equal(P.cellSteepMask(40, 0, 0, 0, false), 1, "SE→NW: only the SW half");
  assert.equal(P.cellSteepMask(40, 0, 0, 0, true), 3, "SW→NE: both halves touch SW");
  assert.deepEqual(P.CELL_TRIANGLES.swNe, [[0, 1, 3], [0, 3, 2]]);
  assert.deepEqual(P.CELL_TRIANGLES.seNw, [[0, 1, 2], [1, 3, 2]]);
});

await check("cellSteepMask agrees with terrain_oracle.js triangleGradInCell on 20 000 random cells, both cuts", () => {
  const r = rng(7);
  const probe = { swNe: [[0.75, 0.25], [0.25, 0.75]], seNw: [[0.25, 0.25], [0.75, 0.75]] }; // a point inside each triangle
  let steep = 0;
  for (let i = 0; i < 20000; i++) {
    const h = [0, 1, 2, 3].map(() => (r() - 0.5) * 70);
    for (const cut of [true, false]) {
      const mask = P.cellSteepMask(h[0], h[1], h[2], h[3], cut);
      probe[cut ? "swNe" : "seNw"].forEach(([fx, fy], t) => {
        const [gx, gy] = triangleGradInCell(h[0], h[1], h[2], h[3], fx, fy, cut);
        const nz = 1 / Math.sqrt(1 + (gx / 24) ** 2 + (gy / 24) ** 2);
        assert.equal(!!(mask & (1 << t)), nz < P.FLOOR_Z, `cell ${i} cut ${cut} tri ${t}`);
        if (nz < P.FLOOR_Z) steep++;
      });
    }
  }
  assert.ok(steep > 5000 && steep < 75000, `a mix of steep and walkable (${steep})`);
});

console.log("\n— the builder");

await check("disc: 97 cells at R = 5 (dx² + dy² ≤ 30), symmetric; buffer sized for two triangles each", () => {
  const d = P.discOffsets(5);
  assert.equal(d.length / 2, 97);
  assert.equal(P.discOffsets(5), d, "memoised");
  for (let i = 0; i < d.length; i += 2) assert.ok(d[i] * d[i] + d[i + 1] * d[i + 1] <= 30);
  assert.equal(P.maxPassabilityVertices(5), 97 * 6);
  assert.equal(P.discOffsets(4).length / 2, 69, "RynthAi's radius 4 for comparison");
});

await check("builder == an independent oracle reference (random terrain over 4 landblocks, both cuts present)", () => {
  const r = rng(11);
  const lbs = new Map();
  for (const lx of [0x7f, 0x80]) for (const ly of [0x7f, 0x80]) lbs.set((lx << 8) | ly, { heights: heights(() => r() * 60) });
  // (independent random grids: every cell reads its own landblock's 9×9, as the builder must)
  const get = (lx, ly) => lbs.get((lx << 8) | ly) || null;
  const x = 0x80 * LB + 5;
  const y = 0x80 * LB + 30;
  const res = P.buildPassabilityGeometry(get, x, y, {});
  const cx = Math.floor(x / 24);
  const cy = Math.floor(y / 24);
  assert.deepEqual([res.cx, res.cy], [cx, cy]);
  assert.deepEqual([res.origin.x, res.origin.y, res.origin.z], [cx * 24, cy * 24, 0]);
  assert.equal(res.missing, 0);
  assert.equal(res.cells, 97);
  // the reference: every cell of the disc, its cut, the oracle gradient at an interior point of each half
  const want = new Set();
  let cuts = 0;
  const d = P.discOffsets(5);
  for (let i = 0; i < d.length; i += 2) {
    const gx = cx + d[i];
    const gy = cy + d[i + 1];
    const h = get(gx >> 3, gy >> 3).heights;
    const vx = gx & 7;
    const vy = gy & 7;
    const c = [h[vx * 9 + vy], h[(vx + 1) * 9 + vy], h[vx * 9 + vy + 1], h[(vx + 1) * 9 + vy + 1]];
    const cut = cellSwToNeCut(gx, gy);
    if (cut) cuts++;
    const tris = cut ? [[[0.75, 0.25], [0, 1, 3]], [[0.25, 0.75], [0, 3, 2]]] : [[[0.25, 0.25], [0, 1, 2]], [[0.75, 0.75], [1, 3, 2]]];
    for (const [[fx, fy], corners] of tris) {
      const [g0, g1] = triangleGradInCell(c[0], c[1], c[2], c[3], fx, fy, cut);
      if (1 / Math.sqrt(1 + (g0 / 24) ** 2 + (g1 / 24) ** 2) >= P.FLOOR_Z) continue;
      const pts = corners.map((k) => [gx * 24 + (k & 1 ? 24 : 0), gy * 24 + (k & 2 ? 24 : 0), Math.fround(c[k])]);
      want.add(JSON.stringify(pts));
    }
  }
  assert.ok(cuts > 20 && cuts < 77, `both cuts in the disc (${cuts} SW→NE)`);
  // the built triangles, keyed by their corners' x / y (exact: multiples of 24); z within f32 rounding
  const got = new Map();
  const p = res.positions;
  for (let v = 0; v < res.vertexCount; v += 3) {
    const xy = [];
    const zs = [];
    for (let k = 0; k < 3; k++) {
      const o = (v + k) * 3;
      xy.push([res.origin.x + p[o], res.origin.y + p[o + 1]]);
      zs.push(p[o + 2] - res.liftM);
    }
    got.set(JSON.stringify(xy), zs);
  }
  const wantXY = new Map([...want].map((s) => {
    const pts = JSON.parse(s);
    return [JSON.stringify(pts.map(([a, b]) => [a, b])), pts.map((q) => q[2])];
  }));
  assert.equal(res.steep, wantXY.size, "steep triangle count");
  assert.equal(res.vertexCount, wantXY.size * 3);
  assert.deepEqual([...got.keys()].sort(), [...wantXY.keys()].sort(), "the same triangles, corner for corner");
  for (const [k, zs] of wantXY) zs.forEach((z, i) => near(got.get(k)[i], z, 1e-4, `${k} z${i}`));
  assert.ok(res.steep > 10 && res.steep < 180, `random terrain: a mix (${res.steep})`);
});

await check("a raised NE corner: a SW→NE cell emits both halves, a SE→NW cell only its NE half", () => {
  for (const swNe of [true, false]) {
    const { gx, gy } = cellWithCut(swNe);
    const lx = gx >> 3;
    const ly = gy >> 3;
    const vx = gx & 7;
    const vy = gy & 7;
    const h = heights((x, y) => (x === vx + 1 && y === vy + 1 ? 40 : 0)); // the cell's NE corner
    const res = P.buildPassabilityGeometry((a, b) => (a === lx && b === ly ? h : null), gx * 24 + 12, gy * 24 + 12, { radiusCells: 1, liftM: 0 });
    // keep the triangles inside the centre cell (the raised vertex touches 4 cells)
    const inCell = [];
    for (let v = 0; v < res.vertexCount; v += 3) {
      const tri = [0, 1, 2].map((k) => Array.from(res.positions.slice((v + k) * 3, (v + k) * 3 + 3)));
      if (tri.every(([a, b]) => a >= 0 && a <= 24 && b >= 0 && b <= 24)) inCell.push(tri);
    }
    if (swNe) {
      assert.deepEqual(inCell, [[[0, 0, 0], [24, 0, 0], [24, 24, 40]], [[0, 0, 0], [24, 24, 40], [0, 24, 0]]], "SE half + NW half");
    } else {
      assert.deepEqual(inCell, [[[24, 0, 0], [24, 24, 40], [0, 24, 0]]], "the NE half (SE, NE, NW) only");
    }
  }
});

await check("threshold through the builder: an east slope of 27.00 m / cell draws nothing, 27.03 m draws every triangle", () => {
  for (const [k, steep] of [[27.0, false], [27.03, true]]) {
    const h = heights((vx) => vx * k);
    const res = P.buildPassabilityGeometry(() => h, 0x60 * LB + 96, 0x60 * LB + 96, {});
    assert.equal(res.cells, 97);
    assert.equal(res.steep, steep ? 2 * 97 : 0, `k = ${k}`);
  }
});

await check("landblocks: the disc crosses an edge, a missing landblock is skipped and named in `lbs`", () => {
  // player 2 cells west of the 0x81/0x80 edge; the west LB is flat, the east one steep
  const flat = heights(() => 0);
  const cliff = heights((vx) => vx * 40);
  const get = (lx, ly) => (ly !== 0x40 ? null : lx === 0x80 ? flat : lx === 0x81 ? { heights: cliff } : null);
  const x = 0x81 * LB - 2 * 24 + 1;
  const y = 0x40 * LB + 96;
  const res = P.buildPassabilityGeometry(get, x, y, {});
  assert.deepEqual([...res.lbs.keys()].sort(), [0x803f, 0x8040, 0x8041, 0x813f, 0x8140, 0x8141].sort(), "every landblock the disc touches");
  assert.equal(res.lbs.get(0x8040), flat);
  assert.equal(res.lbs.get(0x8140), cliff);
  assert.equal(res.lbs.get(0x803f), null);
  const east = P.discOffsets(5);
  let eastCells = 0;
  for (let i = 0; i < east.length; i += 2) if (east[i] >= 2 && east[i + 1] >= -4 && east[i + 1] <= 3) eastCells++; // landblock 0x81/0x40 only
  assert.equal(res.steep, 2 * eastCells, "only the east landblock's cells are steep");
  for (let v = 0; v < res.vertexCount; v++) assert.ok(res.origin.x + res.positions[v * 3] >= 0x81 * LB, "every tint vertex is east of the edge");
  assert.ok(res.missing > 0 && res.missing < res.cells);
  // a throwing source and short heights count as missing
  const bad = P.buildPassabilityGeometry((lx) => {
    if (lx === 0x80) throw new Error("boom");
    return new Float32Array(10);
  }, x, y, {});
  assert.equal(bad.missing, bad.cells);
  assert.equal(bad.vertexCount, 0);
  assert.equal(P.buildPassabilityGeometry(get, NaN, y, {}).vertexCount, 0);
});

await check("lift: the tint floats liftM + the largest roundMaxAbsM in reach over the retail heights", () => {
  const cliff = heights((vx) => 100 + vx * 40);
  const res = P.buildPassabilityGeometry((lx, ly) => (lx === 0x20 && ly === 0x20 ? { heights: cliff, roundMaxAbsM: 0.06 } : lx === 0x21 ? { heights: cliff, roundMaxAbsM: -0.08 } : null), 0x20 * LB + 180, 0x20 * LB + 96, { liftM: 0.1 });
  near(res.liftM, 0.18, 1e-12, "0.1 + |−0.08|");
  const z0 = res.positions[2];
  const xRel = res.positions[0];
  const gx = Math.round((res.origin.x + xRel) / 24) % 8; // the vertex column inside its landblock
  near(z0, 100 + gx * 40 + 0.18, 1e-4, "z = height + lift");
  const plain = P.buildPassabilityGeometry(() => cliff, 0x20 * LB + 180, 0x20 * LB + 96, {});
  near(plain.liftM, P.PASSABILITY_DEFAULTS.liftM, 1e-12, "a bare heights array: the default lift");
});

await check("options are clamped; unknown keys pass through", () => {
  const o = P.resolvePassabilityOptions({ radiusCells: 99, rebuildCells: 0, liftM: -1, opacity: 3, layer: 40, color: "x", extra: 1 });
  assert.equal(o.radiusCells, 16);
  assert.equal(o.rebuildCells, 1);
  assert.equal(o.liftM, 0);
  assert.equal(o.opacity, 1);
  assert.equal(o.layer, 31);
  assert.equal(o.color, 0xff2020);
  assert.equal(o.extra, 1);
  const d = P.resolvePassabilityOptions();
  near(d.opacity, 0x60 / 255, 1e-12, "RynthAi 0x60FF2020 alpha");
  assert.equal(d.color, 0xff2020);
});

console.log("\n— THREE layer");

const steepGet = (h) => (lx, ly) => (lx >= 0x50 && lx <= 0x52 && ly >= 0x50 && ly <= 0x52 ? h : null);
const CLIFF = { heights: heights((vx) => vx * 40), roundMaxAbsM: 0 };

await check("one Mesh, one draw call: unlit translucent red, layer 1, renderOrder −24, no raycast / shadows / depth writes", () => {
  const parent = new THREE.Group();
  const ov = P.createPassabilityOverlay({ THREE, parent });
  assert.equal(ov.root, null, "nothing allocated before use");
  assert.equal(ov.stats().drawCalls, 0);
  ov.setVisible(true);
  assert.deepEqual(parent.children, [ov.root]);
  const rebuilt = ov.update(0x51 * LB + 100, 0x51 * LB + 100, steepGet(CLIFF));
  assert.equal(rebuilt, true);
  const { mesh, mat, geom, group } = ov.objects;
  assert.ok(mat instanceof THREE.MeshBasicMaterial);
  assert.equal(mat.transparent, true);
  assert.equal(mat.depthWrite, false);
  assert.equal(mat.depthTest, true);
  assert.equal(mat.fog, false);
  assert.equal(mat.toneMapped, false);
  assert.equal(mat.vertexColors, false);
  near(mat.opacity, 0x60 / 255, 1e-9, "opacity");
  assert.equal(mat.color.getHex(), new THREE.Color(0xff2020).getHex());
  assert.equal(mesh.layers.mask, 1 << 1);
  assert.equal(mesh.renderOrder, -24);
  assert.equal(mesh.castShadow, false);
  const hits = [];
  mesh.raycast(new THREE.Raycaster(), hits);
  assert.equal(hits.length, 0, "raycast is a no-op");
  assert.equal(geom.drawRange.count, 97 * 6, "every triangle of the disc is steep on a 40 m / cell cliff");
  assert.equal(mesh.visible, true);
  assert.equal(ov.stats().drawCalls, 1);
  assert.equal(group.position.x, Math.floor((0x51 * LB + 100) / 24) * 24);
  assert.ok(group.matrix.elements[12] === group.position.x, "the group matrix follows (matrixAutoUpdate off)");
  // flat ground: nothing drawn, no draw call
  ov.update(0x51 * LB + 100, 0x51 * LB + 100, steepGet({ heights: heights(() => 0) }));
  assert.equal(ov.stats().steep, 0);
  assert.equal(mesh.visible, false);
  assert.equal(ov.stats().drawCalls, 0);
  ov.dispose();
});

await check("rebuilds only on a move of rebuildCells or a heights change — never per poll", () => {
  const parent = new THREE.Group();
  const ov = P.createPassabilityOverlay({ THREE, parent });
  ov.setVisible(true);
  const x0 = 0x51 * LB + 100;
  const y0 = 0x51 * LB + 100;
  let lbsNow = new Map([[0x5151, CLIFF], [0x5051, CLIFF]]);
  const get = (lx, ly) => lbsNow.get((lx << 8) | ly) || null;
  assert.equal(ov.update(x0, y0, get), true);
  const buf = ov.objects.attr;
  for (let i = 0; i < 10; i++) assert.equal(ov.update(x0 + (i % 3) * 7, y0 - (i % 2) * 9, get), false, `poll ${i}: same cell or one away`);
  assert.equal(ov.update(x0 + 24, y0 + 24, get), false, "one cell diagonally: kept");
  assert.equal(ov.stats().rebuilds, 1);
  assert.equal(ov.update(x0 + 48, y0, get), true, "two cells east: rebuilt");
  assert.equal(ov.stats().rebuilds, 2);
  assert.equal(ov.objects.attr, buf, "the same GPU buffer, re-uploaded");
  // the same records again: nothing; a landblock streams in: rebuilt
  assert.equal(ov.update(x0 + 48, y0, get), false);
  lbsNow = new Map(lbsNow).set(0x5251, CLIFF);
  assert.equal(ov.update(x0 + 48, y0, get), true, "a landblock in reach arrived");
  // a re-bake hands a new heights array (same values): rebuilt once, then stable
  lbsNow = new Map(lbsNow).set(0x5151, { heights: heights((vx) => vx * 40) });
  assert.equal(ov.update(x0 + 48, y0, get), true);
  assert.equal(ov.update(x0 + 48, y0, get), false);
  // a landblock in reach goes away (evicted): rebuilt without it; one out of reach changes nothing
  lbsNow.delete(0x5051);
  assert.equal(ov.update(x0 + 48, y0, get), false, "0x50 is out of the disc now (centre moved 2 cells east)");
  lbsNow.delete(0x5251);
  assert.equal(ov.update(x0 + 48, y0, get), true);
  assert.equal(ov.update(x0 + 48, y0, get, { force: true }), true, "force");
  ov.dispose();
});

await check("setOptions: the look applies at once, a larger radius reallocates on the next update; dispose releases GPU resources", () => {
  const parent = new THREE.Group();
  const ov = P.createPassabilityOverlay({ THREE, parent, opts: { radiusCells: 3 } });
  ov.setVisible(true);
  ov.update(0x51 * LB + 100, 0x51 * LB + 100, steepGet(CLIFF));
  assert.equal(ov.objects.capacity, P.maxPassabilityVertices(3));
  ov.setOptions({ opacity: 0.5, color: 0x00ff00, layer: 2, renderOrder: -30 });
  assert.equal(ov.objects.mat.opacity, 0.5);
  assert.equal(ov.objects.mat.color.getHex(), 0x00ff00);
  assert.equal(ov.objects.mesh.layers.mask, 1 << 2);
  assert.equal(ov.objects.mesh.renderOrder, -30);
  assert.equal(ov.stats().rebuilds, 1, "the look needs no rebuild");
  ov.setOptions({ radiusCells: 6 });
  assert.equal(ov.update(0x51 * LB + 100, 0x51 * LB + 100, steepGet(CLIFF)), true, "radius change → rebuild");
  assert.equal(ov.objects.capacity, P.maxPassabilityVertices(6));
  assert.equal(ov.objects.geom.drawRange.count, P.maxPassabilityVertices(6));
  let disposed = 0;
  ov.objects.geom.addEventListener("dispose", () => disposed++);
  ov.objects.mat.addEventListener("dispose", () => disposed++);
  ov.setVisible(false);
  assert.equal(parent.children.length, 0, "hidden = detached");
  ov.setVisible(true);
  assert.equal(parent.children.length, 1, "shown again without a rebuild");
  ov.dispose();
  assert.equal(disposed, 2, "geometry + material disposed");
  assert.equal(parent.children.length, 0);
  ov.dispose();
  assert.equal(ov.update(1, 1, steepGet(CLIFF)), false, "inert after dispose");
});

console.log("\n— page attach (installPassabilityOverlay)");

function fakeTimers() {
  return {
    n: 0,
    fns: new Map(),
    setInterval(fn) {
      this.n += 1;
      this.fns.set(this.n, fn);
      return this.n;
    },
    clearInterval(id) {
      this.fns.delete(id);
    },
    fire() {
      for (const fn of [...this.fns.values()]) fn();
    },
  };
}
/** A session handle whose getLocalPlayerPose box counts its free() calls. */
function poseHandle(state) {
  return {
    frees: 0,
    getLocalPlayerPose() {
      const self = this;
      if (!state.cell) return null;
      return { x: state.x, y: state.y, z: 0, heading: 0, landblockId: state.cell, isOnGround: true, free() { self.frees++; } };
    },
  };
}
const terrainMesh = (lbX, lbY, h, extra = {}) => ({ userData: { lbX, lbY, heights: h, ...extra } });

await check("install → wait for the scene → attach outdoors; indoors / portal space hide; scene swap; hide; dispose", async () => {
  const timers = fakeTimers();
  const flush = () => new Promise((r) => setTimeout(r, 0));
  let imports = 0;
  const win = {};
  const h = P.installPassabilityOverlay(win, { timers, importThree: () => (imports++, Promise.resolve(THREE)) });
  assert.equal(win.__rynthPassabilityOverlay, h);
  assert.equal(P.installPassabilityOverlay(win, { timers }), h, "idempotent");
  assert.equal(timers.fns.size, 0, "no timer before setVisible(true)");
  h.setVisible(true);
  assert.equal(timers.fns.size, 1);
  assert.equal(h.status().state, "no-scene");
  assert.equal(imports, 0, "three is loaded only once a scene exists");

  // the scene lands: entitiesGroup + terrainGroup (a parked landblock is absent; a wire fill mesh has no heights)
  const cliff = heights((vx) => vx * 40);
  const eg1 = new THREE.Group();
  const tg = { children: [terrainMesh(0x51, 0x51, cliff, { roundMaxAbsM: 0.02 }), terrainMesh(0x52, 0x51, cliff), { userData: {} }, terrainMesh(0x10, 0x10, cliff)] };
  win.liveScene3d = { entitiesGroup: eg1, terrainGroup: tg };
  const where = { cell: ((0x51 << 24) | (0x51 << 16) | 0x0024) >>> 0, x: 100, y: 100 };
  win.__sessionHandle = poseHandle(where);
  timers.fire();
  await flush();
  assert.equal(imports, 1);
  let st = h.status();
  assert.equal(st.state, "shown");
  assert.deepEqual(eg1.children, [h.overlay.root]);
  assert.ok(st.overlay.steep > 0);
  assert.equal(st.overlay.drawCalls, 1);
  near(st.overlay.liftM, P.PASSABILITY_DEFAULTS.liftM + 0.02, 1e-9, "the lift takes the landblock's rounding");
  assert.equal(win.__sessionHandle.frees, 1, "the pose box is freed");
  // standing still: polls rebuild nothing
  timers.fire();
  timers.fire();
  assert.equal(h.status().overlay.rebuilds, 1);
  // a building interior: hidden (detached), nothing rebuilt
  where.cell = ((0x51 << 24) | (0x51 << 16) | 0x0105) >>> 0;
  timers.fire();
  assert.equal(h.status().state, "indoors");
  assert.equal(eg1.children.length, 0);
  // back outside, then the portal tunnel
  where.cell = ((0x51 << 24) | (0x51 << 16) | 0x0024) >>> 0;
  timers.fire();
  assert.equal(eg1.children.length, 1);
  win.__isPortalSpaceActive = () => true;
  timers.fire();
  assert.equal(h.status().state, "portal");
  assert.equal(eg1.children.length, 0);
  win.__isPortalSpaceActive = () => false;
  // no pose (pre-spawn / landblock 0)
  where.cell = 0x0000_0024;
  timers.fire();
  assert.equal(h.status().state, "no-pose");
  where.cell = ((0x51 << 24) | (0x51 << 16) | 0x0024) >>> 0;
  timers.fire();
  assert.equal(h.status().state, "shown");
  // the player walks two cells: one rebuild
  where.x += 48;
  timers.fire();
  assert.equal(h.status().overlay.rebuilds, 2);
  // relog / scene re-init: a new liveScene3d + entitiesGroup
  const eg2 = new THREE.Group();
  win.liveScene3d = { entitiesGroup: eg2, terrainGroup: tg };
  timers.fire();
  st = h.status();
  assert.equal(eg1.children.length, 0, "old scene released");
  assert.deepEqual(eg2.children, [h.overlay.root]);
  assert.equal(st.attaches, 2);
  assert.equal(imports, 1, "three imported once");
  // hide: timer stopped, detached; dispose
  h.setVisible(false);
  assert.equal(timers.fns.size, 0);
  assert.equal(eg2.children.length, 0);
  assert.equal(h.status().state, "hidden");
  h.dispose();
  assert.equal(timers.fns.size, 0);
  assert.equal(win.__rynthPassabilityOverlay, undefined);
  assert.equal(h.setVisible(true), false);
  assert.equal(P.installPassabilityOverlay(null), null, "no window (node)");
});

await check("readPlayerCell / collectTerrainHeights: world position, indoor flag, a throwing handle; one scan per window", () => {
  const out = {};
  assert.equal(P.readPlayerCell({}, out), false);
  assert.equal(P.readPlayerCell({ __sessionHandle: { getLocalPlayerPose: () => { throw new Error("x"); } } }, out), false);
  assert.equal(P.readPlayerCell({ __sessionHandle: poseHandle({ cell: ((0xa9 << 24) | (0xb4 << 16) | 0x0031) >>> 0, x: 12.5, y: 170 }) }, out), true);
  assert.deepEqual({ ...out }, { valid: true, outdoor: true, x: 0xa9 * 192 + 12.5, y: 0xb4 * 192 + 170, cell: ((0xa9 << 24) | (0xb4 << 16) | 0x0031) >>> 0 });
  assert.equal(P.readPlayerCell({ liveScene3d: { sessionHandle: poseHandle({ cell: 0x01d90120, x: 1, y: 1 }) } }, out), true, "liveScene3d.sessionHandle too");
  assert.equal(out.outdoor, false, "an EnvCell");
  const h = new Float32Array(81);
  const m = P.collectTerrainHeights({ children: [terrainMesh(3, 4, h), terrainMesh(3, 4, new Float32Array(81)), terrainMesh(9, 9, h), terrainMesh(3, 5, [1, 2])] }, 2, 4, 3, 5);
  assert.deepEqual([...m.keys()], [0x0304], "in the window, with 81 heights, first mesh wins");
  assert.equal(m.get(0x0304).heights, h);
  assert.equal(P.collectTerrainHeights(null, 0, 1, 0, 1).size, 0);
});

console.log(`\npassability_overlay: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

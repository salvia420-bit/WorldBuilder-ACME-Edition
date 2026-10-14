// tests/film_terrain_corridor.test.mjs
//
// WHY: AC Film Mode flies the camera far from the hidden player, where
// `SessionHandle.terrainHeightAt` is undefined and the live terrain oracle has
// never baked a landblock. scene3d/film/scene/terrain_corridor.js owns a
// private height cache fed by `wasmExports.fetch_landblock_heightmaps`, and
// its sharp edges silently produce a camera inside a hill or a wasm leak:
// the whole batch rejects when ONE id fails (so a bad landblock must not cost
// its 15 neighbours), every LandblockMesh is a wasm box that leaks unless
// freed, and the height must follow the RETAIL split diagonal exactly — the
// port of terrain_oracle.js must not drift from it. This suite EXECUTES the
// real module against fake wasm exports (meshes whose getters throw after
// free(), free() a spy) and proves:
//   C1  cellSwToNeCut / triangleHeightInCell / triangleGradInCell match the
//       terrain_oracle.js exports bit-for-bit;
//   C2  heightAt / normalAt / codeAt match a terrain_oracle.js oracle fed the same
//       heightmaps (random points, cell edges, landblock borders); planar and
//       flat landblocks give the analytic answer;
//   C3  batching: ≤ 16 ids per call, ids = (lbKey | 0xFFFF) >>> 0, urgent=false,
//       cached landblocks are never refetched, duplicates collapse;
//   C4  a rejected batch is retried landblock by landblock: only the bad one
//       fails, the rest load; short and malformed answers are handled;
//   C5  every LandblockMesh is freed exactly once (kept, surplus, malformed);
//   C6  concurrent ensures share in-flight fetches; a missing export (stale pkg)
//       fails cleanly; the single-id fallback export works;
//   C7  isWater (codes 16–20), maxHeightInFootprint (exact on a slope, fail-closed
//       on a half-loaded footprint), seed, drop, eviction, off-world / NaN inputs.
//
// Flag: filmMode (DEFAULT OFF, `?filmMode=on`) — terrain_corridor.js is one of its page adapters.
// Run from apps/holtburger-web/: node tests/film_terrain_corridor.test.mjs

import assert from "node:assert/strict";

const TC = await import("../scene3d/film/scene/terrain_corridor.js");
const ORACLE = await import("../scene3d/terrain_oracle.js");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err && err.message ? err.message : err}`);
  }
}

function near(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) <= eps, `${msg ?? "value"}: ${a} vs ${b} (eps ${eps})`);
}

const LB = (x, y) => (((x & 0xff) << 24) | ((y & 0xff) << 16)) >>> 0;

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

/** Heightmap of a landblock: random hills (default), or a named shape. */
function heightmap(lbKey, shape = "random") {
  const h = new Float32Array(81);
  const c = new Uint8Array(81);
  const r = rng(lbKey ^ 0x9e3779b9);
  for (let vx = 0; vx < 9; vx++) {
    for (let vy = 0; vy < 9; vy++) {
      const i = vx * 9 + vy;
      if (shape === "flat") h[i] = 12.5;
      else if (shape === "slopeX") h[i] = 0.1 * (vx * 24); // z = 0.1·localX (planar)
      else h[i] = 20 + 60 * r();
      c[i] = Math.floor(r() * 32); // codes 0..31
    }
  }
  return { h, c };
}

const ALL_MESHES = [];
class FakeMesh {
  constructor(lbKey, shape, opts = {}) {
    const { h, c } = heightmap(lbKey, shape);
    this._h = opts.short ? h.slice(0, 10) : h;
    this._c = c;
    this.freed = 0;
    this.lbKey = lbKey;
    ALL_MESHES.push(this);
  }
  get heights() {
    if (this.freed) throw new Error("LandblockMesh.heights read after free()");
    return Float32Array.from(this._h);
  }
  get terrainCodes() {
    if (this.freed) throw new Error("LandblockMesh.terrainCodes read after free()");
    return Uint8Array.from(this._c);
  }
  free() {
    if (this.freed) throw new Error("double free");
    this.freed += 1;
  }
}

/**
 * Fake wasm exports. `fail` = lbKeys whose presence rejects the whole batch;
 * `shapes` = lbKey → shape; `short` = return one mesh fewer than asked;
 * `malformed` = lbKeys answered with an 10-entry heights array.
 */
function fakeWasm(opts = {}) {
  const calls = [];
  const fail = new Set(opts.fail ?? []);
  const malformed = new Set(opts.malformed ?? []);
  const shapes = opts.shapes ?? new Map();
  const w = {
    calls,
    async fetch_landblock_heightmaps(ids, urgent) {
      calls.push({ ids: Array.from(ids), urgent, isTyped: ids instanceof Uint32Array });
      await Promise.resolve();
      for (const id of ids) if (fail.has((id & 0xffff0000) >>> 0)) throw new Error(`no heightmap for 0x${(id >>> 0).toString(16)}`);
      const out = Array.from(ids, (id) => {
        const k = (id & 0xffff0000) >>> 0;
        return new FakeMesh(k, shapes.get(k) ?? "random", { short: malformed.has(k) });
      });
      if (opts.short && out.length > 1) {
        const extra = out.pop();
        extra.free(); // the fake owns the dropped one
      }
      return out;
    },
  };
  return w;
}

function oracleFor(keys, shapes = new Map()) {
  const o = ORACLE.createTerrainOracle();
  for (const k of keys) {
    const { h, c } = heightmap(k, shapes.get(k) ?? "random");
    o.noteLandblock(k, { codes: c, heights: h, lbX: (k >>> 24) & 0xff, lbY: (k >>> 16) & 0xff });
  }
  return o;
}

// ---------------------------------------------------------------------------

await check("C1 split-diagonal helpers match terrain_oracle.js exports exactly", () => {
  const r = rng(7);
  for (let i = 0; i < 4000; i++) {
    const gx = Math.floor(r() * 2048), gy = Math.floor(r() * 2048);
    assert.equal(TC.cellSwToNeCut(gx, gy), ORACLE.cellSwToNeCut(gx, gy), `cut ${gx},${gy}`);
  }
  // Edge words (u32 wrap).
  for (const [gx, gy] of [[0, 0], [2047, 2047], [0xffffffff, 1], [123456789, 987654321]]) {
    assert.equal(TC.cellSwToNeCut(gx, gy), ORACLE.cellSwToNeCut(gx, gy));
  }
  for (let i = 0; i < 4000; i++) {
    const z = [r() * 100, r() * 100, r() * 100, r() * 100];
    const fx = i % 50 === 0 ? 0 : i % 51 === 0 ? 1 : r();
    const fy = i % 53 === 0 ? fx : r();
    for (const cut of [true, false]) {
      assert.equal(TC.triangleHeightInCell(...z, fx, fy, cut), ORACLE.triangleHeightInCell(...z, fx, fy, cut));
      assert.deepEqual(TC.triangleGradInCell(...z, fx, fy, cut), ORACLE.triangleGradInCell(...z, fx, fy, cut));
    }
  }
});

await check("C2 heightAt / normalAt / codeAt match a terrain_oracle fed the same heightmaps", async () => {
  const keys = [];
  for (let x = 0x80; x <= 0x82; x++) for (let y = 0x40; y <= 0x42; y++) keys.push(LB(x, y));
  const tc = TC.createTerrainCorridor({ wasmExports: fakeWasm() });
  const res = await tc.ensure(keys);
  assert.equal(res.ok, true);
  const o = oracleFor(keys);
  const r = rng(99);
  const x0 = 0x80 * 192, y0 = 0x40 * 192;
  const pts = [];
  for (let i = 0; i < 3000; i++) pts.push([x0 + r() * 576, y0 + r() * 576]);
  // Cell edges, vertices and landblock borders.
  for (let k = 0; k < 24; k++) {
    pts.push([x0 + 192 + k * 0.001, y0 + 100]);
    pts.push([x0 + 192 - 1e-9, y0 + 24 * (k % 8)]);
    pts.push([x0 + 24 * k, y0 + 24 * k]);
    pts.push([x0 + 24 * k + 12, y0 + 24 * k + 12]); // on a diagonal
  }
  let maxDz = 0;
  for (const [x, y] of pts) {
    const a = tc.heightAt(x, y);
    const b = o.heightAt(x, y);
    assert.ok(a !== null && b !== null, `both know ${x},${y}`);
    maxDz = Math.max(maxDz, Math.abs(a - b));
    const s = o.sample(x, y);
    const n = tc.normalAt(x, y);
    near(n[0], s.normal.x, 1e-12, "nx");
    near(n[1], s.normal.y, 1e-12, "ny");
    near(n[2], s.normal.z, 1e-12, "nz");
    assert.equal(tc.codeAt(x, y), s.code, `code at ${x},${y}`);
  }
  assert.ok(maxDz <= 1e-9, `max |dz| ${maxDz}`);
});

await check("C2b flat and planar landblocks give the analytic height and normal on either diagonal", async () => {
  const kf = LB(0x10, 0x10), ks = LB(0x11, 0x10);
  const shapes = new Map([[kf, "flat"], [ks, "slopeX"]]);
  const tc = TC.createTerrainCorridor({ wasmExports: fakeWasm({ shapes }) });
  await tc.ensure([kf, ks]);
  const r = rng(3);
  for (let i = 0; i < 500; i++) {
    const lx = r() * 191.9, ly = r() * 191.9;
    near(tc.heightAt(0x10 * 192 + lx, 0x10 * 192 + ly), 12.5, 1e-4, "flat");
    near(tc.heightAt(0x11 * 192 + lx, 0x10 * 192 + ly), 0.1 * lx, 1e-4, "slope");
  }
  const n = tc.normalAt(0x11 * 192 + 50, 0x10 * 192 + 50);
  const L = Math.hypot(0.1, 1);
  near(n[0], -0.1 / L, 1e-6, "slope nx");
  near(n[1], 0, 1e-9, "slope ny");
  near(n[2], 1 / L, 1e-6, "slope nz");
  assert.deepEqual(tc.normalAt(0x10 * 192 + 5, 0x10 * 192 + 5).map((v) => Math.round(v * 1e9) / 1e9), [0, 0, 1]);
});

await check("C3 batches of ≤ 16, ids (lbKey|0xFFFF)>>>0, urgent false, cached never refetched, duplicates collapse", async () => {
  const w = fakeWasm();
  const tc = TC.createTerrainCorridor({ wasmExports: w });
  const keys = [];
  for (let i = 0; i < 40; i++) keys.push(LB(0x20 + (i % 8), 0x30 + Math.floor(i / 8)));
  const res = await tc.ensure([...keys, keys[0], keys[5] | 0x0123]); // dupes + a cell id inside a known lb
  assert.equal(res.ok, true);
  assert.equal(res.loaded.length, 40);
  assert.deepEqual(w.calls.map((c) => c.ids.length), [16, 16, 8]);
  for (const c of w.calls) {
    assert.equal(c.urgent, false);
    assert.equal(c.isTyped, true, "Uint32Array");
    for (const id of c.ids) assert.equal(id & 0xffff, 0xffff, "LandBlock sentinel low word");
  }
  assert.equal(w.calls[0].ids[0], (keys[0] | 0xffff) >>> 0);
  const again = await tc.ensure(keys.slice(0, 10));
  assert.equal(w.calls.length, 3, "no refetch");
  assert.equal(again.cached.length, 10);
  assert.equal(again.loaded.length, 0);
  assert.equal(tc.has(keys[3]), true);
  assert.equal(tc.has(keys[3] | 0x0042), true, "has() takes any cell id of the landblock");
});

await check("C4 a rejected batch is retried per landblock: only the bad landblock fails", async () => {
  const keys = [];
  for (let i = 0; i < 20; i++) keys.push(LB(0x50 + i, 0x60));
  const bad = keys[17];
  const w = fakeWasm({ fail: [bad] });
  const logs = [];
  const tc = TC.createTerrainCorridor({ wasmExports: w, log: (e) => logs.push(e) });
  const res = await tc.ensure(keys);
  assert.equal(res.ok, false);
  assert.deepEqual(res.failed.map((f) => f.lbKey), [bad]);
  assert.match(res.failed[0].error, /no heightmap/);
  assert.equal(res.loaded.length, 19);
  // batch 1 (16 ok), batch 2 (4 ids, rejects) → 4 single retries.
  assert.deepEqual(w.calls.map((c) => c.ids.length), [16, 4, 1, 1, 1, 1]);
  assert.equal(tc.has(bad), false);
  assert.equal(tc.heightAt(((bad >>> 24) & 0xff) * 192 + 10, 0x60 * 192 + 10), null);
  assert.notEqual(tc.heightAt(((keys[16] >>> 24) & 0xff) * 192 + 10, 0x60 * 192 + 10), null);
  const st = tc.stats();
  assert.equal(st.batchRejections, 1);
  assert.equal(st.retries, 4);
  assert.ok(logs.some((e) => e.event === "film-terrain-corridor" && e.level === "warn"), "failure logged");
});

await check("C4b short and malformed batch answers: missing meshes retried, malformed ones fail", async () => {
  const keys = [LB(1, 1), LB(1, 2), LB(1, 3)];
  const w = fakeWasm({ short: true });
  const tc = TC.createTerrainCorridor({ wasmExports: w });
  const res = await tc.ensure(keys);
  assert.equal(res.ok, true, JSON.stringify(res.failed));
  assert.deepEqual(w.calls.map((c) => c.ids.length), [3, 1]);
  const w2 = fakeWasm({ malformed: [LB(2, 2)] });
  const tc2 = TC.createTerrainCorridor({ wasmExports: w2 });
  const res2 = await tc2.ensure([LB(2, 1), LB(2, 2)]);
  assert.deepEqual(res2.failed.map((f) => f.lbKey), [LB(2, 2)]);
  assert.match(res2.failed[0].error, /malformed/);
  assert.equal(tc2.has(LB(2, 1)), true);
});

await check("C5 every LandblockMesh handed out is freed exactly once", async () => {
  const before = ALL_MESHES.length;
  const w = fakeWasm({ fail: [LB(9, 9)], malformed: [LB(9, 7)] });
  const tc = TC.createTerrainCorridor({ wasmExports: w, batchSize: 4 });
  const keys = [];
  for (let y = 0; y < 10; y++) keys.push(LB(9, y));
  await tc.ensure(keys);
  const mine = ALL_MESHES.slice(before);
  assert.ok(mine.length >= 10, `meshes created: ${mine.length}`);
  for (const m of mine) assert.equal(m.freed, 1, `mesh 0x${m.lbKey.toString(16)} freed once`);
  assert.equal(tc.stats().freed, mine.length);
  // All earlier suites' meshes too (kept, surplus, malformed).
  for (const m of ALL_MESHES) assert.equal(m.freed, 1);
});

await check("C6 concurrent ensures share in-flight fetches; stale pkg fails cleanly; single-id fallback", async () => {
  const w = fakeWasm();
  const tc = TC.createTerrainCorridor({ wasmExports: w });
  const a = [LB(0x30, 1), LB(0x30, 2), LB(0x30, 3)];
  const [r1, r2] = await Promise.all([tc.ensure(a), tc.ensure([a[1], a[2], LB(0x30, 4)])]);
  assert.equal(r1.ok && r2.ok, true);
  const fetched = w.calls.flatMap((c) => c.ids.map((id) => (id & 0xffff0000) >>> 0));
  assert.equal(new Set(fetched).size, fetched.length, "each landblock fetched once");
  assert.deepEqual(r2.cached.sort(), [a[1], a[2]].sort());
  assert.deepEqual(r2.loaded, [LB(0x30, 4)]);

  const stale = TC.createTerrainCorridor({ wasmExports: {} });
  const rs = await stale.ensure([LB(1, 1)]);
  assert.equal(rs.ok, false);
  assert.match(rs.failed[0].error, /not available/);
  const none = TC.createTerrainCorridor({});
  assert.equal((await none.ensure(LB(1, 1))).ok, false, "no wasm at all");

  const singles = [];
  const single = TC.createTerrainCorridor({
    wasmExports: {
      async fetch_landblock_heightmap(id) {
        singles.push(id);
        return new FakeMesh((id & 0xffff0000) >>> 0, "flat");
      },
    },
  });
  const rf = await single.ensure([LB(4, 4), LB(4, 5)]);
  assert.equal(rf.ok, true);
  assert.deepEqual(singles, [(LB(4, 4) | 0xffff) >>> 0, (LB(4, 5) | 0xffff) >>> 0]);
  near(single.heightAt(4 * 192 + 3, 5 * 192 + 3), 12.5, 1e-5, "fallback height");
});

await check("C7 isWater (16–20), maxHeightInFootprint exact + fail-closed, seed / drop / eviction / bad input", async () => {
  // Water: seed a landblock whose codes are known.
  const tc = TC.createTerrainCorridor({ wasmExports: fakeWasm({ shapes: new Map([[LB(5, 5), "slopeX"]]) }), maxLandblocks: 4 });
  const codes = new Uint8Array(81);
  codes.fill(4);
  codes[0 * 9 + 0] = 16; // SW corner vertex
  codes[1 * 9 + 0] = 20;
  codes[2 * 9 + 0] = 21; // not water
  codes[3 * 9 + 0] = 16 | 0x20; // masked to 16
  assert.equal(tc.seed(LB(7, 7), { heights: new Float32Array(81).fill(3), codes }), true);
  const bx = 7 * 192, by = 7 * 192;
  assert.equal(tc.isWater(bx + 1, by + 1), true);
  assert.equal(tc.isWater(bx + 24, by + 1), true);
  assert.equal(tc.isWater(bx + 48, by + 1), false);
  assert.equal(tc.isWater(bx + 72, by + 1), true);
  assert.equal(tc.isWater(bx + 100, by + 100), false);
  assert.equal(tc.isWater(9 * 192, 9 * 192), null, "unknown landblock");
  assert.equal(TC.isWaterTerrainCode(18), true);
  assert.equal(TC.isWaterTerrainCode(15), false);
  assert.equal(TC.isWaterTerrainCode(NaN), false);
  assert.equal(tc.seed(LB(7, 8), { heights: [1, 2] }), false, "short heights refused");

  // Footprint on the planar slope z = 0.1·localX.
  await tc.ensure([LB(5, 5)]);
  const x = 5 * 192 + 80, y = 5 * 192 + 80;
  near(tc.maxHeightInFootprint(x, y, 10), 0.1 * 90, 1e-4, "max is the downhill-most east point");
  near(tc.maxHeightInFootprint(x, y, 0), 0.1 * 80, 1e-4, "r=0 → heightAt");
  near(tc.maxHeightInFootprint(x, y, NaN), 0.1 * 80, 1e-4, "NaN r → heightAt");
  assert.equal(tc.maxHeightInFootprint(5 * 192 + 5, y, 10), null, "footprint spills into an unknown landblock → null");
  // Seeded flat landblock with a single raised vertex inside the disc.
  const h = new Float32Array(81).fill(1);
  h[4 * 9 + 4] = 9; // vertex at local (96, 96)
  tc.seed(LB(6, 6), { heights: h });
  near(tc.maxHeightInFootprint(6 * 192 + 90, 6 * 192 + 90, 10), 9, 1e-6, "raised vertex inside the disc");
  near(tc.maxHeightInFootprint(6 * 192 + 40, 6 * 192 + 40, 10), 1, 1e-6, "far from it");

  // Eviction (cap 4): 7,7 / 5,5 / 6,6 cached; two more evict the oldest.
  await tc.ensure([LB(8, 1), LB(8, 2)]);
  assert.equal(tc.keys().length, 4);
  assert.equal(tc.has(LB(7, 7)), false, "oldest evicted");
  assert.ok(tc.stats().evicted >= 1);
  assert.equal(tc.drop(LB(8, 1)), true);
  assert.equal(tc.has(LB(8, 1)), false);

  // Bad input never throws.
  assert.equal(tc.heightAt(NaN, 5), null);
  assert.equal(tc.heightAt(-5, 5), null, "off-world");
  assert.equal(tc.heightAt(256 * 192 + 1, 5), null, "off-world east");
  assert.equal(tc.normalAt(undefined, 1), null);
  assert.equal(tc.codeAt("a", 1), -1);
  assert.equal(tc.sample(1e9, 1e9), null);
  const s = tc.sample(5 * 192 + 30, 5 * 192 + 30);
  near(s.height, 3, 1e-5, "sample height");
  assert.equal(s.lbKey, LB(5, 5));
  const r = await tc.ensure([NaN, "x", null, 1.5]);
  assert.equal(r.ok, true, "nothing valid to fetch");
  assert.equal(TC.corridorLbKey(0xa9b4001c), 0xa9b40000);
  assert.equal(TC.corridorLbKey(-1), 0xffff0000);
  assert.equal(TC.corridorLbKey(1.5), null);
  tc.clear();
  assert.equal(tc.keys().length, 0);
});

console.log(`film_terrain_corridor: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

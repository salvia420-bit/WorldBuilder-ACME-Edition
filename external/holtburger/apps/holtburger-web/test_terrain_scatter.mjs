// test_terrain_scatter.mjs — the effect-agnostic instanced scatter pool
// (Wave 1 pre-work; `scene3d/terrain_scatter.js`).
//
// Locks (docs/2026-07-31-terrain-vfx-plan.md §3.1 "Placement (CPU, amortised)",
// §3.2 item 1, §3.3 item 1, §5.4, §5.5, §5.7, §6):
//   L1  The placement helpers are PURE and hash-deterministic — no clock, no
//       `Math.random`, no player state. `wrapSlotToCell` is a bijection over a
//       window (every slot lands on exactly one cell) and is STABLE while the
//       window does not scroll.
//   L2  Every per-instance buffer is allocated EXACTLY ONCE, at construction:
//       the instance count, the buffer lengths and the buffer IDENTITIES never
//       change afterwards. `castShadow` is false (§5.7 — added geometry is paid
//       a second time by the shadow depth pass).
//   L3  Scatter is DETERMINISTIC for a fixed centre + seed, and placement is
//       HASH-STABLE per WORLD CELL (§5.4): leave and come back and the same
//       instances land in the same places, which is what makes park/unpark and
//       rebake invisible.
//   L4  The family gate is honoured: a sample whose family is not in the
//       consumer's set is written DEGENERATE — `aScale` h === 0.
//   L5  Accepted instances are GROUNDED at the oracle height (+ the configured
//       lift) and carry the face normal; the consumer's `fill` runs only for
//       them, may adjust z, and may reject.
//   L6  AMORTISATION: a 10 m move re-scatters at most `sliceSize` instances per
//       update, and a stationary, fully-resolved pool re-scatters NOTHING and
//       uploads NOTHING (no per-frame CPU write for instances that did not move).
//   L7  TELEPORT: an explicit `rescatterAll()` — and an auto-detected jump of
//       more than one landblock — re-scatters every instance in one call.
//   L8  A null oracle sample (unbaked landblock) is degenerate and RETRIED:
//       once the landblock bakes, later amortised ticks revive those instances
//       with no player movement at all.
//   L9  Steady state allocates nothing new: no extra buffers, and the pending
//       `updateRanges` on an unconsumed attribute stay BOUNDED.
//   L10 Headless (no THREE) is a supported mode — full CPU bookkeeping, zero
//       GPU objects, no throw. That is the `?nullRender=1` path.
//   L11 The optional GLSL helper declares each uniform exactly once, matches
//       `pool.uniforms` by name, and matches `fadeFor` in form (LINEAR).
//
// Run from apps/holtburger-web/:  node test_terrain_scatter.mjs
// (`three` resolves as a bare import via node_modules — the plan §6 tier for
// anything touching InstancedMesh/BufferGeometry; `_three_stub.mjs` has neither.)

import * as THREE from "three";
import { FAM_GRASS, FAM_SAND, familyForCode } from "./scene3d/terrain_families.js";
import {
  SCATTER_DEFAULTS,
  SCATTER_FADE_GLSL,
  scatterHashU32,
  scatterHash01,
  gridSizeFor,
  instanceCountFor,
  cellSizeFor,
  wrapSlotToCell,
  fadeFor,
  isScatterTeleport,
  createScatterPool,
} from "./scene3d/terrain_scatter.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
// A stub oracle implementing the REAL `terrain_oracle.js::sample(x, y, out)`
// contract: it fills the caller's `out` (allocation-free), reuses `out.normal`
// and `out.cornerCodes`, and returns null for an unbaked landblock.
// ---------------------------------------------------------------------------
function makeStubOracle(opts = {}) {
  const codeAt = opts.codeAt || (() => 1);            // null ⇒ unbaked LB
  const heightAt = opts.heightAt || ((x, y) => 20 + 0.01 * x + 0.02 * y);
  const slope = opts.slope || (() => [0.01, 0.02]);   // dz/dx, dz/dy
  const st = { samples: 0, nulls: 0 };
  return {
    _stats: st,
    sample(x, y, out) {
      st.samples += 1;
      const code = codeAt(x, y);
      if (code === null || code === undefined) { st.nulls += 1; return null; }
      const r = out || {};
      let corners = r.cornerCodes;
      if (!corners || corners.length !== 4) { corners = new Uint8Array(4); r.cornerCodes = corners; }
      corners[0] = code; corners[1] = code; corners[2] = code; corners[3] = code;
      r.code = code;
      r.family = familyForCode(code);
      r.lbX = Math.floor(x / 192);
      r.lbY = Math.floor(y / 192);
      r.lbKey = ((r.lbX & 0xff) << 24) | ((r.lbY & 0xff) << 16);
      r.hasHeight = opts.hasHeight === false ? false : true;
      r.height = heightAt(x, y);
      const g = slope(x, y);
      let nx = -g[0], ny = -g[1], nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      let n = r.normal;
      if (!n || typeof n !== "object") { n = { x: 0, y: 0, z: 1 }; r.normal = n; }
      n.x = nx; n.y = ny; n.z = nz;
      return r;
    },
  };
}

const GRASS_SCHEMA = [
  { name: "aOffset", itemSize: 3 },
  { name: "aRot", itemSize: 1 },
  { name: "aScale", itemSize: 2 },
  { name: "aTint", itemSize: 3 },
  { name: "aFamilyParam", itemSize: 1 },
  { name: "aNormal", itemSize: 3 },
];

let ibaAllocs = 0;
class SpyInstancedBufferAttribute extends THREE.InstancedBufferAttribute {
  constructor(...args) { super(...args); ibaAllocs += 1; }
}
const THREE_SPY = Object.assign({}, THREE, {
  InstancedBufferAttribute: SpyInstancedBufferAttribute,
});

function makePool(extra = {}) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
  const material = new THREE.MeshBasicMaterial();
  const pool = createScatterPool({
    THREE: THREE_SPY,
    geometry,
    material,
    count: 4096,
    radiusM: 48,
    seed: 1234,
    attributes: GRASS_SCHEMA,
    families: [FAM_GRASS],
    oracle: makeStubOracle(),
    ...extra,
  });
  return { pool, geometry, material };
}

// ---------------------------------------------------------------------------
console.log("\n-- L1: pure, hash-deterministic placement helpers --");
{
  check("scatterHashU32 is deterministic",
    scatterHashU32(12, -7, 3, 99) === scatterHashU32(12, -7, 3, 99));
  check("scatterHashU32 stays in u32",
    (() => {
      for (let i = -50; i < 50; i += 1) {
        const h = scatterHashU32(i, i * 7, 2, 5);
        if (!Number.isInteger(h) || h < 0 || h > 0xffffffff) return false;
      }
      return true;
    })());
  check("the seed actually changes the stream",
    scatterHashU32(4, 4, 0, 1) !== scatterHashU32(4, 4, 0, 2));
  check("neighbouring cells decorrelate (low bits are avalanched)",
    (() => {
      let same = 0;
      for (let i = 0; i < 512; i += 1) {
        if (Math.floor(scatterHash01(i, 0, 1, 7) * 8) === Math.floor(scatterHash01(i + 1, 0, 1, 7) * 8)) same += 1;
      }
      return same < 512 * 0.25;   // random would be ~12.5%
    })());
  check("scatterHash01 is in [0,1)",
    (() => {
      for (let i = 0; i < 1000; i += 1) {
        const v = scatterHash01(i, i * 3, i & 7, 11);
        if (!(v >= 0 && v < 1)) return false;
      }
      return true;
    })());

  check("gridSizeFor rounds UP to a square grid", gridSizeFor(4096) === 64 && gridSizeFor(4097) === 65);
  check("instanceCountFor(20000) === 142² === 20164", instanceCountFor(20000) === 20164);
  check("cellSizeFor(48, 64) === 1.5 m", near(cellSizeFor(48, 64), 1.5));

  // The torus mapping: bijection + stability.
  const g = 64;
  {
    const seen = new Set();
    let ok = true;
    for (let s = 0; s < g; s += 1) {
      const c = wrapSlotToCell(s, 1000, g);
      if (c < 1000 || c >= 1000 + g) ok = false;
      seen.add(c);
    }
    check("wrapSlotToCell covers the window exactly once (bijection)", ok && seen.size === g);
  }
  check("wrapSlotToCell handles NEGATIVE window origins (west of the origin)",
    (() => {
      const seen = new Set();
      for (let s = 0; s < g; s += 1) {
        const c = wrapSlotToCell(s, -37, g);
        if (c < -37 || c >= -37 + g) return false;
        seen.add(c);
      }
      return seen.size === g;
    })());
  check("a slot keeps its cell while the window does not scroll",
    wrapSlotToCell(17, 1000, g) === wrapSlotToCell(17, 1000, g));
  check("scrolling the window by one moves exactly ONE slot's cell",
    (() => {
      let moved = 0;
      for (let s = 0; s < g; s += 1) {
        if (wrapSlotToCell(s, 1000, g) !== wrapSlotToCell(s, 1001, g)) moved += 1;
      }
      return moved === 1;
    })(), "the leading-edge property");

  check("fadeFor is 1 inside the plateau", fadeFor(10, 0, 48, 0.2, "disc") === 1);
  check("fadeFor is 0 at/beyond R", fadeFor(48, 0, 48, 0.2, "disc") === 0
    && fadeFor(60, 0, 48, 0.2, "disc") === 0);
  check("fadeFor is linear across the last 20%",
    near(fadeFor(48 - 48 * 0.1, 0, 48, 0.2, "disc"), 0.5, 1e-9));
  check("square shape measures Chebyshev distance",
    fadeFor(30, 30, 48, 0.2, "square") === 1 && fadeFor(30, 30, 48, 0.2, "disc") < 1);
  check("isScatterTeleport: 10 m no, 200 m yes",
    !isScatterTeleport(0, 0, 10, 0) && isScatterTeleport(0, 0, 200, 0));
  check("SCATTER_DEFAULTS.sliceSize is the plan's 512", SCATTER_DEFAULTS.sliceSize === 512);
}

// ---------------------------------------------------------------------------
console.log("\n-- L2: construction — one allocation per buffer, ever --");
let mainPool = null;
{
  ibaAllocs = 0;
  const { pool, geometry } = makePool();
  mainPool = pool;
  check("instance count matches the configured N (4096 = 64²)", pool.count === 4096, String(pool.count));
  check("mesh.count matches", pool.mesh && pool.mesh.count === 4096);
  check("one InstancedBufferAttribute per schema entry, and no more",
    ibaAllocs === GRASS_SCHEMA.length, `${ibaAllocs} vs ${GRASS_SCHEMA.length}`);
  check("stats().allocations agrees", pool.stats().allocations === GRASS_SCHEMA.length);
  check("every buffer is sized count × itemSize",
    GRASS_SCHEMA.every((s) => pool.arrays[s.name].length === 4096 * s.itemSize));
  check("the attributes are set on the CONSUMER's geometry",
    GRASS_SCHEMA.every((s) => geometry.getAttribute(s.name) === pool.attributes[s.name]));
  check("attribute.array IS the pool's array (no copy)",
    GRASS_SCHEMA.every((s) => pool.attributes[s.name].array === pool.arrays[s.name]));
  check("castShadow === false (§5.7)", pool.mesh.castShadow === false);
  check("frustumCulled === false by default (the window moves with the player)",
    pool.mesh.frustumCulled === false);
  check("the pool publishes centre/radius/fade-start/shape uniforms",
    !!pool.uniforms.uScatterCenter && !!pool.uniforms.uScatterRadius
    && near(pool.uniforms.uScatterFadeStart.value, 48 * 0.8)
    && pool.uniforms.uScatterShape.value === 0);
  check("nothing is live before the first update (zero-scale instance matrices)",
    pool.stats().live === 0);

  const before = GRASS_SCHEMA.map((s) => pool.arrays[s.name]);
  pool.update(0.016, 1000, 2000, 20);
  for (let i = 0; i < 200; i += 1) pool.update(0.016, 1000 + i * 0.5, 2000, 20);
  check("after 200 ticks NO new buffer was allocated", ibaAllocs === GRASS_SCHEMA.length,
    String(ibaAllocs));
  check("buffer identities are unchanged",
    GRASS_SCHEMA.every((s, k) => pool.arrays[s.name] === before[k]));
  check("count/gridSize/cellSize are immutable config",
    pool.count === 4096 && pool.gridSize === 64 && near(pool.cellSizeM, 1.5));
}

// ---------------------------------------------------------------------------
console.log("\n-- L3: determinism + hash-stable placement per world cell --");
{
  const a = makePool().pool;
  const b = makePool().pool;
  a.rescatterAll(3000.25, 4000.75, 12);
  b.rescatterAll(3000.25, 4000.75, 12);
  const same = (name) => {
    const x = a.arrays[name], y = b.arrays[name];
    for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false;
    return true;
  };
  check("two pools, same seed + centre ⇒ byte-identical placement",
    GRASS_SCHEMA.every((s) => same(s.name)));

  const c = makePool({ seed: 4321 }).pool;
  c.rescatterAll(3000.25, 4000.75, 12);
  check("a different seed ⇒ a different field",
    (() => {
      const x = a.arrays.aOffset, y = c.arrays.aOffset;
      for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return true;
      return false;
    })());

  // §5.4: placement is a function of the WORLD CELL, so walking away and back
  // must reproduce it exactly.
  const snapshot = Float32Array.from(a.arrays.aOffset);
  a.rescatterAll(3000.25 + 5000, 4000.75, 12);   // teleport away
  a.rescatterAll(3000.25, 4000.75, 12);          // and back
  check("teleport away and back reproduces the SAME field (park/rebake safe)",
    (() => {
      const x = a.arrays.aOffset;
      for (let i = 0; i < x.length; i += 1) if (x[i] !== snapshot[i]) return false;
      return true;
    })());

  // Independence from the pool's own history: a fresh pool centred there matches.
  const d = makePool().pool;
  d.rescatterAll(3000.25, 4000.75, 12);
  check("a fresh pool at the same centre matches instance-for-instance",
    (() => {
      const x = a.arrays.aOffset, y = d.arrays.aOffset;
      for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false;
      return true;
    })());

  check("placement is time-independent (dt does not enter it)",
    (() => {
      const p = makePool().pool;
      p.update(0.016, 500, 500, 0);
      const s1 = Float32Array.from(p.arrays.aOffset);
      const q = makePool().pool;
      q.update(9.5, 500, 500, 0);
      for (let i = 0; i < s1.length; i += 1) if (q.arrays.aOffset[i] !== s1[i]) return false;
      return true;
    })());
}

// ---------------------------------------------------------------------------
console.log("\n-- L4: the family gate ⇒ degenerate instances --");
{
  // Sand everywhere, grass-only pool.
  const sand = makePool({ oracle: makeStubOracle({ codeAt: () => 10 }) }).pool;
  sand.rescatterAll(500, 500, 0);
  check("a non-matching family leaves NOTHING live", sand.stats().live === 0,
    String(sand.stats().live));
  check("every aScale h is exactly 0",
    (() => {
      for (let i = 0; i < sand.count; i += 1) if (sand.arrays.aScale[i * 2] !== 0) return false;
      return true;
    })());
  check("the instance matrix is zero-scale too (degenerate for ANY material)",
    (() => {
      const m = sand.mesh.instanceMatrix.array;
      for (let i = 0; i < sand.count; i += 1) if (m[i * 16] !== 0) return false;
      return true;
    })());
  check("family rejects are counted and RESOLVED (not retried every lap)",
    sand.stats().familyRejects > 0 && sand._resolved[0] === 1);

  // Half sand, half grass — the per-instance boundary case.
  const mixed = makePool({
    oracle: makeStubOracle({ codeAt: (x) => (x < 500 ? 10 : 1) }),
  }).pool;
  mixed.rescatterAll(500, 500, 0);
  let wrong = 0, liveSeen = 0, deadSeen = 0;
  for (let i = 0; i < mixed.count; i += 1) {
    const x = mixed.arrays.aOffset[i * 3];
    const live = mixed.arrays.aScale[i * 2] !== 0;
    if (live) liveSeen += 1; else deadSeen += 1;
    if (live && x < 500) wrong += 1;
  }
  check("no instance is live over the sand half", wrong === 0, String(wrong));
  check("both halves are represented", liveSeen > 100 && deadSeen > 100,
    `${liveSeen} live / ${deadSeen} dead`);
  check("an all-family pool (no `families`) accepts sand as happily as grass",
    (() => {
      const any = makePool({ families: undefined, oracle: makeStubOracle({ codeAt: () => 10 }) }).pool;
      any.rescatterAll(500, 500, 0);
      return any.stats().live > 0 && familyForCode(10) === FAM_SAND;
    })());
}

// ---------------------------------------------------------------------------
console.log("\n-- L5: grounding, normals and the consumer fill callback --");
{
  const heightAt = (x, y) => 30 + 0.1 * x - 0.05 * y;
  let fillCalls = 0;
  const seen = [];
  const pool = makePool({
    heightOffsetM: 0.25,
    oracle: makeStubOracle({ codeAt: (x) => (x < 500 ? 10 : 1), heightAt }),
    fill(ctx) {
      fillCalls += 1;
      if (seen.length < 4) seen.push({ i: ctx.index, x: ctx.x, y: ctx.y, z: ctx.z, f: ctx.family });
      ctx.set("aRot", ctx.rand(0) * Math.PI * 2);
      ctx.set("aScale", 0.4 + ctx.rand(1) * 0.4, 0.05);
      ctx.set("aTint", 0.2, 0.5 + ctx.rand(2) * 0.2, 0.1);
      ctx.set("aFamilyParam", ctx.code);
    },
  }).pool;
  pool.rescatterAll(500, 500, 7);

  check("fill ran once per ACCEPTED instance only",
    fillCalls === pool.stats().live, `${fillCalls} vs ${pool.stats().live}`);
  check("fill only ever saw the accepted family",
    seen.every((s) => s.f === FAM_GRASS));
  check("accepted instances are grounded at height + heightOffsetM",
    (() => {
      for (let i = 0; i < pool.count; i += 1) {
        if (!pool.isLive(i)) continue;
        const x = pool.arrays.aOffset[i * 3];
        const y = pool.arrays.aOffset[i * 3 + 1];
        const z = pool.arrays.aOffset[i * 3 + 2];
        if (!near(z, heightAt(x, y) + 0.25, 1e-3)) return false;
      }
      return true;
    })());
  check("the instance matrix translation matches the offset attribute",
    (() => {
      const m = pool.mesh.instanceMatrix.array;
      for (let i = 0; i < pool.count; i += 1) {
        if (!pool.isLive(i)) continue;
        if (m[i * 16 + 12] !== pool.arrays.aOffset[i * 3]) return false;
        if (m[i * 16 + 14] !== pool.arrays.aOffset[i * 3 + 2]) return false;
        if (m[i * 16] !== 1) return false;
        return true;
      }
      return false;
    })());
  check("the ground normal is written and unit-length",
    (() => {
      for (let i = 0; i < pool.count; i += 1) {
        if (!pool.isLive(i)) continue;
        const b = i * 3;
        const n = pool.arrays.aNormal;
        return near(Math.hypot(n[b], n[b + 1], n[b + 2]), 1, 1e-5) && n[b + 2] > 0.9;
      }
      return false;
    })());
  check("the consumer's writes survived (aScale is the fill's, not the pool's 1)",
    (() => {
      for (let i = 0; i < pool.count; i += 1) {
        if (!pool.isLive(i)) continue;
        return pool.arrays.aScale[i * 2] >= 0.4 && pool.arrays.aScale[i * 2] <= 0.8
          && near(pool.arrays.aScale[i * 2 + 1], 0.05);
      }
      return false;
    })());
  check("ctx.rand is deterministic per world cell, not per call",
    (() => {
      const p1 = makePool({ fill: (c) => c.set("aRot", c.rand(3)) }).pool;
      const p2 = makePool({ fill: (c) => c.set("aRot", c.rand(3)) }).pool;
      p1.rescatterAll(800, 900, 0);
      p2.rescatterAll(800, 900, 0);
      for (let i = 0; i < p1.count; i += 1) if (p1.arrays.aRot[i] !== p2.arrays.aRot[i]) return false;
      return true;
    })());

  // fill may lift the instance and may reject it.
  const lifted = makePool({
    oracle: makeStubOracle({ heightAt: () => 10 }),
    fill(ctx) {
      if (ctx.index % 2 === 0) { ctx.live = false; return; }
      ctx.z += 3;
    },
  }).pool;
  lifted.rescatterAll(500, 500, 0);
  check("fill can reject an instance (live = false ⇒ degenerate)",
    (() => {
      for (let i = 0; i < lifted.count; i += 2) if (lifted.isLive(i)) return false;
      return lifted.stats().fillRejects > 0;
    })());
  check("fill can adjust z and the pool commits the ADJUSTED value",
    (() => {
      for (let i = 1; i < lifted.count; i += 2) {
        if (!lifted.isLive(i)) continue;
        return near(lifted.arrays.aOffset[i * 3 + 2], 13, 1e-4);
      }
      return false;
    })());
  check("a throwing fill is contained (counted, instance degenerate, no crash)",
    (() => {
      const boom = makePool({ fill: () => { throw new Error("boom"); } }).pool;
      boom.rescatterAll(500, 500, 0);
      return boom.stats().fillErrors > 0 && boom.stats().live === 0;
    })());
  check("hasHeight === false ⇒ degenerate, never a guessed z",
    (() => {
      const nh = makePool({ oracle: makeStubOracle({ hasHeight: false }) }).pool;
      nh.rescatterAll(500, 500, 0);
      return nh.stats().live === 0 && nh.stats().noHeight > 0;
    })());
}

// ---------------------------------------------------------------------------
console.log("\n-- L6: amortisation — a 10 m move touches ≤ sliceSize --");
{
  const oracle = makeStubOracle();
  const pool = makePool({ oracle, sliceSize: 512 }).pool;
  pool.update(0.016, 1000, 1000, 0);            // first frame = full scatter
  check("the first update is a full scatter", pool.stats().fullRescatters === 1
    && pool.stats().lastRescattered === pool.count);

  // Settle, so the "10 m move" measurement is not paying off earlier debt.
  for (let i = 0; i < 40; i += 1) pool.update(0.016, 1000, 1000, 0);
  check("a stationary, resolved pool re-scatters NOTHING",
    pool.stats().lastRescattered === 0, String(pool.stats().lastRescattered));

  const versionsBefore = GRASS_SCHEMA.map((s) => pool.attributes[s.name].version);
  pool.update(0.016, 1000, 1000, 0);
  check("…and uploads nothing (no attribute version bump)",
    GRASS_SCHEMA.every((s, k) => pool.attributes[s.name].version === versionsBefore[k]));

  const samplesBefore = oracle._stats.samples;
  const moved = pool.update(0.016, 1010, 1000, 0);   // a 10 m step
  check(`a 10 m move re-scatters at most sliceSize (${moved} ≤ 512)`, moved <= 512 && moved > 0);
  check("the pool never samples the oracle more than it re-scatters",
    oracle._stats.samples - samplesBefore <= moved,
    `${oracle._stats.samples - samplesBefore} samples for ${moved} re-scatters`);
  check("the scan itself is bounded by scanBudget",
    pool.stats().lastScanned <= Math.max(SCATTER_DEFAULTS.scanBudget, 512));

  // It must CONVERGE: keep ticking at the new centre until the debt is paid.
  let ticks = 0;
  while (pool.stats().lastRescattered > 0 && ticks < 500) { pool.update(0.016, 1010, 1000, 0); ticks += 1; }
  check("the amortised debt is paid off in bounded ticks", ticks < 500, String(ticks));
  check("after convergence every instance owns a cell in the CURRENT window",
    (() => {
      const gxMin = Math.floor((1010 - 48) / pool.cellSizeM);
      const gyMin = Math.floor((1000 - 48) / pool.cellSizeM);
      for (let i = 0; i < pool.count; i += 1) {
        const gx = pool._cellX[i], gy = pool._cellY[i];
        if (gx < gxMin || gx >= gxMin + pool.gridSize) return false;
        if (gy < gyMin || gy >= gyMin + pool.gridSize) return false;
      }
      return true;
    })());
  check("a small sliceSize is honoured exactly",
    (() => {
      const p = makePool({ sliceSize: 64 }).pool;
      p.update(0.016, 2000, 2000, 0);
      for (let i = 0; i < 40; i += 1) p.update(0.016, 2000, 2000, 0);
      const n = p.update(0.016, 2020, 2000, 0);
      return n <= 64;
    })());
  check("a bad centre (NaN) is a no-op, not a crash",
    (() => {
      const n = pool.update(0.016, NaN, 1000, 0);
      return n === 0;
    })());
}

// ---------------------------------------------------------------------------
console.log("\n-- L7: teleport ⇒ full, non-amortised re-scatter --");
{
  const pool = makePool().pool;
  pool.update(0.016, 5000, 5000, 0);
  for (let i = 0; i < 40; i += 1) pool.update(0.016, 5000, 5000, 0);
  const fullsBefore = pool.stats().fullRescatters;

  const n = pool.update(0.016, 9000, 9000, 0);   // > one landblock ⇒ teleport
  check("an auto-detected teleport re-scatters EVERY instance", n === pool.count, String(n));
  check("it is counted as a teleport", pool.stats().teleports === 1
    && pool.stats().fullRescatters === fullsBefore + 1);
  check("every instance now sits in the arrival window",
    (() => {
      const gxMin = Math.floor((9000 - 48) / pool.cellSizeM);
      for (let i = 0; i < pool.count; i += 1) {
        if (pool._cellX[i] < gxMin || pool._cellX[i] >= gxMin + pool.gridSize) return false;
      }
      return true;
    })());
  check("the explicit rescatterAll() entry point does the same",
    pool.rescatterAll(1234, 5678, 3) === pool.count);
  check("autoTeleport can be disabled (the consumer drives it)",
    (() => {
      const p = makePool({ autoTeleport: false }).pool;
      p.update(0.016, 100, 100, 0);
      const m = p.update(0.016, 9000, 9000, 0);
      return m <= p.sliceSize;
    })());
  check("a sub-landblock move is NOT a teleport",
    (() => {
      const p = makePool().pool;
      p.update(0.016, 100, 100, 0);
      for (let i = 0; i < 40; i += 1) p.update(0.016, 100, 100, 0);
      const f = p.stats().fullRescatters;
      p.update(0.016, 180, 100, 0);
      return p.stats().fullRescatters === f;
    })());
}

// ---------------------------------------------------------------------------
console.log("\n-- L8: unbaked landblock ⇒ degenerate, then REVIVED --");
{
  let baked = false;
  const oracle = makeStubOracle({ codeAt: () => (baked ? 1 : null) });
  const pool = makePool({ oracle }).pool;
  pool.update(0.016, 700, 700, 0);
  check("a null sample leaves the instance degenerate", pool.stats().live === 0
    && pool.stats().nullSamples > 0);
  check("null samples are marked UNRESOLVED (they will be retried)",
    (() => {
      for (let i = 0; i < pool.count; i += 1) {
        if (pool._resolved[i] === 0) return true;   // at least the in-disc ones
      }
      return false;
    })());
  check("the aScale h of an unbaked instance is 0",
    (() => {
      for (let i = 0; i < pool.count; i += 1) if (pool.arrays.aScale[i * 2] !== 0) return false;
      return true;
    })());

  // The landblock bakes. No player movement at all.
  baked = true;
  let ticks = 0;
  while (pool.stats().lastRescattered > 0 && ticks < 500) { pool.update(0.016, 700, 700, 0); ticks += 1; }
  check("later amortised ticks revive them with NO player movement",
    pool.stats().live > 0, `live=${pool.stats().live} after ${ticks} ticks`);
  check("the revived field is the full in-disc population (≈ π/4 of the pool)",
    pool.stats().live > pool.count * 0.7 && pool.stats().live <= pool.count,
    `${pool.stats().live}/${pool.count}`);
  check("no instance is re-scattered once everything resolved",
    pool.update(0.016, 700, 700, 0) === 0);
  check("invalidate() forces a re-examination without moving the player",
    (() => {
      pool.invalidate();
      return pool.update(0.016, 700, 700, 0) > 0;
    })());
}

// ---------------------------------------------------------------------------
console.log("\n-- L9: steady state allocates nothing, upload ranges stay bounded --");
{
  ibaAllocs = 0;
  const { pool } = makePool();
  const allocAfterBuild = ibaAllocs;
  const arraysBefore = GRASS_SCHEMA.map((s) => pool.arrays[s.name]);
  // Nothing consumes `updateRanges` here (there is no renderer), which is the
  // worst case for unbounded growth.
  for (let i = 0; i < 300; i += 1) pool.update(0.016, 3000 + i * 0.7, 3000 + i * 0.3, 0);
  check("no buffer allocated after construction", ibaAllocs === allocAfterBuild);
  check("array identities unchanged",
    GRASS_SCHEMA.every((s, k) => pool.arrays[s.name] === arraysBefore[k]));
  check("pending updateRanges stay bounded on an unconsumed attribute",
    GRASS_SCHEMA.every((s) => pool.attributes[s.name].updateRanges.length <= SCATTER_DEFAULTS.maxPendingRanges),
    GRASS_SCHEMA.map((s) => pool.attributes[s.name].updateRanges.length).join(","));
  check("the instance matrix is uploaded through the same bounded path",
    pool.mesh.instanceMatrix.updateRanges.length <= SCATTER_DEFAULTS.maxPendingRanges);
  check("an update range never runs past the end of its buffer",
    GRASS_SCHEMA.every((s) => {
      const a = pool.attributes[s.name];
      return a.updateRanges.every((r) => r.start >= 0 && r.start + r.count <= a.array.length);
    }));
  check("dispose() drops the mesh and keeps the CONSUMER's geometry/material",
    (() => {
      const { pool: p, geometry, material } = makePool();
      p.update(0.016, 10, 10, 0);
      p.dispose();
      return p.mesh === null && geometry.getAttribute("position") !== undefined
        && material.dispose !== undefined;
    })());
}

// ---------------------------------------------------------------------------
console.log("\n-- L10: headless (no THREE) is a first-class mode --");
{
  const pool = createScatterPool({
    count: 1024,
    radiusM: 32,
    seed: 7,
    attributes: GRASS_SCHEMA,
    families: [FAM_GRASS],
    oracle: makeStubOracle(),
    fill: (ctx) => ctx.set("aScale", 0.5, 0.05),
  });
  check("no THREE ⇒ no mesh, no throw", pool.mesh === null);
  check("the CPU buffers still exist and still fill",
    pool.arrays.aOffset.length === 1024 * 3);
  pool.update(0.016, 400, 400, 0);
  check("headless scatter grounds instances", pool.stats().live > 0);
  check("headless placement matches the GPU pool exactly",
    (() => {
      const gpu = makePool({ count: 1024, radiusM: 32, seed: 7, fill: (c) => c.set("aScale", 0.5, 0.05) }).pool;
      gpu.rescatterAll(400, 400, 0);
      for (let i = 0; i < pool.arrays.aOffset.length; i += 1) {
        if (pool.arrays.aOffset[i] !== gpu.arrays.aOffset[i]) return false;
      }
      return true;
    })());
  check("a pool with no oracle at all degrades to all-degenerate, no throw",
    (() => {
      const p = createScatterPool({ count: 256, attributes: GRASS_SCHEMA });
      p.update(0.016, 0, 0, 0);
      return p.stats().live === 0;
    })());
  check("a LATE oracle (the ctx.oracle live-getter idiom) is picked up",
    (() => {
      let live = null;
      const p = createScatterPool({
        count: 256, attributes: GRASS_SCHEMA, families: [FAM_GRASS], oracle: () => live,
      });
      p.update(0.016, 300, 300, 0);
      if (p.stats().live !== 0) return false;
      live = makeStubOracle();
      let t = 0;
      while (p.stats().lastRescattered > 0 && t < 200) { p.update(0.016, 300, 300, 0); t += 1; }
      return p.stats().live > 0;
    })());
}

// ---------------------------------------------------------------------------
console.log("\n-- L11: the optional GLSL fade helper --");
{
  const names = ["uScatterCenter", "uScatterRadius", "uScatterFadeStart", "uScatterShape"];
  check("it declares exactly the uniforms the pool publishes",
    names.every((n) => (SCATTER_FADE_GLSL.match(new RegExp(`uniform [a-z0-9]+ ${n};`, "g")) || []).length === 1)
    && Object.keys(mainPool.uniforms).every((k) => names.includes(k)));
  const glslCode = SCATTER_FADE_GLSL.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  check("the fade is LINEAR (matching fadeFor), not a smoothstep",
    /clamp\(\(uScatterRadius - dist\) \/ band/.test(glslCode)
    && !/smoothstep/.test(glslCode));
  check("it honours the square shape the same way the CPU does",
    /uScatterShape == 1/.test(SCATTER_FADE_GLSL) && /max\(abs\(d\.x\), abs\(d\.y\)\)/.test(SCATTER_FADE_GLSL));
  check("no backticks inside GLSL comments (house rule)",
    !/\/\/[^\n]*`/.test(SCATTER_FADE_GLSL));
  check("it declares no light, no cache-key hook, no texture",
    !/PointLight|customProgramCacheKey|sampler2D/.test(SCATTER_FADE_GLSL));
}

// ---------------------------------------------------------------------------
console.log("\n-- source-level invariants (plan §5) --");
{
  const src = await (await import("node:fs/promises")).readFile("./scene3d/terrain_scatter.js", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
    .map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  check("no Math.random (§5.5)", !/Math\.random/.test(code));
  check("no wall-clock read (§5.5)", !/Date\.now|performance\.now/.test(code));
  check("no `.visible =` (§5.3)", !/\.visible\s*=/.test(code));
  check("no light is ever constructed (§5.2)", !/new THREE\.[A-Za-z]*Light/.test(code));
  check("no customProgramCacheKey (§5.4)", !/customProgramCacheKey/.test(code));
  check("castShadow is forced false (§5.7)", /castShadow = false/.test(code));
  check("it imports nothing (a true leaf module, node-loadable)",
    !/^\s*import\s/m.test(code));
  check("it reads no URL flags (the consumer gates, §2.4)",
    !/URLSearchParams|location\.search|_boolFlag|_strFlag/.test(code));
}

// ---------------------------------------------------------------------------
console.log(`\nterrain scatter: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

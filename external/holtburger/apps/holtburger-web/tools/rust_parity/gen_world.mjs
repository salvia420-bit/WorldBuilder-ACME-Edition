// tools/rust_parity/gen_world.mjs — lane W parity fixtures
// (docs/2026-10-26-rust-world.md §5): every scenario of
// gen_world_scenarios.mjs run through the REAL producers with the bridge armed
// on the JS reference model, written to
// crates/holtburger-scene/tests/fixtures/world_<scenario>.json for
// crates/holtburger-scene/tests/world_parity.rs.
//
// A fixture holds the recorded event stream (exactly what the bridge hands the
// kernel), and per checkpoint the audit arena the bridge built from three.js
// and the JS residency at that moment, the audit result (0 — the generator
// refuses to write a fixture whose own run is not clean), the integrity total
// and the model's table census. Negatives are single perturbations of a
// checkpoint's arena with the per-category counts the model reports for them,
// so the cargo replay proves the Rust audit is not vacuous either. A negative is
// stored as point edits `[[index, value], ...]` against its checkpoint's arena.
//
// Values travel as JSON numbers when they are integers (not -0) and as f64hex
// strings otherwise (fixture_util.mjs; serde_json integers are exact below 2^53).
//
// Run from apps/holtburger-web/:  node tools/rust_parity/gen_world.mjs [scenario...]

import { fileURLToPath } from "node:url";
import { f64hex, writeFixture } from "./fixture_util.mjs";

const _dv = new DataView(new ArrayBuffer(8));

/** Float64Array → JSON-safe values (integers as numbers, anything else as f64hex). */
export function encodeWorldValues(arr) {
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    out[i] = Number.isSafeInteger(v) && !Object.is(v, -0) ? v : f64hex(v);
  }
  return out;
}

/** The inverse of encodeWorldValues. */
export function decodeWorldValues(vals) {
  const out = new Float64Array(vals.length);
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (typeof v === "number") out[i] = v;
    else {
      _dv.setBigUint64(0, BigInt("0x" + v));
      out[i] = _dv.getFloat64(0);
    }
  }
  return out;
}

/** The model's census, flattened to the fields world_parity.rs compares. */
export function flatCensus(c) {
  const t = c.tiles || {};
  return {
    objects: c.objects, slots: c.slots, active: c.active, visible: c.visible, attributed: c.attributed,
    committed: c.committed, geometries: c.geometries,
    lb_index: c.lbIndex, tile_index: c.tileIndex, cell_index: c.cellIndex,
    lru_live: c.lru.live, lru_parked: c.lru.parked,
    tiles_fetching: t["1"] || 0, tiles_staged: t["2"] || 0, tiles_live: t["3"] || 0, tiles_parked: t["4"] || 0, tiles_quarantined: t["5"] || 0,
    pool_regs: c.pools.regs, pool_parked_tiles: c.pools.parkedTiles, pool_hidden_lbs: c.pools.hiddenLbs, pool_records: c.pools.records,
    objr_hidden: c.objrHidden, cells: c.cells,
  };
}

// Arena section walk (WORLD_SEC layout) → the offsets a perturbation needs.
function arenaIndex(a) {
  const out = { objects: [], lru: [], grid: [], objr: [], poolreg: [], poolrecs: [], matrices: [], ranges: [], untracked: [] };
  let i = 0;
  while (i < a.length) {
    const sec = a[i++];
    if (sec === 0) break;
    if (sec === 1) {
      out.objectsHeader = i;
      const n = a[i++];
      for (let q = 0; q < n; q++) { const len = a[i + 2]; out.objects.push({ at: i, len }); i += 3 + 2 * len; }
    } else if (sec === 2) { out.lru.push(i); const nl = a[i + 1]; const np = a[i + 2 + nl]; i += 3 + nl + np; }
    else if (sec === 3) { out.grid.push(i); i += 2 + 4 * a[i + 1]; }
    else if (sec === 4 || sec === 5) { if (sec === 4) out.objr.push(i); i += 2 + a[i + 1]; }
    else if (sec === 6) { out.poolreg.push(i); const np = a[i + 1]; const nh = a[i + 2 + np]; i += 3 + np + nh; }
    else if (sec === 9) { out.poolrecs.push(i); const n = a[i + 1]; let k = i + 2; for (let q = 0; q < n; q++) k += 4 + a[k + 3]; i = k; }
    else if (sec === 7) { out.matrices.push(i); i += 2 + 17 * a[i + 1]; }
    else if (sec === 8) { out.ranges.push(i); i += 2 + 3 * a[i + 1]; }
    else if (sec === 10) { out.untracked.push(i); i += 1; }
    else throw new Error(`bad section ${sec}`);
  }
  return out;
}

function firstActive(a, o) {
  for (let s = 0; s < o.len; s++) if ((a[o.at + 3 + 2 * s] & 1) === 1) return o.at + 3 + 2 * s;
  return -1;
}

/** Perturbation recipes: (arena copy, index) → label, or null when the arena has nothing to edit. */
const RECIPES = [
  ["visible bit", (a, ix) => { const o = ix.objects.find((x) => firstActive(a, x) >= 0); if (!o) return null; a[firstActive(a, o)] ^= 2; return "flip one instance's visible bit"; }],
  ["gid", (a, ix) => { const o = ix.objects.find((x) => firstActive(a, x) >= 0); if (!o) return null; a[firstActive(a, o) + 1] += 1; return "one instance's geometry id"; }],
  ["active", (a, ix) => { const o = ix.objects.find((x) => firstActive(a, x) >= 0); if (!o) return null; a[firstActive(a, o)] &= ~1; return "deactivate one instance"; }],
  ["lru", (a, ix) => { if (!ix.lru.length) return null; const at = ix.lru[0]; if (a[at + 1] === 0) return null; a[at + 2] = 0x7f7f0000; return "rename a live landblock"; }],
  ["tile state", (a, ix) => { if (!ix.grid.length || a[ix.grid[0] + 1] === 0) return null; const at = ix.grid[0]; a[at + 3] = a[at + 3] === 3 ? 4 : 3; return "one tile's state"; }],
  ["tile time", (a, ix) => { if (!ix.grid.length || a[ix.grid[0] + 1] === 0) return null; a[ix.grid[0] + 4] += 0.5; return "one tile's sinceMs"; }],
  ["objr", (a, ix) => { if (!ix.objr.length || a[ix.objr[0] + 1] === 0) return null; a[ix.objr[0] + 2] = 0x01020000; return "rename an objRadius-hidden landblock"; }],
  ["matrix", (a, ix) => { const at = ix.matrices.find((p) => a[p + 1] > 0); if (at === undefined) return null; a[at + 2 + 1 + 12] += 0.25; return "one matrix element"; }],
  ["ranges", (a, ix) => { const at = ix.ranges.find((p) => a[p + 1] > 0); if (at === undefined) return null; a[at + 2 + 1] += 3; return "one geometry range start"; }],
  ["pool reg", (a, ix) => { if (!ix.poolreg.length || a[ix.poolreg[0] + 1] === 0) return null; a[ix.poolreg[0] + 2] = 0x7777; return "rename a parked tile"; }],
  ["pool rec", (a, ix) => { if (!ix.poolrecs.length || a[ix.poolrecs[0] + 1] === 0) return null; const p = ix.poolrecs[0] + 2 + 2; a[p] = a[p] ? 0 : 1; return "one pool record's live flag"; }],
  ["untracked", (a, ix) => { if (!ix.untracked.length) return null; a[ix.untracked[0]] = 2; return "two untracked shadow-kind objects"; }],
  // 2026-10-29: a pool-registry landblock hide no ?objRadius set holds (the
  // drift the pre-fix forget left behind) — `poolHideOrphan`, plus the poolReg
  // diff of the renamed entry. Only arenas with an OBJR section and a hidden
  // landblock fit (the objrPool scenario).
  ["pool hide orphan", (a, ix) => {
    if (!ix.objr.length) return null;
    for (const at of ix.poolreg) {
      const np = a[at + 1];
      if (a[at + 2 + np] > 0) { a[at + 3 + np] = 0x7e7e0000; return "rename a pool-hidden landblock to one no objRadius set holds"; }
    }
    return null;
  }],
  ["pool hidden", (a, ix) => {
    for (const at of ix.poolrecs) {
      let k = at + 2;
      for (let q = 0; q < a[at + 1]; q++) {
        if (a[k + 3] > 0) { a[k + 4] = 0x7ffff; return "rename a pool record's hidden cell instance"; }
        k += 4 + a[k + 3];
      }
    }
    return null;
  }],
];

/** Generate one scenario's fixture object (throws when the run is not clean). */
export async function worldFixture(name) {
  const S = await import("./gen_world_scenarios.mjs");
  const { WorldModel, MISMATCH_KEYS, INTEGRITY_KEYS } = await import("./gen_world_model.mjs");
  const W = (await S.loadModules()).world;
  const r = await S.runScenario(name, { kernel: new WorldModel() });
  for (const cp of r.checkpoints) {
    if (!cp.audit || cp.audit.mismatches !== 0 || cp.audit.report.integrityTotal !== 0) {
      throw new Error(`${name}: "${cp.label}" is not clean (${JSON.stringify(cp.audit && cp.audit.report && cp.audit.report.last)})`);
    }
  }
  const checkpoints = r.checkpoints.map((cp) => ({
    label: cp.label,
    events_end: cp.eventsEnd,
    arena: encodeWorldValues(cp.audit.arena),
    mismatches: 0,
    integrity: 0,
    and_divergence: cp.audit.report.andDivergence,
    census: flatCensus(cp.census),
  }));
  // Negatives at a mid-run checkpoint (and the first one, for the objects-only recipes).
  const negatives = [];
  const picks = [...new Set([Math.floor(r.checkpoints.length / 2), 1, r.checkpoints.length - 2].filter((i) => i >= 0 && i < r.checkpoints.length))];
  // A recipe none of the picks can apply to takes the first checkpoint it fits.
  const all = r.checkpoints.map((_, i) => i);
  const fits = (fn, idx) => { const a = Float64Array.from(r.checkpoints[idx].audit.arena); return !!fn(a, arenaIndex(a)); };
  const jobs = [];
  for (const [key, fn] of RECIPES) {
    const mine = picks.filter((idx) => fits(fn, idx));
    if (mine.length === 0) { const first = all.find((idx) => fits(fn, idx)); if (first !== undefined) mine.push(first); }
    for (const idx of mine) jobs.push([idx, key, fn]);
  }
  for (const [idx, key, fn] of jobs) {
    const cp = r.checkpoints[idx];
    {
      const orig = cp.audit.arena;
      const a = Float64Array.from(orig);
      const what = fn(a, arenaIndex(a));
      if (!what) continue;
      const edits = [];
      for (let i = 0; i < a.length; i++) if (!Object.is(a[i], orig[i])) edits.push([i, ...encodeWorldValues([a[i]])]);
      const k = new WorldModel();
      k.apply(r.events.subarray(0, cp.eventsEnd));
      const m = k.audit(a);
      const cat = JSON.parse(k.report()).last.cat;
      const nz = Object.fromEntries(Object.entries(cat).filter(([, v]) => v));
      if (m <= 0) throw new Error(`${name}: perturbation "${key}" at "${cp.label}" was not caught`);
      negatives.push({ label: `${cp.label} / ${what}`, checkpoint: idx, edits, mismatches: m, cat: nz });
    }
  }
  return {
    abi: W.WORLD_ABI,
    scenario: name,
    ops: W.WORLD_OP,
    sections: W.WORLD_SEC,
    kinds: W.WORLD_KIND,
    tile_states: W.WORLD_TILE_STATE,
    mismatch_keys: MISMATCH_KEYS,
    integrity_keys: INTEGRITY_KEYS,
    events: encodeWorldValues(r.events),
    checkpoints,
    negatives,
  };
}

async function main() {
  const S = await import("./gen_world_scenarios.mjs");
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(S.SCENARIOS);
  for (const name of names) {
    const fx = await worldFixture(name);
    const p = writeFixture(`world_${name}`, fx);
    console.log(`${p}: ${fx.events.length} event values, ${fx.checkpoints.length} checkpoints, ${fx.negatives.length} negatives`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();

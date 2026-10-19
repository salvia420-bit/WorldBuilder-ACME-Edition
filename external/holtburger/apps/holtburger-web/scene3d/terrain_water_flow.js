// scene3d/terrain_water_flow.js — TERRAIN WATER THAT FLOWS DOWNSTREAM, and a
// swell that stays off what retail built flush with the water.
//
// ===========================================================================
// HISTORY (2026-10-19, owner)
// ===========================================================================
//   "a general issue with our modifications to water not flowing in the right
//    direction down these waterfalls ... it will be noticable that the water is
//    flowing towards a waterfall instead of away from it ... otherwise you have
//    to come up with some sort of system which understands which way the water
//    needs to flow, and still have to come up with solutions around the
//    waterfalls."  And: "there are some dams on marae lassel and the water can
//    clip into the dams a little bit".
//
// What was wrong:
//   * terrain.js scrolled EVERY water pixel the same way, fract(cellUv +
//     uTime * (0.05, 0.02)): the pattern drifted west-south-west at ~1.3 m/s on
//     rivers, lakes and the sea alike. Pools crawled toward the falls above
//     them, and on a steep water face (cellUv is a horizontal parameterisation)
//     the texture slid sideways or uphill.
//   * The swell lifts every water vertex up to +0.24 m. Retail built the Marae
//     Lassel dams flush with the water: under East Fork Dam's north end (0x1FBC
//     cell 4,2) and West Fork Dam's south end (0x1BBB cell 5,7) retail's split
//     leaves a flat 82.000 m terrain triangle with one reservoir corner, and
//     the swell tilted water up through the walkway every few seconds. And a
//     subdivided shoreline point took its NEAREST corner's code (full swell or
//     none) while the coarser neighbour drew the chord: a 0.125 m crack on
//     water/land edges at the moving LOD boundary.
//
// ===========================================================================
// 1. FLOW  (?waterFlow — default ON; off|0|false|no restores the old drift)
// ===========================================================================
// Direction cannot come from height: Dereth's rivers are flat terraces (99.6 %
// of running-water vertices sit on flats; the river below Cragstone lake even
// sits 2 m ABOVE the lake it drains). It comes from an offline bake over the
// whole world, tools/water-flow/bake_water_flow.py -> data/water_flow.bin: a
// priority flood to the ocean over land and water (water routes always win,
// lakes fill to their spill point, falls open their land gaps), giving each
// water vertex its downstream direction and a speed (river 1, falls up to 4,
// fed lakes 0.2, plunge pools radially away from the foot), plus a whitewater
// amount (fall faces, the water at a fall's foot, rapids).
//
// The fragment shader turns that into a TWO-PHASE FLOW MAP (Vlachos, "Water
// Flow in Portal 2", 2010): the water texture is sampled twice, each copy
// advected along the local flow and restarted every `period` seconds, half a
// period apart, cross-faded by a triangle weight so neither restart shows; the
// phase is jittered per place so the surface never pulses as one. Spatially
// varying flow therefore never shears the texture by more than one period's
// travel. Where the table says nothing (still lakes, the open sea) the water
// gets a slow wandering eddy instead of a heading (`still`, m/s). The ripple
// normal of the sheen rides the same two phases, and whitewater is drawn as
// soft white patches carried by them.
//
// ===========================================================================
// 2. BANKED SWELL  (?waterBank — default ON; off|0|false|no = per-vertex gate)
// ===========================================================================
// The swell is evaluated on EVERY vertex as the bilinear blend, over the 24 m
// lattice, of (swell × weight) at the four lattice corners. Weight = 0 on land
// and on a water vertex with a lower neighbour (a dam crest, a waterfall lip),
// else 1. A bilinear function restricted to an axis-aligned edge is linear, so
// every subdivision factor still draws the same surface (crack-free), now at
// shorelines too; the dam corners stay at retail height. Neighbours are read
// inside this landblock only — along the edge for an edge vertex, none for a
// landblock corner — so both landblocks sharing a vertex compute the same
// weight without each other's data.
//
// ===========================================================================
// DATA: columns 18..35 of the per-landblock `uVertexTypes` texture
// ===========================================================================
// No new sampler (the terrain program is at 15 of the 1070's 16 fragment
// units). The texture is 36 wide whenever either feature is on (session
// constant, read at module load like every sibling terrain flag):
//   0..8    R = terrain code, G = road*64         (terrain.js / adapter.js)
//   9..17   RG = retail normals                   (terrain_round.js bevel)
//   18..26  RG = flow east / north, biased: byte 128 = still,
//           128 +- 127 = +- the table's full scale (uWaterFlow.y m/s)
//   27..35  R = swell weight 0..255, G = whitewater 0..255
// Texel (column + x, y) holds lattice vertex (x, y). terrain_batch.js copies
// the layer and stamps B/A of every texel with its per-LB validity bits, so
// these blocks use R/G only.

const FLAG_OFF = new Set(["off", "0", "false", "no"]);

export const WATER_FLOW_COL = 18;
export const WATER_AUX_COL = 27;
export const WATER_TYPES_COLS = 36;

/** Default tuning. `speed` is m/s per table speed unit (a plain river = 1 unit). */
export const WATER_FLOW_DEFAULTS = Object.freeze({
  speed: 1.2,
  period: 1.6,
  still: 0.35,
  foam: 1.0,
});

/** A float search param in [lo, hi], else `def`. */
function _num(p, name, def, lo, hi) {
  const raw = p.get(name);
  if (raw == null) return def;
  if (FLAG_OFF.has(String(raw).toLowerCase())) return lo;
  const v = Number(raw);
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def;
}

/**
 * Session config from the page URL (or `search` for tests).
 *   ?waterFlow=off   the old one-way drift (no flow map, no whitewater)
 *   ?waterBank=off   the old per-vertex code-gated swell
 *   ?waterFlowSpeed  m/s per table speed unit, 0..4 (default 1.2)
 *   ?waterFlowPeriod flow-map restart period, 0.5..8 s (default 1.6)
 *   ?waterStill      eddy speed on still water, 0..2 m/s (default 0.35; off = 0)
 *   ?waterFoam       whitewater strength, 0..2 (default 1; off = 0)
 */
export function readWaterFlowConfig(search) {
  let s = search;
  if (s == null) {
    try {
      s = typeof window !== "undefined" && window.location ? window.location.search : "";
    } catch (_) {
      s = "";
    }
  }
  let p;
  try {
    p = new URLSearchParams(s || "");
  } catch (_) {
    p = new URLSearchParams("");
  }
  const flowRaw = p.get("waterFlow");
  const bankRaw = p.get("waterBank");
  return {
    flow: !(flowRaw != null && FLAG_OFF.has(flowRaw.toLowerCase())),
    bank: !(bankRaw != null && FLAG_OFF.has(bankRaw.toLowerCase())),
    speed: _num(p, "waterFlowSpeed", WATER_FLOW_DEFAULTS.speed, 0, 4),
    period: _num(p, "waterFlowPeriod", WATER_FLOW_DEFAULTS.period, 0.5, 8),
    still: _num(p, "waterStill", WATER_FLOW_DEFAULTS.still, 0, 2),
    foam: _num(p, "waterFoam", WATER_FLOW_DEFAULTS.foam, 0, 2),
  };
}

/** The session config (module load, like every sibling terrain flag). */
export const WATER_FLOW = readWaterFlowConfig();

/** Width of the per-LB `uVertexTypes` texture given the base width (9 or 18). */
export function waterTypesCols(baseCols, cfg = WATER_FLOW) {
  return cfg && (cfg.flow || cfg.bank) ? Math.max(WATER_TYPES_COLS, baseCols) : baseCols;
}

// ---------------------------------------------------------------------------
// Banked swell weights
// ---------------------------------------------------------------------------

/** A water vertex with a neighbour lower than this (m) sits at a drop. */
export const WATER_BANK_DROP_M = 0.5;

/**
 * Swell weight (0 or 255) for the 81 lattice vertices of one landblock, index
 * x*9+y (the wasm `terrainCodes` / `heights` order). `swellMask` is the
 * vertex stage's uWaterCodeMask (bit c = code c swells).
 */
export function computeWaterBankWeights(codes, heights, swellMask, out) {
  const w = out || new Uint8Array(81);
  const mask = swellMask >>> 0;
  for (let x = 0; x <= 8; x += 1) {
    for (let y = 0; y <= 8; y += 1) {
      const i = x * 9 + y;
      const c = codes ? codes[i] : -1;
      if (!(c >= 0 && c < 32 && ((mask >>> c) & 1) === 1)) {
        w[i] = 0;
        continue;
      }
      const h = heights ? heights[i] : NaN;
      if (!Number.isFinite(h)) {
        w[i] = 255;
        continue;
      }
      const floor = h - WATER_BANK_DROP_M;
      const onX = x === 0 || x === 8;
      const onY = y === 0 || y === 8;
      let k = 255;
      if (onX && onY) {
        // Landblock corner: shared by four landblocks — itself only.
      } else if (onX) {
        if (heights[i - 1] < floor || heights[i + 1] < floor) k = 0;
      } else if (onY) {
        if (heights[i - 9] < floor || heights[i + 9] < floor) k = 0;
      } else if (heights[i - 1] < floor || heights[i + 1] < floor
              || heights[i - 9] < floor || heights[i + 9] < floor) {
        k = 0;
      }
      w[i] = k;
    }
  }
  return w;
}

// ---------------------------------------------------------------------------
// The flow table (data/water_flow.bin, tools/water-flow/README.md)
// ---------------------------------------------------------------------------
//   0  "HBWF"   4  u16 version (1)   6  u16 count   8  f32 fullScaleUnits
//   12 u32 reserved   16  u16 lbKey[count] ascending, zero-padded to 4 bytes
//   then count blocks of 81 * 3 bytes, vertex i = x*9+y: [flowE, flowN, foam],
//   flowE/flowN biased (128 = still).

export const WATER_FLOW_TABLE_URL = "./data/water_flow.bin";
const ENTRY_BYTES = 81 * 3;

/** Parse the table; null on any structural problem (logged by the loader). */
export function parseWaterFlowTable(buf) {
  if (!buf || typeof buf.byteLength !== "number" || buf.byteLength < 16) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== 0x48 || dv.getUint8(1) !== 0x42 || dv.getUint8(2) !== 0x57 || dv.getUint8(3) !== 0x46) {
    return null;
  }
  if (dv.getUint16(4, true) !== 1) return null;
  const count = dv.getUint16(6, true);
  const fullScaleUnits = dv.getFloat32(8, true);
  if (!(fullScaleUnits > 0)) return null;
  const dataOff = (16 + count * 2 + 3) & ~3;
  if (buf.byteLength !== dataOff + count * ENTRY_BYTES) return null;
  const offsets = new Map();
  let prev = -1;
  for (let k = 0; k < count; k += 1) {
    const key = dv.getUint16(16 + k * 2, true);
    if (key <= prev) return null;
    prev = key;
    offsets.set(key, dataOff + k * ENTRY_BYTES);
  }
  return { fullScaleUnits, count, offsets, bytes: new Uint8Array(buf) };
}

/** This landblock's 243-byte block, or null (no moving water / no table). */
export function waterFlowEntry(table, lbKey) {
  if (!table) return null;
  const off = table.offsets.get(lbKey & 0xffff);
  return off == null ? null : table.bytes.subarray(off, off + ENTRY_BYTES);
}

let _tablePromise = null;
let _table = null;

/**
 * Fetch + parse the table once per session (memoised). Fail-soft: resolves
 * null (still water everywhere, the swell unaffected) on any error. `no-cache`
 * revalidates, so a regenerated table is never served stale.
 */
export function loadWaterFlowTable(url = WATER_FLOW_TABLE_URL, fetchImpl) {
  if (_tablePromise) return _tablePromise;
  const f = fetchImpl || (typeof fetch === "function" ? fetch : null);
  _tablePromise = (async () => {
    if (!f) return null;
    try {
      const r = await f(url, { cache: "no-cache" });
      if (!r || !r.ok) {
        console.warn(`[waterFlow] ${url} HTTP ${r ? r.status : "?"}; still water everywhere`);
        return null;
      }
      const t = parseWaterFlowTable(await r.arrayBuffer());
      if (!t) console.warn(`[waterFlow] ${url} failed to parse; still water everywhere`);
      _table = t;
      return t;
    } catch (e) {
      console.warn(`[waterFlow] ${url} fetch failed (${e && e.message ? e.message : e}); still water everywhere`);
      return null;
    }
  })();
  return _tablePromise;
}

/** The loaded table (null before / without it). */
export function waterFlowTable() {
  return _table;
}

/** Test seam. */
export function _setWaterFlowTableForTest(t) {
  _table = t;
  _tablePromise = t ? Promise.resolve(t) : null;
}

/**
 * Write columns 18..35 of a `cols`-wide RGBA8 vertex-types block. `entry` is
 * this landblock's table block (null = still everywhere), `bankWeights` its
 * 81 swell weights (null = 0). Every byte of both blocks is written, so a
 * pooled texture never carries the previous landblock's data.
 */
export function writeWaterColumns(bytes, cols, entry, bankWeights) {
  if (!bytes || cols < WATER_TYPES_COLS) return false;
  for (let y = 0; y <= 8; y += 1) {
    for (let x = 0; x <= 8; x += 1) {
      const i = x * 9 + y;
      const f = (y * cols + WATER_FLOW_COL + x) * 4;
      const a = (y * cols + WATER_AUX_COL + x) * 4;
      bytes[f] = entry ? entry[i * 3] : 128;
      bytes[f + 1] = entry ? entry[i * 3 + 1] : 128;
      bytes[f + 2] = 0;
      bytes[f + 3] = 255;
      bytes[a] = bankWeights ? bankWeights[i] : 0;
      bytes[a + 1] = entry ? entry[i * 3 + 2] : 0;
      bytes[a + 2] = 0;
      bytes[a + 3] = 255;
    }
  }
  return true;
}

/** The shader's decode of one flow byte pair -> [east, north] in table units. */
export function decodeFlowBytes(e, n, fullScaleUnits) {
  const k = fullScaleUnits / 127;
  return [Math.max(-127, Math.min(127, e - 128)) * k, Math.max(-127, Math.min(127, n - 128)) * k];
}

// ---------------------------------------------------------------------------
// Uniforms + live tuning
// ---------------------------------------------------------------------------

const _live = {
  speed: WATER_FLOW.speed,
  period: WATER_FLOW.period,
  still: WATER_FLOW.still,
  foam: WATER_FLOW.foam,
};

function _fullScaleUnits() {
  return _table ? _table.fullScaleUnits : 4.0;
}

/**
 * The material's water-flow uniforms.
 *   uWaterFlow = (on, m/s at byte +-127, period s, still-water eddy m/s)
 *   uWaterFoam = (strength, fast-water foam start m/s, full m/s, unused)
 */
export function waterFlowUniforms(Vector4) {
  return {
    uWaterFlow: {
      value: new Vector4(WATER_FLOW.flow ? 1 : 0, _live.speed * _fullScaleUnits(), _live.period, _live.still),
    },
    uWaterFoam: { value: new Vector4(WATER_FLOW.flow ? _live.foam : 0, 3.5, 7.0, 0) },
  };
}

function _applyLive(m) {
  const u = m && m.uniforms;
  if (!u || !u.uWaterFlow || !u.uWaterFlow.value) return false;
  const f = u.uWaterFlow.value;
  if (typeof f.set === "function") f.set(f.x, _live.speed * _fullScaleUnits(), _live.period, _live.still);
  const fo = u.uWaterFoam && u.uWaterFoam.value;
  if (fo && typeof fo.set === "function") fo.set(f.x > 0.5 ? _live.foam : 0, fo.y, fo.z, fo.w);
  return true;
}

/**
 * Live tuning without a reload: { speed (m/s per unit), period (s), still
 * (m/s), foam (0..2) }. Applies to every registered terrain material (per-LB
 * and the terrain batch) and to materials built later.
 */
export function setWaterFlowLive(scene3d, patch = {}) {
  if (Number.isFinite(patch.speed)) _live.speed = Math.max(0, Math.min(4, patch.speed));
  if (Number.isFinite(patch.period)) _live.period = Math.max(0.5, Math.min(8, patch.period));
  if (Number.isFinite(patch.still)) _live.still = Math.max(0, Math.min(2, patch.still));
  if (Number.isFinite(patch.foam)) _live.foam = Math.max(0, Math.min(2, patch.foam));
  let touched = 0;
  const seen = new Set();
  const lists = [scene3d && scene3d.terrainMaterials];
  try {
    const liveS = typeof window !== "undefined" ? window.liveScene3d : null;
    if (liveS && liveS !== scene3d) lists.push(liveS.terrainMaterials);
  } catch (_) { /* fail-soft */ }
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      if (_applyLive(m)) touched += 1;
    }
  }
  return { ..._live, materials: touched };
}

/**
 * Diag: the baked flow (m/s, east/north), whitewater and table presence at a
 * world AC point (metres), plus the session config. Nearest lattice vertex.
 */
export function waterFlowAt(x, y) {
  const gx = Math.round(x / 24);
  const gy = Math.round(y / 24);
  const lbX = Math.min(254, Math.floor(gx / 8));
  const lbY = Math.min(254, Math.floor(gy / 8));
  const lx = gx - lbX * 8;
  const ly = gy - lbY * 8;
  const lbKey = (lbX << 8) | lbY;
  const entry = waterFlowEntry(_table, lbKey);
  const i = lx * 9 + ly;
  const scale = _live.speed;
  const [e, n] = entry ? decodeFlowBytes(entry[i * 3], entry[i * 3 + 1], _fullScaleUnits()) : [0, 0];
  return {
    lbKey: "0x" + lbKey.toString(16).toUpperCase().padStart(4, "0"),
    vertex: [lx, ly],
    flowMs: [e * scale, n * scale],
    foam: entry ? entry[i * 3 + 2] / 255 : 0,
    inTable: !!entry,
  };
}

/** Install `window.__waterFlow` (diag + live tuning). */
export function installWaterFlowDiag(scene3d) {
  try {
    if (typeof window === "undefined") return;
    window.__waterFlow = {
      config: { ...WATER_FLOW },
      table: () => (_table ? { landblocks: _table.count, fullScaleUnits: _table.fullScaleUnits } : null),
      at: (x, y) => waterFlowAt(x, y),
      set: (patch) => setWaterFlowLive(scene3d, patch),
    };
  } catch (_) { /* fail-soft */ }
}

// ---------------------------------------------------------------------------
// Shader. Injected into terrain.js only when the matching feature is on, so
// `?waterFlow=off&waterBank=off` compiles none of this code (terrain.js keeps
// the sheen's ripple field as a shared function either way, same maths). The
// texelFetch lines are terrain_batch.js anchors (rewritten to the
// sampler2DArray + slot form).
// ---------------------------------------------------------------------------

/** Vertex stage: the sampler (its own text — the fragment's declaration is a batch anchor). */
export const WATER_BANK_VERTEX_DECL_GLSL = `
// ?waterBank (scene3d/terrain_water_flow.js) — the per-landblock vertex-types
// texture, read in this stage only for the swell weights (columns 27..35, R).
uniform highp sampler2D uVertexTypes;
`;

/** The vertex-stage texelFetch line terrain_batch.js rewrites. */
export const WATER_BANK_FETCH_ANCHOR =
  "  return texelFetch(uVertexTypes, ivec2(27 + x, y), 0).r;";
export const WATER_BANK_FETCH_BATCHED =
  "  return texelFetch(uVertexTypes, ivec3(27 + x, y, int(aLbSlot + 0.5)), 0).r;";
export const WATER_BANK_VDECL_ANCHOR = "uniform highp sampler2D uVertexTypes;";
export const WATER_BANK_VDECL_BATCHED = "uniform highp sampler2DArray uVertexTypes;";

export const WATER_BANK_VERTEX_FN_GLSL = `

// ?waterBank — swell weight of lattice vertex (x, y) of this landblock, 0..1:
// 0 on land and beside a drop (scene3d/terrain_water_flow.js).
float waterBankWeightAt(int x, int y) {
  return texelFetch(uVertexTypes, ivec2(27 + x, y), 0).r;
}

// ?waterBank — the lattice swell weighted per corner: bilinear over the 24 m
// lattice of (swell x weight), so it is linear along every cell edge (no LOD
// crack, shorelines included) and exactly 0 at a weight-0 corner. lxy is the
// landblock-local position (metres), wxy the same point in the world frame.
float waterSwellBanked(vec2 lxy, vec2 wxy) {
  vec2 g = lxy * (1.0 / 24.0);
  ivec2 i0 = clamp(ivec2(floor(g)), ivec2(0), ivec2(7));
  vec2 f = clamp(g - vec2(i0), 0.0, 1.0);
  float k00 = waterBankWeightAt(i0.x, i0.y);
  float k10 = waterBankWeightAt(i0.x + 1, i0.y);
  float k01 = waterBankWeightAt(i0.x, i0.y + 1);
  float k11 = waterBankWeightAt(i0.x + 1, i0.y + 1);
  if (k00 + k10 + k01 + k11 <= 0.0) return 0.0;
  vec2 c0 = wxy - f * 24.0;
  float s00 = waterSwellAt(c0) * k00;
  float s10 = waterSwellAt(c0 + vec2(24.0, 0.0)) * k10;
  float s01 = waterSwellAt(c0 + vec2(0.0, 24.0)) * k01;
  float s11 = waterSwellAt(c0 + vec2(24.0, 24.0)) * k11;
  return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
}
`;

export const WATER_BANK_VERTEX_APPLY_GLSL = `
  // ?waterBank (scene3d/terrain_water_flow.js) — the swell on EVERY vertex,
  // weighted per lattice corner (0 on land and beside a drop: dam crests,
  // waterfall lips), replacing the per-vertex code gate above. A subdivided
  // shore point now lands on the coarse chord, and nothing retail built flush
  // with the water gets water pushed up through it.
  if (uDisplacementEnabled > 0.5) {
    appliedSwell = waterSwellBanked(position.xy, worldXy);
    displacedPos.z += appliedSwell;
  }
`;

/** Fragment-stage uniforms (spliced after uWaterSheenFade). */
export const WATER_FLOW_FRAG_DECL_GLSL = `
uniform vec4 uWaterFlow;              // 2026-10-19 ?waterFlow — (on, m/s at byte +-127, period s, still-water eddy m/s)
uniform vec4 uWaterFoam;              // 2026-10-19 ?waterFlow — (whitewater strength, fast-water foam start / full m/s, unused)
`;

/** The fragment-stage texelFetch lines terrain_batch.js rewrites. */
export const WATER_FLOW_FETCH_ANCHOR =
  "  vec2 e = texelFetch(uVertexTypes, ivec2(18 + x, y), 0).rg;";
export const WATER_FLOW_FETCH_BATCHED =
  "  vec2 e = texelFetch(uVertexTypes, ivec3(18 + x, y, int(vLbSlot + 0.5)), 0).rg;";
export const WATER_FOAM_FETCH_ANCHOR =
  "  return texelFetch(uVertexTypes, ivec2(27 + x, y), 0).g;";
export const WATER_FOAM_FETCH_BATCHED =
  "  return texelFetch(uVertexTypes, ivec3(27 + x, y, int(vLbSlot + 0.5)), 0).g;";

/** Fragment helpers (global scope, after the uVertexTypes readers). */
export const WATER_FLOW_FRAG_GLSL = `

// ?waterFlow (scene3d/terrain_water_flow.js) — the baked flow at lattice
// vertex (x, y): columns 18..26, RG = east / north, byte 128 = still, +-127 =
// +-1 (times uWaterFlow.y m/s).
vec2 waterFlowAt(int x, int y) {
  vec2 e = texelFetch(uVertexTypes, ivec2(18 + x, y), 0).rg;
  return clamp((e * 255.0 - 128.0) * (1.0 / 127.0), -1.0, 1.0);
}

// ?waterFlow — the baked whitewater amount at lattice vertex (x, y), 0..1.
float waterFoamAt(int x, int y) {
  return texelFetch(uVertexTypes, ivec2(27 + x, y), 0).g;
}
`;

/**
 * main(): right after the old scroll. Declares the flow-map state every later
 * water splice reads (waterCellUvB, waterOffA/B, waterPhaseW, waterFoam,
 * waterFlowSpeed) and re-aims waterCellUv along the flow.
 */
export const WATER_FLOW_MAIN_GLSL = `

  // ?waterFlow (scene3d/terrain_water_flow.js) — the scroll above drifted
  // every water pixel west-south-west. Re-aim it along this water's own flow:
  // the bilinear blend of the four corners' baked flow, or a slow wandering
  // eddy where nothing is baked (still lakes, the open sea), advected as a
  // two-phase flow map — two taps restarting half a period apart, cross-faded
  // by a triangle weight so neither restart shows, the phase jittered per
  // place so the surface never pulses as one.
  vec2 waterCellUvB = waterCellUv;
  vec2 waterOffA = vec2(0.0);
  vec2 waterOffB = vec2(0.0);
  float waterPhaseW = 1.0;
  float waterFoam = 0.0;
  float waterFlowSpeed = 0.0;
  if (uWaterFlow.x > 0.5 && uWaterScrollEnabled > 0.5 && cellTouchesWater) {
    float qw00 = (1.0 - fu) * (1.0 - fv);
    float qw10 = fu * (1.0 - fv);
    float qw01 = (1.0 - fu) * fv;
    float qw11 = fu * fv;
    vec2 flowMs = (waterFlowAt(iu, iv) * qw00 + waterFlowAt(iu + 1, iv) * qw10
                 + waterFlowAt(iu, iv + 1) * qw01 + waterFlowAt(iu + 1, iv + 1) * qw11) * uWaterFlow.y;
    waterFoam = waterFoamAt(iu, iv) * qw00 + waterFoamAt(iu + 1, iv) * qw10
              + waterFoamAt(iu, iv + 1) * qw01 + waterFoamAt(iu + 1, iv + 1) * qw11;
    vec2 gpFlow = vec2(vWorldPos.x, -vWorldPos.z);
    float bakedSpeed = length(flowMs);
    if (uWaterFlow.w > 0.0 && bakedSpeed < 0.25) {
      // Two independent mean-zero noises: an eddy with no preferred heading,
      // wandering over ~90 m and a few minutes.
      vec2 eddyP = gpFlow * 0.011 + vec2(uTime * 0.003, -uTime * 0.002);
      vec2 eddy = vec2(fragValueNoise2D(eddyP), fragValueNoise2D(eddyP + vec2(31.7, -12.3)))
                * (2.0 * uWaterFlow.w);
      flowMs = mix(eddy, flowMs, bakedSpeed * 4.0);
    }
    waterFlowSpeed = length(flowMs);
    float period = uWaterFlow.z;
    float ph0 = fract(uTime / period + fragValueNoise2D(gpFlow * 0.03));
    float ph1 = fract(ph0 + 0.5);
    waterOffA = flowMs * (period * ph0);
    waterOffB = flowMs * (period * ph1);
    // No fixed offset between the two taps: where the flow is ~0 they sample
    // the same texel and the cross-fade cannot pulse (still water stays still).
    waterCellUv = fract(cellUv - waterOffA * (1.0 / 24.0));
    waterCellUvB = fract(cellUv - waterOffB * (1.0 / 24.0));
    waterPhaseW = 1.0 - abs(2.0 * ph0 - 1.0);
  }`;

/** TexMerge base slot: the second phase's tap, cross-faded in. */
export const WATER_FLOW_MERGE_BASE_GLSL = `
    if (waterPhaseW < 0.999 && isWaterCode(baseLayer)) {
      merged = mix(terrainAtlasTex(clamp(baseLayer, 0, 32), waterCellUvB).rgb, merged, waterPhaseW);
    }`;

/** TexMerge overlay slots: same, per water layer. */
export const WATER_FLOW_MERGE_SLOT_GLSL = `
        if (waterPhaseW < 0.999 && isWaterCode(layer)) {
          overlayCol = mix(terrainAtlasTex(clamp(layer, 0, 32), waterCellUvB).rgb, overlayCol, waterPhaseW);
        }`;

/** Bilinear corner taps (TERRAIN_BILINEAR_TAPS_GLSL): same, per water corner. */
export const WATER_FLOW_BILINEAR_TAPS_GLSL = `
  if (waterPhaseW < 0.999) {
    if (wc00) c00 = mix(terrainAtlasTex(clamp(t00, 0, 32), waterCellUvB).rgb, c00, waterPhaseW);
    if (wc10) c10 = mix(terrainAtlasTex(clamp(t10, 0, 32), waterCellUvB).rgb, c10, waterPhaseW);
    if (wc01) c01 = mix(terrainAtlasTex(clamp(t01, 0, 32), waterCellUvB).rgb, c01, waterPhaseW);
    if (wc11) c11 = mix(terrainAtlasTex(clamp(t11, 0, 32), waterCellUvB).rgb, c11, waterPhaseW);
  }`;

/** After the tint breath: whitewater on the albedo. */
export const WATER_FOAM_APPLY_GLSL = `

  // ?waterFlow — whitewater: the baked foam (fall faces, the water at a fall's
  // foot, rapids) plus anything running fast, as soft white patches carried by
  // the same two phases as the texture, so they ride the flow downstream.
  if (uWaterFoam.x > 0.0 && waterW > 0.0) {
    float foamAmt = clamp((waterFoam + smoothstep(uWaterFoam.y, uWaterFoam.z, waterFlowSpeed))
                          * uWaterFoam.x, 0.0, 1.0);
    if (foamAmt > 0.004) {
      vec2 gpFoam = vec2(vWorldPos.x, -vWorldPos.z);
      vec2 fpA = (gpFoam - waterOffA) * 0.45;
      vec2 fpB = (gpFoam - waterOffB) * 0.45;
      float fnA = fragValueNoise2D(fpA) + 0.5 * fragValueNoise2D(fpA * 3.1);
      float fnB = fragValueNoise2D(fpB) + 0.5 * fragValueNoise2D(fpB * 3.1);
      float fn = mix(fnB, fnA, waterPhaseW);
      // Coverage grows with the amount (peaks only -> nearly all); the colour
      // keeps the noise's light and shade so full whitewater is not a flat sheet.
      float lo = 0.3 - 0.8 * foamAmt;
      float cover = smoothstep(lo, lo + 0.3, fn);
      vec3 foamCol = vec3(0.78, 0.84, 0.86) * (0.88 + 0.35 * fn);
      result = mix(result, foamCol, cover * foamAmt * 0.9 * waterW);
    }
  }`;

/** The sheen's ripple slope, evaluated at both flow-advected positions. */
export const WATER_FLOW_RIPPLE_SLOPE_GLSL =
  "mix(waterRippleSlope(gp - waterOffB), waterRippleSlope(gp - waterOffA), waterPhaseW)";

// scene3d/passability_overlay.js — ground too steep to walk up, tinted red in
// the 3D world around the player (2026-10-19; VTank / RynthAi "Show Terrain
// Passability", the profile option ShowTerrainPassability — Route tab › Steep,
// driven page-wide by plugins/rynth-vt/display.js).
//
// ── The rule (game physics) ────────────────────────────────────────────────
// Outdoor ground is two planar triangles per 24 m cell, cut along the cell's
// own diagonal — SW→NE or SE→NW, the game's per-cell hash
// (terrain_oracle.js cellSwToNeCut = acclient CLandBlockStruct::
// ConstructPolygons). A triangle is walkable when its unit normal's z is at
// least FLOOR_Z = cos 48.4° (acclient PhysicsGlobals::floor_z, f32; ACE
// PhysicsObj.is_valid_walkable; crates/holtburger-dat/src/transition/
// types.rs FLOOR_Z); steeper ground cannot be walked up. The same test as
// RynthAi's TerrainSampler.GetTrianglePassability (vendored:
// apps/rynthnav-sidecar/vendor/rynthsuite/Shared/RynthCore.TerrainData/
// TerrainSampler.cs) and its TerrainPassabilityOverlay (cells within 4 of the
// player's cell, ARGB 0x60FF2020); here a disc of `radiusCells` (5 ≈ 130 m)
// that crosses landblock edges, drawn as filled triangles.
//
// ── Three layers ───────────────────────────────────────────────────────────
//   buildPassabilityGeometry(getLandblock, x, y, opts) — pure, no THREE: the
//     steep triangles of the cells around AC world (x, y), positions relative
//     to the centre cell's SW corner.
//   createPassabilityOverlay({ THREE, parent, opts }) — one Mesh over one
//     preallocated position buffer; update(x, y, getLandblock) rebuilds only
//     when the player's cell moved `rebuildCells` from the last build or the
//     heights of a landblock in reach changed (streamed in / out, re-baked).
//   installPassabilityOverlay(win, cfg) — the page attach (the
//     route_overlay.js installRouteOverlay pattern): while visible it polls
//     at 2 Hz for the live scene (follows a scene swap), reads the player's
//     cell from the session pose — outdoors only, never in portal space —
//     and the heights from liveScene3d.terrainGroup, and publishes
//     window.__rynthPassabilityOverlay. Hidden = no timer, nothing in the
//     scene graph. THREE is injected or imported ("three", the import-map
//     instance scene3d uses) on the first show.
//
// ── Heights and frame ──────────────────────────────────────────────────────
// Every terrain mesh carries userData.heights (the 81 retail vertex heights,
// idx = vx·9 + vy) and lbX / lbY (terrain.js); landblock_lru.js parks far
// meshes out of terrainGroup, never the ones around the player. Drawn under
// liveScene3d.entitiesGroup — AC metres, x east / y north / z up inside
// worldRoot's −π/2 turn, as route_overlay.js. The DRAWN ground leaves these
// retail triangles inside a cell by terrain rounding's fillet
// (visual_ground.js: 0 at every retail vertex, at most the landblock's
// userData.roundMaxAbsM), so the tint floats liftM + the largest
// roundMaxAbsM in reach above them: no z-fighting, one seamless surface.
//
// ── Budget ─────────────────────────────────────────────────────────────────
// One draw call while shown and something is steep; none while hidden,
// indoors or on gentle ground. One MeshBasicMaterial program (transparent,
// depthWrite off, fog and tone mapping off, no vertex colours), no lights,
// no onBeforeCompile / customProgramCacheKey. One position buffer sized for
// the whole disc (97 cells at R = 5 → ≤ 194 triangles, 7 KB), re-uploaded
// per rebuild; the poll is one pose read and one terrainGroup scan at 2 Hz,
// never per frame. Render layer 1 (RENDER_LAYER_INDOOR — the outdoor pass
// draws it, like route_overlay.js), renderOrder −24 (under the route
// overlay's −20…−18, so a route draws over the tint); raycast is a no-op
// (picking walks entitiesGroup), no shadows, never written to depth.

import { cellSwToNeCut } from "./terrain_oracle.js";

// ── constants ──────────────────────────────────────────────────────────────

/** acclient PhysicsGlobals::floor_z (f32; = cos 48.381°): the walkable limit
 *  on a contact plane's normal z (types.rs FLOOR_Z, ACE PhysicsGlobals). */
export const FLOOR_Z = Math.fround(0.66417414618662751);

/** Metres per terrain cell (one edge of the 8×8 grid of a landblock). */
export const CELL_M = 24;
const CELLS_PER_LB = 8;
const GRID_MAX = 256 * CELLS_PER_LB - 1; // last global cell index (2047)

export const PASSABILITY_DEFAULTS = Object.freeze({
  radiusCells: 5, // the disc drawn around the player's cell (RynthAi: 4)
  rebuildCells: 2, // rebuild once the player is this many cells from the last build
  liftM: 0.12, // above the retail triangles (+ the drawn ground's rounding)
  floorZ: FLOOR_Z,
  color: 0xff2020, // RynthAi FillColor 0x60FF2020
  opacity: 0x60 / 255,
  layer: 1, // RENDER_LAYER_INDOOR (index.js), as route_overlay.js
  renderOrder: -24,
  pollMs: 500, // the page attach's poll while visible
});

/** Corner offsets of a cell, in its own corner order 0 SW · 1 SE · 2 NW · 3 NE. */
const CX = Object.freeze([0, CELL_M, 0, CELL_M]);
const CY = Object.freeze([0, 0, CELL_M, CELL_M]);

/**
 * The two triangles of a cell by its cut, as corner indices (0 SW · 1 SE ·
 * 2 NW · 3 NE), counter-clockwise seen from above: the triangles
 * terrain_oracle.js triangleGradInCell differentiates and RynthAi's
 * GetTrianglePassability names tri1 / tri2.
 *   swNe (SW→NE diagonal): SE half (SW, SE, NE) · NW half (SW, NE, NW)
 *   seNw (SE→NW diagonal): SW half (SW, SE, NW) · NE half (SE, NE, NW)
 */
export const CELL_TRIANGLES = Object.freeze({
  swNe: Object.freeze([Object.freeze([0, 1, 3]), Object.freeze([0, 3, 2])]),
  seNw: Object.freeze([Object.freeze([0, 1, 2]), Object.freeze([1, 3, 2])]),
});

const finiteOr = (v, d) => {
  const n = Number(v);
  return v === null || v === "" || !Number.isFinite(n) ? d : n;
};
const clampNum = (v, lo, hi, d) => Math.min(hi, Math.max(lo, finiteOr(v, d)));

/** Defaults + overrides, clamped. Unknown keys pass through. */
export function resolvePassabilityOptions(opts = {}) {
  const src = opts && typeof opts === "object" ? opts : {};
  const D = PASSABILITY_DEFAULTS;
  const o = { ...D, ...src };
  o.radiusCells = Math.round(clampNum(o.radiusCells, 1, 16, D.radiusCells));
  o.rebuildCells = Math.round(clampNum(o.rebuildCells, 1, o.radiusCells, D.rebuildCells));
  o.liftM = clampNum(o.liftM, 0, 5, D.liftM);
  o.floorZ = clampNum(o.floorZ, 0.05, 0.999, D.floorZ);
  o.color = Math.round(clampNum(o.color, 0, 0xffffff, D.color));
  o.opacity = clampNum(o.opacity, 0, 1, D.opacity);
  o.layer = Math.round(clampNum(o.layer, 0, 31, D.layer));
  o.renderOrder = finiteOr(o.renderOrder, D.renderOrder);
  o.pollMs = clampNum(o.pollMs, 100, 60_000, D.pollMs);
  return o;
}

// ── pure geometry ──────────────────────────────────────────────────────────

/**
 * The unit normal's z of a planar terrain triangle whose height changes by
 * `dzEast` metres across one cell eastward and `dzNorth` northward (the
 * cell-fraction gradient terrain_oracle.js triangleGradInCell returns).
 */
export function triangleNormalZ(dzEast, dzNorth) {
  const sx = dzEast / CELL_M;
  const sy = dzNorth / CELL_M;
  return 1 / Math.sqrt(1 + sx * sx + sy * sy);
}

/**
 * Which triangles of a cell are too steep to walk up. Corners h00 SW, h10 SE,
 * h01 NW, h11 NE (metres); `swNeCut` from cellSwToNeCut. → bit 0 = the first
 * triangle of CELL_TRIANGLES[cut] is steep, bit 1 = the second.
 */
export function cellSteepMask(h00, h10, h01, h11, swNeCut, floorZ = FLOOR_Z) {
  let a;
  let b;
  if (swNeCut) {
    a = triangleNormalZ(h10 - h00, h11 - h10); // SE half: SW, SE, NE
    b = triangleNormalZ(h11 - h01, h01 - h00); // NW half: SW, NE, NW
  } else {
    a = triangleNormalZ(h10 - h00, h01 - h00); // SW half: SW, SE, NW
    b = triangleNormalZ(h11 - h01, h11 - h10); // NE half: SE, NE, NW
  }
  // NaN (a hole in the heights) is never steep.
  return (a < floorZ ? 1 : 0) | (b < floorZ ? 2 : 0);
}

const discCache = new Map();
/** The cells drawn around the centre cell: offsets (dx, dy) with
 *  dx² + dy² ≤ R(R+1), interleaved in an Int16Array. Memoised per R. */
export function discOffsets(radiusCells) {
  const R = Math.max(0, Math.round(finiteOr(radiusCells, PASSABILITY_DEFAULTS.radiusCells)));
  const hit = discCache.get(R);
  if (hit) return hit;
  const out = [];
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) if (dx * dx + dy * dy <= R * (R + 1)) out.push(dx, dy);
  }
  const arr = Int16Array.from(out);
  discCache.set(R, arr);
  return arr;
}

/** Most vertices a build can write for a radius (two triangles per cell). */
export function maxPassabilityVertices(radiusCells) {
  return (discOffsets(radiusCells).length / 2) * 6;
}

/** A landblock record's 81 heights (a bare array-like or {heights}), or null. */
function heightsOf(lb) {
  if (!lb) return null;
  const h = Array.isArray(lb) || ArrayBuffer.isView(lb) ? lb : lb.heights;
  return h && typeof h.length === "number" && h.length >= 81 ? h : null;
}

const scratchH = new Float64Array(4);

/**
 * The steep triangles around AC world (x, y) — pure, no THREE.
 *
 * @param {(lbX:number, lbY:number) => (ArrayLike<number>|{heights:ArrayLike<number>, roundMaxAbsM?:number}|null)} getLandblock
 *        a landblock's 81 retail heights (idx = vx·9 + vy), or null when not loaded
 * @param {number} x AC world metres, east
 * @param {number} y AC world metres, north
 * @param {object} [options] resolvePassabilityOptions input (or its output)
 * @param {Float32Array|null} [target] buffer to write into (used when large
 *        enough: maxPassabilityVertices(radiusCells) · 3 floats)
 * @returns {{ cx:number, cy:number, origin:{x:number,y:number,z:number},
 *   positions:Float32Array, vertexCount:number, steep:number, cells:number,
 *   missing:number, liftM:number, lbs:Map<number, ArrayLike<number>|null> }}
 *   `cx`/`cy` the centre cell (global, 0..2047); positions relative to
 *   `origin` (its SW corner, z 0); `lbs` every landblock the disc touches
 *   ((lbX << 8) | lbY → its heights or null) — what a rebuild depends on.
 */
export function buildPassabilityGeometry(getLandblock, x, y, options, target = null) {
  const o = options && options.__resolved ? options : resolvePassabilityOptions(options);
  const out = {
    cx: 0,
    cy: 0,
    origin: { x: 0, y: 0, z: 0 },
    positions: null,
    vertexCount: 0,
    steep: 0,
    cells: 0,
    missing: 0,
    liftM: o.liftM,
    lbs: new Map(),
  };
  const R = o.radiusCells;
  const cap = maxPassabilityVertices(R) * 3;
  const buf = target instanceof Float32Array && target.length >= cap ? target : new Float32Array(cap);
  out.positions = buf.subarray(0, 0);
  if (!Number.isFinite(x) || !Number.isFinite(y) || typeof getLandblock !== "function") return out;
  const cx = Math.floor(x / CELL_M);
  const cy = Math.floor(y / CELL_M);
  out.cx = cx;
  out.cy = cy;
  out.origin.x = cx * CELL_M;
  out.origin.y = cy * CELL_M;

  // 1) every landblock the disc touches, and the lift over the drawn ground.
  let round = 0;
  const lb0x = Math.max(0, Math.floor((cx - R) / CELLS_PER_LB));
  const lb1x = Math.min(255, Math.floor((cx + R) / CELLS_PER_LB));
  const lb0y = Math.max(0, Math.floor((cy - R) / CELLS_PER_LB));
  const lb1y = Math.min(255, Math.floor((cy + R) / CELLS_PER_LB));
  for (let lx = lb0x; lx <= lb1x; lx++) {
    for (let ly = lb0y; ly <= lb1y; ly++) {
      let rec = null;
      try {
        rec = getLandblock(lx, ly);
      } catch (_) {
        rec = null;
      }
      const h = heightsOf(rec);
      out.lbs.set((lx << 8) | ly, h);
      const r = h && rec && !ArrayBuffer.isView(rec) && !Array.isArray(rec) ? Math.abs(Number(rec.roundMaxAbsM)) : 0;
      if (Number.isFinite(r) && r > round) round = r;
    }
  }
  const lift = o.liftM + Math.min(round, 5);
  out.liftM = lift;

  // 2) the disc, cell by cell: the game's cut, the floor_z test, the steep halves.
  const offs = discOffsets(R);
  let n = 0;
  for (let i = 0; i < offs.length; i += 2) {
    const gx = cx + offs[i];
    const gy = cy + offs[i + 1];
    if (gx < 0 || gy < 0 || gx > GRID_MAX || gy > GRID_MAX) continue;
    out.cells += 1;
    const h = out.lbs.get(((gx >> 3) << 8) | (gy >> 3));
    if (!h) {
      out.missing += 1;
      continue;
    }
    const vx = gx & 7;
    const vy = gy & 7;
    scratchH[0] = h[vx * 9 + vy];
    scratchH[1] = h[(vx + 1) * 9 + vy];
    scratchH[2] = h[vx * 9 + vy + 1];
    scratchH[3] = h[(vx + 1) * 9 + vy + 1];
    const cut = cellSwToNeCut(gx, gy);
    const mask = cellSteepMask(scratchH[0], scratchH[1], scratchH[2], scratchH[3], cut, o.floorZ);
    if (!mask) continue;
    const ox = offs[i] * CELL_M;
    const oy = offs[i + 1] * CELL_M;
    const tris = cut ? CELL_TRIANGLES.swNe : CELL_TRIANGLES.seNw;
    for (let t = 0; t < 2; t++) {
      if (!(mask & (1 << t))) continue;
      for (const c of tris[t]) {
        buf[n++] = ox + CX[c];
        buf[n++] = oy + CY[c];
        buf[n++] = scratchH[c] + lift;
      }
      out.steep += 1;
    }
  }
  out.vertexCount = n / 3;
  out.positions = buf.subarray(0, n);
  return out;
}

// ── page reads ─────────────────────────────────────────────────────────────

/**
 * The heights of the landblocks lbX0..lbX1 × lbY0..lbY1 present in the
 * scene's terrain group (one scan): `out` is cleared, then (lbX << 8) | lbY →
 * { heights, roundMaxAbsM }. Children without heights (wire-mode fill
 * meshes) are skipped.
 */
export function collectTerrainHeights(terrainGroup, lbX0, lbX1, lbY0, lbY1, out = new Map()) {
  out.clear();
  const kids = terrainGroup && Array.isArray(terrainGroup.children) ? terrainGroup.children : null;
  if (!kids) return out;
  for (let i = 0; i < kids.length; i++) {
    const ud = kids[i] && kids[i].userData;
    if (!ud || typeof ud.lbX !== "number" || typeof ud.lbY !== "number") continue;
    if (ud.lbX < lbX0 || ud.lbX > lbX1 || ud.lbY < lbY0 || ud.lbY > lbY1) continue;
    if (!heightsOf(ud.heights)) continue;
    const key = ((ud.lbX & 0xff) << 8) | (ud.lbY & 0xff);
    if (!out.has(key)) out.set(key, { heights: ud.heights, roundMaxAbsM: ud.roundMaxAbsM });
  }
  return out;
}

/**
 * The local player's position (AC world metres) and whether they stand in an
 * outdoor cell, from the session pose (getLocalPlayerPose: landblock-local
 * x / y + the cell id; the wasm box is copied, then freed). Fills `out`
 * { valid, outdoor, x, y, cell } → valid. Never throws.
 */
export function readPlayerCell(win, out) {
  out.valid = false;
  out.outdoor = false;
  try {
    const h = (win && (win.__sessionHandle || (win.liveScene3d && win.liveScene3d.sessionHandle))) || null;
    if (!h || typeof h.getLocalPlayerPose !== "function") return false;
    let box = null;
    try {
      box = h.getLocalPlayerPose();
    } catch (_) {
      box = null;
    }
    if (!box) return false;
    let cell = 0;
    let x = NaN;
    let y = NaN;
    try {
      cell = Number(box.landblockId) >>> 0;
      x = Number(box.x);
      y = Number(box.y);
    } finally {
      try {
        if (typeof box.free === "function") box.free();
      } catch (_) {
        /* already released */
      }
    }
    if (!(cell >>> 16) || !Number.isFinite(x) || !Number.isFinite(y)) return false; // landblock 0: portal space
    out.valid = true;
    out.outdoor = (cell & 0xffff) < 0x0100; // 0x0100+ are EnvCells (buildings, dungeons)
    out.x = ((cell >>> 24) & 0xff) * 192 + x;
    out.y = ((cell >>> 16) & 0xff) * 192 + y;
    out.cell = cell;
    return true;
  } catch (_) {
    return false;
  }
}

// ── THREE layer ────────────────────────────────────────────────────────────

const noRaycast = () => {};

/**
 * The overlay. See the module header.
 *
 * @param {object} args
 * @param {object} args.THREE   the three module (required)
 * @param {object} [args.parent] Object3D in the AC frame — scene3d's
 *        entitiesGroup. Attached to only by setVisible(true).
 * @param {object} [args.opts]  PASSABILITY_DEFAULTS overrides
 * @returns {{ update(x:number, y:number, getLandblock:Function, o?:{force?:boolean}):boolean,
 *   setVisible(v:boolean):void, setOptions(partial:object):void, dispose():void, stats():object,
 *   readonly visible:boolean, readonly root:object|null, readonly options:object, readonly objects:object|null }}
 */
export function createPassabilityOverlay({ THREE, parent = null, opts = {} } = {}) {
  if (!THREE || typeof THREE.BufferGeometry !== "function") throw new TypeError("createPassabilityOverlay: THREE is required");
  const host = parent || null;
  let o = resolvePassabilityOptions(opts);
  o.__resolved = true;
  let objs = null;
  let built = null; // { cx, cy, lbs } of the geometry on the GPU
  let visible = false;
  let disposed = false;
  const stats = { rebuilds: 0, updates: 0, steep: 0, cells: 0, missing: 0, vertices: 0, liftM: 0 };

  function makeBuffers(O) {
    const capacity = maxPassabilityVertices(o.radiusCells);
    const attr = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    if (typeof attr.setUsage === "function" && THREE.DynamicDrawUsage !== undefined) attr.setUsage(THREE.DynamicDrawUsage);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", attr);
    geom.setDrawRange(0, 0);
    if (O.geom) {
      try {
        O.geom.dispose();
      } catch (_) {
        /* released */
      }
    }
    O.geom = geom;
    O.attr = attr;
    O.capacity = capacity;
    O.mesh.geometry = geom;
  }

  function ensureObjects() {
    if (objs) return objs;
    const mat = new THREE.MeshBasicMaterial({
      color: o.color,
      transparent: true,
      opacity: o.opacity,
      depthTest: true,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    mat.name = "rynth-passability";
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    mesh.name = "rynth-passability";
    mesh.renderOrder = o.renderOrder;
    mesh.layers.set(o.layer);
    mesh.raycast = noRaycast;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    // The disc moves with the player and is rebuilt in place: never culled
    // against a stale bounding sphere (it is around the camera's target anyway).
    mesh.frustumCulled = false;
    mesh.visible = false;
    const group = new THREE.Group();
    group.name = "rynth-passability-overlay";
    group.userData.rynthPassabilityOverlay = true;
    group.matrixAutoUpdate = false;
    group.add(mesh);
    const placeholder = mesh.geometry;
    objs = { group, mesh, mat, geom: placeholder, attr: null, capacity: 0 };
    makeBuffers(objs);
    return objs;
  }

  function rebuild(x, y, getLandblock) {
    const O = ensureObjects();
    if (O.capacity < maxPassabilityVertices(o.radiusCells)) makeBuffers(O);
    const res = buildPassabilityGeometry(getLandblock, x, y, o, O.attr.array);
    if (res.positions.buffer !== O.attr.array.buffer) {
      // (cannot happen while capacity matches the radius; keep the GPU side right anyway)
      makeBuffers(O);
      O.attr.array.set(res.positions);
    }
    O.attr.needsUpdate = true;
    O.geom.setDrawRange(0, res.vertexCount);
    O.mesh.visible = res.vertexCount > 0;
    O.group.position.set(res.origin.x, res.origin.y, 0);
    O.group.updateMatrix();
    built = { cx: res.cx, cy: res.cy, lbs: res.lbs };
    stats.rebuilds += 1;
    stats.steep = res.steep;
    stats.cells = res.cells;
    stats.missing = res.missing;
    stats.vertices = res.vertexCount;
    stats.liftM = res.liftM;
  }

  const api = {
    /**
     * The player stands at AC world (x, y): rebuild when the centre cell is
     * `rebuildCells` away from the last build, or a landblock in reach got,
     * lost or changed its heights (`getLandblock` as buildPassabilityGeometry).
     * → true when it rebuilt.
     */
    update(x, y, getLandblock, { force = false } = {}) {
      if (disposed || !Number.isFinite(x) || !Number.isFinite(y) || typeof getLandblock !== "function") return false;
      stats.updates += 1;
      const cx = Math.floor(x / CELL_M);
      const cy = Math.floor(y / CELL_M);
      let need = force || !built || Math.abs(cx - built.cx) >= o.rebuildCells || Math.abs(cy - built.cy) >= o.rebuildCells;
      if (!need) {
        for (const [key, ref] of built.lbs) {
          let rec = null;
          try {
            rec = getLandblock(key >> 8, key & 0xff);
          } catch (_) {
            rec = null;
          }
          if (heightsOf(rec) !== ref) {
            need = true;
            break;
          }
        }
      }
      if (!need) return false;
      rebuild(x, y, getLandblock);
      return true;
    },
    /** First true builds the objects and attaches; false detaches (buffers kept). */
    setVisible(v) {
      if (disposed) return;
      const want = !!v;
      if (want === visible) return;
      visible = want;
      if (want) {
        if (!host || typeof host.add !== "function") {
          visible = false;
          return;
        }
        const O = ensureObjects();
        if (O.group.parent !== host) host.add(O.group);
      } else if (objs && objs.group.parent) {
        objs.group.parent.remove(objs.group);
      }
    },
    /** Change options: the look applies at once; radius / rebuild distance /
     *  lift / floor take effect on the next update (a full rebuild). */
    setOptions(partial) {
      if (disposed || !partial || typeof partial !== "object") return;
      const next = resolvePassabilityOptions({ ...o, __resolved: undefined, ...partial });
      next.__resolved = true;
      const geomChanged = ["radiusCells", "liftM", "floorZ"].some((k) => next[k] !== o[k]);
      o = next;
      if (geomChanged) built = null;
      if (!objs) return;
      objs.mat.color.setHex(o.color);
      objs.mat.opacity = o.opacity;
      objs.mesh.renderOrder = o.renderOrder;
      objs.mesh.layers.set(o.layer);
    },
    /** Release the geometry and the material; detach. Idempotent. */
    dispose() {
      if (disposed) return;
      disposed = true;
      visible = false;
      if (objs) {
        if (objs.group.parent) objs.group.parent.remove(objs.group);
        for (const r of [objs.geom, objs.mat]) {
          try {
            r.dispose();
          } catch (_) {
            /* released */
          }
        }
      }
      objs = null;
      built = null;
    },
    stats() {
      return {
        visible,
        built: !!objs,
        disposed,
        center: built ? { cx: built.cx, cy: built.cy } : null,
        drawCalls: visible && objs && objs.mesh.visible ? 1 : 0,
        ...stats,
      };
    },
    get visible() {
      return visible;
    },
    get root() {
      return objs ? objs.group : null;
    },
    get options() {
      return { ...o };
    },
    /** Test / diag access to the built objects (null before the first show). */
    get objects() {
      return objs;
    },
  };
  return api;
}

// ── page attach ────────────────────────────────────────────────────────────

/**
 * Attach the overlay to the live scene and publish
 * window.__rynthPassabilityOverlay. Idempotent (a second call returns the
 * installed handle, applying `cfg.opts`). Allocates no THREE object and
 * starts no timer until setVisible(true).
 *
 * @param {object} win  the page window (tests: a plain object)
 * @param {object} [cfg]
 * @param {object} [cfg.opts]   createPassabilityOverlay options (+ pollMs)
 * @param {object} [cfg.THREE]  the three module (else import("three") on show)
 * @param {Function} [cfg.importThree] () → Promise<THREE> (tests)
 * @param {{setInterval:Function, clearInterval:Function}} [cfg.timers] (tests)
 * @returns {object|null} the handle
 */
export function installPassabilityOverlay(win, cfg = {}) {
  const w = win || (typeof window !== "undefined" ? window : null);
  if (!w) return null;
  const c = cfg && typeof cfg === "object" ? cfg : {};
  let prev = null;
  try {
    prev = w.__rynthPassabilityOverlay;
  } catch (_) {
    prev = null;
  }
  if (prev && prev.__passabilityOverlay === true && !prev.disposed) {
    if (c.opts) prev.setOptions(c.opts);
    return prev;
  }
  const timers = c.timers || {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h),
  };
  const importThree = typeof c.importThree === "function" ? c.importThree : () => import("three");
  let THREE = c.THREE || null;
  let threeLoading = null;
  let threeError = null;
  let opts = { ...(c.opts || {}) };
  let pollMs = resolvePassabilityOptions(opts).pollMs;
  let visible = false;
  let timer = null;
  let overlay = null;
  let boundParent = null;
  let boundScene = null;
  let disposed = false;
  let attaches = 0;
  let lastError = null;
  let state = "hidden";
  const pose = { valid: false, outdoor: false, x: 0, y: 0, cell: 0 };
  const lbs = new Map();
  const lookup = (lx, ly) => lbs.get(((lx & 0xff) << 8) | (ly & 0xff)) || null;

  const drop = () => {
    if (overlay) {
      try {
        overlay.dispose();
      } catch (_) {
        /* released */
      }
    }
    overlay = null;
    boundParent = null;
    boundScene = null;
  };
  const loadThree = () => {
    if (THREE || threeLoading || threeError) return;
    threeLoading = Promise.resolve()
      .then(importThree)
      .then((m) => {
        THREE = m && m.BufferGeometry ? m : m && m.default ? m.default : m;
        threeLoading = null;
        poll();
      })
      .catch((e) => {
        threeLoading = null;
        threeError = String((e && e.message) || e);
      });
  };
  const inPortalSpace = () => {
    try {
      return typeof w.__isPortalSpaceActive === "function" && w.__isPortalSpaceActive() === true;
    } catch (_) {
      return false;
    }
  };
  function tick() {
    if (!visible || disposed) return;
    const ls = w.liveScene3d || null;
    const parent = (ls && ls.entitiesGroup) || null;
    // A new scene (or none): the old overlay belongs to a dead graph.
    if (overlay && (parent !== boundParent || ls !== boundScene)) drop();
    if (!parent || typeof parent.add !== "function") {
      state = "no-scene";
      return;
    }
    if (!overlay) {
      if (!THREE) {
        state = "loading";
        loadThree();
        return;
      }
      overlay = createPassabilityOverlay({ THREE, parent, opts });
      boundParent = parent;
      boundScene = ls;
      attaches += 1;
    }
    // Outdoors only: no tint in a building or a dungeon, none in the tunnel.
    if (!readPlayerCell(w, pose) || !pose.outdoor || inPortalSpace()) {
      overlay.setVisible(false);
      state = !pose.valid ? "no-pose" : !pose.outdoor ? "indoors" : "portal";
      return;
    }
    const o = overlay.options;
    const reach = o.radiusCells + o.rebuildCells; // the last build's disc is inside it
    const gx = Math.floor(pose.x / CELL_M);
    const gy = Math.floor(pose.y / CELL_M);
    collectTerrainHeights(
      ls.terrainGroup,
      Math.floor((gx - reach) / CELLS_PER_LB),
      Math.floor((gx + reach) / CELLS_PER_LB),
      Math.floor((gy - reach) / CELLS_PER_LB),
      Math.floor((gy + reach) / CELLS_PER_LB),
      lbs,
    );
    overlay.update(pose.x, pose.y, lookup);
    overlay.setVisible(true);
    state = "shown";
  }
  function poll() {
    try {
      tick();
    } catch (e) {
      lastError = String((e && e.message) || e);
    }
  }

  const handle = {
    __passabilityOverlay: true,
    get disposed() {
      return disposed;
    },
    get visible() {
      return visible;
    },
    /** Show / hide. Hidden = detached from the scene, no timer. → visible. */
    setVisible(v) {
      if (disposed) return false;
      const want = !!v;
      if (want === visible) return visible;
      visible = want;
      if (want) {
        if (timer === null) timer = timers.setInterval(poll, pollMs);
        poll();
      } else {
        if (timer !== null) timers.clearInterval(timer);
        timer = null;
        state = "hidden";
        if (overlay) overlay.setVisible(false);
      }
      return visible;
    },
    /** createPassabilityOverlay options (+ pollMs, applied on the next show). */
    setOptions(partial) {
      if (disposed || !partial || typeof partial !== "object") return;
      opts = { ...opts, ...partial };
      pollMs = resolvePassabilityOptions(opts).pollMs;
      if (overlay) overlay.setOptions(partial);
      if (visible) poll();
    },
    /** One poll now (scene check + player + heights). */
    refresh() {
      poll();
    },
    status() {
      const ls = w.liveScene3d || null;
      return {
        visible,
        disposed,
        state,
        sceneReady: !!(ls && ls.entitiesGroup),
        threeLoaded: !!THREE,
        threeError,
        attached: !!overlay,
        attaches,
        polling: timer !== null,
        lastError,
        overlay: overlay ? overlay.stats() : null,
      };
    },
    /** The live overlay (tests / diag); null until attached. */
    get overlay() {
      return overlay;
    },
    dispose() {
      if (disposed) return;
      if (timer !== null) timers.clearInterval(timer);
      timer = null;
      drop();
      lbs.clear();
      visible = false;
      disposed = true;
      try {
        if (w.__rynthPassabilityOverlay === handle) delete w.__rynthPassabilityOverlay;
      } catch (_) {
        w.__rynthPassabilityOverlay = undefined;
      }
    },
  };
  w.__rynthPassabilityOverlay = handle;
  return handle;
}

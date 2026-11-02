// scene3d/lb_presence.js — the per-landblock PRESENCE FIELD (`?lbFade`, flight experience Phase 1).
//
// PROBLEM. Every way a landblock's content appears or disappears was a hard toggle:
//   * objects (statics = trees and all procedural scenery, buildings) pop on at the ?objRadius window edge,
//     pop off at N+1, pop on when a late bake lands inside the window, pop off when a tile parks;
//   * the far composite ring discards a SQUARE around the player landblock, so a near landblock that is not
//     drawn yet inside that square (the leading edge at speed, a parked tile) is a HOLE — neither ring draws it.
// At 300-400 km/h the object window slides one landblock every ~1.7 s, so the owner saw "trees flash in and
// out" and "landblocks flicker or arrive late" (docs/flight-experience-2026-11-01/WORKFLOW.md).
//
// WHAT THIS IS. One small texture, 64 × 64 landblocks around the aircraft / player (12.3 km), two channels:
//   R  object presence 0..1   — statics / buildings / scenery of that landblock (the dither FADE value)
//   G  near-terrain presence  — 1 while the near ring really draws the landblock's ground
// driven every frame from the authoritative state (baked sets, parks, the object window) with a time-based
// approach to its target (fade in ~0.7 s, out ~0.5 s). Consumers:
//   * the far ring's shader discards per landblock where G says the near ring draws — never a square, so a
//     missing near landblock is always backed by far terrain (no holes by construction); the world tier does
//     the same. Both go through LB_HANDOFF_GLSL below (`?lbBand`): a 10 m hand-off band stays drawn under a
//     near landblock only along the edges where the near ring ENDS;
//   * every object material carrying the HB_LB_FADE define reads R at its OBJECT ORIGIN's landblock in the
//     vertex shader (one value per object, so an object straddling a landblock edge fades as one) and discards
//     fragments with a 4×4 ordered dither below it — a screen-door crossfade, opaque pass, real depth;
//   * object_radius.js defers its hide until the fade-out has finished (`objRadiusFadeHooks`).
//
// RULES IT KEEPS
//   * vfx-write-invariant: no light count change, no per-instance program key — the define is per material
//     FACTORY (every atlas / pool / statics / buildings / anim-scenery material gets the same one), the GLSL
//     lives in three's shared chunks behind `#ifdef HB_LB_FADE`, and the uniforms are ONE shared object.
//   * Off (`?lbFade=off`): no chunk is touched, no define is set, no uniform added — byte-identical programs.
//   * Landblocks outside the window read presence 1 (drawn as before); the window recentres with hysteresis.
//
// AC ↔ three: objects live under worldRoot (rotation.x = −π/2, no translation, scene3d/index.js), so an AC
// position (x, y, z) is three world (x, z, −y): AC x = world.x, AC y = −world.z.

import { flightViewFlag } from "./flight_view_flag.js";

export const WIN = 64;                 // landblocks per side of the presence window
const RECENTRE_SLACK = 12;             // recentre when the centre drifts this far from the window centre
export const CH_OBJ = 0;
export const CH_TER = 1;
export const FADE_IN_MS = 700;
export const FADE_OUT_MS = 500;

/**
 * `?objFade` — the OBJECT half (DEV opt-in, default OFF): the dither fade on object materials + the deferred
 * object-window hide. Kept apart from `?lbFade` because object materials are SHARED: the material cache serves
 * entities and statics alike, and the draw-pool class materials serve interior EnvCell geometry too (a dungeon
 * landblock has no outdoor objects, so its presence would read 0 and fade the dungeon away). Only material
 * objects that draw outdoor landblock objects and nothing else may carry the define (see applyLbFade).
 */
export function objFadeEnabled(search) {
  try {
    const s = search !== undefined ? search : (globalThis.location?.search || "");
    const v = (new URLSearchParams(s).get("objFade") || "").trim().toLowerCase();
    return v === "on" || v === "1" || v === "true" || v === "yes";
  } catch (_) {
    return false;
  }
}
let _objFlag;
export function objFadeOn() {
  if (_objFlag === undefined) _objFlag = objFadeEnabled() && lbFadeOn();
  return _objFlag;
}
export function __setObjFadeForTest(v) { _objFlag = v; }

/** `?lbFade` — DEV opt-in until the 1070 eye test: on/1/true/yes → ON; absent / anything else → OFF. */
export function lbFadeEnabled(search) {
  try {
    const s = search !== undefined ? search : (globalThis.location?.search || "");
    const ps = new URLSearchParams(s);
    const v = (ps.get("lbFade") || "").trim().toLowerCase();
    if (v === "on" || v === "1" || v === "true" || v === "yes") return true;
    if (v === "off" || v === "0" || v === "false" || v === "no") return false;
    // ?flightView (altitude_policy.js, default ON) needs the field: the world tier discards under the inner rings by it
    return flightViewFlag(s);
  } catch (_) {
    return false;
  }
}
let _flag; // cached page read
export function lbFadeOn() {
  if (_flag === undefined) _flag = lbFadeEnabled();
  return _flag;
}
/** Test seam: force the flag (undefined re-reads the URL). */
export function __setLbFadeForTest(v) { _flag = v; }

export function lbKeyXY(x, y) { return (((x & 0xff) << 24) | ((y & 0xff) << 16)) >>> 0; }

/**
 * The presence state machine (renderer-free; unit-tested). Values live per landblock key for the landblocks
 * that have ever been set inside the window; the window only decides what is packed into the texture.
 */
export class LbPresence {
  constructor({ fadeInMs = FADE_IN_MS, fadeOutMs = FADE_OUT_MS, win = WIN } = {}) {
    this.fadeInMs = fadeInMs;
    this.fadeOutMs = fadeOutMs;
    this.win = win;
    this.ox = 0;            // window origin (landblocks)
    this.oy = 0;
    this.cx = -1;           // centre the window was laid out for
    this.cy = -1;
    /** lbKey -> Float32Array(4): [objValue, objTarget, terValue, terTarget] */
    this.cells = new Map();
    // RG, row-major from the origin. Undriven cells (beyond DRIVE_R = 12 LB, i.e. beyond any object window):
    // objects ABSENT (R 0 — the far-forest impostors draw there; lane B's review) and near terrain ABSENT (G 0 —
    // the far ring and the world tier draw wherever the near ring is unknown).
    this.bytes = new Uint8Array(win * win * 2);
    this._fillDefault();
    this.dirty = true;
    this.relayouts = 0;
    this.lastMs = null;
    /** (lbKey, channel) callbacks when a value reaches 0 with target 0 (object_radius commits its hide). */
    this._doneOut = [];
    this._pendingDone = [];
    this.stats = { fadesIn: 0, fadesOut: 0, cancels: 0, commits: 0 };
  }

  /** Move the window so (lbx, lby) is inside it with slack; returns true when the layout changed. */
  setCentre(lbx, lby) {
    const half = this.win >> 1;
    if (this.cx >= 0 && Math.abs(lbx - this.cx) <= RECENTRE_SLACK && Math.abs(lby - this.cy) <= RECENTRE_SLACK) return false;
    this.cx = lbx; this.cy = lby;
    this.ox = Math.max(0, Math.min(256 - this.win, lbx - half));
    this.oy = Math.max(0, Math.min(256 - this.win, lby - half));
    this.relayouts += 1;
    this._relayout();
    return true;
  }

  _fillDefault() {
    this.bytes.fill(0);
  }

  _relayout() {
    this._fillDefault();
    for (const [k, c] of this.cells) this._write(k, c);
    // forget cells far outside the window (they re-enter at their state's target, see `value`)
    const lo = -this.win, hi = 2 * this.win;
    for (const k of [...this.cells.keys()]) {
      const x = ((k >>> 24) & 0xff) - this.ox, y = ((k >>> 16) & 0xff) - this.oy;
      if (x < lo || y < lo || x >= hi || y >= hi) this.cells.delete(k);
    }
    this.dirty = true;
  }

  _index(k) {
    const x = ((k >>> 24) & 0xff) - this.ox, y = ((k >>> 16) & 0xff) - this.oy;
    if (x < 0 || y < 0 || x >= this.win || y >= this.win) return -1;
    return (y * this.win + x) * 2;
  }

  _write(k, c) {
    const i = this._index(k);
    if (i < 0) return;
    const o = Math.round(c[0] * 255), t = Math.round(c[2] * 255);
    if (this.bytes[i] !== o || this.bytes[i + 1] !== t) {
      this.bytes[i] = o; this.bytes[i + 1] = t;
      this.dirty = true;
    }
  }

  _cell(k, initObj, initTer) {
    let c = this.cells.get(k);
    if (!c) {
      c = new Float32Array([initObj, initObj, initTer, initTer]);
      this.cells.set(k, c);
      this._write(k, c);
    }
    return c;
  }

  /**
   * Set a channel's target. `snap` (first sight of a landblock that is already present, e.g. at boot) sets the
   * value too, so the world never fades in around a standing player.
   */
  setTarget(k, ch, target, { snap = false } = {}) {
    const tv = target > 0.5 ? 1 : 0;
    const c = this._cell(k >>> 0, ch === CH_OBJ ? (snap ? tv : 0) : 0, ch === CH_TER ? (snap ? tv : 0) : 0);
    const vi = ch === CH_OBJ ? 0 : 2;
    if (snap) { c[vi] = tv; c[vi + 1] = tv; this._write(k >>> 0, c); return; }
    if (c[vi + 1] !== tv) {
      if (tv === 1) this.stats.fadesIn += 1; else this.stats.fadesOut += 1;
      if (tv === 1 && c[vi] > 0 && c[vi] < 1) this.stats.cancels += 1;
      c[vi + 1] = tv;
    }
  }

  value(k, ch) {
    const c = this.cells.get(k >>> 0);
    if (!c) return null;
    return ch === CH_OBJ ? c[0] : c[2];
  }
  target(k, ch) {
    const c = this.cells.get(k >>> 0);
    if (!c) return null;
    return ch === CH_OBJ ? c[1] : c[3];
  }
  /** A fade is in flight for the landblock (either channel). */
  fading(k) {
    const c = this.cells.get(k >>> 0);
    return !!c && (c[0] !== c[1] || c[2] !== c[3]);
  }

  /** Advance every fade; returns the number of landblocks whose value moved. */
  tick(nowMs) {
    const dt = this.lastMs == null ? 0 : Math.max(0, Math.min(250, nowMs - this.lastMs));
    this.lastMs = nowMs;
    if (dt === 0) return 0;
    const upIn = dt / this.fadeInMs, upOut = dt / this.fadeOutMs;
    let moved = 0;
    for (const [k, c] of this.cells) {
      let ch = false;
      for (let vi = 0; vi <= 2; vi += 2) {
        const v = c[vi], t = c[vi + 1];
        if (v === t) continue;
        let n;
        if (t > v) n = Math.min(t, v + upIn);
        else {
          // terrain presence drops instantly (the far ring must take over the same frame the near ring is gone)
          n = vi === 2 ? t : Math.max(t, v - upOut);
          if (n === 0) this._pendingDone.push([k, vi === 0 ? CH_OBJ : CH_TER]);
        }
        c[vi] = n;
        ch = true;
      }
      if (ch) { moved += 1; this._write(k, c); }
    }
    if (this._pendingDone.length) {
      const done = this._pendingDone;
      this._pendingDone = [];
      for (const [k, chn] of done) {
        for (const cb of this._doneOut) { try { cb(k, chn); } catch (_) { /* consumer bug never stops the fades */ } }
        if (chn === CH_OBJ) this.stats.commits += 1;
      }
    }
    return moved;
  }

  onFadeOutDone(cb) { if (typeof cb === "function") this._doneOut.push(cb); }
}

// ---------------------------------------------------------------------------
// GLSL — three's shared chunks, behind #ifdef HB_LB_FADE (patched once, before the first compile)
// ---------------------------------------------------------------------------
export const LB_FADE_DEFINE = "HB_LB_FADE";
const MARK = "/* hb-lb-fade */";

/** Declarations, appended to `common` (both stages). Plain text, no backticks (the chunks are JS strings). */
export const LB_FADE_COMMON_GLSL = `
${MARK}
#ifdef HB_LB_FADE
uniform highp sampler2D hbLbPresence;  // RG8, 64x64 landblocks; R = object presence, G = near-terrain presence
uniform vec2 hbLbPresenceOrigin;       // window origin in landblocks (AC lbX, lbY)
uniform float hbLbFadeOn;              // 1 when the shared uniforms reached this program (0 = inert, never discard)
flat varying float vHbLbFade;          // the object's presence, from its ORIGIN landblock
#endif
`;

/** After `project_vertex`: the object's origin in AC metres → its landblock → presence. */
export const LB_FADE_VERTEX_GLSL = `
${MARK}
#ifdef HB_LB_FADE
{
  vec4 hbO = vec4(0.0, 0.0, 0.0, 1.0);
  #ifdef USE_BATCHING
    hbO = batchingMatrix * hbO;
  #endif
  #ifdef USE_INSTANCING
    hbO = instanceMatrix * hbO;
  #endif
  hbO = modelMatrix * hbO;
  ivec2 hbLb = ivec2(floor(vec2(hbO.x, -hbO.z) / 192.0)) - ivec2(hbLbPresenceOrigin);
  if (hbLb.x < 0 || hbLb.y < 0 || hbLb.x >= 64 || hbLb.y >= 64) {
    // merged geometry (object transforms baked into the vertices, origin at the world origin): this vertex's landblock
    vec4 hbV = vec4(transformed, 1.0);
    #ifdef USE_BATCHING
      hbV = batchingMatrix * hbV;
    #endif
    #ifdef USE_INSTANCING
      hbV = instanceMatrix * hbV;
    #endif
    hbV = modelMatrix * hbV;
    hbLb = ivec2(floor(vec2(hbV.x, -hbV.z) / 192.0)) - ivec2(hbLbPresenceOrigin);
  }
  vHbLbFade = 1.0;
  if (hbLbFadeOn > 0.5 && hbLb.x >= 0 && hbLb.y >= 0 && hbLb.x < 64 && hbLb.y < 64) {
    vHbLbFade = texelFetch(hbLbPresence, hbLb, 0).r;
  }
}
#endif
`;

/** Top of `clipping_planes_fragment`: the screen-door crossfade (4x4 ordered dither). */
export const LB_FADE_FRAGMENT_GLSL = `
${MARK}
#ifdef HB_LB_FADE
  if (vHbLbFade < 0.999) {
    const float hbBayer[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
    ivec2 hbP = ivec2(gl_FragCoord.xy) & 3;
    if ((hbBayer[hbP.y * 4 + hbP.x] + 0.5) / 16.0 >= vHbLbFade) discard;
  }
#endif
`;

/** Pure: patch three's chunk strings (idempotent). Throws on a missing anchor (fail closed). */
export function patchLbFadeChunks(chunks) {
  const out = {};
  for (const name of ["common", "project_vertex", "clipping_planes_fragment"]) {
    if (typeof chunks[name] !== "string") throw new Error(`lbFade: ShaderChunk.${name} missing`);
  }
  out.common = chunks.common.includes(MARK) ? chunks.common : chunks.common + LB_FADE_COMMON_GLSL;
  out.project_vertex = chunks.project_vertex.includes(MARK) ? chunks.project_vertex : chunks.project_vertex + LB_FADE_VERTEX_GLSL;
  out.clipping_planes_fragment = chunks.clipping_planes_fragment.includes(MARK)
    ? chunks.clipping_planes_fragment
    : LB_FADE_FRAGMENT_GLSL + chunks.clipping_planes_fragment;
  return out;
}

export const lbFadeState = { installed: false, reason: null, materials: 0 };

/** Patch THREE.ShaderChunk once, before the WebGLRenderer compiles anything (index.js preInit3D). */
export function installLbFadeChunks(THREE) {
  if (!objFadeOn()) { lbFadeState.reason = "objFade off"; return false; }
  try {
    const p = patchLbFadeChunks(THREE.ShaderChunk);
    THREE.ShaderChunk.common = p.common;
    THREE.ShaderChunk.project_vertex = p.project_vertex;
    THREE.ShaderChunk.clipping_planes_fragment = p.clipping_planes_fragment;
    lbFadeState.installed = true;
    lbFadeState.reason = null;
    return true;
  } catch (e) {
    lbFadeState.reason = String(e?.message ?? e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// The shared uniforms + texture (created lazily against the page's THREE)
// ---------------------------------------------------------------------------
let _THREE = null;
let _presence = null;
let _uniforms = null;
let _tex = null;

export function getLbPresence() {
  if (!_presence) _presence = new LbPresence();
  return _presence;
}

/** The ONE uniform object every faded material shares (by reference). */
export function lbFadeUniforms(THREE) {
  if (_uniforms) return _uniforms;
  _THREE = THREE || _THREE;
  if (!_THREE) return null;
  const p = getLbPresence();
  _tex = new _THREE.DataTexture(p.bytes, p.win, p.win, _THREE.RGFormat, _THREE.UnsignedByteType);
  _tex.minFilter = _THREE.NearestFilter;
  _tex.magFilter = _THREE.NearestFilter;
  _tex.generateMipmaps = false;
  _tex.flipY = false;
  _tex.unpackAlignment = 1;
  _tex.needsUpdate = true;
  _tex.name = "hbLbPresence";
  _uniforms = {
    hbLbPresence: { value: _tex },
    hbLbPresenceOrigin: { value: new _THREE.Vector2(p.ox, p.oy) },
    hbLbFadeOn: { value: 1.0 },
  };
  return _uniforms;
}

const _faded = new WeakSet();

/**
 * Give an OBJECT material the fade (no-op unless `?objFade` and `?lbFade` are on and the chunks installed).
 * Idempotent per material object. ONLY for material objects that draw outdoor landblock objects and nothing
 * else (see objFadeEnabled): never the shared material-cache instances, never the draw-pool class materials.
 *
 * The hook is CHAINED as a plain data property (the batched-variant mirror copies own properties by reference
 * and relies on the member's hidden class, so no accessor). Programs are keyed by the define (three puts
 * `material.defines` in the program cache key). A program that compiles the define without the uniforms (a
 * later code path replacing the hook outright) reads `hbLbFadeOn` = 0 and never discards.
 */
export function applyLbFade(material, THREE) {
  if (!material || !objFadeOn() || !lbFadeState.installed) return material;
  if (_faded.has(material)) return material;
  const u = lbFadeUniforms(THREE);
  if (!u) return material;
  material.defines = { ...(material.defines || {}), [LB_FADE_DEFINE]: "" };
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = function hbLbFadeOnBeforeCompile(shader, renderer) {
    if (typeof prev === "function") prev.call(this, shader, renderer);
    shader.uniforms.hbLbPresence = u.hbLbPresence;
    shader.uniforms.hbLbPresenceOrigin = u.hbLbPresenceOrigin;
    shader.uniforms.hbLbFadeOn = u.hbLbFadeOn;
  };
  _faded.add(material);
  material.needsUpdate = true;
  lbFadeState.materials += 1;
  return material;
}

/** Push the CPU field to the GPU (once per frame, only when something changed). */
export function flushLbPresence() {
  const p = _presence;
  if (!p || !_uniforms) return false;
  _uniforms.hbLbPresenceOrigin.value.set(p.ox, p.oy);
  if (!p.dirty) return false;
  p.dirty = false;
  _tex.needsUpdate = true;
  return true;
}

// ---------------------------------------------------------------------------
// "Objects attached" — the moment a landblock's nodes exist (index.js loader wrappers)
// ---------------------------------------------------------------------------
// `staticsBakedLbs` / `buildingsBakedLbs` are set when a bake STARTS its fetch (statics.js marks before the
// geometry fetch and the attach), so a fade keyed on them would run while nothing is drawn and the objects
// would then pop in at full presence. The loader wrappers stamp the attach time per kind instead.
export const ATTACH_WAIT_MS = 2000;

/** index.js: a statics ("s") or buildings ("b") bake just attached its nodes for `lbKey`. */
export function noteObjectsAttached(scene3d, lbKey, kind) {
  if (!scene3d) return;
  const m = scene3d._objAttach || (scene3d._objAttach = new Map());
  const k = lbKey >>> 0;
  let r = m.get(k);
  if (!r) { r = { s: 0, b: 0 }; m.set(k, r); }
  const t = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  if (kind === "s") r.s = t; else r.b = t;
}

/**
 * Are `lbKey`'s objects on screen-ready? Both kinds attached, or one of them for ATTACH_WAIT_MS (the other is
 * late or failed — do not hold the trees back for a missing building). An entry whose baked marks are gone
 * (evicted) is dropped, so a re-bake waits for its own attach.
 */
export function objectsAttached(scene3d, lbKey, nowMs) {
  const k = lbKey >>> 0;
  const m = scene3d?._objAttach;
  const r = m ? m.get(k) : null;
  const sB = !!scene3d?.staticsBakedLbs?.has?.(k), bB = !!scene3d?.buildingsBakedLbs?.has?.(k);
  if (!sB && !bB) { if (r) m.delete(k); return false; }
  if (!r) return false;
  const s = r.s > 0 && sB, b = r.b > 0 && bB;
  if (s && b) return true;
  if (!s && !b) return false;
  return nowMs - Math.max(r.s, r.b) >= ATTACH_WAIT_MS;
}

// ---------------------------------------------------------------------------
// The per-frame driver: targets from the authoritative state
// ---------------------------------------------------------------------------
const DRIVE_R = 12; // landblocks around the centre whose targets are refreshed every frame

/**
 * `objWanted(k)` / `terDrawn(k)` are the authoritative reads (index.js wires them: baked sets, parks, the object
 * window's own hidden + pending-hide sets). The first time a landblock is seen its value SNAPS to its state, so a
 * boot / teleport shows what is there without a fade; afterwards every change fades.
 */
export function tickLbPresence({ centreLb, nowMs, objWanted, terDrawn }) {
  const p = getLbPresence();
  if (!centreLb) return 0;
  const cx = (centreLb >>> 24) & 0xff, cy = (centreLb >>> 16) & 0xff;
  p.setCentre(cx, cy);
  for (let dx = -DRIVE_R; dx <= DRIVE_R; dx += 1) {
    const x = cx + dx;
    if (x < 0 || x > 0xff) continue;
    for (let dy = -DRIVE_R; dy <= DRIVE_R; dy += 1) {
      const y = cy + dy;
      if (y < 0 || y > 0xff) continue;
      const k = lbKeyXY(x, y);
      const seen = p.cells.has(k);
      const o = objWanted(k) ? 1 : 0;
      const t = terDrawn(k) ? 1 : 0;
      if (!seen) {
        // first sight: objects that are already drawn snap on (boot / teleport); objects that are not drawn yet
        // start at 0 and fade in when they arrive. Terrain always snaps (it is binary).
        p.setTarget(k, CH_OBJ, o, { snap: o === 1 });
        p.setTarget(k, CH_TER, t, { snap: true });
      } else {
        p.setTarget(k, CH_OBJ, o);
        p.setTarget(k, CH_TER, t);
      }
    }
  }
  return p.tick(nowMs);
}

// ---------------------------------------------------------------------------
// The terrain HAND-OFF rule (`?lbBand`): where the far ring and the world tier draw under a near landblock
// ---------------------------------------------------------------------------
// The far ring (far_terrain.js, HB_FAR_PRESENCE) and the world tier (world_terrain.js, HB_WORLD_PRESENCE)
// discard where the near ring draws the ground. Under a near-drawn landblock they used to keep a 10 m band along
// EVERY edge "so the seam between two meshes can never crack". That band WON the depth test instead of hiding
// under the near ring — the owner's "green lines in square shape on terrain" (1070, on foot at Holtburg and at
// 100 m AGL in flight: a 19 m strip of flat, shadow-less far / world ground centred on every landblock edge):
//   * the near ring draws every vertex 1 cm BELOW grade (retail zFightTerrainAdjust, terrain.js
//     ZFIGHT_TERRAIN_ADJUST_M, `?terrainLower`); the far ring and the world tier draw AT grade;
//   * their reversed-Z push is RELATIVE (gl_Position.z *= (5001)^-bias): the far ring 1e-6 → 8.5e-6 of the
//     view distance, the world tier 2.5e-6 → 2.1e-5 — 0.85 mm / 2.1 mm at 100 m;
//   * along a view ray from a camera H metres above the ground a 1 cm vertical gap is 1 cm × d / H of depth, so
//     the near ring wins only where H > 1 cm / push: 1.2 km over the far ring, 470 m over the world tier. On
//     foot and in the whole low flight band the band showed. (The world tier also alternates its cell
//     diagonal where retail picks it per cell: in 7.8 % of the cells around Holtburg its cell centre stands
//     1-11 m above the retail surface — the notched strips.)
// Between two near-drawn landblocks the near ring is watertight by itself (both share the 9 retail vertices of
// the edge, and a re-baked finer landblock keeps its edge on the coarse chord: holtburger-dat terrain_subdiv.rs
// lod_boundary_edges_coincide_across_factors), so no lower tier belongs there — the rule before ?lbFade (the
// far ring's square discard) never drew one there either. A band is needed only where the near ring ENDS: an
// edge (or corner) whose neighbouring landblock the near ring does not draw — its outer edge, a leading-edge
// hole, a parked tile. There the lower tier keeps overlapping it by 10 m (and wins those 10 m: the hand-off line
// moves 10 m in, invisible).
//   open (default)          the band only along those open edges / corners
//   all  (off / 0 / false / no)  the 2026-11-01 rule: a band along every edge (reproduces the green lines)
//   none                    no band at all: a near-drawn landblock is discarded whole (the crack A/B)
export const LB_BAND_FRAC = 0.05;       // the hand-off band, as a fraction of the landblock (9.6 m)
export const LB_BAND_NONE = 0;
export const LB_BAND_OPEN = 1;
export const LB_BAND_ALL = 2;

/** `?lbBand` — open (default) | all (also off / 0 / false / no: the pre-fix rule) | none. */
export function lbBandMode(search) {
  try {
    const s = search !== undefined ? search : (globalThis.location?.search || "");
    const v = (new URLSearchParams(s).get("lbBand") || "").trim().toLowerCase();
    if (v === "all" || v === "off" || v === "0" || v === "false" || v === "no") return LB_BAND_ALL;
    if (v === "none") return LB_BAND_NONE;
    return LB_BAND_OPEN;
  } catch (_) {
    return LB_BAND_OPEN;
  }
}
let _band; // cached page read (session-constant: it is a program define)
export function lbBandOn() {
  if (_band === undefined) _band = lbBandMode();
  return _band;
}
/** Test seam: force the mode (undefined re-reads the URL). */
export function __setLbBandForTest(v) { _band = v; }

/** The material define both hand-off consumers set next to their HB_*_PRESENCE define. */
export function lbBandDefines() { return { HB_LB_BAND: lbBandOn() }; }

/**
 * The rule on the CPU (a mirror of LB_HANDOFF_GLSL for tests and probes): does the near ring cover the point
 * (lbx + fx, lby + fy)? `drawn(x, y)` = the near ring draws landblock (x, y) (presence G > 0.5).
 */
export function nearCoversAt(drawn, lbx, lby, fx, fy, mode = LB_BAND_OPEN) {
  if (!drawn(lbx, lby)) return false;
  if (mode === LB_BAND_NONE) return true;
  const sx = fx <= LB_BAND_FRAC ? -1 : (fx >= 1 - LB_BAND_FRAC ? 1 : 0);
  const sy = fy <= LB_BAND_FRAC ? -1 : (fy >= 1 - LB_BAND_FRAC ? 1 : 0);
  if (sx === 0 && sy === 0) return true;
  if (mode === LB_BAND_ALL) return false;
  if (sx !== 0 && !drawn(lbx + sx, lby)) return false;
  if (sy !== 0 && !drawn(lbx, lby + sy)) return false;
  if (sx !== 0 && sy !== 0 && !drawn(lbx + sx, lby + sy)) return false;
  return true;
}

const _glF = (v) => Number(v).toFixed(4);

/**
 * GLSL of the same rule, for a fragment stage that declares `hbLbPresence` / `hbLbPresenceOrigin` (the shared
 * uniforms) and sets HB_LB_BAND (lbBandDefines). `hbNearCovers(worldXy / 192.0)` → discard. A landblock outside
 * the window reads "not drawn". Plain text, no backticks.
 */
export const LB_HANDOFF_GLSL = `
// lb_presence.js LB_HANDOFF_GLSL (?lbBand): HB_LB_BAND 0 none / 1 open (default) / 2 all
#ifndef HB_LB_BAND
#define HB_LB_BAND 1
#endif
bool hbNearDrawnLb(ivec2 lb) {
  if (lb.x < 0 || lb.y < 0 || lb.x >= ${WIN} || lb.y >= ${WIN}) return false;
  return texelFetch(hbLbPresence, lb, 0).g > 0.5;
}
// true where the near ring covers the fragment for sure: its landblock is near-drawn and, inside the band along
// an edge / at a corner, so is every landblock across that edge / corner (the near ring is watertight there)
bool hbNearCovers(vec2 lbPos) {
  ivec2 lb = ivec2(floor(lbPos)) - ivec2(hbLbPresenceOrigin);
  if (!hbNearDrawnLb(lb)) return false;
#if HB_LB_BAND == 0
  return true;
#else
  vec2 f = fract(lbPos);
  int sx = f.x <= ${_glF(LB_BAND_FRAC)} ? -1 : (f.x >= ${_glF(1 - LB_BAND_FRAC)} ? 1 : 0);
  int sy = f.y <= ${_glF(LB_BAND_FRAC)} ? -1 : (f.y >= ${_glF(1 - LB_BAND_FRAC)} ? 1 : 0);
  if (sx == 0 && sy == 0) return true;
#if HB_LB_BAND == 2
  return false;
#else
  if (sx != 0 && !hbNearDrawnLb(lb + ivec2(sx, 0))) return false;
  if (sy != 0 && !hbNearDrawnLb(lb + ivec2(0, sy))) return false;
  if (sx != 0 && sy != 0 && !hbNearDrawnLb(lb + ivec2(sx, sy))) return false;
  return true;
#endif
#endif
}
`;

/** Diag: `window.__lbPresence()`. */
export function lbPresenceDiag() {
  const p = _presence;
  return {
    flag: lbFadeOn(), objFade: objFadeOn(), chunks: lbFadeState.installed, reason: lbFadeState.reason, materials: lbFadeState.materials,
    band: ["none", "open", "all"][lbBandOn()] ?? null,
    window: p ? { ox: p.ox, oy: p.oy, win: p.win, relayouts: p.relayouts } : null,
    cells: p ? p.cells.size : 0, fading: p ? [...p.cells.keys()].filter((k) => p.fading(k)).length : 0,
    stats: p ? { ...p.stats } : null,
  };
}

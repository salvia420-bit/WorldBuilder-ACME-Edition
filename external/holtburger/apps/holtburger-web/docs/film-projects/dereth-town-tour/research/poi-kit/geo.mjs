// poi-kit/geo.mjs — offline AC world geometry for film shot checks (Dereth tour expansion, 2026-10-15).
// Data: world/0xXXYY.json per landblock (build_world.py from WorldBuilder.Terminal dumps + the dist bakes).
// groundZ = the retail split-triangle interpolation of the 9x9 vertex heights (acclient CLandBlock split magic).
// Obstacles: statics as rotated model AABBs, building footprints as prisms (floorZ..topZ), procedural scenery
// (default bake = what the client draws; retail bake = opt-in), outdoor ACE spawns as 2.4 x 3.5 m boxes.
import fs from "node:fs";
import path from "node:path";

export const KIT = path.dirname(new URL(import.meta.url).pathname);
const cache = new Map();
const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, "0");
export const lbKey = (lbX, lbY) => `0x${hex2(lbX)}${hex2(lbY)}`;

export function loadLb(lbX, lbY) {
  const k = lbKey(lbX, lbY);
  if (cache.has(k)) return cache.get(k);
  const f = path.join(KIT, "world", `${k}.json`);
  const w = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
  cache.set(k, w);
  return w;
}

function isSWtoNE(gx, gy) {
  const a = (Math.imul(gx, 214614067) + 1813693831) | 0;
  const b = Math.imul(gx, 1109124029) | 0;
  return ((Math.imul(gy, a) - b - 1369149221) >>> 0) * 2.3283064e-10 >= 0.5;
}

/** Terrain z at world (x, y), or null when that landblock is not in the kit. */
export function groundZ(x, y) {
  const lbX = Math.floor(x / 192), lbY = Math.floor(y / 192);
  const w = loadLb(lbX, lbY);
  if (!w) return null;
  const cx = (x - lbX * 192) / 24, cy = (y - lbY * 192) / 24;
  const ix = Math.min(Math.floor(cx), 7), iy = Math.min(Math.floor(cy), 7);
  const fx = cx - ix, fy = cy - iy;
  const g = w.h;
  const sw = g[ix][iy], se = g[ix + 1][iy], nw = g[ix][iy + 1], ne = g[ix + 1][iy + 1];
  if ([sw, se, nw, ne].some((v) => v === null || v === undefined)) return null;
  if (isSWtoNE(lbX * 8 + ix, lbY * 8 + iy)) {
    if (fx > fy) return sw + fx * (se - sw) + fy * (ne - se);
    return sw + fx * (ne - nw) + fy * (nw - sw);
  }
  if (fx + fy <= 1) return sw + fx * (se - sw) + fy * (nw - sw);
  return ne + (1 - fx) * (nw - ne) + (1 - fy) * (se - ne);
}

export const TERRAIN_NAMES = ["BarrenRock", "Grassland", "Ice", "LushGrass", "MarshSparseSwamp", "MudRichDirt", "ObsidianPlain",
  "PackedDirt", "PatchyDirt", "PatchyGrassland", "SandYellow", "SandGrey", "SandRockStrewn", "SedimentaryRock", "SemiBarrenRock",
  "Snow", "WaterRunning", "WaterStandingFresh", "WaterShallowSea", "WaterShallowStillSea", "WaterDeepSea", "forestfloor",
  "FauxWaterRunning", "SeaSlime", "Argila", "VolcanoLava", "VolcanoFlow", "BlueIce", "Rock3", "Rock4", "Rock5", "Rock6"];

/** Terrain type of the nearest vertex: {id, name, water: 'running'|'fresh'|'sea'|'deep'|null}. */
export function terrainAt(x, y) {
  const lbX = Math.floor(x / 192), lbY = Math.floor(y / 192);
  const w = loadLb(lbX, lbY);
  if (!w) return null;
  const ix = Math.min(8, Math.round((x - lbX * 192) / 24)), iy = Math.min(8, Math.round((y - lbY * 192) / 24));
  const id = w.tt[ix][iy];
  const water = id === 16 ? "running" : id === 17 ? "fresh" : id === 18 || id === 19 ? "sea" : id === 20 ? "deep" : null;
  return { id, name: TERRAIN_NAMES[id] || String(id), water, road: !!w.road[ix][iy] };
}
export const waterAt = (x, y) => (terrainAt(x, y) || {}).water || null;

/**
 * Obstacles of the landblocks within R metres of (x, y).
 * opts.scenery: 'default' (what the client draws; the film boots on the default bake) | 'both' | 'none'.
 * Boxes {kind, id, lo, hi}; building prisms {kind:'bldg', id, fp, z0, z1}.
 */
export function obstaclesNear(x, y, R = 300, opts = {}) {
  const sc = opts.scenery || "default";
  const out = [];
  const x0 = Math.floor((x - R) / 192), x1 = Math.floor((x + R) / 192), y0 = Math.floor((y - R) / 192), y1 = Math.floor((y + R) / 192);
  const inR = (p) => Math.abs(p[0] - x) <= R + 40 && Math.abs(p[1] - y) <= R + 40;
  for (let a = x0; a <= x1; a++) for (let b = y0; b <= y1; b++) {
    const w = loadLb(a, b);
    if (!w) continue;
    for (const s of w.statics) {
      const dim = Math.max(s.hi[0] - s.lo[0], s.hi[1] - s.lo[1], s.hi[2] - s.lo[2]);
      if (dim < 0.35 || !inR(s.p)) continue; // effect emitters / markers
      out.push({ kind: "static", id: `${w.lb}#${s.i} ${s.m}${s.weenie ? " " + s.weenie : ""}`, lo: s.lo, hi: s.hi });
    }
    for (const s of w.structs) {
      if (!s.fp || s.fp.length < 3 || !inR(s.fp[0])) continue;
      out.push({ kind: "bldg", id: `${w.lb}#${s.i} ${s.m} ${s.type || ""}`.trim(), fp: s.fp, z0: s.z0, z1: s.z1 });
    }
    if (sc !== "none") for (const s of w.scenery) {
      if (sc === "default" && s.set !== "default") continue;
      if (s.hi[2] - s.lo[2] < 1.0 || !inR(s.p)) continue;
      out.push({ kind: `scenery-${s.set}`, id: `${s.m}@${s.p[0].toFixed(0)},${s.p[1].toFixed(0)}`, lo: s.lo, hi: s.hi });
    }
    for (const e of w.spawns) {
      if (e.cat === "Creature" || !inR(e.p)) continue;
      const hw = e.name === "Door" ? 0.8 : 1.2, hh = e.name === "Door" ? 2.6 : 3.5;
      out.push({ kind: "spawn", id: e.name, lo: [e.p[0] - hw, e.p[1] - hw, e.p[2]], hi: [e.p[0] + hw, e.p[1] + hw, e.p[2] + hh] });
    }
  }
  return out;
}

export function distBox(p, b) {
  let d2 = 0;
  for (let i = 0; i < 3; i++) {
    const v = p[i] < b.lo[i] ? b.lo[i] - p[i] : p[i] > b.hi[i] ? p[i] - b.hi[i] : 0;
    d2 += v * v;
  }
  return Math.sqrt(d2);
}
export function pip(x, y, fp) {
  let inside = false;
  for (let i = 0, j = fp.length - 1; i < fp.length; j = i++) {
    const [xi, yi] = fp[i], [xj, yj] = fp[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function segDist(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  let t = L > 0 ? ((x - a[0]) * dx + (y - a[1]) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}
export function distPrism(p, s) {
  let d2d = 0;
  if (!pip(p[0], p[1], s.fp)) {
    d2d = Infinity;
    for (let i = 0; i < s.fp.length; i++) d2d = Math.min(d2d, segDist(p[0], p[1], s.fp[i], s.fp[(i + 1) % s.fp.length]));
  }
  const dz = p[2] < s.z0 ? s.z0 - p[2] : p[2] > s.z1 ? p[2] - s.z1 : 0;
  return Math.hypot(d2d, dz);
}
export const distTo = (p, o) => (o.fp ? distPrism(p, o) : distBox(p, o));

export function nearest(p, list, filter) {
  let best = { d: Infinity, id: null, kind: null };
  for (const o of list) {
    if (filter && !filter(o)) continue;
    const d = distTo(p, o);
    if (d < best.d) best = { d, id: o.id, kind: o.kind };
  }
  return best;
}

/** First obstacle (or terrain) on the segment a → b, ignoring the last `stop` metres before b and objects in `skip`. */
export function blocked(a, b, list, stop = 3, skip = null) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const n = Math.max(2, Math.ceil(L / 1.0));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (L * (1 - t) < stop) break;
    const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const g = groundZ(p[0], p[1]);
    if (g !== null && p[2] < g - 0.3) return { id: "terrain", kind: "terrain", at: t };
    for (const o of list) {
      if (skip && skip(o)) continue;
      if (distTo(p, o) === 0) return { id: o.id, kind: o.kind, at: t };
    }
  }
  return null;
}

/** Camera basis from compass heading h (radians, clockwise from north) and pitch p (radians, up +). */
export function project(pose, target, aspect = 16 / 9) {
  const { h, p } = pose;
  const fwd = [Math.sin(h) * Math.cos(p), Math.cos(h) * Math.cos(p), Math.sin(p)];
  const right = [Math.cos(h), -Math.sin(h), 0];
  const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
  const d = [target[0] - pose.pos[0], target[1] - pose.pos[1], target[2] - pose.pos[2]];
  const z = d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2];
  if (z <= 0.01) return { behind: true, x: NaN, y: NaN, z };
  const tv = Math.tan(((pose.fov || 60) * Math.PI) / 360);
  const x = (d[0] * right[0] + d[1] * right[1] + d[2] * right[2]) / z / (tv * aspect);
  const y = (d[0] * up[0] + d[1] * up[1] + d[2] * up[2]) / z / tv;
  return { behind: false, x, y, z };
}

/** World [x, y, z] of a plan anchor ([x,y,z] or {cell, local:[x,y,z]} / {cell, x, y, z}). */
export function anchorWorld(a) {
  if (Array.isArray(a)) return a;
  if (a && typeof a === "object") {
    const cell = typeof a.cell === "string" ? parseInt(a.cell, 16) : a.cell;
    const loc = Array.isArray(a.local) ? a.local : [a.x, a.y, a.z];
    const lbX = (cell >>> 24) & 0xff, lbY = (cell >>> 16) & 0xff;
    return [lbX * 192 + loc[0], lbY * 192 + loc[1], loc[2]];
  }
  return null;
}

// Tree wind rig — pure, deterministic, no THREE / no wasm (Phase 1, 2026-06-23).
//
// Produces the dense per-part keyframe array that `buildSceneryAnimationClip`
// (animated_scenery.js) consumes, so the existing per-part keyframe player
// drives wind sway with ZERO new runtime infrastructure.
//
// Output layout (matches buildSceneryAnimationClip exactly):
//   frames[(f*numParts + p)*7 + 0..6] = [ox,oy,oz, qw,qx,qy,qz]
//   — ABSOLUTE part-local Frame, AC quaternion order wxyz, frame-major.
//
// The motion is a hinge ROTATION about each part's BASE pivot (its vertex Zmin
// in model space), composed ON TOP of the part's REST frame:
//   R_final = R_wind * R_rest
//   o_final = R_wind * (o_rest - pivot) + pivot      ("rotate about pivot")
// This is the fix for AC's co-located-origin trees: every part sits at model
// origin (0,0,0), so rotating about the origin would swing a high canopy part
// through a huge arc. Pivoting about the part's own base keeps the trunk
// planted while the canopy sways. Composing with R_rest preserves authored
// per-part orientations (e.g. 0x02001063's rotated billboards).
//
// Determinism: per-part phase from a golden-ratio hash (Math.random is banned
// in the bake sandbox and would also break frame-to-frame stability). The loop
// is seamless because every band frequency is an integer number of cycles over
// the clip DURATION (numFrames-1)/fps, so frame[0] === frame[numFrames-1].

const DEG2RAD = Math.PI / 180;
const GOLDEN = 0.6180339887498949;

// ---- quaternion helpers (wxyz arrays) ----
function qmul(a, b) {
  const [aw, ax, ay, az] = a, [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}
function qrotvec(q, vx, vy, vz) {
  const [w, x, y, z] = q;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  // v' = v + w*t + cross(q.xyz, t)
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/**
 * Object-space AABB of a flat xyz position stream (e.g. a THREE geometry's
 * `position.array`). Returns local bounds + centre. AC is Z-up.
 */
export function partBBox(positions) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const n = positions ? positions.length : 0;
  for (let i = 0; i + 2 < n; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minZ)) { minX = minY = minZ = maxX = maxY = maxZ = 0; }
  return {
    minX, minY, minZ, maxX, maxY, maxZ,
    cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, cz: (minZ + maxZ) / 2,
  };
}

// Transform a local AABB by a rest frame {o:{x,y,z}, q:[w,x,y,z]} → model-space
// {minZ,maxZ,cz,cx,cy} (8-corner transform; exact for any rotation).
function _modelBox(local, rest) {
  const o = rest.o, q = rest.q;
  const xs = [local.minX, local.maxX], ys = [local.minY, local.maxY], zs = [local.minZ, local.maxZ];
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < 8; i++) {
    const lx = xs[(i >> 0) & 1], ly = ys[(i >> 1) & 1], lz = zs[(i >> 2) & 1];
    const [wx, wy, wz] = qrotvec(q, lx, ly, lz);
    const X = wx + o.x, Y = wy + o.y, Z = wz + o.z;
    if (X < mnx) mnx = X; if (X > mxx) mxx = X;
    if (Y < mny) mny = Y; if (Y > mxy) mxy = Y;
    if (Z < mnz) mnz = Z; if (Z > mxz) mxz = Z;
  }
  return { minZ: mnz, maxZ: mxz, cz: (mnz + mxz) / 2, cx: (mnx + mxx) / 2, cy: (mny + mxy) / 2 };
}

/**
 * Per-part sway weight from a part's MODEL-space box + the model bounds.
 * Monotone: higher parts sway more; a near-full-height (trunk-like) part is
 * suppressed so the trunk stays planted. Range [0.1, 1].
 */
export function swayAmp(partModelBox, modelMinZ, modelH) {
  const H = Math.max(modelH, 1e-3);
  const hfrac = clamp((partModelBox.cz - modelMinZ) / H, 0, 1);
  let w = 0.15 + 0.85 * hfrac;
  const spanFrac = (partModelBox.maxZ - partModelBox.minZ) / H;
  if (spanFrac > 0.7) w *= 0.3; // full-height trunk-like part → barely moves
  return clamp(w, 0.1, 1);
}

/**
 * Build the per-part rig from per-part local bounding boxes + rest (hinge)
 * frames. `hingeFrames[p]` may be {x,y,z,qw,qx,qy,qz} (from
 * `takePartHingeFrames`) or null/undefined → identity rest.
 * Returns { rigs:[{pivot:{x,y,z}, weight, rest:{o,q}}], modelH }.
 */
export function buildBboxRig(partBoxes, hingeFrames) {
  const rests = partBoxes.map((_, p) => {
    const h = hingeFrames && hingeFrames[p];
    if (!h) return { o: { x: 0, y: 0, z: 0 }, q: [1, 0, 0, 0] };
    return {
      o: { x: h.x || 0, y: h.y || 0, z: h.z || 0 },
      q: [typeof h.qw === "number" ? h.qw : 1, h.qx || 0, h.qy || 0, h.qz || 0],
    };
  });
  const modelBoxes = partBoxes.map((lb, p) => _modelBox(lb, rests[p]));
  let modelMinZ = Infinity, modelMaxZ = -Infinity;
  for (const mb of modelBoxes) {
    if (mb.minZ < modelMinZ) modelMinZ = mb.minZ;
    if (mb.maxZ > modelMaxZ) modelMaxZ = mb.maxZ;
  }
  if (!Number.isFinite(modelMinZ)) { modelMinZ = 0; modelMaxZ = 0; }
  const modelH = modelMaxZ - modelMinZ;
  const rigs = partBoxes.map((_, p) => ({
    // pivot = part base in MODEL space (centroid XY, vertex Zmin).
    pivot: { x: modelBoxes[p].cx, y: modelBoxes[p].cy, z: modelBoxes[p].minZ },
    weight: swayAmp(modelBoxes[p], modelMinZ, modelH),
    rest: rests[p],
  }));
  return { rigs, modelH };
}

/**
 * Build a dense per-part wind keyframe array for buildSceneryAnimationClip.
 *
 * @param {number} numParts
 * @param {Array|null} rig  per-part [{pivot,weight,rest}] (from buildBboxRig);
 *                          null → origin pivot, weight 1, identity rest.
 * @param {object} opts  { fps, loopSeconds, ampDeg, dirDeg, strength,
 *                         cycles1, cycles2, flutter, phaseOffset }
 * @returns {{frames:Float32Array, numParts:number, numFrames:number, fps:number}}
 */
export function buildTreeWindClip(numParts, rig, opts) {
  const o = opts || {};
  const fps = o.fps > 0 ? o.fps : 30;
  const loopSeconds = o.loopSeconds > 0 ? o.loopSeconds : 4;
  const ampDeg = typeof o.ampDeg === "number" ? o.ampDeg : 7;
  const strength = typeof o.strength === "number" ? o.strength : 1;
  const cycles1 = o.cycles1 || 3;   // integer → seamless loop
  const cycles2 = o.cycles2 || 11;  // integer flutter band
  const flutter = typeof o.flutter === "number" ? o.flutter : 0.3;
  const phaseOffset = o.phaseOffset || 0;
  const dirRad = (typeof o.dirDeg === "number" ? o.dirDeg : 135) * DEG2RAD;

  const numFrames = Math.max(2, Math.round(fps * loopSeconds) + 1);
  const T = (numFrames - 1) / fps;                 // = loopSeconds; period == duration
  const w1 = (2 * Math.PI * cycles1) / T;
  const w2 = (2 * Math.PI * cycles2) / T;
  const A = ampDeg * DEG2RAD * strength;

  // Hinge axis: horizontal, perpendicular to wind dir (Z-up). Bend leans the
  // canopy along the wind direction.
  const dx = Math.cos(dirRad), dy = Math.sin(dirRad);
  const ax = -dy, ay = dx, az = 0;

  const frames = new Float32Array(numParts * numFrames * 7);
  for (let p = 0; p < numParts; p++) {
    const r = rig && rig[p];
    const weight = r ? r.weight : 1;
    const piv = r ? r.pivot : { x: 0, y: 0, z: 0 };
    const restQ = r ? r.rest.q : [1, 0, 0, 0];
    const restO = r ? r.rest.o : { x: 0, y: 0, z: 0 };
    const ph = 2 * Math.PI * ((p * GOLDEN) % 1) + phaseOffset;
    const ph2 = ph * 1.7 + 1.3; // decorrelate the flutter band
    for (let f = 0; f < numFrames; f++) {
      const t = f / fps;
      const th = A * weight * (Math.sin(w1 * t + ph) + flutter * Math.sin(w2 * t + ph2));
      const half = th * 0.5, s = Math.sin(half), c = Math.cos(half);
      const Rw = [c, s * ax, s * ay, s * az];          // wind rotation (wxyz)
      const Rf = qmul(Rw, restQ);                       // R_final = R_wind * R_rest
      // o_final = R_wind * (o_rest - pivot) + pivot
      const [tx, ty, tz] = qrotvec(Rw, restO.x - piv.x, restO.y - piv.y, restO.z - piv.z);
      const ox = tx + piv.x, oy = ty + piv.y, oz = tz + piv.z;
      const b = (f * numParts + p) * 7;
      frames[b] = ox; frames[b + 1] = oy; frames[b + 2] = oz;
      frames[b + 3] = Rf[0]; frames[b + 4] = Rf[1]; frames[b + 5] = Rf[2]; frames[b + 6] = Rf[3];
    }
  }
  return { frames, numParts, numFrames, fps };
}

/** Deterministic [0,1) hash for per-instance phase buckets (no Math.random). */
export function hash01(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0) / 4294967296;
}

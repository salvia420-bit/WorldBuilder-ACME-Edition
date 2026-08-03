// scene3d/blood_decals.js — persistent blood splatter on world surfaces
// (?blood — DEFAULT ON, =off escape).
//
// Every combat splatter event (broadcast for all creatures) stamps liquid
// blood marks onto whatever surface the spray physically reaches: dungeon
// walls/floor/ceiling (EnvCells), building interiors, terrain, tree trunks.
// Bodies and severed pieces leave pools where they come to rest (via the
// `window.__bloodPools` hook that ragdoll_env/dismember feed).
//
// DESIGN CONSTRAINTS (owner 2026-08-02): must survive "a couple of hallways
// of monsters (20-30) over a few minutes" and MUST NOT touch the terrain /
// EnvCell / interior rendering systems. Both are answered by the same
// architecture: all stains live in ONE InstancedMesh (a single draw call,
// hard cap BLOOD_MAX_DECALS with circular overwrite of the oldest), parented
// additively to `entitiesGroup` (AC frame, render layer 1 like entities so it
// draws in both the outdoor and interior passes) — the world meshes are only
// ever RAYCAST against, never modified. Aging (fresh red → dried brown →
// fade) runs entirely in the shader off one time uniform, so per-frame CPU
// cost is a single uniform write while any stain is visible.
//
// Placement: a small ray fan from the wound point (direction = the splatter
// quadrant, i.e. away from the blow) against cells+buildings(+statics for
// tree trunks), capped and bounding-sphere-culled; downward rays that miss
// geometry outdoors fall back to the analytic terrain height (no terrain
// raycasts — terrain meshes are big and the oracle is exact). Vertical
// surfaces get elongated runny streak variants aligned with gravity;
// ceilings (indoor, crit-biased) get round spatter; floors get spread blots.

import * as THREE from "three";

export function bloodEnabled() {
  try {
    return new URLSearchParams(window.location.search).get("blood") !== "off";
  } catch (_e) {
    return false;
  }
}

/* ── tunables ────────────────────────────────────────────────────────── */
export const BLOOD_MAX_DECALS = 1024; // one InstancedMesh, circular overwrite
export const BLOOD_TTL_S = 240; // full life; last 45s fade out
export const BLOOD_DRY_S = 70; // seconds to dry from red to dark brown
export const BLOOD_RAYS_HIT = 3; // rays per normal splatter
export const BLOOD_RAYS_CRIT = 6;
export const BLOOD_RANGE_M = 7; // how far spray can reach a surface
export const BLOOD_EVENTS_PER_SEC = 30; // global throttle
const MAX_RAY_TARGETS = 48;
const MAX_SCENE_VISITS = 2500;
// Decal depth bias, applied to the LOG-depth view distance (see the
// USE_LOGARITHMIC_DEPTH_BUFFER block in the vertex shader). `polygonOffset`
// below is DEAD whenever the shader writes gl_FragDepth — GL applies polygon
// offset to the interpolated depth only, and a shader-written depth replaces
// it — so the coplanar-decal fight has to be won here instead. 0.999 pulls the
// stain 0.1 % of its view distance toward the eye: 2 mm at 2 m, 1 cm at 10 m,
// on top of the 1.5 cm geometric offset along the surface normal in `_stamp`.
const BLOOD_DEPTH_BIAS = 0.999;

/* ── pure math (node-tested) ─────────────────────────────────────────── */

/**
 * Spray directions for one hit: mostly the quadrant direction (away from the
 * attacker, through the body) fanned in a cone, plus drip-biased down rays,
 * plus an optional ceiling ray. Returns array of [x,y,z] unit vectors in the
 * AC frame (+Z up). `quadDir` = horizontal unit [x,y].
 */
export function makeRayFan(quadDir, count, indoor, crit, rand = Math.random) {
  const rays = [];
  const [qx, qy] = quadDir;
  for (let i = 0; i < count; i++) {
    const yaw = (rand() - 0.5) * 1.2; // ±34° around the quadrant dir
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const dx = qx * c - qy * s;
    const dy = qx * s + qy * c;
    // pitch: bias downward — blood falls; first ray flattest (wall shot)
    const pitch = i === 0 ? (rand() - 0.5) * 0.4 : -(0.25 + rand() * 0.9);
    const cp = Math.cos(pitch);
    rays.push([dx * cp, dy * cp, Math.sin(pitch)]);
  }
  if (indoor && (crit || rand() < 0.25)) {
    // Arterial ceiling hit: mostly straight up, leaning along the spray.
    //
    // 2026-08-03 — the old line was
    //   [qx * 0.3 * Math.cos(yaw), qy * 0.3 * Math.sin(yaw) || 0.1, 0.95]
    // which is not a rotation at all: it multiplies each component by a
    // DIFFERENT trig function of the same angle (a yaw rotation is
    // `qx*c - qy*s` / `qx*s + qy*c`, both components of ONE rotation), and the
    // `|| 0.1` binds looser than the `*`, so any spray along ±X (`qy === 0`)
    // silently became a FIXED +Y lean — indoor ceiling spatter always landed
    // on the same side of the victim regardless of where the blow came from.
    const yaw = (rand() - 0.5) * 0.8;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    let lx = (qx * c - qy * s) * 0.3;
    let ly = (qx * s + qy * c) * 0.3;
    if (!Number.isFinite(lx) || !Number.isFinite(ly) || (lx === 0 && ly === 0)) {
      // Degenerate quadrant (a zero/NaN spray dir): any small lean beats a
      // perfectly vertical ray, which would stripe the ceiling directly
      // overhead on every hit. This is the ONLY case the old `|| 0.1` was
      // right about, kept explicit instead of riding operator precedence.
      lx = 0;
      ly = 0.1;
    }
    // Unit, like every other ray in the fan (`[dx*cp, dy*cp, sin(pitch)]` from
    // a unit horizontal is already unit) — the docstring promises unit vectors
    // and the suite asserts it. `transformDirection` would normalise anyway.
    const l = Math.hypot(lx, ly, 0.95) || 1;
    rays.push([lx / l, ly / l, 0.95 / l]);
  }
  return rays;
}

/**
 * Decal transform on a surface. `n` = surface normal (AC frame, unit).
 * Vertical-ish surfaces pick a streak variant and elongate down-slope;
 * ceilings and floors get round variants with random roll.
 * Returns { quat:[x,y,z,w], scale:[sx,sy], variant:'floor'|'wall'|'ceiling' }.
 */
export function stampOrientation(n, size, rand = Math.random) {
  const up = Math.abs(n[2]);
  const variant = n[2] > 0.6 ? "floor" : n[2] < -0.6 ? "ceiling" : "wall";
  // base quat: rotate +Z onto n
  const q = _quatZTo(n);
  let roll;
  let sx = size;
  let sy = size;
  if (variant === "wall") {
    // align local -Y with world gravity projected onto the surface, so the
    // streak runs DOWN the wall; elongate.
    // local Y axis after q: y' = q * (0,1,0). We want y' ≈ +Z (so -Y runs down).
    // Solve roll about n that maximizes y'·(0,0,1).
    roll = _rollForUpSlope(q);
    sy = size * (1.6 + rand() * 1.2);
    sx = size * (0.55 + rand() * 0.3);
  } else {
    roll = rand() * Math.PI * 2;
    if (up < 0.95) {
      // sloped ground: mild elongation down-slope reads as run-off
      sy = size * (1.15 + (1 - up) * 0.8);
    }
  }
  const rq = _quatAxisAngle(n, roll);
  return { quat: _quatMul(rq, q), scale: [sx, sy], variant };
}

export function ageAlpha(ageS, ttlS = BLOOD_TTL_S) {
  if (ageS < 0) return 0;
  if (ageS < 0.12) return ageS / 0.12;
  const fadeStart = ttlS - 45;
  if (ageS < fadeStart) return 1;
  if (ageS >= ttlS) return 0;
  return 1 - (ageS - fadeStart) / 45;
}

function _quatZTo(n) {
  // shortest arc from (0,0,1) to n
  const d = n[2];
  if (d > 0.999999) return [0, 0, 0, 1];
  if (d < -0.999999) return [1, 0, 0, 0];
  const cx = -n[1];
  const cy = n[0];
  const w = 1 + d;
  const l = Math.hypot(cx, cy, w) || 1;
  return [cx / l, cy / l, 0, w / l];
}
function _quatAxisAngle(axis, a) {
  const s = Math.sin(a / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(a / 2)];
}
function _quatMul(q1, q2) {
  const [x1, y1, z1, w1] = q1;
  const [x2, y2, z2, w2] = q2;
  return [
    w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
    w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
    w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
  ];
}
function _rotByQuat(q, v) {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  const dd = x * vx + y * vy + z * vz;
  const nn = x * x + y * y + z * z;
  const cx = y * vz - z * vy;
  const cy = z * vx - x * vz;
  const cz = x * vy - y * vx;
  return [
    2 * dd * x + (w * w - nn) * vx + 2 * w * cx,
    2 * dd * y + (w * w - nn) * vy + 2 * w * cy,
    2 * dd * z + (w * w - nn) * vz + 2 * w * cz,
  ];
}
function _rollForUpSlope(q) {
  // choose roll about local Z so rotated +Y points as much +Z (AC up) as possible
  const y1 = _rotByQuat(q, [0, 1, 0]);
  const x1 = _rotByQuat(q, [1, 0, 0]);
  // maximize (cosR*y1 + sinR*(-x1))·Zup  → atan2
  return Math.atan2(-x1[2], y1[2]);
}

/* ── atlas (procedural, liquid look; browser only) ───────────────────── */
// 4 columns × 2 rows: [0..2]=impact blots, [3]=wall streak, [4..5]=spatter,
// [6]=pool, [7]=heavy streak.
const ATLAS_COLS = 4;
const ATLAS_ROWS = 2;
const VARIANT_TILES = { floor: [0, 1, 2, 4, 5], wall: [3, 7], ceiling: [4, 5, 0], pool: [6] };

function _drawBlot(ctx, cx, cy, r, rand, runny) {
  // core
  const grad = ctx.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
  grad.addColorStop(0, "rgba(255,255,255,0.95)");
  grad.addColorStop(0.55, "rgba(255,255,255,0.85)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  // irregular edge: radial blob with noise
  const steps = 26;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const rr = r * (0.55 + 0.45 * Math.abs(Math.sin(a * 3 + rand() * 7)) * (0.6 + rand() * 0.4));
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr * (runny ? 1.25 : 1);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  // satellite droplets
  const sats = 6 + ((rand() * 8) | 0);
  for (let i = 0; i < sats; i++) {
    const a = rand() * Math.PI * 2;
    const d = r * (0.9 + rand() * 0.9);
    const sr = r * (0.04 + rand() * 0.1);
    const sx = cx + Math.cos(a) * d;
    const sy = cy + Math.sin(a) * d + (runny ? d * 0.35 : 0);
    ctx.globalAlpha = 0.7 + rand() * 0.3;
    ctx.beginPath();
    ctx.ellipse(sx, sy, sr, sr * (0.7 + rand() * 0.6), a, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

function _drawStreak(ctx, cx, topY, w, h, rand, heavy) {
  // runny wall streak: head blob + gravity drips with bulbed ends
  _drawBlot(ctx, cx, topY + w * 0.5, w * 0.55, rand, true);
  const drips = heavy ? 5 : 3;
  for (let i = 0; i < drips; i++) {
    const dx = cx + (rand() - 0.5) * w * 0.8;
    const len = h * (0.35 + rand() * 0.55);
    const dw = w * (0.05 + rand() * 0.06);
    const grad = ctx.createLinearGradient(dx, topY + w * 0.4, dx, topY + len);
    grad.addColorStop(0, "rgba(255,255,255,0.9)");
    grad.addColorStop(0.85, "rgba(255,255,255,0.75)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(dx - dw / 2, topY + w * 0.4, dw, len);
    // bulb at the running tip
    ctx.beginPath();
    ctx.ellipse(dx, topY + len * (0.92 + rand() * 0.06), dw * 1.4, dw * 2.0, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fill();
  }
}

function _buildAtlasTexture() {
  const TS = 256;
  const canvas = document.createElement("canvas");
  canvas.width = TS * ATLAS_COLS;
  canvas.height = TS * ATLAS_ROWS;
  const ctx = canvas.getContext("2d");
  let seed = 1234567;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const tile = (i) => [(i % ATLAS_COLS) * TS, ((i / ATLAS_COLS) | 0) * TS];
  for (const i of [0, 1, 2]) {
    const [ox, oy] = tile(i);
    _drawBlot(ctx, ox + TS / 2, oy + TS / 2, TS * 0.34, rand, false);
  }
  {
    const [ox, oy] = tile(3);
    _drawStreak(ctx, ox + TS / 2, oy + TS * 0.08, TS * 0.4, TS * 0.85, rand, false);
  }
  for (const i of [4, 5]) {
    const [ox, oy] = tile(i);
    // fine spatter: many small droplets
    for (let d = 0; d < 46; d++) {
      const a = rand() * Math.PI * 2;
      const r = TS * 0.05 + rand() * TS * 0.34;
      ctx.globalAlpha = 0.5 + rand() * 0.5;
      ctx.fillStyle = "rgba(255,255,255,1)";
      ctx.beginPath();
      ctx.ellipse(ox + TS / 2 + Math.cos(a) * r, oy + TS / 2 + Math.sin(a) * r,
        TS * (0.008 + rand() * 0.03), TS * (0.008 + rand() * 0.05), a, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  {
    const [ox, oy] = tile(6);
    _drawBlot(ctx, ox + TS / 2, oy + TS / 2, TS * 0.42, rand, false);
    _drawBlot(ctx, ox + TS / 2 + TS * 0.1, oy + TS / 2 - TS * 0.06, TS * 0.3, rand, false);
  }
  {
    const [ox, oy] = tile(7);
    _drawStreak(ctx, ox + TS / 2, oy + TS * 0.05, TS * 0.52, TS * 0.9, rand, true);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/* ── instanced decal pool ────────────────────────────────────────────── */

let _pool = null; // { mesh, geom, mat, uTime, birth, uvRect, tint, cursor }
let _warnedNoScene = false;
let _totalStamped = 0;

function _nowS() {
  return performance.now() / 1000;
}

function _buildPool() {
  const geom = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1);
  geom.index = quad.index;
  geom.attributes.position = quad.attributes.position;
  geom.attributes.uv = quad.attributes.uv;
  const birth = new THREE.InstancedBufferAttribute(new Float32Array(BLOOD_MAX_DECALS).fill(-1e9), 1);
  const uvRect = new THREE.InstancedBufferAttribute(new Float32Array(BLOOD_MAX_DECALS * 4), 4);
  const tint = new THREE.InstancedBufferAttribute(new Float32Array(BLOOD_MAX_DECALS * 3), 3);
  birth.setUsage(THREE.DynamicDrawUsage);
  uvRect.setUsage(THREE.DynamicDrawUsage);
  tint.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute("aBirth", birth);
  geom.setAttribute("aUvRect", uvRect);
  geom.setAttribute("aTint", tint);

  const uTime = { value: 0 };
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime, uMap: { value: _buildAtlasTexture() } },
    // NOTE (2026-08-02, the "invisible blood" root cause): the renderer runs
    // with `logarithmicDepthBuffer: true` (index.js:985). three injects
    // USE_LOGARITHMIC_DEPTH_BUFFER + the `logDepthBufFC` uniform into EVERY
    // program — INCLUDING a plain ShaderMaterial — and its built-in materials
    // (buildings/cells/statics = MeshStandardMaterial) therefore write a
    // LOGARITHMIC gl_FragDepth. A custom shader that omits the chunk writes
    // ordinary hardware gl_FragCoord.z instead, a completely different
    // encoding, so it loses the depth test against the world essentially
    // everywhere → the decals draw nothing, silently (three's
    // `debug.checkShaderErrors` is also OFF here unless ?shaderErrorCheck=on —
    // index.js:1001 — so nothing lands in the console either). Same bug that
    // hit terrain.js — see its note at terrain.js:1202-1215. Inlined rather than
    // `#include <logdepthbuf_*>` because the chunk's isPerspectiveMatrix()
    // lives in <common>; guarded on the define so a non-log renderer (none
    // today) still renders correctly through the polygonOffset path.
    vertexShader: /* glsl */ `
      attribute vec4 aUvRect;
      attribute float aBirth;
      attribute vec3 aTint;
      varying vec2 vUv;
      varying vec4 vUvRect;
      varying float vBirth;
      varying vec3 vTint;
#if defined( USE_LOGARITHMIC_DEPTH_BUFFER ) || defined( USE_LOGDEPTHBUF )
      varying float vFragDepth;
      varying float vIsPerspective;
#endif
      void main() {
        vUv = uv;
        vUvRect = aUvRect;
        vBirth = aBirth;
        vTint = aTint;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
#if defined( USE_LOGARITHMIC_DEPTH_BUFFER ) || defined( USE_LOGDEPTHBUF )
        // Matches three's logdepthbuf_vertex chunk, with the decal bias folded
        // into the view distance. vIsPerspective inlines isPerspectiveMatrix().
        vFragDepth = 1.0 + gl_Position.w * ${BLOOD_DEPTH_BIAS.toFixed(4)};
        vIsPerspective = float( projectionMatrix[2][3] == -1.0 );
#endif
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform float uTime;
      varying vec2 vUv;
      varying vec4 vUvRect;
      varying float vBirth;
      varying vec3 vTint;
#if defined( USE_LOGARITHMIC_DEPTH_BUFFER ) || defined( USE_LOGDEPTHBUF )
      // logDepthBufFC is a renderer-supplied built-in (WebGLRenderer.setProgram
      // pushes it every frame from camera.far onto any program that declares
      // it) — no entry is needed in the material's own uniforms map.
      uniform float logDepthBufFC;
      varying float vFragDepth;
      varying float vIsPerspective;
#endif
      const float TTL = ${BLOOD_TTL_S.toFixed(1)};
      const float DRY = ${BLOOD_DRY_S.toFixed(1)};
      void main() {
#if defined( USE_LOGARITHMIC_DEPTH_BUFFER ) || defined( USE_LOGDEPTHBUF )
        // Matches three's logdepthbuf_fragment chunk. First statement so the
        // depth write is unconditional for every fragment that survives.
        gl_FragDepth = vIsPerspective == 0.0 ? gl_FragCoord.z : log2( vFragDepth ) * logDepthBufFC * 0.5;
#endif
        float age = uTime - vBirth;
        if (age < 0.0 || age > TTL) discard;
        float a = texture2D(uMap, vUv * vUvRect.zw + vUvRect.xy).a;
        // fresh blood glistens (lighter core), dried blood darkens to brown
        float dry = clamp(age / DRY, 0.0, 1.0);
        vec3 fresh = vTint;
        vec3 dried = vTint * vec3(0.32, 0.20, 0.16);
        vec3 col = mix(fresh, dried, dry);
        float fadeIn = clamp(age / 0.12, 0.0, 1.0);
        float fadeOut = 1.0 - clamp((age - (TTL - 45.0)) / 45.0, 0.0, 1.0);
        float alpha = a * fadeIn * fadeOut * 0.92;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(col, alpha);
      }`,
    transparent: true,
    depthWrite: false,
    // Only live when the renderer is NOT on a log-depth buffer (see the shader
    // note above): a shader-written gl_FragDepth bypasses polygon offset.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.InstancedMesh(geom, mat, BLOOD_MAX_DECALS);
  mesh.name = "blood-decals";
  mesh.frustumCulled = false;
  mesh.count = 0;
  mesh.renderOrder = 10;
  mesh.layers.set(1); // render wherever entities render (outdoor + interior passes)
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Ageing clock. Driven from onBeforeRender rather than a parallel rAF: the
  // uniform only has to be current for the frame that actually DRAWS the mesh,
  // which makes it correct on the very first stamped frame (a rAF races the
  // render and leaves `age` negative → `discard` for one frame) and keeps it
  // working under ?renderOnDemand=1 / ?targetFps=N, where a self-rearming rAF
  // burns a callback per vsync for stains nobody is drawing. Called once per
  // pass, so it is also correct across the indoor world/cells split.
  mesh.onBeforeRender = () => {
    uTime.value = _nowS();
  };
  // Decoration only — never let a stain win a hover/target pick from the
  // entity underneath it (picking raycasts entitiesGroup on layer 1 too).
  mesh.raycast = () => {};
  return { mesh, geom, mat, uTime, birth, uvRect, tint, cursor: 0 };
}

function _ensurePool() {
  if (_pool) return _pool;
  const group = window.liveScene3d?.entitiesGroup;
  if (!group) {
    if (!_warnedNoScene) {
      _warnedNoScene = true;
      // eslint-disable-next-line no-console
      console.warn("[blood] no liveScene3d.entitiesGroup yet — stamp dropped");
    }
    return null;
  }
  _pool = _buildPool();
  group.add(_pool.mesh);
  // eslint-disable-next-line no-console
  console.info("[blood] decal pool attached to entitiesGroup (cap", BLOOD_MAX_DECALS + ")");
  return _pool;
}

const _m4 = [];
function _stamp(acPos, normal, size, variant, tintScale) {
  const pool = _ensurePool();
  if (!pool) return false;
  const i = pool.cursor;
  pool.cursor = (pool.cursor + 1) % BLOOD_MAX_DECALS;
  if (pool.mesh.count < BLOOD_MAX_DECALS) pool.mesh.count = Math.max(pool.mesh.count, i + 1);
  const { quat, scale } = stampOrientation(normal, size);
  const tiles = VARIANT_TILES[variant] || VARIANT_TILES.floor;
  const tileIdx = tiles[(Math.random() * tiles.length) | 0];
  const tu = (tileIdx % ATLAS_COLS) / ATLAS_COLS;
  // Texture.flipY defaults TRUE, so canvas row 0 (drawn at the TOP) lands at
  // the HIGH end of v. Row r therefore starts at v = 1 - (r+1)/ROWS, not
  // r/ROWS — without this the two atlas rows are silently swapped (tile 3's
  // light wall streak drew tile 7's heavy one, floor blots drew spatter, …).
  // The remaining within-tile vertical mirror is WANTED: the wall streaks are
  // painted head-at-top / drips-downward in canvas space, and stampOrientation
  // aligns the quad's local +Y (= increasing v) with world up.
  const tv = 1 - (((tileIdx / ATLAS_COLS) | 0) + 1) / ATLAS_ROWS;
  pool.uvRect.setXYZW(i, tu, tv, 1 / ATLAS_COLS, 1 / ATLAS_ROWS);
  const r = (0.45 + Math.random() * 0.2) * tintScale;
  pool.tint.setXYZ(i, r, r * 0.06, r * 0.05);
  pool.birth.setX(i, _nowS());
  // compose instance matrix: T * R * S, offset 1.5cm along the normal
  const [qx, qy, qz, qw] = quat;
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  const sx = scale[0], sy = scale[1];
  const m = _m4;
  m[0] = (1 - (yy + zz)) * sx; m[1] = (xy + wz) * sx; m[2] = (xz - wy) * sx; m[3] = 0;
  m[4] = (xy - wz) * sy; m[5] = (1 - (xx + zz)) * sy; m[6] = (yz + wx) * sy; m[7] = 0;
  m[8] = xz + wy; m[9] = yz - wx; m[10] = 1 - (xx + yy); m[11] = 0;
  m[12] = acPos[0] + normal[0] * 0.015;
  m[13] = acPos[1] + normal[1] * 0.015;
  m[14] = acPos[2] + normal[2] * 0.015;
  m[15] = 1;
  pool.mesh.instanceMatrix.array.set(m, i * 16);
  pool.mesh.instanceMatrix.needsUpdate = true;
  pool.birth.needsUpdate = true;
  pool.uvRect.needsUpdate = true;
  pool.tint.needsUpdate = true;
  // Keep the clock sane for anything that reads it before the next draw
  // (diag, a stamp landing between passes). onBeforeRender owns it otherwise.
  pool.uTime.value = _nowS();
  if (_totalStamped++ === 0) {
    // eslint-disable-next-line no-console
    console.info("[blood] first decal stamped");
  }
  return true;
}

/* ── raycasting placement ────────────────────────────────────────────── */

let _ray = null;
let _scratch = null;
function _getScratch() {
  if (!_scratch) {
    _ray = new THREE.Raycaster();
    _ray.layers.enable(1); // cells live on layer 1 (picking.js trap)
    _scratch = {
      origin: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      sphere: new THREE.Sphere(),
      inv: new THREE.Matrix4(),
      nrm: new THREE.Matrix3(),
      v: new THREE.Vector3(),
      n: new THREE.Vector3(),
      targets: [],
    };
  }
  return _scratch;
}

function _collectTargets(centerW, groups) {
  const s = _getScratch();
  s.targets.length = 0;
  let visits = 0;
  const visit = (o) => {
    if (visits++ > MAX_SCENE_VISITS || s.targets.length >= MAX_RAY_TARGETS) return;
    if (o.isMesh && o.geometry) {
      // InstancedMesh / BatchedMesh carry their OWN boundingSphere spanning
      // every instance / batched draw; the shared `geometry.boundingSphere` is
      // just one un-instanced copy sitting at the local origin, so using it
      // would cull away every animated-scenery trunk that isn't at the group
      // origin. Prefer the object sphere whenever the object defines one.
      let bs = null;
      try {
        if (o.isInstancedMesh || o.isBatchedMesh) {
          if (!o.boundingSphere) o.computeBoundingSphere();
          bs = o.boundingSphere;
        }
        if (!bs) {
          if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
          bs = o.geometry.boundingSphere;
        }
      } catch (_e) {
        return;
      }
      if (bs) {
        s.sphere.copy(bs).applyMatrix4(o.matrixWorld);
        if (s.sphere.center.distanceTo(centerW) - s.sphere.radius < BLOOD_RANGE_M + 4) {
          s.targets.push(o);
        }
      }
      return;
    }
    const kids = o.children;
    for (let i = 0; i < kids.length && visits < MAX_SCENE_VISITS; i++) visit(kids[i]);
  };
  for (const g of groups) if (g) visit(g);
  return s.targets;
}

function _terrainHeightAt(x, y) {
  try {
    const sh = window.liveScene3d?.sessionHandle || window.__sessionHandle;
    const h = sh?.terrainHeightAt?.(x, y);
    return typeof h === "number" && Number.isFinite(h) ? h : null;
  } catch (_e) {
    return null;
  }
}

/** Trust the analytic terrain oracle as "this IS the surface under me" within
 *  this many metres. Same tolerance `addPool` and `__diag.blood.test` use. */
export const BLOOD_TERRAIN_TRUST_M = 2.5;

/**
 * Is this entity indoors RIGHT NOW?
 *
 * 2026-08-03 — this used to be `(inst._outdoorCellIdx ?? inst._cellIdx ?? 0)`
 * alone. Two problems, both verified by grep over the whole tree:
 *   * `_cellIdx` does not exist. Nothing ever writes it.
 *   * `_outdoorCellIdx` has exactly ONE writer, `entities.js:4551`, inside the
 *     ObjectCreate spawn path — it is a SPAWN-TIME STAMP, never refreshed,
 *     despite that line's own comment claiming position updates re-read it.
 *     The position-update seam (`entities.js:5969`) receives world-folded
 *     x/y/z with no landcell at all, so there is nothing there to refresh it
 *     WITH; a stamp-refresh fix would mean plumbing a new field down the wire
 *     path. Hence the live read below rather than a stamp refresh.
 * A creature that spawned in a cottage and was killed on the lawn therefore
 * read "indoor" forever: no terrain fallback, no statics in the ray targets,
 * and a ceiling ray it can never hit — outdoor kills of indoor-spawned mobs
 * left no blood on the ground at all.
 *
 * The live test is the one this file already trusts twice (`addPool`,
 * `__diag.blood.test`): if the body is sitting ON the analytic terrain
 * surface, it is outdoors — nothing else puts you within 2.5 m of your own
 * terrain column. Off it by more ⇒ dungeon, cottage floor, bridge or rooftop,
 * all of which want the indoor treatment. The stamp survives only as the
 * fallback for when the oracle cannot answer (no session handle, LB not
 * streamed). One oracle call per hit, already inside the 30/s budget.
 *
 * @param {object} inst  EntityInstance.
 * @param {(x:number,y:number)=>number|null} [terrainAt]  injectable for tests.
 */
export function resolveIndoor(inst, terrainAt = _terrainHeightAt) {
  const cellIdx = (inst?._outdoorCellIdx ?? inst?._cellIdx ?? 0) >>> 0;
  const stamped = (cellIdx & 0xffff) >= 0x0100;
  const p = inst?.root?.position;
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
    return stamped;
  }
  let th = null;
  try { th = terrainAt(p.x, p.y); } catch (_e) { th = null; }
  if (typeof th !== "number" || !Number.isFinite(th)) return stamped;
  return Math.abs(p.z - th) > BLOOD_TERRAIN_TRUST_M;
}

/**
 * Stamp blood from one hit. `woundAC` = [x,y,z] wound point, `quadDir` =
 * horizontal unit direction the spray travels (away from the attacker).
 */
function _splatterFromHit(inst, woundAC, quadDir, crit) {
  const live = window.liveScene3d;
  const group = live?.entitiesGroup;
  if (!group) return 0;
  const s = _getScratch();
  const indoor = resolveIndoor(inst);
  const rays = makeRayFan(quadDir, crit ? BLOOD_RAYS_CRIT : BLOOD_RAYS_HIT, indoor, crit);

  // entitiesGroup local (AC) → world for the raycaster
  group.updateWorldMatrix(true, false);
  const groupMat = group.matrixWorld;
  s.inv.copy(groupMat).invert();
  s.nrm.getNormalMatrix(s.inv);

  const groups = indoor
    ? [live.cellsGroup, live.buildingsGroup]
    : [live.buildingsGroup, live.staticsGroup, live.cellsGroup];
  const originW = s.origin.set(woundAC[0], woundAC[1], woundAC[2]).applyMatrix4(groupMat);
  const targets = _collectTargets(originW, groups);

  let stamped = 0;
  for (const rd of rays) {
    s.origin.set(woundAC[0], woundAC[1], woundAC[2]).applyMatrix4(groupMat);
    s.dir.set(rd[0], rd[1], rd[2]).transformDirection(groupMat);
    _ray.set(s.origin, s.dir);
    _ray.far = BLOOD_RANGE_M;
    let hit = null;
    if (targets.length) {
      const hits = _ray.intersectObjects(targets, false);
      if (hits.length) hit = hits[0];
    }
    if (hit) {
      // world hit → AC frame
      s.v.copy(hit.point).applyMatrix4(s.inv);
      const wn = hit.face ? s.n.copy(hit.face.normal).transformDirection(hit.object.matrixWorld) : s.n.set(0, 1, 0);
      // world normal → AC frame
      wn.applyMatrix3(s.nrm).normalize();
      // flip toward the ray origin so the decal faces outward
      if (wn.x * rd[0] + wn.y * rd[1] + wn.z * rd[2] > 0) wn.multiplyScalar(-1);
      const dist = hit.distance;
      const size = (crit ? 0.5 : 0.34) * (1 - dist / (BLOOD_RANGE_M * 1.6)) * (0.8 + Math.random() * 0.5);
      if (_stamp([s.v.x, s.v.y, s.v.z], [wn.x, wn.y, wn.z], Math.max(0.12, size),
        wn.z > 0.6 ? "floor" : wn.z < -0.6 ? "ceiling" : "wall", 1)) stamped++;
    } else if (!indoor && rd[2] < -0.05) {
      // outdoor down-ray that missed all meshes → terrain (analytic)
      const t = Math.min(BLOOD_RANGE_M, (woundAC[2] - (_terrainHeightAt(woundAC[0], woundAC[1]) ?? woundAC[2])) / Math.max(0.1, -rd[2]) + 1.2);
      const gx = woundAC[0] + rd[0] * t;
      const gy = woundAC[1] + rd[1] * t;
      const gz = _terrainHeightAt(gx, gy);
      if (gz !== null && woundAC[2] - gz < 12) {
        // terrain normal from height samples
        const e = 0.35;
        const hx1 = _terrainHeightAt(gx + e, gy) ?? gz;
        const hx0 = _terrainHeightAt(gx - e, gy) ?? gz;
        const hy1 = _terrainHeightAt(gx, gy + e) ?? gz;
        const hy0 = _terrainHeightAt(gx, gy - e) ?? gz;
        let nx = (hx0 - hx1) / (2 * e);
        let ny = (hy0 - hy1) / (2 * e);
        const nl = Math.hypot(nx, ny, 1);
        const size = (crit ? 0.5 : 0.32) * (0.8 + Math.random() * 0.6);
        if (_stamp([gx, gy, gz], [nx / nl, ny / nl, 1 / nl], size, "floor", 1)) stamped++;
      }
    }
  }
  return stamped;
}

/** Pool under a settled body / big severed piece. Exposed via window.__bloodPools. */
export function addPool(acX, acY, acZ, radius = 0.6) {
  if (!bloodEnabled()) return false;
  const live = window.liveScene3d;
  if (!live?.entitiesGroup) return false;
  let z = acZ;
  const th = _terrainHeightAt(acX, acY);
  if (th !== null && Math.abs(th - acZ) < 2.5) z = th;
  const size = Math.min(1.6, Math.max(0.5, radius * 1.6));
  return _stamp([acX, acY, z], [0, 0, 1], size, "pool", 0.85);
}

/* ── event wiring ────────────────────────────────────────────────────── */

let _installed = false;
let _bound = false;
let _budget = { windowStart: 0, used: 0 };
const _critByName = new Map();

function _underBudget() {
  const now = performance.now();
  if (now - _budget.windowStart > 1000) {
    _budget.windowStart = now;
    _budget.used = 0;
  }
  return _budget.used++ < BLOOD_EVENTS_PER_SEC;
}

function _bodyMetrics(inst) {
  // cheap cached body height from part rest z span (fallback 1.6m)
  if (inst.__bloodH) return inst.__bloodH;
  let lo = Infinity;
  let hi = -Infinity;
  const parts = inst.parts || [];
  for (const p of parts) {
    lo = Math.min(lo, p.position.z);
    hi = Math.max(hi, p.position.z);
  }
  const h = Number.isFinite(hi - lo) && hi - lo > 0.2 ? hi - lo + 0.3 : 1.6;
  // Only cache a MEASURED height. Parts can still be empty on the first
  // splatter of a just-spawned entity; caching the 1.6 m fallback there would
  // pin every later hit on that creature to the wrong band for its lifetime.
  if (parts.length) inst.__bloodH = h;
  return h;
}

function _bind(decodeSplatterId) {
  const pc = window.__pluginClient;
  if (!pc?.events?.on) return false;
  pc.events.on("playEffect", ({ targetGuid, scriptId }) => {
    try {
      const d = decodeSplatterId(scriptId);
      if (!d || !_underBudget()) return;
      const em = window.liveScene3d?.entityManager;
      const inst = em?.entityMap?.get(Number(targetGuid) >>> 0);
      if (!inst?.root) return;
      const name = inst.meta?.name;
      const critTs = name ? _critByName.get(name) : undefined;
      const crit = critTs !== undefined && performance.now() - critTs < 3000;
      const h = _bodyMetrics(inst);
      const bandZ = [0.22, 0.5, 0.8][d.height] * h;
      // quadrant → horizontal dir in ENTITY space, rotated by entity yaw.
      // AC forward = +Y, left = -X.
      let lx = d.left ? -1 : 1;
      let ly = d.front ? 1 : -1;
      const l = Math.hypot(lx, ly);
      lx /= l;
      ly /= l;
      const q = inst.root.quaternion;
      const dir = _rotByQuat([q.x, q.y, q.z, q.w], [lx, ly, 0]);
      const dl = Math.hypot(dir[0], dir[1]) || 1;
      const quadDir = [dir[0] / dl, dir[1] / dl];
      const rp = inst.root.position;
      const wound = [rp.x + quadDir[0] * 0.25, rp.y + quadDir[1] * 0.25, rp.z + bandZ];
      _splatterFromHit(inst, wound, quadDir, crit);
    } catch (_e) { /* never break the shared bus */ }
  });
  pc.events.on("damageDealt", (dd) => {
    try {
      if (dd?.criticalHit && dd.defenderName) {
        _critByName.set(dd.defenderName, performance.now());
        if (_critByName.size > 32) _critByName.delete(_critByName.keys().next().value);
      }
    } catch (_e) { /* ignore */ }
  });
  _bound = true;
  return true;
}

/**
 * Lazy-loaded from scene3d/index.js on the DEFAULT path.
 *
 * `?blood` is DEFAULT-ON (owner flip 2026-08-02; url-flags.md:800). Both the
 * import gate (`scene3d/index.js:3840`) and `bloodEnabled()` above read
 * `!== "off"`, so an ABSENT param resolves ON — only `?blood=off` skips it.
 * (This line previously said "only when ?blood=on", contradicting both the
 * file header and the doc; that exact shape talked a reviewer into inverting
 * an owner decision earlier today, so it is corrected, not obeyed.)
 */
export async function installBloodDecals() {
  if (_installed || !bloodEnabled()) return;
  _installed = true;
  const { decodeSplatterId } = await import("./splatter_decode.js");
  let tries = 0;
  const attempt = () => {
    if (_bind(decodeSplatterId)) {
      // eslint-disable-next-line no-console
      console.info("[blood] armed — surface decals on, cap", BLOOD_MAX_DECALS);
      return;
    }
    // GIVE-UP IS LOUD (2026-08-03). The success arm logs "[blood] armed"; this
    // arm used to end the chain in silence after ~2 minutes, so a missing or
    // renamed `window.__pluginClient.events` left a DEFAULT-ON feature with no
    // splatter subscription and ZERO console evidence — `__diag.blood.stats()`
    // would report `bound: false` if anyone thought to look, which is exactly
    // what nobody does when a feature has simply never been seen working.
    // Pools (`window.__bloodPools`, installed below) are unaffected.
    if (++tries < 60) {
      setTimeout(attempt, 2000);
      return;
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[blood] gave up after ${tries} attempts (~${tries * 2}s): window.__pluginClient.events.on ` +
        "never appeared — no combat splatter will be observed (settled-body pools still work). " +
        "__diag.blood.stats().bound stays false.",
    );
  };
  attempt();
  window.__bloodPools = (x, y, z, r) => {
    try { addPool(x, y, z, r); } catch (_e) { /* ignore */ }
  };
  const diag = (window.__diag = window.__diag || {});
  diag.blood = {
    enabled: bloodEnabled,
    stats() {
      return {
        active: _pool?.mesh.count ?? 0,
        cap: BLOOD_MAX_DECALS,
        cursor: _pool?.cursor ?? 0,
        totalStamped: _totalStamped,
        bound: _bound,
        pooled: !!_pool,
        // Sanity surface for the "nothing renders" class of bug: if `pooled`
        // is true and `active` > 0 but you see no stains, the mesh is being
        // drawn and the problem is depth/blend, not placement.
        inScene: !!_pool && _pool.mesh.parent === window.liveScene3d?.entitiesGroup,
        uTime: _pool?.uTime.value ?? 0,
      };
    },
    clear() {
      if (_pool) {
        _pool.birth.array.fill(-1e9);
        _pool.birth.needsUpdate = true;
        _pool.mesh.count = 0;
        _pool.cursor = 0;
      }
      return true;
    },
    /** Ring of test stains around the local player for eyeballing. */
    test(n = 12) {
      const em = window.liveScene3d?.entityManager;
      // getLocalPlayerWorldPos() is AC-frame (it reads inst.root.position) and
      // survives the eager-WorldState path where the local player never gets a
      // 3D rig — the raw entityMap read below does not, so it is only a
      // fallback. Both are entitiesGroup-local, which is what _stamp wants.
      const rp = em?.getLocalPlayerWorldPos?.()
        ?? em?.entityMap?.get(window.getLocalPlayerGuid?.() >>> 0)?.root?.position;
      if (!rp) return { error: "no local player position", stats: diag.blood.stats() };
      let ok = 0;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const gx = rp.x + Math.cos(a) * 1.8;
        const gy = rp.y + Math.sin(a) * 1.8;
        // Indoors the analytic oracle still answers with the OUTDOOR terrain
        // height under the dungeon, which would drop the ring tens of metres
        // below the floor you are standing on. Only trust it when it is
        // plausibly the surface the player is on (same guard as addPool).
        const th = _terrainHeightAt(gx, gy);
        const gz = th !== null && Math.abs(th - rp.z) < 2.5 ? th : rp.z;
        if (_stamp([gx, gy, gz + 0.01], [0, 0, 1], 0.4, "floor", 1)) ok++;
      }
      return { stamped: ok, at: [rp.x, rp.y, rp.z], stats: diag.blood.stats() };
    },
  };
}

// scene3d/drone/props.js — Drone Deploy (2026-10-24; DEFAULT ON since 2026-10-25, `?drone=off` disables it).
//
// The three procedural props — the brass-and-iron camera drone, the pilot's
// tablet and the FPV goggles — their placement on the pilot's rig or in the
// world, the per-frame rotor / LED / blob-shadow / fade animation, the tablet's
// CanvasTexture screen, and the one-time shader prewarm. Contract:
// scene3d/drone/SPEC.md §3.2 (exports, model conventions, look and cost rules,
// prewarm, the props member table), §6.11 (attach rules), §2.1 (frames: AC world
// under `droneGroup`, part-local anchors in rig object space), DV-22 / DV-23 /
// DV-24 / DV-25.
//
// THREE is injected (no import of any kind: the page passes the import-map
// instance, node tests pass node_modules three r184). Cost rules (binding):
//   * stock MeshStandardMaterial / MeshBasicMaterial only — no ShaderMaterial,
//     onBeforeCompile or customProgramCacheKey; NO Light objects (LEDs, crystal
//     and screen are unlit MeshBasic); every material is created with its FINAL
//     map and no program-relevant field ever changes at runtime (per-frame
//     animation touches uniforms — opacity, the blur map's uv rotation — node
//     visibility, transforms, and two tiny attributes re-uploaded whole (the
//     blades while they spin up, ≈16 KB; the rear-LED uvs at the 1 Hz edges) —
//     whole, because three's `addUpdateRange` allocates per call;
//   * the five materials are program-key twins of the login-idle archetype warm
//     (bake_prewarm.js): `{map, DoubleSide}` MeshStandard for the metal (brass /
//     iron / copper / leather and the goggles' dark lens glass come from a 16×1
//     palette texture via uv), `{map, transparent, depthWrite: false}` MeshBasic
//     for the glow parts, the screen, the rotor blur and the blob shadow;
//     `prewarm` compiles the same set for the composer variant anyway, plus a
//     twin of the film lens overlay's material (angle / acro FPV) for the canvas;
//   * geometry merged per material per prop with a local helper (no
//     three/addons): drone 4 meshes (body + blades, glow, blur discs, blob),
//     tablet 2, goggles 2; every node on layer 1 only, no shadows, no-op raycast,
//     default frustum culling, no `__disposable` / `__cacheOwned` anywhere.
// The fade (`fadeOut`) is a scale-out toward the feet plus the blob's opacity:
// no material swap, nothing to prebuild.

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

/** The three props, in index order. */
export const PROP_NAMES = Object.freeze(["drone", "tablet", "goggles"]);

/**
 * Drone body facts shared with the flight code: overall span 0.32 m, the body
 * centre sits `restHeightM` above the ground when landed (feet at z = −0.06 in
 * the body frame), `radiusM` is the collision sphere (world_link `safetyBody`).
 */
export const DRONE_BODY = Object.freeze({ spanM: 0.32, restHeightM: 0.06, radiusM: 0.18 });

/**
 * Default prop anchors in the part-local frame of the anchor part (rig object
 * space, metres before the rig root scale; quat `[w, x, y, z]`). DAT-derived and
 * checked on the 1070 with placeholder boxes (PLAN §5.3); tuned per setup by
 * `__drone.tune` / data/drone-rig-profiles.json. `droneInHand.quat` is
 * q15(Pickup 0x03000247 source frame 18)⁻¹ ⊗ Rz(π) from fixtures/drone/anims.json:
 * at the place clip's release frame the drone is already level and facing the
 * pilot, so `toWorld`'s level snap moves it 0° (the grip frame's 90° about x
 * snapped it 58°); it rides ≈25° tilted at the side, on its side at the shoulder.
 */
export const DEFAULT_ANCHORS = Object.freeze({
  droneInHand: Object.freeze({ pos: Object.freeze([0.025, 0, -0.076]), quat: Object.freeze([0.932351, 0.304211, 0.142447, -0.13374]) }),
  tablet: Object.freeze({ pos: Object.freeze([-0.105, -0.035, -0.143]), quat: Object.freeze([-0.509, 0.062, -0.685, 0.518]) }),
  goggles: Object.freeze({ pos: Object.freeze([0, -0.10, 0.085]), quat: Object.freeze([1, 0, 0, 0]), scale: 1 }),
});

/** The rig anchor (a RigProfile field) each prop attaches to by default. */
export const ANCHOR_OF = Object.freeze({ drone: "rightHand", tablet: "leftHand", goggles: "head" });

/** The `DEFAULT_ANCHORS` / Anchors key of each prop's offsets. */
export const ANCHOR_KEY = Object.freeze({ drone: "droneInHand", tablet: "tablet", goggles: "goggles" });

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const DRONE = 0;
const TABLET = 1;
const GOGGLES = 2;
const ANCHOR_NAMES = Object.freeze(["rightHand", "leftHand", "head"]);
const ANCHOR_KEYS = Object.freeze(["droneInHand", "tablet", "goggles"]);

const SCREEN_W = 256;
const SCREEN_H = 160;
const BLUR_ABOVE_SPIN = 0.3; // two-blade rotors at or below, translucent blur discs above
const BLADE_REV_PER_SPIN = 40; // visible blade revolutions per second per unit spin
const BLUR_RAD_PER_SPIN = 9; // blur-disc shimmer (uv rotation) per unit spin
// Blur discs: a translucent smoke, never an opaque plate (1070 V2). The texture's
// alpha peaks (1) on the outer band's lobes and falls toward an empty hub; the
// material opacity runs 0.7–1 × BLUR_OPACITY with spin, so the peak stays ≤ 0.35.
const BLUR_OPACITY = 0.35;
const BLUR_GREY = 0x70; // neutral grey texels
const BLOB_OPACITY = 0.55;
const BLOB_LIFT_M = 0.03; // above the ground (no polygonOffset: reversed-Z, DV-24)
const BLOB_FADE_AGL_M = 3; // opacity ∝ max(0, 1 − AGL / 3)
const MAX_SPIN = 2.5;
const MAX_DT = 0.1;

// Drone geometry (body frame: +x right, +y forward (the camera end), +z up).
const ARM_R = 0.105; // motor distance from the centre
const MOTOR_A = ARM_R / Math.SQRT2; // motor x / y offset (X frame)
const PROP_R = 0.052;
const ROTOR_Z = 0.03;
// Motor order: FL, FR, RL, RR; diagonal pairs spin the same way.
const MOTOR_X = Object.freeze([-MOTOR_A, MOTOR_A, -MOTOR_A, MOTOR_A]);
const MOTOR_Y = Object.freeze([MOTOR_A, MOTOR_A, -MOTOR_A, -MOTOR_A]);
const SPIN_DIR = Object.freeze([-1, 1, 1, -1]);
const BLADE_PHASE = Object.freeze([0, Math.PI / 3, Math.PI / 6, Math.PI / 2]);

// The 16×1 palette (sRGB). Metal entries feed MeshStandard (lit), glow entries
// MeshBasic (unlit, "emissive").
const PALETTE = Object.freeze([
  0xc8963e, // 0 brass
  0x8a6428, // 1 dark brass
  0x4a4d55, // 2 iron
  0x26272c, // 3 dark iron
  0xb06a3a, // 4 copper
  0x4b3322, // 5 leather
  0x141414, // 6 rubber
  0x0d0d10, // 7 bezel black
  0x6ff0ff, // 8 mana crystal
  0xffffff, // 9 LED white
  0xff3020, // 10 LED red (on)
  0x3a0806, // 11 LED red (off)
  0x0e2128, // 12 goggle lens: dark tinted glass on the lit metal (no glow; 1070 V3)
  0xff1a1a, // 13 REC pip
  0x2bb5ff, // 14 crystal core
  0xe8e8e8, // 15 spare
]);
const P = Object.freeze({
  BRASS: 0, DARK_BRASS: 1, IRON: 2, DARK_IRON: 3, COPPER: 4, LEATHER: 5, RUBBER: 6, BEZEL: 7,
  CRYSTAL: 8, LED_WHITE: 9, LED_RED: 10, LED_OFF: 11, LENS: 12, REC: 13, CRYSTAL_CORE: 14,
});
const palU = (i) => (i + 0.5) / PALETTE.length;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const _warned = new Set();
function defaultLog(entry) {
  if (!entry || entry.level !== "warn") return;
  const m = String(entry.message ?? "");
  if (_warned.has(m)) return;
  _warned.add(m);
  try {
    // eslint-disable-next-line no-console
    console.warn("[drone] " + m);
  } catch (_) { /* no console */ }
}

function noRaycast() {}

// SPEC §6.11, exact.
function stampRigProp(root, pilotGuid) {
  root.userData.__attachedChildOf = pilotGuid >>> 0;   // _isAttachedChildNode: survives part-content swaps; rig dispose prunes here
  root.traverse((o) => { o.layers.set(1); o.castShadow = false; o.receiveShadow = false; if (o.isMesh) o.raycast = noRaycast; });
  return root;
}

// The same stamp minus the rig brand: layer 1 only, no shadows, no-op raycast.
function stampNode(root) {
  root.traverse((o) => { o.layers.set(1); o.castShadow = false; o.receiveShadow = false; if (o.isMesh) o.raycast = noRaycast; });
  return root;
}

function finiteVec(v, n) {
  if (!v || typeof v.length !== "number" || v.length !== n) return null;
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const x = +v[i];
    if (!Number.isFinite(x)) return null;
    out[i] = x;
  }
  return out;
}

function unitQuat(v) {
  const q = finiteVec(v, 4);
  if (!q) return null;
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(n > 1e-9)) return null;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

// A validated, mutable copy of an Anchors object; anything missing or invalid
// falls back to DEFAULT_ANCHORS per anchor, per field. Unknown keys (e.g. a
// tune profile's `clipMode`) are ignored.
function anchorsFrom(src) {
  const out = {};
  for (const key of ANCHOR_KEYS) {
    const def = DEFAULT_ANCHORS[key];
    const a = src && typeof src === "object" && src[key] && typeof src[key] === "object" ? src[key] : null;
    const entry = {
      pos: finiteVec(a?.pos, 3) ?? def.pos.slice(),
      quat: unitQuat(a?.quat) ?? unitQuat(def.quat),
    };
    if (key === "goggles") {
      const s = +a?.scale;
      entry.scale = Number.isFinite(s) && s > 0 ? s : def.scale;
    }
    out[key] = entry;
  }
  return out;
}

function xf(THREE, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  const m = new THREE.Matrix4();
  m.compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
  return m;
}

/**
 * Merge primitive parts into one indexed geometry (position, normal, uv). A
 * part `{geom, m?, pal?, uv?: 'keep'|'mirrorU', key?}`: `m` places it, `pal`
 * points every uv at that palette texel, `uv: 'keep'` keeps the primitive's uvs
 * (textured parts), `'mirrorU'` keeps them mirrored. The primitives are disposed.
 * Returns the geometry and the vertex range of every keyed part.
 */
function mergeParts(THREE, parts) {
  let vCount = 0;
  let iCount = 0;
  for (const p of parts) {
    const g = p.geom;
    vCount += g.attributes.position.count;
    iCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vCount * 3);
  const nrm = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const idx = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
  const ranges = {};
  const v = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    const g = p.geom;
    const P3 = g.attributes.position;
    const N3 = g.attributes.normal;
    const U2 = g.attributes.uv;
    if (p.m) nm.getNormalMatrix(p.m);
    for (let i = 0; i < P3.count; i += 1) {
      const o = (vo + i) * 3;
      v.fromBufferAttribute(P3, i);
      if (p.m) v.applyMatrix4(p.m);
      pos[o] = v.x; pos[o + 1] = v.y; pos[o + 2] = v.z;
      if (N3) {
        v.fromBufferAttribute(N3, i);
        if (p.m) v.applyMatrix3(nm).normalize();
      } else {
        v.set(0, 0, 1);
      }
      nrm[o] = v.x; nrm[o + 1] = v.y; nrm[o + 2] = v.z;
      const t = (vo + i) * 2;
      if (p.pal !== undefined && p.pal !== null) {
        uv[t] = palU(p.pal);
        uv[t + 1] = 0.5;
      } else if (U2) {
        const u = U2.getX(i);
        uv[t] = p.uv === "mirrorU" ? 1 - u : u;
        uv[t + 1] = U2.getY(i);
      }
    }
    if (g.index) {
      for (let j = 0; j < g.index.count; j += 1) idx[io + j] = g.index.getX(j) + vo;
      io += g.index.count;
    } else {
      for (let j = 0; j < P3.count; j += 1) idx[io + j] = vo + j;
      io += P3.count;
    }
    if (p.key) ranges[p.key] = { start: vo, count: P3.count };
    vo += P3.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return { geometry: out, ranges };
}

// --- textures (deterministic, procedural; no RNG) ---------------------------

function paletteTexture(THREE) {
  const data = new Uint8Array(PALETTE.length * 4);
  for (let i = 0; i < PALETTE.length; i += 1) {
    const c = PALETTE[i];
    data[i * 4] = (c >> 16) & 0xff;
    data[i * 4 + 1] = (c >> 8) & 0xff;
    data[i * 4 + 2] = c & 0xff;
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, PALETTE.length, 1, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.name = "drone-palette";
  t.needsUpdate = true;
  return t;
}

function smooth01(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function blobTexture(THREE) {
  const n = 32;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const dx = (x + 0.5) / n * 2 - 1;
      const dy = (y + 0.5) / n * 2 - 1;
      const r = Math.hypot(dx, dy);
      const a = r >= 1 ? 0 : Math.pow(1 - r, 1.6);
      const o = (y * n + x) * 4;
      data[o] = 0; data[o + 1] = 0; data[o + 2] = 0;
      data[o + 3] = Math.round(255 * a);
    }
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.name = "drone-blob";
  t.needsUpdate = true;
  return t;
}

function blurTexture(THREE) {
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const dx = (x + 0.5) / n * 2 - 1;
      const dy = (y + 0.5) / n * 2 - 1;
      const r = Math.hypot(dx, dy);
      const th = Math.atan2(dy, dx);
      // two smeared blade lobes over a steady haze, densest in the outer band and
      // fainter toward an empty hub; the rim has faded out by r 0.92, inside the
      // octagon's edge midpoints (cos 22.5°), so the disc reads round
      const lobes = 0.55 + 0.45 * Math.pow(0.5 + 0.5 * Math.cos(2 * th), 2);
      const band = 0.35 + 0.65 * smooth01(0.2, 0.75, r);
      const a = r >= 1 ? 0 : lobes * band * (1 - smooth01(0.78, 0.92, r)) * smooth01(0.1, 0.24, r);
      const o = (y * n + x) * 4;
      data[o] = BLUR_GREY; data[o + 1] = BLUR_GREY; data[o + 2] = BLUR_GREY;
      data[o + 3] = Math.round(255 * Math.min(1, a));
    }
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.center.set(0.5, 0.5); // the shimmer rotates the uvs about the disc centre
  t.name = "drone-blur";
  t.needsUpdate = true;
  return t;
}

function pixelTexture(THREE, rgba, name) {
  const t = new THREE.DataTexture(new Uint8Array(rgba), 1, 1, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.name = name;
  t.needsUpdate = true;
  return t;
}

/**
 * THE material factory — `createProps` and `prewarm` both build from it, so the
 * prewarmed program keys are the live ones. Every material gets its final map.
 */
function buildMaterials(THREE, maps) {
  return {
    metal: new THREE.MeshStandardMaterial({
      name: "drone-metal", map: maps.palette, roughness: 0.42, metalness: 0.55, side: THREE.DoubleSide,
    }),
    glow: new THREE.MeshBasicMaterial({ name: "drone-glow", map: maps.palette, transparent: true, depthWrite: false }),
    screen: new THREE.MeshBasicMaterial({ name: "drone-screen", map: maps.screen, transparent: true, depthWrite: false }),
    blur: new THREE.MeshBasicMaterial({
      name: "drone-blur", map: maps.blur, transparent: true, depthWrite: false, opacity: BLUR_OPACITY,
    }),
    blob: new THREE.MeshBasicMaterial({
      name: "drone-blob", map: maps.blob, transparent: true, depthWrite: false, opacity: BLOB_OPACITY,
    }),
  };
}

// --- models ------------------------------------------------------------------

const R90 = Math.PI / 2;

function droneGeometries(THREE) {
  const box = (w, d, h) => new THREE.BoxGeometry(w, d, h);
  // CylinderGeometry's axis is +y (the body's forward axis); R90 about x stands it on +z.
  const cyl = (r, h, seg, open = false) => new THREE.CylinderGeometry(r, r, h, seg, 1, open);
  const body = [];
  // hub, plates, camera hood (axis +y, open), antenna tilted 20° back, its tip
  body.push({ geom: box(0.064, 0.1, 0.032), pal: P.IRON });
  body.push({ geom: box(0.07, 0.085, 0.006), m: xf(THREE, 0, 0, 0.019), pal: P.BRASS });
  body.push({ geom: box(0.06, 0.08, 0.005), m: xf(THREE, 0, 0, -0.0185), pal: P.DARK_BRASS });
  body.push({ geom: cyl(0.019, 0.018, 10, true), m: xf(THREE, 0, 0.058, -0.002), pal: P.BRASS });
  body.push({ geom: cyl(0.002, 0.04, 4, true), m: xf(THREE, 0, -0.045, 0.04, R90 + 0.35, 0, 0), pal: P.IRON });
  body.push({ geom: new THREE.OctahedronGeometry(0.005, 0), m: xf(THREE, 0, -0.052, 0.058), pal: P.BRASS });
  for (let i = 0; i < 4; i += 1) {
    const mx = MOTOR_X[i];
    const my = MOTOR_Y[i];
    const ang = Math.atan2(my, mx);
    // arm (centre to motor), motor bell, leg + foot (the foot's underside is z = −restHeightM)
    body.push({ geom: box(ARM_R, 0.014, 0.008), m: xf(THREE, mx / 2, my / 2, 0.006, 0, 0, ang), pal: P.BRASS });
    body.push({ geom: cyl(0.013, 0.018, 8), m: xf(THREE, mx, my, 0.016, R90, 0, 0), pal: P.COPPER });
    body.push({ geom: cyl(0.0035, 0.05, 5, true), m: xf(THREE, mx, my, -0.029, R90, 0, 0), pal: P.IRON });
    body.push({ geom: box(0.012, 0.012, 0.006), m: xf(THREE, mx, my, -0.057), pal: P.RUBBER });
  }
  // the four two-blade props LAST: their vertices are rotated / collapsed on the CPU
  for (let i = 0; i < 4; i += 1) {
    body.push({ geom: box(2 * PROP_R, 0.011, 0.0025), m: xf(THREE, MOTOR_X[i], MOTOR_Y[i], ROTOR_Z), pal: P.DARK_IRON, key: "blade" + i });
  }
  const glow = [];
  // the mana crystal (camera) at the +y end, front LEDs white, rear LEDs red (blink)
  glow.push({ geom: new THREE.OctahedronGeometry(0.017, 0), m: xf(THREE, 0, 0.068, -0.002, 0, 0, 0, 0.8, 1.35, 0.8), pal: P.CRYSTAL });
  glow.push({ geom: new THREE.OctahedronGeometry(0.008, 0), m: xf(THREE, 0, 0.05, -0.002), pal: P.CRYSTAL_CORE });
  const ledAt = (i) => {
    const k = 1 + 0.017 / ARM_R; // just outside the motor bell, on the arm line
    return xf(THREE, MOTOR_X[i] * k, MOTOR_Y[i] * k, 0.006);
  };
  glow.push({ geom: box(0.007, 0.007, 0.007), m: ledAt(0), pal: P.LED_WHITE });
  glow.push({ geom: box(0.007, 0.007, 0.007), m: ledAt(1), pal: P.LED_WHITE });
  glow.push({ geom: box(0.007, 0.007, 0.007), m: ledAt(2), pal: P.LED_RED, key: "ledRear0" });
  glow.push({ geom: box(0.007, 0.007, 0.007), m: ledAt(3), pal: P.LED_RED, key: "ledRear1" });
  // blur discs: one up-facing and one down-facing octagon per rotor (FrontSide
  // twins); the octagon's inner radius still covers the blade tips, and its
  // corners stay inside the 0.18 m collision sphere (square quads did not)
  const blur = [];
  const discR = PROP_R + 0.006;
  for (let i = 0; i < 4; i += 1) {
    const uvMode = SPIN_DIR[i] < 0 ? "mirrorU" : "keep";
    blur.push({ geom: new THREE.CircleGeometry(discR, 8), m: xf(THREE, MOTOR_X[i], MOTOR_Y[i], ROTOR_Z + 0.0015), uv: uvMode });
    blur.push({ geom: new THREE.CircleGeometry(discR, 8), m: xf(THREE, MOTOR_X[i], MOTOR_Y[i], ROTOR_Z - 0.0015, Math.PI, 0, 0), uv: uvMode });
  }
  return {
    body: mergeParts(THREE, body),
    glow: mergeParts(THREE, glow),
    blur: mergeParts(THREE, blur),
  };
}

function tabletGeometries(THREE) {
  const box = (w, d, h) => new THREE.BoxGeometry(w, d, h);
  const frame = [];
  // 0.24 × 0.16 × 0.012: back plate z ∈ [−0.006, 0.002], bezel z ∈ [0.002, 0.006]
  frame.push({ geom: box(0.24, 0.16, 0.008), m: xf(THREE, 0, 0, -0.002), pal: P.DARK_BRASS });
  frame.push({ geom: box(0.24, 0.012, 0.004), m: xf(THREE, 0, 0.074, 0.004), pal: P.BRASS });
  frame.push({ geom: box(0.24, 0.012, 0.004), m: xf(THREE, 0, -0.074, 0.004), pal: P.BRASS });
  frame.push({ geom: box(0.012, 0.136, 0.004), m: xf(THREE, 0.114, 0, 0.004), pal: P.BRASS });
  frame.push({ geom: box(0.012, 0.136, 0.004), m: xf(THREE, -0.114, 0, 0.004), pal: P.BRASS });
  // screen on the +z face (top of the canvas toward local +y: away from the pilot)
  const screen = new THREE.PlaneGeometry(0.216, 0.136);
  screen.translate(0, 0, 0.0035);
  return { frame: mergeParts(THREE, frame), screen: mergeParts(THREE, [{ geom: screen, uv: "keep" }]) };
}

function gogglesGeometries(THREE) {
  const box = (w, d, h) => new THREE.BoxGeometry(w, d, h);
  const body = [];
  // 0.18 × 0.07 × 0.08, lenses facing local −y (head-local −y is forward), strap toward +y
  body.push({ geom: box(0.15, 0.045, 0.055), m: xf(THREE, 0, 0.002, 0), pal: P.DARK_IRON });
  body.push({ geom: box(0.16, 0.01, 0.012), m: xf(THREE, 0, -0.012, 0.031), pal: P.BRASS });
  for (const sx of [-1, 1]) {
    body.push({ geom: new THREE.CylinderGeometry(0.024, 0.024, 0.014, 12, 1, true), m: xf(THREE, sx * 0.038, -0.025, 0), pal: P.BRASS });
    body.push({ geom: box(0.012, 0.05, 0.03), m: xf(THREE, sx * 0.084, 0.01, 0), pal: P.LEATHER });
  }
  body.push({ geom: new THREE.CylinderGeometry(0.0025, 0.0025, 0.009, 5, 1, true), m: xf(THREE, -0.05, 0.01, 0.032, R90, 0, 0), pal: P.IRON });
  body.push({ geom: new THREE.OctahedronGeometry(0.0035, 0), m: xf(THREE, -0.05, 0.01, 0.0365), pal: P.BRASS });
  // the two lens panels: dark tinted glass on the lit metal (its roughness gives the
  // faint sheen), recessed in the brass rims — on the unlit glow material they read
  // as glowing eyes (1070 V3)
  for (const sx of [-1, 1]) {
    body.push({ geom: new THREE.CircleGeometry(0.02, 12), m: xf(THREE, sx * 0.038, -0.026, 0, R90, 0, 0), pal: P.LENS });
  }
  // the red REC pip is the goggles' only glow
  const glow = [];
  glow.push({ geom: box(0.008, 0.004, 0.006), m: xf(THREE, 0.06, -0.022, 0.02), pal: P.REC });
  return { body: mergeParts(THREE, body), glow: mergeParts(THREE, glow) };
}

// --- the tablet screen ---------------------------------------------------------

// The tablet's two numeric texts, rebuilt only when the value they show changes
// (SPEC §5: the 4 Hz `setScreen` path builds no strings except on a text change).
function screenTexts() {
  return { batKey: NaN, bat: "--%", distKey: NaN, dist: "--" };
}

function drawScreen(ctx, s, texts) {
  const st = s && typeof s === "object" ? s : {};
  const live = st.live === true;
  const sig = Number.isFinite(st.signal) ? Math.min(1, Math.max(0, st.signal)) : 0;
  const bat = Number.isFinite(st.battery) ? Math.min(1, Math.max(0, st.battery)) : null;
  const brg = Number.isFinite(st.homeBearingRad) ? st.homeBearingRad : null;
  const dist = Number.isFinite(st.distM) ? Math.max(0, st.distM) : null;
  ctx.save();
  ctx.fillStyle = "#08121c";
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  ctx.fillStyle = "#11263a";
  ctx.fillRect(0, 0, SCREEN_W, 28);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.font = "bold 15px monospace";
  if (live) {
    ctx.fillStyle = "#ff3b30";
    ctx.beginPath();
    ctx.arc(14, 14, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffe6e3";
    ctx.fillText("LIVE", 24, 15);
  } else {
    ctx.fillStyle = "#8394a6";
    ctx.fillText("NO LINK", 8, 15);
  }
  // signal: five bars
  const bars = sig <= 0 ? 0 : Math.ceil(sig * 5);
  for (let i = 0; i < 5; i += 1) {
    const bh = 5 + i * 3;
    ctx.fillStyle = i < bars ? "#6fe3ff" : "#2a3a4a";
    ctx.fillRect(84 + i * 8, 22 - bh, 5, bh);
  }
  // battery
  ctx.strokeStyle = "#c8d4e0";
  ctx.lineWidth = 2;
  ctx.strokeRect(150, 7, 34, 14);
  ctx.fillStyle = "#c8d4e0";
  ctx.fillRect(184, 11, 3, 6);
  if (bat !== null) {
    ctx.fillStyle = bat <= 0.2 ? "#ff5040" : "#7fe07f";
    ctx.fillRect(152, 9, Math.round(30 * bat), 10);
  }
  ctx.fillStyle = "#e6eef5";
  ctx.font = "bold 13px monospace";
  const batKey = bat === null ? -1 : Math.round(bat * 100);
  if (batKey !== texts.batKey) {
    texts.batKey = batKey;
    texts.bat = batKey < 0 ? "--%" : `${batKey}%`;
  }
  ctx.fillText(texts.bat, 194, 15);
  // north-up compass with the home arrow
  ctx.strokeStyle = "#3b5a78";
  ctx.beginPath();
  ctx.arc(64, 96, 44, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "#8394a6";
  ctx.font = "bold 12px monospace";
  ctx.textAlign = "center";
  ctx.fillText("N", 64, 61);
  if (brg !== null) {
    ctx.save();
    ctx.translate(64, 96);
    ctx.rotate(brg); // canvas y points down: a positive angle turns clockwise, like a compass bearing
    ctx.fillStyle = "#f3d27a";
    ctx.beginPath();
    ctx.moveTo(0, -32);
    ctx.lineTo(11, 9);
    ctx.lineTo(0, 2);
    ctx.lineTo(-11, 9);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.textAlign = "left";
  ctx.fillStyle = "#8394a6";
  ctx.font = "bold 12px monospace";
  ctx.fillText("HOME", 128, 72);
  ctx.fillStyle = "#e6eef5";
  ctx.font = "bold 24px monospace";
  // whole metres below 1 km, else km with two decimals (10 m steps); -1 = no value
  const distKey = dist === null ? -1 : dist < 1000 ? Math.round(dist) : -2 - Math.round(dist / 10);
  if (distKey !== texts.distKey) {
    texts.distKey = distKey;
    texts.dist = distKey === -1 ? "--" : distKey >= 0 ? `${distKey} m` : `${((-2 - distKey) / 100).toFixed(2)} km`;
  }
  ctx.fillText(texts.dist, 128, 102);
  ctx.restore();
}

function defaultCreateCanvas() {
  if (typeof document === "undefined" || !document || typeof document.createElement !== "function") return null;
  return (w, h) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  };
}

const nowMs = () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());

// ---------------------------------------------------------------------------
// prewarm
// ---------------------------------------------------------------------------

let _prewarmMemo = new WeakMap(); // renderer → Promise<result>
const _prewarmKeep = []; // proxy roots kept alive for the page (their programs stay referenced)
const PREWARM_POLL_MS = 10;
const PREWARM_POLL_MAX_MS = 20000;

function prewarmRoot(THREE, tex) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 0.01, 0, 0, 0, 0.01, 0]), 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2));
  geom.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));
  const mats = buildMaterials(THREE, { palette: tex, screen: tex, blur: tex, blob: tex });
  const root = new THREE.Group();
  root.name = "drone-prewarm-proxies";
  for (const key of Object.keys(mats)) {
    const mesh = new THREE.Mesh(geom, mats[key]);
    mesh.name = "drone-prewarm-" + key;
    root.add(mesh);
  }
  return root;
}

// The film lens overlay's material twin. world_link draws scene3d/film/runtime/
// lens_overlay.js over the angle / acro FPV frame: transparent DoubleSide MeshBasic
// quads (depthTest / depthWrite / fog / toneMapped off) rendered from the overlay's
// own scene — no lights, no fog — into the canvas. three draws a transparent
// DoubleSide material as a BackSide and a FrontSide pass (two programs), and the
// light counts and the bound target's output colour space are in every program key,
// so the twin is compiled with the null target against an EMPTY Scene: the main
// scene, the HalfFloat target or FrontSide alone each leave the overlay's programs
// to link inside its first draw (the goggle-cut frame).
function overlayTwinRoot(THREE, tex) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
    name: "drone-prewarm-lens-overlay", map: tex, transparent: true, depthTest: false, depthWrite: false,
    fog: false, toneMapped: false, side: THREE.DoubleSide,
  }));
  mesh.name = "drone-prewarm-lens-overlay";
  const root = new THREE.Group();
  root.name = "drone-prewarm-overlay-proxy";
  root.add(mesh);
  return root;
}

// `renderer.compile(root, camera, targetScene)` with the canvas (null) target bound
// and the previous target restored, also on a throw. A renderer without the target
// accessors compiles as it stands.
function compileForCanvas(renderer, root, camera, targetScene) {
  if (typeof renderer.setRenderTarget !== "function" || typeof renderer.getRenderTarget !== "function") {
    return renderer.compile(root, camera, targetScene);
  }
  const prev = renderer.getRenderTarget();
  try {
    renderer.setRenderTarget(null);
    return renderer.compile(root, camera, targetScene);
  } finally {
    try { renderer.setRenderTarget(prev); } catch (_) { /* restore best-effort */ }
  }
}

function programReady(prog) {
  if (!prog || typeof prog.isReady !== "function") return true; // a vanished program counts as done
  try { return prog.isReady() === true; } catch (_) { return true; }
}

// Every program a material owns has linked. three keeps them per material in
// `properties.get(m).programs` (a transparent DoubleSide material owns a BackSide
// and a FrontSide one; `currentProgram` is only the last); without that map,
// `currentProgram`.
function materialReady(renderer, m) {
  let p = null;
  try { p = renderer.properties.get(m); } catch (_) { return true; }
  const progs = p ? p.programs : null;
  if (progs && typeof progs.values === "function" && progs.size > 0) {
    for (const prog of progs.values()) if (!programReady(prog)) return false;
    return true;
  }
  return programReady(p ? p.currentProgram : null);
}

/**
 * Compile the prop programs once, off the frame (the idle prewarm after login,
 * and again — memoised — at deploy). Builds the prop material set with the same
 * factory `createProps` uses (so the keys match) on tiny proxy meshes, then
 * compiles them for the composer variant: when `offscreen`, a 1×1 HalfFloatType
 * WebGLRenderTarget (no depth / stencil) is bound around
 * `renderer.compile(root, camera, scene)` and the previous target restored, then
 * the target is disposed. After that compile (never inside it) a twin of the film
 * lens overlay's material (world_link draws the overlay in angle / acro) is
 * compiled for the canvas: the null target bound, an empty Scene (no lights, no
 * fog) as the target scene, the previous target restored. It then polls every
 * 10 ms until every program of each material (`renderer.properties.get(m)
 * .programs`, else `.currentProgram`) reports `isReady()` (a vanished program
 * counts as done — three's own compileAsync throws from its timer when a
 * material is disposed mid-link). The proxy materials stay alive for the page,
 * so their programs stay referenced even under `?programRetain=off`. Memoised
 * per renderer (a second call returns the first promise). Never call it from
 * inside a render.
 *
 * @param {{THREE: object, renderer: object, scene: object, camera: object,
 *   offscreen?: boolean}} deps `offscreen` default true (callers pass
 *   `!liveScene3d.wireframeMode`: without a composer the canvas variant is live)
 * @returns {Promise<{ok: boolean, compiled: number, ms: number, reason?: string}>}
 *   never rejects; `compiled` counts the materials compiled (the five prop
 *   materials and the overlay twin); `{ok:false, compiled:0, ms:0, reason}`
 *   without a renderer / `compile` / THREE / camera / scene
 */
export function prewarm(deps) {
  const d = deps && typeof deps === "object" ? deps : {};
  const { THREE, renderer, scene, camera } = d;
  const offscreen = d.offscreen !== false;
  if (!renderer || typeof renderer.compile !== "function") {
    return Promise.resolve({ ok: false, compiled: 0, ms: 0, reason: "no renderer.compile" });
  }
  const hit = _prewarmMemo.get(renderer);
  if (hit) return hit;
  if (!THREE || typeof THREE.Group !== "function" || typeof THREE.WebGLRenderTarget !== "function") {
    return Promise.resolve({ ok: false, compiled: 0, ms: 0, reason: "no THREE" });
  }
  if (!camera || typeof camera !== "object") return Promise.resolve({ ok: false, compiled: 0, ms: 0, reason: "no camera" });
  if (!scene || typeof scene !== "object") return Promise.resolve({ ok: false, compiled: 0, ms: 0, reason: "no scene" });
  const t0 = nowMs();
  const elapsed = () => Math.round(nowMs() - t0);
  const p = new Promise((resolve) => {
    const pending = [];
    const take = (materials) => {
      if (materials && typeof materials.forEach === "function") materials.forEach((m) => { if (m) pending.push(m); });
    };
    try {
      const tex = pixelTexture(THREE, [255, 255, 255, 255], "drone-prewarm-pixel");
      const root = prewarmRoot(THREE, tex);
      const overlayRoot = overlayTwinRoot(THREE, tex);
      _prewarmKeep.push(root, overlayRoot);
      if (offscreen && typeof renderer.setRenderTarget === "function" && typeof renderer.getRenderTarget === "function") {
        const prev = renderer.getRenderTarget();
        const target = new THREE.WebGLRenderTarget(1, 1, {
          type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
        });
        try {
          renderer.setRenderTarget(target);
          take(renderer.compile(root, camera, scene));
        } finally {
          try { renderer.setRenderTarget(prev); } catch (_) { /* restore best-effort */ }
          try { target.dispose(); } catch (_) { /* already gone */ }
        }
      } else {
        take(renderer.compile(root, camera, scene));
      }
      // the lens-overlay twin: the canvas variant from an empty scene, in either mode
      take(compileForCanvas(renderer, overlayRoot, camera, new THREE.Scene()));
    } catch (e) {
      resolve({ ok: false, compiled: 0, ms: elapsed(), reason: "compile failed: " + String(e?.message ?? e) });
      return;
    }
    const compiled = pending.length;
    const check = () => {
      try {
        for (let i = pending.length - 1; i >= 0; i -= 1) if (materialReady(renderer, pending[i])) pending.splice(i, 1);
      } catch (_) {
        pending.length = 0; // never leak a throw out of the poll
      }
      if (pending.length === 0) {
        resolve({ ok: true, compiled, ms: elapsed() });
        return;
      }
      if (nowMs() - t0 > PREWARM_POLL_MAX_MS) {
        resolve({ ok: false, compiled, ms: elapsed(), reason: "ready-poll timeout" });
        return;
      }
      setTimeout(check, PREWARM_POLL_MS);
    };
    check();
  });
  _prewarmMemo.set(renderer, p);
  return p;
}

/** Test hook: forget the per-renderer prewarm memo and the kept proxy materials. */
export function _resetPrewarmForTest() {
  _prewarmMemo = new WeakMap();
  _prewarmKeep.length = 0;
}

// ---------------------------------------------------------------------------
// createProps
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Props
 * @property {object} drone THREE root of the drone (read-only reference)
 * @property {object} tablet THREE root of the tablet
 * @property {object} goggles THREE root of the goggles
 * @property {object} group `droneGroup` (scene child, rotation.x = −π/2: AC world)
 * @property {(rig: object|null) => void} setRig
 * @property {(anchors: object) => void} setAnchors
 * @property {(name: string, anchor?: string) => boolean} attach
 * @property {(name: string, groundZ: number, yaw: number) => {ok: boolean, pos: number[]|null}} toWorld
 * @property {(name: string, pos: number[], yaw: number) => boolean} place
 * @property {(name: string) => boolean} remove
 * @property {(name: string) => 'none'|'rig'|'world'} where
 * @property {(name: string, out?: number[]) => number[]|null} worldPos
 * @property {(pos: number[], q: number[]) => boolean} setDronePose
 * @property {(name: string, on: boolean) => void} setVisible
 * @property {(spin: number, t: number) => void} setRotor
 * @property {(z: number|null) => void} setGround
 * @property {(state: object) => boolean} setScreen
 * @property {(name: string, opts: {delaySec?: number, durationSec?: number, now: number}) => boolean} fadeOut
 * @property {(name: string) => boolean} fading
 * @property {() => {meshes: number, geometries: number, materials: number, textures: number, built: boolean}} stats
 * @property {() => {ok: boolean, disposed: {geometries: number, materials: number, textures: number}}} dispose
 */

/**
 * Build the drone, the tablet and the goggles (all hidden, placement `'none'`)
 * and `droneGroup` (name `"drone-world"`, a direct child of `scene` with
 * `rotation.x = −π/2` — worldRoot's transform, so its children take AC world
 * coordinates — `userData.__punchPhase = 2`, layer 1). See SPEC §3.2 for every
 * member's contract. Per-frame members (`setDronePose`, `setRotor`,
 * `setGround`) allocate nothing; no member throws after construction.
 *
 * @param {{THREE: object, scene: object, anchors?: object,
 *   createCanvas?: (w: number, h: number) => (HTMLCanvasElement|null),
 *   log?: (entry: object) => void}} deps `THREE` and `scene` (liveScene3d.scene)
 *   are REQUIRED. `anchors` default DEFAULT_ANCHORS; `createCanvas` default
 *   `document.createElement("canvas")` when a document exists — with none (node)
 *   the screen is a 1×1 DataTexture and `setScreen` returns false
 * @returns {Props}
 * @throws {TypeError} without THREE or scene
 */
export function createProps(deps) {
  const d = deps && typeof deps === "object" ? deps : {};
  const THREE = d.THREE;
  const scene = d.scene;
  if (!THREE || typeof THREE.Group !== "function" || typeof THREE.Mesh !== "function") {
    throw new TypeError("[drone] createProps: deps.THREE is required");
  }
  if (!scene || typeof scene.add !== "function") throw new TypeError("[drone] createProps: deps.scene is required");
  const log = typeof d.log === "function" ? d.log : defaultLog;
  const say = (level, message, extra) => {
    try { log({ event: "drone", level, message, ...(extra || {}) }); } catch (_) { /* never breaks us */ }
  };
  let anchors = anchorsFrom(d.anchors);

  const created = { geometries: new Set(), materials: new Set(), textures: new Set() };
  const keepGeom = (g) => { created.geometries.add(g); return g; };

  // --- textures + materials ---
  const palette = paletteTexture(THREE);
  const blobTex = blobTexture(THREE);
  const blurTex = blurTexture(THREE);
  let screenCtx = null;
  let screenTex = null;
  const screenTxt = screenTexts();
  {
    const make = typeof d.createCanvas === "function" ? d.createCanvas : defaultCreateCanvas();
    let canvas = null;
    if (make) {
      try { canvas = make(SCREEN_W, SCREEN_H) ?? null; } catch (e) {
        canvas = null;
        say("warn", "props: createCanvas failed; the tablet screen stays blank", { error: String(e?.message ?? e) });
      }
    }
    let ctx = null;
    if (canvas && typeof canvas.getContext === "function") {
      try { ctx = canvas.getContext("2d") ?? null; } catch (_) { ctx = null; }
    }
    if (ctx) {
      try {
        if (canvas.width !== SCREEN_W) canvas.width = SCREEN_W;
        if (canvas.height !== SCREEN_H) canvas.height = SCREEN_H;
      } catch (_) { /* fixed-size canvas */ }
      try { drawScreen(ctx, { live: false }, screenTxt); } catch (_) { /* first draw is cosmetic */ }
      screenCtx = ctx;
      screenTex = new THREE.CanvasTexture(canvas);
      screenTex.colorSpace = THREE.SRGBColorSpace;
      screenTex.generateMipmaps = false;
      screenTex.minFilter = THREE.LinearFilter;
      screenTex.magFilter = THREE.LinearFilter;
      screenTex.name = "drone-screen";
    } else {
      screenTex = pixelTexture(THREE, [8, 18, 28, 255], "drone-screen");
    }
  }
  for (const t of [palette, blobTex, blurTex, screenTex]) created.textures.add(t);
  const mats = buildMaterials(THREE, { palette, screen: screenTex, blur: blurTex, blob: blobTex });
  for (const k of Object.keys(mats)) created.materials.add(mats[k]);

  // --- meshes ---
  const mesh = (name, geom, mat) => {
    const m = new THREE.Mesh(keepGeom(geom), mat);
    m.name = name;
    return m;
  };
  const dg = droneGeometries(THREE);
  const tg = tabletGeometries(THREE);
  const gg = gogglesGeometries(THREE);

  const droneRoot = new THREE.Group();
  droneRoot.name = "drone-prop";
  const bodyMesh = mesh("drone-body", dg.body.geometry, mats.metal);
  const glowMesh = mesh("drone-glow", dg.glow.geometry, mats.glow);
  const blurMesh = mesh("drone-blur", dg.blur.geometry, mats.blur);
  droneRoot.add(bodyMesh, glowMesh, blurMesh);
  blurMesh.visible = false;

  const tabletRoot = new THREE.Group();
  tabletRoot.name = "drone-tablet";
  tabletRoot.add(mesh("tablet-frame", tg.frame.geometry, mats.metal), mesh("tablet-screen", tg.screen.geometry, mats.screen));

  const gogglesRoot = new THREE.Group();
  gogglesRoot.name = "drone-goggles";
  gogglesRoot.add(mesh("goggles-body", gg.body.geometry, mats.metal), mesh("goggles-glow", gg.glow.geometry, mats.glow));

  const blobGeom = new THREE.PlaneGeometry(0.42, 0.42);
  const blob = mesh("drone-blob", blobGeom, mats.blob);
  blob.visible = false;

  const group = new THREE.Group();
  group.name = "drone-world";
  group.rotation.x = -Math.PI / 2;
  group.userData.__punchPhase = 2;
  group.add(blob);
  stampNode(group);
  const roots = [droneRoot, tabletRoot, gogglesRoot];
  for (const r of roots) {
    stampNode(r);
    r.visible = false;
  }
  scene.add(group);

  // --- the blade / rear-LED vertex ranges (CPU-animated; the attributes re-upload whole) ---
  const bodyGeom = dg.body.geometry;
  const bodyPos = bodyGeom.attributes.position;
  const bodyNrm = bodyGeom.attributes.normal;
  bodyPos.setUsage(THREE.DynamicDrawUsage);
  bodyNrm.setUsage(THREE.DynamicDrawUsage);
  const bladeStart = dg.body.ranges.blade0.start;
  const bladeVerts = dg.body.ranges.blade0.count; // per rotor
  const bladeBasePos = bodyPos.array.slice(bladeStart * 3, (bladeStart + 4 * bladeVerts) * 3);
  const bladeBaseNrm = bodyNrm.array.slice(bladeStart * 3, (bladeStart + 4 * bladeVerts) * 3);
  // Rotating blades must stay inside the culling sphere: cover every rotor disc.
  {
    const s = bodyGeom.boundingSphere;
    let r = s.radius;
    for (let i = 0; i < 4; i += 1) {
      const dx = MOTOR_X[i] - s.center.x;
      const dy = MOTOR_Y[i] - s.center.y;
      const dz = ROTOR_Z - s.center.z;
      r = Math.max(r, Math.hypot(dx, dy, dz) + PROP_R + 0.005);
    }
    s.radius = r;
  }
  const glowGeom = dg.glow.geometry;
  const glowUv = glowGeom.attributes.uv;
  glowUv.setUsage(THREE.DynamicDrawUsage);
  const ledRanges = [dg.glow.ranges.ledRear0, dg.glow.ranges.ledRear1];

  // --- state ---
  let disposed = false;
  let rig = null;
  const where = ["none", "none", "none"];
  const anchorAt = [null, null, null];
  const vis = [true, true, true]; // render visibility (setVisible), independent of placement
  const fadeStart = [NaN, NaN, NaN]; // NaN = no fade
  const fadeDur = [0, 0, 0];
  const fadeK = [1, 1, 1]; // current fade factor (1 = none)
  let groundZ = null; // the drone's last ground z (toWorld / place / setGround)
  let droneBaseZ = 0; // the drone's pose z before the fade's ground-anchored shrink
  let lastT = null;
  let bladeAngle = 0;
  let bladesHidden = false;
  let ledOn = true;
  const _v = new THREE.Vector3();

  const idxOf = (name) => (name === "drone" ? DRONE : name === "tablet" ? TABLET : name === "goggles" ? GOGGLES : -1);
  const rigScale = () => {
    const s = +rig?.rootScale;
    return Number.isFinite(s) && s > 0 ? s : 1;
  };
  const baseScale = (i) => {
    if (where[i] !== "rig") return 1;
    if (i === DRONE) return 1 / rigScale(); // its world size stays 1:1 in a large race's hand
    if (i === GOGGLES) return anchors.goggles.scale;
    return 1;
  };
  const applyVisible = (i) => { roots[i].visible = where[i] !== "none" && vis[i]; };
  const setYaw = (root, yaw) => {
    // compass yaw → AC quat [cos(−yaw/2), 0, 0, sin(−yaw/2)] in three field order
    root.quaternion.set(0, 0, Math.sin(-yaw / 2), Math.cos(-yaw / 2));
  };
  const cancelFade = (i) => {
    fadeStart[i] = NaN;
    fadeDur[i] = 0;
    fadeK[i] = 1;
  };

  function rotateBlades(angle) {
    const a = bodyPos.array;
    const n = bodyNrm.array;
    for (let r = 0; r < 4; r += 1) {
      const th = angle * SPIN_DIR[r] + BLADE_PHASE[r];
      const c = Math.cos(th);
      const s = Math.sin(th);
      const cx = MOTOR_X[r];
      const cy = MOTOR_Y[r];
      const v0 = r * bladeVerts;
      for (let k = 0; k < bladeVerts; k += 1) {
        const b = (v0 + k) * 3;
        const o = (bladeStart + v0 + k) * 3;
        const x = bladeBasePos[b] - cx;
        const y = bladeBasePos[b + 1] - cy;
        a[o] = cx + x * c - y * s;
        a[o + 1] = cy + x * s + y * c;
        a[o + 2] = bladeBasePos[b + 2];
        const nx = bladeBaseNrm[b];
        const ny = bladeBaseNrm[b + 1];
        n[o] = nx * c - ny * s;
        n[o + 1] = nx * s + ny * c;
        n[o + 2] = bladeBaseNrm[b + 2];
      }
    }
    bodyPos.needsUpdate = true;
    bodyNrm.needsUpdate = true;
    bladesHidden = false;
  }

  function collapseBlades() {
    // the blur discs take over: the blade triangles collapse onto their shafts
    const a = bodyPos.array;
    for (let r = 0; r < 4; r += 1) {
      const v0 = r * bladeVerts;
      for (let k = 0; k < bladeVerts; k += 1) {
        const o = (bladeStart + v0 + k) * 3;
        a[o] = MOTOR_X[r];
        a[o + 1] = MOTOR_Y[r];
        a[o + 2] = ROTOR_Z;
      }
    }
    bodyPos.needsUpdate = true;
    bladesHidden = true;
  }

  function setRearLed(on) {
    const u = palU(on ? P.LED_RED : P.LED_OFF);
    const arr = glowUv.array;
    for (let j = 0; j < ledRanges.length; j += 1) {
      const rg = ledRanges[j];
      for (let k = 0; k < rg.count; k += 1) arr[(rg.start + k) * 2] = u;
    }
    glowUv.needsUpdate = true;
    ledOn = on;
  }

  function updateBlob() {
    if (disposed) return;
    if (where[DRONE] !== "world" || !vis[DRONE] || groundZ === null) {
      blob.visible = false;
      return;
    }
    // AGL = the drone's z over its last ground z (SPEC §3.2; the OSD's aglM is the same)
    const agl = Math.max(0, droneBaseZ - groundZ);
    const k = Math.max(0, 1 - agl / BLOB_FADE_AGL_M) * fadeK[DRONE];
    if (k < 0.01) {
      blob.visible = false;
      return;
    }
    blob.visible = true;
    const p = droneRoot.position;
    blob.position.set(p.x, p.y, groundZ + BLOB_LIFT_M);
    const s = 1 + 0.25 * Math.min(agl, BLOB_FADE_AGL_M);
    blob.scale.set(s, s, 1);
    mats.blob.opacity = BLOB_OPACITY * k;
  }

  function removeIdx(i) {
    cancelFade(i);
    const root = roots[i];
    root.removeFromParent();
    delete root.userData.__attachedChildOf;
    where[i] = "none";
    anchorAt[i] = null;
    root.visible = false;
    if (i === DRONE) blob.visible = false;
  }

  function attachIdx(i, anchor) {
    const r = rig;
    const prof = r?.profile;
    if (!r || !prof || prof.kind !== "humanoid") return false;
    if (!ANCHOR_NAMES.includes(anchor)) return false;
    const partIdx = prof[anchor];
    if (!Number.isInteger(partIdx) || partIdx < 0) return false;
    const part = r.parts?.[partIdx];
    if (!part || part.isObject3D !== true) return false;
    const a = anchors[ANCHOR_KEYS[i]];
    const root = roots[i];
    cancelFade(i);
    if (root.parent !== part) part.add(root); // add() takes it off its old parent
    root.position.set(a.pos[0], a.pos[1], a.pos[2]);
    root.quaternion.set(a.quat[1], a.quat[2], a.quat[3], a.quat[0]);
    where[i] = "rig";
    anchorAt[i] = anchor;
    const s = baseScale(i);
    root.scale.set(s, s, s);
    stampRigProp(root, r.guid);
    applyVisible(i);
    if (i === DRONE) blob.visible = false;
    return true;
  }

  function toGroup(i) {
    cancelFade(i);
    const root = roots[i];
    if (root.parent !== group) {
      root.removeFromParent();
      group.add(root);
    }
    delete root.userData.__attachedChildOf;
  }

  // ---- members ----

  function setRig(next) {
    if (disposed) return;
    rig = next && typeof next === "object" ? next : null;
    for (let i = 0; i < 3; i += 1) {
      if (where[i] !== "rig") continue;
      if (!attachIdx(i, anchorAt[i])) removeIdx(i); // the new rig cannot hold it
    }
  }

  function setAnchors(next) {
    if (disposed) return;
    anchors = anchorsFrom(next);
    for (let i = 0; i < 3; i += 1) if (where[i] === "rig") attachIdx(i, anchorAt[i]);
  }

  function attach(name, anchor) {
    const i = idxOf(name);
    if (i < 0 || disposed) return false;
    return attachIdx(i, anchor === undefined ? ANCHOR_OF[name] : anchor);
  }

  function toWorld(name, gz, yaw) {
    const i = idxOf(name);
    if (i < 0 || disposed || where[i] === "none") return { ok: false, pos: null };
    const g = typeof gz === "number" ? gz : NaN;
    const c = typeof yaw === "number" ? yaw : NaN;
    if (!Number.isFinite(g) || !Number.isFinite(c)) return { ok: false, pos: null };
    const root = roots[i];
    cancelFade(i);
    if (root.parent !== group) group.attach(root); // keeps the world transform (updateWorldMatrix both ways)
    delete root.userData.__attachedChildOf;
    root.scale.set(1, 1, 1);
    const x = root.position.x;
    const y = root.position.y;
    const z = g + (i === DRONE ? DRONE_BODY.restHeightM : 0);
    root.position.set(x, y, z);
    setYaw(root, c);
    where[i] = "world";
    anchorAt[i] = null;
    if (i === DRONE) {
      groundZ = g;
      droneBaseZ = z;
    }
    applyVisible(i);
    updateBlob();
    return { ok: true, pos: [x, y, z] };
  }

  function place(name, pos, yaw) {
    const i = idxOf(name);
    if (i < 0 || disposed || !pos) return false;
    const x = +pos[0];
    const y = +pos[1];
    const z = +pos[2];
    const c = typeof yaw === "number" ? yaw : NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(c)) return false;
    toGroup(i);
    const root = roots[i];
    root.position.set(x, y, z);
    setYaw(root, c);
    root.scale.set(1, 1, 1);
    where[i] = "world";
    anchorAt[i] = null;
    if (i === DRONE) {
      groundZ = z - DRONE_BODY.restHeightM;
      droneBaseZ = z;
    }
    applyVisible(i);
    updateBlob();
    return true;
  }

  function remove(name) {
    const i = idxOf(name);
    if (i < 0 || disposed) return false;
    removeIdx(i);
    return true;
  }

  function whereOf(name) {
    const i = idxOf(name);
    return i < 0 || disposed ? "none" : where[i];
  }

  function worldPos(name, out) {
    const i = idxOf(name);
    if (i < 0 || disposed || where[i] === "none") return null;
    const o = out ?? [0, 0, 0];
    roots[i].getWorldPosition(_v); // updates the parent chain: never a stale matrixWorld
    group.updateWorldMatrix(true, false);
    group.worldToLocal(_v); // three world → AC world (droneGroup is worldRoot's transform)
    o[0] = _v.x;
    o[1] = _v.y;
    o[2] = _v.z;
    return o;
  }

  function setDronePose(pos, q) {
    if (disposed || where[DRONE] !== "world" || !pos || !q) return false;
    const x = +pos[0];
    const y = +pos[1];
    const z = +pos[2];
    const qw = +q[0];
    const qx = +q[1];
    const qy = +q[2];
    const qz = +q[3];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
    if (!Number.isFinite(qw) || !Number.isFinite(qx) || !Number.isFinite(qy) || !Number.isFinite(qz)) return false;
    const n = Math.sqrt(qw * qw + qx * qx + qy * qy + qz * qz);
    if (!(n > 1e-9)) return false;
    droneRoot.position.set(x, y, z);
    droneRoot.quaternion.set(qx / n, qy / n, qz / n, qw / n);
    droneBaseZ = z;
    return true;
  }

  function setVisible(name, on) {
    const i = idxOf(name);
    if (i < 0 || disposed) return;
    vis[i] = !!on;
    applyVisible(i);
    if (i === DRONE) updateBlob();
  }

  function setRotor(spin, t) {
    if (disposed) return;
    const tt = typeof t === "number" && Number.isFinite(t) ? t : (lastT ?? 0);
    const dt = lastT === null ? 0 : Math.min(MAX_DT, Math.max(0, tt - lastT));
    lastT = tt;
    const sp = typeof spin === "number" && Number.isFinite(spin) ? Math.min(MAX_SPIN, Math.max(0, spin)) : 0;
    // rotors: blades at or below 0.3, blur discs above
    const blurOn = sp > BLUR_ABOVE_SPIN;
    blurMesh.visible = blurOn;
    if (blurOn) {
      if (!bladesHidden) collapseBlades();
      let r = blurTex.rotation + BLUR_RAD_PER_SPIN * sp * dt;
      if (r > Math.PI * 2) r -= Math.PI * 2;
      blurTex.rotation = r;
      mats.blur.opacity = BLUR_OPACITY * (0.7 + 0.3 * Math.min(1, (sp - BLUR_ABOVE_SPIN) / 1.2));
    } else if (bladesHidden || (sp > 0 && droneRoot.visible)) {
      bladeAngle += BLADE_REV_PER_SPIN * Math.PI * 2 * sp * dt;
      if (bladeAngle > Math.PI * 2) bladeAngle -= Math.PI * 2 * Math.floor(bladeAngle / (Math.PI * 2));
      rotateBlades(bladeAngle);
    }
    // LEDs: rear red blinks at 1 Hz
    const on = tt - Math.floor(tt) < 0.5;
    if (on !== ledOn) setRearLed(on);
    // fades (any prop): scale-out toward the feet, then remove
    for (let i = 0; i < 3; i += 1) {
      const f0 = fadeStart[i];
      if (f0 !== f0 || tt < f0) continue; // NaN = no fade; or still pending
      const dur = fadeDur[i];
      const p = dur > 0 ? (tt - f0) / dur : 1;
      if (p >= 1) {
        removeIdx(i);
        continue;
      }
      const k = 1 - p * p * (3 - 2 * p);
      fadeK[i] = k;
      const s = Math.max(1e-3, k) * baseScale(i);
      roots[i].scale.set(s, s, s);
      if (i === DRONE && where[DRONE] === "world") {
        droneRoot.position.z = droneBaseZ - DRONE_BODY.restHeightM * (1 - k);
      }
    }
    updateBlob();
  }

  function setGround(z) {
    if (disposed) return;
    if (typeof z === "number" && Number.isFinite(z)) groundZ = z;
    updateBlob();
  }

  function setScreen(state) {
    if (disposed || !screenCtx) return false;
    try {
      drawScreen(screenCtx, state, screenTxt);
      screenTex.needsUpdate = true;
      return true;
    } catch (_) {
      return false;
    }
  }

  function fadeOut(name, opts) {
    const i = idxOf(name);
    if (i < 0 || disposed || where[i] === "none") return false;
    const o = opts && typeof opts === "object" ? opts : {};
    const now = typeof o.now === "number" && Number.isFinite(o.now) ? o.now : (lastT ?? 0);
    const delay = o.delaySec === undefined ? 0 : +o.delaySec;
    const dur = o.durationSec === undefined ? 1 : +o.durationSec;
    fadeStart[i] = now + (Number.isFinite(delay) && delay > 0 ? delay : 0);
    fadeDur[i] = Number.isFinite(dur) && dur > 0 ? dur : 0;
    fadeK[i] = 1;
    return true;
  }

  function fading(name) {
    const i = idxOf(name);
    if (i < 0 || disposed) return false;
    return fadeStart[i] === fadeStart[i]; // not NaN
  }

  function stats() {
    return {
      meshes: disposed ? 0 : 8,
      geometries: created.geometries.size,
      materials: created.materials.size,
      textures: created.textures.size,
      built: !disposed,
    };
  }

  function dispose() {
    if (disposed) return { ok: true, disposed: { geometries: 0, materials: 0, textures: 0 } };
    for (let i = 0; i < 3; i += 1) removeIdx(i); // off the rig / out of the world
    disposed = true;
    rig = null;
    group.removeFromParent();
    const counts = { geometries: 0, materials: 0, textures: 0 };
    for (const g of created.geometries) { try { g.dispose(); } catch (_) {} counts.geometries += 1; }
    for (const m of created.materials) { try { m.dispose(); } catch (_) {} counts.materials += 1; }
    for (const t of created.textures) { try { t.dispose(); } catch (_) {} counts.textures += 1; }
    created.geometries.clear();
    created.materials.clear();
    created.textures.clear();
    screenCtx = null;
    return { ok: true, disposed: counts };
  }

  // Initial rotor / LED state (blades at their phases, rear LED on).
  rotateBlades(0);
  setRearLed(true);

  return {
    drone: droneRoot,
    tablet: tabletRoot,
    goggles: gogglesRoot,
    group,
    setRig,
    setAnchors,
    attach,
    toWorld,
    place,
    remove,
    where: whereOf,
    worldPos,
    setDronePose,
    setVisible,
    setRotor,
    setGround,
    setScreen,
    fadeOut,
    fading,
    stats,
    dispose,
  };
}

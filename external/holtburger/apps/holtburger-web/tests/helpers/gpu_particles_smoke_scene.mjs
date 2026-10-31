// tests/helpers/gpu_particles_smoke_scene.mjs — the S7 scene of the
// `?gpuParticles` (R3-7a) SwiftShader smoke, ONE copy for both halves:
// harness/glsl_smoke/gpu_particles_page.html draws it in Chromium, and
// tests/gpu_particles.test.mjs draws it through three r184's real
// WebGLRenderer over tests/helpers/fake_webgl2.mjs and evaluates the program
// three built (tests/helpers/gpu_particles_glsl_eval.mjs). No imports: the
// caller hands in THREE and the app modules (the page gets them from its
// import map / routes, node from node_modules and scene3d/).
//
// 2026-10-31 smoke fix: the page used to build
//   new OrthographicCamera(cx - half, cx + half, cy + half, cy - half) at (cx, cy)
// but three's left / right / top / bottom are VIEW-space offsets from the
// camera, so it framed world [2 cx - half, 2 cx + half] while the verdict
// projected onto [cx - half, cx + half]: every centroid sat cx / (2 half) W px
// off (8 to 40 px on the four S7 cases, 213 of 213 off). The frustum is now
// symmetric about the camera, and `smokeExpectedPixel` is the one projection
// both the verdict and the node check use.

/** Render target / canvas size of the production arm (px). */
export const SMOKE_W = 256;
/** The S7 cases, the picks per case, the opacity floor of a pick. */
export const SMOKE_S7_CASES = Object.freeze(["corpus", "facing", "twoManagers", "clock16000"]);
export const SMOKE_S7_PER_CASE = 60;
export const SMOKE_S7_MIN_OP = 0.05;
/** Margin (world units) around the instances' xy extent. */
export const SMOKE_MARGIN = 6;

/**
 * The world-space window a case is framed in: the xy extent of its instance
 * translations (the flag-off matrices) plus the margin, square, and the top z.
 * `{ left, right, bottom, top, W, H, cx, cy, half, zTop }` (left..top in WORLD units).
 */
export function smokeOrthoBounds(entries, W = SMOKE_W) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const en of entries) {
    x0 = Math.min(x0, en.M[12]); x1 = Math.max(x1, en.M[12]);
    y0 = Math.min(y0, en.M[13]); y1 = Math.max(y1, en.M[13]);
    z1 = Math.max(z1, en.M[14]);
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, half = Math.max(x1 - x0, y1 - y0) / 2 + SMOKE_MARGIN;
  return { left: cx - half, right: cx + half, bottom: cy - half, top: cy + half, W, H: W, cx, cy, half, zTop: z1 };
}

/**
 * The top-down orthographic camera that frames `o` (smokeOrthoBounds): at
 * (cx, cy, zTop + 1000) looking down -z, up +y (view x = world x - cx, view
 * y = world y - cy), frustum symmetric about it in VIEW space.
 */
export function smokeOrthoCamera(THREE, o) {
  const cam = new THREE.OrthographicCamera(o.left - o.cx, o.right - o.cx, o.top - o.cy, o.bottom - o.cy, 0.1, 10000);
  cam.position.set(o.cx, o.cy, o.zTop + 1000);
  cam.up.set(0, 1, 0);
  cam.lookAt(o.cx, o.cy, o.zTop);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

/**
 * The CPU projection of world (x, y) into the render target, in window
 * coordinates as readPixels reports them (x right, y UP from the bottom row,
 * pixel (i, j) centred at (i + 0.5, j + 0.5)).
 */
export function smokeExpectedPixel(o, x, y) {
  return [(x - o.left) / (o.right - o.left) * o.W, (y - o.bottom) / (o.top - o.bottom) * o.H];
}

/** The S7 picks of a case: the first SMOKE_S7_PER_CASE entries with op >= SMOKE_S7_MIN_OP. */
export function smokeS7Picks(cs) {
  const out = [];
  for (const en of cs.entries) {
    if (out.length >= SMOKE_S7_PER_CASE) break;
    if (!(en.C[0] >= SMOKE_S7_MIN_OP)) continue;
    out.push(en);
  }
  return out;
}

/** The carrier geometry: a 2 x 2 x 2 box (centrally symmetric: its coverage centroid is its centre) with white vertex colours. */
export function smokeBox(THREE) {
  const geom = new THREE.BoxGeometry(2, 2, 2);
  geom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(geom.attributes.position.count * 3).fill(1), 3));
  return geom;
}

/** A 4 x 4 white RGBA8 map. */
export function smokeWhite(THREE) {
  const white = new THREE.DataTexture(new Uint8Array(4 * 4 * 4).fill(255), 4, 4);
  white.needsUpdate = true;
  return white;
}

/**
 * The bucket configurations of particle_manager.js `_makeBucketIm`, made the
 * production way (the gpu patch before the additive fog). `mods` = { THREE,
 * GPM: gpu_particles.js, PM: particle_manager.js, PF: particle_fx.js, AF:
 * additive_fog.js }.
 */
export function smokeMaterials(mods, white) {
  const { THREE, GPM, PM, PF, AF } = mods;
  return {
    stockAdd() {
      const m = new THREE.MeshBasicMaterial({ map: white, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, vertexColors: true });
      m.forceSinglePass = true;
      GPM.applyGpParticleMaterial(m, { fx: false });
      AF.applyAdditiveParticleFog(m);
      return m;
    },
    stockAlpha() {
      const m = new THREE.MeshBasicMaterial({ map: white });
      PM._configureAlphaBucketMaterial(m);
      m.forceSinglePass = true;
      GPM.applyGpParticleMaterial(m, { fx: false });
      return m;
    },
    fxAdd() {
      const m = new THREE.MeshBasicMaterial({ map: white, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, vertexColors: true });
      m.forceSinglePass = true;
      PF.applyParticleFxMaterial(m, { additive: true });
      GPM.applyGpParticleMaterial(m, { fx: true });
      AF.applyAdditiveParticleFog(m);
      return m;
    },
    fxAlpha() {
      const m = new THREE.MeshBasicMaterial({ map: white });
      PM._configureAlphaBucketMaterial(m);
      m.forceSinglePass = true;
      PF.applyParticleFxMaterial(m, { additive: false });
      GPM.applyGpParticleMaterial(m, { fx: true });
      return m;
    },
  };
}

/** An InstancedMesh of `recs.length` instances whose instanceColor.r carries the record index. */
export function smokeMeshOf(THREE, geom, mat, recs) {
  const im = new THREE.InstancedMesh(geom, mat, Math.max(1, recs.length));
  im.frustumCulled = false;
  const c = new THREE.Color();
  recs.forEach((r, i) => im.setColorAt(i, c.setRGB(r, 0, 0)));
  im.count = recs.length;
  im.instanceColor.needsUpdate = true;
  return im;
}

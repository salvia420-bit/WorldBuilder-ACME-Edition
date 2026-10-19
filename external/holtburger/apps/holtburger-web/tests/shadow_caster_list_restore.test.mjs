// tests/shadow_caster_list_restore.test.mjs — ?shadowCasterList and
// ?shadowStaticCache (scene3d/shadow_caster_list.js) across a WebGL context
// loss + restore (review 2026-10-18 §10.5 "Render restore gaps", follow-up).
//
// three r184's onContextRestore -> initGLContext builds a NEW WebGLShadowMap
// and assigns it to renderer.shadowMap (WebGLRenderer.js:456/508), copying
// only enabled / autoUpdate / needsUpdate / type over (:1110-1121). The
// wrapper used to stay on the dead map, so both trims were silently off for
// the rest of the session. This runs three's real WebGLRenderer and
// WebGLShadowMap over tests/helpers/fake_webgl2.mjs with a canvas that keeps
// its listeners, and fires three's lost/restored handlers followed by ours:
//   1. ?shadowCasterList: the restored map is wrapped (one wrapper, the
//      dynamic root carried over), a second restore wraps again, the dead map's
//      stand-in root holds nothing, a restored non-PCF type gets three's own
//      pass once (its fresh map sees a type change), uninstall stops re-wrapping.
//   2. ?shadowStaticCache: the first mover raster after a restore runs through
//      the cache path and REFRESHes (no OVERLAY from the dead context's cache),
//      the cache target gets GL objects from the restored context, its first
//      blits are GL-error checked again, then OVERLAY resumes.
//
// Run:  cd apps/holtburger-web && node tests/shadow_caster_list_restore.test.mjs

globalThis.window ??= {};
window.location ??= { search: "" };
window.requestAnimationFrame ??= () => 0;

const THREE = await import("three");
const { createFakeWebGL2 } = await import("./helpers/fake_webgl2.mjs");
const SCL = await import("../scene3d/shadow_caster_list.js");

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

/** A canvas that keeps its listeners (see webgl_restore_render_patches). */
function restorableCanvas(gl, width = 800, height = 600) {
  const listeners = Object.create(null);
  const c = {
    width, height, style: {},
    addEventListener(t, f) { (listeners[t] ||= []).push(f); },
    removeEventListener(t, f) { const a = listeners[t]; const i = a ? a.indexOf(f) : -1; if (i >= 0) a.splice(i, 1); },
    getContext() { return gl; },
    getBoundingClientRect() { return { left: 0, top: 0, width, height }; },
    loseAndRestore() {
      for (const f of [...(listeners.webglcontextlost || [])]) f({ preventDefault() {} });
      for (const f of [...(listeners.webglcontextrestored || [])]) f({});
    },
  };
  try { gl.canvas = c; } catch (_) { /* proxy set */ }
  return c;
}

// three logs "Context Lost." / "Context Restored." through console.log.
const quietRestore = (canvas) => {
  const log = console.log;
  console.log = () => {};
  try { canvas.loseAndRestore(); } finally { console.log = log; }
};

/** The client's shadow setup: PCF, the mover-scope gate's manual raster
 *  (lighting.js applyMoverScopedShadowGate), a managed sun, and the
 *  entities group as the dynamic root. */
function setup() {
  const gl = createFakeWebGL2({ maxTextures: 16, maxCombined: 32 });
  const canvas = restorableCanvas(gl);
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 1000);
  camera.position.set(0, 5, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.name = "sun";
  sun.position.set(10, 20, 5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(256, 256);
  sun.shadow.autoUpdate = false;
  sun.userData.hbShadowManaged = true;
  scene.add(sun, sun.target);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(50, 50), new THREE.MeshStandardMaterial());
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  const house = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial());
  house.castShadow = true;
  const entities = new THREE.Group();
  entities.name = "entities";
  const rig = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.8, 0.5), new THREE.MeshStandardMaterial());
  rig.position.set(3, 0.9, 0);
  rig.castShadow = true;
  entities.add(rig);
  scene.add(ground, house, entities);
  renderer.shadowMap.__hbShadowDynamicRoot = entities;
  // One gated frame: mark the sun (with why) and render.
  const frame = (reason) => {
    sun.shadow.needsUpdate = true;
    sun.userData.hbShadowReason = (sun.userData.hbShadowReason | 0) | reason;
    renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, camera);
  };
  return { gl, canvas, renderer, camera, scene, sun, entities, rig, frame };
}

const { SHADOW_REASON_MOVER: MOVER, SHADOW_REASON_STATIC: STATIC, SHADOW_REASON_FRUSTUM: FRUSTUM } = SCL;

// ---------------------------------------------------------------------------
console.log("PART 1 — ?shadowCasterList across a restore");
// ---------------------------------------------------------------------------
{
  SCL.__setShadowStaticCacheOffForTest(true); // the plain single-pass wrapper
  const { canvas, renderer, entities, frame } = setup();
  check("installs on the boot map", SCL.installShadowCasterList(renderer, { force: true }) === true);
  let s = SCL.getShadowCasterListStats();
  frame(FRUSTUM);
  let s1 = SCL.getShadowCasterListStats();
  check("before the loss: a raster is served from the caster list", s1.walks === s.walks + 1 && s1.lastListed === 2,
    `walks +${s1.walks - s.walks}, listed=${s1.lastListed}`);

  const oldMap = renderer.shadowMap;
  quietRestore(canvas);
  const sm = renderer.shadowMap;
  check("three built a new WebGLShadowMap (the premise)", sm !== oldMap && sm.enabled === true &&
    sm.autoUpdate === false && sm.type === THREE.PCFShadowMap);
  check("the restored map is wrapped", !!sm.__hbCasterList && sm.render !== sm.__hbCasterList.orig,
    `own __hbCasterList=${!!sm.__hbCasterList}`);
  check("…around the restored map's own render, not the dead map's", !!sm.__hbCasterList &&
    sm.__hbCasterList.orig !== oldMap.render && sm.__hbCasterList.orig !== oldMap.__hbCasterList.orig);
  check("the dynamic root is carried over", sm.__hbShadowDynamicRoot === entities);
  s = SCL.getShadowCasterListStats();
  frame(MOVER);
  s1 = SCL.getShadowCasterListStats();
  check("first restored raster is served from the caster list (exactly one walk)",
    s1.walks === s.walks + 1 && s1.passthrough === s.passthrough && s1.lastListed === 2,
    `walks +${s1.walks - s.walks}, passthrough +${s1.passthrough - s.passthrough}, listed=${s1.lastListed}`);
  check("the dead map's stand-in root holds nothing", oldMap.__hbCasterList.root.children.length === 0);
  check("re-installs counted", s1.reinstalls === s.reinstalls && s1.reinstalls >= 1, `reinstalls=${s1.reinstalls}`);
  const wrapped = sm.render, saved = sm.__hbCasterList;
  check("installShadowCasterList on the restored map is idempotent",
    SCL.installShadowCasterList(renderer, { force: true }) === true && sm.render === wrapped && sm.__hbCasterList === saved);

  // A second loss/restore: wrapped again, once.
  const r0 = SCL.getShadowCasterListStats().reinstalls;
  quietRestore(canvas);
  const sm2 = renderer.shadowMap;
  check("a second restore wraps the next map, once", sm2 !== sm && !!sm2.__hbCasterList &&
    SCL.getShadowCasterListStats().reinstalls === r0 + 1);
  s = SCL.getShadowCasterListStats();
  frame(MOVER);
  s1 = SCL.getShadowCasterListStats();
  check("…and its rasters walk the list", s1.walks === s.walks + 1, `walks +${s1.walks - s.walks}`);

  // A restored non-PCF type: three's fresh map starts at PCFShadowMap, so its
  // first raster sees a type change (re-creates the maps, walks the scene for
  // recompiles) and must get the real scene.
  renderer.shadowMap.type = THREE.BasicShadowMap;
  frame(MOVER); // the type change on the live map: three's own pass
  quietRestore(canvas);
  check("restored type carried by three", renderer.shadowMap.type === THREE.BasicShadowMap);
  s = SCL.getShadowCasterListStats();
  frame(MOVER);
  s1 = SCL.getShadowCasterListStats();
  check("first raster on a restored non-PCF map goes to three unchanged", s1.passthrough === s.passthrough + 1 && s1.walks === s.walks,
    `passthrough +${s1.passthrough - s.passthrough}, walks +${s1.walks - s.walks}`);
  frame(MOVER);
  const s2 = SCL.getShadowCasterListStats();
  check("…then the list serves it again", s2.walks === s1.walks + 1, `walks +${s2.walks - s1.walks}`);

  SCL.uninstallShadowCasterList(renderer);
  const plain = renderer.shadowMap;
  quietRestore(canvas);
  check("after uninstall a restore does not re-wrap", renderer.shadowMap !== plain && !renderer.shadowMap.__hbCasterList);
  SCL.__setShadowStaticCacheOffForTest(false);
}

// ---------------------------------------------------------------------------
console.log("PART 2 — ?shadowStaticCache across a restore");
// ---------------------------------------------------------------------------
{
  SCL.__resetShadowStaticCacheForTest();
  const { gl, canvas, renderer, sun, frame } = setup();
  SCL.installShadowCasterList(renderer, { force: true });
  let errChecks = 0;
  const getError = gl.getError;
  gl.getError = function () { errChecks++; return getError.call(this); };
  const ssc = () => SCL.getShadowStaticCacheStats();
  frame(FRUSTUM); // NORMAL: no cache yet
  frame(STATIC); // REFRESH: statics pass, map -> cache
  let a = ssc();
  frame(MOVER); // OVERLAY: cache -> map, rigs on top
  let b = ssc();
  check("before the loss: refresh then overlay", a.refresh === 1 && b.overlay === 1 && b.rasters === 2 && b.errors === 0,
    JSON.stringify({ refresh: b.refresh, overlay: b.overlay, rasters: b.rasters, errors: b.errors, lastError: b.lastError }));
  frame(MOVER);
  const checksBefore = errChecks;
  frame(MOVER);
  check("…the first two blits were GL-error checked, later ones are not", checksBefore > 0 && errChecks === checksBefore,
    `getError calls ${checksBefore} -> ${errChecks}`);
  const st = SCL.__shadowStaticCacheStateForTest(sun);
  const oldFb = renderer.properties.get(st.rt).__webglFramebuffer;

  quietRestore(canvas);
  a = ssc();
  const e0 = errChecks;
  frame(MOVER); // rigs only moved — but the cache belongs to the dead context
  b = ssc();
  check("first mover raster after the restore runs the cache path", b.rasters === a.rasters + 1,
    `rasters +${b.rasters - a.rasters}`);
  check("…and REFRESHes instead of overlaying the dead context's cache", b.refresh === a.refresh + 1 && b.overlay === a.overlay,
    `refresh +${b.refresh - a.refresh}, overlay +${b.overlay - a.overlay}`);
  const newFb = renderer.properties.get(st.rt).__webglFramebuffer;
  check("the cache target has GL objects from the restored context", !!newFb && newFb !== oldFb);
  check("…its first blits on the restored context are GL-error checked", errChecks > e0, `getError calls +${errChecks - e0}`);
  a = ssc();
  frame(MOVER);
  b = ssc();
  check("the next mover raster overlays the rebuilt cache", b.overlay === a.overlay + 1 && b.refresh === a.refresh && b.errors === 0,
    `overlay +${b.overlay - a.overlay}, refresh +${b.refresh - a.refresh}, errors=${b.errors}`);
  check("the cache never stood down", !window.__shadowStaticCache?.broken && b.errors === 0, b.lastError || "");
  gl.getError = getError;
  SCL.uninstallShadowCasterList(renderer);
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

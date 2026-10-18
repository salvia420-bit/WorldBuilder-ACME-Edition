// tests/webgl_restore_render_patches.test.mjs — the default-on render patches
// across a WebGL context loss + restore (review 2026-10-18: RENDER-1, RENDER-2
// and the draw-sort extra).
//
// three r184's onContextRestore -> initGLContext builds a NEW WebGLProperties,
// WebGLCapabilities, WebGLInfo and program cache and assigns them to the
// renderer, on the SAME WebGL2RenderingContext object. This runs three's real
// WebGLRenderer over tests/helpers/fake_webgl2.mjs with a canvas that keeps its
// listeners, and fires three's own lost/restored handlers followed by ours:
//   1. ?asyncLink: a material first drawn after the restore draws (it was
//      deferred and compiled every frame and never drew); a material stamped
//      before the loss is deferred once instead of relinking synchronously in
//      the first restored frame, then draws; a version move after it draws.
//   2. ?texUnitPin / ?lightUbo: three's unit limit is put back to the one the
//      pins were planned for (no "Trying to use 31 texture units" warning per
//      upload), the restored programs are adopted in the restore event (light
//      blocks backed in the first restored frame), and a restored context with
//      a lower combined limit gets re-planned pins.
//   3. ?drawSortProgram: the comparator reads the restored renderer.info /
//      renderer.properties, so program keys refresh after the restore.
//
// Run:  cd apps/holtburger-web && node tests/webgl_restore_render_patches.test.mjs

globalThis.window ??= {};
window.location ??= { search: "" };
window.requestAnimationFrame ??= () => 0;

const THREE = await import("three");
const { createFakeWebGL2 } = await import("./helpers/fake_webgl2.mjs");
const { installAsyncLinkGuard } = await import("../scene3d/async_link_guard.js");
const { installUniformBindPatch, uniformBindPatchTick, installLightUboChunks } = await import("../scene3d/uniform_bind_patch.js");
const { makeProgramSort } = await import("../scene3d/draw_sort_program.js");

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A canvas that keeps its listeners, so three's (and the patches') context
 *  handlers can be fired the way the browser does: lost, then restored. */
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

/** A renderer the way scene3d/index.js builds it: three's unit limit raised
 *  to MAX_COMBINED_TEXTURE_IMAGE_UNITS at boot. */
function setup() {
  const gl = createFakeWebGL2({ maxTextures: 16, maxCombined: 32 });
  const canvas = restorableCanvas(gl);
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
  renderer.capabilities.maxTextures = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS);
  const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 1000);
  camera.position.set(0, 0, 5);
  return { gl, canvas, renderer, camera };
}

// three logs "Context Lost." / "Context Restored." through console.log.
const quietRestore = (canvas) => {
  const log = console.log;
  console.log = () => {};
  try { canvas.loseAndRestore(); } finally { console.log = log; }
};

// ---------------------------------------------------------------------------
console.log("PART 1 — ?asyncLink across a restore (RENDER-1)");
// ---------------------------------------------------------------------------
{
  const { canvas, renderer, camera } = setup();
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const a = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xff0000 }));
  scene.add(a);
  const guard = installAsyncLinkGuard(renderer, () => scene);
  // One frame: render, then let the guard's off-frame drain (setTimeout 0) and
  // readiness poll (10 ms) run, as the rAF gap does in the client.
  const frame = async () => { renderer.render(scene, camera); const calls = renderer.info.render.calls; await sleep(30); return calls; };
  let calls = 0;
  for (let i = 0; i < 6; i++) calls = await frame();
  check("before the loss: A draws", calls === 1 && a.material.__hbLinkOk === a.material.version, `calls=${calls}`);

  const oldProps = renderer.properties;
  quietRestore(canvas);
  check("three replaced renderer.properties on restore (the premise)", renderer.properties !== oldProps);
  const q0 = guard.stats.queued;
  const first = await frame();
  check("first restored frame: A (stamped before the loss) is deferred, not relinked synchronously",
    first === 0 && guard.stats.queued === q0 + 1, `calls=${first} queued+=${guard.stats.queued - q0}`);
  for (let i = 0; i < 4; i++) calls = await frame();
  check("…and draws again once its off-frame compile is ready", calls === 1, `calls=${calls}`);

  const b = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x00ff00 }));
  b.position.x = 1;
  scene.add(b);
  const c0 = guard.stats.compiled;
  for (let i = 0; i < 12; i++) calls = await frame();
  check("a material first drawn after the restore draws", calls === 2 && b.material.__hbLinkOk === b.material.version,
    `calls=${calls} stamped=${b.material.__hbLinkOk === b.material.version}`);
  check("…compiled once, not on every frame", guard.stats.compiled - c0 === 1, `compiles=${guard.stats.compiled - c0} over 12 frames`);
  check("no compile left counted in flight", guard.stats.inFlight === 0, `inFlight=${guard.stats.inFlight}`);

  a.material.needsUpdate = true;
  b.material.needsUpdate = true;
  for (let i = 0; i < 6; i++) calls = await frame();
  check("version moves after the restore draw again", calls === 2, `calls=${calls}`);

  // A compile in flight at the loss: its poll belongs to the dead context. The
  // in-flight count must come back to 0 (asyncLinkBusy() gates the fog probe).
  const c = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x0000ff }));
  c.position.x = -1;
  scene.add(c);
  renderer.render(scene, camera); // C queued
  await sleep(1); // the drain ran; its readiness poll (10 ms) has not
  const inFlightAtLoss = guard.stats.inFlight;
  quietRestore(canvas);
  check("a compile in flight at the loss is dropped from the in-flight count", inFlightAtLoss === 1 && guard.stats.inFlight === 0,
    `inFlight ${inFlightAtLoss} -> ${guard.stats.inFlight}`);
  for (let i = 0; i < 8; i++) calls = await frame();
  check("…and that material draws on the restored context", calls === 3 && guard.stats.inFlight === 0,
    `calls=${calls} inFlight=${guard.stats.inFlight}`);
  guard.uninstall();
}

// ---------------------------------------------------------------------------
console.log("PART 2 — ?texUnitPin + ?lightUbo across a restore (RENDER-2)");
// ---------------------------------------------------------------------------
{
  installLightUboChunks(THREE, { force: true }); // index.js preInit3D
  const { gl, canvas, renderer, camera } = setup();
  const api = installUniformBindPatch(renderer, { texUnitPin: true, lightUploadOnce: true, lightUbo: true });
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0x404040, 0.5));
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.set(10, 20, 5);
  scene.add(sun);
  const torch = new THREE.PointLight(0xffaa66, 1, 30, 2);
  torch.position.set(0, 3, 0);
  scene.add(torch);
  const tex = new THREE.DataTexture(new Uint8Array(16 * 4), 4, 4);
  tex.needsUpdate = true;
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ map: tex })));
  // index.js recordRenderDiag: uniformBindPatchTick at every render tail.
  const frame = () => { renderer.render(scene, camera); uniformBindPatchTick(renderer); };
  const warn = console.warn;
  const warns = [];
  console.warn = (...x) => { warns.push(String(x[0])); };
  try {
    for (let i = 0; i < 3; i++) frame();
    check("pins planned at the top of a 32-unit range", api.pinUnits.get("dfgLUT") === 31 && api.stats.programsPinned >= 1,
      JSON.stringify({ dfgLUT: api.pinUnits.get("dfgLUT"), pinned: api.stats.programsPinned }));
    check("no unit warning before the loss", warns.length === 0, warns[0]);

    quietRestore(canvas);
    check("restore: three's maxTextures is back at the limit the pins were planned for",
      renderer.capabilities.maxTextures === 32, `maxTextures=${renderer.capabilities.maxTextures}`);
    check("restore: the new programs array is adopted in the restore event, before any draw",
      api.stats.contextResets === 1 && Object.prototype.hasOwnProperty.call(renderer.info.programs, "push"),
      `contextResets=${api.stats.contextResets}`);
    const e0 = gl.__fake.uboErrors, pinned0 = api.stats.programsPinned;
    renderer.render(scene, camera); // the first restored frame, before its render tail
    check("first restored frame: every light block is backed by a buffer", gl.__fake.uboErrors === e0, gl.__fake.uboErrorLog.slice(-2).join("; "));
    uniformBindPatchTick(renderer);
    for (let i = 0; i < 3; i++) frame();
    check("no 'Trying to use N texture units' warning after the restore", warns.length === 0, `${warns.length} warnings, e.g. ${warns[0]}`);
    check("the restored lit programs are pinned again", api.stats.programsPinned > pinned0, `pinned ${pinned0} -> ${api.stats.programsPinned}`);
    check("no sampler-type collision on any unit", gl.__fake.unitConflicts === 0, gl.__fake.conflictLog.join("; "));

    // A restore onto a context with a LOWER combined limit (another adapter):
    // never set three's limit past it — re-plan the pins for it instead.
    const getParameter = gl.getParameter;
    gl.getParameter = function (p) { return p === gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS ? 24 : getParameter.call(this, p); };
    quietRestore(canvas);
    check("lower combined limit after a restore: three's limit follows it", renderer.capabilities.maxTextures === 24,
      `maxTextures=${renderer.capabilities.maxTextures}`);
    check("…and the pins are re-planned under it", api.pinUnits.get("dfgLUT") === 23 && api.stats.maxTextures === 24,
      `dfgLUT=${api.pinUnits.get("dfgLUT")}`);
    for (let i = 0; i < 3; i++) frame();
    check("…with no unit warning", warns.length === 0, warns[0]);
    gl.getParameter = getParameter;
  } finally {
    console.warn = warn;
  }
}

// ---------------------------------------------------------------------------
console.log("PART 3 — ?drawSortProgram across a restore (extra)");
// ---------------------------------------------------------------------------
{
  const { canvas, renderer, camera } = setup();
  const sort = makeProgramSort(renderer);
  renderer.setOpaqueSort(sort);
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const a = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
  const b = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  b.position.x = 1;
  scene.add(a, b);
  const item = (m, id) => ({ id, groupOrder: 0, renderOrder: 0, material: m.material, materialVariant: 0, z: 0 });
  const progId = (m) => renderer.properties.get(m.material).currentProgram.id;
  // Link A's program first, then B's: A's id is the lower one.
  b.visible = false; renderer.render(scene, camera);
  b.visible = true; renderer.render(scene, camera); renderer.render(scene, camera);
  check("before the loss: A sorts ahead of B (lower program id)", progId(a) < progId(b) && sort(item(a, 0), item(b, 1)) < 0);
  quietRestore(canvas);
  // Relink in the opposite order on the restored context.
  a.visible = false; renderer.render(scene, camera);
  a.visible = true; renderer.render(scene, camera); renderer.render(scene, camera);
  check("after the restore B's new program id is the lower one (the premise)", progId(b) < progId(a));
  check("the comparator follows the restored programs (B ahead of A)", sort(item(a, 0), item(b, 1)) > 0,
    `sort(A,B)=${sort(item(a, 0), item(b, 1))}`);
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

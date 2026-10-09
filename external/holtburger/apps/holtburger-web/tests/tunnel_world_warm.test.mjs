// 2026-10-09 (D2) — programs that still linked at first draw on a cold academy
// spawn (1070, acad-diagF --linkmap), and the three default-on flags that move
// them off the frame:
//   ?tunnelWorldWarm  scene3d/portal_space.js  warmWorldPrograms + release hold
//                     (EffectMaterial 512 ms + bloom/luminance siblings at the
//                     login tunnel's reveal: the composer's first frame)
//   ?pmremPrecompile  scene3d/ibl_environment.js warmPrograms + refresh gate
//                     (first IBL refresh: PMREMGGXConvolution 761 ms, SkyMaterial
//                     120, SphericalGaussianBlur 104; second refresh: the moons
//                     314 ms + StarsMaterial 113 ms, all inside tickPerFrame)
//   ?asyncLinkFar     scene3d/async_link_guard.js asyncLinkEligible
//                     (far-terrain-33-0 202 ms at its first draw)
// plus the shared helpers in scene3d/shader_prewarm.js.
//
// Real three (node_modules) + a fake renderer whose compile() keys a program on
// the bound target class (null vs non-null), the target scene's light count and
// fog — the three r184 axes these warms must get right.
// Run:
//   cd apps/holtburger-web/
//   node tests/tunnel_world_warm.test.mjs

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

globalThis.window = globalThis;
globalThis.location = { search: "", href: "http://test/index.html", reload() {} };
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, setAttribute() {}, textContent: "" }),
  body: { appendChild() {} },
};

const THREE = await import("three");
const SP = await import("../scene3d/shader_prewarm.js");
const ps = await import("../scene3d/portal_space.js");
const { IblEnvironment, readPmremPrecompileFlag, PMREM_WAIT_MAX_MS, PMREM_WARM_LEAD_MS } = await import("../scene3d/ibl_environment.js");
const ALG = await import("../scene3d/async_link_guard.js");
const { TAS } = ps;

// ── fake renderer ─────────────────────────────────────────────────────────
function makeRenderer() {
  const props = new WeakMap();
  // material -> boolean; absent = ready unless its NAME is in `slow` (a program
  // three creates still linking — KHR_parallel_shader_compile — until set ready).
  const ready = new Map();
  const slow = new Set();
  const r = {
    _rt: null,
    calls: [],
    ready,
    slow,
    properties: { get(m) { let p = props.get(m); if (!p) { p = {}; props.set(m, p); } return p; } },
    getRenderTarget() { return this._rt; },
    setRenderTarget(t) { this._rt = t ?? null; },
    getActiveCubeFace() { return 0; },
    getActiveMipmapLevel() { return 0; },
    render() {},
    compile(root, camera, targetScene = null) {
      const ts = targetScene ?? root;
      const lights = [];
      ts.traverseVisible?.((o) => { if (o.isLight) lights.push(o); });
      const set = new Set();
      root.traverse((o) => {
        if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (!m) continue;
          const mp = this.properties.get(m);
          if (!mp.programs) mp.programs = new Map();
          const key = `${this._rt ? "rt" : "canvas"}|L${lights.length}|${ts.isScene && ts.fog ? "fog" : "nofog"}`;
          if (!mp.programs.has(key)) mp.programs.set(key, { key, usedTimes: 1, isReady: () => ready.get(m) ?? !slow.has(m.name) });
          mp.currentProgram = mp.programs.get(key);
          set.add(m);
        }
      });
      this.calls.push({ target: this._rt, ts, lights: lights.length, names: [...set].map((m) => m.name || m.type) });
      return set;
    },
  };
  return r;
}
const callFor = (r, name) => r.calls.filter((c) => c.names.includes(name));
const keysOf = (r, m) => [...(r.properties.get(m).programs?.keys() ?? [])];

console.log("PART 1 — flag readers");
{
  const m = ps.tunnelWorldWarmMode;
  check("tunnelWorldWarm absent ⇒ on", m("") === "on");
  check("tunnelWorldWarm on / garbage ⇒ on", m("?tunnelWorldWarm=on") === "on" && m("?tunnelWorldWarm=x") === "on");
  check("tunnelWorldWarm nohold ⇒ nohold", m("?tunnelWorldWarm=nohold") === "nohold");
  check("tunnelWorldWarm off/0/false/no ⇒ off", ["off", "0", "false", "no", "OFF"].every((v) => m(`?tunnelWorldWarm=${v}`) === "off"));
  const p = readPmremPrecompileFlag;
  check("pmremPrecompile absent ⇒ on", p("") === true);
  check("pmremPrecompile off/0/false/no ⇒ off", ["off", "0", "false", "no"].every((v) => p(`?pmremPrecompile=${v}`) === false));
  check("asyncLinkFar default on", ALG.asyncLinkFarEnabled() === true);
}

console.log("PART 2 — shader_prewarm helpers");
{
  const r = makeRenderer();
  const prev = { name: "composer-in" };
  r._rt = prev;
  const mat = new THREE.ShaderMaterial({ name: "fs" });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  const set = SP.compileWithTarget(r, mesh, new THREE.OrthographicCamera(), null, null);
  check("compileWithTarget binds the CANVAS (null) when asked", r.calls[0].target === null && set.has(mat));
  check("…and restores the previous target", r._rt === prev);
  SP.compileWithTarget(r, mesh, new THREE.OrthographicCamera(), null, SP.getWarmTarget());
  check("…or the shared non-null warm target", r.calls[1].target === SP.getWarmTarget() && keysOf(r, mat).length === 2);
  check("programsOf returns every program the material owns (both variants)", SP.programsOf(r, mat).length === 2);
  check("compileWithTarget without setRenderTarget ⇒ null (never compiles an unknown variant)",
    SP.compileWithTarget({ compile() { return new Set(); } }, mesh, {}, null, null) === null);
  const pend = { isReady: () => false, usedTimes: 1 };
  check("programPending: isReady false ⇒ pending", SP.programPending(pend) === true);
  check("…isReady true / null (lost context) ⇒ done", !SP.programPending({ isReady: () => true }) && !SP.programPending({ isReady: () => null }));
  check("…released program (usedTimes 0) ⇒ done", !SP.programPending({ isReady: () => false, usedTimes: 0 }));
  check("…throwing poll ⇒ done", !SP.programPending({ isReady: () => { throw new Error("x"); } }));
  const s = new Set([pend, { isReady: () => true }]);
  check("prunePending keeps only the linking ones", SP.prunePending(s) === 1 && s.has(pend));
  // warmSceneMaterials: one compile, stand-in carries fog + visible lights, memo.
  const sc = new THREE.Scene();
  sc.fog = new THREE.Fog(0xffffff, 1, 2);
  const lamp = new THREE.DirectionalLight();
  const hiddenLamp = new THREE.PointLight();
  hiddenLamp.visible = false;
  sc.add(lamp, hiddenLamp);
  const a = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ name: "a" }));
  const hiddenGroup = new THREE.Group();
  hiddenGroup.visible = false;
  const b = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({ name: "b" }));
  hiddenGroup.add(b);
  const skipMe = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({ name: "skip" }));
  skipMe.userData.skipMe = true;
  sc.add(a, hiddenGroup, skipMe);
  const r2 = makeRenderer();
  const seen = new WeakMap();
  const cam = new THREE.PerspectiveCamera();
  const res = SP.warmSceneMaterials(r2, sc, cam, SP.getWarmTarget(), { seen, skip: (o) => o.userData.skipMe === true });
  check("warmSceneMaterials: ONE compile() for the scene", r2.calls.length === 1, JSON.stringify(r2.calls.map((c) => c.names)));
  check("…hidden objects are compiled too (shown later), skipped subtrees are not",
    res.materials.has(b.material) && res.materials.has(a.material) && !res.materials.has(skipMe.material));
  check("…against the scene's fog and only the VISIBLE lights", r2.calls[0].lights === 1 && keysOf(r2, a.material)[0] === "rt|L1|fog");
  check("…with the non-null target bound", r2.calls[0].target === SP.getWarmTarget());
  const again = SP.warmSceneMaterials(r2, sc, cam, SP.getWarmTarget(), { seen, skip: (o) => o.userData.skipMe === true });
  check("a second pass with nothing new compiles nothing", again.compiled === 0 && r2.calls.length === 1);
  a.material.needsUpdate = true;
  const third = SP.warmSceneMaterials(r2, sc, cam, SP.getWarmTarget(), { seen, skip: (o) => o.userData.skipMe === true });
  check("a version bump recompiles just that material", third.compiled === 1 && third.materials.has(a.material));
  sc.add(new THREE.PointLight());
  const fourth = SP.warmSceneMaterials(r2, sc, cam, SP.getWarmTarget(), { seen });
  check("a light-count change recompiles everything (the key's light bits moved)", fourth.compiled >= 2);
  const capped = SP.warmSceneMaterials(makeRenderer(), sc, cam, SP.getWarmTarget(), { seen: new WeakMap(), maxNew: 1 });
  check("maxNew caps the materials per pass (rest deferred)", capped.compiled === 1 && capped.deferred >= 1);
}

console.log("PART 3 — ?asyncLinkFar: far-terrain patches join the async-link guard");
{
  const E = ALG.asyncLinkEligible;
  check("Mesh*Material eligible", E({ type: "MeshStandardMaterial", userData: {} }));
  check("far-terrain-33-0 ShaderMaterial eligible", E({ type: "ShaderMaterial", name: "far-terrain-33-0", userData: {} }));
  check("far-terrain-bake / far-terrain base / plain ShaderMaterial NOT eligible",
    !E({ type: "ShaderMaterial", name: "far-terrain-bake", userData: {} }) && !E({ type: "ShaderMaterial", name: "far-terrain", userData: {} })
    && !E({ type: "ShaderMaterial", name: "", userData: {} }) && !E({ type: "RawShaderMaterial", name: "far-terrain-1-2", userData: {} }));
  check("explicit userData.__asyncLink opt-in eligible", E({ type: "ShaderMaterial", name: "x", userData: { __asyncLink: true } }));
  check("__noAsyncLink always wins", !E({ type: "ShaderMaterial", name: "far-terrain-1-2", userData: { __noAsyncLink: true } }));
  // The wrapper: a far patch's first draw is skipped and compiled off-frame.
  const props = new WeakMap();
  const draws = [];
  const scene = { isScene: true };
  const rr = {
    properties: { get(m) { let p = props.get(m); if (!p) { p = {}; props.set(m, p); } return p; } },
    renderBufferDirect(c, s, g, material, object) { draws.push(object.name); this.properties.get(material).__version = material.version; },
    compile(root) { const set = new Set(); root.traverse((o) => { set.add(o.material); this.properties.get(o.material).currentProgram = { isReady: () => true }; }); return set; },
  };
  const api = ALG.installAsyncLinkGuard(rr, () => scene);
  const far = { type: "ShaderMaterial", name: "far-terrain-33-0", version: 0, userData: {} };
  rr.renderBufferDirect({}, scene, {}, far, { name: "far-patch-33-0", material: far }, null);
  check("first draw of a far patch is deferred", draws.length === 0 && api.stats.deferred === 1);
  check("api.guards() reports it (portal_space holds only on what it does NOT guard)", api.guards(far) === true && api.guards({ type: "ShaderMaterial", name: "sky", userData: {} }) === false);
  await new Promise((res) => setTimeout(res, 60));
  rr.renderBufferDirect({}, scene, {}, far, { name: "far-patch-33-0", material: far }, null);
  check("…drawn once the guard's off-frame compile is ready", draws.includes("far-patch-33-0"));
  const plain = { type: "ShaderMaterial", name: "terrain-batch", version: 0, userData: {} };
  rr.renderBufferDirect({}, scene, {}, plain, { name: "terrain", material: plain }, null);
  check("other ShaderMaterials draw untouched", draws.includes("terrain"));
  api.off = true;
  check("guards() is false while the guard is switched off", api.guards(far) === false);
  api.uninstall();
  location.search = "?asyncLinkFar=off";
  const ALG2 = await import("../scene3d/async_link_guard.js?farOff");
  location.search = "";
  check("?asyncLinkFar=off ⇒ far patches are not eligible (today)", ALG2.asyncLinkFarEnabled() === false
    && !ALG2.asyncLinkEligible({ type: "ShaderMaterial", name: "far-terrain-33-0", userData: {} })
    && ALG2.asyncLinkEligible({ type: "MeshBasicMaterial", userData: {} }));
}

// ── a world: composer with sky / world / cells scene passes, an effect pass
//    with bloom-like nested passes, a final pass to the canvas ──────────────
function makeWorld(r) {
  const main = new THREE.Scene();
  main.fog = new THREE.Fog(0xc3c8dc, 200, 2500);
  main.add(new THREE.DirectionalLight());
  const g = new THREE.BufferGeometry();
  const std = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ name: "scene3d-surface-08000003" }));
  const farMat = new THREE.ShaderMaterial({ name: "far-terrain-33-0" });
  const farGroup = new THREE.Group();
  farGroup.visible = false; // hidden indoors — still compiled
  farGroup.add(new THREE.Mesh(g, farMat));
  const terrain = new THREE.Mesh(g, new THREE.ShaderMaterial({ name: "terrain-batch" }));
  main.add(std, farGroup, terrain);
  const sky = new THREE.Scene();
  sky.add(new THREE.Mesh(g, new THREE.ShaderMaterial({ name: "SkyMaterial" })));
  const overlay = new THREE.Mesh(g, new THREE.ShaderMaterial({ name: "cloud-overlay" }));
  overlay.userData.__clipSpaceOverlay = true;
  sky.add(overlay);
  const cam = new THREE.PerspectiveCamera();
  const skyCam = new THREE.PerspectiveCamera();
  const mk = (name) => new THREE.ShaderMaterial({ name });
  const fx = { effMat: mk("EffectMaterial-fx"), lum: mk("LuminanceMaterial"), down: mk("DownsamplingMaterial"), up: mk("UpsamplingMaterial"), fin: mk("EffectMaterial-final") };
  const bloom = {
    name: "BloomEffect",
    luminancePass: { name: "LuminancePass", render() {}, needsSwap: false, fullscreenMaterial: fx.lum },
    mipmapBlurPass: { name: "MipmapBlurPass", render() {}, needsSwap: false, fullscreenMaterial: fx.down, downsamplingMaterial: fx.down, upsamplingMaterial: fx.up },
  };
  const composer = {
    passes: [
      { name: "RenderPass", scene: sky, camera: skyCam, fullscreenMaterial: null, renderToScreen: false, render() {} },
      { name: "CameraLayerMask", scene: new THREE.Scene(), camera: cam, fullscreenMaterial: null, renderToScreen: false, render() {} },
      { name: "RenderPass", scene: main, camera: cam, fullscreenMaterial: null, renderToScreen: false, render() {} },
      { name: "RenderPass", scene: main, camera: cam, fullscreenMaterial: null, renderToScreen: false, render() {} },
      { name: "EffectPass", fullscreenMaterial: fx.effMat, renderToScreen: false, needsSwap: true, effects: [bloom], render() {} },
      { name: "EffectPass", fullscreenMaterial: fx.fin, renderToScreen: true, needsSwap: true, effects: [], render() {} },
    ],
    inputBuffer: { name: "EffectComposer.Buffer" },
  };
  const ibl = { calls: 0, warmPrograms() { this.calls += 1; return []; } };
  const sc = {
    renderer: r, scene: main, camera: cam,
    atmospherePipeline: { composer },
    iblEnvironment: ibl,
    cellContainers3d: new Map(), terrainBakedLbs: new Set(), envCellBuildInFlight: new Set(),
  };
  return { sc, main, sky, std, farMat, terrain, overlay, fx, ibl };
}

console.log("PART 4 — warmWorldPrograms: the right target per draw");
{
  const r = makeRenderer();
  r.__hbAsyncLink = { off: false, guards: (m) => ALG.asyncLinkEligible(m) };
  const w = makeWorld(r);
  const res = ps.warmWorldPrograms(w.sc);
  const fin = callFor(r, "EffectMaterial-fin".replace("-fin", "-final"));
  check("the final (renderToScreen) pass compiles with the CANVAS bound", fin.length === 1 && fin[0].target === null);
  check("…its key is the canvas variant", keysOf(r, w.fx.fin)[0].startsWith("canvas|"));
  for (const [n, m] of [["intermediate EffectPass", w.fx.effMat], ["bloom LuminanceMaterial", w.fx.lum], ["bloom Downsampling", w.fx.down], ["bloom Upsampling", w.fx.up]]) {
    check(`${n} compiles into a non-null (composer-class) target`, keysOf(r, m).length === 1 && keysOf(r, m)[0].startsWith("rt|"), keysOf(r, m).join());
  }
  const mainCalls = r.calls.filter((c) => c.names.includes("terrain-batch"));
  check("the main scene compiles ONCE although two passes render it", mainCalls.length === 1);
  check("…into the composer-class target, with the scene's fog and lights", mainCalls[0].target !== null && keysOf(r, w.terrain.material)[0] === "rt|L1|fog");
  check("…including the far-terrain patch hidden indoors", keysOf(r, w.farMat)[0] === "rt|L1|fog");
  check("the composer's sky pass compiles the sky (overlay included: that pass draws it)",
    keysOf(r, w.sky.children[0].material).length === 1 && keysOf(r, w.overlay.material).length === 1);
  check("the IBL's sky / PMREM warm is driven too", w.ibl.calls === 1);
  check("counters", res.passes === 6 && res.compiled >= 9, JSON.stringify(res));
  // Hold set: only programs the guard would NOT defer.
  r.ready.set(w.terrain.material, false);
  r.ready.set(w.farMat, false);
  r.ready.set(w.std.material, false);
  w.terrain.material.needsUpdate = true;
  w.farMat.needsUpdate = true;
  w.std.material.needsUpdate = true;
  const res2 = ps.warmWorldPrograms(w.sc);
  check("held: the unguarded terrain ShaderMaterial only (Mesh* + far patch are the guard's)", res2.held === 1, JSON.stringify(res2));
  const before = r.calls.length;
  ps.warmWorldPrograms(w.sc);
  check("a pass with nothing new compiles nothing", r.calls.length === before);
  r.ready.clear();
  ps.warmWorldPrograms(w.sc);
  // A pass switched off right now (sky pass indoors, an effect pass toggled
  // off): its materials are warmed for later but never hold the release.
  const flare = new THREE.ShaderMaterial({ name: "LensFlareMaterial" });
  const offSky = new THREE.Scene();
  const offSkyMat = new THREE.ShaderMaterial({ name: "OffSky" });
  offSky.add(new THREE.Mesh(new THREE.BufferGeometry(), offSkyMat));
  w.sc.atmospherePipeline.composer.passes.push(
    { name: "EffectPass", fullscreenMaterial: flare, renderToScreen: false, enabled: false, needsSwap: true, effects: [], render() {} },
    { name: "RenderPass", scene: offSky, camera: new THREE.PerspectiveCamera(), fullscreenMaterial: null, renderToScreen: false, enabled: false, render() {} },
  );
  r.ready.set(flare, false);
  r.ready.set(offSkyMat, false);
  const res4 = ps.warmWorldPrograms(w.sc);
  check("a disabled pass is warmed…", keysOf(r, flare).length === 1 && keysOf(r, offSkyMat).length === 1);
  check("…but its still-linking programs are not held", res4.held === 0, JSON.stringify(res4));
  w.sc.atmospherePipeline.composer.passes.length -= 2;
  r.ready.clear();
  // No composer yet (pre-bake window): the main scene is NOT compiled for the canvas.
  const r3 = makeRenderer();
  const w3 = makeWorld(r3);
  w3.sc.atmospherePipeline = null;
  ps.warmWorldPrograms(w3.sc);
  check("no composer ⇒ the main scene is left for a later pass (no canvas-variant warm)", !r3.calls.some((c) => c.names.includes("terrain-batch")));
  check("no renderer ⇒ null", ps.warmWorldPrograms({}) === null);
}

const run = (sc, secs, dt = 0.05) => { for (let t = 0; t < secs - 1e-9; t += dt) ps.tickPortalSpace(sc, dt); };
const diag = () => globalThis.__portalSpace || {};
const quietWarn = (fn) => { const w0 = console.warn, i0 = console.info; console.warn = () => {}; console.info = () => {}; try { return fn(); } finally { console.warn = w0; console.info = i0; } };

console.log("PART 5 — while the tunnel owns the frame: every ~1 s, bounded release hold");
{
  const r = makeRenderer();
  const w = makeWorld(r);
  r.ready.set(w.fx.fin, false); // the reveal-frame EffectMaterial is still linking
  quietWarn(() => ps.startPortalSpace(w.sc, { enterDid: 0, exitDid: 0 }));
  ps.tickPortalSpace(w.sc, 0.05);
  check("first owning tick runs a warm pass", diag().warm?.passes === 1 && diag().warm?.mode === "on", JSON.stringify(diag().warm));
  run(w.sc, 0.5);
  check("…none again within the 1 s interval", diag().warm.passes === 1);
  run(w.sc, 0.6);
  check("…the next one after ~1 s (new materials picked up)", diag().warm.passes === 2);
  w.main.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({ name: "late-water" })));
  run(w.sc, 1.0);
  check("a material attached during the tunnel is compiled by the next pass", callFor(r, "late-water").length === 1);
  ps.signalPortalArrived({ cellId: 0x01d90123 });
  w.sc.cellContainers3d.set(0x01d90123, {});
  ps.tickPortalSpace(w.sc, 0.05);
  check("cells ready but an unguarded program still linking ⇒ held in TUNNEL, reason 'warming'",
    diag().state === TAS.TUNNEL && diag().reason === "warming", `${diag().state} ${diag().reason}`);
  run(w.sc, 0.5);
  check("…still held at +0.5 s", diag().state === TAS.TUNNEL);
  r.ready.set(w.fx.fin, true);
  ps.tickPortalSpace(w.sc, 0.05);
  check("linked ⇒ released at once", diag().state !== TAS.TUNNEL, String(diag().state));
  check("…hold recorded (~0.55 s), not capped", diag().warm.holdMs >= 500 && diag().warm.holdMs <= 700 && diag().warm.holdCapped === false, JSON.stringify(diag().warm));
  run(w.sc, 8);
  check("teleport completes", !ps.isPortalSpaceActive());
  quietWarn(() => ps.endPortalSpace());
}
{
  const r = makeRenderer();
  const w = makeWorld(r);
  r.ready.set(w.fx.fin, false); // never links
  quietWarn(() => ps.startPortalSpace(w.sc, { enterDid: 0, exitDid: 0 }));
  ps.tickPortalSpace(w.sc, 0.05);
  ps.signalPortalArrived({ cellId: 0x01d90123 });
  w.sc.cellContainers3d.set(0x01d90123, {});
  run(w.sc, 1.4);
  check("never linking: held up to the cap", diag().state === TAS.TUNNEL && diag().reason === "warming");
  run(w.sc, 0.2);
  check(`…released by the ${ps.WARM_HOLD_MAX_S} s cap (capped flag)`, diag().state !== TAS.TUNNEL && diag().warm.holdCapped === true, JSON.stringify(diag().warm));
  quietWarn(() => ps.endPortalSpace());
}
{
  location.search = "?tunnelWorldWarm=nohold";
  const r = makeRenderer();
  const w = makeWorld(r);
  r.ready.set(w.fx.fin, false);
  quietWarn(() => ps.startPortalSpace(w.sc, { enterDid: 0, exitDid: 0 }));
  ps.tickPortalSpace(w.sc, 0.05);
  ps.signalPortalArrived({ cellId: 0x01d90123 });
  w.sc.cellContainers3d.set(0x01d90123, {});
  ps.tickPortalSpace(w.sc, 0.05);
  check("nohold: warms, but releases as soon as the cells are ready", diag().warm.passes >= 1 && diag().state !== TAS.TUNNEL);
  quietWarn(() => ps.endPortalSpace());
  location.search = "?tunnelWorldWarm=off";
  const r2 = makeRenderer();
  const w2 = makeWorld(r2);
  r2.ready.set(w2.fx.fin, false);
  quietWarn(() => ps.startPortalSpace(w2.sc, { enterDid: 0, exitDid: 0 }));
  run(w2.sc, 2.5);
  ps.signalPortalArrived({ cellId: 0x01d90123 });
  w2.sc.cellContainers3d.set(0x01d90123, {});
  ps.tickPortalSpace(w2.sc, 0.05);
  check("off: no compile at all during the tunnel (today)", r2.calls.length === 0 && w2.ibl.calls === 0);
  check("off: releases on cells-ready as before", diag().state !== TAS.TUNNEL && diag().warm.mode === "off");
  quietWarn(() => ps.endPortalSpace());
  location.search = "";
}
{
  // Login warm-path backstop is untouched by the hold: resident within 0.3 s ⇒ ends at once.
  const r = makeRenderer();
  const w = makeWorld(r);
  r.ready.set(w.fx.fin, false);
  ps.requestLoginPortalSpace(w.sc, { cellId: 0x860201ad });
  ps.tickPortalSpace(w.sc, 1 / 60);
  check("login tunnel up (cold)", ps.isPortalSpaceActive() && diag().login === true);
  w.sc.cellContainers3d.set(0x860201ad, {});
  quietWarn(() => ps.tickPortalSpace(w.sc, 1 / 60));
  check("resident-late backstop still ends at once despite a linking program", !ps.isPortalSpaceActive() && diag().loginSkip === "resident-late");
  // Cold login: the warm runs throughout; the release is not held once linked.
  const r2 = makeRenderer();
  const w2 = makeWorld(r2);
  w2.sc.envCellBuildInFlight.add(0x86020000);
  ps.requestLoginPortalSpace(w2.sc, { cellId: 0x860201ad });
  ps.tickPortalSpace(w2.sc, 1 / 60);
  quietWarn(() => run(w2.sc, 8));
  check("cold login: a warm pass about every second of the hold", diag().warm.passes >= 8 && diag().reason === "login-building", JSON.stringify({ p: diag().warm.passes, r: diag().reason }));
  w2.sc.cellContainers3d.set(0x860201ad, {});
  quietWarn(() => ps.tickPortalSpace(w2.sc, 1 / 60));
  check("…nothing linking at ready ⇒ no hold (released on the same tick)", diag().state !== TAS.TUNNEL && diag().warm.holdMs === 0);
  quietWarn(() => run(w2.sc, 3));
  quietWarn(() => ps.endPortalSpace());
}

console.log("PART 6 — ?pmremPrecompile: IblEnvironment.warmPrograms + the refresh gate");
function makeIbl(r, extra = {}) {
  const scene = new THREE.Scene();
  const sky = new THREE.Scene();
  const skyMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({ name: "SkyMaterial" }));
  const overlay = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({ name: "cloud-overlay" }));
  overlay.userData.__clipSpaceOverlay = true;
  sky.add(skyMesh, overlay);
  const ibl = new IblEnvironment({ renderer: r, scene, skyScene: sky, ...extra });
  const counts = { fromScene: 0, cube: 0 };
  ibl._pmrem.fromScene = () => { counts.fromScene += 1; return { texture: { isTexture: true }, dispose() {} }; };
  ibl._renderTerrainCube = (now) => { counts.cube += 1; ibl._lastCubeMs = now; };
  return { ibl, sky, skyMesh, overlay, counts };
}
{
  const r = makeRenderer();
  const t = makeIbl(r);
  const pm = t.ibl._pmrem;
  const names = r.calls.filter((c) => c.target !== null).flatMap((c) => c.names);
  check("boot: PMREM internals reached (three r184 _allocateTargets)", t.ibl.warmStats.pmremInternals === true && !!pm._ggxMaterial && !!pm._blurMaterial);
  check("boot: GGX + blur + PMREM.Background compiled into a non-null target",
    names.includes("PMREMGGXConvolution") && names.includes("SphericalGaussianBlur") && names.includes("PMREM.Background"), names.join());
  check("…and the sky scene, clip-space overlay excluded (the PMREM hides it)", names.includes("SkyMaterial") && !names.includes("cloud-overlay"));
  // r184 keys `vertexNormals: !!geometry.attributes.normal`: three's background
  // box is a BoxGeometry (normal present), its GGX / blur lod planes have none.
  const geomOf = (m) => t.ibl._warmMeshes?.get(m)?.geometry?.attributes ?? {};
  check("PMREM.Background proxy is drawn on a box (normal attribute ⇒ same vertexNormals key bit as three's)",
    !!geomOf(t.ibl._bgProxy).normal && !!geomOf(t.ibl._bgProxy).position);
  check("…GGX / blur proxies carry no normal (as three's lod planes)", !geomOf(pm._ggxMaterial).normal && !geomOf(pm._blurMaterial).normal);
  check("the pre-allocated targets are the ones fromScene will reuse (768×1024 ping-pong)",
    pm._pingPongRenderTarget?.width === 768 && pm._pingPongRenderTarget?.height === 1024);
}
{
  const r = makeRenderer();
  // GGX still linking at the first refresh (as on the 1070: ~760 ms in the GPU process).
  r.slow.add("PMREMGGXConvolution");
  const t = makeIbl(r);
  const ggx = t.ibl._pmrem._ggxMaterial;
  check("boot: the linking GGX program is tracked", t.ibl.warmStats.pending === 1, JSON.stringify(t.ibl.warmStats));
  t.ibl.tick(1000, []);
  check("first refresh due while GGX links ⇒ it waits (no fromScene)", t.counts.fromScene === 0 && t.ibl.warmStats.waitTicks === 1);
  t.ibl.tick(1500, []);
  check("…still waiting at +500 ms", t.counts.fromScene === 0);
  r.ready.set(ggx, true);
  t.ibl.tick(1600, []);
  check("linked ⇒ refresh runs (once)", t.counts.fromScene === 1 && t.ibl.refreshCount === 1);
  check("firstWaitMs recorded", t.ibl.warmStats.firstWaitMs === 600, String(t.ibl.warmStats.firstWaitMs));
  // A moon arrives between refreshes: the lead warm compiles it before the next refresh is due.
  const moonMat = new THREE.ShaderMaterial({ name: "ac-moon", side: THREE.DoubleSide });
  t.sky.add(new THREE.Mesh(new THREE.BufferGeometry(), moonMat));
  r.ready.set(moonMat, false);
  t.ibl.tick(1600 + 5000, []);
  check("no early warm far from the next refresh", callFor(r, "ac-moon").length === 0);
  t.ibl.tick(1600 + t.ibl.refreshMs - PMREM_WARM_LEAD_MS + 10, []);
  check(`lead warm (${PMREM_WARM_LEAD_MS} ms before due) compiles the new moon`, callFor(r, "ac-moon").length === 1 && callFor(r, "ac-moon")[0].target !== null);
  t.ibl.tick(1600 + t.ibl.refreshMs, []);
  check("due while the moon still links ⇒ waits", t.counts.fromScene === 1);
  r.ready.set(moonMat, true);
  t.ibl.tick(1600 + t.ibl.refreshMs + 100, []);
  check("…then refreshes", t.counts.fromScene === 2);
}
{
  const r = makeRenderer();
  r.slow.add("PMREMGGXConvolution"); // never links
  const t = makeIbl(r);
  t.ibl.tick(0, []);
  t.ibl.tick(PMREM_WAIT_MAX_MS - 1, []);
  check("never linking: waits up to the cap", t.counts.fromScene === 0);
  t.ibl.tick(PMREM_WAIT_MAX_MS, []);
  check(`…refreshes at the ${PMREM_WAIT_MAX_MS} ms cap (waitCapped)`, t.counts.fromScene === 1 && t.ibl.warmStats.waitCapped === 1);
}
{
  // The clouds cube (1 Hz) waits too — it renders the same sky scene.
  const r = makeRenderer();
  const t = makeIbl(r, { camera: new THREE.PerspectiveCamera(), getCloudsBuffer: () => ({ isTexture: true }) });
  t.ibl.tick(0, []);
  const cube0 = t.counts.cube;
  const lateStar = new THREE.ShaderMaterial({ name: "StarsMaterial" });
  t.sky.add(new THREE.Points(new THREE.BufferGeometry(), lateStar));
  r.ready.set(lateStar, false);
  t.ibl.tick(1100, []);
  check("clouds cube update waits while a sky program links", t.counts.cube === cube0, `${cube0} → ${t.counts.cube}`);
  r.ready.set(lateStar, true);
  t.ibl.tick(1200, []);
  check("…and runs once linked", t.counts.cube === cube0 + 1);
}
{
  location.search = "?pmremPrecompile=off";
  const r = makeRenderer();
  const t = makeIbl(r);
  location.search = "";
  check("off: no warm at construction (only three's own compileCubemapShader, canvas-bound)",
    t.ibl.pmremPrecompile === false && r.calls.every((c) => c.target === null) && t.ibl.warmStats.calls === 0);
  r.ready.set(t.skyMesh.material, false);
  t.ibl.tick(1000, []);
  check("off: the first refresh runs at once (today)", t.counts.fromScene === 1 && t.ibl.warmStats.waitTicks === 0);
  const res = t.ibl.warmPrograms();
  check("off: the tunnel warm still warms the sky (not the PMREM internals)",
    callFor(r, "SkyMaterial").some((c) => c.target !== null) && !callFor(r, "PMREMGGXConvolution").length && Array.isArray(res));
}

console.log("PART 7 — the tunnel's own programs (?portalSpacePrecompile) link first");
{
  const r = makeRenderer();
  const w = makeWorld(r);
  w.sc.wasmExports = { resolveClientEnumDid: async () => 0x2000004b }; // builds an (empty) tunnel scene
  let tunnelLinked = false;
  const tunnelMat = { name: "tunnel-part" };
  r.properties.get(tunnelMat).programs = new Map([["back", { usedTimes: 1, isReady: () => tunnelLinked }]]);
  const base = r.compile.bind(r);
  r.compile = (root, cam, ts) => (root && root.name === "portalSpaceScene" ? new Set([tunnelMat]) : base(root, cam, ts));
  // Let the earlier (wasm-less) tunnel starts' build promises settle first.
  await new Promise((res) => setTimeout(res, 0));
  quietWarn(() => ps.startPortalSpace(w.sc, { enterDid: 0, exitDid: 0 }));
  for (let i = 0; i < 20; i++) await new Promise((res) => setTimeout(res, 0));
  ps.tickPortalSpace(w.sc, 0.05);
  run(w.sc, 1.2);
  check("tunnel programs still linking ⇒ no world warm pass yet", diag().warm.passes === 0 && diag().tunnelReady === false, JSON.stringify({ p: diag().warm.passes, tr: diag().tunnelReady }));
  tunnelLinked = true;
  ps.tickPortalSpace(w.sc, 0.05);
  check("…the first pass runs as soon as they are linked", diag().warm.passes === 1);
  quietWarn(() => ps.endPortalSpace());
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

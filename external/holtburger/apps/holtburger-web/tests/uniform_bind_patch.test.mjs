// tests/uniform_bind_patch.test.mjs — `?texUnitPin` + `?lightUploadOnce`
// (scene3d/uniform_bind_patch.js), fps wave 2 card "binds", 2026-10-17.
//
// Runs three r184's REAL WebGLRenderer over tests/helpers/fake_webgl2.mjs (a
// counting, state-tracking fake WebGL2 context) on a synthetic world pass shaped
// like the client's: plain surface meshes (map + normalMap), luminous ones
// (+ emissiveMap), detail-patched ones (onBeforeCompile uDetailMap), BatchedMesh
// buckets, a many-sampler terrain-like ShaderMaterial, transparent surfaces,
// IBL (scene.environment as a cubeUV texture), the 16-point + 2-spot light pool,
// and the client's own program-grouped opaque sort. Then:
//   1. EXACTNESS — every draw of the measured frame is snapshotted (program,
//      every active uniform's value, every sampler resolved to the TEXTURE it
//      reads at its unit/target). The stock run and each patched run must be
//      identical, draw for draw.
//   2. GL validity — no program ever has two sampler types on one unit.
//   3. The reduction — activeTexture + bindTexture per frame, total GL calls,
//      light-uniform GL calls (`?lightUbo` moves them into std140 uniform
//      blocks: the fake GL lays blocks out per std140 independently and reads
//      every block member back from the buffer bound at its binding point, so
//      the comparison covers the serialised light data too), light-struct walks.
//
// Run:  cd apps/holtburger-web && node tests/uniform_bind_patch.test.mjs

globalThis.window ??= {};
window.location ??= { search: "" };
window.requestAnimationFrame ??= () => 0;

const THREE = await import("three");
const { createFakeWebGL2, fakeCanvas } = await import("./helpers/fake_webgl2.mjs");
const {
  installUniformBindPatch, planProgramPins, pinUnitsFor, texUnitPinEnabled, lightUploadOnceEnabled,
  PIN_NAMES, uniformBindPatchTick, lightUboEnabled, lightUboChunkText, installLightUboChunks,
  injectLightUboDefine, LIGHT_BLOCKS,
} = await import("../scene3d/uniform_bind_patch.js");
const STOCK_LIGHTS_PARS = THREE.ShaderChunk.lights_pars_begin;
const { makeProgramSort } = await import("../scene3d/draw_sort_program.js");

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

// ---------------------------------------------------------------------------
// Deterministic synthetic world
// ---------------------------------------------------------------------------
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function dataTex(n = 4) {
  const t = new THREE.DataTexture(new Uint8Array(n * n * 4), n, n);
  t.needsUpdate = true;
  return t;
}
function cubeUvTex() {
  // A PMREM-shaped texture: three passes CubeUVReflectionMapping through as-is
  // and derives the CUBEUV_* defines from image.height.
  const t = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  t.image = { data: new Uint8Array(768 * 1024 * 4), width: 768, height: 1024 };
  t.mapping = THREE.CubeUVReflectionMapping;
  t.needsUpdate = true;
  return t;
}

function buildWorld({ seed = 7, count = 160, batches = 16, transparent = 12, fog = true } = {}) {
  const r = rng(seed);
  const scene = new THREE.Scene();
  scene.environment = cubeUvTex();
  if (fog) scene.fog = new THREE.Fog(0x8899aa, 50, 400);
  scene.add(new THREE.AmbientLight(0x404040, 0.5));
  const sun = new THREE.DirectionalLight(0xffffff, 1); sun.position.set(10, 20, 5); scene.add(sun);
  scene.add(new THREE.HemisphereLight(0x8888ff, 0x442200, 0.3));
  for (let i = 0; i < 16; i++) { const p = new THREE.PointLight(0xffaa66, 1, 30, 2); p.position.set(r() * 80 - 40, 3, r() * 80 - 40); scene.add(p); }
  for (let i = 0; i < 2; i++) { const s = new THREE.SpotLight(0xffffff, 1, 40, 0.5, 0.2, 2); s.position.set(r() * 20, 10, r() * 20); scene.add(s); }

  const box = new THREE.BoxGeometry(1, 1, 1);
  const place = (o) => { o.position.set(r() * 60 - 30, r() * 4, -5 - r() * 50); o.rotation.y = r() * 6; return o; };
  const detailTile = dataTex(8);
  const detailPatch = (m, key) => {
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uDetailMap = { value: detailTile };
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform sampler2D uDetailMap;")
        .replace("#include <map_fragment>", "#include <map_fragment>\n#ifdef USE_MAP\ndiffuseColor.rgb *= texture2D(uDetailMap, vMapUv * 8.0).r;\n#endif");
    };
    m.customProgramCacheKey = () => key;
    return m;
  };
  const floorBias = (m) => {
    m.onBeforeCompile = (shader) => { shader.fragmentShader = shader.fragmentShader.replace("#include <logdepthbuf_fragment>", "#include <logdepthbuf_fragment>\n// floor bias"); };
    m.customProgramCacheKey = () => "floorBias";
    return m;
  };
  // Material KINDS, each its own program (the client measured ~62 programs /
  // 126 switches per frame at Holtburg; the kinds below interleave in creation
  // order and sit in three renderOrder "phases", so the opaque sort has real
  // grouping work to do).
  const kinds = [
    () => new THREE.MeshStandardMaterial({ map: dataTex(), normalMap: dataTex(), roughness: 0.8 }),
    () => new THREE.MeshStandardMaterial({ map: dataTex() }),
    () => { const map = dataTex(); return new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: 0xffffff, emissiveIntensity: 0.5 }); },
    () => detailPatch(new THREE.MeshStandardMaterial({ map: dataTex(), normalMap: dataTex() }), "detail"),
    () => floorBias(new THREE.MeshStandardMaterial({ map: dataTex(), normalMap: dataTex() })),
    () => new THREE.MeshStandardMaterial({ map: dataTex(), alphaTest: 0.5, side: THREE.DoubleSide }),
    () => new THREE.MeshStandardMaterial({ map: dataTex(), normalMap: dataTex(), roughnessMap: dataTex() }),
    () => detailPatch(new THREE.MeshStandardMaterial({ map: dataTex(), roughnessMap: dataTex() }), "detail2"),
  ];
  for (let i = 0; i < count; i++) {
    const k = Math.floor(r() * kinds.length);
    const mesh = place(new THREE.Mesh(box, kinds[k]()));
    mesh.renderOrder = Math.floor(r() * 3); // buildings / statics / entities phases
    scene.add(mesh);
  }
  // BatchedMesh buckets (static-batch-c), three kinds, same phases.
  const bkinds = [
    () => new THREE.MeshStandardMaterial({ map: dataTex(), normalMap: dataTex() }),
    () => detailPatch(new THREE.MeshStandardMaterial({ map: dataTex(), normalMap: dataTex() }), "detail"),
    () => new THREE.MeshStandardMaterial({ map: dataTex(), alphaTest: 0.5 }),
  ];
  for (let b = 0; b < batches; b++) {
    const bm = new THREE.BatchedMesh(8, 512, 1024, bkinds[b % bkinds.length]());
    const gid = bm.addGeometry(box);
    for (let k = 0; k < 4; k++) {
      const id = bm.addInstance(gid);
      bm.setMatrixAt(id, new THREE.Matrix4().makeTranslation(r() * 40 - 20, 0, -5 - r() * 40));
    }
    bm.frustumCulled = false;
    bm.renderOrder = b % 3;
    scene.add(bm);
  }
  // Terrain-like ShaderMaterial with many samplers (stays three's own layout).
  const terrainU = {};
  let decl = "";
  let sum = "vec4 t = vec4(0.0);";
  for (let i = 0; i < 10; i++) { terrainU[`uT${i}`] = { value: dataTex() }; decl += `uniform sampler2D uT${i};\n`; sum += `t += texture(uT${i}, vUv);`; }
  const terrain = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.ShaderMaterial({
    uniforms: terrainU,
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: `${decl}varying vec2 vUv; void main(){ ${sum} gl_FragColor = t; }`,
  }));
  terrain.rotation.x = -Math.PI / 2; terrain.position.y = -1;
  scene.add(terrain);
  // Transparent surfaces: depth-sorted, interleaving programs.
  for (let i = 0; i < transparent; i++) {
    const m = new THREE.MeshStandardMaterial({ map: dataTex(), transparent: true, opacity: 0.5 });
    if (i % 2) m.emissiveMap = m.map, m.emissive = new THREE.Color(0xffffff);
    scene.add(place(new THREE.Mesh(box, m)));
  }
  const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 500);
  camera.position.set(0, 5, 10);
  return { scene, camera };
}

function moveCamera(camera, f) {
  camera.position.set(Math.sin(f * 0.1) * 2, 5, 10 + f * 0.05);
  camera.lookAt(0, 0, -20);
  camera.updateMatrixWorld();
}

/**
 * A renderer over a fresh fake context, set up the way scene3d/index.js does:
 * three's unit limit raised to MAX_COMBINED, the client's program sort, then
 * the patch. `ubo` patches THREE.ShaderChunk.lights_pars_begin first (global,
 * idempotent — index.js does it in preInit3D before any compile).
 */
function makeRenderer({ pin = false, light = false, ubo = false, programSort = true, shadows = false, check: chk = true } = {}) {
  if (ubo) installLightUboChunks(THREE, { force: true });
  const gl = createFakeWebGL2({ maxTextures: 16, maxCombined: 32 });
  gl.__fake.setCheckUnits(chk);
  const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });
  renderer.capabilities.maxTextures = 32;
  if (shadows) renderer.shadowMap.enabled = true;
  if (programSort) renderer.setOpaqueSort(makeProgramSort(renderer));
  const api = (pin || light || ubo) ? installUniformBindPatch(renderer, { texUnitPin: pin, lightUploadOnce: light, lightUbo: ubo }) : null;
  return { gl, renderer, api };
}

/**
 * One arm: fresh context + renderer + world, `warm` frames, then one measured
 * frame. `passes` = render() calls per frame (the client renders the world
 * scene more than once per composited frame on some paths).
 */
function runArm({ pin = false, light = false, ubo = false, warm = 3, passes = 1, programSort = true, worldOpts, snap = true }) {
  const { gl, renderer, api } = makeRenderer({ pin, light, ubo, programSort });
  const { scene, camera } = buildWorld(worldOpts);
  let f = 0;
  for (; f < warm; f++) { moveCamera(camera, f); for (let p = 0; p < passes; p++) renderer.render(scene, camera); }
  gl.__fake.reset();
  if (snap) gl.__fake.startSnapshots();
  moveCamera(camera, f);
  for (let p = 0; p < passes; p++) renderer.render(scene, camera);
  const snaps = snap ? gl.__fake.takeSnapshots() : null;
  return { gl, renderer, api, snaps, counts: { ...gl.__fake.counts }, total: gl.__fake.total(), scene, camera };
}

function normalizeSnaps(snaps) {
  // Program / texture ids are creation-order ids; arms create both in the same
  // order, but normalise to first-seen order anyway so the comparison is about
  // structure, not numbering.
  const progIds = new Map(), texIds = new Map();
  const norm = (v) => {
    if (typeof v === "string" && v.startsWith("tex#")) {
      if (!texIds.has(v)) texIds.set(v, `T${texIds.size}`);
      return texIds.get(v);
    }
    if (Array.isArray(v)) return v.map(norm);
    return v;
  };
  return snaps.map((s) => {
    if (!progIds.has(s.program)) progIds.set(s.program, `P${progIds.size}`);
    const u = {};
    for (const k of Object.keys(s.uniforms).sort()) u[k] = norm(s.uniforms[k]);
    return { kind: s.kind, program: progIds.get(s.program), u };
  });
}

function firstDiff(a, b) {
  if (a.length !== b.length) return `draw count ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    const x = JSON.stringify(a[i]), y = JSON.stringify(b[i]);
    if (x !== y) {
      for (const k of Object.keys(a[i].u)) {
        if (JSON.stringify(a[i].u[k]) !== JSON.stringify(b[i].u[k])) return `draw ${i} (${a[i].program}) uniform ${k}: ${JSON.stringify(a[i].u[k])} vs ${JSON.stringify(b[i].u[k])}`;
      }
      return `draw ${i}: ${x.slice(0, 200)} vs ${y.slice(0, 200)}`;
    }
  }
  return null;
}

const binds = (c) => (c.bindTexture || 0) + (c.activeTexture || 0);

// ---------------------------------------------------------------------------
console.log("PART 1 — flags and planning (pure)");
// ---------------------------------------------------------------------------
{
  check("texUnitPin default ON", texUnitPinEnabled("") === true && texUnitPinEnabled("?x=1") === true);
  check("texUnitPin off-forms", ["off", "0", "false", "no", "OFF"].every((v) => texUnitPinEnabled(`?texUnitPin=${v}`) === false));
  check("texUnitPin garbage stays ON", texUnitPinEnabled("?texUnitPin=maybe") === true);
  check("lightUploadOnce default ON / off escape", lightUploadOnceEnabled("") === true && lightUploadOnceEnabled("?lightUploadOnce=off") === false);
  check("lightUbo default ON / off escape", lightUboEnabled("") === true && ["off", "0", "false", "no"].every((v) => lightUboEnabled(`?lightUbo=${v}`) === false));
  const patched = lightUboChunkText(STOCK_LIGHTS_PARS);
  check("lightUbo chunk: all four arrays get an #ifdef'd std140 block, stock text in the #else",
        patched !== null && LIGHT_BLOCKS.every((b) => patched.includes(`layout( std140 ) uniform ${b.block} { ${b.struct} ${b.name}[ ${b.count} ]; };`)
          && patched.includes(`#else\n\tuniform ${b.struct} ${b.name}[ ${b.count} ];\n#endif`)));
  check("lightUbo chunk: the #else branch preprocesses to the stock chunk",
        patched.replace(/#ifdef HB_LIGHT_UBO\n[^\n]*\n#else\n\t([^\n]*)\n#endif/g, "$1") === STOCK_LIGHTS_PARS);
  check("lightUbo chunk: an unexpected chunk shape patches nothing", lightUboChunkText(STOCK_LIGHTS_PARS.replace("pointLights[ NUM_POINT_LIGHTS ]", "pointLights[ 4 ]")) === null && lightUboChunkText(patched) === null);
  check("define injected after #version, only where the marker is",
        injectLightUboDefine("#version 300 es\nx\n#ifdef HB_LIGHT_UBO") === "#version 300 es\n#define HB_LIGHT_UBO\nx\n#ifdef HB_LIGHT_UBO"
        && injectLightUboDefine("#version 300 es\nno marker") === "#version 300 es\nno marker");
  const u32 = pinUnitsFor(32);
  check("pins sit at the top of the unit range, most frequent highest",
        u32.get("dfgLUT") === 31 && u32.get("envMap") === 30 && u32.size === PIN_NAMES.length);
  const u16 = pinUnitsFor(16);
  check("a 16-unit context still pins (units 15..9)", u16.get("dfgLUT") === 15 && Math.min(...u16.values()) >= 8);
  check("a tiny context pins nothing below unit 8", pinUnitsFor(10).size === 2 && pinUnitsFor(8).size === 0);

  const S = (id, type = 0x8b5e) => ({ id, type, setValue() {} });
  const plan1 = planProgramPins({ seq: [S("map"), S("normalMap"), S("envMap"), S("dfgLUT"), { id: "modelMatrix", type: 0x8b5c }] }, "MeshStandardMaterial", u32);
  check("standard program: envMap + dfgLUT pinned", plan1.eligible && plan1.pins.map((p) => p.u.id).sort().join() === "dfgLUT,envMap" && plan1.total === 4);
  // 30 dynamic samplers + dfgLUT pinned at 31: 30 <= 31 single-pass -> ok; ShaderMaterial (2 passes) -> crowded.
  const many = []; for (let i = 0; i < 30; i++) many.push(S(`t${i}`));
  const plan2 = planProgramPins({ seq: [...many, S("dfgLUT")] }, "MeshStandardMaterial", u32);
  const plan3 = planProgramPins({ seq: [...many, S("dfgLUT")] }, "ShaderMaterial", u32);
  check("single-pass budget: dynamic units <= lowest pin", plan2.eligible === true);
  check("ShaderMaterial counts two upload passes -> crowded, left to three", plan3.eligible === false && plan3.reason === "crowded");
  const arr = { id: "dfgLUT", type: 0x8b5e, size: 3, setValue() {} };
  const plan4 = planProgramPins({ seq: [arr, S("map")] }, "MeshStandardMaterial", u32);
  check("array samplers are never pinned (they take a run of units)", plan4.pins.length === 0 && plan4.total === 4);
  const st = { id: "pointLights", seq: [{ id: 0, seq: [{ id: "shadowMap", type: 0x8b62, setValue() {} }] }], map: {} };
  check("struct-nested samplers count toward the budget", planProgramPins({ seq: [st, S("dfgLUT")] }, "MeshStandardMaterial", u32).total === 2);
}

// ---------------------------------------------------------------------------
console.log("PART 2 — real three r184 renderer: output identical, GL calls down");
// ---------------------------------------------------------------------------
const lightRe = /^(ambientLightColor|lightProbe|directionalLights|spotLights|pointLights|hemisphereLights|rectAreaLights)/;
function lightUniformCalls(gl) {
  let light = 0, all = 0;
  for (const [k, v] of Object.entries(gl.__fake.uniformCallsByName)) { all += v; if (lightRe.test(k)) light += v; }
  return { light, all };
}
const top = (c) => Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}=${v}`).join(" ");
let stock;
{
  // The stock baseline is taken BEFORE the global chunk patch exists.
  check("baseline runs on three's stock lights_pars_begin", THREE.ShaderChunk.lights_pars_begin === STOCK_LIGHTS_PARS);
  stock = runArm({});
  const pinned = runArm({ pin: true });
  const lightOnce = runArm({ light: true });
  const both = runArm({ pin: true, light: true });
  const S0 = normalizeSnaps(stock.snaps);
  check("stock frame drew something real", S0.length > 80 && new Set(S0.map((s) => s.program)).size >= 5,
        `${S0.length} draws, ${new Set(S0.map((s) => s.program)).size} programs`);
  for (const [name, arm] of [["texUnitPin", pinned], ["lightUploadOnce", lightOnce], ["pin+once", both]]) {
    const d = firstDiff(S0, normalizeSnaps(arm.snaps));
    check(`${name}: every draw sees the same program, uniforms and textures as stock`, d === null, d || `${arm.snaps.length} draws compared`);
    check(`${name}: no sampler-type collision on any unit`, arm.gl.__fake.unitConflicts === 0, arm.gl.__fake.conflictLog.join("; "));
  }
  const b0 = binds(stock.counts), b1 = binds(pinned.counts);
  check("texUnitPin cuts activeTexture+bindTexture", b1 < b0, `${b0} -> ${b1} per frame (${((1 - b1 / b0) * 100).toFixed(0)}%)`);
  check("texUnitPin pinned the lit programs", pinned.api.stats.programsPinned >= 4 && pinned.api.stats.patchErrors === 0,
        JSON.stringify({ pinned: pinned.api.stats.programsPinned, samplers: pinned.api.stats.samplersPinned, crowded: pinned.api.stats.programsCrowded }));
  check("lightUploadOnce sends exactly the same GL calls (the skipped walks sent nothing)",
        JSON.stringify(lightOnce.counts) === JSON.stringify(stock.counts), `${lightOnce.total} vs ${stock.total}`);
  const ls = lightOnce.api.stats;
  check("lightUploadOnce skipped re-walks", ls.lightSkips > 0 && ls.patchErrors === 0, `uploads ${ls.lightUploads} / skips ${ls.lightSkips} (cumulative over warm+measured)`);

  // ---- ?lightUbo (patches the global chunk from here on) ----
  const ubo = runArm({ ubo: true });
  const all3 = runArm({ pin: true, light: true, ubo: true });
  check("the chunk is patched now", THREE.ShaderChunk.lights_pars_begin !== STOCK_LIGHTS_PARS);
  for (const [name, arm] of [["lightUbo", ubo], ["all three", all3]]) {
    const d = firstDiff(S0, normalizeSnaps(arm.snaps));
    check(`${name}: every draw sees the same program, uniforms (block members read back from the UBO) and textures as stock`, d === null, d || `${arm.snaps.length} draws compared`);
    check(`${name}: every active block backed by a large-enough buffer at every draw`, arm.gl.__fake.uboErrors === 0, arm.gl.__fake.uboErrorLog.join("; "));
    check(`${name}: no sampler-type collision`, arm.gl.__fake.unitConflicts === 0, arm.gl.__fake.conflictLog.join("; "));
    const st = arm.api.stats;
    check(`${name}: blocks bound on every lit program, no layout drift, no errors`,
          st.programsUbo >= 10 && st.uboNoSentinel === 0 && st.noCameraKey === 0 && st.uboLayoutMismatch === 0 && st.patchErrors === 0, JSON.stringify(st));
  }
  const lu0 = lightUniformCalls(stock.gl), lu1 = lightUniformCalls(ubo.gl), lu3 = lightUniformCalls(all3.gl);
  check("lightUbo removes the light-struct uniform calls", lu1.light < lu0.light / 4,
        `${lu0.light} -> ${lu1.light} light-uniform calls/frame (ambient/probe stay); bufferSubData ${ubo.counts.bufferSubData || 0}/frame`);
  check("lightUbo cuts total GL calls", ubo.total < stock.total, `${stock.total} -> ${ubo.total}`);
  check("all three: fewest GL calls", all3.total < ubo.total && all3.total < pinned.total, `${all3.total}`);
  console.log(`    program switches/frame ${stock.counts.useProgram}; draws ${stock.snaps.length}`);
  console.log(`    per-frame GL calls: stock ${stock.total} | pin ${pinned.total} | once ${lightOnce.total} | ubo ${ubo.total} | all three ${all3.total}`);
  console.log(`    light-uniform calls: stock ${lu0.light} of ${lu0.all} uniform calls | ubo ${lu1.light} | all three ${lu3.light}`);
  console.log(`    stock top: ${top(stock.counts)}`);
  console.log(`    all3  top: ${top(all3.counts)}`);

  // Another renderer in the same page (ui/ac_paperdoll_viewport.js) shares the
  // patched chunk but never gets the define: it must compile the stock branch.
  const other = runArm({});
  const d = firstDiff(S0, normalizeSnaps(other.snaps));
  check("a renderer WITHOUT the install compiles the stock declarations from the patched chunk: identical, no blocks",
        d === null && other.gl.__fake.uboErrors === 0 && lightUniformCalls(other.gl).light === lu0.light, d || "");
}

// ---------------------------------------------------------------------------
console.log("PART 3 — multi-pass frames, painter sort, camera change inside a frame, shadows");
// ---------------------------------------------------------------------------
{
  // Two render() calls per frame with the client sort, then three's stock sort.
  for (const programSort of [true, false]) {
    const a = runArm({ passes: 2, programSort });
    const b = runArm({ pin: true, light: true, ubo: true, passes: 2, programSort });
    const d = firstDiff(normalizeSnaps(a.snaps), normalizeSnaps(b.snaps));
    check(`2 renders/frame, ${programSort ? "program" : "painter"} sort: identical`, d === null && b.gl.__fake.uboErrors === 0,
          d || `${a.snaps.length} draws; binds ${binds(a.counts)} -> ${binds(b.counts)}; GL calls ${a.total} -> ${b.total}`);
  }
  // A second camera rendering the same scene inside the same frame (a cube /
  // reflection camera): light data must follow the camera.
  const mk = (opts) => {
    const { gl, renderer } = makeRenderer(opts);
    const { scene, camera } = buildWorld({ count: 50, batches: 6 });
    const cam2 = new THREE.PerspectiveCamera(90, 1, 0.1, 100); cam2.position.set(5, 2, -10); cam2.lookAt(0, 0, -30); cam2.updateMatrixWorld();
    for (let f = 0; f < 3; f++) { moveCamera(camera, f); renderer.render(scene, camera); renderer.render(scene, cam2); }
    gl.__fake.startSnapshots();
    moveCamera(camera, 3); renderer.render(scene, camera); renderer.render(scene, cam2); renderer.render(scene, camera);
    return { s: normalizeSnaps(gl.__fake.takeSnapshots()), e: gl.__fake.uboErrors };
  };
  const a = mk({}), b = mk({ pin: true, light: true, ubo: true });
  const d = firstDiff(a.s, b.s);
  check("camera A / camera B / camera A in one frame: identical", d === null && b.e === 0, d || "");

  // A nested render from onBeforeRender with a different scene (own lights,
  // own render state at stack depth 1) in the middle of the world pass.
  const mkNested = (opts) => {
    const { gl, renderer } = makeRenderer(opts);
    const { scene, camera } = buildWorld({ count: 40, batches: 4, seed: 11 });
    const inner = buildWorld({ count: 10, batches: 1, seed: 3, transparent: 0 });
    const rt = new THREE.WebGLRenderTarget(64, 64);
    const hook = scene.children.find((o) => o.isMesh && o.renderOrder === 1);
    hook.onBeforeRender = (r) => { const prev = r.getRenderTarget(); r.setRenderTarget(rt); r.render(inner.scene, inner.camera); r.setRenderTarget(prev); };
    for (let f = 0; f < 3; f++) { moveCamera(camera, f); renderer.render(scene, camera); }
    gl.__fake.startSnapshots();
    moveCamera(camera, 3); renderer.render(scene, camera);
    return { s: normalizeSnaps(gl.__fake.takeSnapshots()), e: gl.__fake.uboErrors };
  };
  const n0 = mkNested({}), n1 = mkNested({ pin: true, light: true, ubo: true });
  const dn = firstDiff(n0.s, n1.s);
  check("nested render of another lit scene inside the world pass: identical", dn === null && n1.e === 0, dn || `${n0.s.length} draws`);

  // Shadow-casting directional light: three's shadow maps are pre-allocated
  // first and a depth pass with other cameras runs inside render().
  const mkShadow = (opts) => {
    const { gl, renderer } = makeRenderer({ ...opts, shadows: true });
    const { scene, camera } = buildWorld({ count: 50, batches: 6 });
    scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } if (o.isDirectionalLight) o.castShadow = true; });
    for (let f = 0; f < 3; f++) { moveCamera(camera, f); renderer.render(scene, camera); }
    gl.__fake.reset(); gl.__fake.startSnapshots();
    moveCamera(camera, 3); renderer.render(scene, camera);
    return { s: normalizeSnaps(gl.__fake.takeSnapshots()), c: gl.__fake.unitConflicts, e: gl.__fake.uboErrors, b: binds(gl.__fake.counts) };
  };
  const s0 = mkShadow({}), s1 = mkShadow({ pin: true, light: true, ubo: true });
  const ds = firstDiff(s0.s, s1.s);
  check("with three shadow maps + depth pass: identical, no unit collision", ds === null && s1.c === 0 && s1.e === 0, ds || `binds ${s0.b} -> ${s1.b}`);

  // A light-count change mid-session (three relinks for the new NUM_*): the
  // block grows and the layout extends.
  const g = makeRenderer({ ubo: true });
  const ref = makeRenderer({});
  const w1 = buildWorld({ count: 20, batches: 2, seed: 5 }), w2 = buildWorld({ count: 20, batches: 2, seed: 5 });
  for (const [r, w] of [[g, w1], [ref, w2]]) { r.renderer.render(w.scene, w.camera); }
  for (const w of [w1, w2]) for (let i = 0; i < 12; i++) { const p = new THREE.PointLight(0x88ccff, 2, 20, 2); p.position.set(i * 3 - 18, 2, -10); w.scene.add(p); }
  g.gl.__fake.startSnapshots(); ref.gl.__fake.startSnapshots();
  g.renderer.render(w1.scene, w1.camera); ref.renderer.render(w2.scene, w2.camera);
  const dg = firstDiff(normalizeSnaps(ref.gl.__fake.takeSnapshots()), normalizeSnaps(g.gl.__fake.takeSnapshots()));
  check("16 -> 28 point lights mid-session: buffer grows, identical", dg === null && g.gl.__fake.uboErrors === 0 && g.api.stats.uboGrows >= 1,
        dg || JSON.stringify({ grows: g.api.stats.uboGrows, mismatch: g.api.stats.uboLayoutMismatch }));
}

// ---------------------------------------------------------------------------
console.log("PART 4 — install mechanics");
// ---------------------------------------------------------------------------
{
  // Programs compiled BEFORE install are hooked lazily; the accessor is handed
  // back after the patch; a context restore (new programs array) is re-adopted.
  const gl = createFakeWebGL2();
  const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });
  renderer.capabilities.maxTextures = 32;
  const { scene, camera } = buildWorld({ count: 16, batches: 3, transparent: 0 });
  renderer.render(scene, camera); // programs exist and are in use (stock declarations: no define yet)
  const api = installUniformBindPatch(renderer, { texUnitPin: true, lightUploadOnce: true, lightUbo: true });
  check("idempotent install returns the same api", installUniformBindPatch(renderer, { texUnitPin: true }) === api);
  check("window.__uniformBindPatch published", window.__uniformBindPatch === api);
  const progs = renderer.info.programs.slice();
  check("existing programs got the lazy hook (own wrapper)", progs.every((p) => p.getUniforms.name === ""));
  renderer.render(scene, camera);
  check("after first use each program has three's accessor back", progs.every((p) => !String(p.getUniforms).includes("_patchProgramUniforms")));
  check("pre-existing programs were patched on next use (pins + light memo; no blocks: compiled before the define)",
        api.stats.programsPinned >= 2 && api.stats.programsLightOnce >= 2 && api.stats.programsUbo === 0 && gl.__fake.uboErrors === 0, JSON.stringify(api.stats));
  const before = api.stats.contextResets;
  const fresh = [];
  const old = renderer.info.programs;
  renderer.info.programs = fresh; // what three does on context restore
  uniformBindPatchTick(renderer);
  check("tick re-adopts a swapped programs array (and rebuilds the light buffers)",
        api.stats.contextResets === before + 1 && Object.prototype.hasOwnProperty.call(fresh, "push"));
  renderer.info.programs = old;
  check("all flags off -> nothing installed",
        installUniformBindPatch({ info: { programs: [] }, capabilities: { maxTextures: 32 }, getContext: () => gl }, { texUnitPin: false, lightUploadOnce: false, lightUbo: false }) === null);
  check("lightUbo stays off on a context without the patched chunk's define seam (no WebGL2 block API)",
        installUniformBindPatch({ info: { programs: [] }, capabilities: { maxTextures: 32 }, getContext: () => ({}) }, { texUnitPin: false, lightUploadOnce: false, lightUbo: true }) === null);
}

// ---------------------------------------------------------------------------
console.log("PART 5 — CPU indication (node V8, fake GL; informational; UBP_BENCH_REPS=N to run)");
// ---------------------------------------------------------------------------
if (!process.env.UBP_BENCH_REPS) {
  console.log("    skipped (set UBP_BENCH_REPS=9 for the bench quoted in the url-flags rows)");
} else {
  const time = (opts) => {
    const { renderer } = makeRenderer({ ...opts, check: false });
    const { scene, camera } = buildWorld({ count: 300, batches: 48, transparent: 24 });
    for (let f = 0; f < 20; f++) { moveCamera(camera, f); renderer.render(scene, camera); }
    const N = 150;
    const t0 = performance.now();
    for (let f = 0; f < N; f++) { moveCamera(camera, f); renderer.render(scene, camera); renderer.render(scene, camera); }
    return (performance.now() - t0) / N;
  };
  // Interleave arms to share thermal/JIT conditions.
  const arms = { stock: {}, pin: { pin: true }, once: { light: true }, ubo: { light: true, ubo: true }, all: { pin: true, light: true, ubo: true } };
  const res = Object.fromEntries(Object.keys(arms).map((k) => [k, []]));
  const reps = Math.max(1, Number(process.env.UBP_BENCH_REPS) || 3);
  for (let rep = 0; rep < reps; rep++) for (const [k, o] of Object.entries(arms)) res[k].push(time(o));
  const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const mn = (a) => Math.min(...a);
  console.log(`    min ms/frame (2 renders of ~370 draws, ${reps} reps): ${Object.keys(arms).map((k) => `${k} ${mn(res[k]).toFixed(3)}`).join(", ")}`);
  console.log(`    median: ${Object.keys(arms).map((k) => `${k} ${med(res[k]).toFixed(3)}`).join(", ")}`);
  check("timing ran", Number.isFinite(med(res.all)));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

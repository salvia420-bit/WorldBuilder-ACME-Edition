// tests/ibl_stable_env.test.mjs — `?iblStableEnv` (scene3d/ibl_environment.js),
// improvement hunt main-thread-1, 2026-10-20.
//
// three r184's PMREMGenerator.fromScene allocates a new cubeUV target per call,
// so every IBL refresh (15 s, `?ibl` default on) handed scene.environment a NEW
// texture, and the next frame ran getProgram (programCache.getParameters +
// getProgramCacheKey) for every MeshStandard / Lambert material drawn — only to
// land on the program it already had. With the flag the first refresh's target
// stays scene.environment and every later fromScene result is copied into it
// (renderer.copyTextureToTexture) and freed.
//
// Runs three's REAL WebGLRenderer + REAL PMREMGenerator + the real
// IblEnvironment over tests/helpers/fake_webgl2.mjs, with a sky scene and a
// world of MeshStandard + MeshLambert materials; four refreshes per arm,
// default vs `?iblStableEnv=off`. Pins:
//   1. scene.environment is ONE object across the refreshes (off: a new one
//      every refresh); the kept target is never disposed and its GL texture
//      never deleted; each refresh's fresh target is freed after the copy.
//   2. the bug trigger: getProgram calls per material in the frame after a
//      refresh — one per material with the flag off, ZERO by default. Counted on
//      three's own path: getParameters calls material.customProgramCacheKey()
//      exactly once per getProgram.
//   3. the copy at the GL level: one copyTexSubImage2D per refresh, level 0,
//      the full 768x1024 region, read attachment = THIS refresh's fresh texture,
//      bound destination = the kept env texture, both allocated with the same
//      internal format and size; and on the three side the two textures agree on
//      size / format / type / filters / mapping / colour space.
//   4. draw for draw: every draw of each refresh and of the world frame after it
//      (fake-GL snapshots: program, every uniform, every sampler resolved to the
//      texture it reads) is identical between the arms once a texture is named
//      by the refresh whose PMREM it holds. That naming is derived from the GL
//      calls: a fresh target holds its own refresh; a full-region, same-format,
//      level-0 copyTexSubImage2D moves that content into its destination.
//   5. fallbacks keep the old swap without throwing: no copyTextureToTexture, a
//      throwing copy, a kept texture with no GL object (context restore),
//      scene.environment replaced elsewhere, a GL error on the session's first
//      copy (the only one gl.getError-checked; the flag then latches off). The render target bound before a
//      refresh is bound after it (r184's copy leaves READ/DRAW at null), and
//      dispose() frees the kept target.
//
// Run:  cd apps/holtburger-web && node tests/ibl_stable_env.test.mjs

globalThis.window ??= {};
window.location ??= { search: "" };
window.requestAnimationFrame ??= () => 0;

const THREE = await import("three");
const { createFakeWebGL2, fakeCanvas } = await import("./helpers/fake_webgl2.mjs");
const { IblEnvironment, readIblStableEnvFlag } = await import("../scene3d/ibl_environment.js");

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

// ---------------------------------------------------------------------------
// GL trace: texture unit bindings, texture allocations, the read attachment,
// the draw framebuffer, copies and deletes — and the CONTENT model (GL texture
// id -> refresh index whose PMREM it holds).
// ---------------------------------------------------------------------------
function installGlTrace(gl) {
  const T = { log: [], content: new Map(), alloc: new Map(), drawFb: null };
  let unit = 0;
  const bound = new Map(); // `${unit}:${target}` -> texture
  let readTex = null, readLevel = 0;
  const wrap = (name, hook) => {
    const orig = gl[name];
    gl[name] = function (...args) { hook(...args); return orig.apply(this, args); };
  };
  wrap("activeTexture", (u) => { unit = u - gl.TEXTURE0; });
  wrap("bindTexture", (target, tex) => { bound.set(`${unit}:${target}`, tex || null); });
  wrap("texStorage2D", (target, levels, internalFormat, w, h) => {
    const t = bound.get(`${unit}:${target}`);
    if (t) T.alloc.set(t.__id, { internalFormat, w, h });
  });
  wrap("texImage2D", (target, level, internalFormat, w, h) => {
    const t = bound.get(`${unit}:${target}`);
    if (t && level === 0 && typeof w === "number") T.alloc.set(t.__id, { internalFormat, w, h });
  });
  wrap("bindFramebuffer", (target, fb) => { if (target !== gl.READ_FRAMEBUFFER) T.drawFb = fb || null; });
  wrap("framebufferTexture2D", (target, att, texTarget, tex, level) => {
    if (target === gl.READ_FRAMEBUFFER && att === gl.COLOR_ATTACHMENT0) { readTex = tex || null; readLevel = level; }
  });
  wrap("copyTexSubImage2D", (target, level, x, y, sx, sy, w, h) => {
    const dst = bound.get(`${unit}:${target}`) ?? null;
    const e = { op: "copy", dst, src: readTex, srcLevel: readLevel, level, x, y, sx, sy, w, h };
    T.log.push(e);
    const a = dst && T.alloc.get(dst.__id);
    const b = readTex && T.alloc.get(readTex.__id);
    // Exact whole-texture copy ⇒ the destination now holds the source's PMREM.
    if (a && b && level === 0 && readLevel === 0 && x === 0 && y === 0 && sx === 0 && sy === 0 &&
        a.internalFormat === b.internalFormat && a.w === b.w && a.h === b.h && w === a.w && h === a.h &&
        T.content.has(readTex.__id)) {
      T.content.set(dst.__id, T.content.get(readTex.__id));
    }
  });
  wrap("blitFramebuffer", () => T.log.push({ op: "blit" }));
  wrap("deleteTexture", (tex) => T.log.push({ op: "delete", tex }));
  return T;
}

const glTex = (renderer, tex) => renderer.properties.get(tex).__webglTexture ?? null;

function canon(v, content) {
  if (typeof v === "string") {
    const m = /^tex#(\d+)$/.exec(v);
    if (m && content.has(Number(m[1]))) return `env@${content.get(Number(m[1]))}`;
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => canon(x, content));
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = canon(v[k], content);
    return o;
  }
  return v;
}

// ---------------------------------------------------------------------------
// One arm: renderer + sky + world + IblEnvironment (constructed under `search`).
// ---------------------------------------------------------------------------
const N_WORLD = 24;
function makeArm(search = "") {
  window.location.search = search;
  const gl = createFakeWebGL2({ maxTextures: 16, maxCombined: 32 });
  const T = installGlTrace(gl);
  const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });

  const sky = new THREE.Scene();
  sky.add(new THREE.Mesh(new THREE.SphereGeometry(500, 8, 6),
    new THREE.MeshBasicMaterial({ name: "sky-dome", color: 0x88aaff, side: THREE.BackSide, depthWrite: false })));
  const stars = new THREE.Points(new THREE.BufferGeometry().setAttribute("position",
    new THREE.Float32BufferAttribute([100, 200, 50, -300, 150, 20, 10, 400, -90], 3)),
  new THREE.PointsMaterial({ name: "stars", size: 2, sizeAttenuation: false }));
  sky.add(stars);

  const world = new THREE.Scene();
  world.add(new THREE.AmbientLight(0x404040, 0.5));
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.set(10, 20, 5);
  world.add(sun);
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mats = [];
  for (let i = 0; i < N_WORLD; i++) {
    const color = new THREE.Color().setHSL(i / N_WORLD, 0.5, 0.5);
    const m = i % 6 === 5
      ? new THREE.MeshLambertMaterial({ name: `lambert-${i}`, color })
      : new THREE.MeshStandardMaterial({ name: `std-${i}`, color, roughness: 0.2 + 0.03 * i, metalness: (i % 3) / 3 });
    // getProgram counter: three r184's getParameters reads
    // material.customProgramCacheKey() once per getProgram call.
    const base = m.customProgramCacheKey.bind(m);
    m.__getProgram = 0;
    m.customProgramCacheKey = () => { m.__getProgram += 1; return base(); };
    mats.push(m);
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set((i % 6) * 2 - 5, Math.floor(i / 6) * 2 - 3, -4 - (i % 4));
    world.add(mesh);
  }
  const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 1000);
  camera.position.set(0, 1, 8);
  camera.lookAt(0, 0, -4);
  camera.updateMatrixWorld(true);

  const ibl = new IblEnvironment({ renderer, scene: world, skyScene: sky, refreshMs: 1000, camera });
  window.location.search = "";

  // Every fresh fromScene target, and its content (its own refresh index).
  const fresh = [];
  const realFromScene = ibl._pmrem.fromScene.bind(ibl._pmrem);
  ibl._pmrem.fromScene = (...args) => {
    const rt = realFromScene(...args);
    fresh.push(rt);
    const t = glTex(renderer, rt.texture);
    if (t) T.content.set(t.__id, fresh.length);
    rt.__disposed = false;
    rt.addEventListener("dispose", () => { rt.__disposed = true; });
    return rt;
  };
  return { gl, T, renderer, sky, world, mats, camera, ibl, fresh };
}

const REFRESHES = 4;
function runArm(search) {
  const a = makeArm(search);
  const phases = [];
  for (let k = 1; k <= REFRESHES; k++) {
    a.gl.__fake.startSnapshots();
    const logFrom = a.T.log.length;
    a.ibl.tick(k * 1000, []); // refreshMs 1000 ⇒ due every call
    const before = a.mats.map((m) => m.__getProgram);
    a.renderer.render(a.world, a.camera);
    const getProgram = a.mats.map((m, i) => m.__getProgram - before[i]);
    const snaps = a.gl.__fake.takeSnapshots();
    phases.push({
      k,
      snaps: canon(snaps, a.T.content),
      getProgram,
      log: a.T.log.slice(logFrom),
      env: a.world.environment,
      keptRT: a.ibl._pmremRT,
      contentAfter: new Map(a.T.content), // the content model as of this phase
    });
    // A steady frame between refreshes (no re-resolve in either arm).
    const b2 = a.mats.map((m) => m.__getProgram);
    a.renderer.render(a.world, a.camera);
    phases[phases.length - 1].steadyGetProgram = a.mats.reduce((s, m, i) => s + m.__getProgram - b2[i], 0);
  }
  return { a, phases };
}

console.log("PART 0 — readIblStableEnvFlag");
{
  check("default (absent) ⇒ ON", readIblStableEnvFlag("") === true && readIblStableEnvFlag("?ibl=on") === true);
  check("off | 0 | false | no (any case) ⇒ OFF",
    ["off", "0", "false", "no", "OFF"].every((v) => readIblStableEnvFlag(`?iblStableEnv=${v}`) === false));
  check("on | 1 | empty ⇒ ON", ["on", "1", ""].every((v) => readIblStableEnvFlag(`?iblStableEnv=${v}`) === true));
  window.location.search = "?iblStableEnv=off";
  const viaLocation = readIblStableEnvFlag();
  window.location.search = "";
  check("reads window.location.search when no argument is given", viaLocation === false && readIblStableEnvFlag() === true);
}

const S = runArm("");
const L = runArm("?iblStableEnv=off");

console.log("PART 1 — scene.environment identity + target lifetime");
{
  const env1 = S.phases[0].env;
  check("default: the first refresh sets a PMREM texture (CubeUV, 768x1024)",
    !!env1 && env1.mapping === THREE.CubeUVReflectionMapping && env1.image.width === 768 && env1.image.height === 1024);
  check(`default: scene.environment is the SAME object across all ${REFRESHES} refreshes`,
    S.phases.every((p) => p.env === env1), S.phases.map((p) => p.env?.uuid?.slice(0, 8)).join(" "));
  check("default: the kept target is the first refresh's own fromScene target, never disposed",
    S.phases.every((p) => p.keptRT === S.a.fresh[0]) && S.a.fresh[0].__disposed === false);
  check(`default: every later fresh target is disposed (${REFRESHES - 1} of ${REFRESHES - 1})`,
    S.a.fresh.slice(1).every((rt) => rt.__disposed === true), S.a.fresh.map((rt) => rt.__disposed).join());
  const keptGl = glTex(S.a.renderer, env1);
  check("default: the kept GL texture is never deleted",
    !!keptGl && !S.phases.some((p) => p.log.some((e) => e.op === "delete" && e.tex === keptGl)));
  check("default: stableEnvStats counts one copy per later refresh, no fallback",
    S.a.ibl.stableEnvStats.copies === REFRESHES - 1 && S.a.ibl.stableEnvStats.fallbacks === 0, JSON.stringify(S.a.ibl.stableEnvStats));
  const envs = new Set(L.phases.map((p) => p.env));
  check(`off (escape): a new scene.environment every refresh (${REFRESHES} distinct)`, envs.size === REFRESHES && L.a.ibl.stableEnv === false);
  check("off: the previous env target is disposed every refresh (today's churn)",
    L.a.fresh.slice(0, -1).every((rt) => rt.__disposed === true) && L.a.fresh[REFRESHES - 1].__disposed === false);
  check("off: no copy issued", L.phases.every((p) => !p.log.some((e) => e.op === "copy" || e.op === "blit")) && L.a.ibl.stableEnvStats.copies === 0);
}

console.log("PART 2 — the bug trigger: getProgram per material in the frame after a refresh");
{
  const sum = (arr) => arr.reduce((s, x) => s + x, 0);
  check("first refresh: both arms resolve every material once (first draw compiles)",
    S.phases[0].getProgram.every((n) => n === 1) && L.phases[0].getProgram.every((n) => n === 1));
  for (let k = 2; k <= REFRESHES; k++) {
    const s = S.phases[k - 1].getProgram, l = L.phases[k - 1].getProgram;
    check(`refresh ${k}: off re-resolves EVERY material (${sum(l)}/${N_WORLD}), default none (${sum(s)})`,
      l.every((n) => n === 1) && s.every((n) => n === 0));
  }
  check("Lambert materials are part of it (r184 routes scene.environment to Lambert/Phong too)",
    L.phases[1].getProgram.filter((n, i) => S.a.mats[i].isMeshLambertMaterial && n === 1).length === Math.floor(N_WORLD / 6));
  check("steady frames: no re-resolve in either arm",
    S.phases.every((p) => p.steadyGetProgram === 0) && L.phases.every((p) => p.steadyGetProgram === 0));
  check("still ONE program set: the off arm re-resolves to the programs it had (no compile)",
    S.a.renderer.info.programs.length === L.a.renderer.info.programs.length,
    `${S.a.renderer.info.programs.length} vs ${L.a.renderer.info.programs.length}`);
}

console.log("PART 3 — the copy, at the GL level");
{
  const kept = S.a.fresh[0];
  const keptGl = glTex(S.a.renderer, kept.texture);
  const ka = S.a.T.alloc.get(keptGl.__id);
  for (let k = 2; k <= REFRESHES; k++) {
    const p = S.phases[k - 1];
    const copies = p.log.filter((e) => e.op === "copy");
    const rt = S.a.fresh[k - 1];
    // The fresh GL texture is gone from properties after dispose; find it in the log by elimination.
    const c = copies[0];
    const fa = c && c.src ? S.a.T.alloc.get(c.src.__id) : null;
    check(`refresh ${k}: exactly one copyTexSubImage2D (no blit)`, copies.length === 1 && !p.log.some((e) => e.op === "blit"));
    check(`refresh ${k}: level 0 → level 0, full ${ka?.w}x${ka?.h} region at the origin`,
      !!c && c.level === 0 && c.srcLevel === 0 && c.x === 0 && c.y === 0 && c.sx === 0 && c.sy === 0 &&
      c.w === 768 && c.h === 1024 && ka?.w === 768 && ka?.h === 1024, JSON.stringify(c && { ...c, dst: c.dst?.__id, src: c.src?.__id }));
    check(`refresh ${k}: destination = the kept env texture; source = this refresh's fresh texture`,
      !!c && c.dst === keptGl && S.a.T.content.get(c.src.__id) === k && c.src !== keptGl);
    check(`refresh ${k}: both GL textures allocated with the same internal format and size`,
      !!fa && !!ka && fa.internalFormat === ka.internalFormat && fa.w === ka.w && fa.h === ka.h);
    const iCopy = p.log.indexOf(c);
    const iDel = p.log.findIndex((e) => e.op === "delete" && c && e.tex === c.src);
    check(`refresh ${k}: the fresh texture is deleted after the copy`, iDel > iCopy && iCopy >= 0);
    const a = rt.texture, b = kept.texture;
    check(`refresh ${k}: three textures agree (size/format/type/filters/mapping/colour space/no mips)`,
      rt.width === kept.width && rt.height === kept.height && a.format === b.format && a.type === b.type &&
      a.type === THREE.HalfFloatType && a.internalFormat === b.internalFormat && a.minFilter === b.minFilter &&
      a.magFilter === b.magFilter && a.mapping === b.mapping && a.colorSpace === b.colorSpace &&
      a.generateMipmaps === false && b.generateMipmaps === false);
    check(`refresh ${k}: the kept texture now holds refresh ${k}'s PMREM`, p.contentAfter.get(keptGl.__id) === k,
      String(p.contentAfter.get(keptGl.__id)));
  }
}

console.log("PART 4 — draw for draw, default vs off (refresh draws + the world frame after)");
{
  for (let k = 1; k <= REFRESHES; k++) {
    const s = S.phases[k - 1].snaps, l = L.phases[k - 1].snaps;
    let firstDiff = -1;
    const n = Math.max(s.length, l.length);
    for (let i = 0; i < n; i++) {
      if (JSON.stringify(s[i]) !== JSON.stringify(l[i])) { firstDiff = i; break; }
    }
    const envReads = s.filter((d) => Object.values(d.uniforms).includes(`env@${k}`)).length;
    check(`refresh ${k}: ${s.length} draws identical (program, uniforms, sampled texture content)`,
      s.length === l.length && s.length > N_WORLD && firstDiff < 0,
      firstDiff < 0 ? "" : `first diff at draw ${firstDiff}: ${JSON.stringify(s[firstDiff])?.slice(0, 300)} vs ${JSON.stringify(l[firstDiff])?.slice(0, 300)}`);
    check(`refresh ${k}: the world draws sample refresh ${k}'s PMREM (${envReads} draws)`, envReads >= N_WORLD);
  }
}

console.log("PART 5 — fallbacks, render-target restore, dispose");
{
  // No copy API ⇒ the old swap.
  const a = makeArm("");
  a.renderer.copyTextureToTexture = undefined;
  a.ibl.tick(1000, []);
  const e1 = a.world.environment;
  let threw = null;
  try { a.ibl.tick(2000, []); } catch (e) { threw = e; }
  check("no copyTextureToTexture ⇒ swap (new env, old target disposed), no throw",
    !threw && a.world.environment !== e1 && a.world.environment === a.fresh[1].texture && a.fresh[0].__disposed === true);
}
{
  // A throwing copy ⇒ the swap; counted.
  const a = makeArm("");
  a.ibl.tick(1000, []);
  a.renderer.copyTextureToTexture = () => { throw new Error("copy failed"); };
  let threw = null;
  try { a.ibl.tick(2000, []); } catch (e) { threw = e; }
  check("a throwing copy ⇒ swap to the fresh target, counted as a fallback, no throw",
    !threw && a.world.environment === a.fresh[1].texture && a.fresh[0].__disposed === true && a.fresh[1].__disposed === false &&
    a.ibl.stableEnvStats.fallbacks === 1);
}
{
  // Context lost + restored: three rebuilt its properties, the kept texture has no GL object.
  const a = makeArm("");
  a.ibl.tick(1000, []);
  a.renderer.properties.remove(a.fresh[0].texture);
  a.ibl.tick(2000, []);
  check("kept texture with no GL object (context restore) ⇒ swap, so the refresh re-creates the env",
    a.world.environment === a.fresh[1].texture && a.ibl._pmremRT === a.fresh[1] && a.ibl.stableEnvStats.fallbacks === 1);
  a.ibl.tick(3000, []);
  check("…and the next refresh copies into the new kept target again",
    a.world.environment === a.fresh[1].texture && a.fresh[2].__disposed === true && a.ibl.stableEnvStats.copies === 1);
}
{
  // The session's first copy is gl.getError()-checked (one drain + one read);
  // a rejected copy latches the flag off and this refresh swaps.
  const a = makeArm("");
  const realGetError = a.gl.getError;
  let pending = 0, getErrorCalls = 0;
  a.gl.getError = function () { getErrorCalls += 1; const e = pending; pending = 0; return e || realGetError.call(this); };
  const realCopy = a.gl.copyTexSubImage2D;
  a.gl.copyTexSubImage2D = function (...args) { pending = 0x0502; return realCopy.apply(this, args); }; // INVALID_OPERATION
  a.ibl.tick(1000, []);
  const callsBefore = getErrorCalls;
  a.ibl.tick(2000, []);
  check("first copy raises a GL error ⇒ swap to the fresh target, flag latched off, error recorded",
    a.world.environment === a.fresh[1].texture && a.fresh[0].__disposed === true && a.fresh[1].__disposed === false &&
    a.ibl.stableEnv === false && a.ibl.stableEnvStats.glError === 0x0502 && a.ibl.stableEnvStats.copies === 0,
    JSON.stringify(a.ibl.stableEnvStats));
  check("…the check cost one drain read + one read", getErrorCalls - callsBefore === 2, String(getErrorCalls - callsBefore));
  const copiesBefore = a.T.log.filter((e) => e.op === "copy").length;
  a.ibl.tick(3000, []);
  check("…later refreshes swap without copying", a.world.environment === a.fresh[2].texture &&
    a.T.log.filter((e) => e.op === "copy").length === copiesBefore);
}
{
  // Only the FIRST copy of a session pays the getError syncs.
  const a = makeArm("");
  let getErrorCalls = 0;
  const realGetError = a.gl.getError;
  a.gl.getError = function () { getErrorCalls += 1; return realGetError.call(this); };
  a.ibl.tick(1000, []);
  const c1 = getErrorCalls;
  a.ibl.tick(2000, []);
  const c2 = getErrorCalls;
  a.ibl.tick(3000, []);
  a.ibl.tick(4000, []);
  check("getError only around the session's first copy (2 reads), none after",
    c2 - c1 === 2 && getErrorCalls === c2 && a.ibl.stableEnvStats.copies === 3, `${c2 - c1}, then ${getErrorCalls - c2}`);
}
{
  // scene.environment replaced by someone else ⇒ swap (as before), no copy into a texture nobody samples.
  const a = makeArm("");
  a.ibl.tick(1000, []);
  a.world.environment = null;
  a.ibl.tick(2000, []);
  check("scene.environment replaced elsewhere ⇒ swap", a.world.environment === a.fresh[1].texture && a.ibl.stableEnvStats.copies === 0);
}
{
  // The render target bound before the refresh is bound after it. The terrain
  // cube is stubbed out here: CubeCamera.update rebinds on its own, which would
  // hide a missing restore after the copy.
  const a = makeArm("");
  a.ibl.tick(1000, []);
  a.ibl._renderTerrainCube = (now) => { a.ibl._lastCubeMs = now; };
  const rtX = new THREE.WebGLRenderTarget(64, 64);
  a.renderer.setRenderTarget(rtX);
  const fbX = a.renderer.properties.get(rtX).__webglFramebuffer;
  a.ibl.tick(2000, []);
  check("render target restored after the copy (renderer AND the GL draw framebuffer)",
    a.ibl.stableEnvStats.copies === 1 && a.renderer.getRenderTarget() === rtX && !!fbX && a.T.drawFb === fbX,
    `drawFb=${a.T.drawFb?.__id} want ${fbX?.__id}`);
  a.renderer.setRenderTarget(null);
  // dispose() frees the kept target.
  a.ibl.dispose();
  check("dispose() frees the kept target and clears scene.environment", a.fresh[0].__disposed === true && a.world.environment === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

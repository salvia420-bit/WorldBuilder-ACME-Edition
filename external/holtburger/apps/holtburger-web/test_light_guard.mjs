// LIGHT-GUARD (2026-10-05) — headless ESM test for the light-pool parameter
// guards, the cell-path stick band, detached/ghost-source handling, the
// per-instance userData stamp fix and the window.__diag.lights snapshot in
// scene3d/lighting.js.
//
// Owner symptom: intermittent near-full-screen black + a flickering green
// light in the distance. A pool slot feeds EVERY lit material's light
// uniforms, so one NaN/Inf slot value turns every lit fragment NaN (bloom then
// spreads it over the frame). These checks pin that no slot can ever hold a
// non-finite value, whatever the sources do.
//
// Run: cd apps/holtburger-web/ && node test_light_guard.mjs
// (SKIPs cleanly if three can't be located.)

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed += 1;
  else failed += 1;
}

let threePath = null;
try {
  threePath = require.resolve("three");
} catch (_) {}
if (!threePath) {
  console.log("light-guard test: SKIP (three not located).");
  process.exit(0);
}
const THREE = await import("file://" + threePath);

console.log("LIGHT-GUARD — light-pool validation / stick band / diag");
console.log("=========================");

function loadModule(relPath) {
  let src = readFileSync(resolvePath(__dirname, relPath), "utf8");
  src = src.replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m, "");
  src = src.replace(/^\s*import\s+\{[^}]+\}\s+from\s+["']\.\/csm\.js["'];?\s*$/m, "");
  src = src.replace(/^\s*import\s+\{[^}]+\}\s+from\s+["']\.\/landblock_lru\.js["'];?\s*$/m, "");
  return src;
}
function stripExports(src) {
  return src
    .replace(/^\s*export\s+function\s+/gm, "function ")
    .replace(/^\s*export\s+async\s+function\s+/gm, "async function ")
    .replace(/^\s*export\s+class\s+/gm, "class ")
    .replace(/^\s*export\s+const\s+/gm, "const ")
    .replace(/^\s*export\s+default\s+/gm, "")
    .replace(/^\s*export\s+\{[^}]+\}[\s;]*$/gm, "");
}
const composite =
  "const LB_KEY_MASK = 0xffff_0000 >>> 0;\n" +
  "function lbKeyOf(idOrKey) { return (idOrKey & LB_KEY_MASK) >>> 0; }\n" +
  stripExports(loadModule("scene3d/csm.js")) + "\n" +
  stripExports(loadModule("scene3d/lighting.js")) + "\n" +
  "; return { setupSceneLighting, capActiveLightsByDistance, writePoolSlot, " +
  "sanitizeLightIntensity, sanitizeLightDistance, buildLightForSetupLight, " +
  "attachSetupModelLights, lightPoolSnapshot, newLightGuardCounters, " +
  "__resetLightPoolConfigForTest, __resetCellLightsConfigForTest, " +
  "__resetVertexBakePoolConfigForTest, LIGHTING_CONSTANTS };";
const M = new Function("THREE", composite)(THREE);

const FLT_MAX = 3.4028234663852886e38;
const ROOM = 0x01210100;

function slotFinite(l) {
  const p = l.position;
  const c = l.color;
  const nums = [l.intensity, l.distance, l.decay, p.x, p.y, p.z, c.r, c.g, c.b];
  if (l.isSpotLight) nums.push(l.angle, l.penumbra, l.target.position.x, l.target.position.y, l.target.position.z);
  return nums.every(Number.isFinite) && l.intensity >= 0 && l.distance >= 0;
}
function allSlotsFinite(pool) {
  return pool.point.every(slotFinite) && pool.spot.every(slotFinite);
}
function makeLamp(name, x, y, z, { cellId = ROOM, color = 0x00ff00, intensity = 100, dist = 7.8 } = {}) {
  const l = new THREE.PointLight(color, intensity, dist, 2);
  l.position.set(x, y, z);
  l.visible = false;
  l.name = name;
  l.userData = {};
  if (cellId != null) l.userData.__cellId = cellId >>> 0;
  return l;
}
function freshWorld({ pointCount = 4, hysteresis = 0.64, withScene = false } = {}) {
  M.__resetLightPoolConfigForTest({ enabled: true, pointCount, spotCount: 2, hysteresis });
  M.__resetCellLightsConfigForTest({ enabled: true, viewerLight: false, viewerIntensity: 2.25 });
  const scene = new THREE.Scene();
  const lighting = M.setupSceneLighting(scene, {});
  const playerPos = new THREE.Vector3(0, 0, 0);
  const camera = { position: new THREE.Vector3(0, 2, 5) };
  const scene3d = {
    lighting,
    activeLights: [],
    camera,
    cameraSwitcher: {
      activeCamera: camera,
      getPlayerWorldPosition(v) { v.copy(playerPos); return v; },
    },
  };
  if (withScene) scene3d.scene = scene;
  let renderSet = [ROOM];
  const session = { getRenderSet() { return Uint32Array.from(renderSet); } };
  return {
    scene, scene3d, session, playerPos, pool: lighting.lightPool,
    setRenderSet(ids) { renderSet = ids; },
    tick() { M.capActiveLightsByDistance(scene3d, session); },
  };
}
const names = (pool) => pool.selPoint.map((s) => s.name).sort().join(",");

// ---------------------------------------------------------------- 1. sanitizers
{
  check("1a: intensity NaN → 0", M.sanitizeLightIntensity(NaN) === 0);
  check("1b: intensity +Inf → 0 (malformed, not clamped up)", M.sanitizeLightIntensity(Infinity) === 0);
  check("1c: intensity negative → 0", M.sanitizeLightIntensity(-5) === 0);
  check("1d: intensity 1e9 → LIGHT_INTENSITY_CLAMP",
    M.sanitizeLightIntensity(1e9) === M.LIGHTING_CONSTANTS.LIGHT_INTENSITY_CLAMP);
  check("1e: intensity 100 passes through", M.sanitizeLightIntensity(100) === 100);
  check("1f: distance NaN → 0 (infinite reach)", M.sanitizeLightDistance(NaN) === 0);
  check("1g: distance +Inf → 1000", M.sanitizeLightDistance(Infinity) === 1000);
  check("1h: distance FLT_MAX*1.3 → 1000", M.sanitizeLightDistance(FLT_MAX * 1.3) === 1000);
  check("1i: distance 7.8 passes through", M.sanitizeLightDistance(7.8) === 7.8);
}

// ------------------------------------------------------ 2. writePoolSlot rejects
{
  const tmp = new THREE.Vector3();
  const mk = () => new THREE.PointLight(0xffffff, 0, 0, 2);
  const g = M.newLightGuardCounters();

  const dst = mk();
  const src = makeLamp("nanpos", NaN, 1, 1);
  const st = M.writePoolSlot(dst, src, tmp, g);
  check("2a: NaN source position → slot parked, never copied",
    st === "nonFinitePos" && dst.intensity === 0 && slotFinite(dst) && g.nonFinitePos === 1,
    `status=${st} pos=${dst.position.toArray()}`);

  const far = makeLamp("far", 1e30, 0, 0);
  const st2 = M.writePoolSlot(dst, far, tmp, g);
  check("2b: absurd (1e30) position → parked (float32 overflow → Inf in the shader)",
    st2 === "farPos" && dst.intensity === 0 && slotFinite(dst));

  const infI = makeLamp("infI", 1, 1, 1);
  infI.intensity = Infinity;
  const st3 = M.writePoolSlot(dst, infI, tmp, g);
  check("2c: +Inf intensity → parked", st3 === "nonFiniteIntensity" && dst.intensity === 0 && slotFinite(dst));

  const nanC = makeLamp("nanC", 1, 1, 1);
  nanC.color.r = NaN;
  const st4 = M.writePoolSlot(dst, nanC, tmp, g);
  check("2d: NaN colour → parked", st4 === "badColor" && slotFinite(dst));

  const huge = makeLamp("huge", 1, 2, 3, { intensity: 5000, dist: FLT_MAX * 1.3 });
  huge.decay = NaN;
  const st5 = M.writePoolSlot(dst, huge, tmp, g);
  check("2e: huge intensity/distance + NaN decay → clamped, lit, finite",
    st5 === "ok" && dst.intensity === 120 && dst.distance === 1000 && dst.decay === 2 &&
      dst.position.x === 1 && slotFinite(dst),
    `I=${dst.intensity} d=${dst.distance} decay=${dst.decay}`);

  const ok = makeLamp("ok", 4, 5, 6, { intensity: 100, dist: 7.8 });
  const st6 = M.writePoolSlot(dst, ok, tmp, g);
  check("2f: a sane source is copied verbatim",
    st6 === "ok" && dst.intensity === 100 && dst.distance === 7.8 && dst.position.z === 6 &&
      dst.color.g === ok.color.g);

  const spot = new THREE.SpotLight(0xffffff, 0, 0, Math.PI / 6, 0, 2);
  const ssrc = new THREE.SpotLight(0x00ff00, 50, 5, NaN, NaN, 2);
  ssrc.position.set(1, 1, 1);
  ssrc.target.position.set(1, 1, 1); // target ON the light → zero cone axis
  const st7 = M.writePoolSlot(spot, ssrc, tmp, g);
  check("2g: spot with NaN angle/penumbra + degenerate target → finite, aimed down",
    st7 === "ok" && slotFinite(spot) && spot.target.position.y === 0,
    `angle=${spot.angle} pen=${spot.penumbra} tgt=${spot.target.position.toArray()}`);

  const idle = mk();
  idle.position.set(NaN, NaN, NaN);
  const st8 = M.writePoolSlot(idle, null, tmp, g);
  check("2h: idle slot is parked at a finite pose with a finite cutoff (never on a fragment)",
    st8 === "idle" && idle.intensity === 0 && slotFinite(idle) && idle.position.y < -1e4 && idle.distance > 0);
}

// ------------------------------------------- 3. constructor caps the DAT outlier
{
  const base = { x: 0, y: 0, z: 1, colorR: 0, colorG: 150 / 255, colorB: 0, intensity: 100, coneAngle: -2.3e23 };
  const portal = M.buildLightForSetupLight({ ...base, falloff: 6 });
  check("3a: green portal light (0x020005D3) → PointLight, I=100, distance 6*1.3",
    portal && portal.isPointLight && portal.intensity === 100 && Math.abs(portal.distance - 7.8) < 1e-9);
  const fltmax = M.buildLightForSetupLight({ ...base, falloff: FLT_MAX });
  check("3b: FLT_MAX falloff (Setup 0x02001096) → distance capped at 1000, not Inf in float32",
    fltmax && fltmax.distance === 1000, `distance=${fltmax && fltmax.distance}`);
  const wide = M.buildLightForSetupLight({ ...base, falloff: 4, coneAngle: 10 });
  check("3c: an over-wide cone is clamped to π/2", wide && wide.isSpotLight && wide.angle === Math.PI / 2);
}

// ------------------------------- 4. NaN source never selected; sort deterministic
{
  const w = freshWorld({ pointCount: 4 });
  const a = makeLamp("a", 1, 0, 0);
  const b = makeLamp("b", 2, 0, 0);
  const c = makeLamp("c", 3, 0, 0);
  const d = makeLamp("d", 4, 0, 0);
  const bad = makeLamp("bad", NaN, 0, 0);
  w.scene3d.activeLights.push(bad, d, a, c, b);
  w.tick();
  check("4a: NaN-pose source rejected at selection; the 4 real lamps own the slots",
    names(w.pool) === "a,b,c,d" && !w.pool.selPoint.includes(bad), names(w.pool));
  check("4b: every pool slot finite", allSlotsFinite(w.pool));
  check("4c: rejection counted in cell stats", w.scene3d._cellLightsStats.rejected === 1);
  // Repeated forced rebuilds (identity churn) give the identical set.
  let stable = true;
  for (let k = 0; k < 20; k += 1) {
    const extra = makeLamp("x" + k, 50 + k, 0, 0);
    w.scene3d.activeLights.push(extra);
    w.tick();
    w.scene3d.activeLights.pop();
    w.tick();
    if (names(w.pool) !== "a,b,c,d") stable = false;
  }
  check("4d: 40 identity-churn rebuilds with a NaN source present → selection never moves", stable);
}

// --------------------------------- 5. selected source goes NaN mid-hold
{
  const w = freshWorld({ pointCount: 2 });
  const a = makeLamp("a", 1, 0, 0);
  const b = makeLamp("b", 2, 0, 0);
  const c = makeLamp("c", 3, 0, 0);
  w.scene3d.activeLights.push(a, b, c);
  w.tick();
  check("5a: nearest two selected", names(w.pool) === "a,b");
  a.position.x = NaN; // e.g. a rig transform blew up this frame
  w.tick();
  const parked = w.pool.pointStatus.includes("nonFinitePos");
  check("5b: same frame — the bad slot is parked, all slots finite", parked && allSlotsFinite(w.pool),
    w.pool.pointStatus.join(","));
  w.tick();
  check("5c: next frame — slot re-assigned to the next-best source", names(w.pool) === "b,c" && allSlotsFinite(w.pool),
    names(w.pool));
  a.position.x = 1;
  for (let k = 0; k < 61; k += 1) w.tick();
  check("5d: a recovered source is re-admitted by the slow re-check", w.pool.selPoint.includes(a), names(w.pool));
}

// ----------------------------------------------- 6. cell-path stick band
{
  const w = freshWorld({ pointCount: 2, hysteresis: 0.64 });
  const a = makeLamp("a", 5, 0, 0);
  const b = makeLamp("b", -5, 0, 0);
  const c = makeLamp("c", 0, 0, 6);
  w.scene3d.activeLights.push(a, b, c);
  w.tick();
  check("6a: nearest two (a,b) selected", names(w.pool) === "a,b");
  // Player steps so c is marginally nearer than b, then an unrelated rebuild fires.
  w.playerPos.set(0, 0, 0.6); // a,b ≈ 5.04 ; c = 5.4 → still b. Move more:
  w.playerPos.set(0, 0, 1.2); // a,b ≈ 5.14 ; c = 4.8 (only ~7% nearer)
  w.setRenderSet([ROOM, ROOM + 1]);
  w.tick();
  check("6b: a barely-nearer challenger does NOT steal the boundary slot on rebuild (no distant flicker)",
    names(w.pool) === "a,b", names(w.pool));
  w.playerPos.set(0, 0, 3); // a,b ≈ 5.83 ; c = 3 → decisively nearer
  w.setRenderSet([ROOM]);
  w.tick();
  check("6c: a decisively-nearer source does take the slot", w.pool.selPoint.includes(c), names(w.pool));
  const w1 = freshWorld({ pointCount: 2, hysteresis: 1 });
  w1.scene3d.activeLights.push(a, b, c);
  a.__lightPoolSel = b.__lightPoolSel = c.__lightPoolSel = false;
  w1.tick();
  w1.playerPos.set(0, 0, 1.2);
  w1.setRenderSet([ROOM, ROOM + 1]);
  w1.tick();
  check("6d: ?lightHysteresis=1 restores pure nearest-N on the cell path", w1.pool.selPoint.includes(c), names(w1.pool));
}

// ------------------------------------------ 7. detached (ghost) rig sources
{
  const w = freshWorld({ pointCount: 4, withScene: true });
  const live = new THREE.Group();
  w.scene.add(live);
  const ghostRig = new THREE.Group(); // a despawned rig: no longer in the scene
  const a = makeLamp("a", 2, 0, 0, { cellId: null });
  const ghost = makeLamp("ghost", 1, 0, 0, { cellId: null });
  live.add(a);
  ghostRig.add(ghost);
  w.scene3d.activeLights.push(a, ghost);
  w.tick();
  check("7a: a light whose rig left the scene is never selected", names(w.pool) === "a", names(w.pool));
  w.scene.add(ghostRig); // re-attached (e.g. rig re-parented)
  for (let k = 0; k < 61; k += 1) w.tick();
  check("7b: re-attached rig's light is re-admitted by the slow re-check", w.pool.selPoint.includes(ghost), names(w.pool));
  w.scene.remove(ghostRig);
  w.tick();
  check("7c: detaching a SELECTED source parks its slot the same frame",
    w.pool.pointStatus.includes("detached") && allSlotsFinite(w.pool), w.pool.pointStatus.join(","));
}

// ------------------------------------------- 8. legacy (non-cell) path guards
{
  M.__resetLightPoolConfigForTest({ enabled: true, pointCount: 2, spotCount: 1, hysteresis: 0.64 });
  M.__resetCellLightsConfigForTest({ enabled: false, viewerLight: false, viewerIntensity: 2.25 });
  const scene = new THREE.Scene();
  const lighting = M.setupSceneLighting(scene, {});
  const camera = { position: new THREE.Vector3(0, 0, 0) };
  const s3 = { lighting, activeLights: [], camera, cameraSwitcher: { activeCamera: camera } };
  const a = makeLamp("a", 1, 0, 0);
  const bad = makeLamp("bad", 0, Infinity, 0);
  const b = makeLamp("b", 3, 0, 0);
  s3.activeLights.push(bad, a, b);
  M.capActiveLightsByDistance(s3, null);
  check("8a: hysteresis path also skips the non-finite source",
    names(lighting.lightPool) === "a,b" && allSlotsFinite(lighting.lightPool), names(lighting.lightPool));
}

// ------------------------- 9. attach: per-instance stamps + despawned owner skip
{
  M.__resetLightPoolConfigForTest({ enabled: true, pointCount: 4, spotCount: 1, hysteresis: 0.64 });
  M.__resetVertexBakePoolConfigForTest({ dropCellStatics: true });
  const SETUP = 0x020005d3;
  const sl = {
    partIndex: 0, x: 0.03, y: -1.29, z: 2.32, colorR: 0, colorG: 150 / 255, colorB: 0,
    intensity: 100, falloff: 6, coneAngle: -2.3e23, free() {},
  };
  const wasm = {
    async fetchSetupModelLights() {
      return { partCount: 1, takeLights: () => [sl], free() {} };
    },
  };
  const staticsGroup = new THREE.Group();
  const staticMesh = new THREE.Object3D();
  staticMesh.userData = { modelId: SETUP, landblockId: 0xa9b40001 };
  staticsGroup.add(staticMesh);
  const mkInst = (guid) => {
    const root = new THREE.Group();
    const part = new THREE.Group();
    root.add(part);
    return { guid, root, parts: [part], meta: { setupId: SETUP } };
  };
  const live = mkInst(0x7a000001);
  const dead = mkInst(0x7a000002);
  const entityMap = new Map([[live.guid, live], [dead.guid, dead]]);
  const s3 = {
    activeLights: [],
    staticsGroup,
    entityManager: { entityMap },
  };
  // `dead` despawns while the light fetch is in flight.
  const p = M.attachSetupModelLights(s3, wasm);
  entityMap.delete(dead.guid);
  dead._disposed = true;
  const summary = await p;
  const entLights = s3.activeLights.filter((l) => l.userData.__ownerGuid != null);
  check("9a: static + live entity lit; despawned entity got NO ghost light",
    summary.lightCount === 2 && entLights.length === 1 && dead.parts[0].children.length === 0,
    `count=${summary.lightCount} ent=${entLights.length}`);
  const ent = entLights[0];
  check("9b: entity rig light does NOT inherit the static placement's __lbKey (template stamp leak)",
    ent && ent.userData.__lbKey === undefined && ent.userData.__ownerGuid === live.guid &&
      ent.userData.__setupId === SETUP,
    JSON.stringify(ent && ent.userData));
  const st = s3.activeLights.find((l) => l.userData.__lbKey != null);
  check("9c: the static placement keeps its own __lbKey + __setupId",
    st && st.userData.__lbKey === 0xa9b40000 && st.userData.__setupId === SETUP);
}

// ------------------------------------------------------ 10. window.__diag.lights
{
  globalThis.window = {};
  const w = freshWorld({ pointCount: 3, withScene: true });
  const g = new THREE.Group();
  w.scene.add(g);
  const a = makeLamp("portal", 2, 0, 0, { cellId: null });
  a.userData.__setupId = 0x020005d3;
  a.userData.__ownerGuid = 0x7a0000aa;
  g.add(a);
  w.scene3d.activeLights.push(a);
  w.tick();
  const fn = globalThis.window.__diag && globalThis.window.__diag.lights;
  check("10a: window.__diag.lights installed by the light tick", typeof fn === "function");
  const snap = fn();
  const s0 = snap.pool.slots[0];
  check("10b: snapshot names the slot's source (guid/setup), status ok, finite, no bad rows",
    s0.status === "ok" && s0.src.guid === "0x7a0000aa" && s0.src.setupId === "0x020005d3" &&
      s0.finite === true && snap.bad.length === 0 && snap.mode === "pool+cellLights",
    JSON.stringify(s0.src));
  check("10c: snapshot is JSON-serialisable", typeof fn.json() === "string" && fn.json().length > 100);
  w.pool.point[1].position.x = NaN; // simulate a poisoned uniform
  const snap2 = fn();
  check("10d: a poisoned slot shows up in `bad`", snap2.bad.some((r) => r.where === "point1"));
  check("10e: scene lights (sun/ambient/hemi) listed with finite flags",
    snap2.sceneLights.length >= 2 && snap2.sceneLights.every((r) => r.finite === true));
  w.tick();
  check("10f: the next tick repairs the poisoned idle slot", allSlotsFinite(w.pool));
  delete globalThis.window;
}

console.log("=========================");
console.log(`light-guard test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

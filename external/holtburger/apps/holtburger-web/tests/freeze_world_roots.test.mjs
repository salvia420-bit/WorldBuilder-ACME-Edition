// 2026-10-19 — ?freezeWorldRoots (scene3d/freeze_world_roots.js): the Scene,
// worldRoot and the five world groups compose once and stop forcing their
// subtrees through every frame's matrix walk. The claim is EXACTNESS: every
// world matrix equals what three's full cascade computes, frame by frame, for
// every pattern scene3d uses (rigs, late-added manual-matrix nodes, frozen
// script anchors / cells, attach, hidden toggles, re-parenting).
//
// Run:
//   cd apps/holtburger-web/
//   node tests/freeze_world_roots.test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const THREE = await import("three");
const F = await import("../scene3d/freeze_world_roots.js");
const { installSkipHiddenMatrix } = await import("../scene3d/skip_hidden_matrix.js");

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// The app runs the walk with ?skipHiddenMatrix (default on) installed.
installSkipHiddenMatrix(THREE);

console.log("-- F1 flag reader (DEFAULT ON since 2026-10-30; off/0/false/no opt out) ---");
{
  const R = F.freezeWorldRootsRequested;
  check("absent / empty -> on (the default)", R("") === true && R("?foo=1") === true && R("?freezeWorldRoots=") === true);
  check("on / 1 / true / yes / garbage (any case) -> on", ["on", "ON", "1", "true", "yes", "maybe"].every((v) => R(`?freezeWorldRoots=${v}`) === true));
  check("off / 0 / false / no (any case) -> off", ["off", "OFF", "0", "false", "no"].every((v) => R(`?freezeWorldRoots=${v}`) === false));
  check("module flag is ON with no location (node)", F.freezeWorldRootsEnabled() === true);
  // The flag-off path: a second module instance that read ?freezeWorldRoots=off at load.
  globalThis.location = { search: "?freezeWorldRoots=off" };
  const Foff = await import("../scene3d/freeze_world_roots.js?flagoff");
  delete globalThis.location;
  check("?freezeWorldRoots=off: module flag off", Foff.freezeWorldRootsEnabled() === false);
  const g = new THREE.Group();
  check("flag off: freezeWorldRoots freezes nothing", Foff.freezeWorldRoots(THREE, [g]) === 0 && g.matrixAutoUpdate === true && !THREE.Object3D.prototype.__hbFreezeAdd);
}

// ---------------------------------------------------------------------------
// A deterministic world: the same construction and the same per-frame mutations
// run against a default scene (A) and a frozen one (B).
function buildWorld(frozen) {
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group(); worldRoot.name = "worldRoot"; worldRoot.rotation.x = -Math.PI / 2; scene.add(worldRoot);
  const groups = ["terrain", "buildings", "statics", "cells", "entities"].map((n) => { const g = new THREE.Group(); g.name = n; return g; });
  worldRoot.add(...groups);
  const [terrain, buildings, statics, cells, entities] = groups;
  if (frozen) F.freezeWorldRoots(THREE, [scene, worldRoot, ...groups], { force: true });
  const W = { scene, worldRoot, terrain, buildings, statics, cells, entities };

  // (a) terrain chunk meshes: auto, never move
  for (let i = 0; i < 3; i++) { const m = new THREE.Mesh(); m.name = `terrain-${i}`; m.position.set(i * 192, 0, 0); terrain.add(m); }
  // (b) a building: non-auto, placed with updateMatrix() (flags itself)
  const bld = new THREE.Group(); bld.name = "building"; bld.position.set(10, 20, 3); bld.rotation.z = 0.3; bld.updateMatrix(); bld.matrixAutoUpdate = false;
  const shell = new THREE.Mesh(); shell.name = "shell"; shell.matrixAutoUpdate = false; bld.add(shell);
  buildings.add(bld);
  // (c) a static script anchor (?staticAnchorFreeze): world matrix computed, subtree frozen, hidden
  const anchor = new THREE.Group(); anchor.name = "anchor"; anchor.position.set(5, 6, 7); statics.add(anchor);
  const anchorKid = new THREE.Object3D(); anchorKid.name = "anchor-kid"; anchorKid.position.set(0, 0, 1); anchor.add(anchorKid);
  anchor.updateWorldMatrix(true, true);
  anchor.traverse((o) => { o.matrixAutoUpdate = false; o.matrixWorldAutoUpdate = false; });
  anchor.visible = false;
  // (d) an interior cell, frozen after its world matrices are computed (cells.js)
  const cell = new THREE.Group(); cell.name = "cell"; cell.position.set(30, 40, -2); cells.add(cell);
  const cellProp = new THREE.Mesh(); cellProp.name = "cell-prop"; cellProp.position.set(1, 1, 0); cell.add(cellProp);
  cell.updateWorldMatrix(true, true);
  cell.traverse((o) => { o.matrixAutoUpdate = false; o.matrixWorldAutoUpdate = false; });
  // (e) an animated rig: auto parent composing every frame, non-auto part under it
  const rig = new THREE.Group(); rig.name = "rig"; entities.add(rig);
  const part = new THREE.Mesh(); part.name = "rig-part"; part.position.set(0, 0, 1.5); part.updateMatrix(); part.matrixAutoUpdate = false; rig.add(part);
  // (f) occlusion proxy group at the scene root: manual matrix + matrixWorld, flag cleared
  const occ = new THREE.Group(); occ.name = "occlusion-proxies"; occ.matrixAutoUpdate = false; scene.add(occ);
  const proxy = new THREE.Mesh(); proxy.name = "proxy"; proxy.matrixAutoUpdate = false; occ.add(proxy);
  // (g) an fx mesh at the scene root (fx_ribbons / fx_showcase): identity, non-auto
  const fx = new THREE.Mesh(); fx.name = "fx-ribbons"; fx.matrixAutoUpdate = false;

  const late = [];
  function step(f) {
    rig.position.set(Math.sin(f) * 3, Math.cos(f) * 2, 0.5); // the rig walks
    rig.rotation.z = f * 0.1;
    if (f === 1) {
      // (h) animated-scenery InstancedMesh pattern: non-auto, identity, added with no flag
      const inst = new THREE.Mesh(); inst.name = "anim-inst"; inst.matrixAutoUpdate = false; statics.add(inst); late.push(inst);
      // (i) several at once (three re-enters add per argument)
      const a = new THREE.Mesh(), b = new THREE.Mesh(), c = new THREE.Mesh();
      a.name = "multi-a"; b.name = "multi-b"; c.name = "multi-c";
      for (const o of [a, b, c]) o.matrixAutoUpdate = false;
      b.position.set(1, 2, 3); b.updateMatrix();
      entities.add(a, b, c); late.push(a, b, c);
      scene.add(fx);
      // an auto prop hung on the frozen cell after the freeze (attachAnimatedScenery)
      const prop = new THREE.Mesh(); prop.name = "cell-anim-prop"; prop.position.set(0, 2, 0); cell.add(prop); late.push(prop);
    }
    if (f === 2) {
      // (j) attach(): keeps the world transform, computes the world matrix itself
      const loose = new THREE.Mesh(); loose.name = "attached"; loose.position.set(7, 8, 9); loose.matrixAutoUpdate = false; loose.updateMatrix();
      loose.updateMatrixWorld(true);
      buildings.attach(loose); late.push(loose);
    }
    if (f === 3) {
      // (k) re-parent a non-auto node to another frozen group
      const inst = late[0]; cells.add(inst);
      // occlusion proxy re-placed by hand (occlusion_cull.js _place)
      const e = proxy.matrix.elements;
      e[0] = 2; e[5] = 3; e[10] = 4; e[12] = 11; e[13] = 12; e[14] = 13;
      proxy.matrixWorld.copy(proxy.matrix);
      proxy.matrixWorldNeedsUpdate = false;
    }
    if (f === 4) { bld.visible = false; bld.position.x += 5; bld.updateMatrix(); } // moved while hidden
    if (f === 6) bld.visible = true;
    if (f === 7) { shell.position.set(0, 0, 4); shell.updateMatrix(); } // a non-auto child re-posed
  }
  return { W, step };
}

function nodes(scene) { const out = []; scene.traverse((o) => out.push(o)); return out; }

function runPair(frames) {
  // A: three's own add (the patch is global; restore it for the default world)
  F.__unpatchAddForTest(THREE);
  const A = buildWorld(false);
  const B = buildWorld(true);
  let worst = 0, firstBad = "";
  for (let f = 0; f < frames; f++) {
    F.__unpatchAddForTest(THREE);
    A.step(f);
    A.W.scene.updateMatrixWorld();
    F.freezeWorldRoots(THREE, [], { force: true }); // re-arm the add patch for B
    B.step(f);
    B.W.scene.updateMatrixWorld();
    const na = nodes(A.W.scene), nb = nodes(B.W.scene);
    if (na.length !== nb.length) { firstBad ||= `node count ${na.length} vs ${nb.length} at frame ${f}`; worst = Infinity; continue; }
    for (let i = 0; i < na.length; i++) {
      // hidden subtrees are stale by design (skip_hidden_matrix) in BOTH worlds
      let hidden = false;
      for (let o = na[i]; o; o = o.parent) if (o.visible === false) { hidden = true; break; }
      if (hidden) continue;
      const ea = na[i].matrixWorld.elements, eb = nb[i].matrixWorld.elements;
      for (let k = 0; k < 16; k++) {
        const d = Math.abs(ea[k] - eb[k]);
        if (d > worst) { worst = d; if (d > 0 && !firstBad) firstBad = `${na[i].name || na[i].type} frame ${f}`; }
      }
    }
  }
  return { A, B, worst, firstBad };
}

console.log("-- F2 exactness: frozen roots == three's full cascade, every frame ---");
{
  const { A, B, worst, firstBad } = runPair(10);
  check("every visible world matrix identical over 10 frames (late adds, attach, re-parent, hidden move, re-pose)", worst === 0, `worst ${worst} at ${firstBad}`);
  const inst = B.W.scene.getObjectByName("anim-inst");
  const want = new THREE.Matrix4().multiplyMatrices(B.W.cells.matrixWorld, inst.matrix);
  check("the late identity InstancedMesh carries worldRoot's axis flip (not identity)", inst.matrixWorld.equals(want) && !inst.matrixWorld.equals(new THREE.Matrix4()));
  check("the frozen containers stopped auto-updating; the default world's did not",
    [B.W.scene, B.W.worldRoot, B.W.terrain, B.W.entities].every((o) => o.matrixAutoUpdate === false) &&
    [A.W.scene, A.W.worldRoot, A.W.terrain, A.W.entities].every((o) => o.matrixAutoUpdate === true));
  const ra = A.W.scene.getObjectByName("rig-part").matrixWorld, rb = B.W.scene.getObjectByName("rig-part").matrixWorld;
  check("the walking rig's part still follows the rig", ra.equals(rb) && !rb.equals(new THREE.Matrix4()));
}

console.log("-- F3 the walk does less: forced-only multiplies drop -----------------");
{
  const count = (frozen) => {
    F.__unpatchAddForTest(THREE);
    if (frozen) F.freezeWorldRoots(THREE, [], { force: true });
    const w = buildWorld(frozen);
    for (let f = 0; f < 4; f++) { w.step(f); w.W.scene.updateMatrixWorld(); }
    const proto = THREE.Matrix4.prototype;
    const orig = proto.multiplyMatrices;
    let n = 0;
    proto.multiplyMatrices = function (a, b) { n++; return orig.call(this, a, b); };
    try { w.W.scene.updateMatrixWorld(); } finally { proto.multiplyMatrices = orig; }
    return n;
  };
  const a = count(false), b = count(true);
  check(`a settled frame multiplies less (default ${a}, frozen ${b})`, b < a && b > 0);
}

console.log("-- F4 the add patch -----------------------------------------------------");
{
  F.__unpatchAddForTest(THREE);
  F.freezeWorldRoots(THREE, [], { force: true });
  const p = new THREE.Group(), c = new THREE.Object3D(), d = new THREE.Object3D(), e = new THREE.Object3D();
  for (const o of [c, d, e]) o.matrixWorldNeedsUpdate = false;
  p.add(c);
  check("add() flags the child for the next walk", c.matrixWorldNeedsUpdate === true && c.parent === p);
  p.add(d, e);
  check("add(a, b) flags each child", d.matrixWorldNeedsUpdate === true && e.matrixWorldNeedsUpdate === true);
  const q = new THREE.Group(); c.matrixWorldNeedsUpdate = false; q.add(c);
  check("re-parenting flags too", c.parent === q && c.matrixWorldNeedsUpdate === true);
  const before = F.getFreezeWorldRootsStats().addsFlagged;
  const err = console.error;
  console.error = () => {}; // three logs the refused self-add with the whole object
  try { p.add(p); } finally { console.error = err; }
  check("a refused add (self) flags nothing", F.getFreezeWorldRootsStats().addsFlagged === before);
  F.__unpatchAddForTest(THREE);
  check("test hook restores three's add", !THREE.Object3D.prototype.__hbFreezeAdd);
}

console.log("-- F5 verifyWorldMatrices -----------------------------------------------");
{
  F.__unpatchAddForTest(THREE);
  F.freezeWorldRoots(THREE, [], { force: true });
  const w = buildWorld(true);
  for (let f = 0; f < 3; f++) { w.step(f); w.W.scene.updateMatrixWorld(); }
  const r0 = F.verifyWorldMatrices(w.W.scene);
  check(`a walked frozen world verifies clean (${r0.checked} checked)`, r0.mismatches === 0 && r0.checked > 10 && r0.pending === 0, JSON.stringify(r0));
  const shell = w.W.scene.getObjectByName("shell");
  shell.matrixWorld.elements[12] += 1;
  const r1 = F.verifyWorldMatrices(w.W.scene);
  check("a stale world matrix is reported by name", r1.mismatches === 1 && r1.samples[0].startsWith("shell"), JSON.stringify(r1));
  shell.matrixWorldNeedsUpdate = true;
  const r2 = F.verifyWorldMatrices(w.W.scene);
  check("a node flagged for the next walk is pending, not a mismatch", r2.mismatches === 0 && r2.pending === 1);
  w.W.scene.updateMatrixWorld();
  w.W.buildings.visible = false;
  w.W.scene.getObjectByName("building").matrixWorld.elements[12] += 9;
  const r3 = F.verifyWorldMatrices(w.W.scene);
  check("hidden subtrees are not checked (never drawn)", r3.mismatches === 0);
}

console.log("-- F6 negative control: without the add patch the freeze is NOT exact -");
{
  F.__unpatchAddForTest(THREE);
  const w = buildWorld(true);
  F.__unpatchAddForTest(THREE); // the freeze installed it; take it away
  for (let f = 0; f < 3; f++) { w.step(f); w.W.scene.updateMatrixWorld(); }
  const inst = w.W.scene.getObjectByName("anim-inst");
  const r = F.verifyWorldMatrices(w.W.scene);
  check("the late identity mesh keeps an identity world matrix (missing the axis flip)", inst.matrixWorld.equals(new THREE.Matrix4()));
  check("…and verify() catches it", r.mismatches >= 1 && r.samples.some((s) => s.startsWith("anim-inst")), JSON.stringify(r));
}

console.log("-- F7 the verify seam ---------------------------------------------------");
{
  globalThis.window = {};
  const scene = new THREE.Scene();
  const g = new THREE.Group(); g.position.set(1, 2, 3); scene.add(g);
  const renderer = { render(s) { if (s === scene) s.updateMatrixWorld(); } };
  const origRender = renderer.render;
  check("seam installs", F.installFreezeWorldRootsSeam(renderer, scene) === true && typeof window.__freezeWorldRoots.verify === "function");
  const p = window.__freezeWorldRoots.verify();
  renderer.render(new THREE.Scene());
  check("verify waits for a render of the main scene", renderer.render !== origRender);
  renderer.render(scene);
  const r = await p;
  check("…then reports and unwraps render()", r && r.mismatches === 0 && r.checked === 1 && r.frozen === true /* default ON since 2026-10-30 */ && renderer.render === origRender, JSON.stringify(r));
  delete globalThis.window;
}

console.log("-- F8 wiring ---------------------------------------------------------------");
{
  const idx = readFileSync(path.join(APP, "scene3d", "index.js"), "utf8");
  check("index.js freezes the Scene, worldRoot and the five groups right after they are assembled",
    /worldRoot\.add\(terrainGroup, buildingsGroup, staticsGroup, cellsGroup, entitiesGroup\);\s*\n(\s*\/\/[^\n]*\n)+\s*try \{\s*freezeWorldRoots\(THREE, \[scene, worldRoot, terrainGroup, buildingsGroup, staticsGroup, cellsGroup, entitiesGroup\]\);\s*installFreezeWorldRootsSeam\(renderer, scene\);/.test(idx));
  check("index.js imports both", /import \{ freezeWorldRoots, installFreezeWorldRootsSeam \} from "\.\/freeze_world_roots\.js";/.test(idx));
  const code = idx.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const moves = code.match(/\b(worldRoot|terrainGroup|buildingsGroup|staticsGroup|cellsGroup|entitiesGroup)\.(position|rotation|quaternion|scale)\.(set|copy|[xyz]\s*=)[^\n]*/g) || [];
  check("the containers are never moved after construction (the freeze's premise)",
    moves.length === 1 && moves[0].startsWith("worldRoot.rotation.x = -Math.PI / 2;"), JSON.stringify(moves));
}

console.log(`\nfreeze world roots: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

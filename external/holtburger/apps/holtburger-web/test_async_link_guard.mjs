// 2026-10-06 — ?asyncLink (scene3d/async_link_guard.js): a world draw whose
// shader program is new / still linking is skipped and compiled off-frame.
//
// Run:
//   cd apps/holtburger-web/
//   node test_async_link_guard.mjs

import { linkDecision, installAsyncLinkGuard, VERSION_DEFER_MAX, newLinkState } from "./scene3d/async_link_guard.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("PART 1 — linkDecision");
{
  const ready = { isReady: () => true }, linking = { isReady: () => false };
  check("no program yet ⇒ defer + compile", linkDecision({ version: 1, userData: {} }, {}) === 1);
  check("program still linking ⇒ defer, no new compile", linkDecision({ version: 1, userData: {} }, { currentProgram: linking, __version: 1 }) === 2);
  check("ready program, same version ⇒ draw", linkDecision({ version: 1, userData: {} }, { currentProgram: ready, __version: 1 }) === 0);
  check("prewarmed but never drawn (no __version) ⇒ defer + compile (a cache hit if unchanged)",
    linkDecision({ version: 4, userData: {} }, { currentProgram: ready }) === 1);
  check("…drawn once the guard compiled that very version",
    linkDecision({ version: 4, userData: {} }, { currentProgram: ready }, 0, Object.assign(newLinkState(), { ver: 4 })) === 0);
  check("version moved ⇒ defer + compile", linkDecision({ version: 2, userData: {} }, { currentProgram: ready, __version: 1 }) === 1);
  const st = (o) => Object.assign(newLinkState(), o);
  check("version we already compiled ⇒ draw", linkDecision({ version: 2, userData: {} }, { currentProgram: ready, __version: 1 }, 0, st({ ver: 2 })) === 0);
  check(`a version that keeps moving is deferred at most ${VERSION_DEFER_MAX}x in a burst`,
    linkDecision({ version: 9, userData: {} }, { currentProgram: ready, __version: 1 }, 0, st({ verDefers: VERSION_DEFER_MAX, verDeferAt: performance.now() })) === 0);
  check("…but an occasional upgrade long after the last one is deferred again (rate cap, not a lifetime cap)",
    linkDecision({ version: 9, userData: {} }, { currentProgram: ready, __version: 1 }, 0, st({ verDefers: VERSION_DEFER_MAX, verDeferAt: performance.now() - 60000 })) === 1);
  check("compile in flight ⇒ defer", linkDecision({ version: 1, userData: {} }, {}, 0, st({ pending: true })) === 2);
  check("__noAsyncLink materials always draw", linkDecision({ version: 1, userData: { __noAsyncLink: true } }, {}) === 0);
  const plainProg = { currentProgram: ready, __version: 1, batching: false, instancing: false, skinning: false };
  check("another object KIND (batched) on a plain-linked material ⇒ defer + compile",
    linkDecision({ version: 1, userData: {} }, plainProg, 1) === 1);
  check("…but a kind we already compiled for it ⇒ draw (program-cache hit)",
    linkDecision({ version: 1, userData: {} }, plainProg, 1, st({ combos: new Set([1]) })) === 0);
  check("same kind ⇒ draw", linkDecision({ version: 1, userData: {} }, plainProg, 0) === 0);
  // Geometry-dependent variants (three's vertexAlphas / vertexTangents / morph).
  const { objectCombo } = await import("./scene3d/async_link_guard.js");
  const matVC = { vertexColors: true, normalMap: {}, userData: {} };
  const geoA = { attributes: { color: { itemSize: 4 }, tangent: {} }, morphAttributes: {} };
  const geoB = { attributes: { color: { itemSize: 3 } }, morphAttributes: { position: [1] } };
  check("vertex alphas + tangents set their bits", objectCombo({ geometry: geoA }, matVC) === (8 | 16));
  check("RGB colours + morph targets set only the morph bit", objectCombo({ geometry: geoB }, matVC) === 32);
  check("a material linked for one geometry signature defers on another",
    linkDecision({ version: 1, userData: {} }, { ...plainProg, vertexAlphas: true, vertexTangents: true }, 32) === 1);
}

console.log("PART 2 — the renderBufferDirect wrapper");
{
  // Fake renderer: compile() assigns a program that becomes ready after 2 polls.
  const props = new WeakMap();
  const draws = [];
  const scene = { isScene: true }, other = { isScene: true };
  const renderer = {
    properties: { get(m) { let p = props.get(m); if (!p) { p = {}; props.set(m, p); } return p; } },
    renderBufferDirect(camera, sc, g, material, object) { draws.push(object.name); const mp = this.properties.get(material); mp.__version = material.version; },
    compiles: 0,
    compile(root) {
      // three's compile() only walks its first argument with traverse().
      this.compiles += 1;
      const set = new Set();
      root.traverse((o) => {
        set.add(o.material);
        let polls = 0;
        this.properties.get(o.material).currentProgram = { isReady: () => ++polls > 2 };
      });
      return set;
    },
  };
  globalThis.window = {};
  const api = installAsyncLinkGuard(renderer, () => scene);
  check("installed + diag surface", !!api && window.__asyncLink === api);
  const mat = { type: "MeshStandardMaterial", version: 0, userData: {} };
  const obj = { name: "tree", material: mat };
  renderer.renderBufferDirect({}, scene, {}, mat, obj, null);
  check("first draw of a new material is skipped", draws.length === 0 && api.stats.deferred === 1 && api.pending === 1);
  renderer.renderBufferDirect({}, other, {}, mat, obj, null);
  check("other scenes (sky, post, shadow) are never deferred", draws.length === 1);
  draws.length = 0;
  await sleep(5);
  check("queue drained off-frame into a compile", api.pending === 0 && api.stateOf(mat)?.pending === true);
  renderer.renderBufferDirect({}, scene, {}, mat, obj, null);
  check("still skipped while the compile is in flight", draws.length === 0);
  await sleep(80); // guardedCompileAsync polls every 10 ms
  check("compile resolved", api.stats.compiled === 1 && api.stateOf(mat)?.pending === false, JSON.stringify(api.stats));
  check("one compile() call per drain", renderer.compiles === 1);
  renderer.renderBufferDirect({}, scene, {}, mat, obj, null);
  check("draws once its program is ready", draws.length === 1);
  const sh = { type: "ShaderMaterial", version: 0, userData: {} };
  renderer.renderBufferDirect({}, scene, {}, sh, { name: "post", material: sh }, null);
  check("ShaderMaterial draws untouched", draws.length === 2);
  // A burst of new materials in one frame → ONE compile() (one light traverse).
  const before = renderer.compiles;
  const burst = [0, 1, 2, 3, 4].map((i) => ({ name: "b" + i, material: { type: "MeshStandardMaterial", version: 0, userData: {} } }));
  for (const o of burst) renderer.renderBufferDirect({}, scene, {}, o.material, o, null);
  await sleep(5);
  check("a burst of 5 new materials compiles in ONE call", renderer.compiles - before === 1, `calls=${renderer.compiles - before}`);
  await sleep(80);
  draws.length = 0;
  for (const o of burst) renderer.renderBufferDirect({}, scene, {}, o.material, o, null);
  check("…and all of them draw once ready", draws.length === 5);
  // A ?batchMatVariant material (Object.create(member)) must not inherit the
  // member's "already linked" stamp.
  const member = burst[0].material;
  const variant = Object.create(member);
  variant.userData = {};
  draws.length = 0;
  renderer.renderBufferDirect({}, scene, {}, variant, { name: "bucket", material: variant }, null);
  check("a prototype-derived variant is checked on its own (no inherited stamp)", draws.length === 0 && api.stats.deferred > 0);
  // Steady state: a stamped material costs only the stamp compare.
  const before2 = api.stats.deferred;
  for (let i = 0; i < 100; i++) renderer.renderBufferDirect({}, scene, {}, member, burst[0], null);
  check("stamped materials draw without re-checking", api.stats.deferred === before2);
  // Only the four fixed-order stamp fields ever land ON a material.
  const own = Object.keys(member).filter((k) => k.startsWith("__hb"));
  check("only the 4 stamp fields are stored on the material, in one order",
    own.join(",") === "__hbLinkOk,__hbLinkOkOwner,__hbLinkOkCombo,__hbLinkOkListen", own.join(","));
  api.uninstall();
  delete globalThis.window;
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

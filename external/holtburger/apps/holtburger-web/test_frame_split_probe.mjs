// 2026-08-06 — `scene3d/frame_split.js`, the instrument that splits the
// ~5.72 ms remainder of `renderer.render()`.
//
// WHY THIS FILE EXISTS. The probe's whole value is that its numbers get quoted
// into a design decision, and this workload has now produced four separate 2x+
// overestimates from instruments that looked right (see
// `docs/2026-08-06-frame-cost-structure-measured.md` §5c and
// `test_static_merge_projection.mjs`). An instrument that is wrong is worse
// than no instrument. So every property the probe's conclusions rest on is
// asserted here, against a FAKE renderer that reproduces three r184's real call
// ORDER — because the order is the entire basis of the attribution.
//
//   PART 1 — the seams land where three calls them, and the phase boundaries
//            are the ones claimed. `projectObject` is measured as
//            `list.finish` entry minus `list.init` exit, and the fixture puts a
//            known, deliberately slow "traversal" in exactly that window.
//   PART 2 — DRAWS ARE SUBTRACTED FROM THE SHADOW WINDOW. The shadow phase
//            contains real `renderBufferDirect` calls. A shadow bucket that
//            counted them would double-charge the draw funnel and invent a
//            traversal cost that is really draw cost. This is the single
//            assertion that separates an honest shadow number from a fictional
//            one.
//   PART 3 — SILENCE IS NOT SUCCESS. A seam that never fires reports `null`.
//            `sortMs` is null when `sortObjects === false` (three does not call
//            `sort` at all then), `objHookMs` is null unless explicitly armed,
//            and every bucket derived from a null is null.
//   PART 4 — THE BOOKS CLOSE. The buckets are disjoint wall-clock windows over
//            one call, so they must re-add to the measured total. `booksClosed`
//            must be true on a well-formed call and FALSE when a phase goes
//            missing — a residual nobody checks is how a missing phase becomes
//            an invisible bucket.
//   PART 5 — FOREIGN SCENES ARE NOT FOLDED IN. The composer also renders the
//            sky-dome scene. Those calls, and their draws, must land in
//            `otherSceneCalls` / `rbdOtherDraws`, never in the world call's
//            mean. Averaging a 0.2 ms sky pass into a 24 ms world pass halves
//            nothing visibly and corrupts everything.
//   PART 6 — THE SHADOW DUTY CYCLE. The RP5 gate (`lighting.js`) makes the
//            identical 3-cascade traversal fire on some frames and not others.
//            `dutyCycle` must track it, and `traversalMsPerRaster` must use the
//            rastering calls as its denominator — quoting the all-calls mean
//            understates one raster by exactly 1/dutyCycle.
//   PART 7 — THE CENSUS NAMES ITS SCALES. RESIDENT (what
//            `scene.updateMatrixWorld` walks — no `visible` early-out) must be
//            strictly larger than VISITED (what `projectObject` and each shadow
//            cascade walk) whenever anything is hidden. Conflating them is the
//            `_projDrawn` error one rung up, and `visitsPerFrame` must state
//            the 5-walk total rather than the 1-walk count.
//   PART 8 — THE BALLAST IS IMAGE-IDENTICAL AND ABSOLUTE. Empty Groups must
//            push nothing onto a render list, and setting a ballast twice must
//            REPLACE it, not accumulate — a cumulative ballast silently voids
//            the A/B it exists to serve.
//   PART 9 — DISARM RESTORES EVERYTHING, including the `scene.onBeforeRender`
//            case where there was no own property to begin with. Leaving an own
//            no-op shadowing `Object3D.prototype` would be a permanent, silent
//            change to a scene the probe claims to only observe.
//
// Run:
//   cd apps/holtburger-web/
//   node test_frame_split_probe.mjs

import { Group, Mesh, Object3D, Scene } from "three";
import {
  armFrameSplit,
  disarmFrameSplit,
  resetFrameSplit,
  frameSplitReport,
  frameSplitSamples,
  frameSplitCensus,
  setFrameSplitBallast,
} from "./scene3d/frame_split.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}
function near(a, b, tol) {
  return typeof a === "number" && isFinite(a) && Math.abs(a - b) <= tol;
}

// ---------------------------------------------------------------------------
// Fixture. A fake renderer whose `render()` reproduces three r184's ORDER, from
// `WebGLRenderer.js` `this.render = function (scene, camera)`:
//
//   scene.updateMatrixWorld()            <- the matrix phase
//   camera.updateMatrixWorld()
//   scene.onBeforeRender(...)            <- SEAM: end of the matrix phase
//   renderStates.get/init, frustum, clipping.init
//   currentRenderList = renderLists.get(scene, 0)
//   currentRenderList.init()             <- SEAM: start of projectObject
//   projectObject(scene, ...)
//   currentRenderList.finish()           <- SEAM: end of projectObject
//   currentRenderList.sort(...)          <- SEAM (skipped if !sortObjects)
//   background.addToRenderList(...)
//   shadowMap.render(shadowsArray, ...)  <- SEAM: contains its own draws
//   renderScene -> renderObjects -> renderObject -> renderBufferDirect
//   scene.onAfterRender(...)             <- SEAM: end of the scene submission
//   (render-target resolve, output.end, stack pops)
//
// Time is BURNED with a spin loop rather than mocked, because the probe reads
// the same real clock the app does; a mocked clock would test a transcription
// of the arithmetic instead of the instrument.
// ---------------------------------------------------------------------------

function burn(ms) {
  const end = performance.now() + ms;
  // eslint-disable-next-line no-empty
  while (performance.now() < end) {}
}

function makeRenderList() {
  const opaque = [], transmissive = [], transparent = [];
  return {
    opaque, transmissive, transparent,
    init() { opaque.length = 0; transmissive.length = 0; transparent.length = 0; },
    push(item) { (item.transparent ? transparent : opaque).push(item); },
    finish() { burn(0.2); },
    sort() { burn(0.4); },
  };
}

function makeRenderer(scene, opts = {}) {
  const list = makeRenderList();
  const lists = new Map([[scene, list]]);
  const r = {
    sortObjects: opts.sortObjects !== false,
    renderLists: { get: (s) => lists.get(s) || (lists.set(s, makeRenderList()), lists.get(s)) },
    shadowMap: opts.noShadowMap
      ? null
      : {
          enabled: opts.shadowEnabled !== false,
          autoUpdate: false,
          needsUpdate: opts.shadowNeedsUpdate !== false,
          render(lights /* , scene, camera */) {
            if (!this.enabled) return;
            if (this.autoUpdate === false && this.needsUpdate === false) return;
            if (!lights || lights.length === 0) return;
            burn(opts.shadowTraverseMs ?? 1.0); // the per-cascade walks
            for (let i = 0; i < (opts.shadowDraws ?? 6); i++) {
              r.renderBufferDirect(); // shadow draws go through the SAME funnel
            }
            this.needsUpdate = false;
          },
        },
    renderBufferDirect() { burn(opts.drawMs ?? 0.05); },
    render(s /* , camera */) {
      burn(opts.matrixMs ?? 0.8); // scene.updateMatrixWorld + camera
      if (s.onBeforeRender) s.onBeforeRender(r, s, null, null);
      burn(0.1); // renderStates / frustum / clipping / renderLists.get
      const l = r.renderLists.get(s);
      l.init();
      burn(opts.projectMs ?? 1.5); // projectObject
      for (let i = 0; i < (opts.submitted ?? 12); i++) l.push({ transparent: i % 3 === 0 });
      l.finish();
      if (r.sortObjects) l.sort();
      burn(0.05); // background.addToRenderList
      if (r.shadowMap) r.shadowMap.render(opts.shadowLights ?? [1, 2, 3], s, null);
      burn(opts.lightsMs ?? 0.3); // setupLights / setupLightsView
      for (let i = 0; i < (opts.sceneDraws ?? 20); i++) {
        burn(0.02); // per-draw glue: modelViewMatrix, normalMatrix, layers.test
        r.renderBufferDirect();
      }
      if (s.onAfterRender) s.onAfterRender(r, s, null);
      burn(0.1); // resolve / output.end / stack pops
    },
  };
  return r;
}

// ---------------------------------------------------------------------------
console.log("PART 1 — the seams bracket the phases three actually has");
// ---------------------------------------------------------------------------
{
  const scene = new Scene();
  const renderer = makeRenderer(scene, { matrixMs: 2.0, projectMs: 3.0 });
  const a = armFrameSplit({ renderer, scene });
  check("arms", a.armed === true, JSON.stringify(a));
  for (let i = 0; i < 6; i++) renderer.render(scene);
  disarmFrameSplit();
  const rep = frameSplitReport();
  check("accounts every world call", rep.calls === 6, `calls=${rep.calls}`);
  // The fixture burns 2.0 ms before onBeforeRender and 3.0 ms between
  // init-exit and finish-entry. A spin loop overshoots slightly and never
  // undershoots, so the tolerance is one-sided-ish but generous.
  check(
    "preProject ≈ the matrix phase (2.0 ms)",
    near(rep.buckets.preProject, 2.0, 0.8),
    `${rep.buckets.preProject?.toFixed(2)} ms`
  );
  check(
    "project ≈ projectObject (3.0 ms), measured init-exit → finish-entry",
    near(rep.buckets.project, 3.0, 0.8),
    `${rep.buckets.project?.toFixed(2)} ms`
  );
  check(
    "sort ≈ the two sorts (0.4 ms)",
    near(rep.buckets.sort, 0.4, 0.4),
    `${rep.buckets.sort?.toFixed(2)} ms`
  );
  check(
    "submitted comes from the render list, at SUBMITTED scale",
    rep.submitted.perCall === 12,
    `${rep.submitted.perCall}`
  );
  check("samples ring populated", frameSplitSamples().length === 6);
}

// ---------------------------------------------------------------------------
console.log("PART 2 — shadow draws are SUBTRACTED from the shadow window");
// ---------------------------------------------------------------------------
{
  const scene = new Scene();
  // 1.0 ms of traversal, then 8 draws at 0.25 ms = 2.0 ms of DRAW inside the
  // shadow window. A probe that reported the raw window would claim ~3.0 ms of
  // "shadow traversal" — three times the truth, and every one of those ms is
  // already counted in the draw funnel.
  const renderer = makeRenderer(scene, {
    shadowTraverseMs: 1.0,
    shadowDraws: 8,
    drawMs: 0.25,
    sceneDraws: 4,
  });
  armFrameSplit({ renderer, scene });
  for (let i = 0; i < 5; i++) {
    renderer.shadowMap.needsUpdate = true;
    renderer.render(scene);
  }
  disarmFrameSplit();
  const rep = frameSplitReport();
  const sp = rep.shadowSplit;
  check("shadow draws counted", sp.drawsPerCall === 8, `${sp.drawsPerCall}`);
  check(
    "raw shadow window includes the draws (~3.0 ms)",
    near(rep.buckets.shadow, 3.0, 1.0),
    `${rep.buckets.shadow?.toFixed(2)} ms`
  );
  check(
    "shadow TRAVERSAL is the window minus the draws (~1.0 ms)",
    near(sp.traversalMs, 1.0, 0.7),
    `${sp.traversalMs?.toFixed(2)} ms vs raw ${rep.buckets.shadow?.toFixed(2)}`
  );
  check(
    "scene draws are not mixed into the shadow draws",
    rep.sceneSplit.drawsPerCall === 4,
    `${rep.sceneSplit.drawsPerCall}`
  );
}

// ---------------------------------------------------------------------------
console.log("PART 3 — silence is not success: absent phases read null");
// ---------------------------------------------------------------------------
{
  const scene = new Scene();
  const renderer = makeRenderer(scene, { sortObjects: false });
  armFrameSplit({ renderer, scene });
  for (let i = 0; i < 3; i++) renderer.render(scene);
  disarmFrameSplit();
  const rep = frameSplitReport();
  check("sortMs is null when sortObjects === false", rep.buckets.sort === null,
    `got ${rep.buckets.sort}`);
  check("and the skipped calls are counted", rep.health.noSortCalls === 3,
    `${rep.health.noSortCalls}`);
  check("objHookMs is null when not armed for it", rep.objHookMs === null);
  check("glueAndLights is null because objHooks is", rep.sceneSplit.glueAndLightsMs === null);
  check(
    "remainder says it still contains the object hooks",
    rep.remainderIncludesObjHooks === true
  );
}
{
  // No shadowMap at all: the shadow bucket must read null, not 0.00 ms.
  const scene = new Scene();
  const renderer = makeRenderer(scene, { noShadowMap: true });
  armFrameSplit({ renderer, scene });
  renderer.render(scene);
  renderer.render(scene);
  disarmFrameSplit();
  const rep = frameSplitReport();
  check("shadow bucket null with no shadowMap", rep.buckets.shadow === null,
    `got ${rep.buckets.shadow}`);
  check("shadow traversal null too", rep.shadowSplit.traversalMs === null);
  check(
    "sceneSubmit still measured (window falls back to the sort/finish end)",
    typeof rep.buckets.sceneSubmit === "number" && rep.buckets.sceneSubmit > 0,
    `${rep.buckets.sceneSubmit?.toFixed(2)} ms`
  );
}
{
  // rbd unwrapped: the subtractions are unavailable, so they must read null
  // rather than silently equalling the raw window.
  const scene = new Scene();
  const renderer = makeRenderer(scene);
  armFrameSplit({ renderer, scene, rbd: false });
  renderer.render(scene);
  disarmFrameSplit();
  const rep = frameSplitReport();
  check("drawFunnelMs null when rbd unwrapped", rep.drawFunnelMs === null);
  check("shadow traversal null when rbd unwrapped", rep.shadowSplit.traversalMs === null);
  check("remainderMs null when rbd unwrapped", rep.remainderMs === null);
}

// ---------------------------------------------------------------------------
console.log("PART 4 — the books close, and say so when they do not");
// ---------------------------------------------------------------------------
{
  const scene = new Scene();
  const renderer = makeRenderer(scene);
  armFrameSplit({ renderer, scene });
  for (let i = 0; i < 8; i++) {
    renderer.shadowMap.needsUpdate = true;
    renderer.render(scene);
  }
  disarmFrameSplit();
  const rep = frameSplitReport();
  check("booksClosed on a well-formed call", rep.health.booksClosed === true,
    `residual ${rep.health.residualMs?.toFixed(3)} ms, tol ${rep.health.toleranceMs?.toFixed(3)}`);
  const sum = Object.values(rep.buckets).reduce((a, b) => a + (b ?? 0), 0);
  check("buckets re-add to the measured total",
    Math.abs(sum - rep.total) <= rep.health.toleranceMs,
    `Σ ${sum.toFixed(2)} vs total ${rep.total.toFixed(2)}`);
  check("probeOverheadMs is reported, not assumed",
    typeof rep.health.probeOverheadMs === "number" && rep.health.probeOverheadMs >= 0,
    `${rep.health.probeOverheadMs?.toFixed(4)} ms`);
}
{
  // A render list swapped out from under the patch (three's
  // `renderLists.dispose()` on context loss). `project` must go null and the
  // event must be counted, not averaged away as a fast frame.
  const scene = new Scene();
  const renderer = makeRenderer(scene);
  armFrameSplit({ renderer, scene });
  renderer.render(scene);
  const orphan = makeRenderList();
  renderer.renderLists.get = () => orphan; // the patch is now orphaned
  renderer.render(scene);
  renderer.render(scene);
  disarmFrameSplit();
  const rep = frameSplitReport();
  check("detached list calls counted", rep.health.listDetachedCalls === 2,
    `${rep.health.listDetachedCalls}`);
  check("books do NOT close with a phase missing", rep.health.booksClosed === false);
}

// ---------------------------------------------------------------------------
console.log("PART 5 — foreign scenes are not folded into the world mean");
// ---------------------------------------------------------------------------
{
  const scene = new Scene();
  const skyScene = new Scene();
  const renderer = makeRenderer(scene, { sceneDraws: 20 });
  armFrameSplit({ renderer, scene });
  for (let i = 0; i < 4; i++) {
    renderer.render(skyScene); // the sky-dome pass
    renderer.render(scene); // the world
  }
  disarmFrameSplit();
  const rep = frameSplitReport();
  check("world calls counted alone", rep.calls === 4, `${rep.calls}`);
  check("foreign calls counted separately", rep.otherSceneCalls === 4,
    `${rep.otherSceneCalls}`);
  check("foreign draws land in rbdOther, not the world funnel",
    rep.health.rbdOtherDraws > 0 && rep.sceneSplit.drawsPerCall === 20,
    `other=${rep.health.rbdOtherDraws} world=${rep.sceneSplit.drawsPerCall}`);
}

// ---------------------------------------------------------------------------
console.log("PART 6 — the shadow duty cycle, and the right denominator");
// ---------------------------------------------------------------------------
{
  const scene = new Scene();
  const renderer = makeRenderer(scene, {
    shadowTraverseMs: 1.2, shadowDraws: 4, drawMs: 0.05, shadowNeedsUpdate: false,
  });
  armFrameSplit({ renderer, scene });
  // 8 calls, re-arming the gate on every other one — the RP5 pattern.
  for (let i = 0; i < 8; i++) {
    if (i % 2 === 0) renderer.shadowMap.needsUpdate = true;
    renderer.render(scene);
  }
  disarmFrameSplit();
  const rep = frameSplitReport();
  const sp = rep.shadowSplit;
  check("dutyCycle tracks the gate", near(sp.dutyCycle, 0.5, 0.01), `${sp.dutyCycle}`);
  check("cascade count is reported", near(sp.cascades, 3, 0.01), `${sp.cascades}`);
  check(
    "per-raster traversal is ~2x the all-calls mean at 50% duty",
    sp.traversalMsPerRaster > sp.traversalMs * 1.6,
    `perRaster ${sp.traversalMsPerRaster?.toFixed(2)} vs mean ${sp.traversalMs?.toFixed(2)}`
  );
}

// ---------------------------------------------------------------------------
console.log("PART 7 — the census names its scales, and they differ");
// ---------------------------------------------------------------------------
{
  const scene = new Scene();
  const visibleGroup = new Group();
  const hiddenGroup = new Group();
  hiddenGroup.visible = false;
  for (let i = 0; i < 5; i++) visibleGroup.add(new Group());
  for (let i = 0; i < 7; i++) hiddenGroup.add(new Group());
  const mesh = new Mesh();
  mesh.castShadow = true;
  visibleGroup.add(mesh);
  scene.add(visibleGroup, hiddenGroup);

  const cen = frameSplitCensus(scene);
  // resident = scene + visibleGroup + 5 + mesh + hiddenGroup + 7 = 16
  check("RESIDENT counts everything (updateMatrixWorld has no visible early-out)",
    cen.resident.nodes === 16, `${cen.resident.nodes}`);
  // visited = 16 - (hiddenGroup + its 7) = 8
  check("VISITED prunes the hidden subtree (projectObject and the shadow walk do)",
    cen.visited.nodes === 8, `${cen.visited.nodes}`);
  check("the pruned subtree is reported, not just missing",
    cen.pruned.subtrees === 1 && cen.pruned.nodes === 8,
    `${cen.pruned.subtrees} subtree(s), ${cen.pruned.nodes} nodes`);
  check("inert nodes (pure traversal tax) are separated from meshes",
    cen.visited.inert === 7 && cen.visited.meshes === 1,
    `inert=${cen.visited.inert} meshes=${cen.visited.meshes}`);
  check("resident > visited whenever anything is hidden",
    cen.resident.nodes > cen.visited.nodes);
  check("visitsPerFrame states the 5-walk total, not the 1-walk count",
    cen.visitsPerFrame.updateMatrixWorld === cen.resident.nodes &&
      cen.visitsPerFrame.projectObject === cen.visited.nodes,
    JSON.stringify({
      umw: cen.visitsPerFrame.updateMatrixWorld,
      proj: cen.visitsPerFrame.projectObject,
    }));
  check("the census does NOT claim a submitted count",
    /NOT computed here/.test(cen.scales.submitted));
}

// ---------------------------------------------------------------------------
console.log("PART 8 — the ballast is image-identical and absolute");
// ---------------------------------------------------------------------------
{
  const scene = new Scene();
  const before = frameSplitCensus(scene).resident.nodes;
  const inertBefore = frameSplitCensus(scene).visited.inert;
  const b1 = setFrameSplitBallast(100, { scene, fanout: 8 });
  check("ballast attaches exactly n nodes", b1.ballast === 100,
    JSON.stringify(b1));
  const withBallast = frameSplitCensus(scene);
  check("n extra nodes in the graph", withBallast.resident.nodes === before + 100,
    `${withBallast.resident.nodes} vs ${before}`);
  check("all of them are inert — they can never contribute a draw",
    withBallast.visited.inert === inertBefore + 100 && withBallast.visited.meshes === 0,
    `inert=${withBallast.visited.inert} (was ${inertBefore})`);

  // Setting it again must REPLACE, not accumulate. A cumulative ballast makes
  // the second arm of an A/B measure a population nobody chose.
  const b2 = setFrameSplitBallast(40, { scene, fanout: 8 });
  check("re-setting replaces rather than accumulates",
    b2.ballast === 40 && frameSplitCensus(scene).resident.nodes === before + 40,
    `${frameSplitCensus(scene).resident.nodes}`);

  // The hidden arm: updateMatrixWorld still walks it (RESIDENT), projectObject
  // and the shadow walk do not (VISITED). That difference IS the instrument.
  const b3 = setFrameSplitBallast(40, { scene, fanout: 8, visible: false });
  const hid = frameSplitCensus(scene);
  check("hidden ballast counts as RESIDENT", hid.resident.nodes === before + 40,
    `${hid.resident.nodes}`);
  check("hidden ballast does NOT count as VISITED", hid.visited.nodes === before,
    `${hid.visited.nodes} vs ${before}`);
  check("and the arm says which walks it prices", /updateMatrixWorld ONLY/.test(b3.note));

  // Image-identity: an empty Group pushes nothing onto a render list.
  const list = makeRenderList();
  let pushed = 0;
  list.push = () => { pushed += 1; };
  scene.traverse((o) => { if (o.isMesh || o.isLight || o.isSprite) list.push(o); });
  check("empty Groups push nothing — the ballast cannot change the image",
    pushed === 0, `${pushed} pushes`);

  check("ballast(0) removes it", setFrameSplitBallast(0, { scene }).ballast === 0 &&
    frameSplitCensus(scene).resident.nodes === before);
}

// ---------------------------------------------------------------------------
console.log("PART 9 — disarm restores every seam, including the absent ones");
// ---------------------------------------------------------------------------
{
  const scene = new Scene();
  const renderer = makeRenderer(scene);
  const list = renderer.renderLists.get(scene);
  const origRender = renderer.render;
  const origRbd = renderer.renderBufferDirect;
  const origShadow = renderer.shadowMap.render;
  const origInit = list.init, origFinish = list.finish, origSort = list.sort;
  check("scene has no own onBeforeRender to begin with",
    !Object.prototype.hasOwnProperty.call(scene, "onBeforeRender"));

  armFrameSplit({ renderer, scene });
  check("armed: the seam is an own property",
    Object.prototype.hasOwnProperty.call(scene, "onBeforeRender"));
  renderer.render(scene);
  disarmFrameSplit();

  check("renderer.render restored", renderer.render === origRender);
  check("renderBufferDirect restored", renderer.renderBufferDirect === origRbd);
  check("shadowMap.render restored", renderer.shadowMap.render === origShadow);
  check("list.init/finish/sort restored",
    list.init === origInit && list.finish === origFinish && list.sort === origSort);
  // The one that is easy to get wrong: restoring by ASSIGNMENT here would leave
  // a permanent own no-op shadowing Object3D.prototype.onBeforeRender.
  check("scene.onBeforeRender own property DELETED, not reassigned",
    !Object.prototype.hasOwnProperty.call(scene, "onBeforeRender"));
  check("scene.onAfterRender own property DELETED, not reassigned",
    !Object.prototype.hasOwnProperty.call(scene, "onAfterRender"));
  check("the prototype no-op still resolves",
    typeof scene.onBeforeRender === "function" &&
      scene.onBeforeRender === Object3D.prototype.onBeforeRender);

  // A pre-existing own hook must be chained and given back untouched.
  const scene2 = new Scene();
  const mine = function () {};
  scene2.onBeforeRender = mine;
  const r2 = makeRenderer(scene2);
  let ran = 0;
  scene2.onBeforeRender = function (...a) { ran += 1; return mine.apply(this, a); };
  const chained = scene2.onBeforeRender;
  armFrameSplit({ renderer: r2, scene: scene2 });
  r2.render(scene2);
  disarmFrameSplit();
  check("a pre-existing own hook is chained, then restored",
    ran === 1 && scene2.onBeforeRender === chained, `ran=${ran}`);

  check("reset() zeroes the accumulators", (() => {
    armFrameSplit({ renderer, scene });
    renderer.render(scene);
    resetFrameSplit();
    renderer.render(scene);
    disarmFrameSplit();
    return frameSplitReport().calls === 1;
  })());
  check("re-arming while armed is refused, not silently ignored", (() => {
    armFrameSplit({ renderer, scene });
    const second = armFrameSplit({ renderer, scene });
    disarmFrameSplit();
    return typeof second.error === "string";
  })());
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

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
// 2026-08-06, part 2 — splitting the 3.42 ms `sceneSubmit − draws` block:
//
//   PART 10 — `sceneSubmit` SPLITS INTO ONCE-PER-CALL AND PER-OBJECT WORK, and
//             the split costs ZERO extra timestamps (its boundaries are the
//             first and last draw, which the rbd wrapper already stamps).
//             `setupLights` and the per-object glue were being quoted as one
//             number; a fix ranked off that number would be ranked off a
//             population it does not have.
//   PART 11 — THE ADOPT PASS SEES OWN-PROPERTY HOOKS. This is the tombstone
//             made executable: `static_batch_x.js` installs its memo hook as an
//             OWN property, which SHADOWS the prototype, so the original
//             `BatchedMesh.prototype` wrapper would have measured an empty
//             population and reported a confident ~0. The fixture reproduces
//             both shapes and asserts both are timed.
//   PART 12 — THE HOOK TOTAL REFUSES A MISMATCHED DENOMINATOR, and disarm hands
//             every borrowed slot back — including leaving alone the ones the
//             app has since reassigned, where writing our captured function
//             would overwrite live app code.
//   PART 13 — THE GLUE SAMPLER measures the same quantity a second, independent
//             way (hook-exit → draw-entry), and must come in at or below the
//             span arithmetic because it covers a strict subset of it.
//   PART 14 — THE DRAW BALLAST is submitted, drawn, and paints nothing. An
//             empty Group prices a VISIT and can say nothing about a SUBMITTED
//             object; that scale confusion is what this file exists to prevent.
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
  setFrameSplitDrawBallast,
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
      // `opts.objects` opts into the faithful renderObject path. Without it the
      // fixture keeps its original shape so the pre-existing parts measure
      // exactly what they measured before.
      const items = opts.objects
        ? opts.objects.map((o) => ({ object: o, transparent: false }))
        : null;
      if (items) for (const it of items) l.push(it);
      else for (let i = 0; i < (opts.submitted ?? 12); i++) l.push({ transparent: i % 3 === 0 });
      l.finish();
      if (r.sortObjects) l.sort();
      burn(0.05); // background.addToRenderList
      if (r.shadowMap) r.shadowMap.render(opts.shadowLights ?? [1, 2, 3], s, null);
      burn(opts.lightsMs ?? 0.3); // setupLights / setupLightsView
      if (items) {
        // The faithful `renderObjects` → `renderObject` shape, used by the
        // sceneSubmit sub-split tests. Order is three r184's, exactly:
        //   object.onBeforeRender → glue → renderBufferDirect → onAfterRender
        // The glue burn stands in for modelViewMatrix.multiplyMatrices +
        // normalMatrix.getNormalMatrix + material.onBeforeRender.
        for (let i = 0; i < items.length; i++) {
          const o = items[i].object;
          o.onBeforeRender(r, s, null, null, null, null);
          burn(opts.glueMs ?? 0.05);
          r.renderBufferDirect();
          o.onAfterRender(r, s, null, null, null, null);
        }
      } else {
        for (let i = 0; i < (opts.sceneDraws ?? 20); i++) {
          burn(0.02); // per-draw glue: modelViewMatrix, normalMatrix, layers.test
          r.renderBufferDirect();
        }
      }
      // The multisample resolve / mipmap / output.end, which three does BEFORE
      // scene.onAfterRender — so it belongs to `postDrawMs`, not to `tail`.
      burn(opts.resolveMs ?? 0);
      if (s.onAfterRender) s.onAfterRender(r, s, null);
      burn(0.1); // stack pops
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

// ---------------------------------------------------------------------------
console.log("PART 10 — sceneSubmit splits into once-per-call and per-object work");
// ---------------------------------------------------------------------------
{
  // 10 objects. Per object: 0.05 ms of glue then a 0.05 ms draw. Once per call:
  // 0.60 ms of lights setup before the first draw and 0.40 ms of resolve after
  // the last one. A probe that quotes `sceneSubmit − draws` alone reports
  // 0.60 + 0.45 + 0.40 = ~1.45 ms of "per-object glue" for a workload whose
  // per-object glue is 0.45 ms — a 3x overstatement, and the exact shape of the
  // 3.42 ms this half of the file exists to break apart.
  const scene = new Scene();
  const objects = [];
  for (let i = 0; i < 10; i++) objects.push(new Object3D());
  const renderer = makeRenderer(scene, {
    objects,
    glueMs: 0.05,
    drawMs: 0.05,
    lightsMs: 0.6,
    resolveMs: 0.4,
    shadowDraws: 0,
    shadowTraverseMs: 0.01,
  });
  armFrameSplit({ renderer, scene, objHooks: true });
  for (let i = 0; i < 6; i++) {
    renderer.shadowMap.needsUpdate = true;
    renderer.render(scene);
  }
  disarmFrameSplit();
  const rep = frameSplitReport();
  const sp = rep.sceneSplit.split;

  // preSubmit runs from the end of the shadow phase to the FIRST draw's entry,
  // so it is the 0.60 ms of lights plus the first object's 0.05 ms of glue.
  check("preSubmitMs ≈ the once-per-call lights work (0.65 ms)",
    near(sp.preSubmitMs, 0.65, 0.35), `${sp.preSubmitMs?.toFixed(2)} ms`);
  // drawLoop is first-entry → last-exit: 10 draws + the 9 glues between them.
  check("drawLoopMs ≈ 10 draws + 9 glues (0.95 ms)",
    near(sp.drawLoopMs, 0.95, 0.45), `${sp.drawLoopMs?.toFixed(2)} ms`);
  check("postDrawMs ≈ the resolve (0.40 ms)",
    near(sp.postDrawMs, 0.4, 0.3), `${sp.postDrawMs?.toFixed(2)} ms`);
  check("glueSpanMs = drawLoop − draws − hooks ≈ 9 glues (0.45 ms)",
    near(sp.glueSpanMs, 0.45, 0.35),
    `${sp.glueSpanMs?.toFixed(2)} ms (drawLoop ${sp.drawLoopMs?.toFixed(2)}, draws ${rep.sceneSplit.drawMs?.toFixed(2)})`);
  check("the sub-split's books close against sceneSubmit",
    sp.booksClosed === true,
    `residual ${sp.residualMs?.toFixed(3)} ms of ${rep.buckets.sceneSubmit?.toFixed(2)}`);
  check("glueAndLightsMs is no longer null once objHooks is armed",
    typeof rep.sceneSplit.glueAndLightsMs === "number",
    `${rep.sceneSplit.glueAndLightsMs?.toFixed(2)} ms`);
  check("and it is visibly LARGER than the per-object glue alone",
    rep.sceneSplit.glueAndLightsMs > sp.glueSpanMs,
    `glueAndLights ${rep.sceneSplit.glueAndLightsMs?.toFixed(2)} vs glueSpan ${sp.glueSpanMs?.toFixed(2)}`);
  check("per-submitted glue is quoted in µs against the SUBMITTED count",
    sp.glueSpanPerSubmittedUs > 0 && rep.submitted.perCall === 10,
    `${sp.glueSpanPerSubmittedUs?.toFixed(1)} µs × ${rep.submitted.perCall}`);
  check("the sub-split adds NO clock reads beyond the hook ones",
    // 14 per call + 2 per draw (10 scene draws) + 2 for the adopt scan. The
    // three sub-buckets contribute nothing: their stamps are the draw stamps.
    near(rep.health.probeClockReadsPerCall, 36, 1),
    `${rep.health.probeClockReadsPerCall?.toFixed(1)} reads/call`);
  check("the main books still close with the adopt scan inside listFinish",
    rep.health.booksClosed === true,
    `residual ${rep.health.residualMs?.toFixed(3)} ms`);
  check("the adopt scan is priced, not hidden",
    typeof rep.health.objHooks.scanMs === "number" && rep.health.objHooks.scans === rep.calls,
    `${rep.health.objHooks.scanMs?.toFixed(4)} ms/call over ${rep.health.objHooks.scans} scans`);
}
{
  // A call that draws nothing in the scene phase: the three sub-buckets have no
  // boundaries at all and must read null, not 0.00 ms.
  const scene = new Scene();
  const renderer = makeRenderer(scene, { objects: [], shadowDraws: 0 });
  armFrameSplit({ renderer, scene, objHooks: true });
  renderer.render(scene);
  renderer.render(scene);
  disarmFrameSplit();
  const sp = frameSplitReport().sceneSplit.split;
  check("no scene draw ⇒ preSubmit/drawLoop/postDraw all null, never 0",
    sp.preSubmitMs === null && sp.drawLoopMs === null && sp.postDrawMs === null,
    JSON.stringify({ pre: sp.preSubmitMs, loop: sp.drawLoopMs, post: sp.postDrawMs }));
  check("and glueSpan is null with them", sp.glueSpanMs === null);
}

// ---------------------------------------------------------------------------
console.log("PART 11 — the adopt pass sees OWN-property hooks a prototype misses");
// ---------------------------------------------------------------------------
{
  // THE TOMBSTONE, EXECUTABLE. `static_batch_x.js:_installMemo` does
  // `bm.onBeforeRender = _memoOnBeforeRender` — an OWN property that shadows the
  // prototype. `blood_decals.js` and `static_atlas.js` do the same. Wrapping
  // `BatchedMesh.prototype.onBeforeRender` would never run for any of them.
  class FakeBatched extends Object3D {
    onBeforeRender() {
      burn(0.10); // the multidraw rebuild
    }
  }
  const scene = new Scene();
  const protoHooked = [];
  const ownHooked = [];
  for (let i = 0; i < 3; i++) protoHooked.push(new FakeBatched());
  for (let i = 0; i < 3; i++) {
    const o = new FakeBatched();
    // The memo: an own property replacing the prototype's rebuild.
    o.onBeforeRender = function () { burn(0.10); };
    ownHooked.push(o);
  }
  const plain = [new Object3D(), new Object3D()];
  const objects = [...protoHooked, ...ownHooked, ...plain];
  scene.add(...objects);

  const cen = frameSplitCensus(scene);
  check("census separates OWN hooks from inherited overrides",
    cen.hooks.ownOnBeforeRender === 3 && cen.hooks.inheritedOverride === 3,
    `own=${cen.hooks.ownOnBeforeRender} inherited=${cen.hooks.inheritedOverride}`);
  check("census counts the stock no-ops, which are deliberately NOT wrapped",
    cen.hooks.defaultOnBeforeRender === 3, // 2 plain + the Scene root
    `${cen.hooks.defaultOnBeforeRender}`);
  check("the three identity is the scene's (else every compare is meaningless)",
    cen.hooks.identityCheckOk === true);
  check("byConstructor names what would be timed",
    cen.hooks.byConstructor.FakeBatched === 6,
    JSON.stringify(cen.hooks.byConstructor));

  const renderer = makeRenderer(scene, {
    objects, glueMs: 0.01, drawMs: 0.01, lightsMs: 0.05, shadowDraws: 0,
  });
  armFrameSplit({ renderer, scene, objHooks: true });
  for (let i = 0; i < 4; i++) renderer.render(scene);
  disarmFrameSplit();
  const rep = frameSplitReport();
  check("objHookMs is a number, not null",
    typeof rep.objHookMs === "number", `${rep.objHookMs}`);
  check("ALL SIX hooks are timed — the 3 own ones are not skipped",
    near(rep.sceneSplit.split.hookedPerCall, 6, 0.01),
    `${rep.sceneSplit.split.hookedPerCall} hooked/call`);
  check("objHookMs ≈ 6 × 0.10 ms",
    near(rep.objHookMs, 0.6, 0.35), `${rep.objHookMs?.toFixed(2)} ms`);
  check("per-hook cost is quoted against the hooked count, not all submitted",
    near(rep.sceneSplit.split.objHookPerHookedUs, 100, 60),
    `${rep.sceneSplit.split.objHookPerHookedUs?.toFixed(0)} µs`);
  // The counterfactual: had the probe wrapped only the prototype, it would have
  // seen 3 of 6 and reported half. That is the failure this asserts against.
  check("a prototype-only wrap would have seen HALF the population",
    cen.hooks.inheritedOverride * 2 === cen.hooks.inheritedOverride + cen.hooks.ownOnBeforeRender);
  // THE WINDOW EDGE. `drawLoopMs` opens at the FIRST draw, so the first
  // object's hook already fired — it is in `preSubmitMs`. Subtracting all six
  // hooks from a window containing five drives `glueSpanMs` negative, which is
  // how this bias announces itself when hooks are expensive; when they are
  // cheap it just quietly understates the glue.
  check("only the hooks INSIDE the loop window are subtracted (5 of 6)",
    near(rep.sceneSplit.split.objHookInLoopMs, rep.objHookMs * (5 / 6), 0.06),
    `inLoop ${rep.sceneSplit.split.objHookInLoopMs?.toFixed(3)} of total ${rep.objHookMs?.toFixed(3)}`);
  check("so glueSpan stays non-negative instead of eating a hook twice",
    rep.sceneSplit.split.glueSpanMs >= -0.02,
    `glueSpan ${rep.sceneSplit.split.glueSpanMs?.toFixed(3)} ms`);
}

// ---------------------------------------------------------------------------
console.log("PART 12 — the hook total refuses a mismatched denominator; disarm gives back");
// ---------------------------------------------------------------------------
{
  const scene = new Scene();
  const o1 = new Object3D();
  const mine = function () {};
  o1.onBeforeRender = mine; // an OWN hook that must come back byte-identical
  const o2 = new Object3D();
  Object.getPrototypeOf(o2).constructor; // (no own hook — must come back ABSENT)
  class Hooked extends Object3D { onBeforeRender() {} }
  const o3 = new Hooked();
  const objects = [o1, o2, o3];
  const renderer = makeRenderer(scene, { objects, drawMs: 0.01, glueMs: 0.01, shadowDraws: 0 });

  armFrameSplit({ renderer, scene, objHooks: true });
  renderer.render(scene);
  check("armed: the adopted slots are own properties",
    Object.prototype.hasOwnProperty.call(o1, "onBeforeRender") &&
      Object.prototype.hasOwnProperty.call(o3, "onBeforeRender"));
  check("a stock-no-op object is NOT wrapped (an empty call costs ~2 ns)",
    !Object.prototype.hasOwnProperty.call(o2, "onBeforeRender"));

  // The app swaps a hook out from under us — `_installMemo` does exactly this
  // when a new batch bucket is built. Our row is now stale.
  const appFn = function () {};
  o3.onBeforeRender = appFn;
  renderer.render(scene); // re-adopts the new function

  const d = disarmFrameSplit();
  check("o1's own hook is restored byte-identical",
    o1.onBeforeRender === mine, `${o1.onBeforeRender === mine}`);
  check("o3 ends up with the APP's function, not a captured stale one",
    o3.onBeforeRender === appFn);
  check("no own property is left on the object that never had one",
    !Object.prototype.hasOwnProperty.call(o2, "onBeforeRender"));
  check("the stale row is reported, not silently applied",
    d.objHooksReleased.stale >= 1,
    JSON.stringify(d.objHooksReleased));
}
{
  // A detached render list orphans the adopt pass. `objHookMs` must go null:
  // a hook sum over a subset of calls divided by all calls is a number that
  // looks right and is low by exactly the missing fraction.
  const scene = new Scene();
  class Hooked extends Object3D { onBeforeRender() { burn(0.02); } }
  const objects = [new Hooked(), new Hooked()];
  const renderer = makeRenderer(scene, { objects, drawMs: 0.01, shadowDraws: 0 });
  armFrameSplit({ renderer, scene, objHooks: true });
  renderer.render(scene);
  const orphan = makeRenderList();
  renderer.renderLists.get = () => orphan; // the finish patch is now orphaned
  renderer.render(scene);
  disarmFrameSplit();
  const rep = frameSplitReport();
  check("adoptScans falls behind calls when the list detaches",
    rep.health.objHooks.scans === 1 && rep.calls === 2,
    `${rep.health.objHooks.scans} scans / ${rep.calls} calls`);
  check("objHookMs goes NULL rather than averaging over the wrong denominator",
    rep.objHookMs === null && rep.health.objHooks.fullySampled === false);
  check("and every bucket derived from it goes null too",
    rep.sceneSplit.glueAndLightsMs === null && rep.sceneSplit.split.glueSpanMs === null);
}
{
  // Not armed for hooks at all: still null, and still says so.
  const scene = new Scene();
  const objects = [new Object3D()];
  const renderer = makeRenderer(scene, { objects, shadowDraws: 0 });
  armFrameSplit({ renderer, scene });
  renderer.render(scene);
  disarmFrameSplit();
  const rep = frameSplitReport();
  check("objHooks not armed ⇒ objHookMs null, health.objHooks null",
    rep.objHookMs === null && rep.health.objHooks === null);
  check("but preSubmit/drawLoop/postDraw still work — they need no hooks",
    typeof rep.sceneSplit.split.preSubmitMs === "number" &&
      typeof rep.sceneSplit.split.drawLoopMs === "number");
  check("glueSpan is null without the hook number, because it subtracts it",
    rep.sceneSplit.split.glueSpanMs === null);
}

// ---------------------------------------------------------------------------
console.log("PART 13 — the glue sampler measures the same thing a second way");
// ---------------------------------------------------------------------------
{
  const scene = new Scene();
  const objects = [];
  for (let i = 0; i < 8; i++) objects.push(new Object3D());
  const renderer = makeRenderer(scene, {
    objects, glueMs: 0.20, drawMs: 0.02, lightsMs: 0.05, shadowDraws: 0,
  });
  armFrameSplit({ renderer, scene, objHooks: true, glueSample: 4 });
  for (let i = 0; i < 5; i++) renderer.render(scene);
  disarmFrameSplit();
  const rep = frameSplitReport();
  const sp = rep.sceneSplit.split;
  check("k objects are borrowed, and only k",
    sp.glueSampleObjects === 4 && near(sp.glueSamplesPerCall, 4, 0.01),
    `${sp.glueSampleObjects} objects, ${sp.glueSamplesPerCall}/call`);
  check("the sampled glue ≈ the fixture's 0.20 ms per object",
    near(sp.glueSampleUs, 200, 100), `${sp.glueSampleUs?.toFixed(0)} µs`);
  // Against the PER-GAP figure, not per-submitted: `drawLoopMs` spans N draws
  // but only N−1 inter-draw gaps, so per-submitted is biased low by 1/N — 12.5%
  // at these 8 objects, 0.2% at the live 470. Comparing the sampler against the
  // biased figure is how a correct instrument gets called wrong.
  check("sample ≤ per-GAP span: it covers a strict SUBSET of one gap",
    sp.glueSampleUs <= sp.glueSpanPerGapUs * 1.15,
    `sample ${sp.glueSampleUs?.toFixed(0)} µs vs gap ${sp.glueSpanPerGapUs?.toFixed(0)} µs ` +
      `(per-submitted ${sp.glueSpanPerSubmittedUs?.toFixed(0)} µs is the biased one)`);
  check("the per-gap figure is the larger of the two, by exactly N/(N−1)",
    near(sp.glueSpanPerGapUs / sp.glueSpanPerSubmittedUs, 8 / 7, 0.01),
    `ratio ${(sp.glueSpanPerGapUs / sp.glueSpanPerSubmittedUs).toFixed(3)}`);
  check("borrowed slots are given back on disarm",
    objects.every((o) => !Object.prototype.hasOwnProperty.call(o, "onBeforeRender")));
}
{
  const scene = new Scene();
  const objects = [new Object3D(), new Object3D()];
  const renderer = makeRenderer(scene, { objects, shadowDraws: 0 });
  armFrameSplit({ renderer, scene, objHooks: true });
  renderer.render(scene);
  disarmFrameSplit();
  check("glueSampleUs is null when the sampler was not asked for",
    frameSplitReport().sceneSplit.split.glueSampleUs === null);
}

// ---------------------------------------------------------------------------
console.log("PART 14 — the draw ballast is submitted, drawn, and paints nothing");
// ---------------------------------------------------------------------------
{
  const scene = new Scene();
  const before = frameSplitCensus(scene).visited.meshes;
  const b = setFrameSplitDrawBallast(50, { scene });
  check("attaches exactly n meshes", b.drawBallast === 50, JSON.stringify(b));
  const cen = frameSplitCensus(scene);
  check("they are MESHES — the node ballast's Groups could never be submitted",
    cen.visited.meshes === before + 50, `${cen.visited.meshes}`);
  check("census reports the submitted-scale ballast separately from the node one",
    cen.ballast.drawNodes === 50 && cen.ballast.nodes === 0,
    JSON.stringify(cen.ballast));

  const root = scene.children.find((c) => c.name === "__frameSplitDrawBallast");
  const meshes = root.children;
  check("frustumCulled is off, so three submits them at ANY camera",
    meshes.every((m) => m.frustumCulled === false));
  check("they cast no shadow — the shadow walk must stay a clean baseline",
    meshes.every((m) => m.castShadow === false));
  check("one shared geometry and one shared material across all n",
    meshes.every((m) => m.geometry === meshes[0].geometry && m.material === meshes[0].material));
  // Image-identity: three identical vertices ⇒ zero area ⇒ no fragments.
  const pos = meshes[0].geometry.attributes.position;
  const degenerate =
    pos.count === 3 &&
    Array.from(pos.array).every((v) => v === 0);
  check("the triangle is degenerate — zero area, so it can paint no pixel",
    degenerate, `count=${pos.count}`);

  const b2 = setFrameSplitDrawBallast(10, { scene });
  check("re-setting REPLACES rather than accumulates",
    b2.drawBallast === 10 && frameSplitCensus(scene).visited.meshes === before + 10,
    `${frameSplitCensus(scene).visited.meshes}`);
  check("draw ballast(0) removes it",
    setFrameSplitDrawBallast(0, { scene }).drawBallast === 0 &&
      frameSplitCensus(scene).visited.meshes === before);
  check("the two ballasts are independent instruments",
    setFrameSplitBallast(20, { scene }).ballast === 20 &&
      frameSplitCensus(scene).ballast.drawNodes === 0);
  setFrameSplitBallast(0, { scene });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

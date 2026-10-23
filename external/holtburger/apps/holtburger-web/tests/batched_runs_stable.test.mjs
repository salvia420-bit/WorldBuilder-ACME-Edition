// 2026-10-22 — ?batchedRunsStable (scene3d/batched_runs.js, handoff L1): the O(1)
// "canonical list unchanged since this texture's last draw" signal that lets a
// bucket on three's early-out skip batchedRuns' O(ranges) per-draw compare.
//
// What is pinned here, without a GPU, over real three r184 BatchedMeshes and the
// real ?bmIndirectPerCamera prototype patch (installed first, as index.js does):
//   * the premises: three's early-out condition text, the hook sitting outermost;
//   * the skip: settled early-out frames skip (any camera), a membership change
//     (setVisibleAt -> _visibilityChanged) re-derives;
//   * every hole the proof has to close, each re-derived correctly: a list write
//     with no onBeforeRender before the draw, an own-property override that
//     writes without the prototype, an own override that calls through, three's
//     second DoubleSide pass, per-object-culled and sorted buckets (never quiet),
//     the hook cut out of the chain by a later prototype restore;
//   * THE ROLLBACK CASE: ?bmIndirectPerCamera rolls a texture version back when
//     the ids match although optimize() moved the ranges — the version would lie,
//     the epoch does not;
//   * the cooperation API for own overrides, and the self-audit catching an owner
//     that under-reports (skip disabled for the session, list re-derived);
//   * flag default (OFF, exact-match opt-in), seams, direct prepareRunDraw.
//
// Run:
//   cd apps/holtburger-web/
//   node tests/batched_runs_stable.test.mjs

import * as THREE from "three";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  installBatchedRuns, uninstallBatchedRuns, installBatchedRunsStable, uninstallBatchedRunsStable,
  markBatchedRuns, markBatchedRunsOwnHook, reportBatchedRunsList, prepareRunDraw, RUN_MARKER,
  getBatchedRunsStats, batchedRunsStableEnabled,
  __setBatchedRunsChunksForTest, __setBatchedRunsStableOffForTest, __setStableAuditEveryForTest,
  __resetStableForTest, __stableRecForTest,
} from "../scene3d/batched_runs.js";
import {
  installBatchedIndirectPerCamera, uninstallBatchedIndirectPerCamera, getBatchedIndirectPerCameraStats,
} from "../scene3d/batched_indirect_per_camera.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

// --- flag + premises ------------------------------------------------------------------------
const THREE_OBR = THREE.BatchedMesh.prototype.onBeforeRender;
{
  check("flag: ?batchedRunsStable is OFF by default (node: no URL)", batchedRunsStableEnabled() === false);
  const src = readFileSync(new URL("../scene3d/batched_runs.js", import.meta.url), "utf8");
  check("flag: exact-match opt-in on/1/true/yes",
    /get\("batchedRunsStable"\)[\s\S]{0,120}return v === "on" \|\| v === "1" \|\| v === "true" \|\| v === "yes";/.test(src));
  check("install: the hook is installed by installBatchedRuns only with both flags", /if \(FLAG && FLAG_STABLE\) \{\s*try \{ installBatchedRunsStable\(THREE\)/.test(src));
  const require = createRequire(import.meta.url);
  const core = readFileSync(require.resolve("three").replace(/[^/\\]+$/, "") + "three.core.js", "utf8");
  check("premise: three's early-out is `!_visibilityChanged && !perObjectFrustumCulled && !sortObjects`",
    core.includes("if ( ! this._visibilityChanged && ! this.perObjectFrustumCulled && ! this.sortObjects ) {"));
  check("premise: onBeforeShadow routes through this.onBeforeRender (shadow draws are armed too)",
    core.includes("this.onBeforeRender( renderer, null, shadowCamera, geometry, depthMaterial );"));
}

// --- harness ---------------------------------------------------------------------------------
function makeExt() {
  const calls = [];
  return {
    calls,
    multiDrawElementsWEBGL(mode, counts, co, type, offsets, oo, drawCount) {
      calls.push({ kind: "elems", n: drawCount, counts: [...counts].slice(co, co + drawCount), offsets: [...offsets].slice(oo, oo + drawCount) });
    },
    multiDrawElementsInstancedWEBGL(mode, counts, co, type, offsets, oo, inst, io, drawCount) {
      calls.push({ kind: "inst", n: drawCount, counts: [...counts].slice(co, co + drawCount), offsets: [...offsets].slice(oo, oo + drawCount), inst: [...inst].slice(io, io + drawCount) });
    },
  };
}
function makeRenderer(ext) {
  const seenTex = [];
  return {
    info: { render: { frame: 0 } },
    extensions: { has: (n) => n === "WEBGL_multi_draw" && !!ext, get: () => ext },
    seenTex,
    renderBufferDirect(camera, scene, geometry, material, object) {
      seenTex.push(object._indirectTexture);
      if (object.isBatchedMesh && object._multiDrawCount > 0) {
        this.extensions.get("WEBGL_multi_draw").multiDrawElementsWEBGL(4, object._multiDrawCounts, 0, 5125, object._multiDrawStarts, 0, object._multiDrawCount);
      }
    },
  };
}
function tri(off) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([off, 0, 0, off + 1, 0, 0, off, 1, 0]), 3));
  g.setIndex([0, 1, 2]);
  return g;
}
function camAt(x, z) {
  const c = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  c.position.set(x, 0, z); c.lookAt(0, 0, 0); c.updateMatrixWorld(true);
  c.matrixWorldInverse.copy(c.matrixWorld).invert();
  return c;
}
const camA = camAt(0, 50), camB = camAt(3, 45);
/** Unsorted bucket; `pofc` false puts it on three's early-out (handoff P2 / pools). */
function makeBucket(placements, { pofc = false, sorted = false, padGeom = false } = {}) {
  const bm = new THREE.BatchedMesh(64, 64, 64, new THREE.MeshBasicMaterial({ transparent: sorted }));
  const gX = padGeom ? bm.addGeometry(tri(9)) : -1; // no instances: deleted later to move ranges
  const gA = bm.addGeometry(tri(0)), gB = bm.addGeometry(tri(5));
  const m = new THREE.Matrix4();
  for (const [g, x, z = 0] of placements) {
    const id = bm.addInstance(g === "A" ? gA : gB);
    bm.setMatrixAt(id, m.makeTranslation(x, 0, z));
  }
  bm.sortObjects = sorted;
  bm.perObjectFrustumCulled = pofc;
  bm.updateMatrixWorld(true);
  markBatchedRuns(bm);
  return { bm, gX, gA, gB };
}
function emulatePairs(tex, call) {
  const d = tex.image.data;
  if (d[0] !== RUN_MARKER) return null;
  const out = [];
  for (let q = 0; q < call.n; q++) for (let i = 0; i < call.inst[q]; i++) out.push(`${call.offsets[q]}:${call.counts[q]}:${d[d[1 + q] + i]}`);
  return out.sort();
}
const canonPairs = (bm) => {
  const o = [], d = bm._indirectTexture.image.data;
  for (let k = 0; k < bm._multiDrawCount; k++) o.push(`${bm._multiDrawStarts[k]}:${bm._multiDrawCounts[k]}:${d[k]}`);
  return o.sort();
};

// As in index.js: ?bmIndirectPerCamera's prototype patch first, batchedRuns (and so
// the stable hook) after it.
installBatchedIndirectPerCamera(THREE, { force: true });
const PC_OBR = THREE.BatchedMesh.prototype.onBeforeRender;
check("setup: ?bmIndirectPerCamera patched the prototype", PC_OBR !== THREE_OBR);
check("install: installBatchedRunsStable(force) goes live", installBatchedRunsStable(THREE, { force: true }) === true);
const HOOK = THREE.BatchedMesh.prototype.onBeforeRender;
check("install: the hook is OUTERMOST (wraps the per-camera patch)", HOOK !== PC_OBR);
check("install: idempotent while on top", installBatchedRunsStable(THREE, { force: true }) === true && THREE.BatchedMesh.prototype.onBeforeRender === HOOK);
__setBatchedRunsChunksForTest(true);
const ext = makeExt();
const r = makeRenderer(ext);
installBatchedRuns(r);
const obr = (bm, c = camA) => bm.onBeforeRender(r, null, c, bm.geometry, bm.material, null);
const rbd = (bm, c = camA) => { r.renderBufferDirect(c, null, bm.geometry, bm.material, bm, null); return ext.calls.at(-1); };
const draw = (bm, c = camA) => { obr(bm, c); return rbd(bm, c); };
const S = () => getBatchedRunsStats();

// --- the skip on an early-out bucket ------------------------------------------------------
{
  const { bm } = makeBucket([["A", 0], ["B", 2], ["A", 4], ["A", -4], ["B", -2]]);
  const s0 = S();
  const c1 = draw(bm);
  const runTex = r.seenTex.at(-1);
  check("first draw: runs 3 + 2, derived (rebuild +1), no skip", c1.kind === "inst" && c1.inst.join() === "3,2"
    && S().rebuilds === s0.rebuilds + 1 && S().stableSkips === s0.stableSkips, JSON.stringify(c1));
  const s1 = S();
  const v1 = runTex.version;
  const c2 = draw(bm);
  check("settled draw (three's early-out): the compare is SKIPPED, same runs, same texture, no upload",
    S().stableSkips === s1.stableSkips + 1 && c2.inst.join() === "3,2" && r.seenTex.at(-1) === runTex && runTex.version === v1 && S().rebuilds === s1.rebuilds);
  const pc0 = getBatchedIndirectPerCameraStats();
  const c3 = draw(bm, camB);
  check("another camera: still skipped (the early-out list is camera-independent; per-camera passes through)",
    S().stableSkips === s1.stableSkips + 2 && c3.inst.join() === "3,2" && getBatchedIndirectPerCameraStats().passthrough === pc0.passthrough + 1);
  check("the run texture still holds three's pairs", JSON.stringify(emulatePairs(runTex, c3)) === JSON.stringify(canonPairs(bm)));

  // Membership change: three's rebuild runs (not quiet) -> epoch bump -> compare -> re-derive.
  bm.setVisibleAt(1, false);
  const s2 = S();
  const c4 = draw(bm);
  check("setVisibleAt: not quiet -> no skip, re-derived to 3 + 1", c4.inst.join() === "3,1" && S().stableSkips === s2.stableSkips && S().rebuilds === s2.rebuilds + 1);
  draw(bm);
  check("…and the next settled draw skips again", S().stableSkips === s2.stableSkips + 1);

  // A write with NO onBeforeRender before the draw (an unknown writer): unarmed -> poisoned.
  const d = bm._indirectTexture.image.data;
  const nl = bm._multiDrawCount;
  const before = canonPairs(bm).join();
  const t = d[0]; d[0] = d[nl - 1]; d[nl - 1] = t; // an A id <-> the B id: the (range, id) pairs change
  const s3 = S();
  const c5 = rbd(bm);
  check("unarmed draw: poisoned, compared, the swapped ids are what the runs read",
    canonPairs(bm).join() !== before
      && S().stablePoisons === s3.stablePoisons + 1 && S().stableSkips === s3.stableSkips
      && JSON.stringify(emulatePairs(r.seenTex.at(-1), c5)) === JSON.stringify(canonPairs(bm)));
  bm._visibilityChanged = true; // let three rebuild the canonical list
  draw(bm); draw(bm);

  // Three's second DoubleSide pass: two draws, one onBeforeRender — the second is poisoned.
  obr(bm);
  const s4 = S();
  rbd(bm); rbd(bm);
  check("two-pass: the first draw skips, the second (no onBeforeRender in between) compares",
    S().stableSkips === s4.stableSkips + 1 && S().stablePoisons === s4.stablePoisons + 1 && S().rebuilds === s4.rebuilds);

  // Live seam off -> full compare every draw (still correct, nothing re-derived).
  __setBatchedRunsStableOffForTest(true);
  const s5 = S();
  draw(bm); draw(bm);
  check("seam: __batchedRuns.stableOff -> no skips, compare hits (no rebuild)", S().stableSkips === s5.stableSkips && S().rebuilds === s5.rebuilds);
  __setBatchedRunsStableOffForTest(false);

  // A direct prepareRunDraw (no arm proof) never skips and clears the stamp.
  const s6 = S();
  prepareRunDraw(bm);
  check("direct prepareRunDraw: never skips", S().stableSkips === s6.stableSkips);
  draw(bm);
  check("…and the next wrapped draw re-verifies before it may skip", S().stableSkips === s6.stableSkips);
  draw(bm);
  check("…then skips", S().stableSkips === s6.stableSkips + 1);
}

// --- own-property overrides --------------------------------------------------------------
{
  const { bm } = makeBucket([["A", 0], ["A", 2], ["B", 4], ["A", -4]]);
  draw(bm); draw(bm);
  // A memo-like override: writes the list itself, never reaches the prototype.
  bm.onBeforeRender = function () {
    const d = this._indirectTexture.image.data;
    const t = d[0]; d[0] = d[2]; d[2] = t; // swap an A id with the B id: ranges now disagree with ids
  };
  const s0 = S();
  const c1 = draw(bm);
  check("own override that writes: poisoned (own property), compared, the runs read the written ids",
    S().stableSkips === s0.stableSkips && S().stablePoisons > s0.stablePoisons
      && JSON.stringify(emulatePairs(r.seenTex.at(-1), c1)) === JSON.stringify(canonPairs(bm)));
  // An adopt-style wrapper that calls the prototype: still own -> never skips.
  bm.onBeforeRender = function (...a) { return HOOK.apply(this, a); };
  const s1 = S();
  draw(bm); draw(bm);
  check("own override that calls through: conservative, no skip", S().stableSkips === s1.stableSkips);
  delete bm.onBeforeRender;
  bm._visibilityChanged = true;
  draw(bm);
  const s2 = S();
  draw(bm);
  check("override removed: the prototype path skips again", S().stableSkips === s2.stableSkips + 1);
}

// --- per-object culled and sorted buckets are never quiet --------------------------------
{
  const { bm } = makeBucket([["A", 0], ["B", 2], ["A", 4]], { pofc: true });
  const s0 = S();
  draw(bm); draw(bm); draw(bm);
  check("perObjectFrustumCulled: no early-out -> no skip; the compare hits (one derive)",
    S().stableSkips === s0.stableSkips && S().rebuilds === s0.rebuilds + 1);
  const so = makeBucket([["A", 0, 0], ["A", 1, 0], ["B", 0, 1]], { sorted: true });
  const s1 = S();
  draw(so.bm); draw(so.bm);
  check("sorted: never quiet -> no skip (consecutive runs still drawn)", S().stableSkips === s1.stableSkips && ext.calls.at(-1).kind === "inst");
}

// --- THE ROLLBACK CASE ----------------------------------------------------------------------
{
  // Per-object culled (so ?bmIndirectPerCamera owns a texture per camera and may
  // roll a version back). optimize() moves gA/gB's ranges; the ids stay the same.
  const { bm, gX, gA, gB } = makeBucket([["A", 0], ["B", 2], ["A", 4], ["A", -4], ["B", -2]], { pofc: true, padGeom: true });
  const cPre = (draw(bm, camA), draw(bm, camB), draw(bm, camA));
  const bpe = bm.geometry.getIndex().array.BYTES_PER_ELEMENT;
  const startA0 = bm._geometryInfo[gA].start;
  const preOffsets = cPre.offsets.join();
  bm.deleteGeometry(gX);
  bm.optimize();
  check("rollback setup: optimize() moved gA's range", bm._geometryInfo[gA].start !== startA0, `${startA0} -> ${bm._geometryInfo[gA].start}`);
  const pc0 = getBatchedIndirectPerCameraStats();
  const canonA = bm._indirectTexture; // camA's texture is installed (it drew last)
  const verA = canonA.version;
  obr(bm, camA);
  const pc1 = getBatchedIndirectPerCameraStats();
  check("rollback: the ids matched, so ?bmIndirectPerCamera rolled the version back — a version check would call this list unchanged",
    pc1.skipped === pc0.skipped + 1 && bm._indirectTexture.version === verA);
  const s0 = S();
  const c = rbd(bm, camA);
  const moved = [bm._geometryInfo[gA].start * bpe, bm._geometryInfo[gB].start * bpe].join();
  check("rollback: the epoch saw the rebuild — no skip, re-derived, the issued offsets are the MOVED ranges",
    S().stableSkips === s0.stableSkips && S().rebuilds === s0.rebuilds + 1
      && c.kind === "inst" && c.offsets.join() === moved && moved !== preOffsets
      && JSON.stringify(emulatePairs(r.seenTex.at(-1), c)) === JSON.stringify(canonPairs(bm)), `${preOffsets} -> ${c.offsets.join()} (want ${moved})`);
  // The same move on an EARLY-OUT bucket: optimize() sets _visibilityChanged, so the
  // call is not quiet either.
  const eo = makeBucket([["A", 0], ["B", 2], ["A", 4]], { padGeom: true });
  draw(eo.bm); draw(eo.bm);
  eo.bm.deleteGeometry(eo.gX); eo.bm.optimize();
  const s1 = S();
  const c2 = draw(eo.bm);
  check("early-out + optimize(): not quiet -> re-derived with the moved ranges",
    S().stableSkips === s1.stableSkips && S().rebuilds === s1.rebuilds + 1
      && JSON.stringify(emulatePairs(r.seenTex.at(-1), c2)) === JSON.stringify(canonPairs(eo.bm)));
}

// --- cooperation API + the self-audit -------------------------------------------------------
{
  const { bm } = makeBucket([["A", 0], ["A", 2], ["B", 4], ["A", -4], ["B", 6]]);
  markBatchedRunsOwnHook(bm);
  let mode = "hit";
  bm.onBeforeRender = function (...a) {
    if (mode === "rebuild") { this._visibilityChanged = true; HOOK.apply(this, a); reportBatchedRunsList(this, true); return; }
    if (mode === "write-honest" || mode === "write-lie") {
      const d = this._indirectTexture.image.data;
      const t = d[0]; d[0] = d[2]; d[2] = t;
      reportBatchedRunsList(this, mode === "write-lie" ? false : true);
      return;
    }
    reportBatchedRunsList(this, false); // a hit that touched nothing
  };
  mode = "rebuild"; draw(bm);
  mode = "hit";
  const s0 = S();
  draw(bm);
  check("coop: an own override that reports a no-write call -> skip", S().stableSkips === s0.stableSkips + 1);
  mode = "write-honest";
  const s1 = S();
  const c1 = draw(bm);
  check("coop: a reported write -> no skip, the runs read the new ids",
    S().stableSkips === s1.stableSkips && JSON.stringify(emulatePairs(r.seenTex.at(-1), c1)) === JSON.stringify(canonPairs(bm)));
  mode = "hit"; draw(bm);
  // An owner that LIES (writes, reports no write): the audit (every skip here) catches it.
  __setStableAuditEveryForTest(1);
  mode = "write-lie";
  const s2 = S();
  const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
  const c2 = draw(bm);
  console.warn = warn;
  const s3 = S();
  check("audit: an under-reported write is caught (auditFail +1, warned once), the list is re-derived",
    s3.stableAudits === s2.stableAudits + 1 && s3.stableAuditFails === s2.stableAuditFails + 1 && warned === 1
      && s3.stableBroken === true && JSON.stringify(emulatePairs(r.seenTex.at(-1), c2)) === JSON.stringify(canonPairs(bm)));
  mode = "hit";
  draw(bm); draw(bm);
  check("audit: after a failure the skip is off for the session", S().stableSkips === s3.stableSkips);
  check("audit: an own hook mark sticks on the record", __stableRecForTest(bm).ownHook === true);
  __resetStableForTest();
  draw(bm);
  check("reset (test seam): skips resume", S().stableSkips === s3.stableSkips + 1);
  delete bm.onBeforeRender;
}

// --- the hook cut out of the chain ------------------------------------------------------------
{
  const { bm } = makeBucket([["A", 0], ["A", 2], ["B", 4]]);
  draw(bm); draw(bm);
  // ?bmIndirectPerCamera's uninstall restores the prototype to three's own method,
  // dropping our hook with it: nothing arms any more.
  uninstallBatchedIndirectPerCamera(THREE);
  check("unhook: the prototype is three's own method again", THREE.BatchedMesh.prototype.onBeforeRender === THREE_OBR);
  const s0 = S();
  draw(bm); draw(bm); draw(bm);
  check("unhook: every draw is unarmed -> poisoned, never skipped, still drawn as runs",
    S().stableSkips === s0.stableSkips && S().stablePoisons === s0.stablePoisons + 3 && ext.calls.at(-1).kind === "inst");
  check("re-install: wraps the current chain again", installBatchedRunsStable(THREE, { force: true }) === true
    && THREE.BatchedMesh.prototype.onBeforeRender !== THREE_OBR);
  draw(bm);
  const s1 = S();
  draw(bm);
  check("re-install: skips again", S().stableSkips === s1.stableSkips + 1);
  uninstallBatchedRunsStable();
  check("uninstall: three's method restored", THREE.BatchedMesh.prototype.onBeforeRender === THREE_OBR);
  const s2 = S();
  draw(bm); draw(bm);
  check("uninstall: no observation, no skips", S().stableSkips === s2.stableSkips);
}

uninstallBatchedRuns(r);
__setBatchedRunsChunksForTest(false);

console.log(`\nbatched_runs_stable: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

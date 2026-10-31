// tests/interior_batch_contract.test.mjs — R3-5 `?interiorBatch` source
// contract (scene3d/cells.js hooks, scene3d/gpu_batch/interior_batch.js;
// design §3.1, proof §6.1).
//
//   C1  every `container.visible =` write inside tickCellVisibility3D is
//       followed (after its if-block, not inside it) by an IB_ON-guarded
//       `ibNoteVisible(container, <the same value>)`; there are exactly
//       three writes and three notes; the one sync call sits after the
//       shadow-raster request and before the __diag.pvs hook.
//   C2  the one build hook sits right after the success `envCellLoadedLbs.add`
//       (after the walls-first stage 2, outside every cancel closure), not
//       after the empty-landblock one, and is IB_ON-guarded.
//   C3  cells.js imports interior_batch.js on ONE line (the statics.js:80
//       line-strip rule) and reads the flag once into IB_ON; every call into
//       the module is behind it.
//   C4  no runtime writer of the chain uniforms the class materials copy as
//       constants (`uAcBakedGain`, `uAcBakedSuppressDirect`,
//       `uLightColorClamp`): outside their install in materials.js nothing
//       assigns them (design risk 12) — when one appears, the batch must
//       follow it (or refuse the chain), and this test says so.
//   C5  interior_batch.js, EXECUTED: importing it creates no state (the
//       module state, the landblock records, the diag and the census are all
//       empty), installs no global, no window listener and no LRU hook; the
//       cells.js entry points called with no armed state create none either;
//       no top-level Map / Set / WeakMap / typed array / THREE object in the
//       source; no backtick inside a GLSL string.
//   C6  none of the R3-5 suites is a PURE-PIN suite (harness/
//       test_suite_hygiene.mjs classifySuite: every one executes app code),
//       so the shrink-only source-pin ratchet stays green.
//   C7  (realboot 2026-10-31, the draw pools) the pooled / legacy split hook:
//       right after each of buildEnvCellsForLandblock's two pool offers
//       (fused and ?envcellFusion=off), an IB_ON-guarded
//       `ibNotePooled(cellContainer, <the offered entries>, <the offer's
//       flags>)`, exactly two; executed, it stamps the offer verdict
//       non-enumerably and creates no module state; interior_batch.js no
//       longer disarms on envCellPoolsActive().
//
// Run: node tests/interior_batch_contract.test.mjs

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The module under contract, imported for real before anything else touches
// it (C5 reads its import-time state).
const windowListeners = [];
globalThis.window ??= {};
const winAdd = globalThis.window.addEventListener;
globalThis.window.addEventListener = (...a) => { windowListeners.push(a[0]); if (typeof winAdd === "function") winAdd.apply(globalThis.window, a); };
const windowKeysBefore = Object.keys(globalThis.window);
const IB = await import("../scene3d/gpu_batch/interior_batch.js");
const { classifySuite } = await import("../harness/test_suite_hygiene.mjs");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const CELLS = readFileSync(path.join(APP, "scene3d/cells.js"), "utf8");
const IBSRC = readFileSync(path.join(APP, "scene3d/gpu_batch/interior_batch.js"), "utf8");

let failures = 0;
let passes = 0;
function t(name, fn) {
  try { fn(); passes++; console.log("  ok ", name); } catch (e) { failures++; console.log("  FAIL", name); console.log(e); }
}

function fnBody(src, header) {
  const a = src.indexOf(header);
  assert.ok(a >= 0, `missing ${header}`);
  const b = src.indexOf("\n}\n", a);
  return src.slice(a, b + 2);
}

t("C1 tickCellVisibility3D: three visible writes, each followed by its note; one sync at the end", () => {
  const body = fnBody(CELLS, "export function tickCellVisibility3D(");
  const lines = body.split("\n");
  const writes = [];
  lines.forEach((l, i) => { const m = /container\.visible = (want|true|false);/.exec(l); if (m) writes.push([i, m[1]]); });
  assert.equal(writes.length, 3, "three writes");
  for (const [i, v] of writes) {
    assert.match(lines[i + 1], /^\s+\}\s*$/, "the write's if-block closes on the next line");
    const note = lines[i + 2];
    const re = new RegExp(`^\\s+if \\(IB_ON(?: && container)?\\) ibNoteVisible\\(container, ${v}\\);\\s*$`);
    assert.match(note, re, `note after the block for the ${v} write: ${note}`);
  }
  assert.equal((body.match(/ibNoteVisible\(/g) || []).length, 3, "three notes, no other");
  const sync = body.indexOf("if (IB_ON) syncInteriorBatches(scene3d, isIndoor, castOn);");
  assert.ok(sync > 0, "the sync");
  assert.equal((body.match(/syncInteriorBatches\(/g) || []).length, 1);
  assert.ok(sync > body.indexOf("if (castChanged) requestShadowRaster(scene3d.renderer, scene3d);"), "after the raster request");
  assert.ok(sync < body.indexOf("window.__diag?.pvs?.onCellTick"), "before the diag hook");
  assert.ok(sync > body.lastIndexOf("container.visible = false;"), "after every write");
});

t("C2 the build hook: right after the success envCellLoadedLbs.add, outside every cancel path", () => {
  const body = fnBody(CELLS, "export async function buildEnvCellsForLandblock(");
  assert.equal((body.match(/noteInteriorBatchBuilt\(/g) || []).length, 1, "one call");
  const call = body.indexOf("if (IB_ON) noteInteriorBatchBuilt(scene3d, lbKey, buildGen, newCells);");
  assert.ok(call > 0);
  const adds = [];
  let k = -1;
  while ((k = body.indexOf("scene3d.envCellLoadedLbs.add(lbKey);", k + 1)) !== -1) adds.push(k);
  assert.equal(adds.length, 2, "premise: the empty-LB add and the success add");
  const success = adds[1];
  assert.ok(call > success && body.slice(success, call).split("\n").length <= 6, "right after the success add");
  assert.ok(call > body.indexOf("`?interiorWallsFirst` stage 2"), "after the walls-first stage 2");
  const cancelled = body.indexOf("const cancelled = () => {");
  const cancelEnd = body.indexOf("};", cancelled);
  assert.ok(!(call > cancelled && call < cancelEnd), "not in the cancel closure");
  assert.ok(call > body.indexOf("evictedDuringBuild: true,"), "after the mid-build eviction bail-out");
});

t("C3 one-line import, one flag read, every call guarded", () => {
  const imp = CELLS.match(/^import \{[^\n}]*\} from "\.\/gpu_batch\/interior_batch\.js";$/m);
  assert.ok(imp, "single-line import");
  assert.match(CELLS, /^const IB_MODE = interiorBatchMode\(\);$/m);
  assert.match(CELLS, /^const IB_ON = IB_MODE !== "off";$/m);
  for (const fn of ["noteInteriorBatchBuilt", "ibNoteVisible", "syncInteriorBatches", "ibNotePooled"]) {
    const re = new RegExp(`^.*${fn}\\(.*$`, "gm");
    const uses = (CELLS.match(re) || []).filter((l) => !l.startsWith("import "));
    assert.ok(uses.length > 0, fn);
    for (const l of uses) assert.match(l, /if \(IB_ON[ )&]/, `guarded: ${l.trim()}`);
  }
  assert.equal((CELLS.match(/interiorBatchMode\(/g) || []).length, 1, "the flag is read once");
});

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === "assets" || n.startsWith(".")) continue;
    const p = path.join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(m?js|html)$/.test(n)) out.push(p);
  }
  return out;
}

t("C4 no runtime writer of the constant chain uniforms (risk 12)", () => {
  const files = [...walk(path.join(APP, "scene3d")), ...walk(path.join(APP, "app")), path.join(APP, "index.html")];
  const re = /(uAcBakedGain|uAcBakedSuppressDirect|uLightColorClamp)\b[^\n=]*?(?<![=!<>])=(?!=)/g;
  const writers = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const line of src.split("\n")) {
      if (!/uAcBakedGain|uAcBakedSuppressDirect|uLightColorClamp/.test(line)) continue;
      if (/^\s*(\/\/|\*|")/.test(line.trim()) && !/=\s*\{\s*value/.test(line)) continue; // comments, GLSL text
      re.lastIndex = 0;
      if (!re.test(line)) continue;
      const rel = path.relative(APP, f);
      const install = rel === path.join("scene3d", "materials.js") && /shader\.uniforms\.(uAcBakedGain|uAcBakedSuppressDirect|uLightColorClamp) = \{ value:/.test(line);
      if (!install) writers.push(`${rel}: ${line.trim()}`);
    }
  }
  assert.deepEqual(writers, [], "a writer appeared: the interior batch copies these as compile-time constants into its class programs");
});

t("C5 interior_batch.js executed: no import-time state, global, listener or hook; no top-level state in the source; no backtick in GLSL", () => {
  assert.equal(IB.__interiorBatchStateForTest(), null, "no module state after import");
  assert.equal(IB.__interiorBatchLbsForTest(), null, "no landblock records");
  assert.equal(IB.interiorBatchDiag(), null, "no diag");
  assert.deepEqual(IB.interiorBatchPlan(), [], "no census");
  // (Its import graph — three, shader_prewarm, interior_shadow_cull, … —
  // stamps its own diag globals, as it does for cells.js flag-off.)
  assert.equal(globalThis.window.__interiorBatch, undefined, "no window.__interiorBatch");
  assert.deepEqual(Object.keys(globalThis.window).filter((k) => !windowKeysBefore.includes(k) && /interiorBatch|ibatch/i.test(k)), [], "no interior-batch global");
  assert.deepEqual(windowListeners, [], "no window listener");
  // The cells.js entry points with nothing armed: the per-frame calls return
  // at once and create nothing (cells.js never calls the build hook flag-off).
  const scene3d = {};
  const container = { userData: {}, visible: true };
  IB.ibNoteVisible(container, true);
  IB.syncInteriorBatches(scene3d, false, true);
  IB.ibNotePooled(container, [{ group: { surfaceDid: 7 } }], [false]);
  assert.equal(IB.__interiorBatchStateForTest(), null, "still no state");
  assert.deepEqual(Object.keys(scene3d), [], "no LRU hook installed");
  assert.deepEqual(Object.keys(container.userData), [], "no stamp");
  assert.equal(IB.interiorBatchMode(""), "off", "DEFAULT OFF");
  // Source: column-0 bindings may hold constant tables only.
  const top = IBSRC.split("\n").filter((l) => /^(const|let|var) /.test(l));
  for (const l of top) {
    assert.ok(!/new THREE\./.test(l), `import-time THREE object: ${l}`);
    assert.ok(!/new (Map|Set|WeakMap|WeakSet|(Float|Int|Uint)(8|16|32|64)(Clamped)?Array|ArrayBuffer)\(/.test(l), `import-time state: ${l}`);
  }
  for (const m of IBSRC.matchAll(/"([^"\n]*(?:hbIb|texelFetch|transformed|discard)[^"\n]*)"/g)) assert.ok(!m[1].includes("`"), m[1]);
});

t("C6 no R3-5 suite is a PURE-PIN suite (the source-pin ratchet stays green)", () => {
  const dir = path.join(APP, "tests");
  const suites = readdirSync(dir).filter((n) => /^interior_batch.*\.test\.mjs$/.test(n));
  assert.ok(suites.length >= 8, `premise: the suites (${suites.length})`);
  for (const n of suites) {
    const rel = `tests/${n}`;
    const c = classifySuite(readFileSync(path.join(dir, n), "utf8"), rel);
    assert.equal(c.pin, false, `${rel} is PURE-PIN (reads ${c.reads}, executes ${c.executes})`);
    assert.ok(c.executes, `${rel} executes app code`);
  }
});

t("C7 the pools split hook: one IB_ON-guarded ibNotePooled right after each pool offer; executed it stamps the verdict only; no draw-pools disarm", () => {
  const body = fnBody(CELLS, "export async function buildEnvCellsForLandblock(");
  assert.equal((body.match(/ibNotePooled\(/g) || []).length, 2, "two stamps");
  for (const [flags, entries] of [["pooledFlags", "resolvedGroups"], ["pooledUnfused", "resolvedUnfused"]]) {
    const offer = body.indexOf(`const ${flags} = envCellPools`);
    assert.ok(offer > 0, `the ${flags} offer`);
    const end = body.indexOf(": null;", offer);
    const after = body.slice(end, body.indexOf("\n", body.indexOf(`ibNotePooled(cellContainer, ${entries}, ${flags});`, end)) + 1);
    assert.ok(after.split("\n").length <= 4, `right after the ${flags} offer: ${after}`);
    assert.match(after, new RegExp(`if \\(IB_ON && ${flags}\\) ibNotePooled\\(cellContainer, ${entries}, ${flags}\\);`));
  }
  const c = { userData: { cellId: 1 }, visible: true };
  IB.ibNotePooled(c, [{ group: { surfaceDid: 0x08000201 } }, { group: { surfaceDid: 0x08000101 } }, { group: { surfaceDid: 0x08000202 } }], [true, false, true]);
  assert.deepEqual(c.userData.__ibPool, { offered: 3, pooled: 2, legacy: 1, dids: [0x08000201, 0x08000202] });
  assert.deepEqual(Object.keys(c.userData), ["cellId"], "non-enumerable");
  assert.equal(IB.__interiorBatchStateForTest(), null, "no module state");
  const dis = fnBody(IBSRC, "function _disarmReason(");
  assert.ok(!/envCellPoolsActive|draw-pools/.test(dis.replace(/\/\*[\s\S]*?\*\//g, "")), "the pools are not a disarm");
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);

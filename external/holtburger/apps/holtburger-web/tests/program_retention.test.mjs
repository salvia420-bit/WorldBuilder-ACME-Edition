// render-perf-1 (2026-10-13) — scene3d/program_retention.js: hold one extra
// reference on every WebGLProgram so three's releaseProgram never destroys it
// and the next material with that key is a program-cache hit, not a relink.
// After WebAC packages/renderer/src/scene/ProgramRetention.ts (AGPL-3.0).
//
// A fake renderer whose info.programs is driven by a model of three r184's
// WebGLPrograms (acquireProgram: map hit → ++usedTimes, else push;
// releaseProgram: --usedTimes === 0 → swap-remove + map delete). The model's
// fidelity is pinned against the vendored three.module.js source below.
// Run:
//   cd apps/holtburger-web/
//   node tests/program_retention.test.mjs

import { readFileSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

globalThis.window = globalThis;
globalThis.location = { search: "" };

const PR = await import("../scene3d/program_retention.js");
const {
  createProgramRetention,
  programRetainEnabled,
  retainNewPrograms,
  getProgramRetention,
  isStageKeyed,
  stagePairOf,
  PROGRAM_RETAIN_CAP,
  PROGRAM_RETAIN_SWEEP_EVERY,
} = PR;

// three r184 WebGLPrograms, reduced to the refcount + the programs array.
function fakeThree() {
  const map = new Map();
  let nextId = 0;
  const renderer = { info: { programs: [] } };
  const acquire = (cacheKey, type = "MeshStandardMaterial", name = "") => {
    let p = map.get(cacheKey);
    if (p !== undefined) { p.usedTimes += 1; return p; }
    p = { id: nextId++, cacheKey, type, name, usedTimes: 1, destroyed: false };
    renderer.info.programs.push(p);
    map.set(cacheKey, p);
    return p;
  };
  const release = (p) => {
    p.usedTimes -= 1;
    if (p.usedTimes === 0) {
      const progs = renderer.info.programs;
      const i = progs.indexOf(p);
      progs[i] = progs[progs.length - 1];
      progs.pop();
      map.delete(p.cacheKey);
      p.destroyed = true;
    }
  };
  // initGLContext on context restore: a NEW WebGLPrograms, so a new array + map.
  const restore = () => { renderer.info.programs = []; map.clear(); };
  return { renderer, acquire, release, restore, map, created: () => nextId };
}

// ── 0. flag + key helpers ─────────────────────────────────────────────────
{
  check("absent flag → ON", programRetainEnabled("") === true);
  check("?programRetain=off → OFF", programRetainEnabled("?programRetain=off") === false);
  check("?programRetain=0 → OFF", programRetainEnabled("?programRetain=0") === false);
  check("?programRetain=false → OFF", programRetainEnabled("?a=1&programRetain=false") === false);
  check("?programRetain=on → ON", programRetainEnabled("?programRetain=on") === true);
  check("cap is ~1024", PROGRAM_RETAIN_CAP === 1024);
  check("sweep cadence is a positive integer", Number.isInteger(PROGRAM_RETAIN_SWEEP_EVERY) && PROGRAM_RETAIN_SWEEP_EVERY > 0);
  check("built-in key is not stage-keyed", isStageKeyed({ type: "MeshStandardMaterial", cacheKey: "physical,1,2,hb|x" }) === false);
  check("depth key is not stage-keyed", isStageKeyed({ type: "MeshDepthMaterial", cacheKey: "depth,highp,3201" }) === false);
  check("ShaderMaterial type is stage-keyed", isStageKeyed({ type: "ShaderMaterial", cacheKey: "12,13,x" }) === true);
  check("RawShaderMaterial type is stage-keyed", isStageKeyed({ type: "RawShaderMaterial", cacheKey: "4,5," }) === true);
  check("custom-type subclass with numeric head is stage-keyed", isStageKeyed({ type: "LineMaterial", cacheKey: "7,8,USE_DASH" }) === true);
  check("stagePairOf reads the vs,fs head", stagePairOf("12,13,FOO,1,hb") === "12,13");
  check("stagePairOf of a 2-field key", stagePairOf("12,13") === "12,13");
  check("stagePairOf of a built-in key is null", stagePairOf("physical,1,2") === null);
}

// ── 1. each built-in program bumped exactly once; repeat calls are no-ops ──
{
  const t = fakeThree();
  const pr = createProgramRetention({ enabled: true, sweepEvery: 3 });
  const a = t.acquire("physical,A");
  const b = t.acquire("depth,B", "MeshDepthMaterial");
  check("first call retains both", pr.retainNew(t.renderer) === 2);
  check("usedTimes bumped to 2", a.usedTimes === 2 && b.usedTimes === 2);
  for (let i = 0; i < 10; i++) pr.retainNew(t.renderer); // crosses several sweeps
  check("repeat calls (incl. periodic sweeps) never bump again", a.usedTimes === 2 && b.usedTimes === 2);
  check("stats.retained = 2", pr.stats.retained === 2);
  check("periodic sweeps ran", pr.stats.scans >= 3, String(pr.stats.scans));
  const c = t.acquire("physical,C");
  check("a new program is retained on the next call", pr.retainNew(t.renderer) === 1 && c.usedTimes === 2);
  check("no relinks so far", pr.stats.relinks === 0 && pr.stats.relinkedKeys === 0);
}

// ── 2. ShaderMaterial / RawShaderMaterial skipped unless pinned ───────────
{
  const t = fakeThree();
  const pr = createProgramRetention({ enabled: true });
  const sm = t.acquire("12,13,DEFS", "ShaderMaterial", "terrain");
  const raw = t.acquire("20,21,", "RawShaderMaterial", "post");
  const line = t.acquire("30,31,X", "LineMaterial");
  const std = t.acquire("physical,S");
  pr.retainNew(t.renderer);
  check("ShaderMaterial not bumped", sm.usedTimes === 1);
  check("RawShaderMaterial not bumped", raw.usedTimes === 1);
  check("custom-type stage-keyed program not bumped", line.usedTimes === 1);
  check("built-in program bumped", std.usedTimes === 2);
  check("skippedShader = 3, retained = 1", pr.stats.skippedShader === 3 && pr.stats.retained === 1, JSON.stringify(pr.stats));

  // Pin AFTER the program was seen: the next call rescans and retains it.
  check("pinStagePair accepts numeric ids", pr.pinStagePair(12, 13) === true);
  check("pinStagePair rejects non-numeric ids", pr.pinStagePair("physical", "x") === false);
  check("rescan retains the pinned family", pr.retainNew(t.renderer) === 1 && sm.usedTimes === 2);
  check("skippedShader drops to 2, pinnedFamilies 1", pr.stats.skippedShader === 2 && pr.stats.pinnedFamilies === 1);
  check("unpinned shader programs still not bumped", raw.usedTimes === 1 && line.usedTimes === 1);
  // Another program of the pinned pair (different defines) is retained on sight.
  const sm2 = t.acquire("12,13,OTHER", "ShaderMaterial", "terrain");
  pr.retainNew(t.renderer);
  check("new program of a pinned pair retained on sight", sm2.usedTimes === 2);
  // Same source, different stage pair (stage ids reissued): not pinned.
  const sm3 = t.acquire("14,15,DEFS", "ShaderMaterial", "terrain");
  pr.retainNew(t.renderer);
  check("a different stage pair is not retained", sm3.usedTimes === 1);

  // pinMaterialStages reads properties.get(material).currentProgram.
  const mat = {};
  const props = new Map([[mat, { currentProgram: raw }]]);
  const r2 = { info: t.renderer.info, properties: { get: (m) => props.get(m) } };
  check("pinMaterialStages pins a compiled material's pair", pr.pinMaterialStages(r2, mat) === true);
  pr.retainNew(t.renderer);
  check("its program is then retained", raw.usedTimes === 2);
  check("pinMaterialStages of an uncompiled material → false", pr.pinMaterialStages(r2, {}) === false);
  const stdMat = {};
  props.set(stdMat, { currentProgram: std });
  check("pinMaterialStages of a built-in material → false", pr.pinMaterialStages(r2, stdMat) === false);
}

// ── 3. three's releaseProgram never removes a retained program ────────────
{
  const t = fakeThree();
  const pr = createProgramRetention({ enabled: true });
  const p = t.acquire("physical,K"); // material 1
  pr.retainNew(t.renderer);
  t.release(p); // material 1 disposed
  check("retained program survives its last material's dispose", !p.destroyed && t.renderer.info.programs.includes(p));
  const again = t.acquire("physical,K"); // a new material with the same key
  check("the next acquire is a cache hit (same program, nothing created)", again === p && t.created() === 1);
  t.release(again);
  pr.retainNew(t.renderer);
  check("no relink, nothing released", pr.stats.relinks === 0 && pr.stats.released === 0, JSON.stringify(pr.stats));
  // An unretained (shader) program IS still destroyed by three.
  const s = t.acquire("3,4,", "ShaderMaterial");
  pr.retainNew(t.renderer);
  t.release(s);
  pr.retainNew(t.renderer);
  check("an unretained shader program is still destroyed", s.destroyed === true);
  check("released counts it", pr.stats.released === 1);
}

// ── 4. context restore: a new programs array, even of the same length ─────
{
  const t = fakeThree();
  const pr = createProgramRetention({ enabled: true });
  t.acquire("physical,A");
  t.acquire("physical,B");
  pr.retainNew(t.renderer);
  check("before restore: 2 retained", pr.stats.retained === 2);
  t.restore();
  const a2 = t.acquire("physical,A");
  const b2 = t.acquire("physical,B");
  check("same length as before the restore", t.renderer.info.programs.length === 2);
  check("the new array's programs are retained", pr.retainNew(t.renderer) === 2 && a2.usedTimes === 2 && b2.usedTimes === 2);
  check("contextResets = 1, retained = 2", pr.stats.contextResets === 1 && pr.stats.retained === 2);
  check("re-created keys after a restore are not counted as relinks", pr.stats.relinks === 0);
  // A length-only check (WebAC) would have skipped them: prove the trap exists.
  let lengthOnly = 0;
  for (const p of t.renderer.info.programs) if (p.usedTimes === 1) lengthOnly += 1;
  check("(model check) nothing left unretained", lengthOnly === 0);
  // Pins are per context: cleared by the restore.
  const t2 = fakeThree();
  const pr2 = createProgramRetention({ enabled: true });
  pr2.pinStagePair(1, 2);
  t2.acquire("1,2,", "ShaderMaterial");
  pr2.retainNew(t2.renderer);
  check("a pin made before the first call survives first adoption", pr2.stats.retained === 1 && pr2.stats.pinnedFamilies === 1);
  t2.restore();
  const s2 = t2.acquire("1,2,", "ShaderMaterial");
  pr2.retainNew(t2.renderer);
  check("pins cleared on restore (stage ids are reissued)", pr2.stats.pinnedFamilies === 0 && s2.usedTimes === 1);
}

// ── 5. retention OFF: relinks measured, lifetimes untouched ───────────────
{
  const t = fakeThree();
  const pr = createProgramRetention({ enabled: false });
  const p = t.acquire("physical,R", "MeshStandardMaterial", "rock");
  pr.retainNew(t.renderer);
  check("OFF: usedTimes untouched", p.usedTimes === 1 && pr.stats.retained === 0);
  t.release(p);
  check("OFF: three destroys it", p.destroyed === true);
  pr.retainNew(t.renderer);
  check("OFF: released = 1", pr.stats.released === 1);
  const p2 = t.acquire("physical,R", "MeshStandardMaterial", "rock");
  check("OFF: the next material relinks (a new program)", p2 !== p && t.created() === 2);
  pr.retainNew(t.renderer);
  check("OFF: relinks = 1, relinkedKeys = 1", pr.stats.relinks === 1 && pr.stats.relinkedKeys === 1, JSON.stringify(pr.stats));
  check("OFF: relinkedBy names the material", pr.stats.relinkedBy.rock === 1);
  check("OFF: keysSeen = 1", pr.stats.keysSeen === 1);
  check("OFF: enabled flag reported", pr.stats.enabled === false);
  // Same scenario with retention ON: zero relinks.
  const t2 = fakeThree();
  const on = createProgramRetention({ enabled: true });
  const q = t2.acquire("physical,R");
  on.retainNew(t2.renderer);
  t2.release(q);
  on.retainNew(t2.renderer);
  t2.acquire("physical,R");
  on.retainNew(t2.renderer);
  check("ON: the same churn relinks nothing", on.stats.relinks === 0 && on.stats.released === 0 && t2.created() === 1);
}

// ── 6. same-window create + release (signature unchanged) → caught by sweep ─
{
  const t = fakeThree();
  const pr = createProgramRetention({ enabled: true, sweepEvery: 5 });
  t.acquire("physical,A");
  const s = t.acquire("9,10,", "ShaderMaterial");
  t.acquire("physical,TAIL");
  pr.retainNew(t.renderer);
  const progs = t.renderer.info.programs;
  const len0 = progs.length;
  const tail0 = progs[len0 - 1];
  // create N (pushed at the end), then release the shader program: N is
  // swapped into its slot, the tail and length are back where they were.
  const n = t.acquire("physical,N");
  t.release(s);
  check("(model) the signature is unchanged", progs.length === len0 && progs[progs.length - 1] === tail0);
  pr.retainNew(t.renderer);
  check("the cheap gate skips this call", n.usedTimes === 1);
  for (let i = 0; i < 5; i++) pr.retainNew(t.renderer);
  check("the periodic sweep retains it", n.usedTimes === 2);
  check("released counted once", pr.stats.released === 1, JSON.stringify(pr.stats));
}

// ── 7. soft cap ───────────────────────────────────────────────────────────
{
  const t = fakeThree();
  const pr = createProgramRetention({ enabled: true, cap: 2 });
  const a = t.acquire("physical,1");
  const b = t.acquire("physical,2");
  const c = t.acquire("physical,3");
  pr.retainNew(t.renderer);
  check("cap: first two retained, third not", a.usedTimes === 2 && b.usedTimes === 2 && c.usedTimes === 1);
  check("cap: overCap = 1", pr.stats.overCap === 1 && pr.stats.retained === 2);
}

// ── 8. fail-soft + session singleton + __diag.programs ────────────────────
{
  const pr = createProgramRetention({ enabled: true });
  check("no renderer → 0", pr.retainNew(null) === 0);
  check("no info.programs → 0", pr.retainNew({ info: {} }) === 0);
  let threw = false;
  try { retainNewPrograms({ get info() { throw new Error("lost"); } }); } catch (_) { threw = true; }
  check("retainNewPrograms never throws", threw === false);
  delete globalThis.__diag;
  const t = fakeThree();
  const p = t.acquire("physical,S1");
  retainNewPrograms(t.renderer);
  const sess = getProgramRetention();
  check("singleton is ON with no flag", sess.stats.enabled === true);
  check("singleton retained the program", p.usedTimes === 2);
  check("__diag.programs is the live stats object", globalThis.__diag && globalThis.__diag.programs === sess.stats);
  const d = globalThis.__diag.programs;
  check(
    "__diag.programs carries retained/skippedShader/relinkedKeys/keysSeen",
    ["retained", "skippedShader", "relinkedKeys", "keysSeen", "relinks", "released"].every((k) => typeof d[k] === "number"),
  );
}

// ── 9. relinkedBy label cardinality is bounded ───────────────────────────
{
  const t = fakeThree();
  const pr = createProgramRetention({ enabled: false });
  for (let i = 0; i < 100; i++) {
    const p = t.acquire(`physical,L${i}`, "MeshBasicMaterial", `nameplate-${i}`);
    pr.retainNew(t.renderer);
    t.release(p);
    pr.retainNew(t.renderer);
    t.acquire(`physical,L${i}`, "MeshBasicMaterial", `nameplate-${i}`);
    pr.retainNew(t.renderer);
  }
  const labels = Object.keys(pr.stats.relinkedBy);
  check("100 relinks counted", pr.stats.relinks === 100, String(pr.stats.relinks));
  check("labels capped (64 + \"(other)\")", labels.length === 65 && pr.stats.relinkedBy["(other)"] === 36, String(labels.length));
  const t2 = fakeThree();
  const pr2 = createProgramRetention({ enabled: false });
  const q = t2.acquire("physical,P", "MeshBasicMaterial", "toString");
  pr2.retainNew(t2.renderer);
  t2.release(q);
  pr2.retainNew(t2.renderer);
  t2.acquire("physical,P", "MeshBasicMaterial", "toString");
  pr2.retainNew(t2.renderer);
  check("a prototype-named label counts as a plain number", pr2.stats.relinkedBy.toString === 1);
}

// ── 10. drift pins: vendored three r184 + the index.js render-tail hook ────
{
  let three = "";
  try {
    three = readFileSync(joinPath(__dirname, "..", "node_modules", "three", "build", "three.module.js"), "utf8");
  } catch (_) {
    three = "";
  }
  if (three) {
    check("three: releaseProgram destroys at usedTimes 0", /function releaseProgram\( program \) \{\s*if \( -- program\.usedTimes === 0 \)/.test(three));
    check("three: acquireProgram is a map hit → ++usedTimes", /function acquireProgram\( parameters, cacheKey \) \{\s*let program = programsMap\.get\( cacheKey \);\s*if \( program !== undefined \) \{\s*\+\+ program\.usedTimes;/.test(three));
    check("three: info.programs is re-pointed on (re)init", /info\.programs = programCache\.programs;/.test(three));
    check("three: WebGLProgram.type = material.type", /this\.type = parameters\.shaderType;/.test(three) && /shaderType: material\.type,/.test(three));
    check("three: custom shaders key by stage id", /array\.push\( parameters\.customVertexShaderID \);/.test(three));
  } else {
    console.log("  [SKIP] three.module.js not vendored here — drift pins skipped");
  }
  const idx = readFileSync(joinPath(__dirname, "..", "scene3d", "index.js"), "utf8");
  check("index.js imports retainNewPrograms", /import \{ retainNewPrograms \} from "\.\/program_retention\.js";/.test(idx));
  const body = idx.slice(idx.indexOf("function recordRenderDiag("), idx.indexOf("function recordRenderDiag(") + 1500);
  check("recordRenderDiag calls retainNewPrograms(renderer) before the renderDiag gate",
    /retainNewPrograms\(renderer\);[\s\S]*if \(_renderDiagArmed === undefined\)/.test(body));
}

console.log(`\nprogram_retention: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

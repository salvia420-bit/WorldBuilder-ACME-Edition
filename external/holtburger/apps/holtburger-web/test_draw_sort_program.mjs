// 2026-10-04 — perf T10 from the OpenAC comparison (`?drawSortProgram`): group
// opaque draws by compiled program, keeping every other key of three r184's
// `painterSortStable` in place.
//
// Run:
//   cd apps/holtburger-web/
//   node test_draw_sort_program.mjs

import {
  makeProgramSort,
  installDrawSortProgram,
  drawSortProgramEnabled,
} from "./scene3d/draw_sort_program.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

function fakeRenderer() {
  const map = new WeakMap();
  let opaqueSort = "unset";
  let lookups = 0;
  return {
    info: { render: { frame: 0 } },
    properties: { get(m) { lookups++; let p = map.get(m); if (!p) { p = {}; map.set(m, p); } return p; } },
    setOpaqueSort(fn) { opaqueSort = fn; },
    get opaqueSort() { return opaqueSort; },
    get lookups() { return lookups; },
    bind(m, programId) { this.properties.get(m).currentProgram = programId == null ? undefined : { id: programId }; },
  };
}

let nextId = 0;
const mat = (id) => ({ id });
const item = (material, o = {}) => ({
  id: nextId++, groupOrder: 0, renderOrder: 0, material, materialVariant: 0, z: 0, ...o,
});

// ---------------------------------------------------------------------------
console.log("PART 1 — opaque draws cluster by program");
// ---------------------------------------------------------------------------
{
  const r = fakeRenderer();
  // Material ids interleave two programs: 1:A 2:B 3:A 4:B 5:A
  const ms = [1, 2, 3, 4, 5].map(mat);
  ms.forEach((m, i) => r.bind(m, i % 2 === 0 ? 10 : 20));
  const items = ms.map((m) => item(m));
  const sorted = items.slice().sort(makeProgramSort(r));
  const progs = sorted.map((it) => r.properties.get(it.material).currentProgram.id);
  const switches = progs.filter((p, i) => i > 0 && p !== progs[i - 1]).length;
  check("one switch instead of four", switches === 1, progs.join(","));
  check("material.id still orders within a program",
        sorted.map((it) => it.material.id).join() === "1,3,5,2,4");
}

// ---------------------------------------------------------------------------
console.log("PART 2 — every other painterSortStable key keeps its place");
// ---------------------------------------------------------------------------
{
  const r = fakeRenderer();
  const a = mat(1), b = mat(2);
  r.bind(a, 99); r.bind(b, 1);
  const s = makeProgramSort(r);
  check("groupOrder beats program", s(item(a, { groupOrder: 0 }), item(b, { groupOrder: 1 })) < 0);
  check("renderOrder beats program", s(item(a, { renderOrder: -1 }), item(b)) < 0);
  check("program beats material.id at equal renderOrder", s(item(a), item(b)) > 0);
  const near = item(a, { z: 1 }), far = item(a, { z: 5 });
  check("same material keeps front-to-back z", s(near, far) < 0 && s(far, near) > 0);
  const v0 = item(a, { materialVariant: 0, z: 9 }), v1 = item(a, { materialVariant: 1, z: 0 });
  check("materialVariant still precedes z", s(v0, v1) < 0);
  const t1 = item(a), t2 = item(a);
  check("stable id tie-break", s(t1, t2) < 0);
  const u = mat(3); r.bind(u, null);
  check("an uncompiled material sorts after compiled ones", s(item(u), item(a)) > 0);
}

// ---------------------------------------------------------------------------
console.log("PART 3 — program ids are memoized per render() call");
// ---------------------------------------------------------------------------
{
  const r = fakeRenderer();
  const ms = [];
  for (let i = 1; i <= 40; i++) { const m = mat(i); r.bind(m, i % 5); ms.push(m); }
  const s = makeProgramSort(r);
  const items = [];
  for (let k = 0; k < 10; k++) for (const m of ms) items.push(item(m, { z: k }));
  const before = r.lookups;
  items.slice().sort(s);
  const used = r.lookups - before;
  check("at most one lookup per material per frame", used <= ms.length, `lookups=${used} materials=${ms.length}`);
  // A recompile lands next frame and is picked up.
  r.bind(ms[0], 1000);
  r.info.render.frame++;
  const sorted = items.slice().sort(s);
  check("a recompiled program is seen on the next frame",
        sorted[sorted.length - 1].material === ms[0]);
}

// ---------------------------------------------------------------------------
console.log("PART 4 — install, live toggle, flag grammar");
// ---------------------------------------------------------------------------
{
  const withSearch = (search) => {
    globalThis.window = { location: { search } };
    return import(`./scene3d/draw_sort_program.js?${encodeURIComponent(search)}`)
      .then((mod) => { const v = mod.drawSortProgramEnabled(); delete globalThis.window; return v; });
  };
  check("absent ⇒ off (opt-in)", drawSortProgramEnabled() === false);
  check("?drawSortProgram=on arms it", (await withSearch("?drawSortProgram=on")) === true);
  check("anything else stays off", (await withSearch("?drawSortProgram=yes")) === false);

  const r = fakeRenderer();
  globalThis.window = {};
  const on = installDrawSortProgram(r);
  check("default install leaves three's sort (null)", on === false && r.opaqueSort === null);
  check("window.__drawSort is installed", typeof window.__drawSort?.probe === "function");
  window.__drawSort.set(true);
  check("set(true) installs the program sort", typeof r.opaqueSort === "function" && window.__drawSort.get());
  const fn = r.opaqueSort;
  window.__drawSort.set(false);
  window.__drawSort.set(true);
  check("toggling reuses one comparator (one memo)", r.opaqueSort === fn);
  window.__drawSort.set(false);
  check("set(false) restores three's painterSortStable", r.opaqueSort === null);
  delete globalThis.window;
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

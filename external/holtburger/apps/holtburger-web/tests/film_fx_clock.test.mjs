// tests/film_fx_clock.test.mjs — the FX clock follows the film clock in a stepped take (2026-10-15).
//
// WHY: film mode (?filmMode=on, DEFAULT OFF) renders a stepped take frame by frame at film timestamps, often slower
// than real time. Effects that read performance.now() themselves — portal swirl / fire heat shimmer
// (vfx/fx_distort_effect.js), ground decals (fx_decal_effect.js, fx_decals.js), the portal-disc / lifestone-aura
// showcase (fx_showcase.js), light-pool flicker and flash envelopes (fx_lights.js), trails (fx_ribbons.js) and
// lifestone breath (lifestone_fx.js) — ran on the WALL time between rendered frames (too fast, jumpy), and so did
// grass sway and the ambient fields (loop.js → terrainVfxTick). The effects audit found them; the owner asked for
// every legitimate effect to be operant during filming. These checks pin: fx_clock.js is performance.now() with no
// source and the installed source otherwise; particle_fx.setFxTimeSource (what film_clock.js installs) forwards to
// it; every listed module reads fxNowMs() at the audited sites; loop.js feeds terrainVfxTick the film frame stamp
// while film.holdLoop is set. Pure — nothing renders.
//
// Run from apps/holtburger-web/: node tests/film_fx_clock.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fxNowMs, setFxClockSource } from "../scene3d/fx_clock.js";

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name} — ${e && e.message ? e.message : e}`);
  }
}
const src = (p) => readFileSync(new URL(`../scene3d/${p}`, import.meta.url), "utf8");

check("no source: fxNowMs() is performance.now()", () => {
  setFxClockSource(null);
  const a = performance.now();
  const t = fxNowMs();
  const b = performance.now();
  assert.ok(t >= a && t <= b, `${t} not within [${a}, ${b}]`);
});
check("an installed source wins; a throwing / non-finite source falls back to performance.now()", () => {
  setFxClockSource(() => 123456.5);
  assert.equal(fxNowMs(), 123456.5);
  setFxClockSource(() => NaN);
  assert.ok(Math.abs(fxNowMs() - performance.now()) < 50);
  setFxClockSource(() => { throw new Error("x"); });
  assert.ok(Math.abs(fxNowMs() - performance.now()) < 50);
  setFxClockSource(null);
  assert.throws(() => setFxClockSource(42), /expected a function or null/);
});
check("particle_fx.setFxTimeSource (installed by film_clock.js for a stepped take) forwards to fx_clock.js", () => {
  const s = src("particles/particle_fx.js");
  assert.match(s, /import \{ setFxClockSource \} from "\.\.\/fx_clock\.js";/);
  const body = s.slice(s.indexOf("export function setFxTimeSource"), s.indexOf("function _fxSourceNowMs"));
  assert.match(body, /_fxTimeSource = fn \|\| null;[\s\S]*setFxClockSource\(_fxTimeSource\);/);
});
for (const [file, n] of [["vfx/fx_distort_effect.js", 1], ["vfx/fx_decal_effect.js", 1], ["vfx/fx_showcase.js", 2], ["vfx/fx_lights.js", 1],
  ["vfx/fx_ribbons.js", 3], ["vfx/fx_decals.js", 1], ["vfx/lifestone_fx.js", 1]]) {
  check(`${file} animates on fxNowMs() (${n} site${n > 1 ? "s" : ""})`, () => {
    const s = src(file);
    assert.match(s, /import \{ fxNowMs \} from "\.\.\/fx_clock\.js";/);
    assert.equal((s.match(/fxNowMs\(\)/g) || []).length, n);
  });
}
check("fx_decal_effect keeps performance.now() only for its CPU-time stats", () => {
  const s = src("vfx/fx_decal_effect.js");
  for (const m of s.matchAll(/performance\.now\(\)/g)) {
    const line = s.slice(s.lastIndexOf("\n", m.index) + 1, s.indexOf("\n", m.index));
    assert.match(line, /t0|cpuMs/, line.trim());
  }
});
check("loop.js: terrainVfxTick gets the film frame stamp while film.holdLoop is set, the live clock otherwise", () => {
  const s = src("loop.js");
  assert.match(s, /const _vfxTsSec = scene3d\?\.film\?\.holdLoop && Number\.isFinite\(scene3d\?\.frameTime\?\.tsSec\) \? scene3d\.frameTime\.tsSec : _rp3TsSec;/);
  assert.match(s, /terrainVfxTick\(scene3d\?\.frameTime\?\.dt \?\? 0, scene3d, _vfxTsSec\);/);
});

console.log(`film_fx_clock: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

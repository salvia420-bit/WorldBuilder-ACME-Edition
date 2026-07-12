// WS09 (2026-07-12) — `formulaScale` is a script-SELECTION mod, NOT a playback
// speed (F1). Proves scene3d/play_effect_vfx.js::pickScriptEntry matches a
// from-decomp `PhysicsScriptTableData::GetScript` reference (acclient.c:336552)
// over the ENTIRE reachable formulaScale domain against the real DAT mod
// ladders. `speed` (the misnomer) is the GetScript threshold selector; a level-I
// buff (Formula.Scale 0.05) picks the subtle variant, level-VI (1.0) the
// dramatic one — if it were a playback rate 0.05 would run 20x too slow.
//
// Reachability: every DAT ladder in PhysicsScriptTable 0x34000004 tops out at
// mod 1.0 and the max spell Formula.Scale is 1.0, so `speed` never exceeds the
// tail — the only divergence (client clamps to last entry, decomp returns id 0)
// is UNREACHABLE for real casts. The ladders below mirror the oracle shapes
// ({0,0.25,0.5,0.75,1}, {0,0.5,1}, {1}).
//
// Run: node tests/test_ws09_formula_scale_parity.mjs   (from apps/holtburger-web/)

import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Register the shared "three" resolution hook (bare `three` → the stub) so the
// resolver module imports cleanly under Node.
register(pathToFileURL(resolvePath(__dirname, "../_three_stub_loader.mjs")).href);

// play_effect_vfx.js runs an auto-bind IIFE on import that polls
// window.__pluginClient — scaffold a quiet window so the import is silent.
globalThis.window = globalThis.window || {
  __pluginClient: { events: { on() {}, off() {}, emit() {} } },
  __playEffectVfxBound: false,
  liveScene3d: null,
};

const mod = await import(
  pathToFileURL(resolvePath(__dirname, "../scene3d/play_effect_vfx.js")).href
);
const { pickScriptEntry, __test } = mod;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log("  FAIL " + m); } };

ok(typeof pickScriptEntry === "function", "pickScriptEntry exported");
ok(typeof __test?.runPickerSelfTests === "function", "__test.runPickerSelfTests exported");

// The module's own inline self-tests (single-entry, two-entry below/above,
// three-entry clamp, empty/null guards).
const self = __test.runPickerSelfTests();
ok(!self.failed, `picker self-tests: ${self.passed}/${self.total} pass`);

// From-decomp reference: the FIRST entry whose mod threshold is >= the
// requested mod; overflow (mod exceeds every entry) → null (retail returns the
// global default id 0). acclient.c:336552 `while (mod > v5->mod) ++v5;`.
const decomp = (es, mod) => { for (const e of es) if (!(mod > e.mod)) return e; return null; };

// Real ladder shapes (ascending mod, terminating at 1.0), with distinct DIDs.
const ladders = [
  [{ mod: 0, scriptDid: 100 }, { mod: 0.25, scriptDid: 101 }, { mod: 0.5, scriptDid: 102 }, { mod: 0.75, scriptDid: 103 }, { mod: 1, scriptDid: 104 }],
  [{ mod: 0, scriptDid: 200 }, { mod: 0.5, scriptDid: 201 }, { mod: 1, scriptDid: 202 }],
  [{ mod: 1, scriptDid: 300 }], // Fizzle-shape single-entry ladder (0x33000103)
];

// The reachable formulaScale grade set (spell levels I..VI) plus the ladder
// breakpoints — every value is within [0, 1.0], the reachable domain.
const grades = [0, 0.05, 0.2, 0.25, 0.4, 0.5, 0.6, 0.75, 1.0];

let mism = 0, total = 0;
for (const L of ladders) {
  for (const s of grades) {
    total++;
    const a = pickScriptEntry(L, s)?.scriptDid ?? null;
    const b = decomp(L, s)?.scriptDid ?? null;
    if (a !== b) {
      mism++;
      console.log(`  FAIL MISMATCH mods=[${L.map((e) => e.mod)}] scale=${s} client=${a} decomp=${b}`);
    }
  }
}
ok(mism === 0, `decomp-parity over reachable domain: ${total - mism}/${total} match`);

// The single divergence — scale=2.0 (above every mod): client clamps to the
// last entry, decomp returns null. Documented + UNREACHABLE (max scale = 1.0).
{
  const L = ladders[0];
  const client = pickScriptEntry(L, 2.0)?.scriptDid ?? null;
  const dc = decomp(L, 2.0)?.scriptDid ?? null;
  ok(client === 104 && dc === null,
    `overflow (scale=2.0) diverges as documented: client=${client} (last), decomp=${dc} (null) — UNREACHABLE`);
}

console.log(`\nWS09 formulaScale parity: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

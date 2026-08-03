// test_trail_map_stamp_falloff.mjs — the stamp falloff must not depend on
// UNDEFINED GLSL behaviour (2026-08-03 review F10, task #149).
//
// The shipped stamp term was `smoothstep(s.z, 0.0, d)`: edge0 = the stamp
// radius, edge1 = 0. `s.z` is clamped to > 0 on the JS side (trail_map.js
// `blobRadiusM > 0 ? blobRadiusM : TRAIL_DEFAULTS.stampRadiusM`), so
// edge0 > edge1 on every texel of every stamp, always.
//
// GLSL ES 1.0 §8.3: "Results are undefined if edge0 >= edge1." The expression
// worked only because the common lowering is the general
// clamp((x-edge0)/(edge1-edge0), 0, 1) form, which inverts cleanly for a
// negative denominator. A conforming compiler that specialises on the
// documented edge0 < edge1 precondition may return 0 instead — every stomp,
// footprint and mud print silently blank, while `stampsDrawn` keeps counting
// and `stats()` keeps reporting the feature healthy. The 1070 runs
// ANGLE/D3D11.
//
// This drives BOTH candidate lowerings against BOTH forms, so the fix is
// proven on the math rather than asserted on the source text (though the
// source is also locked, since the whole point is which expression ships).
//
// Run: node test_trail_map_stamp_falloff.mjs

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass += 1; console.log(`  [OK] ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${extra ? ` — ${extra}` : ""}`); }
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// Lowering A — the general form nearly every driver emits today.
function smoothstepGeneral(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
// Lowering B — a conforming compiler that trusts the edge0 < edge1
// precondition. Returning 0 for the whole undefined region is legal.
function smoothstepStrict(edge0, edge1, x) {
  if (!(edge0 < edge1)) return 0;
  return smoothstepGeneral(edge0, edge1, x);
}

// The two candidate stamp terms.
const oldForm = (ss, d, r, w) => w * ss(r, 0.0, d);
const newForm = (ss, d, r, w) => w * (1.0 - ss(0.0, Math.max(r, 1e-4), d));

const R = 1.5;   // metres — a footprint blob
const W = 0.8;   // strength
const samples = [0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0].map((f) => f * R);

// ── under the forgiving lowering, the fix must be a no-op ──────────────────
{
  const before = samples.map((d) => oldForm(smoothstepGeneral, d, R, W));
  const after = samples.map((d) => newForm(smoothstepGeneral, d, R, W));
  const maxDiff = Math.max(...before.map((v, i) => Math.abs(v - after[i])));
  check("general lowering: new form is byte-identical to the old curve",
    maxDiff < 1e-12, `maxDiff=${maxDiff}`);
  check("general lowering: centre is full strength, rim is zero",
    Math.abs(after[0] - W) < 1e-12 && Math.abs(after[samples.length - 3]) < 1e-12,
    JSON.stringify(after));
  check("general lowering: falloff is monotonically decreasing",
    after.every((v, i) => i === 0 || v <= after[i - 1] + 1e-12),
    JSON.stringify(after));
}

// ── under the strict lowering, the OLD form is the blank-map bug ───────────
{
  const before = samples.map((d) => oldForm(smoothstepStrict, d, R, W));
  const after = samples.map((d) => newForm(smoothstepStrict, d, R, W));
  check("strict lowering: OLD form collapses to zero everywhere (the bug)",
    before.every((v) => v === 0), JSON.stringify(before));
  check("strict lowering: NEW form is unchanged and still correct",
    Math.abs(after[0] - W) < 1e-12 &&
    after.every((v, i) => i === 0 || v <= after[i - 1] + 1e-12),
    JSON.stringify(after));
  check("strict lowering: the two forms genuinely disagree (test has teeth)",
    Math.max(...after.map((v, i) => Math.abs(v - before[i]))) > 0.5);
}

// ── a zero/degenerate radius must not reintroduce edge0 >= edge1 ───────────
{
  for (const bad of [0, -1, 1e-9]) {
    const v = newForm(smoothstepStrict, 0.0, bad, W);
    check(`degenerate radius ${bad}: still defined (no edge0 >= edge1)`,
      Number.isFinite(v) && v >= 0 && v <= W, `got ${v}`);
  }
}

// ── source lock: the shipped shader uses the spec-safe form ────────────────
{
  const src = readFileSync(new URL("./scene3d/trail_map.js", import.meta.url), "utf8");
  const stampLine = src.split("\n").find((l) => l.includes("v = max(v, s.w"));
  check("shipped shader uses the spec-safe rising smoothstep",
    !!stampLine && stampLine.includes("1.0 - smoothstep(0.0,"),
    stampLine ?? "(stamp term not found)");
  check("shipped shader no longer passes the radius as edge0",
    !!stampLine && !/smoothstep\(\s*s\.z\s*,/.test(stampLine),
    stampLine ?? "");
}

console.log("");
console.log(`trail map stamp falloff: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

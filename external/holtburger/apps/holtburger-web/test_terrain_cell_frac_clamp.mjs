// test_terrain_cell_frac_clamp.mjs — 2026-10-07 green-sparkle regression.
// The terrain fragment shader clamped the cell index (iu/iv) but not the
// intra-cell fraction (fu/fv). A fragment with vGridUv outside [0, 8] then
// extrapolated its four bilinear corner weights, and the per-biome palette
// tint turned one terrain fragment into an HDR green spike (~141 vs ~0.06),
// which the owner saw as "a green sparkling light in the distance".
//
// Run: node test_terrain_cell_frac_clamp.mjs
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`); }
}

const src = readFileSync(new URL("./scene3d/terrain.js", import.meta.url), "utf8");
check("fu is clamped to [0, 1]", src.includes("float fu = clamp(grid.x - float(iu), 0.0, 1.0);"));
check("fv is clamped to [0, 1]", src.includes("float fv = clamp(grid.y - float(iv), 0.0, 1.0);"));
check("no unclamped fraction remains", !/float f[uv] = grid\.[xy] - float\(i[uv]\);/.test(src));

// The math the clamp guards: the shader's weights for a grid coordinate.
function weights(gx, gy, clampFrac) {
  const iu = Math.min(7, Math.max(0, Math.floor(gx)));
  const iv = Math.min(7, Math.max(0, Math.floor(gy)));
  let fu = gx - iu, fv = gy - iv;
  if (clampFrac) { fu = Math.min(1, Math.max(0, fu)); fv = Math.min(1, Math.max(0, fv)); }
  return [(1 - fu) * (1 - fv), fu * (1 - fv), (1 - fu) * fv, fu * fv];
}
const inRange = (w) => w.every((x) => x >= 0 && x <= 1);
// Palette corners from data/terrain_palette.json (normalised): BarrenRock 0
// vs LushGrass 3 — they differ mostly in green, hence the green spike.
const p0 = [100 / 255, 150 / 255, 100 / 255], p3 = [70 / 255, 250 / 255, 70 / 255];
const tintG = (w) => 1 + 0.25 * ((p0[1] * (w[0] + w[2]) + p3[1] * (w[1] + w[3])) - 1);

for (const g of [[0.2, 0.3], [3.5, 7.9], [7.999, 0.001]]) {
  const a = weights(g[0], g[1], false), b = weights(g[0], g[1], true);
  check(`in range (${g}) — clamp is a no-op`, a.every((x, i) => Math.abs(x - b[i]) < 1e-12));
}
for (const g of [[8.6, 4.2], [-1.5, 2.5], [12, 12]]) {
  check(`out of range (${g}) — unclamped weights extrapolate`, !inRange(weights(g[0], g[1], false)));
  const w = weights(g[0], g[1], true);
  check(`out of range (${g}) — clamped weights stay in [0, 1]`, inRange(w), JSON.stringify(w));
  check(`out of range (${g}) — clamped palette tint stays <= 1`, tintG(w) <= 1 + 1e-9, String(tintG(w)));
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// HUD overhaul 2026-10-05 — zoom-aware popup placement + tooltip model.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_hud_popup_placement.mjs
//
// `placeNearPointer` (plugins/hover-tooltip.js) is the pure rule the
// hover tooltip AND the right-click menu (plugins/radial-menu.js) use to
// put a box next to the pointer. Both live in zoomed HUD roots, so the
// callers convert the screen-px pointer with hudPoint() and pass the
// HUD-px viewport (hudViewport()); the rule itself is unit-agnostic.
// Also pins the screen→HUD conversion maths of ui/hud_scale.js the
// callers rely on.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const load = (p) => import(pathToFileURL(resolvePath(__dirname, p)).href);

const { placeNearPointer, tooltipModel } = await load("plugins/hover-tooltip.js");
const hudScale = await load("ui/hud_scale.js");

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  [OK] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("== placeNearPointer ==");
{
  // Plenty of room: offset right/below.
  const p = placeNearPointer(100, 100, 80, 40, 1280, 720);
  check("default offset +14/+18", p.x === 114 && p.y === 118 && !p.flippedX && !p.flippedY, JSON.stringify(p));
}
{
  // Near the right edge: flips to the left of the pointer.
  const p = placeNearPointer(1250, 100, 80, 40, 1280, 720);
  check("flips left at right edge", p.flippedX && p.x === 1250 - 14 - 80, JSON.stringify(p));
}
{
  // Near the bottom edge: flips above.
  const p = placeNearPointer(100, 700, 80, 40, 1280, 720);
  check("flips up at bottom edge", p.flippedY && p.y === 700 - 18 - 40, JSON.stringify(p));
}
{
  // Corner: both flips, still inside.
  const p = placeNearPointer(1278, 718, 120, 90, 1280, 720);
  check("bottom-right corner stays on screen",
    p.x >= 4 && p.y >= 4 && p.x + 120 <= 1280 - 4 + 1e-9 && p.y + 90 <= 720 - 4 + 1e-9, JSON.stringify(p));
}
{
  // A box bigger than the viewport pins to the margin instead of going negative.
  const p = placeNearPointer(10, 10, 2000, 900, 1280, 720);
  check("oversize box pins to the top-left margin", p.x === 4 && p.y === 4, JSON.stringify(p));
}
{
  // Pointer at the top-left with the flip impossible: clamped to margin.
  const p = placeNearPointer(0, 0, 50, 20, 300, 200, { dx: 2, dy: 2, margin: 4 });
  check("context-menu offset (+2,+2) honoured", p.x === 4 && p.y === 4, JSON.stringify(p));
}
{
  // Menu-style placement (dx=dy=2) near the right edge: flips so the
  // pointer sits at the menu's top-RIGHT corner.
  const p = placeNearPointer(500, 50, 140, 100, 512, 288, { dx: 2, dy: 2, margin: 4 });
  check("context menu flips left of the pointer", p.x === 500 - 2 - 140 && p.y === 52, JSON.stringify(p));
}

console.log("== zoom maths (ui/hud_scale.js) ==");
{
  // Screen px → HUD px is a division by the scale; at scale 1 (node: no
  // window, auto scale = 1) the helpers are the identity.
  check("getHudScale() defaults to 1 outside a browser", hudScale.getHudScale() === 1);
  const pt = hudScale.hudPoint({ clientX: 300, clientY: 150 });
  check("hudPoint identity at scale 1", pt.x === 300 && pt.y === 150, JSON.stringify(pt));
  check("computeAutoScale(720)=1, 1080→1.5, 1440→2, 2160→3, 600→1",
    hudScale.computeAutoScale(720) === 1 && hudScale.computeAutoScale(1080) === 1.5
    && hudScale.computeAutoScale(1440) === 2 && hudScale.computeAutoScale(2160) === 3
    && hudScale.computeAutoScale(600) === 1);
  // The placement the callers do at scale s: pointer (sx, sy) screen px,
  // viewport (W, H) screen px → place in HUD px → convert back → the box
  // must sit next to the SCREEN pointer, inside the SCREEN viewport.
  for (const s of [1.25, 2, 3]) {
    const W = 1280, H = 720, sx = 1200, sy = 650, bw = 120, bh = 60; // HUD px box
    const p = placeNearPointer(sx / s, sy / s, bw, bh, W / s, H / s);
    const left = p.x * s, top = p.y * s, right = (p.x + bw) * s, bottom = (p.y + bh) * s;
    check(`scale ${s}: box on screen`, left >= 0 && top >= 0 && right <= W && bottom <= H,
      JSON.stringify({ left, top, right, bottom }));
    // Within one offset of the pointer on both axes (it hugs the cursor).
    const nearX = Math.abs(right - sx) <= (14 * s + 1) || Math.abs(left - sx) <= (14 * s + 1);
    const nearY = Math.abs(bottom - sy) <= (18 * s + 1) || Math.abs(top - sy) <= (18 * s + 1);
    check(`scale ${s}: box hugs the pointer`, nearX && nearY, JSON.stringify({ left, top, right, bottom, sx, sy }));
  }
}

console.log("== tooltipModel ==");
check("no meta → null", tooltipModel(null) === null);
check("nameless meta → null", tooltipModel({ level: 5 }) === null);
{
  const m = tooltipModel({ name: "Drudge Skulker", level: 12, currentHealth: 30, maxHealth: 120 });
  check("creature: name + level + health fraction",
    m.name === "Drudge Skulker" && m.level === 12 && Math.abs(m.health.fraction - 0.25) < 1e-9, JSON.stringify(m));
}
{
  const m = tooltipModel({ name: "Sword", ql: 7, workmanship: 6.5 });
  check("item: quality + workmanship lines", eq(m.lines, ["Quality 7", "Workmanship 6.50"]), JSON.stringify(m));
  check("item: no level / health", m.level === null && m.health === null);
}
{
  const m = tooltipModel({ name: "Ghost", currentHealth: -5, maxHealth: 10 });
  check("negative health clamps to 0", m.health.cur === 0 && m.health.fraction === 0, JSON.stringify(m));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

// test_nav_frame_clamp.mjs — nav_frame.js ↔ goto_compose.js leg-frame drift
// lock (2026-08-03 review F5, task #150).
//
// `normalizeLegWorldFrame` exists to re-bucket a router leg whose EnvCell-local
// coords sit OUTSIDE [0,192) — its own header cites the live Town Network legs
// carrying y ~ -70. There are TWO copies of the cell-index math: this module's
// (used by bot.js `_walkGraphPath`) and goto_compose.js's private one (used by
// its five indoor-leg producers). They had diverged: goto_compose clamped the
// index to >= 0, nav_frame did not, so the shared helper produced a garbage
// landblock for exactly the input it was written for.
//
// Town Network cells are 0x0007xxxx — landblock X byte 0x00 — so `wx = 0*192 + x`
// and a negative local cannot be lifted back into range by the landblock base.
//
// Run: node rynth/test_nav_frame_clamp.mjs

import { normalizeLegWorldFrame, worldToOutdoorCell, worldX, worldY } from "./nav_frame.js";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass += 1; console.log(`  [OK] ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${extra ? ` — ${extra}` : ""}`); }
};

const hex = (n) => `0x${(n >>> 0).toString(16).padStart(8, "0")}`;
// A landblock byte pair is valid iff the packed id's low word is a real
// outdoor cell index (1..64) and the high bytes are the landblock.
const validOutdoorCell = (lb) => {
  const idx = (lb >>> 0) & 0xffff;
  return idx >= 1 && idx <= 64 && (lb >>> 0) <= 0xffffffff;
};

// ── the live wedge case ────────────────────────────────────────────────────
{
  const leg = { lb: 0x00070143, x: -12.5, y: -62.8, z: 10 };
  const out = normalizeLegWorldFrame(leg);
  check("Town Network negative locals do not wrap the landblock",
    validOutdoorCell(out.lb), `got lb=${hex(out.lb)} (pre-fix: 0xfffffffe)`);
  check("…and the landblock stays in the 0x00yy family it started in",
    ((out.lb >>> 24) & 0xff) === 0x00, `got lb=${hex(out.lb)}`);
}

// ── the invariant the header promises: the WORLD POINT is preserved ────────
{
  const legs = [
    { lb: 0x00070143, x: -12.5, y: -62.8, z: 10 },
    { lb: 0x00070178, x: -70.0, y: -70.0, z: 0 },
    { lb: 0xa9b40021, x: 100.25, y: 33.5, z: 66 },
    { lb: 0x0007015f, x: 250.0, y: 300.0, z: 5 },   // above 192 too
  ];
  let worst = 0;
  for (const leg of legs) {
    const out = normalizeLegWorldFrame(leg);
    if (!validOutdoorCell(out.lb)) {
      check(`leg ${hex(leg.lb)} produces a valid outdoor cell`, false, hex(out.lb));
      continue;
    }
    // Only legs whose world point is actually inside the map can round-trip;
    // a clamped one is deliberately moved (that is what a clamp is for).
    const wx0 = worldX(leg.lb, leg.x), wy0 = worldY(leg.lb, leg.y);
    if (wx0 < 0 || wy0 < 0) continue;
    const d = Math.hypot(worldX(out.lb, out.x) - wx0, worldY(out.lb, out.y) - wy0);
    worst = Math.max(worst, d);
  }
  check("in-range legs keep their exact world point", worst < 1e-9, `worst=${worst}`);
}

// ── DRIFT LOCK: the two copies must agree ──────────────────────────────────
// goto_compose.js's copy is private, so mirror it here from its source text —
// if either implementation changes shape, this stops matching and the lock
// fails loudly rather than silently re-diverging.
{
  const gc = readFileSync(new URL("./goto_compose.js", import.meta.url), "utf8");
  const body = gc.slice(gc.indexOf("function normalizeLegWorldFrame"));
  const cellLine = body.split("\n").find((l) => l.includes("const cell = 1 +"));
  check("goto_compose.js still clamps the cell index to >= 0",
    !!cellLine && /Math\.max\(\s*0\s*,/.test(cellLine), cellLine ?? "(not found)");

  // Independent reimplementation of the goto_compose form.
  const gotoComposeForm = (leg) => {
    const wx = worldX(leg.lb >>> 0, leg.x);
    const wy = worldY(leg.lb >>> 0, leg.y);
    const lbX = Math.max(0, Math.min(255, Math.floor(wx / 192)));
    const lbY = Math.max(0, Math.min(255, Math.floor(wy / 192)));
    const lx = wx - lbX * 192;
    const ly = wy - lbY * 192;
    const cell = 1 + Math.min(7, Math.max(0, Math.floor(lx / 24))) * 8
                   + Math.min(7, Math.max(0, Math.floor(ly / 24)));
    return { lb: (((lbX << 24) | (lbY << 16) | cell) >>> 0), x: lx, y: ly };
  };

  const corpus = [];
  for (const lb of [0x00070143, 0x00070178, 0xa9b40021, 0x01f80100, 0x0007015f]) {
    for (const x of [-70, -12.5, 0, 33.5, 100.25, 191.9, 250]) {
      for (const y of [-70, -1, 0, 47.5, 191.9, 300]) corpus.push({ lb, x, y, z: 3 });
    }
  }
  let mismatches = 0, firstBad = null;
  for (const leg of corpus) {
    const a = normalizeLegWorldFrame(leg);
    const b = gotoComposeForm(leg);
    if (a.lb !== b.lb || Math.abs(a.x - b.x) > 1e-9 || Math.abs(a.y - b.y) > 1e-9) {
      mismatches += 1;
      if (!firstBad) firstBad = { leg, nav: a, goto: b };
    }
  }
  check(`both leg-frame copies agree across ${corpus.length} legs`,
    mismatches === 0,
    firstBad ? `${mismatches} mismatches, first: ${JSON.stringify(firstBad)}` : "");
}

// ── worldToOutdoorCell itself (the shared primitive) ───────────────────────
{
  const bad = worldToOutdoorCell(-30, -30, 0);
  check("worldToOutdoorCell clamps negative world coords to cell 1",
    validOutdoorCell(bad.lb) && (bad.lb & 0xffff) === 1, hex(bad.lb));
  const ok = worldToOutdoorCell(192 * 3 + 50, 192 * 7 + 100, 0);
  check("worldToOutdoorCell still maps a normal point correctly",
    ((ok.lb >>> 24) & 0xff) === 3 && ((ok.lb >>> 16) & 0xff) === 7 &&
    (ok.lb & 0xffff) === 1 + 2 * 8 + 4,
    hex(ok.lb));
}

console.log("");
console.log(`nav_frame clamp: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

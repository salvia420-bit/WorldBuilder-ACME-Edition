// 2026-11-01 — FAR FORESTS (scene3d/far_forest.js): the flight-experience Phase 2 impostor tier. Region ranging,
// the 20-byte placement record decode (the bake_far_forest.py layout), the atlas layout / view azimuths, the
// flag grammar and the GLSL shape (one program, presence complement on the shared 4x4 dither, range fade).
//
// Run:
//   cd apps/holtburger-web/
//   node tests/far_forest.test.mjs

import { readFileSync } from "node:fs";
import {
  farForestEnabled, regionOf, regionsInRange, decodeRegion, atlasCell, viewAzimuth, farForestRegionStride, FF_VERTEX_GLSL, FF_FRAGMENT_GLSL,
} from "../scene3d/far_forest.js";
import { farForestRangeM } from "../scene3d/altitude_policy.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

console.log("-- F1 flags ----------------------------------------------------------");
check("?farForest: implied by the default-ON ?flightView, =on forces, =off escapes",
  farForestEnabled("") === true && farForestEnabled("?farForest=on") === true && farForestEnabled("?flightView=off") === false
  && farForestEnabled("?flightView=off&farForest=on") === true
  && farForestEnabled("?flightView=on") === true && farForestEnabled("?flightView=on&farForest=off") === false);

console.log("-- F2 regions ----------------------------------------------------------");
check("regionOf: 8x8 landblocks = 1,536 m", JSON.stringify(regionOf(1535, 1536)) === "[0,1]");
{
  const r = regionsInRange(32500, 34600, 4500);
  check("a 4.5 km disc touches ~5x5..7x7 regions", r.length >= 20 && r.length <= 49, String(r.length));
  check("nearest first (the camera's own region leads)", r[0].d === 0 && r[0].rx === Math.floor(32500 / 1536) && r[0].ry === Math.floor(34600 / 1536));
  check("sorted by distance", r.every((x, i) => i === 0 || r[i - 1].d <= x.d));
  check("clamped to the map (no negative region)", regionsInRange(100, 100, 5000).every((x) => x.rx >= 0 && x.ry >= 0));
}

console.log("-- F3 record decode ---------------------------------------------------");
{
  const buf = new ArrayBuffer(40);
  const dv = new DataView(buf);
  const put = (i, x, y, z, s, m, yaw) => { const o = i * 20; dv.setFloat32(o, x, true); dv.setFloat32(o + 4, y, true); dv.setFloat32(o + 8, z, true); dv.setFloat32(o + 12, s, true); dv.setUint8(o + 16, m); dv.setUint8(o + 17, yaw); };
  put(0, 192 * 10 + 5, 192 * 20 + 7, 55.5, 2.0, 3, 64);
  put(1, 192 * 10 + 50, 192 * 20 + 9, 60, 1.0, 0, 0);
  const d = decodeRegion(buf);
  check("two records", d.n === 2);
  check("position + scale + model", d.pos[0] === 1925 && d.pos[2] === 55.5 && d.sy[0] === 2 && d.model[0] === 3);
  check("yaw u8 → radians (64 = π/2)", Math.abs(d.sy[1] - Math.PI / 2) < 1e-6);
  const k = (((10 & 0xff) << 24) | ((20 & 0xff) << 16)) >>> 0;
  check("per-landblock counts (the residency coverage probe)", d.lbCount.get(k) === 2);
}

console.log("-- F4 atlas + views ----------------------------------------------------");
check("8 views per model, 16 cells per row", JSON.stringify(atlasCell(0, 0)) === "[0,0]" && JSON.stringify(atlasCell(1, 7)) === "[15,0]" && JSON.stringify(atlasCell(2, 0)) === "[0,1]");
check("view azimuths: k / 8 of a turn", viewAzimuth(0) === 0 && Math.abs(viewAzimuth(2) - Math.PI / 2) < 1e-9);
check("range: 5.5 km low (<= 150 m), linear ramp to 10 km at 2.5 km AGL",
  farForestRangeM(0) === 5500 && farForestRangeM(150) === 5500 && farForestRangeM(1325) === 7750 && farForestRangeM(2500) === 10000 && farForestRangeM(1e5) === 10000);
check("region stride by distance",
  farForestRegionStride(3000) === 1 && farForestRegionStride(3800) === 1 && farForestRegionStride(5000) === 2
  && farForestRegionStride(7000) === 3 && farForestRegionStride(9000) === 4);

console.log("-- F5 GLSL shape ------------------------------------------------------");
check("vertex: cylindrical card + per-instance view pick + range cull", /vec2 right = vec2\(-dir\.y, dir\.x\)/.test(FF_VERTEX_GLSL) && /iScaleYaw\.y/.test(FF_VERTEX_GLSL) && /uRange\.y/.test(FF_VERTEX_GLSL));
check("fragment: presence complement on the shared Bayer dither", /HB_FF_PRESENCE/.test(FF_FRAGMENT_GLSL) && /1\.0 - texelFetch\(hbLbPresence/.test(FF_FRAGMENT_GLSL) && /hbBayer\[16\]/.test(FF_FRAGMENT_GLSL));
check("fragment: un-premultiplied atlas + alpha test", /t\.rgb \/ max\(t\.a/.test(FF_FRAGMENT_GLSL) && /t\.a < 0\.35/.test(FF_FRAGMENT_GLSL));
check("no backticks inside the GLSL", !FF_VERTEX_GLSL.slice(1).includes("`") && !FF_FRAGMENT_GLSL.slice(1).includes("`"));
check("two nearest views cross-dithered (no 45-degree card flips in a turn): both fetched, picked per pixel",
  /vUv1 =/.test(FF_VERTEX_GLSL) && /vViewF = v - k/.test(FF_VERTEX_GLSL)
  && /texture\(uAtlas, vUv\)/.test(FF_FRAGMENT_GLSL) && /texture\(uAtlas, vUv1\)/.test(FF_FRAGMENT_GLSL) && /< vViewF\) \? tB : tA/.test(FF_FRAGMENT_GLSL));

// --- the impostor bake's surface fetcher (2026-11-02): surfacePixelsFetcher is a FACTORY ---
{
  const src = readFileSync(new URL("../scene3d/far_forest.js", import.meta.url), "utf8");
  check("FF-SRC the bake passes the fetcher instance (surfacePixelsFetcher(wasm)), never the factory, to the material cache",
    /const fetchPixels = surfacePixelsFetcher\(wasm\)/.test(src) && /mc\.get\(sid, fetchPixels\)/.test(src)
      && !/mc\.get\(sid, surfacePixelsFetcher\)/.test(src));
  check("FF-SRC a part whose surface fell back to the grey material is left out of the bake (no grey cards)",
    /src === mc\.fallbackMaterial\) \{ fallbackParts \+= 1; continue; \}/.test(src));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

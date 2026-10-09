// 2026-10-09 — ?alphaMaskSlice (scene3d/adapter.js buildAlphaMaskArrayBytesAsync,
// wired in scene3d/terrain.js): the session-once TexMerge alpha-mask array build
// (273 ms in ONE task on the 1070 academy cold load) runs one layer per task.
// Pins: byte-identical output to the sync build on BOTH paths — the 256² copy
// path and the canvas RESIZE path (the one that costs: putImageData + drawImage
// + getImageData, stubbed here); one yield between layers (depth-1); every
// mask's free() exactly once; one scratch-canvas pair per build; bad input
// rejects like the sync build throws; the terrain.js reader + call site.
//
// Run:
//   cd apps/holtburger-web/
//   node tests/alpha_mask_slice.test.mjs

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { register } from "node:module";
import { existsSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = resolvePath(__dirname, "..");
const STUB_LOADER_PATH = resolvePath(APP, "_three_stub_palette_loader.mjs");
if (!existsSync(STUB_LOADER_PATH)) {
  console.error(`[setup] missing ${STUB_LOADER_PATH}; run test_terrain_palette.mjs once first.`);
  process.exit(2);
}
register(pathToFileURL(STUB_LOADER_PATH).href, import.meta.url);

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

// ── a minimal 2D-canvas stub: nearest-neighbour drawImage, real pixel stores ──
let canvasesMade = 0;
class StubImageData {
  constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
}
function makeCanvas() {
  canvasesMade += 1;
  const cv = { width: 300, height: 150, _px: null };
  const ensure = () => {
    if (!cv._px || cv._px.length !== cv.width * cv.height * 4) cv._px = new Uint8ClampedArray(cv.width * cv.height * 4);
  };
  const ctx = {
    putImageData(img, x, y) {
      ensure();
      for (let r = 0; r < img.height; r++) {
        cv._px.set(img.data.subarray(r * img.width * 4, (r + 1) * img.width * 4), ((y + r) * cv.width + x) * 4);
      }
    },
    clearRect() { ensure(); cv._px.fill(0); },
    drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh) {
      ensure();
      for (let y = 0; y < dh; y++) {
        for (let x = 0; x < dw; x++) {
          const ux = sx + Math.floor((x * sw) / dw), uy = sy + Math.floor((y * sh) / dh);
          const si = (uy * src.width + ux) * 4, di = ((dy + y) * cv.width + dx + x) * 4;
          for (let c = 0; c < 4; c++) cv._px[di + c] = src._px[si + c];
        }
      }
    },
    getImageData(x, y, w, h) {
      ensure();
      const out = new Uint8ClampedArray(w * h * 4);
      for (let r = 0; r < h; r++) out.set(cv._px.subarray(((y + r) * cv.width + x) * 4, ((y + r) * cv.width + x + w) * 4), r * w * 4);
      return new StubImageData(out, w, h);
    },
  };
  cv.getContext = () => ctx;
  return cv;
}
globalThis.ImageData = StubImageData;
globalThis.document = { createElement: (t) => (t === "canvas" ? makeCanvas() : {}) };

const { buildAlphaMaskArrayBytes, buildAlphaMaskArrayBytesAsync } =
  await import(pathToFileURL(resolvePath(APP, "scene3d/adapter.js")).href);

const TILE = 256;
// Masks with a per-texel pattern (so a misplaced or mis-sampled byte shows).
function makeMask(size, seed, frees) {
  const px = new Uint8Array(size * size * 4);
  for (let i = 0; i < px.length; i += 4) {
    const t = (i / 4 + seed * 37) % 251;
    px[i] = t; px[i + 1] = (t * 3) & 255; px[i + 2] = (t * 7) & 255; px[i + 3] = 255;
  }
  const m = { width: size, height: size, pixels: px, free() { frees.set(m, (frees.get(m) || 0) + 1); } };
  return m;
}
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

for (const [label, size] of [["copy path (256²)", 256], ["RESIZE path (64² → 256², the costly one)", 64]]) {
  console.log(`PART — ${label}`);
  const fSync = new Map(), fAsync = new Map();
  const mk = (frees) => [0, 1, 2, 3, 4, 5, 6, 7].map((s) => makeMask(size, s, frees));
  canvasesMade = 0;
  const masksSync = mk(fSync);
  const sync = buildAlphaMaskArrayBytes(masksSync);
  const syncCanvases = canvasesMade;
  canvasesMade = 0;
  const masksAsync = mk(fAsync);
  let yields = 0;
  const layerMs = [];
  const asy = await buildAlphaMaskArrayBytesAsync(masksAsync, {
    yieldFn: async () => { yields += 1; },
    onLayer: (i, ms) => { layerMs[i] = ms; },
  });
  check("byte-identical to the sync build", eq(sync.alphaArrayBytes, asy.alphaArrayBytes));
  check("same tileSize / depth", asy.tileSize === TILE && asy.depth === 8 && sync.depth === 8);
  check("one yield between layers (depth-1 = 7)", yields === 7, `yields=${yields}`);
  check("onLayer reported every layer", layerMs.length === 8 && layerMs.every((v) => v >= 0));
  check("every mask freed exactly once (sync)", masksSync.every((m) => fSync.get(m) === 1));
  check("every mask freed exactly once (sliced)", masksAsync.every((m) => fAsync.get(m) === 1));
  check("scratch canvases: same count as the sync build (one pair or none)",
    canvasesMade === syncCanvases && canvasesMade === (size === TILE ? 0 : 2), `sync=${syncCanvases} sliced=${canvasesMade}`);
  // Placement: layer k's first texel equals the resampled mask k's first texel.
  const stride = TILE * TILE * 4;
  check("layer placement (layer k at k*stride)",
    [0, 1, 2, 3, 4, 5, 6, 7].every((k) => asy.alphaArrayBytes[k * stride] === ((0 + k * 37) % 251)));
}

console.log("PART — default yield + validation");
{
  const frees = new Map();
  const masks = [0, 1].map((s) => makeMask(TILE, s, frees));
  let macro = false;
  setTimeout(() => { macro = true; }, 0);
  const p = buildAlphaMaskArrayBytesAsync(masks);
  check("returns a promise", typeof p.then === "function");
  const r = await p;
  check("default yieldFn is a macrotask (a timer queued earlier ran first)", macro === true && r.depth === 2);
  let rejected = false;
  try { await buildAlphaMaskArrayBytesAsync([]); } catch (_) { rejected = true; }
  check("empty input rejects like the sync build throws", rejected);
  let threw = false;
  try { buildAlphaMaskArrayBytes([]); } catch (_) { threw = true; }
  check("…and the sync build still throws", threw);
}

console.log("PART — terrain.js wiring");
{
  const src = readFileSync(resolvePath(APP, "scene3d/terrain.js"), "utf8");
  check("reader handles off/0/false/no", /get\("alphaMaskSlice"\)[\s\S]{0,200}"off"[\s\S]{0,40}"0"[\s\S]{0,40}"false"[\s\S]{0,40}"no"/.test(src));
  check("the call site awaits the sliced build when on, the sync build when off",
    /readAlphaMaskSliceFlag\(\)[\s\S]{0,300}await buildAlphaMaskArrayBytesAsync\(ordered[\s\S]{0,200}: buildAlphaMaskArrayBytes\(ordered\)/.test(src));
  check("diag __alphaMaskSliceStats published", /__alphaMaskSliceStats = sliceStats/.test(src));
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

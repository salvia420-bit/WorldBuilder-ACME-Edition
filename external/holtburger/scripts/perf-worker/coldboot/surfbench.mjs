// surfbench.mjs — decode every interior surface (cell surfaces + the cell statics' surfaces) of a set of
// landblocks with ONE pkg build in node, against a running serve.py, and write a hash of every plane.
// Two builds' outputs must match byte for byte; the decode-only time is the CPU a bake worker spends.
//   node surfbench.mjs <pkgDir> <out.json> [lbHex,...]        (WASM=<file> swaps in e.g. a named build)
//   python3 -c "import json;a=json.load(open('A.json'))['surfaces'];b=json.load(open('B.json'))['surfaces'];print(sum(a[k]!=b.get(k) for k in a))"
// Default landblocks: the four academies, the Town Network, 0x0125. 2026-10-09: 313 surfaces / 13.7 Mpx,
// decode-only 8,969 ms (wasmrev-20261009e) → 3,212 ms (…f), identical hashes. Profile: node --cpu-prof.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const [PKG, OUT] = process.argv.slice(2, 4);
if (!PKG || !OUT) { console.error("usage: node surfbench.mjs <pkgDir> <out.json> [lbHex,...]"); process.exit(2); }
const LBS = (process.argv[4] || "0x86020000,0x7F030000,0x8C040000,0x72020000,0x00070000,0x01250000").split(",").map((s) => parseInt(s, 16) >>> 0);
const BASE = process.env.HB_BASE || "http://127.0.0.1:8765";
globalThis.self = globalThis;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => { let u = typeof input === "string" ? input : input.url; if (u.startsWith("/")) u = BASE + u; return realFetch(u, init); };
const ns = await import(pathToFileURL(PKG + "/holtburger_web.js").href);
await ns.default({ module_or_path: readFileSync(process.env.WASM || PKG + "/holtburger_web_bg.wasm") });
ns.seed_url_flag_search?.("");
await ns.init_resource_source(BASE + "/dist/manifest.json");
const h = (u8) => createHash("sha256").update(u8).digest("hex").slice(0, 24);
const all = new Set(); const perLb = {};
for (const lb of LBS) {
  try {
    const deps = JSON.parse(await ns.fetchEnvCellDepsInLandblock(lb));
    const ds = new Set(deps.cellSurfaceDids.map((d) => d >>> 0));
    if (deps.stabIds.length) {
      const meshes = await ns.fetch_model_meshes(new Uint32Array(deps.stabIds), true);
      for (const m of meshes) { if (m && m.triCount > 0) for (const d of m.surfaces) ds.add(d >>> 0); try { m?.free?.(); } catch (_) {} }
    }
    perLb[lb.toString(16)] = { cells: deps.numCells, surfaces: ds.size };
    for (const d of ds) all.add(d);
  } catch (e) { perLb[lb.toString(16)] = { error: String(e) }; }
}
const dids = [...all].sort((a, b) => a - b);
// First pass fetches the records (network); the timed pass decodes from the record cache only.
let sp = await ns.fetch_surfaces_pixels(new Uint32Array(dids), true);
for (const s of sp) { try { s?.free?.(); } catch (_) {} }
ns.surface_cache_clear();
const t0 = performance.now();
sp = await ns.fetch_surfaces_pixels(new Uint32Array(dids), true);
const decodeMs = Math.round(performance.now() - t0);
const out = {}; let px = 0;
for (let i = 0; i < dids.length; i++) {
  const s = sp[i]; if (!s) { out[dids[i].toString(16)] = null; continue; }
  px += s.width * s.height;
  out[dids[i].toString(16)] = [s.width, s.height, s.category, s.surfaceType ?? null, s.hasPalette, s.luminosity, s.diffuse,
    String(s.normalScaleOverride), h(s.pixels), h(s.normalPixels), h(s.heightPixels), s.normalPixels.length, s.heightPixels.length].join("|");
  try { s.free(); } catch (_) {}
}
const sum = { perLb, n: dids.length, mpx: +(px / 1e6).toFixed(2), decodeMs };
writeFileSync(OUT, JSON.stringify({ ...sum, surfaces: out }));
console.log(JSON.stringify(sum));
process.exit(0);

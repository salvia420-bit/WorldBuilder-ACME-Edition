// Bundle-size measurement for the 3D port (follow-on #12 in
// docs/3d-port-state-2026-05-10.md). Plan target: < 1 MB gzipped for
// the 3D production bundle (wasm + wasm-bindgen glue + scene3d/*).
// three.js and PIXI are loaded from CDN at runtime so they're tracked
// here for context but not part of the "production bundle" total.
//
// Usage: node apps/holtburger-web/measure_bundle_size.cjs
//
// All sizes are produced by piping the source through `gzip -9 -c` and
// counting bytes via `wc -c`. No estimates. CDN libs are cached at
// /tmp/holtburger-bundle-measure/ — if a file is missing we download
// it once with curl. The fetch is idempotent and only runs on first
// invocation; subsequent runs reuse the cache.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const CACHE_DIR = "/tmp/holtburger-bundle-measure";
const CDN_FILES = [
    {
        name: "three.module.js",
        url: "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.module.js",
        label: "three.js core (r184)",
    },
    {
        name: "OrbitControls.js",
        url: "https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/controls/OrbitControls.js",
        label: "three.js OrbitControls",
    },
    {
        name: "PointerLockControls.js",
        url: "https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/controls/PointerLockControls.js",
        label: "three.js PointerLockControls",
    },
    {
        name: "pixi.min.mjs",
        url: "https://cdn.jsdelivr.net/npm/pixi.js@8.18.1/dist/pixi.min.mjs",
        label: "PIXI.js v8.18.1 (minified)",
    },
];

function ensureCdnCache() {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    for (const f of CDN_FILES) {
        const out = path.join(CACHE_DIR, f.name);
        if (!fs.existsSync(out)) {
            console.log(`fetching ${f.name} from CDN…`);
            execSync(`curl -sL "${f.url}" -o "${out}"`);
        }
    }
}

function gzipSize(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const out = execSync(`gzip -9 -c "${filePath}" | wc -c`).toString().trim();
    return parseInt(out, 10);
}

function rawSize(filePath) {
    if (!fs.existsSync(filePath)) return null;
    return fs.statSync(filePath).size;
}

function fmt(bytes) {
    if (bytes == null) return "MISSING";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1_048_576).toFixed(2)} MB`;
}

function padR(s, n) {
    s = String(s);
    return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function padL(s, n) {
    s = String(s);
    return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

function row(label, raw, gz) {
    return `  ${padR(label, 42)}${padL(fmt(raw), 12)}${padL(fmt(gz), 12)}`;
}

ensureCdnCache();

const HERE = __dirname;
const wasmPath = path.join(HERE, "pkg/holtburger_web_bg.wasm");
const wasmJsPath = path.join(HERE, "pkg/holtburger_web.js");
const scene3dDir = path.join(HERE, "scene3d");

const wasmRaw = rawSize(wasmPath);
const wasmGz = gzipSize(wasmPath);
const wasmJsRaw = rawSize(wasmJsPath);
const wasmJsGz = gzipSize(wasmJsPath);

// scene3d/*.js — per-file breakdown then total
const scene3dFiles = fs
    .readdirSync(scene3dDir)
    .filter((f) => f.endsWith(".js"))
    .sort();
let scene3dRawTotal = 0;
let scene3dGzTotal = 0;
const scene3dRows = [];
for (const f of scene3dFiles) {
    const fp = path.join(scene3dDir, f);
    const r = rawSize(fp);
    const g = gzipSize(fp);
    scene3dRawTotal += r;
    scene3dGzTotal += g;
    scene3dRows.push({ name: f, raw: r, gz: g });
}

// CDN libs
const threeCorePath = path.join(CACHE_DIR, "three.module.js");
const orbitPath = path.join(CACHE_DIR, "OrbitControls.js");
const pointerLockPath = path.join(CACHE_DIR, "PointerLockControls.js");
const pixiPath = path.join(CACHE_DIR, "pixi.min.mjs");

const threeCoreGz = gzipSize(threeCorePath);
const threeCoreRaw = rawSize(threeCorePath);
const orbitGz = gzipSize(orbitPath);
const orbitRaw = rawSize(orbitPath);
const pointerLockGz = gzipSize(pointerLockPath);
const pointerLockRaw = rawSize(pointerLockPath);
const pixiGz = gzipSize(pixiPath);
const pixiRaw = rawSize(pixiPath);

const threeAddonsGz = orbitGz + pointerLockGz;
const threeAddonsRaw = orbitRaw + pointerLockRaw;
const threeTotalGz = threeCoreGz + threeAddonsGz;
const threeTotalRaw = threeCoreRaw + threeAddonsRaw;

// Totals
// 2D-only: wasm + wasm-bindgen + PIXI
const twoDGz = wasmGz + wasmJsGz + pixiGz;
const twoDRaw = wasmRaw + wasmJsRaw + pixiRaw;
// 3D-only: wasm + wasm-bindgen + three + scene3d/*
const threeDGz = wasmGz + wasmJsGz + threeTotalGz + scene3dGzTotal;
const threeDRaw = wasmRaw + wasmJsRaw + threeTotalRaw + scene3dRawTotal;
// Combined: wasm + wasm-bindgen + PIXI + three + scene3d/*
const combinedGz = wasmGz + wasmJsGz + pixiGz + threeTotalGz + scene3dGzTotal;
const combinedRaw = wasmRaw + wasmJsRaw + pixiRaw + threeTotalRaw + scene3dRawTotal;
// Production-bundled (the part we actually ship — three.js + PIXI come from CDN)
const productionBundleGz = wasmGz + wasmJsGz + scene3dGzTotal;
const productionBundleRaw = wasmRaw + wasmJsRaw + scene3dRawTotal;

const ONE_MB = 1_000_000;

console.log("");
console.log("holtburger-web bundle-size measurement (gzip -9 -c | wc -c)");
console.log("============================================================");
console.log(`  ${padR("component", 42)}${padL("raw", 12)}${padL("gzipped", 12)}`);
console.log(`  ${"-".repeat(42)}${" "}${"-".repeat(11)}${" "}${"-".repeat(11)}`);
console.log("");
console.log("  --- wasm core ---");
console.log(row("pkg/holtburger_web_bg.wasm", wasmRaw, wasmGz));
console.log(row("pkg/holtburger_web.js (wasm-bindgen)", wasmJsRaw, wasmJsGz));
console.log("");
console.log("  --- scene3d/* (3D path only) ---");
for (const r of scene3dRows) {
    console.log(row(`scene3d/${r.name}`, r.raw, r.gz));
}
console.log(row("scene3d/* SUBTOTAL", scene3dRawTotal, scene3dGzTotal));
console.log("");
console.log("  --- three.js (CDN; 3D path only) ---");
console.log(row("three.module.js (core, r184)", threeCoreRaw, threeCoreGz));
console.log(row("OrbitControls.js", orbitRaw, orbitGz));
console.log(row("PointerLockControls.js", pointerLockRaw, pointerLockGz));
console.log(row("three.js SUBTOTAL", threeTotalRaw, threeTotalGz));
console.log("");
console.log("  --- PIXI.js (CDN; 2D path only) ---");
console.log(row("pixi.min.mjs (v8.18.1)", pixiRaw, pixiGz));
console.log("");
console.log("============================================================");
console.log("  TOTALS");
console.log("============================================================");
console.log(row("2D path (wasm + wasmJs + PIXI)", twoDRaw, twoDGz));
console.log(row("3D path (wasm + wasmJs + three + scene3d)", threeDRaw, threeDGz));
console.log(row("Combined (both renderers loaded)", combinedRaw, combinedGz));
console.log(row("Production bundle (wasm+wasmJs+scene3d)", productionBundleRaw, productionBundleGz));
console.log("");
console.log("============================================================");
console.log("  Plan target: 3D production bundle < 1 MB gzipped");
console.log("============================================================");
const passProduction = productionBundleGz < ONE_MB;
const pass3D = threeDGz < ONE_MB;
console.log(`  Production bundle gz: ${fmt(productionBundleGz)} (${productionBundleGz} bytes)`);
console.log(`  3D path total gz:     ${fmt(threeDGz)} (${threeDGz} bytes)`);
console.log(`  1 MB target:          ${fmt(ONE_MB)} (${ONE_MB} bytes)`);
console.log("");
if (passProduction) {
    console.log(`  PASS: production bundle is ${fmt(ONE_MB - productionBundleGz)} under 1 MB.`);
} else {
    console.log(`  FAIL: production bundle is ${fmt(productionBundleGz - ONE_MB)} OVER the 1 MB target.`);
    console.log("");
    console.log("  Largest contributor: pkg/holtburger_web_bg.wasm");
    console.log(`    wasm gz: ${fmt(wasmGz)} = ${((wasmGz / productionBundleGz) * 100).toFixed(1)}% of the bundle`);
    console.log("");
    console.log("  Follow-on options to land under 1 MB:");
    console.log("    1. Split the wasm: move dat-parsing (the bulk of holtburger_dat::file_type::*)");
    console.log("       behind a lazy-loaded dynamic-import wasm chunk. The login + first-frame");
    console.log("       hot path only needs ~10% of those parsers. Estimated saving: 1.0-1.5 MB gz.");
    console.log("    2. Enable wasm-opt -Oz on the release build (currently wasm-pack uses default -O).");
    console.log("       Estimated saving: 5-15% of wasm gz size.");
    console.log("    3. Audit Rust dependencies — `image`, `flate2`, `pathfinder_geometry`, etc.");
    console.log("       Removing unused features in Cargo.toml can shave 100-300 KB gz.");
    console.log("    4. Brotli compression instead of gzip — typically saves another 15-20% on wasm.");
    console.log("       Requires server-side change (Content-Encoding: br) but no code change.");
    console.log("");
    console.log("  scene3d/* on its own is only " + fmt(scene3dGzTotal) + " gz; three.js + addons");
    console.log("  is only " + fmt(threeTotalGz) + " gz. Both are well under budget. The wasm");
    console.log("  binary at " + fmt(wasmGz) + " is the single dominant contributor.");
}
console.log("");

// Exit code mirrors the smoke check — 0 if production bundle is under
// 1 MB, 1 otherwise. Callers can use this in CI.
process.exit(passProduction ? 0 : 1);

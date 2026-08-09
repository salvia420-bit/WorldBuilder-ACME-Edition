// harness/test_service_worker_v3.mjs — T12 (ST2): the DORMANT SW v3 split.
//
// Loads the REAL service-worker.js into a vm sandbox twice — once as
// shipped (`SW_V3 = false`) and once with the constant flipped (the
// orchestrator's ST2 default-flip edit) — and asserts:
//   * shipped arm: v2 behavior exactly (shards content-addressed,
//     boot.hba/catalogs bake-versioned, cache name -v2) — the OFF-arm
//     byte-identity leg;
//   * flipped arm: packs/ + index/ + shards/ content-addressed (shards
//     allowlisted until ST10, F-11.11), NOTHING bake-versioned (the gate
//     unreachable), cache name -v3, manifest.json/HTML/JS/wasm never
//     cacheable, /scene3d/assets/ SWR kept.
//
// Run: node harness/test_service_worker_v3.mjs

import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SW_PATH = path.join(HERE, "..", "service-worker.js");
const ORIGIN = "https://holt.test";

let passed = 0;
let failed = 0;
const ok = (cond, label) => {
  if (cond) { passed += 1; }
  else { failed += 1; console.error(`  FAIL ${label}`); }
};

function loadSw(source) {
  const self = { addEventListener: () => {}, location: { href: `${ORIGIN}/apps/holtburger-web/service-worker.js` } };
  const ctx = vm.createContext({
    self, URL, console, Map, Promise, Response: class {}, Request: class {}, fetch: async () => ({}),
    caches: { open: async () => null, keys: async () => [], delete: async () => true },
    setTimeout, clearTimeout,
  });
  vm.runInContext(source, ctx, { filename: "service-worker.js" });
  return self.__swTestHooks;
}

const src = readFileSync(SW_PATH, "utf8");
ok(/const SW_V3 = false;/.test(src), "shipped source carries SW_V3 = false (DORMANT — orchestrator flips at the ST2 default flip)");

const u = (p) => new URL(p, `${ORIGIN}/dist/`);

// ── arm 1: as shipped (v2 behavior byte-identical) ─────────────────────────
{
  const h = loadSw(src);
  ok(h && h.SW_V3 === false, "hooks exported, SW_V3 false");
  ok(h.CONTENT_CACHE === "holtburger-content-v2", "cache name stays v2");
  ok(h.isContentAddressed(u("shards/ab/cafe.bin")) === true, "v2: shards content-addressed");
  ok(h.isContentAddressed(u("packs/ab/cafe.hbp")) === false, "v2: packs NOT intercepted (dormant)");
  ok(h.isContentAddressed(u("index/cafe.bin")) === false, "v2: index NOT intercepted (dormant)");
  ok(h.isBakeVersioned(u("boot.hba")) === true, "v2: boot.hba bake-versioned (gate intact)");
  ok(h.isBakeVersioned(u("manifest/eor-cell.bin")) === true, "v2: catalogs bake-versioned (gate intact)");
  ok(h.isCacheable(u("manifest.json")) === false, "v2: manifest.json never cacheable");
  ok(h.isSwrCacheable(new URL(`${ORIGIN}/apps/holtburger-web/scene3d/assets/terrain_macro/m.png`)) === true, "v2: scene3d/assets SWR");
}

// ── arm 2: the ST2 flip (SW_V3 = true) ─────────────────────────────────────
{
  const flipped = src.replace("const SW_V3 = false;", "const SW_V3 = true;");
  ok(flipped !== src, "flip edit applies");
  const h = loadSw(flipped);
  ok(h.SW_V3 === true, "flipped arm reads v3");
  ok(h.CONTENT_CACHE === "holtburger-content-v3", "v3 cache name (activate GC purges v2 by prefix)");
  ok(h.isContentAddressed(u("packs/ab/cafe.hbp")) === true, "v3: packs/ CAS intercepted");
  ok(h.isContentAddressed(u("index/cafe.bin")) === true, "v3: index/ CAS intercepted");
  ok(h.isContentAddressed(u("shards/ab/cafe.bin")) === true, "v3: shards/ allowlisted until ST10 (F-11.11)");
  ok(h.isBakeVersioned(u("boot.hba")) === false, "v3: boot.hba NOT intercepted (gate unreachable)");
  ok(h.isBakeVersioned(u("manifest/eor-cell.bin")) === false, "v3: catalogs NOT intercepted");
  ok(h.isCacheable(u("boot.hba")) === false, "v3: boot.hba not cacheable at all");
  ok(h.isCacheable(u("manifest.json")) === false, "v3: manifest.json never cacheable");
  ok(h.isCacheable(new URL(`${ORIGIN}/apps/holtburger-web/index.html`)) === false, "v3: HTML never cacheable");
  ok(h.isCacheable(new URL(`${ORIGIN}/apps/holtburger-web/scene3d/index.js`)) === false, "v3: JS never cacheable");
  ok(h.isCacheable(new URL(`${ORIGIN}/apps/holtburger-web/pkg/holtburger_web_bg.wasm`)) === false, "v3: wasm never cacheable");
  // `/index/` must not swallow index.html.
  ok(h.isContentAddressed(new URL(`${ORIGIN}/apps/holtburger-web/index.html`)) === false, "v3: /index/ does not match index.html");
  ok(h.isSwrCacheable(new URL(`${ORIGIN}/apps/holtburger-web/scene3d/assets/clouds/n.bin`)) === true, "v3: scene3d/assets SWR kept");
}

console.log(`\n${passed} passed, ${failed} failed  SW-V3-DORMANT ${failed ? "❌" : "✅"}`);
process.exit(failed ? 1 : 0);

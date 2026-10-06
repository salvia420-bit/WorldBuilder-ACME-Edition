// test_plugin_manifest_parallel.mjs — plugins/loader.js fetchManifestIndex.
//
// 2026-10-06: the per-plugin manifest fetches run CONCURRENTLY (they used to be
// ~49 sequential round-trips on the boot path). What must hold:
//   - every manifest request is in flight before the first one resolves;
//   - entries come back in DESCRIPTOR order regardless of completion order
//     (plugin load order is unchanged);
//   - skipped reasons (bad descriptor, HTTP error, network error) are reported
//     in descriptor order too, and never abort the siblings;
//   - module paths resolve exactly as before (descriptor `entry` wins, else the
//     manifest's `entry` relative to the manifest URL).
//
// Run: cd apps/holtburger-web && node test_plugin_manifest_parallel.mjs
import { fetchManifestIndex, bundledPluginLoader, loadPlugins } from "./plugins/loader.js";

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${ok || !detail ? "" : " — " + detail}`);
  ok ? passed++ : failed++;
}

const BASE = "http://game.test/apps/holtburger-web/plugins/";
const index = [
  { manifestPath: "a.manifest.json" },
  { manifestPath: "b.manifest.json", entry: "b-entry.js" },
  { nope: true },
  { manifestPath: "c.manifest.json" },
  { manifestPath: "gone.manifest.json" },
  { manifestPath: "boom.manifest.json" },
  { manifestPath: "d.manifest.json" },
];
// Later descriptors resolve FIRST (reverse delays) to prove order is by index.
const delay = { a: 60, b: 50, c: 30, d: 5, gone: 10, boom: 20 };
let inFlight = 0, maxInFlight = 0, firstResolvedAt = null, startedBeforeFirstResolve = 0;
const fetchStub = async (url) => {
  url = String(url);
  if (url.endsWith("index.json")) return { ok: true, status: 200, json: async () => index };
  const id = url.split("/").pop().replace(".manifest.json", "");
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  if (firstResolvedAt === null) startedBeforeFirstResolve += 1;
  await new Promise((r) => setTimeout(r, delay[id] ?? 1));
  inFlight -= 1;
  if (firstResolvedAt === null) firstResolvedAt = Date.now();
  if (id === "gone") return { ok: false, status: 404 };
  if (id === "boom") throw new Error("network down");
  return { ok: true, status: 200, json: async () => ({ id, name: id.toUpperCase(), version: "1.0.0", entry: `${id}.js` }) };
};

const { entries, skipped } = await fetchManifestIndex({ indexUrl: `${BASE}index.json`, fetch: fetchStub, probeDev: false });
check("all 6 manifest requests were in flight together", maxInFlight === 6, String(maxInFlight));
check("…every one started before the first resolved", startedBeforeFirstResolve === 6, String(startedBeforeFirstResolve));
check("entries in DESCRIPTOR order (a, b, c, d) despite reverse completion",
  entries.map((e) => e.manifest.id).join(",") === "a,b,c,d", entries.map((e) => e.manifest.id).join(","));
check("descriptor `entry` wins for b", entries[1].modulePath === `${BASE}b-entry.js`, entries[1].modulePath);
check("manifest `entry` resolves relative to the manifest URL for a", entries[0].modulePath === `${BASE}a.js`);
check("dev sidecar not probed when probeDev is false", entries.every((e) => e.dev === null));
check("3 skips, in descriptor order: bad descriptor, 404, network error",
  skipped.length === 3 && /missing manifestPath/.test(skipped[0].reason)
  && /gone\.manifest\.json: HTTP 404/.test(skipped[1].reason)
  && /boom\.manifest\.json: network down/.test(skipped[2].reason),
  JSON.stringify(skipped));

// ── T11-D4: the bundled-plugin registry lookup ──────────────────────────────
{
  const BASE_PAGE = "http://game.test/apps/holtburger-web/index.html?autoLogin=1";
  const book = () => Promise.resolve({ marker: "bundled-book" });
  const reg = { "plugins/book-panel.js": book };
  check("registry hit for an absolute modulePath under the page dir",
    bundledPluginLoader("http://game.test/apps/holtburger-web/plugins/book-panel.js", { registry: reg, baseUrl: BASE_PAGE }) === book);
  check("query/hash stripped before lookup",
    bundledPluginLoader("http://game.test/apps/holtburger-web/plugins/book-panel.js?v=2#x", { registry: reg, baseUrl: BASE_PAGE }) === book);
  check("unknown plugin ⇒ null (plain import fallback)",
    bundledPluginLoader("http://game.test/apps/holtburger-web/plugins/nope.js", { registry: reg, baseUrl: BASE_PAGE }) === null);
  check("outside the page dir ⇒ null",
    bundledPluginLoader("http://other.test/plugins/book-panel.js", { registry: reg, baseUrl: BASE_PAGE }) === null);
  check("no registry (unbundled page) ⇒ null",
    bundledPluginLoader("http://game.test/apps/holtburger-web/plugins/book-panel.js", { registry: null, baseUrl: BASE_PAGE }) === null);

  // loadPlugins uses the registry instead of importing the URL.
  globalThis.__hbBundledPlugins = { "plugins/book-panel.js": () => Promise.resolve({ onLoad() { globalThis.__bookLoaded = "bundled"; } }) };
  globalThis.location = { href: BASE_PAGE };
  const res = await loadPlugins({ entries: [{ manifest: { id: "book-panel", name: "Book", version: "1.0.0" },
    modulePath: "http://game.test/apps/holtburger-web/plugins/book-panel.js" }], log: () => {} });
  check("loadPlugins resolved the plugin from the bundle (no network import)",
    globalThis.__bookLoaded === "bundled" && (res.loaded?.has?.("book-panel") ?? true), JSON.stringify(res.skipped ?? []));
  delete globalThis.__hbBundledPlugins;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

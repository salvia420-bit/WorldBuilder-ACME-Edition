// Standalone icon decode probe — does `wasm.fetch_surface_pixels` decode
// real AC icon DIDs into non-zero pixels? Confirms JPEG-path works
// end-to-end (independent of inventory wire state).

const fs = require("node:fs");
const path = require("node:path");
const PLAYWRIGHT_CACHE = "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules";
let chromium;
try { ({ chromium } = require("playwright")); }
catch (_) { ({ chromium } = require(path.join(PLAYWRIGHT_CACHE, "playwright"))); }

const PAGE_URL = "http://127.0.0.1:7080/apps/holtburger-web/index.html"
  + "?renderer=3d&wireframe=1"
  + "&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&kickDance=1";

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--no-sandbox", "--use-gl=angle",
           "--enable-webgl", "--ignore-gpu-blocklist"],
  });
  const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__bootState === "ready", { timeout: 120_000, polling: 500 });

  const result = await page.evaluate(async () => {
    const sources = {
      __hbWasm: window.__hbWasm,
      __wasm: window.__wasm,
      em_wasmExports: window.liveScene3d?.entityManager?.wasmExports,
    };
    const inv = {};
    for (const [k, v] of Object.entries(sources)) {
      if (!v) { inv[k] = "absent"; continue; }
      inv[k] = {
        hasFetchIcon: typeof v.fetch_icon_pixels === "function",
        hasFetchSurface: typeof v.fetch_surface_pixels === "function",
        keysSample: Object.keys(v).filter(n => /^fetch/.test(n)).slice(0, 8),
      };
    }
    const wasm = sources.__hbWasm ?? sources.__wasm ?? sources.em_wasmExports ?? null;
    if (!wasm) return { error: "no wasm exports", inv };
    const exports = ["fetch_icon_pixels", "fetch_surface_pixels"].filter(n => typeof wasm[n] === "function");
    // Real iconIds from Tester's inventory (per `playerInventory()`).
    const ids = [0x600170c, 0x6000ff5, 0x6000fed, 0x6001703, 0x6004d8d, 0x600103f,
                 0x60023e2, 0x6000fbb, 0x6002265, 0x6006a96, 0x600106f, 0x6006495,
                 0x600229f, 0x6001a82, 0x60026ba];
    const probes = [];
    for (const id of ids) {
      const perId = { did: "0x" + id.toString(16).padStart(8, "0") };
      for (const name of exports) {
        try {
          const r = await wasm[name](id >>> 0);
          perId[name] = {
            ok: !!(r && r.width && r.height && r.pixels?.length),
            width: r?.width ?? null, height: r?.height ?? null,
            pxLen: r?.pixels?.length ?? null,
            sample: r?.pixels ? Array.from(r.pixels.slice(0, 8)) : null,
          };
          if (r?.free) try { r.free(); } catch (_) {}
        } catch (e) {
          perId[name] = { ok: false, error: String(e).slice(0, 100) };
        }
      }
      probes.push(perId);
    }
    return { inv, exports, probes };
  });
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})().catch((e) => { console.error("FAIL", e); process.exit(1); });

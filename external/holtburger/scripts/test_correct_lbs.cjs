const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");

async function main() {
  const browser = await chromium.launch({
    args: ["--use-gl=swiftshader", "--no-sandbox"],
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1024 } });
    page.on("console", msg => console.log("[PAGE]", msg.text()));

    const url = "http://127.0.0.1:8765/apps/holtburger-web/index.html?renderer=3d&quality=high&gfxRelief=on&reliefBundles=on&atmosphere=off";
    console.log("Loading page:", url);
    await page.goto(url, { waitUntil: "domcontentloaded" });

    await page.waitForFunction(() => {
      const r = document.getElementById("results");
      return r && /PASS/.test(r.innerHTML);
    }, { timeout: 30000 });
    console.log("PASS observed.");

    const towns = [
      { name: "Holtburg", lbX: 169, lbY: 180, hex: "0xA9B4" },
      { name: "Sanamar", lbX: 51, lbY: 217, hex: "0x33D9" },
      { name: "Al-Jalima", lbX: 133, lbY: 136, hex: "0x8588" },
      { name: "Neydisa Castle", lbX: 149, lbY: 214, hex: "0x95D6" },
      { name: "Bandit Castle", lbX: 189, lbY: 208, hex: "0xBDD0" },
    ];

    const results = await page.evaluate(async (townList) => {
      const wasm = window.__hbSceneWasm;
      const canvas = document.getElementById("scene") || document.querySelector("canvas");
      const scene3d = await import("./scene3d/index.js");
      const buildingsMod = await import("./scene3d/buildings.js");

      const mockSession = {
        isCurrentCellIndoor() { return false; },
        getCurrentCellId() { return 0; },
        getRenderSet() { return new Uint32Array(0); },
        setMovementInput() {},
        pollEntityUpdates() { return []; },
      };
      const live = await scene3d.init3D(canvas, mockSession, wasm);

      const out = [];
      for (const t of townList) {
        const lbKey = (((t.lbX & 0xff) << 24) | ((t.lbY & 0xff) << 16)) >>> 0;
        if (live.landblockLru) {
          live.landblockLru._serverLbKey = lbKey;
        }

        console.log(`Baking ${t.name} (${t.hex}: ${t.lbX}, ${t.lbY})...`);
        const t0 = performance.now();
        let bakeRes = null;
        let err = null;
        try {
          // 15s timeout race
          bakeRes = await Promise.race([
            buildingsMod.bakeBuildingsForLandblock(live, t.lbX, t.lbY, null, wasm),
            new Promise((_, rej) => setTimeout(() => rej(new Error("Timeout after 15s")), 15000))
          ]);
        } catch (e) {
          err = e.message;
        }
        const dt = Math.round(performance.now() - t0);

        let meshCount = 0;
        let pomMeshCount = 0;
        let stoneCount = 0;
        const pomMeshes = [];
        live.buildingsGroup.traverse((o) => {
          if (!o.isMesh) return;
          meshCount++;
          const cat = o.material?.userData?.surfaceCategory;
          if (cat === 0 || cat === 10 || cat === 11) stoneCount++;
          if (o.material?.userData?.pomEnabled === true) {
            pomMeshCount++;
            if (pomMeshes.length < 3) {
              pomMeshes.push({
                name: o.name,
                cat,
                ao: o.material?.userData?.creviceAoEnabled,
                shadow: o.material?.userData?.microShadowEnabled,
              });
            }
          }
        });

        out.push({
          town: t.name,
          hex: t.hex,
          bakeRes,
          err,
          timeMs: dt,
          meshCount,
          pomMeshCount,
          stoneCount,
          pomMeshes,
        });
      }
      return out;
    }, towns);

    console.log("Town Bake Results:\n", JSON.stringify(results, null, 2));

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});

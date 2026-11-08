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

    for (const t of towns) {
      console.log(`\n========================================`);
      console.log(`Starting bake for ${t.name} (${t.hex}: ${t.lbX}, ${t.lbY})`);
      console.log(`========================================`);

      const t0 = Date.now();
      const townRes = await page.evaluate(async (town) => {
        const wasm = window.__hbSceneWasm;
        const canvas = document.getElementById("scene") || document.querySelector("canvas");
        const scene3d = await import("./scene3d/index.js");
        const buildingsMod = await import("./scene3d/buildings.js");

        if (!window.__testLive) {
          const mockSession = {
            isCurrentCellIndoor() { return false; },
            getCurrentCellId() { return 0; },
            getRenderSet() { return new Uint32Array(0); },
            setMovementInput() {},
            pollEntityUpdates() { return []; },
          };
          window.__testLive = await scene3d.init3D(canvas, mockSession, wasm);
        }
        const live = window.__testLive;

        // Clear buildings group completely for clean town isolation
        while (live.buildingsGroup.children.length > 0) {
          const child = live.buildingsGroup.children[0];
          live.buildingsGroup.remove(child);
        }

        const lbKey = (((town.lbX & 0xff) << 24) | ((town.lbY & 0xff) << 16)) >>> 0;
        if (live.landblockLru) {
          live.landblockLru._serverLbKey = lbKey;
        }

        const bakePromise = buildingsMod.bakeBuildingsForLandblock(live, town.lbX, town.lbY, null, wasm);
        const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error("Timeout after 45s")), 45000));
        
        let bakeRes = null;
        let err = null;
        try {
          bakeRes = await Promise.race([bakePromise, timeoutPromise]);
        } catch (e) {
          err = e.message;
        }

        let meshCount = 0;
        let pomMeshCount = 0;
        let stoneCount = 0;
        const meshes = [];
        live.buildingsGroup.traverse((o) => {
          if (!o.isMesh) return;
          meshCount++;
          const cat = o.material?.userData?.surfaceCategory;
          if (cat === 0 || cat === 10 || cat === 11) stoneCount++;
          const pom = o.material?.userData?.pomEnabled === true;
          if (pom) {
            pomMeshCount++;
            if (meshes.length < 5) {
              meshes.push({
                name: o.name,
                cat,
                ao: o.material?.userData?.creviceAoEnabled,
                microShadow: o.material?.userData?.microShadowEnabled,
                pomSteps: o.material?.userData?.pomUniforms?.steps,
              });
            }
          }
        });

        return {
          town: town.name,
          hex: town.hex,
          bakeRes,
          err,
          meshCount,
          pomMeshCount,
          stoneCount,
          sampleMeshes: meshes,
        };
      }, t);

      console.log(`Town ${t.name} result in ${Date.now() - t0}ms:`, JSON.stringify(townRes, null, 2));
    }

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});

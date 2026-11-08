const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");

async function main() {
  const browser = await chromium.launch({
    args: ["--use-gl=swiftshader", "--no-sandbox"],
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1024 } });
    page.on("console", msg => console.log("[PAGE LOG]", msg.text()));

    const url = "http://127.0.0.1:8765/apps/holtburger-web/index.html?renderer=3d&quality=high&gfxRelief=on&reliefBundles=on";
    console.log("Navigating to:", url);
    await page.goto(url, { waitUntil: "domcontentloaded" });

    await page.waitForFunction(() => {
      const r = document.getElementById("results");
      return r && /PASS/.test(r.innerHTML);
    }, { timeout: 30000 });
    console.log("Smoke test PASS observed.");

    const towns = [
      { name: "Holtburg", lbX: 169, lbY: 180 },
      { name: "Sanamar", lbX: 50, lbY: 217 },
      { name: "Al-Jalima", lbX: 133, lbY: 136 },
      { name: "Neydisa Castle", lbX: 149, lbY: 214 },
      { name: "Bandit Castle", lbX: 189, lbY: 210 },
    ];

    for (const town of towns) {
      console.log(`\n--- Starting bake for ${town.name} (${town.lbX}, ${town.lbY}) ---`);
      const t0 = Date.now();
      const res = await page.evaluate(async (t) => {
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

        // Clear previous buildings to avoid accumulating geometry
        while (live.buildingsGroup.children.length > 0) {
          const child = live.buildingsGroup.children[0];
          live.buildingsGroup.remove(child);
        }

        console.log(`Calling bakeBuildingsForLandblock for ${t.name}...`);
        const bakeRes = await buildingsMod.bakeBuildingsForLandblock(
          live,
          t.lbX,
          t.lbY,
          null,
          wasm
        );

        let meshCount = 0;
        let pomMeshCount = 0;
        const meshes = [];
        live.buildingsGroup.traverse((o) => {
          if (!o.isMesh) return;
          meshCount++;
          const pom = o.material?.userData?.pomEnabled === true;
          if (pom) pomMeshCount++;
          if (meshes.length < 5) {
            meshes.push({
              name: o.name,
              pom,
              category: o.material?.userData?.surfaceCategory,
              creviceAo: o.material?.userData?.creviceAoEnabled,
              microShadow: o.material?.userData?.microShadowEnabled,
            });
          }
        });

        return {
          ok: true,
          bakeRes,
          meshCount,
          pomMeshCount,
          sampleMeshes: meshes,
        };
      }, town);

      console.log(`Bake for ${town.name} completed in ${Date.now() - t0}ms:`, JSON.stringify(res, null, 2));
    }

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});

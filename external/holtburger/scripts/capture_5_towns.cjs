const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const OUT_DIR = "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/reports/captures";
fs.mkdirSync(OUT_DIR, { recursive: true });

async function captureScene(config) {
  const browser = await chromium.launch({
    args: ["--use-gl=swiftshader", "--no-sandbox"],
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1024 } });
    const url = "http://127.0.0.1:8765/apps/holtburger-web/index.html?renderer=3d&quality=high&gfxRelief=on&reliefBundles=on&skyhour=12&camDebug=on&portalSpace=off&loginPortalSpace=off&atmosphere=off";
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.getElementById("results")?.innerHTML.includes("PASS"), { timeout: 30000 });

    const sceneEval = await page.evaluate(async (cfg) => {
      document.querySelectorAll("body > *:not(#scene-container):not(#scene):not(canvas)").forEach(el => {
        if (el.tagName !== "CANVAS" && !el.querySelector("canvas")) el.style.display = "none";
      });
      const canvas = document.getElementById("scene") || document.querySelector("canvas");
      canvas.style.position = "fixed";
      canvas.style.top = "0";
      canvas.style.left = "0";
      canvas.style.width = "100vw";
      canvas.style.height = "100vh";
      canvas.style.zIndex = "99999";

      const wasm = window.__hbSceneWasm;
      const scene3d = await import("./scene3d/index.js");
      const buildingsMod = await import("./scene3d/buildings.js");
      const THREE = await import("three");

      const lbKey = (((cfg.lbX & 0xff) << 24) | ((cfg.lbY & 0xff) << 16)) >>> 0;
      const mockSession = {
        isCurrentCellIndoor: () => false,
        getCurrentCellId: () => 0,
        getRenderSet: () => new Uint32Array(0),
        setMovementInput: () => {},
        pollEntityUpdates: () => [],
        getLocalPlayerPose: () => ({ landblockId: lbKey, x: 60, y: 60, z: 78 }),
      };

      const live = await scene3d.init3D(canvas, mockSession, wasm);
      if (live.landblockLru) {
        live.landblockLru._serverLbKey = lbKey;
      }

      await buildingsMod.bakeBuildingsForLandblock(live, cfg.lbX, cfg.lbY, null, wasm);

      let targetMesh = null;
      let pomMeshCount = 0;
      let totalMeshCount = 0;

      live.buildingsGroup.traverse((o) => {
        if (!o.isMesh) return;
        totalMeshCount++;
        if (o.material?.userData?.pomEnabled) {
          pomMeshCount++;
          if (!targetMesh) targetMesh = o;
          if (cfg.meshSubstr && o.name.includes(cfg.meshSubstr)) targetMesh = o;
        }
      });

      if (!targetMesh) {
        live.buildingsGroup.traverse((o) => {
          if (o.isMesh && !targetMesh) targetMesh = o;
        });
      }

      const bbox = targetMesh ? new THREE.Box3().setFromObject(targetMesh) : new THREE.Box3();
      const center = bbox.getCenter(new THREE.Vector3());
      const size = bbox.getSize(new THREE.Vector3());

      const cam = live.cameraSwitcher?.activeCamera ?? live.camera;
      // Position camera at an oblique angle framing the primary masonry facade
      const eyeX = center.x + (cfg.camOffset ? cfg.camOffset.x : 3.2);
      const eyeY = center.y + (cfg.camOffset ? cfg.camOffset.y : 1.2);
      const eyeZ = center.z + (cfg.camOffset ? cfg.camOffset.z : 3.8);

      cam.position.set(eyeX, eyeY, eyeZ);
      cam.lookAt(center.x, center.y + (cfg.lookOffsetY || 0.4), center.z);
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();

      // Ensure direct sunlight at 45 degree angle for micro-contact crevice shadows
      const sun = new THREE.DirectionalLight(0xfffaed, 3.2);
      sun.position.set(center.x + 12, center.y + 24, center.z + 10);
      live.scene.add(sun);
      live.scene.add(new THREE.AmbientLight(0x8899aa, 1.4));

      live.renderer.render(live.scene, cam);

      return {
        sceneName: cfg.name,
        targetName: targetMesh?.name,
        totalMeshes: totalMeshCount,
        pomMeshes: pomMeshCount,
        pomEnabled: !!targetMesh?.material?.userData?.pomEnabled,
        pomSteps: targetMesh?.material?.userData?.pomUniforms?.steps,
        creviceAo: !!targetMesh?.material?.userData?.creviceAoEnabled,
        microShadow: !!targetMesh?.material?.userData?.microShadowEnabled,
        center: { x: +center.x.toFixed(2), y: +center.y.toFixed(2), z: +center.z.toFixed(2) },
        camPos: { x: +cam.position.x.toFixed(2), y: +cam.position.y.toFixed(2), z: +cam.position.z.toFixed(2) },
      };
    }, config);

    await page.waitForTimeout(400);
    const cdp = await page.context().newCDPSession(page);
    const snap = await cdp.send("Page.captureScreenshot", { format: "png" });
    const imgBuf = Buffer.from(snap.data, "base64");

    const outPath = path.join(OUT_DIR, config.filename);
    fs.writeFileSync(outPath, imgBuf);

    return {
      ...sceneEval,
      savedPath: outPath,
      bytes: imgBuf.length,
    };

  } finally {
    await browser.close();
  }
}

async function main() {
  const scenes = [
    {
      name: "Holtburg",
      filename: "scene1_holtburg_cottage_wall.png",
      lbX: 169,
      lbY: 180,
      meshSubstr: "08000370",
      description: "Stone cottage walls and masonry facades in Holtburg",
      camOffset: { x: 3.2, y: 1.2, z: 3.8 },
      lookOffsetY: 0.4,
    },
    {
      name: "Sanamar",
      filename: "scene2_sanamar_stone_hall.png",
      lbX: 51,
      lbY: 217,
      description: "Viamontian dressed stone masonry and halls in Sanamar",
      camOffset: { x: 4.5, y: 1.8, z: 4.2 },
      lookOffsetY: 0.6,
    },
    {
      name: "Al-Jalima",
      filename: "scene3_al_jalima_sandstone_tavern.png",
      lbX: 133,
      lbY: 136,
      description: "Arid sandstone architecture and domed tavern in Al-Jalima",
      camOffset: { x: 4.0, y: 1.5, z: 4.5 },
      lookOffsetY: 0.5,
    },
    {
      name: "Neydisa Castle",
      filename: "scene4_neydisa_stone_keep.png",
      lbX: 149,
      lbY: 214,
      description: "Granite battlements and stone keep in Neydisa Castle",
      camOffset: { x: 5.0, y: 2.5, z: 5.5 },
      lookOffsetY: 1.0,
    },
    {
      name: "Bandit Castle",
      filename: "scene5_bandit_octagonal_keep.png",
      lbX: 189,
      lbY: 208,
      description: "Rough stone ruins and octagonal keep in Bandit Castle",
      camOffset: { x: 4.8, y: 2.0, z: 4.8 },
      lookOffsetY: 0.8,
    },
  ];

  console.log(`Starting capture for ${scenes.length} representative town scenes...`);
  const results = [];

  for (const sc of scenes) {
    console.log(`\nCapturing ${sc.name} (${sc.filename})...`);
    const t0 = Date.now();
    try {
      const res = await captureScene(sc);
      console.log(`Successfully captured ${sc.name} in ${Date.now() - t0}ms:`, JSON.stringify(res, null, 2));
      results.push(res);
    } catch (err) {
      console.error(`Failed to capture ${sc.name}:`, err.message);
      results.push({ sceneName: sc.name, error: err.message });
    }
  }

  console.log("\nAll Scenes Captured:", JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});

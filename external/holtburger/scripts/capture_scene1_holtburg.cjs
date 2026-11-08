const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const OUT_DIR = "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/reports/captures";
fs.mkdirSync(OUT_DIR, { recursive: true });

async function main() {
  const browser = await chromium.launch({
    args: ["--use-gl=swiftshader", "--no-sandbox"],
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1024 } });

    const url = "http://127.0.0.1:8765/apps/holtburger-web/index.html?renderer=3d&quality=high&gfxRelief=on&reliefBundles=on&skyhour=12&camDebug=on&portalSpace=off&loginPortalSpace=off&atmosphere=off";
    console.log("Navigating to:", url);
    await page.goto(url, { waitUntil: "domcontentloaded" });

    await page.waitForFunction(() => {
      const r = document.getElementById("results");
      return r && /PASS/.test(r.innerHTML);
    }, { timeout: 30000 });
    console.log("Page ready, baking Holtburg scene...");

    const sceneData = await page.evaluate(async () => {
      // Hide UI overlays
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
      const THREE = await import("three");
      const scene3d = await import("./scene3d/index.js");
      const buildingsMod = await import("./scene3d/buildings.js");

      const mockSession = {
        isCurrentCellIndoor() { return false; },
        getCurrentCellId() { return 0; },
        getRenderSet() { return new Uint32Array(0); },
        setMovementInput() {},
        pollEntityUpdates() { return []; },
        getLocalPlayerPose() {
          return { landblockId: 0xA9B40000, x: 60, y: 60, z: 78 };
        },
      };

      const live = await scene3d.init3D(canvas, mockSession, wasm);
      const bakeRes = await buildingsMod.bakeBuildingsForLandblock(live, 169, 180, null, wasm);

      let targetMesh = null;
      live.buildingsGroup.traverse((o) => {
        if (o.isMesh && o.material?.userData?.pomEnabled) {
          if (!targetMesh || o.name.includes("08000370")) targetMesh = o;
        }
      });

      if (!targetMesh) return { ok: false, error: "No POM mesh found" };

      const bbox = new THREE.Box3().setFromObject(targetMesh);
      const center = bbox.getCenter(new THREE.Vector3());
      const size = bbox.getSize(new THREE.Vector3());

      const cam = live.cameraSwitcher?.activeCamera ?? live.camera;
      // Position at an oblique 45° angle, ~3m away to emphasize 3D parallax depth and crevice shadows
      cam.position.set(center.x + 3.2, center.y + 1.2, center.z + 3.8);
      cam.lookAt(center.x, center.y + 0.4, center.z);
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();

      // Strong directional lighting at 45 deg angle to cast micro-contact shadows in recessed crevices
      const sun = new THREE.DirectionalLight(0xfffaed, 3.2);
      sun.position.set(center.x + 12, center.y + 24, center.z + 10);
      sun.castShadow = true;
      live.scene.add(sun);
      const amb = new THREE.AmbientLight(0x8899aa, 1.4);
      live.scene.add(amb);

      live.renderer.render(live.scene, cam);

      return {
        ok: true,
        town: "Holtburg",
        feature: "Stone Cottage Wall (surface-08000370)",
        meshName: targetMesh.name,
        materialName: targetMesh.material?.name,
        pomEnabled: !!targetMesh.material?.userData?.pomEnabled,
        pomSteps: targetMesh.material?.userData?.pomUniforms?.steps,
        creviceAo: !!targetMesh.material?.userData?.creviceAoEnabled,
        microShadow: !!targetMesh.material?.userData?.microShadowEnabled,
        meshCenter: { x: +center.x.toFixed(2), y: +center.y.toFixed(2), z: +center.z.toFixed(2) },
        meshSize: { x: +size.x.toFixed(2), y: +size.y.toFixed(2), z: +size.z.toFixed(2) },
        cameraPos: { x: +cam.position.x.toFixed(2), y: +cam.position.y.toFixed(2), z: +cam.position.z.toFixed(2) },
      };
    });

    console.log("Scene 1 Holtburg Data:", JSON.stringify(sceneData, null, 2));

    await page.waitForTimeout(400);
    const cdp = await page.context().newCDPSession(page);
    const snap = await cdp.send("Page.captureScreenshot", { format: "png" });
    const imgBuf = Buffer.from(snap.data, "base64");

    const outPath = path.join(OUT_DIR, "scene1_holtburg_cottage_wall.png");
    fs.writeFileSync(outPath, imgBuf);
    console.log(`Saved Scene 1 capture to ${outPath} (${imgBuf.length} bytes)`);

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});

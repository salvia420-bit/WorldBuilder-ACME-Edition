const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const fs = require("fs");

(async () => {
  const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1024 } });
  const t0 = Date.now();
  await page.goto("http://127.0.0.1:8765/apps/holtburger-web/index.html?renderer=3d&quality=high&gfxRelief=on&reliefBundles=on&skyhour=12&portalSpace=off&loginPortalSpace=off&atmosphere=off", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.getElementById("results")?.innerHTML.includes("PASS"), { timeout: 30000 });
  console.log("PASS in", Date.now() - t0, "ms");

  const capture = await page.evaluate(async () => {
    // Hide UI
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

    const mockSession = {
      isCurrentCellIndoor() { return false; },
      getCurrentCellId() { return 0; },
      getRenderSet() { return new Uint32Array(0); },
      setMovementInput() {},
      pollEntityUpdates() { return []; },
      getLocalPlayerPose() { return { landblockId: 0xA9B40000, x: 60, y: 60, z: 78 }; }
    };
    const live = await scene3d.init3D(canvas, mockSession, wasm, window.__preInit3DHandle);
    
    // Bake Holtburg buildings
    console.log("Baking Holtburg buildings...");
    const bakeRes = await buildingsMod.bakeBuildingsForLandblock(live, 169, 180, null, wasm);

    // Find stone mesh with POM
    let target = null;
    live.buildingsGroup?.traverse(o => {
      if (o.isMesh && o.material?.userData?.pomEnabled) {
        if (!target || o.name.includes("08000370")) target = o;
      }
    });

    const THREE = await import("three");
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    if (target) {
      const bbox = new THREE.Box3().setFromObject(target);
      bbox.getCenter(center);
      bbox.getSize(size);
    }

    const cam = live.cameraSwitcher?.activeCamera ?? live.camera;
    // Oblique angle framing wall
    cam.position.set(center.x + 3.2, center.y + 1.2, center.z + 3.8);
    cam.lookAt(center.x, center.y + 0.4, center.z);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();

    // Directional light casting micro-shadows at 45 deg
    const sun = new THREE.DirectionalLight(0xfffaed, 3.2);
    sun.position.set(center.x + 12, center.y + 24, center.z + 10);
    live.scene.add(sun);
    live.scene.add(new THREE.AmbientLight(0x8899aa, 1.4));

    live.renderer.render(live.scene, cam);

    return {
      target: target ? target.name : null,
      pom: !!target?.material?.userData?.pomEnabled,
      pomSteps: target?.material?.userData?.pomUniforms?.steps,
      ao: !!target?.material?.userData?.creviceAoEnabled,
      microShadow: !!target?.material?.userData?.microShadowEnabled,
      center,
      cam: cam.position,
      bakeRes
    };
  });

  console.log("Capture evaluation result:", JSON.stringify(capture, null, 2));

  await page.waitForTimeout(300);
  const cdp = await page.context().newCDPSession(page);
  const snap = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync("/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/reports/captures/scene1_holtburg_cottage_wall.png", Buffer.from(snap.data, "base64"));
  console.log("SUCCESS! Saved scene1_holtburg_cottage_wall.png, bytes:", snap.data.length);

  await browser.close();
})();

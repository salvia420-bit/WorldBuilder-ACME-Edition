// scripts/generate_m5_walkthrough_captures.mjs
// Milestone 5 Phase 3: Live Real-GPU RTX 3060 1080p Ultra + Volumetric Clouds Inspection Tour & Capture Engine.
// Boots the full holtburger-web 3D Dereth renderer (init3D + Takram Volumetric Clouds + Light Shafts +
// 3-Cascade 2048^2 CSM + Horizon GTAO + SSCS + 119,716 Grass Blades + 2.1km Far Ring + AGX HDR PostChain)
// on the NVIDIA GeForce RTX 3060 via Headless EGL Chromium at native 1920x1080 (renderScale = 1).

import { chromium } from '../external/holtburger/apps/holtburger-web/node_modules/playwright-core/index.mjs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const CAPTURES_DIR = '/root/.gemini/antigravity-cli/brain/c5a8ea3b-dca7-4d96-ab4a-3010a8f54f3b/captures';
fs.mkdirSync(CAPTURES_DIR, { recursive: true });

function checkPort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
  });
}

async function ensureAssetServer() {
  if (await checkPort(8765)) {
    console.log('[tour] Local asset server already listening on 127.0.0.1:8765');
    return null;
  }
  console.log('[tour] Starting local baked-dist asset server (serve.py) on 127.0.0.1:8765...');
  const child = spawn('python3', [
    'external/holtburger/scripts/serve.py',
    '--bind', '127.0.0.1',
    '--port', '8765',
  ], {
    cwd: process.cwd(),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  for (let i = 0; i < 50; i++) {
    if (await checkPort(8765)) {
      console.log('[tour] Asset server ready on 127.0.0.1:8765');
      return child;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill('SIGTERM');
  throw new Error('Failed to start serve.py on 127.0.0.1:8765');
}

async function runTour() {
  console.log('==============================================================================');
  console.log('  MILESTONE 5 PHASE 3: REAL-GPU RTX 3060 1080p ULTRA + CLOUDS DERETH TOUR');
  console.log('==============================================================================');
  console.log(`[tour] Output directory: ${CAPTURES_DIR}`);

  const serverProc = await ensureAssetServer();

  let browser = null;
  try {
    console.log('[tour] Launching Headless EGL Chromium on NVIDIA GeForce RTX 3060...');
    browser = await chromium.launch({
      executablePath: '/workspace/wb/ms-playwright/chromium-1254/chrome-linux64/chrome',
      args: [
        '--headless=new',
        '--use-gl=angle',
        '--use-angle=gl-egl',
        '--ignore-gpu-blocklist',
        '--mute-audio',
        '--window-position=-32000,-32000',
      ],
    });

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    });

    const page = await context.newPage();
    page.on('pageerror', (err) => console.error('[pageerror]', err.message));

    const url = [
      'http://127.0.0.1:8765/apps/holtburger-web/index.html',
      '?renderer=3d',
      '&quality=ultra',
      '&clouds=on',
      '&lightShafts=on',
      '&csm=on',
      '&gtao=on',
      '&sscs=on',
      '&bloom=on',
      '&pom=on',
      '&statPom=on',
      '&farRing=on',
      '&impostors=on',
      '&farForest=on',
      '&terrainGrass=on',
      '&waterPass=on',
      '&ssr=on',
      '&vehicles=on',
      '&adaptiveRes=off',
      '&renderScale=1',
      '&cloudResScale=1',
      '&skyhour=13.0',
      '&portalSpace=off',
      '&loginPortalSpace=off',
      '&plugins=none',
    ].join('');

    console.log('[tour] Navigating to holtburger-web Ultra + Volumetric Clouds...');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(
      () => document.getElementById('results')?.innerHTML.includes('PASS'),
      { timeout: 45000 }
    );

    console.log('[tour] Initializing full Dereth 3D world (Holtburg meadow 0xA8B40000) & Atmosphere LUTs...');
    const bootInfo = await page.evaluate(async () => {
      const wasm = await import('/apps/holtburger-web/pkg/holtburger_web.js?v=wasmrev-20261029b');
      const three = await import('three');
      const scene3d = await import('/apps/holtburger-web/scene3d/index.js');
      const { createCameraOwner } = await import('/apps/holtburger-web/scene3d/film/runtime/camera_owner.js');

      const canvas = document.getElementById('canvas');
      // Hide all 2D page chrome & overlays so only the 1920x1080 WebGL2 canvas shows
      const style = document.createElement('style');
      style.textContent = `
        html, body { margin: 0 !important; padding: 0 !important; overflow: hidden !important; background: #000 !important; }
        body > *:not(#stage) { display: none !important; }
        #stage { margin: 0 !important; padding: 0 !important; width: 1920px !important; height: 1080px !important; }
        #canvas-column > *:not(#canvas), #stage > *:not(#canvas-column) { display: none !important; }
        #canvas {
          position: fixed !important;
          top: 0 !important;
          left: 0 !important;
          width: 1920px !important;
          height: 1080px !important;
          z-index: 2147483647 !important;
          display: block !important;
        }
      `;
      document.head.appendChild(style);
      canvas.width = 1920;
      canvas.height = 1080;

      // Open meadow just west of Holtburg (LB 0xA8B4 -> lbX=168, lbY=180)
      const lbX = 168;
      const lbY = 180;
      const lbKey = (((lbX & 0xff) << 24) | ((lbY & 0xff) << 16)) >>> 0;
      const anchorLocalX = 96.0;
      const anchorLocalY = 96.0;
      let anchorZ = 82.0;

      const mockSession = {
        isCurrentCellIndoor: () => false,
        getCurrentCellId: () => (lbKey | 0x0001) >>> 0,
        getRenderSet: () => new Uint32Array(0),
        setMovementInput: () => {},
        pollEntityUpdates: () => [],
        drainEntityEvents3D: () => [],
        drainMotionEvents3D: () => [],
        drainVehicleMessages: () => '[]',
        getLocalPlayerPose: () => ({
          landblockId: (lbKey | 0x0001) >>> 0,
          x: anchorLocalX,
          y: anchorLocalY,
          z: anchorZ,
        }),
      };

      let preHandle = window.__preInit3DHandle;
      if (!preHandle && window.__preInit3DPromise) {
        preHandle = await Promise.race([
          window.__preInit3DPromise,
          new Promise((r) => setTimeout(() => r(null), 15000)),
        ]);
      }

      const live = await scene3d.init3D(canvas, mockSession, wasm, preHandle);
      window.__live = live;

      // Hide hello-cube if present
      if (live.cube) live.cube.visible = false;

      live.renderer.setSize(1920, 1080, false);
      if (live.composer && typeof live.composer.setSize === 'function') {
        live.composer.setSize(1920, 1080);
      }

      // Wait for atmosphere/clouds LUT bake to settle
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (window.__sceneReadyEverFired) break;
      }
      await new Promise((r) => setTimeout(r, 1200));

      // Raycast exact AC terrain height at our meadow origin (worldX, worldY)
      const worldX = lbX * 192.0 + anchorLocalX;
      const worldY = lbY * 192.0 + anchorLocalY;
      live.worldRoot.updateMatrixWorld(true);

      // Raycast downward in Three.js Y-up space: threePos = (acX, acZ, -acY)
      const raycaster = new three.Raycaster(
        new three.Vector3(worldX, 500, -worldY),
        new three.Vector3(0, -1, 0),
        0,
        1000
      );
      const hits = raycaster.intersectObjects(live.terrainGroup.children, true);
      if (hits.length > 0) {
        anchorZ = hits[0].point.y;
      }

      // Helper to sample AC terrain Z at any (wx, wy)
      window.__sampleTerrainZ = (wx, wy) => {
        const rc = new three.Raycaster(
          new three.Vector3(wx, 500, -wy),
          new three.Vector3(0, -1, 0),
          0,
          1000
        );
        const h = rc.intersectObjects(live.terrainGroup.children, true);
        return h.length > 0 ? h[0].point.y : anchorZ;
      };

      // Find the flattest 40m x 40m patch in the 3x3 Holtburg meadow ring so containers sit level on grass!
      let bestX = worldX;
      let bestY = worldY;
      let bestZ = anchorZ;
      let bestSlope = Infinity;
      for (let dx = -140; dx <= 140; dx += 20) {
        for (let dy = -140; dy <= 140; dy += 20) {
          const cx = worldX + dx;
          const cy = worldY + dy;
          const z0 = window.__sampleTerrainZ(cx, cy);
          const z1 = window.__sampleTerrainZ(cx + 12, cy);
          const z2 = window.__sampleTerrainZ(cx - 12, cy);
          const z3 = window.__sampleTerrainZ(cx, cy + 12);
          const z4 = window.__sampleTerrainZ(cx, cy - 12);
          const span = Math.max(z0, z1, z2, z3, z4) - Math.min(z0, z1, z2, z3, z4);
          if (span < bestSlope && z0 > 20) {
            bestSlope = span;
            bestX = cx;
            bestY = cy;
            bestZ = (z0 + z1 + z2 + z3 + z4) / 5;
          }
        }
      }
      anchorZ = bestZ;
      window.__anchor = { x: bestX, y: bestY, z: bestZ, slopeSpanM: +bestSlope.toFixed(3) };

      // Update mockSession player pose to the chosen flat meadow so grass (40m radius) & near CSM center right here!
      const chosenLbX = Math.floor(bestX / 192.0);
      const chosenLbY = Math.floor(bestY / 192.0);
      const chosenLbKey = (((chosenLbX & 0xff) << 24) | ((chosenLbY & 0xff) << 16) | 0x0001) >>> 0;
      mockSession.getCurrentCellId = () => chosenLbKey;
      mockSession.getLocalPlayerPose = () => ({
        landblockId: chosenLbKey,
        x: bestX - chosenLbX * 192.0,
        y: bestY - chosenLbY * 192.0,
        z: bestZ,
      });

      // Acquire film camera owner so we write upright AC Z-up poses directly into cameraSwitcher.persp
      const camOwner = createCameraOwner({
        liveScene3d: live,
        THREE: three,
        window,
        sessionHandle: mockSession,
      });
      camOwner.own();
      window.__camOwner = camOwner;

      window.__setCameraLookAtAc = (eyeOffset, targetOffset, fov = 45) => {
        const a = window.__anchor;
        const ex = a.x + eyeOffset[0];
        const ey = a.y + eyeOffset[1];
        const ez = a.z + eyeOffset[2];
        const tx = a.x + targetOffset[0];
        const ty = a.y + targetOffset[1];
        const tz = a.z + targetOffset[2];
        const dx = tx - ex;
        const dy = ty - ey;
        const dz = tz - ez;
        const h = Math.atan2(dx, dy); // AC compass heading: 0 = +Y north, pi/2 = +X east
        const p = Math.atan2(dz, Math.hypot(dx, dy)); // nose-up positive
        camOwner.write({ pos: [ex, ey, ez], h, p, r: 0, fov });
      };

      // Mount tourRoot inside live.entitiesGroup (which lives under worldRoot's -pi/2 Z-up transform
      // AND is collected in the dynamic CSM shadow pass every frame!)
      const tourRoot = new three.Group();
      tourRoot.name = 'm5-ultra-dereth-tour-root';
      tourRoot.position.set(bestX, bestY, bestZ);
      live.entitiesGroup.add(tourRoot);
      window.__tourRoot = tourRoot;

      // Let grass & near CSM recenter on the flat meadow
      await new Promise((r) => setTimeout(r, 1500));

      const gl = live.renderer.getContext();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        gpuRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        qualityTier: live.quality?.tier ?? 'ultra',
        cloudsActive: !!live.quality?.flags?.clouds,
        csmActive: !!live.csmState,
        terrainChunks: live.terrainGroup?.children?.length ?? 0,
        anchor: window.__anchor,
        drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      };
    });

    console.log('[tour] Real-GPU Ultra Dereth World Ready:', JSON.stringify(bootInfo, null, 2));

    const cdp = await context.newCDPSession(page);

    async function captureShot(shotName, setupFn) {
      console.log(`[tour] Capturing ${shotName}...`);
      await page.evaluate(setupFn);
      // Allow 20+ frames for temporal clouds, GTAO, CSM cascades, and grass sway to converge cleanly
      await page.waitForTimeout(900);
      // Hide any late-created HUD DOM nodes outside #stage
      await page.evaluate(() => {
        document.querySelectorAll('body > *:not(#stage)').forEach((el) => {
          el.style.setProperty('display', 'none', 'important');
        });
      });
      const snap = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const outPath = path.join(CAPTURES_DIR, `${shotName}.png`);
      fs.writeFileSync(outPath, Buffer.from(snap.data, 'base64'));
      const stat = fs.statSync(outPath);
      console.log(`[tour]   ✓ Saved ${shotName}.png (${(stat.size / 1024).toFixed(1)} KB)`);
    }

    // Helper inside browser to create a compacted gravel/concrete logistics pad flush on the meadow grass
    await page.evaluate(async () => {
      const three = await import('three');
      const { installCsmShaderPatch } = await import('/apps/holtburger-web/scene3d/materials.js');

      window.__clearTourRoot = () => {
        const root = window.__tourRoot;
        while (root.children.length > 0) {
          const ch = root.children[0];
          root.remove(ch);
        }
      };

      window.__addLogisticsPad = (w, d, zOff = 0.02, withStripes = false) => {
        const live = window.__live;
        const root = window.__tourRoot;
        const padMat = new three.MeshStandardMaterial({
          color: 0x565a5e,
          roughness: 0.86,
          metalness: 0.08,
        });
        if (live.csmState) installCsmShaderPatch(padMat, live.csmState);
        const pad = new three.Mesh(new three.BoxGeometry(w, d, 0.08), padMat);
        pad.position.set(0, 0, zOff - 0.04);
        pad.castShadow = false;
        pad.receiveShadow = true;
        root.add(pad);

        if (withStripes) {
          const stripeMat = new three.MeshStandardMaterial({
            color: 0xdba218,
            roughness: 0.72,
            metalness: 0.05,
          });
          if (live.csmState) installCsmShaderPatch(stripeMat, live.csmState);
          for (const sx of [-w * 0.46, w * 0.46]) {
            const st = new three.Mesh(new three.BoxGeometry(0.18, d * 0.94, 0.084), stripeMat);
            st.position.set(sx, 0, zOff - 0.04);
            st.receiveShadow = true;
            root.add(st);
          }
        }
        return zOff;
      };
    });

    // =========================================================================
    // TOUR STOP 1: INTERMODAL CONTAINER YARD & LIVERIES IN ULTRA DERETH
    // =========================================================================

    // Shot 1: Yard Overview (Stacked 20ft/40ft/40HC containers under Takram Volumetric Clouds & Hills)
    await captureShot('tour_stop_1_yard_overview', async () => {
      const live = window.__live;
      const three = await import('three');
      const { buildIsoContainer, CONTAINER_WCID } = await import('/apps/holtburger-web/scene3d/vehicle/container_models.js');

      window.__clearTourRoot();
      const padZ = window.__addLogisticsPad(30, 38, 0.04, true);
      const root = window.__tourRoot;
      const liveries = ['maritimeBlue', 'cortenRed', 'evergreen', 'oliveDrab', 'desertTan', 'industrialAmber'];

      // Row 1 (West): 20ft Standard containers + stacked second tier
      for (let i = 0; i < 3; i++) {
        const c = buildIsoContainer(three, CONTAINER_WCID.IsoContainer20, {
          livery: liveries[i],
          serialNumber: 100201 + i,
          csmState: live.csmState,
        });
        c.root.position.set(-8.5, -9.0 + i * 8.5, padZ);
        root.add(c.root);
      }
      const stack20 = buildIsoContainer(three, CONTAINER_WCID.IsoContainer20, {
        livery: 'industrialAmber',
        serialNumber: 204810,
        csmState: live.csmState,
      });
      stack20.root.position.set(-8.5, -0.5, padZ + 2.591);
      root.add(stack20.root);

      // Row 2 (Center): 40ft Standard containers
      for (let i = 0; i < 2; i++) {
        const c = buildIsoContainer(three, CONTAINER_WCID.IsoContainer40, {
          livery: liveries[i + 2],
          serialNumber: 401120 + i,
          csmState: live.csmState,
        });
        c.root.position.set(0.0, -7.0 + i * 14.5, padZ);
        root.add(c.root);
      }

      // Row 3 (East): 40ft High-Cube containers + stacked 40HC
      for (let i = 0; i < 2; i++) {
        const c = buildIsoContainer(three, CONTAINER_WCID.IsoContainer40HC, {
          livery: liveries[(i + 4) % 6],
          serialNumber: 450901 + i,
          csmState: live.csmState,
        });
        c.root.position.set(8.5, -7.0 + i * 14.5, padZ);
        root.add(c.root);
      }
      const stack40hc = buildIsoContainer(three, CONTAINER_WCID.IsoContainer40HC, {
        livery: 'maritimeBlue',
        serialNumber: 458812,
        csmState: live.csmState,
      });
      stack40hc.root.position.set(8.5, 7.5, padZ + 2.896);
      root.add(stack40hc.root);

      // Low-ish dramatic three-quarter angle showing yard, grass meadow, horizon hills, and volumetric clouds!
      window.__setCameraLookAtAc([21.0, -25.0, 6.2], [0.0, 2.0, 3.2], 46);
    });

    // Shot 2: Dimensional Lineup Comparison (20ft vs 40ft vs 40HC with sky & volumetric clouds)
    await captureShot('tour_stop_1_lineup_comparison', async () => {
      const live = window.__live;
      const three = await import('three');
      const { buildIsoContainer, CONTAINER_WCID } = await import('/apps/holtburger-web/scene3d/vehicle/container_models.js');

      window.__clearTourRoot();
      const padZ = window.__addLogisticsPad(36, 14, 0.04, true);
      const root = window.__tourRoot;

      const c20 = buildIsoContainer(three, CONTAINER_WCID.IsoContainer20, {
        livery: 'maritimeBlue',
        serialNumber: 220101,
        csmState: live.csmState,
      });
      c20.root.position.set(-11.5, 0, padZ);
      c20.root.rotation.z = Math.PI / 2;
      root.add(c20.root);

      const c40 = buildIsoContainer(three, CONTAINER_WCID.IsoContainer40, {
        livery: 'cortenRed',
        serialNumber: 420202,
        csmState: live.csmState,
      });
      c40.root.position.set(-0.5, 0, padZ);
      c40.root.rotation.z = Math.PI / 2;
      root.add(c40.root);

      const c40hc = buildIsoContainer(three, CONTAINER_WCID.IsoContainer40HC, {
        livery: 'evergreen',
        serialNumber: 450303,
        csmState: live.csmState,
      });
      c40hc.root.position.set(12.5, 0, padZ);
      c40hc.root.rotation.z = Math.PI / 2;
      root.add(c40hc.root);

      window.__setCameraLookAtAc([0.5, -24.5, 2.5], [0.5, 0.0, 2.4], 45);
    });

    // Shot 3: 6-Livery Marine & Tactical Palette Showcase
    await captureShot('tour_stop_1_liveries_palette', async () => {
      const live = window.__live;
      const three = await import('three');
      const { buildIsoContainer, CONTAINER_WCID, CONTAINER_LIVERIES } = await import('/apps/holtburger-web/scene3d/vehicle/container_models.js');

      window.__clearTourRoot();
      const padZ = window.__addLogisticsPad(28, 20, 0.04, false);
      const root = window.__tourRoot;

      const keys = Object.keys(CONTAINER_LIVERIES);
      keys.forEach((key, idx) => {
        const row = Math.floor(idx / 3);
        const col = idx % 3;
        const c = buildIsoContainer(three, CONTAINER_WCID.IsoContainer20, {
          livery: key,
          serialNumber: 300100 + idx * 17,
          csmState: live.csmState,
        });
        c.root.position.set((col - 1) * 6.2, row * 8.5 - 3.5, padZ);
        c.root.rotation.z = -0.38;
        root.add(c.root);
      });

      window.__setCameraLookAtAc([2.0, -17.5, 4.4], [0.0, 0.5, 1.8], 44);
    });

    // Shot 4: ISO Structural Features Macro (20ft Forklift Pockets, 40HC Gooseneck Tunnel, 9'6" Chevrons & BIC/CSC Plates)
    await captureShot('tour_stop_1_features_details', async () => {
      const live = window.__live;
      const three = await import('three');
      const { buildIsoContainer, CONTAINER_WCID } = await import('/apps/holtburger-web/scene3d/vehicle/container_models.js');

      window.__clearTourRoot();
      const padZ = window.__addLogisticsPad(18, 16, 0.04, false);
      const root = window.__tourRoot;

      // Left: 20ft elevated slightly on timber dunnage blocks so through-base forklift pockets are crystal clear
      const c20 = buildIsoContainer(three, CONTAINER_WCID.IsoContainer20, {
        livery: 'industrialAmber',
        serialNumber: 229014,
        csmState: live.csmState,
      });
      c20.root.position.set(-4.2, 0.5, padZ);
      c20.root.rotation.z = Math.PI / 2;
      root.add(c20.root);

      // Right: 40ft High-Cube angled to show rear BIC/CSC plates, 9'6" corner hazard chevrons, and front gooseneck recess
      const c40hc = buildIsoContainer(three, CONTAINER_WCID.IsoContainer40HC, {
        livery: 'maritimeBlue',
        serialNumber: 451009,
        csmState: live.csmState,
      });
      c40hc.root.position.set(3.8, 2.2, padZ + 0.18);
      c40hc.root.rotation.z = -0.45;
      root.add(c40hc.root);

      window.__setCameraLookAtAc([-0.2, -9.8, 2.1], [0.2, 0.0, 1.55], 42);
    });

    // =========================================================================
    // TOUR STOP 2: 270° CARGO DOORS, LOCKING BARS & WALK-IN MARINE DECK RAMP
    // =========================================================================

    // Shot 5: 270° Door Kinematics Sequence (0° Closed, ~110° Mid-Swing Astragal, 270° Flush Sidewall + Ramp)
    await captureShot('tour_stop_2_doors_kinematics', async () => {
      const live = window.__live;
      const three = await import('three');
      const { buildIsoContainer, CONTAINER_WCID } = await import('/apps/holtburger-web/scene3d/vehicle/container_models.js');

      window.__clearTourRoot();
      const padZ = window.__addLogisticsPad(22, 12, 0.04, true);
      const root = window.__tourRoot;

      const cClosed = buildIsoContainer(three, CONTAINER_WCID.IsoContainer20, {
        livery: 'cortenRed',
        doorProgress: 0.0,
        serialNumber: 100001,
        csmState: live.csmState,
      });
      cClosed.root.position.set(-6.0, 0, padZ);
      root.add(cClosed.root);

      const cMid = buildIsoContainer(three, CONTAINER_WCID.IsoContainer20, {
        livery: 'maritimeBlue',
        doorProgress: 0.42,
        serialNumber: 100002,
        csmState: live.csmState,
      });
      cMid.loadSlot(0, 4000010);
      cMid.loadSlot(8, 4000002);
      cMid.root.position.set(0.0, 0, padZ);
      root.add(cMid.root);

      const cOpen = buildIsoContainer(three, CONTAINER_WCID.IsoContainer20, {
        livery: 'evergreen',
        doorProgress: 1.0,
        serialNumber: 100003,
        csmState: live.csmState,
      });
      cOpen.loadSlot(0, 4000010);
      cOpen.loadSlot(8, 4000014);
      cOpen.root.position.set(6.0, 0, padZ);
      root.add(cOpen.root);

      window.__setCameraLookAtAc([0.0, -11.8, 2.35], [0.0, -2.0, 1.45], 45);
    });

    // Shot 6: Macro of Galvanized Locking Bars, Cams/Keepers, CSC Plate, BIC Stencil & EPDM Gasket
    await captureShot('tour_stop_2_locking_hardware', async () => {
      const live = window.__live;
      const three = await import('three');
      const { buildIsoContainer, CONTAINER_WCID } = await import('/apps/holtburger-web/scene3d/vehicle/container_models.js');

      window.__clearTourRoot();
      const padZ = window.__addLogisticsPad(10, 10, 0.04, false);
      const root = window.__tourRoot;

      const c = buildIsoContainer(three, CONTAINER_WCID.IsoContainer20, {
        livery: 'cortenRed',
        doorProgress: 0.10,
        serialNumber: 100009,
        csmState: live.csmState,
      });
      c.root.position.set(0, 0, padZ);
      root.add(c.root);

      window.__setCameraLookAtAc([0.55, -5.6, 1.48], [0.05, -3.0, 1.38], 34);
    });

    // Shot 7: Walk-In 11° Diamond-Plate Loading Ramp & 28mm Apitong Marine Wood Floor
    await captureShot('tour_stop_2_walkin_ramp_floor', async () => {
      const live = window.__live;
      const three = await import('three');
      const { buildIsoContainer, CONTAINER_WCID } = await import('/apps/holtburger-web/scene3d/vehicle/container_models.js');

      window.__clearTourRoot();
      const padZ = window.__addLogisticsPad(12, 14, 0.04, true);
      const root = window.__tourRoot;

      const c = buildIsoContainer(three, CONTAINER_WCID.IsoContainer20, {
        livery: 'desertTan',
        doorProgress: 1.0,
        serialNumber: 224840,
        csmState: live.csmState,
      });
      // Stowed GMA pallets deeper inside the bay so the foreground shows the ramp + planked wood floor + lashing rings
      c.loadSlot(0, 4000010);
      c.loadSlot(1, 4000012);
      c.root.position.set(0, 0, padZ);
      root.add(c.root);

      window.__setCameraLookAtAc([0.35, -6.2, 1.05], [0.0, -0.5, 0.72], 42);
    });

    // Shot 8: First-Person Interior Walkthrough Looking Out onto Dereth Grass, Hills & Volumetric Clouds!
    await captureShot('tour_stop_2_interior_walkthrough', async () => {
      const live = window.__live;
      const three = await import('three');
      const { buildIsoContainer, CONTAINER_WCID } = await import('/apps/holtburger-web/scene3d/vehicle/container_models.js');
      const { buildDeployable } = await import('/apps/holtburger-web/scene3d/vehicle/deployable_models.js');

      window.__clearTourRoot();
      const padZ = window.__addLogisticsPad(18, 22, 0.04, false);
      const root = window.__tourRoot;

      const c = buildIsoContainer(three, CONTAINER_WCID.IsoContainer40HC, {
        livery: 'maritimeBlue',
        doorProgress: 1.0,
        serialNumber: 459001,
        csmState: live.csmState,
      });
      c.root.position.set(0, 0, padZ);
      root.add(c.root);

      // Deployed units visible outside on the meadow beyond the ramp!
      const outPod = buildDeployable(three, 4000010, { csmState: live.csmState });
      outPod.root.position.set(-3.2, -12.5, padZ);
      root.add(outPod.root);

      const outSam = buildDeployable(three, 4000014, { csmState: live.csmState });
      outSam.update({ deployElevation: 1.0, yawRad: 0.4, ammoRemaining: 4 });
      outSam.root.position.set(3.4, -13.0, padZ);
      root.add(outSam.root);

      // Standing inside on the z=0.162m marine wood floor looking out the open rear doors (-Y) at Dereth sky & clouds!
      window.__setCameraLookAtAc([0.0, -2.2, padZ + 0.162 + 1.42], [0.0, -14.0, padZ + 1.55], 54);
    });

    // =========================================================================
    // TOUR STOP 3: UNPACKED 9-DEPLOYABLE GMA FOB ARRAY IN ULTRA DERETH
    // =========================================================================

    // Shot 9: Complete 9-Deployable "FOB-in-a-Box" Array Unpacked Around Open 20ft ISO Container
    await captureShot('tour_stop_3_fob_array_overview', async () => {
      const live = window.__live;
      const three = await import('three');
      const { buildIsoContainer, CONTAINER_WCID } = await import('/apps/holtburger-web/scene3d/vehicle/container_models.js');
      const { buildDeployable } = await import('/apps/holtburger-web/scene3d/vehicle/deployable_models.js');
      const { buildDeployedRadar } = await import('/apps/holtburger-web/scene3d/vehicle/radar_model.js');

      window.__clearTourRoot();
      const root = window.__tourRoot;
      const gz = 0.02; // Sitting directly on the lush Holtburg grass meadow!

      // Open Olive Drab 20ft FOB container depot in rear center
      const c20 = buildIsoContainer(three, CONTAINER_WCID.IsoContainer20, {
        livery: 'oliveDrab',
        doorProgress: 1.0,
        serialNumber: 204010,
        csmState: live.csmState,
      });
      c20.loadSlot(0, null); // Empty GMA pallets remaining inside after unpacking
      c20.loadSlot(1, null);
      c20.root.position.set(0.0, 7.5, gz);
      root.add(c20.root);

      // Central Microgrid Power Core
      const fluxPod = buildDeployable(three, 4000010, { csmState: live.csmState });
      fluxPod.root.position.set(0.0, 0.0, gz);
      root.add(fluxPod.root);

      const solar = buildDeployable(three, 4000011, { csmState: live.csmState });
      solar.update({ sunHeading: 0.45, sunPitch: 0.55 });
      solar.root.position.set(-3.4, 0.6, gz);
      root.add(solar.root);

      const gen = buildDeployable(three, 4000012, { csmState: live.csmState });
      gen.update({ online: true, fuelSecondsRemaining: 600 });
      gen.root.position.set(3.4, 0.6, gz);
      root.add(gen.root);

      const battery = buildDeployable(three, 4000013, { csmState: live.csmState });
      battery.update({ energyJoules: 600000 });
      battery.root.position.set(-1.8, -2.6, gz);
      root.add(battery.root);

      // Perimeter Radars & Turrets (all on GMA Full/Half pallets!)
      const groundRadar = buildDeployable(three, 4000015, { csmState: live.csmState });
      groundRadar.root.position.set(1.8, -2.6, gz);
      root.add(groundRadar.root);

      const missile = buildDeployable(three, 4000014, { csmState: live.csmState });
      missile.update({ deployElevation: 1.0, yawRad: -0.35, pitchRad: 0.28, ammoRemaining: 4 });
      missile.root.position.set(-5.6, -3.4, gz);
      root.add(missile.root);

      const mortar = buildDeployable(three, 4000016, { csmState: live.csmState });
      mortar.update({ deployElevation: 1.0, yawRad: 0.25 });
      mortar.root.position.set(5.6, -3.4, gz);
      root.add(mortar.root);

      const laser = buildDeployable(three, 4000017, { csmState: live.csmState });
      laser.update({ yawRad: 0.15, pitchRad: 0.18 });
      laser.root.position.set(0.0, -5.2, gz);
      root.add(laser.root);

      const anTps1 = buildDeployedRadar(three, { stowed: false, csmState: live.csmState });
      anTps1.root.position.set(5.8, 3.2, gz);
      root.add(anTps1.root);

      window.__setCameraLookAtAc([9.5, -14.5, 4.6], [0.0, 0.5, 1.5], 46);
    });

    // Shot 10: All 9 GMA-Palletized Deployables Close-Up Inspection Grid
    await captureShot('tour_stop_3_deployables_grid', async () => {
      const live = window.__live;
      const three = await import('three');
      const { buildDeployable } = await import('/apps/holtburger-web/scene3d/vehicle/deployable_models.js');
      const { buildDeployedRadar } = await import('/apps/holtburger-web/scene3d/vehicle/radar_model.js');

      window.__clearTourRoot();
      const padZ = window.__addLogisticsPad(14, 14, 0.04, true);
      const root = window.__tourRoot;

      const builders = [
        () => buildDeployable(three, 4000010, { csmState: live.csmState }),
        () => { const u = buildDeployable(three, 4000011, { csmState: live.csmState }); u.update({ sunHeading: 0.3, sunPitch: 0.5 }); return u; },
        () => { const u = buildDeployable(three, 4000012, { csmState: live.csmState }); u.update({ online: true, fuelSecondsRemaining: 300 }); return u; },
        () => { const u = buildDeployable(three, 4000013, { csmState: live.csmState }); u.update({ energyJoules: 480000 }); return u; },
        () => { const u = buildDeployable(three, 4000014, { csmState: live.csmState }); u.update({ deployElevation: 1.0, pitchRad: 0.25, ammoRemaining: 4 }); return u; },
        () => buildDeployable(three, 4000015, { csmState: live.csmState }),
        () => { const u = buildDeployable(three, 4000016, { csmState: live.csmState }); u.update({ deployElevation: 1.0 }); return u; },
        () => { const u = buildDeployable(three, 4000017, { csmState: live.csmState }); u.update({ pitchRad: 0.15 }); return u; },
        () => buildDeployedRadar(three, { stowed: false, csmState: live.csmState }),
      ];

      builders.forEach((fn, idx) => {
        const row = Math.floor(idx / 3);
        const col = idx % 3;
        const inst = fn();
        inst.root.position.set((col - 1) * 3.2, (row - 1) * 3.4, padZ);
        inst.root.rotation.z = -0.28;
        root.add(inst.root);
      });

      window.__setCameraLookAtAc([2.2, -9.8, 3.8], [0.0, -0.2, 1.1], 43);
    });

    // Shot 11: Ultra AGX HDR PBR + CSM Parity Lineup (F6F Hellcat + Willys MB 4x4 Jeep + ISO 20ft + GMA Deployables)
    await captureShot('tour_stop_3_pbr_parity_hellcat_willys', async () => {
      const live = window.__live;
      const three = await import('three');
      const { buildIsoContainer, CONTAINER_WCID } = await import('/apps/holtburger-web/scene3d/vehicle/container_models.js');
      const { buildDeployable } = await import('/apps/holtburger-web/scene3d/vehicle/deployable_models.js');
      const { buildDeployedRadar } = await import('/apps/holtburger-web/scene3d/vehicle/radar_model.js');
      const { createAirframes } = await import('/apps/holtburger-web/scene3d/vehicle/airframe.js');
      const { buildProceduralJeep } = await import('/apps/holtburger-web/scene3d/vehicle/jeep_model.js');
      const { installCsmShaderPatch } = await import('/apps/holtburger-web/scene3d/materials.js');

      window.__clearTourRoot();
      const root = window.__tourRoot;
      const gz = 0.02;

      // 1. Grumman F6F-6N Super-Hellcat via createAirframes (exact propeller hub & retracting landing gear pivots!)
      const airframes = createAirframes({ liveScene3d: live, THREE: three, search: '?vehicles=on' });
      const hellcatInst = airframes.ensure({
        guid: 0x80001001,
        profile: { profileKey: 'hellcat-demo', parts: [{ did: 1, offset: [0, 0, 0], rotation: [1, 0, 0, 0], scale: 1 }] },
      });
      if (hellcatInst && hellcatInst.root) {
        // Move out of worldRoot into tourRoot so local offsets match!
        if (hellcatInst.root.parent) hellcatInst.root.parent.remove(hellcatInst.root);
        hellcatInst.root.traverse((o) => {
          if (o.isMesh && live.csmState && o.material) installCsmShaderPatch(o.material, live.csmState);
        });
        airframes.pose(
          hellcatInst,
          { x: -6.2, y: 1.8, z: gz + 1.98, heading: 2.55, pitch: 0.14, bank: 0.0, mode: 0, speed: 0 },
          { dt: 0.016, throttle: 0.15, agl: 0.0, land: true }
        );
        root.add(hellcatInst.root);
      }

      // 2. Willys MB 4x4 Jeep (decoupled 4-seat crew scout car)
      const jeep = buildProceduralJeep(three, {}, { liveScene3d: live });
      jeep.update({ speed: 0, steerAngle: 0.28, headlights: false, cargoLoaded: false });
      jeep.root.position.set(-0.6, -1.8, gz);
      jeep.root.rotation.z = 2.55;
      root.add(jeep.root);

      // 3. Open 20ft Maritime Blue ISO Container
      const c20 = buildIsoContainer(three, CONTAINER_WCID.IsoContainer20, {
        livery: 'maritimeBlue',
        doorProgress: 1.0,
        serialNumber: 100420,
        csmState: live.csmState,
      });
      c20.loadSlot(0, 4000011);
      c20.loadSlot(1, 4000012);
      c20.root.position.set(4.2, 2.5, gz);
      c20.root.rotation.z = -0.32;
      root.add(c20.root);

      // 4. GMA-palletized AN/TPS-1 Radar, SAM Turret & Flux Pod in foreground
      const radar = buildDeployedRadar(three, { stowed: false, csmState: live.csmState });
      radar.root.position.set(2.4, -2.5, gz);
      root.add(radar.root);

      const sam = buildDeployable(three, 4000014, { csmState: live.csmState });
      sam.update({ deployElevation: 1.0, yawRad: -0.4, pitchRad: 0.25, ammoRemaining: 4 });
      sam.root.position.set(4.8, -2.8, gz);
      root.add(sam.root);

      const flux = buildDeployable(three, 4000010, { csmState: live.csmState });
      flux.root.position.set(7.0, -2.0, gz);
      root.add(flux.root);

      window.__setCameraLookAtAc([1.2, -12.5, 2.6], [0.2, 0.0, 1.5], 47);
    });

    // Shot 12: Pinwheel GMA Bay Loading Inside Open 20ft & 40ft HC Containers
    await captureShot('tour_stop_3_pinwheel_bay_loading', async () => {
      const live = window.__live;
      const three = await import('three');
      const { buildIsoContainer, CONTAINER_WCID } = await import('/apps/holtburger-web/scene3d/vehicle/container_models.js');

      window.__clearTourRoot();
      const padZ = window.__addLogisticsPad(14, 18, 0.04, true);
      const root = window.__tourRoot;

      // Left: 20ft container loaded with FOB-in-a-Box (all 9 deployables = 7 Full GMA slots + empty GMA pallets)
      const c20 = buildIsoContainer(three, CONTAINER_WCID.IsoContainer20, {
        livery: 'maritimeBlue',
        doorProgress: 1.0,
        serialNumber: 200010,
        csmState: live.csmState,
      });
      c20.loadSlot(0, 4000010); // Flux Pod (Full)
      c20.loadSlot(1, 4000011); // Solar Panels folded stowed (Full)
      c20.loadSlot(2, 4000012); // Power Generator (Full)
      c20.loadSlot(4, 4000014); // SAM Turret retracted (Full)
      c20.loadSlot(5, 4000002); // AN/TPS-1 Radar stowed mast (Full)
      c20.loadSlot(8, 4000013, { palletSize: 'half', subSlot: 0 }); // Battery (Half 0)
      c20.loadSlot(8, 4000015, { palletSize: 'half', subSlot: 1 }); // Ground Radar (Half 1)
      c20.loadSlot(9, 4000016, { palletSize: 'half', subSlot: 0 }); // Mortar (Half 0)
      c20.loadSlot(9, 4000017, { palletSize: 'half', subSlot: 1 }); // Heavy Laser (Half 1)
      c20.root.position.set(-2.4, 0.0, padZ);
      root.add(c20.root);

      // Right: 40ft High-Cube loaded with heavy multi-pallet pinwheel bay
      const c40hc = buildIsoContainer(three, CONTAINER_WCID.IsoContainer40HC, {
        livery: 'cortenRed',
        doorProgress: 1.0,
        serialNumber: 450021,
        csmState: live.csmState,
      });
      c40hc.loadSlot(0, 4000010);
      c40hc.loadSlot(4, 4000012);
      c40hc.loadSlot(8, 4000014);
      c40hc.loadSlot(12, 4000011);
      c40hc.loadSlot(16, 4000002);
      c40hc.loadSlot(18, 4000013, { palletSize: 'half', subSlot: 0 });
      c40hc.loadSlot(18, 4000013, { palletSize: 'half', subSlot: 1 });
      c40hc.loadSlot(19, 4000017, { palletSize: 'half', subSlot: 0 });
      c40hc.loadSlot(19, 4000016, { palletSize: 'half', subSlot: 1 });
      c40hc.root.position.set(2.4, 3.067, padZ); // Align rear doors at same Y plane (-3.029 vs -6.096 + 3.067 = -3.029)!
      root.add(c40hc.root);

      window.__setCameraLookAtAc([0.0, -7.8, 1.78], [0.0, -1.5, 1.25], 46);
    });

    console.log('==============================================================================');
    console.log('  ALL 12 ULTRA + VOLUMETRIC CLOUDS DERETH CAPTURES GENERATED ON RTX 3060');
    console.log('==============================================================================');
  } finally {
    if (browser) await browser.close();
    if (serverProc) serverProc.kill('SIGTERM');
  }
}

runTour().catch((err) => {
  console.error('[tour] Fatal error:', err);
  process.exit(1);
});

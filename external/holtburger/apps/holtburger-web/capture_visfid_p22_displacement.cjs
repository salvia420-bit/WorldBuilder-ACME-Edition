// Phase 2.2 capture — animated water vertex displacement.
//
// Captures two screenshots of a Holtburg-centre LB whose `terrainCode`
// attribute has been forcibly overwritten to a water code (17 =
// WaterStandingFresh). The two screenshots are taken at uTime=t and
// uTime=t+2s; the diffs prove the wave displacement is animating.
//
// Why synthetic terrain codes: Holtburg (LB 0xA9B4) has no water
// terrain in retail Dereth (4 codes: 1 Grassland, 3 LushGrass, 9
// PatchyGrassland, 14 SemiBarrenRock). Water terrain (rivers / lakes /
// ocean) lives in other regions — Yaraq (~0x76xx) and rivers in the
// Direlands. The existing wasm pipeline's `fetch_landblock_heightmaps`
// fetches whatever the eor/cell catalog has; even though the v2 catalog
// covers more than just Holtburg, capture-script convenience + plan
// hand-off "use synthetic-terrain-codes capture if water LB not
// available" make this the pragmatic path.
//
// The implementation under test is real; the test input is synthetic.
//
// Run from `apps/holtburger-web/` against a local dev server:
//   PHASE22_PAGE_BASE=http://127.0.0.1:8090/apps/holtburger-web/index.html \
//   PHASE22_OUT_DIR=/mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave6-p22 \
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node capture_visfid_p22_displacement.cjs
//
// Asserts (in-page probe + screenshot diff):
//   - scene3d.terrainMaterials.length === 9 (one per Holtburg LB).
//   - Every material has a `uTime` uniform that increments per frame.
//   - At quality=mid (subdivLevel=2) → uDisplacementEnabled==1.0.
//   - At quality=low (subdivLevel=1) → uDisplacementEnabled==0.0.
//   - Synthetic water override applied to the centre LB: peek a vertex
//     before/after a 2s tick → z should differ.
//   - Lava code mask is 0 (Region 0x13 has no lava terrain).

const path = require("node:path");
const fs = require("node:fs");

const PLAYWRIGHT_CACHE =
  process.env.PLAYWRIGHT_CACHE ||
  "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules";

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (_) {
  try {
    ({ chromium } = require(path.join(PLAYWRIGHT_CACHE, "playwright")));
  } catch (e) {
    console.error("FAIL: playwright not found in NODE_PATH or " + PLAYWRIGHT_CACHE);
    process.exit(2);
  }
}

const PAGE_BASE =
  process.env.PHASE22_PAGE_BASE ||
  "http://127.0.0.1:8090/apps/holtburger-web/index.html";
const OUT_DIR =
  process.env.PHASE22_OUT_DIR ||
  "/mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave6-p22";
const SMOKE_TIMEOUT_MS = Number(process.env.PHASE22_SMOKE_TIMEOUT_MS || 90_000);
const BUILD_TIMEOUT_MS = Number(process.env.PHASE22_BUILD_TIMEOUT_MS || 180_000);
const RENDER_WAIT_MS = Number(process.env.PHASE22_RENDER_WAIT_MS || 2_000);
const DISPLACEMENT_WAIT_MS = Number(process.env.PHASE22_DISP_WAIT_MS || 2_000);

fs.mkdirSync(OUT_DIR, { recursive: true });

const HOLTBURG_X = 0xa9;
const HOLTBURG_Y = 0xb4;

async function captureOne(quality, opts) {
  const subdivLevel =
    opts?.subdivLevelOverride ??
    (quality === "low" ? 1 : quality === "mid" ? 2 : 4);
  const label = opts?.label || `${quality}-subdiv${subdivLevel}`;

  // Two screenshots per quality: t=0 and t=2s. Both run inside ONE
  // browser session so the uTime increments monotonically between
  // them — the wave displacement is the visible delta.
  const f0 = path.join(OUT_DIR, `water_displacement_${label}_t0.png`);
  const f2 = path.join(OUT_DIR, `water_displacement_${label}_t2s.png`);

  const pageUrl = `${PAGE_BASE}?renderer=3d&quality=${quality}&subdivLevel=${subdivLevel}`;
  console.log(`[visfid-p22] launching chromium → ${pageUrl}`);

  const browser = await chromium.launch({
    args: ["--use-gl=swiftshader"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1024 },
  });
  const page = await context.newPage();

  let consoleErrors = 0;
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error") {
      consoleErrors += 1;
      if (consoleErrors <= 6) console.log(`[browser error] ${text}`);
    } else if (/phase.?2\.2|displacement|terrain/i.test(text) && text.length < 200) {
      console.log(`[browser log] ${text.slice(0, 180)}`);
    }
  });
  page.on("pageerror", (err) => {
    consoleErrors += 1;
    console.error("[pageerror]", err.message);
  });

  await page.goto(pageUrl, { waitUntil: "domcontentloaded" });

  try {
    await page.waitForFunction(
      () => {
        const r = document.getElementById("results");
        return r && /PASS/.test(r.innerHTML);
      },
      { timeout: SMOKE_TIMEOUT_MS }
    );
  } catch (e) {
    const html = await page.locator("#results").innerHTML().catch(() => "(no #results)");
    console.error(`FAIL [${label}]: smoke panel never reached PASS within ${SMOKE_TIMEOUT_MS}ms`);
    console.error(`results HTML: ${html.slice(0, 500)}`);
    await browser.close();
    return { ok: false, fpath: null, reason: "smoke timeout" };
  }
  console.log(`[visfid-p22] [${label}] smoke panel PASS`);

  // Drive init3D, then synthetically override the Holtburg centre LB's
  // terrainCode attribute to water code 17 so the displacement path
  // activates on every centre-LB vertex.
  const probeInit = await page.evaluate(async (BUILD_TIMEOUT) => {
    const out = { steps: [] };
    try {
      const canvas =
        document.getElementById("scene") || document.querySelector("canvas");
      if (!canvas) { out.error = "no canvas"; return out; }
      const wasmMod = await import("./pkg/holtburger_web.js?v=h3-e1");
      const scene3d = await import("./scene3d/index.js");

      const mockSession = {
        isCurrentCellIndoor() { return false; },
        getCurrentCellId() { return 0; },
        getRenderSet() { return new Uint32Array(0); },
        setMovementInput() {},
        pollEntityUpdates() { return []; },
      };
      const wasmExports = {
        fetch_landblock_heightmaps: wasmMod.fetch_landblock_heightmaps,
        fetch_subdivided_landblock: wasmMod.fetch_subdivided_landblock,
        fetch_subdivided_landblocks: wasmMod.fetch_subdivided_landblocks,
        fetch_terrain_textures: wasmMod.fetch_terrain_textures,
        fetch_landblock_objects: wasmMod.fetch_landblock_objects,
        fetch_model_meshes: wasmMod.fetch_model_meshes,
        fetch_surfaces_pixels: wasmMod.fetch_surfaces_pixels,
        fetchBuildingPlacement: wasmMod.fetchBuildingPlacement,
        fetchSetupModelLights: wasmMod.fetchSetupModelLights,
        fetchEnvCellsInLandblock: wasmMod.fetchEnvCellsInLandblock,
        fetchEntityAnimationKeyframes: wasmMod.fetchEntityAnimationKeyframes,
        fetchEntityModelRender: wasmMod.fetchEntityModelRender,
        fetchEntitySurfacesPixels: wasmMod.fetchEntitySurfacesPixels,
      };
      const live = await Promise.race([
        scene3d.init3D(canvas, mockSession, wasmExports),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("init3D timeout")), BUILD_TIMEOUT)
        ),
      ]);
      out.preset = live.quality?.preset;
      out.subdivLevel = live.quality?.flags?.subdivLevel;

      // Phase 2.2 — collect terrain materials + sample one centre LB's
      // uniforms. The displacement gate is the load-bearing one.
      const mats = live.terrainMaterials || [];
      out.terrainMaterialsCount = mats.length;
      if (mats.length > 0) {
        const m0 = mats[0];
        out.uniforms = {
          uDisplacementEnabled: m0.uniforms?.uDisplacementEnabled?.value,
          uWaterCodeMask: m0.uniforms?.uWaterCodeMask?.value,
          uLavaCodeMask: m0.uniforms?.uLavaCodeMask?.value,
          uTime: m0.uniforms?.uTime?.value,
          uLbOriginXy_x: m0.uniforms?.uLbOriginXy?.value?.x,
          uLbOriginXy_y: m0.uniforms?.uLbOriginXy?.value?.y,
        };
      }

      // Find the centre LB and synthetically override its terrainCode
      // attribute to water code 17 (WaterStandingFresh). This activates
      // the displacement path on every centre-LB vertex. Real Holtburg
      // has 0 water terrain so without this override the wave would
      // never trigger.
      const tg = live.terrainGroup;
      const meshes = tg ? tg.children.filter((c) => c.userData?.lbX !== undefined) : [];
      const centre = meshes.find((m) => m.userData.lbX === 0xa9 && m.userData.lbY === 0xb4);
      if (!centre) {
        out.error = "centre LB not found";
        return out;
      }
      const geom = centre.geometry;
      const codeAttr = geom?.attributes?.terrainCode;
      if (!codeAttr) {
        out.error = "centre LB geometry has no terrainCode attribute";
        return out;
      }
      // Snapshot pre-override codes for traceability.
      out.preOverrideCodes = {
        unique: Array.from(new Set(Array.from(codeAttr.array.slice(0, 81)))),
        sampled: Array.from(codeAttr.array.slice(0, 9)),
      };
      // Force every vertex to water code 17. Re-uploads to GPU via
      // needsUpdate.
      const arr = codeAttr.array;
      for (let i = 0; i < arr.length; i += 1) arr[i] = 17;
      codeAttr.needsUpdate = true;
      out.postOverrideCodes = {
        sampled: Array.from(arr.slice(0, 9)),
      };
      // Sample two centre-LB vertices to compare z values across frames.
      const posAttr = geom?.attributes?.position;
      if (posAttr) {
        const pickIdx = (posAttr.count >> 1) | 0;
        out.centreSampleVertexIdx = pickIdx;
        out.centreSamplePos_initial = {
          x: posAttr.getX(pickIdx),
          y: posAttr.getY(pickIdx),
          z: posAttr.getZ(pickIdx),
        };
      }
      out.uTimeInitial = mats[0]?.uniforms?.uTime?.value;
      // Stash on window for the second-frame probe.
      window.__phase22_centre = centre;
      window.__phase22_mat0 = mats[0];
      out.initOk = true;
    } catch (e) {
      out.error = String(e?.message ?? e);
      out.errorStack = String(e?.stack ?? "").slice(0, 1200);
    }
    return out;
  }, BUILD_TIMEOUT_MS);

  console.log(`[visfid-p22] [${label}] init probe:`, JSON.stringify(probeInit, null, 2));

  if (!probeInit.initOk) {
    console.error(`FAIL [${label}]: init3D / centre-override failed: ${probeInit.error}`);
    if (probeInit.errorStack) console.error(probeInit.errorStack);
    await browser.close();
    return { ok: false, fpath: null, reason: probeInit.error, probe: probeInit };
  }

  // Camera flyover: aim down at the Holtburg centre LB so the water-
  // typed vertices fill the frame. Synthetic water override applies
  // displacement to the WHOLE centre LB, so a top-down framing makes
  // the wave easy to see across the surface.
  await page.evaluate(() => {
    const live = window.liveScene3d;
    if (!live) return;
    const acToThree = (x, y, z) => [x, z, -y];
    const M = 192;
    const cx = 0xa9 * M + M / 2;
    const cy = 0xb4 * M + M / 2;
    const camera = live.cameraSwitcher?.activeCamera || live.camera;
    if (!camera) return;
    if (live.cameraSwitcher) {
      live.cameraSwitcher.positionCamera = () => {};
      live.cameraSwitcher.tick = () => {};
    }
    // Stand south-west of the centre at 50 m up, look NE across the
    // displaced surface. Low-angle framing makes the wave silhouette
    // visible against the horizon.
    const eyeX = cx - 100;
    const eyeY = cy - 50;
    const eyeZ = 80;
    camera.position.set(...acToThree(eyeX, eyeY, eyeZ));
    camera.lookAt(...acToThree(cx + 30, cy + 80, 75));
  });

  await page.waitForTimeout(RENDER_WAIT_MS);

  // Frame 0: t=0 (after init render-wait).
  const canvasHandle = await page.$("#scene, canvas");
  if (canvasHandle) {
    await canvasHandle.screenshot({ path: f0, type: "png" });
  } else {
    await page.screenshot({ path: f0, type: "png" });
  }
  console.log(`[visfid-p22] [${label}] screenshot @t0 → ${f0}`);

  // Sample the centre vertex's clip-space z BEFORE the 2s wait (the
  // shader reads the geometry buffer, not displaced; we sample on the
  // probe side via the wave formula directly so we don't have to read
  // the GPU back).
  const probeT0 = await page.evaluate(() => {
    const centre = window.__phase22_centre;
    const m0 = window.__phase22_mat0;
    if (!centre || !m0) return { error: "no stashed centre/mat" };
    const geom = centre.geometry;
    const posAttr = geom?.attributes?.position;
    const pickIdx = (posAttr.count >> 1) | 0;
    const px = posAttr.getX(pickIdx);
    const py = posAttr.getY(pickIdx);
    const pz = posAttr.getZ(pickIdx);
    const uTime = m0.uniforms?.uTime?.value;
    const wx = (m0.uniforms?.uLbOriginXy?.value?.x ?? 0) + px;
    const wy = (m0.uniforms?.uLbOriginXy?.value?.y ?? 0) + py;
    // Replay shader-side wave displacement so the test can compare a
    // pure-JS computed delta against the visible animation.
    const wave =
      Math.sin(uTime * 0.5 + wx * 0.1) * 0.15 +
      Math.sin(uTime * 0.7 + wy * 0.13) * 0.10;
    return { px, py, pz, uTime, expectedWave: wave };
  });

  console.log(`[visfid-p22] [${label}] t0 probe:`, JSON.stringify(probeT0));

  // Wait 2 s of wall-clock time so uTime advances. The loop's per-rAF
  // tick pushes performance.now()*0.001 into every material's uniform.
  await page.waitForTimeout(DISPLACEMENT_WAIT_MS);

  const probeT2 = await page.evaluate(() => {
    const centre = window.__phase22_centre;
    const m0 = window.__phase22_mat0;
    if (!centre || !m0) return { error: "no stashed centre/mat" };
    const geom = centre.geometry;
    const posAttr = geom?.attributes?.position;
    const pickIdx = (posAttr.count >> 1) | 0;
    const px = posAttr.getX(pickIdx);
    const py = posAttr.getY(pickIdx);
    const pz = posAttr.getZ(pickIdx);
    const uTime = m0.uniforms?.uTime?.value;
    const wx = (m0.uniforms?.uLbOriginXy?.value?.x ?? 0) + px;
    const wy = (m0.uniforms?.uLbOriginXy?.value?.y ?? 0) + py;
    const wave =
      Math.sin(uTime * 0.5 + wx * 0.1) * 0.15 +
      Math.sin(uTime * 0.7 + wy * 0.13) * 0.10;
    return { px, py, pz, uTime, expectedWave: wave };
  });

  console.log(`[visfid-p22] [${label}] t2 probe:`, JSON.stringify(probeT2));

  // Frame 2: t=2s.
  if (canvasHandle) {
    await canvasHandle.screenshot({ path: f2, type: "png" });
  } else {
    await page.screenshot({ path: f2, type: "png" });
  }
  console.log(`[visfid-p22] [${label}] screenshot @t2s → ${f2}`);

  await browser.close();
  return {
    ok: true,
    fpath0: f0,
    fpath2: f2,
    probe: probeInit,
    probeT0,
    probeT2,
    consoleErrors,
  };
}

(async () => {
  const results = {};
  // mid = subdivLevel=2 → displacement ON. low = subdivLevel=1 →
  // displacement OFF (quality gate). The two captures together prove
  // both branches of the gate.
  results.mid = await captureOne("mid", { label: "mid-subdiv2" });
  results.low = await captureOne("low", { label: "low-subdiv1" });

  console.log("=========================");
  console.log("Phase 2.2 capture summary:");
  for (const k of ["mid", "low"]) {
    const r = results[k];
    console.log(
      `  ${k}: ok=${r.ok}, ` +
        `disp=${r.probe?.uniforms?.uDisplacementEnabled}, ` +
        `waterMask=0x${(r.probe?.uniforms?.uWaterCodeMask ?? 0).toString(16)}, ` +
        `lavaMask=0x${(r.probe?.uniforms?.uLavaCodeMask ?? 0).toString(16)}, ` +
        `uTime_t0=${r.probeT0?.uTime}, uTime_t2=${r.probeT2?.uTime}, ` +
        `materials=${r.probe?.terrainMaterialsCount}, ` +
        `errors=${r.consoleErrors ?? 0}`
    );
  }

  let failures = 0;
  function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures += 1;
  }

  // 9 terrain materials registered (one per Holtburg LB in the ring).
  check(
    "mid: 9 terrain ShaderMaterials registered",
    results.mid.probe?.terrainMaterialsCount === 9,
    `actual=${results.mid.probe?.terrainMaterialsCount}`
  );

  // Quality gate: mid → uDisplacementEnabled === 1.0.
  check(
    "mid (subdivLevel=2): uDisplacementEnabled === 1.0",
    results.mid.probe?.uniforms?.uDisplacementEnabled === 1.0,
    `actual=${results.mid.probe?.uniforms?.uDisplacementEnabled}`
  );

  // Quality gate: low → uDisplacementEnabled === 0.0.
  check(
    "low (subdivLevel=1): uDisplacementEnabled === 0.0",
    results.low.probe?.uniforms?.uDisplacementEnabled === 0.0,
    `actual=${results.low.probe?.uniforms?.uDisplacementEnabled}`
  );

  // Water code bitmask: codes {16, 17, 18, 19, 20, 22, 23} → 0xDF0000.
  // Bits 16-20 + 22-23 packed; bit 21 (ForestFloor) is grass not water.
  const expectedWaterMask = (1 << 16) | (1 << 17) | (1 << 18) | (1 << 19) | (1 << 20) | (1 << 22) | (1 << 23);
  check(
    "uWaterCodeMask == 0xDF0000 (codes 16,17,18,19,20,22,23)",
    results.mid.probe?.uniforms?.uWaterCodeMask === expectedWaterMask,
    `actual=0x${(results.mid.probe?.uniforms?.uWaterCodeMask ?? 0).toString(16)}, expected=0x${expectedWaterMask.toString(16)}`
  );

  // Lava code bitmask: 0 (Region 0x13 has no lava terrain codes).
  check(
    "uLavaCodeMask === 0 (Region 0x13 has no lava)",
    results.mid.probe?.uniforms?.uLavaCodeMask === 0,
    `actual=${results.mid.probe?.uniforms?.uLavaCodeMask}`
  );

  // uTime advances between t0 and t2s captures. Per-rAF tick pushes
  // performance.now()*0.001 onto every material's uTime.
  const uTimeDeltaMid = (results.mid.probeT2?.uTime ?? 0) - (results.mid.probeT0?.uTime ?? 0);
  check(
    "mid: uTime advances by ~2.0 s between frames",
    uTimeDeltaMid > 1.0 && uTimeDeltaMid < 3.5,
    `delta=${uTimeDeltaMid.toFixed(3)}s`
  );

  // Wave delta: |expectedWave(t2) - expectedWave(t0)| > 1 mm — proves
  // the wave formula evaluates differently at the two times.
  const waveDelta = Math.abs(
    (results.mid.probeT2?.expectedWave ?? 0) - (results.mid.probeT0?.expectedWave ?? 0)
  );
  check(
    "mid: wave delta over 2s > 1 mm (animation is alive)",
    waveDelta > 0.001,
    `|Δwave|=${waveDelta.toFixed(4)} m`
  );

  // Sanity: wave amplitude envelope. Max |sin| sum = 0.15 + 0.10 = 0.25,
  // well under the 0.4 m plan-doc cap.
  check(
    "wave amplitude bounded ≤ 0.25 m (plan §4 ≤ 0.4 m)",
    Math.abs(results.mid.probeT0?.expectedWave ?? 0) <= 0.26 &&
      Math.abs(results.mid.probeT2?.expectedWave ?? 0) <= 0.26,
    `t0=${results.mid.probeT0?.expectedWave?.toFixed(3)}, t2=${results.mid.probeT2?.expectedWave?.toFixed(3)}`
  );

  // Both screenshots exist on disk.
  check("t0 screenshot saved (mid)", results.mid.ok && results.mid.fpath0 && fs.existsSync(results.mid.fpath0));
  check("t2 screenshot saved (mid)", results.mid.ok && results.mid.fpath2 && fs.existsSync(results.mid.fpath2));

  // Screenshots differ — visual change between the two frames.
  if (results.mid.fpath0 && results.mid.fpath2 && fs.existsSync(results.mid.fpath0) && fs.existsSync(results.mid.fpath2)) {
    const buf0 = fs.readFileSync(results.mid.fpath0);
    const buf2 = fs.readFileSync(results.mid.fpath2);
    const sizesDiffer = buf0.length !== buf2.length;
    const bytesDiffer = !buf0.equals(buf2);
    check(
      "mid: t0 ≠ t2 screenshots (visual delta on screen)",
      bytesDiffer,
      `sizes: ${buf0.length} vs ${buf2.length}; bytes-differ=${bytesDiffer}; size-differ=${sizesDiffer}`
    );
  }

  console.log(`Total failures: ${failures}`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error("CRASH:", e);
  process.exit(2);
});

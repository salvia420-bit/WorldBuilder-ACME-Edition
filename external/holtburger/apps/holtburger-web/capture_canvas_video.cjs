#!/usr/bin/env node
// record_canvas.cjs — records the 3D canvas DIRECTLY via the browser's
// MediaRecorder API + canvas.captureStream(). Bypasses the previous
// Playwright recordVideo approach which captured DOM but not WebGL.
//
// Env knobs:
//   RECORD_W / RECORD_H — viewport (default 1920x1080; Chromium renders
//     at this size regardless of the virtual desktop's 1024x768).
//   RECORD_DURATION_MS — total record length (default 30s for smoke).
//   RECORD_WALK — "0" to disable @teleloc walk loop (default on).
//   RECORD_OUT_DIR — where to write the .webm (default D:/.../out/video).
//   RECORD_FPS — capture rate (default 30).

"use strict";

const path = require("path");
const fs = require("fs");
const PLAYWRIGHT_CACHE = process.env.PLAYWRIGHT_CACHE;
let chromium;
try { chromium = require("playwright").chromium; }
catch (_) {
  try { chromium = require(path.join(PLAYWRIGHT_CACHE, "playwright")).chromium; }
  catch (e) { console.error("playwright not found:", e?.message); process.exit(2); }
}

const ACCOUNT = process.env.PHASE4_TEST_ACCOUNT || "tailnet1";
const PASSWORD = process.env.PHASE4_TEST_PASSWORD || "tailnet1";
const BRIDGE_URL = process.env.PHASE4_BRIDGE_URL || "ws://127.0.0.1:8080/";
const SERVER_IP = process.env.PHASE4_SERVER_IP || "100.116.47.66";
const SERVER_PORT = process.env.PHASE4_SERVER_PORT || "9000";
const W = Number(process.env.RECORD_W || 1920);
const H = Number(process.env.RECORD_H || 1080);
const DURATION_MS = Number(process.env.RECORD_DURATION_MS || 30_000);
const WALK_ENABLED = process.env.RECORD_WALK !== "0";
const FPS = Number(process.env.RECORD_FPS || 30);
const OUT_DIR = process.env.RECORD_OUT_DIR || "D:/andrew/claudecode2/out/video";
try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch (_) {}

const PAGE_URL =
  (process.env.PAGE_URL_BASE
   || "http://127.0.0.1:8765/apps/holtburger-web/index.html")
  + "?renderer=3d&quality=ultra&clouds=on&envcellFusion=1";

const WAYPOINTS = [
  "@teleloc 0xA9B40000 100 100 80",
  "@teleloc 0xA9B40000 140 80 82",
  "@teleloc 0xAAB30015 67 110 112",
  "@teleloc 0xA9B30000 120 60 90",
  "@teleloc 0xA9B20000 80 80 95",
  "@teleloc 0xAAB40000 100 100 88",
  "@teleloc 0xABB40000 60 60 92",
  "@teleloc 0xAAB20000 80 100 88",
];

(async () => {
  console.log(`Loading: ${PAGE_URL}`);
  console.log(`Canvas: ${W}x${H} @ ${FPS}fps for ${(DURATION_MS / 1000).toFixed(1)}s`);
  console.log(`Walk: ${WALK_ENABLED}`);

  const browser = await chromium.launch({
    // Headed so the WebGL context uses the real GPU. Headless silently
    // fell back to a blank software context (smoke webm was 77KB for
    // 30s, which is impossible for real rendered content).
    headless: false,
    args: [
      `--window-size=${W},${H}`,
      "--window-position=0,0",
      "--start-maximized",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      // Prevent Chrome from throttling rAF when the window isn't focused
      // / is occluded / runs in the background. Headed Chromium launched
      // from schtasks gets no user focus, so without these the rAF
      // pump pauses and Three.js stops drawing — captureStream then
      // sees an empty buffer.
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-features=CalculateNativeWinOcclusion",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
  });
  const page = await context.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "error" || /\[rec\]/i.test(msg.text())) {
      console.log(`  [browser ${msg.type()}] ${msg.text().slice(0, 240)}`);
    }
  });
  page.on("pageerror", (err) => console.log(`  [pageerror] ${err.message}`));

  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => /PASS/.test(document.getElementById("results")?.innerHTML || ""),
    { timeout: 90_000 },
  );
  console.log("smoke PASS");

  await page.fill('input[name="account"]', ACCOUNT);
  await page.fill('input[name="password"]', PASSWORD);
  await page.fill('input[name="bridge_url"]', BRIDGE_URL);
  await page.fill('input[name="server_host"]', SERVER_IP);
  await page.fill('input[name="server_port"]', SERVER_PORT);
  let loggedIn = false;
  for (let attempt = 1; attempt <= 3 && !loggedIn; attempt++) {
    await page.click('#login-form button[type=submit]');
    try {
      await page.waitForSelector("#selection:not([hidden])", { timeout: 45_000 });
      loggedIn = true;
    } catch (e) {
      console.log(`  login attempt ${attempt} timed out; retrying after 12 s`);
      await page.waitForTimeout(12_000);
    }
  }
  if (!loggedIn) throw new Error("login failed");
  console.log("logged in");

  if ((await page.locator('#character-ul button[data-id]').count()) === 0) {
    const charName = `Rec${Date.now().toString(36).slice(-6)}`;
    await page.fill('#create-form input[name="char_name"]', charName);
    await page.click('#create-button');
    await page.waitForFunction(
      () => /Created\b/.test(document.getElementById("create-status")?.innerText || ""),
      { timeout: 30_000 },
    );
    await page.waitForFunction(
      () => document.querySelectorAll('#character-ul button[data-id]').length > 0,
      { timeout: 10_000 },
    );
  }
  await page.locator('#character-ul button[data-id]').first().click();
  await page.waitForFunction(
    () => /InWorld|Spawned/.test(document.getElementById("login-status")?.innerText || ""),
    { timeout: 60_000 },
  );
  await page.waitForTimeout(6000);
  await page.evaluate(() => {
    try { window.__sessionHandle?.sendChat?.("/godly"); } catch (_) {}
  });
  console.log("spawned + /godly");

  console.log("waiting up to 180s for liveScene3d.renderer...");
  await page.waitForFunction(
    () => !!window.liveScene3d?.renderer?.domElement,
    { timeout: 180_000, polling: 1000 },
  );
  console.log("renderer ready");
  await page.waitForTimeout(3000);

  // Force the canvas to fill the viewport. The page lays it out at
  // y=1777 (below all the login/select chrome), which puts it
  // off-screen — Chrome's compositor then skips painting it, and
  // canvas.captureStream returns empty frames. Pinning it to
  // position:fixed top:0 left:0 100%x100% z-index:9999 fixes this
  // without touching any page-side JS that watches resize events.
  await page.evaluate(({ w, h }) => {
    const cv = window.liveScene3d?.renderer?.domElement;
    if (!cv) return;
    cv.style.position = "fixed";
    cv.style.left = "0";
    cv.style.top = "0";
    cv.style.width = "100vw";
    cv.style.height = "100vh";
    cv.style.zIndex = "9999";
    // Hide everything else (login form / chrome) so we don't get a
    // UI overlay across the recording.
    for (const el of document.body.children) {
      if (el !== cv && el.tagName !== "SCRIPT") {
        el.style.display = "none";
      }
    }
    // Tell the renderer about the new size.
    const renderer = window.liveScene3d?.renderer;
    if (renderer) {
      renderer.setSize(w, h, false);
      const cam = window.liveScene3d?.cameraSwitcher?.activeCamera
        || window.liveScene3d?.camera;
      if (cam && cam.aspect !== undefined) {
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
      }
    }
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    window.scrollTo(0, 0);
  }, { w: W, h: H });
  console.log("canvas pinned to fullscreen viewport");

  // Belt-and-braces: install a setInterval that calls renderer.render
  // directly at 30Hz, bypassing the page's main rAF loop entirely.
  // If the page's tick is throttled for any reason (occlusion, focus),
  // this keeps the canvas's drawing buffer fresh so captureStream
  // sees real frames.
  await page.evaluate(() => {
    const live = window.liveScene3d;
    const renderer = live?.renderer;
    const scene = live?.scene;
    const cam = live?.cameraSwitcher?.activeCamera || live?.camera;
    if (!renderer || !scene || !cam) {
      console.warn("[rec] forced-render: missing renderer/scene/camera");
      return;
    }
    window.__forcedRender = setInterval(() => {
      try { renderer.render(scene, cam); }
      catch (e) { /* swallow per-frame errors */ }
    }, 33);
    console.log("[rec] forced renderer.render loop @30fps installed");
  });
  await page.waitForTimeout(2000);

  // Start the canvas recorder INSIDE the page, then exit eval. The
  // recorder runs to completion; we wait outside.
  const startResult = await page.evaluate(({ waypoints, durationMs, walkEnabled, fps }) => {
    const canvas = window.liveScene3d?.renderer?.domElement;
    if (!canvas) return { ok: false, err: "no renderer.domElement" };
    if (typeof canvas.captureStream !== "function") {
      return { ok: false, err: "canvas.captureStream not supported" };
    }

    // Pitch camera UP every 100ms.
    const pitchUp = () => {
      const cam = window.liveScene3d?.cameraSwitcher?.activeCamera
        || window.liveScene3d?.camera;
      if (!cam) return;
      try {
        cam.up.set(0, 1, 0);
        cam.lookAt(cam.position.x, cam.position.y + 1000, cam.position.z);
      } catch (_) {}
    };
    window.__pitchUpInterval = setInterval(pitchUp, 100);
    pitchUp();

    // Walk loop.
    let walkIdx = 0;
    if (walkEnabled) {
      const send = (cmd) => {
        try { window.__sessionHandle?.sendChat?.(cmd); } catch (_) {}
      };
      send(waypoints[0]);
      walkIdx = 1;
      window.__walkInterval = setInterval(() => {
        send(waypoints[walkIdx % waypoints.length]);
        walkIdx += 1;
      }, 60_000);
    }

    // Canvas capture stream → MediaRecorder.
    const stream = canvas.captureStream(fps);
    const mime = MediaRecorder.isTypeSupported("video/webm; codecs=vp9")
      ? "video/webm; codecs=vp9"
      : (MediaRecorder.isTypeSupported("video/webm; codecs=vp8")
         ? "video/webm; codecs=vp8"
         : "video/webm");
    const recorder = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: 8_000_000,
    });
    window.__recChunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) window.__recChunks.push(e.data);
    };
    recorder.onerror = (e) => console.error("[rec] recorder error:", e?.error);
    window.__recorder = recorder;
    recorder.start(1000); // flush a chunk every 1 s
    console.log(`[rec] started ${mime} at ${fps}fps`);

    // Stop everything after durationMs.
    window.__recDone = new Promise((resolve) => {
      setTimeout(() => {
        clearInterval(window.__pitchUpInterval);
        if (window.__walkInterval) clearInterval(window.__walkInterval);
        recorder.onstop = () => resolve(true);
        recorder.stop();
        console.log(`[rec] stopped`);
      }, durationMs);
    });

    return { ok: true, mime };
  }, { waypoints: WAYPOINTS, durationMs: DURATION_MS, walkEnabled: WALK_ENABLED, fps: FPS });

  if (!startResult.ok) {
    console.error(`FATAL: recorder didn't start: ${startResult.err}`);
    await browser.close();
    process.exit(2);
  }
  console.log(`recorder started: ${startResult.mime}`);

  // Wait for the recorder to finish — plus a few seconds of slack for
  // the final chunk to flush.
  const startMs = Date.now();
  while (Date.now() - startMs < DURATION_MS + 5000) {
    await page.waitForTimeout(15_000);
    const t = ((Date.now() - startMs) / 1000).toFixed(0);
    const state = await page.evaluate(() => ({
      chunks: window.__recChunks?.length ?? 0,
      bytes: (window.__recChunks ?? []).reduce((a, b) => a + (b?.size || 0), 0),
      camPos: (() => {
        const c = window.liveScene3d?.cameraSwitcher?.activeCamera;
        return c ? `${c.position.x|0},${c.position.y|0},${c.position.z|0}` : null;
      })(),
    }));
    console.log(`  t=${t}s  chunks=${state.chunks}  bytes=${state.bytes}  camPos=${state.camPos}`);
  }

  // Wait for the final stop + then pull the chunks as a single base64 blob.
  await page.evaluate(() => window.__recDone);
  console.log("recorder finished — pulling chunks");

  // The Blob is too large to transfer through page.evaluate's return path
  // for long recordings. Instead, we expose the chunks via a download.
  const dlPromise = page.waitForEvent("download", { timeout: 30_000 });
  await page.evaluate(() => {
    const blob = new Blob(window.__recChunks, { type: "video/webm" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `canvas-rec-${Date.now()}.webm`;
    document.body.appendChild(a);
    a.click();
  });
  const dl = await dlPromise;
  const suffix = WALK_ENABLED ? "walk" : "stationary";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(OUT_DIR, `canvas-${suffix}-${stamp}.webm`);
  await dl.saveAs(outPath);
  console.log(`video saved: ${outPath}`);

  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error("FATAL:", err?.stack || err?.message || err);
  process.exit(2);
});

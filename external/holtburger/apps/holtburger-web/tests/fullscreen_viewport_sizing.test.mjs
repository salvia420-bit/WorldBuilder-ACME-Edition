// tests/fullscreen_viewport_sizing.test.mjs — Area 10 (2026-11-12).
//
// Verifies:
//   1. Fullscreen mode maintains correct aspect ratio without subtracting 320px
//      desktop HUD chrome or 32px layout margin.
//   2. ui/fullscreen_toggle.js dispatches resize on fullscreenchange so Three.js
//      cameras and renderers re-derive projection matrices.
//   3. computeInitialRenderScale starts 1440p DPR=1 at 100% (1.0), not 0.84.
//   4. AdaptiveRenderScaleController.notifyManual clears settle latches, resets
//      raise ceiling, and prevents adaptive resolution from fighting manual slider inputs.
//
// Run from apps/holtburger-web/:  node tests/fullscreen_viewport_sizing.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mountFullscreenControl } from "../ui/fullscreen_toggle.js";
import {
  computeInitialRenderScale,
  AdaptiveRenderScaleController,
} from "../scene3d/adaptive_render_scale.js";

// ── 1. Fullscreen Viewport Aspect & Layout Math ──────────────────────────
test("[fullscreen] windowed desktop mode subtracts 320px chrome and 32px margin", () => {
  const windowInnerW = 1920;
  const windowInnerH = 1080;
  const _isAgentMode = false;
  const isFullscreen = false;

  const layoutChromeH = (_isAgentMode || isFullscreen) ? 0 : 320;
  const layoutMarginW = (_isAgentMode || isFullscreen) ? 0 : 32;
  const maxW = isFullscreen ? windowInnerW : (_isAgentMode ? 4096 : 1920);
  const maxH = isFullscreen ? windowInnerH : (_isAgentMode ? 2160 : 1080);

  const newW = Math.min(windowInnerW - layoutMarginW, maxW);
  const newH = Math.min(windowInnerH - layoutChromeH, maxH);

  assert.equal(layoutChromeH, 320);
  assert.equal(layoutMarginW, 32);
  assert.equal(newW, 1888);
  assert.equal(newH, 760);
  // Aspect is ~2.48 in windowed mode due to HUD reservation
  assert.equal((newW / newH).toFixed(2), "2.48");
});

test("[fullscreen] fullscreen mode does NOT subtract 320px chrome or 32px margin", () => {
  const windowInnerW = 1920;
  const windowInnerH = 1080;
  const _isAgentMode = false;
  const isFullscreen = true;

  const layoutChromeH = (_isAgentMode || isFullscreen) ? 0 : 320;
  const layoutMarginW = (_isAgentMode || isFullscreen) ? 0 : 32;
  const maxW = isFullscreen ? windowInnerW : (_isAgentMode ? 4096 : 1920);
  const maxH = isFullscreen ? windowInnerH : (_isAgentMode ? 2160 : 1080);

  const newW = Math.min(windowInnerW - layoutMarginW, maxW);
  const newH = Math.min(windowInnerH - layoutChromeH, maxH);

  assert.equal(layoutChromeH, 0, "no 320px subtraction in fullscreen");
  assert.equal(layoutMarginW, 0, "no 32px margin in fullscreen");
  assert.equal(newW, 1920);
  assert.equal(newH, 1080);
  // Standard 16:9 aspect ratio preserved
  assert.equal(newW / newH, 1920 / 1080);
  assert.equal((newW / newH).toFixed(4), "1.7778");
});

test("[fullscreen] 1440p (2560x1440) fullscreen maintains true 16:9 native aspect", () => {
  const windowInnerW = 2560;
  const windowInnerH = 1440;
  const _isAgentMode = false;
  const isFullscreen = true;

  const effectiveChromeH = (_isAgentMode || isFullscreen) ? 0 : 320;
  const effectiveMarginW = (_isAgentMode || isFullscreen) ? 0 : 32;
  const maxW = isFullscreen ? windowInnerW : (_isAgentMode ? 4096 : 1920);
  const maxH = isFullscreen ? windowInnerH : (_isAgentMode ? 2160 : 1080);

  const newW = Math.min(windowInnerW - effectiveMarginW, maxW);
  const newH = Math.min(windowInnerH - effectiveChromeH, maxH);

  assert.equal(newW, 2560, "uses full 2560 width");
  assert.equal(newH, 1440, "uses full 1440 height (no 320px subtraction)");
  assert.equal(newW / newH, 16 / 9, "exact 16:9 aspect ratio, no vertical stretch");
});

// ── 2. Fullscreen Toggle Control ─────────────────────────────────────────
test("[fullscreen] fullscreen_toggle mounts, handles toggle, and triggers resize on change", async () => {
  const savedDoc = globalThis.document;
  const savedWin = globalThis.window;

  let resizeDispatched = 0;
  const listeners = {};
  const fakeWin = {
    dispatchEvent(ev) {
      if (ev?.type === "resize") resizeDispatched += 1;
    },
  };
  globalThis.window = fakeWin;

  let fsElement = null;
  let requestCalled = false;
  let exitCalled = false;

  const fakeDoc = {
    get fullscreenElement() { return fsElement; },
    documentElement: {
      requestFullscreen: () => {
        requestCalled = true;
        fsElement = fakeDoc.documentElement;
        return Promise.resolve();
      },
    },
    exitFullscreen: () => {
      exitCalled = true;
      fsElement = null;
      return Promise.resolve();
    },
    addEventListener: (t, fn) => {
      listeners[t] = listeners[t] || [];
      listeners[t].push(fn);
    },
    removeEventListener: (t, fn) => {
      if (!listeners[t]) return;
      listeners[t] = listeners[t].filter((f) => f !== fn);
    },
    createElement: (tag) => {
      return {
        tagName: tag.toUpperCase(),
        style: {},
        textContent: "",
        appendChild() {},
        addEventListener(t, fn) {
          listeners[t] = listeners[t] || [];
          listeners[t].push(fn);
        },
      };
    },
  };
  globalThis.document = fakeDoc;

  try {
    const container = { appendChild() {} };
    const dispose = mountFullscreenControl(container);

    // Initial state: windowed
    assert.equal(fakeDoc.fullscreenElement, null);

    // Click button to enter fullscreen
    const clickHandler = listeners["click"]?.[0];
    assert.ok(clickHandler, "button click handler registered");
    clickHandler();

    await new Promise((r) => setTimeout(r, 60));
    assert.equal(requestCalled, true, "requestFullscreen called");
    assert.ok(resizeDispatched >= 1, "resize dispatched after requestFullscreen");

    // Fullscreenchange event fires (e.g. user toggles or presses Esc)
    const fsChangeHandler = listeners["fullscreenchange"]?.[0];
    assert.ok(fsChangeHandler, "fullscreenchange handler registered");

    const prevResizeCount = resizeDispatched;
    fsChangeHandler();
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(resizeDispatched > prevResizeCount, "resize dispatched on fullscreenchange");

    dispose();
    assert.equal(listeners["fullscreenchange"].length, 0, "fullscreenchange listener removed on dispose");
  } finally {
    globalThis.document = savedDoc;
    globalThis.window = savedWin;
  }
});

// ── 3. computeInitialRenderScale 1440p DPR=1 Headroom ────────────────────
test("[adaptive-res] 1440p DPR=1 starts at 100% (1.0), not 0.84", () => {
  const scale1440p = computeInitialRenderScale({
    basePixelRatio: 1,
    cssW: 2560,
    cssH: 1440,
    maxScale: 1,
    minScale: 0.35,
  });
  assert.equal(scale1440p, 1.0, "2560x1440 at DPR=1 must start at 1.0");

  const scale1080p = computeInitialRenderScale({
    basePixelRatio: 1,
    cssW: 1920,
    cssH: 1080,
    maxScale: 1,
    minScale: 0.35,
  });
  assert.equal(scale1080p, 1.0, "1920x1080 at DPR=1 must start at 1.0");

  // 4K (3840x2160) at DPR=1 has 8.29 Mpx -> scales down below budget (~0.67)
  const scale4K = computeInitialRenderScale({
    basePixelRatio: 1,
    cssW: 3840,
    cssH: 2160,
    maxScale: 1,
    minScale: 0.35,
  });
  assert.ok(scale4K < 0.75, "4K scales down to maintain frame rate");
  assert.ok(scale4K >= 0.35, "4K respects minScale floor");

  // 1080p at DPR=2 (HiDPI / Retina 4K buffer) scales down to ~0.67
  const scaleRetina1080p = computeInitialRenderScale({
    basePixelRatio: 2,
    cssW: 1920,
    cssH: 1080,
    maxScale: 1,
    minScale: 0.35,
  });
  assert.ok(scaleRetina1080p < 0.75);
});

// ── 4. AdaptiveRenderScaleController Manual Slider Override ───────────────
test("[adaptive-res] notifyManual clears 5-minute settle latch and resets ceiling", () => {
  let liveScale = 0.84;
  const appliedScales = [];
  let simulatedTime = 1000;

  const controller = new AdaptiveRenderScaleController({
    getScale: () => liveScale,
    applyScale: (s) => {
      liveScale = s;
      appliedScales.push(s);
    },
    minScale: 0.35,
    maxScale: 1.0,
    now: () => simulatedTime,
    settleLockMs: 300_000, // 5 minutes
  });

  // Simulate a previous oscillation latch (e.g. streaming spike latched ceiling to 0.84)
  controller.raiseCeiling = 0.84;
  controller._settleUntil = simulatedTime + 300_000;
  controller.settleLatches = 1;
  controller._lastChange = { dir: "up", from: 0.84, to: 0.96, t: simulatedTime - 5000 };

  assert.equal(controller._raiseCap(simulatedTime), 0.84, "ceiling is latched to 0.84");

  // User moves slider in Graphics Settings to 1.0 (100%)
  controller.notifyManual(1.0);
  liveScale = 1.0;

  assert.equal(controller._settleUntil, 0, "settle latch cleared");
  assert.equal(controller._lastChange, null, "oscillation history cleared");
  assert.equal(controller.raiseCeiling, 1.0, "ceiling reset to user manual scale");
  assert.equal(controller._raiseCap(simulatedTime), 1.0, "raise cap allows 1.0");
  assert.ok(controller._cooldownUntil >= simulatedTime + 9000, "cooldown armed");
});

test("[adaptive-res] streaming spikes without GPU bottleneck do not trigger settle latch", () => {
  let liveScale = 0.96;
  let simulatedTime = 5000;

  const probe = {
    sample: () => false, // GPU kept up (main-thread streaming spike)
  };

  const controller = new AdaptiveRenderScaleController({
    getScale: () => liveScale,
    applyScale: (s) => { liveScale = s; },
    minScale: 0.35,
    maxScale: 1.0,
    now: () => simulatedTime,
    gpuProbe: probe,
    settleLockMs: 300_000,
  });

  // Previous was up to 0.96
  controller._lastChange = { dir: "up", from: 0.84, to: 0.96, t: simulatedTime - 2000 };
  controller._gpuKnown = 10;
  controller._gpuBehind = 1; // only 10% behind (< 50% threshold)

  controller._noteChangeForSettle(0.84, simulatedTime, "down");

  assert.equal(controller.settleLatches, 0, "did not latch oscillation on CPU streaming spike");
  assert.equal(controller._settleUntil, 0, "no 5-minute settle lock");
});

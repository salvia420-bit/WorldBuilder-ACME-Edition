// tests/gpu_tier_probe_memo.test.mjs — `detectGpuTier` probes once per page (2026-10-09).
//
// `getQuality()` runs the GPU-tier probe on every call and every surface
// material calls `getQuality()` (materials.js POM patch): a cold academy spawn
// on the 1070 created ~290 throwaway WebGL contexts (1.4 s of main thread) and
// logged `[quality] gpu-probe` per material.
//
//   M1  three getQuality() calls → ONE probe context, one log line, same tier
//   M2  the test hook forgets the memo → the next call probes again
//
// Run: node tests/gpu_tier_probe_memo.test.mjs

import assert from "node:assert/strict";

let contexts = 0;
globalThis.document = {
  createElement: () => ({
    width: 0,
    height: 0,
    remove() {},
    getContext() {
      contexts++;
      return {
        getExtension: (n) => (n === "WEBGL_debug_renderer_info" ? { UNMASKED_RENDERER_WEBGL: 1 } : { loseContext() {} }),
        getParameter: () => "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      };
    },
  }),
};

const logs = [];
const origLog = console.log;
console.log = (...a) => { if (String(a[0]).startsWith("[quality] gpu-probe")) logs.push(a[0]); else origLog(...a); };
const { getQuality, detectGpuTier, _resetGpuTierProbeForTest } = await import("../scene3d/quality.js");

let failures = 0;
function t(name, fn) {
  try { fn(); origLog("  ok ", name); } catch (e) { failures++; origLog("  FAIL", name); origLog(e); }
}

t("M1 three getQuality() calls → one probe, one log, one tier", () => {
  _resetGpuTierProbeForTest();
  contexts = 0; logs.length = 0;
  const q = [1, 2, 3].map(() => getQuality("http://x/index.html", "Mozilla/5.0 (Windows NT 10.0)"));
  assert.equal(contexts, 1);
  assert.equal(logs.length, 1);
  assert.deepEqual(new Set(q.map((x) => x.preset)).size, 1);
  assert.equal(q[0].source, "gpu-probe");
});

t("M2 the test hook forgets the memo", () => {
  contexts = 0;
  detectGpuTier();
  assert.equal(contexts, 0);
  _resetGpuTierProbeForTest();
  detectGpuTier();
  assert.equal(contexts, 1);
});

console.log = origLog;
console.log(`\n${failures ? "FAIL" : "2 passed, 0 failed"}`);
process.exit(failures ? 1 : 0);

// test_trail_map.mjs — the shared stomp/footprint trail map (Wave 0B).
//
// Locks (docs/2026-07-31-terrain-vfx-plan.md §2.2, §3.1 "STOMP", §5, §8 risk 7):
//   L1  The centre is SNAPPED to the texel grid — a sub-texel move must not
//       shift the sampling phase (the documented anti-shimmer requirement).
//   L2  Recovery is LINEAR and frame-rate independent: `fadeAmountFor` sums to
//       exactly 1 over `recoverySec` regardless of how it is subdivided, and a
//       tab-resume `dt` spike clamps rather than going out of range.
//   L3  World→UV is exact and the out-of-footprint case is DETECTABLE (the
//       shader must read "no trail", never a clamped smear).
//   L4  A teleport (any move > one landblock in one frame) CLEARS the map —
//       otherwise a stomp scar appears at the arrival point.
//   L5  PING-PONG: `update()` swaps the read/write targets, and the uniform
//       consumers bind BY REFERENCE (`uniforms.uTrailMap`) follows the swap.
//       No pass ever reads and writes the same target.
//   L6  Headless (no renderer) is a supported mode: full CPU bookkeeping, zero
//       GPU allocation, no throw. That is what makes `?nullRender=1` free.
//   L7  The stamp queue is BOUNDED (MAX_STAMPS) and off-map stamps are dropped
//       — a Wave-1 family with a runaway loop cannot grow an array per frame.
//   L8  `resolveTrailMapConfig` is the gfx_relief house form: STRICT `on`/`off`
//       only, clamped numerics, and an unrecognised value does NOT enable.
//   L9  The GLSL never uses the banned per-instance idioms and reads only its
//       own previous target + the stamp uniforms.
//
// Run from apps/holtburger-web/:  node test_trail_map.mjs
// (`three` resolves as a bare import via node_modules — needed for the real
// WebGLRenderTarget/ShaderMaterial path in L5/L6.)

import * as THREE from "three";
import {
  MAX_STAMPS,
  TRAIL_DEFAULTS,
  texelSizeM,
  snapCenterToTexel,
  fadeAmountFor,
  trailUvFor,
  trailCovers,
  isTeleportJump,
  resolveTrailMapConfig,
  createTrailMap,
  TRAIL_VERTEX_SHADER,
  TRAIL_FRAGMENT_SHADER,
} from "./scene3d/trail_map.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
console.log("\n-- L1: texel snap (anti-shimmer) --");
const texel = texelSizeM(48, 256);
check("256² over 96 m ⇒ 0.375 m/texel", near(texel, 0.375), String(texel));
check("snap(0) === 0", snapCenterToTexel(0, texel) === 0);
check("a sub-texel drift snaps to the SAME centre",
  snapCenterToTexel(10.0, texel) === snapCenterToTexel(10.0 + texel * 0.4, texel),
  `${snapCenterToTexel(10.0, texel)} vs ${snapCenterToTexel(10.0 + texel * 0.4, texel)}`);
check("a full-texel move snaps to the NEXT centre",
  !near(snapCenterToTexel(10.0, texel), snapCenterToTexel(10.0 + texel, texel)));
check("every snapped centre is an exact multiple of the texel",
  [0, 1.3, -7.77, 191.4, 4096.9].every((v) => near((snapCenterToTexel(v, texel) / texel) % 1, 0, 1e-9)));
check("snap survives a non-finite input", snapCenterToTexel(NaN, texel) === 0);
check("snap survives a zero texel (returns the input)", snapCenterToTexel(3.5, 0) === 3.5);

// ---------------------------------------------------------------------------
console.log("\n-- L2: linear, frame-rate-independent recovery --");
check("full recovery in one dt === recoverySec", near(fadeAmountFor(4, 4), 1));
check("half recovery at dt = recoverySec/2", near(fadeAmountFor(2, 4), 0.5));
{
  // Subdivide the same wall-clock interval differently; the total fade must
  // match, or "recovery ≈ 4 s" would be an fps-dependent lie.
  const total = (n) => {
    let s = 0;
    for (let i = 0; i < n; i += 1) s += fadeAmountFor(4 / n, 4);
    return s;
  };
  check("60 small steps and 4 big steps fade the SAME total",
    near(total(60), total(4), 1e-12), `${total(60)} vs ${total(4)}`);
}
check("a tab-resume dt spike CLAMPS to 1 (never > 1)", fadeAmountFor(9999, 4) === 1);
check("negative/NaN dt fades nothing", fadeAmountFor(-1, 4) === 0 && fadeAmountFor(NaN, 4) === 0);
check("recoverySec <= 0 ⇒ instant recovery (1), not a divide-by-zero",
  fadeAmountFor(0.016, 0) === 1 && Number.isFinite(fadeAmountFor(0.016, -3)));

// ---------------------------------------------------------------------------
console.log("\n-- L3: world → UV, and the out-of-footprint case --");
{
  const c = trailUvFor(100, 200, 100, 200, 48);
  check("the centre maps to UV (0.5, 0.5)", near(c.x, 0.5) && near(c.y, 0.5));
  const e = trailUvFor(100 + 48, 200 - 48, 100, 200, 48);
  check("the corner maps to UV (1, 0)", near(e.x, 1) && near(e.y, 0));
  const o = trailUvFor(100 + 60, 200, 100, 200, 48);
  check("outside the footprint yields a UV OUTSIDE [0,1] (detectable)", o.x > 1, String(o.x));
  const out = { x: 0, y: 0 };
  check("the `out` form is zero-alloc and returns the same object",
    trailUvFor(100, 200, 100, 200, 48, out) === out && near(out.x, 0.5));
  check("trailCovers agrees with the UV bounds",
    trailCovers(100, 200, 100, 200, 48) === true
    && trailCovers(160, 200, 100, 200, 48) === false);
}

// ---------------------------------------------------------------------------
console.log("\n-- L4: teleport detection --");
check("a 6 m/s walk step is NOT a teleport", isTeleportJump(0, 0, 0.1, 0, 192) === false);
check("a whole landblock IS a teleport", isTeleportJump(0, 0, 200, 0, 192) === true);
check("diagonal magnitude is used, not per-axis",
  isTeleportJump(0, 0, 140, 140, 192) === true, "|(140,140)| ≈ 198 > 192");
check("default threshold is one landblock", TRAIL_DEFAULTS.teleportJumpM === 192);

// ---------------------------------------------------------------------------
console.log("\n-- L8: config resolution (the gfx_relief house form) --");
{
  const warns = [];
  const realWarn = console.warn;
  const cfgOf = (readers) => resolveTrailMapConfig(readers);

  check("no readers ⇒ disabled, defaults", (() => {
    const c = cfgOf({});
    return c.enabled === false
      && c.resolution === TRAIL_DEFAULTS.resolution
      && c.radiusM === TRAIL_DEFAULTS.radiusM
      && c.recoverySec === TRAIL_DEFAULTS.recoverySec;
  })());
  check("enabled reader true ⇒ enabled", cfgOf({ enabled: () => true }).enabled === true);
  check("a truthy NON-boolean does NOT enable (strict === true)",
    cfgOf({ enabled: () => 1 }).enabled === false);
  check("a throwing reader fails CLOSED", cfgOf({ enabled: () => { throw new Error("x"); } }).enabled === false);
  check("resolution is clamped + rounded",
    cfgOf({ resolution: () => 99999 }).resolution === 2048
    && cfgOf({ resolution: () => 1 }).resolution === 16
    && cfgOf({ resolution: () => 257.6 }).resolution === 258);
  check("radius is clamped", cfgOf({ radiusM: () => 0 }).radiusM === 4
    && cfgOf({ radiusM: () => 1e6 }).radiusM === 512);
  check("recovery is clamped", cfgOf({ recoverySec: () => 0 }).recoverySec === 0.05
    && cfgOf({ recoverySec: () => 1e6 }).recoverySec === 300);
  check("a NaN numeric reader falls back to the default",
    cfgOf({ resolution: () => NaN }).resolution === TRAIL_DEFAULTS.resolution);
  console.warn = realWarn;
  void warns;
}

// ---------------------------------------------------------------------------
console.log("\n-- L6/L7: headless (no renderer) is a first-class mode --");
{
  const t = createTrailMap({ resolution: 64, radiusM: 32, recoverySec: 2 });
  check("no THREE/renderer ⇒ no GPU resources", t.hasGpu === false && t.texture === null);
  check("uniforms still exist (families bind by reference)",
    !!t.uniforms.uTrailMap && t.uniforms.uTrailEnabled.value === 0);
  t.update(0.016, 100, 100);
  check("update() does not throw headless and centres", t.stats().centered === true);
  check("the centre is snapped headless too",
    near((t.stats().centerX / t.stats().texelM) % 1, 0, 1e-9));

  // L7 — bounded queue.
  for (let i = 0; i < MAX_STAMPS + 20; i += 1) t.stamp(100, 100, 0.5, 1);
  check(`queue is bounded at MAX_STAMPS (${MAX_STAMPS})`, t._pending.length === MAX_STAMPS,
    String(t._pending.length));
  check("over-budget stamps are counted as dropped, not thrown",
    t.stats().stampsDropped === 20, String(t.stats().stampsDropped));
  t.update(0.016, 100, 100);
  check("update() drains the queue", t._pending.length === 0);
  check("drawn stamps are counted", t.stats().stampsDrawn === MAX_STAMPS);

  const before = t.stats().stampsDropped;
  t.stamp(100 + 1000, 100, 0.5, 1);
  check("an off-map stamp is dropped, not queued",
    t._pending.length === 0 && t.stats().stampsDropped === before + 1);
  check("a non-finite stamp is rejected outright", t.stamp(NaN, 5) === false);

  // L4 live.
  const clearsBefore = t.stats().clears;
  t.update(0.016, 100 + 500, 100);
  check("a teleport-sized recentre CLEARS the map",
    t.stats().teleportClears === 1 && t.stats().clears === clearsBefore + 1);
  t.update(0.016, 100 + 500.2, 100);
  check("a normal step does NOT clear", t.stats().teleportClears === 1);

  t.dispose();
  check("dispose() is safe headless", true);
}

// ---------------------------------------------------------------------------
console.log("\n-- L5: ping-pong with a real THREE render target --");
{
  // A minimal renderer stand-in: the real WebGLRenderTarget/ShaderMaterial are
  // constructed (they are pure JS state until a GL context touches them); only
  // the draw call is recorded.
  const calls = { setRenderTarget: [], render: 0, clear: 0 };
  const fakeRenderer = {
    autoClear: true,
    _rt: null,
    getRenderTarget() { return this._rt; },
    setRenderTarget(rt) { this._rt = rt; calls.setRenderTarget.push(rt); },
    setClearColor() {},
    clear() { calls.clear += 1; },
    render() { calls.render += 1; },
  };
  const t = createTrailMap({ THREE, renderer: fakeRenderer, resolution: 32, radiusM: 16, recoverySec: 2 });
  check("a THREE + renderer pair allocates the GPU path", t.hasGpu === true);
  check("uTrailMap is bound to a real texture", !!t.texture && t.uniforms.uTrailMap.value === t.texture);
  check("uTrailEnabled reports 1", t.uniforms.uTrailEnabled.value === 1);

  const tex0 = t.texture;
  t.stamp(5, 5, 1, 1);
  t.update(0.016, 0, 0);
  check("update() issued exactly one render", calls.render === 1);
  check("PING-PONG: the exposed texture CHANGED after one update",
    t.texture !== tex0 && !!t.texture);
  check("uniforms.uTrailMap followed the swap (bound by reference)",
    t.uniforms.uTrailMap.value === t.texture);
  t.update(0.016, 0, 0);
  check("PING-PONG returns to the first target on the second update",
    t.texture === tex0, "two targets, alternating");

  check("the render target was restored after the pass",
    calls.setRenderTarget[calls.setRenderTarget.length - 1] === null);
  check("autoClear was restored", fakeRenderer.autoClear === true);

  const before = calls.clear;
  t.clear("teleport");
  check("clear() wipes BOTH targets", calls.clear === before + 2);

  // A fake renderer that throws must not break the client.
  const boom = { ...fakeRenderer, render() { throw new Error("context lost"); } };
  const t2 = createTrailMap({ THREE, renderer: boom, resolution: 32 });
  let threw = false;
  try { t2.update(0.016, 0, 0); } catch (_) { threw = true; }
  check("a throwing renderer is fail-soft (a dropped frame, not a dead client)", threw === false);
  t2.dispose();

  t.dispose();
  check("dispose() drops the texture", t.texture === null && t.hasGpu === false);
}

// ---------------------------------------------------------------------------
console.log("\n-- L9: the GLSL --");
{
  const src = TRAIL_VERTEX_SHADER + TRAIL_FRAGMENT_SHADER;
  check("the fragment shader re-projects through the PREVIOUS centre (scroll, not smear)",
    /uPrevCenter/.test(TRAIL_FRAGMENT_SHADER));
  check("it bounds-checks prevUv instead of clamping",
    /prevUv\.x >= 0\.0/.test(TRAIL_FRAGMENT_SHADER) && !/ClampToEdge/.test(TRAIL_FRAGMENT_SHADER));
  check("the fade is subtracted and floored at 0",
    /max\(0\.0, texture2D\(uPrev, prevUv\)\.r - uFade\)/.test(TRAIL_FRAGMENT_SHADER));
  check(`the stamp loop is bounded by the MAX_STAMPS constant (${MAX_STAMPS})`,
    TRAIL_FRAGMENT_SHADER.includes(`uStamps[${MAX_STAMPS}]`)
    && TRAIL_FRAGMENT_SHADER.includes(`i < ${MAX_STAMPS}`));
  check("no backticks inside GLSL comments (house rule)", !/\/\/[^\n]*`/.test(src));
  check("reads no scene texture, no depth, no camera — only its own target",
    !/tDepth|cameraPosition|logDepth/.test(src));
}

// ---------------------------------------------------------------------------
console.log(`\ntrail map: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

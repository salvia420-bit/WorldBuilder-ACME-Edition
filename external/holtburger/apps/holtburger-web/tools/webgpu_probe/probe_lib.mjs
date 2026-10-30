// tools/webgpu_probe/probe_lib.mjs — pure helpers of the standalone WebGPU capability probe
// (round 3 R3-1 / R3-12 input, 2026-10-30). No DOM, no GPU: the page (probe.js) and the node suite
// (scripts/perf-worker/tests/hb_v2.test.mjs) both import it.

/** Features R3-12 asks about (plan §3 R3-1 "WebGPU capability probe"). */
export const FEATURES_OF_INTEREST = Object.freeze([
  "texture-compression-bc", "timestamp-query", "chromium-experimental-multi-draw-indirect", "indirect-first-instance",
  "shader-f16", "float32-filterable", "rg11b10ufloat-renderable", "bgra8unorm-storage", "depth-clip-control",
  "chromium-experimental-timestamp-query-inside-passes", "subgroups", "dual-source-blending",
]);

/** Limits R3-12 asks about: texture arrays, storage buffers, bind groups, uniform offsets. */
export const LIMITS_OF_INTEREST = Object.freeze([
  "maxTextureArrayLayers", "maxTextureDimension2D", "maxStorageBufferBindingSize", "maxStorageBuffersPerShaderStage",
  "maxBufferSize", "maxUniformBufferBindingSize", "maxBindGroups", "maxSampledTexturesPerShaderStage",
  "maxSamplersPerShaderStage", "maxComputeWorkgroupStorageSize", "maxComputeInvocationsPerWorkgroup",
  "maxVertexBuffers", "maxVertexAttributes", "minUniformBufferOffsetAlignment", "minStorageBufferOffsetAlignment",
  "maxColorAttachments", "maxDynamicUniformBuffersPerPipelineLayout", "maxDynamicStorageBuffersPerPipelineLayout",
]);

/** The limits of interest present on a GPUSupportedLimits-like object, plus every other numeric one under `other`. */
export function pickLimits(limits) {
  const out = {}, other = {};
  if (!limits) return { picked: out, other };
  for (const k of LIMITS_OF_INTEREST) if (typeof limits[k] === "number") out[k] = limits[k];
  // GPUSupportedLimits exposes its values as prototype getters: walk the chain, not own keys
  for (let p = limits; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const k of Object.getOwnPropertyNames(p)) {
      if (k === "constructor" || k in out || k in other) continue;
      let v; try { v = limits[k]; } catch (_) { continue; }
      if (typeof v === "number") other[k] = v;
    }
  }
  return { picked: out, other };
}

/** Feature set (setlike or array) -> sorted array + the of-interest map (name -> bool). */
export function featureReport(features) {
  const all = features ? [...features].map(String).sort() : [];
  const has = Object.fromEntries(FEATURES_OF_INTEREST.map((f) => [f, all.includes(f)]));
  return { all, has };
}

/** {n, mean, p50, p95, max} (ms, 3 decimals) of finite numbers; null when empty. */
export function statsMs(arr) {
  const a = (arr || []).filter((x) => typeof x === "number" && Number.isFinite(x));
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), n = s.length;
  const q = (p) => +s[Math.min(n - 1, Math.floor(p * n))].toFixed(3);
  return { n, mean: +(a.reduce((x, y) => x + y, 0) / n).toFixed(3), p50: q(0.5), p95: q(0.95), max: +s[n - 1].toFixed(3) };
}

/** Per-draw costs of a mode summary: µs per draw of CPU submit and of GPU time. */
export function perDraw(mode, draws) {
  if (!mode || !draws) return null;
  const c = mode.cpuMs && mode.cpuMs.p50, g = mode.gpuMs && mode.gpuMs.p50;
  return { cpuUsPerDraw: c != null ? +((c * 1000) / draws).toFixed(3) : null, gpuUsPerDraw: g != null ? +((g * 1000) / draws).toFixed(3) : null };
}

/** The bench shader: one dynamic-offset uniform per draw moves a 36-index cube. */
export function benchWgsl() {
  return `struct U { off: vec4f, };
@group(0) @binding(0) var<uniform> u: U;
struct VO { @builtin(position) pos: vec4f, @location(0) c: vec3f, };
@vertex fn vs(@location(0) p: vec3f) -> VO {
  var o: VO;
  o.pos = vec4f(p * 0.01 + u.off.xyz, 1.0);
  o.c = vec3f(0.5) + p * 0.5;
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f { return vec4f(i.c, 1.0); }
`;
}

/**
 * A terrain-sized fragment shader for the createRenderPipelineAsync timing: `taps` texture-array
 * samples blended by a height / slope weight, a normal from the samples, a sun + ambient term and
 * distance fog — roughly the instruction mix of our terrain material (12-20 taps per near pixel,
 * plan §1.5), so the compile time is representative, not the look.
 */
export function terrainWgsl(taps = 16) {
  const n = Math.max(1, taps | 0);
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(`  let s${i} = textureSample(layers, samp, uv * ${(1 + i * 0.37).toFixed(2)} + vec2f(${(i * 0.013).toFixed(3)}, ${(i * 0.029).toFixed(3)}), ${i % 8});`);
    lines.push(`  acc += s${i} * w(f32(${i}), i.h, i.slope);`);
  }
  return `struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) h: f32, @location(2) slope: f32, @location(3) dist: f32, @location(4) n: vec3f, };
@group(0) @binding(0) var layers: texture_2d_array<f32>;
@group(0) @binding(1) var samp: sampler;
struct Sun { dir: vec4f, col: vec4f, amb: vec4f, fog: vec4f, };
@group(0) @binding(2) var<uniform> sun: Sun;
fn w(k: f32, h: f32, slope: f32) -> f32 { return clamp(1.0 - abs(h * 0.1 - k * 0.0625) * 4.0, 0.0, 1.0) * mix(1.0, 0.25, smoothstep(0.4, 0.9, slope)); }
@vertex fn vs(@location(0) p: vec3f, @location(1) nrm: vec3f) -> VO {
  var o: VO;
  o.pos = vec4f(p.xy * 0.001, 0.5, 1.0);
  o.uv = p.xy * 0.04167; o.h = p.z; o.slope = 1.0 - nrm.z; o.dist = length(p); o.n = nrm;
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let uv = i.uv;
  var acc = vec4f(0.0);
${lines.join("\n")}
  let col = acc.rgb / max(acc.a + 1e-3, 1e-3);
  let ndl = max(dot(normalize(i.n), normalize(sun.dir.xyz)), 0.0);
  let lit = col * (sun.col.rgb * ndl + sun.amb.rgb);
  let f = clamp((i.dist - sun.fog.x) / max(sun.fog.y - sun.fog.x, 1.0), 0.0, 1.0);
  return vec4f(mix(lit, sun.fog.rgb * 0.0 + vec3f(0.6, 0.7, 0.8), f), 1.0);
}
`;
}

/** A unit cube: 8 positions (xyz) and 36 uint16 indices. */
export function cube() {
  const p = new Float32Array([-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1]);
  const i = new Uint16Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]);
  return { positions: p, indices: i };
}

/** The probe's per-draw offsets: N points on a grid in clip space (vec4 per draw, 256-byte stride). */
export function drawOffsets(n, strideFloats = 64) {
  const out = new Float32Array(n * strideFloats);
  const side = Math.ceil(Math.sqrt(n));
  for (let k = 0; k < n; k++) {
    out[k * strideFloats] = ((k % side) / side) * 1.8 - 0.9;
    out[k * strideFloats + 1] = (Math.floor(k / side) / side) * 1.8 - 0.9;
    out[k * strideFloats + 2] = 0.5;
    out[k * strideFloats + 3] = 1;
  }
  return out;
}

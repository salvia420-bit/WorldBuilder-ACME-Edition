// tools/webgpu_probe/probe.js — the standalone WebGPU capability probe page (round 3 R3-1, R3-12 input;
// 2026-10-30, lane H). Loaded by index.html; never imported by the client. Driver: run.mjs (box,
// off-screen, muted, fresh profile, no game page, no login).
//
// Records (plan §3 R3-1 "WebGPU capability probe"):
//   * adapter info, ALL features (texture-compression-bc, timestamp-query, whether
//     chromium-experimental-multi-draw-indirect is present ...) and limits (maxTextureArrayLayers,
//     storage-buffer limits ...);
//   * per-draw submission cost, three modes of N (default 1,000) draws of a 36-index cube, each moved
//     by its own dynamic uniform offset, `sec` seconds each, rotated over `rounds`:
//       gpu-draws   one render pass, N x (setBindGroup with offset + drawIndexed) encoded every frame;
//       gpu-bundle  the same N draws recorded ONCE in a render bundle, executeBundles every frame;
//       gl-draws    WebGL2, N x (uniform4f + drawElements) every frame;
//     main-thread ms per frame (encode + submit, performance.now) and GPU ms (WebGPU timestamp-query
//     when the feature exists; EXT_disjoint_timer_query_webgl2 for WebGL2); every measured window starts
//     with performance.mark `hbGPU:<mode>:r<round>` and ends with `hbGPU:gap`, so the driver's browser
//     trace gives CrGpuMain ms per mode (`hbreport.py trace-split --marks hbGPU:`);
//   * createRenderPipelineAsync wall time for one terrain-sized shader (probe_lib.mjs terrainWgsl).
// Result: window.__webgpuProbe = {state: "running" | "done" | "error", result}.
import { pickLimits, featureReport, statsMs, perDraw, benchWgsl, terrainWgsl, cube, drawOffsets } from "./probe_lib.mjs";

const Q = new URLSearchParams(location.search);
const N = Math.max(1, +(Q.get("draws") || 1000));
const SEC = Math.max(1, +(Q.get("sec") || 5));
const ROUNDS = Math.max(1, +(Q.get("rounds") || 2));
const W = 1280, H = 720;
const state = (window.__webgpuProbe = { state: "running", result: null });
const log = (s) => { const el = document.getElementById("log"); if (el) el.textContent += s + "\n"; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raf = () => new Promise((r) => requestAnimationFrame(r));

async function setupWebGPU(res) {
  if (!navigator.gpu) { res.webgpu = { available: false, reason: "navigator.gpu missing" }; return null; }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) { res.webgpu = { available: false, reason: "requestAdapter returned null" }; return null; }
  let info = adapter.info || null;
  if (!info && typeof adapter.requestAdapterInfo === "function") { try { info = await adapter.requestAdapterInfo(); } catch (_) { info = null; } }
  const feats = featureReport(adapter.features);
  res.webgpu = {
    available: true, isFallbackAdapter: !!adapter.isFallbackAdapter,
    info: info ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description } : null,
    features: feats.all, featuresOfInterest: feats.has, limits: pickLimits(adapter.limits),
    preferredCanvasFormat: navigator.gpu.getPreferredCanvasFormat(),
  };
  const want = ["timestamp-query"].filter((f) => feats.has[f]);
  const device = await adapter.requestDevice({ requiredFeatures: want });
  device.lost.then((l) => { res.errors.push(`device lost: ${l.reason} ${l.message}`); });
  device.addEventListener("uncapturederror", (e) => { if (res.errors.length < 50) res.errors.push(`uncaptured: ${e.error && e.error.message}`); });
  res.webgpu.deviceFeatures = [...device.features].sort();
  return { adapter, device, timestamps: want.includes("timestamp-query") };
}

function gpuBench(g, canvas) {
  const { device } = g;
  const ctx = canvas.getContext("webgpu");
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "opaque" });
  const c = cube();
  const vb = device.createBuffer({ size: c.positions.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(vb, 0, c.positions);
  const ib = device.createBuffer({ size: Math.ceil(c.indices.byteLength / 4) * 4, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(ib, 0, new Uint16Array([...c.indices, ...(c.indices.length % 2 ? [0] : [])]));
  const offs = drawOffsets(N, 64);
  const ub = device.createBuffer({ size: offs.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(ub, 0, offs);
  const bgl = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform", hasDynamicOffset: true } }] });
  const bg = device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: ub, size: 16 } }] });
  const module = device.createShaderModule({ code: benchWgsl() });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    vertex: { module, entryPoint: "vs", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list", cullMode: "none" },
  });
  const encodeDraws = (enc) => {
    enc.setPipeline(pipeline); enc.setVertexBuffer(0, vb); enc.setIndexBuffer(ib, "uint16");
    for (let k = 0; k < N; k++) { enc.setBindGroup(0, bg, [k * 256]); enc.drawIndexed(36); }
  };
  const be = device.createRenderBundleEncoder({ colorFormats: [format] });
  encodeDraws(be);
  const bundle = be.finish();
  let qs = null, resolveBuf = null;
  const readBufs = [];
  if (g.timestamps) {
    qs = device.createQuerySet({ type: "timestamp", count: 2 });
    resolveBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    for (let k = 0; k < 4; k++) readBufs.push({ buf: device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), busy: false });
  }
  return {
    frame(mode, gpuSink) {
      const t0 = performance.now();
      const enc = device.createCommandEncoder();
      const desc = { colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0.05, g: 0.05, b: 0.08, a: 1 } }] };
      if (qs) desc.timestampWrites = { querySet: qs, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
      const pass = enc.beginRenderPass(desc);
      if (mode === "gpu-bundle") pass.executeBundles([bundle]); else encodeDraws(pass);
      pass.end();
      let rb = null;
      if (qs) {
        enc.resolveQuerySet(qs, 0, 2, resolveBuf, 0);
        rb = readBufs.find((x) => !x.busy) || null;
        if (rb) enc.copyBufferToBuffer(resolveBuf, 0, rb.buf, 0, 16);
      }
      device.queue.submit([enc.finish()]);
      const cpu = performance.now() - t0;
      if (rb) {
        rb.busy = true;
        rb.buf.mapAsync(GPUMapMode.READ).then(() => {
          const v = new BigUint64Array(rb.buf.getMappedRange().slice(0));
          rb.buf.unmap(); rb.busy = false;
          const ns = Number(v[1] - v[0]);
          if (ns > 0 && ns < 1e9) gpuSink.push(ns / 1e6);
        }, () => { rb.busy = false; });
      }
      return cpu;
    },
  };
}

function glBench(canvas, res) {
  const gl = canvas.getContext("webgl2", { antialias: false });
  if (!gl) { res.webgl2 = { available: false }; return null; }
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  res.webgl2 = { available: true, renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), version: gl.getParameter(gl.VERSION) };
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, "#version 300 es\nin vec3 p; uniform vec4 uOff; out vec3 c; void main(){ gl_Position = vec4(p * 0.01 + uOff.xyz, 1.0); c = vec3(0.5) + p * 0.5; }"));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, "#version 300 es\nprecision mediump float; in vec3 c; out vec4 o; void main(){ o = vec4(c, 1.0); }"));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  const c = cube();
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, c.positions, gl.STATIC_DRAW);
  const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, c.indices, gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
  const uOff = gl.getUniformLocation(prog, "uOff");
  const offs = drawOffsets(N, 4);
  const tq = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  const pending = [];
  return {
    frame(_mode, gpuSink) {
      for (let i = pending.length - 1; i >= 0; i--) {
        const q = pending[i];
        if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) continue;
        if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) gpuSink.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(q); pending.splice(i, 1);
      }
      const t0 = performance.now();
      let q = null;
      if (tq && pending.length < 8) { q = gl.createQuery(); gl.beginQuery(tq.TIME_ELAPSED_EXT, q); }
      gl.viewport(0, 0, W, H); gl.clearColor(0.05, 0.05, 0.08, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog); gl.bindVertexArray(vao);
      for (let k = 0; k < N; k++) { gl.uniform4f(uOff, offs[k * 4], offs[k * 4 + 1], offs[k * 4 + 2], 1); gl.drawElements(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0); }
      if (q) { gl.endQuery(tq.TIME_ELAPSED_EXT); pending.push(q); }
      return performance.now() - t0;
    },
    timer: !!tq,
  };
}

async function runMode(runner, mode, ms, round, out) {
  const cpu = [], gpu = [], dt = [];
  if (round > 0) performance.mark(`hbGPU:${mode}:r${round}`);
  const t0 = performance.now();
  let last = null;
  while (performance.now() - t0 < ms) {
    const now = await raf();
    if (last !== null) dt.push(now - last);
    last = now;
    cpu.push(runner.frame(mode, gpu));
  }
  if (round > 0) performance.mark("hbGPU:gap");
  await sleep(300);
  if (round > 0) out.push({ mode, round, frames: dt.length, fps: dt.length ? +(dt.length / (dt.reduce((a, x) => a + x, 0) / 1000)).toFixed(1) : null, cpuMs: statsMs(cpu), gpuMs: statsMs(gpu) });
}

async function main() {
  const res = { schema: "hb-webgpu-probe-v1", at: new Date().toISOString(), userAgent: navigator.userAgent, draws: N, sec: SEC, rounds: ROUNDS,
    inner: [innerWidth, innerHeight], dpr: devicePixelRatio, webgpu: null, webgl2: null, windows: [], modes: {}, pipelineAsync: null, errors: [] };
  try {
    const cGpu = document.getElementById("gpu"), cGl = document.getElementById("gl");
    cGpu.width = W; cGpu.height = H; cGl.width = W; cGl.height = H;
    const g = await setupWebGPU(res);
    log(`webgpu: ${JSON.stringify(res.webgpu && res.webgpu.info)}`);
    const runners = {};
    if (g) { const b = gpuBench(g, cGpu); runners["gpu-draws"] = b; runners["gpu-bundle"] = b; }
    try { const gb = glBench(cGl, res); if (gb) runners["gl-draws"] = gb; } catch (e) { res.errors.push(`webgl2 bench: ${e.message}`); }
    const modes = Object.keys(runners);
    for (const m of modes) await runMode(runners[m], m, 1500, 0, res.windows); // warm-up (compiles, first presents)
    for (let r = 1; r <= ROUNDS; r++) {
      const order = modes.map((_, i) => modes[(i + r - 1) % modes.length]);
      for (const m of order) { log(`${m} round ${r}`); await runMode(runners[m], m, SEC * 1000, r, res.windows); }
    }
    for (const m of modes) {
      const ws = res.windows.filter((w) => w.mode === m);
      const med = (f) => { const a = ws.map(f).filter((x) => x != null).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };
      res.modes[m] = { windows: ws.length, cpuMs: { p50: med((w) => w.cpuMs && w.cpuMs.p50) }, gpuMs: { p50: med((w) => w.gpuMs && w.gpuMs.p50) }, fps: med((w) => w.fps) };
      res.modes[m].perDraw = perDraw(res.modes[m], N);
    }
    if (g) {
      const code = terrainWgsl(16);
      const t0 = performance.now();
      const module = g.device.createShaderModule({ code });
      const info = await module.getCompilationInfo();
      const tMod = performance.now() - t0;
      const t1 = performance.now();
      const fmt = navigator.gpu.getPreferredCanvasFormat();
      await g.device.createRenderPipelineAsync({
        layout: "auto",
        vertex: { module, entryPoint: "vs", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }, { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" }] }] },
        fragment: { module, entryPoint: "fs", targets: [{ format: fmt }] },
        primitive: { topology: "triangle-list" },
      });
      res.pipelineAsync = { taps: 16, wgslChars: code.length, moduleMs: +tMod.toFixed(2), pipelineAsyncMs: +(performance.now() - t1).toFixed(2),
        messages: info.messages.slice(0, 10).map((m) => `${m.type}: ${m.message}`) };
    }
    state.result = res;
    state.state = "done";
  } catch (e) {
    res.errors.push(String((e && e.stack) || e).slice(0, 600));
    state.result = res;
    state.state = "error";
  }
  log(`state ${state.state}`);
}
main();

// Phase-0 manifest capture for the shader-compile-trim-72 workflow.
// Hooks the WebGL context BEFORE app load to record, per program: compileMs (vs+fs),
// linkCallMs (time in linkProgram), queryMs (time in the FIRST getProgramParameter /
// getProgramInfoLog = the ANGLE/D3D11 deferred-link block = the "gold" metric), the
// resolved #defines, vertex/fragment line counts, and the full generated GLSL. Then
// walks renderer.info.programs to align each three.js wrapper (name/cacheKey/usedTimes)
// with its GL program and emit one row per live program.
//
// COLD by design: deletes the profile dir at startup so the on-disk GL program cache is
// empty (warm cache makes link ~0 and invalidates linkMs — the whole point of Phase 0).
// Run ON the 1070 (real NVIDIA ANGLE D3D11). Config mirrors the ceiling measurement:
//   ?quality=high & pvsRingRadius=10 & lbCap=600  (program set is quality-dependent).
const { chromium } = require("playwright-core");
const fs = require("fs");

const PROFILE = "C:\\Temp\\chrome-smanifest";
const OUT = "C:\\Temp\\shader-manifest-full.json";

const BASE =
  "http://127.0.0.1:18765/apps/holtburger-web/index.html" +
  "?quality=high&clouds=on&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&maxRetries=2" +
  "&nosw=1&bridge_url=ws://100.116.47.66:8080/&server_host=127.0.0.1&server_port=9000" +
  "&pvsRingRadius=10&lbCap=600";

const INWORLD_DEADLINE_MS = 95000;
const FILL_MAX_MS = 220000;
const POLL_MS = 2500;
const PLATEAU_POLLS = 6;   // N consecutive no-new-program polls = program set settled
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GL hooks installed in the page before any app script runs. Store-only: stamps raw
// timing/source onto shader & program GL objects; the final evaluate reads them back
// off renderer.info.programs so we get exactly the live program set, matched 1:1.
function installHooks() {
  try {
    const VERT = 0x8b31, FRAG = 0x8b30, LINK_STATUS = 0x8b82;
    const protos = [];
    if (window.WebGL2RenderingContext) protos.push(WebGL2RenderingContext.prototype);
    if (window.WebGLRenderingContext) protos.push(WebGLRenderingContext.prototype);
    for (const P of protos) {
      const _createShader = P.createShader;
      P.createShader = function (type) { const s = _createShader.call(this, type); try { if (s) s.__glType = type; } catch (_) {} return s; };
      const _shaderSource = P.shaderSource;
      P.shaderSource = function (sh, src) { try { if (sh) sh.__src = src; } catch (_) {} return _shaderSource.call(this, sh, src); };
      const _compileShader = P.compileShader;
      P.compileShader = function (sh) { const t = performance.now(); const r = _compileShader.call(this, sh); try { if (sh) sh.__compileMs = performance.now() - t; } catch (_) {} return r; };
      const _attachShader = P.attachShader;
      P.attachShader = function (pg, sh) { try { if (pg) (pg.__shaders || (pg.__shaders = [])).push(sh); } catch (_) {} return _attachShader.call(this, pg, sh); };
      const _linkProgram = P.linkProgram;
      P.linkProgram = function (pg) { const t = performance.now(); const r = _linkProgram.call(this, pg); try { if (pg) pg.__linkCallMs = performance.now() - t; } catch (_) {} return r; };
      const _getProgramParameter = P.getProgramParameter;
      P.getProgramParameter = function (pg, pn) {
        if (pg && pg.__queryMs == null) { const t = performance.now(); const r = _getProgramParameter.call(this, pg, pn); try { pg.__queryMs = performance.now() - t; pg.__queryKind = "getProgramParameter:" + pn; } catch (_) {} return r; }
        return _getProgramParameter.call(this, pg, pn);
      };
      const _getProgramInfoLog = P.getProgramInfoLog;
      P.getProgramInfoLog = function (pg) {
        if (pg && pg.__queryMs == null) { const t = performance.now(); const r = _getProgramInfoLog.call(this, pg); try { pg.__queryMs = performance.now() - t; pg.__queryKind = "getProgramInfoLog"; } catch (_) {} return r; }
        return _getProgramInfoLog.call(this, pg);
      };
    }
    window.__shaderHooksInstalled = true;
  } catch (e) { window.__shaderHooksError = String(e); }
}

function defLines(src) {
  if (!src) return [];
  const out = [];
  for (const l of src.split("\n")) { const t = l.trim(); if (t.indexOf("#define ") === 0) out.push(t.slice(8).trim()); if (out.length > 500) break; }
  return out;
}

(async () => {
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) {}
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true, viewport: { width: 1600, height: 900 },
    args: ["--no-sandbox", "--disable-gpu-sandbox", "--use-angle=d3d11", "--ignore-gpu-blocklist",
           "--enable-gpu-rasterization", "--disable-dev-shm-usage",
           "--disable-features=PaintHoldingCrossOrigin,PaintHolding"],
  });
  await ctx.addInitScript(installHooks);
  const page = ctx.pages()[0] || (await ctx.newPage());

  let lb = null;
  for (let attempt = 0; attempt < 2 && !lb; attempt++) {
    if (attempt > 0) console.log("retry login");
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 120000 }).catch((e) => console.log("goto", e.message));
    const dl = Date.now() + INWORLD_DEADLINE_MS;
    while (Date.now() < dl) {
      const s = await page.evaluate(() => { const h = window.__sessionHandle; if (!h) return null;
        try { const w = h.getLocalPlayerPose && h.getLocalPlayerPose(); const c = h.getCurrentCellId ? (h.getCurrentCellId() >>> 0) : 0;
          if (w && (w.landblockId >>> 0) && c) return { lb: (w.landblockId >>> 0).toString(16), cell: "0x" + c.toString(16) }; } catch (_) {} return null;
      }).catch(() => null);
      if (s) { lb = s.lb; console.log("in-world:", s.lb, "cell:", s.cell); break; }
      await sleep(1500);
    }
  }
  if (!lb) { console.log("NEVER in-world"); fs.writeFileSync(OUT, JSON.stringify({ error: "never-in-world" })); await ctx.close().catch(()=>{}); process.exit(2); }

  const hookState = await page.evaluate(() => ({ installed: !!window.__shaderHooksInstalled, err: window.__shaderHooksError || null }));
  console.log("hooks:", JSON.stringify(hookState));

  // Run the fill until the program count plateaus (program set fully materialized).
  const fillT0 = Date.now();
  let lastN = 0, flat = 0;
  while (Date.now() - fillT0 < FILL_MAX_MS) {
    await sleep(POLL_MS);
    const n = await page.evaluate(() => { try { const r = window.liveScene3d && window.liveScene3d.renderer; return r && r.info && r.info.programs ? r.info.programs.length : null; } catch (_) { return null; } }).catch(() => null);
    if (n == null) continue;
    if (n <= lastN) { flat++; if (flat >= PLATEAU_POLLS && lastN > 0) { console.log("program plateau at", lastN); break; } }
    else { flat = 0; lastN = n; console.log("t+" + Math.round((Date.now()-fillT0)/1000) + "s programs=" + n); }
  }

  // Build the manifest from the live program set.
  const result = await page.evaluate((defLinesSrc) => {
    const defLines = new Function("return (" + defLinesSrc + ")")();
    const VERT = 0x8b31, FRAG = 0x8b30;
    const r = window.liveScene3d && window.liveScene3d.renderer;
    const progs = (r && r.info && r.info.programs) ? Array.from(r.info.programs) : [];
    let gl = null, khr = null, maxThreads = null, rendererStr = "?";
    try { gl = r.getContext(); khr = gl.getExtension("KHR_parallel_shader_compile"); if (khr) maxThreads = gl.getParameter(khr.MAX_SHADER_COMPILER_THREADS_KHR); } catch (_) {}
    try { const dbg = gl.getExtension("WEBGL_debug_renderer_info"); rendererStr = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL); } catch (_) {}
    const rows = [];
    let matched = 0;
    let idx = 0;
    for (const w of progs) {
      const gp = w && w.program;
      let vsrc = "", fsrc = "";
      const shaders = (gp && gp.__shaders) || [];
      for (const sh of shaders) { if (!sh) continue; if (sh.__glType === VERT) vsrc = sh.__src || ""; else if (sh.__glType === FRAG) fsrc = sh.__src || ""; }
      // fallback: three.js also keeps w.vertexShader / w.fragmentShader (GL shader objs)
      if (!vsrc && w && w.vertexShader && w.vertexShader.__src) vsrc = w.vertexShader.__src;
      if (!fsrc && w && w.fragmentShader && w.fragmentShader.__src) fsrc = w.fragmentShader.__src;
      if (vsrc || fsrc) matched++;
      const cms = ((shaders[0] && shaders[0].__compileMs) || 0) + ((shaders[1] && shaders[1].__compileMs) || 0);
      rows.push({
        idx: idx++,
        name: (w && w.name) || null,
        cacheKey: (w && typeof w.cacheKey === "string") ? w.cacheKey : null,
        usedTimes: (w && w.usedTimes) || null,
        compileMs: +cms.toFixed(2),
        linkCallMs: gp && gp.__linkCallMs != null ? +gp.__linkCallMs.toFixed(2) : null,
        queryMs: gp && gp.__queryMs != null ? +gp.__queryMs.toFixed(2) : null,
        queryKind: gp ? (gp.__queryKind || null) : null,
        vertLines: vsrc ? vsrc.split("\n").length : 0,
        fragLines: fsrc ? fsrc.split("\n").length : 0,
        vertDefines: defLines(vsrc),
        fragDefines: defLines(fsrc),
        vsrc, fsrc,
      });
    }
    return { meta: { programCount: progs.length, matchedSource: matched, rendererStr, khrPresent: !!khr, maxThreads,
                     checkShaderErrors: r && r.debug ? r.debug.checkShaderErrors : null }, rows };
  }, defLines.toString());

  // total/sortKey + strip nothing; node writes the full file (incl. source).
  for (const row of result.rows) {
    row.totalMs = +((row.compileMs || 0) + (row.linkCallMs || 0) + (row.queryMs || 0)).toFixed(2);
  }
  result.rows.sort((a, b) => (b.totalMs || 0) - (a.totalMs || 0));
  result.rows.forEach((row, i) => { row.rank = i; });

  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  const top = result.rows.slice(0, 8).map((r) => ({ rank: r.rank, name: r.name, totalMs: r.totalMs, queryMs: r.queryMs, linkCallMs: r.linkCallMs, compileMs: r.compileMs }));
  console.log("META", JSON.stringify(result.meta));
  console.log("TOP8", JSON.stringify(top, null, 1));
  console.log("WROTE", OUT, "rows=", result.rows.length);
  await ctx.close().catch(() => {});
  process.exit(0);
})().catch((e) => { console.error("FATAL", e); try { fs.writeFileSync(OUT, JSON.stringify({ error: String(e) })); } catch (_) {} process.exit(1); });

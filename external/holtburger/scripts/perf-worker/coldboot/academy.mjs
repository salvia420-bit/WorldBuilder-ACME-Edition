// acad-time.mjs — fresh-profile boot of the academy character; poll the EnvCell build every 2 s.
//   node acad-time.mjs --label X [--flags 'a=b'] [--max-s 360] [--relay-log run4.tsv] [--profile]
//   --profile: main-thread CPU profile from navigation to the end → acad-<label>.cpuprofile
//   --linkmap: time every blocking program query per GL program (a synchronous driver link shows up
//              as the first getProgramParameter/getActiveUniform on it) → sum.linkmap, named via
//              renderer.info.programs. Per program also: msInRender / msInCompile (blocked inside
//              renderer.render / .compile), the full cacheKey + usedTimes, and for every single
//              query over 50 ms the draw in flight + a 60-frame stack (`slow`). Programs that
//              blocked >100 ms in render get a sibling key diff decoded per three r184 axis
//              (sum.linkmapSiblings; LINKHOT lines). Implies a small --progdump.
//   --progdump: every live program [name, full cacheKey, usedTimes] + __asyncLink.stats,
//              __texWorkerStats(), __xu7Stats(), __portalSpace → `progdump` in acad-<label>.json
//   --shots 5,10,15: 3D JPGs at those seconds after in-world → acad-<label>-<s>s.jpg (NOT on timing
//              arms: each capture costs 20-60 ms of main thread)
//   rows carry `ps` (portal space "state:reason[:login]"); the run ends 6 s after the textures
//   are done AND the login tunnel has ended (15 s ceiling past that). Summary adds tunnelStart /
//   tunnelReady / tunnelReveal / tunnelDone (run clock, from __portalSpace.t anchored on a
//   page-now/laptop-now pair — no laptop↔1070 clock skew), loginMode / loginSkip / loginStarts,
//   wallsVisible = max(texturesDone, tunnelReveal) and pageClockSkewMs (1070 − laptop, ± RTT/2).
//   --fetchmap: per /shards/ request on the page, when fetch() was called and when its body reached
//              JS (arrayBuffer resolved) → `fetchmap` in acad-<label>.json, to set against the
//              network's own responseEnd (resource timing): the gap is main-thread delay
//   --workerspy: in the bake worker, each message's arrival / reply (type, id, DID count, urgent) and every
//              event-loop block over 50 ms → net.workers[].spy (`wspy.py acad-<label>.json` prints them)
//   --longtasks: every main-thread task over 50 ms ([startMs, durationMs], page clock) → `longtasks`
//              (with --profile, the profile records the page clock at its start: pageMsAtStart)
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { statSync, openSync, readSync, closeSync, readFileSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const BOX = "young@100.127.215.75", CDP = "http://127.0.0.1:9333", PORT = +opt("--port", 7093), HOST = opt("--host", "100.116.47.66");
const LABEL = opt("--label", "acad"), MAXS = +opt("--max-s", 360), RLOG = opt("--relay-log", "run4.tsv");
const ACE_LOG = "/home/wbterminal/ace-server/Source/ACE.Server/bin/Release/net10.0/ACE_Log.txt";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ssh = (c) => execFileSync("ssh", ["-o", "BatchMode=yes", BOX, c], { encoding: "utf8", timeout: 60000 });
function aceTail(n = 262144) { const s = statSync(ACE_LOG).size, fd = openSync(ACE_LOG, "r"); const b = Buffer.alloc(Math.min(n, s)); readSync(fd, b, 0, b.length, s - b.length); closeSync(fd); return b.toString("utf8"); }
async function waitFree(maxMs = 150000) { const end = Date.now() + maxMs; while (Date.now() < end) { const ev = aceTail().split("\n").filter((l) => /\[(LOGIN|LOGOUT)\] Account tailnet1 /.test(l)); const last = ev[ev.length - 1]; if (!last || /\[LOGOUT\]/.test(last)) return true; await sleep(2000); } return false; }
function relayDown(sinceMs) { let d = 0; for (const l of readFileSync(RLOG, "utf8").split("\n")) { const f = l.split("\t"); if (+f[0] >= sinceMs) d += +f[1] || 0; } return d; }
// End any live test session cleanly first (disconnect), then kill only the test Chrome.
try { const b = await chromium.connectOverCDP(CDP, { timeout: 8000 }); for (const p of b.contexts()[0].pages()) await p.evaluate(() => { try { window.__sessionHandle?.disconnect?.(); } catch (_) {} }).catch(() => {}); await sleep(1500); } catch (_) {}
try { ssh("powershell -NoProfile -ExecutionPolicy Bypass -File D:\\Temp\\hbbench\\hbbench-kill.ps1"); } catch (_) {}
console.log("account free:", await waitFree());
ssh(`echo hbb-${LABEL}-${Date.now()}> D:\\Temp\\hbbench\\profile.txt`);
ssh(`echo 1280,720> D:\\Temp\\hbbench\\winsize.txt`);
ssh('schtasks /create /tn hbprobe /tr "D:\\Temp\\hbbench\\hbprobe-launch.bat" /sc once /st 00:00 /it /f >nul 2>nul & schtasks /run /tn hbprobe >nul');
for (let i = 0; i < 40; i++) { try { if ((await fetch(`${CDP}/json/version`)).ok) break; } catch (_) {} await sleep(1000); }
const browser = await chromium.connectOverCDP(CDP);
const pg = browser.contexts()[0].pages()[0];
const flags = opt("--flags", "");
const url = `http://${HOST}:${PORT}/apps/holtburger-web/index.html?autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&nosw=1&bridge_url=ws://${HOST}:${PORT}/wsbridge&server_host=127.0.0.1&server_port=9000${flags ? "&" + flags : ""}`;
await pg.addInitScript(() => { try { performance.setResourceTimingBufferSize(200000); } catch (_) {} });
if (a.includes("--longtasks")) await pg.addInitScript(() => {
  const lt = []; window.__longTasks = lt;
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) lt.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: "longtask", buffered: true }); } catch (_) {}
});
if (a.includes("--fetchmap")) await pg.addInitScript(() => {
  const recs = new Map(); window.__fetchMap = recs; const of = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    const u = typeof input === "string" ? input : input?.url || String(input);
    const p = of.call(this, input, init);
    if (u.includes("/shards/")) { const r = { c: performance.now() }; recs.set(u.slice(u.indexOf("/shards/")), r); p.then(() => { r.h = performance.now(); }, () => {}); }
    return p;
  };
  const oab = Response.prototype.arrayBuffer;
  Response.prototype.arrayBuffer = function () {
    const url = String(this.url); const r = recs.get(url.slice(url.indexOf("/shards/"))); const p = oab.call(this);
    if (r) p.then(() => { r.b = performance.now(); }, () => {});
    return p;
  };
});
if (a.includes("--linkmap")) await pg.addInitScript(() => {
  // 2026-10-09 (Workstream D step 1): stacks deep enough to reach app code (the blocking
  // query sits ~10 frames inside three), the time blocked inside renderer.render /
  // renderer.compile (msInRender / msInCompile), and for any single query over 50 ms the
  // draw that was in flight (renderBufferDirect stash: scene, material, object, target,
  // camera layer mask, material/props versions, the ?asyncLink slow-path state).
  try { Error.stackTraceLimit = 60; } catch (_) {}
  const m = new WeakMap(), all = []; const L = { all, m, depth: 0, cdepth: 0, d: null, hooked: false }; window.__linkMap = L;
  const descDraw = () => {
    const d = L.d; if (!d) return null;
    const s = d.scene, mt = d.material, o = d.object, st = d.st;
    let al = null; if (st) al = { ver: st.ver, verNoop: st.verNoop, verDefers: st.verDefers, sigDefers: st.sigDefers, sig: st.sig == null ? null : String(st.sig).slice(0, 120) };
    return { scene: s === null ? null : (s?.name || s?.type || "?"), shadow: s === null, matType: mt?.type, mat: mt?.name || "", uuid: mt?.uuid, obj: o?.name || o?.type || "",
      rt: d.rt ? (d.rt.texture?.name || d.rt.name || "rt") : null, mask: d.mask, ver: mt?.version, mpVerAtEntry: d.mpVer, al };
  };
  for (const C of [globalThis.WebGL2RenderingContext, globalThis.WebGLRenderingContext]) {
    if (!C) continue;
    for (const fn of ["getProgramParameter", "getActiveUniform", "getActiveAttrib", "getUniformLocation", "getAttribLocation", "getProgramInfoLog"]) {
      const o = C.prototype[fn]; if (typeof o !== "function") continue;
      C.prototype[fn] = function (prog, ...rest) {
        const t0 = performance.now(); const r = o.call(this, prog, ...rest); const dt = performance.now() - t0;
        if (prog && typeof prog === "object") {
          let e = m.get(prog); if (!e) { e = { first: t0, ms: 0, worst: 0, calls: 0, prog, msR: 0, msC: 0, slow: null }; m.set(prog, e); all.push(e); }
          e.ms += dt; e.calls++; if (dt > e.worst) e.worst = dt;
          if (L.depth > 0) e.msR += dt; else if (L.cdepth > 0) e.msC += dt;
          if (dt > 50) {
            (e.slow || (e.slow = [])).push({ at: Math.round(t0), ms: Math.round(dt), fn, phase: L.depth > 0 ? "render" : L.cdepth > 0 ? "compile" : "other",
              draw: descDraw(), stack: String(new Error().stack || "").split("\n").slice(2, 60).map((x) => x.trim()).join(" | ") });
          }
        }
        return r;
      };
    }
  }
  // Renderer hooks once liveScene3d exists (instance wrappers: ?asyncLink's
  // renderBufferDirect wrapper, installed at init, stays inside ours).
  const hook = () => {
    const r = window.liveScene3d?.renderer; if (!r) return false; if (L.hooked) return true; L.hooked = true;
    const oRender = r.render, oCompile = r.compile, oRbd = r.renderBufferDirect;
    r.render = function (...x) { L.depth++; try { return oRender.apply(this, x); } finally { L.depth--; } };
    r.compile = function (...x) { L.cdepth++; try { return oCompile.apply(this, x); } finally { L.cdepth--; } };
    const d = { scene: null, material: null, object: null, rt: null, mask: null, mpVer: null, st: null };
    r.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
      const prev = L.d;
      d.scene = scene; d.material = material; d.object = object; d.mask = camera?.layers?.mask ?? null;
      try { d.rt = r.getRenderTarget(); } catch (_) { d.rt = null; }
      try { d.mpVer = r.properties.get(material).__version ?? null; } catch (_) { d.mpVer = null; }
      try { d.st = window.__asyncLink?.stateOf?.(material) || null; } catch (_) { d.st = null; }
      L.d = d;
      try { return oRbd.call(this, camera, scene, geometry, material, object, group); } finally { L.d = prev; }
    };
    return true;
  };
  const iv = setInterval(() => { try { if (hook()) clearInterval(iv); } catch (_) {} }, 200);
});
const logs = [], workers = [];
pg.on("console", (m) => { const tx = m.text(); if (/envcells|placements fetched|bake_worker|materialCache|fetchEnvCells|surface|interiorStabBatch|interiorClosure|interiorEarly|interiorWallsFirst|interiorBuildShare|shardFetch|texUpgrade|portalSpace|\[F1\]|packSource/i.test(tx)) logs.push({ t: Date.now() - t0, tx: tx.slice(0, 240) }); });
const WORKERSPY = a.includes("--workerspy");
pg.on("worker", (w) => { workers.push({ w, url: w.url(), t: Date.now() - t0 }); w.evaluate(() => { try { performance.setResourceTimingBufferSize(200000); } catch (_) {} }).catch(() => {});
  // --workerspy: inside the bake worker, every message in (type, id, DID count, urgent) and reply out,
  // plus every event-loop block > 50 ms (a synchronous wasm stretch) → net.workers[].spy.
  if (WORKERSPY && /bake_worker/.test(w.url())) w.evaluate(() => {
    const spy = self.__spy = { origin: performance.timeOrigin, msgs: [], lag: [] };
    const wrapOn = () => { const f = self.onmessage; if (typeof f === "function" && !f.__spied) { const g = function (ev) { const d = ev.data || {}; spy.msgs.push(["in", Math.round(performance.now()), d.type, d.id, (d.dids || d.ids || d.flatDids || []).length, d.urgent === true]); return f.call(this, ev); }; g.__spied = true; self.onmessage = g; } };
    wrapOn(); setInterval(wrapOn, 5);
    const pm = self.postMessage.bind(self);
    self.postMessage = (m, t) => { spy.msgs.push(["out", Math.round(performance.now()), m && m.type, m && m.id, m && m.kind]); return pm(m, t); };
    let last = performance.now();
    setInterval(() => { const n = performance.now(); if (n - last > 50) spy.lag.push([Math.round(last), Math.round(n - last)]); last = n; }, 10);
  }).catch(() => {});
});
const PROF = a.includes("--profile");
let cdp = null, profPageMs = null;
const t0 = Date.now();
await pg.goto(url, { waitUntil: "commit", timeout: 120000 });
if (PROF) { // after commit: a cross-origin navigation can swap the renderer
  cdp = await pg.context().newCDPSession(pg);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
  await cdp.send("Profiler.start");
  profPageMs = await pg.evaluate(() => performance.now()).catch(() => null);
}
const rows = [];
let doneAt = null;
// --shots 5,10,15 (seconds after in-world): 3D JPGs (toDataURL inside a canvas render, the
// townnet.mjs way) → acad-<label>-<s>s.jpg. Each costs ~20-60 ms of main thread: keep shots
// OFF the timing arms.
const SHOTS = String(opt("--shots", "") || "").split(",").map(Number).filter((x) => x > 0).sort((x, y) => x - y);
const shot3d = async (file) => {
  const u = await pg.evaluate(async () => {
    const r = window.liveScene3d?.renderer; if (!r) return null; const orig = r.render, cv = r.domElement; let last = null;
    r.render = function (...x) { const ret = orig.apply(this, x); if (r.getRenderTarget() === null) { try { last = cv.toDataURL("image/jpeg", 0.85); } catch (e) { last = String(e); } } return ret; };
    await new Promise((res) => { let n = 0; const f = () => (++n >= 3 || last) ? res() : requestAnimationFrame(f); requestAnimationFrame(f); setTimeout(res, 4000); });
    r.render = orig; return last;
  }).catch(() => null);
  if (u && u.startsWith("data:")) writeFileSync(file, Buffer.from(u.split(",")[1], "base64"));
};
let inWorldT = null;
for (let i = 0; Date.now() - t0 < MAXS * 1000; i++) {
  const r = await pg.evaluate(() => {
    const s = window.liveScene3d, h = window.__sessionHandle;
    const hist = (window.__bootStateHistory || []).map((x) => x.state);
    let cell = null; try { const p = h?.getLocalPlayerPose?.(); cell = p ? (p.landblockId >>> 0).toString(16) : null; p?.free?.(); } catch (_) {}
    let bw = null; try { const st = window.__diag?.bakeWorkerStats?.(); if (st) bw = { q: st.queue?.queuedNow, inf: st.queue?.inFlightPosted, posted: st.queue?.posted, fb: st.fallbacks?.total, by: Object.fromEntries(Object.entries(st.byType || {}).map(([k, v]) => [k, v.count + "/" + v.maxMs])) }; } catch (_) {}
    const asArr = (v) => v instanceof Set ? Array.from(v).map((x) => (typeof x === "number" ? (x >>> 0).toString(16) : String(x))) : null;
    // Portal space ("state:reason[:login]", null = never ran) — 0 = off.
    const P = window.__portalSpace;
    return {
      st: hist[hist.length - 1] || null, cell,
      kids: s?.cellsGroup?.children?.length ?? null,
      envIn: asArr(s?.envCellBuildInFlight), envLoaded: asArr(s?.envCellLoadedLbs),
      pf: s?.materialCache?.pendingFetches?.size ?? null, mats: s?.materialCache?.materials?.size ?? null,
      terr: s?.terrainBakedLbs?.size ?? null, bw,
      shell: document.querySelector('script[src*="shell/"]') ? "bundled" : "unbundled",
      ps: P ? `${P.state}:${P.reason}${P.login ? ":login" : ""}${P.loginPending ? ":pending" : ""}` : null,
    };
  }).catch((e) => ({ err: String(e).slice(0, 80) }));
  r.t = Math.round((Date.now() - t0) / 100) / 10;
  r.downMB = Math.round(relayDown(t0) / 1e5) / 10;
  rows.push(r);
  const key = JSON.stringify({ ...r, t: 0, downMB: 0 });
  if (rows.length === 1 || key !== rows[rows.length - 2]._k) console.log(JSON.stringify(r));
  r._k = key;
  if (inWorldT == null && (r.st === "in-world" || r.st === "ready")) inWorldT = r.t;
  while (SHOTS.length && inWorldT != null && r.t - inWorldT >= SHOTS[0]) await shot3d(`acad-${LABEL}-${SHOTS.shift()}s.jpg`);
  // Done: the cells are built and textured (+6 s) AND the portal tunnel has ended
  // (login portal space; 15 s ceiling past that) — without a tunnel this is the old rule.
  const psIdle = !r.ps || r.ps.startsWith("0:");
  if (r.kids > 0 && r.pf === 0 && Array.isArray(r.envIn) && r.envIn.length === 0 && r.cell && /^8602/.test(r.cell)) { if (doneAt == null) doneAt = r.t; if (r.t - doneAt >= 6 && (psIdle || r.t - doneAt >= 21)) break; }
  await sleep(2000);
}
let linkmap = null, linkProgs = null, linkHooked = null;
if (a.includes("--linkmap")) linkmap = await pg.evaluate(() => {
  const L = window.__linkMap; if (!L) return null;
  const progs = window.liveScene3d?.renderer?.info?.programs || [];
  const idx = new Map(progs.map((p, i) => [p.program, i]));
  const name = new Map(progs.map((p) => [p.program, `${p.name || "?"} | ${String(p.cacheKey || "").slice(0, 90)}`]));
  const out = L.all.filter((e) => e.ms > 2).sort((x, y) => y.ms - x.ms).map((e) => {
    const p = idx.has(e.prog) ? progs[idx.get(e.prog)] : null;
    return { at: Math.round(e.first) / 1000, ms: Math.round(e.ms), worst: Math.round(e.worst), calls: e.calls, name: name.get(e.prog) || "(unnamed/disposed)",
      msInRender: Math.round(e.msR || 0), msInCompile: Math.round(e.msC || 0), pname: p ? p.name || "" : null, key: p ? String(p.cacheKey || "") : null,
      usedTimes: p ? p.usedTimes : null, prog: idx.has(e.prog) ? idx.get(e.prog) : -1, slow: e.slow || null };
  });
  return { out, programs: progs.map((p) => ({ name: p.name || "", key: String(p.cacheKey || ""), usedTimes: p.usedTimes })), hooked: !!L.hooked };
}).catch((e) => ({ err: String(e).slice(0, 120) }));
if (linkmap && !linkmap.err) { linkProgs = linkmap.programs; linkHooked = linkmap.hooked; linkmap = linkmap.out; }
// Sibling key diff for every program that blocked >100 ms inside render(): the programs
// with the same name (else the same first + last token), token by token. three r184
// getProgramCacheKey order, read from the END (defines vary at the front); the trailing
// customProgramCacheKey is ONE token (three's default is onBeforeCompile.toString(),
// which contains a comma).
const AXES = ["precision", "outputColorSpace", "envMapMode", "envMapCubeUVHeight", "mapUv", "alphaMapUv", "lightMapUv", "aoMapUv", "bumpMapUv", "normalMapUv", "displacementMapUv", "emissiveMapUv", "metalnessMapUv", "roughnessMapUv", "anisotropyMapUv", "clearcoatMapUv", "clearcoatNormalMapUv", "clearcoatRoughnessMapUv", "iridescenceMapUv", "iridescenceThicknessMapUv", "sheenColorMapUv", "sheenRoughnessMapUv", "specularMapUv", "specularColorMapUv", "specularIntensityMapUv", "transmissionMapUv", "thicknessMapUv", "combine", "fogExp2", "sizeAttenuation", "morphTargetsCount", "morphAttributeCount", "numDirLights", "numPointLights", "numSpotLights", "numSpotLightMaps", "numHemiLights", "numRectAreaLights", "numDirLightShadows", "numPointLightShadows", "numSpotLightShadows", "numSpotLightShadowsWithMaps", "numLightProbes", "shadowMapType", "toneMapping", "numClippingPlanes", "numClipIntersection", "depthPacking", "maskA", "maskB", "rendererOutputColorSpace", "customProgramCacheKey"];
const MASK_A = ["instancing", "instancingColor", "instancingMorph", "matcap", "envMap", "normalMapObjectSpace", "normalMapTangentSpace", "clearcoat", "iridescence", "alphaTest", "vertexColors", "vertexAlphas", "vertexUv1s", "vertexUv2s", "vertexUv3s", "vertexTangents", "anisotropy", "alphaHash", "batching", "dispersion", "batchingColor", "gradientMap", "packedNormalMap", "vertexNormals"];
const MASK_B = ["fog", "useFog", "flatShading", "logarithmicDepthBuffer", "reversedDepthBuffer", "skinning", "morphTargets", "morphNormals", "morphColors", "premultipliedAlpha", "shadowMapEnabled", "doubleSided", "flipSided", "useDepthPacking", "dithering", "transmission", "sheen", "opaque", "pointsUvs", "decodeVideoTexture", "decodeVideoTextureEmissive", "alphaToCoverage", "lightProbeGrid"];
function keyTokens(key) {
  let s = String(key || "");
  const DEF = "onBeforeCompile( /* shaderobject, renderer */ ) {}";
  if (s.endsWith(DEF)) { s = s.slice(0, -DEF.length).replace(/,$/, ""); return [...s.split(","), "onBeforeCompile(default)"]; }
  const toks = s.split(",");
  const j = toks.findIndex((t) => /[{}]|=>|\bfunction\b/.test(t)); // a code-bearing custom key: one token
  return j >= 0 ? [...toks.slice(0, j), toks.slice(j).join(",")] : toks;
}
function tokenDiff(ka, kb) {
  const A = keyTokens(ka), B = keyTokens(kb);
  if (A.length !== B.length) return [{ lenA: A.length, lenB: B.length }];
  const out = [];
  for (let i = 0; i < A.length; i++) {
    if (A[i] === B[i]) continue;
    const fromEnd = i - A.length; const axis = AXES[AXES.length + fromEnd] || `head[${i}]`;
    const row = { i: fromEnd, axis, a: A[i].slice(0, 80), b: B[i].slice(0, 80) };
    if (axis === "maskA" || axis === "maskB") {
      const names = axis === "maskA" ? MASK_A : MASK_B, x = (+A[i]) ^ (+B[i]);
      row.bits = names.map((n, bit) => ((x >> bit) & 1 ? `${n}:${((+A[i]) >> bit) & 1}->${((+B[i]) >> bit) & 1}` : null)).filter(Boolean);
    }
    out.push(row);
  }
  return out;
}
let linkSiblings = null;
if (Array.isArray(linkmap) && linkProgs) {
  linkSiblings = linkmap.filter((e) => e.msInRender > 100 && e.key).map((e) => {
    const T = keyTokens(e.key);
    let sib = linkProgs.map((p, i) => ({ ...p, i })).filter((p) => p.i !== e.prog && p.name === e.pname);
    if (sib.length === 0) sib = linkProgs.map((p, i) => ({ ...p, i })).filter((p) => { if (p.i === e.prog) return false; const U = keyTokens(p.key); return U[0] === T[0] && U[U.length - 1] === T[T.length - 1]; });
    sib.sort((x, y) => tokenDiff(e.key, x.key).length - tokenDiff(e.key, y.key).length);
    return { name: e.pname, ms: e.ms, msInRender: e.msInRender, usedTimes: e.usedTimes, at: e.at, key: e.key,
      siblings: sib.slice(0, 6).map((p) => ({ name: p.name, usedTimes: p.usedTimes, diff: tokenDiff(p.key, e.key) })) };
  });
  for (const s of linkSiblings) console.log("LINKHOT", JSON.stringify({ name: s.name, ms: s.ms, msInRender: s.msInRender, at: s.at, sib: s.siblings.slice(0, 2).map((x) => ({ name: x.name, diff: x.diff })) }));
}
// --progdump: every live program (name, full key, usedTimes) + the guards' own stats.
let progdump = null;
if (a.includes("--progdump") || a.includes("--linkmap")) progdump = await pg.evaluate((full) => {
  const progs = window.liveScene3d?.renderer?.info?.programs || [];
  const call = (f) => { try { return typeof f === "function" ? f() : null; } catch (e) { return { err: String(e).slice(0, 80) }; } };
  return {
    programs: full ? progs.map((p) => [p.name || "", String(p.cacheKey || ""), p.usedTimes]) : progs.length,
    asyncLink: window.__asyncLink?.stats ? { ...window.__asyncLink.stats } : null,
    texWorker: call(window.__texWorkerStats), xu7: call(window.__xu7Stats),
    portalSpace: window.__portalSpace ? { ...window.__portalSpace } : null,
    alphaMaskSlice: window.__alphaMaskSliceStats || null,
  };
}, a.includes("--progdump")).catch((e) => ({ err: String(e).slice(0, 120) }));
const longtasks = a.includes("--longtasks") ? await pg.evaluate(() => window.__longTasks || []).catch(() => null) : null;
let fetchmap = null;
if (a.includes("--fetchmap")) fetchmap = await pg.evaluate(() => Array.from(window.__fetchMap || [], ([u, r]) => [u, Math.round(r.c), r.h == null ? null : Math.round(r.h), r.b == null ? null : Math.round(r.b)])).catch(() => null);
// Portal-space stamps are page performance.now() ms. They are put on this run's clock through a
// page-now / laptop-now pair taken together (midpoint of the evaluate round trip), NOT through
// performance.timeOrigin - t0: the rows run on the LAPTOP's clock and timeOrigin on the 1070's,
// so any skew between the two would shift tunnel* (and wallsVisible) by it. pageClockSkewMs
// records that skew (± RTT/2) for reading the page-clock longtasks / fetchmap against the rows.
const psA = Date.now();
const psEnd = await pg.evaluate(() => ({ origin: performance.timeOrigin, now: performance.now(), P: window.__portalSpace ? { ...window.__portalSpace } : null })).catch(() => null);
const psMid = (psA + Date.now()) / 2;
const psRun = (ms) => (psEnd && ms > 0 ? Math.round((psMid - (psEnd.now - ms) - t0) / 100) / 10 : null);
const first = (f) => rows.find(f)?.t ?? null;
const sum = {
  label: LABEL, flags, shell: rows[rows.length - 1]?.shell,
  inWorld: first((r) => r.st === "in-world" || r.st === "ready"),
  ready: first((r) => r.st === "ready"),
  envInFlight: first((r) => r.envIn && r.envIn.length > 0),
  firstCellMesh: first((r) => r.kids > 0),
  texturesDone: first((r) => r.kids > 0 && r.pf === 0),
  final: rows[rows.length - 1],
  linkmap,
};
sum.pageClockSkewMs = psEnd && Number.isFinite(psEnd.origin) && Number.isFinite(psEnd.now) ? Math.round(psEnd.origin + psEnd.now - psMid) : null;
// Added 2026-10-09 (login portal space): run-clock seconds of the tunnel's start / cells
// ready / first world frame / end, and the walls as the PLAYER sees them.
const P = psEnd?.P;
sum.tunnelStart = psRun(P?.t?.start); sum.tunnelReady = psRun(P?.t?.ready);
sum.tunnelReveal = psRun(P?.t?.reveal); sum.tunnelDone = psRun(P?.t?.done);
sum.loginMode = P?.loginMode ?? null; sum.loginSkip = P?.loginSkip ?? null; sum.loginStarts = P?.loginStarts ?? null;
sum.wallsVisible = sum.texturesDone == null ? null : (sum.tunnelReveal != null && P?.loginStarts > 0 ? Math.max(sum.texturesDone, sum.tunnelReveal) : sum.texturesDone);
if (linkSiblings) sum.linkmapSiblings = linkSiblings;
if (linkHooked !== null) sum.linkmapHooked = linkHooked; // render/compile/draw hooks attached (else msInRender stays 0)
if (progdump && !progdump.err) sum.asyncLink = progdump.asyncLink;
const res = async (ctx) => ctx.evaluate(() => ({ origin: performance.timeOrigin, now: performance.now(), e: performance.getEntriesByType("resource").map((x) => [x.name.replace(/^https?:\/\/[^/]+/, ""), Math.round(x.startTime), Math.round(x.responseEnd), x.transferSize, x.encodedBodySize, x.initiatorType]) })).catch((e) => ({ err: String(e).slice(0, 100) }));
const net = { page: await res(pg), workers: [] };
for (const w of workers) net.workers.push({ url: w.url, t: w.t, r: await res(w.w), spy: WORKERSPY && /bake_worker/.test(w.url) ? await w.w.evaluate(() => self.__spy || null).catch(() => null) : null });
if (cdp) { const { profile } = await cdp.send("Profiler.stop"); profile.wallT0 = t0; profile.pageMsAtStart = profPageMs; writeFileSync(`acad-${LABEL}.cpuprofile`, JSON.stringify(profile)); }
writeFileSync(`acad-${LABEL}.json`, JSON.stringify({ t0, sum, rows, logs, net, fetchmap, longtasks, progdump }, null, 0));
console.log("SUMMARY", JSON.stringify(sum));
process.exit(0);

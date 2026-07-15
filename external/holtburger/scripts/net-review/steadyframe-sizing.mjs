// steadyframe-sizing.mjs — size all reframed L2 levers in ONE settled 1070 session.
// Follows RESULTS-taskL2-steadyframe: the fps ceiling is render submission (draw-call /
// mesh-node count). This probe measures the payoff of each candidate lever so we build the
// right one:
//   B  real draw-calls/frame            (renderer.info.autoReset=false — fixes the L2 trap)
//   1  entity instancing collapse ceiling = totalEntityMeshes − distinct(guid,part,surface)
//   D  static vs dynamic mesh-node split (how much of the walk is bake-static)
//   E  fresh CPU profile at TRUE steady  (entRoots stable → getParameters churn vs transient)
//   F  matrix-freeze A/B                 (median tCpu: baseline vs matrixWorldAutoUpdate=false
//                                          on terrain/statics/buildings) → sizes lever #2
//   G  light-count variance             (relink-freeze churn signal for getParameters)
// Measurement-only: the one scene mutation (matrix freeze) is reverted before exit.
//
// Usage: POI=Cragstone node steadyframe-sizing.mjs [outJson] [profileS]
import fs from "node:fs";

const CDP_URL = "http://127.0.0.1:9333";
const SERVE = "http://127.0.0.1:8765/apps/holtburger-web/index.html";
const ACCOUNT = "tailnet1";
const OUT = process.argv[2] || "/mnt/wbterminal2/tmp/steadyframe-sizing.json";
const PROFILE_S = Number(process.argv[3] || "5");
const POI = process.env.POI || "Cragstone";
const SAMPLE_INTERVAL_US = 200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
// Rotate the player in place (forward=0, strafe=0, turn=±1, no translation → residency unchanged).
const spin = (page, on) => page.evaluate((v) => { try { window.__sessionHandle.setMovementInput(0, 0, v ? 1 : 0, false); } catch (_) {} }, on).catch(() => {});
const headingOf = (page) => page.evaluate(() => { try { const p = window.__sessionHandle.getLocalPlayerPose(); const h = p ? p.heading : null; if (p && p.free) p.free(); return h; } catch (_) { return null; } }).catch(() => null);
// Facing-averaged draw calls: caller has spin ON; sample autoReset=false over `seconds`, with
// per-500ms windows → overall mean (facing-independent) + per-heading min/max spread.
async function drawCallsSpinning(page, seconds) {
  await page.evaluate(() => { const rr = window.liveScene3d.renderer; rr.info.autoReset = false; rr.info.reset(); });
  const snap = () => page.evaluate(() => ({ c: window.liveScene3d.renderer.info.render.calls, t: window.liveScene3d.renderer.info.render.triangles, f: window.__sz.frames }));
  const h0 = await headingOf(page);
  let prev = await snap(); const first = prev; const wins = [];
  const steps = Math.max(2, Math.round(seconds * 2));
  for (let i = 0; i < steps; i++) { await sleep(500); const cur = await snap(); const df = cur.f - prev.f; if (df > 0) wins.push((cur.c - prev.c) / df); prev = cur; }
  const h1 = await headingOf(page);
  await page.evaluate(() => { window.liveScene3d.renderer.info.autoReset = true; });
  const tf = Math.max(1, prev.f - first.f);
  return { mean: +((prev.c - first.c) / tf).toFixed(1), tris: Math.round((prev.t - first.t) / tf),
    min: wins.length ? Math.round(Math.min(...wins)) : null, max: wins.length ? Math.round(Math.max(...wins)) : null,
    windows: wins.map((w) => Math.round(w)), frames: tf, headingStart: h0, headingEnd: h1 };
}

(async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  let pw;
  try { pw = require("playwright-core"); }
  catch (_) { const home = process.env.HOME;
    const hits = fs.readdirSync(`${home}/.npm/_npx`).map((d) => `${home}/.npm/_npx/${d}/node_modules/playwright-core`).filter((p) => fs.existsSync(p));
    if (!hits.length) { console.error("playwright-core not found"); process.exit(2); } pw = require(hits[0]); }

  const browser = await pw.chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const page = await ctx.newPage();
  const q = new URLSearchParams({ renderer: "3d", autoLogin: "1", account: ACCOUNT, password: ACCOUNT, autoSpawn: "first", nosw: "1", vfxGauge: "on", renderDiag: "on" });
  if (process.env.EXTRA_QUERY) for (const [k, v] of new URLSearchParams(process.env.EXTRA_QUERY)) q.set(k, v);
  console.error(`[sz] query: ${q}`);
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (consoleErrors.length < 40) consoleErrors.push(t); } });
  page.on("pageerror", (e) => { if (consoleErrors.length < 40) consoleErrors.push("PAGEERROR: " + String(e?.message ?? e)); });
  await page.goto(`${SERVE}?${q}`, { timeout: 60000 });

  let inWorld = false;
  for (let i = 0; i < 240; i++) { const bs = await page.evaluate(() => window.__bootState).catch(() => null);
    if (bs === "in-world" || bs === "ready") { inWorld = true; break; } if (bs === "error") break; await sleep(1000); }
  if (!inWorld) { console.error("[sz] NOT in-world; abort"); try { await page.close(); } catch (_) {} process.exit(3); }

  const gpu = await page.evaluate(() => { try { const c = document.createElement("canvas"); const gl = c.getContext("webgl2") || c.getContext("webgl");
    const ext = gl.getExtension("WEBGL_debug_renderer_info"); return gl.getParameter(ext.UNMASKED_RENDERER_WEBGL); } catch (e) { return "ERR:" + e; } }).catch(() => "ERR");
  console.error(`[sz] UNMASKED_RENDERER = ${gpu}`);
  const realGpu = /NVIDIA|GTX|Direct3D/i.test(String(gpu));

  // In-page harness: rAF frame counter + opt-in tCpu collector.
  await page.evaluate(() => {
    if (window.__sz) return;
    window.__sz = { frames: 0, maxFrameMs: 0, collecting: false, cpu: [], gpu: [] };
    let last = performance.now();
    const loop = () => { const now = performance.now(); const dt = now - last; last = now;
      window.__sz.frames++; if (dt > window.__sz.maxFrameMs) window.__sz.maxFrameMs = dt;
      if (window.__sz.collecting) { const g = window.__diag && window.__diag.vfxGauge;
        if (g && g.tCpuMs > 0) window.__sz.cpu.push(g.tCpuMs); if (g && g.tGpuMs > 0) window.__sz.gpu.push(g.tGpuMs); }
      requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }).catch(() => {});

  for (let i = 0; i < 90; i++) { if (await page.evaluate(() => !!(window.liveScene3d && window.liveScene3d.scene)).catch(() => false)) break; await sleep(1000); }
  const chat = (c) => page.evaluate((cmd) => { try { window.__sessionHandle.sendChat(cmd); } catch (_) {} }, c).catch(() => {});

  const entRootsNow = () => page.evaluate(() => window.liveScene3d?.entitiesGroup?.children?.length ?? 0).catch(() => 0);
  const terrNow = () => page.evaluate(() => window.liveScene3d?.terrainBakedLbs?.size ?? 0).catch(() => 0);

  // ── Teleport + settle to TRUE steady (terrain stable AND entRoots stable). ──
  console.error(`[sz] @telepoi ${POI}`);
  await chat(`@telepoi ${POI}`);
  await sleep(4000);
  let lastT = -1, tStable = 0;
  for (let i = 0; i < 30; i++) { await sleep(1500); const t = await terrNow(); if (t > 0 && t === lastT) { if (++tStable >= 3) break; } else tStable = 0; lastT = t; }
  // entRoots steady: within ±2 across 4 consecutive 2s reads.
  let prevE = await entRootsNow(), eStable = 0;
  for (let i = 0; i < 30; i++) { await sleep(2000); const e = await entRootsNow();
    if (Math.abs(e - prevE) <= 2) { if (++eStable >= 4) { prevE = e; break; } } else eStable = 0; prevE = e; }
  console.error(`[sz] TRUE-steady: terr=${lastT} entRoots≈${prevE}`);

  // ── D + 1: scene census (instant) — split + entity instancing ceiling. ─────
  const census = await page.evaluate(() => {
    const ls = window.liveScene3d; const scene = ls.scene;
    const byName = {}; for (const n of ["terrain", "statics", "buildings", "entities"]) byName[n] = scene.getObjectByName(n);
    const countMeshes = (root) => { let m = 0; if (root) root.traverse((o) => { if ((o.isMesh || o.isInstancedMesh || o.isBatchedMesh) && o.visible !== false) m++; }); return m; };
    const split = {}; for (const [k, g] of Object.entries(byName)) split[k] = countMeshes(g);
    // entity instancing ceiling: key part meshes by (guid,partIndex,surfaceDid) and by (wcid,part,surface).
    const eg = ls.entitiesGroup; let totalEnt = 0; const kGuid = new Set(), kWcid = new Set();
    if (eg) for (const er of eg.children) { const wcid = er.userData && er.userData.modelId != null ? (er.userData.modelId >>> 0) : 0;
      er.traverse((o) => { if (!(o.isMesh || o.isInstancedMesh)) return; if (o.visible === false) return; totalEnt++;
        const ud = o.userData || {}; const part = ud.partIndex ?? -1; const surf = ud.surfaceDid ?? -1; const guid = ud.guid ?? "n";
        kGuid.add(`${guid}|${part}|${surf}`); kWcid.add(`${wcid}|${part}|${surf}`); }); }
    // statics + buildings draw-collapse ceiling: key visible meshes by (geometry,material);
    // count how many are ALREADY batched/instanced (1 node = many draws) vs individual.
    const hasLodAncestor = (o) => { let p = o; while (p) { if (p.isLOD) return true; p = p.parent; } return false; };
    const staticCollapse = (name) => {
      const g = scene.getObjectByName(name); const gm = new Set(); let batched = 0, instanced = 0, indiv = 0;
      // exclusion reasons mirroring static_atlas.js:389 (why an individual static can't atlas)
      const reason = { lod: 0, "no-uv": 0, "no-map": 0, "no-pixels": 0, deformed: 0, "staticbatch-tagged": 0, eligible: 0 };
      const eligibleGm = new Set();
      let particleMeshes = 0, particleBuckets = 0, particleInstances = 0;
      if (g) g.traverse((o) => { if (o.visible === false) return;
        // Particles are NOT batchable statics — count them in their own bucket.
        // The static ParticleManager's scene IS staticsGroup (statics.js ~464),
        // so every live particle billboard is a direct child of `statics`. A
        // billboard is a textured quad, so it passes the whole eligibility
        // ladder below and used to be reported as an atlas-batchable static —
        // that is precisely what produced the phantom "~1000 eligible statics
        // bypassing the atlas" lead (refuted in 9baa72b2: with
        // ?staticScripts=off the eligible count was EXACTLY 0). Keyed on the
        // explicit userData.__particle stamp (particle_manager meshFactory),
        // NOT on depthWrite/frustumCulled — that heuristic misses the alpha
        // (NormalBlending, depthWrite=true) particles.
        if (o.userData?.isParticleInstanced) { particleBuckets++; particleInstances += o.count | 0; return; }
        if (o.userData?.__particle) { particleMeshes++; return; }
        if (o.isBatchedMesh) { batched++; return; } if (o.isInstancedMesh) { instanced++; return; }
        if (!o.isMesh) return; indiv++;
        const gid = o.geometry?.uuid ?? "n"; const mid = Array.isArray(o.material) ? o.material.map((m) => m.uuid).join(",") : (o.material?.uuid ?? "n"); gm.add(`${gid}|${mid}`);
        const mat = Array.isArray(o.material) ? o.material[0] : o.material;
        const tex = mat && mat.map; const img = tex && tex.image;
        if (hasLodAncestor(o)) reason.lod++;
        else if (!o.geometry || !o.geometry.attributes?.uv) reason["no-uv"]++;
        else if (!tex) reason["no-map"]++;
        else if (!img || !img.data) reason["no-pixels"]++;
        else if (typeof mat.userData?.__vfxSetKey === "string" && mat.userData.__vfxSetKey.includes("deformation.")) reason.deformed++;
        else if (o.userData?.__staticBatch) reason["staticbatch-tagged"]++;
        else { reason.eligible++; eligibleGm.add(`${gid}|${mid}`); }
      });
      return { individualMeshes: indiv, distinctGeomMat: gm.size, collapsible: indiv - gm.size, batchedNodes: batched, instancedNodes: instanced,
        excludeReasons: reason, eligibleDistinctGeomMat: eligibleGm.size,
        // reported, not silently dropped: particles ARE real draws (one per live
        // billboard, frustumCulled=false) — they are just not ATLAS-batchable.
        // See ?particleInstancing for the lever that actually collapses them.
        particleMeshes, particleBuckets, particleInstances };
    };
    const rr = ls.renderer;
    return { split, totalEntMeshes: totalEnt, distinctGuidKeys: kGuid.size, distinctWcidKeys: kWcid.size,
      staticsCollapse: staticCollapse("statics"), buildingsCollapse: staticCollapse("buildings"),
      programs: Array.isArray(rr?.info?.programs) ? rr.info.programs.length : null,
      geometries: rr?.info?.memory?.geometries ?? null, textures: rr?.info?.memory?.textures ?? null };
  });
  console.error(`[sz] staticsCollapse: ${JSON.stringify(census.staticsCollapse)}`);
  console.error(`[sz] buildingsCollapse: ${JSON.stringify(census.buildingsCollapse)}`);
  // Particles are draws but NOT atlas-batchable — keep them beside `eligible`
  // so the two are never conflated again (see 9baa72b2).
  const _sp = census.staticsCollapse;
  console.error(`[sz] statics particles: meshes=${_sp.particleMeshes} (each = 1 draw, frustumCulled=false) | instancedBuckets=${_sp.particleBuckets} instances=${_sp.particleInstances} — NOT counted in eligible=${_sp.excludeReasons.eligible}`);
  if (process.env.CENSUS_ONLY === "1") {
    // facing-averaged draw-calls/frame: spin in place so FCULL variance cancels.
    await spin(page, true);
    const dc = await drawCallsSpinning(page, 8);
    await spin(page, false);
    const drawCalls = dc.mean;
    console.error(`[sz] draw calls/frame (spin-avg) = ${dc.mean} | per-heading min ${dc.min}/max ${dc.max} (spread ${dc.max != null ? dc.max - dc.min : "?"}) frames=${dc.frames}`);
    const bgChildren = await page.evaluate(() => window.liveScene3d?.buildingsGroup?.children?.length ?? -1).catch(() => -1);
    const atlasStats = await page.evaluate(() => (typeof window.__atlasStats === "function" ? window.__atlasStats() : null)).catch(() => null);
    if (atlasStats) {
      const full = (atlasStats.buckets || []).filter((b) => b.full).length;
      console.error(`[sz] atlasStats: atlased=${atlasStats.atlased} nodesIn=${atlasStats.nodesIn} ptLayerFull=${atlasStats.ptLayerFull} ptDeformed=${atlasStats.ptDeformed} ptFiltered=${atlasStats.ptFiltered} ptNorm/Geom/Inst=${atlasStats.ptNormFail}/${atlasStats.ptGeomFail}/${atlasStats.ptInstFail} | buckets=${atlasStats.bucketCount} full=${full} atlasBakedLbs=${atlasStats.atlasBakedLbs}`);
    }
    const diagC = await page.evaluate(() => { const d = window.__diag || {}; const pick = (o) => { try { return JSON.parse(JSON.stringify(o)); } catch (_) { return null; } }; return { vfxGauge: pick(d.vfxGauge), render: pick(d.render) }; }).catch(() => ({}));
    const shot = OUT.replace(/\.json$/, ".png");
    try { await page.screenshot({ path: shot }); } catch (_) {}
    fs.writeFileSync(OUT, JSON.stringify({ censusOnly: true, generatedAtMs: Date.now(), poi: POI, query: q.toString(), steadyEntRoots: prevE, steadyTerr: lastT, drawCallsPerFrame: drawCalls, drawSpread: { min: dc.min, max: dc.max, windows: dc.windows, frames: dc.frames }, buildingsGroupChildren: bgChildren, atlasStats, census, consoleErrors, vfxGauge: diagC.vfxGauge, renderDiag: diagC.render }, null, 2));
    console.error(`[sz] CENSUS_ONLY: drawCalls=${drawCalls} buildingsGroupChildren=${bgChildren} consoleErrors=${consoleErrors.length} shot=${shot}`);
    if (consoleErrors.length) console.error(`[sz] ERRORS: ${JSON.stringify(consoleErrors.slice(0, 8))}`);
    console.error(`[sz] wrote ${OUT}`);
    try { await page.close(); } catch (_) {} process.exit(0);
  }
  console.error(`[sz] split(meshNodes): ${JSON.stringify(census.split)} | entMeshes=${census.totalEntMeshes} distinctGuid=${census.distinctGuidKeys} distinctWcid=${census.distinctWcidKeys}`);

  // ── B: facing-averaged draw-calls. Spin in place (no translation → residency ──
  // unchanged) so FCULL frustum-cull variance cancels; keep spinning through the CPU
  // profile + matrix A/B below so tCpu is facing-averaged too. Stopped before detach.
  await spin(page, true);
  const dc = await drawCallsSpinning(page, 8);
  const drawCallsPerFrame = dc.mean; const trisPerFrame = dc.tris;
  console.error(`[sz] draw calls/frame (spin-avg) = ${drawCallsPerFrame} tris=${trisPerFrame} | per-heading min ${dc.min}/max ${dc.max} (spread ${dc.max != null ? dc.max - dc.min : "?"}) frames=${dc.frames}`);

  // ── G: light-count variance (relink churn signal). ─────────────────────────
  const lightSamples = [];
  for (let i = 0; i < 20; i++) { const lc = await page.evaluate(() => { let n = 0; window.liveScene3d.scene.traverse((o) => { if (o.isLight && o.visible !== false && (o.intensity === undefined || o.intensity > 0)) n++; }); return n; }).catch(() => -1); lightSamples.push(lc); await sleep(100); }
  const litMin = Math.min(...lightSamples), litMax = Math.max(...lightSamples);
  console.error(`[sz] lit-light count over 2s: min=${litMin} max=${litMax} (churn=${litMax - litMin})`);

  // ── E: fresh CPU profile at TRUE steady. ───────────────────────────────────
  const client = await ctx.newCDPSession(page);
  await client.send("Profiler.enable");
  await client.send("Profiler.setSamplingInterval", { interval: SAMPLE_INTERVAL_US });
  console.error(`[sz] profiling ${PROFILE_S}s at true-steady…`);
  await client.send("Profiler.start");
  await sleep(PROFILE_S * 1000);
  const { profile } = await client.send("Profiler.stop");

  // ── F: matrix-freeze A/B (median tCpu). ────────────────────────────────────
  const collect = async (ms) => { await page.evaluate(() => { window.__sz.cpu = []; window.__sz.gpu = []; window.__sz.collecting = true; });
    await sleep(ms); return page.evaluate(() => { window.__sz.collecting = false; return { cpu: window.__sz.cpu.slice(), gpu: window.__sz.gpu.slice() }; }); };
  const baseAB = await collect(2500);
  const froze = await page.evaluate(() => {
    const scene = window.liveScene3d.scene; let n = 0; const touched = [];
    for (const name of ["terrain", "statics", "buildings"]) { const g = scene.getObjectByName(name); if (!g) continue;
      g.traverse((o) => { if (o.matrixWorldAutoUpdate !== false) { o.matrixWorldAutoUpdate = false; touched.push(o); n++; } }); }
    window.__szTouched = touched; return n;
  });
  await sleep(500);
  const frozenAB = await collect(2500);
  const restored = await page.evaluate(() => { const t = window.__szTouched || []; for (const o of t) o.matrixWorldAutoUpdate = true; const n = t.length; window.__szTouched = null; return n; });
  await spin(page, false); // stop rotating
  const baseCpu = median(baseAB.cpu), frozenCpu = median(frozenAB.cpu);
  console.error(`[sz] matrix A/B: froze ${froze} nodes; tCpu median base=${baseCpu?.toFixed?.(2)}ms frozen=${frozenCpu?.toFixed?.(2)}ms Δ=${baseCpu && frozenCpu ? (baseCpu - frozenCpu).toFixed(2) : "?"}ms (restored ${restored})`);

  // diag + counts.
  const diag = await page.evaluate(() => { const d = window.__diag || {}; const pick = (o) => { try { return JSON.parse(JSON.stringify(o)); } catch (_) { return null; } };
    return { vfxGauge: pick(d.vfxGauge), render: pick(d.render) }; }).catch(() => ({}));

  // aggregate profile self-time.
  const nodes = profile.nodes || []; const agg = new Map(); let totalHits = 0;
  for (const n of nodes) { const hc = n.hitCount || 0; if (!hc) continue; totalHits += hc; const cf = n.callFrame || {};
    let fn = cf.functionName || "(anonymous)"; let url = cf.url || ""; if (url === "" && fn === "(anonymous)") fn = "(program)";
    const shortUrl = url.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
    const key = `${fn}@@${shortUrl}:${cf.lineNumber ?? -1}`; const e = agg.get(key) || { fn, url: shortUrl, line: cf.lineNumber ?? -1, hits: 0 }; e.hits += hc; agg.set(key, e); }
  const us = SAMPLE_INTERVAL_US;
  const rows = [...agg.values()].map((e) => ({ fn: e.fn, loc: `${e.url}:${e.line}`, selfMs: +(e.hits * us / 1000).toFixed(1), pct: +(100 * e.hits / totalHits).toFixed(1) })).sort((a, b) => b.selfMs - a.selfMs);
  const buckets = {}; for (const e of agg.values()) { let b = "other";
    if (/three\.module|three\.core|WebGLRenderer/i.test(e.url)) b = "three-render"; else if (/loop\.js/.test(e.url)) b = "loop-tick";
    else if (/entities\.js/.test(e.url)) b = "entities"; else if (/statics|static_atlas|buildings/.test(e.url)) b = "statics";
    else if (/nameplate|hud|overlay/i.test(e.url)) b = "nameplate-hud"; else if (/particle/i.test(e.url)) b = "particles";
    else if (/holtburger_web|wasm/.test(e.url)) b = "wasm"; else if (e.url === "") b = "native/gc/vm"; buckets[b] = (buckets[b] || 0) + e.hits; }
  const bucketRows = Object.entries(buckets).map(([k, h]) => ({ bucket: k, selfMs: +(h * us / 1000).toFixed(1), pct: +(100 * h / totalHits).toFixed(1) })).sort((a, b) => b.selfMs - a.selfMs);
  const getParams = rows.find((r) => r.fn === "getParameters");

  const result = {
    generatedAtMs: Date.now(), gpu: String(gpu), realGpu, poi: POI, steadyEntRoots: prevE, steadyTerr: lastT,
    B_drawCallsPerFrame: drawCallsPerFrame, B_trisPerFrame: trisPerFrame, B_overFrames: dc.frames,
    B_drawSpread: { min: dc.min, max: dc.max, windows: dc.windows, headingStart: dc.headingStart, headingEnd: dc.headingEnd },
    D_meshNodeSplit: census.split,
    L1_totalEntMeshes: census.totalEntMeshes, L1_distinctGuidKeys: census.distinctGuidKeys, L1_distinctWcidKeys: census.distinctWcidKeys,
    L1_collapsibleDraws_byGuid: census.totalEntMeshes - census.distinctGuidKeys,
    L1_collapsibleDraws_byWcid: census.totalEntMeshes - census.distinctWcidKeys,
    G_litLightCount: { min: litMin, max: litMax, churn: litMax - litMin, samples: lightSamples },
    F_matrixFreeze: { frozeNodes: froze, restoredNodes: restored, baseCpuMs: baseCpu, frozenCpuMs: frozenCpu,
      deltaCpuMs: baseCpu && frozenCpu ? +(baseCpu - frozenCpu).toFixed(2) : null, baseSamples: baseAB.cpu.length, frozenSamples: frozenAB.cpu.length },
    E_profile: { totalSamples: totalHits, getParameters: getParams || null, buckets: bucketRows, top: rows.slice(0, 25) },
    programs: census.programs, geometries: census.geometries, textures: census.textures,
    vfxGauge: diag.vfxGauge, renderDiag: diag.render,
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.error(`\n[sz] ===== SIZING SUMMARY (${POI}, steady entRoots≈${prevE}) =====`);
  console.error(`[sz] B  draw-calls/frame:        ${drawCallsPerFrame}  (tris ${trisPerFrame})`);
  console.error(`[sz] D  meshNode split:          ${JSON.stringify(census.split)}`);
  console.error(`[sz] 1  entity draws:            ${census.totalEntMeshes} → collapsible ${census.totalEntMeshes - census.distinctGuidKeys} (byGuid) / ${census.totalEntMeshes - census.distinctWcidKeys} (byWcid); floor ${census.distinctGuidKeys} guid-groups`);
  console.error(`[sz] 2  static matrix-freeze Δ:  ${result.F_matrixFreeze.deltaCpuMs}ms/frame (base ${baseCpu?.toFixed?.(2)} → ${frozenCpu?.toFixed?.(2)})`);
  console.error(`[sz] 3  getParameters:           ${getParams ? getParams.selfMs + "ms " + getParams.pct + "%" : "≈0 (evaporated at steady → was transient)"}; lit-light churn ${litMax - litMin}`);
  console.error(`[sz] E  three-render bucket:     ${bucketRows.find((b) => b.bucket === "three-render")?.pct}%`);
  console.error(`[sz] wrote ${OUT}`);
  try { await client.detach(); } catch (_) {}
  try { await page.close(); } catch (_) {}
  process.exit(0);
})().catch((e) => { console.error("[sz] FATAL", e); process.exit(1); });

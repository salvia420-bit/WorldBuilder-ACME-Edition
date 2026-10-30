// laptop-rust-boot-smoke.mjs — does the client boot clean with the Rust scene-core
// flags on, and are the Rust paths actually the ones running?
//
// docs/2026-10-26-rust-scene-core.md. The owner's bar for a default flip is "the bare URL
// loads, spawns, 0 console errors"; this checks that bar on the laptop (SwiftShader, so no
// timings) for any flag set, and reads every lane's diagnostic so a silent fallback to the
// JS path shows up as `available: false` / zero counts instead of passing quietly.
//
// RUN ONLY UNDER capped-build (~/CLAUDE.md: a headless Chrome on a real world is a heavy
// job; one at a time, >= 2.5 GB available):
//   capped-build node scripts/perf-worker/laptop-rust-boot-smoke.mjs --label bare --flags ''
//   capped-build node scripts/perf-worker/laptop-rust-boot-smoke.mjs --label rust-all
// Default --flags turns every lane flag on. --settle-sec (default 90) after in-world.

import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { uncappedBenchUrl } from "./lib/bench-url.mjs";
import { acquireHeavyLock } from "../../apps/holtburger-web/harness/lib/heavy_lock.mjs";
import { classifyBoot, formatBootHistory } from "../../apps/holtburger-web/harness/moving-bench.mjs";
import { buildProbeUrl, inBuildsCgroup, VIEWPORT } from "./laptop-structure-probe.mjs";

const PLAYWRIGHT_CORE = process.env.PLAYWRIGHT_CORE || "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core";
export const ALL_RUST_FLAGS = [
  "rustParticles=on", "rustRig=on", "rustEntityCull=on", "rigMeshAlias=on",
  "anchorOffGraph=on", "staticMatrixFreeze=on", "poolSizeToContent=on", "rustCull=on",
  "rustAnimScenery=on", "rustAnimSceneryGate=on", "rustTerrainFx=on",
  "drawExec=on", "drawExecRigs=on",
  "hotMatVariant=on", "hotDrawSort=on", "hotCloudPush=on", "hotTerrainTime=on", "hotNightRamp=on",
].join("&");

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? "" : v;
}

async function readBoot(page) {
  return page.evaluate(() => {
    let pose = false;
    try { const p = window.__sessionHandle?.getLocalPlayerPose?.(); pose = !!p; try { p?.free?.(); } catch (_) { /* released */ } } catch (_) { /* not yet */ }
    let meshes = 0;
    try { window.liveScene3d?.scene?.traverse((o) => { if (o.isMesh) meshes += 1; }); } catch (_) { /* not yet */ }
    return {
      state: window.__bootState ?? null,
      history: (window.__bootStateHistory || []).map((e) => ({ state: e.state, message: e.message || "" })),
      sceneReadyEverFired: !!window.__sceneReadyEverFired,
      inFlight: typeof window.__autoLoginInFlight === "function" ? window.__autoLoginInFlight() : false,
      live: !!window.liveScene3d, handle: !!window.__sessionHandle, pose, meshes,
    };
  }).catch(() => null);
}

async function main() {
  const t0 = Date.now();
  const log = (...m) => console.log(`[rust-boot-smoke ${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...m);
  let cg = null;
  try { cg = readFileSync("/proc/self/cgroup", "utf8"); } catch (_) { /* not Linux */ }
  if (inBuildsCgroup(cg) === false) {
    console.error("[rust-boot-smoke] REFUSED: not inside the capped-build cgroup (headless Chrome is a heavy job).");
    return 2;
  }
  const label = String(arg("--label", "rust-all")).replace(/[^A-Za-z0-9_.-]+/g, "_");
  const flags = arg("--flags", ALL_RUST_FLAGS);
  const settleSec = Number(arg("--settle-sec", 90));
  const quality = String(arg("--quality", "ultra"));
  const outDir = String(arg("--out", `/mnt/wbterminal1/tmp/claude-scratch/perf/rust-boot-smoke-${label}`));
  mkdirSync(outDir, { recursive: true });
  // renderScale=0.5 keeps SwiftShader's per-frame cost (and the GPU process's memory) down;
  // it changes no code path the flags touch.
  const tail = [`renderScale=${arg("--render-scale", "0.5")}`, flags].filter(Boolean).join("&");
  const url = uncappedBenchUrl(buildProbeUrl({ quality }) + "&" + tail);
  const res = { schema: "hb-rust-boot-smoke-v1", label, flags, quality, url: url.replace(/password=[^&]*/, "password=***"), startedAt: new Date().toISOString() };
  const heavy = await acquireHeavyLock({ label: `laptop-rust-boot-smoke ${label}` });
  res.heavyLock = { waitedMs: heavy.waitedMs };
  const require = createRequire(import.meta.url);
  const { chromium } = require(PLAYWRIGHT_CORE);
  let browser = null, code = 1;
  const consoleErrors = [], pageErrors = [], warnings = [];
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM || "/usr/bin/chromium", headless: true,
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--mute-audio",
        "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"],
    });
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    page.on("console", (m) => {
      const t = m.text();
      if (m.type() === "error" && consoleErrors.length < 200) consoleErrors.push(t.slice(0, 400));
      if (m.type() === "warning" && /scene_core|rust|Rust|SceneParticles|SceneRigs|SceneStaticsCull|SceneAnimScenery|SceneScatterPlanner|drawExec/.test(t) && warnings.length < 100) warnings.push(t.slice(0, 400));
    });
    page.on("pageerror", (e) => { if (pageErrors.length < 100) pageErrors.push(String(e?.stack ?? e).slice(0, 600)); });
    page.on("crash", () => pageErrors.push("PAGE CRASH"));
    log(`goto ${res.url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    const bootT = Date.now();
    let attempt = 0, snap = null;
    for (;;) {
      snap = await readBoot(page);
      const d = classifyBoot(snap, { attempt, maxAttempts: 2 });
      if (d.action === "fatal") throw new Error(`boot failed: ${d.reason}\n${formatBootHistory(snap)}`);
      if (d.action === "relogin") {
        attempt += 1;
        await new Promise((r) => setTimeout(r, 9000));
        await page.evaluate(() => window.__runAutonomousLogin?.({ autoSpawn: "first", maxRetries: 1 })).catch(() => {});
        continue;
      }
      if (d.action === "go" && snap.live && snap.handle && snap.pose && snap.meshes > 100) break;
      if (Date.now() - bootT > 480000) throw new Error(`boot timeout\n${formatBootHistory(snap)}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    res.boot = { ms: Date.now() - bootT, relogins: attempt, meshes: snap.meshes, history: snap.history };
    log(`booted in ${(res.boot.ms / 1000).toFixed(0)} s (${snap.meshes} meshes)`);
    // --telepoi <POI>: move the (Developer) bot somewhere with the content a lane needs
    // (animated scenery, a town's statics) before the settle; ACE's @telepoi, as the
    // structure probe's towns use @teleloc.
    const poi = arg("--telepoi", "");
    if (poi) {
      res.telepoi = await page.evaluate((p) => {
        try { window.__sessionHandle?.sendChat?.(`@telepoi ${p}`); return "sent"; } catch (e) { return String(e?.message ?? e); }
      }, poi);
      log(`@telepoi ${poi}: ${res.telepoi}`);
      await new Promise((r) => setTimeout(r, 20000));
    }
    log(`settling ${settleSec} s`);
    await new Promise((r) => setTimeout(r, settleSec * 1000));
    // --profile-sec N: a V8 CPU profile of the settled, still scene (an A/B arm: same
    // --telepoi, a fresh profile dir per arm). SwiftShader makes the frame rate meaningless
    // but not the main thread's JS per frame: bucket with
    //   python3 -I tools/rust_parity/profile_systems.py OUT/run.cpuprofile <frames>
    // (frames = rAF callbacks counted over the same window, written to profile.json).
    const profileSec = Number(arg("--profile-sec", 0));
    if (profileSec > 0) {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 250 });
      await page.evaluate(() => {
        window.__abFrames = 0;
        const f = () => { window.__abFrames += 1; if (window.__abFramesOn) requestAnimationFrame(f); };
        window.__abFramesOn = true; requestAnimationFrame(f);
      });
      const pt0 = Date.now();
      await cdp.send("Profiler.start");
      await new Promise((r) => setTimeout(r, profileSec * 1000));
      const { profile } = await cdp.send("Profiler.stop");
      const frames = await page.evaluate(() => { window.__abFramesOn = false; return window.__abFrames; });
      writeFileSync(join(outDir, "run.cpuprofile"), JSON.stringify(profile));
      res.profile = { sec: (Date.now() - pt0) / 1000, frames, fps: frames / ((Date.now() - pt0) / 1000) };
      writeFileSync(join(outDir, "profile.json"), JSON.stringify(res.profile, null, 1));
      log(`profile: ${JSON.stringify(res.profile)}`);
      await cdp.detach().catch(() => {});
    }
    // ?drawExec (DEFAULT ON): what the draws are and how the executor handled them
    // (`census`, --dx-census N rAF frames, default 60; 0 skips), then the per-draw self-check
    // against the REAL driver's program / VAO bindings (`verify`, --dx-verify N, default 120).
    // Both run after the settle: inside the teleport settle `verify` checks no draws. Pass bar
    // (handoff 2026-10-26 §RESUME 1): verify fails 0 with checks > 0, stats.texDemoted 0.
    // SwiftShader runs ~0.1 fps at Holtburg, so the defaults take ~30 min.
    const dxCensusFrames = Number(arg("--dx-census", 60));
    if (dxCensusFrames > 0) {
      res.drawExecCensus = await page.evaluate(async (n) => {
        try { return window.__drawExec?.census ? await window.__drawExec.census(n) : null; } catch (e) { return { error: String(e?.message ?? e) }; }
      }, dxCensusFrames).catch((e) => ({ error: String(e?.message ?? e) }));
      writeFileSync(join(outDir, "drawexec-census.json"), JSON.stringify(res.drawExecCensus, null, 1));
      log(`drawExec census: ${JSON.stringify(res.drawExecCensus).slice(0, 600)}`);
    }
    const dxVerifyFrames = Number(arg("--dx-verify", 120));
    res.drawExecVerify = await page.evaluate(async (n) => {
      try { return window.__drawExec?.verify ? await window.__drawExec.verify(n) : null; } catch (e) { return { error: String(e?.message ?? e) }; }
    }, dxVerifyFrames).catch((e) => ({ error: String(e?.message ?? e) }));
    log(`drawExec verify(${dxVerifyFrames}): ${JSON.stringify(res.drawExecVerify)}`);
    // --census N: R3's draw-list census (drawlist-census.eval.js, phase "all", still camera)
    // over N frames. Draw / switch / GL-call COUNTS do not depend on the GPU, so SwiftShader's
    // numbers are the real ones; its timings are not. It wraps renderBufferDirect, so run it
    // without ?drawExec (executed draws bypass that).
    const censusFrames = Number(arg("--census", 0));
    if (censusFrames > 0) {
      const src = readFileSync(new URL("./drawlist-census.eval.js", import.meta.url), "utf8");
      res.drawlistCensus = await page.evaluate(async ({ src, n }) => {
        try {
          window.__dlcPhase = "all"; window.__dlcFrames = n; window.__dlcOrbit = false;
          const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
          return await new AsyncFunction(src)();
        } catch (e) { return { error: String(e?.stack ?? e) }; }
      }, { src, n: censusFrames }).catch((e) => ({ error: String(e?.message ?? e) }));
      writeFileSync(join(outDir, "drawlist-census.json"), JSON.stringify(res.drawlistCensus, null, 1));
      log(`drawlist census: ${JSON.stringify(res.drawlistCensus).slice(0, 600)}`);
    }
    res.diag = await page.evaluate(() => {
      const call = (f) => { try { return typeof f === "function" ? f() : null; } catch (e) { return { error: String(e?.message ?? e) }; } };
      let meshes = 0;
      try { window.liveScene3d?.scene?.traverse((o) => { if (o.isMesh) meshes += 1; }); } catch (_) { /* gone */ }
      return {
        bootState: window.__bootState ?? null,
        meshes,
        sceneCoreAbi: (() => { try { return window.__hbSceneWasm?.sceneCoreAbi?.() ?? null; } catch (_) { return null; } })(),
        rustRig: call(window.__rustRig?.stats),
        rigMeshAlias: call(window.__rigMeshAlias?.stats),
        rustCull: call(window.__rustCull?.stats),
        rustCullVerify: call(window.__rustCull?.verify),
        rustAnimScenery: call(window.__rustAnimScenery?.stats),
        animSceneryDiag: (() => { try { const d = window.__animSceneryDiag?.(); return d ? { rustAnimScenery: d.rustAnimScenery ?? null, groups: d.groups ?? d.groupCount ?? null, instances: d.instances ?? d.instanceCount ?? null } : null; } catch (e) { return { error: String(e?.message ?? e) }; } })(),
        rustTerrainFx: call(window.__rustTerrainFx?.stats),
        rustWorld: call(window.__rustWorld?.stats),
        // audit() also returns its input arena (every instance matrix): never hand that back to node.
        rustWorldAudit: (() => { try { const a = window.__rustWorld?.audit?.(); return a ? { mismatches: a.mismatches, report: a.report } : null; } catch (e) { return { error: String(e?.message ?? e) }; } })(),
        particles: call(window.__particleInstancingDiag),
        drawExec: (() => { try { const st = window.__drawExec?.stats; return st ? { ...st } : null; } catch (e) { return { error: String(e?.message ?? e) }; } })(),
        renderCalls: window.liveScene3d?.renderer?.info?.render?.calls ?? null,
        // Instancing headroom for rig parts (a stage-3 question): visible entity meshes, and
        // how many distinct materials / (geometry, material) pairs they use.
        entityParts: (() => {
          try {
            const g = window.liveScene3d?.entitiesGroup;
            if (!g) return null;
            let meshes = 0, skinned = 0, instanced = 0;
            const mats = new Set(), pairs = new Map(), rigs = new Set();
            const visit = (o, root) => {
              if (o.visible === false) return;
              if (o.isMesh) {
                if (o.isSkinnedMesh) skinned += 1;
                else if (o.isInstancedMesh || o.isBatchedMesh) instanced += 1;
                else {
                  meshes += 1; rigs.add(root);
                  const ms = Array.isArray(o.material) ? o.material : [o.material];
                  for (const m of ms) {
                    if (!m) continue;
                    mats.add(m);
                    const k = `${o.geometry?.uuid}|${m.uuid}`;
                    pairs.set(k, (pairs.get(k) || 0) + 1);
                  }
                }
              }
              for (const c of o.children) visit(c, root);
            };
            for (const c of g.children) visit(c, c);
            let multi = 0, inMulti = 0;
            for (const n of pairs.values()) if (n > 1) { multi += 1; inMulti += n; }
            return { rigs: rigs.size, meshes, skinned, instanced, materials: mats.size, pairs: pairs.size,
              pairsUsedMoreThanOnce: multi, meshesInSharedPairs: inMulti };
          } catch (e) { return { error: String(e?.message ?? e) }; }
        })(),
      };
    });
    log(`diag: ${JSON.stringify(res.diag).slice(0, 1200)}`);
    // The executor's bar in one place (null when the executor is not installed).
    const v = res.drawExecVerify, st = res.diag?.drawExec;
    res.drawExecBar = v && st && !v.error && !st.error
      ? { checks: v.checks, fails: v.fails, texDemoted: st.texDemoted, vaoFixLate: st.vaoFixLate, errors: st.errors,
        pass: v.fails === 0 && v.checks > 0 && st.texDemoted === 0 }
      : null;
    log(`drawExec bar: ${JSON.stringify(res.drawExecBar)}`);
    // --hop <POI>: a second @telepoi after the diag (residency churn: park / evict / feed),
    // then the shadow audit again (?rustWorld, lane W).
    const hop = arg("--hop", "");
    if (hop) {
      await page.evaluate((p) => { try { window.__sessionHandle?.sendChat?.(`@telepoi ${p}`); } catch (_) { /* gone */ } }, hop);
      log(`@telepoi ${hop} (hop); settling ${settleSec} s`);
      await new Promise((r) => setTimeout(r, 20000 + settleSec * 1000));
      res.afterHop = await page.evaluate(() => {
        const call = (f) => { try { return typeof f === "function" ? f() : null; } catch (e) { return { error: String(e?.message ?? e) }; } };
        const a = (() => { try { return window.__rustWorld?.audit?.() ?? null; } catch (e) { return { error: String(e?.message ?? e) }; } })();
        return { bootState: window.__bootState ?? null, rustWorld: call(window.__rustWorld?.stats), rustWorldAudit: a && !a.error ? { mismatches: a.mismatches, report: a.report } : a };
      }).catch((e) => ({ error: String(e?.message ?? e) }));
      log(`after hop: ${JSON.stringify(res.afterHop).slice(0, 1200)}`);
    }
    code = consoleErrors.length || pageErrors.length ? 3 : 0;
  } catch (e) {
    res.error = String(e?.stack ?? e);
    log("ERROR", String(e?.message ?? e).split("\n")[0]);
  } finally {
    res.consoleErrors = consoleErrors;
    res.pageErrors = pageErrors;
    res.rustWarnings = warnings;
    res.endedAt = new Date().toISOString();
    writeFileSync(join(outDir, "smoke.json"), JSON.stringify(res, null, 1));
    try { if (browser) await browser.close(); } catch (_) { /* gone */ }
    log(`console errors ${consoleErrors.length}, page errors ${pageErrors.length}, rust warnings ${warnings.length}; out ${outDir} (exit ${code})`);
  }
  return code;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });

// cloud-prebake-verify2.mjs — GTX 1070 headless. Measures the SYNCHRONOUS
// shader-link cost of the cloud NOISE programs, procedural vs prebaked.
//
// Why force synchronous: this headless chromium has KHR_parallel_shader_compile
// effective, so link is async and ~free — but the real 1070 desktop Chrome the
// user plays on has it ineffective (goal1: "KHR present, maxThreads=null") →
// link is SYNCHRONOUS and blocks (that's where the ~tens-of-seconds live). We
// disable KHR in the page so getProgramParameter(LINK_STATUS) blocks here too,
// reproducing the user's cold-load condition and making it measurable (the
// goal1 "queryMs" gold metric).
//
// The 4 noise-bake programs use the procedural fullscreen-quad vertex shader
// (`position.xy * 0.5 + 0.5`); we tag + sum their link time. In the prebaked
// arm those programs never compile → noiseMs ~0. The procedural arm's noiseMs
// is what prebake saves on the synchronous path.
//
//   node C:\Temp\cloud-prebake-verify2.mjs

import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const EXE = "C:\\Users\\<user>\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe";
const OUT = "C:\\Temp";
const APP = "http://127.0.0.1:18765/apps/holtburger-web/index.html";
const COMMON = {
  renderer: "3d", quality: "mid", clouds: "on",
  autoLogin: "1", account: "<test-account>", password: "<test-account>", autoSpawn: "first",
  renderDiag: "on", nosw: "1",
  server_host: "127.0.0.1", server_port: "9000", bridge_url: "ws://<server-ip>:8080/",
};
const ARMS = [
  { key: "procedural", extra: { cloudProcedural: "on" } },
  { key: "prebaked", extra: {} },
];

const LOGIN_POLL_MS = 200000;
const PRELOGIN_GAP_MS = 90000;
const CLOUD_WAIT_MS = 160000;    // synchronous link is slow; clouds appear after the stall
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

function initHook() {
  const NOISE_VTX = /position\.xy\s*\*\s*0\.5\s*\+\s*0\.5/;
  const LINK_STATUS = 0x8b82;
  const slog = { count: 0, totalLinkMs: 0, noiseCount: 0, noiseMs: 0, top: [] };
  window.__shaderLog = slog;
  for (const proto of [self.WebGL2RenderingContext, self.WebGLRenderingContext]) {
    if (!proto) continue;
    const P = proto.prototype;
    // Force synchronous link: hide KHR parallel-compile so three queries
    // LINK_STATUS immediately (blocks), like the real 1070 desktop config.
    const oExt = P.getExtension;
    P.getExtension = function (name) { if (name === "KHR_parallel_shader_compile") return null; return oExt.call(this, name); };
    const srcMap = new WeakMap();
    const progSrc = new WeakMap();
    const oSrc = P.shaderSource;
    P.shaderSource = function (sh, src) { try { srcMap.set(sh, src); } catch (e) {} return oSrc.call(this, sh, src); };
    const oAtt = P.attachShader;
    P.attachShader = function (pr, sh) { try { let a = progSrc.get(pr); if (!a) { a = []; progSrc.set(pr, a); } a.push(srcMap.get(sh) || ""); } catch (e) {} return oAtt.call(this, pr, sh); };
    const oLink = P.linkProgram;
    P.linkProgram = function (pr) {
      slog.count++;
      try { if ((progSrc.get(pr) || []).some(s => NOISE_VTX.test(s))) { slog.noiseCount++; slog.top.push({ link: 1, noise: true }); } } catch (e) {}
      return oLink.call(this, pr);
    };
    const oGP = P.getProgramParameter;
    P.getProgramParameter = function (pr, pname) {
      if (pname === LINK_STATUS) {
        const t0 = performance.now();
        const r = oGP.call(this, pr, pname);
        const dt = performance.now() - t0;
        const isNoise = (progSrc.get(pr) || []).some(s => NOISE_VTX.test(s));
        slog.totalLinkMs += dt;
        if (isNoise) { slog.noiseMs += dt; }
        slog.top.push({ ms: +dt.toFixed(0), noise: isNoise });
        return r;
      }
      return oGP.call(this, pr, pname);
    };
  }
}

const report = { ts: new Date().toISOString(), host: "GTX1070", note: "KHR parallel-compile DISABLED to force synchronous link (real-1070 condition)", arms: [] };

async function runArm(arm) {
  const url = `${APP}?${new URLSearchParams({ ...COMMON, ...arm.extra }).toString()}`;
  const out = { key: arm.key, url };
  log("=".repeat(70)); log(`ARM ${arm.key}`);
  log(`  pre-login gap ${PRELOGIN_GAP_MS / 1000}s ...`);
  await sleep(PRELOGIN_GAP_MS);
  const browser = await chromium.launch({
    headless: true, executablePath: EXE,
    args: ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--use-gl=angle", "--disable-dev-shm-usage"],
  });
  const cons = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    await ctx.addInitScript(initHook);
    const page = await ctx.newPage();
    page.on("console", m => { if (cons.length < 250) cons.push(`${m.type()}: ${m.text()}`.slice(0, 200)); });
    const tGoto = Date.now();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // gate in-world, reload once on early connect-error
    let t0 = Date.now(), inWorld = false, last = null, reloaded = false;
    while (Date.now() - t0 < LOGIN_POLL_MS) {
      const s = await page.evaluate(() => { const h = window.__sessionHandle; let cell = 0, pose = 0; try { cell = h?.getCurrentCellId?.() >>> 0; } catch (e) {} try { pose = h?.getLocalPlayerPose?.() ? 1 : 0; } catch (e) {} return { boot: window.__bootState || "none", cell, pose }; }).catch(() => ({ boot: "evalerr" }));
      if (s.boot !== last) { log(`  boot=${s.boot} cell=0x${(s.cell || 0).toString(16)}`); last = s.boot; }
      if (s.boot === "in-world" && s.pose && s.cell) { inWorld = true; out.spawnCell = "0x" + s.cell.toString(16); break; }
      if (!reloaded && s.boot === "error" && (Date.now() - t0) < 60000) { log("  early error → reload"); await sleep(25000); try { await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }); } catch (e) {} reloaded = true; last = null; t0 = Date.now(); continue; }
      await sleep(2500);
    }
    out.inWorld = inWorld;
    if (!inWorld) { out.fail = "no in-world"; out.consoleTail = cons.slice(-25); return out; }
    out.outdoorSpawn = (parseInt(out.spawnCell, 16) & 0xffff) < 0x100;

    // ensure outdoors so clouds compile (teleport if needed)
    if (!out.outdoorSpawn) {
      await page.evaluate(() => { try { window.__sessionHandle?.sendChat?.("@telepoi Holtburg"); } catch (e) {} });
      const tt = Date.now();
      while (Date.now() - tt < 70000) { const c = await page.evaluate(() => { try { return window.__sessionHandle?.getCurrentCellId?.() >>> 0; } catch (e) { return 0; } }).catch(() => 0); if (c && (c & 0xffff) < 0x100) break; await sleep(2000); }
    }

    // wait for clouds to actually render (frameCount advances past the synchronous compile)
    const tc = Date.now(); let firstFrameMs = null;
    while (Date.now() - tc < CLOUD_WAIT_MS) {
      const st = await page.evaluate(() => { const co = window.liveScene3d?.cloudOverlay; return co ? { fc: co.frameCount, pre: co._prebakedLoaded, proc: co._proceduralTextures } : { fc: -1 }; }).catch(() => ({ fc: -1 }));
      if (st.fc > 0 && firstFrameMs == null) firstFrameMs = Date.now() - tc;
      if (st.fc >= 10) break;
      await sleep(1000);
    }
    out.timeToFirstCloudFrameMs = firstFrameMs;
    out.timeInWorldToCloudSec = +((Date.now() - tGoto) / 1000).toFixed(1);
    await sleep(3000);

    out.shaderLog = await page.evaluate(() => { const s = window.__shaderLog; return { count: s.count, totalLinkMs: +s.totalLinkMs.toFixed(0), noiseCount: s.noiseCount, noiseMs: +s.noiseMs.toFixed(0), noiseProgs: s.top.filter(p => p.noise).map(p => p.ms) }; });
    out.cloudInfo = await page.evaluate(() => { const co = window.liveScene3d?.cloudOverlay; if (!co) return { present: false }; const eff = co.volume?.effect; return { present: true, frameCount: co.frameCount, lastError: co.lastError || null, prebakedLoaded: co._prebakedLoaded, procedural: co._proceduralTextures, hasShape: !!eff?.shapeTexture, hasShapeDetail: !!eff?.shapeDetailTexture, hasWeather: !!eff?.localWeatherTexture, hasTurb: !!eff?.turbulenceTexture }; });
    log(`  shaderLog: total ${out.shaderLog.count} progs / ${out.shaderLog.totalLinkMs}ms link | NOISE ${out.shaderLog.noiseCount} progs / ${out.shaderLog.noiseMs}ms [${out.shaderLog.noiseProgs.join(",")}]`);
    log(`  cloudInfo: ${JSON.stringify(out.cloudInfo)}`);

    try { await page.screenshot({ path: `${OUT}\\cloud-prebake3-${arm.key}.png` }); log(`  saved cloud-prebake3-${arm.key}.png`); } catch (e) {}
    out.consoleTail = cons.filter(c => /clouds|prebake|noise|fail|error/i.test(c)).slice(-12);
  } catch (e) {
    out.fatal = String(e?.message || e); log(`  FATAL ${out.fatal}`);
  } finally {
    try { await browser.close(); } catch (_) {}
  }
  return out;
}

async function main() {
  log("cloud prebake SYNCHRONOUS-link verify — GTX 1070 (KHR disabled)");
  for (const arm of ARMS) { report.arms.push(await runArm(arm)); writeFileSync(`${OUT}\\cloud-prebake3-report.json`, JSON.stringify(report, null, 2)); }
  log("=".repeat(74));
  log("CLOUD NOISE-PROGRAM SYNCHRONOUS LINK COST (KHR disabled = real-1070 cond.)");
  for (const a of report.arms) {
    if (!a.shaderLog) { log(`  ${a.key}: ${a.fail || a.fatal || "no data"}`); continue; }
    log(`  ${a.key.padEnd(11)} noise ${a.shaderLog.noiseCount} progs / ${String(a.shaderLog.noiseMs).padStart(6)}ms   total ${a.shaderLog.count} progs / ${a.shaderLog.totalLinkMs}ms   firstFrame ${a.timeToFirstCloudFrameMs}ms   ${a.cloudInfo?.prebakedLoaded ? "PREBAKED" : a.cloudInfo?.procedural ? "PROCEDURAL" : "?"}`);
  }
  const pro = report.arms.find(a => a.key === "procedural")?.shaderLog;
  const pre = report.arms.find(a => a.key === "prebaked")?.shaderLog;
  if (pro && pre) { log("-- prebake saving (synchronous link) --"); log(`  noise link removed: ${pro.noiseMs}ms (${pro.noiseCount} progs) → ${pre.noiseMs}ms (${pre.noiseCount} progs)`); }
  writeFileSync(`${OUT}\\cloud-prebake3-report.json`, JSON.stringify(report, null, 2));
  log("DONE");
}
main().catch(e => { log("TOP FATAL", e?.stack?.slice(0, 400) || e); try { writeFileSync(`${OUT}\\cloud-prebake3-report.json`, JSON.stringify(report, null, 2)); } catch (_) {} }).finally(() => process.exit(0));

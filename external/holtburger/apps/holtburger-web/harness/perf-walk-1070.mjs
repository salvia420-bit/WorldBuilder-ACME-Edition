// harness/perf-walk-1070.mjs — all-flags-on perf walk on the REAL GTX 1070.
//
// Drives the 1070's persistent Playwright-Firefox driver over its HTTP /eval API
// (http://127.0.0.1:9224, reached via the standing -L forward). The app is the
// LAPTOP's all-on build, served to the 1070 via the -R reverse tunnel
// (127.0.0.1:18765 -> laptop serve.py); bridge over tailscale.
//
// Real 1070 GPU render → meaningful FPS/GPU vs the laptop's software SwiftShader.
// Off-screen: the FF driver window is hidden (1070 "never on screen" rule). On
// exit it navigates the FF to about:blank to stop rendering + free the GPU.
//
//   node harness/perf-walk-1070.mjs [--seconds=300]
//
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

const arg = (k, d) => { const h = process.argv.find(a => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : d; };
const DURATION_S = Number(arg("seconds", "300"));
const SAMPLE_MS = 5000;
const DRIVER = "http://127.0.0.1:9224";
const HOST_1070 = "young@100.127.215.75";
const APP = "http://127.0.0.1:18765/apps/holtburger-web/index.html"; // via -R tunnel
const SCRATCH = (() => { for (const d of ["/mnt/wbterminal1/tmp/claude-scratch", "/tmp/claude-scratch"]) { try { mkdirSync(d, { recursive: true }); return d; } catch {} } return "/tmp"; })();

const FLAGS = process.env.PERF_FLAGS ? process.env.PERF_FLAGS.split(",").map(s => s.trim()).filter(Boolean) : [
  "renderer=3d", "autoLogin=1", "account=tailnet1", "password=tailnet1", "autoSpawn=first", "kickDance=1",
  "server_host=127.0.0.1", "server_port=9000", "bridge_url=ws://100.116.47.66:8080/",
  "renderDiag=on", "syncTickDiag=1",
  "unifiedTick=on", "posePublishPostTick=on", "syncPhysicsTick=on", "wireStatePacks=stage1",
  "worldLifecycle=on", "maintPrune=on", "unifiedTransition=on", "remoteInterp=on", "stickyRetail=on",
  "inputFunnel=on", "wasmPursuit=on", "jumpParity=on", "retailRunKeys=on",
  "hookDrain=on", "mtQueue=on", "rootMotionObject=1", "getLink=on",
  "surfaceUnified=on", "surfaceParityV2=on", "placementId=on",
  "blockingParticleParity=on", "scriptQueue=on", "particleOwner=on", "defaultScriptSpawn=on", "particleDegrade=retail",
  "retailCamZoom=on", "camStiffness=0.5", "mouseSmooth=0.5", "preCreateBuffer=on", "entityLights=on",
];
const URL = APP + "?" + FLAGS.join("&");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pctile = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };

async function gotoFF(url) {
  const r = await fetch(`${DRIVER}/goto?` + new URLSearchParams({ url }), { signal: AbortSignal.timeout(45000) });
  return r.json();
}
// fn is an arrow-function source string; driver evals + calls it, returns {ok,result}.
async function ff(fn, timeoutMs = 20000) {
  const b64 = Buffer.from(fn).toString("base64");
  const r = await fetch(`${DRIVER}/eval?fn=${encodeURIComponent(b64)}`, { signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json();
  if (!j.ok) throw new Error("ff: " + String(j.error || "").slice(0, 140));
  return j.result;
}
function gpu1070() {
  const r = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", HOST_1070,
    "nvidia-smi --query-gpu=utilization.gpu,memory.used,temperature.gpu,power.draw --format=csv,noheader,nounits"],
    { encoding: "utf8", timeout: 14000 });
  const line = (r.stdout || "").trim().split("\n")[0] || "";
  const [util, mem, temp, pw] = line.split(",").map(s => parseFloat(s));
  return { util: util ?? null, memMB: mem ?? null, tempC: temp ?? null, watts: pw ?? null };
}

async function main() {
  console.log(`[1070] all-flags-on perf walk, ${DURATION_S}s, REAL GTX 1070. scratch=${SCRATCH}`);
  // Clear the FF first (drop any prior tailnet1 session) + wait out ACE's
  // ~25s single-session grace so the next login can claim the slot cleanly
  // (kickDance alone is flaky over this path).
  console.log("[1070] about:blank + 35s grace for ACE to free tailnet1…");
  await gotoFF("about:blank").catch(() => {});
  await sleep(35000);

  let inWorld = false, renderer = null;
  for (let attempt = 0; attempt < 2 && !inWorld; attempt++) {
    console.log(`[1070] /goto login attempt ${attempt + 1}…`);
    const g = await gotoFF(URL);
    if (!g.ok) { console.log("[1070] goto err:", String(g.error || "").slice(0, 160)); continue; }
    const tB = Date.now();
    while (Date.now() - tB < 75000) {
      const s = await ff(`()=>{const h=window.__sessionHandle;let pose=null;try{pose=h&&h.getLocalPlayerPose?h.getLocalPlayerPose():null}catch(e){}return {boot:window.__bootState||'none',hasPose:pose!=null}}`).catch(e => ({ err: String(e.message) }));
      if (s && s.boot === "in-world" && s.hasPose) { inWorld = true; break; }
      await sleep(2500);
    }
    if (!inWorld) console.log(`[1070] attempt ${attempt + 1} did not reach in-world; ${attempt === 0 ? "re-goto" : "giving up"}.`);
  }
  // WebGL renderer (confirm the 1070 GPU, not software).
  renderer = await ff(`()=>{try{const c=document.createElement('canvas');const gl=c.getContext('webgl2')||c.getContext('webgl');if(!gl)return 'no-gl';const d=gl.getExtension('WEBGL_debug_renderer_info');return d?String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL)):'no-debug-ext'}catch(e){return 'err:'+e.message}}`).catch(e => "err:" + e.message);
  console.log(`[1070] inWorld=${inWorld}  renderer="${renderer}"`);

  // Install rAF frame-time probe.
  await ff(`()=>{window.__perf={frames:[],last:null};const l=()=>{const n=performance.now();if(window.__perf.last!=null)window.__perf.frames.push(n-window.__perf.last);window.__perf.last=n;requestAnimationFrame(l)};requestAnimationFrame(l);return true}`).catch(() => {});
  const KEY = (type, key, code, kc) => `()=>{for(const t of [document,window])t.dispatchEvent(new KeyboardEvent('${type}',{key:'${key}',code:'${code}',keyCode:${kc},which:${kc},bubbles:true,cancelable:true}));return true}`;
  if (inWorld) await ff(KEY("keydown", "w", "KeyW", 87)).catch(() => {});

  const samples = [];
  const t0 = Date.now(), tEnd = t0 + DURATION_S * 1000;
  let i = 0, startPose = null;
  while (Date.now() < tEnd) {
    const loopStart = Date.now();
    if (inWorld) {
      try {
        if (i % 3 === 1) { await ff(KEY("keydown", "a", "KeyA", 65)); await sleep(600); await ff(KEY("keyup", "a", "KeyA", 65)); }
        else if (i % 3 === 2) { await ff(KEY("keydown", "d", "KeyD", 68)); await sleep(600); await ff(KEY("keyup", "d", "KeyD", 68)); }
        if (i % 6 === 4) { await ff(KEY("keydown", " ", "Space", 32)); await ff(KEY("keyup", " ", "Space", 32)); }
        if (i % 8 === 7) { await ff(KEY("keyup", "w", "KeyW", 87)); await sleep(1000); await ff(KEY("keydown", "w", "KeyW", 87)); }
      } catch {}
    }
    const s = await ff(`()=>{const h=window.__sessionHandle;let pose=null;try{pose=h&&h.getLocalPlayerPose?h.getLocalPlayerPose():null}catch(e){}return {diag:window.__diag&&window.__diag.render?Object.assign({},window.__diag.render):null,sync:window.__syncTickDiag?Object.assign({},window.__syncTickDiag):null,heapMB:(performance.memory?+(performance.memory.usedJSHeapSize/1048576).toFixed(1):null),frames:(window.__perf?window.__perf.frames.length:0),boot:window.__bootState||null,pose:pose?{x:+(pose.x||0).toFixed(1),y:+(pose.y||0).toFixed(1),z:+(pose.z||0).toFixed(1)}:null}}`).catch(e => ({ evalErr: String(e.message).slice(0, 80) }));
    s.gpu = gpu1070();
    s.elapsed = Math.round((Date.now() - t0) / 1000);
    if (s.pose && !startPose) startPose = s.pose;
    samples.push(s);
    if (i % 2 === 0) console.log(`  t=${s.elapsed}s frames=${s.frames} draws=${s.diag?.calls ?? "-"} nodes=${s.diag?.sceneNodes ?? "-"} progs=${s.diag?.programs ?? "-"} heap=${s.heapMB ?? "-"}MB gpu=${s.gpu.util ?? "-"}% gmem=${s.gpu.memMB ?? "-"} pose=${s.pose ? `${s.pose.x},${s.pose.y}` : "-"}`);
    const spent = Date.now() - loopStart;
    if (spent < SAMPLE_MS) await sleep(SAMPLE_MS - spent);
    i++;
  }
  if (inWorld) await ff(KEY("keyup", "w", "KeyW", 87)).catch(() => {});

  const frames = await ff(`()=>window.__perf?window.__perf.frames:[]`, 20000).catch(() => []);
  const endPose = samples.filter(s => s.pose).slice(-1)[0]?.pose || null;
  const moved = startPose && endPose ? +Math.hypot(endPose.x - startPose.x, endPose.y - startPose.y).toFixed(1) : 0;

  const dts = frames.filter(d => d > 0 && d < 8000);
  const fps = dts.length ? 1000 / (dts.reduce((a, b) => a + b, 0) / dts.length) : null;
  const col = k => samples.map(s => s.diag?.[k]).filter(v => typeof v === "number");
  const rng = a => a.length ? { min: Math.min(...a), max: Math.max(...a), avg: Math.round(a.reduce((x, y) => x + y, 0) / a.length) } : null;
  const gcol = k => samples.map(s => s.gpu?.[k]).filter(v => typeof v === "number");
  const heaps = samples.map(s => s.heapMB).filter(v => typeof v === "number");
  const lastSync = [...samples].reverse().find(s => s.sync)?.sync || null;
  const errs = samples.filter(s => s.evalErr).length;

  const report = {
    ts: new Date().toISOString(), host: "GTX1070", durationS: DURATION_S, url: URL, inWorld, renderer,
    movedMeters: moved, startPose, endPose,
    fps: fps ? +fps.toFixed(1) : null,
    frameMs: { p50: pctile(dts, 50), p95: pctile(dts, 95), p99: pctile(dts, 99), worst: dts.length ? Math.max(...dts) : null },
    spikes: { gt33ms: dts.filter(d => d > 33).length, gt100ms: dts.filter(d => d > 100).length, gt500ms: dts.filter(d => d > 500).length, totalFrames: dts.length },
    drawCalls: rng(col("calls")), triangles: rng(col("triangles")), programs: rng(col("programs")),
    sceneNodes: rng(col("sceneNodes")), meshNodes: rng(col("meshNodes")),
    gpuUtilPct: rng(gcol("util")), gpuMemMB: rng(gcol("memMB")), gpuTempC: rng(gcol("tempC")), gpuWatts: rng(gcol("watts")),
    jsHeapMB: heaps.length ? { start: heaps[0], peak: Math.max(...heaps), end: heaps[heaps.length - 1] } : null,
    syncPhysicsTick: lastSync, evalErrors: errs, samples,
  };
  const out = `${SCRATCH}/perf-walk-1070-${DURATION_S}s.json`;
  writeFileSync(out, JSON.stringify(report, null, 2));

  console.log("\n" + "=".repeat(70));
  console.log("  ALL-FLAGS-ON PERF WALK — GTX 1070 (real GPU)");
  console.log("=".repeat(70));
  console.log(`  in-world        : ${inWorld}   renderer: ${renderer}`);
  console.log(`  moved           : ${moved} m  (start ${JSON.stringify(startPose)} -> end ${JSON.stringify(endPose)})`);
  console.log(`  FPS             : ${report.fps}   frame ms p50=${report.frameMs.p50} p95=${report.frameMs.p95} p99=${report.frameMs.p99} worst=${report.frameMs.worst}`);
  console.log(`  spikes          : >33ms=${report.spikes.gt33ms} >100ms=${report.spikes.gt100ms} >500ms=${report.spikes.gt500ms} (of ${dts.length})`);
  console.log(`  draw calls      : ${JSON.stringify(report.drawCalls)}`);
  console.log(`  scene/mesh nodes: ${JSON.stringify(report.sceneNodes)} / ${JSON.stringify(report.meshNodes)}`);
  console.log(`  programs        : ${JSON.stringify(report.programs)}`);
  console.log(`  GPU util %      : ${JSON.stringify(report.gpuUtilPct)}`);
  console.log(`  GPU mem MB      : ${JSON.stringify(report.gpuMemMB)}   temp ${JSON.stringify(report.gpuTempC)}C  watts ${JSON.stringify(report.gpuWatts)}`);
  console.log(`  JS heap MB      : ${JSON.stringify(report.jsHeapMB)}`);
  console.log(`  syncPhysicsTick : ${JSON.stringify(lastSync)}`);
  console.log(`  eval errors     : ${errs}`);
  console.log(`  full JSON -> ${out}`);
  console.log("=".repeat(70));
}

main()
  .catch(e => { console.error("[1070] fatal:", e && e.stack ? e.stack : e); })
  .finally(async () => {
    // Per the off-screen rule + cleanup: clear the FF off the test page (stops the
    // heavy scene + frees the GPU). Does NOT kill the shared driver process.
    try { await gotoFF("about:blank"); console.log("[1070] FF navigated to about:blank (test page closed)."); } catch (e) { console.log("[1070] about:blank failed:", String(e.message)); }
    process.exit(0);
  });

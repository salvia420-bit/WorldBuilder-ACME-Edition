// s1.eval.js - round-3 session S1 page driver (queue apps/holtburger-web/docs/reengineering/queue-1070/
// batch-R3-S1-2026-10-30.json). Lane Q wrote it inside the queue (`evalScripts`); lane Q2 (2026-10-30) promoted it
// here and fixed: GL upload reads per window (arrive / turn / content), the ctxloss flow (lose, await the lost
// event + a frame, restore, await the restored event), the landing check against the retail ground height, the
// bakeFallbackWaves read (maxIds is the largest REQUEST, not a wave), the rigPoseSkip skip rate over the run, and
// the laptop-tab guard. tests/s1_queue.test.mjs runs every mode against fakes.
//
// The BODY of an async fn: hbanatomy.mjs --eval wraps it (wrapEval) and injects --opts as window.__hbEvalOpts.
// Measurement only: it never sets a URL flag, and every GL method it wraps (countUploads) is put back before it
// returns. The ctxloss mode loses and restores the WebGL context on purpose (S1-CTX only).
// Modes (opts.mode):
//   route   a 360 deg player turn where bootArm parked (turn0; NOT hbbench's cold first turn), then opts.hops:
//           @teleloc, wait for the landing and the end of the portal tunnel (arrive window), a 360 deg turn with
//           hbbench's first-turn camera (turn window), then time to content (LRU size | geometries unchanged for
//           contentQuietMs; content window). Frame stats per window (hb_v2 frameStats definitions), the longest
//           long-animation-frame and its top scripts, GL upload bytes per window (countUploads), a diag dump and
//           the landing check per hop (|stand z - groundZ| <= landTolM).
//   indoor  eye fixed at the player (+eyeDz); a 12-heading sweep that reads the landscape-skip share per heading
//           from __indoorLandscapeGateDiag().skippedFrames (present in both arms), then a still window at the
//           most-skipped heading ("still-wall"), one at the least-skipped ("still-door") and a yaw sweep
//           ("moving"). performance.mark hbS1:<window> ... hbS1:gap around each window, for
//           `hbreport.py trace-split <trace> --marks hbS1:` (main busy / CrGpuMain per window).
//   diag    a diag dump at the start and after holdMs.
//   ctxloss WEBGL_lose_context (handle taken while the context is alive): loseContext(); await the
//           'webglcontextlost' event; await one frame ("fast"; "slow": restoreDelayMs, then a frame) so the
//           restore runs in a later task than the event's dispatch (Chrome allows restoreContext() only after
//           the lost event was dispatched with its default prevented); restoreContext(); await
//           'webglcontextrestored'; then watchMs of per-frame anim-scenery batch status. Checks: the K2 diag
//           (batch.contextResets up, kit.pages.generation bumped, no legacy bucket held hidden while no batch is
//           active = legacy on screen meanwhile, the batch active again), GL errors drained before the restore
//           (CONTEXT_LOST_WEBGL expected), right after it (INVALID_OPERATION = refused) and at the end (none).
//   helpers returns the pure helpers below and touches nothing (tests/s1_queue.test.mjs).
// Every mode but helpers: with opts.laptopCheck the script refuses, before touching the page, any tab that is not
// the orchestrator's laptop check tab (a Windows user agent = the 1070 box; no ?wireframe=1 = not SwiftShader).
// route / indoor need window.__cam (boot with ?camDebug=on).
const O = Object.assign({
  mode: "diag", hops: [], turnMs: 12000, telelocWaitMs: 30000, contentQuietMs: 6000, contentMaxMs: 60000, landTolM: 1.0,
  countUploads: false, verifyRigPoseSkip: false, pollBatch: false, holdMs: 0, laptopCheck: false,
  eyeDz: 1.6, headingMs: 1500, stillMs: 20000, doorMs: 10000, moveMs: 20000, moveDegPerSec: 18,
  ctx: "fast", restoreDelayMs: 500, watchMs: 20000, eventWaitMs: 10000, activeAgainMaxMs: 2000,
}, (typeof window !== "undefined" && window.__hbEvalOpts) || {});

// ---- pure helpers (mode "helpers" returns them) ----------------------------------------------------------
// hb_v2.mjs frameStats, verbatim definitions (so a route window reads like an hbbench segment)
function fstats(d) {
  if (!d || !d.length) return null;
  const s = [...d].sort((a, b) => a - b), n = s.length, sum = d.reduce((a, b) => a + b, 0);
  const q = (p) => +s[Math.min(n - 1, Math.floor(p * n))].toFixed(1);
  const lowOf = (f) => { const w = s.slice(Math.floor(n * (1 - f))); return +(1000 / (w.reduce((a, b) => a + b, 0) / w.length)).toFixed(1); };
  return { n, fps: +(n / (sum / 1000)).toFixed(1), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +s[n - 1].toFixed(0), low1: lowOf(0.01), low01: lowOf(0.001),
    h50: d.filter((x) => x > 50).length, h100: d.filter((x) => x > 100).length, h250: d.filter((x) => x > 250).length,
    jankMs: Math.round(d.filter((x) => x > 50).reduce((a, x) => a + x - 33.3, 0)) };
}
function loafSummary(list, supported) {
  if (!supported) return { supported: false };
  let top = null, blocking = 0;
  for (const e of list) { blocking += e.blockingDuration || 0; if (!top || e.duration > top.duration) top = e; }
  const scripts = top && top.scripts ? [...top.scripts].sort((a, b) => b.duration - a.duration).slice(0, 3).map((s) => ({
    ms: Math.round(s.duration), fn: s.sourceFunctionName || "", src: String(s.sourceURL || "").split("/").slice(-2).join("/"),
    invoker: String(s.invoker || "").slice(0, 80), type: s.invokerType || "" })) : [];
  return { supported: true, n: list.length, maxMs: top ? Math.round(top.duration) : 0, maxBlockingMs: top ? Math.round(top.blockingDuration || 0) : 0,
    blockingMs: Math.round(blocking), topScripts: scripts };
}
// Bytes one GL upload call moves: ArrayBufferView arguments (srcOffset/length honoured for buffers), image
// sources width x height x 4, copies width x height x 4; a size-only bufferData counts its size.
const UPLOAD_METHODS = ["bufferData", "bufferSubData", "texImage2D", "texSubImage2D", "texImage3D", "texSubImage3D", "compressedTexImage2D",
  "compressedTexSubImage2D", "compressedTexImage3D", "compressedTexSubImage3D", "copyTexSubImage2D", "copyTexSubImage3D"];
function uploadBytes(n, a) {
  const isView = (v) => ArrayBuffer.isView(v);
  const viewBytes = (v, off, len) => { const bpe = v.BYTES_PER_ELEMENT || 1; if (typeof len === "number" && len > 0) return len * bpe; if (typeof off === "number" && off > 0) return Math.max(0, v.byteLength - off * bpe); return v.byteLength; };
  if (n === "bufferData") return typeof a[1] === "number" ? a[1] : isView(a[1]) ? viewBytes(a[1], a[3], a[4]) : (a[1] && a[1].byteLength) || 0;
  if (n === "bufferSubData") return isView(a[2]) ? viewBytes(a[2], a[3], a[4]) : (a[2] && a[2].byteLength) || 0;
  if (n === "copyTexSubImage2D") return (a[6] | 0) * (a[7] | 0) * 4;
  if (n === "copyTexSubImage3D") return (a[7] | 0) * (a[8] | 0) * 4;
  for (const v of a) {
    if (isView(v)) return v.byteLength;
    if (v && typeof v === "object" && typeof v.width === "number" && typeof v.height === "number") return v.width * v.height * 4;
  }
  return 0;
}
/** Buffer bytes (bufferData + bufferSubData) of one upload read; null without a read. */
function bufferBytes(u) { return u && u.bytes ? (u.bytes.bufferData || 0) + (u.bytes.bufferSubData || 0) : null; }
/** Sum of upload reads ({calls, bytes, totalBytes}); null when none is a read. */
function sumUploads(list) {
  const rs = (list || []).filter((u) => u && u.bytes);
  if (!rs.length) return null;
  const out = { calls: {}, bytes: {}, totalBytes: 0 };
  for (const u of rs) {
    for (const [k, v] of Object.entries(u.calls || {})) out.calls[k] = (out.calls[k] || 0) + v;
    for (const [k, v] of Object.entries(u.bytes)) out.bytes[k] = (out.bytes[k] || 0) + v;
    out.totalBytes += u.totalBytes || 0;
  }
  return out;
}
/**
 * The landing check of one hop (one rule, hopRoutes.west4.landing): the player stands on the retail terrain under
 * the stop, |stand z - groundZ| <= tolM (not under it, not on a roof). dropM = requested z - stand z (the fall).
 */
function landing(h, standZ, tolM) {
  const dropM = typeof h.z === "number" && typeof standZ === "number" ? +(h.z - standZ).toFixed(2) : null;
  if (typeof h.groundZ !== "number") return { dropM, groundZ: null, landErrM: null, ok: false, problem: "no groundZ in the hop: the landing cannot be checked" };
  if (typeof standZ !== "number") return { dropM, groundZ: h.groundZ, landErrM: null, ok: false, problem: "no stand pose" };
  const landErrM = +(standZ - h.groundZ).toFixed(2);
  const ok = Math.abs(landErrM) <= tolM;
  return { dropM, groundZ: h.groundZ, landErrM, ok, problem: ok ? null : `stands ${landErrM} m from the ground (${h.groundZ}), beyond +-${tolM} m` };
}
/**
 * `?bakeFallbackWaves` stats() read (scene3d/bake_worker_client.js _noteFallbackWaves / fallbackWaveStats).
 * calls / split / waves / maxIds are noted when a request STARTS; yields when a later wave starts. maxIds is the
 * largest REQUEST (tests/bake_fallback_waves.test.mjs W14: one 64-id request in 4 waves gives maxIds 64), so a
 * split needs maxIds > cap. The per-wave id bound (cap; max(cap, longest group) for the entity batch) is not in
 * stats(): it holds by construction (splitBatchWaves / splitEntityBatchGroupWaves, W3/W5); on the 1070 the bound
 * that matters is time (the hop LoAF max). `seq` = __bakeWorkerSeq() (<= 1: the worker never served).
 * -> { mode: "off" | "fallback" | "worker", problems[] }
 */
function fallbackWavesCheck(s, seq) {
  if (s === null || s === undefined) return { mode: "off", problems: [] };
  const p = [];
  for (const k of ["cap", "calls", "split", "waves", "yields", "maxIds"]) if (!Number.isFinite(s[k])) p.push(`stats().${k} missing`);
  if (p.length) return { mode: "fallback", problems: p };
  if (Number.isFinite(seq) && seq > 1) {
    // the control arm (worker on): inert while the worker serves
    if (s.calls !== 0) p.push(`worker served (seq ${seq}) yet ${s.calls} main-thread request(s) ran armed (a crash window or a worker error reply)`);
    return { mode: "worker", problems: p };
  }
  if (!(s.cap >= 2)) p.push(`cap ${s.cap} < 2: not armed`);
  if (!(s.calls > 0)) p.push("calls 0: no main-thread request ran armed");
  if (!(s.split > 0)) p.push("split 0: no request was longer than one wave");
  if (s.waves < s.calls + s.split) p.push(`waves ${s.waves} < calls ${s.calls} + split ${s.split} (a split request runs >= 2 waves)`);
  if (s.split > 0 && !(s.maxIds > s.cap)) p.push(`split ${s.split} with maxIds ${s.maxIds} <= cap ${s.cap} (only a request longer than the cap splits)`);
  if (s.split > 0 && !(s.yields > 0)) p.push("yields 0: no later wave ran in its own task");
  if (s.yields > s.waves - s.calls) p.push(`yields ${s.yields} > waves - calls = ${s.waves - s.calls}`);
  for (const [t, b] of Object.entries(s.byType || {})) {
    if (!b || !(b.calls > 0)) continue;
    if (b.waves < b.calls + b.split) p.push(`${t}: waves ${b.waves} < calls ${b.calls} + split ${b.split}`);
    // flat legs cut at the cap: the largest request alone runs ceil(maxIds / cap) waves, every other one >= 1
    if (t !== "fetchEntitySurfacesPixelsBatch") {
      const need = b.calls - 1 + Math.max(1, Math.ceil(b.maxIds / s.cap));
      if (b.waves < need) p.push(`${t}: waves ${b.waves} < calls - 1 + ceil(maxIds ${b.maxIds} / cap ${s.cap}) = ${need} (its largest request was not cut at the cap)`);
    }
  }
  return { mode: "fallback", problems: p };
}
/** rigPoseSkip skip rate between two stats() reads (start / end of a run); null without both. */
function skipRate(a, b) {
  const ok = (x) => x && typeof x === "object" && Number.isFinite(x.posed) && Number.isFinite(x.skipped);
  if (!ok(a) || !ok(b)) return null;
  const d = (k) => (Number.isFinite(b[k]) && Number.isFinite(a[k]) ? b[k] - a[k] : null);
  const posed = d("posed"), skipped = d("skipped");
  return { posed, skipped, probed: d("probed"), routeChanged: d("routeChanged"), verified: d("verified"), violations: d("violations"),
    rate: posed + skipped > 0 ? +(skipped / (posed + skipped)).toFixed(3) : null, enabled: b.enabled === true, verify: b.verify === true };
}
/** The laptop-check guard: null = a laptop SwiftShader check tab; else why the script refuses to touch it. */
function laptopRefusal(ua, search) {
  if (/Windows/i.test(String(ua || ""))) return "laptopCheck: this tab runs on Windows (the 1070 box, not the laptop): refused, nothing touched";
  if (!/[?&]wireframe=1(&|#|$)/.test(String(search || ""))) return "laptopCheck: the tab was not booted with ?wireframe=1 (the laptop SwiftShader check tab): refused, nothing touched";
  return null;
}
/** gl.getError() until NO_ERROR (at most max reads). */
function drainErrors(gl, max = 16) {
  const out = [];
  for (let i = 0; i < max; i++) { let e = 0; try { e = gl.getError(); } catch (_) { break; } if (!e) break; out.push(e); }
  return out;
}
const GL_INVALID_OPERATION = 0x0502, GL_CONTEXT_LOST_WEBGL = 0x9242;
/** The S1-CTX pass conditions over a ctxloss result -> problems[] (requireBatch false: laptop tab, no batch needed). */
function ctxlossProblems(r, { requireBatch = true, activeAgainMaxMs = 2000 } = {}) {
  const p = [];
  const ev = r.events || {};
  if (ev.lostMs === null || ev.lostMs === undefined) p.push("no webglcontextlost event");
  if (r.lostBeforeRestore !== true) p.push("the context was not lost when restoreContext() was called");
  if ((r.restoreErrors || []).includes(GL_INVALID_OPERATION)) p.push("restoreContext() refused (INVALID_OPERATION): called before the lost event was dispatched and prevented");
  else if ((r.restoreErrors || []).length) p.push(`GL errors right after restoreContext(): ${r.restoreErrors.join(",")}`);
  if (ev.restoredMs === null || ev.restoredMs === undefined) p.push("no webglcontextrestored event");
  if (r.contextLostAtEnd !== false) p.push(`context lost at the end (${JSON.stringify(r.contextLostAtEnd)})`);
  if (!Array.isArray(r.glErrorsAtEnd) || r.glErrorsAtEnd.length) p.push(`GL errors at the end: ${JSON.stringify(r.glErrorsAtEnd)}`);
  if (!requireBatch && !(r.activeBefore > 0)) return p;
  if (!(r.activeBefore > 0)) { p.push("no active anim-scenery batch before the loss"); return p; }
  const cr = r.contextResets || {}, g = r.generation || {};
  if (!(Number.isFinite(cr.after) && cr.after > 0 && cr.after > (cr.before || 0))) p.push(`batch.contextResets did not rise (${cr.before} -> ${cr.after})`);
  if (!(Number.isFinite(g.after) && Number.isFinite(g.before) && g.after > g.before)) p.push(`kit.pages.generation not bumped (${g.before} -> ${g.after})`);
  if (!(r.legacyHeldFrames === 0)) p.push(`${r.legacyHeldFrames} sampled frame(s) with no active batch but legacy buckets still taken (legacy not on screen)`);
  const again = Number.isFinite(r.activeAgainMsAfterResume) ? r.activeAgainMsAfterResume : r.activeAgainMsAfterRestore;
  if (!Number.isFinite(again)) p.push("the batch never became active again");
  else if (again > activeAgainMaxMs) p.push(`batch active again ${again} ms after the app resumed (> ${activeAgainMaxMs} ms [D])`);
  if (r.legacyReasons && r.legacyReasons["never-drawn"] > 0) p.push(`legacyReasons never-drawn ${r.legacyReasons["never-drawn"]}`);
  return p;
}
const HELPERS = { fstats, loafSummary, uploadBytes, bufferBytes, sumUploads, landing, fallbackWavesCheck, skipRate, laptopRefusal, drainErrors, ctxlossProblems,
  UPLOAD_METHODS, GL_INVALID_OPERATION, GL_CONTEXT_LOST_WEBGL };
if (O.mode === "helpers") return HELPERS;

// ---- page side ---------------------------------------------------------------------------------------------
if (O.laptopCheck) {
  const why = laptopRefusal(typeof navigator !== "undefined" ? navigator.userAgent : "", typeof location !== "undefined" ? location.search : "");
  if (why) return { mode: O.mode, refused: why, problems: [why], opts: O };
}
const W = window;
const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raf = () => new Promise((r) => requestAnimationFrame(r));
const call = (f) => { try { return f(); } catch (e) { return { error: String((e && e.message) || e).slice(0, 200) }; } };
const plain = (v) => { try { return v == null ? null : JSON.parse(JSON.stringify(v)); } catch (_) { return null; } };
const mark = (n) => { try { performance.mark("hbS1:" + n); } catch (_) { /* no user timing */ } };
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => false)]);
const problems = [];
const camOk = () => !!(W.__cam && typeof W.__cam.world === "function");

// rAF intervals + long animation frames over one window
function recorder() {
  const d = []; let last = null, on = true;
  const f = (t) => { if (!on) return; if (last !== null) d.push(t - last); last = t; requestAnimationFrame(f); };
  requestAnimationFrame(f);
  const lo = []; let po = null;
  try { po = new PerformanceObserver((l) => { for (const e of l.getEntries()) lo.push(e); }); po.observe({ type: "long-animation-frame" }); } catch (_) { po = null; }
  return {
    frames: d,
    stop() {
      on = false;
      try { if (po) { for (const e of po.takeRecords()) lo.push(e); po.disconnect(); } } catch (_) { /* gone */ }
      return { frames: fstats(d), loaf: loafSummary(lo, po !== null) };
    },
  };
}
const batchDiag = () => { if (typeof W.__animSceneryDiag !== "function") return null; const d = W.__animSceneryDiag(); return d && d.batch ? d.batch : null; };
const diag = () => ({
  at: Math.round(now()),
  rigPoseSkip: W.__rigPoseSkip ? call(() => W.__rigPoseSkip.stats()) : null,
  skipEmptyPasses: W.__skipEmptyPasses ? call(() => W.__skipEmptyPasses.stats()) : null,
  indoorGate: typeof W.__indoorLandscapeGateDiag === "function" ? call(() => W.__indoorLandscapeGateDiag()) : null,
  uploadWarmDraw: W.__uploadWarmDraw ? call(() => W.__uploadWarmDraw.stats()) : null,
  animSceneryBatch: call(() => plain(batchDiag())),
  bakeFallbackWaves: W.__bakeFallbackWaves ? call(() => W.__bakeFallbackWaves.stats()) : null,
  bakeWorkerSeq: typeof W.__bakeWorkerSeq === "function" ? call(() => W.__bakeWorkerSeq()) : null,
  asyncLink: W.__asyncLink && W.__asyncLink.stats ? plain(W.__asyncLink.stats) : null,
  farFog: typeof W.__farFogProbeStats === "function" ? call(() => plain(W.__farFogProbeStats())) : null,
  programs: call(() => W.liveScene3d.renderer.info.programs.length),
  memory: call(() => plain(W.liveScene3d.renderer.info.memory)),
  lru: call(() => (W.__landblockLru && W.__landblockLru.entries ? W.__landblockLru.entries.size : null)),
  terrainBaked: call(() => (W.liveScene3d && W.liveScene3d.terrainBakedLbs ? W.liveScene3d.terrainBakedLbs.size : null)),
});
const pose = () => { if (!camOk()) return null; const p = W.__cam.world(); return { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), lbx: Math.floor(p.x / 192), lby: Math.floor(p.y / 192) }; };
const tunnel = () => { try { return typeof W.__isPortalSpaceActive === "function" && W.__isPortalSpaceActive() === true; } catch (_) { return false; } };
const contentKey = () => `${W.__landblockLru && W.__landblockLru.entries ? W.__landblockLru.entries.size : "?"}|${call(() => W.liveScene3d.renderer.info.memory.geometries)}`;
/** Checks every mode runs on its start / end diag: the rigPoseSkip skip rate and the bakeFallbackWaves read. */
function endChecks(out, start, end) {
  out.rigPoseSkipRate = skipRate(start && start.rigPoseSkip, end && end.rigPoseSkip);
  const bfw = fallbackWavesCheck(end ? end.bakeFallbackWaves : null, end ? end.bakeWorkerSeq : null);
  out.checks = Object.assign(out.checks || {}, { bakeFallbackWaves: bfw });
  for (const x of bfw.problems) problems.push(`bakeFallbackWaves (${bfw.mode}): ${x}`);
}

// GL upload bytes (opts.countUploads; never in a scored rep: the wrapper itself costs main-thread time).
// Wrapped as own properties of the renderer's context; restore() puts back what was there (a prior own patch is
// reassigned, a prototype method is uncovered by deleting the wrapper). take() returns the window's counts and
// starts the next window.
function uploadCounter(gl) {
  const cur = { calls: {}, bytes: {} };
  const saved = [];
  for (const n of UPLOAD_METHODS) {
    const orig = gl[n];
    if (typeof orig !== "function") continue;
    // another module may already own-patch this method: restore() puts back exactly what was there
    saved.push([n, Object.prototype.hasOwnProperty.call(gl, n), orig]);
    gl[n] = function (...a) {
      cur.calls[n] = (cur.calls[n] || 0) + 1;
      try { const b = uploadBytes(n, a); if (b) cur.bytes[n] = (cur.bytes[n] || 0) + b; } catch (_) { /* count only */ }
      return orig.apply(this, a);
    };
  }
  return {
    take() { const r = { calls: { ...cur.calls }, bytes: { ...cur.bytes }, totalBytes: Object.values(cur.bytes).reduce((x, y) => x + y, 0) }; cur.calls = {}; cur.bytes = {}; return r; },
    /** Put every method back; returns the names that do not read back as what was there. */
    restore() {
      for (const [n, own, orig] of saved) { if (own) gl[n] = orig; else delete gl[n]; }
      return saved.filter(([n, own, orig]) => gl[n] !== orig || Object.prototype.hasOwnProperty.call(gl, n) !== own).map(([n]) => n);
    },
  };
}

// hbbench's first-turn camera: 360 deg around the player at 8 m, el 12, over ms
async function turn(ms) {
  try { W.__cam.release(); } catch (_) { /* not parked */ }
  const t0 = now();
  await new Promise((res) => { const f = (t) => { W.__cam.player(8, ((t - t0) / ms) * 360, 12, 1.5); if (t - t0 >= ms) return res(); requestAnimationFrame(f); }; requestAnimationFrame(f); });
  try { W.__cam.release(); } catch (_) { /* gone */ }
}
function batchPoller() {
  if (!O.pollBatch || !batchDiag()) return null;
  const st = { polls: 0, overlapPolls: 0, maxOverlap: 0, maxOverlapRunMs: 0, run: 0, last: now() };
  const id = setInterval(() => {
    const b = batchDiag(); const t = now();
    const ov = b && b.byStatus ? b.byStatus.overlap || 0 : 0;
    st.polls++;
    if (ov > 0) { st.overlapPolls++; st.run += t - st.last; st.maxOverlapRunMs = Math.max(st.maxOverlapRunMs, Math.round(st.run)); st.maxOverlap = Math.max(st.maxOverlap, ov); } else st.run = 0;
    st.last = t;
  }, 250);
  return { stop() { clearInterval(id); delete st.run; delete st.last; return st; } };
}
async function hop(h, i, up) {
  const lb = String(h.lb || "");
  const lbx = /^0x[0-9a-f]{4}$/i.test(lb) ? parseInt(lb.slice(2, 4), 16) : null, lby = lbx === null ? null : parseInt(lb.slice(4, 6), 16);
  if (up) up.take(); // the hop's windows start at the command
  const poll = batchPoller();
  const rec = recorder();
  mark(`hop${i}:${h.label}`);
  const t0 = now();
  W.__sessionHandle.sendChat(h.cmd);
  let landedMs = null, arrivedMs = null;
  while (now() - t0 < O.telelocWaitMs) {
    await sleep(100);
    const p = pose();
    if (landedMs === null && (lbx === null || (p.lbx === lbx && p.lby === lby))) landedMs = Math.round(now() - t0);
    if (landedMs !== null && !tunnel()) { arrivedMs = Math.round(now() - t0); break; }
  }
  if (arrivedMs === null) problems.push(`hop ${i} ${h.label}: not arrived in ${O.telelocWaitMs} ms (landed ${landedMs})`);
  const upArrive = up ? up.take() : null; // arrive window: command -> landing + tunnel end
  const nArrive = rec.frames.length;
  const arrivePose = pose();
  await turn(O.turnMs);
  const upTurn = up ? up.take() : null; // turn window: the 12 s turn
  const turnEnd = rec.frames.length;
  mark("gap");
  const r = rec.stop();
  const all = rec.frames;
  let key = contentKey(), changedAt = now(), quiet = false;
  const tc = now();
  while (now() - tc < O.contentMaxMs) {
    await sleep(500);
    const k = contentKey();
    if (k !== key) { key = k; changedAt = now(); } else if (now() - changedAt >= O.contentQuietMs) { quiet = true; break; }
  }
  const upContent = up ? up.take() : null; // content window: after the turn until content is quiet
  const standPose = pose();
  const land = landing(h, standPose ? standPose.z : null, O.landTolM);
  if (land.problem) problems.push(`hop ${i} ${h.label}: landing: ${land.problem}`);
  return {
    i, label: h.label, cmd: h.cmd, landedMs, arrivedMs, contentMs: Math.round(changedAt - t0), contentQuiet: quiet,
    arrivePose, standPose, dropM: land.dropM, groundZ: land.groundZ, landErrM: land.landErrM, landed: land.ok,
    arrive: fstats(all.slice(0, nArrive)), turn: fstats(all.slice(nArrive, turnEnd)), all: r.frames, loaf: r.loaf,
    uploads: up ? { arrive: upArrive, turn: upTurn, content: upContent } : null,
    batchOverlap: poll ? poll.stop() : null, diag: diag(), frames: all.slice(0, turnEnd).map((x) => +x.toFixed(1)),
  };
}

async function runRoute() {
  const out = { mode: "route", start: diag(), startPose: pose(), problems };
  if (O.verifyRigPoseSkip) {
    if (W.__rigPoseSkip) W.__rigPoseSkip.verify(true); else problems.push("verifyRigPoseSkip: window.__rigPoseSkip absent (flag off, or no rig posed yet)");
  }
  const gl = O.countUploads ? call(() => W.liveScene3d.renderer.getContext()) : null;
  const up = gl && !gl.error ? uploadCounter(gl) : null;
  if (O.countUploads && !up) problems.push("countUploads: no GL context to count on");
  try {
    if (up) up.take();
    const rec = recorder();
    mark("turn0");
    await turn(O.turnMs);
    mark("gap");
    out.turn0 = rec.stop();
    out.turn0.uploads = up ? up.take() : null;
    out.hops = [];
    for (let i = 0; i < O.hops.length; i++) out.hops.push(await hop(O.hops[i], i + 1, up));
  } finally {
    if (up) {
      const left = up.restore();
      out.glRestored = left.length === 0;
      if (left.length) problems.push(`countUploads: GL methods not restored: ${left.join(", ")}`);
    }
  }
  const cat = (k) => out.hops.flatMap((h) => (k === "turn" ? h.frames.slice(h.frames.length - (h.turn ? h.turn.n : 0)) : h.frames));
  const contents = out.hops.map((h) => h.contentMs).sort((a, b) => a - b);
  out.route = {
    hops: fstats(cat("all")), hopTurns: fstats(cat("turn")),
    loafMaxMs: Math.max(0, ...out.hops.map((h) => (h.loaf && h.loaf.maxMs) || 0)),
    contentMsMed: contents.length ? contents[contents.length >> 1] : null, contentMsMax: contents.length ? contents[contents.length - 1] : null,
    notArrived: out.hops.filter((h) => h.arrivedMs === null).length,
    notLanded: out.hops.filter((h) => h.landed !== true).length,
  };
  if (up) {
    const w = (k) => sumUploads(out.hops.map((h) => h.uploads && h.uploads[k]));
    const u = { turn0: out.turn0.uploads, arrive: w("arrive"), turn: w("turn"), content: w("content") };
    const bb = ["arrive", "turn", "content"].map((k) => bufferBytes(u[k]) || 0);
    u.bufferBytes = { turn0: bufferBytes(u.turn0), arrive: bb[0], turn: bb[1], content: bb[2] };
    u.turnShareOfBufferBytes = bb[0] + bb[1] + bb[2] > 0 ? +(bb[1] / (bb[0] + bb[1] + bb[2])).toFixed(3) : null;
    out.route.uploads = u;
  }
  if (O.verifyRigPoseSkip && W.__rigPoseSkip) { out.rigPoseSkipVerify = call(() => W.__rigPoseSkip.stats()); W.__rigPoseSkip.verify(false); }
  out.end = diag();
  endChecks(out, out.start, out.end);
  return out;
}

async function runIndoor() {
  const out = { mode: "indoor", start: diag(), pose: pose(), problems };
  const p0 = W.__cam.world();
  const eye = [p0.x, p0.y, p0.z + O.eyeDz];
  const look = (deg) => { const a = (deg * Math.PI) / 180; W.__cam.set(eye[0], eye[1], eye[2], eye[0] + 5 * Math.sin(a), eye[1] + 5 * Math.cos(a), eye[2] - 0.5); };
  const gateSkipped = () => { const g = typeof W.__indoorLandscapeGateDiag === "function" ? W.__indoorLandscapeGateDiag() : null; return g && typeof g.skippedFrames === "number" ? g.skippedFrames : null; };
  const sepSkipped = () => (W.__skipEmptyPasses ? W.__skipEmptyPasses.stats().skipped : null);
  const d = (a, b) => (a === null || b === null ? null : b - a);
  out.headings = [];
  for (let k = 0; k < 12; k++) {
    look(k * 30);
    await sleep(400);
    const g0 = gateSkipped(), s0 = sepSkipped();
    const rec = recorder();
    await sleep(O.headingMs);
    const r = rec.stop();
    const n = r.frames ? r.frames.n : 0;
    const gs = d(g0, gateSkipped());
    out.headings.push({ deg: k * 30, frames: n, gateSkipped: gs, sepSkipped: d(s0, sepSkipped()), share: gs === null || !n ? null : +(gs / n).toFixed(2), p50: r.frames ? r.frames.p50 : null });
  }
  const ranked = out.headings.filter((h) => h.share !== null).sort((a, b) => b.share - a.share || a.deg - b.deg);
  const wall = typeof O.wallDeg === "number" ? O.wallDeg : ranked.length ? ranked[0].deg : 0;
  const door = typeof O.doorDeg === "number" ? O.doorDeg : ranked.length ? ranked[ranked.length - 1].deg : 180;
  out.wallDeg = wall; out.doorDeg = door;
  if (!ranked.length) problems.push("indoor: __indoorLandscapeGateDiag() absent: headings not ranked");
  out.windows = {};
  for (const [name, deg, ms] of [["still-wall", wall, O.stillMs], ["still-door", door, O.doorMs], ["moving", null, O.moveMs]]) {
    look(deg === null ? wall : deg);
    await sleep(500);
    const g0 = gateSkipped(), s0 = sepSkipped(), sepRenders0 = W.__skipEmptyPasses ? W.__skipEmptyPasses.stats().renders : null;
    mark(name);
    const rec = recorder();
    const t0 = now();
    if (deg === null) {
      await new Promise((res) => { const f = (t) => { look(wall + ((t - t0) / 1000) * O.moveDegPerSec); if (t - t0 >= ms) return res(); requestAnimationFrame(f); }; requestAnimationFrame(f); });
    } else await sleep(ms);
    mark("gap");
    const r = rec.stop();
    const n = r.frames ? r.frames.n : 0, gs = d(g0, gateSkipped());
    out.windows[name] = { ...r, deg, gateSkipped: gs, gateShare: gs === null || !n ? null : +(gs / n).toFixed(2), sepSkipped: d(s0, sepSkipped()),
      sepRenders: W.__skipEmptyPasses ? W.__skipEmptyPasses.stats().renders - sepRenders0 : null };
  }
  try { W.__cam.release(); } catch (_) { /* gone */ }
  out.end = diag();
  endChecks(out, out.start, out.end);
  return out;
}

async function runCtxLoss() {
  const out = { mode: "ctxloss", ctx: O.ctx, start: diag(), problems };
  const r = W.liveScene3d.renderer, gl = r.getContext(), canvas = r.domElement;
  // the handle must be taken while the context is alive (getExtension answers null once it is lost)
  const ext = gl.getExtension("WEBGL_lose_context");
  if (!ext) { problems.push("ctxloss: WEBGL_lose_context unavailable"); return out; }
  const b0 = plain(batchDiag());
  const activeBefore = b0 && b0.byStatus ? b0.byStatus.active || 0 : 0;
  out.activeBefore = activeBefore;
  const ev = { lostAt: null, restoreCalledAt: null, restoredAt: null };
  const lostP = new Promise((res) => canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); ev.lostAt = now(); res(true); }, { once: true }));
  const restoredP = new Promise((res) => canvas.addEventListener("webglcontextrestored", () => { ev.restoredAt = now(); res(true); }, { once: true }));
  // per-frame batch status from just before the loss to the end of the watch
  const series = []; let sampling = true, activeAgainAt = null, legacyHeldFrames = 0, overlapSeen = false;
  const t0 = now();
  const sampleLoop = (async () => {
    while (sampling) {
      await raf();
      const s = batchDiag();
      if (!s) continue;
      const act = (s.byStatus && s.byStatus.active) || 0, ov = (s.byStatus && s.byStatus.overlap) || 0, taken = s.bucketsTaken || 0;
      const phase = ev.restoredAt !== null ? "restored" : ev.lostAt !== null ? "lost" : "pre";
      if (ov > 0) overlapSeen = true;
      // legacy on screen meanwhile: no legacy bucket stays taken (hidden) while no batch is active
      if (phase !== "pre" && act === 0 && taken > 0) legacyHeldFrames++;
      if (series.length < 600) series.push([Math.round(now() - t0), phase, act, ov, s.contextResets, s.kit && s.kit.pages ? s.kit.pages.generation : null, taken]);
      if (phase === "restored" && activeAgainAt === null && activeBefore > 0 && act >= activeBefore) activeAgainAt = now();
    }
  })();
  const rec = recorder();
  ext.loseContext();
  const lost = await withTimeout(lostP, O.eventWaitMs);
  if (!lost) problems.push(`ctxloss: no webglcontextlost event within ${O.eventWaitMs} ms`);
  // + a frame: restoreContext() must run in a later task than the lost event's dispatch
  await raf();
  if (O.ctx === "slow") { await sleep(O.restoreDelayMs); await raf(); }
  out.lostBeforeRestore = call(() => gl.isContextLost());
  out.preRestoreErrors = drainErrors(gl); // CONTEXT_LOST_WEBGL (37442) expected: recorded, not a problem
  ev.restoreCalledAt = now();
  try { ext.restoreContext(); } catch (err) { problems.push(`ctxloss: restoreContext threw: ${String((err && err.message) || err)}`); }
  out.restoreErrors = drainErrors(gl); // INVALID_OPERATION (1282) = the restore was refused
  const restored = await withTimeout(restoredP, O.eventWaitMs);
  const tw = restored ? ev.restoredAt : now();
  while (now() - tw < O.watchMs) await raf();
  sampling = false;
  await sampleLoop;
  const rr = rec.stop();
  const b1 = plain(batchDiag());
  const ms = (t) => (t === null ? null : Math.round(t - t0));
  out.events = { lostMs: ms(ev.lostAt), restoreCalledMs: ms(ev.restoreCalledAt), restoredMs: ms(ev.restoredAt) };
  // the app resumes its frame pump at 'restored' (no textures to re-hydrate) or at 'rehydrated'
  // (scene3d/webgl_context_recovery.js history; performance.now() stamps)
  const hist = typeof W.__webglContextRecoveryHistory === "function" ? call(() => W.__webglContextRecoveryHistory()) : null;
  const resumed = Array.isArray(hist) ? hist.filter((h) => h && ev.restoredAt !== null && h.ts >= ev.lostAt - 1 && (h.state === "rehydrated" || (h.state === "restored" && !h.rehydratePending))).pop() : null;
  out.recoveryHistory = Array.isArray(hist) ? hist.slice(-6) : null;
  out.resumedMs = resumed ? Math.round(resumed.ts - t0) : null;
  out.activeAgainMsAfterRestore = activeAgainAt !== null && ev.restoredAt !== null ? Math.round(activeAgainAt - ev.restoredAt) : null;
  out.activeAgainMsAfterResume = activeAgainAt !== null && resumed ? Math.round(activeAgainAt - Math.max(resumed.ts, ev.restoredAt)) : null;
  out.legacyHeldFrames = legacyHeldFrames; out.overlapSeen = overlapSeen;
  out.contextResets = { before: b0 ? b0.contextResets : null, after: b1 ? b1.contextResets : null };
  out.generation = { before: b0 && b0.kit && b0.kit.pages ? b0.kit.pages.generation : null, after: b1 && b1.kit && b1.kit.pages ? b1.kit.pages.generation : null };
  out.legacyReasons = b1 ? b1.legacyReasons : null;
  out.frames = rr.frames; out.loaf = rr.loaf; out.series = series;
  out.contextLostAtEnd = call(() => gl.isContextLost());
  out.glErrorsAtEnd = drainErrors(gl);
  out.end = diag();
  const cp = ctxlossProblems(out, { requireBatch: !O.laptopCheck, activeAgainMaxMs: O.activeAgainMaxMs });
  out.checks = { ctxloss: cp };
  for (const x of cp) problems.push(`ctxloss: ${x}`);
  return out;
}

let result;
if ((O.mode === "route" || O.mode === "indoor") && !camOk()) {
  problems.push("window.__cam absent: boot the tab with ?camDebug=on");
  result = { mode: O.mode, problems };
} else if (O.mode === "route") result = await runRoute();
else if (O.mode === "indoor") result = await runIndoor();
else if (O.mode === "ctxloss") result = await runCtxLoss();
else {
  const start = diag();
  if (O.holdMs > 0) await sleep(O.holdMs);
  result = { mode: "diag", start, diag: diag(), pose: pose(), problems };
  endChecks(result, start, result.diag);
}
result.opts = O;
return result;

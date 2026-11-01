// carry-flight.eval.js — fly the REAL drone (scene3d/drone, hb-carry experiment build) with the player
// carried under it, and census what the client and ACE keep up with. 2026-10-31.
//
// Evaluated as an async function BODY in the page: `(async () => { <this file> })()`; the run comes from
// window.__carryRun. Needs the experiment copy (/mnt/wbterminal2/hb-carry): wasm `debugDragPose` +
// `?droneCarry=on&droneDebug=on` (window.__drone.carry / .debug.setSticks).
//
// Flight: the drone is deployed (quick) if it is not flying, climbs to `aglM`, then flies `legs`
// (compass heading, metres) at `speedKmh` with its own cine flight model, driven through its sticks by a
// 10 Hz controller: pitch stick = speed / carry vmax, yaw stick toward the leg heading, throttle toward
// ground + aglM (ground = the highest KNOWN terrain 0-300 m ahead; unknown ground holds altitude and counts as
// "blind"), gimbal toward `pitchDeg`. The drone module itself sends the player's pose to ACE at 10 Hz.
//
// One row per `sampleMs`: drone pose / speed / state, carry stats, render-terrain coverage around and ahead of the
// drone, physics-terrain lead, server objects (bubble census + first-seen distance of every new object), LRU /
// bake queue, a CPU frustum census of the main pass from the drone camera (draw ESTIMATE), long tasks, rAF gaps,
// JS heap, page errors.
const R = Object.assign({
  label: "run", speedKmh: 200, aglM: 100, legs: [{ heading: 90, metres: 3000 }], pitchDeg: -25,
  sampleMs: 1000, settleMs: 8000, census: true, maxSec: 900, climbTimeoutSec: 60, deployTimeoutSec: 90,
}, window.__carryRun || {});

const W = window, L = W.liveScene3d, h = W.__sessionHandle, D = W.__drone;
const out = { label: R.label, run: R, errors: [], startedAt: new Date().toISOString() };
if (!D || typeof D.carry !== "function") return { ...out, fatal: "window.__drone.carry missing (hb-carry build, ?droneCarry=on, __droneHud.load())" };
if (!D.debug || typeof D.debug.setSticks !== "function") return { ...out, fatal: "__drone.debug missing (?droneDebug=on)" };
if (!h || typeof h.debugDragPose !== "function") return { ...out, fatal: "debugDragPose missing (hb-carry wasm)" };
const THREE = await import("three").catch(() => null);
const em = L.entityManager, g = (W.getLocalPlayerGuid?.() ?? 0) >>> 0;
const LB = 192, BUBBLE = 112.5, DEG = Math.PI / 180;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrap180 = (a) => { let x = ((a + 180) % 360 + 360) % 360 - 180; return x === -180 ? 180 : x; };
const groundAt = (x, y) => { try { const v = h.terrainHeightAt(x, y); return v == null || !Number.isFinite(v) ? null : v; } catch (_) { return null; } };
const playerPos = () => em.entityMap.get(g)?.root?.position ?? null;
const isWorldObj = (guid, p) => p && (guid >>> 0) !== g && !(Math.abs(p.x) < 1 && Math.abs(p.y) < 1);
const st = () => { try { return D.status(); } catch (e) { return { ok: false, err: String(e) }; } };
const craft = () => st().craft;

// ---------- instruments ----------
const lt = { n: 0, ms: 0, max: 0 };
let po = null;
try { po = new PerformanceObserver((l) => { for (const e of l.getEntries()) { lt.n++; lt.ms += e.duration; if (e.duration > lt.max) lt.max = e.duration; } }); po.observe({ type: "longtask", buffered: false }); } catch (_) { po = null; }
const raf = { gaps: [], last: 0, on: true };
const rafTick = (t) => { if (!raf.on) return; if (raf.last) raf.gaps.push(t - raf.last); raf.last = t; requestAnimationFrame(rafTick); };
requestAnimationFrame(rafTick);
let pageErrs = 0;
const onErr = () => { pageErrs++; };
W.addEventListener("error", onErr); W.addEventListener("unhandledrejection", onErr);
const lru = () => { try { const s = W.__landblockLru?.getStats?.(); return s ? { resident: s.resident, evicted: s.evicted, parked: s.parked, liveGeom: s.liveGeom } : null; } catch (_) { return null; } };
const bakeQ = () => { try { const s = W.__diag?.bakeWorkerStats?.(); if (!s) return null; const q = s.queue; return { queue: typeof q === "number" ? q : q && typeof q === "object" ? (q.depth ?? q.length ?? q.pending ?? q.size ?? null) : null, raw: q && typeof q === "object" ? Object.fromEntries(Object.entries(q).filter(([, v]) => typeof v === "number").slice(0, 8)) : undefined }; } catch (_) { return null; } };
const heapMB = () => { try { return performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null; } catch (_) { return null; } };
const tb = () => (L.terrainBakedLbs instanceof Set ? L.terrainBakedLbs : null);
const key = (lbx, lby) => ((((lbx & 0xff) << 24) | ((lby & 0xff) << 16)) >>> 0);
const coverage = (x, y, ux, uy) => {
  const s = tb(); if (!s) return null;
  const cx = Math.floor(x / LB), cy = Math.floor(y / LB);
  const ring = (r) => { let have = 0, n = 0; for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) { n++; if (s.has(key(cx + i, cy + j))) have++; } return +(have / n).toFixed(2); };
  let lead = 0;
  for (let k = 1; k <= 24; k++) { const px = x + ux * k * 96, py = y + uy * k * 96; if (!s.has(key(Math.floor(px / LB), Math.floor(py / LB)))) break; lead = k * 96; }
  let physLead = 0;
  for (const d of [0, 50, 100, 200, 300, 400, 600, 800]) { if (groundAt(x + ux * d, y + uy * d) == null) break; physLead = d; }
  return { baked: s.size, r1: ring(1), r2: ring(2), r3: ring(3), r5: ring(5), leadM: lead, physLeadM: physLead, underBaked: s.has(key(cx, cy)) };
};
const frustum = THREE ? new THREE.Frustum() : null, pm = THREE ? new THREE.Matrix4() : null, dirV = THREE ? new THREE.Vector3() : null;
const camPitchDeg = () => { try { L.camera.getWorldDirection(dirV); return Math.asin(clamp(dirV.y, -1, 1)) / DEG; } catch (_) { return null; } };
const census = () => {
  if (!R.census || !frustum || !L.camera) return null;
  const cam = L.camera, t0 = now();
  cam.updateMatrixWorld(true);
  pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  frustum.setFromProjectionMatrix(pm);
  let draws = 0, mesh = 0, inst = 0, instN = 0, batched = 0, other = 0, culled = 0, objects = 0;
  const visit = (o) => {
    if (o.visible === false) return;
    objects++;
    const layersOk = !o.layers || !cam.layers || o.layers.test(cam.layers);
    if (layersOk && (o.isMesh || o.isLine || o.isPoints || o.isSprite)) {
      let inView = true;
      if (o.frustumCulled !== false) { try { inView = o.isSprite ? frustum.intersectsSprite(o) : frustum.intersectsObject(o); } catch (_) { inView = true; } }
      if (!inView) culled++;
      else if (o.isBatchedMesh) { batched++; draws++; }
      else if (o.isInstancedMesh) { if (o.count > 0) { inst++; instN += o.count; draws++; } }
      else if (o.isMesh) {
        mesh++;
        if (Array.isArray(o.material)) { const gr = o.geometry?.groups; draws += gr && gr.length ? gr.filter((q) => o.material[q.materialIndex]?.visible !== false).length : 1; }
        else if (o.material?.visible !== false) draws++;
      } else { other++; draws++; }
    }
    const ch = o.children; for (let i = 0; i < ch.length; i++) visit(ch[i]);
  };
  visit(L.scene);
  return { draws, mesh, inst, instN, batched, other, culled, objects, ms: r1(now() - t0) };
};
const known = new Set();
for (const [guid, inst] of em.entityMap) { const p = inst?.root?.position; if (isWorldObj(guid, p)) known.add(guid >>> 0); }
const preKnown = known.size, firstSeen = [];
const scanObjects = (x, y, ux, uy, t) => {
  let total = 0, bubble = 0, ahead = 0;
  for (const [guid, inst] of em.entityMap) {
    const p = inst?.root?.position; if (!isWorldObj(guid, p)) continue;
    total++;
    const dx = p.x - x, dy = p.y - y, d = Math.hypot(dx, dy);
    if (d <= BUBBLE) { bubble++; if (dx * ux + dy * uy > 0) ahead++; }
    const k = guid >>> 0;
    if (!known.has(k)) { known.add(k); firstSeen.push({ t: r1(t), d: r1(d), along: r1(dx * ux + dy * uy), name: inst.meta?.name ?? null }); }
  }
  return { total, bubble, ahead };
};

// ---------- deploy + climb ----------
const t0 = now();
const tSec = () => (now() - t0) / 1000;
const rows = [];
let lastLt = { n: 0, ms: 0 }, nextSample = 0, phase = "deploy", leg = 0, legStart = null, travelled = 0, blind = 0, ctl = 0;
let headingWanted = R.legs[0]?.heading ?? 0;
const sample = () => {
  const s = st(), c = s.craft, pos = c ? { x: c.pos[0], y: c.pos[1], z: c.pos[2] } : null;
  const hd = (c?.hprDeg?.h ?? headingWanted) * DEG, ux = Math.sin(hd), uy = Math.cos(hd);
  const gaps = raf.gaps.splice(0); gaps.sort((a, b) => a - b);
  const pp = playerPos();
  const row = {
    t: r1(tSec()), phase, leg, state: s.state, m: Math.round(travelled),
    drone: pos ? [r1(pos.x), r1(pos.y), r1(pos.z)] : null, agl: r1(c?.aglM), speed: r1(c?.speed), hdg: r1(c?.hprDeg?.h), camPitch: r1(camPitchDeg()),
    carry: s.carry ? { sends: s.carry.sends, catchUps: s.carry.catchUps, maxGapM: s.carry.maxGapM, errors: s.carry.errors } : null,
    playerGap: pos && pp ? r1(Math.hypot(pp.x - pos.x, pp.y - pos.y)) : null, playerZ: pp ? r1(pp.z) : null,
    cov: pos ? coverage(pos.x, pos.y, ux, uy) : null, obj: pos ? scanObjects(pos.x, pos.y, ux, uy, tSec()) : null, newObj: firstSeen.length,
    lru: lru(), bake: bakeQ(), census: census(), heapMB: heapMB(),
    lt: { n: lt.n - lastLt.n, ms: Math.round(lt.ms - lastLt.ms), max: Math.round(lt.max) },
    raf: { n: gaps.length, p95: gaps.length ? r1(gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.95))]) : null, max: gaps.length ? r1(gaps[gaps.length - 1]) : null },
    portal: !!W.__isPortalSpaceActive?.(), errs: pageErrs, blind,
  };
  lastLt = { n: lt.n, ms: lt.ms }; lt.max = 0;
  rows.push(row);
};
const tick = () => { if (now() - t0 >= nextSample) { sample(); nextSample += R.sampleMs; } };

try {
  const s0 = st();
  if (s0.state !== "flying") {
    const tIdle = now();
    while (st().state !== "idle" && now() - tIdle < 60000) { try { if (D.debug) D.debug.trigger("pilotMoved"); } catch (_) { /* */ } await sleep(1000); }
    D.setSettings({ batteryMin: 0, mode: "cine", crash: false });
    const dep = D.deploy({ quick: true });
    out.deploy = dep;
    if (!dep.ok) throw new Error("deploy refused: " + JSON.stringify(dep));
    const tDep = now();
    while (st().state !== "flying") {
      if (now() - tDep > R.deployTimeoutSec * 1000) throw new Error("not flying after deploy: " + st().state);
      if (st().state === "idle" && now() - tDep > 3000) throw new Error("deploy fell back to idle: " + JSON.stringify(st().lastAbort));
      tick(); await sleep(250);
    }
    out.deploySec = r1((now() - tDep) / 1000);
  }
  // ---------- climb ----------
  phase = "climb";
  const tClimb = now();
  for (;;) {
    const c = craft(); if (!c) throw new Error("no craft status");
    const gz = groundAt(c.pos[0], c.pos[1]);
    const err = gz == null ? 0 : gz + R.aglM - c.pos[2];
    const pNow = camPitchDeg();
    const gim = pNow == null ? 0 : clamp((R.pitchDeg - pNow) / 10, -1, 1);
    D.debug.setSticks({ throttle: clamp(err / 15, -1, 1), gimbal: gim }, 1500);
    tick();
    if (Math.abs(err) < 3 && (pNow == null || Math.abs(R.pitchDeg - pNow) < 2)) break;
    if (now() - tClimb > R.climbTimeoutSec * 1000) { out.errors.push("climb timeout (err " + r1(err) + " m)"); break; }
    await sleep(100);
  }
  out.climbSec = r1((now() - tClimb) / 1000);
  // ---------- cruise ----------
  phase = "fly";
  const vmax = (D.carry().cfg.kmh || 760) / 3.6;
  const stick = clamp(R.speedKmh / 3.6 / vmax, 0, 1);
  const tFly = now();
  let prev = craft().pos.slice();
  legStart = prev.slice();
  for (;;) {
    if (tSec() > R.maxSec) { out.errors.push("maxSec reached"); break; }
    const s = st();
    if (s.state !== "flying") { out.errors.push(`drone left flying: ${s.state} ${JSON.stringify(s.lastAbort)}`); break; }
    const c = s.craft;
    const legDone = Math.hypot(c.pos[0] - legStart[0], c.pos[1] - legStart[1]);
    travelled += Math.hypot(c.pos[0] - prev[0], c.pos[1] - prev[1]);
    prev = c.pos.slice();
    if (legDone >= R.legs[leg].metres) {
      leg++;
      if (leg >= R.legs.length) break;
      legStart = c.pos.slice();
    }
    headingWanted = R.legs[leg].heading;
    const hNow = c.hprDeg?.h ?? headingWanted;
    const herr = wrap180(headingWanted - hNow);
    const hd = hNow * DEG, ux = Math.sin(hd), uy = Math.cos(hd);
    let gMax = null;
    for (const d of [0, 50, 100, 200, 300]) { const gz = groundAt(c.pos[0] + ux * d, c.pos[1] + uy * d); if (gz != null && (gMax == null || gz > gMax)) gMax = gz; }
    let thr = 0;
    if (gMax == null) blind++;
    else thr = clamp((gMax + R.aglM - c.pos[2]) / 15, -1, 1);
    const pNow = camPitchDeg();
    D.debug.setSticks({ pitch: stick, boost: true, yaw: clamp(herr / 30, -1, 1), throttle: thr, gimbal: pNow == null ? 0 : clamp((R.pitchDeg - pNow) / 10, -1, 1) }, 1500);
    ctl++;
    tick();
    await sleep(100);
  }
  out.flySec = r1((now() - tFly) / 1000);
  // ---------- hover ----------
  phase = "hover";
  const tH = now();
  while (now() - tH < R.settleMs) {
    const c = craft(); const gz = c ? groundAt(c.pos[0], c.pos[1]) : null;
    D.debug.setSticks({ throttle: c && gz != null ? clamp((gz + R.aglM - c.pos[2]) / 15, -1, 1) : 0 }, 1500);
    tick(); await sleep(100);
  }
} catch (e) {
  out.errors.push(String(e?.stack ?? e).slice(0, 600));
} finally {
  raf.on = false;
  try { po?.disconnect(); } catch (_) { /* gone */ }
  W.removeEventListener("error", onErr); W.removeEventListener("unhandledrejection", onErr);
}

// ---------- summary ----------
const fly = rows.filter((r) => r.phase === "fly" && r.state === "flying");
const nums = (a) => a.filter((v) => v != null && Number.isFinite(v));
const med = (a) => { const b = nums(a).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; };
const mean = (a) => { const b = nums(a); return b.length ? r1(b.reduce((x, y) => x + y, 0) / b.length) : null; };
const mx = (a) => { const b = nums(a); return b.length ? Math.max(...b) : null; };
const mn = (a) => { const b = nums(a); return b.length ? Math.min(...b) : null; };
const ds = firstSeen.filter((f) => f.t >= (rows.find((r) => r.phase === "fly")?.t ?? 0)).map((f) => f.d);
const last = st();
out.summary = {
  metres: Math.round(travelled), flySec: out.flySec, achievedKmh: out.flySec ? r1((travelled / out.flySec) * 3.6) : null,
  cruiseKmhMed: r1((med(fly.map((r) => r.speed)) ?? 0) * 3.6), deploySec: out.deploySec ?? null, climbSec: out.climbSec,
  aglMed: med(fly.map((r) => r.agl)), aglMin: mn(fly.map((r) => r.agl)), blindCtlFrac: ctl ? +(blind / ctl).toFixed(3) : null,
  terrainUnderBakedFrac: fly.length ? +(fly.filter((r) => r.cov?.underBaked).length / fly.length).toFixed(2) : null,
  r1Mean: mean(fly.map((r) => r.cov?.r1)), r2Mean: mean(fly.map((r) => r.cov?.r2)), r3Mean: mean(fly.map((r) => r.cov?.r3)), r5Mean: mean(fly.map((r) => r.cov?.r5)),
  leadMed: med(fly.map((r) => r.cov?.leadM)), leadMin: mn(fly.map((r) => r.cov?.leadM)), physLeadMed: med(fly.map((r) => r.cov?.physLeadM)), physLeadMin: mn(fly.map((r) => r.cov?.physLeadM)),
  bubbleMean: mean(fly.map((r) => r.obj?.bubble)), bubbleZeroFrac: fly.length ? +(fly.filter((r) => (r.obj?.bubble ?? 0) === 0).length / fly.length).toFixed(2) : null,
  newObjectsInFlight: ds.length, preKnown,
  firstSeen: ds.length ? { min: mn(ds), median: med(ds), max: mx(ds) } : null,
  firstSeenAheadFrac: ds.length ? +(firstSeen.filter((f) => f.along > 0).length / firstSeen.length).toFixed(2) : null,
  censusDrawsMed: med(fly.map((r) => r.census?.draws)), censusDrawsMax: mx(fly.map((r) => r.census?.draws)), censusMsMed: med(fly.map((r) => r.census?.ms)),
  longTaskMsPerSec: mean(fly.map((r) => r.lt.ms)), longTaskMax: mx(rows.map((r) => r.lt.max)),
  rafP95Med: med(fly.map((r) => r.raf.p95)), rafMax: mx(fly.map((r) => r.raf.max)),
  heapStart: rows[0]?.heapMB ?? null, heapEnd: rows[rows.length - 1]?.heapMB ?? null, heapMax: mx(rows.map((r) => r.heapMB)),
  lruResidentMax: mx(rows.map((r) => r.lru?.resident)), lruEvicted: (rows[rows.length - 1]?.lru?.evicted ?? 0) - (rows[0]?.lru?.evicted ?? 0),
  bakeQueueMax: mx(rows.map((r) => r.bake?.queue)), playerGapMax: mx(fly.map((r) => r.playerGap)),
  carry: last.carry, droneState: last.state, lastAbort: last.lastAbort, pageErrors: pageErrs, portalSeen: rows.some((r) => r.portal),
};
out.rows = rows;
out.firstSeenSample = firstSeen.slice(0, 100);
out.endedAt = new Date().toISOString();
return out;

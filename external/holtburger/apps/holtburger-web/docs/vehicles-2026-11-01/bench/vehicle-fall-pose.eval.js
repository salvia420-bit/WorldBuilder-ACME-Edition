// vehicle-fall-pose.eval.js — pilot page (DESIGN decisions 54-61, `?vehicleFallAnim`, default on): board the parked
// vehicle nearby, climb, bail out, and report the falling body's pose at three moments — FREE FALL (retail Falling
// 0x40000015, the parachute pack packed on the back), UNDER THE CANOPY (the canopy grip clip on the playhead, the pack
// flattened, the hands up on the risers) and AFTER TOUCHDOWN (clip off, Ready, pack gone).
// window.__vehicleRun: {climbAgl: 300, maxSec: 300, manualChute: false, chuteAfterSec: 4, holdSec: 2.5}
//   manualChute: open the chute with X (V.openChute) `chuteAfterSec` after the bail instead of waiting for 150 m AGL.
// Stills: at each moment it sets window.__fallPoseProbe = {phase: "freefall" | "canopy" | "landed", t} and then holds
// `holdSec` before sampling, so a director polling every ~400 ms (bench/vehicle-1070.mjs runEval) can take the still:
//   (s, d) => pg.evaluate(() => window.__fallPoseProbe?.phase).then((ph) => ph && once(d, ph) && still(`fall-${ph}`, ph))
// Laptop (structural, SwiftShader, one heavy job): capped-build node vehicle-runner.mjs --plan plan-fall-pose.json
const R = window.__vehicleRun || {};
const V = window.__vehicles, h = window.__sessionHandle, em = window.liveScene3d?.entityManager;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const hex = (n) => "0x" + ((n ?? 0) >>> 0).toString(16);
const ground = (x, y) => { try { const z = h.terrainHeightAt(x, y); return z == null ? null : z; } catch (_) { return null; } };
const me = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;
const out = { ok: false, samples: {}, checks: {} };
if (!V || !em) return { ...out, fatal: "window.__vehicles / entityManager missing (?vehicles=on not loaded)" };
const fp0 = V.status().fallPose;
if (!fp0 || fp0.enabled === false) return { ...out, fatal: "the fall pose is off (?vehicleFallAnim=off)" };
const t0 = now();
const tSec = () => (now() - t0) / 1000;
const hold = (R.holdSec ?? 2.5) * 1000;
const mark = (phase) => { window.__fallPoseProbe = { phase, t: Math.round(tSec() * 10) / 10 }; };
window.__fallPoseProbe = null;

// the local rig in object space (AC: x right, y forward, z up, metres before the root scale)
const partPos = (inst, i) => { const p = inst?.parts?.[i]?.position; return p ? [r2(p.x), r2(p.y), r2(p.z)] : null; };
function sample(phase) {
  const st = V.status();
  const inst = em.entityMap.get(me);
  const seq = inst?._unifiedSeq ?? null;
  let frame = null;
  try { frame = seq?.seq?.globalFrameIndex ?? null; } catch (_) { frame = null; }
  const pack = inst?.parts?.[9]?.children?.find?.((c) => c.name?.startsWith?.("vehicle-pack-")) ?? null;
  const body = st.fallPose?.bodies?.find?.((b) => b.guid === me) ?? null;
  const rp = inst?.root?.position;
  return {
    phase, t: r2(tSec()),
    fall: st.fall ? { agl: r2(st.fall.agl), vz: r2(st.fall.vz), chute: st.fall.chute, sec: r2(st.fall.sec), maxSec: r2(st.fall.maxSec) } : null,
    motion: inst ? hex(inst.lastMotionCommand) : null,
    playhead: seq ? { localClip: seq.localClip === true, holdFinal: seq.clearOnDone === false, frames: seq.desc?.numFrames ?? null, frame } : null,
    body, // fall_pose status: phase, fit (table / fallback-human), heritage, sex, rootScale, pack {attached, flat, dims}, clip
    pack: pack ? { attached: true, depthScale: r2(pack.children?.[0]?.scale?.y), pos: [r2(pack.position.x), r2(pack.position.y), r2(pack.position.z)] } : { attached: false },
    rig: inst ? {
      rootScale: r2(inst.root?.scale?.x), feetAgl: rp ? r2(rp.z - (ground(rp.x, rp.y) ?? NaN)) : null,
      shoulderL: partPos(inst, 10), handL: partPos(inst, 12), shoulderR: partPos(inst, 13), handR: partPos(inst, 15), head: partPos(inst, 16),
    } : null,
    chutes: st.chutes,
    stats: st.fallPose?.stats ?? null,
  };
}

// 1. board (approach the newest parked vehicle first if needed — as vehicle-bail.eval.js)
if (!V.nearest()) {
  const v = [...V.vehicles()].reverse().find((x) => x.profile && x.last && x.last.mode === 0);
  if (v) {
    h.sendChat(`@teleloc 0x${(v.last.cell >>> 0).toString(16)} ${Math.max(1, v.last.x - 4).toFixed(2)} ${v.last.y.toFixed(2)} ${(v.last.z + 0.5).toFixed(2)}`);
    for (let i = 0; i < 40 && !V.nearest(); i++) await sleep(250);
    await sleep(1500);
  }
}
out.board = V.board(V.nearest());
while (!V.piloting && tSec() < 10) await sleep(200);
if (!V.piloting) return { ...out, fatal: "board refused", status: V.status() };
// 2. climb
let st = null;
while (tSec() < 150) {
  st = V.status().pilot?.state;
  if (!st) { await sleep(100); continue; }
  const agl = st.z - (ground(st.x, st.y) ?? 0);
  if (st.mode === 2 && agl >= (R.climbAgl ?? 300)) break;
  V.setSticks({ throttle: 1, pitch: st.mode === 2 ? 1 : 0, roll: 0.2 }, 2000);
  await sleep(100);
}
out.bailAgl = st ? r2(st.z - (ground(st.x, st.y) ?? 0)) : null;
// 3. bail; free fall
V.clearSticks();
V.exit(1);
const tB = now();
while (!V.falling && now() - tB < 5000) await sleep(100);
if (!V.falling) return { ...out, fatal: "no fall after the bail", status: V.status() };
mark("freefall");
await sleep(hold);
out.samples.freefall = sample("freefall");
// 4. the chute (automatic at 150 m AGL, or X)
const tF = now();
while (V.falling && !V.status().fall?.chute && tSec() < (R.maxSec ?? 300)) {
  if (R.manualChute && (now() - tB) / 1000 >= (R.chuteAfterSec ?? 4)) V.openChute();
  await sleep(100);
}
out.freefallSec = r2((now() - tF) / 1000 + hold / 1000);
if (V.falling) {
  mark("canopy");
  await sleep(hold);
  out.samples.canopy = sample("canopy");
}
// 5. touchdown
while (V.falling && tSec() < (R.maxSec ?? 300)) await sleep(150);
mark("landed");
await sleep(hold);
out.samples.landed = sample("landed");
out.fallSec = r2((now() - tB) / 1000 - hold / 1000);

// checks (structural; the look is the GPU stills' job)
const s1 = out.samples.freefall, s2 = out.samples.canopy, s3 = out.samples.landed;
const low = (m) => (m ? parseInt(m, 16) & 0xffff : -1);
const handsUp = (s) => !!(s?.rig?.handL && s.rig.handR && s.rig.shoulderL && s.rig.handL[2] > s.rig.shoulderL[2] + 0.08 && s.rig.handR[2] > s.rig.shoulderR[2] + 0.08 && Math.abs(s.rig.handL[0]) < 0.45);
const handsOut = (s) => !!(s?.rig?.handL && Math.abs(s.rig.handL[0]) > 0.45 && Math.abs(s.rig.handR[0]) > 0.45);
out.checks = {
  freefallMotionFalling: low(s1?.motion) === 0x15,
  freefallArmsSpread: handsOut(s1), // the retail Falling pose: arms out at the sides
  freefallPackPacked: !!(s1?.pack?.attached && (s1.body?.pack?.flat ?? 1) < 0.2),
  freefallNoClip: !s1?.playhead?.localClip,
  canopyClip: !!(s2?.playhead?.localClip && s2.playhead.holdFinal),
  canopyHandsUp: handsUp(s2),
  canopyPackFlat: !!(s2?.pack?.attached && (s2.body?.pack?.flat ?? 0) > 0.8),
  canopyDrawn: (s2?.chutes?.live ?? 0) > 0, // the canopy over the body (`?vehicleChute`)
  landedReleased: !s3?.body && !s3?.pack?.attached && !s3?.playhead?.localClip,
  landedNotFalling: low(s3?.motion) !== 0x15,
};
out.ok = Object.values(out.checks).every(Boolean);
out.summary = {
  ok: out.ok, bailAgl: out.bailAgl, fallSec: out.fallSec, fit: s1?.body?.fit ?? null, heritage: s1?.body?.heritage ?? null,
  sex: s1?.body?.sex ?? null, rootScale: s1?.rig?.rootScale ?? null, packDims: s1?.body?.pack?.dims ?? null,
  failed: Object.entries(out.checks).filter(([, v]) => !v).map(([k]) => k), stats: s3?.stats ?? null,
};
window.__fallPoseProbe = { phase: "done", t: r2(tSec()) };
return out;

// tests/vehicle_fall_pose.test.mjs — the bailed-out body's pose (scene3d/vehicle/fall_pose.js, `?vehicleFallAnim`,
// DEFAULT ON) and the long-fall bound (docs/vehicles-2026-11-01/DESIGN.md decisions 54-61).
//
//   F1  the URL flag: default on; off / 0 / false / no (any case, trimmed) escape.
//   F2  DAT pins (docs/vehicles-2026-11-01/fall-pose/fall-pose-fixtures.json, generated from client_portal.dat):
//       every CharGen heritage x sex row has its PACK_PROFILES row (scale, MotionTable, kind, torso, head); every
//       humanoid MotionTable's NonCombat Falling = the loop 0x030004A9 behind 0x030004AA, back through 0x030004A6.
//   F3  profile resolution: table / human fallback / none, never throws.
//   F4  pack placement per heritage x gender: on the back surface, below the shoulders, mild size differences,
//       straps over the shoulders to the chest front; the Olthoi anchor; geometry extents.
//   F5  the canopy clip from the retail Falling frames: exact lead-in start and seams, the wrists on the grips,
//       joints as tight as retail's own, calmer than the source, wider grip for wider heads, buildClip descriptors.
//   F6  the state machine: bail -> chute -> touchdown -> cleanup (and the missed-bail / gone / seated variants).
//   F7  the driver against a fake EntityManager (real three part groups): Falling + pack at the bail, the canopy clip
//       (holdFinal) at the chute and its loop re-play, the held-motion watchdog, rig rebuild, touchdown hand-back
//       (no Ready on a death hold), observed bodies landing / inferred chute, dispose.
//   F8  the long fall: a 5 km bail walks the fall model past 120 s (free fall to the 150 m chute, then 5 m/s);
//       fallTimeoutSec covers it and a chute opened at the top; index.js uses the bound, not a fixed 120 s.
//   F9  the canopy's lines (chute.js lineSegments): to the two riser grips + riser straps, or the single harness.
//
// Run: node tests/vehicle_fall_pose.test.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

const FP = await import("../scene3d/vehicle/fall_pose.js");
const F = await import("../scene3d/vehicle/fall_model.js");
const FM = await import("../scene3d/vehicle/flight_model.js");
const C = await import("../scene3d/vehicle/chute.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(HERE, "../docs/vehicles-2026-11-01/fall-pose/fall-pose-fixtures.json"), "utf8"));
const A = fx.anims["0x030004A9"];
const FALL_ANIM = { numFrames: A.numFrames, numParts: A.numParts, frames: Float32Array.from(A.frames), did: 0x030004a9, flags: A.flags };

let passed = 0;
let failed = 0;
async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [OK] ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${label} — ${err.message}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m || "assertion failed"); }
function near(a, b, eps, m) { if (!(Math.abs(a - b) <= eps)) throw new Error(`${m}: ${a} vs ${b} (eps ${eps})`); }
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const hex = (n) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
function partAt(frames, np, f, i) {
  const b = (f * np + i) * 7;
  return { p: [frames[b], frames[b + 1], frames[b + 2]], q: [frames[b + 3], frames[b + 4], frames[b + 5], frames[b + 6]] };
}
function qrot(q, v) {
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const tickAsync = () => new Promise((r) => setTimeout(r, 0));

console.log("F1 the URL flag");
await check("?vehicleFallAnim: default on; off / 0 / false / no escape (trimmed, any case)", () => {
  assert(FP.fallAnimEnabled("") && FP.fallAnimEnabled(undefined) && FP.fallAnimEnabled("?vehicles=on"), "default on");
  for (const v of ["off", "0", "false", "no", "OFF", " No ", "False"]) assert(!FP.fallAnimEnabled(`?vehicleFallAnim=${encodeURIComponent(v)}`), `escape ${v}`);
  for (const v of ["on", "1", "true", "yes", ""]) assert(FP.fallAnimEnabled(`?vehicleFallAnim=${v}`), `stays on for ${v}`);
});

console.log("F2 DAT pins");
await check("every CharGen heritage x sex row has its pack profile (scale, MotionTable, kind)", () => {
  assert(fx.chargen.length === 26, `26 rows (13 heritages x 2), got ${fx.chargen.length}`);
  for (const r of fx.chargen) {
    const p = FP.PACK_PROFILES[r.setup];
    assert(p, `${r.heritage} ${r.sex} ${r.setup} missing`);
    assert(p.scale === r.scale, `${r.setup} scale ${p.scale} vs CharGen ${r.scale}`);
    assert(p.motionTable === r.motionTable, `${r.setup} motion table ${p.motionTable} vs ${r.motionTable}`);
    assert(p.kind === fx.setups[r.setup].kind, `${r.setup} kind`);
    if (p.kind === "humanoid") assert(p.sex === r.sex, `${r.setup} sex ${p.sex} vs ${r.sex}`);
  }
  assert(Object.keys(FP.PACK_PROFILES).length === Object.keys(fx.setups).length, "no extra rows");
});
await check("the torso / head measurements and the Olthoi anchors equal the DAT", () => {
  for (const [key, s] of Object.entries(fx.setups)) {
    const p = FP.PACK_PROFILES[key];
    if (s.kind === "humanoid") {
      for (const k of ["backY", "frontY", "top", "bottom", "halfW"]) near(p.torso[k], s.torso[k], 1e-6, `${key} ${k}`);
      near(p.headHalfW, s.headHalfW, 1e-6, `${key} headHalfW`);
      assert(s.parts === 34 && s.rightHandPart === 15 && s.leftHandPart === 12, `${key} humanoid rig`);
    } else {
      assert(p.anchor.part === s.anchor.part, `${key} anchor part`);
      for (let i = 0; i < 3; i++) near(p.anchor.pos[i], s.anchor.pos[i], 1e-6, `${key} anchor pos`);
      for (let i = 0; i < 4; i++) near(p.anchor.quat[i], s.anchor.quat[i], 1e-6, `${key} anchor quat`);
    }
  }
  const rest = fx.restFrames[9];
  for (let i = 0; i < 4; i++) near(FP.HUMANOID_FALL_RIG.chestRestQuat[i], rest[3 + i], 1e-6, "chest rest quaternion");
});
await check("every humanoid MotionTable: NonCombat Falling = 0x030004A9 behind 0x030004AA, back via 0x030004A6", () => {
  const humanoidMts = new Set(fx.chargen.filter((r) => fx.setups[r.setup].kind === "humanoid").map((r) => r.motionTable));
  assert(humanoidMts.size === 9, `9 humanoid motion tables, got ${humanoidMts.size}`);
  for (const mt of humanoidMts) {
    const e = fx.motionTables[mt];
    assert(e.fallingCycle.length === 1 && e.fallingCycle[0].anim === hex(FP.FALL_ANIMS.LOOP), `${mt} cycle`);
    assert(e.readyToFalling.at(-1).anim === hex(FP.FALL_ANIMS.READY_TO_FALLING), `${mt} Ready->Falling`);
    assert(e.fallingToReady[0].anim === hex(FP.FALL_ANIMS.FALLING_TO_READY) && e.fallingToReady[0].fps < 0, `${mt} Falling->Ready (reversed)`);
  }
  // the Empyrean tables prepend their hover link; the Olthoi tables have their own
  assert(fx.motionTables["0x0900020B"].readyToFalling[0].anim === "0x03000C34", "Empyrean hover link");
  assert(fx.motionTables["0x09000206"].fallingCycle[0].anim !== hex(FP.FALL_ANIMS.LOOP), "Olthoi own falling");
  assert(A.numParts === 34 && A.numFrames === 22 && (A.flags & 1) === 0, "the loop: 22 frames, 34 parts, no root motion");
});

console.log("F3 profile resolution");
await check("table hits, the human fallback, none; never throws", () => {
  const lug = FP.resolvePackProfile({ setupId: 0x02001a18, partCount: 34 });
  assert(lug.source === "table" && lug.kind === "humanoid" && lug.profile.heritage === "Lugian" && lug.profile.sex === "Male", "Lugian male");
  const ol = FP.resolvePackProfile({ setupId: 0x02001a21, partCount: 25 });
  assert(ol.source === "table" && ol.kind === "no-hands", "Olthoi");
  const odd = FP.resolvePackProfile({ setupId: 0x02001a18, partCount: 12 });
  assert(odd.source === "none" && odd.profile === null, "a humanoid row on a 12-part rig");
  const unk = FP.resolvePackProfile({ setupId: 0x02009999, partCount: 34 });
  assert(unk.source === "fallback-human" && unk.profile === FP.PACK_PROFILES[FP.HUMAN_FALLBACK_SETUP], "unknown humanoid");
  assert(FP.resolvePackProfile({ setupId: 0x02009999, partCount: 34, humanoid: false }).source === "none", "unknown, no hands");
  assert(FP.resolvePackProfile({ setupId: 0x02000123, partCount: 9 }).source === "none", "unknown creature");
  for (const junk of [undefined, null, 7, "x", { setupId: "a", partCount: "b" }]) assert(FP.resolvePackProfile(junk).kind === "none", `junk ${String(junk)}`);
  assert(FP.setupKey(0x0200004e) === "0x0200004E" && FP.setupKey(undefined) === "0x00000000", "setup keys");
});

console.log("F4 pack placement");
const humanoidKeys = Object.keys(FP.PACK_PROFILES).filter((k) => FP.PACK_PROFILES[k].kind === "humanoid");
await check("every humanoid fit: the front face on the back surface, below the shoulders, inside the torso width", () => {
  for (const k of humanoidKeys) {
    const prof = FP.PACK_PROFILES[k];
    const pl = FP.packPlacement({ profile: prof });
    const t = prof.torso;
    assert(pl.part === 9 && pl.kind === "humanoid", `${k} anchor = chest part 9`);
    near(pl.pos[1], t.backY + FP.PACK.gap, 1e-9, `${k} front face off the back`);
    assert(pl.pos[0] === 0, `${k} centred`);
    assert(pl.pos[2] + pl.dims.h / 2 <= t.top - 0.02 + 1e-9, `${k} top below the shoulders`);
    assert(pl.pos[2] - pl.dims.h / 2 >= t.bottom - 0.05, `${k} bottom near the torso's`);
    assert(pl.dims.w < 2 * t.halfW + 1e-9 || pl.dims.w === FP.PACK.minW, `${k} narrower than the torso`);
    for (const [v, lo, hi] of [[pl.dims.w, FP.PACK.minW, FP.PACK.maxW], [pl.dims.h, FP.PACK.minH, FP.PACK.maxH], [pl.dims.d, FP.PACK.minD, FP.PACK.maxD]]) assert(v >= lo && v <= hi, `${k} dims in range`);
  }
});
await check("heritage x gender changes the fit mildly (and the root scale carries the body size)", () => {
  const pl = (k) => FP.packPlacement({ profile: FP.PACK_PROFILES[k] });
  const hm = pl("0x02000001"), hf = pl("0x0200004E"), lm = pl("0x02001A18"), gm = pl("0x02001907"), um = pl("0x02001A0E");
  assert(hf.pos[1] < hm.pos[1] && hf.pos[2] > hm.pos[2], "the female pack sits closer to the spine and higher (her torso)");
  assert(lm.pos[1] > hm.pos[1] && lm.dims.w > hm.dims.w, "the Lugian back is further out and broader");
  assert(gm.pos[1] > 0.27, "the Gear Knight pack clears its back structure");
  assert(um.dims.w <= hm.dims.w, "the Undead pack is the narrowest");
  const ws = humanoidKeys.map((k) => pl(k).dims.w), hs = humanoidKeys.map((k) => pl(k).dims.h);
  assert(Math.max(...ws) / Math.min(...ws) <= 1.6 && Math.max(...hs) / Math.min(...hs) <= 1.5, "mild: <= 1.6x / 1.5x before the root scale");
  assert(FP.PACK_PROFILES["0x02001A18"].scale === 130 && FP.PACK_PROFILES["0x02001A12"].scale === 120, "Lugian root scale 1.3 / 1.2");
});
await check("the straps run from the pack over the shoulder down the chest front", () => {
  for (const k of humanoidKeys) {
    const prof = FP.PACK_PROFILES[k];
    const pl = FP.packPlacement({ profile: prof });
    assert(pl.straps.length === 2, `${k} two straps`);
    for (const line of pl.straps) {
      const top = Math.max(...line.map((p) => p[2]));
      assert(top + pl.pos[2] > prof.torso.top, `${k} over the shoulder top`);
      assert(line.at(-1)[1] + pl.pos[1] < prof.torso.frontY, `${k} ends in front of the chest`);
      assert(Math.abs(line[0][0]) < pl.dims.w / 2, `${k} starts on the pack`);
    }
  }
});
await check("pack geometry: chamfered body + flap, straps; Olthoi fit on its thorax without straps", () => {
  const pl = FP.packPlacement({ profile: FP.PACK_PROFILES["0x02000001"] });
  const g = FP.packGeometry(pl);
  assert(g.body.positions.length % 9 === 0 && g.body.colors.length === g.body.positions.length, "body triangles");
  const bodyTris = g.body.positions.length / 9;
  assert(bodyTris === 6 * 2 + 2 * 4 + 12, `body + flap = 32 triangles, got ${bodyTris}`);
  let xmax = 0, ymin = Infinity, ymax = -Infinity, zmax = 0;
  for (let i = 0; i < g.body.positions.length; i += 3) {
    xmax = Math.max(xmax, Math.abs(g.body.positions[i])); ymin = Math.min(ymin, g.body.positions[i + 1]);
    ymax = Math.max(ymax, g.body.positions[i + 1]); zmax = Math.max(zmax, Math.abs(g.body.positions[i + 2]));
  }
  near(xmax, pl.dims.w / 2, 1e-6, "width"); near(ymin, 0, 1e-6, "front face at y 0"); assert(ymax <= pl.dims.d + 0.021, "depth + flap");
  near(zmax, pl.dims.h / 2, 1e-6, "height");
  assert(g.straps && g.straps.positions.length === 2 * 4 * 4 * 2 * 9, "two 4-segment straps (8 triangles a segment)");
  const ol = FP.packPlacement(FP.resolvePackProfile({ setupId: 0x02001a21, partCount: 25 }));
  assert(ol.kind === "no-hands" && ol.part === 0 && ol.straps === null && FP.packGeometry(ol).straps === null, "Olthoi: thorax, no straps");
  assert(FP.packPlacement(null) === null && FP.packPlacement({ profile: null }) === null, "none");
});

console.log("F5 the canopy clip (retail Falling frames)");
const humanFrames = FP.buildCanopyFrames(FALL_ANIM, { grip: FP.canopyGripFor(FP.PACK_PROFILES["0x02000001"]) });
await check("lead-in starts on the retail Falling frame 0; the seams are exact (enter -> loop, loop -> loop)", () => {
  const np = 34, L = np * 7, fr = humanFrames;
  assert(fr && fr.numParts === 34, "built");
  assert(fr.enterFrames === FP.CANOPY_POSE.leadIn + 22 * FP.CANOPY_POSE.slow + 1, `enter frames ${fr.enterFrames}`);
  assert(fr.loopFrames === FP.CANOPY_POSE.cycles * 22 * FP.CANOPY_POSE.slow + 1, `loop frames ${fr.loopFrames}`);
  let d0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < L; i++) {
    d0 = Math.max(d0, Math.abs(fr.enter[i] - FALL_ANIM.frames[i]));
    s1 = Math.max(s1, Math.abs(fr.enter[(fr.enterFrames - 1) * L + i] - fr.loop[i]));
    s2 = Math.max(s2, Math.abs(fr.loop[(fr.loopFrames - 1) * L + i] - fr.loop[i]));
  }
  assert(d0 < 1e-5, `enter frame 0 = retail frame 0 (${d0})`);
  assert(s1 === 0 && s2 === 0, "seams");
  // and the lead-in has no jump: < 6 cm per 30 fps frame for any part
  let jump = 0;
  for (let f = 1; f < fr.enterFrames; f++) for (let i = 0; i < np; i++) jump = Math.max(jump, dist(partAt(fr.enter, np, f, i).p, partAt(fr.enter, np, f - 1, i).p));
  assert(jump < 0.06, `largest lead-in step ${jump}`);
});
await check("the wrists hold the riser grips beside the head; the joints stay as tight as retail's own", () => {
  const np = 34, fr = humanFrames;
  let maxGap = 0, maxWrist = 0;
  for (let f = 0; f < fr.loopFrames; f++) {
    for (const arm of FP.HUMANOID_FALL_RIG.arms) {
      const U = partAt(fr.loop, np, f, arm.upper), Fo = partAt(fr.loop, np, f, arm.fore), H = partAt(fr.loop, np, f, arm.hand);
      maxGap = Math.max(maxGap, dist(add(U.p, qrot(U.q, [0, 0, -0.325])), add(Fo.p, qrot(Fo.q, [0, 0, 0.141]))));
      maxWrist = Math.max(maxWrist, dist(add(Fo.p, qrot(Fo.q, [0, 0, -0.162])), H.p));
    }
  }
  assert(maxGap < 0.03 && maxWrist < 0.01, `elbow ${maxGap}, wrist ${maxWrist} (retail rest pose: 0.029 / 0.007)`);
  for (const arm of fr.info.arms) {
    assert(arm.wrist[2] > arm.shoulder[2] + 0.1, "wrist above the shoulder");
    assert(Math.abs(arm.wrist[0]) > 0.09 + 0.1, "wrist beside the head (human head half width 0.09)");
    assert(arm.elbow[2] < arm.wrist[2] && arm.elbow[1] > arm.shoulder[1], "elbow below the hand and forward (calm, not a raised arm)");
    assert(Math.sign(arm.wrist[0]) === arm.side, "each hand on its own side");
  }
  // free fall had the arms spread out at the sides: the grip moved the wrists in by > 0.3 m
  const raw = partAt(FALL_ANIM.frames, np, 0, 12).p, grip = fr.info.arms[0].wrist;
  assert(dist(raw, grip) > 0.3, `the hands moved from the spread (${dist(raw, grip)})`);
});
await check("calmer: the legs' flutter shrinks; parts away from the arms keep the (calmed) retail frames", () => {
  const np = 34, src = FALL_ANIM.frames, fr = humanFrames;
  const spread = (frames, n, part) => {
    let lo = Infinity, hi = -Infinity;
    for (let f = 0; f < n; f++) { const y = partAt(frames, np, f, part).p[1]; lo = Math.min(lo, y); hi = Math.max(hi, y); }
    return hi - lo;
  };
  const cyc = 22 * FP.CANOPY_POSE.slow;
  for (const foot of [3, 7]) {
    const a = spread(src, 22, foot), b = spread(fr.loop, cyc, foot);
    assert(b <= a * (1 - FP.CANOPY_POSE.calm) + 1e-4, `foot ${foot} flutter ${a} -> ${b}`);
  }
  // the head part only went through calm + slow (never the arm swing): its frame 0 = lerp(retail 0, mean, calm)
  const mean = [0, 0, 0];
  for (let f = 0; f < 22; f++) { const p = partAt(src, np, f, 16).p; mean[0] += p[0] / 22; mean[1] += p[1] / 22; mean[2] += p[2] / 22; }
  const h0 = partAt(src, np, 0, 16).p, c = FP.CANOPY_POSE.calm;
  const want = [h0[0] + (mean[0] - h0[0]) * c, h0[1] + (mean[1] - h0[1]) * c, h0[2] + (mean[2] - h0[2]) * c];
  assert(dist(partAt(fr.loop, np, 0, 16).p, want) < 1e-5, "head = the calmed retail frame");
});
await check("heritage: a wider head spreads the grip (Tumerok > Lugian > human); clip descriptors via buildClip", () => {
  const g = (k) => FP.canopyGripFor(FP.PACK_PROFILES[k]).out;
  assert(g("0x02001A1A") > g("0x02001A18") && g("0x02001A18") > g("0x02000001"), "grip spread order");
  near(g("0x02000001"), FP.CANOPY_POSE.grip.out, 1e-6, "human = the base grip");
  near(g("0x02001907"), FP.CANOPY_POSE.grip.out, 1e-9, "a narrow (null) head never narrows the grip");
  const tum = FP.buildCanopyFrames(FALL_ANIM, { grip: FP.canopyGripFor(FP.PACK_PROFILES["0x02001A1A"]) });
  assert(Math.abs(tum.info.arms[0].wrist[0]) > Math.abs(humanFrames.info.arms[0].wrist[0]) + 0.05, "Tumerok hands wider");
  const c = FP.buildCanopyClips(FALL_ANIM, {});
  assert(c && c.enter.partCount === 34 && c.enter.framerate === 30 && c.enter.posFrames === null && c.enter.rootFrames === null, "enter descriptor");
  assert(c.loop.numFrames === humanFrames.loopFrames && Math.abs(c.loop.duration - c.loop.numFrames / 30) < 1e-9, "loop descriptor");
  assert(c.enter.segmentAnimIds[0] === 0x030004a9, "tagged with the retail anim");
  assert(FP.buildCanopyFrames(null) === null && FP.buildCanopyFrames({ ...FALL_ANIM, numParts: 25, frames: new Float32Array(22 * 25 * 7) }) === null, "refusals");
  assert(FP.buildCanopyFrames({ ...FALL_ANIM, frames: FALL_ANIM.frames.subarray(7) }) === null, "length mismatch");
});
await check("solveTwoBone keeps the bone lengths and clamps an out-of-reach target", () => {
  const J0 = [0, 0, 0], J1 = [0.3, 0, 0], J2 = [0.6, 0, 0];
  const s = FP.solveTwoBone(J0, J1, J2, [0.1, 0.2, 0.3], [1, 0, -1]);
  near(dist(s.elbow, J0), 0.3, 1e-9, "upper"); near(dist(s.elbow, s.target), 0.3, 1e-9, "fore"); near(dist(s.target, [0.1, 0.2, 0.3]), 0, 1e-9, "reached");
  const far = FP.solveTwoBone(J0, J1, J2, [5, 0, 0], [0, 0, -1]);
  assert(!far.reachable && dist(far.target, J0) < 0.6, "clamped into reach");
});

console.log("F6 the state machine");
await check("bail -> chute -> touchdown -> cleanup; repeats are no-ops", () => {
  const m = FP.createFallPoseMachine();
  const g = 0x50000001;
  const a1 = m.bail(g, 0);
  assert(JSON.stringify(a1) === JSON.stringify([{ type: "pack", mode: "packed" }, { type: "motion", cmd: FP.FALL_MOTION.FALLING }]), "bail");
  assert(m.phase(g) === FP.PHASE.FREEFALL && m.bail(g, 1).length === 0, "free fall; a repeated bail does nothing");
  const a2 = m.chute(g, 10);
  assert(JSON.stringify(a2) === JSON.stringify([{ type: "clip", op: "canopy" }, { type: "pack", mode: "flat" }]), "chute");
  assert(m.phase(g) === FP.PHASE.CANOPY && m.chute(g, 11).length === 0 && m.get(g).bailAt === 0 && m.get(g).chuteAt === 10, "canopy");
  const a3 = m.end(g, "touchdown");
  assert(JSON.stringify(a3) === JSON.stringify([{ type: "clip", op: "stop" }, { type: "motion", cmd: FP.FALL_MOTION.READY }, { type: "pack", mode: "none" }]), "touchdown");
  assert(m.phase(g) === FP.PHASE.IDLE && m.size === 0 && m.end(g).length === 0, "cleaned up");
});
await check("a chute without its bail falls first; gone / seated bodies get no Ready; free fall ends without a clip stop", () => {
  const m = FP.createFallPoseMachine();
  const acts = m.chute(7, 0).map((a) => a.type + ":" + (a.mode ?? a.op ?? a.cmd));
  assert(acts.join(",") === `pack:packed,motion:${FP.FALL_MOTION.FALLING},clip:canopy,pack:flat`, acts.join(","));
  assert(!m.end(7, "gone").some((a) => a.type === "motion"), "gone: nothing to hand back");
  m.bail(8, 0);
  assert(!m.end(8, "seated").some((a) => a.type === "motion"), "seated: the server's Sitting");
  m.bail(9, 0);
  const e = m.end(9, "teleport");
  assert(!e.some((a) => a.type === "clip") && e.some((a) => a.cmd === FP.FALL_MOTION.READY), "free fall end: Ready, no clip");
  assert(m.bail(0).length === 0 && m.chute(0).length === 0, "guid 0 ignored");
});

console.log("F7 the driver (fake EntityManager, real three part groups)");
function makeWorld({ setup = 0x02000001, parts = 34, scale = 1 } = {}) {
  const calls = [];
  const mk = (guid, s = setup, n = parts) => {
    const root = new THREE.Group();
    root.scale.set(scale, scale, scale);
    const ps = [];
    for (let i = 0; i < n; i++) { const g = new THREE.Group(); g.name = `part_${i}`; root.add(g); ps.push(g); }
    return { guid, root, parts: ps, meta: { modelId: s }, lastMotionCommand: FP.FALL_MOTION.READY, _unifiedSeq: null };
  };
  const em = {
    entityMap: new Map(), deathHeld: new Set(), spawnInFlight: new Set(),
    setMotion(guid, cmd, stance, speed) {
      calls.push({ op: "motion", guid, cmd: cmd >>> 0, stance: stance >>> 0, speed });
      const inst = this.entityMap.get(guid >>> 0);
      if (inst) {
        if (inst._unifiedSeq && inst._unifiedSeq.clearOnDone === false) inst._unifiedSeq = null; // a holdFinal clip is cut
        inst.lastMotionCommand = cmd >>> 0;
      }
      return Promise.resolve();
    },
    playLocalClip(guid, desc, opts) {
      calls.push({ op: "play", guid, frames: desc.numFrames, holdFinal: opts?.holdFinal === true });
      const inst = this.entityMap.get(guid >>> 0);
      if (!inst || this.deathHeld.has(guid >>> 0) || desc.partCount !== inst.parts.length) return false;
      inst._unifiedSeq = { desc, localClip: true, clearOnDone: opts?.holdFinal !== true, seq: { globalFrameIndex: 0 } };
      return true;
    },
    stopLocalClip(guid) {
      calls.push({ op: "stop", guid });
      const inst = this.entityMap.get(guid >>> 0);
      if (!inst?._unifiedSeq?.localClip) return false;
      inst._unifiedSeq = null;
      return true;
    },
    isDeathHeld(guid) { return this.deathHeld.has(guid >>> 0); },
    async _resolveHoldingLocation(_sid, key) { return key === 1 ? { partId: 15 } : key === 2 ? { partId: 12 } : null; },
  };
  let t = 100;
  const landed = [], chuted = [];
  const fp = FP.createFallPose({
    liveScene3d: { entityManager: em }, THREE, ground: () => 0, now: () => t,
    loadAnim: async () => FALL_ANIM,
    onLanded: (g) => landed.push(g), onChute: (g) => chuted.push(g),
  });
  return { em, mk, fp, calls, landed, chuted, clock: { get t() { return t; }, set t(v) { t = v; } } };
}
const packOf = (inst) => inst.parts[9].children.find((c) => c.name.startsWith("vehicle-pack-")) ?? null;

await check("bail: Falling (NonCombat, speed 1) and the pack on the chest part (tagged, layer 1, no shadows)", async () => {
  const w = makeWorld();
  const me = w.mk(0x50000001);
  w.em.entityMap.set(me.guid, me);
  assert(w.fp.begin(me.guid, { local: true }) && !w.fp.begin(me.guid), "begun once");
  const mo = w.calls.filter((c) => c.op === "motion");
  assert(mo.length === 1 && mo[0].cmd === FP.FALL_MOTION.FALLING && mo[0].stance === FP.FALL_MOTION.NONCOMBAT && mo[0].speed === 1, "Falling");
  const pk = packOf(me);
  assert(pk && pk.userData.__attachedChildOf === me.guid, "pack on part 9, tagged as an attached child");
  let ok = true;
  pk.traverse((o) => { if (o.layers.mask !== 2 || o.castShadow) ok = false; });
  assert(ok, "layer 1 only, no shadows");
  near(pk.position.y, FP.PACK_PROFILES["0x02000001"].torso.backY + FP.PACK.gap, 1e-6, "on the back");
  const st = w.fp.status().bodies[0];
  assert(st.phase === "freefall" && st.fit === "table" && st.heritage.startsWith("Aluvian") && st.pack.attached, "status");
});
await check("chute: the canopy clip (holdFinal) plays, the pack flattens, the loop re-plays before the end, risers", async () => {
  const w = makeWorld();
  const me = w.mk(0x50000002);
  w.em.entityMap.set(me.guid, me);
  w.fp.begin(me.guid, { local: true });
  await tickAsync(); await tickAsync();
  w.clock.t += 5;
  w.fp.chute(me.guid, { local: true });
  await tickAsync();
  w.fp.tick(1 / 60, w.clock.t);
  const plays = w.calls.filter((c) => c.op === "play");
  assert(plays.length === 1 && plays[0].holdFinal && plays[0].frames === humanFrames.enterFrames, `enter clip played (${JSON.stringify(plays)})`);
  const r1 = w.fp.risers(me.guid), r2 = w.fp.risers(me.guid);
  assert(r1 && r1 === r2 && r1.length === 2 && Object.isFrozen(r1), "risers: one frozen array");
  for (let i = 0; i < 120; i++) { w.clock.t += 1 / 60; w.fp.tick(1 / 60, w.clock.t); }
  const bg = packOf(me).children[0];
  near(bg.scale.y, FP.PACK.flatDepth, 0.02, "flattened (depth)");
  // near the end of the enter clip the loop is re-played (seamless: its first frame = the enter's last)
  me._unifiedSeq.seq.globalFrameIndex = humanFrames.enterFrames - 2;
  w.fp.tick(1 / 60, w.clock.t);
  const plays2 = w.calls.filter((c) => c.op === "play");
  assert(plays2.length === 2 && plays2[1].frames === humanFrames.loopFrames, "loop re-played");
  // a server motion cuts the holdFinal clip: re-played next frame
  w.em.setMotion(me.guid, 0x41000003, FP.FALL_MOTION.NONCOMBAT, 1);
  w.fp.tick(1 / 60, w.clock.t);
  assert(w.calls.filter((c) => c.op === "play").length === 3 && me._unifiedSeq?.localClip, "re-played after a cut");
  assert(w.fp.status().bodies[0].clip.onPlayhead, "status: on the playhead");
});
await check("the held-motion watchdog re-asserts Falling (at most once a second; a commit gets 2.5 s)", async () => {
  const w = makeWorld();
  const me = w.mk(0x50000003);
  w.em.entityMap.set(me.guid, me);
  w.fp.begin(me.guid, { local: true });
  w.fp.tick(1 / 60, w.clock.t); // Falling seen
  me.lastMotionCommand = FP.FALL_MOTION.READY; // a stray Ready replaced it
  w.clock.t += 0.5;
  w.fp.tick(1 / 60, w.clock.t);
  assert(w.calls.filter((c) => c.op === "motion").length === 1, "not within the second");
  w.clock.t += 0.6;
  w.fp.tick(1 / 60, w.clock.t);
  assert(w.calls.filter((c) => c.op === "motion").length === 2 && me.lastMotionCommand === FP.FALL_MOTION.FALLING, "re-issued after 1 s");
  assert(w.fp.stats().reissued === 1, "counted");
  // a death hold: never re-asserted
  w.em.deathHeld.add(me.guid);
  me.lastMotionCommand = 0x40000011;
  w.clock.t += 5;
  w.fp.tick(1 / 60, w.clock.t);
  assert(w.calls.filter((c) => c.op === "motion").length === 2, "no Falling on a corpse");
});
await check("touchdown: clip stopped, Ready (the landing link), pack removed; never Ready on a death hold", async () => {
  const w = makeWorld();
  const me = w.mk(0x50000004);
  w.em.entityMap.set(me.guid, me);
  w.fp.begin(me.guid, { local: true });
  await tickAsync(); await tickAsync();
  w.fp.chute(me.guid, { local: true });
  await tickAsync();
  w.fp.tick(1 / 60, w.clock.t);
  assert(me._unifiedSeq?.localClip, "clip on");
  assert(w.fp.end(me.guid, "touchdown") && !w.fp.has(me.guid), "ended");
  const tail = w.calls.slice(-2);
  assert(tail[0].op === "stop" && tail[1].op === "motion" && tail[1].cmd === FP.FALL_MOTION.READY, `stop then Ready (${JSON.stringify(tail)})`);
  assert(packOf(me) === null && me._unifiedSeq === null, "pack gone, playhead back to the cycle");
  assert(w.fp.status().stats.lastEnd.why === "touchdown" && !w.fp.end(me.guid), "idempotent");
  const dead = w.mk(0x50000005);
  w.em.entityMap.set(dead.guid, dead);
  w.fp.begin(dead.guid);
  w.em.deathHeld.add(dead.guid);
  const n = w.calls.length;
  w.fp.end(dead.guid, "touchdown");
  assert(!w.calls.slice(n).some((c) => c.op === "motion"), "DV-13: no Ready on a death-held rig");
});
await check("a rebuilt rig gets the pack and the motion back; a vanished observed body is dropped", async () => {
  const w = makeWorld();
  const a = w.mk(0x50000006);
  w.em.entityMap.set(a.guid, a);
  w.fp.begin(a.guid);
  const b = w.mk(0x50000006);
  w.em.entityMap.set(a.guid, b);
  w.fp.tick(1 / 60, w.clock.t);
  assert(packOf(b) && !packOf(a), "pack re-parented to the new rig");
  assert(w.calls.filter((c) => c.op === "motion").length === 2 && w.fp.stats().rebinds === 1, "Falling re-issued");
  w.em.entityMap.delete(a.guid);
  w.fp.tick(1 / 60, w.clock.t);
  w.clock.t += 2.5;
  w.fp.tick(1 / 60, w.clock.t);
  assert(!w.fp.has(a.guid) && w.fp.stats().gone === 1, "gone after 2 s");
});
await check("observed bodies: on the ground without a Touchdown event -> landed; slowed without a Chute event -> canopy", async () => {
  const w = makeWorld();
  const o = w.mk(0x50000007);
  w.em.entityMap.set(o.guid, o);
  w.fp.begin(o.guid);
  // free fall at 40 m/s from 300 m, then 5 m/s (a chute whose event never reached us)
  let z = 300;
  for (let i = 0; i < 30; i++) { z -= 40 / 30; o.root.position.z = z; w.clock.t += 1 / 30; w.fp.tick(1 / 30, w.clock.t); }
  assert(w.fp.phase(o.guid) === "freefall", "still free falling");
  for (let i = 0; i < 75; i++) { z -= 5 / 30; o.root.position.z = z; w.clock.t += 1 / 30; w.fp.tick(1 / 30, w.clock.t); }
  assert(w.fp.phase(o.guid) === "canopy" && w.chuted.includes(o.guid) && w.fp.stats().inferredChutes === 1, "chute inferred, canopy opened");
  o.root.position.z = 0.05;
  for (let i = 0; i < 30; i++) { w.clock.t += 1 / 30; w.fp.tick(1 / 30, w.clock.t); }
  assert(!w.fp.has(o.guid) && w.landed.includes(o.guid) && w.fp.stats().landedByGround === 1, "landed by the ground check");
  assert(w.calls.at(-1).op === "motion" && w.calls.at(-1).cmd === FP.FALL_MOTION.READY, "handed back with Ready");
  // a body that stops descending above the terrain (a roof, a floor) ends after 4 s still — never stuck
  const roof = w.mk(0x5000000a);
  w.em.entityMap.set(roof.guid, roof);
  w.fp.begin(roof.guid);
  roof.root.position.z = 12;
  for (let i = 0; i < 90; i++) { w.clock.t += 1 / 30; w.fp.tick(1 / 30, w.clock.t); }
  assert(w.fp.has(roof.guid), "not before 4 s");
  for (let i = 0; i < 40; i++) { w.clock.t += 1 / 30; w.fp.tick(1 / 30, w.clock.t); }
  assert(!w.fp.has(roof.guid) && w.fp.stats().landedStill === 1, "ended still on the roof");
});
await check("rigs: an unknown humanoid takes the human fit after the hands check; Olthoi: pack, no clip; dispose", async () => {
  const w = makeWorld();
  const u = w.mk(0x50000008, 0x02007777, 34);
  w.em.entityMap.set(u.guid, u);
  w.fp.begin(u.guid);
  assert(!packOf(u), "nothing until the hands are confirmed");
  await tickAsync(); await tickAsync();
  const st = w.fp.status().bodies.find((x) => x.guid === u.guid);
  assert(st.fit === "fallback-human" && packOf(u), `human fit (${st.fit})`);
  const ol = w.mk(0x50000009, 0x02001a21, 25);
  w.em.entityMap.set(ol.guid, ol);
  w.fp.begin(ol.guid);
  w.fp.chute(ol.guid);
  await tickAsync();
  w.fp.tick(1 / 60, w.clock.t);
  assert(ol.parts[0].children.some((c) => c.name.startsWith("vehicle-pack-")), "Olthoi pack on the thorax");
  assert(!w.calls.some((c) => c.op === "play" && c.guid === ol.guid), "no canopy clip on a no-hands rig");
  w.fp.dispose();
  assert(!packOf(u) && !ol.parts[0].children.length && w.fp.status().bodies.length === 0, "disposed: all handed back");
  assert(!w.fp.begin(u.guid), "inert after dispose");
});

console.log("F8 the long fall (5 km bail)");
function walkFall({ startAgl, chuteAtTop = false, groundZ = 100 }) {
  const f = { x: 20000, y: 20000, z: groundZ + startAgl, vx: 60, vy: 10, vz: 0, heading: 0.4, chute: chuteAtTop };
  let t = 0, at120 = null, chuteT = chuteAtTop ? 0 : null;
  while (t < 4000) {
    F.stepFall(f, FM.DT);
    t += FM.DT;
    if (!f.chute && f.z - groundZ <= F.FALL.CHUTE_AGL) { f.chute = true; chuteT = t; } // the server's opening rule
    if (at120 === null && t >= 120) at120 = { z: f.z, chute: f.chute };
    if (f.z <= groundZ) break;
  }
  return { t, at120, chuteT, f };
}
await check("a 5 km bail free-falls ~100 s to the 150 m chute and lands at ~116 s (the old fixed 120 s had 4 s to spare)", () => {
  const r = walkFall({ startAgl: 5000 });
  assert(r.chuteT > 95 && r.chuteT < 105, `chute after ${r.chuteT.toFixed(1)} s of free fall`);
  assert(r.t > 110 && r.t < 125, `total ${r.t.toFixed(1)} s`);
  near(r.f.vz, -F.FALL.CHUTE_SINK, 1e-9, "touchdown at the chute sink");
  const bound = FP.fallTimeoutSec(5000 + 100, 100);
  assert(bound > r.t + 600 && bound <= FP.FALL_BOUND.maxSec, `bound ${bound} s`);
});
await check("a 5 km bail with the chute opened at once walks the model far past 120 s (~17 min), inside the bound", () => {
  const r = walkFall({ startAgl: 5000, chuteAtTop: true });
  assert(r.at120 && r.at120.z - 100 > 4000 && r.at120.chute, `at 120 s still ${r.at120 && (r.at120.z - 100).toFixed(0)} m up`);
  assert(r.t > 990 && r.t < 1010, `total ${r.t.toFixed(1)} s`);
  assert(FP.fallTimeoutSec(5100, 100) > r.t + 60, "bound");
  // and opened half-way down (X at 2 km): ~1 min of free fall + ~7 min of drift
  const f = { x: 20000, y: 20000, z: 5100, vx: 0, vy: 0, vz: 0, heading: 0, chute: false };
  let t = 0;
  while (f.z > 100 && t < 4000) { F.stepFall(f, FM.DT); t += FM.DT; if (!f.chute && f.z - 100 <= 2000) f.chute = true; }
  assert(t > 420 && t < 500 && FP.fallTimeoutSec(5100, 100) > t, `X at 2 km: ${t.toFixed(0)} s`);
});
await check("the bound's limits", () => {
  assert(FP.fallTimeoutSec(250, 100) === FP.FALL_BOUND.minSec, "a low bail: the 5 min floor");
  near(FP.fallTimeoutSec(550, 100), (450 + FP.FALL_BOUND.marginM) / F.FALL.CHUTE_SINK + FP.FALL_BOUND.slackSec, 1e-9, "450 m: the slowest descent + margins");
  assert(FP.fallTimeoutSec(1e6, 0) === FP.FALL_BOUND.maxSec, "the 60 min cap");
  assert(FP.fallTimeoutSec(5100, NaN) >= FP.fallTimeoutSec(5100, 100), "unknown terrain counts as sea level (longer)");
  assert(FP.fallTimeoutSec(NaN, NaN) === FP.FALL_BOUND.minSec, "junk");
});
await check("index.js ends the fall on the bound / a teleport, not a fixed 120 s; fall_model's world edge = landblock 0xFE", () => {
  const src = readFileSync(join(HERE, "../scene3d/vehicle/index.js"), "utf8");
  assert(!/startedAt\s*>\s*120\b/.test(src), "no fixed 120 s timeout");
  assert(/fall\.maxSec\s*=\s*fallTimeoutSec\(/.test(src) && /f\.startedAt\s*>\s*f\.maxSec/.test(src), "the bound");
  assert(/portalSpaceOwnsFrame\(\)\)\s*\{[^}]*stopFall\("teleport"\)/.test(src), "a teleport ends it");
  const f = { x: 255 * 192 + 50, y: 10, z: 500, vx: 100, vy: 0, vz: 0, heading: 0, chute: false };
  F.stepFall(f, FM.DT);
  near(f.x, 255 * 192 - 0.5, 1e-9, "clamped inside landblock 0xFE");
});

console.log("F9 the canopy's lines (chute.js)");
await check("risers: 8 lines to the two grips + 2 riser straps; none: 8 lines to the harness; body ends never scale", () => {
  const rs = [{ grip: [-0.22, 0.09, 1.9], shoulder: [-0.21, 0.03, 1.7] }, { grip: [0.22, 0.09, 1.9], shoulder: [0.2, 0.04, 1.7] }];
  const seg = C.lineSegments(0.3, 0.3, rs);
  assert(seg.length === (C.CANOPY.lines + 2) * 6, "10 segments");
  for (let i = 0; i < C.CANOPY.lines; i++) {
    const x = seg[i * 6], end = [seg[i * 6 + 3], seg[i * 6 + 4], seg[i * 6 + 5]];
    const want = x < -1e-9 || (Math.abs(x) <= 1e-9 && seg[i * 6 + 1] < 0) ? rs[0].grip : rs[1].grip;
    assert(dist(end, want) < 1e-6, `line ${i} to its side's grip`);
    near(seg[i * 6 + 2], C.CANOPY.rise * 0.3, 1e-6, "rim end scales with the dome");
  }
  assert(dist([seg[48], seg[49], seg[50]], rs[0].grip) < 1e-6 && dist([seg[51], seg[52], seg[53]], rs[0].shoulder) < 1e-6, "left riser strap");
  const plain = C.lineSegments(1, 1, null);
  assert(plain.length === C.CANOPY.lines * 6 && plain[5] === C.CANOPY.harness, "the single harness");
  // the fall pose's grips are where the canopy pose puts the hands
  const g0 = humanFrames.info.arms[0].gripPoint;
  assert(g0[2] > 1.8 && g0[2] < 2.0 && g0[0] < -0.15, `human left grip ${g0.map((v) => v.toFixed(2))}`);
});

console.log(`\nvehicle_fall_pose: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

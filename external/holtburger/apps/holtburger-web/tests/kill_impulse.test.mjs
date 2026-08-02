// kill_impulse.test.mjs — death ragdolls must fall FROM THE KILL, and never
// all the same way.
//
// 2026-08-02. `entities.js` armed the ragdoll with `startRagdoll(inst)` — no
// opts — so ragdoll.js fell through to `dx = 1, dy = 0` and seeded the impulse
// as [RAGDOLL_IMPULSE, 0, …]. That made `initSim`'s "no direction ⇒ random
// yaw" branch UNREACHABLE (the impulse XY was never zero) and every creature
// in the world toppled toward MODEL +X with ±0.45 rad of jitter: measured on
// the pre-fix module, 200 deaths landed in 2 of 8 azimuth bins (101/0/0/0/0/0/
// 0/99). This suite pins both halves of the fix — the resolver reads the real
// blow, and the fallback is genuinely spread.
//
// Run: node tests/kill_impulse.test.mjs   (from apps/holtburger-web/)

import {
  yawFromQuat,
  rotZ,
  hash32,
  mulberry32,
  quadrantPushModel,
  quadrantPushWorld,
  recencyWeight,
  blendHits,
  pickFallStyle,
  resolveKillImpulse,
  noteHit,
  noteSplatterHit,
  noteAttackerHit,
  noteProjectileImpact,
  projectileNear,
  hitsFor,
  forgetKillImpulse,
  FALL_STYLES,
  KILL_HIT_TTL_MS,
  KILL_MAX_HITS_PER_GUID,
} from "../scene3d/kill_impulse.js";
import { SPLATTER_DECODE_TABLE, decodeSplatterId } from "../scene3d/splatter_decode.js";

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.error("  FAIL:", msg);
  }
}
function section(n) {
  console.log(`\n— ${n}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
/** Smallest signed angle a→b. */
function angDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/* ── 1. frame math ────────────────────────────────────────────────────── */
section("frame math");
{
  // Yaw-only AC quaternion: (0, 0, sin(θ/2), cos(θ/2)).
  for (const th of [0, 0.7, Math.PI / 2, 2.5, -1.3]) {
    const q = { x: 0, y: 0, z: Math.sin(th / 2), w: Math.cos(th / 2) };
    ok(near(angDiff(th, yawFromQuat(q.x, q.y, q.z, q.w)), 0, 1e-9), `yawFromQuat recovers ${th}`);
  }
  const [rx, ry] = rotZ(1, 0, Math.PI / 2);
  ok(near(rx, 0, 1e-9) && near(ry, 1, 1e-9), "rotZ(+X, 90°) = +Y");
  const back = rotZ(rx, ry, -Math.PI / 2);
  ok(near(back[0], 1, 1e-9) && near(back[1], 0, 1e-9), "rotZ is its own inverse at −θ");
  ok(hash32(1, 2) !== hash32(2, 1), "hash32 is order-sensitive");
  ok(hash32(0x1234, 99) === hash32(0x1234, 99), "hash32 is stable");
}

/* ── 2. splatter quadrant → push direction ────────────────────────────── */
section("splatter quadrant decodes to a push AWAY from the wound");
{
  let checked = 0;
  for (const idKey of Object.keys(SPLATTER_DECODE_TABLE)) {
    const id = Number(idKey);
    const d = decodeSplatterId(id);
    const push = quadrantPushModel(d);
    ok(push !== null, `0x${id.toString(16)} decodes`);
    // A wound on the LEFT (model −X) must push the body RIGHT (+X), and a
    // FRONT wound (model +Y) must push it BACK (−Y).
    ok(d.left ? push[0] > 0 : push[0] < 0, `0x${id.toString(16)} (${d.name}) pushes off the struck side`);
    ok(d.front ? push[1] < 0 : push[1] > 0, `0x${id.toString(16)} (${d.name}) pushes off the struck face`);
    ok(near(Math.hypot(push[0], push[1]), 1, 1e-6), `0x${id.toString(16)} push is a unit vector`);
    checked++;
  }
  ok(checked === 12, `all 12 Splatter IDs covered (got ${checked})`);
  // Non-splatter IDs (the adjacent Spark family) decode to nothing.
  ok(quadrantPushModel(decodeSplatterId(0x67)) === null, "Spark 0x67 yields no push");
}
{
  // World lift: a front-left wound on a body facing +X (yaw = −90° from the
  // model's +Y forward) must push in the world direction the yaw implies.
  const d = decodeSplatterId(0x5c); // LowLeftFront
  const m = quadrantPushModel(d);
  for (const yaw of [0, 0.9, -2.2, Math.PI]) {
    const w = quadrantPushWorld(d, yaw);
    const expect = rotZ(m[0], m[1], yaw);
    ok(near(w[0], expect[0], 1e-9) && near(w[1], expect[1], 1e-9), `quadrantPushWorld matches rotZ at yaw ${yaw}`);
  }
}

/* ── 3. blending ──────────────────────────────────────────────────────── */
section("hit blending");
{
  ok(recencyWeight(0) === 1, "a fresh hit weighs 1");
  ok(near(recencyWeight(1500), 0.5, 1e-9), "a hit at the half-life weighs 0.5");
  ok(recencyWeight(KILL_HIT_TTL_MS) === 0, "a hit past the TTL weighs 0");

  const now = 10000;
  const agreeing = [
    { dx: 1, dy: 0, ts: now, source: "attacker" },
    { dx: 0.98, dy: 0.2, ts: now - 100, source: "splatter" },
  ];
  const b1 = blendHits(agreeing, now);
  ok(b1 && b1.confidence > 0.95, `agreeing hits are high-confidence (${b1?.confidence.toFixed(3)})`);
  ok(b1 && Math.abs(angDiff(0, Math.atan2(b1.dy, b1.dx))) < 0.2, "agreeing hits blend to their mean");

  const opposing = [
    { dx: 1, dy: 0, ts: now, source: "splatter" },
    { dx: -1, dy: 0, ts: now, source: "splatter" },
  ];
  ok(blendHits(opposing, now) === null || blendHits(opposing, now).confidence < 0.05,
    "opposing hits cancel to (near) zero confidence");

  ok(blendHits([], now) === null, "no hits ⇒ null");
  ok(blendHits([{ dx: 0, dy: 0, ts: now, source: "splatter" }], now) === null, "a zero vector is ignored");
  ok(blendHits([{ dx: 1, dy: 0, ts: now - KILL_HIT_TTL_MS - 1, source: "attacker" }], now) === null,
    "expired hits are ignored");

  // Source weighting: a projectile outranks a splatter when they disagree.
  const mixed = [
    { dx: 1, dy: 0, ts: now, source: "projectile" },
    { dx: 0, dy: 1, ts: now, source: "splatter" },
  ];
  const b2 = blendHits(mixed, now);
  ok(b2.dx > b2.dy, "the projectile direction dominates a same-age splatter");
  ok(b2.source === "projectile", "the winning source is reported");

  const critMix = [{ dx: 1, dy: 0, ts: now, source: "attacker", critical: true }];
  ok(blendHits(critMix, now).critical === true, "crit flags propagate through the blend");
}

/* ── 4. fall styles ───────────────────────────────────────────────────── */
section("fall styles");
{
  const total = FALL_STYLES.reduce((a, s) => a + s.p, 0);
  ok(near(total, 1, 1e-9), `style weights sum to 1 (got ${total})`);
  ok(FALL_STYLES.every((s) => s.topple > 0 && s.twist >= 0 && s.spread > 0), "every style has usable knobs");
  ok(pickFallStyle(0).name === FALL_STYLES[0].name, "roll 0 draws the first style");
  ok(pickFallStyle(0.999999).name === FALL_STYLES[FALL_STYLES.length - 1].name, "roll ~1 draws the last style");
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(pickFallStyle(i / 2000).name);
  ok(seen.size === FALL_STYLES.length, `a uniform sweep reaches every style (${seen.size}/${FALL_STYLES.length})`);
}

/* ── 5. THE regression: the unknowable kill is still well spread ───────── */
section("fallback azimuths are spread, not canned (400 seeded deaths)");
{
  const bins = new Array(8).fill(0);
  for (let i = 0; i < 400; i++) {
    const r = resolveKillImpulse({ guid: 0x50000000 + i * 7, nowMs: 1000 + i * 137, yaw: 0, hits: [] });
    const a = Math.atan2(r.worldDir[1], r.worldDir[0]);
    bins[Math.floor(((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8]++;
  }
  console.log("    azimuth histogram (8 bins):", bins.join(","));
  const min = Math.min(...bins);
  const max = Math.max(...bins);
  ok(bins.every((b) => b > 0), "every 45° sector is used");
  ok(min >= 400 / 8 / 2.2, `no sector is starved (min ${min}, uniform would be 50)`);
  ok(max <= (400 / 8) * 2.2, `no sector dominates (max ${max}, uniform would be 50)`);
  // The pre-fix module put 200/200 into 2 bins; assert we are nowhere near that.
  const occupied2 = bins.slice().sort((a, b) => b - a).slice(0, 2).reduce((a, b) => a + b, 0);
  ok(occupied2 < 400 * 0.45, `the top two sectors hold < 45% of deaths (got ${((occupied2 / 400) * 100).toFixed(1)}%)`);
}

/* ── 6. a KNOWN attack direction actually steers the fall ──────────────── */
section("attack bearing steers the fall (200 seeded kills, varied bearings)");
{
  let worst = 0;
  let sum = 0;
  const bins = new Array(8).fill(0);
  for (let i = 0; i < 200; i++) {
    const bearing = (i / 200) * Math.PI * 2; // attacker→victim direction
    const r = resolveKillImpulse({
      guid: 0x60000000 + i * 13,
      nowMs: 5000 + i * 91,
      yaw: 0,
      hits: [
        { dx: Math.cos(bearing), dy: Math.sin(bearing), ts: 5000 + i * 91, source: "attacker" },
        { dx: Math.cos(bearing), dy: Math.sin(bearing), ts: 4900 + i * 91, source: "splatter" },
      ],
    });
    const got = Math.atan2(r.worldDir[1], r.worldDir[0]);
    // `rotate` styles deliberately turn the fall (sidefall ±90°, backflop 180°)
    // — measure the error against the style's own intent.
    const style = FALL_STYLES.find((s) => s.name === r.style);
    const err = Math.abs(angDiff(bearing + style.rotate, got));
    sum += err;
    if (err > worst) worst = err;
    bins[Math.floor(((got + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8]++;
  }
  console.log(`    mean |err| = ${((sum / 200) * 57.3).toFixed(1)}°, worst = ${(worst * 57.3).toFixed(1)}°`);
  console.log("    resulting azimuth histogram:", bins.join(","));
  ok(sum / 200 < 0.02, `a confident read follows the bearing (mean err ${((sum / 200) * 57.3).toFixed(2)}°)`);
  ok(worst < 0.05, "no confident read wanders off its bearing");
  ok(bins.every((b) => b > 0), "varied bearings still fill every sector");
}

/* ── 7. model-space conversion ────────────────────────────────────────── */
section("world → model conversion");
{
  for (const yaw of [0, 0.6, -1.9, Math.PI]) {
    const r = resolveKillImpulse({
      guid: 0x1111,
      nowMs: 42,
      yaw,
      hits: [{ dx: 1, dy: 0, ts: 42, source: "projectile" }],
    });
    const expect = rotZ(r.worldDir[0], r.worldDir[1], -yaw);
    ok(near(r.dir[0], expect[0], 1e-9) && near(r.dir[1], expect[1], 1e-9), `model dir = world dir rotated by −yaw (${yaw})`);
    ok(near(Math.hypot(r.dir[0], r.dir[1]), 1, 1e-9), "model dir is a unit vector");
  }
}

/* ── 8. determinism + style knobs ─────────────────────────────────────── */
section("determinism");
{
  const mk = () => resolveKillImpulse({ guid: 0xabcdef, nowMs: 777, yaw: 0.3, hits: [] });
  const a = mk();
  const b = mk();
  ok(a.seed === b.seed && a.style === b.style, "same guid+timestamp ⇒ same seed and style");
  ok(a.dir[0] === b.dir[0] && a.dir[1] === b.dir[1], "same guid+timestamp ⇒ same direction");
  const c = resolveKillImpulse({ guid: 0xabcdef, nowMs: 778, yaw: 0.3, hits: [] });
  ok(c.seed !== a.seed, "one millisecond later is a different death");
  ok(a.toppleScale > 0 && a.twistScale >= 0 && a.dirJitter > 0, "style knobs are exported for initSim");
}

/* ── 9. victim momentum ───────────────────────────────────────────────── */
section("victim momentum");
{
  // A creature sprinting +Y that dies with no attack information should carry
  // its momentum, not fall at a seeded azimuth unrelated to its run.
  let carried = 0;
  for (let i = 0; i < 200; i++) {
    const r = resolveKillImpulse({
      guid: 0x70000000 + i,
      nowMs: 100 + i,
      yaw: 0,
      motion: { vx: 0, vy: 4 },
      hits: [],
    });
    const a = Math.atan2(r.worldDir[1], r.worldDir[0]);
    if (Math.abs(angDiff(Math.PI / 2, a)) < Math.PI / 3) carried++;
  }
  console.log(`    ${carried}/200 falls leaned into the run direction`);
  ok(carried >= 60, `momentum visibly biases the fall (${carried}/200)`);
  ok(carried <= 175, `momentum does NOT collapse the spread (${carried}/200)`);
  // Below the speed floor it must not bias at all.
  const slow = resolveKillImpulse({ guid: 9, nowMs: 9, yaw: 0, motion: { vx: 0, vy: 0.2 }, hits: [] });
  const bare = resolveKillImpulse({ guid: 9, nowMs: 9, yaw: 0, hits: [] });
  ok(slow.worldDir[0] === bare.worldDir[0], "a crawling creature's velocity is ignored");
}

/* ── 10. runtime rings ────────────────────────────────────────────────── */
section("runtime rings");
{
  forgetKillImpulse();
  ok(noteHit(0x1234, 1, 0, { ts: 1000 }), "noteHit records");
  ok(!noteHit(0x1234, 0, 0, { ts: 1000 }), "a zero direction is rejected");
  ok(!noteHit(0, 1, 0, { ts: 1000 }), "guid 0 is rejected");
  for (let i = 0; i < KILL_MAX_HITS_PER_GUID + 4; i++) noteHit(0x1234, 1, 0, { ts: 1000 + i });
  ok(hitsFor(0x1234).length === KILL_MAX_HITS_PER_GUID, `per-guid ring is capped at ${KILL_MAX_HITS_PER_GUID}`);

  forgetKillImpulse();
  const q = { x: 0, y: 0, z: 0, w: 1 }; // yaw 0
  ok(noteSplatterHit(0x99, decodeSplatterId(0x5c), q, { ts: 500 }), "noteSplatterHit records");
  const h = hitsFor(0x99)[0];
  const expect = quadrantPushModel(decodeSplatterId(0x5c));
  ok(near(h.dx, expect[0], 1e-6) && near(h.dy, expect[1], 1e-6), "splatter push stored in the world frame");
  ok(!noteSplatterHit(0x99, null, q), "a non-splatter script records nothing");

  forgetKillImpulse();
  noteAttackerHit(0x77, 0, 0, 3, 4, { ts: 10 });
  const a = hitsFor(0x77)[0];
  ok(near(a.dx, 0.6, 1e-9) && near(a.dy, 0.8, 1e-9), "attacker→victim is normalised");
  ok(a.source === "attacker", "attacker hits are tagged");

  forgetKillImpulse();
  ok(noteProjectileImpact(10, 10, 1, 0, 2000), "projectile impacts record");
  ok(projectileNear(10.5, 10.2, 2100) !== null, "a nearby impact correlates");
  ok(projectileNear(40, 40, 2100) === null, "a distant impact does not");
  ok(projectileNear(10.5, 10.2, 2000 + 99999) === null, "a stale impact does not");
  forgetKillImpulse();
}

console.log(`\nkill_impulse: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

// WS02 (2026-07-12) — the LOCAL cast-gesture KIND_MOTION echo is swallowed when
// the client already predicted it, and plays as the sole animator otherwise.
// Pure JS — replicates the exact note/consume machinery (entities.js
// noteLocalSwingPrediction/consumeLocalSwingEcho, ~L6649-6667) and the Patch-B
// gate from scene3d/loop.js `_armMotion`, then asserts against the REAL
// data/spell-cast-sequence.json. No wasm/three.js/browser needed.
//
// Run: node tests/test_ws02_cast_echo_dedup.mjs   (from apps/holtburger-web/)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

let fail = 0;
const assert = (cond, msg) => { if (!cond) { fail++; console.log("FAIL:", msg); } };

// --- Mirror of entities.js note/consume (kept in lock-step) ------------------
// noteLocalSwingPrediction stores the FULL 32-bit command (0x40-class for a cast
// gesture) with a ~500ms expiry; consumeLocalSwingEcho returns true (and deletes)
// only for the local guid when the full command was noted within the window.
function makeEcho(localGuid, nowRef) {
  const map = new Map();
  return {
    note(cmd) {
      const c = (cmd >>> 0) || 0;
      if (c === 0) return;
      map.set(c, nowRef.t + 500);
    },
    consume(guid, cmd) {
      if ((guid >>> 0) !== (localGuid >>> 0)) return false;
      const c = (cmd >>> 0) || 0;
      const expiry = map.get(c);
      if (expiry == null) return false;
      map.delete(c);
      return nowRef.t <= expiry;
    },
  };
}

// --- Mirror of the Patch-B gate (scene3d/loop.js `_armMotion`) ----------------
// Returns { setMotion } — how many redundant setMotion the echo would fire on the
// KIND_MOTION path (0 = swallowed, 1 = played). Also records stanceKept.
const isLocalPredictedCastGestureLow = (low) => low >= 0x2b && low <= 0x39;
function armMotionEcho({ CAST_GESTURE_PARITY_ON, echo, motionGuid, localGuid, motionCmd, st }) {
  const out = { setMotion: 0, stanceKept: false, swallowed: false };
  const isLocal = (motionGuid >>> 0) === (localGuid >>> 0);
  if (CAST_GESTURE_PARITY_ON && isLocal) {
    const low = motionCmd & 0xffff;
    if (isLocalPredictedCastGestureLow(low)) {
      const fullGesture = (0x40000000 | low) >>> 0;
      if (echo.consume(motionGuid, fullGesture)) {
        out.swallowed = true;
        if (st !== 0) out.stanceKept = true; // setLocalStance (not a motion_command play)
        return out; // early-return: NO redundant setMotion
      }
      // fall through — echo becomes the single animation source
    }
  }
  // forceLocal path would fire setMotion for the cast gesture on the local rig
  out.setMotion = 1;
  return out;
}

// === T1: predicted cast-gesture echo is deduped → 0 redundant setMotion =======
{
  const nowRef = { t: 1000 };
  const localGuid = 0x50000123 >>> 0;
  const echo = makeEcho(localGuid, nowRef);
  // Chain predicted MagicBlast 0x4000002B (playCastSequence noted the FULL cmd).
  echo.note(0x4000002b);
  // Echo arrives on KIND_MOTION as the RAW low16 0x2B for the local guid.
  const r = armMotionEcho({
    CAST_GESTURE_PARITY_ON: true, echo, motionGuid: localGuid, localGuid,
    motionCmd: 0x0000002b, st: 0x0049,
  });
  assert(r.setMotion === 0, "T1: predicted echo deduped → 0 redundant setMotion");
  assert(r.swallowed === true && r.stanceKept === true, "T1: echo swallowed, server stance kept");
  if (!fail) console.log("PASS T1: predicted cast-gesture echo deduped (0 redundant setMotion), stance kept.");
}

// === T2: un-predicted gesture (busy-window/table-miss) falls through → plays ===
{
  const nowRef = { t: 1000 };
  const localGuid = 0x50000123 >>> 0;
  const echo = makeEcho(localGuid, nowRef); // nothing noted (early-returned chain)
  const r = armMotionEcho({
    CAST_GESTURE_PARITY_ON: true, echo, motionGuid: localGuid, localGuid,
    motionCmd: 0x0000002b, st: 0x0049,
  });
  assert(r.setMotion === 1 && r.swallowed === false,
    "T2: un-predicted gesture plays (single-source fallback, never silent)");
  if (!fail) console.log("PASS T2: un-predicted gesture falls through → echo is the sole animator.");
}

// === T2b: note expired (very high RTT) also falls through → plays =============
{
  const nowRef = { t: 1000 };
  const localGuid = 0x50000123 >>> 0;
  const echo = makeEcho(localGuid, nowRef);
  echo.note(0x4000002b);
  nowRef.t = 1600; // 600ms later > 500ms window
  const r = armMotionEcho({
    CAST_GESTURE_PARITY_ON: true, echo, motionGuid: localGuid, localGuid,
    motionCmd: 0x0000002b, st: 0x0049,
  });
  assert(r.setMotion === 1, "T2b: expired note falls through → echo plays (fail-open, no NEW bug)");
  if (!fail) console.log("PASS T2b: expired prediction note → echo plays (fail-open).");
}

// === T3: remote guid never gated (remote casters need the echo) ===============
{
  const nowRef = { t: 1000 };
  const localGuid = 0x50000123 >>> 0;
  const remoteGuid = 0x50000999 >>> 0;
  const echo = makeEcho(localGuid, nowRef);
  echo.note(0x4000002b); // even if the LOCAL player had a note...
  const r = armMotionEcho({
    CAST_GESTURE_PARITY_ON: true, echo, motionGuid: remoteGuid, localGuid,
    motionCmd: 0x0000002b, st: 0x0049,
  });
  assert(r.setMotion === 1 && r.swallowed === false, "T3: remote echo never swallowed");
  if (!fail) console.log("PASS T3: remote caster echo never touched.");
}

// === T3b: flag off → byte-identical (echo always plays for local) =============
{
  const nowRef = { t: 1000 };
  const localGuid = 0x50000123 >>> 0;
  const echo = makeEcho(localGuid, nowRef);
  echo.note(0x4000002b);
  const r = armMotionEcho({
    CAST_GESTURE_PARITY_ON: false, echo, motionGuid: localGuid, localGuid,
    motionCmd: 0x0000002b, st: 0x0049,
  });
  assert(r.setMotion === 1 && r.swallowed === false, "T3b: flag off → echo plays (pre-patch)");
  if (!fail) console.log("PASS T3b: castGestureParity=off is byte-identical (echo plays).");
}

// === T4: windups + locomotion excluded from the band =========================
{
  const outOfBand = [0x0070, 0x0072, 0x0074, 0x0076, 0x0078, 0x0132, // windups
    0x0003, 0x0004, 0x0005, 0x0006, 0x0007, 0x0008]; // locomotion
  for (const low of outOfBand) {
    assert(!isLocalPredictedCastGestureLow(low),
      `T4: low 0x${low.toString(16)} must be OUTSIDE the cast-gesture band`);
    // and a matching local echo must still play (not swallowed)
    const nowRef = { t: 1000 };
    const localGuid = 0x50000123 >>> 0;
    const echo = makeEcho(localGuid, nowRef);
    echo.note((0x40000000 | low) >>> 0);
    const r = armMotionEcho({
      CAST_GESTURE_PARITY_ON: true, echo, motionGuid: localGuid, localGuid,
      motionCmd: low, st: 0x0049,
    });
    assert(r.swallowed === false, `T4: out-of-band low 0x${low.toString(16)} not swallowed`);
  }
  if (!fail) console.log("PASS T4: windups (0x70..0x132) + locomotion (0x03..0x08) excluded from the band.");
}

// === T5: low16 → full 0x40-class expansion matches the JSON's stored full cmds =
{
  const d = JSON.parse(readFileSync(join(__dirname, "..", "data", "spell-cast-sequence.json"), "utf8")).sequences;
  const toU = (m) => { const s = String(m); return (s.startsWith("0x") ? parseInt(s, 16) : parseInt(s, 10)) >>> 0; };
  let checked = 0;
  for (const k in d) {
    const cg = d[k].castGesture;
    if (!cg || !cg.motion) continue;
    const full = toU(cg.motion);
    const low = full & 0xffff;
    const expanded = (0x40000000 | low) >>> 0;
    assert(expanded === full,
      `T5: expand(0x${low.toString(16)}) must equal stored 0x${full.toString(16)}`);
    checked++;
    if (checked >= 200) break; // sample; T6 scans all anyway
  }
  if (!fail) console.log(`PASS T5: low16→0x40-class expansion matches stored full commands (${checked} sampled).`);
}

// === T6: the band [0x2B,0x39] covers EVERY cast gesture and NO windup =========
{
  const d = JSON.parse(readFileSync(join(__dirname, "..", "data", "spell-cast-sequence.json"), "utf8")).sequences;
  const toU = (m) => { const s = String(m); return (s.startsWith("0x") ? parseInt(s, 16) : parseInt(s, 10)) >>> 0; };
  let casts = 0, windups = 0, castOob = 0, windInBand = 0, nonMagicClass = 0;
  for (const k in d) {
    const e = d[k];
    if (e.castGesture && e.castGesture.motion) {
      const u = toU(e.castGesture.motion);
      casts++;
      if ((u & 0xf0000000) !== 0x40000000) nonMagicClass++;
      const low = u & 0xffff;
      if (!isLocalPredictedCastGestureLow(low)) castOob++;
    }
    for (const g of (e.windupGestures || [])) {
      const low = toU(g.motion) & 0xffff;
      windups++;
      if (isLocalPredictedCastGestureLow(low)) windInBand++;
    }
  }
  assert(castOob === 0, `T6: every cast gesture in [0x2B,0x39] (got ${castOob} out-of-band)`);
  assert(nonMagicClass === 0, `T6: every cast gesture is class 0x40 (got ${nonMagicClass} off-class)`);
  assert(windInBand === 0, `T6: NO windup falls in the cast band (got ${windInBand})`);
  assert(casts > 6000 && windups > 7000, `T6: scanned the full JSON (${casts} casts / ${windups} windups)`);
  if (!fail) console.log(`PASS T6: band [0x2B,0x39] covers all casts / no windups (${casts} casts / ${windups} windups).`);
}

console.log(fail ? "FAIL" : "ALL PASS");
process.exit(fail ? 1 : 0);

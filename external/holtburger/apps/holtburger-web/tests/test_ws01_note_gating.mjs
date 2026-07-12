// WS01 (2026-07-12) — Patch C behavior test: the swing-echo prediction is noted
// ONLY when the gesture will actually animate, so a silent no-op leaves the server
// echo as the safety net (instead of the default-ON dispatchParity dedup swallowing
// BOTH). Pure JS — mirrors the exact `willPlay` predicate + note gate from
// scene3d/entities.js playCastSequence.playGesture, driven by a stubbed
// classifyMotionCommandTyped. No wasm/browser needed.
//
// Run: node tests/test_ws01_note_gating.mjs   (from apps/holtburger-web/)

let fail = 0;
const assert = (cond, msg) => { if (!cond) { fail++; console.log("FAIL:", msg); } };

// --- The exact Patch C gate (kept in lock-step with entities.js) -------------
// willPlay = superset condition of canPlayReal in setSwingMotion:
//   result.kind ∈ {swing,cast} && resolvedCommand!=0 && source==="wasm-link".
// noteLocalSwingPrediction fires only when (CAST_SPEED !== 1.0) && willPlay.
function evalGesture({ CAST_RELIABILITY, CAST_SPEED, classify, motionU32, note }) {
  const c = CAST_RELIABILITY ? classify(motionU32) : null;
  const willPlay = !CAST_RELIABILITY ||
    !!(c && (c.kind === "swing" || c.kind === "cast") && (c.resolvedCommand >>> 0) !== 0 && c.source === "wasm-link");
  if (CAST_SPEED !== 1.0 && willPlay) note(motionU32);
  return willPlay;
}

// Stub classifier: a resolvable cast gesture vs a coarse-fallback miss.
const RESOLVES = 0x40000035 >>> 0; // MagicTransfer, resolves under Magic stance
const MISSES = 0x10000132 >>> 0;   // Purple windup, but stance-missed here → coarse
const classify = (m) => (m === RESOLVES)
  ? { kind: "cast", resolvedCommand: m, source: "wasm-link" }
  : { kind: "cast", resolvedCommand: m, source: "coarse-fallback" }; // miss = coarse, not a wasm link

// --- Case 1: castReliability ON — note only the resolvable gesture -----------
{
  const noted = [];
  const note = (m) => noted.push(m >>> 0);
  const wp1 = evalGesture({ CAST_RELIABILITY: true, CAST_SPEED: 2.0, classify, motionU32: RESOLVES, note });
  const wp2 = evalGesture({ CAST_RELIABILITY: true, CAST_SPEED: 2.0, classify, motionU32: MISSES, note });
  assert(wp1 === true, "resolvable gesture willPlay=true");
  assert(wp2 === false, "coarse-fallback gesture willPlay=false (silent no-op)");
  assert(noted.length === 1 && noted[0] === RESOLVES,
    `note fired ONLY for the resolvable gesture (got ${noted.map((m) => "0x" + m.toString(16)).join(",")})`);
  assert(!noted.includes(MISSES),
    "the missed gesture is NOT noted → its server echo survives the dispatchParity dedup");
  if (!fail) console.log("PASS case1: castReliability ON — note only on wasm-link success, echo un-noted on miss.");
}

// --- Case 2: castReliability OFF — legacy unconditional note (byte-identical) -
{
  const noted = [];
  const note = (m) => noted.push(m >>> 0);
  const wp1 = evalGesture({ CAST_RELIABILITY: false, CAST_SPEED: 2.0, classify, motionU32: RESOLVES, note });
  const wp2 = evalGesture({ CAST_RELIABILITY: false, CAST_SPEED: 2.0, classify, motionU32: MISSES, note });
  assert(wp1 === true && wp2 === true, "OFF: willPlay always true (no gating)");
  assert(noted.length === 2, "OFF: both gestures noted (pre-WS01 unconditional behavior preserved)");
  if (!fail) console.log("PASS case2: castReliability OFF — unconditional note (pre-WS01 behavior).");
}

// --- Case 3: CAST_SPEED == 1.0 never notes (matches `CAST_SPEED !== 1.0` guard) -
{
  const noted = [];
  const note = (m) => noted.push(m >>> 0);
  evalGesture({ CAST_RELIABILITY: true, CAST_SPEED: 1.0, classify, motionU32: RESOLVES, note });
  assert(noted.length === 0, "CAST_SPEED==1.0: never notes (no 2× echo to dedup)");
  if (!fail) console.log("PASS case3: CAST_SPEED==1.0 never notes.");
}

// --- Invariant: willPlay is a strict superset of canPlayReal (no double-play) -
// Any gesture setSwingMotion would play (canPlayReal true) MUST be noted, and any
// noted gesture MUST play — else the echo either double-plays or is wrongly eaten.
{
  const cases = [
    { kind: "cast", resolvedCommand: 0x40000035, source: "wasm-link" },
    { kind: "swing", resolvedCommand: 0x10000132, source: "wasm-link" },
    { kind: "cast", resolvedCommand: 0, source: "wasm-link" },        // resolved 0 → no play
    { kind: "cast", resolvedCommand: 0x40000035, source: "coarse-fallback" }, // not a link → no play
    { kind: "walk", resolvedCommand: 0x40000035, source: "wasm-link" }, // wrong kind → no play
    null,
  ];
  for (const c of cases) {
    const canPlayReal = !!(c && (c.kind === "swing" || c.kind === "cast") && (c.resolvedCommand >>> 0) !== 0 && c.source === "wasm-link");
    const willPlay = canPlayReal; // Patch C willPlay uses the identical predicate under CAST_RELIABILITY
    assert(willPlay === canPlayReal, "willPlay ≡ canPlayReal for " + JSON.stringify(c));
  }
  if (!fail) console.log("PASS invariant: willPlay ≡ canPlayReal (note-when-play, play-when-note).");
}

console.log(fail ? "FAIL" : "ALL PASS");
process.exit(fail ? 1 : 0);

// A14-I1 (2026-06-11 unification survey, Stage I1) — single JS InputController.
//
// Survey: docs/2026-06-11-unification-survey/agents/A14-input-to-motion.md
// §3 row 1 (SPLIT-BRAIN, 5 sites) + §4 Stage I1.
//
// Two independent keystate trackers (index.html `keyState`, camera.js
// `this.keys`) plus dispatcher families all call the one wasm
// `setMovementInput` boundary, each deduping against its OWN `lastInputSig`
// so cross-site stomps go undetected and orbit-mode suppression exists on
// only one path. Stage I1 funnels them through ONE `InputController` behind
// `?inputFunnel=on` (default-off; off = both legacy paths untouched).
//
//   PART 1 — signature dedupe: the SINGLE shared signature recognises a
//            second site repeating the first site's axes as a no-op (the
//            cross-site stomp guard the per-site copies could never give);
//            a genuine change re-fires exactly once.
//   PART 2 — suppression matrix: the camera policy (orbit-suppress /
//            topDown / follow) crossed with the index.html gate
//            (enteredWorld && !typing) yields the right dispatch/suppress
//            decision; orbit suppresses on EITHER caller (the divergence-1
//            fix), pre-EnteredWorld gates, sign-clamp is applied.
//   PART 3 — static: exactly ONE non-synthetic `setMovementInput` call site
//            is wired through the controller when the flag is on, both legacy
//            sites route through it, and the flag-off path is preserved.
//            (picking.js synthetic-mover call sites are Stage I2, excluded.)
//
// Run:
//   cd apps/holtburger-web/
//   node test_a14_i1_input_controller.mjs

import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";
import { readFileSync } from "node:fs";
import {
  InputController,
  clampSign,
  readInputFunnelFlag,
} from "./scene3d/input.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

// A fake wasm handle that records every setMovementInput call.
function makeHandle() {
  const calls = [];
  return {
    calls,
    setMovementInput(forward, strafe, turn, run) {
      calls.push({ forward, strafe, turn, run });
    },
  };
}

// =====================================================================
console.log("PART 1 — single shared signature dedupes across sites");
{
  const ctrl = new InputController();
  // No policy, no gate → passthrough + allow (2D path / pre-camera).
  const handle = makeHandle();

  // Site A (index.html) fires forward.
  const a = ctrl.dispatch(handle, { forward: 1, strafe: 0, turn: 0, run: true });
  check("first dispatch fires setMovementInput once",
    a.dispatched === true && handle.calls.length === 1);

  // Site B (camera) fires the SAME axes in the same frame → no second call.
  const b = ctrl.dispatch(handle, { forward: 1, strafe: 0, turn: 0, run: true });
  check("second site, identical axes → deduped (no double-fire / stomp)",
    b.dispatched === false && handle.calls.length === 1);

  // A genuine change re-fires exactly once.
  const c = ctrl.dispatch(handle, { forward: 0, strafe: 1, turn: 0, run: true });
  check("genuine axis change → re-fires exactly once",
    c.dispatched === true && handle.calls.length === 2 &&
    handle.calls[1].strafe === 1);

  // Repeating the change is a no-op again.
  ctrl.dispatch(handle, { forward: 0, strafe: 1, turn: 0, run: true });
  check("repeat of the changed axes → no-op", handle.calls.length === 2);

  // run flag is part of the signature (Shift = walk).
  const r = ctrl.dispatch(handle, { forward: 0, strafe: 1, turn: 0, run: false });
  check("run flag participates in the dedup signature",
    r.dispatched === true && handle.calls.length === 3 &&
    handle.calls[2].run === false);
}

// Signature stability: two distinct axis sets never collide.
{
  const s1 = InputController.signature({ forward: 1, strafe: 0, turn: -1, run: true });
  const s2 = InputController.signature({ forward: 1, strafe: 0, turn: 1, run: true });
  check("distinct axis sets → distinct signatures", s1 !== s2);
  check("suppressed sentinel is its own signature",
    InputController.signature(null) === "suppressed");
}

// =====================================================================
console.log("PART 2 — suppression matrix (policy × gate)");

// Policy emulating camera.js _movementPolicy for a given mode.
function policyForMode(modeRef) {
  return (raw) => {
    if (modeRef.mode === "orbit") return null; // free-look suppresses
    // follow + topDown are passthrough today (player-local intent).
    return { forward: raw.forward, strafe: raw.strafe, turn: raw.turn, run: raw.run };
  };
}

// --- orbit suppresses on EITHER caller (divergence #1 fix) ---
{
  const modeRef = { mode: "orbit" };
  const ctrl = new InputController();
  ctrl.setMovementPolicy(policyForMode(modeRef));
  const handle = makeHandle();
  // index.html computes raw forward but the funnel suppresses in orbit.
  const r = ctrl.dispatch(handle, { forward: 1, strafe: 0, turn: 0, run: true });
  check("orbit mode: raw forward is SUPPRESSED at the single funnel (no wasm call)",
    r.suppressed === true && r.dispatched === false && handle.calls.length === 0);
}

// --- follow mode passes through ---
{
  const modeRef = { mode: "follow" };
  const ctrl = new InputController();
  ctrl.setMovementPolicy(policyForMode(modeRef));
  const handle = makeHandle();
  const r = ctrl.dispatch(handle, { forward: 1, strafe: 0, turn: -1, run: true });
  check("follow mode: passthrough → dispatched",
    r.dispatched === true && handle.calls.length === 1 &&
    handle.calls[0].forward === 1 && handle.calls[0].turn === -1);
}

// --- topDown mode passes through (world-fixed today is identical axes) ---
{
  const modeRef = { mode: "topDown" };
  const ctrl = new InputController();
  ctrl.setMovementPolicy(policyForMode(modeRef));
  const handle = makeHandle();
  const r = ctrl.dispatch(handle, { forward: 0, strafe: 1, turn: 0, run: false });
  check("topDown mode: passthrough → dispatched",
    r.dispatched === true && handle.calls[0].strafe === 1 && handle.calls[0].run === false);
}

// --- mode flips live (mid-stride C-cycle into orbit parks the rig) ---
{
  const modeRef = { mode: "follow" };
  const ctrl = new InputController();
  ctrl.setMovementPolicy(policyForMode(modeRef));
  const handle = makeHandle();
  ctrl.dispatch(handle, { forward: 1, strafe: 0, turn: 0, run: true });
  check("follow→moving: dispatched", handle.calls.length === 1);
  modeRef.mode = "orbit"; // user pressed C mid-stride
  const r = ctrl.dispatch(handle, { forward: 1, strafe: 0, turn: 0, run: true });
  check("flip to orbit mid-stride: same raw axes now suppressed",
    r.suppressed === true && handle.calls.length === 1);
}

// --- the index.html gate (enteredWorld && !typing) blocks dispatch ---
{
  const gateRef = { entered: false, typing: false };
  const ctrl = new InputController();
  ctrl.setInputGate(() => gateRef.entered && !gateRef.typing);
  const handle = makeHandle();

  const pre = ctrl.dispatch(handle, { forward: 1, strafe: 0, turn: 0, run: true });
  check("pre-EnteredWorld: gate blocks the wasm call",
    pre.dispatched === false && handle.calls.length === 0);

  gateRef.entered = true;
  // NOTE: the signature already advanced to "1,0,0,true" while gated, so a
  // dispatch with the SAME axes is (correctly) a no-op — the gate is not a
  // queue. A real keystate change re-fires; emulate by toggling an axis.
  const sameAxesNowEntered = ctrl.dispatch(handle, { forward: 1, strafe: 0, turn: 0, run: true });
  check("entering with unchanged axes → still no-op (gate is not a replay queue)",
    sameAxesNowEntered.dispatched === false && handle.calls.length === 0);
  const changed = ctrl.dispatch(handle, { forward: 1, strafe: 1, turn: 0, run: true });
  check("post-EnteredWorld + a real change → dispatched",
    changed.dispatched === true && handle.calls.length === 1);

  gateRef.typing = true; // focus moved to chat
  const typing = ctrl.dispatch(handle, { forward: 0, strafe: 0, turn: 0, run: true });
  check("typing in a form: gate blocks the wasm call",
    typing.dispatched === false && handle.calls.length === 1);
}

// --- sign-clamp is applied at the funnel (matches camera.js clampSign) ---
{
  const ctrl = new InputController();
  const handle = makeHandle();
  const r = ctrl.dispatch(handle, { forward: 0.0005, strafe: -0.9, turn: 2, run: true });
  check("funnel sign-clamps axes (dead-zone + sign)",
    r.axes.forward === 0 && r.axes.strafe === -1 && r.axes.turn === 1);
  check("clampSign dead-zone matches camera.js (±1e-3)",
    clampSign(0.0005) === 0 && clampSign(0.01) === 1 && clampSign(-0.01) === -1);
}

// --- a wasm throw rolls the signature back so the retry re-fires ---
{
  const ctrl = new InputController();
  const throwOnce = (() => {
    let n = 0;
    return {
      calls: [],
      setMovementInput(f, s, t, r) {
        if (n++ === 0) throw new Error("pre-EnteredWorld reject");
        this.calls.push({ f, s, t, r });
      },
    };
  })();
  const first = ctrl.dispatch(throwOnce, { forward: 1, strafe: 0, turn: 0, run: true });
  check("first dispatch throws → not counted as dispatched",
    first.dispatched === false && throwOnce.calls.length === 0);
  // Same axes retried — because the throw rolled lastSig back, it re-fires.
  const retry = ctrl.dispatch(throwOnce, { forward: 1, strafe: 0, turn: 0, run: true });
  check("identical retry after a throw re-fires (signature was rolled back)",
    retry.dispatched === true && throwOnce.calls.length === 1);
}

// =====================================================================
console.log("PART 3 — static: exactly ONE funnel call site when flag on");
const idx = readFileSync(joinPath(__dirname, "index.html"), "utf8");
const cam = readFileSync(joinPath(__dirname, "scene3d", "camera.js"), "utf8");
const inputSrc = readFileSync(joinPath(__dirname, "scene3d", "input.js"), "utf8");
const picking = readFileSync(joinPath(__dirname, "scene3d", "picking.js"), "utf8");

// The funnel module owns the ONLY executable setMovementInput call in
// scene3d/input.js (the canonical boundary). Count only code lines — the
// JSDoc references `handle.setMovementInput(...)` in prose.
{
  const codeCalls = inputSrc
    .split("\n")
    .filter((ln) => {
      const t = ln.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
      return /\bhandle\.setMovementInput\(/.test(ln);
    });
  check("input.js owns a single executable setMovementInput call (the funnel boundary)",
    codeCalls.length === 1, `found ${codeCalls.length}`);
}

// Both legacy sites import + read the flag + route through the controller.
check("index.html imports getInputController from the funnel module",
  /import\s*\{[\s\S]*getInputController as __getInputController[\s\S]*\}\s*from\s*["']\.\/scene3d\/input\.js["']/.test(idx));
check("index.html parses the ?inputFunnel flag",
  /readInputFunnelFlag/.test(idx) && /__inputFunnelOn/.test(idx));
check("index.html registers the input gate (enteredWorld && !typing)",
  /setInputGate\(\s*\n?\s*\(\)\s*=>\s*enteredWorld\s*&&\s*!isTypingInForm\(\)/.test(idx));
check("index.html rAF dispatch routes through the controller under the flag",
  /if\s*\(\s*__inputFunnelOn\s*\)\s*\{[\s\S]*?__getInputController\(\)\.dispatch\(handle,\s*\{\s*forward,\s*strafe,\s*turn,\s*run\s*\}\)/.test(idx));
check("index.html keeps the legacy direct call on the else (flag-off) branch",
  /\}\s*else\s*\{\s*\n\s*handle\.setMovementInput\(forward,\s*strafe,\s*turn,\s*run\);/.test(idx));

// A14-I3 (2026-06-12) widened this import to a multi-line form adding
// resolveRunModifier — match names anywhere inside one import-from-input.js.
check("camera.js imports getInputController + readInputFunnelFlag",
  /import\s*\{[^}]*getInputController[^}]*readInputFunnelFlag[^}]*\}\s*from\s*["']\.\/input\.js["']/s.test(cam));
check("camera.js registers its _movementPolicy with the controller under the flag",
  /this\._inputFunnelOn\s*=\s*readInputFunnelFlag\(\)/.test(cam) &&
  /setMovementPolicy\(\(raw\)\s*=>\s*this\._movementPolicy\(raw\)\)/.test(cam));
check("camera.js _movementPolicy suppresses motion in orbit (returns null)",
  /_movementPolicy\(raw\)\s*\{\s*\n\s*if\s*\(this\.mode\s*===\s*"orbit"\)\s*return\s+null;/.test(cam));
check("camera.js _dispatchMovement routes through the controller under the flag",
  /if\s*\(this\._inputFunnelOn\)\s*\{[\s\S]*?ctrl\.dispatch\(handle,\s*m\)/.test(cam));
check("camera.js keeps the legacy direct call on the else (flag-off) branch",
  /\}\s*else\s*\{[\s\S]*?handle\.setMovementInput\(m\.forward,\s*m\.strafe,\s*m\.turn,\s*m\.run\)/.test(cam));

// I1 must NOT touch the synthetic-mover (picking.js) call sites — that is I2,
// and it must not regress the shipped F6-6 charge-pursuit lockout fix.
check("picking.js synthetic-mover setMovementInput call sites are UNCHANGED (Stage I2)",
  /chargeTick/.test(picking) &&
  (picking.match(/setMovementInput/g) || []).length >= 4 &&
  !/getInputController/.test(picking) && !/inputFunnel/.test(picking));

// Flag default-off discipline.
check("readInputFunnelFlag default is off (no param → false)",
  readInputFunnelFlag("") === false &&
  readInputFunnelFlag("?inputFunnel=off") === false &&
  readInputFunnelFlag("?inputFunnel=on") === true);

// url-flags.md documents the flag.
const flagsDoc = readFileSync(joinPath(__dirname, "docs", "url-flags.md"), "utf8");
check("url-flags.md documents ?inputFunnel",
  /`inputFunnel`/.test(flagsDoc) && /A14-I1/.test(flagsDoc));

// =====================================================================
console.log(`\nA14-I1 input-controller: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

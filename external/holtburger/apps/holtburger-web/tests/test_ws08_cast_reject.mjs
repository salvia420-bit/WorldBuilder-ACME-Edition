// WS08 (F8-6, 2026-07-12) — cast-reject policy for the client cast-state machine.
//
// Proves ui/cast_reject_policy.js::isTerminalCastReject classifies exactly the
// server cast-reject WeenieError codes that must free the F8-4 busy window +
// cancel the optimistic local prediction (retail Handle_Item__UseDone decrements
// m_cBusy on EVERY UseDone — acclient.c:401931), while EXCLUDING the two codes
// that must NOT cancel:
//   0x0402 YourSpellFizzled  — owned by the ?castFizzle branch (index.html)
//   0x001D YoureTooBusy      — the PREVIOUS cast is still live; cancelling kills it
// and models the index.html kind=13 handler gate (shouldClearCastOnReject):
// cancel ONLY when a local cast is in flight, and ONLY under the strict opt-in
// `?castRejectClears=on` (DEFAULT-OFF). WS08b (2026-07-13): the "in flight"
// signal is the DURABLE `inst._castChainActive` (true for the whole chain) with
// `_castBusyUntilMs` as an OR-fallback — the round-4c judge proved that gating
// on `nowMs < _castBusyUntilMs` ALONE drops a genuine reject that lands after
// the short durationS-based busy-window ESTIMATE lapses but while the windup is
// still visibly running (cast +482ms, done +1224ms, reject +874ms).
//
// Run: node tests/test_ws08_cast_reject.mjs   (from apps/holtburger-web/)

import { isTerminalCastReject, shouldClearCastOnReject } from "../ui/cast_reject_policy.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log("  ✗ " + m); } };

// --- classification: terminal cast rejects -> true -----------------------------
for (const [code, name] of [
  [0x000f, "BadCast"], [0x03fc, "InvalidType"], [0x0400, "Components"],
  [0x0401, "Mana"], [0x0407, "Outside"], [0x0408, "Inside"],
  [0x042c, "TargetLost"], [0x0498, "MovedTooFar"], [0x04eb, "InAir"],
  [0x0550, "OutOfRange"],
]) {
  ok(isTerminalCastReject(code) === true, `terminal ${name} 0x${code.toString(16)} -> true`);
}

// --- excluded -> false ---------------------------------------------------------
ok(isTerminalCastReject(0x0402) === false, "fizzle 0x0402 excluded (castFizzle owns it)");
ok(isTerminalCastReject(0x001d) === false, "YoureTooBusy 0x001D excluded (prev cast live)");

// --- unrelated -> false --------------------------------------------------------
for (const c of [0x0000, 0x001c, 0x0226, 0xffff]) {
  ok(isTerminalCastReject(c) === false, `unrelated 0x${c.toString(16)} -> false`);
}

// --- u32 coercion: a code passed as a negative/large int is masked -------------
ok(isTerminalCastReject(0x0550 >>> 0) === true, "0x0550 via >>>0 still true");
ok(isTerminalCastReject(-1) === false, "-1 (>>>0 = 0xFFFFFFFF) -> false");

// --- handler-gate model (mirrors index.html kind=13 branch, strict `=on`) ------
// Cancel only when: not a fizzle, flag === "on", terminal reject, AND a local
// cast is in flight. WS08b: the in-flight signal is the DURABLE
// `inst._castChainActive` (true for the whole chain), with `_castBusyUntilMs`
// as an OR-fallback — NOT `nowMs < _castBusyUntilMs` alone, which the round-4c
// judge proved drops a genuine reject that lands after the short busy-window
// ESTIMATE lapses but during the still-running windup.
function handle(inst, errCode, nowMs, castRejectClearsParam /* url param value */) {
  const out = [];
  if (errCode === 0x0402) { out.push("fizzle-cancel"); return out; } // castFizzle branch
  const flagOn = castRejectClearsParam === "on";                     // strict opt-in
  if (shouldClearCastOnReject({
    flagOn,
    code: errCode,
    chainActive: !!inst._castChainActive,
    busyUntilMs: inst._castBusyUntilMs || 0,
    nowMs,
  })) {
    out.push("cancelCastSequence");
  }
  return out;
}
const J = JSON.stringify;
ok(J(handle({ _castBusyUntilMs: 1000 }, 0x0550, 500, "on")) === '["cancelCastSequence"]',
  "in-flight range reject cancels (busy-window fallback, flag on)");
ok(J(handle({ _castBusyUntilMs: 0 }, 0x0550, 500, "on")) === "[]",
  "no-cast reject is no-op (door/melee reuse)");
// THE ROUND-4C FIX — a genuine reject lands after the busy-window ESTIMATE
// expired (nowMs 874 > busyUntilMs 600) but the cast CHAIN is still active
// (durationS estimate < actual windup). Old gate dropped it; new gate cancels.
ok(J(handle({ _castChainActive: true, _castBusyUntilMs: 600 }, 0x042c, 874, "on")) === '["cancelCastSequence"]',
  "ROUND-4C: reject after busy-window estimate lapses but chain still active -> CANCELS");
// Chain active with no busy window set at all still cancels (durable signal).
ok(J(handle({ _castChainActive: true, _castBusyUntilMs: 0 }, 0x042c, 5000, "on")) === '["cancelCastSequence"]',
  "chainActive true, no busy window -> cancels (durable in-flight signal)");
// Chain NOT active and window expired -> no-op (nothing is casting).
ok(J(handle({ _castChainActive: false, _castBusyUntilMs: 400 }, 0x0550, 500, "on")) === "[]",
  "expired window AND chain inactive -> no-op (no cast in flight)");
ok(J(handle({ _castBusyUntilMs: 1000 }, 0x001d, 500, "on")) === "[]",
  "YoureTooBusy leaves in-flight cast");
ok(J(handle({ _castBusyUntilMs: 0 }, 0x0402, 500, "on")) === '["fizzle-cancel"]',
  "fizzle handled regardless of window");
// Default-OFF: absent flag (any value != "on") is a full no-op for terminal rejects.
ok(J(handle({ _castChainActive: true, _castBusyUntilMs: 1000 }, 0x0550, 500, null)) === "[]",
  "default-OFF: absent castRejectClears is a no-op even with chain active");
ok(J(handle({ _castChainActive: true, _castBusyUntilMs: 1000 }, 0x0550, 500, "off")) === "[]",
  "castRejectClears=off escape is a no-op");
// ...but fizzle still fires with the flag absent (it's on the castFizzle branch).
ok(J(handle({ _castBusyUntilMs: 1000 }, 0x0402, 500, null)) === '["fizzle-cancel"]',
  "default-OFF: fizzle unaffected by castRejectClears");

// --- shouldClearCastOnReject pure unit coverage --------------------------------
ok(shouldClearCastOnReject({ flagOn: true, code: 0x042c, chainActive: true, busyUntilMs: 0, nowMs: 9e9 }) === true,
  "shouldClear: flag on + terminal + chainActive -> true");
ok(shouldClearCastOnReject({ flagOn: true, code: 0x042c, chainActive: false, busyUntilMs: 1000, nowMs: 500 }) === true,
  "shouldClear: flag on + terminal + open busy window -> true (fallback)");
ok(shouldClearCastOnReject({ flagOn: true, code: 0x042c, chainActive: false, busyUntilMs: 400, nowMs: 500 }) === false,
  "shouldClear: flag on + terminal + expired window + not active -> false");
ok(shouldClearCastOnReject({ flagOn: false, code: 0x042c, chainActive: true, busyUntilMs: 1000, nowMs: 500 }) === false,
  "shouldClear: flag OFF -> false (strict opt-in) even when clearly in flight");
ok(shouldClearCastOnReject({ flagOn: true, code: 0x0402, chainActive: true, busyUntilMs: 1000, nowMs: 500 }) === false,
  "shouldClear: fizzle 0x0402 is not a terminal reject here -> false (castFizzle owns it)");
ok(shouldClearCastOnReject({ flagOn: true, code: 0x001d, chainActive: true, busyUntilMs: 1000, nowMs: 500 }) === false,
  "shouldClear: YoureTooBusy 0x001D excluded -> false");

console.log(fail ? `FAIL — ${pass} passed, ${fail} failed` : `PASS — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);

// WS08 (F8-6, 2026-07-12) — cast-reject policy for the client cast-state machine.
//
// Proves ui/cast_reject_policy.js::isTerminalCastReject classifies exactly the
// server cast-reject WeenieError codes that must free the F8-4 busy window +
// cancel the optimistic local prediction (retail Handle_Item__UseDone decrements
// m_cBusy on EVERY UseDone — acclient.c:401931), while EXCLUDING the two codes
// that must NOT cancel:
//   0x0402 YourSpellFizzled  — owned by the ?castFizzle branch (index.html)
//   0x001D YoureTooBusy      — the PREVIOUS cast is still live; cancelling kills it
// and models the index.html kind=13 handler gate: cancel ONLY when a local cast
// prediction is in flight (_castBusyUntilMs), and ONLY under the strict opt-in
// `?castRejectClears=on` (DEFAULT-OFF per the verdict mustFix).
//
// Run: node tests/test_ws08_cast_reject.mjs   (from apps/holtburger-web/)

import { isTerminalCastReject } from "../ui/cast_reject_policy.js";

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
// cast prediction is in flight (nowMs < _castBusyUntilMs).
function handle(inst, errCode, nowMs, castRejectClearsParam /* url param value */) {
  const out = [];
  if (errCode === 0x0402) { out.push("fizzle-cancel"); return out; } // castFizzle branch
  if (castRejectClearsParam !== "on") return out;                    // strict opt-in
  if (isTerminalCastReject(errCode) && inst && inst._castBusyUntilMs &&
      nowMs < inst._castBusyUntilMs) {
    out.push("cancelCastSequence");
  }
  return out;
}
const J = JSON.stringify;
ok(J(handle({ _castBusyUntilMs: 1000 }, 0x0550, 500, "on")) === '["cancelCastSequence"]',
  "in-flight range reject cancels (flag on)");
ok(J(handle({ _castBusyUntilMs: 0 }, 0x0550, 500, "on")) === "[]",
  "no-cast reject is no-op (door/melee reuse)");
ok(J(handle({ _castBusyUntilMs: 400 }, 0x0550, 500, "on")) === "[]",
  "expired-window reject is no-op");
ok(J(handle({ _castBusyUntilMs: 1000 }, 0x001d, 500, "on")) === "[]",
  "YoureTooBusy leaves in-flight cast");
ok(J(handle({ _castBusyUntilMs: 0 }, 0x0402, 500, "on")) === '["fizzle-cancel"]',
  "fizzle handled regardless of window");
// Default-OFF: absent flag (any value != "on") is a full no-op for terminal rejects.
ok(J(handle({ _castBusyUntilMs: 1000 }, 0x0550, 500, null)) === "[]",
  "default-OFF: absent castRejectClears is a no-op");
ok(J(handle({ _castBusyUntilMs: 1000 }, 0x0550, 500, "off")) === "[]",
  "castRejectClears=off escape is a no-op");
// ...but fizzle still fires with the flag absent (it's on the castFizzle branch).
ok(J(handle({ _castBusyUntilMs: 1000 }, 0x0402, 500, null)) === '["fizzle-cancel"]',
  "default-OFF: fizzle unaffected by castRejectClears");

console.log(fail ? `FAIL — ${pass} passed, ${fail} failed` : `PASS — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);

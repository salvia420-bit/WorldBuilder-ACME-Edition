// operator_stop.js — durable operator AI-stop latch (task #11, 2026-07-19).
//
// Bug it fixes: the ?bot=1 auto-boot block (index.html) rebuilds a fresh bot
// from URL params on every session takeover/reconnect. Because the stream-rig
// URL carries botModel/botInterval, the fresh bot auto-started a NEW AI
// director even when the operator had deliberately stopped the previous one
// via window.rynthAI.stop(). A soak once closed with the director stopped; a
// 04:24 auto-reconnect booted a fresh director that ran ~11h and burned
// OpenRouter credits against a stuck character.
//
// Fix: rynthAI.stop() writes a persistent latch; rynthAI.start() clears it;
// the auto-boot cfg assembly forces cfg.ai = false whenever the latch is set,
// so an operator stop survives reloads AND reconnect reboots. localStorage
// (not sessionStorage) is used deliberately so the latch also survives a full
// browser restart. The latch is ADDITIVE: ?botAi=off still forces the director
// off on its own; the latch is an extra AND-style suppressor. When the latch
// is absent (operator never touched rynthAI) behavior is unchanged.
//
// Pure + storage-injectable so it is unit-testable under plain `node` (which
// has no localStorage): every entry point accepts an optional storage object
// and defaults to globalThis.localStorage in the browser.

export const OPERATOR_STOP_KEY = "rynthAiOperatorStop";

function resolveStore(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

// Operator pressed stop: persist the latch. Blocked/absent storage is a no-op.
export function latchOperatorStop(storage) {
  const s = resolveStore(storage);
  try { s?.setItem(OPERATOR_STOP_KEY, "1"); } catch { /* blocked storage */ }
}

// Operator pressed start: release the latch so auto-boot may run the director.
export function clearOperatorStop(storage) {
  const s = resolveStore(storage);
  try { s?.removeItem(OPERATOR_STOP_KEY); } catch { /* blocked storage */ }
}

export function isOperatorStopLatched(storage) {
  const s = resolveStore(storage);
  try { return s?.getItem(OPERATOR_STOP_KEY) === "1"; } catch { return false; }
}

// Auto-boot decision: when the latch is set, force the AI director off on the
// assembled bot config, regardless of botModel/botInterval params. Mutates cfg
// in place and returns true iff it suppressed the director (so the caller can
// log a single line). A missing/invalid cfg or an absent latch is a no-op
// returning false — the default (never-stopped) path is untouched.
export function applyOperatorStopToCfg(cfg, storage) {
  if (!cfg || typeof cfg !== "object") return false;
  if (!isOperatorStopLatched(storage)) return false;
  cfg.ai = false;
  return true;
}

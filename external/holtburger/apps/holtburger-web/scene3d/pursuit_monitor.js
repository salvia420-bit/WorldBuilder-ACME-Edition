// A14-I2 (2026-06-12, W3+ S10) — pure pursuit-monitor state machine for
// the `?wasmPursuit=on` picking.js consumer. NO THREE / NO DOM imports
// (the input.js pure-helper precedent, scene3d/input.js:44-46) so the
// headless test (`test_a14_i2_pursuit_monitor.mjs`) can drive it under
// plain node.
//
// Under the flag the charge pursuit / turn-to-face steering moves
// WASM-side (`pursueEntity`/`turnToEntity` → the A3-D3 MoveToManager
// driver); JS keeps only this monitor: poll `pursuitStatus()` each rAF
// and decide arrive / cancel / keep-waiting. Crucially the ARRIVE
// decision still invokes the same `charge.fireAttack` closure as the
// legacy chargeTick (picking.js), so the F6-6 live-lockout read inside
// `fireOnce` is preserved verbatim — this module never touches the
// fire path, it only says WHEN.

// `pursuitStatus()` wire encoding (lib.rs `SessionHandle::pursuit_status`):
// low 16 bits = state, high 16 bits = WEENIE error on failure
// (0x36 cancelled / 0x3D fail-distance / 0x37,0x38 target lost /
// 8 unresolvable). The completion states (>= 2) are READ-CLEAR at the
// wasm getter, so each completion is observed exactly once.
export const PURSUIT_IDLE = 0;
export const PURSUIT_ACTIVE = 1;
export const PURSUIT_ARRIVED = 2;
export const PURSUIT_FAILED = 3;

export function decodePursuitStatus(raw) {
  const value = raw >>> 0;
  return { state: value & 0xffff, werror: (value >>> 16) & 0xffff };
}

// Module-flag reader (the `readInputFunnelFlag` pattern) — pure so the
// test can probe both polarities.
export function readWasmPursuitFlag(search) {
  try {
    return /[?&]wasmPursuit=on(&|$)/.test(search ?? "");
  } catch {
    return false;
  }
}

/**
 * One charge-pursuit monitor. `step(...)` is called once per rAF with
 * the live inputs and returns exactly one terminal action over the
 * monitor's lifetime:
 *
 *   { action: "continue" }                    — keep polling (IDLE is
 *     "pending": the command channel is async, the intent may not have
 *     been applied yet; bounded by the timeout).
 *   { action: "arrive" }                      — wasm reports ARRIVED:
 *     caller releases the windup hold then invokes `charge.fireAttack()`
 *     (same order as legacy arrival — F6-6 preserved). Fired AT MOST
 *     ONCE; subsequent steps return { action: "done" }.
 *   { action: "cancel", reason, werror? }     — terminal no-fire:
 *     reason "timeout" (wall-clock safety net), "stance" (left combat
 *     stance) or "failed" (wasm completion 3; werror carries the
 *     WEENIE code). Also at most once.
 *   { action: "done" }                        — already terminal.
 */
export function createPursuitMonitor({ maxDurationMs }) {
  let terminal = false;
  return function step({ statusRaw, elapsedMs, inCombatStance }) {
    if (terminal) return { action: "done" };
    if (elapsedMs > maxDurationMs) {
      terminal = true;
      return { action: "cancel", reason: "timeout" };
    }
    if (!inCombatStance) {
      terminal = true;
      return { action: "cancel", reason: "stance" };
    }
    const { state, werror } = decodePursuitStatus(statusRaw);
    if (state === PURSUIT_ARRIVED) {
      terminal = true;
      return { action: "arrive" };
    }
    if (state === PURSUIT_FAILED) {
      terminal = true;
      return { action: "cancel", reason: "failed", werror };
    }
    return { action: "continue" };
  };
}

/**
 * One turn-to-face monitor (missile/cast pre-step). Terminal mapping
 * differs from the charge: EVERY terminal outcome runs `act()` (legacy
 * `turnToFaceThenAct` fires the action on timeout too) — only WHETHER
 * a `cancelPursuit()` is owed differs:
 *
 *   { action: "continue" }
 *   { action: "act", cancel: false }  — arrived (2) or failed (3): the
 *     wasm side already ended the turn; just act.
 *   { action: "act", cancel: true }   — wall-clock timeout: cancel the
 *     still-running turn, then act.
 *   { action: "done" }
 */
export function createTurnMonitor({ timeoutMs }) {
  let terminal = false;
  return function step({ statusRaw, elapsedMs }) {
    if (terminal) return { action: "done" };
    if (elapsedMs > timeoutMs) {
      terminal = true;
      return { action: "act", cancel: true };
    }
    const { state } = decodePursuitStatus(statusRaw);
    if (state === PURSUIT_ARRIVED || state === PURSUIT_FAILED) {
      terminal = true;
      return { action: "act", cancel: false };
    }
    return { action: "continue" };
  };
}

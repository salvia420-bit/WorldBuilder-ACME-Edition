// scene3d/ghost_rigs.js — NETSYNC-4b (2026-10-07): drop a remote PLAYER's rig
// once the wasm world has stopped knowing that player for longer than retail's
// object-destruction time.
//
// Retail culls an object 25 s after it leaves visibility or lands in a cell the
// client does not have (`CPhysicsObj::prepare_to_leave_visibility` →
// `CObjectMaint::AddObjectToBeDestroyed`, +25.0 s, acclient.c:319196 /
// :310651), and ACE relies on that client cull (no ObjectDelete is sent). The
// wasm world already does it (liveness.rs, 25 s); `?maintPrune` (default ON
// since NETSYNC-4) forwards that despawn as KIND_REMOVE. This sweep is the
// backstop for a rig whose KIND_REMOVE never comes (the round-1 Coldeve
// capture had 7 player rigs whose wasm entity was gone for the whole session):
// it removes the rig only after the wasm world has not known the guid for
// GHOST_RIG_GRACE_MS (25 s + margin), so the KIND_REMOVE path wins whenever it
// fires. PLAYERS ONLY (guid class 0x50): players always come from a wire
// ObjectCreate, never from baked spawn data, so "unknown to wasm" is
// unambiguous for them.
//
// `?ghostRigSweep=off` disables it (absent ⇒ ON; true outside a browser).

/** Retail destruction time (25 s) + margin so the KIND_REMOVE path wins. */
export const GHOST_RIG_GRACE_MS = 30000;
/** Sweep cadence (retail refreshes its visible-object list once per second). */
export const GHOST_RIG_SWEEP_INTERVAL_MS = 1000;

export const GHOST_RIG_SWEEP_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    return new URLSearchParams(window.location.search).get("ghostRigSweep")?.toLowerCase() !== "off";
  } catch (_) {
    return true;
  }
})();

/**
 * One sweep step. Pure.
 * @param {Map<number, number>} state guid → ms since which wasm has not known it
 * @param {number} nowMs
 * @param {Iterable<number>} rigGuids every guid that currently has a JS rig
 * @param {(guid: number) => boolean} isKnownToWasm
 * @param {number|null} localGuid the local player (never swept)
 * @returns {number[]} guids whose rig should be removed now
 */
export function ghostRigSweepStep(state, nowMs, rigGuids, isKnownToWasm, localGuid) {
  const drop = [];
  const seen = new Set();
  const local = localGuid == null ? null : (localGuid >>> 0);
  for (const g0 of rigGuids) {
    const g = g0 >>> 0;
    if ((g >>> 24) !== 0x50 || g === local) continue;
    seen.add(g);
    if (isKnownToWasm(g)) {
      state.delete(g);
      continue;
    }
    const since = state.get(g);
    if (since === undefined) {
      state.set(g, nowMs);
    } else if (nowMs - since >= GHOST_RIG_GRACE_MS) {
      drop.push(g);
      state.delete(g);
    }
  }
  // Rigs that went away by themselves.
  for (const g of [...state.keys()]) if (!seen.has(g)) state.delete(g);
  return drop;
}

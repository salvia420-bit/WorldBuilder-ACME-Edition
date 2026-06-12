// scene3d/entity_dispatch.js — A15-Q4 renderer-NEUTRAL EntityUpdate
// dispatch core (2026-06-12 unification survey, w3plus spec S3).
//
// Retail analog: the single DispatchSmartBoxEvent funnel at the bottom
// of the renderer-neutral SmartBox::UseTime tick (acclient.c:146313-
// 146318) — ONE kind table, with per-renderer backends as separate
// passes. Our pre-Q4 shape had the kind routing duplicated across the
// 2D drainEvents if-chain (index.html) and the 3D dispatchEntityUpdate
// if-chain (loop.js); this module is the shared routing table both
// hosts build their dispatcher from under `?unifiedDispatch=on`.
//
// QUARANTINE POLICY (RULINGS.md 2026-06-11 item 2 — "2D stays
// supported; deletion is permanently off the table; quarantine-plus-
// shared-core"): the 2D backend is FROZEN at kinds 0-5; kinds 6-9
// (APPEARANCE/ATTACH/MOTION_ACTION/TURN) are a documented feature gap
// of the supported 2D mode; NEW kinds are 3D-only by policy and MUST
// be registered in this KIND map first.
//
// Design constraints (load-bearing for the A1-O4 re-host):
//   - Pure factory module: no `window`, no DOM, no wasm imports —
//     every environment touch is an injected handler. A1-O4
//     (`?singleDriver`) is the intended next consumer: under O4 the
//     scene3d rAF will call the SAME drain core, and this module (plus
//     world_stream.js) can be re-hosted without edits because nothing
//     here assumes a renderer or a window.
//   - The dispatcher NEVER calls `upd.free()` — the drain that polled
//     `pollEntityUpdates()` owns the wasm-bindgen lifetime
//     (index.html drain-loop tail; loop.js drainEntityEvents3D
//     wrapper). Handlers receive the still-alive handle (or a
//     plain-JS clone on the backlog-replay path) read-only.

// Entity-update kind constants — mirror the wasm `ENTITY_UPDATE_KIND_*`
// constants from `crates/holtburger-session/src/lib.rs`. Single source
// for both renderers (loop.js aliases these; pre-Q4 it carried its own
// `const KIND_* = n` literal block).
export const KIND = Object.freeze({
  POSITION: 0,
  SPAWN: 1,
  REMOVE: 2,
  META_REFRESH: 3,
  VELOCITY: 4,
  MOTION: 5,
  APPEARANCE: 6,
  ATTACH: 7,
  MOTION_ACTION: 8,
  TURN: 9,
});

/**
 * Build a per-host EntityUpdate dispatcher.
 *
 * @param {object} opts
 * @param {Object<number, function>} [opts.neutral] renderer-NEUTRAL
 *   per-kind hooks (world streaming, Chorizite worldObjectManager feed).
 *   Run BEFORE the backend for the same kind. INVARIANT: neutral
 *   concerns run exactly ONCE per update — at the index.html drain.
 *   The loop.js (3D) dispatcher is built with an EMPTY neutral table
 *   because the 3D hook receives the same array the 2D for-loop
 *   iterates.
 * @param {Object<number, function>} [opts.backend] per-renderer
 *   per-kind handlers (2D sprite work / 3D rig work).
 * @param {string} [opts.label] host tag for the one-time accounting
 *   info + warn prefixes ("2d-drain" / "3d").
 * @returns {{dispatch: function(object): boolean}} `dispatch(upd)`
 *   returns true iff a backend handler ran. Never throws; never frees.
 */
export function createEntityDispatcher({ neutral = {}, backend = {}, label = "?" } = {}) {
  const warnedKinds = new Set();
  return {
    dispatch(upd) {
      if (!upd) return false;
      const kind = upd.kind | 0;
      try {
        neutral[kind]?.(upd);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[A15-Q4 ${label}] neutral kind=${kind}:`, e);
      }
      const h = backend[kind];
      if (h) {
        try {
          h(upd);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(`[A15-Q4 ${label}] backend kind=${kind}:`, e);
        }
        return true;
      }
      if (!warnedKinds.has(kind)) {
        // One-time per-kind accounting — replaces the pre-Q4 SILENT
        // fall-through (the 2D kinds-6-9 gap; the 3D kind-3 gap).
        warnedKinds.add(kind);
        // eslint-disable-next-line no-console
        console.info(
          `[A15-Q4 ${label}] no backend handler for EntityUpdate kind=${kind} (quarantine policy)`
        );
      }
      return false;
    },
    // NEVER calls upd.free() — the drain owns the wasm-bindgen
    // lifetime (see module header).
  };
}

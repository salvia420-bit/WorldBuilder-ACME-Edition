// A8-M3 (2026-06-11 unification survey) — scene3d-owned dispatcher for
// rig-affecting ClientEvents (poll_events stream). Retail parity: visibility
// state bits are applied by the entity owner with no renderer dispatch hop
// (SmartBox::DoSetState acclient.c:143396 → CPhysicsObj::set_state
// :322172 → set_nodraw/set_hidden :322197-322200). Mirror of the wasm
// constant CLIENT_EVENT_KIND_ENTITY_VISIBILITY_CHANGED (src/lib.rs:16463).
//
// Pure, dependency-free (no THREE, no DOM, no wasm imports) — node-importable
// like scene3d/entity_update_clone.js (the A15-Q2 precedent). Gated at the
// CALL site in index.html behind `?unifiedClientEvent=on` (default-off;
// renamed from the spec's `?unifiedEntityDispatch` by the SQ3 §3 flag ruling:
// kind-17 rides the ClientEvent stream, not the EntityUpdate stream).
export const CLIENT_EVENT_KIND_ENTITY_VISIBILITY_CHANGED = 17;

// Returns a hook fn(evt) -> boolean (true = consumed by scene3d; caller
// must then skip its legacy arm). `getEntityManager` is injected so this
// module stays pure and the manager can be late-bound.
//
// Lifetime contract (pinned by spec review): the hook MUST NOT retain
// `evt` — poll_events ClientEvents are not `.free()`d by the drain loop;
// payload fields are copied into primitives immediately and nothing is
// stored.
export function createClientEventDispatcher({ getEntityManager }) {
  return function scene3dClientEventHook(evt) {
    if (!evt) return false;
    const kind = evt.kind | 0;
    if (kind !== CLIENT_EVENT_KIND_ENTITY_VISIBILITY_CHANGED) return false;
    const em = getEntityManager?.();
    // Consumed even when the manager isn't ready: the legacy index.html
    // body would no-op behind the same guard (liveScene3d/entityManager/
    // setVisibility checks), so "consumed + no-op" is behavior-identical
    // and keeps exactly one handler authoritative per kind.
    if (em && typeof em.setVisibility === "function") {
      em.setVisibility(evt.u32Payload >>> 0, (evt.u32Payload2 >>> 0) === 1);
    }
    return true;
  };
}

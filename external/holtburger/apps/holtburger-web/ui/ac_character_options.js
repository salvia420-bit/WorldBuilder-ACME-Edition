// Wave 11 Phase 33 (2026-05-26) — JS facade for ACE CharacterOption
// updates. Routes through the wasm SessionHandle.setCharacterOption
// binding → SessionCommand::SetCharacterOption → ClientCommand-mirroring
// recv arm → GameAction::SetSingleCharacterOption (sub-opcode 0x0167).
//
// Path B for the combat-bar's Fast Missiles toggle: this is the
// wire-side companion to Path A (picking.js's client-side 1.2× arc
// prediction multiplier). Both run together — Path A keeps the local
// aim arc in sync with what ACE will broadcast back, Path B tells ACE
// to actually apply its server-side 1.2× modifier on the next missile
// engagement (Creature_Missile.cs:223-225 in ACE-server).
//
// Values are the `holtburger_common::CharacterOption` enum (which
// mirrors ACE `CharacterOption.cs`). The wasm `from_repr` rejects
// unknown values with a JS-side error so a typo here surfaces as a
// console.warn instead of silently no-oping on the wire.
export const CHARACTER_OPTION = Object.freeze({
  // ACE CharacterOption.cs:144 — boosts arrow/bolt/dart launcher
  // velocity by 1.2× server-side. Wave 10 Phase 32 wired the client-
  // side prediction half; Wave 11 Phase 33 wires the wire-side bit.
  UseFastMissiles: 0x2B,
  // (Add more as plugins need them. Cite ACE `CharacterOption.cs`
  // for each value; the wasm side's `from_repr` is authoritative on
  // the full set.)
});

// Send a CharacterOption toggle through the wasm SessionHandle. Both
// arguments are coerced to safe shapes (option → unsigned u32, enabled
// → strict boolean) so a JS-side bug can't ship malformed bytes. The
// session-handle binding may not exist if wasm hasn't initialised yet
// (pre-login, or in a Storybook-style standalone harness) — we
// fail-soft with a console.warn rather than throwing, since this is a
// fire-and-forget UI toggle, not a load-bearing dispatch.
export function setCharacterOption(option, enabled) {
  try {
    const handle = window.__sessionHandle;
    if (!handle || typeof handle.setCharacterOption !== "function") {
      // pre-login / no session yet — nothing to send. The combat-bar's
      // localStorage persistence still works; the wire op will fire
      // the next time the user toggles after login.
      return;
    }
    handle.setCharacterOption(option >>> 0, !!enabled);
  } catch (e) {
    console.warn(`[character-options] setCharacterOption failed:`, e);
  }
}

// Convenience helper for the combat-bar's Fast Missiles checkbox.
// Same shape as the underlying setCharacterOption call but keeps the
// 0x2B magic number out of plugin code.
export function setUseFastMissiles(enabled) {
  setCharacterOption(CHARACTER_OPTION.UseFastMissiles, enabled);
}

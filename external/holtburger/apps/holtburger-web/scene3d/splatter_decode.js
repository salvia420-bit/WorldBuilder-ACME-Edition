// Combat-visuals Phase 1 (2026-08-02) — directional Splatter decode.
//
// ACE's `PlayScript` enum carries the blood-splatter family as 12
// contiguous IDs (`0x5B`-`0x66`) encoding a 3 × 2 × 2 product:
//
//   height    ∈ { Low, Mid, Up }          — thirds of the target's body
//   side      ∈ { Left, Right }           — TARGET-relative, not camera
//   facing    ∈ { Back, Front }           — TARGET-relative
//
// Verified against `external/ACE/Source/ACE.Entity/Enum/PlayScript.cs`
// (lines 96-107). The enum is ordered height-major, then Left/Right,
// then Back/Front — i.e. the low bits cycle Front/Back fastest:
//
//   0x5B SplatterLowLeftBack    0x5C SplatterLowLeftFront
//   0x5D SplatterLowRightBack   0x5E SplatterLowRightFront
//   0x5F SplatterMidLeftBack    0x60 SplatterMidLeftFront
//   0x61 SplatterMidRightBack   0x62 SplatterMidRightFront
//   0x63 SplatterUpLeftBack     0x64 SplatterUpLeftFront
//   0x65 SplatterUpRightBack    0x66 SplatterUpRightFront
//
// Retail placed the emitter at the height-third of the whole-body
// cylinder on the named quadrant side, so the decode is directly
// consumable as "(height band, quadrant) on the target's own body".
//
// **Deliberately dependency-free.** This module imports NOTHING (no
// three.js, no PLAY_SCRIPT mirror) so it can be unit-tested under bare
// `node` and imported by a web worker without dragging the renderer in.
// The numeric IDs are inlined rather than read from `ui/ac_play_script.js`
// precisely to keep that property; the table below IS the contract and
// the unit test asserts it against the ACE enum ordering.

/** Height band — index into the target's body thirds. */
export const SPLATTER_HEIGHT = Object.freeze({
  LOW: 0,
  MID: 1,
  UP: 2,
});

/** First / last PlayScript ID in the Splatter family (inclusive). */
export const SPLATTER_ID_MIN = 0x5b;
export const SPLATTER_ID_MAX = 0x66;

/**
 * `id → {height, left, front}`, frozen records so the hot path can
 * return the shared object without allocating. Names are carried for
 * diag/log readability only — nothing branches on them.
 *
 * @typedef {{ height: 0|1|2, left: boolean, front: boolean, name: string }} SplatterDecode
 * @type {Readonly<Record<number, Readonly<SplatterDecode>>>}
 */
export const SPLATTER_DECODE_TABLE = Object.freeze({
  0x5b: Object.freeze({ height: 0, left: true,  front: false, name: "SplatterLowLeftBack" }),
  0x5c: Object.freeze({ height: 0, left: true,  front: true,  name: "SplatterLowLeftFront" }),
  0x5d: Object.freeze({ height: 0, left: false, front: false, name: "SplatterLowRightBack" }),
  0x5e: Object.freeze({ height: 0, left: false, front: true,  name: "SplatterLowRightFront" }),
  0x5f: Object.freeze({ height: 1, left: true,  front: false, name: "SplatterMidLeftBack" }),
  0x60: Object.freeze({ height: 1, left: true,  front: true,  name: "SplatterMidLeftFront" }),
  0x61: Object.freeze({ height: 1, left: false, front: false, name: "SplatterMidRightBack" }),
  0x62: Object.freeze({ height: 1, left: false, front: true,  name: "SplatterMidRightFront" }),
  0x63: Object.freeze({ height: 2, left: true,  front: false, name: "SplatterUpLeftBack" }),
  0x64: Object.freeze({ height: 2, left: true,  front: true,  name: "SplatterUpLeftFront" }),
  0x65: Object.freeze({ height: 2, left: false, front: false, name: "SplatterUpRightBack" }),
  0x66: Object.freeze({ height: 2, left: false, front: true,  name: "SplatterUpRightFront" }),
});

/**
 * Decode a raw PlayScript ID into its Splatter geometry, or `null` when
 * the ID is outside the Splatter family (including the adjacent Spark
 * family `0x67`-`0x72`, which shares the taxonomy but is a separate
 * visual and is intentionally NOT decoded here).
 *
 * Never throws — a non-numeric / NaN / out-of-range input returns null.
 *
 * @param {number} id
 * @returns {Readonly<SplatterDecode>|null}
 */
export function decodeSplatterId(id) {
  if (typeof id !== "number" || !Number.isFinite(id)) return null;
  const k = id >>> 0;
  if (k < SPLATTER_ID_MIN || k > SPLATTER_ID_MAX) return null;
  return SPLATTER_DECODE_TABLE[k] ?? null;
}

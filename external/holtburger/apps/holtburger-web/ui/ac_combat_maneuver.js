/**
 * AC CombatManeuverTable lookup runtime.
 *
 * Wraps `fetch_combat_maneuver_table(id)` with a small JS layer that
 * indexes the flat list ACE ships into a Stance → AttackHeight →
 * AttackType → [MotionCommand] tree, matching how
 * `Source/Network/Structure/CombatManeuverTable.cs::GetMotion`
 * dispatches.
 *
 *   - `loadCombatManeuverTable(id)`  → Promise<CmtRuntime | null>
 *   - `getCmt()`                     → CmtRuntime | null  (sync)
 *   - `getCombatManeuver(stance, attackHeight, attackType, powerLevel)`
 *                                    → motion_command u32 | null
 *
 * The retail combat table at `0x30000000` is the only canonical record;
 * private servers can ship others but we default to it.
 *
 * `motion_command` is a raw u32 enum code (see ACE `MotionCommand`).
 * Replaying the motion on a Three.js rig is a separate concern — this
 * runtime is the LOOKUP only. Callers feed the returned u32 to
 * `entityManager.setSwingMotion?.(localGuid, motionCmd)` (deferred — for
 * now picking.js still falls back to the vibe-pose `setSwingPose` if the
 * lookup miss-fires or motion playback isn't wired).
 */

export const DEFAULT_CMT_ID = 0x30000000;

// F6-1 (2026-06-09) — `?cmtStanceMask` — **DEFAULT-ON since the 2026-07-27
// audit**; `?cmtStanceMask=off` is the escape hatch. (The "default OFF" note
// that used to head this block was stale from the day it shipped: the reader
// below is `!== "off"`, which reads ON whenever the param is ABSENT. Corrected
// R9 2026-08-03 against docs/url-flags.md:340, which is the authority for a
// shipped default — no behaviour change here, only the comment.) The CMT tree is
// keyed by the FULL MotionStance u32 (e.g. 0x8000003C) but every caller
// passes the low-16 stance (0x3C — `__getCurrentStanceLow()` /
// picking.js), so getCombatManeuver missed at the stance level 100% of the
// time and the local melee swing always fell back to the canned "vibe pose"
// arm tween instead of the real SlashHigh/BackhandMed/ThrustLow clip. When
// ON, both the tree keys and the lookup are masked to low-16 so the
// (stance, height, type, power) lookup resolves — which is what lights up the
// real swing animations. docs/url-flags.md:340 records it as on-by-default
// with the 1070 eye-test still pending.
const CMT_STANCE_MASK = (() => {
  try {
    return typeof window !== "undefined" && window.location &&
      new URLSearchParams(window.location.search).get("cmtStanceMask")?.toLowerCase() !== "off";
  } catch (_) {
    return false;
  }
})();
const cmtStanceKey = (style) =>
  CMT_STANCE_MASK ? ((style >>> 0) & 0xffff) : (style >>> 0);

/**
 * @typedef {Object} CmtRuntime
 * @property {number} id
 * @property {Array<{style: number, attack_height: number, attack_type: number, motion: number}>} maneuvers
 * @property {Map<number, Map<number, Map<number, number[]>>>} tree — stance → height → type → motion candidates
 */

// Module-scoped cache. Map<tableId, runtime|null>.
const runtimes = new Map();
const inFlight = new Map();

/**
 * Load + index a CombatManeuverTable. Idempotent — concurrent
 * callers share one wasm fetch.
 *
 * @param {number} tableId — default 0x30000000 (the only retail record).
 * @returns {Promise<CmtRuntime | null>}
 */
export async function loadCombatManeuverTable(tableId = DEFAULT_CMT_ID) {
  const cached = runtimes.get(tableId);
  if (cached !== undefined) return cached;

  const pending = inFlight.get(tableId);
  if (pending) return pending;

  const promise = (async () => {
    // R9 (2026-08-03) — yield once so the `inFlight.set(...)` below has run
    // before this body (and its `finally`) executes. Without it the
    // synchronous wasm-missing early return fired `inFlight.delete` BEFORE
    // the matching set, and the set then pinned a settled promise. Same
    // ordering hazard ui/ac_layout.js documents on loadLayout.
    await Promise.resolve();
    try {
      const wasm = window.__hbWasm ?? window.__wasm ?? null;
      // R9 — "wasm isn't ready yet" is transient (plugins mount before
      // init_resource_source resolves); memoising it as `null` blanked this
      // record for the WHOLE session with no way back. Unproven failures are
      // NOT cached — only the authoritative DAT answers below are. Same rule
      // as ui/ac_icon_cache.js §P0.4 / LEAK-03 and ui/ac_layout.js.
      if (!wasm?.fetch_combat_maneuver_table) return null;
      const json = await wasm.fetch_combat_maneuver_table(tableId >>> 0);
      const data = JSON.parse(json);
      if (!data || !Array.isArray(data.maneuvers)) {
        try { window.__diag?.combat?.onLoadFailed?.({ tableId, error: "no maneuvers", source: "empty" }); } catch (_) {}
        runtimes.set(tableId, null);
        return null;
      }
      const runtime = _buildRuntime(tableId, data);
      runtimes.set(tableId, runtime);
      try {
        window.__diag?.combat?.onLoadSucceeded?.({
          tableId,
          maneuverCount: runtime.maneuvers.length,
          stanceCount: runtime.tree.size,
        });
      } catch (_) {}
      return runtime;
    } catch (err) {
      console.warn(`[ac-combat] CMT 0x${tableId.toString(16)} load failed:`, err);
      try { window.__diag?.combat?.onLoadFailed?.({ tableId, error: err, source: "fetch" }); } catch (_) {}
      return null; // not cached — a later call retries
    } finally {
      inFlight.delete(tableId);
    }
  })();
  inFlight.set(tableId, promise);
  return promise;
}

/**
 * Sync cache accessor. Returns the cached runtime or `null`.
 */
export function getCmt(tableId = DEFAULT_CMT_ID) {
  const v = runtimes.get(tableId);
  return v === undefined ? null : v;
}

/**
 * Resolve a (stance, attackHeight, attackType) tuple to one motion
 * command. ACE example: SwordCombat+Medium+Slash returns
 * `[SlashMed, BackhandMed]` — `motions[0]` is the higher-powered swing
 * and `motions[1]` is the lower-powered backhand. The picker below
 * mirrors ACE's `Player_Melee.GetSwingAnimation`.
 *
 * ## Algorithm (ground-truth: ACE)
 *
 * Cited from
 * `~/ace-server/Source/ACE.Server/WorldObjects/Player_Melee.cs:440-475`
 * (in-repo copy at
 * `external/ACE/Source/ACE.Server/WorldObjects/Player_Melee.cs:440`,
 * verified identical 2026-05-26):
 *
 * ```csharp
 * var subdivision = 0.33f;
 * if (weapon != null) {
 *   AttackType = weapon.GetAttackType(...);
 *   if (weapon.IsThrustSlash) subdivision = 0.66f;
 * }
 * var motions = CombatTable.GetMotion(stance, height, attackType, prevMotion);
 * // higher-powered animation always in first slot
 * var motion = motions.Count > 1 && PowerLevel < subdivision ? motions[1] : motions[0];
 * PrevMotionCommand = motion;
 * ```
 *
 * `IsThrustSlash` is defined at
 * `~/ace-server/Source/ACE.Server/WorldObjects/WorldObject_Weapon.cs:1039-1048`
 * as "weapon's `W_AttackType` contains `Slash|Thrust` (or the
 * `DoubleSlash|DoubleThrust` / `TripleSlash|TripleThrust` combos)".
 * That bitmask is `PropertyInt::AttackType = 45` — NOT surfaced on
 * the inventory wire today (see TODO at
 * `ui/ac_attack_type_for_weapon.js`), so the JS picker defaults
 * `subdivision = 0.33` and accepts an optional `isThrustSlash` arg
 * for callers that have weapon-level bitmask info.
 *
 * Retail `acclient.c` (`CombatManeuverTable::Get` at line 407721 +
 * call site 408537) loads the table for `PlayerInReadyPosition()`
 * but does NOT pick a motion from it client-side — selection is
 * server-authoritative. ACE's server picks; the client just plays
 * the animation the server sends back via `kind=19 swing` events.
 * Our local-player swing path is purely cosmetic prediction.
 *
 * Retail's `prevMotion`-alternation comment in
 * `~/ace-server/Source/ACE.DatLoader/FileTypes/CombatManeuverTable.cs:88-101`
 * is commented out; the active code path returns the whole list at
 * line 106 (`return maneuvers;`) and lets the caller pick. The
 * `prevMotion` parameter is preserved on the signature here for
 * forward-compat with a future port of that retail alternation
 * heuristic if servers ever flip it back on.
 *
 * Returns the motion u32 enum code, or `null` if the lookup misses.
 *
 * @param {number} stance        — MotionStance enum
 * @param {number} attackHeight  — AttackHeight enum
 * @param {number} attackType    — AttackType enum
 * @param {number} powerLevel    — 0..1
 * @param {number | null} [prevMotion] — last swing motion u32 (forward-compat; unused in current picker)
 * @param {number} [tableId]     — defaults to DEFAULT_CMT_ID
 * @param {Object} [opts]        — { isThrustSlash?: boolean } — when true, subdivision = 0.66
 * @returns {number | null}
 */
export function getCombatManeuver(stance, attackHeight, attackType, powerLevel = 1.0, prevMotion = null, tableId = DEFAULT_CMT_ID, opts = null) {
  const r = getCmt(tableId);
  if (!r?.tree) return null;
  const heightMap = r.tree.get(cmtStanceKey(stance)); // F6-1: low-16 mask under flag
  if (!heightMap) {
    try { window.__diag?.combat?.onLookupMiss?.({ stance, attackHeight, attackType, reason: "stance" }); } catch (_) {}
    return null;
  }
  const typeMap = heightMap.get(attackHeight >>> 0);
  if (!typeMap) {
    try { window.__diag?.combat?.onLookupMiss?.({ stance, attackHeight, attackType, reason: "height" }); } catch (_) {}
    return null;
  }
  const motions = typeMap.get(attackType >>> 0);
  if (!motions?.length) {
    try { window.__diag?.combat?.onLookupMiss?.({ stance, attackHeight, attackType, reason: "type" }); } catch (_) {}
    return null;
  }
  // Phase 4 (Wave 2, 2026-05-26): port ACE Player_Melee.cs:452-468 picker.
  // `motions[0]` is the higher-powered swing (e.g. SlashMed), `motions[1]`
  // the lower-powered backhand (e.g. BackhandMed). At low power
  // (powerLevel < subdivision) we play the backhand; at high power we
  // play the main swing. Single-candidate rows pass through.
  const p = Math.max(0, Math.min(1, powerLevel));
  const subdivision = opts?.isThrustSlash ? 0.66 : 0.33;
  let idx = 0;
  if (motions.length > 1 && p < subdivision) {
    idx = 1;
  }
  const motion = motions[idx];
  try {
    window.__diag?.combat?.onLookupHit?.({
      tableId: r.id,
      stance,
      attackHeight,
      attackType,
      motion,
      powerLevel: p,
      candidates: motions.length,
      candidateIdx: idx,
      subdivision,
      prevMotion: (prevMotion ?? 0) >>> 0,
    });
  } catch (_) {}
  return motion;
}

/**
 * Diag-layer accessor — returns a snapshot of currently-cached tables
 * + their indexing summary. Used by `scene3d/diag/combat.js`.
 */
export function getCombatDiagSnapshot() {
  return {
    tables: Array.from(runtimes.entries())
      .filter(([, r]) => r !== null)
      .map(([tid, r]) => ({
        tableId: tid,
        maneuverCount: r.maneuvers.length,
        stanceCount: r.tree.size,
      })),
  };
}

// ---------------------------------------------------------------------
// Internal helpers

function _buildRuntime(tableId, data) {
  // Reindex flat list into Stance → Height → Type → [motion_command].
  const tree = new Map();
  for (const m of data.maneuvers) {
    const s = cmtStanceKey(m.style); // F6-1: low-16 mask under flag (else full u32)
    const h = (m.attack_height >>> 0);
    const t = (m.attack_type >>> 0);
    let heights = tree.get(s);
    if (!heights) { heights = new Map(); tree.set(s, heights); }
    let types = heights.get(h);
    if (!types) { types = new Map(); heights.set(h, types); }
    let motions = types.get(t);
    if (!motions) { motions = []; types.set(t, motions); }
    motions.push(m.motion >>> 0);
  }
  return {
    id: tableId,
    maneuvers: data.maneuvers,
    tree,
  };
}

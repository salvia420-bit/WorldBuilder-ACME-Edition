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
    const wasm = window.__hbWasm ?? window.__wasm ?? null;
    if (!wasm?.fetch_combat_maneuver_table) {
      runtimes.set(tableId, null);
      return null;
    }
    try {
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
      runtimes.set(tableId, null);
      return null;
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
 * command. `powerLevel ∈ [0, 1]` picks among multiple candidate
 * motions (ACE comment example: SwordCombat+Medium+Slash returns
 * `[SlashMed, BackhandMed]`; powerLevel=0.0 → SlashMed,
 * powerLevel=1.0 → BackhandMed).
 *
 * Returns the motion u32 enum code, or `null` if the lookup misses.
 *
 * @param {number} stance        — MotionStance enum
 * @param {number} attackHeight  — AttackHeight enum
 * @param {number} attackType    — AttackType enum
 * @param {number} powerLevel    — 0..1
 * @param {number} [tableId]     — defaults to DEFAULT_CMT_ID
 * @returns {number | null}
 */
export function getCombatManeuver(stance, attackHeight, attackType, powerLevel = 1.0, tableId = DEFAULT_CMT_ID) {
  const r = getCmt(tableId);
  if (!r?.tree) return null;
  const heightMap = r.tree.get(stance >>> 0);
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
  const p = Math.max(0, Math.min(1, powerLevel));
  const idx = motions.length === 1 ? 0 : Math.min(motions.length - 1, Math.floor(p * motions.length));
  const motion = motions[idx];
  try { window.__diag?.combat?.onLookupHit?.({ tableId: r.id, stance, attackHeight, attackType, motion, powerLevel: p, candidates: motions.length }); } catch (_) {}
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
    const s = (m.style >>> 0);
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

/**
 * Spell cast-sequence lookup — Wave 14 / Phase 45.
 *
 * Resolves a SpellId u32 to the ordered list of scarab-windup motions
 * + final talisman cast gesture that the renderer should chain on the
 * caster's rig. Wave 13 / Phase 42 shipped a hand-rolled "both arms up"
 * vibe tween (`EntityManager.setCastPose`) as a placeholder; Phase 45
 * replaces it with the real per-spell motion sequence derived from
 * each spell's SpellFormula component chain.
 *
 * ## Why this helper exists
 *
 * Retail AC drives cast-time gestures off the spell's component list
 * (`SpellFormula.Components[]` — Pyreal scarab + secondary scarabs +
 * herb + tapers + talisman). Each scarab maps to a windup gesture
 * (e.g. `MagicPowerUp01`) and the talisman maps to the final cast
 * gesture (e.g. `MagicBlast`). The algorithm is fully captured by
 * ACE:
 *
 *   `Source/ACE.Server/WorldObjects/Player_Magic.cs` ~605-689 +
 *   `Source/ACE.Server/Entity/SpellFormula.cs` ~245-287 (cast-time
 *   gesture sequencing).
 *
 * Two retail edge cases the data generator (Agent AP) bakes into the
 * `spell-cast-sequence.json` map:
 *
 *   - **FastCast** spells (`SpellFlags.FastCast` bit set) skip ALL
 *     windup gestures and play ONLY the talisman cast gesture. JSON
 *     emits `fastCast: true` + `windupGestures: []`.
 *
 *   - **Lead-scarab exemption** — the Lead scarab (used by tier-1
 *     spells such as `Lightning Bolt I` — SpellId 75) is documented
 *     in ACE as "no windup gesture; only the final cast". The
 *     generator filters Lead-only spells the same way FastCast spells
 *     are emitted (empty windup, cast-only). This isn't a one-off
 *     hack — it mirrors ACE's `SpellFormula.GetGestureMotionsList`
 *     short-circuit when the only scarab is Lead.
 *
 * ## Cast-motion uniformity vs cast-sequence
 *
 * `ac_spell_shape.js` (Wave 5 Phase 12) classifies the **projectile
 * shape** (Bolt / Arc / Streak / …) because that's what differs by
 * SpellId on the projectile-spawn side. The cast wind-up motion does
 * NOT vary by projectile shape — but it DOES vary by component chain.
 * The two helpers are complementary:
 *
 *   - `classifySpell(spellId)` → `{school, shape, level}` (Phase 12)
 *   - `getCastSequence(spellId)` → `{school, shape, level, fastCast,
 *     windupGestures[], castGesture, totalDurationS}` (this module)
 *
 * Both lazy-load JSON tables from `./data/`. Keep them independent —
 * a future renderer pass might consult `shape` for projectile spawn
 * AND `windupGestures[]` for the cast wind-up animation in the same
 * frame.
 *
 * ## Data source
 *
 * `data/spell-cast-sequence.json` is generated in parallel by Phase 44
 * (Agent AP) from `data/spells-catalog.json` cross-referenced with
 * ACE's `SpellFormula.cs` component → gesture mapping. See the
 * generator's header for the full mapping table (scarab → motion
 * 0x__...., name = `MagicPowerUp01` / `MagicPowerUp02` / etc.).
 *
 * ## Hard scope (Phase 45)
 *
 * This module owns the lookup + a tiny lazy loader. The chain-playback
 * runtime lives in `scene3d/entities.js::playCastSequence` (Phase 45,
 * same wave) and the picking-side dispatch lives in
 * `scene3d/picking.js`. The vibe-pose fallback `setCastPose` stays as
 * the safety net when the JSON isn't loaded yet or the SpellId is not
 * in the sequence map.
 *
 * Authored 2026-05-26 for Wave 14 Phase 45 (Agent AQ).
 */

/**
 * Lazy-loaded cast-sequence table — fetched on first
 * `getCastSequence` call. Mirrors the `ac_spell_shape.js` cache
 * pattern (Phase 12) so the same Node-side / browser-side preload
 * contract holds:
 *
 *   - Browser: first call kicks `_loadSequenceAsync` and returns null
 *     synchronously. Subsequent calls (after the fetch resolves)
 *     return the real entry.
 *   - Node tests: call `_loadSequenceSync(table)` before any
 *     `getCastSequence` to avoid the async dance.
 *
 * Wave 18 / Phase 52 added three per-spell fields (`casterEffect`,
 * `targetEffect`, `formulaScale`) sourced from `SpellBase.cs:36-37`
 * + `SpellFormula.cs:313 Scale`. See module docs above for semantics.
 *
 * @type {Record<string, {
 *   school: string,
 *   shape: string,
 *   level: number,
 *   fastCast: boolean,
 *   windupGestures: Array<{motion: string, name: string, durationS: number}>,
 *   castGesture: {motion: string, name: string, durationS: number},
 *   totalDurationS: number,
 *   casterEffect: number,
 *   targetEffect: number,
 *   formulaScale: number,
 * }> | null}
 */
let _sequenceTable = null;
let _pendingFetch = null;

const DEFAULT_TABLE_URL = "./data/spell-cast-sequence.json";

/**
 * @internal Browser-side async loader. Returns the same promise on
 * concurrent calls so we don't double-fetch.
 *
 * @param {string} [url] override the default table URL
 * @returns {Promise<Record<string, object>>}
 */
async function _loadSequenceAsync(url) {
  if (_sequenceTable) return _sequenceTable;
  if (_pendingFetch) return _pendingFetch;
  _pendingFetch = fetch(url || DEFAULT_TABLE_URL, { cache: "force-cache" })
    .then((r) => {
      if (!r.ok) throw new Error(`spell-cast-sequence fetch ${r.status}`);
      return r.json();
    })
    .then((table) => {
      // The generator (gen-spell-cast-sequence.cjs) nests the per-spell
      // entries under `sequences` alongside `_comment`/`_spell_count`
      // metadata; older synthetic test tables are flat. Storing the
      // wrapper verbatim made every browser-side lookup miss (spellId
      // keys aren't top-level), silently killing the whole gesture
      // chain — unwrap before caching.
      _sequenceTable = table.sequences ?? table;
      _pendingFetch = null;
      return _sequenceTable;
    })
    .catch((err) => {
      _pendingFetch = null;
      throw err;
    });
  return _pendingFetch;
}

/**
 * Synchronously preload the cast-sequence table from a JS object —
 * used by Node-side tests that read `data/spell-cast-sequence.json`
 * with `fs.readFile` and want `getCastSequence` to be synchronous.
 *
 * @param {Record<string, object>} table
 * @returns {void}
 */
export function _loadSequenceSync(table) {
  if (!table || typeof table !== "object") {
    throw new Error("_loadSequenceSync: table must be a non-null object");
  }
  // Accept both the generator's `{sequences: {...}}` wrapper and the
  // flat synthetic tables the Node tests build (same unwrap as the
  // async loader above).
  _sequenceTable = table.sequences ?? table;
  _pendingFetch = null;
}

/**
 * Reset the cached table — for tests that want to verify async
 * loading works.
 *
 * @returns {void}
 */
export function _resetSequenceTable() {
  _sequenceTable = null;
  _pendingFetch = null;
}

/**
 * Has the table been loaded yet? Browser callers (`playCastSequence`
 * in entities.js) check this before chaining so the very-first cast
 * doesn't silently fall through to vibe-pose just because the JSON
 * fetch is still in flight.
 *
 * @returns {boolean}
 */
export function isCastSequenceLoaded() {
  return _sequenceTable !== null;
}

/**
 * Look up the cast sequence for a SpellId. Returns the full entry or
 * `null` if the table isn't loaded OR the SpellId is not in the map.
 *
 * Per Phase 44 contract:
 *   - `school`, `shape`, `level` — mirror `classifySpell`'s fields
 *     (string school name e.g. `"War"`, shape e.g. `"Bolt"`, 1-8).
 *   - `fastCast` — boolean; if true `windupGestures` is empty by
 *     construction.
 *   - `windupGestures` — ordered list of `{motion, name, durationS}`
 *     scarab windups. Empty for FastCast + Lead-exempt spells.
 *   - `castGesture` — final talisman cast `{motion, name,
 *     durationS}`. Always present.
 *   - `totalDurationS` — sum of all windup durations + cast duration,
 *     pre-computed by the generator so callers don't have to reduce
 *     the list every frame.
 *
 * Wave 18 / Phase 52 contract additions:
 *   - `casterEffect` (u32, default 0) — `SpellBase.CasterEffect`
 *     (`ACE.DatLoader/Entity/SpellBase.cs:36`). PlayScript enum ID
 *     (NOT a 0x33xxxxxx PhysicsScript DID) — resolves to a real
 *     particle script via the CASTER entity's PhysicsScriptTable
 *     lookup (Wave 17 path). 0 = no caster effect.
 *   - `targetEffect` (u32, default 0) — `SpellBase.TargetEffect`
 *     (`SpellBase.cs:37`). Fires on the TARGET on hit. Out-of-scope
 *     wiring for Wave 18 (see `playCastSequence` TODO breadcrumb).
 *   - `formulaScale` (f32, 0.05..=1.0) — `Spell.Formula.Scale`
 *     (`ACE.Server/Entity/SpellFormula.cs:313`). Used as the picker
 *     `mod` weight when looking up the caster/target effect in the
 *     entity's PhysicsScriptTable (`acclient.c:336552
 *     PhysicsScriptTableData::GetScript`).
 *
 * Browser-side first-call note: like `classifySpell`, the helper
 * lazy-fetches the table on first use. Callers MUST handle a `null`
 * return — the convention (mirrored by `EntityManager.playCastSequence`)
 * is to fall back to the placeholder `setCastPose` vibe-pose.
 *
 * @param {number | string} spellId — u32 SpellId; numeric or numeric
 *   string. Out-of-range values (NaN, < 0) return `null`.
 * @returns {{
 *   school: string,
 *   shape: string,
 *   level: number,
 *   fastCast: boolean,
 *   windupGestures: Array<{motion: string, name: string, durationS: number}>,
 *   castGesture: {motion: string, name: string, durationS: number},
 *   totalDurationS: number,
 *   casterEffect: number,
 *   targetEffect: number,
 *   formulaScale: number,
 * } | null}
 */
export function getCastSequence(spellId) {
  if (_sequenceTable === null) {
    if (typeof fetch === "function" && !_pendingFetch) {
      _loadSequenceAsync().catch(() => { /* swallow; future call retries */ });
    }
    return null;
  }
  let key;
  if (typeof spellId === "number") {
    if (!Number.isFinite(spellId) || spellId < 0) return null;
    key = String(spellId | 0);
  } else if (typeof spellId === "string") {
    const parsed = spellId.startsWith("0x") || spellId.startsWith("0X")
      ? parseInt(spellId, 16)
      : parseInt(spellId, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    key = String(parsed | 0);
  } else {
    return null;
  }
  const entry = _sequenceTable[key];
  if (!entry) return null;
  // Defensive normalisation — the generator validates these on emit,
  // but a stale table with the field renamed / missing should fail
  // soft (null) rather than crash the renderer mid-cast.
  if (!entry.castGesture || typeof entry.castGesture !== "object") return null;
  return {
    school: entry.school || "None",
    shape: entry.shape || "Self",
    level: entry.level | 0 || 1,
    fastCast: !!entry.fastCast,
    windupGestures: Array.isArray(entry.windupGestures)
      ? entry.windupGestures
      : [],
    castGesture: entry.castGesture,
    totalDurationS: Number.isFinite(entry.totalDurationS)
      ? entry.totalDurationS
      : 1.0,
    // Wave 18 / Phase 52 — defensive default-0 for older fixtures /
    // staler JSON missing the field (back-compat with pre-Wave-18
    // synthetic test tables); the resolver chain in
    // `entities.js::playCastSequence` treats 0 as "no effect, skip
    // the resolver spawn" so this is the safe no-op default.
    casterEffect: (entry.casterEffect >>> 0) || 0,
    targetEffect: (entry.targetEffect >>> 0) || 0,
    formulaScale: Number.isFinite(entry.formulaScale)
      ? entry.formulaScale
      : 1.0,
  };
}

// ---------------------------------------------------------------------
// Inline unit tests — run with:
//   cd apps/holtburger-web/
//   node test_ac_spell_cast_sequence.mjs
// (sibling test file mirroring the Phase 12 pattern). The tests below
// build a small synthetic table to exercise lookup-hit / lookup-miss /
// FastCast / Lead-exempt / multi-component cases without depending on
// the real `data/spell-cast-sequence.json` (which Agent AP generates
// in parallel — Phase 45's test contract is "consume the schema",
// not "validate the data").
// ---------------------------------------------------------------------

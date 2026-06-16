// =============================================================================
// ACPlugin PR-4 (2026-05-27) — Character class (port of Character.cs)
// =============================================================================
//
// Direct port of `external/chorizite/ACPlugin/API/WorldObjects/Character.cs`
// (vendored HEAD 1341660). Bridges the 40+ S2C handler chain Wave C.2
// deferred — when WorldState (PR 2) dispatches a WorldObject whose GUID is
// the local player's, it spawns as a Character; the Character's
// `update*` / `applyEnchantment` / etc. methods receive the per-handler
// dispatches forwarded from PR 2's WorldState bus.
//
// Citations:
//   - `Character.cs:LLL` references `external/chorizite/ACPlugin/API/
//     WorldObjects/Character.cs:LLL` (vendored HEAD 1341660).
//   - `handoff §3 rowN` references `external/holtburger/docs/
//     chorizite-reading-guide-summary-2026-05-27.md` §3.
//   - `WaveC.2 lib.rs:LLL` references the wasm exports in
//     `apps/holtburger-web/src/lib.rs`.
//
// Load-bearing semantics replicated EXACTLY (handoff §3):
//   1. **Vitae 1.0 = no vitae, 0.95 = 5% vitae** (`Character.cs:80-88` +
//      `SkillInfo.cs:138-140`). Don't invert — SkillInfo MULTIPLIES by it,
//      so a value < 1.0 reduces effective skill.
//   2. **UpdateVital even/odd parity** (`Character.cs:721`): vitals come
//      as (current, max) at adjacent IDs; even=current, odd=max; the
//      `(int)key % 2 == 0` check is load-bearing.
//   3. **Enchantment tiebreak** (`Character.cs:232-239`): per Wave C.2
//      handoff §7 — set-spells beat non-set; within set sort by SpellId
//      desc; within non-set sort by StartTime desc; Power desc primary
//      with Level8AuraSelfSpells secondary.
//   4. **ApplyEnchantment cooldown discriminator** (`Character.cs:619`):
//      `StatMod.Type & EnchantmentTypeFlags.Cooldown (0x1000000)` routes
//      to SharedCooldowns; otherwise to AllEnchantments. One wire packet
//      carries both. (PR 4: discriminator wired; wasm-side payload
//      extension for cooldown statMod arrives in Wave E.)
//   5. **`SharedCooldown.Id = (layeredId.Id << 20 >> 20)`** sign-extends
//      low 12 bits (`SharedCooldown.cs:55`). Ported exactly via signed
//      32-bit shift semantics (`(id << 20) >> 20` in JS is signed).
//   6. **PrivateUpdate* vs Update*** (`Character.cs:191-213` vs
//      `World.cs:109-131`): public = broadcast; private = only sent to
//      object's owner. Subscription target differs (Character vs
//      World) — DON'T merge. PR 4 wires the Character side; PR 2 owns
//      World.
//   7. **`_setSpells` cutoff `>= 4730u`** (`Character.cs:42`) — use Wave
//      C.2's `spellSetCutoff()` wasm export, never inline the magic.
//
// Math: use Wave C.2 wasm exports (`computeAttributeCurrent` etc.) for
// derived values. Don't re-derive in JS.
// =============================================================================

import { Container } from './container.js';

// ─── PropertyInt key constants (only the ones Character uses) ───
// Sourced from `crates/holtburger-common/src/properties/property_keys/ints.rs`.
const PROP_INT_HERITAGE_GROUP = 188;  // PropertyInt::HeritageGroup
const PROP_INT_PHYSICS_STATE  = 107;  // PropertyInt::PhysicsState — for Item_SetState

// PhysicsState bit for `Hidden` — `Character.cs:462` checks
// `!e.NewState.HasFlag(PhysicsState.Hidden)`. Per
// `crates/holtburger-common/src/properties/object.rs::PhysicsState::HIDDEN`.
const PHYSICS_STATE_HIDDEN = 0x00000040;

// `EnchantmentTypeFlags.Cooldown` per
// `crates/holtburger-common/src/properties/combat.rs:118`.
const ENCHANTMENT_TYPE_COOLDOWN     = 0x1000000;
const ENCHANTMENT_TYPE_SKILL        = 0x0000010;
const ENCHANTMENT_TYPE_ATTRIBUTE    = 0x0000001;
const ENCHANTMENT_TYPE_SECOND_ATT   = 0x0000002;
const ENCHANTMENT_TYPE_MULTIPLE     = 0x0002000;
const ENCHANTMENT_TYPE_ADDITIVE     = 0x0008000;
const ENCHANTMENT_TYPE_MULTIPLICATIVE = 0x0004000;

// Constants from Character.cs:20, 22-30. Use `level8AuraSelfSpells()` wasm
// export at runtime when available (it returns the exact authoritative list
// from Wave C.2); fall back to the inline list if the export is missing
// (tests, pre-wasm-ready bootstrap, etc.). The inline list mirrors
// `Character.cs:23-30`.
const FALLBACK_LEVEL_8_AURA_SELF_SPELLS = Object.freeze([
  4395, 4400, 4405, 4414, 4417, 4418,
]);
const FALLBACK_VITAE_SPELL_ID = 666;     // Character.cs:20

/**
 * Browser-side mirror of `Chorizite/ACPlugin/API/WorldObjects/Character.cs`.
 *
 * Extends Container (handoff §3 hierarchy: "Character + Creature extend
 * Container"). Owns the 8 attribute / 3 vital / N skill / vitae /
 * enchantment / cooldown state for the LOCAL player.
 *
 * Spawn rule: WorldState (PR 2) checks the kind=1 `PLAYER_SPAWNED`
 * payload's GUID; when that GUID later arrives via
 * `dispatchItemCreateObject`, the WorldState constructs a `Character`
 * instead of the generic typed-subclass dispatch. See
 * `world-state.js::dispatchItemCreateObject`'s `localPlayerGuid` branch.
 *
 * Public surface (mirrors `Character.cs:53-110`):
 *   - `Skills: Map<SkillType, SkillBundle>`
 *   - `Attributes: Map<AttributeType, AttributeBundle>`
 *   - `Vitals: Map<VitalType, VitalBundle>`  (keyed by ODD canonical id)
 *   - `AllEnchantments: Map<layeredSpellId, EnchantmentRecord>`
 *   - `SharedCooldowns: Map<layeredSpellId, CooldownRecord>`
 *   - `Options1: number` (CharacterOptions1 bitfield)
 *   - `vitae: number` (1.0=none; 0.95=5%; per handoff §3 row 4)
 *   - `inPortalSpace: bool` (true at login per `Character.cs:93`)
 *   - `heritage: number` getter (PropertyInt.HeritageGroup)
 *
 * Events (mirrors `Character.cs:112-176`): emitted via `dispatchEvent`
 *   - `vitaeChanged`         (CustomEvent{detail:{vitae, oldVitae}})
 *   - `vitalChanged`         (CustomEvent{detail:{type, value, oldValue}})
 *   - `enchantmentChanged`   (CustomEvent{detail:{type, layeredSpellId, spellId, enchantment}})
 *   - `sharedCooldownChanged` (CustomEvent{detail:{type, cooldown}})
 *   - `portalSpaceEntered`   (CustomEvent{detail:{}})
 *   - `portalSpaceExited`    (CustomEvent{detail:{}})
 *   - `death`                (CustomEvent{detail:{text, killerId}})
 *
 * The Character is itself an `EventTarget`-compatible surface (via
 * Container → Item → WorldObject — none of which currently inherit
 * EventTarget). Per the porting guide, plugins use the bus on
 * `client.events.on('vitaeChanged', ...)` instead of binding directly
 * to the Character. WorldState forwards the Character bus emissions onto
 * the client bus so the existing event API is preserved.
 */
export class Character extends Container {
  /**
   * @param {number} id        Local player GUID
   * @param {number} classId   Local player wcid
   * @param {object} taxonomy  WorldObjectTaxonomy (PR 1)
   * @param {object} enums     ChoriziteEnums (PR 1)
   * @param {object} manager   WorldObjectManager (PR 1)
   */
  constructor(id, classId, taxonomy = null, enums = null, manager = null) {
    super(id, classId, taxonomy, enums, manager);

    // `Character.cs:58` — CharacterOptions1 bitfield from
    // Login_PlayerDescription.PlayerModule.Options.
    this.options1 = 0;

    // `Character.cs:63-73` — three typed dictionaries.
    /** @type {Map<number, SkillBundle>} keyed by SkillType u32 */
    this.skills = new Map();
    /** @type {Map<number, AttributeBundle>} keyed by AttributeType u32 */
    this.attributes = new Map();
    /** @type {Map<number, VitalBundle>} keyed by ODD canonical VitalType u32 */
    this.vitals = new Map();

    // `Character.cs:53` — vitae (1.0 = none; 0.95 = 5% vitae). Counter-
    // intuitive — DO NOT INVERT (handoff §3 row 4).
    this._vitae = 1.0;

    // `Character.cs:93` — portal space (loading-screen). True at login.
    this.inPortalSpace = true;

    // `Character.cs:98` — every enchantment received, including ones
    // overridden by higher-power same-category entries. Keyed by
    // layered-spell-id `(spellId << 16) | layer`.
    /** @type {Map<number, EnchantmentRecord>} */
    this.allEnchantments = new Map();

    // `Character.cs:104` — shared item cooldowns. Same key encoding as
    // allEnchantments; one wire packet carries both, discriminated by
    // `StatMod.Type & EnchantmentTypeFlags.Cooldown`.
    /** @type {Map<number, CooldownRecord>} */
    this.sharedCooldowns = new Map();

    // Bus surface — Character extends EventTarget-like via the bus we
    // create on demand. We don't extend EventTarget directly (the
    // chain WorldObject→Item→Container doesn't), so we hold an inner
    // bus and re-export the addEventListener/removeEventListener/
    // dispatchEvent calls.
    this._bus = new EventTarget();

    // Lazy spell-set cache (mirrors `Character.cs:33-51`). Populated
    // on first `getActiveEnchantments` call via `wasmHandle.spellSetIds()`
    // when a session handle is wired through the manager; falls back to
    // an empty set otherwise (the tiebreak still works without it,
    // it just doesn't promote set-spells over non-set within a
    // category).
    this._setSpells = null;

    // Cached references to the Wave C.2 wasm exports. Resolved lazily
    // from globalThis so tests can inject mocks via global setup before
    // the wasm module loads; production uses the real module.
    this._wasmExports = null;
  }

  // ─── Public surface (`Character.cs:53-110`) ───

  /**
   * `Character.cs:79-88` — vitae getter/setter pair. Setting to a new
   * value fires `vitaeChanged` with `{vitae, oldVitae}`.
   *
   * **Load-bearing per handoff §3 row 4:** 1.0 = no vitae,
   * 0.95 = 5% vitae. Don't invert. `SkillInfo.cs:138-140`
   * MULTIPLIES `current` by this — a value < 1.0 reduces effective skill.
   *
   * @returns {number}
   */
  get vitae() { return this._vitae; }
  set vitae(value) {
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    if (this._vitae !== v) {
      const old = this._vitae;
      this._vitae = v;
      this._bus.dispatchEvent(new CustomEvent('vitaeChanged', {
        detail: { vitae: v, oldVitae: old },
      }));
    }
  }

  /**
   * `Character.cs:110` — heritage group convenience. Reads
   * PropertyInt.HeritageGroup off the typed property store.
   */
  get heritage() {
    return this.intValue(PROP_INT_HERITAGE_GROUP, 0);
  }

  /**
   * Event-bus accessors. Re-export so plugin code can bind directly to
   * the Character or to the client.events bus (WorldState forwards).
   */
  addEventListener(...a)    { return this._bus.addEventListener(...a); }
  removeEventListener(...a) { return this._bus.removeEventListener(...a); }
  dispatchEvent(...a)       { return this._bus.dispatchEvent(...a); }

  /**
   * `Character.cs:230-240` — list active enchantments. Returns one entry
   * per `(SpellCategory)` — the highest-priority record per category per
   * the load-bearing tiebreak (handoff §3 row 7):
   *
   *   1. Power desc (primary)
   *   2. Level8AuraSelfSpells contains SpellId (boolean: true beats false)
   *   3. SetSpells contains SpellId ? SpellId desc : StartTime desc
   *   4. First()
   *
   * Per Wave C.2 §7 open question — the C# LINQ projection mixes uint
   * and double in `Comparer<object>.Default`. The mathematically correct
   * port (and what Wave C's Rust impl does) is the segregation pattern:
   * set-spells beat non-set; within set sort by SpellId desc; within
   * non-set sort by StartTime desc.
   *
   * @param {string|number|null} [filterKind] optional 'skill'/'attribute'/'vital' filter
   * @param {number} [filterId]               id when filterKind given
   * @returns {EnchantmentRecord[]}
   */
  getActiveEnchantments(filterKind = null, filterId = 0) {
    const setSpells = this._getSetSpellsSnapshot();
    const level8 = this._getLevel8AuraSelfSpells();
    const dbg = typeof window !== "undefined" && window.__debugEnchantments === true;
    if (dbg) {
      console.log(`[character.getActiveEnchantments] allEnchantments.size=${this.allEnchantments.size} filter=${filterKind ?? "(none)"} id=${filterId}`);
    }

    // Filter pre-pass (`Character.cs:247-258` / 265-279 / 286-297).
    const filtered = [];
    for (const e of this.allEnchantments.values()) {
      if (filterKind === 'skill') {
        if ((e.type & ENCHANTMENT_TYPE_SKILL) === 0) continue;
        if (e.statKey !== filterId) continue;
      } else if (filterKind === 'attribute') {
        if ((e.type & ENCHANTMENT_TYPE_ATTRIBUTE) === 0) continue;
        // MultipleStat enchantments hit every attribute regardless of statKey.
        if (e.statKey !== filterId && (e.type & ENCHANTMENT_TYPE_MULTIPLE) === 0) continue;
      } else if (filterKind === 'vital') {
        if ((e.type & ENCHANTMENT_TYPE_SECOND_ATT) === 0) continue;
        if (e.statKey !== filterId) continue;
      }
      filtered.push(e);
    }
    if (dbg) {
      console.log(`[character.getActiveEnchantments] filtered.length=${filtered.length}`);
    }

    // Group by category (`Character.cs:232`).
    const byCategory = new Map();
    for (const e of filtered) {
      const cat = e.spellCategory | 0;
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(e);
    }
    if (dbg) {
      const catSizes = Array.from(byCategory.entries()).map(([c, g]) => `cat=${c}:${g.length}`);
      console.log(`[character.getActiveEnchantments] categories=${catSizes.join(", ") || "(none)"}`);
    }

    // Per-category resolve via the load-bearing tiebreak.
    const winners = [];
    for (const [cat, group] of byCategory.entries()) {
      group.sort((a, b) => Character._tiebreakDescending(a, b, level8, setSpells));
      const winner = group[0];
      winners.push(winner);
      if (dbg && group.length > 1) {
        const summary = group.map((e) => `spellId=${e.spellId} pwr=${e.power} layer=${e.layer} start=${e.startTime}`).join(" | ");
        console.log(`[character.getActiveEnchantments] cat=${cat} tiebreak winner=spellId=${winner.spellId} pwr=${winner.power} of [${summary}]`);
      }
    }
    return winners;
  }

  /**
   * Three Character.cs sigs collapsed: `Character.cs:304-330` —
   * additive modifier for an attribute/skill/vital.
   *
   * @param {'attribute'|'skill'|'vital'} kind
   * @param {number} id
   * @returns {number} sum of Additive modifiers from active enchantments
   */
  getEnchantmentsAdditiveModifier(kind, id) {
    let sum = 0;
    for (const e of this.getActiveEnchantments(kind, id)) {
      if ((e.type & ENCHANTMENT_TYPE_ADDITIVE) !== 0) {
        sum += (e.statValue | 0);
      }
    }
    return sum;
  }

  /**
   * `Character.cs:336-372` — multiplicative modifier (product) for an
   * attribute/skill/vital.
   *
   * @param {'attribute'|'skill'|'vital'} kind
   * @param {number} id
   * @returns {number} product of Multiplicative modifiers (starts at 1.0)
   */
  getEnchantmentsMultiplierModifier(kind, id) {
    let mult = 1.0;
    for (const e of this.getActiveEnchantments(kind, id)) {
      if ((e.type & ENCHANTMENT_TYPE_MULTIPLICATIVE) !== 0) {
        mult *= Number(e.statValue);
      }
    }
    return mult;
  }

  // ─── Wave C.2 wasm-export-driven derived stats ───
  //
  // These call the canonical Wave C.2 math wrappers in
  // `apps/holtburger-web/src/lib.rs:15785-16566`. They DO NOT inline the
  // math — drift would silently break the HUD against ACE's
  // server-side values.
  //
  // Pre-condition: wasm module loaded. When called before load (in
  // tests or pre-bootstrap), these return 0 / the base value (no
  // multiplier applied) — defensive fallback.

  /**
   * Effective (buffed) attribute value. Wraps wasm
   * `computeAttributeCurrent(innate, raised, multiplier, additives)` —
   * `Character.cs` uses GetEnchantmentsMultiplierModifier +
   * GetEnchantmentsAdditiveModifier to feed the call.
   *
   * @param {number} attributeType AttributeType u32 (Strength=1..Self=6)
   * @returns {number} buffed value
   */
  currentAttribute(attributeType) {
    const bundle = this.attributes.get(attributeType);
    if (!bundle) return 0;
    const wasm = this._resolveWasm();
    if (!wasm || typeof wasm.computeAttributeCurrent !== 'function') {
      return (bundle.innatePoints | 0) + (bundle.pointsRaised | 0);
    }
    const mult = this.getEnchantmentsMultiplierModifier('attribute', attributeType);
    const add  = this.getEnchantmentsAdditiveModifier('attribute', attributeType);
    return wasm.computeAttributeCurrent(
      bundle.innatePoints >>> 0,
      bundle.pointsRaised >>> 0,
      mult,
      add | 0,
    );
  }

  /**
   * Max vital value (buffed; vitae-folded; with Endurance bonus). Wraps
   * wasm `computeVitalMax`.
   *
   * @param {number} vitalType VitalType u32 (Health=1, Stamina=3, Mana=5)
   * @param {object} [formula] Optional `{attr1, attr2, divisor, useFormula}`
   *                           — when omitted, the canonical ACE formulas
   *                           are inferred from vitalType. NOTE: the
   *                           canonical formula attr ids depend on DAT
   *                           data; pass explicitly when available.
   * @returns {number} buffed max
   */
  maxVital(vitalType, formula = null) {
    const bundle = this.vitals.get(vitalType);
    if (!bundle) return 0;
    const wasm = this._resolveWasm();
    if (!wasm || typeof wasm.computeVitalMax !== 'function') {
      // Defensive fallback — base only.
      return (bundle.initLevel | 0) + (bundle.pointsRaised | 0);
    }
    const f = formula ?? Character._defaultVitalFormula(vitalType);
    const attr1Base = this.attributes.get(f.attr1)?.innatePoints ?? 0;
    const attr2Base = this.attributes.get(f.attr2)?.innatePoints ?? 0;
    const mult = this.getEnchantmentsMultiplierModifier('vital', vitalType);
    const add  = this.getEnchantmentsAdditiveModifier('vital', vitalType);
    return wasm.computeVitalMax(
      vitalType >>> 0,
      bundle.initLevel >>> 0,
      bundle.pointsRaised >>> 0,
      Boolean(f.useFormula),
      Number(f.divisor),
      f.attr1 >>> 0,
      attr1Base >>> 0,
      f.attr2 >>> 0,
      attr2Base >>> 0,
      0,  // enlightenment (Wave C.2 — passed through; populate when wire data lands)
      0,  // gear_max_health (ditto)
      mult,
      this._vitae,
      add | 0,
    );
  }

  /**
   * Effective (buffed; vitae-folded) skill value. Wraps wasm
   * `computeSkillCurrent`. Skill formula bundle must include attr1/attr2
   * + divisor + training class (the canonical skill table provides these
   * via Wave C.2's `skillMinLevel` + the DAT).
   *
   * @param {number} skillType SkillType u32
   * @param {object} [formula] {attr1, attr2, divisor, useFormula}
   * @returns {number} buffed skill
   */
  currentSkill(skillType, formula = null) {
    const bundle = this.skills.get(skillType);
    if (!bundle) return 0;
    const wasm = this._resolveWasm();
    if (!wasm || typeof wasm.computeSkillCurrent !== 'function') {
      return (bundle.initLevel | 0) + (bundle.pointsRaised | 0);
    }
    const f = formula ?? { attr1: 0, attr2: 0, divisor: 1, useFormula: false };
    const attr1Cur = f.attr1 ? this.currentAttribute(f.attr1) : 0;
    const attr2Cur = f.attr2 ? this.currentAttribute(f.attr2) : 0;
    const mult = this.getEnchantmentsMultiplierModifier('skill', skillType);
    const add  = this.getEnchantmentsAdditiveModifier('skill', skillType);
    return wasm.computeSkillCurrent(
      skillType >>> 0,
      bundle.initLevel >>> 0,
      bundle.pointsRaised >>> 0,
      (bundle.training | 0) >>> 0,
      Boolean(f.useFormula),
      Number(f.divisor),
      f.attr1 >>> 0,
      attr1Cur >>> 0,
      f.attr2 >>> 0,
      attr2Cur >>> 0,
      mult,
      this._vitae,
      add | 0,
      0, 0, 0, 0, 0, 0,  // aug bonuses — populate from PropertyInt when wired
    );
  }

  // ─── S2C handler equivalents (`Character.cs:376-610`) ───
  //
  // Each method is invoked by `WorldState` (or its `bindCharacter`
  // helper) when the corresponding wire event arrives. These are NOT
  // the bus event names — they're the C#-side handler bodies.

  /**
   * `Character.cs:380-449` — login player description fold. Hydrates
   * options1, base PropertyInt/Float/etc., then attribute/vital/skill/
   * enchantment lists.
   */
  applyLoginPlayerDescription(payload) {
    if (!payload) return;
    if (typeof payload.options !== 'undefined') {
      this.options1 = payload.options | 0;
    }
    // Property-bundle fold (PropertyInt/Float/Bool/String/Data/Instance/Position).
    // Each is `[key, value]` pairs — mirrors the C# `UpdateStatsTable` calls.
    this._applyPropertyMaps(payload);
    if (Array.isArray(payload.attributes)) {
      for (const a of payload.attributes) this.updateAttribute(a.type | 0, a);
    }
    if (Array.isArray(payload.vitals)) {
      for (const v of payload.vitals) this.updateVital(v.type | 0, v, /*isInitial=*/true);
    }
    if (Array.isArray(payload.skills)) {
      for (const s of payload.skills) this.updateSkill(s.type | 0, s);
    }
    if (Array.isArray(payload.enchantments)) {
      for (const e of payload.enchantments) this.applyEnchantment(e);
    }
  }

  /** `Character.cs:451-453` — log-off → clear all state. */
  applyLogOffCharacter() { this.clear(); }

  /**
   * `Character.cs:455-459` — death broadcast. Filters by `killedId == Id`
   * so remote-death events don't fire the local OnDeath.
   */
  applyCombatHandlePlayerDeath(message, killedId, killerId) {
    if ((killedId | 0) !== (this.id | 0)) return;
    this._bus.dispatchEvent(new CustomEvent('death', {
      detail: { text: message ?? '', killerId: killerId | 0 },
    }));
  }

  /**
   * `Character.cs:461-466` — Item_SetState for self. When the local
   * player's PhysicsState clears the Hidden bit, we just exited portal
   * space.
   */
  applyItemSetState(objectId, newState) {
    if ((objectId | 0) !== (this.id | 0)) return;
    if ((newState & PHYSICS_STATE_HIDDEN) === 0 && this.inPortalSpace) {
      this.inPortalSpace = false;
      this._bus.dispatchEvent(new CustomEvent('portalSpaceExited', { detail: {} }));
    }
    // Mirror onto the property store so the World setters chain reads
    // consistent values.
    this.setIntValue(PROP_INT_PHYSICS_STATE, newState | 0);
  }

  /**
   * `Character.cs:468-471` — Effects_PlayerTeleport (S2C). Sets
   * inPortalSpace=true + fires `portalSpaceEntered`.
   */
  applyEffectsPlayerTeleport() {
    this.inPortalSpace = true;
    this._bus.dispatchEvent(new CustomEvent('portalSpaceEntered', { detail: {} }));
  }

  /**
   * `Character.cs:613-639` — apply an enchantment. **Load-bearing
   * cooldown discriminator** per handoff §3 row 5.
   *
   * `enchantment` accepts the wire shape: `{layeredId, spellId, layer,
   * spellCategory, power, startTime, duration, casterGuid, type,
   * statKey, statValue}`. `type` is the `EnchantmentTypeFlags` bitfield;
   * the Cooldown bit (0x1000000) routes to SharedCooldowns.
   */
  applyEnchantment(enchantment) {
    if (!enchantment) return;
    const spellId = (enchantment.spellId ?? enchantment.spell_id ?? 0) >>> 0;

    // `Character.cs:614-617` — vitae short-circuit. Wave C.2's
    // vitaeSpellId() is 666; use the export when available, else 666.
    const vitaeSpellId = this._getVitaeSpellId();
    if (spellId === vitaeSpellId) {
      // The wire payload's StatMod.Value is the new vitae multiplier.
      const v = Number(enchantment.statValue ?? enchantment.stat_value ?? 1.0);
      this.vitae = v;
      return;
    }

    const layeredId = Character._layeredKey(spellId, enchantment.layer ?? 0);
    const type = (enchantment.type ?? 0) | 0;

    // `Character.cs:619` — cooldown discriminator.
    if ((type & ENCHANTMENT_TYPE_COOLDOWN) !== 0) {
      const cooldown = Character._cooldownFromWire(enchantment);
      this.sharedCooldowns.set(layeredId, cooldown);
      this._bus.dispatchEvent(new CustomEvent('sharedCooldownChanged', {
        detail: { type: /*Added*/ 0, cooldown },
      }));
      return;
    }

    // Regular enchantment route — handoff §3 row 7 tiebreak applies.
    const record = Character._enchantmentFromWire(enchantment);
    this.allEnchantments.set(layeredId, record);
    this._bus.dispatchEvent(new CustomEvent('enchantmentChanged', {
      detail: { type: /*Added*/ 0, layeredSpellId: layeredId, spellId, enchantment: record },
    }));
  }

  /**
   * `Character.cs:641-654` — remove enchantment. Same cooldown
   * discriminator applies. Vitae-remove sets vitae=1 (handoff §3 row 4).
   *
   * @param {object|number} layeredOrId either `{id, layer}` or a u32 key
   */
  removeEnchantment(layeredOrId) {
    let layeredId;
    let spellIdComponent;
    if (typeof layeredOrId === 'number') {
      layeredId = layeredOrId >>> 0;
      spellIdComponent = (layeredId >> 16) >>> 0;
    } else if (layeredOrId) {
      const sid = (layeredOrId.id ?? layeredOrId.spellId ?? 0) >>> 0;
      const ly = (layeredOrId.layer ?? 0) | 0;
      layeredId = Character._layeredKey(sid, ly);
      spellIdComponent = sid;
    } else {
      return;
    }
    if (spellIdComponent === this._getVitaeSpellId()) {
      this.vitae = 1.0;
      return;
    }
    const ench = this.allEnchantments.get(layeredId);
    if (ench) {
      this.allEnchantments.delete(layeredId);
      this._bus.dispatchEvent(new CustomEvent('enchantmentChanged', {
        detail: { type: /*Removed*/ 1, layeredSpellId: layeredId, spellId: spellIdComponent, enchantment: ench },
      }));
    }
    const cooldown = this.sharedCooldowns.get(layeredId);
    if (cooldown) {
      this.sharedCooldowns.delete(layeredId);
      this._bus.dispatchEvent(new CustomEvent('sharedCooldownChanged', {
        detail: { type: /*Removed*/ 1, cooldown },
      }));
    }
  }

  /** `Character.cs:564-568` — bulk apply. */
  applyMagicUpdateMultipleEnchantments(list) {
    if (!Array.isArray(list)) return;
    for (const e of list) this.applyEnchantment(e);
  }

  /** `Character.cs:574-577` — bulk remove via wire-side LayeredSpellId list. */
  applyMagicRemoveMultipleEnchantments(list) {
    if (!Array.isArray(list)) return;
    for (const layered of list) this.removeEnchantment(layered);
  }

  /** `Character.cs:584-591` — purge all enchantments with `duration > 0`. */
  applyMagicPurgeEnchantments() {
    const all = [...this.allEnchantments.values()];
    for (const e of all) {
      if ((e.duration | 0) > 0) {
        this.removeEnchantment(e.layeredId);
      }
    }
  }

  /** `Character.cs:593-600` — purge all DEBUFFs (statValue < 0) with `duration > 0`. */
  applyMagicPurgeBadEnchantments() {
    const all = [...this.allEnchantments.values()];
    for (const e of all) {
      if ((e.duration | 0) > 0 && Number(e.statValue) < 0) {
        this.removeEnchantment(e.layeredId);
      }
    }
  }

  /**
   * `Character.cs:665-678` — UpdateSkill from wire payload.
   * `value` shape: `{adjustPP, innatePoints, lastUsedTime, pointsRaised,
   * resistanceOfLastCheck, trainingLevel, experienceSpent}`.
   */
  updateSkill(skillType, value) {
    if (value == null) return;
    const skill = this._addOrCreateSkill(skillType);
    skill.adjustXP = (value.adjustPP ?? value.adjustXp ?? 0) | 0;
    skill.initLevel = (value.innatePoints ?? value.initLevel ?? 0) | 0;
    skill.lastUsedTime = Number(value.lastUsedTime ?? 0);
    skill.pointsRaised = (value.pointsRaised ?? 0) | 0;
    skill.resistanceOfLastCheck = (value.resistanceOfLastCheck ?? 0) | 0;
    skill.training = (value.trainingLevel ?? value.training ?? skill.training) | 0;
    skill.experience = value.experienceSpent ?? value.experience ?? skill.experience;
    skill.type = skillType | 0;
  }

  /**
   * `Character.cs:689-694` — UpdateAttribute. `value` shape:
   * `{innatePoints, pointsRaised, experienceSpent}`.
   */
  updateAttribute(attributeType, value) {
    if (value == null) return;
    const attr = this._addOrCreateAttribute(attributeType);
    attr.innatePoints = (value.innatePoints ?? 0) | 0;
    attr.pointsRaised = (value.pointsRaised ?? 0) | 0;
    attr.experience = value.experienceSpent ?? value.experience ?? attr.experience;
  }

  /** `Character.cs:696-699` — bumped attribute ranks only. */
  updateAttributePointsRaised(attributeType, raised) {
    const attr = this._addOrCreateAttribute(attributeType);
    attr.pointsRaised = (raised >>> 0);
  }

  /**
   * `Character.cs:713-729` — UpdateVital with **even/odd parity check
   * (load-bearing per handoff §3 row 5)**. `value` shape:
   * `{attribute:{innatePoints, pointsRaised, experienceSpent}, current}`.
   *
   * `isInitialUpdate`=true for login-time hydration (no `vitalChanged`
   * event fire; just seed). Per `Character.cs:721`: when the key is even
   * (current-vital id like Health=2/Stamina=4/Mana=6), `vital.current`
   * is updated and `vitalChanged` fires. When odd (Health=1/Stamina=3/
   * Mana=5), only the max bundle is touched.
   *
   * @param {number} vitalKey raw VitalType key (1..6; even/odd
   *                          determines parity)
   * @param {object} value
   * @param {boolean} [isInitialUpdate=true]
   */
  updateVital(vitalKey, value, isInitialUpdate = true) {
    if (value == null) return;
    const vital = this._addOrCreateVital(vitalKey);
    if (value.attribute) {
      vital.initLevel = (value.attribute.innatePoints ?? 0) | 0;
      vital.pointsRaised = (value.attribute.pointsRaised ?? 0) | 0;
      vital.experience = value.attribute.experienceSpent ?? value.attribute.experience ?? vital.experience;
    } else if (value.innatePoints !== undefined) {
      // Allow flat shape for tests.
      vital.initLevel = (value.innatePoints ?? 0) | 0;
      vital.pointsRaised = (value.pointsRaised ?? 0) | 0;
      vital.experience = value.experienceSpent ?? value.experience ?? vital.experience;
    }

    const wireCurrent = value.current;
    if (wireCurrent != null && (wireCurrent | 0) !== vital.current
        && (isInitialUpdate || (vitalKey % 2) === 0)) {
      // Per Character.cs:721 — `key -= 1` so the dispatched event always
      // fires against the ODD canonical id. Internally we already key by
      // odd id; the event payload mirrors that.
      const oddKey = (vitalKey % 2) === 0 ? (vitalKey - 1) : vitalKey;
      const old = vital.current;
      vital.current = (wireCurrent | 0);
      if (!isInitialUpdate) {
        this._bus.dispatchEvent(new CustomEvent('vitalChanged', {
          detail: { type: oddKey, value: vital.current, oldValue: old },
        }));
      }
    }
  }

  /**
   * `Character.cs:736-745` — current vital level only (no formula refresh).
   * Used by `Qualities_PrivateUpdateAttribute2ndLevel`. Even-parity check
   * applies here too.
   */
  updateVitalCurrent(vitalKey, value) {
    const vital = this._addOrCreateVital(vitalKey);
    if ((value | 0) === vital.current) return;
    if ((vitalKey % 2) === 0) {
      const oddKey = vitalKey - 1;
      const old = vital.current;
      vital.current = value | 0;
      this._bus.dispatchEvent(new CustomEvent('vitalChanged', {
        detail: { type: oddKey, value: vital.current, oldValue: old },
      }));
    }
  }

  /** `Character.cs:731-734` — vital points-raised only. */
  updateVitalPointsRaised(vitalKey, raised) {
    const vital = this._addOrCreateVital(vitalKey);
    vital.pointsRaised = raised >>> 0;
  }

  /** `Character.cs:747-750` — set training class only. */
  updateSkillTraining(skillType, training) {
    const skill = this._addOrCreateSkill(skillType);
    skill.training = training | 0;
  }

  /** `Character.cs:752-755` — bumped skill ranks only. */
  updateSkillPointsRaised(skillType, raised) {
    const skill = this._addOrCreateSkill(skillType);
    skill.pointsRaised = raised >>> 0;
  }

  // ─── PrivateUpdate* property setters (`Character.cs:473-562`) ───
  //
  // Per handoff §3 row 6 — PRIVATE quality updates dispatch to the
  // Character, not the World. PR 4 wires these through dedicated
  // methods so the WorldState dispatcher can route private-only quality
  // updates here instead of into the shared WorldObject store.
  //
  // The actual property STORE is the inherited WorldObject 8-dict map
  // (Character extends Container extends Item extends WorldObject).

  privateUpdateInt(key, value)        { this.setIntValue(key, value); }
  privateRemoveInt(key)               { this.removeIntValue(key); }
  privateUpdateInt64(key, value)      { this.setInt64Value(key, value); }
  privateRemoveInt64(key)             { this.removeInt64Value(key); }
  privateUpdateFloat(key, value)      { this.setFloatValue(key, value); }
  privateRemoveFloat(key)             { this.removeFloatValue(key); }
  privateUpdateBool(key, value)       { this.setBoolValue(key, value); }
  privateRemoveBool(key)              { this.removeBoolValue(key); }
  privateUpdateString(key, value)     { this.setStringValue(key, value); }
  privateRemoveString(key)            { this.removeStringValue(key); }
  privateUpdateInstance(key, value)   { this.setInstanceValue(key, value); }
  privateRemoveInstance(key)          { this.removeInstanceValue(key); }
  privateUpdateData(key, value)       { this.setDataValue(key, value); }
  privateRemoveData(key)              { this.removeDataValue(key); }
  privateUpdatePosition(key, value)   { this.setPositionValue(key, value); }
  privateRemovePosition(key)          { this.removePositionValue(key); }

  // ─── State management (`Character.cs:764-783`) ───

  /** Reset every typed bundle back to login-pristine state. */
  clear() {
    this.options1 = 0;
    // Don't fire vitaeChanged on clear — `Character.cs:767` directly
    // assigns `Vitae = 1f` via the setter, which DOES fire. We mirror.
    if (this._vitae !== 1.0) {
      const old = this._vitae;
      this._vitae = 1.0;
      this._bus.dispatchEvent(new CustomEvent('vitaeChanged', {
        detail: { vitae: 1.0, oldVitae: old },
      }));
    }
    this.skills.clear();
    this.attributes.clear();
    this.vitals.clear();
    this.intValues.clear();
    this.int64Values.clear();
    this.boolValues.clear();
    this.floatValues.clear();
    this.stringValues.clear();
    this.instanceValues.clear();
    this.dataValues.clear();
    this.allEnchantments.clear();
    this.sharedCooldowns.clear();
    this.inPortalSpace = true;
  }

  // ─── Internal helpers ───

  _addOrCreateSkill(skillType) {
    const k = skillType | 0;
    let s = this.skills.get(k);
    if (!s) {
      s = {
        type: k,
        initLevel: 0,
        pointsRaised: 0,
        experience: 0,
        adjustXP: 0,
        lastUsedTime: 0,
        resistanceOfLastCheck: 0,
        training: 0,
      };
      this.skills.set(k, s);
    }
    return s;
  }
  _addOrCreateAttribute(attributeType) {
    const k = attributeType | 0;
    let a = this.attributes.get(k);
    if (!a) {
      a = { type: k, innatePoints: 0, pointsRaised: 0, experience: 0 };
      this.attributes.set(k, a);
    }
    return a;
  }
  _addOrCreateVital(vitalKey) {
    // `Character.cs:701-711` — when key is even, normalize to odd-1.
    let k = vitalKey | 0;
    if ((k % 2) === 0) k -= 1;
    let v = this.vitals.get(k);
    if (!v) {
      v = { type: k, initLevel: 0, pointsRaised: 0, experience: 0, current: 0 };
      this.vitals.set(k, v);
    }
    return v;
  }

  _applyPropertyMaps(payload) {
    const pump = (entries, setter) => {
      if (!entries) return;
      const it = entries instanceof Map ? entries.entries() :
                 Array.isArray(entries) ? entries : Object.entries(entries);
      for (const [k, v] of it) setter.call(this, k | 0, v);
    };
    pump(payload.intProperties,      this.setIntValue);
    pump(payload.int64Properties,    this.setInt64Value);
    pump(payload.boolProperties,     this.setBoolValue);
    pump(payload.floatProperties,    this.setFloatValue);
    pump(payload.stringProperties,   this.setStringValue);
    pump(payload.dataIdProperties,   this.setDataValue);
    pump(payload.instanceIdProperties, this.setInstanceValue);
    pump(payload.positionProperties, this.setPositionValue);
  }

  /**
   * Resolve the Wave C.2 wasm exports. Caches the bundle so we don't
   * re-look up on every HUD tick. Tests inject via `globalThis.__wasm`
   * (a plain object exposing the export names); production reads from
   * the wasm-bindgen module mounted on `globalThis` by the bootstrap.
   */
  _resolveWasm() {
    if (this._wasmExports) return this._wasmExports;
    if (typeof globalThis !== 'undefined') {
      // Tests / mock injection.
      if (globalThis.__wasm) { this._wasmExports = globalThis.__wasm; return this._wasmExports; }
      // Production: bootstrap mounts the import bindings on
      // `globalThis.__holtburger_wasm` (see index.html bootstrap).
      if (globalThis.__holtburger_wasm) {
        this._wasmExports = globalThis.__holtburger_wasm;
        return this._wasmExports;
      }
    }
    return null;
  }

  /**
   * Lazy `Character.cs:33-51` — initialize the set-spells cache from the
   * Wave C.2 wasm export. If the session handle isn't wired yet
   * (pre-bootstrap), returns an empty Set so the tiebreak still works
   * (set-spells just lose).
   */
  _getSetSpellsSnapshot() {
    if (this._setSpells) return this._setSpells;
    const session = this.manager?.client?.player ? this.manager.client : null;
    let ids = null;
    if (session?.sessionHandle?.spellSetIds) {
      try { ids = session.sessionHandle.spellSetIds(); } catch (_) {}
    }
    // Test/mock path: sessionHandle exposed directly on manager.
    if (!ids && this.manager?.sessionHandle?.spellSetIds) {
      try { ids = this.manager.sessionHandle.spellSetIds(); } catch (_) {}
    }
    this._setSpells = new Set(Array.isArray(ids) ? ids.map(n => n >>> 0) : []);
    return this._setSpells;
  }

  _getLevel8AuraSelfSpells() {
    const wasm = this._resolveWasm();
    if (wasm?.level8AuraSelfSpells) {
      try { return new Set(wasm.level8AuraSelfSpells().map(n => n >>> 0)); } catch (_) {}
    }
    return new Set(FALLBACK_LEVEL_8_AURA_SELF_SPELLS);
  }

  _getVitaeSpellId() {
    const wasm = this._resolveWasm();
    if (wasm?.vitaeSpellId) {
      try { return wasm.vitaeSpellId() >>> 0; } catch (_) {}
    }
    return FALLBACK_VITAE_SPELL_ID;
  }

  // ─── Static utility helpers ───

  /**
   * Pack `(spellId, layer)` into a 32-bit layered-spell-id key.
   * Matches `world-state.js`'s encoding so cross-comparison works.
   */
  static _layeredKey(spellId, layer) {
    return ((((spellId | 0) >>> 0) << 16) | ((layer | 0) & 0xFFFF)) >>> 0;
  }

  /**
   * `SharedCooldown.cs:55` — `Id = (layeredId.Id << 20 >> 20)` sign-extends
   * the low 12 bits. In JS `<<` and `>>` are signed 32-bit ops, so the
   * literal port works.
   */
  static signExtendLow12(layeredIdU32) {
    const v = (layeredIdU32 | 0) << 20 >> 20;
    return v;  // intentionally signed — Character.cs:619 path uses it as int
  }

  static _enchantmentFromWire(e) {
    return {
      layeredId: Character._layeredKey(e.spellId ?? e.spell_id ?? 0, e.layer ?? 0),
      spellId: (e.spellId ?? e.spell_id ?? 0) >>> 0,
      layer: (e.layer ?? 0) | 0,
      spellCategory: (e.spellCategory ?? e.spell_category ?? 0) | 0,
      power: (e.power ?? e.powerLevel ?? e.power_level ?? 0) | 0,
      startTime: Number(e.startTime ?? e.start_time ?? 0),
      duration: Number(e.duration ?? 0),
      casterGuid: (e.casterGuid ?? e.caster_guid ?? 0) >>> 0,
      type: (e.type ?? e.statModType ?? 0) | 0,
      statKey: (e.statKey ?? e.stat_key ?? 0) | 0,
      statValue: Number(e.statValue ?? e.stat_value ?? 0),
    };
  }

  static _cooldownFromWire(e) {
    // `SharedCooldown.FromMessage` (per Character.cs:620 + SharedCooldown.cs).
    // Stored id is the sign-extended low-12-bit slice.
    const layeredId = Character._layeredKey(e.spellId ?? e.spell_id ?? 0, e.layer ?? 0);
    return {
      layeredId,
      id: Character.signExtendLow12(layeredId),
      spellId: (e.spellId ?? e.spell_id ?? 0) >>> 0,
      layer: (e.layer ?? 0) | 0,
      startTime: Number(e.startTime ?? e.start_time ?? 0),
      duration: Number(e.duration ?? 0),
    };
  }

  /**
   * Tiebreak comparator per handoff §3 row 7 / `Character.cs:232-239`.
   * Returns negative if `a` wins (sort-descending semantic).
   */
  static _tiebreakDescending(a, b, level8Set, setSpellsSet) {
    // 1. Power desc.
    if (a.power !== b.power) return b.power - a.power;

    // 2. Level8AuraSelfSpells (true beats false → -1 means a wins).
    const aL8 = level8Set.has(a.spellId);
    const bL8 = level8Set.has(b.spellId);
    if (aL8 !== bL8) return aL8 ? -1 : 1;

    // 3. Segregation per Wave C.2 handoff §7 — set-spells beat non-set;
    // within set sort by SpellId desc; within non-set sort by StartTime desc.
    const aSet = setSpellsSet.has(a.spellId);
    const bSet = setSpellsSet.has(b.spellId);
    if (aSet !== bSet) return aSet ? -1 : 1;
    if (aSet) {
      // Both are set-spells → SpellId desc.
      return b.spellId - a.spellId;
    }
    // Both non-set → StartTime desc.
    return b.startTime - a.startTime;
  }

  /**
   * Best-effort default formula attrs per vital. Real values come from
   * the DAT's `SkillTable.skill_formula_table` for skills, and a
   * hard-coded ACE table for vitals (`SecondaryAttributeInfo.Formula`).
   * Health=Endurance/2, Stamina=Endurance/3, Mana=Self/3.
   */
  static _defaultVitalFormula(vitalType) {
    switch (vitalType | 0) {
      case 1: return { attr1: 2 /*Endurance*/, attr2: 0, divisor: 2, useFormula: true };  // Health
      case 3: return { attr1: 2 /*Endurance*/, attr2: 0, divisor: 3, useFormula: true };  // Stamina
      case 5: return { attr1: 6 /*Self*/,      attr2: 0, divisor: 3, useFormula: true };  // Mana
      default: return { attr1: 0, attr2: 0, divisor: 1, useFormula: false };
    }
  }
}

/**
 * @typedef {object} SkillBundle
 * @property {number} type            SkillType u32
 * @property {number} initLevel       innate points
 * @property {number} pointsRaised
 * @property {number} experience
 * @property {number} adjustXP
 * @property {number} lastUsedTime
 * @property {number} resistanceOfLastCheck
 * @property {number} training        TrainingClass u32 (0..3)
 */

/**
 * @typedef {object} AttributeBundle
 * @property {number} type            AttributeType u32 (1..6)
 * @property {number} innatePoints
 * @property {number} pointsRaised
 * @property {number} experience
 */

/**
 * @typedef {object} VitalBundle
 * @property {number} type        VitalType u32 (1, 3, or 5 — always odd)
 * @property {number} initLevel
 * @property {number} pointsRaised
 * @property {number} experience
 * @property {number} current
 */

/**
 * @typedef {object} EnchantmentRecord
 * @property {number} layeredId         (spellId << 16) | layer
 * @property {number} spellId
 * @property {number} layer
 * @property {number} spellCategory
 * @property {number} power
 * @property {number} startTime
 * @property {number} duration
 * @property {number} casterGuid
 * @property {number} type              EnchantmentTypeFlags bitfield
 * @property {number} statKey
 * @property {number} statValue
 */

/**
 * @typedef {object} CooldownRecord
 * @property {number} layeredId  packed (spellId<<16)|layer
 * @property {number} id         sign-extended low-12 of layeredId
 * @property {number} spellId
 * @property {number} layer
 * @property {number} startTime
 * @property {number} duration
 */

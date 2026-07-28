import {
  getSpellBarSlots,
  setSpellBarSlot,
  getActiveSpellBar,
  setActiveSpellBar,
  addToFirstEmptySlot,
  SPELL_BAR_TABS,
  SPELL_BAR_SLOTS,
  loadCatalog,
} from "./spellbook.js";
import { resolveBindingIcon } from "../ui/ac_entity_icon.js";
import { attachWindowPosition } from "../ui/ac_window_position.js";
import {
  resolveLocalBinding,
  matchesBinding,
  LOCAL_ACTION_IDS,
} from "../ui/keymap.js";
import { getInputFunnel, inputFunnelV2On } from "../ui/input-funnel.js";
import { setAcText } from "../ui/ac_font.js";
import {
  classifySpell,
  isShapeTableLoaded,
  SPELL_SHAPE,
} from "../ui/ac_spell_shape.js";
import { setUseFastMissiles, setAutoRepeatAttacks, isCharacterOptionEnabled, CHARACTER_OPTION } from "../ui/ac_character_options.js";
import { castSpellViaHandle } from "../ui/ac_cast_spell.js";
import { getCastSequence } from "../ui/ac_spell_cast_sequence.js";
import {
  wrongStanceForArmed,
  castCooldownMs,
  castSweepReducer,
} from "../ui/ac_cast_ui_logic.js";
import { suggestedCombatModeFromInventory } from "./inventory_helpers.js";

// Wave 6 / Phase 17 — spell-shape badge mapping.
//
// `classifySpell(spellId)` lazy-loads `data/spell-shapes.json` on the
// first call (returns `null` synchronously while the fetch is in
// flight). The spell picker mirrors the existing `loadCatalog` pattern:
// render once on open (badges absent if the table isn't loaded yet),
// then poll `isShapeTableLoaded()` with a short setInterval and
// re-render once the table is in. This keeps the picker snappy on
// open — no awaited gate — and the badges fade in within ~one frame
// of the JSON arriving (typical cold fetch is 30-80ms).
//
// Single-letter badges per `ui/ac_spell_shape.js` SPELL_SHAPE strings:
//   Bolt → B   single straight-line projectile
//   Arc  → A   parabolic single projectile
//   Streak → S rapid-fire same projectile
//   Volley → V fan of multi-projectiles converging on target
//   Wall → W   slow-advancing wall of projectiles
//   Ring → R   caster-centered ring AoE
//   Blast → X explosion at target point
//   Self → ·  no projectile (non-projectile / DoT / debuff / heal /
//             enchant). Distinct middle-dot keeps the column visually
//             aligned with projectile spells so the badge slot doesn't
//             jitter.
const SPELL_SHAPE_BADGE = Object.freeze({
  [SPELL_SHAPE.Bolt]:   "B",
  [SPELL_SHAPE.Arc]:    "A",
  [SPELL_SHAPE.Streak]: "S",
  [SPELL_SHAPE.Volley]: "V",
  [SPELL_SHAPE.Wall]:   "W",
  [SPELL_SHAPE.Ring]:   "R",
  [SPELL_SHAPE.Blast]:  "X",
  [SPELL_SHAPE.Self]:   "·", // middle dot
});

const STORAGE_KEY = "holtburger_combat_bar_v1";

const DEFAULTS = {
  attackHeight: 2, // MEDIUM
  powerLevel: 1.0,
  autoRepeat: true,
  chargeAttack: true, // Phase I.1 — auto-pursue to attack range on click
  // Wave 10 / Phase 32 (2026-05-26) — UseFastMissiles toggle. Default
  // OFF (opt-in only). ACE multiplies the missile launcher's max
  // velocity by `fast_missile_modifier = 1.2` server-side when the
  // CharacterOption is set (`Creature_Missile.cs:223-225`,
  // `CharacterOption.UseFastMissiles = 0x2B`). This client flag is a
  // PREDICTION AID — `scene3d/picking.js` boosts `projectileSpeed`
  // by 1.2× before solving the gravity-arc so the local aim-level
  // prediction matches what ACE will broadcast back on UpdateMotion
  // (kind=5). The actual server-side speedup requires our wasm to
  // send `GameAction::SetSingleCharacterOption(UseFastMissiles, true)`
  // — see TODO below. For now the toggle only affects local
  // ballistic-arc prediction; if ACE doesn't have our CharacterOptions2
  // bit set, the server still uses 1.0× and UpdateMotion may correct
  // mid-swing. TODO Wave 11+: expose `set_single_character_option`
  // from `holtburger-web/src/lib.rs` (currently parked behind AB/AC's
  // file ownership) and dispatch on toggle so persistence is
  // round-tripped through ACE rather than only localStorage.
  useFastMissiles: false,
  armedSpellId: 0, // 0 = no spell armed
  spellBarSlots: [], // populated by the Spellbook plugin (📖)
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage may be unavailable (private mode); silently drop
  }
}

function syncWindowState(state) {
  window.__combatBarState = {
    // F11-3 — PRESERVE the in-flight attack lockout across this wholesale
    // object replacement. Previously any syncWindowState (stance change,
    // slider/checkbox interaction, panel re-render) wiped attackInProgress
    // to undefined mid-swing, so the live fireOnce read (F6-6) saw it as
    // cleared and let an overlapping attack request through (visible windup
    // restart). Carry the prior value forward.
    attackInProgress: window.__combatBarState?.attackInProgress ?? false,
    attackHeight: state.attackHeight,
    powerLevel: state.powerLevel,
    autoRepeat: state.autoRepeat,
    chargeAttack: state.chargeAttack !== false,
    // Phase 32 — surfaced for picking.js's missile branch (boosts
    // gravity-arc projectileSpeed by 1.2× when true). Coerced to a
    // strict bool so a stale "useFastMissiles: 1"-style localStorage
    // record (from a hand-edit or older schema) still gates correctly.
    useFastMissiles: state.useFastMissiles === true,
    armedSpellId: state.armedSpellId,
    spellBarSlots: state.spellBarSlots || [],
  };
}

// Module-scope disarm helper. Clears armedSpellId in localStorage +
// window.__combatBarState without touching DOM. Used by the module-load
// IIFE's event subscribers (death / zone change) so the disarm works
// even when the combat-bar panel is closed. When the panel IS open,
// activate()'s local setArmed updates the row "armed" class; the
// next renderRows after reopen reads the fresh state either way.
function clearArmedSpell() {
  const state = loadState();
  if (state.armedSpellId === 0) return;
  state.armedSpellId = 0;
  saveState(state);
  syncWindowState(state);
}

// Shared surface between the hotkey handler and the spell strip —
// installSpellStrip() populates it with {render, fireSlot, selectDelta,
// selectEdge, castCurrent}. Declared BEFORE the module-load install
// block below: installSpellStrip() assigns it during module init, so a
// later declaration would be a temporal-dead-zone ReferenceError that
// kills the whole module eval.
let __stripApi = null;

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "hb-combat-bar-style";
  style.textContent = `
    .hb-cb-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
      font-size: 12px;
    }
    .hb-cb-row label {
      flex: 0 0 auto;
      color: rgba(255, 255, 255, 0.75);
    }
    .hb-cb-heights {
      display: flex;
      gap: 4px;
      flex: 1;
    }
    .hb-cb-height-btn {
      flex: 1;
      padding: 4px 6px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: rgba(255, 255, 255, 0.8);
      border-radius: 4px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
    }
    .hb-cb-height-btn:hover {
      background: rgba(255, 255, 255, 0.12);
    }
    .hb-cb-height-btn.active {
      background: rgba(255, 120, 60, 0.4);
      border-color: rgba(255, 140, 80, 0.7);
      color: #fff;
    }
    .hb-cb-power-row input[type="range"] {
      flex: 1;
      position: relative;
      z-index: 1;
      background: transparent;
    }
    .hb-cb-power-wrap {
      flex: 1;
      position: relative;
      display: flex;
      align-items: center;
      min-height: 16px;
    }
    .hb-cb-power-wrap input[type="range"] {
      flex: 1;
      position: relative;
      z-index: 1;
    }
    /* Recklessness active-band overlay — drawn between 10%–90% of
       the track width when the local player has Recklessness Trained
       (2) or Specialized (3) AND is in a melee / missile stance.
       Sits BEHIND the slider thumb (z-index 0 vs thumb's 1) so the
       thumb is always visible on top. Visual-only — never enforced
       as a cap; see acpedia Recklessness page + Combat omnibus. */
    .hb-cb-power-band {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      height: 10px;
      left: 10%;
      width: 80%;
      background: rgba(220, 80, 40, 0.18);
      border: 1px solid rgba(220, 80, 40, 0.32);
      border-radius: 2px;
      pointer-events: auto;
      z-index: 0;
      cursor: help;
    }
    .hb-cb-power-band.hb-cb-power-band-spec {
      background: rgba(220, 80, 40, 0.26);
      border-color: rgba(240, 100, 60, 0.45);
    }
    .hb-cb-power-val {
      flex: 0 0 36px;
      text-align: right;
      font-variant-numeric: tabular-nums;
      color: rgba(255, 255, 255, 0.7);
    }
    .hb-cb-toggle {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: rgba(255, 255, 255, 0.75);
      cursor: pointer;
    }
    .hb-cb-stance-row {
      margin-bottom: 6px;
      padding-bottom: 6px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.12);
    }
    .hb-cb-stance-val {
      flex: 1;
      font-weight: 600;
      color: #fff;
    }
    .hb-cb-stance-btn {
      padding: 4px 10px;
      background: rgba(255, 255, 255, 0.10);
      border: 1px solid rgba(255, 255, 255, 0.22);
      border-radius: 3px;
      color: #fff;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    .hb-cb-stance-btn:hover {
      background: rgba(255, 255, 255, 0.18);
    }
    .hb-cb-hint {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.45);
      margin-top: 6px;
      line-height: 1.4;
    }
    .hb-cb-feed {
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid rgba(255, 255, 255, 0.12);
      display: flex;
      flex-direction: column;
      gap: 2px;
      font-size: 11px;
      line-height: 1.35;
      max-height: 90px;
      overflow-y: auto;
    }
    .hb-cb-feed-line {
      color: rgba(255, 255, 255, 0.65);
      font-variant-numeric: tabular-nums;
    }
    .hb-cb-feed-line.hb-cb-feed-hit { color: rgba(255, 200, 120, 0.9); }
    .hb-cb-feed-line.hb-cb-feed-taken { color: rgba(255, 130, 130, 0.9); }
    .hb-cb-feed-line.hb-cb-feed-miss { color: rgba(180, 180, 180, 0.7); font-style: italic; }
    .hb-cb-feed-empty {
      color: rgba(255, 255, 255, 0.35);
      font-style: italic;
    }
    .hb-cb-spells {
      display: flex;
      flex-direction: column;
      gap: 3px;
      margin-bottom: 8px;
      max-height: 200px;
      overflow-y: auto;
    }
    .hb-cb-spell {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 6px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      color: rgba(255, 255, 255, 0.8);
      font-family: inherit;
      text-align: left;
    }
    .hb-cb-spell:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.2);
    }
    .hb-cb-spell.armed {
      background: rgba(160, 110, 255, 0.4);
      border-color: rgba(180, 130, 255, 0.7);
      color: #fff;
    }
    .hb-cb-spell-action {
      flex: 0 0 38px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-size: 9px;
      color: rgba(255, 255, 255, 0.55);
    }
    .hb-cb-spell.armed .hb-cb-spell-action {
      color: #fff;
    }
    .hb-cb-spell-name {
      flex: 1;
    }
    .hb-cb-spell-tag {
      flex: 0 0 auto;
      font-size: 9px;
      padding: 1px 5px;
      background: rgba(0, 0, 0, 0.3);
      border-radius: 3px;
      color: rgba(255, 255, 255, 0.45);
    }
    /* Wave 6 / Phase 17 — spell-shape badge. Sits between the action
       column and the spell name so the column-width stays fixed even
       when the table hasn't loaded yet (badge becomes a blank span). */
    .hb-cb-spell-shape {
      flex: 0 0 14px;
      font-family: var(--ac-mono, ui-monospace, monospace);
      font-size: 10px;
      font-weight: 700;
      text-align: center;
      line-height: 14px;
      border-radius: 3px;
      background: rgba(0, 0, 0, 0.35);
      color: rgba(255, 255, 255, 0.65);
    }
    .hb-cb-spell-shape[data-shape="Bolt"]   { color: rgba(170, 200, 255, 0.95); }
    .hb-cb-spell-shape[data-shape="Arc"]    { color: rgba(200, 170, 255, 0.95); }
    .hb-cb-spell-shape[data-shape="Streak"] { color: rgba(255, 200, 130, 0.95); }
    .hb-cb-spell-shape[data-shape="Volley"] { color: rgba(255, 170, 200, 0.95); }
    .hb-cb-spell-shape[data-shape="Wall"]   { color: rgba(170, 230, 200, 0.95); }
    .hb-cb-spell-shape[data-shape="Ring"]   { color: rgba(230, 230, 130, 0.95); }
    .hb-cb-spell-shape[data-shape="Blast"]  { color: rgba(255, 140, 100, 0.95); }
    .hb-cb-spell-shape[data-shape="Self"]   { color: rgba(255, 255, 255, 0.35); background: transparent; }
    .hb-cb-magic-hint {
      margin-bottom: 8px;
      font-size: 11px;
      color: rgba(180, 130, 255, 0.85);
    }
    .hb-cb-tabs {
      display: flex;
      gap: 2px;
      margin-bottom: 8px;
    }
    .hb-cb-tab {
      flex: 1;
      padding: 3px 0;
      font-size: 11px;
      font-family: inherit;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 3px;
      color: rgba(255, 255, 255, 0.55);
      cursor: pointer;
      text-align: center;
    }
    .hb-cb-tab:hover {
      background: rgba(255, 255, 255, 0.1);
      color: rgba(255, 255, 255, 0.85);
    }
    .hb-cb-tab.active {
      background: rgba(160, 110, 255, 0.4);
      border-color: rgba(180, 130, 255, 0.7);
      color: #fff;
      font-weight: 600;
    }
    .hb-cb-power-meter {
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid rgba(255, 255, 255, 0.12);
    }
    .hb-cb-power-meter-label {
      font-size: 10px;
      color: rgba(255, 255, 255, 0.55);
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .hb-cb-power-meter-bar {
      position: relative;
      height: 12px;
      background: rgba(0, 0, 0, 0.5);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 3px;
      overflow: hidden;
    }
    .hb-cb-power-meter-fill {
      position: absolute;
      top: 0; left: 0; bottom: 0;
      width: 0%;
      background: linear-gradient(180deg, #ffaa44, #cc6622);
      transition: width 100ms linear;
    }
    .hb-cb-power-meter.refilling .hb-cb-power-meter-fill {
      background: linear-gradient(180deg, #ffaa44, #cc6622);
    }
    .hb-cb-power-meter.ready .hb-cb-power-meter-fill {
      background: linear-gradient(180deg, #88ff88, #44cc44);
    }
    /* AttackHook strike-frame pulse — flashes the meter when the
       LOCAL player's swing reaches its hookType=3 AttackHook (the
       retail strike-frame moment, ~halfway through the swing clip).
       Subscriber lives in attachPowerMeter; class auto-removes after
       the 220ms animation completes. */
    @keyframes hb-cb-strike-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(255, 220, 120, 0); transform: scaleY(1); }
      40%  { box-shadow: 0 0 8px 2px rgba(255, 220, 120, 0.95); transform: scaleY(1.35); }
      100% { box-shadow: 0 0 0 0 rgba(255, 220, 120, 0); transform: scaleY(1); }
    }
    .hb-cb-power-meter.strike-pulse .hb-cb-power-meter-bar {
      animation: hb-cb-strike-pulse 220ms ease-out;
    }
  `;
  document.head.appendChild(style);
}

// Stance enum values that mean "ranged combat" — used to flip the
// slider label from Power → Accuracy. Mirrors RANGED_STANCES in
// index.html.
const RANGED_STANCES = new Set([
  0x003f, 0x0041, 0x0043, 0x0047, 0x00e8, 0x00e9, 0x013b, 0x013c,
]);
// Melee stance enum values (HandCombat, SwordCombat, etc.) — needed
// by `stanceWord()` after folding the standalone `stance-toggle`
// plugin in here. Mirrors MELEE_STANCES in `plugins/stance-toggle.js`
// (kept for symmetry with RANGED_STANCES). Pre-2026-05-17 this was
// missing and `stanceWord()` threw a ReferenceError on the first
// `MELEE_STANCES.has(low)` call, aborting the rest of `activate()` —
// so the panel rendered only the stance row + empty button.
const MELEE_STANCES = new Set([
  0x003c, 0x003e, 0x0040, 0x0044, 0x0046,
]);
function currentStanceIsRanged() {
  const fn = typeof window !== "undefined" ? window.__getCurrentStanceLow : null;
  if (typeof fn !== "function") return false;
  try {
    return RANGED_STANCES.has(fn());
  } catch {
    return false;
  }
}
function currentStanceIsMagic() {
  const fn = typeof window !== "undefined" ? window.__getCurrentStanceLow : null;
  if (typeof fn !== "function") return false;
  try {
    return fn() === 0x0049; // Magic stance (wand / orb / magic staff + combat mode)
  } catch {
    return false;
  }
}

// SkillType::Recklessness = 50 — see
// `external/holtburger/crates/holtburger-common/src/stats.rs:156`.
// TrainingLevel: 0=Unusable, 1=Untrained, 2=Trained, 3=Specialized
// (`stats.rs:287`). The wasm-side `playerStats().skills` is a flat
// `Vec<u32>` of 5-tuples `[type, current, base, ranks, training]`
// sorted by SkillType — see `src/lib.rs:13911-13915`.
const SKILL_TYPE_RECKLESSNESS = 50;
const TRAINING_TRAINED = 2;
const TRAINING_SPECIALIZED = 3;

// Reads the local player's Recklessness training level from the
// session handle's stats snapshot. Returns the integer training
// level (0..3) or `null` when stats/skills aren't available yet
// (pre-login, pre-PlayerDescription, accessor throws). Callers
// should treat any non-2/3 return as "no band".
function readRecklessnessTrainingLevel() {
  try {
    const handle = (typeof window !== "undefined") ? window.__sessionHandle : null;
    if (!handle || typeof handle.playerStats !== "function") return null;
    const stats = handle.playerStats();
    const skills = stats?.skills;
    if (!skills) return null;
    // skills may be a real Array (Vec<u32> → Array) or wasm-bindgen
    // typed-array; both index numerically. We treat anything with a
    // numeric `.length` as iterable here. character-info.js does the
    // same coercion (see tupleArrayAt).
    const len = skills.length ?? 0;
    if (len === 0) return null;
    // stride-6: [type, current, base, ranks, training, next_rank_cost]
    for (let i = 0; i + 5 < len; i += 6) {
      const type = skills[i];
      if (type === SKILL_TYPE_RECKLESSNESS) {
        return skills[i + 4] ?? 0;   // training class (value index unchanged)
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Seed window.__combatBarState at import time so picking.js reads
// the persisted values (or DEFAULTS on a fresh session) even when
// the user never opens the panel this session.
//
// Wave J1.A (2026-05-27) — also installs the auto-disarm hooks that
// previously lived in an exported `mount(ctx)` lifecycle. The bar's
// per-slot mount pass intentionally skipped combat-bar (Polish A's
// `BAR_SLOT_EXPORT_OVERRIDES["combat-bar"] = { mount: false, ... }`
// in index.html, around line 1236), which meant `mount()` was an
// orphan — declared but never invoked. The disarm logic is correctness-
// critical (clear armed spell on zone change / death even when the
// combat panel is closed), so we run it at module-load time instead.
// The poll loop below handles the case where `window.__pluginClient`
// isn't ready yet (it's set by index.html post-login).
if (typeof window !== "undefined") {
  syncWindowState(loadState());
  installAutoDisarmHooks();
  installAttackLockoutHooks();
  installSpellBarHotkeys();
  installSpellStrip();
  installCastBusySweep();
}

// WS14 (patch A/B) — cast-busy grey + cooldown sweep (HUD-only, no flag).
//
// Greys the armed/selected spell-picker rows AND the spell-strip slots for the
// duration of the LOCAL player's cast, driven by the cast-lifecycle events
// (spellCastInitiated → on; spellCastResolved/Rejected → off). Self-expiring:
// the CSS keyframe animation ends on its own even if a resolve event is dropped.
//
// Runs at module-load (mirrors installSpellStrip / installAutoDisarmHooks) so
// the strip sweep works whether or not the combat PANEL is open, and injects
// its own <style> here (NOT ensureStyles, which only runs on panel-open) so the
// CSS exists whenever the sweep can fire. Queries the DOCUMENT — the strip
// (.hb-ss-slot) and the panel rows (.hb-cb-spell) live in SEPARATE DOM subtrees
// (no shared `root`), so a document query is the only one that greys both.
function installCastBusySweep() {
  if (window.__hbCastBusySweepInstalled) return;
  window.__hbCastBusySweepInstalled = true;

  // Self-contained style — panel `.armed`-adjacent CSS lives in ensureStyles(),
  // but that only injects on panel-open; the sweep + wrong-stance rules must be
  // available at module-load for the always-present strip.
  try {
    if (!document.getElementById("hb-ws14-cast-style")) {
      const st = document.createElement("style");
      st.id = "hb-ws14-cast-style";
      st.textContent = `
    /* WS14 — cast-busy grey + cooldown sweep. HUD-only; no flag.
       --hb-cast-ms is set inline from the spell's totalDurationS/CAST_SPEED. */
    .hb-cb-spell.casting,
    .hb-ss-slot.casting {
      pointer-events: none;
      filter: grayscale(0.7) brightness(0.7);
      position: relative;
      overflow: hidden;
    }
    .hb-cb-spell.casting::after,
    .hb-ss-slot.casting::after {
      content: "";
      position: absolute; inset: 0;
      transform-origin: left center;
      background: rgba(160, 110, 255, 0.28);
      animation: hb-cast-cooldown var(--hb-cast-ms, 2000ms) linear 1 forwards;
      pointer-events: none;
    }
    @keyframes hb-cast-cooldown {
      from { transform: scaleX(1); }
      to   { transform: scaleX(0); }
    }
    /* WS14 (patch B) — armed but NOT in Magic stance: amber cue instead of the
       ready-purple, so the player sees the spell won't fire until they enter
       Magic mode. */
    .hb-cb-spell.armed.wrong-stance {
      background: rgba(200, 140, 40, 0.28);
      border-color: rgba(220, 160, 60, 0.7);
    }
    .hb-cb-spell.armed.wrong-stance .hb-cb-spell-action { color: #ffd98a; }`;
      (document.head ?? document.documentElement).appendChild(st);
    }
  } catch (_) { /* style injection is best-effort */ }

  const _durationMsFor = (spellId) => {
    try {
      const seq = getCastSequence((spellId >>> 0) || 0);
      return castCooldownMs(seq?.totalDurationS, Number(window.__castSpeed) || 2.0);
    } catch (_) { return 2000; }
  };
  const _setCasting = (on, ms) => {
    try {
      const nodes = document.querySelectorAll(".hb-cb-spell, .hb-ss-slot");
      for (const n of nodes) {
        if (on) {
          n.style.setProperty("--hb-cast-ms", `${ms}ms`);
          n.classList.add("casting");
        } else {
          n.classList.remove("casting");
          n.style.removeProperty("--hb-cast-ms");
        }
      }
    } catch (_) { /* never throw out of an event handler */ }
  };

  let pollTimer = null;
  function tryHook() {
    const client = window.__pluginClient ?? null;
    if (!client?.events?.on) return false;
    const localGuid = () => (window.getLocalPlayerGuid?.() ?? 0) >>> 0;
    const onInitiated = (e) => {
      const d = e?.detail ?? e ?? {};
      const r = castSweepReducer({
        type: "spellCastInitiated",
        attackerGuid: d.attackerGuid,
        localGuid: localGuid(),
        estDurationMs: d.estDurationMs,
        fallbackMs: _durationMsFor(d.spellId),
      });
      if (r.ignored) return;
      _setCasting(r.casting, r.ms);
    };
    const onResolved = () => _setCasting(false);
    const onRejected = () => _setCasting(false);
    client.events.on("spellCastInitiated", onInitiated);
    client.events.on("spellCastResolved", onResolved);
    client.events.on("spellCastRejected", onRejected);
    return true;
  }
  if (typeof window !== "undefined") {
    if (!tryHook()) {
      pollTimer = setInterval(() => {
        if (tryHook()) { clearInterval(pollTimer); pollTimer = null; }
      }, 500);
    }
  }
}

// Subscribe at module-load to the hotbar bus event — when a hotbar
// slot fires an armed spell on an item, clear the armed state so the
// combat-bar UI is consistent.
try {
  window.addEventListener("hbHotbarItemTargeted", () => {
    try { clearArmedSpell(); } catch (_) {}
  });
} catch (_) {}

// Auto-disarm subscriptions. Runs at module-load (see syncWindowState
// IIFE above) so the disarm hook is live even before the user opens
// the combat panel — armed-spell state lives in localStorage +
// window.__combatBarState, so it survives across sessions and panel
// open/close. Two trigger events:
//   - `landblockChanged` — zone exit clears armed spell (matches
//     retail AC's "armed spell cleared on portal / teleport"). The
//     first emission also catches the log-in case (lastLocalPlayerLb
//     starts at 0 in index.html), so reloading the page with a stale
//     armed spell no longer leaves the UI lying to the user.
//   - `playerStatsUpdated` with HP=0 — death clears armed spell.
//
// Previously this lived in an exported `mount(ctx)` lifecycle fn that
// the bar would invoke. Wave J1.A (2026-05-27) moved it inline because
// index.html's `BAR_SLOT_EXPORT_OVERRIDES["combat-bar"]` intentionally
// skipped combat-bar's `mount()` (see index.html ~line 1232-1236 for
// the historical rationale), so the hooks never fired.
function installAutoDisarmHooks() {
  let pollTimer = null;

  function tryHook() {
    const client = window.__pluginClient ?? null;
    if (!client?.events?.on || !client?.player) {
      return false;
    }
    const onZoneChange = () => clearArmedSpell();
    const onStatsUpdated = () => {
      try {
        const stats = client.player.stats;
        const vitals = stats?.vitals;
        if (!vitals) return;
        // vitals packs [type, current, base, buffed_max] × N — see
        // plugins/vitals-hud.js for the same wire-layout reader.
        // Type 1 = HP; current at offset +1.
        for (let i = 0; i + 3 < vitals.length; i += 4) {
          if (vitals[i] === 1 && vitals[i + 1] === 0) {
            clearArmedSpell();
            return;
          }
        }
      } catch {
        // Stats accessor can throw pre-biota; ignore.
      }
    };
    client.events.on("landblockChanged", onZoneChange);
    client.events.on("playerStatsUpdated", onStatsUpdated);
    return true;
  }

  if (!tryHook()) {
    pollTimer = setInterval(() => {
      if (tryHook()) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }, 500);
  }
  // No teardown — disposers live for the page lifetime, mirroring how
  // the prior `mount(ctx)` disposer was never invoked (bar teardown
  // isn't plumbed today; see ui/bar.js:583-584 "TODO: bar teardown
  // not yet plumbed"). If/when bar teardown lands we can surface the
  // disposer back through a return value or a window-scoped handle.
}

// Task C step 3 (2026-07-01) — spell-bar keyboard cycling, module-load.
//
// Retail exposed dedicated input actions for this in the MAGIC-mode
// input map (`ClientCombatSystem::HandleMagicAction`, acclient.c
// ~407451): 0x10000063 CombatPrevSpellTab / 0x10000064
// CombatNextSpellTab / 0x10000104 CombatFirstSpellTab (+ LastSpellTab),
// plus spell SELECTION cycling and CastCurrentSpell. Retail shipped
// them user-bindable via Keyboard Config; we pick web-native defaults
// and scope them exactly like retail did — magic stance only:
//   [ / ]        previous / next spell tab (wraps)
//   { / }        first / last spell tab (Shift+[ / Shift+])
//   1..9         fire the Nth slot of the active tab — untargeted
//                spells cast immediately, targeted spells arm/disarm
//                (retail's CastCurrentSpell + selection model; retail
//                badges hotkey digits on the strip's first nine slots).
// Keys are ignored while typing (input/textarea/contenteditable) and
// with ctrl/alt/meta held. Tab switches go through setActiveSpellBar →
// `hb-spellbar-changed`, which refreshes any open picker (tab
// highlight + rows) — and still persist when the panel is closed.
function installSpellBarHotkeys() {
  if (window.__hbSpellBarHotkeysInstalled) return;
  window.__hbSpellBarHotkeysInstalled = true;
  const cycleTab = (dir) => {
    const cur = getActiveSpellBar();
    setActiveSpellBar((cur + dir + SPELL_BAR_TABS) % SPELL_BAR_TABS);
  };
  // Magic stance only — retail scoped the whole MagicCombat input map to
  // the casting stance (ClientCombatSystem::HandleMagicAction). THIS is the
  // gate that made Delete look "dead" in melee/peace while WASD kept
  // working: it is an action SCOPE, not a second gate on the funnel.
  const inMagicStance = () => {
    try {
      return window.__getCurrentStanceLow?.() === 0x49;
    } catch (_) {
      return false;
    }
  };

  // Retail MagicCombat actions — every row from the acclient.keymap
  // capture is its own rebindable entry in Options → Controls
  // ("Magic: …" rows), defaults verbatim: Insert/PageUp tab cycling,
  // Delete/PageDown spell selection, Ctrl+<key> First/Last (retail
  // metakey 0x2 = Ctrl), End casts, Digit1..9 = UseSpellSlot_N.
  // matchesBinding is exact on modifiers, so plain-Insert (prev)
  // and Ctrl+Insert (first) rows coexist without special-casing.
  // `__stripApi` is read at DISPATCH time (it is assigned later, by
  // installSpellStrip) — never captured.
  const actionRows = [
    [LOCAL_ACTION_IDS.MAGIC_PREV_TAB, "Insert", () => cycleTab(-1)],
    [LOCAL_ACTION_IDS.MAGIC_NEXT_TAB, "PageUp", () => cycleTab(+1)],
    [LOCAL_ACTION_IDS.MAGIC_FIRST_TAB, { code: "Insert", ctrl: true },
      () => setActiveSpellBar(0)],
    [LOCAL_ACTION_IDS.MAGIC_LAST_TAB, { code: "PageUp", ctrl: true },
      () => setActiveSpellBar(SPELL_BAR_TABS - 1)],
    [LOCAL_ACTION_IDS.MAGIC_PREV_SPELL, "Delete", () => __stripApi?.selectDelta(-1)],
    [LOCAL_ACTION_IDS.MAGIC_NEXT_SPELL, "PageDown", () => __stripApi?.selectDelta(+1)],
    [LOCAL_ACTION_IDS.MAGIC_FIRST_SPELL, { code: "Delete", ctrl: true },
      () => __stripApi?.selectEdge("first")],
    [LOCAL_ACTION_IDS.MAGIC_LAST_SPELL, { code: "PageDown", ctrl: true },
      () => __stripApi?.selectEdge("last")],
    [LOCAL_ACTION_IDS.MAGIC_CAST, "End", () => __stripApi?.castCurrent()],
  ];
  for (let n = 1; n <= 9; n++) {
    const slotIdx = n - 1;
    actionRows.push([
      LOCAL_ACTION_IDS[`MAGIC_SLOT_${n}`],
      `Digit${n}`,
      () => __stripApi?.fireSlot(slotIdx),
    ]);
  }

  // Web-native aliases kept from v1 ([ ] cycle, { } first/last) + the
  // storage-level digit fallback for a strip that failed to mount. Not
  // rebindable, so they stay a small raw handler rather than actions.
  const aliasBody = (ev) => {
    if (ev.ctrlKey) return; // unbound Ctrl combos are not ours
    const api = __stripApi;
    const key = ev.key;
    if (key === "[" || key === "]" || key === "{" || key === "}") {
      if (key === "{") setActiveSpellBar(0);
      else if (key === "}") setActiveSpellBar(SPELL_BAR_TABS - 1);
      else cycleTab(key === "[" ? -1 : +1);
      ev.preventDefault();
      return;
    }
    if (!api && key >= "1" && key <= "9") {
      const slotIdx = key.charCodeAt(0) - 49; // '1' → slot 0
      ev.preventDefault();
      const spellId = (getSpellBarSlots()[slotIdx] | 0);
      if (!spellId) return;
      loadCatalog()
        .then((catalog) => {
          const meta = catalog?.[String(spellId)];
          const untargeted = (meta?.untargeted ?? true) === true;
          if (untargeted) {
            castSpellViaHandle(spellId, null);
          } else {
            const state = loadState();
            state.armedSpellId = state.armedSpellId === spellId ? 0 : spellId;
            saveState(state);
            syncWindowState(state);
            window.dispatchEvent(new CustomEvent("hb-spellbar-changed"));
          }
        })
        .catch(() => { /* catalog fetch failed — drop the keypress */ });
    }
  };

  // P-unification (2026-07-28): register on the ONE funnel so the whole
  // MagicCombat map shares fate with WASD. `?inputFunnelV2=off` restores
  // the legacy standalone listener below, byte-identical.
  if (inputFunnelV2On()) {
    const funnel = getInputFunnel();
    for (const [id, def, run] of actionRows) {
      funnel.bindAction(id, def, run, {
        when: inMagicStance,
        source: "combat-bar",
      });
    }
    funnel.bindRaw("combat-bar.aliases", (ev) => {
      if (ev.altKey || ev.metaKey) return;
      if (!inMagicStance()) return;
      aliasBody(ev);
    });
    return;
  }

  window.addEventListener("keydown", (ev) => {
    try {
      if (ev.altKey || ev.metaKey) return;
      const t = ev.target;
      const tag = (t?.tagName || "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) {
        return;
      }
      if (!inMagicStance()) return;
      for (const [id, def, run] of actionRows) {
        const b = resolveLocalBinding(id, def);
        if (matchesBinding(ev, b)) {
          run();
          ev.preventDefault();
          return;
        }
      }
      aliasBody(ev);
    } catch (_) {
      // Never break global input handling on a hotkey fault.
    }
  });
}

// ============================================================================
// Task C follow-up (2026-07-01) — the retail spellcasting STRIP
// (#hb-spell-strip). Reference: live retail capture
// (Spell-Casting-Panel-Live.jpg, 717×81): a compact horizontal bar shown
// ONLY in magic stance, where retail REPLACED the melee/missile
// High/Med/Low + Recklessness panel (combat-hud.js now hides itself on
// stance 0x49 to make room — its recomputeVisible keys on
// stanceIsMeleeOrMissile). Layout matches the capture:
//
//   [tab row I..VIII, active lit]
//   [orb] [18 icon slots — gold hotkey digits on the first 9] [Cast]
//   selected-spell name label underneath ("Horizon's Blades" spot)
//
// The slots are the SAME per-tab storage the side panel, spellbook and
// digit hotkeys use (spellbook.js spellBars in
// holtburger_combat_bar_v1), so every surface stays in sync:
//   - drag a spell icon from the 📖 Spellbook onto any cell to bind it
//     (application/x-hb-spell-id, the existing drag mime)
//   - drag cell → cell to move/swap a binding within the strip
//   - right-click a cell to clear it
//   - click: self-spell casts immediately, targeted spell arms (then
//     click an enemy to fire) — identical to the panel rows / hotkeys
//   - Cast button: fires the armed spell at the selected target
//     (self-spells just cast) — retail's CastCurrentSpell.
function installSpellStrip() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const STRIP_ID = "hb-spell-strip";
  if (document.getElementById(STRIP_ID)) return;
  const ROMAN_TABS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"];
  const STANCE_MAGIC = 0x49;

  const style = document.createElement("style");
  style.id = "hb-spell-strip-style";
  style.textContent = `
    #${STRIP_ID} {
      /* left/top (or the centered default) are owned by
         attachWindowPosition — drag the orb to move, position persists
         + clamps to the viewport. */
      position: fixed; z-index: 1400; user-select: none;
    }
    #${STRIP_ID} .hb-ss-tabs { display: flex; gap: 2px; margin-left: 42px; }
    #${STRIP_ID} .hb-ss-tab {
      width: 42px; height: 17px; padding: 0; cursor: pointer;
      background: linear-gradient(#3a2f22, #241c12);
      border: 1px solid #6b5433; border-bottom: none;
      border-radius: 6px 6px 0 0;
      color: #c9b27a; font: 600 10px Georgia, serif; line-height: 16px;
    }
    #${STRIP_ID} .hb-ss-tab.active {
      background: linear-gradient(#6e5a35, #4a3a20); color: #ffe9b0;
    }
    #${STRIP_ID} .hb-ss-tab.drag-over {
      border-color: #a06eff; color: #d9c2ff;
      background: linear-gradient(#54418a, #37285e);
    }
    #${STRIP_ID} .hb-ss-main {
      display: flex; align-items: center; gap: 3px; padding: 3px 5px;
      background: linear-gradient(#2a2118, #171108);
      border: 2px solid #6b5433; border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.6);
    }
    #${STRIP_ID} .hb-ss-orb {
      flex: none; width: 30px; height: 30px; border-radius: 50%;
      border: 1px solid #0b1e33; margin-right: 3px; cursor: grab;
      background: radial-gradient(circle at 35% 30%, #cfe8ff, #4d86c8 45%, #123055 80%);
    }
    #${STRIP_ID} .hb-ss-orb:active { cursor: grabbing; }
    #${STRIP_ID} .hb-ss-slots { display: flex; gap: 2px; }
    #${STRIP_ID} .hb-ss-slot {
      position: relative; width: 32px; height: 32px; box-sizing: border-box;
      background: #0d0a06; border: 1px solid #4a3a24; cursor: pointer;
    }
    #${STRIP_ID} .hb-ss-slot.bound:hover { border-color: #caa955; }
    /* .selected = retail's current-spell highlight (Delete/PageDown
       cycling, UseSpellSlot, or a click land here); armed targeted
       spells share the same ring. */
    #${STRIP_ID} .hb-ss-slot.selected,
    #${STRIP_ID} .hb-ss-slot.armed {
      border-color: #ffd76a; box-shadow: inset 0 0 6px rgba(255, 215, 106, 0.6);
    }
    #${STRIP_ID} .hb-ss-slot.drag-over { border-color: #a06eff; }
    #${STRIP_ID} .hb-ss-icon {
      position: absolute; inset: 1px; opacity: 0;
      background-size: cover; background-position: center;
      image-rendering: pixelated;
    }
    #${STRIP_ID} .hb-ss-slot.bound .hb-ss-icon { opacity: 1; }
    #${STRIP_ID} .hb-ss-num {
      position: absolute; top: -1px; left: 1px; z-index: 1;
      font: 700 9px monospace; color: #ffd76a;
      text-shadow: 0 1px 2px #000; pointer-events: none;
    }
    #${STRIP_ID} .hb-ss-cast {
      margin-left: 6px; height: 26px; padding: 0 14px; cursor: pointer;
      background: linear-gradient(#7a1c14, #4b0e09);
      border: 1px solid #a8623c; border-radius: 3px;
      color: #f3d9a8; font: 600 12px Georgia, serif;
    }
    #${STRIP_ID} .hb-ss-cast:hover { background: linear-gradient(#93261b, #5d130c); }
    #${STRIP_ID} .hb-ss-name {
      margin: 2px 0 0 44px; min-height: 15px;
      color: #fff; font: 12px Georgia, serif; text-shadow: 0 1px 2px #000;
    }
  `;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = STRIP_ID;
  root.style.display = "none";

  const tabsEl = document.createElement("div");
  tabsEl.className = "hb-ss-tabs";
  const tabEls = [];
  for (let i = 0; i < SPELL_BAR_TABS; i++) {
    const t = document.createElement("button");
    t.type = "button";
    t.className = "hb-ss-tab";
    t.textContent = ROMAN_TABS[i] ?? String(i + 1);
    t.title = `Spell tab ${ROMAN_TABS[i] ?? i + 1}  (Insert/PageUp cycle — drop a spell here to move it to this tab)`;
    t.addEventListener("click", () => setActiveSpellBar(i));
    // Drop a spell on the numeral to move it to that tab (user spec).
    // From the strip: the source cell empties (move). From the
    // spellbook: plain add. addToFirstEmptySlot dedupes per-tab.
    t.addEventListener("dragover", (ev) => {
      if (ev.dataTransfer.types.includes("application/x-hb-spell-id")) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "copy";
        t.classList.add("drag-over");
      }
    });
    t.addEventListener("dragleave", () => t.classList.remove("drag-over"));
    t.addEventListener("drop", (ev) => {
      ev.preventDefault();
      t.classList.remove("drag-over");
      const id = parseInt(ev.dataTransfer.getData("application/x-hb-spell-id"), 10);
      if (!Number.isFinite(id) || id <= 0) return;
      const srcRaw = ev.dataTransfer.getData("application/x-hb-ss-slot");
      const src = srcRaw === "" ? -1 : parseInt(srcRaw, 10);
      const activeTab = getActiveSpellBar();
      if (src >= 0 && i !== activeTab) {
        setSpellBarSlot(src, 0); // move: vacate the source cell first
      }
      addToFirstEmptySlot(id, i);
    });
    tabEls.push(t);
    tabsEl.appendChild(t);
  }
  root.appendChild(tabsEl);

  const mainEl = document.createElement("div");
  mainEl.className = "hb-ss-main";
  const orbEl = document.createElement("div");
  orbEl.className = "hb-ss-orb";
  orbEl.title = "Spellcasting — drag the orb to move the bar";
  mainEl.appendChild(orbEl);

  const slotsWrap = document.createElement("div");
  slotsWrap.className = "hb-ss-slots";
  const slotEls = [];

  let catalog = null;
  const metaFor = (id) => (catalog ? catalog[String(id)] : null);
  const armedId = () => (window.__combatBarState?.armedSpellId | 0) || 0;

  const nameEl = document.createElement("div");
  nameEl.className = "hb-ss-name";
  const setName = (text) => {
    try { setAcText(nameEl, text || ""); } catch (_) { nameEl.textContent = text || ""; }
  };

  // === Retail selection model (Task C v2, 2026-07-02) ================
  // One "current spell" per the MagicCombat map: Delete/PageDown cycle
  // it, End (or the Cast button) casts it, UseSpellSlot digits and
  // clicks land on it too. Selection is index-based (a tab may show
  // the same icon art on different spells; index is unambiguous).
  // Selecting a TARGETED spell also arms it (armedSpellId — the same
  // storage picking.js's click-to-cast reads); selecting a self spell
  // clears the armed state so a stale bolt can't fire on entity click.
  let selectedIdx = -1;

  function writeArmed(spellId) {
    const st = loadState();
    if ((st.armedSpellId | 0) === (spellId | 0)) return;
    st.armedSpellId = spellId | 0;
    saveState(st);
    syncWindowState(st);
  }

  function selectSlot(idx, { silent = false } = {}) {
    const slots = getSpellBarSlots();
    const id = (slots[idx] | 0);
    if (!id) return false;
    selectedIdx = idx;
    if (window.__combatBarState) window.__combatBarState.selectedSlotIdx = idx;
    const meta = metaFor(id);
    const targeted = !((meta?.untargeted ?? true) === true);
    writeArmed(targeted ? id : 0);
    if (!silent) setName(meta?.name ?? `Spell ${id}`);
    render();
    return true;
  }

  function boundIndexes() {
    const slots = getSpellBarSlots();
    const out = [];
    for (let i = 0; i < slots.length; i++) if ((slots[i] | 0) > 0) out.push(i);
    return out;
  }

  // CombatPrevSpell / CombatNextSpell — cycle across BOUND cells, wraps.
  function selectDelta(dir) {
    const bound = boundIndexes();
    if (!bound.length) return;
    let pos = bound.indexOf(selectedIdx);
    if (pos === -1) pos = dir > 0 ? -1 : 0;
    const next = bound[(pos + dir + bound.length) % bound.length];
    selectSlot(next);
  }

  // CombatFirstSpell / CombatLastSpell.
  function selectEdge(which) {
    const bound = boundIndexes();
    if (!bound.length) return;
    selectSlot(which === "last" ? bound[bound.length - 1] : bound[0]);
  }

  // CombatCastCurrentSpell — cast the selection: self-spells cast on
  // ourselves, targeted spells fire at the selected target.
  function castCurrent() {
    const slots = getSpellBarSlots();
    const id = (slots[selectedIdx] | 0) || armedId();
    if (!id) {
      setName("(no spell selected — Delete/PageDown to choose)");
      return;
    }
    const meta = metaFor(id);
    const untargeted = (meta?.untargeted ?? true) === true;
    if (untargeted) {
      castSpellViaHandle(id, null);
      setName(meta?.name ?? `Spell ${id}`);
      return;
    }
    const tgt =
      (window.liveScene3d?.entityManager?.getSelectedTarget?.() >>> 0) || 0;
    if (!tgt) {
      setName("(no target selected)");
      // WS14 — surface the retail client string (acclient.c:404772) on the
      // shared toast surface, not just the strip name label. This is the
      // End-key / Cast-button path (no click-to-cast follow-up implied); the
      // fireSlot() armed-no-target path keeps its "click a target" name hint.
      try {
        window.__pluginClient?.events?.emit?.("clientActionRejected", {
          message: "You must select a suitable target before casting this spell.",
        });
      } catch (_) {}
      return;
    }
    castSpellViaHandle(id, tgt);
    setName(meta?.name ?? `Spell ${id}`);
  }

  // UseSpellSlot_N / cell click: select the cell, then act — self
  // spells cast immediately; targeted spells cast when a target is
  // already selected, else stay armed for the click-to-cast flow.
  function fireSlot(idx) {
    const id = (getSpellBarSlots()[idx] | 0);
    if (!id) return;
    selectSlot(idx, { silent: true });
    const meta = metaFor(id);
    const untargeted = (meta?.untargeted ?? true) === true;
    if (untargeted) {
      castSpellViaHandle(id, null);
      setName(meta?.name ?? `Spell ${id}`);
      return;
    }
    const tgt =
      (window.liveScene3d?.entityManager?.getSelectedTarget?.() >>> 0) || 0;
    if (tgt) {
      castSpellViaHandle(id, tgt);
      setName(meta?.name ?? `Spell ${id}`);
    } else {
      setName(`${meta?.name ?? `Spell ${id}`} — armed, click a target`);
    }
  }

  for (let i = 0; i < SPELL_BAR_SLOTS; i++) {
    const el = document.createElement("div");
    el.className = "hb-ss-slot";
    el.dataset.slot = String(i);
    const icon = document.createElement("div");
    icon.className = "hb-ss-icon";
    el.appendChild(icon);
    if (i < 9) {
      const num = document.createElement("span");
      num.className = "hb-ss-num";
      num.textContent = String(i + 1);
      el.appendChild(num);
    }
    el.addEventListener("click", () => fireSlot(i));
    el.addEventListener("mouseenter", () => {
      const id = (getSpellBarSlots()[i] | 0);
      if (id) setName(metaFor(id)?.name ?? `Spell ${id}`);
    });
    const clearCell = () => {
      const id = (getSpellBarSlots()[i] | 0);
      if (!id) return;
      if (armedId() === id) writeArmed(0);
      if (selectedIdx === i) selectedIdx = -1;
      setSpellBarSlot(i, 0);
    };
    el.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      clearCell();
    });
    el.draggable = true;
    el.addEventListener("dragstart", (ev) => {
      const id = (getSpellBarSlots()[i] | 0);
      if (!id) { ev.preventDefault(); return; }
      ev.dataTransfer.effectAllowed = "copyMove";
      ev.dataTransfer.setData("application/x-hb-spell-id", String(id));
      ev.dataTransfer.setData("application/x-hb-ss-slot", String(i));
    });
    // Dragging a spell OFF the bar removes it (user spec — retail
    // behavior). If no drop target accepted the drag, the browser
    // reports dropEffect "none" on dragend: the strip's own cells /
    // tabs and the hotbar all set copy, so an internal move or a
    // hotbar shortcut-bind never triggers the removal.
    el.addEventListener("dragend", (ev) => {
      if (ev.dataTransfer && ev.dataTransfer.dropEffect === "none") {
        clearCell();
        setName("(spell removed from the bar)");
      }
    });
    el.addEventListener("dragover", (ev) => {
      if (ev.dataTransfer.types.includes("application/x-hb-spell-id")) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "copy";
        el.classList.add("drag-over");
      }
    });
    el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
    el.addEventListener("drop", (ev) => {
      ev.preventDefault();
      el.classList.remove("drag-over");
      const id = parseInt(ev.dataTransfer.getData("application/x-hb-spell-id"), 10);
      if (!Number.isFinite(id) || id <= 0) return;
      const srcRaw = ev.dataTransfer.getData("application/x-hb-ss-slot");
      const src = srcRaw === "" ? -1 : parseInt(srcRaw, 10);
      if (Number.isFinite(src) && src >= 0 && src !== i) {
        // strip-internal move: swap the two cells.
        const cur = (getSpellBarSlots()[i] | 0);
        setSpellBarSlot(i, id);
        setSpellBarSlot(src, cur);
      } else if (src !== i) {
        setSpellBarSlot(i, id);
      }
    });
    slotEls.push(el);
    slotsWrap.appendChild(el);
  }
  mainEl.appendChild(slotsWrap);

  const castBtn = document.createElement("button");
  castBtn.type = "button";
  castBtn.className = "hb-ss-cast";
  castBtn.textContent = "Cast";
  castBtn.title = "Cast the armed spell at your selected target";
  // Cast button = retail CombatCastCurrentSpell (End key), same code path.
  castBtn.addEventListener("click", () => castCurrent());
  mainEl.appendChild(castBtn);
  root.appendChild(mainEl);
  root.appendChild(nameEl);
  document.body.appendChild(root);

  // Draggable frame (user spec) — the orb is the grip. Position
  // persists per the shared hb.window.* store and clamps back into
  // the viewport on restore. 0x21000031 is a synthetic window id in
  // the retail gm-UI id space (gmSpellbookUI = 0x21000032 per the
  // spellbook port; the spellcasting panel's exact retail id is
  // unverified). Default: centered above the chat/target bars.
  let posCtl = null;
  try {
    posCtl = attachWindowPosition(root, {
      windowId: 0x21000031,
      dragHandle: orbEl,
      defaultPos: { left: "calc(50% - 372px)", bottom: "96px" },
    });
  } catch (_) { /* position helper failure must never kill the strip */ }

  // The strip mounts display:none (magic-stance gating), so
  // attachWindowPosition's restore-time viewport clamp measures a 0×0
  // element and can't catch a stale/bogus saved position. Re-check on
  // every show transition with REAL geometry; a strip parked outside
  // the viewport snaps back to the centered default.
  function reclampIntoViewport() {
    try {
      const r = root.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const off =
        r.left < 0 || r.top < 0 ||
        r.right > window.innerWidth + 4 ||
        r.bottom > window.innerHeight + 4;
      if (off) {
        if (posCtl?.resetPosition) {
          posCtl.resetPosition();
        }
        root.style.left = "calc(50% - 372px)";
        root.style.top = "auto";
        root.style.bottom = "96px";
      }
    } catch (_) {}
  }

  loadCatalog().then((c) => { catalog = c; render(); }).catch(() => {});

  function render() {
    const active = getActiveSpellBar();
    for (let i = 0; i < tabEls.length; i++) {
      tabEls[i].classList.toggle("active", i === active);
    }
    const slots = getSpellBarSlots();
    const armed = armedId();
    for (let i = 0; i < slotEls.length; i++) {
      const el = slotEls[i];
      const id = (slots[i] | 0);
      const meta = id ? metaFor(id) : null;
      el.classList.toggle("bound", !!id);
      const isTargeted = !!id && !((meta?.untargeted ?? true) === true);
      // Current-spell ring: index selection (keyboard/click) OR the
      // armed targeted spell (click-to-cast flow).
      el.classList.toggle("selected", !!id && i === selectedIdx);
      el.classList.toggle("armed", !!id && isTargeted && id === armed);
      el.title = id
        ? `${meta?.name ?? `Spell ${id}`}${isTargeted ? " — click to cast at your target" : " — click to cast"} (drag off the bar to remove)`
        : "(empty — drag a spell here from the Spellbook)";
      const icon = el.querySelector(".hb-ss-icon");
      const key = id ? `spell:${id}` : "";
      if (icon.dataset.boundKey === key) continue; // no repaint churn
      icon.dataset.boundKey = key;
      if (!id) { icon.style.backgroundImage = ""; continue; }
      // Same shared resolver + in-flight guard as the hotbar slots.
      resolveBindingIcon({ spellId: id }).then((url) => {
        if (icon.dataset.boundKey !== key) return;
        if (url) icon.style.backgroundImage = `url("${url}")`;
      }).catch(() => { /* resolver logs; cell stays dark */ });
    }
  }

  window.addEventListener("hb-spellbar-changed", render);

  // Hotkey handler + any external caller reach the strip through this
  // module-scope surface (declared above installSpellBarHotkeys).
  __stripApi = { render, fireSlot, selectDelta, selectEdge, castCurrent };

  // Visibility: magic stance only (retail swaps this strip in where the
  // melee power panel lived). 500 ms poll mirrors combat-hud's fallback
  // cadence; the poll also diffs armed/active/selected state so a
  // panel-row arm (which doesn't dispatch hb-spellbar-changed) still
  // refreshes us.
  let lastVisible = false;
  let lastPanelMagic = null;
  let lastArmed = -1;
  let lastActive = -1;
  let lastSelected = -2;
  setInterval(() => {
    let on = false;
    try { on = window.__getCurrentStanceLow?.() === STANCE_MAGIC; } catch (_) {}
    // WS14 (patch B) — refresh the OPEN spellbook panel's armed/wrong-stance
    // amber cue on any Magic-stance transition. The panel is a separate closure
    // from this strip and may be open while not in Magic stance; its cue only
    // updates on re-render, so drive one here. (Strip visibility below is
    // separate.) No-op when the panel is closed (hook nulled on dispose).
    if (on !== lastPanelMagic) {
      lastPanelMagic = on;
      try { window.__combatBarPanelRerender?.(); } catch (_) {}
    }
    if (on !== lastVisible) {
      lastVisible = on;
      root.style.display = on ? "" : "none";
      if (!on) setName("");
      if (on) {
        render();
        reclampIntoViewport();
      }
    }
    if (on) {
      const a = armedId();
      const act = getActiveSpellBar();
      if (act !== lastActive && lastActive !== -1) {
        // Selection is per-tab — changing tabs drops the current-spell
        // ring rather than silently pointing at a different spell.
        selectedIdx = -1;
        if (window.__combatBarState) window.__combatBarState.selectedSlotIdx = -1;
      }
      if (a !== lastArmed || act !== lastActive || selectedIdx !== lastSelected) {
        lastArmed = a;
        lastActive = act;
        lastSelected = selectedIdx;
        render();
      }
    }
  }, 500);
}

// F11-3 — attackInProgress lockout lifecycle, owned at module-load.
//
// The flag (`window.__combatBarState.attackInProgress`) gates rapid attack
// clicks in scene3d/picking.js. Previously the ONLY clearers lived inside
// the power-meter closure (`attachPowerMeter`), which exists ONLY while the
// combat panel is open — so an attack fired with the panel closed left the
// flag stuck (the next click silently gated), and the ack-loss safety
// timeout was never armed either. Mirroring installAutoDisarmHooks, we
// subscribe the clearers here so the lockout is released whether or not the
// panel is open. attachPowerMeter now drives the VISUAL meter only. Two
// triggers:
//   - `attackDone` — server says the swing finished; release immediately.
//   - a safety timeout armed on `combatCommenceAttack` — releases the flag
//     if attackDone is dropped (ACE error, packet loss, disconnect
//     mid-swing). Duration mirrors the power-meter refill estimate.
function installAttackLockoutHooks() {
  let pollTimer = null;
  let lockoutTimeoutId = 0;
  const clearLockout = () => {
    const cb = window.__combatBarState;
    if (cb) cb.attackInProgress = false;
    if (lockoutTimeoutId) {
      clearTimeout(lockoutTimeoutId);
      lockoutTimeoutId = 0;
    }
  };

  function tryHook() {
    const client = window.__pluginClient ?? null;
    if (!client?.events?.on) {
      return false;
    }
    client.events.on("attackDone", clearLockout);
    client.events.on("combatCommenceAttack", () => {
      // Match attachPowerMeter's refill estimate (~0.6s low … ~1.8s full)
      // plus a 1s ack-loss margin.
      const power = (window.__combatBarState?.powerLevel ?? 1.0);
      const refillDurMs = 600 + power * 1200;
      if (lockoutTimeoutId) clearTimeout(lockoutTimeoutId);
      lockoutTimeoutId = setTimeout(clearLockout, refillDurMs + 1000);
    });
    return true;
  }

  if (!tryHook()) {
    pollTimer = setInterval(() => {
      if (tryHook()) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }, 500);
  }
  // No teardown — mirrors installAutoDisarmHooks; the disposer lives for
  // the page lifetime (bar teardown isn't plumbed today).
}

// Stance label — one-word descriptor read off the wasm-side stance.
// Mirrors `plugins/stance-toggle.js`'s classifyStance + STANCE_LABELS
// before that plugin was folded in here (2026-05-17).
function stanceWord() {
  const low = (typeof window !== "undefined" && typeof window.__getCurrentStanceLow === "function")
    ? window.__getCurrentStanceLow()
    : 0x003d;
  if (low === 0x003d) return "Peace";
  if (low === 0x0049) return "Magic";
  if (RANGED_STANCES.has(low)) return "Missile";
  if (MELEE_STANCES.has(low)) return "Melee";
  return "Other";
}

// Header injected at the top of every stance-form (attack controls
// AND spell picker). Folds the old `stance-toggle` plugin into the
// combat-bar so one panel covers stance + attack settings + spell
// picking. The bar slot for stance-toggle was removed from
// index.html on the same change.
function renderStanceHeader(bodyEl, client) {
  const row = document.createElement("div");
  row.className = "hb-cb-row hb-cb-stance-row";
  const label = document.createElement("label");
  setAcText(label, "Stance");
  row.appendChild(label);
  const val = document.createElement("span");
  val.className = "hb-cb-stance-val";
  row.appendChild(val);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "hb-cb-stance-btn";
  row.appendChild(btn);
  bodyEl.appendChild(row);

  function refresh() {
    const w = stanceWord();
    setAcText(val, w);
    setAcText(btn, w === "Peace" ? "Combat" : "Peace");
  }
  btn.addEventListener("click", () => {
    try {
      // Use the JS-side stance label as the source of truth for
      // current state — read `__getCurrentStanceLow()` (authoritative;
      // `applyConfirmedStance` updates it on every kind=5 UpdateMotion).
      // When LEAVING Peace, pick the target mode from the equipped
      // weapon (Missile/Magic/Melee) so bow- and wand-wielders actually
      // enter combat — a hardcoded Melee is silently reverted by ACE for
      // those classes, and mages could never reach the spell picker via
      // this button (F11-1). CombatMode flag values: NonCombat=1,
      // Melee=2, Missile=4, Magic=8.
      const inCombat = stanceWord() !== "Peace";
      const handle = window.__sessionHandle;
      let targetMode = 1; // NonCombat (entering Peace).
      if (!inCombat) {
        let inv = [];
        try {
          inv = typeof handle?.playerInventory === "function" ? handle.playerInventory() : [];
        } catch (_) {}
        targetMode = suggestedCombatModeFromInventory(inv);
      }
      if (typeof handle?.setCombatMode === "function") {
        handle.setCombatMode(targetMode);
      } else if (typeof client?.player?.toggleCombatMode === "function") {
        // Fallback for older wasm bundles without setCombatMode —
        // toggleCombatMode now reads the hydrated CombatMode and picks
        // the equipment-suggested mode itself (post-Wave-6.A).
        client.player.toggleCombatMode();
      }
    } catch (e) {
      console.warn(`[combat-bar] setCombatMode failed: ${e?.message ?? e}`);
    }
    setTimeout(refresh, 250);
  });
  if (client?.events?.on) {
    const onStats = () => refresh();
    client.events.on("playerStatsUpdated", onStats);
    bodyEl.__stanceHeaderDispose = () => {
      try { client.events.off("playerStatsUpdated", onStats); } catch {}
    };
  } else {
    bodyEl.__stanceHeaderDispose = () => {};
  }
  refresh();
}

// ── Render helpers ──────────────────────────────────────────────
// Each render fn populates `bodyEl` with its stance-specific UI;
// they share the damage-feed code at the bottom of activate().

function renderAttackControls(bodyEl, state) {
  // Height picker — one-word labels (Hi/Mid/Lo). Stance header is
  // injected by activate() before this fn runs.
  const heightRow = document.createElement("div");
  heightRow.className = "hb-cb-row";
  const heightLabel = document.createElement("label");
  setAcText(heightLabel, "Height");
  heightRow.appendChild(heightLabel);
  const heightGroup = document.createElement("div");
  heightGroup.className = "hb-cb-heights";
  const HEIGHTS = [
    { value: 1, label: "Hi" },
    { value: 2, label: "Mid" },
    { value: 3, label: "Lo" },
  ];
  const heightButtons = new Map();
  for (const h of HEIGHTS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hb-cb-height-btn";
    setAcText(btn, h.label);
    btn.dataset.value = String(h.value);
    if (state.attackHeight === h.value) btn.classList.add("active");
    btn.addEventListener("click", () => {
      state.attackHeight = h.value;
      for (const [v, b] of heightButtons) {
        b.classList.toggle("active", v === h.value);
      }
      saveState(state);
      syncWindowState(state);
      // Retail UX (2026-05-19) — clicking Hi/Med/Lo also FIRES the
      // attack on the currently selected target. The fire helper
      // (set on `window` by `scene3d/picking.js::setupClickPicking`)
      // reads the selected target + power + chargeAttack flag and
      // routes through the same lockout/charge path the click handler
      // used to. No-op if no target selected, wrong stance, or
      // attack still in flight.
      try {
        window.__fireAttackOnTarget?.(h.value);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[combat-bar] fire-on-height click: ${e?.message ?? e}`);
      }
    });
    heightButtons.set(h.value, btn);
    heightGroup.appendChild(btn);
  }
  heightRow.appendChild(heightGroup);
  bodyEl.appendChild(heightRow);

  // Power / Accuracy slider — label flips based on local combat stance.
  const powerRow = document.createElement("div");
  powerRow.className = "hb-cb-row hb-cb-power-row";
  const powerLabel = document.createElement("label");
  // bug-effects-text Part B — "Accuracy" is longer than "Power" and can
  // overflow the row label slot; fit auto-shrinks to the label's own
  // laid-out width instead of hard-clipping.
  setAcText(powerLabel, currentStanceIsRanged() ? "Accuracy" : "Power", { fit: true });
  powerRow.appendChild(powerLabel);
  // Slider lives inside a position-relative wrapper so the Recklessness
  // active-band overlay can be positioned absolutely between 10–90% of
  // the slider's effective width without disturbing flex layout. The
  // band is purely visual — see refreshRecklessnessBand() below.
  const powerWrap = document.createElement("span");
  powerWrap.className = "hb-cb-power-wrap";
  const powerSlider = document.createElement("input");
  powerSlider.type = "range";
  powerSlider.min = "0";
  powerSlider.max = "100";
  powerSlider.step = "1";
  powerSlider.value = String(Math.round(state.powerLevel * 100));
  // Band element — populated/cleared by refreshRecklessnessBand(). The
  // band is gated on (a) Recklessness Trained/Specialized AND (b) a
  // non-magic stance. Inserted before the slider so the slider's thumb
  // (z-index 1) stacks above the band (z-index 0) on every browser.
  const reckBand = document.createElement("span");
  reckBand.className = "hb-cb-power-band";
  reckBand.style.display = "none";
  powerWrap.appendChild(reckBand);
  powerWrap.appendChild(powerSlider);
  // Hook the band to playerStatsUpdated so a mid-session training-level
  // change (redistribution gem, GM /skill set, etc.) re-evaluates the
  // overlay without requiring the panel to close+reopen.
  let _reckSub = null;
  function refreshRecklessnessBand() {
    // Magic stance — combat-bar transforms to spell-picker entirely
    // (renderSpellPicker, not this fn), but defense-in-depth: if some
    // future path leaves the slider rendered in magic, the band stays
    // off because Recklessness doesn't apply to magic per the wiki.
    if (currentStanceIsMagic()) {
      reckBand.style.display = "none";
      return;
    }
    const lvl = readRecklessnessTrainingLevel();
    if (lvl !== TRAINING_TRAINED && lvl !== TRAINING_SPECIALIZED) {
      reckBand.style.display = "none";
      return;
    }
    const bonus = (lvl === TRAINING_SPECIALIZED) ? 20 : 10;
    reckBand.style.display = "";
    reckBand.classList.toggle("hb-cb-power-band-spec", lvl === TRAINING_SPECIALIZED);
    reckBand.title =
      `Recklessness active: +${bonus} Damage Rating ` +
      `(also +${bonus} incoming non-crit damage from all sources). ` +
      `Band is 10%–90% of the power bar.`;
  }
  refreshRecklessnessBand();
  // The host client may not be wired yet at activate-time on a fresh
  // session; fall back to __pluginClient lazily. We also re-check on
  // playerStatsUpdated since the first kind=8 may carry the skill row.
  const _reckClient = (typeof window !== "undefined") ? window.__pluginClient : null;
  if (_reckClient?.events?.on) {
    const onStats = () => refreshRecklessnessBand();
    _reckClient.events.on("playerStatsUpdated", onStats);
    _reckSub = () => {
      try { _reckClient.events.off("playerStatsUpdated", onStats); } catch (_) {}
    };
  }
  // Expose teardown via bodyEl so activate()'s dispose chain runs it
  // alongside the existing __powerMeterDispose / __spellPickerDispose.
  bodyEl.__reckBandDispose = () => {
    try { if (_reckSub) _reckSub(); } catch (_) {}
  };
  powerRow.appendChild(powerWrap);
  const powerVal = document.createElement("span");
  powerVal.className = "hb-cb-power-val";
  setAcText(powerVal, `${powerSlider.value}%`);
  // F1 — coalesce slider `input` syncs to one per animation frame.
  // The label / numeric readout updates synchronously (cheap, and
  // the user wants instant visual feedback), but `syncWindowState`
  // (which writes window.__combatBarState and is polled by picking +
  // wire dispatch) only fires once per frame at most. Drag at 60+ Hz
  // → 60 Hz max writes instead of one per pointermove tick.
  //
  // F2 already uses a `rafId` inside the power-meter IIFE; that
  // closure is separate so a unique name here (`_powerSyncRafId`)
  // keeps the two coalescers clearly distinct.
  let _powerSyncRafId = 0;
  powerSlider.addEventListener("input", () => {
    state.powerLevel = Number(powerSlider.value) / 100;
    setAcText(powerVal, `${powerSlider.value}%`);
    if (_powerSyncRafId !== 0) return; // already scheduled this frame
    _powerSyncRafId = requestAnimationFrame(() => {
      _powerSyncRafId = 0;
      syncWindowState(state);
    });
  });
  powerSlider.addEventListener("change", () => {
    // Release — cancel any pending coalesced sync and flush the final
    // value immediately so the wire-side state lands without waiting
    // another frame, then persist to localStorage.
    if (_powerSyncRafId !== 0) {
      cancelAnimationFrame(_powerSyncRafId);
      _powerSyncRafId = 0;
    }
    syncWindowState(state);
    saveState(state);
  });
  // Slider is already inside powerWrap (which sits in powerRow). The
  // previous append of powerSlider directly on powerRow was removed
  // when the powerWrap layer was added (Phase 8 Recklessness band).
  powerRow.appendChild(powerVal);
  bodyEl.appendChild(powerRow);

  // Auto-repeat tickbox
  const repeatLabel = document.createElement("label");
  repeatLabel.className = "hb-cb-toggle";
  const repeatBox = document.createElement("input");
  repeatBox.type = "checkbox";
  repeatBox.checked = !!state.autoRepeat;
  repeatBox.addEventListener("change", () => {
    state.autoRepeat = repeatBox.checked;
    saveState(state);
    syncWindowState(state);
    // F11-2 — actually drive ACE's auto-attack loop. Without this the
    // checkbox only flipped a local flag no consumer read; ACE defaults
    // AutoRepeatAttacks OFF, so combat was one-click-one-swing. Now ACE
    // re-fires on each AttackDone while this is set (mirrors the Fast
    // Missiles Path-B wiring above). Fire-and-forget; fail-softs pre-login.
    setAutoRepeatAttacks(repeatBox.checked);
  });
  repeatLabel.appendChild(repeatBox);
  const repeatText = document.createElement("span");
  setAcText(repeatText, "Repeat");
  repeatLabel.appendChild(repeatText);
  bodyEl.appendChild(repeatLabel);
  // F11-2 — ACE defaults AutoRepeatAttacks OFF while the UI default is
  // ON, so push the current checkbox value once on mount to make the
  // displayed state authoritative (fail-softs pre-login).
  setAutoRepeatAttacks(!!state.autoRepeat);
  // Subscribe to playerStatsUpdated to keep the checkbox in lockstep
  // with ACE's echoed CharacterOptions1/2 bits (e.g. another client
  // toggled the option, or ACE clamped/rejected our write). Falls back
  // to localStorage when the wasm side returns null (pre-login).
  const _autoRepClient = (typeof window !== "undefined") ? window.__pluginClient : null;
  if (_autoRepClient?.events?.on) {
    const onAutoRepStats = () => {
      const server = isCharacterOptionEnabled(CHARACTER_OPTION.AutoRepeatAttacks, null);
      if (server === null) return;
      if (server === repeatBox.checked) return;
      repeatBox.checked = server;
      state.autoRepeat = server;
      saveState(state);
      syncWindowState(state);
    };
    _autoRepClient.events.on("playerStatsUpdated", onAutoRepStats);
    const _autoRepDispose = () => {
      try { _autoRepClient.events.off("playerStatsUpdated", onAutoRepStats); } catch (_) {}
    };
    const prevDispose = bodyEl.__autoRepDispose;
    bodyEl.__autoRepDispose = () => {
      try { prevDispose?.(); } catch (_) {}
      try { _autoRepDispose(); } catch (_) {}
    };
  }

  // Phase I.1 — Charge Attack tickbox (retail's "Use Charge Attack").
  const chargeLabel = document.createElement("label");
  chargeLabel.className = "hb-cb-toggle";
  const chargeBox = document.createElement("input");
  chargeBox.type = "checkbox";
  chargeBox.checked = state.chargeAttack !== false;
  chargeBox.addEventListener("change", () => {
    state.chargeAttack = chargeBox.checked;
    saveState(state);
    syncWindowState(state);
  });
  chargeLabel.appendChild(chargeBox);
  const chargeText = document.createElement("span");
  setAcText(chargeText, "Charge");
  chargeLabel.appendChild(chargeText);
  bodyEl.appendChild(chargeLabel);

  // Wave 10 / Phase 32 (2026-05-26) — UseFastMissiles tickbox. Shown
  // ONLY in a missile/ranged stance — irrelevant to melee (no
  // projectile arc to boost) and to magic (renderSpellPicker, not this
  // fn). Default OFF, opt-in only. See DEFAULTS docstring for the
  // full picture. Wave 11 / Phase 33 (2026-05-26) closed the wire-side
  // TODO: the change handler now also calls `setUseFastMissiles(...)`
  // from `ui/ac_character_options.js`, which routes through
  // `SessionHandle.setCharacterOption` → `GameAction::
  // SetSingleCharacterOption` so ACE applies its 1.2× modifier
  // server-side. Path A (the client-side prediction multiplier in
  // `picking.js`) stays in place — both run together.
  if (currentStanceIsRanged()) {
    const fastMissileLabel = document.createElement("label");
    fastMissileLabel.className = "hb-cb-toggle";
    fastMissileLabel.title =
      "Fast Missiles (UseFastMissiles): boosts arrow / bolt / dart " +
      "speed by 1.2× and shortens draw cadence. Currently a client-" +
      "side prediction aid only — the server speedup requires the " +
      "CharacterOption bit to be set on your ACE character (TODO).";
    const fastMissileBox = document.createElement("input");
    fastMissileBox.type = "checkbox";
    fastMissileBox.checked = state.useFastMissiles === true;
    fastMissileBox.addEventListener("change", () => {
      state.useFastMissiles = fastMissileBox.checked;
      saveState(state);
      syncWindowState(state);
      // Wave 11 Phase 33 (2026-05-26) — Path B: ALSO tell ACE to flip
      // the CharacterOption bit so the server-side 1.2× multiplier
      // fires on the next missile engagement. Path A's client-side
      // prediction multiplier in picking.js stays in place (the two
      // are complementary — Path A keeps the local arc in sync, Path
      // B makes ACE actually apply the launcher-velocity boost). Fire-
      // and-forget — the wasm facade fail-softs if there's no session
      // yet (pre-login), and ACE echoes the bit back through the
      // existing CharacterOptions1/2 stats pipeline on success.
      setUseFastMissiles(fastMissileBox.checked);
    });
    fastMissileLabel.appendChild(fastMissileBox);
    const fastMissileText = document.createElement("span");
    // bug-effects-text Part B — "Fast Missiles" is the widest toggle
    // label in the panel; fit auto-shrinks to the span's laid-out width.
    setAcText(fastMissileText, "Fast Missiles", { fit: true });
    fastMissileLabel.appendChild(fastMissileText);
    bodyEl.appendChild(fastMissileLabel);
  }

  // Phase H.6 — power-bar meter. Subscribes to combatCommenceAttack +
  // attackDone events to animate the refill cycle. Refill duration is
  // approximated from the current power slider (retail's
  // nextRefillTime ≈ PowerLevel × ~1.5s for melee). We don't know the
  // exact refillMod ACE uses; the visual feedback approximates it.
  const meter = document.createElement("div");
  meter.className = "hb-cb-power-meter ready";
  const meterBar = document.createElement("div");
  meterBar.className = "hb-cb-power-meter-bar";
  const meterFill = document.createElement("div");
  meterFill.className = "hb-cb-power-meter-fill";
  meterFill.style.width = "100%";
  meterBar.appendChild(meterFill);
  meter.appendChild(meterBar);
  bodyEl.appendChild(meter);

  // Expose tween handle so the activate() teardown can clear it.
  bodyEl.__powerMeterDispose = (function attachPowerMeter() {
    const client = window.__pluginClient;
    if (!client?.events?.on) return () => {};

    let refillStartMs = 0;
    let refillDurMs = 1500;
    let rafId = 0;
    // F10-3 — DEFAULT-ON (`!== "off"` reader): the meter is driven off the
    // resolved swing-clip length (passed on the combatCommenceAttack detail
    // by picking.js); `?powerMeterSwingDuration=off` restores the
    // pure-power heuristic (pre-F10-3 timing).
    const useSwingDuration = (() => {
      try {
        return new URLSearchParams(window.location.search).get("powerMeterSwingDuration") !== "off";
      } catch (_) { return false; }
    })();
    // F2: when the bar / panel is hidden mid-refill we stop scheduling
    // rAFs and remember to resume on the next visible frame so the
    // power slider, refill duration, and elapsed time all stay correct.
    let pendingResume = false;
    let visibilityObserver = null;

    function isHidden() {
      // offsetParent === null catches display:none on any ancestor and
      // detachment from the DOM. It's the cheapest layout-free check
      // (no getBoundingClientRect → no forced reflow).
      return meterFill.offsetParent === null;
    }

    function tick() {
      // F2 gate — bail without scheduling another frame if the meter
      // (or any ancestor) is display:none / detached. The next
      // combatCommenceAttack will reset state + restart; the
      // visibilityObserver below picks up "becomes visible again with
      // refill still in flight" so the meter resumes from where it
      // would have been.
      if (isHidden()) {
        pendingResume = true;
        rafId = 0;
        return;
      }
      pendingResume = false;
      const elapsed = performance.now() - refillStartMs;
      const t = Math.min(1, elapsed / refillDurMs);
      meterFill.style.width = `${(t * 100).toFixed(1)}%`;
      if (t < 1) {
        rafId = requestAnimationFrame(tick);
      } else {
        meter.classList.remove("refilling");
        meter.classList.add("ready");
        rafId = 0;
      }
    }

    // F2 restart path — watch the panel subtree for attribute changes
    // (display / class toggles on any ancestor of the meter). When the
    // meter flips back to visible while a refill is still pending,
    // re-enter tick() so the loop picks up from where it left off
    // (refillStartMs is preserved across the hidden interval, so the
    // first visible frame snaps to the correct elapsed position).
    if (typeof MutationObserver === "function") {
      visibilityObserver = new MutationObserver(() => {
        if (pendingResume && !isHidden() && rafId === 0) {
          rafId = requestAnimationFrame(tick);
        }
      });
      // Walk up to the nearest containing panel root (or body) and
      // watch style/class mutations on each ancestor. attributeFilter
      // keeps the observer cheap.
      let node = meterFill.parentElement;
      while (node && node !== document.body) {
        visibilityObserver.observe(node, {
          attributes: true,
          attributeFilter: ["style", "class", "hidden"],
        });
        node = node.parentElement;
      }
    }

    // F11-3 — the attackInProgress lockout flag is no longer cleared in
    // this closure. Its full lifecycle (arm the ack-loss safety timeout on
    // commence, clear on attackDone) now lives in `installAttackLockoutHooks()`
    // at module-load, so the flag is released even when the combat panel is
    // closed (this meter only exists while the panel is open). attachPowerMeter
    // drives the VISUAL meter only.
    const onCommence = (ev) => {
      // Power slider drives the default expected refill duration.
      const power = (window.__combatBarState?.powerLevel ?? 1.0);
      // F10-3 — when `?powerMeterSwingDuration=on` AND picking.js resolved
      // the actual swing-clip length (typed motion-link lookup, passed on
      // the event detail), drive the meter off that so the fill tracks the
      // visible swing cadence instead of the pure-power heuristic, which
      // drifts at most power settings. Falls back to the heuristic when the
      // duration isn't available — MT not cached yet, or a server-driven
      // auto-repeat re-arm that carries no detail. (NOTE: the meter already
      // animated on the first/single swing pre-F10-3 — picking.js's
      // local-fire emit seeds it; the doc's "never animate" premise was
      // stale. This only refines the DURATION.)
      const swingMs = useSwingDuration ? Number(ev?.detail?.swingDurationMs) : 0;
      refillDurMs = (Number.isFinite(swingMs) && swingMs > 0)
        ? swingMs
        : (600 + power * 1200); // ~0.6s low, ~1.8s full
      refillStartMs = performance.now();
      meter.classList.remove("ready");
      meter.classList.add("refilling");
      meterFill.style.width = "0%";
      if (rafId) cancelAnimationFrame(rafId);
      // F2: if the bar is hidden right now, mark pending so the
      // visibilityObserver picks it up when we become visible again.
      // Don't schedule a frame we'd immediately bail on.
      if (isHidden()) {
        pendingResume = true;
        rafId = 0;
        return;
      }
      pendingResume = false;
      rafId = requestAnimationFrame(tick);
    };
    const onDone = () => {
      // AttackDone — power refilled, ready for next swing. Release
      // the lockout flag so picking.js will accept the next click.
      meter.classList.remove("refilling");
      meter.classList.add("ready");
      meterFill.style.width = "100%";
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      pendingResume = false;
    };

    // Strike-frame pulse: the kind=19→`combatStrikeFrame` event fires
    // when our swing animation reaches its retail AttackHook
    // (hookType=3) timestamp — the actual strike moment. Pulse the
    // meter so the visual lands on the hit, not on swing-start.
    // Filter to OUR swings only (`attackerGuid === localPlayerGuid`)
    // so an enemy hitting us doesn't trigger our recovery meter.
    let pulseTimeoutId = 0;
    const onStrike = (ev) => {
      const detail = ev?.detail ?? {};
      const attackerGuid = (detail.attackerGuid >>> 0);
      if (attackerGuid === 0) return;
      let localGuid = 0;
      try {
        localGuid = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;
      } catch (_) {}
      if (localGuid === 0 || attackerGuid !== localGuid) return;
      // Animation is on a CSS class — restart it cleanly even if a
      // previous pulse is still running by removing + reflowing +
      // re-adding. `void offsetWidth` is the canonical force-reflow
      // trick that resets the keyframe playhead.
      if (pulseTimeoutId) clearTimeout(pulseTimeoutId);
      meter.classList.remove("strike-pulse");
      void meter.offsetWidth;
      meter.classList.add("strike-pulse");
      pulseTimeoutId = setTimeout(() => {
        meter.classList.remove("strike-pulse");
        pulseTimeoutId = 0;
      }, 240);
    };

    client.events.on("combatCommenceAttack", onCommence);
    client.events.on("attackDone", onDone);
    client.events.on("combatStrikeFrame", onStrike);
    // F2 open-path restart: if attachPowerMeter is re-entered while a
    // refill is in flight (e.g. the panel was reopened mid-refill in
    // a future architecture that retains meter state across opens),
    // start the loop straight away. In the current code each activate()
    // creates a fresh closure so this is a no-op, but the check makes
    // the gate self-contained.
    if (meter.classList.contains("refilling") && rafId === 0 && !isHidden()) {
      rafId = requestAnimationFrame(tick);
    }
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      if (pulseTimeoutId) clearTimeout(pulseTimeoutId);
      meter.classList.remove("strike-pulse");
      // F11-3 — the lockout flag is NOT cleared on panel teardown any
      // more. Clearing it on close prematurely released a real in-flight
      // lockout (close the panel mid-swing → the next click double-fires
      // the windup). `installAttackLockoutHooks()` owns the flag now and
      // clears it on attackDone / ack-loss timeout regardless of panel
      // state, so closing the panel is purely visual.
      if (visibilityObserver) visibilityObserver.disconnect();
      client.events.off("combatCommenceAttack", onCommence);
      client.events.off("attackDone", onDone);
      client.events.off("combatStrikeFrame", onStrike);
    };
  })();
}

function renderSpellPicker(bodyEl, state) {
  // Banner naming the stance — magic combat with wand/orb/staff equipped.
  const hint = document.createElement("div");
  hint.className = "hb-cb-magic-hint";
  setAcText(
    hint,
    "Magic stance — click a self-spell to cast on yourself, or arm a target spell then click an enemy.",
  );
  bodyEl.appendChild(hint);

  // Phase I.2 — numbered tab strip (retail had 7).
  const tabsEl = document.createElement("div");
  tabsEl.className = "hb-cb-tabs";
  const tabButtons = [];
  for (let i = 0; i < SPELL_BAR_TABS; i++) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "hb-cb-tab";
    setAcText(tab, String(i + 1));
    tab.dataset.tabIndex = String(i);
    tab.title = `Spell bar ${i + 1}`;
    tab.addEventListener("click", () => {
      setActiveSpellBar(i);
      // Re-highlight; renderRows fires from the spellbar-changed event.
      for (const t of tabButtons) {
        t.classList.toggle("active", Number(t.dataset.tabIndex) === i);
      }
    });
    // Phase I.2 — also accept dropped spells onto a tab to populate it.
    tab.addEventListener("dragover", (ev) => {
      if (ev.dataTransfer.types.includes("application/x-hb-spell-id")) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "copy";
        tab.style.background = "rgba(160, 110, 255, 0.5)";
      }
    });
    tab.addEventListener("dragleave", () => {
      tab.style.background = "";
    });
    tab.addEventListener("drop", (ev) => {
      ev.preventDefault();
      tab.style.background = "";
      const draggedId = parseInt(ev.dataTransfer.getData("application/x-hb-spell-id"), 10);
      if (!Number.isFinite(draggedId) || draggedId <= 0) return;
      // Drop onto an inactive tab: switch to it, add to first empty slot.
      const targetTab = Number(tab.dataset.tabIndex);
      setActiveSpellBar(targetTab);
      const slots = getSpellBarSlots(targetTab);
      const empty = slots.findIndex((v) => v === 0);
      setSpellBarSlot(empty === -1 ? slots.length - 1 : empty, draggedId, targetTab);
      for (const t of tabButtons) {
        t.classList.toggle("active", Number(t.dataset.tabIndex) === targetTab);
      }
    });
    tabButtons.push(tab);
    tabsEl.appendChild(tab);
  }
  function refreshTabActive() {
    const active = getActiveSpellBar();
    for (const t of tabButtons) {
      t.classList.toggle("active", Number(t.dataset.tabIndex) === active);
    }
  }
  refreshTabActive();
  bodyEl.appendChild(tabsEl);

  const list = document.createElement("div");
  list.className = "hb-cb-spells";
  bodyEl.appendChild(list);

  let catalog = null;
  const rows = new Map();

  function setArmed(spellId) {
    state.armedSpellId = spellId;
    saveState(state);
    syncWindowState(state);
    for (const [id, row] of rows) {
      row.classList.toggle("armed", id === spellId && spellId !== 0);
    }
  }

  function renderRows() {
    list.innerHTML = "";
    rows.clear();
    // Caster wielded? Recomputed every render so equip/unequip transitions
    // refresh the tooltip suffix. EquipMask Held|TwoHanded = 0x03000000.
    let casterWielded = false;
    try {
      const handle = window.__sessionHandle ?? null;
      const inv = typeof handle?.playerInventory === "function" ? handle.playerInventory() : [];
      casterWielded = Array.isArray(inv) && inv.some((it) => ((it.equipMask >>> 0) & 0x03000000) !== 0);
    } catch (_) {}
    // Mana Conversion trained/specialized? Drives the tooltip's cost
    // note: ACE only rolls the cost reduction when the skill is at
    // least Trained (Creature_Magic.cs CalculateManaUsage — untrained
    // or SpellFlags.IgnoresManaConversion → flat BaseMana). skills[]
    // is the flat [id, current, base, trained_state, xp] × N layout
    // (see plugins/character-info.js); ManaConversion = 16,
    // SkillAdvancementClass Trained = 2.
    let manaConvTrained = false;
    try {
      const skills = window.__sessionHandle?.playerStats?.()?.skills;
      if (skills && skills.length) {
        for (let s = 0; s + 4 < skills.length; s += 5) {
          if (skills[s] === 16) {
            manaConvTrained = skills[s + 3] >= 2;
            break;
          }
        }
      }
    } catch (_) {}

    const slots = getSpellBarSlots();
    const populated = slots.filter((v) => v > 0);

    if (populated.length === 0) {
      const empty = document.createElement("div");
      empty.className = "hb-cb-hint";
      empty.style.padding = "10px 4px";
      empty.style.color = "rgba(255, 255, 255, 0.55)";
      empty.textContent =
        "No spells on the magic combat bar. Open the 📖 Spellbook and double-click known spells to add them here.";
      list.appendChild(empty);
      return;
    }

    for (let i = 0; i < slots.length; i++) {
      const spellId = slots[i];
      if (spellId === 0) {
        // Phase H.5 — empty slot rendered as drop target so user can
        // drop a dragged spell into a specific position. The slot
        // appears as a thin dashed placeholder.
        const placeholder = document.createElement("div");
        placeholder.className = "hb-cb-spell hb-cb-spell-empty";
        placeholder.dataset.slotIndex = String(i);
        placeholder.style.borderStyle = "dashed";
        placeholder.style.opacity = "0.4";
        placeholder.style.cursor = "default";
        const action = document.createElement("span");
        action.className = "hb-cb-spell-action";
        action.textContent = `${i + 1}`;
        placeholder.appendChild(action);
        const empty = document.createElement("span");
        empty.className = "hb-cb-spell-name";
        empty.textContent = "(empty — drop a spell here)";
        empty.style.color = "rgba(255, 255, 255, 0.4)";
        empty.style.fontStyle = "italic";
        placeholder.appendChild(empty);
        placeholder.addEventListener("dragover", (ev) => {
          if (ev.dataTransfer.types.includes("application/x-hb-spell-id")) {
            ev.preventDefault();
            ev.dataTransfer.dropEffect = "copy";
            placeholder.style.opacity = "1";
            placeholder.style.borderColor = "rgba(160, 110, 255, 0.7)";
          }
        });
        placeholder.addEventListener("dragleave", () => {
          placeholder.style.opacity = "0.4";
          placeholder.style.borderColor = "";
        });
        placeholder.addEventListener("drop", (ev) => {
          ev.preventDefault();
          const draggedId = parseInt(ev.dataTransfer.getData("application/x-hb-spell-id"), 10);
          if (Number.isFinite(draggedId) && draggedId > 0) {
            setSpellBarSlot(i, draggedId);
          }
        });
        list.appendChild(placeholder);
        continue;
      }
      const meta = catalog ? catalog[String(spellId)] : null;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "hb-cb-spell";
      row.dataset.spellId = String(spellId);
      row.dataset.slotIndex = String(i);
      const isUntargeted = meta?.untargeted ?? true;
      // WS14 (patch B) — surface the firing precondition. A targeted armed
      // spell only fires from Magic stance (picking.js dispatch); flag the
      // mismatch with an amber cue so the player knows it won't cast until they
      // enter Magic mode. The tooltip hint is folded into row.title below
      // (which is re-assigned later, so setting it here would be clobbered).
      let rowWrongStance = false;
      if (state.armedSpellId === spellId && !isUntargeted) {
        row.classList.add("armed");
        let stanceLow = 0;
        try { stanceLow = window.__getCurrentStanceLow?.() | 0; } catch (_) {}
        rowWrongStance = wrongStanceForArmed(state.armedSpellId, isUntargeted, stanceLow);
        if (rowWrongStance) row.classList.add("wrong-stance");
      }
      // Phase H.5 — accept dragged spells from the Spellbook plugin.
      row.addEventListener("dragover", (ev) => {
        if (ev.dataTransfer.types.includes("application/x-hb-spell-id")) {
          ev.preventDefault();
          ev.dataTransfer.dropEffect = "copy";
        }
      });
      row.addEventListener("drop", (ev) => {
        ev.preventDefault();
        const draggedId = parseInt(ev.dataTransfer.getData("application/x-hb-spell-id"), 10);
        if (Number.isFinite(draggedId) && draggedId > 0) {
          setSpellBarSlot(i, draggedId);
        }
      });

      const action = document.createElement("span");
      action.className = "hb-cb-spell-action";
      action.textContent = isUntargeted ? "Cast" : "Arm";
      row.appendChild(action);

      // Wave 6 / Phase 17 — spell-shape badge. classifySpell returns
      // `null` until the shape-table JSON is loaded (lazy fetch kicked
      // by the first call); the schedulePickerReload() poll below
      // re-renders the picker as soon as the table is in. Until then
      // the badge slot is an empty fixed-width column so the layout
      // doesn't jitter when shapes arrive.
      const shape = document.createElement("span");
      shape.className = "hb-cb-spell-shape";
      const classification = classifySpell(spellId);
      if (classification && classification.shape) {
        const letter = SPELL_SHAPE_BADGE[classification.shape] ?? "";
        shape.textContent = letter;
        shape.dataset.shape = classification.shape;
      } else {
        shape.textContent = "";
      }
      row.appendChild(shape);

      const name = document.createElement("span");
      name.className = "hb-cb-spell-name";
      const baseName = meta?.name ?? `Spell 0x${spellId.toString(16)}`;
      name.textContent = baseName;
      row.appendChild(name);

      const tag = document.createElement("span");
      tag.className = "hb-cb-spell-tag";
      tag.textContent = isUntargeted ? "self" : (meta?.school ? schoolName(meta.school) : "target");
      row.appendChild(tag);

      // Tooltip mirrors the badge so screen-readers + hover both
      // surface the projectile pattern. `(Bolt)` etc. appended only
      // when we have a classification; unclassified spells get just
      // the name as before. When no caster is wielded and the spell
      // isn't Item Enchantment (school 3, which casts via components),
      // suffix a hint — informational only; the row still casts.
      //
      // Mana suffix (Task C step 3, 2026-07-01): base cost from the
      // hybrid catalog (DAT-correct `baseMana` post-EnteredWorld). The
      // actual charge is server-rolled — with Mana Conversion trained,
      // ACE reduces the cost stochastically per cast
      // (Creature_Magic.cs GetManaCost) — so the note says "may be
      // reduced" rather than faking a number.
      const needsCasterHint = !casterWielded && (meta?.school !== 3);
      const casterSuffix = needsCasterHint ? " — no caster wielded" : "";
      let manaSuffix = "";
      if (Number.isFinite(+meta?.mana) && +meta.mana > 0) {
        const mcNote =
          manaConvTrained && !(meta?.flags?.ignoresManaConv === true)
            ? " (Mana Conversion may reduce)"
            : "";
        manaSuffix = ` — ${+meta.mana} mana${mcNote}`;
      }
      // WS14 (patch B, MN1) — append the wrong-stance hint into the tooltip
      // HERE (not at the .wrong-stance class site above), because row.title is
      // re-assigned on this line and would clobber an earlier set.
      const stanceHint = rowWrongStance ? " — enter Magic mode to cast" : "";
      if (classification && classification.shape) {
        row.title = `${baseName} (${classification.shape})${manaSuffix}${casterSuffix}${stanceHint}`;
      } else {
        row.title = `${baseName}${manaSuffix}${casterSuffix}${stanceHint}`;
      }

      row.addEventListener("click", () => {
        if (isUntargeted) {
          try {
            castSpellViaHandle(spellId, null);
          } catch (e) {
            console.warn(`[combat-bar] cast(${spellId}) failed: ${e?.message ?? e}`);
          }
        } else {
          setArmed(state.armedSpellId === spellId ? 0 : spellId);
        }
      });

      rows.set(spellId, row);
      list.appendChild(row);
    }
  }

  // Initial draw + load catalog → second draw with names.
  // The first renderRows() call also triggers classifySpell()'s lazy
  // fetch of `data/spell-shapes.json`; schedulePickerReload() polls
  // and re-renders once it's in (Wave 6 / Phase 17).
  renderRows();
  loadCatalog().then((c) => {
    catalog = c;
    renderRows();
  });

  // WS14 (patch B, MF4) — expose this panel's renderRows so the module-level
  // strip poll can refresh the open picker's armed/wrong-stance amber cue on a
  // Magic-stance transition (the panel isn't necessarily open in Magic stance,
  // and arming doesn't dispatch hb-spellbar-changed). Cleared on dispose.
  window.__combatBarPanelRerender = renderRows;

  // Wave 6 / Phase 17 — poll for the spell-shape table to land, then
  // re-render once so the badges + tooltip suffixes appear. The first
  // classifySpell() call in renderRows() kicks the async fetch. Poll
  // every 50ms for up to ~3s; on production cold-load the fetch lands
  // in 30-80ms so the user typically sees badges on the next frame.
  let shapePollId = 0;
  if (!isShapeTableLoaded()) {
    shapePollId = setInterval(() => {
      if (isShapeTableLoaded()) {
        clearInterval(shapePollId);
        shapePollId = 0;
        renderRows();
      }
    }, 50);
    // Safety stop after 3s — if the fetch ultimately fails, give up
    // quietly so we don't poll forever. The picker stays usable
    // without badges in that case.
    setTimeout(() => {
      if (shapePollId) {
        clearInterval(shapePollId);
        shapePollId = 0;
      }
    }, 3000);
  }

  // Re-render when the spellbook plugin updates the slots or
  // when the user switches the active tab.
  const onSpellbarChanged = () => {
    refreshTabActive();
    renderRows();
  };
  window.addEventListener("hb-spellbar-changed", onSpellbarChanged);

  // (No teardown needed for the slot listener — bar.js calls our
  // returned dispose; the damage-feed return-fn below adds + manages
  // its own teardown chain.)
  // We store this so the outer activate() can include it in dispose.
  bodyEl.__spellPickerDispose = () => {
    window.removeEventListener("hb-spellbar-changed", onSpellbarChanged);
    // WS14 — drop the panel-rerender hook so the strip poll no-ops when the
    // picker is closed (renderRows would touch a detached `list` otherwise).
    if (window.__combatBarPanelRerender === renderRows) {
      window.__combatBarPanelRerender = null;
    }
    if (shapePollId) {
      clearInterval(shapePollId);
      shapePollId = 0;
    }
  };
}

function schoolName(s) {
  return { 1: "War", 2: "Life", 3: "Item", 4: "Creature", 5: "Void" }[s] ?? "?";
}

export const manifest = {
  id: "combat-bar",
  name: "Combat",
  icon: "⚔",
  // Retail gmCombatUI button sprite (combat-state normal). bar.js prefers
  // iconSprite over the emoji when the PNG resolves; the emoji stays as a
  // load-error fallback.
  iconSprite: "0x06004D1C",
  version: "0.1.0",
  description: "Stance toggle + attack settings + spell picker",
};

// Wave J1.A (2026-05-27) — the previously-exported `mount(ctx)` lifecycle
// fn that handled auto-disarm on zone-change/death has been moved into
// the module-load IIFE above (`installAutoDisarmHooks`). The export was
// orphaned by Polish A's `BAR_SLOT_EXPORT_OVERRIDES["combat-bar"]` in
// index.html (around line 1232-1236) which intentionally skipped combat-
// bar's mount() to preserve pre-refactor behaviour. Now that the hook
// runs at module-load instead, combat-bar no longer needs a mount export.

export function activate(bodyEl, ctx) {
  ensureStyles();
  const state = loadState();
  syncWindowState(state);
  const client = ctx?.client ?? window.__pluginClient ?? null;

  // Stance toggle header (was the separate `stance-toggle` plugin
  // pre-2026-05-17). Shown above whichever stance-specific body
  // renders below.
  renderStanceHeader(bodyEl, client);

  // Phase F — branch on local combat stance. Magic stance (wand / orb
  // / magic staff in hand + combat mode) shows a spell picker;
  // melee / missile / NonCombat show the attack-controls row.
  //
  // F11-4 — render the stance-specific body into a dedicated sub-container
  // and re-render it whenever the combat mode changes, instead of branching
  // exactly once at panel-open. Previously a weapon swap or Peace↔Combat
  // toggle with the panel open left the WRONG body mounted (mages staring
  // at dead attack buttons, melee players at a spell list) plus stale
  // stance-conditional rows (the Accuracy/Power label and the missile-only
  // Fast Missiles tickbox), recoverable only by closing + reopening the
  // panel. The stance header (above) and the damage feed (below) are
  // siblings of this container, so a body swap leaves them untouched.
  const stanceBodyEl = document.createElement("div");
  stanceBodyEl.className = "hb-cb-stance-body";
  bodyEl.appendChild(stanceBodyEl);

  // magic → spell picker; ranged / melee / NonCombat → attack controls.
  // ranged and melee both render renderAttackControls, but that fn reads
  // currentStanceIsRanged() for the Accuracy/Power label + the Fast
  // Missiles row, so a ranged↔melee swap must re-render too.
  function currentStanceBodyMode() {
    if (currentStanceIsMagic()) return "magic";
    if (currentStanceIsRanged()) return "ranged";
    return "melee";
  }
  // Tear down whichever body is currently mounted (each render fn parks its
  // disposer on the element it was handed — now stanceBodyEl, not bodyEl).
  function disposeStanceBody() {
    for (const k of ["__spellPickerDispose", "__powerMeterDispose", "__reckBandDispose", "__autoRepDispose"]) {
      if (typeof stanceBodyEl[k] === "function") {
        try { stanceBodyEl[k](); } catch {}
      }
      stanceBodyEl[k] = undefined;
    }
  }
  let renderedBodyMode = null;
  function renderStanceBody() {
    disposeStanceBody();
    stanceBodyEl.replaceChildren();
    renderedBodyMode = currentStanceBodyMode();
    if (renderedBodyMode === "magic") {
      renderSpellPicker(stanceBodyEl, state);
    } else {
      renderAttackControls(stanceBodyEl, state);
    }
  }
  renderStanceBody();

  // ── Damage feed (shared across all stances) ──────────────────────
  // Live damage feed — subscribes to the facade combat events and
  // prepends the last few lines. Skipped gracefully when the facade
  // isn't available yet (pre-login).
  const feedEl = document.createElement("div");
  feedEl.className = "hb-cb-feed";
  const feedEmpty = document.createElement("div");
  feedEmpty.className = "hb-cb-feed-empty";
  feedEmpty.textContent = client ? "" : "Log in to enable.";
  feedEl.appendChild(feedEmpty);
  bodyEl.appendChild(feedEl);

  // F5 — damage-feed ring buffer. Pre-allocate FEED_LIMIT line nodes
  // on first use; rotate text/class through them and move the recycled
  // slot to the top via a single `insertBefore` (O(1) DOM op) on each
  // event. Sustained 5 hits/s no longer creates+removes a DOM node per
  // event. Visual order preserved: newest at top, oldest at bottom
  // (matches the prior `insertBefore(line, feedEl.firstChild)` path).
  //
  // Closure state (named to avoid colliding with F1's `_powerSyncRafId`
  // and F2's `rafId` / `pendingResume`):
  //   _feedSlots   — recycled <div> nodes, length FEED_LIMIT
  //   _feedRingHead — index of the slot to write next
  //   _feedFilled  — count of slots that have been initialized + inserted
  const FEED_LIMIT = 5;
  const _feedSlots = new Array(FEED_LIMIT);
  let _feedRingHead = 0;
  let _feedFilled = 0;
  function pushLine(text, cls) {
    if (feedEmpty.parentNode) feedEmpty.remove();
    let slot = _feedSlots[_feedRingHead];
    if (!slot) {
      // Lazy init — create this slot's node the first time around the ring.
      slot = document.createElement("div");
      _feedSlots[_feedRingHead] = slot;
    }
    slot.className = `hb-cb-feed-line ${cls}`;
    slot.textContent = text;
    // Move (or first-insert) this slot to the top of the feed. Calling
    // `insertBefore` with a node already in the parent moves it — a
    // single DOM op, not append+remove.
    feedEl.insertBefore(slot, feedEl.firstChild);
    if (_feedFilled < FEED_LIMIT) _feedFilled++;
    _feedRingHead = (_feedRingHead + 1) % FEED_LIMIT;
  }

  const subs = [];
  if (client?.events?.on) {
    const onDealt = (ev) => {
      const d = ev.detail ?? {};
      const crit = d.criticalHit ? " (crit)" : "";
      pushLine(
        `→ ${d.defenderName ?? "?"}  ${d.damage ?? 0} ${d.damageType ?? ""}${crit}`,
        "hb-cb-feed-hit",
      );
    };
    const onTaken = (ev) => {
      const d = ev.detail ?? {};
      const crit = d.criticalHit ? " (crit)" : "";
      pushLine(
        `← ${d.attackerName ?? "?"}  ${d.damage ?? 0} ${d.damageType ?? ""} → ${d.damageLocation ?? ""}${crit}`,
        "hb-cb-feed-taken",
      );
    };
    const onEvadeTarget = (ev) => {
      pushLine(`→ ${ev.detail?.defenderName ?? "?"} evaded`, "hb-cb-feed-miss");
    };
    const onEvadeAttacker = (ev) => {
      pushLine(`← evaded ${ev.detail?.attackerName ?? "?"}`, "hb-cb-feed-miss");
    };
    client.events.on("damageDealt", onDealt);
    client.events.on("damageTaken", onTaken);
    client.events.on("evadedTarget", onEvadeTarget);
    client.events.on("evadedAttacker", onEvadeAttacker);
    subs.push(() => client.events.off("damageDealt", onDealt));
    subs.push(() => client.events.off("damageTaken", onTaken));
    subs.push(() => client.events.off("evadedTarget", onEvadeTarget));
    subs.push(() => client.events.off("evadedAttacker", onEvadeAttacker));

    // F11-4 — re-render the stance body when the combat mode changes
    // (weapon swap / Peace↔Combat toggle). playerStatsUpdated is ACE's
    // signal for stance + equipment changes; we rebuild only when the body
    // mode actually flips, so the common no-op stat update stays cheap.
    const onStanceBodyMaybeChanged = () => {
      if (currentStanceBodyMode() !== renderedBodyMode) renderStanceBody();
    };
    client.events.on("playerStatsUpdated", onStanceBodyMaybeChanged);
    subs.push(() => client.events.off("playerStatsUpdated", onStanceBodyMaybeChanged));
  }

  // Return a teardown so the bar's openPanel can clean up our
  // event subscriptions when the panel closes.
  return () => {
    for (const dispose of subs) {
      try { dispose(); } catch {}
    }
    // F11-4 — the stance body's sub-renders (Phase G spell-picker window
    // listener, Phase H.6 power-meter rAF + subs, Phase 8 Recklessness band
    // sub) now live on the stanceBodyEl sub-container; dispose whichever
    // body is currently mounted.
    disposeStanceBody();
    // Stance-header playerStatsUpdated subscription (on the main bodyEl).
    if (typeof bodyEl.__stanceHeaderDispose === "function") {
      try { bodyEl.__stanceHeaderDispose(); } catch {}
    }
  };
}

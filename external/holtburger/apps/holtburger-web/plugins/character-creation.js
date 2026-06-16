// character-creation.js — Wave D.2 + J4.BC (2026-05-27)
//
// 4-page wizard porting `gmCharGenMainUI` (external/chorizite/
// ACBindings/Generated/Game/CharGen/gmCharGenMainUI.cs:5-220).
//
// Wave D.2 shipped a 3-page collapse of retail's 6-step `ECGProgress`
// (`ECG_HERTAGE→ECG_PROFESSION→ECG_SKILLS→ECG_APPEARANCE→ECG_TOWN→
// ECG_SUMMARY`, cs:36-45). Wave J4.BC splits Profession off Heritage so
// the user can manually spend attribute credits (B.2) while keeping
// Appearance + Town inline on Heritage (B.1 swatch pickers + B.3
// start-area picker):
//
//   Page 1 (heritage)   → ECG_HERTAGE + ECG_APPEARANCE + ECG_TOWN
//                         collapsed: heritage / gender / name / hair
//                         /face/eyes swatch picker (J4.B.1) / start
//                         area dropdown (J4.B.3). Templates still pre-
//                         spread the attribute defaults but the user
//                         picks finer-grained values on the next page.
//   Page 2 (attributes) → ECG_PROFESSION: per-attribute spend UI
//                         (J4.B.2). Slider + +/− buttons for each of
//                         the 6 attributes. Mirrors `gmCGProfessionPage`
//                         (external/chorizite/ACBindings/Generated/UI/
//                         Elements/gmCGProfessionPage.cs:108-130
//                         tagSlider) — six sliders, one per attribute,
//                         pre-populated by the "Class Template" pick,
//                         clamped to `CHARACTER_GEN_MIN_ATTRIBUTE..=
//                         CHARACTER_GEN_MAX_ATTRIBUTE` ([10, 100], per
//                         holtburger-core/src/character_gen.rs:15-16).
//                         Sum MUST exactly equal heritage.attributeCredits
//                         (validator enforces this — character_gen.rs:
//                         337-349, both Exceeded and Incomplete fire).
//   Page 3 (skills)     → ECG_SKILLS: trained / specialized toggle per
//                         skill against the heritage's skill_credits
//                         budget. Pre-populated by template.
//   Page 4 (summary)    → ECG_SUMMARY: read-only review + Submit.
//                         Submit dispatches `0xF656
//                         Character_SendCharGenResult` → ACE's
//                         `Player.HandleCharacterCreate` → S2C `0xF643
//                         CharGenVerificationResponse` (we already handle
//                         both — `crates/holtburger-protocol/src/messages/
//                         character/types.rs:236-433`).
//
// State machine (mirrors `gmCharGenMainUI::SetProgressState`, cs:97):
//   NotStarted → Heritage → Attributes → Skills → Summary → Submitting
//                                                            → Success
//                                                            → Failed
//   Back transitions: Attributes→Heritage, Skills→Attributes,
//                     Summary→Skills.
//   Failed → returns to the Skills page (the most common rejection
//   bucket — server-side name collisions, attribute budget mismatches,
//   etc.); user clicks Back to walk all the way back if needed.
//
// Wire integration:
//   - C2S `sendCharGenResult(payload)` — see `apps/holtburger-web/
//     src/lib.rs` `send_char_gen_result` (Wave D.2 wasm export).
//     Validates client-side via `CharacterGenBuilder::build_request`
//     then dispatches SessionCommand::CreateCharacter.
//   - S2C — recv-loop emits `kind=5 CharacterCreated` on Ok (with new
//     GUID + name) or `kind=6 CharacterCreateFailed` on rejection
//     (with the `CharacterGenerationVerificationResponse` variant
//     name in `string_payload`). Wizard listens on the host's
//     `client.events` bus via `characterCreated` / `characterCreateFailed`
//     event names (wired through the host's `drainEvents` loop in
//     index.html — see Wave D.2 host hook).
//
// State-machine math + payload-builder logic is split into pure
// functions so the unit test (`tests/character_creation.test.cjs`) can
// drive them headless.

import { setAcText } from "../ui/ac_font.js";
import { fetchIconDataUrl as fetchIconDataUrlShared } from "../ui/ac_icon_cache.js";

// J4.B.2 — attribute bounds (mirrors
// holtburger-core/src/character_gen.rs:15-16).
export const CHARACTER_GEN_MIN_ATTRIBUTE = 10;
export const CHARACTER_GEN_MAX_ATTRIBUTE = 100;

// ───────────────────────────────────────────────────────────────────────
// 1. Pure state-machine + helpers (export for tests)
// ───────────────────────────────────────────────────────────────────────

/**
 * Wizard states. Mirror `gmCharGenMainUI::ECGProgress` (cs:36-45)
 * condensed to the 4 user-facing pages + 3 submit states.
 *
 * Retail correspondence:
 *   Heritage       ← ECG_HERTAGE / ECG_APPEARANCE / ECG_TOWN
 *                    (start-area picker + swatches inline with
 *                     heritage select).
 *   Attributes     ← ECG_PROFESSION (Wave J4.B.2 added as a separate
 *                    page so the user can manually spend the
 *                    heritage's attribute_credits budget across the
 *                    six attributes via sliders, mirroring
 *                    gmCGProfessionPage.cs:108 tagSlider).
 *   Skills         ← ECG_SKILLS
 *   Summary        ← ECG_SUMMARY
 *   Submitting     ← `gmCharGenMainUI::DoFinish` await
 *                    (cs:197-203) — no retail enum, distinct in JS.
 *   Success/Failed ← `RecvNotice_CharGenVerificationResponse` branches
 *                    (cs:190-195).
 */
export const WizardState = Object.freeze({
  NotStarted: "not-started",
  Heritage:   "heritage",
  Attributes: "attributes",
  Skills:     "skills",
  Summary:    "summary",
  Submitting: "submitting",
  Success:    "success",
  Failed:     "failed",
});

/**
 * Transition table. Reads as `(from, action) → to`. Action names map
 * to the wizard's button verbs (Next, Back, Submit).
 *
 * Implements `gmCharGenMainUI::SetProgressState` (cs:97) — retail
 * lets the user click any progress button to jump non-linearly; we
 * keep it linear in v1 for simplicity (the Back button covers the
 * common case).
 *
 * Wave J4.B.2 added the Attributes page between Heritage and Skills.
 *
 * @returns {string|null} next state, or null if the transition is illegal.
 */
export function transitionState(from, action) {
  const table = {
    [WizardState.NotStarted]: { open: WizardState.Heritage },
    [WizardState.Heritage]:   { next: WizardState.Attributes, cancel: WizardState.NotStarted },
    [WizardState.Attributes]: { next: WizardState.Skills, back: WizardState.Heritage, cancel: WizardState.NotStarted },
    [WizardState.Skills]:     { next: WizardState.Summary, back: WizardState.Attributes, cancel: WizardState.NotStarted },
    [WizardState.Summary]:    { submit: WizardState.Submitting, back: WizardState.Skills, cancel: WizardState.NotStarted },
    [WizardState.Submitting]: { ok: WizardState.Success, fail: WizardState.Failed },
    [WizardState.Success]:    { close: WizardState.NotStarted },
    [WizardState.Failed]:     { retry: WizardState.Heritage, edit: WizardState.Skills, cancel: WizardState.NotStarted },
  };
  const next = table[from]?.[action];
  return next || null;
}

/**
 * Name validation per ACE's `Player.HandleCharacterCreate` invariants
 * (crates/holtburger-protocol shipped a min/max via the HTML form +
 * `CharacterGenValidationError::EmptyName` at character_gen.rs:597).
 * Retail enforces 1-32 chars; we require 3-32 alphanumeric + space
 * for sanity in the wizard (server is still authoritative — if the
 * server rejects we surface `NameInUse` / `NameBanned`).
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateCharacterName(name) {
  if (!name || typeof name !== "string") return { ok: false, reason: "Name is required." };
  const trimmed = name.trim();
  if (trimmed.length < 3) return { ok: false, reason: "Name must be at least 3 characters." };
  if (trimmed.length > 32) return { ok: false, reason: "Name must be at most 32 characters." };
  if (!/^[a-zA-Z0-9 ']+$/.test(trimmed)) {
    return { ok: false, reason: "Name may only contain letters, numbers, spaces, and apostrophes." };
  }
  return { ok: true };
}

/**
 * Skill-credit math. Mirrors `validate_skills` (crates/holtburger-core/
 * src/character_gen.rs:352-411) exactly:
 *
 *   - Inactive / Untrained skills cost 0.
 *   - Trained skill cost = `trainedCost` (heritage override or base).
 *   - Specialized skill cost = `trainedCost + specializedCost`.
 *
 * `skillStates` is `{ [skillId]: { class: SkillAdvancementClass } }`
 * keyed by the skillId emitted from `client.characters.getCatalog().skills`.
 * `costsForSkill(skillId)` is a callback that returns
 * `{ trainedCost, specializedCost }` — the wizard injects this from
 * `client.characters.skillCostsFor(heritageId, skillId)`.
 *
 * Returns `{ spent, budget, remaining, valid }`.
 */
export function computeSkillBudget(skillStates, costsForSkill, budget) {
  let spent = 0;
  for (const [skillIdStr, info] of Object.entries(skillStates || {})) {
    if (!info || info.class === undefined) continue;
    const skillId = Number(skillIdStr);
    const c = costsForSkill(skillId);
    if (!c) continue;
    // SkillAdvancementClass: Inactive=0, Untrained=1, Trained=2, Specialized=3
    if (info.class === 2 /* Trained */) {
      spent += c.trainedCost;
    } else if (info.class === 3 /* Specialized */) {
      spent += c.trainedCost + c.specializedCost;
    }
  }
  const remaining = budget - spent;
  return { spent, budget, remaining, valid: remaining >= 0 };
}

/**
 * J4.B.2 — Attribute budget math. Mirrors `validate_attributes`
 * (holtburger-core/src/character_gen.rs:313-350):
 *
 *   - Each attribute must be in `[CHARACTER_GEN_MIN_ATTRIBUTE,
 *     CHARACTER_GEN_MAX_ATTRIBUTE]` (`[10, 100]`).
 *   - Sum MUST equal `attributeBudget` (heritage.attributeCredits).
 *     Both Exceeded (sum > budget) and Incomplete (sum < budget) fire
 *     as validation errors server-side.
 *
 * Returns `{ spent, budget, remaining, valid, perAttrValid: bool, error }`.
 * `valid` is true iff every attribute is in range AND remaining === 0.
 */
export function computeAttributeBudget(attributes, attributeBudget) {
  const total =
    (attributes.strength|0) + (attributes.endurance|0) +
    (attributes.coordination|0) + (attributes.quickness|0) +
    (attributes.focus|0) + (attributes.self|0);
  const remaining = attributeBudget - total;
  const allInRange = ["strength","endurance","coordination","quickness","focus","self"].every(
    (k) => (attributes[k]|0) >= CHARACTER_GEN_MIN_ATTRIBUTE
        && (attributes[k]|0) <= CHARACTER_GEN_MAX_ATTRIBUTE
  );
  let error = null;
  if (!allInRange) error = `Each attribute must be ${CHARACTER_GEN_MIN_ATTRIBUTE}-${CHARACTER_GEN_MAX_ATTRIBUTE}.`;
  else if (total > attributeBudget) error = `Attribute total ${total} exceeds budget ${attributeBudget}.`;
  else if (total < attributeBudget) error = `Attribute total ${total} below budget ${attributeBudget} (${remaining} unspent).`;
  return {
    spent: total,
    budget: attributeBudget,
    remaining,
    valid: allInRange && remaining === 0,
    perAttrValid: allInRange,
    error,
  };
}

/**
 * J4.B.2 — Bump one attribute by `delta` (typically ±1 or ±5),
 * clamped to `[CHARACTER_GEN_MIN_ATTRIBUTE, CHARACTER_GEN_MAX_ATTRIBUTE]`
 * AND to the heritage's remaining attribute budget on increment so the
 * user can't go over (mirrors gmCGProfessionPage::SetAttribValue
 * 0x00482C50 which clamps to remaining credits).
 *
 * Returns the new value (caller is responsible for assigning back).
 * Pure: no side effects on `attributes` — call sites do `attributes[k]
 * = applyAttributeDelta(...)`.
 *
 * @param {number} current — current attribute value.
 * @param {number} delta — desired change (positive or negative).
 * @param {number} remaining — heritage.attributeCredits − sum(other 5
 *                              attributes + current). Caller computes
 *                              this with `computeAttributeBudget`.
 */
export function applyAttributeDelta(current, delta, remaining) {
  const desired = (current|0) + (delta|0);
  if (desired < CHARACTER_GEN_MIN_ATTRIBUTE) return CHARACTER_GEN_MIN_ATTRIBUTE;
  if (desired > CHARACTER_GEN_MAX_ATTRIBUTE) return CHARACTER_GEN_MAX_ATTRIBUTE;
  // For increment, also clamp to the remaining budget (excluding the
  // already-spent `current` value — the caller's `remaining` is the
  // global remaining after subtracting all six current attributes).
  if (delta > 0 && remaining < delta) {
    // Allow up to remaining + current → still bounded by MAX above.
    const safeDesired = (current|0) + remaining;
    return safeDesired > CHARACTER_GEN_MAX_ATTRIBUTE ? CHARACTER_GEN_MAX_ATTRIBUTE : safeDesired;
  }
  return desired;
}

/**
 * Build the JS payload `client.characters.createCharacter(...)` expects.
 * Mirrors `CharacterGenBuildJs` shape on the wasm side (apps/holtburger-web/
 * src/lib.rs Wave D.2 block) — camelCase fields, headgear_style sentinel
 * `0xFFFFFFFF` for "none", and `skillAdvancementClasses` is a dense
 * array of `expectedSkillSlots` u32 tags (Inactive=0 fills holes).
 *
 * @param {object} args
 * @param {number} args.heritage
 * @param {number} args.gender
 * @param {number} args.templateOption
 * @param {object} args.attributes — {strength, endurance, coordination, quickness, focus, self}
 * @param {object} args.appearance — see CharacterCreateAppearanceJs shape
 * @param {object} args.skillStates — keyed by skillId, {class: 0..=3}
 * @param {string} args.name
 * @param {number} args.startArea
 * @param {number} args.expectedSkillSlots — from `catalog.expectedSkillSlots`
 * @returns {object} CharacterGenBuildJs
 */
export function buildCharGenPayload(args) {
  const {
    heritage, gender, templateOption, attributes, appearance,
    skillStates, name, startArea, expectedSkillSlots,
  } = args;

  // Dense skill array: zeroed (Inactive) by default, populated from
  // skillStates. Length MUST equal expectedSkillSlots (validator at
  // character_gen.rs:358 errors otherwise).
  const skillAdvancementClasses = new Array(expectedSkillSlots).fill(0);
  for (const [skillIdStr, info] of Object.entries(skillStates || {})) {
    const skillId = Number(skillIdStr);
    if (skillId < expectedSkillSlots && info && typeof info.class === "number") {
      skillAdvancementClasses[skillId] = info.class;
    }
  }

  return {
    heritage,
    gender,
    templateOption,
    strengthAbility:     attributes.strength,
    enduranceAbility:    attributes.endurance,
    coordinationAbility: attributes.coordination,
    quicknessAbility:    attributes.quickness,
    focusAbility:        attributes.focus,
    selfAbility:         attributes.self,
    skillAdvancementClasses,
    name: (name || "").trim(),
    startArea,
    appearance,
    // Omit characterSlot so the wasm auto-assigns (mirrors
    // create_test_character; documented as the supported path).
  };
}

/**
 * Pre-populate skill state from a `CharacterGenTemplate`. Template
 * primary_skills→Specialized (3), normal_skills→Trained (2),
 * everything else→Inactive (0). Mirrors
 * `minimum_skill_advancement_for_template` (holtburger-core/src/
 * character_gen.rs:59-73).
 *
 * @param {object} template — { primarySkills: number[], normalSkills: number[] }
 * @returns {object} { [skillId]: { class: 0..=3 } }
 */
export function seedSkillStatesFromTemplate(template) {
  const out = {};
  for (const skillId of template?.primarySkills || []) {
    out[skillId] = { class: 3 /* Specialized */ };
  }
  for (const skillId of template?.normalSkills || []) {
    out[skillId] = { class: 2 /* Trained */ };
  }
  return out;
}

/**
 * Picks the "default" template per heritage. Retail prefers a fully-
 * spread (sum == attribute_credits) preset like "Adventurer" or
 * "Soldier" so the player has a working build without manual point
 * allocation. We mirror `build_test_character_request` (apps/
 * holtburger-web/src/lib.rs:22189-22205) but expose the choice so the
 * UI can highlight it.
 */
export function pickDefaultTemplate(heritage) {
  if (!heritage?.templates?.length) return null;
  const fullSpread = heritage.templates.find((t) => {
    const total = t.strength + t.endurance + t.coordination + t.quickness + t.focus + t["self"];
    return total === heritage.attributeCredits;
  });
  return fullSpread || heritage.templates[0];
}

/**
 * Picks the default start area for a heritage. Prefers the heritage's
 * first primary start area (typically Holtburg for Aluvian, Shoushi
 * for Sho, Yaraq for Gharu'ndim). Falls back to the first secondary
 * if no primary. Returns null if neither is set.
 */
export function pickDefaultStartArea(heritage) {
  const primary = heritage?.primaryStartAreaIds?.[0];
  if (typeof primary === "number" && primary >= 0) return primary;
  const secondary = heritage?.secondaryStartAreaIds?.[0];
  if (typeof secondary === "number" && secondary >= 0) return secondary;
  return null;
}

// ───────────────────────────────────────────────────────────────────────
// 2. Plugin manifest + view exports
// ───────────────────────────────────────────────────────────────────────

export const manifest = {
  id: "character-creation",
  name: "Character Creation",
  icon: "🧙",
  iconHidden: true,
  version: "0.1.0",
  description: "4-page wizard ported from gmCharGenMainUI (J4.BC).",
};

// The wizard is not mounted into a slot via Bar — it overlays the whole
// viewport when the user clicks "New Character" on the char-list screen.
// `view.openWizard()` is the host entry point; the host wires it up in
// index.html.
export const view = {
  name: "Character Creation",
  nameFor: () => "Character Creation",
  openWizard,
  closeWizard,
  // No `mount(parentEl, ctx)` — this plugin isn't a panel.
};

// ───────────────────────────────────────────────────────────────────────
// 3. CSS — namespaced .hb-cc-* so we don't collide with combat-bar etc.
// ───────────────────────────────────────────────────────────────────────

let _stylesInjected = false;
function ensureStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const style = document.createElement("style");
  style.dataset.plugin = "character-creation";
  style.textContent = `
    .hb-cc-overlay {
      position: fixed; inset: 0; z-index: 9000;
      background: rgba(8, 6, 4, 0.85);
      display: flex; align-items: center; justify-content: center;
      font-family: var(--hb-font, "Trebuchet MS", sans-serif);
      color: #e8d8a8;
    }
    .hb-cc-panel {
      width: min(720px, 92vw);
      max-height: 92vh;
      background: #1a1410;
      border: 2px solid #806838;
      border-radius: 4px;
      box-shadow: 0 6px 32px rgba(0,0,0,0.7);
      display: flex; flex-direction: column;
      overflow: hidden;
    }
    .hb-cc-header {
      padding: 14px 18px;
      background: linear-gradient(180deg, #2c2018 0%, #1a1410 100%);
      border-bottom: 1px solid #806838;
      display: flex; align-items: center; justify-content: space-between;
    }
    .hb-cc-title { font-size: 18px; font-weight: bold; color: #f0d8a0; }
    .hb-cc-close-btn {
      background: transparent; border: 1px solid #806838; color: #e8d8a8;
      padding: 4px 10px; cursor: pointer; border-radius: 2px;
    }
    .hb-cc-close-btn:hover { background: #3a2c20; }
    .hb-cc-progress {
      display: flex; gap: 0; padding: 8px 14px;
      background: #14100c; border-bottom: 1px solid #4a3c28;
      font-size: 12px;
    }
    .hb-cc-progress-step {
      flex: 1; padding: 6px 8px; text-align: center;
      color: #806838; border-bottom: 2px solid transparent;
      transition: color 0.15s, border-color 0.15s;
    }
    .hb-cc-progress-step.active {
      color: #f0d8a0; border-bottom-color: #c89858;
    }
    .hb-cc-progress-step.done {
      color: #c0a878;
    }
    .hb-cc-body {
      flex: 1; padding: 16px 20px;
      overflow-y: auto; min-height: 320px;
    }
    .hb-cc-footer {
      padding: 12px 18px;
      background: #14100c;
      border-top: 1px solid #4a3c28;
      display: flex; gap: 10px; justify-content: flex-end;
    }
    .hb-cc-btn {
      background: #2c2018; color: #e8d8a8;
      border: 1px solid #806838; padding: 6px 16px;
      cursor: pointer; border-radius: 2px;
      font-family: inherit; font-size: 13px;
    }
    .hb-cc-btn:hover:not(:disabled) { background: #3a2c20; }
    .hb-cc-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .hb-cc-btn.primary {
      background: #806838; color: #1a1410;
      border-color: #c89858; font-weight: bold;
    }
    .hb-cc-btn.primary:hover:not(:disabled) { background: #c89858; }
    .hb-cc-row { margin-bottom: 12px; display: flex; align-items: center; gap: 10px; }
    .hb-cc-row > label { min-width: 110px; color: #f0d8a0; }
    .hb-cc-row > select, .hb-cc-row > input[type="text"] {
      flex: 1; background: #14100c; color: #e8d8a8;
      border: 1px solid #4a3c28; padding: 5px 8px;
      font-family: inherit; font-size: 13px;
    }
    .hb-cc-section-title {
      color: #c89858; font-weight: bold; margin: 14px 0 6px 0;
      border-bottom: 1px solid #4a3c28; padding-bottom: 3px;
    }
    .hb-cc-hint { color: #a08868; font-size: 11px; margin-top: 4px; }
    .hb-cc-budget {
      padding: 6px 10px; margin-bottom: 10px;
      background: #14100c; border-left: 3px solid #c89858;
      font-size: 12px;
    }
    .hb-cc-budget.exceeded {
      border-left-color: #c84848; color: #e89890;
    }
    .hb-cc-skill-table {
      width: 100%; border-collapse: collapse; font-size: 12px;
    }
    .hb-cc-skill-table th, .hb-cc-skill-table td {
      padding: 4px 6px; border-bottom: 1px solid #2c2018;
      text-align: left;
    }
    .hb-cc-skill-table th { color: #c89858; }
    .hb-cc-skill-table td.cost { text-align: right; color: #a08868; }
    .hb-cc-skill-table select {
      background: #14100c; color: #e8d8a8;
      border: 1px solid #4a3c28; padding: 2px 4px;
      font-family: inherit; font-size: 11px;
    }
    .hb-cc-error {
      padding: 10px; margin-bottom: 12px;
      background: rgba(200, 72, 72, 0.15);
      border-left: 3px solid #c84848;
      color: #e89890;
    }
    .hb-cc-summary-row {
      display: flex; justify-content: space-between;
      padding: 4px 0; border-bottom: 1px dotted #2c2018;
    }
    .hb-cc-summary-row > .key { color: #a08868; }
    .hb-cc-summary-row > .value { color: #f0d8a0; font-weight: bold; }
    .hb-cc-spinner { font-size: 14px; color: #c89858; text-align: center; padding: 40px; }
    /* J4.B.1 — appearance swatch pickers */
    .hb-cc-swatch-row {
      display: flex; gap: 6px; padding: 4px 0;
      overflow-x: auto; align-items: center; min-height: 44px;
    }
    .hb-cc-swatch-row > .label {
      min-width: 70px; color: #c89858; font-size: 12px;
      flex-shrink: 0;
    }
    .hb-cc-swatch {
      width: 38px; height: 38px;
      border: 1px solid #4a3c28;
      background: #14100c; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; color: #806838; flex-shrink: 0;
      position: relative;
      overflow: hidden;
    }
    .hb-cc-swatch:hover { border-color: #c89858; }
    .hb-cc-swatch.selected { border: 2px solid #f0d8a0; box-shadow: inset 0 0 0 1px #1a1410; }
    .hb-cc-swatch > img { width: 100%; height: 100%; object-fit: contain; image-rendering: pixelated; }
    .hb-cc-swatch.none {
      color: #806838; font-style: italic;
      background: repeating-linear-gradient(45deg, #14100c, #14100c 4px, #1a1410 4px, #1a1410 8px);
    }
    /* J4.B.2 — attribute spending sliders */
    .hb-cc-attr-row {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 4px; border-bottom: 1px dotted #2c2018;
    }
    .hb-cc-attr-row > .name {
      width: 105px; color: #f0d8a0; font-size: 13px;
    }
    .hb-cc-attr-row > .value {
      width: 36px; text-align: center; color: #f0d8a0;
      font-weight: bold; font-size: 14px;
      background: #14100c; border: 1px solid #4a3c28;
      padding: 2px 0;
    }
    .hb-cc-attr-row input[type="range"] {
      flex: 1; accent-color: #c89858;
    }
    .hb-cc-attr-row > .step-btn {
      width: 28px; height: 24px;
      background: #2c2018; color: #e8d8a8;
      border: 1px solid #806838; cursor: pointer;
      font-family: inherit; font-size: 12px;
    }
    .hb-cc-attr-row > .step-btn:hover:not(:disabled) { background: #3a2c20; }
    .hb-cc-attr-row > .step-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  `;
  document.head.appendChild(style);
}

// ───────────────────────────────────────────────────────────────────────
// 4. Wizard runtime — state, render, event wiring
// ───────────────────────────────────────────────────────────────────────

// Module-scope singleton (wizard is fullscreen overlay — only one
// instance ever active).
let _wizard = null;

/**
 * Opens the wizard.
 *
 * @param {object} ctx
 * @param {object} ctx.client — `window.__pluginClient` (api.js createClient)
 * @param {Function} [ctx.onSuccess] — fires on kind=5 CharacterCreated;
 *                                    receives `{ guid, name }`.
 * @param {Function} [ctx.onCancel]  — fires on close button or X.
 */
export function openWizard(ctx) {
  if (_wizard) {
    // Already open — bring to front (no-op since fixed-position overlay).
    return _wizard;
  }
  ensureStyles();

  const client = ctx?.client ?? window.__pluginClient ?? null;
  if (!client) {
    console.warn("[character-creation] no client available; cannot open wizard");
    return null;
  }

  const catalog = client.characters?.getCatalog?.();
  if (!catalog || !catalog.heritages?.length) {
    console.warn("[character-creation] catalog not loaded; cannot open wizard");
    return null;
  }

  _wizard = createWizardInstance(client, catalog, ctx);
  _wizard.transition("open");
  return _wizard;
}

/**
 * Closes the wizard if open. Idempotent.
 */
export function closeWizard() {
  if (_wizard) {
    _wizard.destroy();
    _wizard = null;
  }
}

function createWizardInstance(client, catalog, ctx) {
  // ── Mutable wizard state. ──
  const state = {
    wizard: WizardState.NotStarted,
    // Page 1
    heritageId: null,
    genderId: null,
    templateOption: null,
    name: "",
    // Page 2 — skill plan (keyed by skillId)
    skillStates: {},
    // Page 1.5 — attribute spread (template-driven; UI exposed as
    // read-only in v1 — user uses pre-spread templates).
    attributes: { strength: 10, endurance: 10, coordination: 10, quickness: 10, focus: 10, self: 10 },
    // Page 1 — appearance (randomized initially; user can re-roll OR
    // pick individual swatches via the J4.B.1 picker UI).
    appearance: null,
    // Page 1 — per-gender icon strips cached from
    // `getCharacterGenAppearanceStrips`; null until first render of the
    // Heritage page, invalidated on heritage/gender change.
    appearanceStrips: null,
    startArea: null,
    // Error state after Failed.
    errorMessage: null,
  };

  // ── DOM ──
  const overlay = document.createElement("div");
  overlay.className = "hb-cc-overlay";
  overlay.dataset.plugin = "character-creation";

  const panel = document.createElement("div");
  panel.className = "hb-cc-panel";
  overlay.appendChild(panel);

  const header = document.createElement("div");
  header.className = "hb-cc-header";
  const title = document.createElement("div");
  title.className = "hb-cc-title";
  setAcText(title, "Create Character", { color: "#f0d8a0" });
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "hb-cc-close-btn";
  setAcText(closeBtn, "× Close");
  closeBtn.addEventListener("click", () => transition("cancel"));
  header.appendChild(title);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const progress = document.createElement("div");
  progress.className = "hb-cc-progress";
  for (const [label] of [["Heritage"], ["Attributes"], ["Skills"], ["Summary"]]) {
    const step = document.createElement("div");
    step.className = "hb-cc-progress-step";
    setAcText(step, label);
    progress.appendChild(step);
  }
  panel.appendChild(progress);

  const body = document.createElement("div");
  body.className = "hb-cc-body";
  panel.appendChild(body);

  const footer = document.createElement("div");
  footer.className = "hb-cc-footer";
  panel.appendChild(footer);

  document.body.appendChild(overlay);

  // ── Initialise page-1 defaults from the catalog. ──
  const firstHeritage = catalog.heritages[0];
  state.heritageId = firstHeritage.heritageId;
  applyHeritageDefaults(state, firstHeritage);

  // ── Event-bus subscription for outcome (kind=5 / kind=6) ──
  let unsubSuccess = null;
  let unsubFailed = null;
  if (client?.events?.on) {
    const onSuccess = (ev) => {
      if (state.wizard !== WizardState.Submitting) return;
      const detail = ev?.detail || {};
      transition("ok");
      ctx?.onSuccess?.(detail);
    };
    const onFailed = (ev) => {
      if (state.wizard !== WizardState.Submitting) return;
      const detail = ev?.detail || {};
      state.errorMessage = detail?.reason || detail?.code || "Server rejected character creation.";
      transition("fail");
    };
    client.events.on("characterCreated", onSuccess);
    client.events.on("characterCreateFailed", onFailed);
    unsubSuccess = () => client.events.off?.("characterCreated", onSuccess);
    unsubFailed  = () => client.events.off?.("characterCreateFailed", onFailed);
  }

  function transition(action) {
    const next = transitionState(state.wizard, action);
    if (!next) {
      console.warn(`[character-creation] illegal transition ${state.wizard} -- ${action}`);
      return;
    }
    state.wizard = next;
    if (next === WizardState.NotStarted) {
      destroy();
      ctx?.onCancel?.();
      return;
    }
    if (next === WizardState.Submitting) {
      doSubmit();
    }
    render();
  }

  function doSubmit() {
    state.errorMessage = null;
    const heritage = findHeritage(catalog, state.heritageId);
    if (!heritage) {
      state.errorMessage = "Unknown heritage; cannot submit.";
      transition("fail");
      return;
    }
    const payload = buildCharGenPayload({
      heritage: state.heritageId,
      gender: state.genderId,
      templateOption: state.templateOption,
      attributes: state.attributes,
      appearance: state.appearance,
      skillStates: state.skillStates,
      name: state.name,
      startArea: state.startArea,
      expectedSkillSlots: catalog.expectedSkillSlots,
    });
    try {
      client.characters.createCharacter(payload);
    } catch (err) {
      // Local validation failure (CharacterGenBuilder errors).
      state.errorMessage = String(err?.message ?? err);
      transition("fail");
    }
  }

  function render() {
    // Progress bar — highlight current.
    const steps = progress.querySelectorAll(".hb-cc-progress-step");
    const order = [
      WizardState.Heritage,
      WizardState.Attributes,
      WizardState.Skills,
      WizardState.Summary,
    ];
    const idx = order.indexOf(state.wizard);
    steps.forEach((s, i) => {
      s.classList.toggle("active", i === idx);
      s.classList.toggle("done", idx >= 0 && i < idx);
    });

    body.innerHTML = "";
    footer.innerHTML = "";

    switch (state.wizard) {
      case WizardState.Heritage:    renderHeritagePage(); break;
      case WizardState.Attributes:  renderAttributesPage(); break;
      case WizardState.Skills:      renderSkillsPage(); break;
      case WizardState.Summary:     renderSummaryPage(); break;
      case WizardState.Submitting:  renderSubmitting(); break;
      case WizardState.Success:     renderSuccess(); break;
      case WizardState.Failed:      renderFailed(); break;
    }
  }

  // ── Page 1: heritage / gender / name / appearance swatches / start area. ──
  // Wave J4.B.1 (swatch pickers) + J4.B.3 (start-area dropdown). The
  // template select moved here from a dedicated profession page; the
  // *attributes* themselves live on the J4.B.2 Attributes page below.
  function renderHeritagePage() {
    const sectionTitle = (label) => {
      const t = document.createElement("div");
      t.className = "hb-cc-section-title";
      setAcText(t, label);
      return t;
    };

    body.appendChild(sectionTitle("Heritage"));

    // Heritage select.
    const heritageRow = document.createElement("div");
    heritageRow.className = "hb-cc-row";
    const heritageLabel = document.createElement("label");
    setAcText(heritageLabel, "Heritage:");
    const heritageSel = document.createElement("select");
    for (const h of catalog.heritages) {
      const opt = document.createElement("option");
      opt.value = String(h.heritageId);
      opt.textContent = h.name;
      if (h.heritageId === state.heritageId) opt.selected = true;
      heritageSel.appendChild(opt);
    }
    heritageSel.addEventListener("change", () => {
      state.heritageId = Number(heritageSel.value);
      const h = findHeritage(catalog, state.heritageId);
      if (h) applyHeritageDefaults(state, h);
      // Heritage change invalidates the cached appearance strips.
      state.appearanceStrips = null;
      render();
    });
    heritageRow.appendChild(heritageLabel);
    heritageRow.appendChild(heritageSel);
    body.appendChild(heritageRow);

    const heritage = findHeritage(catalog, state.heritageId);
    if (!heritage) return;

    // Gender select.
    const genderRow = document.createElement("div");
    genderRow.className = "hb-cc-row";
    const genderLabel = document.createElement("label");
    setAcText(genderLabel, "Gender:");
    const genderSel = document.createElement("select");
    for (const g of heritage.genders) {
      const opt = document.createElement("option");
      opt.value = String(g.genderId);
      opt.textContent = g.name;
      if (g.genderId === state.genderId) opt.selected = true;
      genderSel.appendChild(opt);
    }
    genderSel.addEventListener("change", () => {
      state.genderId = Number(genderSel.value);
      const g = heritage.genders.find((x) => x.genderId === state.genderId);
      if (g) state.appearance = randomizeAppearance(g);
      // Gender change invalidates the cached appearance strips.
      state.appearanceStrips = null;
      render();
    });
    genderRow.appendChild(genderLabel);
    genderRow.appendChild(genderSel);
    body.appendChild(genderRow);

    // Template select (still seeds attributes + skills, but the user
    // can override on the Attributes / Skills pages).
    body.appendChild(sectionTitle("Class Template"));
    const tmplRow = document.createElement("div");
    tmplRow.className = "hb-cc-row";
    const tmplLabel = document.createElement("label");
    setAcText(tmplLabel, "Template:");
    const tmplSel = document.createElement("select");
    for (const t of heritage.templates) {
      const opt = document.createElement("option");
      opt.value = String(t.templateOption);
      opt.textContent = t.name;
      if (t.templateOption === state.templateOption) opt.selected = true;
      tmplSel.appendChild(opt);
    }
    tmplSel.addEventListener("change", () => {
      state.templateOption = Number(tmplSel.value);
      const t = heritage.templates.find((x) => x.templateOption === state.templateOption);
      if (t) {
        state.attributes = {
          strength: t.strength, endurance: t.endurance,
          coordination: t.coordination, quickness: t.quickness,
          focus: t.focus, self: t["self"],
        };
        state.skillStates = seedSkillStatesFromTemplate(t);
      }
      render();
    });
    tmplRow.appendChild(tmplLabel);
    tmplRow.appendChild(tmplSel);
    body.appendChild(tmplRow);

    // J4.B.3 — Start area dropdown (gmCGTownPage.cs:1-185 equivalent
    // collapsed onto Heritage). Heritage exposes `primaryStartAreaIds`
    // + `secondaryStartAreaIds` (Aluvian → Holtburg only; Sho →
    // Shoushi + Hebian-To; etc); we merge them and let the user pick.
    const allowedAreaIds = [
      ...(heritage.primaryStartAreaIds || []),
      ...(heritage.secondaryStartAreaIds || []),
    ].filter((id) => typeof id === "number" && id >= 0);
    if (allowedAreaIds.length > 0) {
      const areaRow = document.createElement("div");
      areaRow.className = "hb-cc-row";
      const areaLabel = document.createElement("label");
      setAcText(areaLabel, "Start area:");
      const areaSel = document.createElement("select");
      for (const areaId of allowedAreaIds) {
        const area = catalog.starterAreas.find((a) => a.startAreaId === areaId);
        if (!area) continue;
        const opt = document.createElement("option");
        opt.value = String(area.startAreaId);
        opt.textContent = area.name;
        if (area.startAreaId === state.startArea) opt.selected = true;
        areaSel.appendChild(opt);
      }
      areaSel.addEventListener("change", () => {
        state.startArea = Number(areaSel.value);
      });
      areaRow.appendChild(areaLabel);
      areaRow.appendChild(areaSel);
      body.appendChild(areaRow);
    }

    // J4.B.1 — Appearance swatch pickers (hair / face-eyes / face-nose
    // / face-mouth / headgear) per gmCGAppearancePage::InitChoices
    // (gmCGAppearancePage.cs:346). One icon strip per feature; click
    // a swatch to assign the index into state.appearance.*Style.
    body.appendChild(sectionTitle("Appearance"));
    renderAppearanceSwatchPickers();

    // "I don't care" shortcut — re-roll all randomized indices in one
    // click (mirrors gmCharGenMainUI::DoRandom @ 0x004E8A00).
    const apprRow = document.createElement("div");
    apprRow.className = "hb-cc-row";
    const apprLabel = document.createElement("label");
    setAcText(apprLabel, "Shortcut:");
    const apprBtn = document.createElement("button");
    apprBtn.type = "button";
    apprBtn.className = "hb-cc-btn";
    setAcText(apprBtn, "Randomize appearance");
    apprBtn.addEventListener("click", () => {
      // HUD rec #126 — retail's MakeRandomizeWarningDialog confirms
      // before overwriting hand-tuned eyes/skin/hair so a stray click
      // doesn't wipe minutes of work. window.confirm fronts the call
      // until the brass modal dialog system is wired everywhere.
      if (typeof window !== "undefined" && typeof window.confirm === "function") {
        if (!window.confirm("Randomize appearance? Your current eye / skin / hair selections will be replaced.")) return;
      }
      const g = heritage.genders.find((x) => x.genderId === state.genderId);
      if (g) state.appearance = randomizeAppearance(g);
      render();
    });
    apprRow.appendChild(apprLabel);
    apprRow.appendChild(apprBtn);
    body.appendChild(apprRow);

    // Name.
    body.appendChild(sectionTitle("Name"));
    const nameRow = document.createElement("div");
    nameRow.className = "hb-cc-row";
    const nameLabel = document.createElement("label");
    setAcText(nameLabel, "Character name:");
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.maxLength = 32;
    nameInput.value = state.name;
    nameInput.placeholder = "e.g. Asheron";
    nameInput.addEventListener("input", () => {
      state.name = nameInput.value;
      // Re-render only the Next button's disabled state.
      const next = footer.querySelector(".hb-cc-btn.primary");
      if (next) {
        const v = validateCharacterName(state.name);
        next.disabled = !v.ok;
      }
    });
    nameRow.appendChild(nameLabel);
    nameRow.appendChild(nameInput);
    body.appendChild(nameRow);

    const nameHint = document.createElement("div");
    nameHint.className = "hb-cc-hint";
    setAcText(nameHint, "3-32 characters; letters, numbers, spaces, apostrophes.");
    body.appendChild(nameHint);

    // ── Footer ──
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "hb-cc-btn";
    setAcText(cancelBtn, "Cancel");
    cancelBtn.addEventListener("click", () => transition("cancel"));
    footer.appendChild(cancelBtn);

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "hb-cc-btn primary";
    setAcText(nextBtn, "Next →");
    nextBtn.disabled = !validateCharacterName(state.name).ok;
    nextBtn.addEventListener("click", () => transition("next"));
    footer.appendChild(nextBtn);
  }

  // J4.B.1 — Render one swatch strip per appearance feature. Fetches
  // per-gender icon DataIDs via `getCharacterGenAppearanceStrips`
  // (apps/holtburger-web/src/lib.rs Wave J4.B export); each strip's
  // swatch resolves its `iconImage` via `fetchIconDataUrl`
  // (ui/ac_icon_cache.js — same path as vendor-ui / inventory icons).
  //
  // Async-friendly: the wasm call is synchronous, but icon thumbnails
  // load asynchronously (each surface is a 32×32 RenderSurface DAT
  // fetch). The DOM is built immediately with empty `<img>` placeholders
  // and populated as fetches complete.
  function renderAppearanceSwatchPickers() {
    // Cache strips per gender so flipping back and forth doesn't re-fetch.
    if (!state.appearanceStrips && client?.characters?.appearanceStrips) {
      try {
        state.appearanceStrips =
          client.characters.appearanceStrips(state.heritageId, state.genderId);
      } catch (e) {
        console.warn("[character-creation] strips fetch failed:", e);
      }
    }
    const strips = state.appearanceStrips;
    if (!strips) {
      const note = document.createElement("div");
      note.className = "hb-cc-hint";
      setAcText(note, "Appearance icons unavailable; use Randomize to pick a random look.");
      body.appendChild(note);
      return;
    }

    // Feature -> [{ index, iconImage, displayLabel? }, state.appearance key]
    const features = [
      { key: "hairStyle", label: "Hair", entries: strips.hairStyles, iconField: "iconImage" },
      { key: "eyes",      label: "Eyes", entries: strips.eyeStrips,  iconField: "iconImage" },
      { key: "nose",      label: "Nose", entries: strips.noseStrips, iconField: "iconImage" },
      { key: "mouth",     label: "Mouth", entries: strips.mouthStrips, iconField: "iconImage" },
    ];
    for (const f of features) {
      if (!Array.isArray(f.entries) || f.entries.length === 0) continue;
      body.appendChild(buildSwatchRow(f, /* allowNone */ false));
    }
    // Headgear — optional ("None" picks the 0xFFFFFFFF sentinel).
    if (Array.isArray(strips.headgearStyles) && strips.headgearStyles.length > 0) {
      body.appendChild(buildSwatchRow({
        key: "headgearStyle", label: "Hat",
        entries: strips.headgearStyles, iconField: null /* Gear has no icon_image */,
      }, /* allowNone */ true));
    }
  }

  // Build a single feature row (label + horizontal swatch strip).
  function buildSwatchRow(feature, allowNone) {
    const row = document.createElement("div");
    row.className = "hb-cc-swatch-row";
    const lbl = document.createElement("div");
    lbl.className = "label";
    setAcText(lbl, feature.label + ":");
    row.appendChild(lbl);

    if (allowNone) {
      // "No headgear" picks the 0xFFFFFFFF sentinel (matches retail).
      const none = document.createElement("button");
      none.type = "button";
      none.className = "hb-cc-swatch none";
      const isSel = (state.appearance?.[feature.key] === 0xFFFFFFFF);
      if (isSel) none.classList.add("selected");
      none.title = "No " + feature.label.toLowerCase();
      setAcText(none, "—");
      none.addEventListener("click", () => {
        if (!state.appearance) return;
        state.appearance[feature.key] = 0xFFFFFFFF;
        if (feature.key === "headgearStyle") {
          state.appearance.headgearColor = 0;
          state.appearance.headgearHue = 0;
        }
        render();
      });
      row.appendChild(none);
    }

    feature.entries.forEach((entry) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hb-cc-swatch";
      const isSel = (state.appearance?.[feature.key] === entry.index);
      if (isSel) btn.classList.add("selected");
      btn.title = `${feature.label} #${entry.index}` + (entry.name ? ` — ${entry.name}` : "");

      if (feature.iconField && entry[feature.iconField]) {
        // Fetch icon asynchronously; placeholder text in the interim.
        setAcText(btn, "·");
        fetchIconDataUrlShared(entry[feature.iconField] >>> 0, "character-creation").then((url) => {
          if (!url || !btn.isConnected) return;
          btn.textContent = "";
          const img = document.createElement("img");
          img.src = url;
          img.alt = entry.name || `${feature.label} #${entry.index}`;
          btn.appendChild(img);
        });
      } else {
        // Gear-only path — fall back to name or index.
        setAcText(btn, String(entry.name ? entry.name.substring(0, 4) : `#${entry.index}`));
      }
      btn.addEventListener("click", () => {
        if (!state.appearance) return;
        state.appearance[feature.key] = entry.index;
        // Defensive: if headgear flipped from "none" sentinel to a real
        // entry, give it a randomized color (caller already had one if
        // the wizard initialised via randomizeAppearance).
        if (feature.key === "headgearStyle" && entry.index !== 0xFFFFFFFF) {
          const g = heritageGenderFor(state);
          const colorCount = g?.appearance?.clothingColorCount || 0;
          if (colorCount > 0) {
            state.appearance.headgearColor = Math.floor(Math.random() * colorCount);
            state.appearance.headgearHue = Math.random();
          }
        }
        render();
      });
      row.appendChild(btn);
    });
    return row;
  }

  // ── Page 2: attribute spending (J4.B.2). ──
  function renderAttributesPage() {
    const heritage = findHeritage(catalog, state.heritageId);
    if (!heritage) return;

    const budget = computeAttributeBudget(state.attributes, heritage.attributeCredits);

    const banner = document.createElement("div");
    banner.className = `hb-cc-budget${budget.valid ? "" : " exceeded"}`;
    setAcText(banner,
      `Attribute credits: ${budget.spent} spent / ${budget.budget} budget` +
      (budget.valid ? " (fully allocated)"
                     : budget.remaining > 0 ? ` (${budget.remaining} unspent)`
                                            : ` (over by ${-budget.remaining})`));
    body.appendChild(banner);

    const hint = document.createElement("div");
    hint.className = "hb-cc-hint";
    setAcText(hint,
      `Each attribute is ${CHARACTER_GEN_MIN_ATTRIBUTE}-${CHARACTER_GEN_MAX_ATTRIBUTE}; ` +
      `total must equal ${heritage.attributeCredits} to advance.`);
    body.appendChild(hint);

    const attrs = [
      ["strength",     "Strength"],
      ["endurance",    "Endurance"],
      ["coordination", "Coordination"],
      ["quickness",    "Quickness"],
      ["focus",        "Focus"],
      ["self",         "Self"],
    ];
    for (const [key, label] of attrs) {
      const row = document.createElement("div");
      row.className = "hb-cc-attr-row";

      const nameEl = document.createElement("div");
      nameEl.className = "name";
      setAcText(nameEl, label);
      row.appendChild(nameEl);

      // Compute remaining FOR THIS attribute (the budget minus all
      // other five). The user can push this attribute up to either
      // CHARACTER_GEN_MAX_ATTRIBUTE or `current + remainingGlobal`,
      // whichever's smaller.
      const others = attrs
        .filter(([k]) => k !== key)
        .reduce((sum, [k]) => sum + (state.attributes[k]|0), 0);
      const remainingGlobalIncl = heritage.attributeCredits - others - (state.attributes[key]|0);

      const dec = document.createElement("button");
      dec.type = "button";
      dec.className = "step-btn";
      setAcText(dec, "−");
      dec.disabled = state.attributes[key] <= CHARACTER_GEN_MIN_ATTRIBUTE;
      dec.addEventListener("click", () => {
        state.attributes[key] = applyAttributeDelta(
          state.attributes[key], -1, remainingGlobalIncl);
        render();
      });
      row.appendChild(dec);

      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = String(CHARACTER_GEN_MIN_ATTRIBUTE);
      slider.max = String(CHARACTER_GEN_MAX_ATTRIBUTE);
      slider.value = String(state.attributes[key]);
      slider.addEventListener("input", () => {
        const desired = Number(slider.value);
        const delta = desired - state.attributes[key];
        state.attributes[key] = applyAttributeDelta(
          state.attributes[key], delta, remainingGlobalIncl);
        slider.value = String(state.attributes[key]);
        // Only update the value cell + banner; full re-render on
        // mouseup-equivalent (change event).
        const val = row.querySelector(".value");
        if (val) val.textContent = String(state.attributes[key]);
      });
      slider.addEventListener("change", () => render());
      row.appendChild(slider);

      const inc = document.createElement("button");
      inc.type = "button";
      inc.className = "step-btn";
      setAcText(inc, "+");
      // `+` disabled when at MAX or budget fully spent
      // (remainingGlobalIncl = budget - others - current ≤ 0 means no
      // room to add more).
      inc.disabled = state.attributes[key] >= CHARACTER_GEN_MAX_ATTRIBUTE
                  || remainingGlobalIncl <= 0;
      inc.addEventListener("click", () => {
        state.attributes[key] = applyAttributeDelta(
          state.attributes[key], 1, remainingGlobalIncl);
        render();
      });
      row.appendChild(inc);

      const val = document.createElement("div");
      val.className = "value";
      setAcText(val, String(state.attributes[key]));
      row.appendChild(val);

      body.appendChild(row);
    }

    // ── Footer ──
    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "hb-cc-btn";
    setAcText(backBtn, "← Back");
    backBtn.addEventListener("click", () => transition("back"));
    footer.appendChild(backBtn);

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "hb-cc-btn";
    setAcText(resetBtn, "Reset to template");
    resetBtn.addEventListener("click", () => {
      const tmpl = heritage.templates.find((x) => x.templateOption === state.templateOption);
      if (tmpl) {
        state.attributes = {
          strength: tmpl.strength, endurance: tmpl.endurance,
          coordination: tmpl.coordination, quickness: tmpl.quickness,
          focus: tmpl.focus, self: tmpl["self"],
        };
      }
      render();
    });
    footer.appendChild(resetBtn);

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "hb-cc-btn primary";
    setAcText(nextBtn, "Next →");
    nextBtn.disabled = !budget.valid;
    nextBtn.title = budget.valid ? "" : (budget.error || "Allocate exactly the budget to advance.");
    nextBtn.addEventListener("click", () => transition("next"));
    footer.appendChild(nextBtn);
  }

  // Resolve the currently-selected gender for state-dependent code paths.
  function heritageGenderFor(s) {
    const h = findHeritage(catalog, s.heritageId);
    return h?.genders?.find((g) => g.genderId === s.genderId) || null;
  }

  // ── Page 2: skills. ──
  function renderSkillsPage() {
    const heritage = findHeritage(catalog, state.heritageId);
    if (!heritage) return;

    // Budget banner — heritage skill_credits with override-aware spend.
    const costsForSkill = (skillId) => {
      try {
        return client.characters.skillCostsFor(state.heritageId, skillId);
      } catch { return null; }
    };
    const budget = computeSkillBudget(state.skillStates, costsForSkill, heritage.skillCredits);

    const banner = document.createElement("div");
    banner.className = `hb-cc-budget${budget.valid ? "" : " exceeded"}`;
    setAcText(banner,
      `Skill credits: ${budget.spent} spent / ${budget.budget} budget` +
      (budget.valid ? ` (${budget.remaining} remaining)` : ` (over by ${-budget.remaining})`));
    body.appendChild(banner);

    // Skill table.
    const table = document.createElement("table");
    table.className = "hb-cc-skill-table";
    table.innerHTML =
      "<thead><tr><th>Skill</th><th>Status</th><th class='cost'>Cost</th></tr></thead>";
    const tbody = document.createElement("tbody");

    for (const skill of catalog.skills) {
      // Hide skills that the chargen UI flagged as non-chargen-usable
      // (mirrors `chargenUse` filter — character_gen.rs:379-384). These
      // can still appear as Inactive but the user shouldn't see them.
      if (!skill.chargenUse) continue;
      const cur = state.skillStates[skill.skillId];
      const tr = document.createElement("tr");
      const tdName = document.createElement("td");
      setAcText(tdName, skill.name || `Skill #${skill.skillId}`);
      const tdStatus = document.createElement("td");
      const sel = document.createElement("select");
      // SkillAdvancementClass options. Untrained=1 is the "available
      // but un-allocated" default for chargen-usable skills.
      for (const [val, label] of [[1, "Untrained"], [2, "Trained"], [3, "Specialized"]]) {
        const opt = document.createElement("option");
        opt.value = String(val);
        opt.textContent = label;
        if (cur?.class === val) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener("change", () => {
        const newClass = Number(sel.value);
        state.skillStates[skill.skillId] = { class: newClass };
        render();
      });
      tdStatus.appendChild(sel);
      const tdCost = document.createElement("td");
      tdCost.className = "cost";
      const c = costsForSkill(skill.skillId);
      const myCost = !c ? "-" :
        cur?.class === 3 ? `${c.trainedCost + c.specializedCost}` :
        cur?.class === 2 ? `${c.trainedCost}` : "0";
      setAcText(tdCost, myCost);
      tr.appendChild(tdName);
      tr.appendChild(tdStatus);
      tr.appendChild(tdCost);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    body.appendChild(table);

    // ── Footer ──
    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "hb-cc-btn";
    setAcText(backBtn, "← Back");
    backBtn.addEventListener("click", () => transition("back"));
    footer.appendChild(backBtn);

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "hb-cc-btn primary";
    setAcText(nextBtn, "Next →");
    nextBtn.disabled = !budget.valid;
    nextBtn.title = budget.valid ? "" : "Skill budget exceeded — adjust skill choices.";
    nextBtn.addEventListener("click", () => transition("next"));
    footer.appendChild(nextBtn);
  }

  // ── Page 3: summary. ──
  function renderSummaryPage() {
    const heritage = findHeritage(catalog, state.heritageId);
    if (!heritage) return;
    const gender = heritage.genders.find((g) => g.genderId === state.genderId);
    const tmpl = heritage.templates.find((t) => t.templateOption === state.templateOption);

    const sumRow = (key, value) => {
      const r = document.createElement("div");
      r.className = "hb-cc-summary-row";
      const k = document.createElement("span");
      k.className = "key";
      setAcText(k, key);
      const v = document.createElement("span");
      v.className = "value";
      setAcText(v, String(value));
      r.appendChild(k); r.appendChild(v);
      return r;
    };

    body.appendChild(sumRow("Name", state.name));
    body.appendChild(sumRow("Heritage", heritage.name));
    body.appendChild(sumRow("Gender", gender?.name || "-"));
    body.appendChild(sumRow("Template", tmpl?.name || "-"));

    const startAreaName =
      catalog.starterAreas.find((a) => a.startAreaId === state.startArea)?.name || "-";
    body.appendChild(sumRow("Start Area", startAreaName));

    const trained = [];
    const specialized = [];
    for (const [sid, info] of Object.entries(state.skillStates)) {
      const skill = catalog.skills.find((s) => s.skillId === Number(sid));
      const label = skill?.name || `Skill #${sid}`;
      if (info?.class === 2) trained.push(label);
      else if (info?.class === 3) specialized.push(label);
    }
    body.appendChild(sumRow("Trained skills",
      trained.length ? trained.join(", ") : "none"));
    body.appendChild(sumRow("Specialized skills",
      specialized.length ? specialized.join(", ") : "none"));

    const sum = state.attributes.strength + state.attributes.endurance +
                state.attributes.coordination + state.attributes.quickness +
                state.attributes.focus + state.attributes.self;
    body.appendChild(sumRow("Attribute spread",
      `STR ${state.attributes.strength} / END ${state.attributes.endurance} / ` +
      `COO ${state.attributes.coordination} / QUI ${state.attributes.quickness} / ` +
      `FOC ${state.attributes.focus} / SLF ${state.attributes.self} (${sum}/${heritage.attributeCredits})`));

    // ── Footer ──
    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "hb-cc-btn";
    setAcText(backBtn, "← Back");
    backBtn.addEventListener("click", () => transition("back"));
    footer.appendChild(backBtn);

    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "hb-cc-btn primary";
    setAcText(submitBtn, "Create");
    submitBtn.addEventListener("click", () => transition("submit"));
    footer.appendChild(submitBtn);
  }

  function renderSubmitting() {
    const sp = document.createElement("div");
    sp.className = "hb-cc-spinner";
    setAcText(sp, "Sending character to server…");
    body.appendChild(sp);
    // No footer buttons — wait for kind=5 / kind=6.
  }

  function renderSuccess() {
    const sp = document.createElement("div");
    sp.className = "hb-cc-spinner";
    setAcText(sp, `Character "${state.name}" created. Returning to character list…`);
    body.appendChild(sp);
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "hb-cc-btn primary";
    setAcText(ok, "Close");
    ok.addEventListener("click", () => transition("close"));
    footer.appendChild(ok);
  }

  function renderFailed() {
    const err = document.createElement("div");
    err.className = "hb-cc-error";
    setAcText(err, state.errorMessage || "Character creation failed. Please check your selections and try again.");
    body.appendChild(err);

    const back = document.createElement("button");
    back.type = "button";
    back.className = "hb-cc-btn";
    setAcText(back, "Back to skills");
    back.addEventListener("click", () => transition("edit"));
    footer.appendChild(back);

    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "hb-cc-btn primary";
    setAcText(retry, "Start over");
    retry.addEventListener("click", () => transition("retry"));
    footer.appendChild(retry);
  }

  function destroy() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    if (unsubSuccess) try { unsubSuccess(); } catch {}
    if (unsubFailed)  try { unsubFailed();  } catch {}
  }

  return { transition, destroy, _state: state /* test hook */ };
}

// ───────────────────────────────────────────────────────────────────────
// 5. Internal helpers
// ───────────────────────────────────────────────────────────────────────

function findHeritage(catalog, heritageId) {
  return catalog?.heritages?.find?.((h) => h.heritageId === heritageId) || null;
}

function applyHeritageDefaults(state, heritage) {
  state.genderId = heritage.genders?.[0]?.genderId ?? null;
  const tmpl = pickDefaultTemplate(heritage);
  state.templateOption = tmpl?.templateOption ?? heritage.templates[0]?.templateOption ?? 0;
  if (tmpl) {
    state.attributes = {
      strength: tmpl.strength, endurance: tmpl.endurance,
      coordination: tmpl.coordination, quickness: tmpl.quickness,
      focus: tmpl.focus, self: tmpl["self"],
    };
    state.skillStates = seedSkillStatesFromTemplate(tmpl);
  }
  state.startArea = pickDefaultStartArea(heritage) ?? 0;
  const g = heritage.genders?.[0];
  if (g) state.appearance = randomizeAppearance(g);
}

// Mirrors `CharacterGenBuilder::randomize_appearance` (holtburger-core/
// src/character_gen.rs:195-242). Required indices clamped to [0, count);
// optional headgear uses `0xFFFFFFFF` sentinel when count==0.
//
// IMPORTANT: keys are camelCase to match the wasm `CharacterCreateAppearanceJs`
// `#[serde(rename_all = "camelCase")]` deserialiser (apps/holtburger-web/
// src/lib.rs Wave D.2 block). The wasm side translates to the
// snake_case `CharacterCreateAppearanceData` wire fields via
// `into_wire()` before packing.
export function randomizeAppearance(gender) {
  const a = gender.appearance;
  const r = (count) => count > 0 ? Math.floor(Math.random() * count) : 0;
  const optR = (count) => count > 0 ? Math.floor(Math.random() * count) : 0xFFFFFFFF;
  const headgearStyle = optR(a.headgearCount);
  return {
    eyes:          r(a.eyeStripCount),
    nose:          r(a.noseStripCount),
    mouth:         r(a.mouthStripCount),
    hairColor:     r(a.hairColorCount),
    eyeColor:      r(a.eyeColorCount),
    hairStyle:     r(a.hairStyleCount),
    headgearStyle,
    headgearColor: headgearStyle === 0xFFFFFFFF ? 0 : r(a.clothingColorCount),
    shirtStyle:    r(a.shirtCount),
    shirtColor:    r(a.clothingColorCount),
    pantsStyle:    r(a.pantsCount),
    pantsColor:    r(a.clothingColorCount),
    footwearStyle: r(a.footwearCount),
    footwearColor: r(a.clothingColorCount),
    skinHue:       Math.random(),
    hairHue:       Math.random(),
    headgearHue:   headgearStyle === 0xFFFFFFFF ? 0 : Math.random(),
    shirtHue:      Math.random(),
    pantsHue:      Math.random(),
    footwearHue:   Math.random(),
  };
}

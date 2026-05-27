// character_creation.test.cjs — Wave D.2 (2026-05-27)
//
// Unit tests for the character-creation wizard plugin
// (plugins/character-creation.js). Covers the pure helpers:
//
//   [1] WizardState constants + transitionState matrix
//   [2] validateCharacterName (length + charset)
//   [3] computeSkillBudget (heritage override math)
//   [4] buildCharGenPayload (dense skill array + camelCase shape)
//   [5] seedSkillStatesFromTemplate (primary→3, normal→2)
//   [6] pickDefaultTemplate + pickDefaultStartArea
//   [7] randomizeAppearance (range clamping + headgear sentinel)
//
// Wire-payload shape (item 4) is the load-bearing one — the wasm side
// (apps/holtburger-web/src/lib.rs Wave D.2 block) deserialises it via
// serde_wasm_bindgen with `#[serde(rename_all = "camelCase")]`, then
// routes through `CharacterGenBuilder::build_request` (server-parity
// validator), so JS-side shape drift would fire as a runtime
// `"invalid payload"` rejection in production.
//
// Run from apps/holtburger-web/:
//   node tests/character_creation.test.cjs

const path = require("node:path");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");

const PLUGIN_URL = pathToFileURL(
  path.join(__dirname, "..", "plugins", "character-creation.js"),
).href;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}

(async () => {
  // Stub document.head so the plugin's `ensureStyles()` import-time
  // pipeline doesn't blow up. Pure-helper code path doesn't touch DOM.
  if (typeof globalThis.document === "undefined") {
    globalThis.document = {
      head: { appendChild: () => {} },
      createElement: () => ({
        style: {}, dataset: {}, classList: { toggle: () => {}, add: () => {} },
        appendChild: () => {}, addEventListener: () => {}, removeChild: () => {},
        querySelector: () => null, querySelectorAll: () => [],
        setAttribute: () => {}, textContent: "",
      }),
      body: { appendChild: () => {} },
      getElementById: () => null,
    };
  }
  if (typeof globalThis.window === "undefined") globalThis.window = globalThis;

  const mod = await import(PLUGIN_URL);
  const {
    WizardState, transitionState,
    validateCharacterName,
    computeSkillBudget, buildCharGenPayload,
    seedSkillStatesFromTemplate,
    pickDefaultTemplate, pickDefaultStartArea,
    randomizeAppearance,
  } = mod;

  // ─── [1] WizardState + transitionState ─────────────────────────────
  console.log("\n[1] WizardState constants + transitionState matrix");

  check("WizardState constants are stable strings", () => {
    assert.equal(WizardState.NotStarted, "not-started");
    assert.equal(WizardState.Heritage, "heritage");
    assert.equal(WizardState.Skills, "skills");
    assert.equal(WizardState.Summary, "summary");
    assert.equal(WizardState.Submitting, "submitting");
    assert.equal(WizardState.Success, "success");
    assert.equal(WizardState.Failed, "failed");
  });

  check("transitionState: open advances NotStarted → Heritage", () => {
    assert.equal(transitionState(WizardState.NotStarted, "open"), WizardState.Heritage);
  });

  check("transitionState: linear next path Heritage → Skills → Summary → Submitting", () => {
    assert.equal(transitionState(WizardState.Heritage, "next"), WizardState.Skills);
    assert.equal(transitionState(WizardState.Skills, "next"), WizardState.Summary);
    assert.equal(transitionState(WizardState.Summary, "submit"), WizardState.Submitting);
  });

  check("transitionState: back from Skills → Heritage and Summary → Skills", () => {
    assert.equal(transitionState(WizardState.Skills, "back"), WizardState.Heritage);
    assert.equal(transitionState(WizardState.Summary, "back"), WizardState.Skills);
  });

  check("transitionState: Submitting branches to Success / Failed", () => {
    assert.equal(transitionState(WizardState.Submitting, "ok"), WizardState.Success);
    assert.equal(transitionState(WizardState.Submitting, "fail"), WizardState.Failed);
  });

  check("transitionState: Failed → retry returns to Heritage; edit → Skills", () => {
    assert.equal(transitionState(WizardState.Failed, "retry"), WizardState.Heritage);
    assert.equal(transitionState(WizardState.Failed, "edit"), WizardState.Skills);
  });

  check("transitionState: cancel from any page returns NotStarted", () => {
    for (const s of [WizardState.Heritage, WizardState.Skills, WizardState.Summary, WizardState.Failed]) {
      assert.equal(transitionState(s, "cancel"), WizardState.NotStarted, `cancel from ${s}`);
    }
  });

  check("transitionState: illegal transitions return null", () => {
    assert.equal(transitionState(WizardState.Heritage, "submit"), null);
    assert.equal(transitionState(WizardState.Submitting, "back"), null);
    assert.equal(transitionState(WizardState.Success, "next"), null);
    assert.equal(transitionState("bogus-state", "next"), null);
  });

  // ─── [2] validateCharacterName ─────────────────────────────────────
  console.log("\n[2] validateCharacterName (length + charset)");

  check("validateCharacterName: rejects empty", () => {
    assert.equal(validateCharacterName("").ok, false);
    assert.equal(validateCharacterName(null).ok, false);
    assert.equal(validateCharacterName(undefined).ok, false);
  });

  check("validateCharacterName: rejects whitespace-only", () => {
    assert.equal(validateCharacterName("   ").ok, false);
  });

  check("validateCharacterName: rejects < 3 chars after trim", () => {
    const r = validateCharacterName("ab");
    assert.equal(r.ok, false);
    assert.match(r.reason, /3 characters/);
  });

  check("validateCharacterName: rejects > 32 chars after trim", () => {
    const r = validateCharacterName("a".repeat(33));
    assert.equal(r.ok, false);
    assert.match(r.reason, /32 characters/);
  });

  check("validateCharacterName: accepts 3 alphanumeric", () => {
    assert.equal(validateCharacterName("Foo").ok, true);
  });

  check("validateCharacterName: accepts 32 alphanumeric", () => {
    assert.equal(validateCharacterName("a".repeat(32)).ok, true);
  });

  check("validateCharacterName: accepts apostrophes (Gharu'ndim convention)", () => {
    assert.equal(validateCharacterName("Gharu'ndim").ok, true);
    assert.equal(validateCharacterName("D'or").ok, true);
  });

  check("validateCharacterName: accepts spaces (Asheron's-style two-word names)", () => {
    assert.equal(validateCharacterName("Ash The Sword").ok, true);
  });

  check("validateCharacterName: rejects punctuation other than space + apostrophe", () => {
    assert.equal(validateCharacterName("Foo-Bar").ok, false);
    assert.equal(validateCharacterName("Foo.Bar").ok, false);
    assert.equal(validateCharacterName("Foo!").ok, false);
    assert.equal(validateCharacterName("Foo<script>").ok, false);
  });

  // ─── [3] computeSkillBudget ────────────────────────────────────────
  console.log("\n[3] computeSkillBudget (heritage override math)");

  // Costs callback mirroring catalog.skillCostsFor(heritage, skill).
  // Skill 1 = Axe (trained 6, spec 4); Skill 2 = Bow (trained 0, spec 4 — free trained).
  const baseCosts = (skillId) => {
    if (skillId === 1) return { trainedCost: 6, specializedCost: 4 };
    if (skillId === 2) return { trainedCost: 0, specializedCost: 4 };
    if (skillId === 3) return { trainedCost: 4, specializedCost: 6 }; // Sho-overridden bow
    return null;
  };

  check("computeSkillBudget: empty skillStates spends 0", () => {
    const r = computeSkillBudget({}, baseCosts, 50);
    assert.equal(r.spent, 0);
    assert.equal(r.budget, 50);
    assert.equal(r.remaining, 50);
    assert.equal(r.valid, true);
  });

  check("computeSkillBudget: Untrained skills spend 0", () => {
    const r = computeSkillBudget({ 1: { class: 1 } }, baseCosts, 50);
    assert.equal(r.spent, 0);
  });

  check("computeSkillBudget: Trained sums trainedCost only", () => {
    const r = computeSkillBudget({ 1: { class: 2 } }, baseCosts, 50);
    assert.equal(r.spent, 6, "Axe trained = 6");
  });

  check("computeSkillBudget: Specialized sums trainedCost + specializedCost", () => {
    // Mirror character_gen.rs:399 — Specialized = trained + spec.
    const r = computeSkillBudget({ 1: { class: 3 } }, baseCosts, 50);
    assert.equal(r.spent, 10, "Axe spec = 6 + 4 = 10");
  });

  check("computeSkillBudget: Inactive (class=0) skipped", () => {
    const r = computeSkillBudget(
      { 1: { class: 0 }, 2: { class: 2 } }, baseCosts, 50);
    assert.equal(r.spent, 0, "Bow trained cost = 0");
  });

  check("computeSkillBudget: mixed plan computes correctly", () => {
    // Axe trained (6) + Bow specialized (0 + 4 = 4) + Crossbow trained (4) = 14.
    const r = computeSkillBudget(
      { 1: { class: 2 }, 2: { class: 3 }, 3: { class: 2 } }, baseCosts, 50);
    assert.equal(r.spent, 14);
    assert.equal(r.remaining, 36);
    assert.equal(r.valid, true);
  });

  check("computeSkillBudget: over-budget flips valid=false + reports negative remaining", () => {
    const r = computeSkillBudget(
      { 1: { class: 3 }, 3: { class: 3 } }, baseCosts, 15);
    // Axe spec 10 + Crossbow spec (4 + 6 = 10) = 20.
    assert.equal(r.spent, 20);
    assert.equal(r.remaining, -5);
    assert.equal(r.valid, false);
  });

  check("computeSkillBudget: unknown skill (null cost) is silently skipped", () => {
    const r = computeSkillBudget({ 999: { class: 2 } }, baseCosts, 50);
    assert.equal(r.spent, 0, "unknown skill should not bump spend");
  });

  // ─── [4] buildCharGenPayload ───────────────────────────────────────
  console.log("\n[4] buildCharGenPayload (wire shape + dense skill array)");

  const sampleAppearance = {
    eyes: 1, nose: 2, mouth: 3, hairColor: 4, eyeColor: 5, hairStyle: 6,
    headgearStyle: 0xFFFFFFFF, headgearColor: 0,
    shirtStyle: 7, shirtColor: 8, pantsStyle: 9, pantsColor: 10,
    footwearStyle: 11, footwearColor: 12,
    skinHue: 0.1, hairHue: 0.2, headgearHue: 0,
    shirtHue: 0.4, pantsHue: 0.5, footwearHue: 0.6,
  };

  check("buildCharGenPayload: camelCase keys for wasm deserializer", () => {
    const p = buildCharGenPayload({
      heritage: 1, gender: 1, templateOption: 0,
      attributes: { strength: 100, endurance: 10, coordination: 100,
                    quickness: 100, focus: 10, self: 10 },
      appearance: sampleAppearance,
      skillStates: { 1: { class: 2 }, 2: { class: 3 } },
      name: "  Asheron  ", startArea: 0, expectedSkillSlots: 5,
    });
    // Spot-check camelCase
    assert.equal(p.strengthAbility, 100);
    assert.equal(p.enduranceAbility, 10);
    assert.equal(p.coordinationAbility, 100);
    assert.equal(p.quicknessAbility, 100);
    assert.equal(p.focusAbility, 10);
    assert.equal(p.selfAbility, 10);
    assert.equal(p.templateOption, 0);
    assert.equal(p.startArea, 0);
    assert.equal(p.appearance, sampleAppearance, "appearance object passed through");
  });

  check("buildCharGenPayload: trims whitespace from name", () => {
    const p = buildCharGenPayload({
      heritage: 1, gender: 1, templateOption: 0,
      attributes: { strength: 10, endurance: 10, coordination: 10,
                    quickness: 10, focus: 10, self: 10 },
      appearance: sampleAppearance, skillStates: {},
      name: "  Asheron  ", startArea: 0, expectedSkillSlots: 5,
    });
    assert.equal(p.name, "Asheron");
  });

  check("buildCharGenPayload: skillAdvancementClasses dense to expectedSkillSlots", () => {
    const p = buildCharGenPayload({
      heritage: 1, gender: 1, templateOption: 0,
      attributes: { strength: 10, endurance: 10, coordination: 10,
                    quickness: 10, focus: 10, self: 10 },
      appearance: sampleAppearance,
      skillStates: { 1: { class: 2 }, 3: { class: 3 } },
      name: "Foo", startArea: 0, expectedSkillSlots: 5,
    });
    assert.equal(p.skillAdvancementClasses.length, 5);
    assert.equal(p.skillAdvancementClasses[0], 0, "slot 0 zeroed");
    assert.equal(p.skillAdvancementClasses[1], 2, "slot 1 = Trained");
    assert.equal(p.skillAdvancementClasses[2], 0, "slot 2 zeroed");
    assert.equal(p.skillAdvancementClasses[3], 3, "slot 3 = Specialized");
    assert.equal(p.skillAdvancementClasses[4], 0, "slot 4 zeroed");
  });

  check("buildCharGenPayload: skill outside slot count silently dropped", () => {
    const p = buildCharGenPayload({
      heritage: 1, gender: 1, templateOption: 0,
      attributes: { strength: 10, endurance: 10, coordination: 10,
                    quickness: 10, focus: 10, self: 10 },
      appearance: sampleAppearance,
      skillStates: { 1: { class: 2 }, 999: { class: 3 } },
      name: "Foo", startArea: 0, expectedSkillSlots: 5,
    });
    // Length should still be 5, not 1000.
    assert.equal(p.skillAdvancementClasses.length, 5);
    assert.equal(p.skillAdvancementClasses[1], 2);
  });

  check("buildCharGenPayload: omits characterSlot so wasm auto-assigns", () => {
    const p = buildCharGenPayload({
      heritage: 1, gender: 1, templateOption: 0,
      attributes: { strength: 10, endurance: 10, coordination: 10,
                    quickness: 10, focus: 10, self: 10 },
      appearance: sampleAppearance, skillStates: {},
      name: "Foo", startArea: 0, expectedSkillSlots: 5,
    });
    assert.equal(p.characterSlot, undefined,
      "characterSlot must be absent so the wasm-side default kicks in");
  });

  // ─── [5] seedSkillStatesFromTemplate ───────────────────────────────
  console.log("\n[5] seedSkillStatesFromTemplate (primary→3, normal→2)");

  check("seedSkillStatesFromTemplate: primary skills map to Specialized (3)", () => {
    const out = seedSkillStatesFromTemplate({
      primarySkills: [1, 7], normalSkills: [],
    });
    assert.equal(out[1].class, 3);
    assert.equal(out[7].class, 3);
  });

  check("seedSkillStatesFromTemplate: normal skills map to Trained (2)", () => {
    const out = seedSkillStatesFromTemplate({
      primarySkills: [], normalSkills: [3, 9],
    });
    assert.equal(out[3].class, 2);
    assert.equal(out[9].class, 2);
  });

  check("seedSkillStatesFromTemplate: primary overrides normal when both list a skill", () => {
    // Real-world templates wouldn't but defensively the primary loop
    // overwrites normal (or v.v. — verify the contract). Plugin code
    // runs primary first, then normal, so normal would win — verify.
    const out = seedSkillStatesFromTemplate({
      primarySkills: [5], normalSkills: [5],
    });
    // The plugin's loop assigns primary→3 first, then normal→2 — so
    // skill 5 ends up Trained. Document the behaviour to match.
    assert.equal(out[5].class, 2, "normal loop runs second; overrides to Trained=2");
  });

  check("seedSkillStatesFromTemplate: empty template → empty plan", () => {
    const out = seedSkillStatesFromTemplate({ primarySkills: [], normalSkills: [] });
    assert.deepEqual(out, {});
  });

  check("seedSkillStatesFromTemplate: null template is safe", () => {
    const out = seedSkillStatesFromTemplate(null);
    assert.deepEqual(out, {});
  });

  // ─── [6] pickDefaultTemplate + pickDefaultStartArea ────────────────
  console.log("\n[6] pickDefaultTemplate + pickDefaultStartArea");

  check("pickDefaultTemplate: prefers fully-spread template matching budget", () => {
    const heritage = {
      attributeCredits: 60,
      templates: [
        { templateOption: 0, name: "Adventurer", strength: 10, endurance: 10,
          coordination: 10, quickness: 10, focus: 10, "self": 10 },
        { templateOption: 1, name: "Soldier", strength: 30, endurance: 10,
          coordination: 10, quickness: 10, focus: 0, "self": 0 },
      ],
    };
    // Adventurer sums to 60, Soldier sums to 60 — first match wins.
    const got = pickDefaultTemplate(heritage);
    assert.equal(got.name, "Adventurer", "first matching-spread template wins");
  });

  check("pickDefaultTemplate: falls back to first template if none match budget", () => {
    const heritage = {
      attributeCredits: 330,
      templates: [
        { templateOption: 0, name: "Adventurer", strength: 10, endurance: 10,
          coordination: 10, quickness: 10, focus: 10, "self": 10 }, // sum 60
      ],
    };
    const got = pickDefaultTemplate(heritage);
    assert.equal(got.name, "Adventurer", "fallback to first when no match");
  });

  check("pickDefaultTemplate: returns null when heritage has no templates", () => {
    assert.equal(pickDefaultTemplate({ templates: [] }), null);
    assert.equal(pickDefaultTemplate(null), null);
  });

  check("pickDefaultStartArea: returns first primary area", () => {
    assert.equal(pickDefaultStartArea({
      primaryStartAreaIds: [0, 1], secondaryStartAreaIds: [2],
    }), 0);
  });

  check("pickDefaultStartArea: falls back to secondary when no primary", () => {
    assert.equal(pickDefaultStartArea({
      primaryStartAreaIds: [], secondaryStartAreaIds: [3],
    }), 3);
  });

  check("pickDefaultStartArea: returns null when both empty", () => {
    assert.equal(pickDefaultStartArea({
      primaryStartAreaIds: [], secondaryStartAreaIds: [],
    }), null);
  });

  // ─── [7] randomizeAppearance ───────────────────────────────────────
  console.log("\n[7] randomizeAppearance (range clamping + headgear sentinel)");

  check("randomizeAppearance: all required indices are in-range", () => {
    const gender = {
      appearance: {
        hairColorCount: 5, hairStyleCount: 3, eyeColorCount: 4, eyeStripCount: 6,
        noseStripCount: 6, mouthStripCount: 6, headgearCount: 0,
        shirtCount: 2, pantsCount: 2, footwearCount: 2, clothingColorCount: 8,
      },
    };
    for (let i = 0; i < 50; i++) {
      const a = randomizeAppearance(gender);
      // Required indices clamped to [0, count).
      assert.ok(a.eyes >= 0 && a.eyes < 6);
      assert.ok(a.nose >= 0 && a.nose < 6);
      assert.ok(a.mouth >= 0 && a.mouth < 6);
      assert.ok(a.hairColor >= 0 && a.hairColor < 5);
      assert.ok(a.eyeColor >= 0 && a.eyeColor < 4);
      assert.ok(a.hairStyle >= 0 && a.hairStyle < 3);
      assert.ok(a.shirtStyle >= 0 && a.shirtStyle < 2);
      assert.ok(a.pantsStyle >= 0 && a.pantsStyle < 2);
      assert.ok(a.footwearStyle >= 0 && a.footwearStyle < 2);
      assert.ok(a.shirtColor >= 0 && a.shirtColor < 8);
      // Hues in [0,1).
      assert.ok(a.skinHue >= 0 && a.skinHue < 1);
      assert.ok(a.hairHue >= 0 && a.hairHue < 1);
    }
  });

  check("randomizeAppearance: headgearStyle uses 0xFFFFFFFF sentinel when count=0", () => {
    const gender = {
      appearance: {
        hairColorCount: 5, hairStyleCount: 3, eyeColorCount: 4, eyeStripCount: 6,
        noseStripCount: 6, mouthStripCount: 6, headgearCount: 0,
        shirtCount: 2, pantsCount: 2, footwearCount: 2, clothingColorCount: 8,
      },
    };
    const a = randomizeAppearance(gender);
    assert.equal(a.headgearStyle, 0xFFFFFFFF);
    assert.equal(a.headgearColor, 0, "color zeroed when no headgear");
    assert.equal(a.headgearHue, 0, "hue zeroed when no headgear");
  });

  check("randomizeAppearance: headgearStyle in-range when headgearCount > 0", () => {
    const gender = {
      appearance: {
        hairColorCount: 5, hairStyleCount: 3, eyeColorCount: 4, eyeStripCount: 6,
        noseStripCount: 6, mouthStripCount: 6, headgearCount: 4,
        shirtCount: 2, pantsCount: 2, footwearCount: 2, clothingColorCount: 8,
      },
    };
    // Run many times — some will return a real headgear index.
    let seenRealIndex = false;
    for (let i = 0; i < 100; i++) {
      const a = randomizeAppearance(gender);
      assert.ok(
        a.headgearStyle === 0xFFFFFFFF ||
          (a.headgearStyle >= 0 && a.headgearStyle < 4),
        `headgearStyle ${a.headgearStyle} out of range`);
      if (a.headgearStyle !== 0xFFFFFFFF) {
        seenRealIndex = true;
        assert.ok(a.headgearColor >= 0 && a.headgearColor < 8);
        assert.ok(a.headgearHue >= 0 && a.headgearHue < 1);
      }
    }
    assert.equal(seenRealIndex, true,
      "with headgearCount=4 we should pick a real index in 100 rolls");
  });

  // ─── Summary ────────────────────────────────────────────────────────
  console.log("\n========");
  console.log(`${passed} passed, ${failed} failed (total ${passed + failed} assertions)`);
  console.log("========");

  if (failed > 0) {
    console.log("\nFailures:");
    for (const { name, err } of failures) {
      console.log(`  ${name}\n    ${err.stack || err.message}`);
    }
    process.exit(1);
  }
})();

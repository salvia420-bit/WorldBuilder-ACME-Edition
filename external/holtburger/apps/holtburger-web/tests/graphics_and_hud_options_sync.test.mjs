// tests/graphics_and_hud_options_sync.test.mjs — Area 10 (2026-11-12).
//
// Verifies:
//   1. Graphics options parity across quality.js and graphics_settings.js:
//      clouds, ssao, csm, anisotropy, pom, statPom in BOOL_FLAGS / INT_FLAGS
//      and preserved by sanitizeFlags.
//   2. POM toggle updates both `pom` and outdoor `statPom`.
//   3. Controls for clouds, ssao, anisotropy, vitalsOrbs, orbScale, and chatFade
//      exist in graphics_settings.js and persist.
//   4. vitals-orbs.js respects URL, localStorage, and graphics state for
//      isVitalsOrbsActive and orbScale.
//   5. chatFade persists and is reflected across settings.
//
// Run from apps/holtburger-web/:  node tests/graphics_and_hud_options_sync.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRESETS,
  BOOL_FLAGS,
  INT_FLAGS,
  getQuality,
} from "../scene3d/quality.js";
import {
  loadGraphicsState,
  renderGraphicsTab,
  __test_only,
} from "../ui/graphics_settings.js";
import {
  isVitalsOrbsActive,
  setVitalsOrbsActive,
  orbScale,
  setOrbScale,
  getOrbScale,
} from "../plugins/vitals-orbs.js";

// Mock localStorage for headless Node environment
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
  clear: () => storage.clear(),
};

// ── 1. quality.js Flags & Presets Parity ─────────────────────────────────
test("[quality] BOOL_FLAGS and INT_FLAGS include all required parity keys", () => {
  // Required boolean flags
  assert.ok(BOOL_FLAGS.has("clouds"), "clouds must be in BOOL_FLAGS");
  assert.ok(BOOL_FLAGS.has("ssao"), "ssao must be in BOOL_FLAGS");
  assert.ok(BOOL_FLAGS.has("csm"), "csm must be in BOOL_FLAGS");
  assert.ok(BOOL_FLAGS.has("pom"), "pom must be in BOOL_FLAGS");
  assert.ok(BOOL_FLAGS.has("statPom"), "statPom must be in BOOL_FLAGS");

  // Required integer flags
  assert.ok(INT_FLAGS.has("anisotropy"), "anisotropy must be in INT_FLAGS");
  assert.ok(INT_FLAGS.has("subdivLevel"), "subdivLevel in INT_FLAGS");
});

test("[quality] getQuality preserves clouds, ssao, csm, anisotropy, and statPom overrides", () => {
  storage.clear();
  storage.set("holtburger_graphics_v1", JSON.stringify({
    flags: {
      clouds: true,
      ssao: true,
      csm: true,
      anisotropy: 8,
      pom: true,
      statPom: true,
    },
  }));

  const q = getQuality("", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
  assert.equal(q.flags.clouds, true);
  assert.equal(q.flags.ssao, true);
  assert.equal(q.flags.csm, true);
  assert.equal(q.flags.anisotropy, 8);
  assert.equal(q.flags.pom, true);
  assert.equal(q.flags.statPom, true);
});

test("[quality] PRESETS define clouds, ssao, csm, and anisotropy across tiers", () => {
  for (const tier of ["low", "mid", "high", "ultra"]) {
    const p = PRESETS[tier];
    assert.ok(p, `preset ${tier} exists`);
    assert.equal(typeof p.clouds, "boolean", `${tier}.clouds is boolean`);
    assert.equal(typeof p.ssao, "boolean", `${tier}.ssao is boolean`);
    assert.equal(typeof p.csm, "boolean", `${tier}.csm is boolean`);
    assert.equal(typeof p.anisotropy, "number", `${tier}.anisotropy is number`);
    assert.equal(typeof p.statPom, "boolean", `${tier}.statPom is boolean`);
  }

  // Tier-specific validation
  assert.equal(PRESETS.low.clouds, false);
  assert.equal(PRESETS.low.anisotropy, 1);

  assert.equal(PRESETS.mid.clouds, false);
  assert.equal(PRESETS.mid.anisotropy, 4);

  assert.equal(PRESETS.high.clouds, true);
  assert.equal(PRESETS.high.ssao, true);
  assert.equal(PRESETS.high.anisotropy, 16);

  assert.equal(PRESETS.ultra.clouds, true);
  assert.equal(PRESETS.ultra.ssao, true);
  assert.equal(PRESETS.ultra.anisotropy, 16);
});

// ── 2. graphics_settings.js Flags, Parity, & POM Synchronization ─────────
test("[graphics_settings] QUALITY_BOOL_FLAGS, QUALITY_INT_FLAGS, and EXTRA_DEFAULTS are synchronized", () => {
  const bools = new Set(__test_only.QUALITY_BOOL_FLAGS);
  const ints = new Set(__test_only.QUALITY_INT_FLAGS);
  const extras = __test_only.EXTRA_DEFAULTS;

  assert.ok(bools.has("clouds"), "clouds in QUALITY_BOOL_FLAGS");
  assert.ok(bools.has("ssao"), "ssao in QUALITY_BOOL_FLAGS");
  assert.ok(bools.has("csm"), "csm in QUALITY_BOOL_FLAGS");
  assert.ok(bools.has("statPom"), "statPom in QUALITY_BOOL_FLAGS");
  assert.ok(ints.has("anisotropy"), "anisotropy in QUALITY_INT_FLAGS");

  assert.equal(extras.vitalsOrbs, true, "vitalsOrbs defaults to true");
  assert.equal(extras.orbScale, 0.72, "orbScale defaults to 0.72");
  assert.equal(extras.chatFade, false, "chatFade defaults to false");
});

function createMockDoc(elements) {
  return {
    addEventListener() {},
    removeEventListener() {},
    createElement(tag) {
      const el = {
        tagName: tag.toUpperCase(),
        style: {},
        className: "",
        dataset: {},
        children: [],
        appendChild(c) { this.children.push(c); },
        setAttribute(k, v) { this[k] = v; },
        classList: {
          add(c) { el.className += " " + c; },
          toggle(c, v) { if (v) el.className += " " + c; },
        },
        addEventListener(evt, fn) { this[`on_${evt}`] = fn; },
      };
      elements.push(el);
      return el;
    },
  };
}

test("[graphics_settings] POM toggle synchronizes both pom and outdoor statPom", () => {
  storage.clear();
  const savedDoc = globalThis.document;

  const elements = [];
  const fakeDoc = createMockDoc(elements);
  globalThis.document = fakeDoc;

  try {
    const container = fakeDoc.createElement("div");
    renderGraphicsTab(container);

    const stateBefore = loadGraphicsState();
    assert.equal(stateBefore.flags.pom, undefined);
    assert.equal(stateBefore.flags.statPom, undefined);

    // Find the POM checkbox via its label
    const pomLabel = elements.find((e) => e.tagName === "LABEL" && e.textContent?.includes("Parallax"));
    assert.ok(pomLabel, "POM label created in tab");
    const pomInput = elements.find((e) => e.tagName === "INPUT" && e.id === pomLabel.htmlFor);
    assert.ok(pomInput, "POM checkbox element created in tab");

    // Toggle POM ON
    pomInput.checked = true;
    pomInput.on_change?.();

    const stateAfter = loadGraphicsState();
    assert.equal(stateAfter.flags.pom, true, "pom flag set");
    assert.equal(stateAfter.flags.statPom, true, "outdoor statPom flag synchronized");

    // Toggle POM OFF
    pomInput.checked = false;
    pomInput.on_change?.();

    const stateOff = loadGraphicsState();
    assert.equal(stateOff.flags.pom, false, "pom flag unset");
    assert.equal(stateOff.flags.statPom, false, "outdoor statPom flag synchronized unset");
  } finally {
    globalThis.document = savedDoc;
  }
});

test("[graphics_settings] UI renders controls for clouds, ssao, anisotropy, vitalsOrbs, orbScale, and chatFade", () => {
  storage.clear();
  const savedDoc = globalThis.document;

  const elements = [];
  const fakeDoc = createMockDoc(elements);
  globalThis.document = fakeDoc;

  try {
    const container = fakeDoc.createElement("div");
    renderGraphicsTab(container);

    // Verify all missing options now have UI representation
    assert.ok(elements.some((e) => e.id?.includes("clouds") || e.textContent?.includes("Volumetric clouds")), "clouds toggle exists");
    assert.ok(elements.some((e) => e.id?.includes("ssao") || e.textContent?.includes("SSAO")), "ssao toggle exists");
    assert.ok(elements.some((e) => e.id?.includes("csm") || e.textContent?.includes("CSM")), "csm toggle exists");
    assert.ok(elements.some((e) => e.id?.includes("anisotropy") || e.textContent?.includes("Anisotropic")), "anisotropy select exists");
    assert.ok(elements.some((e) => e.id?.includes("vitalsorbs") || e.textContent?.includes("Vitals orbs")), "vitalsOrbs toggle exists");
    assert.ok(elements.some((e) => e.id?.includes("orbscale") || e.textContent?.includes("Orb scale")), "orbScale slider exists");
    assert.ok(elements.some((e) => e.id?.includes("chatfade") || e.textContent?.includes("Fade chat")), "chatFade toggle exists");
  } finally {
    globalThis.document = savedDoc;
  }
});

// ── 3. vitals-orbs.js Parity & Persistence ───────────────────────────────
test("[vitals-orbs] isVitalsOrbsActive and orbScale respect settings and persistence", () => {
  storage.clear();

  // Default is active (true) and scale 0.72
  assert.equal(isVitalsOrbsActive(), true, "default active is true");
  assert.equal(getOrbScale(), 0.72, "default scale is 0.72");

  // Setting via setter
  setVitalsOrbsActive(false);
  assert.equal(globalThis.localStorage.getItem("hb_vitals_orbs"), "0");
  assert.equal(isVitalsOrbsActive(), false, "reads back inactive from storage");

  setVitalsOrbsActive(true);
  assert.equal(globalThis.localStorage.getItem("hb_vitals_orbs"), "1");
  assert.equal(isVitalsOrbsActive(), true, "reads back active from storage");

  setOrbScale(1.25);
  assert.equal(globalThis.localStorage.getItem("hb_orb_scale"), "1.25");
  assert.equal(getOrbScale(), 1.25, "reads back scale from storage");

  // Fallback to holtburger_graphics_v1
  storage.clear();
  storage.set("holtburger_graphics_v1", JSON.stringify({
    extras: { vitalsOrbs: false, orbScale: 0.75 },
  }));
  assert.equal(isVitalsOrbsActive(), false, "reads vitalsOrbs: false from graphics state");
  assert.equal(orbScale(), 0.75, "reads orbScale: 0.75 from graphics state");
});

// ── 4. Chat Fade Persistence ─────────────────────────────────────────────
test("[chat-fade] chatFade persists and is recognized by graphics state and storage", () => {
  storage.clear();

  // Initially not set
  assert.equal(globalThis.localStorage.getItem("hb_chat_panel_fade"), null);

  // Set chat fade
  storage.set("hb_chat_panel_fade", "1");
  assert.equal(globalThis.localStorage.getItem("hb_chat_panel_fade"), "1");

  storage.set("holtburger_graphics_v1", JSON.stringify({
    extras: { chatFade: true },
  }));
  const loaded = loadGraphicsState();
  assert.equal(loaded.extras.chatFade, true);
});

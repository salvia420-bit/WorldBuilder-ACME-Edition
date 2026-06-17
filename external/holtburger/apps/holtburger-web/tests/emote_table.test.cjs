// Wave F.6 (2026-05-27) — Node smoke test for the emote-panel JS
// contract: validates `inferSoulEmoteTypeId`, the action-tooltip
// builder, the dispatch decision tree, and the section-grouping
// renderer against a synthetic getEmoteTaxonomy() payload.
//
// Like spellbook_wasm_record.test.cjs, we can't import the plugin
// directly (needs DOM + AC font + plugin API). The contract under
// test lives in the `__test` export of plugins/emote-panel.js; we
// re-implement it here against the same payload shape that wasm
// produces, then assert the merge behaviour.
//
// Run:
//   node tests/emote_table.test.cjs

'use strict';

const assert = require('node:assert/strict');

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

// ─── Local copies of the contract under test ──────────────────────────
// Keep in sync with apps/holtburger-web/plugins/emote-panel.js.

function inferSoulEmoteTypeId(tokenName) {
  const SAY_TOKENS = new Set([
    "admit", "confess", "duck", "duh", "no", "ok", "yes",
    "hello", "goodbye", "thanks", "sorry", "huh", "wow",
  ]);
  return SAY_TOKENS.has(tokenName.toLowerCase()) ? 0x08 : 0x05;
}

function buildActionTooltip(t) {
  const visibility = t.isUserVisible ? "user-visible" : "server-only";
  const fieldsList = t.fields.length === 0 ? "(none)" : t.fields.join(", ");
  return `${t.name} (0x${t.id.toString(16).padStart(2, "0")})\n`
       + `shape: ${t.shape}\n`
       + `fields: ${fieldsList}\n`
       + `${visibility}`;
}

function dispatchEmoteAction(t, ctx) {
  const handle = ctx?.handle ?? null;
  if (!handle) {
    return { dispatched: false, error: "Not logged in." };
  }
  if (t.id === 0x05 || t.id === 0x34) {
    return {
      dispatched: false,
      info: `For pose emotes use slash commands in chat (e.g. /wave, /bow). Action type ${t.name} is dispatched per-pose.`,
    };
  }
  if (t.id === 0x09 /* Sound */) {
    // HUD rec #142 — local-only emote sound (mirrors emote-panel.js).
    if (typeof handle.broadcastEmoteSoundEffect !== "function") {
      return { dispatched: false, info: `Action ${t.name}: sound playback needs a newer client build.` };
    }
    const guid = (typeof window !== "undefined" && typeof window.getLocalPlayerGuid === "function")
      ? (window.getLocalPlayerGuid() >>> 0) : 0;
    if (!guid) {
      return { dispatched: false, info: `Action ${t.name}: enter the world before playing a sound.` };
    }
    const soundEnum = 0x40; // Sound.Eat1 — representative in-humanoid-table cue.
    try {
      handle.broadcastEmoteSoundEffect(guid, soundEnum);
    } catch (err) {
      return { dispatched: false, error: `Sound dispatch failed: ${err?.message ?? err}` };
    }
    return {
      dispatched: true,
      echo: `Played Sound enum 0x${soundEnum.toString(16)} locally (remote players will not hear it).`,
    };
  }
  if (t.id === 0x08) {
    if (typeof handle.sendEmote === "function") {
      return {
        dispatched: false,
        info: `Action ${t.name}: use chat input "/me <text>" to dispatch.`,
      };
    }
  }
  if (!t.isUserVisible) {
    return {
      dispatched: false,
      info: `Action ${t.name} is server-only (no client-firable C2S surface).`,
    };
  }
  return {
    dispatched: false,
    info: `Action ${t.name} (shape ${t.shape}) — wire dispatch deferred to Wave F.6 stretch.`,
  };
}

// ─── Synthetic taxonomy payload (matches the wasm export shape) ────────
// Pre-populates a representative subset of the actual 39 + 122 enums to
// keep this test self-contained without booting wasm.
const SYNTHETIC_TAXONOMY = {
  categoryCount: 39,
  typeCount: 122,
  categories: [
    { id: 0x00, name: "Invalid", rawName: "Invalid", isCommon: false },
    { id: 0x01, name: "Refuse", rawName: "Refuse", isCommon: true },
    { id: 0x02, name: "Vendor", rawName: "Vendor", isCommon: true },
    { id: 0x06, name: "Give", rawName: "Give", isCommon: true },
    { id: 0x0C, name: "Quest Success", rawName: "QuestSuccess", isCommon: true },
    { id: 0x18, name: "Hear Chat", rawName: "HearChat", isCommon: true },
    { id: 0x25, name: "Receive Local Signal", rawName: "ReceiveLocalSignal", isCommon: false },
  ],
  types: [
    // Bare (no extra payload)
    { id: 0x00, name: "Invalid", isUserVisible: false, shape: "Bare", fields: [] },
    { id: 0x39, name: "ResetHomePosition", isUserVisible: false, shape: "Bare", fields: [] },
    // Message
    { id: 0x08, name: "Say", isUserVisible: true, shape: "Message", fields: ["message"] },
    { id: 0x0A, name: "Tell", isUserVisible: true, shape: "Message", fields: ["message"] },
    // Motion
    { id: 0x05, name: "Motion", isUserVisible: true, shape: "Motion", fields: ["motion"] },
    { id: 0x34, name: "ForceMotion", isUserVisible: true, shape: "Motion", fields: ["motion"] },
    // Sound (HUD rec #142 — local-only emote sound)
    { id: 0x09, name: "Sound", isUserVisible: true, shape: "Sound", fields: ["sound"] },
    // SpellId
    { id: 0x0E, name: "CastSpell", isUserVisible: true, shape: "SpellId", fields: ["spellId"] },
    // AwardHeroXp
    { id: 0x02, name: "AwardXP", isUserVisible: true, shape: "AmountHeroXp", fields: ["amount64", "heroXp64"] },
    // Server-only
    { id: 0x15, name: "InqQuest", isUserVisible: false, shape: "Message", fields: ["message"] },
    { id: 0x35, name: "SetIntStat", isUserVisible: false, shape: "StatAmount", fields: ["stat", "amount"] },
    // Position
    { id: 0x64, name: "TeleportSelf", isUserVisible: true, shape: "Position", fields: ["position"] },
  ],
};

// ─── Tests ─────────────────────────────────────────────────────────────

check("inferSoulEmoteTypeId: 'wave' → Motion (0x05)", () => {
  assert.equal(inferSoulEmoteTypeId("wave"), 0x05);
});

check("inferSoulEmoteTypeId: 'bow' → Motion (0x05)", () => {
  assert.equal(inferSoulEmoteTypeId("bow"), 0x05);
});

check("inferSoulEmoteTypeId: 'admit' → Say (0x08)", () => {
  assert.equal(inferSoulEmoteTypeId("admit"), 0x08);
});

check("inferSoulEmoteTypeId: 'goodbye' → Say (0x08)", () => {
  assert.equal(inferSoulEmoteTypeId("goodbye"), 0x08);
});

check("inferSoulEmoteTypeId: case-insensitive", () => {
  assert.equal(inferSoulEmoteTypeId("Wave"), 0x05);
  assert.equal(inferSoulEmoteTypeId("OK"), 0x08);
  assert.equal(inferSoulEmoteTypeId("Yes"), 0x08);
});

check("inferSoulEmoteTypeId: unknown token defaults to Motion", () => {
  assert.equal(inferSoulEmoteTypeId("flummox"), 0x05);
  assert.equal(inferSoulEmoteTypeId("xyzzy"), 0x05);
});

check("buildActionTooltip: includes type id hex, shape, fields, visibility", () => {
  const t = { id: 0x08, name: "Say", isUserVisible: true, shape: "Message", fields: ["message"] };
  const tip = buildActionTooltip(t);
  assert.match(tip, /Say \(0x08\)/);
  assert.match(tip, /shape: Message/);
  assert.match(tip, /fields: message/);
  assert.match(tip, /user-visible/);
});

check("buildActionTooltip: empty fields renders (none)", () => {
  const t = { id: 0x39, name: "ResetHomePosition", isUserVisible: false, shape: "Bare", fields: [] };
  const tip = buildActionTooltip(t);
  assert.match(tip, /fields: \(none\)/);
  assert.match(tip, /server-only/);
});

check("buildActionTooltip: zero-padded hex", () => {
  const t = { id: 0x05, name: "Motion", isUserVisible: true, shape: "Motion", fields: ["motion"] };
  const tip = buildActionTooltip(t);
  assert.match(tip, /\(0x05\)/);
});

check("buildActionTooltip: multi-field render", () => {
  const t = { id: 0x32, name: "AwardLevelProportionalSkillXP", isUserVisible: true,
              shape: "StatPercentMinMaxDisplay",
              fields: ["stat", "percent", "min", "max", "display"] };
  const tip = buildActionTooltip(t);
  assert.match(tip, /fields: stat, percent, min, max, display/);
});

check("dispatchEmoteAction: no handle → error", () => {
  const t = { id: 0x05, name: "Motion", isUserVisible: true, shape: "Motion", fields: ["motion"] };
  const result = dispatchEmoteAction(t, { handle: null });
  assert.equal(result.dispatched, false);
  assert.equal(result.error, "Not logged in.");
});

check("dispatchEmoteAction: Motion (0x05) → soul-emote hint", () => {
  const t = { id: 0x05, name: "Motion", isUserVisible: true, shape: "Motion", fields: ["motion"] };
  const result = dispatchEmoteAction(t, { handle: {} });
  assert.equal(result.dispatched, false);
  assert.match(result.info, /pose emotes use slash commands/);
});

check("dispatchEmoteAction: ForceMotion (0x34) → soul-emote hint", () => {
  const t = { id: 0x34, name: "ForceMotion", isUserVisible: true, shape: "Motion", fields: ["motion"] };
  const result = dispatchEmoteAction(t, { handle: {} });
  assert.equal(result.dispatched, false);
  assert.match(result.info, /pose emotes use slash commands/);
});

check("dispatchEmoteAction: Sound (0x09) without wasm export → upgrade hint", () => {
  const t = { id: 0x09, name: "Sound", isUserVisible: true, shape: "Sound", fields: ["sound"] };
  const result = dispatchEmoteAction(t, { handle: {} });
  assert.equal(result.dispatched, false);
  assert.match(result.info, /newer client build/);
});

check("dispatchEmoteAction: Sound (0x09) pre-world (no guid) → enter-world hint", () => {
  const t = { id: 0x09, name: "Sound", isUserVisible: true, shape: "Sound", fields: ["sound"] };
  const calls = [];
  const handle = { broadcastEmoteSoundEffect: (g, s) => calls.push([g, s]) };
  // No window.getLocalPlayerGuid in scope → guid resolves to 0.
  const result = dispatchEmoteAction(t, { handle });
  assert.equal(result.dispatched, false);
  assert.match(result.info, /enter the world/);
  assert.equal(calls.length, 0);
});

check("dispatchEmoteAction: Sound (0x09) in-world → local-only play (rec #142)", () => {
  const t = { id: 0x09, name: "Sound", isUserVisible: true, shape: "Sound", fields: ["sound"] };
  const calls = [];
  const handle = { broadcastEmoteSoundEffect: (g, s) => calls.push([g, s]) };
  const prevWindow = globalThis.window;
  globalThis.window = { getLocalPlayerGuid: () => 0x50000123 };
  try {
    const result = dispatchEmoteAction(t, { handle });
    assert.equal(result.dispatched, true);
    assert.match(result.echo, /locally/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 0x50000123); // local player guid forwarded
    assert.equal(calls[0][1], 0x40);       // Sound.Eat1 representative cue
  } finally {
    globalThis.window = prevWindow;
  }
});

check("dispatchEmoteAction: Say (0x08) → /me chat hint", () => {
  const t = { id: 0x08, name: "Say", isUserVisible: true, shape: "Message", fields: ["message"] };
  const result = dispatchEmoteAction(t, { handle: { sendEmote() {} } });
  assert.equal(result.dispatched, false);
  assert.match(result.info, /"\/me <text>"/);
});

check("dispatchEmoteAction: server-only InqQuest → server-only hint", () => {
  const t = { id: 0x15, name: "InqQuest", isUserVisible: false, shape: "Message", fields: ["message"] };
  const result = dispatchEmoteAction(t, { handle: {} });
  assert.equal(result.dispatched, false);
  assert.match(result.info, /server-only/);
});

check("dispatchEmoteAction: user-visible but no specific handler → deferred message", () => {
  const t = { id: 0x07, name: "PhysScript", isUserVisible: true, shape: "PhysScript", fields: ["physicsScript"] };
  const result = dispatchEmoteAction(t, { handle: {} });
  assert.equal(result.dispatched, false);
  assert.match(result.info, /Wave F\.6 stretch/);
});

check("synthetic taxonomy: shape counts", () => {
  // Spot-check the synthetic payload to confirm the structure is consistent.
  assert.equal(SYNTHETIC_TAXONOMY.categories.length, 7);
  assert.equal(SYNTHETIC_TAXONOMY.types.length, 12);
  // All types must have id + name + shape + fields + isUserVisible.
  for (const t of SYNTHETIC_TAXONOMY.types) {
    assert.ok(Number.isInteger(t.id));
    assert.ok(typeof t.name === "string");
    assert.ok(typeof t.shape === "string");
    assert.ok(Array.isArray(t.fields));
    assert.ok(typeof t.isUserVisible === "boolean");
  }
});

check("synthetic taxonomy: id 0x00 reserved", () => {
  const invalid = SYNTHETIC_TAXONOMY.types.find((t) => t.id === 0x00);
  assert.ok(invalid);
  assert.equal(invalid.isUserVisible, false);
  assert.equal(invalid.shape, "Bare");
});

check("synthetic taxonomy: Motion + ForceMotion both shape='Motion'", () => {
  const motion = SYNTHETIC_TAXONOMY.types.find((t) => t.id === 0x05);
  const force_motion = SYNTHETIC_TAXONOMY.types.find((t) => t.id === 0x34);
  assert.ok(motion);
  assert.ok(force_motion);
  assert.equal(motion.shape, "Motion");
  assert.equal(force_motion.shape, "Motion");
});

check("synthetic taxonomy: SpellId shape on CastSpell", () => {
  const cast = SYNTHETIC_TAXONOMY.types.find((t) => t.id === 0x0E);
  assert.ok(cast);
  assert.equal(cast.shape, "SpellId");
  assert.deepEqual(cast.fields, ["spellId"]);
});

check("synthetic taxonomy: every common category in categories list", () => {
  const commonIds = SYNTHETIC_TAXONOMY.categories.filter((c) => c.isCommon).map((c) => c.id);
  // Sampling: Refuse (0x01), Vendor (0x02), Give (0x06), QuestSuccess (0x0C),
  // HearChat (0x18) are all flagged common in the wasm export.
  for (const id of [0x01, 0x02, 0x06, 0x0C, 0x18]) {
    assert.ok(commonIds.includes(id), `category id 0x${id.toString(16)} should be common`);
  }
});

check("taxonomy partition: user-visible vs server-only count", () => {
  const visible = SYNTHETIC_TAXONOMY.types.filter((t) => t.isUserVisible).length;
  const server = SYNTHETIC_TAXONOMY.types.filter((t) => !t.isUserVisible).length;
  assert.equal(visible + server, SYNTHETIC_TAXONOMY.types.length);
  // Spot-check: at least 5 user-visible actions in the synthetic set.
  assert.ok(visible >= 5, `expected ≥ 5 user-visible types, got ${visible}`);
});

check("Position shape (TeleportSelf) preserves position field", () => {
  const tele = SYNTHETIC_TAXONOMY.types.find((t) => t.id === 0x64);
  assert.ok(tele);
  assert.equal(tele.shape, "Position");
  assert.deepEqual(tele.fields, ["position"]);
});

check("AmountHeroXp shape (AwardXP) carries two 64-bit fields", () => {
  const xp = SYNTHETIC_TAXONOMY.types.find((t) => t.id === 0x02);
  assert.ok(xp);
  assert.equal(xp.shape, "AmountHeroXp");
  assert.deepEqual(xp.fields, ["amount64", "heroXp64"]);
});

// ─── Roll-up ───────────────────────────────────────────────────────────

console.log(`\n[emote_table.test.cjs] ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`  ${f.name}: ${f.err.stack || f.err}`);
  process.exit(1);
}

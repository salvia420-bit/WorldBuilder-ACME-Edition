#!/usr/bin/env node
// rynth_ai_observe_ext_test.cjs — unit tests for rynth/ai/observe_ext.js
// (enrichObservation: the ADDITIVE enricher over buildObservation output).
// No infra, no network — hand-built base results + mock bots, plus one
// composition pass over the real observe.js. See task B6 / the module header.
//
// Run: node rynth_ai_observe_ext_test.cjs   (exits 1 on any FAIL)

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

(async () => {
  const mod = (p) => import(pathToFileURL(path.join(__dirname, ...p)).href);
  const ex = await mod(["rynth", "ai", "observe_ext.js"]);
  const ob = await mod(["rynth", "ai", "observe.js"]);

  const NOW = 1_800_000_000_000; // fixed clock — all trend math injected

  // A hand-built buildObservation-shaped base (text + the data it renders).
  const makeBase = (data = {}) => ({
    text: "uptime: 5m0s | kernel: running action=Combat kills=12 looted=7\nvitals: hp=85% stam=70% mana=61%\njournal: (none)",
    data: {
      kernel: { running: true, action: "Combat", kills: 12, looted: 7 },
      vitals: { hp: 85, stam: 70, mana: 61 },
      threats: [{ name: "drudge skulker", dist: 10, hp: 0.45 }],
      corpses: 0,
      ...data,
    },
  });

  const PORTAL_GUID = 0x80001111;
  function makeHost(overrides = {}) {
    const ents = {
      [PORTAL_GUID]: { name: "Gateway", itemType: 0x00010000, x: 66, y: 108, z: 12 },
      0x80002222: { name: "drudge skulker", itemType: 0x10, x: 70, y: 100, z: 12 },
    };
    return {
      TryGetPlayerPose: () => ({ objCellId: 0xa9b40015, x: 60, y: 100, z: 12 }),
      NearbyGuids: () => Object.keys(ents).map(Number),
      TryGetObjectIntProperty: (g, k) => (k === 1 ? ents[g]?.itemType : undefined),
      TryGetObjectPosition: (g) => (ents[g] ? { objCellId: 0xa9b40015, x: ents[g].x, y: ents[g].y, z: ents[g].z } : null),
      TryGetObjectName: (g) => ents[g]?.name ?? null,
      ...overrides,
    };
  }

  // ── appends all four sections; base untouched ──────────────────────────
  {
    const base = makeBase();
    const state = {};
    const bot = { host: makeHost(), kernel: { status: { kills: 12 } } };
    const r = ex.enrichObservation(bot, base, { now: NOW, state });
    check("append: starts with base text verbatim", r.text.startsWith(base.text + "\n"), r.text.slice(0, 60));
    check("append: focus line", /\nfocus: /.test(r.text), r.text);
    check("append: kill_trend line", r.text.includes("\nkill_trend: warming up"), r.text);
    check("append: burden line (n/a host)", r.text.includes("\nburden: n/a | free_slots: n/a"), r.text);
    // portal at same-lb (66,108) vs me (60,100): hypot(6,8,0)=10.0
    check("append: portals line", r.text.includes("\nportals: Gateway d=10.0m"), r.text);
    check("append: data.ext present", r.data.ext && typeof r.data.ext === "object" && typeof r.data.ext.focus === "string");
    check("append: base data fields carried", r.data.kernel.kills === 12 && r.data.vitals.hp === 85);
    check("append: base result NOT mutated", !("ext" in base.data) && !base.text.includes("focus:"));
    check("append: portal list excludes non-portals", r.data.ext.portals.length === 1 && r.data.ext.portals[0].guid === PORTAL_GUID);
  }

  // ── throwing bot -> base returned unchanged (same object) ──────────────
  {
    const base = makeBase({ kernel: null }); // force killTrend to touch the bot
    const hostile = new Proxy({}, { get() { throw new Error("boom"); } });
    let r = null, threw = false;
    try { r = ex.enrichObservation(hostile, base, { now: NOW, state: {} }); } catch { threw = true; }
    check("hostile: never throws", !threw);
    check("hostile: base returned unchanged (identity)", r === base);
    check("hostile: no ext leaked into base", !("ext" in base.data) && !base.text.includes("focus:"));
  }

  // malformed base -> returned as-is, never throws
  {
    let ok = true, r;
    try { r = ex.enrichObservation({ host: makeHost() }, null, { now: NOW }); } catch { ok = false; }
    check("malformed base: null passes through", ok && r === null);
    const noText = { data: {} };
    check("malformed base: missing text passes through", ex.enrichObservation({}, noText, { now: NOW }) === noText);
  }

  // ── maxChars: re-truncates after append, ext lines drop from the END ───
  {
    const base = makeBase();
    const bot = { host: makeHost() };
    const full = ex.enrichObservation(bot, base, { now: NOW, state: {} });
    // Budget for base + focus + kill_trend only: portals + burden must drop.
    const cap = full.text.indexOf("\nburden:");
    const r = ex.enrichObservation(bot, base, { now: NOW, state: {}, maxChars: cap });
    check("maxChars: respected", r.text.length <= cap, `len=${r.text.length} cap=${cap}`);
    check("maxChars: focus + trend kept", r.text.includes("focus:") && r.text.includes("kill_trend:"));
    check("maxChars: burden + portals dropped first", !r.text.includes("burden:") && !r.text.includes("portals:"));
    check("maxChars: data.ext still complete", r.data.ext.portals.length === 1 && r.data.ext.focus.length > 0);
    // No room for any ext line -> base text unchanged.
    const r2 = ex.enrichObservation(bot, base, { now: NOW, maxChars: base.text.length });
    check("maxChars: zero headroom -> base text verbatim", r2.text === base.text);
    // Cap below base length -> hard slice (observe.js:275 parity).
    const r3 = ex.enrichObservation(bot, base, { now: NOW, maxChars: 40 });
    check("maxChars: hard cap slices", r3.text.length <= 40, `len=${r3.text.length}`);
  }

  // ── kills/min trend math with injected history + now ──────────────────
  {
    // Seeded sample 8 minutes ago at 0 kills; current kills 20 -> 2.5/min.
    const state = { _killSamples: [{ t: NOW - 8 * 60_000, kills: 0 }] };
    const base = makeBase({ kernel: { running: true, action: "Combat", kills: 20, looted: 7 } });
    const r = ex.enrichObservation({}, base, { now: NOW, state });
    check("trend: rate math (20 kills / 8 min)", r.data.ext.trend.ratePerMin === 2.5, JSON.stringify(r.data.ext.trend));
    check("trend: rendered", r.text.includes("kill_trend: 2.5/min over 8m (+20 kills)"), r.text);
    check("trend: state accumulated", state._killSamples.length === 2 && state._killSamples[1].kills === 20);

    // Samples outside the window are pruned before the math.
    const state2 = { _killSamples: [{ t: NOW - 60 * 60_000, kills: 0 }, { t: NOW - 4 * 60_000, kills: 10 }] };
    const r2 = ex.enrichObservation({}, base, { now: NOW, state: state2 });
    check("trend: old samples pruned (10-min window)",
      state2._killSamples.length === 2 && r2.data.ext.trend.ratePerMin === 2.5, // (20-10)/4min
      JSON.stringify(r2.data.ext.trend));

    // Kill counter going BACKWARDS (kernel restart) resets the history.
    const state3 = { _killSamples: [{ t: NOW - 5 * 60_000, kills: 500 }] };
    const r3 = ex.enrichObservation({}, base, { now: NOW, state: state3 });
    check("trend: counter reset clears history", state3._killSamples.length === 1
      && r3.data.ext.trend.ratePerMin === null && r3.text.includes("kill_trend: warming up"));

    // No state object -> trend n/a (observe is stateless; we need the caller's state).
    const r4 = ex.enrichObservation({}, base, { now: NOW });
    check("trend: no state -> n/a", r4.data.ext.trend === null && r4.text.includes("kill_trend: n/a"));

    // No kills anywhere (no base kernel, no bot.kernel) -> n/a, state untouched.
    const state5 = {};
    const r5 = ex.enrichObservation({}, makeBase({ kernel: null }), { now: NOW, state: state5 });
    check("trend: no kill source -> n/a", r5.data.ext.trend === null && !("_killSamples" in state5 && state5._killSamples.length));

    // Falls back to bot.kernel.status.kills when base data lacks it.
    const state6 = { _killSamples: [{ t: NOW - 4 * 60_000, kills: 0 }] };
    const r6 = ex.enrichObservation({ kernel: { status: { kills: 8 } } }, makeBase({ kernel: null }), { now: NOW, state: state6 });
    check("trend: bot.kernel fallback", r6.data.ext.trend.ratePerMin === 2, JSON.stringify(r6.data.ext.trend));
  }

  // ── burden probe ───────────────────────────────────────────────────────
  {
    const base = makeBase();
    // Named getter wins.
    const r1 = ex.enrichObservation({ host: makeHost({ GetBurden: () => 12345, GetFreeSlots: () => 34 }) }, base, { now: NOW });
    check("burden: named getters", r1.text.includes("burden: 12345 | free_slots: 34")
      && r1.data.ext.burden.burden === 12345 && r1.data.ext.burden.freeSlots === 34);
    // EncumbranceVal int-property fallback (PropertyInt 5).
    const r2 = ex.enrichObservation({
      host: makeHost({ GetPlayerId: () => 0x50000001, TryGetObjectIntProperty: (g, k) => (g === 0x50000001 && k === 5 ? 777 : undefined) }),
    }, base, { now: NOW });
    check("burden: EncumbranceVal fallback", r2.text.includes("burden: 777 | free_slots: n/a"), r2.text);
    // Nothing exposed -> "n/a" (the task's required path).
    const r3 = ex.enrichObservation({ host: makeHost() }, base, { now: NOW });
    check("burden: absent -> n/a", r3.text.includes("burden: n/a | free_slots: n/a") && r3.data.ext.burden === null);
    // Getter present but non-numeric -> still n/a, not garbage.
    const r4 = ex.enrichObservation({ host: makeHost({ GetBurden: () => "heavy" }) }, base, { now: NOW });
    check("burden: non-numeric getter -> n/a", r4.text.includes("burden: n/a"), r4.text);
    // No host at all -> n/a.
    const r5 = ex.enrichObservation({}, base, { now: NOW });
    check("burden: no host -> n/a", r5.text.includes("burden: n/a | free_slots: n/a"));
  }

  // ── portals ────────────────────────────────────────────────────────────
  {
    const base = makeBase();
    // No portals nearby -> "none".
    const host = makeHost();
    host.NearbyGuids = () => [0x80002222];
    const r1 = ex.enrichObservation({ host }, base, { now: NOW });
    check("portals: none nearby", r1.text.includes("portals: none") && r1.data.ext.portals.length === 0);
    // Host lacking the object-read surface -> n/a.
    const r2 = ex.enrichObservation({ host: { TryGetPlayerPose: () => null } }, base, { now: NOW });
    check("portals: no surface -> n/a", r2.text.includes("portals: n/a") && r2.data.ext.portals === null);
    // Sorted by distance, capped at 3.
    const many = {};
    for (let i = 1; i <= 5; i++) many[0x80003000 + i] = { name: `Portal ${i}`, itemType: 0x00010000, x: 60 + i * 10, y: 100, z: 12 };
    const host3 = makeHost({
      NearbyGuids: () => Object.keys(many).map(Number),
      TryGetObjectIntProperty: (g, k) => (k === 1 ? many[g]?.itemType : undefined),
      TryGetObjectPosition: (g) => (many[g] ? { objCellId: 0xa9b40015, x: many[g].x, y: many[g].y, z: many[g].z } : null),
      TryGetObjectName: (g) => many[g]?.name ?? null,
    });
    const r3 = ex.enrichObservation({ host: host3 }, base, { now: NOW });
    check("portals: nearest-3 cap", r3.data.ext.portals.length === 3
      && r3.data.ext.portals[0].name === "Portal 1" && r3.data.ext.portals[2].name === "Portal 3",
      JSON.stringify(r3.data.ext.portals));
  }

  // ── suggested focus heuristics ─────────────────────────────────────────
  {
    const lowHp = ex.enrichObservation({}, makeBase({ vitals: { hp: 25, stam: 70, mana: 61 } }), { now: NOW });
    check("focus: vitals low -> pause", lowHp.data.ext.focus === "vitals low (hp=25%) -> consider pause", lowHp.data.ext.focus);

    const lootable = ex.enrichObservation({}, makeBase({ threats: [], corpses: 3 }), { now: NOW });
    check("focus: no threats + corpses -> loot", lootable.data.ext.focus === "no threats + 3 corpse(s) -> loot", lootable.data.ext.focus);

    // Idle: no threats, no corpses, 0 kill delta across >= 5 min of history.
    const idleState = { _killSamples: [{ t: NOW - 6 * 60_000, kills: 12 }] };
    const idle = ex.enrichObservation({}, makeBase({ threats: [], corpses: 0 }), { now: NOW, state: idleState });
    check("focus: idle long -> travel", idle.data.ext.focus === "idle 6m with 0 kills -> consider travel", idle.data.ext.focus);

    const steady = ex.enrichObservation({}, makeBase(), { now: NOW });
    check("focus: default steady -> none", steady.data.ext.focus === "steady -> none", steady.data.ext.focus);

    // Precedence: low vitals beats the loot hint.
    const both = ex.enrichObservation({}, makeBase({ vitals: { hp: 10 }, threats: [], corpses: 2 }), { now: NOW });
    check("focus: vitals beats loot", both.data.ext.focus.includes("consider pause"), both.data.ext.focus);
  }

  // ── composition over the REAL observe.js ───────────────────────────────
  {
    const host = makeHost();
    const bot = { host, kernel: { running: true, status: { action: "Combat", kills: 12, looted: 7 } } };
    const base = ob.buildObservation(bot, { now: NOW });
    const state = {};
    const r = ex.enrichObservation(bot, base, { now: NOW, state });
    check("compose: real base + all sections", r.text.startsWith(base.text + "\n")
      && r.text.includes("focus:") && r.text.includes("kill_trend:")
      && r.text.includes("burden:") && r.text.includes("portals: Gateway d=10.0m"), r.text);
    check("compose: default 6000-char contract", r.text.length <= 6000, `len=${r.text.length}`);
    check("compose: deterministic with injected now",
      JSON.stringify(ex.enrichObservation(bot, base, { now: NOW, state: {} }))
      === JSON.stringify(ex.enrichObservation(bot, base, { now: NOW, state: {} })));
  }

  // ── nearby classification: takeable items are [item], never [monster] ──
  // ACE defaults every WorldObject's ODF to Attackable, so ground armor
  // arrives ATTACKABLE (the v6.2 academy "Leather Cap [monster]" trap).
  {
    const base = makeBase();
    const ODF_ATTACKABLE = 0x10;
    const ents = {
      0x80004001: { name: "Leather Cap", itemType: 0x2, flags: ODF_ATTACKABLE, x: 62, y: 100, z: 12 }, // Armor
      0x80004002: { name: "Sparring Golem", itemType: 0x10, flags: ODF_ATTACKABLE, x: 64, y: 100, z: 12 }, // Creature
      0x80004003: { name: "Jonathan", itemType: 0x10, flags: 0, x: 66, y: 100, z: 12 }, // non-attackable creature
      0x80004004: { name: "Old Key", itemType: 0x4000, flags: 0, x: 68, y: 100, z: 12 }, // non-attackable item
      0x80004005: { name: "Mystery", itemType: undefined, flags: ODF_ATTACKABLE, x: 70, y: 100, z: 12 }, // no itemType -> legacy
    };
    const host = makeHost({
      NearbyGuids: () => Object.keys(ents).map(Number),
      TryGetObjectIntProperty: (g, k) => (k === 1 ? ents[g]?.itemType : undefined),
      TryGetObjectDescFlags: (g) => ents[g]?.flags ?? null,
      TryGetObjectPosition: (g) => (ents[g] ? { objCellId: 0xa9b40015, x: ents[g].x, y: ents[g].y, z: ents[g].z } : null),
      TryGetObjectName: (g) => ents[g]?.name ?? null,
    });
    const r = ex.enrichObservation({ host }, base, { now: NOW });
    const byName = Object.fromEntries((r.data.ext.nearby || []).map((o) => [o.name, o.type]));
    check("classify: attackable armor -> item", byName["Leather Cap"] === "item", JSON.stringify(byName));
    check("classify: attackable creature -> monster", byName["Sparring Golem"] === "monster", JSON.stringify(byName));
    check("classify: non-attackable creature -> npc", byName["Jonathan"] === "npc", JSON.stringify(byName));
    check("classify: non-attackable item -> item", byName["Old Key"] === "item", JSON.stringify(byName));
    check("classify: no itemType + attackable -> monster (legacy)", byName["Mystery"] === "monster", JSON.stringify(byName));
    check("classify: rendered [item] tag", r.text.includes("Leather Cap [item]"), r.text);
  }

  // ── inventory line: always-on carried-item grounding ───────────────────
  {
    const base = makeBase();
    const inv = [
      { guid: 0x60000001, name: "Academy Exit Token", stackSize: 1, value: 0, equipMask: 0, wcid: 29335 },
      { guid: 0x60000002, name: "Pyreal", stackSize: 500, value: 500, equipMask: 0, wcid: 273 },
      { guid: 0x60000003, name: "Leather Boots", stackSize: 1, value: 20, equipMask: 0x800, wcid: 115 },
    ];
    const r = ex.enrichObservation({ host: makeHost({ TryGetPlayerInventory: () => inv }) }, base, { now: NOW });
    check("inventory: line rendered with count", r.text.includes("inventory(3): "), r.text);
    check("inventory: zero-value item present (the v6.2 token trap)", r.text.includes("Academy Exit Token"), r.text);
    check("inventory: stacks + worn split", r.text.includes("Pyreal x500") && r.text.includes("| worn: Leather Boots"), r.text);
    check("inventory: data.ext present", r.data.ext.inventory && r.data.ext.inventory.count === 3);
    // Big pack: capped with explicit +N more, never silent.
    const big = Array.from({ length: 40 }, (_, i) => ({ guid: 0x61000000 + i, name: `Trinket ${i}`, stackSize: 1, value: i, equipMask: 0, wcid: 1000 + i }));
    const r2 = ex.enrichObservation({ host: makeHost({ TryGetPlayerInventory: () => big }) }, base, { now: NOW, maxChars: 12000 });
    check("inventory: big pack capped with +N more", r2.text.includes("(+16 more)"), r2.text.slice(r2.text.indexOf("inventory(")));
    // No inventory surface -> n/a, never throws.
    const r3 = ex.enrichObservation({ host: makeHost() }, base, { now: NOW });
    check("inventory: no surface -> n/a", r3.text.includes("inventory: n/a"), r3.text);
  }

  // defaults path (no opts) must not throw
  {
    let ok = true;
    try { ex.enrichObservation({ host: makeHost() }, makeBase()); } catch { ok = false; }
    check("default opts do not throw", ok);
  }

  console.log(`${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});

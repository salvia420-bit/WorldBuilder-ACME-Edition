#!/usr/bin/env node
// rynth_healreflex_test.cjs — unit tests for rynth/ai/heal_reflex.js (WP-14
// A1-3): the dark, flag-off out-of-combat heal reflex. No infra, mocked host,
// injected opts.now for deterministic cooldown pacing.
//
// Covers the WP acceptance shape: deficit+kits -> UseItemOnTarget(kit,self)
// when skill-sufficient; food fallback when skill-insufficient; no-op at full
// HP; and the survival invariants (flag-off no-op that never reads the host,
// busy/combat-lock deferral, cooldown pacing, never-throws).

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

const SELF = 0x50000001;
const FOOD_BIT = 0x20; // ItemType.FOOD

// Inventory: two kits (rank by value) + one food + one equipped (ignored) item.
const KIT_CRUDE = { guid: 0x1001, name: "Crude Healing Kit", value: 5, itemType: 0, equipMask: 0 };
const KIT_GOLD = { guid: 0x1002, name: "Gold Healing Kit", value: 40, itemType: 0, equipMask: 0 };
const FOOD = { guid: 0x1003, name: "Bread", value: 1, itemType: FOOD_BIT, equipMask: 0 };
const WORN = { guid: 0x1004, name: "Healing Kit Amulet", value: 999, itemType: 0, equipMask: 0x8 };

// hpPct: 0..100 ; skill: Healing.current ; busy/ready/mode toggles.
function makeHost(over = {}) {
  const calls = [];
  const hp = over.hp ?? 40;
  const skill = over.skill ?? 100;
  const inv = over.inventory ?? [KIT_CRUDE, KIT_GOLD, FOOD, WORN];
  return {
    calls,
    IsPlayerReady: () => over.ready ?? true,
    GetBusyState: () => over.busy ?? 0,
    GetCastBusyState: () => over.castBusy ?? 0,
    GetPlayerId: () => SELF,
    TryGetPlayerStats: () => ({
      vitals: { 1: { current: hp, base: 100, max: 100 } },
      skills: { 21: { current: skill, base: skill, ranks: 0, training: 2, nextCost: 0 } },
    }),
    TryGetPlayerInventory: () => inv,
    UseItemOnTarget: (i, t) => { calls.push(["useOn", i >>> 0, t >>> 0]); return over.useOnFails ? false : true; },
    UseObject: (g) => { calls.push(["use", g >>> 0]); return over.useFails ? false : true; },
  };
}

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, "rynth", "ai", "heal_reflex.js")).href);
  const { HealReflex } = mod;

  // (1) deficit + kits + skill-sufficient -> UseItemOnTarget(best kit, self).
  {
    const host = makeHost({ hp: 40, skill: 100 });
    const r = new HealReflex(host, { enabled: true }).step(false);
    check("deficit+skill-ok: acts via kit", r.acted && r.action === "kit", JSON.stringify(r));
    check("deficit+skill-ok: UseItemOnTarget on BEST kit (Gold, higher value) targeting self",
      host.calls.length === 1 && host.calls[0][0] === "useOn" &&
      host.calls[0][1] === KIT_GOLD.guid && host.calls[0][2] === SELF, JSON.stringify(host.calls));
  }

  // (2) deficit + kits present but skill INsufficient -> food fallback.
  {
    const host = makeHost({ hp: 40, skill: 0 }); // min default 1 -> insufficient
    const r = new HealReflex(host, { enabled: true }).step(false);
    check("deficit+skill-insufficient: falls back to food", r.acted && r.action === "food", JSON.stringify(r));
    check("food fallback: UseObject on the food item (not UseItemOnTarget)",
      host.calls.length === 1 && host.calls[0][0] === "use" && host.calls[0][1] === FOOD.guid,
      JSON.stringify(host.calls));
  }

  // (2b) deficit, no kit at all, has food -> food.
  {
    const host = makeHost({ hp: 40, skill: 100, inventory: [FOOD, WORN] });
    const r = new HealReflex(host, { enabled: true }).step(false);
    check("no kit + food present: eats food", r.acted && r.action === "food" && host.calls[0][1] === FOOD.guid, JSON.stringify(r));
  }

  // (3) full HP -> no-op.
  {
    const host = makeHost({ hp: 100, skill: 100 });
    const r = new HealReflex(host, { enabled: true }).step(false);
    check("full HP: no-op (full-hp)", r.acted === false && r.reason === "full-hp", JSON.stringify(r));
    check("full HP: issued NO host action", host.calls.length === 0);
  }

  // (4) flag-off -> no-op AND never reads the host (~0 tokens): a throwing host
  // must be untouched.
  {
    let touched = false;
    const throwingHost = new Proxy({}, { get() { touched = true; throw new Error("host touched"); } });
    const r = new HealReflex(throwingHost, { enabled: false }).step(false);
    check("flag-off: no-op (disabled)", r.acted === false && r.reason === "disabled", JSON.stringify(r));
    check("flag-off: host was never read", touched === false);
  }

  // (5) busy -> defer.
  {
    const host = makeHost({ hp: 40, skill: 100, busy: 1 });
    const r = new HealReflex(host, { enabled: true }).step(false);
    check("busy: no-op (busy)", r.acted === false && r.reason === "busy", JSON.stringify(r));
    check("busy: no host action issued", host.calls.length === 0);
  }
  {
    const host = makeHost({ hp: 40, skill: 100, ready: false });
    const r = new HealReflex(host, { enabled: true }).step(false);
    check("not-ready: no-op (busy)", r.acted === false && r.reason === "busy", JSON.stringify(r));
  }

  // (6) combat-lock (inCombat) -> defer to the spell loop.
  {
    const host = makeHost({ hp: 40, skill: 100 });
    const r = new HealReflex(host, { enabled: true }).step(true);
    check("combat-lock: no-op (combat-lock)", r.acted === false && r.reason === "combat-lock", JSON.stringify(r));
    check("combat-lock: no host action issued", host.calls.length === 0);
  }

  // (7) cooldown pacing via injected now.
  {
    const host = makeHost({ hp: 40, skill: 100 });
    let clock = 1_000;
    const rf = new HealReflex(host, { enabled: true, cooldownMs: 3000, now: () => clock });
    const r1 = rf.step(false);
    check("cooldown: first use acts", r1.acted === true);
    clock += 1000; // < cooldown
    const r2 = rf.step(false);
    check("cooldown: second use within window is suppressed", r2.acted === false && r2.reason === "cooldown", JSON.stringify(r2));
    check("cooldown: still only one host action", host.calls.length === 1);
    clock += 5000; // past cooldown
    const r3 = rf.step(false);
    check("cooldown: acts again after the window", r3.acted === true && host.calls.length === 2);
  }

  // (8) no consumable at all -> no-consumable, no throw.
  {
    const host = makeHost({ hp: 40, skill: 100, inventory: [WORN] });
    const r = new HealReflex(host, { enabled: true }).step(false);
    check("no consumable: no-op (no-consumable)", r.acted === false && r.reason === "no-consumable", JSON.stringify(r));
  }

  // (9) never throws: a host that throws on every read degrades safely.
  {
    let threw = false;
    try {
      const host = { TryGetPlayerStats: () => { throw new Error("boom"); } };
      const r = new HealReflex(host, { enabled: true }).step(false);
      check("throwing host: degrades to no-op, no throw", r.acted === false && (r.reason === "hp-unknown" || r.reason === "error"), JSON.stringify(r));
    } catch { threw = true; }
    check("throwing host: step() never throws", threw === false);
  }

  // (10) send-failure paths don't throw and report the reason.
  {
    const host = makeHost({ hp: 40, skill: 100, useOnFails: true });
    const r = new HealReflex(host, { enabled: true }).step(false);
    check("kit send fails: reports kit-send-failed, no throw", r.acted === false && r.reason === "kit-send-failed", JSON.stringify(r));
  }

  // (11) custom skillOk override is honored (mechanism, not policy).
  {
    const host = makeHost({ hp: 40, skill: 100 });
    const r = new HealReflex(host, { enabled: true, skillOk: () => false }).step(false);
    check("custom skillOk=false forces food even with high skill", r.acted && r.action === "food", JSON.stringify(r));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});

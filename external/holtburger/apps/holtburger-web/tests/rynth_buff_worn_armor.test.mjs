// tests/rynth_buff_worn_armor.test.mjs — worn-armor buffs (2026-10-19): the
// VTank options BuffArmorImpen / BuffProfileBanes made live.
//
// rynth/buff_loop.js — the real loop (and a real kernel) over a scripted fake
// host and clock. ACE's answer is modelled on WorldObject_Magic.cs: a self-cast
// Impenetrability / bane enchants every worn armor / clothing piece and the
// shield, one "You cast <spell> on <item>" line each, then the cast's UseDone;
// nothing worn → no line at all.
//   • the worn-armor table is rynth/vt/data/combat_spells.json's impen /
//     bane:<el> ladders (ids, tiers, the names the server prints), in the
//     Buffs tab's column order;
//   • without the layer (no optFn): no worn cast, no extra host read, status
//     as before, the Items tab's casts untouched;
//   • with it: after the self buffs, one cast per family at our own guid at
//     the best known tier; each confirmed only by its own spell's line; an
//     equipped shield's Items-tab casts dropped for the covered families, a
//     pack shield's kept; the options switch families; nothing worn ⇒ none;
//   • status counts the item enchants, so a real kernel gives a due worn cast
//     the Buffing tick once every self buff is up (not without the layer);
//   • a cast that enchanted nothing is held (60 s, then noShowCooldownMs); a
//     long windup's late line still confirms; a rung ACE says is unknown walks
//     the family down a tier; FIZZLE_WALK_LIMIT fizzles in a row hold the
//     cast 10 min (a worn family steps a tier down meanwhile, held as not
//     due); a busy refusal backs off 1 s; no layer: retried as before;
//   • a bane profile stored before the codec ("Banes1", "All", "2") reads as
//     the codec reads it (the loop's and the bridge's baneLetters = the
//     schema's), unreadable ⇒ every bane;
//   • Force Buff recasts them (Cancel stops it); the rebuff threshold and the
//     idle-rebuff window move the recast point, never before half the span.
// rynth/vt/bridge/bridge_lists.js — the Buffs tab view's wornArmor (the two
//   options, real VtOptions) and the worn / equipped hints on Items-tab rows.
// plugins/rynth-vt/tab_buffs.js — fake DOM, real bridge, real VtOptions: the
//   "Worn armor" row first in the matrix, its cells bound to BuffArmorImpen
//   and the BuffProfileBanes letters (a cell writes the whole new string).
//
// Run from apps/holtburger-web/:  node tests/rynth_buff_worn_armor.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installFakeDom, FakeEvent } from "./helpers/social_fake_dom.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");

globalThis.window = globalThis;
const { document } = installFakeDom(globalThis);
globalThis.location = { href: pathToFileURL(path.join(APP, "index.html")).href, search: "" };

const { RynthBuffLoop, WORN_ARMOR_FAMILIES, baneLetters: loopBaneLetters } = await import("../rynth/buff_loop.js");
const { RynthBotKernel } = await import("../rynth/kernel.js");
const lists = await import("../rynth/vt/bridge/bridge_lists.js");
const { createVtBridge } = await import("../rynth/vt/bridge/vt_bridge.js");
const S = await import("../rynth/vt/settings/index.js");
const { BANE_LETTERS: SCHEMA_BANE_LETTERS, baneLetters: schemaBaneLetters } = await import("../rynth/vt/settings/schema.js");
const { createBuffsTab } = await import("../plugins/rynth-vt/tab_buffs.js");

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 5).join("\n       ") : e}`);
  }
}
const flush = async (n = 3) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const quiet = () => {};

// One fake clock for the loop, the kernel and the options.
const REAL_NOW = Date.now;
let NOW = 1_800_000_000_000;
Date.now = () => NOW;

// ── the scripted world ─────────────────────────────────────────────────────
const ME = 0x50000001;
const COAT = 0x60000101; // worn armor
const SHIRT = 0x60000102; // worn clothing
const KITE = 0x60000103; // the worn shield (on the Items tab)
const TOWER = 0x60000104; // a shield in the pack (on the Items tab)
const WAND = 0x60000105; // the wielded caster
const RING = 0x60000106; // worn jewelry: the worn casts don't reach it
const SELF = 1011; // a self buff (category 101, through the catalog fallback)

const NAME = { [COAT]: "Leather Coat", [SHIRT]: "Cotton Shirt", [KITE]: "Kite Shield", [TOWER]: "Tower Shield", [WAND]: "Wand", [RING]: "Gold Ring" };
const INV = () => [
  { guid: COAT, name: NAME[COAT], equipMask: 0x00000200, itemType: 0x2 },
  { guid: SHIRT, name: NAME[SHIRT], equipMask: 0x00000002, itemType: 0x4 },
  { guid: KITE, name: NAME[KITE], equipMask: 0x00200000, itemType: 0x2 },
  { guid: TOWER, name: NAME[TOWER], equipMask: 0, itemType: 0x2 },
  { guid: WAND, name: NAME[WAND], equipMask: 0x01000000, itemType: 0x8000 },
  { guid: RING, name: NAME[RING], equipMask: 0x00040000, itemType: 0x8 },
];
const RUNG = new Map(WORN_ARMOR_FAMILIES.flatMap((f) => f.rungs.map((r) => [r.id, { ...r, family: f.family }])));
// Impenetrability VI + VII, Blade Bane I + Incantation, Piercing Bane I, the other banes VI.
const KNOWN = [SELF, 51, 1486, 2108, 37, 4393, 1569, 1516, 1552, 1528, 1540, 1498];
const BEST = [2108, 4393, 1569, 1516, 1552, 1528, 1540, 1498]; // column order: Imp Blade Pierce Bludg Flame Frost Light Acid
// The Items tab's projection (rynth/vt/index.js projectItemBuffs): the worn
// Kite Shield's Impenetrability + Flame Bane, the pack shield's Impenetrability.
const ITEMS_TAB = [
  { spellId: 2108, itemGuid: KITE, itemName: NAME[KITE] },
  { spellId: 1552, itemGuid: KITE, itemName: NAME[KITE] },
  { spellId: 2108, itemGuid: TOWER, itemName: NAME[TOWER] },
];

function makeWorld({ known = KNOWN, inv = INV(), castMs = 3000 } = {}) {
  const W = {
    known: known.slice(),
    inv,
    castMs,
    reg: [{ spellId: SELF, spellCategory: 101, startTime: 0, duration: 3600, layer: 1 }],
    seq: 0,
    casts: [], // [target, spell]
    castAt: [], // NOW of each cast
    pend: [],
    subs: [],
    useDone: 0,
    token: null,
    reads: { inv: 0, known: 0 },
    // how ACE answers a cast: "ok" | "silent" (UseDone, no line) | "none"
    // (never) | { refuse: code } | { lineAtMs } (the line that much later)
    answer: () => "ok",
    logs: [],
  };
  const emit = (e) => {
    for (const fn of W.subs) fn({ u32: 0, u32b: 0, text: "", ...e });
  };
  W.emit = emit;
  W.say = (text) => emit({ kind: 2, text });
  const useDone = () => {
    W.useDone++;
    emit({ kind: 14 });
  };
  W.host = {
    IsPlayerReady: () => true,
    IsPortalSpaceActive: () => false,
    GetCurrentCombatMode: () => 8,
    ChangeCombatMode: () => true,
    GetCastBusyState: () => (W.pend.length ? 1 : 0),
    GetBusyState: () => (W.pend.length ? 1 : 0),
    GetPlayerId: () => ME,
    CastSpell(t, s) {
      W.casts.push([t >>> 0, s >>> 0]);
      W.castAt.push(NOW);
      const c = { t: t >>> 0, s: s >>> 0, at: NOW + W.castMs, how: W.answer({ t: t >>> 0, s: s >>> 0 }) };
      if (c.how !== "none") W.pend.push(c);
      return true;
    },
    tryClaimCast(o) {
      if (W.token && W.token.o !== o && W.token.seq === W.useDone) return false;
      W.token = { o, seq: W.useDone };
      return true;
    },
    releaseCast(o) {
      if (W.token && W.token.o === o) W.token = null;
    },
    has: (c) => c === "GetUseDoneSeq",
    GetUseDoneSeq: () => W.useDone,
    TryGetPlayerInventory() {
      W.reads.inv++;
      if (W.inv === null) throw new Error("no inventory yet");
      return W.inv.map((r) => ({ ...r }));
    },
    onEvent(fn) {
      W.subs.push(fn);
    },
    onTick() {},
    s: {
      playerEnchantments: () => W.reg.map((r) => ({ ...r })),
      playerKnownSpells() {
        W.reads.known++;
        return W.known.slice();
      },
      getSpellRecord: (id) => (id === SELF ? { category: 101, roughLevel: 1 } : null),
    },
  };
  W.step = () => {
    for (const c of W.pend.splice(0)) {
      if (c.at > NOW) {
        W.pend.push(c);
        continue;
      }
      const r = RUNG.get(c.s);
      if (c.how === "fizzle") {
        // ACE: the fizzle's WeenieError, then the cast's own UseDone
        emit({ kind: 13, u32: 0x0402 });
        useDone();
        continue;
      }
      if (c.how && c.how.refuse) {
        W.useDone++;
        emit({ kind: 13, u32: c.how.refuse });
        continue;
      }
      if (c.how && c.how.lineAtMs) {
        // a long windup: the line (and the UseDone) come later still
        c.at = NOW + c.how.lineAtMs;
        c.how = "ok";
        W.pend.push(c);
        continue;
      }
      if (!r) {
        // a self buff: a new registry row (re-stamped), its line, the UseDone
        W.reg = W.reg.filter((x) => x.spellId !== c.s).concat([{ spellId: c.s, spellCategory: 101, startTime: -(++W.seq) * 1e-3, duration: 3600, layer: 1 }]);
        W.say(`You cast Spell ${c.s} and feel better.`);
      } else if (c.how === "ok") {
        if (c.t === ME) {
          // ACE: every enchantable equipped Clothing / shield, one line each
          for (const p of W.inv || []) if (p.equipMask && p.itemType & 0x6) W.say(`You cast ${r.name} on ${p.name}, refreshing ${r.name}`);
        } else W.say(`You cast ${r.name} on ${NAME[c.t]}`);
      }
      useDone();
    }
  };
  return W;
}

function rig({ layer = true, values = {}, opts = {}, itemsTab = ITEMS_TAB, self = true, ...world } = {}) {
  const W = makeWorld(world);
  const loop = new RynthBuffLoop(W.host, self ? [SELF] : [], { log: (m) => W.logs.push(m), ...opts });
  loop.startedAt = NOW;
  loop.registryReady = true;
  loop._refresh();
  const vals = { BuffArmorImpen: true, BuffProfileBanes: "ALFCBPS", ...values };
  if (layer) loop.optFn = (k) => vals[k];
  if (itemsTab) loop.setItemBuffs(itemsTab);
  return { W, loop, vals };
}

/** Advance the world in 100 ms steps; every step one loop.tick() (or kernel.tick()). */
function run(r, ms, { kernel = null, each = null } = {}) {
  const end = NOW + ms;
  while (NOW < end) {
    NOW += 100;
    r.W.step();
    if (kernel) kernel.tick();
    else r.loop.tick();
    if (each) each();
  }
}
const castsFrom = (W, i0 = 0) => W.casts.slice(i0).map(([t, s]) => `${t === ME ? "me" : NAME[t]}:${s}`);

// ── the table ──────────────────────────────────────────────────────────────
await check("the worn-armor table is combat_spells.json's impen / bane ladders (ids, tiers, server names), in the Buffs tab's column order", () => {
  const json = JSON.parse(readFileSync(path.join(APP, "rynth/vt/data/combat_spells.json"), "utf8"));
  assert.deepEqual(WORN_ARMOR_FAMILIES.map((f) => f.family), [...lists.ITEM_BUFF_FAMILIES], "the matrix columns");
  for (const f of WORN_ARMOR_FAMILIES) {
    const rows = json.families[f.family].slice().sort((a, b) => a.level - b.level || a.id - b.id);
    assert.deepEqual(f.rungs.map((r) => [r.id, r.tier, r.name]), rows.map((r) => [r.id, r.level, r.name]), f.family);
    assert.ok(rows.every((r) => r.school === 3 && r.untargeted !== true), `${f.family}: Item school, targeted`);
    assert.equal(f.letter, lists.ITEM_BUFF_LETTERS[f.family] ?? null, `${f.family}: the VTank letter`);
  }
  assert.equal(lists.BANE_LETTERS, SCHEMA_BANE_LETTERS, "the bridge's letter order is the schema codec's");
  assert.ok(Object.isFrozen(WORN_ARMOR_FAMILIES) && Object.isFrozen(WORN_ARMOR_FAMILIES[0].rungs));
});

// ── without the layer ──────────────────────────────────────────────────────
await check("no layer (optFn absent): no worn cast, no inventory read, status as before; the Items tab's casts go to their items", () => {
  const r = rig({ layer: false });
  assert.equal(r.loop.optFn, null);
  run(r, 40_000);
  assert.deepEqual(castsFrom(r.W), ["Kite Shield:2108", "Kite Shield:1552", "Tower Shield:2108"], "B7 as before (the worn shield too)");
  assert.equal(r.W.reads.inv, 0, "no inventory read");
  const st = r.loop.status;
  assert.equal(st.desired, 1, "status: the self buffs only");
  assert.equal(st.active, 1);
  assert.equal(st.itemBuffs, 3);
  assert.equal(r.loop.needsBuff(), false);
  assert.ok(!r.W.logs.some((m) => /worn armor/.test(m)));
});

// ── with the layer ─────────────────────────────────────────────────────────
await check("layer: after the self buffs, one cast per family at our own guid, best known tier, column order; the worn shield's Items-tab casts dropped, the pack shield's kept", () => {
  const r = rig({ self: true });
  r.W.reg = []; // the self buff is down: it goes first (step 7 comes after)
  r.loop._refresh();
  run(r, 60_000);
  assert.deepEqual(castsFrom(r.W), ["me:1011", ...BEST.map((id) => `me:${id}`), "Tower Shield:2108"]);
  assert.equal(r.W.casts.filter(([t]) => t === KITE).length, 0, "never at the worn Kite Shield");
  const keys = [...r.loop._itemLastCast.keys()];
  assert.deepEqual(keys, [...BEST.map((id) => `${id}:${ME}`), `2108:${TOWER}`], "each confirmed by its line");
  const st = r.loop.status;
  assert.deepEqual([st.desired, st.active], [1 + 8 + 1, 1 + 8 + 1], "status counts the item enchants");
  assert.equal(r.loop.needsBuff(), false);
  assert.ok(r.W.logs.some((m) => /^worn armor: Brogard's Defiance, Incantation of Blade Bane, Piercing Bane I, .*Acid Bane VI — 3 worn piece/.test(m)), r.W.logs.join("\n"));
  run(r, 60_000);
  assert.equal(r.W.casts.length, 10, "fresh: nothing recast");
});

await check("layer: the options switch families (Imp off, banes BPS ⇒ the worn shield's own Impenetrability and Flame Bane go to it); None and off ⇒ no worn casts", () => {
  const r = rig({ values: { BuffArmorImpen: false, BuffProfileBanes: "BPS" } });
  run(r, 40_000);
  assert.deepEqual(castsFrom(r.W), ["me:4393", "me:1569", "me:1516", "Kite Shield:2108", "Kite Shield:1552", "Tower Shield:2108"]);
  // switched off at runtime: the worn casts leave the pass and the status at once
  r.vals.BuffProfileBanes = "";
  const st = r.loop.status;
  assert.deepEqual([st.desired, st.active], [1 + 3, 1 + 3], "the Items tab's three only");
  const r2 = rig({ values: { BuffArmorImpen: false, BuffProfileBanes: "" }, itemsTab: [] });
  run(r2, 20_000);
  assert.deepEqual(r2.W.casts, []);
  assert.equal(r2.W.reads.inv, 0, "nothing chosen: not even an inventory read");
  assert.deepEqual([r2.loop.status.desired, r2.loop.status.active], [1, 1]);
});

await check("layer: nothing enchantable worn (or no inventory, or no item spell known) ⇒ no worn cast", () => {
  const bare = INV().filter((p) => p.guid === WAND || p.guid === RING || p.guid === TOWER);
  const r = rig({ inv: bare, itemsTab: [] });
  run(r, 20_000);
  assert.deepEqual(r.W.casts, [], "ring + wand only: ACE would enchant nothing");
  assert.deepEqual([r.loop.status.desired, r.loop.status.active], [1, 1]);
  const r2 = rig({ inv: null, itemsTab: [] });
  run(r2, 20_000);
  assert.deepEqual(r2.W.casts, [], "unreadable inventory");
  const r3 = rig({ known: [SELF], itemsTab: [] });
  run(r3, 20_000);
  assert.deepEqual(r3.W.casts, [], "no Impenetrability / bane in the spellbook");
  assert.equal(r3.W.reads.inv, 0, "and no inventory read for it");
});

await check("layer: a worn cast is confirmed only by its own spell's line (not a debuff's, not another bane's)", () => {
  const r = rig({ itemsTab: [] });
  r.W.answer = () => "none";
  run(r, 300);
  assert.deepEqual(castsFrom(r.W), ["me:2108"]);
  const p = r.loop._itemPending;
  assert.ok(p && p.worn && p.spellName === "Brogard's Defiance" && p.itemGuid === ME);
  r.W.say("You cast Imperil Other VI on Drudge Slinker");
  r.W.say("You cast Olthoi's Bane on Leather Coat");
  r.W.say("You cast Brogard's Defiance and feel protected");
  assert.equal(r.loop._itemPending, p, "still pending");
  r.W.say("You cast Brogard's Defiance on Kite Shield, but it is surpassed by Incantation of Impenetrability");
  assert.equal(r.loop._itemPending, null, "its line (any outcome suffix) confirms");
  assert.ok(r.loop._itemLastCast.has(`2108:${ME}`));
  assert.equal(r.W.token, null, "cast token released");
});

// ── the kernel gate ────────────────────────────────────────────────────────
await check("kernel: every self buff up and the worn casts due ⇒ the real kernel ticks Buffing until they land, then Idle (without the layer it stays Idle)", () => {
  const r = rig({ itemsTab: [] });
  const kernel = new RynthBotKernel(r.W.host, { combat: null, buff: r.loop, loot: null, vitals: null, unwedge: null }, { log: quiet });
  const seen = new Set();
  run(r, 50_000, { kernel, each: () => seen.add(kernel.action) });
  assert.ok(seen.has("Buffing"), [...seen].join(","));
  assert.deepEqual(castsFrom(r.W), BEST.map((id) => `me:${id}`));
  assert.equal(kernel.action, "Idle", "all landed: back to Idle");
  assert.deepEqual([kernel.status.buffs.desired, kernel.status.buffs.active], [9, 9]);
  // the layer's absence: today's gate — B7 never gets the tick here
  const r0 = rig({ layer: false });
  const k0 = new RynthBotKernel(r0.W.host, { combat: null, buff: r0.loop, loot: null, vitals: null, unwedge: null }, { log: quiet });
  const seen0 = new Set();
  run(r0, 20_000, { kernel: k0, each: () => seen0.add(k0.action) });
  assert.deepEqual([...seen0], ["Idle"]);
  assert.deepEqual(r0.W.casts, []);
});

// ── holds, long casts, the tier walk ───────────────────────────────────────
await check("layer: a cast that enchanted nothing (UseDone, no line) is held 60 s, then noShowCooldownMs; the held entry does not keep the kernel on Buffing", () => {
  const r = rig({ itemsTab: [], opts: { noShowCooldownMs: 5 * 60_000 } });
  r.W.answer = ({ s }) => (s === 2108 ? "silent" : "ok");
  run(r, 40_000);
  assert.deepEqual(castsFrom(r.W), BEST.map((id) => `me:${id}`), "the others go on");
  assert.ok(r.W.logs.some((m) => /^item enchant 2108 on worn armor enchanted nothing — held 60 s$/.test(m)), r.W.logs.join("\n"));
  assert.deepEqual([r.loop.status.desired, r.loop.status.active], [9, 9], "held = not due");
  run(r, 15_000);
  assert.equal(r.W.casts.length, 8, "not before the minute is up");
  run(r, 15_000);
  assert.deepEqual(castsFrom(r.W, 8), ["me:2108"], "retried once");
  assert.ok(r.W.logs.some((m) => /^item enchant 2108 on worn armor enchanted nothing — held 300 s$/.test(m)), "silent twice: noShowCooldownMs");
  r.W.answer = () => "ok";
  run(r, 4 * 60_000);
  assert.equal(r.W.casts.length, 9, "parked");
  run(r, 70_000);
  assert.deepEqual(castsFrom(r.W, 9), ["me:2108"]);
  assert.ok(r.loop._itemLastCast.has(`2108:${ME}`) && !r.loop._itemSilent.has(`2108:${ME}`), "confirmed: the strikes reset");
});

await check("layer: a long windup's line (7 s) still confirms — resolution waits for ACE's UseDone, not 5 s", () => {
  const r = rig({ itemsTab: [], values: { BuffArmorImpen: true, BuffProfileBanes: "" } });
  r.W.answer = () => ({ lineAtMs: 4000 }); // the line and the UseDone 7 s after the send
  run(r, 12_000);
  assert.deepEqual(castsFrom(r.W), ["me:2108"]);
  assert.ok(r.loop._itemLastCast.has(`2108:${ME}`), "confirmed");
  assert.ok(!r.W.logs.some((m) => /no-chat timeout|enchanted nothing|no answer/.test(m)), r.W.logs.join("\n"));
  // no answer at all: the 12 s hard cap holds it (a stalled page is not a recast storm)
  const r2 = rig({ itemsTab: [], values: { BuffArmorImpen: true, BuffProfileBanes: "" } });
  r2.W.answer = () => "none";
  run(r2, 20_000);
  assert.equal(r2.W.casts.length, 1);
  assert.ok(r2.W.logs.some((m) => /^item enchant 2108 on worn armor had no answer in 12 s — held 60 s$/.test(m)), r2.W.logs.join("\n"));
});

await check("layer: a worn rung ACE refuses as not in the spellbook walks its family a tier down; a fizzle is retried", () => {
  const r = rig({ itemsTab: [], values: { BuffArmorImpen: true, BuffProfileBanes: "" } });
  let fizzled = false;
  r.W.answer = ({ s }) => {
    if (s === 2108) return { refuse: 0x03fc }; // MagicInvalidSpellType
    if (s === 1486 && !fizzled) return (fizzled = true), { refuse: 0x0402 }; // one fizzle
    return "ok";
  };
  run(r, 20_000);
  assert.deepEqual(castsFrom(r.W), ["me:2108", "me:1486", "me:1486"]);
  assert.ok(r.loop._itemLastCast.has(`1486:${ME}`));
  assert.equal(r.loop.lastRefusal.cls, "fizzle");
});

await check("layer: 3 fizzles in a row hold a worn cast 10 min and step its family a tier down meanwhile; the held cast is not due; then the top tier is back", () => {
  const r = rig({ itemsTab: [], values: { BuffArmorImpen: true, BuffProfileBanes: "" } });
  r.W.answer = ({ s }) => (s === 2108 && !r.ok2108 ? "fizzle" : "ok");
  run(r, 25_000);
  assert.deepEqual(castsFrom(r.W), ["me:2108", "me:2108", "me:2108", "me:1486"], "fizzle, fizzle, fizzle, then Impenetrability VI");
  assert.ok(r.W.logs.includes("item enchant 2108 fizzled 3x in a row — held 10 min"), r.W.logs.join("\n"));
  assert.ok(r.loop._itemLastCast.has(`1486:${ME}`));
  const st = r.loop.status;
  assert.deepEqual([st.desired, st.active], [2, 2], "nothing due: the kernel can leave Buffing");
  assert.equal(r.loop.needsBuff(), false);
  run(r, 9 * 60_000);
  assert.equal(r.W.casts.length, 4, "held for the window");
  r.ok2108 = true;
  run(r, 70_000);
  assert.deepEqual(castsFrom(r.W, 4), ["me:2108"], "the walk expired: Brogard's Defiance again");
  assert.ok(r.loop._itemLastCast.has(`2108:${ME}`) && !r.loop._itemFizzles.has(`2108:${ME}`));
  // with no tier below it known, the family keeps its rung, held — no recast storm
  const r2 = rig({ itemsTab: [], known: [SELF, 2108], values: { BuffArmorImpen: true, BuffProfileBanes: "" } });
  r2.W.answer = () => "fizzle";
  run(r2, 25_000);
  assert.deepEqual(castsFrom(r2.W), ["me:2108", "me:2108", "me:2108"]);
  assert.deepEqual([r2.loop.status.desired, r2.loop.status.active], [2, 2], "held = not due");
  run(r2, 9 * 60_000);
  assert.equal(r2.W.casts.length, 3);
});

await check("layer: an Items-tab cast is held after 3 fizzles in a row (no walk); fizzles 1-2 and a landing in between reset nothing early", () => {
  const r = rig({ itemsTab: [{ spellId: 2108, itemGuid: TOWER, itemName: NAME[TOWER] }], values: { BuffArmorImpen: false, BuffProfileBanes: "" } });
  let n = 0;
  r.W.answer = () => (++n === 3 ? "ok" : "fizzle"); // fizzle, fizzle, land …
  run(r, 15_000);
  assert.deepEqual(castsFrom(r.W), ["Tower Shield:2108", "Tower Shield:2108", "Tower Shield:2108"]);
  assert.ok(r.loop._itemLastCast.has(`2108:${TOWER}`) && !r.loop._itemFizzles.has(`2108:${TOWER}`), "the landing resets the count");
  r.W.answer = ({ t }) => (t === TOWER ? "fizzle" : "ok");
  r.loop.forceRebuff(); // the self buff, then three shield fizzles in a row
  run(r, 25_000);
  assert.deepEqual(castsFrom(r.W, 3), ["me:1011", "Tower Shield:2108", "Tower Shield:2108", "Tower Shield:2108"]);
  assert.ok(r.loop._itemHeldUntil.get(`2108:${TOWER}`) > NOW + 9 * 60_000, "held 10 min");
  assert.equal(r.loop._wornWalkedUntil.size, 0, "an Items-tab cast walks no worn family");
  run(r, 5 * 60_000);
  assert.equal(r.W.casts.length, 7, "held");
});

await check("layer: a busy / in-the-air refusal backs off 1 s (TRANSIENT_BACKOFF_MS); without the layer item fizzles and busy refusals retry at once, as before", () => {
  const r = rig({ itemsTab: [], values: { BuffArmorImpen: true, BuffProfileBanes: "" } });
  let first = true;
  r.W.answer = () => (first ? ((first = false), { refuse: 0x001d }) : "ok"); // YoureTooBusy
  run(r, 10_000);
  assert.deepEqual(castsFrom(r.W), ["me:2108", "me:2108"]);
  const refusedAt = r.W.castAt[0] + r.W.castMs;
  assert.ok(r.W.castAt[1] - refusedAt >= 1000, `retried ${r.W.castAt[1] - refusedAt} ms after the refusal`);
  // no layer: today's B7 (the goldens pin it)
  const r0 = rig({ layer: false, itemsTab: [{ spellId: 2108, itemGuid: TOWER, itemName: NAME[TOWER] }] });
  let k = 0;
  r0.W.answer = () => (++k <= 3 ? "fizzle" : k === 4 ? { refuse: 0x001d } : "ok");
  run(r0, 20_000);
  assert.deepEqual(castsFrom(r0.W), Array(5).fill("Tower Shield:2108"), "fizzle ×3 and a busy refusal: each retried");
  assert.ok(r0.W.castAt[4] - (r0.W.castAt[3] + r0.W.castMs) < 1000, "no backoff");
  assert.equal(r0.loop._itemHeldUntil.size + r0.loop._itemFizzles.size, 0);
});

await check("a bane profile stored before the codec reads as the codec reads it: the loop's and the bridge's baneLetters = the schema's; unreadable ⇒ every bane", () => {
  const inputs = [
    null, undefined, {}, [], true, false, "", "  ", "none", "NONE", "None ", "All", "all", " ALL ",
    "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "2.0", "2.5", "+5", "-5", "0x5", "0X8", "-0x2", "1e0", "5e0",
    "abc", "Banes1", "ALFCBPS", "s, a", "b p s", "SPB", "a+l+f", "c;b", "xyz", "AX",
    2, 5, 8, 1, 9, 2.5, NaN, Infinity,
  ];
  for (const v of inputs) {
    const want = schemaBaneLetters(v);
    assert.equal(loopBaneLetters(v), want, `buff_loop.js baneLetters(${JSON.stringify(v)})`);
    assert.equal(lists.baneLetters(v), want, `bridge_lists.js baneLetters(${JSON.stringify(v)})`);
  }
  // the loop: which worn families a stored value asks for
  const r = rig({ itemsTab: [] });
  const fams = (banes) => {
    r.vals.BuffProfileBanes = banes;
    NOW += 1;
    return r.loop._wornArmor(NOW).entries.map((e) => e.family.replace("bane:", ""));
  };
  const all = ["impen", "slash", "pierce", "bludgeon", "fire", "cold", "lightning", "acid"];
  assert.deepEqual(fams("Banes1"), all, "free text: every bane (the default), not A+B+S");
  assert.deepEqual(fams("All"), all, "not A+L");
  assert.deepEqual(fams("2"), all, "VTank 2 = All, not none");
  assert.deepEqual(fams("5"), ["impen", "slash", "pierce", "bludgeon"], "VTank 5 = BPS");
  assert.deepEqual(fams("None"), ["impen"]);
  assert.deepEqual(fams("s, a"), ["impen", "slash", "acid"]);
  // the bridge's Worn armor row
  const view = (banes) => lists.wornArmorView({ getValue: (k) => ({ BuffArmorImpen: true, BuffProfileBanes: banes })[k] }).letters;
  assert.deepEqual(["Banes1", "All", "2", "5", "None", "s, a", undefined].map(view), ["ALFCBPS", "ALFCBPS", "ALFCBPS", "BPS", "", "AS", ""]);
});

// ── Force Buff and the rebuff windows ──────────────────────────────────────
await check("layer: Force Buff recasts the item enchants once (after the self buff); Cancel stops the rest", () => {
  const r = rig();
  run(r, 40_000);
  assert.equal(r.W.casts.length, 9);
  r.loop.forceRebuff();
  run(r, 50_000);
  assert.deepEqual(castsFrom(r.W, 9), ["me:1011", ...BEST.map((id) => `me:${id}`), "Tower Shield:2108"]);
  run(r, 30_000);
  assert.equal(r.W.casts.length, 19, "once each");
  r.loop.forceRebuff();
  run(r, 5_000); // the self buff landed, the first worn cast in flight
  r.loop.cancelForceRebuff();
  run(r, 30_000);
  assert.deepEqual(castsFrom(r.W, 19), ["me:1011", "me:2108"], "the in-flight cast lands; nothing after Cancel");
});

await check("layer: the recast point — 25 min at the defaults; RebuffSecondsRemaining 600 ⇒ 20 min; 1800 ⇒ half the 30 min span; the idle window ⇒ earlier (needsBuff)", () => {
  const due = (r, min) => {
    const t = NOW;
    NOW = r.t0 + min * 60_000;
    try {
      const st = r.loop.status;
      return st.active < st.desired;
    } finally {
      NOW = t;
    }
  };
  const r = rig({ itemsTab: [], values: { BuffArmorImpen: true, BuffProfileBanes: "" } });
  run(r, 8000);
  r.t0 = r.loop._itemLastCast.get(`2108:${ME}`);
  assert.ok(r.t0 > 0);
  assert.deepEqual([due(r, 24.9), due(r, 25)], [false, true], "defaults: itemRecastMs (25 min)");
  r.loop.rebuffSecondsRemaining = 600;
  assert.deepEqual([due(r, 19.9), due(r, 20)], [false, true]);
  r.loop.rebuffSecondsRemaining = 1800;
  assert.deepEqual([due(r, 14.9), due(r, 15)], [false, true], "never before half the span");
  r.loop.rebuffSecondsRemaining = 300;
  const t = NOW;
  NOW = r.t0 + 14.9 * 60_000;
  assert.equal(r.loop.needsBuff({ extraWindowS: 600 }), false);
  NOW = r.t0 + 15 * 60_000;
  assert.equal(r.loop.needsBuff(), false, "window 0: not yet");
  assert.equal(r.loop.needsBuff({ extraWindowS: 600 }), true, "RebuffWhenIdle's window brings it forward");
  NOW = t;
  // without the layer the threshold doesn't move B7's interval
  const r0 = rig({ layer: false, itemsTab: [{ spellId: 2108, itemGuid: TOWER, itemName: NAME[TOWER] }] });
  run(r0, 8000);
  const t0 = r0.loop._itemLastCast.get(`2108:${TOWER}`);
  r0.loop.rebuffSecondsRemaining = 600;
  assert.equal(r0.loop._itemDue({ spellId: 2108, itemGuid: TOWER }, t0 + 20 * 60_000), false);
  assert.equal(r0.loop._itemDue({ spellId: 2108, itemGuid: TOWER }, t0 + 25 * 60_000), true);
});

// ── the bridge view ────────────────────────────────────────────────────────
function spyStorage() {
  const m = new Map();
  return {
    get length() {
      return m.size;
    },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}
function realOptions() {
  const profiles = new S.ProfileStore({ storage: spyStorage(), scope: "1001", charName: "Tester", now: () => NOW, log: quiet });
  const options = S.createVtOptions({ profiles, now: () => NOW, log: quiet });
  const sets = [];
  const set = options.set.bind(options);
  options.set = (k, v, o) => (sets.push([k, v]), set(k, v, o));
  return { options, sets };
}
function bridgeWorld({ options = realOptions().options, items = [], inv = INV() } = {}) {
  const vt = {
    options,
    session: { options },
    items: {
      list: () => items.map((e) => ({ ...e })),
      find: (g) => items.find((e) => e.guid === g) || null,
      resolveGuid: (e) => e.guid,
    },
  };
  const bot = {
    vt,
    host: { TryGetPlayerInventory: () => inv.map((r) => ({ ...r })), TryGetKnownSpells: () => KNOWN, TryGetSpellRecord: () => null },
    kernel: { operatorHeld: false },
    buff: { forceRebuff() {}, cancelForceRebuff() {} },
  };
  const win = { __bot: bot };
  const bridge = createVtBridge({ win, importer: async () => ({ buildDynamicBuffList: () => [], loadSpellLadders: async () => ({}) }) });
  return { bridge, bot, vt, options, win };
}
const SHIELDS = [
  { guid: KITE, name: NAME[KITE], wcid: 1, kind: "shield", element: null, noBuffs: false },
  { guid: TOWER, name: NAME[TOWER], wcid: 2, kind: "shield", element: null, noBuffs: false },
];

await check("bridge: the Buffs tab view's wornArmor reads BuffArmorImpen and the BuffProfileBanes letters (real VtOptions, VTank 5 = BPS)", () => {
  const { options } = realOptions();
  const { bridge } = bridgeWorld({ options });
  let w = bridge.snapshot("buffs").view.wornArmor;
  assert.equal(w.available, true);
  assert.equal(w.impen, true, "VTank / RynthAi default");
  assert.equal(w.letters, "ALFCBPS");
  assert.equal(w.order, "ALFCBPS");
  assert.deepEqual(w.families.map((f) => [f.family, f.letter, f.on]), [
    ["impen", null, true], ["bane:slash", "S", true], ["bane:pierce", "P", true], ["bane:bludgeon", "B", true],
    ["bane:fire", "F", true], ["bane:cold", "C", true], ["bane:lightning", "L", true], ["bane:acid", "A", true],
  ]);
  assert.equal(w.families[4].label, "Flame Bane");
  assert.equal(options.set("BuffProfile_Banes", 5).ok, true);
  assert.equal(options.set("BuffArmorImpen", false).ok, true);
  w = bridge.snapshot("buffs").view.wornArmor;
  assert.equal(w.letters, "BPS");
  assert.deepEqual(w.families.filter((f) => f.on).map((f) => f.family), ["bane:slash", "bane:pierce", "bane:bludgeon"]);
  // no settings yet: the row shows, off and not editable
  const none = lists.wornArmorView(null);
  assert.deepEqual([none.available, none.impen, none.letters, none.families.some((f) => f.on)], [false, false, "", false]);
});

await check("bridge: an Items-tab shield worn now is `equipped`, its families the Worn armor row covers marked `worn`; the pack shield not", () => {
  const { options } = realOptions();
  options.set("BuffProfileBanes", "F");
  options.set("BuffArmorImpen", false);
  const { bridge } = bridgeWorld({ options, items: SHIELDS });
  const v = bridge.snapshot("buffs").view;
  const kite = v.items.find((x) => x.guid === KITE);
  const tower = v.items.find((x) => x.guid === TOWER);
  assert.equal(kite.equipped, true);
  assert.deepEqual(kite.families.filter((f) => f.worn).map((f) => f.family), ["bane:fire"]);
  assert.equal(tower.equipped, false);
  assert.equal(tower.families.some((f) => f.worn), false);
  assert.equal(kite.families.filter((f) => f.on).length, 8, "its own boxes are unchanged");
});

// ── the tab (fake DOM, real bridge, real VtOptions) ────────────────────────
function mountTab(w) {
  const reports = [];
  let tab = null;
  const ctx = {
    doc: document,
    bridge: w.bridge,
    report: (r) => reports.push(r),
    refresh: ({ force = false } = {}) => tab.update(w.bridge.snapshot("buffs"), { force }),
    pref: () => undefined,
  };
  tab = createBuffsTab(ctx);
  document.body.appendChild(tab.el);
  tab.update(w.bridge.snapshot("buffs"), { force: true });
  return { tab, reports, el: tab.el };
}
const change = (el, checked) => {
  el.checked = checked;
  el.dispatchEvent(new FakeEvent("change"));
};

await check("tab: 'Worn armor' is the matrix's first row — its boxes in the column order, a tooltip saying the server puts them on every worn armor and clothing piece", () => {
  const w = bridgeWorld({ items: SHIELDS });
  const { el } = mountTab(w);
  const rows = el.querySelectorAll("table.rvt-ibm tr");
  assert.equal(rows.length, 4, "header, Worn armor, two shields");
  assert.ok(rows[1].classList.contains("rvt-wornarmor"), "first data row");
  assert.equal(rows[1].querySelector("td.rvt-name").textContent, "Worn armor");
  assert.match(rows[1].querySelector("td.rvt-name").title, /every armor and clothing piece you wear/);
  const boxes = rows[1].querySelectorAll("input[data-worn]");
  assert.deepEqual(boxes.map((b) => b.dataset.worn), [...lists.ITEM_BUFF_FAMILIES]);
  assert.ok(boxes.every((b) => b.type === "checkbox" && b.checked && !b.disabled && b.classList.contains("hbk-check")));
  assert.equal(boxes[0].getAttribute("aria-label"), "Worn armor: Impenetrability");
  assert.equal(boxes[4].getAttribute("aria-label"), "Worn armor: Flame Bane");
  assert.match(boxes[4].title, /Flame Bane on every armor and clothing piece you wear \(bane letter F\)/);
  // the Items-tab rows keep their own class and boxes (the worn row is not one of them)
  assert.equal(el.querySelectorAll(".rvt-itembuff").length, 2);
  assert.equal(el.querySelectorAll("input[data-family]").length, 16);
  const kite = el.querySelector(`tr.rvt-itembuff[data-guid='${KITE}']`);
  assert.ok(kite.querySelectorAll("td.is-worn").length === 8, "the worn Kite Shield: covered by the Worn armor row");
  assert.match(kite.querySelector("input[data-family='impen']").title, /worn now: the Worn armor row casts it/);
  assert.equal(el.querySelector(`tr.rvt-itembuff[data-guid='${TOWER}']`).querySelectorAll("td.is-worn").length, 0);
  el.remove();
});

await check("tab: a bane box writes the whole BuffProfileBanes string in VTank's order, Imp writes BuffArmorImpen; the row redraws from the options", async () => {
  const { options, sets } = realOptions();
  const w = bridgeWorld({ options, items: SHIELDS });
  const { el, reports } = mountTab(w);
  const box = (fam) => el.querySelector(`tr.rvt-wornarmor input[data-worn='${fam}']`);
  change(box("bane:fire"), false);
  await flush();
  assert.deepEqual(sets.at(-1), ["BuffProfileBanes", "ALCBPS"]);
  assert.equal(options.getValue("BuffProfileBanes"), "ALCBPS");
  assert.equal(box("bane:fire").checked, false);
  change(box("impen"), false);
  await flush();
  assert.deepEqual(sets.at(-1), ["BuffArmorImpen", false]);
  assert.equal(options.getValue("BuffArmorImpen"), false);
  for (const f of ["bane:acid", "bane:lightning", "bane:cold", "bane:bludgeon", "bane:pierce", "bane:slash"]) {
    change(box(f), false);
    await flush();
  }
  assert.equal(options.getValue("BuffProfileBanes"), "", "all off = None");
  change(box("bane:slash"), true);
  await flush();
  change(box("bane:acid"), true);
  await flush();
  assert.deepEqual(sets.at(-1), ["BuffProfileBanes", "AS"], "canonical order, not click order");
  assert.ok(reports.every((x) => x.ok), JSON.stringify(reports.filter((x) => !x.ok)));
  assert.match(reports.at(-1).echo, /BuffProfileBanes = AS/);
  // the Kite Shield's covered families follow the row
  const covered = el.querySelector(`tr.rvt-itembuff[data-guid='${KITE}']`).querySelectorAll("td.is-worn");
  assert.equal(covered.length, 2, "Blade + Acid");
  el.remove();
});

await check("tab: no Items-tab weapons or shields ⇒ the Worn armor row and the empty hint; no settings ⇒ its boxes disabled", () => {
  const w = bridgeWorld({ items: [] });
  const { el } = mountTab(w);
  assert.equal(el.querySelectorAll("tr.rvt-wornarmor").length, 1);
  assert.equal(el.querySelectorAll(".rvt-itembuff").length, 0);
  assert.match(el.querySelector(".rvt-itembuffs .rvt-empty").textContent, /No weapons or shields on the Items tab/);
  el.remove();
  const w2 = bridgeWorld({ items: [] });
  w2.bot.vt = null; // no layer and no page session: no options
  const t2 = mountTab(w2);
  const boxes = t2.el.querySelectorAll("tr.rvt-wornarmor input[data-worn]");
  assert.equal(boxes.length, 8);
  assert.ok(boxes.every((b) => b.disabled && !b.checked));
  t2.el.remove();
});

Date.now = REAL_NOW;
console.log(fail === 0 ? `rynth_buff_worn_armor: all ${pass} checks passed` : `rynth_buff_worn_armor: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);

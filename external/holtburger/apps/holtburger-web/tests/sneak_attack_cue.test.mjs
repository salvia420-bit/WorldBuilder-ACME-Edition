// tests/sneak_attack_cue.test.mjs — 2026-10-18. Owner: "i see a sneak attack
// popup occur which should be moved into the combat HUD."
//
// Retail has no Sneak Attack popup. acclient.c only prefixes the hit line
// ("Sneak Attack! " on AttackConditions bit 4, HandleAttackerNotificationEvent
// :408415 / HandleDefenderNotificationEvent :409683). The floating
// plugins/sneak-hud.js plaque is retired; the cue now lives inside the combat
// panels (ui/ac_sneak_attack_cue.js):
//
//   [1] predicates: AttackConditions bit 0x4; ACE's Magic hit line
//       (SpellProjectile.cs:805 "[Critical hit! ][Overpower! ]Sneak Attack!
//       You …"); the nominal +10 / +20.
//   [2] the state machine on a fake clock: a swing predicted from behind is
//       dim, the server's sneak hit makes it bright, a plain hit turns it off,
//       an evade drops only the prediction, and the cue expires on its own.
//   [3] mountSneakCue, feed "attack", on a CustomEvent bus built like
//       plugins/api.js (handlers get `ev.detail`).
//   [4] mountSneakCue, feed "magic", on the REAL plugins/chat-hooks.js bus.
//   [5] the REAL plugins/combat-hud.js (spliced, fake DOM): row 2 carries the
//       cue right after "Recklessness", the lazy import wires it, and a
//       damageDealt with bit 0x4 lights it. Teardown unhooks it.
//   [6] source pins: sneak-hud retired (files, dock skip lists, bar order);
//       the spell strip's twin is loaded lazily with the magic feed.
//
// Run from apps/holtburger-web/:  node tests/sneak_attack_cue.test.mjs

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installFakeDom } from "./helpers/fake_dom_items.mjs";
import { spliceModule, importedNames } from "../harness/lib/splice_module.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const src = (rel) => readFileSync(path.join(APP, rel), "utf8");

globalThis.window = globalThis;
const { document } = installFakeDom(globalThis);

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err.stack || err.message}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(10);
  }
  return pred();
}

const CUE = await import("../ui/ac_sneak_attack_cue.js");
const {
  ATTACK_CONDITION_SNEAK_ATTACK, CHAT_TYPE_MAGIC, SNEAK_HIT_HOLD_MS, SNEAK_BEHIND_HOLD_MS,
  SNEAK_BEHIND_MISSILE_HOLD_MS,
  hasSneakAttackBit, isMagicSneakAttackLine, sneakAttackBonus, sneakCueText,
  createSneakCue, paintSneakCue, mountSneakCue,
} = CUE;

/** Deterministic timers: advance() runs every due timer in deadline order. */
function fakeClock() {
  let t = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++nextId; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let due = null;
        for (const [id, v] of timers) if (v.at <= end && (!due || v.at < due[1].at)) due = [id, v];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    },
    pending: () => timers.size,
  };
}

/** A plugin-client events bus shaped like plugins/api.js (EventTarget +
 *  CustomEvent{detail}), counting live listeners per event name. */
function makeClient() {
  const bus = new EventTarget();
  const live = new Map();
  return {
    live: (n) => live.get(n) ?? 0,
    events: {
      on(name, fn) { bus.addEventListener(name, fn); live.set(name, (live.get(name) ?? 0) + 1); },
      off(name, fn) { bus.removeEventListener(name, fn); live.set(name, Math.max(0, (live.get(name) ?? 0) - 1)); },
      emit(name, payload) { bus.dispatchEvent(new CustomEvent(name, { detail: payload })); },
    },
  };
}

console.log("\n[1] predicates");

await check("AttackConditions bit 0x4 is the Sneak Attack bit (ACE enum + acclient.c `& 4`)", () => {
  assert.equal(ATTACK_CONDITION_SNEAK_ATTACK, 0x4);
  for (const v of [0x4, 0x5, 0x6, 0x7, 0xC, 4n, "4"]) assert.equal(hasSneakAttackBit(v), true, `0x${v.toString(16)}`);
  // CriticalProtectionAugmentation 0x1, Recklessness 0x2, Overpower 0x8, nothing.
  for (const v of [0, 0x1, 0x2, 0x3, 0x8, 0x9, 0xA, 2n, null, undefined, NaN, "x", -4]) {
    assert.equal(hasSneakAttackBit(v), false, String(v));
  }
});

await check("ACE's own-spell Sneak Attack line (Magic chat type) is recognised", () => {
  assert.equal(CHAT_TYPE_MAGIC, 0x07);
  for (const line of [
    "Sneak Attack! You blast Drudge Skulker for 54 points with Lightning Bolt III.",
    "Critical hit! Sneak Attack! You incinerate Drudge Skulker for 140 points with Flame Bolt VI.",
    "Critical hit! Overpower! Sneak Attack! You eradicate Shadow for 99 points with Nether Bolt V.",
    "Overpower! Sneak Attack! You scar Shadow for 12 points with Nether Bolt I. Your critical hit was avoided with their augmentation!",
  ]) assert.equal(isMagicSneakAttackLine(line, CHAT_TYPE_MAGIC), true, line);
  // Not the caster's own sneak line, or not a Magic-type line.
  for (const [line, type] of [
    ["You blast Drudge Skulker for 54 points with Lightning Bolt III.", 7],
    ["Sneak Attack! Drudge Skulker blasts you for 12 points with Lightning Bolt III.", 7],
    ["Sneak Attack! You blast Drudge Skulker for 54 points with Lightning Bolt III.", 0x16],
    ["Sneak Attack! You blast Drudge Skulker for 54 points with Lightning Bolt III.", 0],
    // Our melee line (two spaces after "Critical hit!"; chat type 0) never qualifies.
    ["Critical hit!  Sneak Attack! You impale Drudge for 37 points of piercing damage!", 7],
    ["With Drain Stamina III you drain 20 points of stamina from Drudge.", 7],
    [null, 7],
  ]) assert.equal(isMagicSneakAttackLine(line, type), false, `${line} / ${type}`);
});

await check("nominal Sneak Attack damage rating: +20 specialized, +10 trained, else none", () => {
  assert.equal(sneakAttackBonus(3), 20);
  assert.equal(sneakAttackBonus(2), 10);
  for (const t of [1, 0, null, undefined]) assert.equal(sneakAttackBonus(t), 0);
  assert.equal(sneakCueText(10), "Sneak Attack +10");
  assert.equal(sneakCueText(20), "Sneak Attack +20");
  assert.equal(sneakCueText(0), "Sneak Attack");
});

console.log("\n[2] state machine (fake clock)");

await check("prediction dims, the server's sneak hit brightens, then it fades", () => {
  const c = fakeClock();
  const cue = createSneakCue(c);
  const seen = [];
  cue.subscribe((s) => seen.push(s.mode));
  assert.equal(cue.get().mode, "off");
  cue.behind();
  assert.equal(cue.get().mode, "behind");
  c.advance(700);
  cue.hit();
  assert.deepEqual(cue.get(), { mode: "hit", critical: false, flashes: 1 });
  c.advance(SNEAK_HIT_HOLD_MS - 1);
  assert.equal(cue.get().mode, "hit");
  c.advance(1);
  assert.equal(cue.get().mode, "off", "expires after SNEAK_HIT_HOLD_MS");
  assert.deepEqual(seen, ["behind", "hit", "off"]);
  assert.equal(c.pending(), 0, "no timer left armed");
});

await check("an unanswered prediction fades after SNEAK_BEHIND_HOLD_MS", () => {
  const c = fakeClock();
  const cue = createSneakCue(c);
  cue.behind();
  c.advance(SNEAK_BEHIND_HOLD_MS - 1);
  assert.equal(cue.get().mode, "behind");
  c.advance(1);
  assert.equal(cue.get().mode, "off");
  assert.equal(c.pending(), 0);
});

await check("a plain hit (no bit) turns it off; an evade drops only the prediction", () => {
  const c = fakeClock();
  const cue = createSneakCue(c);
  cue.behind();
  cue.plainHit();
  assert.equal(cue.get().mode, "off", "plain hit ends the dim cue");
  cue.hit();
  cue.plainHit();
  assert.equal(cue.get().mode, "off", "plain hit ends the bright cue");
  cue.behind();
  cue.missed();
  assert.equal(cue.get().mode, "off", "evade drops the dim cue");
  cue.hit();
  cue.missed();
  assert.equal(cue.get().mode, "hit", "an evade does not unlight a confirmed sneak hit");
  assert.equal(c.pending(), 1);
});

await check("a prediction never dims a bright cue; the next one shows once the bright one ends", () => {
  const c = fakeClock();
  const cue = createSneakCue(c);
  cue.hit();                       // t=0, bright until 2500
  c.advance(1000);
  cue.behind();                    // t=1000, pending until 3000
  assert.equal(cue.get().mode, "hit");
  c.advance(1500);                 // t=2500
  assert.equal(cue.get().mode, "behind", "bright ran out, the newer prediction is still pending");
  cue.hit({ critical: true });     // that swing landed as a sneak crit
  assert.deepEqual(cue.get(), { mode: "hit", critical: true, flashes: 2 });
});

await check("back-to-back sneak hits stay bright and restart the flash (data-flash alternates)", () => {
  const c = fakeClock();
  const cue = createSneakCue(c);
  const el = document.createElement("span");
  cue.subscribe((s) => paintSneakCue(el, s, { bonus: 10 }));
  cue.hit();
  assert.equal(el.dataset.sneak, "hit");
  assert.equal(el.dataset.flash, "1");
  c.advance(1200);
  cue.hit();
  assert.equal(el.dataset.flash, "0", "second hit flips the keyframes");
  c.advance(SNEAK_HIT_HOLD_MS - 1);
  assert.equal(el.dataset.sneak, "hit", "held from the latest hit");
  c.advance(1);
  assert.equal(el.dataset.sneak, "off");
  assert.equal(el.textContent, "Sneak Attack +10", "text stays while it fades");
  assert.equal(el.getAttribute("aria-hidden"), "true");
});

await check("dispose clears the timer and ignores later input", () => {
  const c = fakeClock();
  const cue = createSneakCue(c);
  cue.hit();
  assert.equal(c.pending(), 1);
  cue.dispose();
  assert.equal(c.pending(), 0);
  cue.behind();
  assert.equal(c.pending(), 0);
});

console.log("\n[3] mountSneakCue — attack feed (melee / missile)");

await check("prediction + server bit drive the element; untrained Sneak Attack shows no dim cue", async () => {
  const c = fakeClock();
  const client = makeClient();
  const win = { __pluginClient: client };
  let training = 2;
  const el = document.createElement("span");
  const off = mountSneakCue(el, {
    feed: "attack", win, doc: document, readTraining: () => training,
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
  });
  assert.ok(el.classList.contains("hb-sneak-cue"));
  assert.ok(document.getElementById("hb-sneak-cue-style"), "shared stylesheet injected");
  assert.equal(el.dataset.sneak, "off");
  assert.equal(client.live("damageDealt"), 1);
  assert.equal(client.live("evadedTarget"), 1);
  assert.equal(client.live("sneakAttackPredicted"), 1);

  client.events.emit("sneakAttackPredicted", { attackerGuid: 1, defenderGuid: 2, attackType: 4, scope: "local" });
  assert.equal(el.dataset.sneak, "behind");
  assert.equal(el.textContent, "Sneak Attack +10");
  client.events.emit("damageDealt", {
    defenderName: "Drudge Skulker", damage: 37, damageType: "Pierce", severity: 0.3,
    criticalHit: true, attackConditions: 0x4,
  });
  assert.equal(el.dataset.sneak, "hit");
  assert.match(el.title, /Sneak Attack \(up to \+10 damage rating\)/);
  assert.equal(win.__sneakCue.attack.state().critical, true);

  // Recklessness-only hit: not a sneak attack any more.
  client.events.emit("damageDealt", { defenderName: "Drudge Skulker", damage: 20, attackConditions: 0x2 });
  assert.equal(el.dataset.sneak, "off");

  // Missile swing from behind, evaded.
  client.events.emit("sneakAttackPredicted", { scope: "local-missile" });
  assert.equal(el.dataset.sneak, "behind");
  client.events.emit("evadedTarget", { defenderName: "Drudge Skulker" });
  assert.equal(el.dataset.sneak, "off");

  // The cast-click prediction is not this feed's business.
  client.events.emit("sneakAttackPredicted", { scope: "local-magic", spellId: 27 });
  assert.equal(el.dataset.sneak, "off");

  // Untrained: no dim cue, but the server's word still lights it (no number).
  training = 1;
  c.advance(2500); // past the training cache
  client.events.emit("sneakAttackPredicted", { scope: "local" });
  assert.equal(el.dataset.sneak, "off");
  client.events.emit("damageDealt", { attackConditions: 0x4 });
  assert.equal(el.dataset.sneak, "hit");
  assert.equal(el.textContent, "Sneak Attack");

  off();
  assert.equal(client.live("damageDealt"), 0);
  assert.equal(client.live("evadedTarget"), 0);
  assert.equal(client.live("sneakAttackPredicted"), 0);
  assert.equal(el.dataset.sneak, "off");
  assert.equal(win.__sneakCue.attack, undefined, "debug handle removed");
  assert.equal(c.pending(), 0);
});

await check("an unanswered swing fades after 2 s, an unanswered shot after 3 s", () => {
  assert.equal(SNEAK_BEHIND_HOLD_MS, 2000);
  assert.equal(SNEAK_BEHIND_MISSILE_HOLD_MS, 3000);
  const c = fakeClock();
  const client = makeClient();
  const el = document.createElement("span");
  const off = mountSneakCue(el, {
    feed: "attack", win: { __pluginClient: client }, doc: document, readTraining: () => 2,
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
  });
  client.events.emit("sneakAttackPredicted", { scope: "local" });
  c.advance(SNEAK_BEHIND_HOLD_MS - 1);
  assert.equal(el.dataset.sneak, "behind");
  c.advance(1);
  assert.equal(el.dataset.sneak, "off");
  client.events.emit("sneakAttackPredicted", { scope: "local-missile" });
  c.advance(SNEAK_BEHIND_MISSILE_HOLD_MS - 1);
  assert.equal(el.dataset.sneak, "behind", "the arrow is still in the air");
  c.advance(1);
  assert.equal(el.dataset.sneak, "off");
  off();
});

await check("before login it waits for __pluginClientReady, then subscribes", async () => {
  const client = makeClient();
  let resolve;
  const win = { __pluginClient: null, __pluginClientReady: new Promise((r) => { resolve = r; }) };
  const el = document.createElement("span");
  const off = mountSneakCue(el, { feed: "attack", win, doc: document, readTraining: () => 3 });
  assert.equal(client.live("damageDealt"), 0);
  resolve(client);
  await sleep(0);
  assert.equal(client.live("damageDealt"), 1);
  client.events.emit("sneakAttackPredicted", { scope: "local" });
  assert.equal(el.dataset.sneak, "behind");
  assert.equal(el.textContent, "Sneak Attack +20");
  off();
  assert.equal(client.live("damageDealt"), 0);
});

console.log("\n[4] mountSneakCue — magic feed (real plugins/chat-hooks.js)");

await check("ACE's 'Sneak Attack! You …' Magic line lights the spell cue; nothing is eaten", async () => {
  const { chatHooks } = await import("../plugins/chat-hooks.js");
  const c = fakeClock();
  const el = document.createElement("span");
  const off = mountSneakCue(el, {
    feed: "magic", win: { __chatHooks: chatHooks }, doc: document, readTraining: () => 2,
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
  });
  let ev = chatHooks.emitIncoming("You blast Drudge Skulker for 54 points with Lightning Bolt III.", 7, 7);
  assert.equal(el.dataset.sneak, "off");
  ev = chatHooks.emitIncoming("Sneak Attack! Drudge Skulker blasts you for 12 points with Lightning Bolt III.", 7, 7);
  assert.equal(el.dataset.sneak, "off", "the defender line is not ours");
  ev = chatHooks.emitIncoming("Critical hit! Sneak Attack! You blast Drudge Skulker for 108 points with Lightning Bolt III.", 7, 7);
  assert.equal(ev.eaten, false, "the cue never eats the chat line");
  assert.equal(el.dataset.sneak, "hit");
  assert.equal(el.textContent, "Sneak Attack +10");
  assert.match(el.title, /^Your last spell was a Sneak Attack/);
  c.advance(SNEAK_HIT_HOLD_MS);
  assert.equal(el.dataset.sneak, "off");
  off();
  chatHooks.emitIncoming("Sneak Attack! You blast Drudge Skulker for 54 points with Lightning Bolt III.", 7, 7);
  assert.equal(el.dataset.sneak, "off", "unhooked after teardown");
});

console.log("\n[5] the real plugins/combat-hud.js");

await check("row 2 carries the cue after Recklessness; a sneak hit lights it; teardown unhooks", async () => {
  const client = makeClient();
  window.__pluginClient = client;
  window.__pluginClientReady = Promise.resolve(client);
  window.__combatBarState = { powerLevel: 0.5, attackHeight: 2, autoRepeat: true };
  window.__getCurrentStanceLow = () => 0x3c; // a melee stance → the HUD shows
  // Sneak Attack (51) trained — what ui/ac_damage_rating.js readTrainingLevel reads.
  window.__sessionHandle = { playerStats: () => ({ skills: [51, 210, 200, 150, 2, 0] }) };
  window.__fireAttackOnTarget = () => {};

  const body = spliceModule(src("plugins/combat-hud.js"), {
    label: "plugins/combat-hud.js",
    provided: [],
    stubs: {
      setAcText: "(el, text) => { if (el) el.textContent = String(text ?? ''); }",
      readTrainingLevel: "() => 2",
      SKILL_RECKLESSNESS: "50",
      TRAINING_TRAINED: "2",
      TRAINING_SPECIALIZED: "3",
      RECKLESSNESS_BAND_MIN: "0.10",
      RECKLESSNESS_BAND_MAX: "0.90",
      attachWindowPosition: "() => ({ getState: () => ({ x: null, y: null }), resetPosition() {} })",
      WINDOW_ID: "Object.freeze({ COMBAT_HUD: 0x1000004B })",
      setAutoRepeatAttacks: "() => {}",
      isCharacterOptionEnabled: "() => null",
      CHARACTER_OPTION: "Object.freeze({ AutoRepeatAttacks: 0 })",
      getInputFunnel: "() => null",
      inputFunnelV2On: "() => false",
      getAttackCharge: "() => ({ press() {}, release() {}, cancel() {}, onChange: () => () => {} })",
    },
  });
  // eslint-disable-next-line no-new-func
  const hud = new Function(body + "\nreturn { mount, state };\n")();
  const teardown = hud.mount({});
  try {
    const sneak = document.querySelector("#hb-combat-hud .hch-sneak");
    assert.ok(sneak, "the cue element exists in the combat HUD");
    const row = sneak.parentNode;
    assert.ok(row.classList.contains("hch-row"), "inside the option row");
    const kids = row.children;
    assert.equal(kids[kids.length - 1], sneak, "last item of the row");
    assert.ok(kids[kids.length - 2].classList.contains("hch-reck"), "right after Recklessness");
    assert.equal(sneak.dataset.sneak, "off");

    assert.ok(await waitFor(() => !!window.__sneakCue?.attack), "lazy import wired the cue");
    assert.ok(sneak.classList.contains("hb-sneak-cue"));
    assert.equal(client.live("damageDealt"), 1, "one damageDealt listener for the cue");

    client.events.emit("sneakAttackPredicted", { scope: "local", attackerGuid: 1, defenderGuid: 2 });
    assert.equal(sneak.dataset.sneak, "behind");
    client.events.emit("damageDealt", { defenderName: "Drudge Skulker", damage: 37, attackConditions: 0x4 });
    assert.equal(sneak.dataset.sneak, "hit");
    assert.equal(sneak.textContent, "Sneak Attack +10");
    assert.equal(document.getElementById("hb-sneak-hud"), null, "no floating plaque anywhere");
  } finally {
    teardown();
  }
  assert.equal(client.live("damageDealt"), 0, "teardown unhooked the cue");
  assert.equal(window.__sneakCue.attack, undefined);
});

console.log("\n[6] source pins — the old plaque is gone, the strip has the twin");

await check("plugins/sneak-hud.* are retired and nothing points at them", () => {
  assert.equal(existsSync(path.join(APP, "plugins", "sneak-hud.js")), false);
  assert.equal(existsSync(path.join(APP, "plugins", "sneak-hud.manifest.json")), false);
  for (const rel of ["plugins/combat-hud.js", "plugins/combat-bar.js", "app/plugin_bar.js"]) {
    const s = src(rel);
    assert.doesNotMatch(s, /"hb-sneak-hud"/, `${rel}: no hb-sneak-hud id`);
    assert.doesNotMatch(s, /"sneak-hud"/, `${rel}: no sneak-hud plugin id`);
  }
});

await check("both panels load the cue lazily (the splice suites stub every static import)", () => {
  const hudSrc = src("plugins/combat-hud.js");
  const barSrc = src("plugins/combat-bar.js");
  for (const [rel, s] of [["plugins/combat-hud.js", hudSrc], ["plugins/combat-bar.js", barSrc]]) {
    const names = importedNames(s);
    for (const n of ["mountSneakCue", "createSneakCue", "hasSneakAttackBit"]) {
      assert.equal(names.has(n), false, `${rel}: ${n} must not be a static import`);
    }
    assert.match(s, /import\("\.\.\/ui\/ac_sneak_attack_cue\.js"\)/, `${rel}: lazy import`);
  }
  assert.match(hudSrc, /m\.mountSneakCue\(state\.refs\.sneak, \{ feed: "attack" \}\)/);
  assert.match(barSrc, /m\.mountSneakCue\(sneakEl, \{ feed: "magic" \}\)/);
  assert.match(barSrc, /sneakEl\.className = "hb-ss-sneak";/);
  // The strip's cue sits on the tab row as a grid item and lets clicks through.
  assert.match(barSrc, /\.hb-ss-sneak \{\s*grid-column: 2 \/ 4; grid-row: 1;[\s\S]*?pointer-events: none;/);
});

console.log("\n[7] the real spell strip (plugins/combat-bar.js) — the magic twin");

await check("the strip's tab row carries the cue and ACE's Magic sneak line lights it", async () => {
  const { chatHooks } = await import("../plugins/chat-hooks.js");
  window.__chatHooks = chatHooks;
  window.__getCurrentStanceLow = () => 0x49; // magic stance → the strip shows
  globalThis.__T = { slots: Array(18).fill(0), catalog: {} };
  // Same explicit inert stubs as tests/spellbar_endowment_strip.test.mjs.
  const INERT = "() => undefined";
  const STUBS = {
    getSpellBarSlots: "() => globalThis.__T.slots",
    setSpellBarSlot: INERT,
    getActiveSpellBar: "() => 0",
    setActiveSpellBar: INERT,
    addToFirstEmptySlot: "() => false",
    SPELL_BAR_TABS: "8",
    SPELL_BAR_SLOTS: "18",
    loadCatalog: "() => Promise.resolve(globalThis.__T.catalog)",
    resolveBindingIcon: "() => Promise.resolve(null)",
    attachWindowPosition: "() => null",
    resolveLocalBinding: "() => null",
    matchesBinding: "() => false",
    LOCAL_ACTION_IDS: "Object.freeze({})",
    getInputFunnel: "() => null",
    inputFunnelV2On: "() => false",
    setAcText: "(el, text) => { if (el) el.textContent = String(text ?? ''); }",
    classifySpell: "() => null",
    isShapeTableLoaded: "() => false",
    SPELL_SHAPE: "Object.freeze({ Bolt: 'Bolt', Arc: 'Arc', Streak: 'Streak', Volley: 'Volley', Wall: 'Wall', Ring: 'Ring', Blast: 'Blast', Self: 'Self' })",
    setUseFastMissiles: INERT,
    setAutoRepeatAttacks: INERT,
    isCharacterOptionEnabled: "() => false",
    CHARACTER_OPTION: "Object.freeze({})",
    castSpellViaHandle: "() => true",
    spellTargetClass: "() => 'target'",
    announceCastRefusal: INERT,
    MSG_NO_SELECTION: "'You must select a suitable target before casting this spell'",
    noteCombatModeRequest: INERT,
    refuseCombatModeInPortalSpace: "() => false",
    getCastSequence: "() => null",
    wrongStanceForArmed: "() => false",
    castCooldownMs: "() => 0",
    castSweepReducer: "() => ({ ignored: true })",
    suggestedCombatModeFromInventory: "() => 2",
    getAttackCharge: "() => null",
  };
  const body = spliceModule(src("plugins/combat-bar.js"), { label: "plugins/combat-bar.js", provided: [], stubs: STUBS });
  // eslint-disable-next-line no-new-func
  new Function(body + "\nreturn null;\n")();

  const cue = document.querySelector("#hb-spell-strip .hb-ss-sneak");
  assert.ok(cue, "the strip has its cue element");
  assert.ok(cue.parentNode.classList.contains("hb-ss-body"), "a grid item of the strip body");
  assert.equal(cue.previousElementSibling, document.querySelector("#hb-spell-strip .hb-ss-tabs"),
    "placed right after the tab row");
  assert.ok(await waitFor(() => !!window.__sneakCue?.magic), "lazy import wired the magic feed");
  assert.equal(cue.dataset.sneak, "off");
  chatHooks.emitIncoming("Sneak Attack! You blast Drudge Skulker for 54 points with Lightning Bolt III.", 7, 7);
  assert.equal(cue.dataset.sneak, "hit");
  assert.equal(cue.textContent, "Sneak Attack +10");
  window.__sneakCue.magic.clear();
  assert.equal(cue.dataset.sneak, "off");
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);

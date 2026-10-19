// tests/rynth_vt_panel_live_options.test.mjs — where the options made live on
// 2026-10-19 (the former "Not on web" rows) show up in the VTank panel.
//
//   • bridge: the Main tab view carries the helper matrix rows ("others" %,
//     "others ≤" m), the helper switches, the attack-minimum / disengage
//     ranges, Target lock and Start on login; the Loot tab rows carry the
//     corpse-ownership, rare-only, scroll and salvage knobs; none of them is
//     drawn again on the Advanced tab (which still finds them by search);
//   • DOM: the Main and Loot tabs bind those rows and commit the right key.
//
// The REAL VtOptions (a page session over in-memory storage, no bot) and the
// real tab factories on the small fake DOM; the bridge is reduced to the
// opt.set command the tabs call.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_panel_live_options.test.mjs

import assert from "node:assert/strict";
import { installFakeDom, FakeEvent } from "./helpers/social_fake_dom.mjs";

globalThis.window = globalThis;
const { document } = installFakeDom(globalThis);

const { getVtSession } = await import("../rynth/vt/settings/session.js");
const B = await import("../rynth/vt/bridge/bridge_options.js");
const { createMainTab } = await import("../plugins/rynth-vt/tab_main.js");
const { createLootTab } = await import("../plugins/rynth-vt/tab_loot.js");

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n       ") : e}`);
  }
}
const flush = async (n = 3) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const change = (el, value) => {
  if (el.type === "checkbox") el.checked = !!value;
  else el.value = String(value);
  el.dispatchEvent(new FakeEvent("change"));
};
const q = (sel, root = document) => root.querySelector(sel);

function memStorage() {
  const m = new Map();
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

let scopeN = 4000;
function session() {
  const win = {};
  const s = getVtSession(win, String(++scopeN), { storage: memStorage(), log: () => {} });
  // a user profile, so the tabs' edits are writable (Default is read-only)
  assert.equal(s.options.saveAs("Hunt").ok, true);
  return s;
}

function mount(factory, options) {
  const sets = [];
  const ctx = {
    doc: document,
    bridge: {
      opt: {
        set: async (k, v) => {
          sets.push([k, v]);
          return options.set(k, v, { source: "ui" });
        },
      },
      loot: {},
    },
    report: () => {},
    refresh: () => {},
    setStatus: () => {},
    pref: () => undefined,
    isActive: () => true,
    overlay: { update() {} },
  };
  const tab = factory(ctx);
  document.body.appendChild(tab.el);
  return { tab, sets };
}

await check("bridge: Main tab view — helper matrix rows, helper switches, the two new ranges, Target lock and Start on login", () => {
  const { options } = session();
  const v = B.mainTabView(options);
  assert.deepStrictEqual(
    [v.vitals.others.hp?.key, v.vitals.others.st?.key, v.vitals.others.mn?.key],
    ["HealOthersAt", "RestamOthersAt", "InfuseOthersAt"],
  );
  assert.deepStrictEqual([v.vitals.others.hp.value, v.vitals.others.st.value, v.vitals.others.mn.value], [50, 10, 10]);
  assert.deepStrictEqual(
    [v.vitals.othersRange.hp?.key, v.vitals.othersRange.st?.key, v.vitals.othersRange.mn?.key],
    ["HelperHealDistance", "HelperRestamDistance", "HelperInfuseDistance"],
  );
  assert.deepStrictEqual(v.vitals.helpers.map((r) => [r.key, r.value]), [["DoHelp", true], ["UseHealersHeart", true], ["JumpOutWandCasting", false]]);
  assert.deepStrictEqual(v.ranges.map((r) => r.key).slice(-2), ["AttackMinDistance", "MonsterDisengageRange"]);
  const beh = v.behaviour.map((r) => r.key);
  assert.ok(beh.includes("TargetLock") && beh.includes("StartMacroOnLogin"), "Target lock and Start on login on the Behaviour card");
});

await check("bridge: Loot tab rows and homes; the Advanced tab no longer repeats them but its search finds them", () => {
  const { options } = session();
  const rows = B.rowsFor(options, B.LOOT_TAB_KEYS);
  assert.deepStrictEqual(rows.map((r) => r.key), [
    "LootMinValue", "CorpseApproachRangeMax", "CorpseApproachRangeMin",
    "LootFellowCorpses", "LootAllCorpses", "LootOnlyRareCorpses", "ReadUnknownScrolls", "CombineSalvage",
  ]);
  for (const k of ["HealOthersAt", "HelperInfuseDistance", "DoHelp", "AttackMinDistance", "TargetLock", "StartMacroOnLogin"]) {
    assert.equal(B.settingHome(k), "main", `${k} lives on the Main tab`);
  }
  for (const k of ["LootAllCorpses", "ReadUnknownScrolls", "CombineSalvage", "CorpseApproachRangeMin"]) assert.equal(B.settingHome(k), "loot", k);
  const adv = B.advancedTabView(options);
  const shown = adv.groups.flatMap((g) => g.rows.map((r) => r.key));
  for (const k of ["HealOthersAt", "LootAllCorpses", "TargetLock", "AttackMinDistance"]) assert.equal(shown.includes(k), false, `${k} is not repeated on Advanced`);
  for (const k of ["DoJiggle", "TargetNoProgressTimeoutSec", "NavFarStopDistance", "EnableFPSLimit"]) {
    assert.ok(shown.includes(k), `${k} is on Advanced`);
  }
  for (const k of ["BuffProfileBanes", "BuffArmorImpen"]) {
    assert.equal(B.settingHome(k), "buffs", `${k}: the Buffs tab's Worn armor row`);
    assert.equal(shown.includes(k), false, `${k} is not repeated on Advanced`);
  }
  assert.equal(adv.inertCount, 0, "nothing is 'Not on web' any more (Show Editor is never drawn)");
  assert.equal(adv.groups.some((g) => g.group === "Not on web"), false);
  const found = B.advancedTabView(options, "others").groups.flatMap((g) => g.rows.map((r) => [r.key, r.home]));
  assert.ok(found.some(([k, h]) => k === "HealOthersAt" && h === "main"), "search finds a Main-tab row and says where it lives");
});

await check("DOM: Main tab draws the Others rows and the helper switches, and commits their keys", async () => {
  const { options } = session();
  const { tab, sets } = mount(createMainTab, options);
  tab.update({ view: B.mainTabView(options) }, { force: true });
  const heal = q('input[data-key="others.hp"]', tab.el);
  const infuseM = q('input[data-key="othersRange.mn"]', tab.el);
  assert.ok(heal && infuseM, "the Others % and Others ≤ m rows");
  assert.equal(heal.value, "50");
  assert.equal(infuseM.value, "30");
  change(heal, 42);
  change(infuseM, 18);
  const help = q('input[data-key="DoHelp"]', tab.el);
  assert.equal(help.checked, true, "Help fellows starts on");
  change(help, false);
  const lock = q('.rvt-opt[data-key="TargetLock"] input', tab.el);
  assert.ok(lock, "Target lock on the Behaviour card");
  change(lock, true);
  const minR = q('input[data-key="AttackMinDistance"]', tab.el);
  assert.ok(minR && q('input[data-key="MonsterDisengageRange"]', tab.el), "the two new ranges");
  change(minR, 3);
  await flush();
  assert.deepStrictEqual(sets, [
    ["HealOthersAt", 42], ["HelperInfuseDistance", 18], ["DoHelp", false], ["TargetLock", true], ["AttackMinDistance", 3],
  ]);
  assert.equal(options.getValue("HealOthersAt"), 42);
  assert.equal(options.getValue("DoHelp"), false);
  tab.update({ view: B.mainTabView(options) });
  assert.equal(q('input[data-key="DoHelp"]', tab.el).checked, false);
  assert.ok(heal.closest?.(".is-changed") || heal.classList.contains("is-changed") || heal.parentNode?.classList?.contains("is-changed"), "a changed level is marked");
  tab.el.remove();
});

await check("DOM: Loot tab binds the approach minimum and the ownership / after-corpse checkboxes", async () => {
  const { options } = session();
  const { tab, sets } = mount(createLootTab, options);
  tab.update({ view: { rows: B.rowsFor(options, B.LOOT_TAB_KEYS), profiles: [], active: null } });
  const openAt = q('input[data-key="CorpseApproachRangeMin"]', tab.el);
  assert.equal(openAt.value, "4", "the loop's old literal reach");
  const all = q('input[data-key="LootAllCorpses"]', tab.el);
  const scrolls = q('input[data-key="ReadUnknownScrolls"]', tab.el);
  const salvage = q('input[data-key="CombineSalvage"]', tab.el);
  assert.ok(all && scrolls && salvage && q('input[data-key="LootFellowCorpses"]', tab.el) && q('input[data-key="LootOnlyRareCorpses"]', tab.el));
  assert.deepStrictEqual([all.checked, scrolls.checked, salvage.checked], [false, true, true], "VTank defaults");
  change(all, true);
  change(scrolls, false);
  change(openAt, 3.5);
  await flush();
  assert.deepStrictEqual(sets, [["LootAllCorpses", true], ["ReadUnknownScrolls", false], ["CorpseApproachRangeMin", 3.5]]);
  assert.equal(options.getValue("LootAllCorpses"), true);
  assert.equal(options.getValue("CorpseApproachRangeMin"), 3.5);
  tab.el.remove();
});

console.log(fail ? `rynth_vt_panel_live_options: ${fail} FAILED (${pass} passed)` : `rynth_vt_panel_live_options: all ${pass} checks passed`);
process.exit(fail ? 1 : 0);

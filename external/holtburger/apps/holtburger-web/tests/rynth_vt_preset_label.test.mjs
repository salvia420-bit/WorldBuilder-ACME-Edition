// tests/rynth_vt_preset_label.test.mjs — the Profiles tab's preset button
// says what PRESETS.vtank really is (WebAC comparison rynth-formats-expr-6).
//
// PRESETS.vtank (rynth/vt/settings/schema.js) carries RynthAi's
// LegacyUiSettings values (PLAN D3: "VTank/RynthAi defaults"), not values read
// from a VTank-written defaultsettings.usd. The button used to read "Apply
// VTank defaults"; it is relabelled "Apply VTank/RynthAi defaults" with a
// RynthAi title. Relabel only: the preset key stays "vtank" and its values are
// not pinned here — the title's listed settings are checked AGAINST
// PRESETS.vtank, so a later value change must update the title too.
//
// Mounts the panel's command bar (plugins/rynth-vt/bar.js — the preset button
// lives in its profile drawer since the v2 layout, 2026-10-19; v1 had it on
// the Profiles tab) alone on the small fake DOM
// (tests/helpers/social_fake_dom.mjs) with a fake bridge.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_preset_label.test.mjs

import assert from "node:assert/strict";
import { installFakeDom, FakeEvent } from "./helpers/social_fake_dom.mjs";

globalThis.window = globalThis;
const { document } = installFakeDom(globalThis);

const { createCommandBar } = await import("../plugins/rynth-vt/bar.js");
const { PRESETS } = await import("../rynth/vt/settings/schema.js");

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
const qa = (sel, root) => root.querySelectorAll(sel);

const presetCalls = [];
const reports = [];
const bridge = {
  opt: { applyPreset: async (name) => (presetCalls.push(name), { ok: true, applied: Object.keys(PRESETS[name] || {}) }) },
  profiles: {},
};
const ctx = {
  doc: document,
  bridge,
  report: (r, okText) => reports.push([r, okText]),
  refresh: () => {},
};
const bar = createCommandBar(ctx);
document.body.append(bar.el, bar.drawer);
const presetBtn = () => qa("button", bar.drawer).find((b) => /defaults/.test(b.textContent)) || null;
const snapFor = (active) => ({ run: { phase: "running" }, header: { active, profiles: [{ name: active.name, kind: active.kind, label: active.name }], switches: {} } });
const tab = { update: (snap) => bar.update(snapFor(snap.view.active)) };

await check("the preset button reads 'Apply VTank/RynthAi defaults'", () => {
  const b = presetBtn();
  assert.ok(b, "preset button present");
  assert.equal(b.textContent, "Apply VTank/RynthAi defaults");
});

await check("its title names RynthAi (at build and on a writable user profile)", () => {
  assert.match(presetBtn().title, /RynthAi/);
  tab.update({ view: { active: { name: "Hunt", kind: "shared", readOnly: false } } }, { force: true });
  assert.equal(presetBtn().disabled, false);
  assert.match(presetBtn().title, /RynthAi/);
});

await check("Default (read-only) keeps the Save As hint and the button disabled", () => {
  tab.update({ view: { active: { name: "Default", kind: "default", readOnly: true } } }, { force: true });
  assert.equal(presetBtn().disabled, true);
  assert.equal(presetBtn().title, "Default is read-only — Save As first");
  tab.update({ view: { active: { name: "Hunt", kind: "shared", readOnly: false } } }, { force: true });
});

await check("the title lists exactly what PRESETS.vtank turns on", () => {
  const t = presetBtn().title;
  const v = PRESETS.vtank;
  for (const [key, phrase] of [
    ["EnableAutostack", "Autostack"],
    ["EnableAutocram", "Autocram"],
    ["PeaceModeWhenIdle", "Peace Mode When Idle"],
    ["PetAutoRefill", "pet refill"],
  ]) {
    assert.equal(t.includes(phrase), v[key] === true, `${phrase} listed iff PRESETS.vtank.${key} is on`);
  }
  assert.equal(t.includes("VTank war spells"), v.WarSpellMode === "vtank");
  assert.ok(t.includes(`Follow/Nav Min ${v.FollowNavMin} m`), `Follow/Nav Min ${v.FollowNavMin} m listed`);
});

await check("click still applies the 'vtank' preset and reports the new label", async () => {
  presetBtn().dispatchEvent(new FakeEvent("click"));
  await flush();
  assert.deepStrictEqual(presetCalls, ["vtank"], "preset key unchanged");
  const [r, okText] = reports.at(-1);
  assert.equal(r.ok, true);
  assert.equal(okText, "VTank/RynthAi defaults applied");
});

console.log(fail === 0 ? `rynth_vt_preset_label: all ${pass} checks passed` : `rynth_vt_preset_label: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);

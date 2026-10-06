// HUD overhaul 2026-10-05 — unified retail toolbar test.
//
// Run from apps/holtburger-web/:  node test_toolbar_unified.mjs
//
// The toolbar used to be two independently positioned overlays (#hb-hotbar
// 310×132 with two shortcut rows + #hb-target-bar 300×58 at bottom:46px,
// z-index 49, hidden behind the hotbar frame). It is now ONE
// gmFloatyToolbarUI (0x21000070) framing gmToolbarUI (0x21000016):
// plugins/hotbar.js owns the root, plugins/target-bar.js builds the top
// band into the same ToolbarField. This test pins:
//
//   [1] every hard-coded rect / sprite against the DAT layout dumps
//       (data/retail-layouts/0x21000016.json + 0x21000070.json), so the
//       geometry cannot silently drift from retail;
//   [2] the pure helpers (row count / height, grip drag, combat mode,
//       spell self-target read, hotkey labels, panel highlight, health);
//   [3] source-level invariants of the unification (no second overlay,
//       no transform centring, no non-retail strip icons).

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const here = (p) => resolvePath(__dirname, p);

// ─── minimal DOM shim (module-load side effects only) ─────────────────
function installDomShim() {
  if (typeof globalThis.document !== "undefined") return;
  const mkEl = () => ({
    style: { setProperty() {} }, dataset: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() {}, append() {}, setAttribute() {}, addEventListener() {}, remove() {},
  });
  globalThis.document = {
    head: mkEl(), body: mkEl(),
    createElement: mkEl, getElementById: () => null,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  };
  globalThis.window = globalThis;
  if (typeof globalThis.addEventListener !== "function") globalThis.addEventListener = () => {};
  if (typeof globalThis.removeEventListener !== "function") globalThis.removeEventListener = () => {};
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.localStorage = {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
  };
  globalThis.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}), text: () => Promise.resolve("") });
}
installDomShim();

const tb = await import(pathToFileURL(here("plugins/target-bar.js")).href);
const hb = await import(pathToFileURL(here("plugins/hotbar.js")).href);
const st = await import(pathToFileURL(here("plugins/stance-toggle.js")).href);

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  [FAIL] ${name} — ${e.message}`);
  }
}
function eq(actual, expected, label = "") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label} expected ${e}, got ${a}`);
}
function ok(cond, label) { if (!cond) throw new Error(label); }

// ─── DAT layout index ─────────────────────────────────────────────────
function indexLayout(path) {
  const d = JSON.parse(readFileSync(here(path), "utf8"));
  const byId = new Map();
  const walk = (els) => {
    for (const e of els || []) {
      byId.set(parseInt(e.elementIdHex, 16) >>> 0, e);
      walk(e.children);
    }
  };
  walk(d.elements);
  return byId;
}
const L16 = indexLayout("data/retail-layouts/0x21000016.json");
const L70 = indexLayout("data/retail-layouts/0x21000070.json");
const geom = (e) => ({ x: e.stateDesc.x, y: e.stateDesc.y, w: e.stateDesc.width, h: e.stateDesc.height });
// First IMAGE media of a state (frame pieces also carry a Cursor media —
// 0x06006119 move / 0x06005E66 resize — which must not be mistaken for art).
const imageOf = (sd) => (sd?.media || []).find((m) => m.mediaType === "Image")?.imageDids?.[0] ?? null;
const cursorOf = (sd) => (sd?.media || []).find((m) => m.mediaType === "Cursor")?.imageDids?.[0] ?? null;
const stateSprite = (e, state) => imageOf(e.states?.[state]);
const defaultSprite = (e) => imageOf(e.stateDesc);
const hex = (n) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;

console.log("[1] Retail geometry + sprites vs the DAT dumps");

check("floaty root 0x10000602 is 310×100 and toolbarHeightForRows(1) matches", () => {
  const root = geom(L70.get(0x10000602));
  eq([root.w, root.h], [310, 100], "root");
  eq(hb.toolbarHeightForRows(1), root.h, "1-row height");
  eq(hb.toolbarHeightForRows(2), 132, "2-row height (ShortcutBar2 revealed)");
});

check("ToolbarField 0x1000001B sits at (5,5), 300 wide", () => {
  const f = geom(L70.get(0x1000001B));
  eq([f.x, f.y, f.w], [5, 5, 300]);
});

check("TOOLBAR_RECTS match gmToolbarUI StateDesc rects", () => {
  for (const [key, r] of Object.entries(tb.TOOLBAR_RECTS)) {
    const e = L16.get(r.id);
    ok(e, `${key}: ${hex(r.id)} missing from layout`);
    eq({ x: r.x, y: r.y, w: r.w, h: r.h }, geom(e), `${key} ${hex(r.id)}`);
    if (r.sprite) eq(r.sprite, defaultSprite(e), `${key} sprite`);
  }
});

check("all four combat-mode buttons share the stance rect", () => {
  for (const id of [0x10000192, 0x10000193, 0x10000194, 0x10000195]) {
    const g = geom(L16.get(id));
    const r = tb.TOOLBAR_RECTS.stance;
    eq({ x: r.x, y: r.y, w: r.w, h: r.h }, g, hex(id));
  }
});

check("STANCE_BUTTONS use the Normal / Normal_pressed sprites of 0x10000192-195", () => {
  for (const mode of [1, 2, 4, 8]) {
    const b = st.STANCE_BUTTONS[mode];
    const e = L16.get(b.elementId);
    eq(b.normal, stateSprite(e, "Normal"), `mode ${mode} normal`);
    eq(b.pressed, stateSprite(e, "Normal_pressed"), `mode ${mode} pressed`);
  }
});

check("PANEL_BUTTONS: 6 retail buttons, rects + Normal/Highlight sprites from the DAT", () => {
  eq(tb.PANEL_BUTTONS.length, 6, "count");
  eq(tb.PANEL_BUTTONS.map((b) => b.id), [0x10000197, 0x10000198, 0x10000199, 0x1000055A, 0x1000019A, 0x1000019B], "ids in PostInit order");
  for (const b of tb.PANEL_BUTTONS) {
    const e = L16.get(b.id);
    eq({ x: b.x, y: b.y, w: b.w, h: b.h }, geom(e), b.key);
    eq(b.normal, stateSprite(e, "Normal"), `${b.key} Normal`);
    eq(b.highlight, stateSprite(e, "Highlight"), `${b.key} Highlight`);
  }
});

check("InventoryButton uses Normal 0x06004CF7 / Highlight 0x06004CF8", () => {
  const e = L16.get(0x100001B1);
  eq(tb.INVENTORY_BUTTON.normal, stateSprite(e, "Normal"));
  eq(tb.INVENTORY_BUTTON.highlight, stateSprite(e, "Highlight"));
});

check("slotRect() matches ShortcutBar (0x100001A7-AF) and ShortcutBar2 (0x100006B7-BF)", () => {
  const row1 = [0x100001A7, 0x100001A8, 0x100001A9, 0x100001AA, 0x100001AB, 0x100001AC, 0x100001AD, 0x100001AE, 0x100001AF];
  const row2 = [0x100006B7, 0x100006B8, 0x100006B9, 0x100006BA, 0x100006BB, 0x100006BC, 0x100006BD, 0x100006BE, 0x100006BF];
  [...row1, ...row2].forEach((id, i) => {
    const r = hb.slotRect(i);
    eq({ x: r.x, y: r.y, w: r.w, h: r.h }, geom(L16.get(id)), `slot ${i} ${hex(id)}`);
  });
});

check("1-row toolbar fits ShortcutBar exactly: 5 + (58 + 32) + 5 = 100", () => {
  const last = hb.slotRect(8);
  eq(5 + last.y + last.h + 5, hb.toolbarHeightForRows(1));
});

check("every sprite the toolbar draws exists in data/ui-sprites", () => {
  const ids = new Set();
  for (const b of tb.PANEL_BUTTONS) { ids.add(b.normal); ids.add(b.highlight); }
  for (const m of [1, 2, 4, 8]) { ids.add(st.STANCE_BUTTONS[m].normal); ids.add(st.STANCE_BUTTONS[m].pressed); }
  ids.add(tb.INVENTORY_BUTTON.normal); ids.add(tb.INVENTORY_BUTTON.highlight);
  for (const r of Object.values(tb.TOOLBAR_RECTS)) if (r.sprite) ids.add(r.sprite);
  // Literal ids referenced in CSS (Use/Examine/field/meter/blink/frame).
  for (const f of ["plugins/target-bar.js", "plugins/hotbar.js"]) {
    for (const m of readFileSync(here(f), "utf8").matchAll(/"(0x06[0-9A-Fa-f]{6})"/g)) ids.add(m[1]);
  }
  const missing = [...ids].filter((id) => !existsSync(here(`data/ui-sprites/${id}.png`)));
  eq(missing, [], "missing sprites");
});

check("CSS frame uses the gmFloatyToolbarUI unlocked + locked piece sprites", () => {
  const src = readFileSync(here("plugins/hotbar.js"), "utf8");
  const pieces = [0x1000062B, 0x1000062C, 0x1000062E, 0x10000630, 0x10000632,
    0x10000623, 0x10000624, 0x10000625, 0x10000626, 0x10000627, 0x10000628, 0x10000629, 0x1000062A];
  for (const id of pieces) {
    const did = defaultSprite(L70.get(id));
    ok(did && src.includes(`"${did}"`), `${hex(id)} sprite ${did} not referenced`);
  }
});

check("frame cursors: top/sides move (0x06006119), bottom edge resizes (0x06005E66)", () => {
  const src = readFileSync(here("plugins/hotbar.js"), "utf8");
  eq(cursorOf(L70.get(0x1000062C).stateDesc), "0x06006119", "top border");
  eq(cursorOf(L70.get(0x10000630).stateDesc), "0x06005E66", "bottom border");
  ok(src.includes("0x06006119") && src.includes("0x06005E66"), "both retail cursors used");
});

console.log("\n[2] Pure helpers");

check("normalizeRowCount: only 2 means two rows", () => {
  eq([1, 2, "2", 0, 3, null, undefined, "x"].map(hb.normalizeRowCount), [1, 2, 2, 1, 1, 1, 1, 1]);
});

check("rowsAfterGripDrag: half a slot (16 HUD px) commits", () => {
  eq(hb.rowsAfterGripDrag(1, 15), 1, "short drag down");
  eq(hb.rowsAfterGripDrag(1, 16), 2, "drag down reveals row 2");
  eq(hb.rowsAfterGripDrag(2, -15), 2, "short drag up");
  eq(hb.rowsAfterGripDrag(2, -16), 1, "drag up hides row 2");
  eq(hb.rowsAfterGripDrag(2, 40), 2, "already 2");
});

check("spellIsSelfTargeted reads serde-wasm-bindgen Maps (the old read was always undefined)", () => {
  eq(hb.spellIsSelfTargeted(new Map([["isSelfTargeted", false]])), false, "Map false");
  eq(hb.spellIsSelfTargeted(new Map([["isSelfTargeted", true]])), true, "Map true");
  eq(hb.spellIsSelfTargeted(new Map([["flags", new Map([["selfTargeted", true]])]])), true, "nested flags Map");
  eq(hb.spellIsSelfTargeted({ isSelfTargeted: false }), false, "plain object");
  eq(hb.spellIsSelfTargeted({ flags: { selfTargeted: false } }), false, "plain nested");
  eq(hb.spellIsSelfTargeted(new Map()), null, "unknown");
  eq(hb.spellIsSelfTargeted(null), null, "null");
});

check("targeted Map record + selection → castOnTarget (regression for the Map bug)", () => {
  const rec = new Map([["isSelfTargeted", false]]);
  const v = hb.spellIsSelfTargeted(rec);
  eq(hb.decideFireAction({ spellId: 0x5C }, { isSelfTargeted: v ?? true, softTargetGuid: 0x80001234 }),
    { kind: "castOnTarget", spellId: 0x5C, targetGuid: 0x80001234 });
});

check("combatModeForStance → retail COMBAT_MODE", () => {
  const C = st.COMBAT_MODE;
  eq(st.combatModeForStance(0), C.NONCOMBAT, "unknown");
  eq(st.combatModeForStance(0x3D), C.NONCOMBAT, "NonCombat");
  eq(st.combatModeForStance(0x8000003D), C.NONCOMBAT, "full 32-bit NonCombat");
  eq(st.combatModeForStance(0x49), C.MAGIC, "Magic");
  eq(st.combatModeForStance(0x3F), C.MISSILE, "Bow");
  eq(st.combatModeForStance(0xE8), C.MISSILE, "BowNoAmmo");
  eq(st.combatModeForStance(0x3C), C.MELEE, "HandCombat");
  eq(st.combatModeForStance(0x45), C.MELEE, "TwoHandedStaff");
  eq(st.combatModeForStance(0x48), C.MELEE, "other non-peace → melee");
});

check("stanceButtonFor / stanceButtonTip", () => {
  eq(st.stanceButtonFor(4).label, "Missile Mode");
  eq(st.stanceButtonFor(99).label, "Peace Mode", "unknown → peace");
  eq(st.stanceButtonTip(1), { text: "Peace Mode", key: "`", sub: "Click to enter combat" });
  eq(st.stanceButtonTip(8).sub, "Click to return to peace");
});

check("pickHotkeyLabel: default before load, live key after, blank when lost", () => {
  eq(tb.pickHotkeyLabel(null, "spellbook", "toggle", "F5"), "F5", "not loaded");
  eq(tb.pickHotkeyLabel([], "spellbook", "toggle", "F5"), "F5", "empty table");
  const list = [
    { keyString: "F2", pluginId: "spellbook", hotkeyId: "toggle-alt" },
    { keyString: "Shift+F5", pluginId: "spellbook", hotkeyId: "toggle" },
  ];
  eq(tb.pickHotkeyLabel(list, "spellbook", "toggle", "F5"), "Shift+F5", "live");
  eq(tb.pickHotkeyLabel(list, "map-panel", "toggle", "F3"), "", "lost its key");
});

check("formatTipLabel", () => {
  eq(tb.formatTipLabel("Spellbook", "F5"), "Spellbook (F5)");
  eq(tb.formatTipLabel("Use", ""), "Use");
});

check("panelButtonIsActive: Highlight only while that panel is the open view", () => {
  const social = tb.PANEL_BUTTONS.find((b) => b.key === "social");
  const world = tb.PANEL_BUTTONS.find((b) => b.key === "world");
  ok(tb.panelButtonIsActive(social, true, "allegiance"), "social/allegiance");
  ok(tb.panelButtonIsActive(social, true, "fellowship"), "social/fellowship tab");
  ok(!tb.panelButtonIsActive(social, false, "allegiance"), "closed");
  ok(tb.panelButtonIsActive(world, true, "map"), "map");
  ok(!tb.panelButtonIsActive(world, true, "inventory"), "other view");
  ok(tb.panelButtonIsActive(tb.INVENTORY_BUTTON, true, "inventory"), "backpack");
});

check("healthFillWidth: hidden until known, clamped to the 140-px meter", () => {
  eq(tb.healthFillWidth(null), null);
  eq(tb.healthFillWidth(-1), null, "objectHealthFraction unknown sentinel");
  eq(tb.healthFillWidth(NaN), null);
  eq(tb.healthFillWidth(0), 0);
  eq(tb.healthFillWidth(0.5), 70);
  eq(tb.healthFillWidth(1.4), 140);
});

console.log("\n[3] Unification invariants (source)");
// Code only: strip /* */ and // comments so history notes don't trip checks.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
const tbSrc = code(readFileSync(here("plugins/target-bar.js"), "utf8"));
const hbSrc = code(readFileSync(here("plugins/hotbar.js"), "utf8"));

check("target-bar no longer positions its own overlay", () => {
  ok(!/bottom:\s*46px/.test(tbSrc), "bottom:46px is gone");
  ok(!/position:\s*fixed/.test(tbSrc), "no fixed-position root");
  ok(!/overlay\.id\s*=/.test(tbSrc), "no overlay id assignment");
  ok(/export function mountToolbarControls\(/.test(tbSrc), "builder exported");
});

check("target-bar mount() is a no-op that only clears a stale #hb-target-bar", () => {
  const removed = [];
  const prevGet = document.getElementById;
  document.getElementById = (id) => (id === "hb-target-bar" ? { remove: () => removed.push(id) } : null);
  try {
    const dispose = tb.mount({});
    ok(typeof dispose === "function", "returns disposer");
    eq(removed, ["hb-target-bar"]);
  } finally {
    document.getElementById = prevGet;
  }
});

check("hotbar mounts the controls into its own ToolbarField", () => {
  ok(/mountToolbarControls\(field,/.test(hbSrc), "mountToolbarControls(field, …)");
  ok(/attachWindowPosition\(overlay,/.test(hbSrc), "single draggable root");
});

check("no translateX(-50%) centring on #hb-hotbar (drag jumped half a width)", () => {
  const m = /#\$\{OVERLAY_ID\} \{([\s\S]*?)\n    \}/.exec(hbSrc);
  ok(m, "root rule found");
  ok(!/transform/.test(m[1]), "root must not be transform-centred");
  ok(/left: calc\(50% - \$\{WIDTH \/ 2\}px\)/.test(m[1]), "centred with calc(50% - 155px)");
});

check("non-retail strip icons are gone (pack button = inventory; train skills / fellowship via panels)", () => {
  ok(!tbSrc.includes("0x06004CFB"), "train-skills tome icon");
  ok(!tbSrc.includes("0x06001366"), "fellowship heads icon");
  ok(!/view:\s*"train-skills"/.test(tbSrc) && !/view:\s*"fellowship"/.test(tbSrc), "no strip button routes there");
});

check("second shortcut row is opt-in (default 1 row)", () => {
  localStorage.removeItem("hb.hotbar.rows.v1");
  ok(/let rowCount = loadRowCount\(\);/.test(hbSrc), "row count is persisted state");
  ok(/hb-hotbar-rows-1 \.hb-hotbar-slot\[data-row="1"\] \{ display: none; \}/.test(hbSrc), "row 2 hidden in 1-row mode");
  eq(hb.normalizeRowCount(localStorage.getItem("hb.hotbar.rows.v1")), 1, "default");
});

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

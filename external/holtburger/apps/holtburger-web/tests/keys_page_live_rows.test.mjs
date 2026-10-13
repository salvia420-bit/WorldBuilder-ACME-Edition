// tests/keys_page_live_rows.test.mjs — input-options-6 (2026-10-13).
//
// Options → Controls "Game actions" listed every labelled retail ActionMap
// action (0x26000000) with a Bind button keyed by the row's labelHash, but
// nothing read those bindings, and the "default" shown was retail's even
// where this client uses another key (Turn Left showed A, which strafes
// here; Use Selected Object showed R, which is Autorun here). Retail's
// Configure Keyboard rows are commands its input manager dispatches
// (UIOption_ActionKeyMap::RefreshMappings → ACCmdInterp::OnAction
// acclient.c:435951 / CPlayerSystem::OnAction).
//
// Pins:
//   [A] retailActionStatus — rebindable (LOCAL_ACTIONS / funnel keyed by the
//       retail id) / fixed (hard-coded + manifest keys) / unavailable.
//   [B] isRetailActionLive / effectiveKeyFor on Controls-row identities
//       (labelHash or label), against real ActionMap rows.
//   [C] findConflictingBindings covers the live defaults.
//   [D] DefaultMap 0x14000002 merges after gmDefaultMap 0x14000000
//       (gmKeyboardUI::InitOptions acclient.c:268397), first map wins,
//       mouse offsets decode as DIMOFS (middle button = Toggle Mouselook).
//   [E] options-panel retailActionRowView (the row a player sees).
//   [F] drift guards: index.html CMD_INTERP_ACTIONS, LOCAL_ACTION_IDS,
//       manifest hotkeys, holtburger-common ClientAction ids.
//
// Fixtures are real retail data: ActionMap 0x26000000 rows resolved through
// StringTable 0x23000005, and KeyMap mapping words copied from the
// client_portal.dat records 0x14000000 / 0x14000002 (one synthetic mapping
// in [D] is marked as such).
//
// Run from apps/holtburger-web/:  node tests/keys_page_live_rows.test.mjs

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";

const APP = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolvePath(APP, "..", "..");

class MemStorage {
  constructor() { this.m = new Map(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
globalThis.window = globalThis;
globalThis.localStorage = new MemStorage();

const K = await import(pathToFileURL(resolvePath(APP, "ui/keymap.js")).href);
const O = await import(pathToFileURL(resolvePath(APP, "plugins/options-panel.js")).href);

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  [OK] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`); }
}
const j = (x) => JSON.stringify(x);

// Real ActionMap 0x26000000 rows (inputMap, actionHash = inner key, labelHash
// = action_name StringTable hash, label = StringTable 0x23000005 text).
const ACTIONS = [
  [0x00000004, 0x00000029, 0x0513D964, "Move Forward"],
  [0x00000004, 0x0000002B, 0x001F2EC0, "Stop Moving"],
  [0x00000004, 0x0000002D, 0x07D707F4, "Strafe Left"],
  [0x00000004, 0x0000002F, 0x0B3334E4, "Turn Left"],
  [0x00000004, 0x00000030, 0x01D9346B, "Autorun"],
  [0x00000004, 0x00000031, 0x001F9DE0, "Jump "],
  [0x00000005, 0x00000035, 0x098D0504, "Rotate Camera Left"],
  [0x00000005, 0x0000003D, 0x07FE3BEB, "Toggle Mouselook"],
  [0x10000002, 0x1000005A, 0x03979184, "Toggle Combat Mode"],
  [0x10000005, 0x10000065, 0x0BE91921, "Spell Slot 1"],
  [0x10000007, 0x10000036, 0x02F394C2, "Select Previous Monster"],
  [0x10000007, 0x10000037, 0x0A1768C2, "Select Next Monster"],
  [0x10000009, 0x10000003, 0x082BC8EC, "Show/Hide Abuse Reporting Panel"],
  [0x10000009, 0x10000019, 0x09BDBC8C, "Show/Hide Inventory Panel"],
  [0x10000009, 0x10000025, 0x04DA4A75, "Use Selected Object"],
  [0x10000009, 0x10000114, 0x01D1EC01, "Toggle Floating Chat Window 1"],
  [0x1000000C, 0x10000042, 0x0AEBD371, "Quickslot 1"],
  [0x1000000C, 0x1000004B, 0x0EBD37E0, "Quickslot 10"],
].map(([inputMap, actionHash, labelHash, label]) => ({ inputMap, actionHash, labelHash, toggle: 0, label }));
window.__acKeybindings = ACTIONS;
const L = K.LOCAL_ACTION_IDS;

// ── [A] retailActionStatus ──────────────────────────────────────────────
console.log("\n[A] retailActionStatus");
{
  const s = K.retailActionStatus(0x10000037, { funnelActions: [] });
  check("Select Next Monster → rebindable through LOCAL Next Monster (Tab)",
    s.status === "rebindable" && s.source === "local" && s.bindingId === L.NEXT_MONSTER
      && s.binding?.code === "Tab" && !s.binding.shift, j(s));
  const q1 = K.retailActionStatus(0x10000042, { funnelActions: [] });
  check("Quickslot 1 → Hotbar Slot 1 (Digit1)", q1.bindingId === L.HOTBAR_1 && q1.binding?.code === "Digit1", j(q1));
  const q10 = K.retailActionStatus(0x1000004B, { funnelActions: [] });
  check("Quickslot 10 → hotbar row 2 slot 1 (Alt+1)",
    q10.bindingId === L.HOTBAR_R2_1 && q10.binding?.code === "Digit1" && q10.binding.alt === true, j(q10));
  const q18 = K.retailActionStatus(0x10000137, { funnelActions: [] });
  check("Quickslot 18 → hotbar row 2 slot 9", q18.bindingId === L.HOTBAR_R2_9, j(q18));
  const ss1 = K.retailActionStatus(0x10000065, { funnelActions: [] });
  check("Spell Slot 1 → Magic: Use Spell Slot 1", ss1.bindingId === L.MAGIC_SLOT_1, j(ss1));
  const auto = K.retailActionStatus(0x30, { funnelActions: [] });
  check("Autorun → LOCAL Autorun (KeyR)", auto.bindingId === L.AUTORUN && auto.binding?.code === "KeyR", j(auto));

  const tl = K.retailActionStatus(0x2F, { funnelActions: [] });
  check("Turn Left → fixed KeyQ (CMD_INTERP)", tl.status === "fixed" && tl.source === "fixed"
    && tl.binding?.code === "KeyQ" && tl.bindingId === null, j(tl));
  const cm = K.retailActionStatus(0x1000005A, { funnelActions: [] });
  check("Toggle Combat Mode → fixed Backquote", cm.status === "fixed" && cm.binding?.code === "Backquote", j(cm));

  check("Toggle Floating Chat Window 1 → unavailable",
    K.retailActionStatus(0x10000114, { funnelActions: [] }).status === "unavailable");
  check("Use Selected Object → unavailable",
    K.retailActionStatus(0x10000025, { funnelActions: [] }).status === "unavailable");
  check("Stop Moving → unavailable", K.retailActionStatus(0x2B, { funnelActions: [] }).status === "unavailable");

  // Manifest-owned panel toggles resolve through the live manifest table.
  K.clearManifestBindings();
  check("Show/Hide Inventory Panel without its manifest → unavailable",
    K.retailActionStatus(0x10000019, { funnelActions: [] }).status === "unavailable");
  K.setManifestBindings({ F4: "inventory::toggle", "Shift+F6": "house-panel::toggle" });
  const inv = K.retailActionStatus(0x10000019, { funnelActions: [] });
  check("Show/Hide Inventory Panel → fixed F4 via inventory::toggle",
    inv.status === "fixed" && inv.source === "manifest" && inv.binding?.code === "F4", j(inv));
  const house = K.retailActionStatus(0x10000018, { funnelActions: [] });
  check("Show/Hide House Page → Shift+F6", house.binding?.code === "F6" && house.binding.shift === true, j(house));
  K.clearManifestBindings();

  // A handler keyed by the retail id goes live with no table edit.
  const viaFunnel = K.retailActionStatus(0x10000114, {
    funnelActions: [{ labelHash: "0x10000114", defaultBinding: "KeyV" }],
  });
  check("funnel action bound under the retail id → rebindable",
    viaFunnel.status === "rebindable" && viaFunnel.source === "funnel"
      && viaFunnel.bindingId === "0x10000114" && viaFunnel.binding?.code === "KeyV", j(viaFunnel));
  K.setBinding("0x10000114", { code: "KeyB" });
  const viaFunnel2 = K.retailActionStatus(0x10000114, {
    funnelActions: [{ labelHash: "0x10000114", defaultBinding: "KeyV" }],
  });
  check("…and its effective key follows the player's override",
    viaFunnel2.binding?.code === "KeyB" && viaFunnel2.defaultBinding?.code === "KeyV", j(viaFunnel2));
  K.clearBinding("0x10000114");
  check("default funnel list = window.__inputFunnel.actions", (() => {
    window.__inputFunnel = { actions: [{ labelHash: "0x10000114", defaultBinding: "KeyV" }] };
    const s = K.retailActionStatus(0x10000114);
    delete window.__inputFunnel;
    return s.status === "rebindable" && s.source === "funnel";
  })());

  const row = { labelHash: "0xFF0000FE", label: "test row", defaultCode: "KeyJ", retailAction: 0x10000114 };
  K.LOCAL_ACTIONS.push(row);
  const viaRow = K.retailActionStatus(0x10000114, { funnelActions: [] });
  K.LOCAL_ACTIONS.splice(K.LOCAL_ACTIONS.indexOf(row), 1);
  check("LOCAL_ACTIONS row tagged `retailAction` → rebindable through that row",
    viaRow.status === "rebindable" && viaRow.bindingId === "0xFF0000FE" && viaRow.binding?.code === "KeyJ", j(viaRow));
  check("retailActionBindingId pads + uppercases", K.retailActionBindingId(0x2f) === "0x0000002F"
    && K.retailActionBindingId(0x10000114) === "0x10000114");
}

// ── [B] isRetailActionLive / effectiveKeyFor ───────────────────────────
console.log("\n[B] isRetailActionLive / effectiveKeyFor");
{
  check("unwired label (Toggle Floating Chat Window 1) is not live", K.isRetailActionLive(0x01D1EC01) === false);
  check("unwired label (Show/Hide Abuse Reporting Panel) is not live", K.isRetailActionLive(0x082BC8EC) === false);
  check("wired label (Select Next Monster) is live", K.isRetailActionLive(0x0A1768C2) === true);
  check("…also as the options-panel hex string", K.isRetailActionLive("0x0A1768C2") === true);
  check("fixed-key label (Turn Left) is live", K.isRetailActionLive(0x0B3334E4) === true);
  check("unknown labelHash is not live", K.isRetailActionLive(0x12345678) === false);
  check("labelHash 0 (unlabelled rows) is not live", K.isRetailActionLive(0) === false);
  check("explicit actions list is honoured",
    K.isRetailActionLive(0x0A1768C2, { actions: [] }) === false);

  check("effectiveKeyFor('Turn Left') → KeyQ", K.effectiveKeyFor("Turn Left") === "KeyQ", K.effectiveKeyFor("Turn Left"));
  check("label match is trim/case-insensitive", K.effectiveKeyFor(" turn left ") === "KeyQ");
  check("effectiveKeyFor('Strafe Left') → KeyA", K.effectiveKeyFor("Strafe Left") === "KeyA");
  check("retail's 'Jump ' (trailing space) → Space", K.effectiveKeyFor("Jump") === "Space");
  check("effectiveKeyFor('Autorun') → KeyR (retail Q)", K.effectiveKeyFor("Autorun") === "KeyR");
  check("effectiveKeyFor('Select Next Monster') → Tab (retail ;)", K.effectiveKeyFor("Select Next Monster") === "Tab");
  const prev = K.effectiveBindingFor("Select Previous Monster");
  check("effectiveBindingFor('Select Previous Monster') → Shift+Tab", prev?.code === "Tab" && prev.shift === true, j(prev));
  check("effectiveKeyFor(labelHash) works too", K.effectiveKeyFor(0x0B3334E4) === "KeyQ");
  check("unavailable action → null", K.effectiveKeyFor("Toggle Floating Chat Window 1") === null);
  check("unknown label → null", K.effectiveKeyFor("No Such Action") === null);
}

// ── [C] findConflictingBindings ─────────────────────────────────────────
console.log("\n[C] findConflictingBindings");
{
  const r = K.findConflictingBindings("KeyR", false, false, false, false);
  check("KeyR with no overrides reports Autorun's default",
    r.some((c) => c.labelHash === L.AUTORUN && c.isDefault === true && c.binding.code === "KeyR"), j(r));
  check("excludeLabelHash skips the row being captured",
    !K.findConflictingBindings("KeyR", false, false, false, false, L.AUTORUN).some((c) => c.labelHash === L.AUTORUN));
  const q = K.findConflictingBindings("KeyQ");
  check("KeyQ reports the fixed Turn Left key",
    q.some((c) => c.label === "Turn Left" && c.fixed === true && c.labelHash === "0x0000002F"), j(q));
  check("Shift+KeyQ is a different shape (no Turn Left)",
    !K.findConflictingBindings("KeyQ", true).some((c) => c.label === "Turn Left"));
  const d1 = K.findConflictingBindings("Digit1").map((c) => c.labelHash);
  check("Digit1 reports both Hotbar Slot 1 and Magic: Use Spell Slot 1",
    d1.includes(L.HOTBAR_1) && d1.includes(L.MAGIC_SLOT_1), j(d1));
  check("unbound-by-default rows (corpse keys) never match",
    !K.findConflictingBindings("KeyC").some((c) => c.labelHash === L.CLOSEST_UNOPENED_CORPSE));

  K.setBinding(L.AUTORUN, { code: "KeyF" });
  check("after rebinding Autorun to F, KeyR no longer reports it",
    !K.findConflictingBindings("KeyR").some((c) => c.labelHash === L.AUTORUN));
  const f = K.findConflictingBindings("KeyF");
  check("…and KeyF reports the override (not as a default)",
    f.some((c) => c.labelHash === L.AUTORUN && !c.isDefault), j(f));
  K.clearBinding(L.AUTORUN);
  check("empty code → []", K.findConflictingBindings("").length === 0);
}

// ── [D] KeyMap merge (gmDefaultMap + DefaultMap) ────────────────────────
console.log("\n[D] retail KeyMap merge");
// Mapping words copied from client_portal.dat. Both records list device 0 =
// keyboard (type 1), device 1 = mouse (type 2).
const DEVICES = [{ type: 1 }, { type: 2 }];
const GM = {
  id: 0x14000000, name: "gmDefaultMap", devices: DEVICES, meta_keys: [],
  mappings: [
    { input_map: 4, key: 0x1E0000, modifier: 0, activation: 3, action_hash: 0x2F }, // Turn Left  A
    { input_map: 4, key: 0xCB0000, modifier: 0, activation: 3, action_hash: 0x2F }, // Turn Left  Left
    { input_map: 4, key: 0x1E0000, modifier: 0x20000000, activation: 3, action_hash: 0x2D }, // Strafe Left Alt+A
    { input_map: 4, key: 0x2C0000, modifier: 0, activation: 3, action_hash: 0x2D }, // Strafe Left Z
    { input_map: 4, key: 0x100000, modifier: 0, activation: 3, action_hash: 0x30 }, // Autorun Q
    { input_map: 0x10000007, key: 0x270000, modifier: 0, activation: 3, action_hash: 0x10000037 }, // Select Next Monster ;
    { input_map: 0x10000009, key: 0x130000, modifier: 0, activation: 3, action_hash: 0x10000025 }, // Use Selected Object R
    { input_map: 0x10000009, key: 0x580000, modifier: 0, activation: 3, action_hash: 0x10000019 }, // Inventory F12
    { input_map: 5, key: 0xB50000, modifier: 0, activation: 3, action_hash: 0x3E }, // Alt Camera Num/
    { input_map: 6, key: 0xCB0000, modifier: 0, activation: 3, action_hash: 0x35 }, // Rotate Camera Left (alt map) Left
  ],
};
const DM = {
  id: 0x14000002, name: "DefaultMap", devices: DEVICES, meta_keys: [],
  mappings: [
    { input_map: 5, key: 0xE0001, modifier: 0, activation: 3, action_hash: 0x3D }, // Toggle Mouselook DIMOFS_BUTTON2
    { input_map: 5, key: 0x4B0000, modifier: 0, activation: 3, action_hash: 0x35 }, // Rotate Camera Left Num4
    { input_map: 5, key: 0x4A0000, modifier: 0, activation: 3, action_hash: 0x33 }, // Zoom Camera In Num-
    { input_map: 10, key: 0x80101, modifier: 0, activation: 3, action_hash: 5 }, // wheel up (sub-control 1)
    { input_map: 10, key: 0x80201, modifier: 0, activation: 3, action_hash: 6 }, // wheel down (sub-control 2)
  ],
};
{
  const idx = K.indexRetailKeyMaps([GM, DM]);
  const at = (cat, ah) => idx.byCategoryAction.get(`${cat}:${ah}`);
  check("gmDefaultMap Turn Left default is A (plain key wins)", at(4, 0x2F)?.code === "KeyA", j(at(4, 0x2F)));
  check("Strafe Left primary is the modifier-less Z", at(4, 0x2D)?.code === "KeyZ" && !at(4, 0x2D).alt, j(at(4, 0x2D)));
  check("DefaultMap camera row now has a default (Num4)", at(5, 0x35)?.code === "Numpad4", j(at(5, 0x35)));
  check("…the alt-camera map keeps gmDefaultMap's Left", at(6, 0x35)?.code === "ArrowLeft");
  check("Toggle Mouselook = DIMOFS_BUTTON2 → Mouse:Middle", at(5, 0x3D)?.code === "Mouse:Middle", j(at(5, 0x3D)));
  check("wheel sub-controls decode up / down",
    at(10, 5)?.code === "Mouse:WheelUp" && at(10, 6)?.code === "Mouse:WheelDown");
  check("byActionHash collects both maps' rotate-left bindings",
    (idx.byActionHash.get(0x35) || []).length === 2);
  check("raw stays the first record; raws lists both", idx.raw === GM && idx.raws.length === 2);
  // Synthetic (merge rule only): a second map rebinding Turn Left must not
  // displace gmDefaultMap's entry.
  const dup = { devices: DEVICES, mappings: [{ input_map: 4, key: 0x2C0000, modifier: 0, activation: 3, action_hash: 0x2F }] };
  const idx2 = K.indexRetailKeyMaps([GM, dup]);
  check("first map wins a duplicate (category, action)", idx2.byCategoryAction.get("4:47")?.code === "KeyA");
  check("…while byActionHash still records the extra binding", idx2.byActionHash.get(0x2F).length === 3);
  const single = K.indexRetailKeyMaps(GM);
  check("a single record indexes as before", single.byCategoryAction.get("4:47")?.code === "KeyA"
    && single.raws.length === 1);
}
{
  const fetched = [];
  window.__hbWasm = {
    fetch_key_map: async (id) => {
      fetched.push(id);
      if (id === 0x14000000) return JSON.stringify(GM);
      if (id === 0x14000002) return JSON.stringify(DM);
      return "null";
    },
  };
  K._resetRetailKeyMapForTest();
  const km = await K.loadRetailKeyMap();
  check("loadRetailKeyMap fetches gmDefaultMap then DefaultMap",
    j(fetched) === j([0x14000000, 0x14000002]), j(fetched));
  check("merged: Rotate Camera Left default Num4", K.lookupRetailDefault(5, 0x35)?.code === "Numpad4");
  check("merged: Turn Left still A", K.lookupRetailDefault(4, 0x2F)?.code === "KeyA");
  check("cache carries both raws", km?.raws?.length === 2 && km.raw?.id === 0x14000000);

  fetched.length = 0;
  K._resetRetailKeyMapForTest();
  await K.loadRetailKeyMap(0x14000002);
  check("an explicit non-game id loads only that record", j(fetched) === j([0x14000002]), j(fetched));

  window.__hbWasm = {
    fetch_key_map: async (id) => {
      if (id === 0x14000002) throw new Error("shard fetch failed");
      return JSON.stringify(GM);
    },
  };
  K._resetRetailKeyMapForTest();
  const warn = console.warn;
  console.warn = () => {};
  const km2 = await K.loadRetailKeyMap();
  console.warn = warn;
  check("a failed DefaultMap still yields gmDefaultMap (cached, not null)",
    km2 !== null && km2.raws.length === 1 && K.getRetailKeyMap() === km2);
  check("…with gmDefaultMap's defaults and no camera default",
    K.lookupRetailDefault(4, 0x2F)?.code === "KeyA" && K.lookupRetailDefault(5, 0x35) === null);
  K._resetRetailKeyMapForTest();
  delete window.__hbWasm;
}

// ── [E] options-panel retailActionRowView ───────────────────────────────
console.log("\n[E] retailActionRowView");
{
  const tl = O.retailActionRowView(K.retailActionStatus(0x2F, { funnelActions: [] }), { code: "KeyA" });
  check("Turn Left reads 'Q' with 'retail A' (fixed, no Bind)",
    tl.state === "fixed" && tl.keyText === "Q" && tl.retailHint === "retail A" && tl.bindingId === null, j(tl));
  const cm = O.retailActionRowView(K.retailActionStatus(0x1000005A, { funnelActions: [] }), { code: "Backquote" });
  check("same key as retail → no retail hint", cm.retailHint === null && cm.keyText === "Backquote", j(cm));
  const nm = O.retailActionRowView(K.retailActionStatus(0x10000037, { funnelActions: [] }), { code: "Semicolon" });
  check("Select Next Monster: rebindable, binds Next Monster's key, 'Tab' + retail hint",
    nm.state === "rebindable" && nm.bindingId === L.NEXT_MONSTER && nm.keyText === "Tab"
      && nm.retailHint === "retail Semicolon" && nm.defaultBinding?.code === "Tab", j(nm));
  const q1 = O.retailActionRowView(K.retailActionStatus(0x10000042, { funnelActions: [] }), { code: "Digit1" });
  check("Quickslot 1 matches retail → no hint", q1.state === "rebindable" && q1.retailHint === null, j(q1));
  const use = O.retailActionRowView(K.retailActionStatus(0x10000025, { funnelActions: [] }), { code: "KeyR" });
  check("Use Selected Object: greyed 'not available', retail R only in the tooltip",
    use.state === "unavailable" && use.keyText === "not available" && use.bindingId === null
      && use.retailHint === null && /Not available in this client/.test(use.title) && /retail default: R/.test(use.title), j(use));
  const none = O.retailActionRowView(null, null);
  check("no status / no retail default → unavailable, plain title",
    none.state === "unavailable" && none.title === "Not available in this client", j(none));
}

// ── [F] drift guards ────────────────────────────────────────────────────
console.log("\n[F] drift guards");
{
  const html = readFileSync(resolvePath(APP, "index.html"), "utf8");
  const m = html.match(/const CMD_INTERP_ACTIONS = \{([\s\S]*?)\};/);
  check("index.html still declares CMD_INTERP_ACTIONS", !!m);
  const KEY_TO_CODE = { w: "KeyW", s: "KeyS", d: "KeyD", a: "KeyA", e: "KeyE", q: "KeyQ", " ": "Space", shift: "ShiftLeft" };
  const entries = m ? [...m[1].matchAll(/(?:"([^"]*)"|([a-z]+))\s*:\s*0x([0-9a-f]+)/gi)] : [];
  check("CMD_INTERP_ACTIONS has the 8 movement entries", entries.length === 8, `${entries.length}`);
  for (const e of entries) {
    const key = e[1] ?? e[2];
    const id = Number.parseInt(e[3], 16);
    const fixed = K.RETAIL_ACTION_FIXED_KEYS.get(id);
    check(`fixed key for InputAction 0x${id.toString(16)} mirrors CMD_INTERP '${key}'`,
      fixed?.code === KEY_TO_CODE[key], `${fixed?.code} vs ${KEY_TO_CODE[key]}`);
  }

  const localIds = new Set(K.LOCAL_ACTIONS.map((a) => a.labelHash));
  const missing = [...K.RETAIL_ACTION_LOCAL_IDS].filter(([, id]) => !id || !localIds.has(id));
  check("every RETAIL_ACTION_LOCAL_IDS target is a LOCAL_ACTIONS row", missing.length === 0, j(missing));

  for (const [ah, hk] of K.RETAIL_ACTION_MANIFEST_HOTKEYS) {
    const [plugin, hotkey] = hk.split("::");
    let ok = false;
    try {
      const man = JSON.parse(readFileSync(resolvePath(APP, "plugins", `${plugin}.manifest.json`), "utf8"));
      ok = Array.isArray(man.hotkeys) && man.hotkeys.some((h) => h.id === hotkey);
    } catch (_) {}
    check(`manifest hotkey ${hk} (retail 0x${ah.toString(16)}) exists`, ok);
  }

  // Retail ClientAction ids (holtburger-common, mirrors Chorizite's enum).
  const ui = readFileSync(resolvePath(REPO, "crates/holtburger-common/src/properties/ui.rs"), "utf8");
  const enumBody = ui.slice(ui.indexOf("pub enum ClientAction"), ui.indexOf("}", ui.indexOf("pub enum ClientAction")));
  const clientIds = new Set([...enumBody.matchAll(/=\s*0x([0-9A-Fa-f]{8})/g)].map((x) => Number.parseInt(x[1], 16)));
  const tableIds = [
    ...K.RETAIL_ACTION_LOCAL_IDS.keys(), ...K.RETAIL_ACTION_FIXED_KEYS.keys(), ...K.RETAIL_ACTION_MANIFEST_HOTKEYS.keys(),
  ].filter((id) => id >= 0x10000000);
  const unknown = tableIds.filter((id) => !clientIds.has(id)).map((id) => id.toString(16));
  check(`every 0x1000xxxx table id is a ClientAction (${tableIds.length} ids)`, clientIds.size > 250 && unknown.length === 0, j(unknown));

  const keymapSrc = readFileSync(resolvePath(APP, "ui/keymap.js"), "utf8");
  check("keymap.js no longer calls the retail rows read-only labels with no dispatch",
    !/Read-only labels today/.test(keymapSrc));
  const panelSrc = readFileSync(resolvePath(APP, "plugins/options-panel.js"), "utf8");
  check("options-panel no longer binds Game actions under the raw labelHash",
    !/buildBindingRow\(hashHex/.test(panelSrc) && /retailActionRowView\(retailActionStatus\(/.test(panelSrc));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

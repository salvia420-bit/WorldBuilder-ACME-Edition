// HUD overhaul 2026-10-05 — Options view pure helpers.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_options_panel_helpers.mjs
//
// Pins the HUD-scale slider mapping (percent ↔ ui/hud_scale.js
// multiplier), the "Reset window positions" key sweep (every key
// ui/ac_window_position.js persists under, nothing else), the
// snapshot/restore that backs Cancel, the old-tab-id → retail-4-tab
// mapping, and the manastone / dialog copy that lives beside them.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const load = (p) => import(pathToFileURL(resolvePath(__dirname, p)).href);

const O = await load("plugins/options-panel.js");
const H = await load("ui/hud_scale.js");
const M = await load("plugins/manastone-confirm.js");
const D = await load("plugins/modal-dialog.js");

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  [OK] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`); }
}

class MemStorage {
  constructor(init = {}) { this.m = new Map(Object.entries(init)); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

console.log("== HUD scale slider mapping ==");
check("range follows hud_scale.js (60–200 %)",
  O.HUD_SCALE_PCT_MIN === Math.round(H.HUD_SCALE_MULT_MIN * 100)
  && O.HUD_SCALE_PCT_MAX === Math.round(H.HUD_SCALE_MULT_MAX * 100)
  && O.HUD_SCALE_PCT_MIN === 60 && O.HUD_SCALE_PCT_MAX === 200);
check("1.0 → 100 %", O.hudScalePercentFromMultiplier(1) === 100);
check("1.33 snaps to 135 % (5 % steps)", O.hudScalePercentFromMultiplier(1.33) === 135);
check("0.1 clamps to 60 %", O.hudScalePercentFromMultiplier(0.1) === 60);
check("9 clamps to 200 %", O.hudScalePercentFromMultiplier(9) === 200);
check("garbage → 100 %", O.hudScalePercentFromMultiplier("x") === 100);
check("150 % → 1.5", O.hudScaleMultiplierFromPercent(150) === 1.5);
check("10 % clamps to 0.6", O.hudScaleMultiplierFromPercent(10) === 0.6);
check("round trip for every step",
  Array.from({ length: (200 - 60) / 5 + 1 }, (_, i) => 60 + i * 5)
    .every((p) => O.hudScalePercentFromMultiplier(O.hudScaleMultiplierFromPercent(p)) === p));
{
  const s = O.describeHudScale({ effective: 1.875, auto: 1.25, percent: 150 });
  check("readout: effective = window × percent", s === "Effective size 1.88× (window 1.25× × 150%)", s);
  const f = O.describeHudScale({ effective: 2, auto: 1, percent: 100, forced: 2 });
  check("readout: URL override is called out", /\?hudScale=/.test(f) && /2\.00×/.test(f), f);
}

console.log("== Reset window positions ==");
{
  const st = new MemStorage({
    "hb.window.10000600": "{\"x\":1}",
    "hb.window.fffe1234": "{\"x\":2}",
    "hb_panel_pos_main-panel": "{\"left\":3}",
    "hb.hudScale.v1": "{\"mult\":1.5}",
    "holtburger_graphics_v1": "{}",
    "hb.window": "not-a-window-key",
  });
  const n = O.clearWindowPositionKeys(st);
  check("removes the 3 window keys", n === 3, `n=${n}`);
  check("keeps HUD scale + graphics + look-alike keys",
    st.getItem("hb.hudScale.v1") !== null && st.getItem("holtburger_graphics_v1") !== null
    && st.getItem("hb.window") !== null && st.length === 3);
  check("idempotent on a clean store", O.clearWindowPositionKeys(st) === 0);
  check("null storage → 0", O.clearWindowPositionKeys(null) === 0);
  const src = readFileSync(resolvePath(__dirname, "ui/ac_window_position.js"), "utf8");
  check("prefix matches ac_window_position.js STORAGE_PREFIX",
    /const STORAGE_PREFIX = "hb\.window\.";/.test(src) && O.WINDOW_POSITION_KEY_PREFIXES.includes("hb.window."));
}

console.log("== Cancel snapshot / restore ==");
{
  const st = new MemStorage({ a: "1", b: "2" });
  const snap = O.snapshotStorage(st, ["a", "b", "c"]);
  check("snapshot records absent keys as null", snap.a === "1" && snap.b === "2" && snap.c === null);
  st.setItem("a", "changed");
  st.removeItem("b");
  st.setItem("c", "new");
  const changed = O.restoreStorage(st, snap).sort();
  check("restore reports exactly the changed keys", JSON.stringify(changed) === JSON.stringify(["a", "b", "c"]), JSON.stringify(changed));
  check("restore puts values back / removes new ones",
    st.getItem("a") === "1" && st.getItem("b") === "2" && st.getItem("c") === null);
  check("second restore is a no-op", O.restoreStorage(st, snap).length === 0);
}

console.log("== tab ids ==");
check("retail tabs resolve to themselves",
  ["gameplay", "character", "chat", "config"].every((t) => O.resolveTabId(t) === t));
check("old ids map onto the retail 4",
  O.resolveTabId("graphics") === "config" && O.resolveTabId("audio") === "config"
  && O.resolveTabId("mouse") === "gameplay" && O.resolveTabId("controls") === "gameplay"
  && O.resolveTabId("network") === "gameplay" && O.resolveTabId("char") === "character");
check("unknown → null (caller falls back)", O.resolveTabId("bogus") === null && O.resolveTabId(undefined) === null);

console.log("== no native unstyled controls in the options sources ==");
for (const f of ["plugins/options-panel.js", "ui/graphics_settings.js", "ui/camera_settings.js"]) {
  const src = readFileSync(resolvePath(__dirname, f), "utf8");
  const ranges = (src.match(/\.type = "range"/g) || []).length;
  const kitRanges = (src.match(/className = "hbk-range"/g) || []).length;
  const checks = (src.match(/\.type = "checkbox"/g) || []).length;
  const kitChecks = (src.match(/className = "hbk-check"/g) || []).length;
  check(`${f}: every range/checkbox carries the kit class`, ranges === kitRanges && checks === kitChecks,
    JSON.stringify({ ranges, kitRanges, checks, kitChecks }));
  check(`${f}: no accent-color / native glass styling left`, !/accent-color/.test(src));
}

console.log("== confirm copy ==");
{
  const a = M.buildMessage({ name: "Mana Stone", charge: 50, mode: "all" });
  check("manastone (all, 50 %)", a === "Use Mana Stone?\nIt will recharge every magic item you are carrying at 50% efficiency, and the stone will be destroyed.", a);
  const b = M.buildMessage({});
  check("manastone defaults read cleanly (no '( restore)')", !/\(\s*restore\)/.test(b) && /this mana stone/.test(b), b);
  check("dialog frame = retail DialogBox sprites 0x06005D39–3E + 0x06005DDB",
    ["0x06005D39", "0x06005D3A", "0x06005D3B", "0x06005D3C", "0x06005D3D", "0x06005D3E", "0x06005DDB"]
      .every((id) => D.DIALOG_FRAME_BACKGROUND.includes(id)));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

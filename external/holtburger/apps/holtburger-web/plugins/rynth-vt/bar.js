// plugins/rynth-vt/bar.js — the VTank panel's command bar (v2, 2026-10-19).
//
// Always visible above the tabs, so what a player flips mid-hunt is one click
// from any tab (VTank spread these over Options, Profiles and Meta):
//
//   RUN        Run Macro (G:7): pause / resume — through the HUD when it is
//              mounted (its START also boots a bot), else bot.control.
//   COMBAT · BUFF · NAV · LOOT · META
//              the five subsystem switches (G:20-21, G:56-57, G:237). NAV
//              resumes a paused route; a paused route draws its switch dashed.
//   profile ▾  the active settings profile (G:51). Default cannot be saved
//              (G:48): an amber "session only" chip says edits there last
//              until reload — click it to Save As.
//   ⋯          the profile drawer: Save As (+ Mine Only, G:54-55), Delete,
//              Apply VTank/RynthAi defaults (PRESETS.vtank, D3), Import HUD
//              settings (D27).
//
// Mine Only has VTank's two meanings: under Default it is the Save As flag
// (kept here); on a user profile it moves that profile between shared and
// this character (G:55).

import {
  el, btn, setText, setTitle, setValue, select, fillSelect, textInput, checkbox, toggleBtn, setToggle, confirmBtn,
  editingInside,
} from "./widgets.js";

export const SWITCHES = Object.freeze([
  { id: "combat", label: "Combat", title: "Enable Combat — attack and debuff targets. Healing, navigation and looting go on when it is off (G:21)" },
  { id: "buff", label: "Buff", title: "Enable Buffing — keep your self buffs up (Buffs tab)" },
  { id: "nav", label: "Nav", title: "Enable Navigation — walk the loaded route (Route tab)" },
  { id: "loot", label: "Loot", title: "Enable Looting — loot corpses with the Loot tab's profile" },
  { id: "meta", label: "Meta", title: "Enable Meta — run the meta's rules about three times a second (Meta tab, G:237)" },
]);

// PRESETS.vtank is RynthAi's set (PLAN D3), not VTank's own file values.
export const PRESET_TITLE = "RynthAi defaults (D3): Autostack, Autocram, Peace Mode When Idle, Follow/Nav Min 1.5 m, VTank war spells, pet refill — into the current profile";
const RO_TIP = "Default can't be saved: your edits apply now but last only until you reload. Click to keep them as a new profile (Save As).";

export function createCommandBar(ctx) {
  const { doc, bridge } = ctx;
  const bar = el(doc, "div", "rvt-bar");

  const run = btn(doc, "START", null, "rvt-run");
  run.dataset.state = "off";
  const sw = el(doc, "div", "rvt-switches");
  const swBtns = {};
  for (const s of SWITCHES) {
    const b = toggleBtn(doc, s.label, s.title);
    b.dataset.switch = s.id;
    swBtns[s.id] = b;
    sw.appendChild(b);
  }
  const prof = el(doc, "div", "rvt-prof");
  const ro = btn(doc, "session only", RO_TIP, "rvt-ro");
  ro.hidden = true;
  const profSel = select(doc, [], "rvt-profile-select");
  profSel.title = "Settings profile (G:51). [By char] = this character only; [Char] = a Mine Only profile.";
  const more = btn(doc, "⋯", "Profile: Save As, Delete, VTank/RynthAi defaults, Import HUD settings", "rvt-more");
  prof.append(ro, profSel, more);
  bar.append(run, sw, prof);

  // ── the profile drawer ───────────────────────────────────────────────────
  const drawer = el(doc, "div", "rvt-drawer");
  drawer.hidden = true;
  const saveName = textInput(doc, "new profile name (no spaces)", "rvt-saveas-name");
  const mine = checkbox(doc, "Mine only", "Profile for this character only (G:55)");
  const saveAs = btn(doc, "Save As", "Save the current settings under a new name and switch to it (G:54)");
  saveAs.classList.add("is-primary");
  const del = confirmBtn(doc, "Delete", "Delete it?", "Delete the selected profile (Default cannot be deleted)", () => doDelete());
  const preset = btn(doc, "Apply VTank/RynthAi defaults", PRESET_TITLE);
  const importHud = btn(doc, "Import HUD settings", "Copy the RynthSuite HUD's saved vitals, loot floor, buffs and priorities into the current profile");
  drawer.append(saveName, mine.lab, saveAs, el(doc, "span", "rvt-sep"), del, preset, importHud);

  let activeKind = null;
  let mineForSaveAs = false; // Mine Only ticked while Default is active

  const after = (r, okText) => {
    ctx.report(r, okText);
    ctx.refresh({ force: true });
    return r;
  };
  // Focus the name field only when the player asked to Save As (the chip):
  // a focused field swallows the movement keys.
  const setDrawer = (open, focusName = false) => {
    drawer.hidden = !open;
    more.classList.toggle("is-active", !!open);
    if (open && focusName) setTimeout(() => saveName.focus?.(), 0);
  };

  run.addEventListener("click", async () => {
    run.disabled = true;
    try {
      ctx.report(await bridge.run.toggle());
    } finally {
      run.disabled = false;
      ctx.refresh({ force: true });
    }
  });
  for (const s of SWITCHES) {
    const b = swBtns[s.id];
    b.addEventListener("click", async () => {
      const on = b.getAttribute("aria-pressed") !== "true";
      after(await bridge.switches.set(s.id, on), (x) => x.echo || `${s.label} ${on ? "on" : "off"}`);
    });
  }
  ro.addEventListener("click", () => setDrawer(true, true));
  more.addEventListener("click", () => setDrawer(drawer.hidden));
  profSel.addEventListener("change", async () => {
    del.disarm(); // an armed Delete was for the profile shown before
    const [kind, ...rest] = String(profSel.value).split(":");
    const name = rest.join(":");
    after(await bridge.profiles.select(name, kind), () => `Profile: ${name}`);
  });
  saveAs.addEventListener("click", async () => {
    const name = saveName.value.trim();
    const r = await bridge.profiles.saveAs(name, mine.cb.checked);
    if (r.ok) {
      saveName.value = "";
      mineForSaveAs = false;
      setDrawer(false);
    }
    after(r, () => `Saved as ${name}`);
  });
  saveName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveAs.click();
  });
  mine.cb.addEventListener("change", async () => {
    // Under Default (read-only) Mine Only is the Save As flag; otherwise it
    // moves the active profile between shared and this character (G:55).
    if (activeKind === "default") {
      mineForSaveAs = mine.cb.checked;
      ctx.report({ ok: true }, mineForSaveAs ? "Save As will create a [Char] profile" : "Save As will create a shared profile");
      return;
    }
    after(await bridge.profiles.setMineOnly(mine.cb.checked), () => (mine.cb.checked ? "Mine Only" : "Shared"));
  });
  async function doDelete() {
    const [kind, ...rest] = String(profSel.value).split(":");
    after(await bridge.profiles.remove(rest.join(":"), kind), "Profile deleted");
  }
  preset.addEventListener("click", async () => after(await bridge.opt.applyPreset("vtank"), "VTank/RynthAi defaults applied"));
  importHud.addEventListener("click", async () => after(await bridge.profiles.importHud(), (x) => `Imported ${(x.imported || []).length} HUD setting(s)`));

  function update(snap) {
    const h = snap && snap.header ? snap.header : null;
    // Run Macro
    const rs = (snap && snap.run) || {};
    const state = rs.phase === "running" ? "running" : rs.phase === "stopped" ? "stopped" : "off";
    if (run.dataset.state !== state) run.dataset.state = state;
    setText(run, state === "running" ? "RUNNING" : state === "stopped" ? "STOPPED" : "START");
    setTitle(run, state === "running" ? "Run Macro is on — click to pause the bot" : state === "stopped" ? "Paused — click to resume" : "Start the bot (HUD START / ?bot=1)");
    // switches
    for (const s of SWITCHES) {
      const b = swBtns[s.id];
      const v = h && h.switches ? h.switches[s.id] : null;
      setToggle(b, !!(v && v.on));
      b.disabled = !(v && v.available);
      b.classList.toggle("is-paused", !!(v && v.on && v.paused));
      setTitle(b, v && v.paused ? `${s.title} — route paused (${v.paused}); click to turn it off, again to resume` : s.title);
    }
    // profile select + chip + drawer state
    const active = h ? h.active : null;
    activeKind = active ? active.kind : null;
    if (!editingInside(profSel)) fillSelect(profSel, (h ? h.profiles : []).map((p) => [`${p.kind}:${p.name}`, p.label]));
    if (active) setValue(profSel, `${active.kind}:${active.name}`);
    profSel.disabled = !active;
    more.disabled = !active;
    const readOnly = !!(active && active.readOnly);
    ro.hidden = !readOnly;
    prof.classList.toggle("is-readonly", readOnly);
    del.disabled = !active || active.kind === "default";
    setValue(mine.cb, activeKind === "default" ? mineForSaveAs : !!(h && h.mineOnly));
    mine.cb.disabled = !active;
    setTitle(mine.lab, activeKind === "default" ? "Save As creates a [Char] profile for this character only (G:55)" : "Profile for this character only (G:55)");
    preset.disabled = !active || readOnly;
    importHud.disabled = !active || readOnly;
    setTitle(preset, readOnly ? "Default is read-only — Save As first" : PRESET_TITLE);
  }

  return { el: bar, drawer, update, setDrawer, refs: { run, swBtns, profSel, ro, more, saveName, mine, saveAs, del, preset, importHud } };
}

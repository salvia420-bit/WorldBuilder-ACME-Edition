// plugins/rynth-vt/tab_profiles.js — the VTank Profiles tab (G:44-58).
//
//   Macro Settings dropdown: Default, [By char], shared profiles, "[Char] …"
//     (this character's own); every change is saved at once to the current
//     profile — Default is read-only (banner) and needs a Save As first (G:48).
//   Save As (no spaces) + Mine Only (G:54-55), Delete, Apply VTank defaults
//     (PRESETS.vtank, D3), Import HUD settings (D27).
//   Enable Auto-Navigation + the Nav profile select + "Save route as…"
//     ("Routes are created on the Route tab and saved on the Profile tab",
//     G:56, critic G3).
//   Enable Looting + the loot profile select ((Value floor) = today's rule),
//     .utl import/export and a minimal loot-rule editor (G:57, critic G2/Q22):
//     rule name / enabled / action (+ keep count) / conditions = a node type
//     from the library's UTL_NODE_TYPES and its raw data fields. Save goes
//     through bot.vt.library.putLoot (validated there).
//   Show Editor: shown disabled — no function, deprecated in VTank (G:58).

import {
  el, btn, setTitle, setValue, shouldRebuild, sectionTitle, note, row, checkbox, textInput, numInput, select, fillSelect,
  fileInput, downloadFile,
} from "./widgets.js";

const NEW_RULE = () => ({ name: "New rule", enabled: true, priority: 0, action: "Keep", conditions: [] });
const baseName = (fileName) => String(fileName || "").replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "").replace(/\s+/g, "_");

export function createProfilesTab(ctx) {
  const { doc, bridge } = ctx;
  const root = el(doc, "div", "rvt-tab-body rvt-tab-profiles");
  root.dataset.tab = "profiles";

  // (The "Default is read-only" banner is the panel's own, above every tab.)

  // ── Macro Settings ───────────────────────────────────────────────────────
  root.appendChild(sectionTitle(doc, "Macro Settings"));
  const profSel = select(doc, [], "rvt-grow rvt-profile-select");
  profSel.title = "The active settings profile (G:51). [By char] = this character only; [Char] = a Mine Only profile.";
  const del = btn(doc, "Delete", "Delete the selected profile (Default cannot be deleted)");
  root.appendChild(row(doc, el(doc, "span", null, "Profile"), profSel, del));
  const saveName = textInput(doc, "new profile name (no spaces)", "rvt-grow rvt-saveas-name");
  const saveAs = btn(doc, "Save As", "Save the current settings under a new name and select it (G:54)");
  const mine = checkbox(doc, "Mine Only", "Profile for this character only (G:55)");
  root.appendChild(row(doc, saveName, saveAs, mine.lab));
  const preset = btn(doc, "Apply VTank defaults", "Autostack, Autocram, Peace Mode When Idle, Follow/Nav Min 1.5 m, VTank war spells, pet refill — into the current profile");
  const importHud = btn(doc, "Import HUD settings", "Copy the RynthSuite HUD's saved vitals, loot floor, buffs and priorities into the current profile");
  root.appendChild(row(doc, preset, importHud));

  // ── Navigation ───────────────────────────────────────────────────────────
  root.appendChild(sectionTitle(doc, "Navigation"));
  const navOn = checkbox(doc, "Enable Auto-Navigation", "Toggle navigation (G:56). Routes are created on the Route tab and saved here.");
  const navSel = select(doc, [["", "(no nav profile)"]], "rvt-grow rvt-navprofile-select");
  navSel.title = "Nav profile: load it as the current route (saved with this settings profile)";
  root.appendChild(row(doc, navOn.lab, navSel));
  const navName = textInput(doc, "route name", "rvt-grow rvt-saveroute-name");
  const navSave = btn(doc, "Save route as…", "Save the current Route tab waypoints as a nav profile and select it");
  root.appendChild(row(doc, navName, navSave));

  // ── Looting ──────────────────────────────────────────────────────────────
  root.appendChild(sectionTitle(doc, "Looting"));
  const lootOn = checkbox(doc, "Enable Looting", "Toggle looting (G:57)");
  const lootSel = select(doc, [["", "(Value floor)"]], "rvt-grow rvt-lootprofile-select");
  lootSel.title = "Loot profile (.utl). (Value floor) = the plain minimum-value rule.";
  root.appendChild(row(doc, lootOn.lab, lootSel));
  const lootImport = fileInput(doc, { accept: ".utl,.txt", title: "Import a VT Classic Looter .utl profile" }, async (f, text, err) => {
    if (err || text == null) return ctx.report({ ok: false, error: `could not read ${f?.name ?? "the file"}` });
    const name = baseName(f.name) || "loot";
    const r = await bridge.loot.importText(name, text);
    ctx.report(r, (x) => `Imported ${name}${x.warnings && x.warnings.length ? ` (${x.warnings.length} warning(s))` : ""}`);
    ctx.refresh({ force: true });
  });
  const lootExport = btn(doc, "Export", "Download the selected loot profile as .utl");
  const lootDel = btn(doc, "Delete", "Delete the selected loot profile");
  root.appendChild(row(doc, el(doc, "span", null, "Import .utl"), lootImport, lootExport, lootDel));
  root.appendChild(note(doc, "Alinco3 connector files are not supported on the web — import a .utl or use the Value floor."));

  // ── Loot rules editor ────────────────────────────────────────────────────
  root.appendChild(sectionTitle(doc, "Loot rules"));
  const edSel = select(doc, [], "rvt-grow rvt-lootedit-select");
  const edLoad = btn(doc, "Edit", "Load the selected loot profile into the rule editor");
  const edNew = btn(doc, "New", "Start a new, empty loot profile");
  root.appendChild(row(doc, edSel, edLoad, edNew));
  const edName = textInput(doc, "loot profile name", "rvt-grow rvt-lootedit-name");
  const edAddRule = btn(doc, "Add rule", "Append a rule");
  const edSave = btn(doc, "Save rules", "Validate and save the profile");
  root.appendChild(row(doc, edName, edAddRule, edSave));
  const rulesEl = el(doc, "div", "rvt-lootrules");
  root.appendChild(rulesEl);

  // ── Show Editor (deprecated) ─────────────────────────────────────────────
  const showEd = checkbox(doc, "Show Editor — No function (deprecated)", "No function in VTank either (G:58)");
  showEd.cb.disabled = true;
  root.appendChild(row(doc, showEd.lab));

  let draft = null; // { name, profile }
  let nodeTypes = [];
  let actions = ["Keep", "Salvage", "Sell", "Read", "KeepUpTo"];
  let activeKind = null; // the active profile's kind (last refresh)
  let mineForSaveAs = false; // Mine Only ticked while Default is active
  let navAvailable = false;

  // ── wiring ───────────────────────────────────────────────────────────────
  profSel.addEventListener("change", async () => {
    const [kind, ...rest] = String(profSel.value).split(":");
    const r = await bridge.profiles.select(rest.join(":"), kind);
    ctx.report(r, () => `Profile: ${rest.join(":")}`);
    ctx.refresh({ force: true });
  });
  del.addEventListener("click", async () => {
    const [kind, ...rest] = String(profSel.value).split(":");
    ctx.report(await bridge.profiles.remove(rest.join(":"), kind), "Profile deleted");
    ctx.refresh({ force: true });
  });
  saveAs.addEventListener("click", async () => {
    const r = await bridge.profiles.saveAs(saveName.value, mine.cb.checked);
    ctx.report(r, () => `Saved as ${saveName.value}`);
    if (r.ok) {
      saveName.value = "";
      mineForSaveAs = false;
    }
    ctx.refresh({ force: true });
  });
  mine.cb.addEventListener("change", async () => {
    // Under Default (read-only) Mine Only is the Save As flag; otherwise it
    // moves the active profile between shared and this character (G:55).
    if (activeKind === "default") {
      mineForSaveAs = mine.cb.checked;
      ctx.report({ ok: true }, mineForSaveAs ? "Save As will create a [Char] profile" : "Save As will create a shared profile");
      return;
    }
    ctx.report(await bridge.profiles.setMineOnly(mine.cb.checked), () => (mine.cb.checked ? "Mine Only" : "Shared"));
    ctx.refresh({ force: true });
  });
  preset.addEventListener("click", async () => {
    ctx.report(await bridge.opt.applyPreset("vtank"), "VTank defaults applied");
    ctx.refresh({ force: true });
  });
  importHud.addEventListener("click", async () => {
    ctx.report(await bridge.profiles.importHud(), (x) => `Imported ${(x.imported || []).length} HUD setting(s)`);
    ctx.refresh({ force: true });
  });
  navOn.cb.addEventListener("change", async () => {
    // With a live nav: the same path as the Route tab's "Enable nav" (ActiveNav
    // setEnabled + resume a paused route); without a bot: the profile value.
    const on = navOn.cb.checked;
    const r = navAvailable ? await bridge.route.enable(on) : await bridge.opt.set("EnableNavigation", on);
    ctx.report(r, (x) => x.echo || (navAvailable ? (on ? "Navigation on" : "Navigation off") : null));
    ctx.refresh();
  });
  navSel.addEventListener("change", async () => {
    if (!navSel.value) return;
    ctx.report(await bridge.navProfiles.select(navSel.value), () => `Route ${navSel.value} loaded`);
    ctx.refresh({ force: true });
  });
  navSave.addEventListener("click", async () => {
    const name = navName.value.trim();
    const r = await bridge.navProfiles.saveAs(name);
    ctx.report(r, () => `Route saved as ${name}`);
    if (r.ok) navName.value = "";
    ctx.refresh({ force: true });
  });
  lootOn.cb.addEventListener("change", async () => {
    ctx.report(await bridge.opt.set("EnableLooting", lootOn.cb.checked), (x) => x.echo || null);
    ctx.refresh();
  });
  lootSel.addEventListener("change", async () => {
    const name = lootSel.value;
    const r = name ? await bridge.loot.load(name) : await bridge.loot.clear();
    ctx.report(r, () => (name ? `Loot profile ${name}` : "Loot: Value floor"));
    ctx.refresh({ force: true });
  });
  lootExport.addEventListener("click", async () => {
    const name = lootSel.value || edSel.value;
    if (!name) return ctx.report({ ok: false, error: "pick a loot profile first" });
    const r = await bridge.loot.exportText(name);
    if (r.ok && typeof r.text === "string") downloadFile(doc, `${name}.utl`, r.text, "text/plain");
    ctx.report(r, () => `Exported ${name}.utl`);
  });
  lootDel.addEventListener("click", async () => {
    const name = lootSel.value || edSel.value;
    if (!name) return ctx.report({ ok: false, error: "pick a loot profile first" });
    ctx.report(await bridge.loot.remove(name), `Deleted ${name}`);
    ctx.refresh({ force: true });
  });
  edLoad.addEventListener("click", async () => {
    const name = edSel.value;
    if (!name) return ctx.report({ ok: false, error: "pick a loot profile to edit" });
    const r = await bridge.loot.get(name);
    if (!r.ok) return ctx.report(r);
    draft = { name, profile: normalizeDraft(r.profile) };
    edName.value = name;
    renderDraft();
  });
  edNew.addEventListener("click", async () => {
    const r = await bridge.loot.newProfile();
    if (!r.ok) return ctx.report(r);
    draft = { name: "", profile: normalizeDraft(r.profile) };
    edName.value = "";
    renderDraft();
  });
  edAddRule.addEventListener("click", () => {
    if (!draft) draft = { name: edName.value.trim(), profile: normalizeDraft(null) };
    draft.profile.rules.push(NEW_RULE());
    renderDraft();
  });
  edSave.addEventListener("click", async () => {
    if (!draft) return ctx.report({ ok: false, error: "nothing to save — Edit or New first" });
    const name = edName.value.trim();
    if (!name) return ctx.report({ ok: false, error: "name the loot profile first" });
    const r = await bridge.loot.put(name, draft.profile);
    if (!r.ok && Array.isArray(r.errors) && r.errors.length) r.error = `${r.error}: ${r.errors.slice(0, 3).join("; ")}`;
    ctx.report(r, () => `Saved loot profile ${name}`);
    if (r.ok) draft.name = name;
    ctx.refresh({ force: true });
  });

  function normalizeDraft(p) {
    const src = p && typeof p === "object" ? JSON.parse(JSON.stringify(p)) : { version: 1, rules: [] };
    if (!Array.isArray(src.rules)) src.rules = [];
    for (const r of src.rules) if (!Array.isArray(r.conditions)) r.conditions = [];
    return src;
  }

  function nodeType(id) {
    return nodeTypes.find((t) => t.id === Number(id)) || null;
  }

  // The draft is panel state: re-rendered on the player's own edits only.
  function renderDraft() {
    rulesEl.textContent = "";
    if (!draft) {
      rulesEl.appendChild(note(doc, "Edit a loot profile or start a New one."));
      return;
    }
    const rules = draft.profile.rules;
    if (!rules.length) rulesEl.appendChild(note(doc, "No rules — Add rule."));
    rules.forEach((rule, ri) => {
      const box = el(doc, "div", "rvt-lootrule");
      box.dataset.rule = String(ri);
      const name = textInput(doc, "rule name", "rvt-grow");
      name.value = String(rule.name ?? "");
      name.addEventListener("change", () => { rule.name = name.value; });
      const en = checkbox(doc, "Enabled");
      en.cb.checked = rule.enabled !== false;
      en.cb.addEventListener("change", () => { rule.enabled = en.cb.checked; });
      const act = select(doc, actions.map((a) => [a, a]));
      act.value = actions.includes(rule.action) ? rule.action : actions[0];
      const keep = numInput(doc, { min: 0, step: 1, placeholder: "count", cls: "rvt-num-s" });
      keep.value = rule.keepCount != null ? String(rule.keepCount) : "";
      keep.hidden = act.value !== "KeepUpTo";
      act.addEventListener("change", () => {
        rule.action = act.value;
        keep.hidden = act.value !== "KeepUpTo";
      });
      keep.addEventListener("change", () => { rule.keepCount = keep.value === "" ? undefined : Math.max(0, Math.round(Number(keep.value))); });
      const up = btn(doc, "▲", "Move up");
      const down = btn(doc, "▼", "Move down");
      const rm = btn(doc, "✕", "Delete rule");
      up.addEventListener("click", () => { if (ri > 0) { rules.splice(ri - 1, 0, rules.splice(ri, 1)[0]); renderDraft(); } });
      down.addEventListener("click", () => { if (ri < rules.length - 1) { rules.splice(ri + 1, 0, rules.splice(ri, 1)[0]); renderDraft(); } });
      rm.addEventListener("click", () => { rules.splice(ri, 1); renderDraft(); });
      box.appendChild(row(doc, name, en.lab, act, keep, up, down, rm));
      rule.conditions.forEach((c, ci) => {
        const typeSel = select(doc, nodeTypes.map((t) => [String(t.id), t.name]), "rvt-node-type");
        typeSel.value = String(c.type);
        const t = nodeType(c.type);
        if (t && t.label) typeSel.title = t.label;
        const n = Math.max(t ? t.arity : 0, Array.isArray(c.data) ? c.data.length : 0);
        const fields = [];
        for (let k = 0; k < n; k++) {
          const f = textInput(doc, (t && t.fields && t.fields[k]) || `data ${k + 1}`, "rvt-num");
          f.value = c.data && c.data[k] != null ? String(c.data[k]) : "";
          f.addEventListener("change", () => {
            if (!Array.isArray(c.data)) c.data = [];
            c.data[k] = f.value;
          });
          fields.push(f);
        }
        typeSel.addEventListener("change", () => {
          const nt = nodeType(typeSel.value);
          c.type = Number(typeSel.value);
          c.typeName = nt ? nt.name : String(typeSel.value);
          const want = nt ? nt.arity : 0;
          c.data = (Array.isArray(c.data) ? c.data : []).slice(0, want);
          while (c.data.length < want) c.data.push("");
          renderDraft();
        });
        const crm = btn(doc, "✕", "Remove condition");
        crm.addEventListener("click", () => { rule.conditions.splice(ci, 1); renderDraft(); });
        const r = row(doc, el(doc, "span", "rvt-note", "if"), typeSel, ...fields, crm);
        r.classList.add("rvt-lootcond");
        box.appendChild(r);
      });
      const addCond = btn(doc, "Add condition", "Add a condition (all conditions must match)");
      addCond.addEventListener("click", () => {
        const first = nodeTypes[0];
        if (!first) return ctx.report({ ok: false, error: "loot condition types are not available (start the bot)" });
        rule.conditions.push({ type: first.id, typeName: first.name, data: Array.from({ length: first.arity }, () => "") });
        renderDraft();
      });
      box.appendChild(row(doc, addCond));
      rulesEl.appendChild(box);
    });
  }
  renderDraft();

  // ── refresh ──────────────────────────────────────────────────────────────
  function update(snap, { force = false } = {}) {
    const v = snap?.view || {};
    const active = v.active || snap?.profile || null;
    activeKind = active ? active.kind : null;

    const opts = (v.profiles || []).map((p) => [`${p.kind}:${p.name}`, p.label]);
    if (shouldRebuild(profSel, JSON.stringify(opts), force)) fillSelect(profSel, opts);
    if (active) setValue(profSel, `${active.kind}:${active.name}`);
    del.disabled = !active || active.kind === "default";
    // Default: the box is only the Save As flag (kept by the panel); a user
    // profile: it shows / toggles that profile's scope (G:55).
    setValue(mine.cb, activeKind === "default" ? mineForSaveAs : !!v.mineOnly);
    mine.cb.disabled = !active;
    setTitle(mine.cb, activeKind === "default" ? "Save As creates a [Char] profile for this character only (G:55)" : "Profile for this character only (G:55)");
    preset.disabled = !active || active.readOnly;
    importHud.disabled = !active || active.readOnly;
    preset.title = active && active.readOnly ? "Default is read-only — Save As first" : "Autostack, Autocram, Peace Mode When Idle, Follow/Nav Min 1.5 m, VTank war spells, pet refill — into the current profile";

    const tg = v.toggles || {};
    setValue(navOn.cb, !!tg.EnableNavigation?.value);
    setValue(lootOn.cb, !!tg.EnableLooting?.value);
    setValue(showEd.cb, !!tg.ShowEditor?.value);

    const np = v.navProfiles || {};
    fillSelect(navSel, [["", "(no nav profile)"], ...(np.profiles || []).map((p) => [p.name, p.name])]);
    setValue(navSel, np.current || "");
    navAvailable = !!np.available;
    navSel.disabled = !np.available;
    navSave.disabled = !np.available;

    const lt = v.loot || {};
    nodeTypes = Array.isArray(lt.nodeTypes) ? lt.nodeTypes : [];
    if (Array.isArray(lt.actions) && lt.actions.length) actions = lt.actions;
    const lootOpts = (lt.profiles || []).map((p) => [p.name, p.name]);
    fillSelect(lootSel, [["", "(Value floor)"], ...lootOpts]);
    setValue(lootSel, lt.current || "");
    fillSelect(edSel, lootOpts.length ? lootOpts : [["", "(no loot profiles)"]]);
    const avail = !!lt.available;
    for (const c of [lootSel, lootImport, lootExport, lootDel, edSel, edLoad, edNew, edAddRule, edSave]) c.disabled = !avail;
  }

  return { id: "profiles", el: root, snapshotId: () => "profiles", update };
}

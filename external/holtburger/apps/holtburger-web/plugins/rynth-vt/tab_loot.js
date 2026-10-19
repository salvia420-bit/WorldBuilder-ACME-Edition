// plugins/rynth-vt/tab_loot.js — the VTank panel's Loot tab (G:57, critic
// G2/Q22; v2 2026-10-19 — v1 kept this on the Profiles tab with two selects
// over the same list of loot profiles).
//
//   profile   the loot profile in use: (Value floor) = the plain
//             minimum-value rule, or a VT Classic Looter .utl from the
//             library — selecting one loads it; Import .utl / Export /
//             Delete. Alinco3 connector files are not supported on the web.
//   knobs     Loot minimum value (the Value floor) and the corpse approach
//             range — the Looting rows VTank keeps among its Advanced options.
//   rules     a minimal rule editor for any library profile (its own picker
//             follows the profile in use until you pick another, so a rule
//             can be fixed without switching the looter mid-hunt) or a New
//             one: rule name / enabled / action (+ keep count) / conditions =
//             a node type from the library's UTL_NODE_TYPES and its raw data
//             fields. Save goes through bot.vt.library.putLoot (validated
//             there). The draft is panel state: it re-renders on the
//             player's own edits only.
// Looting itself is LOOT on the command bar.

import {
  el, btn, setText, setValue, row, checkbox, textInput, numInput, select, fillSelect, fileButton, downloadFile,
  confirmBtn, iconBtn, note, numField, bindRow,
} from "./widgets.js";

const NEW_RULE = () => ({ name: "New rule", enabled: true, priority: 0, action: "Keep", conditions: [] });
const baseName = (fileName) => String(fileName || "").replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "").replace(/\s+/g, "_");

export function createLootTab(ctx) {
  const { doc, bridge } = ctx;
  const root = el(doc, "div", "rvt-tab-body rvt-tab-loot");
  root.dataset.tab = "loot";

  // ── profile ──────────────────────────────────────────────────────────────
  const lootSel = select(doc, [["", "(Value floor)"]], "rvt-lootprofile-select");
  lootSel.title = "Loot profile (.utl). (Value floor) = the plain minimum-value rule. Alinco3 connector files are not supported on the web.";
  const lootImport = fileButton(doc, "Import .utl", { accept: ".utl,.txt", title: "Import a VT Classic Looter .utl profile" }, async (f, text, err) => {
    if (err || text == null) return ctx.report({ ok: false, error: `could not read ${f?.name ?? "the file"}` });
    const name = baseName(f.name) || "loot";
    const r = await bridge.loot.importText(name, text);
    ctx.report(r, (x) => `Imported ${name}${x.warnings && x.warnings.length ? ` (${x.warnings.length} warning(s))` : ""}`);
    ctx.refresh({ force: true });
  });
  const lootExport = btn(doc, "Export", "Download the selected loot profile as .utl");
  const lootDel = confirmBtn(doc, "Delete", "Delete it?", "Delete the selected loot profile", async () => {
    const name = lootSel.value;
    if (!name) return ctx.report({ ok: false, error: "pick a loot profile first" });
    ctx.report(await bridge.loot.remove(name), `Deleted ${name}`);
    ctx.refresh({ force: true });
  });
  root.appendChild(row(doc, el(doc, "span", "rvt-lbl", "Loot profile"), lootSel, lootImport.wrap, lootExport, lootDel));
  root.appendChild(el(doc, "div", "rvt-note", "VT Classic Looter .utl profiles. Alinco3 connector files are not supported on the web."));

  // ── knobs ────────────────────────────────────────────────────────────────
  const minVal = numField(doc, { unit: "pyreals", cls: "rvt-num" });
  minVal.input.dataset.key = "LootMinValue";
  const minLbl = el(doc, "span", "rvt-lbl", "Minimum value");
  const corpse = numField(doc, { unit: "m" });
  corpse.input.dataset.key = "CorpseApproachRangeMax";
  const corpseLbl = el(doc, "span", "rvt-lbl", "Corpse range");
  root.appendChild(row(doc, minLbl, minVal.wrap, el(doc, "span", "rvt-sep"), corpseLbl, corpse.wrap));
  const commit = async (key, value) => {
    ctx.report(await bridge.opt.set(key, value), (x) => x.echo || `${key} = ${x.value}`);
    ctx.refresh();
  };
  const knobs = { LootMinValue: bindRow({ ...minVal, tip: minLbl }, commit), CorpseApproachRangeMax: bindRow({ ...corpse, tip: corpseLbl }, commit) };

  // ── rules editor ─────────────────────────────────────────────────────────
  const head = el(doc, "div", "rvt-sec", "Rules");
  const editing = el(doc, "span", "rvt-sec-meta");
  head.appendChild(editing);
  root.appendChild(head);
  const edSel = select(doc, [["", "(no loot profiles)"]], "rvt-lootedit-select");
  edSel.title = "The loot profile to edit — editing it does not switch the looter";
  const edLoad = btn(doc, "Edit", "Load this loot profile into the rule editor");
  const edNew = btn(doc, "New", "Start a new, empty loot profile");
  const edName = textInput(doc, "loot profile name", "rvt-grow rvt-lootedit-name");
  const edAddRule = btn(doc, "Add rule", "Append a rule");
  const edSave = btn(doc, "Save rules", "Validate and save the profile");
  edSave.classList.add("is-primary");
  root.appendChild(row(doc, edSel, edLoad, edNew, edName, edAddRule, edSave));
  const rulesEl = el(doc, "div", "rvt-lootrules hbk-scroll");
  root.appendChild(rulesEl);

  let draft = null; // { name, profile }
  let edPicked = false; // the player chose what to edit (else it follows the profile in use)
  let nodeTypes = [];
  let actions = ["Keep", "Salvage", "Sell", "Read", "KeepUpTo"];

  lootSel.addEventListener("change", async () => {
    lootDel.disarm(); // an armed Delete was for the profile shown before
    const name = lootSel.value;
    const r = name ? await bridge.loot.load(name) : await bridge.loot.clear();
    ctx.report(r, () => (name ? `Loot profile ${name}` : "Loot: Value floor"));
    ctx.refresh({ force: true });
  });
  lootExport.addEventListener("click", async () => {
    const name = lootSel.value;
    if (!name) return ctx.report({ ok: false, error: "pick a loot profile first" });
    const r = await bridge.loot.exportText(name);
    if (r.ok && typeof r.text === "string") downloadFile(doc, `${name}.utl`, r.text, "text/plain");
    ctx.report(r, () => `Exported ${name}.utl`);
  });
  edSel.addEventListener("change", () => { edPicked = true; });
  edLoad.addEventListener("click", async () => {
    const name = edSel.value;
    if (!name) return ctx.report({ ok: false, error: "pick a loot profile to edit (or New)" });
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
    renderDraft();
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

  function renderDraft() {
    rulesEl.textContent = "";
    setText(editing, draft ? (draft.name ? `editing ${draft.name}` : "new profile") : "");
    if (!draft) {
      rulesEl.appendChild(note(doc, "Pick a loot profile and Edit it, or start a New one."));
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
      act.title = "Action";
      const keep = numInput(doc, { min: 0, step: 1, placeholder: "count", cls: "rvt-num-s" });
      keep.value = rule.keepCount != null ? String(rule.keepCount) : "";
      keep.hidden = act.value !== "KeepUpTo";
      act.addEventListener("change", () => {
        rule.action = act.value;
        keep.hidden = act.value !== "KeepUpTo";
      });
      keep.addEventListener("change", () => { rule.keepCount = keep.value === "" ? undefined : Math.max(0, Math.round(Number(keep.value))); });
      const up = iconBtn(doc, "▲", "Move up");
      const down = iconBtn(doc, "▼", "Move down");
      const rm = iconBtn(doc, "✕", "Delete rule", "is-danger");
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
        const crm = iconBtn(doc, "✕", "Remove condition", "is-danger");
        crm.addEventListener("click", () => { rule.conditions.splice(ci, 1); renderDraft(); });
        const r = row(doc, el(doc, "span", "rvt-faint", "if"), typeSel, ...fields, crm);
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

  function update(snap) {
    const v = snap?.view || {};
    const byKey = new Map((v.rows || []).map((r) => [r.key, r]));
    for (const [k, upd] of Object.entries(knobs)) upd(byKey.get(k) || null);
    nodeTypes = Array.isArray(v.nodeTypes) ? v.nodeTypes : [];
    if (Array.isArray(v.actions) && v.actions.length) actions = v.actions;
    const lootOpts = (v.profiles || []).map((p) => [p.name, p.name]);
    fillSelect(lootSel, [["", "(Value floor)"], ...lootOpts]);
    setValue(lootSel, v.current || "");
    fillSelect(edSel, lootOpts.length ? lootOpts : [["", "(no loot profiles)"]]);
    if (!edPicked || !lootOpts.some(([n]) => n === edSel.value)) {
      edPicked = false;
      setValue(edSel, v.current && lootOpts.some(([n]) => n === v.current) ? v.current : lootOpts.length ? lootOpts[0][0] : "");
    }
    const avail = !!v.available;
    for (const c of [lootSel, lootImport.btn, lootExport, lootDel, edSel, edLoad, edNew, edAddRule, edSave]) c.disabled = !avail;
    lootExport.disabled = !avail || !lootSel.value;
    lootDel.disabled = !avail || !lootSel.value;
    edLoad.disabled = !avail || !edSel.value;
  }

  return { id: "loot", el: root, snapshotId: () => "loot", update };
}

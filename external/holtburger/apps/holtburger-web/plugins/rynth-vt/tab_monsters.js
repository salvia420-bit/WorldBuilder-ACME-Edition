// plugins/rynth-vt/tab_monsters.js — the VTank Monsters tab (G:68-150).
//
// One ordered list; DEFAULT is pinned on top (undeletable, never matched by
// name). Entries are monster names or Monster Expressions; the first entry
// (after DEFAULT) that evaluates to true or to the monster's name is used
// (G:103). Columns (G:76-97): F B G I Y V A R S WC FC Cp DC Cs, P (−1 ignore,
// 0-4 attack priority), Damage Type (<Auto>), Ex. Vuln, Weapon, Offhand,
// PetDmg; [E] opens the expression editor (parse errors shown when the layer
// exposes the parser); ↑↓ reorder; ✕ delete. Add / Add Sel (the selected
// monster's name) / Import HUD priorities / Import RynthAi JSON.

import {
  el, btn, setTitle, shouldRebuild, note, row, checkbox, textInput, textArea, select, fileInput,
} from "./widgets.js";

const VARS_NOTE = "Expressions (G:101-150): range>5 && species==drudge · variables: name typeid species maxhp range hasshield setting_X metastate · /vt listmonstervariables";

export function createMonstersTab(ctx) {
  const { doc, bridge } = ctx;
  const root = el(doc, "div", "rvt-tab-body rvt-tab-monsters");
  root.dataset.tab = "monsters";
  root.appendChild(note(doc, VARS_NOTE));

  const wrap = el(doc, "div", "rvt-table-wrap");
  const table = el(doc, "table", "rvt-table rvt-monsters");
  wrap.appendChild(table);
  root.appendChild(wrap);

  // Expression editor ([E]).
  const ed = el(doc, "div", "rvt-expr");
  ed.hidden = true;
  const edTitle = el(doc, "div", "rvt-note");
  const edText = textArea(doc, "name, or an expression such as  range>5 && species==drudge", 2);
  const edStatus = el(doc, "div", "rvt-note rvt-expr-status");
  const edCheck = btn(doc, "Check", "Parse the expression");
  const edSave = btn(doc, "Save", "Use this text for the entry");
  const edClose = btn(doc, "Close");
  ed.append(edTitle, edText, edStatus, row(doc, edCheck, edSave, edClose));
  root.appendChild(ed);
  let edIndex = null;

  // Add row.
  const addText = textInput(doc, "monster name or expression", "rvt-grow rvt-mon-add");
  const addBtn = btn(doc, "Add", "Append an entry");
  const addSel = btn(doc, "Add Sel", "Add the selected monster's name");
  root.appendChild(row(doc, addText, addBtn, addSel));
  const impHud = btn(doc, "Import HUD priorities", "Copy the HUD's name → priority rules (priority clamped to 0-4)");
  const impJson = fileInput(doc, { accept: ".json", title: "Import RynthAi monster rules (JSON)" }, async (f, text, err) => {
    if (err || text == null) return ctx.report({ ok: false, error: `could not read ${f?.name ?? "the file"}` });
    ctx.report(await bridge.monsters.importRynthAiJson(text), (x) => `Imported ${x.added} rule(s)${x.defaultSet ? " + DEFAULT" : ""}`);
    ctx.refresh({ force: true });
  });
  root.appendChild(row(doc, impHud, el(doc, "span", null, "RynthAi JSON"), impJson));

  // A refused edit forces a re-render so the row shows the stored value again
  // (deferred by shouldRebuild until the player leaves the field).
  const act = async (p, okText = null, force = true) => {
    const r = await p;
    ctx.report(r, okText);
    ctx.refresh({ force: force || !(r && r.ok) });
  };

  addBtn.addEventListener("click", async () => {
    const r = await bridge.monsters.add(addText.value);
    ctx.report(r, () => `Added "${addText.value.trim()}"`);
    if (r.ok) addText.value = "";
    ctx.refresh({ force: true });
  });
  addText.addEventListener("keydown", (e) => { if (e.key === "Enter") addBtn.click(); });
  addSel.addEventListener("click", () => act(bridge.monsters.addSelectedTarget(), (x) => `Added "${x.name}"`));
  impHud.addEventListener("click", () => act(bridge.monsters.importHudPriorities(), (x) => (x.added ? `Imported ${x.added} HUD priorit${x.added === 1 ? "y" : "ies"}` : "Nothing new to import")));

  async function check() {
    const r = await bridge.monsters.check(edText.value);
    const p = r && r.parse;
    edText.classList.toggle("is-error", !!(p && !p.ok));
    edStatus.textContent = r && r.unavailable
      ? `Syntax check unavailable (${r.reason || "start the bot"}).`
      : !p
        ? ""
        : p.ok
          ? `OK${p.dynamic ? " — DYNAMIC (re-evaluated every scan)" : " — static"}`
          : `Parse error${p.pos != null ? ` at ${p.pos}` : ""}: ${p.error}`;
  }
  edText.addEventListener("input", check);
  edCheck.addEventListener("click", check);
  edSave.addEventListener("click", async () => {
    if (edIndex == null) return;
    const r = await bridge.monsters.update(edIndex, { text: edText.value });
    ctx.report(r, "Entry saved");
    if (r.ok) ed.hidden = true;
    ctx.refresh({ force: true });
  });
  edClose.addEventListener("click", () => { ed.hidden = true; edIndex = null; });

  function openEditor(e) {
    edIndex = e.index;
    edTitle.textContent = `Entry ${e.index}: expression`;
    edText.value = e.text;
    ed.hidden = false;
    check();
  }

  const opts = (list) => list.map((x) => (Array.isArray(x) ? x : [String(x), String(x)]));

  function build(v) {
    table.textContent = "";
    const head = el(doc, "tr", "rvt-head");
    const cols = v.columns || [];
    for (const h of ["Name / expression", "On", ...cols, "P", "Dmg Type", "Ex. Vuln", "Weapon", "Offhand", "PetDmg", "E", "", "", ""]) {
      const th = el(doc, "th", null, h);
      if (v.columnTitles && v.columnTitles[h]) th.title = v.columnTitles[h];
      head.appendChild(th);
    }
    table.appendChild(head);
    const elements = v.elements || [];
    const weaponOpts = [["0", "AUTO"], ...(v.weapons || []).map((w) => [String(w.guid), w.name])];
    const offOpts = [["0", "AUTO"], ...(v.offhands || []).map((w) => [String(w.guid), w.name])];
    for (const e of v.entries || []) {
      const tr = el(doc, "tr", `rvt-mon-row${e.isDefault ? " is-default" : ""}`);
      tr.dataset.index = String(e.index);
      const upd = (patch) => act(bridge.monsters.update(e.index, patch), null, false);
      // name / expression
      const tdName = el(doc, "td", "rvt-name");
      if (e.isDefault) tdName.appendChild(el(doc, "span", null, "DEFAULT"));
      else {
        const t = textInput(doc, "", "rvt-mon-text");
        t.value = e.text;
        if (e.parse && !e.parse.ok) {
          t.classList.add("is-error");
          t.title = `Does not parse — matched by name only: ${e.parse.error}`;
        } else if (e.parse && e.parse.dynamic) t.title = "DYNAMIC expression (re-evaluated every scan)";
        t.addEventListener("change", () => upd({ text: t.value }));
        tdName.appendChild(t);
      }
      tr.appendChild(tdName);
      // enabled
      const tdOn = el(doc, "td");
      const on = checkbox(doc, "", "Entry enabled");
      on.cb.checked = e.enabled !== false;
      on.cb.disabled = !!e.isDefault;
      on.cb.addEventListener("change", () => upd({ enabled: on.cb.checked }));
      tdOn.appendChild(on.cb);
      tr.appendChild(tdOn);
      // the 14 spell columns
      for (const c of cols) {
        const td = el(doc, "td", "rvt-colcell");
        const cb = el(doc, "input", "hbk-check rvt-col");
        cb.type = "checkbox";
        cb.dataset.col = c;
        cb.checked = !!e[c];
        cb.title = `${c}: ${(v.columnTitles && v.columnTitles[c]) || c}`;
        cb.addEventListener("change", () => upd({ [c]: cb.checked }));
        td.appendChild(cb);
        tr.appendChild(td);
      }
      // P
      const tdP = el(doc, "td");
      const p = select(doc, opts((v.priorities || [-1, 0, 1, 2, 3, 4]).map((n) => [String(n), String(n)])), "rvt-prio");
      p.value = String(e.priority);
      p.title = "Priority: -1 = ignore completely; 0-4 attack (higher first)";
      p.addEventListener("change", () => upd({ priority: Number(p.value) }));
      tdP.appendChild(p);
      tr.appendChild(tdP);
      // damage type / ex vuln / weapon / offhand / pet
      const mk = (cls, list, value, key, title, conv = (x) => x) => {
        const td = el(doc, "td");
        const s = select(doc, opts(list), cls);
        s.value = String(value);
        s.title = title;
        s.addEventListener("change", () => upd({ [key]: conv(s.value) }));
        td.appendChild(s);
        tr.appendChild(td);
      };
      mk("rvt-dmg", [["Auto", "<Auto>"], ...elements.map((x) => [x, x])], e.damageType, "damageType", "Damage Type (<Auto> lets the macro decide)");
      mk("rvt-exvuln", [["None", "None"], ...elements.map((x) => [x, x])], e.exVuln, "exVuln", "Ex. Vuln: an extra element vuln");
      const withCurrent = (list, g) =>
        g && !list.some(([v]) => v === String(g)) ? [...list, [String(g), `0x${(g >>> 0).toString(16)} (not on the Items tab)`]] : list;
      mk("rvt-weapon", withCurrent(weaponOpts, e.weapon), e.weapon, "weapon", "Weapon/caster to use (from the Items tab)", Number);
      mk("rvt-offhand", withCurrent(offOpts, e.offhand), e.offhand, "offhand", "Offhand weapon or shield (melee)", Number);
      mk("rvt-petdmg", [["PAuto", "PAuto"], ...elements.map((x) => [x, x])], e.petDmg, "petDmg", "Pet damage type to summon");
      // [E] ↑ ↓ ✕
      const tdE = el(doc, "td");
      const eb = btn(doc, "E", "Expression editor");
      eb.disabled = !!e.isDefault;
      eb.addEventListener("click", () => openEditor(e));
      tdE.appendChild(eb);
      tr.appendChild(tdE);
      for (const [label, title, fn] of [
        ["↑", "Move up", () => act(bridge.monsters.move(e.index, -1))],
        ["↓", "Move down", () => act(bridge.monsters.move(e.index, +1))],
        ["✕", "Delete", () => act(bridge.monsters.remove(e.index))],
      ]) {
        const td = el(doc, "td");
        const b = btn(doc, label, title);
        b.disabled = !!e.isDefault;
        b.addEventListener("click", fn);
        td.appendChild(b);
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
  }

  function update(snap, { force = false } = {}) {
    const v = snap?.view || {};
    const sig = JSON.stringify([v.entries, v.weapons, v.offhands, v.syntaxCheck]);
    if (shouldRebuild(table, sig, force)) build(v);
    addSel.disabled = !v.selectedName;
    setTitle(addSel, v.selectedName ? `Add "${v.selectedName}"` : "Select a monster first");
    addBtn.disabled = v.editable === false;
  }

  return { id: "monsters", el: root, snapshotId: () => "monsters", update };
}

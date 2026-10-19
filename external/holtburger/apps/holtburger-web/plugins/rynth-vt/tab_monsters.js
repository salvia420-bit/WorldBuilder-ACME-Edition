// plugins/rynth-vt/tab_monsters.js — the VTank Monsters tab (G:68-150).
//
// One ordered list; DEFAULT is pinned on top (undeletable, never matched by
// name). Entries are monster names or Monster Expressions; the first entry
// (after DEFAULT) that evaluates to true or to the monster's name is used
// (G:103). Columns (G:76-97): F B G I Y V A R S WC FC Cp DC Cs, P (−1 ignore,
// 0-4 attack priority), Damage Type (<Auto>), Ex. Vuln, Weapon, Offhand,
// PetDmg; then E (expression editor, with parse errors when the layer
// exposes the parser) and ↑ ↓ ✕.
//
// v2 (2026-10-19): the name column (with the entry's on/off box) stays put
// while the table scrolls sideways; the add field also FILTERS the list as
// you type (so you see whether a name is already there) and Enter adds it
// (a name already on the list is refused); the row that governs the
// selected / locked monster right now is tinted green; the HUD-priority and
// RynthAi-JSON imports fold into the ⋯ drawer, and the expression help shows
// in the expression editor (and the drawer).

import {
  el, btn, setText, setTitle, shouldRebuild, note, row, checkbox, textInput, textArea, select, fileButton, iconBtn,
} from "./widgets.js";

const VARS_NOTE = "Expressions (G:101-150): range>5 && species==drudge · variables: name typeid species maxhp range hasshield setting_X metastate · /vt listmonstervariables";

export function createMonstersTab(ctx) {
  const { doc, bridge } = ctx;
  const root = el(doc, "div", "rvt-tab-body rvt-tab-monsters");
  root.dataset.tab = "monsters";

  // ── add / filter bar ─────────────────────────────────────────────────────
  const addText = textInput(doc, "monster name or expression — type to filter, Enter to add", "rvt-grow rvt-mon-add");
  const addBtn = btn(doc, "Add", "Append an entry (the first match after DEFAULT wins, G:103)");
  addBtn.classList.add("is-primary");
  const addSel = btn(doc, "Add selected", "Add the selected monster's name");
  const more = btn(doc, "⋯", "Imports and expression help", "rvt-more");
  root.appendChild(row(doc, addText, addBtn, addSel, more));
  const drawer = el(doc, "div", "rvt-drawer rvt-mon-drawer");
  drawer.hidden = true;
  const impHud = btn(doc, "Import HUD priorities", "Copy the HUD's name → priority rules (priority clamped to 0-4)");
  const impJson = fileButton(doc, "Import RynthAi JSON…", { accept: ".json", title: "Import RynthAi monster rules (JSON)" }, async (f, text, err) => {
    if (err || text == null) return ctx.report({ ok: false, error: `could not read ${f?.name ?? "the file"}` });
    ctx.report(await bridge.monsters.importRynthAiJson(text), (x) => `Imported ${x.added} rule(s)${x.defaultSet ? " + DEFAULT" : ""}`);
    ctx.refresh({ force: true });
  });
  drawer.append(impHud, impJson.wrap, note(doc, VARS_NOTE));
  root.appendChild(drawer);

  // ── the table ────────────────────────────────────────────────────────────
  const wrap = el(doc, "div", "rvt-table-wrap hbk-scroll");
  const table = el(doc, "table", "rvt-table rvt-monsters");
  wrap.appendChild(table);
  root.appendChild(wrap);
  const filterNote = el(doc, "div", "rvt-faint rvt-mon-filtered");
  filterNote.hidden = true;
  root.appendChild(filterNote);

  // Expression editor ([E]).
  const ed = el(doc, "div", "rvt-expr");
  ed.hidden = true;
  const edTitle = el(doc, "div", "rvt-dim");
  const edText = textArea(doc, "name, or an expression such as  range>5 && species==drudge", 2);
  const edStatus = el(doc, "div", "rvt-note rvt-expr-status");
  const edCheck = btn(doc, "Check", "Parse the expression");
  const edSave = btn(doc, "Save", "Use this text for the entry");
  const edClose = btn(doc, "Close");
  ed.append(edTitle, edText, edStatus, row(doc, edCheck, edSave, edClose), note(doc, VARS_NOTE));
  root.appendChild(ed);
  let edIndex = null;

  // A refused edit forces a re-render so the row shows the stored value again
  // (deferred by shouldRebuild until the player leaves the field).
  const act = async (p, okText = null, force = true) => {
    const r = await p;
    ctx.report(r, okText);
    ctx.refresh({ force: force || !(r && r.ok) });
  };

  const doAdd = async () => {
    const text = addText.value;
    const r = await bridge.monsters.add(text);
    ctx.report(r, () => `Added "${text.trim()}"`);
    if (r.ok) {
      addText.value = "";
      applyFilter();
    }
    ctx.refresh({ force: true });
  };
  addBtn.addEventListener("click", doAdd);
  addText.addEventListener("keydown", (e) => { if (e.key === "Enter") doAdd(); });
  addText.addEventListener("input", () => applyFilter());
  addSel.addEventListener("click", () => act(bridge.monsters.addSelectedTarget(), (x) => `Added "${x.name}"`));
  more.addEventListener("click", () => {
    drawer.hidden = !drawer.hidden;
    more.classList.toggle("is-active", !drawer.hidden);
  });
  impHud.addEventListener("click", () => act(bridge.monsters.importHudPriorities(), (x) => (x.added ? `Imported ${x.added} HUD priorit${x.added === 1 ? "y" : "ies"}` : "Nothing new to import")));

  /** Hide rows whose text does not contain the add field's text (DEFAULT always shows). */
  function applyFilter() {
    const f = addText.value.trim().toLowerCase();
    let shown = 0;
    let total = 0;
    for (const tr of table.querySelectorAll("tr.rvt-mon-row")) {
      if (tr.classList.contains("is-default")) continue;
      total++;
      const hit = !f || String(tr.dataset.text || "").toLowerCase().includes(f);
      tr.hidden = !hit;
      if (hit) shown++;
    }
    filterNote.hidden = !f || shown === total;
    setText(filterNote, f ? `${shown} of ${total} entries contain "${addText.value.trim()}" — Add or clear the field to see all` : "");
  }

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
    edTitle.textContent = `Entry ${e.index}: name or expression`;
    edText.value = e.text;
    ed.hidden = false;
    check();
  }

  const opts = (list) => list.map((x) => (Array.isArray(x) ? x : [String(x), String(x)]));

  function build(v) {
    table.textContent = "";
    const head = el(doc, "tr", "rvt-head");
    const cols = v.columns || [];
    const th = (h, cls = null) => {
      const t = el(doc, "th", cls, h);
      if (v.columnTitles && v.columnTitles[h]) t.title = `${h}: ${v.columnTitles[h]}`;
      head.appendChild(t);
      return t;
    };
    th("Name / expression", "rvt-name").title = "Monster name or expression — the box turns the entry on/off";
    for (const c of cols) th(c, "rvt-th-spell");
    th("P").title = "Priority: -1 = ignore completely; 0-4 attack (higher first)";
    for (const h of ["Dmg Type", "Ex. Vuln", "Weapon", "Offhand", "PetDmg", "E", ""]) th(h);
    table.appendChild(head);
    const elements = v.elements || [];
    const weaponOpts = [["0", "AUTO"], ...(v.weapons || []).map((w) => [String(w.guid), w.name])];
    const offOpts = [["0", "AUTO"], ...(v.offhands || []).map((w) => [String(w.guid), w.name])];
    for (const e of v.entries || []) {
      const tr = el(doc, "tr", `rvt-mon-row${e.isDefault ? " is-default" : ""}${e.enabled === false ? " is-off" : ""}`);
      tr.dataset.index = String(e.index);
      tr.dataset.text = e.isDefault ? "DEFAULT" : String(e.text ?? "");
      const upd = (patch) => act(bridge.monsters.update(e.index, patch), null, false);
      // name / expression (+ the entry's on/off box)
      const tdName = el(doc, "td", "rvt-name");
      const on = checkbox(doc, "", e.isDefault ? "DEFAULT is always on" : "Entry enabled");
      on.cb.checked = e.enabled !== false;
      on.cb.disabled = !!e.isDefault;
      on.cb.addEventListener("change", () => upd({ enabled: on.cb.checked }));
      tdName.appendChild(on.cb);
      if (e.isDefault) tdName.appendChild(el(doc, "span", null, "DEFAULT"));
      else {
        const t = textInput(doc, "", "rvt-mon-text");
        t.value = e.text;
        if (e.parse && !e.parse.ok) {
          t.classList.add("is-error");
          t.title = `Does not parse — matched by name only: ${e.parse.error}`;
        } else if (e.parse && e.parse.dynamic) t.title = "DYNAMIC expression (re-evaluated every scan)";
        else t.title = e.text;
        t.addEventListener("change", () => upd({ text: t.value }));
        tdName.appendChild(t);
      }
      tr.appendChild(tdName);
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
        g && !list.some(([val]) => val === String(g)) ? [...list, [String(g), `0x${(g >>> 0).toString(16)} (not on the Items tab)`]] : list;
      mk("rvt-weapon", withCurrent(weaponOpts, e.weapon), e.weapon, "weapon", "Weapon/caster to use (from the Items tab)", Number);
      mk("rvt-offhand", withCurrent(offOpts, e.offhand), e.offhand, "offhand", "Offhand weapon or shield (melee)", Number);
      mk("rvt-petdmg", [["PAuto", "PAuto"], ...elements.map((x) => [x, x])], e.petDmg, "petDmg", "Pet damage type to summon");
      // E · ↑ ↓ ✕
      const tdE = el(doc, "td");
      const eb = iconBtn(doc, "E", "Expression editor");
      eb.disabled = !!e.isDefault;
      eb.addEventListener("click", () => openEditor(e));
      tdE.appendChild(eb);
      tr.appendChild(tdE);
      const tdA = el(doc, "td");
      const acts = el(doc, "span", "rvt-acts");
      for (const [label, title, fn, cls] of [
        ["↑", "Move up", () => act(bridge.monsters.move(e.index, -1)), ""],
        ["↓", "Move down", () => act(bridge.monsters.move(e.index, +1)), ""],
        ["✕", "Delete", () => act(bridge.monsters.remove(e.index)), "is-danger"],
      ]) {
        const b = iconBtn(doc, label, title, cls);
        b.disabled = !!e.isDefault;
        b.addEventListener("click", fn);
        acts.appendChild(b);
      }
      tdA.appendChild(acts);
      tr.appendChild(tdA);
      table.appendChild(tr);
    }
    applyFilter();
  }

  function update(snap, { force = false } = {}) {
    const v = snap?.view || {};
    const sig = JSON.stringify([v.entries, v.weapons, v.offhands, v.syntaxCheck]);
    if (shouldRebuild(table, sig, force)) build(v);
    // the row governing the selected / locked monster (no rebuild as targets come and go)
    const tip = v.targetIndex != null
      ? `Governs your ${v.targetSource === "locked" ? "current target" : "selected monster"}${v.selectedName ? ` (${v.selectedName})` : ""}`
      : "";
    for (const tr of table.querySelectorAll("tr.rvt-mon-row")) {
      const on = v.targetIndex != null && tr.dataset.index === String(v.targetIndex);
      tr.classList.toggle("is-target", on);
      const td = tr.querySelector("td.rvt-name");
      if (td) setTitle(td, on ? tip : "");
    }
    addSel.disabled = !v.selectedName;
    setTitle(addSel, v.selectedName ? `Add "${v.selectedName}"` : "Select a monster first");
    addBtn.disabled = v.editable === false;
  }

  return { id: "monsters", el: root, snapshotId: () => "monsters", update };
}

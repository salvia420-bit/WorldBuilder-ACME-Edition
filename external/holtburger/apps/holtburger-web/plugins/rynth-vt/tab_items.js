// plugins/rynth-vt/tab_items.js — the VTank Items tab (G:152-166).
//
// Combat items the macro may wield: wands/staves/orbs, melee and missile
// weapons, shields, pets. "Add" takes the item selected in the inventory
// (then the world selection); "Add (No Buffs)" adds it and keeps the buffing
// subsystem off it (G:156-157; a plain-Add shield gets Impenetrability + the
// banes, D38). Kind and element can be overridden per row; "add by name" is
// the headless fallback (U7b H23).

import { el, btn, shouldRebuild, note, row, checkbox, textInput, select } from "./widgets.js";

export function createItemsTab(ctx) {
  const { doc, bridge } = ctx;
  const root = el(doc, "div", "rvt-tab-body rvt-tab-items");
  root.dataset.tab = "items";
  root.appendChild(note(doc, "Select an item in your inventory and press Add. Allowed: wands/staves/orbs, melee weapons, missile weapons, shields, pets."));

  const add = btn(doc, "Add", "Add the selected inventory item");
  const addNb = btn(doc, "Add (No Buffs)", "Add the selected item and skip it when buffing");
  root.appendChild(row(doc, add, addNb));
  const byName = textInput(doc, "…or the item's name", "rvt-grow rvt-item-name");
  const addName = btn(doc, "Add", "Add the named inventory item");
  const addNameNb = btn(doc, "Add (No Buffs)", "Add the named item, no buffs");
  root.appendChild(row(doc, byName, addName, addNameNb));
  const list = el(doc, "div", "rvt-list rvt-items-list");
  root.appendChild(list);

  const done = async (p, okText) => {
    const r = await p;
    ctx.report(r, okText);
    ctx.refresh({ force: true });
    return r;
  };
  const added = (x) => `Added ${x.entry?.name ?? "item"}${x.entry?.kind ? ` (${x.entry.kind})` : ""}`;
  add.addEventListener("click", () => done(bridge.items.addSelected({ noBuffs: false }), added));
  addNb.addEventListener("click", () => done(bridge.items.addSelected({ noBuffs: true }), added));
  addName.addEventListener("click", async () => {
    const r = await done(bridge.items.addByName(byName.value, { noBuffs: false }), added);
    if (r.ok) byName.value = "";
  });
  addNameNb.addEventListener("click", async () => {
    const r = await done(bridge.items.addByName(byName.value, { noBuffs: true }), added);
    if (r.ok) byName.value = "";
  });

  function build(v) {
    list.textContent = "";
    const entries = v.entries || [];
    if (!v.available) {
      list.appendChild(el(doc, "div", "hbk-empty", "Start the bot to edit the Items list."));
      return;
    }
    if (!entries.length) {
      list.appendChild(el(doc, "div", "hbk-empty", "No combat items yet."));
      return;
    }
    for (const e of entries) {
      const it = el(doc, "div", `rvt-item rvt-item-row${e.noBuffs ? " is-nobuffs" : ""}${e.owned ? "" : " is-missing"}`);
      it.dataset.guid = String(e.guid);
      const name = el(doc, "span", "rvt-grow", e.name || `0x${e.guid.toString(16)}`);
      if (!e.owned) name.title = "Not in this character's inventory";
      const kind = select(doc, (v.kinds || []).map((k) => [k, k]), "rvt-item-kind");
      kind.value = e.kind;
      kind.title = "Item kind";
      kind.addEventListener("change", () => done(bridge.items.update(e.guid, { kind: kind.value })));
      const elem = select(doc, [["", "—"], ...(v.elements || []).map((x) => [x, x])], "rvt-item-element");
      elem.value = e.element || "";
      elem.title = "Damage element (Auto damage type falls back to it)";
      elem.addEventListener("change", () => done(bridge.items.update(e.guid, { element: elem.value || null })));
      const nb = checkbox(doc, "No Buffs", "Skip this item when buffing");
      nb.cb.checked = e.noBuffs;
      nb.cb.addEventListener("change", () => done(bridge.items.update(e.guid, { noBuffs: nb.cb.checked })));
      const rm = btn(doc, "✕", "Remove from the Items list");
      rm.addEventListener("click", () => done(bridge.items.remove(e.guid), "Removed"));
      it.append(name, kind, elem, nb.lab, rm);
      list.appendChild(it);
    }
  }

  function update(snap, { force = false } = {}) {
    const v = snap?.view || {};
    if (shouldRebuild(list, JSON.stringify([v.available, v.entries]), force)) build(v);
    const avail = !!v.available;
    for (const b of [add, addNb, addName, addNameNb]) b.disabled = !avail;
  }

  return { id: "items", el: root, snapshotId: () => "items", update };
}

// plugins/rynth-vt/tab_consumables.js — the VTank Consumables tab
// (G:168-181): items the macro uses — buff items (beers, food), healing /
// stamina kits, foods, potions, mana charges and stones, alchemical grenades,
// spell components whose peas are split, lockpicks for doors.
//
// "Add selected" takes the inventory selection with a type (or auto-detect);
// a Buff Item is appraised first and refused when it lasts less than the
// rebuff threshold (5 minutes, G:181). Pea components carry "keep at least"
// and the splitting tool.

import { el, btn, shouldRebuild, note, row, textInput, numInput, select, fmtSecs } from "./widgets.js";

const TYPE_LABELS = Object.freeze({
  HealthKit: "Healing kit", StaminaKit: "Stamina kit", ManaKit: "Mana kit", HealthFood: "Health food",
  StaminaFood: "Stamina food", HealthPotion: "Health potion", StaminaPotion: "Stamina potion", ManaPotion: "Mana potion",
  BuffItem: "Buff item", ManaStone: "Mana stone", ManaCharge: "Mana charge", Dispel: "Dispel item", Grenade: "Grenade",
  PeaComponent: "Component (split peas)", Lockpick: "Lockpick", Pet: "Pet", General: "General",
});

export function createConsumablesTab(ctx) {
  const { doc, bridge } = ctx;
  const root = el(doc, "div", "rvt-tab-body rvt-tab-consumables");
  root.dataset.tab = "consumables";
  root.appendChild(note(doc, "Since all buff spells are recast when they go below 5 minutes, buff items that last less than 5 minutes are not allowed (G:181)."));

  const typeSel = select(doc, [["auto", "(detect type)"]], "rvt-cons-type");
  const addSel = btn(doc, "Add selected", "Add the selected inventory item as this type");
  root.appendChild(row(doc, typeSel, addSel));
  const byName = textInput(doc, "…or the item's name", "rvt-grow rvt-cons-name");
  const addName = btn(doc, "Add", "Add the named inventory item as the type above");
  root.appendChild(row(doc, byName, addName));
  const list = el(doc, "div", "rvt-list rvt-cons-list");
  root.appendChild(list);

  const done = async (p, okText) => {
    const r = await p;
    ctx.report(r, okText);
    ctx.refresh({ force: true });
    return r;
  };
  const added = (x) => `Added ${x.entry?.name ?? "item"} (${TYPE_LABELS[x.entry?.type] ?? x.entry?.type ?? "?"})`;
  addSel.addEventListener("click", () => done(bridge.consumables.addSelected(typeSel.value), added));
  addName.addEventListener("click", async () => {
    const r = await done(bridge.consumables.addByName(byName.value, typeSel.value), added);
    if (r.ok) byName.value = "";
  });

  function build(v) {
    list.textContent = "";
    if (!v.available) {
      list.appendChild(el(doc, "div", "hbk-empty", "Start the bot to edit the Consumables list."));
      return;
    }
    const entries = v.entries || [];
    if (!entries.length) {
      list.appendChild(el(doc, "div", "hbk-empty", "No consumables yet."));
      return;
    }
    const types = (v.types || []).map((t) => [t, TYPE_LABELS[t] ?? t]);
    for (const e of entries) {
      const it = el(doc, "div", "rvt-item rvt-cons-row");
      it.dataset.guid = String(e.guid);
      const name = el(doc, "span", "rvt-grow", e.name || `0x${e.guid.toString(16)}`);
      const t = select(doc, types, "rvt-cons-rowtype");
      t.value = e.type;
      t.addEventListener("change", () => done(bridge.consumables.update(e.guid, { type: t.value })));
      it.append(name, t);
      if (e.type === "PeaComponent") {
        const keep = numInput(doc, { min: 0, step: 1, placeholder: "keep ≥", cls: "rvt-num-s rvt-cons-keep" });
        keep.value = e.keepAtLeast != null ? String(e.keepAtLeast) : "";
        keep.title = "Split a pea when you have fewer than this many";
        keep.addEventListener("change", () => done(bridge.consumables.update(e.guid, { keepAtLeast: keep.value === "" ? null : Number(keep.value) })));
        const tool = el(doc, "span", "rvt-note", e.toolName ? `tool: ${e.toolName}` : "no tool");
        const useSel = btn(doc, "Tool = selected", "Use the selected inventory item as the splitting tool");
        useSel.addEventListener("click", () => done(bridge.consumables.setToolFromSelection(e.guid), "Tool set"));
        it.append(el(doc, "span", null, "keep ≥"), keep, tool, useSel);
      } else if (e.type === "BuffItem") {
        it.append(el(doc, "span", "rvt-note", e.durationS != null ? `lasts ${fmtSecs(e.durationS)}` : "duration unknown"));
      }
      const rm = btn(doc, "✕", "Remove");
      rm.addEventListener("click", () => done(bridge.consumables.remove(e.guid), "Removed"));
      it.appendChild(rm);
      list.appendChild(it);
    }
  }

  function update(snap, { force = false } = {}) {
    const v = snap?.view || {};
    const types = [["auto", "(detect type)"], ...(v.types || []).map((t) => [t, TYPE_LABELS[t] ?? t])];
    if (shouldRebuild(typeSel, JSON.stringify(types), force)) {
      const keep = typeSel.value;
      typeSel.textContent = "";
      typeSel.value = "";
      for (const [val, text] of types) {
        const o = el(doc, "option", null, text);
        o.value = val;
        typeSel.appendChild(o);
      }
      if (types.some(([val]) => val === keep)) typeSel.value = keep;
    }
    if (shouldRebuild(list, JSON.stringify([v.available, v.entries]), force)) build(v);
    const avail = !!v.available;
    for (const b of [addSel, addName]) b.disabled = !avail;
  }

  return { id: "consumables", el: root, snapshotId: () => "consumables", update };
}

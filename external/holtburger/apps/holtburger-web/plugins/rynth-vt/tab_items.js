// plugins/rynth-vt/tab_items.js — the VTank Items tab (G:152-181): the
// combat items the macro may wield AND the consumables it may use (VTank's
// Items and Consumables tabs, one tab since 2026-10-19).
//
// One add bar: it shows the item selected in your inventory (then the world
// selection), "Add as" (Auto, a combat kind — Wand/Staff/Orb, Melee, Missile,
// Shield, Pet — or a consumable type: kits, foods, potions, buff items, mana
// stones and charges, dispel items, grenades, pea components, lockpicks),
// No Buffs (G:156-157: a combat item the buffing subsystem leaves alone; a
// plain-Add shield gets Impenetrability + the banes, D38) and Add. "Auto"
// adds a weapon / shield / caster / pet essence as a combat item and anything
// else as a consumable of the type the SUP model detects; the name field is
// the headless fallback (U7b H23). Buff items lasting less than the rebuff
// threshold (5 minutes) are refused, as in VTank (G:181).
//
// Below, the two lists: combat items (kind, element — Auto damage type falls
// back to it — No Buffs, remove) and consumables (type; pea components carry
// "keep at least" and the splitting tool; buff items their duration).

import { el, btn, setText, setTitle, shouldRebuild, row, checkbox, textInput, numInput, select, fmtSecs, iconBtn } from "./widgets.js";

export const CONSUMABLE_LABELS = Object.freeze({
  HealthKit: "Healing kit", StaminaKit: "Stamina kit", ManaKit: "Mana kit", HealthFood: "Health food",
  StaminaFood: "Stamina food", HealthPotion: "Health potion", StaminaPotion: "Stamina potion", ManaPotion: "Mana potion",
  BuffItem: "Buff item", ManaStone: "Mana stone", ManaCharge: "Mana charge", Dispel: "Dispel item", Grenade: "Grenade",
  PeaComponent: "Component (split peas)", Lockpick: "Lockpick", Pet: "Pet essence", General: "General",
});
const KIND_LABELS_FALLBACK = Object.freeze({ caster: "Wand/Staff/Orb", melee: "Melee weapon", missile: "Missile weapon", shield: "Shield", pet: "Pet" });

export function createItemsTab(ctx) {
  const { doc, bridge } = ctx;
  const root = el(doc, "div", "rvt-tab-body rvt-tab-items");
  root.dataset.tab = "items";

  // ── add bar ──────────────────────────────────────────────────────────────
  const bar = el(doc, "div", "rvt-addbar");
  const selName = el(doc, "span", "rvt-grow rvt-selname is-none", "select an item in your inventory");
  const asSel = el(doc, "select", "hbk-select rvt-add-as");
  asSel.title = "Add the item as — Auto: a weapon, shield, caster or pet essence becomes a combat item; anything else a consumable of the detected type";
  const noBuffs = checkbox(doc, "No Buffs", "Combat items only: the buffing subsystem leaves this item alone (G:157)");
  const add = btn(doc, "Add", "Add the selected inventory item");
  add.classList.add("is-primary");
  bar.append(el(doc, "span", "rvt-lbl", "Selected:"), selName, el(doc, "span", "rvt-lbl", "as"), asSel, noBuffs.lab, add);
  const byName = textInput(doc, "…or type the item's name", "rvt-grow rvt-item-name");
  const addName = btn(doc, "Add by name", "Add the named inventory item (as above)");
  const nameRow = row(doc, byName, addName);
  nameRow.classList.add("rvt-addbar-row");
  bar.appendChild(nameRow);
  root.appendChild(bar);

  const combatHead = el(doc, "div", "rvt-sec", "Combat items");
  const combatMeta = el(doc, "span", "rvt-sec-meta");
  combatHead.appendChild(combatMeta);
  root.appendChild(combatHead);
  const combatList = el(doc, "div", "rvt-list rvt-items-list");
  root.appendChild(combatList);
  const consHead = el(doc, "div", "rvt-sec", "Consumables");
  consHead.appendChild(el(doc, "span", "rvt-faint rvt-cons-rule", "buff items must last 5 min or more"));
  consHead.lastChild.title = "Every buff is recast below 5 minutes left, so a shorter buff item would be used again at once (G:181)";
  const consMeta = el(doc, "span", "rvt-sec-meta");
  consHead.appendChild(consMeta);
  root.appendChild(consHead);
  const consList = el(doc, "div", "rvt-list rvt-cons-list");
  root.appendChild(consList);

  let kindLabels = { ...KIND_LABELS_FALLBACK };
  const labelOf = (x) => kindLabels[x] || CONSUMABLE_LABELS[x] || x;

  const done = async (p, okText) => {
    const r = await p;
    ctx.report(r, okText);
    ctx.refresh({ force: true });
    return r;
  };
  const added = (x) => {
    const e = x.entry || {};
    return `Added ${e.name ?? "item"}${e.kind ? ` (${labelOf(e.kind)}${e.noBuffs ? ", no buffs" : ""})` : e.type ? ` (${labelOf(e.type)})` : ""}`;
  };
  // One add at a time: after a success "as" and No Buffs go back to Auto / off,
  // so the next item is never added as the last one's kind by accident.
  const addWith = async (name) => {
    const r = await done(bridge.items.addAs({ as: asSel.value || "auto", noBuffs: !noBuffs.cb.disabled && noBuffs.cb.checked, ...(name === undefined ? {} : { name }) }), added);
    if (r && r.ok) {
      asSel.value = "auto";
      noBuffs.cb.checked = false;
      syncNoBuffs();
    }
    return r;
  };
  add.addEventListener("click", () => addWith());
  const addNamed = async () => {
    if (!byName.value.trim()) return ctx.report({ ok: false, error: "type the item's name" });
    const r = await addWith(byName.value);
    if (r.ok) byName.value = "";
  };
  addName.addEventListener("click", addNamed);
  byName.addEventListener("keydown", (e) => { if (e.key === "Enter") addNamed(); });
  asSel.addEventListener("change", () => syncNoBuffs());

  let avail = false;
  /** No Buffs applies to combat items only (by selection or by name). */
  function syncNoBuffs() {
    const v = asSel.value || "auto";
    const combat = v === "auto" || Object.prototype.hasOwnProperty.call(kindLabels, v);
    noBuffs.cb.disabled = !avail || !combat;
  }

  /** "Add as": Auto, then the combat kinds and the consumable types as two option groups. */
  function fillAs(kinds, types) {
    const sig = JSON.stringify([kinds, types]);
    if (asSel._rvtOpts === sig) return;
    const keep = asSel.value || "auto";
    asSel._rvtOpts = sig;
    asSel.textContent = "";
    const opt = (value, text, parent) => {
      const o = el(doc, "option", null, text);
      o.value = value;
      parent.appendChild(o);
    };
    opt("auto", "Auto-detect", asSel);
    const g1 = el(doc, "optgroup");
    g1.setAttribute("label", "Combat item");
    for (const k of kinds) opt(k, labelOf(k), g1);
    const g2 = el(doc, "optgroup");
    g2.setAttribute("label", "Consumable");
    for (const t of types) opt(t, labelOf(t), g2);
    asSel.append(g1, g2);
    asSel.value = [...kinds, ...types].includes(keep) ? keep : "auto";
  }

  function buildCombat(v) {
    combatList.textContent = "";
    if (!v.combatAvailable) {
      combatList.appendChild(el(doc, "div", "rvt-empty", "Start the bot to edit the Items list."));
      return;
    }
    const entries = v.combat || [];
    if (!entries.length) {
      combatList.appendChild(el(doc, "div", "rvt-empty", "No combat items — select a wand, weapon, shield or pet essence and Add."));
      return;
    }
    for (const e of entries) {
      const it = el(doc, "div", `rvt-item rvt-item-row${e.noBuffs ? " is-nobuffs" : ""}${e.owned ? "" : " is-missing"}`);
      it.dataset.guid = String(e.guid);
      const name = el(doc, "span", "rvt-grow", e.name || `0x${e.guid.toString(16)}`);
      name.title = e.owned ? e.name : `${e.name} — not in this character's inventory`;
      const kind = select(doc, (v.kinds || []).map((k) => [k, labelOf(k)]), "rvt-item-kind");
      kind.value = e.kind;
      kind.title = "Item kind";
      kind.addEventListener("change", () => done(bridge.items.update(e.guid, { kind: kind.value })));
      const elem = select(doc, [["", "— element"], ...(v.elements || []).map((x) => [x, x])], "rvt-item-element");
      elem.value = e.element || "";
      elem.title = "Damage element (Auto damage type falls back to it)";
      elem.addEventListener("change", () => done(bridge.items.update(e.guid, { element: elem.value || null })));
      const nb = checkbox(doc, "No Buffs", "Skip this item when buffing");
      nb.cb.checked = e.noBuffs;
      nb.cb.addEventListener("change", () => done(bridge.items.update(e.guid, { noBuffs: nb.cb.checked })));
      const rm = iconBtn(doc, "✕", "Remove from the Items list", "is-danger");
      rm.addEventListener("click", () => done(bridge.items.remove(e.guid), "Removed"));
      const acts = el(doc, "span", "rvt-acts");
      acts.appendChild(rm);
      it.append(name, kind, elem, nb.lab, acts);
      combatList.appendChild(it);
    }
  }

  function buildCons(v) {
    consList.textContent = "";
    if (!v.consumablesAvailable) {
      consList.appendChild(el(doc, "div", "rvt-empty", "Start the bot to edit the Consumables list."));
      return;
    }
    const entries = v.consumables || [];
    if (!entries.length) {
      consList.appendChild(el(doc, "div", "rvt-empty", "No consumables — select a kit, potion, food, mana stone… and Add."));
      return;
    }
    const types = (v.types || []).map((t) => [t, labelOf(t)]);
    for (const e of entries) {
      const it = el(doc, "div", "rvt-item rvt-cons-row");
      it.dataset.guid = String(e.guid);
      const name = el(doc, "span", "rvt-grow", e.name || `0x${e.guid.toString(16)}`);
      name.title = e.name;
      const t = select(doc, types, "rvt-cons-rowtype");
      t.value = e.type;
      t.title = "Consumable type";
      t.addEventListener("change", () => done(bridge.consumables.update(e.guid, { type: t.value })));
      // name · that type's extras · type (a fixed column) · ✕
      it.append(name);
      if (e.type === "PeaComponent") {
        const keep = numInput(doc, { min: 0, step: 1, placeholder: "keep ≥", cls: "rvt-num-xs rvt-cons-keep" });
        keep.value = e.keepAtLeast != null ? String(e.keepAtLeast) : "";
        keep.title = "Split a pea when you have fewer than this many";
        keep.addEventListener("change", () => done(bridge.consumables.update(e.guid, { keepAtLeast: keep.value === "" ? null : Number(keep.value) })));
        const useSel = btn(doc, e.toolName ? "⚒ tool" : "⚒ set tool", `${e.toolName ? `Splitting tool: ${e.toolName}` : "No splitting tool yet"} — click to use the selected inventory item`);
        useSel.classList.toggle("is-active", !!e.toolName);
        useSel.addEventListener("click", () => done(bridge.consumables.setToolFromSelection(e.guid), "Tool set"));
        it.append(el(doc, "span", "rvt-lbl", "keep ≥"), keep, useSel);
      } else if (e.type === "BuffItem") {
        it.append(el(doc, "span", "rvt-kind", e.durationS != null ? `lasts ${fmtSecs(e.durationS)}` : "duration unknown"));
      }
      it.appendChild(t);
      const rm = iconBtn(doc, "✕", "Remove", "is-danger");
      rm.addEventListener("click", () => done(bridge.consumables.remove(e.guid), "Removed"));
      const acts = el(doc, "span", "rvt-acts");
      acts.appendChild(rm);
      it.appendChild(acts);
      consList.appendChild(it);
    }
  }

  function update(snap, { force = false } = {}) {
    const v = snap?.view || {};
    if (v.kindLabels && typeof v.kindLabels === "object") kindLabels = { ...KIND_LABELS_FALLBACK, ...v.kindLabels };
    fillAs(v.kinds || Object.keys(KIND_LABELS_FALLBACK), v.types || Object.keys(CONSUMABLE_LABELS));
    if (shouldRebuild(combatList, JSON.stringify([v.combatAvailable, v.combat]), force)) buildCombat(v);
    if (shouldRebuild(consList, JSON.stringify([v.consumablesAvailable, v.consumables]), force)) buildCons(v);
    setText(combatMeta, v.combatAvailable ? `${(v.combat || []).length}` : "");
    setText(consMeta, v.consumablesAvailable ? `${(v.consumables || []).length}` : "");
    // the selection preview
    const s = v.selection;
    selName.classList.toggle("is-none", !s);
    setText(selName, s ? `${s.name || `0x${(Number(s.guid) >>> 0).toString(16)}`}${s.owned === false ? " (not in your inventory)" : ""}` : "select an item in your inventory");
    setTitle(selName, s ? (s.kind ? `Auto adds it as a combat item: ${labelOf(s.kind)}` : "Auto adds it as a consumable (type detected from the item)") : "");
    avail = !!v.available;
    for (const b of [add, addName, byName, asSel]) b.disabled = !avail;
    add.disabled = !avail || !s;
    syncNoBuffs();
  }

  return { id: "items", el: root, snapshotId: () => "items", update };
}

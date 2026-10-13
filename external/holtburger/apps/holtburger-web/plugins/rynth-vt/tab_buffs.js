// plugins/rynth-vt/tab_buffs.js — the VTank Buffs tab (G:183, D21, D38).
//
// Top: the self-buff list in the macro's own order (buff_loop.js
// buildDynamicBuffList over the spells you know) with the resolved tier,
// school, time remaining and an Enabled box per spell; "Auto" maintains every
// known self buff. The enabled set is projected to the running bot through
// bot.setBuffs (list "buffs" = { spec, disabled }).
// Below: one block per Items-tab entry with its item-buff families
// (Impenetrability + the seven banes; a plain-Add shield gets all eight by
// default, other kinds none) and "Reset to default". No-Buffs items are shown
// greyed and cannot be changed (G:157).

import { el, btn, setText, setValue, shouldRebuild, sectionTitle, note, row, checkbox, fmtSecs } from "./widgets.js";

export function createBuffsTab(ctx) {
  const { doc, bridge } = ctx;
  const root = el(doc, "div", "rvt-tab-body rvt-tab-buffs");
  root.dataset.tab = "buffs";

  root.appendChild(sectionTitle(doc, "Self buffs"));
  const auto = checkbox(doc, "Auto — maintain every self buff you know", "The bot picks the best tier of every known self buff");
  const status = el(doc, "span", "rvt-note");
  root.appendChild(row(doc, auto.lab, status));
  const list = el(doc, "div", "rvt-list rvt-buff-list");
  root.appendChild(list);

  root.appendChild(sectionTitle(doc, "Item buffs (Items tab)"));
  root.appendChild(note(doc, "Shields get Impenetrability and every bane by default; weapons and casters get none (their auras are self buffs)."));
  const items = el(doc, "div", "rvt-list rvt-itembuff-list");
  root.appendChild(items);

  const done = async (p, okText) => {
    const r = await p;
    ctx.report(r, okText);
    ctx.refresh({ force: true });
    return r;
  };
  auto.cb.addEventListener("change", () => done(bridge.buffs.setAuto(auto.cb.checked), auto.cb.checked ? "Buffs: auto" : "Buffs: fixed list"));

  function buildRows(v) {
    list.textContent = "";
    if (v.loading) {
      list.appendChild(el(doc, "div", "hbk-empty", "Loading the spell ladder…"));
      return;
    }
    if (v.error) {
      list.appendChild(el(doc, "div", "hbk-empty", `Buff list unavailable: ${v.error}`));
      return;
    }
    if (!(v.rows || []).length) {
      list.appendChild(el(doc, "div", "hbk-empty", "No known self buffs (log in, or learn some spells)."));
      return;
    }
    for (const r of v.rows) {
      const it = el(doc, "div", "rvt-item rvt-buff-row");
      it.dataset.spell = String(r.spellId);
      const en = checkbox(doc, "", "Enabled");
      en.cb.checked = !!r.enabled;
      en.cb.addEventListener("change", () => done(bridge.buffs.setEnabled(r.spellId, en.cb.checked)));
      const rem = el(doc, "span", "rvt-note rvt-buff-rem", r.permanent ? "permanent" : fmtSecs(r.remainingS));
      it.append(en.cb, el(doc, "span", "rvt-grow", r.name), el(doc, "span", "rvt-note", r.tier != null ? `T${r.tier}` : ""),
        el(doc, "span", "rvt-note", r.schoolName || ""), rem);
      list.appendChild(it);
    }
  }

  function buildItems(v) {
    items.textContent = "";
    const rows = v.items || [];
    if (!rows.length) {
      items.appendChild(el(doc, "div", "hbk-empty", "No Items-tab entries."));
      return;
    }
    for (const it of rows) {
      const box = el(doc, "div", `rvt-item rvt-itembuff${it.noBuffs ? " is-nobuffs" : ""}`);
      box.dataset.guid = String(it.guid);
      const head = row(doc, el(doc, "span", "rvt-grow", `${it.name} (${it.kind})${it.noBuffs ? " — No Buffs" : it.overridden ? " — custom" : ""}`));
      const reset = btn(doc, "Reset to default", "Use the default families for this kind");
      reset.disabled = it.noBuffs || !it.overridden;
      reset.addEventListener("click", () => done(bridge.buffs.resetItemSpells(it.guid), "Reset to default"));
      head.appendChild(reset);
      const fams = el(doc, "div", "rvt-fams");
      for (const f of it.families) {
        const c = checkbox(doc, f.label, `${f.family}${f.dflt ? " (default for this kind)" : ""}`);
        c.cb.checked = !!f.on;
        c.cb.disabled = !!it.noBuffs;
        c.cb.dataset.family = f.family;
        c.cb.addEventListener("change", () => done(bridge.buffs.setItemSpell(it.guid, f.family, c.cb.checked)));
        fams.appendChild(c.lab);
      }
      const wrap = el(doc, "div", "rvt-itembuff-wrap");
      wrap.append(head, fams);
      box.appendChild(wrap);
      items.appendChild(box);
    }
  }

  function update(snap, { force = false } = {}) {
    const v = snap?.view || {};
    setValue(auto.cb, !!v.auto);
    auto.cb.disabled = snap?.settings === false;
    setText(status, v.loading ? "loading…" : v.present ? "" : "start the bot to apply buffs live");
    const rowSig = JSON.stringify([v.loading, v.error, (v.rows || []).map((r) => [r.spellId, r.enabled, r.name])]);
    if (shouldRebuild(list, rowSig, force)) buildRows(v);
    else {
      // cheap live text: time remaining
      for (const r of v.rows || []) {
        const it = list.querySelector(`.rvt-buff-row[data-spell='${r.spellId}'] .rvt-buff-rem`);
        if (it) setText(it, r.permanent ? "permanent" : fmtSecs(r.remainingS));
      }
    }
    if (shouldRebuild(items, JSON.stringify(v.items || []), force)) buildItems(v);
  }

  return { id: "buffs", el: root, snapshotId: () => "buffs", update };
}

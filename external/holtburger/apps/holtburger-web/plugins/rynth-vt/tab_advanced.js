// plugins/rynth-vt/tab_advanced.js — the VTank panel's Advanced tab (G:6:
// "Advanced Options: … control of all internal macro variables"; v2,
// 2026-10-19).
//
// Lists every option no other tab shows (Buffing tiers, Combat, Navigation,
// Mana, Consumables, Pets refill …) as typed editors, grouped; the options
// that do nothing on the web ("Not on web", D19) are folded away below and
// still round-trip through /rs opt and metas. The filter searches EVERY
// option — including the ones on Main, Buffs, Loot and the command bar — and
// says where each match normally lives, so a VTank name typed from memory
// always finds its setting. v1 made this a sub-view of Options (two clicks)
// that repeated every row of the other tabs.

import { el, btn, setText, shouldRebuild, optionEditor, textInput, numInput, bindRow, ROMAN } from "./widgets.js";

const HOME_TEXT = Object.freeze({ bar: "command bar", main: "Main tab", buffs: "Buffs tab", loot: "Loot tab", hidden: "not shown" });
// The eight "Min skill for … tier N" rows of a family (buff tiers, war spell
// tiers) draw as ONE strip of eight fields under I … VIII.
const TIER_RE = /^(Buff)?MinSkillLevelTier([1-8])$/;
const TIER_TITLE = Object.freeze({ buff: "Min skill per buff tier", spell: "Min skill per spell tier" });

export function createAdvancedTab(ctx) {
  const { doc, bridge } = ctx;
  const root = el(doc, "div", "rvt-tab-body rvt-tab-advanced");
  root.dataset.tab = "advanced";

  const top = el(doc, "div", "rvt-row is-nowrap");
  const filter = textInput(doc, "search every option — name, VTank name or group", "rvt-grow rvt-adv-filter");
  const count = el(doc, "span", "rvt-faint rvt-adv-count");
  top.append(filter, count);
  root.appendChild(top);
  const groupsEl = el(doc, "div", "rvt-groups rvt-adv-groups");
  root.appendChild(groupsEl);
  const inertHead = el(doc, "div", "rvt-sec rvt-adv-inert-head");
  const inertToggle = btn(doc, "Show", "Options VTank has that do nothing on the web — stored and round-tripped through /rs opt and metas (D19)");
  const inertTitle = el(doc, "span", null, "Not on web");
  inertHead.append(inertTitle, el(doc, "span", "rvt-sec-meta"), inertToggle);
  root.appendChild(inertHead);
  const inertEl = el(doc, "div", "rvt-groups rvt-adv-inert");
  inertEl.hidden = true;
  root.appendChild(inertEl);

  const editors = new Map();
  let openedBySearch = false; // the search unfolded "Not on web" (fold it back when it is cleared)
  const commit = async (key, value) => {
    const r = await bridge.opt.set(key, value);
    ctx.report(r, (x) => x.echo || `${key} = ${x.value}`);
    ctx.refresh();
  };
  const onFilter = async () => {
    await bridge.opt.setFilter(filter.value);
    ctx.refresh({ force: true });
  };
  filter.addEventListener("input", onFilter);
  filter.addEventListener("change", onFilter);
  inertToggle.addEventListener("click", () => {
    openedBySearch = false; // the player's own choice now
    inertEl.hidden = !inertEl.hidden;
    setText(inertToggle, inertEl.hidden ? "Show" : "Hide");
  });

  /** One family's tier rows as a strip of numbered fields (each bound to its row). */
  function tierStrip(fam, rows) {
    const wrap = el(doc, "div", "rvt-opt rvt-tierstrip");
    wrap.dataset.key = `${fam}Tiers`;
    const label = el(doc, "span", "rvt-opt-label", TIER_TITLE[fam]);
    label.title = fam === "buff"
      ? "Cap buff/vital tiers by skill: the highest tier whose minimum your buffed skill reaches (BuffMinSkillLevelTier1-8)"
      : "The war/void spell tier each skill level reaches (MinSkillLevelTier1-8)";
    const grid = el(doc, "div", "rvt-tiergrid");
    for (const r of rows.slice().sort((a, b) => Number(TIER_RE.exec(a.key)[2]) - Number(TIER_RE.exec(b.key)[2]))) {
      const tier = Number(TIER_RE.exec(r.key)[2]);
      const cell = el(doc, "label", "rvt-tiercell");
      const input = numInput(doc, { cls: "rvt-tier-in" });
      input.dataset.key = r.key;
      cell.append(el(doc, "span", "rvt-faint", ROMAN[tier]), input);
      const upd = bindRow({ input, wrap: cell }, commit);
      upd(r);
      editors.set(r.key, { update: upd });
      grid.appendChild(cell);
    }
    wrap.append(label, grid);
    return wrap;
  }

  function build(container, groups, searching) {
    container.textContent = "";
    for (const g of groups) {
      const box = el(doc, "div", "rvt-group");
      box.appendChild(el(doc, "div", "rvt-sec", g.group));
      // a family with most of its eight tier rows here draws as one strip
      const fams = new Map();
      for (const r of g.rows) {
        const m = TIER_RE.exec(r.key);
        if (!m) continue;
        const fam = m[1] ? "buff" : "spell";
        if (!fams.has(fam)) fams.set(fam, []);
        fams.get(fam).push(r);
      }
      for (const [fam, rows] of [...fams]) if (rows.length < 4) fams.delete(fam);
      const drawn = new Set();
      for (const r of g.rows) {
        const m = TIER_RE.exec(r.key);
        const fam = m ? (m[1] ? "buff" : "spell") : null;
        if (fam && fams.has(fam)) {
          if (!drawn.has(fam)) box.appendChild(tierStrip(fam, fams.get(fam)));
          drawn.add(fam);
          continue;
        }
        const ed = optionEditor(doc, r, commit);
        editors.set(r.key, ed);
        if (searching && r.home && r.home !== "advanced") ed.wrap.appendChild(el(doc, "span", "rvt-home", HOME_TEXT[r.home] || r.home));
        box.appendChild(ed.wrap);
      }
      container.appendChild(box);
    }
  }

  function update(snap, { force = false } = {}) {
    const v = snap && snap.view ? snap.view : {};
    const groups = Array.isArray(v.groups) ? v.groups : [];
    const inert = Array.isArray(v.inert) ? v.inert : [];
    const sigOf = (gs) => JSON.stringify([!!v.searching, gs.map((g) => [g.group, g.rows.map((r) => r.key)])]);
    if (shouldRebuild(groupsEl, sigOf(groups), force)) {
      build(groupsEl, groups, !!v.searching);
      if (!groups.length && !inert.length) groupsEl.appendChild(el(doc, "div", "rvt-empty", v.total ? "No option matches." : "No settings yet — log in first."));
    }
    if (shouldRebuild(inertEl, sigOf(inert), force)) build(inertEl, inert, !!v.searching);
    for (const g of [...groups, ...inert]) for (const r of g.rows) editors.get(r.key)?.update(r);
    inertHead.hidden = !inert.length;
    setText(inertHead.querySelector(".rvt-sec-meta"), `${v.inertCount ?? 0}`);
    // a search shows its not-on-web matches; clearing it folds them back as they were
    if (v.searching && inert.length && inertEl.hidden && !openedBySearch) {
      openedBySearch = true;
      inertEl.hidden = false;
      setText(inertToggle, "Hide");
    } else if (!v.searching && openedBySearch) {
      openedBySearch = false;
      inertEl.hidden = true;
      setText(inertToggle, "Show");
    }
    setText(count, v.searching ? `${(v.count ?? 0) + (v.inertCount ?? 0)} of ${v.total ?? 0}` : `${v.count ?? 0} options`);
  }

  return { id: "advanced", el: root, snapshotId: () => "advanced", update };
}

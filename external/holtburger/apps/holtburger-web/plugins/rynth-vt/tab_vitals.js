// plugins/rynth-vt/tab_vitals.js — the VTank Vitals tab (G:60-66): the
// top-off levels used when there is no combat target, the in-combat
// recharge levels, and the three web-only extras (emergency HP, stamina
// floors). Values are the live vitals.js thresholds (cells) under the active
// profile; Default edits last for the page session only.

import { el, shouldRebuild, sectionTitle, note, optionEditor } from "./widgets.js";

export function createVitalsTab(ctx) {
  const { doc, bridge } = ctx;
  const root = el(doc, "div", "rvt-tab-body rvt-tab-vitals");
  root.dataset.tab = "vitals";
  root.appendChild(note(doc, "Levels (percent) the macro recharges to. Top-off levels apply when there is no active combat target."));
  const body = el(doc, "div", "rvt-groups");
  root.appendChild(body);
  const editors = new Map();

  const commit = async (key, value) => {
    ctx.report(await bridge.opt.set(key, value), (x) => x.echo || `${key} = ${x.value}`);
    ctx.refresh();
  };

  function update(snap, { force = false } = {}) {
    const groups = Array.isArray(snap?.view?.groups) ? snap.view.groups : [];
    const sig = JSON.stringify(groups.map((g) => [g.group, g.rows.map((r) => r.key)]));
    if (shouldRebuild(body, sig, force)) {
      body.textContent = "";
      editors.clear();
      if (!groups.length) body.appendChild(el(doc, "div", "hbk-empty", "No settings yet — log in first."));
      for (const g of groups) {
        const box = el(doc, "div", "rvt-group");
        box.appendChild(sectionTitle(doc, g.group));
        for (const r of g.rows) {
          const ed = optionEditor(doc, r, commit);
          editors.set(r.key, ed);
          box.appendChild(ed.wrap);
        }
        body.appendChild(box);
      }
      return;
    }
    for (const g of groups) for (const r of g.rows) editors.get(r.key)?.update(r);
  }

  return { id: "vitals", el: root, snapshotId: () => "vitals", update };
}

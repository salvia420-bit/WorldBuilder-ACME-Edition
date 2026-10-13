// plugins/rynth-vt/tab_options.js — the VTank Options tab (G:1-42) and its
// "Advanced Options…" sub-view (G:6: every internal macro variable).
//
// Layout follows the VTank Options page: Run Macro + Advanced Options… on
// top, Force Buff / Cancel Force Buff, then the option groups (Ranges,
// Subsystems, Inventory, Dispel, Fellowship, Mana, Priority, Idle, Pets) as
// typed editors built from the schema rows the bridge serves. The Advanced
// sub-view lists EVERY schema row grouped, with a filter; rows that do
// nothing on the web ("inert") are greyed but still round-trip (D19).

import { el, btn, setText, setTitle, shouldRebuild, sectionTitle, note, row, optionEditor, textInput } from "./widgets.js";

export function createOptionsTab(ctx) {
  const { doc, bridge } = ctx;
  const root = el(doc, "div", "rvt-tab-body rvt-tab-options");
  root.dataset.tab = "options";

  // ── main view ────────────────────────────────────────────────────────────
  const main = el(doc, "div", "rvt-sub rvt-options-main");
  const top = row(doc);
  const run = btn(doc, "RUN", "Run Macro: pause/resume the bot (G:7)", "rvt-run");
  const adv = btn(doc, "Advanced Options…", "Every macro variable (G:6)");
  const fb = btn(doc, "Force Buff", "Recast every buff now; pausing the macro resumes where it left off (G:10)");
  const cfb = btn(doc, "Cancel Force Buff", "Cancel a Force Buff sequence (G:11)");
  top.append(run, adv, fb, cfb);
  main.appendChild(top);
  const groupsEl = el(doc, "div", "rvt-groups");
  main.appendChild(groupsEl);
  root.appendChild(main);

  // ── advanced sub-view ────────────────────────────────────────────────────
  const advEl = el(doc, "div", "rvt-sub rvt-options-advanced");
  advEl.hidden = true;
  const advTop = row(doc);
  const back = btn(doc, "◂ Options", "Back to the Options tab");
  const filter = textInput(doc, "filter (name, VTank name, group)", "rvt-grow");
  const count = el(doc, "span", "rvt-note");
  advTop.append(back, filter, count);
  advEl.append(advTop, note(doc, "Greyed rows are not implemented on the web; they are stored and round-trip through /rs opt and metas."));
  const advGroups = el(doc, "div", "rvt-adv-groups");
  advEl.appendChild(advGroups);
  root.appendChild(advEl);

  let sub = "main";
  const editors = new Map(); // key → editor (main + advanced share nothing; rebuilt per view)

  const commit = async (key, value) => {
    const r = await bridge.opt.set(key, value);
    ctx.report(r, (x) => x.echo || `${key} = ${x.value}`);
    ctx.refresh();
  };

  run.addEventListener("click", async () => {
    run.disabled = true;
    try {
      ctx.report(await bridge.run.toggle());
    } finally {
      run.disabled = false;
      ctx.refresh({ force: true });
    }
  });
  adv.addEventListener("click", () => ctx.setSub("advanced"));
  back.addEventListener("click", () => ctx.setSub(null));
  fb.addEventListener("click", async () => ctx.report(await bridge.run.forceBuff(), "Force buff"));
  cfb.addEventListener("click", async () => ctx.report(await bridge.run.cancelForceBuff(), "Force buff cancelled"));
  filter.addEventListener("input", async () => {
    await bridge.opt.setFilter(filter.value);
    ctx.refresh({ force: true });
  });
  filter.addEventListener("change", async () => {
    await bridge.opt.setFilter(filter.value);
    ctx.refresh({ force: true });
  });

  function buildGroups(container, groups, cls) {
    container.textContent = "";
    editors.clear();
    if (!groups.length) {
      container.appendChild(el(doc, "div", "hbk-empty", "No settings yet — log in first."));
      return;
    }
    for (const g of groups) {
      const box = el(doc, "div", `rvt-group ${cls}`);
      box.appendChild(sectionTitle(doc, g.group));
      for (const r of g.rows) {
        const ed = optionEditor(doc, r, commit);
        editors.set(r.key, ed);
        box.appendChild(ed.wrap);
      }
      container.appendChild(box);
    }
  }

  function setView(which) {
    sub = which === "advanced" ? "advanced" : "main";
    main.hidden = sub !== "main";
    advEl.hidden = sub !== "advanced";
    groupsEl._rvtSig = null;
    advGroups._rvtSig = null;
  }

  function update(snap, { force = false } = {}) {
    const v = snap && snap.view ? snap.view : {};
    const isAdv = snap && snap.tab === "advanced";
    if ((isAdv ? "advanced" : "main") !== sub) setView(isAdv ? "advanced" : "main");
    const container = isAdv ? advGroups : groupsEl;
    const groups = Array.isArray(v.groups) ? v.groups : [];
    const sig = JSON.stringify(groups.map((g) => [g.group, g.rows.map((r) => r.key)]));
    if (shouldRebuild(container, sig, force)) buildGroups(container, groups, isAdv ? "is-advanced" : "is-main");
    else for (const g of groups) for (const r of g.rows) editors.get(r.key)?.update(r);
    if (isAdv) {
      setText(count, `${v.count ?? 0} options`);
      return;
    }
    const rs = v.run || snap.run || {};
    const state = rs.phase === "running" ? "running" : rs.phase === "stopped" ? "stopped" : "off";
    if (run.dataset.state !== state) run.dataset.state = state;
    setText(run, rs.phase === "running" ? "RUNNING" : rs.phase === "stopped" ? "STOPPED" : "START");
    setTitle(run, rs.phase === "running" ? "Run Macro is on — click to pause" : rs.phase === "stopped" ? "Paused — click to resume" : "Start the bot (HUD START / ?bot=1)");
    const fr = v.forceRebuff || {};
    fb.disabled = !snap.present;
    cfb.disabled = !snap.present || fr.cancellable === false;
    fb.classList.toggle("is-active", !!fr.active);
  }

  return {
    id: "options",
    el: root,
    snapshotId: () => (sub === "advanced" ? "advanced" : "options"),
    setSub: (s) => setView(s === "advanced" ? "advanced" : "main"),
    get sub() {
      return sub;
    },
    update,
  };
}

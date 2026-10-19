// plugins/rynth-vt/tab_main.js — the VTank panel's Main tab (v2,
// 2026-10-19): VTank's Options page (G:14-42) and Vitals page (G:60-66) on
// one screen.
//
//   Vitals     live HP / Stam / Mana bars with the two recharge levels marked
//              on them (gold = top-off with no combat target, white = in
//              combat), the matrix that sets those levels, and the two
//              conditional rules of rynth/vitals.js: the emergency
//              Stamina→Health cast (HP ≤ x % while Stam > y %, B15) and the
//              Stamina→Mana floor (B16).
//   Ranges     Monster · Ring · Approach · Follow/Nav Min (metres).
//   Pets       Summon Pets, Custom Pet Range (+ metres), Pet Min. Monsters.
//   Behaviour  the Options-page switches: Boost Nav / Loot Priority, Peace
//              Mode / Rebuff When Idle, Autostack, Autocram, dispel items /
//              self, Auto Fellow Mgmt., Mana charges when off.
//
// The subsystem switches are on the command bar; every other option is on the
// Advanced tab. Values come from the bridge (schema rows with live values; a
// value that differs from its default is drawn gold) and every change is
// saved to the active profile at once (G:48).

import { el, setText, setTitle, shouldRebuild, optionEditor, numField, bindRow, checkbox } from "./widgets.js";

const VITALS = Object.freeze([
  { id: "hp", label: "Health" },
  { id: "st", label: "Stamina" },
  { id: "mn", label: "Mana" },
]);
const RANGE_LABELS = Object.freeze({
  MonsterRange: "Monster range",
  RingRange: "Ring range",
  ApproachRange: "Approach",
  FollowNavMin: "Follow/Nav min",
});

export function createMainTab(ctx) {
  const { doc, bridge } = ctx;
  const root = el(doc, "div", "rvt-tab-body rvt-tab-main");
  root.dataset.tab = "main";
  const empty = el(doc, "div", "rvt-empty", "No settings yet — log in first.");
  empty.hidden = true;
  root.appendChild(empty);
  const grid = el(doc, "div", "rvt-main");
  root.appendChild(grid);

  const commit = async (key, value) => {
    ctx.report(await bridge.opt.set(key, value), (x) => x.echo || `${key} = ${x.value}`);
    ctx.refresh();
  };
  const card = (title, cls = "") => {
    const c = el(doc, "div", `rvt-card${cls ? ` ${cls}` : ""}`);
    c.appendChild(el(doc, "div", "rvt-card-title", title));
    grid.appendChild(c);
    return c;
  };
  const binders = []; // [key path → update fn]

  // ── Vitals ───────────────────────────────────────────────────────────────
  const vit = card("Vitals — recharge levels (%)", "rvt-span2 rvt-vitals");
  const mx = el(doc, "div", "rvt-vit");
  vit.appendChild(mx);
  mx.appendChild(el(doc, "span"));
  for (const v of VITALS) mx.appendChild(el(doc, "span", `rvt-vit-h is-${v.id}`, v.label));
  // live bars
  const nowLbl = el(doc, "span", "rvt-lbl", "Now");
  nowLbl.title = "Your vitals right now; the marks are where the macro recharges";
  mx.appendChild(nowLbl);
  const bars = {};
  for (const v of VITALS) {
    const bar = el(doc, "div", `rvt-vbar is-${v.id}`);
    const fill = el(doc, "div", "rvt-vbar-fill");
    const idle = el(doc, "div", "rvt-vmark is-idle");
    const fight = el(doc, "div", "rvt-vmark is-combat");
    const text = el(doc, "div", "rvt-vbar-text", "—");
    bar.append(fill, idle, fight, text);
    mx.appendChild(bar);
    bars[v.id] = { bar, fill, idle, fight, text };
  }
  // the matrix rows
  const matrixRow = (label, tip, path) => {
    const l = el(doc, "span", "rvt-lbl", label);
    l.title = tip;
    mx.appendChild(l);
    for (const v of VITALS) {
      const cell = el(doc, "span", "rvt-vit-cell");
      const f = numField(doc, { unit: "%" });
      f.input.dataset.key = `${path}.${v.id}`;
      cell.appendChild(f.wrap);
      mx.appendChild(cell);
      binders.push([(vw) => vw.vitals[path][v.id], bindRow(f, commit)]);
    }
  };
  matrixRow("Top-off", "No combat target: recharge up to these levels (Recharge-NoTarg, G:64-66)", "topOff");
  matrixRow("In combat", "Fighting: recharge when a vital drops below these levels (Recharge-Norm)", "combat");
  const legend = el(doc, "div", "rvt-vit-legend");
  const key = (cls, text) => {
    const s = el(doc, "span");
    s.append(el(doc, "span", `rvt-key ${cls}`), doc.createTextNode(text));
    return s;
  };
  legend.append(key("is-idle", "top-off mark"), key("is-combat", "in-combat mark"));
  mx.appendChild(legend);
  // the two conditional rules
  const ruleField = (getRow, dataKey) => {
    const f = numField(doc, { unit: "%" });
    f.input.dataset.key = dataKey;
    binders.push([getRow, bindRow(f, commit)]);
    return f.wrap;
  };
  const r1 = el(doc, "div", "rvt-rule-line");
  r1.title = "rynth/vitals.js B15: below every other level, convert stamina to health — if there is stamina to spare";
  r1.append(
    el(doc, "span", "rvt-dim", "Emergency Stam→HP when HP ≤"),
    ruleField((vw) => vw.vitals.emergencyHp, "EmergencyHP"),
    el(doc, "span", "rvt-dim", "and Stam >"),
    ruleField((vw) => vw.vitals.emergencyStamFloor, "EmergencyStamFloor"),
    el(doc, "span", "rvt-dim", "·  Stam→Mana only while Stam >"),
    ruleField((vw) => vw.vitals.manaRechargeStamFloor, "ManaRechargeStamFloor"),
  );
  vit.appendChild(r1);

  // ── Ranges ───────────────────────────────────────────────────────────────
  const rng = card("Ranges");
  const rg = el(doc, "div", "rvt-ranges");
  rng.appendChild(rg);
  for (const k of Object.keys(RANGE_LABELS)) {
    const l = el(doc, "span", "rvt-lbl", RANGE_LABELS[k]);
    const f = numField(doc, { unit: "m", cls: "rvt-num-xs" });
    f.input.dataset.key = k;
    rg.append(l, f.wrap);
    binders.push([(vw) => vw.ranges.find((r) => r.key === k) || null, bindRow({ ...f, tip: l }, commit)]);
  }

  // ── Pets ─────────────────────────────────────────────────────────────────
  const pets = card("Pets");
  const summon = checkbox(doc, "Summon Pets");
  summon.cb.dataset.key = "SummonPets";
  const custom = checkbox(doc, "Custom range");
  custom.cb.dataset.key = "CustomPetRangeEnabled";
  const customM = numField(doc, { unit: "m" });
  customM.input.dataset.key = "CustomPetRange";
  const minMon = numField(doc, { unit: "" });
  minMon.input.dataset.key = "PetMinMonsters";
  const pr1 = el(doc, "div", "rvt-row is-nowrap");
  pr1.append(summon.lab);
  const pr2 = el(doc, "div", "rvt-row is-nowrap");
  pr2.append(custom.lab, customM.wrap);
  const pr3 = el(doc, "div", "rvt-row is-nowrap");
  const mmLbl = el(doc, "span", "rvt-lbl", "Min. monsters");
  pr3.append(mmLbl, minMon.wrap);
  pets.append(pr1, pr2, pr3);
  const petRow = (k) => (vw) => vw.pets.find((r) => r.key === k) || null;
  binders.push([petRow("SummonPets"), bindRow({ input: summon.cb, tip: summon.lab }, commit)]);
  binders.push([petRow("CustomPetRangeEnabled"), bindRow({ input: custom.cb, tip: custom.lab }, commit)]);
  binders.push([petRow("CustomPetRange"), bindRow(customM, commit)]);
  binders.push([petRow("PetMinMonsters"), bindRow({ ...minMon, tip: mmLbl }, commit)]);

  // ── Behaviour (the Options-page switches; built from the rows) ───────────
  const beh = card("Behaviour", "rvt-span2");
  const checks = el(doc, "div", "rvt-checks");
  beh.appendChild(checks);
  const behEditors = new Map();

  function update(snap, { force = false } = {}) {
    const v = snap && snap.view ? snap.view : {};
    const avail = !!v.available;
    empty.hidden = avail;
    grid.hidden = !avail;
    if (!avail) return;
    for (const [get, upd] of binders) {
      let row = null;
      try { row = get(v); } catch { row = null; }
      upd(row);
    }
    const rows = Array.isArray(v.behaviour) ? v.behaviour : [];
    if (shouldRebuild(checks, JSON.stringify(rows.map((r) => r.key)), force)) {
      checks.textContent = "";
      behEditors.clear();
      for (const r of rows) {
        const ed = optionEditor(doc, r, commit);
        behEditors.set(r.key, ed);
        checks.appendChild(ed.wrap);
      }
    } else for (const r of rows) behEditors.get(r.key)?.update(r);
    // live bars + marks
    const live = (v.vitals && v.vitals.live) || {};
    for (const vd of VITALS) {
      const b = bars[vd.id];
      const cur = live[vd.id];
      const pct = cur && cur.max > 0 ? Math.max(0, Math.min(100, (cur.cur / cur.max) * 100)) : null;
      b.fill.style.setProperty("width", `${pct == null ? 0 : pct.toFixed(1)}%`);
      setText(b.text, pct == null ? "—" : `${Math.round(pct)}%`);
      setTitle(b.bar, cur ? `${vd.label} ${Math.round(cur.cur)} / ${Math.round(cur.max)}` : `${vd.label}: not logged in`);
      const idle = v.vitals.topOff[vd.id];
      const fight = v.vitals.combat[vd.id];
      for (const [mark, row] of [[b.idle, idle], [b.fight, fight]]) {
        const at = row && typeof row.value === "number" ? Math.max(0, Math.min(100, row.value)) : null;
        mark.hidden = at == null || at <= 0;
        if (at != null) mark.style.setProperty("left", `${at}%`);
      }
    }
  }

  return { id: "main", el: root, snapshotId: () => "main", update };
}

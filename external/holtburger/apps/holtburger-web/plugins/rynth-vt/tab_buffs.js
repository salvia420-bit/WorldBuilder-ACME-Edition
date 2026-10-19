// plugins/rynth-vt/tab_buffs.js — the VTank Buffs tab (G:183, D21, D38; v2
// layout 2026-10-19).
//
//   header      Auto (maintain every self buff you know) · rebuff below N s ·
//               cap tiers by magic skill · Force Buff / Cancel (G:10-11)
//   summary     how many buffs are maintained, on you, due, missing
//   self buffs  the macro's own list (buff_loop.js buildDynamicBuffList over
//               the spells you know — RynthAi order), grouped (Attributes ·
//               Defenses · Masteries · Regeneration · Protections · Weapon
//               auras), two columns: Enabled box, the buff, its tier and the
//               time left — green, yellow (under twice the rebuff threshold),
//               orange (under it: recast now), red (maintained but not on
//               you). A group's box turns the whole group on or off.
//   item buffs  a matrix of Impenetrability and the seven banes: first "Worn
//               armor" — cast on yourself, the server puts each on every armor
//               and clothing piece you wear and on your shield (the options
//               BuffArmorImpen and BuffProfileBanes' letters, 2026-10-19) —
//               then the Items tab's weapons and shields (a plain-Add shield
//               gets all eight by default, other kinds none, D38; a worn
//               piece's boxes are left to the Worn armor row); No-Buffs items
//               greyed (G:157).
// The enabled set is projected to the running bot through bot.setBuffs (list
// "buffs" = { spec, disabled, itemSpells }); the Worn armor row writes its two
// options.

import {
  el, btn, setText, setTitle, setValue, shouldRebuild, row, checkbox, fmtSecs, numField, bindRow, iconBtn,
} from "./widgets.js";

const BANE_SHORT = Object.freeze({
  impen: "Imp", "bane:slash": "Blade", "bane:pierce": "Pierce", "bane:bludgeon": "Bludg", "bane:fire": "Flame",
  "bane:cold": "Frost", "bane:lightning": "Light", "bane:acid": "Acid",
});

const timeText = (r) => {
  if (r.permanent) return "∞";
  if (r.state === "off") return "off";
  if (r.remainingS == null) return "missing";
  return fmtSecs(r.remainingS);
};

const WORN_TIP =
  "Cast on yourself: the server puts Impenetrability and each bane on every armor and clothing piece you wear, " +
  "and on your shield — one cast per box, after your self buffs. A worn shield's own boxes below are not cast for these.";

/** The bane letters (BuffProfileBanes) with `letter` switched on or off, in VTank's order. */
const withLetter = (w, letter, on) =>
  [...(w.order || "ALFCBPS")].filter((c) => (c === letter ? on : String(w.letters || "").includes(c))).join("");

export function createBuffsTab(ctx) {
  const { doc, bridge } = ctx;
  const root = el(doc, "div", "rvt-tab-body rvt-tab-buffs");
  root.dataset.tab = "buffs";

  // ── header ───────────────────────────────────────────────────────────────
  const auto = checkbox(doc, "Auto — every self buff you know", "The bot keeps up the best tier of every known self buff (RynthAi BuildDynamicBuffList)");
  const rebuff = numField(doc, { unit: "s" });
  rebuff.input.dataset.key = "RebuffSecondsRemaining";
  const rebuffLbl = el(doc, "span", "rvt-lbl", "rebuff below");
  const cap = checkbox(doc, "Cap tiers by skill");
  cap.cb.dataset.key = "BuffTierSkillCap";
  const fb = btn(doc, "Force Buff", "Recast every buff now; pausing the macro resumes where it left off (G:10)");
  const cfb = btn(doc, "Cancel", "Cancel a Force Buff sequence (G:11)");
  root.appendChild(row(doc, auto.lab, rebuffLbl, rebuff.wrap, cap.lab, el(doc, "span", "rvt-grow"), fb, cfb));
  const summary = el(doc, "div", "rvt-bsum");
  root.appendChild(summary);

  const list = el(doc, "div", "rvt-buff-groups");
  root.appendChild(list);

  const itemsHead = el(doc, "div", "rvt-sec", "Item buffs");
  const itemsMeta = el(doc, "span", "rvt-sec-meta", "worn armor: one cast on you per box · shields get Impenetrability + every bane by default; weapons and casters none");
  itemsHead.appendChild(itemsMeta);
  root.appendChild(itemsHead);
  const items = el(doc, "div", "rvt-itembuffs");
  root.appendChild(items);

  const done = async (p, okText) => {
    const r = await p;
    ctx.report(r, okText);
    ctx.refresh({ force: true });
    return r;
  };
  const commit = async (key, value) => {
    ctx.report(await bridge.opt.set(key, value), (x) => x.echo || `${key} = ${x.value}`);
    ctx.refresh();
  };
  const knob = { RebuffSecondsRemaining: bindRow({ ...rebuff, tip: rebuffLbl }, commit), BuffTierSkillCap: bindRow({ input: cap.cb, tip: cap.lab }, commit) };
  auto.cb.addEventListener("change", () => done(bridge.buffs.setAuto(auto.cb.checked), auto.cb.checked ? "Buffs: auto" : "Buffs: fixed list"));
  fb.addEventListener("click", async () => done(bridge.run.forceBuff(), "Force buff"));
  cfb.addEventListener("click", async () => done(bridge.run.cancelForceBuff(), "Force buff cancelled"));

  const groupMetas = new Map(); // group → its header's "on/total · due" text
  /** "6/6 · 2 due" — maintained / total, and how many are under the rebuff threshold or missing. */
  function groupMetaText(g) {
    const on = g.rows.filter((r) => r.enabled).length;
    const due = g.rows.filter((r) => r.state === "low" || r.state === "missing").length;
    return `${on}/${g.rows.length}${due ? ` · ${due} due` : ""}`;
  }

  function buildGroups(v) {
    list.textContent = "";
    groupMetas.clear();
    if (v.loading) {
      list.appendChild(el(doc, "div", "rvt-empty", "Loading the spell ladder…"));
      return;
    }
    if (v.error) {
      list.appendChild(el(doc, "div", "rvt-empty", `Buff list unavailable: ${v.error}`));
      return;
    }
    const groups = Array.isArray(v.groups) ? v.groups : [];
    if (!groups.length) {
      list.appendChild(el(doc, "div", "rvt-empty", "No known self buffs (log in, or learn some spells)."));
      return;
    }
    const collapsed = new Set(Array.isArray(ctx.pref("buffsCollapsed")) ? ctx.pref("buffsCollapsed") : []);
    for (const g of groups) {
      const head = el(doc, "div", "rvt-sec rvt-bgroup-head");
      head.dataset.group = g.group;
      const all = el(doc, "input", "hbk-check rvt-bgroup-all");
      all.type = "checkbox";
      const on = g.rows.filter((r) => r.enabled).length;
      all.checked = on === g.rows.length;
      all.title = `Maintain every ${g.group.toLowerCase()} buff (or none)`;
      all.addEventListener("change", () => done(bridge.buffs.setEnabledMany(g.rows.map((r) => r.spellId), all.checked), `${g.group}: ${all.checked ? "all on" : "all off"}`));
      const fold = el(doc, "span", "rvt-fold", collapsed.has(g.group) ? "▸" : "▾");
      const title = el(doc, "span", "rvt-fold-title", g.group);
      const meta = el(doc, "span", "rvt-sec-meta", groupMetaText(g));
      groupMetas.set(g.group, meta);
      head.append(all, fold, title, meta);
      head.title = "Click to fold / unfold";
      head.tabIndex = 0;
      head.setAttribute("role", "button");
      list.appendChild(head);
      const grid = el(doc, "div", "rvt-bgrid");
      grid.hidden = collapsed.has(g.group);
      head.setAttribute("aria-expanded", grid.hidden ? "false" : "true");
      const toggleFold = () => {
        grid.hidden = !grid.hidden;
        setText(fold, grid.hidden ? "▸" : "▾");
        head.setAttribute("aria-expanded", grid.hidden ? "false" : "true");
        if (grid.hidden) collapsed.add(g.group);
        else collapsed.delete(g.group);
        ctx.pref("buffsCollapsed", [...collapsed]);
      };
      head.addEventListener("click", (e) => {
        if (String(e?.target?.tagName || "").toUpperCase() === "INPUT") return;
        toggleFold();
      });
      head.addEventListener("keydown", (e) => {
        if (e.target !== head || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault?.();
        toggleFold();
      });
      for (const r of g.rows) {
        const it = el(doc, "div", `rvt-brow rvt-buff-row${r.enabled ? "" : " is-off"}`);
        it.dataset.spell = String(r.spellId);
        it.dataset.state = r.state || "ok";
        const en = el(doc, "input", "hbk-check");
        en.type = "checkbox";
        en.checked = !!r.enabled;
        en.title = r.enabled ? "Maintained — click to stop" : "Not maintained — click to keep it up";
        en.setAttribute("aria-label", `Maintain ${r.familyLabel || r.name}`);
        en.addEventListener("change", () => done(bridge.buffs.setEnabled(r.spellId, en.checked)));
        const name = el(doc, "span", "rvt-grow", r.familyLabel || r.name);
        name.title = `${r.name}${r.schoolName ? ` — ${r.schoolName}` : ""}`;
        const tier = el(doc, "span", "rvt-tier", r.tierText || (r.tier != null ? `T${r.tier}` : ""));
        tier.title = r.tier != null ? `Tier ${r.tier}: the best tier you know (the bot upgrades as you learn more)` : "";
        const rem = el(doc, "span", "rvt-btime rvt-buff-rem", timeText(r));
        it.append(en, name, tier, rem);
        grid.appendChild(it);
      }
      list.appendChild(grid);
    }
  }

  /** The "Worn armor" row: its cells are the options BuffArmorImpen (Imp) and
   *  the BuffProfileBanes letters (a bane cell writes the whole new string). */
  function wornRow(w, fams) {
    const tr = el(doc, "tr", "rvt-wornarmor");
    const name = el(doc, "td", "rvt-name", "Worn armor");
    name.title = WORN_TIP;
    tr.appendChild(name);
    const byFamily = new Map((w.families || []).map((f) => [f.family, f]));
    for (const fam of fams) {
      const f = byFamily.get(fam);
      const td = el(doc, "td");
      if (f) {
        const cb = el(doc, "input", "hbk-check");
        cb.type = "checkbox";
        cb.checked = !!f.on;
        cb.disabled = !w.available;
        cb.dataset.worn = f.family;
        cb.title = `${f.label} on every armor and clothing piece you wear${f.letter ? ` (bane letter ${f.letter})` : ""}`;
        cb.setAttribute("aria-label", `Worn armor: ${f.label}`);
        cb.addEventListener("change", () => {
          const [key, value] = f.letter ? ["BuffProfileBanes", withLetter(w, f.letter, cb.checked)] : ["BuffArmorImpen", cb.checked];
          done(bridge.opt.set(key, value), (x) => x.echo || `${key} = ${x.value}`);
        });
        td.appendChild(cb);
      }
      tr.appendChild(td);
    }
    tr.appendChild(el(doc, "td"));
    return tr;
  }

  function buildItems(v) {
    items.textContent = "";
    const rows = v.items || [];
    const worn = v.wornArmor || null;
    const none = () => el(doc, "div", "rvt-empty", "No weapons or shields on the Items tab.");
    if (!rows.length && !worn) {
      items.appendChild(none());
      return;
    }
    const fams = v.families || [];
    const t = el(doc, "table", "rvt-ibm");
    const head = el(doc, "tr");
    head.appendChild(el(doc, "th", "rvt-name", "Item"));
    for (const f of fams) {
      const th = el(doc, "th", null, BANE_SHORT[f] || f);
      th.title = (v.familyLabels && v.familyLabels[f]) || f;
      head.appendChild(th);
    }
    head.appendChild(el(doc, "th"));
    t.appendChild(head);
    if (worn) t.appendChild(wornRow(worn, fams));
    for (const it of rows) {
      const tr = el(doc, "tr", `rvt-itembuff${it.noBuffs ? " is-nobuffs" : ""}`);
      tr.dataset.guid = String(it.guid);
      const name = el(doc, "td", `rvt-name${it.overridden && !it.noBuffs ? " is-custom" : ""}`, it.overridden && !it.noBuffs ? `${it.name} ✱` : it.name);
      name.title = `${it.name} (${it.kind})${it.noBuffs ? " — No Buffs" : it.overridden ? " — custom banes (⟲ resets to this kind's default)" : ""}${it.equipped ? " — worn now" : ""}`;
      tr.appendChild(name);
      for (const f of it.families) {
        // worn now, with the Worn armor box on: that cast covers it
        const td = el(doc, "td", f.worn && !it.noBuffs ? "is-worn" : null);
        const cb = el(doc, "input", "hbk-check");
        cb.type = "checkbox";
        cb.checked = !!f.on;
        cb.disabled = !!it.noBuffs;
        cb.dataset.family = f.family;
        cb.title = `${f.label}${f.dflt ? " (default for this kind)" : ""}${f.worn && !it.noBuffs ? " — worn now: the Worn armor row casts it" : ""}`;
        cb.addEventListener("change", () => done(bridge.buffs.setItemSpell(it.guid, f.family, cb.checked)));
        td.appendChild(cb);
        tr.appendChild(td);
      }
      const td = el(doc, "td");
      const reset = iconBtn(doc, "⟲", "Reset to the default banes for this kind");
      reset.disabled = it.noBuffs || !it.overridden;
      reset.addEventListener("click", () => done(bridge.buffs.resetItemSpells(it.guid), "Reset to default"));
      td.appendChild(reset);
      tr.appendChild(td);
      t.appendChild(tr);
    }
    items.appendChild(t);
    if (!rows.length) items.appendChild(none());
  }

  function renderSummary(v) {
    const s = v.summary;
    const sig = JSON.stringify([s, !!v.present]);
    if (summary._rvtSig === sig) return;
    summary._rvtSig = sig;
    summary.textContent = "";
    if (!s || !s.total) return;
    const part = (label, n, cls = "") => {
      const sp = el(doc, "span");
      const b = el(doc, "b", cls || null, String(n));
      sp.append(b, doc.createTextNode(` ${label}`));
      summary.appendChild(sp);
    };
    part("maintained", `${s.enabled}/${s.total}`);
    part("on you", s.active);
    if (s.soon) part("due soon", s.soon, "is-warn");
    if (s.low) part("below the rebuff threshold", s.low, "is-warn");
    if (s.missing) part("missing", s.missing, "is-bad");
    if (!v.present) summary.appendChild(el(doc, "span", "rvt-faint", "· start the bot to buff"));
  }

  function update(snap, { force = false } = {}) {
    const v = snap?.view || {};
    setValue(auto.cb, !!v.auto);
    auto.cb.disabled = snap?.settings === false;
    const byKey = new Map((v.rows || []).map((r) => [r.key, r]));
    for (const [k, upd] of Object.entries(knob)) upd(byKey.get(k) || null);
    const fr = v.forceRebuff || {};
    fb.disabled = !snap?.present;
    cfb.disabled = !snap?.present || fr.cancellable === false;
    fb.classList.toggle("is-active", !!fr.active);
    setTitle(fb, fr.active ? "Force Buff running — Cancel stops it" : "Recast every buff now; pausing the macro resumes where it left off (G:10)");
    const rows = Array.isArray(v.buffs) ? v.buffs : [];
    const sig = JSON.stringify([v.loading, v.error, rows.map((r) => [r.spellId, r.enabled, r.familyLabel, r.group, r.tier])]);
    if (shouldRebuild(list, sig, force)) buildGroups(v);
    else {
      // cheap live text: time left and its colour, and each group's "due" count
      for (const r of rows) {
        const it = list.querySelector(`.rvt-buff-row[data-spell='${r.spellId}']`);
        if (!it) continue;
        if (it.dataset.state !== (r.state || "ok")) it.dataset.state = r.state || "ok";
        setText(it.querySelector(".rvt-buff-rem"), timeText(r));
      }
      for (const g of Array.isArray(v.groups) ? v.groups : []) setText(groupMetas.get(g.group), groupMetaText(g));
    }
    renderSummary(v);
    if (shouldRebuild(items, JSON.stringify([v.items || [], v.wornArmor || null]), force)) buildItems(v);
  }

  return { id: "buffs", el: root, snapshotId: () => "buffs", update };
}

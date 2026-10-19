// plugins/rynth-vt/tab_route.js — the VTank Route tab (G:185-224, §2.8
// R5-R23; v2 layout 2026-10-19).
//
//   saved routes   [route ▾] Load · [name] Save · Import (.nav / metaf .af) ·
//                  Export .nav · Delete — VTank saved routes from the Profiles
//                  tab (G:56, critic G3); v2 keeps them all here.
//   route          type Circular (ABC-ABC) · Linear (ABC-CBA) · Once · Follow
//                  (a player), Reverse (/rs reverseroute), "Show path" (draw
//                  the route in the 3D world even when this tab is closed —
//                  while it is open the path is always drawn), "Steep" (the
//                  profile's ShowTerrainPassability: ground too steep to walk
//                  up tinted red around you, route or not — display.js),
//                  insert mode (at the end / above / below the selected row,
//                  G:210).
//   waypoints      ➜ marks the current waypoint (click one to make it current,
//                  ▲▼ step it, G:211); each row shows its type, detail and how
//                  far you are from it; Pause / Chat rows edit in place; ✕
//                  deletes; Clear asks twice.
//   add            "Add here" = VTank's Add (the current location, or the
//                  selected portal; in Follow mode the selection becomes the
//                  follow target, G:199) — then one picker for the other
//                  waypoint kinds (Portal/NPC, NPC Talk, Open Vendor, Recall,
//                  Pause, Chat, Checkpoint, Jump) that shows only that kind's
//                  fields, and its VTank-named button (G:200-205, /rs addnav*).
// The navigation switch itself is NAV on the command bar.

import {
  el, btn, setText, setTitle, setValue, shouldRebuild, row, checkbox, textInput, numInput, select, fillSelect,
  fileButton, downloadFile, segmented, setSegmented, confirmBtn, iconBtn, bindRow,
} from "./widgets.js";

const INSERT_LABELS = Object.freeze({ end: "at the end", above: "above the selected", below: "below the selected" });
const baseName = (fileName) => String(fileName || "").replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "").replace(/\s+/g, "_");
const ROUTE_TYPES = Object.freeze([
  ["1", "Circular", "ABC-ABC: after the last waypoint, back to the first"],
  ["2", "Linear", "ABC-CBA: back and forth"],
  ["4", "Once", "Run it once (to a vendor, to a dungeon)"],
  ["3", "Follow", "Follow a player: select them and press Add here"],
]);
/** The waypoint kinds behind the picker: VTank's buttons, one at a time. */
export const ADD_KINDS = Object.freeze([
  { type: 6, label: "Portal/NPC", button: "Add Portal/NPC", needs: "selection", title: "Use the selected portal or NPC (G:201)" },
  { type: 7, label: "NPC Talk", button: "Add NPC Talk", needs: "selection", title: "Use the selected NPC until it tells you something (G:202)" },
  { type: 5, label: "Open Vendor", button: "Open Vendor", needs: "vendor", title: "Open the selected — or named — vendor (G:200)" },
  { type: 2, label: "Recall", button: "Add Recall", needs: "recall", title: "Cast one of your recall spells (G:203)" },
  { type: 3, label: "Pause", button: "Add Pause", needs: "seconds", title: "Wait X seconds (G:204)" },
  { type: 4, label: "Chat", button: "Add Chat", needs: "chat", title: "Run a chat line or a /command — /ls, plugin commands… (G:205)" },
  { type: 8, label: "Checkpoint", button: "Add Checkpoint", needs: "none", title: "Wait for the server to confirm your position (/rs addnavcheckpoint)" },
  { type: 9, label: "Jump", button: "Add Jump", needs: "jump", title: "A jump: heading, shift, charge (ms) and direction (/rs addnavjump)" },
].map((k) => Object.freeze(k)));

const fmtDist = (m) => (m == null || !Number.isFinite(m) ? "" : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

export function createRouteTab(ctx) {
  const { doc, bridge } = ctx;
  const root = el(doc, "div", "rvt-tab-body rvt-tab-route");
  root.dataset.tab = "route";

  // ── saved routes ─────────────────────────────────────────────────────────
  const profSel = select(doc, [["", "(saved routes)"]], "rvt-route-profiles");
  profSel.title = "Saved routes (nav profiles, saved with this settings profile)";
  const bLoad = btn(doc, "Load", "Load the selected route (/rs nav load)");
  const dirty = el(doc, "span", "rvt-dirty", "● unsaved");
  dirty.title = "The waypoints changed since the route was loaded or saved";
  dirty.hidden = true;
  const saveName = textInput(doc, "name", "rvt-route-name rvt-name-in");
  const bSave = btn(doc, "Save", "Save the waypoints under this name — or the selected route's (/rs nav save, overwrites)");
  const imp = fileButton(doc, "Import", { accept: ".nav,.af,.txt", title: "Import a VTank .nav or a metaf .af NAV section" }, async (f, text, err) => {
    if (err || text == null) return ctx.report({ ok: false, error: `could not read ${f?.name ?? "the file"}` });
    const name = baseName(f.name) || "route";
    ctx.report(await bridge.route.importText(name, text), (x) => `Imported ${name}${x.warnings && x.warnings.length ? ` (${x.warnings.length} warning(s))` : ""}`);
    ctx.refresh({ force: true });
  });
  const bExport = btn(doc, "Export", "Download the selected (or named) route as a VTank .nav");
  const bDel = confirmBtn(doc, "Delete", "Delete it?", "Delete the selected saved route", () => {
    if (!profSel.value) return ctx.report({ ok: false, error: "pick a saved route" });
    return done(bridge.route.remove(profSel.value), `Deleted ${profSel.value}`);
  });
  root.appendChild(row(doc, el(doc, "span", "rvt-lbl", "Route"), profSel, bLoad, dirty, el(doc, "span", "rvt-grow"), saveName, bSave, imp.wrap, bExport, bDel));

  // ── route mode ───────────────────────────────────────────────────────────
  const typeSeg = segmented(doc, ROUTE_TYPES, (t) => done(bridge.route.setType(Number(t))), "rvt-route-type");
  const rev = btn(doc, "⇅ Reverse", "Reverse the route — the walk turns around at the same waypoint (/rs reverseroute)");
  const showPath = checkbox(doc, "Show path", "Draw the route in the world even when this tab is closed (while it is open the path is always drawn)");
  // Steep: a profile option (ShowTerrainPassability), not a per-viewer pref —
  // its row arrives with the view (null = no settings yet: disabled).
  const steep = checkbox(doc, "Steep", "Tint ground too steep to walk up red around you, with or without a route");
  const insSel = select(doc, ["end", "above", "below"].map((m) => [m, INSERT_LABELS[m]]), "rvt-insert-mode");
  insSel.title = "Where new waypoints go, relative to the selected row (G:210)";
  root.appendChild(row(doc, typeSeg, rev, showPath.lab, steep.lab, el(doc, "span", "rvt-grow"), el(doc, "span", "rvt-lbl", "insert"), insSel));

  // ── waypoint list ────────────────────────────────────────────────────────
  const up = iconBtn(doc, "▲", "Current waypoint: previous");
  const down = iconBtn(doc, "▼", "Current waypoint: next");
  const curText = el(doc, "span", "rvt-grow rvt-route-cur");
  const clear = confirmBtn(doc, "Clear", "Clear all?", "Remove every waypoint", () => done(bridge.route.clear(), "Route cleared"));
  const head = el(doc, "div", "rvt-points-head");
  head.append(up, down, curText, clear);
  root.appendChild(head);
  const list = el(doc, "div", "rvt-list rvt-points rvt-scroll hbk-scroll");
  root.appendChild(list);

  // ── add ──────────────────────────────────────────────────────────────────
  const bAdd = btn(doc, "Add here", "Add the current location — or the selected portal; in Follow mode, follow the selected player (VTank Add, G:199)");
  bAdd.classList.add("is-primary");
  const kindSel = select(doc, ADD_KINDS.map((k) => [String(k.type), k.label]), "rvt-add-kind");
  kindSel.title = "Other waypoint kinds";
  const selHint = el(doc, "span", "rvt-grow rvt-selname is-none");
  const vendorName = textInput(doc, "vendor name (else the selected one)", "rvt-grow rvt-vendor-name");
  const recallSel = select(doc, [["", "(no known recall spells)"]], "rvt-recall-select");
  const pauseS = numInput(doc, { min: 0, step: 1, placeholder: "s", cls: "rvt-num-xs rvt-pause-s" });
  pauseS.value = "5";
  pauseS.title = "Seconds";
  const chatText = textInput(doc, "/ls  or any chat / plugin command", "rvt-grow rvt-chat-text");
  const jHead = numInput(doc, { min: 0, max: 359, step: 1, placeholder: "heading°", cls: "rvt-num-s rvt-jump-heading" });
  jHead.title = "Heading in degrees (empty = the way you face)";
  const jShift = checkbox(doc, "shift", "Hold shift (walk) while jumping");
  const jCharge = numInput(doc, { min: 0, max: 1000, step: 50, placeholder: "ms", cls: "rvt-num-xs rvt-jump-charge" });
  jCharge.title = "Charge the power bar (0-1000 ms)";
  const jDir = select(doc, [["forward", "forward"], ["none", "none"], ["strafeleft", "strafe left"], ["straferight", "strafe right"], ["back", "back"]], "rvt-jump-dir");
  const checkNote = el(doc, "span", "rvt-grow rvt-faint", "waits for the server to confirm your position");
  const bAddKind = btn(doc, "Add Portal/NPC", null);
  const fields = {
    selection: [selHint],
    vendor: [vendorName, selHint],
    recall: [recallSel],
    seconds: [pauseS, el(doc, "span", "rvt-unit", "s")],
    chat: [chatText],
    none: [checkNote],
    jump: [jHead, jShift.lab, jCharge, jDir],
  };
  const addBar = el(doc, "div", "rvt-addbar rvt-route-add");
  const fieldBox = el(doc, "span", "rvt-row is-nowrap rvt-grow rvt-add-fields");
  addBar.append(bAdd, el(doc, "span", "rvt-sep"), kindSel, fieldBox, bAddKind);
  root.appendChild(addBar);

  let selected = null;
  let selection = null; // { guid, name } from the last snapshot
  let avail = false;
  let recallCount = 0;
  const kindOf = () => ADD_KINDS.find((k) => String(k.type) === kindSel.value) || ADD_KINDS[0];

  function showKind() {
    const k = kindOf();
    fieldBox.textContent = "";
    for (const n of fields[k.needs] || []) fieldBox.appendChild(n);
    setText(bAddKind, k.button);
    setTitle(bAddKind, k.title);
    bAddKind.disabled = !avail || (k.type === 2 && !recallCount);
    ctx.pref("routeAddKind", k.type);
  }
  const savedKind = ctx.pref("routeAddKind");
  if (savedKind != null && ADD_KINDS.some((k) => k.type === Number(savedKind))) kindSel.value = String(savedKind);
  showKind();
  kindSel.addEventListener("change", showKind);

  const done = async (p, okText = null) => {
    const r = await p;
    ctx.report(r, okText);
    ctx.refresh({ force: true });
    return r;
  };
  const added = (x) => (x.follow ? `Following ${x.follow.name || "selection"}` : `Waypoint ${Number(x.index) + 1} added`);
  const bindSteep = bindRow({ input: steep.cb, tip: steep.lab }, (key, value) => done(bridge.opt.set(key, value), (x) => x.echo || `${key} = ${x.value}`));

  rev.addEventListener("click", () => done(bridge.route.reverse(), (x) => `Reversed: ${x.reversed}`));
  insSel.addEventListener("change", () => done(bridge.route.setInsertMode(insSel.value)));
  showPath.cb.addEventListener("change", () => {
    ctx.pref("routeShowPath", !!showPath.cb.checked);
    ctx.overlay?.update?.();
  });
  bAdd.addEventListener("click", () => done(bridge.route.add(0, {}), added));
  bAddKind.addEventListener("click", async () => {
    const k = kindOf();
    let f = {};
    if (k.type === 5 && vendorName.value.trim()) f = { name: vendorName.value.trim() };
    else if (k.type === 2) {
      if (!recallSel.value) return ctx.report({ ok: false, error: "no known recall spell selected" });
      f = { spellId: Number(recallSel.value) };
    } else if (k.type === 3) f = { seconds: Number(pauseS.value || 0) };
    else if (k.type === 4) f = { chat: chatText.value };
    else if (k.type === 9) {
      f = { holdShift: jShift.cb.checked, delayMs: Number(jCharge.value || 0), direction: jDir.value };
      if (jHead.value !== "") f.headingDeg = Number(jHead.value);
    }
    const r = await done(bridge.route.add(k.type, f), added);
    if (r.ok && k.type === 4) chatText.value = "";
    return r;
  });
  chatText.addEventListener("keydown", (e) => { if (e.key === "Enter") bAddKind.click(); });
  up.addEventListener("click", () => done(bridge.route.step(-1)));
  down.addEventListener("click", () => done(bridge.route.step(+1)));
  profSel.addEventListener("change", () => bDel.disarm()); // an armed Delete was for the route shown before
  bLoad.addEventListener("click", () => {
    if (!profSel.value) return ctx.report({ ok: false, error: "pick a saved route" });
    return done(bridge.route.load(profSel.value), `Loaded ${profSel.value}`);
  });
  bSave.addEventListener("click", async () => {
    const name = saveName.value.trim() || profSel.value;
    if (!name) return ctx.report({ ok: false, error: "name the route (or pick a saved one to overwrite)" });
    const r = await done(bridge.route.save(name), `Saved ${name}`);
    if (r.ok) saveName.value = "";
  });
  bExport.addEventListener("click", async () => {
    const name = saveName.value.trim() || profSel.value;
    if (!name) return ctx.report({ ok: false, error: "pick or name a saved route" });
    const r = await bridge.route.exportText(name);
    if (r.ok && typeof r.text === "string") downloadFile(doc, `${name}.nav`, r.text, "text/plain");
    ctx.report(r, (x) => `Exported ${name}.nav${x.warnings && x.warnings.length ? ` (${x.warnings.join("; ")})` : ""}`);
  });

  function build(v) {
    list.textContent = "";
    if (!v.available) {
      list.appendChild(el(doc, "div", "rvt-empty", "Start the bot to edit routes."));
      return;
    }
    if (v.routeType === 3) {
      const ft = v.followTarget;
      list.appendChild(el(doc, "div", "rvt-item", ft ? `Following ${ft.name || `0x${(Number(ft.guid) >>> 0).toString(16)}`}` : "Follow route: select a player and press Add here."));
      return;
    }
    if (!(v.points || []).length) {
      list.appendChild(el(doc, "div", "rvt-empty", "No waypoints — walk to a spot and press Add here, or Load a saved route."));
      return;
    }
    for (const p of v.points) {
      const it = el(doc, "div", `rvt-item rvt-point${p.active ? " is-active" : ""}${p.selected ? " is-selected" : ""}`);
      it.dataset.index = String(p.index);
      const arrow = btn(doc, "➜", p.active ? "Current waypoint" : "Make this the current waypoint", "rvt-arrow");
      arrow.setAttribute("aria-label", p.active ? `Waypoint ${p.index + 1} is current` : `Make waypoint ${p.index + 1} current`);
      arrow.addEventListener("click", (e) => {
        e.stopPropagation?.();
        done(bridge.route.setActive(p.index));
      });
      const type = el(doc, "span", "rvt-ptype", p.typeLabel);
      type.dataset.type = String(p.type);
      it.append(arrow, el(doc, "span", "rvt-pidx", `${p.index + 1}.`), type);
      if (p.type === 3) {
        const s = numInput(doc, { min: 0, step: 1, cls: "rvt-num-xs rvt-point-pause" });
        s.value = String(Math.round((Number(p.pauseMs) || 0) / 100) / 10);
        s.title = "Pause seconds";
        s.addEventListener("change", () => done(bridge.route.updatePoint(p.index, { pauseMs: Math.max(0, Number(s.value || 0)) * 1000 })));
        it.append(s, el(doc, "span", "rvt-grow rvt-unit", "s"));
      } else if (p.type === 4) {
        const t = textInput(doc, "", "rvt-grow rvt-point-chat");
        t.value = p.chat || "";
        t.title = "Chat text";
        t.addEventListener("change", () => done(bridge.route.updatePoint(p.index, { chat: t.value })));
        it.appendChild(t);
      } else {
        const d = el(doc, "span", "rvt-grow", p.detail ?? p.label);
        d.title = p.label;
        it.appendChild(d);
      }
      const dist = el(doc, "span", "rvt-dist", fmtDist(p.distM));
      dist.title = p.distM != null ? "Distance from you" : "";
      const rm = iconBtn(doc, "✕", "Delete waypoint", "is-danger");
      rm.addEventListener("click", (e) => {
        e.stopPropagation?.();
        done(bridge.route.removeAt(p.index));
      });
      const acts = el(doc, "span", "rvt-acts");
      acts.appendChild(rm);
      it.append(dist, acts);
      // the selected row is where Insert above / below puts new waypoints
      const toggleSelect = async () => {
        selected = selected === p.index ? null : p.index;
        await bridge.route.select(selected);
        ctx.refresh();
      };
      it.tabIndex = 0;
      it.setAttribute("aria-selected", p.selected ? "true" : "false");
      it.addEventListener("click", (e) => {
        const tag = String(e?.target?.tagName || "").toUpperCase();
        if (tag === "INPUT" || tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA") return;
        toggleSelect();
      });
      it.addEventListener("keydown", (e) => {
        if (e.target !== it || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault?.();
        toggleSelect();
      });
      list.appendChild(it);
    }
  }

  function update(snap, { force = false } = {}) {
    const v = snap?.view || {};
    selected = v.selected ?? null;
    selection = v.selection || null;
    setSegmented(typeSeg, String(v.routeType ?? 1), !v.available);
    setValue(insSel, v.insertMode || "end");
    rev.classList.toggle("is-active", !!v.reversed);
    setText(rev, v.reversed ? "⇅ Reversed" : "⇅ Reverse");
    setValue(showPath.cb, !!ctx.pref("routeShowPath"));
    bindSteep(v.steep || null);
    const recalls = (v.recalls || []).map((r) => [String(r.id), r.name]);
    fillSelect(recallSel, recalls.length ? recalls : [["", "(no known recall spells)"]]);
    fillSelect(profSel, [["", "(saved routes)"], ...(v.profiles || []).map((p) => [p.name, p.name])]);
    if (v.currentProfile) setValue(profSel, v.currentProfile);
    dirty.hidden = !v.dirty;
    // the list: rebuilt on data changes; distances refresh in place
    const sig = JSON.stringify([v.available, v.routeType, v.followTarget, (v.points || []).map((p) => [p.type, p.label, p.active, p.selected, p.pauseMs, p.chat])]);
    if (shouldRebuild(list, sig, force)) build(v);
    else for (const p of v.points || []) setText(list.querySelector(`.rvt-point[data-index='${p.index}'] .rvt-dist`), fmtDist(p.distM));
    const n = (v.points || []).length;
    const cur = (v.points || []).find((p) => p.active);
    setText(curText, !v.available ? "" : v.routeType === 3 ? "follow route" : n ? `current ${v.activeIndex + 1} / ${n}${cur && cur.distM != null ? ` · ${fmtDist(cur.distM)} away` : ""}` : "no waypoints");
    // the selection the add buttons will use
    setText(selHint, selection ? `→ ${selection.name || `0x${(Number(selection.guid) >>> 0).toString(16)}`}` : "select a portal, NPC or vendor first");
    selHint.classList.toggle("is-none", !selection);
    avail = !!v.available;
    recallCount = recalls.length;
    for (const c of [rev, insSel, bAdd, kindSel, vendorName, pauseS, chatText, jHead, jCharge, jDir, up, down, clear, bLoad, bDel, bSave, bExport, imp.btn, saveName]) c.disabled = !avail;
    jShift.cb.disabled = !avail;
    bAddKind.disabled = !avail || (kindOf().type === 2 && !recallCount);
    ctx.setStatus?.(v.statusLine || "");
    ctx.overlay?.update?.();
  }

  return {
    id: "route",
    el: root,
    snapshotId: () => "route",
    update,
    ownsStatus: true,
    onShow: () => ctx.overlay?.update?.(),
    onHide: () => ctx.overlay?.update?.(),
  };
}

// plugins/rynth-vt/tab_route.js — the VTank Route tab (G:185-224, §2.8
// R5-R23).
//
//   Route type: Circular (ABC-ABC) · Linear (ABC-CBA) · Follow (a player) ·
//   Once. Insert mode: Add to End / Insert Above / Insert Below (relative to
//   the selected row, G:210). Buttons: Add (current location, or the selected
//   portal; in Follow mode the selection becomes the follow target, G:199),
//   Open Vendor, Add Portal/NPC, Add NPC Talk, Add Recall (known recalls),
//   Add Pause [s], Add Chat [text], Add Checkpoint, Add Jump [heading, shift,
//   charge, direction]. The green arrow marks/sets the current waypoint and
//   ▲▼ move it (G:211); ✕ deletes a row; Pause/Chat rows edit in place.
//   Nav profiles: load / save / delete / import .nav or metaf .af / export.

import {
  el, btn, setText, setValue, shouldRebuild, sectionTitle, row, checkbox, textInput, numInput, select, fillSelect,
  fileInput, downloadFile,
} from "./widgets.js";

const INSERT_LABELS = Object.freeze({ end: "Add to End", above: "Insert Above", below: "Insert Below" });
const baseName = (fileName) => String(fileName || "").replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "").replace(/\s+/g, "_");

export function createRouteTab(ctx) {
  const { doc, bridge } = ctx;
  const root = el(doc, "div", "rvt-tab-body rvt-tab-route");
  root.dataset.tab = "route";

  // ── route header ─────────────────────────────────────────────────────────
  const typeSel = select(doc, [["1", "Circular"], ["2", "Linear"], ["3", "Follow"], ["4", "Once"]], "rvt-route-type");
  typeSel.title = "Circular: ABC-ABC · Linear: ABC-CBA · Follow: a player · Once: run it once";
  const insSel = select(doc, ["end", "above", "below"].map((m) => [m, INSERT_LABELS[m]]), "rvt-insert-mode");
  insSel.title = "Where new waypoints go, relative to the selected row";
  const navOn = checkbox(doc, "Enable nav", "EnableNavigation (also on the Profiles tab)");
  const rev = btn(doc, "Reverse", "Reverse the route (/rs reverseroute)");
  root.appendChild(row(doc, el(doc, "span", null, "Type"), typeSel, el(doc, "span", null, "Insert"), insSel, navOn.lab, rev));

  // ── add buttons ──────────────────────────────────────────────────────────
  const bAdd = btn(doc, "Add", "Add the current location (or the selected portal; in Follow mode: follow the selection)");
  const bVendor = btn(doc, "Open Vendor", "Open the selected vendor (G:200)");
  const bPortal = btn(doc, "Add Portal/NPC", "Use the selected portal or NPC (G:201)");
  const bTalk = btn(doc, "Add NPC Talk", "Use the selected NPC until it tells you something (G:202)");
  const bCheck = btn(doc, "Add Checkpoint", "Wait for the position to settle (/rs addnavcheckpoint)");
  root.appendChild(row(doc, bAdd, bVendor, bPortal, bTalk, bCheck));
  const vendorName = textInput(doc, "vendor name (when none is selected)", "rvt-grow rvt-vendor-name");
  vendorName.title = "Open Vendor uses the selected vendor, else the nearest vendor with this name";
  const recallSel = select(doc, [["", "(no known recall spells)"]], "rvt-recall-select");
  const bRecall = btn(doc, "Add Recall", "Add a recall waypoint (G:203)");
  const pauseS = numInput(doc, { min: 0, step: 1, placeholder: "s", cls: "rvt-num-s rvt-pause-s" });
  pauseS.value = "5";
  const bPause = btn(doc, "Add Pause", "Pause X seconds (G:204)");
  root.appendChild(row(doc, recallSel, bRecall, pauseS, bPause));
  const chatText = textInput(doc, "/ls  or any chat / plugin command", "rvt-grow rvt-chat-text");
  const bChat = btn(doc, "Add Chat", "Run a chat line or /command (G:205)");
  root.appendChild(row(doc, chatText, bChat));
  root.appendChild(row(doc, el(doc, "span", null, "Vendor"), vendorName));
  const jHead = numInput(doc, { min: 0, max: 359, step: 1, placeholder: "heading°", cls: "rvt-num-s rvt-jump-heading" });
  const jShift = checkbox(doc, "shift", "Hold shift (walk) while jumping");
  const jCharge = numInput(doc, { min: 0, max: 1000, step: 50, placeholder: "ms", cls: "rvt-num-s rvt-jump-charge" });
  const jDir = select(doc, [["forward", "forward"], ["none", "none"], ["strafeleft", "strafe left"], ["straferight", "strafe right"], ["back", "back"]], "rvt-jump-dir");
  const bJump = btn(doc, "Add Jump", "Jump waypoint (/rs addnavjump heading shift charge direction)");
  root.appendChild(row(doc, el(doc, "span", null, "Jump"), jHead, jShift.lab, jCharge, jDir, bJump));

  // ── point list + current-waypoint controls ───────────────────────────────
  root.appendChild(sectionTitle(doc, "Waypoints"));
  const list = el(doc, "div", "rvt-list rvt-points hbk-scroll");
  root.appendChild(list);
  const up = btn(doc, "▲", "Current waypoint: previous");
  const down = btn(doc, "▼", "Current waypoint: next");
  const setCur = btn(doc, "➜ Set current", "Make the selected row the current waypoint");
  const clear = btn(doc, "Clear", "Remove every waypoint");
  root.appendChild(row(doc, up, down, setCur, clear));

  // ── profiles ─────────────────────────────────────────────────────────────
  root.appendChild(sectionTitle(doc, "Nav profiles"));
  const profSel = select(doc, [["", "(saved routes)"]], "rvt-grow rvt-route-profiles");
  const bLoad = btn(doc, "Load", "Load the selected route (/rs nav load)");
  const bDel = btn(doc, "Delete", "Delete the selected saved route");
  root.appendChild(row(doc, profSel, bLoad, bDel));
  const saveName = textInput(doc, "route name", "rvt-grow rvt-route-name");
  const bSave = btn(doc, "Save", "Save the waypoints (/rs nav save, overwrites)");
  const bExport = btn(doc, "Export .nav", "Download the selected (or named) route as a VTank .nav");
  const imp = fileInput(doc, { accept: ".nav,.af,.txt", title: "Import a VTank .nav or a metaf .af NAV section" }, async (f, text, err) => {
    if (err || text == null) return ctx.report({ ok: false, error: `could not read ${f?.name ?? "the file"}` });
    const name = baseName(f.name) || "route";
    ctx.report(await bridge.route.importText(name, text), (x) => `Imported ${name}${x.warnings && x.warnings.length ? ` (${x.warnings.length} warning(s))` : ""}`);
    ctx.refresh({ force: true });
  });
  root.appendChild(row(doc, saveName, bSave, bExport));
  root.appendChild(row(doc, el(doc, "span", null, "Import"), imp));

  const done = async (p, okText = null) => {
    const r = await p;
    ctx.report(r, okText);
    ctx.refresh({ force: true });
    return r;
  };
  const added = (x) => (x.follow ? `Following ${x.follow.name || "selection"}` : `Waypoint ${Number(x.index) + 1} added`);

  typeSel.addEventListener("change", () => done(bridge.route.setType(Number(typeSel.value))));
  insSel.addEventListener("change", () => done(bridge.route.setInsertMode(insSel.value)));
  navOn.cb.addEventListener("change", () => done(bridge.route.enable(navOn.cb.checked), navOn.cb.checked ? "Navigation on" : "Navigation off"));
  rev.addEventListener("click", () => done(bridge.route.reverse(), (x) => `Reversed: ${x.reversed}`));
  bAdd.addEventListener("click", () => done(bridge.route.add(0, {}), added));
  bVendor.addEventListener("click", () => done(bridge.route.add(5, vendorName.value.trim() ? { name: vendorName.value.trim() } : {}), added));
  bPortal.addEventListener("click", () => done(bridge.route.add(6, {}), added));
  bTalk.addEventListener("click", () => done(bridge.route.add(7, {}), added));
  bCheck.addEventListener("click", () => done(bridge.route.add(8, {}), added));
  bRecall.addEventListener("click", () => {
    if (!recallSel.value) return ctx.report({ ok: false, error: "no known recall spell selected" });
    return done(bridge.route.add(2, { spellId: Number(recallSel.value) }), added);
  });
  bPause.addEventListener("click", () => done(bridge.route.add(3, { seconds: Number(pauseS.value || 0) }), added));
  bChat.addEventListener("click", async () => {
    const r = await done(bridge.route.add(4, { chat: chatText.value }), added);
    if (r.ok) chatText.value = "";
  });
  bJump.addEventListener("click", () => {
    const f = { holdShift: jShift.cb.checked, delayMs: Number(jCharge.value || 0), direction: jDir.value };
    if (jHead.value !== "") f.headingDeg = Number(jHead.value);
    return done(bridge.route.add(9, f), added);
  });
  up.addEventListener("click", () => done(bridge.route.step(-1)));
  down.addEventListener("click", () => done(bridge.route.step(+1)));
  setCur.addEventListener("click", () => {
    if (selected == null) return ctx.report({ ok: false, error: "select a waypoint row first" });
    return done(bridge.route.setActive(selected));
  });
  clear.addEventListener("click", () => done(bridge.route.clear(), "Route cleared"));
  bLoad.addEventListener("click", () => {
    if (!profSel.value) return ctx.report({ ok: false, error: "pick a saved route" });
    return done(bridge.route.load(profSel.value), `Loaded ${profSel.value}`);
  });
  bDel.addEventListener("click", () => {
    if (!profSel.value) return ctx.report({ ok: false, error: "pick a saved route" });
    return done(bridge.route.remove(profSel.value), `Deleted ${profSel.value}`);
  });
  bSave.addEventListener("click", async () => {
    const name = saveName.value.trim() || profSel.value;
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

  let selected = null;

  function build(v) {
    list.textContent = "";
    if (!v.available) {
      list.appendChild(el(doc, "div", "hbk-empty", "Start the bot to edit routes."));
      return;
    }
    if (v.routeType === 3) {
      const ft = v.followTarget;
      list.appendChild(el(doc, "div", "rvt-item", ft ? `Following ${ft.name || `0x${(Number(ft.guid) >>> 0).toString(16)}`}` : "Follow route: select a player and press Add."));
      return;
    }
    if (!(v.points || []).length) {
      list.appendChild(el(doc, "div", "hbk-empty", "No waypoints."));
      return;
    }
    for (const p of v.points) {
      const it = el(doc, "div", `rvt-item rvt-point${p.active ? " is-active" : ""}${p.selected ? " is-selected" : ""}`);
      it.dataset.index = String(p.index);
      const arrow = el(doc, "span", "rvt-arrow", "➜");
      arrow.title = p.active ? "Current waypoint" : "Click to make this the current waypoint";
      arrow.addEventListener("click", (e) => {
        e.stopPropagation?.();
        done(bridge.route.setActive(p.index));
      });
      const label = el(doc, "span", "rvt-grow", `${p.index + 1}. ${p.label}`);
      it.append(arrow, label);
      if (p.type === 3) {
        const s = numInput(doc, { min: 0, step: 1, cls: "rvt-num-s rvt-point-pause" });
        s.value = String(Math.round((Number(p.pauseMs) || 0) / 100) / 10);
        s.title = "Pause seconds";
        s.addEventListener("change", () => done(bridge.route.updatePoint(p.index, { pauseMs: Math.max(0, Number(s.value || 0)) * 1000 })));
        it.appendChild(s);
      } else if (p.type === 4) {
        const t = textInput(doc, "", "rvt-point-chat");
        t.value = p.chat || "";
        t.title = "Chat text";
        t.addEventListener("change", () => done(bridge.route.updatePoint(p.index, { chat: t.value })));
        it.appendChild(t);
      }
      const rm = btn(doc, "✕", "Delete waypoint");
      rm.addEventListener("click", (e) => {
        e.stopPropagation?.();
        done(bridge.route.removeAt(p.index));
      });
      it.appendChild(rm);
      it.addEventListener("click", async (e) => {
        const tag = String(e?.target?.tagName || "").toUpperCase();
        if (tag === "INPUT" || tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA") return;
        selected = selected === p.index ? null : p.index;
        await bridge.route.select(selected);
        ctx.refresh();
      });
      list.appendChild(it);
    }
  }

  function update(snap, { force = false } = {}) {
    const v = snap?.view || {};
    selected = v.selected ?? null;
    setValue(typeSel, String(v.routeType ?? 1));
    setValue(insSel, v.insertMode || "end");
    setValue(navOn.cb, !!v.enabled);
    rev.classList.toggle("is-active", !!v.reversed);
    setText(rev, v.reversed ? "Reverse (on)" : "Reverse");
    const recalls = (v.recalls || []).map((r) => [String(r.id), r.name]);
    fillSelect(recallSel, recalls.length ? recalls : [["", "(no known recall spells)"]]);
    fillSelect(profSel, [["", "(saved routes)"], ...(v.profiles || []).map((p) => [p.name, p.name])]);
    if (v.currentProfile) setValue(profSel, v.currentProfile);
    const sig = JSON.stringify([v.available, v.routeType, v.followTarget, v.points]);
    if (shouldRebuild(list, sig, force)) build(v);
    const avail = !!v.available;
    for (const c of [typeSel, insSel, navOn.cb, rev, vendorName, bAdd, bVendor, bPortal, bTalk, bCheck, bRecall, bPause, bChat, bJump, up, down, setCur, clear, bLoad, bDel, bSave, bExport, imp]) c.disabled = !avail;
    bRecall.disabled = !avail || !recalls.length;
    ctx.setStatus?.(v.statusLine || "");
  }

  return { id: "route", el: root, snapshotId: () => "route", update };
}

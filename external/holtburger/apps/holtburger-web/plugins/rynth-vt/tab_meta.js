// plugins/rynth-vt/tab_meta.js — the VTank Meta tab (G:226-319).
//
// Rules (state + condition + action) listed grouped by state; a rule that
// already ran in the current state is shown in red (G:232). The state
// dropdown in the bottom left changes the current state (G:230 — the engine
// re-arms every rule, "manual" entry). Add Rule opens the rule editor: the
// condition on the left, the action on the right (G:242), with an editor for
// every Appendix-B keyword (All/Any/Not and DoAll nest). Enable Meta, Debug,
// the meta library (load / save) and .met / .af / .json import and export.
// A snapshot strip shows the state, seconds in state, the call stack, the
// watchdog and the last fired rule / error.
//
// Edits never reload the meta: the bridge applies them with
// engine.replaceMeta(clone, { keepState: true }) (critic C3). Above 200 rows
// the list is windowed (only the visible rows exist in the DOM).

import {
  el, btn, setText, setValue, shouldRebuild, sectionTitle, row, checkbox, textInput, numInput, textArea, select,
  fillSelect, fileInput, downloadFile,
} from "./widgets.js";

export const META_VIRTUAL_THRESHOLD = 200;
const ROW_H = 20;
const OVERSCAN = 10;
const KINDS = Object.freeze(["met", "af", "json"]);
const baseName = (fileName) => String(fileName || "").replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "").replace(/\s+/g, "_");
const kindOf = (fileName) => {
  const m = /\.([a-z]+)$/i.exec(String(fileName || ""));
  const k = m ? m[1].toLowerCase() : "";
  return KINDS.includes(k) ? k : null;
};

export function createMetaTab(ctx) {
  const { doc, bridge } = ctx;
  const root = el(doc, "div", "rvt-tab-body rvt-tab-meta");
  root.dataset.tab = "meta";

  // ── header ───────────────────────────────────────────────────────────────
  const enable = checkbox(doc, "Enable Meta", "EnableMeta: run the meta rules (checked ~3×/s before normal operation, G:237)");
  const debug = checkbox(doc, "Debug", "Print state changes and rule errors to chat");
  const libSel = select(doc, [["", "(meta library)"]], "rvt-grow rvt-meta-library");
  const bLoad = btn(doc, "Load", "Load the selected meta (starts in Default)");
  root.appendChild(row(doc, enable.lab, debug.lab, libSel, bLoad));
  const name = textInput(doc, "meta name", "rvt-grow rvt-meta-name");
  const bSave = btn(doc, "Save", "Save the current rules to the library");
  const kindSel = select(doc, KINDS.map((k) => [k, `.${k}`]), "rvt-meta-kind");
  const bExport = btn(doc, "Export", "Download the named meta");
  root.appendChild(row(doc, name, bSave, kindSel, bExport));
  const imp = fileInput(doc, { accept: ".met,.af,.json", binary: (f) => /\.met$/i.test(f?.name || ""), title: "Import a VTank .met, a metaf .af or a JSON meta" }, async (f, data, err) => {
    if (err || data == null) return ctx.report({ ok: false, error: `could not read ${f?.name ?? "the file"}` });
    const kind = kindOf(f.name);
    if (!kind) return ctx.report({ ok: false, error: "meta files are .met, .af or .json" });
    const nm = baseName(f.name) || "meta";
    ctx.report(await bridge.meta.importFile(nm, data, kind), (x) => `Imported ${nm}${x.warnings && x.warnings.length ? ` (${x.warnings.length} warning(s))` : ""}`);
    ctx.refresh({ force: true });
  });
  root.appendChild(row(doc, el(doc, "span", null, "Import"), imp));
  const strip = el(doc, "div", "rvt-strip rvt-meta-strip");
  root.appendChild(strip);

  // ── rule list ────────────────────────────────────────────────────────────
  root.appendChild(sectionTitle(doc, "Rules"));
  const list = el(doc, "div", "rvt-list rvt-rules rvt-virtual hbk-scroll");
  root.appendChild(list);
  const addRule = btn(doc, "Add Rule", "Add a rule: state, condition, action");
  const stateSel = select(doc, [["Default", "Default"]], "rvt-state-select");
  stateSel.title = "The current meta state — pick one to switch to it now (G:230)";
  root.appendChild(row(doc, el(doc, "span", null, "State"), stateSel, addRule));

  // ── rule editor ──────────────────────────────────────────────────────────
  const editor = el(doc, "div", "rvt-editor rvt-rule-editor");
  editor.hidden = true;
  root.appendChild(editor);

  let condKw = [];
  let actKw = [];
  let draft = null; // { id|null, state, enabled, cond, act }
  let flat = []; // display rows for the windowed list

  const done = async (p, okText = null, force = true) => {
    const r = await p;
    ctx.report(r, okText);
    ctx.refresh({ force });
    return r;
  };

  enable.cb.addEventListener("change", () => done(bridge.meta.setEnabled(enable.cb.checked), enable.cb.checked ? "Meta enabled" : "Meta disabled"));
  debug.cb.addEventListener("change", () => done(bridge.meta.setDebug(debug.cb.checked)));
  bLoad.addEventListener("click", () => {
    if (!libSel.value) return ctx.report({ ok: false, error: "pick a meta from the library" });
    return done(bridge.meta.load(libSel.value), `Loaded ${libSel.value}`);
  });
  bSave.addEventListener("click", () => {
    const nm = name.value.trim() || libSel.value;
    return done(bridge.meta.save(nm), `Saved ${nm}`);
  });
  bExport.addEventListener("click", async () => {
    const nm = name.value.trim() || libSel.value;
    if (!nm) return ctx.report({ ok: false, error: "name or pick a meta to export" });
    const r = await bridge.meta.exportFile(nm, kindSel.value);
    if (r.ok && r.data != null) downloadFile(doc, `${nm}.${kindSel.value}`, r.data, kindSel.value === "json" ? "application/json" : kindSel.value === "af" ? "text/plain" : "application/octet-stream");
    // (a .met export leaves disabled rules out; the library says so in warnings)
    ctx.report(r, (x) => `Exported ${nm}.${kindSel.value}${x.warnings && x.warnings.length ? ` — ${x.warnings.slice(0, 2).join("; ")}` : ""}`);
  });
  stateSel.addEventListener("change", () => done(bridge.meta.setState(stateSel.value), `State: ${stateSel.value}`));
  addRule.addEventListener("click", () => openEditor(null));

  // ── list rendering (windowed above the threshold) ───────────────────────
  function ruleRow(r) {
    const it = el(doc, "div", `rvt-item rvt-rule${r.fired ? " is-fired" : ""}${r.enabled ? "" : " is-disabled"}`);
    it.dataset.id = r.id;
    const en = checkbox(doc, "", "Rule enabled");
    en.cb.checked = r.enabled;
    en.cb.addEventListener("change", () => done(bridge.meta.updateRule(r.id, { enabled: en.cb.checked }), null, false));
    const text = el(doc, "span", "rvt-grow", `${r.condText}  →  ${r.actText}`);
    text.title = `${r.id} · ${r.state}${r.fired ? " · already ran in this state" : ""}`;
    it.append(en.cb, text);
    for (const [label, title, fn] of [
      ["✎", "Edit", () => openEditor(r)],
      ["▲", "Move up (within its state)", () => done(bridge.meta.moveRule(r.id, -1))],
      ["▼", "Move down (within its state)", () => done(bridge.meta.moveRule(r.id, +1))],
      ["⧉", "Duplicate", () => done(bridge.meta.duplicateRule(r.id))],
      ["✕", "Delete", () => done(bridge.meta.deleteRule(r.id), "Rule deleted")],
    ]) {
      const b = btn(doc, label, title);
      b.addEventListener("click", fn);
      it.appendChild(b);
    }
    return it;
  }
  function headRow(g) {
    const h = el(doc, "div", `rvt-state-head${g.current ? " is-current" : ""}`, `${g.state}${g.current ? "  (current)" : ""}`);
    h.dataset.state = g.state;
    return h;
  }

  function renderWindow() {
    if (flat.length <= META_VIRTUAL_THRESHOLD) return;
    const win = list._rvtWindow;
    if (!win) return;
    const top = Number(list.scrollTop) || 0;
    const visible = Math.ceil((Number(list.clientHeight) || 240) / ROW_H);
    const start = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const end = Math.min(flat.length, start + visible + 2 * OVERSCAN);
    if (win._range && win._range[0] === start && win._range[1] === end) return;
    win._range = [start, end];
    win.textContent = "";
    win.style.setProperty("top", `${start * ROW_H}px`);
    for (let i = start; i < end; i++) win.appendChild(flat[i].kind === "head" ? headRow(flat[i].g) : ruleRow(flat[i].r));
  }
  list.addEventListener("scroll", renderWindow);

  function build(v) {
    list.textContent = "";
    list._rvtWindow = null;
    flat = [];
    if (!v.available) {
      list.appendChild(el(doc, "div", "hbk-empty", "Start the bot to use metas."));
      return;
    }
    for (const g of v.groups || []) {
      flat.push({ kind: "head", g });
      for (const r of g.rules) flat.push({ kind: "rule", r });
    }
    if (!flat.length) {
      list.appendChild(el(doc, "div", "hbk-empty", v.loaded ? "No rules." : "No meta loaded — Add Rule or Load one."));
      return;
    }
    if (flat.length <= META_VIRTUAL_THRESHOLD) {
      for (const x of flat) list.appendChild(x.kind === "head" ? headRow(x.g) : ruleRow(x.r));
      return;
    }
    const spacer = el(doc, "div", "rvt-virtual-spacer");
    spacer.style.setProperty("height", `${flat.length * ROW_H}px`);
    spacer.style.setProperty("position", "relative");
    const win = el(doc, "div", "rvt-virtual-window");
    win.style.setProperty("position", "absolute");
    win.style.setProperty("left", "0");
    win.style.setProperty("right", "0");
    spacer.appendChild(win);
    list.appendChild(spacer);
    list._rvtWindow = win;
    renderWindow();
  }

  // ── rule editor ──────────────────────────────────────────────────────────
  const kwOf = (table, t) => table.find((k) => k.kw === t) || null;

  function fieldInput(f, node, onDone) {
    let input;
    const v = node[f.name];
    if (f.type === "int" || f.type === "float") {
      input = numInput(doc, { step: f.type === "int" ? 1 : 0.1, cls: "rvt-num" });
      input.value = v == null ? "" : String(v);
      input.addEventListener("change", () => {
        const n = Number(input.value);
        node[f.name] = input.value === "" || !Number.isFinite(n) ? 0 : f.type === "int" ? Math.trunc(n) : n;
        onDone();
      });
    } else if (f.type === "hex") {
      input = textInput(doc, "0x0000FFFF", "rvt-num");
      input.value = v == null ? "" : `0x${((Number(v) >>> 0) || 0).toString(16).toUpperCase()}`;
      input.addEventListener("change", () => {
        const s = input.value.trim().replace(/^0x/i, "");
        const n = /^[0-9a-f]+$/i.test(s) ? parseInt(s, 16) >>> 0 : 0;
        node[f.name] = n;
        onDone();
      });
    } else if (f.type === "textarea") {
      input = textArea(doc, f.label, 4);
      input.value = v == null ? "" : String(v);
      input.addEventListener("change", () => { node[f.name] = input.value; onDone(); });
    } else {
      input = textInput(doc, f.label, "rvt-grow");
      input.value = v == null ? "" : String(v);
      input.addEventListener("change", () => { node[f.name] = input.value; onDone(); });
    }
    input.dataset.field = f.name;
    input.title = f.label;
    return row(doc, el(doc, "span", "rvt-note", f.label), input);
  }

  /** One condition/action node editor (recursive for All/Any/Not/DoAll). */
  function nodeEditor(kind, node, replace, depth = 0) {
    const table = kind === "cond" ? condKw : actKw;
    const box = el(doc, "div", `rvt-node rvt-node-${kind}`);
    const opts = table.map((k) => [k.kw, k.label]);
    if (!kwOf(table, node.t)) opts.push([node.t, `Unsupported: ${node.unknownKeyword || node.t}`]);
    const kwSel = select(doc, opts, `rvt-kw rvt-kw-${kind}`);
    kwSel.value = node.t;
    kwSel.addEventListener("change", () => {
      const k = kwOf(table, kwSel.value);
      const next = { t: kwSel.value };
      if (k && k.children && Array.isArray(node.children)) next.children = k.children === "one" ? node.children.slice(0, 1) : node.children;
      else if (k && k.children) next.children = [];
      replace(next);
      renderEditor();
    });
    box.appendChild(kwSel);
    const k = kwOf(table, node.t);
    if (k) for (const f of k.fields) box.appendChild(fieldInput(f, node, () => {}));
    if (k && k.children) {
      if (!Array.isArray(node.children)) node.children = [];
      node.children.forEach((child, i) => {
        const wrap = el(doc, "div", "rvt-node-child");
        wrap.appendChild(nodeEditor(kind, child, (n) => { node.children[i] = n; }, depth + 1));
        const rm = btn(doc, "✕", "Remove");
        rm.addEventListener("click", () => { node.children.splice(i, 1); renderEditor(); });
        wrap.appendChild(rm);
        box.appendChild(wrap);
      });
      if (k.children === "many" || node.children.length === 0) {
        const add = btn(doc, kind === "cond" ? "+ condition" : "+ action", "Add a child");
        add.addEventListener("click", () => {
          node.children.push(kind === "cond" ? { t: "Always" } : { t: "None" });
          renderEditor();
        });
        box.appendChild(add);
      }
    }
    return box;
  }

  function renderEditor() {
    editor.textContent = "";
    if (!draft) {
      editor.hidden = true;
      return;
    }
    editor.hidden = false;
    editor.appendChild(el(doc, "div", "hbk-section-title", draft.id ? `Edit rule ${draft.id}` : "Add rule"));
    const st = textInput(doc, "state (e.g. Default)", "rvt-grow rvt-rule-state");
    st.value = draft.state;
    st.addEventListener("change", () => { draft.state = st.value; });
    const en = checkbox(doc, "Enabled");
    en.cb.checked = draft.enabled !== false;
    en.cb.addEventListener("change", () => { draft.enabled = en.cb.checked; });
    editor.appendChild(row(doc, el(doc, "span", null, "State"), st, en.lab));
    const cols = el(doc, "div", "rvt-editor-cols");
    const left = el(doc, "div", "rvt-editor-cond");
    left.appendChild(el(doc, "div", "rvt-note", "Condition"));
    left.appendChild(nodeEditor("cond", draft.cond, (n) => { draft.cond = n; }));
    const right = el(doc, "div", "rvt-editor-act");
    right.appendChild(el(doc, "div", "rvt-note", "Action"));
    right.appendChild(nodeEditor("act", draft.act, (n) => { draft.act = n; }));
    cols.append(left, right);
    editor.appendChild(cols);
    const save = btn(doc, "Save rule", "Apply the rule (the meta keeps its current state)");
    const cancel = btn(doc, "Cancel");
    save.addEventListener("click", async () => {
      const rule = { state: draft.state, enabled: draft.enabled !== false, cond: draft.cond, act: draft.act };
      const r = draft.id ? await bridge.meta.updateRule(draft.id, rule) : await bridge.meta.addRule(rule);
      ctx.report(r, (x) => (draft && draft.id ? `Rule ${draft.id} saved` : `Rule ${x.id} added`));
      if (r.ok) {
        draft = null;
        renderEditor();
      }
      ctx.refresh({ force: true });
    });
    cancel.addEventListener("click", () => { draft = null; renderEditor(); });
    editor.appendChild(row(doc, save, cancel));
  }

  function openEditor(r) {
    const cur = stateSel.value || "Default";
    draft = r
      ? { id: r.id, state: r.state, enabled: r.enabled, cond: JSON.parse(JSON.stringify(r.cond || { t: "Always" })), act: JSON.parse(JSON.stringify(r.act || { t: "None" })) }
      : { id: null, state: cur, enabled: true, cond: { t: "Always" }, act: { t: "SetState", state: "" } };
    renderEditor();
  }

  // ── refresh ──────────────────────────────────────────────────────────────
  function stripText(v) {
    const s = v.snapshot;
    if (!v.available) return "No meta engine (start the bot).";
    if (!s) return "";
    const parts = [`${v.name ? `${v.name} · ` : ""}State: ${s.state}`, `${Math.floor(s.secondsInState || 0)}s in state`, `${Math.floor(s.secondsInStateP || 0)}s (P)`];
    parts.push(`stack ${s.stackDepth || 0}`);
    if (s.watchdog) parts.push(`watchdog → ${s.watchdog.state} (${s.watchdog.dist} m, ${Math.round(s.watchdog.secsRemaining)} s)`);
    if (s.lastFired) parts.push(`last: ${s.lastFired.ruleId}`);
    if (s.lastError) parts.push(`error: ${s.lastError.msg}`);
    if (!s.enabled) parts.push("meta off");
    else if (!s.running) parts.push("macro paused");
    return parts.join(" · ");
  }

  function update(snap, { force = false } = {}) {
    const v = snap?.view || {};
    if (Array.isArray(v.condKeywords)) condKw = v.condKeywords;
    if (Array.isArray(v.actKeywords)) actKw = v.actKeywords;
    setValue(enable.cb, !!v.enabled);
    setValue(debug.cb, !!v.debug);
    fillSelect(libSel, [["", "(meta library)"], ...(v.library || []).map((m) => [m.name, m.name])]);
    if (v.name && (v.library || []).some((m) => m.name === v.name)) setValue(libSel, v.name);
    const states = (v.states && v.states.length ? v.states : ["Default"]).map((s) => [s, s]);
    if (!states.some(([s]) => s === v.state) && v.state) states.push([v.state, v.state]);
    fillSelect(stateSel, states);
    setValue(stateSel, v.state || "Default");
    setText(strip, stripText(v));
    const sig = JSON.stringify([v.available, v.loaded, (v.groups || []).map((g) => [g.state, g.current, g.rules.map((r) => [r.id, r.enabled, r.fired, r.condText, r.actText])])]);
    if (shouldRebuild(list, sig, force)) build(v);
    const avail = !!v.available;
    for (const c of [enable.cb, debug.cb, stateSel, addRule]) c.disabled = !avail && c !== enable.cb;
    const lib = !!v.libraryAvailable;
    for (const c of [libSel, bLoad, bSave, kindSel, bExport, imp]) c.disabled = !lib;
  }

  return { id: "meta", el: root, snapshotId: () => "meta", update, renderWindow };
}

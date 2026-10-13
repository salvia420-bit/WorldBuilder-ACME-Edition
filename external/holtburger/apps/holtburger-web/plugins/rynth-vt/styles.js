// plugins/rynth-vt/styles.js — the VTank panel's stylesheet (PLAN W1-10).
// Builds on the HUD kit (ui/hud_kit.js `hbk-*` classes, installed at boot);
// this sheet only lays the panel out and adds the VTank-specific states
// (fired meta rules red, inert options greyed, No-Buffs items greyed, the
// green "current waypoint" arrow). Injected once, removed on dispose.

export const VT_STYLE_ID = "hb-rynth-vt-style";
export const VT_ROOT_ID = "hb-rynth-vt";
const SP = "./data/ui-sprites";

export const VT_CSS = `
  #${VT_ROOT_ID} { right: 364px; top: 96px; width: 560px; z-index: 61; background: transparent; isolation: isolate; }
  #${VT_ROOT_ID}[data-open="0"] { display: none; }
  #${VT_ROOT_ID}::before {
    content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;
    background: url("${SP}/0x06004CC2.png") repeat, var(--hbk-ink, #0b0c10);
    opacity: var(--rvt-alpha, 0.95);
  }
  #${VT_ROOT_ID} .hbk-titlebar { gap: 3px; }
  #${VT_ROOT_ID} .hbk-titlebar > .hbk-title { flex: 1 1 auto; min-width: 0; text-align: center; }
  #${VT_ROOT_ID} .rvt-hdr-btn {
    min-width: 18px; height: 16px; padding: 0 4px; margin: 0 1px;
    border: 1px solid var(--hbk-gold-deep, #4e3f1f); background: rgba(0, 0, 0, 0.55);
    color: var(--hbk-gold, #d9b45a); font: 11px/14px var(--hbk-font); cursor: pointer;
  }
  #${VT_ROOT_ID} .rvt-tabs { min-height: 18px; }
  #${VT_ROOT_ID} .rvt-tabs + .rvt-tabs { border-top: 0; }
  #${VT_ROOT_ID} .rvt-banner { padding: 3px 8px; font-size: 11px; color: #ffcf7a; background: rgba(120, 70, 0, 0.35); border-bottom: 1px solid #4e3f1f; }
  #${VT_ROOT_ID} .rvt-banner[hidden] { display: none; }
  #${VT_ROOT_ID} .rvt-content { padding: 6px 8px; max-height: 440px; min-height: 160px; font-size: 11px; }
  #${VT_ROOT_ID} .rvt-tab-body[hidden] { display: none; }
  #${VT_ROOT_ID} .rvt-msg { min-height: 14px; padding: 0 8px; font-size: 11px; color: var(--hbk-gold-bright, #f3d27a); }
  #${VT_ROOT_ID} .rvt-msg[data-kind="error"] { color: var(--hbk-warn, #ff6a50); }
  #${VT_ROOT_ID} .rvt-status { padding: 3px 8px 5px; font-size: 10px; color: var(--hbk-text-dim, #a8a090); border-top: 1px solid var(--hbk-gold-deep, #4e3f1f); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #${VT_ROOT_ID} .rvt-row { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; padding: 2px 0; }
  #${VT_ROOT_ID} .rvt-grow { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #${VT_ROOT_ID} .rvt-note { color: var(--hbk-text-faint, #77705f); font-style: italic; margin: 2px 0 4px; }
  #${VT_ROOT_ID} input.hbk-input, #${VT_ROOT_ID} select.hbk-select, #${VT_ROOT_ID} textarea.hbk-input { min-height: 18px; font-size: 11px; padding: 1px 4px; }
  #${VT_ROOT_ID} .rvt-num { width: 64px; }
  #${VT_ROOT_ID} .rvt-num-s { width: 48px; }
  #${VT_ROOT_ID} .rvt-textarea { width: 100%; box-sizing: border-box; resize: vertical; font-family: var(--hb-font-mono, ui-monospace, Menlo, Consolas, monospace); }
  #${VT_ROOT_ID} .rvt-file { max-width: 170px; }
  #${VT_ROOT_ID} .rvt-check { margin-right: 8px; }
  #${VT_ROOT_ID} .rvt-run { min-width: 96px; height: 22px; font: bold 12px/20px var(--hbk-font); border: 1px solid #000; border-radius: 3px; color: #f4ecd8; cursor: pointer;
    background: linear-gradient(180deg, #5c2a22 0%, #2c120e 100%); }
  #${VT_ROOT_ID} .rvt-run[data-state="running"] { background: linear-gradient(180deg, #2f6b3a 0%, #133a1c 100%); }
  #${VT_ROOT_ID} .rvt-groups { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; }
  #${VT_ROOT_ID} .rvt-group { min-width: 0; }
  #${VT_ROOT_ID} .rvt-group .hbk-section-title { margin-bottom: 2px; }
  #${VT_ROOT_ID} .rvt-opt { display: flex; align-items: center; gap: 4px; min-height: 20px; }
  #${VT_ROOT_ID} .rvt-opt-label { flex: 1 1 auto; color: var(--hbk-text, #e8dfc8); }
  #${VT_ROOT_ID} .rvt-opt.is-inert, #${VT_ROOT_ID} .rvt-opt.is-inert .rvt-opt-label { color: var(--hbk-text-faint, #77705f); filter: grayscale(0.8); opacity: 0.7; }
  #${VT_ROOT_ID} .rvt-opt.is-changed .rvt-opt-label, #${VT_ROOT_ID} .rvt-opt.is-changed .hbk-label span { color: var(--hbk-gold-bright, #f3d27a); }
  #${VT_ROOT_ID} .rvt-unit { color: var(--hbk-text-faint, #77705f); min-width: 14px; }
  #${VT_ROOT_ID} .rvt-table-wrap { overflow-x: auto; }
  #${VT_ROOT_ID} table.rvt-table { border-collapse: collapse; font-size: 10px; }
  #${VT_ROOT_ID} table.rvt-table th { color: var(--hbk-gold, #d9b45a); font-weight: normal; padding: 1px 2px; white-space: nowrap; }
  #${VT_ROOT_ID} table.rvt-table td { padding: 1px 2px; text-align: center; white-space: nowrap; }
  #${VT_ROOT_ID} table.rvt-table td.rvt-name { text-align: left; }
  #${VT_ROOT_ID} table.rvt-table tr.is-default td.rvt-name { color: var(--hbk-gold-bright, #f3d27a); }
  #${VT_ROOT_ID} table.rvt-table select.hbk-select { font-size: 10px; padding: 0 2px; min-height: 16px; max-width: 92px; }
  #${VT_ROOT_ID} table.rvt-table input.hbk-input { font-size: 10px; min-height: 16px; width: 120px; }
  #${VT_ROOT_ID} .is-error, #${VT_ROOT_ID} input.hbk-input.is-error { border-color: var(--hbk-warn, #ff6a50) !important; color: #ffb0a0; }
  #${VT_ROOT_ID} .rvt-expr { border: 1px solid var(--hbk-gold-deep, #4e3f1f); padding: 4px; margin: 4px 0; background: rgba(0, 0, 0, 0.35); }
  #${VT_ROOT_ID} .rvt-expr[hidden] { display: none; }
  #${VT_ROOT_ID} .rvt-list { display: flex; flex-direction: column; }
  #${VT_ROOT_ID} .rvt-item { display: flex; align-items: center; gap: 4px; padding: 1px 2px; min-height: 19px; border-left: 2px solid transparent; }
  #${VT_ROOT_ID} .rvt-item:nth-child(even) { background: rgba(255, 255, 255, 0.025); }
  #${VT_ROOT_ID} .rvt-item.is-selected { background: var(--hbk-sel, rgba(243, 210, 122, 0.16)); border-left-color: var(--hbk-gold, #d9b45a); }
  #${VT_ROOT_ID} .rvt-item.is-nobuffs, #${VT_ROOT_ID} .rvt-item.is-missing { color: var(--hbk-text-faint, #77705f); filter: grayscale(0.8); opacity: 0.65; }
  #${VT_ROOT_ID} .rvt-arrow { width: 14px; color: transparent; text-align: center; }
  #${VT_ROOT_ID} .rvt-item.is-active .rvt-arrow { color: #6fe36f; text-shadow: 0 0 4px #2f8f2f; }
  #${VT_ROOT_ID} .rvt-fams { display: flex; flex-wrap: wrap; gap: 0 6px; padding-left: 14px; }
  #${VT_ROOT_ID} .rvt-rule.is-fired, #${VT_ROOT_ID} .rvt-rule.is-fired .rvt-grow { color: #ff5a4a; }
  #${VT_ROOT_ID} .rvt-rule.is-disabled { opacity: 0.55; }
  #${VT_ROOT_ID} .rvt-state-head { margin-top: 3px; padding: 1px 4px; color: var(--hbk-gold, #d9b45a); border-bottom: 1px solid var(--hbk-gold-deep, #4e3f1f); }
  #${VT_ROOT_ID} .rvt-state-head.is-current { color: var(--hbk-gold-bright, #f3d27a); background: rgba(243, 210, 122, 0.08); }
  #${VT_ROOT_ID} .rvt-strip { font-size: 10px; color: var(--hbk-text-dim, #a8a090); padding: 2px 0; }
  #${VT_ROOT_ID} .rvt-virtual { overflow-y: auto; max-height: 240px; position: relative; }
  #${VT_ROOT_ID} .rvt-editor { border: 1px solid var(--hbk-gold-dim, #8a7544); padding: 4px; margin: 4px 0; background: rgba(0, 0, 0, 0.45); }
  #${VT_ROOT_ID} .rvt-editor[hidden] { display: none; }
  #${VT_ROOT_ID} .rvt-editor-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  #${VT_ROOT_ID} .rvt-node { border-left: 1px dotted var(--hbk-gold-deep, #4e3f1f); padding-left: 6px; margin: 2px 0; }
  #${VT_ROOT_ID} .rvt-lootrule { border: 1px solid var(--hbk-gold-deep, #4e3f1f); padding: 3px; margin: 3px 0; }
  #${VT_ROOT_ID} .rvt-sub[hidden] { display: none; }
  .rvt-view { position: fixed; z-index: 62; min-width: 120px; min-height: 60px; }
  .rvt-view .rvt-view-body { position: relative; }
  .rvt-view .rvt-ctl { position: absolute; box-sizing: border-box; font-size: 11px; }
  .rvt-view .rvt-ctl[hidden] { display: none; }
  .rvt-view .rvt-ctl.rvt-unsupported { border: 1px dashed var(--hbk-text-faint, #77705f); color: var(--hbk-text-faint, #77705f); font-style: italic; padding: 1px 3px; }
`;

export function ensureVtStyles(doc = globalThis.document) {
  if (!doc || !doc.head) return null;
  const have = doc.getElementById ? doc.getElementById(VT_STYLE_ID) : null;
  if (have) return have;
  const st = doc.createElement("style");
  st.id = VT_STYLE_ID;
  st.textContent = VT_CSS;
  doc.head.appendChild(st);
  return st;
}

export function removeVtStyles(doc = globalThis.document) {
  try {
    doc?.getElementById?.(VT_STYLE_ID)?.remove();
  } catch {
    /* ignore */
  }
}

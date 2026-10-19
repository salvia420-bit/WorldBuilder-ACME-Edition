// plugins/rynth-vt/styles.js — the VTank panel's stylesheet (PLAN W1-10;
// v2 layout 2026-10-19).
// Builds on the HUD kit (ui/hud_kit.js `hbk-*` classes, installed at boot);
// this sheet lays the panel out — command bar, one tab row, footer — and adds
// the VTank-specific states (fired meta rules red, inert options greyed,
// No-Buffs items greyed, the green "current waypoint" arrow, the buff timer
// colours). Injected once, removed on dispose.

export const VT_STYLE_ID = "hb-rynth-vt-style";
export const VT_ROOT_ID = "hb-rynth-vt";
const SP = "./data/ui-sprites";

export const VT_CSS = `
  #${VT_ROOT_ID} { right: 364px; top: 96px; width: 568px; z-index: 61; background: transparent; isolation: isolate; font-size: 11px; }
  #${VT_ROOT_ID}[data-open="0"] { display: none; }
  #${VT_ROOT_ID}::before {
    content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;
    background: url("${SP}/0x06004CC2.png") repeat, var(--hbk-ink, #0b0c10);
    opacity: var(--rvt-alpha, 0.95);
  }
  #${VT_ROOT_ID} [hidden] { display: none !important; }
  #${VT_ROOT_ID} .hbk-titlebar { gap: 3px; }
  #${VT_ROOT_ID} .hbk-titlebar > .hbk-title { flex: 1 1 auto; min-width: 0; text-align: center; }
  #${VT_ROOT_ID} .rvt-hdr-btn {
    min-width: 18px; height: 16px; padding: 0 4px; margin: 0 1px;
    border: 1px solid var(--hbk-gold-deep, #4e3f1f); background: rgba(0, 0, 0, 0.55);
    color: var(--hbk-gold, #d9b45a); font: 11px/14px var(--hbk-font); cursor: pointer;
  }
  #${VT_ROOT_ID} .rvt-hdr-btn:hover { color: var(--hbk-gold-bright, #f3d27a); border-color: var(--hbk-gold-dim, #8a7544); }

  /* ── command bar: Run · switches · profile ─────────────────────────── */
  #${VT_ROOT_ID} .rvt-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; padding: 4px 6px; background: rgba(0, 0, 0, 0.38); border-bottom: 1px solid var(--hbk-gold-deep, #4e3f1f); }
  #${VT_ROOT_ID} .rvt-run { flex: 0 0 auto; min-width: 82px; height: 20px; padding: 0 6px; font: bold 11px/18px var(--hbk-font); letter-spacing: 1px; border: 1px solid #000; border-radius: 3px; color: #f4ecd8; cursor: pointer;
    background: linear-gradient(180deg, #5c2a22 0%, #2c120e 100%); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12); }
  #${VT_ROOT_ID} .rvt-run:hover { filter: brightness(1.2); }
  #${VT_ROOT_ID} .rvt-run[data-state="running"] { background: linear-gradient(180deg, #2f6b3a 0%, #133a1c 100%); }
  #${VT_ROOT_ID} .rvt-run[data-state="off"] { background: linear-gradient(180deg, #4e4520 0%, #241f0c 100%); }
  #${VT_ROOT_ID} .rvt-run:disabled { filter: grayscale(0.7) brightness(0.6); cursor: default; }
  #${VT_ROOT_ID} .rvt-switches { display: flex; gap: 2px; flex: 0 0 auto; }
  #${VT_ROOT_ID} .rvt-tgl {
    height: 20px; min-width: 0; padding: 0 6px; font: 10px/18px var(--hbk-font); letter-spacing: 0.06em; text-transform: uppercase;
    border: 1px solid #000; border-radius: 3px; color: var(--hbk-text-dim, #a8a090); cursor: pointer;
    background: linear-gradient(180deg, #2a241a 0%, #120f09 100%);
  }
  #${VT_ROOT_ID} .rvt-tgl:hover { color: var(--hbk-text, #e8dfc8); }
  #${VT_ROOT_ID} .rvt-tgl.is-on { color: #10140c; background: linear-gradient(180deg, #e7c66a 0%, #9a7a2e 100%); }
  #${VT_ROOT_ID} .rvt-tgl.is-paused { outline: 1px dashed var(--hbk-gold, #d9b45a); outline-offset: -3px; }
  #${VT_ROOT_ID} .rvt-tgl:disabled { filter: grayscale(0.8) brightness(0.55); cursor: default; }
  #${VT_ROOT_ID} .rvt-prof { flex: 1 1 160px; min-width: 0; display: flex; align-items: center; justify-content: flex-end; gap: 3px; }
  #${VT_ROOT_ID} .rvt-prof select.hbk-select { min-width: 0; max-width: 160px; flex: 0 1 auto; min-height: 20px; font-size: 11px; padding: 0 16px 0 4px; }
  #${VT_ROOT_ID} .rvt-prof.is-readonly select.hbk-select { border-color: #8a6a28; }
  #${VT_ROOT_ID} .rvt-ro { flex: 0 0 auto; padding: 0 4px; border: 1px solid #6a5222; border-radius: 3px; color: #ffcf7a; background: rgba(120, 70, 0, 0.35); font: 10px/16px var(--hbk-font); cursor: pointer; white-space: nowrap; }
  #${VT_ROOT_ID} .rvt-ro:hover { filter: brightness(1.25); }
  #${VT_ROOT_ID} .rvt-more { min-width: 20px; height: 20px; padding: 0 4px; border: 1px solid var(--hbk-gold-deep, #4e3f1f); background: rgba(0, 0, 0, 0.55); color: var(--hbk-gold, #d9b45a); font: 12px/16px var(--hbk-font); cursor: pointer; }
  #${VT_ROOT_ID} .rvt-more.is-active, #${VT_ROOT_ID} .rvt-more:hover { color: var(--hbk-gold-bright, #f3d27a); border-color: var(--hbk-gold-dim, #8a7544); }
  #${VT_ROOT_ID} .rvt-drawer { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; padding: 4px 6px; background: rgba(0, 0, 0, 0.3); border-bottom: 1px solid var(--hbk-gold-deep, #4e3f1f); }
  #${VT_ROOT_ID} .rvt-sep { width: 1px; align-self: stretch; min-height: 14px; background: var(--hbk-gold-deep, #4e3f1f); }

  /* ── tabs, content, footer ─────────────────────────────────────────── */
  #${VT_ROOT_ID} .rvt-tabs { min-height: 19px; }
  #${VT_ROOT_ID} .rvt-tabs .hbk-tab { flex: 1 1 auto; padding: 2px 4px 3px; letter-spacing: 0.04em; }
  #${VT_ROOT_ID} .rvt-content { padding: 6px 8px; max-height: 436px; min-height: 200px; }
  #${VT_ROOT_ID} .rvt-foot { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 8px; min-height: 16px; padding: 2px 8px 4px; font-size: 10px; border-top: 1px solid var(--hbk-gold-deep, #4e3f1f); }
  #${VT_ROOT_ID} .rvt-status { flex: 1 1 200px; min-width: 0; color: var(--hbk-text-dim, #a8a090); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #${VT_ROOT_ID} .rvt-msg { flex: 0 1 auto; max-width: 100%; color: var(--hbk-gold-bright, #f3d27a); overflow-wrap: anywhere; }
  #${VT_ROOT_ID} .rvt-msg[data-kind="error"] { flex-basis: 100%; color: var(--hbk-warn, #ff6a50); }

  /* ── shared building blocks ────────────────────────────────────────── */
  #${VT_ROOT_ID} .rvt-row { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; padding: 2px 0; }
  #${VT_ROOT_ID} .rvt-row.is-nowrap { flex-wrap: nowrap; }
  #${VT_ROOT_ID} .rvt-grow { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #${VT_ROOT_ID} .rvt-note { color: var(--hbk-text-faint, #77705f); font-style: italic; margin: 2px 0 4px; }
  #${VT_ROOT_ID} .rvt-dim { color: var(--hbk-text-dim, #a8a090); }
  #${VT_ROOT_ID} .rvt-faint { color: var(--hbk-text-faint, #77705f); }
  #${VT_ROOT_ID} .rvt-lbl { color: var(--hbk-text-dim, #a8a090); white-space: nowrap; }
  #${VT_ROOT_ID} input.hbk-input, #${VT_ROOT_ID} select.hbk-select, #${VT_ROOT_ID} textarea.hbk-input { min-height: 18px; font-size: 11px; padding: 1px 4px; }
  #${VT_ROOT_ID} select.hbk-select { padding-right: 14px; }
  #${VT_ROOT_ID} .hbk-btn-small { min-width: 0; min-height: 16px; padding: 0 6px; font-size: 10px; }
  #${VT_ROOT_ID} .hbk-btn-small.is-primary { color: #fff6dc; filter: brightness(1.18) saturate(1.2); }
  #${VT_ROOT_ID} .hbk-btn-small.is-armed { color: #ffd0c0; filter: hue-rotate(-25deg) brightness(1.2); }
  #${VT_ROOT_ID} .hbk-btn-small.is-active { color: var(--hbk-gold-bright, #f3d27a); box-shadow: 0 0 0 1px var(--hbk-gold-dim, #8a7544); }
  #${VT_ROOT_ID} .rvt-num { width: 64px; }
  #${VT_ROOT_ID} .rvt-num-s { width: 48px; }
  #${VT_ROOT_ID} .rvt-num-xs { width: 42px; text-align: right; }
  #${VT_ROOT_ID} .rvt-numf { display: inline-flex; align-items: center; gap: 2px; white-space: nowrap; }
  #${VT_ROOT_ID} .rvt-numf.is-changed input.hbk-input, #${VT_ROOT_ID} .hbk-label.is-changed span { color: var(--hbk-gold-bright, #f3d27a); }
  #${VT_ROOT_ID} .rvt-textarea { width: 100%; box-sizing: border-box; resize: vertical; font-family: var(--hb-font-mono, ui-monospace, Menlo, Consolas, monospace); }
  #${VT_ROOT_ID} .rvt-check { margin-right: 6px; }
  #${VT_ROOT_ID} .rvt-unit { color: var(--hbk-text-faint, #77705f); min-width: 10px; }
  #${VT_ROOT_ID} .rvt-filebtn { display: inline-flex; }
  #${VT_ROOT_ID} .rvt-sec { display: flex; align-items: center; gap: 6px; margin: 6px 0 3px; padding: 1px 4px; color: var(--hbk-gold-bright, #f3d27a); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
    background: linear-gradient(90deg, rgba(243, 210, 122, 0.12), transparent 80%); border-top: 1px solid rgba(243, 210, 122, 0.22); }
  #${VT_ROOT_ID} .rvt-sec:first-child { margin-top: 0; }
  #${VT_ROOT_ID} .rvt-sec .rvt-sec-meta { margin-left: auto; color: var(--hbk-text-dim, #a8a090); letter-spacing: 0; text-transform: none; }
  #${VT_ROOT_ID} .rvt-sec .rvt-faint { letter-spacing: 0; text-transform: none; font-style: italic; }
  #${VT_ROOT_ID} .rvt-card { min-width: 0; border: 1px solid rgba(78, 63, 31, 0.9); background: rgba(0, 0, 0, 0.28); padding: 3px 6px 5px; }
  #${VT_ROOT_ID} .rvt-card-title { margin: 0 -6px 3px; padding: 1px 6px 2px; color: var(--hbk-gold, #d9b45a); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; border-bottom: 1px solid rgba(78, 63, 31, 0.9); }
  #${VT_ROOT_ID} .rvt-seg { display: inline-flex; border: 1px solid #000; border-radius: 3px; overflow: hidden; }
  #${VT_ROOT_ID} .rvt-seg-btn { height: 18px; padding: 0 7px; border: 0; border-right: 1px solid #000; background: linear-gradient(180deg, #2a241a 0%, #120f09 100%); color: var(--hbk-text-dim, #a8a090); font: 10px/18px var(--hbk-font); cursor: pointer; }
  #${VT_ROOT_ID} .rvt-seg-btn:last-child { border-right: 0; }
  #${VT_ROOT_ID} .rvt-seg-btn.is-on { color: #10140c; background: linear-gradient(180deg, #e7c66a 0%, #9a7a2e 100%); }
  #${VT_ROOT_ID} .rvt-seg-btn:disabled { filter: grayscale(0.8) brightness(0.55); cursor: default; }
  #${VT_ROOT_ID} .rvt-list { display: flex; flex-direction: column; }
  #${VT_ROOT_ID} .rvt-scroll { overflow-y: auto; }
  #${VT_ROOT_ID} .rvt-item { display: flex; align-items: center; gap: 4px; padding: 1px 2px; min-height: 19px; border-left: 2px solid transparent; }
  #${VT_ROOT_ID} .rvt-item:nth-child(even) { background: rgba(255, 255, 255, 0.025); }
  #${VT_ROOT_ID} .rvt-item:hover { background: var(--hbk-hover, rgba(243, 210, 122, 0.08)); }
  #${VT_ROOT_ID} .rvt-item.is-selected { background: var(--hbk-sel, rgba(243, 210, 122, 0.16)); border-left-color: var(--hbk-gold, #d9b45a); }
  #${VT_ROOT_ID} .rvt-item.is-nobuffs, #${VT_ROOT_ID} .rvt-item.is-missing { color: var(--hbk-text-faint, #77705f); }
  #${VT_ROOT_ID} .rvt-item.is-missing .rvt-grow { text-decoration: line-through; text-decoration-color: rgba(255, 106, 80, 0.6); }
  #${VT_ROOT_ID} .rvt-acts { display: inline-flex; gap: 1px; opacity: 0.45; transition: opacity 120ms; }
  #${VT_ROOT_ID} .rvt-item:hover .rvt-acts, #${VT_ROOT_ID} .rvt-item:focus-within .rvt-acts, #${VT_ROOT_ID} .rvt-item.is-selected .rvt-acts, #${VT_ROOT_ID} tr:hover .rvt-acts { opacity: 1; }
  #${VT_ROOT_ID} .rvt-ico { min-width: 16px; height: 16px; padding: 0 3px; border: 1px solid transparent; background: transparent; color: var(--hbk-text-dim, #a8a090); font: 11px/14px var(--hbk-font); cursor: pointer; }
  #${VT_ROOT_ID} .rvt-ico:hover { color: var(--hbk-gold-bright, #f3d27a); border-color: var(--hbk-gold-deep, #4e3f1f); background: rgba(0, 0, 0, 0.4); }
  #${VT_ROOT_ID} .rvt-ico:disabled { opacity: 0.3; cursor: default; }
  #${VT_ROOT_ID} .rvt-ico.is-danger:hover { color: var(--hbk-warn, #ff6a50); }
  #${VT_ROOT_ID} .is-error, #${VT_ROOT_ID} input.hbk-input.is-error { border-color: var(--hbk-warn, #ff6a50) !important; color: #ffb0a0; }
  #${VT_ROOT_ID} .rvt-empty { padding: 14px 10px; text-align: center; color: var(--hbk-text-faint, #77705f); font-style: italic; }
  #${VT_ROOT_ID} [role="button"]:focus-visible, #${VT_ROOT_ID} .rvt-item[tabindex]:focus-visible { outline: 1px solid var(--hbk-gold, #d9b45a); outline-offset: -1px; }
  #${VT_ROOT_ID} .rvt-name-in { width: 92px; }

  /* ── option editors (Main, Advanced, Buffs/Loot knobs) ─────────────── */
  #${VT_ROOT_ID} .rvt-groups { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; }
  #${VT_ROOT_ID} .rvt-group { min-width: 0; }
  #${VT_ROOT_ID} .rvt-opt { display: flex; align-items: center; gap: 4px; min-height: 19px; }
  #${VT_ROOT_ID} .rvt-opt-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--hbk-text, #e8dfc8); }
  #${VT_ROOT_ID} .rvt-opt .hbk-label { min-width: 0; }
  #${VT_ROOT_ID} .rvt-opt .hbk-label span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #${VT_ROOT_ID} .rvt-opt.is-inert, #${VT_ROOT_ID} .rvt-opt.is-inert .rvt-opt-label, #${VT_ROOT_ID} .rvt-opt.is-inert .hbk-label { color: var(--hbk-text-faint, #77705f); filter: grayscale(0.8); opacity: 0.7; }
  #${VT_ROOT_ID} .rvt-opt.is-changed .rvt-opt-label, #${VT_ROOT_ID} .rvt-opt.is-changed .hbk-label span { color: var(--hbk-gold-bright, #f3d27a); }
  #${VT_ROOT_ID} .rvt-opt .rvt-home { color: var(--hbk-text-faint, #77705f); font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; }
  #${VT_ROOT_ID} .rvt-tierstrip { flex-direction: column; align-items: stretch; gap: 1px; margin: 2px 0 4px; }
  #${VT_ROOT_ID} .rvt-tiergrid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 2px; }
  #${VT_ROOT_ID} .rvt-tiercell { display: flex; flex-direction: column; align-items: center; font-size: 9px; line-height: 11px; }
  #${VT_ROOT_ID} .rvt-tiercell input.hbk-input.rvt-tier-in { width: 100%; min-width: 0; padding: 1px 1px; text-align: center; appearance: textfield; -moz-appearance: textfield; }
  #${VT_ROOT_ID} .rvt-tiercell input.rvt-tier-in::-webkit-inner-spin-button, #${VT_ROOT_ID} .rvt-tiercell input.rvt-tier-in::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
  #${VT_ROOT_ID} .rvt-tiercell.is-changed input.hbk-input { color: var(--hbk-gold-bright, #f3d27a); }

  /* ── Main ──────────────────────────────────────────────────────────── */
  #${VT_ROOT_ID} .rvt-main { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 8px; }
  #${VT_ROOT_ID} .rvt-main .rvt-span2 { grid-column: 1 / -1; }
  #${VT_ROOT_ID} .rvt-ranges { display: grid; grid-template-columns: auto auto; gap: 2px 8px; align-items: center; justify-content: start; }
  #${VT_ROOT_ID} .rvt-checks { display: grid; grid-template-columns: 1fr 1fr; gap: 0 6px; }
  #${VT_ROOT_ID} .rvt-checks .rvt-opt { min-height: 18px; }
  #${VT_ROOT_ID} .rvt-vit { display: grid; grid-template-columns: 74px repeat(3, 1fr); gap: 3px 6px; align-items: center; }
  #${VT_ROOT_ID} .rvt-vit-h { text-align: center; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; }
  #${VT_ROOT_ID} .rvt-vit-h.is-hp { color: #ff8a70; }
  #${VT_ROOT_ID} .rvt-vit-h.is-st { color: #f0d060; }
  #${VT_ROOT_ID} .rvt-vit-h.is-mn { color: #80a8ff; }
  #${VT_ROOT_ID} .rvt-vit-cell { display: flex; justify-content: center; }
  #${VT_ROOT_ID} .rvt-vbar { position: relative; height: 12px; border: 1px solid #000; background: #0d0b08; box-shadow: inset 0 1px 2px #000; }
  #${VT_ROOT_ID} .rvt-vbar-fill { position: absolute; left: 0; top: 0; bottom: 0; width: 0; }
  #${VT_ROOT_ID} .rvt-vbar.is-hp .rvt-vbar-fill { background: linear-gradient(180deg, #d84030, #6a1010); }
  #${VT_ROOT_ID} .rvt-vbar.is-st .rvt-vbar-fill { background: linear-gradient(180deg, #e0c040, #6a5a10); }
  #${VT_ROOT_ID} .rvt-vbar.is-mn .rvt-vbar-fill { background: linear-gradient(180deg, #4070e0, #102a6a); }
  #${VT_ROOT_ID} .rvt-vmark { position: absolute; top: -2px; bottom: -2px; width: 2px; margin-left: -1px; }
  #${VT_ROOT_ID} .rvt-vmark.is-idle { background: var(--hbk-gold-bright, #f3d27a); box-shadow: 0 0 2px #000; }
  #${VT_ROOT_ID} .rvt-vmark.is-combat { background: #f4f4f4; box-shadow: 0 0 2px #000; }
  #${VT_ROOT_ID} .rvt-vbar-text { position: absolute; inset: 0; text-align: center; font-size: 9px; line-height: 11px; color: #fff; text-shadow: 0 0 2px #000, 0 1px 0 #000; }
  #${VT_ROOT_ID} .rvt-vit-legend { grid-column: 1 / -1; display: flex; gap: 10px; color: var(--hbk-text-faint, #77705f); font-size: 10px; }
  #${VT_ROOT_ID} .rvt-key { display: inline-block; width: 8px; height: 8px; margin-right: 3px; vertical-align: -1px; }
  #${VT_ROOT_ID} .rvt-key.is-idle { background: var(--hbk-gold-bright, #f3d27a); }
  #${VT_ROOT_ID} .rvt-key.is-combat { background: #f4f4f4; }
  #${VT_ROOT_ID} .rvt-rule-line { display: flex; align-items: center; flex-wrap: wrap; gap: 3px; margin-top: 3px; color: var(--hbk-text, #e8dfc8); }

  /* ── Monsters ──────────────────────────────────────────────────────── */
  #${VT_ROOT_ID} .rvt-table-wrap { overflow: auto; max-height: 334px; border: 1px solid rgba(78, 63, 31, 0.7); }
  #${VT_ROOT_ID} table.rvt-table { border-collapse: separate; border-spacing: 0; font-size: 10px; width: max-content; min-width: 100%; }
  #${VT_ROOT_ID} table.rvt-table th { position: sticky; top: 0; z-index: 2; background: #17130c; color: var(--hbk-gold, #d9b45a); font-weight: normal; padding: 2px 3px; white-space: nowrap; border-bottom: 1px solid var(--hbk-gold-deep, #4e3f1f); cursor: default; }
  #${VT_ROOT_ID} table.rvt-table th.rvt-th-spell { min-width: 15px; }
  #${VT_ROOT_ID} table.rvt-table td { padding: 1px 2px; text-align: center; white-space: nowrap; }
  #${VT_ROOT_ID} table.rvt-table tr:nth-child(even) td { background: rgba(255, 255, 255, 0.025); }
  /* the name column stays put while the table scrolls sideways: it must be opaque on every row */
  #${VT_ROOT_ID} table.rvt-table td.rvt-name, #${VT_ROOT_ID} table.rvt-table th.rvt-name { position: sticky; left: 0; z-index: 1; text-align: left; background: #100e0a; }
  #${VT_ROOT_ID} table.rvt-table tr:nth-child(even) td.rvt-name { background: #15130e; }
  #${VT_ROOT_ID} table.rvt-table th.rvt-name { z-index: 3; background: #17130c; }
  #${VT_ROOT_ID} table.rvt-table tr.is-default td.rvt-name { color: var(--hbk-gold-bright, #f3d27a); }
  #${VT_ROOT_ID} table.rvt-table tr.is-target td { background-color: rgba(111, 227, 111, 0.09); }
  #${VT_ROOT_ID} table.rvt-table tr.is-target td.rvt-name { box-shadow: inset 3px 0 0 #6fe36f; background-color: #142614; }
  #${VT_ROOT_ID} table.rvt-table tr.is-off td > * { opacity: 0.5; }
  #${VT_ROOT_ID} table.rvt-table tr.is-off td.rvt-name > input.hbk-check { opacity: 1; }
  #${VT_ROOT_ID} table.rvt-table select.hbk-select { font-size: 10px; padding: 0 12px 0 2px; min-height: 16px; max-width: 86px; }
  #${VT_ROOT_ID} table.rvt-table input.hbk-input { font-size: 10px; min-height: 16px; width: 132px; }
  #${VT_ROOT_ID} table.rvt-table input.hbk-check { margin: 0; }
  #${VT_ROOT_ID} .rvt-expr { border: 1px solid var(--hbk-gold-deep, #4e3f1f); padding: 4px; margin: 4px 0; background: rgba(0, 0, 0, 0.35); }

  /* ── Items ─────────────────────────────────────────────────────────── */
  #${VT_ROOT_ID} .rvt-addbar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 4px; margin-bottom: 4px; border: 1px solid rgba(78, 63, 31, 0.9); background: rgba(0, 0, 0, 0.3); }
  #${VT_ROOT_ID} .rvt-addbar .rvt-addbar-row { flex: 1 1 100%; padding: 0; }
  #${VT_ROOT_ID} .rvt-selname { color: var(--hbk-value, #8aef6d); }
  #${VT_ROOT_ID} .rvt-selname.is-none { color: var(--hbk-text-faint, #77705f); font-style: italic; }
  #${VT_ROOT_ID} .rvt-kind { color: var(--hbk-text-dim, #a8a090); font-size: 10px; }
  #${VT_ROOT_ID} .rvt-items-list .rvt-item-kind { width: 124px; }
  #${VT_ROOT_ID} .rvt-items-list .rvt-item-element { width: 104px; }
  #${VT_ROOT_ID} .rvt-cons-list .rvt-cons-rowtype { width: 152px; }
  #${VT_ROOT_ID} .rvt-cons-list .rvt-item > .rvt-grow { flex: 1 1 120px; }

  /* ── Buffs ─────────────────────────────────────────────────────────── */
  #${VT_ROOT_ID} .rvt-bsum { display: flex; flex-wrap: wrap; gap: 2px 10px; color: var(--hbk-text-dim, #a8a090); }
  #${VT_ROOT_ID} .rvt-bsum b { font-weight: normal; color: var(--hbk-value, #8aef6d); }
  #${VT_ROOT_ID} .rvt-bsum b.is-warn { color: #ffb060; }
  #${VT_ROOT_ID} .rvt-bsum b.is-bad { color: var(--hbk-warn, #ff6a50); }
  #${VT_ROOT_ID} .rvt-bgroup-head { cursor: pointer; user-select: none; }
  #${VT_ROOT_ID} .rvt-bgroup-head:hover .rvt-fold-title { color: #fff2c8; }
  #${VT_ROOT_ID} .rvt-fold { width: 10px; color: var(--hbk-gold, #d9b45a); }
  #${VT_ROOT_ID} .rvt-bgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 10px; }
  #${VT_ROOT_ID} .rvt-brow { display: flex; align-items: center; gap: 3px; min-height: 18px; padding: 0 2px; border-bottom: 1px solid rgba(255, 255, 255, 0.03); }
  #${VT_ROOT_ID} .rvt-brow:hover { background: var(--hbk-hover, rgba(243, 210, 122, 0.08)); }
  #${VT_ROOT_ID} .rvt-brow .rvt-grow { color: var(--hbk-text, #e8dfc8); }
  #${VT_ROOT_ID} .rvt-brow.is-off .rvt-grow { color: var(--hbk-text-faint, #77705f); }
  #${VT_ROOT_ID} .rvt-tier { min-width: 22px; padding: 0 2px; text-align: center; font-size: 9px; color: var(--hbk-gold, #d9b45a); border: 1px solid rgba(78, 63, 31, 0.9); border-radius: 2px; }
  #${VT_ROOT_ID} .rvt-btime { min-width: 46px; text-align: right; font-size: 10px; font-variant-numeric: tabular-nums; }
  #${VT_ROOT_ID} .rvt-brow[data-state="ok"] .rvt-btime { color: var(--hbk-value, #8aef6d); }
  #${VT_ROOT_ID} .rvt-brow[data-state="soon"] .rvt-btime { color: #e8d070; }
  #${VT_ROOT_ID} .rvt-brow[data-state="low"] .rvt-btime { color: #ffb060; }
  #${VT_ROOT_ID} .rvt-brow[data-state="missing"] .rvt-btime { color: var(--hbk-warn, #ff6a50); }
  #${VT_ROOT_ID} .rvt-brow[data-state="off"] .rvt-btime { color: var(--hbk-text-faint, #77705f); }
  #${VT_ROOT_ID} table.rvt-ibm { border-collapse: collapse; font-size: 10px; }
  #${VT_ROOT_ID} table.rvt-ibm th { color: var(--hbk-gold, #d9b45a); font-weight: normal; padding: 1px 4px; white-space: nowrap; }
  #${VT_ROOT_ID} table.rvt-ibm td { padding: 1px 4px; text-align: center; }
  #${VT_ROOT_ID} table.rvt-ibm td.rvt-name { text-align: left; max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #${VT_ROOT_ID} table.rvt-ibm tr.is-nobuffs td { color: var(--hbk-text-faint, #77705f); filter: grayscale(0.8); opacity: 0.6; }
  #${VT_ROOT_ID} table.rvt-ibm td.rvt-name.is-custom { color: var(--hbk-gold-bright, #f3d27a); }
  #${VT_ROOT_ID} table.rvt-ibm tr.rvt-wornarmor td { border-bottom: 1px solid var(--hbk-gold-deep, #4e3f1f); }
  #${VT_ROOT_ID} table.rvt-ibm tr.rvt-wornarmor td.rvt-name { color: var(--hbk-gold-bright, #f3d27a); }
  #${VT_ROOT_ID} table.rvt-ibm td.is-worn .hbk-check { opacity: 0.5; }

  /* ── Route ─────────────────────────────────────────────────────────── */
  #${VT_ROOT_ID} .rvt-points { max-height: 236px; min-height: 60px; border: 1px solid rgba(78, 63, 31, 0.7); }
  #${VT_ROOT_ID} .rvt-points-head { display: flex; align-items: center; gap: 4px; padding: 1px 2px 2px; color: var(--hbk-text-dim, #a8a090); }
  #${VT_ROOT_ID} .rvt-arrow { width: 16px; height: 16px; padding: 0; border: 0; background: transparent; font: 12px/16px var(--hbk-font); color: rgba(111, 227, 111, 0.12); text-align: center; cursor: pointer; }
  #${VT_ROOT_ID} .rvt-arrow:focus-visible { outline: 1px solid #6fe36f; }
  #${VT_ROOT_ID} .rvt-arrow:hover { color: rgba(111, 227, 111, 0.6); }
  #${VT_ROOT_ID} .rvt-item.is-active .rvt-arrow { color: #6fe36f; text-shadow: 0 0 4px #2f8f2f; }
  #${VT_ROOT_ID} .rvt-pidx { min-width: 22px; text-align: right; color: var(--hbk-text-faint, #77705f); font-variant-numeric: tabular-nums; }
  #${VT_ROOT_ID} .rvt-ptype { min-width: 62px; color: var(--hbk-gold, #d9b45a); }
  #${VT_ROOT_ID} .rvt-ptype[data-type="0"], #${VT_ROOT_ID} .rvt-ptype[data-type="8"] { color: var(--hbk-text-dim, #a8a090); }
  #${VT_ROOT_ID} .rvt-ptype[data-type="2"] { color: #8fb8ff; }
  #${VT_ROOT_ID} .rvt-ptype[data-type="1"], #${VT_ROOT_ID} .rvt-ptype[data-type="6"], #${VT_ROOT_ID} .rvt-ptype[data-type="7"] { color: #d79bff; }
  #${VT_ROOT_ID} .rvt-ptype[data-type="9"] { color: #7fe0d0; }
  #${VT_ROOT_ID} .rvt-dist { min-width: 44px; text-align: right; color: var(--hbk-text-faint, #77705f); font-variant-numeric: tabular-nums; }
  #${VT_ROOT_ID} .rvt-item.is-active .rvt-dist { color: #6fe36f; }
  #${VT_ROOT_ID} .rvt-dirty { color: #ffb060; }

  /* ── Meta ──────────────────────────────────────────────────────────── */
  #${VT_ROOT_ID} .rvt-rule.is-fired, #${VT_ROOT_ID} .rvt-rule.is-fired .rvt-grow { color: #ff5a4a; }
  #${VT_ROOT_ID} .rvt-rule.is-disabled { opacity: 0.55; }
  #${VT_ROOT_ID} .rvt-state-head { margin-top: 3px; padding: 1px 4px; color: var(--hbk-gold, #d9b45a); border-bottom: 1px solid var(--hbk-gold-deep, #4e3f1f); }
  #${VT_ROOT_ID} .rvt-state-head.is-current { color: var(--hbk-gold-bright, #f3d27a); background: rgba(243, 210, 122, 0.08); }
  #${VT_ROOT_ID} .rvt-strip { font-size: 10px; color: var(--hbk-text-dim, #a8a090); padding: 2px 0; }
  #${VT_ROOT_ID} .rvt-virtual { overflow-y: auto; max-height: 250px; position: relative; border: 1px solid rgba(78, 63, 31, 0.7); }
  #${VT_ROOT_ID} .rvt-editor { border: 1px solid var(--hbk-gold-dim, #8a7544); padding: 4px; margin: 4px 0; background: rgba(0, 0, 0, 0.45); }
  #${VT_ROOT_ID} .rvt-editor-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  #${VT_ROOT_ID} .rvt-node { border-left: 1px dotted var(--hbk-gold-deep, #4e3f1f); padding-left: 6px; margin: 2px 0; }

  /* ── Loot ──────────────────────────────────────────────────────────── */
  #${VT_ROOT_ID} .rvt-lootrule { border: 1px solid var(--hbk-gold-deep, #4e3f1f); padding: 3px; margin: 3px 0; background: rgba(0, 0, 0, 0.2); }
  #${VT_ROOT_ID} .rvt-lootrules { max-height: 250px; overflow-y: auto; }

  /* ── meta views (windows created by a meta's CreateView) ───────────── */
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

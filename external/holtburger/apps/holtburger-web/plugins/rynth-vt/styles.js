// plugins/rynth-vt/styles.js — the VTank panel's stylesheet (PLAN W1-10;
// v2 layout 2026-10-19; dark fantasy restyle 2026-11-08).
// Builds on the HUD kit (ui/hud_kit.js `hbk-*` classes, installed at boot);
// this sheet lays the panel out — command bar, one tab row, footer — and adds
// the VTank-specific states (fired meta rules red, inert options greyed,
// No-Buffs items greyed, the green "current waypoint" arrow, the buff timer
// colours). Injected once, removed on dispose.

export const VT_STYLE_ID = "hb-rynth-vt-style";
export const VT_ROOT_ID = "hb-rynth-vt";
const SP = "./data/ui-sprites";

export const VT_CSS = `
  /* ── Outer Window Frame & Deep Obsidian Background ─────────────────── */
  #${VT_ROOT_ID} {
    right: 364px;
    top: 96px;
    width: 580px;
    z-index: 61;
    background: transparent;
    isolation: isolate;
    font-size: 11px;
    border-radius: 4px;
    border: 2px solid transparent;
    border-image: linear-gradient(135deg, #fae5a8 0%, #a87d24 22%, #ffd700 48%, #5a4014 74%, #caa148 100%) 2;
    box-shadow:
      0 0 0 1px #1a160d,
      0 0 0 2px #d4af37,
      inset 0 0 0 1px #221b0e,
      inset 0 0 0 2px #0a0908,
      inset 0 0 0 3px #8a6a24,
      inset 0 0 0 4px #4e3a12,
      0 18px 50px rgba(0, 0, 0, 0.95),
      0 0 30px rgba(212, 175, 55, 0.15),
      inset 0 0 40px rgba(0, 0, 0, 0.85);
    position: relative;
  }
  #${VT_ROOT_ID}[data-open="0"] { display: none; }
  #${VT_ROOT_ID}::before {
    content: "";
    position: absolute;
    inset: 2px;
    z-index: -1;
    pointer-events: none;
    border-radius: 3px;
    background:
      radial-gradient(ellipse 85% 55% at 50% 18%, rgba(45, 38, 25, 0.55) 0%, rgba(16, 14, 11, 0.85) 60%, rgba(5, 5, 7, 0.98) 100%),
      url("${SP}/0x06004CC2.png") repeat;
    background-blend-mode: overlay, normal;
    opacity: var(--rvt-alpha, 0.96);
  }
  #${VT_ROOT_ID} [hidden] { display: none !important; }

  /* ── Sculpted Corner Brackets & Center Anchor Crest ─────────────────── */
  #${VT_ROOT_ID} .rvt-corner {
    position: absolute;
    width: 44px;
    height: 44px;
    pointer-events: none;
    z-index: 15;
    background-size: contain;
    background-repeat: no-repeat;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 44 44' fill='none'%3E%3Cdefs%3E%3ClinearGradient id='cGold' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%23fff2be'/%3E%3Cstop offset='25%25' stop-color='%23d4af37'/%3E%3Cstop offset='65%25' stop-color='%238a6820'/%3E%3Cstop offset='100%25' stop-color='%234e3810'/%3E%3C/linearGradient%3E%3ClinearGradient id='cGlint' x1='0%25' y1='100%25' x2='100%25' y2='0%25'%3E%3Cstop offset='0%25' stop-color='%235a4214'/%3E%3Cstop offset='50%25' stop-color='%23fae5a8'/%3E%3Cstop offset='100%25' stop-color='%239a7424'/%3E%3C/linearGradient%3E%3Cfilter id='cShadow' x='-20%25' y='-20%25' width='140%25' height='140%25'%3E%3CfeDropShadow dx='0' dy='1' stdDeviation='1.5' flood-color='%23000' flood-opacity='0.9'/%3E%3C/filter%3E%3C/defs%3E%3Cg filter='url(%23cShadow)'%3E%3Cpath d='M 2 42 L 2 6 C 2 3.8 3.8 2 6 2 L 42 2 L 42 5 L 7 5 C 5.9 5 5 5.9 5 7 L 5 42 Z' fill='url(%23cGold)'/%3E%3Cpath d='M 1 42 L 1 6 C 1 3.2 3.2 1 6 1 L 42 1 L 42 2 L 6 2 C 3.8 2 2 3.8 2 6 L 2 42 Z' fill='%23fff6cc' opacity='0.8'/%3E%3Cpath d='M 5 32 C 5 18 18 5 32 5 L 32 7 C 19 7 7 19 7 32 Z' fill='url(%23cGlint)'/%3E%3Cpath d='M 4 22 C 8 22 12 18 12 14 C 12 10 9 9 7 11 C 5 13 4 17 4 22 Z' fill='url(%23cGold)'/%3E%3Cpath d='M 22 4 C 22 8 18 12 14 12 C 10 12 9 9 11 7 C 13 5 17 4 22 4 Z' fill='url(%23cGold)'/%3E%3Cpath d='M 8 36 C 12 30 18 24 24 18 C 30 12 36 8 40 6 L 39 8 C 35 10 29 14 23 20 C 17 26 11 32 8 36 Z' fill='url(%23cGold)'/%3E%3Cpolygon points='12,7 17,12 12,17 7,12' fill='%232a1f0a' stroke='url(%23cGlint)' stroke-width='1.2'/%3E%3Cpolygon points='12,9 15,12 12,15 9,12' fill='url(%23cGold)'/%3E%3Ccircle cx='12' cy='12' r='1.5' fill='%23fff9db'/%3E%3C/g%3E%3C/svg%3E");
  }
  #${VT_ROOT_ID} .rvt-corner-tl { top: -2px; left: -2px; }
  #${VT_ROOT_ID} .rvt-corner-tr { top: -2px; right: -2px; transform: scaleX(-1); }
  #${VT_ROOT_ID} .rvt-corner-bl { bottom: -2px; left: -2px; transform: scaleY(-1); }
  #${VT_ROOT_ID} .rvt-corner-br { bottom: -2px; right: -2px; transform: scale(-1, -1); }

  #${VT_ROOT_ID} .rvt-anchor-crest {
    position: absolute;
    bottom: -12px;
    left: 50%;
    transform: translateX(-50%);
    width: 140px;
    height: 22px;
    pointer-events: none;
    z-index: 16;
    background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 140 22' fill='none'%3E%3Cdefs%3E%3ClinearGradient id='crestGold' x1='0%25' y1='0%25' x2='0%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%23fff4c2'/%3E%3Cstop offset='40%25' stop-color='%23d4af37'/%3E%3Cstop offset='80%25' stop-color='%237a5a18'/%3E%3Cstop offset='100%25' stop-color='%233d2a08'/%3E%3C/linearGradient%3E%3ClinearGradient id='crestHoriz' x1='0%25' y1='0%25' x2='100%25' y2='0%25'%3E%3Cstop offset='0%25' stop-color='%234e3810' stop-opacity='0'/%3E%3Cstop offset='20%25' stop-color='%23d4af37'/%3E%3Cstop offset='50%25' stop-color='%23fff8db'/%3E%3Cstop offset='80%25' stop-color='%23d4af37'/%3E%3Cstop offset='100%25' stop-color='%234e3810' stop-opacity='0'/%3E%3C/linearGradient%3E%3Cfilter id='anchorDrop' x='-10%25' y='-20%25' width='120%25' height='150%25'%3E%3CfeDropShadow dx='0' dy='2' stdDeviation='2' flood-color='%23000' flood-opacity='0.95'/%3E%3C/filter%3E%3C/defs%3E%3Cg filter='url(%23anchorDrop)'%3E%3Cpath d='M 0 2 L 140 2 L 135 4 L 5 4 Z' fill='url(%23crestHoriz)'/%3E%3Cpath d='M 15 2 C 35 2 48 8 58 14 C 62 16 66 18 70 21 C 68 17 65 14 62 11 C 52 5 36 2 15 2 Z' fill='url(%23crestGold)'/%3E%3Cpath d='M 30 3 C 42 4 52 7 60 12 C 54 8 44 4 30 3 Z' fill='%23fff8d6' opacity='0.7'/%3E%3Cpath d='M 125 2 C 105 2 92 8 82 14 C 78 16 74 18 70 21 C 72 17 75 14 78 11 C 88 5 104 2 125 2 Z' fill='url(%23crestGold)'/%3E%3Cpath d='M 110 3 C 98 4 88 7 80 12 C 86 8 96 4 110 3 Z' fill='%23fff8d6' opacity='0.7'/%3E%3Cpolygon points='70,22 79,12 70,5 61,12' fill='%2318130a' stroke='url(%23crestGold)' stroke-width='1.4'/%3E%3Cpolygon points='70,18 76,12 70,7 64,12' fill='url(%23crestGold)'/%3E%3Ccircle cx='70' cy='12' r='1.8' fill='%23fffbe8'/%3E%3C/g%3E%3C/svg%3E") center / contain no-repeat;
  }

  /* ── Golden Winged Crest Titlebar ───────────────────────────────────── */
  #${VT_ROOT_ID} .hbk-titlebar {
    height: 32px;
    padding: 0 8px 0 44px;
    background: linear-gradient(180deg, rgba(32, 28, 22, 0.95) 0%, rgba(14, 12, 10, 0.98) 100%);
    border-bottom: 1px solid #7d6328;
    box-shadow: inset 0 1px 0 rgba(255, 235, 170, 0.2), 0 2px 8px rgba(0, 0, 0, 0.6);
    position: relative;
    display: flex;
    align-items: center;
    border-image: none;
    gap: 3px;
  }

  #${VT_ROOT_ID} .rvt-title-crest {
    position: absolute;
    left: 6px;
    top: -4px;
    width: 44px;
    height: 40px;
    pointer-events: none;
    z-index: 20;
    background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 54 48' fill='none'%3E%3Cdefs%3E%3ClinearGradient id='crestGoldMetal' x1='0%25' y1='0%25' x2='0%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%23fff2be'/%3E%3Cstop offset='30%25' stop-color='%23f0cb64'/%3E%3Cstop offset='65%25' stop-color='%23b88928'/%3E%3Cstop offset='100%25' stop-color='%235a3e10'/%3E%3C/linearGradient%3E%3ClinearGradient id='shieldBg' x1='0%25' y1='0%25' x2='0%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%231f1b15'/%3E%3Cstop offset='50%25' stop-color='%2312100d'/%3E%3Cstop offset='100%25' stop-color='%23080706'/%3E%3C/linearGradient%3E%3ClinearGradient id='vtGold' x1='0%25' y1='0%25' x2='0%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%23ffffff'/%3E%3Cstop offset='35%25' stop-color='%23fae5a8'/%3E%3Cstop offset='70%25' stop-color='%23d4af37'/%3E%3Cstop offset='100%25' stop-color='%237a5514'/%3E%3C/linearGradient%3E%3Cfilter id='crestShadow' x='-20%25' y='-20%25' width='140%25' height='140%25'%3E%3CfeDropShadow dx='0' dy='2' stdDeviation='2' flood-color='%23000' flood-opacity='0.95'/%3E%3C/filter%3E%3C/defs%3E%3Cg filter='url(%23crestShadow)'%3E%3Cg fill='url(%23crestGoldMetal)'%3E%3Cpath d='M 18 12 C 12 7 4 10 1 16 C 4 17 10 16 16 17 Z'/%3E%3Cpath d='M 17 18 C 9 16 3 22 2 28 C 6 28 11 26 16 24 Z'/%3E%3Cpath d='M 17 25 C 10 26 5 32 6 38 C 9 37 13 34 18 31 Z'/%3E%3Cpath d='M 18 32 C 14 36 12 42 16 45 C 18 42 19 37 20 34 Z'/%3E%3C/g%3E%3Cg fill='url(%23crestGoldMetal)' transform='translate(54,0) scale(-1,1)'%3E%3Cpath d='M 18 12 C 12 7 4 10 1 16 C 4 17 10 16 16 17 Z'/%3E%3Cpath d='M 17 18 C 9 16 3 22 2 28 C 6 28 11 26 16 24 Z'/%3E%3Cpath d='M 17 25 C 10 26 5 32 6 38 C 9 37 13 34 18 31 Z'/%3E%3Cpath d='M 18 32 C 14 36 12 42 16 45 C 18 42 19 37 20 34 Z'/%3E%3C/g%3E%3Cpath d='M 27 6 C 37 6 42 10 42 22 C 42 33 32 42 27 46 C 22 42 12 33 12 22 C 12 10 17 6 27 6 Z' fill='%233a280c' stroke='url(%23crestGoldMetal)' stroke-width='2'/%3E%3Cpath d='M 27 8.5 C 35.5 8.5 39.5 12 39.5 22 C 39.5 31.5 30.5 39.5 27 43 C 23.5 39.5 14.5 31.5 14.5 22 C 14.5 12 18.5 8.5 27 8.5 Z' fill='url(%23shieldBg)'/%3E%3Cpath d='M 27 10.5 C 34 10.5 37.5 13.5 37.5 22 C 37.5 30 29.5 37.5 27 40.5 C 24.5 37.5 16.5 30 16.5 22 C 16.5 13.5 20 10.5 27 10.5 Z' fill='none' stroke='url(%23crestGoldMetal)' stroke-width='0.75' opacity='0.8'/%3E%3Cpath d='M 20.5 17 L 24 17 L 27 28.5 L 30 17 L 33.5 17 L 28.5 33 L 25.5 33 Z' fill='url(%23vtGold)' filter='drop-shadow(0 1px 1px %23000)'/%3E%3Cpath d='M 21.5 18 L 32.5 18 L 32.5 20.2 L 28.4 20.2 L 28.4 30.5 L 25.6 30.5 L 25.6 20.2 L 21.5 20.2 Z' fill='url(%23vtGold)' opacity='0.95' filter='drop-shadow(0 1px 1px %23000)'/%3E%3Cpath d='M 27 2 L 29.5 6 L 27 5 L 24.5 6 Z' fill='url(%23crestGoldMetal)'/%3E%3Ccircle cx='27' cy='2' r='1.2' fill='%23fff9dc'/%3E%3C/g%3E%3C/svg%3E") center / contain no-repeat;
    filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.85));
  }

  #${VT_ROOT_ID} .hbk-titlebar > .hbk-title {
    flex: 1 1 auto;
    min-width: 0;
    text-align: center;
    font-family: var(--hb-font-serif, "Cinzel", "Times New Roman", Garamond, Georgia, serif);
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: #fae5a8;
    text-shadow:
      0 0 10px rgba(243, 210, 122, 0.65),
      0 0 20px rgba(212, 175, 55, 0.35),
      0 1px 2px rgba(0, 0, 0, 0.95);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
  }

  #${VT_ROOT_ID} .hbk-titlebar > .hbk-title::before,
  #${VT_ROOT_ID} .hbk-titlebar > .hbk-title::after {
    content: "";
    display: inline-block;
    width: 38px;
    height: 10px;
    flex: 0 0 38px;
    background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 38 10' fill='none'%3E%3Cpath d='M0 5 C10 5 18 1 26 4 C30 5.5 35 5 38 5 C35 5 30 4.5 26 6 C18 9 10 5 0 5 Z' fill='url(%23g)'/%3E%3Ccircle cx='38' cy='5' r='1.5' fill='%23fae5a8'/%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0%25' y1='0%25' x2='100%25' y2='0%25'%3E%3Cstop offset='0%25' stop-color='%23d4af37' stop-opacity='0'/%3E%3Cstop offset='50%25' stop-color='%23d4af37'/%3E%3Cstop offset='100%25' stop-color='%23fae5a8'/%3E%3C/linearGradient%3E%3C/defs%3E%3C/svg%3E") center / contain no-repeat;
    opacity: 0.85;
  }
  #${VT_ROOT_ID} .hbk-titlebar > .hbk-title::after { transform: scaleX(-1); }

  #${VT_ROOT_ID} .rvt-hdr-btn,
  #${VT_ROOT_ID} .hbk-close {
    height: 20px;
    min-width: 22px;
    padding: 0 6px;
    margin: 0 2px;
    border-radius: 3px;
    border: 1px solid #7d6328;
    background: linear-gradient(180deg, #26221d 0%, #171512 50%, #0d0c0a 100%);
    box-shadow:
      inset 0 1px 0 rgba(255, 235, 170, 0.18),
      0 1px 3px rgba(0, 0, 0, 0.7);
    color: #d9b45a;
    font: 11px/20px var(--hbk-font);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: all 120ms ease-out;
  }
  #${VT_ROOT_ID} .rvt-hdr-btn:hover,
  #${VT_ROOT_ID} .hbk-close:hover {
    color: #fff2c4;
    border-color: #d4af37;
    background: linear-gradient(180deg, #363028 0%, #221e19 50%, #151310 100%);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.3),
      0 0 8px rgba(243, 210, 122, 0.35);
  }
  #${VT_ROOT_ID} .rvt-hdr-btn:active,
  #${VT_ROOT_ID} .hbk-close:active {
    background: linear-gradient(180deg, #100e0c 0%, #1a1815 100%);
    box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.9);
    transform: translateY(1px);
  }
  #${VT_ROOT_ID} .hbk-close {
    position: static;
    width: 22px;
    height: 20px;
  }
  #${VT_ROOT_ID} .hbk-close::after {
    content: "✕";
    font-size: 11px;
    line-height: 20px;
    color: #d9b45a;
  }
  #${VT_ROOT_ID} .hbk-close:hover {
    border-color: #c04030;
    box-shadow: 0 0 8px rgba(255, 100, 80, 0.4);
  }
  #${VT_ROOT_ID} .hbk-close:hover::after { color: #ff8a7a; }
  #${VT_ROOT_ID} .rvt-hdr-btn:first-of-type::before {
    content: "🔒 ";
    font-size: 10px;
    margin-right: 2px;
    filter: drop-shadow(0 0 2px rgba(243, 210, 122, 0.4));
  }

  /* ── Command Bar: RUN Button, Switches, Profile Capsule ─────────────── */
  #${VT_ROOT_ID} .rvt-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 6px;
    padding: 5px 8px;
    background: rgba(0, 0, 0, 0.42);
    border-bottom: 1px solid #7c6230;
  }
  #${VT_ROOT_ID} .rvt-run {
    flex: 0 0 auto;
    min-width: 92px;
    height: 22px;
    padding: 0 10px 0 8px;
    font-family: var(--hbk-font);
    font-size: 11px;
    font-weight: 700;
    line-height: 20px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    border-radius: 4px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    transition: all 120ms ease;
    position: relative;
  }
  #${VT_ROOT_ID} .rvt-run::before {
    content: "▶";
    font-size: 10px;
    line-height: 1;
    display: inline-block;
    transform: scaleY(0.95);
    transition: all 120ms ease;
  }
  #${VT_ROOT_ID} .rvt-run[data-state="running"] {
    border: 1px solid #2ae66e;
    background: linear-gradient(180deg, #26b956 0%, #168a3b 22%, #0e6128 48%, #08431b 52%, #053314 100%);
    box-shadow:
      inset 0 1px 1px rgba(255, 255, 255, 0.75),
      inset 0 2px 4px rgba(72, 255, 138, 0.4),
      inset 0 -1px 2px rgba(0, 0, 0, 0.6),
      0 0 10px rgba(38, 185, 86, 0.65),
      0 0 20px rgba(16, 185, 129, 0.35);
    color: #f0fff4;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8), 0 0 6px rgba(72, 255, 138, 0.75);
  }
  #${VT_ROOT_ID} .rvt-run[data-state="running"]::before {
    color: #48ff8a;
    text-shadow: 0 0 6px #2ecc71, 0 0 12px #10b981;
  }
  #${VT_ROOT_ID} .rvt-run[data-state="running"]:hover {
    filter: brightness(1.15);
    box-shadow:
      inset 0 1px 1px rgba(255, 255, 255, 0.85),
      inset 0 2px 5px rgba(72, 255, 138, 0.5),
      0 0 14px rgba(38, 185, 86, 0.85),
      0 0 24px rgba(16, 185, 129, 0.45);
  }
  #${VT_ROOT_ID} .rvt-run[data-state="stopped"] {
    border: 1px solid #e63946;
    background: linear-gradient(180deg, #b92626 0%, #8a1616 22%, #610e0e 48%, #430808 52%, #330505 100%);
    box-shadow:
      inset 0 1px 1px rgba(255, 255, 255, 0.65),
      inset 0 2px 4px rgba(255, 100, 100, 0.3),
      inset 0 -1px 2px rgba(0, 0, 0, 0.6),
      0 0 10px rgba(230, 57, 70, 0.65),
      0 0 20px rgba(230, 57, 70, 0.35);
    color: #fff5f5;
    text-shadow: 0 1px 2px #000, 0 0 6px rgba(255, 100, 100, 0.7);
  }
  #${VT_ROOT_ID} .rvt-run[data-state="stopped"]::before {
    content: "❚❚";
    font-size: 8px;
    letter-spacing: -1px;
    color: #ff8585;
    text-shadow: 0 0 6px #ff4d4d;
  }
  #${VT_ROOT_ID} .rvt-run[data-state="off"] {
    border: 1px solid #7c6230;
    background: linear-gradient(180deg, #3d3220 0%, #292114 48%, #1a150c 52%, #120e08 100%);
    box-shadow:
      inset 0 1px 1px rgba(255, 255, 255, 0.2),
      inset 0 -1px 2px rgba(0, 0, 0, 0.6),
      0 1px 3px rgba(0, 0, 0, 0.5);
    color: #d4af37;
    text-shadow: 0 1px 2px #000;
  }
  #${VT_ROOT_ID} .rvt-run[data-state="off"]::before {
    color: #d4af37;
    text-shadow: 0 0 4px #8a7544;
  }
  #${VT_ROOT_ID} .rvt-run:active { transform: translateY(1px); }
  #${VT_ROOT_ID} .rvt-run:disabled { filter: grayscale(0.8) brightness(0.5); cursor: default; }

  #${VT_ROOT_ID} .rvt-switches { display: flex; gap: 3px; flex: 0 0 auto; }
  #${VT_ROOT_ID} .rvt-tgl {
    height: 22px;
    min-width: 0;
    padding: 0 8px;
    font-family: var(--hbk-font);
    font-size: 10px;
    font-weight: 700;
    line-height: 20px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    border-radius: 3px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: all 120ms ease;
    position: relative;
    border: 1px solid #5a4522;
    background: linear-gradient(180deg, #2b2216 0%, #1e170e 45%, #130f08 100%);
    box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.1), inset 0 -1px 2px rgba(0, 0, 0, 0.6);
    color: #8c7b60;
    text-shadow: 0 1px 1px #000;
  }
  #${VT_ROOT_ID} .rvt-tgl::before {
    font-size: 11px;
    line-height: 1;
    margin-right: 4px;
    display: inline-block;
    vertical-align: -1px;
    color: #8c7b60;
    transition: all 120ms ease;
  }
  #${VT_ROOT_ID} .rvt-tgl[data-switch="combat"]::before { content: "⚔"; }
  #${VT_ROOT_ID} .rvt-tgl[data-switch="buff"]::before   { content: "✨"; }
  #${VT_ROOT_ID} .rvt-tgl[data-switch="nav"]::before    { content: "↗"; }
  #${VT_ROOT_ID} .rvt-tgl[data-switch="loot"]::before   { content: "📦"; }
  #${VT_ROOT_ID} .rvt-tgl[data-switch="meta"]::before   { content: "🗂"; }

  #${VT_ROOT_ID} .rvt-tgl:hover {
    border-color: #8c6e32;
    color: #c4b89e;
    filter: brightness(1.15);
  }
  #${VT_ROOT_ID} .rvt-tgl.is-on {
    border: 1px solid #d4af37;
    background: linear-gradient(180deg, #f5e4a8 0%, #f0c66e 6%, #dba240 25%, #d49d41 50%, #c58f37 75%, #af7828 100%);
    box-shadow:
      inset 0 1px 1px rgba(255, 255, 255, 0.75),
      inset 0 -1px 2px rgba(0, 0, 0, 0.5),
      0 0 8px rgba(212, 175, 55, 0.55),
      0 0 16px rgba(212, 175, 55, 0.25);
    color: #1a1105;
    text-shadow: 0 1px 0 rgba(255, 245, 210, 0.45);
  }
  #${VT_ROOT_ID} .rvt-tgl.is-on::before {
    color: #1a1105;
    text-shadow: 0 1px 0 rgba(255, 245, 210, 0.45);
  }
  #${VT_ROOT_ID} .rvt-tgl.is-on:hover {
    filter: brightness(1.1);
    box-shadow:
      inset 0 1px 1px rgba(255, 255, 255, 0.85),
      inset 0 -1px 2px rgba(0, 0, 0, 0.5),
      0 0 12px rgba(212, 175, 55, 0.75),
      0 0 20px rgba(212, 175, 55, 0.35);
  }
  #${VT_ROOT_ID} .rvt-tgl.is-paused {
    outline: 1px dashed #ffd700;
    outline-offset: -2px;
    box-shadow: 0 0 8px rgba(255, 215, 0, 0.5);
  }
  #${VT_ROOT_ID} .rvt-tgl:active { transform: translateY(1px); }
  #${VT_ROOT_ID} .rvt-tgl:disabled { filter: grayscale(0.8) brightness(0.5); cursor: default; }

  #${VT_ROOT_ID} .rvt-prof {
    flex: 1 1 170px;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
  }
  #${VT_ROOT_ID} .rvt-prof select.hbk-select.rvt-profile-select {
    min-width: 0;
    max-width: 170px;
    flex: 0 1 auto;
    height: 22px;
    min-height: 22px;
    font-family: var(--hbk-font);
    font-size: 11px;
    font-weight: 600;
    color: #ffffff;
    border-radius: 4px;
    border: 1px solid #7c6230;
    background-color: #0c0a07;
    background-image:
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23d4af37' stroke-width='1.5'%3E%3Ccircle cx='8' cy='8' r='5'/%3E%3Ccircle cx='8' cy='8' r='1.5' fill='%23d4af37'/%3E%3Cline x1='8' y1='1' x2='8' y2='4'/%3E%3Cline x1='8' y1='12' x2='8' y2='15'/%3E%3Cline x1='1' y1='8' x2='4' y2='8'/%3E%3Cline x1='12' y1='8' x2='15' y2='8'/%3E%3C/svg%3E"),
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6' fill='none' stroke='%23d4af37' stroke-width='1.5'%3E%3Cpath d='M1 1l4 4 4-4'/%3E%3C/svg%3E");
    background-repeat: no-repeat, no-repeat;
    background-position: left 6px center, right 8px center;
    background-size: 12px 12px, 8px 5px;
    padding: 0 20px 0 22px;
    box-shadow:
      inset 0 2px 4px rgba(0, 0, 0, 0.8),
      0 1px 0 rgba(255, 215, 0, 0.15);
    appearance: none;
    -webkit-appearance: none;
    -moz-appearance: none;
    cursor: pointer;
    transition: all 120ms ease;
  }
  #${VT_ROOT_ID} .rvt-prof select.hbk-select.rvt-profile-select:hover {
    border-color: #c99a45;
    box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.8), 0 0 6px rgba(212, 175, 55, 0.35);
  }
  #${VT_ROOT_ID} .rvt-prof select.hbk-select.rvt-profile-select:focus {
    outline: none;
    border-color: #ffd700;
    box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.8), 0 0 8px rgba(255, 215, 0, 0.5);
  }
  #${VT_ROOT_ID} .rvt-ro {
    flex: 0 0 auto;
    padding: 0 5px;
    height: 18px;
    border: 1px solid #c99a45;
    border-radius: 3px;
    color: #ffe082;
    background: rgba(180, 110, 0, 0.35);
    box-shadow: 0 0 4px rgba(255, 179, 0, 0.35);
    font: 10px/16px var(--hbk-font);
    cursor: pointer;
    white-space: nowrap;
  }
  #${VT_ROOT_ID} .rvt-ro:hover {
    filter: brightness(1.25);
    border-color: #ffd700;
  }
  #${VT_ROOT_ID} .rvt-more {
    min-width: 22px;
    height: 22px;
    padding: 0 4px;
    border: 1px solid #7c6230;
    border-radius: 4px;
    background: linear-gradient(180deg, #221a10 0%, #120e09 100%);
    color: #d4af37;
    font: 12px/20px var(--hbk-font);
    cursor: pointer;
    box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.1), 0 1px 2px rgba(0, 0, 0, 0.5);
    transition: all 120ms ease;
  }
  #${VT_ROOT_ID} .rvt-more.is-active,
  #${VT_ROOT_ID} .rvt-more:hover {
    color: #ffffff;
    border-color: #ffd700;
    box-shadow: 0 0 6px rgba(212, 175, 55, 0.5);
  }
  #${VT_ROOT_ID} .rvt-drawer { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; padding: 4px 6px; background: rgba(0, 0, 0, 0.3); border-bottom: 1px solid var(--hbk-gold-deep, #4e3f1f); }
  #${VT_ROOT_ID} .rvt-sep { width: 1px; align-self: stretch; min-height: 14px; background: var(--hbk-gold-deep, #4e3f1f); }

  /* ── Tabs, Content, Footer ─────────────────────────────────────────── */
  #${VT_ROOT_ID} .rvt-tabs {
    min-height: 26px;
    display: flex;
    gap: 2px;
    padding: 4px 6px 0;
    background: rgba(0, 0, 0, 0.45);
    border-bottom: 1px solid #7c6230;
    box-sizing: border-box;
  }
  #${VT_ROOT_ID} .rvt-tabs .hbk-tab {
    flex: 1 1 auto;
    height: 24px;
    padding: 0 5px;
    font-family: var(--hbk-font);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    border-radius: 4px 4px 0 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 120ms ease;
    position: relative;
    border: 1px solid rgba(140, 110, 50, 0.45);
    border-bottom: 0;
    background: linear-gradient(180deg, #1b1610 0%, #110e0a 60%, #0a0806 100%);
    color: #c4b89e;
    text-shadow: 0 1px 2px #000;
  }
  #${VT_ROOT_ID} .rvt-tabs .hbk-tab::before {
    font-size: 11px;
    line-height: 1;
    margin-right: 4px;
    display: inline-block;
    vertical-align: -1px;
    color: #c9a96e;
    transition: color 120ms ease;
  }
  #${VT_ROOT_ID} .rvt-tabs .hbk-tab[data-tab="main"]::before     { content: ""; }
  #${VT_ROOT_ID} .rvt-tabs .hbk-tab[data-tab="monsters"]::before { content: "💀"; }
  #${VT_ROOT_ID} .rvt-tabs .hbk-tab[data-tab="items"]::before    { content: "🎒"; }
  #${VT_ROOT_ID} .rvt-tabs .hbk-tab[data-tab="buffs"]::before    { content: "🔥"; }
  #${VT_ROOT_ID} .rvt-tabs .hbk-tab[data-tab="route"]::before    { content: "⚬—⚬"; font-size: 9px; }
  #${VT_ROOT_ID} .rvt-tabs .hbk-tab[data-tab="loot"]::before     { content: "📦"; }
  #${VT_ROOT_ID} .rvt-tabs .hbk-tab[data-tab="meta"]::before     { content: "🗂"; }
  #${VT_ROOT_ID} .rvt-tabs .hbk-tab[data-tab="advanced"]::before { content: "⚙"; }

  #${VT_ROOT_ID} .rvt-tabs .hbk-tab:not(.is-active):hover {
    background: linear-gradient(180deg, #2c2317 0%, #1a140d 60%, #100c07 100%);
    border-color: #c99a45;
    color: #fff0be;
    box-shadow: 0 0 6px rgba(212, 175, 55, 0.35);
  }
  #${VT_ROOT_ID} .rvt-tabs .hbk-tab:not(.is-active):hover::before { color: #ffd700; }

  #${VT_ROOT_ID} .rvt-tabs .hbk-tab.is-active,
  #${VT_ROOT_ID} .rvt-tabs .hbk-tab[aria-selected="true"] {
    border-top: 2px solid #ffe285;
    border-left: 1px solid #c99a45;
    border-right: 1px solid #c99a45;
    border-bottom: 1px solid #100b04;
    background: linear-gradient(180deg, #433116 0%, #291d0c 35%, #181106 70%, #100b04 100%);
    box-shadow:
      0 -3px 10px rgba(255, 215, 0, 0.75),
      0 -1px 3px rgba(255, 255, 255, 0.8),
      inset 0 1px 1px rgba(255, 255, 255, 0.5);
    color: #fff6db;
    font-weight: 700;
    text-shadow:
      0 0 8px rgba(255, 215, 0, 0.8),
      0 0 16px rgba(212, 175, 55, 0.5),
      0 1px 2px #000;
    z-index: 2;
    margin-bottom: -1px;
  }
  #${VT_ROOT_ID} .rvt-tabs .hbk-tab.is-active::before,
  #${VT_ROOT_ID} .rvt-tabs .hbk-tab[aria-selected="true"]::before {
    color: #ffd700;
    text-shadow: 0 0 6px rgba(255, 215, 0, 0.8);
  }

  #${VT_ROOT_ID} .rvt-content { padding: 6px 8px; max-height: 436px; min-height: 200px; }

  /* ── Status Bar Footer ─────────────────────────────────────────────── */
  #${VT_ROOT_ID} .rvt-foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0 8px;
    min-height: 22px;
    padding: 4px 12px 6px;
    font-size: 11px;
    background: linear-gradient(180deg, rgba(16, 14, 12, 0.95) 0%, rgba(8, 7, 6, 0.98) 100%);
    border-top: 1px solid #6e5828;
    box-shadow: inset 0 1px 0 rgba(243, 210, 122, 0.15), 0 -2px 6px rgba(0, 0, 0, 0.5);
    position: relative;
  }
  #${VT_ROOT_ID} .rvt-status {
    flex: 1 1 200px;
    min-width: 0;
    color: #d4ccba;
    font-family: var(--hbk-font);
    font-size: 10.5px;
    line-height: 16px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-shadow: 0 1px 2px #000;
    display: flex;
    align-items: center;
  }
  #${VT_ROOT_ID} .rvt-status::before {
    content: "";
    display: inline-block;
    width: 14px;
    height: 14px;
    flex: 0 0 14px;
    margin-right: 6px;
    vertical-align: middle;
    background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='7' fill='%2312100d' stroke='%23d4af37' stroke-width='1.2'/%3E%3Ccircle cx='8' cy='5' r='1.1' fill='%23f3d27a'/%3E%3Cpath d='M7.2 7.2 h1.6 v4.2 h-1.6 z' fill='%23f3d27a'/%3E%3C/svg%3E") center / contain no-repeat;
    filter: drop-shadow(0 0 3px rgba(243, 210, 122, 0.45));
  }
  #${VT_ROOT_ID} .rvt-msg {
    flex: 0 1 auto;
    max-width: 100%;
    color: var(--hbk-gold-bright, #f3d27a);
    font-size: 10.5px;
    overflow-wrap: anywhere;
    text-shadow: 0 0 6px rgba(243, 210, 122, 0.5);
  }
  #${VT_ROOT_ID} .rvt-msg[data-kind="error"] {
    flex-basis: 100%;
    color: var(--hbk-warn, #ff6a50);
    text-shadow: 0 0 6px rgba(255, 106, 80, 0.5);
  }

  /* ── Shared Building Blocks ────────────────────────────────────────── */
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

  /* ── Inset Numeric Stepper Inputs ──────────────────────────────────── */
  #${VT_ROOT_ID} .rvt-num-box {
    position: relative;
    display: inline-flex;
    align-items: center;
    background: #0d0c0a;
    border: 1px solid #7c6332;
    border-radius: 3px;
    box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.85);
    padding-right: 14px;
  }
  #${VT_ROOT_ID} .rvt-num-box:hover {
    border-color: #d4af37;
    box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.85), 0 0 5px rgba(212, 175, 55, 0.4);
  }
  #${VT_ROOT_ID} .rvt-num-box input.hbk-input {
    border: none !important;
    background: transparent !important;
    box-shadow: none !important;
    color: #ffffff;
    font-weight: 600;
    font-size: 11px;
    height: 18px;
    line-height: 18px;
    padding: 0 2px 0 4px;
    text-align: right;
    font-variant-numeric: tabular-nums;
    -moz-appearance: textfield;
  }
  #${VT_ROOT_ID} .rvt-num-box input.hbk-input::-webkit-inner-spin-button,
  #${VT_ROOT_ID} .rvt-num-box input.hbk-input::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  #${VT_ROOT_ID} .rvt-steppers {
    position: absolute;
    right: 1px;
    top: 1px;
    bottom: 1px;
    width: 12px;
    display: flex;
    flex-direction: column;
    border-left: 1px solid rgba(124, 99, 50, 0.45);
  }
  #${VT_ROOT_ID} .rvt-step-btn {
    flex: 1 1 50%;
    padding: 0;
    margin: 0;
    border: none;
    background: rgba(30, 24, 16, 0.6);
    color: #c8a248;
    font-size: 7px;
    line-height: 8px;
    text-align: center;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  #${VT_ROOT_ID} .rvt-step-btn:hover {
    color: #fff2c8;
    background: rgba(80, 60, 25, 0.85);
  }
  #${VT_ROOT_ID} .rvt-step-btn.is-up {
    border-bottom: 1px solid rgba(124, 99, 50, 0.4);
  }

  /* ── High-End Sliding Pill Switches ────────────────────────────────── */
  #${VT_ROOT_ID} input.hbk-check,
  #${VT_ROOT_ID} .rvt-switch {
    -webkit-appearance: none;
    appearance: none;
    width: 30px;
    height: 16px;
    border-radius: 999px;
    background: linear-gradient(180deg, #100e0b 0%, #1c1813 100%);
    border: 1px solid #5a451e;
    box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.9), 0 1px 2px rgba(0, 0, 0, 0.6);
    position: relative;
    cursor: pointer;
    vertical-align: middle;
    outline: none;
    margin: 0 6px 0 0;
    flex-shrink: 0;
    transition: background 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease;
  }
  #${VT_ROOT_ID} input.hbk-check::after,
  #${VT_ROOT_ID} .rvt-switch::after {
    content: "";
    position: absolute;
    top: 1px;
    left: 1px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: radial-gradient(circle at 35% 35%, #9d9282 0%, #544b3c 60%, #302a20 100%);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.9), inset 0 1px 1px rgba(255, 255, 255, 0.4);
    transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1), background 0.25s ease, box-shadow 0.25s ease;
  }
  #${VT_ROOT_ID} input.hbk-check:hover,
  #${VT_ROOT_ID} .rvt-switch:hover {
    border-color: #8c6e33;
  }
  #${VT_ROOT_ID} input.hbk-check:checked,
  #${VT_ROOT_ID} .rvt-switch:checked {
    background: linear-gradient(180deg, #2ecc71 0%, #15803d 100%);
    border-color: #4ade80;
    box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.5), 0 0 10px rgba(46, 204, 113, 0.65);
  }
  #${VT_ROOT_ID} input.hbk-check:checked::after,
  #${VT_ROOT_ID} .rvt-switch:checked::after {
    transform: translateX(14px);
    background: radial-gradient(circle at 35% 35%, #ffffff 0%, #dcfce7 60%, #86efac 100%);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5), 0 0 6px rgba(255, 255, 255, 0.9);
  }
  #${VT_ROOT_ID} input.hbk-check:disabled,
  #${VT_ROOT_ID} .rvt-switch:disabled {
    opacity: 0.4;
    cursor: default;
    filter: grayscale(0.8);
  }

  /* ── Double-Lined Gold Cards & Glowing Headers ─────────────────────── */
  #${VT_ROOT_ID} .rvt-card {
    position: relative;
    min-width: 0;
    border: 1px solid #8e7033;
    box-shadow:
      inset 0 0 0 2px #0f0d0a,
      inset 0 0 0 3px #443419,
      0 4px 14px rgba(0, 0, 0, 0.7);
    background: linear-gradient(180deg, rgba(22, 18, 14, 0.92) 0%, rgba(12, 10, 8, 0.96) 100%);
    padding: 6px 10px 8px;
    border-radius: 4px;
  }
  #${VT_ROOT_ID} .rvt-card::before,
  #${VT_ROOT_ID} .rvt-card::after {
    content: "";
    position: absolute;
    width: 8px;
    height: 8px;
    pointer-events: none;
  }
  #${VT_ROOT_ID} .rvt-card::before {
    top: 2px;
    left: 2px;
    border-top: 1px solid #d4af37;
    border-left: 1px solid #d4af37;
  }
  #${VT_ROOT_ID} .rvt-card::after {
    bottom: 2px;
    right: 2px;
    border-bottom: 1px solid #d4af37;
    border-right: 1px solid #d4af37;
  }

  #${VT_ROOT_ID} .rvt-card-title {
    display: flex;
    align-items: center;
    margin: -2px -6px 6px;
    padding: 2px 8px 4px;
    color: #f7d584;
    font: bold 11px/16px "Cinzel", "Times New Roman", Georgia, serif;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    text-shadow: 0 0 10px rgba(247, 213, 132, 0.5), 0 1px 2px #000;
    border-bottom: 1px solid #5a451e;
    position: relative;
  }
  #${VT_ROOT_ID} .rvt-vitals .rvt-card-title::before { content: "⚡ "; color: #f7d584; }
  #${VT_ROOT_ID} .rvt-card-ranges .rvt-card-title::before { content: "🎯 "; color: #f7d584; }
  #${VT_ROOT_ID} .rvt-card-pets .rvt-card-title::before { content: "🐾 "; color: #f7d584; }
  #${VT_ROOT_ID} .rvt-card-beh .rvt-card-title::before { content: "⚙ "; color: #f7d584; }

  #${VT_ROOT_ID} .rvt-card-title::after {
    content: "";
    position: absolute;
    right: 6px;
    top: 3px;
    width: 68px;
    height: 14px;
    background-repeat: no-repeat;
    background-position: right center;
    background-size: contain;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 16' fill='none'%3E%3Cpath d='M75 8c-8-4-16 2-24-1s-14-6-24-3-16 4-27 4' stroke='%23d4af37' stroke-width='1.2' stroke-linecap='round'/%3E%3Cpath d='M78 8c-5-2-12 1-18-1s-10-5-18-2-12 3-20 3' stroke='%23f7d584' stroke-width='0.8' stroke-linecap='round' opacity='0.7'/%3E%3C/svg%3E");
    pointer-events: none;
  }

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

  /* ── Option Editors (Main, Advanced, Buffs/Loot Knobs) ─────────────── */
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

  /* ── Main Tab Layout & Vitals Gauges ───────────────────────────────── */
  #${VT_ROOT_ID} .rvt-main { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 8px; }
  #${VT_ROOT_ID} .rvt-main .rvt-span2 { grid-column: 1 / -1; }
  #${VT_ROOT_ID} .rvt-vit {
    display: grid;
    grid-template-columns: 78px repeat(3, 1fr);
    gap: 6px 10px;
    align-items: center;
  }
  #${VT_ROOT_ID} .rvt-vit-h {
    text-align: center;
    font: bold 11px/16px "Cinzel", "Times New Roman", Georgia, serif;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  #${VT_ROOT_ID} .rvt-vit-h.is-hp { color: #ff6b6b; text-shadow: 0 0 8px rgba(255, 107, 107, 0.5); }
  #${VT_ROOT_ID} .rvt-vit-h.is-st { color: #ffd152; text-shadow: 0 0 8px rgba(255, 209, 82, 0.5); }
  #${VT_ROOT_ID} .rvt-vit-h.is-mn { color: #5ce1e6; text-shadow: 0 0 8px rgba(92, 225, 230, 0.5); }
  #${VT_ROOT_ID} .rvt-vit-h.is-hp::before { content: "❤️ "; font-size: 11px; }
  #${VT_ROOT_ID} .rvt-vit-h.is-st::before { content: "⚡ "; font-size: 11px; }
  #${VT_ROOT_ID} .rvt-vit-h.is-mn::before { content: "💧 "; font-size: 11px; }

  #${VT_ROOT_ID} .rvt-vit-cell { display: flex; justify-content: center; }

  #${VT_ROOT_ID} .rvt-vbar {
    position: relative;
    height: 20px;
    border-radius: 11px;
    background: #080706;
    border: 1px solid rgba(160, 130, 65, 0.55);
    box-shadow:
      inset 0 2px 5px rgba(0, 0, 0, 0.95),
      inset 0 0 0 1px rgba(0, 0, 0, 0.8),
      0 1px 4px rgba(0, 0, 0, 0.6);
    overflow: visible;
  }
  #${VT_ROOT_ID} .rvt-vbar::after {
    content: "";
    position: absolute;
    left: 2px;
    right: 2px;
    top: 1px;
    height: 48%;
    border-radius: 9px 9px 4px 4px;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.5) 0%, rgba(255, 255, 255, 0.12) 60%, rgba(255, 255, 255, 0) 100%);
    pointer-events: none;
    z-index: 2;
  }
  #${VT_ROOT_ID} .rvt-vbar-fill {
    position: absolute;
    left: 1px;
    top: 1px;
    bottom: 1px;
    width: 0;
    border-radius: 9px;
    transition: width 0.35s cubic-bezier(0.2, 0.8, 0.3, 1);
  }
  #${VT_ROOT_ID} .rvt-vbar.is-hp .rvt-vbar-fill {
    background: linear-gradient(180deg, #ff5c5c 0%, #ee1b1b 35%, #ad0000 70%, #680000 100%);
    box-shadow: 0 0 10px rgba(238, 27, 27, 0.65), inset 0 1px 1px rgba(255, 255, 255, 0.4);
  }
  #${VT_ROOT_ID} .rvt-vbar.is-st .rvt-vbar-fill {
    background: linear-gradient(180deg, #ffe066 0%, #f5a623 35%, #b86e00 70%, #703c00 100%);
    box-shadow: 0 0 10px rgba(245, 166, 35, 0.65), inset 0 1px 1px rgba(255, 255, 255, 0.4);
  }
  #${VT_ROOT_ID} .rvt-vbar.is-mn .rvt-vbar-fill {
    background: linear-gradient(180deg, #66d9ff 0%, #0099ff 35%, #0044cc 70%, #002277 100%);
    box-shadow: 0 0 10px rgba(0, 153, 255, 0.65), inset 0 1px 1px rgba(255, 255, 255, 0.4);
  }
  #${VT_ROOT_ID} .rvt-vbar-text {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font: bold 11px/20px var(--hbk-font);
    color: #ffffff;
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9), 0 0 5px #000;
    letter-spacing: 0.05em;
    font-variant-numeric: tabular-nums;
    z-index: 3;
  }
  #${VT_ROOT_ID} .rvt-vmark {
    position: absolute;
    top: -3px;
    bottom: -3px;
    width: 2px;
    margin-left: -1px;
    z-index: 4;
    pointer-events: none;
  }
  #${VT_ROOT_ID} .rvt-vmark.is-idle {
    background: #ffd700;
    box-shadow: 0 0 6px rgba(255, 215, 0, 0.85), 0 0 2px #000;
  }
  #${VT_ROOT_ID} .rvt-vmark.is-idle::before,
  #${VT_ROOT_ID} .rvt-vmark.is-idle::after {
    content: "";
    position: absolute;
    left: -2px;
    width: 6px;
    height: 2px;
    background: #ffd700;
    box-shadow: 0 0 4px rgba(255, 215, 0, 0.9);
  }
  #${VT_ROOT_ID} .rvt-vmark.is-idle::before { top: 0; }
  #${VT_ROOT_ID} .rvt-vmark.is-idle::after { bottom: 0; }

  #${VT_ROOT_ID} .rvt-vmark.is-combat {
    background: #ffffff;
    box-shadow: 0 0 6px rgba(255, 255, 255, 0.9), 0 0 2px #000;
  }
  #${VT_ROOT_ID} .rvt-vmark.is-combat::before,
  #${VT_ROOT_ID} .rvt-vmark.is-combat::after {
    content: "";
    position: absolute;
    left: -2px;
    width: 6px;
    height: 2px;
    background: #ffffff;
    box-shadow: 0 0 4px rgba(255, 255, 255, 0.9);
  }
  #${VT_ROOT_ID} .rvt-vmark.is-combat::before { top: 0; }
  #${VT_ROOT_ID} .rvt-vmark.is-combat::after { bottom: 0; }

  #${VT_ROOT_ID} .rvt-vit-legend { grid-column: 1 / -1; display: flex; gap: 10px; color: var(--hbk-text-faint, #77705f); font-size: 10px; }
  #${VT_ROOT_ID} .rvt-key { display: inline-block; width: 8px; height: 8px; margin-right: 3px; vertical-align: -1px; }
  #${VT_ROOT_ID} .rvt-key.is-idle { background: #ffd700; }
  #${VT_ROOT_ID} .rvt-key.is-combat { background: #ffffff; }
  #${VT_ROOT_ID} .rvt-rule-line { display: flex; align-items: center; flex-wrap: wrap; gap: 3px; margin-top: 3px; color: var(--hbk-text, #e8dfc8); }

  /* ── Ranges 2-Column Wrap & Radar Display ─────────────────────────── */
  #${VT_ROOT_ID} .rvt-ranges-wrap {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  #${VT_ROOT_ID} .rvt-ranges {
    display: grid;
    grid-template-columns: auto auto;
    gap: 3px 8px;
    align-items: center;
    flex: 1 1 auto;
  }
  #${VT_ROOT_ID} .rvt-radar {
    flex: 0 0 116px;
    width: 116px;
    height: 116px;
    position: relative;
    border-radius: 50%;
    border: 1px solid rgba(212, 175, 55, 0.7);
    box-shadow:
      inset 0 0 16px rgba(0, 0, 0, 0.95),
      0 0 10px rgba(212, 175, 55, 0.25),
      0 2px 6px rgba(0, 0, 0, 0.8);
    background: radial-gradient(circle at 50% 50%, #0e1319 0%, #06090c 100%);
    overflow: hidden;
  }
  #${VT_ROOT_ID} .rvt-radar-face {
    position: absolute;
    inset: 0;
    background-position: center;
    background-repeat: no-repeat;
    background-size: 116px 116px;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120'%3E%3Ccircle cx='60' cy='60' r='18' fill='none' stroke='%23d4af37' stroke-width='0.8' stroke-opacity='0.45'/%3E%3Ccircle cx='60' cy='60' r='36' fill='none' stroke='%23d4af37' stroke-width='0.8' stroke-opacity='0.45'/%3E%3Ccircle cx='60' cy='60' r='54' fill='none' stroke='%23d4af37' stroke-width='0.8' stroke-opacity='0.45'/%3E%3Cline x1='60' y1='4' x2='60' y2='116' stroke='%23d4af37' stroke-width='0.8' stroke-opacity='0.35'/%3E%3Cline x1='4' y1='60' x2='116' y2='60' stroke='%23d4af37' stroke-width='0.8' stroke-opacity='0.35'/%3E%3Cline x1='21' y1='21' x2='99' y2='99' stroke='%23d4af37' stroke-width='0.6' stroke-opacity='0.25'/%3E%3Cline x1='21' y1='99' x2='99' y2='21' stroke='%23d4af37' stroke-width='0.6' stroke-opacity='0.25'/%3E%3C/svg%3E");
  }
  #${VT_ROOT_ID} .rvt-radar-sweep {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: conic-gradient(from 0deg, transparent 0deg, transparent 300deg, rgba(212, 175, 55, 0.08) 320deg, rgba(247, 213, 132, 0.45) 360deg);
    animation: rvt-radar-sweep 4s linear infinite;
    pointer-events: none;
  }
  @keyframes rvt-radar-sweep {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  #${VT_ROOT_ID} .rvt-radar-blip {
    position: absolute;
    width: 4px;
    height: 4px;
    left: 42px;
    top: 73px;
    background: #ffffff;
    border-radius: 50%;
    box-shadow: 0 0 6px 2px rgba(255, 215, 0, 0.95), 0 0 12px 4px rgba(255, 180, 0, 0.6);
    animation: rvt-blip-pulse 2s ease-in-out infinite;
  }
  #${VT_ROOT_ID} .rvt-radar-blip::before {
    content: "";
    position: absolute;
    top: 1px;
    left: -4px;
    width: 12px;
    height: 2px;
    background: rgba(255, 255, 255, 0.85);
    box-shadow: 0 0 4px #ffd700;
  }
  #${VT_ROOT_ID} .rvt-radar-blip::after {
    content: "";
    position: absolute;
    top: -4px;
    left: 1px;
    width: 2px;
    height: 12px;
    background: rgba(255, 255, 255, 0.85);
    box-shadow: 0 0 4px #ffd700;
  }
  @keyframes rvt-blip-pulse {
    0%, 100% { opacity: 0.7; transform: scale(0.9); }
    50% { opacity: 1; transform: scale(1.2); }
  }
  #${VT_ROOT_ID} .rvt-radar-center {
    position: absolute;
    left: 56px;
    top: 56px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: #ffd700;
    box-shadow: 0 0 4px rgba(255, 215, 0, 0.9);
  }

  /* ── Pets Wrap & Golden Wolf Silhouette Vignette ────────────────────── */
  #${VT_ROOT_ID} .rvt-pets-wrap {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  #${VT_ROOT_ID} .rvt-pets-ctl {
    flex: 1 1 auto;
  }
  #${VT_ROOT_ID} .rvt-vignette-wolf {
    flex: 0 0 130px;
    width: 130px;
    height: 94px;
    border-radius: 4px;
    background-position: center;
    background-repeat: no-repeat;
    background-size: cover;
    box-shadow: inset 0 0 8px rgba(0, 0, 0, 0.85);
    border: 1px solid rgba(142, 112, 51, 0.4);
    background-image:
      radial-gradient(circle at 70% 40%, rgba(247, 213, 132, 0.15), transparent 60%),
      linear-gradient(180deg, rgba(22, 18, 14, 0.2) 0%, rgba(12, 10, 8, 0.9) 100%),
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 140 100'%3E%3Ccircle cx='95' cy='52' r='28' fill='none' stroke='%23d4af37' stroke-width='0.8' stroke-opacity='0.4'/%3E%3Ccircle cx='95' cy='52' r='38' fill='none' stroke='%23d4af37' stroke-width='0.8' stroke-opacity='0.3'/%3E%3Cpath d='M65 95l12-25 10-18 6-15 4-12 8 8 10-12 3 14 12 18 10 42z' fill='%23100e0c' stroke='%23d4af37' stroke-width='1.2' stroke-linejoin='round'/%3E%3Ccircle cx='85' cy='42' r='2' fill='%23ffd700'/%3E%3Cpath d='M50 100l30-15 40 10 20-5v10H50z' fill='%23080706'/%3E%3C/svg%3E");
  }

  /* ── Behaviour Wrap, Mountain Castle Vignette & Switch Icons ─────────── */
  #${VT_ROOT_ID} .rvt-beh-wrap {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  #${VT_ROOT_ID} .rvt-checks {
    flex: 1 1 auto;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2px 10px;
  }
  #${VT_ROOT_ID} .rvt-checks .rvt-opt { min-height: 18px; }
  #${VT_ROOT_ID} .rvt-checks .rvt-opt[data-key="BoostNavPriority"] .hbk-label span::before,
  #${VT_ROOT_ID} .rvt-checks .rvt-opt[data-key*="Nav"] .hbk-label span::before { content: "↗ "; color: #f7d584; }
  #${VT_ROOT_ID} .rvt-checks .rvt-opt[data-key="PeaceModeWhenIdle"] .hbk-label span::before { content: "☮ "; color: #f7d584; }
  #${VT_ROOT_ID} .rvt-checks .rvt-opt[data-key="EnableAutostack"] .hbk-label span::before { content: "🥞 "; color: #f7d584; }
  #${VT_ROOT_ID} .rvt-checks .rvt-opt[data-key="UseDispelItems"] .hbk-label span::before { content: "🗑 "; color: #f7d584; }
  #${VT_ROOT_ID} .rvt-checks .rvt-opt[data-key="AutoFellowMgmt"] .hbk-label span::before { content: "👥 "; color: #f7d584; }
  #${VT_ROOT_ID} .rvt-checks .rvt-opt[data-key="BoostLootPriority"] .hbk-label span::before { content: "📦 "; color: #f7d584; }
  #${VT_ROOT_ID} .rvt-checks .rvt-opt[data-key="RebuffWhenIdle"] .hbk-label span::before { content: "⌛ "; color: #f7d584; }
  #${VT_ROOT_ID} .rvt-checks .rvt-opt[data-key="EnableAutocram"] .hbk-label span::before { content: "🔄 "; color: #f7d584; }
  #${VT_ROOT_ID} .rvt-checks .rvt-opt[data-key="CastDispelSelf"] .hbk-label span::before { content: "✨ "; color: #f7d584; }
  #${VT_ROOT_ID} .rvt-checks .rvt-opt[data-key*="ManaCharge"] .hbk-label span::before { content: "⚡ "; color: #f7d584; }

  #${VT_ROOT_ID} .rvt-vignette-castle {
    flex: 0 0 160px;
    width: 160px;
    height: 120px;
    border-radius: 4px;
    background-position: center;
    background-repeat: no-repeat;
    background-size: cover;
    box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.9);
    border: 1px solid rgba(142, 112, 51, 0.4);
    background-image:
      radial-gradient(ellipse at 75% 70%, rgba(255, 215, 0, 0.25) 0%, transparent 60%),
      linear-gradient(180deg, rgba(14, 12, 10, 0.3) 0%, rgba(8, 7, 5, 0.95) 100%),
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 160 120'%3E%3Cpath d='M0 120l30-35 45-20 40-30 45 85z' fill='%230f0d0a'/%3E%3Cpath d='M85 85l6-35 8 10 4-22 5 22 8-10 6 35z' fill='%2317130f' stroke='%23c8a248' stroke-width='0.8'/%3E%3Crect x='101' y='75' width='6' height='10' rx='3' fill='%23ffd700'/%3E%3Cpath d='M20 120l50-30 40 10 50-20v40H20z' fill='%23080706'/%3E%3C/svg%3E");
  }

  /* ── Monsters ──────────────────────────────────────────────────────── */
  #${VT_ROOT_ID} .rvt-table-wrap { overflow: auto; max-height: 334px; border: 1px solid rgba(78, 63, 31, 0.7); }
  #${VT_ROOT_ID} table.rvt-table { border-collapse: separate; border-spacing: 0; font-size: 10px; width: max-content; min-width: 100%; }
  #${VT_ROOT_ID} table.rvt-table th { position: sticky; top: 0; z-index: 2; background: #17130c; color: var(--hbk-gold, #d9b45a); font-weight: normal; padding: 2px 3px; white-space: nowrap; border-bottom: 1px solid var(--hbk-gold-deep, #4e3f1f); cursor: default; }
  #${VT_ROOT_ID} table.rvt-table th.rvt-th-spell { min-width: 15px; }
  #${VT_ROOT_ID} table.rvt-table td { padding: 1px 2px; text-align: center; white-space: nowrap; }
  #${VT_ROOT_ID} table.rvt-table tr:nth-child(even) td { background: rgba(255, 255, 255, 0.025); }
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

  /* ── Meta Views (windows created by a meta's CreateView) ───────────── */
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

// Combat HUD — retail port of gmCombatUI (layout 0x21000007, class
// 0x1000000C, 800x80 design canvas). Auto-shows when the player
// enters combat stance, auto-hides when peace.
//
// Layout decoded (combat_hud_layout_dump 2026-05-24 on 0x21000007):
//   Root 0x1000004B (type=268435468) 800x80  outer wrapper @ (0, 464)
//     0x1000004C (type=3)  10x80     left edge spacer       @ (0, 0)
//     0x1000004D (type=3)  690x80    main content area      @ (10, 0)
//     0x1000004E (type=3)  100x80    right edge spacer      @ (700, 0)
//     0x1000004F (type=11) 707x14    meter parent           @ (8, 9)
//       0x10000050 (type=7) 707x14   meter inner track
//         0x100005EF (type=3) 567x14 slider thumb / fill    @ (70, 0)
//     0x10000051 (type=0) 100x15     "Speed" label          @ (12, 9)
//     0x10000052 (type=0) 100x15     Speed value            @ (611, 9)
//     0x10000053 (type=0) 100x14     second-row label       @ (5, 29)
//     0x10000054 (type=0)  80x14     second-row value       @ (110, 29)
//     0x10000055 (type=0) 100x14     "Accuracy" label       @ (195, 29)
//     0x10000056 (type=17) 72x57     right button column    @ (722, 4)
//       0x10000057 (type=0) 72x19    High                   @ (0, 0)
//       0x10000058 (type=0) 72x19    Med                    @ (0, 19)
//       0x10000059 (type=0) 72x19    Low                    @ (0, 38)
//   0x1000005A (type=0) 72x19 (detached template, 4 states):
//     Normal=0x06004D1C  Pressed=0x06004D1D  Highlight=0x06004D1E
//
// Behaviour vs existing plugins:
//   - plugins/combat-bar.js — bar-slot popover with Hi/Med/Lo +
//     power + auto-repeat controls. Stays available in the bar.
//   - plugins/target-bar.js — Peace/Combat toggle + Use/Target/
//     Examine row. Stance toggle still lives there.
//   - plugins/combat-hud.js (THIS) — the horizontal wide bar that
//     auto-shows in combat. Power slider on left, 3 height buttons
//     on right. The user's "proper combat bar from the data".
//
// Authoritative stance source: window.__getCurrentStanceLow()
// (set by applyConfirmedStance on every kind=5 UpdateMotion).
// Low 16 bits == 0x3D = Peace; any other non-zero = in-combat stance.
//
// Click Hi/Med/Lo → window.__fireAttackOnTarget(heightId) — same
// path the existing combat-bar popover uses. The heightId values
// (Hi=2, Med=1, Lo=0) match scene3d/picking.js's expected enum.

import { setAcText } from "../ui/ac_font.js";
import { loadLayout, findElementById, getCachedLayout } from "../ui/ac_layout.js";

/** gmCombatUI — retail layout that drives the combat HUD horizontal bar.
 *  Element-id map confirmed by combat_hud_layout_dump 2026-05-24:
 *    0x1000004B — root wrapper (800×80)
 *    0x1000004D — main content area (690×80 at 10,0)
 *    0x1000004F — meter parent (Speed/Power slider, 707×14 at 8,9)
 *    0x100005EF — slider fill/thumb (567×14 at 70,0 inside track)
 *    0x10000051 — "Speed" / Power label (100×15 at 12,9)
 *    0x10000052 — Speed/Power value text (100×15 at 611,9)
 *    0x10000053 — second-row label e.g. "Accuracy:" (100×14 at 5,29)
 *    0x10000054 — second-row value (80×14 at 110,29)
 *    0x10000055 — "Accuracy" label (100×14 at 195,29)
 *    0x10000056 — right button column container (72×57 at 722,4)
 *    0x10000057 — High button (72×19 at 0,0 in column)
 *    0x10000058 — Med  button (72×19 at 0,19)
 *    0x10000059 — Low  button (72×19 at 0,38)
 */
const COMBAT_HUD_LAYOUT_ID = 0x21000007;
const COMBAT_HUD_ELEMS = {
  root:        0x1000004B,
  main:        0x1000004D,
  slider:      0x1000004F,
  sliderFill:  0x100005EF,
  powerLabel:  0x10000051,
  powerValue:  0x10000052,
  row2Label:   0x10000053,
  row2Value:   0x10000054,
  accLabel:    0x10000055,
  buttonCol:   0x10000056,
  high:        0x10000057,
  med:         0x10000058,
  low:         0x10000059,
};

const OVERLAY_ID = "hb-combat-hud";
const STYLE_ID   = "hb-combat-hud-style";
const SP = "./data/ui-sprites";

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    /* Retail gmCombatUI is 800×80 at design size; the layout applies
     * explicit child positions, so the overlay is just an anchored
     * pixel-accurate frame. CSS centering trap avoided per radar.js:
     * we use left:50% + margin-left:-400px instead of transform, so
     * applyCombatHudLayout's per-element transform overrides have a
     * clean baseline. */
    #${OVERLAY_ID} {
      position: fixed;
      bottom: 116px;  /* above target-bar (bottom:46) + hotbar (bottom:8) stack */
      left: 50%;
      margin-left: -400px;
      transform: none;
      width: 800px;
      height: 80px;
      z-index: 48;
      pointer-events: auto;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      background: rgba(20, 14, 8, 0.92);
      border: 1px solid var(--hb-border-brass);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.55);
      display: none;
      box-sizing: border-box;
    }
    #${OVERLAY_ID}[data-open="1"] { display: block; }
    /* Main content area (gmCombatUI 0x1000004D 690×80 @ 10,0). */
    #${OVERLAY_ID} .hch-main {
      position: absolute;
      left: 10px; top: 0;
      width: 690px; height: 80px;
    }
    /* Power/Speed slider parent (0x1000004F 707×14 @ 8,9). */
    #${OVERLAY_ID} .hch-slider {
      position: absolute;
      left: 8px; top: 9px;
      width: 707px; height: 14px;
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid var(--hb-border-brass-dim);
      box-sizing: border-box;
      cursor: pointer;
    }
    /* Slider fill (0x100005EF 567×14 @ 70,0 inside the track). Width
     * is set imperatively to track the current power level; left
     * anchor stays at 0 so the fill grows from the left edge. */
    #${OVERLAY_ID} .hch-slider-fill {
      position: absolute;
      top: 1px; left: 1px; bottom: 1px;
      width: 50%;
      background: linear-gradient(90deg,
        rgba(180, 130, 50, 0.7) 0%,
        rgba(220, 180, 80, 0.9) 100%);
      transition: width 80ms linear;
      pointer-events: none;
    }
    /* "Power" label (0x10000051 100×15 @ 12,9). */
    #${OVERLAY_ID} .hch-power-label {
      position: absolute;
      left: 12px; top: 9px;
      width: 100px; height: 15px;
      color: var(--hb-text-gold-dim);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-size: 10px;
      line-height: 14px;
      pointer-events: none;
    }
    /* Power-value readout (0x10000052 100×15 @ 611,9). */
    #${OVERLAY_ID} .hch-slider-val {
      position: absolute;
      left: 611px; top: 9px;
      width: 100px; height: 15px;
      color: var(--hb-text-gold);
      font-variant-numeric: tabular-nums;
      font-size: 10px;
      line-height: 14px;
      text-align: right;
      pointer-events: none;
    }
    /* Row-2 label "Accuracy:" (0x10000053 100×14 @ 5,29). */
    #${OVERLAY_ID} .hch-acc-label {
      position: absolute;
      left: 5px; top: 29px;
      width: 100px; height: 14px;
      color: var(--hb-text-gold-dim);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-size: 10px;
      line-height: 14px;
      pointer-events: none;
    }
    /* Row-2 value (0x10000054 80×14 @ 110,29). */
    #${OVERLAY_ID} .hch-acc-val {
      position: absolute;
      left: 110px; top: 29px;
      width: 80px; height: 14px;
      color: var(--hb-text-gold);
      font-size: 10px;
      line-height: 14px;
      pointer-events: none;
    }
    /* Trailing "Accuracy" label (0x10000055 100×14 @ 195,29). */
    #${OVERLAY_ID} .hch-acc-trailing {
      position: absolute;
      left: 195px; top: 29px;
      width: 100px; height: 14px;
      color: var(--hb-text-gold-dim);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-size: 10px;
      line-height: 14px;
      pointer-events: none;
    }
    /* Right button column (0x10000056 72×57 @ 722,4). */
    #${OVERLAY_ID} .hch-buttons {
      position: absolute;
      left: 722px; top: 4px;
      width: 72px; height: 57px;
    }
    /* Hi/Med/Lo buttons (0x10000057..9 72×19 each, stacked at y=0/19/38). */
    #${OVERLAY_ID} .hch-height {
      position: absolute;
      left: 0;
      width: 72px; height: 19px;
      background: url("${SP}/0x06004D1C.png") no-repeat center / 100% 100%;
      border: 0; padding: 0; margin: 0;
      font-family: var(--hb-font-serif);
      font-size: 10px;
      font-weight: 600;
      color: var(--hb-text-cream);
      letter-spacing: 0.04em;
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.85);
      cursor: pointer;
    }
    #${OVERLAY_ID} .hch-height[data-height="high"]   { top: 0; }
    #${OVERLAY_ID} .hch-height[data-height="medium"] { top: 19px; }
    #${OVERLAY_ID} .hch-height[data-height="low"]    { top: 38px; }
    #${OVERLAY_ID} .hch-height:hover {
      background-image: url("${SP}/0x06004D1E.png");
      color: var(--hb-text-gold);
    }
    #${OVERLAY_ID} .hch-height:active {
      background-image: url("${SP}/0x06004D1D.png");
    }
    #${OVERLAY_ID} .hch-height.armed {
      background-image: url("${SP}/0x06004D1E.png");
      color: var(--hb-text-gold);
    }
  `;
  document.head.appendChild(s);
}

// Module state (singleton).
let state = {
  overlayEl: null,
  visible: false,
  power: 1.0,         // 0..1, drives __combatBarState.powerLevel
};

function stanceIsCombat() {
  try {
    const fn = window.__getCurrentStanceLow;
    if (typeof fn !== "function") return false;
    const low = fn() || 0;
    return low !== 0 && low !== 0x3D; // 0x3D = Peace
  } catch { return false; }
}

function syncPowerFill() {
  const ov = state.overlayEl;
  if (!ov) return;
  const fill = ov.querySelector(".hch-slider-fill");
  const val = ov.querySelector(".hch-slider-val");
  if (fill) fill.style.width = `${Math.round(state.power * 100)}%`;
  if (val) setAcText(val, `${Math.round(state.power * 100)}%`);
  // Propagate to the shared combat bar state so picking.js's
  // fireAttackOnTarget honours the power level set here.
  if (window.__combatBarState) {
    window.__combatBarState.powerLevel = state.power;
  }
}

// Returns { overlay, refs } where refs is the element map applyCombatHudLayout
// walks. DOM mirrors the 0x21000007 element tree:
//   overlay (root 0x1000004B)
//   ├─ .hch-main (0x1000004D)
//   ├─ .hch-slider (0x1000004F)
//   │   └─ .hch-slider-fill (0x100005EF)
//   ├─ .hch-power-label (0x10000051)
//   ├─ .hch-slider-val (0x10000052)
//   ├─ .hch-acc-label (0x10000053)
//   ├─ .hch-acc-val (0x10000054)
//   ├─ .hch-acc-trailing (0x10000055)
//   └─ .hch-buttons (0x10000056)
//       ├─ .hch-height[data-height="high"]   (0x10000057)
//       ├─ .hch-height[data-height="medium"] (0x10000058)
//       └─ .hch-height[data-height="low"]    (0x10000059)
function build() {
  const ov = document.createElement("div");
  ov.id = OVERLAY_ID;
  ov.dataset.open = "0";

  const main = document.createElement("div");
  main.className = "hch-main";
  // main holds the slider, labels, and button column; using pointer-events:
  // none on .main would prevent the slider drag from working, so leave it on.
  ov.appendChild(main);

  // Power slider (0x1000004F at 8,9). Fill child is 0x100005EF.
  const powerSlider = document.createElement("div");
  powerSlider.className = "hch-slider";
  const powerFill = document.createElement("div");
  powerFill.className = "hch-slider-fill";
  powerSlider.appendChild(powerFill);
  ov.appendChild(powerSlider);

  // Slider drag → update power. Hit-rect is the slider element, not the fill.
  let dragging = false;
  function setFromEv(ev) {
    const r = powerSlider.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    state.power = f;
    syncPowerFill();
  }
  powerSlider.addEventListener("pointerdown", (ev) => {
    dragging = true;
    powerSlider.setPointerCapture?.(ev.pointerId);
    setFromEv(ev);
  });
  powerSlider.addEventListener("pointermove", (ev) => {
    if (dragging) setFromEv(ev);
  });
  powerSlider.addEventListener("pointerup", (ev) => {
    dragging = false;
    powerSlider.releasePointerCapture?.(ev.pointerId);
  });

  // "Power" label (0x10000051).
  const powerLabel = document.createElement("div");
  powerLabel.className = "hch-power-label";
  setAcText(powerLabel, "Power");
  ov.appendChild(powerLabel);

  // Power-value readout (0x10000052).
  const powerVal = document.createElement("div");
  powerVal.className = "hch-slider-val";
  setAcText(powerVal, "100%");
  ov.appendChild(powerVal);

  // Row-2 label e.g. "Accuracy:" (0x10000053).
  const row2Label = document.createElement("div");
  row2Label.className = "hch-acc-label";
  setAcText(row2Label, "Accuracy");
  ov.appendChild(row2Label);

  // Row-2 value (0x10000054).
  const row2Val = document.createElement("div");
  row2Val.className = "hch-acc-val";
  setAcText(row2Val, "—");
  ov.appendChild(row2Val);

  // Trailing accuracy label (0x10000055).
  const accLabel = document.createElement("div");
  accLabel.className = "hch-acc-trailing";
  setAcText(accLabel, "Accuracy");
  ov.appendChild(accLabel);

  // Right button column (0x10000056).
  const buttons = document.createElement("div");
  buttons.className = "hch-buttons";
  const HEIGHTS = [
    { id: "high",   label: "High",   value: 2 },
    { id: "medium", label: "Medium", value: 1 },
    { id: "low",    label: "Low",    value: 0 },
  ];
  const heightEls = { high: null, medium: null, low: null };
  for (const h of HEIGHTS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hch-height";
    btn.dataset.height = h.id;
    btn.dataset.heightValue = String(h.value);
    setAcText(btn, h.label);
    btn.title = `Attack at ${h.label} height`;
    btn.addEventListener("click", () => {
      // Mirrors plugins/combat-bar.js's Hi/Med/Lo wiring — calls
      // the global exposed by picking.js (line 375).
      if (typeof window.__fireAttackOnTarget === "function") {
        window.__fireAttackOnTarget(h.value);
      } else {
        console.warn("[combat-hud] __fireAttackOnTarget not exposed");
      }
    });
    buttons.appendChild(btn);
    heightEls[h.id] = btn;
  }
  ov.appendChild(buttons);

  document.body.appendChild(ov);

  // Apply retail layout positions for sub-elements once the DOM is wired.
  applyCombatHudLayout({
    mainEl: main,
    sliderEl: powerSlider,
    fillEl: powerFill,
    powerLabelEl: powerLabel,
    powerValEl: powerVal,
    row2LabelEl: row2Label,
    row2ValEl: row2Val,
    accLabelEl: accLabel,
    buttonsEl: buttons,
    heightEls,
  });

  return ov;
}

// Apply gmCombatUI 0x21000007 layout to the combat-hud's sub-elements.
// Sizes + positions come from the LayoutDesc; the hand-tuned CSS values
// in ensureStyles() are very close already (no 1-2px deltas; they were
// derived from the dump comment, but applying the layout at runtime
// makes the DAT the source of truth so future tweaks come from the
// asset rather than the plugin).
//
// Boot-order note: combat-hud mounts via mountBar() — same race window
// as radar. Retry every 2s up to 8 times (~16s) before giving up.
function applyCombatHudLayout(refs, attempt = 0) {
  const apply = (layout) => {
    if (!layout) {
      if (attempt < 8) {
        setTimeout(() => applyCombatHudLayout(refs, attempt + 1), 2000);
      }
      return;
    }
    let applied = 0;
    const pairs = [
      [COMBAT_HUD_ELEMS.main,        refs.mainEl],
      [COMBAT_HUD_ELEMS.slider,      refs.sliderEl],
      [COMBAT_HUD_ELEMS.sliderFill,  refs.fillEl],
      [COMBAT_HUD_ELEMS.powerLabel,  refs.powerLabelEl],
      [COMBAT_HUD_ELEMS.powerValue,  refs.powerValEl],
      [COMBAT_HUD_ELEMS.row2Label,   refs.row2LabelEl],
      [COMBAT_HUD_ELEMS.row2Value,   refs.row2ValEl],
      [COMBAT_HUD_ELEMS.accLabel,    refs.accLabelEl],
      [COMBAT_HUD_ELEMS.buttonCol,   refs.buttonsEl],
      [COMBAT_HUD_ELEMS.high,        refs.heightEls?.high],
      [COMBAT_HUD_ELEMS.med,         refs.heightEls?.medium],
      [COMBAT_HUD_ELEMS.low,         refs.heightEls?.low],
    ];
    for (const [id, el] of pairs) {
      if (!el) continue;
      const desc = findElementById(layout, id);
      if (!desc) continue;
      // Slider fill: x is the rest-position of the thumb (567×14 @ 70,0).
      // We DON'T want to apply that x as left — width is driven by
      // syncPowerFill(). Skip the x-write for the fill ref; width
      // comes from syncPowerFill at runtime.
      if (el === refs.fillEl) {
        if (typeof desc.y === "number") el.style.top = `${desc.y + 1}px`;
        if (typeof desc.height === "number") el.style.height = `${desc.height - 2}px`;
        applied += 1;
        continue;
      }
      // Hi/Med/Lo buttons: positions are relative to the .hch-buttons
      // container, which lives at (722, 4). Apply x/y as-is.
      if (typeof desc.x === "number") el.style.left = `${desc.x}px`;
      if (typeof desc.y === "number") el.style.top = `${desc.y}px`;
      if (typeof desc.width === "number") el.style.width = `${desc.width}px`;
      if (typeof desc.height === "number") el.style.height = `${desc.height}px`;
      applied += 1;
    }
    // After re-applying widths/positions, refresh the fill width to
    // honor the new slider track width.
    syncPowerFill();
    try {
      window.__diag?.layout?.onCombatHudApplied?.({ applied });
    } catch (_) {}
  };
  const cached = getCachedLayout(COMBAT_HUD_LAYOUT_ID);
  if (cached) { apply(cached); return; }
  loadLayout(COMBAT_HUD_LAYOUT_ID).then(apply).catch(() => {});
}

function show() {
  if (!state.overlayEl) state.overlayEl = build();
  state.overlayEl.dataset.open = "1";
  state.visible = true;
  syncPowerFill();
}

function hide() {
  if (!state.overlayEl) return;
  state.overlayEl.dataset.open = "0";
  state.visible = false;
}

export const manifest = {
  id: "combat-hud",
  name: "Combat HUD",
  icon: "⚔",
  iconHidden: true,
  version: "0.1.0",
  description: "Retail gmCombatUI horizontal bar — auto-shows when in combat stance",
};

export function mount(_ctx) {
  ensureStyles();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
  state.overlayEl = build();
  syncPowerFill();

  // 4Hz poll of the authoritative stance source. Cheap; ~0.0001ms.
  const t = setInterval(() => {
    const inCombat = stanceIsCombat();
    if (inCombat && !state.visible) show();
    else if (!inCombat && state.visible) hide();
  }, 250);

  return () => {
    clearInterval(t);
    if (state.overlayEl) {
      state.overlayEl.remove();
      state.overlayEl = null;
    }
  };
}

// Debug: pop the bar without needing combat stance.
if (typeof window !== "undefined") {
  window.__combatHudDebug = function () {
    ensureStyles();
    if (!state.overlayEl) state.overlayEl = build();
    show();
  };
}

// Combat HUD — retail port of gmCombatUI (layout 0x21000007, class
// 0x1000000C, 800x80 design canvas). Auto-shows when the player
// enters combat stance, auto-hides when peace.
//
// Layout decoded (chorizite-dump-layout-tree on 0x21000007):
//   Root 0x1000004B  800x80  outer wrapper
//     0x1000004C   10x80     left edge spacer
//     0x1000004D  690x80     main content area
//       0x1000004F 707x14    meter parent (Speed/Power slider track)
//         0x10000050 707x14  meter inner track
//           0x100005EF 567x14 slider thumb / fill
//       0x10000051 100x15    "Speed" label (StringId 200023700)
//       0x10000052 100x15    Speed value
//       0x10000053 100x14    second-row label
//       0x10000054  80x14    second-row value
//       0x10000055 100x14    "Accuracy" label (StringId 9706964)
//     0x10000056   72x57     right button column
//       0x10000057 72x19     High  (StringId 45713544)
//       0x10000058 72x19     Med   (StringId 173867533)
//       0x10000059 72x19     Low   (StringId 86746391)
//   0x1000005A 72x19 (detached template):
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

const OVERLAY_ID = "hb-combat-hud";
const STYLE_ID   = "hb-combat-hud-style";
const SP = "./data/ui-sprites";

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      bottom: 116px;  /* above target-bar (bottom:46) + hotbar (bottom:8) stack */
      left: 50%;
      transform: translateX(-50%);
      width: 540px;
      height: 64px;
      z-index: 48;
      pointer-events: auto;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      background: rgba(20, 14, 8, 0.92);
      border: 1px solid var(--hb-border-brass);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.55);
      display: none;
      padding: 6px 8px;
      box-sizing: border-box;
      gap: 8px;
    }
    #${OVERLAY_ID}[data-open="1"] { display: flex; align-items: stretch; }
    #${OVERLAY_ID} .hch-left {
      flex: 1 1 auto;
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }
    #${OVERLAY_ID} .hch-row {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 10px;
      color: var(--hb-text-cream);
    }
    #${OVERLAY_ID} .hch-label {
      flex: 0 0 60px;
      color: var(--hb-text-gold-dim);
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    #${OVERLAY_ID} .hch-slider {
      flex: 1 1 auto;
      height: 12px;
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid var(--hb-border-brass-dim);
      position: relative;
      cursor: pointer;
    }
    #${OVERLAY_ID} .hch-slider-fill {
      position: absolute;
      top: 1px; bottom: 1px; left: 1px;
      width: 50%;
      background: linear-gradient(90deg,
        rgba(180, 130, 50, 0.7) 0%,
        rgba(220, 180, 80, 0.9) 100%);
      transition: width 80ms linear;
    }
    #${OVERLAY_ID} .hch-slider-val {
      flex: 0 0 36px;
      color: var(--hb-text-gold);
      font-variant-numeric: tabular-nums;
      text-align: right;
    }
    #${OVERLAY_ID} .hch-right {
      flex: 0 0 80px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    #${OVERLAY_ID} .hch-height {
      width: 72px; height: 14px;
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

function build() {
  const ov = document.createElement("div");
  ov.id = OVERLAY_ID;
  ov.dataset.open = "0";

  // Left side: power slider + (placeholder) accuracy strip
  const left = document.createElement("div");
  left.className = "hch-left";

  const powerRow = document.createElement("div");
  powerRow.className = "hch-row";
  const powerLabel = document.createElement("div");
  powerLabel.className = "hch-label";
  setAcText(powerLabel, "Power");
  const powerSlider = document.createElement("div");
  powerSlider.className = "hch-slider";
  const powerFill = document.createElement("div");
  powerFill.className = "hch-slider-fill";
  powerSlider.appendChild(powerFill);
  const powerVal = document.createElement("div");
  powerVal.className = "hch-slider-val";
  setAcText(powerVal, "100%");
  powerRow.appendChild(powerLabel);
  powerRow.appendChild(powerSlider);
  powerRow.appendChild(powerVal);
  left.appendChild(powerRow);

  // Slider drag → update power
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

  const accRow = document.createElement("div");
  accRow.className = "hch-row";
  const accLabel = document.createElement("div");
  accLabel.className = "hch-label";
  setAcText(accLabel, "Accuracy");
  const accSlider = document.createElement("div");
  accSlider.className = "hch-slider";
  const accFill = document.createElement("div");
  accFill.className = "hch-slider-fill";
  accFill.style.width = "100%";
  accSlider.appendChild(accFill);
  const accVal = document.createElement("div");
  accVal.className = "hch-slider-val";
  setAcText(accVal, "—");
  accRow.appendChild(accLabel);
  accRow.appendChild(accSlider);
  accRow.appendChild(accVal);
  left.appendChild(accRow);

  ov.appendChild(left);

  // Right side: 3 height buttons
  const right = document.createElement("div");
  right.className = "hch-right";
  const HEIGHTS = [
    { id: "high",   label: "High",   value: 2 },
    { id: "medium", label: "Medium", value: 1 },
    { id: "low",    label: "Low",    value: 0 },
  ];
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
    right.appendChild(btn);
  }
  ov.appendChild(right);

  document.body.appendChild(ov);
  return ov;
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

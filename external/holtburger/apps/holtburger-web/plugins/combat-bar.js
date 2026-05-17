const STORAGE_KEY = "holtburger_combat_bar_v1";

const DEFAULTS = {
  attackHeight: 2, // MEDIUM
  powerLevel: 1.0,
  autoRepeat: true,
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage may be unavailable (private mode); silently drop
  }
}

function syncWindowState(state) {
  window.__combatBarState = {
    attackHeight: state.attackHeight,
    powerLevel: state.powerLevel,
    autoRepeat: state.autoRepeat,
  };
}

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "hb-combat-bar-style";
  style.textContent = `
    .hb-cb-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
      font-size: 12px;
    }
    .hb-cb-row label {
      flex: 0 0 auto;
      color: rgba(255, 255, 255, 0.75);
    }
    .hb-cb-heights {
      display: flex;
      gap: 4px;
      flex: 1;
    }
    .hb-cb-height-btn {
      flex: 1;
      padding: 4px 6px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: rgba(255, 255, 255, 0.8);
      border-radius: 4px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
    }
    .hb-cb-height-btn:hover {
      background: rgba(255, 255, 255, 0.12);
    }
    .hb-cb-height-btn.active {
      background: rgba(255, 120, 60, 0.4);
      border-color: rgba(255, 140, 80, 0.7);
      color: #fff;
    }
    .hb-cb-power-row input[type="range"] {
      flex: 1;
    }
    .hb-cb-power-val {
      flex: 0 0 36px;
      text-align: right;
      font-variant-numeric: tabular-nums;
      color: rgba(255, 255, 255, 0.7);
    }
    .hb-cb-toggle {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: rgba(255, 255, 255, 0.75);
      cursor: pointer;
    }
    .hb-cb-hint {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.45);
      margin-top: 6px;
      line-height: 1.4;
    }
  `;
  document.head.appendChild(style);
}

// Seed window.__combatBarState at import time so picking.js reads
// the persisted values (or DEFAULTS on a fresh session) even when
// the user never opens the panel this session.
if (typeof window !== "undefined") {
  syncWindowState(loadState());
}

export const manifest = {
  id: "combat-bar",
  name: "Combat Bar",
  icon: "⚒",
  version: "0.0.1",
  description: "Attack height + power + auto-repeat for melee combat",
};

export function activate(bodyEl) {
  ensureStyles();
  const state = loadState();
  syncWindowState(state);

  // Height picker
  const heightRow = document.createElement("div");
  heightRow.className = "hb-cb-row";
  const heightLabel = document.createElement("label");
  heightLabel.textContent = "Height";
  heightRow.appendChild(heightLabel);
  const heightGroup = document.createElement("div");
  heightGroup.className = "hb-cb-heights";
  const HEIGHTS = [
    { value: 1, label: "High" },
    { value: 2, label: "Mid" },
    { value: 3, label: "Low" },
  ];
  const heightButtons = new Map();
  for (const h of HEIGHTS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hb-cb-height-btn";
    btn.textContent = h.label;
    btn.dataset.value = String(h.value);
    if (state.attackHeight === h.value) btn.classList.add("active");
    btn.addEventListener("click", () => {
      state.attackHeight = h.value;
      for (const [v, b] of heightButtons) {
        b.classList.toggle("active", v === h.value);
      }
      saveState(state);
      syncWindowState(state);
    });
    heightButtons.set(h.value, btn);
    heightGroup.appendChild(btn);
  }
  heightRow.appendChild(heightGroup);
  bodyEl.appendChild(heightRow);

  // Power slider
  const powerRow = document.createElement("div");
  powerRow.className = "hb-cb-row hb-cb-power-row";
  const powerLabel = document.createElement("label");
  powerLabel.textContent = "Power";
  powerRow.appendChild(powerLabel);
  const powerSlider = document.createElement("input");
  powerSlider.type = "range";
  powerSlider.min = "0";
  powerSlider.max = "100";
  powerSlider.step = "1";
  powerSlider.value = String(Math.round(state.powerLevel * 100));
  const powerVal = document.createElement("span");
  powerVal.className = "hb-cb-power-val";
  powerVal.textContent = `${powerSlider.value}%`;
  powerSlider.addEventListener("input", () => {
    state.powerLevel = Number(powerSlider.value) / 100;
    powerVal.textContent = `${powerSlider.value}%`;
    syncWindowState(state);
  });
  powerSlider.addEventListener("change", () => saveState(state));
  powerRow.appendChild(powerSlider);
  powerRow.appendChild(powerVal);
  bodyEl.appendChild(powerRow);

  // Auto-repeat tickbox
  const repeatLabel = document.createElement("label");
  repeatLabel.className = "hb-cb-toggle";
  const repeatBox = document.createElement("input");
  repeatBox.type = "checkbox";
  repeatBox.checked = !!state.autoRepeat;
  repeatBox.addEventListener("change", () => {
    state.autoRepeat = repeatBox.checked;
    saveState(state);
    syncWindowState(state);
  });
  repeatLabel.appendChild(repeatBox);
  const repeatText = document.createElement("span");
  repeatText.textContent = "Auto-repeat attacks";
  repeatLabel.appendChild(repeatText);
  bodyEl.appendChild(repeatLabel);

  const hint = document.createElement("div");
  hint.className = "hb-cb-hint";
  hint.textContent =
    "Settings apply to your next click-to-attack. ACE owns the auto-repeat loop server-side.";
  bodyEl.appendChild(hint);

  // No teardown needed — DOM is cleaned by the bar when the panel
  // closes. Return undefined (the bar's openPanel only calls a
  // returned function when it's a function).
  return undefined;
}

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
    .hb-cb-feed {
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid rgba(255, 255, 255, 0.12);
      display: flex;
      flex-direction: column;
      gap: 2px;
      font-size: 11px;
      line-height: 1.35;
      max-height: 90px;
      overflow-y: auto;
    }
    .hb-cb-feed-line {
      color: rgba(255, 255, 255, 0.65);
      font-variant-numeric: tabular-nums;
    }
    .hb-cb-feed-line.hb-cb-feed-hit { color: rgba(255, 200, 120, 0.9); }
    .hb-cb-feed-line.hb-cb-feed-taken { color: rgba(255, 130, 130, 0.9); }
    .hb-cb-feed-line.hb-cb-feed-miss { color: rgba(180, 180, 180, 0.7); font-style: italic; }
    .hb-cb-feed-empty {
      color: rgba(255, 255, 255, 0.35);
      font-style: italic;
    }
  `;
  document.head.appendChild(style);
}

// Stance enum values that mean "ranged combat" — used to flip the
// slider label from Power → Accuracy. Mirrors RANGED_STANCES in
// index.html.
const RANGED_STANCES = new Set([
  0x003f, 0x0041, 0x0043, 0x0047, 0x00e8, 0x00e9, 0x013b, 0x013c,
]);
function currentStanceIsRanged() {
  const fn = typeof window !== "undefined" ? window.__getCurrentStanceLow : null;
  if (typeof fn !== "function") return false;
  try {
    return RANGED_STANCES.has(fn());
  } catch {
    return false;
  }
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

export function activate(bodyEl, ctx) {
  ensureStyles();
  const state = loadState();
  syncWindowState(state);
  const client = ctx?.client ?? window.__pluginClient ?? null;

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

  // Power / Accuracy slider — label flips based on local combat stance.
  const powerRow = document.createElement("div");
  powerRow.className = "hb-cb-row hb-cb-power-row";
  const powerLabel = document.createElement("label");
  powerLabel.textContent = currentStanceIsRanged() ? "Accuracy" : "Power";
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

  // Live damage feed — subscribes to the facade combat events and
  // prepends the last few lines. Skipped gracefully when the facade
  // isn't available yet (pre-login).
  const feedEl = document.createElement("div");
  feedEl.className = "hb-cb-feed";
  const feedEmpty = document.createElement("div");
  feedEmpty.className = "hb-cb-feed-empty";
  feedEmpty.textContent =
    client ? "Combat feed — waiting for first hit…" : "Login to start the combat feed.";
  feedEl.appendChild(feedEmpty);
  bodyEl.appendChild(feedEl);

  const FEED_LIMIT = 5;
  const lines = [];
  function pushLine(text, cls) {
    if (feedEmpty.parentNode) feedEmpty.remove();
    const line = document.createElement("div");
    line.className = `hb-cb-feed-line ${cls}`;
    line.textContent = text;
    feedEl.insertBefore(line, feedEl.firstChild);
    lines.unshift(line);
    while (lines.length > FEED_LIMIT) {
      const old = lines.pop();
      if (old?.parentNode) old.remove();
    }
  }

  const subs = [];
  if (client?.events?.on) {
    const onDealt = (ev) => {
      const d = ev.detail ?? {};
      const crit = d.criticalHit ? " (crit)" : "";
      pushLine(
        `→ ${d.defenderName ?? "?"}  ${d.damage ?? 0} ${d.damageType ?? ""}${crit}`,
        "hb-cb-feed-hit",
      );
    };
    const onTaken = (ev) => {
      const d = ev.detail ?? {};
      const crit = d.criticalHit ? " (crit)" : "";
      pushLine(
        `← ${d.attackerName ?? "?"}  ${d.damage ?? 0} ${d.damageType ?? ""} → ${d.damageLocation ?? ""}${crit}`,
        "hb-cb-feed-taken",
      );
    };
    const onEvadeTarget = (ev) => {
      pushLine(`→ ${ev.detail?.defenderName ?? "?"} evaded`, "hb-cb-feed-miss");
    };
    const onEvadeAttacker = (ev) => {
      pushLine(`← evaded ${ev.detail?.attackerName ?? "?"}`, "hb-cb-feed-miss");
    };
    client.events.on("damageDealt", onDealt);
    client.events.on("damageTaken", onTaken);
    client.events.on("evadedTarget", onEvadeTarget);
    client.events.on("evadedAttacker", onEvadeAttacker);
    subs.push(() => client.events.off("damageDealt", onDealt));
    subs.push(() => client.events.off("damageTaken", onTaken));
    subs.push(() => client.events.off("evadedTarget", onEvadeTarget));
    subs.push(() => client.events.off("evadedAttacker", onEvadeAttacker));
  }

  // Return a teardown so the bar's openPanel can clean up our
  // event subscriptions when the panel closes.
  return () => {
    for (const dispose of subs) {
      try { dispose(); } catch {}
    }
  };
}

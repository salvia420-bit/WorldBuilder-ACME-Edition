// Vitae detail panel — small popup showing the player's current vitae
// penalty + the XP threshold needed to clear it (ACE
// `Player_Xp.VitaeCPPoolThreshold(vitae, level)`). Opens on click of
// the status-indicators "vitae" indicator (or via the programmatic
// API below), auto-hides after a short delay, and updates live on
// every vitaeChanged / playerStatsUpdated event.
//
// Note on accuracy: the current VitaeCpPool progress is NOT surfaced
// from the wasm side yet, so the panel shows the pool THRESHOLD (max
// XP to clear) rather than the live debt remaining. We use the
// player's current Level as a proxy for DeathLevel — close to retail
// for players who haven't levelled-up between deaths, off by one
// otherwise. The pool-progress wiring is a wasm follow-on.
//
// Programmatic API:
//   window.__showVitaeDetail() / __hideVitaeDetail() / __toggleVitaeDetail()
//
// References:
//   - ace-server Player_Xp.cs:433 VitaeCPPoolThreshold formula
//   - plugins/world-objects/character.js:108 vitaeChanged event
//   - plugins/status-indicators.js INDICATORS.vitae (click target)

import { setAcText } from "../ui/ac_font.js";

const OVERLAY_ID = "hb-vitae-detail";
const STYLE_ID = "hb-vitae-detail-style";

const state = {
  overlayEl: null,
  vitaeRowEl: null,
  thresholdRowEl: null,
  noteEl: null,
  client: null,
  unsubStats: null,
  unsubCharVitae: null,
  characterRef: null,
  charAttachTimer: 0,
  autoHideTimer: 0,
};

function ensureStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      top: 30px;
      left: 32px;
      min-width: 220px;
      max-width: 280px;
      z-index: 65;
      display: none;
      padding: 8px 12px 10px 12px;
      background: rgba(20, 14, 8, 0.96);
      border: 1px solid var(--hb-border-brass, #b08a4a);
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.7);
      font-family: var(--hb-font-serif, serif);
      color: var(--hb-text-cream, #e8d8b0);
    }
    #${OVERLAY_ID}[data-open="1"] { display: block; }
    #${OVERLAY_ID} .hb-vd-title {
      font-size: 12px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--hb-text-gold, #d4af37);
      margin: 0 0 6px 0;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--hb-border-brass-dim, rgba(176, 138, 74, 0.4));
    }
    #${OVERLAY_ID} .hb-vd-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      font-size: 11px;
      margin: 3px 0;
      font-variant-numeric: tabular-nums;
    }
    #${OVERLAY_ID} .hb-vd-row .label { color: var(--hb-text-label, #b0a080); }
    #${OVERLAY_ID} .hb-vd-row .value { color: var(--hb-text-cream-bright, #f0e0b8); }
    #${OVERLAY_ID} .hb-vd-note {
      font-size: 10px;
      color: var(--hb-text-muted, #b0a080);
      margin-top: 6px;
      font-style: italic;
      line-height: 1.3;
    }
  `;
  document.head.appendChild(s);
}

// ACE Player_Xp.cs:433 — VitaeCPPoolThreshold(vitae, level)
// = (pow(level, 2.5) * 2.5 + 20) * pow(vitae, 5.0) + 0.5
function vitaeCpPoolThreshold(vitae, level) {
  const v = Number(vitae);
  const lv = Number(level);
  if (!Number.isFinite(v) || !Number.isFinite(lv) || lv <= 0 || v <= 0 || v >= 1) {
    return 0;
  }
  return Math.floor((Math.pow(lv, 2.5) * 2.5 + 20.0) * Math.pow(v, 5.0) + 0.5);
}

function readVitae() {
  // Prefer typed Character (event-driven, freshest).
  try {
    const ch = state.client?.character ?? state.client?.world?.character ?? state.characterRef;
    if (ch && typeof ch.vitae === "number") return ch.vitae;
  } catch (_) {}
  // Fallback: handle.playerStats() if exposed.
  try {
    const handle = window.__sessionHandle;
    const stats = typeof handle?.playerStats === "function" ? handle.playerStats() : null;
    if (stats && typeof stats.vitae === "number") return stats.vitae;
  } catch (_) {}
  return 1.0;
}

function readLevel() {
  try {
    const handle = window.__sessionHandle;
    const stats = typeof handle?.playerStats === "function" ? handle.playerStats() : null;
    if (stats && typeof stats.level === "number") return stats.level;
  } catch (_) {}
  return 0;
}

function render() {
  if (!state.overlayEl) return;
  const vitae = readVitae();
  const level = readLevel();
  const pctRaw = (1.0 - vitae) * 100;
  const pct = Math.max(0, Math.round(pctRaw));
  if (state.vitaeRowEl) {
    const valueEl = state.vitaeRowEl.querySelector(".value");
    if (valueEl) setAcText(valueEl, `${pct}%`);
  }
  if (state.thresholdRowEl) {
    const valueEl = state.thresholdRowEl.querySelector(".value");
    if (valueEl) {
      if (vitae >= 1.0) {
        setAcText(valueEl, "—");
      } else if (level <= 0) {
        setAcText(valueEl, "level unknown");
      } else {
        const t = vitaeCpPoolThreshold(vitae, level);
        setAcText(valueEl, `${t.toLocaleString()} XP`);
      }
    }
  }
}

function ensurePanel() {
  if (state.overlayEl) return state.overlayEl;
  ensureStyles();
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Vitae detail");
  overlay.setAttribute("data-open", "0");

  const title = document.createElement("div");
  title.className = "hb-vd-title";
  title.textContent = "Vitae";
  overlay.appendChild(title);

  const vRow = document.createElement("div");
  vRow.className = "hb-vd-row";
  const vLabel = document.createElement("span");
  vLabel.className = "label";
  vLabel.textContent = "Penalty";
  const vValue = document.createElement("span");
  vValue.className = "value";
  vValue.textContent = "0%";
  vRow.appendChild(vLabel);
  vRow.appendChild(vValue);
  overlay.appendChild(vRow);

  const tRow = document.createElement("div");
  tRow.className = "hb-vd-row";
  const tLabel = document.createElement("span");
  tLabel.className = "label";
  tLabel.textContent = "CP threshold";
  const tValue = document.createElement("span");
  tValue.className = "value";
  tValue.textContent = "—";
  tRow.appendChild(tLabel);
  tRow.appendChild(tValue);
  overlay.appendChild(tRow);

  const note = document.createElement("div");
  note.className = "hb-vd-note";
  note.textContent =
    "Threshold = max CP to clear vitae (computed from current Level as DeathLevel proxy). Live VitaeCpPool progress pending wasm surface.";
  overlay.appendChild(note);

  document.body.appendChild(overlay);
  state.overlayEl = overlay;
  state.vitaeRowEl = vRow;
  state.thresholdRowEl = tRow;
  state.noteEl = note;
  return overlay;
}

export function show() {
  const overlay = ensurePanel();
  render();
  overlay.dataset.open = "1";
  if (state.autoHideTimer) { try { clearTimeout(state.autoHideTimer); } catch (_) {} state.autoHideTimer = 0; }
}

export function hide() {
  const overlay = state.overlayEl;
  if (!overlay) return;
  overlay.dataset.open = "0";
  if (state.autoHideTimer) { try { clearTimeout(state.autoHideTimer); } catch (_) {} state.autoHideTimer = 0; }
}

function tryAttachCharacter() {
  if (state.unsubCharVitae) return true;
  try {
    const ch = state.client?.character ?? state.client?.world?.character ?? null;
    if (!ch || typeof ch.addEventListener !== "function") return false;
    const handler = () => { if (state.overlayEl?.dataset.open === "1") render(); };
    ch.addEventListener("vitaeChanged", handler);
    state.characterRef = ch;
    state.unsubCharVitae = () => {
      try { ch.removeEventListener("vitaeChanged", handler); } catch (_) {}
    };
    return true;
  } catch (_) { return false; }
}

export const manifest = {
  id: "vitae-detail",
  name: "Vitae Detail",
  icon: "💀",
  iconHidden: true,
  version: "0.1.0",
  description: "Vitae detail popup — current penalty + ACE VitaeCPPoolThreshold (Player_Xp.cs:433).",
};

export function mount(ctx) {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return () => {};
  }
  ensureStyles();
  state.client = ctx?.client ?? window.__pluginClient ?? null;

  // playerStatsUpdated fallback — re-render if the panel is open, and
  // poll for the typed Character if it wasn't ready at mount.
  const onStatsUpdated = () => {
    if (!state.unsubCharVitae) tryAttachCharacter();
    if (state.overlayEl?.dataset.open === "1") render();
  };
  try {
    if (typeof state.client?.events?.on === "function") {
      state.client.events.on("playerStatsUpdated", onStatsUpdated);
      state.unsubStats = () => {
        try { state.client?.events?.off?.("playerStatsUpdated", onStatsUpdated); } catch (_) {}
      };
    }
  } catch (e) {
    console.warn("[vitae-detail] playerStatsUpdated subscribe failed:", e);
  }
  // First-chance attach (Character may already be live by mount).
  tryAttachCharacter();

  // Hook the status-indicators vitae indicator to toggle this panel.
  // Polls briefly in case status-indicators mounts after us.
  let installAttempts = 0;
  function tryInstallClickHandler() {
    installAttempts += 1;
    const vitaeEl = document.querySelector('#hb-status-indicators [data-indicator="vitae"]');
    if (vitaeEl && !vitaeEl.dataset.vitaeDetailWired) {
      vitaeEl.dataset.vitaeDetailWired = "1";
      vitaeEl.style.cursor = "pointer";
      vitaeEl.addEventListener("click", () => {
        if (state.overlayEl?.dataset.open === "1") hide();
        else show();
      });
      return true;
    }
    return false;
  }
  if (!tryInstallClickHandler()) {
    const installTimer = setInterval(() => {
      if (tryInstallClickHandler() || installAttempts > 30) {
        clearInterval(installTimer);
      }
    }, 500);
  }

  return () => {
    try { if (typeof state.unsubStats === "function") state.unsubStats(); } catch (_) {}
    try { if (typeof state.unsubCharVitae === "function") state.unsubCharVitae(); } catch (_) {}
    state.unsubStats = null;
    state.unsubCharVitae = null;
    state.characterRef = null;
    state.client = null;
  };
}

if (typeof window !== "undefined") {
  window.__showVitaeDetail = show;
  window.__hideVitaeDetail = hide;
  window.__toggleVitaeDetail = () => {
    if (state.overlayEl?.dataset.open === "1") hide();
    else show();
  };
}

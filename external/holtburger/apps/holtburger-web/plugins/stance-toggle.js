let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "hb-stance-style";
  style.textContent = `
    .hb-stance-current {
      font-size: 13px;
      color: rgba(255, 255, 255, 0.85);
      margin-bottom: 6px;
    }
    .hb-stance-current strong {
      color: #fff;
      font-weight: 600;
    }
    .hb-stance-current .hb-stance-peace { color: rgba(180, 220, 255, 0.95); }
    .hb-stance-current .hb-stance-melee { color: rgba(255, 180, 120, 0.95); }
    .hb-stance-current .hb-stance-ranged { color: rgba(255, 220, 120, 0.95); }
    .hb-stance-current .hb-stance-magic { color: rgba(200, 140, 255, 0.95); }
    .hb-stance-btn {
      width: 100%;
      padding: 8px 10px;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 4px;
      color: #fff;
      font-family: inherit;
      font-size: 13px;
      cursor: pointer;
      margin-top: 4px;
    }
    .hb-stance-btn:hover {
      background: rgba(255, 255, 255, 0.15);
      border-color: rgba(255, 255, 255, 0.35);
    }
    .hb-stance-hint {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.5);
      margin-top: 8px;
      line-height: 1.4;
    }
    /* P1-26 (cross-find gap-001): bar-icon tint reflects current combat
       mode. Retail toggles the dove between peaceful (cool tone) and
       combat-ready (warm tone) states via SetState on the gmFloaty-
       ToolbarUI's peace/combat button. We approximate with a filter
       tint until the real combat-mode sprite is extracted. */
    .hb-bar-icon[data-stance="peace"]  img { filter: drop-shadow(0 0 2px rgba(120, 200, 255, 0.45)); }
    .hb-bar-icon[data-stance="melee"]  img { filter: drop-shadow(0 0 2px rgba(255, 140, 80,  0.55)) hue-rotate(-25deg); }
    .hb-bar-icon[data-stance="ranged"] img { filter: drop-shadow(0 0 2px rgba(255, 200, 80,  0.55)) hue-rotate(-15deg); }
    .hb-bar-icon[data-stance="magic"]  img { filter: drop-shadow(0 0 2px rgba(200, 140, 255, 0.55)) hue-rotate(45deg); }
  `;
  document.head.appendChild(style);
}

// MotionStance low words (ACE.Entity/Enum/MotionStance.cs). HUD overhaul
// 2026-10-05: 0x45 TwoHandedStaffCombat added to the melee set — it was
// missing, so a two-handed-staff wielder classified as "other".
const MELEE_STANCES = new Set([0x003c, 0x003e, 0x0040, 0x0044, 0x0045, 0x0046]);
const RANGED_STANCES = new Set([0x003f, 0x0041, 0x0043, 0x0047, 0x00e8, 0x00e9, 0x013b, 0x013c]);

export function classifyStance(low) {
  if (low === 0x003d) return "peace";
  if (low === 0x0049) return "magic";
  if (RANGED_STANCES.has(low)) return "ranged";
  if (MELEE_STANCES.has(low)) return "melee";
  return "other";
}

// ── Toolbar combat-mode button (HUD overhaul 2026-10-05) ─────────────
// Retail COMBAT_MODE (acclient.h `enum COMBAT_MODE`): the toolbar shows
// exactly one of four 55×58 buttons — gmToolbarUI::RecvNotice_SetCombatMode
// (acclient.c) sets 0x10000192 visible iff mode==1, 0x10000193 iff 2,
// 0x10000194 iff 4, 0x10000195 iff 8. Each button has a Normal and a
// Normal_pressed sprite (data/retail-layouts/0x21000016.json). Clicking
// any of them is ClientCombatSystem::ToggleCombatMode
// (gmToolbarUI::ListenToElementMessage).
export const COMBAT_MODE = Object.freeze({
  NONCOMBAT: 1,
  MELEE: 2,
  MISSILE: 4,
  MAGIC: 8,
});

export const STANCE_BUTTONS = Object.freeze({
  1: Object.freeze({ elementId: 0x10000192, label: "Peace Mode",   normal: "0x06004CEC", pressed: "0x06004CED" }),
  2: Object.freeze({ elementId: 0x10000193, label: "Melee Mode",   normal: "0x06004CEE", pressed: "0x06004CEF" }),
  4: Object.freeze({ elementId: 0x10000194, label: "Missile Mode", normal: "0x06004CF0", pressed: "0x06004CF1" }),
  8: Object.freeze({ elementId: 0x10000195, label: "Magic Mode",   normal: "0x06004CF2", pressed: "0x06004CF3" }),
});

/** MotionStance low word → retail COMBAT_MODE. 0 (no UpdateMotion seen
 *  yet) and NonCombat read as Peace; any non-peace stance that is not
 *  magic or missile reads as Melee (ACE only has those four modes). */
export function combatModeForStance(low) {
  const l = (low >>> 0) & 0xffff;
  if (!l) return COMBAT_MODE.NONCOMBAT;
  const kind = classifyStance(l);
  if (kind === "peace") return COMBAT_MODE.NONCOMBAT;
  if (kind === "magic") return COMBAT_MODE.MAGIC;
  if (kind === "ranged") return COMBAT_MODE.MISSILE;
  return COMBAT_MODE.MELEE;
}

/** Button descriptor for a COMBAT_MODE; unknown values fall back to Peace. */
export function stanceButtonFor(mode) {
  return STANCE_BUTTONS[mode] || STANCE_BUTTONS[COMBAT_MODE.NONCOMBAT];
}

/** Tooltip copy for the toolbar combat-mode button. */
export function stanceButtonTip(mode, key = "`") {
  const b = stanceButtonFor(mode);
  const verb = (mode === COMBAT_MODE.NONCOMBAT || !STANCE_BUTTONS[mode])
    ? "Click to enter combat"
    : "Click to return to peace";
  return { text: b.label, key, sub: verb };
}

export const manifest = {
  id: "stance-toggle",
  name: "Combat Stance",
  icon: "⚐",
  // Retail dove (peace) sprite. activate() can flip to the combat-state
  // sprite by re-rendering the icon when CombatMode changes — bar.js's
  // makeIcon picks up `slot.iconSprite` once on mount; for cross-mode
  // swap we'll wire a `setIconSprite()` call in a follow-on.
  iconSprite: "0x0600111E",
  version: "0.1.0",
  // HUD overhaul 2026-10-05: the on-screen combat-mode button lives in the
  // unified toolbar (plugins/target-bar.js → plugins/hotbar.js) and reads
  // the COMBAT_MODE / STANCE_BUTTONS helpers exported above.
  description: "Combat-mode helpers for the toolbar stance button + bar-icon stance tint",
};

export function activate(bodyEl, ctx) {
  ensureStyles();
  const client = ctx?.client ?? window.__pluginClient ?? null;

  const currentEl = document.createElement("div");
  currentEl.className = "hb-stance-current";
  bodyEl.appendChild(currentEl);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "hb-stance-btn";
  bodyEl.appendChild(btn);

  const hint = document.createElement("div");
  hint.className = "hb-stance-hint";
  hint.textContent =
    "Peace mode lets you trade, craft, and heal more reliably. Combat mode increases defense. ACE derives the sub-mode (melee / missile / magic) from the weapon in hand.";
  bodyEl.appendChild(hint);

  function render() {
    const low = (typeof window.__getCurrentStanceLow === "function")
      ? window.__getCurrentStanceLow()
      : 0x003d;
    const label = (typeof window.__getCurrentStanceLabel === "function")
      ? window.__getCurrentStanceLabel()
      : `0x${low.toString(16)}`;
    const kind = classifyStance(low);

    currentEl.innerHTML = "";
    currentEl.appendChild(document.createTextNode("Current stance: "));
    const strong = document.createElement("strong");
    strong.className = `hb-stance-${kind}`;
    strong.textContent = label;
    currentEl.appendChild(strong);

    const isPeace = kind === "peace";
    btn.textContent = isPeace ? "Enter Combat Mode" : "Leave Combat Mode";
  }

  btn.addEventListener("click", () => {
    try {
      client?.player?.toggleCombatMode?.();
    } catch (e) {
      console.warn(`[stance-toggle] toggle failed: ${e?.message ?? e}`);
    }
    // Render speculatively; the real update lands when ACE responds and
    // the kind=5 motion event fires applyConfirmedStance.
    setTimeout(render, 250);
  });

  // Re-render on stats-updated (stance changes ride that channel).
  let statsHandler = null;
  if (client?.events?.on) {
    statsHandler = () => render();
    client.events.on("playerStatsUpdated", statsHandler);
  }

  render();

  return () => {
    if (statsHandler && client?.events?.off) {
      client.events.off("playerStatsUpdated", statsHandler);
    }
  };
}

// P1-26 (cross-find gap-001): bar-icon mode swap. Mount-time hook (runs
// independently of the panel's activate() so the dove tint stays
// up-to-date even when the user never opens the panel). Subscribes to
// playerStatsUpdated and writes `data-stance="peace|melee|ranged|magic"`
// onto the bar icon button; CSS above takes it from there.
export function mount(ctx) {
  const client = ctx?.client ?? window.__pluginClient ?? null;
  ensureStyles();

  function applyStanceToBarIcon() {
    const low = (typeof window.__getCurrentStanceLow === "function")
      ? window.__getCurrentStanceLow()
      : 0x003d;
    const kind = classifyStance(low);
    // R5 (BAND-C1): stance-toggle is BAR_SLOT_SUPPRESS-ed into combat-bar, so
    // the bar icon carries data-plugin-id="combat-bar" (bar.js sets it from
    // slot.id), not "stance-toggle" — the old selector matched nothing.
    const btn = document.querySelector('.hb-bar-icon[data-plugin-id="combat-bar"]');
    if (btn) btn.dataset.stance = kind;
  }
  // First apply on next animation frame so bar.js has built the icon.
  requestAnimationFrame(applyStanceToBarIcon);
  let statsHandler = null;
  if (client?.events?.on) {
    statsHandler = applyStanceToBarIcon;
    client.events.on("playerStatsUpdated", statsHandler);
  }
  return () => {
    if (statsHandler && client?.events?.off) {
      client.events.off("playerStatsUpdated", statsHandler);
    }
  };
}

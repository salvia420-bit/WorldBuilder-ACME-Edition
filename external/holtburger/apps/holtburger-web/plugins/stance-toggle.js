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
  `;
  document.head.appendChild(style);
}

const MELEE_STANCES = new Set([0x003c, 0x003e, 0x0040, 0x0044, 0x0046]);
const RANGED_STANCES = new Set([0x003f, 0x0041, 0x0043, 0x0047, 0x00e8, 0x00e9, 0x013b, 0x013c]);

function classifyStance(low) {
  if (low === 0x003d) return "peace";
  if (low === 0x0049) return "magic";
  if (RANGED_STANCES.has(low)) return "ranged";
  if (MELEE_STANCES.has(low)) return "melee";
  return "other";
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
  version: "0.0.1",
  description: "Peace ↔ Combat toggle (retail dove icon equivalent)",
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

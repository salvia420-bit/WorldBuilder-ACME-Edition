// Target bar — port of retail gmToolbarUI (layout 0x21000016) middle
// rows: the 5-panel shortcut strip + the [Use | Target | Examine] row
// with Pack on the right. The existing plugins/hotbar.js renders only
// the bottom 9-slot row of gmToolbarUI; PR-KK adds the rest.
//
// Layout decoded via chorizite-dump-layout-tree on 0x21000016:
//   Row 1 (y=0,  h=27): 5 panel-shortcut buttons
//     0x10000197 Allegiance Panel  (sprite 0x0600111F / 0x06001121)
//     0x10000198 Spellbook Panel   (sprite 0x06001119 / 0x0600111B)
//     0x10000199 Attributes Panel  (sprite 0x06001122 / 0x06001124)
//     0x1000055A Map Panel         (sprite 0x060069AE / 0x060069AF)
//     0x1000019A Options Panel     (sprite 0x06001116 / 0x06001118)
//     + 4 combat-stance variants (0x10000192-195, sprites 0x06004CEC..F3)
//   Row 2 (y=27, h=31): action row
//     0x1000019D Use Selected      (sprite 0x06001129 N / 0x0600112A P / 0x0600120E G)
//     0x1000019E Target display    (140x31, sprite 0x06001126 frame + child icon/text)
//     0x100001A5 Examine Selected  (sprite 0x06001127 N / 0x06001128 P)
//   Right edge: 0x100001B1 Pack/Main-Pack 63x58 (sprite 0x06004CF7 N / 0x06004CF8 H)
//
// Wires per acclient.c:241593-241627 retail dispatch:
//   - Use Selected (0x1000019D)         → ItemHolder::UseObject(selectedID)
//                                          → wasm handle.useObject(guid)
//   - Examine Selected (0x100001A5)     → ClientUISystem::ExamineObject(selectedID)
//                                          → main-panel toggleView("examine", {guid})
//   - Combat toggle (0x10000192-5)      → ClientCombatSystem::ToggleCombatMode
//                                          → handle.setCombatMode(1=peace / 2=combat)
//   - Allegiance shortcut               → main-panel toggleView("allegiance")
//   - Spellbook shortcut                → main-panel toggleView("spellbook")
//   - Attributes shortcut               → main-panel toggleView("character")
//   - Map shortcut                      → main-panel toggleView("map")
//   - Options shortcut                  → main-panel toggleView("options")
//   - Pack (0x100001B1)                 → main-panel toggleView("inventory")
//
// Target name + selection state: polled at 4Hz from
// liveScene3d.entityManager.getSelectedTarget() (api.js coverage row
// 5 — `selectionChanged` bus event is MISSING; future PR replaces
// the poll). Name resolved via the JS entity-store lookup.

import { setAcText } from "../ui/ac_font.js";

const OVERLAY_ID = "hb-target-bar";
const STYLE_ID   = "hb-target-bar-style";
const SP = "./data/ui-sprites";

// Retail combat-mode enum mirror. Stays in sync with
// holtburger_common::CombatMode (NonCombat=0, Melee=1, Missile=2, Magic=3).
// Toolbar's peace/combat toggle flips NonCombat ↔ last-melee/missile-stance.
const COMBAT_MODE_NON_COMBAT = 1; // wasm setCombatMode arg for peace
const COMBAT_MODE_MELEE_DEFAULT = 2; // wasm setCombatMode arg for combat-ready

// Top-row sprite buttons in retail render order (acclient.c layout
// 0x21000016 read order — element IDs 197/198/199/055A/19A).
const TOP_BUTTONS = [
  { id: "allegiance", view: "allegiance", title: "Allegiance Panel", sprite: "0x0600111F", hover: "0x06001121" },
  { id: "spellbook",  view: "spellbook",  title: "Spellbook Panel",  sprite: "0x06001119", hover: "0x0600111B" },
  { id: "attributes", view: "character",  title: "Attributes Panel", sprite: "0x06001122", hover: "0x06001124" },
  { id: "map",        view: "map",        title: "Map Panel",        sprite: "0x060069AE", hover: "0x060069AF" },
  { id: "options",    view: "options",    title: "Options Panel",    sprite: "0x06001116", hover: "0x06001118" },
];

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      bottom: 46px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 49;
      width: 300px;
      pointer-events: auto;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    /* ─ Top row: 5 panel-shortcut sprites + combat stance ─ */
    #${OVERLAY_ID} .htb-top {
      display: flex;
      align-items: center;
      gap: 1px;
      height: 27px;
      background: rgba(20, 14, 8, 0.85);
      border: 1px solid var(--hb-border-brass-dim);
      padding: 0 2px;
    }
    #${OVERLAY_ID} .htb-panel-btn {
      width: 34px; height: 27px;
      background-position: center;
      background-size: contain;
      background-repeat: no-repeat;
      image-rendering: pixelated;
      border: 0; padding: 0; margin: 0;
      cursor: pointer;
      font-size: 0;
      filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.7));
      transition: filter 80ms;
    }
    #${OVERLAY_ID} .htb-panel-btn:hover { filter: brightness(1.4) drop-shadow(0 0 3px rgba(255, 220, 120, 0.55)); }
    #${OVERLAY_ID} .htb-stance-btn {
      width: 28px; height: 23px;
      margin-left: auto;
      background-position: center;
      background-size: contain;
      background-repeat: no-repeat;
      image-rendering: pixelated;
      border: 1px solid var(--hb-border-brass-dim);
      padding: 0;
      cursor: pointer;
      background-color: rgba(0, 0, 0, 0.45);
      font-size: 9px;
      color: var(--hb-text-cream);
    }
    #${OVERLAY_ID} .htb-stance-btn[data-mode="combat"] {
      background-image: url("${SP}/0x06004CEE.png");
      color: var(--hb-text-gold);
    }
    #${OVERLAY_ID} .htb-stance-btn[data-mode="peace"] {
      background-image: url("${SP}/0x06004CEC.png");
    }
    #${OVERLAY_ID} .htb-stance-btn:hover { filter: brightness(1.3); }

    /* ─ Action row: Use | Target | Examine | Pack ─ */
    #${OVERLAY_ID} .htb-action {
      display: flex;
      align-items: stretch;
      gap: 1px;
      height: 33px;
    }
    #${OVERLAY_ID} .htb-use,
    #${OVERLAY_ID} .htb-examine {
      width: 28px; height: 33px;
      background-position: center;
      background-size: contain;
      background-repeat: no-repeat;
      image-rendering: pixelated;
      border: 0; padding: 0;
      cursor: pointer;
      filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.7));
      transition: filter 80ms;
    }
    #${OVERLAY_ID} .htb-use { background-image: url("${SP}/0x06001129.png"); }
    #${OVERLAY_ID} .htb-use:hover,
    #${OVERLAY_ID} .htb-examine:hover {
      filter: brightness(1.4) drop-shadow(0 0 3px rgba(255, 220, 120, 0.55));
    }
    #${OVERLAY_ID} .htb-use:active { background-image: url("${SP}/0x0600112A.png"); }
    #${OVERLAY_ID} .htb-use[disabled],
    #${OVERLAY_ID} .htb-examine[disabled] {
      filter: grayscale(0.7) opacity(0.45);
      cursor: not-allowed;
    }
    #${OVERLAY_ID} .htb-use[disabled] { background-image: url("${SP}/0x0600120E.png"); }
    #${OVERLAY_ID} .htb-examine { background-image: url("${SP}/0x06001127.png"); }
    #${OVERLAY_ID} .htb-examine:active { background-image: url("${SP}/0x06001128.png"); }
    #${OVERLAY_ID} .htb-pack {
      width: 40px; height: 33px;
      background-image: url("${SP}/0x06004CF7.png");
      background-position: center;
      background-size: contain;
      background-repeat: no-repeat;
      image-rendering: pixelated;
      border: 0; padding: 0;
      cursor: pointer;
      filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.7));
      transition: filter 80ms;
    }
    #${OVERLAY_ID} .htb-pack:hover {
      background-image: url("${SP}/0x06004CF8.png");
      filter: brightness(1.2);
    }
    #${OVERLAY_ID} .htb-target {
      flex: 1 1 auto;
      min-width: 0;
      height: 33px;
      background: rgba(20, 14, 8, 0.85);
      border: 1px solid var(--hb-border-brass-dim);
      display: flex;
      align-items: center;
      padding: 0 6px;
      gap: 6px;
      font-size: 11px;
      color: var(--hb-text-cream);
      overflow: hidden;
    }
    #${OVERLAY_ID} .htb-target.empty {
      color: var(--hb-text-muted-3);
      font-style: italic;
      justify-content: center;
    }
    #${OVERLAY_ID} .htb-target-name {
      flex: 1 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--hb-text-gold);
      font-weight: 600;
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.85);
    }
    #${OVERLAY_ID} .htb-target-meta {
      flex: 0 0 auto;
      font-size: 9px;
      color: var(--hb-text-muted-2);
    }
  `;
  document.head.appendChild(s);
}

// Module state.
let state = {
  overlayEl: null,
  selectedGuid: 0,
  selectedName: "",
  inCombat: false,
};

function lookupEntityName(guid) {
  if (!guid) return null;
  const handle = window.__sessionHandle;
  // Try wasm entity store first (most authoritative).
  try {
    const ent = handle?.entityByGuid?.(guid >>> 0);
    if (ent?.name) return ent.name;
  } catch {}
  // Fallback: scene3d's nameplate cache.
  try {
    const em = window.liveScene3d?.entityManager;
    const e = em?.entityMap?.get(guid >>> 0);
    if (e?.name) return e.name;
  } catch {}
  return null;
}

function getSelectedTargetGuid() {
  try {
    const em = window.liveScene3d?.entityManager;
    return (em?.getSelectedTarget?.() ?? 0) >>> 0;
  } catch { return 0; }
}

function renderTarget() {
  const ov = state.overlayEl;
  if (!ov) return;
  const guid = state.selectedGuid;
  const name = state.selectedName;
  const targetEl = ov.querySelector(".htb-target");
  if (!guid) {
    targetEl.classList.add("empty");
    setAcText(targetEl, "— no target —");
  } else {
    targetEl.classList.remove("empty");
    targetEl.innerHTML = "";
    const nameEl = document.createElement("span");
    nameEl.className = "htb-target-name";
    setAcText(nameEl, name || `Entity 0x${guid.toString(16).toUpperCase().padStart(8, "0")}`);
    targetEl.appendChild(nameEl);
    const meta = document.createElement("span");
    meta.className = "htb-target-meta";
    setAcText(meta, `0x${guid.toString(16).toUpperCase().padStart(8, "0")}`);
    targetEl.appendChild(meta);
  }
  // Enable / disable use + examine based on target presence.
  ov.querySelector(".htb-use").disabled = !guid;
  ov.querySelector(".htb-examine").disabled = !guid;
}

function renderStance() {
  const ov = state.overlayEl;
  if (!ov) return;
  const btn = ov.querySelector(".htb-stance-btn");
  if (!btn) return;
  btn.dataset.mode = state.inCombat ? "combat" : "peace";
  btn.title = state.inCombat ? "Combat Mode — click for Peace" : "Peace Mode — click for Combat";
}

function build() {
  const ov = document.createElement("div");
  ov.id = OVERLAY_ID;

  // ── Top row — 5 panel shortcuts + combat-stance toggle ─────
  const top = document.createElement("div");
  top.className = "htb-top";
  for (const b of TOP_BUTTONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "htb-panel-btn";
    btn.dataset.id = b.id;
    btn.title = b.title;
    btn.style.backgroundImage = `url("${SP}/${b.sprite}.png")`;
    btn.addEventListener("mouseenter", () => {
      btn.style.backgroundImage = `url("${SP}/${b.hover}.png")`;
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.backgroundImage = `url("${SP}/${b.sprite}.png")`;
    });
    btn.addEventListener("click", () => {
      window.__mainPanel?.toggleView?.(b.view);
    });
    top.appendChild(btn);
  }
  const stance = document.createElement("button");
  stance.type = "button";
  stance.className = "htb-stance-btn";
  stance.dataset.mode = "peace";
  stance.title = "Peace / Combat Mode";
  stance.addEventListener("click", () => {
    const handle = window.__sessionHandle;
    if (!handle) return;
    // Read authoritative current stance from window.__getCurrentStanceLow()
    // (same source combat-bar uses). `world.player.combat_mode` is
    // unreliable as a source per combat-bar.js:393-403; the
    // motion-table-applied stance from kind=5 UpdateMotion is the
    // truth. Toggle: !Peace → NonCombat(1); Peace → Melee(2).
    let inCombatNow = state.inCombat;
    try {
      const stanceLow = (typeof window.__getCurrentStanceLow === "function")
        ? window.__getCurrentStanceLow()
        : 0;
      // Low 16 bits: Peace = 0x3D (61) per MotionStance; non-zero
      // non-peace values mean combat stance. Treat any non-peace
      // motion-stance as in-combat for toggle purposes.
      // See plugins/combat-bar.js stanceWord() for the full table.
      inCombatNow = stanceLow !== 0 && stanceLow !== 0x3D;
    } catch {}
    const next = inCombatNow ? COMBAT_MODE_NON_COMBAT : COMBAT_MODE_MELEE_DEFAULT;
    try {
      if (typeof handle.setCombatMode === "function") {
        handle.setCombatMode(next);
      } else if (typeof handle.toggleCombatMode === "function") {
        handle.toggleCombatMode();
      }
      // Optimistic flip; the 500ms poll will reconcile from
      // __getCurrentStanceLow when the server confirms.
      state.inCombat = !inCombatNow;
      renderStance();
    } catch (e) {
      console.warn("[target-bar] combat-mode toggle failed", e);
    }
  });
  top.appendChild(stance);
  ov.appendChild(top);

  // ── Action row — Use | Target | Examine | Pack ─────────────
  const action = document.createElement("div");
  action.className = "htb-action";

  const useBtn = document.createElement("button");
  useBtn.type = "button";
  useBtn.className = "htb-use";
  useBtn.title = "Use Selected";
  useBtn.addEventListener("click", () => {
    const handle = window.__sessionHandle;
    if (!handle?.useObject || !state.selectedGuid) return;
    try {
      handle.useObject(state.selectedGuid >>> 0);
    } catch (e) {
      console.warn("[target-bar] useObject failed", e);
    }
  });
  action.appendChild(useBtn);

  const target = document.createElement("div");
  target.className = "htb-target empty";
  setAcText(target, "— no target —");
  // Click-target = examine for convenience (mirrors retail behavior).
  target.addEventListener("click", () => {
    if (!state.selectedGuid) return;
    window.__mainPanel?.toggleView?.("examine", {
      guid: state.selectedGuid,
      name: state.selectedName,
      fromEntity: true,
    });
  });
  action.appendChild(target);

  const examineBtn = document.createElement("button");
  examineBtn.type = "button";
  examineBtn.className = "htb-examine";
  examineBtn.title = "Examine Selected";
  examineBtn.addEventListener("click", () => {
    if (!state.selectedGuid) return;
    window.__mainPanel?.toggleView?.("examine", {
      guid: state.selectedGuid,
      name: state.selectedName,
      fromEntity: true,
    });
  });
  action.appendChild(examineBtn);

  const packBtn = document.createElement("button");
  packBtn.type = "button";
  packBtn.className = "htb-pack";
  packBtn.title = "Inventory Panel";
  packBtn.addEventListener("click", () => {
    window.__mainPanel?.toggleView?.("inventory");
  });
  action.appendChild(packBtn);

  ov.appendChild(action);
  document.body.appendChild(ov);
  return ov;
}

export const manifest = {
  id: "target-bar",
  name: "Target Bar",
  icon: "⊙",
  iconHidden: true,
  version: "0.1.0",
  description: "Retail gmToolbarUI middle rows — 5 panel shortcuts + Use/Target/Examine + Pack",
};

export function mount(_ctx) {
  ensureStyles();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
  state.overlayEl = build();

  // Poll selection state at 4Hz (selectionChanged bus event is MISSING
  // per api.js coverage row 5; future PR replaces the poll).
  const selTimer = setInterval(() => {
    const next = getSelectedTargetGuid();
    if (next !== state.selectedGuid) {
      state.selectedGuid = next;
      state.selectedName = next ? (lookupEntityName(next) || "") : "";
      renderTarget();
    } else if (next && !state.selectedName) {
      // Late-name resolution: name may land after selection.
      const n = lookupEntityName(next);
      if (n) {
        state.selectedName = n;
        renderTarget();
      }
    }
  }, 250);

  // Stance state derives from the authoritative motion-table stance
  // (window.__getCurrentStanceLow — updated by applyConfirmedStance
  // on every kind=5 UpdateMotion). Low 16 bits == 0x3D = Peace;
  // anything else non-zero = in combat. Poll at 2Hz; cheap.
  const stanceTimer = setInterval(() => {
    let inCombat = state.inCombat;
    try {
      const stanceLow = (typeof window.__getCurrentStanceLow === "function")
        ? window.__getCurrentStanceLow()
        : 0;
      inCombat = stanceLow !== 0 && stanceLow !== 0x3D;
    } catch {}
    if (inCombat !== state.inCombat) {
      state.inCombat = inCombat;
      renderStance();
    }
  }, 500);

  renderTarget();
  renderStance();

  return () => {
    clearInterval(selTimer);
    clearInterval(stanceTimer);
    if (state.overlayEl) {
      state.overlayEl.remove();
      state.overlayEl = null;
    }
  };
}

// Target bar — port of retail gmToolbarUI (layout 0x21000016) middle
// rows: the panel-shortcut strip + the [Use | Target | Examine] row
// with Pack on the right. The existing plugins/hotbar.js renders only
// the bottom 9-slot row of gmToolbarUI; PR-KK adds the rest.
//
// Layout decoded via target_bar_layout_dump (2026-05-24) — root
// 0x10000191 is 300×122; panel-shortcut + action elements live inside:
//   Row 1 (y=0,  h=27): 6 panel-shortcut buttons
//     0x10000192-195 combat-stance variants (mutually exclusive,
//                    each 55×58 at x=0, spans rows 1+2 — left edge)
//     0x10000196 separator (55,0) 7×27
//     (retail names per elementIdName in retail-layouts/0x21000016.json)
//     0x10000197 PanelButton_Social           (55,0)  35×27  (0x0600111F / 0x06001121)
//     0x10000198 PanelButton_Magic            (85,0)  34×27  (0x06001119 / 0x0600111B)
//     0x10000199 PanelButton_SkillManagement  (115,0) 34×27  (0x06001122 / 0x06001124)
//     0x1000055A PanelButton_QuestManagement  (145,0) 34×27  (0x060069AE / 0x060069AF — quill)
//     0x1000019A PanelButton_World            (175,0) 34×27  (0x06001116 / 0x06001118 — compass rose)
//     0x1000019B PanelButton_Options          (204,0) 39×27  (0x0600111C / 0x0600111E)
//     0x1000019C separator         (236,0) 10×27
//   Row 2 (y=27, h=31): action row
//     0x1000019D Use Selected      (55,27)  23×31  (sprite 0x06001129 N / 0x0600112A P / 0x0600120E G)
//     0x1000019E Target display    (78,27)  140×31 (sprite 0x06001126 frame + child icon/text)
//     0x100001A5 Examine Selected  (218,27) 22×31  (sprite 0x06001127 N / 0x06001128 P)
//   Right edge: 0x100001B1 Pack/Main-Pack (238,0) 63×58 (sprite 0x06004CF7 N / 0x06004CF8 H)
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
import { loadLayout, findElementById, getCachedLayout } from "../ui/ac_layout.js";
import { suggestedCombatModeFromInventory } from "./inventory_helpers.js";

/** gmToolbarUI — retail layout that drives the target-bar middle rows.
 *  Element-id map confirmed by target_bar_layout_dump 2026-05-24.
 *  Positions are relative to the root 0x10000191 (300×122 panel). */
const TARGET_BAR_LAYOUT_ID = 0x21000016;
const TB_ELEMS = {
  stance:     0x10000192, // 4 stance variants (192-195) all share (0,0) 55×58
  allegiance: 0x10000197, //  (55, 0)  35×27
  spellbook:  0x10000198, //  (85, 0)  34×27
  attributes: 0x10000199, //  (115,0)  34×27
  map:        0x1000055A, //  (145,0)  34×27
  options:    0x1000019A, //  (175,0)  34×27
  use:        0x1000019D, //  (55, 27) 23×31
  target:     0x1000019E, //  (78, 27) 140×31
  examine:    0x100001A5, //  (218,27) 22×31
  pack:       0x100001B1, //  (238,0)  63×58
};

const OVERLAY_ID = "hb-target-bar";
const STYLE_ID   = "hb-target-bar-style";
const SP = "./data/ui-sprites";

// Retail combat-mode enum mirror. Stays in sync with
// holtburger_common::CombatMode (NonCombat=0, Melee=1, Missile=2, Magic=3).
// Toolbar's peace/combat toggle flips NonCombat ↔ last-melee/missile-stance.
const COMBAT_MODE_NON_COMBAT = 1; // wasm setCombatMode arg for peace
const COMBAT_MODE_MELEE_DEFAULT = 2; // wasm setCombatMode arg for combat-ready

// P1-31 (cross-find gap-025): 9-icon panel strip. The first 6 wear the
// retail gmToolbarUI button sprite pairs (normal/hover), assigned by
// the layout dump's elementIdNames — see the header table. Retail
// semantics: Social→allegiance, Magic→spellbook, SkillManagement→
// attributes (Character Info), QuestManagement→journal, World→map,
// Options→options. The last 3 views have no retail toolbar
// counterpart; they wear retail art that reads at strip size: the
// Pack sprite (inventory — same view the Pack button opens), an open
// tome 0x06004CFB (train-skills), and the paired-heads chat sprites
// 0x06001366/67 (fellowship).
// NOTE: these render as CSS background-image — a bad sprite path
// shows a blank button (no <img>-style onerror fallback fires here).
const TOP_BUTTONS = [
  { id: "allegiance", view: "allegiance",   title: "Allegiance Panel", sprite: "0x0600111F", hover: "0x06001121" },
  { id: "spellbook",  view: "spellbook",    title: "Spellbook Panel",  sprite: "0x06001119", hover: "0x0600111B" },
  { id: "attributes", view: "character",    title: "Attributes Panel", sprite: "0x06001122", hover: "0x06001124" },
  { id: "journal",    view: "journal",      title: "Journal Panel",    sprite: "0x060069AE", hover: "0x060069AF" },
  { id: "map",        view: "map",          title: "Map Panel",        sprite: "0x06001116", hover: "0x06001118" },
  { id: "options",    view: "options",      title: "Options Panel",    sprite: "0x0600111C", hover: "0x0600111E" },
  { id: "inventory",  view: "inventory",    title: "Inventory Panel",  sprite: "0x06004CF7", hover: "0x06004CF8" },
  { id: "skills",     view: "train-skills", title: "Skills Panel",     sprite: "0x06004CFB", hover: "0x06004CFB" },
  { id: "fellowship", view: "fellowship",   title: "Fellowship Panel", sprite: "0x06001366", hover: "0x06001367" },
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
      height: 58px;
      pointer-events: auto;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      /* Layout-driven: row 1 (.htb-top) + row 2 (.htb-action) +
         stance/pack overlap both rows via absolute positioning. */
    }
    /* ─ Top row: 9 panel-shortcut sprites + combat stance ─
       P1-31 (cross-find gap-025): expanded from the retail-DAT-driven
       5 to a 9-icon strip. Flex layout because applyTargetBarLayout's
       per-element absolute positions only cover the retail 6 — the
       trailing icons need a self-distributing container. The padding
       carves out the stance (0..55) and Pack (238..300) footprints —
       both span rows 1+2 as absolute overlay children — while the
       background/border still back the full 300px row. */
    #${OVERLAY_ID} .htb-top {
      position: absolute;
      top: 0;
      left: 0;
      width: 300px;
      height: 27px;
      box-sizing: border-box;
      padding: 0 62px 0 55px;
      background: rgba(20, 14, 8, 0.85);
      border: 1px solid var(--hb-border-brass-dim);
      display: flex;
      align-items: center;
      gap: 1px;
    }
    #${OVERLAY_ID} .htb-panel-btn {
      /* 9 buttons share the 183px between the stance and Pack
         footprints (~20px each) — flex-distributed, not fixed-width,
         so none of them lands under those two overlay children. */
      flex: 1 1 0;
      width: auto; min-width: 0; height: 25px;
      background-position: center;
      background-size: contain;
      background-repeat: no-repeat;
      image-rendering: pixelated;
      border: 0; padding: 0; margin: 0;
      cursor: pointer;
      font-size: 0;
      filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.7));
      transition: filter 80ms;
      position: static;
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
      position: absolute;
      top: 27px;
      left: 0;
      width: 300px;
      height: 31px;
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
    /* F10-1 — selected target health bar. */
    #${OVERLAY_ID} .htb-target-health {
      flex: 1 1 auto;
      min-width: 40px;
      height: 6px;
      margin-left: 6px;
      border: 1px solid rgba(0, 0, 0, 0.6);
      border-radius: 3px;
      background: rgba(0, 0, 0, 0.45);
      overflow: hidden;
    }
    #${OVERLAY_ID} .htb-target-health-fill {
      height: 100%;
      transition: width 180ms ease-out, background 180ms ease-out;
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
  // F10-1 — selected target's health fraction in [0,1], or null until the
  // QueryHealth reply (EntityHealthUpdated) arrives.
  selectedHealth: null,
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
    // F10-1 — selected target's health bar. Hidden until the QueryHealth
    // reply lands (state.selectedHealth != null); shrinks as you damage it.
    const frac = state.selectedHealth;
    if (frac != null && Number.isFinite(frac)) {
      const bar = document.createElement("div");
      bar.className = "htb-target-health";
      const fill = document.createElement("div");
      fill.className = "htb-target-health-fill";
      const pct = Math.max(0, Math.min(1, frac)) * 100;
      fill.style.width = `${pct.toFixed(1)}%`;
      // Green → yellow → red as health drops (hue 0=red .. 120=green).
      fill.style.background = `hsl(${(pct * 1.2).toFixed(0)}, 70%, 45%)`;
      bar.appendChild(fill);
      bar.title = `${pct.toFixed(0)}% health`;
      targetEl.appendChild(bar);
    }
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
  // Refs we hand to applyTargetBarLayout — one per layout-positioned element.
  const refs = { panelBtns: {} };

  // ── Top row — 9 panel shortcuts + combat-stance toggle ─────
  const top = document.createElement("div");
  top.className = "htb-top";
  refs.topRow = top;
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
    refs.panelBtns[b.id] = btn;
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
    // Leaving Peace: pick the mode from the equipped weapon (Missile/
    // Magic/Melee) so bow- and wand-wielders enter combat instead of a
    // hardcoded Melee that ACE silently reverts (F11-1).
    let suggested = COMBAT_MODE_MELEE_DEFAULT;
    try {
      const inv = typeof handle.playerInventory === "function" ? handle.playerInventory() : [];
      suggested = suggestedCombatModeFromInventory(inv);
    } catch {}
    const next = inCombatNow ? COMBAT_MODE_NON_COMBAT : suggested;
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
  refs.stanceBtn = stance;
  ov.appendChild(top);

  // ── Action row — Use | Target | Examine | Pack ─────────────
  const action = document.createElement("div");
  action.className = "htb-action";
  refs.actionRow = action;

  const useBtn = document.createElement("button");
  useBtn.type = "button";
  useBtn.className = "htb-use";
  useBtn.title = "Use Selected";
  useBtn.addEventListener("click", () => {
    const handle = window.__sessionHandle;
    if (!handle?.useObject || !state.selectedGuid) return;
    const guid = state.selectedGuid >>> 0;
    try {
      handle.useObject(guid);
    } catch (e) {
      console.warn("[target-bar] useObject failed", e);
    }
    // HUD rec #180 (2026-06-16): if the target is a book (object-
    // description flag BOOK = 0x100), fan out a bookData() request so
    // the book-panel auto-opens once ACE's BookDataResponse lands.
    // ACE's Use handler on a book object only sends the action ack,
    // not the BookData payload — without this follow-up the book
    // overlay only opens from the debug entry. Cheap to issue on
    // non-books (server ignores BookData on non-book GUIDs).
    try {
      const em = window.liveScene3d?.entityManager;
      const ent = em?.entityMap?.get?.(guid);
      const objDescFlags = ((ent?.meta?.objDescFlags ?? ent?.objDescFlags) ?? 0) >>> 0;
      if ((objDescFlags & 0x100) !== 0 && handle.bookData) {
        handle.bookData(guid);
      }
    } catch (_) { /* book auto-open is best-effort */ }
  });
  action.appendChild(useBtn);
  refs.useBtn = useBtn;

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
  refs.targetEl = target;

  const examineBtn = document.createElement("button");
  examineBtn.type = "button";
  examineBtn.className = "htb-examine";
  examineBtn.title = "Examine Selected";
  examineBtn.addEventListener("click", () => {
    if (!state.selectedGuid) return;
    // Toggle: when the floaty is already open on the same target,
    // close it. Otherwise route through __showExamineFor so the
    // flag-gated floaty vs main-panel path (EX-03) is honored.
    if (window.__examineFloaty?.isOpen?.()) {
      window.__examineFloaty.close?.();
      return;
    }
    if (typeof window.__showExamineFor === "function") {
      window.__showExamineFor(state.selectedGuid, {
        name: state.selectedName,
        fromEntity: true,
      });
    } else {
      window.__mainPanel?.toggleView?.("examine", {
        guid: state.selectedGuid,
        name: state.selectedName,
        fromEntity: true,
      });
    }
  });
  action.appendChild(examineBtn);
  refs.examineBtn = examineBtn;

  const packBtn = document.createElement("button");
  packBtn.type = "button";
  packBtn.className = "htb-pack";
  packBtn.title = "Inventory Panel";
  packBtn.addEventListener("click", () => {
    window.__mainPanel?.toggleView?.("inventory");
  });
  action.appendChild(packBtn);
  refs.packBtn = packBtn;

  ov.appendChild(action);
  document.body.appendChild(ov);
  return { overlay: ov, refs };
}

// Apply gmToolbarUI 0x21000016 layout to the target-bar plugin's
// sub-elements. The retail layout uses absolute positioning within a
// 300×122 frame; we switch each row container to `position: relative`
// and each child to `position: absolute` with explicit x/y from the
// LayoutDesc. CSS centering and flex-gap behavior are overridden via
// `transform = "none"` (mirrors the radar pattern).
function applyTargetBarLayout(refs, attempt = 0) {
  const apply = (layout) => {
    // target-bar mounts during early boot via mountBar(); eor/local
    // shards may not yet be available. Retry every 2s up to 8 times.
    if (!layout) {
      if (attempt < 8) {
        setTimeout(() => applyTargetBarLayout(refs, attempt + 1), 2000);
      }
      return;
    }
    // Layout positions are relative to the root 0x10000191. Row 1
    // children have y=0; row 2 children have y=27; Pack spans
    // both rows at y=0,h=58. To keep the existing two-row DOM
    // structure (top + action), translate row 2's child y values
    // by -27 (subtract the row offset) — but we keep .htb-top at
    // height=27 + .htb-action at height=31, so the row layout
    // remains visually aligned.
    //
    // The Pack button is special: it's a row-1 sibling spanning
    // y=0..58, h=58, currently nested in .htb-action. We pop it
    // out of the action row and parent to the overlay so it can
    // overlap both rows. Done lazily here.
    let applied = 0;

    // Helper — apply x/y/w/h from a LayoutDesc element to a DOM ref,
    // wiping CSS-driven margin/centering so absolute coords win.
    // box-sizing: border-box so width/height match retail's outer box
    // including any CSS border/padding the existing styles applied.
    const applyEl = (el, desc, yOffset = 0) => {
      if (!el || !desc) return 0;
      el.style.position = "absolute";
      el.style.margin = "0";
      el.style.boxSizing = "border-box";
      // Explicit "none" overrides any CSS translate centering. Empty
      // string would let the cascade re-apply (per ac_layout.js gotcha).
      el.style.transform = "none";
      el.style.right = "";
      el.style.bottom = "";
      el.style.flex = "";
      if (typeof desc.x === "number") el.style.left = `${desc.x}px`;
      if (typeof desc.y === "number") el.style.top = `${desc.y - yOffset}px`;
      if (typeof desc.width === "number") el.style.width = `${desc.width}px`;
      if (typeof desc.height === "number") el.style.height = `${desc.height}px`;
      return 1;
    };

    // Both row containers are `position: absolute` per their CSS, so
    // they're already containing blocks for their absolutely-positioned
    // children AND removed from flow (so they don't push each other
    // down). We don't touch position here — only clear any padding/gap
    // P1-31 (cross-find gap-025): the top row is flex-distributed now
    // so the 9 panel icons + stance share the 300px width. Don't
    // clobber the flex gap/padding the CSS sets, and don't
    // applyEl-position the 5 retail icons (would absolute-position
    // them and break flow for the 4 new ones).
    if (refs.actionRow) {
      refs.actionRow.style.padding = "0";
      refs.actionRow.style.gap = "0";
    }

    // Stance button — retail places this at (0,0) 55×58 spanning rows
    // 1+2 on the LEFT. Our hand-tuned panel has stance on the right.
    // Retail-faithful position is more semantically meaningful (the
    // stance is mode-defining), but disrupts the top row's flow. Wire
    // it to the retail x=0,y=0 with retail size 55×58. Since stance
    // lives inside .htb-top (h=27), we'll detach + re-parent to overlay
    // so it can span both rows. Stays inside refs map for restyling.
    const stanceDesc = findElementById(layout, TB_ELEMS.stance);
    if (refs.stanceBtn && stanceDesc) {
      // Re-parent to overlay so it can span both rows.
      if (refs.stanceBtn.parentElement !== refs.overlay && refs.overlay) {
        refs.overlay.appendChild(refs.stanceBtn);
      }
      refs.stanceBtn.style.marginLeft = "";
      applied += applyEl(refs.stanceBtn, stanceDesc);
    }

    // Row 2 — Use | Target | Examine. Layout y=27 but .htb-action is
    // already at its own row anchor, so subtract 27 to get inner y=0.
    applied += applyEl(refs.useBtn,     findElementById(layout, TB_ELEMS.use),     27);
    applied += applyEl(refs.targetEl,   findElementById(layout, TB_ELEMS.target),  27);
    applied += applyEl(refs.examineBtn, findElementById(layout, TB_ELEMS.examine), 27);

    // Pack — retail says (238,0) 63×58 spanning both rows. Re-parent
    // out of .htb-action to the overlay so it can overlap.
    const packDesc = findElementById(layout, TB_ELEMS.pack);
    if (refs.packBtn && packDesc) {
      if (refs.packBtn.parentElement !== refs.overlay && refs.overlay) {
        refs.overlay.appendChild(refs.packBtn);
      }
      applied += applyEl(refs.packBtn, packDesc);
    }

    try {
      window.__diag?.layout?.onTargetBarApplied?.({ applied });
    } catch (_) {}
  };
  const cached = getCachedLayout(TARGET_BAR_LAYOUT_ID);
  if (cached) { apply(cached); return; }
  loadLayout(TARGET_BAR_LAYOUT_ID).then(apply).catch(() => {});
}

export const manifest = {
  id: "target-bar",
  name: "Target Bar",
  icon: "⊙",
  iconHidden: true,
  version: "0.1.0",
  description: "Retail gmToolbarUI middle rows — 9 panel shortcuts + Use/Target/Examine + Pack",
};

export function mount(_ctx) {
  ensureStyles();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
  const { overlay, refs } = build();
  state.overlayEl = overlay;
  // Stash overlay on refs so applyTargetBarLayout can re-parent
  // stance + Pack to it (they span both rows).
  refs.overlay = overlay;

  // Apply retail layout positions for sub-elements (5 panel shortcuts
  // + Use/Target/Examine + Pack + stance). Mounts via mountBar() so
  // includes the 8 × 2s retry loop for early-boot eor/local shards.
  applyTargetBarLayout(refs);

  // P3-41 — drive selection + stance off the bus (selectionChanged for
  // target, playerStatsUpdated for stance). Keep a low-frequency timer
  // (1Hz) ONLY as a backstop for late-name resolution and event-drop
  // recovery; the previous 4Hz/2Hz polls were the primary loop.
  const updateSelection = (nextOverride) => {
    const next = (nextOverride != null) ? (nextOverride >>> 0) : getSelectedTargetGuid();
    if (next !== state.selectedGuid) {
      state.selectedGuid = next;
      state.selectedName = next ? (lookupEntityName(next) || "") : "";
      // F10-1 — new target: clear the stale health bar and ask the server
      // for this target's current health fraction (reply arrives as the
      // `entityHealthUpdated` bus event). Deselect (next===0) just clears.
      //
      // HUD rec #98 — there is a latency window between queryHealth() and
      // the UpdateHealth reply. If the target dies / heals / gets
      // damage_taken'd inside that window, the reply may carry a stale
      // fraction. Follow-up: when ACE's UpdateHealth carries a timestamp,
      // gate cache invalidation on it; for now the next bus event resyncs.
      state.selectedHealth = null;
      if (next) {
        try { window.__sessionHandle?.queryHealth?.(next); } catch (_) {}
      }
      renderTarget();
    } else if (next && !state.selectedName) {
      const n = lookupEntityName(next);
      if (n) {
        state.selectedName = n;
        renderTarget();
      }
    }
  };
  const updateStance = () => {
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
  };
  const onSelectionChanged = (ev) => {
    const guid = (ev?.detail?.guid ?? 0) >>> 0;
    updateSelection(guid);
  };
  // F10-1 — selected target's health changed (QueryHealth reply / damage
  // broadcast). Update the bar only when it's for the current target.
  const onEntityHealth = (ev) => {
    const d = ev?.detail ?? ev ?? {};
    const guid = (d.guid ?? 0) >>> 0;
    if (!guid || guid !== state.selectedGuid) return;
    const f = d.fraction;
    state.selectedHealth = Number.isFinite(f) ? f : null;
    renderTarget();
  };
  const onStatsUpdated = () => updateStance();
  const pc = window.__pluginClient ?? null;
  let pcSubscribed = false;
  if (pc?.events?.on) {
    pc.events.on("selectionChanged", onSelectionChanged);
    pc.events.on("playerStatsUpdated", onStatsUpdated);
    pc.events.on("entityHealthUpdated", onEntityHealth);
    pcSubscribed = true;
  } else if (window.__pluginClientReady?.then) {
    window.__pluginClientReady.then((client) => {
      if (client?.events?.on) {
        client.events.on("selectionChanged", onSelectionChanged);
        client.events.on("playerStatsUpdated", onStatsUpdated);
        client.events.on("entityHealthUpdated", onEntityHealth);
        pcSubscribed = true;
      }
    });
  }
  // Backstop — 1Hz catches late-name resolution + recovers from any
  // dropped bus event.
  const fallbackTimer = setInterval(() => { updateSelection(); updateStance(); }, 1000);

  renderTarget();
  renderStance();

  return () => {
    clearInterval(fallbackTimer);
    const pcEnd = window.__pluginClient ?? null;
    if (pcSubscribed && pcEnd?.events?.off) {
      try { pcEnd.events.off("selectionChanged", onSelectionChanged); } catch (_) {}
      try { pcEnd.events.off("playerStatsUpdated", onStatsUpdated); } catch (_) {}
      try { pcEnd.events.off("entityHealthUpdated", onEntityHealth); } catch (_) {}
    }
    if (state.overlayEl) {
      state.overlayEl.remove();
      state.overlayEl = null;
    }
  };
}

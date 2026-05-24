// Examine view — mounts inside main-panel's body slot. Replaces the
// PR-S standalone floating popup (gmFloatyExaminationUI 0x2100006B).
//
// User direction 2026-05-22: examine and inventory share the same UI
// pane — clicking an inventory item OR examining a creature in the
// world transitions the same pane. main-panel owns the position +
// title + close; we render the examine content inside its body slot.
//
// Two trigger paths:
//   1. From inventory: inventory.js pushes view "examine" with ctx
//      { srcLi, guid, name, fromInventory: true }. We pull stats from
//      the source <li>'s dataset + window.__sessionHandle.playerInventory().
//   2. From world picking: the rAF tick polls
//      liveScene3d.entityManager.getSelectedTarget(); on
//      0 → non-zero, pushes view "examine" with ctx { guid, name?,
//      fromEntity: true }. EntityMap entry sourced for details.
//
// Real DAT sprites:
//   - 0x06004CFC : blue glowing orb (32x32) — examine icon at top-left.

import { setAcText } from "../ui/ac_font.js";

const VIEW_ID_STYLE = "hb-examine-view-style";

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = VIEW_ID_STYLE;
  style.textContent = `
    .hb-exa-root {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      box-sizing: border-box;
      pointer-events: auto;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      overflow: hidden;
    }
    .hb-exa-head {
      position: absolute;
      top: 6px;
      left: 8px;
      right: 8px;
      height: 44px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .hb-exa-icon {
      width: 40px; height: 40px;
      background: url("./data/ui-sprites/0x06004CFC.png") center/contain no-repeat;
      filter: drop-shadow(0 0 4px rgba(80, 140, 255, 0.7));
      image-rendering: pixelated;
    }
    .hb-exa-namecol {
      display: flex;
      flex-direction: column;
      flex: 1;
      gap: 2px;
    }
    .hb-exa-name {
      font-size: 13px;
      color: var(--hb-text-gold);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.9);
      letter-spacing: 0.02em;
    }
    .hb-exa-guid {
      font-size: 9px;
      font-family: var(--hb-font-mono);
      color: var(--hb-text-muted);
    }
    .hb-exa-body {
      position: absolute;
      top: 56px;
      left: 8px;
      right: 8px;
      bottom: 8px;
      overflow-y: auto;
      padding: 4px;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid var(--hb-border-brass-dim);
      scrollbar-width: thin;
      scrollbar-color: var(--hb-border-brass) rgba(0, 0, 0, 0.5);
    }
    .hb-exa-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 2px 4px;
      font-size: 10px;
      line-height: 14px;
      border-bottom: 1px solid rgba(138, 117, 68, 0.18);
    }
    .hb-exa-row:last-child { border-bottom: none; }
    .hb-exa-label {
      color: var(--hb-text-cream);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-size: 9px;
    }
    .hb-exa-value {
      color: var(--hb-text-gold);
      text-align: right;
    }
    .hb-exa-section {
      font-size: 9px;
      color: var(--hb-text-cream-bright);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      padding: 4px 0 2px;
      margin-top: 4px;
      border-bottom: 1px solid var(--hb-border-brass-dim);
    }
  `;
  document.head.appendChild(style);
}

// Type-bit → label (mirrors inventory.js TYPE_COLOR map).
const TYPE_LABEL = {
  "0x4":     "Weapon",
  "0x2":     "Armor",
  "0x10000": "Magic / Scroll",
  "0x20":    "Currency (pyreal)",
};

function r(parent, label, value) {
  if (value == null || value === "") return;
  const row = document.createElement("div");
  row.className = "hb-exa-row";
  const l = document.createElement("span");
  l.className = "hb-exa-label";
  setAcText(l, label);
  const v = document.createElement("span");
  v.className = "hb-exa-value";
  setAcText(v, String(value));
  row.appendChild(l);
  row.appendChild(v);
  parent.appendChild(row);
}
function section(parent, text) {
  const s = document.createElement("div");
  s.className = "hb-exa-section";
  setAcText(s, text);
  parent.appendChild(s);
}

function getItemByGuid(guid) {
  try {
    const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
    if (!handle?.playerInventory) return null;
    const items = handle.playerInventory();
    return items.find((it) => String(it.guid) === String(guid)) || null;
  } catch (_) { return null; }
}

function populateFromInventory(body, ctx, nameEl, guidEl) {
  const srcLi = ctx.srcLi;
  const guid = ctx.guid ?? srcLi?.dataset?.guid;
  const item = getItemByGuid(guid);
  const tb = srcLi?.dataset?.typeBit ?? "0x0";
  nameEl.textContent = srcLi?.querySelector?.(".name")?.textContent || item?.name || ctx.name || "(unnamed)";
  guidEl.textContent = guid != null
    ? `0x${(Number(guid) >>> 0).toString(16).toUpperCase().padStart(8, "0")}`
    : "";
  section(body, "Identity");
  r(body, "Kind", TYPE_LABEL[tb] || "Item");
  if (item) {
    if (item.stackSize > 1) r(body, "Stack", item.stackSize);
    if (item.value > 0) r(body, "Value", `${item.value} pyreals`);
    if (item.equipMask) r(body, "Equip mask", `0x${item.equipMask.toString(16).toUpperCase().padStart(8, "0")}`);
    if (item.burden != null) r(body, "Burden", item.burden);
    if (item.itemType != null) r(body, "Item type bits", `0x${item.itemType.toString(16)}`);
  }
  r(body, "GUID", guidEl.textContent);
}

function populateFromEntity(body, ctx, nameEl, guidEl) {
  const guid = (ctx.guid >>> 0) || 0;
  const em = window.liveScene3d?.entityManager;
  const ent = em?.entityMap?.get?.(guid) || em?.entityMap?.get?.(String(guid)) || null;
  nameEl.textContent = ent?.name || ctx.name || "(unnamed)";
  guidEl.textContent = `0x${guid.toString(16).toUpperCase().padStart(8, "0")}`;
  if (!ent) {
    section(body, "Status");
    r(body, "Loading", "—");
    return;
  }
  section(body, "Identity");
  if (ent.type != null) r(body, "Type", String(ent.type));
  if (ent.classId != null) r(body, "Class", `0x${ent.classId.toString(16)}`);
  if (ent.wcid != null) r(body, "Wcid", String(ent.wcid));
  if (ent.position) {
    section(body, "Position");
    const p = ent.position;
    r(body, "X", p.x?.toFixed?.(1) ?? p.x);
    r(body, "Y", p.y?.toFixed?.(1) ?? p.y);
    r(body, "Z", p.z?.toFixed?.(1) ?? p.z);
    if (ent.landblock != null) r(body, "Landblock", `0x${ent.landblock.toString(16).padStart(8, "0").toUpperCase()}`);
  }
  section(body, "Combat");
  if (ent.level != null) r(body, "Level", String(ent.level));
  if (ent.health != null) r(body, "Health", String(ent.health));
  if (ent.stamina != null) r(body, "Stamina", String(ent.stamina));
  if (ent.mana != null) r(body, "Mana", String(ent.mana));
  if (ent.motionState != null) {
    section(body, "Animation");
    r(body, "Motion", String(ent.motionState));
    if (ent.heading != null) r(body, "Heading", (ent.heading * 180 / Math.PI).toFixed(1) + "°");
  }
}

// View interface — registered with main-panel under id "examine".
export const view = {
  name: "Examine",
  nameFor: (ctx) => {
    if (ctx?.name) return `Examine: ${ctx.name}`;
    if (ctx?.srcLi) {
      const n = ctx.srcLi.querySelector(".name")?.textContent;
      if (n) return `Examine: ${n}`;
    }
    return "Examine";
  },
  mount: (parentEl, ctx) => {
    ensureStyles();
    const root = document.createElement("div");
    root.className = "hb-exa-root";

    const head = document.createElement("div");
    head.className = "hb-exa-head";
    const iconEl = document.createElement("div");
    iconEl.className = "hb-exa-icon";
    head.appendChild(iconEl);
    const nameCol = document.createElement("div");
    nameCol.className = "hb-exa-namecol";
    const nameEl = document.createElement("div");
    nameEl.className = "hb-exa-name";
    nameEl.textContent = "—";
    const guidEl = document.createElement("div");
    guidEl.className = "hb-exa-guid";
    guidEl.textContent = "";
    nameCol.appendChild(nameEl);
    nameCol.appendChild(guidEl);
    head.appendChild(nameCol);
    root.appendChild(head);

    const body = document.createElement("div");
    body.className = "hb-exa-body";
    root.appendChild(body);

    parentEl.appendChild(root);

    if (ctx?.fromInventory) {
      populateFromInventory(body, ctx, nameEl, guidEl);
    } else {
      populateFromEntity(body, ctx ?? {}, nameEl, guidEl);
    }

    return () => { root.remove(); };
  },
};

// Selection-poll module: watches getSelectedTarget() and pushes the
// examine view onto the main-panel stack on non-zero transitions
// (skipping inventory items, which are handled by inventory.js).
// Exported as a separate mount() so index.html can register it as
// an iconHidden bar slot — it has no DOM of its own; it only watches.
export const manifest = {
  id: "examine-target-watcher",
  name: "Examine watcher",
  icon: "🔍",
  iconHidden: true,
  version: "0.2.0",
  description: "rAF polls getSelectedTarget; pushes examine view to main-panel on world-target change",
};

export function mount(_ctx) {
  // No auto-pop on selection change — selection click is reserved for
  // select-to-interact (attack / use / vendor-open / etc.). Examine
  // fires only on explicit user action: window.__showExamineFor(guid),
  // inventory slot click, or (future) right-click context menu.
  // User regression 2026-05-22: "clicking on the vendor causes
  // examine, before it was the other command, which would let you
  // interact with things."

  // E key removed 2026-05-22 (collides with turn-right movement key).
  // Examine is now only triggered explicitly via
  // window.__showExamineFor(guid), inventory slot click, or right-click
  // (when wired). Keeping the debug helper for console testing.
  window.__showExamineFor = (guid) => window.__mainPanel?.pushView?.("examine", { guid: guid >>> 0 });

  return () => {
    delete window.__showExamineFor;
  };
}

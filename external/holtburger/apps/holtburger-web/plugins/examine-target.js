// Examine-target popup — port of retail gmFloatyExaminationUI (layout
// 0x2100006B, 70 elements, 24 image DIDs, 310x400 floating panel).
//
// Trigger: rAF-polls liveScene3d.entityManager.getSelectedTarget()
// (per scene3d/picking.js:305). When the selected GUID changes from 0
// to non-zero, the panel pops with that entity's name + icon + stats.
// Setting target back to 0 (deselect) hides it. Close button dismisses
// without changing selection.
//
// Real DAT sprites:
//   - 0x06004CFC : blue glowing orb (32x32) — examine icon at top-left.
//                  Retail uses this as the "appraised" indicator.
//   - panel.png 9-slice from Chorizite atlas — outer brass chrome
//     (matches our other framed surfaces).
//
// First pass: name + GUID + (placeholder) level/HP/notes. Real stat
// rows (creature level, vitals, attack/defense, magic resists, etc.)
// need wasm.appraiseTarget() which we don't expose yet — wiring is a
// follow-on. The chrome + show/hide on selection is the core of PR-S.

const OVERLAY_ID = "hb-examine-target";
const WIDTH = 310;
const HEIGHT = 400;
const TITLE_H = 25;

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "hb-examine-target-style";
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      top: 100px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 60;
      width: ${WIDTH}px;
      height: ${HEIGHT}px;
      box-sizing: border-box;
      pointer-events: none;
      font-family: var(--hb-font-serif);
      background: linear-gradient(180deg, var(--hb-bg-stone-top) 0%, var(--hb-bg-stone-bottom) 100%);
      border: 6px solid transparent;
      border-image: url("./sprites/acsprites/panel.png") 6 / 6px / 0 stretch;
      box-shadow: var(--hb-shadow-panel);
      color: var(--hb-text-cream);
      display: none;
    }
    #${OVERLAY_ID}[data-open="1"] { display: block; }
    #${OVERLAY_ID} .hb-exa-title {
      position: absolute;
      top: 0; left: 0; right: 0;
      height: ${TITLE_H}px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 8px;
      background: url("./data/ui-sprites/0x06004CFA.png") center/100% 100% no-repeat;
      font-size: 11px;
      color: var(--hb-text-cream-bright);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.9);
      pointer-events: auto;
      user-select: none;
    }
    #${OVERLAY_ID} .hb-exa-close {
      width: 14px; height: 14px;
      background: var(--hb-border-brass);
      color: var(--hb-bg-stone-bottom);
      font-size: 9px;
      line-height: 14px;
      text-align: center;
      cursor: pointer;
    }
    #${OVERLAY_ID} .hb-exa-close:hover { background: var(--hb-text-gold); }
    /* Header row: blue-orb icon + target name + GUID. */
    #${OVERLAY_ID} .hb-exa-head {
      position: absolute;
      top: ${TITLE_H + 6}px;
      left: 8px;
      right: 8px;
      height: 38px;
      display: flex;
      align-items: center;
      gap: 8px;
      pointer-events: auto;
    }
    #${OVERLAY_ID} .hb-exa-icon {
      width: 32px; height: 32px;
      background: url("./data/ui-sprites/0x06004CFC.png") center/contain no-repeat;
      filter: drop-shadow(0 0 3px rgba(80, 140, 255, 0.7));
      image-rendering: pixelated;
    }
    #${OVERLAY_ID} .hb-exa-namecol {
      display: flex;
      flex-direction: column;
      flex: 1;
      gap: 1px;
    }
    #${OVERLAY_ID} .hb-exa-name {
      font-size: 13px;
      color: var(--hb-text-gold);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.9);
      letter-spacing: 0.02em;
    }
    #${OVERLAY_ID} .hb-exa-guid {
      font-size: 9px;
      font-family: var(--hb-font-mono);
      color: var(--hb-text-muted);
    }
    /* Body: stat rows. Each row is "Label : Value". */
    #${OVERLAY_ID} .hb-exa-body {
      position: absolute;
      top: ${TITLE_H + 50}px;
      left: 8px;
      right: 8px;
      bottom: 8px;
      overflow-y: auto;
      pointer-events: auto;
      padding: 4px;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid var(--hb-border-brass-dim);
      scrollbar-width: thin;
      scrollbar-color: var(--hb-border-brass) rgba(0, 0, 0, 0.5);
    }
    #${OVERLAY_ID} .hb-exa-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 2px 4px;
      font-size: 10px;
      line-height: 14px;
      border-bottom: 1px solid rgba(138, 117, 68, 0.18);
    }
    #${OVERLAY_ID} .hb-exa-row:last-child { border-bottom: none; }
    #${OVERLAY_ID} .hb-exa-label {
      color: var(--hb-text-cream);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-size: 9px;
    }
    #${OVERLAY_ID} .hb-exa-value {
      color: var(--hb-text-gold);
      text-align: right;
    }
    #${OVERLAY_ID} .hb-exa-section {
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

export const manifest = {
  id: "examine-target",
  name: "Examine",
  icon: "🔍",
  iconHidden: true,
  version: "0.1.0",
  description: "Floating examine popup (gmFloatyExaminationUI 0x2100006B)",
};

export function mount(_ctx) {
  ensureStyles();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;

  // Title
  const title = document.createElement("div");
  title.className = "hb-exa-title";
  const titleLabel = document.createElement("span");
  titleLabel.textContent = "Examine";
  title.appendChild(titleLabel);
  const closeBtn = document.createElement("span");
  closeBtn.className = "hb-exa-close";
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => { overlay.dataset.open = "0"; });
  title.appendChild(closeBtn);
  overlay.appendChild(title);

  // Header (icon + name + guid)
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
  overlay.appendChild(head);

  // Body: stat rows
  const body = document.createElement("div");
  body.className = "hb-exa-body";
  overlay.appendChild(body);

  document.body.appendChild(overlay);

  function row(label, value) {
    const r = document.createElement("div");
    r.className = "hb-exa-row";
    const l = document.createElement("span");
    l.className = "hb-exa-label";
    l.textContent = label;
    const v = document.createElement("span");
    v.className = "hb-exa-value";
    v.textContent = value;
    r.appendChild(l);
    r.appendChild(v);
    return r;
  }
  function section(label) {
    const s = document.createElement("div");
    s.className = "hb-exa-section";
    s.textContent = label;
    return s;
  }

  function populateFor(guid) {
    body.innerHTML = "";
    const em = window.liveScene3d?.entityManager;
    if (!em) return;
    // entityMap is per memory keyed by guid → entity record.
    const ent = em.entityMap?.get?.(guid) || em.entityMap?.get?.(String(guid)) || null;
    if (!ent) {
      body.appendChild(row("Status", "Loading…"));
      return;
    }
    // Surface whatever the entity record has. Common fields per the
    // surface inventory: name, type, level, position, motionState, etc.
    // Read defensively so we don't crash if shape drifts.
    nameEl.textContent = ent.name || ent.displayName || "(unnamed)";
    guidEl.textContent = `0x${(guid >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;

    body.appendChild(section("Identity"));
    if (ent.type != null) body.appendChild(row("Type", String(ent.type)));
    if (ent.classId != null) body.appendChild(row("Class", `0x${ent.classId.toString(16)}`));
    if (ent.wcid != null) body.appendChild(row("Wcid", String(ent.wcid)));

    body.appendChild(section("Position"));
    if (ent.position) {
      const p = ent.position;
      body.appendChild(row("X", (p.x ?? 0).toFixed?.(1) ?? p.x));
      body.appendChild(row("Y", (p.y ?? 0).toFixed?.(1) ?? p.y));
      body.appendChild(row("Z", (p.z ?? 0).toFixed?.(1) ?? p.z));
    }
    if (ent.landblock != null) {
      body.appendChild(row("Landblock", `0x${ent.landblock.toString(16).padStart(8, "0").toUpperCase()}`));
    }

    body.appendChild(section("Combat"));
    if (ent.level != null) body.appendChild(row("Level", String(ent.level)));
    if (ent.health != null) body.appendChild(row("Health", String(ent.health)));
    if (ent.stamina != null) body.appendChild(row("Stamina", String(ent.stamina)));
    if (ent.mana != null) body.appendChild(row("Mana", String(ent.mana)));

    body.appendChild(section("Animation"));
    if (ent.motionState != null) body.appendChild(row("Motion", String(ent.motionState)));
    if (ent.heading != null) body.appendChild(row("Heading", (ent.heading * 180 / Math.PI).toFixed(1) + "°"));

    // Empty-state fallback — show that we have the entity but no fields.
    if (body.childElementCount === 0) {
      body.appendChild(row("Status", "Entity record empty"));
    }
  }

  // Poll for selected-target changes. The entity manager exposes
  // getSelectedTarget() per scene3d/picking.js:305.
  let lastGuid = 0;
  let rafId = 0;
  function tick() {
    const em = window.liveScene3d?.entityManager;
    if (em?.getSelectedTarget) {
      const guid = (em.getSelectedTarget() ?? 0) >>> 0;
      if (guid !== lastGuid) {
        lastGuid = guid;
        if (guid === 0) {
          overlay.dataset.open = "0";
        } else {
          populateFor(guid);
          overlay.dataset.open = "1";
        }
      }
    }
    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);

  // Debug helper — manually trigger by GUID from console.
  window.__showExamineFor = (guid) => { populateFor(guid >>> 0); overlay.dataset.open = "1"; };
  window.__hideExamine = () => { overlay.dataset.open = "0"; };

  return () => {
    cancelAnimationFrame(rafId);
    delete window.__showExamineFor;
    delete window.__hideExamine;
    overlay.remove();
  };
}

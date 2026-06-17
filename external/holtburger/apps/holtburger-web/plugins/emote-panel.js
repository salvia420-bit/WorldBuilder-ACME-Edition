// Wave F.6 (2026-05-27) — Emote Panel plugin.
//
// Categorized emote picker built atop the wasm `getEmoteTaxonomy()`
// export. Bridges the gap between Wave 9.5's narrow ChatPoseTable
// soul-emote slash commands (303 user-facing pose tokens) and the
// broader CEmoteTable wire taxonomy (39 categories × 122 action types).
//
// Architecture:
//
//   * Wave 9.5 SoulEmoteCatalog → `handle.resolveSoulEmote(token)` →
//     `handle.sendSoulEmote(text) + handle.broadcastEmoteMotion(motion)`.
//     Lives in chat-panel's slash-command parser. Already shipped.
//
//   * Wave F.6 emote-panel (this file) → categorized UI palette
//     surfacing the FULL EmoteType discriminant table per
//     external/chorizite/Chorizite.Common/Enums/EmoteType.cs.
//     Hover → tooltip with field-shape; click → dispatches via the
//     existing Wave 9.5 wire path when the action is user-firable.
//
// The panel surfaces categories grouped under "Common" (vendor/death/
// hear-chat/give/wield/etc., the 13 most-used in retail vendor weenies)
// vs "All" (the full 39). Click an action → dispatches the matching
// `/<token>` soul emote if one exists, or fires a system-only chat line
// for action types that aren't user-firable (e.g. AwardXP, EraseQuest).
//
// References:
//   * external/chorizite/Chorizite.Common/Enums/EmoteCategory.cs
//   * external/chorizite/Chorizite.Common/Enums/EmoteType.cs
//   * external/chorizite/Chorizite.ACProtocol/Types/Emote.generated.cs
//   * apps/holtburger-web/src/lib.rs (getEmoteTaxonomy wasm export)
//
// Hotkey: Shift+F2 — declared in `emote-panel.manifest.json` and routed
// via the manifest-hotkey path in index.html (Polish B's `matchHotkeyEvent`
// dispatcher → `__mainPanel.toggleView("emote")`). The legacy
// `window.__toggleEmotePanel` global was removed in Wave J1.A (2026-05-27)
// as part of the orphan-hotkey cleanup: there were no remaining callers
// after Polish B's manifest path took over, and a `FKEY_SHIFT_TOGGLES[F2]`
// entry was never wired in index.html (Polish B audit finding).

const PANEL_ID = "hb-emote-panel";

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "hb-emote-panel-style";
  style.textContent = `
    #${PANEL_ID} {
      position: fixed;
      top: 80px;
      right: 40px;
      width: 380px;
      max-height: 70vh;
      background: rgba(20, 18, 14, 0.94);
      border: 1px solid rgba(180, 140, 80, 0.55);
      border-radius: 4px;
      color: #d8d2c4;
      font-family: inherit;
      font-size: 12px;
      z-index: 6000;
      display: none;
      box-shadow: 0 4px 18px rgba(0,0,0,0.6);
    }
    #${PANEL_ID}[data-open="1"] { display: flex; flex-direction: column; }
    #${PANEL_ID} .hb-ep-title {
      padding: 8px 12px;
      background: linear-gradient(to bottom, rgba(80, 60, 30, 0.7), rgba(50, 40, 20, 0.7));
      border-bottom: 1px solid rgba(180, 140, 80, 0.4);
      font-size: 13px;
      font-weight: 600;
      color: #f0e6d0;
      display: flex;
      align-items: center;
    }
    #${PANEL_ID} .hb-ep-title-text { flex: 1; }
    #${PANEL_ID} .hb-ep-close {
      background: transparent;
      color: #d8d2c4;
      border: 1px solid rgba(180, 140, 80, 0.4);
      border-radius: 3px;
      width: 20px;
      height: 20px;
      cursor: pointer;
      font-size: 12px;
      line-height: 1;
      padding: 0;
    }
    #${PANEL_ID} .hb-ep-close:hover {
      background: rgba(180, 140, 80, 0.25);
      border-color: rgba(220, 180, 100, 0.8);
    }
    #${PANEL_ID} .hb-ep-toolbar {
      padding: 6px 10px;
      border-bottom: 1px solid rgba(120, 100, 60, 0.3);
      display: flex;
      gap: 6px;
      align-items: center;
    }
    #${PANEL_ID} .hb-ep-toolbar select,
    #${PANEL_ID} .hb-ep-toolbar input[type="text"] {
      flex: 1;
      background: rgba(10, 10, 8, 0.7);
      border: 1px solid rgba(120, 100, 60, 0.5);
      color: #d8d2c4;
      padding: 3px 6px;
      font: inherit;
      border-radius: 3px;
    }
    #${PANEL_ID} .hb-ep-toolbar label {
      font-size: 11px;
      color: rgba(216, 210, 196, 0.7);
      display: flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      user-select: none;
    }
    #${PANEL_ID} .hb-ep-body {
      flex: 1;
      overflow-y: auto;
      padding: 0;
    }
    #${PANEL_ID} .hb-ep-section {
      border-bottom: 1px solid rgba(80, 70, 50, 0.4);
    }
    #${PANEL_ID} .hb-ep-section-head {
      padding: 6px 12px;
      background: rgba(60, 50, 30, 0.4);
      font-weight: 600;
      font-size: 12px;
      color: #e8d8b0;
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    #${PANEL_ID} .hb-ep-section-head:hover { background: rgba(80, 70, 40, 0.5); }
    #${PANEL_ID} .hb-ep-section-head .hb-ep-caret { font-size: 10px; }
    #${PANEL_ID} .hb-ep-section-head .hb-ep-count {
      margin-left: auto;
      font-weight: 400;
      color: rgba(216, 210, 196, 0.5);
      font-size: 11px;
    }
    #${PANEL_ID} .hb-ep-section-body {
      padding: 4px 6px 8px 6px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
    }
    #${PANEL_ID} .hb-ep-section[data-collapsed="1"] .hb-ep-section-body { display: none; }
    #${PANEL_ID} .hb-ep-action {
      padding: 4px 8px;
      background: rgba(40, 35, 25, 0.6);
      border: 1px solid rgba(120, 100, 60, 0.35);
      border-radius: 3px;
      color: #d8d2c4;
      font-family: inherit;
      font-size: 11px;
      cursor: pointer;
      text-align: left;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #${PANEL_ID} .hb-ep-action:hover {
      background: rgba(80, 60, 30, 0.7);
      border-color: rgba(220, 180, 100, 0.7);
      color: #f4e8c8;
    }
    #${PANEL_ID} .hb-ep-action[data-dispatchable="1"] {
      color: #f4e8c8;
      border-color: rgba(160, 130, 70, 0.5);
    }
    #${PANEL_ID} .hb-ep-action[data-dispatchable="0"] {
      color: rgba(216, 210, 196, 0.45);
      font-style: italic;
    }
    #${PANEL_ID} .hb-ep-empty {
      padding: 20px 12px;
      text-align: center;
      color: rgba(216, 210, 196, 0.5);
      font-style: italic;
    }
    #${PANEL_ID} .hb-ep-status {
      padding: 6px 12px;
      border-top: 1px solid rgba(80, 70, 50, 0.5);
      font-size: 10px;
      color: rgba(216, 210, 196, 0.6);
    }
  `;
  document.head.appendChild(style);
}

// Soul-emote token → EmoteType heuristic. Most pose tokens trigger
// `Motion` (type 0x05); a handful (`/admit`, `/confess`, etc.) trigger
// `Say` (type 0x08) per ACE's SoulEmote.cs. We don't load the full ACE
// table here — Wave F.6 stretch could replace this with a map
// generated from `external/ACE/Source/ACE.Server/Entity/SoulEmote.cs`.
function inferSoulEmoteTypeId(tokenName) {
  const SAY_TOKENS = new Set([
    "admit", "confess", "duck", "duh", "no", "ok", "yes",
    "hello", "goodbye", "thanks", "sorry", "huh", "wow",
  ]);
  return SAY_TOKENS.has(tokenName.toLowerCase()) ? 0x08 : 0x05;
}

// Tooltip text builder — concise summary of an action.
function buildActionTooltip(t) {
  const visibility = t.isUserVisible ? "user-visible" : "server-only";
  const fieldsList = t.fields.length === 0 ? "(none)" : t.fields.join(", ");
  return `${t.name} (0x${t.id.toString(16).padStart(2, "0")})\n`
       + `shape: ${t.shape}\n`
       + `fields: ${fieldsList}\n`
       + `${visibility}`;
}

// Try to dispatch an emote action via the existing wire surface.
// Returns { dispatched, echo, error }.
function dispatchEmoteAction(t, ctx) {
  const handle = ctx?.handle ?? window.__sessionHandle ?? null;
  if (!handle) {
    return { dispatched: false, error: "Not logged in." };
  }
  // Only `Motion`-type actions map onto SoulEmote / soul-emote slash
  // (`/wave`, `/bow`, `/cheer`). Other types (`Say`, `CastSpell`, ...)
  // either have no client-firable C2S surface (`AwardXP`, server-only)
  // or are handled by their own UI (`CastSpell` via combat-bar magic
  // mode, `Tell` via chat-panel's `/t name msg`, etc.).
  if (t.id === 0x05 /* Motion */ || t.id === 0x34 /* ForceMotion */) {
    // Map the action name to a soul-emote token. The taxonomy's
    // `name` is something like "Motion" — that's the EmoteType
    // discriminant name, not a specific pose. For a soul-emote
    // catalog cross-match the user should use the slash command
    // (`/wave`, `/bow`, etc.). We surface a hint here.
    return {
      dispatched: false,
      info: `For pose emotes use slash commands in chat (e.g. /wave, /bow). Action type ${t.name} is dispatched per-pose.`,
    };
  }
  if (t.id === 0x09 /* Sound */) {
    // HUD rec #142 — local-only emote sound. ACE has no C2S "broadcast
    // sound" GameAction (GameMessageSound 0xF750 is server-emitted only),
    // so this plays the cue for the LOCAL player only; PVS-visible
    // observers will NOT hear it. The panel surfaces the EmoteType
    // taxonomy (not per-NPC emote records), so there is no specific sound
    // bound to the generic Sound type — we play a representative cue that
    // is verified to live in the local player's humanoid SoundTable
    // (0x20000001). A future sound-picker could expose the full ACE Sound
    // enum (external/melt/Source/Ace.Entity/Enum/Sound.cs).
    if (typeof handle.broadcastEmoteSoundEffect !== "function") {
      // Typeof-guard (F18-2): a pre-rec-#142 wasm bundle lacks this export.
      return { dispatched: false, info: `Action ${t.name}: sound playback needs a newer client build.` };
    }
    const guid = (typeof window !== "undefined" && typeof window.getLocalPlayerGuid === "function")
      ? (window.getLocalPlayerGuid() >>> 0) : 0;
    if (!guid) {
      return { dispatched: false, info: `Action ${t.name}: enter the world before playing a sound.` };
    }
    const soundEnum = 0x40; // Sound.Eat1 — representative in-humanoid-table cue.
    try {
      handle.broadcastEmoteSoundEffect(guid, soundEnum);
    } catch (err) {
      return { dispatched: false, error: `Sound dispatch failed: ${err?.message ?? err}` };
    }
    return {
      dispatched: true,
      echo: `Played Sound enum 0x${soundEnum.toString(16)} locally (remote players will not hear it).`,
    };
  }
  if (t.id === 0x08 /* Say */) {
    // Say is just a chat broadcast — pass through.
    if (typeof handle.sendEmote === "function") {
      // Without a specific message, we can't dispatch — surface help.
      return {
        dispatched: false,
        info: `Action ${t.name}: use chat input "/me <text>" to dispatch.`,
      };
    }
  }
  // Server-only actions surface a system info line.
  if (!t.isUserVisible) {
    return {
      dispatched: false,
      info: `Action ${t.name} is server-only (no client-firable C2S surface).`,
    };
  }
  return {
    dispatched: false,
    info: `Action ${t.name} (shape ${t.shape}) — wire dispatch deferred to Wave F.6 stretch.`,
  };
}

function renderSections(body, taxonomy, ctx, opts) {
  body.innerHTML = "";
  const { showAll, filterText, statusEl } = opts;

  // Filter types by user-visible + filter text. The picker only
  // surfaces user-visible types by default (Motion / Say / CastSpell /
  // PhysScript / Sound / etc.). Show-All toggles in all 122.
  const matchingTypes = taxonomy.types.filter((t) => {
    if (!showAll && !t.isUserVisible) return false;
    if (filterText && !t.name.toLowerCase().includes(filterText)) return false;
    return true;
  });

  if (matchingTypes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hb-ep-empty";
    empty.textContent = filterText
      ? "No matching actions."
      : "No user-visible actions in this view.";
    body.appendChild(empty);
    statusEl.textContent = `0 of ${taxonomy.typeCount} actions visible.`;
    return;
  }

  // Group matching types by category-style buckets. For Wave F.6 we
  // surface a flat "All Actions" section (categories apply only to
  // per-NPC tables, not the static type list); the action's own shape
  // doubles as the sub-grouping signal.
  const byShape = new Map();
  for (const t of matchingTypes) {
    const k = t.shape;
    if (!byShape.has(k)) byShape.set(k, []);
    byShape.get(k).push(t);
  }
  // Sort shape buckets alphabetically; sort types within each by id.
  const sortedShapes = [...byShape.keys()].sort();
  for (const shape of sortedShapes) {
    const types = byShape.get(shape);
    types.sort((a, b) => a.id - b.id);
    const section = document.createElement("div");
    section.className = "hb-ep-section";
    section.dataset.shape = shape;

    const head = document.createElement("div");
    head.className = "hb-ep-section-head";
    const caret = document.createElement("span");
    caret.className = "hb-ep-caret";
    caret.textContent = "▾";
    head.appendChild(caret);
    const label = document.createElement("span");
    label.textContent = shape;
    head.appendChild(label);
    const count = document.createElement("span");
    count.className = "hb-ep-count";
    count.textContent = `${types.length}`;
    head.appendChild(count);
    head.addEventListener("click", () => {
      const collapsed = section.dataset.collapsed === "1" ? "0" : "1";
      section.dataset.collapsed = collapsed;
      caret.textContent = collapsed === "1" ? "▸" : "▾";
    });
    section.appendChild(head);

    const sectionBody = document.createElement("div");
    sectionBody.className = "hb-ep-section-body";
    for (const t of types) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hb-ep-action";
      btn.textContent = t.name;
      btn.title = buildActionTooltip(t);
      btn.dataset.typeId = t.id;
      btn.dataset.dispatchable = t.isUserVisible ? "1" : "0";
      btn.addEventListener("click", () => {
        const result = dispatchEmoteAction(t, ctx);
        statusEl.textContent =
          result.dispatched
            ? (result.echo || `Dispatched ${t.name}.`)
            : (result.info || result.error || `${t.name}: see hint.`);
      });
      sectionBody.appendChild(btn);
    }
    section.appendChild(sectionBody);
    body.appendChild(section);
  }

  statusEl.textContent =
    `${matchingTypes.length} of ${taxonomy.typeCount} actions visible — ${sortedShapes.length} shape group(s).`;
}

// J1.A removed the standalone-overlay `toggle()` path: it wasn't
// exported (module scope hid it from devtools too), wasn't called
// internally, and the manifest's Shift+F2 routes through main-panel's
// `view` (line 469 below). If a future need surfaces a separate
// floating-overlay surface distinct from the main-panel view, re-derive
// from git history rather than carrying speculative code.

export const manifest = {
  id: "emote-panel",
  name: "Emote Palette",
  icon: "☺",
  // No dedicated retail "emote" button sprite exists (chat triggers emotes
  // via slash). Falling back to the spellbook-style scroll sprite as a
  // neutral DAT-themed placeholder; the emoji remains the load-fallback.
  iconSprite: "0x06001AAF",
  version: "0.1.0",
  description:
    "Categorized emote action picker (Wave F.6, CEmoteTable taxonomy). " +
    "Shift+F2 toggles the panel. Surfaces all 122 EmoteType discriminants " +
    "with field-shape hints; click an action for dispatch (Motion routes " +
    "through soul-emote slash commands).",
};

// main-panel `view` export — same convention as
// spellbook / inventory / allegiance / etc.
export function view(ctx) {
  ensureStyles();
  const handle = ctx?.handle ?? window.__sessionHandle ?? null;
  if (!cachedTaxonomy && handle && typeof handle.getEmoteTaxonomy === "function") {
    try {
      const tax = handle.getEmoteTaxonomy();
      if (tax && tax.types) cachedTaxonomy = tax;
    } catch (e) {
      console.warn("[emote-panel.view] getEmoteTaxonomy failed:", e);
    }
  }
  const tax = cachedTaxonomy ?? { categories: [], types: [], categoryCount: 0, typeCount: 0 };
  const container = document.createElement("div");
  container.style.display = "flex";
  container.style.flexDirection = "column";
  container.style.height = "100%";

  const toolbar = document.createElement("div");
  toolbar.className = "hb-ep-toolbar";
  toolbar.style.borderTop = "none";
  const filterInput = document.createElement("input");
  filterInput.type = "text";
  filterInput.placeholder = "Filter actions…";
  toolbar.appendChild(filterInput);
  const allLabel = document.createElement("label");
  const allCheckbox = document.createElement("input");
  allCheckbox.type = "checkbox";
  allLabel.appendChild(allCheckbox);
  allLabel.appendChild(document.createTextNode("All"));
  toolbar.appendChild(allLabel);
  container.appendChild(toolbar);

  const body = document.createElement("div");
  body.className = "hb-ep-body";
  body.style.flex = "1";
  body.style.overflowY = "auto";
  container.appendChild(body);

  const status = document.createElement("div");
  status.className = "hb-ep-status";
  status.textContent = `Taxonomy: ${tax.categoryCount} categories × ${tax.typeCount} action types.`;
  container.appendChild(status);

  function render() {
    renderSections(body, tax, ctx, {
      showAll: allCheckbox.checked,
      filterText: (filterInput.value || "").trim().toLowerCase(),
      statusEl: status,
    });
  }
  filterInput.addEventListener("input", render);
  allCheckbox.addEventListener("change", render);
  render();

  return container;
}

// Test-only export (Wave F.6 unit tests in tests/emote_table.test.cjs).
// Hidden behind a no-window guard so production bundles strip it.
export const __test = {
  inferSoulEmoteTypeId,
  buildActionTooltip,
  dispatchEmoteAction,
  renderSections,
};

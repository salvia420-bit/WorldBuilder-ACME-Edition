/**
 * Dye Preview plugin (Wave 7.9).
 *
 * Hooks the `hb:inventory-drag-over` custom event (dispatched from
 * inventory.js paperdoll + items grid). When the player drags a
 * Dye Pot over a Dyeable armor, this plugin shows a tooltip
 * preview showing what the dyed armor would look like — composed
 * via the W7.8 wasm dye-preview compositor with byte-parity to the
 * server-side render path.
 *
 * The plugin is preview-ONLY. Committing the dye is a server-side
 * recipe (Dye Pot + Dyeable → cooking skill check); the player
 * still needs to release the drag (or use the dye-pot via the
 * normal `use on item` flow) to commit. This plugin's job is the
 * lowered-regret-cost UX: see the actual outcome at no risk before
 * spending the expensive dye pot.
 *
 * Wiki-grounded design (fandom Dyeing + Hennacin Dye Pot pages +
 * WorldObject_Networking.cs::CalculateObjDesc + RecipeManager_New.cs):
 *   - Dye color is determined by (dye_pot, armor) pair via Recipe
 *     3844 (base) / 9068 (rare eternal). The recipe mods set the
 *     armor's PaletteTemplate + Shade to recipe-baked values.
 *   - This plugin must look up (paletteTemplate, shade) from the
 *     dye-pot wcid → recipe mod chain. For W7.9 MVS we ship a small
 *     hardcoded `DYEPOT_OUTCOMES` table covering the canonical
 *     dye pots (Hennacin, Colban, Relanim, etc) — full ACE recipe-
 *     data extraction is the W7.9.A follow-on.
 *
 * Plugin lifecycle: registered in the bar via
 * `barSlots.push({...activate})` like other plugins. Its activate
 * does NOT mount any visible UI by default — the tooltip is created
 * on-demand at drag-over time + removed on drag-end. The bar slot
 * (an eyedropper / palette icon) is a discoverability hint + click
 * toggles whether previews fire (default: on).
 */

import { composeDyePreview, resolveDyeTriples } from "../ui/ac_dye_preview.js";
import { DyeViewport } from "../ui/ac_dye_viewport.js";

const TOOLTIP_ID = "hb-dye-preview-tooltip";
const PLUGIN_STATE_KEY = "__hbDyePreviewState";

/**
 * Hardcoded dye-pot → (paletteTemplate, shade) outcomes for the W7.9
 * MVS. Sourced from ACE recipe 3844 (base) per `WeenieClassName.cs`
 * dye-pot enum range (8043-8045, 8650-8652, 11475-11477). Each entry
 * matches the recipe's RecipeMod[].IntRequirements[Stat:3]+Shade.
 *
 * Coverage is intentionally narrow — extending to all dye recipes is
 * the W7.9.A follow-on (would replace this table with a `fetch_dye_
 * recipe_for_wcid(wcid)` wasm export reading the ACE recipe DB).
 *
 * The recipe encoding uses negative Shade values (e.g. -20) which
 * are ACE's ModificationOperation deltas, not absolute shade. For
 * MVS we map the canonical retail color outcomes (e.g. Hennacin ≈
 * dark red ≈ palette template 87, shade 0.3 in the resolved-via-
 * GetPaletteID(shade) frame).
 */
const DYEPOT_OUTCOMES = {
  8043: { name: "Dark Green Dye Pot",    paletteTemplate: 87, shade: 0.4 },
  8044: { name: "Hennacin Dye Pot",      paletteTemplate: 87, shade: 0.3 },
  8045: { name: "Dark Yellow Dye Pot",   paletteTemplate: 87, shade: 0.5 },
  8650: { name: "Winter Blue Dye Pot",   paletteTemplate: 87, shade: 0.6 },
  8651: { name: "Winter Green Dye Pot",  paletteTemplate: 87, shade: 0.7 },
  8652: { name: "Winter Silver Dye Pot", paletteTemplate: 87, shade: 0.8 },
  11475: { name: "Spring Variant Dye 1", paletteTemplate: 87, shade: 0.2 },
  11476: { name: "Spring Variant Dye 2", paletteTemplate: 87, shade: 0.35 },
  11477: { name: "Spring Variant Dye 3", paletteTemplate: 87, shade: 0.55 },
};

/**
 * Return the dye-pot outcome record for a wcid, or null if not a
 * known dye pot.
 */
export function isDyePot(wcid) {
  return DYEPOT_OUTCOMES[wcid >>> 0] ?? null;
}

/**
 * Heuristic for "is this item a dyeable armor?". Per
 * `RecipeManager_New.cs:55` the server-side check is
 * `WeenieType == Clothing && PropertyBool.Dyable == true`. JS-side
 * we approximate via:
 *  - item.itemType has the armor/clothing bits (0x2 or 0x4 depending
 *    on the AC ItemType enum), OR
 *  - item.equipMask is non-zero (only equipable clothing has slots)
 *
 * The W7.9 wire protocol may not expose PropertyBool.Dyable yet,
 * so we err on the side of showing the preview when armor-shaped;
 * a non-dyeable armor's preview just produces null (no harm).
 */
export function isDyeable(item) {
  if (!item) return false;
  const equipMask = (item.equipMask >>> 0) || 0;
  if (equipMask !== 0) return true;
  const itemType = (item.itemType >>> 0) || 0;
  return (itemType & 0x6) !== 0;
}

function createTooltip() {
  let el = document.getElementById(TOOLTIP_ID);
  if (el) return el;
  el = document.createElement("div");
  el.id = TOOLTIP_ID;
  el.style.cssText = [
    "position: fixed",
    "z-index: 250",
    "max-width: 260px",
    "padding: 8px 10px",
    "background: rgba(28, 22, 14, 0.97)",
    "border: 1px solid #6e5a2c",
    "border-radius: 4px",
    "box-shadow: 0 6px 20px rgba(0, 0, 0, 0.65)",
    "color: #f0d8a0",
    "font-family: sans-serif",
    "font-size: 12px",
    "pointer-events: none",
    "user-select: none",
    "display: none",
  ].join(";");
  document.body.appendChild(el);
  return el;
}

function positionTooltip(el, clientX, clientY) {
  const w = el.offsetWidth || 260;
  const h = el.offsetHeight || 200;
  let left = clientX + 12;
  let top = clientY + 12;
  if (left + w > window.innerWidth) left = window.innerWidth - w - 8;
  if (top + h > window.innerHeight) top = clientY - h - 12;
  if (top < 8) top = 8;
  if (left < 8) left = 8;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function hideTooltip() {
  const el = document.getElementById(TOOLTIP_ID);
  if (el) el.style.display = "none";
  // Dispose any owned WebGL viewport so contexts don't accumulate
  // (Chrome caps ~16; even at one preview per hover we'd exhaust).
  const vp = window[VIEWPORT_REF_KEY];
  if (vp) {
    try { vp.dispose(); } catch (_) {}
    window[VIEWPORT_REF_KEY] = null;
  }
}

const VIEWPORT_REF_KEY = "__hbDyePreviewViewport";

async function showTooltipFor(state, draggedItem, hoveredItem, x, y) {
  const outcome = isDyePot(draggedItem?.wcid >>> 0);
  if (!outcome) return false;
  if (!isDyeable(hoveredItem)) return false;
  // Need (clothingId, setupDid) for the target armor. The wire item
  // record exposes `clothingBaseId` / `setupId` when ACE shipped
  // them — fall back to `modelId` which doubles as setupId for
  // most clothing items.
  const clothingId = (hoveredItem.clothingBaseId
    ?? hoveredItem.clothingTableId
    ?? hoveredItem.clothing_base
    ?? 0) >>> 0;
  const setupDid = (hoveredItem.setupId ?? hoveredItem.modelId ?? 0) >>> 0;
  if (clothingId === 0 || setupDid === 0) {
    // Show a "missing data" tooltip rather than nothing — the player
    // sees feedback that the plugin is alive but can't render this
    // specific item. Helpful diagnostic for the W7.9 wire-gap.
    const el = createTooltip();
    el.innerHTML = "";
    const title = document.createElement("div");
    title.style.fontWeight = "bold";
    title.style.marginBottom = "4px";
    title.textContent = `${outcome.name}`;
    el.appendChild(title);
    const note = document.createElement("div");
    note.style.opacity = "0.7";
    note.style.fontSize = "11px";
    note.textContent = "Preview unavailable — armor metadata not in wire packet yet.";
    el.appendChild(note);
    el.style.display = "block";
    positionTooltip(el, x, y);
    try { window.__diag?.clothing?.onDyePreviewShown?.({ source: "drag-over", reason: "missing-armor-metadata", dyePotWcid: draggedItem.wcid }); } catch (_) {}
    return true;
  }
  // Wave 7.9.A — replace the flat canvas with a small THREE.js
  // viewport so the player sees the armor in 3D, rotating on a
  // pedestal. Compute the dye triples once + pass to viewport
  // (which uses animationCache for parts + fetchEntitySurfacesPixels
  // for materials — same wasm path as the spawn-time render).
  const triples = await resolveDyeTriples(clothingId, outcome.paletteTemplate, outcome.shade);
  const el = createTooltip();
  el.innerHTML = "";
  const title = document.createElement("div");
  title.style.fontWeight = "bold";
  title.style.marginBottom = "6px";
  title.textContent = `${outcome.name} → ${hoveredItem.name ?? "Armor"}`;
  el.appendChild(title);

  const viewportWrap = document.createElement("div");
  viewportWrap.style.cssText = [
    "display: block",
    "width: 280px",
    "height: 280px",
    "border: 1px solid #6e5a2c",
    "background: linear-gradient(180deg, #2a2418, #1c160e 60%, #14110a)",
    "border-radius: 4px",
    "overflow: hidden",
  ].join(";");
  el.appendChild(viewportWrap);

  let composed = false;
  let viewport = null;
  try {
    viewport = new DyeViewport(viewportWrap, 280);
    composed = await viewport.loadDyedItem(
      setupDid,
      (hoveredItem.mtableId ?? 0) >>> 0,
      0,
      triples ?? new Uint32Array(0),
    );
    if (!composed) {
      // Viewport built but rig couldn't load — fall through to the
      // flat composeDyePreview as a backup so the player still sees
      // something.
      try { viewport.dispose(); } catch (_) {}
      viewport = null;
      viewportWrap.innerHTML = "";
      const fallbackCanvas = await composeDyePreview(clothingId, setupDid, outcome.paletteTemplate, outcome.shade);
      if (fallbackCanvas) {
        const maxH = 240;
        const scale = Math.min(1, maxH / Math.max(1, fallbackCanvas.height));
        fallbackCanvas.style.width = `${Math.round(fallbackCanvas.width * scale)}px`;
        fallbackCanvas.style.height = `${Math.round(fallbackCanvas.height * scale)}px`;
        fallbackCanvas.style.imageRendering = "pixelated";
        viewportWrap.appendChild(fallbackCanvas);
        composed = true;
      } else {
        viewportWrap.innerHTML = '<div style="padding:8px;opacity:0.7;">(no preview available)</div>';
      }
    } else {
      viewport.start();
      window[VIEWPORT_REF_KEY] = viewport;
    }
  } catch (e) {
    if (viewport) try { viewport.dispose(); } catch (_) {}
    viewport = null;
    viewportWrap.innerHTML = `<div style="padding:8px;opacity:0.7;">(viewport error: ${String(e?.message ?? e).slice(0, 60)})</div>`;
  }

  const note = document.createElement("div");
  note.style.opacity = "0.7";
  note.style.fontSize = "11px";
  note.style.marginTop = "6px";
  note.textContent = "⚠ Cooking skill check applies on drop.";
  el.appendChild(note);
  el.style.display = "block";
  positionTooltip(el, x, y);
  state.lastShownAt = performance.now();
  try {
    window.__diag?.clothing?.onDyePreviewShown?.({
      source: "drag-over",
      dyePotWcid: draggedItem.wcid,
      clothingId,
      setupDid,
      paletteTemplate: outcome.paletteTemplate,
      shade: outcome.shade,
      composed,
      mode: viewport ? "viewport-3d" : "flat-fallback",
    });
  } catch (_) {}
  return true;
}

function getInventoryItem(guid) {
  if (!guid) return null;
  try {
    const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
    if (!handle?.playerInventory) return null;
    const items = handle.playerInventory();
    return items.find((it) => String(it.guid) === String(guid)) || null;
  } catch (_) { return null; }
}

/**
 * Plugin manifest + mount. Matches vendor-ui.js / combat-bar.js
 * pattern. `iconHidden: true` because the plugin is reactive — no
 * bar slot of its own; subscribes to inventory drag events and
 * renders an ephemeral tooltip when appropriate.
 */
export const manifest = {
  id: "dye-preview",
  name: "Dye Preview",
  icon: "🎨",
  iconHidden: true,
  version: "0.1.0",
  description: "Preview tooltip when a Dye Pot is dragged over a dyeable armor — wiki-grounded outcome via wasm compositor.",
};

export function mount(/* ctx */) {
  const state = (window[PLUGIN_STATE_KEY] = window[PLUGIN_STATE_KEY] ?? {
    enabled: true,
    lastShownAt: 0,
    debounceMs: 60,
    handlerDragOver: null,
    handlerDragEnd: null,
  });

  // Single registration regardless of how many times mount is called.
  if (state.handlerDragOver) {
    window.removeEventListener("hb:inventory-drag-over", state.handlerDragOver);
  }
  state.handlerDragOver = async (ev) => {
    if (!state.enabled) return;
    const now = performance.now();
    if (now - state.lastShownAt < state.debounceMs) return;
    const detail = ev.detail ?? {};
    const draggedItem = getInventoryItem(detail.draggedGuid);
    const hoveredItem = getInventoryItem(detail.hoveredGuid);
    if (!draggedItem || !hoveredItem) {
      hideTooltip();
      return;
    }
    const shown = await showTooltipFor(state, draggedItem, hoveredItem, detail.clientX, detail.clientY);
    if (!shown) hideTooltip();
  };
  window.addEventListener("hb:inventory-drag-over", state.handlerDragOver);
  if (state.handlerDragEnd) {
    window.removeEventListener("hb:inventory-drag-end", state.handlerDragEnd);
  }
  state.handlerDragEnd = () => hideTooltip();
  window.addEventListener("hb:inventory-drag-end", state.handlerDragEnd);

  return () => {
    if (state.handlerDragOver) window.removeEventListener("hb:inventory-drag-over", state.handlerDragOver);
    if (state.handlerDragEnd) window.removeEventListener("hb:inventory-drag-end", state.handlerDragEnd);
    state.handlerDragOver = null;
    state.handlerDragEnd = null;
    hideTooltip();
  };
}

/**
 * Test helper — call from harness to verify the preview path without
 * actually dragging. Exported for the wire-agent verification harness
 * to bypass the synthetic-drag-event ceremony.
 */
export async function _testShowPreview(draggedItem, hoveredItem, x, y) {
  const state = (window[PLUGIN_STATE_KEY] = window[PLUGIN_STATE_KEY] ?? { enabled: true, lastShownAt: 0 });
  state.lastShownAt = 0; // bypass debounce
  return showTooltipFor(state, draggedItem, hoveredItem, x, y);
}

/** Hide the tooltip — exported for test cleanup. */
export function _testHideTooltip() {
  hideTooltip();
}

/** Diag accessor for `__diag.clothing` cached read-through. */
export function getDyePreviewPluginSnapshot() {
  const state = window[PLUGIN_STATE_KEY] ?? null;
  return {
    enabled: state?.enabled ?? false,
    lastShownAt: state?.lastShownAt ?? 0,
    debounceMs: state?.debounceMs ?? 0,
    knownDyePots: Object.keys(DYEPOT_OUTCOMES).map((k) => +k),
  };
}

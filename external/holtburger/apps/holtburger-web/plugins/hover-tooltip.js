// Rec #193 — hover tooltip (E08 picking/target cursor feedback).
//
// Low-latency popup that surfaces just-enough info on the entity under
// the cursor: name (always when known), level + health for creatures,
// ql + workmanship for items. Stays cheap: a single throttled mousemove
// listener, a single 400 ms rest-timer, and one <div> reused for all
// tooltips. Full Examine is still a click-through; this is the at-a-
// glance variant retail HoverObject_ui uses for cursor feedback.
//
// Data sources:
//   - window.__pickEntityAt(x, y) → guid|0 (picking.js, scene3d)
//   - window.liveScene3d.entityManager.entityMap.get(guid).meta — name,
//     and any optional fields the spawn-time ObjectCreate / Examine
//     replies populated (level, currentHealth, maxHealth, ql, work).
//
// Events:
//   - emits `hoverEntity` with { guid, name, source: "tooltip" } on
//     entity-rest and `hoverEntity` with { guid: 0 } on dismiss.
//
// Behaviour:
//   - Cursor at rest 400 ms over a known entity → tooltip appears.
//   - Cursor moves more than 4 px → re-arm the rest timer (debounced).
//   - Cursor leaves canvas, mouse-down anywhere, or Esc → dismiss.
//   - When entity meta lacks name (PVS-bare entity), no tooltip; the
//     hoverEntity bus event still fires with guid for plugin polish.
//
// HUD overhaul 2026-10-05:
//   - retail ToolTip_ObjectName chrome (layout 0x21000041: the 0x06004CC2
//     dark field) via the kit's `.hbk-tooltip`, serif text instead of the
//     old monospace, a small health meter instead of "HP 12 / 40".
//   - ZOOM-AWARE placement. `#hb-hover-tooltip` is a zoomed HUD root
//     (ui/hud_scale.js), so the screen-px pointer is converted with
//     hudPoint() and the box is clamped/flipped inside hudViewport() —
//     it now sits exactly beside the pointer at any HUD scale and never
//     leaves the screen (previously it drifted to (x·s, y·s) and fell
//     off the right/bottom edge at scale > 1).
//   - `placeNearPointer` is the shared pure placement rule (the right-
//     click menu in radial-menu.js uses it too); see
//     test_hud_popup_placement.mjs.

import { hudPoint, hudViewport, getHudScale } from "../ui/hud_scale.js";

const TOOLTIP_ID = "hb-hover-tooltip";
const STYLE_ID = "hb-hover-tooltip-style";
const HOVER_DELAY_MS = 400;
const MOVE_REARM_PX = 4;
// Cursor-relative offset (HUD px): right of and below the arrow tip so
// the pointer never covers the text.
const TIP_OFFSET_X = 14;
const TIP_OFFSET_Y = 18;
const EDGE_MARGIN = 4;

/**
 * Place a `w`×`h` box next to a pointer at (`px`, `py`) inside a
 * `vw`×`vh` viewport — all in the SAME (HUD) units. The box goes at
 * (px + dx, py + dy); if that overflows the right/bottom edge it flips
 * to the other side of the pointer (left: px − dx − w, above:
 * py − dy − h), and the result is finally clamped to [margin, v − size −
 * margin] so it can never leave the viewport (a box larger than the
 * viewport pins to the top/left margin).
 *
 * @returns {{x: number, y: number, flippedX: boolean, flippedY: boolean}}
 */
export function placeNearPointer(px, py, w, h, vw, vh, { dx = TIP_OFFSET_X, dy = TIP_OFFSET_Y, margin = EDGE_MARGIN } = {}) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  let x = px + dx;
  let y = py + dy;
  let flippedX = false;
  let flippedY = false;
  if (x + w + margin > vw) { x = px - dx - w; flippedX = true; }
  if (y + h + margin > vh) { y = py - dy - h; flippedY = true; }
  x = clamp(x, margin, Math.max(margin, vw - w - margin));
  y = clamp(y, margin, Math.max(margin, vh - h - margin));
  return { x, y, flippedX, flippedY };
}

/** Pure: entity meta → tooltip model, or null when there is no name. */
export function tooltipModel(meta) {
  if (!meta) return null;
  const name = (typeof meta.name === "string" && meta.name.length > 0) ? meta.name : null;
  if (!name) return null;
  const model = { name, level: null, health: null, lines: [] };
  const lvl = Number(meta.level);
  if (Number.isFinite(lvl) && lvl > 0) model.level = lvl;
  const cur = Number(meta.currentHealth);
  const max = Number(meta.maxHealth);
  if (Number.isFinite(cur) && Number.isFinite(max) && max > 0) {
    model.health = { cur: Math.max(0, cur), max, fraction: Math.max(0, Math.min(1, cur / max)) };
  }
  const ql = Number(meta.ql);
  if (Number.isFinite(ql) && ql > 0) model.lines.push(`Quality ${ql}`);
  const work = Number(meta.workmanship);
  if (Number.isFinite(work) && work > 0) model.lines.push(`Workmanship ${work.toFixed(2)}`);
  return model;
}

let _root = null;
let _restTimer = null;
let _lastX = -1, _lastY = -1;
let _currentGuid = 0;
let _client = null;
let _mounted = false;
let _onMove = null;
let _onLeave = null;
let _onDown = null;
let _onKey = null;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${TOOLTIP_ID} {
      z-index: 9000;
      display: none;
      min-width: 90px;
      max-width: min(280px, calc(90 * var(--hb-hud-vw, 1vw)));
      line-height: 1.3;
      text-shadow: 0 1px 0 #000;
    }
    #${TOOLTIP_ID} .hb-tip-name {
      display: flex; align-items: baseline; gap: 8px;
      color: var(--hbk-gold-bright);
      font-size: 12px;
      white-space: nowrap;
    }
    #${TOOLTIP_ID} .hb-tip-name > span:first-child { overflow: hidden; text-overflow: ellipsis; }
    #${TOOLTIP_ID} .hb-tip-level { margin-left: auto; color: var(--hbk-text-dim); font-size: 11px; }
    #${TOOLTIP_ID} .hbk-meter { height: 8px; margin-top: 3px; }
    #${TOOLTIP_ID} .hb-tip-line { color: var(--hbk-text); font-size: 11px; white-space: nowrap; }
  `;
  document.head.appendChild(s);
}

function ensureRoot() {
  if (_root && document.body && document.body.contains(_root)) return _root;
  if (typeof document === "undefined") return null;
  ensureStyles();
  const el = document.createElement("div");
  el.id = TOOLTIP_ID;
  el.className = "hbk-tooltip";
  el.setAttribute("role", "tooltip");
  document.body.appendChild(el);
  _root = el;
  return _root;
}

function lookupEntityMeta(guid) {
  if (!guid) return null;
  const em = window.liveScene3d?.entityManager;
  if (!em) return null;
  const inst = em.entityMap?.get?.(guid) || em.entityMap?.get?.(String(guid));
  return inst?.meta ?? null;
}

function renderModel(el, model) {
  el.textContent = "";
  const head = document.createElement("div");
  head.className = "hb-tip-name";
  const n = document.createElement("span");
  n.textContent = model.name;
  head.appendChild(n);
  if (model.level != null) {
    const l = document.createElement("span");
    l.className = "hb-tip-level";
    l.textContent = `Level ${model.level}`;
    head.appendChild(l);
  }
  el.appendChild(head);
  if (model.health) {
    const m = document.createElement("div");
    m.className = "hbk-meter";
    m.title = `Health ${model.health.cur} / ${model.health.max}`;
    const f = document.createElement("div");
    f.className = "hbk-meter-fill";
    f.style.setProperty("--hbk-fill", `${(model.health.fraction * 100).toFixed(1)}%`);
    m.appendChild(f);
    el.appendChild(m);
  }
  for (const line of model.lines) {
    const d = document.createElement("div");
    d.className = "hb-tip-line";
    d.textContent = line;
    el.appendChild(d);
  }
}

function showTooltip(screenX, screenY, model, guid) {
  const el = ensureRoot();
  if (!el) return;
  renderModel(el, model);
  el.style.left = "0px";
  el.style.top = "0px";
  el.style.display = "block";
  // Measure in HUD px (the root is zoomed by --hb-ui-scale), then place.
  const s = Number(el.currentCSSZoom) || getHudScale() || 1;
  const r = el.getBoundingClientRect();
  const p = hudPoint({ clientX: screenX, clientY: screenY });
  const vp = hudViewport();
  const pos = placeNearPointer(p.x, p.y, r.width / s, r.height / s, vp.width, vp.height);
  el.style.left = `${Math.round(pos.x)}px`;
  el.style.top = `${Math.round(pos.y)}px`;
  _currentGuid = guid >>> 0;
  try { _client?.events?.emit?.("hoverEntity", { guid: _currentGuid, name: model.name, source: "tooltip" }); } catch (_) {}
}

function hideTooltip(emitBus = true) {
  if (_root) _root.style.display = "none";
  if (_restTimer) { clearTimeout(_restTimer); _restTimer = null; }
  if (emitBus && _currentGuid !== 0) {
    try { _client?.events?.emit?.("hoverEntity", { guid: 0 }); } catch (_) {}
  }
  _currentGuid = 0;
}

function armRestTimer(x, y) {
  if (_restTimer) clearTimeout(_restTimer);
  _restTimer = setTimeout(() => {
    _restTimer = null;
    if (typeof window.__pickEntityAt !== "function") return;
    // A right-click menu is up — it already names the thing.
    if (window.__radialMenuOpen) return;
    let guid = 0;
    try { guid = window.__pickEntityAt(x, y) >>> 0; } catch (_) { return; }
    if (!guid) { hideTooltip(); return; }
    const model = tooltipModel(lookupEntityMeta(guid));
    if (!model) {
      // No name yet — emit the guid so other plugins can react, but
      // don't paint a tooltip with no content.
      try { _client?.events?.emit?.("hoverEntity", { guid, name: null, source: "tooltip" }); } catch (_) {}
      hideTooltip(false);
      return;
    }
    showTooltip(x, y, model, guid);
  }, HOVER_DELAY_MS);
}

export const manifest = {
  id: "hover-tooltip",
  name: "Hover Tooltip",
  icon: "?",
  iconHidden: true,
  version: "0.2.0",
  description: "Low-latency popup with entity name / level / HP / quality on cursor rest.",
};

export function mount(ctx) {
  if (_mounted || typeof window === "undefined") return () => {};
  _mounted = true;
  _client = ctx?.client ?? window.__pluginClient ?? null;

  _onMove = (ev) => {
    const dx = ev.clientX - _lastX;
    const dy = ev.clientY - _lastY;
    if (Math.abs(dx) < MOVE_REARM_PX && Math.abs(dy) < MOVE_REARM_PX && _restTimer) return;
    _lastX = ev.clientX; _lastY = ev.clientY;
    if (_currentGuid !== 0) hideTooltip();
    armRestTimer(ev.clientX, ev.clientY);
  };
  _onLeave = () => hideTooltip();
  _onDown = () => hideTooltip();
  _onKey = (ev) => { if (ev.key === "Escape") hideTooltip(); };

  // Attach to the canvas (or fallback to window when canvas not yet
  // mounted — the listener guards on __pickEntityAt anyway).
  const canvas = document.querySelector("canvas") || window;
  canvas.addEventListener("mousemove", _onMove, { passive: true });
  canvas.addEventListener("mouseleave", _onLeave, { passive: true });
  window.addEventListener("mousedown", _onDown, true);
  window.addEventListener("keydown", _onKey, true);

  return () => {
    try { canvas.removeEventListener("mousemove", _onMove); } catch (_) {}
    try { canvas.removeEventListener("mouseleave", _onLeave); } catch (_) {}
    try { window.removeEventListener("mousedown", _onDown, true); } catch (_) {}
    try { window.removeEventListener("keydown", _onKey, true); } catch (_) {}
    hideTooltip(false);
    if (_root && _root.parentNode) _root.parentNode.removeChild(_root);
    _root = null;
    _mounted = false;
    _client = null;
    _lastX = _lastY = -1;
    _currentGuid = 0;
  };
}

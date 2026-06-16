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

const TOOLTIP_ID = "hb-hover-tooltip";
const HOVER_DELAY_MS = 400;
const MOVE_REARM_PX = 4;

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

function ensureRoot() {
  if (_root && document.body && document.body.contains(_root)) return _root;
  if (typeof document === "undefined") return null;
  const el = document.createElement("div");
  el.id = TOOLTIP_ID;
  el.style.cssText = [
    "position:fixed", "pointer-events:none", "display:none",
    "z-index:2147483646",
    "background:rgba(20,20,24,0.92)", "color:#f6e8c1",
    "border:1px solid #6a583c", "border-radius:3px",
    "padding:3px 6px", "font:11px/1.3 monospace",
    "max-width:300px", "white-space:nowrap",
    "box-shadow:0 2px 6px rgba(0,0,0,0.6)",
    "text-shadow:0 1px 0 rgba(0,0,0,0.7)",
  ].join(";");
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

function formatTooltip(meta) {
  if (!meta) return null;
  const name = (typeof meta.name === "string" && meta.name.length > 0) ? meta.name : null;
  if (!name) return null;
  const lines = [name];
  const lvl = Number(meta.level);
  if (Number.isFinite(lvl) && lvl > 0) {
    lines[lines.length - 1] += `  L${lvl}`;
  }
  const cur = Number(meta.currentHealth);
  const max = Number(meta.maxHealth);
  if (Number.isFinite(cur) && Number.isFinite(max) && max > 0) {
    lines.push(`HP ${cur} / ${max}`);
  }
  const ql = Number(meta.ql);
  if (Number.isFinite(ql) && ql > 0) {
    lines.push(`Quality ${ql}`);
  }
  const work = Number(meta.workmanship);
  if (Number.isFinite(work) && work > 0) {
    lines.push(`Workmanship ${work.toFixed(2)}`);
  }
  return lines.join("\n");
}

function showTooltip(x, y, text, guid) {
  const el = ensureRoot();
  if (!el) return;
  el.textContent = text;
  el.style.left = `${Math.min(window.innerWidth - 8, x + 14)}px`;
  el.style.top  = `${Math.min(window.innerHeight - 8, y + 18)}px`;
  el.style.display = "block";
  _currentGuid = guid >>> 0;
  try { _client?.events?.emit?.("hoverEntity", { guid: _currentGuid, name: text.split("\n", 1)[0], source: "tooltip" }); } catch (_) {}
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
    let guid = 0;
    try { guid = window.__pickEntityAt(x, y) >>> 0; } catch (_) { return; }
    if (!guid) { hideTooltip(); return; }
    const meta = lookupEntityMeta(guid);
    const text = formatTooltip(meta);
    if (!text) {
      // No name yet — emit the guid so other plugins can react, but
      // don't paint a tooltip with no content.
      try { _client?.events?.emit?.("hoverEntity", { guid, name: null, source: "tooltip" }); } catch (_) {}
      hideTooltip(false);
      return;
    }
    showTooltip(x, y, text, guid);
  }, HOVER_DELAY_MS);
}

export const manifest = {
  id: "hover-tooltip",
  name: "Hover Tooltip",
  icon: "?",
  iconHidden: true,
  version: "0.1.0",
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

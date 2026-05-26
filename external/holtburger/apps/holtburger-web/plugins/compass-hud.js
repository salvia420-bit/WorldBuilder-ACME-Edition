// Compass HUD overlay — top-center scrolling heading tape.
//
// Retail had a small N/S/E/W indicator at the top-center of the HUD; this
// is a reconstruction styled to match the AC aesthetic (brass border +
// cream text + serif font). Reads camera heading from
// `liveScene3d.cameraSwitcher.followYaw` (radians, 0 = north, π/2 = east)
// and scrolls the tape so the current heading sits centred.
//
// URL knob: `?compass=off` hides the overlay.
// Window hook: `window.__compassHud = { setVisible(bool) }`.

const OVERLAY_ID = "hb-compass-hud";
const RADAR_ID = "hb-compass-radar";
const TOOLTIP_ID = "hb-compass-radar-tooltip";
const WIDTH = 200;
const HEIGHT = 16;
// Pixels per degree on the tape. Spec says the strip is 200px wide and
// shows roughly 60° of heading (W..NW..N..NE..E visible at once), so
// each degree ≈ 3.33px. Tweaking this changes "tape zoom".
const PX_PER_DEG = 200 / 60;
const TAPE_TOTAL_DEG = 360;
const TAPE_INNER_WIDTH_PX = TAPE_TOTAL_DEG * PX_PER_DEG;

const RADAR_HEIGHT = 40;
const RADAR_WIDTH = WIDTH;
const RADAR_FOV_RAD = Math.PI / 2; // ±90° forward arc maps to full strip width
const MAX_RADAR_RANGE = 50;        // metres
const MAX_DOTS = 30;
const ODF_PLAYER = 0x00000008;
const ODF_VENDOR = 0x00000010;

const CARDINALS = [
  { deg: 0,   label: "N" },
  { deg: 45,  label: "NE" },
  { deg: 90,  label: "E" },
  { deg: 135, label: "SE" },
  { deg: 180, label: "S" },
  { deg: 225, label: "SW" },
  { deg: 270, label: "W" },
  { deg: 315, label: "NW" },
];

const HIDDEN_BY_URL = (() => {
  try {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("compass") === "off";
  } catch (_) { return false; }
})();

const RADAR_HIDDEN_BY_URL = (() => {
  try {
    if (typeof window === "undefined") return true;
    if (HIDDEN_BY_URL) return true;
    return new URLSearchParams(window.location.search).get("compassRadar") === "off";
  } catch (_) { return false; }
})();

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "hb-compass-hud-style";
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      top: 4px;
      left: 50%;
      transform: translateX(-50%);
      width: ${WIDTH}px;
      height: ${HEIGHT}px;
      z-index: 50;
      pointer-events: none;
      background: var(--hb-overlay-dark-deep, rgba(0,0,0,0.4));
      border: 1px solid var(--hb-border-brass, #8a7544);
      box-shadow: 0 1px 0 var(--hb-border-brass-deep, #5a4a28) inset,
                  0 0 2px rgba(0,0,0,0.6);
      overflow: hidden;
      font-family: var(--hb-font-serif, "Cinzel", "Trajan Pro", "Times New Roman", serif);
      color: var(--hb-text-cream, #f0d8a0);
    }
    #${OVERLAY_ID}[hidden] { display: none; }
    /* Inner tape — wider than the overlay; transformed by JS each frame
       so the current heading sits at the centre. */
    #${OVERLAY_ID} .hb-compass-tape {
      position: absolute;
      top: 0;
      left: 0;
      width: ${TAPE_INNER_WIDTH_PX}px;
      height: 100%;
      will-change: transform;
    }
    #${OVERLAY_ID} .hb-compass-tick {
      position: absolute;
      bottom: 0;
      width: 1px;
      background: var(--hb-text-cream, #f0d8a0);
    }
    #${OVERLAY_ID} .hb-compass-tick.minor { height: 4px; opacity: 0.55; }
    #${OVERLAY_ID} .hb-compass-tick.diag  { height: 7px; opacity: 0.85; }
    #${OVERLAY_ID} .hb-compass-tick.cardinal { height: 9px; opacity: 1.0; }
    #${OVERLAY_ID} .hb-compass-label {
      position: absolute;
      top: 0;
      transform: translateX(-50%);
      font-size: 10px;
      font-weight: 700;
      line-height: ${HEIGHT}px;
      text-shadow: 0 0 2px rgba(0,0,0,0.9), 0 1px 0 #000;
      letter-spacing: 0.5px;
    }
    /* Centre crosshair — the heading indicator. Two thin lines forming
       a downward chevron over the tape. */
    #${OVERLAY_ID} .hb-compass-cursor {
      position: absolute;
      top: 0; bottom: 0;
      left: 50%;
      width: 1px;
      background: #ffd76a;
      box-shadow: 0 0 3px #ffd76a, 0 0 1px #fff;
      transform: translateX(-0.5px);
      opacity: 0.95;
    }
    #${RADAR_ID} {
      position: fixed;
      top: ${4 + HEIGHT + 1}px;
      left: 50%;
      transform: translateX(-50%);
      width: ${RADAR_WIDTH}px;
      height: ${RADAR_HEIGHT}px;
      z-index: 49;
      pointer-events: none;
      background: var(--hb-overlay-dark-deep, rgba(0,0,0,0.34));
      border: 1px solid var(--hb-border-brass, #8a7544);
      box-shadow: 0 1px 0 var(--hb-border-brass-deep, #5a4a28) inset,
                  0 0 2px rgba(0,0,0,0.6);
      overflow: hidden;
    }
    #${RADAR_ID}[hidden] { display: none; }
    #${RADAR_ID} .hb-radar-centerline {
      position: absolute;
      left: 0; right: 0;
      top: 50%;
      height: 1px;
      background: var(--hb-border-brass-deep, #5a4a28);
      opacity: 0.45;
      transform: translateY(-0.5px);
    }
    #${RADAR_ID} .hb-radar-cursor {
      position: absolute;
      top: 0; bottom: 0;
      left: 50%;
      width: 1px;
      background: rgba(255, 215, 106, 0.35);
      transform: translateX(-0.5px);
    }
    #${RADAR_ID} .hb-radar-dot {
      position: absolute;
      width: 3px;
      height: 3px;
      border-radius: 50%;
      transform: translate(-50%, -50%);
      will-change: left, top, opacity;
      pointer-events: auto;
      cursor: pointer;
    }
    #${RADAR_ID} .hb-radar-dot.hb-radar-dot-pulse {
      transform: translate(-50%, -50%) scale(1.8);
      transition: transform 200ms ease-out;
    }
    #${TOOLTIP_ID} {
      position: fixed;
      z-index: 51;
      pointer-events: none;
      padding: 3px 6px;
      background: var(--hb-overlay-dark-deep, rgba(0,0,0,0.78));
      border: 1px solid var(--hb-border-brass, #8a7544);
      box-shadow: 0 1px 0 var(--hb-border-brass-deep, #5a4a28) inset,
                  0 0 3px rgba(0,0,0,0.7);
      font-family: var(--hb-font-serif, "Cinzel", "Trajan Pro", "Times New Roman", serif);
      color: var(--hb-text-cream, #f0d8a0);
      font-size: 11px;
      line-height: 1.2;
      white-space: nowrap;
      transform: translateX(-50%);
      text-shadow: 0 0 2px rgba(0,0,0,0.9), 0 1px 0 #000;
    }
    #${TOOLTIP_ID}[hidden] { display: none; }
  `;
  document.head.appendChild(style);
}

function buildTape(tapeEl) {
  // 15° minor ticks. Skip ticks that coincide with diagonal/cardinal
  // marks; those get their own taller stroke.
  for (let d = 0; d < 360; d += 15) {
    const isCardinal = d % 90 === 0;
    const isDiag = d % 45 === 0 && !isCardinal;
    if (isCardinal || isDiag) continue;
    const tick = document.createElement("div");
    tick.className = "hb-compass-tick minor";
    tick.style.left = `${d * PX_PER_DEG}px`;
    tapeEl.appendChild(tick);
  }
  for (const card of CARDINALS) {
    const isCardinal = card.deg % 90 === 0;
    const tick = document.createElement("div");
    tick.className = isCardinal ? "hb-compass-tick cardinal" : "hb-compass-tick diag";
    tick.style.left = `${card.deg * PX_PER_DEG}px`;
    tapeEl.appendChild(tick);
    const label = document.createElement("div");
    label.className = "hb-compass-label";
    label.style.left = `${card.deg * PX_PER_DEG}px`;
    label.textContent = card.label;
    tapeEl.appendChild(label);
  }
}

let _overlayEl = null;
let _tapeEl = null;
let _radarEl = null;
let _radarDotPool = [];
let _dotEntityRefs = [];
let _tooltipEl = null;
let _hoveredDotIdx = -1;
let _rafId = 0;
let _disposed = false;

// Category → dot color. Players white, creatures (incl. monsters) red,
// NPCs/Vendors green. Items/containers/statics are filtered out before
// reaching this map.
const DOT_COLORS = Object.freeze({
  player:   "#ffffff",
  creature: "#ff4040",
  npc:      "#40d060",
  vendor:   "#40d060",
});

function classifyEntityForRadar(guid, inst) {
  try {
    const wo = window.__wom?.get?.(guid >>> 0);
    const cls = wo?.canonicalObjectClass || wo?.className;
    if (cls === "Player") return "player";
    if (cls === "Vendor") return "vendor";
    if (cls === "Npc") return "npc";
    if (cls === "Creature" || cls === "Monster") return "creature";
  } catch (_) {}
  const meta = inst?.meta || {};
  const odf = (meta.objDescFlags >>> 0) || 0;
  if (odf & ODF_PLAYER) return "player";
  if (odf & ODF_VENDOR) return "vendor";
  if (meta.category === "creature") return "creature";
  return null;
}

function ensureDotPool() {
  if (!_radarEl) return;
  while (_radarDotPool.length < MAX_DOTS) {
    const d = document.createElement("div");
    d.className = "hb-radar-dot";
    d.style.display = "none";
    _radarEl.appendChild(d);
    _radarDotPool.push(d);
  }
}

function updateRadarDots(playerPos, yawRad) {
  if (!_radarEl || _radarEl.hidden) return;
  const em = window.liveScene3d?.entityManager;
  const map = em?.entityMap;
  if (!map || !playerPos) {
    for (const d of _radarDotPool) d.style.display = "none";
    return;
  }
  const localGuid = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;

  // Collect candidates within range + in front (|relBearing| ≤ FOV).
  // AC frame: x=east, y=north. Bearing 0 = +y, +π/2 = +x.
  const candidates = [];
  const cosYaw = Math.cos(yawRad);
  const sinYaw = Math.sin(yawRad);
  for (const [guid, inst] of map) {
    const g = (guid >>> 0);
    if (g === localGuid) continue;
    const pos = inst?.root?.position;
    if (!pos) continue;
    const dx = pos.x - playerPos.x;
    const dy = pos.y - playerPos.y;
    const dist = Math.hypot(dx, dy);
    if (dist > MAX_RADAR_RANGE || dist < 0.01) continue;
    // Rotate world delta into player-relative frame (yaw rotates the
    // forward axis clockwise from +y). Forward distance fy along
    // player-heading axis; lateral fx orthogonal-right.
    const fx = cosYaw * dx - sinYaw * dy;
    const fy = sinYaw * dx + cosYaw * dy;
    if (fy <= 0) continue; // behind camera — clip
    const relBearing = Math.atan2(fx, fy); // -π..π, sign: + = right
    if (Math.abs(relBearing) > RADAR_FOV_RAD) continue;
    const kind = classifyEntityForRadar(g, inst);
    if (!kind) continue;
    candidates.push({ relBearing, dist, kind, guid: g, inst });
  }

  // Sort by distance ascending so closest entities take dot-pool priority.
  candidates.sort((a, b) => a.dist - b.dist);

  ensureDotPool();
  const n = Math.min(candidates.length, _radarDotPool.length);
  for (let i = 0; i < n; i++) {
    const c = candidates[i];
    const d = _radarDotPool[i];
    const x = RADAR_WIDTH / 2 + (c.relBearing / RADAR_FOV_RAD) * (RADAR_WIDTH / 2);
    // Map distance to vertical: near → bottom (closer to player marker),
    // far → top. Player sits at the centerline horizontally.
    const y = RADAR_HEIGHT - 2 - (1 - c.dist / MAX_RADAR_RANGE) * (RADAR_HEIGHT - 6);
    const alpha = Math.max(0.15, 1 - c.dist / MAX_RADAR_RANGE);
    d.style.display = "block";
    d.style.left = `${x}px`;
    d.style.top = `${y}px`;
    d.style.background = DOT_COLORS[c.kind] || "#ffffff";
    d.style.opacity = String(alpha);
    d.style.boxShadow = `0 0 2px ${DOT_COLORS[c.kind] || "#ffffff"}`;
    _dotEntityRefs[i] = { guid: c.guid, inst: c.inst, relBearing: c.relBearing, dist: c.dist };
  }
  for (let i = n; i < _radarDotPool.length; i++) {
    _radarDotPool[i].style.display = "none";
    _dotEntityRefs[i] = null;
  }
  if (_hoveredDotIdx >= 0 && _hoveredDotIdx < n) {
    positionAndFillTooltip(_hoveredDotIdx);
  } else if (_hoveredDotIdx >= n) {
    hideTooltip();
    _hoveredDotIdx = -1;
  }
}

function getLocalPlayerAcPos() {
  try {
    const em = window.liveScene3d?.entityManager;
    const lpg = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;
    if (!lpg) return null;
    const inst = em?.entityMap?.get?.(lpg);
    const p = inst?.root?.position;
    if (!p) return null;
    return { x: p.x, y: p.y, z: p.z };
  } catch (_) { return null; }
}

function tickCompass() {
  if (_disposed) return;
  _rafId = window.requestAnimationFrame(tickCompass);
  if (!_overlayEl || _overlayEl.hidden || !_tapeEl) return;
  let yaw = 0;
  try {
    const live = window.liveScene3d;
    yaw = live?.cameraSwitcher?.followYaw ?? 0;
  } catch (_) {}
  // followYaw: radians, 0 = facing AC +Y (north), π/2 = facing +X (east).
  // → degrees, normalized to [0, 360).
  let deg = (yaw * 180) / Math.PI;
  deg = ((deg % 360) + 360) % 360;
  const offset = WIDTH / 2 - deg * PX_PER_DEG;
  _tapeEl.style.transform = `translateX(${offset}px)`;

  if (_radarEl && !_radarEl.hidden) {
    const playerPos = getLocalPlayerAcPos();
    updateRadarDots(playerPos, yaw);
  }
}

function ensureTooltip() {
  if (_tooltipEl) return _tooltipEl;
  const t = document.createElement("div");
  t.id = TOOLTIP_ID;
  t.hidden = true;
  document.body.appendChild(t);
  _tooltipEl = t;
  return t;
}

function entityDisplayName(ref) {
  const inst = ref?.inst;
  const m = inst?.meta;
  if (m && typeof m.name === "string" && m.name.length > 0) return m.name;
  const rn = inst?.root?.name;
  if (typeof rn === "string" && rn.length > 0) return rn;
  return `0x${(ref?.guid >>> 0).toString(16).padStart(8, "0")}`;
}

function positionAndFillTooltip(idx) {
  const ref = _dotEntityRefs[idx];
  const dot = _radarDotPool[idx];
  if (!ref || !dot || !_radarEl || _radarEl.hidden) {
    hideTooltip();
    return;
  }
  const t = ensureTooltip();
  const name = entityDisplayName(ref);
  const distM = ref.dist.toFixed(1);
  const bearingDeg = Math.round((ref.relBearing * 180) / Math.PI);
  const bearingStr = bearingDeg > 0 ? `+${bearingDeg}` : `${bearingDeg}`;
  t.textContent = `${name} • ${distM}m • ${bearingStr}°`;
  // Anchor to dot center, just above the radar strip.
  const radarRect = _radarEl.getBoundingClientRect();
  const dotLeftPx = parseFloat(dot.style.left) || 0;
  t.hidden = false;
  t.style.left = `${radarRect.left + dotLeftPx}px`;
  t.style.top = `${radarRect.top - 4}px`;
  t.style.transform = "translate(-50%, -100%)";
}

function hideTooltip() {
  if (_tooltipEl) _tooltipEl.hidden = true;
}

function dotIndexFromEvent(ev) {
  const el = ev.target;
  if (!el || !el.classList || !el.classList.contains("hb-radar-dot")) return -1;
  const idx = _radarDotPool.indexOf(el);
  if (idx < 0) return -1;
  if (!_dotEntityRefs[idx]) return -1;
  return idx;
}

function onRadarMouseOver(ev) {
  if (!_radarEl || _radarEl.hidden) return;
  const idx = dotIndexFromEvent(ev);
  if (idx < 0) return;
  _hoveredDotIdx = idx;
  positionAndFillTooltip(idx);
}

function onRadarMouseOut(ev) {
  const idx = dotIndexFromEvent(ev);
  if (idx < 0) return;
  // Only hide if leaving for something that isn't another radar dot.
  const related = ev.relatedTarget;
  if (related && related.classList && related.classList.contains("hb-radar-dot")) return;
  if (_hoveredDotIdx === idx) {
    _hoveredDotIdx = -1;
    hideTooltip();
  }
}

function onRadarClick(ev) {
  if (!_radarEl || _radarEl.hidden) return;
  const idx = dotIndexFromEvent(ev);
  if (idx < 0) return;
  const ref = _dotEntityRefs[idx];
  if (!ref) return;
  try {
    window.liveScene3d?.entityManager?.setSelectedTarget?.(ref.guid >>> 0);
  } catch (_) {}
  const dot = _radarDotPool[idx];
  if (dot) {
    dot.classList.add("hb-radar-dot-pulse");
    window.setTimeout(() => {
      try { dot.classList.remove("hb-radar-dot-pulse"); } catch (_) {}
    }, 200);
  }
}

function mountOverlay() {
  ensureStyles();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  _overlayEl = document.createElement("div");
  _overlayEl.id = OVERLAY_ID;
  if (HIDDEN_BY_URL) _overlayEl.hidden = true;

  // Three tape copies at x = -W, 0, +W (where W = TAPE_INNER_WIDTH_PX).
  // Combined wrapper coverage spans [-W..2W]; with T in
  // [WIDTH/2 - W, WIDTH/2], the visible [0..WIDTH] window always falls
  // inside that span — no gaps at the N seam in either direction.
  const tapeWrapper = document.createElement("div");
  tapeWrapper.style.cssText = `
    position: absolute; top: 0; left: 0;
    width: ${TAPE_INNER_WIDTH_PX * 3}px; height: 100%;
  `;
  for (const x of [-TAPE_INNER_WIDTH_PX, 0, TAPE_INNER_WIDTH_PX]) {
    const tape = document.createElement("div");
    tape.className = "hb-compass-tape";
    tape.style.left = `${x}px`;
    buildTape(tape);
    tapeWrapper.appendChild(tape);
  }
  _tapeEl = tapeWrapper;
  _overlayEl.appendChild(tapeWrapper);

  const cursor = document.createElement("div");
  cursor.className = "hb-compass-cursor";
  _overlayEl.appendChild(cursor);

  document.body.appendChild(_overlayEl);

  // Radar strip — sibling overlay anchored directly below the tape so
  // the tape's overflow-clipping stays intact.
  const existingRadar = document.getElementById(RADAR_ID);
  if (existingRadar) existingRadar.remove();
  _radarEl = document.createElement("div");
  _radarEl.id = RADAR_ID;
  if (RADAR_HIDDEN_BY_URL || HIDDEN_BY_URL) _radarEl.hidden = true;
  const centerline = document.createElement("div");
  centerline.className = "hb-radar-centerline";
  _radarEl.appendChild(centerline);
  const radarCursor = document.createElement("div");
  radarCursor.className = "hb-radar-cursor";
  _radarEl.appendChild(radarCursor);
  _radarDotPool = [];
  _dotEntityRefs = [];
  document.body.appendChild(_radarEl);
  ensureDotPool();
  ensureTooltip();
  _radarEl.addEventListener("mouseover", onRadarMouseOver);
  _radarEl.addEventListener("mouseout", onRadarMouseOut);
  _radarEl.addEventListener("click", onRadarClick);

  _rafId = window.requestAnimationFrame(tickCompass);
}

function setVisible(visible) {
  if (_overlayEl) _overlayEl.hidden = !visible;
  if (_radarEl) {
    // Radar follows tape visibility, but respect the explicit URL opt-out.
    _radarEl.hidden = !visible || RADAR_HIDDEN_BY_URL;
  }
  if (_radarEl?.hidden) { hideTooltip(); _hoveredDotIdx = -1; }
}

function setRadarVisible(visible) {
  if (!_radarEl) return;
  _radarEl.hidden = !visible;
  if (_radarEl.hidden) { hideTooltip(); _hoveredDotIdx = -1; }
}

function unmount() {
  _disposed = true;
  if (_rafId) {
    try { window.cancelAnimationFrame(_rafId); } catch (_) {}
    _rafId = 0;
  }
  if (_radarEl) {
    try {
      _radarEl.removeEventListener("mouseover", onRadarMouseOver);
      _radarEl.removeEventListener("mouseout", onRadarMouseOut);
      _radarEl.removeEventListener("click", onRadarClick);
    } catch (_) {}
  }
  if (_overlayEl && _overlayEl.parentNode) {
    _overlayEl.parentNode.removeChild(_overlayEl);
  }
  if (_radarEl && _radarEl.parentNode) {
    _radarEl.parentNode.removeChild(_radarEl);
  }
  if (_tooltipEl && _tooltipEl.parentNode) {
    _tooltipEl.parentNode.removeChild(_tooltipEl);
  }
  _overlayEl = null;
  _tapeEl = null;
  _radarEl = null;
  _radarDotPool = [];
  _dotEntityRefs = [];
  _tooltipEl = null;
  _hoveredDotIdx = -1;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const boot = () => {
    try { mountOverlay(); } catch (_) {}
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
  window.__compassHud = { setVisible, setRadarVisible, unmount };
}

export { setVisible, setRadarVisible, unmount };

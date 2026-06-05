// Top-right compass/radar disk.
//
// Direct port of retail gmRadarUI (layout 0x21000074, 120x140 panel).
// Element rect data from the layout's StateDesc tree:
//   root          120x140 px
//   disk area     120x120 px at top   (sprite 0x06004CC1)
//   lock button   27x27   at (~4, 6)  (sprite 0x060074B7)
//   move handle   27x27   at (~89, 6) (sprite 0x06006119, brass cross-arrows)
//   N/E/S/W       ~10x9 each at disk edges
//   coords strip  120x18  at y=120    (text — TODO)
//
// Heading rotation: planned. window.getLocalPlayerPose is not yet
// exposed globally — once it is (or once we hook the camera tick), the
// .hb-radar-disk wrapper rotates by `-heading` and the cardinals
// counter-rotate so they stay upright relative to the screen.

import { setAcText } from "../ui/ac_font.js";
import { applyLayoutRegions } from "../ui/ac_layout.js";
import { attachWindowPosition, WINDOW_ID } from "../ui/ac_window_position.js";

const OVERLAY_ID = "hb-radar";
const TOOLTIP_ID = "hb-radar-tooltip";
const WIDTH = 120;
const HEIGHT = 140;
const DISK_SIZE = 120;
const BUTTON_SIZE = 27;

// Blip projection — entities within MAX_RADAR_RANGE metres show as a
// 3px dot at polar (dx, dy) scaled into the disk's effective radius.
// The effective radius leaves ~10px margin so blips don't intrude on
// the brass rim.
const MAX_RADAR_RANGE = 50;
const DOT_RADIUS_PX = (DISK_SIZE / 2) - 10;
const MAX_BLIPS = 32;

// objDescFlags bits used as a fallback when the WO classifier can't
// resolve a canonical class. Mirrors gmRadarUI's flag-based fallback.
const ODF_PLAYER = 0x00000008;
const ODF_VENDOR = 0x00000010;

// Category → dot color. Players white, creatures/monsters red,
// NPCs/Vendors green. Items/containers/statics are filtered out before
// reaching this map. Matches retail gmRadarUI::GetBlipColor.
const DOT_COLORS = Object.freeze({
  player:   "#ffffff",
  creature: "#ff4040",
  npc:      "#40d060",
  vendor:   "#40d060",
});

const RADAR_HOSTILE_ONLY_BY_URL = (() => {
  try {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("radarHostileOnly") === "1";
  } catch (_) { return false; }
})();

/** gmRadarUI — retail layout that drives the radar/compass panel.
 *  Element-id map confirmed by radar_layout_dump 2026-05-24:
 *    0x100006D3 — root (120×140)
 *    0x1000003F — disk area (type=3, 120×120 at 0,0)
 *    0x10000619 — lock button (27×27 at 6,6, 2 states for locked/unlocked)
 *    0x100006A3 — move handle (type=2, 27×27 at 87,6)
 *    0x10000040 — N cardinal (10×9 at 55,1)
 *    0x10000041 — E cardinal (10×9 at 110,55)
 *    0x10000042 — S cardinal (10×9 at 55,110)
 *    0x10000043 — W cardinal (10×9 at 0,55)
 *    0x1000003E — coords strip (120×18 at 0,120)
 */
const RADAR_LAYOUT_ID = 0x21000074;
const RADAR_ELEMS = {
  disk:    0x1000003F,
  lock:    0x10000619,
  move:    0x100006A3,
  n:       0x10000040,
  e:       0x10000041,
  s:       0x10000042,
  w:       0x10000043,
  coords:  0x1000003E,
};

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "hb-radar-style";
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      top: 8px;
      right: 8px;
      z-index: 50;
      width: ${WIDTH}px;
      height: ${HEIGHT}px;
      pointer-events: none;
      font-family: var(--hb-font-serif);
    }
    #${OVERLAY_ID} .hb-radar-disk {
      position: absolute;
      top: 0; left: 0;
      width: ${DISK_SIZE}px;
      height: ${DISK_SIZE}px;
      background: url("./data/ui-sprites/0x06004CC1.png") center/100% 100% no-repeat;
      /* image-rendering: pixelated preserves the brass rim detail when scaled. */
      image-rendering: pixelated;
    }
    /* Heading-rotated layer: cardinals + centre cross live in here so
       they stay aligned to world-space when we wire up pose.heading. */
    #${OVERLAY_ID} .hb-radar-rotor {
      position: absolute;
      top: 0; left: 0;
      width: ${DISK_SIZE}px;
      height: ${DISK_SIZE}px;
      transform: rotate(0deg);
      transform-origin: 50% 50%;
      transition: transform 80ms linear;
    }
    #${OVERLAY_ID} .hb-radar-cardinal {
      position: absolute;
      width: 10px;
      height: 9px;
      background-repeat: no-repeat;
      background-size: contain;
      background-position: center;
      filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.7));
    }
    #${OVERLAY_ID} .hb-radar-n { top: 1px;  left: 50%; transform: translateX(-50%);
                                background-image: url("./data/ui-sprites/0x060011FB.png"); }
    #${OVERLAY_ID} .hb-radar-e { right: 1px; top: 50%; transform: translateY(-50%);
                                background-image: url("./data/ui-sprites/0x06001938.png"); }
    #${OVERLAY_ID} .hb-radar-s { bottom: 1px; left: 50%; transform: translateX(-50%);
                                background-image: url("./data/ui-sprites/0x0600193A.png"); }
    #${OVERLAY_ID} .hb-radar-w { left: 1px;  top: 50%; transform: translateY(-50%);
                                background-image: url("./data/ui-sprites/0x0600193C.png"); }
    #${OVERLAY_ID} .hb-radar-centre {
      position: absolute;
      top: ${DISK_SIZE / 2}px;
      left: ${DISK_SIZE / 2}px;
      width: 14px;
      height: 14px;
      transform: translate(-50%, -50%);
      background: url("./data/ui-sprites/0x060074C9.png") center/contain no-repeat;
      filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.7));
      pointer-events: none;
      z-index: 3;
    }
    /* Field-of-view wedge — translucent green cone pointing where the
       player is looking. Anchored centre, rotates with .hb-radar-rotor
       (which itself rotates by -heading so the wedge stays world-aligned
       to the player's facing). */
    #${OVERLAY_ID} .hb-radar-fov {
      position: absolute;
      top: 50%;
      left: 50%;
      width: 0;
      height: 0;
      transform: translate(-50%, -100%);
      border-left: 24px solid transparent;
      border-right: 24px solid transparent;
      border-bottom: ${DISK_SIZE / 2 - 10}px solid rgba(120, 220, 120, 0.18);
      pointer-events: none;
      z-index: 2;
    }
    /* Chrome overlays — lock + move handle in the upper corners,
       per retail rect data 0x10000619 + 0x100006A3 (both 27x27 at y=6). */
    #${OVERLAY_ID} .hb-radar-lock,
    #${OVERLAY_ID} .hb-radar-move {
      position: absolute;
      top: 6px;
      width: ${BUTTON_SIZE}px;
      height: ${BUTTON_SIZE}px;
      background-repeat: no-repeat;
      background-size: contain;
      background-position: center;
      pointer-events: auto;
      cursor: pointer;
      filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.8));
    }
    #${OVERLAY_ID} .hb-radar-lock {
      left: 4px;
      background-image: url("./data/ui-sprites/0x060074B7.png");
    }
    #${OVERLAY_ID} .hb-radar-move {
      right: 4px;
      background-image: url("./data/ui-sprites/0x06006119.png");
      cursor: move;
    }
    #${OVERLAY_ID} .hb-radar-coords {
      position: absolute;
      top: ${DISK_SIZE}px;
      left: 0;
      width: ${WIDTH}px;
      height: ${HEIGHT - DISK_SIZE}px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--hb-font-serif);
      font-size: 10px;
      color: var(--hb-text-cream);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.85);
      background: transparent;
    }
    #${OVERLAY_ID} .hb-radar-coords:empty::before { content: ""; }
    /* Entity blips — children of .hb-radar-rotor so they rotate with
       the disk. World-frame deltas project to rotor-local pixel
       offsets; the rotor's -heading rotation then puts each blip at
       the correct screen position relative to the player's facing. */
    #${OVERLAY_ID} .hb-radar-blip {
      position: absolute;
      width: 3px;
      height: 3px;
      border-radius: 50%;
      transform: translate(-50%, -50%);
      will-change: left, top, opacity;
      pointer-events: auto;
      cursor: pointer;
      z-index: 4;
    }
    #${OVERLAY_ID} .hb-radar-blip-pulse {
      transform: translate(-50%, -50%) scale(2.2);
      transition: transform 200ms ease-out;
    }
    #${OVERLAY_ID} .hb-radar-hostile-indicator {
      position: absolute;
      top: 122px;
      right: 4px;
      font-family: var(--hb-font-serif, "Cinzel", "Trajan Pro", "Times New Roman", serif);
      font-size: 9px;
      color: var(--hb-text-gold, #ffd76a);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.9);
      pointer-events: none;
      letter-spacing: 0.5px;
      z-index: 5;
    }
    #${OVERLAY_ID} .hb-radar-hostile-indicator[hidden] { display: none; }
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
      transform: translate(-50%, -100%);
      text-shadow: 0 0 2px rgba(0,0,0,0.9), 0 1px 0 #000;
    }
    #${TOOLTIP_ID}[hidden] { display: none; }
    #${TOOLTIP_ID} .hb-radar-tooltip-tag-hostile { color: #ff5050; font-weight: 600; }
    #${TOOLTIP_ID} .hb-radar-tooltip-tag-friendly { color: #ffffff; }
    #${TOOLTIP_ID} .hb-radar-tooltip-tag-neutral { color: #f0c87c; }
  `;
  document.head.appendChild(style);
}

// Entity classifier — port from compass-hud. Prefer the WorldObject
// map's canonical class (set by GameEvent.ObjectCreate / template
// resolution); fall back to objDescFlags bits when the WO record is
// absent (entity created mid-zone-load, etc.). Returns null for things
// that shouldn't render on the radar (items, containers, statics).
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

function entityDisplayName(ref) {
  const inst = ref?.inst;
  const m = inst?.meta;
  if (m && typeof m.name === "string" && m.name.length > 0) return m.name;
  const rn = inst?.root?.name;
  if (typeof rn === "string" && rn.length > 0) return rn;
  return `0x${(ref?.guid >>> 0).toString(16).padStart(8, "0")}`;
}

function entityDisposition(ref) {
  const kind = ref?.kind;
  if (kind === "player") return "friendly";
  if (kind === "npc" || kind === "vendor") return "neutral";
  if (kind === "creature") return "hostile";
  try {
    const wo = window.__wom?.get?.((ref?.guid >>> 0));
    const cls = wo?.canonicalObjectClass || wo?.className;
    if (cls === "Player") return "friendly";
    if (cls === "Npc" || cls === "Vendor") return "neutral";
    if (cls === "Creature" || cls === "Monster") return "hostile";
  } catch (_) {}
  return "neutral";
}

// Module-level blip state. mount() owns the lifecycle and clears these
// in the teardown closure so unmount-remount stays clean.
let _overlayEl = null;
let _rotorEl = null;
let _blipPool = [];
let _blipRefs = [];
let _tooltipEl = null;
let _hostileIndicatorEl = null;
let _hoveredBlipIdx = -1;
let _radarHostileOnly = RADAR_HOSTILE_ONLY_BY_URL;

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

function ensureBlipPool() {
  if (!_rotorEl) return;
  while (_blipPool.length < MAX_BLIPS) {
    const d = document.createElement("div");
    d.className = "hb-radar-blip";
    d.style.display = "none";
    _rotorEl.appendChild(d);
    _blipPool.push(d);
  }
}

// Project entities to rotor-local pixel coordinates. Because the rotor
// is later rotated by -heading, a blip placed in rotor-local "world
// frame" (centerX + dx*scale, centerY - dy*scale) ends up at the right
// screen position automatically — no manual heading rotation needed
// for the blip placement step.
//
// World delta uses entity.root.position.{x,y} treated as AC (east, north)
// in line with the existing compass-hud blip code. The entityManager's
// `root.position` is the canonical position source — see entities.js
// for that contract.
function updateRadarBlips(playerPos) {
  if (!_overlayEl || _overlayEl.hidden || !_rotorEl) return;
  const em = window.liveScene3d?.entityManager;
  const map = em?.entityMap;
  if (!map || !playerPos) {
    for (const b of _blipPool) b.style.display = "none";
    for (let i = 0; i < _blipRefs.length; i++) _blipRefs[i] = null;
    return;
  }
  const localGuid = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;

  const candidates = [];
  for (const [guid, inst] of map) {
    const g = (guid >>> 0);
    if (g === localGuid) continue;
    const pos = inst?.root?.position;
    if (!pos) continue;
    const dx = pos.x - playerPos.x;
    const dy = pos.y - playerPos.y;
    const dist = Math.hypot(dx, dy);
    if (dist > MAX_RADAR_RANGE || dist < 0.01) continue;
    const kind = classifyEntityForRadar(g, inst);
    if (!kind) continue;
    if (_radarHostileOnly && kind !== "creature") continue;
    candidates.push({ dx, dy, dist, kind, guid: g, inst });
  }

  // Closest first so dot-pool slots go to the nearest entities.
  candidates.sort((a, b) => a.dist - b.dist);
  ensureBlipPool();
  const n = Math.min(candidates.length, _blipPool.length);
  const scale = DOT_RADIUS_PX / MAX_RADAR_RANGE;
  for (let i = 0; i < n; i++) {
    const c = candidates[i];
    const b = _blipPool[i];
    const localX = DISK_SIZE / 2 + c.dx * scale;
    const localY = DISK_SIZE / 2 - c.dy * scale;
    const alpha = Math.max(0.25, 1 - c.dist / MAX_RADAR_RANGE);
    b.style.display = "block";
    b.style.left = `${localX}px`;
    b.style.top = `${localY}px`;
    b.style.background = DOT_COLORS[c.kind] || "#ffffff";
    b.style.opacity = String(alpha);
    b.style.boxShadow = `0 0 2px ${DOT_COLORS[c.kind] || "#ffffff"}`;
    _blipRefs[i] = {
      guid: c.guid, inst: c.inst, dx: c.dx, dy: c.dy, dist: c.dist,
      kind: c.kind, localX, localY,
    };
  }
  for (let i = n; i < _blipPool.length; i++) {
    _blipPool[i].style.display = "none";
    _blipRefs[i] = null;
  }
  if (_hoveredBlipIdx >= n) {
    _hoveredBlipIdx = -1;
    hideTooltip();
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

function fillTooltipContent(ref) {
  const t = ensureTooltip();
  // Bearing reported relative to player facing: a blip directly in
  // front shows 0°, +right, −left. Since the blip's rotor-local
  // offset (cx, cy) is already in player-facing frame after the
  // rotor's -heading rotation cancels out the world-frame placement,
  // we recompute the bearing here directly from world-deltas to keep
  // the math one-source-of-truth.
  const bearingDeg = Math.round(
    (Math.atan2(ref.dx, ref.dy) * 180) / Math.PI,
  );
  const bearingStr = bearingDeg > 0 ? `+${bearingDeg}` : `${bearingDeg}`;
  const distM = ref.dist.toFixed(1);
  const disposition = entityDisposition(ref);
  t.textContent = `${entityDisplayName(ref)} • ${distM}m • ${bearingStr}° • `;
  const tagEl = document.createElement("span");
  tagEl.className = `hb-radar-tooltip-tag-${disposition}`;
  tagEl.textContent = disposition.toUpperCase();
  t.appendChild(tagEl);
}

// Position the tooltip at the blip's screen-space location. The blip
// lives inside .hb-radar-rotor which is rotated by -heading every
// frame, so we compute the blip's screen position analytically from
// its rotor-local offset + the current heading. Cheaper than reading
// getBoundingClientRect on each frame (no layout reflow).
function updateTooltipPosition(headingDeg) {
  if (_hoveredBlipIdx < 0 || !_tooltipEl || _tooltipEl.hidden) return;
  const ref = _blipRefs[_hoveredBlipIdx];
  if (!ref || !_overlayEl) return;
  const overlayRect = _overlayEl.getBoundingClientRect();
  const theta = (-headingDeg * Math.PI) / 180;
  const lx = ref.localX - DISK_SIZE / 2;
  const ly = ref.localY - DISK_SIZE / 2;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const screenX = cos * lx - sin * ly;
  const screenY = sin * lx + cos * ly;
  _tooltipEl.style.left = `${overlayRect.left + DISK_SIZE / 2 + screenX}px`;
  _tooltipEl.style.top = `${overlayRect.top + DISK_SIZE / 2 + screenY - 6}px`;
}

function hideTooltip() {
  if (_tooltipEl) _tooltipEl.hidden = true;
}

function blipIndexFromEvent(ev) {
  const el = ev.target;
  if (!el || !el.classList || !el.classList.contains("hb-radar-blip")) return -1;
  const idx = _blipPool.indexOf(el);
  if (idx < 0) return -1;
  if (!_blipRefs[idx]) return -1;
  return idx;
}

function onBlipMouseOver(ev) {
  const idx = blipIndexFromEvent(ev);
  if (idx < 0) return;
  _hoveredBlipIdx = idx;
  fillTooltipContent(_blipRefs[idx]);
  if (_tooltipEl) _tooltipEl.hidden = false;
}

function onBlipMouseOut(ev) {
  const idx = blipIndexFromEvent(ev);
  if (idx < 0) return;
  // Only hide if leaving for something that isn't another blip.
  const related = ev.relatedTarget;
  if (related && related.classList && related.classList.contains("hb-radar-blip")) return;
  if (_hoveredBlipIdx === idx) {
    _hoveredBlipIdx = -1;
    hideTooltip();
  }
}

function onBlipClick(ev) {
  const idx = blipIndexFromEvent(ev);
  if (idx < 0) return;
  const ref = _blipRefs[idx];
  if (!ref) return;
  try {
    window.liveScene3d?.entityManager?.setSelectedTarget?.(ref.guid >>> 0);
  } catch (_) {}
  const b = _blipPool[idx];
  if (b) {
    b.classList.add("hb-radar-blip-pulse");
    window.setTimeout(() => {
      try { b.classList.remove("hb-radar-blip-pulse"); } catch (_) {}
    }, 200);
  }
}

function setRadarHostileOnly(enabled) {
  _radarHostileOnly = !!enabled;
  if (_hostileIndicatorEl) _hostileIndicatorEl.hidden = !_radarHostileOnly;
  if (_hoveredBlipIdx >= 0) { hideTooltip(); _hoveredBlipIdx = -1; }
}

export const manifest = {
  id: "radar",
  name: "Compass",
  // No bar icon — the radar IS the presentation. iconHidden so it
  // claims no bar real-estate but still runs through mount().
  icon: "🧭",
  iconHidden: true,
  version: "0.1.0",
  description: "Top-right compass/radar disk (retail gmRadarUI 0x21000074)",
};

// Apply gmRadarUI 0x21000074 layout to the radar plugin's sub-elements.
// Cardinals get their explicit left/top from the layout (replacing the
// hand-tuned `left: 50%` + `transform: translateX(-50%)` centering),
// so the rAF tick's per-cardinal rotation uses the cardinal's own
// center as its origin (default `transform-origin: 50% 50%`) instead
// of being chained onto the existing centering translate.
function applyRadarLayout(refs) {
  applyLayoutRegions(RADAR_LAYOUT_ID, {
    [RADAR_ELEMS.disk]:   refs.diskEl,
    [RADAR_ELEMS.lock]:   refs.lockEl,
    [RADAR_ELEMS.move]:   refs.moveEl,
    [RADAR_ELEMS.n]:      refs.cardinalEls?.n,
    [RADAR_ELEMS.e]:      refs.cardinalEls?.e,
    [RADAR_ELEMS.s]:      refs.cardinalEls?.s,
    [RADAR_ELEMS.w]:      refs.cardinalEls?.w,
    [RADAR_ELEMS.coords]: refs.coordsEl,
  }, {
    // mountBar early-mount: retry is on by default in applyLayoutRegions.
    beforeApplyEl: (el) => {
      // Cardinals: clear centering anchors + override transform to
      // "none" so the rAF tick's per-cardinal counter-rotation works
      // around the cardinal's own center (default transform-origin
      // 50% 50%) instead of being chained onto the CSS translate(-50%).
      if (el.classList.contains("hb-radar-cardinal")) {
        el.style.right = "";
        el.style.bottom = "";
        el.style.transform = "none";
        delete el.dataset.baseTransform;
      }
      // Lock + move buttons: CSS uses `right: 4px` for move; clear so
      // explicit left wins.
      if (el === refs.lockEl || el === refs.moveEl) {
        el.style.right = "";
      }
    },
    afterApply: (_layout, applied) => {
      try { window.__diag?.layout?.onRadarApplied?.({ applied }); } catch (_) {}
    },
  });
}

export function mount(_ctx) {
  ensureStyles();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;

  // Disk (will eventually rotate with -heading so the dark north-wedge
  // points to true north).
  const disk = document.createElement("div");
  disk.className = "hb-radar-disk";
  overlay.appendChild(disk);

  // Rotor wraps the cardinals + FOV wedge + (future) entity blips.
  // We rotate it by `-heading` so that N stays world-north when the
  // player turns; the cardinals counter-rotate to stay readable.
  const rotor = document.createElement("div");
  rotor.className = "hb-radar-rotor";
  // Field-of-view wedge — points UP in rotor-local space, which after
  // rotor's -heading rotation lands in world-space at the player's
  // facing direction. So this is BOTH player facing + N indicator combined?
  // No — wedge stays in rotor local frame. As rotor rotates with -heading,
  // wedge sweeps with player facing in screen-space — exactly what retail
  // does: the cone shows where you're looking, regardless of how cardinals
  // are oriented.
  const fov = document.createElement("div");
  fov.className = "hb-radar-fov";
  rotor.appendChild(fov);
  const cardinalEls = {};
  for (const dir of ["n", "e", "s", "w"]) {
    const card = document.createElement("div");
    card.className = `hb-radar-cardinal hb-radar-${dir}`;
    rotor.appendChild(card);
    cardinalEls[dir] = card;
  }
  overlay.appendChild(rotor);

  // Centre marker (player position) — does NOT rotate.
  const centre = document.createElement("div");
  centre.className = "hb-radar-centre";
  overlay.appendChild(centre);

  // Lock toggle (upper-left) and Move handle (upper-right). Both wired
  // via the shared ac_window_position adapter, which owns drag,
  // localStorage persistence (key `hb.window.100006D3`), and the
  // `hb-ui-lock-changed` CustomEvent broadcast so other floaties can
  // react. Alternate sprite 0x060074B8 = locked state.
  const lockBtn = document.createElement("div");
  lockBtn.className = "hb-radar-lock";
  lockBtn.setAttribute("role", "button");
  lockBtn.setAttribute("aria-label", "Lock UI");
  overlay.appendChild(lockBtn);

  const moveBtn = document.createElement("div");
  moveBtn.className = "hb-radar-move";
  moveBtn.setAttribute("role", "button");
  moveBtn.setAttribute("aria-label", "Move Compass");
  overlay.appendChild(moveBtn);

  attachWindowPosition(overlay, {
    windowId: WINDOW_ID.RADAR,
    dragHandle: moveBtn,
    lockButton: lockBtn,
    defaultPos: { top: "8px", right: "8px" },
    onLockChange: (locked) => {
      lockBtn.style.backgroundImage = locked
        ? "url('./data/ui-sprites/0x060074B8.png')"
        : "url('./data/ui-sprites/0x060074B7.png')";
      // Backward-compat global hook — other CSS may key off this class.
      document.documentElement.classList.toggle("hb-ui-locked", locked);
    },
  });

  // Coords strip — empty by default so no horizontal line shows. Populated
  // by the rAF tick below once getPlayerWorldPos() returns valid data.
  const coords = document.createElement("div");
  coords.className = "hb-radar-coords";
  setAcText(coords, "");
  overlay.appendChild(coords);

  // Hostile-only indicator label (visible when ?radarHostileOnly=1).
  const hostileIndicator = document.createElement("div");
  hostileIndicator.className = "hb-radar-hostile-indicator";
  hostileIndicator.textContent = "[HOSTILE]";
  hostileIndicator.hidden = !_radarHostileOnly;
  overlay.appendChild(hostileIndicator);

  document.body.appendChild(overlay);

  // Plumb module-level refs and stand up the blip pool + tooltip so
  // the rAF tick below can populate the radar each frame.
  _overlayEl = overlay;
  _rotorEl = rotor;
  _hostileIndicatorEl = hostileIndicator;
  _blipPool = [];
  _blipRefs = [];
  ensureBlipPool();
  ensureTooltip();
  overlay.addEventListener("mouseover", onBlipMouseOver);
  overlay.addEventListener("mouseout", onBlipMouseOut);
  overlay.addEventListener("click", onBlipClick);

  // Apply retail layout positions for sub-elements. The hand-tuned
  // CSS values are very close already (1-2px deltas), but layout-driven
  // makes the DAT the source of truth so future radar tweaks come from
  // the asset rather than the JS plugin.
  applyRadarLayout({
    diskEl: disk,
    lockEl: lockBtn,
    moveEl: moveBtn,
    cardinalEls,
    coordsEl: coords,
  });

  // ──────────────────────────────────────────────────────────────────
  // rAF tick — rotate the rotor by -heading so the FOV wedge follows
  // player facing, counter-rotate cardinals so N/E/S/W stay upright,
  // and populate the coord strip.
  let rafId = 0;
  function fmtCoord(x, y) {
    // AC-style coords: world x is east-west axis, world z (3JS) is N-S,
    // displayed as "NN.NN, EE.EE" in dec-degree-ish form. Holtburg sits
    // near (32000, -34000) in three.js coords — divide by ~1000 for a
    // readable order of magnitude until we wire the real packed coords.
    if (x == null || y == null) return "";
    const ew = (x / 240).toFixed(1);
    const ns = (-y / 240).toFixed(1);
    return `${ns}, ${ew}`;
  }
  function tick() {
    const sw = window.liveScene3d?.cameraSwitcher;
    let heading = 0;
    try { heading = sw?.getPlayerHeading?.() ?? 0; } catch (_) {}
    // CSS rotation is clockwise; AC heading is compass bearing (0 = north,
    // 90 = east). To make N world-stay (player turning rotates the disk
    // counter-clockwise relative to screen), apply `-heading`.
    rotor.style.transform = `rotate(${-heading}deg)`;
    // Counter-rotate each cardinal so the letters stay screen-upright.
    for (const dir of ["n", "e", "s", "w"]) {
      const el = cardinalEls[dir];
      if (el) {
        // Each cardinal already has translateX/Y(-50%) baked in; chain
        // the counter-rotation onto that. position:absolute placement
        // is unaffected by the rotation.
        const existing = el.dataset.baseTransform ?? "";
        if (!existing) {
          el.dataset.baseTransform = el.style.transform || getComputedStyle(el).transform;
        }
        const base = el.dataset.baseTransform === "none" ? "" : el.dataset.baseTransform;
        el.style.transform = `${base} rotate(${heading}deg)`;
      }
    }
    try {
      const pos = sw?.getPlayerWorldPos?.();
      if (pos) setAcText(coords, fmtCoord(pos.x, pos.z));
    } catch (_) {}
    // Entity blips — placed in rotor-local coords each frame; the
    // rotor's -heading rotation (above) carries them to the correct
    // screen position. Tooltip follows the hovered blip analytically.
    const playerPos = getLocalPlayerAcPos();
    updateRadarBlips(playerPos);
    updateTooltipPosition(heading);
    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(rafId);
    try {
      overlay.removeEventListener("mouseover", onBlipMouseOver);
      overlay.removeEventListener("mouseout", onBlipMouseOut);
      overlay.removeEventListener("click", onBlipClick);
    } catch (_) {}
    overlay.remove();
    if (_tooltipEl && _tooltipEl.parentNode) {
      _tooltipEl.parentNode.removeChild(_tooltipEl);
    }
    _overlayEl = null;
    _rotorEl = null;
    _tooltipEl = null;
    _hostileIndicatorEl = null;
    _blipPool = [];
    _blipRefs = [];
    _hoveredBlipIdx = -1;
  };
}

// Expose hostile-only toggle for runtime tweaking (used by HUD options
// follow-up; also lets the existing compass-hud `?radarHostileOnly=1`
// URL flag keep working once compass-hud is deleted).
if (typeof window !== "undefined") {
  window.__radar = { setRadarHostileOnly };
}

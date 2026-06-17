// Map view — port of retail gmMapUI (LayoutDesc 0x21000026, 11 elements,
// 3 image DIDs). Mounts as a registered view of plugins/main-panel.js.
// Toggled via F3.
//
// Real DAT sprites:
//   - 0x0600127D : the ENTIRE world map of Dereth as a single bitmap.
//                  Parchment background + coastlines + cities +
//                  landmarks + roads all rendered into one texture.
//   - 0x06004D11 : bright green diamond — player position marker.
//   - 0x06004D10 : darker green dot — other-player / friend marker (?).
//
// Dereth coord system: landblocks form a 254×254 grid. Each landblock
// is 192 game units on a side, so the world is 254*192 = 48 768 units
// wide. Holtburg's landblock is (169, 180) per memory. The map
// bitmap covers the entire 254×254 landblock grid.
//
// Player world coords come from
// liveScene3d.cameraSwitcher.getPlayerWorldPos() — same source the
// radar plugin uses. We compute (lbX, lbY) from world XYZ via the
// 192-unit-per-landblock pitch.
//
// Retail layout source: gmMapUI 0x21000026 (800×600 in layout coords,
// but the meaningful inner content is 0x100001EA at 300×330).
// Element-id semantics from gmMapUI::PostInit (acclient.c:218339):
//   - 0x100001E8 : root container (300×600 at 0,0; gmMapUI type=268435494)
//   - 0x100001E9 : inner container (300×600 at 0,0)
//   - 0x100001EA : content panel (300×330 at 0,135) — the meaningful
//                  region; everything else is positioned relative to it.
//   - 0x100001EB : m_pDateTimeText — date/time strip (227×30 at 21,4 rel EA)
//   - 0x100001EC : m_pMap — UIRegion that hosts the world bitmap +
//                  player/house markers (257×267 at 21,36 rel EA)
//   - 0x100001ED : m_pPlayerLocationIcon — green diamond (17×16, child of EC)
//   - 0x100001EE : m_pHouseLocationIcon — house marker (8×8, 2 states, child of EC)
//   - 0x100001EF : m_pCoordinateText — coord readout (257×20 at 21,303 rel EA)
//   - 0x100001F0 : top-level 10×10 sprite (2 states)
//   - 0x100001F1 : 10×10 sprite (child of EE + F0; reusable template)

import { setAcText } from "../ui/ac_font.js";
import { loadLayout, findElementById, getCachedLayout } from "../ui/ac_layout.js";

const STYLE_ID = "hb-map-view-style";

/** gmMapUI — retail layout that drives the map panel.
 *  Element-id map confirmed by map_panel_layout_dump 2026-05-24 +
 *  acclient.c gmMapUI::PostInit (218339).
 */
const MAP_LAYOUT_ID = 0x21000026;
// Reference-only:
//   0x100001EA — (0,135) 300×330 content panel: outer chrome is owned
//                by main-panel; we treat this as the content origin.
//   0x100001EE — (0,0) 8×8 m_pHouseLocationIcon: not surfaced until
//                house-data plumbing lands.
const MAP_ELEM_DATE_TEXT        = 0x100001EB;  // (21,4) 227×30 — m_pDateTimeText
const MAP_ELEM_VIEWPORT         = 0x100001EC;  // (21,36) 257×267 — m_pMap
const MAP_ELEM_PLAYER_ICON      = 0x100001ED;  // (0,0) 17×16 — m_pPlayerLocationIcon
const MAP_ELEM_COORD_TEXT       = 0x100001EF;  // (21,303) 257×20 — m_pCoordinateText

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .hb-map-root {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      box-sizing: border-box;
      pointer-events: auto;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      overflow: hidden;
    }
    /* Date/time strip — per gmMapUI 0x100001EB at (21,4) 227×30 rel
       to the 0x100001EA content panel (which itself sits at y=135 in
       the 600-tall retail window). applyMapLayout re-anchors at runtime
       from the LayoutDesc. */
    .hb-map-meta-date {
      position: absolute;
      box-sizing: border-box;
      left: 21px;
      top: 4px;
      width: 227px;
      height: 30px;
      display: flex;
      align-items: center;
      padding: 0 6px;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid var(--hb-border-brass-dim);
      font-size: 11px;
      color: var(--hb-text-cream);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.9);
      pointer-events: none;
    }
    /* Map viewport — per gmMapUI 0x100001EC at (21,36) 257×267 rel
       to 0x100001EA. The world-map bitmap + player/house icons mount
       inside this region. */
    .hb-map-viewport {
      position: absolute;
      box-sizing: border-box;
      left: 21px;
      top: 36px;
      width: 257px;
      height: 267px;
      overflow: hidden;
      background: #1a140a;
      border: 1px solid var(--hb-border-brass-dim);
      cursor: grab;
    }
    .hb-map-viewport:active { cursor: grabbing; }
    .hb-map-bitmap {
      position: absolute;
      top: 0; left: 0;
      width: 100%;
      height: 100%;
      background: url("./data/ui-sprites/0x0600127D.png") center/contain no-repeat;
      image-rendering: pixelated;
      transition: transform 60ms linear;
      transform-origin: 0 0;
    }
    /* Player location icon — per gmMapUI 0x100001ED 17×16, sprite
       0x06004D11 (bright green diamond). Centered on the player's
       current world coords inside the map viewport. */
    .hb-map-player {
      position: absolute;
      box-sizing: border-box;
      width: 17px;
      height: 16px;
      background: url("./data/ui-sprites/0x06004D11.png") center/contain no-repeat;
      image-rendering: pixelated;
      transform: translate(-50%, -50%);
      filter: drop-shadow(0 0 4px rgba(120, 220, 120, 0.85));
      pointer-events: none;
      z-index: 3;
    }
    /* Owned-house marker — 8×8 brass-and-gold square placed at the
       player's house position when handle.playerHouseData() returns a
       valid landblockId. Sprite-less by design (retail 0x06004D0F is
       not in our extracted UI-sprite set) so the marker is always
       visible regardless of DAT extraction state. */
    .hb-map-house {
      position: absolute;
      box-sizing: border-box;
      width: 8px;
      height: 8px;
      background: linear-gradient(180deg, var(--hb-text-gold) 0%, var(--hb-border-brass) 100%);
      border: 1px solid var(--hb-border-brass-deep);
      transform: translate(-50%, -50%);
      filter: drop-shadow(0 0 3px rgba(212, 175, 55, 0.7));
      pointer-events: none;
      z-index: 2;
    }
    /* HUD rec #139 — fellow / allegiance member pins. fellow uses the retail
       darker-green friend dot 0x06004D10; allegiance uses an amber square. */
    .hb-map-roster {
      position: absolute;
      box-sizing: border-box;
      width: 10px;
      height: 10px;
      transform: translate(-50%, -50%);
      pointer-events: auto;
      z-index: 3;
      display: none;
    }
    .hb-map-roster[data-kind="fellow"] {
      background: url("./data/ui-sprites/0x06004D10.png") center/contain no-repeat;
      border-radius: 50%;
    }
    .hb-map-roster[data-kind="alleg"] {
      background: linear-gradient(180deg, #d8b24a 0%, #a8801a 100%);
      border: 1px solid #6a5010;
    }
    /* Coord readout — per gmMapUI 0x100001EF at (21,303) 257×20 rel
       to 0x100001EA. Below the viewport. */
    .hb-map-meta-coord {
      position: absolute;
      box-sizing: border-box;
      left: 21px;
      top: 303px;
      width: 257px;
      height: 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 6px;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid var(--hb-border-brass-dim);
      font-size: 10px;
      color: var(--hb-text-gold);
      font-variant-numeric: tabular-nums;
      pointer-events: none;
    }
    .hb-map-meta-coord-lb {
      color: var(--hb-text-muted);
      font-size: 9px;
    }
  `;
  document.head.appendChild(style);
}

// AC world units → map percentage. The 0x0600127D bitmap covers all
// 254×254 landblocks; each landblock = 192 game units. World origin
// (0, 0) is the SOUTH-WEST corner; X grows east, Z grows north (Y up).
// On screen we want: bitmap-x = (world_x / WORLD_SPAN) * 100%,
//                    bitmap-y = ((WORLD_SPAN - world_z) / WORLD_SPAN) * 100%.
const LB_PITCH = 192;
const WORLD_SPAN = 254 * LB_PITCH; // 48768
function worldToMapPct(worldX, worldZ) {
  const x = Math.max(0, Math.min(WORLD_SPAN, worldX));
  const z = Math.max(0, Math.min(WORLD_SPAN, worldZ));
  return {
    leftPct: (x / WORLD_SPAN) * 100,
    topPct:  ((WORLD_SPAN - z) / WORLD_SPAN) * 100,
  };
}

// AC coord display: "65.5S, 30.3E" style. Convert world-x (east axis)
// + world-z (north axis) into compass coordinates.
function fmtCoord(worldX, worldZ) {
  if (worldX == null || worldZ == null) return "—";
  // Centre of map = (24384, 24384) game units. Each unit ~ 0.0042 deg.
  // Common AC reading: divide by 240 (~ landblock side / 0.8) — same
  // convention the radar plugin uses for its coords strip.
  const ew = (worldX - 24384) / 240;
  const ns = (worldZ - 24384) / 240;
  const ewLabel = ew >= 0 ? "E" : "W";
  const nsLabel = ns >= 0 ? "N" : "S";
  return `${Math.abs(ns).toFixed(1)}${nsLabel}, ${Math.abs(ew).toFixed(1)}${ewLabel}`;
}

// HUD rec #139 — collect renderable roster-member map markers. Pure (no DOM):
// given the roster map (guid → {kind, name}), the live entityMap, a last-seen
// position cache, the current time, and the local player's guid, return one
// descriptor per locatable member. Live PVS positions (entityMap) win and
// refresh the cache; recently-seen members fall back to the cache (faded by
// age) up to staleMs. Members never seen — outside the local PVS or offline —
// are omitted: the AC server never broadcast roster-wide positions, so this is
// fidelity-correct, not a regression. A PLAYER objDescFlags guard suppresses
// the rare case of an item guid recycled onto a roster guid (radar.js:38).
export function collectRosterMarkers(roster, entityMap, lastSeen, nowMs, localGuid, opts = {}) {
  const staleMs = opts.staleMs ?? 5 * 60 * 1000;
  const ODF_PLAYER = 0x08;
  const lg = (localGuid ?? 0) >>> 0;
  const out = [];
  for (const [guidRaw, info] of roster) {
    const g = guidRaw >>> 0;
    if (g === lg) continue; // the local player already has their own marker
    const kind = info?.kind ?? "fellow";
    const name = info?.name ?? "";
    const inst = (entityMap && typeof entityMap.get === "function") ? entityMap.get(g) : null;
    const pos = inst?.root?.position ?? null;
    const odf = inst?.meta?.objDescFlags;
    const isPlayer = (odf == null) ? true : (((odf >>> 0) & ODF_PLAYER) !== 0);
    if (pos && isPlayer && typeof pos.x === "number" && typeof pos.y === "number") {
      lastSeen.set(g, { x: pos.x, y: pos.y, ts: nowMs });
      out.push({ guid: g, kind, name, x: pos.x, y: pos.y, source: "live", ageMs: 0 });
    } else {
      const cached = lastSeen.get(g);
      if (cached && (nowMs - cached.ts) <= staleMs) {
        out.push({ guid: g, kind, name, x: cached.x, y: cached.y, source: "cached", ageMs: nowMs - cached.ts });
      }
    }
  }
  return out;
}

// Apply gmMapUI 0x21000026 layout to the map view's sub-elements.
// Mirrors radar.js's applyRadarLayout but no retry loop — map mounts
// via main-panel.showView("map"), which only fires after the user
// presses F3 (post wasm-ready). If the layout fails to load, the CSS
// defaults already match the retail values exactly.
//
// Coordinate frame: the layout root is 800×600 but the meaningful
// content lives under 0x100001EA at (0,135) 300×330. Each child
// element (date/viewport/coord) has positions relative to EA. We
// strip the (0,135) parent offset and treat EA as our root (the
// main-panel body slot is the same 300×337 dimensions as EA, so
// no scaling is needed).
function applyMapLayout(refs) {
  const apply = (layout) => {
    if (!layout) return;
    let applied = 0;
    const pairs = [
      [MAP_ELEM_DATE_TEXT,  refs.dateEl],
      [MAP_ELEM_VIEWPORT,   refs.viewportEl],
      [MAP_ELEM_COORD_TEXT, refs.coordEl],
      // Player + house icons sit inside the viewport; their layout
      // x/y are template defaults (0,0) — we drive their position
      // from world coords in positionPlayer(). Only width/height
      // are useful from the layout.
      [MAP_ELEM_PLAYER_ICON, refs.playerEl],
    ];
    for (const [id, el] of pairs) {
      if (!el) continue;
      const desc = findElementById(layout, id);
      if (!desc) continue;
      // CSS centering trap: the player icon has transform:translate(-50%,-50%)
      // applied by ensureStyles. We DON'T touch transform on the player
      // icon because the runtime tick re-applies it every frame; for the
      // other refs (date/viewport/coord) clear any conflicting anchors.
      if (el !== refs.playerEl) {
        el.style.right = "";
        el.style.bottom = "";
        el.style.transform = "none";
      }
      if (typeof desc.x === "number" && el !== refs.playerEl) el.style.left = `${desc.x}px`;
      if (typeof desc.y === "number" && el !== refs.playerEl) el.style.top = `${desc.y}px`;
      if (typeof desc.width === "number") el.style.width = `${desc.width}px`;
      if (typeof desc.height === "number") el.style.height = `${desc.height}px`;
      applied += 1;
    }
    try {
      window.__diag?.layout?.onMapApplied?.({ applied });
    } catch (_) {}
  };
  const cached = getCachedLayout(MAP_LAYOUT_ID);
  if (cached) { apply(cached); return; }
  loadLayout(MAP_LAYOUT_ID).then(apply).catch(() => {});
}

export const view = {
  name: "Map",
  nameFor: () => "Map of Dereth",
  mount: (parentEl, ctx) => {
    ensureStyles();
    const root = document.createElement("div");
    root.className = "hb-map-root";

    // Date/time strip — per gmMapUI 0x100001EB.
    const dateEl = document.createElement("div");
    dateEl.className = "hb-map-meta-date";
    setAcText(dateEl, "Date: —");
    root.appendChild(dateEl);

    // Map viewport — per gmMapUI 0x100001EC. Hosts world bitmap +
    // player icon as children (retail's m_pMap UIRegion).
    const viewport = document.createElement("div");
    viewport.className = "hb-map-viewport";
    const bitmap = document.createElement("div");
    bitmap.className = "hb-map-bitmap";
    viewport.appendChild(bitmap);
    // Player location icon — per gmMapUI 0x100001ED. Sprite 0x06004D11.
    const player = document.createElement("div");
    player.className = "hb-map-player";
    player.style.display = "none";
    viewport.appendChild(player);
    // Owned-house marker. Hidden until handle.playerHouseData() returns
    // a snapshot with a non-zero landblockId.
    const house = document.createElement("div");
    house.className = "hb-map-house";
    house.title = "Your house";
    house.style.display = "none";
    viewport.appendChild(house);
    root.appendChild(viewport);

    // Coord readout — per gmMapUI 0x100001EF.
    const coordEl = document.createElement("div");
    coordEl.className = "hb-map-meta-coord";
    const coordValue = document.createElement("span");
    setAcText(coordValue, "—");
    coordEl.appendChild(coordValue);
    const lbEl = document.createElement("span");
    lbEl.className = "hb-map-meta-coord-lb";
    setAcText(lbEl, "LB —");
    coordEl.appendChild(lbEl);
    root.appendChild(coordEl);

    parentEl.appendChild(root);

    // Apply retail layout: replaces the hand-tuned (21,4) / (21,36) /
    // (21,303) CSS values with the LayoutDesc values from the DAT. The
    // hand-tuned values match retail exactly (we sourced them from the
    // same dump), so this is a re-assertion — the DAT is now the source
    // of truth for any future tweaks.
    applyMapLayout({
      dateEl,
      viewportEl: viewport,
      coordEl,
      playerEl: player,
    });

    // Drag-to-pan
    let pan = { x: 0, y: 0 };
    let drag = null;
    let scale = 1;
    function applyTransform() {
      bitmap.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${scale})`;
    }
    viewport.addEventListener("pointerdown", (ev) => {
      if (ev.target === player) return;
      drag = { ox: ev.clientX, oy: ev.clientY, px: pan.x, py: pan.y };
      try { viewport.setPointerCapture(ev.pointerId); } catch (_) {}
    });
    viewport.addEventListener("pointermove", (ev) => {
      if (!drag) return;
      pan.x = drag.px + (ev.clientX - drag.ox);
      pan.y = drag.py + (ev.clientY - drag.oy);
      applyTransform();
      positionPlayer();
      positionHouseMarker();
      positionRosterMarkers();
    });
    viewport.addEventListener("pointerup", (ev) => {
      drag = null;
      try { viewport.releasePointerCapture(ev.pointerId); } catch (_) {}
    });
    viewport.addEventListener("pointercancel", () => { drag = null; });
    viewport.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const delta = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
      scale = Math.max(0.5, Math.min(4, scale * delta));
      applyTransform();
      positionPlayer();
      positionHouseMarker();
      positionRosterMarkers();
    }, { passive: false });

    // Position the player marker over the world-map bitmap using the
    // current player coords. Re-runs each rAF so the dot tracks live.
    function positionPlayer() {
      const sw = window.liveScene3d?.cameraSwitcher;
      if (!sw?.getPlayerWorldPos) {
        player.style.display = "none";
        return;
      }
      let pos;
      try { pos = sw.getPlayerWorldPos(); } catch (_) { pos = null; }
      if (!pos) { player.style.display = "none"; return; }
      const { leftPct, topPct } = worldToMapPct(pos.x, pos.y);
      // Bitmap is positioned `top:0, left:0, width:100%, height:100%`
      // with the transform translate(panX, panY) scale(scale). The
      // player marker also sits inside the same viewport, so we
      // anchor by % then apply the same transform.
      const vpRect = viewport.getBoundingClientRect();
      const xPx = (leftPct / 100) * vpRect.width * scale + pan.x;
      const yPx = (topPct  / 100) * vpRect.height * scale + pan.y;
      player.style.left = `${xPx}px`;
      player.style.top  = `${yPx}px`;
      player.style.display = "block";
      // Coord readout
      setAcText(coordValue, fmtCoord(pos.x, pos.y));
      const lbX = Math.max(0, Math.min(253, Math.floor(pos.x / LB_PITCH)));
      const lbY = Math.max(0, Math.min(253, Math.floor(pos.y / LB_PITCH)));
      const lbKey = (lbX << 8) | lbY;
      setAcText(lbEl, `LB 0x${lbKey.toString(16).toUpperCase().padStart(4, "0")} (${lbX}, ${lbY})`);
    }

    // Position the owned-house marker. handle.playerHouseData() returns
    // {landblockId, posX, posY, posZ, ...} or null/undefined. We hide
    // the marker on the null path (no house) or zero landblockId (the
    // wasm-side default before a HouseData payload has been observed).
    // Otherwise convert the landblock-local coords to global via
    // landblock × LB_PITCH + cell-local, then re-use worldToMapPct.
    function positionHouseMarker() {
      const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
      let data = null;
      try { data = handle?.playerHouseData?.() ?? null; } catch (_) { data = null; }
      const lbId = (data?.landblockId >>> 0) || 0;
      if (!lbId) {
        house.style.display = "none";
        return;
      }
      const lbKey = (lbId >>> 16) & 0xFFFF;
      const lbX = (lbKey >> 8) & 0xFF;
      const lbY = lbKey & 0xFF;
      const globalX = lbX * LB_PITCH + (Number(data.posX) || 0);
      const globalY = lbY * LB_PITCH + (Number(data.posY) || 0);
      const { leftPct, topPct } = worldToMapPct(globalX, globalY);
      const vpRect = viewport.getBoundingClientRect();
      const xPx = (leftPct / 100) * vpRect.width * scale + pan.x;
      const yPx = (topPct  / 100) * vpRect.height * scale + pan.y;
      house.style.left = `${xPx}px`;
      house.style.top  = `${yPx}px`;
      house.style.display = "block";
    }

    // HUD rec #139 — fellow / allegiance member pins. The wire never carries
    // roster-wide positions (FellowshipMemberData / AllegianceDataEntry have
    // no coords), but members inside the local PVS exist in the 3D
    // entityManager with live AC-world positions (the radar plugin reads the
    // same source). Cross-reference roster guids against entityMap each tick;
    // a small last-seen cache keeps a fading marker for members who just left
    // PVS. The roster guid set is refreshed on the fellowship/allegiance bus
    // events. JS-only — every wasm surface used here already ships.
    const rosterLastSeen = new Map(); // guid -> { x, y, ts }
    const rosterPool = [];            // reused marker divs
    let roster = new Map();           // guid -> { kind, name }

    function refreshRoster() {
      const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
      const next = new Map();
      try {
        const fel = handle?.playerFellowship?.();
        if (fel?.members) {
          for (const m of fel.members) {
            if (m?.guid != null) next.set(m.guid >>> 0, { kind: "fellow", name: m.name ?? "" });
          }
        }
      } catch (_) { /* not in a fellowship / stale pkg */ }
      try {
        const alg = handle?.playerAllegiance?.();
        if (alg) {
          const members = [alg.monarch, alg.patron, alg.myself, ...(alg.vassals ?? [])];
          for (const m of members) {
            if (m?.guid != null && !next.has(m.guid >>> 0)) {
              next.set(m.guid >>> 0, { kind: "alleg", name: m.name ?? "" });
            }
          }
        }
      } catch (_) { /* not in an allegiance / stale pkg */ }
      roster = next;
    }

    function ensureRosterPool(n) {
      while (rosterPool.length < n) {
        const el = document.createElement("div");
        el.className = "hb-map-roster";
        viewport.appendChild(el);
        rosterPool.push(el);
      }
    }

    function positionRosterMarkers() {
      const entityMap = window.liveScene3d?.entityManager?.entityMap ?? null;
      const localGuid = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;
      const markers = collectRosterMarkers(roster, entityMap, rosterLastSeen, Date.now(), localGuid);
      ensureRosterPool(markers.length);
      const vpRect = viewport.getBoundingClientRect();
      for (let i = 0; i < rosterPool.length; i++) {
        const el = rosterPool[i];
        const m = markers[i];
        if (!m) { el.style.display = "none"; continue; }
        const { leftPct, topPct } = worldToMapPct(m.x, m.y);
        el.style.left = `${(leftPct / 100) * vpRect.width * scale + pan.x}px`;
        el.style.top  = `${(topPct  / 100) * vpRect.height * scale + pan.y}px`;
        el.dataset.kind = m.kind;
        el.style.opacity = m.source === "cached"
          ? String(Math.max(0.25, 1 - m.ageMs / (5 * 60 * 1000)))
          : "1";
        const ageStr = m.source === "cached" ? ` (last seen ${Math.round(m.ageMs / 1000)}s ago)` : "";
        el.title = `${m.name || ("0x" + m.guid.toString(16))}${ageStr}`;
        el.style.display = "block";
      }
    }
    refreshRoster();

    // Refresh the roster guid set on roster changes (kind=22/25 → these bus
    // events). Positions still come live from entityMap each tick.
    const rosterBus = ctx?.client?.events
      ?? (typeof window !== "undefined" ? window.__pluginClient?.events : null)
      ?? null;
    const onRosterChange = () => refreshRoster();
    if (rosterBus && typeof rosterBus.on === "function") {
      rosterBus.on("fellowshipUpdated", onRosterChange);
      rosterBus.on("allegianceUpdated", onRosterChange);
    }

    function updateDate() {
      // AC clock — same epoch + compression as Sky-K stars/moon.
      // AC_LAUNCH_UNIX_EPOCH = 941500800 (1999-11-01), 11.34× compression.
      // We'll just show the current real-world date for now.
      const d = new Date();
      setAcText(dateEl, `Date: ${d.toLocaleDateString()}`);
    }
    updateDate();

    let rafId = 0;
    let houseTick = 0;
    function tick() {
      positionPlayer();
      positionRosterMarkers();
      // House position changes only on HouseData arrival; sample once
      // a second (≈60 frames at 60Hz) to keep the rAF cost negligible.
      if ((houseTick++ % 60) === 0) {
        positionHouseMarker();
      }
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      if (rosterBus && typeof rosterBus.off === "function") {
        try { rosterBus.off("fellowshipUpdated", onRosterChange); } catch (_) {}
        try { rosterBus.off("allegianceUpdated", onRosterChange); } catch (_) {}
      }
      root.remove();
    };
  },
};

// Convenience export to register the view (called from index.html).
export const manifest = {
  id: "map-panel",
  name: "Map",
  icon: "🗺",
  iconHidden: true,
  version: "0.1.0",
  description: "Map of Dereth (gmMapUI 0x21000026, world bitmap 0x0600127D)",
};

// Map view — port of retail gmMapUI (layout 0x21000026, 11 elements,
// 3 image DIDs). Mounts as a registered view of plugins/main-panel.js.
// Toggled via the M key.
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

const STYLE_ID = "hb-map-view-style";

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
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .hb-map-meta {
      flex: 0 0 auto;
      padding: 4px 8px;
      display: flex;
      justify-content: space-between;
      background: rgba(0, 0, 0, 0.35);
      border-bottom: 1px solid var(--hb-border-brass-dim);
      font-size: 10px;
    }
    .hb-map-meta-date  { color: var(--hb-text-cream); }
    .hb-map-meta-coord { color: var(--hb-text-gold); font-variant-numeric: tabular-nums; }
    .hb-map-viewport {
      flex: 1 1 auto;
      position: relative;
      overflow: hidden;
      background: #1a140a;
      border: 1px solid var(--hb-border-brass-dim);
      margin: 4px;
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
    .hb-map-player {
      position: absolute;
      width: 12px;
      height: 12px;
      background: url("./data/ui-sprites/0x06004D11.png") center/contain no-repeat;
      image-rendering: pixelated;
      transform: translate(-50%, -50%);
      filter: drop-shadow(0 0 4px rgba(120, 220, 120, 0.85));
      pointer-events: none;
      z-index: 3;
    }
    .hb-map-footer {
      flex: 0 0 auto;
      padding: 3px 8px;
      background: rgba(0, 0, 0, 0.4);
      border-top: 1px solid var(--hb-border-brass-dim);
      font-size: 9px;
      color: var(--hb-text-muted);
      display: flex;
      justify-content: space-between;
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

export const view = {
  name: "Map",
  nameFor: () => "Map of Dereth",
  mount: (parentEl, _ctx) => {
    ensureStyles();
    const root = document.createElement("div");
    root.className = "hb-map-root";

    const meta = document.createElement("div");
    meta.className = "hb-map-meta";
    const dateEl = document.createElement("span");
    dateEl.className = "hb-map-meta-date";
    dateEl.textContent = "Date: —";
    const coordEl = document.createElement("span");
    coordEl.className = "hb-map-meta-coord";
    coordEl.textContent = "—";
    meta.appendChild(dateEl);
    meta.appendChild(coordEl);
    root.appendChild(meta);

    const viewport = document.createElement("div");
    viewport.className = "hb-map-viewport";
    const bitmap = document.createElement("div");
    bitmap.className = "hb-map-bitmap";
    viewport.appendChild(bitmap);
    const player = document.createElement("div");
    player.className = "hb-map-player";
    player.style.display = "none";
    viewport.appendChild(player);
    root.appendChild(viewport);

    const footer = document.createElement("div");
    footer.className = "hb-map-footer";
    const lbEl = document.createElement("span");
    lbEl.textContent = "LB —";
    const helpEl = document.createElement("span");
    helpEl.textContent = "Drag to pan · M closes";
    footer.appendChild(lbEl);
    footer.appendChild(helpEl);
    root.appendChild(footer);

    parentEl.appendChild(root);

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
      const { leftPct, topPct } = worldToMapPct(pos.x, pos.z);
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
      // Footer coords
      coordEl.textContent = fmtCoord(pos.x, pos.z);
      const lbX = Math.max(0, Math.min(253, Math.floor(pos.x / LB_PITCH)));
      const lbY = Math.max(0, Math.min(253, Math.floor(pos.z / LB_PITCH)));
      const lbKey = (lbX << 8) | lbY;
      lbEl.textContent = `LB 0x${lbKey.toString(16).toUpperCase().padStart(4, "0")} (${lbX}, ${lbY})`;
    }

    function updateDate() {
      // AC clock — same epoch + compression as Sky-K stars/moon.
      // AC_LAUNCH_UNIX_EPOCH = 941500800 (1999-11-01), 11.34× compression.
      // We'll just show the current real-world date for now.
      const d = new Date();
      dateEl.textContent = `Date: ${d.toLocaleDateString()}`;
    }
    updateDate();

    let rafId = 0;
    function tick() {
      positionPlayer();
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
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

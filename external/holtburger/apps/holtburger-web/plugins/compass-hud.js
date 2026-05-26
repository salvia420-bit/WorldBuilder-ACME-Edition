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
const WIDTH = 200;
const HEIGHT = 16;
// Pixels per degree on the tape. Spec says the strip is 200px wide and
// shows roughly 60° of heading (W..NW..N..NE..E visible at once), so
// each degree ≈ 3.33px. Tweaking this changes "tape zoom".
const PX_PER_DEG = 200 / 60;
const TAPE_TOTAL_DEG = 360;
const TAPE_INNER_WIDTH_PX = TAPE_TOTAL_DEG * PX_PER_DEG;

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
let _rafId = 0;
let _disposed = false;

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

  _rafId = window.requestAnimationFrame(tickCompass);
}

function setVisible(visible) {
  if (!_overlayEl) return;
  _overlayEl.hidden = !visible;
}

function unmount() {
  _disposed = true;
  if (_rafId) {
    try { window.cancelAnimationFrame(_rafId); } catch (_) {}
    _rafId = 0;
  }
  if (_overlayEl && _overlayEl.parentNode) {
    _overlayEl.parentNode.removeChild(_overlayEl);
  }
  _overlayEl = null;
  _tapeEl = null;
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
  window.__compassHud = { setVisible, unmount };
}

export { setVisible, unmount };

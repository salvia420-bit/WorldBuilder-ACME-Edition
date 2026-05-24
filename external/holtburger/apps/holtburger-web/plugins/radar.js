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

const OVERLAY_ID = "hb-radar";
const WIDTH = 120;
const HEIGHT = 140;
const DISK_SIZE = 120;
const BUTTON_SIZE = 27;

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
  `;
  document.head.appendChild(style);
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

  // Lock toggle (upper-left) — clicking will lock/unlock UI repositioning.
  // Wire-up of the global UI lock is a follow-on; for now toggles a
  // visual indicator (alternate sprite 0x060074B8 = locked state).
  let locked = false;
  const lockBtn = document.createElement("div");
  lockBtn.className = "hb-radar-lock";
  lockBtn.setAttribute("role", "button");
  lockBtn.setAttribute("aria-label", "Lock UI");
  lockBtn.addEventListener("click", () => {
    locked = !locked;
    lockBtn.style.backgroundImage = locked
      ? "url('./data/ui-sprites/0x060074B8.png')"
      : "url('./data/ui-sprites/0x060074B7.png')";
    document.documentElement.classList.toggle("hb-ui-locked", locked);
  });
  overlay.appendChild(lockBtn);

  // Move handle (upper-right) — pointer-capture-based drag so the
  // browser keeps mouse events flowing even if the cursor leaves the
  // 27x27 hit area mid-drag.
  const moveBtn = document.createElement("div");
  moveBtn.className = "hb-radar-move";
  moveBtn.setAttribute("role", "button");
  moveBtn.setAttribute("aria-label", "Move Compass");
  let drag = null;
  moveBtn.addEventListener("pointerdown", (ev) => {
    if (locked) return;
    ev.preventDefault();
    const rect = overlay.getBoundingClientRect();
    drag = { ox: ev.clientX - rect.left, oy: ev.clientY - rect.top };
    try { moveBtn.setPointerCapture(ev.pointerId); } catch (_) {}
  });
  moveBtn.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    overlay.style.top = `${ev.clientY - drag.oy}px`;
    overlay.style.left = `${ev.clientX - drag.ox}px`;
    overlay.style.right = "auto";
  });
  moveBtn.addEventListener("pointerup", (ev) => {
    drag = null;
    try { moveBtn.releasePointerCapture(ev.pointerId); } catch (_) {}
  });
  moveBtn.addEventListener("pointercancel", () => { drag = null; });
  overlay.appendChild(moveBtn);

  // Coords strip — empty by default so no horizontal line shows. Populated
  // by the rAF tick below once getPlayerWorldPos() returns valid data.
  const coords = document.createElement("div");
  coords.className = "hb-radar-coords";
  setAcText(coords, "");
  overlay.appendChild(coords);

  document.body.appendChild(overlay);

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
    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(rafId);
    overlay.remove();
  };
}

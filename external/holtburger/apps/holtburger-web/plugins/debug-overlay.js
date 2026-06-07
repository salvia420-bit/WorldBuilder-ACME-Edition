// Developer overlay (?debug=1) — top-right HUD surfacing the dev info
// imgui shows for native AC plugins (FPS, draw calls, resident LBs,
// current LB, selected/hovered GUID, camera pose, etc.). No retail
// analog — pure dev tooling.
//
// Lifecycle: IIFE-style. If `?debug=1` is missing on the URL we exit
// silently before touching the DOM or starting a rAF loop, so the
// off-state cost is zero. With the flag set, a single rAF loop reads
// cheap fields off `window.liveScene3d` and updates one DOM node per
// row.
//
// Window hook: `window.__debugOverlay.setVisible(bool)`.

const OVERLAY_ID = "hb-debug-overlay";
const BLOCK_SIZE_M = 192.0; // AC landblock size; matches scene3d/{buildings,terrain,spawns}.js

const ENABLED = (() => {
  try {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("debug") === "1";
  } catch (_) { return false; }
})();

// Row definitions: [label, key]. `key` is matched in updateValues() to
// a getter that pulls the current value off liveScene3d / window.
const ROWS = [
  ["FPS",          "fps"],
  ["Frame ms",     "frameMs"],
  ["Draw calls",   "drawCalls"],
  ["Triangles",    "triangles"],
  ["Geometries",   "geometries"],
  ["Textures",     "textures"],
  ["Programs",     "programs"],
  ["Resident LBs", "residentLbs"],
  ["Evicted LBs",  "evictedLbs"],
  ["Current LB",   "currentLb"],
  ["Local GUID",   "localGuid"],
  ["Selected",     "selectedGuid"],
  ["Cursor",       "cursorGuid"],
  ["Cam pos",      "camPos"],
  ["Cam yaw",      "camYaw"],
];

let _overlayEl = null;
let _valueEls = {}; // key → span element
let _rafId = 0;
let _disposed = false;

// Mouse-pos tracking. Updated on mousemove over the canvas; used by
// the rAF tick to call __pickEntityAt(x,y). null when the cursor is
// off the canvas (or before the first mousemove).
let _mouseX = -1;
let _mouseY = -1;
let _mouseOverCanvas = false;
let _canvasListenersBound = null; // the <canvas> we bound to, so we can rebind if it changes

// Cursor-pick memoization (#32). The raycast allocates per call
// (Raycaster builds a fresh hit array + walks entity rigs), and the
// rAF tick ran it EVERY frame even with a stationary cursor — a GC
// sawtooth on idle. Cache the last resolved guid and only re-pick when
// the cursor actually moved (or left the canvas). `_cursorDirty` starts
// true so the first tick after a mousemove picks once.
let _lastCursorGuid = null;
let _cursorDirty = false;

// FPS rolling-window state. We keep the last 60 frame timestamps and
// recompute the average once per second. Frame-ms is just the delta
// since the previous tick.
const FPS_WINDOW = 60;
const _frameTimes = []; // ring buffer of performance.now() samples
let _lastFrameNow = 0;
let _lastFrameMs = 0;
let _fpsDisplay = 0;
let _lastFpsUpdate = 0;

let _stylesInjected = false;
function ensureStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const style = document.createElement("style");
  style.id = "hb-debug-overlay-style";
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      top: 4px;
      right: 4px;
      width: 280px;
      max-height: 240px;
      z-index: 9999;
      pointer-events: none;
      background: rgba(0, 0, 0, 0.65);
      border: 1px solid var(--hb-border-brass, #8a7544);
      box-shadow: 0 1px 0 var(--hb-border-brass-deep, #5a4a28) inset,
                  0 0 3px rgba(0, 0, 0, 0.7);
      font-family: var(--hb-font-mono, ui-monospace, "SF Mono", "Menlo", "Consolas", monospace);
      font-size: 10px;
      line-height: 1.35;
      color: var(--hb-text-cream, #f0d8a0);
      padding: 4px 6px;
      user-select: none;
    }
    #${OVERLAY_ID}[hidden] { display: none; }
    #${OVERLAY_ID} .hb-debug-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      white-space: nowrap;
    }
    #${OVERLAY_ID} .hb-debug-label {
      color: var(--hb-text-cream-dim, #b8a17a);
      flex: 0 0 auto;
    }
    #${OVERLAY_ID} .hb-debug-value {
      color: var(--hb-text-cream, #f0d8a0);
      flex: 1 1 auto;
      text-align: right;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `;
  document.head.appendChild(style);
}

function mountOverlay() {
  ensureStyles();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  _overlayEl = document.createElement("div");
  _overlayEl.id = OVERLAY_ID;

  _valueEls = {};
  for (const [label, key] of ROWS) {
    const row = document.createElement("div");
    row.className = "hb-debug-row";
    const labelEl = document.createElement("span");
    labelEl.className = "hb-debug-label";
    labelEl.textContent = label;
    const valEl = document.createElement("span");
    valEl.className = "hb-debug-value";
    valEl.textContent = "—";
    row.appendChild(labelEl);
    row.appendChild(valEl);
    _overlayEl.appendChild(row);
    _valueEls[key] = valEl;
  }

  document.body.appendChild(_overlayEl);
}

function bindCanvasIfReady() {
  // The renderer canvas is created during scene3d init, which may not
  // be ready when this plugin mounts. Re-check each frame; cheap O(1)
  // identity comparison, no churn after the canvas appears.
  const canvas = window.liveScene3d?.renderer?.domElement;
  if (!canvas || canvas === _canvasListenersBound) return;
  if (_canvasListenersBound) {
    try {
      _canvasListenersBound.removeEventListener("mousemove", onCanvasMouseMove);
      _canvasListenersBound.removeEventListener("mouseleave", onCanvasMouseLeave);
    } catch (_) {}
  }
  canvas.addEventListener("mousemove", onCanvasMouseMove, { passive: true });
  canvas.addEventListener("mouseleave", onCanvasMouseLeave, { passive: true });
  _canvasListenersBound = canvas;
}

function onCanvasMouseMove(ev) {
  _mouseX = ev.clientX;
  _mouseY = ev.clientY;
  _mouseOverCanvas = true;
  _cursorDirty = true; // (#32) re-pick on the next updateValues()
}

function onCanvasMouseLeave() {
  _mouseOverCanvas = false;
  _cursorDirty = true; // (#32) clear the cached guid on the next tick
}

function hex32(n) {
  return "0x" + ((n >>> 0).toString(16).padStart(8, "0"));
}

function landblockIdFromPos(x, y) {
  // Matches scene3d/{buildings,spawns,terrain}.js: lbX = floor(x/192),
  // lbY = floor(y/192), packed as ((lbX & 0xff) << 24) | ((lbY & 0xff) << 16).
  const lbX = Math.floor(x / BLOCK_SIZE_M);
  const lbY = Math.floor(y / BLOCK_SIZE_M);
  return (((lbX & 0xff) << 24) | ((lbY & 0xff) << 16)) >>> 0;
}

function getLocalPlayerInst() {
  try {
    const lpg = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;
    if (!lpg) return null;
    return window.liveScene3d?.entityManager?.entityMap?.get?.(lpg) ?? null;
  } catch (_) { return null; }
}

// camera.position is in three.js frame (acToThree maps AC (ax,ay,az)
// → three [ax, az, -ay]). Inverse: AC (tx, -tz, ty).
function camWorldPosAc() {
  try {
    const cam = window.liveScene3d?.cameraSwitcher?.getActive?.()
             ?? window.liveScene3d?.camera;
    if (!cam || !cam.position) return null;
    const tx = cam.position.x, ty = cam.position.y, tz = cam.position.z;
    return { x: tx, y: -tz, z: ty };
  } catch (_) { return null; }
}

function camYawDeg() {
  try {
    const yaw = window.liveScene3d?.cameraSwitcher?.followYaw ?? 0;
    let deg = (yaw * 180) / Math.PI;
    deg = ((deg % 360) + 360) % 360;
    return deg;
  } catch (_) { return 0; }
}

function updateValues() {
  const live = window.liveScene3d;
  const info = live?.renderer?.info;
  const render = info?.render;
  const memory = info?.memory;
  const lruStats = live?.landblockLru?.getStats?.() ?? null;

  // FPS / frame timing.
  _valueEls.fps.textContent = _fpsDisplay > 0 ? _fpsDisplay.toString() : "—";
  _valueEls.frameMs.textContent = _lastFrameMs > 0 ? _lastFrameMs.toFixed(1) : "—";

  _valueEls.drawCalls.textContent = render?.calls != null ? String(render.calls) : "—";
  _valueEls.triangles.textContent = render?.triangles != null ? String(render.triangles) : "—";
  _valueEls.geometries.textContent = memory?.geometries != null ? String(memory.geometries) : "—";
  _valueEls.textures.textContent = memory?.textures != null ? String(memory.textures) : "—";
  _valueEls.programs.textContent = info?.programs?.length != null ? String(info.programs.length) : "—";

  _valueEls.residentLbs.textContent = lruStats?.resident != null ? String(lruStats.resident) : "—";
  _valueEls.evictedLbs.textContent = lruStats?.evicted != null ? String(lruStats.evicted) : "—";

  // Current LB derives from the local player's world position.
  const inst = getLocalPlayerInst();
  if (inst?.root?.position) {
    const p = inst.root.position;
    _valueEls.currentLb.textContent = hex32(landblockIdFromPos(p.x, p.y));
  } else {
    _valueEls.currentLb.textContent = "—";
  }

  // GUIDs.
  let lpg = 0;
  try { lpg = (window.getLocalPlayerGuid?.() ?? 0) >>> 0; } catch (_) {}
  _valueEls.localGuid.textContent = lpg ? hex32(lpg) : "—";

  let selGuid = 0;
  try { selGuid = (live?.entityManager?.getSelectedTarget?.() ?? 0) >>> 0; } catch (_) {}
  _valueEls.selectedGuid.textContent = selGuid ? hex32(selGuid) : "none";

  // Cursor pick — only run when the mouse is actually over the canvas
  // and __pickEntityAt is available. The raycast is O(entities-in-PVS)
  // which is ~200 max, but it allocates per call, so (#32) we re-pick
  // ONLY when the cursor moved (`_cursorDirty`) instead of every frame —
  // a stationary cursor reuses the cached `_lastCursorGuid` and does no
  // raycast (no per-frame GC sawtooth on idle hover).
  if (_cursorDirty) {
    let cursorGuid = null;
    if (_mouseOverCanvas && typeof window.__pickEntityAt === "function" && _mouseX >= 0) {
      try { cursorGuid = window.__pickEntityAt(_mouseX, _mouseY); } catch (_) {}
    }
    _lastCursorGuid = cursorGuid;
    _cursorDirty = false;
  }
  if (_lastCursorGuid != null) {
    _valueEls.cursorGuid.textContent = hex32(_lastCursorGuid);
  } else {
    _valueEls.cursorGuid.textContent = "none";
  }

  // Camera world pos (AC frame) + yaw.
  const cp = camWorldPosAc();
  if (cp) {
    _valueEls.camPos.textContent = `${cp.x.toFixed(1)},${cp.y.toFixed(1)},${cp.z.toFixed(1)}`;
  } else {
    _valueEls.camPos.textContent = "—";
  }
  _valueEls.camYaw.textContent = camYawDeg().toFixed(1) + "°";
}

function tick() {
  if (_disposed) return;
  _rafId = window.requestAnimationFrame(tick);
  if (!_overlayEl || _overlayEl.hidden) return;

  const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
  if (_lastFrameNow > 0) {
    _lastFrameMs = now - _lastFrameNow;
    _frameTimes.push(_lastFrameMs);
    if (_frameTimes.length > FPS_WINDOW) _frameTimes.shift();
  }
  _lastFrameNow = now;

  // FPS once per second from the rolling-window average.
  if (now - _lastFpsUpdate >= 1000 && _frameTimes.length > 0) {
    let sum = 0;
    for (const ms of _frameTimes) sum += ms;
    const avgMs = sum / _frameTimes.length;
    _fpsDisplay = avgMs > 0 ? Math.round(1000 / avgMs) : 0;
    _lastFpsUpdate = now;
  }

  bindCanvasIfReady();
  updateValues();
}

function setVisible(visible) {
  if (_overlayEl) _overlayEl.hidden = !visible;
}

function unmount() {
  _disposed = true;
  if (_rafId) {
    try { window.cancelAnimationFrame(_rafId); } catch (_) {}
    _rafId = 0;
  }
  if (_canvasListenersBound) {
    try {
      _canvasListenersBound.removeEventListener("mousemove", onCanvasMouseMove);
      _canvasListenersBound.removeEventListener("mouseleave", onCanvasMouseLeave);
    } catch (_) {}
    _canvasListenersBound = null;
  }
  if (_overlayEl && _overlayEl.parentNode) {
    _overlayEl.parentNode.removeChild(_overlayEl);
  }
  _overlayEl = null;
  _valueEls = {};
}

if (ENABLED && typeof window !== "undefined" && typeof document !== "undefined") {
  const boot = () => {
    try {
      mountOverlay();
      _rafId = window.requestAnimationFrame(tick);
    } catch (_) {}
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
  window.__debugOverlay = { setVisible, unmount };
}

export { setVisible, unmount };

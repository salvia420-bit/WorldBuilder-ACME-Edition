// Portal space — the retail gmSmartBoxUI teleport presentation (2026-10-05
// rework; replaces the camera-hugging donut overlay AND the loading-screen
// curtain plugin, both retired).
//
// RETAIL (acclient.c, gmSmartBoxUI):
//   ctor  :262328  teleportObj = makeObject(GetDIDByEnum(0x10000001, 7))
//                  -> added to viewport 0x10000436's CreatureMode with ONE
//                  DISTANT_LIGHT at 2.0, direction (0.3,-1.9,0.65), camera at
//                  (0.24,-2.7,0.88), UseSmartboxFOV.
//   UseTime :262415-262580 — a TeleportAnimState machine:
//     3 TUNNEL         entered when SmartBox::teleport_in_progress goes true
//                      (BeginTeleportAnimation: Sound_UI_EnterPortal). On the
//                      first tunnel frame: SmartBox::Hide (world NOT drawn),
//                      portal viewport shown (cleared black), the tunnel object
//                      plays animation GetDIDByEnum(0x10000002, 7) at 40 fps.
//                      Every 0.6-1.8 s a new random camera ROLL target in
//                      [0,360) is eased to with UIGlobals::GetAnimLevel, and
//                      "In Portal Space - Please Wait..." is posted.
//     4 CONTINUE       EndTeleportAnimation when teleport_in_progress clears
//                      (= destination position applied AND cells loaded,
//                      SmartBox::UseTime :146262-146283). Holds >= 2 s, leaves
//                      when (120 - frame)/40 is in (1.1, 1.3) or at 5 s.
//     5 TUNNEL_FADEOUT 1 s — the tunnel's far plane (smartbox view distance)
//                      shrinks to 0.001 along GetAnimLevel.
//     6 WORLD_FADEIN   SmartBox::Show + Sound_UI_ExitPortal; 1 s view-distance
//                      grow-in, then LoginComplete + teleport_in_progress=0.
// OpenAC (src/AcDream.App/Rendering/PortalTunnelPresentation.cs +
// AcDream.Core/World/TeleportAnimSequencer.cs) ports the same machine; the
// constants below match both.
//
// OURS:
//   START  client_events.js kind=33 PortalSpaceEntered -> startPortalSpace.
//   ARRIVE client_events.js kind=66 TeleportArrived (wasm: first self
//          UpdatePosition carrying the teleport's sequence) -> signalPortalArrived
//          with the destination cell; "cells loaded" = that cell's EnvCell
//          container (indoor) / terrain bake (outdoor) is resident. Stale-pkg
//          fallback: the local pose leaving the start pose. FAILSAFES: a 6 s cap
//          on the cells wait after arrival, a 20 s cap on the whole tunnel hold.
//   TICK   loop.js tickPortalSpace (after the camera tick).
//   RENDER scene3d/index.js: while portalSpaceOwnsFrame() the world submission
//          is SKIPPED (retail SmartBox::Hide) and renderPortalSpaceFrame draws
//          the tunnel in its own scene on a black clear. During WORLD_FADEIN the
//          world renders and renderPortalSpaceOverlay fades a black quad out
//          (approximation of retail's view-distance grow-in — changing the main
//          camera's far plane would ripple through CSM/log-depth/culling).
//   NOT PORTED: LoginComplete timing (the wasm still sends it on PlayerTeleport —
//          see holtburger_core DEFER_LOGIN_COMPLETE_AFTER_TELEPORT), the login /
//          logout tunnel entries, the tunnel animation's hooks.
//
// `?portalSpace=off` disables the whole presentation (the world just stays up).

import * as THREE from "three";
import { meshToGeometryGroups, surfacePixelsToTexture } from "./adapter.js";
import { withLogDepth } from "./shader_logdepth.js";
import { playUiSound } from "./audio/retail_sound_rules.js";

// ── retail constants ───────────────────────────────────────────────────
export const PORTAL_SETUP_ENUM = 0x10000001; // portalspace_background
export const PORTAL_ANIM_ENUM = 0x10000002; // portalspace_animation
export const PORTAL_ENUM_CATEGORY = 7; // UIASSET
// DAT-verified resolutions (client_portal.dat: 0x25000000[7] = 0x25000010,
// whose 0x10000001 -> 0x02000306, 0x10000002 -> 0x030005AC). Used when the
// wasm resolver is absent (stale pkg) or fails.
export const PORTAL_SETUP_FALLBACK = 0x02000306;
export const PORTAL_ANIM_FALLBACK = 0x030005ac;

export const TAS = Object.freeze({
  OFF: 0,
  TUNNEL: 3,
  CONTINUE: 4,
  TUNNEL_FADEOUT: 5,
  WORLD_FADEIN: 6,
});
const FADE_TIME = 1.0;
const MIN_CONTINUE = 2.0;
const MAX_CONTINUE = 5.0;
export const TUNNEL_FPS = 40.0;
const TUNNEL_END_FRAME = 120;
const EXIT_WINDOW_LOW = FADE_TIME + 0.1;
const EXIT_WINDOW_HIGH = FADE_TIME + 0.3;
const ROT_MIN = 0.6;
const ROT_MAX = 1.8;
const LIGHT_DIR_AC = [0.3, -1.9, 0.65]; // direction the light travels
const LIGHT_INTENSITY = 2.0;
const AMBIENT = 0.3; // OpenAC CellAmbient; retail CreatureMode default
const EYE_AC = [0.24, -2.7, 0.88];
const NEAR_VDIST = 0.001;
// ── our failsafes (retail has none; a lost packet must not strand us) ──
const ARRIVAL_CELLS_WAIT_MAX = 6.0; // s after arrival before ignoring cell residency
const TUNNEL_HOLD_MAX = 20.0; // s in TUNNEL before forcing the exit
// `?portalHoldBuild` (2026-10-09, default on, `=off` escape): past the 6 s
// cells wait, keep holding while the destination landblock's interior build is
// still IN FLIGHT (a stalled or failed build leaves the in-flight set, so it
// releases at once), up to this hard cap. The 6 s cap alone dropped the player
// into a void for ~10 s on the way into the Town Network (1070, 2026-10-09:
// arrival 1.1 s, cells 17.4 s) — portals, signs and paintings hanging in
// mid-air in front of the outdoor mountains around landblock 0x0007.
const ARRIVAL_BUILD_WAIT_MAX = 60.0;
const PORTAL_HOLD_BUILD = (() => {
  try {
    const v = new URLSearchParams(globalThis.location?.search || "").get("portalHoldBuild");
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
})();
const POSE_MOVE_M = 5.0; // stale-pkg arrival fallback threshold
export const NOTICE_TEXT = "In Portal Space - Please Wait...";
// Sound_UI_EnterPortal / Sound_UI_ExitPortal (acclient.h SoundType).
const SOUND_UI_ENTER_PORTAL = 0x6a;
const SOUND_UI_EXIT_PORTAL = 0x6b;

// Sounds — retail PlaySoundFromCenter(Sound_UI_EnterPortal / _ExitPortal,
// GetUISoundTable()) (acclient.c:261845, 262562; 383569-383589): picked
// through the UI SoundTable (row probability + volume), not fixed waves.
// On the retail DAT these rows are 0x0A000246 / 0x0A000245.
const PORTAL_ENTER_WAVE = SOUND_UI_ENTER_PORTAL; // sentinel: "via the SoundTable"
const PORTAL_EXIT_WAVE = SOUND_UI_EXIT_PORTAL;
const SOUND_FADE_S = 0.35;

// UIGlobals::GetAnimLevel — the retail ease table (OpenAC
// TeleportAnimSequencer.BuildRetailAnimationLevels, bit-exact port).
const _ANIM_LEVELS = (() => {
  const retailPi = 3.1415920000000002;
  const r99 = 0.010101010101010102;
  const s = new Int32Array(100);
  let total = 0;
  for (let i = 0; i < 100; i++) {
    const v = Math.trunc(Math.sin(i * retailPi * r99) * 1024.0);
    s[i] = (v << 16) >> 16; // short
    total += s[i];
  }
  let running = 0;
  for (let i = 0; i < 100; i++) {
    running += s[i];
    s[i] = (Math.trunc((running << 10) / total) << 16) >> 16;
  }
  return s;
})();

/** GetAnimLevel(t) in [0,1024] for t in [0,1] (clamped). */
export function retailAnimLevel(t) {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return _ANIM_LEVELS[-Math.trunc(-99.0 * c)];
}

/**
 * Pure gmSmartBoxUI teleport state machine (no THREE / DOM / wasm) — unit
 * tested in test_portal_space_sequencer.mjs. `rng()` -> [0,1).
 */
export function createPortalSequencer(rng = Math.random) {
  const s = {
    state: TAS.OFF,
    t: 0, // seconds in the current state
    rotStart: 0,
    rotEnd: 0,
    rotDur: 0,
    rotT: 0,
    angle: 0, // camera roll, degrees
  };
  const rand = (lo, hi) => lo + rng() * (hi - lo);
  return {
    get state() { return s.state; },
    get t() { return s.t; },
    get angle() { return s.angle; },
    isActive() { return s.state !== TAS.OFF; },
    /** Tunnel visible + world hidden (retail states 2..5). */
    ownsFrame() {
      return s.state === TAS.TUNNEL || s.state === TAS.CONTINUE || s.state === TAS.TUNNEL_FADEOUT;
    },
    /** BeginTeleportAnimation(TAS_TUNNEL): rotation reset, state 3. */
    begin() {
      s.state = TAS.TUNNEL;
      s.t = 0;
      s.rotStart = s.rotEnd = s.angle = 0;
      s.rotDur = 0;
      s.rotT = 0;
    },
    reset() { s.state = TAS.OFF; s.t = 0; },
    /** Tunnel far plane as a fraction of the game view distance. */
    tunnelFarFrac() {
      if (s.state !== TAS.TUNNEL_FADEOUT) return 1;
      const lvl = retailAnimLevel(s.t / FADE_TIME) / 1024;
      return lvl * (NEAR_VDIST - 1) + 1;
    },
    /** Black-overlay alpha over the world (WORLD_FADEIN approximation). */
    worldOverlayAlpha() {
      if (s.state !== TAS.WORLD_FADEIN) return 0;
      return 1 - retailAnimLevel(s.t / FADE_TIME) / 1024;
    },
    /**
     * Advance. `worldReady` = retail !teleport_in_progress; `frame` = the
     * tunnel animation's current frame number. Returns event names:
     * "notice" (new rotation leg), "continue", "exitSound", "done".
     */
    tick(dt, { worldReady = false, frame = 0 } = {}) {
      const ev = [];
      if (s.state === TAS.OFF) return ev;
      s.t += dt;
      if (this.ownsFrame()) {
        s.rotT += dt;
        if (s.rotT >= s.rotDur) {
          s.angle = s.rotEnd;
          s.rotT = 0;
          s.rotDur = rand(ROT_MIN, ROT_MAX);
          s.rotStart = s.angle;
          s.rotEnd = rand(0, 360);
          ev.push("notice");
        } else {
          const lvl = retailAnimLevel(s.rotDur > 0 ? s.rotT / s.rotDur : 1) / 1024;
          s.angle = s.rotStart + (s.rotEnd - s.rotStart) * lvl;
        }
      }
      switch (s.state) {
        case TAS.TUNNEL:
          if (worldReady) { s.state = TAS.CONTINUE; s.t = 0; ev.push("continue"); }
          break;
        case TAS.CONTINUE:
          if (s.t >= MIN_CONTINUE) {
            const remaining = (TUNNEL_END_FRAME - frame) / TUNNEL_FPS;
            if (s.t >= MAX_CONTINUE || (remaining > EXIT_WINDOW_LOW && remaining < EXIT_WINDOW_HIGH)) {
              s.state = TAS.TUNNEL_FADEOUT; s.t = 0;
            }
          }
          break;
        case TAS.TUNNEL_FADEOUT:
          if (s.t >= FADE_TIME) { s.state = TAS.WORLD_FADEIN; s.t = 0; ev.push("exitSound"); }
          break;
        case TAS.WORLD_FADEIN:
          if (s.t >= FADE_TIME) { s.state = TAS.OFF; s.t = 0; ev.push("done"); }
          break;
        default:
          break;
      }
      return ev;
    },
  };
}

/**
 * Is the destination's geometry resident? Indoor cell (low word >= 0x100) ->
 * its EnvCell container; outdoor -> the landblock's terrain bake. A scene
 * without either registry (headless/capture) reads ready.
 */
export function destinationCellsReady(scene3d, cellId) {
  const id = cellId >>> 0;
  if (!id) return false;
  if ((id & 0xffff) >= 0x100) {
    const m = scene3d?.cellContainers3d;
    return m && typeof m.has === "function" ? m.has(id) : true;
  }
  const t = scene3d?.terrainBakedLbs;
  return t && typeof t.has === "function" ? t.has((id & 0xffff0000) >>> 0) : true;
}

/**
 * Is the destination's interior still being built? Indoor cell only: its
 * landblock in `envCellBuildInFlight` (cells.js adds it before the build's
 * first await and removes it on every exit — success, empty, evicted, error).
 */
export function destinationBuildInFlight(scene3d, cellId) {
  const id = cellId >>> 0;
  if (!id || (id & 0xffff) < 0x100) return false;
  const s = scene3d?.envCellBuildInFlight;
  return !!(s && typeof s.has === "function" && s.has((id & 0xffff0000) >>> 0));
}

// ── module state ───────────────────────────────────────────────────────
const _seq = createPortalSequencer();
let _scene3d = null;
let _arrived = false;
let _arrivalCell = 0;
let _arrivedAt = 0; // tunnel-clock seconds at arrival
let _clock = 0; // seconds since the current begin()
let _startPose = null;
let _onExit = null;
let _audio = null;
let _loop = null;
let _exitDid = PORTAL_EXIT_WAVE;
let _reason = "";
// tunnel scene (built once, reused)
let _tunnelScene = null;
let _tunnelCam = null;
let _rigParts = null; // THREE.Group[] (index = setup part)
let _anim = null; // { frames, numParts, numFrames }
let _animTime = 0;
let _frame = 0;
let _building = null;
let _setupDid = 0;
let _animDid = 0;
let _overlay = null; // { scene, cam, mat }
let _noticeEl = null;

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function sessionHandle() {
  try { return (typeof window !== "undefined" && window.__sessionHandle) || null; } catch (_) { return null; }
}

function readPose() {
  const h = sessionHandle();
  if (!h || typeof h.getLocalPlayerPose !== "function") return null;
  let p = null;
  try {
    p = h.getLocalPlayerPose();
    if (!p) return null;
    const out = { lb: p.landblockId >>> 0, x: +p.x, y: +p.y, z: +p.z };
    return out;
  } catch (_) {
    return null;
  } finally {
    try { p?.free?.(); } catch (_) {}
  }
}

function tunnelMaterial(map, surf) {
  const opacity = Math.max(0, Math.min(1, 1 - (+surf.translucency || 0)));
  const ld = new THREE.Vector3(LIGHT_DIR_AC[0], LIGHT_DIR_AC[2], -LIGHT_DIR_AC[1]).normalize().negate();
  // withLogDepth: the renderer uses a logarithmic depth buffer, and the
  // tunnel depth-tests against itself.
  return new THREE.ShaderMaterial(withLogDepth({
    uniforms: {
      map: { value: map },
      hasMap: { value: map ? 1 : 0 },
      opacity: { value: opacity },
      luminosity: { value: Math.max(0, +surf.luminosity || 0) },
      diffuse: { value: Number.isFinite(+surf.diffuse) ? +surf.diffuse : 1 },
      toLight: { value: ld },
      ambient: { value: AMBIENT },
      lightScale: { value: LIGHT_INTENSITY },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vN;
      void main() {
        vUv = uv;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    // Retail fixed-function: tex * clamp(emissive + diffuse*(ambient + I*N.L)).
    fragmentShader: `
      uniform sampler2D map;
      uniform float hasMap, opacity, luminosity, diffuse, ambient, lightScale;
      uniform vec3 toLight;
      varying vec2 vUv;
      varying vec3 vN;
      void main() {
        vec4 tex = hasMap > 0.5 ? texture2D(map, vUv) : vec4(1.0);
        float ndl = max(dot(normalize(vN), toLight), 0.0);
        float lit = clamp(ambient + lightScale * ndl, 0.0, 1.0);
        float light = clamp(luminosity + diffuse * lit, 0.0, 1.0);
        gl_FragColor = vec4(tex.rgb * light, tex.a * opacity);
        if (gl_FragColor.a < 0.004) discard;
        #include <colorspace_fragment>
      }`,
    transparent: opacity < 1,
    depthWrite: opacity >= 1,
    side: THREE.DoubleSide,
  }));
}

async function resolveDid(wasm, enumValue, fallback) {
  try {
    if (typeof wasm?.resolveClientEnumDid === "function") {
      const d = (await wasm.resolveClientEnumDid(enumValue, PORTAL_ENUM_CATEGORY)) >>> 0;
      if (d) return d;
    }
  } catch (_) { /* fall back */ }
  return fallback;
}

async function surfaceMaterials(wasm, dids) {
  const out = new Map();
  if (!dids.length) return out;
  let res = null;
  try {
    if (typeof wasm.fetch_surfaces_pixels === "function") {
      res = await wasm.fetch_surfaces_pixels(new Uint32Array(dids));
    }
  } catch (_) { res = null; }
  for (let i = 0; i < dids.length; i++) {
    const sp = res?.[i];
    let map = null;
    const surf = { translucency: 0, luminosity: 0, diffuse: 1 };
    if (sp) {
      surf.translucency = sp.translucency ?? 0;
      surf.luminosity = sp.luminosity ?? 0;
      surf.diffuse = sp.diffuse ?? 1;
      try {
        if (sp.width && sp.height) map = surfacePixelsToTexture(sp.pixels, sp.width, sp.height);
      } catch (_) { map = null; }
      try { sp.free?.(); } catch (_) {}
    }
    out.set(dids[i] >>> 0, tunnelMaterial(map, surf));
  }
  return out;
}

// Build the tunnel scene once: per-part rig (part-local meshes at the
// Setup's rest pose, driven per-frame by the tunnel Animation), own camera.
async function ensureTunnel(scene3d) {
  if (_tunnelScene) return true;
  if (_building) return _building;
  _building = (async () => {
    const wasm = scene3d?.wasmExports;
    if (!wasm) return false;
    _setupDid = await resolveDid(wasm, PORTAL_SETUP_ENUM, PORTAL_SETUP_FALLBACK);
    _animDid = await resolveDid(wasm, PORTAL_ANIM_ENUM, PORTAL_ANIM_FALLBACK);
    const acRoot = new THREE.Group();
    acRoot.name = "portalSpaceAcRoot";
    acRoot.rotation.x = -Math.PI / 2; // same AC(Z-up) -> three mapping as worldRoot
    const parts = [];
    // Preferred: part-local meshes + rest pose (the entity path).
    try {
      if (typeof wasm.fetchEntityAnimationKeyframes === "function") {
        const e = new Uint32Array(0);
        const data = await wasm.fetchEntityAnimationKeyframes(_setupDid, e, e, 0, e, 0, 0, 0, 0, 0);
        const n = data.partCount | 0;
        const meshes = data.takePartMeshes();
        const ro = data.restOrigins;
        const rq = data.restOrientations;
        try { data.free?.(); } catch (_) {}
        const perPart = [];
        const dids = new Set();
        for (let i = 0; i < n; i++) {
          let groups = [];
          try { groups = meshes[i] ? meshToGeometryGroups(meshes[i]).groups || [] : []; } catch (_) { groups = []; }
          try { meshes[i]?.free?.(); } catch (_) {}
          for (const g of groups) dids.add(g.surfaceDid >>> 0);
          perPart.push(groups);
        }
        const mats = await surfaceMaterials(wasm, [...dids]);
        for (let i = 0; i < n; i++) {
          const pg = new THREE.Group();
          pg.name = `portal_part_${i}`;
          if (ro && ro.length >= (i + 1) * 3) pg.position.set(ro[i * 3], ro[i * 3 + 1], ro[i * 3 + 2]);
          if (rq && rq.length >= (i + 1) * 4) pg.quaternion.set(rq[i * 4 + 1], rq[i * 4 + 2], rq[i * 4 + 3], rq[i * 4]);
          for (const g of perPart[i]) {
            const m = new THREE.Mesh(g.geometry, mats.get(g.surfaceDid >>> 0));
            m.frustumCulled = false;
            pg.add(m);
          }
          acRoot.add(pg);
          parts.push(pg);
        }
      }
    } catch (err) {
      console.warn("[portalSpace] per-part tunnel build failed, using static mesh:", err);
      parts.length = 0;
    }
    // Fallback: the merged static mesh (no part animation).
    if (parts.length === 0 && typeof wasm.fetch_model_meshes === "function") {
      try {
        const meshes = await wasm.fetch_model_meshes(new Uint32Array([_setupDid]));
        const wm = meshes && meshes[0];
        const { groups } = wm ? meshToGeometryGroups(wm) : { groups: [] };
        try { wm?.free?.(); } catch (_) {}
        const mats = await surfaceMaterials(wasm, [...new Set(groups.map((g) => g.surfaceDid >>> 0))]);
        const pg = new THREE.Group();
        for (const g of groups) {
          const m = new THREE.Mesh(g.geometry, mats.get(g.surfaceDid >>> 0));
          m.frustumCulled = false;
          pg.add(m);
        }
        acRoot.add(pg);
      } catch (err) {
        console.warn("[portalSpace] tunnel mesh fetch failed:", err);
      }
    }
    // Tunnel animation (frame-major, 7 floats per part: xyz + wxyz).
    _anim = null;
    if (parts.length > 0 && typeof wasm.fetchAnimation === "function") {
      try {
        const a = await wasm.fetchAnimation(_animDid);
        const anim = { frames: a.frames, numParts: a.numParts | 0, numFrames: a.numFrames | 0 };
        try { a.free?.(); } catch (_) {}
        if (anim.numParts === parts.length && anim.numFrames > 1 &&
            anim.frames.length >= anim.numParts * anim.numFrames * 7) {
          _anim = anim;
        } else {
          console.warn(`[portalSpace] animation 0x${_animDid.toString(16)} parts=${anim.numParts} vs setup parts=${parts.length} — static tunnel`);
        }
      } catch (err) {
        console.warn("[portalSpace] tunnel animation fetch failed:", err);
      }
    }
    _rigParts = parts;
    const scene = new THREE.Scene();
    scene.name = "portalSpaceScene";
    scene.add(acRoot);
    _tunnelCam = new THREE.PerspectiveCamera(45, 1, 0.05, 4000);
    _tunnelScene = scene;
    return true;
  })();
  try {
    return await _building;
  } finally {
    _building = null;
  }
}

// CSequence-style discrete playback: frames 1..N-1 (LowFrame=1, HighFrame=-1)
// at 40 fps, looping. Returns the current frame number.
function advanceAnim(dt) {
  if (!_anim || !_rigParts) return 0;
  const n = _anim.numFrames;
  const span = n - 1;
  _animTime += dt;
  const f = 1 + (Math.floor(_animTime * TUNNEL_FPS) % span);
  if (f !== _frame) {
    const fr = _anim.frames;
    const np = _anim.numParts;
    for (let p = 0; p < np; p++) {
      const b = (f * np + p) * 7;
      const g = _rigParts[p];
      g.position.set(fr[b], fr[b + 1], fr[b + 2]);
      g.quaternion.set(fr[b + 4], fr[b + 5], fr[b + 6], fr[b + 3]);
    }
  }
  _frame = f;
  return f;
}

function setNotice(on) {
  if (typeof document === "undefined") return;
  try {
    if (on && !_noticeEl) {
      const el = document.createElement("div");
      el.id = "hb-portal-space-notice";
      el.setAttribute("aria-live", "polite");
      el.style.cssText =
        "position:fixed;left:0;right:0;top:18%;text-align:center;pointer-events:none;" +
        "z-index:60;font:14px var(--hb-font-serif,serif);color:#f0e0b8;" +
        "text-shadow:0 1px 3px #000,0 0 6px #000;";
      el.textContent = NOTICE_TEXT;
      document.body.appendChild(el);
      _noticeEl = el;
    }
    if (_noticeEl) _noticeEl.style.display = on ? "block" : "none";
  } catch (_) {}
}

// `did` is a SoundType (0x6A/0x6B: resolve through the UI SoundTable, the
// retail path) or an explicit Wave DID override (?portalSound=<hex>), which
// plays from the centre at volume 1.0 (retail PlaySoundFromCenter(gid, 1.0)).
function playOneShot(scene3d, did) {
  if (!_audio || !did) return;
  if (did === SOUND_UI_ENTER_PORTAL || did === SOUND_UI_EXIT_PORTAL) {
    playUiSound(scene3d, did).catch(() => {});
  } else if (typeof _audio.playFromCenter === "function") {
    _audio.playFromCenter(did >>> 0, 1.0).catch(() => {});
  }
}

function stopLoop() {
  const h = _loop;
  _loop = null;
  if (!h?.source) return;
  try {
    const ctx = h.gain?.context;
    if (ctx && h.gain) {
      const t = ctx.currentTime;
      h.gain.gain.setTargetAtTime(0, t, SOUND_FADE_S / 3);
      h.source.stop(t + SOUND_FADE_S);
    } else {
      h.source.stop();
    }
  } catch (_) {}
}

function publishDiag() {
  try {
    if (typeof window === "undefined") return;
    window.__portalSpace = {
      state: _seq.state,
      arrived: _arrived,
      arrivalCell: _arrivalCell,
      reason: _reason,
      setupDid: _setupDid,
      animDid: _animDid,
      animated: !!_anim,
      frame: _frame,
      angle: _seq.angle,
      clock: _clock,
    };
  } catch (_) {}
}

/**
 * Enter portal space (kind=33 PlayerTeleport). Rapid re-teleport while
 * active re-opens the tunnel (world hidden again) and re-arms arrival.
 *
 * @param {object} scene3d  live scene handle
 * @param {object} [opts]   { enterDid, loopDid, exitDid, onExit }
 *   enterDid/exitDid: Wave DIDs (undefined = retail default, 0 = muted)
 */
export function startPortalSpace(scene3d, opts = {}) {
  if (!scene3d) return;
  _scene3d = scene3d;
  _audio = scene3d.audioManager ?? null;
  _onExit = typeof opts.onExit === "function" ? opts.onExit : null;
  const enterDid = opts.enterDid === undefined ? PORTAL_ENTER_WAVE : opts.enterDid >>> 0;
  _exitDid = opts.exitDid === undefined ? PORTAL_EXIT_WAVE : opts.exitDid >>> 0;
  const wasOwning = _seq.ownsFrame();
  _seq.begin();
  _arrived = false;
  _arrivalCell = 0;
  _arrivedAt = 0;
  _clock = 0;
  _reason = "tunnel";
  _startPose = readPose();
  if (!wasOwning) playOneShot(scene3d, enterDid);
  const loopDid = opts.loopDid ? opts.loopDid >>> 0 : 0;
  if (loopDid && !_loop && _audio) {
    _audio
      .playFromCenter(loopDid, 1.0, { loop: true })
      .then((h) => { if (h && _seq.isActive()) _loop = h; else if (h) { _loop = h; stopLoop(); } })
      .catch(() => {});
  }
  setNotice(true);
  ensureTunnel(scene3d).catch((e) => console.warn("[portalSpace] tunnel build failed:", e));
  publishDiag();
}

/**
 * Destination applied (kind=66 TeleportArrived). `cellId` = destination
 * objcell (0 = unknown: the cells half then waits on the failsafe cap).
 */
export function signalPortalArrived(info) {
  if (!_seq.isActive() || _arrived) return;
  _arrived = true;
  _arrivedAt = _clock;
  const c = typeof info === "object" && info ? info.cellId : info;
  _arrivalCell = (c >>> 0) || 0;
  _reason = "arrived";
  publishDiag();
}

/** True while any portal-space state is running. */
export function isPortalSpaceActive() {
  return _seq.isActive();
}
// streaming-teleport-5: ui/portal_busy.js reads this (retail
// CPlayerSystem::teleportInProgress spans the tunnel through the fade-in).
try { globalThis.__isPortalSpaceActive = isPortalSpaceActive; } catch (_) {}

/** True while the tunnel owns the screen (world submission skipped). */
export function portalSpaceOwnsFrame() {
  return _seq.ownsFrame();
}

function computeWorldReady(scene3d) {
  if (!_arrived) {
    // Stale-pkg fallback (no kind=66): the local pose left the start pose.
    if (_clock > 0.25) {
      const p = readPose();
      if (p && _startPose && p.lb &&
          (p.lb !== _startPose.lb ||
           Math.hypot(p.x - _startPose.x, p.y - _startPose.y, p.z - _startPose.z) > POSE_MOVE_M)) {
        _arrived = true;
        _arrivedAt = _clock;
        _arrivalCell = p.lb;
        _reason = "arrived(pose-fallback)";
      }
    }
    if (!_arrived && _clock >= TUNNEL_HOLD_MAX) {
      _reason = "failsafe(no-arrival)";
      return true;
    }
    if (!_arrived) return false;
  }
  if (_arrivalCell && destinationCellsReady(scene3d, _arrivalCell)) {
    _reason = "cells-ready";
    return true;
  }
  const waited = _clock - _arrivedAt;
  if (waited >= ARRIVAL_CELLS_WAIT_MAX) {
    if (PORTAL_HOLD_BUILD && waited < ARRIVAL_BUILD_WAIT_MAX
        && destinationBuildInFlight(scene3d, _arrivalCell)) {
      _reason = "building";
      return false;
    }
    _reason = waited >= ARRIVAL_BUILD_WAIT_MAX ? "failsafe(build-wait)" : "failsafe(cells-wait)";
    return true;
  }
  return false;
}

/** Per-frame driver. Called from loop.js AFTER the camera tick. */
export function tickPortalSpace(scene3d, dt) {
  if (!_seq.isActive()) return;
  const d = Math.min(Math.max(+dt || 0, 0), 0.25);
  _clock += d;
  const frame = advanceAnim(d);
  const worldReady = _seq.state === TAS.TUNNEL ? computeWorldReady(scene3d ?? _scene3d) : true;
  // No animation -> no frame sync; let the 5 s cap / window logic run on a
  // synthetic frame that never lands in the exit window.
  const ev = _seq.tick(d, { worldReady, frame: _anim ? frame : 0 });
  for (const e of ev) {
    if (e === "exitSound") {
      playOneShot(scene3d ?? _scene3d, _exitDid);
      setNotice(false);
    } else if (e === "done") {
      endPortalSpace();
      return;
    }
  }
  if (!_seq.ownsFrame()) setNotice(false);
  publishDiag();
}

/**
 * Draw the tunnel in place of the world (retail SmartBox::Hide + portal
 * viewport cleared black). Returns true when it owned this frame's
 * submission — the caller then skips the world render.
 */
export function renderPortalSpaceFrame(renderer, mainCam) {
  if (!_seq.ownsFrame() || !renderer) return false;
  const prevTarget = renderer.getRenderTarget?.() ?? null;
  const prevAutoClear = renderer.autoClear;
  const prevColor = new THREE.Color();
  renderer.getClearColor?.(prevColor);
  const prevAlpha = renderer.getClearAlpha?.() ?? 1;
  try {
    renderer.setRenderTarget(null);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, true);
    if (_tunnelScene && _tunnelCam) {
      const cam = _tunnelCam;
      const gameFar = mainCam?.far > 0 ? mainCam.far : 4000;
      cam.fov = mainCam?.fov > 0 ? mainCam.fov : 45;
      cam.aspect = mainCam?.aspect > 0 ? mainCam.aspect : 1;
      cam.near = 0.05;
      cam.far = Math.max(cam.near + 1e-3, gameFar * _seq.tunnelFarFrac());
      cam.updateProjectionMatrix();
      // AC eye (0.24,-2.7,0.88) looking +Y, rolled about the view axis.
      const a = (_seq.angle * Math.PI) / 180;
      cam.position.set(EYE_AC[0], EYE_AC[2], -EYE_AC[1]);
      cam.up.set(Math.sin(a), Math.cos(a), 0);
      cam.lookAt(EYE_AC[0], EYE_AC[2], -EYE_AC[1] - 1);
      renderer.autoClear = false;
      renderer.render(_tunnelScene, cam);
    }
    return true;
  } catch (e) {
    console.warn("[portalSpace] tunnel render failed:", e);
    return true; // world stays hidden; next frame retries
  } finally {
    renderer.autoClear = prevAutoClear;
    renderer.setClearColor(prevColor, prevAlpha);
    try { renderer.setRenderTarget(prevTarget); } catch (_) {}
  }
}

/** WORLD_FADEIN: black quad fading out over the freshly drawn world. */
export function renderPortalSpaceOverlay(renderer) {
  const alpha = _seq.worldOverlayAlpha();
  if (!(alpha > 0.002) || !renderer) return;
  if (!_overlay) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { alpha: { value: 1 } },
      vertexShader: "void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: "uniform float alpha; void main(){ gl_FragColor = vec4(0.0, 0.0, 0.0, alpha); }",
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(quad);
    _overlay = { scene, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), mat };
  }
  _overlay.mat.uniforms.alpha.value = alpha;
  const prevAutoClear = renderer.autoClear;
  const prevTarget = renderer.getRenderTarget?.() ?? null;
  try {
    renderer.setRenderTarget(null);
    renderer.autoClear = false;
    renderer.render(_overlay.scene, _overlay.cam);
  } catch (_) {
  } finally {
    renderer.autoClear = prevAutoClear;
    try { renderer.setRenderTarget(prevTarget); } catch (_) {}
  }
}

/** Tear down (normal end or forced). The tunnel scene is kept for reuse. */
export function endPortalSpace() {
  const wasActive = _seq.isActive();
  _seq.reset();
  _arrived = false;
  setNotice(false);
  stopLoop();
  _reason = "off";
  publishDiag();
  const cb = _onExit;
  _onExit = null;
  if (cb) {
    try { cb({ forced: wasActive }); } catch (_) {}
  }
}

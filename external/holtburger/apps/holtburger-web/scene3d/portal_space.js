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
//     5 TUNNEL_FADEOUT 1 s — the smartbox view-plane distance
//                      (SetOverrideFovDistance) lerps to 0.001 along
//                      GetAnimLevel. It only ever becomes an FOV (Render::
//                      set_vdst -> SetFOVInternal, zfar untouched): the tunnel
//                      zooms out to a point; nothing darkens.
//     6 WORLD_FADEIN   SmartBox::Show + Sound_UI_ExitPortal; 1 s view-distance
//                      grow-in (the world zooms in from a point), then
//                      LoginComplete + teleport_in_progress=0.
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
//   FOV    `?portalFovFade=on` (2026-10-13, cells-portals-3, OPT-IN until a 1070
//          teleport eye test; absent = the far-plane shrink + black quad above):
//          the retail fades. TUNNEL_FADEOUT widens the tunnel camera's fov
//          toward 179° (far plane kept), WORLD_FADEIN narrows the world
//          camera's from 179° back to its own (no black quad) — viewDistFov.
//          The world camera's fov is held between frames and put back at OFF /
//          teardown / a new tunnel; the CSM keeps fitting the game fov
//          (userData.csmFitFov, csm.js). See _tickWorldFov.
//   LOGIN  (2026-10-09, `?loginPortalSpace`, default `quick`) retail enters the
//          same TAS_TUNNEL at login (SmartBox::teleport_in_progress = player &&
//          !position_update_complete, acclient.c:143092; position_update_complete
//          stays 0 until the cell manager stops blocking, :146270-146283).
//          client_events.js's FIRST ENTERED_WORLD of a login scope calls
//          requestLoginPortalSpace; the first tickPortalSpace decides: spawn cell
//          already resident (char-screen warm path) → no tunnel, no sound; else
//          the tunnel holds with the teleport build-aware rule (6 s, then while
//          the spawn interior is building / __interiorBuildPending, 60 s cap).
//          `quick` fades out as soon as the cell is ready (no CONTINUE floor),
//          `retail` keeps CONTINUE (2-5 s) — the owner picks. A death respawn
//          never re-triggers (enteredWorld stays true for the login scope).
//   PACE   `?portalSpaceFps` (default 30): scene3d/index.js scheduleNext paces
//          the loop while the tunnel owns the frame (portalSpaceFrameIntervalMs);
//          tickPerFrame (net pump, cell visibility/PVS, interior builds) keeps
//          running at that rate — only the world submission is skipped.
//   WARM   `?tunnelWorldWarm` (2026-10-09, default on): while the tunnel owns
//          the frame, every ~1 s, the WORLD's programs start linking off the
//          main thread with the target each draw binds (composer passes, the
//          main scene into the composer buffer, the sky into a PMREM-class
//          target) — the reveal frame no longer links them. The release waits
//          ≤ 1.5 s for a still-linking program the async-link guard would not
//          defer (`nohold`: never). See warmWorldPrograms.
//   DRONE  `?portalDrone` (2026-10-13, cells-portals-5, default on, `=off`
//          escape): the tunnel animation's Sound / SoundTweaked hooks, read
//          from the DAT (wasm fetchAnimation soundHook*) — retail frame 2's
//          SoundTweaked Wave 0x0A000316 at vol 0.3, every 2.975 s loop. See
//          hooksCrossed / tickDrone. `?portalSoundLoop` replaces it.
//   NOT PORTED: LoginComplete timing (the wasm still sends it on PlayerTeleport —
//          see holtburger_core DEFER_LOGIN_COMPLETE_AFTER_TELEPORT; at login it
//          is sent before the tunnel ends, so ACE materialises the player while
//          the client still shows the tunnel), the logout tunnel entry, the
//          tunnel animation's non-sound hooks.
//
// `?portalSpace=off` disables the whole presentation (the world just stays up),
// the login entry included.

import * as THREE from "three";
import { meshToGeometryGroups, surfacePixelsToTexture } from "./adapter.js";
import { withLogDepth } from "./shader_logdepth.js";
import { playUiSound, rollProbability, retailVolume } from "./audio/retail_sound_rules.js";
import { hookFiresInDirection } from "./hook_windows.js";
import { wireframeFlagOn } from "./wireframe_flag.js";
import { getWarmTarget, compileWithTarget, programsOf, programPending, prunePending, warmSceneMaterials } from "./shader_prewarm.js";

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
// 2026-10-09 (Phase 4, 1070): quick login mode's tunnel fade-out. The retail 1 s fade runs on the
// sequencer's frame-dt clock, which a busy load stretches to 2.5-3.2 s of wall time between "walls
// ready" and the first world pixel; quick mode exists to show the walls as soon as they are up, so it
// fades the tunnel in 0.25 s (the world still fades in over the retail 1 s). Retail mode and
// teleports keep FADE_TIME.
const QUICK_FADE_OUT = 0.25;
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
// Login entry: how long the first ticks may wait for the spawn cell to resolve
// before deciding (the raw pose reads cell 0 right at EnteredWorld on a login
// INTO a dungeon — client_events.js spawn-kick note), and the warm-path
// backstop: cells ready this early after a silent start → end without fades.
const LOGIN_CELL_WAIT_S = 0.5;
const LOGIN_INSTANT_S = 0.3;

/**
 * `?loginPortalSpace` — `off|0|false|no` → "off" (today's login, no tunnel);
 * `retail` → "retail" (CONTINUE 2-5 s + fades, acclient.c EndTeleportAnimation);
 * absent / `quick` / anything else → "quick" (fade out as soon as the spawn
 * cell is ready). Read per call so tests can pass `search`.
 */
export function loginPortalSpaceMode(search) {
  try {
    const s = typeof search === "string" ? search : (globalThis.location?.search || "");
    const v = (new URLSearchParams(s).get("loginPortalSpace") || "").trim().toLowerCase();
    if (v === "off" || v === "0" || v === "false" || v === "no") return "off";
    return v === "retail" ? "retail" : "quick";
  } catch (_) {
    return "quick";
  }
}

const _ON = new Set(["1", "on", "true", "yes"]);
/**
 * Why the login tunnel must not run on this page, or null. Agents and
 * capture modes keep today's login: a frozen/hand-driven loop would capture
 * the tunnel (renderOnDemand), nullRender draws nothing, a bot/agent must not
 * have combat mode refused by ui/portal_busy.js, wireframe has no composer.
 */
export function loginPortalSpaceSkipReason(search) {
  const s = typeof search === "string" ? search : (globalThis.location?.search || "");
  if (loginPortalSpaceMode(s) === "off") return "flag";
  try {
    const p = new URLSearchParams(s);
    const ps = (p.get("portalSpace") || "").trim().toLowerCase();
    if (ps === "off" || ps === "0" || ps === "false" || ps === "no") return "portalSpace";
    if (_ON.has((p.get("nullRender") || "").trim().toLowerCase())) return "nullRender";
    if (_ON.has((p.get("renderOnDemand") || "").trim().toLowerCase())) return "renderOnDemand";
    if (_ON.has((p.get("bot") || "").trim().toLowerCase())) return "bot";
    if (_ON.has((p.get("agent") || "").trim().toLowerCase())) return "agent";
  } catch (_) { /* unparsable search: no URL-driven skip */ }
  if (wireframeFlagOn(s)) return "wireframe";
  return null;
}

/**
 * `?portalSpaceFps` — the loop's frame interval while the tunnel owns the
 * frame: absent → 30 fps; `off|0|false|no` → 0 (uncapped, today); a number N →
 * clamped to [10, 120] fps. Pure (tests pass `search`); the runtime value is
 * memoised below.
 */
export function portalSpaceFpsIntervalMs(search) {
  try {
    const s = typeof search === "string" ? search : (globalThis.location?.search || "");
    const v = (new URLSearchParams(s).get("portalSpaceFps") || "").trim().toLowerCase();
    if (v === "off" || v === "0" || v === "false" || v === "no") return 0;
    const n = v === "" ? 30 : Number(v);
    if (!Number.isFinite(n) || n <= 0) return 1000 / 30;
    return 1000 / Math.min(120, Math.max(10, n));
  } catch (_) {
    return 1000 / 30;
  }
}
const PACE_MS = portalSpaceFpsIntervalMs();

// `?portalSpacePrecompile` (default on): link the tunnel's and the fade
// overlay's ShaderMaterials off the main thread right after the tunnel scene is
// built — renderer.compile with the CANVAS bound (their draws go to the canvas;
// the HalfFloat warm target would key the other variant), then three's
// non-blocking isReady() on every program each material owns (a transparent
// DoubleSide part has a Back and a Front program). The tunnel draws black until
// they are ready. Off: they link synchronously on the first tunnel frame (today).
const PRECOMPILE = (() => {
  try {
    const v = (new URLSearchParams(globalThis.location?.search || "").get("portalSpacePrecompile") || "").toLowerCase();
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
})();
const PRECOMPILE_WAIT_MAX_MS = 8000; // then draw anyway (a lost poll must not hide the tunnel)

/**
 * `?tunnelWorldWarm` (2026-10-09, D2) — `off|0|false|no` → "off" (today: the
 * world's programs link in the reveal frame); `nohold` → warm, but never hold
 * the release; absent / `on` / anything else → "on". Read per tunnel start
 * (`_startTunnel`), so tests can pass `search`.
 *
 * Why: the tunnel skips the world submission, so the composer's first frame
 * became the REVEAL frame — 1070 academy spawn (acad-diagF): EffectMaterial
 * (the final EffectPass, drawn to the canvas) linked 512 ms at the reveal,
 * plus its bloom / luminance / second EffectPass siblings (~160 ms); before
 * the tunnel it linked at boot (253 ms).
 */
export function tunnelWorldWarmMode(search) {
  try {
    const s = typeof search === "string" ? search : (globalThis.location?.search || "");
    const v = (new URLSearchParams(s).get("tunnelWorldWarm") || "").trim().toLowerCase();
    if (v === "off" || v === "0" || v === "false" || v === "no") return "off";
    return v === "nohold" ? "nohold" : "on";
  } catch (_) {
    return "on";
  }
}
/** Tunnel-clock seconds between warm passes while the tunnel owns the frame. */
export const WARM_INTERVAL_S = 1.0;
/** Most the release waits for a still-linking unguarded program (mode "on"). */
export const WARM_HOLD_MAX_S = 1.5;
/** Most NEW main-scene materials compiled per pass (the rest: next pass). */
export const WARM_NEW_MAX = 256;
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

// ── portal-space drone (cells-portals-5, 2026-10-13) ───────────────────
// Retail plays the tunnel object's animation as a normal CSequence:
// UseTime set_sequence_animation(teleportObj, GetDIDByEnum(0x10000002, 7),
// interrupt 1, low frame 1, 40.0) (acclient.c:262444, 316619), and
// CSequence::update_internal (340659) runs execute_hooks (339683) for every
// frame the playhead LEAVES. The retail clip 0x030005AC carries one hook:
// frame 2, SoundTweaked (Both), Wave 0x0A000316 (3.01 s), prob 1, vol 0.3 —
// re-fired every 119/40 = 2.975 s loop, a continuous drone between the
// whooshes. SoundTweakedHook::Execute -> PlaySoundA(gid, obj, prio, prob, vol)
// (342207, 383490): PlayProbability(prob), then PlaySoundInternal at the
// object's position while CreatureMode's draw holds the listener at the portal
// camera (143926-143934) — ~2.85 m away, inside VOL_MIN_DIST (5 m): no
// falloff, pan 0, i.e. from the centre at `vol`. SoundHook (type 1) plays at
// effect_sound_volume, which GetAttenuation applies again (342188, 383481).
// The hooks come from the DAT (wasm fetchAnimation soundHook*): no hook, no
// sound; a stale pkg without those getters stays silent.

/**
 * `?portalDrone` — `off|0|false|no` → false (the tunnel's sound hooks stay
 * silent); absent / anything else → true. Read per tunnel start, so tests can
 * pass `search`.
 */
export function portalDroneEnabled(search) {
  try {
    const s = typeof search === "string" ? search : (globalThis.location?.search || "");
    const v = (new URLSearchParams(s).get("portalDrone") || "").trim().toLowerCase();
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
}

/**
 * The wasm AnimationJs sound-hook arrays → `[{frame, hookType, direction,
 * volume, probability, wave}]`. `frames` / `waves` are Uint32Arrays (wave ids
 * exceed 2^24 — a Float32Array would round them), `meta` 4 floats per hook
 * `[hookType, direction, volume, probability]`. Missing (stale pkg) or ragged
 * arrays → [] (no hooks, no sound); a zero wave is dropped.
 */
export function parseTunnelSoundHooks(frames, waves, meta) {
  const out = [];
  if (!frames || !waves || !meta) return out;
  const n = frames.length | 0;
  if (!(n > 0) || waves.length !== n || meta.length < n * 4) return out;
  for (let i = 0; i < n; i++) {
    const wave = waves[i] >>> 0;
    if (!wave) continue;
    out.push({
      frame: frames[i] >>> 0,
      hookType: Math.round(meta[i * 4]),
      direction: Math.round(meta[i * 4 + 1]),
      volume: +meta[i * 4 + 2],
      probability: +meta[i * 4 + 3],
      wave,
    });
  }
  return out;
}

/**
 * Hooks to fire when the tunnel playhead moves from absolute frame count
 * `prevAbs` to `curAbs` (frames played since the sequence start; frame number
 * = 1 + abs % (n-1), the retail low frame 1 / high frame n-1 loop). Retail
 * CSequence::update_internal (acclient.c:340659): advancing, it runs the hooks
 * of each frame it LEAVES — execute_hooks(frame, 1), which skips Backward
 * hooks (339683; the shared gate hook_windows.js hookFiresInDirection) — and
 * passing the high frame clamps to it and wraps (advance_to_next_animation)
 * without running the high frame's own hooks. A stall (hidden tab) fires at
 * most one loop's worth. Pure; exported for the node test. `hooks`:
 * `[{frame, direction, …}]`, returned in firing order.
 */
export function hooksCrossed(prevAbs, curAbs, n, hooks) {
  const out = [];
  const span = (n | 0) - 1;
  if (!(span >= 1) || !hooks || !hooks.length) return out;
  let from = Math.floor(+prevAbs || 0);
  const to = Math.floor(+curAbs || 0);
  if (!(to > from)) return out;
  if (to - from > span) from = to - span;
  for (let a = from; a < to; a++) {
    const left = 1 + (((a % span) + span) % span);
    if (left === span) continue; // the high frame: retail clamps + wraps, no hooks
    for (const h of hooks) {
      if (h.frame === left && hookFiresInDirection(h, 1)) out.push(h);
    }
  }
  return out;
}

/**
 * How one tunnel sound hook plays (retail SoundHook / SoundTweakedHook
 * ::Execute, acclient.c:342188-342209 -> PlaySoundA 383465-383510):
 * SoundTweaked rolls its probability (PlayProbability) and plays at its own
 * volume (0 = silent); Sound always plays at the effect slider, applied twice.
 * Returns `{ play, volume, sliderTwice, reason }`.
 */
export function soundHookPlan(hook, rng = Math.random) {
  const ht = hook ? hook.hookType | 0 : 0;
  if (!hook || !(hook.wave >>> 0)) return { play: false, volume: 0, sliderTwice: false, reason: "no_wave" };
  if (ht === 21) {
    if (!rollProbability(hook.probability, rng)) return { play: false, volume: 0, sliderTwice: false, reason: "probability" };
    const volume = retailVolume(hook.volume);
    if (!(volume > 0)) return { play: false, volume, sliderTwice: false, reason: "silent" };
    return { play: true, volume, sliderTwice: false, reason: "ok" };
  }
  if (ht === 1) return { play: true, volume: 1.0, sliderTwice: true, reason: "ok" };
  return { play: false, volume: 0, sliderTwice: false, reason: "type" };
}

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

// ── portal-space FOV fades (cells-portals-3, 2026-10-13) ───────────────
// Retail's fades never dim anything. UseTime states 5/6 (acclient.c:262497-
// 262527) lerp the SmartBox view-plane distance between gameVDist (captured by
// BeginTeleportAnimation from GetOverrideFovDistance, whose default is
// 1/tan(fovV/2), 143080) and 0.001 along GetAnimLevel, and push it with
// SetOverrideFovDistance (143073). RenderNormalMode (the world, 144891) and
// CreatureMode with UseSmartboxFOV (the tunnel viewport, 143942) consume it
// only through Render::set_vdst (378875) -> SetFOVInternal (453039) ->
// D3DXMatrixPerspectiveFovLH(fov, aspect, znear, Render::zfar): an FOV, zfar
// untouched. 0.001 is ~180°: the tunnel recedes to a point, then the world
// zooms in from one.

/** The widest fov the zoom draws (degrees): set_vdst clamps at π, where
 *  three's perspective projection degenerates. */
export const PORTAL_FOV_MAX_DEG = 179;

/**
 * `?portalFovFade` — OPT-IN: only `on` → true (the retail FOV zoom fades);
 * absent / anything else → false (today's tunnel far-plane shrink + black
 * world quad). Read per tunnel start, so tests can pass `search`.
 */
export function portalFovFadeEnabled(search) {
  try {
    const s = typeof search === "string" ? search : (globalThis.location?.search || "");
    return (new URLSearchParams(s).get("portalFovFade") || "").trim().toLowerCase() === "on";
  } catch (_) {
    return false;
  }
}

/** SmartBox::GetOverrideFovDistance's default for a vertical fov (degrees):
 *  1 / tan(fov/2) (acclient.c:143080). */
export function viewDistForFov(fovDeg) {
  return 1 / Math.tan((fovDeg * Math.PI) / 360);
}

/**
 * Render::set_vdst (acclient.c:378875): the vertical fov (degrees) a
 * view-plane distance gives, 2·atan(1/vdist), capped at PORTAL_FOV_MAX_DEG.
 * The printed `atan2(_vdst, 1.0)` is the decompiler's FPATAN operand order;
 * 2·atan(1/vdist) is the reading that is the identity at the default
 * distance and keeps set_vdst's znear = vdist·0.25 at a constant half-width.
 */
export function fovForViewDist(vdist) {
  if (!(vdist > 0)) return PORTAL_FOV_MAX_DEG;
  const f = (2 * Math.atan(1 / vdist) * 180) / Math.PI;
  return f > PORTAL_FOV_MAX_DEG ? PORTAL_FOV_MAX_DEG : f;
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
    minC: MIN_CONTINUE, // this run's CONTINUE floor / cap (login quick mode: 0 / 0)
    maxC: MAX_CONTINUE,
    fadeOut: FADE_TIME, // this run's TUNNEL_FADEOUT length (login quick mode: QUICK_FADE_OUT)
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
    /**
     * BeginTeleportAnimation(TAS_TUNNEL): rotation reset, state 3.
     * `opts.minContinue` / `opts.maxContinue` (seconds) override this run's
     * CONTINUE floor and cap; omitted = retail 2 s / 5 s. `opts.fadeOut`
     * (seconds, >= 0) overrides this run's tunnel fade-out; omitted = retail 1 s.
     */
    begin(opts) {
      s.state = TAS.TUNNEL;
      s.t = 0;
      s.rotStart = s.rotEnd = s.angle = 0;
      s.rotDur = 0;
      s.rotT = 0;
      const mn = opts && Number.isFinite(opts.minContinue) ? Math.max(0, opts.minContinue) : MIN_CONTINUE;
      const mx = opts && Number.isFinite(opts.maxContinue) ? Math.max(mn, opts.maxContinue) : MAX_CONTINUE;
      s.minC = mn;
      s.maxC = Math.max(mn, mx);
      s.fadeOut = opts && Number.isFinite(opts.fadeOut) ? Math.max(0, opts.fadeOut) : FADE_TIME;
    },
    reset() { s.state = TAS.OFF; s.t = 0; },
    /** Tunnel far plane as a fraction of the game view distance. */
    tunnelFarFrac() {
      if (s.state !== TAS.TUNNEL_FADEOUT) return 1;
      const lvl = retailAnimLevel(s.fadeOut > 0 ? s.t / s.fadeOut : 1) / 1024;
      return lvl * (NEAR_VDIST - 1) + 1;
    },
    /** Black-overlay alpha over the world (WORLD_FADEIN approximation). */
    worldOverlayAlpha() {
      if (s.state !== TAS.WORLD_FADEIN) return 0;
      return 1 - retailAnimLevel(s.t / FADE_TIME) / 1024;
    },
    /**
     * ?portalFovFade: the vertical fov (degrees) retail's view-distance
     * override gives a camera whose own fov is `fovDeg` — null outside
     * TUNNEL_FADEOUT / WORLD_FADEIN (or for a fov outside (0,180)).
     * gmSmartBoxUI::UseTime (acclient.c:262497-262527), g = 1/tan(fov/2),
     * L = GetAnimLevel/1024: state 5 vdist = g + (0.001 - g)·L over this
     * run's fade-out (the quick login fade included), state 6 vdist =
     * 0.001 + (g - 0.001)·L over FADE_TIME; fov = 2·atan(1/vdist).
     */
    viewDistFov(fovDeg) {
      const out = s.state === TAS.TUNNEL_FADEOUT;
      if (!out && s.state !== TAS.WORLD_FADEIN) return null;
      if (!(fovDeg > 0 && fovDeg < 180)) return null;
      const g = viewDistForFov(fovDeg);
      if (out) {
        const lvl = retailAnimLevel(s.fadeOut > 0 ? s.t / s.fadeOut : 1) / 1024;
        return fovForViewDist(g + (NEAR_VDIST - g) * lvl);
      }
      const lvl = retailAnimLevel(s.t / FADE_TIME) / 1024;
      return fovForViewDist(NEAR_VDIST + (g - NEAR_VDIST) * lvl);
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
          if (s.t >= s.minC) {
            const remaining = (TUNNEL_END_FRAME - frame) / TUNNEL_FPS;
            if (s.t >= s.maxC || (remaining > EXIT_WINDOW_LOW && remaining < EXIT_WINDOW_HIGH)) {
              s.state = TAS.TUNNEL_FADEOUT; s.t = 0;
            }
          }
          break;
        case TAS.TUNNEL_FADEOUT:
          if (s.t >= s.fadeOut) { s.state = TAS.WORLD_FADEIN; s.t = 0; ev.push("exitSound"); }
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
// ?portalSpacePrecompile: programs to await before the tunnel / overlay draw.
let _tunnelProgs = null; // null = not compiled (draw as today); [] = nothing to await
let _tunnelProgsAt = 0;
let _tunnelReady = true; // false while precompiled programs are still linking
let _overlayProgs = null;
// Login entry (?loginPortalSpace).
let _loginPending = null; // { cellId, sc, waited } until the first tick decides
let _loginMode = false; // the running tunnel is a login tunnel
let _loginAnnounced = false; // enter whoosh + notice played (only once it really holds)
let _loginRequestMode = ""; // "quick" | "retail" | "off" at the last request
let _loginSkip = null; // why the last login request ran no tunnel (or null)
let _loginStarts = 0;
// performance.now() stamps of the current/last run (login AND teleport):
// start = tunnel up, ready = "continue" (cells ready), reveal = "exitSound"
// (first world frame), done = sequence over.
let _t = { start: 0, ready: 0, reveal: 0, done: 0, cells: 0 };
// ?tunnelWorldWarm (per run unless noted).
let _warmMode = "off"; // read at each tunnel start
let _warmLastAt = -Infinity; // tunnel clock of the last warm pass
let _warmHoldFrom = -1; // tunnel clock the release hold began (-1 = not holding)
let _warmHoldSpent = false; // one bounded hold per run
const _warmHeld = new Set(); // unguarded programs still linking (the hold set)
const _warmSeen = new WeakMap(); // material -> keys compiled (whole session)
const _warmZero = () => ({ passes: 0, compiled: 0, deferred: 0, fullscreen: 0, held: 0, sky: 0, lastMs: 0, maxMs: 0, totalMs: 0, holdMs: 0, holdCapped: false, errors: 0 });
let _warmStats = _warmZero();
let _warmRuns = 0;
// ?portalDrone (cells-portals-5). The hook clock is the retail sequence's own:
// it restarts at frame 1 when the tunnel (audibly) starts, apart from the
// drawn frame's `_animTime`, which is left as it was.
let _droneOn = false; // this run plays the tunnel's sound hooks
let _droneHooks = null; // { numFrames, hooks } from the tunnel Animation (null = none)
let _droneTime = 0; // seconds of hook-clock time this run
let _droneAbs = 0; // whole frames played on the hook clock
let _droneGen = 0; // bumped by stopDrone: a voice that starts after it is stopped
const _droneVoices = new Set(); // playing voice handles ({ source, gain })
const _droneZero = () => ({ fires: 0, skipped: 0 });
let _droneStats = _droneZero();
// ?portalFovFade (cells-portals-3).
let _fovFadeOn = false; // this run fades by FOV zoom (read at each tunnel start)
let _fovCam = null; // the world camera whose fov the WORLD_FADEIN zoom holds (null = none)
let _fovBase = 0; // that camera's own (game) fov, put back on release
let _fovSet = 0; // the fov the zoom last wrote (anything else = a resize / FOV slider since)
let _fovRevealPending = false; // this tick's hold began wider than its culls ran: draw the frame black
let _tunnelFov = 0; // diag: the tunnel camera's fov at the last tunnel draw

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function sessionHandle() {
  try { return (typeof window !== "undefined" && window.__sessionHandle) || null; } catch (_) { return null; }
}

/** Login spawn cell: the pose's cell, else the cell-scene snapshot (server-truth
 *  carried cell — the pose reads 0 at EnteredWorld on a login into a dungeon). */
function resolveLoginCell() {
  const p = readPose();
  if (p && p.lb) return p.lb >>> 0;
  const h = sessionHandle();
  try {
    if (h && typeof h.getCurrentCellId === "function") return (h.getCurrentCellId() >>> 0) || 0;
  } catch (_) {}
  return 0;
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
    _droneHooks = null;
    if (parts.length > 0 && typeof wasm.fetchAnimation === "function") {
      try {
        const a = await wasm.fetchAnimation(_animDid);
        const anim = { frames: a.frames, numParts: a.numParts | 0, numFrames: a.numFrames | 0 };
        // ?portalDrone: the clip's Sound / SoundTweaked hooks (a stale pkg
        // has no getters -> undefined -> no hooks).
        let hooks = [];
        try { hooks = parseTunnelSoundHooks(a.soundHookFrames, a.soundHookWaves, a.soundHookMeta); } catch (_) { hooks = []; }
        if (hooks.length && anim.numFrames > 2) _droneHooks = { numFrames: anim.numFrames, hooks };
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
    if (PRECOMPILE) _precompileTunnel(scene3d?.renderer);
    return true;
  })();
  try {
    return await _building;
  } finally {
    _building = null;
  }
}

// ── ?portalSpacePrecompile ─────────────────────────────────────────────
// renderer.compile with the canvas bound (the tunnel and the overlay draw to
// it), returning every program the compiled materials own — not just
// currentProgram: three compiles a transparent DoubleSide material as a Back
// and a Front program. Must run outside render() (compile resets three's
// render state); ensureTunnel's continuation is.
function _compileForCanvas(renderer, scene, cam) {
  const out = [];
  if (!renderer || typeof renderer.compile !== "function" || !scene || !cam) return out;
  const prev = typeof renderer.getRenderTarget === "function" ? renderer.getRenderTarget() : null;
  let mats = null;
  try {
    if (typeof renderer.setRenderTarget === "function") renderer.setRenderTarget(null);
    mats = renderer.compile(scene, cam);
  } catch (e) {
    console.warn("[portalSpace] precompile failed (links at first draw):", e);
    return out;
  } finally {
    try { if (typeof renderer.setRenderTarget === "function") renderer.setRenderTarget(prev); } catch (_) {}
  }
  if (!mats || typeof mats.forEach !== "function") return out;
  mats.forEach((m) => {
    let mp = null;
    try { mp = renderer.properties?.get?.(m) ?? null; } catch (_) { mp = null; }
    const progs = mp && mp.programs;
    if (progs && typeof progs.forEach === "function") progs.forEach((p) => { if (p) out.push(p); });
    else if (mp && mp.currentProgram) out.push(mp.currentProgram);
  });
  return out;
}

function _programsReady(progs) {
  if (!progs) return true;
  for (let i = 0; i < progs.length; i++) {
    const p = progs[i];
    try {
      if (p && typeof p.isReady === "function" && p.isReady() !== true) return false;
    } catch (_) { /* a destroyed program reads ready */ }
  }
  return true;
}

function _ensureOverlay() {
  if (_overlay) return _overlay;
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
  return _overlay;
}

function _precompileTunnel(renderer) {
  if (!renderer || typeof renderer.compile !== "function" || !_tunnelScene || !_tunnelCam) return;
  _ensureOverlay();
  _tunnelProgs = _compileForCanvas(renderer, _tunnelScene, _tunnelCam);
  _overlayProgs = _compileForCanvas(renderer, _overlay.scene, _overlay.cam);
  _tunnelProgsAt = now();
  _tunnelReady = _programsReady(_tunnelProgs);
}

/** Tunnel programs linked (or nothing to wait for, or the wait cap passed). */
function _tunnelDrawable() {
  if (_tunnelReady) return true;
  if (_programsReady(_tunnelProgs) || now() - _tunnelProgsAt > PRECOMPILE_WAIT_MAX_MS) {
    _tunnelReady = true;
    return true;
  }
  return false;
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

// Fade a playing voice ({ source, gain }) out over SOUND_FADE_S and stop it.
function fadeStopVoice(h) {
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

function stopLoop() {
  const h = _loop;
  _loop = null;
  fadeStopVoice(h);
}

// ?portalDrone: one tunnel sound hook, from the centre (see the drone note at
// the top: the object sits inside VOL_MIN_DIST of the portal listener).
function playDroneHook(hook) {
  const plan = soundHookPlan(hook);
  if (!plan.play || !_audio || typeof _audio.playFromCenter !== "function") {
    _droneStats.skipped += 1;
    return;
  }
  _droneStats.fires += 1;
  const gen = _droneGen;
  _audio
    .playFromCenter(hook.wave >>> 0, plan.volume, plan.sliderTwice ? { sliderTwice: true } : {})
    .then((v) => {
      if (!v?.source) return;
      if (gen !== _droneGen) { fadeStopVoice(v); return; } // stopped while it decoded
      _droneVoices.add(v);
      try { v.source.addEventListener?.("ended", () => { _droneVoices.delete(v); }); } catch (_) {}
    })
    .catch(() => {});
}

// ?portalDrone: advance the hook clock and fire the hooks of every frame it
// left. Waits for the tunnel Animation (the clock starts when the hooks are
// known, i.e. with the tunnel build).
function tickDrone(dt) {
  if (!_droneHooks) return;
  const prev = _droneAbs;
  _droneTime += dt;
  _droneAbs = Math.floor(_droneTime * TUNNEL_FPS);
  for (const h of hooksCrossed(prev, _droneAbs, _droneHooks.numFrames, _droneHooks.hooks)) playDroneHook(h);
}

// Fade out every drone voice (exit edge / teardown); a voice still decoding
// is stopped when it starts (generation check).
function stopDrone() {
  _droneGen += 1;
  for (const v of _droneVoices) fadeStopVoice(v);
  _droneVoices.clear();
}

// ?portalFovFade: WORLD_FADEIN draws the world through retail's view-distance
// zoom (RenderNormalMode -> set_vdst, acclient.c:144891). The active world
// camera's fov follows viewDistFov, written once per tick — after the camera
// tick, before the render — and HELD between frames, so the cell PVS and
// frustum-cull passes early in the next tick see the zoomed view (the fov only
// narrows during the fade-in: last frame's is a superset). The CSM is the
// exception: userData.csmFitFov parks the game fov for csm.js, so the cascades
// keep fitting the game frustum instead of stretching over ~179°.
// The tick a hold BEGINS is the other exception (V-cells-stream-R2): that
// tick's culls already ran at the camera's game fov, so its frame would draw a
// ~179° view with everything outside the game cone culled. `_fovRevealPending`
// keeps that one frame black (renderPortalSpaceOverlay); the next tick's culls
// see the wide frustum.
function _tickWorldFov(sc) {
  _fovRevealPending = false;
  const cam = _fovFadeOn && _seq.state === TAS.WORLD_FADEIN
    ? (sc?.cameraSwitcher?.activeCamera ?? sc?.camera ?? null)
    : null;
  if (!cam || !cam.isPerspectiveCamera || typeof cam.updateProjectionMatrix !== "function") {
    _releaseWorldFov(); // none / top-down ortho: the black quad stands in
    return;
  }
  const starting = cam !== _fovCam;
  if (starting) _releaseWorldFov(); // switched mid-fade: the old camera gets its fov back
  // The game fov: the camera's own at the first write, else whatever a resize
  // (?retailFov) or the Field of View slider wrote over our last value.
  const base = cam === _fovCam && cam.fov === _fovSet ? _fovBase : cam.fov;
  const f = _seq.viewDistFov(base);
  if (f == null) {
    _releaseWorldFov();
    return;
  }
  const culledAt = cam.fov; // the fov this tick's culls built their frustum from
  _fovCam = cam;
  _fovBase = base;
  _fovSet = f;
  _fovRevealPending = starting && f > culledAt;
  cam.fov = f;
  if (cam.userData) cam.userData.csmFitFov = base;
  cam.updateProjectionMatrix();
}

// Put the held world camera's game fov back (OFF, teardown, a new tunnel).
// A fov someone else wrote during the hold (resize, FOV slider) is kept.
function _releaseWorldFov() {
  _fovRevealPending = false;
  const cam = _fovCam;
  if (!cam) return;
  _fovCam = null;
  if (cam.fov === _fovSet) cam.fov = _fovBase;
  try { if (cam.userData) delete cam.userData.csmFitFov; } catch (_) {}
  try { cam.updateProjectionMatrix(); } catch (_) {}
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
      // ?loginPortalSpace: the running tunnel is the login one / the mode at
      // the last request / why the last request ran no tunnel / still waiting
      // for the first tick to decide.
      login: _loginMode,
      loginMode: _loginRequestMode,
      loginSkip: _loginSkip,
      loginPending: _loginPending !== null,
      loginStarts: _loginStarts,
      tunnelReady: _tunnelReady,
      // performance.now() ms; 0 = not reached in this run.
      // cells = the destination first read ready (ready = the release: + the
      // ?tunnelWorldWarm hold, if any).
      t: { start: _t.start, ready: _t.ready, reveal: _t.reveal, done: _t.done, cells: _t.cells },
      // ?tunnelWorldWarm, this run: passes run, materials compiled (+ deferred
      // by the per-pass cap), unguarded programs still linking, sky programs
      // still linking (IBL), last/max/total pass ms, release hold ms / capped.
      warm: { mode: _warmMode, runs: _warmRuns, ..._warmStats },
      // ?portalDrone, this run: on, tunnel sound hooks known, hooks played /
      // skipped (probability, volume 0, no audio), voices still playing.
      drone: { on: _droneOn, hooks: _droneHooks ? _droneHooks.hooks.length : 0, ..._droneStats, voices: _droneVoices.size },
      // ?portalFovFade, this run: on, the world camera's held zoom fov / its
      // game fov (0 = not holding), the tunnel camera's fov at its last draw.
      fovFade: { on: _fovFadeOn, world: _fovCam ? _fovSet : 0, base: _fovCam ? _fovBase : 0, tunnel: _tunnelFov },
    };
  } catch (_) {}
}

// ── ?tunnelWorldWarm ───────────────────────────────────────────────────
// While the tunnel owns the frame the world is not drawn, so nothing links —
// until the reveal frame links everything at once. Each pass (first owning
// tick, then every WARM_INTERVAL_S) compiles, with the render target each draw
// will bind (shader_prewarm.js: null vs non-null is the only key axis):
//   - every composer pass: a scene pass (RenderPass world / sky, the sky
//     capture) compiles its scene into the composer-class target (the world
//     scene with its fog + lights, new / changed materials only, ≤ WARM_NEW_MAX
//     per pass); a fullscreen pass compiles its material — to the CANVAS when
//     it is the pass that renders to screen — and every material of the
//     passes nested in it / its effects (bloom luminance + mipmap blur …)
//     into the composer-class target;
//   - the sky scene as the PMREM / cube camera draws it
//     (IblEnvironment.warmPrograms; `?pmremPrecompile` adds the PMREM
//     convolution programs).
// Far-terrain patches are main-scene objects: compiled here when they exist
// during the tunnel; one created after the reveal is the async-link guard's
// (`?asyncLinkFar`). No composer yet (pre-bake window) → the main scene waits
// for the next pass rather than compile the canvas variant.
const _fsScene = new THREE.Scene();
const _fsCam = new THREE.OrthographicCamera();
const _fsGeom = new THREE.BufferGeometry();
const _fsMeshes = new WeakMap(); // material -> proxy mesh
const FS_CANVAS = 1;
const FS_OFFSCREEN = 2;
const FS_HOLD = 4; // from a pass enabled at warm time: the release may wait on it

function _markFs(map, m, bit) {
  if (!m || !m.isMaterial) return;
  map.set(m, (map.get(m) || 0) | bit);
}

function _passLike(v) {
  return !!v && typeof v === "object" && !v.isObject3D && !v.isMaterial && !v.isTexture &&
    typeof v.render === "function" && ("fullscreenMaterial" in v || "needsSwap" in v);
}

// Materials a pass draws offscreen: its own material-valued fields, and those
// of the passes it (or its `effects`) holds — bloom's LuminancePass /
// MipmapBlurPass (downsampling + upsampling materials), clouds passes, …
function _scanPassMaterials(obj, map, depth, visited, extra) {
  if (!obj || typeof obj !== "object" || visited.has(obj)) return;
  visited.add(obj);
  let keys;
  try { keys = Object.keys(obj); } catch (_) { return; }
  for (const k of keys) {
    // A pass's own fullscreen material is classed by the caller (canvas when
    // it renders to screen) — never re-marked offscreen here.
    if (k === "fullscreenMaterial") continue;
    let v;
    try { v = obj[k]; } catch (_) { continue; }
    if (!v || typeof v !== "object") continue;
    if (v.isMaterial) { _markFs(map, v, FS_OFFSCREEN | extra); continue; }
    if (depth <= 0) continue;
    if (_passLike(v)) {
      let fm = null;
      try { fm = v.fullscreenMaterial; } catch (_) { fm = null; }
      _markFs(map, fm, FS_OFFSCREEN | extra);
      _scanPassMaterials(v, map, depth - 1, visited, extra);
    } else if (k === "effects" && Array.isArray(v)) {
      for (const e of v) _scanPassMaterials(e, map, depth - 1, visited, extra);
    }
  }
}

function _compileFullscreen(renderer, map, offTarget, stats) {
  const byClass = [[FS_CANVAS, null, []], [FS_OFFSCREEN, offTarget, []]];
  for (const [m, bits] of map) {
    for (const cls of byClass) {
      if (!(bits & cls[0])) continue;
      const key = `fs${cls[0]}|${m.version}`;
      const s = _warmSeen.get(m);
      if (s && s.has(key)) continue;
      let mesh = _fsMeshes.get(m);
      if (!mesh) {
        mesh = new THREE.Mesh(_fsGeom, m);
        mesh.frustumCulled = false;
        _fsMeshes.set(m, mesh);
      }
      cls[2].push(mesh);
    }
  }
  const out = [];
  for (const [cls, target, meshes] of byClass) {
    if (!meshes.length) continue;
    const root = {
      traverse(cb) { for (const o of meshes) cb(o); },
      traverseVisible(cb) { for (const o of meshes) cb(o); },
    };
    // A fullscreen pass draws its quad in its own empty Scene: no fog, no
    // environment, no lights — the same as this empty stand-in.
    const set = compileWithTarget(renderer, root, _fsCam, _fsScene, target);
    if (!set) continue;
    set.forEach((m) => {
      out.push(m);
      let s = _warmSeen.get(m);
      if (!s || s.size >= 8) { s = new Set(); _warmSeen.set(m, s); }
      s.add(`fs${cls}|${m.version}`);
    });
    stats.fullscreen += set.size;
  }
  return out;
}

/**
 * One warm pass over the world `sc` (the liveScene3d facade: renderer, scene,
 * atmospherePipeline.composer, iblEnvironment). Starts links only — never
 * reads LINK_STATUS. Unguarded programs still linking go to the release hold
 * set (main-scene materials the async-link guard defers are left to it).
 * Exported for the node test. Returns this pass's counters, or null.
 */
export function warmWorldPrograms(sc) {
  const renderer = sc?.renderer;
  if (!renderer || typeof renderer.compile !== "function") return null;
  const t0 = now();
  const res = { passes: 0, compiled: 0, deferred: 0, fullscreen: 0, held: 0, sky: 0 };
  const guard = renderer.__hbAsyncLink;
  const guarded = guard && typeof guard.guards === "function" ? guard.guards : null;
  const hold = (mats, isMain) => {
    if (!mats) return;
    mats.forEach((m) => {
      if (isMain && guarded && guarded(m)) return; // deferred by the guard instead
      for (const p of programsOf(renderer, m)) if (programPending(p)) _warmHeld.add(p);
    });
  };
  const off = getWarmTarget();
  const comp = sc.atmospherePipeline?.composer ?? null;
  const main = sc.scene ?? null;
  if (comp && Array.isArray(comp.passes)) {
    const scenes = new Set();
    const fs = new Map();
    const visited = new Set();
    for (const pass of comp.passes) {
      if (!pass || typeof pass !== "object") continue;
      res.passes += 1;
      let fsm = null;
      try { fsm = pass.fullscreenMaterial ?? null; } catch (_) { fsm = null; }
      if (!fsm && pass.scene && pass.scene.isScene && pass.camera) {
        // Scene pass (RenderPass world / sky, SkyCapturePass).
        if (!scenes.has(pass.scene)) {
          scenes.add(pass.scene);
          const isMain = pass.scene === main;
          const r = warmSceneMaterials(renderer, pass.scene, pass.camera, pass.renderToScreen === true ? null : off,
            { seen: _warmSeen, maxNew: isMain ? WARM_NEW_MAX : Infinity });
          res.compiled += r.compiled;
          res.deferred += r.deferred;
          // A pass switched off right now (e.g. the sky pass indoors) is
          // warmed for later but never holds the release.
          if (pass.enabled !== false) hold(r.materials, isMain);
        }
      } else {
        _markFs(fs, fsm, (pass.renderToScreen === true ? FS_CANVAS : FS_OFFSCREEN) | (pass.enabled !== false ? FS_HOLD : 0));
      }
      _scanPassMaterials(pass, fs, 3, visited, pass.enabled !== false ? FS_HOLD : 0);
    }
    if (fs.size) {
      const mats = _compileFullscreen(renderer, fs, off, res);
      res.compiled += mats.length;
      hold(mats.filter((m) => (fs.get(m) & FS_HOLD) !== 0), false);
    }
  }
  const ibl = sc.iblEnvironment;
  if (ibl && typeof ibl.warmPrograms === "function") {
    try { res.sky = ibl.warmPrograms().length; } catch (_) { res.sky = 0; }
  }
  res.held = prunePending(_warmHeld);
  const ms = now() - t0;
  const s = _warmStats;
  s.passes += 1;
  s.compiled += res.compiled;
  s.deferred = res.deferred;
  s.fullscreen += res.fullscreen;
  s.held = res.held;
  s.sky = res.sky;
  s.lastMs = Math.round(ms * 10) / 10;
  s.maxMs = Math.max(s.maxMs, s.lastMs);
  s.totalMs = Math.round((s.totalMs + ms) * 10) / 10;
  return res;
}

function _warmTick(sc) {
  if (!sc || _clock - _warmLastAt < WARM_INTERVAL_S) return;
  // The tunnel's own programs (?portalSpacePrecompile) link first — the world
  // warm waits for them (bounded by that precompile's own 8 s cap).
  if (_tunnelScene && !_tunnelDrawable()) return;
  _warmLastAt = _clock;
  try {
    warmWorldPrograms(sc);
  } catch (e) {
    _warmStats.errors += 1;
    if (_warmStats.errors === 1) console.warn("[portalSpace] tunnel world warm failed (links at the reveal):", e);
  }
}

// Mode "on": hold the release while an unguarded warmed program is still
// linking — once per run, at most WARM_HOLD_MAX_S of tunnel clock.
function _warmHolds() {
  if (_warmMode !== "on" || _warmHoldSpent) return false;
  const pending = prunePending(_warmHeld);
  _warmStats.held = pending;
  if (pending === 0) {
    if (_warmHoldFrom >= 0) { _warmStats.holdMs = Math.round((_clock - _warmHoldFrom) * 1000); _warmHoldSpent = true; }
    return false;
  }
  if (_warmHoldFrom < 0) _warmHoldFrom = _clock;
  if (_clock - _warmHoldFrom >= WARM_HOLD_MAX_S) {
    _warmStats.holdMs = Math.round((_clock - _warmHoldFrom) * 1000);
    _warmStats.holdCapped = true;
    _warmHoldSpent = true;
    return false;
  }
  _reason = "warming";
  return true;
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
  _startTunnel(scene3d, opts, false);
}

// The shared start. `silent` (login entry): no enter whoosh and no notice yet —
// they play once the tunnel really holds (tickPortalSpace), so a login whose
// cells turn out ready at once ends without a sound (warm-path backstop).
function _startTunnel(scene3d, opts, silent) {
  if (!scene3d) return;
  // A teleport (kind=33) always wins over a login entry: it drops a pending
  // request and switches a running login tunnel to teleport semantics.
  _loginPending = null;
  _loginMode = false;
  _loginAnnounced = false;
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
  _t = { start: now(), ready: 0, reveal: 0, done: 0, cells: 0 };
  // ?tunnelWorldWarm: a fresh run (the material memo `_warmSeen` persists).
  _warmMode = tunnelWorldWarmMode();
  _warmLastAt = -Infinity;
  _warmHoldFrom = -1;
  _warmHoldSpent = false;
  _warmHeld.clear();
  _warmStats = _warmZero();
  if (_warmMode !== "off") _warmRuns += 1;
  _startPose = readPose();
  if (!wasOwning && !silent) playOneShot(scene3d, enterDid);
  const loopDid = opts.loopDid ? opts.loopDid >>> 0 : 0;
  if (loopDid && !_loop && _audio) {
    _audio
      .playFromCenter(loopDid, 1.0, { loop: true })
      .then((h) => { if (h && _seq.isActive()) _loop = h; else if (h) { _loop = h; stopLoop(); } })
      .catch(() => {});
  }
  // ?portalDrone: the ?portalSoundLoop bed replaces it. A tunnel that was not
  // up restarts the hook clock at frame 1 (retail set_sequence_animation with
  // interrupt); a re-teleport inside the tunnel keeps the running sequence.
  _droneOn = portalDroneEnabled() && !loopDid;
  if (!_droneOn) stopDrone();
  if (!wasOwning) {
    _droneTime = 0;
    _droneAbs = 0;
    _droneStats = _droneZero();
  }
  // ?portalFovFade: a teleport during WORLD_FADEIN gives the world camera its
  // fov back before the tunnel takes the frame again.
  _fovFadeOn = portalFovFadeEnabled();
  _releaseWorldFov();
  _tunnelFov = 0;
  if (!silent) setNotice(true);
  ensureTunnel(scene3d).catch((e) => console.warn("[portalSpace] tunnel build failed:", e));
  publishDiag();
}

/**
 * Login entry (client_events.js, FIRST ENTERED_WORLD of a login scope). Only
 * records the request — the first tickPortalSpace decides (cell resolution,
 * skip reasons, the resident check), so nothing plays on the warm path.
 * `scene3d` may be null (init3D not finished); `opts.cellId` optional.
 * Returns false when a skip reason applies (published as
 * `__portalSpace.loginSkip`), true when the request is pending.
 */
export function requestLoginPortalSpace(scene3d, opts = {}) {
  _loginRequestMode = loginPortalSpaceMode();
  const why = loginPortalSpaceSkipReason();
  if (why) {
    _loginSkip = why;
    _loginPending = null;
    publishDiag();
    return false;
  }
  _loginSkip = null;
  _loginPending = { cellId: (opts && opts.cellId) >>> 0, sc: scene3d ?? null, waited: 0 };
  publishDiag();
  return true;
}

function _skipLogin(why) {
  _loginSkip = why;
  _loginPending = null;
  publishDiag();
}

// First tick(s) after a login request: decide, then start (or not).
function _consumeLoginPending(sc, dt) {
  const p = _loginPending;
  if (!sc) return; // no scene yet: keep waiting (init3D still running)
  if (_seq.isActive()) { _skipLogin("busy"); return; } // a tunnel already runs: never restart it
  const why = loginPortalSpaceSkipReason();
  if (why) { _skipLogin(why); return; }
  let cell = p.cellId >>> 0;
  if (!cell) cell = resolveLoginCell();
  if (!cell) {
    p.waited += dt;
    if (p.waited < LOGIN_CELL_WAIT_S) return; // the pose may still read 0
  }
  if (cell && destinationCellsReady(sc, cell)) { _skipLogin("resident"); return; }
  _loginPending = null;
  _beginLogin(sc, cell);
}

function _beginLogin(sc, cell) {
  const mode = _loginRequestMode || loginPortalSpaceMode();
  _startTunnel(sc, {}, true); // clears the login fields: set them after
  if (mode === "quick") _seq.begin({ minContinue: 0, maxContinue: 0, fadeOut: QUICK_FADE_OUT });
  _loginMode = true;
  _loginAnnounced = false;
  _arrived = true; // the login has no kind=66 edge: the position is the spawn
  _arrivedAt = 0;
  _arrivalCell = cell >>> 0;
  _reason = "login";
  _loginStarts += 1;
  publishDiag();
}

/** True while a login request waits for the first tick to decide. */
export function isLoginPortalSpacePending() {
  return _loginPending !== null;
}

/**
 * scene3d/index.js scheduleNext: the loop's frame interval this frame —
 * `baseMs` (the ?targetFps pacing, 0 = rAF) unless the tunnel owns the frame
 * and ?portalSpaceFps is on, then max(baseMs, 1000/N).
 */
export function portalSpaceFrameIntervalMs(baseMs) {
  if (!(PACE_MS > 0) || !_seq.ownsFrame()) return baseMs;
  return baseMs > PACE_MS ? baseMs : PACE_MS;
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

// Login tunnel: "cells loaded" for the spawn cell, with the teleport
// build-aware hold (`?portalHoldBuild`). Indoors the hold also covers queued
// builds and retry gaps that are not in flight (`__interiorBuildPending`).
function computeLoginWorldReady(scene3d) {
  if (!_arrivalCell) _arrivalCell = resolveLoginCell();
  if (_arrivalCell && destinationCellsReady(scene3d, _arrivalCell)) {
    _reason = "cells-ready";
    return true;
  }
  const waited = _clock - _arrivedAt;
  if (waited >= ARRIVAL_CELLS_WAIT_MAX) {
    const indoor = (_arrivalCell & 0xffff) >= 0x100;
    if (PORTAL_HOLD_BUILD && waited < ARRIVAL_BUILD_WAIT_MAX &&
        (destinationBuildInFlight(scene3d, _arrivalCell) ||
         (indoor && globalThis.__interiorBuildPending === true))) {
      _reason = "login-building";
      return false;
    }
    _reason = waited >= ARRIVAL_BUILD_WAIT_MAX ? "failsafe(build-wait)" : "failsafe(cells-wait)";
    return true;
  }
  _reason = "login";
  return false;
}

function computeWorldReady(scene3d) {
  if (_loginMode) return computeLoginWorldReady(scene3d);
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
  if (_loginPending !== null) {
    _consumeLoginPending(scene3d ?? _loginPending.sc ?? null, Math.min(Math.max(+dt || 0, 0), 0.25));
  }
  if (!_seq.isActive()) return;
  const d = Math.min(Math.max(+dt || 0, 0), 0.25);
  _clock += d;
  const frame = advanceAnim(d);
  // ?tunnelWorldWarm: the world's programs link while the tunnel hides it.
  if (_warmMode !== "off" && _seq.ownsFrame()) _warmTick(scene3d ?? _scene3d);
  const rawReady = _seq.state === TAS.TUNNEL ? computeWorldReady(scene3d ?? _scene3d) : true;
  let worldReady = rawReady;
  if (rawReady && _seq.state === TAS.TUNNEL && !_t.cells) _t.cells = now();
  if (_loginMode && !_loginAnnounced) {
    // Warm-path backstop: the spawn cell turned out resident right after a
    // silent start — end now, no CONTINUE, no fades, no sound.
    if (rawReady && _seq.state === TAS.TUNNEL && _clock < LOGIN_INSTANT_S) {
      _loginSkip = "resident-late";
      _t.ready = _t.reveal = _t.done = now();
      endPortalSpace();
      return;
    }
    if (!rawReady && _clock >= LOGIN_INSTANT_S) {
      // It really holds: now the retail enter whoosh + notice.
      _loginAnnounced = true;
      playOneShot(scene3d ?? _scene3d, PORTAL_ENTER_WAVE);
      setNotice(true);
    }
  }
  // ?tunnelWorldWarm "on": the destination is ready, but a warmed program the
  // async-link guard would not defer is still linking — hold the tunnel (once
  // per run, ≤ WARM_HOLD_MAX_S) rather than link it in the reveal frame.
  if (rawReady && _seq.state === TAS.TUNNEL && _warmHolds()) worldReady = false;
  // No animation -> no frame sync; let the 5 s cap / window logic run on a
  // synthetic frame that never lands in the exit window.
  const ev = _seq.tick(d, { worldReady, frame: _anim ? frame : 0 });
  for (const e of ev) {
    if (e === "continue") {
      _t.ready = now();
    } else if (e === "exitSound") {
      _t.reveal = now();
      if (!_loginMode || _loginAnnounced) playOneShot(scene3d ?? _scene3d, _exitDid);
      setNotice(false);
      // ?portalDrone: retail clears the tunnel sequence here (UseTime state
      // 5 -> 6, clear_sequence_anims, acclient.c:262559): no more hooks. Its
      // last voice would play out (<= 3 s into the world); ours fades out
      // under the exit whoosh, as the ?portalSoundLoop bed does at the end.
      stopDrone();
    } else if (e === "done") {
      _t.done = now();
      endPortalSpace();
      return;
    }
  }
  // ?portalDrone: the tunnel's sound hooks run while its viewport is up
  // (retail CreatureMode draw -> update_position), and a login tunnel only
  // once it is announced (a warm-path login stays silent).
  if (_droneOn && _seq.ownsFrame() && (!_loginMode || _loginAnnounced)) tickDrone(d);
  // ?portalFovFade: the world camera's WORLD_FADEIN zoom for this frame's draw.
  if (_fovFadeOn || _fovCam) _tickWorldFov(scene3d ?? _scene3d);
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
    // ?portalSpacePrecompile: black until the tunnel's programs have linked.
    if (_tunnelScene && _tunnelCam && _tunnelDrawable()) {
      const cam = _tunnelCam;
      const gameFar = mainCam?.far > 0 ? mainCam.far : 4000;
      cam.fov = mainCam?.fov > 0 ? mainCam.fov : 45;
      cam.aspect = mainCam?.aspect > 0 ? mainCam.aspect : 1;
      cam.near = 0.05;
      // ?portalFovFade: TUNNEL_FADEOUT zooms the tunnel out to a point
      // (CreatureMode UseSmartboxFOV -> Render::set_vdst, acclient.c:143942)
      // and leaves its far plane alone (SetFOVInternal keeps Render::zfar);
      // off: today's far-plane shrink.
      if (_fovFadeOn) {
        const zf = _seq.viewDistFov(cam.fov);
        if (zf != null) cam.fov = zf;
        _tunnelFov = cam.fov;
      }
      cam.far = Math.max(cam.near + 1e-3, gameFar * (_fovFadeOn ? 1 : _seq.tunnelFarFrac()));
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
  // ?portalFovFade: the zoom IS the fade-in (retail draws no black) — no quad
  // while it holds the world camera (a top-down ortho camera keeps the quad),
  // except one fully black frame when the hold began this tick: this tick's
  // culls ran at the game fov, so the ~179° world would draw with its
  // periphery culled (see _tickWorldFov). On the reveal frame alpha is 1
  // anyway (WORLD_FADEIN s.t = 0); the tunnel's last frame is a point on black.
  let alpha;
  if (_fovCam) {
    if (!_fovRevealPending) return;
    _fovRevealPending = false;
    alpha = 1;
  } else {
    alpha = _seq.worldOverlayAlpha();
  }
  if (!(alpha > 0.002) || !renderer) return;
  _ensureOverlay();
  _overlay.mat.uniforms.alpha.value = alpha;
  const prevAutoClear = renderer.autoClear;
  const prevTarget = renderer.getRenderTarget?.() ?? null;
  try {
    renderer.setRenderTarget(null);
    renderer.autoClear = false;
    if (_overlayProgs && !_programsReady(_overlayProgs) && now() - _tunnelProgsAt < PRECOMPILE_WAIT_MAX_MS) {
      // ?portalSpacePrecompile: the fade quad is still linking — keep the
      // world black this frame instead of linking it inside the frame.
      const c = new THREE.Color();
      renderer.getClearColor?.(c);
      const a = renderer.getClearAlpha?.() ?? 1;
      renderer.setClearColor(0x000000, 1);
      renderer.clear(true, false, false);
      renderer.setClearColor(c, a);
    } else {
      renderer.render(_overlay.scene, _overlay.cam);
    }
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
  _loginPending = null;
  _loginMode = false;
  _loginAnnounced = false;
  if (wasActive && _warmMode !== "off" && _warmStats.passes > 0) {
    // ?tunnelWorldWarm run summary (academy.mjs keeps `portalSpace` lines).
    const w = _warmStats;
    let ib = null;
    try { ib = _scene3d?.iblEnvironment?.warmStats ?? null; } catch (_) { ib = null; }
    console.info(
      `[portalSpace] tunnel world warm (${_warmMode}): ${w.passes} passes, ${w.compiled} materials ` +
      `(${w.fullscreen} fullscreen, ${w.deferred} deferred), ${w.totalMs} ms main thread (max ${w.maxMs}), ` +
      `release hold ${w.holdMs} ms${w.holdCapped ? " (capped)" : ""}, ${prunePending(_warmHeld)} still linking` +
      (ib ? `; ibl: first refresh waited ${ib.firstWaitMs} ms, waits ${ib.waitTicks}/${ib.waitCapped} capped, pmrem internals ${ib.pmremInternals}` : ""),
    );
  }
  _warmHeld.clear(); // ?tunnelWorldWarm: nothing left to hold
  _warmHoldFrom = -1;
  setNotice(false);
  stopLoop();
  stopDrone();
  _releaseWorldFov(); // ?portalFovFade: the world camera's game fov back (OFF / teardown)
  _reason = "off";
  publishDiag();
  const cb = _onExit;
  _onExit = null;
  if (cb) {
    try { cb({ forced: wasActive }); } catch (_) {}
  }
}

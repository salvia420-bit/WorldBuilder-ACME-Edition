// Portal-space travel visual — the "donut you fly through" while portaling.
//
// Retail AC renders a large purplish ring (Setup 0x02000306 — a hollow torus,
// ~113 units across, ring radius ~45-56, thin in its local Z) client-side
// during a portal transition: the camera sits in the hollow centre and is
// flown through it ("travelling through portal space"). The object has NO
// weenie / spawn — it's pure presentation, engine-rendered (confirmed via DAT:
// 0 of 28k LSD weenies reference it, and the decompiled client never names it
// by id). So we render it ourselves, around the follow camera.
//
// Lifecycle (all time-driven, self-contained — no protocol/wasm change):
//   START  → `startPortalSpace` on the `PortalSpaceEntered` (kind=33) event
//            that already fires on every PlayerTeleport (index.html ~9327).
//   TICK   → `tickPortalSpace` per frame from loop.js, AFTER the camera tick
//            so the rig reads the final camera pose.
//   END    → auto-closes after the travel window, OR earlier when
//            `signalPortalArrived()` is called (optional tighter coupling to
//            the F2-3 "destination UpdatePosition applied" moment).
//
// The ring uses its REAL DAT textures (surfaces 0x08000C31/0x08000C32) pulled
// through the same `materialCache` path entity models use, dropped onto an
// unlit MeshBasicMaterial so it self-illuminates regardless of scene lighting.
//
// Gated by `?portalSpace=<scale>` (or `=on` for the default scale). Default
// off; flip on + eye-test on the 1070 to tune scale + twist feel.

import * as THREE from "three";
import { meshToGeometryGroups } from "./adapter.js";

// Setup (0x02…) for the portal-space donut. Confirmed donut geometry via
// WorldBuilder.Terminal get-object-detail + obj-export (hollow ring about Z).
const PORTAL_DONUT_SETUP = 0x02000306;

const DEFAULT_SCALE = 0.4;     // raw ring is ~113u across; 0.4 ≈ camera-hugging
const RING_COUNT = 6;          // repeated along the view axis → tunnel of rings
const RING_SPACING = 26;       // AC units between rings (pre-scale)
const OPEN_DUR = 0.45;         // s — iris-open (scale + fade in) = "opens"
const TRAVEL_DUR = 1.8;        // s — default sustained travel before auto-close
const MAX_HOLD = 6.0;          // s — hard cap on travel if arrival never signals
const CLOSE_DUR = 0.55;        // s — iris-out (fade + slight expand) = "closes"
const TWIST_RATE = 0.9;        // rad/s — global roll ("twists and turns")
const FLY_SPEED = RING_SPACING * RING_COUNT * 0.6; // units/s the tunnel streams
// The portal object's own MovementState is ForwardCommand + SideStepSpeed +
// TurnCommand (forward + strafe + turn) — a corkscrew. We render the camera's
// trip through it by giving the streaming tunnel a matching sidestep sway +
// yaw banking on top of the forward stream, so the hole curves past you.
const SIDESTEP_AMP = 0.18;     // lateral sway as a fraction of ring radius
const SIDESTEP_RATE = 0.8;     // rad/s of the sway oscillation
const TURN_AMP = 0.22;         // rad — yaw banking amplitude (TurnCommand)
const TURN_RATE = 0.5;         // rad/s of the yaw oscillation

// Tinge applied on top of the real texture so the ring reads as portal-energy
// even where the DAT texture is dim. Multiplied with the texture (not added).
const ENERGY_TINT = 0x9b6cff;

// Portal-space sound. Wave (0x0A) DID — candidate 0x0A000316. UNVERIFIED: the
// retail portal sounds. VERIFIED via `dump_portal_sounds` against
// client_portal.dat: SoundTable 0x2000004B maps `Sound.UI_EnterPortal (0x6A)
// → Wave 0x0A000246` and `UI_ExitPortal (0x6B) → Wave 0x0A000245`. These are
// the real one-shot whooshes the retail client plays on portal enter/exit.
// (The earlier candidate 0x0A000316 exists in the DAT but no SoundTable maps
// to it — it's an unmapped/engine-direct wave next to the portal open/close
// pair 0x0A000317/0x318; available as an opt-in loop bed via ?portalSoundLoop.)
const PORTAL_ENTER_WAVE = 0x0a000246; // UI_EnterPortal — one-shot on open
const PORTAL_EXIT_WAVE = 0x0a000245;  // UI_ExitPortal — one-shot on close
const SOUND_REF_DISTANCE = 60; // large → ~full volume even with tiny offset
const SOUND_FADE_S = 0.35;     // close-out gain ramp on the optional loop

// Module-level cache: the geometry + materials are built ONCE (one wasm round
// trip) and the rig is reused across teleports. `_rig` is detached from the
// scene while idle, so it costs nothing when not portaling.
let _rig = null;            // THREE.Group — follows the camera
let _rings = [];            // THREE.Group[] — one per tunnel slice
let _materials = [];        // shared MeshBasicMaterial[] (per surface group)
let _building = null;       // in-flight build promise (dedupe)
let _active = false;
let _scene = null;
let _elapsed = 0;           // s since START
let _arrived = false;       // set by signalPortalArrived()
let _scale = DEFAULT_SCALE;
let _audio = null;          // AudioManager handle for this run
let _loop = null;           // optional looping-bed handle {source,panner,gain}
let _enterDid = PORTAL_ENTER_WAVE; // one-shot on open (0 = muted)
let _exitDid = PORTAL_EXIT_WAVE;   // one-shot on close (0 = muted)
let _loopDid = 0;           // optional loop bed (0 = none)
let _exitFired = false;     // one-shot guard for the close whoosh

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Recentre + axis-align a set of part geometries so the ring's hollow centre
// sits at the rig origin and the ring axis points along local +Z (the asset's
// thin dimension). Asset-agnostic: derives the axis from the union bbox, so a
// different donut id still lands correctly.
function normaliseGeometries(geoms) {
  const box = new THREE.Box3();
  for (const g of geoms) {
    g.computeBoundingBox();
    box.union(g.boundingBox);
  }
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  // thin axis (smallest extent) = ring axis → bring it to Z
  const minAxis = s.x <= s.y && s.x <= s.z ? "x" : s.y <= s.z ? "y" : "z";
  for (const g of geoms) {
    g.translate(-c.x, -c.y, -c.z);
    if (minAxis === "x") g.rotateY(Math.PI / 2);
    else if (minAxis === "y") g.rotateX(-Math.PI / 2);
  }
}

async function ensureRig(scene3d) {
  if (_rig) return _rig;
  if (_building) return _building;
  _building = (async () => {
    const wasm = scene3d?.wasmExports;
    const mc = scene3d?.materialCache;
    if (!wasm || typeof wasm.fetch_model_meshes !== "function" || !mc) {
      return null; // headless / pre-init — caller no-ops
    }
    const meshes = await wasm.fetch_model_meshes(
      new Uint32Array([PORTAL_DONUT_SETUP]),
    );
    const wasmMesh = meshes && meshes[0];
    if (!wasmMesh) return null;
    const { groups } = meshToGeometryGroups(wasmMesh);
    if (!groups || groups.length === 0) return null;

    normaliseGeometries(groups.map((g) => g.geometry));

    // Real textures via the entity material path, re-skinned as unlit glow.
    _materials = [];
    const geoms = [];
    for (const grp of groups) {
      let map = null;
      try {
        const src = await mc.get(
          grp.surfaceDid >>> 0,
          wasm.fetch_surfaces_pixels,
        );
        map = src?.map ?? null;
      } catch (_) {
        /* fall through to untextured tint */
      }
      const mat = new THREE.MeshBasicMaterial({
        map,
        color: new THREE.Color(ENERGY_TINT),
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
        fog: false,
      });
      _materials.push(mat);
      geoms.push(grp.geometry);
    }

    _rings = [];
    _rig = new THREE.Group();
    _rig.name = "portalSpaceRig";
    for (let i = 0; i < RING_COUNT; i++) {
      const ring = new THREE.Group();
      for (let g = 0; g < geoms.length; g++) {
        const mesh = new THREE.Mesh(geoms[g], _materials[g]);
        mesh.renderOrder = 9000; // draw after the world (per-object, not Group)
        mesh.frustumCulled = false; // it hugs the camera; never cull it
        ring.add(mesh);
      }
      _rig.add(ring);
      _rings.push(ring);
    }
    _rig.visible = false;
    return _rig;
  })();
  const built = await _building;
  _building = null;
  return built;
}

/**
 * Begin the portal-space sequence. Idempotent restart: calling again while
 * active (rapid re-teleport) just re-opens from the top. Safe to call for
 * indoor↔indoor recalls — it always plays.
 *
 * @param {object} scene3d  the live `window.liveScene3d` handle
 * @param {number} [scale]  ring scale (`?portalSpace=<scale>`); defaults to 0.4
 * @param {number} [enterDid] one-shot enter whoosh; omit = default
 *        (0x0A000246 UI_EnterPortal), `0` = muted. (`?portalSound=<hex|off>`)
 * @param {number} [loopDid] optional looping ambience bed for the transit;
 *        omit/`0` = none (`?portalSoundLoop=<hex>`, e.g. the 0x0A000316 wave).
 */
export async function startPortalSpace(scene3d, scale, enterDid, loopDid) {
  if (!scene3d?.scene || !scene3d?.cameraSwitcher) return;
  _scale = Number.isFinite(scale) && scale > 0 ? scale : DEFAULT_SCALE;
  _enterDid = enterDid === undefined ? PORTAL_ENTER_WAVE : enterDid >>> 0;
  _loopDid = loopDid ? loopDid >>> 0 : 0;
  const rig = await ensureRig(scene3d);
  if (!rig) return;
  _scene = scene3d.scene;
  if (rig.parent !== _scene) _scene.add(rig);
  rig.visible = true;
  _elapsed = 0;
  _arrived = false;
  _exitFired = false;
  _active = true;
  _audio = scene3d.audioManager ?? null;
  // Enter whoosh (one-shot). Fire-and-forget; silent + harmless if the audio
  // context is still locked (no user gesture yet) or the id is wrong.
  playOneShot(scene3d, _enterDid);
  // Optional looping bed for the whole transit, pinned to the listener. Skip
  // if one's already up (rapid re-teleport keeps it running).
  if (_loopDid && !_loop) {
    const p = listenerPos(scene3d);
    _audio
      ?.play(_loopDid, p, { loop: true, refDistance: SOUND_REF_DISTANCE })
      .then((h) => {
        if (h && _active) _loop = h;
        else if (h) stopLoop();
      })
      .catch(() => {});
  }
}

function listenerPos(scene3d) {
  const cam =
    scene3d?.cameraSwitcher?.activeCamera ?? scene3d?.cameraSwitcher?.persp;
  const p = cam?.position;
  return p ? { x: p.x, y: p.y, z: p.z } : { x: 0, y: 0, z: 0 };
}

function playOneShot(scene3d, did) {
  if (!_audio || !did) return;
  _audio
    .play(did >>> 0, listenerPos(scene3d), { refDistance: SOUND_REF_DISTANCE })
    .catch(() => {});
}

// Fade + stop the optional loop bed without a click.
function stopLoop() {
  const h = _loop;
  _loop = null;
  if (!h?.source) return;
  try {
    const ctx = h.gain?.context;
    if (ctx && h.gain) {
      const now = ctx.currentTime;
      h.gain.gain.setTargetAtTime(0, now, SOUND_FADE_S / 3);
      h.source.stop(now + SOUND_FADE_S);
    } else {
      h.source.stop();
    }
  } catch (_) {
    /* already stopped */
  }
}

/** Optional: signal the destination is loaded (begin closing immediately). */
export function signalPortalArrived() {
  _arrived = true;
}

/** True while the sequence is on-screen. */
export function isPortalSpaceActive() {
  return _active;
}

/** Per-frame driver. Call from loop.js AFTER the camera tick. */
export function tickPortalSpace(scene3d, dt) {
  if (!_active || !_rig) return;
  const cam =
    scene3d?.cameraSwitcher?.activeCamera ?? scene3d?.cameraSwitcher?.persp;
  if (!cam) return;
  _elapsed += dt;

  // Phase envelope. open → travel (until arrival / cap) → close.
  const travelEnd = (_arrived ? 0 : TRAVEL_DUR);
  const closeStart = OPEN_DUR + Math.min(MAX_HOLD, travelEnd);
  const openEnv = smoothstep(0, OPEN_DUR, _elapsed);          // 0→1
  const closeEnv = 1 - smoothstep(closeStart, closeStart + CLOSE_DUR, _elapsed);
  const env = Math.min(openEnv, closeEnv);                    // overall 0..1..0
  // Exit whoosh (one-shot) the instant the close phase begins.
  if (!_exitFired && _elapsed >= closeStart) {
    _exitFired = true;
    playOneShot(scene3d, _exitDid);
  }
  if (_elapsed >= closeStart + CLOSE_DUR) {
    endPortalSpace();
    return;
  }

  // Follow the camera: ring plane perpendicular to view, hole on the view axis.
  cam.updateMatrixWorld();
  _rig.position.setFromMatrixPosition(cam.matrixWorld);
  _rig.quaternion.setFromRotationMatrix(cam.matrixWorld);
  // MovementState corkscrew: roll twist (TurnCommand spin) + yaw banking
  // (TurnCommand) + lateral sway (SideStepSpeed), all view-relative. Forward
  // (ForwardCommand) is the tunnel stream below.
  _rig.rotateZ(_elapsed * TWIST_RATE);
  _rig.rotateY(Math.sin(_elapsed * TURN_RATE) * TURN_AMP);
  const bloom = 1 + (1 - closeEnv) * 0.6; // rings rush outward as it closes
  _rig.scale.setScalar(_scale * (0.2 + 0.8 * openEnv) * bloom);
  // sidestep sway: nudge the hole off the view axis so it curves past you
  _rig.translateX(Math.sin(_elapsed * SIDESTEP_RATE) * SIDESTEP_AMP * RING_SPACING);

  // Keep the optional loop bed pinned to the listener (== cam.position in the
  // AudioManager's frame) so it stays omnipresent as you move/turn.
  if (_loop?.panner) {
    const p = cam.position;
    const pn = _loop.panner;
    if (pn.positionX && typeof pn.positionX.value === "number") {
      pn.positionX.value = p.x;
      pn.positionY.value = p.y;
      pn.positionZ.value = p.z;
    } else if (typeof pn.setPosition === "function") {
      pn.setPosition(p.x, p.y, p.z);
    }
  }

  // Stream the tunnel toward the camera, recycling rings front↔back, and spin
  // each ring for the "twists and turns".
  const travel = _elapsed * FLY_SPEED;
  const span = RING_SPACING * RING_COUNT;
  for (let i = 0; i < _rings.length; i++) {
    const base = (i + 1) * RING_SPACING;
    let z = -(((base - travel) % span) + span) % span; // (-span, 0], in front
    _rings[i].position.set(0, 0, z);
    _rings[i].rotation.z = travel * 0.04 + i * 0.5;
  }
  for (const m of _materials) m.opacity = env;
}

/** Tear down: detach the rig (kept for reuse) and clear active state. */
export function endPortalSpace() {
  if (!_active) return;
  _active = false;
  if (_rig) {
    _rig.visible = false;
    if (_rig.parent) _rig.parent.remove(_rig);
  }
  for (const m of _materials) m.opacity = 0;
  stopLoop();
}

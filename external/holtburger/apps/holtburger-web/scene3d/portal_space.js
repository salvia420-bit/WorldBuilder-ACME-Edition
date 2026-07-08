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
import { lbWarmPending, warmSubtree } from "./program_warm.js";

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

// ── Loading GATE (retail `blocking_for_cells`, acclient.c SmartBox::UseTime
// :146268). While portalling we HIDE the destination world groups and hold the
// donut until the destination is resident AND its shader programs are
// link-complete (program_warm), then reveal. So the world never renders
// half-built — nor stalls ~1s/program on the first-render ACTIVE_UNIFORMS fetch
// (the Marketplace freeze, 2026-07-08) — in front of the player: that link
// happens off-screen, behind the tunnel. `?portalGate=off` keeps the donut as a
// pure visual (legacy time-driven close).
// Wall-clock (performance.now) driven so the gate is robust to rAF throttling
// (a backgrounded/hidden tab drops to ~1 Hz; a frame-counted streak would then
// stretch to seconds and the `_elapsed` envelope would stall).
const GATE_MIN_MS = 500; // ms — always show the tunnel at least this long
const GATE_READY_MS = 200; // ms — destination must stay resident+warmed this long
const GATE_MAX_MS = 8000; // ms — hard safety cap: reveal even if never "ready"
// World groups hidden during transit (all on `scene3d`). Hiding the GROUP (not
// per-mesh) is what suppresses the first-render program link across every layer
// at once; program_warm links them in the driver background meanwhile.
const WORLD_GROUP_KEYS = [
  "terrainGroup",
  "buildingsGroup",
  "staticsGroup",
  "cellsGroup",
];

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
// Gate state.
let _gating = false;        // world hidden, holding the tunnel for readiness
let _gateEnabled = true;    // `?portalGate=off` → visual-only (no world hide/hold)
let _hiddenGroups = null;   // [{ group, prev }] captured to restore on reveal
let _gateStartWall = 0;     // performance.now() when the gate began
let _readySinceWall = 0;    // performance.now() the destination first looked ready (0 = not)
let _startWall = 0;         // performance.now() of the last accepted start (re-entry guard)

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

// Hide the destination world groups so nothing first-renders (and stalls on the
// program link) while the tunnel is up. Idempotent — a rapid re-teleport keeps
// the already-captured `prev` flags.
function hideWorld(scene3d) {
  if (_hiddenGroups) return; // already hidden (re-teleport mid-gate)
  const captured = [];
  for (const key of WORLD_GROUP_KEYS) {
    const group = scene3d && scene3d[key];
    if (group && typeof group.visible === "boolean") {
      captured.push({ group, prev: group.visible });
      group.visible = false;
    }
  }
  _hiddenGroups = captured;
}

// Restore the world groups to their pre-gate visibility. Their per-mesh /
// per-cell visibility logic (BFS reveal, frustum cull) resumes from here.
function revealWorld() {
  if (!_hiddenGroups) return;
  for (const { group, prev } of _hiddenGroups) {
    try {
      group.visible = prev;
    } catch (_) {
      /* group torn down mid-gate — ignore */
    }
  }
  _hiddenGroups = null;
}

// Destination readiness: the terrain under the player is baked (streaming has
// reached the destination LB) and no shader-program warm is still in flight (so
// every newly-linked program is COMPLETION_STATUS-ready — revealing now cannot
// land a first-render link stall). Cells/buildings/statics are covered by
// `pendingWarmCount` (each registers a warm job while loading).
function gateReady(scene3d) {
  let curLb = 0;
  try {
    const sh = typeof window !== "undefined" ? window.__sessionHandle : null;
    const pose = sh && sh.getLocalPlayerPose ? sh.getLocalPlayerPose() : null;
    if (pose) {
      curLb = ((pose.landblockId >>> 16) << 16) >>> 0;
      if (typeof pose.free === "function") pose.free();
    }
  } catch (_) {
    return false;
  }
  if (!curLb) return false;
  const terrainOk =
    scene3d.terrainBakedLbs instanceof Set
      ? scene3d.terrainBakedLbs.has(curLb)
      : true;
  // Cells for the destination must have been processed (their attach adds the LB
  // to envCellLoadedLbs and registers the cell warm) — guards against a
  // premature "no pending warm" the instant before streaming reaches the dest.
  const cellsOk =
    scene3d.envCellLoadedLbs instanceof Set
      ? scene3d.envCellLoadedLbs.has(curLb)
      : true;
  // Wait on THIS landblock's programs only — NOT the whole neighbourhood's
  // (which now includes look-ahead prefetches). That is the reveal-speed fix:
  // the gate no longer holds the world hidden until every prefetched neighbour
  // has also finished linking.
  return terrainOk && cellsOk && !lbWarmPending(curLb);
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
    // Warm the donut's OWN programs before it is ever shown — otherwise its
    // materials link on the tunnel's first render (first teleport of the
    // session), stalling the very loading screen meant to hide such stalls.
    // Awaited (resolves via tickProgramWarm on the running loop), so the rig is
    // returned only once its shaders are COMPLETION_STATUS-ready.
    try {
      await warmSubtree(scene3d, _rig, 0, { markLb: false });
    } catch (_) {
      /* fail-soft: donut lazy-links on first render */
    }
    return _rig;
  })();
  const built = await _building;
  _building = null;
  return built;
}

/**
 * Build + warm the donut rig ahead of the first teleport (call once at boot,
 * behind the loading screen). Without this, the FIRST teleport of a session
 * shows ~1s of hidden world while the donut's mesh is fetched and its programs
 * link; pre-warming moves that cost to boot where a wait is already expected.
 * Fail-soft and idempotent (ensureRig caches the rig).
 */
export async function prewarmPortalDonut(scene3d) {
  try {
    await ensureRig(scene3d);
  } catch (_) {
    /* fail-soft: the donut lazy-builds on first teleport */
  }
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
  // Re-entry guard: the gate is triggered by BOTH the loop.js LB-jump detector
  // (early, jitter-free) and the kind=33 PortalSpaceEntered event (later, after
  // event-drain latency). Ignore the duplicate so the second call can't
  // restart/extend an in-flight transit. `gateReady` reads the LIVE pose, so a
  // genuine rapid re-teleport still re-targets without a restart.
  const nowW0 = typeof performance !== "undefined" ? performance.now() : 0;
  // `_gating` flips synchronously below (before the rig-build await), so this
  // also dedups a kind=33 call that lands mid-build on the first teleport.
  if ((_active || _gating) && nowW0 - _startWall < 3000) return;
  _startWall = nowW0;
  _scale = Number.isFinite(scale) && scale > 0 ? scale : DEFAULT_SCALE;
  _enterDid = enterDid === undefined ? PORTAL_ENTER_WAVE : enterDid >>> 0;
  _loopDid = loopDid ? loopDid >>> 0 : 0;
  // Gate setup FIRST — hide the destination world SYNCHRONOUSLY, before the async
  // rig build. `ensureRig` fetches the donut mesh on the first teleport (a wasm
  // round-trip); if we hid the world only after that await, the destination would
  // render + stall (~1s/program) in the gap. `?portalGate=off` = visual-only.
  try {
    const sp = new URLSearchParams(
      typeof window !== "undefined" && window.location
        ? window.location.search
        : "",
    );
    _gateEnabled = sp.get("portalGate") !== "off";
  } catch (_) {
    _gateEnabled = true;
  }
  _readySinceWall = 0;
  _gating = false;
  if (_gateEnabled) {
    hideWorld(scene3d);
    _gating = true;
    _gateStartWall = performance.now();
  }
  const rig = await ensureRig(scene3d);
  if (!rig) {
    // No donut (headless / build failed): never strand the world hidden.
    revealWorld();
    _gating = false;
    return;
  }
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
  if (_gating) {
    revealWorld();
    _gating = false;
  }
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

  // Gate driver: hold the tunnel (world hidden) until the destination has been
  // resident + warmed for GATE_READY_MS straight, then reveal. GATE_MAX_MS is the
  // hard safety cap so a stuck stream can never trap the player in transit.
  if (_gating) {
    const nowW = performance.now();
    const held = nowW - _gateStartWall;
    if (held >= GATE_MIN_MS && gateReady(scene3d)) {
      if (_readySinceWall === 0) _readySinceWall = nowW;
    } else {
      _readySinceWall = 0;
    }
    const settled =
      _readySinceWall !== 0 && nowW - _readySinceWall >= GATE_READY_MS;
    if (settled || held >= GATE_MAX_MS) {
      revealWorld();
      _gating = false;
      _arrived = true; // begin the iris-close as the world comes back
    }
  }

  // Phase envelope. open → travel (until arrival / cap) → close. While gating we
  // hold up to MAX_HOLD (not TRAVEL_DUR) so a slow destination keeps the tunnel.
  const travelEnd = _arrived ? 0 : _gating ? MAX_HOLD : TRAVEL_DUR;
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
  // Safety: a teardown mid-gate must never leave the destination world hidden.
  revealWorld();
  _gating = false;
  _readySinceWall = 0;
  if (_rig) {
    _rig.visible = false;
    if (_rig.parent) _rig.parent.remove(_rig);
  }
  for (const m of _materials) m.opacity = 0;
  stopLoop();
}

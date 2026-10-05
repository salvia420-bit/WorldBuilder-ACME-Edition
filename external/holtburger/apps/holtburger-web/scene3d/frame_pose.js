// frame_pose.js — one `getLocalPlayerPose()` wasm crossing per frame.
//
// `SessionHandle.getLocalPlayerPose()` returns a wasm-bindgen BOX
// (`LocalPlayerPose`, needs `free()`), and several per-frame consumers in
// `tickPerFrame` (loop.js rig pose, the server-turn poll, camera.js heading +
// integrator mirror) each read it. This module hands them ONE frozen plain
// snapshot per frame and frees the box immediately.
//
// Why caching cannot change what a caller sees within a frame: the wasm side
// writes the pose cell (`local_player_pose`) only from the async recv loop
// (`publish_local_player_pose`); `tickMovement()` merely ENQUEUES a command.
// `tickPerFrame` is synchronous, so every direct read inside it already
// returned identical values. The cache is therefore scoped to exactly that
// synchronous window: `beginPoseFrame()`/`endPoseFrame()` bracket it (see
// loop.js `tickPerFrame`). Outside the window — event handlers, timers, the
// deliberate pre/post-tick `?syncTickDiag` reads in index.js — every call is
// a fresh read (still snapshotted + freed).

let _depth = 0;
let _cached; // undefined = not read this frame; null = read, no pose
let _cachedHandle = null; // identity key — see _handleKey

// The camera reaches the handle via window.__sessionHandle, which
// plugins/rejection_feedback.js replaces with a Proxy, while loop.js gets the
// raw handle. Key on the wasm pointer (a plain data prop the Proxy passes
// through) so both share one read; plain mocks fall back to object identity.
function _handleKey(handle) {
  const ptr = handle.__wbg_ptr;
  return (typeof ptr === "number" && ptr !== 0) ? ptr : handle;
}

/** Copy the box's fields into a frozen plain object (null for no pose). */
export function snapshotLocalPlayerPose(p) {
  if (!p) return null;
  return Object.freeze({
    x: p.x,
    y: p.y,
    z: p.z,
    heading: p.heading,
    landblockId: p.landblockId,
    isOnGround: p.isOnGround,
  });
}

/** Open the per-frame cache window (nestable). */
export function beginPoseFrame() {
  if (_depth === 0) {
    _cached = undefined;
    _cachedHandle = null;
  }
  _depth += 1;
}

/** Close the per-frame cache window; drop the snapshot when the outermost closes. */
export function endPoseFrame() {
  if (_depth > 0) _depth -= 1;
  if (_depth === 0) {
    _cached = undefined;
    _cachedHandle = null;
  }
}

/**
 * The local player's pose as a frozen plain object, or null (no handle, no
 * export, pre-spawn, or the read threw). Inside a begin/end window the first
 * call per handle crosses into wasm and later calls share its snapshot.
 */
export function readLocalPlayerPose(handle) {
  if (!handle || typeof handle.getLocalPlayerPose !== "function") return null;
  const key = _handleKey(handle);
  if (_depth > 0 && _cached !== undefined && _cachedHandle === key) return _cached;
  let box = null;
  try { box = handle.getLocalPlayerPose(); } catch (_) { box = null; }
  const snap = snapshotLocalPlayerPose(box);
  try { box?.free?.(); } catch (_) { /* already released */ }
  if (_depth > 0) {
    _cached = snap;
    _cachedHandle = key;
  }
  return snap;
}

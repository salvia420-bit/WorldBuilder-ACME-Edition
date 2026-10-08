// scene3d/viewer_cell.js — bug 4 (2026-10-07): retail's VIEWER cell.
//
// Retail renders from the CAMERA's cell, not the player's.
// `SmartBox::RenderNormalMode` (acclient.c:144889) branches on
// `viewer.objcell_id & 0xFFFF < 0x100`, and `SmartBox::update_viewer`
// (acclient.c:144991) gets that cell by moving the camera sphere from the
// player's head to the eye as a physics transit. OpenAC does the same
// (`PhysicsCameraCollisionProbe.SweepEye` returns the viewer cell, and
// `RetailFrameWalk.WalkFrame` takes it as `cameraCellId`).
//
// Ours keyed every render decision to the player's cell, which is what the
// barn-door report showed:
//   · player outside, camera inside the barn → the outdoor portal punch ran
//     from inside the room, stamping far depth over the view out of the
//     door, and the horizon dissolve then washed those pixels to sky colour
//     (the "strong fog");
//   · player inside, camera outside → the indoor depth split armed and the
//     seal re-stamped the doorway plane at true depth, so the interior behind
//     it failed the depth test from the outside camera and only the grass
//     drawn before the wipe remained.
//
// cells.js `tickCellVisibility3D` resolves the viewer cell once per frame
// (wasm `resolveViewerCell`), roots the wasm render walks at it
// (`setViewerCell`) and publishes it here. RENDER consumers of "am I indoors"
// read it (the indoor depth split, the portal punch, the sky pass, weather,
// the horizon dissolve). Gameplay consumers (ambient sound, collision,
// content streaming) keep the player's cell.
//
// `?viewerCell=off` restores the player-cell behaviour.

export const VIEWER_CELL_ON = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search || "").get("viewerCell") !== "off";
  } catch (_) {
    return true;
  }
})();

/**
 * Retail `viewer_sphere` radius (acclient.c:145543, 0x3E99999A = 0.3f;
 * OpenAC `PhysicsCameraCollisionProbe.ViewerSphereRadius`). camera.js sweeps
 * the same sphere under `?camRetailSphere` (camera-4, 2026-10-08 round 2).
 */
export const VIEWER_SPHERE_RADIUS_M = 0.3;

/**
 * Pivot above the player's feet: `CAMERA_DEFAULT_PIVOT_Z` (acclient.c:39550),
 * the same one camera.js sweeps from under `?camRetailSphere` (was 1.6, the
 * legacy clip-chain head height, before 2026-10-08 round 2).
 */
export const VIEWER_PIVOT_Z_M = 1.5;

/** An EnvCell id (low word ≥ 0x100) is an indoor cell. */
export function isIndoorCellId(cell) {
  return ((cell >>> 0) & 0xffff) >= 0x100;
}

const _state = {
  valid: false,
  cell: 0,
  indoor: false,
  seenOutside: false,
  playerCell: 0,
  playerIndoor: false,
};

/**
 * Publish this frame's viewer cell.
 * @param {number} playerCell full cell id of the local player
 * @param {boolean} playerIndoor
 * @param {number} viewerCell full cell id of the camera (0 → the player's)
 * @param {boolean} seenOutside SeenOutside bit of the viewer cell
 * @returns {boolean} true when the published viewer changed
 */
export function publishViewerCell(playerCell, playerIndoor, viewerCell, seenOutside) {
  const p = playerCell >>> 0;
  const v = (viewerCell >>> 0) || p;
  const indoor = v === p ? !!playerIndoor : isIndoorCellId(v);
  const changed = !_state.valid || _state.cell !== v || _state.playerCell !== p;
  _state.valid = p !== 0;
  _state.cell = v;
  _state.indoor = indoor;
  _state.seenOutside = indoor ? !!seenOutside : false;
  _state.playerCell = p;
  _state.playerIndoor = !!playerIndoor;
  return changed;
}

/** The live (mutable) viewer state; treat as read-only. */
export function viewerState() {
  return _state;
}

/** Render-side indoor flag: the viewer's when published, else `fallback`. */
export function viewerIndoorOr(fallback) {
  return _state.valid ? _state.indoor : !!fallback;
}

/** Forget the published viewer (session teardown / tests). */
export function resetViewerCell() {
  _state.valid = false;
  _state.cell = 0;
  _state.indoor = false;
  _state.seenOutside = false;
  _state.playerCell = 0;
  _state.playerIndoor = false;
}

// Sky pass host (originally the parametric Sky-D dome + celestial-body
// renderer, gutted in K.6 cleanup).
//
// Before K.6: hosted a 32×16 gradient sphere (Sky-D), parametric
// SkyObject rotators (Sky-E/G — sun, moon, cloud bands, stars,
// weather streaks fetched from client_portal.dat via Sky-Assets +
// populateCelestialBodies), per-celestial particle chains (Sky-J P5),
// natural-sky override path (__naturalSky), and a horizon-gradient
// uniform sink driven by SkyLightingController.skyBackgroundColor.
// Roughly 1,876 LoC.
//
// After K.6: the takram atmosphere stack (SkyMaterial + stars +
// AerialPerspective + volumetric clouds) is the sole renderer of
// every celestial element. The parametric DAT-driven path is gone.
// This module's only remaining job is to host the sky-pass scene
// (`skyScene`) + sky-pass camera (`skyCamera`) so atmosphere_sky,
// ac_moons, aurora, and cloud_overlay have a common parent for the
// pre-world render pass, and to drive the per-frame indoor flip +
// cloud-overlay tick.
//
// Class name `SkyDome` is preserved for backward compatibility with
// the existing `liveScene3d.skyDome` access patterns from before K.6.

import * as THREE from "three";

const SKY_CAMERA_NEAR = 0.1;
const SKY_CAMERA_FAR = 50000.0;

/**
 * Minimal sky-pass host. Owns the scene + camera that atmosphere_sky
 * (takram SkyMaterial + stars), ac_moons (AC moon billboards),
 * aurora (Hagol overlay), and cloud_overlay (volumetric clouds)
 * paint into during the pre-world render pass.
 */
export class SkyDome {
  /**
   * @param {Object} opts
   * @param {THREE.Scene} opts.scene — root world scene (kept for API
   *   compat with the prior dome implementation; unused post-K.6).
   * @param {Function} [opts.sessionHandleAccessor] — `() => SessionHandle
   *   | null`. Called each tick to fetch the wasm handle that exposes
   *   `isCurrentCellIndoor()` — the indoor short-circuit gate for
   *   skipping the sky render pass when the player is inside a
   *   dungeon / building.
   * @param {Object} [opts.liveScene3dRef] — reference to the live
   *   scene3d hash; used to pull the cached SkyState
   *   (`skyLightingController._lastState`) and forward it into
   *   `cloudOverlay.tick(state)` without a second wasm call.
   */
  constructor(opts) {
    const { scene, sessionHandleAccessor, liveScene3dRef = null } = opts || {};
    if (!scene) {
      throw new Error("SkyDome: opts.scene required");
    }
    this.scene = scene;
    this.sessionHandleAccessor =
      typeof sessionHandleAccessor === "function"
        ? sessionHandleAccessor
        : () => null;
    this.liveScene3dRef = liveScene3dRef;

    // === Sky scene + camera (separate render pass) ====================
    //
    // The sky pass renders BEFORE the world pass in
    // atmosphere_pipeline.js's EffectComposer. It clears color + depth,
    // then renders this scene with this camera (which mirrors the main
    // camera each tick via syncSkyCamera). The subsequent world pass
    // runs with `clear=false, clearDepth=true` so sky color is
    // preserved and world depth-tests fresh.
    this.skyScene = new THREE.Scene();
    this.skyScene.name = "sky_scene";
    this.skyScene.fog = null;
    this.skyCamera = new THREE.PerspectiveCamera(
      60,
      1,
      SKY_CAMERA_NEAR,
      SKY_CAMERA_FAR,
    );
    this.skyCamera.name = "sky_camera";

    // === Sky cell (camera-anchored Group) =============================
    //
    // Kept as an empty Group for backward compatibility with code
    // paths that read `skyDome.skyCell` (e.g. atmosphere_sky.js's
    // detach() path). The cell still follows the main camera each
    // tick — useful if any future sky-internal mesh wants the
    // camera-anchored frame without each owner re-implementing the
    // copy.
    this.skyCell = new THREE.Group();
    this.skyCell.name = "sky_cell";
    this.skyCell.rotation.x = -Math.PI / 2;
    this.skyScene.add(this.skyCell);

    // Cloud overlay handle, attached lazily via setCloudOverlay().
    this.cloudOverlay = null;

    // Indoor short-circuit state. Read by renderSkyPass +
    // atmosphere_pipeline.preFrameSkySync.
    this._lastIsIndoor = false;
    this._lastSkyRendered = false;

    // Tick counters (capture scripts inspect these).
    this._tickCount = 0;
    this._indoorTickCount = 0;
  }

  /**
   * Attach the cloud overlay so its quad lives in the sky scene
   * (renderOrder=999, painted after every other sky-pass mesh) and
   * its per-frame tick runs from `SkyDome.tick`.
   *
   * @param {import('./cloud_overlay.js').CloudOverlay|null} cloudOverlay
   */
  setCloudOverlay(cloudOverlay) {
    this.cloudOverlay = cloudOverlay;
    if (cloudOverlay && typeof cloudOverlay.attachToSkyScene === "function") {
      cloudOverlay.attachToSkyScene(this.skyScene);
    }
  }

  /**
   * No-op stub. Pre-K.6 this toggled the visibility of every
   * parametric SkyObject rotator. The parametric meshes are gone
   * post-K.6 so there's nothing to toggle. Kept for backward
   * compatibility with any caller (atmosphere_sky.js cleared this
   * call in K.6; left here so a stale call from another path
   * doesn't throw).
   */
  setParametricSkyObjectsVisible(_visible) {
    // intentionally empty
  }

  /**
   * Per-rAF tick. (1) anchor `skyCell` at the camera so any cell-
   * resident mesh stays compass-locked. (2) read the indoor flag
   * from wasm so renderSkyPass can short-circuit. (3) forward the
   * cached SkyState into the cloud overlay so it doesn't need its
   * own getSkyState() wasm call.
   *
   * @param {number} _dt
   * @param {THREE.Camera} camera
   */
  tick(_dt, camera) {
    this._tickCount += 1;

    if (camera && camera.position) {
      this.skyCell.position.copy(camera.position);
    }

    const session = this.sessionHandleAccessor();
    let isIndoor = false;
    if (session && typeof session.isCurrentCellIndoor === "function") {
      try {
        isIndoor = !!session.isCurrentCellIndoor();
      } catch (_) {
        isIndoor = this._lastIsIndoor;
      }
    }
    this._lastIsIndoor = isIndoor;

    if (this.cloudOverlay) {
      const cachedState =
        this.liveScene3dRef?.skyLightingController?._lastState ?? null;
      this.cloudOverlay.tick(cachedState);
    }

    if (isIndoor) {
      this._indoorTickCount += 1;
    }
  }

  /**
   * Sync the sky camera with the main world camera. Position +
   * quaternion + fov + aspect mirror so the projection matrix
   * aligns. Called from atmosphere_pipeline's preFrameSkySync each
   * frame.
   *
   * @param {THREE.Camera} mainCamera
   */
  syncSkyCamera(mainCamera) {
    if (!mainCamera) return;
    this.skyCamera.position.copy(mainCamera.position);
    this.skyCamera.quaternion.copy(mainCamera.quaternion);
    if (typeof mainCamera.fov === "number") {
      this.skyCamera.fov = mainCamera.fov;
    }
    if (typeof mainCamera.aspect === "number") {
      this.skyCamera.aspect = mainCamera.aspect;
    }
    this.skyCamera.updateProjectionMatrix();
  }

  /**
   * Direct-render path for the indoor short-circuit case. The
   * atmosphere composer normally drives the sky pass as an
   * EffectComposer RenderPass; this method is kept for the legacy
   * direct-render path that runs when atmosphere mode isn't fully
   * wired (e.g. early in init before AtmosphereRuntime resolves).
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} mainCamera
   * @param {number} [dt=0]
   */
  renderSkyPass(renderer, mainCamera, dt = 0) {
    if (!renderer || !mainCamera) {
      this._lastSkyRendered = false;
      return;
    }
    if (this._lastIsIndoor) {
      this._lastSkyRendered = false;
      return;
    }
    this.syncSkyCamera(mainCamera);
    if (this.cloudOverlay) {
      this.cloudOverlay.preRender(renderer, dt, mainCamera);
    }
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;
    renderer.render(this.skyScene, this.skyCamera);
    renderer.autoClear = prevAutoClear;
    if (this.cloudOverlay) {
      this.cloudOverlay.renderOverlay(renderer);
    }
    this._lastSkyRendered = true;
  }

  /** Capture-script introspection: did renderSkyPass actually draw last frame? */
  wasSkyRenderedLastFrame() {
    return !!this._lastSkyRendered;
  }

  dispose() {
    if (this.cloudOverlay && typeof this.cloudOverlay.dispose === "function") {
      try { this.cloudOverlay.dispose(); } catch (_) { /* tear-down */ }
    }
    this.skyScene.fog = null;
    this.cloudOverlay = null;
    this.skyScene = null;
    this.skyCamera = null;
    this.skyCell = null;
  }
}

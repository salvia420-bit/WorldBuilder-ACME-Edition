# CAMERA CONTROLLERS + FRAME LOOP (holtburger-web scene3d: camera.js, camera_math.js, loop.js tickPerFrame, index.js init3D/tick/render, adaptive_render_scale.js, shader_logdepth.js, frame_pose.js, harness moving_rig/moving_path, perf-worker camset.mjs)
All paths are relative to HB=$REPO/external/holtburger/apps/holtburger-web unless absolute. I read every cited line myself. Three r184 (index.html:986 importmap; node_modules/three 0.184.0); postprocessing 6.39.1.

(1) CAMERASWITCHER + COORDINATE FRAME
- Class `CameraSwitcher` (scene3d/camera.js:408) is built once in init3D (index.js:3652-3689) with persp `camera` = PerspectiveCamera(60, cssW/cssH, 0.1, 5000) (index.js:1625; layers 0 and 1, :1650) and `orthoCamera` from createOrthoCamera (camera.js:368: 100 m frustum height at zoom 1, near 0.1, far 5000, layer 1 enabled).
- Modes are CAMERA_MODES=["follow","topDown","orbit"] (:195). A C-key press edge cycles them (`_installModeToggle` :3196). `activeCamera` is persp in follow and orbit, ortho in topDown. The renderer draws `liveScene3d.cameraSwitcher.activeCamera ?? camera` (index.js:2722). Nothing outside scene3d drives the camera; plugins only read it.
- Key state:
  - followYaw is a compass bearing: AC forward = (sin yaw, cos yaw).
  - followPitch is positive looking down, init 0.3, clamped to [FOLLOW_PITCH_MIN -0.5, FOLLOW_PITCH_MAX 1.4] (:215-216).
  - followDistance is 6 m. The retail zoom continuum (default on) runs 0.5..10 m plus in-head.
  - Also: keys{w,a,s,d,q,e,shift}, controls (OrbitControls only in orbit), predictedPlayerPos, _prevEyeAc, _camStiffness (null = hard lock).
  - Flags read once in the ctor (:606-690); live setters window.__setCam*/__setAutoFollow* (:759-846); localStorage `holtburger_camera_v1` overrides (:853-881).
- `tick(dt)` (:1179-1196) runs in this order:
  1. `_smoothToIntegrator(dt)` (:2664): direct-assigns the wasm pose into predictedPlayerPos. This feeds entities.getLocalPlayerWorldPos (entities.js:15818-15836), and through it lighting, the shadow gate, single-shadow recentre and far-terrain fallback, plus the local rig when ?rustPose=off.
  2. `_updateCombatTargetTracking`.
  3. `_updateAutoFollow`, which mutates followYaw.
  4. `this.positionCamera(dt)` (an instance property lookup, so it can be overridden per instance).
  5. `controls.update()`.
  6. `_dispatchMovement()`.
- `positionCamera(dt)` (:1536-1702):
  - p = `_safePlayerPos()` in AC world metres. With ?rustPose on by default, this is the wasm integrator pose LB-folded via `_integratorWorldPose` (:2621).
  - follow branch: ideal eye = p - fwd*d*cos(pitch), z = p.z + d*sin(pitch) + 1.0.
    - Under camViewerStep (default on), only the terrain floor is applied first (`_terrainFloorZ`).
    - look = (p.x, p.y, p.z + 1.6 - sin(pitch)*4) (LOOK_LIFT_DIST_M :223), plus optional cast bias. Then guardLookHorizontal (:1645-1655).
    - `_applyViewerStep` (:2073): lerp from the last swept eye toward the ideal by stiffnessFrac (frac 1 = hard lock), then sweep pivot→sought, and publish the swept eye. Orientation is ideal-eye→look via Matrix4.lookAt plus quaternion slerp(frac).
    - Legacy path: clip-first then `persp.position.set(...acToThree)` + `persp.lookAt(...acToThree)`.
    - Then near-fade opacity on the local player.
  - orbit branch: only sets `controls.target = acToThree(p + 1 m)`.
  - topDown branch: ortho at p.z + 300, `ortho.up = (0,0,-1)` (AC north up), lookAt p.
- `?camDebug=on` (exact match, ctor :463-473; `_installCamDebug` :1457-1534) replaces `this.positionCamera` with a wrapper that returns early while `_camDebugParked`. It installs `window.__cam`:
  - `park()` returns true. `release()` returns false. `parked` getter.
  - `set(ex,ey,ez,tx,ty,tz)`: AC world metres; implies park. Writes `cs.activeCamera` (that is the ORTHO camera in topDown): position = acToThree(eye), `up.set(0,1,0)`, `lookAt(acToThree(target))`, `updateMatrixWorld(true)`; returns info().
  - `orbit(tx,ty,tz,dist,azDeg,elDeg)`: eye = t + (dist*cos(el)*sin(az), dist*cos(el)*cos(az), dist*sin(el)). az is the compass bearing of the EYE from the target (deg CW from north); el is degrees above horizon.
  - `player(dist,az,el,dz=1)`: orbit around the LIVE `world()` pose, so it drifts (moving_path.mjs:8-27).
  - `fov(v)`: perspective only; sets fov + updateProjectionMatrix; does NOT park.
  - `info()` returns {pos: THREE coords rounded, fov, parked, mode, world: AC}.
  - `world()` = getLocalPlayerPose() folded, box freed.
- "Landblock folded": getLocalPlayerPose returns landblock-LOCAL x,y in [0,192) plus landblockId 0xXXYYcccc (d.ts:2342-2365). World = (XX*192 + x, YY*192 + y, z). This is the same convention as @teleloc cell+local and moving_path.cellToWorld (:56-59).
- Mapping to three.js:
  - worldRoot (index.js:1552-1555) is a Group whose ONLY transform is rotation.x = -pi/2; there is no translation.
  - All terrain/buildings/statics/cells/entities live inside it in ABSOLUTE AC world metres (entity root.position = AC coords).
  - There is NO floating origin or rebasing anywhere (grep for floatingOrigin/rebase/worldRoot.position writes returned nothing).
  - The camera is NOT parented (parent null), so the renderer auto-updates its matrixWorld at render (three.module.js:17571). camera.position and quaternion are therefore THREE world coords.
  - three = acToThree(ax,ay,az) = [ax, az, -ay] (adapter.js:1817). Inverse is (x, -z, y) (moving_rig.mjs:62). AC east = +X, AC north = -Z, AC up = +Y.
  - An identity camera looks AC north with AC up.
- A film controller must write `persp.position = acToThree(eyeWorldAC)` and `persp.quaternion` in the three frame. My derivation (no repo citation): `rotation.set(-pitchDown, -bearing, roll, 'YXZ')` gives AC forward (cos p*sin b, cos p*cos b, -sin p).
- Doc trap: the camera.js:19-23 header says camera positions are AC coords. That is stale; the code uses acToThree since the 2026-05-18 fix (:1085-1097).

(2) PER-FRAME ORDER
- index.js `tick(nowTs)` (:2487) in order:
  1. dt: first frame 0.016. If raw dt > max(0.5 s, 1.5×frame interval), dt is forced to 0 for 10 frames (disabled under renderOnDemand). Otherwise dt = min(raw, 0.1) (:2311-2339, :2497-2514).
  2. `await syncTickHop` (default ?syncPhysicsTick: handle.tickMovement() + one microtask). This makes tick async.
  3. `liveScene3d.frameTime = {tsMs, tsSec, dt}` (:2532).
  4. `tickPerFrame` (:2538), then acMoons.
  5. Audio listener = active camera pos/quat (:2551-2592).
  6. LRU eviction / slot grid / terrain audit / reaper (all player-LB).
  7. ambientRuntime.
  8. RENDER (:2722-2984):
     - Portal space owns the frame: black + tunnel only.
     - Composer path: `atmospherePipeline.preFrameSkySync(skyDome, activeCam)` (sky camera copies pos/quat/fov/aspect, sky_dome.js:711-721), cloud preRender, `atmospherePipeline.render(activeCam, dt)`, overlays.
     - nullRender: exit.
     - Direct path: sky pass, layer masks, optional indoor split, renderer.render.
  9. Every exit goes through `_postRenderStreamSlot()` (:2360) and then `scheduleNext()` (:2403). renderOnDemand never re-arms; targetFps paces with setTimeout+rAF; portal space paces at 30 fps.
- loop.js `tickPerFrame` (:2780) is wrapped in beginPoseFrame/endPoseFrame (frame_pose.js: one getLocalPlayerPose crossing per frame, frozen snapshot). Body order:
  - #0 `__netFramePump` (singleDriver, :2817).
  - #1 `tickCellVisibility3D`: viewer cell plus a frustum/PView render set from the camera MVP; stencil/punch/seal feeds (:2857-2867).
  - #1.5 `tickFrustumCull` (:2879).
  - #2 [RP3 PVS, 10 Hz] PVS expansion and far ring.
  - terrain uTime, VFX oscillators, weather, terrainVfx (grass).
  - #4 [SKY] sun dir.
  - #5 fxLights; `tickLightingForCellState`, which includes `updateCsm(activeCam)` (lighting.js:1687-1700) and the player-centred single-shadow recentre (:1662-1676); flicker; shadow receive gate.
  - #7-#12 [SKY, 10 Hz]: sky lighting, fog color, `atmosphereLights.tick(state, cam.position)` (:3136), IBL, atmosphereSky, `skyDome.tick(dt, activeCam)` (:3194), weather.
  - #13 `cameraSwitcher.tick(dt)` (:3233-3243).
  - tickPortalSpace; animated surfaces.
  - #15/16/19 `entityManager.tick(dt)` (mixers; the default particle tick is inside), drains, remote poses, `applyLocalPlayerPoseFromIntegrator`, serverTurn.
  - A11-S3 particle phase (only if ?particleClock).
  - fx ribbons / weaponFx / showcase.
  - #20 [RP3 NAME] nameplate DOM tick; selection brackets DOM.
- Consequences:
  - Cell visibility, viewer cell, frustum cull, CSM fit and sky all run BEFORE the camera tick. They read `camera.matrixWorldInverse` from the PREVIOUS render, so they lag the camera by one frame. Object3D.lookAt also refreshes matrixWorld with the old rotation.
  - Entities and particles update AFTER the camera, so a tracked subject's pose is one frame old. The local player under rustPose is current.
  - RP6 particles call `updateMatrixWorld` themselves (particle_manager.js:937-963).
- Clocks: rAF ts drives frameTime. RP3 throttles, the shadow gate and IBL use live `performance.now()`. Particles are absolute-clock, or with ?particleClock=sim use loop dt capped at wall time.
- Cadence flags:
  - `?targetFps=N` paces the loop.
  - `?renderOnDemand=1`: one boot frame, then idle. `window.__renderOnce()` (:3007) calls `tick(performance.now())` and returns before an async frame completes. adaptiveRes is off.
  - `?nullRender=1`: full sim, no GPU submission.
  - `?netDrainHz=N` (:3031-3084) runs the FULL tickPerFrame (camera + animation) on setInterval with its own dt, independent of renders.
- There is NO pre/post-render hook registry; per-frame calls are hard-wired. Usable extension points: the per-instance positionCamera override (camDebug pattern), the renderer.render monkeypatch (camset.mjs), scene.onBeforeRender (fires per renderer.render call, several per composer frame), and `__renderOnce` external stepping.

(3) PER-FRAME CAMERA READERS
Camera-relative (these follow a film camera correctly):
- FrustumCuller (culling.js:154-185, 271-319): AC-space MVP from projection·matrixWorldInverse·worldRoot. Distance cull is opt-in via ?cullDist.
- Cell render set: `getRenderSetWithFrustum(mvp)` + `getRenderSetWithPView(mvp, 0)` (cells.js:3020-3087).
- CSM: 3 cascades at 30/100/300 m (csm.js:59). Refit whenever camera pos/rot/fov/aspect/near/zoom changes past thresholds (:121, :140, :412+). updateCsm itself calls camera.updateMatrixWorld/updateProjectionMatrix.
- Entity animation tick gate: 120 m from the active camera (entities.js:2887-2896, :16069-16098; ?maxTickDist).
- Particle RP6: frustum or 220 m cap, rechecked every 6 ticks (particle_manager.js:165-193).
- Dynamic entity LOD: reads `liveScene3d.camera` (the persp object, NOT activeCamera) at 2 Hz and respawns on band crossing (entities.js:16146-16200; ?dynLod=off).
- Others: statics billboards / LOD diag (statics.js:4197, :4286), THREE.LOD (render camera), sky dome skyCell + sky camera, atmosphere probe altitude, audio listener, nameplate LOD, tex_upgrade_queue side planes (:437), SSAO (reads `this.camera.projectionMatrix` and `far` per frame, ssao.js:219-223), three fog (view distance).

Player-centred (these break when the camera is far from the player):
- Viewer cell: cells.js `updateViewerCell` (:2849-2906) calls `resolveViewerCell(player head z+1.5 → camera eye, r 0.3, seed = playerCell)`. The Rust side (scene.rs:5673) walks 0.25 m steps, max 256. A void exit (wall) keeps the last reached cell. Outdoors it floods the 3×3 landcell buildings. So a film camera in a dungeon room not reachable in a straight line from the player's head gets the WRONG viewer cell, and the walks are rooted wrong.
- Light pool cell mode: `getRenderSet(1)` plus the player reference point (lighting.js:2001-2022, 2156+).
- Single-shadow frustum is recentred on the player (lighting.js:1662-1676).
- Shadow-receive gate: buildings/statics within 80 m of the player (loop.js:2478; buildings.js:262; statics.js:247).
- Grass pool is re-centred on the player (terrain_grass.js:19-24).
- Streaming and residency: LRU current LB from the player rig (index.js:6596-6616); PVS expansion from the player render set; far ring from the player LB (far_terrain.js:1070-1086).

(4) NEAR/FAR/FOV/RESIZE/LOG DEPTH
- Projection:
  - Perspective is near 0.1, far 5000, vertical fov 60.
  - `?retailFov=on` (opt-in) makes fovY = gameFov / (aspect - 0.1) rad (camera_math.js:542-559, index.js:1629-1639).
  - `logarithmicDepthBuffer: true` (index.js:1162). Custom ShaderMaterials must use shader_logdepth.js `withLogDepth`, or their depth test against the world is wrong.
- Resize (index.js:1869-1916, debounced 150 ms) resets persp.aspect, re-derives fov under retailFov, updates the ortho left/right, and resizes the composer and clouds. Agent-mode canvas is up to 4096×2160 (:881-897).
- Animating fov per frame (`cam.fov = f; cam.updateProjectionMatrix()`, exactly what `__cam.fov` does) is safe for dolly zoom:
  - pmndrs EffectMaterial.copyCameraSettings stores projectionMatrix/projectionMatrixInverse uniforms BY REFERENCE (postprocessing build/index.js:5122-5127), and EffectPass.render never re-copies (:15645-15655), so fov propagates.
  - Sky camera copies fov per frame; SSAO reads the projection per frame; CSM refits every frame while fov changes (cost).
  - `camera.userData.csmFitFov` lets CSM fit a different fov (csm.js:393).
  - Near/far, however, are copied BY VALUE only when the camera is set or retargeted, so keep near/far constant.

(5) DEGENERATE LOOK DIRECTIONS AND COLLISION
- Three r184 `Matrix4.lookAt` (node_modules/three/build/three.core.js:10306-10346): when up is exactly parallel to the view it nudges `_z.z += 0.0001` (or `_z.x` if |up.z|=1).
  - With `up = (0,1,0)`, exactly straight down gives screen-up = AC north; straight up gives AC south (my derivation from that code).
  - A tilt through vertical therefore snaps yaw or flips the image.
  - `__cam.set` always forces up = (0,1,0) and has no roll.
- Existing guards:
  - follow pitch clamp [-0.5, 1.4];
  - in-head dirZ clamp ±0.8 (camera_math.js:72);
  - `guardLookHorizontal` (camera_math.js:339-380, MIN_LOOK_HORIZ_M 0.5): if camera→look horizontal separation < 0.5 m, it synthesises look = cam + dir*0.5, with dir from followYaw, then the near-degenerate sign, then last good, then north. It counts `_degenerateBasisFrames`, exposed via `cameraBasisGuard()` (camera.js:1148);
  - topDown uses `up = (0,0,-1)`;
  - retailViewerStep returns fwd=null and keeps the last orientation when look == eye.
- Spring arm = `_clipCameraAgainstWorld` (camera.js:1769-1971). Pivot is player z+1.5 with a 0.3 m sphere and 0.02 skin (camRetailSphere default; legacy 1.6 / 0.5 / 0.2). Steps:
  1. terrain floor (`terrainHeightAt` + 0.7, outdoors);
  2. building AABB (opt-in);
  3. building triangles;
  4. statics;
  - 4b. scenery;
  5. EnvCell mesh over `getRenderSet(1)`;
  - 5b. cell statics;
  - 5c. BSP entities (doors; creatures exempt);
  6. `clipCameraToCellSpace` (indoor).
- Each hit sets final = start + delta*max(0, t - skin/len) (:1802-1813). Under camViewerStep, pull-in is immediate and re-extension is damped only if stiffness is set. There is NO predictive look-ahead.

(6) BEST SEAM FOR A FILM CONTROLLER
- Add a `?film=on` exact-match opt-in that installs a positionCamera wrapper in the CameraSwitcher ctor, cloning `_installCamDebug` (camera.js:1457-1465). It costs nothing when off because no wrapper is installed. Rules:
  - Keep `tick()` running: `_smoothToIntegrator` feeds the player pose to lighting, the rig and the LRU; `_dispatchMovement` feeds input.
  - Drive the SAME persp object; do not use a new camera.
  - Write position + quaternion + fov, then call `updateMatrixWorld(true)`.
  - Force follow mode.
- For in-frame consistency (cull, cell, CSM and viewer cell seeing THIS frame's pose), add a one-line pre-tick hook in index.js tick just before `tickPerFrame` (:2532-2538). Alternatively, drive with `?renderOnDemand=1`: set the pose, call `__renderOnce`, wait, capture — exactly moving_rig's applyPose→step, which works because `__cam.set` calls `updateMatrixWorld(true)` before the tick.
- Things that fight an external camera:
  - follow/topDown re-derive the pose every tick unless parked;
  - OrbitControls.update() is called by tick even when parked and always rewrites position + lookAt (OrbitControls.js:688, 786-788);
  - C toggles to topDown, which switches activeCamera to ortho;
  - autoFollow and combat tracking keep mutating followYaw, so the camera snaps on release;
  - the near-fade / in-head opacity latch persists while parked;
  - resize resets aspect and fov;
  - ?portalFovFade (opt-in) writes fov;
  - `atmospherePipeline.render(cam)` retargets only some passes on a camera-object change; ssaoPass and layeredHaze need `setCamera` (atmosphere_pipeline.js:2131-2163 vs 2236-2249);
  - dyn-LOD reads `liveScene3d.camera`.
- Follow mode uses right-drag listeners, not pointer lock.

(7) HARNESS PATH CODE
- moving_path.mjs is pure, node-side:
  - `poseTable(spec)` (:128) gives frame-indexed rows [ex,ey,ez,tx,ty,tz] in AC world metres. Modes: orbit, dolly (closed loop), hop (per-stop orbit plus an @teleloc event on each stop's first frame).
  - Also: `cellToWorld` (:56), `normalizeSpec` (:81, validates and throws), `tableChecksum` (FNV-1a over 1 mm quantisation, :192) and `realisedChecksum` (:219).
  - Its rules — pose is a function of frame index not wall clock, the table is built in node, the anchor is pinned — are exactly what a film take needs.
  - Missing for film: easing/splines, roll, a fov channel, and quaternion rows (rows are lookAt targets, so they are degenerate at vertical).
- moving_rig.mjs `movingRigSource()` (:51) installs `window.__mbench`:
  - install(payload) sets `renderer.info.autoReset=false`;
  - applyPose(k) calls `__cam.set`;
  - step() runs `__renderOnce`, then a rAF yield, then up to 3 extra yields for the async syncPhysicsTick frame;
  - run() is a warm lap then a measure lap, with a realised-pose checksum and resident-LB churn hash (`terrainBakedLbs`);
  - `_maybeEvent` sends chat (@teleloc) and waits one rAF.
  - Reusable as the film stepper plus "rehearsal lap" and "world settled" gates.
- moving-bench.mjs `buildUrl` (:198-210) is the proven URL recipe: nosw, quality=mid, adaptiveRes=off, renderScale=1, camDebug=on, vfxGauge=on, autoLogin…agent=1, plus renderOnDemand=1&netDrainHz=30. It also uses `acquireHeavyLock` (one heavy job per box).
- camset.mjs (19 lines) connects over CDP to 127.0.0.1:9333, picks the page whose URL contains "holtburger-web", calls `__cam.set(...)`, waits 400 ms, wraps `renderer.render` to `toDataURL("image/jpeg", 0.85)` after the final `getRenderTarget()===null` draw (an in-task, HUD-free canvas grab with no preserveDrawingBuffer), waits ≤3 rAF or 4 s, restores render, and releases unless `keep`. The playwright-core path is hard-coded.

Client film code must not call any Anthropic API. Claude Code drives the page over CDP (`page.evaluate`); JEV/OpenRouter belongs in the orchestration layer, not in the scene3d camera module.

## APIS
- CameraSwitcher (class) [scene3d/camera.js:408]  sig=new CameraSwitcher({scene3d, perspectiveCamera, orthoCamera, domElement, sessionHandle /*obj or ()=>handle*/, getPlayerWorldPos /*()=>{x,y,z} AC world m*/, getPlayerHeading}) :: Owns follow/topDown/orbit modes, activeCamera, keystate, follow yaw/pitch/distance, the clip chain, movement dispatch. Constructed in init3D at index.js:3652; reachable as liveScene3d.cameraSwitcher (null for ~35 s after in-world, poll first).
- CameraSwitcher.tick [scene3d/camera.js:1179]  sig=tick(dt) :: Order: _smoothToIntegrator(dt) → _updateCombatTargetTracking(dt) → _updateAutoFollow(dt) → this.positionCamera(dt) → controls.update() → _dispatchMovement(). Called from loop.js:3235 (#13).
- CameraSwitcher.positionCamera [scene3d/camera.js:1536]  sig=positionCamera(dt) :: Per-mode pose derivation from _safePlayerPos(). follow: ideal eye behind player + look point + guardLookHorizontal + _applyViewerStep/_applyStiffness/hard set + near-fade. orbit: only controls.target. topDown: ortho 300 m above, up (0,0,-1). An INSTANCE property lookup in tick(), so it can be wrapped per instance (camDebug does).
- CameraSwitcher.switchMode [scene3d/camera.js:891]  sig=switchMode(next: 'follow'|'topDown'|'orbit') :: Disposes the previous controller and per-mode DOM listeners, resets _prevEyeAc. follow → right-drag mouselook listeners, activeCamera=persp. orbit → new OrbitControls(damping 0.08), activeCamera=persp. topDown → activeCamera=ortho.
- CameraSwitcher.getActive / cameraBasisGuard [scene3d/camera.js:1137]  sig=getActive(): Camera; cameraBasisGuard(): {degenerateFrames, lastGoodDir, followYaw, followPitch, mode} :: Active render camera, and the LIVE-03 degenerate-basis diagnostic (camera.js:1148).
- window.__cam (camDebug rig) [scene3d/camera.js:1484]  sig=park(); release(); parked; set(ex,ey,ez,tx,ty,tz); orbit(tx,ty,tz,dist,azDeg,elDeg); player(dist,azDeg,elDeg,dz=1); fov(v); info(); world() :: Installed only with ?camDebug=on (exact match, camera.js:463-473). set/orbit/player imply park and write activeCamera via acToThree + up(0,1,0) + lookAt + updateMatrixWorld(true). orbit az = eye bearing from target, deg CW from north; el = deg up. fov only for perspective and does not park. info().pos is in THREE coords; info().world and world() are AC world metres (LB folded).
- CameraSwitcher._clipCameraAgainstWorld [scene3d/camera.js:1769]  sig=_clipCameraAgainstWorld(playerPos, idealX, idealY, idealZ, ctx=this._camClipContext(), terrainFloor=true) → {x,y,z} :: Spring-arm sweep chain from pivot (player z+1.5, r 0.3, skin 0.02 under camRetailSphere) to the ideal eye: terrain floor, optional building AABB, building tris, statics, scenery, EnvCell mesh over getRenderSet(1), cell statics, BSP entities, clipCameraToCellSpace. Frees each CollisionHit. All inputs in AC world metres.
- CameraSwitcher._camClipContext / _terrainFloorZ [scene3d/camera.js:1979]  sig=_camClipContext() → {handle, landblockId, indoor}|null; _terrainFloorZ(ctx,x,y,z) → z :: Clip-chain context: indoor = landblockId&0xffff >= 0x100 when ?indoorCam is on. Terrain floor = terrainHeightAt + 0.5 + 0.2 outdoors (camera.js:2006).
- CameraSwitcher._applyViewerStep / _applyStiffness [scene3d/camera.js:2073]  sig=_applyViewerStep(dt,p,ctx,idealX,idealY,idealZ,lookX,lookY,lookZ); _applyStiffness(dt,finalX,finalY,finalZ,lookX,lookY,lookZ) (camera.js:2117) :: Retail smoothing. Lerps the eye by stiffnessFrac and slerps the quaternion toward the Matrix4.lookAt(pos, look, persp.up) basis. Snaps when unseeded, frac>=1, or a jump >50 m.
- CameraSwitcher._applyCameraPlayerFade [scene3d/camera.js:2156]  sig=_applyCameraPlayerFade(opacity 0..1) :: Quantised (1/128), deduped push to entityManager.setLocalPlayerCameraOpacity(localGuid, q). Use it to hide or restore the cameraman avatar while keeping camera.js's dedupe cache coherent.
- CameraSwitcher._integratorWorldPose / getPredictedPlayerWorldPos / getPlayerWorldPosition / _safePlayerPos / setPreviewTarget [scene3d/camera.js:2621]  sig=_integratorWorldPose() → {x,y,z,landblockId}|null; getPredictedPlayerWorldPos() → {x,y,z}|null (:2704); getPlayerWorldPosition(outVec3) → THREE-frame Vector3 (:3241); _safePlayerPos() → AC {x,y,z} (:3249); setPreviewTarget({x,y,z}|null) (:3286) :: Player pose sources. AC world metres except getPlayerWorldPosition, which returns THREE coords and is rotation-invariant (used for light sorting).
- createOrthoCamera [scene3d/camera.js:368]  sig=createOrthoCamera(canvas) → OrthographicCamera :: Top-down ortho: frustum height 100 m at zoom 1, near 0.1, far 5000, layer 1 enabled. Zoom range [0.2, 8] via wheel.
- acToThree [scene3d/adapter.js:1817]  sig=acToThree(ax, ay, az) → [ax, az, -ay] :: AC world metres to THREE world coords for objects outside worldRoot (cameras, lights). Inverse: (x, -z, y).
- retailViewerStep [scene3d/camera_math.js:426]  sig=retailViewerStep(prevEye|null, idealEye, frac, sweepFn?, look?) → {sought, eye, fwd|null, snapped} :: Pure retail viewer order: smooth toward the unclipped ideal, then sweep. Reusable as a boom smoother with a pluggable collision sweep.
- guardLookHorizontal [scene3d/camera_math.js:339]  sig=guardLookHorizontal(camX, camY, lookX, lookY, fallback{x,y}, lastGood{x,y}|null) → {x, y, degenerate, dirX, dirY} :: Ensures the camera→look horizontal separation is at least MIN_LOOK_HORIZ_M=0.5 (:322). Synthesises the look point from fallback, then the near-degenerate sign, then lastGood, then north.
- stiffnessFrac / STIFFNESS constants [scene3d/camera_math.js:139]  sig=stiffnessFrac(stiffness, dt) → clamp(stiffness*dt*10, 0, 1); STIFFNESS_SNAP_DIST_M=0.0004 (:153); STIFFNESS_TELEPORT_SNAP_M=50 (:161) :: Retail frame-rate-dependent smoothing fraction.
- applyRetailFov / retailVerticalFovDeg [scene3d/camera_math.js:553]  sig=applyRetailFov(camera, gameFovDeg) → bool; retailVerticalFovDeg(gameFovDeg, aspect) → deg|null (:542) :: Retail fovY = gameFov/(aspect-0.1). The caller must call updateProjectionMatrix.
- trackedTargetYaw / inPlaceTurnYawDelta [scene3d/camera_math.js:479]  sig=trackedTargetYaw(pivot{x,y}, target{x,y}) → atan2(dx,dy)|null; inPlaceTurnYawDelta(prevH, h, {moved,keyed,dragging}) (:464) :: Compass-bearing yaw toward a target, in followYaw convention.
- readLocalPlayerPose / beginPoseFrame / endPoseFrame [scene3d/frame_pose.js:68]  sig=readLocalPlayerPose(handle) → frozen {x,y (LB-local 0..192), z, heading (CCW yaw; compass=-yaw), landblockId, isOnGround}|null :: One wasm crossing per tickPerFrame window. Frees the wasm box. Keyed on __wbg_ptr so the Proxy'd window.__sessionHandle shares the snapshot.
- tickPerFrame [scene3d/loop.js:2780]  sig=tickPerFrame(scene3d, sessionHandle, dt) :: Whole per-frame sim/visibility/camera/entity pass (body :2789-3462). Called by index.js tick (:2538) and by the ?netDrainHz interval (:3047).
- tickFrustumCull / FrustumCuller.update [scene3d/culling.js:271]  sig=tickFrustumCull(scene3d) → FrustumCuller|null; FrustumCuller.update(camera, worldRoot) (:154) :: AC-space frustum from camera.projectionMatrix · camera.matrixWorldInverse · worldRoot.matrixWorld. Culls statics and entities per object; terrain is opt-in. Exported, so it could be re-run after a late camera write.
- tickCellVisibility3D / updateViewerCell [scene3d/cells.js:2926]  sig=tickCellVisibility3D(scene3d, sessionHandle); updateViewerCell(scene3d, handle, playerCell, playerIndoor) (internal, :2849) :: Resolves the viewer cell by sweeping player head → camera eye, then calls setViewerCell. Builds the render set from getRenderSetWithFrustum ∪ getRenderSetWithPView using the camera MVP. Flips cell/group visibility.
- wasm resolveViewerCell / setViewerCell / getViewerCell / getViewerRenderSet [pkg/holtburger_web.d.ts:5983]  sig=resolveViewerCell(from_x,from_y,from_z,to_x,to_y,to_z,radius,player_cell) → u32; setViewerCell(cell) (:6395); getViewerCell() (:4820); getViewerRenderSet() (:4825) :: Viewer-cell walk (Rust scene.rs:5673: 0.25 m steps, max 256). Seed cell plus a from-point inside it gives cur_cell continuity, so a film controller could carry its own cell by calling it with prevEye → eye and seed = previous film cell.
- wasm getRenderSetWithFrustum / getRenderSetWithPView / getRenderSet / getCurrentCellId [pkg/holtburger_web.d.ts:4575]  sig=getRenderSetWithFrustum(mvp: Float32Array[16] col-major) → Uint32Array; getRenderSetWithPView(mvp, max_depth=0) (:4614); getRenderSet(depth) (:4541); getCurrentCellId() (:4266) :: Camera-MVP cell visibility, rooted at the current or viewer cell. Outdoor case: all loaded EnvCell AABBs in the frustum.
- wasm camera sweeps [pkg/holtburger_web.d.ts:6505]  sig=sweepSphereAgainstBuildingMesh(f…,t…,r,lbId); sweepSphereAgainstStatics(…,lbId) (:6611, 3×3 ring); sweepSphereAgainstScenery(…,lbId) (:6598, 3×3); sweepSphereAgainstCellMesh(…,cellIds: Uint32Array) (:6522); sweepSphereAgainstCellStatics(…,cellIds) (:6540); sweepSphereAgainstEntities(…,r,max_range_m) (:6565, BSP-only, creatures exempt); sweepSphereAgainstObjects(…,r,missile_guid,exempt_local_player) (:6585); cameraSweepCollision(…,lbId) (:3496); clipCameraToCellSpace(…,r,start_cell) → t|undefined (:3621); terrainHeightAt(x,y) → z|undefined (:6652) :: AC world-metre collision and line-of-sight primitives. Return CollisionHit {t, x, y, z, normalX/Y/Z} (d.ts:752-781), which must be .free()'d.
- index.js window.__renderOnce [scene3d/index.js:3007]  sig=window.__renderOnce() → bool :: Runs tick(performance.now()) once: sim + render. Async under default ?syncPhysicsTick, so it returns before the frame completes. With ?renderOnDemand=1 this is the only frame driver besides an optional netDrain interval.
- index.js window.__setRenderScale / __setGameFov [scene3d/index.js:1268]  sig=__setRenderScale(n in (0,2]); __setGameFov(deg) (:1634, only with ?retailFov=on) :: Live pixel-ratio scale (rebuilds composer and cloud RTs) and retail game FOV.
- atmospherePipeline.render / setCamera [scene3d/atmosphere_pipeline.js:2131]  sig=render(cam, dt=0); setCamera(cam) (:2236); preFrameSkySync(skyDome, mainCamera, atmosphereSky) (:1904) :: render() retargets world/cells/aerial/mask/fx passes ONLY when the camera OBJECT changes (and not ssao/haze). setCamera() also retargets ssaoPass and layeredHaze.
- skyDome.syncSkyCamera / tick [scene3d/sky_dome.js:711]  sig=syncSkyCamera(mainCamera); tick(dt, camera) (:610) :: Sky camera copies position/quaternion/fov/aspect each frame before the composer render. tick re-centres skyCell on the camera, but runs in the RP3 SKY group before the camera tick.
- updateCsm [scene3d/csm.js:412]  sig=updateCsm(csmState, camera, sunDir?) :: Fits 3 cascades (30/100/300 m) to the active camera. Skips when pos<1e-4 m², rot<2e-6 and the projection is unchanged. Calls camera.updateMatrixWorld/updateProjectionMatrix. Reads camera.userData.csmFitFov (:393).
- EntityManager.setLocalPlayerCameraOpacity / getLocalPlayerWorldPos [scene3d/entities.js:18991]  sig=setLocalPlayerCameraOpacity(guid, opacity 0..1); getLocalPlayerWorldPos() → AC {x,y,z} (:15818, prefers cameraSwitcher.getPredictedPlayerWorldPos) :: Hide the local avatar (hierarchical, includes held items). Player position for lighting, shadow gate and similar systems.
- three Matrix4.lookAt (degenerate up) [node_modules/three/build/three.core.js:10306]  sig=Matrix4.lookAt(eye, target, up) :: If up × z is exactly zero it nudges z.z += 0.0001 (or z.x if |up.z|==1), giving a fixed north-up basis straight down and south-up straight up with up=(0,1,0). Object3D.lookAt (:12382) is used by all camera code.
- poseTable / cellToWorld / tableChecksum [harness/lib/moving_path.mjs:128]  sig=poseTable(spec{mode:'orbit'|'dolly'|'hop', frames, anchor{x,y,z}, dist, el, elAmp, elPeriod, az0, laps, dz, hops[{cell,x,y,z}], dwell}) → {spec, rows[[ex,ey,ez,tx,ty,tz]], events[], checksum}; cellToWorld(cell,lx,ly,lz) (:56); tableChecksum(rows, events) (:192) :: Deterministic frame-indexed camera path tables in AC world metres, with hop events (@teleloc) and a 1 mm-quantised FNV checksum.
- movingRigSource / window.__mbench [harness/lib/moving_rig.mjs:51]  sig=page.evaluate(movingRigSource()); __mbench.install({spec,rows,events,warmFrames,drive}); applyPose(k); realisedEye(); step(); run(); _maybeEvent(k) :: In-page stepper: __cam.set per row, then __renderOnce, then rAF yields that tolerate the async tick. Warm and measure laps, realised-pose checksum, resident-LB churn hash.
- camset.mjs [/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/scripts/perf-worker/coldboot/camset.mjs:1]  sig=node camset.mjs ex ey ez tx ty tz out.jpg [keep] :: CDP 127.0.0.1:9333 still-shot: __cam.set, then a 400 ms settle, then capture via a renderer.render wrap with toDataURL after the final null-target draw, then release unless keep.
- moving-bench buildUrl [harness/moving-bench.mjs:198]  sig=buildUrl(arm) → URL string :: Proven headless URL: nosw=1&quality=mid&adaptiveRes=off&renderScale=1&renderDiag=on&camDebug=on&vfxGauge=on&autoLogin=1&account=X&password=X&autoSpawn=first&agent=1 [+renderOnDemand=1&netDrainHz=30]. main() uses acquireHeavyLock and a __bootStateHistory gate.
- ParticleManager RP6 emitter sphere test [scene3d/particles/particle_manager.js:1239]  sig=_rp6ShouldCull(emitter, camera) (module-private) :: Emitter obstruction sphere = emitter.parent.getWorldPosition() (THREE coords), radius = emitter.info.sortingSphere.radius + |emitter.parentOffset.position|. Basis for a particle-obstructs-lens test. Managers: entityManager._worldParticleManager (entities.js:14588), scene3d._staticParticleManager (statics.js:4986).

## SEAMS
- [scene3d/camera.js:1460] positionCamera instance override (camDebug pattern): ctor-time wrapper replacing this.positionCamera, gated on an exact-match URL flag => Install under ?film=on. Wrapper: if film active, call film.apply(dt, this.persp) and skip follow/orbit/topDown re-derivation; otherwise call the original. Costs nothing when off because no wrapper exists. Keep tick() itself running: _smoothToIntegrator feeds player pose to lighting, rig and LRU; _dispatchMovement feeds input. Runs at loop #13, before entity tick and render.
- [scene3d/index.js:2537] Pre-tickPerFrame insertion point in index.js tick (after frameTime is stamped, before tickPerFrame) => Proposed one-line hook such as `liveScene3dRef.film?.preFrame(ts, dt)`. Writing the camera here lets cell visibility/viewer cell (#1), frustum cull (#1.5), CSM fit (#5) and sky (#7-12) see THIS frame's pose instead of last frame's. Required for clean hard cuts without throwaway frames. Off cost is one optional-chain property read.
- [scene3d/index.js:3007] window.__renderOnce external stepping (renderOnDemand) => Deterministic frame-indexed capture: set pose (updateMatrixWorld(true)), call __renderOnce, wait for the async frame, then capture. tick(nowTs) already accepts a timestamp, so a proposed __renderOnce(tsMs) variant would give a fixed film dt (=1/fps < 0.1 clamp) for mixers and sky.
- [scene3d/index.js:2360] _postRenderStreamSlot: every render exit (composer, direct, nullRender, portal-space) passes through it right after GL submission => Natural internal post-render hook site, e.g. film.postRender(renderer), for in-task canvas readback (toDataURL/readPixels/captureStream frame request) without preserveDrawingBuffer. The external alternative is the camset.mjs renderer.render wrap.
- [scene3d/cells.js:2849] cells.js updateViewerCell: viewer cell = resolveViewerCell(player head → camera eye, seed player cell) then setViewerCell => Add an override so a free film camera carries its own viewer cell: resolveViewerCell(prevEye → eye, r, seed = previous film cell), then setViewerCell. Without it, dungeon shots away from the player's straight-line line-of-sight root the PView/BFS walks in the wrong cell and rooms vanish.
- [scene3d/index.js:2722] cameraSwitcher.activeCamera / liveScene3d.camera (persp) as the single render camera => Drive the existing persp object; do not introduce a new camera. Composer retarget, SSAO/haze camera refs and dyn-LOD (liveScene3d.camera) all assume this object. Force switchMode('follow') when film takes over.
- [scene3d/camera.js:2156] Local avatar opacity => cs._applyCameraPlayerFade(0) hides the cameraman character in shots (and 1 restores it), keeping camera.js's dedupe cache coherent. It wraps entityManager.setLocalPlayerCameraOpacity (entities.js:18991).
- [pkg/holtburger_web.d.ts:6505] wasm collision and line-of-sight sweeps plus clipCameraToCellSpace and terrainHeightAt => Film boom and obstruction checks. Subject-pivot → eye sphere sweeps for walls between subject and lens; prevEye → nextEye for collision-free dolly/drone moves; clipCameraToCellSpace to keep dungeon fly-throughs inside cell space; terrainHeightAt for terrain clearance. Pass the landblock and cell ids of the CAMERA segment (not the player's). Free each CollisionHit.
- [scene3d/camera_math.js:426] retailViewerStep + guardLookHorizontal pure math => Reusable boom smoother (smooth-then-sweep with immediate pull-in and damped re-extension) and horizontal-basis guard. The pure module is node-testable (tests/camera_retail_math.test.cjs pattern), so film_camera.js math should live in a similar import-free module.
- [scene3d/particles/particle_manager.js:1239] Particle emitter obstruction sphere (RP6) => Test whether an emitter sphere (anchor world pos, radius sortingSphere.radius + |parentOffset|) intersects the near-plane region or the subject→lens segment, so the director can avoid lens-filling particles. Emitters also freeze while culled, rechecked every 6 ticks, so pre-roll after cuts.
- [scene3d/csm.js:393] camera.userData.csmFitFov => During dolly zooms or extreme FOV, park a game fov here so CSM cascades keep fitting a sane frustum. portal_space.js already uses this trick.
- [harness/lib/moving_path.mjs:128] Frame-indexed path tables + in-page stepper => Template for film take tables (rows indexed by frame, built in node, anchor pinned, checksum of intended vs realised path, hop events for @teleloc between shots). Extend rows to eye + quaternion/yaw-pitch-roll + fov. Pair with moving_rig.mjs's step/warm-lap/LB-churn gates.
- [scene3d/index.js:2532] scene3d.frameTime => The film controller's per-frame clock {tsMs, tsSec, dt}. Note it is frozen between __renderOnce calls and is not stamped by the netDrain interval.
- [scene3d/index.js:1268] window.__setRenderScale => Supersample captures up to 2x pixel ratio. Pin ?renderScale=N in the URL so the adaptive controller cannot change resolution mid-shot.

## HAZARDS
- [scene3d/loop.js:2879] One-frame camera lag for everything before the camera tick. tickCellVisibility3D (#1, viewer cell + render set), tickFrustumCull (#1.5), CSM fit and light sort (#5) and the sky stack (#7-12) run BEFORE cameraSwitcher.tick (#13), reading camera.matrixWorldInverse from the previous render. On a hard cut the first frame is culled and visibility-tested against the previous shot. || mitig: Pose the camera before tickPerFrame (proposed pre-tick hook, or external __cam.set-style write + updateMatrixWorld(true) before __renderOnce). Otherwise render 1-2 discard frames after every cut.
- [scene3d/loop.js:3263] Subject tracking lags one frame: remote entity poses, mixers and particles update in entityManager.tick AFTER the camera tick, so a camera aimed at an NPC uses last frame's position. The local player under default ?rustPose reads the current wasm pose. || mitig: Extrapolate subject position by its velocity × dt, or do a small post-entity re-aim pass. Avoid jittery look-at by smoothing the target point.
- [scene3d/cells.js:2860] Viewer cell is resolved by sweeping from the PLAYER's head to the camera eye (seed = player cell). A void exit keeps the last reached cell. A film camera in a dungeon room not straight-line reachable from the player gets the wrong viewer cell, so PView/BFS walks are rooted wrong and cells disappear. || mitig: Viewer-cell override seam carrying the film camera's own cell via resolveViewerCell(prevEye→eye, seed=prev film cell), or keep the cameraman player in the filmed room.
- [scene3d/index.js:6596] Player-centred systems: streaming/LRU (player rig LB, index.js:6596), PVS expansion (player render set), far ring (far_terrain.js:1070), grass pool re-centred on the player (terrain_grass.js:19-24), shadow-receive gate 80 m around the player (loop.js:2478, buildings.js:262), single-shadow frustum recentred on the player (lighting.js:1662), light pool cell mode (player BFS + player ref point, lighting.js:2001). Shots far from the player lose content, grass, received shadows and lights. || mitig: Move the cameraman character (@teleloc/@telepoi) to each shot location and wait for streaming (resident-LB hash stable) before rolling; hide the avatar with _applyCameraPlayerFade(0).
- [scene3d/entities.js:2887] Camera-distance gates: entity animation freezes beyond 120 m from the camera (?maxTickDist); particle emitters culled beyond 220 m or out of frustum, decision re-evaluated only every 6 ticks (newly visible emitters can stay frozen up to ~6 frames after a cut or fast pan); dynamic entity LOD respawns rigs on band crossings at 2 Hz (visible pop during dollies). || mitig: Raise ?maxTickDist for wide shots, use ?dynLod=off for hero shots, and pre-roll ≥6 frames after cuts.
- [node_modules/three/build/three.core.js:10323] lookAt degeneracy: three r184 Matrix4.lookAt nudges z by 1e-4 when up is exactly parallel to the view, so straight-down snaps to a north-up basis and straight-up to south-up regardless of approach yaw. Passing through vertical flips the image. __cam.set always resets up=(0,1,0) and has no roll. || mitig: Film controller builds the quaternion directly (yaw/pitch/roll Euler 'YXZ' or a parallel-transported up vector) and never calls lookAt near ±90°. Interpolate orientations with quaternion slerp/squad.
- [scene3d/camera.js:1190] OrbitControls.update() is called by CameraSwitcher.tick every frame even while camDebug-parked, and always rewrites camera position and lookAt. Park therefore does not hold in orbit mode. The C key toggles to topDown (activeCamera=ortho); __cam.set would then move the ORTHO camera. || mitig: Film mode forces switchMode('follow') and ignores or blocks the C mode toggle while active.
- [scene3d/atmosphere_pipeline.js:2131] Introducing a separate camera object breaks things: atmospherePipeline.render(cam) retargets only world/cells/aerial/mask/fx passes on an object change (ssaoPass/layeredHaze only via setCamera); fx retarget can recompile on a type change; dynamic LOD reads liveScene3d.camera; CSM/culling read activeCamera. || mitig: Drive the existing persp camera object only.
- [node_modules/postprocessing/build/index.js:5122] Near/far must not be animated: pmndrs EffectMaterial.copyCameraSettings copies cameraNear/cameraFar BY VALUE only when mainCamera is set (projection matrices are by reference), and EffectPass.render never re-copies. Changing near/far mis-decodes depth for aerial perspective, horizon dissolve and heat haze. || mitig: Keep near=0.1/far=5000. Animate only fov via updateProjectionMatrix, which is safe.
- [scene3d/camera.js:286] Wide FOV vs collision radius: the clip chain's 0.3 m viewer sphere covers the 0.1 near-plane corner only at moderate FOV (comment camera.js:286-288). At ~120° vertical, 16:9, the corner sits ~0.37 m out (my calculation), so the near plane can poke through walls in tight dungeons. || mitig: Film collision radius ≥ near·sqrt(1 + tan²(fovY/2)·(1+aspect²)) + skin.
- [scene3d/index.js:1298] Adaptive resolution (default ON) changes renderScale mid-take when frames drop. || mitig: Pin ?renderScale=N (also disables adaptive) or ?adaptiveRes=off. It is already off under renderOnDemand/nullRender.
- [scene3d/index.js:2497] Time base is wall-clock: dt=min(raw,0.1), with a recovery freeze (dt=0 for 10 frames after a >0.5 s gap, disabled under renderOnDemand). __renderOnce uses performance.now(). ?netDrainHz runs the FULL tickPerFrame (camera + animation) between renders. RP3 throttles, shadow gate, IBL and particles use live performance.now(). wasm physics self-measures time. Offline capture therefore cannot be fully deterministic. || mitig: For live footage use real-time capture on the 1070 with ?targetFps. For offline, add a ts-param __renderOnce and avoid netDrainHz during takes; accept that world sim is wall-clock.
- [scene3d/index.js:3002] tick is async under default ?syncPhysicsTick, so __renderOnce returns before the frame finishes. || mitig: Wait rAF/microtasks (moving_rig step() pattern) or capture from inside the post-render slot.
- [scene3d/index.js:1869] Resize resets camera.aspect and, under ?retailFov, recomputes fov; agent-mode canvas tracks the window size (≤4096×2160). || mitig: Fix the CDP window size before takes and re-assert the film fov after any resize.
- [scene3d/camera.js:1218] Parked-camera side effects: autoFollow and combat-target tracking keep mutating followYaw while parked (snap on release); the near-fade/in-head opacity latch persists while parked (player may stay ghosted or invisible). || mitig: On film release set _prevEyeAc=null, call _applyCameraPlayerFade(1), and optionally restore the saved followYaw/followPitch.
- [scene3d/speech_bubble.js:20] In-canvas overlays end up in canvas captures: speech bubbles are always-on THREE.Sprites (no flag); nameplate sprites are default OFF but ?nameplates=on enables them (?hud=none forces off); portal space hides the world and shows a tunnel after every teleport (default on), plus a WORLD_FADEIN overlay. || mitig: Use ?hud=none; add a film flag to suppress speech bubbles; gate takes on portal space having ended.
- [scene3d/camera.js:19] Doc trap: the camera.js header claims camera positions are AC coords. They are THREE coords (acToThree). __cam.info().pos is THREE, while world() is AC. || mitig: Always convert with acToThree / threeToAc (x,-z,y).
- [scene3d/frame_pose.js:68] Wasm boxes leak if not freed: getLocalPlayerPose() and CollisionHit are wasm-bindgen boxes. || mitig: Use readLocalPlayerPose inside the tick; call .free() on every hit after copying .t/.x/.y/.z.
- [pkg/holtburger_web.d.ts:6505] Sweep scoping: building-mesh sweep reads only the given landblock; statics/scenery widen to that landblock's 3×3 ring; cell sweeps need explicit cell id lists; sweepSphereAgainstEntities is BSP-only (creatures never block). || mitig: For film segments pass the camera segment's landblock (floor(x/192)<<24 | floor(y/192)<<16) and viewer render-set cells. Use sweepSphereAgainstObjects or JS entity spheres for creature obstruction.
- [scene3d/csm.js:59] CSM far cascade ends at 300 m from the camera, so aerial/drone wides lose shadows beyond that; CSM refits and re-rasters every frame the camera or fov moves (GPU cost). || mitig: Accept or tune splits for aerial takes; budget GPU on the 1070.
- [scene3d/index.js:1554] No floating origin: absolute AC world coords up to ~49 km live in THREE space. float32 ulp is ~4 mm at the map edge (my estimate), relevant only to shaders that compose modelMatrix then viewMatrix separately. || mitig: Usually negligible; watch for shimmer in custom shaders at far-east/north landblocks.

## DATA

## RECS
- Implement the camera math as an import-free module, e.g. scene3d/film_camera.js (node-testable like camera_math.js): rig state (eye, quaternion, fov, roll), spline/ease evaluators, drone moves. Write orientation directly as a quaternion, e.g. camera.rotation.set(-pitchDown, -bearing, roll, 'YXZ'), which gives AC forward (cos p·sin b, cos p·cos b, -sin p) per my derivation. Never use lookAt near ±90°, so straight-down tilts and right-angle corridor turns are continuous; slerp/squad between keyframe quaternions.
- Install the controller only under an exact-match `?film=on`, via a ctor-time positionCamera wrapper exactly like _installCamDebug (camera.js:1457-1465). Keep CameraSwitcher.tick running, drive the existing persp camera object, force switchMode('follow'), and call persp.updateMatrixWorld(true) after each write.
- Add a one-line pre-tick hook in index.js tick before tickPerFrame (:2537) so visibility, cull, CSM, viewer cell and sky see the current pose. For offline takes, drive with ?renderOnDemand=1: set pose, call __renderOnce, wait, capture (moving_rig pattern), and consider adding a ts parameter to __renderOnce for a fixed film dt.
- Add a viewer-cell override seam in cells.js updateViewerCell so a free film camera carries its own cell through portals via resolveViewerCell(prevEye→eye, seed=prev film cell). Validate dungeon dolly segments with clipCameraToCellSpace before shooting.
- Build the obstruction model from the existing primitives:
- wasm sweeps from subject pivot to eye, and prevEye to nextEye, passing the camera segment's landblock/cells;
- terrainHeightAt for clearance;
- sweepSphereAgainstObjects or JS entity spheres for creatures;
- RP6 emitter spheres (anchor + sortingSphere.radius + |parentOffset|) for particle effects in front of the lens.
Use a collision radius ≥ the near-plane corner distance at the shot FOV.
- Treat the cameraman character as a streaming anchor: @teleloc/@telepoi it near each shot, wait until portal space ends and the resident-LB hash (liveScene3d.terrainBakedLbs) stops changing, then hide it with cs._applyCameraPlayerFade(0) and restore it after the take.
- Capture URL recipe, starting from moving-bench buildUrl: nosw=1, agent=1, hud=none, autoLogin…, camDebug/film flag, renderScale=1 or 2 (pins resolution and disables adaptiveRes), maxTickDist raised for wides, dynLod=off for hero shots, and frameBudget=off so sky/PVS do not defer. Avoid netDrainHz during deterministic takes because it advances animation between renders.
- Grab frames in-task right after the final canvas draw (camset.mjs renderer.render wrap, or a film.postRender call in _postRenderStreamSlot) so DOM HUD is excluded and preserveDrawingBuffer is not needed. Prefer canvas.captureStream/MediaRecorder or async readPixels over per-frame JPEG toDataURL for video.
- Animate only fov for dolly zoom (fov + updateProjectionMatrix; distance = subjectHeight/(2·tan(fov/2))), and set camera.userData.csmFitFov during extreme FOV. Never animate near/far (pmndrs copies them by value).
- After every hard cut, render at least 6 discard or pre-roll frames: RP6 particle recheck interval is 6 ticks, PVS/SKY throttle at 10 Hz, CSM refit and shadow re-raster.
- Reuse moving_path.mjs principles for take tables: frame-indexed rows built in node, pinned anchors, intended-vs-realised checksums, hop events for teleports. Extend rows with quaternion/yaw-pitch-roll and fov channels, and reuse moving_rig's warm 'rehearsal' lap to stream and compile before the recorded lap.
- Film capture runs in headless Chrome, which is a heavy job: one at a time, under capped-build/acquireHeavyLock, and real-GPU takes only on the 1070, off-screen. Client film code makes no Anthropic API calls; the Claude Code session drives it over CDP (page.evaluate on a window.__film API); JEV/OpenRouter calls belong to the orchestration layer.

## OPENQ
- Is a one-line pre-tick hook in index.js tick() acceptable, versus living with a one-frame cull/visibility lag plus discard frames after cuts?
- What should the deterministic-time strategy be? tick(nowTs) supports a synthetic timestamp, but RP3 throttles, particles (unless ?particleClock=sim), wasm physics (self-measured) and network events stay on wall clock.
- Does the takram AerialPerspectiveEffect read camera projection and world matrices per frame (FOV animation safe)? Its source in vendor/takram is unread.
- sky_dome.js tick reads session.isCurrentCellIndoor() (line ~619). Is that the player's cell or the setViewerCell-rooted viewer cell inside wasm? It matters for sky and weather when a film camera is indoors and the player is not, or the reverse.
- What is the ParticleManager emitter iteration API (field names for live emitters) for building a particle-obstruction query? Unread.
- Does sweepSphereAgainstBuildingMesh with a non-player landblock id return hits for every resident landblock, i.e. is populateBuildingAabbsForLandblock run for all resident LBs or only near the player? Unverified in Rust.
- resolveViewerCell clamps at 256 steps, so segments over 64 m use steps coarser than 0.25 m. Is that acceptable for a carried film cell across fast drone moves, or should the controller sub-step?
- Should speech-bubble sprites get a film/hud suppression flag? They are always-on with no gate today.
- Should film mode reuse ?camDebug's window.__cam surface (extending set() with roll and a quaternion API), or get a separate window.__film namespace?

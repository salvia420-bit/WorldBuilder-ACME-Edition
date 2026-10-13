# PARTICLES/VFX, ATMOSPHERE, TIME OF DAY, WEATHER, POST-PROCESSING LOOK, CLOCKS (holtburger-web scene3d)
Paths below are relative to HB (apps/holtburger-web) unless they start with external/. Everything listed is reachable from page JS via CDP Runtime.evaluate, so none of it needs the Anthropic API.

1) PARTICLE RUNTIME AND ENUMERATION FOR OBSTRUCTION SCORING
- There are two ParticleManager instances.
  - World manager: `window.liveScene3d.entityManager._worldParticleManager`. Created at scene3d/entities.js:14588 with scene = entitiesGroup. It holds entity, PlayEffect and cast emitters.
  - Static manager: `scene3d._staticParticleManager`, created at scene3d/statics.js:4986 with scene = staticsGroup. It holds default_script fountains, braziers, torches, the foliage ambient emitters, the sky chain and the terrain families. It is stamped on the internal `scene3dForBuilders` facade, so it is often NOT present on `window.liveScene3d` (see the facade check at scene3d/index.js:4920-4924).
- `_allManagers` (scene3d/particles/particle_manager.js:1337) is module-private. The reliable discovery path is the owner facade `ownerRegistry` (scene3d/particles/owner_registry.js:549, default ON):
  - `_owners`: Map ownerKey → {ids: Map<emitterId, manager>, scoped, pending}.
  - `_byMgr` (line 185): WeakMap manager → Map<emitterId, ownerKey>, giving an O(1) reverse owner lookup.
  - Reach it with `await import('./scene3d/particles/owner_registry.js')`. index.html imports scene3d/index.js with a `?v=` query, but the submodules resolve to canonical URLs, so the import returns the same module instance.
- Owner keys:
  - an entity guid (a number); PlayEffects register under the TARGET's guid;
  - `static:<lbKey decimal>` for outdoor and cell default_script anchors (vfx/particle_attach.js staticOwnerKeyForLb);
  - `static:<seq>` as the fallback;
  - `sky:<pesId>` for the camera-following sky chain;
  - `static:<lbKey>:volcano|swamp|…` for the terrain families.
- Static anchors are THREE.Group objects under staticsGroup with `userData {isStaticScriptAnchor, defaultScriptId, landblockId, particleOwnerKey, [isCellStaticScriptAnchor, cellId]}` (scene3d/statics.js:5433, :5574).
- Per manager, `mgr.particleTable` is a Map<id, ParticleEmitter> (particle_manager.js:1420). Per emitter:
  - `parent`: the anchor Object3D (entity rig or static Group).
  - `partIndex`, and `parentOffset.position/quaternion` (the static offset).
  - `info`: a ParticleEmitterInfo with `id` (the 0x32 DID), `hwGfxObjId`, `emitterType`, `particleType`, `birthrate`, `maxParticles`, `initialParticles`, `totalParticles`, `totalSeconds`, `lifespan`, `lifespanRand`, `minOffset/maxOffset`, `a/b/c`, `minA/maxA`, `startScale/finalScale`, `startTrans/finalTrans`, `isParentLocal`, `billboard`, `fxProfile`, and `sortingSphere.radius = max(maxOffset, maxA*lifespan)` (particle_emitter_info.js:125-138). The sphere ignores the B and C acceleration terms, so it underestimates gravity arcs and fountains.
  - `numParticles`, `stopped`.
  - `parts[i]`: the live slot meshes. `mesh.position` and `mesh.scale` (setScalar, lerped startScale→finalScale) are in `_scene`-local space; `mesh.userData.__op` is the opacity (1−translucency).
  - `particles[i].lifetime/lifespan`.
  - `_baseIsAdditive`: true means additive glow, drawn UNFOGGED (particles/additive_fog.js); false means alpha smoke (`_instAlpha`, alphaTest 0.1, depthWrite on, sorted back to front).
  - `skyGlow`: true for kilometre-scale sky sheets; exclude these.
  - `_instKey` (the gfxobj bucket), `renderLayer` (0 = world, 1 = indoor), `_rp6Culled`, `degradeDistance`, `_forceDegrade`, `_bbMode`.
  - A persistent emitter is one with `info.totalParticles==0 && totalSeconds==0`.
  - A projectile anchor has `parent.userData.__ballistic`.
- Coordinates: `_scene` is entitiesGroup or staticsGroup under worldRoot (rotation.x = −π/2, scene3d/index.js:1552-1562), so `_scene`-local is the AC frame (Z up, metres).
  - The default path is the instanced path (`?particleInstancing` and `?particleInstancingAlpha` are both ON). There, slot meshes are DETACHED transform carriers (onMeshActive = _NOOP).
  - For a particle's world position, use `mgr._scene.localToWorld(v.copy(mesh.position))`. `mesh.getWorldPosition` returns AC-local coordinates, and `__diag.probeNearestParticle` (scene3d/index.js:4707) has exactly this bug.
  - The anchor's world position is `parent.getWorldPosition()`; the cull adds `parentOffset.position.length()` to the radius.
  - Particle size = `geometry.boundingSphere.radius × mesh.scale.x`. The geometry is shared per gfxobj (`emitter._instGeom`).
- Classification oracle: data/particle-fx-catalog.json maps every 0x32 DID to {family, behavior, note, params incl. nearFade, surface, gfx}.
  - 2051 emitters in 44 families (fire, flame_tongue, smoke_dark, smoke_add, smoke_light, gas_alpha, mist_*, star, glow_orb, …).
  - 11 behaviours: swarm, standing, burst, trail, flash, plume, stream, fountain, implode, puff, drift.
- Visual extent that is NOT in particleTable: fxKids GPU children (`mgr._kids`), PlayEffect placeholder bursts (the `_activeBursts` Map in play_effect_vfx.js:573 is private and short-lived), fxLights point lights, fxDistort screen warp, the fxGlow halo buffer, fxDecals, and ground fog cards.

2) SUPPRESSING PARTICLES (NEAR FADE AND PER-EMITTER HIDE)
- Near fade:
  - It exists only per profile row, on the instanced FX shader: `if (vFxD.y>0) fxA *= smoothstep(0.35*nearFade, nearFade, clipW)` (particles/particle_fx.js:1002).
  - Catalog nearFade values are small (2000 of 2051 are >0, max 3.0 m, typically ≈0.2 m).
  - There is no global floor or override. Soft particles apply only in the late particlesOverClouds pass.
- Per-emitter cull authority is RP6 inside `_tickLatched` (particle_manager.js:2156).
  - The cull is re-evaluated every 6 ticks (line 171) against the frustum and a 220 m cap (line 177, `slack = 220 + radius`).
  - A culled emitter:
    - skips `_appendInstances` (its instances vanish that tick);
    - has its per-mesh slots hidden on every tick;
    - is frozen if persistent (thawed on re-entry);
    - virtual-emits if finite, and a count-bounded one is force-stopped after 30 s culled.
  - Hide hack: set `e._forceDegrade = true; e.degradeDistance = 0`, plus `e._rp6Culled = true` so it takes effect immediately. `_rp6ShouldCull` (line 1239) ORs in the degrade term. Restore with the saved values (the defaults are `Infinity`/`undefined`).
  - Ballistic anchors return before that term, so they cannot be hidden this way.
- Render-only hide (the simulation keeps running) exists only as the cell gate: `?particleCellGate=on` or `__setParticleCellGate(true)`. It applies to static anchors with `userData.cellId`, through `mgr._cellLookup`.
- Kill controls:
  - `mgr.stopParticleEmitter(id)` (line 2730) stops gracefully.
  - `mgr.destroyParticleEmitter(id)` (line 2739) removes immediately.
  - `ownerRegistry.stopSome`, `destroySome` and `destroyAllForOwner` work per owner.
- Bucket-level hide: `mgr._instBuckets` (key `${gfx}|${layer}[|a][|sky]` → {im, n, alpha}). `im.visible = false` hides every emitter sharing that gfxobj, but the fxGlow twin still draws (vfx/fx_glow_effect.js:139 checks ancestors only).
- Global switches:
  - `__particlesOverClouds.set(false)`
  - `__particleFx(false)` (neutral rows)
  - `__additiveFogBlack('retail'|'fade'|'off')`
  - `__setParticleInstancing(on)`
  - `?particleBillboard=off`

3) TIME OF DAY AND WEATHER
- Sky clock (wasm):
  - `SessionHandle.getSkyState()` → src/lib.rs:23531 `evaluate_sky_now()` reads JS `Date.now()` (wasm-bindgen glue calls the global at call time).
  - The evaluator (external/holtburger/crates/holtburger-world/src/sky.rs) computes `world_time = (now − anchor) + zero_time_of_year`.
  - The anchor is the server PortalYearTicks from ConnectRequest and every TimeSync, forward-only, under `?skyServerClock` (default ON). `=off` uses the legacy 1999-11-02 wall anchor.
  - `day_length` = 7620 s (11.34× compression).
  - `timeOfDayNormalized` ∈ [0,1); ×24 gives the hour, and 0.5 is Midsong.
  - The DayGroup (weather/sky set) comes from an LCG on (day, year).
  - The authored sun never sets: dirPitch floors at 0.9° from 23:02 to 03:50h and peaks at 90° at 14:40h. `?nightRamp` remaps elevation to −14° for the sky only.
- Runtime overrides:
  - `__sessionHandle.setSkyTimeOverride(t)` (d.ts:6366). NaN clears it. It returns false until `populateSkyDescFromRegion` has run, and is lost when EnteredWorld replaces the evaluator.
  - `setGameDayOverride(day, year)` (d.ts:6276) forces the DayGroup; `(0xFFFFFFFF, 0xFFFFFFFF)` clears it.
  - Read-backs: `getSkyPortalTicks`, `getSkyObjectStates` (weather objects have props & 0x04), `derethCalendarAt`.
- `?skytime` (index.html:6311-6345, driven in pumpNetFrame at :6487-6512):
  - `accel` gives a 5-minute day via a per-pump override.
  - A number (hour 0-24, or a 0-1 fraction) is a one-shot sticky pin (`window.__skyTimePin`).
  - With no `?skytime`, the Always-daylight driver (CharacterOption 0x05, always_daylight.js:82) pins 0.5 on every 250 ms poll and NaN-clears on the off edge. It will fight a runtime override.
- Time-lapse is possible by calling `setSkyTimeOverride` each frame, with these caveats:
  - The RP3 SKY group (terrain sun push, `skyLightingController._lastState` snapshot, fog colour and band, atmosphereLights, atmosphereSky, skyDome, weather) runs at 10 Hz on the wall clock (loop.js:2667, :2995). `?frameBudget=off` or `?deferHz=60` makes it run every frame.
  - The terrain Gouraud light re-lights only on the 15 s `retailLightTick` (retail_light_tick.js:154). `__setTerrainLightScale(cur)` calls `invalidate()`.
  - The IBL environment refreshes every 15 s (`?iblRefreshMs`, minimum 1000).
  - The colour-grade night blend is smoothed by exp(−4·dt).
  - The takram moon and stars follow `getSkyPortalTicks` (Date.now; `portal_ticks_at` IGNORES the time-of-day override, sky.rs:485).
  - The AC moons orbit on the rAF timestamp × `?moonSpeed`.
  - The AC sky-object UV scroll runs on session-relative Date.now.
  - The DayGroup does not advance when the overridden time wraps past midnight.
- Weather:
  - Retail weather means DayGroup SkyObjects with props 0x04, plus PES chains: the moon nebula 0x330007DB and the storm lightning box 0x33000453, realized by skyDome.updateSkyParticleChains (`?skyBirds`, default ON).
  - Streak billboards draw only with `?skyWeather=on`.
  - NO rain or snow precipitation particle system exists; the weather/manager.js named in comments is absent from the tree.
  - Runtime knobs:
    - `__setWeather({is_storm, temperature_C, dewpoint_C, …})`: sticky per-field overrides (weather_state.js:250) that drive the takram storm look (`?clouds=on` only) and the VFX weather uniforms;
    - `__clearWeatherOverride()`;
    - `__setWeatherProfile(idx, partial)` (the 20-entry table is INFERRED, not retail).
- Fog:
  - `scene.fog` is a linear THREE.Fog rewritten every sky tick by loop.js:2016 tickDistanceFogColor. The band comes from SkyState fogMin/fogMax, re-anchored to the drawn ring edge; the colour comes from the horizon sky radiance probe.
  - Only `?farFogNear` and `?farFogFar` pin it. These are read from `location.search` on every call (far_terrain_flags.js:317-329).
  - Client-side override: `window.__environFogOverride = environFogFor(1..6)` (environ_override.js:81; Red, Blue, White, Green, Black, Black2). It must be a fresh object; it fades in over about 20 s in 0.8 s ticks; null clears it.
  - The character options "Disable distance fog" and "Disable most weather effects" kill fog and weather respectively.

4) LOOK CONTROLS
The `__set*` helpers in scene3d/index.js are installed in the same synchronous callback that fires bootState 'ready' (index.js:6290 → 6323-6366). They are absent under `?wireframe=1`.

| Area | Controls |
|---|---|
| Exposure and light | `__setExposure(v)` (`?exposure`, default 5, range 0.1-20); `__setWorldLightScale(v)` (default 0.4); `__setTerrainLightScale(v)` (default 0.55); `__setAmbTintSat(v)` |
| Bloom and vignette | `__setBloomIntensity` / `__setBloomThreshold` (0.55 / 1.1); `__setVignetteDarkness` / `__setVignetteOffset` (0.3 / 0.5). These return null unless the preset built bloom (mid+) or vignette (high+). |
| Sun, moon, sky glow | `__setSunSize(rad)`, `__setMoonSize(rad)`; `__setMoon*` (ac_moons.js:1539-1615); `__skyGlow` |
| Colour grade | `__grade` {day, night, off, reset(), state()} (color_grade.js:194); GRADE_DAY and GRADE_NIGHT are blended by night fraction |
| Tone curve | `?tone=neutral|agx|aces` is URL-only. At runtime, `__atmospherePipeline.toneMapping.mode` (pmndrs) can be set, which recompiles. |
| AO and haze | `__ssao` {params, set(o), off, stats} (high/ultra or `?ssao=on`); `__layerHaze` {strength, params} (default 0.4) |
| FX effects | `__fxGlow` {intensity, strength, radius}; `__fxDistort` {amplitude}; `__fxDecals`; `__fxTier2` {stretchT (particle motion-streak shutter), minPx} |
| Clouds (`?clouds=on` only) | `__setCloudCoverage`, `__setCloudQuality`, `__setLightShafts`, `__setCloudShadowStrength`, `__setCloudShadowEnabled`, `__applyCloudWeather`, `__resetCloudLayers` |
| Shadows | CSM has no window setter. It uses `liveScene3d.csmState`, `invalidateCsm`, `DEFAULT_CSM_SPLITS` [30, 100, 300], fit to `cameraSwitcher.activeCamera` (lighting.js:1688) |
| Fog | `?radialFog=on` makes fog range-based, so it does not change with camera yaw (pans) |
| Render | `__setRenderScale(n)` |

5) POST-PROCESSING
- The composer is built in scene3d/atmosphere_pipeline.js `createAtmospherePipeline` (:829), with `new EffectComposer(renderer, {frameBufferType: HalfFloat, multisampling: msaa(2), stencilBuffer: flag})` at :939.
- Pass order:
  1. [sky RenderPass]
  2. CameraLayerMask
  3. world RenderPass (:1141)
  4. [portal punch / seal]
  5. depth ClearPass
  6. cellsMask, cells RenderPass (:1330), mask restore
  7. NanScrub EffectPass (:1634)
  8. [SsaoPass] (:1638)
  9. [LayeredHaze, if the chain is unsplit]
  10. fxPass (:1641)
  11. split chain only: ParticlesOverClouds, late scrub, LayeredHaze, fxPostPass (:1648)
- Legacy single fxPass (:1609/:1629), which is the default boot when clouds are off: [HeatHaze?, FxDistort?, SsaoComposite?, FxDecals?, Clouds?, AerialPerspective, HorizonDissolve(off), FxGlow?, LensFlare(off, `?lensFlare=on`), Bloom?, Vignette?, ToneMapping(Neutral), ColorGrade, Dithering].
- Split chain, only with `?clouds=on` + cloudsMainPass + particlesOverClouds (:1595-1602): atmosEffects into late target T, then postEffects [FxGlow, LensFlare, Bloom, Vignette, ToneMapping, ColorGrade, Dithering].
- Not present: depth of field / bokeh, motion blur, chromatic aberration, grain, SMAA/FXAA (MSAA only), LUT, and god rays (except takram lightShafts when clouds are on). The CDN postprocessing@6.39.1 (index.html:995; the same build is in node_modules) ships DepthOfFieldEffect (build/index.js:5430), BokehEffect, RealisticBokehEffect, ChromaticAberrationEffect, NoiseEffect, TiltShiftEffect, LUT3DEffect, GodRaysEffect and SMAAEffect.
- Adding DoF for rack focus:
  1. Build `new DepthOfFieldEffect(camera, {focusDistance, focusRange, bokehScale, resolutionScale})`.
  2. Put it before fxGlow/bloom: postEffects at :1596 (split), or after horizonDissolve in the legacy list at :1629.
  3. The effect's EffectAttribute.DEPTH makes the pass request depth. The CoC shader decodes logarithmic depth itself (`USE_LOGARITHMIC_DEPTH_BUFFER` block, build/index.js:4937). The renderer uses logarithmicDepthBuffer:true (index.js:1162). Never hand-decode log depth a second time; see the history at atmosphere_pipeline.js:288-306.
  4. Rack focus: animate `dof.cocMaterial.focusDistance`, or set `dof.target` to a THREE-world Vector3 for autofocus (calculateFocusDistance :5642 measures euclidean distance from the camera).
  5. Camera switch: `set mainCamera` (:5513) re-copies near/far, and `retargetFxPass` (:1773) fans out to `fxPass` and `fxPostPass.mainCamera`.
- pmndrs gotcha: the base Pass `mainCamera` setter is a no-op. LayeredHazePass, SsaoPass, ParticlesOverCloudsPass and PortalPunchPass keep their own `.camera`/`setCamera`. `pipeline.render(cam)`'s camera-switch branch (:2131-2141) does NOT retarget SSAO or LayeredHaze; only `pipeline.setCamera` (:2236) does, and nothing calls it.

6) CLOCKS
There is no shared clock and no global time scale. The sources are:

| Clock | What it drives |
|---|---|
| rAF timestamp → `tick(nowTs)` (index.js:2487). dt is clamped to 0.1 (:2512) with a recovery freeze; recovery is disabled under renderOnDemand. Published as `liveScene3d.frameTime` {tsMs, tsSec, dt} (:2532). | terrain water and lava uTime (loop.js:1146); the VFX master clock VFX_GLOBALS.uTime, which drives grass and tree wind sway, oscillators, weather inputs and flame flicker (loop.js:1190); ground fog; AC moons (ts); entity mixers, camera and ambient audio (dt); composer dt, which drives takram cloud advection plus TAA jitter and colour-grade smoothing |
| Particle simulation and PhysicsScript queues: `time_rng.currentTime()` (latched per manager tick) | Default `?particleClock=off` uses `performance.now()/1000`. `=sim` installs `liveScene3d._particleSimNowS += clamped dt`, bounded by wall time (index.js:5431, loop.js:3354). RNG comes from `rng()` = Math.random. Both are overridable through the `setCurrentTime` and `setRng` module exports. |
| `performance.now` (wall clock) | particle FX shader time (`particleFxFrame()` :525, called with no arguments); the static manager's PRIVATE rAF loop in `particleClock=off` (statics.js:5771); animated_scenery's private rAF; PlayEffect burst rAF and one-shot setTimeout reapers; fx_lights; the RP3 throttles; retail light (15 s) and fog (0.8 s) ticks; the IBL cadence; `?skytime=accel` |
| `Date.now` | wasm sky time of day and DayGroup; moon and star date; AC sky UV scroll |
| `document.timeline.currentTime` | shared alpha bucket frame id |
| wasm physics | its own self-measured dt |

- `__renderOnce()` (index.js:3007) ignores its arguments and passes `performance.now()`, so a fixed dt per captured frame needs either a small code change (accept an explicit ts) or a page-level `performance.now`/`Date.now`/rAF virtualization.

## APIS
- ParticleManager [scene3d/particles/particle_manager.js:1410]  sig=new ParticleManager({scene, geometryFactory, materialFactory, degradeInfoFactory?, cellLookup?, instancing?}) :: Emitter coordinator. Fields: particleTable (Map<id, ParticleEmitter>, line 1420), _scene, _instBuckets (Map key `${gfx}|${layer}[|a][|sky]` → {im, n, alpha}, line 1448), _kids, onEmitterRemoved, cellHiddenLastTick, _rp6Frame. Two instances exist: world (entities.js:14588) and static (statics.js:4986).
- ParticleManager.addEmitter [scene3d/particles/particle_manager.js:1764]  sig=async addEmitter({emitterInfo, parent, partIndex=-1, parentOffset=null, emitterId=0, blocking=false, renderLayer=0, skyGlow=false}) → Promise<id|0> :: Installs an emitter from a wasm ParticleEmitterJs or a POJO. Stamps renderLayer, _fxRow, skyGlow, _baseIsAdditive, _instKey and _instAlpha. Foliage POJOs with degradeDistanceMeters get _forceDegrade=true (line 2122-2123). Film mode can use it to spawn its own atmospheric emitters (dust, embers, mist).
- ParticleManager.tick / _tickLatched [scene3d/particles/particle_manager.js:2147]  sig=tick() → void (holds the time latch; _tickLatched at 2156) :: Per-frame update. RP6 frustum and 220 m cull rechecked every 6 ticks; billboarding against _rp6ResolveCamera() (cameraSwitcher.activeCamera ?? camera); cell gate; instanced append; bucket finalize with back-to-front alpha sort; retirement of finished emitters.
- ParticleManager.stopParticleEmitter / destroyParticleEmitter [scene3d/particles/particle_manager.js:2730]  sig=stopParticleEmitter(id) → bool; destroyParticleEmitter(id) → bool (line 2739) :: Graceful stop (sets stopped and drains live particles) or immediate removal (meshes removed, slot materials reclaimed).
- _rp6ShouldCull (private) [scene3d/particles/particle_manager.js:1239]  sig=_rp6ShouldCull(emitter, camera) → bool :: Per-emitter cull authority. Ballistic anchors are exempt. Distance cap is _RP6.maxDistance (220, line 177) + sortingSphere.radius + |parentOffset|. Degrade OR-term: (?particleDegrade=retail || emitter._forceDegrade) && distSq > degradeDistance². Then a frustum test on the sphere.
- ParticleEmitter [scene3d/particles/particle_emitter.js:112]  sig=fields: id, parent, partIndex, parentOffset{position,quaternion}, info, particles[], parts[], partStorage[], numParticles, totalEmitted, stopped, lastEmitTime, degradeDistance(=Infinity, line 155); updateParticles() line 505; _resolveAnchorFrame() line 182 :: Per-emitter state. parts[i] are live slot meshes. On the instanced path they are detached carriers holding _scene-local matrices and userData.__op opacity.
- ParticleEmitterInfo.sortingSphere [scene3d/particles/particle_emitter_info.js:125]  sig=info.sortingSphere = {center:(0,0,0), radius:max(maxOffset, maxA*lifespan)} (initEnd line 130) :: Conservative reach radius around the anchor. Ignores the B and C accelerations. Use it for coarse segment-vs-sphere obstruction tests.
- setTranslucency [scene3d/particles/particle.js:179]  sig=setTranslucency(mesh, translucency) :: Sets mesh.visible (false when translucency>=1) and userData.__op = 1−translucency on every particle update. Any external mesh.visible write is overwritten on the next update.
- time_rng clock and RNG hooks [scene3d/particles/time_rng.js:54]  sig=currentTime() (line 44); setCurrentTime(fn|null) (54); setRng(fn|null) (66); holdTimeLatch()/releaseTimeLatch() (34/39); particleClockMode() → 'off'|'loop'|'sim' (100) :: The single clock for particle simulation, emission and PhysicsScript queues. Defaults to performance.now()/1000 and Math.random. Override with deterministic functions for frame-stepped capture and repeatable takes.
- ownerRegistry [scene3d/particles/owner_registry.js:549]  sig=addEmitter(ownerKey, manager, req) (240); destroyEmitter(ownerKey, handle, opts) (391); stopEmitter(ownerKey, handle, opts) (422); stopSome(ownerKey, ids) (461); destroySome(ownerKey, ids) (482); destroyAllForOwner(ownerKey) (503); ownerKeys(); emitterCountForOwner(k); _owners Map; _byMgr WeakMap (185) :: Owner facade (default ON). Maps an entity guid or static/sky key to {manager, emitter id}. `_byMgr.get(mgr)?.get(id)` gives the emitter's owner. This is the reliable way to discover the static manager.
- window.__diag.particles [scene3d/index.js:4675]  sig=__diag.particles() → {liveEmitters, staticEmitters, worldEmitters, owners, byOwner} :: Counts only, read off the scene3dForBuilders facade. probeNearestParticle (line 4707) returns wrong-frame coordinates on the instanced path.
- particle FX profile uniforms and near fade [scene3d/particles/particle_fx.js:405]  sig=FX_UNIFORMS {uFxTime, uFxLight, uFxAlphaCal, uFxAddCal, uFxStretchT, uFxMinPx, uFxViewH, …}; particleFxFrame(nowMs?) (525); window.__particleFx(on?) (1488); window.__fxTier2 {stretchT, minPx} (1507) :: Shared FX shader uniforms. The per-row nearFade term is at line 1002. uFxTime is driven from performance.now when no argument is passed. Calibration follows renderer.toneMappingExposure.
- collectParticlesOverClouds / window.__particlesOverClouds [scene3d/atmosphere_pipeline.js:1690]  sig=__particlesOverClouds {flag, built, armed, activeThisFrame, set(on), stats(), passes(), reset()} :: Late particle draw toggle. passes() lists the composer pass and effect order, which is useful for checking an inserted DoF.
- createAtmospherePipeline [scene3d/atmosphere_pipeline.js:829]  sig=createAtmospherePipeline(renderer, scene, camera, {skyScene, skyCamera, atmosphereRuntime, bloom, vignette, ssao, msaa, lensFlare, portalPunch, punchRetail, …}) → {composer, aerialPerspective, bloom, vignette, toneMapping, colorGrade, ssaoPass, layeredHaze, dithering, fxPass, fxPostPass, particlesOverCloudsPass, cloudsMainPass, preFrameSkySync, setSunDirection, render(cam, dt) (2131), setCamera(cam) (2236), setSize, getSceneDepthTexture} :: The pmndrs composer and all post effects. Live instance at window.__atmospherePipeline and liveScene3d.atmospherePipeline. The DoF insertion point is postEffects (line 1596) or the legacy list (line 1629).
- look setters [scene3d/index.js:6323]  sig=__setExposure(v); __setWorldLightScale(v) (6333); __setBloomIntensity(v) (6343); __setBloomThreshold(v) (6349); __setVignetteDarkness(v) (6356); __setVignetteOffset(v) (6362); __setSunSize(rad) (6051); __setMoonSize(rad) (6055); __setRenderScale(n) (1268) :: Installed right after bootState 'ready' on the atmosphere composer path. The bloom and vignette setters return null if the preset did not build those effects.
- cloud setters [scene3d/index.js:5713]  sig=__setCloudCoverage(0..1); __setCloudQuality('low'|'medium'|'high'|'ultra') (5721); __setLightShafts(on) (5729); cloud_volume.js: __applyCloudWeather (602), __resetCloudLayers (609), __setCloudShadowStrength (627), __setCloudShadowEnabled (642) :: Volumetric takram clouds. Exist only with ?clouds=on (index.js:5619).
- window.__grade [scene3d/color_grade.js:194]  sig=__grade {day, night (mutable param objects: wb, tint, lift, gain, gamma, contrast, pivot, saturation, vibrance), off, reset(), state(), effect} :: Display-referred colour grade after the tone curve. Day and night sets are blended by the night fraction from the authored sun pitch, smoothed by exp(−4·dt).
- window.__ssao / window.__layerHaze [scene3d/ssao.js:295]  sig=__ssao {params, set(o), off, stats(), pass}; __layerHaze {strength, params, stats()} (layered_haze.js:163) :: SSAO (high/ultra presets) and the layered distance/altitude haze (default 0.4).
- terrain light and environ handles [scene3d/loop.js:1361]  sig=__setTerrainLightScale(v) (calls retailLightTick.invalidate()); __setAmbTintSat(v) (1366); __terrainLightState() (1371); __retailLightTickState() (1373); __environOverrideState() (1375) :: Terrain Gouraud light scale. Calling it each frame forces the 15 s retail light tick to re-light, which a time-lapse needs.
- SessionHandle sky API [pkg/holtburger_web.d.ts:6366]  sig=setSkyTimeOverride(t:number /*[0,1), NaN clears*/): boolean; setGameDayOverride(day, year): boolean (6276; 0xFFFFFFFF pair clears); getSkyState(): SkyState|undefined (4699); getSkyPortalTicks(): number (4675); getSkyObjectStates(): SkyObjectState[] (4657); derethCalendarAt(ticks) (3779); isCharacterOptionEnabled(opt) (5005) :: Wasm sky evaluator controls via window.__sessionHandle. getSkyState is evaluated against Date.now() (src/lib.rs:23531). The time-of-day override does not move the moon or stars (sky.rs:485).
- SkyLightingController._lastState [scene3d/sky_lighting.js:88]  sig=liveScene3d.skyLightingController._lastState = {dirColorArgb, dirBright, dirHeading, dirPitch, ambColorArgb, ambBright, fogColorArgb, fogColorArgbLerp, fogMin, fogMax, worldFog, timeOfDayNormalized, dayGroupIndex} (snapshotSkyState line 44; tick line 114) :: Per-sky-tick snapshot (10 Hz) used by every atmosphere consumer. Convert to a THREE-world sun with sunDirFromHeadingPitch(h, p) → (cos p·sin h, sin p, −cos p·cos h) (sun_direction.js:49).
- createAlwaysDaylight / window.__alwaysDaylight [scene3d/always_daylight.js:82]  sig=tick(handle, nowMs); state() → {on, pinned, lightResets} :: CharacterOption 0x05 driver. Pins setSkyTimeOverride(0.5) every 250 ms poll while the option is on, and NaN-clears on the off edge. Runs only when there is no ?skytime pin or accel (index.html:6508).
- retailLightTick [scene3d/retail_light_tick.js:154]  sig=retailLightTick.{sync(stateTick), due(stateTick), reset(stateTick?), invalidate(), stats()} :: The shared 15 s landscape re-light clock (terrain Gouraud and pebbles), on performance.now().
- weather overrides [scene3d/weather_state.js:250]  sig=window.__setWeather(partial {latitude_deg, longitude_deg, temperature_C, dewpoint_C, surface_pressure_hPa, season, is_storm}); __getWeather(); __clearWeatherOverride(field?) (270); daygroup_weather.js: __setWeatherProfile(idx, partial) (252), __getWeatherProfiles() :: Sticky per-field overrides. DayGroup updates skip overridden fields. Drives the takram storm look (clouds) and VFX weather uniforms. It does not create rain.
- environFogFor / window.__environFogOverride [scene3d/environ_override.js:81]  sig=environFogFor(option 1..6) → {option, name, fogRgb, fogMin, fogMax, ambRgb, ambLevel} | null; read each tick at loop.js:2039 :: Client-side AdminEnvirons fog. Assign a fresh object to window.__environFogOverride for Red, Blue, White, Green or Black fog plus ambient. Fades in over about 25 × 0.8 s; null clears it.
- tickDistanceFogColor [scene3d/loop.js:2016]  sig=tickDistanceFogColor(scene3d, env) :: Rewrites scene.fog color, near and far every sky tick. The band is anchored to the drawn ring edge and pinned only by ?farFogNear and ?farFogFar, which are read live from location.search (far_terrain_flags.js:317).
- AtmosphereSky.tick / setSunAngularRadius [scene3d/atmosphere_sky.js:285]  sig=tick(state); setSunAngularRadius(rad) (350); setMoonAngularRadius(rad) :: Sun direction from SkyState with nightRamp applied. Moon and stars come from gameDateMsNow(handle, Date.now()) (sky_game_date.js:51), which uses portal ticks and ignores the time-of-day override.
- SkyDome.syncSkyCamera [scene3d/sky_dome.js:711]  sig=syncSkyCamera(mainCamera) :: Copies the main camera's LOCAL position and quaternion, plus fov and aspect, to the sky camera every frame (from preFrameSkySync). Quaternion copy means it is gimbal-free, but the camera must be unparented.
- updateCsm / invalidateCsm [scene3d/csm.js:412]  sig=updateCsm(csmState, camera, sunDir?); invalidateCsm(csmState) (380); DEFAULT_CSM_SPLITS [30,100,300] (60) :: Cascaded shadows fit per frame to cameraSwitcher.activeCamera (lighting.js:1688-1699). Perspective cameras only. Skip-cache on camera position and orientation deltas.
- __renderOnce / tick [scene3d/index.js:3007]  sig=window.__renderOnce() → bool (calls tick(performance.now())); internal async tick(nowTs) (2487) :: Steps one frame (simulation plus render) under ?renderOnDemand=1. dt is the wall-clock delta clamped to 0.1, so it is not fixed per frame.
- DepthOfFieldEffect (postprocessing 6.39.1) [node_modules/postprocessing/build/index.js:5430]  sig=new DepthOfFieldEffect(camera, {focusDistance=3, focusRange=2, bokehScale=1, resolutionScale=0.5, resolutionX, resolutionY}); .target (Vector3 autofocus); .cocMaterial.focusDistance/focusRange; set mainCamera (5513); update reads target at 5667 :: Not yet used anywhere. The CoC shader handles the log depth buffer (4937). Load it via the import map 'postprocessing' (index.html:995, the same CDN version) so it is the same instance as the pipeline.
- playEffect event bus [scene3d/play_effect_vfx.js:3476]  sig=window.__pluginClient.events.emit('playEffect', {targetGuid, scriptId, speed, synthetic:true})  (same shape as entities.js:10585) :: Triggers retail PhysicsScript VFX, or the placeholder fallback, on an entity client-side. synthetic:true plays visuals only. Usable for staged spectacle.
- particle FX catalog [data/particle-fx-catalog.json:1]  sig={version, layout, families{44}, emitters{'0x32xxxxxx': {family, behavior, note, params{…nearFade…}, surface, gfx, tags}}, synthesized{14}} :: Per-emitter semantic classification (fire, smoke_dark, mist, star, …; plume, standing, burst, …) for obstruction scoring and shot dressing. Keyed by emitter.info.id.

## SEAMS
- [scene3d/atmosphere_pipeline.js:2236] Active-camera resolution. Every subsystem reads `liveScene3d.cameraSwitcher.activeCamera ?? camera` per frame: the particle RP6 cull, billboards and alpha sort (particle_manager.js:925); CSM (lighting.js:1688); the composer render (index.js:2722/2779); skyDome.tick (loop.js:3198); and AC moons. => Install the film camera as activeCamera, or drive the boot liveScene3d.camera object directly (the simplest option). Set its pose BEFORE tickPerFrame's camera, entity and particle phases so billboards and cull use this frame's pose. Keep it unparented, since the sky sync and billboards treat camera.position/quaternion as world values. If it is a new camera object, also call __atmospherePipeline.setCamera(cam).
- [scene3d/particles/owner_registry.js:185] Emitter enumeration for obstruction: ownerRegistry._owners / _byMgr plus mgr.particleTable plus emitter.info and parts[]. => Each frame (after the particle tick, before render), build a list of {worldCenter = parent.getWorldPosition() + parentOffset, radius = sortingSphere.radius, live particle world positions via mgr._scene.localToWorld(mesh.position), size = geom.boundingSphere.radius*mesh.scale.x, opacity = userData.__op, additive = _baseIsAdditive, family = catalog[info.id], ownerKey}. Score camera→subject segment intersections (smoke and gas families occlude; additive fire brightens) and particles within about 2 m of the eye (a cloud on the lens).
- [scene3d/particles/particle_manager.js:2156] Per-emitter hide via the cull path: emitter._forceDegrade, degradeDistance and _rp6Culled. => Hide an obstructing emitter for one shot by setting _forceDegrade=true, degradeDistance=0, _rp6Culled=true, then restoring the saved values afterwards. Better: add a render-only `filmHidden` check beside the cell-gate branch in _tickLatched (skip _appendInstances, run _setPartsVisible(false)) so the simulation keeps running.
- [scene3d/particles/particle_fx.js:1002] Global particle near fade. A shader term already exists per row at particle_fx.js:1002, fed from FX_UNIFORMS (line 405). => Add a uniform-only floor, e.g. uFxNearFadeMin, and compute nearFade = max(vFxD.y, uFxNearFadeMin). This kills screen-filling smoke quads during dolly-throughs without a program-key change (respects the VFX write invariant). Only the instanced path is covered, which is the default.
- [scene3d/particles/particle_manager.js:177] RP6 220 m particle distance cap (`_RP6.maxDistance`, read live from a module-level object). => Export a setter and raise it to 600-1500 m during aerial establishing shots. Otherwise all fires, smoke and portal swirls beyond 220 m + radius from the camera are frozen and hidden.
- [pkg/holtburger_web.d.ts:6366] Time-of-day override API: SessionHandle.setSkyTimeOverride / setGameDayOverride. => Golden hour or night shots: call setSkyTimeOverride(h/24) EVERY frame (cheap, and survives evaluator replacement). Time-lapse: t = t0 + rate·filmTime, with ?frameBudget=off and __setTerrainLightScale(cur) each frame. Weather: pick the DayGroup with setGameDayOverride(day, year) after a sweep that reads getSkyState().dayGroupIndex and getSkyObjectStates() props&4.
- [scene3d/loop.js:2039] Client fog override via window.__environFogOverride (read each sky tick). => Dramatic fog on demand without server admin: window.__environFogOverride = environFogFor(3) (WhiteFog, 30 m band). It fades over about 20 s; ?environRetail=off snaps. Clear with null.
- [scene3d/atmosphere_pipeline.js:1596] Composer post-effect slot lists. => Insert DepthOfFieldEffect (rack focus via dof.target = subject world position or animated cocMaterial.focusDistance). Optionally add ChromaticAberration or Noise in postEffects. After insertion, verify the order with __particlesOverClouds.passes().
- [scene3d/index.js:6323] Look handles: __setExposure, __grade, __setBloom*, __setVignette*, __ssao, __layerHaze, __fxGlow, __setWorldLightScale, __setSunSize. => Per-shot grading presets (warm noon, cool night, high-contrast storm) and exposure ramps for interior↔exterior transitions. Apply after bootState 'ready'; gate on __sceneReadyEverFired.
- [scene3d/index.js:3007] Deterministic clock injection: time_rng.setCurrentTime/setRng, tick(nowTs), and __renderOnce. => Frame-stepped capture: boot with ?renderOnDemand=1&particleClock=sim&frameBudget=off. Change __renderOnce to accept an explicit tsMs (dt = 1/fps). Set setCurrentTime(() => filmClockSec) and setRng(seeded) via dynamic import of ./scene3d/particles/time_rng.js. Route particleFxFrame, animated_scenery, fx_lights and the moon/star date to the film clock.
- [scene3d/sky_lighting.js:88] Sun direction snapshot for shot planning. => Backlight, rim-light or golden-hour framing: sun = sunDirFromHeadingPitch(_lastState.dirHeading, _lastState.dirPitch) in THREE world, or __atmosphereLights.sun.sunDirection. Choose the camera azimuth relative to the sun and avoid lens-flare angles.
- [scene3d/play_effect_vfx.js:3476] PlayEffect client-side trigger bus. => Staged spectacle (portal swirls, spell bursts, level-up effects) on chosen entities for music-video beats, with synthetic:true (silent visuals).
- [data/particle-fx-catalog.json:1] Semantic emitter catalog (data/particle-fx-catalog.json). => Score lyric↔site matches (fire, mist, magic, water families near a site) and obstruction weights by family. JEV can take the family/behavior/note text as typed decision features.

## HAZARDS
- [scene3d/index.js:4744] Instanced slot meshes (the default path) are detached carriers, so mesh.getWorldPosition() returns _scene-local AC coordinates, not THREE world. __diag.probeNearestParticle uses getWorldPosition and is wrong on the default path. || mitig: Convert with mgr._scene.localToWorld(v.copy(mesh.position)), or mgr._scene.matrixWorld × mesh.matrix.
- [scene3d/statics.js:4895] The static ParticleManager is stamped on scene3dForBuilders. window.liveScene3d._staticParticleManager can be undefined, or a second instance if a lazy LB bake ran against the window facade. || mitig: Discover managers via ownerRegistry._owners (rec.ids values) plus entityManager._worldParticleManager, or export an allParticleManagers() accessor from particle_manager.js.
- [scene3d/statics.js:5771] The default ?particleClock=off ticks static emitters on a PRIVATE rAF loop. That loop is registered before the main tick, so it likely runs before the main tick's camera update: static billboards, alpha sort and cull use the previous frame's camera, and static particles keep simulating between __renderOnce calls. (Ordering inferred from rAF semantics; not measured.) || mitig: Boot film sessions with ?particleClock=sim (or loop) so both managers tick in tickPerFrame after cameraSwitcher.tick.
- [scene3d/particles/particle_manager.js:177] The RP6 cull hides and freezes every emitter beyond 220 m + radius from the CAMERA, and rechecks only every 6 ticks. Aerial and drone wide shots lose all distant fire, smoke and portal effects, and fast pans can pop emitters in for up to 6 frames. || mitig: Raise _RP6.maxDistance and set recheckInterval to 1 during film (needs a small exported setter).
- [scene3d/particles/particle_manager.js:1249] Forcing the cull to hide an emitter has side effects. Persistent emitters freeze (ages thaw on re-entry). Finite emitters virtual-emit and are force-stopped after 30 s culled, so they may never return. Ballistic projectile emitters are exempt and cannot be hidden this way. || mitig: Prefer a new render-only filmHidden flag mirroring the cell-gate branch. Keep hides under 30 s, or restore before they expire.
- [scene3d/particles/particle.js:179] setTranslucency rewrites mesh.visible on every particle update, so a per-mesh hide written from outside is undone on the next tick. || mitig: Hide through the manager (cull or flag path), or re-assert after the particle tick and before render.
- [scene3d/vfx/fx_glow_effect.js:139] Hiding an instanced bucket via im.visible=false still leaves its fxGlow halo. The glow twin checks ancestors only, not the bucket itself. || mitig: Use emitter-level hiding, or also set __fxGlow.strength=0 during the shot.
- [scene3d/particles/particle_manager.js:1197] Retail mode-2 billboards skip the update when the viewer line is parallel to world up, and spin rapidly near nadir. Synthesized sprites use setFromUnitVectors, whose roll is unstable near the anti-normal. Straight-down drone tilts over waterfalls, fires or portals show spinning or frozen quads. || mitig: Keep top-down shots a few degrees off nadir, or add a film-mode stable-up override (e.g. use the camera's up vector) for billboards.
- [scene3d/atmosphere_pipeline.js:2131] pipeline.render(cam)'s camera-switch branch does not retarget SsaoPass or LayeredHazePass, and pipeline.setCamera() is never called. A separate film camera object gets AO and haze computed from the boot camera's pose and projection. Base pmndrs Pass.mainCamera is a no-op. || mitig: Call __atmospherePipeline.setCamera(filmCam) once on switch, or drive the boot camera object itself.
- [scene3d/index.js:2487] Many independent clocks. Wall performance.now: particle sim default, particle FX shader time, fx_lights, animated_scenery private rAF, PlayEffect burst rAF and setTimeout reapers, RP3 10 Hz sky throttle, 15 s retail light tick, 0.8 s fog tick, IBL 15 s. Date.now: wasm sky time and DayGroup, moon and stars, AC sky UV scroll. rAF timestamp: water, VFX uTime (grass and tree sway), AC moons, mixers. Composer dt: cloud advection, TAA, grade smoothing. __renderOnce always passes performance.now(). || mitig: For deterministic capture, either virtualize performance.now, Date.now and rAF at page level (Page.addScriptToEvaluateOnNewDocument or CDP virtual time), or add explicit film-clock plumbing (tsMs into __renderOnce, plus setCurrentTime, particleFxFrame(nowMs), and the moon-date override).
- [scene3d/loop.js:3354] In ?particleClock=sim the simulation clock is min(prev+dt, wallNow), so a virtual clock running ahead of wall time is clamped. The manager-phase double-call guard keys on performance.now(), so a frozen virtual performance.now would skip particle ticks. || mitig: Under film mode, bypass the wall clamp and key the guard on a frame counter, or install setCurrentTime(filmClock) after boot (it overrides the sim install).
- [external/holtburger/crates/holtburger-world/src/sky.rs:485] Time-lapse inconsistencies under setSkyTimeOverride: moon and stars ignore the override (portal ticks come from Date.now); the DayGroup does not change across the overridden midnight; terrain re-lights only every 15 s; the sky stack updates at 10 Hz; IBL every 15 s; colour-grade night blend lags (exp −4·dt). || mitig: Use ?frameBudget=off (or ?deferHz=60), ?iblRefreshMs=1000, __setTerrainLightScale(cur) per frame, advance setGameDayOverride manually across midnight, and add a moon/star date override in sky_game_date.js for film.
- [scene3d/always_daylight.js:82] The Always-daylight character option re-pins time of day to 0.5 every 250 ms (and NaN-clears on the off edge), fighting film overrides. The ?skytime pin is one-shot and is lost when populateSkyDescFromRegion replaces the evaluator. setSkyTimeOverride returns false before the SkyDesc lands. || mitig: Boot with ?skytime=<h> (disables the daylight driver) or ensure option 0x05 is off. Re-assert the override every frame and check the boolean return.
- [scene3d/index.js:6290] The look setters (__setExposure, bloom, vignette, sun and moon size) only exist after the atmosphere composer reports 'ready'. They are absent with ?wireframe=1. Bloom is null at quality=low, vignette below high, SSAO below high. 'ready' and 'in-world' can arrive in either order on the one scalar. || mitig: Film sessions use ?quality=ultra (or ?bloom=on&vignette=on&ssao=on). Wait on window.__sceneReadyEverFired===true plus __bootStateHistory containing 'in-world', and null-check every setter's return.
- [scene3d/atmosphere_pipeline.js:288] The renderer uses logarithmicDepthBuffer. pmndrs readDepth already decodes it for Effects with EffectAttribute.DEPTH; hand-decoding again previously replaced the whole town with sky. CoC near/far are copied by value. || mitig: For DoF, use the stock DepthOfFieldEffect (CoC handles log depth) and getViewZ in custom effects. Re-set fxPostPass.mainCamera after changing camera.near or far.
- [scene3d/atmosphere_pipeline.js:1609] Adding, removing or reordering effects in an EffectPass, or changing the tone-mapping mode, recompiles the merged program (about 3 s per program on the 1070). Changing light counts or per-instance program keys violates the VFX write invariant. || mitig: Build the DoF (and any lens effects) once at pipeline construction behind a film flag. Animate only uniforms (focusDistance, bokehScale, blendMode.opacity) per shot.
- [scene3d/loop.js:2306] scene.fog near, far and colour are overwritten every sky tick. The horizon fog band is anchored to the drawn streaming-ring edge, so drone shots far from the player can expose fog walls or unloaded edges. Planar fog makes distant objects gain and lose fog during pans unless ?radialFog=on. || mitig: Use ?radialFog=on for film. Pin via ?farFogNear/?farFogFar (read live from location.search) or add a film fog override. Coordinate with the streaming subsystem for camera-centred residency.
- [scene3d/loop.js:1538] No rain or snow precipitation system exists (the weather/manager.js referenced in comments is absent). Weather visuals are limited to DayGroup sky objects, ?skyWeather streak billboards, the storm lightning sky chain, takram storm clouds (?clouds=on) and fog. || mitig: Treat 'rain' shots as fog, storm clouds or lightning, or add a film-side precipitation emitter via ParticleManager.addEmitter.
- [scene3d/particles/additive_fog.js:1] Additive particles are drawn unfogged, matching retail, so fires and portals glow at full strength through heavy fog. Alpha smoke is fogged. || mitig: Account for this in fog-heavy compositions, or use __additiveFogBlack('fade') per shot.
- [scene3d/atmosphere_pipeline.js:1585] The particlesOverClouds split chain (particles drawn after clouds and aerial perspective) exists only with ?clouds=on. On split frames (indoor depth split, punch) particles stay in the world or cells pass, and soft particles are off. || mitig: Know which chain is live (__particlesOverClouds.stats().why) before inserting DoF. Test DoF on both the legacy and split chains.

## DATA
- {'name': 'Particle FX catalog', 'location': 'apps/holtburger-web/data/particle-fx-catalog.json (+ particle-fx-tier1.json, particle-fx-tier2.json; compiled into scene3d/particles/particle_fx_profiles.js)', 'format': "JSON {families{44}, emitters{'0x32xxxxxx': {family, behavior, note, params, surface, gfx, tags}}, synthesized{14}}", 'notes': '2051 retail emitters; nearFade>0 on 2000 of them (max 3.0 m). Keyed by emitter.info.id. Semantic classes for obstruction weighting and lyric/site matching.'}
- {'name': 'Live particle tables', 'location': 'window.liveScene3d.entityManager._worldParticleManager.particleTable; static manager via ownerRegistry (import ./scene3d/particles/owner_registry.js)', 'format': 'Map<id, ParticleEmitter>', 'notes': 'Positions are _scene-local AC frame (Z up). Convert with mgr._scene.localToWorld.'}
- {'name': 'Sky state snapshot', 'location': 'window.liveScene3d.skyLightingController._lastState; window.__sessionHandle.getSkyState()/getSkyObjectStates()/getSkyPortalTicks()', 'format': 'POJO {dirHeading, dirPitch, dirBright, ambColorArgb, fogMin, fogMax, fogColorArgbLerp, worldFog, timeOfDayNormalized, dayGroupIndex}', 'notes': 'Refreshed at 10 Hz unless ?frameBudget=off. Weather objects are those with properties & 0x04.'}
- {'name': 'URL flag registry', 'location': 'apps/holtburger-web/docs/url-flags.md (rows: skytime :974, skyServerClock :1566, exposure :985, tone :986, grade :987, layerHaze :979, clouds :255, particlesOverClouds :264, particleClock :532, frameBudget :539, deferHz :540, radialFog :1758, environRetail :1757)', 'format': 'Markdown table', 'notes': 'Trust the code readers over the doc text (some doc pointers are stale).'}

## RECS
- Film boot URL baseline: ?quality=ultra&frameBudget=off&particleClock=sim&radialFog=on&iblRefreshMs=1000&nosw=1, plus ?renderOnDemand=1 for frame-stepped capture. Add ?clouds=on only on the 1070, since SwiftShader zero-bakes the cloud 3D textures.
- Drive the existing boot camera (liveScene3d.camera), or call __atmospherePipeline.setCamera(filmCam) on switch. Set the pose before tickPerFrame's particle and entity phases, keep the camera unparented, and build orientation from quaternions (slerp or parallel-transport). Never use lookAt at ±90° pitch.
- Add film-only exports in particle_manager.js: allParticleManagers(), setParticleCullConfig({maxDistance, recheckInterval}), and an emitter.filmHidden render-only flag handled next to the cell-gate branch (skip _appendInstances / _setPartsVisible(false)).
- Add a global FX_UNIFORMS.uFxNearFadeMin (uniform-only) and use max(rowNearFade, uFxNearFadeMin) at particle_fx.js:1002 to prevent particle clouds on the lens. Scale the floor by camera speed and particle size.
- Build the obstruction scorer from ownerRegistry + particleTable: sphere = anchor world position + |parentOffset|, radius = max(sortingSphere.radius, live particle extent), weight by catalog family (smoke_dark, gas_alpha, mist_white occlude; additive fire, star, glow only distract), numParticles and mean userData.__op. Exclude skyGlow emitters. Also test the near-eye volume (particles within about 2 m of the camera).
- Construct DepthOfFieldEffect at pipeline build time behind a ?filmDof flag: in postEffects before fxGlow/bloom (split chain), and after horizonDissolve in the legacy list. Expose window.__dof {target, focusDistance, focusRange, bokehScale}. Rack focus = animate focusDistance, or set target to the subject's THREE-world position.
- Add a film clock: __renderOnce(tsMs) passing an explicit ts; setCurrentTime and setRng (seeded) from time_rng.js; particleFxFrame(filmMs); animated_scenery and fx_lights reading the same clock; a sky_game_date override so moon and stars follow setSkyTimeOverride. Motion blur can then be done by accumulating N sub-frames in the capture tool (pmndrs has no motion blur effect).
- For time of day and time-lapse, call setSkyTimeOverride every frame plus __setTerrainLightScale(__terrainLightState().scale) to force a terrain re-light. Advance setGameDayOverride across midnight. Pre-sweep (day, year) → dayGroupIndex and weather SkyObjects (props&0x04) once per session to get a weather menu for the planner.
- Use the documented look handles (__setExposure, __grade.day/.night, bloom, vignette, __ssao, __layerHaze, __fxGlow) for per-shot grading. Snapshot their current values before a shot and restore them after.
- Use window.__environFogOverride = environFogFor(n) for client-only fog moods instead of the server @setlbenviron command, which affects every player in the landblock. Budget the ~20 s fade-in, or use ?environRetail=off for a snap.

## OPENQ
- Does CDP Emulation.setVirtualTimePolicy, or a page-level performance.now/Date.now/rAF virtualization, keep the live ACE session healthy? Concerns: the keepalive worker, TimeSync forward-only anchoring, the 4 s pump watchdog and WebSocket timing. This has not been tested.
- Is the static ParticleManager present on window.liveScene3d in the current 1070 build? Run `await __diag.portalEmitterState()` and check its .facade field.
- Should DoF run before or after the late particle draw (blurred particles vs sharp ones)? How does it interact with 2× MSAA and the alpha-particle depth writes into composer.depthTexture inside the late pass?
- What is an acceptable RP6 cull distance and recheck interval for film on the GTX 1070 (perf budget for hundreds of town emitters at 1 km)?
- Which (day, year) pairs yield storm or foggy DayGroups in retail Dereth, and do the server's DayGroup and the client override stay consistent for other observers? (The override is client-only.)
- Should film mode own a separate camera object (cleaner, but needs pipeline.setCamera plus CSM, IBL and cloud retargeting) or hijack the boot camera? This decision belongs to the camera-subsystem recon.
- Exact rAF callback ordering between statics.js _spLoop and the main tick on headless Chrome under renderOnDemand. This determines whether static billboards lag the camera by a frame even with particleClock=off.

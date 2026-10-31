// scene3d/draw_exec.js — `?drawExec` (stage 3 S3.1, 2026-10-26; DEFAULT ON since 2026-10-26,
// `rustFlag("drawExec", true)`: `=off|0|false|no` is the escape). A thin executor for
// proven-stable STATIC-world draws, installed as the OUTERMOST renderBufferDirect wrapper. Design:
// docs/2026-10-26-rust-draw-list-design.md (R3) §5; lane notes: docs/2026-10-26-rust-draw-exec.md.
// Exactness proof: tests/draw_exec.test.mjs (the full GL call stream, flag-off vs flag-on,
// frame by frame) + harness/glsl_smoke/draw_exec_smoke.mjs (pixels, SwiftShader).
//
// WHY. three r184 re-derives every draw from scratch: `renderBufferDirect` runs
// setProgram (~20 needsProgramChange compares, the uniform-object lookups by name,
// the batching texture setters, the matrix setters), state.setMaterial, the VAO
// lookup (four nested map lookups + an attribute loop) and our three wrappers
// (batched_runs, skip_empty_multidraw, async_link_guard) for draws whose inputs did
// not change since the last frame (R3 §2, §5.10).
//
// WHAT. The first draw of an (object, material, group) goes through the full chain
// and is RECORDED: three's program, its uniform objects, the VAO three bound, the
// index type, what the geometry looked like (the program's attributes by identity,
// index + version, drawRange), the material fields three re-reads per draw, the
// async-link stamp combo. Every later draw VALIDATES the record (property reads, no
// lookups) and then takes one of three paths:
//   * CONTINUATION — same program, material, camera and render call as the draw
//     before: three's setProgram would set no program, no material uniforms and no
//     camera uniforms, so the executor issues exactly what it would issue — the
//     batching textures on their units (through three's own textures.setTexture2D, so
//     a due upload happens exactly where three does it), receiveShadow if it moved,
//     the three matrix setters (their caches decide the upload), state.setMaterial
//     (skipped when provably a no-op, below), then the VAO bind (if not bound), the
//     draw, and renderer.info.update.
//   * SWITCH — anything else with a valid record: three's own renderBufferDirect with
//     a degenerate group { start: 0, count: -1 } runs setProgram + setMaterial in full
//     and returns at `drawCount < 0` before the VAO setup (WebGLRenderer.js
//     renderBufferDirect); if three kept the recorded program the executor binds the
//     VAO and draws, else three draws for real (a second setProgram is GL-silent) and
//     the record is re-taken.
//   * FULL — no / invalid record, any refusal: the untouched chain. A record whose only
//     fault is async_link's stamp (another object kind stamped the shared material) or a
//     ShaderMaterial re-upload draws through the chain and is kept; one whose material
//     version or program moves at every draw (two-pass translucency, a material drawn into
//     targets of different output colour spaces) rests on the chain for a cool-down.
// The executor STANDS IN for the three wrappers on the draws it executes, one owner per
// draw: batched_runs' observe + run layout + frame count (`batchedRunsBeforeDraw`, the
// wrapper's own code), skip_empty's empty-multidraw skip (`skipEmptyMultiDrawTake`, the
// wrapper's own decision and counter), and async_link's steady-state pass-through
// (the material's stamp, evaluated exactly as the guard evaluates it; any other case
// goes through the guard). The run draw is the same `multiDrawElementsInstancedWEBGL`
// the patched extension would issue, `renderer.info` sums the canonical counts as
// three's renderMultiDraw does, and `__batchedRuns.frame()` counts the draw once.
//
// COHERENCE WITH THREE'S PRIVATE STATE (R3 §5.5).
//   * WebGLState (program, blend/depth/cull/stencil, texture units): only three's own
//     entry points are used (state.setMaterial, textures.setTexture2D →
//     state.bindTexture). Never renderer.resetState() (it turns reversed-Z off).
//     state.setMaterial is skipped on a continuation only when the previous draw's call
//     set the same (material, front face) and nothing in between can have touched
//     WebGLState: the previous object's onAfterRender, this object's onBeforeRender and
//     the material's onBeforeRender are three's own empty prototype functions (or the
//     BatchedMesh prototype chain as installed: L1 / per-camera / three's rebuild — JS
//     only).
//   * _currentMaterialId / _currentCamera: the executor never changes material or
//     camera on its own — a continuation is by definition three's current pair — so
//     three's trackers stay true. A serial bumped on every render() entry/exit,
//     setRenderTarget, compile/compileAsync and resetState breaks every continuation
//     across those (three resets its trackers there).
//   * The VAO three believes is bound (WebGLBindingStates' private currentState): the
//     executor binds VAOs itself, so three's belief T and the GL binding G can differ.
//     Exactness needs the GL call stream to equal stock's, where three's tracker S
//     always equals G. So: (1) a bindVertexArray three issues for X is suppressed when
//     X is already bound (stock's tracker would have skipped it); (2) when three is
//     handed a draw with T ≠ G and then finds its needed state equal to T (no bind), T
//     must be bound at the exact point stock's setup would have bound it. The hand-over
//     is armed when state.setMaterial returns (a hook swapped in for that one hand-over
//     only); the bind is issued by the SETUP HOOK, every WebGLProgram's getAttributes,
//     which setup calls right after its bind decision and before any other GL call
//     (needsUpdate) — so also for setups no GL call follows (an InstancedMesh with count
//     0, an InstancedBufferGeometry with instanceCount 0, an empty multi-draw: their
//     draws return first). The first VAO-dependent GL call (buffer binds/creates, vertex
//     attrib setup, line width, the draw) stays a fallback trigger, counted in
//     `stats.vaoFixLate` (0 unless a program escaped the hook). Between setMaterial and
//     setup three issues no other GL call except a wireframe index deleteBuffer (it acts
//     on the same bound VAO in both arms). (3) deleteVertexArray of the bound VAO reverts
//     G to null, as GL does. WEBGL_multi_draw is hooked when three first fetches it
//     (renderer.extensions.get is wrapped: fetching it ourselves would move three's first
//     getExtension call).
//   * Texture units / uniform caches: three's setters and textures object are used, so
//     their caches stay exact. The batching samplers' units are the program's
//     `uniform.cache[0]` — the unit three allocated for this program in this render
//     (same program, same shadow-sampler count ⇒ same allocation).
//
// RIGS (S3.6, `?drawExecRigs`): the same executor for rigid entity parts (worldRoot's entities
// group): nothing in the path depends on a draw being static — matrices go through three's
// setters every draw, and churn cool-downs absorb fades.
//
// RUNS (S3.2, `?drawExecRuns`, sentinel render items standing for runs of consecutive owned
// opaque items) were DELETED in round 3 R3-2 (2026-10-30): exact, but no measured gain
// (docs/2026-10-26-rust-draw-exec.md §4, §10). A stale `?drawExecRuns` URL or `runs` option
// is inert: three's renderObjects reaches this wrapper once per item, as without the executor.
//
// ELIGIBILITY (conservative; everything else is a pass-through, counted by reason in
// `__drawExec.stats.refused`): the main scene; a Mesh or BatchedMesh under the static
// world roots (worldRoot's terrain / buildings / statics / cells groups; entities under
// RIGS) or under the main scene's `occlusion-proxies` group (lane X2: occlusion_cull.js's
// query boxes, back-to-back continuations); not InstancedMesh / SkinnedMesh / Points /
// Line / Sprite; no morph attributes, no instanced geometry; a built-in Mesh*Material or a
// ShaderMaterial, not wireframe, no populated uniformsGroups, no clipping planes, no
// transmission, not a transparent DoubleSide two-pass material; position active in the
// program and present in the geometry (`noPosition`: the VAO generation's premise);
// BatchedMesh needs WEBGL_multi_draw; three's batching sampler setters must be its own.
// Per draw: a ShaderMaterial with uniformsNeedUpdate, a light-probe grid, async_link's
// stamp not holding, the renderer clipping state of the current render(). An empty
// multi-draw takes the wrappers' own path before any of that (lane X2).
//
// LANE X2 (2026-10-26, docs/2026-10-26-rust-draw-exec.md §9): the TEXTURE EPOCH (a lit
// continuation after a foreign texture bind takes the state-only call), the VAO CONTENT
// GENERATION (a foreign re-setup of a shared VAO invalidates its records), cached batching
// texture binds and batched_runs lookups, `__drawExec.census(frames)`.
//
// LIFECYCLE. Material dispose (listener), VAO deletion (deleteVertexArray hook: covers
// geometry dispose and program release), texture re-creation (three's own
// setTexture2D path), geometry growth (attribute / index identity + version,
// drawRange), program change (post-check after the state-only call), context restore
// (records, trackers, hooks re-taken), resetState (records dropped, full chain until
// three's forced VAO re-setup has run), `__drawExec.off = true` (everything goes through
// the chain; the VAO coherence hooks stay until three's belief matches GL again).
//
// SAME-PROGRAM SWITCH (`?drawExecSwitch`, round 3, 2026-10-31; DEFAULT OFF, needs `?drawExec`).
// A SWITCH whose material resolves to the program three has bound (same program, same camera, same
// render() call, another material) is ~5 us of three's JS in node (5.5-6.7 ms/frame at Holtburg
// ultra on the 1070, ~434 switches/frame, ~10% of them program changes): the needsProgramChange
// compares, the environment / colour-space derivation, the by-name uniform lookups (three's uniforms
// objects are dictionary-mode: every lookup hashes), the fog colour-space conversion, the walk over
// the whole upload list. The executor does what three r184's setProgram + state.setMaterial do for
// exactly that case, in three's order:
//   textures.resetTextureUnits(); the batching samplers (through their own setters, which allocate
//   the units in three's order; batched_runs' run texture in force); receiveShadow; dfgLUT;
//   toneMappingExposure; a ShaderMaterial's light uniforms marked clean; the fog uniforms (getRGB
//   memoised on every input it reads); the material refresh (WebGLMaterials' Basic / Lambert / Toon /
//   Phong / Standard paths write for write, ShaderMaterial: uniformsNeedUpdate = false); the upload
//   list walked as WebGLUniforms.upload walks it — each container looked up by name ONCE per draw
//   (a replaced container is seen), the refresh writing into those same containers — minus the ten
//   light entries a same-camera, same-program refresh marks clean, through the program's own uniform
//   objects, so their value caches (and uniform_bind_patch's pinned / UBO setters) decide every GL
//   call as they do under three; the three matrix setters; state.setMaterial. Not written (no reader
//   before three's next refresh rewrites them, which only a program change reaches): the values of
//   uniforms the program does not use, and a built-in material's light needsUpdate flags.
// Each needsProgramChange compare is proven false per draw from public state (material / object /
// renderer / scene fields, three's materialProperties) plus two witnesses three itself leaves: the
// lights state version (a lit material's lightsStateVersion after any setProgram of this render
// call) and the light-probe-grid count (a program compiled without USE_LIGHT_PROBES_GRID, made
// current by three in this render call, proves it 0 — shader sources observed at gl.shaderSource).
// Everything not proven goes the existing SWITCH path, counted in `stats.switchRefused[reason]`
// (`plan:*` once per material + program: type, shadow samplers, an unknown or probe-grid program).
//   THREE'S MATERIAL TRACKER. three's private `_currentMaterialId` decides `refreshMaterial` at its
// next setProgram; after a same-program switch it still names three's last material (`thrMat`)
// while the GL state is the executor's (`curMat`, stock's tracker). It only matters for a hand-over
// to three on three's camera whose material is one of the two (anything else refreshes in both
// arms, and so does a program change); before such a hand-over the executor SYNCS three's tracker:
// three's own setProgram for curMat (state-only, DEGEN group; on the hand-over's own object when it
// draws curMat, else on the executor's last draw under curMat) with the program's named setter, the
// upload list and state.setMaterial stubbed — no GL call, the tracker set — and three's getProgram
// fenced (mp.programs.get: a compile or another program aborts it before any further write: the
// hand-over then binds another program and refreshes in both arms); setProgram's version stamp and
// getProgram's writes before its lookup are restored either way, so async_link and the hand-over's
// own setProgram see stock's materialProperties. The window closes at three's next setProgram,
// render() end, setRenderTarget, resetState, restore. What stays unproven — counted in
// `stats.switchSyncFailed`, 0 in every test scenario: a sync for three's tracked material that
// aborts (a render hook moved the switched material's program key mid-frame), and a sync whose
// getProgram early-out cannot be proven (no lights witness yet, or the material's lights version
// stale). In those cases three's tracker stays as it was.
//
// What this file does NOT do: S3.4, the Rust static list on R2's StaticDrawFrame
// (residency §2.8). It does not preclude it: the run state the executor draws is
// batched_runs' own (`batchedRunsBeforeDraw`), so a Rust-built list / run layout that
// batched_runs adopts reaches this GL path unchanged, and the records key on the draw
// object, not on how its list was built.

import * as THREE from "three";
import { rustFlag } from "./rust/scene_core.js";
import { batchedRunsBeforeDraw, batchedRunsCall, newBatchedRunsCache } from "./batched_runs.js";
import { skipEmptyMultiDrawTake, skipEmptyMultiDrawWouldSkip } from "./skip_empty_multidraw.js";
import { objectCombo } from "./async_link_guard.js";

/** `?drawExec` — DEFAULT ON since 2026-10-26 (rustFlag grammar: off/0/false/no is the escape). */
export function drawExecEnabled() {
  return rustFlag("drawExec", true);
}

/** `?drawExecRigs` (S3.6) — DEFAULT ON since 2026-10-26, needs `?drawExec`: worldRoot's `entities` group is an
 *  owned root too (rigid entity parts; SkinnedMesh / InstancedMesh stay refused by type). */
export function drawExecRigsEnabled() {
  return rustFlag("drawExecRigs", true);
}

/** `?drawExecSwitch` (round 3, 2026-10-31) — DEFAULT OFF, needs `?drawExec`: the same-program material
 *  switch executed (see SAME-PROGRAM SWITCH above). */
export function drawExecSwitchEnabled() {
  return rustFlag("drawExecSwitch", false);
}

// three r184 shapes the same-program switch replicates (setProgram's refresh path, WebGLMaterials,
// getUnlitUniformColorSpace, getProgram's early-out). They live in closures the install cannot read:
// tests/draw_exec_switch.test.mjs checks them against three.module.js / three.core.js, whitespace-
// normalised; the install refuses the switch on any other three REVISION.
export const THREE_SWITCH_PREMISES = Object.freeze([
  // setProgram: the refresh block as the executor replays it (refreshProgram false, camera unchanged)
  "if ( refreshMaterial || materialProperties.receiveShadow !== object.receiveShadow ) { materialProperties.receiveShadow = object.receiveShadow; p_uniforms.setValue( _gl, 'receiveShadow', object.receiveShadow ); } if ( ( material.isMeshStandardMaterial || material.isMeshLambertMaterial || material.isMeshPhongMaterial ) && material.envMap === null && scene.environment !== null ) { m_uniforms.envMapIntensity.value = scene.environmentIntensity; } // Set DFG LUT for physically-based materials if ( m_uniforms.dfgLUT !== undefined ) { m_uniforms.dfgLUT.value = getDFGLUT(); } if ( refreshMaterial ) { p_uniforms.setValue( _gl, 'toneMappingExposure', _this.toneMappingExposure ); if ( materialProperties.needsLights ) {",
  "markUniformsLightsNeedsUpdate( m_uniforms, refreshLights ); } // refresh uniforms common to several materials if ( fog && material.fog === true ) { materials.refreshFogUniforms( m_uniforms, fog ); } materials.refreshMaterialUniforms( m_uniforms, material, _pixelRatio, _height, currentRenderState.state.transmissionRenderTarget[ camera.id ] ); // light probe volume if ( materialProperties.needsLights && materialProperties.lightProbeGrid ) {",
  "WebGLUniforms.upload( _gl, getUniformList( materialProperties ), m_uniforms, textures ); } if ( material.isShaderMaterial && material.uniformsNeedUpdate === true ) {",
  "p_uniforms.setValue( _gl, 'modelViewMatrix', object.modelViewMatrix ); p_uniforms.setValue( _gl, 'normalMatrix', object.normalMatrix ); p_uniforms.setValue( _gl, 'modelMatrix', object.matrixWorld );",
  // setProgram: what runs before the refresh block for a same-program, same-camera material switch
  "textures.resetTextureUnits(); const fog = scene.fog;",
  "if ( materialProperties.needsLights ) { const objectVolume = findLightProbeGrid( currentRenderState.state.lightProbeGridArray, object ); if ( materialProperties.lightProbeGrid !== objectVolume ) { materialProperties.lightProbeGrid = objectVolume; refreshMaterial = true; } } if ( refreshProgram || _currentCamera !== camera ) {",
  "if ( object.isBatchedMesh ) { p_uniforms.setOptional( _gl, object, 'batchingTexture' ); p_uniforms.setValue( _gl, 'batchingTexture', object._matricesTexture, textures ); p_uniforms.setOptional( _gl, object, 'batchingIdTexture' ); p_uniforms.setValue( _gl, 'batchingIdTexture', object._indirectTexture, textures ); p_uniforms.setOptional( _gl, object, 'batchingColorTexture' ); if ( object._colorsTexture !== null ) { p_uniforms.setValue( _gl, 'batchingColorTexture', object._colorsTexture, textures ); } }",
  // the needsProgramChange chain, in order (each compare the executor proves false)
  "if ( material.version === materialProperties.__version ) { if ( materialProperties.needsLights && ( materialProperties.lightsStateVersion !== lights.state.version ) ) { needsProgramChange = true; } else if ( materialProperties.outputColorSpace !== colorSpace ) { needsProgramChange = true; } else if ( object.isBatchedMesh && materialProperties.batching === false ) { needsProgramChange = true; } else if ( ! object.isBatchedMesh && materialProperties.batching === true ) { needsProgramChange = true; } else if ( object.isBatchedMesh && materialProperties.batchingColor === true && object.colorTexture === null ) { needsProgramChange = true; } else if ( object.isBatchedMesh && materialProperties.batchingColor === false && object.colorTexture !== null ) { needsProgramChange = true; } else if ( object.isInstancedMesh && materialProperties.instancing === false ) { needsProgramChange = true; } else if ( ! object.isInstancedMesh && materialProperties.instancing === true ) { needsProgramChange = true; } else if ( object.isSkinnedMesh && materialProperties.skinning === false ) { needsProgramChange = true; } else if ( ! object.isSkinnedMesh && materialProperties.skinning === true ) { needsProgramChange = true; }",
  "} else if ( materialProperties.envMap !== envMap ) { needsProgramChange = true; } else if ( material.fog === true && materialProperties.fog !== fog ) { needsProgramChange = true; } else if ( materialProperties.numClippingPlanes !== undefined && ( materialProperties.numClippingPlanes !== clipping.numPlanes || materialProperties.numIntersection !== clipping.numIntersection ) ) { needsProgramChange = true; } else if ( materialProperties.vertexAlphas !== vertexAlphas ) { needsProgramChange = true; } else if ( materialProperties.vertexTangents !== vertexTangents ) { needsProgramChange = true; } else if ( materialProperties.morphTargets !== morphTargets ) { needsProgramChange = true; } else if ( materialProperties.morphNormals !== morphNormals ) { needsProgramChange = true; } else if ( materialProperties.morphColors !== morphColors ) { needsProgramChange = true; } else if ( materialProperties.toneMapping !== toneMapping ) { needsProgramChange = true; } else if ( materialProperties.morphTargetsCount !== morphTargetsCount ) { needsProgramChange = true; } else if ( !! materialProperties.lightProbeGrid !== ( currentRenderState.state.lightProbeGridArray.length > 0 ) ) { needsProgramChange = true; } } else { needsProgramChange = true; materialProperties.__version = material.version; }",
  "const colorSpace = ( _currentRenderTarget === null ) ? _this.outputColorSpace : ( _currentRenderTarget.isXRRenderTarget === true ? _currentRenderTarget.texture.colorSpace : ColorManagement.workingColorSpace );",
  "const environment = ( material.isMeshStandardMaterial || material.isMeshLambertMaterial || material.isMeshPhongMaterial ) ? scene.environment : null;",
  "let toneMapping = NoToneMapping; if ( material.toneMapped ) { if ( _currentRenderTarget === null || _currentRenderTarget.isXRRenderTarget === true ) { toneMapping = _this.toneMapping; } }",
  // getProgram: the writes before the program lookup (the sync fence restores them), the early-out
  "materialProperties.environment = ( material.isMeshStandardMaterial || material.isMeshLambertMaterial || material.isMeshPhongMaterial ) ? scene.environment : null; materialProperties.fog = scene.fog; const usePMREM = material.isMeshStandardMaterial || ( material.isMeshLambertMaterial && ! material.envMap ) || ( material.isMeshPhongMaterial && ! material.envMap ); materialProperties.envMap = environments.get( material.envMap || materialProperties.environment, usePMREM ); materialProperties.envMapRotation = ( materialProperties.environment !== null && material.envMap === null ) ? scene.environmentRotation : material.envMapRotation; if ( programs === undefined ) {",
  "let program = programs.get( programCacheKey ); if ( program !== undefined ) { // early out if program and light state is identical if ( materialProperties.currentProgram === program && materialProperties.lightsStateVersion === lightsStateVersion ) { updateCommonMaterialProperties( material, parameters ); return program; } } else {",
  "materialProperties.lightProbeGrid = currentRenderState.state.lightProbeGridArray.length > 0; materialProperties.currentProgram = program; materialProperties.uniformsList = null;",
  "parameters.numLightProbeGrids > 0 ? '#define USE_LIGHT_PROBES_GRID' : '',",
  // the light uniforms markUniformsLightsNeedsUpdate toggles (the executor skips exactly these entries)
  "uniforms.ambientLightColor.needsUpdate = value; uniforms.lightProbe.needsUpdate = value; uniforms.directionalLights.needsUpdate = value; uniforms.directionalLightShadows.needsUpdate = value; uniforms.pointLights.needsUpdate = value; uniforms.pointLightShadows.needsUpdate = value; uniforms.spotLights.needsUpdate = value; uniforms.spotLightShadows.needsUpdate = value; uniforms.rectAreaLights.needsUpdate = value; uniforms.hemisphereLights.needsUpdate = value;",
  "static upload( gl, seq, values, textures ) { for ( let i = 0, n = seq.length; i !== n; ++ i ) { const u = seq[ i ], v = values[ u.id ]; if ( v.needsUpdate !== false ) { // note: always updating when .needsUpdate is undefined u.setValue( gl, v.value, textures ); } } }",
  // WebGLMaterials (the copies below)
  "function refreshTransformUniform( map, uniform ) { if ( map.matrixAutoUpdate === true ) { map.updateMatrix(); } uniform.value.copy( map.matrix ); } function refreshFogUniforms( uniforms, fog ) { fog.color.getRGB( uniforms.fogColor.value, getUnlitUniformColorSpace( renderer ) ); if ( fog.isFog ) { uniforms.fogNear.value = fog.near; uniforms.fogFar.value = fog.far; } else if ( fog.isFogExp2 ) { uniforms.fogDensity.value = fog.density; } }",
  "if ( material.isNodeMaterial ) { material.uniformsNeedUpdate = false; } else if ( material.isMeshBasicMaterial ) { refreshUniformsCommon( uniforms, material ); } else if ( material.isMeshLambertMaterial ) { refreshUniformsCommon( uniforms, material ); if ( material.envMap ) { uniforms.envMapIntensity.value = material.envMapIntensity; } } else if ( material.isMeshToonMaterial ) { refreshUniformsCommon( uniforms, material ); refreshUniformsToon( uniforms, material ); } else if ( material.isMeshPhongMaterial ) { refreshUniformsCommon( uniforms, material ); refreshUniformsPhong( uniforms, material ); if ( material.envMap ) { uniforms.envMapIntensity.value = material.envMapIntensity; } } else if ( material.isMeshStandardMaterial ) { refreshUniformsCommon( uniforms, material ); refreshUniformsStandard( uniforms, material ); if ( material.isMeshPhysicalMaterial ) {",
  "} else if ( material.isShaderMaterial ) { material.uniformsNeedUpdate = false; // #15581 } }",
  "function refreshUniformsCommon( uniforms, material ) { uniforms.opacity.value = material.opacity; if ( material.color ) { uniforms.diffuse.value.copy( material.color ); } if ( material.emissive ) { uniforms.emissive.value.copy( material.emissive ).multiplyScalar( material.emissiveIntensity ); } if ( material.map ) { uniforms.map.value = material.map; refreshTransformUniform( material.map, uniforms.mapTransform ); } if ( material.alphaMap ) { uniforms.alphaMap.value = material.alphaMap; refreshTransformUniform( material.alphaMap, uniforms.alphaMapTransform ); } if ( material.bumpMap ) { uniforms.bumpMap.value = material.bumpMap; refreshTransformUniform( material.bumpMap, uniforms.bumpMapTransform ); uniforms.bumpScale.value = material.bumpScale; if ( material.side === BackSide ) { uniforms.bumpScale.value *= -1; } } if ( material.normalMap ) { uniforms.normalMap.value = material.normalMap; refreshTransformUniform( material.normalMap, uniforms.normalMapTransform ); uniforms.normalScale.value.copy( material.normalScale ); if ( material.side === BackSide ) { uniforms.normalScale.value.negate(); } }",
  "if ( material.displacementMap ) { uniforms.displacementMap.value = material.displacementMap; refreshTransformUniform( material.displacementMap, uniforms.displacementMapTransform ); uniforms.displacementScale.value = material.displacementScale; uniforms.displacementBias.value = material.displacementBias; } if ( material.emissiveMap ) { uniforms.emissiveMap.value = material.emissiveMap; refreshTransformUniform( material.emissiveMap, uniforms.emissiveMapTransform ); } if ( material.specularMap ) { uniforms.specularMap.value = material.specularMap; refreshTransformUniform( material.specularMap, uniforms.specularMapTransform ); } if ( material.alphaTest > 0 ) { uniforms.alphaTest.value = material.alphaTest; } const materialProperties = properties.get( material ); const envMap = materialProperties.envMap; const envMapRotation = materialProperties.envMapRotation; if ( envMap ) {",
  "if ( material.lightMap ) { uniforms.lightMap.value = material.lightMap; uniforms.lightMapIntensity.value = material.lightMapIntensity; refreshTransformUniform( material.lightMap, uniforms.lightMapTransform ); } if ( material.aoMap ) { uniforms.aoMap.value = material.aoMap; uniforms.aoMapIntensity.value = material.aoMapIntensity; refreshTransformUniform( material.aoMap, uniforms.aoMapTransform ); } }",
  "function refreshUniformsPhong( uniforms, material ) { uniforms.specular.value.copy( material.specular ); uniforms.shininess.value = Math.max( material.shininess, 1e-4 ); // to prevent pow( 0.0, 0.0 ) } function refreshUniformsToon( uniforms, material ) { if ( material.gradientMap ) { uniforms.gradientMap.value = material.gradientMap; } }",
  "function refreshUniformsStandard( uniforms, material ) { uniforms.metalness.value = material.metalness; if ( material.metalnessMap ) { uniforms.metalnessMap.value = material.metalnessMap; refreshTransformUniform( material.metalnessMap, uniforms.metalnessMapTransform ); } uniforms.roughness.value = material.roughness; if ( material.roughnessMap ) { uniforms.roughnessMap.value = material.roughnessMap; refreshTransformUniform( material.roughnessMap, uniforms.roughnessMapTransform ); } if ( material.envMap ) { //uniforms.envMap.value = material.envMap; // part of uniforms common uniforms.envMapIntensity.value = material.envMapIntensity; } }",
]);
// three.core.js (the getRGB target colour space the fog refresh uses)
export const THREE_SWITCH_CORE_PREMISES = Object.freeze([
  "function getUnlitUniformColorSpace( renderer ) { const currentRenderTarget = renderer.getRenderTarget(); if ( currentRenderTarget === null ) { // https://github.com/mrdoob/three.js/pull/23937#issuecomment-1111067398 return renderer.outputColorSpace; } // https://github.com/mrdoob/three.js/issues/27868 if ( currentRenderTarget.isXRRenderTarget === true ) { return currentRenderTarget.texture.colorSpace; } return ColorManagement.workingColorSpace; }",
  "getRGB( target, colorSpace = ColorManagement.workingColorSpace ) { ColorManagement.workingToColorSpace( _color.copy( this ), colorSpace ); target.r = _color.r; target.g = _color.g; target.b = _color.b; return target; }",
]);

// three's light uniforms markUniformsLightsNeedsUpdate toggles (by name, on the material's uniforms).
const LIGHT_IDS = Object.freeze(["ambientLightColor", "lightProbe", "directionalLights", "directionalLightShadows",
  "pointLights", "pointLightShadows", "spotLights", "spotLightShadows", "rectAreaLights", "hemisphereLights"]);
const LIGHT_ID_SET = new Set(LIGHT_IDS);
const SAMPLER_TYPES = new Set([0x8b5e, 0x8b5f, 0x8b60, 0x8b62, 0x8d66, 0x8dc1, 0x8dc4, 0x8dc5, 0x8dca, 0x8dcb, 0x8dcc, 0x8dcf, 0x8dd2, 0x8dd3, 0x8dd4, 0x8dd7]);
// the refresh paths the executor replays (WebGLMaterials.refreshMaterialUniforms' dispatch order)
const K_BASIC = 1, K_LAMBERT = 2, K_TOON = 3, K_PHONG = 4, K_STANDARD = 5, K_SHADER = 6;
const SYNC_ABORT = { hbDxSyncAbort: true };
const EMPTY_LIST = Object.freeze([]);
function hbDxSyncNoopSetValue() { /* the sync's p_uniforms.setValue: no GL */ }
function hbDxSyncNoopSetMaterial() { /* the sync's state.setMaterial: no GL */ }

// ---- WebGLMaterials (three r184) for the same-program switch -------------------------------------
// The refresh three runs on a material switch, write for write, with each uniform addressed through
// the container the upload walk looks up by name for this draw (C[ix.name]) instead of a second
// by-name lookup (three's uniforms objects are in dictionary mode: every lookup hashes). A write to a
// uniform the program does not use (not in its upload list) is dropped: three reads such a value only
// in an upload, which only a refresh that rewrites it first can reach (a program change). Texture
// matrices are still updated for every present map (Texture.updateMatrix is a public side effect).
// THREE_SWITCH_PREMISES pins the originals. refreshUniformsCommon's envMap block is left out: the
// switch proves materialProperties.envMap === null first, so three skips it too.
const REFRESHED = Object.freeze(["opacity", "diffuse", "emissive", "map", "mapTransform", "alphaMap", "alphaMapTransform",
  "bumpMap", "bumpMapTransform", "bumpScale", "normalMap", "normalMapTransform", "normalScale", "displacementMap",
  "displacementMapTransform", "displacementScale", "displacementBias", "emissiveMap", "emissiveMapTransform", "specularMap",
  "specularMapTransform", "alphaTest", "lightMap", "lightMapIntensity", "lightMapTransform", "aoMap", "aoMapIntensity",
  "aoMapTransform", "metalness", "metalnessMap", "metalnessMapTransform", "roughness", "roughnessMap", "roughnessMapTransform",
  "envMapIntensity", "specular", "shininess", "gradientMap", "fogColor", "fogNear", "fogFar", "fogDensity", "dfgLUT"]);
/** Per plan: each refreshed uniform's index in the upload list, -1 when the program does not use it. */
function refreshIndex(ids) {
  const ix = Object.create(null);
  for (const n of REFRESHED) ix[n] = ids.indexOf(n);
  // a fixed-shape object for the hot path (named loads)
  return Object.seal({ ...ix });
}
function refreshTransformIx(map, C, i) {
  if (map.matrixAutoUpdate === true) {
    map.updateMatrix();
  }
  if (i >= 0) C[i].value.copy(map.matrix);
}
function refreshCommonIx(C, ix, material) {
  if (ix.opacity >= 0) C[ix.opacity].value = material.opacity;
  if (material.color) {
    if (ix.diffuse >= 0) C[ix.diffuse].value.copy(material.color);
  }
  if (material.emissive) {
    if (ix.emissive >= 0) C[ix.emissive].value.copy(material.emissive).multiplyScalar(material.emissiveIntensity);
  }
  if (material.map) {
    if (ix.map >= 0) C[ix.map].value = material.map;
    refreshTransformIx(material.map, C, ix.mapTransform);
  }
  if (material.alphaMap) {
    if (ix.alphaMap >= 0) C[ix.alphaMap].value = material.alphaMap;
    refreshTransformIx(material.alphaMap, C, ix.alphaMapTransform);
  }
  if (material.bumpMap) {
    if (ix.bumpMap >= 0) C[ix.bumpMap].value = material.bumpMap;
    refreshTransformIx(material.bumpMap, C, ix.bumpMapTransform);
    if (ix.bumpScale >= 0) {
      const u = C[ix.bumpScale];
      u.value = material.bumpScale;
      if (material.side === THREE.BackSide) {
        u.value *= -1;
      }
    }
  }
  if (material.normalMap) {
    if (ix.normalMap >= 0) C[ix.normalMap].value = material.normalMap;
    refreshTransformIx(material.normalMap, C, ix.normalMapTransform);
    if (ix.normalScale >= 0) {
      const u = C[ix.normalScale];
      u.value.copy(material.normalScale);
      if (material.side === THREE.BackSide) {
        u.value.negate();
      }
    }
  }
  if (material.displacementMap) {
    if (ix.displacementMap >= 0) C[ix.displacementMap].value = material.displacementMap;
    refreshTransformIx(material.displacementMap, C, ix.displacementMapTransform);
    if (ix.displacementScale >= 0) C[ix.displacementScale].value = material.displacementScale;
    if (ix.displacementBias >= 0) C[ix.displacementBias].value = material.displacementBias;
  }
  if (material.emissiveMap) {
    if (ix.emissiveMap >= 0) C[ix.emissiveMap].value = material.emissiveMap;
    refreshTransformIx(material.emissiveMap, C, ix.emissiveMapTransform);
  }
  if (material.specularMap) {
    if (ix.specularMap >= 0) C[ix.specularMap].value = material.specularMap;
    refreshTransformIx(material.specularMap, C, ix.specularMapTransform);
  }
  if (material.alphaTest > 0) {
    if (ix.alphaTest >= 0) C[ix.alphaTest].value = material.alphaTest;
  }
  // (materialProperties.envMap: null, proven — three's `if ( envMap ) { … }` is skipped)
  if (material.lightMap) {
    if (ix.lightMap >= 0) C[ix.lightMap].value = material.lightMap;
    if (ix.lightMapIntensity >= 0) C[ix.lightMapIntensity].value = material.lightMapIntensity;
    refreshTransformIx(material.lightMap, C, ix.lightMapTransform);
  }
  if (material.aoMap) {
    if (ix.aoMap >= 0) C[ix.aoMap].value = material.aoMap;
    if (ix.aoMapIntensity >= 0) C[ix.aoMapIntensity].value = material.aoMapIntensity;
    refreshTransformIx(material.aoMap, C, ix.aoMapTransform);
  }
}
/** WebGLMaterials.refreshMaterialUniforms for the kinds the switch takes (three's dispatch order). */
function refreshMaterialIx(kind, C, ix, material) {
  switch (kind) {
    case K_BASIC:
      refreshCommonIx(C, ix, material);
      break;
    case K_LAMBERT:
      refreshCommonIx(C, ix, material);
      if (material.envMap) { if (ix.envMapIntensity >= 0) C[ix.envMapIntensity].value = material.envMapIntensity; }
      break;
    case K_TOON:
      refreshCommonIx(C, ix, material);
      if (material.gradientMap) { if (ix.gradientMap >= 0) C[ix.gradientMap].value = material.gradientMap; }
      break;
    case K_PHONG:
      refreshCommonIx(C, ix, material);
      if (ix.specular >= 0) C[ix.specular].value.copy(material.specular);
      if (ix.shininess >= 0) C[ix.shininess].value = Math.max(material.shininess, 1e-4); // to prevent pow( 0.0, 0.0 )
      if (material.envMap) { if (ix.envMapIntensity >= 0) C[ix.envMapIntensity].value = material.envMapIntensity; }
      break;
    case K_STANDARD:
      refreshCommonIx(C, ix, material);
      // refreshUniformsStandard
      if (ix.metalness >= 0) C[ix.metalness].value = material.metalness;
      if (material.metalnessMap) {
        if (ix.metalnessMap >= 0) C[ix.metalnessMap].value = material.metalnessMap;
        refreshTransformIx(material.metalnessMap, C, ix.metalnessMapTransform);
      }
      if (ix.roughness >= 0) C[ix.roughness].value = material.roughness;
      if (material.roughnessMap) {
        if (ix.roughnessMap >= 0) C[ix.roughnessMap].value = material.roughnessMap;
        refreshTransformIx(material.roughnessMap, C, ix.roughnessMapTransform);
      }
      if (material.envMap) { if (ix.envMapIntensity >= 0) C[ix.envMapIntensity].value = material.envMapIntensity; }
      break;
    case K_SHADER:
      material.uniformsNeedUpdate = false; // #15581
      break;
    default:
      break;
  }
}

// three r184 renderBufferDirect / renderMultiDraw shapes the executor relies on,
// checked against the innermost function's source at install (three drift => refuse).
export const THREE_PREMISES = Object.freeze([
  "const frontFaceCW = ( object.isMesh && object.matrixWorld.determinant() < 0 );",
  "const program = setProgram( camera, scene, geometry, material, object );",
  "state.setMaterial( material, frontFaceCW );",
  "if ( drawCount < 0 || drawCount === Infinity ) return;",
  "bindingStates.setup( object, material, program, geometry, index );",
  "renderer.renderMultiDraw( object._multiDrawStarts, object._multiDrawCounts, object._multiDrawCount );",
  "renderer.render( drawStart, drawCount );",
]);

// three r184 shapes OUTSIDE renderBufferDirect the setup hook relies on (COHERENCE (2)).
// They live in closures (WebGLBindingStates, WebGLPrograms) the install cannot read, so
// tests/draw_exec.test.mjs checks them against three.module.js, whitespace-normalised.
export const THREE_SETUP_PREMISES = Object.freeze([
  // setup: the bind decision, then needsUpdate, nothing in between ...
  "function setup( object, material, program, geometry, index ) { let updateBuffers = false; const state = getBindingState( object, geometry, program, material ); if ( currentState !== state ) { currentState = state; bindVertexArrayObject( currentState.object ); } updateBuffers = needsUpdate( object, geometry, program, index );",
  // ... and needsUpdate asks program.getAttributes() before any GL call
  "function needsUpdate( object, geometry, program, index ) { const cachedAttributes = currentState.attributes; const geometryAttributes = geometry.attributes; let attributesNum = 0; const programAttributes = program.getAttributes();",
  // every program three creates lands on the list renderer.info.programs exposes
  "program = new WebGLProgram( renderer, cacheKey, parameters, bindingStates ); programs.push( program );",
  "info.programs = programCache.programs;",
  // getAttributes is each program's own (replaceable) property
  "this.getAttributes = function () {",
  // setProgram makes the program's first use (getUniforms) before setup asks for attributes
  "const p_uniforms = program.getUniforms(),",
]);

// The wrapper chain the executor stands in for, outermost first (index.js install order).
const KNOWN_CHAIN = ["batchedRuns", "skipEmpty", "asyncLink"];

const STATIC_ROOT_NAMES = Object.freeze(["terrain", "buildings", "statics", "cells"]);
// Main-scene children owned too (2026-10-26, lane X2), matched by name at classification:
// occlusion_cull.js's proxies — one shared box, one shared material, drawn back to back at the
// end of the transparent list (continuations); their query hooks (beginQuery / endQuery) run in
// renderObject around the draw, outside renderBufferDirect, so they bracket the executor's
// draw exactly as they bracket three's.
const SCENE_ROOT_NAMES = Object.freeze(["occlusion-proxies"]);


const GL_TRIANGLES = 0x0004;
const GL_UNSIGNED_BYTE = 0x1401, GL_UNSIGNED_SHORT = 0x1403, GL_UNSIGNED_INT = 0x1405;
const GL_TEXTURE_2D = 0x0de1, GL_TEXTURE0 = 0x84c0;
// The state-only group: the shape of three's geometry.groups entries (addGroup), so three's
// `group.start` / `group.count` loads stay on the shape they already see.
const DEGEN = { start: 0, count: -1, materialIndex: 0 };
const MAX_RECS_PER_OBJECT = 8;

function bytesOfIndexType(t) {
  return t === GL_UNSIGNED_INT ? 4 : t === GL_UNSIGNED_SHORT ? 2 : t === GL_UNSIGNED_BYTE ? 1 : 0;
}
function indexTypeOfArray(a) {
  return a instanceof Uint32Array ? GL_UNSIGNED_INT : a instanceof Uint16Array ? GL_UNSIGNED_SHORT
    : a instanceof Uint8Array ? GL_UNSIGNED_BYTE : 0;
}

/**
 * The census tag's name part: `name` without its trailing id segments — each an optional one of
 * `-_.:#/ `, an optional `0x`, then a hex run holding a digit — cut to 40 chars. One backwards
 * scan. The regex it replaces, `/([-_.:#/ ]?(0x)?[0-9a-fA-F]*[0-9][0-9a-fA-F]*)+$/`, gives the same
 * result but backtracks exponentially on a long hex run that ends in a non-match (a 29-char name:
 * 0.65 s); the 1070 census of 2026-10-29 crawled at ~1 frame/s under it.
 */
export function censusName(name) {
  if (typeof name !== "string" || name.length === 0) return "";
  let end = name.length;
  for (;;) {
    let s = end, digit = false;
    while (s > 0) {
      const c = name.charCodeAt(s - 1);
      const d = c >= 48 && c <= 57;
      if (!d && !(c >= 65 && c <= 70) && !(c >= 97 && c <= 102)) break;
      if (d) digit = true;
      s -= 1;
    }
    if (!digit) break;
    if (s >= 2 && name.charCodeAt(s - 1) === 120 && name.charCodeAt(s - 2) === 48) s -= 2; // "0x"
    if (s > 0 && "-_.:#/ ".indexOf(name[s - 1]) >= 0) s -= 1;
    end = s;
  }
  return name.slice(0, end).slice(0, 40);
}

/** One record per drawn (object, material, group); fixed shape. */
function newRecord() {
  return {
    isDxRefusal: false, refused: null, next: null,
    material: null, group: null, geometry: null,
    matVersion: -1, mTok: null,
    mp: null, program: null, glProgram: null, pu: null,
    uMV: undefined, uNM: undefined, uMM: undefined, uRS: undefined,
    batched: false, b0: undefined, b1: undefined, b2: undefined, colorsTex: null,
    // the batching textures' three properties objects, cached per texture (bindBatching)
    tx0: null, tp0: null, tk0: null, tx1: null, tp1: null, tk1: null, tx2: null, tp2: null, tk2: null,
    brc: null, // batched_runs' per-mesh lookup cache (newBatchedRunsCache)
    // the program's attributes: the usual names as named loads (aMask bits), the rest generic
    aMask: 0, aPos: null, aPosD: null, aNor: null, aNorD: null, aUv: null, aUvD: null, aCol: null, aColD: null,
    attrNames: null, attrRefs: null, attrData: null, vT: false, vA: false,
    index: null, indexVersion: -1, drawStart: 0, drawCount: 0, ds0: 0, de0: 0,
    vao: null, vTok: null, vGen: 0, type: 0, bpe: 1, shadowMaps: false,
    combo: 0, comboE: 0, shader: false, epoch: 0, hits: 0,
    churn: 0, cool: 0,
    // ?drawExecSwitch: the switch plan (buildPlan), or its refusal for this upload list
    sw: null, swNo: null, swNoList: null, swHits: 0,
  };
}
// A record whose material version moves draw after draw (three's transparent DoubleSide
// two-pass bumps it twice per frame; fades that set needsUpdate every frame), or whose
// program three moves at every switch (one material drawn into targets of different output
// colour spaces: two programs), would be re-taken on every draw — the program case at the
// price of a second setProgram. After CHURN_LIMIT of those in a row the record rests on the
// chain for CHURN_COOL of its draws, then tries again.
const CHURN_LIMIT = 3;
const CHURN_COOL = 240;

/**
 * Install on the main renderer, right after installBatchedRuns (index.js). Returns the
 * api (also `window.__drawExec`), or null when the flag is off.
 * @param {object} renderer three r184 WebGLRenderer
 * @param {() => object} getMainScene the world scene (index.js `() => scene`)
 * @param {{force?: boolean, staticRoots?: () => Iterable<object>}} [opts]
 */
export function installDrawExec(renderer, getMainScene, opts = {}) {
  if (!(opts.force === true || drawExecEnabled())) return null;
  if (!renderer || typeof renderer.renderBufferDirect !== "function") return null;
  if (renderer.__hbDrawExec) return renderer.__hbDrawExec;

  const refuseInstall = (reason) => {
    // eslint-disable-next-line no-console
    console.warn(`[drawExec] not installed: ${reason} — every draw stays on three's chain`);
    const api = { installed: false, reason, stats: null, off: true };
    try { if (typeof window !== "undefined") window.__drawExec = api; } catch (_) { /* diag only */ }
    return api;
  };

  // ---- the chain this executor stands in for --------------------------------------------
  const top = renderer.renderBufferDirect;
  const tags = [];
  let three = top;
  while (typeof three === "function" && typeof three.__hbRbdTag === "string" && typeof three.__hbRbdInner === "function") {
    tags.push(three.__hbRbdTag);
    three = three.__hbRbdInner;
  }
  {
    let k = 0;
    for (const t of tags) {
      while (k < KNOWN_CHAIN.length && KNOWN_CHAIN[k] !== t) k++;
      if (k >= KNOWN_CHAIN.length) return refuseInstall(`unexpected wrapper order ${tags.join(" > ")}`);
      k++;
    }
  }
  let src = "";
  try { src = Function.prototype.toString.call(three); } catch (_) { src = ""; }
  for (const p of THREE_PREMISES) if (!src.includes(p)) return refuseInstall(`three drift (renderBufferDirect lacks "${p.slice(0, 48)}…") or an unknown wrapper in the chain`);
  const hasRuns = tags.includes("batchedRuns");
  const hasSkip = tags.includes("skipEmpty");
  const asyncApi = tags.includes("asyncLink") ? (renderer.__hbAsyncLink || null) : null;
  // async_link's live `off` seam, read once per render() (its stamp test runs per draw).
  let asyncOn = asyncApi !== null && !asyncApi.off;
  if (tags.includes("asyncLink") && (!asyncApi || !("comboEpoch" in asyncApi))) return refuseInstall("async_link_guard without the comboEpoch seam");

  const gl = renderer.getContext();
  let info = renderer.info;
  let state = renderer.state;
  let ext = null;
  let multiDraw = false;
  let textures = null; // three's WebGLTextures (captured from a batching sampler setter)
  let texSet0 = null;  // its own setTexture2D at capture (the cached batching binds stand in for it only)
  // ?drawExecSwitch (SAME-PROGRAM SWITCH above): only on the three revision its copies were checked against.
  const swWanted = opts.switch === true || (opts.switch !== false && drawExecSwitchEnabled());
  const swOn = swWanted && THREE.REVISION === "184";

  // ---- per-session state ------------------------------------------------------------------
  // Structural refusals are memoized on the object: one sentinel per reason (per executor),
  // counting its own draws (a monomorphic increment, not a keyed one).
  const _refusals = Object.create(null);
  const refusal = (reason) => {
    let r = _refusals[reason];
    if (r === undefined) { r = { isDxRefusal: true, refused: reason, n: 0 }; _refusals[reason] = r; }
    return r;
  };
  const ctl = { off: false, verify: 0 };
  const stats = {
    installed: true,
    draws: 0, fast: 0, stateOnly: 0, full: 0, passOther: 0, empty: 0,
    recorded: 0, progChanged: 0, captured: 0, smSkips: 0,
    vaoBinds: 0, vaoSuppressed: 0, vaoFixes: 0, vaoFixLate: 0, texDemoted: 0,
    restores: 0, resets: 0, errors: 0,
    verifyChecks: 0, verifyFails: 0,
    // ?drawExecSwitch: executed same-program switches, the switches left to the state-only path (by
    // reason), the plans built, three-tracker syncs before a hand-over (Own: the hand-over draws the
    // switched material; Tracked: it draws three's tracked one), syncs the getProgram fence aborted
    // (exact for Own: the hand-over then binds another program), and syncs that could not make
    // three's tracker exact (the documented residual; 0 expected)
    switchOn: swOn, sameProgramSwitches: 0, switchRefused: Object.create(null), switchPlans: 0,
    switchSyncs: 0, switchSyncsOwn: 0, switchSyncsTracked: 0, switchSyncAborts: 0, switchSyncFailed: 0,
    invalid: Object.create(null),
    refusedRec: Object.create(null), // per (object, material) refusals, by reason
    /** Every draw handed to the chain unexecuted: structural refusals (counted on their
     *  sentinels) + everything else (`passOther`). */
    get passThrough() {
      let n = this.passOther;
      for (const k in _refusals) n += _refusals[k].n;
      return n;
    },
    get refused() {
      // Structural refusals count on their sentinels, per-record ones here.
      const o = Object.create(null);
      for (const k in _refusals) if (_refusals[k].n > 0) o[k] = _refusals[k].n;
      for (const k in this.refusedRec) o[k] = (o[k] || 0) + this.refusedRec[k];
      return o;
    },
    chain: tags.slice(),
  };
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  let serial = 0;      // continuation chains never cross a render() / target / reset
  let recEpoch = 1;    // all records from before a restore / resetState die
  let forcePending = false; // resetState: three's next setup re-runs the attribute setup

  // three's last setProgram (state.useProgram hook) and the pair it set.
  let spCount = 0, spLastProg = null;
  let lastGlProg = null, lastMat = null, lastCam = null, lastSerial = -1;
  // The last state.setMaterial (by three or the executor): material, object (its front face is
  // re-derived from the unchanged matrixWorld), serial, and the renderBufferDirect call it was
  // made in (stats.draws at that call).
  // A continuation skips setMaterial when that call was the previous draw's, for the same
  // material and front face, and only stock no-op hooks (or the BatchedMesh prototype chain as
  // installed: L1 / per-camera / three's rebuild, all JS) ran in between: WebGLState holds
  // exactly what it would set.
  let smMat = null, smObj = null, smSerial = -1, smDraw = -1, smFF = -1;
  // ?drawExecSwitch — three's material tracker (SAME-PROGRAM SWITCH above): `thrMat` is the material
  // of three's last setProgram (its `_currentMaterialId`), `curMat` the one whose refresh GL holds
  // (stock's tracker); null after three resets it (render() end, setRenderTarget) or the executor
  // stops tracking (resetState, restore). They differ only after a same-program switch, until three's
  // next setProgram. `swObj` / `swScene`: the last draw the executor issued under curMat (the sync's
  // object when the hand-over is three's tracked material). Witnesses for the switch's proof: `lsvW`,
  // the lights state version a lit material carries after a setProgram in render call `lsvSerial`;
  // `dfgLut`, three's DFG LUT (the module-level texture setProgram writes into dfgLUT uniforms).
  let thrMat = null, curMat = null, swObj = null, swScene = null;
  let lsvW = -1, lsvSerial = -1, dfgLut = null;
  let rcEver = false; // renderer clipping ever on in this session (three's clipping plane counts then unknown)
  let syncing = false, syncProg = null; // inside a tracker sync: three must keep this program
  const O3D_BEFORE = THREE.Object3D.prototype.onBeforeRender;
  const O3D_AFTER = THREE.Object3D.prototype.onAfterRender;
  const MAT_BEFORE = THREE.Material.prototype.onBeforeRender;
  const BM_BEFORE = THREE.BatchedMesh.prototype.onBeforeRender;

  // VAO model: T = what three's bindingStates believes is bound, G = what is bound.
  let T = null, G = null;
  let armed = false;
  const vaoLife = new WeakMap();
  const matLife = new WeakMap();

  // Draw observation (the full chain's draw, for the record).
  // Draw observation (the full chain's draw, for the record): only while `observing`.
  let observing = false;
  let drawCalls = 0, lastDrawType = 0, lastDrawKind = 0, lastDrawCount = -1, lastDrawOffset = -1, lastDrawN = -1;

  // ---- GL hooks (own properties on the context; three looks its methods up per call) --------
  const base = Object.create(null);
  const hook = (name, make) => {
    const orig = gl[name];
    if (typeof orig !== "function") return;
    base[name] = orig;
    gl[name] = make(orig);
  };
  const fix = () => {
    armed = false;
    if (T !== G) { base.bindVertexArray.call(gl, T); G = T; stats.vaoFixes += 1; }
  };
  // The fallback triggers below (see COHERENCE (2)): reached armed only if three's setup ran
  // without passing the setup hook (a program not adopted). Counted, expected to stay 0.
  const lateFix = () => {
    if (T !== G) stats.vaoFixLate += 1;
    fix();
  };
  // ---- the setup hook (COHERENCE (2)) ------------------------------------------------------
  // three's WebGLBindingStates.setup makes its bind decision and then, before any other GL
  // call, asks the program for its attributes (needsUpdate → program.getAttributes()). Every
  // WebGLProgram three creates is pushed onto renderer.info.programs (WebGLPrograms
  // .acquireProgram), so wrapping each program's own getAttributes there puts a hook at
  // exactly the point where stock's setup binds the VAO three skipped (T current, G ≠ T).
  // This includes setups no VAO-dependent call follows: an InstancedMesh with count 0, an
  // InstancedBufferGeometry with instanceCount 0, a BatchedMesh with no multi-draw ranges —
  // their draws return before any GL call.
  const hookedPrograms = new WeakSet();
  const hookProgram = (p) => {
    if (p === null || typeof p !== "object" || hookedPrograms.has(p)) return;
    const ga = p.getAttributes;
    if (typeof ga !== "function") return;
    hookedPrograms.add(p);
    const w = function hbDxGetAttributes() {
      if (armed) fix();
      return ga.call(this);
    };
    w.__hbDxInner = ga;
    p.getAttributes = w;
  };
  let progList = null;
  const adoptPrograms = (list) => {
    if (!Array.isArray(list) || list === progList) return;
    if (progList !== null) delete progList.push;
    progList = list;
    for (let i = 0; i < list.length; i++) hookProgram(list[i]);
    const push0 = list.push;
    Object.defineProperty(list, "push", {
      value: function hbDxProgramsPush() {
        for (let i = 0; i < arguments.length; i++) hookProgram(arguments[i]);
        return push0.apply(this, arguments);
      },
      configurable: true, writable: true, enumerable: false,
    });
  };
  hook("bindVertexArray", (orig) => function hbDxBindVertexArray(vao) {
    // Only three's WebGLBindingStates binds VAOs in this app: its tracker now names `vao`.
    T = vao;
    armed = false;
    if (vao === G) { stats.vaoSuppressed += 1; return; }
    G = vao;
    return orig.call(this, vao);
  });
  hook("deleteVertexArray", (orig) => function hbDxDeleteVertexArray(vao) {
    if (vao === G) G = null; // GL: deleting the bound VAO reverts the binding to the default
    const t = vaoLife.get(vao);
    if (t !== undefined) { t.dead = true; t.gen += 1; vaoLife.delete(vao); }
    return orig.call(this, vao);
  });
  // ---- the VAO content generation (2026-10-26, lane X2; repro review3/r4_shared_vao_swapback) ----
  // A record's VAO is three's binding state for (geometry, program). three re-points it only in a
  // setup whose needsUpdate finds the state's attribute cache different from the geometry — and
  // the cache is shared by EVERY object drawing that geometry with that program, so another
  // object (a foreign mesh sharing geometry + material whose hooks swap an attribute or the index
  // around its own draw) can re-save it. Stock's next setup for the recorded object then finds the
  // cache stale and re-points the VAO back; the record (attributes, index: all as recorded) cannot
  // see it. So the calls a re-save issues — vertexAttribPointer / vertexAttribIPointer, and
  // disableVertexAttribArray — bump the generation of the VAO bound in GL (G: after a hand-over
  // fix, three's own), and a record is valid only at the generation it was taken at. EXACT, not
  // heuristic: the recorded state has its position location enabled (record refusal
  // `noPosition` otherwise), and a re-save with other attributes runs setupVertexAttributes
  // with that VAO bound, which either points position again (a present, uploaded position) or
  // disables its location (disableUnusedAttributes) — no re-save is silent. enable, divisor and
  // ELEMENT_ARRAY_BUFFER binds only ever come with one of those (three issues them in the same
  // setup), so they need no bump. A raw foreign call on a bound VAO is invisible to three's cache
  // in both arms alike (stock does not re-point either), so it needs none either. Steady state:
  // nothing re-points, the hooks below run only in re-setups, and the per-draw check replaces the
  // `dead` read (deletion bumps the generation too).
  const vaoWrite = () => {
    if (G !== null) { const t = vaoLife.get(G); if (t !== undefined) t.gen += 1; }
  };
  // ---- the texture epoch (2026-10-26, lane X2; repro review3/r5_shadow_unit_hook) ----------------
  // setProgram binds a lit program's shadow-map samplers (directional / spot / point shadow
  // maps, units 0.. — allocated first) on EVERY draw, through three's bind cache: GL-silent while
  // the units still hold them. A continuation skips setProgram, so it is exact only if nothing
  // re-bound a texture unit since the draw it continues (the batching binds of that draw and of
  // the continuation itself land on units after the shadow ones). `texEpoch` counts every GL
  // texture bind; `texSnap` is its value when the last program-setting draw ended (three's draw,
  // or a continuation after its own binds). A record with shadow samplers continues only at
  // `texEpoch === texSnap`; otherwise the draw takes the state-only call (three's own setProgram
  // re-binds them, exactly). The hook goes in with the first such record (shadows on): with
  // shadows off (the default) nothing is hooked and nothing is counted.
  let texEpoch = 0, texSnap = 0, texHooked = false;
  const hookTextureEpoch = () => {
    texHooked = true;
    hook("bindTexture", (orig) => function hbDxBindTexture(t, x) { texEpoch += 1; return orig.call(this, t, x); });
  };
  // The VAO-dependent calls three's setup / draw can issue first (see COHERENCE).
  hook("createBuffer", (orig) => function hbDxCreateBuffer() { if (armed) lateFix(); return orig.call(this); });
  hook("bindBuffer", (orig) => function hbDxBindBuffer(t, b) { if (armed) lateFix(); return orig.call(this, t, b); });
  hook("enableVertexAttribArray", (orig) => function (i) { if (armed) lateFix(); return orig.call(this, i); });
  hook("disableVertexAttribArray", (orig) => function (i) { if (armed) lateFix(); vaoWrite(); return orig.call(this, i); });
  hook("vertexAttribPointer", (orig) => function (i, s, t, n, st, o) { if (armed) lateFix(); vaoWrite(); return orig.call(this, i, s, t, n, st, o); });
  hook("vertexAttribIPointer", (orig) => function (i, s, t, st, o) { if (armed) lateFix(); vaoWrite(); return orig.call(this, i, s, t, st, o); });
  hook("vertexAttribDivisor", (orig) => function (i, d) { if (armed) lateFix(); return orig.call(this, i, d); });
  hook("vertexAttrib1fv", (orig) => function (i, v) { if (armed) lateFix(); return orig.call(this, i, v); });
  hook("vertexAttrib2fv", (orig) => function (i, v) { if (armed) lateFix(); return orig.call(this, i, v); });
  hook("vertexAttrib3fv", (orig) => function (i, v) { if (armed) lateFix(); return orig.call(this, i, v); });
  hook("vertexAttrib4fv", (orig) => function (i, v) { if (armed) lateFix(); return orig.call(this, i, v); });
  hook("lineWidth", (orig) => function (w) { if (armed) lateFix(); return orig.call(this, w); });
  hook("drawArrays", (orig) => function hbDxDrawArrays(m, f, c) {
    if (armed) lateFix();
    if (observing) { drawCalls++; lastDrawKind = 1; lastDrawType = 0; lastDrawCount = c; lastDrawOffset = f; }
    return orig.call(this, m, f, c);
  });
  hook("drawElements", (orig) => function hbDxDrawElements(m, c, t, o) {
    if (armed) lateFix();
    if (observing) { drawCalls++; lastDrawKind = 2; lastDrawType = t; lastDrawCount = c; lastDrawOffset = o; }
    return orig.call(this, m, c, t, o);
  });
  hook("drawArraysInstanced", (orig) => function (m, f, c, n) { if (armed) lateFix(); if (observing) { drawCalls++; lastDrawKind = 3; } return orig.call(this, m, f, c, n); });
  hook("drawElementsInstanced", (orig) => function (m, c, t, o, n) { if (armed) lateFix(); if (observing) { drawCalls++; lastDrawKind = 4; lastDrawType = t; } return orig.call(this, m, c, t, o, n); });
  hook("drawRangeElements", (orig) => function (m, s, e, c, t, o) { if (armed) lateFix(); if (observing) { drawCalls++; lastDrawKind = 5; lastDrawType = t; } return orig.call(this, m, s, e, c, t, o); });
  const hDE = gl.drawElements, hDA = gl.drawArrays; // the executor's own hooks (drawOnly calls past them)
  // ?drawExecSwitch: which GL programs three built, and which with a light probe grid (the define
  // three's prefix carries when currentRenderState's lightProbeGridArray was non-empty at getProgram).
  // Pure observers on program creation; programs linked before the install stay unknown (refused).
  const knownProgs = new WeakSet(), probeProgs = new WeakSet(), probeShaders = new WeakSet();
  if (swOn) {
    // (transparent wrappers: the wrapped function's own markers are copied — uniform_bind_patch tells
    // its own shaderSource wrapper by `__hbLightUbo` and would inject its define twice otherwise)
    hook("shaderSource", (orig) => Object.assign(function hbDxShaderSource(s, source) {
      if (typeof source === "string" && source.includes("#define USE_LIGHT_PROBES_GRID")) probeShaders.add(s);
      return orig.call(this, s, source);
    }, orig));
    hook("attachShader", (orig) => Object.assign(function hbDxAttachShader(p, s) {
      if (p !== null && typeof p === "object") { knownProgs.add(p); if (probeShaders.has(s)) probeProgs.add(p); }
      return orig.call(this, p, s);
    }, orig));
  }

  // WEBGL_multi_draw's instanced entry points as the executor hooked them (drawOnly calls past its
  // own hook while it is the installed one; batched_runs patches only the non-instanced pair).
  let xDEI = null, xDEIh = null, xDAI = null, xDAIh = null;
  const hookExt = (e) => {
    if (!e || e.__hbDrawExec === true) return;
    const wrap = (name, make) => { const orig = e[name]; if (typeof orig === "function") e[name] = make(orig); };
    wrap("multiDrawArraysWEBGL", (orig) => function (m, f, fo, c, co, n) {
      if (armed) lateFix(); if (observing) { drawCalls++; lastDrawKind = 6; lastDrawType = 0; lastDrawN = n; }
      return orig.call(this, m, f, fo, c, co, n);
    });
    wrap("multiDrawElementsWEBGL", (orig) => function (m, c, co, t, o, oo, n) {
      if (armed) lateFix(); if (observing) { drawCalls++; lastDrawKind = 7; lastDrawType = t; lastDrawN = n; }
      return orig.call(this, m, c, co, t, o, oo, n);
    });
    wrap("multiDrawArraysInstancedWEBGL", (orig) => keepInstanced("multiDrawArraysInstancedWEBGL", orig, function (m, f, fo, c, co, i, io, n) {
      if (armed) lateFix(); if (observing) { drawCalls++; lastDrawKind = 8; lastDrawType = 0; lastDrawN = n; }
      return orig.call(this, m, f, fo, c, co, i, io, n);
    }));
    wrap("multiDrawElementsInstancedWEBGL", (orig) => keepInstanced("multiDrawElementsInstancedWEBGL", orig, function (m, c, co, t, o, oo, i, io, n) {
      if (armed) lateFix(); if (observing) { drawCalls++; lastDrawKind = 9; lastDrawType = t; lastDrawN = n; }
      return orig.call(this, m, c, co, t, o, oo, i, io, n);
    }));
    Object.defineProperty(e, "__hbDrawExec", { value: true, configurable: true });
  };
  // (set by the two instanced wraps through these)
  const keepInstanced = (name, orig, hooked) => {
    if (name === "multiDrawElementsInstancedWEBGL") { xDEI = orig; xDEIh = hooked; } else { xDAI = orig; xDAIh = hooked; }
    return hooked;
  };
  // WEBGL_multi_draw is hooked when three (or batched_runs) first fetches it, through
  // renderer.extensions.get: fetching it here would move three's first getExtension call
  // (a GL command) to another point of the stream. three fetches it before every
  // multi-draw, so the hook is in place before the first one.
  const hookExtensions = (exts) => {
    if (!exts || typeof exts.get !== "function" || exts.__hbDrawExec === true) return;
    const get0 = exts.get;
    exts.get = function hbDxExtensionsGet(name) {
      const e = get0.call(this, name);
      if (name === "WEBGL_multi_draw" && e !== null && e !== undefined && e !== ext) { ext = e; multiDraw = true; hookExt(e); }
      return e;
    };
    Object.defineProperty(exts, "__hbDrawExec", { value: get0, configurable: true });
  };
  const refreshExt = () => {
    ext = null;
    multiDraw = false;
    hookExtensions(renderer.extensions);
  };

  // ---- WebGLState hooks (re-taken on a context restore: three builds a new state) ----------
  // The hand-over arming (see COHERENCE) rides state.setMaterial only for a hand-over that
  // starts with T ≠ G: the hook is swapped in for that one call and out again, so every
  // other setMaterial runs unwrapped. It calls whatever setMaterial was installed then.
  let swapCur = null;
  const armingSetMaterial = function hbDxArmingSetMaterial(material, frontFaceCW) {
    swapCur.call(this, material, frontFaceCW);
    if (T !== G) armed = true;
  };
  const armHandover = () => {
    if (T !== G && state.setMaterial !== armingSetMaterial) { swapCur = state.setMaterial; state.setMaterial = armingSetMaterial; }
  };
  const endHandover = () => {
    armed = false;
    if (swapCur !== null) { if (state.setMaterial === armingSetMaterial) state.setMaterial = swapCur; swapCur = null; }
  };
  const hookState = (s) => {
    if (!s || s.__hbDrawExec === true) return;
    const up = s.useProgram;
    s.useProgram = function hbDxUseProgram(program) {
      // (a tracker sync whose setProgram would move the program: aborted before any GL call)
      if (syncing && program !== syncProg) throw SYNC_ABORT;
      spCount++;
      spLastProg = program;
      return up.call(this, program);
    };
    Object.defineProperty(s, "__hbDrawExec", { value: { up }, configurable: true });
  };
  hookState(state);
  refreshExt();
  adoptPrograms(info.programs);

  // ---- renderer hooks: the serial ----------------------------------------------------------
  const render0 = renderer.render;
  // three resets its material tracker at the end of every render() that ran (info.render.frame moved:
  // the early returns come before the bump) and of every setRenderTarget: so does the executor.
  const trackerReset = () => { thrMat = null; curMat = null; swObj = null; swScene = null; };
  renderer.render = function hbDxRender() {
    serial++;
    asyncOn = asyncApi !== null && !asyncApi.off;
    if (renderer.renderLists !== hookedLists) hookRenderLists(renderer.renderLists);
    const f0 = info.render.frame;
    try { return render0.apply(this, arguments); } finally { serial++; if (info.render.frame !== f0) trackerReset(); }
  };
  const srt0 = renderer.setRenderTarget;
  renderer.setRenderTarget = function hbDxSetRenderTarget() {
    serial++;
    try { return srt0.apply(this, arguments); } finally { trackerReset(); }
  };
  const compile0 = renderer.compile;
  if (typeof compile0 === "function") renderer.compile = function hbDxCompile() { serial++; return compile0.apply(this, arguments); };
  const compileAsync0 = renderer.compileAsync;
  if (typeof compileAsync0 === "function") renderer.compileAsync = function hbDxCompileAsync() { serial++; return compileAsync0.apply(this, arguments); };
  const reset0 = renderer.resetState;
  if (typeof reset0 === "function") {
    renderer.resetState = function hbDxResetState() {
      serial++; recEpoch++; forcePending = true; stats.resets += 1;
      // (three keeps its material tracker but forgets the bound program: its next setProgram binds
      // one and refreshes whatever the tracker says — no hand-over after this is tracker-sensitive)
      trackerReset(); if (swOn) lastGlProg = null;
      return reset0.apply(this, arguments);
    };
  }
  const onRestored = () => {
    stats.restores += 1;
    serial++; recEpoch++; forcePending = false;
    T = null; G = null; armed = false; swapCur = null;
    textures = null;
    lastGlProg = null; lastMat = null; lastCam = null;
    trackerReset(); lsvSerial = -1;
    info = renderer.info;
    state = renderer.state;
    hookState(state);
    refreshExt();
    adoptPrograms(info.programs); // three's restore built a new program cache (and list)
  };
  const canvas = renderer.domElement;
  if (canvas && typeof canvas.addEventListener === "function") {
    try { canvas.addEventListener("webglcontextrestored", onRestored, false); } catch (_) { /* best-effort */ }
  }

  // ---- eligibility -------------------------------------------------------------------------
  let mainScene = null;
  let roots = null; // Set of static root groups, resolved lazily (index.js builds them later)
  const rigsOn = opts.rigs === true || (opts.rigs !== false && drawExecRigsEnabled());
  const resolveRoots = () => {
    if (roots !== null) return roots;
    if (typeof opts.staticRoots === "function") {
      const list = opts.staticRoots();
      if (list) { roots = new Set(list); return roots; }
      return null;
    }
    const sc = mainScene;
    if (!sc) return null;
    let wr = null;
    for (const c of sc.children) if (c.name === "worldRoot") { wr = c; break; }
    if (wr === null) return null;
    const s = new Set();
    for (const c of wr.children) if (STATIC_ROOT_NAMES.includes(c.name) || (rigsOn && c.name === "entities")) s.add(c);
    if (s.size === 0) return null;
    roots = s;
    return roots;
  };
  /** Structural verdict for an object: null (eligible) or a reason. `undefined` = not yet decidable. */
  const classify = (object) => {
    if (object.isMesh !== true) return "notMesh";
    if (object.isInstancedMesh === true) return "instanced";
    if (object.isSkinnedMesh === true) return "skinned";
    // (BatchedMesh without WEBGL_multi_draw: three's fallback loops one draw per range,
    // which the record refuses as "drawShape".)
    const rs = resolveRoots();
    if (rs === null) return undefined;
    for (let p = object.parent; p !== null && p !== undefined; p = p.parent) {
      if (rs.has(p)) return null;
      if (p.parent === mainScene && SCENE_ROOT_NAMES.includes(p.name)) return null;
      if (p === mainScene) break;
    }
    return "notStatic";
  };
  /** Per (object, material) refusal, or null. */
  const materialRefusal = (material, geometry) => {
    if (material.isNodeMaterial === true) return "nodeMaterial";
    const t = material.type;
    const builtin = typeof t === "string" && t.startsWith("Mesh");
    if (!builtin && material.isShaderMaterial !== true) return "materialType";
    if (material.wireframe === true) return "wireframe";
    // every ShaderMaterial carries an (empty) uniformsGroups array: only a populated one is a UBO material
    if (material.uniformsGroups !== undefined && material.uniformsGroups.length > 0) return "uniformsGroups";
    if (material.clippingPlanes !== null && material.clippingPlanes !== undefined && material.clippingPlanes.length > 0) return "clipping";
    if (material.transmission > 0) return "transmission";
    if (material.transparent === true && material.side === 2 && material.forceSinglePass === false) return "twoPass";
    // (`userData.__noAsyncLink` — the occlusion proxies — was refused until 2026-10-26 as "nothing
    // to gain"; they are back-to-back continuations, and async_link stamps them like any other.)
    if (geometry.isInstancedBufferGeometry === true) return "instancedGeometry";
    const ma = geometry.morphAttributes;
    if (ma.position !== undefined || ma.normal !== undefined || ma.color !== undefined) return "morph";
    return null;
  };

  const matTok = (m) => {
    let t = matLife.get(m);
    if (t === undefined) {
      t = { dead: false };
      matLife.set(m, t);
      const onDispose = () => { t.dead = true; matLife.delete(m); try { m.removeEventListener("dispose", onDispose); } catch (_) { /* fail-soft */ } };
      try { m.addEventListener("dispose", onDispose); } catch (_) { /* a material without events: its records live with the session */ }
    }
    return t;
  };
  const vaoTok = (v) => {
    let t = vaoLife.get(v);
    if (t === undefined) { t = { dead: false, gen: 0 }; vaoLife.set(v, t); }
    return t;
  };

  // ---- the batching texture binds (2026-10-26, lane X2) -------------------------------------
  // A continuation binds a BatchedMesh's matrices / id / colours textures as setProgram would:
  // three's textures.setTexture2D(tex, unit). For a plain DataTexture (not video, render-target or
  // external: own flags fixed at construction) that is: properties.get(tex) (a WeakMap lookup),
  // then an upload when `version > 0 && props.__version !== version`, else
  // state.bindTexture(TEXTURE_2D, props.__webglTexture, TEXTURE0 + unit). The record keeps each
  // texture's properties object — valid until the texture is disposed (three drops it then:
  // the token below dies with it) or the context is restored (records are re-taken) — and does
  // the same: the bind through three's state cache, the upload through three's own setTexture2D.
  const texLife = new WeakMap();
  const texTok = (t) => {
    let k = texLife.get(t);
    if (k === undefined) {
      k = { dead: false };
      texLife.set(t, k);
      const onDispose = () => { k.dead = true; texLife.delete(t); try { t.removeEventListener("dispose", onDispose); } catch (_) { /* fail-soft */ } };
      try { t.addEventListener("dispose", onDispose); } catch (_) { k.dead = true; /* no events: never cached */ }
    }
    return k;
  };
  const plainTexture = (t) => t.isVideoTexture !== true && t.isRenderTargetTexture === false && t.isExternalTexture !== true;
  const bindCached = (t, tp, unit) => {
    if (t.version > 0 && tp.__version !== t.version) textures.setTexture2D(t, unit); // upload due: three's own path
    else state.bindTexture(GL_TEXTURE_2D, tp.__webglTexture, GL_TEXTURE0 + unit);
  };

  // three's `textures` reaches every sampler setter as its third argument: borrow it once.
  const captureArmed = new WeakSet();
  const armTexturesCapture = (u) => {
    if (textures !== null || !u || captureArmed.has(u)) return;
    captureArmed.add(u);
    const own = Object.prototype.hasOwnProperty.call(u, "setValue");
    const orig = u.setValue;
    const capture = function hbDxCaptureTextures(g, v, t) {
      if (t && typeof t.setTexture2D === "function" && textures === null) { textures = t; texSet0 = t.setTexture2D; stats.captured += 1; }
      if (u.setValue === capture) { if (own) u.setValue = orig; else delete u.setValue; }
      return orig.call(this, g, v, t);
    };
    u.setValue = capture;
  };

  // ---- the record ----------------------------------------------------------------------------
  /** Take (or re-take) `rec` from the draw three just issued. Returns a refusal reason or null. */
  const takeRecord = (rec, object, geometry, material, group, drawKind) => {
    const mp = renderer.properties.get(material);
    const program = mp.currentProgram;
    if (!program || program.program !== spLastProg) return "programMismatch";
    if (G === null) return "noVao";
    const pu = program.getUniforms();
    const map = pu.map;
    const batched = object.isBatchedMesh === true;
    const index = geometry.index;
    if (batched) {
      if (drawKind !== (index !== null ? 7 : 6) && drawKind !== (index !== null ? 9 : 8)) return "drawShape";
      if (ext === null || !multiDraw) return "noMultiDraw";
      // The canonical multi-draw three issued carried `_multiDrawCount` ranges (whichever side of
      // batched_runs' extension patch the hook sits, three's own call is canonical).
      if ((drawKind === 6 || drawKind === 7) && lastDrawN !== object._multiDrawCount) return "drawArgs";
      const b0 = map.batchingTexture, b1 = map.batchingIdTexture, b2 = map.batchingColorTexture;
      if (b0 === undefined || b1 === undefined) return "noBatchingSamplers";
      for (const u of [b0, b1, b2]) {
        if (u === undefined) continue;
        const f = u.setValue;
        if (typeof f !== "function" || (f.name !== "setValueT1" && f.name !== "hbDxCaptureTextures")) return "samplerSetter";
      }
      if (object._colorsTexture !== null && b2 === undefined) return "noColorSampler";
      rec.b0 = b0; rec.b1 = b1; rec.b2 = b2;
      rec.colorsTex = object._colorsTexture;
      if (textures === null) armTexturesCapture(b0);
    } else {
      if (drawKind !== (index !== null ? 2 : 1)) return "drawShape";
      rec.b0 = undefined; rec.b1 = undefined; rec.b2 = undefined; rec.colorsTex = null;
    }
    let type = 0, bpe = 1;
    if (index !== null) {
      type = lastDrawType;
      bpe = bytesOfIndexType(type);
      if (bpe === 0 || type !== indexTypeOfArray(index.array)) return "indexType";
    }
    const pa = program.getAttributes();
    const names = [], refs = [], datas = [];
    const attrs = geometry.attributes;
    let aMask = 0;
    for (const name in pa) {
      if (pa[name].location < 0) continue;
      const a = attrs[name];
      const d = a !== undefined ? a.data : undefined;
      if (name === "position") { aMask |= 1; rec.aPos = a; rec.aPosD = d; }
      else if (name === "normal") { aMask |= 2; rec.aNor = a; rec.aNorD = d; }
      else if (name === "uv") { aMask |= 4; rec.aUv = a; rec.aUvD = d; }
      else if (name === "color") { aMask |= 8; rec.aCol = a; rec.aColD = d; }
      else { names.push(name); refs.push(a); datas.push(d); }
    }
    // The VAO generation's premise: the state has a location enabled (position, active + present),
    // so a re-save with other attributes can never be GL-silent (see the generation hooks).
    if ((aMask & 1) === 0 || rec.aPos === undefined) return "noPosition";
    rec.aMask = aMask;
    rec.refused = null;
    rec.material = material; rec.group = group; rec.geometry = geometry;
    rec.matVersion = material.version;
    // The two program-variant inputs setProgram (and async_link's object combo) re-derive per
    // draw from the material AND the geometry: vertexTangents, vertexAlphas (three r184).
    rec.vT = attrs.tangent !== undefined && (!!material.normalMap || material.anisotropy > 0);
    rec.vA = material.vertexColors === true && attrs.color !== undefined && attrs.color.itemSize === 4;
    rec.mTok = matTok(material);
    rec.mp = mp; rec.program = program; rec.glProgram = program.program; rec.pu = pu;
    rec.uMV = map.modelViewMatrix; rec.uNM = map.normalMatrix; rec.uMM = map.modelMatrix; rec.uRS = map.receiveShadow;
    rec.batched = batched;
    rec.attrNames = names; rec.attrRefs = refs; rec.attrData = datas;
    rec.index = index; rec.indexVersion = index !== null ? index.version : -1;
    rec.drawStart = geometry.drawRange.start; rec.drawCount = geometry.drawRange.count;
    // three's draw-range arithmetic up to the per-draw count clamp (plainDrawArgs, group === null)
    rec.ds0 = Math.max(rec.drawStart, 0); rec.de0 = rec.drawStart + rec.drawCount;
    // per-texture bind caches start empty (a re-record may follow a restore: new properties)
    rec.tx0 = null; rec.tx1 = null; rec.tx2 = null;
    if (batched && rec.brc === null) rec.brc = newBatchedRunsCache();
    rec.vao = G; rec.vTok = vaoTok(G); rec.vGen = rec.vTok.gen;
    rec.type = type; rec.bpe = bpe;
    // setProgram re-binds a lit program's shadow-map samplers on EVERY draw (not only at a
    // material switch); a continuation relies on their units still holding them (texture epoch).
    rec.shadowMaps = mp.needsLights === true
      && (map.directionalShadowMap !== undefined || map.spotShadowMap !== undefined || map.pointShadowMap !== undefined);
    if (rec.shadowMaps && !texHooked) hookTextureEpoch();
    rec.combo = objectCombo(object, material);
    rec.comboE = asyncApi !== null ? (rec.combo | asyncApi.comboEpoch) : rec.combo; // a restore bumps recEpoch too
    rec.shader = material.isShaderMaterial === true;
    rec.epoch = recEpoch;
    rec.hits = 0;
    rec.sw = null; rec.swNo = null; rec.swNoList = null;
    if (!batched) {
      // Self-check: the draw three issued is the one the executor would compute.
      const d = plainDrawArgs(rec, geometry, group);
      if (d === null || lastDrawCount !== drawCountOut || (index !== null ? lastDrawOffset !== drawStartOut * bpe : lastDrawOffset !== drawStartOut)) return "drawArgs";
    }
    stats.recorded += 1;
    return null;
  };

  /** 0 = valid, else the invalidation reason (a string). */
  const recInvalid = (rec, object, geometry, material) => {
    if (rec.epoch !== recEpoch) return "epoch";
    if (rec.mTok.dead) return "disposed";
    if (rec.vTok.gen !== rec.vGen) return rec.vTok.dead ? "disposed" : "vaoContent";
    if (material.version !== rec.matVersion) return "materialVersion";
    if (geometry !== rec.geometry) return "geometry";
    const attrs = geometry.attributes;
    // vertexTangents / vertexAlphas as setProgram derives them (2026-10-26: their inputs are read
    // only where they can matter — no tangent attribute: no normalMap / anisotropy read; vertex
    // colours off: no colour attribute read — same answers, fewer loads).
    const tan = attrs.tangent;
    if ((tan !== undefined && (!!material.normalMap || material.anisotropy > 0)) !== rec.vT) return "materialKey";
    if (material.vertexColors === true) {
      const col = attrs.color;
      if ((col !== undefined && col.itemSize === 4) !== rec.vA) return "materialKey";
    } else if (rec.vA) return "materialKey";
    const am = rec.aMask;
    if ((am & 1) !== 0) { const a = attrs.position; if (a !== rec.aPos || (a !== undefined && a.data !== rec.aPosD)) return "attributes"; }
    if ((am & 2) !== 0) { const a = attrs.normal; if (a !== rec.aNor || (a !== undefined && a.data !== rec.aNorD)) return "attributes"; }
    if ((am & 4) !== 0) { const a = attrs.uv; if (a !== rec.aUv || (a !== undefined && a.data !== rec.aUvD)) return "attributes"; }
    if ((am & 8) !== 0) { const a = attrs.color; if (a !== rec.aCol || (a !== undefined && a.data !== rec.aColD)) return "attributes"; }
    const names = rec.attrNames;
    if (names.length !== 0) {
      const refs = rec.attrRefs, datas = rec.attrData;
      for (let i = 0; i < names.length; i++) {
        const a = attrs[names[i]];
        if (a !== refs[i] || (a !== undefined && a.data !== datas[i])) return "attributes";
      }
    }
    const idx = geometry.index;
    if (idx !== rec.index || (idx !== null && idx.version !== rec.indexVersion)) return "index";
    const dr = geometry.drawRange;
    if (dr.start !== rec.drawStart || dr.count !== rec.drawCount) return "drawRange";
    const ma = geometry.morphAttributes;
    if (ma.position !== undefined || ma.normal !== undefined || ma.color !== undefined) return "morph";
    if (rec.batched && object._colorsTexture !== rec.colorsTex) return "colorsTexture";
    if (rec.shader && material.uniformsNeedUpdate === true) return "uniformsNeedUpdate";
    const ug = material.uniformsGroups;
    if (ug !== undefined && ug.length !== 0) return "uniformsGroups";
    // (material.version === rec.matVersion, checked above)
    if (asyncOn && (material.__hbLinkOk !== rec.matVersion
      || material.__hbLinkOkOwner !== material || material.__hbLinkOkCombo !== rec.comboE)) return "asyncLinkStamp";
    return 0;
  };

  // three's draw-range arithmetic (renderBufferDirect, rangeFactor 1).
  let drawStartOut = 0, drawCountOut = 0;
  const plainDrawArgs = (rec, geometry, group) => {
    if (group === null) {
      // drawRange validated equal to the record's: start / end precomputed (rec.ds0 / de0); the
      // clamp reads the live count (index or position — a plain field one could write).
      const n = Math.min(rec.de0, rec.index !== null ? rec.index.count : rec.aPos.count) - rec.ds0; // three's Math.min (NaN, ±0)
      if (n < 0 || n === Infinity) return null;
      drawStartOut = rec.ds0;
      drawCountOut = n;
      return true;
    }
    const dr = geometry.drawRange;
    let drawStart = dr.start;
    let drawEnd = dr.start + dr.count;
    if (group !== null) {
      drawStart = Math.max(drawStart, group.start);
      drawEnd = Math.min(drawEnd, group.start + group.count);
    }
    if (rec.index !== null) {
      drawStart = Math.max(drawStart, 0);
      drawEnd = Math.min(drawEnd, rec.index.count);
    } else {
      const position = geometry.attributes.position;
      if (position !== undefined && position !== null) {
        drawStart = Math.max(drawStart, 0);
        drawEnd = Math.min(drawEnd, position.count);
      }
    }
    const drawCount = drawEnd - drawStart;
    if (drawCount < 0 || drawCount === Infinity) return null;
    drawStartOut = drawStart;
    drawCountOut = drawCount;
    return true;
  };

  // ---- three's material tracker (?drawExecSwitch) -------------------------------------------
  // After three's own setProgram: its tracker and GL hold the hand-over's material; a lit material's
  // lightsStateVersion is then the render state's (both branches of setProgram leave it so).
  const afterThreeSw = (material, scene) => {
    thrMat = material === undefined ? null : material;
    curMat = thrMat;
    if (lsvSerial !== serial && thrMat !== null && scene === mainScene && mainScene !== null) {
      const mp = renderer.properties.get(thrMat);
      if (mp.needsLights === true) { lsvW = mp.lightsStateVersion; lsvSerial = serial; }
    }
  };
  /**
   * Make three's material tracker stock's (curMat) before a hand-over whose setProgram could keep the
   * program with X ∈ {curMat, thrMat} on three's camera (anything else refreshes in both arms). three's
   * own setProgram for curMat, state-only (DEGEN), on the hand-over's object when X is curMat (three
   * then derives exactly what the hand-over will) or on the executor's last draw under curMat, with:
   * the program's named setter and the upload list stubbed (no uniform GL call), state.setMaterial
   * stubbed, getProgram fenced (mp.programs.get: a compile or another program — the hand-over then
   * binds another program and refreshes in both arms — or an early-out it cannot prove, abort before
   * any further write; the writes before the lookup are restored), and the materialProperties fields
   * its refresh moves (receiveShadow, uniformsNeedUpdate) restored. GL-silent; the tracker is curMat.
   */
  const syncTracker = (camera, scene, geometry, X, object) => {
    const F = curMat;
    const caseB = X === F;
    const sObj = caseB ? object : swObj;
    const sScene = caseB ? scene : swScene;
    if (F === null || sObj === null || sObj === undefined) { stats.switchSyncFailed += 1; return; }
    const sGeo = sObj.geometry;
    const mpF = renderer.properties.get(F);
    const prog = mpF.currentProgram;
    if (!prog || prog.program !== lastGlProg || mpF.programs === undefined) {
      // (curMat moved off the bound program: three binds another one for it — case b refreshes in both arms)
      if (!caseB) stats.switchSyncFailed += 1;
      return;
    }
    const env = (F.isMeshStandardMaterial || F.isMeshLambertMaterial || F.isMeshPhongMaterial) && sScene !== null && sScene !== undefined && sScene.isScene === true ? sScene.environment : null;
    if (F.envMap || env) { stats.switchSyncFailed += 1; return; } // (environments.get could do PMREM work)
    const pu = prog.getUniforms();
    const ownSet = Object.prototype.hasOwnProperty.call(pu, "setValue") ? pu.setValue : undefined;
    const list0 = mpF.uniformsList, rs0 = mpF.receiveShadow, ver0 = mpF.__version, unu0 = F.uniformsNeedUpdate;
    const env0 = mpF.environment, fog0 = mpF.fog, envMap0 = mpF.envMap, envRot0 = mpF.envMapRotation;
    const progs = mpF.programs;
    const get0 = progs.get;
    const sm0 = state.setMaterial;
    const lsvOk = lsvSerial === serial;
    let unproven = false;
    progs.get = function hbDxSyncProgramsGet(key) {
      const p = get0.call(this, key);
      if (p === undefined || p !== mpF.currentProgram) throw SYNC_ABORT; // compile / another program
      if (!lsvOk || mpF.lightsStateVersion !== lsvW) { unproven = true; throw SYNC_ABORT; } // early-out unproven
      return p; // getProgram's early-out: same program, no write but updateCommonMaterialProperties'
    };
    pu.setValue = hbDxSyncNoopSetValue;
    mpF.uniformsList = EMPTY_LIST;
    state.setMaterial = hbDxSyncNoopSetMaterial;
    syncing = true; syncProg = lastGlProg;
    let aborted = false;
    try {
      three.call(renderer, camera, sScene, sGeo, F, sObj, DEGEN);
    } catch (e) {
      if (e !== SYNC_ABORT) throw e;
      aborted = true;
    } finally {
      syncing = false; syncProg = null;
      if (ownSet === undefined) delete pu.setValue; else pu.setValue = ownSet;
      if (mpF.uniformsList === EMPTY_LIST) mpF.uniformsList = list0;
      mpF.receiveShadow = rs0;
      if (F.uniformsNeedUpdate !== unu0) F.uniformsNeedUpdate = unu0;
      state.setMaterial = sm0;
      delete progs.get;
      // getProgram's writes before its lookup and setProgram's version stamp go back in every case:
      // the hand-over's own setProgram (and async_link's decision before it, which reads __version)
      // must find the materialProperties stock has — the sync only moves three's tracker. (An
      // early-out's updateCommonMaterialProperties rewrites key-determined fields with equal values.)
      mpF.__version = ver0; mpF.environment = env0; mpF.fog = fog0; mpF.envMap = envMap0; mpF.envMapRotation = envRot0;
    }
    if (!aborted) {
      thrMat = F; stats.switchSyncs += 1;
      if (caseB) stats.switchSyncsOwn += 1; else stats.switchSyncsTracked += 1;
      return;
    }
    stats.switchSyncAborts += 1;
    if (unproven || !caseB) stats.switchSyncFailed += 1;
  };
  const preHand = (camera, scene, geometry, material, object) => {
    if (camera === lastCam && material !== null && material !== undefined && (material === curMat || material === thrMat)) syncTracker(camera, scene, geometry, material, object);
  };

  // ---- hand-overs to three -----------------------------------------------------------------
  const afterThree = (sp0, material, camera, object, scene) => {
    if (spCount !== sp0) {
      lastGlProg = spLastProg; lastMat = material; lastCam = camera; lastSerial = serial; smMat = material; smObj = object; smSerial = serial; smDraw = stats.draws; smFF = -1; texSnap = texEpoch;
      if (swOn) afterThreeSw(material, scene);
    }
  };
  const passThrough = (self, camera, scene, geometry, material, object, group) => {
    if (thrMat !== curMat) preHand(camera, scene, geometry, material, object);
    const sp0 = spCount;
    if (T !== G) armHandover();
    try {
      return top.call(self, camera, scene, geometry, material, object, group);
    } finally {
      if (swapCur !== null || armed) endHandover();
      if (spCount !== sp0) {
        lastGlProg = spLastProg; lastMat = material; lastCam = camera; lastSerial = serial; smMat = material; smObj = object; smSerial = serial; smDraw = stats.draws; smFF = -1; texSnap = texEpoch;
        if (swOn) afterThreeSw(material, scene);
      }
    }
  };
  /** Full chain + (re)record. */
  const fullAndRecord = (self, rec, camera, scene, geometry, material, object, group) => {
    stats.full += 1;
    if (thrMat !== curMat) preHand(camera, scene, geometry, material, object);
    const d0 = drawCalls;
    const sp0 = spCount;
    if (T !== G) armHandover();
    observing = true;
    try {
      top.call(self, camera, scene, geometry, material, object, group);
    } finally {
      observing = false;
      if (swapCur !== null || armed) endHandover();
      afterThree(sp0, material, camera, object, scene);
    }
    if (drawCalls !== d0 + 1 || spCount === sp0) return; // deferred / skipped / not a single draw
    if (forcePending) { forcePending = false; return; } // three's forced re-setup ran; record next time
    const r = takeRecord(rec, object, geometry, material, group, lastDrawKind);
    if (r !== null) { rec.refused = r; rec.material = material; rec.group = group; rec.matVersion = material.version; rec.epoch = recEpoch; bump(stats.invalid, `refuse:${r}`); }
  };
  /** three's own renderBufferDirect, the batched_runs state in force (the executor already did its part). */
  const threeDirect = (self, st, pending, camera, scene, geometry, material, object, group) => {
    if (thrMat !== curMat) preHand(camera, scene, geometry, material, object);
    const sp0 = spCount;
    // The degenerate state-only call returns before three's setup: nothing to arm.
    if (T !== G && group !== DEGEN) armHandover();
    try {
      return batchedRunsCall(three, self, st, pending, camera, scene, geometry, material, object, group);
    } finally {
      if (swapCur !== null || armed) endHandover();
      afterThree(sp0, material, camera, object, scene);
    }
  };

  // ---- the executor's own draw -------------------------------------------------------------
  // The executor's own draw calls go to the function its hook wraps when that hook is still the
  // installed one (the hook would only test `armed` / `observing`, both false here); a wrapper
  // someone installed over it since is called as is.
  const drawOnly = (rec, object, geometry, group, st) => {
    if (G !== rec.vao) { base.bindVertexArray.call(gl, rec.vao); G = rec.vao; stats.vaoBinds += 1; }
    if (rec.batched) {
      const n = object._multiDrawCount;
      if (st !== null) {
        const b = st.buf;
        if (rec.index !== null) {
          const fn = ext.multiDrawElementsInstancedWEBGL;
          (fn === xDEIh ? xDEI : fn).call(ext, GL_TRIANGLES, b.counts, 0, rec.type, b.starts, 0, b.inst, 0, b.r);
        } else {
          const fn = ext.multiDrawArraysInstancedWEBGL;
          (fn === xDAIh ? xDAI : fn).call(ext, GL_TRIANGLES, b.starts, 0, b.counts, 0, b.inst, 0, b.r);
        }
      } else if (rec.index !== null) {
        ext.multiDrawElementsWEBGL(GL_TRIANGLES, object._multiDrawCounts, 0, rec.type, object._multiDrawStarts, 0, n);
      } else {
        ext.multiDrawArraysWEBGL(GL_TRIANGLES, object._multiDrawStarts, 0, object._multiDrawCounts, 0, n);
      }
      // renderer.info: the canonical count three's renderMultiDraw sums — kept by the run state
      // while batched_runs verified the canonical list unchanged (it drops `sumOk` at every copy).
      let ec;
      if (st !== null && st.sumOk === true) ec = st.sum;
      else {
        const c = object._multiDrawCounts;
        ec = 0;
        for (let i = 0; i < n; i++) ec += c[i];
        if (st !== null) { st.sum = ec; st.sumOk = true; }
      }
      info.update(ec, GL_TRIANGLES, 1);
      return;
    }
    if (rec.index !== null) {
      const fn = gl.drawElements;
      (fn === hDE ? base.drawElements : fn).call(gl, GL_TRIANGLES, drawCountOut, rec.type, drawStartOut * rec.bpe);
    } else {
      const fn = gl.drawArrays;
      (fn === hDA ? base.drawArrays : fn).call(gl, GL_TRIANGLES, drawStartOut, drawCountOut);
    }
    info.update(drawCountOut, GL_TRIANGLES, 1);
  };

  const verifyDraw = (rec, material) => {
    stats.verifyChecks += 1;
    let ok = renderer.properties.get(material) === rec.mp && rec.mp.currentProgram === rec.program
      && rec.program.getUniforms() === rec.pu && G === rec.vao;
    try {
      const cur = gl.getParameter(gl.CURRENT_PROGRAM);
      const vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
      if (cur && cur !== rec.glProgram) ok = false;
      if (vao && vao !== G) ok = false;
    } catch (_) { /* a context without the queries: the JS checks stand */ }
    if (!ok) stats.verifyFails += 1;
  };

  // ---- the same-program switch (?drawExecSwitch; SAME-PROGRAM SWITCH above) ---------------------
  const swRefuse = (why) => { const o = stats.switchRefused; o[why] = (o[why] || 0) + 1; return false; };
  const planCache = new WeakMap(); // three's uniformsList (per material + program) -> plan | refusal
  /** A record's switch plan: three's upload list as a same-program switch walks it, or a refusal. */
  const buildPlan = (rec, material, mp) => {
    let kind = 0;
    if (material.isNodeMaterial === true) return "plan:materialType";
    if (material.isRawShaderMaterial === true) return "plan:raw";
    if (material.isMeshBasicMaterial) kind = K_BASIC;
    else if (material.isMeshLambertMaterial) kind = K_LAMBERT;
    else if (material.isMeshToonMaterial) kind = K_TOON;
    else if (material.isMeshPhongMaterial) kind = K_PHONG;
    else if (material.isMeshStandardMaterial) { if (material.isMeshPhysicalMaterial) return "plan:physical"; kind = K_STANDARD; }
    else if (material.isMeshMatcapMaterial || material.isMeshDepthMaterial || material.isMeshDistanceMaterial || material.isMeshNormalMaterial
      || material.isLineBasicMaterial || material.isPointsMaterial || material.isSpriteMaterial || material.isShadowMaterial) return "plan:materialType";
    else if (material.isShaderMaterial) kind = K_SHADER;
    else return "plan:materialType";
    // (lit programs with shadow samplers re-bind them per draw from the lights state: left to three)
    if (rec.shadowMaps) return "plan:shadowMaps";
    if (!knownProgs.has(rec.glProgram)) return "plan:programUnknown";
    if (probeProgs.has(rec.glProgram)) return "plan:lightProbeGrid";
    const list = mp.uniformsList;
    if (!Array.isArray(list)) return "plan:uniformsList";
    const lit = mp.needsLights === true;
    const ups = [], ids = [];
    let sampler = null;
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      if (lit && LIGHT_ID_SET.has(u.id)) continue; // marked clean right before the walk: upload skips them
      ups.push(u); ids.push(u.id);
      if (sampler === null && SAMPLER_TYPES.has(u.type)) sampler = u;
    }
    if (textures === null && sampler !== null) armTexturesCapture(sampler);
    // three's DFG LUT (setProgram just wrote it into every dfgLUT uniform it refreshed)
    const d = mp.uniforms.dfgLUT;
    if (dfgLut === null && d !== undefined && d !== null && d.value && d.value.isDataTexture === true && d.value.name === "DFG_LUT") dfgLut = d.value;
    stats.switchPlans += 1;
    // C: this draw's containers, looked up by name once (the walk's own lookups), shared by the refresh
    return { list, m: mp.uniforms, pu: rec.pu, kind, ups, ids, C: new Array(ids.length).fill(null), ix: refreshIndex(ids), uTME: rec.pu.map.toneMappingExposure };
  };
  /** three r184's needsProgramChange for this draw, each compare: null when all are false. */
  const keepProof = (rec, mp, material, object, scene) => {
    if (material.version !== mp.__version) return "version";
    if (mp.needsLights && mp.lightsStateVersion !== lsvW) return "lightsState";
    const rt = renderer.getRenderTarget();
    const xr = rt !== null && rt.isXRRenderTarget === true;
    const cs = rt === null ? renderer.outputColorSpace : (xr ? rt.texture.colorSpace : THREE.ColorManagement.workingColorSpace);
    if (mp.outputColorSpace !== cs) return "colorSpace";
    if (object.isBatchedMesh) {
      if (mp.batching === false) return "batching";
      if (mp.batchingColor === true && object.colorTexture === null) return "batchingColor";
      if (mp.batchingColor === false && object.colorTexture !== null) return "batchingColor";
    } else if (mp.batching === true) return "batching";
    if (object.isInstancedMesh || mp.instancing === true) return "instancing";
    if (object.isSkinnedMesh || mp.skinning === true) return "skinning";
    const env = (material.isMeshStandardMaterial || material.isMeshLambertMaterial || material.isMeshPhongMaterial) ? scene.environment : null;
    const envTex = material.envMap || env;
    // (environments.get: null for no texture; anything else is PMREM / cube state the executor does not model)
    if (envTex !== null && envTex !== undefined) return "envMap";
    if (mp.envMap !== null) return "envMap";
    if (material.fog === true && mp.fog !== scene.fog) return "fog";
    // (three's clipping plane counts are 0 for a session that never clipped; unknown after)
    if (mp.numClippingPlanes !== undefined && (rcEver || mp.numClippingPlanes !== 0 || mp.numIntersection !== 0)) return "clipping";
    // (rec.vA / rec.vT: setProgram's vertexAlphas / vertexTangents, re-derived by recInvalid this draw)
    if (mp.vertexAlphas !== rec.vA || mp.vertexTangents !== rec.vT) return "vertexAttributes";
    if (mp.morphTargets !== false || mp.morphNormals !== false || mp.morphColors !== false || mp.morphTargetsCount !== 0) return "morph";
    const tm = material.toneMapped ? ((rt === null || xr) ? renderer.toneMapping : THREE.NoToneMapping) : THREE.NoToneMapping;
    if (mp.toneMapping !== tm) return "toneMapping";
    // (lightProbeGridArray is empty in this render call: the bound program has no probe grid and three
    // bound it in this call — buildPlan's probeProgs + the caller's lastSerial)
    if (mp.lightProbeGrid) return "lightProbeGrid";
    return null;
  };
  // refreshFogUniforms, its getRGB memoised on every input it reads (fog colour, target colour space,
  // ColorManagement's switch and working space): the same three numbers, without the conversion.
  let fcR = NaN, fcG = NaN, fcB = NaN, fcCS = null, fcEn = null, fcW = null, foR = 0, foG = 0, foB = 0;
  const fogScratch = new THREE.Color();
  const refreshFogIx = (C, ix, fog) => {
    if (ix.fogColor >= 0) {
      const rt = renderer.getRenderTarget();
      const CM = THREE.ColorManagement;
      const cs = rt === null ? renderer.outputColorSpace : (rt.isXRRenderTarget === true ? rt.texture.colorSpace : CM.workingColorSpace);
      const c = fog.color;
      if (c.r !== fcR || c.g !== fcG || c.b !== fcB || cs !== fcCS || CM.enabled !== fcEn || CM.workingColorSpace !== fcW) {
        c.getRGB(fogScratch, cs);
        fcR = c.r; fcG = c.g; fcB = c.b; fcCS = cs; fcEn = CM.enabled; fcW = CM.workingColorSpace;
        foR = fogScratch.r; foG = fogScratch.g; foB = fogScratch.b;
      }
      const t = C[ix.fogColor].value;
      t.r = foR; t.g = foG; t.b = foB;
    }
    if (fog.isFog) {
      if (ix.fogNear >= 0) C[ix.fogNear].value = fog.near;
      if (ix.fogFar >= 0) C[ix.fogFar].value = fog.far;
    } else if (fog.isFogExp2) {
      if (ix.fogDensity >= 0) C[ix.fogDensity].value = fog.density;
    }
  };
  /**
   * The draw's setProgram + state.setMaterial when its material differs from the bound one but its
   * program is the bound one (same render call, same camera): returns false (refusal counted, nothing
   * done) or true with exactly three's calls issued, in three's order.
   */
  const sameProgramSwitch = (rec, scene, material, object, st) => {
    const mp = rec.mp;
    if (mp.currentProgram !== rec.program) return swRefuse("program");
    let plan = rec.sw;
    if (plan === null || plan.list !== mp.uniformsList || plan.m !== mp.uniforms) {
      const list = mp.uniformsList;
      if (rec.swNo !== null && rec.swNoList === list) return swRefuse(rec.swNo);
      // one plan per (material, program): three's upload list is that pair's own array
      let r = list !== null && typeof list === "object" ? planCache.get(list) : undefined;
      if (r === undefined || (typeof r !== "string" && (r.m !== mp.uniforms || r.pu !== rec.pu))) {
        r = buildPlan(rec, material, mp);
        if (list !== null && typeof list === "object") planCache.set(list, r);
      }
      if (typeof r === "string") { rec.sw = null; rec.swNo = r; rec.swNoList = list; return swRefuse(r); }
      plan = r; rec.sw = r; rec.swNo = null;
    }
    if (textures === null) return swRefuse("noTextures");
    if (mp.needsLights && lsvSerial !== serial) return swRefuse("noLightsWitness");
    const why = keepProof(rec, mp, material, object, scene);
    if (why !== null) return swRefuse(why);
    if (object.isBatchedMesh && (object.batchingTexture !== undefined || object.batchingIdTexture !== undefined || object.batchingColorTexture !== undefined)) return swRefuse("setOptional");
    const m = plan.m, ix = plan.ix;
    if (ix.dfgLUT >= 0 && dfgLut === null) return swRefuse("noDfg");
    // ---- three r184 setProgram, this case, call for call (no GL call and no write above) ----------
    stats.sameProgramSwitches += 1;
    rec.swHits += 1;
    textures.resetTextureUnits();
    if (mp.needsLights && mp.lightProbeGrid !== null) mp.lightProbeGrid = null; // findLightProbeGrid([], object)
    // (camera uniforms: same program, same camera — none; shadow samplers: refused; skinning / morph: none)
    if (rec.batched) {
      rec.b0.setValue(gl, object._matricesTexture, textures);
      rec.b1.setValue(gl, st !== null ? st.tex : object._indirectTexture, textures); // (batched_runs' run texture in force)
      if (object._colorsTexture !== null && rec.b2 !== undefined) rec.b2.setValue(gl, object._colorsTexture, textures);
    }
    mp.receiveShadow = object.receiveShadow;
    if (rec.uRS !== undefined) rec.uRS.setValue(gl, object.receiveShadow);
    // (envMapIntensity from scene.environment: the proof has the environment null)
    // the upload list's containers, by name, once (three's walk looks each up; the refresh writes them)
    const ups = plan.ups, ids = plan.ids, C = plan.C;
    for (let i = 0; i < ids.length; i++) C[i] = m[ids[i]];
    if (ix.dfgLUT >= 0) C[ix.dfgLUT].value = dfgLut;
    // refreshMaterial
    if (plan.uTME !== undefined) plan.uTME.setValue(gl, renderer.toneMappingExposure);
    if (mp.needsLights && plan.kind === K_SHADER) {
      // markUniformsLightsNeedsUpdate( m_uniforms, false ): camera and program unchanged. (A built-in
      // material's light flags are read only by uploads three marks them right before; a ShaderMaterial's
      // also by its uniformsNeedUpdate upload: written for those.)
      m.ambientLightColor.needsUpdate = false;
      m.lightProbe.needsUpdate = false;
      m.directionalLights.needsUpdate = false;
      m.directionalLightShadows.needsUpdate = false;
      m.pointLights.needsUpdate = false;
      m.pointLightShadows.needsUpdate = false;
      m.spotLights.needsUpdate = false;
      m.spotLightShadows.needsUpdate = false;
      m.rectAreaLights.needsUpdate = false;
      m.hemisphereLights.needsUpdate = false;
    }
    const fog = scene.fog;
    if (fog && material.fog === true) refreshFogIx(C, ix, fog);
    refreshMaterialIx(plan.kind, C, ix, material);
    // WebGLUniforms.upload( gl, uniformsList, m_uniforms, textures ) — the light entries are clean
    for (let i = 0; i < ups.length; i++) {
      const v = C[i];
      if (v.needsUpdate !== false) ups[i].setValue(gl, v.value, textures);
      C[i] = null; // (no container kept past the draw)
    }
    // (ShaderMaterial: uniformsNeedUpdate is false after the refresh; no sprite; no UBO — refused)
    if (rec.uMV !== undefined) rec.uMV.setValue(gl, object.modelViewMatrix);
    if (rec.uNM !== undefined) rec.uNM.setValue(gl, object.normalMatrix);
    if (rec.uMM !== undefined) rec.uMM.setValue(gl, object.matrixWorld);
    // renderBufferDirect: state.setMaterial( material, frontFaceCW )
    const ff = object.matrixWorld.determinant() < 0;
    state.setMaterial(material, ff);
    smMat = material; smObj = object; smSerial = serial; smDraw = stats.draws; smFF = ff ? 1 : 0;
    // GL now holds this material's refresh (stock's tracker); three's tracker is still thrMat
    lastMat = material; curMat = material; swObj = object; swScene = scene;
    texSnap = texEpoch; // this draw's own binds
    return true;
  };

  /** A draw with a valid record. */
  const execute = (self, rec, camera, scene, geometry, material, object, group) => {
    let st = null;
    if (rec.batched) {
      // (batched_runs' per-draw part through the record's lookup cache; an empty multi-draw never
      // gets here while skip_empty is installed and on — the wrapper's empty path took it)
      if (hasRuns) st = batchedRunsBeforeDraw(self, object, rec.brc);
      if ((object._multiDrawCount | 0) === 0) {
        // skip_empty is off / absent: three's own path (setProgram, setup, renderMultiDraw returns).
        stats.full += 1;
        threeDirect(self, st, true, camera, scene, geometry, material, object, group);
        return;
      }
    } else if (plainDrawArgs(rec, geometry, group) === null) {
      // three would return before its VAO setup; let it do exactly that.
      stats.full += 1;
      threeDirect(self, null, false, camera, scene, geometry, material, object, group);
      return;
    }
    let cont = lastSerial === serial && lastCam === camera && lastMat === material && lastGlProg === rec.glProgram
      && (!rec.batched || textures !== null) && !rec.mp.lightProbeGrid;
    // A texture unit re-bound since the draw this one continues: three's setProgram must re-bind
    // the shadow maps (the state-only call does, exactly).
    if (cont && rec.shadowMaps && texEpoch !== texSnap) { cont = false; stats.texDemoted += 1; }
    if (cont) {
      stats.fast += 1;
      if (rec.batched) {
        // three's setTexture2D for each batching texture, through the record's properties cache
        // (only while three's own setTexture2D is the installed one: a wrapper is called as is)
        const own = textures.setTexture2D === texSet0;
        const t0 = object._matricesTexture, u0 = rec.b0.cache[0];
        if (own && t0 === rec.tx0 && rec.tk0.dead === false) bindCached(t0, rec.tp0, u0);
        else {
          textures.setTexture2D(t0, u0);
          if (plainTexture(t0)) { rec.tx0 = t0; rec.tp0 = renderer.properties.get(t0); rec.tk0 = texTok(t0); } else rec.tx0 = null;
        }
        const t1 = st !== null ? st.tex : object._indirectTexture, u1 = rec.b1.cache[0];
        if (own && t1 === rec.tx1 && rec.tk1.dead === false) bindCached(t1, rec.tp1, u1);
        else {
          textures.setTexture2D(t1, u1);
          if (plainTexture(t1)) { rec.tx1 = t1; rec.tp1 = renderer.properties.get(t1); rec.tk1 = texTok(t1); } else rec.tx1 = null;
        }
        const t2 = object._colorsTexture;
        if (t2 !== null) {
          const u2 = rec.b2.cache[0];
          if (own && t2 === rec.tx2 && rec.tk2.dead === false) bindCached(t2, rec.tp2, u2);
          else {
            textures.setTexture2D(t2, u2);
            if (plainTexture(t2)) { rec.tx2 = t2; rec.tp2 = renderer.properties.get(t2); rec.tk2 = texTok(t2); } else rec.tx2 = null;
          }
        }
        texSnap = texEpoch; // this draw's own binds (batching units, after the shadow ones)
      }
      const mp = rec.mp;
      if (mp.receiveShadow !== object.receiveShadow) {
        mp.receiveShadow = object.receiveShadow;
        if (rec.uRS !== undefined) rec.uRS.setValue(gl, object.receiveShadow);
      }
      if (rec.uMV !== undefined) rec.uMV.setValue(gl, object.modelViewMatrix);
      if (rec.uNM !== undefined) rec.uNM.setValue(gl, object.normalMatrix);
      if (rec.uMM !== undefined) rec.uMM.setValue(gl, object.matrixWorld);
      const ff = object.matrixWorld.determinant() < 0;
      // smFF: the front face the last setMaterial was called with — exact when the executor made
      // that call (1 / 0), unknown (-1) after three's, which re-derives it from smObj as before.
      if (smMat === material && smDraw === stats.draws - 1 && smSerial === serial
        && smObj.onAfterRender === O3D_AFTER && material.onBeforeRender === MAT_BEFORE
        && (object.onBeforeRender === O3D_BEFORE || object.onBeforeRender === BM_BEFORE)
        && (smFF !== -1 ? smFF === (ff ? 1 : 0) : (smObj.isMesh === true && smObj.matrixWorld.determinant() < 0) === ff)) {
        stats.smSkips += 1;
        smObj = object; smDraw = stats.draws; smFF = ff ? 1 : 0; // WebGLState holds what setMaterial(material, ff) sets for this draw too
      } else {
        state.setMaterial(material, ff);
        smMat = material; smObj = object; smSerial = serial; smDraw = stats.draws; smFF = ff ? 1 : 0;
      }
      if (swOn) { swObj = object; swScene = scene; } // (curMat === lastMat === material here)
    } else if (swOn && lastMat !== material && lastSerial === serial && lastCam === camera && lastGlProg === rec.glProgram
      && sameProgramSwitch(rec, scene, material, object, st)) {
      // SAME-PROGRAM SWITCH executed: three's setProgram + setMaterial done, the draw follows
    } else {
      stats.stateOnly += 1;
      threeDirect(self, st, false, camera, scene, geometry, material, object, DEGEN);
      if (rec.mp.currentProgram !== rec.program || lastGlProg !== rec.glProgram) {
        // three moved the program (lights / env / fog / tone mapping / colour space …): it
        // draws for real (its second setProgram is GL-silent) and the record is re-taken.
        stats.progChanged += 1;
        const d0 = drawCalls;
        observing = true;
        try { threeDirect(self, st, true, camera, scene, geometry, material, object, group); } finally { observing = false; }
        if (++rec.churn >= CHURN_LIMIT) { rec.refused = "churn"; rec.cool = CHURN_COOL; rec.epoch = recEpoch; rec.program = null; return; }
        if (drawCalls === d0 + 1) {
          const r = takeRecord(rec, object, geometry, material, group, lastDrawKind);
          if (r !== null) { rec.refused = r; rec.matVersion = material.version; rec.epoch = recEpoch; bump(stats.invalid, `refuse:${r}`); }
        }
        return;
      }
    }
    drawOnly(rec, object, geometry, group, st);
    rec.hits += 1;
    rec.churn = 0;
    if (ctl.verify > 0) verifyDraw(rec, material);
  };

  // ---- the renderer clipping capture ----------------------------------------------------------
  // The renderer clipping in force for three's current render() (refreshed where three captures it,
  // hbDxRenderListsGet; three's setProgram uses that capture, not the live fields, until the next
  // render() — so does the executor). Initially: the renderer's configuration at install.
  // (Until round 3 R3-2 this hook also carried S3.2's `list.sort` hook for `?drawExecRuns`: deleted.)
  let rcOn = renderer.localClippingEnabled === true || renderer.clippingPlanes.length > 0;
  if (rcOn) rcEver = true;
  let hookedLists = null;
  const hookRenderLists = (lists) => {
    hookedLists = lists;
    if (!lists || typeof lists.get !== "function" || lists.__hbDrawExecLists === true) return;
    const get0 = lists.get;
    lists.get = function hbDxRenderListsGet(scene, depth) {
      // three's render() calls this (its only call site, r184) right after it captured the
      // renderer's clipping state (_localClippingEnabled / clipping.init): read it here, once.
      rcOn = renderer.localClippingEnabled === true || renderer.clippingPlanes.length > 0;
      if (rcOn) rcEver = true;
      const list = get0.call(this, scene, depth);
      return list;
    };
    Object.defineProperty(lists, "__hbDrawExecLists", { value: true, configurable: true });
  };
  hookRenderLists(renderer.renderLists);

  // ---- the wrapper -----------------------------------------------------------------------------
  const wrapper = function drawExec(camera, scene, geometry, material, object, group) {
    let head; // object.__hbDx, read once (nothing runs between here and its uses)
    if (object !== null && object !== undefined) {
      head = object.__hbDx;
      if (head !== undefined && head.isDxRefusal === true) {
        // A structurally refused object (any scene): straight to the chain, trackers kept.
        stats.draws += 1;
        head.n += 1;
        return passThrough(this, camera, scene, geometry, material, object, group);
      }
    }
    stats.draws += 1;
    if (ctl.off || object === null || object === undefined || scene === null || material === null || material === undefined) {
      stats.passOther += 1;
      return passThrough(this, camera, scene, geometry, material, object, group);
    }
    if (mainScene === null) mainScene = (getMainScene && getMainScene()) || null;
    if (scene !== mainScene) {
      stats.passOther += 1;
      bump(stats.refusedRec, "scene");
      return passThrough(this, camera, scene, geometry, material, object, group);
    }
    if (head === undefined) {
      const why = classify(object);
      if (why === undefined) { stats.passOther += 1; bump(stats.refusedRec, "rootsPending"); return passThrough(this, camera, scene, geometry, material, object, group); }
      if (why !== null) { // just classified: refused
        head = refusal(why); object.__hbDx = head;
        head.n += 1;
        return passThrough(this, camera, scene, geometry, material, object, group);
      }
      head = newRecord(); object.__hbDx = head;
    }
    if (rcOn) {
      stats.passOther += 1;
      bump(stats.refusedRec, "rendererClipping");
      return passThrough(this, camera, scene, geometry, material, object, group);
    }
    if (hasSkip && object.isBatchedMesh === true && skipEmptyMultiDrawWouldSkip(object)) {
      // An empty multi-draw, whatever its record says (none yet — a bucket culled to nothing
      // since its first draw —, refused, or valid): exactly the chain's work for it — batched_runs'
      // observe + frame count, then skip_empty's skip — and nothing of three's (2026-10-26).
      if (hasRuns) batchedRunsBeforeDraw(this, object);
      skipEmptyMultiDrawTake(object);
      stats.empty += 1;
      return;
    }
    // The record for (material, group): the head, or one further down the object's list.
    let rec = head;
    let n = 0;
    while (rec !== null && (rec.material !== material || rec.group !== group)) { rec = rec.next; n++; }
    if (rec === null) {
      if (n >= MAX_RECS_PER_OBJECT) { stats.passOther += 1; bump(stats.refusedRec, "tooManyMaterials"); return passThrough(this, camera, scene, geometry, material, object, group); }
      if (head.material === null) rec = head;
      else { rec = newRecord(); rec.next = head.next; head.next = rec; }
    }
    if (rec.refused !== null) {
      // A per-material refusal holds while the material does not move; a churn
      // refusal holds for its cool-down.
      if (rec.epoch === recEpoch && (rec.cool > 0 ? --rec.cool > 0 : rec.matVersion === material.version)) {
        stats.passOther += 1;
        bump(stats.refusedRec, rec.refused);
        return passThrough(this, camera, scene, geometry, material, object, group);
      }
      rec.refused = null; rec.program = null; rec.cool = 0; rec.churn = 0;
    }
    if (rec.program === null) {
      const mr = materialRefusal(material, geometry);
      if (mr !== null) {
        rec.refused = mr; rec.material = material; rec.group = group; rec.matVersion = material.version; rec.epoch = recEpoch;
        stats.passOther += 1;
        bump(stats.refusedRec, mr);
        return passThrough(this, camera, scene, geometry, material, object, group);
      }
      rec.material = material; rec.group = group;
      return fullAndRecord(this, rec, camera, scene, geometry, material, object, group);
    }
    const inv = forcePending ? "forcePending" : recInvalid(rec, object, geometry, material);
    if (inv === "asyncLinkStamp" || inv === "uniformsNeedUpdate") {
      // The record still describes the draw; this one draw needs the chain (async_link's own
      // decision — another object kind stamped the shared material — or the ShaderMaterial
      // re-upload). No re-record: every check runs again at the next draw, and a program
      // three moves meanwhile is caught by the state-only post-check / the continuation test.
      bump(stats.invalid, inv);
      stats.full += 1;
      return passThrough(this, camera, scene, geometry, material, object, group);
    }
    if (inv !== 0) {
      bump(stats.invalid, inv);
      if (inv === "materialVersion" && ++rec.churn >= CHURN_LIMIT) {
        rec.refused = "churn"; rec.cool = CHURN_COOL; rec.epoch = recEpoch; rec.program = null;
        stats.passOther += 1;
        bump(stats.refusedRec, "churn");
        return passThrough(this, camera, scene, geometry, material, object, group);
      }
      if (inv !== "forcePending" && inv !== "uniformsNeedUpdate" && inv !== "asyncLinkStamp") {
        const mr = materialRefusal(material, geometry);
        if (mr !== null) {
          rec.refused = mr; rec.matVersion = material.version; rec.epoch = recEpoch; rec.program = null;
          stats.passOther += 1;
          bump(stats.refusedRec, mr);
          return passThrough(this, camera, scene, geometry, material, object, group);
        }
      }
      return fullAndRecord(this, rec, camera, scene, geometry, material, object, group);
    }
    try {
      return execute(this, rec, camera, scene, geometry, material, object, group);
    } catch (e) {
      stats.errors += 1;
      ctl.off = true;
      endHandover();
      // eslint-disable-next-line no-console
      console.warn("[drawExec] executor error — off for this session", e);
      throw e;
    }
  };
  wrapper.__hbRbdTag = "drawExec";
  wrapper.__hbRbdInner = top;
  renderer.renderBufferDirect = wrapper;
  let censusState = null; // api.censusStart / censusStop (diag)

  const api = {
    installed: true,
    stats,
    get off() { return ctl.off; },
    set off(v) { ctl.off = !!v; },
    /** Live per-draw self-check (renderer.properties, program, uniforms, VAO, GL's own
     *  CURRENT_PROGRAM / VERTEX_ARRAY_BINDING) for the next `frames` rAF frames. */
    verify(frames = 60) {
      ctl.verify += 1;
      const c0 = stats.verifyChecks, f0 = stats.verifyFails;
      return new Promise((resolve) => {
        let n = 0;
        const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
        const tick = () => {
          if (++n < frames) { raf(tick); return; }
          ctl.verify -= 1;
          resolve({ checks: stats.verifyChecks - c0, fails: stats.verifyFails - f0, fast: stats.fast, stateOnly: stats.stateOnly, full: stats.full });
        };
        raf(tick);
      });
    },
    /**
     * Diag: what the draws ARE (2026-10-26, lane X2). For the next `frames` rAF frames every
     * renderBufferDirect call is counted by kind — `scene|root|name|type`: the scene (`main`,
     * `shadow` for scene === null, else its name), the object's top group under worldRoot or
     * the scene, its name without trailing ids, its type (BM BatchedMesh, IM InstancedMesh, SM
     * SkinnedMesh, M Mesh, P / L / S) — and by outcome (fast, sps — ?drawExecSwitch —, stateOnly, full, empty, pass) with
     * the refusal / invalidation reasons. While it runs it wraps the chain from the outside;
     * nothing is added per draw otherwise. Resolves
     * `{ frames, draws, kinds: [{ key, draws, perFrame, fast, sps, stateOnly, full, empty, pass, recorded, reasons }] }`.
     */
    census(frames = 60) {
      this.censusStart();
      return new Promise((resolve) => {
        let n = 0;
        const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
        const tick = () => {
          if (++n < frames) { raf(tick); return; }
          resolve(this.censusStop(frames));
        };
        raf(tick);
      });
    },
    /** The census by hand (synchronous; tests): start counting every renderBufferDirect call. */
    censusStart() {
      if (censusState !== null) return;
      const kinds = new Map();
      let draws = 0;
      const tagOf = (object, scene) => {
        if (mainScene === null) mainScene = (getMainScene && getMainScene()) || null;
        const sc = scene === null ? "shadow" : scene === mainScene ? "main" : (scene.name || scene.type || "other");
        let root = "-";
        for (let p = object ? object.parent : null; p; p = p.parent) {
          const pp = p.parent;
          if (pp === null || pp === undefined) break;
          if (pp === scene || pp.isScene === true || pp.name === "worldRoot") { root = p.name || p.type || "?"; break; }
        }
        const nm = object ? censusName(object.name) : "";
        const ty = !object ? "-" : object.isBatchedMesh ? "BM" : object.isInstancedMesh ? "IM" : object.isSkinnedMesh ? "SM"
          : object.isMesh ? "M" : object.isPoints ? "P" : object.isLine ? "L" : object.isSprite ? "S" : "?";
        return `${sc}|${root}|${nm}|${ty}`;
      };
      const reasonOf = (object, material, group, inv0) => {
        const h = object ? object.__hbDx : undefined;
        if (h === undefined) return null;
        if (h.isDxRefusal === true) return h.refused;
        for (let r = h; r !== null; r = r.next) if (r.material === material && r.group === group) {
          if (r.refused !== null) return r.refused;
          break;
        }
        for (const k in stats.invalid) if ((stats.invalid[k] || 0) !== (inv0[k] || 0)) return `invalid:${k}`;
        return null;
      };
      const inner = renderer.renderBufferDirect;
      const census = function hbDxCensus(camera, scene, geometry, material, object, group) {
        const f0 = stats.fast, s0 = stats.stateOnly, u0 = stats.full, e0 = stats.empty, r0 = stats.recorded, w0 = stats.sameProgramSwitches;
        const inv0 = Object.assign({}, stats.invalid);
        try {
          return inner.call(this, camera, scene, geometry, material, object, group);
        } finally {
          draws += 1;
          const key = tagOf(object, scene);
          let k = kinds.get(key);
          if (k === undefined) { k = { key, draws: 0, perFrame: 0, fast: 0, sps: 0, stateOnly: 0, full: 0, empty: 0, pass: 0, recorded: 0, reasons: {} }; kinds.set(key, k); }
          k.draws += 1;
          const out = stats.fast !== f0 ? "fast" : stats.sameProgramSwitches !== w0 ? "sps" : stats.stateOnly !== s0 ? "stateOnly" : stats.full !== u0 ? "full" : stats.empty !== e0 ? "empty" : "pass";
          k[out] += 1;
          if (stats.recorded !== r0) k.recorded += 1;
          if (out !== "fast" && out !== "sps" && out !== "stateOnly" && out !== "empty") {
            // full: an invalidation, a first record, or no record taken (deferred by async_link,
            // not a single draw, three's forced re-setup); pass: the refusal.
            const why = scene !== mainScene ? (scene === null ? "noScene" : "scene")
              : (reasonOf(object, material, group, inv0) || (out === "full" ? (stats.recorded !== r0 ? "firstRecord" : "noRecordTaken") : "other"));
            k.reasons[why] = (k.reasons[why] || 0) + 1;
          }
        }
      };
      renderer.renderBufferDirect = census;
      censusState = { kinds, inner, census, get draws() { return draws; } };
    },
    /** Stop counting; returns the table (`frames`: the frame count it covered, for perFrame). */
    censusStop(frames = 1) {
      const c = censusState;
      if (c === null) return null;
      censusState = null;
      if (renderer.renderBufferDirect === c.census) renderer.renderBufferDirect = c.inner;
      const list = [...c.kinds.values()].sort((x, y) => y.draws - x.draws);
      for (const k of list) k.perFrame = +(k.draws / Math.max(1, frames)).toFixed(2);
      return { frames, draws: c.draws, kinds: list };
    },
    /** Test seam: three's WebGLTextures as captured (null until the first batching sampler upload). */
    __textures() { return textures; },
    /** Test seam: the VAO model (three's belief, the GL binding). */
    __vaoModel() { return { T, G, armed, swapped: swapCur !== null }; },
    /** Test seam: turn the per-draw self-check on/off synchronously. */
    __setVerify(on) { ctl.verify = on ? 1 : 0; },
    /** Test hook: put every wrapper back (records stay on the objects, inert). */
    uninstall() {
      if (renderer.renderBufferDirect === wrapper) renderer.renderBufferDirect = top;
      renderer.render = render0;
      renderer.setRenderTarget = srt0;
      if (typeof compile0 === "function") renderer.compile = compile0;
      if (typeof compileAsync0 === "function") renderer.compileAsync = compileAsync0;
      if (typeof reset0 === "function") renderer.resetState = reset0;
      for (const name in base) { try { gl[name] = base[name]; } catch (_) { /* fail-soft */ } }
      armed = false;
      if (progList !== null) {
        for (const p of progList) { const f = p && p.getAttributes; if (f && f.__hbDxInner) p.getAttributes = f.__hbDxInner; }
        delete progList.push;
        progList = null;
      }
      const s = renderer.state && renderer.state.__hbDrawExec;
      if (s) { renderer.state.useProgram = s.up; delete renderer.state.__hbDrawExec; }
      const ex = renderer.extensions;
      if (ex && typeof ex.__hbDrawExec === "function") { ex.get = ex.__hbDrawExec; delete ex.__hbDrawExec; }
      try { canvas?.removeEventListener?.("webglcontextrestored", onRestored, false); } catch (_) { /* fail-soft */ }
      delete renderer.__hbDrawExec;
    },
  };
  try { Object.defineProperty(renderer, "__hbDrawExec", { value: api, configurable: true }); } catch (_) { renderer.__hbDrawExec = api; }
  try { if (typeof window !== "undefined") window.__drawExec = api; } catch (_) { /* diag only */ }
  return api;
}

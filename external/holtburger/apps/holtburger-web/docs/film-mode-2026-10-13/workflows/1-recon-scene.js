export const meta = {
  name: 'film-recon-scene',
  description: 'Read-only recon of physobjs/obstruction, particles/look/time, HUD/input for AC film mode',
  phases: [{ title: 'Recon', detail: 'physobjs+raycast, particles+atmosphere+time, HUD/UI/input' }],
}

const PRE = `You are a read-only reconnaissance agent for a new feature: "Asheron's Call FILM MODE" for holtburger-web (the JS/three.js + Rust/wasm Asheron's Call web client).

FEATURE CONTEXT (so you know what matters): an optional, default-OFF, agentic cinematography mode. The "agent" is a Claude Code session (Opus 5.5 via the user's subscription — NO Anthropic API calls in code). A user pastes a rough script; the agent turns it into a filming plan; JEV (TypeSafe's typed decision model on OpenRouter, Decisions API) makes fast typed decisions (choose shot candidates, score lyric↔site matches); for music videos it analyses song structure and maps lyrics to in-world sites (using the WorldBuilder.Terminal ontology). The agent drives the web client headlessly (Chrome over CDP, later on a GTX-1070 box) and records HUD-free footage using all common film techniques plus advanced drone techniques. The camera must understand physobjs and particle effects that could obstruct the view, move smoothly through dungeons, and shift angles smoothly even at 90 degrees (e.g. straight-down tilts, right-angle corridor turns) without gimbal flips.

YOUR JOB: produce a VERIFIED map of ONE subsystem so the orchestrator can design film mode without re-reading everything. Read the actual code. Every file:line you cite must be one you actually read (agents have hallucinated file:line before — set verified=false for anything you did not read). Prefer exact function names, signatures, field names, flags, and coordinate conventions. Be dense; no filler.

PATHS: REPO=/home/wbterminal/WorldBuilder-ACME-Edition ; HB=$REPO/external/holtburger/apps/holtburger-web (scene3d/ = renderer modules, index.html = app shell, pkg/holtburger_web.d.ts = wasm API, docs/url-flags.md = every ?flag). Cite paths relative to HB when inside it.

HARD RULES:
- Parallel agents may read, edit and run TARGETED single tests only (\`node test_x.mjs\`). They must NOT run the full JS gate, cargo, wasm-pack or browsers. The orchestrator runs the full gate and builds ONCE, after merging, one at a time.
- You are READ-ONLY: do not create, edit or delete any file. Do not start servers, browsers, Chrome, node test gates, cargo or dotnet builds.
- Use \`rg\` (ripgrep) for search; NEVER pass -rn / -rln / -r flags to rg (-r means --replace). Use \`rg -n PATTERN FILE\`, \`sed -n 'A,Bp' FILE\` to read ranges. index.html and entities.js are huge — navigate with rg, read ranges.
- Output via the StructuredOutput schema. "summary" should be a dense technical briefing (can be long). Put concrete reusable functions in apis[], integration points in seams[] (with how film mode would use them), and gotchas in hazards[].`

const MAP = {
  type: 'object',
  properties: {
    area: { type: 'string' },
    summary: { type: 'string' },
    apis: { type: 'array', items: { type: 'object', properties: {
      name: { type: 'string' }, file: { type: 'string' }, line: { type: 'integer' },
      signature: { type: 'string' }, what: { type: 'string' }, verified: { type: 'boolean' } },
      required: ['name', 'file', 'what', 'verified'] } },
    seams: { type: 'array', items: { type: 'object', properties: {
      what: { type: 'string' }, file: { type: 'string' }, line: { type: 'integer' }, filmUse: { type: 'string' } },
      required: ['what', 'filmUse'] } },
    hazards: { type: 'array', items: { type: 'object', properties: {
      what: { type: 'string' }, file: { type: 'string' }, line: { type: 'integer' }, mitigation: { type: 'string' } },
      required: ['what'] } },
    dataSources: { type: 'array', items: { type: 'object', properties: {
      name: { type: 'string' }, location: { type: 'string' }, format: { type: 'string' }, notes: { type: 'string' } },
      required: ['name', 'location'] } },
    recommendations: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['area', 'summary', 'apis', 'seams', 'hazards', 'recommendations', 'openQuestions'],
}

const TASKS = [
  { key: 'physobj-obstruction', prompt: `SUBSYSTEM: PHYSOBJS, RAYCASTING, OBSTRUCTION, OCCLUDER FADING.
Files: scene3d/entities.js (19.7k lines — navigate with rg: entity registry, spawn/despawn, rig groups, setup radius/height), scene3d/object_radius.js, picking.js, pick_math.js, statics.js, buildings.js, static_batch_x.js, static_geom_cache.js, lb_objects_shared.js, occlusion_cull.js, culling.js, canopy_soften.js, fade_alpha_state.js, selection_brackets.js, nameplate_sprite.js, projectile_sweep.js, scene3d/diag/collision.js, diag/physics.js, diag/entity_types.js, pkg/holtburger_web.d.ts (any collision / raycast / sphere-sweep / cell / BSP / height queries).
Answer precisely:
1. Entity registry: how to enumerate live entities (guid → object3D/rig, world position, heading, setup id, radius/height, kind: creature/NPC/player/item/door/portal/lifestone, name). Where do bounding spheres/cylinders come from (Setup radius/height via object_radius.js?). Exact accessor names / window globals.
2. Statics/scenery/buildings: storage (BatchedMesh / InstancedMesh / merged per-LB geometry?). Can we enumerate static instances near a point with positions + radius/bbox (lb_objects_shared?)? Are trees/rocks/buildings distinguishable (setup ids, flags)?
3. Raycasting: what does picking.js raycast against (entities, statics, batched instances, terrain, cells)? Cost; any BVH; any wasm-side ray/sphere-sweep against physics BSPs/cell geometry? Best way to answer "is the segment camera→subject blocked, and by what?" and "does a sphere radius r at p intersect geometry?" (camera collision/clearance). Quote signatures.
4. Occluder fading: canopy_soften.js / fade_alpha_state.js — existing mechanisms to fade/dither objects between camera and player? Can film mode fade an arbitrary entity/static instance for a shot?
5. Hiding: nameplates, selection brackets/selection lighting, speech bubbles, spell-range previews — flags or functions; hiding the local player avatar and/or other players from render.
6. Client-side physics/collision data exposed (diag/collision.js, diag/physics.js): BSP, cylinders, cell walls — anything queryable from JS.` },
  { key: 'particles-look-time', prompt: `SUBSYSTEM: PARTICLES / VFX, ATMOSPHERE, TIME OF DAY, WEATHER, POST-PROCESSING LOOK, CLOCKS.
Files: scene3d/particles/* (particle_manager.js, particle_emitter.js, particle_emitter_info.js, owner_registry.js, render_layer.js, particle_fx*.js, additive_fog.js, time_rng.js), play_effect_vfx.js, play_effect_burst_fx.js, script_manager.js, terrain_vfx.js, daygroup_weather.js, cloud_*.js, sky_*.js (sky_game_date.js, sky_lighting.js, sky_dome.js), always_daylight.js, environ_override.js, atmosphere_*.js, night_ramp.js, color_grade.js, tone_curve.js, ssao.js, csm.js, radial_fog.js, ground_fog.js, layered_haze.js, scene3d/index.js (where the pmndrs postprocessing composer/effects are built), docs/url-flags.md rows: skytime, exposure, weather/cloud flags, quality.
Answer precisely:
1. Enumerate active particle emitters/systems with world position, approximate extent (emitter radius, particle size, lifetime*velocity), blending (additive vs alpha), owner entity — for obstruction scoring (smoke/fire between camera and subject, or a particle cloud on the lens). Exact accessors.
2. Can film mode suppress particles near the camera (near-plane fade) or hide specific emitters during a shot? Existing per-emitter visibility/cull authority?
3. Time of day: how sky time is derived (server time sync vs local), the ?skytime pin implementation, any runtime API to set time of day or accelerate it (time-lapse); weather (rain/snow/fog/storm/day groups) runtime controls; always_daylight.
4. Look controls: exposure override, color grade/tone curve, bloom, SSAO, shadows, fog — list every window.__set*/__get* helper or runtime knob relevant to cinematography (memory note: atmosphere/__set* helpers attach AFTER __bootState 'in-world', wait for 'ready').
5. Post-processing: which effects exist in the composer (bloom? depth-of-field/bokeh? motion blur? vignette? chromatic aberration?) and where (file:line) the composer/EffectPass is built; how a DoF effect could be added for rack focus. Note the pmndrs gotcha: Pass.mainCamera is a no-op setter (use this.camera).
6. CLOCKS: what time source drives particles, skeletal/motion animation, sky/sun, clouds, wind/foliage sway, water — performance.now(), a shared clock module, frame dt, Date.now()? Could they be virtualized (fixed dt per captured frame) for deterministic frame-stepped capture? Existing freeze/time-scale hooks?` },
  { key: 'hud-ui-input', prompt: `SUBSYSTEM: EVERYTHING THAT CAN SHOW UP ON SCREEN (HUD/DOM/in-canvas overlays) + INPUT + AUDIO + OUTPUT RESOLUTION.
Files: index.html (6.6k lines: DOM overlays, CSS, the ?agent=1 'agent-mode CSS kill rule', toolbar, chat, panels, radar, vitals, loading screens), scene3d/hud.js, ui/ and shell/ dirs, scene3d/input.js, nameplate_sprite.js, speech_bubble.js, selection_brackets.js, spell_range.js, spell_shape_preview.js, portal_space.js (portal travel tunnel when teleporting), death_hold.js, rynth/ai/thought_overlay.js, any stream HUD (?streamHud), FPS/stall/diag overlays, adaptive_render_scale.js, quality.js, scene3d/audio/.
Answer precisely:
1. Enumerate EVERY on-screen element (DOM and in-canvas three.js sprites/overlays) that could appear in footage: what creates it (file:line) and how to hide it (flag, CSS, function). Goal: "nothing on screen but the world".
2. ?agent=1: what exactly does it hide (quote the CSS rule), what does it leave visible (thoughtOverlay exempt...)? Good base for a clean film frame?
3. Teleport visuals: when the player teleports (@teleloc/@tele), what plays (portal-space tunnel, fade, loading)? Duration? Can it be suppressed, or must the recorder pause/cut around it? Readiness signals after arrival.
4. Input: every keyboard/mouse/pointer-lock/wheel/touch handler that moves the camera or player — how to disable all during film mode and restore after.
5. Cursor, focus, resize/fullscreen; canvas sizing (devicePixelRatio, ?renderScale, ?adaptiveRes=off, quality presets) — how to force an exact output resolution (1920x1080, 3840x2160) for recording independent of window size.
6. Audio: how game audio is produced (WebAudio graph, master gain), how to mute it or tap it (MediaStreamDestination) for capture.` },
]

phase('Recon')
const results = await parallel(TASKS.map(t => () =>
  agent(PRE + '\n\n' + t.prompt, { label: 'recon:' + t.key, phase: 'Recon', schema: MAP })
    .then(r => (r ? { key: t.key, ...r } : null))))
const ok = results.filter(Boolean)
log('recon done: ' + ok.length + '/' + TASKS.length)
return ok
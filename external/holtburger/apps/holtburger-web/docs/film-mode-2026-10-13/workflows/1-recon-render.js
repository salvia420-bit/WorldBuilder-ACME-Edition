export const meta = {
  name: 'film-recon-render',
  description: 'Read-only recon of camera/loop, dungeon cells, terrain streaming for AC film mode',
  phases: [{ title: 'Recon', detail: 'camera+loop, dungeons/cells, terrain/streaming' }],
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
  { key: 'camera-loop', prompt: `SUBSYSTEM: CAMERA CONTROLLERS + FRAME LOOP.
Files: scene3d/camera.js (3.3k lines), scene3d/camera_math.js, scene3d/loop.js (4.6k), scene3d/index.js (camera/renderer/composer creation, resize), scene3d/adaptive_render_scale.js, scene3d/shader_logdepth.js, scene3d/frame_pose.js, harness/lib/moving_rig.mjs, harness/lib/moving_path.mjs, $REPO/external/holtburger/scripts/perf-worker/coldboot/camset.mjs.
Answer precisely:
1. CameraSwitcher: modes, key fields, positionCamera(dt) structure; the ?camDebug=on window.__cam rig (park/release/set/orbit/player/fov) exact semantics and coordinate frame ("AC-world metres, landblock folded" — what does folded mean?). How AC coords (x east, y north, z up) map into the three.js scene (worldRoot rotation? landblock-relative origin? floating origin/rebasing?). In which frame must a film controller write camera position/target?
2. Per-frame order in loop.js: where the camera update happens relative to entity interpolation, animation, particles, culling, portal/cell visibility, render and post-processing. dt/clock source. ?targetFps, ?renderOnDemand + window.__renderOnce(), ?nullRender. Are there pre-render / post-render hook lists a module can register into?
3. Every other system that reads the camera each frame (frustum culling, LOD, particle sort, nameplates, audio listener, portal/cell visibility, terrain ring centering, CSM shadows, fog, SSAO). Which assume the camera is near the player?
4. near/far, FOV, aspect/resize, logarithmic depth; is animating fov per frame safe (updateProjectionMatrix path) for dolly-zoom?
5. Degenerate look directions (straight down/up): the 'degenerateFrames ... synthesise a basis' logic, up-vector handling, pitch clamps; any camera collision / spring-arm / wall pull-in logic and lookahead. Quote the relevant code.
6. The cleanest zero-cost-when-off seam for a film controller that fully owns pose+fov+roll each frame (reuse camDebug's positionCamera wrap? something else?). Note anything that fights an externally-driven camera (e.g. follow smoothing re-applied, pointer lock).
7. moving_rig.mjs / moving_path.mjs / camset.mjs: existing scripted camera path code — what is reusable for film paths?` },
  { key: 'dungeons-cells', prompt: `SUBSYSTEM: DUNGEONS / INDOOR ENVCELLS / PORTALS.
Files: scene3d/cells.js (4.9k), scene3d/portal_clip.js, portal_pass2.js, portal_stencil.js, portal_punch.js, rig_cell_gate.js, indoor_landscape_gate.js, pool_envcells.js, cell_fusion.js, cell_static_merge.js, scene3d/diag/pvs.js, rynth/indoor_router.js, rynth/ai/tools/dungeon_nav.js, validate_cell_portal_graph.cjs, docs/ (rg -l 'nonstencil|indoor' docs | head), url flags eagerDungeons / portalStencil / envcellFusion in docs/url-flags.md.
Answer precisely:
1. Client-side EnvCell representation: data structure (cell id, landblock, frame/origin+orientation, mesh, bbox, portal list with polygon + other_cell_id, walkable floor polys?), where loaded from (wasm/DAT/bake), which functions return them.
2. How the renderer decides which cells/landscape to draw: is it keyed on the CAMERA position (camera-cell lookup) or the PLAYER's cell? What happens if the camera is in a different cell than the player, or outside all cells while the player is inside, or inside a dungeon while the player is outside? Quote the decision code (file:line).
3. Is there a point->cell lookup (which EnvCell contains a world point) and a portal-adjacency graph usable for camera path planning? Describe indoor_router's A* (nodes, edges, inputs, outputs: does it give cell sequence + portal crossing points?) and dungeon_nav (describeSurroundings, suggestRoute, exit_building; the 'mesh-bbox centers' note; outside sentinel other_cell_id==0xFFFF).
4. How are dungeon cells streamed/loaded: the whole dungeon landblock at once, or PVS around the player's cell? eagerDungeons? Can a camera visit cells far from the player in the same dungeon and see geometry?
5. Geometry available for camera clearance/raycasts indoors: wall/floor/ceiling polygons per cell, bboxes, portal polygon centers+normals (to fly through doorways). Units/frames.
6. Hazards: portal bleed, building EnvCells sharing one frame origin, stencil vs non-stencil path, sealed cells, anything that breaks when a free camera crosses a portal.` },
  { key: 'terrain-streaming', prompt: `SUBSYSTEM: TERRAIN, STREAMING, RESIDENCY, COORDINATES.
Files: scene3d/terrain.js, terrain_oracle.js, far_terrain.js, far_terrain_flags.js, landblock_lru.js, residency.js, residency_grid.js, fixed_grid.js, pack_fetch_controller.js, tile_plan.js, spawns.js, statics.js + buildings.js (streaming parts only), scene3d/index.js (streaming center / per-frame residency update), pkg/holtburger_web.d.ts (height/terrain queries), docs/url-flags.md rows for pvsRingRadius, farRing, farTerrain, eagerDungeons, terrainFog.
Answer precisely:
1. Terrain height (and normal / water) query at arbitrary AC world (x,y): JS or wasm function, exact signature, frame (global vs landblock-local), works for not-yet-loaded landblocks? Needed for drone altitude-above-ground, terrain following, and camera ground clearance.
2. What is streaming/residency centered on — player position, camera position, or both? Exact variable/function (file:line). If the film camera flies 500 m–2 km from the player, what loads/unloads? Any API to override the streaming focus or prewarm a region (force-load LBs around a point) and a readiness signal (terrainBakedLbs, mesh-count, residency state)?
3. Which content is client-baked (dist: terrain, statics/scenery, buildings, dungeons?) vs server-streamed (creatures/NPCs/players/items within some radius of the player)? So: what does a far drone shot show?
4. Draw distance knobs (pvsRingRadius, farRing/farTerrain, fog distances, far plane 5000 m) — what's visible from a high-altitude drone (100–500 m AGL)? Popping/LOD/bake latency when the camera moves fast; bake worker gotchas.
5. Landblock coordinate conventions + helper functions: LB id (x_byte<<24|y_byte<<16|cell), local 0..192 m, global coords, map lat/lng (the @tele <lat><n|s> <lng><e|w> convention), conversions to three.js scene coords. List the helpers with file:line.
6. Filming hazards: pop-in, half-baked LBs, frozen pose.landblockId, nosw service worker cache, measurement traps.` },
]

phase('Recon')
const results = await parallel(TASKS.map(t => () =>
  agent(PRE + '\n\n' + t.prompt, { label: 'recon:' + t.key, phase: 'Recon', schema: MAP })
    .then(r => (r ? { key: t.key, ...r } : null))))
const ok = results.filter(Boolean)
log('recon done: ' + ok.length + '/' + TASKS.length)
return ok
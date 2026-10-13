export const meta = {
  name: 'film-recon-tooling',
  description: 'Read-only recon of capture/CDP, AI+WBT ontology gazetteer, world control, conventions for AC film mode',
  phases: [{ title: 'Recon', detail: 'capture+driving, WBT ontology+gazetteer, world/actor control, conventions+tests+packaging' }],
}

const PRE = `You are a read-only reconnaissance agent for a new feature: "Asheron's Call FILM MODE" for holtburger-web (the JS/three.js + Rust/wasm Asheron's Call web client).

FEATURE CONTEXT (so you know what matters): an optional, default-OFF, agentic cinematography mode. The "agent" is a Claude Code session (Opus 5.5 via the user's subscription — NO Anthropic API calls in code). A user pastes a rough script; the agent turns it into a filming plan; JEV (TypeSafe's typed decision model on OpenRouter, Decisions API) makes fast typed decisions (choose shot candidates, score lyric↔site matches); for music videos it analyses song structure and maps lyrics to in-world sites (using the WorldBuilder.Terminal ontology). The agent drives the web client headlessly (Chrome over CDP, later on a GTX-1070 box) and records HUD-free footage using all common film techniques plus advanced drone techniques. The camera must understand physobjs and particle effects that could obstruct the view, move smoothly through dungeons, and shift angles smoothly even at 90 degrees without gimbal flips.

YOUR JOB: produce a VERIFIED map of ONE area so the orchestrator can design film mode without re-reading everything. Read the actual code/data. Every file:line you cite must be one you actually read (agents have hallucinated file:line before — set verified=false for anything you did not read). Prefer exact function names, signatures, field names, flags, command names, file paths and formats. Be dense; no filler.

PATHS: REPO=/home/wbterminal/WorldBuilder-ACME-Edition ; HB=$REPO/external/holtburger/apps/holtburger-web ; WBT=$REPO/WorldBuilder.Terminal ; memory dir /home/wbterminal/.claude/projects/-home-wbterminal/memory/ (ace-live.md, fleet-runbooks.md, recall-overflow.md hold runbooks). Cite paths relative to HB when inside it.

HARD RULES:
- Parallel agents may read, edit and run TARGETED single tests only (\`node test_x.mjs\`). They must NOT run the full JS gate, cargo, wasm-pack or browsers. The orchestrator runs the full gate and builds ONCE, after merging, one at a time.
- You are READ-ONLY: do not create, edit or delete any file. Do not start servers, browsers, Chrome, node test gates, cargo or dotnet builds. Do NOT edit/rebuild ~/ace-server (keep ACE vanilla). You MAY run a single quick read-only WBT command if essential (echo '{"command":"help"}' | DOTNET_ROLL_FORWARD=LatestMajor dotnet $WBT/bin/Release/net8.0/WorldBuilder.Terminal.dll --stdin 2>/dev/null | tail -1) — at most a couple, one at a time, nothing heavy.
- Use \`rg\` (ripgrep) for search; NEVER pass -rn / -rln / -r flags to rg (-r means --replace). Use \`rg -n PATTERN FILE\`, \`sed -n 'A,Bp' FILE\`. Big files: navigate with rg, read ranges.
- Output via the StructuredOutput schema. "summary" should be a dense technical briefing (can be long). apis[] = concrete reusable functions/commands; seams[] = integration points (how film mode uses them); hazards[] = gotchas; dataSources[] = data files/stores worth reusing (path, format, size).`

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
  { key: 'capture-driving', prompt: `AREA: VIDEO CAPTURE, FRAME STEPPING, HEADLESS CHROME DRIVING.
Files: capture_canvas_video.cjs, harness/lib/boot.mjs, harness/playwright/drive.mjs, harness/moving-bench.mjs, harness/vistest-1070-round1-7.mjs, harness/cmdinterp-1070.mjs, $REPO/external/holtburger/scripts/perf-worker/hbprobe.mjs, scripts/perf-worker/coldboot/{camset,probe,enterchar}.mjs, scripts/perf-worker/coldboot/pw1070/, scene3d/loop.js (renderOnDemand/__renderOnce/targetFps/nullRender), scene3d/index.js (WebGLRenderer creation: preserveDrawingBuffer? final composer pass to the canvas?), docs/url-flags.md rows for those flags, memory fleet-runbooks.md (1070 MODE2i CDP :9333; T4 'page.screenshot = BLACK world, capture must readPixels inside the render call'; 'canvas-element screenshot = HUD-free beauty frame'). ffmpeg static build: /home/wbterminal/src/ffmpeg-7.0.2-amd64-static. Node is v20.20.2.
Answer precisely:
1. How existing scripts connect to Chrome (playwright-core from ~/.npm/_npx, raw CDP WebSocket with node --experimental-websocket, chrome-remote-interface?). Is there a reusable minimal CDP client module in the repo? Exact paths.
2. Boot recipe: URL + flags (autoLogin, account, autoSpawn, agent=1, nosw=1, quality...), gating on __bootState/__bootStateHistory/'ready', readiness (liveScene3d ~35 s after in-world, mesh counts), accounts, single-login ~25 s gap.
3. Recording: does canvas.captureStream + MediaRecorder work with this renderer (where does the final composer pass draw — default framebuffer?), preserveDrawingBuffer value, how capture_canvas_video.cjs extracts the webm (chunks via evaluate? download?), codecs/bitrates. Deterministic frame grabs: renderOnDemand + __renderOnce + toBlob/readPixels inside render; CDP transfer throughput (base64), Page.startScreencast alternative.
4. Determinism: can the client clock be stepped (fixed dt per frame) so frame-stepped capture is smooth at 30/60 fps even when rendering is slow? Which clocks would need patching (performance.now, requestAnimationFrame, Date.now, particle/animation/sky clocks)? Any existing time-scale/freeze hooks?
5. Output resolution control for capture (canvas size, DPR, ?renderScale, ?adaptiveRes=off, ?quality=ultra) and best-quality flags for the 1070.
6. Hazards: SW cache (?nosw=1), bake worker, --mute-audio, off-screen window, one-tab rule, Chrome dying mid-run, playwright keeping the event loop alive.` },
  { key: 'wbt-ontology-gazetteer', prompt: `AREA: WORLD KNOWLEDGE FOR "LYRICS → SITES": WorldBuilder.Terminal ONTOLOGY, LANDBLOCK DESCRIPTIONS, NAMED PLACES, LORE, + REUSABLE AI INFRA.
Files: $WBT/JsonCommandProcessor.cs (dispatch table ~line 215; find commands about ontology, describe-landblock, search/query/list, regions, dungeons, POIs, placements), $WBT/LandblockDescriber.cs, $REPO/WorldBuilder.Shared/Lib/OntologyEntry.cs, OntologyService (rg -l 'class OntologyService' $REPO --type cs), VisualDescriptor.cs, WeenieIndex.cs, $REPO/pipeline_data/enrichment/canonical_enrichment.json, $REPO/weenie_index.md, $REPO/WorldBuilder.Tests/OntologyServiceTests.cs; HB rynth/ai/README.md, SPEC.md, providers.js, llm_client.js (patterns only), tools/knowledge.js + knowledge.acpedia.json + knowledge.grounded.json + bake_knowledge_acpedia.py, tools/world.js, tools/towns.js, tools/routes.js, tools/dungeon_nav.js, tools/wbt.js; $REPO/external/holtburger/apps/wbt-sidecar/{README.md,wbt_sidecar.cjs} (READ_ALLOW list); memory ace-live.md (tele catalog, @telepoi list), recall-overflow.md (town-coords).
Answer precisely:
1. What the ontology contains (per Setup/GfxObj: category, scale, tags, material tags, names, weenie links), WHERE the built ontology data lives on disk (path, size, format; rg for 'ontology' cache files / json under $REPO and /mnt/wbterminal*), and which WBT commands query it. Can we find "objects tagged tree/tower/bridge/statue/fire/ship/ruins" AND where they are placed in the world (landblock placements)? Which command maps objects → placements?
2. describe-landblock (and similar): exact args + return shape (terrain types, region, named places, objects, buildings, dungeons), cost per call; can we batch-describe all land landblocks into an offline gazetteer? Does it need a .wbproj (-p)?
3. Named places WITH COORDINATES: towns (towns.js), routes, @telepoi list, dungeons (names + entrance coords + dungeon LB ids), landmarks (lifestones, portals, statues, towers), acpedia lore text per place (knowledge.acpedia.json: structure, size, coverage).
4. wbt-sidecar: endpoints, allowlist (which ontology/describe commands are allowed), start command, and alternatively spawning WBT directly from a Node CLI (startup time, -p project requirement).
5. PROPOSE the best pipeline for a "site gazetteer" for film mode: per site {name, kind (town/dungeon/landmark/wilderness), teleport string (@teleloc cell x y z | @tele lat lng | @telepoi name), biome/terrain types, elevation, notable objects (ontology tags), visual descriptors, lore text, indoor/outdoor}. Which existing artifacts can be reused directly vs must be generated?
6. Reusable AI infra patterns for a Node-side JEV client (OpenRouter Decisions API): how existing code stores the OpenRouter key (localStorage? env? file?), providers catalog, cost estimation, typed errors/retries, mock server (mock_llm_server.cjs) for tests.` },
  { key: 'world-actor-control', prompt: `AREA: WORLD CONTROL FOR FILMING — teleport, player visibility, time/weather, actor direction, spawning extras.
Files: HB pkg/holtburger_web.d.ts (SessionHandle methods: list everything relevant — sendChat, pose getters, movement input, motion/emote commands, targeting, entity queries, cell queries), index.html + scene3d (how window.__sessionHandle is used; autoLogin/autoSpawn), scene3d/entities.js (local player rig visibility), memory /home/wbterminal/.claude/projects/-home-wbterminal/memory/ace-live.md and fleet-runbooks.md (admin cmds: @teleloc, @tele <lat><n|s> <lng><e|w>, @telepoi, @attackable off), ACE command handlers /home/wbterminal/ace-server/Source/ACE.Server/Command/Handlers/ (rg for: teleloc, tele, telepoi, teleto, cloak, invis, visible, attackable, time, daytime, weather, create, delete, anim, emote, motion, freeze, god, speed, run, portal) — READ ONLY, never edit/rebuild ACE.
Answer precisely:
1. Teleport options & semantics (@teleloc cell x y z [qw qx qy qz] — z near terrain; @tele lat/lng server-derived z; @telepoi names; @teleto/@teletome; dungeon cell teleports), required access level, readiness after teleport (portal space, server landblock load), cooldowns/rate limits between consecutive teleports.
2. Making the player unobtrusive: ACE @cloak (effect on own client view? on others?), @attackable off, client-side hide of the local player rig (where is its visibility toggled in scene3d?).
3. Server-side time-of-day/weather commands in ACE, if any; otherwise note client-side needs.
4. Actor direction: making the player perform animations/emotes (chat emotes like *wave*, motion commands, sit/kneel/dance, @anim?), walking a path (setMovementInput, auto-run, turn), facing; spawning NPC/creature extras (@create wcid [count]) and removing them (@delete / @smite?), keeping them docile. What ACE sends: emote/motion broadcast to the client so the client animates it.
5. Server object-streaming radius around the player (landblock + adjacent? exact rule in ACE), UpdatePosition rates — impact on tracking shots of moving entities (client interpolation smoothness).
6. A verified inventory of SessionHandle methods relevant to film mode with exact signatures from the d.ts.` },
  { key: 'conventions-packaging', prompt: `AREA: PROJECT CONVENTIONS — tests, gate, lint, flags docs, lazy-load pattern, service worker, Node CLI style, Claude Code skill/agent packaging, git.
Files: HB harness/run-js-headless.mjs (how tests are registered/run), harness/README.md, harness/lib/scene3d_stubs.mjs, HB _three_stub.mjs + _three_stub_loader.mjs, 2-3 recent representative tests (e.g. test_a5_p2_tween_clock.mjs, test_radar_projection.mjs, test_trail_map.mjs, rynth_ai_client_test.cjs), $REPO/external/holtburger/scripts/lint-url-flags.mjs and scripts/audit-flag-defaults.mjs (or wherever they live), docs/url-flags.md (row format, §0 default-OFF rows, the section where new flags go), harness/test_suite_hygiene.mjs, harness/test_console_allowlist.mjs + lib/console_allowlist.mjs, harness/test_build_shell.mjs + shell-manifest.json + service-worker.js (must new files be listed anywhere? caching of new dirs), examples in scene3d/index.js / index.html of lazily importing an optional module only when a URL flag is set (zero cost when off), existing Node CLIs (apps/holtburger-web/tools/, scripts/), $REPO/.claude/skills/worldbuilder-terminal/ (SKILL.md frontmatter + structure) and ~/.claude/skills/ (symlinks?), git: $REPO/external/holtburger is a submodule on branch master — commit message style (git -C $REPO/external/holtburger log --oneline -15), whether the parent repo records submodule bumps (git -C $REPO log --oneline -8).
Answer precisely:
1. Exactly how to add new test files so the JS gate runs them (explicit list? glob? flags table?), test style (plain node + assert, exit codes, output format), stubbing three.js/window/document in node.
2. Suite-hygiene/console-allowlist/lint rules new files must satisfy (e.g. every URL-flag reader needs a url-flags.md row; default-OFF flags need a §0 row; banned patterns; console.* rules; file naming).
3. The lazy-load pattern for an optional module gated by a URL flag — 2 concrete examples with file:line, and how flags are read (URLSearchParams exact-match conventions; the '!== "off"' vs '=== "on"' footgun).
4. Will new JS files under HB/film/ be served by serve.py and handled by the service worker / shell manifest without registration? Anything that must list them?
5. Claude Code packaging: where a new skill (SKILL.md) and a custom agent definition (agents/*.md with model: opus) should live so they work from the user's usual cwd (/home/wbterminal) and from the repo; frontmatter fields used by the existing worldbuilder-terminal skill.
6. Node CLI conventions (ESM .mjs vs .cjs, arg parsing, process.exit discipline) and commit conventions.` },
]

phase('Recon')
const results = await parallel(TASKS.map(t => () =>
  agent(PRE + '\n\n' + t.prompt, { label: 'recon:' + t.key, phase: 'Recon', schema: MAP })
    .then(r => (r ? { key: t.key, ...r } : null))))
const ok = results.filter(Boolean)
log('recon done: ' + ok.length + '/' + TASKS.length)
return ok
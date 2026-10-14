export const meta = {
  name: 'film-fix-followups',
  description: 'Fix the defects the docs lane and the orchestrator found (CLI run/status/doctor, plan schema gaps, jev_tasks roles), update the skill docs, then verify',
  phases: [
    { title: 'Fix', detail: 'file-disjoint clusters, one at a time' },
    { title: 'Check', detail: 'independent check per cluster' },
  ],
}

const HB = '/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web'
const REPO = '/home/wbterminal/WorldBuilder-ACME-Edition'
const SKILL = REPO + '/.claude/skills/film-mode'

const RULES = `HARD RULES (verbatim from ~/CLAUDE.md): Parallel agents may read, edit and run TARGETED single tests only (\`node test_x.mjs\`). They must NOT run the full JS gate, cargo, wasm-pack or browsers. The orchestrator runs the full gate and builds ONCE, after merging, one at a time.
Also: no git commands that change state; never arm background automation; no Anthropic API/SDK/keys; never start browsers, servers, ACE, dotnet, cargo or wasm-pack; no real network calls (OpenRouter included); never write any account password anywhere. Tests: node:assert/strict, local check(), final "<suite>: N passed, M failed", must EXECUTE code, no SKIP banners. Run only the targeted suites named below, one at a time, from ${HB}.`

const CONTEXT = `PROJECT: "AC Film Mode" for holtburger-web (optional, default-OFF ?filmMode=on agentic cinematography; Claude Code director, JEV reflexes, stepped WebCodecs capture). Contracts: ${HB}/scene3d/film/SPEC.md (§5.2 = Plan/Timeline/Take). Director docs: ${SKILL}/SKILL.md + reference/*.md. Developer README: ${HB}/scene3d/film/README.md. An earlier adversarial review/fix workflow may already have touched some of these files — READ THE CURRENT CODE FIRST and skip (reporting 'already fixed') anything that is no longer a defect.`

const FIXREPORT = {
  type: 'object',
  properties: {
    fixed: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, what: { type: 'string' } }, required: ['id', 'what'] } },
    skipped: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, why: { type: 'string' } }, required: ['id', 'why'] } },
    filesTouched: { type: 'array', items: { type: 'string' } },
    tests: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, passed: { type: 'integer' }, failed: { type: 'integer' } }, required: ['file', 'passed', 'failed'] } },
  },
  required: ['fixed', 'skipped', 'filesTouched', 'tests'],
}
const CHECK = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    problems: { type: 'array', items: { type: 'string' } },
    tests: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, passed: { type: 'integer' }, failed: { type: 'integer' } }, required: ['file', 'passed', 'failed'] } },
  },
  required: ['ok', 'problems', 'tests'],
}

const CLUSTERS = [
  {
    key: 'cli',
    files: `${HB}/tools/film/film.mjs, ${HB}/tools/film/lib/*.mjs (except jev*.mjs and decode_audio.mjs), ${HB}/tests/film_cli.test.mjs, ${HB}/tests/film_cli_session.test.mjs, ${SKILL}/SKILL.md, ${SKILL}/reference/workflow.md, ${SKILL}/reference/1070.md, ${HB}/scene3d/film/README.md (CLI section only)`,
    items: `A1 (BUG) film.mjs RUN_PASSTHROUGH includes 'song', so \`film run <dir> --song=X\` hands the same X to plan validate/compile (expects song.json) and assemble (expects audio). Fix: drop 'song' from the passthrough; add \`--song-analysis=<song.json>\` (→ plan validate/compile --song) and \`--song-audio=<audio>\` (→ assemble --song); default to plan.song.analysis / timeline.song.file resolved relative to the project. Test it.
A2 (GAP) there is no \`film status\` / release subcommand, but the 1070 eye-test checklist (handoff §8, ${SKILL}/reference/1070.md) records \`__film.status()\` per item and checks own()/release(). Add \`film status [--release] [--own] [--clean=on|off] [--json]\` (Chrome-driving: heavy lock, connect over CDP to the existing film page, never launch; prints status JSON; --release calls __film.release() then clean(false) and reports avatar/follow restoration via status). Test with the fake page. Then REPLACE the read-only Playwright probe workaround in 1070.md / workflow.md / SKILL.md with the new subcommand.
A3 (GAP) film.mjs doctor's CDP-unreachable hint prints only \`ssh -fN -L 9333:127.0.0.1:9333 <1070>\`; a film session needs the full three-forward tunnel from the fleet runbook: \`ssh -o ExitOnForwardFailure=yes -fN -L 9333:127.0.0.1:9333 -R 8765:127.0.0.1:8765 -R 8080:127.0.0.1:8080 young@100.127.215.75\` (without -R 8080 the login dies with 'WsTransport ws handshake failed'). Print the full line (make host overridable by --host or env FILM_1070_HOST). Test the hint text.
A4 (BUG, cosmetic) film.mjs ~line 561 (sites search formatter) prints \`\${ns.toFixed(1)}N \${ew.toFixed(1)}E\`, so southern/western sites read "-80.8N 61.6E". Use formatMap from scene3d/film/core/units.js everywhere the CLI prints map coords (search, show, go). Test.
A5 (GAP) jev_tasks scoreSiteForLine / sectionTechniqueFamily / pickCandidate / keepOrRetake have no CLI surface beyond what scout/shoot use. Add \`film jev task <pick|keep|site-fit|family> --input=<json|file> [--json]\` (real client via resolveJevKey; no key → the deterministic code verdict with source 'code'); document it in workflow.md. Test with an injected fake client.
After the code: update the director docs you own above so every command/flag they mention exists (run \`node tools/film/film.mjs <cmd> --help\` to confirm). Run tests/film_cli.test.mjs and tests/film_cli_session.test.mjs.`,
  },
  {
    key: 'plan',
    files: `${HB}/tools/film/plan/schema.mjs, ${HB}/tools/film/plan/compile.mjs, ${HB}/tests/film_plan_schema.test.mjs, ${HB}/tests/film_plan_compile.test.mjs, ${SKILL}/reference/plan-format.md, ${HB}/scene3d/film/SPEC.md (§5.2 only)`,
    items: `B1 (GAP) schema.mjs normShot/compile ignore a technique's capture:'realtime' hint (registry def or meta.capture — classic.tracking-follow/-lead/-side, drone.chase/lead/side-track/top-down-track; read shots/classic.js and shots/drone.js to see where the hint lives). Such a shot with an entity/player subject and no explicit capture compiles as stepped and the server-driven subject would stutter. Fix: when a registry is given and the technique hints realtime, default capture.mode to 'realtime' (capture.auto=true) for entity/player subjects, and WARN for other subjects that keep 'stepped'. Test both.
B2 (GAP) Plan v1 has no shot \`bounds\`, although ShotSpec.bounds is a registry-supported director override of the pilot bounds (shots/registry.js). Add \`bounds\` to SHOT_KEYS + PLAN_FIELDS, validate the six keys (maxLateral, maxRise, maxSink ≥ 0 metres; minSpeedScale ≤ 1 ≤ maxSpeedScale, maxDistanceScale ≥ 1 — read registry.js for the exact semantics) and pass it through shotSpec. Test.
B3 (BUG) look.dof.focusRange is validated with min 0 inclusive, but the window.__dof seam requires focusRange > 0 (scene3d/atmosphere_pipeline.js createFilmDof setter throws RangeError). Make it exclusive (> 0); check every other look.dof field against the setter's real constraints too. Test.
B4 (GAP) the offline dry build (dryContext/dryBuild) ignores shot.route, so every indoor fpv.fpv-corridor shot gets a misleading 'needs a route' warning. Fix: when s.route is set, give the dry context a synthetic indoor route (e.g. a 2-leg L through the anchor) or skip the dry build with no warning — prefer the synthetic route so params are still validated. Test that examplePlan() validates with zero warnings against the REAL registry (import scene3d/film/shots/index.js) with dryBuild:true.
After the code: update reference/plan-format.md (fields, defaults, warnings) and SPEC §5.2 to match. Run tests/film_plan_schema.test.mjs and tests/film_plan_compile.test.mjs, then tests/film_cli.test.mjs (it consumes the plan modules).`,
  },
  {
    key: 'jev-tasks',
    files: `${HB}/tools/film/lib/jev_tasks.mjs, ${HB}/tests/film_jev_broker.test.mjs (its jev_tasks section), ${SKILL}/reference/music-video.md (role names only)`,
    items: `C1 (BUG, minor) jev_tasks.mjs SECTION_ROLES lists 'solo' but the song analyser emits 'instrumental' (tools/film/audio/structure.mjs SECTION_ROLES = intro, verse, prechorus, chorus, bridge, instrumental, outro, unknown), so sectionTechniqueFamily's 'bridge or solo' rule never matches an analysed instrumental section. Use the analyser's role list (import SECTION_ROLES from structure.mjs if that keeps jev_tasks Node-only and dependency-light; else mirror it with a test asserting equality), accept 'solo' as an alias of 'instrumental', fix the criteria text and the code verdict. Test. Run tests/film_jev_broker.test.mjs and tests/film_jev_client.test.mjs.`,
  },
]

phase('Fix')
const results = []
for (const c of CLUSTERS) {
  const r = await agent(`${CONTEXT}\n\n${RULES}\n\nYou are a fix agent for cluster "${c.key}". Files you may edit: ${c.files}. Fix each item below (or report it as already fixed / not a defect with evidence). Add a regression check for every code fix in the named suites.\n\n${c.items}`, { label: `fix:${c.key}`, phase: 'Fix', schema: FIXREPORT })
  results.push({ cluster: c.key, result: r })
}

phase('Check')
const checks = await parallel(results.map((fr, i) => () => agent(`${CONTEXT}\n\n${RULES}\n\nIndependently check fix cluster "${fr.cluster}". The items were:\n${CLUSTERS[i].items}\n\nFix agent report:\n${JSON.stringify(fr.result, null, 2)}\n\nRead the current code and docs, confirm each item is actually fixed (or rightly skipped), probe with throwaway scripts under /tmp/claude-1000/ where useful, re-run the targeted suites named in the items one at a time, and confirm every command/flag the edited docs mention exists (\`node ${HB}/tools/film/film.mjs <cmd> --help\`). ok=false if anything is not fixed, regressed, or the docs mention something that does not exist.`, { label: `check:${fr.cluster}`, phase: 'Check', schema: CHECK })))

return { results, checks }

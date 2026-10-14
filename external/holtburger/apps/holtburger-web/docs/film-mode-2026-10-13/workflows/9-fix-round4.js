export const meta = {
  name: 'film-fix-round4',
  description: 'Round 4: make scenery fades conservative (no fade key without exact attribution) to remove the false-clear-view defect, plus the last CLI/doc nits; then check',
  phases: [
    { title: 'Fix', detail: 'perception + pilot text + docs, then CLI/doc nits (sequential)' },
    { title: 'Check', detail: 'independent check per fix' },
  ],
}

const HB = '/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web'
const REPO = '/home/wbterminal/WorldBuilder-ACME-Edition'
const R3 = HB + '/docs/film-mode-2026-10-13/review/round3-fix-results-2026-10-14.json'

const RULES = `HARD RULES (verbatim from ~/CLAUDE.md): Parallel agents may read, edit and run TARGETED single tests only (\`node test_x.mjs\`). They must NOT run the full JS gate, cargo, wasm-pack or browsers. The orchestrator runs the full gate and builds ONCE, after merging, one at a time.
Also: no git commands that change state; never arm background automation; no Anthropic API/SDK/keys; never start browsers, servers, ACE, dotnet, cargo or wasm-pack; no real network calls; never touch ~/ace-server; never write any account password anywhere. Throwaway probes only under /tmp/claude-1000/ (never in the repo). Tests: node:assert/strict, local check(), final "<suite>: N passed, M failed", must EXECUTE code, no SKIP banners; run only targeted suites, one at a time, from ${HB}.`

const CONTEXT = `PROJECT: "AC Film Mode" for holtburger-web — optional default-OFF (?filmMode=on) agentic cinematography. Contracts: ${HB}/scene3d/film/SPEC.md; seams: ${HB}/scene3d/film/runtime/SEAMS.md; README: ${HB}/scene3d/film/README.md; director docs: ${REPO}/.claude/skills/film-mode/. Round-3 results incl. every checker's full problem text (with probe paths under /tmp/claude-1000/ you can re-run): ${R3}. Read the CURRENT code first.`

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

const A = {
  key: 'r4-scenery-fade',
  brief: `RESUME NOTE (relaunch after the Claude Code process exited): a previous run of THIS cluster already changed the CODE and TESTS (world_query.js describeHit → scenery fadeKey always null via FADEABLE_STATIC_SOURCES, sensors.js, questions.js, tests/film_perception + film_pilot_* — 39/39 perception passing at its last run) but had NOT yet updated any DOCS and was in the middle of a mutation check under /tmp/claude-1000/r4-scenery-fade/. READ the current code and tests, KEEP them (fix only what is wrong), re-run the suites, do a quick mutation check (revert the scenery-null rule in a /tmp copy → the new tests must fail), then do ALL the doc updates below.\nORCHESTRATOR DECISION (binding): the round-3 check "check:r3-perception" (read it in ${R3}) proved that attributing a SCENERY (procedural, physics-collider) hit to one placement from geometry alone is unreliable on real data — the main real boulder 0x02001065 (87% of collidable scenery rocks) still yields a tree's fade key (a FALSE CLEAR VIEW: the sensors then see through a rock), and off-axis multi-trunk trees (0x0200035F, 0x02000251, …) lose their key to a neighbour. CollisionHit carries only t/x/y/z/normal — no placement identity — so exact attribution needs a wasm change (out of scope for v1). Therefore for v1: SCENERY hits NEVER produce a fade key (describeHit still reports kind/did from the nearest plausible placement for labelling, but fadeKey is always null for the scenery layer); fades remain for STATICS (Stab placements attributed from render-mesh bounds under STATIC_HIT_RULES), ENTITIES and PARTICLE clouds. With no key, the existing safety net applies: mapper falls back to reroute, take_player reroutes when a fade hides nothing. Make sure no code path can count a scenery hit as "seen through" (sensors fadedIds/seenThrough). Keep the scenery attribution helpers only if still used for labelling; otherwise remove dead code cleanly. Update tests/film_perception.test.mjs (W14/S14 and any test that expects a scenery fade key now expects none; add a test that the boulder-next-to-tree and twin-trunk configurations from the checker's probes give NO key and the subject stays reported hidden), and run film_pilot_loop/film_runtime_capture/film_api too. Update scene3d/film/pilot/questions.js occluder_action text to match exactly: the runtime fades placed props and placed trees of known size, entities and particle smoke; procedural (terrain) trees and rocks are rerouted around — keep the criteria/code agreement tests green (film_pilot_words, film_pilot_policy). Fix the stale staticKindOf JSDoc (tip-flex is not 'bushes / grass clumps' — see the checker text). Then update the docs to the new rule: SPEC.md §3.1 (subject.occluderIds), runtime/SEAMS.md, README.md world_query row, ${REPO}/.claude/skills/film-mode/reference/{pilot,workflow,techniques}.md and SKILL.md wherever they say trees fade; and add to SPEC.md a short "v2: exact scenery fades need a placement index on CollisionHit from the wasm scenery sweep" note in the place that describes the limitation.`,
  files: `scene3d/film/scene/world_query.js, scene3d/film/scene/sensors.js, scene3d/film/pilot/questions.js, tests/film_perception.test.mjs, tests/film_pilot_words.test.mjs, tests/film_pilot_policy.test.mjs, tests/film_pilot_loop.test.mjs, tests/film_runtime_capture.test.mjs, scene3d/film/SPEC.md, scene3d/film/runtime/SEAMS.md, scene3d/film/README.md, ${REPO}/.claude/skills/film-mode/SKILL.md, ${REPO}/.claude/skills/film-mode/reference/*.md`,
}
const B = {
  key: 'r4-nits',
  brief: `Small leftovers from the round-3 checks (texts in ${R3}): (1) tools/film/lib/shoot.mjs: ISSUE_FIELDS keeps the page's limitedBy and minDurationVerified on overspeed issues; overspeedFromFlight's fallback wording reflects verified vs estimate; fix the stale FLIGHT_GAP_WARN_M comment and the header line that says each issue prints ONE warning line per shot (it is per run); test the fields survive. (2) ${REPO}/.claude/skills/film-mode/reference/workflow.md: note that maxGapM on an 'overspeed' issue is the DRY-flown gap at prepare (sampled at 10 Hz, the realised gap can be up to ~20% larger) while on 'tracking-gap' it is the realised gap. (3) SPEC.md §1.1 and runtime/SEAMS.md 'Static catalogs' degrade wording: state the exact condition under which the VFX catalog stays empty (read entities.js / statics bake: ?windGeo=on loads it without the visual gate) — and the same sentence in pilot.md/workflow.md/techniques.md. (4) SPEC §3 Prepare summary: minDurationCheck is null (not 'unverified') when no estimate exists — state the real rule from take_player.js. (5) SPEC.md: reflow the over-long lines the checker named (≤ 120 chars) without changing meaning. (6) Document in SPEC §5.2 Live subjects (and techniques.md tracking/chase notes) the measured physical floor: a subject turning at ~90°/s can push flown side-track/chase rigs ~0.5–25% outside ±15% (U-turn) and the CLI tracking-gap warning (> 2 m) is the signal to retake with a gentler move.`,
  files: `tools/film/lib/shoot.mjs, tests/film_cli_session.test.mjs, tests/film_cli.test.mjs, scene3d/film/SPEC.md, scene3d/film/runtime/SEAMS.md, ${REPO}/.claude/skills/film-mode/reference/{workflow,pilot,techniques}.md`,
}

phase('Fix')
const fixes = []
for (const c of [A, B]) {
  const r = await agent(`${CONTEXT}\n\n${RULES}\n\nYou are the fix agent for "${c.key}". Files you may edit (relative to ${HB} unless absolute): ${c.files}.\nBRIEF:\n${c.brief}\n\nAdd regression checks that EXECUTE each changed path. Run the named suites and every suite importing a module you changed (rg), one at a time; all must pass.`, { label: `fix:${c.key}`, phase: 'Fix', schema: FIXREPORT })
  fixes.push({ key: c.key, brief: c.brief, result: r })
}

phase('Check')
const checks = await parallel(fixes.filter(f => f.result).map(f => () => agent(`${CONTEXT}\n\n${RULES}\n\nIndependently check fix "${f.key}". Brief:\n${f.brief}\nFix report:\n${JSON.stringify(f.result, null, 2)}\n\nConfirm every item is done against the CURRENT code/docs (for r4-scenery-fade: re-run the round-3 checker's real-catalog probes named in ${R3}, prove no scenery hit can yield a fade key or be seen through, and that statics/entity/particle fades still work end to end), re-run the relevant suites one at a time, confirm no regression and zero-cost-when-off. ok=false only for a real defect or regression; prefix non-blocking notes with NON-BLOCKING.`, { label: `check:${f.key}`, phase: 'Check', schema: CHECK }).then(c => ({ key: f.key, check: c }))))

return { fixes, checks }

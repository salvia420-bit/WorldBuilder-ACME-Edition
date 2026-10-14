export const meta = {
  name: 'film-fix-round2',
  description: 'Round 2: fix what the round-1 checks flagged (drone roll seam, static fade key + catalogs, live-subject pre-roll surge + overspeed surfacing, bars pickup, CLI abort race), sync every doc with the code, then check',
  phases: [
    { title: 'Fix', detail: 'page lane and node lane in parallel, sequential within each' },
    { title: 'Docs', detail: 'one docs-sync agent after all code fixes' },
    { title: 'Check', detail: 'independent check per cluster' },
  ],
}

const HB = '/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web'
const REPO = '/home/wbterminal/WorldBuilder-ACME-Edition'
const REVIEW = HB + '/docs/film-mode-2026-10-13/review/review-2026-10-14.json'
const ROUND1 = HB + '/docs/film-mode-2026-10-13/review/round1-fix-results-2026-10-14.json'

const RULES = `HARD RULES (verbatim from ~/CLAUDE.md): Parallel agents may read, edit and run TARGETED single tests only (\`node test_x.mjs\`). They must NOT run the full JS gate, cargo, wasm-pack or browsers. The orchestrator runs the full gate and builds ONCE, after merging, one at a time.
Also: no git commands that change state; never arm background automation; no Anthropic API/SDK/keys; never start browsers, servers, ACE, dotnet, cargo or wasm-pack; no real network calls; never touch ~/ace-server; never write any account password anywhere. Throwaway probes only under /tmp/claude-1000/ (never in the repo). Tests: node:assert/strict, local check(), final "<suite>: N passed, M failed", must EXECUTE code, no SKIP banners; run only targeted suites, one at a time, from ${HB}.`

const CONTEXT = `PROJECT: "AC Film Mode" for holtburger-web — optional default-OFF (?filmMode=on) agentic cinematography (Claude Code director, JEV reflexes, code safety clamp, stepped WebCodecs capture, shoot by location). Contracts: ${HB}/scene3d/film/SPEC.md; seams: ${HB}/scene3d/film/runtime/SEAMS.md; README: ${HB}/scene3d/film/README.md; director docs: ${REPO}/.claude/skills/film-mode/.
Review record: ${REVIEW} (findings by id). Round-1 fix results: ${ROUND1} — "checks" holds each round-1 checker's report (problems quoted below come from there; read the full text), "docsToUpdate" the doc passages fixers could not update, "skipped" the items fixers deferred. Read the CURRENT code first.`

const FIXREPORT = {
  type: 'object',
  properties: {
    fixed: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, what: { type: 'string' } }, required: ['id', 'what'] } },
    skipped: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, why: { type: 'string' } }, required: ['id', 'why'] } },
    filesTouched: { type: 'array', items: { type: 'string' } },
    tests: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, passed: { type: 'integer' }, failed: { type: 'integer' } }, required: ['file', 'passed', 'failed'] } },
    docsToUpdate: { type: 'array', items: { type: 'string' } },
  },
  required: ['fixed', 'skipped', 'filesTouched', 'tests', 'docsToUpdate'],
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

const PAGE = [
  {
    key: 'r2-drone',
    files: `scene3d/film/drone/flight_model.js, tests/film_flight_model.test.mjs, tests/film_shots_drone.test.mjs`,
    brief: `Round-1 check "check:drone" found a BLOCKING regression from the math-1/contracts-8 fix in flight_model.js applyGimbalLimits: the new roll band lim = max(rollLim, |rT| + 2°) is symmetric about level and breaks across the ±180° roll seam (target roll crossing ±180° while the gimbal lags > 2° leaves the camera on the far side and the shrinking band pushes it the long way round). Read the full problem text in ${ROUND1} checks["check:drone"]. Fix: limit the roll ERROR relative to the target's own roll with wrap-aware angle differences (shortestAngleDiff), not an absolute band; keep the pass-over pitch-through result (≤ ~0.5°/frame realised) and all three nadir modes. Add a regression test that drives a target roll through ±180° with gimbal lag and asserts no long-way rotation / per-frame jump. Also fix the module header comment (lines ~20-23) so it states the real rule.`,
  },
  {
    key: 'r2-perception',
    files: `scene3d/film/scene/world_query.js, scene3d/film/scene/sensors.js, scene3d/film/index.js (createWorldQuery wiring only), scene3d/film/runtime/take_player.js (restoreStatic only), tests/film_perception.test.mjs, tests/film_runtime_capture.test.mjs, tests/film_api.test.mjs`,
    brief: `Round-1 check "check:perception" (read it in ${ROUND1}): (1) REGRESSION: world_query.describeHit picks the static whose capsule SURFACE is nearest the hit; with default radii every containing capsule ties at 0 and the lower row index wins, so the fade key can name a neighbouring placement. Choose by distance from the hit to each candidate's AXIS (or centre) normalised by its radius, closest wins; test two overlapping trees where the ray hits the second. (2) WIRING GAP: scene3d/film/index.js createWorldQuery passes no catalogs, so archetypeOf() is null and EVERY scenery placement classifies as 'rock' — trees are never faded in production. Wire the real archetype source: scene3d/vfx_catalog.js (no imports, not on the forbidden list; a dynamic import inside installFilmMode returns the same instance the client uses) — e.g. vfxArchetypeOf(did) = vfxDescriptorFor(did)?.archetype — read vfx_catalog.js for the real API and how the client initialises it; also staticDimsOf if a real dims source exists (sessionHandle/objectPartDims or the catalog) — else keep defaults and say so. Test with a fake catalog that a scenery oak hit is kind 'tree' with a fadeKey. (3) LOW: take_player.restoreStatic for BatchedMesh re-shows any instance that is hidden at restore time even if something else (pool park/static_atlas hide) hid it after us; record our own hide and only restore when the instance is still in the state we left it AND no other owner changed it in between (best effort; document the residual).`,
  },
  {
    key: 'r2-subject',
    files: `scene3d/film/runtime/take_player.js, scene3d/film/index.js, scene3d/film/shots/drone.js (flythrough meta only), tests/film_runtime_capture.test.mjs, tests/film_api.test.mjs, tests/film_shots_drone.test.mjs`,
    brief: `Round-1 check "check:subject" (read it in ${ROUND1}): (1) math-0/contracts-0 partly fixed: a FLOWN carry rig surges at the start of the take when the subject is already walking at prepare (velocity ≥ 0.3 m/s, referenceTrack extrapolates it) and keeps walking through the pre-roll — during pre-roll the reference is held at p=0 so liveUpdate(settle) learns a growing offset that is released as a jump when p starts. Make the pre-roll advance the reference consistently with the live subject (or re-base the reference at the first recorded frame) so there is no surge; test with a fake subject walking through pre-roll + take: no per-frame camera speed spike above k× the steady speed, distance within ±15%. (2) math-2 incomplete: drone.flythrough's meta has no peakSpeed (shots/drone.js ~890) — add it (and audit every drone/fpv technique that uses speedLimitedProfile/fitProfile so meta.peakSpeed and meta.overspeed are always present); the take REPORT (shoot) and the rehearse result must carry the prepare-time flight check / validation issues (overspeed with the minimum feasible duration) so the CLI can surface them. (3) Defence in depth for review tooling-2: in scene3d/film/index.js make world.teleport and world.command refuse with {ok:false, error:{code:'FILM_BUSY'}} while a take/shoot/rehearse/scout is running (same guard pose/release use); test it.`,
  },
]

const NODE = [
  {
    key: 'r2-plan',
    files: `tools/film/plan/compile.mjs, tests/film_plan_compile.test.mjs`,
    brief: `Round-1 check "check:plan" (read it in ${ROUND1}): tooling-3 REGRESSION in compile.mjs resolveEnd {bars} branch — the edit-0 rule \`pickup = bp < -1e-6 || inT <= 1e-9; base = pickup ? Math.ceil(bp - 1e-6) : bp\` jumps to the NEXT bar when song.offsetSec lands slightly AFTER a downbeat, making the first {bars:n} shot ≈ n+1 bars and every following cut a bar late. Correct rule: a pickup exists only when the shot starts strictly BEFORE the first bar line by more than a small tolerance (bp < -tol); when the start is within tolerance of a bar line (|bp - round(bp)| < tol, tol ≈ a few ms in bars) treat it as ON that bar (base = round(bp)); otherwise keep the mid-bar rule. Tests: offsetSec exactly on, 2 ms after, 2 ms before a downbeat, and a real pickup (first downbeat at 0.51 s, offset 0) — cuts land on downbeats in all four.`,
  },
  {
    key: 'r2-cli',
    files: `tools/film/film.mjs, tools/film/lib/{shoot,session}.mjs, tests/film_cli.test.mjs, tests/film_cli_session.test.mjs`,
    brief: `(1) Surface the page's prepare/rehearse/shoot validation and flight-check issues (overspeed with minimum feasible duration, etc. — read scene3d/film/runtime/take_player.js and scene3d/film/index.js for the exact field names the page now returns; the page side is being extended in parallel by the r2-subject cluster to put them on the rehearse result and the take report — code defensively for both presence and absence) in the CLI: print a warning line per issue, include them in reports/<shot>.json and shoot-log.jsonl, and let keepOrRetake/judgeInput see them; never throw on them. (2) Round-1 check "check:cli-shoot" (read it in ${ROUND1}): settlePage calls __film.abort() only once — an abort landing in the window where the page has busy='shoot' but take_player has not yet started is lost; re-issue abort on every poll while status().active is true (bounded), and test it with a fake page that ignores the first abort.`,
  },
]

async function runLane(lane) {
  const out = []
  for (const c of lane) {
    const r = await agent(`${CONTEXT}\n\n${RULES}\n\nYou are the fix agent for cluster "${c.key}". Files you may edit (relative to ${HB}): ${c.files}. Another lane edits other files concurrently — stay inside your list; describe any needed out-of-list change under skipped.\nBRIEF:\n${c.brief}\n\nAdd a regression check that EXECUTES each fixed path. Run your cluster's suites and every suite importing a module you changed (rg), one at a time; all must pass. List doc passages that now disagree with the code under docsToUpdate (a docs agent applies them next).`, { label: `fix:${c.key}`, phase: 'Fix', schema: FIXREPORT })
    out.push({ cluster: c.key, brief: c.brief, result: r })
  }
  return out
}

phase('Fix')
const [pageRes, nodeRes] = await parallel([() => runLane(PAGE), () => runLane(NODE)])
const fixes = [...(pageRes || []), ...(nodeRes || [])]

phase('Docs')
const newDocs = fixes.flatMap(f => (f.result && f.result.docsToUpdate) || []).map(d => '- ' + d).join('\n')
const docs = await agent(`${CONTEXT}\n\n${RULES}\n\nYou are the docs-sync agent. ALL code is now final for this round. Bring every film doc in line with the CURRENT code — read the code, never trust old docs. Inputs: (a) every "docsToUpdate" entry in ${ROUND1}; (b) these new ones from round 2:\n${newDocs || '- (none)'}\n(c) the doc-related problems in ${ROUND1} "checks".\nFiles you may edit: ${HB}/scene3d/film/SPEC.md (it is the frozen contract: update it to describe what the code now does — §1.1 layout, §2.x signatures/state fields such as limits.can_drift_left/right, §3 runtime bullets incl. film_clock, take_player, recorder, camera_owner.parkCell, world.teleport busy guard, installFilmMode deps incl. particleCull, §3.4 readiness, §4 seams incl. the particle_manager pass-through, §5.2 take/subject semantics and the CLI walk), ${HB}/scene3d/film/runtime/SEAMS.md, ${HB}/scene3d/film/README.md, ${REPO}/.claude/skills/film-mode/SKILL.md, ${REPO}/.claude/skills/film-mode/reference/*.md, ${REPO}/.claude/agents/film-director.md. For reference/techniques.md: re-render its generated catalog section from \`node ${HB}/tools/film/film.mjs techniques --json\` (write the generator as a throwaway script under /tmp/claude-1000/, not in the repo) and fix the hand-written notes that mention changed behaviour (hyperlapse-orbit timeRate default/unit, bounds override, capture hint, fade/reroute). Verify every CLI command/flag the skill docs mention exists (\`film.mjs <cmd> --help\`), and that the plan-format example still validates (\`film.mjs plan validate <tmpfile>\` exits 0). Do not edit code. Report under fixed[] one entry per doc file with what changed; under skipped anything you could not reconcile (with the code location).`, { label: 'docs:sync', phase: 'Docs', schema: FIXREPORT })

phase('Check')
const items = [...fixes.filter(f => f.result).map(f => ({ key: f.cluster, what: `fix cluster "${f.cluster}". Brief:\n${f.brief}\nFix report:\n${JSON.stringify(f.result, null, 2)}` })), ...(docs ? [{ key: 'docs', what: `docs-sync. Report:\n${JSON.stringify(docs, null, 2)}\nCheck that SPEC.md, SEAMS.md, README.md and the skill docs describe the CURRENT code (spot-check at least 15 concrete claims against the code: names, signatures, defaults, behaviours, CLI flags), that no doc mentions something that does not exist, and that the plan-format example validates.` }] : [])]
const checks = await parallel(items.map(it => () => agent(`${CONTEXT}\n\n${RULES}\n\nIndependently check ${it.what}\n\nRead the current code and docs (git -C ${HB} diff HEAD for touched files), confirm each item is actually done, probe with throwaway scripts under /tmp/claude-1000/ where useful, re-run the relevant suites one at a time, and confirm no regression (zero-cost-when-off for existing scene3d files; SPEC/owner decisions). ok=false only for a real defect or regression (list non-blocking notes in problems too, prefixed NON-BLOCKING).`, { label: `check:${it.key}`, phase: 'Check', schema: CHECK }).then(c => ({ key: it.key, check: c }))))

return { fixes: fixes.map(f => ({ cluster: f.cluster, result: f.result })), docs, checks }

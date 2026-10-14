export const meta = {
  name: 'film-fix-review',
  description: 'Finish the film review: verify the 8 pending tooling findings, fix every confirmed issue in two file-disjoint sequential lanes (page runtime / Node tooling), then check each cluster',
  phases: [
    { title: 'Verify', detail: '2 refuters per pending tooling finding' },
    { title: 'Fix', detail: 'two parallel lanes, each sequential over file-disjoint clusters' },
    { title: 'Check', detail: 'independent check per cluster' },
  ],
}

const HB = '/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web'
const REPO = '/home/wbterminal/WorldBuilder-ACME-Edition'
const REVIEW = HB + '/docs/film-mode-2026-10-13/review/review-2026-10-14.json'

const RULES = `HARD RULES (verbatim from ~/CLAUDE.md): Parallel agents may read, edit and run TARGETED single tests only (\`node test_x.mjs\`). They must NOT run the full JS gate, cargo, wasm-pack or browsers. The orchestrator runs the full gate and builds ONCE, after merging, one at a time.
Also: no git commands that change state (read-only git diff/log/show is fine); never arm background automation; no Anthropic API/SDK/keys; never start browsers, servers, ACE, dotnet, cargo or wasm-pack; no real network calls (OpenRouter included); never touch ~/ace-server; never write any account password anywhere. Throwaway probes only under /tmp/claude-1000/ (never in the repo). Tests: node:assert/strict, local check(), final "<suite>: N passed, M failed", must EXECUTE code, no SKIP banners; run only targeted suites, one at a time, from ${HB}.`

const CONTEXT = `PROJECT: "AC Film Mode" for holtburger-web (Asheron's Call web client, JS/three.js r184 + Rust/wasm) — optional default-OFF (?filmMode=on) agentic cinematography: a Claude Code director (no Anthropic API in code), JEV (OpenRouter System-One model, key only in Node) as the camera's reflexes with a code safety clamp that always wins, stepped capture on a film clock with WebCodecs, HUD-free, shoot by location (teleports ≈10 s). Owner decisions: film account phase4demo (password run-time only), depth of field in v1, scenery bake = whatever the client loaded.
Contracts: ${HB}/scene3d/film/SPEC.md (§5.2 Plan/Timeline/Take). Seam behaviour: ${HB}/scene3d/film/runtime/SEAMS.md. Developer README: ${HB}/scene3d/film/README.md. Director docs: ${REPO}/.claude/skills/film-mode/ (SKILL.md + reference/*.md).
The adversarial review record (all findings, with description, failureScenario, evidence, suggestedFix and the verifiers' correctedFix notes) is ${REVIEW} — READ the entries for your ids there before changing anything. Several ids describe the SAME defect from different angles; fix the defect once, completely. Read the CURRENT code first: an earlier cluster may already have changed it.`

const VERDICT = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'refuted'] },
    reasoning: { type: 'string' },
    reproduced: { type: 'boolean' },
    correctedFix: { type: 'string' },
  },
  required: ['verdict', 'reasoning', 'reproduced'],
}
const FIXREPORT = {
  type: 'object',
  properties: {
    fixed: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, what: { type: 'string' } }, required: ['id', 'what'] } },
    skipped: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, why: { type: 'string' } }, required: ['id', 'why'] } },
    filesTouched: { type: 'array', items: { type: 'string' } },
    tests: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, passed: { type: 'integer' }, failed: { type: 'integer' } }, required: ['file', 'passed', 'failed'] } },
    docsToUpdate: { type: 'array', items: { type: 'string' }, description: 'doc passages (SPEC/SEAMS/README/skill) that now disagree with the code and that you could not update because they are outside your files' },
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

const PENDING = ['tooling-2', 'tooling-3', 'tooling-4', 'tooling-5', 'tooling-6', 'tooling-7', 'tooling-8', 'tooling-9']

// ── page-runtime lane (sequential; files disjoint from the Node lane) ──
const PAGE = [
  {
    key: 'clock',
    ids: ['seams-0', 'seams-1', 'seams-6'],
    files: `scene3d/film/runtime/film_clock.js, tests/film_runtime_camera.test.mjs (and a new tests/film_runtime_clock.test.mjs if cleaner — then name it in your report so the orchestrator registers it)`,
    brief: `Stepped-clock correctness: (seams-0) step() must yield one animation frame per film frame so rAF-driven subsystems (animated_scenery wind, the RP3 sky group, environ ticks …) advance between film frames — follow the suggested order (stamp clockMs, await rAF with a ~50 ms setTimeout fallback for throttled pages, re-base ts, render) and keep ts strictly increasing; (seams-1) under ?particleClock=sim the particle clock must continue from liveScene3d._particleSimNowS, not jump to wall time, and end() must leave the sim clock ≥ where the take left it; (seams-6) end() must never leave two rAF chains (re-arm only when the realtime chain is dead). Read ${HB}/scene3d/index.js tick/scheduleNext/__renderOnce and loop.js to get the real semantics. Tests with fake rAF/setTimeout/__renderOnce: rAF yields once per step, no jump with simMode and _particleSimNowS ≠ frameTime.tsMs/1000, begin→end without a step leaves exactly one chain.`,
  },
  {
    key: 'drone',
    ids: ['math-1', 'contracts-8', 'contracts-2'],
    files: `scene3d/film/drone/flight_model.js, scene3d/film/shots/drone.js, tests/film_flight_model.test.mjs, tests/film_shots_drone.test.mjs`,
    brief: `(math-1/contracts-8) a FLOWN drone.pass-over in nadirMode 'pitch-through' must not snap: limit gimbal roll relative to the nominal's intended roll (or derive heading/roll from q with the previous heading as hint) so the realised per-frame rotation stays within k× the nominal's; add a flown-continuity test for all three nadir modes with the cinema preset. (contracts-2) drone.hyperlapse-orbit's meta.timeLapse.rate must be in the same unit film_clock reads (game-days per film second, as classic.time-lapse uses) — convert from the param with the client's real day length (find it: rg for the sky day length / game day seconds in scene3d), re-default the param to a sane value, and add {unit:'game-days/s'}; test that per-frame sky advance is small and monotone.`,
  },
  {
    key: 'subject',
    ids: ['math-0', 'contracts-0', 'contracts-7', 'math-3', 'contracts-9', 'math-2'],
    files: `scene3d/film/index.js, scene3d/film/runtime/take_player.js, scene3d/film/shots/classic.js (only if needed), tests/film_api.test.mjs, tests/film_runtime_capture.test.mjs, tests/film_shots_classic.test.mjs`,
    brief: `(math-0/contracts-0, high) tracking/chase rigs must follow a LIVE moving subject during the take: implement the run-time re-anchoring design from the suggested fixes (build against a predicted/reference subject track at prepare, then per frame translate the sampled nominal by liveSubject.pos − refSubject(p).pos and re-aim; for travel-heading rigs also rotate about the subject by the live heading delta from a short position history). Keep stepped (static subject) takes byte-identical. Test with a fake entity that moves during the take: camera–subject distance stays within ±15% and the subject stays in frame. (contracts-7) a player subject becomes live when the take has an actor that moves (actor.moveTo / actor.moves) or capture.mode is realtime. (math-3/contracts-9) provide ShotContext.sun outdoors from the live sky/sun (verify the real convention: sessionHandle.getSkyState() dirHeading/dirPitch, or the scene's sun DirectionalLight direction converted with threeToAcPos — pick the one you can verify from code, free() wasm boxes), null indoors; scout with intent.light must either use it or report that light was ignored. (math-2) prepare() must report an 'overspeed' issue (with the minimum feasible duration) when a drone/fpv trajectory's meta.overspeed or peakSpeed exceeds the chosen preset's vmax.`,
  },
  {
    key: 'perception',
    ids: ['contracts-1', 'contracts-3', 'seams-2', 'gate-2', 'seams-7'],
    files: `scene3d/film/scene/sensors.js, scene3d/film/scene/world_query.js, scene3d/film/pilot/mapper.js, scene3d/film/runtime/take_player.js, scene3d/film/index.js (measureCandidate only), scene3d/film/runtime/safety.js (only for a shared renderSetCells helper), tests/film_perception.test.mjs, tests/film_pilot_loop.test.mjs, tests/film_runtime_capture.test.mjs, tests/film_api.test.mjs`,
    brief: `(contracts-1, high) indoors, perception and scouting must sweep EnvCell walls: put cellIds (the render set, same helper as safety.renderSetCells — share it) into the sensor ctx in take_player.senseFrame/preRollStep and index.js measureCandidate, or let sensors fall back to sh.getRenderSet(1) when ctx.indoor; test that a wall in a cell blocks the centre sector indoors. (contracts-3/seams-2/gate-2) pilot 'fade' must do something for static occluders: give static/scenery hits a fadeable key from world_query.describeHit (node + instance), push it into subject.occluderIds, and in take_player.fade set node.userData.__filmHidden = true + visible=false (Mesh/InstancedMesh/LOD) or setVisibleAt(i,false) (BatchedMesh), restoring exactly in restoreFades; AND as a safety net in mapper.apply fall back to reroute=true when the choice is 'fade' but no ids exist. (seams-7) restore in reverse order of application (safety.release before restoreFades) or a single owner per emitter so a faded smoke cloud is never left hidden.`,
  },
  {
    key: 'capture',
    ids: ['gate-0', 'seams-4', 'contracts-4', 'tooling-1', 'seams-9', 'seams-11'],
    files: `scene3d/film/runtime/take_player.js, scene3d/film/runtime/recorder.js, scene3d/film/runtime/camera_owner.js, scene3d/film/runtime/world.js, scene3d/film/index.js, scene3d/index.js (ONLY the film install block: pass the particle cull seam), scene3d/film/scene/particles_query.js, tests/film_runtime_capture.test.mjs, tests/film_runtime_camera.test.mjs, tests/film_runtime_world.test.mjs, tests/film_api.test.mjs, tests/film_hooks.test.mjs`,
    brief: `(gate-0/seams-4/contracts-4/tooling-1) realtime takes must produce a CONSTANT-RATE stream at the take fps: in runRealtime sample onto the film grid (grab when wall t ≥ n/fps, stamp n/fps, re-grab the same canvas for skipped grid points, skip display frames between grid points), so the CLI's constant-fps mux stays correct; report realised duration from the grid; test with a fake rAF at 22, 30 and 60 Hz → frames = round(duration·fps) with timestamps n/fps. (seams-9) at the scene3d/index.js film install site, inside the filmMode branch, dynamic-import the already-resident ./particles/particle_manager.js and pass {particleCull:{setParticleCullConfig, allParticleManagers}} in the installFilmMode deps (zero cost when off — keep the reader exact and unchanged); take_player sets recheckInterval 1 for the take and restores the previous config; particles_query uses allParticleManagers when given; update tests/film_hooks.test.mjs's index.js install-block check. (seams-11) world.teleport must park the film viewer cell (delete filmViewer / reseed on next write) so the player-head walk drives the viewer cell while the next site loads.`,
  },
  {
    key: 'look',
    ids: ['contracts-5', 'seams-3', 'gate-1'],
    files: `scene3d/film/runtime/look.js, scene3d/film/runtime/take_player.js (pre-roll wait only), scene3d/film/index.js (only if the wait lives there), tests/film_runtime_world.test.mjs, tests/film_runtime_capture.test.mjs`,
    brief: `Fog looks: look.fog.set must keep the existing __environFogOverride object when the fog option is unchanged (re-applying a look is a no-op), and before recording (rehearse and shoot, both modes) the take must wait — bounded, e.g. ≤ 30 s, reported in the take report — until the environ override transition has settled (read ${HB}/scene3d/environ_override.js and how loop.js/index.js expose its state; add nothing to existing files unless strictly necessary — if a read-only accessor is missing, report it under docsToUpdate rather than editing environ_override.js). Do NOT add environRetail=off (it changes the retail fog behaviour). Tests: same fog twice → same object identity; a changed fog → the take waits for a fake transition to reach 1.`,
  },
]

// ── Node-tooling lane (sequential; files disjoint from the page lane) ──
const NODE = [
  {
    key: 'cli-shoot',
    ids: ['contracts-6', 'tooling-0', 'jev-3', 'jev-4', 'tooling-5', 'tooling-2', 'tooling-4', 'tooling-6', 'tooling-7', 'tooling-8', 'tooling-9'],
    files: `tools/film/film.mjs, tools/film/lib/{shoot,session,ffmpeg,drain,args}.mjs, tools/film/lib/jev_broker.mjs, tests/film_cli.test.mjs, tests/film_cli_session.test.mjs, tests/film_jev_broker.test.mjs, ${REPO}/.claude/skills/film-mode/reference/{workflow,1070}.md (only passages about these behaviours)`,
    brief: `(contracts-6/tooling-0) world.prewarm is best-effort: soft call, warn + log missing landblocks, continue; one site's setup error becomes a failures entry, not an abort. (jev-3) per-shot JEV telemetry files contain only that shot's entries (mark/telemetrySince or clear at shot/rehearsal start). (jev-4/tooling-5) set the broker's stepped decide options before every rehearsal. Pending-verification items (fix ONLY those the Verify phase confirmed — listed below as CONFIRMED_TOOLING): tooling-2 abort the page take and wait for idle after any failed attempt, refuse to teleport while a take runs; tooling-4 the password must never reach /tmp/hb-heavy.lock/owner.json (scrub process.argv before acquiring, or pass an explicit scrubbed cmd); tooling-6 a failing retake keeps the earlier recorded attempt; tooling-7 even dimensions for frames/VP9 re-encode (scale/pad); tooling-8 go derives interiorLb from the actual destination cell; tooling-9 boot verifies its window is off-screen (move it off-screen via Browser.setWindowBounds or refuse with exit 2 and close only its own tab).`,
  },
  {
    key: 'pilot-words',
    ids: ['jev-0', 'jev-2'],
    files: `scene3d/film/pilot/{scene_state,questions,policy_code,sense_words}.js, scene3d/film/scene/solver.js (describeCandidate only), tools/film/lib/jev_tasks.mjs, tests/film_pilot_words.test.mjs, tests/film_pilot_policy.test.mjs, tests/film_pilot_loop.test.mjs, tests/film_scene_solver.test.mjs, tests/film_jev_broker.test.mjs, ${REPO}/.claude/skills/film-mode/reference/pilot.md (only the state/criteria description)`,
    brief: `(jev-0) lateral bound exhaustion must be expressed like the vertical one (limits.can_drift_left/right yes/no from the remaining bound), not by capping room_left/right — so drifts are possible for techniques with maxLateral < 2 m; update the criteria text, the code policy and the tests together so they keep sharing WORD_BOUNDS/PILOT_RULES (the ≥25-frame agreement table must still pass and gain cases for small maxLateral). (jev-2) describeCandidate must state clearance with the WORD_BOUNDS distance word (optionally with the metre range) so pickCandidate's criteria words appear in the option texts; add a test that every word the instructions quote can appear in describeCandidate output.`,
  },
  {
    key: 'plan',
    ids: ['tooling-3', 'contracts-7'],
    files: `tools/film/plan/{schema,compile}.mjs, tests/film_plan_schema.test.mjs, tests/film_plan_compile.test.mjs, ${REPO}/.claude/skills/film-mode/reference/plan-format.md (only these behaviours), ${HB}/scene3d/film/SPEC.md (§5.2 only)`,
    brief: `(tooling-3, only if CONFIRMED_TOOLING lists it) {bars:n} shots that start before the first downbeat (e.g. the first shot at edit 0 when bars[0] is at 0.51 s) must count bars from the next downbeat so cuts land on bar lines; test with an analysed-song fixture whose first downbeat is > 0. (contracts-7, plan side) a {kind:'player'} subject whose shot has an actor that moves (actor.moveTo or actor.moves) is normalised with moving:true so the page treats it as live (the page side is handled by another cluster — keep the field name 'moving').`,
  },
]

phase('Verify')
const verdicts = await parallel(PENDING.flatMap(id => [0, 1].map(k => () =>
  agent(`${CONTEXT}\n\n${RULES}\n\nYou are independent skeptic #${k + 1} verifying ONE claimed defect, id "${id}", from the film-mode review. Read its full entry in ${REVIEW}. Try hard to REFUTE it: read the actual code at and around the cited lines, check callers/callees, and where possible EXECUTE a small probe (throwaway scripts only under /tmp/claude-1000/). Refute if the code does not do what is claimed, the scenario cannot happen, it is intended per SPEC/owner decisions, or it is a style nit. Confirm only if convinced. If uncertain, refute.`, { label: `verify:${id}.${k}`, phase: 'Verify', schema: VERDICT })
    .then(v => ({ id, v })))))
const byId = {}
for (const r of verdicts.filter(Boolean)) (byId[r.id] = byId[r.id] || []).push(r.v)
const CONFIRMED_TOOLING = PENDING.filter(id => { const vs = (byId[id] || []).filter(Boolean); const yes = vs.filter(v => v.verdict === 'confirmed').length; return yes > vs.length - yes })
const REFUTED_TOOLING = PENDING.filter(id => !CONFIRMED_TOOLING.includes(id))
log(`tooling verify: confirmed ${CONFIRMED_TOOLING.join(', ') || 'none'}; refuted ${REFUTED_TOOLING.join(', ') || 'none'}`)

const notes = id => (byId[id] || []).filter(v => v && v.verdict === 'confirmed' && v.correctedFix).map(v => `  ${id} verifier fix note: ${v.correctedFix}`).join('\n')
const clusterIds = c => c.ids.filter(id => !PENDING.includes(id) || CONFIRMED_TOOLING.includes(id))

async function runLane(lane, label) {
  const out = []
  for (const c of lane) {
    const ids = clusterIds(c)
    if (!ids.length) { out.push({ cluster: c.key, ids, result: null, skipped: 'no confirmed ids' }); continue }
    const r = await agent(`${CONTEXT}\n\n${RULES}\n\nYou are the fix agent for cluster "${c.key}" (${label} lane). Fix these review ids: ${ids.join(', ')}.\nCONFIRMED_TOOLING (pending items the Verify phase confirmed): ${CONFIRMED_TOOLING.join(', ') || 'none'}. REFUTED (do NOT fix): ${REFUTED_TOOLING.join(', ') || 'none'}.\nFiles you may edit (paths relative to ${HB} unless absolute): ${c.files}. Another lane is editing other files at the same time — do not touch files outside your list; if a correct fix needs another file, describe it under skipped with the exact change.\nBRIEF:\n${c.brief}\n${ids.map(notes).filter(Boolean).join('\n')}\n\nAdd a regression check that EXECUTES the fixed path for every fix, in the named suites. If you add a new suite, name it in filesTouched (the orchestrator registers it). Update SEAMS.md/README.md/SPEC.md/skill passages only if they are in your file list; otherwise list them under docsToUpdate. Run ONLY your cluster's suites (and any suite that imports a module you changed — rg for it), one at a time; all must pass.`, { label: `fix:${c.key}`, phase: 'Fix', schema: FIXREPORT })
    out.push({ cluster: c.key, ids, result: r })
  }
  return out
}

phase('Fix')
const [pageRes, nodeRes] = await parallel([() => runLane(PAGE, 'page-runtime'), () => runLane(NODE, 'node-tooling')])
const all = [...(pageRes || []), ...(nodeRes || [])]

phase('Check')
const checks = await parallel(all.filter(x => x.result).map(x => () => agent(`${CONTEXT}\n\n${RULES}\n\nIndependently check fix cluster "${x.cluster}" (ids ${x.ids.join(', ')} — read each entry in ${REVIEW}). Fix agent report:\n${JSON.stringify(x.result, null, 2)}\n\nRead the current code (git -C ${HB} diff HEAD for the touched files; new files in full), confirm each defect is actually fixed (probe with throwaway scripts under /tmp/claude-1000/ where useful), confirm nothing else broke (re-run the cluster's suites and every suite that imports a touched module, one at a time), confirm zero-cost-when-off for any change to an existing scene3d file, and confirm no SPEC/owner-decision regression. ok=false if any defect is not fixed or anything regressed.`, { label: `check:${x.cluster}`, phase: 'Check', schema: CHECK }).then(c => ({ cluster: x.cluster, check: c }))))

return {
  tooling: { confirmed: CONFIRMED_TOOLING, refuted: REFUTED_TOOLING, votes: byId },
  fixes: all.map(x => ({ cluster: x.cluster, ids: x.ids, fixed: x.result ? x.result.fixed : [], skipped: x.result ? x.result.skipped : x.skipped, files: x.result ? x.result.filesTouched : [], tests: x.result ? x.result.tests : [], docsToUpdate: x.result ? x.result.docsToUpdate : [] })),
  checks: checks.filter(Boolean),
}

export const meta = {
  name: 'film-fix-round3',
  description: 'Round 3: close the last blocking items from the round-2 checks (static hit attribution, live-subject swing feed-forward, acceleration-aware flight check) plus small leftovers, sync docs, check',
  phases: [
    { title: 'Fix', detail: 'page lane (perception → subject) ∥ node/docs lane (small leftovers)' },
    { title: 'Docs', detail: 'apply remaining doc deltas' },
    { title: 'Check', detail: 'independent check per cluster' },
  ],
}

const HB = '/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web'
const REPO = '/home/wbterminal/WorldBuilder-ACME-Edition'
const R2 = HB + '/docs/film-mode-2026-10-13/review/round2-fix-results-2026-10-14.json'

const RULES = `HARD RULES (verbatim from ~/CLAUDE.md): Parallel agents may read, edit and run TARGETED single tests only (\`node test_x.mjs\`). They must NOT run the full JS gate, cargo, wasm-pack or browsers. The orchestrator runs the full gate and builds ONCE, after merging, one at a time.
Also: no git commands that change state; never arm background automation; no Anthropic API/SDK/keys; never start browsers, servers, ACE, dotnet, cargo or wasm-pack; no real network calls; never touch ~/ace-server; never write any account password anywhere. Throwaway probes only under /tmp/claude-1000/ (never in the repo). Tests: node:assert/strict, local check(), final "<suite>: N passed, M failed", must EXECUTE code, no SKIP banners; run only targeted suites, one at a time, from ${HB}.`

const CONTEXT = `PROJECT: "AC Film Mode" for holtburger-web — optional default-OFF (?filmMode=on) agentic cinematography. Contracts: ${HB}/scene3d/film/SPEC.md; seams: ${HB}/scene3d/film/runtime/SEAMS.md; README: ${HB}/scene3d/film/README.md; director docs: ${REPO}/.claude/skills/film-mode/. Round-2 results (fix reports + the round-2 checkers' full problem texts, which quote probe paths under /tmp/claude-1000/ you can re-run): ${R2} — key "checks". Read the CURRENT code first.`

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
    key: 'r3-perception',
    files: `scene3d/film/scene/world_query.js, tests/film_perception.test.mjs`,
    brief: `Round-2 check "check:r2-perception" (read every problem text in ${R2}) found a DEFECT: describeHit normalises the hit's axis distance by the catalog radius, but for trunk-and-canopy trees that radius is the canopy footprint (median ~5 m, p90 ~13 m) while los.js scenery hits land on the PHYSICS colliders (trunk cylinders/boulder spheres), so a hit on a thin tree's trunk can be attributed to a big neighbouring tree. Use the absolute nearest axis (distance from the hit point to each candidate placement's vertical axis segment), gated by a plausible collider radius (trunk/boulder scale — derive from the catalog when it carries one, else a conservative default), and keep the ambiguity rule (no fade key when the two best candidates are near-tied). Re-run the checker's probes (p1_real_catalog.mjs etc., paths in the problem text) and turn their failing configurations into tests (thin tree next to big canopy tree; equal-size clump; rock vs tree). Also: staticsNear awaits prefetchStaticDims (≤ 3 s) per landblock and a DID whose sphere fetch hangs makes every later landblock wait again — remember timed-out DIDs and skip them (bounded total wait per query); test with a never-resolving fake fetch.`,
  },
  {
    key: 'r3-subject',
    files: `scene3d/film/runtime/take_player.js, scene3d/film/index.js, tests/film_runtime_capture.test.mjs, tests/film_api.test.mjs`,
    brief: `Round-2 check "check:r2-subject" (read both BLOCKING texts in ${R2}): (1) flown carry rigs still surge at take start when the subject walks during pre-roll in a direction other than the extrapolated reference heading (θ ≠ 0): liveDerivs (~take_player.js:1484) returns R_θ(vNom) + S.v but omits the swing-rate term θ̇ × R'_θ(nom − ref) (and any re-anchor rate terms), so the drone's velocity/acceleration feed-forward is wrong while the rig swings. Derive the feed-forward from the full time derivative of the re-anchored pose (or finite-difference the re-anchored nominal over one film frame) so it is exact; the checker's probes (/tmp/claude-1000/r2-subject-chk/probe_live.mjs, turnEast cases) must show distance ratio within ±15% and no per-frame speed spike for chase/lead/side-track/tracking-follow at 24/30/60 fps, including a subject that turns. (2) flightCheckOf/verifyMinDuration verify speed only, so minDurationVerified:true is false for ACCELERATION-limited moves (cinema vmax 12, amax 4). Verify by actually flying the nominal through the real flight model (flyTrajectory or the same createDrone stepping at a low fps such as 10) and measuring the tracking gap; search the minimum duration with that fly-verification (bounded iterations) and report minDurationVerified only when the flown gap stays under a stated threshold; keep prepare fast (budget the check, report 'unverified' rather than block when the budget runs out). Use the checker's sweep_flight.mjs cases as tests. (3) cameraBusy() must also cover an in-flight async prepare (busy === 'prepare') so world.teleport/world.command refuse during prepare.`,
  },
]

const NODE = [
  {
    key: 'r3-small',
    files: `tools/film/lib/shoot.mjs, tests/film_cli_session.test.mjs, scene3d/film/pilot/questions.js, tests/film_pilot_words.test.mjs, tests/film_pilot_policy.test.mjs, scene3d/index.js (ONE comment only, lines ~2422-2428 — no code change), ${REPO}/.claude/skills/film-mode/reference/{1070,techniques,music-video,plan-format}.md, ${HB}/scene3d/film/README.md, ${HB}/scene3d/film/runtime/SEAMS.md, ${HB}/scene3d/film/SPEC.md (§1.1 degrade example only)`,
    brief: `Small leftovers from the round-2 checks (texts in ${R2}): (a) shoot.mjs: keep the page's durationHelps on the overspeed issue (ISSUE_FIELDS) and print 'a longer duration will not help' when false; surface the realised flight tracking gap (page.flight.tracking maxGapM/endGapM) in the rehearsal and shot warnings when it exceeds a stated threshold (it is the safety net for acceleration-limited moves); test both. (b) scene3d/film/pilot/questions.js ~283: the soft-occluder criterion says the runtime 'can fade them out' — make it precise (the runtime fades trees and small props of known size and particle smoke; big or unknown statics are rerouted around), keeping WORD_BOUNDS/PILOT_RULES-driven text and the criteria/code agreement tests green. (c) scene3d/index.js ~2426 scheduleNext COMMENT: say the film clock re-arms only a dead chain (film_clock.js end()). Comment only — zero behaviour change. (d) docs nits: 1070.md ~140 says the eye-test plan validates with one expected warning — it now gives 0 warnings (verify with \`node tools/film/film.mjs plan validate\` on the extracted example); techniques.md fpv.fpv-flip director note: the crisp-flip duration rule applies to axis 'roll' only (a pitch flip cannot loop past the +30° gimbal stop on gimbal presets) and needs a shot of ≥ ≈ 9 s because flipDuration is capped at 0.8·duration (drone.js); plan-format.md flightPreset row the same; music-video.md §2 Tempo pickup wording = 'more than half a beat'; README world.ready result adds timedOut; SPEC §1.1 / SEAMS 'Static catalogs' degrade example — check entities.js for when ensureVfxCatalog actually runs and state the real condition.`,
  },
]

async function runLane(lane) {
  const out = []
  for (const c of lane) {
    const r = await agent(`${CONTEXT}\n\n${RULES}\n\nYou are the fix agent for cluster "${c.key}". Files you may edit (relative to ${HB} unless absolute): ${c.files}. Another lane edits other files concurrently — stay inside your list.\nBRIEF:\n${c.brief}\n\nAdd a regression check that EXECUTES each fixed path. Run your cluster's suites and every suite importing a module you changed (rg), one at a time; all must pass. List doc passages that now disagree with the code under docsToUpdate.`, { label: `fix:${c.key}`, phase: 'Fix', schema: FIXREPORT })
    out.push({ cluster: c.key, brief: c.brief, result: r })
  }
  return out
}

phase('Fix')
const [pageRes, nodeRes] = await parallel([() => runLane(PAGE), () => runLane(NODE)])
const fixes = [...(pageRes || []), ...(nodeRes || [])]

phase('Docs')
const deltas = fixes.flatMap(f => (f.result && f.result.docsToUpdate) || [])
const docs = deltas.length ? await agent(`${CONTEXT}\n\n${RULES}\n\nYou are the docs-sync agent; all code for this round is final. Apply these doc deltas after verifying each against the CURRENT code (never trust the text blindly):\n${deltas.map(d => '- ' + d).join('\n')}\nFiles you may edit: ${HB}/scene3d/film/SPEC.md, ${HB}/scene3d/film/runtime/SEAMS.md, ${HB}/scene3d/film/README.md, ${REPO}/.claude/skills/film-mode/SKILL.md, ${REPO}/.claude/skills/film-mode/reference/*.md, ${REPO}/.claude/agents/film-director.md. No code edits. Report fixed[] per file.`, { label: 'docs:sync3', phase: 'Docs', schema: FIXREPORT }) : null

phase('Check')
const items = [...fixes.filter(f => f.result).map(f => ({ key: f.cluster, what: `fix cluster "${f.cluster}". Brief:\n${f.brief}\nFix report:\n${JSON.stringify(f.result, null, 2)}` })), ...(docs ? [{ key: 'docs3', what: `docs-sync. Report:\n${JSON.stringify(docs, null, 2)}` }] : [])]
const checks = await parallel(items.map(it => () => agent(`${CONTEXT}\n\n${RULES}\n\nIndependently check ${it.what}\n\nRead the current code/docs, confirm each item is actually done (re-run the round-2 checkers' probes named in ${R2} where relevant, plus your own throwaway probes under /tmp/claude-1000/), re-run the relevant suites one at a time, confirm no regression (zero-cost-when-off for existing scene3d files; SPEC/owner decisions). ok=false only for a real defect or regression; prefix non-blocking notes with NON-BLOCKING.`, { label: `check:${it.key}`, phase: 'Check', schema: CHECK }).then(c => ({ key: it.key, check: c }))))

return { fixes: fixes.map(f => ({ cluster: f.cluster, result: f.result })), docs, checks }

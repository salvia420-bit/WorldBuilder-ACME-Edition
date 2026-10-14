export const meta = {
  name: 'film-review-fix',
  description: 'Adversarial review of the merged film-mode diff (6 dimensions, 2-3 refuters per finding), then file-clustered fixes and fix verification',
  phases: [
    { title: 'Review', detail: 'one finder per dimension' },
    { title: 'Verify', detail: '2-3 independent refuters per finding; strict majority survives' },
    { title: 'Fix', detail: 'findings clustered by file, fixed one cluster at a time (memory: cluster-by-file -> sequential -> parallel-verify)' },
    { title: 'Check', detail: 'independent check of every fix cluster' },
  ],
}

const HB = '/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web'
const REPO = '/home/wbterminal/WorldBuilder-ACME-Edition'
const SP = HB + '/docs/film-mode-2026-10-13/recon'
const FILES = (args && args.files) || []

const RULES = `HARD RULES (verbatim from ~/CLAUDE.md): Parallel agents may read, edit and run TARGETED single tests only (\`node test_x.mjs\`). They must NOT run the full JS gate, cargo, wasm-pack or browsers. The orchestrator runs the full gate and builds ONCE, after merging, one at a time.
Also: no git commands that change state (read-only git diff/log/show is fine); never arm background automation; no Anthropic API/SDK/keys anywhere; never start browsers, servers, ACE, dotnet, cargo or wasm-pack; never make real network calls (OpenRouter included); never touch ~/ace-server; never write any account password anywhere.`

const CONTEXT = `PROJECT: "AC Film Mode" for holtburger-web (Asheron's Call web client, JS/three.js r184 + Rust/wasm) — an optional default-OFF (?filmMode=on) agentic cinematography mode. A Claude Code session is the director (NO Anthropic API in code); JEV (TypeSafe's System-One decision model on OpenRouter, key only in Node) is the camera's real-time reflexes via bucketed-word state and bounded maneuvers; a code safety clamp always wins; stepped capture on a film clock with WebCodecs; HUD-free; shoot by location (teleports ≈10 s). Owner decisions: film account phase4demo (password run-time only), depth of field is IN v1 (?filmDof=on), scenery bake = whatever the client loaded.
Frozen contracts: ${HB}/scene3d/film/SPEC.md (READ IT FIRST). Handoff: ${HB}/docs/HANDOFF-film-mode-2026-10-13.md. JEV API truth: ${HB}/docs/film-mode-2026-10-13/research_jev.md; pilot prior art: ${SP}/pilot_design.md; recon maps (verified file:line) in ${SP}/*.md (camera/loop map: \`python3 ${SP}/fmt.py ${SP}/recon_render.json 1 all\`).
The diff under review = every new film file plus the integration seams in existing files: see \`git -C ${HB} status --short\` and \`git -C ${HB} diff HEAD\`. Changed/new files:\n${FILES.map(f => '  ' + f).join('\n')}`

const SCOPE = `OUT OF SCOPE (a docs lane is writing these concurrently — do not report or edit them): ${REPO}/.claude/skills/film-mode/**, ${REPO}/.claude/agents/film-director.md, ${HB}/tools/film/install-claude.sh, ${HB}/scene3d/film/README.md, ${HB}/docs/url-flags.md film rows, tests/film_install_claude.test.mjs. Also out of scope: anything that can only be verified on a real GPU/browser/1070 (that is the owner's eye-test batch) — but code paths that would OBVIOUSLY fail there (wrong global names, wrong call shapes) are in scope.
KNOWN GAPS the implementers reported — for each, decide whether it is a real v1 defect (then report it as a finding with a concrete fix) or acceptable (then ignore): (1) pilot 'fade' yields empty fadeIds unless perception adds subject.occluderIds/occluderId to the SensorFrame (not in SPEC §3.1) — does sensors.js provide them? does take_player apply fadeIds (setFilmHidden / userData.__filmHidden / emitter.filmHidden) and restore them? (2) pilot 'reroute' is only a flag — does take_player act on it at all? (3) setParticleCullConfig/allParticleManagers are unused because particle_manager.js is on the forbidden-import list — should scene3d/index.js pass them through installFilmMode deps (the install site already has the module) so the film camera far from the player still sees particles? (4) ShotContext.sun is never provided (solver light intents back/rim dead) — SkyState units unverified. (5) drone.pass-over in pitch-through mode: pose.h can jump by 2π between frames while q is continuous — do any consumers (take_player, camera_owner, recorder table, validateTrajectory, pilot) use h in a way that breaks? (6) fog override fades over ~20 s unless ?environRetail=off. (7) realtime takes: raw Annex-B carries no timestamps, constant-fps mux may drift. (8) prewarmed LBs outside the player ring are first LRU eviction victims (nothing pins them). (9) a VP9 'frames' fallback / canvas size mismatch path.`

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'path relative to apps/holtburger-web (or absolute for files outside it)' },
          line: { type: 'integer' },
          otherFiles: { type: 'array', items: { type: 'string' } },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          title: { type: 'string' },
          description: { type: 'string' },
          failureScenario: { type: 'string', description: 'concrete inputs/state -> wrong output/crash/regression' },
          evidence: { type: 'string', description: 'quoted code + what you ran/observed' },
          suggestedFix: { type: 'string' },
        },
        required: ['file', 'line', 'severity', 'title', 'description', 'failureScenario', 'evidence', 'suggestedFix'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'refuted'] },
    reasoning: { type: 'string' },
    reproduced: { type: 'boolean', description: 'true if you executed code that demonstrates the defect' },
    correctedFix: { type: 'string', description: 'if confirmed: the fix you would apply (may refine the suggested fix)' },
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

const DIMENSIONS = [
  { key: 'contracts', prompt: `DIMENSION: contract conformance & cross-module wiring. Check every module against SPEC.md signatures/names/shapes (exports present, argument orders, return shapes, units/frames — AC metres, compass heading CW from north, pitch [−π/2, π/2], quaternion [w,x,y,z], three mapping [x,z,−y]). Then trace the real call graph across lanes: index.js → take_player → camera_owner/clock/sensors/pilot/safety/recorder; pilot ↔ sense_words/scene_state/questions/policy_code/mapper; sensors ↔ los/world_query/particles_query/terrain_corridor; CLI ↔ plan/compile/edl/jev/broker/sites/audio; shots registry ↔ classic/drone. Find every place where a caller uses a name, argument order, field or shape that the callee does not provide (these are the classic multi-lane integration bugs: e.g. caller reads report.realisedChecksum but callee returns checksum). Execute small node snippets to confirm.` },
  { key: 'math', prompt: `DIMENSION: camera / gimbal / trajectory / flight-model / spline math. Verify numerically (write throwaway node scripts in /tmp/claude-1000/ — never in the repo): gimbal basis & quaternion conventions vs real three (\`await import("three")\` from ${HB}), continuity through pitch ±90° (pass-over, tilt to nadir, birds-eye rotation), lookRotation/look-controller rate limits, spline arc-length and fillet geometry, speed profiles (monotone, limits), critically damped springs, drone flight model limits/overshoot/bank sign, trajectory bake/replay/checksum, framing math (distanceForFraming, projectToNdc vs three), every technique's subject-in-frame / ground clearance / duration claims. Look for NaN paths (coincident points, zero durations, zero-length paths), sign errors, degree/radian mixups, frame mixups.` },
  { key: 'seams', prompt: `DIMENSION: page integration seams in existing files (scene3d/index.js, cells.js, entities.js, statics.js, particles/particle_manager.js, particles/particle_fx.js, animated_scenery.js, atmosphere_pipeline.js) and the runtime page modules that use them (scene3d/film/runtime/*, scene3d/film/index.js, scene3d/film/scene/*). Read \`git -C ${HB} diff HEAD\` for the existing files hunk by hunk with the surrounding code. Prove for each seam: (a) ZERO-COST and byte-for-byte behaviour-identical when film mode is off (no new allocation per frame, no changed default values, shader output identical at default uniforms, no new globals, no static import of film modules from index.js — the modulepreload count is pinned), (b) the variables referenced are actually in scope and refer to the right objects (liveScene3d vs scene3d vs liveScene3dRef; persp camera; entityManager; particle managers), (c) the film runtime calls the seams with the exact names they export, typeof-guarded, (d) restore paths (release/clean(false)/end()) really restore everything (wrapped functions, time sources, cull config, filmHidden flags, __dof state, holdLoop, viewer cell), (e) the stepped clock cannot deadlock the render loop (holdLoop + __renderOnce + postRender promise; what if postRender never fires — timeout?), (f) depth of field (?filmDof=on) is wired in both the legacy and split chains and camera retargeting. Page modules must not import stateful scene3d modules (SPEC §1.1 list) and must not create file-backed Workers.` },
  { key: 'jev', prompt: `DIMENSION: JEV usage. Compare tools/film/lib/jev.mjs, jev_broker.mjs, jev_tasks.mjs, scene3d/film/pilot/*.js and scene3d/film/runtime/jev_bridge_page.js against the verified contract in research_jev.md (endpoint, body keys, question shapes and limits, answer shapes incl. score probabilities keyed "0".."n-1" and arbitrary key order, error codes and retry policy, cost estimate, headers) and the prior-art design rules in pilot_design.md (words not floats, one judgment per question, conservative default first, explicit-boundary criteria quoting the exact state words, thresholded scores, consult only when needed and the scene changed, sequence-tagged answers with stale drop, commit window, code safety wins). Check: criteria text and policy_code use the SAME boundaries (WORD_BOUNDS) — find any drift; the key can never reach the page, logs, telemetry, errors or files; budget caps enforced before network; broker never throws into the page and enforces size/in-flight limits; stepped mode is deterministic; timeouts fall back to code policy; shadow mode agreement metric is computed correctly. Run the existing film_jev_* and film_pilot_* tests and write extra throwaway probes in /tmp/claude-1000/.` },
  { key: 'tooling', prompt: `DIMENSION: Node tooling. tools/film/film.mjs + lib/* (CLI flows, arg parsing, exit codes, password redaction everywhere, heavy lock, never launching a browser, boot URL exactness incl. filmDof=on, mute verification, readiness gating, shoot-by-site schedule never recording across a teleport, drain → annexb/IVF bytes, ffmpeg argv correctness for mux/assemble/contact-sheet — check filter syntax/escaping, xfade offsets, -map, audio offset), plan/{schema,compile,edl}.mjs (beat-grid snapping, schedule ordering, handles, CMX3600 timecodes), audio/* (DSP correctness: FFT, mel/chroma/MFCC, onset, tempo prior + octave handling, DP beat tracker, downbeats, SSM/novelty/clustering, role assignment; performance), sites/* (data parsing of the real sources, coordinate math map↔world↔LB, teleport command formats '@teleloc 0x… x y z qw qx qy qz' / '@tele NS EW' / '@telepoi', dedupe/merge, BM25, lexicon validity). Run their tests and probe edge cases with throwaway scripts in /tmp/claude-1000/ (fakes only, no real ffmpeg on real media is fine to SKIP).` },
  { key: 'gate', prompt: `DIMENSION: conventions & gate readiness. Check every tests/film_*.test.mjs against harness conventions (read ${HB}/harness/run-js-headless.mjs header + the coverage guard + ${HB}/harness/test_suite_hygiene.mjs: PURE-PIN ratchet = suites must execute code, no SKIP banners, final "<suite>: N passed, M failed" line, non-zero exit on failure, header comment with Run line); each suite runs standalone from apps/holtburger-web in < 30 s (run each one, one at a time, and time it); console allowlist (no console.error in normal operation; read ${HB}/harness/lib/console_allowlist.mjs); flag readers exact \`=== "on"\` on the same line as .get( (lint-url-flags / audit-flag-defaults expectations — read ${REPO}/external/holtburger/scripts/lint-url-flags.mjs and audit-flag-defaults.mjs to see what they enforce; you may RUN them, they are light); lint-event-consumers and lint-harness-params expectations; build-shell bundling (read ${REPO}/external/holtburger/scripts/build-shell.mjs: does it pick up scene3d/film/** lazily? WORKER_ENTRIES unchanged? modulepreload count unchanged — read scripts/gen-modulepreload.mjs and its --check mode; you may run \`node scripts/gen-modulepreload.mjs --check\` from apps/holtburger-web if it is light — read it first); no new npm deps; no stateful imports from scene3d/film/** (SPEC §1.1 list); Node-only modules not imported by page code; determinism (no Date.now/Math.random in pure modules). Do NOT run the full gate or test_build_shell.` },
]

const ALL = FILES.length ? `` : `(No file list was passed; derive it from git status.)`

phase('Review')
const reviewed = await pipeline(
  DIMENSIONS,
  d => agent(`${CONTEXT}\n${ALL}\n\n${RULES}\n\n${SCOPE}\n\nYou are a senior reviewer. ${d.prompt}\n\nReport ONLY real defects (correctness, contract breaks, regressions, safety/security, missing required behaviour from SPEC/owner decisions, gate blockers). No style nits. Each finding needs a concrete failure scenario and evidence (quote the code; say what you executed). Severity: high = wrong output/crash/regression/security/gate failure; medium = real but narrower; low = minor real defect.`, { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS }),
  (r, d) => parallel((r ? r.findings : []).map((f, i) => () => {
    const n = f.severity === 'high' ? 3 : 2
    return parallel(Array.from({ length: n }, (_, k) => () => agent(`${CONTEXT}\n\n${RULES}\n\n${SCOPE}\n\nYou are independent skeptic #${k + 1} verifying ONE claimed defect from the "${d.key}" review of film mode. Try hard to REFUTE it: read the actual code at and around the cited lines, check callers/callees, and where possible EXECUTE a small probe (throwaway scripts only under /tmp/claude-1000/, never in the repo; no gate/browsers/cargo). Refute if the code does not do what is claimed, the scenario cannot happen, it is intended per SPEC/owner decisions, or it is a style nit. Confirm only if you are convinced it is a real defect. If uncertain, refute.\n\nCLAIM:\n${JSON.stringify(f, null, 2)}`, { label: `verify:${d.key}#${i}.${k}`, phase: 'Verify', schema: VERDICT })))
      .then(vs => {
        const votes = vs.filter(Boolean)
        const yes = votes.filter(v => v.verdict === 'confirmed')
        const no = votes.length - yes.length
        return { ...f, dim: d.key, id: `${d.key}-${i}`, votes: `${yes.length}/${votes.length}`, confirmed: yes.length > no && yes.length >= 1, fixes: yes.map(v => v.correctedFix).filter(Boolean) }
      })
  })),
)

const all = reviewed.filter(Boolean).flat().filter(Boolean)
const confirmed = all.filter(f => f.confirmed)
log(`review: ${all.length} findings, ${confirmed.length} confirmed (${confirmed.filter(f => f.severity === 'high').length} high)`)

// Cluster confirmed findings by file (union-find over file + otherFiles) so no two fixers touch one file.
const parent = {}
const find = x => (parent[x] === undefined ? (parent[x] = x) : parent[x] === x ? x : (parent[x] = find(parent[x])))
const unite = (a, b) => { parent[find(a)] = find(b) }
for (const f of confirmed) {
  const fs = [f.file, ...(f.otherFiles || [])].filter(Boolean)
  fs.forEach(x => find(x))
  for (let i = 1; i < fs.length; i++) unite(fs[0], fs[i])
}
const clusters = {}
for (const f of confirmed) { const k = find(f.file); (clusters[k] = clusters[k] || []).push(f) }
const clusterList = Object.values(clusters).sort((a, b) => b.length - a.length)
log(`fix clusters: ${clusterList.length}`)

phase('Fix')
const fixResults = []
for (let ci = 0; ci < clusterList.length; ci++) {
  const c = clusterList[ci]
  const files = [...new Set(c.flatMap(f => [f.file, ...(f.otherFiles || [])]))]
  const r = await agent(`${CONTEXT}\n\n${RULES}\n\n${SCOPE}\n\nYou are a fix agent. Fix the following CONFIRMED defects (each was independently verified by 2–3 skeptics). Files in your cluster (you may edit these, plus the matching tests/film_*.test.mjs suites to add a regression check for each fix): ${files.join(', ')}. Do not edit other source files; if a correct fix needs another file, make the minimal change there too and list it in filesTouched. Keep SPEC contracts (if a fix requires a SPEC deviation, implement the least-invasive fix and say so). Add or update a targeted regression assertion for every fix in the relevant tests/film_*.test.mjs (tests must execute code). Then run ONLY the targeted suites you touched or that import the touched modules, one at a time (\`cd ${HB} && node tests/<file>\`), and for existing-file seams also the existing targeted suites covering them. All must pass.\n\nDEFECTS:\n${JSON.stringify(c.map(f => ({ id: f.id, severity: f.severity, file: f.file, line: f.line, otherFiles: f.otherFiles, title: f.title, description: f.description, failureScenario: f.failureScenario, suggestedFix: f.suggestedFix, verifierFixes: f.fixes })), null, 2)}`, { label: `fix:${ci}:${files[0]}`, phase: 'Fix', schema: FIXREPORT })
  fixResults.push({ cluster: ci, files, findings: c.map(f => f.id), result: r })
}

phase('Check')
const checks = await parallel(fixResults.map(fr => () => agent(`${CONTEXT}\n\n${RULES}\n\nIndependently check a fix cluster. Findings that were to be fixed:\n${JSON.stringify(clusterList[fr.cluster].map(f => ({ id: f.id, file: f.file, line: f.line, title: f.title, failureScenario: f.failureScenario })), null, 2)}\nFix agent report:\n${JSON.stringify(fr.result, null, 2)}\nRead the current code (git -C ${HB} diff HEAD for those files), confirm each defect is actually fixed (probe with throwaway scripts in /tmp/claude-1000/ where useful), confirm nothing else broke (re-run the targeted suites named in the report, one at a time), and confirm no SPEC/owner-decision regression. ok=false if any defect is not fixed or anything regressed.`, { label: `check:${fr.cluster}`, phase: 'Check', schema: CHECK })))

return {
  totals: { findings: all.length, confirmed: confirmed.length, clusters: clusterList.length },
  confirmed: confirmed.map(f => ({ id: f.id, severity: f.severity, file: f.file, line: f.line, title: f.title, votes: f.votes })),
  refuted: all.filter(f => !f.confirmed).map(f => ({ id: f.id, severity: f.severity, file: f.file, title: f.title, votes: f.votes })),
  fixes: fixResults.map((fr, i) => ({ files: fr.files, findings: fr.findings, fixed: fr.result ? fr.result.fixed.length : 0, skipped: fr.result ? fr.result.skipped : 'AGENT FAILED', tests: fr.result ? fr.result.tests : [], check: checks[i] })),
}

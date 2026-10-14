export const meta = {
  name: 'film-build-docs',
  description: 'Film mode Claude Code packaging (skill + director agent + installer), README and url-flags rows',
  phases: [
    { title: 'Docs', detail: 'skill/agent/installer/README/url-flags rows, written from the real code' },
  ],
}

const HB = '/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web'
const REPO = '/home/wbterminal/WorldBuilder-ACME-Edition'

const PRE = `You are the documentation + Claude Code packaging agent on "AC Film Mode" for holtburger-web (the Asheron's Call web client: JS/three.js + Rust/wasm).

WHAT FILM MODE IS: an optional, default-OFF (?filmMode=on), agentic cinematography mode. A Claude Code session (Opus 5.5 on the owner's subscription — NO Anthropic API calls in code, ever) is the DIRECTOR (System Two): it turns a pasted script into a filming plan, analyses songs (structure + lyrics) for music videos and maps lyric imagery to in-world sites via an offline gazetteer, teleports the hidden player between sites (~10 s each; the world streams around the player, so it shoots BY LOCATION and never records across a teleport), and drives the page over CDP with the Node CLI tools/film/film.mjs. JEV (TypeSafe's System-One typed-decision model on OpenRouter — the ONLY metered API, key only in Node) is the camera's REFLEXES during each take (bucketed-word state about trees/walls/rocks/creatures/particles → bounded maneuvers; a code safety clamp always wins). Footage is captured stepped on a film clock with WebCodecs, HUD-free, off-screen on the owner's GTX-1070 box.

ALL CODE IS WRITTEN NOW. Your job is to document what EXISTS — read the code, never the plan. READ FIRST: ${HB}/scene3d/film/SPEC.md, ${HB}/docs/HANDOFF-film-mode-2026-10-13.md (§1 owner words, §6 owner decisions, §7 the docs-lane brief, §8 the 1070 checklist), ${HB}/docs/film-mode-2026-10-13/wip/skill_draft.md (a start — improve it), ${HB}/docs/film-mode-2026-10-13/research_jev.md and recon/pilot_design.md (for the standing-orders guidance), then the real code: ${HB}/tools/film/film.mjs (run \`node tools/film/film.mjs --help\` and each subcommand's --help — they are offline and safe), ${HB}/tools/film/plan/schema.mjs (the REAL plan format), ${HB}/scene3d/film/shots/index.js (run \`node tools/film/film.mjs techniques --json\` for the real catalog), ${HB}/scene3d/film/pilot/*.js, ${HB}/scene3d/film/index.js (the real window.__film API), ${HB}/scene3d/film/flags.js, ${HB}/tools/film/sites/search.mjs, ${HB}/tools/film/audio/analyze.mjs.

HARD RULES:
- Parallel agents may read, edit and run TARGETED single tests only (\`node test_x.mjs\`). They must NOT run the full JS gate, cargo, wasm-pack or browsers. The orchestrator runs the full gate and builds ONCE, after merging, one at a time.
- Files you may create/edit: listed in your lane below. Nothing else (no code under scene3d/ or tools/film/ except install-claude.sh; no harness edits). If you find a code bug while documenting, REPORT it (file:line, what, fix) under gaps — do not fix it.
- No git commands that change state; never arm background automation. No Anthropic API/SDK/keys. Never start browsers/servers/ACE/dotnet/cargo. Never write any account password anywhere (the film account name phase4demo is fine; its password is a run-time argument only).
- Finish with the StructuredOutput report.`

const REPORT = {
  type: 'object',
  properties: {
    lane: { type: 'string' },
    files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, purpose: { type: 'string' } }, required: ['path', 'purpose'] } },
    exports: { type: 'array', items: { type: 'string' } },
    tests: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, command: { type: 'string' }, passed: { type: 'integer' }, failed: { type: 'integer' } }, required: ['file', 'passed', 'failed'] } },
    deviations: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'array', items: { type: 'string' } },
    notesForOthers: { type: 'array', items: { type: 'string' } },
  },
  required: ['lane', 'files', 'exports', 'tests', 'deviations', 'gaps', 'notesForOthers'],
}

const L_DOCS = `LANE: docs + Claude packaging. Files you own:
1. ${REPO}/.claude/skills/film-mode/SKILL.md (frontmatter: name film-mode, a description that triggers on AC footage / music video / cinematic / trailer / drone or flythrough shots / film mode / filming in Dereth) + ${REPO}/.claude/skills/film-mode/reference/{workflow.md, plan-format.md, pilot.md, music-video.md, techniques.md, 1070.md}. SKILL.md stays short (the playbook + hard rules + pipeline + when to read which reference); details live in reference/. Look at ${REPO}/.claude/skills/worldbuilder-terminal/ for the house style.
   - Hard rules section embeds the ~/CLAUDE.md laptop rules VERBATIM (read /home/wbterminal/CLAUDE.md and copy its rules), plus: never push, never commit unless the owner asks, never arm background git automation; never open a browser on the laptop; shooting happens ONLY on the 1070's off-screen, MUTED Chrome and only in an owner-requested session (memory rule: no agent eye-tests); the 1070 is used by a person — never kill their Chrome (only the test Chrome matched by --user-data-dir), no sound may reach them; film account = phase4demo (owner decision), password supplied at run time only, single-login (~25–65 s gap after a disconnect); teleports ≈10 s → shoot by location, never record across a teleport; JEV costs money: budget caps flags, prefer code/shadow mode for rehearsals.
   - The pipeline: intake → \`project init\` → \`song analyze\` → beat sheet → \`sites search\` per lyric concept → plan.json → \`plan validate\`/\`plan compile\` → (owner-requested 1070 session) \`doctor\` → \`browser check\` → \`boot\` → \`go\` per site → \`scout\` stills (Read them) → \`rehearse\` risky shots → \`shoot\` → \`contact-sheet\` review (Read the JPEG) → retakes → \`assemble\`. Use the REAL subcommand names and flags from --help.
   - Cinematography rules (music: cut on beats/downbeats; energy → camera speed; chorus = biggest moves/reveals; verse = intimate; bridge = contrast; intro = establishing/tilt-reveal; outro = dronie/pull-out; story: establish → approach → detail → reaction, 180° rule, motivated movement, vary framing; drone: reveal over obstacles, orbit POIs at 0.5–1 rev, pass-over for the 90° gimbal moment, terrain-skim for speed, top-down for pattern; FPV for kinetic energy and dungeon corridors).
   - Standing orders for JEV (reference/pilot.md): one concrete sentence with distances and priorities, naming what may be faded (foliage, particle smoke) vs avoided (walls, buildings, rocks); good/bad examples; how pilot modes jev/code/shadow work, what the telemetry means, agreement rate, budget flags.
   - reference/plan-format.md: generated from the REAL schema.mjs — every field, defaults (normalizePlan), validation errors, one complete realistic example plan (music video, 3 sites, 8 shots incl. a dungeon fpv-corridor, a drone.pass-over and a classic.rack-focus) that you VERIFY by writing it to a temp file and running \`node tools/film/film.mjs plan validate <file>\` (must exit 0; paste nothing else from temp).
   - reference/techniques.md: generated from \`film.mjs techniques --json\` — every id with family, description, whenToUse, params (name/type/default/range) — plus a "which technique for which beat" cheat-sheet.
   - reference/music-video.md: song analysis output (sections/roles/energy/lyrics alignment), how to read it, lyric → concept → \`sites search\` (concept_lexicon.json), look presets (timeOfDay/fog/grade/dof).
   - reference/1070.md: the session runbook (tunnel/CDP :9333 launch with --mute-audio and off-screen window, \`?nosw=1\`, serve.py on :8765 reverse-tunnelled, the boot URL the CLI builds, readiness, the §8 eye-test checklist from the handoff with depth of field as a mandatory item, cleanup rules). Pull the 1070 facts from /home/wbterminal/.claude/projects/-home-wbterminal/memory/fleet-runbooks.md (READ-ONLY; do not edit memory files).
2. ${REPO}/.claude/agents/film-director.md — frontmatter \`name: film-director\`, \`description\`, \`tools\` (Bash, Read, Write, Edit, Glob, Grep — the director reads stills/contact sheets with Read), \`model: opus\`; body = the director's role (System Two), embeds the ~/CLAUDE.md laptop rules VERBATIM + no push / no self-armed git automation, and tells it to follow the film-mode skill.
3. ${HB}/tools/film/install-claude.sh — idempotent, \`set -euo pipefail\`, symlinks ${REPO}/.claude/skills/film-mode → ~/.claude/skills/film-mode and ${REPO}/.claude/agents/film-director.md → ~/.claude/agents/film-director.md (mkdir -p parents; replace an existing SYMLINK; refuse — exit 1 with a message — to clobber a real file/dir); \`--dry-run\` and \`--uninstall\` (removes only symlinks that point into the repo); honours $HOME. Test it: ${HB}/tests/film_install_claude.test.mjs runs the script with HOME set to a fresh os.tmpdir() dir (never the real home): install twice (idempotent), refuses a real dir, dry-run makes no changes, uninstall removes only our links. Do NOT run it against the real ~/.claude — the owner runs it.
4. ${HB}/scene3d/film/README.md — developer README: architecture table, module map (every file under scene3d/film and tools/film with one line each — list them from disk), page API (the real window.__film), flags, tests (every tests/film_*.test.mjs and how to run one), integration seams (from the real diff: \`git -C ${HB} diff HEAD -- scene3d/index.js scene3d/cells.js scene3d/entities.js scene3d/statics.js scene3d/particles scene3d/animated_scenery.js scene3d/atmosphere_pipeline.js\`), how to extend (add a technique, a pilot question).
5. ${HB}/docs/url-flags.md — add the main-table 6-column rows for \`filmMode\` and \`filmDof\` (copy the exact column layout of a neighbouring default-OFF \`=== "on"\` row, e.g. \`audioRetailPan\`; Default \`off\`; the Where cell = the real reader file:line(s) — find them with \`rg -n 'filmMode|filmDof' ${HB}/scene3d ${HB}/index.html\`), plus blockquoted §0 rows (\`> | ...\`, class "Harness / boot contract params": flipping on would hijack a human session; filmDof additionally: ~3 s shader compile, default-OFF outside film sessions by owner decision). Add rows for any OTHER new URL param the film code reads (rg for URLSearchParams/get( under scene3d/film). Then run, one at a time: \`cd ${HB} && node ../../scripts/lint-url-flags.mjs\`, \`node ../../scripts/lint-url-flags.mjs --strict\`, \`node ../../scripts/audit-flag-defaults.mjs --mismatch\` (paths: the scripts live in ${REPO}/external/holtburger/scripts — check the real location and invocation in their headers) and make them pass for the film flags (report any pre-existing unrelated findings separately, do not fix those).`

phase('Docs')
const docs = await agent(PRE + '\n\n' + L_DOCS, { label: 'lane:docs', phase: 'Docs', schema: REPORT })
return { docs }

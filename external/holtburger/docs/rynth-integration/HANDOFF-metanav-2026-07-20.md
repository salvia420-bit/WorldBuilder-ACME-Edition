# HANDOFF — meta-system (.met/.nav) study + import pipeline, corpus oracle (2026-07-20, session 3)

Follow-on to `HANDOFF-wedge-closeout-phi4-rig-2026-07-20.md` (same day, session 2 — its
"everything UNCOMMITTED" warning was stale by this session's start; that work was
committed as 2b12a2c8/d41b9143/bc444852).

Mission context: AI bots traversing Dereth as well as human players, incl. multi-floor
dungeons. This session opened the "meta system" avenue: the community's VTank/VirindiTank
`.met` (meta state machines) and `.nav` (nav routes) files are human-authored ground-truth
traversal data. We studied the formats, built a corpus, wired import → live replay, and
extended the offline physics oracle to validate corpus routes.

## Corpus + format spec (all at /mnt/wbterminal2/met-corpus/)

- `immortalbob-forum/` — 8 dungeon .nav (forum f=8 "VT: Nav Releases"; Catacombs of
  Torment 416 nodes, Aerbax South Gate 534 nodes, floor-puzzle + basement-run routes).
- `mudzereli-metaf-sample/` — 12 dungeon .nav WITH matching human-readable .af sources
  (Tusker Warren room set, Viridian Rise jump puzzles: the jmp→pau→chk idiom).
- `discord/` — 25 files from our own archive (media already local): Dest-MatronHive.nav
  (186 nodes, 6 portals), HoltburgTest.nav (13 nodes), Eskarina's authoritative
  "Format of .met and .nav Files" PDF, Cosmet/ViriTabulis HTML viewers.
- `discord-inline/` — 6 .af fragments mined from message text w/ provenance headers
  (incl. a self-recording waypoint-capture meta and trevis's ANTLR4 .af grammar).
- `format-spec-source/` — JJEII/metaf C# serialization source (de-facto format spec).
- `routes-json/` — hb-route-v1 converted routes (interchange schema for the Rust oracle).
- Reports: `live-replay-holtburg-report.md`, `live-replay-matronhive-report.md` (+ -2),
  `validation-reports/`.

Format facts (validated by a from-scratch parser over 22 real files, zero errors):
plain text, `uTank2 NAV 1.2` header; navType 1=Circular 2=Linear 3=Follow 4=Once;
node types pnt/prt/rcl/pau/cht/vnd/ptl/tlk/chk/jmp. ptl carries approach point AND
object name/class/coords; jmp carries headingDeg/holdShift/delayMs; rcl carries spellID.
Coordinates: VTank global /loc frame — navPointToLeg converts; live-verified to
<0.00001m against a real pose. VTank arrival test (community-reverse-engineered):
flatDist <= NavCloseStopRange*240, atan2 heading, ~5-10° turn tolerance.
.met = FSM (27 conditions/16 actions); navs embedded verbatim via EmbedNav. Traversal
ground truth lives in .nav; .met is orchestration (watchdog stuck-recovery, state chains).

## What landed (code)

1. **nav import wiring** (rynth/nav_import.js NEW, rynth/route_flags.js NEW extracted
   from goto_compose, nav_batch_import.cjs NEW CLI, nav_file.js gained Checkpoint(8)/
   Jump(9)/legacy-Portal(1) — real corpus files use them and previously aborted the
   parser; .af reader gained chk/jmp/prt tokens). `window.rynthImportNav(text, name)`
   console helper on bot.js. Corpus run: 39/41 text files import (2 .af had no NAV
   section), 49 routes / ~3,772 legs total in routes-json (forum+mudzereli 34 routes
   2,950 legs; discord 15 routes 822 legs). Record histogram (forum+mudzereli):
   pnt 2493 · pau 190 · cht 112 · jmp 98 · chk 44 · ptl 11 · rcl 2.
2. **isDropEdge floor-span rescue** (rynth/indoor_router.js): when the geometric test
   says "drop", per-cell floorZMin/floorZMax (scanned from the mesh already fetched for
   the soak-13 bbox-anchor fix, retail FLOOR_Z cosine) can rescue walkable stair/ramp
   edges; `walkableOverrides` escape hatch threaded through all four search fns.
   Evidence: BOTH flagged venues (apt z-stack 0x7200, Holtburg stairs 0xA9B4) are
   ALREADY walkable post-anchor-fix (dHoriz 3.2-3.6m, not ~0) — the handoff's Venue-2
   fear was pre-verification. Residual unknown: cell 0x7200035F degenerate mesh
   (normals between floor/wall thresholds — ramp or artifact; needs a wasm raw-tri dump
   export to resolve).
3. **route_validate.rs → batch corpus oracle** (rewritten 267→1182 lines + serde_json
   dev-dep): hb-route-v1 loader, self-determined indoor-ness (never trusts imported
   flags), indoor anchoring via faithful_find_placement_position, void-coverage guard
   (caught a real false-arrival bug), Stab→Setup→GfxObj furniture recursion ported
   (grocer: 12 parts/105 polys, regression-gated). Suites held 575/0.
   **Then generalized to arbitrary landblocks**: `discover_landblocks` (per-leg +
   segment-sampled, 1-LB margin), `build_scene_for_landblocks` (real terrain via
   `holtburger_dat::landblock` — NB the earlier "no terrain parser in holtburger-dat"
   claim was FALSE, CellLandblock/LandblockInfo parsers existed; every resident
   EnvCell + furniture; outdoor statics/buildings through the precise-BSP path),
   `ModelBspCache` memoization (corpus run 9m50s-stuck → 69s total), scope guard
   (>40 LBs → SKIPPED-SCOPE, never hit; max real route = 5 LBs), and an
   evidence-based `IMPLAUSIBLE_LEG_DISTANCE_M=500` guard (clean 27× gap between the
   longest real leg 343.7m and shortest corrupt one 9.2km).
   **Corpus verdict (50 files, 68.9s): 28 VALIDATED / 21 FAILED / 1 non-route.**
   ALL genuine dungeon routes validate end-to-end (10 tusker variants,
   catacombs-of-torment's 416 legs, bobo-inside, apostate, assassins-roost,
   knighttest). Failure clusters: 16 = corpus artifacts (recurring 24468,24468
   sentinel + 49152m map-edge wraparound legs — importer-level cleanup, not
   traversal gaps); 1 = bobo-outside outdoor terrain-coverage gap (61% walked,
   unresolved, outdoor deprioritized); 1 = frozen-tomb timeout (closed door —
   harness has no door-open state, documented); 1 = vr-bridge-jump WALL at a literal
   gap-jump leg (**expected: no jump physics — the corpus empirically confirms the
   jump primitive as the traversal gap**). Grocer fixture now runs through the same
   generic path (whole-town scene: 123 EnvCells, 292 static BSP parts) and stays
   VALIDATED; suites 575/0 held.
4. **Portal/recall-aware replay** (rynth/nav_import.js, nav_file.js, route_flags.js,
   goto_compose.js, bot.js): ptl/tlk legs carry `meta.objName`/`meta.objPos`
   (world-frame object ground truth — previously parsed but unused); rcl legs carry
   `meta.spellName` (RECALL_SPELL_NAMES table from NRecall.cs) + import-time recall-
   dependency warning. New in goto_compose: `findEntityByName` (mirrors world.js
   resolver), `attemptMetaPortalTouch` (name match → nearest-portal-by-objPos →
   walk-then-retry), `attemptRecallCast` (cast known spell, await teleport, else typed
   `recall-unavailable`), runtime indoor-cell check so the indoor-wedge repath engages
   on imported routes (which never carry leg.indoor). route_flags.js bug fix: legacy
   re-derivation now ORs the 500m heuristic with meta ground truth — bot.followRoute
   (never threads fmt) previously discarded nav-imported portal flags on
   close-together legs. Zero behavior change for flag-less/recorded routes.
   Retest: leg 8's Town Network portal (the prior failure point) USED successfully via
   name targeting; recall cast path works. Finding: a LEADING rcl leg is the route's
   starting precondition ("recall, then walk from there"), not a mid-route action —
   replay from leg 1 after positioning at the recall destination.

## Live replay results

- **HoltburgTest.nav (2021, community-recorded): replays PERFECTLY** — 13/13 legs,
  ~27.6s, zero stalls, coord frame exact. Single-landblock portal-free routes are DONE.
- **Dest-MatronHive.nav attempt 1**: legs 0-7 clean; leg 8 (first ptl, "Portal to Town
  Network") failed portal-entity-not-found → root cause: replay ignored ptl object
  ground truth (name+coords) and rcl semantics; VTank action records reuse the previous
  waypoint's coords so all 6 portal legs collapse to anchors while post-portal legs jump
  landblocks.
- **Dest-MatronHive.nav runs 2-3 (post-fix)**: leg 8's Town Network portal USED via
  name targeting (proven on two fresh sessions); two unflagged internal TN portals
  auto-resumed natively. Authoritative depth (run 3, clean terminal state):
  **leg 26 of 186** — real indoor wedge at EnvCell 0x0007017D: runtime indoor
  detection fired correctly, one-shot `repathIndoor` found a 3-leg A* recovery,
  walked 2, stalled on the 3rd, gave up (`wedges < 1`, no retry). ⚠ monitoring
  caveat: once repathIndoor takes over, origLeg telemetry goes stale (router gets a
  different internal leg list) — run 2's "legsRemaining→3 near completion" was this
  artifact, NOT genuine progress. Reproducible stall venue for offline repro:
  EnvCell transition near 0x0007017D/0x0007017C, LB 0x00070000.
- **Run 4 (post repath-fix)**: bounded-retry `repathIndoor` LIVE-PROVEN — full
  recovery from an indoor wedge at leg ~18-19, clean walking resumed (run 3's
  one-shot could only partially progress). Root cause of the leg-26 class fixed
  offline: recovery walks ended at the nearest node's bbox CELL-CENTRE instead of the
  exact target (composeGoto appends a precise goalLeg; repathIndoor didn't) —
  0x00070178 is furniture-dense, centre wedges on clutter. Fix: exact-target final
  leg + retry ladder (3 attempts, stalled-edge exclusion via new findPath
  `excludeEdges`). goto_compose tests 91→108.
  ⚠ NEW failure class: ~52s after the recovery, the headless chromium renderer's JS
  froze entirely (trivial CDP eval never returns, 0% CPU, threads in futex_wait —
  freeze, not crash/OOM; no console errors) → ACE reaped on network timeout. Distinct
  signature from the A15 RSS crash class; needs its own repro. Also: logging out
  dead/at a dungeon spot made ACE fail-spawn+relocate to Holtburg on next login —
  one reload+relogin recovers.
- **Run 5 was IN FLIGHT at session end** (2026-07-21 ~05:10): chromium
  `chrome-mh5-profile`, character autosaving normally, already outlived run 4's
  freeze point. Its report (if the monitor completed) is
  /mnt/wbterminal2/met-corpus/live-replay-matronhive-5-report.md — CHECK IT FIRST
  next session for the leg-26 verdict and max depth. If absent, the run died with
  the orchestrating session; recipe to re-run is in the -4 report.
- Admin test rig: account `phase4demo` accessLevel 5 (was 4); invincibility =
  `@neversaydie on` + `@attackable off` (@god is cosmetic). vendortest remains
  accessLevel 4. Working @teleloc to route start: `@teleloc 0xC6A90001 88.13 83.73 42.005`.

## Discord-mined execution lore (full citations in the mining agent report)

- UtilityBelt "autonav" prior art (trevis 2019-2026): hierarchical navmesh (overworld
  graph + per-LB detail meshes cached to disk), navmesh CUT at locked doors with
  lever→door off-mesh connections + per-dungeon key requirements as conditional edges,
  and a jump-connection generator: walk unobstructed navmesh boundary edges, simulate
  jump-down then jump-up back for bidirectionality, multi-point checks to isolated
  platforms, prune per-character by jump skill. THE design template for our future jump
  primitive.
- Jump event wire signal: opcode 0xF74E. Jump nodes pause nav; resume-on-land is flaky
  → community inserts 5-10s pause nodes after jumps.
- Deewain jump-puzzle rocks are SERVER-authored (not DAT statics) — pure DAT-side
  navmeshing cannot see them.
- Water rule (2026 mesh-nav prototype): all 4 terrain corners water = unwalkable.

## Ranked gaps for human-grade dungeon traversal (task-5 synthesis — evidence-based)

What the corpus + oracle + live runs PROVED WORKS: walking human-authored waypoint
chains (dense pnt sequences) through real dungeons — offline (all genuine dungeon
routes VALIDATED incl. 416-leg Catacombs) and live (13/13 Holtburg; Matron Hive
through Town Network with portals + wedge recovery). Portal-use legs (name/objPos
ground truth), recall legs (cast or typed-fail), runtime indoor detection, bounded
indoor repath — all landed and live-proven this session.

Ranked remaining gaps, by evidence weight:
1. **Jump primitive** — THE structural gap, now triple-confirmed: (a) 98 jmp records
   in the corpus (heading/holdShift/delayMs = human ground truth per jump);
   (b) vr-bridge-jump fails offline at the exact gap-jump leg (WALL, 0.27m);
   (c) both router (isDropEdge prune) and MoveTo driver lack any jump/fall path by
   design. Design template exists: UB's jump-connection generator (edge-walk +
   simulate down/up + per-char jump-skill prune), retail jump v_z formula (decomp:
   `_powera/(_powera+1300)*22.2`), 0xF74E landing signal, corpus jmp→pau→chk idiom.
2. **Headless client freeze** (new class, run 4): total JS freeze mid-dungeon-lap
   (futex_wait, no crash/OOM/console) ~52s after a repath recovery; distinct from
   the A15 RSS class. Caps ALL long autonomous runs; needs targeted repro
   (suspects: nullRender+renderOnDemand cadence starvation, bake-worker interplay).
3. **Door-state in navigation**: offline oracle has no door-open (frozen-tomb
   timeout); live repath walks reuse world.js door handling only on the main path.
   Follow: thread closed-door detection into recovery walks + oracle door toggling
   (ties to Track D residual: stage_bsp_02 door-blind fine-BSP staging).
4. **Importer sentinel cleanup** (16 routes): drop/split legs at 24468,24468
   sentinels + map-edge wraparound coords at import (route-segmenting like the
   leading-rcl precondition finding) — cheap, converts most of the failed corpus.
5. **bobo-outside outdoor coverage gap** (1 route, 61% walked) — not root-caused;
   outdoor was deprioritized deliberately.
6. **Dungeon graph completeness for unvisited wings** — live graph = streamed cells
   only; dungeon_suggest frontier hints remain advisory. Corpus routes can pre-seed
   expected cell sequences per dungeon (atlas-of-dungeons idea).
7. Oracle building-collision parity (precise-BSP vs live coarse AABB path) +
   0x7200035F degenerate-mesh disambiguation (needs a wasm raw-tri dump export) —
   documented, low-risk.

## Suites at handoff

- node rynth suite: 36 passed / 0 failed / 2 skipped (pre-existing live-only skips);
  within it goto_compose 108 (was 77), nav-import 13 (new), indoor-sim 41 (was 26),
  ai_dungeon_nav 70 — all green.
- holtburger-world (cargo, single-package): 575 / 0 (baseline held exactly).
- core/dat untouched this session (baselines 601/0/1 and 609/0 from session 2).

# HANDOFF — post-flip session 3 work order: click-family fixes + shim real-lengths + Dead-bake (2026-07-04)

Session 7 of the movement-port arc. Session 6 (job 333ff13e) killed bug A
end-to-end, landed BOTH default flips, and ran the wave-2 16-packet fleet.
READ FIRST, in order:

1. This doc (the work order + the user's post-fleet refinements).
2. `/mnt/wbterminal2/fleet-wave2/parts/p11..p16.md` — the six live-bug
   diagnoses you are executing against (each carries a ranked
   root-cause chain + a live-verification recipe). p01..p10 = the
   position-arbitration/cast research (menu item 5 feed; integrate
   later, read-verify every cite — agent citations are HYPOTHESES).
3. `docs/HANDOFF-postflip2-leashgate-fleet-2026-07-03.md` — the prior
   work order (bug A context; its items 1-3 are DONE).

Everything is pushed through `8bf01934`. Floors at HEAD: core 568/10
(failing-set md5 `693c4c01…`, the SAME pre-existing 10), world 542/0
(+2 gate pins), web 126/1 (pre-existing tests_substitution), rust_pose
13/0, wasm32 check clean; release wasm 4,704,154 B (both flips in).

## Session-6 state you must not re-derive

- **Bug A is DEAD and shipped.** The reconcile leash arm's InterpolateTo
  pull mis-gated on `controlled_by_server`; retail gates on
  `UsePositionFromServer` (autonomy != 2, acclient.c:717529 — routine-arm
  vtable slot 8 = 0x803cc0+0x60 = 0x803d20 at :145213, resolved via the
  2013 binja dump; arithmetic cross-checked 5-for-5). Conviction:
  flag-off `applied +36 ≡ mirrorSeen +36` / carriers 0 / 4.9 m yank
  (zero-GPU rhythm leg — strafe→STOP→cast standing; held keys reclaim
  the mirror edge-instantly and MASK the bug); user 1070 confirm:
  applied +0 / gated +344 / z flat / "no snapback".
  `?leashEchoGate` DEFAULT-ON (`=off` escape). vfptr[15] =
  GetAutonomyLevel (keep_heading = autonomy != 0) — dossier question
  closed. Diag: `leashEchoDiag` ("seen,mirrorSeen,applied,gated,
  lastDeltaCm") on `__hbWasm`.
- **ADJ-8 LANDED**: `?slideCast` DEFAULT-OFF (authentic burst), `=on`
  modern opt-in, `USE_SLIDE_CAST=false`, user ruling quoted verbatim in
  `5e9a4918`. Burst floor: bare-URL leg deadPreTap 10/11 + single-tap
  revive. NOTE P16-H3: the burst tradeoff is NOT the cause of the
  backward-cast bug under live defaults.
- **Mechanism notes** (bot-lore, load-bearing for legs): leash pulls
  need standstill windows AND resolved body contact — bots only convict
  on FLAT ground (slope strafe leaves stale non-grounded contact through
  a standing window; real-input sessions keep contact resolved).
  `WalkBackwards` is REWRITTEN to `WalkForward` negative-speed
  (interp_state.rs:12/:27/:58) — forward-slot rules apply to S verbatim.
- Commits this session: `4ac8bba3` (round-3 counter) → `69b1290a`
  (gate) → `b53db682` (fleet spec 10) → `5e9a4918` (both default
  flips) → `8bf01934` (fleet +P11-P16).

## Fleet wave-2 results (16/16, sha256-verified) + USER REFINEMENTS

Parts: `/mnt/wbterminal2/fleet-wave2/parts/` (12-20 KB each). The user
reviewed the P11/P12 verdicts and added two live observations that
ADJUDICATE the ranked chains — fold these in before coding:

- **P11 REFINEMENT (user): the corpse/death failure is much broader
  than tuskers.** "Most monsters aren't showing dying animation but
  some are" — and the ones that DO die visibly "seem to be only
  creatures with particle effects" (fragments etc.). This SHIFTS H1
  from a tusker-data quirk to a GENERAL Dead-pose bake defect: the
  spawn-time corpse bake (`entities.js:3126`, uncaught → spawn throws →
  corpse never in `entityMap`) AND the live creature's death `setMotion`
  bake (caught, non-fatal → no collapse animation) fail for MOST
  complex creature setups; the visible-death set (simple/particle
  setups like the empty-objdesc Obsidian fragment) is the EXCEPTION
  that bakes clean. Investigate the common bake-failure mode across
  several failing setups (multi-part rigs? the Dead motion id
  resolution? keyframe fetch?) rather than one mtable. The fleet's fix
  direction stands and gains urgency: rest-pose fallback on Dead-bake
  reject/degenerate + log `onAnimationError`, THEN root-cause the bake.
- **P12 REFINEMENT (user): peace mode ALSO cannot loot corpses.** The
  fleet's #1 (magic-stance branch lacks the corpse-open carve-out,
  picking.js:821-921) is now a CONTRIBUTOR, not the sole cause — the
  peace branch HAS the carve-out and still fails. Run the part's
  stance-matrix recipe expecting peace to fail too, then follow its
  branches in order: (#4) corpse hydration/`entityIsCorpse` flags —
  NOTE P11: if most corpses never enter `entityMap` they are
  unclickable, so P11's fix may BE most of P12; (#2) ranged-kill
  distance + ACE's post-Use MoveToChain arrival (our client-authored
  autonomy may never complete the walk-in — ties to p02/p03 research);
  (#3) the universal double-click gate; (#5) silent permission fails.
  Fix P11 FIRST, re-test P12 on visible corpses.

Verdict headlines for the rest (details + recipes in the parts):

- **P13 + P16-H2 (ONE fix): the 2.0 s completion-clock shim** drains the
  backward-walk/gesture node and re-resolves the rendered clip to
  stance idle — S-walk reverts to peace idle at ~2 s; during casts the
  body moonwalk-slides backward under an idle anim. The session-5 named
  follow-up (REAL authored lengths at the wasm ingest site, loop-class
  cycles exempt from the one-shot clock) now has two user-facing bugs
  on it — do it properly, don't widen the 2.0 s budget.
- **P14 portals: premise corrected by decode** — portal setup
  0x020001B3 is ONE solid opaque 20-poly part + particle
  `default_script` 0x33000B7A (NOT alpha/zero-part). Failure is
  upstream: the portal CreateObject never reaches `_spawnImpl`
  (streaming/hydration family) or the rig fetch fails for
  setup+mtable 0x09000003. Shares P11's fallback lesson.
- **P15 ground pickup: wrong action sent.** Click routes to `useObject`
  (0x0036 — ACE walks over, does nothing) instead of
  `moveItem`/PutItemInContainer (0x0019). The fix path EXISTS and is
  proven: `corpse-loot-bar.js:263` already uses
  `sessionHandle.moveItem(guid, playerGuid, 0)`; the part has a console
  one-liner to confirm live. Plus the F17-2 double-click gate eats
  single clicks entirely.
- **P16-H1 (click-cast kite killer): `CAST_FACE_TARGET`'s turn-to-face
  pre-step calls `setMovementInput(0,0,turn,0)` then zeroes — OVERWRITES
  the held-S ManualSet drive with no key edge left to revive it.** Pure
  client defect, no retail analog (retail's TurnTo left the held
  command on the list). H4: targeted-cast heading rotation re-points
  "backward" mid-kite (retail-faithful in spirit, amplified by H1).
  H5 (unverified): magic-stance MotionTable may lack a backward cycle.

## Work order (value order)

1. **P15 fix — click → `moveItem` for ground items** (smallest, proven
   path, immediate user value). Confirm with the part's console recipe
   first, then reroute the picking.js item branch. Respect the
   double-click convention question (ask the user: single or double
   click to pick up? retail was double... confirm before changing feel).
2. **P11 Dead-bake fallback + root-cause** (user-broadened): land the
   rest-pose fallback so corpses COMMIT (visible > correct), log the
   bake error, then chase the common failure mode across failing
   setups. Re-test P12 and P14 after — both may shrink.
3. **P12 loot chain on VISIBLE corpses** (post-P11): stance matrix,
   then hydration-flags/arrival/double-click/permission branches per
   the part. Add the magic-stance corpse carve-out regardless (it IS
   missing).
4. **P13/P16-H2 shim real-lengths** — the proper authored-length
   resolve at the wasm ingest site (machinery behind
   `lookupMotionLinkForSwing`/`build_concatenated_motion_frames`), loop
   cycles exempt. Closes two bugs + the session-5 debt.
5. **P16-H1 turn-to-face drive stomp** — stop overwriting the manual
   drive; retail-faithful shape = turn without killing the held command
   (cf. p07/p08 research for the TurnTo ownership model). Coordinate
   with bug C (P07) — same picking.js family.
6. **P14 portals** — after P11's fallback lands, re-check; if still
   invisible, chase the streaming/hydration hop per the part.
7. **P01-P10 integration** (movement-port menu item 5 feed) — separate
   session recommended; read-verify every file:line before use.

## Infrastructure state (as of session end)

- **buildbox: POWERED OFF** (billing stopped; disk kept, 87%).
  ⚠ BOT-LORE: the box's `~/.claude/.credentials.json` OAuth EXPIRES —
  the first wave-2 launch 401'd all 16 agents instantly (74-byte
  parts, uniform). Before ANY fleet launch: compare `expiresAt` vs now;
  if stale, `gcloud compute scp ~/.claude/.credentials.json
  buildbox:~/.claude/` from the laptop (laptop token refreshes with
  use) + a 1-line `claude -p` AUTH-OK smoke, THEN launch. Also: verify
  SENTINEL runs by CONTENT (head -c the first part), not existence.
- 1070 capture chrome: PARKED at about:blank (tap uninstalled — the tap
  was the user's fps complaint, not shipped code). launch-capture.bat
  pins `cmdInterp=on&slideCast=off&leashEchoGate=on` (now all
  defaults/redundant — kept explicit for capture reproducibility).
  Tunnels 9333/9334 + reverse 18765 + wsbridge :8080 were live at
  session end; re-verify before driving.
- serve.py :8765 up (`--allow-missing`); ACE up (pid 21989, 9 days).
  ⚠ The RUNNING ACE binary predates the source tree: `@createcreature`
  (DeveloperCommands.cs) is NOT registered — ACE masks it as "Unknown
  command"; use `@create <wcid>` (AdminCommands.cs:2175). @telepoi /
  @teleloc / @acehelp fine. tailnet1 accessLevel=4 (Developer) in
  ace_auth (creds in $ACERT/Config.js).
- Harness (untracked by convention, apps/holtburger-web/harness/):
  snaptap-install now samples `le:` (leashEchoDiag) and freshness-gates
  on the leashEchoDiag export; jobs-tmp legs from this session
  (convict-leg/gate-leg/burst-leg + analyzers) in
  `~/.claude/jobs/333ff13e/tmp/` — the rhythm + flat-ground + guid-from-
  audit-log patterns are the reusable bits.

## Traps hit this session (do not re-hit)

- **Standstill + flat ground for leash legs** (see mechanism notes):
  held-strafe cast legs measure applied+0 FOREVER (edge reclaims);
  slope legs measure applied+0 (stale contact). Rhythm + flat ground or
  you convict nothing.
- **Do NOT run capped builds concurrently with headless-chromium legs**
  on the 8 GB laptop — earlyoom prefers chrome; it killed leg #1 ~70 s
  in (clean LOGOUT ~60 s after the renderer died).
- **Ghost clocks, again**: page-drop → LOGOUT lands ~60 s later (clean
  navigations can land in ~1 s) → +95 s before relogin is safe. Gate
  every leg on the LOGOUT line, not wall time.
- **Result-watchers must gate on CONTENT freshness** (run-id/mtime in
  the JSON), not file existence — a stale fail-stub satisfied the
  monitor and reported a phantom failure while the real run succeeded.
- **`rg -rn` struck twice more** (`-r n` = --replace n). Plain `rg -n`.
  Backticks inside page.evaluate TEMPLATE LITERALS terminate them (the
  GLSL-comment rule generalizes: no backticks in ANY embedded-string
  comment).
- **Mid-session spawn hydration gap (OPEN, bot-flags-scoped)**: an
  `@create`'d creature never entered `entityMap` on a
  `?nullRender=1&renderOnDemand=1&netDrainHz=30` page (login-time
  entities fine; REFUTED as the corpse cause on real render pages —
  P11-H3). Legs work around it by lifting the guid from ACE's audit
  log line. Root cause unknown — worth a look when touching the drain.
- **Chat-UI Enter-to-send is broken for the user (click works)** —
  unfixed observation; the wasm sendChat path itself is wire-proven
  clean (WebSocket byte-tap in session 6).
- The wstap/ladder/chat probes in jobs-tmp are the reusable wire-truth
  kit: WebSocket.send monkeypatch (frame hex), access-ladder via
  @acehelp/@telepoi/@create, chat-DOM response reads.

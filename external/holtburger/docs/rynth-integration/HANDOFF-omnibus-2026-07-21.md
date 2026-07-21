# HANDOFF — Surveyor OMNIBUS (2026-07-21, session 6b): 2-phase buildbox fan-out DONE, apply+deploy PENDING

Operator is time-limited; this handoff covers everything AFTER tarball verification. The laptop tree
is UNCHANGED by phase 2 so far — still at pushed commit `23936991` (Surveyor rounds 1+2). The stream
rig is fully DOWN (operator request: RAM): chromiums + ffmpeg killed, `STOP` latched — the bot is
OFFLINE until relaunch. Buildbox powered off (billing stopped; disk kept).

## What exists, verified, on /mnt/wbterminal1/omnibus/

- `p1/` — PHASE-1 RESEARCH (16 Opus agents): `parts/{A1-A7,B1-B4,C1-C5}.md` (~384KB) +
  `SYNTHESIS.md` (52.8KB) = merged research + the PHASE2-PLAN (also split as `synth_00`/`synth_01`).
  Checksum-verified (`p1.tgz: OK`).
- `p2/` — PHASE-2 IMPLEMENTATION (16 Opus agents, 16/16 packages exit=0):
  - `p2.tgz` (sha256 OK) → `parts/WP*.md` (per-package reports incl. deviations), `progress.log`,
    `gate_node.txt` / `gate_world.txt` / `gate_core.txt`, `p2.diff` (TRACKED-file changes, 2332
    lines, generated from the WorldBuilder repo ROOT), `p2.status`.
  - `p2-untracked.tgz` (sha256 `ed228e46…dba73f`, 14 NEW files + 10 new test files) — `git diff`
    does NOT contain new files; BOTH archives are required.
- Box-side gates (all green): node suite **50 passed / 0 failed / 2 skipped** (baseline 39),
  `cargo test -p holtburger-world` **579/0** (was 576), `-p holtburger-core` **606/0/1-ignored**
  (was 603).

## What phase 2 built (see synth_01 for full WP specs; parts/WPnn.md for what actually happened)

- **Wave A (wasm survival):** WP-1 arrival z-clamp (the live z-flatten wedge — z 0.005→0 embed);
  WP-2 last-known-good landblock + no-retire-on-transient-NULL; WP-3 raw-pose shadow retention
  (getLocalPlayerPose no longer regresses to cell 0).
- **Wave B (harness survival):** WP-4 explorer boots with combat kernel OFF + loot_loop enabled-gate;
  WP-5 public director `isBusy()` accessor; WP-6 frontier/loopVerdict memoization + missing sev-3
  arms; WP-7 `rynth_host_contract_test.cjs` anti-drift gate.
- **Wave C (nav guards):** WP-8 `nav_frame.js` (one copy of frame/taxonomy math, 6 dupes replaced);
  WP-9 `nav_guard.js` sub-floor-z + landblock-legality leg filter; WP-10 straight-line fallback
  REMOVED from the pressure ladder + doorway pre-approach.
- **Wave D (DARK Mag cores — flag-off, not wired to director):** WP-11 `loot_policy.js` (VTank-
  semantics first-match evaluator + TierCalculator port); WP-12 `ai/combat_memory.js` (DPS/accuracy/
  danger from the event stream); WP-13 `suit/suit_solver.js` Tier-0 coverage gaps (Mag-SuitBuilder
  EquipMask/CoverageMask port); WP-14 `ai/heal_reflex.js` + `ai/confirm_reflex.js`.
- **Wave E (observation budget):** WP-15 `ai/observe_assemble.js` salience/quota assembler wired into
  extensions.js (parts.join fallback kept); WP-16 goal-gated steady-state lines + journal tail cut
  8/700 + plan/result echo filter.
- **DEFERRED list + C5 KILL-LIST** (EORT logger ports, SuitBuilder GUI, blind town walk, embeddings,
  RynthPilot flip, GoalStack, etc.): end of `p1/synth_01`. Wave D/E wiring lands in a LATER phase,
  after survival proves out on soak.

## REMAINING STEPS (in order)

1. **Apply to laptop tree** (repo root `/home/wbterminal/WorldBuilder-ACME-Edition`):
   `git apply --stat /mnt/wbterminal1/omnibus/p2/p2.diff` (inspect) → `git apply` it →
   `tar xzf /mnt/wbterminal1/omnibus/p2/p2-untracked.tgz -C .` (drops the 14 new files in place).
2. **Verify locally:** from `external/holtburger/apps/holtburger-web`: `node rynth_test_all_node.cjs`
   → expect **50/0/2**. Rust via the OOM jail: `env PATH=... capped-build cargo test -p
   holtburger-world` (579/0) and `-p holtburger-core` (606/0). (kill rust-analyzer first.)
3. **Rebuild release wasm** (pkg/ is stale vs new Rust): from apps/holtburger-web,
   `env PATH="/home/wbterminal/.cargo/bin:/usr/local/bin:/usr/bin:/bin" capped-build wasm-pack build
   --target web --out-dir pkg --release` (~5-15min; verify ~4.6-4.9MB, NOT ~18MB).
4. **Review** `p2/parts/WP*.md` deviations sections (WP-11 note: its first run wrote the files then
   timed out reporting; the rerun VERIFIED rather than rewrote — legitimate).
5. **Commit + push** (one omnibus commit; end message with the Claude trailer as before).
6. **Relaunch rig:** wipe `holtburger_ai_journal_v1` + `holtburger_ai_scratchpad_v1` from Local
   Storage (KEEP `holtburger_ai_key_v1`, `rynth.atlas.v1`) — must be done via CDP after first page
   load OR skip (journal was already wiped this morning); clear `profile-game/Default/{Cache,"Code
   Cache",GPUCache}`; `rm /mnt/wbterminal2/stream/STOP`; check `xrandr` still 1280x720; `bash
   /mnt/wbterminal2/stream/launch.sh`; expect ONE error-boot → reload → in-world; then
   `bash /mnt/wbterminal2/stream/go_live.sh &`. ⚠ YouTube will mint a NEW watch URL (the old
   broadcast ended when we killed ffmpeg) — check YT Studio.
7. **DEPLOY GATE (from the plan):** 30-min cold-academy soak — no in-academy death (WP-4: explorer
   now boots combat OFF), leaves the start cell, `exploreMemory.coverage().tiles` strictly
   increases, no terminal wedge, and the ACE log shows NO `failed transition ... [.. 0]` z-embed
   lines (WP-1 oracle). Watch `[pressure]` journal lines: straight-line hops are gone; expect graph
   paths, portal ledger use, and honest "no reachable frontier" + escalation.
8. **Next phase (not now):** wire the dark cores per the DEFERRED list order — loot_policy into
   loot_loop, combat_memory observe line, suit upgrades DFS, reflex kernel registration, GoalStack —
   each gated behind the WP-15 budget governor proving out on soak.

## Ops notes from this session (cost time — don't repay)

- **Buildbox claude auth:** box uses a COPY of the laptop's OAuth creds (`~/.claude/.credentials.json`).
  Access tokens live ~8h: a >8h fan-out (or one starting on an old token) 401s mid-run — this killed
  round 2 once (recovered). Recipe: copy CURRENT laptop creds → box, run one `claude -p` AUTH-OK
  smoke, `cmp` box creds after and sync BACK to laptop if rotated. Canary any fan-out monitor with a
  fresh-file-only grep for "Failed to authenticate".
- **`pkill -f <pat>` self-kill (exit 144/255):** never put the pattern of your own ssh command line
  in pkill/pgrep args — kill by PID/pgid (`kill -- -PGID`), or bracket-trick patterns (`[c]laude`).
- **Fan-out drivers:** a timed-out package can still have WRITTEN its files (WP-11); reruns should
  verify-not-rewrite. A still-running previous driver can drop a STALE sentinel/tarball —
  kill the old driver pgid before re-running, and rm sentinels first.
- **`git diff` misses untracked files** — always tar `git status --short | grep '^??'` separately.
- serve.py logs 4xx/5xx ONLY (quiet log ≠ stale assets; .js/.wasm are no-cache).
- Monitor tool caps at 1h — long fan-outs need re-arming on timeout events.

## Quick state recap for next session

- Laptop repo: commit `23936991` + this handoff file (uncommitted). Phase-2 NOT yet applied.
- Stream rig: DOWN (STOP latched). ACE server: still running (untouched). Vendbot: logged out,
  Sanctuary STILL academy lifestone (re-bind happens on first real exit via portalnewbieexitholtburg).
- Buildbox: powered off; ~/vendor/Mag-Plugins-master + both phase workspaces remain on its disk.
- Mag-Plugins vendored at /mnt/wbterminal1/vendor/file-kiwi-7efaa1ac/ (sha256 f26145f9…12ce93d).

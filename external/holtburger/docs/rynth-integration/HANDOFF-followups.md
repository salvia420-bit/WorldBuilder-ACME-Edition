# Handoff — RynthNav fan-out follow-ups (2026-07-16, later session)

Continuation of `HANDOFF-remaining.md` (which delivered item A, the RynthNav global
router sidecar). This session ran two buildbox fable fan-outs (10 agents + 6 agents)
against the remaining nav/combat/buff work, applied the results to the laptop,
live-verified them (including a real-GPU onscreen run on the 1070), and pushed.
This handoff carries the **remaining task list** and the context to execute it.

Repo: `WorldBuilder-ACME-Edition`, submodule `external/holtburger`, branch **master** (pushed).
Head at handoff: **`6ff0080a`**. This session's commits: `3fa89988` (sidecar scale +
input hardening + building-seal + lifecycle), `bd50a633` (nav-stack + goto + indoor A*),
`f08c6128` (combat + buff + vitals parity fixes), `6ff0080a` (netwasm spikes).

## 0. Read first
- `/mnt/wbterminal2/rynthnav-handoff/` — durable artifacts this handoff points at:
  `coverage.txt` (14,195 portal-coverage LBs, for the full-map rebake), `batch1-synthesis.md`,
  `batch2-synthesis.md`, `batch2-buff-findings.md` (B5's 10 findings), `batch1.patch` /
  `batch2.patch` (already applied — reference only), `1070-visual-proof.png`.
- `apps/rynthnav-sidecar/README.md` — sidecar HTTP contract, bake pipeline, lifecycle, traps.
- The buildbox (GCE `buildbox`) is **powered off** (TERMINATED, disk kept). Its scratch
  (`~/rynthnav-full/`, `~/rynthnav-run/`, `~/rynthnav-b2/`) survives a stop if you restart it.

## 1. What SHIPPED this session (don't redo)
All applied to the laptop, tested, and pushed:
- **Sidecar**: LRU tile eviction + `--max-tiles`/`RYNTHNAV_MAX_TILES` (default 1024, was hard 256);
  `LoadCorridor` bbox clamp (out-of-map goal was a 25–50 min spin, now ~30 ms); `/route` input
  hardening (400/413/405 taxonomy, CORS on all); `--tile-high-water`; `tileinfo` documented.
- **Bake**: **building-seal is DEFAULT ON** (`--no-seal-buildings` to reopen doorways) — outdoor
  routes go AROUND houses. GeomCheck gained SEAL invariants. Placement-frame fix (`0x65`) from the
  prior commit `eb5eef21`. A9B4 seals to 171 polys.
- **Nav JS**: hardened `bot.goto` (pose-race + busy-latch fixes, portal resume, stall deadline,
  kernel-state restore); `indoor_router.js` (dungeon cell-graph A*, not yet wired/live-tested).
- **Combat**: 4 fixes (stickiness 25→12.5, scan-grace re-lock, hp=0-only kill, TTL 30→4s) + **T4
  fail-open** (engage when desc flags genuinely absent, via new `HasObjectDescFlags`).
- **Buff/vitals/kernel**: all 10 B5 findings (B11 livelock, kernel-gate never-rebuff-after-death
  via `buff.heartbeat()`, B4 upgrade, B8 confirm-by-family, B9 tier-walk-down, B16 order, B15
  boundary; #8/#10 confirmed JS already correct).
- **Netwasm spikes**: `CombatScoring/` + `BuffScoring/` parity harnesses (how the bugs were found).
- **Lifecycle**: `scripts/rynthnav-sidecar-boot.sh` (idempotent, cron `@reboot`) + `supervisor.cjs`
  opt-in `RYNTH_SIDECAR_URL` health watch.

Verified: 4 clean builds; navsim 28/28, combatparity 12/12, bufffix 12/12, sidecar 22/22;
BuffScoring divergence 15→9 (rest intentional), CombatScoring 21→17; live globalroute walk on
the sealed navmesh; **1070 onscreen real-GPU run** (GTX 1070/D3D11, bot walked 9 legs across a
rendered Holtburg on the sealed navmesh, arrived — see `1070-visual-proof.png`).

## 2. REMAINING TASK LIST (the carry-forward)

### #15 — T5 live check: spell projectiles excluded from combat targeting  (small; needs live ACE + a war-caster)
B3 flagged that our combat targeting may not filter war-caster spell bolts (they can stream as
attackable `ItemType 16` creatures). ACTION: find/spawn a war-caster mob (e.g. `@telepoi` to a
spot with one, or an ACE admin spawn), log `NearbyGuids` itemTypes during its casts; if bolts
appear as attackable, port the T5 name/type filter into `rynth/combat_loop.js` (cite the C#
`CombatManager` T5 filter). Bounded, ~1 login.

### #16 — Full-map sealed rebake from coverage.txt  (LARGE; hours + OOM risk on the 8 GB laptop)
Bake the 14,195-LB portal-coverage set (`/mnt/wbterminal2/rynthnav-handoff/coverage.txt`) locally
with the **fixed + sealed** GeomExtract, so global routing works beyond the 5×5 Holtburg region.
- Producer decision (audit F1): the laptop bakes A9B4=183 polys where the buildbox baked 182
  (cross-CPU float variance). **Keep the laptop as the single bake producer** — that's why this
  runs locally, not on the buildbox tiles.
- OOM caution: the 8 GB laptop can't do this in one shot (the buildbox OOM-killed 2 of 386 rects
  even at 47 GB). Serialize: decompose coverage into small rects, run GeomExtract→bake one (or two)
  at a time, monitor RSS, write tiles to `/mnt/wbterminal2/rynthnav-data` (or a fresh dir then swap).
  A helper script is the right first step (batch-2 B4/01 reports have the rect-decomposition logic).
- After baking: raise the served `--max-tiles` (coverage ≫ 256 tiles), GeomCheck-gate, restart
  the sidecar, spot-check a cross-region portal route.

### #18 — LootEvaluator netwasm parity lift  (subagent-scale; token-heavy)
B5's recommended next slice: lift `Loot/VTankLootEvaluator.cs` + `LootEvaluator.cs`
(`/mnt/wbterminal1/ac-refs/rynthsuite/Plugins/RynthCore.Plugin.RynthAi/`) to a netwasm parity
harness vs `rynth/loot_loop.js`, mirroring `netwasm-spike/CombatScoring` + `BuffScoring`. Pure
predicates, no clock, wide item-property DTO. Expect it to surface real loot_loop bugs (the
pattern found 4 combat + several buff bugs). Best run as a focused subagent.

### Smaller open items (from batch-2 synthesis §3; not yet tasked)
- `kernel.js`: verify the `_running` public getter + the per-start closure leak (synth §3 #4) were
  addressed — the buff work added `heartbeat()` but the getter/leak may be untouched.
- `CombatScoring/parity_check.cjs` harness was corrected this session; BuffScoring's residual 9
  divergences are all intentional (documented in-file).
- Portal-arrival re-validation: `rynth_portalcheck.cjs` exists (dry-run verified) but the live
  batch validation vs our ACE hasn't run — do it once the full-map bake lands (retail GoArrow
  coords are ~0.1° approximations).
- B3 rulings still open if you want them: T8 first-match vs max-priority (config API break),
  park-duration. (T4 was ruled fail-open and is done.)

## 3. State / how to run
- Laptop services (all up): ACE (UDP 9000/9001), serve.py (:8765), wsbridge (:8080), **sidecar
  (:8767, serving the sealed Holtburg tiles** at `/mnt/wbterminal2/rynthnav-data`).
- Rebuild after edits: `DOTNET_ROLL_FORWARD=LatestMajor ~/.local/bin/dotnet build -c Release`
  in `apps/rynthnav-sidecar` (single-project, memory-safe). Node tests: `node rynth_<x>_test.cjs`
  (no infra); smokes need Playwright on `NODE_PATH` + the live stack.
- 1070 onscreen re-test recipe (proven this session): reverse-tunnel serve.py/wsbridge/sidecar
  (`ssh -fN -R 8765 -R 8080 -R 8767 -L 9333 young@100.127.215.75`), launch Chrome via schtasks
  `/it` (interactive session = real GPU) with `--use-angle=d3d11 --mute-audio --user-data-dir=
  C:\Temp\cdpwb-1070test`, drive via CDP `:9333`. Close by user-data-dir match, NEVER `taskkill
  /IM chrome.exe`. Chrome must be absent first (don't collide with the person's session).

## 4. Gotchas (cost real time)
- `pkill -f <pat>` / PowerShell `-like` where the pattern is in your own cmdline = self-kill
  (exit 144) and quote-mangling. Kill the tunnel by port (`ss -tlnp | grep :9333`), close 1070
  chrome via an uploaded `.ps1`.
- The buildbox shares the laptop's OAuth usage pool; a fan-out can exhaust the 5-hour session
  limit (killed agent 07 in batch 1). Pace it.
- Applying collected fan-out patches: exclude the stray `AGENT*.md` cruft (a prior fanout's
  untracked files) and any half-done agent's edits; the buildbox `git add -A` sweeps them in.
- Bake is deterministic per-box but float-variant across boxes (F1) → one producer.

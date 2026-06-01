# Full-World Bake + Verify — HANDOFF (2026-06-01)

Handoff for the next agent continuing the **bake-the-entire-world + per-landblock
client-side verify** mission. Read these first (deeper detail than this doc):

- **Plan**: `docs/full-world-bake-and-verify-plan-2026-05-30.md` (the phased plan).
- **Memory**: `~/.claude/projects/-home-wbterminal/memory/project_holtburger_full_world_bake_verify_2026-05-30.md`
  (running log of every phase + decisions; the single richest source).
- **Method docs**: `docs/{world-completeness,ring-expansion,ring-diagnose-repair,diagnostic-toolset,entity-completeness,event-completeness}-method.md`, `docs/scenery-bake-b5-collision-parity-report.md`, `docs/ace-local-setup.md`.
- Repo: `/home/wbterminal/WorldBuilder-ACME-Edition`. App: `external/holtburger/apps/holtburger-web`.

## The mission (user's words)
Bake the FULL world — every landblock + all EnvCells, "just everything" — not only
the Holtburg ring; and **verify each landblock CLIENT-SIDE** with the wire-agent loop
(login ACE → position at LB → `__diag` → next), skipping impassable LBs (ocean). Don't
assume current data is fine. Binding decisions: **verify against LIVE ACE** (entities
off the wire, not JSONL replay); **no spawns JSONL bake**; **no events JSONL bake**
(events fire at runtime; oracle = `dump-lb-expectations`); **100% ACE parity**.
⇒ the full-world BAKE collapses to ONE produced layer: **`dist/scenery` JSONL** (terrain
+ EnvCells are already whole-DAT in `manifest/shards`; spawns/events come live/runtime).

## Status: Phases 0–6 DONE. NEXT = Phase 7.

| Phase | State |
|---|---|
| 0 Census | ✅ `landblock-census` bin → **40,197 content LBs** (`content-landblocks.txt`) + 3,409 dungeons (`dungeon-landblocks.txt`). Numbers match the plan exactly. |
| 1 100% ACE parity | ✅ scenery bake bit-parity: **position+scale bit-exact, rotation ≤1 ULP** (accepted floor; .NET MathF vs Rust libm). `--bits` harness + compare-bits.py. 3 fixes landed. |
| 2 Prereqs | ✅ (a) scenery plumb-fix landed + verified in-world (scenery now fetches+renders). (b) `@teleloc` reaches dungeon interiors with a Dev account → all 3,409 dungeons verifiable. |
| 3 Verify-loop infra | ✅ built + tightened. `gen-oracles.mjs` + `verify-sweep.mjs`; 9-LB ring sweep clean (5 PASS / 4 DRIFT = genuine npc signal). |
| **4–5 Full-world bake** | ✅ **DONE 2026-06-01.** Baked `dist/scenery` for all **40,197** content LBs (12-chunk `xargs -P 3` shard of the parity binary; **58s**, 0 fail, no OOM). 40,197 jsonl+sidecars, 1:1 vs census (0 miss/0 extra), ~3.13M placements, 921MB. `bake-source.sha256` fixed to world total (parallel-write race), DAT hashes verified. Swapped into the served root (stale ring kept as `scenery.old`); `_health.json` green; HTTP spot-checks pass. See memory log for full detail. |
| **6 World oracles** | ✅ **DONE 2026-06-01.** `gen-oracles.mjs` single-stream → **40,187 / 40,197** oracle JSONs (~845MB) at `/mnt/wbterminal1/tmp/claude-scratch/world-oracles-2026-06-01/oracles`. **318s** (~110-126 LB/s steady; the handoff's 1.5/s was load-dominated — sharding NOT needed). DATs sha256-identical bake↔oracle (consistent). **10 LBs unloadable by WB.T** (`success:false "Could not load landblock"`, deterministic; 8 dungeon + 2 outdoor; WB.T C# loader gap, real scenery still baked) → `oracles/_unloadable-landblocks.txt`; they're NO_ORACLE in Phase 7. NOTE: `gen-oracles.mjs` ignores WB.T stdout so failures are silent — caught via file-set vs census diff (patch worth doing). |
| **7 Verify sweep** | ⏳ **METHODOLOGY BUILT + VALIDATED (outdoor + dungeon); full run pending.** Stack UP (ACE udp 9000/9001 = same DATs as bake+oracle; wsbridge ws:8080; serve.py:8765; MariaDB). Account blocker DISSOLVED (224 pool `dev-account-pool.txt`, password==name). verify-sweep.mjs (UNCOMMITTED) = COMBINED surface+interior verifier with `--accounts=<file>`: per-LB class (outdoor/dungeon/mixed); OUTDOOR=runAll vs surface-only oracle (NO_ORACLE-null + teleport-retry + scenery-race fixes); INTERIOR=teleport into EnvCell + POLL per-LB cellContainers3d census vs interior.cellCount (poll NOT fixed-wait — heavy all-at-once build stretches under contention). **Pilot5 (149 LBs, 3 agents): dungeon 10/10 PASS, outdoor 89/106, mixed 20/33 (all 11 mixed DRIFT on the surface axis; interiors clean). Residual DRIFT = GENUINE Phase-8 surface findings, not artifacts.** Probes smoke-login.mjs + interior-probe.mjs. **TO RUN (one combined sweep, all 40,197): `verify-sweep.mjs --agents=3-4 --lbs=content-landblocks.txt --oracles=.../oracles --settle=15000 --accounts=dev-account-pool.txt` — RESTART ACE FIRST (cache→OOM; pilot5 hit avail 393Mi) + periodic restarts; ~20-60h resumable.** OPEN: NO_DROP (~6% mixed — dungeons w/ cells but no interior object for a drop point → precompute drops from landblock_instance). |
| 8 Repair | ⏭ route DRIFT through `ring-diagnose-repair-playbook.md`. |

## Commits (master, **PUSHED** to origin/master through `6e138399`, 2026-06-01)
- `6926ea75` P0–1: landblock-census bin + scenery bake 100% ACE parity hardening.
- `ab2fbe18` P2a: plumb scenery channel into init3D (index.html).
- `af22fb3b` P3: verify-loop scripts (gen-oracles.mjs, verify-sweep.mjs).
- `d7ef1c3e` P3 tighten: exclude Generic(weenieType=1) weenies from verdict.
- `6e138399` P3 tighten: __diag placements diff reconcile LandblockInfo objects.
Working tree has untracked junk only (`.claude/worktrees/`, `external/holtburger/08000001.bin`, `scripts/multi-agent/node_modules` — do NOT commit).

## CRITICAL mechanics (hard-won — do NOT re-discover)
- **@teleloc cell MUST be `0xLLLL0000`** (cell-0 = landblock; ACE resolves the LandCell from x,y). `0xLLLL0001` (a specific corner LandCell) + a center position is a mismatch and the teleport silently no-ops.
- **`@god` is MANDATORY** before teleporting: `@teleloc <cell> 96 96 500` drops the player at 500m → they FALL → without invulnerability they die + recall to the Academy (`0x8602`), corrupting the sweep. `@god` is AccessLevel.Sentinel; Dev(4) accounts clear it. Send via `window.__sessionHandle.sendChat("@god")`.
- **Live-ACE entities STREAM ~15–20s** after teleport (51→98 npcs over 7→20s) → settle ≥15s.
- **ESM `import "playwright"` ignores `NODE_PATH`** → `.mjs` tools must live in `external/holtburger/scripts/multi-agent/` (has `node_modules/playwright`). `.cjs` probes use `NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules` fine. Chromium: `~/.cache/ms-playwright`; launch with `--use-gl=swiftshader` (no GPU).
- **Wire-agent boot URL**: `?renderer=3d&quality=low&agentic=low&eagerDungeons=on&hud=none&plugins=none&diag=1&nosw=1&renderOnDemand=1&autoLogin=1&account=<a>&password=<a>&autoSpawn=first&kickDance=1&server_host=127.0.0.1&server_port=9000&bridge_url=ws://127.0.0.1:8080/`. Wait for `window.__bootState==="ready"` (NOT "in-world"). `?nosw=1` dodges stale service-worker cache.
- **Dev accounts** (accessLevel≥4, password==name): `acadmp1ge522`, `holt`, `mombonumber5` (4), `smoketest1` (5). `acadmp1ge522` is confirmed to have a character (others unverified — for multi-agent parallelism, confirm/create chars). NOTE: acadmp1ge522 is currently *saved* in a dungeon (`0x000102c7`) from a 2b probe; first teleport moves it out.
- **WB.Terminal**: `DOTNET_ROOT=/home/wbterminal/.dotnet $DOTNET_ROOT/dotnet /home/wbterminal/WorldBuilder-ACME-Edition/WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll --stdin`; first command `{"command":"load","path":"/home/wbterminal/projects/RetailSmoke/RetailSmoke.wbproj"}`; `dump-lb-expectations` lbX/lbY are **DECIMAL** 0-254; pass `sceneryBakeDir`/`eventsBakeDir` = `/mnt/wbterminal2/holtburger-dist/{scenery,events}/`.
- **Verdict semantics** (in verify-sweep + __diag placements diff): generators (weenieType=1) excluded from "expected render"; LandblockInfo loose objects reconciled by count (sceneryCount). Remaining DRIFT = genuine `npc-not-rendered` (real gap OR dynamic generator-spawned creature, e.g. "Drudge Skulker") — classify per-case; if widespread in Phase 7, refine via the diag.js 5-mode spawns classifier (tolerate "wire-never-received" generator-managed).

## OOM protections (8GB box — DOES OOM; protect every build/run)
Stack is ACTIVE (see memory `reference_oom_protection_stack_2026-06-01`): earlyoom (avoids `claude`, prefers killing `cargo/rustc/chrome`), zram zstd 50%, oom_score cron (claude=-900). **Bound every cargo build: `cargo build --release --jobs 1` + `nice -n 19`.** Snapshot `free -h` before/after heavy runs. All Phase 0–3 runs held flat (avail ≥3.3G). The Phase-4 parallel bake is the next memory test — shard conservatively + monitor.

## Live stack
serve.py (`:8765`, 127.0.0.1) + ACE (udp 9000/9001) + wsbridge (`ws:8080`) were UP this session; ACE swap had crept to ~1.9G (landblock cache). **For Phase 4 (DAT-only bake) the stack is NOT needed — tear it down to free ~1.5G + clear swap.** Bring-up for Phase 7 (per `ace-local-setup.md`):
- serve.py: `python3 external/holtburger/scripts/serve.py --port 8765 --bind 127.0.0.1` (background).
- ACE: `cd ~/ace-server/Source/ACE.Server/bin/x64/Release/net10.0 && ACE_NONINTERACTIVE_CONSOLE=true ~/.dotnet/dotnet ACE.Server.dll < /dev/null` (background; ready ~10-15s, watch log for "World is now open"). MariaDB must be up (`mariadbd-safe`).
- wsbridge: `external/holtburger/target/release/holtburger-wsbridge --listen 127.0.0.1:8080` (NEW flags — destination announced by the WS handshake; do NOT pass --ace-host/--ace-login-port).

## Artifacts (scratch — regenerable; on /mnt to dodge the disk trap)
- Census: `/mnt/wbterminal1/tmp/claude-scratch/census-2026-05-30/{content-landblocks.txt (40,197), dungeon-landblocks.txt (3,409)}`.
- Oracles (9 ring + 0xA3AE): `/mnt/wbterminal1/tmp/claude-scratch/oracles/`.
- Parity harness: `/mnt/wbterminal1/tmp/claude-scratch/parity-bits/` (compare-bits.py + the `--bits` rust/cs dirs). Re-check parity after any bake change.
- Debug probes: `/mnt/wbterminal1/tmp/claude-scratch/probe_{scenery_inworld,teleloc_dungeon,teleport_debug,drift_detail}.cjs`.
- Sweep matrices: `/mnt/wbterminal1/tmp/claude-scratch/verify-sweep/`.
- Bake/dist root: `$HOLTBURGER_DIST=/mnt/wbterminal2/holtburger-dist` (single root; serve.py auto-binds the `dist` symlink).

## NEXT — Phase 4–5 (full-world scenery bake), concrete steps
1. **Tear down ACE + wsbridge** (free RAM). Keep serve.py if convenient.
2. **`scenery-bake` is serial, NO `--parallel` flag** (`scenery-bake.rs`). It takes `--landblocks @<file>`. To use the 40,197-LB list in parallel: split `content-landblocks.txt` into N chunks (N ≈ cores-2, watch RAM — each process opens its own `DatDatabase`, ~1GB) and run N `scenery-bake --dat-dir ~/ac_base_dats --landblocks @chunk_k --out $HOLTBURGER_DIST/scenery --mode ace-compat` concurrently (`nice`). Each emits `0xLLLL.scenery.jsonl` + `.sha256`. Determinism + 100%-ACE-parity (≤1-ULP rotation) already validated.
   - Optional rigor: add a real `--parallel N` flag to scenery-bake (rayon over the per-LB loop; the bake is embarrassingly parallel — `ring-expansion-method.md §6`). ~50 LOC.
3. Confirm shards/terrain/EnvCells already cover the world (885,155 shards = whole DAT; verified) — no shard re-bake needed.
4. Stage to `$HOLTBURGER_DIST/scenery` (already the served root). Watch disk (memory `project_holtburger_bake_disk_trap`): ring 169 LBs = 4.2MB → ~40k LBs ≈ ~1GB scenery JSONL.
5. **Phase 6**: `node scripts/multi-agent/gen-oracles.mjs --lbs=content-landblocks.txt --out=<oracleDir>` (batch; WB.Terminal one load). For dungeons, also `pvs-visibility-snapshot`.
6. **Phase 7**: bring up the ACE stack; `node scripts/multi-agent/verify-sweep.mjs --agents=N --lbs=content-landblocks.txt --oracles=<oracleDir> --settle=15000`. Needs N Dev accounts each with a character (only acadmp1ge522 confirmed — create more or rotate). ~15s/LB single-agent → parallelize. Skip ocean (not in content list). Output: per-LB PASS/DRIFT/INFRA matrix → Phase 8 repair via the ring-diagnose playbook.

## Open refinements (non-blocking)
- scenery-bake `--parallel N` flag (for the world bake throughput).
- verify-sweep multi-account char provisioning (parallelism).
- Verdict: if dynamic generator-spawned creatures are widespread DRIFT in Phase 7, tolerate them via the 5-mode spawns classifier.
- (Rigor) oracle could emit LandblockInfo objects as a position list (not just sceneryCount) for position-matching instead of count-reconciliation.
- (Done) The 5 commits are pushed to origin/master @ `6e138399`. This handoff doc itself is uncommitted on disk.

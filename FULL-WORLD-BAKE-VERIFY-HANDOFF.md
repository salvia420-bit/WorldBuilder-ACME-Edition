# Full-World Bake + Verify — HANDOFF (2026-06-01)

Mission: take the AC renderer from the 169-LB Holtburg ring to **all of Dereth** —
bake every content landblock's scenery, then **verify each one client-side** against
a live ACE server (no GPU), one landblock at a time.

**Status: Phases 0–6 DONE. Phase 7 (verify) methodology BUILT + VALIDATED. The
full-world verify run is READY TO KICK OFF (deferred) — it is fully resumable.**

Deeper running log (richest source): memory
`~/.claude/projects/-home-wbterminal/memory/project_holtburger_full_world_bake_verify_2026-05-30.md`.
Phased plan: `docs/full-world-bake-and-verify-plan-2026-05-30.md`. Earlier handoff:
`docs/full-world-bake-verify-HANDOFF-2026-06-01.md`.

---

## TL;DR — where things stand

| Phase | State |
|---|---|
| 0 Census | ✅ 40,197 content LBs (`content-landblocks.txt`) + 3,409 dungeons. |
| 1 100% ACE parity | ✅ scenery bake: position+scale bit-exact, rotation ≤1 ULP. Committed. |
| 2 Prereqs | ✅ scenery plumb-fix in-world; `@teleloc` reaches dungeon interiors. |
| 3 Verify-loop infra | ✅ gen-oracles.mjs + verify-sweep.mjs. Committed. |
| **4–5 World scenery bake** | ✅ **DONE.** All 40,197 LBs baked to `dist/scenery` (~3.13M placements, 58s, byte-parity). Published + serving. |
| **6 World oracles** | ✅ **DONE.** 40,187/40,197 oracle JSONs (845MB). 10 unloadable by WB.Terminal (documented). |
| **7 Verify methodology** | ✅ **BUILT + VALIDATED** (outdoor + dungeon + mixed). The full run is the only thing left to execute. |
| 8 Repair | ⏭ triage the DRIFT (real surface npc/scenery gaps) the sweep finds. |

**Everything baked/generated is on disk and serving. The remaining work is to run
the ~40-hour verify sweep, then triage its findings.**

---

## HOW TO KICK OFF THE FULL VERIFY RUN (later)

### 1. Bring the live stack up
```bash
# MariaDB (system; usually already up)
pgrep -x mariadbd >/dev/null || sudo mariadbd-safe &

# ACE server — MUST be freshly started (its landblock cache is the main RAM hog)
cd ~/ace-server/Source/ACE.Server/bin/x64/Release/net10.0
ACE_NONINTERACTIVE_CONSOLE=true setsid nohup ~/.dotnet/dotnet ACE.Server.dll </dev/null \
  > /mnt/wbterminal1/tmp/claude-scratch/ace-2026-06-01.log 2>&1 &
# wait for "World is now open" (~15-20s); UDP 9000/9001 will be listening

# wsbridge (NEW flags — destination announced by the WS handshake; do NOT pass --ace-host)
~/WorldBuilder-ACME-Edition/external/holtburger/target/release/holtburger-wsbridge --listen 127.0.0.1:8080 &

# serve.py (static dist server on :8765)
python3 ~/WorldBuilder-ACME-Edition/external/holtburger/scripts/serve.py --port 8765 --bind 127.0.0.1 &
```

### 2. Launch the self-sustaining driver
```bash
bash /mnt/wbterminal1/tmp/claude-scratch/worldsweep-driver.sh   # detach with setsid nohup ... &
```
The driver loops: **restart ACE fresh → run `verify-sweep.mjs` for one chunk (resumes
from state) → clean browsers → repeat** until all 40,197 LBs have a verdict. It bounds
ACE's cache + per-agent memory. Current settings inside the script: `AGENTS=4`,
`CHUNK_SECS=1800` (30 min). **4 agents is the stable ceiling on this 8GB/4-core box**
(see RAM note below).

### 3. Monitor / control
- **Progress**: `find /mnt/wbterminal1/tmp/claude-scratch/verify-sweep/state-worldsweep -name '*.json' | wc -l` / 40197
- **Driver log**: `tail -f /mnt/wbterminal1/tmp/claude-scratch/worldsweep-driver.log`
- **Pause**: `pkill -f worldsweep-driver.sh` then `pkill -x node`  → **Resume**: re-run the driver (skips done LBs).
- **Final matrix**: written to `verify-sweep/worldsweep-<TS>/matrix.json` when the queue drains
  (or aggregate from the state dir anytime).

The run is ~40h at 4 agents, resumable; expect to babysit RAM/ACE only loosely (the driver handles it).

---

## The verify tool — `external/holtburger/scripts/multi-agent/verify-sweep.mjs`

A fleet of headless wire-agents (one Chromium, N pages) each logs into live ACE once,
then pulls LBs off a shared queue and verifies each. **Per-LB it classifies by oracle
content and runs the applicable checks:**

- **Surface** (buildings / baked scenery / surface npcs, `cell < 0x100`): `@teleloc`
  to the outdoor cell `0xLLLL0000`, settle, `__diag.runAll` vs a **surface-only**
  oracle (interior npcs filtered out — they can't render from outdoors).
- **Interior** (`oracle.interior.cellCount > 0`): `@teleloc` INTO an EnvCell (drop
  point = an interior npc's `cell` + `x/y/z`), then **poll the per-LB cell-graph
  census** (`cellContainers3d` keys where `cid>>>16 == lb`) until it reaches
  `interior.cellCount`. Structural — entities are PVS-limited from one drop point,
  so we verify the cell graph loaded, not every entity.
- **Class** = `outdoor` (surface only) / `dungeon` (interior only) / `mixed` (both).
  Combined verdict = worst-of.

**Args:** `--agents=N --settle=15000 --lbs=<file|csv> --oracles=<dir>
--accounts=<file> --label=<name> [--state=<dir>] [--fresh]`.

**Resumability:** writes one `state-<label>/<hex>.json` per **trustworthy** verdict as
it goes. On (re)launch it loads the done-set, skips them, verifies only the rest. ERR
and pure TELEPORT_MISS are **not** persisted (transient → retried). A dungeon that
arrives but loads **0 cells** is treated as contention (not a gap) → retried.

**Boot mode (important):** the PRESET uses **`wireframe=1`** (wire-agent mode —
MeshBasicMaterial, skips atmosphere/composer/clouds/CSM/terrain-shader). The scene
graph `__diag` reads still fully populates; this skips the heavy software-GL rendering.
Do NOT add `nullRender=1` (it under-populates the surface graph → false DRIFT).

### Pilot results (validated the methodology)
- Outdoor 98-LB pilot: **89/98 PASS**, 0 miss; residual DRIFT = genuine npc/scenery gaps.
- Combined 149-LB pilot: dungeon **10/10 PASS** (exact cell counts), mixed interiors all clean.
- The remaining DRIFT is **real Phase-8 signal** (surface npc/scenery gaps), not artifacts.

---

## Key facts / gotchas (hard-won)

- **Account pool DISSOLVED the "only-1-account" blocker:** the ACE DB already has
  **224 accessLevel-4 accounts WITH characters** (auto-created by prior runs;
  `password == accountName`). Harvested to
  `/mnt/wbterminal1/tmp/claude-scratch/world-oracles-2026-06-01/dev-account-pool.txt`.
- **@teleloc cell MUST be `0xLLLL0000`** for outdoor (cell-0 = landblock; ACE resolves
  the LandCell from x,y). `@god` is MANDATORY before teleporting (the 500m drop kills
  un-invulnerable players → recall to lifestone, corrupting the sweep).
- **RAM ceiling ≈ 4 agents** on this 8GB/4-core box. Each agent's scene data
  (meshes/cells) is ~1GB and is needed regardless of render mode — so wireframe helps
  CPU (boots, no thrash), NOT the RAM ceiling. 8 agents OOMs hard; 5 dips to ~415MiB.
- **ACE cache is the other RAM hog** — it grows as agents teleport the world. The
  driver restarts ACE every 30 min to bound it. NEVER launch the sweep on a stale ACE
  (RSS >~1GB) — it OOMs in minutes.
- **DAT consistency:** bake (`~/ac_base_dats`), oracle (`RetailSmoke/dats/base`), and
  live ACE all use **byte-identical DATs** (sha256-verified) — end-to-end consistent.

---

## Artifacts on disk (scratch — regenerable)
- **Census**: `/mnt/wbterminal1/tmp/claude-scratch/census-2026-05-30/{content-landblocks.txt (40,197), dungeon-landblocks.txt (3,409)}`
- **World scenery bake** (served): `$HOLTBURGER_DIST=/mnt/wbterminal2/holtburger-dist/scenery/` (40,197 `0xLLLL.scenery.jsonl` + `.sha256`)
- **World oracles**: `/mnt/wbterminal1/tmp/claude-scratch/world-oracles-2026-06-01/oracles/` (40,187 JSON, 845MB) + `dev-account-pool.txt` + `_unloadable-landblocks.txt`
- **Driver**: `/mnt/wbterminal1/tmp/claude-scratch/worldsweep-driver.sh`
- **Pilot matrices**: `/mnt/wbterminal1/tmp/claude-scratch/verify-sweep/{pilot2-outdoor,pilot5-combined,...}-<TS>/matrix.json`
- (State dir `state-worldsweep` was cleared — the real run starts fresh with the final fixed code.)

---

## Open items (Phase 8 = triage the verify findings)
1. **Run the full sweep** (above), then route DRIFT through `ring-diagnose-repair-playbook.md`.
   The DRIFT is genuine surface npc/scenery render gaps — classify real-gap vs
   dynamic-generator-spawned-creature (tolerate the latter).
2. **10 NO_ORACLE LBs** (WB.Terminal can't load them; `oracles/_unloadable-landblocks.txt`)
   — visited but unverifiable; classify separately.
3. **NO_DROP dungeons** (~6% of mixed — interior cells but no object to anchor a drop
   point, e.g. 0x8303) — precompute drop points from `ace_world.landblock_instance`,
   or emit `interior.dropPoint` in gen-oracles.
4. (Optional) make ERR/contention auto-recovery tighter; consider a 2nd box (1070/R9-290)
   for real extra agent parallelism beyond this box's 4-agent RAM ceiling.

---

## Committed in this effort
Phases 0–3 are on `origin/master` (`6926ea75`…`6e138399`). This commit adds the Phase
4–7 verify work: the combined `verify-sweep.mjs` (surface+interior, resumability,
wireframe, all fixes) + the diagnostic probes (`smoke-login.mjs`, `interior-probe.mjs`,
`mode-test.mjs`) + handoff docs. The bake output + oracles are scratch artifacts (not
committed).

# World Completeness — Refresh & Buildbox Full-World Run Plan (2026-06-13)

Re-grounds the four `*-completeness-method.md` docs (dated 2026-05-23/24) against the
**current** codebase, after (a) the full WorldBuilder.Terminal command review + bug fixes
(`docs/terminal_command_fidelity_audit_2026-06-10.md`, 205 cmds / 243 findings) and (b) the
client **unification** refactor (2026-06-11/12, `?singleDriver` / `?unifiedDispatch` + the
renderer-neutral cores). Written for a **buildbox** session that will run the full-world
bake + verify on 18 cores. Source of truth for "where the world bake actually is."

## TL;DR — the method is FURTHER ALONG than the 05-24 docs say

The 05-24 docs describe a **13×13 ring around Holtburg (shipped 2026-05-14)**. That status is
stale. The machinery advanced past it:

- **Scenery bake = WHOLE WORLD, done.** 40,197 LBs, 3.13 M placements, ~921 MB, `2026-06-01 09:41 UTC`,
  `ace-compat` mode (bit-equivalent to `ACE.Server.Entity.Scenery.Load`). Lives at
  `/mnt/wbterminal2/holtburger-dist/scenery/` (`0xLLLL.scenery.jsonl` + `.sha256` pairs).
  `bake-source.sha256` records the DAT hashes + tool versions.
- **Oracles = WHOLE WORLD, done** (but pre-06-10). 40,187/40,197 generated via WB.Terminal
  `dump-lb-expectations`, `2026-06-01`, at `/mnt/wbterminal1/tmp/claude-scratch/world-oracles-2026-06-01/oracles/`
  (845 MB, scratch — NOT committed; 10 LBs unloadable, documented).
- **Account pool**: 224 dev accounts (accessLevel 4, password == account name) at
  `…/world-oracles-2026-06-01/dev-account-pool.txt`.
- **Verify infra**: coded + pilot-validated, ready for the full sweep (~40 h @ 4 agents on the laptop;
  the buildbox's 18 cores change that math):
  `scripts/multi-agent/verify-sweep.mjs` (sweep), `gen-oracles.mjs` (oracle gen),
  `/mnt/wbterminal1/tmp/claude-scratch/worldsweep-driver.sh` (driver — NOT committed).

## What changed under the docs (and didn't break)

- **WB.Terminal oracle commands reviewed + fixed 2026-06-10.** Tool at
  `WorldBuilder-ACME-Edition/WorldBuilder.Terminal/`, driven via `--stdin` JSON (one obj/line).
  - `dump-lb-expectations` (`JsonCommandProcessor.cs:1689`) — args `lbX,lbY` + optional
    `out`/`sceneryBakeDir`/`eventsBakeDir`. F54/F56 fixed: write outcome now machine-visible
    (`outWritten`/`outError`), args documented. Output schema: `npcs[]`, `buildings[]`,
    `bakedScenery[]`, `events[]`, `interior{cellCount,…}`, `counts{}`.
  - `pvs-visibility-snapshot` (`JsonCommandProcessor.cs:4845`) — args `cellId` (full 32-bit) +
    `bfsDepth?`. F173/F182 fixed: **strict cell-ID parser** (`ParseCellIdScalarStrict`,
    `:4893`) rejects short-form hex / landblock suffixes; missing root → `success:false`.
- **Client world-verification `__diag` surfaces SURVIVED the unification** (confirmed firing on
  DEFAULT *and* `?unifiedDispatch=on&singleDriver=on`):
  - `__diag.placements.walk/diff(lbId)` — read-only scene-graph walker (no hook; reads
    `liveScene3d.{staticsGroup,buildingsGroup,entitiesGroup}`).
  - `__diag.pvs` — hook at `cells.js:980` (`onCellTick`, unconditional).
  - `__diag.wire` — hooks at `index.html:9501` (ClientEvent) + `loop.js:1993` (`_wireDiagTap`,
    shared by both flag paths) + `loop.js:2408/2721`.
  - `__diag` spawn lifecycle — `entities.js:2663/2671/3459`.
  - `__diag.runAll(lbId)` aggregates them. The per-LB loop (autoLogin→teleport→`runAll`→logout
    vs oracle) works unchanged. **No client work needed for verification.**
  - NB: the movement/combat surfaces (`motion`, `combat`, "sticky melee") are a *different*
    subsystem and irrelevant to world verification — ignore them.

## Gaps to close BEFORE a buildbox full-world run

1. **Regenerate oracles** — the 06-01 set predates the 06-10 WB.Terminal fixes (schema +
   strict parsing changed). Re-run `gen-oracles.mjs` against current WB.Terminal into a new
   dated dir. Also re-confirm DAT hashes vs `bake-source.sha256`.
2. **De-hardcode paths for the buildbox** (these assume THIS laptop and WILL break on the GCE box):
   - `worldsweep-driver.sh`: `ACEDIR=…/ace-server/…/net10.0`, `DOTNET=~/.dotnet/dotnet`,
     `SWEEPDIR=…`, scratch log paths. **And commit it** (currently scratch-only → won't ride git).
   - `gen-oracles.mjs:16`: WB.Terminal `net8.0` dll absolute path (no fallback/auto-detect).
   - `validate_landblock_completeness.cjs:81`: hardcoded `out` path.
   - Prefer env vars (`$ACE_DIR`, `$WBT_DLL`, `$DOTNET`) + sane fallbacks.
3. **Parallelize `scenery-bake`** (`apps/holtburger-tools/src/bin/scenery-bake.rs`) — no
   `--parallel` today (documented open follow-on). To use 18 cores: split the LB list into N
   chunks, spawn N processes (each opens its own read-only `DatDatabase`). This is the single
   change that puts the buildbox cores to work on the bake itself.
4. **Full-world spawn staging** — `stage-ring-spawns.py` only staged the **169-LB ring**
   (2026-05-23). Full world needs the whole `ace_spawn_records.jsonl` (365,183 records) staged
   per-LB to `$HOLTBURGER_DIST/spawns/`.
5. **Interior drop-points** — ~6% of mixed dungeons lack an interior NPC to anchor a teleport
   (e.g. 0x8303), so their interior cells can't be reached/verified. Precompute drop coords
   (from ACE `landblock_instance`) and emit `interior.dropPoint{cellId,x,y,z}` into the oracle.

## Buildbox prerequisites (your side)

- `git pull` to HEAD (unified pipeline + WB.Terminal fixes + this doc).
- Build: WB.Terminal (`dotnet build -c Release` → currently `net8.0`), `scenery-bake`/`event-bake`
  (`cargo build -p holtburger-tools --release`), the wasm client if verifying a fresh build.
- **DATs present** on the buildbox (`~/ac_base_dats/` or the RetailSmoke mirror) — bake inputs.
- **ACE running on the buildbox** (`net10.0`) for the live verify sweep's wire-agents to log into.
- `$HOLTBURGER_DIST` set (default `/mnt/wbterminal2/holtburger-dist` — buildbox path will differ).

## Run sequence (once prereqs + gaps 1–3 are addressed)

1. `scenery-bake` (parallelized) → `$HOLTBURGER_DIST/scenery/` + `bake-source.sha256`.
2. `event-bake` → `$HOLTBURGER_DIST/events/`. Full-world spawn staging → `$HOLTBURGER_DIST/spawns/`.
3. `gen-oracles.mjs` (current WB.Terminal) → dated oracle dir.
4. `verify-sweep.mjs` (agents scaled to buildbox cores/RAM — note the laptop's 8 GB→3-agent clamp
   at `verify-sweep.mjs:62` won't bind on a big box) → per-LB verdicts; resumable state per LB.
5. Triage DRIFT/MISS per the ring-diagnose-repair-playbook; re-run dirty LBs.

## Layered, separate: the render-cache (perf #2)

The draw-call/perf fix (≈1000 draws, per-mesh buildings + EnvCells) is a **derived render cache**
compiled FROM these verified placements — NOT a change to the placement bake (which must stay
explicit/diffable per the completeness contract). Bake it on the buildbox as a separate step
(per-LB geometry merged by model+material, static parts only; doors/NPCs/recolorables stay
per-object). Do this AFTER the placement bake + verify are green.

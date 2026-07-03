# HANDOFF — Terrain reconciliation + Gate-1 offline net (2026-06-21)

Status: **SHIPPED to `origin/master` (salvia420-bit, NOT upstream/Vanquish-6).**
3 commits, all validated offline. `pkg/` is gitignored (rebuild on deploy).

| commit | scope |
|---|---|
| `893dc61f` | terrain fidelity: per-cell split diagonal (C-1) + `terrain_normal_at` + live textures (C-2) + C-3/C-4 + golden-vector anchor |
| `38f25afe` | WB.Terminal: full `get-region` (T-1) + new `get-terrain-textures` (T-2) |
| `70b0a4f1` | gate1: offline completeness net — scenery/statics/spawns, no browser (G1/G2/G3) |

Deep detail lives in memory: `project_terrain_reconciliation_2026-06-20.md`,
`project_gate1_offline_completeness_net.md`, and the report
`/mnt/wbterminal1/tmp/claude-scratch/terrain-recon/RECONCILIATION.md`.

---

## 1. What was reconciled + fixed (terrain)

The terrain DATA is faithful end-to-end (bit-layout, height table, 9x9 grid +
seams, and the TexMerge painting ALGORITHM all agree across decomp / DAT / ACE /
client). Four real issues were found; all fixed:

- **C-1 (HIGH, was the only rendered-fidelity break):** base render mesh + both Z
  queries used ONE fixed SW->NE triangle diagonal; retail picks per-cell via the
  AC2D hash. Now uses `holtburger_dat::terrain_subdiv::cell_swto_ne_cut` via a
  shared `triangle_height_in_cell` helper, behind default-on `USE_RETAIL_SPLIT_DIR`
  (compile-const, mirrors `USE_TRIANGLE_TERRAIN_Z`). Sites:
  `apps/holtburger-web/src/lib.rs` `build_mesh` + `terrainHeightAt` export;
  `crates/holtburger-world/src/state/types.rs` `terrain_height_at` + `terrain_normal_at`.
- **C-2 (latent):** `fetch_terrain_textures` (lib.rs) now live-walks the Region for
  base SurfaceTexture ids; frozen `RETAIL_TERRAIN_SURFACE_TEXTURES` is a fail-soft
  fallback. Byte-identical on stock Dereth (verified), correct on modified Regions.
- **C-3/C-4:** stale texMerge "Default OFF" docblock corrected (it's default-ON);
  `TerrainEntry` documented as NOT the DAT 16-bit word.
- **RC-2/RC-3 → T-1/T-2:** `get-region` was the "EMPTY" the user saw (6 keys);
  now 20 keys. New `get-terrain-textures` exposes the TexMerge chain
  (TexGID->0x05->0x06). WB.Terminal C# in `WorldBuilder.Terminal/`.

Authoritative terrain facts (verified vs ACE `CellLandblock.cs` + decomp + our
`landblock.rs`): 16-bit terrain word — **Road `&0x3`>>0 (2 bits)**, Type
`&0x7C`>>2, Scenery `&0xF800`>>11; **Height is a SEPARATE byte array**, not in the
word. (A Discord message proposing a 32-bit Height/Texture/Scenery/Encounters/
Road3/Flags packing is a DIFFERENT/non-DAT structure — do not adopt it.)

---

## 2. Gate-1 offline net — architecture + how to run

Offline, provenance-honest verification (no browser, seconds). Lives in
`scripts/gate1/`. Three independent legs; the frozen 2026-06-01 snapshot is now
used ONLY by the explicitly-labelled scenery-regression leg.

Prereqs: `dat-tool` built (`external/holtburger/target/debug/dat-tool`),
WB.Terminal built (`WorldBuilder.Terminal/bin/Release/net8.0/`), mariadb up
(`ace/ace@127.0.0.1 ace_world`), `~/ac_base_dats/client_cell_1.dat`,
`projects/RetailSmoke/RetailSmoke.wbproj`. Use `capped-build` for any rebuild.

```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition
RING=scripts/gate1/holtburg-ring.txt   # 182 LBs

# SCENERY — bake vs C# cross-check (independent) + frozen snapshot (regression)
node scripts/gate1/diff-completeness.mjs --ring $RING \
  --bake-dir /mnt/wbterminal2/holtburger-dist/scenery \
  --oracle-dir /mnt/wbterminal1/tmp/claude-scratch/world-oracles-2026-06-01/oracles \
  --legs scenery-regression --out /mnt/wbterminal1/tmp/claude-scratch/gate1/report
#   (add --crosscheck-dir <C# scenery-cross-check out> + --legs scenery-independent
#    for the genuinely-independent scenery leg; tool: tools/scenery-cross-check)

# STATICS (G2) — ALL LandblockInfo objects incl the ~720 loose ones
node scripts/gate1/statics-parity.mjs --ring $RING \
  --cell-dat ~/ac_base_dats/client_cell_1.dat \
  --project /home/wbterminal/projects/RetailSmoke/RetailSmoke.wbproj \
  --out /mnt/wbterminal1/tmp/claude-scratch/gate1/statics-report.json
#   last run: 766/766 objects matched, 44/45 LBs PASS

# SPAWNS (G3) — live ACE landblock_instance vs staged jsonl (snapshot-free)
node scripts/gate1/spawns-parity.mjs --ring $RING \
  --spawn-source /home/wbterminal/projects/RetailSmoke/ace_spawn_records.jsonl \
  --out /mnt/wbterminal1/tmp/claude-scratch/gate1/spawns-report.json
#   last run: 1691/1691 spawns matched, 54/54 LBs PASS
```

Result so far (Holtburg ring): spawns 419/419 (G1 precision fix) → live 1691/1691
(G3); statics 766/766 (G2). One real finding: **`0xA7B3` is a WB.Terminal/
DatReaderWriter loader gap** — `list-objects` returns 0 but holtburger-dat reads
19 real objects (the client is the more-complete parser; same LB missing from the
2026-06-01 snapshot; one of ~10 WB.T-unloadable LBs).

---

## 3. Open / next items (none blocking)

1. **Wire `run-gate1.sh` to orchestrate all three gates** in one command (it
   currently predates statics-parity/spawns-parity). Small.
2. **Run the net full-world** (not just the 182-LB Holtburg ring) — point `--ring`
   at `/mnt/wbterminal1/tmp/claude-scratch/census-2026-05-30/content-landblocks.txt`.
   statics/spawns are fast; scenery-independent needs the C# cross-check generated
   first (heavy dotnet — parallelize).
3. **C-1 1070 real-GPU eye-test** (saddle-bow flip + sink=0) — WAIVED by user;
   swiftshader can't validate shape. Batch on the 1070 when the `:9333` chrome is
   back (per the "1070 eye-tests BATCHED" rule).
4. **Release `pkg/` for deploy** — current `pkg/` is a `--dev` (debug, 17.5MB) build
   from validation. For a real deploy run `wasm-pack build --target web --out-dir
   pkg` (release; needs `PATH=$HOME/.cargo/bin` so its internal `cargo metadata`
   resolves) — heavier (wasm-opt), use `capped-build`.
5. **Regenerate the WB.Terminal world oracle** (the 2026-06-01 snapshot predates
   the 2026-06-10 WB.T fixes) if you want the scenery-regression leg current.

---

## 4. Gotchas that cost real time (read before touching the gates / builds)

- `execFileSync` runs NO shell → leading `~` is NOT expanded. Expand in JS.
- JS `(x >>> 0) | 0` RE-SIGNS the 32-bit value negative → `toString(16)` emits a
  bogus `"-564c0000"` id. Use `(lb<<16)>>>0` with NO trailing `| 0`.
- `list-objects` coords are **WORLD frame + rounded 2dp**; dat-tool `--objects-jsonl`
  is **LOCAL frame + f32**. Lift client local→world (`wx=lbX*192+px`) and match @2cm.
- WB.Terminal echoes the input command on stdout (also contains
  `"command":"list-objects"`) → filter responses by presence of a `landblock` field.
- C# `$"0x{LbKey:X4}"` is `0x`+UPPER-hex; do NOT `.toUpperCase()` the whole string
  (makes `0X…`, breaks key match).
- `wasm-pack` needs `PATH=$HOME/.cargo/bin` (internal `cargo metadata`).
- `serve.py` serves the holtburger ROOT → the app URL is
  `http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&...` (nosw mandatory).
- ACE world DB: `mysql -uace -pace -h127.0.0.1 ace_world`; `landblock_instance`
  cols: landblock (VIRTUAL int 0xLLLL), weenie_Class_Id, obj_Cell_Id,
  origin_X/Y/Z (LOCAL), angles_*, is_Link_Child; 365,183 rows.
- 8GB box: never `cargo build/test --workspace`; use `capped-build` (3.5G cgroup);
  reclaim stale LSP/`tsserver` procs if `free` is tight (they respawn on demand).

---

## 5. Push hygiene (for the next commit)

- Remotes: `origin` = salvia420-bit (PUSH HERE), `upstream` = Vanquish-6 (DO NOT),
  `box` = buildbox SSH. `gh` is authed as salvia420-bit (https token, repo scope).
- There are MANY pre-existing untracked files in the tree that are NOT this work
  (handoffs, probes, `harness/`, `examples/`, `crates_probe_anim_dist.rs`). Stage
  explicit paths — never `git add -A`.

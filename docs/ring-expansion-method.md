# Ring Expansion Method

How to take the 169-LB Holtburg ring and grow it — to a wider ring, to a new town, or eventually to whole Dereth (256×256 = 65,536 LBs) — as a **one-shot batch**: bake → stage → diagnose → ship, with the multi-agent fleet doing the per-LB verification in parallel.

Pairs with [`world-completeness-method.md`](world-completeness-method.md) (the placement contract), [`event-completeness-method.md`](event-completeness-method.md) (events), and [`ring-diagnose-repair-playbook.md`](ring-diagnose-repair-playbook.md) (the diagnose-loop this references when something goes wrong).

Status: live 2026-05-23. Covers the 3-CLI bake stack + per-LB sha256 sidecars (Wave-4.B) + multi-agent fleet harness + `window.__diag` 10-surface layer.

---

## 1. The goal: "one shot"

A single operator command — call it `bake-region 0xLO..0xHI` — should produce, for the range provided, a complete deployable bundle: scenery JSONL, events JSONL, spawns JSONL, sha256 sidecars per file, dist-tree staged, validators run, and a green CI gate. Idempotent (re-run = no work if inputs unchanged) and deterministic (re-run = byte-identical outputs).

That command **does not yet exist** as a single entry point. Today the workflow is four-step (three CLIs + an rsync + a validator run), with no orchestrator wrapping them. This doc tells you (a) the recipe to drive the four steps manually today, (b) the proposed shape of the orchestrator, and (c) how the multi-agent fleet collapses per-LB verification time so the bottleneck becomes the bake itself, not the validation.

---

## 2. The current pipeline (what runs today)

Three independent bake CLIs + a Python staging script + a renderer + a validator. Per [`world-completeness-method.md`](world-completeness-method.md) §"Reproducible production loop":

```bash
# 1. Scenery bake — Rust CLI; LB-range syntax via --landblocks
cargo run -p holtburger-tools --release --bin scenery-bake -- \
  --dat-dir ~/ac_base_dats \
  --landblocks 0xA3AE..0xAFBA \
  --out /mnt/wbterminal1/holtburger-dist-v2/scenery/ \
  --mode ace-compat
#   produces: 0xLLLL.scenery.jsonl + 0xLLLL.scenery.jsonl.sha256 (Wave-4.B)
#           + bake-source.sha256 (DAT lineage)

# 2. Event bake — Rust CLI; same LB-range syntax
cargo run -p holtburger-tools --release --bin event-bake -- \
  --dat-dir ~/ac_base_dats \
  --landblocks 0xA3AE..0xAFBA \
  --spawns-dir /mnt/wbterminal1/holtburger-dist-v2/spawns/ \
  --setup-table-path /mnt/wbterminal1/holtburger-dist-v2/spawns/wcid_to_setup.json \
  --out /mnt/wbterminal1/holtburger-dist-v2/events/ \
  --sky
#   produces: 0xLLLL.events.jsonl + 0xLLLL.events.jsonl.sha256 (Wave-4.B)
#           + event-bake-source.sha256
#           + region.sky-events.jsonl (one-shot, if --sky)

# 3. Spawn stage — Python; not range-keyed but ring-filtered
python3 scripts/world-completeness/stage-ring-spawns.py \
  --source /home/wbterminal/projects/RetailSmoke/ace_spawn_records.jsonl \
  --weenie-index /home/wbterminal/projects/RetailSmoke/weenie_index.jsonl \
  --out /mnt/wbterminal1/holtburger-dist-v2/spawns/
#   produces: 0xLLLL.spawns.jsonl + 0xLLLL.spawns.jsonl.sha256 (Wave-4.B)
#           + wcid_to_setup.json + source.sha256 + README.md

# 4. Validate the ring (build-side aggregator)
echo '{"command":"diag-run-all"}' \
  | dotnet WorldBuilder.Terminal.dll --stdin
#   reads /mnt/wbterminal1/holtburger-validator-reports/<surface>/<latest>/report.json
```

Wall-clock (13×13 = 169 LBs):
- Scenery bake: ~minutes (not separately published; estimated from B5 parity test)
- Event bake: ~minutes (similar)
- Spawn stage: <30 s (Python; bottlenecked on JSONL parse of the 365k-row world dump)
- `diag-run-all`: ~7 min (mostly `validate_landblock_completeness.cjs` boot+settle+drain)

**Total for the 169-LB ring**: roughly 15–25 minutes manual operator time today, dominated by the validator's headless-render runtime.

---

## 3. The constraints that make "one-shot" non-trivial

Five gaps between "run three CLIs in sequence" and "one orchestrator":

1. **No unified entry point**. Each CLI has its own argument shape, output dir convention, and error reporting. Operators must remember 4 invocations + paths.
2. **Heterogeneous languages**. Two Rust CLIs + one Python script + one C# WB.T command. Wrapping them in one `bash` script is feasible but fragile (cwd assumptions, env vars, virtualenvs).
3. **No parallelism**. All three bake CLIs are per-LB serial (`scenery-bake.rs:738-763` etc.). Extrapolated 65,536-LB whole-Dereth bake = ~hours. World-completeness-method §"Open follow-ons" calls this out as "future tool work" because `bake_landblock` has no shared state — embarrassingly parallel — but the CLI hasn't been wired to use a thread pool.
4. **No atomic dist publish**. The bake CLIs write per-LB JSONL files in-place. If a re-bake is interrupted mid-LB, the dist tree has a mix of new + old files. No staging-dir + atomic rename + symlink swap pattern exists.
5. **No determinism re-verify step**. The bake CLIs emit `bake-source.sha256` per run; nothing automatically compares against a prior bake's sidecar to confirm inputs haven't drifted.

The orchestrator design in §6 sketches how to close these gaps. The recipe in §4 explains what an operator can run today within the existing constraints.

---

## 4. Practical recipe today: manual one-shot

This is the recipe for an operator to expand the ring NOW, without waiting for the orchestrator. The multi-agent fleet handles the validation; the bake CLIs handle the data production.

### 4.1 Choose the LB range

For an outdoor ring around a town, use the standard `<lo>..<hi>` syntax (a rectangle in row-major LB-key order). Example: extend Holtburg from 13×13 to 25×25 (612 LBs in the doughnut, 781 total):

```bash
# Center Holtburg = 0xA9B4 (lbX=169, lbY=180)
# 25×25 = ±12 in each axis = 0x9DA8..0xB5C0
RING_LO=0x9DA8
RING_HI=0xB5C0
```

For a new region (e.g. Shoushi), look up its centre LB in [`docs/agent_api_reference.md`](agent_api_reference.md) or the ACE town gazetteer, then build a range around it.

### 4.2 Run the bakes in sequence

Each bake is independent; no inter-CLI ordering required as long as spawns precedes events (event-bake reads spawns for wcid → MotionTable resolution).

```bash
export PATH=$HOME/.cargo/bin:$PATH
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger

# Spawn stage first (event-bake needs the spawn manifest for wcid lookups)
python3 scripts/world-completeness/stage-ring-spawns.py \
  --out /mnt/wbterminal1/holtburger-dist-v2/spawns/

# Scenery + Event in parallel — they don't depend on each other
cargo run -p holtburger-tools --release --bin scenery-bake -- \
  --dat-dir ~/ac_base_dats \
  --landblocks ${RING_LO}..${RING_HI} \
  --out /mnt/wbterminal1/holtburger-dist-v2/scenery/ \
  --mode ace-compat \
  &

cargo run -p holtburger-tools --release --bin event-bake -- \
  --dat-dir ~/ac_base_dats \
  --landblocks ${RING_LO}..${RING_HI} \
  --spawns-dir /mnt/wbterminal1/holtburger-dist-v2/spawns/ \
  --setup-table-path /mnt/wbterminal1/holtburger-dist-v2/spawns/wcid_to_setup.json \
  --out /mnt/wbterminal1/holtburger-dist-v2/events/ \
  --sky \
  &

wait  # wait for both bakes
```

Per-LB output: `0xLLLL.{scenery,events}.jsonl` + `.sha256` sidecar (Wave-4.B). Re-running is idempotent — the CLIs overwrite per-LB files in place.

### 4.3 Bake-source integrity check

The bake CLIs emit `bake-source.sha256` (top-level) recording the input DAT hashes. If you're expanding an existing region, the sha256s should be IDENTICAL to the prior bake's sidecar:

```bash
diff /mnt/wbterminal1/holtburger-dist-v2/scenery/bake-source.sha256 \
     /mnt/wbterminal1/holtburger-dist-v2-prev/scenery/bake-source.sha256
# expected: no output (identical), meaning the bake ran on the same DATs
```

If they differ: stop. Either the DATs changed (then you need a full re-bake of the whole ring, not just the expansion) or someone touched the input. Resolve before proceeding.

### 4.4 Multi-agent fleet validation (the big win)

Per-LB validation via the wire-agent's `__diag.runAll(lbId)` is **sub-second** (232 ms measured on Holtburg, page.evaluate roundtrip included). The 169-LB ring at single-agent serial = 40 s of pure diag work + the ~3.5 s boot per agent.

Run via the fleet harness — 4 or 8 agents in one chromium share the boot cost:

```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/scripts/multi-agent

# Boot N agents into the ring, each cycles through assigned LBs
node fleet.mjs --agents=8 \
  --flags="hud=none&plugins=none&renderOnDemand=1&netDrainHz=30&diag=1" \
  --label=expand-validate-$(date +%Y%m%d)
```

The fleet harness's current shape is single-LB-per-agent (the agents boot, settle, snapshot). For batch ring validation, extend it with a `--lb-ring 0xLO..0xHI` argument that round-robins LBs across agents and accumulates per-LB reports. **This extension is the natural next step** — implementation note in §7.

Expected wall-clock (estimated from §5 below):
- 169 LBs / 8 agents = 22 LBs per agent
- Boot+settle: 7.5 s (shared across agents in one chromium)
- Per-LB cycle: teleport (~2 s) + 232 ms runAll + 8 s integrity = ~10 s per LB
- Total: 22 × 10 = **~220 s ≈ 4 minutes** for the 169-LB ring

That's a **~7× speedup** vs single-agent serial.

### 4.5 Build-side validator as the gate

The fleet harness gives you per-LB observation. The build-side `diag-run-all` aggregator is still the gate — it asserts every surface contract holds end-to-end:

```bash
echo '{"command":"diag-run-all"}' | dotnet WorldBuilder.Terminal.dll --stdin
# exit 0 = all required surfaces PASS → ship
# exit 1 = some surface FAIL → drop to ring-diagnose-repair-playbook.md
# exit 2 = infra error → investigate the validator runner
```

CI gate fires on `summary.requiredFailures > 0`.

---

## 5. Performance characteristics + scaling estimates

### 5.1 Per-LB cost breakdown

From measurement runs (see `~/.claude/projects/-home-wbterminal/memory/reference_wire_agent_diag_layer.md`):

| Step | Time | Cost driver |
|---|---|---|
| Scenery bake (1 LB, single-thread Rust) | ~50 ms estimated (Holtburg ring 169 LBs in ~minutes) | DAT decode + scene_info walk + deterministic noise + AABB intersection |
| Event bake (1 LB) | ~100 ms estimated | Same DAT cost + per-spawn motion-hook walk |
| Spawn stage (1 LB, Python) | ~5 ms | JSON parse + sort |
| Wire-agent boot to ready | 3.5 s | wasm load + handshake + spawn |
| Wire-agent settle for async spawns | 4 s | _spawnImpl chain |
| `__diag.runAll(lbId)` (10 surfaces) | 232 ms | One page.evaluate roundtrip |
| `__diag.integrity.verifyManifests(1 LB)` | 8.4 s | 7 fetches (boot.hba + 3 lineage + 3 per-LB JSONL) × sha256 |
| `__diag.integrity` marginal per added LB | ~3 s | 3 more fetches |

### 5.2 Ring sizes — total wall-clock estimates

| Ring | LB count | Bake (single-thread, all 3 CLIs) | Validation (8-agent fleet) | Total |
|---|---:|---:|---:|---:|
| Current 13×13 Holtburg | 169 | ~3 min | ~4 min | **~7 min** |
| 25×25 Holtburg | 625 | ~12 min | ~15 min | **~27 min** |
| 49×49 region | 2,401 | ~45 min | ~60 min | **~1.75 h** |
| Whole-Dereth 256×256 | 65,536 | ~22 h serial | ~28 h serial | **~50 h serial** |
| Whole-Dereth with 8-way bake parallelism | 65,536 | ~3 h | ~28 h | **~31 h** |

The validation side is the dominant cost above ring 25×25. Two optimizations would shift this:

- **A: Per-LB validation parallelism** — the fleet harness already opens N pages in one chromium. Extending to N=16 or N=32 on a larger VM is straightforward; bottleneck is `boot+settle` time per page which is 7.5 s. Parallel boot of 32 pages = ~30 s total boot, then ~5 s per LB across 32 lanes = whole-Dereth in ~3 hours.

- **B: Batched integrity verify** — `integrity.verifyManifests({landblocks: [...]})` already accepts a list. Fetches are sequential within one call; making them parallel (Promise.all with a concurrency limit) would drop the 8 s per LB to ~1 s amortized.

Both are concrete tool work, not algorithm changes. See §7.

### 5.3 Memory + disk

- Per-agent RSS in the fleet: **~130 MB chromium + JS heap 28 MB** (measured). 32-agent fleet = ~4 GB RSS — fits on an 8 vCPU / 16 GB VM.
- Bake disk usage (extrapolated from 13×13's 3.1 MB scenery JSONL): **~1.5 GB scenery + ~50 MB events + ~25 MB spawns = ~1.6 GB whole-Dereth dist tree.**
- Per-LB sha256 sidecar overhead: 64 bytes each × 3 types × 65,536 LBs = ~12 MB. Negligible.

---

## 6. Open infrastructure gaps for "true one-shot"

Beyond what an operator can run today, these are the concrete tool gaps that would make `bake-region 0xLO..0xHI` a single command. Listed by leverage:

1. **`bake-region` orchestrator CLI** (Rust). Wraps scenery-bake + event-bake + stage-ring-spawns.py + `diag-run-all` invocation into one entry point. Args: `--landblocks RANGE`, `--dat-dir PATH`, `--ace-spawns-jsonl PATH`, `--out-root DIR`, `--parallel N`, `--verify` (run the validator gate at the end). ~300 LOC of glue, no algorithm changes.

2. **`scenery-bake --parallel N` / `event-bake --parallel N`** flag. Each per-LB bake is independent (no shared state). A thread pool of N workers with a work-stealing queue would 8×–32× the bake throughput on the same hardware. Rust ecosystem has `rayon` for this; ~50 LOC change per CLI.

3. **Spawn-stager Rust rewrite** (currently Python). Makes the toolchain uniform (one cargo workspace + one venv-less invocation). ~200 LOC. Optional — Python works fine — but eliminates a class of "is Python set up correctly on this box" issues.

4. **Atomic dist-tree publish**. Write per-LB JSONL to `dist-v2-staging/`, fsync the directory, then atomic-rename swap with `dist-v2/`. Eliminates the "interrupted mid-bake = mixed dist tree" failure mode. ~30 LOC, mostly fs::rename.

5. **`fleet.mjs --lb-ring 0xLO..0xHI`** extension. Today the fleet boots N agents at a fixed account; this would round-robin LBs across the agents via repeated teleport-and-snapshot cycles. Per-LB report goes to `report-<lbHex>.json` in the out dir. ~150 LOC extension.

6. **`integrity.verifyManifests` parallelism**. Today the fetches are sequential. Promise.all with concurrency limit of 8 would drop the 8 s/LB to ~1 s amortized. ~20 LOC change.

7. **Determinism re-verify step**. Auto-compare `bake-source.sha256` against the prior bake's sidecar at orchestrator-start. Refuse to run if input DATs changed without operator-acknowledged force flag. ~30 LOC.

Total estimated work for the full orchestrator: ~800 LOC across 5 files + 1 new binary. Roughly 2 days for someone familiar with the codebase.

---

## 7. Step-by-step expansion procedures

### 7.1 Extend Holtburg ring (13×13 → 25×25)

1. Set range: `RING_LO=0x9DA8 RING_HI=0xB5C0`.
2. Run §4.1 sequence.
3. Verify per-LB sha256 sidecars exist for the NEW 612 LBs: `ls /mnt/wbterminal1/holtburger-dist-v2/scenery/0x*.scenery.jsonl.sha256 | wc -l` should match the new total.
4. Run multi-agent fleet validation per §4.4.
5. Run `diag-run-all` gate per §4.5.
6. Acceptance: all surfaces PASS; manual spot-check 3–5 sample LBs via `__diag.runAll(0xLLLL0000)`.

### 7.2 New region (Shoushi, Yaraq, Cragstone, Yanshi)

The complication is each region has its own Region DID (Dereth = 0x13000000 is the only one in retail; multi-region servers like Coldeve add more). For each new region:

1. Identify the Region DID via the ACE world DB or `chorizite-dump-enum-values`.
2. Confirm the ring center LB from the gazetteer.
3. Run bakes with `--region-did 0xXXXXXXXX` (currently hardcoded default = 0x13000000 Dereth; CLI flag exists but rarely used).
4. Stage to a DIFFERENT dist tree (e.g. `holtburger-dist-v2-shoushi/`) so the regions don't collide.
5. Wire the runtime's resource-source to fetch from the appropriate dist tree based on player position (TODO — currently hardcoded).

### 7.3 Whole-Dereth

Not recommended without the §6 work shipped. The serial bake = ~22 hours and the serial validation = ~28 hours; neither parallelizes today.

Order to ship:
1. `--parallel N` flag in scenery-bake (~50 LOC).
2. `--parallel N` flag in event-bake (~50 LOC).
3. `integrity.verifyManifests` parallel fetches (~20 LOC).
4. `fleet.mjs --lb-ring` extension (~150 LOC).
5. `bake-region` orchestrator (~300 LOC).
6. Then run whole-Dereth: estimated ~3 hours bake + ~6 hours fleet validation = **9 hours total**.

The bake is embarrassingly parallel by design (per-LB independent, no shared state per the world-completeness method's "determinism contract" §85-93). The blockers are tool gaps, not algorithm work.

---

## 8. Acceptance gate

For an expansion to be "shipped":

1. **`bake-source.sha256` lineage matches** the canonical retail DAT installation.
2. **All per-LB sha256 sidecars present** for the new LB range across all 3 types (scenery / events / spawns).
3. **`diag-run-all` exit 0** — every required build-side surface PASSes.
4. **Spot-check sample LBs via `__diag.runAll(lbId)`** — at least 5 LBs, no `DRIFT` from any surface.
5. **No `__diag.assets.materialErrors` / `animationErrors` / `meshErrors`** during fleet validation (zero swallowed fetch failures).
6. **`__diag.integrity.verifyManifests({landblocks: [...]})` returns `ok: true`** for the entire new range.

If any of (1)–(6) fails, the expansion is NOT shipped; route through [`ring-diagnose-repair-playbook.md`](ring-diagnose-repair-playbook.md) §5 to repair.

---

## 9. What this method does NOT cover

- **Custom-world expansion** (modder content). See [`HowToMakeNewWorlds.md`](HowToMakeNewWorlds.md) for the WorldBuilder export flow; the diagnostic stack here assumes retail base DATs.
- **Cross-region transitions** (Yanshi-portal-to-Shoushi). Per-region dist trees exist; the runtime side of region switching is a separate workstream.
- **Dynamic spawn rebalancing**. The bake captures ACE's `landblock_instance` as a snapshot; live ACE can mutate spawns. The validator catches drift but doesn't track LIVE updates.
- **Performance regressions during expansion**. See `scripts/perf-worker/README.md`. The perf surface is observation-only.

---

## 10. Provenance

| Artifact | Status | Path |
|---|---|---|
| scenery-bake CLI | Shipped + Wave-4.B sidecars | `apps/holtburger-tools/src/bin/scenery-bake.rs` |
| event-bake CLI | Shipped + Wave-4.B sidecars | `apps/holtburger-tools/src/bin/event-bake.rs` |
| stage-ring-spawns.py | Shipped + Wave-4.B sidecars | `scripts/world-completeness/stage-ring-spawns.py` |
| fleet.mjs harness | Shipped (single-LB-per-agent) | `scripts/multi-agent/fleet.mjs` |
| `__diag.runAll` | Shipped (10 surfaces) | `apps/holtburger-web/scene3d/diag.js` |
| `__diag.integrity.verifyManifests` | Shipped (per-LB + boot) | `apps/holtburger-web/scene3d/diag/integrity.js` |
| `dump-lb-expectations` | Shipped (with `--out`, bakedScenery, events) | `WorldBuilder.Terminal/JsonCommandProcessor.cs` |
| `pvs-visibility-snapshot --out` | Shipped (Wave 5.A) | same |
| `bake-region` orchestrator | **NOT shipped** | proposed in §6 |
| `--parallel N` bake flags | **NOT shipped** | proposed in §6 |
| `fleet.mjs --lb-ring` extension | **NOT shipped** | proposed in §6 |
| `integrity` parallel fetch | **NOT shipped** | proposed in §6 |

The shipped pieces give you the recipe in §4 today. The proposed pieces are what turn that recipe into the `bake-region` one-shot.

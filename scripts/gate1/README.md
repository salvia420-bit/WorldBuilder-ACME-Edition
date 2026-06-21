# Gate-1 — offline world-completeness DATA gate

Gate-1 is the cheap, exhaustive, **offline** half of a two-gate strategy for
proving the baked Holtburger world is complete and faithful to retail Asheron's
Call. It diffs every baked placement in a ring of landblocks against an oracle,
one-to-one within retail-derived tolerances, with **no browser, no network, no
GPU, and no heavy build**. It runs the 169-LB Holtburg ring in a few seconds and
scales to the full 40,197-LB world without a graphics card.

```
scripts/gate1/
  run-gate1.sh           # the runner (this README documents it)
  diff-completeness.mjs  # zero-dep Node ESM diff engine (stdlib only)
  holtburg-ring.txt      # the canonical 13x13 ring 0xA3AE..0xAFBA (169 LBs)
  README.md              # you are here
```

---

## The two-gate thesis

Completeness/fidelity has two failure modes that need two different kinds of
check, with two very different cost profiles:

| | **Gate-1 — DATA gate (this)** | **Gate-2 — RENDER smoke (later)** |
|---|---|---|
| Question | "Is the correct set of objects baked at the correct coordinates/scale/rotation for every landblock?" | "When the client loads a landblock, does it actually draw, with no crash/black-screen/missing-mesh?" |
| Method | One-to-one placement diff vs an oracle, within tolerances | Load representative LBs in the real client and observe they render |
| Coverage | **Exhaustive** — every LB, every placement | **Sampled** — a handful of representative LBs |
| Cost | Pennies. ~3s for the ring; minutes for the whole world, CPU-only | Expensive. GPU, cold-load stalls (~90s on the 1070 for ultra), human or headless-Playwright in the loop |
| Determinism | Byte-deterministic report | Frame-timing / GPU-driver dependent |
| Catches | Missing placements, extras, position/scale/rotation drift, bake-vs-source divergence | Shader-compile failures, white-box materials, draw-gate bugs, z-fighting — things data parity cannot see |

The division of labor: **Gate-1 carries the exhaustive coverage burden** because
it is cheap enough to run for all 40,197 LBs. Gate-2 only has to *sample*,
because Gate-1 already proved the data is right everywhere — so the render smoke
just needs to confirm "given correct data, the renderer draws it" on a few
representative cells (a town, a wilderness cell, a dungeon, a coastline). You do
not (and cannot affordably) render-smoke 40k landblocks; you do not need to,
because the data gate is exhaustive.

A green Gate-1 + a green sampled Gate-2 together give high confidence the whole
world is complete and renders. Gate-1 alone proves the *data*; it deliberately
makes **no rendering claim** — every report stamps `browser used: NO`.

---

## Legs and their oracle provenance

The single most important property of this gate is **oracle-provenance
honesty**: a check is only as good as the independence of what it compares
against. Each leg is stamped with how its oracle was obtained, and the engine
*refuses* to let a bake-derived field masquerade as independent verification.

| leg | produced side | oracle side | provenance | what it proves |
|---|---|---|---|---|
| `scenery-independent` | bake JSONL | C# scenery-cross-check JSONL | **independent** | The Rust bake's scenery algorithm agrees with an independent C# port of ACE's `Scenery.Load`. This is the real correctness proof for scenery. |
| `scenery-regression` | bake JSONL | frozen oracle `bakedScenery` | **regression-snapshot** | The live bake has not *drifted* from the blessed 2026-06-01 snapshot. Drift detection only — NOT algorithm correctness (see below). |
| `statics-independent` | oracle `buildings` (identity) | oracle `buildings` | **independent** | Per-LB coverage of the independent static-object set (LandblockInfo). |
| `spawns-independent` | ACE spawn dump JSONL | oracle `npcs` | **independent** | The spawn set (ACE `landblock_instance` + encounters) matches the world's expected NPC/monster population. |

### Why `scenery-regression` is NOT independence

The frozen WB.Terminal oracle snapshot's `bakedScenery` field was **copied from
the bake JSONL** on 2026-06-01 (`JsonCommandProcessor.CmdDumpLbExpectations`
reads the pre-baked file via `LoadBakedScenery()` and serializes it straight
into the oracle). Diffing today's bake against that field therefore compares the
bake to *a prior copy of itself*. That is a perfectly useful **regression check**
— "did the live bake drift from the blessed snapshot?" — but it can never prove
the bake algorithm is *correct*, only that it is *stable*. The engine labels this
leg `regression-snapshot` and prints a loud warning; the runner's overall
verdict treats it accordingly.

The genuinely independent scenery proof is `scenery-independent`: bake vs the
**C# cross-check** (`tools/scenery-cross-check`, a from-scratch port of ACE's
`Scenery.Load` that reads the retail DATs directly). That comparison is between
two independent implementations of the retail algorithm, so agreement is real
evidence of correctness. It is **not in the offline default set** only because
the C# output is not pre-generated on disk; producing it is a heavy dotnet run
(see "Enabling the independent scenery leg" below).

### Circular refusal

If anyone wires the oracle's bake-derived `bakedScenery` into a slot that claims
`independent` provenance, the engine returns `verdict: REFUSED` with
`oracleProvenance: circular` rather than silently reporting a meaningless PASS.

### `buildings` and `npcs` are genuinely independent

* **buildings** come from `LandblockDocument.GetStaticObjects()` (the WB
  project's per-LB static placements, enriched via the ontology to flag
  `Category='Structure'`). These are the actual model placements edited in
  WorldBuilder — computed from a different source than the bake.
* **npcs** come from ACE world data — `landblock_instance` (static spawns, town
  NPCs, monuments) plus `encounter` (wilderness generators), merged by
  `SpawnGazetteerBuilder`. Independent of both the bake and the LB document.

---

## What the offline default run reports today (Holtburg ring)

Running `run-gate1.sh` with no arguments (offline legs only) over the 169-LB
ring produces, as of the 2026-06-01 artifacts:

```
leg                  provenance           LBs PASS DRIFT SKIP  compared matched missing extra drift
scenery-regression   regression-snapshot  169  168     0    1     16672   16672       0     0     0
statics-independent  independent          169  168     0    1        46      46       0     0     0
spawns-independent   independent          169    1    42  126       419      27     392   392     0
```

* **scenery-regression 168 PASS / 1 SKIP** — 16,672 placements byte-match the
  blessed snapshot; **zero drift**. The lone SKIP is `0xA7B3`, which is absent
  from both the bake and the oracle set (it is the one missing LB inside the
  rectangular ring's bounding box; see `holtburg-ring.txt`).
* **statics-independent 168 PASS / 1 SKIP** — 46 LandblockInfo structures
  covered across the ring (same `0xA7B3` SKIP).
* **spawns-independent 1 PASS / 42 DRIFT / 126 SKIP** — this DRIFT is a **real,
  expected data finding, not a tool bug**:
  * **SKIP (126)** — ring LBs that have no rows in `ace_spawn_records.jsonl`
    (empty wilderness cells with no static spawns/encounters).
  * **DRIFT (42)** — where both sides have records, `oracle.npcs` and the raw
    spawn dump diverge in count and position. `oracle.npcs` is the
    **generator-expanded** population (synthetic child records spawned from
    parent generator wcids via spawn profiles, flagged `isSynthetic`), whereas
    the raw `ace_spawn_records.jsonl` rows are the **un-expanded** generator
    parents at their seed positions. E.g. `0xA9B4` compares 106 oracle npcs to
    14 raw-dump matches. Interpreting this leg correctly requires deciding which
    population is canonical for the gate (raw generators vs expanded children);
    until that policy is fixed, treat spawns DRIFT as *informational*, not a
    hard fail. The runner's overall verdict surfaces it as `DRIFT` so it is
    never silently ignored.

The runner rolls these into an overall verdict (`PASS` / `DRIFT` / `REFUSED`)
and always prints `browser used: NO`.

---

## Running it

```bash
# Default: Holtburg ring, offline legs (regression + statics + spawns).
scripts/gate1/run-gate1.sh

# A different ring (file with one 0xLLLL per line, or an inline comma list).
scripts/gate1/run-gate1.sh --ring scripts/gate1/holtburg-ring.txt
scripts/gate1/run-gate1.sh --ring 0xA9B4,0xA3AE,0xAFBA

# Choose legs explicitly.
scripts/gate1/run-gate1.sh --legs scenery-regression,statics-independent

# Pick an output dir (default /mnt/wbterminal1/tmp/claude-scratch/gate1/report).
scripts/gate1/run-gate1.sh --out /mnt/wbterminal1/tmp/claude-scratch/gate1/myrun

# Exercise the diff engine with synthetic data (no real artifacts touched).
scripts/gate1/run-gate1.sh --selftest
```

Inputs are resolved to verified on-disk defaults and can be overridden by env
vars (`BAKE_DIR`, `ORACLE_DIR`, `SPAWN_SOURCE`, `CROSSCHECK_DIR`, `OUT_DIR`) or
the matching flags. Missing inputs produce a warning and the dependent legs SKIP
(the report stays honest about what could actually run).

Output: `<out>/gate1-report.json` — a deterministic, sorted-key report with
per-landblock per-leg results, evidence samples (missing/extra/drift, capped),
and ring-wide totals. Re-running is byte-identical except `wallClockSeconds`.

### Ring file format

`holtburg-ring.txt` lists one `0xLLLL` per line; `#` comments and blank lines are
ignored. It is the rectangular bounding box `0xA3AE..0xAFBA` (X = 0xA3..0xAF,
Y = 0xAE..0xBA, 13x13 = 169 LBs, center 0xA9B4), the canonical ring from
`validate_landblock_completeness.cjs` / `docs/world-completeness-method.md`.
`0xA7B3` is present in the grid for completeness but is absent from the frozen
bake/oracle set, so it SKIPs.

---

## Oracle generation (how the independent oracles are produced)

Gate-1 consumes oracles that already exist on disk. This section documents how
they are *produced* so the gate can be re-pointed at a fresh world or scaled up.

### Sharded oracle-gen — parallel `dump-lb-expectations`

The frozen oracle snapshot (`buildings` + `npcs` + `bakedScenery` per LB) is
generated by WorldBuilder.Terminal's `dump-lb-expectations` command, one JSON
object per landblock. For 40k LBs this is embarrassingly parallel: shard the LB
list across **N WorldBuilder.Terminal `--stdin` processes**, each owning a slice,
each emitting `<oracleDir>/0xLLLL.json`.

```bash
# Sketch: N-way sharded oracle generation.
N=8
ORACLE_DIR=/mnt/wbterminal1/tmp/claude-scratch/gate1/oracles
mkdir -p "$ORACLE_DIR"

# all-landblocks.txt = the LB list to cover (the ring, or the full world).
split -n l/$N --numeric-suffixes=0 all-landblocks.txt /tmp/gate1-shard-

for i in $(seq 0 $((N-1))); do
  shard=$(printf '/tmp/gate1-shard-%02d' "$i")
  # Each WB.Terminal --stdin process reads "dump-lb-expectations 0xLLLL
  # --sceneryBakeDir <bake>" lines and writes one JSON per LB into $ORACLE_DIR.
  ( while read -r lb; do
      echo "dump-lb-expectations $lb --sceneryBakeDir /mnt/wbterminal2/holtburger-dist/scenery --out $ORACLE_DIR/$lb.json"
    done < "$shard" \
    | WorldBuilder.Terminal --stdin --project /home/wbterminal/projects/RetailSmoke
  ) &
done
wait
```

Provenance note: in this snapshot `bakedScenery` is copied from the bake
(circular — hence the `scenery-regression` label). `buildings` and `npcs` are
computed independently from the LB document and the spawn gazetteer, so they are
valid independent oracles even though they ride in the same JSON file.

### Independent spawns oracle — one-shot ACE `landblock_instance` dump

The spawns leg's independent side is an ACE world-DB dump. The committed default
is `ace_spawn_records.jsonl` (already written by
`CommandEngine.IngestAceSpawnsAsync` / `IngestAceEncountersAsync`). To regenerate
it independently of the oracle snapshot, dump ACE's spawn tables directly:

```sql
-- One-shot independent spawns oracle from the ACE world DB.
SELECT * FROM landblock_instance;   -- static spawns, town NPCs, monuments
SELECT * FROM encounter;            -- wilderness generators
```

Export each row as a JSONL record carrying at minimum
`{ wcid, landblockId, cell, x, y, z }`. `landblockId` may be either the bare
0xLLLL value (the form `ace_spawn_records.jsonl` uses — observed max 0xFADA) or
a full ACE cell id `0xLLLLCCCC`; the diff engine accepts both (it takes the high
word only when the value exceeds 0xFFFF). Because this comes straight from the
ACE DB and never touches the bake or the LB document, it is a genuinely
independent oracle for the NPC/monster population.

To use a fresh dump:

```bash
scripts/gate1/run-gate1.sh --spawn-source /path/to/landblock_instance_dump.jsonl
# or: SPAWN_SOURCE=/path/... scripts/gate1/run-gate1.sh
```

### Enabling the independent scenery leg (C# cross-check)

`scenery-independent` (bake vs an independent C# port of `Scenery.Load`) is the
real scenery correctness proof but is **not** in the offline default because the
C# output is not pre-generated (producing it is a heavy dotnet run — run it
alone, never alongside another heavy process). Generate it, then re-run:

```bash
# Heavy: run by itself (check `free -h` first; needs the base retail DATs).
cd /home/wbterminal/WorldBuilder-ACME-Edition/tools/scenery-cross-check
~/.dotnet/dotnet run -c Release -- \
  --dat-dir /home/wbterminal/projects/RetailSmoke/dats/base \
  --landblocks 0xA3AE..0xAFBA \
  --out /mnt/wbterminal1/tmp/claude-scratch/gate1/crosscheck

# Now the runner auto-adds scenery-independent when the dir exists:
scripts/gate1/run-gate1.sh \
  --crosscheck-dir /mnt/wbterminal1/tmp/claude-scratch/gate1/crosscheck
```

(The C# tool emits no `default_script_id` field — it is the pre-V1 upper-bound
oracle — so the engine matches on `obj_id + position + scale + quaternion`, which
is exactly what the independence proof needs.)

---

## Matching and tolerances

Per leg, per landblock, each placement is normalized to a bucket key
`(modelId/wcid, round(x), round(y), round(z))` carrying scale + quaternion, then
greedily one-to-one matched within retail-derived tolerances:

| tolerance | value | meaning |
|---|---|---|
| `xy` | 1e-4 m | horizontal position |
| `z` | 1e-4 m | vertical position |
| `scale` | 1e-5 | scale ratio |
| `quatDot` | 0.9999 | `\|dot(q_a,q_b)\| >=` this is "same rotation" (q and -q are identical) |

Outcomes per LB: `missing` (in oracle, not produced), `extra` (produced, not in
oracle), `drift` (matched on position but out of scale/quat tolerance). Verdict
is `PASS` iff `missing == extra == drift == 0`, else `DRIFT`.

---

## Scaling from the Holtburg ring to the full 40,197-LB world

Everything above is ring-agnostic — point `--ring` at a full-world LB list and
the same legs run unchanged. The only practical limits are memory and time, not
correctness.

1. **Build the full-world LB list** (one `0xLLLL` per line) from the bake dir,
   which has a JSONL per populated landblock:

   ```bash
   ls /mnt/wbterminal2/holtburger-dist/scenery/ \
     | sed -n 's/^\(0x[0-9A-Fa-f]\{4\}\)\.scenery\.jsonl$/\1/p' \
     | sort -u > /mnt/wbterminal1/tmp/claude-scratch/gate1/all-landblocks.txt
   wc -l /mnt/wbterminal1/tmp/claude-scratch/gate1/all-landblocks.txt   # ~40,197
   ```

2. **Generate full-world oracles** with the sharded `dump-lb-expectations`
   design above, pointed at `all-landblocks.txt` (the 2026-06-01 snapshot at
   `/mnt/wbterminal1/tmp/claude-scratch/world-oracles-2026-06-01/oracles`
   already covers 40,188 LBs and can be reused directly for the regression +
   statics + spawns legs).

3. **(Optional) Generate the full-world C# cross-check** for genuine scenery
   independence (heavy; shard the `--landblocks` range, run shards sequentially
   to respect the one-heavy-process rule).

4. **Run the gate over the whole world** (offline legs; CPU-only):

   ```bash
   scripts/gate1/run-gate1.sh \
     --ring /mnt/wbterminal1/tmp/claude-scratch/gate1/all-landblocks.txt \
     --oracle-dir /mnt/wbterminal1/tmp/claude-scratch/world-oracles-2026-06-01/oracles \
     --out /mnt/wbterminal1/tmp/claude-scratch/gate1/report-fullworld
   ```

   The ring-sized run is ~3s; the spawn-source is read once and indexed by
   landblock, so the dominant cost for the full world is reading ~40k small
   oracle JSON files (minutes, CPU-only, no GPU). For very large rings consider
   sharding the `--ring` across a few sequential runs and merging the per-LB
   sections of the JSON reports if memory pressure on the 8GB box is a concern.

5. **Then, and only then, run Gate-2** (the sampled render smoke) on a handful
   of representative LBs picked from the world — Gate-1's exhaustive data pass
   means the render smoke only has to confirm the renderer draws correct data on
   a few cells, not all 40k.

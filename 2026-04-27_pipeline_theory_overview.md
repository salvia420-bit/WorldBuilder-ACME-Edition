# Pipeline Theory Overview

Date: 2026-04-27 (supersedes the 2026-04-26 snapshot in this same file)

This note captures the full ML pipeline state one day after the first unified
scene-placer training run. The picture has shifted enough — a class-imbalance
discovery, a new training run addressing it, and the abstract-vocab inference
plumbing — that the April 26 version is misleading on its own.

It is intentionally a theory/orientation document, not a plan-of-record.

## 0. What changed since April 26

Three real things, one false alarm:

1. **Discovered the abstract-vocab class-imbalance trap.** The unified
   `component_linked_unified_abstract_ace_vocab.json` has roughly **4476
   model_id (DAT) tokens vs only 108 ace_abstract (ACE/wcid) tokens** —
   a ~40:1 ratio. Vanilla cross-entropy reproduces that ratio at sampling
   time. The April 26 unified runs (`unified_overnight_*`) were
   architecturally fine but would have collapsed onto DAT props at
   inference, almost never emitting ACE objects (creatures, NPCs,
   vendors). This is not an architecture bug — it's a training-data
   calibration issue invisible until you look at sampling behavior.
2. **Trainer rebalance landed.** `train_scene_placer.py` now has
   `build_class_space_weight` + `--ace-abstract-weight`, a per-vocab-idx
   weight tensor that scales `ace_abstract` entries before the wcid
   cross-entropy. The current run is using **weight = 10.0**.
3. **Abstract-vocab inference plumbing landed.** `generate_populated_world.py`
   now has `WcidResolver`, a drop-in replacement for the legacy
   `vocab['idx_to_wcid']` dict that handles both the old direct-wcid vocab
   and the new abstract_ace vocab. `ace_abstract:B` tokens sample a real
   wcid from `component_linked_unified_abstract_ace_bucket_resolver.json`
   (frequency-weighted, configurable temperature). The resolver itself is
   built by the new `build_bucket_to_wcid_resolver.py` from the same
   JSONLs the tensor extractor reads, so bucket strings are guaranteed to
   match the trained vocab.

The false alarm: **the interior-emission inference path is NOT done.**
April 26's Tier 1 item 1 ("inference path for the unified model — needs to
also iterate envcell components and emit interior token sequences with the
right scene_kind context") got the *vocab half* of the work, not the
*emission half*. `generate_populated_world.py` still iterates landblocks
only; envcell components, scene_kind switching, and interior token
emission are still TODO.

## 1. Active run — `unified_classweighted_v3_20260427T1206Z`

Started 2026-04-27 12:06 UTC, currently mid-training:

- **Resumes weights** from `unified_overnight_v2_20260426T210549Z_best.safetensors`
  (yesterday's overnight — last-untweaked baseline). Optimizer/scheduler
  state was *dropped*; this is effectively a fine-tune, not a true
  continuation, which is why warmup re-engages from epoch 0.
- **30 epochs**, lr 1e-4, focal γ=2.0, cosine warm-restart at epoch 15,
  `--ace-abstract-weight 10`. Validation every 3 epochs, region-mode val
  split (honest holdout).
- **37.7M params**, batch 64, NVIDIA L4, ~19 min/epoch → ETA ~21:30 UTC tonight.
- Early loss trajectory: epoch 0 → 2.10, epoch 1 → 1.90 (wcid 2.85 → 2.62).
  A v3-best checkpoint already exists, so the model has moved beyond the
  v2-best init weights it resumed from.

This run is doing double duty: it's the next-best unified checkpoint **and**
the validation pass for the trainer code committed today (`e5dca49`).

## 2. The model inventory — where everything is

| Lane | Model | Status | Role |
|---|---|---|---|
| **Terrain** | V3 conditional DDPM diffusion (~61M params) | Production | Smooths AI-generated heightmaps to retail feel (~15% denoise) |
| | V1/V2 U-Nets | Superseded | Earlier terrain attempts, kept for reference |
| **Macro** | Settlement planner (~100K MLP) | Working | Per-landblock archetype + family-bin distribution; conditions the scene placer |
| | Town placer / `reseed_town_*` | Working | Deterministic placement of named retail towns; not ML |
| **Population** | Outdoor scene placer (50.5M Transformer) | The thing that works | 83–85/100 on retail 20×20 regions; only stage with end-to-end measured quality |
| | WorldGrammar / TownGrammar | Trained, role fluid | Same architecture, different tensor source — sibling lane to OutdoorML, intentionally not its successor |
| | Unified scene placer v3 (37.7M, training now) | In flight | Replaces outdoor + adds interior in one corpus; class-rebalanced |
| | Unified v2 (37.7M, finished overnight Apr 26) | Best stable unified ckpt | Useful as a fine-tune base; would mode-collapse to model_id at inference if used directly |
| | Interior MLPs ×4 | Effectively retired | Quality numbers were leakage artifacts; not wired to inference; superseded by the unified model |
| **Heuristics** | `cluster_shuffle_populate`, `build_population_plan`, `remap_*` portal helpers | Working | Rule-based fillers and post-processors; not ML |
| **Validators / scoring** | `score_placement_quality` (regional), `compare_world_to_retail` (new, world-level) | Working | Eval-time only; the harness that produced the 83–85/100 numbers |

That is the complete list. There is no encounter/monster model, no NPC model,
no quest model, no vendor inventory model. Those are still the gaps.

## 3. End-to-end pipeline — how they chain (revised)

```
┌─ INPUT ─────────────────────────────────────────┐
│ AI-generated world image (Nano / etc.)          │
└─────────────────────────┬───────────────────────┘
                          ▼
┌─ TERRAIN ───────────────────────────────────────┐
│ QuickWorld:  image → terrain types + heights    │ ✓
│ V3 DDPM:     smooth jagged edges (~15%)         │ ✓
│ Output:      255×255 landblock heightmap        │
└─────────────────────────┬───────────────────────┘
                          ▼
┌─ MACRO ─────────────────────────────────────────┐
│ Town placer:  deterministic anchor towns        │ ✓
│ Settlement planner (ML): per-LB archetype/role  │ ✓
│ Output:      per-LB context vector              │
└─────────────────────────┬───────────────────────┘
                          ▼
┌─ POPULATION (outdoor) ──────────────────────────┐
│ Outdoor scene placer per landblock              │ ✓ (83–85/100)
│ WcidResolver bridges abstract_ace → wcids       │ ✓ (NEW, 4-27)
│ Output:   token sequences → object instances    │
└─────────────────────────┬───────────────────────┘
                          ▼
┌─ POPULATION (interior) ─────────────────────────┐
│ Same unified model, scene_kind = interior_*     │ partial:
│   - vocab/resolver path: ✓ ready                │   inference loop
│   - envcell component iteration: ✗              │   not yet wired
│   - scene_kind context switching at inference: ✗│
└─────────────────────────┬───────────────────────┘
                          ▼
┌─ POST-PROCESSING ───────────────────────────────┐
│ Housing canonicalization                        │ ✓
│ Service/lifestone/vendor completion injection   │ ✓
│ Portal target wiring (`remap_town_network_*`)   │ ✓
│ Geometric overlap rejection                     │ partial
└─────────────────────────┬───────────────────────┘
                          ▼
┌─ EVAL (NEW) ────────────────────────────────────┐
│ generate_populated_world --output-jsonl         │ ✓
│   ↓                                             │
│ compare_world_to_retail.py                      │ ✓ (NEW)
│   - mode collapse / over-replication            │
│   - wcid in wrong context                       │
│   - density drift                               │
│   - surface/interior shift                      │
│   - long-tail loss                              │
└─────────────────────────┬───────────────────────┘
                          ▼
┌─ GAMEPLAY (mostly empty) ───────────────────────┐
│ Encounters / monster spawns                     │ TODO
│ Vendor inventory tables                         │ TODO
│ NPC placement (distinct from creatures)         │ TODO
│ Treasure tables / loot rules                    │ TODO
│ Quests / scripts / dialogue                     │ TODO
└─────────────────────────┬───────────────────────┘
                          ▼
┌─ EXPORT ────────────────────────────────────────┐
│ SQL world dump → cell_*.dat → playable client   │ partial
└─────────────────────────────────────────────────┘
```

The chain is real and runs end-to-end *for terrain + outdoor population today*,
and now has a quantitative comparator at the end of that section. The interior
half is closer than yesterday — the vocab and resolver are in place — but the
inference loop itself doesn't yet emit interior sequences.

## 4. The class-imbalance trap (the real lesson of the day)

Worth its own section because it changes how to think about the unified
checkpoints currently on disk.

The unified abstract_ace vocab packs two qualitatively different things into
one token alphabet:

- **`model_id:N`** — direct DAT object IDs. ~4476 entries. These are static
  props (tables, candles, rocks, trees, walls). Cheap and abundant in retail.
- **`ace_abstract:B`** — abstract ACE buckets. ~108 entries. Each maps to a
  cluster of real wcids representing creatures, NPCs, vendors, and other
  ACE-side entities. Rare in retail relative to props.

Cross-entropy without rebalancing learns *the empirical distribution of the
training corpus*. Since the corpus is ~40× more `model_id` than `ace_abstract`,
sampling from the trained model produces ~40× more props than ACE entities.
The model isn't broken — it's faithfully reproducing the corpus's mix.

The fix (today's commit) is a per-class-space weight on the wcid
cross-entropy. Multiplying the 108 `ace_abstract` losses by 10 makes their
gradient magnitude roughly comparable to the 4476 `model_id` losses summed
over a batch. **Whether 10 is the right magnitude is an empirical question
the v3 run is currently answering.** Plausible failure modes:

- Too low (e.g. 2): residual collapse, ACE entities still under-emitted.
- Too high (e.g. 50): over-emission of creatures/NPCs, terrain becomes a
  mob soup; also risks unstable training.
- "Right" probably lives in 5–20; the v3 run picks the middle.

If v3's wcid loss curve looks reasonable but sampled outputs still skew prop-heavy,
the next iteration is either a higher weight or a temperature-on-class-space at
sampling time. If v3 over-corrects, drop the weight.

**Implication for the v1/v2 unified checkpoints**: they are still useful as
*architecture/feature* baselines and as fine-tune starting points (which is
exactly how v3 is using v2_best). But running inference directly off any
pre-rebalance unified checkpoint will produce a world that looks plausible
in shells and props but eerily empty of living entities. Don't ship that.

## 5. What the world will plausibly look like when this train converges

Two scenarios depending on whether the class rebalance lands cleanly.

**If v3 converges and the 10× weight is roughly right** (the optimistic case):

- Terrain that reads as retail-handcrafted at glance — V3 diffusion already
  delivers this.
- Towns sitting in geographically sensible places, with retail-recognizable
  density and service mix (vendors, lifestones, doors clustered correctly).
- Wilderness with biome-appropriate scatter, density falling off with
  elevation, ruins and camps appearing where retail puts them.
- Building shells in correct retail-like distributions in housing zones.
- Building interiors with model-id static furniture **plus** a sensible mix
  of ACE-bucket entities (some creatures, some NPCs in vendor archetypes,
  some ambient critters). The interior won't be hand-perfect, but it
  won't be a gallery of empty tables either.
- A quantitative comparator score (`compare_world_to_retail`) telling you
  per-region how the generated world stacks against retail across mode
  collapse, density drift, and wcid universe coverage.

**If v3 still mode-collapses or over-corrects** (the pessimistic case):

- Same terrain/town/wilderness picture as above (those don't depend on this
  run).
- Interiors and outdoor populations either still empty of living entities,
  or swarming with them. The architectural shell of the model is fine; you
  iterate on the weight and re-train. This is hours of work, not weeks.

In *both* scenarios you still don't have a single moving creature with
behavior, no vendors with inventory, no quests, no NPCs that aren't
generic templates, no loot in chests, no signal that one dungeon is
"level 30 troll lair" vs "level 5 starter cave". A beautiful, walkable,
content-appropriate-looking ghost world either way. That is genuinely a
meaningful achievement — most people in this dev community don't even
attempt this — but it's the architectural shell of a game, not a game.

## 6. What's needed next, in rough priority order

### Tier 1 — close the visual loop on the unified model

The original Tier 1 from April 26, with today's progress marked:

1. **Inference path for the unified model.** ⚠ Half done.
   - **Done today**: `WcidResolver` + `--abstract-resolver` flag bridges the
     abstract_ace vocab to inference. JSONL output mode lets you dump
     placements for the comparator.
   - **Still needed**: `generate_populated_world.py` only iterates landblocks.
     It needs an envcell-component iteration loop that emits interior token
     sequences with `scene_kind = interior_anchored / interior_unanchored`
     in the context vector, normalizes positions to component `boundsLocal`
     (not landblock 192 m), and writes interior placements alongside outdoor
     ones. Estimated 1 day if the existing iteration scaffolding is reused.
2. **Interior-component scoring harness.** ⚠ Partial.
   - **Today**: `compare_world_to_retail.py` is a *world-level* comparator
     that catches "surface/interior shift" as one signal among several. It
     can already tell you the surface/interior balance is wrong, and which
     wcids show up where they shouldn't.
   - **Still needed**: a focused interior-component quality metric — the
     interior analog to `score_placement_quality.py`'s 83–85/100 outdoor
     score. Without this you can't say "interior quality matches outdoor"
     vs "interior quality is degraded." Ideally derived from the same
     comparator infrastructure to keep the two scores comparable.
3. **Drop the four interior MLPs from the repo or mark them deprecated.** 🔲 Pending.
   - Their existence is still a footgun for future-you who won't remember
     which path is current. Cheap cleanup.

New Tier 1 item suggested by today's work:

4. **Validate the v3 class-rebalance empirically.** Once v3 finishes:
   - run inference on a known-good region (one we have outdoor 83–85/100
     scores for)
   - run `compare_world_to_retail` on the JSONL
   - check the wcid-class-space breakdown (ace_abstract vs model_id ratio
     in emitted output vs retail)
   - if ratio is sensible, ship v3 as the new baseline
   - if not, tune `--ace-abstract-weight` and re-fine-tune from v3_best
   This loop is an afternoon, not a week.

### Tier 2 — fill the gameplay box

Each of these is a project, not a task. Unchanged from April 26:

5. Encounter/monster model. Same autoregressive transformer architecture,
   conditioned on landblock context, trained on retail's `landblock_encounter`
   table. Lower-data than placement but tractable. Outputs sequences of
   (creature_wcid, position, group_size).
6. Vendor inventory model. Per-vendor classifier conditioned on archetype +
   tier. Smaller problem than placement; could be an MLP that outputs a
   probability distribution over wcids. Retail data is available.
7. NPC placement. Probably reuses the unified placer's machinery but with
   NPC-specific vocab. Population is small but high-stakes (every NPC is
   named and matters).
8. Loot/treasure tables. Bonus rules from retail; not really an ML problem,
   more an importer + per-area scaling rule.

### Tier 3 — quality of life and validation

9. Geometric overlap validator. "Object inside wall" / "table on top of
   table" rejection. Engineering, not ML. Probably feeds a final pass that
   re-runs the model with the bad placement masked out.
10. DAT writer parity. Make sure the SQL → `cell_*.dat` round-trip is lossless
    for everything the unified model can emit. There's existing terminal-side
    machinery; verify it covers the new tokens (especially `ace_abstract:B`
    after resolver expansion).
11. Procedural quest templates. This is where a small LLM (Sonnet/Haiku, NOT
    one of these placement models) earns its keep — generating sensible quest
    text, NPC dialogue, hint-string variations from a structured template +
    the world's actual contents.
12. **Cleanup**: replace deprecated `torch.cuda.amp.autocast` / `GradScaler`
    calls in `train_scene_placer.py` with the new `torch.amp.autocast('cuda', ...)`
    form. Trivial. Currently producing FutureWarnings on every run.

## 7. Honest meta-take

The April 26 take stands, with a small amendment.

**Placement is the hard, expensive problem to solve correctly, and you've
nearly solved it.** The unified scene placer, if v3 (or its successor)
converges with a calibrated class-space, is genuinely a real technical
achievement at retail-content-completeness — it's the harder half. But the
half it doesn't address (encounters / NPCs / vendors / quests / loot) is
still what makes the world *playable* rather than *visitable*.

The amendment from today: **the abstract-vocab idea was right but
under-specified.** Collapsing creatures, NPCs, and vendors into 108
buckets gives the model a tractable target space, but vanilla CE on a
heavily-imbalanced vocab silently undoes the work. The fix is a single
tensor multiply at training time and a sampler at inference time —
mechanically trivial, but the *kind* of issue that doesn't show up in
loss curves or even validation accuracy. It only shows up in the
distribution of what the model emits. This is exactly the failure mode
the new `compare_world_to_retail.py` exists to surface, which is why
it landed today as a peer to the trainer change.

Two structural choices to keep in mind, unchanged from April 26:

- The placement transformer architecture generalizes. Encounters, NPCs,
  vendors are all "given a context, emit a sequence of (entity_id, position)
  tuples." Same model class. Tier 2 is 3–4 instances of the *same*
  architecture trained on different retail tables — much less work than it
  sounds, *as long as you remember the class-imbalance lesson when defining
  each new vocab*.
- The non-placement gameplay (loot, quests, scripts) probably doesn't want
  to be a custom-trained model at all. Loot tables are rules. Quests are
  templates plus an LLM. Don't sink another six months training small
  models that compete poorly with rule-based or LLM-based approaches there.

If the v3 run finishes well and the rebalance looks calibrated, the right
next session is wiring up envcell-component iteration in
`generate_populated_world.py` (Tier 1 #1, the half that's still missing),
then running the validation loop (Tier 1 #4) end-to-end. Tier 2 is where
the AC-content-complete vision really gets tested.

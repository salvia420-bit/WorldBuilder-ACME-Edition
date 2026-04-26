# Pipeline Theory Overview

Date: 2026-04-26

This note captures the full ML pipeline state at the moment we kicked off the
first unified scene-placer training run. It is a snapshot of where the work is,
how the existing pieces compose, what the generated world will plausibly look
like when the current batch of work converges, and what is still missing.

It is intentionally a theory/orientation document, not a plan-of-record.

## 1. The model inventory — where everything is

| Lane | Model | Status | Role |
|---|---|---|---|
| **Terrain** | V3 conditional DDPM diffusion (~50M) | Production | Smooths AI-generated heightmaps to retail feel (~15% denoise) |
| | V1/V2 U-Nets | Superseded | Earlier terrain attempts, kept for reference |
| **Macro** | Settlement planner (~100K MLP) | Working | Per-landblock archetype + family-bin distribution; conditions the scene placer |
| | Town placer / `reseed_town_*` | Working | Deterministic placement of named retail towns; not ML |
| **Population** | Outdoor scene placer (50.5M Transformer) | The thing that works | 83-85/100 on retail 20×20 regions; the only stage with end-to-end measured quality |
| | WorldGrammar / TownGrammar | Trained, role fluid | Same architecture, different tensor source — sibling lane to OutdoorML, intentionally not its successor |
| | Unified scene placer (37.7M, training now) | In flight | Replaces outdoor + adds interior in one corpus |
| | Interior MLPs ×4 | Effectively retired | Quality numbers were leakage artifacts; not wired to inference; superseded by the unified model |
| **Heuristics** | `cluster_shuffle_populate`, `build_population_plan`, `remap_*` portal helpers | Working | Rule-based fillers and post-processors; not ML |
| **Validators / scoring** | `score_placement_quality`, `score_frequency_distribution`, etc. | Working | Eval-time only; the harness that produced the 83-85/100 numbers |

That is the complete list. There is no encounter/monster model, no NPC model,
no quest model, no vendor inventory model. Those are the gaps.

## 2. End-to-end pipeline — how they chain

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
┌─ POPULATION ────────────────────────────────────┐
│ Today:    outdoor scene placer per landblock    │ ✓ (83-85/100)
│ Next:     UNIFIED scene placer                  │ training
│   - outdoor landblock seqs (existing role)      │
│   - interior component seqs (new)               │
│   - scene_kind context switches the model       │
│ Output:   token sequences → object instances    │
└─────────────────────────┬───────────────────────┘
                          ▼
┌─ POST-PROCESSING ───────────────────────────────┐
│ Housing canonicalization                        │ ✓
│ Service/lifestone/vendor completion injection   │ ✓
│ Portal target wiring (`remap_town_network_*`)   │ ✓
│ Geometric overlap rejection                     │ partial
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

The chain is real and runs end-to-end *for terrain + outdoor population today*.
The unified scene placer's job is to unify the population stage so interior
content stops being an empty box on the diagram. Everything below "Gameplay"
remains a known gap.

## 3. What the world will plausibly look like when this train converges

If the unified run hits roughly the same regional quality as the outdoor
85/100 baseline (no reason it shouldn't, since it's the same architecture on
more data with cleaner conditioning):

You will have:

- Terrain that reads as retail-handcrafted at glance — V3 diffusion already
  delivers this.
- Towns sitting in geographically sensible places (next to coasts, on flatter
  ground), with retail-recognizable density and service mix (vendors,
  lifestones, doors clustered correctly).
- Wilderness with biome-appropriate scatter — pine vs cactus vs grass, density
  falling off with elevation, ruins and camps appearing where retail puts them.
- Building shells (cottages, villas, mansions) in correct retail-like
  distributions in housing zones.
- Building interiors with model-id static furniture (tables, shelves, chests,
  decoration) plus dynamic instances (lit candles, books, ambient clutter)
  arranged with locally retail-like patterns. The interior won't be
  hand-perfect, but it won't be empty either.
- Functional portals, lifestones, and basic service completion (the existing
  post-processing handles this).

You will NOT have without further work:

- A single moving creature in any of these landblocks. No monsters, no
  critters.
- Vendors with sensible inventory (the building shell exists; what they sell
  does not).
- Any quests at all.
- Any NPC who isn't a generic citizen template.
- Loot in any of those chests.
- Any signal that one dungeon is "level 30 troll lair" vs "level 5 starter
  cave" — the model places furniture, not gameplay difficulty.

In short: a beautiful, walkable, content-appropriate-looking ghost world. A
player would log in, run around, see retail-quality landscape and dungeons,
open a chest and find it empty, encounter no monsters, and have nothing to do.
That is genuinely a meaningful achievement — most people in this dev community
don't even attempt this — but it's the architectural shell of a game, not a
game.

## 4. What's needed next, in rough priority order

### Tier 1 — close the visual loop on the model we just trained

This is the natural next session.

1. Inference path for the unified model. `generate_populated_world.py` only
   knows about outdoor sequences today. It needs to also iterate envcell
   components and emit interior token sequences with the right `scene_kind`
   context. Roughly one or two days of work.
2. Interior-component scoring harness. Equivalent to
   `score_placement_quality.py` but at component level. Without this we have
   no honest number for interior quality. Once this exists we can compare the
   unified model's outdoor score (target: match 85/100) and its interior
   score (the new measurement) head to head.
3. Drop the four interior MLPs from the repo or mark them deprecated. Their
   existence is a footgun for future-you who won't remember which path is
   current.

### Tier 2 — fill the gameplay box

Each of these is a project, not a task.

4. Encounter/monster model. Easiest case: same autoregressive transformer
   architecture, conditioned on landblock context, trained on retail's
   `landblock_encounter` table. Lower-data than placement but tractable.
   Outputs sequences of (creature_wcid, position, group_size).
5. Vendor inventory model. Per-vendor classifier conditioned on archetype +
   tier. Smaller problem than placement; could be an MLP that outputs a
   probability distribution over wcids. Retail data is available.
6. NPC placement. Probably reuses the unified placer's machinery but with
   NPC-specific vocab. Population is small but high-stakes (every NPC is named
   and matters).
7. Loot/treasure tables. Bonus rules from retail; not really an ML problem,
   more an importer + per-area scaling rule.

### Tier 3 — quality of life and validation

8. Geometric overlap validator. "Object inside wall" / "table on top of
   table" rejection. Engineering, not ML. Probably feeds a final pass that
   re-runs the model with the bad placement masked out.
9. DAT writer parity. Make sure the SQL → `cell_*.dat` round-trip is lossless
   for everything the unified model can emit. There's existing terminal-side
   machinery; verify it covers the new tokens.
10. Procedural quest templates. This is where a small LLM (Sonnet/Haiku, NOT
    one of these placement models) earns its keep — generating sensible quest
    text, NPC dialogue, hint-string variations from a structured template +
    the world's actual contents.

## 5. Honest meta-take

The thing that keeps making this project feel like wheel-spinning is that
**placement is the hard, expensive problem to solve correctly, and you've
nearly solved it**. The unified scene placer, if it converges, is genuinely a
real technical achievement at retail-content-completeness — it's the harder
half. But the half it doesn't address (encounters / NPCs / vendors / quests /
loot) is what makes the world *playable* rather than *visitable*.

Two structural choices to be aware of:

- The placement transformer architecture generalizes. Encounters, NPCs,
  vendors are all "given a context, emit a sequence of (entity_id, position)
  tuples." Same model class. So Tier 2 isn't 4 fundamentally new architectures
  — it's 3-4 instances of the *same* architecture trained on different retail
  tables. That's much less work than it sounds.
- The non-placement gameplay (loot, quests, scripts) probably doesn't want to
  be a custom-trained model at all. Loot tables are rules. Quests are
  templates plus an LLM. Don't sink another 6 months training small models
  that compete poorly with rule-based or LLM-based approaches for those.

If/when the overnight unified run finishes well, the right next session is
closing the loop (Tier 1: inference + scoring + retire the dead MLPs) before
scoping Tier 2. Tier 2 is where the AC-content-complete vision really gets
tested.

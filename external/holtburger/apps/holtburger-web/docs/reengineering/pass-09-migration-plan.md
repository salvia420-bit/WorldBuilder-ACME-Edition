# Pass 09 — Migration plan: dual-dist coexistence, flag strategy, eye-test gates, kill criteria, doc propagation

Pass 9 of 12. Governed by `TRACKING.md`'s protocol header. This pass turns passes 1–8
into an **additive rollout**: the stage graph (each stage independently shippable, behind
a named flag, with a fallback path, a promotion bar, kill criteria, and the measurement
that gates it — measurements are NAMED for pass 10, not designed here); the bake-side
rollout with its validation and rollback story; the flag/defaults policy per the house
rules (validated gates ship DEFAULT-ON with a one-flag `=off` escape; the promotion bar
is "bare-default loads + spawns + 0 console errors"; structural render changes
additionally take an owner eye-test on the 1070; development happens flagged-OFF;
eye-tests are batched into one 1070 session; HUD-class fixes skip flag gating,
render/physics/movement changes do not); and the doc-propagation duties the walls demand
("propagate verdicts to the docs agents read, same day" — three research cycles were
lost to stale docs in one week). The survey §5 constraint binds every stage: **the live
client keeps working at every point of this plan.** Source classes per R7: **[M]**
measured (doc named), **[D]** derived, **[A]** assumed-pending-measurement.

The pass's core input is the accumulated handoff ledger: passes 1–8 each left explicit
pass-9 duties. Spec S0 is the complete inventory, each duty mapped to the stage that
discharges it — a missing row there is a compliance failure by this pass's own charge.

## Inputs read

Opened in THIS session (file:line cited where load-bearing):

- `docs/reengineering/TRACKING.md` — lines 1–103 (all).
- `docs/2026-08-08-pipeline-reengineering-survey.md` — lines 1–153 (all; §5 sequencing
  note, §6 walls incl. flag-bit≠predicate/ClipMap and same-day propagation).
- `docs/reengineering/pass-01-requirements-charter.md` — lines 1–401 (all; H7, N8,
  D-01.7 I1 "old dist stays servable", A4 migratability, S2 bare-default binding).
- `docs/reengineering/pass-02-world-pack-format.md` — lines 1–600 (all; D-02.6, D-02.10
  `--emit-packs`/`--legacy-layers` spec'd as NEW capability, S7 manifest v3, H-02.5).
- `docs/reengineering/pass-03-wire-and-fetch.md` — lines 1–646 (all; D-03.1 pinning,
  D-03.9 SW v3, D-03.10 legacy lane, S6.3/S6.4, S10 deletion ledger, H-03.4, Q3).
- `docs/reengineering/pass-04-geometry-spec.md` — lines 1–607 (all; D-04.5, encoding
  0x0000 fallback state, H-04.5, H-04.6d byte-identity differ, Q5).
- `docs/reengineering/pass-05-texture-spec.md` — lines 1–768 (all; D-05.3 q75 gate,
  D-05.5/D-05.6 structural texture changes, H-05.4, Q2/Q3).
- `docs/reengineering/pass-06-residency-architecture.md` — lines 1–686 (all; H-06.3
  `?slotGrid` staging, S6 deletion ledger, the S15-ladder precedent).
- `docs/reengineering/pass-07-scene-and-draw-architecture.md` — lines 1–795 (all;
  D-07.10 flag composition, H-07.2 gates + doc duties, Q7).
- `docs/reengineering/pass-08-frame-loop-and-scheduling.md` — lines 1–745 (all; H-08.1
  three-sub-stage `?frameWork` order, H-08.4 co-landing constraint).
- `scripts/serve.py` — lines 1–731 (all): single canonical root + `DEFAULT_ROOT`
  constant (87), `HOLTBURGER_DIST` env override (109–112), `ensure_dist_symlink`
  actively re-points `external/holtburger/dist` at the configured root on EVERY start
  (152–177 — hand-fixed symlinks are reverted, the 2026-08-02 comment at 66–77
  documents exactly this); `--check`/`--allow-missing` validation of
  manifest.json + shards/scenery/spawns with content-aware spawns/scenery arms
  (89–94, 217–284); `_health.json` (297–302); header tiers — `/dist/shards/`
  immutable on 2xx only (615–616), revalidate tier (617–632), no-store tier
  (633–636); no `packs/`/`index/` rule exists today.
- `crates/holtburger-manifest/src/v2.rs` — lines 1–555 (all): `ManifestVersionProbe`
  (239–242), `ManifestV2` derives plain serde `Deserialize` with NO
  `deny_unknown_fields` (189–194) — unknown fields are ignored by v2 parsers;
  probe-then-route contract (490–519 tests).
- `crates/holtburger-resource-http/src/manifest_source.rs` — lines 339–366:
  `connect` routes `version == 1 | MANIFEST_V2_VERSION`, and **any other version is a
  hard `UnsupportedVersion` error** (364) — a deployed client cannot parse a
  `version: 3` manifest at all.
- `apps/holtburger-web/scene3d/bc7_textures.js` — lines 90–134: the shared
  `flagIsOff` predicate (101–105) and the exact-value/default-ON reader pattern
  (`bc7Enabled`, 111–132) all new flags must reuse.
- `docs/url-flags.md` — lines 1–30 (the canonical-flags-doc header: the two lint
  tools `scripts/lint-url-flags.mjs --strict` and `scripts/audit-flag-defaults.mjs
  --mismatch` that keep rows honest, 12–16; §0 default-OFF flip-criteria discipline),
  line 285 (`texFreeCpu` row with its (a)/(b) preconditions), lines 505–507
  (`fixedGrid`/`fixedGridPark`/`fixedGridSealedFreeze` rows — the S15/S16 staging
  precedent this plan reuses).
- `apps/holtburger-tools/src/bin/dat-shard.rs` — targeted scan: existing flags are
  `--input/--output/--boot-landblock/--verify-boot-reachability/--tex-bc7/
  --manifest-version` (doc line 51; CLI tests 220–268 displayed); no
  `--emit-packs`/`--legacy-layers` surfaced — consistent with pass 2 D-02.10's own
  framing of them as NEW ("the existing binary gains").

## Decisions

### D-09.1 — Dual-dist coexistence: ONE tree, additive layers, ONE mutable manifest routed by FIELD PRESENCE; the version sentinel stays 2 until legacy retirement

**Mechanics (normative):**

1. **One dist tree carries both formats.** The pack bake (`dat-shard --emit-packs
   --legacy-layers`, pass 2 D-02.10) emits `packs/` + `index/` + the new manifest
   fields BESIDE today's `shards/`, `manifest/*.bin`, `boot.hba`, and side-trees, in
   the same output root. There are never two dist roots to keep in sync: serve.py
   serves exactly one root through one symlink and actively re-points that symlink at
   its configured root on every start (serve.py:152–177), so a "second dist" would
   require either a second server instance fighting over the same symlink or manual
   symlink discipline the server is explicitly designed to revert. Single-tree
   dual-format is the only shape the existing infrastructure supports without
   modification, and it is also the cheapest (CAS: unchanged bytes shared).
2. **`manifest.json` stays `version: 2` throughout coexistence, gaining the v3 fields
   additively** (`world_index`, `pack_url_template` per pass 2 S7). Old clients parse
   it as v2 and ignore the unknown fields (read-verified: `ManifestV2` has no
   `deny_unknown_fields`, v2.rs:189–194). New clients route on **presence of
   `world_index`**, not on the version sentinel. At stage ST10 (legacy retirement)
   the sentinel flips to 3 and the legacy fields (`shard_url_template`,
   `catalog_url_template`, `boot_pack`, `catalog_version`) drop.

   > **SUPERSEDES pass-02 S7 (version sentinel during migration) because** the
   > deployed client's `connect` hard-fails on any manifest version other than 1 or 2
   > (`UnsupportedVersion`, read-verified manifest_source.rs:341–365). Serving
   > `version: 3` at the ONLY mutable URL during coexistence would brick every
   > pre-migration client — including SW-cached app shells and long-lived 1070
   > sessions — the moment the bake lands. Pass 2's v3 field SET is unchanged; only
   > the sentinel's value during coexistence changes. Pass 3 D-03.1's "one mutable
   > URL" invariant is preserved exactly by this shape (the rejected alternative —
   > a second `manifest.v3.json` — would have created a second mutable URL).
3. **Version-pinned sessions + N−1 retention** (pass 3 D-03.1/S6.4 adopted): sessions
   pin the index they booted; the host retains the previous bake's index + packs
   beside the current (CAS makes this cheap — cost ≈ one bake's churn); bake tooling
   GC removes older-than-N−1 (S3.4). A mid-session re-bake therefore never breaks a
   running client on either path (legacy layers are additionally kept until ST10).
4. **serve.py changes (landed at ST1, spec'd here per R3):** (a) the
   immutable+identity header rule for `/dist/packs/` + `/dist/index/` mirroring the
   existing shards rule (serve.py:615–616; pass 3 S6.3); (b) `--check` extension: when
   the manifest advertises `world_index`, `packs/` (populated prefix buckets, same
   check shape as shards, serve.py:261–278) and the index file become REQUIRED layers
   with `_health.json` rows — fail-loud, the scenery-disappearance lesson
   (serve.py:246–259) applied to the new layers on day one; (c) the `DEFAULT_ROOT`
   repoint-with-comment convention (serve.py:66–87) is the documented mechanism for
   pointing local dev at a new bake.
5. **Disk cost accepted** (charter N8): dual emission ≈ legacy 8.9 GB on-disk + the
   pack tree; disk is not a metric (charter N5). Bake time for dual emission is
   bounded by making `--legacy-layers` reuse the already-loaded bundle (pass 2
   D-02.10's shared `LoadedBundle`).

*Rejected:* two dist roots with an env-var switch (fights `ensure_dist_symlink`,
doubles bake orchestration, and makes A/B arms differ by more than the flag under
test); a second mutable manifest URL (splits the one-mutable-URL invariant pass 3's
SW/offline story rests on); flipping the sentinel early with a client patch released
first (unenforceable against cached app shells — the SW serves stale app code across
restarts, the documented `?nosw` trap class).

### D-09.2 — Stage graph: two parallel tracks + one retirement stage; every stage is one master flag whose OFF arm is today's code path

Ten stages, ST1–ST10 (full cards in S2). Shape rules:

- **Track W1 (wire/dist):** ST1 dual-emit bake → ST2 pack client (records-only) →
  ST3 GEOM bundles → ST5 compressed-only textures → ST6 q75 corpus. ST4 (texture
  worker) is track-independent and lands early.
- **Track W2 (residency/draw):** ST7 slot grid → ST8 frame-work scheduler stage A →
  ST9 draw pools + scheduler stages B/C. W2 proceeds on the LEGACY fetch stack
  (pass 7 D-07.10's migration state) so the tracks parallelize exactly as survey §5
  intends (W1 additive, de-risks W2).
- **ST10 (retirement)** executes the four deletion ledgers (pass 3 S10, pass 6 S6,
  pass 7 S6, pass 8 S8) only after its criteria (D-09.8) hold.
- **Every stage's fallback is the unmodified current path behind one flag** — kill is
  a one-flag revert by construction (pass 7 D-07.10 established this for pools; it is
  generalized here as a stage-design rule). No stage deletes its OFF arm before ST10.
- **Flag composition (dependency edges):** `?drawPools` requires `?slotGrid`
  (pass 7 D-07.10, adopted); `?texCompressedOnly` requires `?packSource` (frame-1
  previews read resident PVW packs, pass 5 S4) and uses `?texWorkers` when armed
  (FIFO fallback otherwise — pass 5 D-05.4); `?geomBundles` requires `?packSource`
  (bundles read GEOM sections); `?frameWork` stage C (upload staging) lands together
  with `?drawPools`' feed path (pass 8 H-08.4 — they share the LIVE-flip ordering
  invariant). A flag armed without its prerequisite logs one loud console error and
  behaves as OFF (never a silent half-configuration).
- **Ordering rationale (risk vs early value):** ST4 and ST8 are low-risk,
  render-invisible, and attack the measured tail — they ship first for early
  validated value. ST2 delivers the wire multiples (B-series) with zero render-path
  change (the fetch layer swaps under an unchanged `ResourceSource` read contract,
  pass 3 S1.3). The eye-gated structural stages (ST3, ST5, ST9) are sequenced so each
  1070 batch carries a coherent set (D-09.5). ST6 is bake-side only and gated on an
  owner's eye. ST9 is last of the big structural stages because it consumes ST7's
  events and ST8's scheduler.

*Rejected:* one big-bang `?v2pipeline` flag (unattributable regressions; violates
independently-shippable); per-module micro-flags beyond the master set (the flag audit
already manages 547 flags — every new flag is a standing cost; sub-flags exist only
where a prior pass named one, e.g. `?atlasPreviewCommit`, `?fixedGridPark`-style
sub-escapes); sequencing W2 after W1 completes (loses months of parallel soak the
S15/S16 precedent shows is safe on the legacy stack).

### D-09.3 — Flag lifecycle and defaults policy (house rules codified as normative stages)

Every stage flag passes through exactly four states:

| state | reader semantics | who runs it |
|---|---|---|
| **DEV** | default-OFF; STRICT exact `=on` opt-in (the `texFreeCpu` pattern, url-flags.md:285) | developers + bots only |
| **VALIDATED** | still default-OFF; promotion bar (D-09.4) met and recorded in the url-flags row | candidates queued for the next default-flip window |
| **DEFAULT-ON** | default-ON with `=off` escape via the shared `flagIsOff` predicate (bc7_textures.js:101–105); the reader is a `*Enabled()` function, never an inline parse | everyone |
| **RETIRED** | flag + escape arm + OFF-path code deleted (ST10 or a stage-local retirement); url-flags row REMOVED, not stranded | — |

Normative rules:

1. **Predicate discipline.** Every new reader imports `flagIsOff` (or the exact-match
   opt-in helper for DEV state) — the documented footgun is that a hand-rolled
   `!== "off"` reads ON when absent (the flag-bit≠predicate wall; the divergence
   history is written into the predicate's own doc block, bc7_textures.js:90–97).
   DEV-state flags MUST be `=== "on"`-class exact opt-ins; DEFAULT-ON-state flags
   MUST be `!flagIsOff(...)`. The state transition is a one-line reader change.
2. **Doc-row-or-fail.** A flag lands in the same commit as its url-flags.md row, and
   `lint-url-flags.mjs --strict` + `audit-flag-defaults.mjs --mismatch` must both
   pass (url-flags.md:12–16 — the CI ratchet already exists; this plan just makes it
   a stage-checklist line). A DEV-state flag gets a §0 row stating its flip evidence
   — which is its D-09.4 promotion bar, by reference.
3. **One default flip at a time, one clean soak between flips.** Default flips are
   serialized (≥1 full daily-loop day + the stage's bench cycle between flips) so a
   regression is attributable to one flip (boot-variance wall: cross-boot comparisons
   are noise; the soak is observational, the DECISION evidence is the same-session
   interleaved bench in the promotion bar).
4. **HUD-class exemption restated:** HUD/diagnostic-surface fixes ship direct,
   unflagged. Everything this plan stages is render/physics/streaming-class and gets
   a flag. (No physics changes exist in this program — pass 8 D-08.1.)
5. **New-flag register for this program** (names bind implementations):
   `?packSource` (ST2 master; CompositeSource order — pass 3 H-03.4's asked-for
   flag), `?geomBundles` (ST3), `?texCompressedOnly` (ST5 master), plus the
   prior-pass-named `?fetchCap`, `?packVerify` (pass 3), `?texWorkers`,
   `?atlasPreviewCommit` (pass 5), `?slotGrid` (pass 6), `?drawPools`
   (pass 7), `?frameWork`, `?workBudget`, `?upBudget*`, `?workShrink` (pass 8).
   `?texWorkers`'s end-state default is 1 (pass 5 S3); during DEV it reads 0 —
   the end-state spec is unchanged, only the rollout path is defined here.

### D-09.4 — The promotion bar: one uniform floor + a stage-specific measurement gate + an eye item for structural stages

A stage flag moves DEV → VALIDATED only when ALL of:

1. **Uniform floor (every stage):** with the flag armed — (a) T2 SwiftShader bare
   boot: loads + spawns + **0 console errors**; (b) T2 bot boot
   (`?nullRender=1` route) completes ≤120 s, 0 page errors (charter M9's gate);
   (c) 1070 headless boot + the standard six-town route: 0 console errors, 0
   context losses attributable to the stage. "Bare-default" at flip time means the
   flag's ON state with NO other tuning flags (charter S2's binding rule).
2. **Stage measurement gate** — the named pass-10 protocol for that stage (S2 cards
   name each): emulated-666 kbps cold-boot bench with per-component attribution
   (B-series stages); fixed-pose moving bench + stall-probe walk (frame/tail
   stages); six-town memory route + 30-min ultra session (memory stages); census CI
   gates (residency/pool stages). Comparisons are same-session interleaved arms,
   fresh Chrome profile per arm — never cross-boot single shots (walls).
3. **Eye item (structural render stages only):** the stage's register entry
   (D-09.5) passed by the owner on the 1070. The ClipMap failure is the binding
   precedent: a large translucent object went fully opaque while every recorded
   metric read clean (survey §6) — no metric gate substitutes for the eye on a
   pass-membership/keying/winding/quantization/tier-class change.

VALIDATED → DEFAULT-ON is then a one-line reader change + doc-propagation checklist
(D-09.9), serialized per D-09.3.3. Stages ST1 and ST6 have no client flag (bake-side);
their "promotion" is "clients may point at this dist" and the bar is D-09.7's
validation gates (+ the ST6 eye item).

### D-09.5 — Eye-test gate register and 1070 batching

**Register (E-items).** Each is a structural render change some pass flagged; each
names what the owner must LOOK AT (the checklist shape is the frame-cost doc's §5f
per pass 7's reading — known-translucent objects, pass membership, silhouettes —
extended per item). Verdict semantics: CLEAN ⇒ promotion may proceed; DIRTY ⇒ the
stage stays flagged-OFF and the finding becomes a defect, never a "ship and tune".

| E | stage | what changed structurally | what the eye must check |
|---|---|---|---|
| E1 | ST3 | consumer swap `meshToGeometryGroups`→`bundleToGeometryGroups`: bake-time triangulation, snorm8 normals, subset regroup, source-order winding (pass 4 H-04.5) | town + dungeon vantage: winding (no inside-out props), shading parity (normal quantization), stipple/two-sided classes, LOD swap at the ~100 m band |
| E2 | ST5 | frame-1 preview world + preview-commit/re-home atlas (pass 5 D-05.5/D-05.6.3) | boot sequence: never-white materials, preview→full sharpening without flicker/holes; the 79%-held-out prop class now batched and CORRECT; array mip/aniso parity vs singletons; terrain t128→t1024 swap seam |
| E3 | ST5 | worker-derived half-res NRA replaces full-res Sobel-from-RGBA8 (pass 5 Q3) | side-by-side flagged arm: relief/shading parity on stone/wood/metal classes; no flattening |
| E4 | ST6 | q75 lossy full-tier corpus (pass 5 D-05.3; owner: redmi) | the existing contact sheets at `/mnt/wbterminal2/xubc7-proto/results/sheets/` + an in-world pass over painted/emblem surfaces; DIRTY ⇒ corpus stays lossless, classifier-mixed encode becomes the follow-up |
| E5 | ST7 | slot grid as residency authority for statics/buildings/cells (pass 6 H-06.3) | walk across shift boundaries: no seams/holes/ghosts at grid edges; teleport arrival completeness; sealed-hub enter/exit |
| E6 | ST9 | first pooled world + class-keyed materials + receiveShadow coarsening (pass 7 H-07.2/Q7) | town + Town Network: pass membership (known translucents STILL translucent — the ClipMap item itself), depth-bias classes (floors not z-fighting), a shadowed-town vantage for building receiveShadow, envcell baked-light parity |
| E7 | reserved, post-v1 | `?poolAdditiveNoSort` (pass 7 D-07.3) | additive z-interleave vs translucents |
| E8 | reserved, post-v1 | f16 UVs (pass 4 Q5) | texel swim at high wrap magnitudes |

**Batching (1070-eyetests-batched rule):** three planned sessions, aligned to the
tracks — **Batch A** = E1 (+ pass 10's piggyback probes: `crypto.subtle`
availability, `initTexture` behavior, 88 MiB upload timing — same session, off-screen,
per the runbook's off-screen/headless-only constraint); **Batch B** = E2 + E3 + E4
(one texture-era session); **Batch C** = E5 + E6 (residency/draw era; E5 may pull
into Batch B if ST7 is ready first). A stage whose eye item misses its batch waits
for the next one — promotion cadence is quantized to 1070 sessions, and that cost is
accepted (the alternative, ad-hoc sessions on a person's machine, is what the rule
exists to prevent). All items run off-screen/headless; screenshots + flag-pair URLs
are prepared in advance so a batch is minutes, not hours.

### D-09.6 — Kill criteria and revert semantics: four revert classes; every kill names its metric's scale and protocol class

**Revert classes:**

- **K1 — session flag flip** (`?flag=off`): the user-level escape; always available
  from DEV onward; not a rollout action by itself.
- **K2 — default flip-back**: one-line reader change back to OFF; the standard kill
  for any client stage; the OFF arm is guaranteed intact until ST10 (D-09.2).
- **K3 — dist repoint**: bake-side kill. Because everything below the manifest is
  CAS and N−1 is retained (D-09.1.3), reverting a bad bake = re-serving the previous
  manifest content (one small file) — running pinned sessions are unaffected, new
  boots get the previous world. Local dev: `HOLTBURGER_DIST` env / `DEFAULT_ROOT`
  repoint (serve.py:87, 109–112).
- **K4 — SW cache bump**: bump `CONTENT_CACHE` name so the activate-step prefix GC
  purges a poisoned cache (pass 3 D-03.9's v2→v3 mechanism, reusable for any
  SW-level kill); `?nosw=1` remains the per-session hard bypass.

**Wall compliance rule (normative):** every kill criterion below states its metric
with SCALE (parked vs moving; p50 vs p95/p99; resident vs submitted; allocated vs
used) and its PROTOCOL CLASS (same-session interleaved A/B; fixed-pose moving bench;
emulated-666 wire bench, cold vs warm cache stated; six-town memory route; 30-min
ultra soak; census CI gate). A kill argued from a cross-boot single-shot comparison
is invalid — re-run it interleaved before acting (boot-variance wall).

Per-stage kill table is S2's rightmost concern and S6 collects it; headline examples:
ST2 kills on cold-boot regression (bytes or requests to `preview-complete`, emulated
666, interleaved packs-vs-legacy arms) or any terminal tile quarantine on a healthy
dist (K2); ST9 kills on fixed-pose moving p50/p99 regression vs the same-session
`?drawPools=off` arm, or `classesCreatedPostBoot > 0`, or a GPU-boundedness flip
(charter D-01.5's re-check duty) (K2); ST6 kills on the eye alone (K3).

### D-09.7 — Bake-side rollout: what validates a dist before ANY client points at it; rollback story

**When the new bake runs:** ST1 lands the dual-emit bake; from then on every bake is
dual-emit until ST10. Cadence unchanged (on-demand, buildbox for heavy encodes —
zstd-19 tiles and the XUBC7 re-encode are buildbox jobs per pass 2 Q1/pass 5).
Inputs: `~/ac_base_dats/` only, `0x__FFxxxx` rejected, `bake-source.sha256`
provenance emitted (the standing bake-source rule; serve.py already surfaces
provenance sidecars, serve.py:139–149).

**Validation gates — ALL must pass before a client is pointed at a new-format dist
(CI-shaped; pass 10 wires them into automation):**

1. `--verify-closure` — every REFS edge in every emitted pack resolves; every
   TEXREF'd rsId has a PVW row (`texrefMissingPvw = 0`, pass 5 D-05.5.4). Fail =
   no deploy (the anti-silent-empty-world rule made structural).
2. `--verify-deterministic` — sample-tile re-bake reproduces byte-identical hashes
   (pass 2 D-02.6).
3. **Byte-identity differ** (pass 4 H-04.6d): for N sample models + envcells, bundle
   geometry ≡ runtime-decoded geometry, byte-exact. This is the gate that lets ST3's
   FIRST eye-test carry the consumer-swap seam only, with bake correctness proven
   mechanically ("Rust cache = byte-identical" principle — but the first switch-on
   still takes E1, as pass 4 states).
4. `serve.py --check` extended (D-09.1.4): packs/index/health rows present and
   populated when the manifest advertises `world_index`.
5. **Boot smoke on the staged dist:** one T2 bot boot + spawn against the new tree
   with `?packSource=on` before the manifest goes live to anyone else.
6. Legacy-layer equivalence during coexistence: `--legacy-layers` output passes the
   UNCHANGED existing checks (`--check` today's arms) so legacy clients are provably
   unaffected by a dual-emit bake.

**Rollback story for a bad bake:** K3 — restore the previous `manifest.json` (or
repoint the root); pinned sessions were never at risk (D-09.1.3); CAS means the
previous bake's packs are still on disk (N−1 retention); the GC never deletes the
serving bake or its predecessor. A bad bake discovered by gate (1)–(6) never ships;
one discovered in the wild (hash-mismatch counters, quarantine counters on the
`__hbFetch` diag per pass 3 S9) is a K3 + an incident row in the propagation ledger.

### D-09.8 — Legacy retirement criteria (ST10): measured-zero, soaked, then delete

ST10 executes only when ALL hold:

1. **Legacy-lane worldload = 0** over the full bench battery (six-town route + boot
   + dungeon entries) — the legacy per-record lane served ZERO world-content records
   (counter on the CompositeSource fallback; equipment/entity records excepted, they
   ride the lane permanently per pass 3 D-03.10). This is pass 3 H-03.4's criterion,
   adopted verbatim.
2. Every client stage flag (ST2–ST5, ST7–ST9) has been DEFAULT-ON for ≥2 bake cycles
   AND ≥2 full bench cycles with no K2 reversion.
3. The pass-6 census reads the retirement shape: worker `packBytes: 0`,
   `shardRecords: 0`; `geomFallback.modelsServedByRuntimeDecode` trends entity-only
   (pass 4 S7).
4. An owner go (the deletion is irreversible without re-bake work).

Then, in order: manifest sentinel 2→3, legacy fields dropped; `--legacy-layers`
stops being passed; legacy layers GC'd from the dist; the four deletion ledgers
execute in dependency order (pass 3 S10 fetch machinery → pass 6 S6 LRU/governor →
pass 7 S6 producers/atlas → pass 8 S8 frame relocations' leftovers); post-migration
cache budgets arm (pass 6 S3's "post-migration" column: tri 16 MiB, surface 48 MiB
summed, legacy shard cache 32 MiB); SW allowlist drops `shards/`; stage flags move
to RETIRED (rows deleted, escape arms deleted). Each ledger execution is itself a
commit-with-doc-propagation event (D-09.9).

### D-09.9 — Doc-propagation duties: a same-day checklist per event class, plus the accumulated stale-wording register

The wall is explicit: verdict drift cost three full research cycles in one week.
This plan makes propagation a CHECKLIST ITEM of every stage landing/flip/kill — the
commit that changes behavior is not done until the checklist is (S7 is the normative
checklist; the register of ALREADY-FLAGGED stale wordings from passes 4–8 is S7.3,
and clearing each register row is bound to a named stage). Three normative rules:

1. **Same-day, same-commit where possible.** Instrument-wiring renames land in the
   same commit as the rename (pass 8 S7.3's rule, generalized); url-flags rows land
   in the flag's commit (D-09.3.2); measurement-doc superseded-banners land the day
   the superseding verdict exists (the frame-cost doc's banner style is the model).
2. **The survey and this folder are corrected at implementation time, not during
   spec passes** (R3 forbids passes editing the survey; the duty transfers to the
   landing session, and the stage checklist carries it — first instance: the survey
   §4 I4 "designed … never built" wording pass 6 read-verified FALSE).
3. **MEMORY.md is the user's file**: agents do not edit it unprompted. The checklist
   line is "notify the owner which memory pointers went stale" (e.g. the
   staleness-rebuild and chrome-testing runbooks once serve/dist/flags change).

## Spec

### S0 — Inherited-handoff inventory (the compliance ledger: every pass-9 duty from passes 1–8 → the stage/section that discharges it)

| # | source | duty (condensed) | discharged by |
|---|---|---|---|
| 1 | P1 H7 | flag/defaults policy applied per stage; eye-gates scheduled into 1070 batches | D-09.3/D-09.4; D-09.5 batches A–C |
| 2 | P1 N8 + D-01.7(I1) | live client works throughout; old dist stays servable; dual-dist cost is pass 9's to minimize | D-09.1 (single tree, CAS sharing); D-09.2 fallback rule |
| 3 | P2 H-02.5 | dual-dist mechanics (`--legacy-layers`); retirement criteria for shards/catalogs/boot.hba; first pack-served-world eye-gate | D-09.1; D-09.8; E1 (ST3) with ST2's mechanical differ (D-09.7.3) |
| 4 | P2 S7 + D-02.6 | manifest dual-stack; legacy layers emitted side-by-side during migration | D-09.1 (incl. the SUPERSEDES on the sentinel) |
| 5 | P3 H-03.4 | CompositeSource order flag; serve.py packs header rule; SW v2→v3 timing; legacy-lane retirement criterion (worldload=0); dist retention GC; `?nosw`-class doc updates | `?packSource` (D-09.3.5); ST1 (D-09.1.4); ST2 card (S2); D-09.8.1; D-09.7/S3.4; S7 checklist |
| 6 | P3 S6.3/S6.4 | serve.py one-rule addition lands via pass 9; host retains N−1, bake tooling owns GC | ST1; D-09.1.3 + S3.4 |
| 7 | P3 S10 | deletion ledger executes at legacy-lane retirement | ST10 (D-09.8) |
| 8 | P3 Q3 | hashed-filename app shell — pass 9 or owner call | Open question Q2 (deferred post-v1, owner call) |
| 9 | P4 H-04.5 | encoding 0x0000 as fallback state; per-consumer swap behind the pack flag; eye-gate for the swap; doc duty for deleted geom-audit machinery | ST2 (0x0000)/ST3 (`?geomBundles`, per-consumer order in S2); E1; S7.3 row |
| 10 | P4 H-04.6d | byte-identity differ as bake gate; FIRST switch-on still eye-tested | D-09.7.3; E1 |
| 11 | P4 Q5 | f16-UV eye-test, post-v1 | E8 (reserved register row) |
| 12 | P5 H-05.4(1) + D-05.3/Q2 | re-encode sequencing lossless→q75 behind the pass-9 gate; **B4-overrun owner decision** (rdo arm vs relax to ~65 MB) | ST6 + E4; owner-decision row in S6/Open Q1 |
| 13 | P5 H-05.4(2) + Q3 | preview-commit atlas + worker-NRA parity ride the migration eye-gate | E2, E3 (Batch B) |
| 14 | P5 H-05.4(3) | tex-bc7 / tex-bc7-pre layer retirement criteria | ST10 (D-09.8; the corpora die with the legacy layers) |
| 15 | P5 H-05.4(4) | doc duties: bc7_textures.js header, url-flags rows, texFreeCpu preconditions | S7.3 rows (ST5) |
| 16 | P6 H-06.3 | `?slotGrid` staging ladder (default-OFF → battery + eye → ON); doc duties: landblock_lru header, url-flags 505–507, survey I4 correction | ST7 card; S7.3 rows |
| 17 | P6 S6 | deletions stage through pass 9; LRU retires only after full-battery soak | ST7 (LRU-as-assert during soak) + ST10 |
| 18 | P7 H-07.2 + D-07.10 + Q7 | `?drawPools` staging (requires `?slotGrid`); eye-gates: pooled world, receiveShadow shadowed-town vantage, reserved additive-unsort; **pool-vs-legacy A/B staging** (OFF arm = today's producer stack); retirement sequencing; doc duties | ST9 card; E5–E7; D-09.2 fallback rule; ST10; S7.3 rows |
| 19 | P8 H-08.1 | `?frameWork` three-sub-stage order (W6 registration → P4 relocation → upload staging); doc duties (p99-doc prewarm staleness; new flag rows) | ST8/ST9 cards; S7.3 rows |
| 20 | P8 H-08.4 | P4 relocation + upload staging land TOGETHER with pools' feed path | ST9 card (co-landing constraint) |
| 21 | Charter A4 | pass 12 must show migratability: stages, kill criteria, fallbacks, flag policy, named eye-gates | this document, S1–S7 (input to pass 12) |

### S1 — Stage graph (summary; dependency edges are the flag-composition rules of D-09.2)

```
W1:  ST1 dual-emit bake ──► ST2 ?packSource (records-only) ──► ST3 ?geomBundles ──► ST5 ?texCompressedOnly ──► ST6 q75 corpus (bake)
                                     │                                                    ▲
ind: ST4 ?texWorkers ────────────────┼────────────────────────────────────────────────────┘  (ST5 uses ST4; falls back to FIFO)
                                     │
W2:  ST7 ?slotGrid ──► ST9 ?drawPools + ?frameWork B/C ──┐
     ST8 ?frameWork A ───────────────┴───────────────────┤
                                                          ▼
                                            ST10 legacy retirement (needs ALL of ST2–ST5, ST7–ST9 default-ON + D-09.8 criteria)
```

Independently shippable: each STn's flag flips on its own evidence; the only hard
co-landing is inside ST9 (pass 8 H-08.4). ST4/ST8 have no ordering constraint at all.

### S2 — Stage cards (normative)

Format: **ships / flag & fallback / promotion bar (beyond the D-09.4 uniform floor) /
gating measurement (named for pass 10) / kill criterion (scale + protocol) / revert.**

**ST1 — Dual-emit bake + serve rules.** Ships: `--emit-packs --legacy-layers` in
dat-shard (new capability per pass 2 D-02.10); manifest gains v3 fields at
`version: 2` (D-09.1.2); serve.py packs/index header rule + `--check`/`_health.json`
extension. Flag: none (no client behavior change; legacy checks prove legacy output
unchanged, D-09.7.6). Promotion: D-09.7 gates 1–6 green. Measurement: bake CI
(closure/determinism/differ) + zstd-ratio pinning (retires pass 2 Q1 / pass 4 Q1 —
re-scores B1 slack). Kill: n/a — a failing dist never gets pointed at. Revert: K3.

**ST2 — Pack client, records-only.** Ships: `PackFetchController`, `PackSource` +
`CompositeSource` (packs-first, legacy fallback), hash-on-receipt, lanes/promotion,
HBSI1 consumption, SW v3 (at promotion — see below); GEOM stays encoding 0x0000
(runtime decode from RECORDS, pass 2 D-02.7's migration state), so the RENDERED
world is byte-identical inputs through the unchanged decode path. Flag: `?packSource`
(fallback = legacy `ManifestResourceSource` stack unchanged). Promotion bar: wire
correctness (0 hash mismatches, 0 terminal quarantines over the battery on a healthy
dist); no render-path eye item owed (inputs identical; one sanity look rides
Batch A anyway, cost ≈ 0). **SW v2→v3 swap timing (P3 H-03.4 discharged): the v3
worker lands in the same commit as the `?packSource` default flip** — v3 keeps
legacy `shards/` in its CAS allowlist until ST10 (sound under the same path⇒bytes
invariant, pass 3 D-03.9), so legacy sessions lose nothing; K4 is the SW kill.
Measurement: emulated-666 cold-boot bench, per-component attribution vs pass 3
S8.1's table (B1'/B2/B3/B5); warm-boot B5 check; T2 bot boot. Kill: cold-boot bytes
OR requests to `preview-complete` (cold cache, emulated 666, same-session
interleaved packs-vs-legacy arms) worse than the legacy arm; or any terminal tile
quarantine on a validated dist; or legacy-lane starvation during equipment bursts
(pass 3 Q6's risk) observed as gameplay-visible. Revert: K2 (+K4 if the SW shipped).

**ST3 — GEOM bundles + consumer swap.** Ships: HBG1 payloads in the bake (GEOM
encoding 0x0001 incl. the did_degrade walk edge, pass 4 D-04.6/H-04.7);
`assemble_*_geometry` exports + `bundleToGeometryGroups`; consumers swap in fixed
order — statics → buildings → animated scenery decode-once → cells — each behind the
same flag, landed as separate commits so a defect bisects to a consumer (pass 4
H-04.5's per-consumer staging made concrete). Flag: `?geomBundles` (requires
`?packSource`; fallback = 0x0000 treatment ⇒ runtime decode — geometry has a
runtime fallback BY CONSTRUCTION, pass 4 S6.3). Promotion bar: differ green
(D-09.7.3) + **E1 eye item** (Batch A) + bundle-assembly cost sanity on the 1070
(pass 4 H-04.6b, asserted memcpy-scale). Measurement: boot/crossing bench deltas
(bytes now include GEOM — C2 margin 2.1× per pass 4 S6.2); `geomFallback` counter
trending to entity-only. Kill: E1 dirty; or parked-mid p50 regression vs
same-session `?geomBundles=off` arm (interleaved, fixed pose — no draw-count
arithmetic, walls); or decode-starvation-class errors reappearing. Revert: K2 (dist
keeps GEOM sections; they are inert to the OFF arm).

**ST4 — Texture worker.** Ships: `texture_worker.js` (transcode + terrain assembly
+ NRA derive capability), results-enqueue-only integration. Flag: `?texWorkers`
(DEV default 0 = today's budgeted FIFO; end-state default 1 per pass 5 S3; fallback
arm = FIFO retained verbatim, pass 5 D-05.4). Promotion bar: uniform floor only —
no eye item (no pixel change: same transcoder, same output shape). Measurement:
stall-probe walk on ultra (transcode bucket, moving p99 scale) same-session
worker-vs-FIFO arms; warm-boot queue depth (pass 5 Q4). Kill: worker-arm tail
(moving p99, stall-probe protocol) worse than FIFO arm; or worker-construction
failure rate nonzero in the field (fallback must engage silently+counted, never
white textures). Revert: K2.

**ST5 — Compressed-only texture path.** Ships: frame-1 preview materials
(scalars-only surface decode + PVW albedo), full-tier lane-T upgrade, preview-commit
+ `atlasRefeed` re-home, full-chain+aniso arrays, ×1.5 growth, NRA worker derivation,
rehydrate v3 + mirror policy, terrain t128 slice + tier ladder, 128 MB record budget.
Flag: `?texCompressedOnly` (master; `?atlasPreviewCommit` sub-escape per pass 5;
requires `?packSource`; fallback = today's RGBA8-first double-build, intact until
ST10). Promotion bar: **E2 + E3 eye items** (Batch B); no-BPTC fallback verified
functional (legacy-lane textures + banner). Measurement: six-town M4 mirror census
(≤250 MB class, allocated-vs-used labeled); 30-min ultra M5 (0 context losses) +
M6; B1 component re-score with the capped-preview ring figure (retires pass 5 Q1);
C4 dungeon check. Kill: E2/E3 dirty; or M4/M5 worse than the same-route legacy arm
(six-town protocol); or frame-1 white/black materials at any rate (correctness,
zero tolerance); or parked-mid p50 regression (interleaved fixed-pose). Revert: K2
(+K3 if a preview-coverage bake defect is implicated).

**ST6 — q75 corpus flip (bake-side).** Ships: full-tier corpus re-encoded
`-quality 75` no-RDO (pass 5 D-05.3; lossless until the gate). Flag: none —
dist-level arm; clients see it via TEXREF `lossy` bit. Promotion bar: **E4** (owner:
redmi, Batch B). Measurement: B4 bytes re-score (q75 ⇒ ~63 MB [D, pass 5]); the
**B4 owner decision** is recorded at this stage: rdo arm through the same gate ⇒
B4 ✓ at ~42 MB, or relax B4 to ~65 MB (charter Q1's contemplated relaxation) —
either way the decision lands in writing (S7 checklist). Kill: E4 dirty ⇒ stay
lossless (K3 is trivial: both corpora are CAS; the manifest points at one). Revert:
K3.

**ST7 — Slot grid as residency authority.** Ships: `residency_grid.js` (W_T=6,
events, state machine), PackStore pin wiring (when `?packSource` on) or legacy-LRU
adapters (when off — pass 7 D-07.10's migration state), park scheduler, pressure
ladder, census deltas; the legacy LRU runs as DERIVED-VIEW ASSERT during soak
(pass 6 H-06.3's S15-ladder discipline — the proven staging shape per the S15b/S16
precedent, url-flags.md:505–507). Flag: `?slotGrid` (fallback = reactive LRU stack
unchanged). Promotion bar: **E5** (Batch C or B); battery green: zig-zag bench
(`reAdoptCancels` absorbing), teleport-settle vs battery baselines,
`pinLeaks`/`shiftMismatches`/`slotDesyncs` = 0 (census CI gates, pass 6 S5). 
Measurement: six-town M1/M2 (heap peak/growth, route protocol); moving-tail stall
probe (governor-churn bucket) same-session arms. Kill: any nonzero integrity
counter; or M1/M2 worse than legacy arm on the same route; or moving p99 (stall
probe, ultra walk) regression vs same-session `?slotGrid=off`. Revert: K2.

**ST8 — FrameWorkScheduler stage A (W6 registration).** Ships: `frame_work.js`;
legacy 6 ms families register as W6 clients under the global cap — their code
unchanged (pass 8 H-08.1 first sub-stage). Flag: `?frameWork` (fallback = today's
free-running task placement). Promotion bar: uniform floor; no eye item.
Measurement: `__framePhase` census (re-classes pass 8 S1's [A] budgets);
boot-time and crossing-settle regression check vs baseline (pass 8 Q4's fast-line
risk — same-session arms, boot protocol interleaved). Kill: boot-to-in-world or
crossing-settle time (wall-clock, interleaved arms, fast line AND emulated 666)
regresses beyond noise — the named lever before killing is the CROSSING elevated
mode (pass 8 Q4). Revert: K2.

**ST9 — Draw pools + scheduler stages B/C + closed-class prewarm.** Ships:
`pool_registry.js`, class-key material tier, TilePlan feeds, P4 relocation of
eviction/feeds (scheduler stage B), upload staging via `initTexture` (stage C —
lands TOGETHER with the feed path, pass 8 H-08.4), boot class-census prewarm incl.
the CSM depth-variant warm render. Flag: `?drawPools` (requires `?slotGrid`;
`?frameWork` must be ON for stages B/C; fallback = today's full producer stack —
statics feed seams, static_batch_x, static_atlas, buildings, cells — intact).
Promotion bar: **E6** (Batch C); class census sane (`pools ≤ ~300`,
`classesCreatedPostBoot = 0` after settle — pass 7 S5.3); parked-frame
`poolMutationsPerFrame = 0`. Measurement: the fixed-pose MOVING bench (the
primary scorecard — pass 7 D-07.5; F3/F4 baselines get created here per charter
Q2); F5 `linkStatusMs = 0` 60 s ultra walk; switch-rate/program-switch counters vs
the 71%/160 baselines; ktris vs today (pass 7 Q3's GPU-boundedness re-check,
charter D-01.5). Kill: E6 dirty; or moving p50/p99 (fixed-pose bench, same-session
`?drawPools=off` arm) regression; or `classesCreatedPostBoot > 0` in steady walk
(class-key fragmentation = design bug); or the frame goes GPU-bound on T1
(boundedness re-measure BEFORE any further work, walls). Revert: K2 — one flag
restores the entire legacy producer stack (the pool-vs-legacy A/B is the same
mechanism as the kill, by construction).

**ST10 — Legacy retirement.** Per D-09.8. No flag — this is the stage that DELETES
flags. Measurement: the retirement criteria themselves (worldload counter, census
shape). Kill: n/a (gated, ordered, owner-approved); a post-deletion regression is a
revert-the-commit event, which is why the soak requirement (D-09.8.2) exists.

### S3 — Bake/dist operational rules

1. **Layer inventory during coexistence:** `manifest.json` (v2+fields) ·
   `index/{hash}.bin` · `packs/xx/{hash}.hbp` · full-tier texture CAS files ·
   legacy: `shards/`, `manifest/*.bin`, `boot.hba`, `scenery/`, `spawns/`,
   `events/`, `suite/` · `_health.json` · `bake-source.sha256`.
2. **Header classes** (pass 3 S6.1 adopted; serve.py gains only the packs/index
   rule — ST1): immutable+identity for all CAS paths; `no-cache` revalidate for the
   app shell; the legacy tiers unchanged until ST10.
3. **serve.py --check matrix:** legacy arms unchanged; `world_index` present ⇒
   `index/` file exists + `packs/` has populated prefix buckets (shards-style
   check) + new `_health.json` rows (`packs`, `index`, with counts) — absent any of
   these, refuse to start (no `--allow-missing` exemption for a manifest that
   PROMISES packs; a promise-breaking tree is the loud-fail case, not the
   partial-dev case).
4. **Retention/GC:** keep serving bake + N−1 (index + packs reachable from either);
   GC (a bake-tool subcommand, not serve.py) deletes CAS objects unreachable from
   both; legacy layers exempt until ST10. [Adopts pass 3 S6.4.]
5. **1070/tunnel note:** `crypto.subtle` needs a secure context; the plain-http
   tailnet origin falls back to worker-wasm sha256 (pass 3 D-03.5) — the Batch A
   probe (D-09.5) confirms the fallback before ST2's default flip is scheduled for
   that rig.

### S4 — Flag lifecycle summary table

| flag | stage | DEV default | end-state default | escape | composition |
|---|---|---|---|---|---|
| `?packSource` | ST2 | off (`=on` opt-in) | on | `=off` → legacy fetch stack | — |
| `?geomBundles` | ST3 | off | on | `=off` → runtime decode (0x0000) | needs packSource |
| `?texWorkers` | ST4 | 0 | 1 (pass 5 S3) | `=0` → budgeted FIFO | — |
| `?texCompressedOnly` | ST5 | off | on | `=off` → RGBA8-first path | needs packSource; uses texWorkers |
| `?atlasPreviewCommit` | ST5 sub | (rides master) | on | `=off` → hold-out-with-refeed (pass 5 D-05.6.3) | within texCompressedOnly |
| `?slotGrid` | ST7 | off | on | `=off` → reactive LRU | — |
| `?frameWork` | ST8/9 | off | on | `=off` → free-running tasks | stage C needs drawPools |
| `?drawPools` | ST9 | off | on | `=off` → legacy producers | needs slotGrid (+frameWork for B/C) |
| `?packVerify`, `?fetchCap`, `?workBudget`, `?upBudget*`, `?workShrink`, `?texWorkers=N` | diag/tuning | per pass 3/8 | per pass 3/8 | explicit values | measurement escapes, never required for correctness |

All flags: `flagIsOff`-family predicates, `*Enabled()` readers, url-flags rows +
lint/audit green in the landing commit (D-09.3).

### S5 — Eye-gate execution rules (batches A/B/C)

1. Queue format and result recording are pass 10's (its charge includes the 1070
   validation queue format); this pass fixes the ITEMS (D-09.5 register), the
   batch grouping, and the pass/fail semantics (CLEAN/DIRTY, D-09.5).
2. Each item ships as a prepared URL pair (flag-on / flag-off) + a vantage list +
   the §5f-shape checklist, so the owner's time per item is minutes.
3. Off-screen/headless only; batched; never on the 1070 user's screen; no sound
   (fleet rules restated as binding here).
4. A DIRTY verdict is recorded in url-flags §0 (the flip-criteria row now cites the
   verdict) AND in the stage's kill log — the flag stays DEV/VALIDATED-blocked
   until the defect is fixed and the item re-queued.
5. Measurement probes may piggyback on eye batches (Batch A carries pass 10's
   subtle/initTexture/88 MiB probes) — one session, many items, per the batching
   rule.

### S6 — Kill-criteria master table (metric scale + protocol class, per the walls)

| stage | kill metric (SCALE) | protocol class | revert |
|---|---|---|---|
| ST2 | bytes/requests to `preview-complete` (cold, per-component) vs legacy arm; terminal quarantines > 0 | emulated-666 boot bench, same-session interleaved arms | K2 (+K4) |
| ST3 | E1 verdict; parked-mid p50 vs off-arm; starvation-class errors | eye; fixed-pose interleaved ABAB | K2 |
| ST4 | moving-ultra p99 transcode bucket vs FIFO arm | stall-probe 60 s walk, same-session arms | K2 |
| ST5 | E2/E3 verdicts; M4 (live mirror bytes, allocated-vs-used labeled) and M5 (context losses) vs legacy arm; any frame-1 white material | eye; six-town route; 30-min ultra soak | K2/K3 |
| ST6 | E4 verdict only | owner eye (sheets + in-world) | K3 |
| ST7 | integrity counters ≠ 0; M1 peak / M2 growth vs legacy arm; moving-ultra p99 governor bucket | census CI; six-town route; stall-probe walk | K2 |
| ST8 | boot-to-in-world + crossing-settle wall clock vs off-arm (fast line AND 666) | interleaved boot arms | K2 |
| ST9 | E6 verdict; moving p50 AND p99 vs off-arm; `classesCreatedPostBoot > 0`; GPU-boundedness flip on T1 | eye; fixed-pose moving bench; census gate; boundedness re-measure | K2 |
| any bake | validation gate failure or in-field hash-mismatch/quarantine counters | bake CI; `__hbFetch` diag | K3 |

Standing rule: a kill fires on the DECISION protocol (interleaved/same-session),
never on a single cross-boot observation; parked evidence never clears a moving
kill and vice versa (parked-vs-moving wall).

### S7 — Doc-propagation checklists

**S7.1 — On every DEFAULT FLIP (and every kill/flip-back):** same day —

1. url-flags.md: row updated (default cell + evidence), §0 row resolved or added;
   `lint-url-flags.mjs --strict` and `audit-flag-defaults.mjs --mismatch` both green
   (url-flags.md:12–16).
2. The superseded measurement docs get their banner (frame-cost style): which
   verdict, which date, what supersedes it.
3. Module headers/comments that now describe the old world: rewritten in the same
   PR (the register S7.3 pre-lists the known ones per stage).
4. Diag/instrument wiring renamed in the same commit as the surface (pass 8 S7.3).
5. `docs/reengineering/` — the stage's row in the SPEC.md risk/stage register
   (post-pass-12) updated; until SPEC.md exists, a dated line in the bake/stage log.
6. Owner notified of stale MEMORY.md pointers (never edited by the agent
   unprompted — D-09.9.3).

**S7.2 — On every BAKE REPOINT:** serve.py `DEFAULT_ROOT` comment block extended
with the dated rationale (the existing convention, serve.py:66–87);
`bake-source.sha256` verified present; `_health.json` diffed against the previous
bake (layer counts).

**S7.3 — The accumulated stale-wording register (from prior passes; each row clears
at its stage, at implementation time per D-09.9.2):**

| stale text (location) | why stale | clears at |
|---|---|---|
| survey §4 I4 "designed …, never built" + `PLAN-fixed-slot-grid` framing echoed in briefs | S15b/S15c grid IS live default-ON at terrain radius-1 (pass 6 read-verified; url-flags.md:505–507) | ST7 landing (survey correction + plan-doc banner) |
| p99 doc: "SHADER_PREWARM default OFF" | flipped default-ON 2026-08-06 (pass 8 read-verified) | ST8 landing (banner) — or earlier as a standalone same-day fix, since the verdict already exists |
| bc7_textures.js header: level-0-only array contract + 256 MB budget rationale ("eviction costs a main-thread transcode") | ST5 fixes chains/aniso and moves transcode to the worker (pass 5 S7) | ST5 landing |
| url-flags `texFreeCpu` row preconditions (a)/(b) + texture_release.js preconditions | rehydrate v3 + compressed-only path restructure the preconditions (pass 5 D-05.7) | ST5 landing |
| xu7_textures.js roadmap comment ("(b) is a prerequisite for (a)") | (a) ships at ST4 | ST4 landing |
| static_batch_x.js long headers (memo/slack/sphere-cache rationale) + statics.js:2435 "default OFF" comment contradicting its reader (pass 7's R4 catch) | memo family OBSOLETE at pools; comment wrong today | comment fix: standalone same-day (it is wrong NOW); headers: ST9 landing |
| landblock_lru.js header + governor doc rows | governor deleted, grid is authority | ST7/ST10 landing |
| statics geom-audit/starvation machinery docs | machinery deleted with bundles (pass 4 H-04.5) | ST3 landing |
| url-flags rows 505–507 (`fixedGrid` family) | subsumed by `?slotGrid` grid-as-authority | ST7 landing (rows superseded), deleted at ST10 |
| frame-cost doc §5a/§5 statBatchMemo/statArrayMerge sections | pools make the family obsolete (pass 7 D-07.4) | ST9 landing (banner: "superseded by pools — historical") |
| pass 2 S7 `version: 3` wording | superseded by D-09.1.2 (sentinel timing) | already handled by this document's SUPERSEDES block; pass 12 carries it into SPEC.md |

## Handoffs to later passes

- **H-09.1 (→ pass 10):** The measurement gates named per stage (S2 cards) need
  their protocols: emulated-666 boot bench with per-component attribution;
  fixed-pose moving bench (creates F3/F4 baselines at ST9); stall-probe walk
  protocol per stage arm; six-town + 30-min-ultra memory routes; census CI gates
  (pass 6 S5, pass 7 S5.3); the 1070 validation QUEUE FORMAT for the D-09.5
  batches (items/checklists/verdict recording); the Batch A piggyback probes
  (crypto.subtle, initTexture+layerUpdates, 88 MiB staging). Also: the promotion
  bar's "0 console errors" needs a mechanical harness definition (which consoles,
  which severities) — proposed default: `list_console_messages` error-level on the
  standard boot + route, zero tolerance, warnings triaged.
- **H-09.2 (→ pass 11):** Attack surface flagged deliberately: (a) the D-09.1
  field-presence routing assumes no deployed parser rejects unknown manifest fields
  — verified for the Rust client (v2.rs:189–194) but NOT audited for smoke
  harnesses/tools that read manifest.json; (b) the ST2 "no eye item owed" claim
  rests on byte-identical decode inputs — worth hostile review; (c) kill
  thresholds are stated as "regression vs same-session arm" without numeric
  deltas — pass 10 must pin noise floors per protocol or the kills are
  unenforceable; (d) the assumption that the S15/S16 staging precedent transfers
  to the much larger ST7 scope; (e) Batch quantization risk: three 1070 sessions
  serialize the three structural stages — if session cadence is slow the plan's
  critical path is the owner's availability, not engineering.
- **H-09.3 (→ pass 12):** SPEC.md's build order should adopt S1/S2 as the
  migration skeleton and A4's acceptance mapping can cite: stages (S1/S2), kill
  criteria (S6), fallbacks (D-09.2 rule), flag policy (D-09.3/S4), eye-gates
  (D-09.5). The stage register (S2) is designed to become SPEC.md's task-group
  table with per-task acceptance criteria attached.

## Self-check

- **Walls — flag-bit ≠ predicate / ClipMap:** the whole of D-09.3 is built on the
  shared predicate + `*Enabled()` + lint-tool discipline (read-verified anchors);
  every structural stage carries a named eye item with the ClipMap precedent cited
  as binding (D-09.4.3, E6 explicitly re-checks the ClipMap item itself). PASS.
- **Walls — boot variance / parked-vs-moving / scale labels:** D-09.6's normative
  rule requires every kill to name scale + protocol class; S6 does so row by row;
  soaks are declared observational with interleaved benches as decision evidence
  (D-09.3.3); parked evidence explicitly cannot clear a moving kill. PASS.
- **Walls — draws×µs / draw-count proxy / GPU-on-CPU-bound:** no frame prediction
  anywhere; ST9's kill includes the boundedness re-measure duty; ST3's kill
  explicitly forbids draw-count arithmetic. PASS.
- **Walls — allocated ≠ used:** ST5/ST7 kill metrics carry the label (M4/M6
  wording). PASS.
- **Walls — propagate verdicts same-day:** D-09.9 + S7 make it a checklist item of
  every landing; the two already-stale items that need no stage (statics.js:2435
  comment, p99 prewarm line) are marked for standalone same-day fixes. PASS.
- **R1:** read order followed; every prior-pass pass-9 handoff is inventoried in S0
  with a discharge point. One contradiction carries an explicit SUPERSEDES block
  (pass 2 S7 sentinel timing) with read-verified evidence
  (manifest_source.rs:341–365; v2.rs:189–194); all other decisions adopt or refine
  handoffs addressed to this pass. PASS.
- **R2:** measurement protocol design, queue format, numeric noise floors → pass 10
  (H-09.1); hostile review of assumptions → pass 11; build-order integration →
  pass 12. No bench mechanics or instrument schemas designed here. PASS.
- **R3:** writes = this file + own TRACKING.md row. serve.py/SW/doc changes are
  spec'd with landing stages, not made; the survey correction is explicitly
  deferred to implementation time (D-09.9.2). PASS.
- **R4:** current-code claims carry file:line opened THIS session: serve.py
  (symlink repointing, check arms, header tiers, DEFAULT_ROOT convention), v2.rs
  (no deny_unknown_fields; probe), manifest_source.rs:341–365 (UnsupportedVersion
  routing), bc7_textures.js:101–132 (predicate family), url-flags.md:1–30/285/
  505–507 (lint tools, texFreeCpu row, fixedGrid rows). The dat-shard CLI claim is
  framed on pass 2's own "gains" wording plus a this-session scan (stated as such).
  The wasm-crate trap not triggered (no `crates/holtburger-web` claims); `dist`
  symlink target matches R4's note. PASS.
- **R6:** six sections in required order; decisions numbered with rationale +
  rejected alternatives. PASS.
- **R7:** concrete stage cards with flags, fallbacks, gates, kill rows; concrete
  file/tool anchors for every duty; the manifest routing mechanism is
  byte-level implementable. Numbers carry source classes where they appear
  (inherited [M]/[D] figures cited to their passes). PASS.
- **R8:** honest gaps: kill thresholds lack numeric deltas until pass 10 pins noise
  floors (flagged in H-09.2c); the field-presence audit gap (H-09.2a); the B4 owner
  decision and q75 verdict are owner calls recorded as open, not presumed; 1070
  cadence risk stated. PASS.

## Open questions

- **Q1 — The B4 owner decision (inherited P5 Q2).** If E4 reads clean, B4 still
  needs either the rdo arm passing the same gate (B4 ✓ ≈ 42 MB) or a relaxation to
  ~65 MB. Owner: redmi, decision recorded at ST6 in writing (S7 checklist).
  [Blocking nothing before ST6.]
- **Q2 — Hashed-filename app shell (inherited P3 Q3).** Would make the shell CAS
  (immutable headers, offline app start, B5 → 0 requests) but is a build-system
  change. Proposed default: defer post-v1; revisit at ST10 when the SW allowlist is
  touched anyway. [Owner call.]
- **Q3 — Non-client manifest readers.** Do smoke harnesses / tools /
  proxy.cjs-adjacent scripts parse manifest.json strictly (would additive fields or
  the eventual v3 flip break them)? Unaudited this session (H-09.2a). One
  `rg manifest.json` sweep at ST1 implementation settles it. [Owner: ST1 task.]
- **Q4 — Legacy-lane concurrency coupling during ST2 (inherited P3 Q6).** The
  "legacy share = 8 under the global cap" starvation behavior for 119-spawn
  equipment bursts is unmeasured; ST2's kill row watches it, but the measurement
  belongs to pass 10's crowded-server scenario. [Owner: pass 10.]
- **Q5 — 1070 batch cadence.** The plan quantizes structural promotions to three
  owner sessions; if cadence slips, DEV-state soaking continues but default flips
  stall. Mitigation already in the plan (batches carry many items; probes
  piggyback); residual risk stated, not solved. [Owner: scheduling reality.]
- **Q6 — SW v3 + legacy shards allowlist interaction.** Keeping `shards/` in the v3
  CAS allowlist (ST2 card) preserves legacy caching but retains a large-cardinality
  cache population until ST10; if Cache Storage quota pressure appears on the 8 GB
  laptop, the named lever is dropping shards/ from the allowlist early (HTTP cache
  still covers B5/C3 — pass 3 S8.1 shows B5 is met with no SW at all). [Owner:
  first T2 soak.]

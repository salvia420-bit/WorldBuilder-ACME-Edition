# Task T16 report — ST6: q75 corpus + the two owner decisions (bake-side, no client flag)

## Shipped

| artifact | where | commit |
|---|---|---|
| q75 no-RDO full-tier corpus (3,985 ktx2, 1,624,666,009 B, 0 encode failures) | `/mnt/wbterminal2/xubc7-corpus-q75/{statics-q75,tranche1-q75}` + `q75-corpus.sha256` + `PROVENANCE.md` (external drive — NOT in the source tree, per I5) | n/a (data artifact) |
| E4 contact sheets, 36 rows | `/mnt/wbterminal2/xubc7-proto/results/sheets/<rsId>_q75.png` | n/a (data artifact) |
| encode driver + sheet builder (rerunnable) | `/mnt/wbterminal2/reeng/T16/{q75-driver.sh,make-q75-sheets.py,driver.log,encode-*.log}` | n/a (scratch tooling) |
| batch-B queue: E4 artifact-path strings updated (3 strings; verdict/decision slots untouched) | `docs/reengineering/queue-1070/batch-B-2026-08-09.json` | (this commit) |
| this report + IMPLEMENTATION.md T16 row | `docs/reengineering/impl/task-T16-report.md` | (this commit) |

The encode ran ONLY on the buildbox (GCE us-central1-a, 18 vCPU), per the task's hard
constraint; the laptop did docs, SSH, rsync, and transcode-only unpacks for the sheets.

**Encode pipeline** (read-verified against pass-05 D-05.3 + the existing encoder
tooling per use-existing-tools-first — no new encoder was written):

- Encoder: `basisu` v2.50.0, basis_universal upstream `9bebe167` — the SAME commit as
  the laptop-built proto encoder (`/mnt/wbterminal2/xubc7-proto/basis_universal`,
  clean tree at that commit). The laptop binary needs GLIBC_2.38 (box is Debian 12 /
  2.36), so the box built its own from the pinned commit (cmake Release, SSE=TRUE).
  **Encoder parity proven**: box lossless encode of `0x06003789.png` is byte-identical
  (sha256 `58a2b8f1…`) to the shipping lossless corpus file encoded on the laptop.
- Per-texture command (mirrors `xubc7-proto/results/run_matrix.py` `MODES['q75']` and
  `xubc7-corpus/encode_lossless.sh`):
  `basisu -xubc7 -quality 75 -mipmap -output_file <rsId>.ktx2 <rsId>.png` — no RDO flags.
- Sources: `/mnt/wbterminal2/upscale-corpus/out/statics-remacri` (2,931) +
  `tranche1-remacri` (1,054) — the exact source set the shipping lossless corpus
  (`/mnt/wbterminal2/xubc7-corpus`) was encoded from, so the E4 A/B isolates the
  quality knob.
- Transfer discipline: the box was at 94% disk, so the driver staged ≤400 PNGs at a
  time (rsync chunk → encode `-P 16` → delete staged inputs; disk guard aborts <3 GB
  free). Total source moved: 4.5 GB (under the ~5 GB guardrail; no pre-existing
  corpus mirror on the box — searched `/home /mnt /opt`). Wall: ~16.5 min for all
  3,985. Box afterwards: staging + box-side corpus copy removed, `~/.keep-awake`
  cleared, poweroff issued (encoder source+binary left for future rebakes).

## Spec conformance

SPEC §3 T16: *re-encode full tier at q75 no-RDO (buildbox); E4 (sheets + in-world
painted/emblem pass; owner: redmi); record IN WRITING: (1) q75 verdict, (2) the B4a
election. Acceptance: GATE-Q75 + decisions recorded. Kill: K3 (manifest points at
either corpus; both are CAS).*

- **q75 no-RDO re-encode on the buildbox** — **MET.** 3,985/3,985 records encoded,
  0 failures; post-transfer `sha256sum -c` 3985/3985 OK; corpus-run output
  byte-identical to a standalone same-box encode of the same input (determinism spot
  check, `0x06003789` q75 sha `e088619d…`).
- **Sheets staged for E4** — **MET.** 36 `<rsId>_q75.png` sheets (SOURCE | LOSSLESS
  corpus | q75 corpus, center-512 crops, per-record KB + ratio in captions): the 12
  canonical picks from `picks.json` (comparable with the earlier proto sheets) + 24
  deterministic corpus-stride rows for breadth. Limitation, recorded in the queue
  item: painted/emblem rows are not classifier-selected — the bake's relief
  classifier (`crates/holtburger-dat/src/gfx_remodel.rs`) does not emit a consumable
  painted/emblem label list, so the owner's in-world pass carries that class (as the
  E4 card already provides).
- **GATE-Q75 (E4 eye pass)** — **DEFERRED-TO-BATCH** (Batch B, owner redmi; I9 — an
  eye gate is never simulated).
- **Decision (1) q75 verdict** — **DEFERRED-TO-OWNER** (slot null in
  `queue-1070/batch-B-2026-08-09.json` E4 `decisionsInWriting.q75Verdict`).
- **Decision (2) B4a election** — **DEFERRED-TO-OWNER** (slot null in the same file),
  with NEW measured evidence for the call (below).
- **K3 readiness** — **MET.** Both corpora are plain ktx2 record dirs the CAS bake
  ingests; the shard store holds both after a q75 bake (shards are content-addressed;
  the tex-xu7 catalog + world_index select the live one). Repoint recipe in Handoffs.

**New [M] evidence for the B4a election (owner should read before electing):**
full-corpus q75/lossless bytes = 1,624,666,009 / 2,353,188,241 = **0.6904**
(statics 0.683, tranche1 0.704) vs 0.644 projected from the 12-sample figures
(0.382/0.593, D-05.3). Applied to the measured 83.5 MB lossless ring [M, pass-02]:
q75 ring ≈ 83.5 × 0.690 ≈ **57.6 MB** → B4a ≈ 12 + 57.6 ≈ **69.6 MB [D]** — ABOVE
both the ≈63 expectation and the ≤65 gate. Caveats: ring composition ≠ corpus
composition (commons-dominated; per-class ratios vary), and the 12-sample was encoded
from the older `pbr-terrain/*/x4-output` sources, not the shipping Remacri set (see
Tests run) — B4a still BINDS only at BOOT-666 converged tail. But at corpus ratio the
q75 default likely needs either the rdo arm or the relax-toward-65 escape D-05.3
already names; this sharpens, not changes, the framed election.

## Deviations

none (SPEC implemented as written). Two notes, neither a spec deviation:

- Corpus destination is the laptop's external drive (`/mnt/wbterminal2/`), not the
  buildbox — the task allows either; the box is at 94–96% disk and the repoint bake
  runs where the other bake inputs live (laptop, `run-world-bake.sh`).
- Box infra installed for the task: `cmake` (apt) + a basis_universal clone at the
  pinned commit — left in place (`~/basis_universal`, binary in `bin/`).

## Tests run

- Encoder parity (box vs laptop toolchain): box-built basisu lossless encode of
  `statics-remacri/0x06003789.png` → sha256 `58a2b8f1…` == shipping
  `xubc7-corpus/statics-lossless/0x06003789.ktx2`. @scale: single-record, byte-exact.
- Encode run: 2,931 + 1,054 = 3,985 ok / 0 FAIL (`/mnt/wbterminal2/reeng/T16/encode-*.log`,
  `driver.log`). @scale: full corpus [M].
- Transfer integrity: `sha256sum -c q75-corpus.sha256` → 3985 OK / 0 failed after the
  pull to `/mnt/wbterminal2/xubc7-corpus-q75/`. @scale: full corpus.
- Determinism spot check: corpus-run `0x06003789.ktx2` == standalone same-box q75
  encode (`e088619d…`). @scale: single-record.
- Proto-lineage check (explains why corpus q75 files differ from the proto's
  `results/enc/*_q75.ktx2`): all 12 picks DIFF, and all 12 `picks.json` `png` paths
  point at `pbr-terrain/{coverage100,statics-x1}/x4-output/` — a different (older)
  upscale lineage than the shipping Remacri sources. Encoder drift ruled out by the
  parity check above. @scale: 12 records.
- Sheets: `make-q75-sheets.py` → `{"sheets": 36, "missing": []}`; one sheet visually
  verified (3 panels + captions render correctly).
- Queue file: `python3 -c json.load(...)` → json-valid after the 3 string edits.

## Handoffs & risks

- **Corpus**: `/mnt/wbterminal2/xubc7-corpus-q75/` — `statics-q75/` (2,931),
  `tranche1-q75/` (1,054), `q75-corpus.sha256`, `PROVENANCE.md`. 1.62 GB. The box
  copy was deleted after sha-verify; re-producing it is ~17 min via
  `/mnt/wbterminal2/reeng/T16/q75-driver.sh` (box IP is ephemeral — re-read it from
  `gcloud compute instances start` output first).
- **Sheets for E4**: `/mnt/wbterminal2/xubc7-proto/results/sheets/<rsId>_q75.png`
  (36 files, `*_q75.png` glob; older proto `_ab/_q20` sheets left alongside).
- **Repoint when the owner accepts q75** (K3; both corpora CAS). One-time ingest farm:
  `mkdir -p /mnt/wbterminal2/xu7-ingest-q75 && ln -s /mnt/wbterminal2/xubc7-corpus-q75/statics-q75/*.ktx2 /mnt/wbterminal2/xu7-ingest-q75/ && ln -s /mnt/wbterminal2/xubc7-corpus-q75/tranche1-q75/*.ktx2 /mnt/wbterminal2/xu7-ingest-q75/`
  then rerun the full-world bake with `--tex-xu7 /mnt/wbterminal2/xu7-ingest-q75`
  (edit line 27 of `/mnt/wbterminal2/reeng/orch-bake/run-world-bake.sh`, currently
  `--tex-xu7 /mnt/wbterminal2/xu7-ingest`) and deploy via
  `deploy-packs-to-dist.sh`. The client-visible arm switch is the deployed
  manifest/world_index/tex-xu7-catalog (lossless shards remain in the CAS store —
  swap back = redeploy the lossless manifest). ORCHESTRATOR NOTE: that bake is
  R-MEM1-bound on the laptop (ran 2026-08-09 at ~3.44 G cgroup) — schedule it alone.
- **Risk — B4a at corpus ratio**: q75 projects ≈69.6 MB converged [D, above], over
  the ≤65 gate. If E4 reads clean but BOOT-666 confirms >65, the named escapes are
  the rdo arm (≈42) or the owner relaxation — both already framed in the election.
- **Not produced here**: the q75 DIST (bake output). T16's charge is the corpus +
  sheets; the bake/deploy belongs to the repoint event after the owner's verdict.
- Unrelated dirty files in the tree at commit time
  (`scene3d/landblock_lru.js`, `docs/PLAN-fixed-slot-grid-residency-2026-07-11.md` —
  T20-family scope) left strictly unstaged per I6.

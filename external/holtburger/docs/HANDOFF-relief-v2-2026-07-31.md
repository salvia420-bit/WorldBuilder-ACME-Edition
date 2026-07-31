# HANDOFF — relief v2: why the showcase looked wrong, and what shipped (2026-07-31)

User critique of the 07-30 showcase set ("effects seem random; dents on the
stones instead of between the stones; paneling/pagoda vanilla; arch low-res")
was diagnosed to FOUR independent causes. All four are fixed or explained.
Commits: `a76abf1e` (bc7cli), `05df3eb6` (classifier v2 + detail micro), this doc.

## 1. The four causes (each verified against Shoushi shot 19's actual DIDs)

| symptom | cause | fix |
|---|---|---|
| everything low-res | shots served the plain dist AND `?texBc7=on` (exact-match opt-in) was absent from the agent URL — the 2,999 ×4 BC7 payloads sat unfetched. Worse: `bc7-webroot/apps/holtburger-web/dist` was a STALE symlink to the plain dist, so even with the flag :8767 would have 404'd every BC7 fetch | unified dist (§2), symlink repointed, reshoot brief hardcodes the flag |
| paneling/pagoda/torii "vanilla" | classifier margin-fallback demotes any split tier-vote to Flush (macro OFF). It **outvoted 22 of its own hand-labeled seeds** — Shoushi wall shingle `0x06004381`, gate planks `0x06004376` included (`maxSim=1.0`, still lost the vote) | classifier v2: seed labels authoritative at inference + 242 new visual labels from a placement-ranked split-vote queue. 721 textures gain macro (258 world-visible), 1,759 borderline retreat to Flush |
| "dents ON the stones" | NOT the seam operator (measured: plain seam carves the mossy fieldstone joints correctly, face−joint = +0.33). It was the MICRO layer — synthesized value noise, content-blind by design, dipping at random on stone faces | micro dips now follow the texture's own pore-scale dark detail (65%) blended with noise (35%), architectural classes only; painted classes stay content-blind (emblem safety). `MICRO_DETAIL_FULL/MIX` in height_seam.rs |
| "effects seem random" | the above two: wrong-class grain + noise-only micro | same fixes |

Also answered: **DeepBump lost the eval** (Tudor inversion −0.294 vs seam
−0.058; self-gate inseparable; worst flats carve 0.99) — it was never baked;
heights are seam+pillow. And **adaptive/wider groove radii measured as
unnecessary** (`/mnt/wbterminal2/gfx-material-agent/seam_adaptive_eval.py`):
extra scales are admitted almost nowhere and cost a window-texture regression;
the shipped 0.6/1.2/2.0% ladder already spans AC's real joints.

## 2. The unified dist (task "merge the tracks")

`/mnt/wbterminal2/holtburger-dist-hires-bc7m` — 888,137 shards, tex-bc7
**2,999 records / 2,401.9 MB / 0 skipped**, boot pack retail-size, aux
namespaces symlinked from the live dist. Bake command in
`/mnt/wbterminal2/bc7-v2-rebake/` (driver + logs + rows.json provenance).

The 460 rows that were both alpha-corrected (07-30 exporter fixes) AND in the
shipped BC7 set were re-run through the full pipeline: colour-bleed →
ESRGAN ×4 (realesrgan-x4plus, HD 520 iGPU) → fidelity gate (451 pass; 5 fell
back to retail-res, still alpha-correct; 4 were retail-res by policy) →
`tools/bc7cli` (**new, committed** — the original encoder died with a /tmp
scratchpad; byte-length-identical containers vs shipped, `validate_hbc7`
clean) → content-hash-verified in the new shard store.

Serve: `/mnt/wbterminal2/bc7-v2-rebake/serve/serve-hires-bc7.sh` (:8767 from
the bc7-webroot copy). ⚠ that webroot's `apps/holtburger-web/dist` symlink is
what the URL path actually resolves through — `--check` passing does NOT prove
the URL serves the right dist; curl `dist/manifest/holtburger-tex-bc7.bin`.

## 3. Classifier v2 pipeline (repeatable)

`/mnt/wbterminal2/embed-classify/`: SigLIP embeddings (20,684) + names +
recovered kNN (`classify_knn_recovered.sh`), `repair-queue.json` (suspect
builder), `repair-sheets/` (contact sheets), `repair-labels.json` (242 visual
labels), `tex-relief-classes-v2.json` (full detail),
`gate-promotions.json`. Repo table `data/tex-relief-classes.compact.json` is
baked into wasm via include_str — **any table edit needs a wasm rebuild**.
LOO on the enriched seed set reads 0.789 (was 0.884) — expected: the new
seeds are deliberately boundary cases, so seed-set LOO now understates corpus
accuracy; don't compare the two numbers.

## 4. Open / notes

- **16×32 rail (`0x060048A0`) stays blurry** — content limit; tiny class
  ships at retail res by measured decision (HANDOFF-bc7 §"tiny 85"). A real
  fix is hand-authored art, not upscaling.
- 67 held paletted rows + 163 creature INDEX16: unchanged (palette-preserving
  path still the plan).
- `terrain_subdiv::tests::triangle_corner_ring_matches_height_sampler` FAILS
  **pre-existing** (fails with 07-31 changes stashed too). Not this work.
- ACE was found dead at 11:47 (earlyoom casualty during the builds; console
  log confirms clean 08:33 stop) — restarted via
  `/mnt/wbterminal2/ace-logs/start-ace.sh`.
- Traps re-burned today: `pgrep -f X` matches YOUR OWN shell when X is in the
  command line (killed one build chain, deadlocked three waiters); a
  10-min-timeout kill leaves cargo children running AND an un-wasm-opt'd
  6.7 MB wasm in the out dir (release is ~5.4 MB — size IS the tell).
- Session tools now live in `/mnt/wbterminal2/bc7-v2-rebake/serve/` (driver,
  launcher, brief) — NOT in a /tmp scratchpad. That mistake cost this session
  a full encoder+driver reconstruction.

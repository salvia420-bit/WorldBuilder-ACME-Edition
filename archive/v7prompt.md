# Train unified_v8: v7 dataset + restored atlas-context + middle-ground regularization

## Why
Run `unified_v7_emptylb_20260429T165705Z` (in flight as of 2026-04-30) is lagging
v6 SHIPPING (`SHIPPING_unified_v6_atlas_ep41_20260429.safetensors`) at equivalent
training fraction — at v7 ep17 we have val_total=4.97 / top1_wcid=0.781 /
unique_wcids=1084 / long_tail_recall=0.254, vs v6 ep41 SHIPPING at val_total=3.78 /
top1=0.911 / unique=1577 / long_tail=0.372. Plateau-with-overfit started ep14.

v7 made TWO changes from v6 simultaneously:
1. Switched dataset to the `_emptylb` variant (intentional — handles empty-landblock cases).
2. Dropped atlas-context entirely AND tightened regularization
   (lambda_marginal_kl 0.03 → 0.12, label_smoothing 0.1 → 0.15).

That conflates dataset effects with regularization effects, so we can't tell which
caused the regression. v8 isolates the dataset change by keeping (1) and reverting (2)
to a middle-ground configuration between v6 and v7.

## Pre-flight checks (do these BEFORE launching)

1. Confirm v7 tensors + vocab exist:
   ls -la pipeline_data/reference/component_linked_unified_v7_tensors.npz
   ls -la pipeline_data/reference/component_linked_unified_v7_vocab.json

2. CRITICAL: there is no `component_linked_unified_v7_atlas_tensors.npz` on disk
   (only `component_linked_unified_v5_atlas_tensors.npz`). Decide one:
   (a) Build a v7 atlas first via:
         python3 scripts/PopulationPipeline/OutdoorML/build_atlas_context.py \
           --tensor-path pipeline_data/reference/component_linked_unified_v7_tensors.npz \
           --vocab-path  pipeline_data/reference/component_linked_unified_v7_vocab.json \
           --output-tensors pipeline_data/reference/component_linked_unified_v7_atlas_tensors.npz \
           --output-vocab  pipeline_data/reference/component_linked_unified_v7_vocab_atlas.json
       (verify the script's actual flags by reading it; the args above are a
       reasonable guess based on its sibling extract_*_tensors.py scripts.)
   (b) Reuse v5 atlas IF v5 and v7 vocabs are wcid-compatible. Verify:
         python3 -c "import json; v5=json.load(open('pipeline_data/reference/component_linked_unified_v5_atlas_vocab.json')); v7=json.load(open('pipeline_data/reference/component_linked_unified_v7_vocab.json')); print('v5 wcid count:', len(v5.get('wcid_to_id', v5))); print('v7 wcid count:', len(v7.get('wcid_to_id', v7))); print('vocabs identical:', v5 == v7)"
       If wcid maps differ, atlas-context indices won't align — DO NOT mix.

3. Confirm GPU is free or v7 has stopped:
     nvidia-smi
     ps -ef | grep train_scene_placer | grep -v grep
   If v7 is still running, decide whether to wait it out or kill it
   (decision belongs to the human — DO NOT kill another run unilaterally).

4. Disk: each scene_placer checkpoint pair runs ~750MB resume.pt + 150MB best.safetensors.
   v8 with --resume-checkpoint-every 5 + --epochs 60 produces ≈12 checkpoints.
   Confirm pipeline_data/models/ has at least 15GB free:
     df -h pipeline_data/models/

## Launch (after pre-flight passes)

cd /home/salvia420/WorldBuilder-ACME-Edition

RUN_NAME="unified_v8_atlas_emptylb_$(date -u +%Y%m%dT%H%M%SZ)"
LOG_DIR="pipeline_data/models/logs/${RUN_NAME}"
LAUNCH_LOG="pipeline_data/models/logs/${RUN_NAME}.launch.log"
PID_FILE="pipeline_data/models/logs/${RUN_NAME}.pid"

mkdir -p "$LOG_DIR"

# Replace ATLAS_TENSOR_PATH/ATLAS_VOCAB_PATH below with whichever you decided in
# pre-flight check 2.
nohup python3 -u scripts/PopulationPipeline/OutdoorML/train_scene_placer.py \
    --tensor-path  pipeline_data/reference/component_linked_unified_v7_tensors.npz \
    --vocab-path   pipeline_data/reference/component_linked_unified_v7_vocab.json \
    --atlas-tensor-path  ATLAS_TENSOR_PATH \
    --atlas-vocab-path   ATLAS_VOCAB_PATH \
    --atlas-warmup-epochs 3 \
    --atlas-context-dropout 0.1 \
    --run-name "${RUN_NAME}" \
    --epochs 60 --batch 128 --patience 8 --validation-every 3 \
    --val-split-mode region --lr-schedule cosine \
    --lr 5e-5 --lr-min 1e-6 \
    --warmup-epochs 5 --warmup-min-epochs 5 --warmup-fraction-cap 0.10 \
    --ace-abstract-weight 4.0 \
    --dat-inv-freq --dat-clamp-max 3.0 \
    --label-smoothing 0.10 \
    --lambda-marginal-kl 0.06 \
    --focal-gamma 0.0 \
    --resume-checkpoint-every 5 \
    > "$LAUNCH_LOG" 2>&1 &

echo $! > "$PID_FILE"
echo "Started v8 (PID $(cat $PID_FILE)). Tail with: tail -f $LAUNCH_LOG"

## Hyperparameter rationale (the deltas from v7)

  --atlas-warmup-epochs 3       (v6 had this; v7 dropped it)
  --atlas-context-dropout 0.1   (v6 had this; v7 dropped it)
  --label-smoothing 0.10        (v6=0.10, v7=0.15 — revert to v6)
  --lambda-marginal-kl 0.06     (v6=0.03, v7=0.12 — middle ground)

Everything else matches v7 exactly so the dataset is the only orthogonal variable
remaining. If v8 catches v6 SHIPPING by ep30, the v7 dataset is fine and the
plateau was caused by missing atlas-context + over-regularization. If v8 still
lags, the `_emptylb` dataset itself is the regression — investigate dataset
construction (likely empty-landblock entries crowding out signal in `extract_*`).

## Success criteria (check at ep17 — same point we have v6 + v7 measurements for)

Compare v8 ep17 against:
  v6 ep14 (closest v6 val checkpoint): val_total ≈ 4.5–5.0, top1 ≈ 0.85, unique ≈ 1300
  v7 ep17 (lagging benchmark):         val_total = 4.97,    top1 = 0.781,  unique = 1084

Pass:    v8 ep17 val_total ≤ v6 ep14 val_total AND unique_wcids ≥ 1300
Lagging: 4.97 ≥ v8 ep17 val_total > v6 ep14 val_total      → keep training, watch ep20
Fail:    v8 ep17 val_total > 4.97                          → kill, dataset is the problem

Also watch overfit_gap. v7's gap rose 0.66→0.90 across ep11→17. v8 should track
v6's curve (which was lower); a similar gap profile means the regularization
revert worked.

## After completion

When the run stops (patience-8, manual kill, or all 60 epochs):

1. Find the best epoch in pipeline_data/models/logs/${RUN_NAME}/training_history.json
   (lowest val_total).
2. If best_val_total < 3.78, this is the new SHIPPING candidate. Rename the best
   checkpoint:
     cp pipeline_data/models/${RUN_NAME}_best.safetensors \
        pipeline_data/models/SHIPPING_unified_v8_atlas_emptylb_ep${BEST_EP}_$(date -u +%Y%m%d).safetensors
   Update memory file `project_unified_scene_placer.md` with the new SHIPPING
   path + headline metrics.
3. If best_val_total ≥ 3.78, leave v6 SHIPPING in place and write the negative
   result into `project_unified_scene_placer.md` so the next experimenter doesn't
   repeat the same config.

## Do NOT

- Do NOT delete ${RUN_NAME}_resume_epoch_*.pt mid-run — they exist for crash recovery.
- Do NOT bump --batch above 128 on the L4; 15.6/23GB at batch=128 in v7 is already
  ~70% memory utilization.
- Do NOT change --val-split-mode from region; we need apples-to-apples val numbers
  vs v6/v7.
- Do NOT mix v5 and v7 atlas if vocabs differ (pre-flight check 2). Wrong indices
  silently corrupt training and look like a "bad config" failure.

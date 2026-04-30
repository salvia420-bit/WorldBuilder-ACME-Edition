#!/usr/bin/env python3
"""diagnose_v4.py — Phase-0 diagnostic for the v4 unified scene-placer.

Read-only inspection of `unified_v4_clean_ctx_20260427T2315Z_best` against
the region-mode val split. Surfaces the failure mode behind the v4 plateau
so V5 reweighting/architecture choices are made from data, not vibes.

Produces:
  - per-class-space confusion (ACE / DAT / special) at top-1
  - top-1, top-5, top-10 wcid accuracy, broken down by class space
  - per-scene_kind metrics (outdoor / interior_anchored / interior_unanchored)
  - per-token frequency: top-50 emitted, top-50 under-emitted-vs-retail
  - per-token KL divergence between empirical retail and model-argmax
  - long-tail recall (fraction of vocab tokens with retail support that
    appear at least once in val greedy output)

Numbers go to `pipeline_data/models/logs/<run>/diagnose_v4.json`. A short
summary prints to stdout.

Why this exists: v4 plateaued at val_total ≈ 6.02 with ace_emit_frac ≈ 0.577
and unique_wcids ≈ 1560 / 4574 used. We need to know whether the bias is
uniform across class spaces or concentrated on a handful of dominant
tokens (the calibration framing) before launching any retraining sweep.
"""

import argparse
import json
import os
import sys
import time
from collections import Counter
from typing import Dict, List, Tuple

import numpy as np
import torch
from torch.utils.data import DataLoader

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# Reuse trainer primitives so model/dataset/val-split match training exactly.
from train_scene_placer import (  # noqa: E402
    BASE_DIR,
    DEFAULT_CONFIG,
    PAD_TOKEN,
    STOP_TOKEN,
    PlacementDataset,
    ScenePlacerTransformer,
    build_ace_abstract_mask,
    build_component_feature_matrix,
    load_vocab_metadata,
    split_indices_for_validation,
)


DEFAULT_CHECKPOINT = os.path.join(
    BASE_DIR, "pipeline_data", "models",
    "unified_v4_clean_ctx_20260427T2315Z_best.safetensors",
)
DEFAULT_TENSOR_PATH = os.path.join(
    BASE_DIR, "pipeline_data", "reference",
    "component_linked_unified_v4_tensors.npz",
)
DEFAULT_VOCAB_PATH = os.path.join(
    BASE_DIR, "pipeline_data", "reference",
    "component_linked_unified_v4_vocab.json",
)
DEFAULT_RUN_NAME = "unified_v4_clean_ctx_20260427T2315Z"

CLASS_NAMES = ("special", "ace", "dat")  # display order: SPECIAL/ACE/DAT
SCENE_KIND_NAMES = ("outdoor", "interior_anchored", "interior_unanchored")


def build_class_space_arrays(vocab: dict, vocab_size: int) -> Dict[str, np.ndarray]:
    """Per-token boolean masks for each class space."""
    is_ace = np.zeros(vocab_size, dtype=bool)
    is_dat = np.zeros(vocab_size, dtype=bool)
    is_special = np.zeros(vocab_size, dtype=bool)
    for raw_idx, kv in (vocab.get("idx_to_class_key") or {}).items():
        if not isinstance(kv, (list, tuple)) or len(kv) != 2:
            continue
        try:
            idx = int(raw_idx)
        except (TypeError, ValueError):
            continue
        if not 0 <= idx < vocab_size:
            continue
        kind = str(kv[0])
        if kind == "ace_abstract":
            is_ace[idx] = True
        elif kind == "model_id":
            is_dat[idx] = True
        elif kind == "special":
            is_special[idx] = True
    return {"ace": is_ace, "dat": is_dat, "special": is_special}


def per_token_class_index(class_arrays: Dict[str, np.ndarray]) -> np.ndarray:
    """Map each vocab idx to: 0=special, 1=ace, 2=dat, 3=other (unused)."""
    n = class_arrays["ace"].shape[0]
    out = np.full(n, 3, dtype=np.int8)  # default "other"
    out[class_arrays["special"]] = 0
    out[class_arrays["ace"]] = 1
    out[class_arrays["dat"]] = 2
    return out


def empirical_token_distribution(sequences: np.ndarray, seq_lengths: np.ndarray,
                                 indices: np.ndarray, vocab_size: int) -> np.ndarray:
    """Per-token marginal over labels in the supplied row indices."""
    counts = np.zeros(vocab_size, dtype=np.float64)
    for i in indices:
        n = int(seq_lengths[i])
        if n == 0:
            continue
        wcids = sequences[i, :n, 0].astype(np.int64)
        wcids = wcids[(wcids >= 0) & (wcids < vocab_size)]
        if wcids.size:
            np.add.at(counts, wcids, 1.0)
    total = counts.sum()
    if total <= 0:
        return counts
    return counts / total


def kl_divergence(p: np.ndarray, q: np.ndarray, eps: float = 1e-12) -> float:
    """KL(p || q) in nats. q smoothed by eps to keep KL finite when q has zeros."""
    p_safe = p.astype(np.float64)
    q_safe = np.maximum(q.astype(np.float64), eps)
    p_safe = p_safe / max(p_safe.sum(), eps)
    q_safe = q_safe / max(q_safe.sum(), eps)
    mask = p_safe > 0
    return float((p_safe[mask] * (np.log(p_safe[mask]) - np.log(q_safe[mask]))).sum())


def jensen_shannon(p: np.ndarray, q: np.ndarray, eps: float = 1e-12) -> float:
    p_safe = np.maximum(p.astype(np.float64), 0.0)
    q_safe = np.maximum(q.astype(np.float64), 0.0)
    p_safe = p_safe / max(p_safe.sum(), eps)
    q_safe = q_safe / max(q_safe.sum(), eps)
    m = 0.5 * (p_safe + q_safe)
    return 0.5 * kl_divergence(p_safe, m) + 0.5 * kl_divergence(q_safe, m)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=str, default=DEFAULT_CHECKPOINT)
    parser.add_argument("--tensor-path", type=str, default=DEFAULT_TENSOR_PATH)
    parser.add_argument("--vocab-path", type=str, default=DEFAULT_VOCAB_PATH)
    parser.add_argument("--run-name", type=str, default=DEFAULT_RUN_NAME)
    parser.add_argument("--batch", type=int, default=64)
    parser.add_argument("--max-batches", type=int, default=None,
                        help="Cap val batches for a fast sanity run.")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--device", type=str, default=None)
    parser.add_argument("--output-json", type=str, default=None)
    args = parser.parse_args()

    print("=" * 72)
    print("  diagnose_v4 — Phase 0 calibration probe")
    print("=" * 72)

    # ── Load tensors + vocab ──
    print(f"  Tensors: {args.tensor_path}")
    print(f"  Vocab:   {args.vocab_path}")
    print(f"  CKPT:    {args.checkpoint}")
    data = np.load(args.tensor_path)
    contexts = data["contexts"]
    sequences = data["sequences"]
    seq_lengths = data["seq_lengths"]
    lb_coords = data["lb_coords"]
    scene_kinds = data["scene_kinds"].astype(np.int64)

    vocab = load_vocab_metadata(args.vocab_path)
    vocab_size = int(vocab["vocab_size"])

    # The trainer concatenates a 12-d component feature matrix onto the
    # sequence tensor at runtime. Replicate that here so the model sees
    # exactly what it saw during training.
    if "component_index_by_object" in data.files:
        component_features = build_component_feature_matrix(data, vocab_size)
        link_idx = sequences.shape[2]
        sequences = np.concatenate([sequences, component_features], axis=-1)
        dataset_schema = "component_linked"
        coord_slice = (2, 4)
        rot_slice = (5, 7)
    else:
        dataset_schema = "legacy"
        link_idx = 7
        coord_slice = (1, 3)
        rot_slice = (4, 6)

    # ── Region-mode val split (same seed as training) ──
    train_idx, val_idx = split_indices_for_validation(
        lb_coords=lb_coords,
        val_split=DEFAULT_CONFIG["val_split"],
        mode="region",
        region_tile_size=DEFAULT_CONFIG["region_tile_size"],
        seed=DEFAULT_CONFIG["split_seed"],
    )
    print(f"  Train: {len(train_idx)}  Val: {len(val_idx)}  "
          f"(region-mode, seed {DEFAULT_CONFIG['split_seed']})")

    # ── Class-space masks ──
    class_arrays = build_class_space_arrays(vocab, vocab_size)
    n_ace = int(class_arrays["ace"].sum())
    n_dat = int(class_arrays["dat"].sum())
    n_special = int(class_arrays["special"].sum())
    print(f"  Vocab class spaces: ace={n_ace} dat={n_dat} special={n_special} "
          f"(total={vocab_size})")

    # ── Empirical retail distributions ──
    p_train = empirical_token_distribution(sequences, seq_lengths, train_idx, vocab_size)
    p_val = empirical_token_distribution(sequences, seq_lengths, val_idx, vocab_size)
    train_class_mass = {
        "ace": float(p_train[class_arrays["ace"]].sum()),
        "dat": float(p_train[class_arrays["dat"]].sum()),
        "special": float(p_train[class_arrays["special"]].sum()),
    }
    val_class_mass = {
        "ace": float(p_val[class_arrays["ace"]].sum()),
        "dat": float(p_val[class_arrays["dat"]].sum()),
        "special": float(p_val[class_arrays["special"]].sum()),
    }
    print(f"  Train label class mix:  "
          f"ACE={train_class_mass['ace']:.3f}  "
          f"DAT={train_class_mass['dat']:.3f}  "
          f"SPECIAL={train_class_mass['special']:.3f}")
    print(f"  Val   label class mix:  "
          f"ACE={val_class_mass['ace']:.3f}  "
          f"DAT={val_class_mass['dat']:.3f}  "
          f"SPECIAL={val_class_mass['special']:.3f}")

    # ── Build model and load weights ──
    config = DEFAULT_CONFIG.copy()
    config["context_dim"] = int(contexts.shape[1])
    config["obj_dim"] = int(sequences.shape[2])
    config["max_seq_len"] = int(sequences.shape[1])
    config["vocab_path"] = args.vocab_path
    config["dataset_schema"] = dataset_schema
    config["coord_slice"] = coord_slice
    config["rot_slice"] = rot_slice
    config["link_idx"] = link_idx
    config["target_token_mode"] = str(vocab.get("target_token_mode", "exact")).lower()

    if args.device is None:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    else:
        device = torch.device(args.device)
    print(f"  Device: {device}")

    print("  Building model + loading weights...")
    model = ScenePlacerTransformer(config).to(device)
    from safetensors.torch import load_file
    state = load_file(args.checkpoint, device=str(device))
    missing, unexpected = model.load_state_dict(state, strict=False)
    if missing:
        print(f"    WARN: missing {len(missing)} tensors (e.g. {missing[:3]})")
    if unexpected:
        print(f"    WARN: unexpected {len(unexpected)} tensors (e.g. {unexpected[:3]})")
    model.eval()
    n_params = sum(p.numel() for p in model.parameters())
    print(f"    Params: {n_params/1e6:.1f}M")

    # ── Val DataLoader ──
    val_ds = PlacementDataset(
        contexts, sequences, seq_lengths, config,
        indices=val_idx, augment=False,
    )
    val_loader = DataLoader(val_ds, batch_size=args.batch, shuffle=False,
                            num_workers=0, pin_memory=(device.type == "cuda"))

    # ── Streaming val pass ──
    print(f"  Running val pass (batch={args.batch}, top_k={args.top_k})...")
    is_ace_t = torch.from_numpy(class_arrays["ace"]).to(device)
    is_dat_t = torch.from_numpy(class_arrays["dat"]).to(device)
    is_special_t = torch.from_numpy(class_arrays["special"]).to(device)

    pred_count = np.zeros(vocab_size, dtype=np.int64)
    label_count = np.zeros(vocab_size, dtype=np.int64)

    # Confusion: rows = label class (special/ace/dat/other), cols = pred class.
    confusion = np.zeros((4, 4), dtype=np.int64)

    top1 = top5 = top10 = total_pos = 0
    # Per-class top-K
    cls_total = {"ace": 0, "dat": 0, "special": 0}
    cls_top1 = {"ace": 0, "dat": 0, "special": 0}
    cls_top5 = {"ace": 0, "dat": 0, "special": 0}
    cls_top10 = {"ace": 0, "dat": 0, "special": 0}

    # Per-scene_kind: total positions, top-1 hits, ACE-emit count, label class mass
    sk_total = np.zeros(3, dtype=np.int64)
    sk_top1 = np.zeros(3, dtype=np.int64)
    sk_pred_ace = np.zeros(3, dtype=np.int64)
    sk_pred_dat = np.zeros(3, dtype=np.int64)
    sk_label_ace = np.zeros(3, dtype=np.int64)
    sk_label_dat = np.zeros(3, dtype=np.int64)
    sk_unique_pred: List[set] = [set(), set(), set()]

    # The val DataLoader iterates val_idx in order — track by batch offset.
    val_indices_arr = np.asarray(val_idx, dtype=np.int64)

    n_processed_samples = 0
    t0 = time.time()

    with torch.no_grad():
        for batch_idx, batch in enumerate(val_loader):
            if args.max_batches is not None and batch_idx >= args.max_batches:
                break
            ctx, input_seq, target_wcid, _, _, _, mask, _ = batch
            ctx = ctx.to(device, non_blocking=True)
            input_seq = input_seq.to(device, non_blocking=True)
            mask_d = mask.to(device, non_blocking=True)
            target_wcid_d = target_wcid.to(device, non_blocking=True)

            wcid_logits, _, _, _ = model(ctx, input_seq, mask_d)  # (B,T,V)
            B, T, V = wcid_logits.shape

            topk_idx = torch.topk(wcid_logits, k=max(args.top_k, 10), dim=-1).indices  # (B,T,K)

            # Per-position scene_kind broadcast
            batch_sample_idx = val_indices_arr[
                n_processed_samples : n_processed_samples + B
            ]
            n_processed_samples += B
            sk_per_sample = torch.from_numpy(scene_kinds[batch_sample_idx]).to(device)  # (B,)
            sk_per_pos = sk_per_sample.unsqueeze(1).expand(B, T)  # (B,T)

            active = mask_d  # (B,T) bool

            # Argmax = top-1
            pred = topk_idx[:, :, 0]  # (B,T)

            # Hits at top-1/5/10
            hit1 = (pred == target_wcid_d) & active
            hit5 = (topk_idx[:, :, :5] == target_wcid_d.unsqueeze(-1)).any(-1) & active
            hit10 = (topk_idx[:, :, :10] == target_wcid_d.unsqueeze(-1)).any(-1) & active

            top1 += int(hit1.sum().item())
            top5 += int(hit5.sum().item())
            top10 += int(hit10.sum().item())
            total_pos += int(active.sum().item())

            # Class-space membership of label and pred
            label_is_ace = is_ace_t[target_wcid_d.clamp(0, V - 1)] & active
            label_is_dat = is_dat_t[target_wcid_d.clamp(0, V - 1)] & active
            label_is_special = is_special_t[target_wcid_d.clamp(0, V - 1)] & active
            pred_is_ace = is_ace_t[pred] & active
            pred_is_dat = is_dat_t[pred] & active
            pred_is_special = is_special_t[pred] & active

            cls_total["ace"] += int(label_is_ace.sum().item())
            cls_total["dat"] += int(label_is_dat.sum().item())
            cls_total["special"] += int(label_is_special.sum().item())
            cls_top1["ace"] += int((label_is_ace & hit1).sum().item())
            cls_top1["dat"] += int((label_is_dat & hit1).sum().item())
            cls_top1["special"] += int((label_is_special & hit1).sum().item())
            cls_top5["ace"] += int((label_is_ace & hit5).sum().item())
            cls_top5["dat"] += int((label_is_dat & hit5).sum().item())
            cls_top5["special"] += int((label_is_special & hit5).sum().item())
            cls_top10["ace"] += int((label_is_ace & hit10).sum().item())
            cls_top10["dat"] += int((label_is_dat & hit10).sum().item())
            cls_top10["special"] += int((label_is_special & hit10).sum().item())

            # Confusion matrix
            for label_kind, label_mask in (
                (1, label_is_ace), (2, label_is_dat), (0, label_is_special),
            ):
                for pred_kind, pred_mask in (
                    (1, pred_is_ace), (2, pred_is_dat), (0, pred_is_special),
                ):
                    confusion[label_kind, pred_kind] += int(
                        (label_mask & pred_mask).sum().item()
                    )
                # rest = "other" pred class
                pred_other = active & ~(pred_is_ace | pred_is_dat | pred_is_special)
                confusion[label_kind, 3] += int((label_mask & pred_other).sum().item())
            label_other = active & ~(label_is_ace | label_is_dat | label_is_special)
            for pred_kind, pred_mask in (
                (1, pred_is_ace), (2, pred_is_dat), (0, pred_is_special),
            ):
                confusion[3, pred_kind] += int((label_other & pred_mask).sum().item())
            confusion[3, 3] += int(
                (label_other & active & ~(pred_is_ace | pred_is_dat | pred_is_special)).sum().item()
            )

            # Per-scene_kind
            for sk in (0, 1, 2):
                sk_mask = (sk_per_pos == sk) & active
                sk_total[sk] += int(sk_mask.sum().item())
                sk_top1[sk] += int((sk_mask & hit1).sum().item())
                sk_pred_ace[sk] += int((sk_mask & pred_is_ace).sum().item())
                sk_pred_dat[sk] += int((sk_mask & pred_is_dat).sum().item())
                sk_label_ace[sk] += int((sk_mask & label_is_ace).sum().item())
                sk_label_dat[sk] += int((sk_mask & label_is_dat).sum().item())
                sk_preds = pred[sk_mask].cpu().numpy()
                if sk_preds.size:
                    sk_unique_pred[sk].update(sk_preds.tolist())

            # Aggregate token frequency counts
            pred_active = pred[active].cpu().numpy()
            label_active = target_wcid_d[active].cpu().numpy()
            np.add.at(pred_count, pred_active, 1)
            np.add.at(label_count, label_active, 1)

            if batch_idx % 50 == 0:
                elapsed = time.time() - t0
                print(f"    batch {batch_idx:4d}  positions={total_pos:>9d}  "
                      f"top1={top1/max(total_pos,1):.4f}  "
                      f"elapsed={elapsed:.1f}s")

    elapsed = time.time() - t0
    print(f"  Val pass done in {elapsed:.1f}s — {total_pos} positions across "
          f"{n_processed_samples} sequences")

    # ── Aggregate metrics ──
    q_pred = pred_count.astype(np.float64) / max(pred_count.sum(), 1)
    q_val_label = label_count.astype(np.float64) / max(label_count.sum(), 1)

    pred_ace_mass = float(q_pred[class_arrays["ace"]].sum())
    pred_dat_mass = float(q_pred[class_arrays["dat"]].sum())
    pred_special_mass = float(q_pred[class_arrays["special"]].sum())

    # ace_emit_frac matching trainer: ACE preds / ALL active preds (the trainer
    # uses the same denominator). We also report the alternative excluding
    # specials, which is what the prompt's "0.577 vs 0.613" framing uses.
    ace_emit_frac_all = pred_ace_mass
    nonspecial_total = pred_count[~class_arrays["special"]].sum()
    ace_emit_frac_nonspecial = (
        float(pred_count[class_arrays["ace"]].sum()) / max(nonspecial_total, 1)
    )

    # KL divergences: training labels vs model argmax over val.
    kl_train_to_pred = kl_divergence(p_train, q_pred)
    kl_pred_to_train = kl_divergence(q_pred, p_train)
    jsd_train_pred = jensen_shannon(p_train, q_pred)
    # Class-space-conditional KL excluding specials (the calibration metric):
    nonspecial_mask = ~class_arrays["special"]
    p_train_ns = p_train[nonspecial_mask]
    q_pred_ns = q_pred[nonspecial_mask]
    kl_train_to_pred_ns = kl_divergence(p_train_ns, q_pred_ns)
    jsd_ns = jensen_shannon(p_train_ns, q_pred_ns)

    # Long-tail recall: fraction of "supported" tokens (train_freq > 0)
    # that appear at least once in val greedy output.
    supported = label_count_train_mask = p_train > 0
    n_supported = int(supported.sum())
    n_emitted = int(((pred_count > 0) & supported).sum())
    long_tail_recall = n_emitted / max(n_supported, 1)
    n_unique_pred = int((pred_count > 0).sum())

    # Per-token ratio (pred_freq / train_freq), for spotting under-emission.
    safe_p_train = np.where(supported, p_train, 1.0)
    emit_ratio = q_pred / safe_p_train
    emit_ratio[~supported] = 0.0

    # Build top-N tables
    def fmt_token(idx: int) -> str:
        kv = vocab["idx_to_class_key"].get(str(idx), ["?", "?"])
        return f"{idx} {kv[0]}:{kv[1]}"

    top_emitted_idx = np.argsort(pred_count)[::-1][:50]
    top_under_idx = np.argsort(emit_ratio)
    # Filter to tokens with substantial retail mass (otherwise "ratio = 0"
    # is dominated by tail tokens that retail itself almost never sees).
    train_freq_thresh = np.quantile(p_train[supported], 0.50) if n_supported > 0 else 0.0
    candidates = [
        i for i in top_under_idx
        if supported[i] and p_train[i] >= train_freq_thresh
    ][:50]

    # Per-scene_kind summary
    scene_kind_metrics = []
    for sk in (0, 1, 2):
        if sk_total[sk] == 0:
            scene_kind_metrics.append({
                "name": SCENE_KIND_NAMES[sk],
                "positions": 0,
                "top1": 0.0,
                "ace_emit_frac": 0.0,
                "dat_emit_frac": 0.0,
                "label_ace_frac": 0.0,
                "label_dat_frac": 0.0,
                "unique_preds": 0,
            })
            continue
        scene_kind_metrics.append({
            "name": SCENE_KIND_NAMES[sk],
            "positions": int(sk_total[sk]),
            "top1": float(sk_top1[sk] / sk_total[sk]),
            "ace_emit_frac": float(sk_pred_ace[sk] / sk_total[sk]),
            "dat_emit_frac": float(sk_pred_dat[sk] / sk_total[sk]),
            "label_ace_frac": float(sk_label_ace[sk] / sk_total[sk]),
            "label_dat_frac": float(sk_label_dat[sk] / sk_total[sk]),
            "unique_preds": int(len(sk_unique_pred[sk])),
        })

    # ── Print summary ──
    print()
    print("─" * 72)
    print("  Headline metrics")
    print("─" * 72)
    print(f"  Total val positions:          {total_pos}")
    print(f"  Top-1 wcid acc (overall):     {top1/max(total_pos,1):.4f}")
    print(f"  Top-5 wcid acc (overall):     {top5/max(total_pos,1):.4f}")
    print(f"  Top-10 wcid acc (overall):    {top10/max(total_pos,1):.4f}")
    print(f"  Unique wcids in val preds:    {n_unique_pred} / {n_supported} supported "
          f"({long_tail_recall:.3f} recall)")
    print(f"  ace_emit_frac (all preds):       {ace_emit_frac_all:.4f}")
    print(f"  ace_emit_frac (excl. specials):  {ace_emit_frac_nonspecial:.4f}")
    print(f"  dat_emit_frac (all preds):       {pred_dat_mass:.4f}")
    print(f"  special_emit_frac (all preds):   {pred_special_mass:.4f}")
    print(f"  KL(retail || model)  full vocab: {kl_train_to_pred:.4f} nats")
    print(f"  KL(model  || retail) full vocab: {kl_pred_to_train:.4f} nats")
    print(f"  JS divergence       full vocab:  {jsd_train_pred:.4f} nats")
    print(f"  KL(retail || model) ex-specials: {kl_train_to_pred_ns:.4f} nats")
    print(f"  JS divergence       ex-specials: {jsd_ns:.4f} nats")

    print()
    print("─" * 72)
    print("  Per class-space top-K accuracy")
    print("─" * 72)
    print(f"  {'class':<10} {'count':>10}  {'top1':>8}  {'top5':>8}  {'top10':>8}")
    for cls in ("ace", "dat", "special"):
        n = max(cls_total[cls], 1)
        print(f"  {cls:<10} {cls_total[cls]:>10}  "
              f"{cls_top1[cls]/n:>8.4f}  {cls_top5[cls]/n:>8.4f}  {cls_top10[cls]/n:>8.4f}")

    print()
    print("─" * 72)
    print("  Confusion at top-1: rows=label, cols=pred (counts)")
    print("─" * 72)
    print(f"  {'':<10} {'pred=SPC':>10} {'pred=ACE':>10} {'pred=DAT':>10} {'pred=OTH':>10}")
    for r, name in enumerate(("SPECIAL", "ACE", "DAT", "OTHER")):
        row = confusion[r]
        print(f"  {name:<10} {row[0]:>10d} {row[1]:>10d} {row[2]:>10d} {row[3]:>10d}")
    # row-normalized
    print()
    print(f"  {'':<10} {'pred=SPC':>10} {'pred=ACE':>10} {'pred=DAT':>10} {'pred=OTH':>10}")
    for r, name in enumerate(("SPECIAL", "ACE", "DAT", "OTHER")):
        row = confusion[r]
        s = max(row.sum(), 1)
        print(f"  {name:<10} {row[0]/s:>10.4f} {row[1]/s:>10.4f} {row[2]/s:>10.4f} {row[3]/s:>10.4f}")

    print()
    print("─" * 72)
    print("  Per scene_kind metrics")
    print("─" * 72)
    print(f"  {'scene_kind':<22} {'positions':>10} {'top1':>8}  "
          f"{'ace_emit':>10} {'dat_emit':>10} {'unique':>8}  "
          f"{'label_ace':>10} {'label_dat':>10}")
    for m in scene_kind_metrics:
        print(f"  {m['name']:<22} {m['positions']:>10} {m['top1']:>8.4f}  "
              f"{m['ace_emit_frac']:>10.4f} {m['dat_emit_frac']:>10.4f} "
              f"{m['unique_preds']:>8d}  "
              f"{m['label_ace_frac']:>10.4f} {m['label_dat_frac']:>10.4f}")

    print()
    print("─" * 72)
    print("  Top-20 most-emitted-by-model tokens")
    print("─" * 72)
    print(f"  {'rank':>4}  {'idx':>5}  {'kind':<14}  {'pred%':>7}  {'train%':>7}  {'ratio':>7}  key")
    for rank, idx in enumerate(top_emitted_idx[:20]):
        kv = vocab["idx_to_class_key"].get(str(int(idx)), ["?", "?"])
        ratio = emit_ratio[idx] if supported[idx] else float('inf')
        print(f"  {rank+1:>4}  {int(idx):>5}  {kv[0]:<14}  "
              f"{100*q_pred[idx]:>6.3f}%  {100*p_train[idx]:>6.3f}%  "
              f"{ratio:>7.2f}  {kv[1]}")

    print()
    print("─" * 72)
    print("  Top-20 most-under-emitted-vs-retail tokens")
    print("    (high train freq, low pred freq — model ignoring these)")
    print("─" * 72)
    print(f"  {'rank':>4}  {'idx':>5}  {'kind':<14}  {'pred%':>7}  {'train%':>7}  {'ratio':>7}  key")
    for rank, idx in enumerate(candidates[:20]):
        kv = vocab["idx_to_class_key"].get(str(int(idx)), ["?", "?"])
        ratio = emit_ratio[idx]
        print(f"  {rank+1:>4}  {int(idx):>5}  {kv[0]:<14}  "
              f"{100*q_pred[idx]:>6.3f}%  {100*p_train[idx]:>6.3f}%  "
              f"{ratio:>7.4f}  {kv[1]}")

    # ── Persist JSON ──
    out_dir = os.path.join(BASE_DIR, "pipeline_data", "models", "logs", args.run_name)
    os.makedirs(out_dir, exist_ok=True)
    out_path = args.output_json or os.path.join(out_dir, "diagnose_v4.json")

    payload = {
        "checkpoint": args.checkpoint,
        "tensor_path": args.tensor_path,
        "vocab_path": args.vocab_path,
        "vocab_size": vocab_size,
        "n_ace": n_ace,
        "n_dat": n_dat,
        "n_special": n_special,
        "train_size": int(len(train_idx)),
        "val_size": int(len(val_idx)),
        "val_positions": int(total_pos),
        "elapsed_seconds": float(elapsed),
        "headline": {
            "top1": top1 / max(total_pos, 1),
            "top5": top5 / max(total_pos, 1),
            "top10": top10 / max(total_pos, 1),
            "unique_pred": n_unique_pred,
            "n_supported": n_supported,
            "long_tail_recall": long_tail_recall,
            "ace_emit_frac_all": ace_emit_frac_all,
            "ace_emit_frac_nonspecial": ace_emit_frac_nonspecial,
            "dat_emit_frac_all": pred_dat_mass,
            "special_emit_frac_all": pred_special_mass,
            "kl_retail_to_model": kl_train_to_pred,
            "kl_model_to_retail": kl_pred_to_train,
            "jsd_full_vocab": jsd_train_pred,
            "kl_retail_to_model_ex_specials": kl_train_to_pred_ns,
            "jsd_ex_specials": jsd_ns,
        },
        "class_space": {
            "train_label_mass": train_class_mass,
            "val_label_mass": val_class_mass,
            "pred_mass": {
                "ace": pred_ace_mass,
                "dat": pred_dat_mass,
                "special": pred_special_mass,
            },
            "top1_acc": {k: cls_top1[k] / max(cls_total[k], 1) for k in cls_total},
            "top5_acc": {k: cls_top5[k] / max(cls_total[k], 1) for k in cls_total},
            "top10_acc": {k: cls_top10[k] / max(cls_total[k], 1) for k in cls_total},
            "label_count": cls_total,
        },
        "confusion_top1": confusion.tolist(),
        "confusion_classes": ["special", "ace", "dat", "other"],
        "scene_kind_metrics": scene_kind_metrics,
        "top_emitted": [
            {
                "rank": i + 1,
                "idx": int(idx),
                "key": vocab["idx_to_class_key"].get(str(int(idx)), ["?", "?"]),
                "pred_count": int(pred_count[idx]),
                "pred_frac": float(q_pred[idx]),
                "train_frac": float(p_train[idx]),
                "emit_ratio": float(emit_ratio[idx]),
            }
            for i, idx in enumerate(top_emitted_idx[:50])
        ],
        "top_under_emitted": [
            {
                "rank": i + 1,
                "idx": int(idx),
                "key": vocab["idx_to_class_key"].get(str(int(idx)), ["?", "?"]),
                "pred_count": int(pred_count[idx]),
                "pred_frac": float(q_pred[idx]),
                "train_frac": float(p_train[idx]),
                "emit_ratio": float(emit_ratio[idx]),
            }
            for i, idx in enumerate(candidates[:50])
        ],
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    print()
    print(f"  Wrote: {out_path}")


if __name__ == "__main__":
    main()

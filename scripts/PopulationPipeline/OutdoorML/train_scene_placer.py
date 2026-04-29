#!/usr/bin/env python3
"""
train_scene_placer.py — Scene Placement Transformer Training
=============================================================

GPT-style autoregressive transformer that learns to place objects on
Dereth's landscape from retail AC data.

Architecture:
  - Input: landblock context + sequence of previous objects
  - Output: Next object (wcid, position, rotation, link flag)
  - 8-layer Transformer decoder, 512 d_model, 8 heads, ~45M params

Anti-Overfitting Rails:
  - Label smoothing (0.1)
  - Dropout (0.15 attn, 0.1 FFN)
  - EMA weights (decay 0.999)
  - Cosine annealing LR schedule
  - Early stopping: overfit_gap > 1.0 or wcid_entropy < 3.0
  - Context jitter (±3% Gaussian noise on terrain features)

Pro-Variance:
  - Temperature sampling (0.8) at inference
  - Nucleus sampling (p=0.92)
  - Frequency penalty (-0.3 * log freq)
  - Rotation augmentation (random 90° flips)
  - Coordinate noise (σ=2.0 world units)

Usage:
    python scripts/PopulationPipeline/OutdoorML/train_scene_placer.py
    python scripts/PopulationPipeline/OutdoorML/train_scene_placer.py --resume pipeline_data/models/resume.pt
    python scripts/PopulationPipeline/OutdoorML/train_scene_placer.py --epochs 500 --batch 64

Runs on NVIDIA L4 (24GB), A100 (40/80GB), or H100 (80GB).
Estimated training time: H100 ~45min, A100 ~2.5h, L4 ~11h.
"""

import argparse
import json
import math
import os
import tempfile
import sys
import time
import random
from collections import defaultdict
from typing import Dict, List, Optional, Tuple

import numpy as np

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(line_buffering=True, write_through=True)
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(line_buffering=True, write_through=True)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from settlement_signatures import (
    SETTLEMENT_ROLE_LABELS,
    WT_CREATURE,
    WT_DOOR,
    WT_LIFESTONE,
    WT_PORTAL,
    WT_SLUMLORD,
    WT_VENDOR,
)

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    from torch.utils.data import Dataset, DataLoader, WeightedRandomSampler
    from torch.cuda.amp import GradScaler, autocast
except ImportError:
    print("ERROR: PyTorch not found. Install with: pip install torch")
    print("  For L4 GPU: pip install torch --index-url https://download.pytorch.org/whl/cu121")
    sys.exit(1)

# ─── Configuration ───────────────────────────────────────────────────────────

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

TENSOR_PATH = os.path.join(BASE_DIR, "pipeline_data", "reference", "component_linked_tensors.npz")
VOCAB_PATH = os.path.join(BASE_DIR, "pipeline_data", "reference", "component_linked_vocab.json")
CHECKPOINT_DIR = os.path.join(BASE_DIR, "pipeline_data", "models")
LOG_DIR = os.path.join(BASE_DIR, "pipeline_data", "models", "logs")

# Special tokens
PAD_TOKEN = 0
STOP_TOKEN = 1

FAMILY_OTHER = 0
FAMILY_CREATURE = 1
FAMILY_PORTAL = 2
FAMILY_VENDOR = 3
FAMILY_LIFESTONE = 4
FAMILY_DOOR = 5
FAMILY_HOUSING = 6
FAMILY_COUNT = 7
BASE_CONTEXT_DIM = 224

# ─── Model Hyperparameters ───────────────────────────────────────────────────

DEFAULT_CONFIG = {
    # Architecture
    "context_dim": 224,
    "d_model": 512,
    "n_heads": 8,
    "n_layers": 8,
    "d_ff": 2048,
    "max_seq_len": 128,
    "dropout_attn": 0.2,
    "dropout_ff": 0.15,
    "label_smoothing": 0.2,
    
    # Object token width is inferred from the dataset at runtime.
    "obj_dim": 10,
    
    # Training
    "epochs": 1000,
    "batch_size": 64,
    "lr_max": 7e-5,
    "lr_min": 1e-6,
    "warmup_epochs": 20,
    "warmup_fraction_cap": 0.05,
    "warmup_min_epochs": 10,
    "weight_decay": 0.02,
    "ema_decay": 0.999,
    
    # Loss weights
    "lambda_pos": 10.0,
    "lambda_rot": 1.0,
    "lambda_link": 5.0,
    "lambda_entropy": 0.15,  # Entropy regularization to prevent mode collapse
    "lambda_dense_repeat": 0.35,
    # Focal loss on the wcid head. 0.0 = pure CE (legacy behaviour).
    # 1.0-2.0 down-weights gradient from already-confident classes so rare
    # weenies (which are most of the 4584-class vocab) get more signal.
    "focal_gamma": 0.0,

    # Cosine warm restart: when set to an epoch index, the cosine scheduler
    # resets to peak LR at that epoch and starts a fresh decay. 0 = no restart.
    "cosine_restart_epoch": 0,
    
    # Data augmentation
    "context_jitter_std": 0.05,
    "coord_noise_std": 3.0 / 192.0,  # 3.0 world units, normalized
    "rotation_augment": True,
    
    # Early stopping
    "patience": 12,
    "overfit_gap_threshold": 10.0,
    "min_overfit_epoch": 60,
    "entropy_collapse_threshold": 2.0,
    "min_entropy_check_epoch": 60,
    "entropy_lr_halving_enabled": True,
    
    # Checkpointing
    "checkpoint_every": 50,
    "resume_checkpoint_every": 25,
    
    # Validation
    "val_split": 0.15,
    "validation_every": 5,
    "val_split_mode": "region",
    "region_tile_size": 8,
    "split_seed": 42,
    "lr_schedule": "staged",
    "tensor_path": TENSOR_PATH,
    "vocab_path": VOCAB_PATH,
    "max_train_batches": None,
    "max_val_batches": None,
    "run_name": "scene_placer",
}

ROLE_INDEX_BY_LABEL = {label: idx for idx, label in enumerate(SETTLEMENT_ROLE_LABELS)}
DENSE_ROLE_INDICES = tuple(
    ROLE_INDEX_BY_LABEL[label]
    for label in ("service_node", "housing_cluster", "service_housing_town")
    if label in ROLE_INDEX_BY_LABEL
)


def load_wcid_types() -> Dict[int, int]:
    cache_path = os.path.join(BASE_DIR, "pipeline_data", "reference", "wcid_types_cache.json")
    if not os.path.exists(cache_path):
        return {}
    with open(cache_path) as f:
        data = json.load(f)
    return {int(k): int(v) for k, v in data.items()}


def load_vocab_metadata(vocab_path: str) -> dict:
    if not os.path.exists(vocab_path):
        return {}
    with open(vocab_path, "r", encoding="utf-8") as f:
        return json.load(f)


def token_family_for_wcid(wcid: int) -> int:
    if wcid == STOP_TOKEN:
        return FAMILY_OTHER
    if wcid == PAD_TOKEN:
        return FAMILY_OTHER
    if wcid in (2, 3, 4):
        return FAMILY_HOUSING
    return FAMILY_OTHER


def build_token_family_index(vocab_size: int, vocab_path: str) -> torch.Tensor:
    token_family = np.zeros(vocab_size, dtype=np.int64)
    wcid_types = load_wcid_types()
    vocab = load_vocab_metadata(vocab_path)
    target_token_mode = str(vocab.get("target_token_mode", "exact")).lower()
    idx_to_wcid = {int(k): int(v) for k, v in vocab.get("idx_to_wcid", {}).items()}
    idx_to_class_key = {int(k): v for k, v in vocab.get("idx_to_class_key", {}).items()}

    for token_idx in range(vocab_size):
        if token_idx in (PAD_TOKEN, STOP_TOKEN):
            family = FAMILY_OTHER
        elif target_token_mode == "exact" and token_idx in (2, 3, 4):
            family = FAMILY_HOUSING
        else:
            wcid = idx_to_wcid.get(token_idx)
            if wcid is None:
                class_key = idx_to_class_key.get(token_idx)
                if (
                    target_token_mode == "exact" and
                    class_key and
                    len(class_key) == 2 and
                    class_key[0] == 'wcid'
                ):
                    wcid = int(class_key[1])
            wtype = wcid_types.get(wcid, 0) if wcid is not None else 0
            if wtype == WT_CREATURE:
                family = FAMILY_CREATURE
            elif wtype == WT_PORTAL:
                family = FAMILY_PORTAL
            elif wtype == WT_VENDOR:
                family = FAMILY_VENDOR
            elif wtype == WT_LIFESTONE:
                family = FAMILY_LIFESTONE
            elif wtype == WT_DOOR:
                family = FAMILY_DOOR
            elif wtype == WT_SLUMLORD:
                family = FAMILY_HOUSING
            else:
                family = FAMILY_OTHER
        token_family[token_idx] = family

    return torch.from_numpy(token_family)


def build_class_space_weight(vocab_size: int, vocab_path: str,
                             ace_abstract_weight: float,
                             dat_inv_freq: bool = False,
                             dat_freq: Optional[np.ndarray] = None,
                             dat_clamp_min: float = 0.5,
                             dat_clamp_max: float = 5.0) -> torch.Tensor:
    """Per-vocab-idx weight applied to the wcid cross-entropy.

    Two-stage rebalancing:
      1. ACE entries multiplied by `ace_abstract_weight` (the v3 lever, ~10).
         This counteracts the ~41:1 DAT-vs-ACE vocab imbalance.
      2. (V5 addition) When `dat_inv_freq` is set, DAT entries are scaled by
         sqrt(median_dat_freq / token_dat_freq), clamped to [min, max]. This
         pushes gradient onto rare DAT tokens — Phase 0 diagnostic showed
         that the v4 plateau is *intra-DAT* long-tail collapse, not class-
         space miscalibration. ACE base weight composes multiplicatively
         with stage 1.

    A weight of 1.0 (the default for both stages) leaves the loss unchanged.
    """
    weight = torch.ones(vocab_size, dtype=torch.float32)
    try:
        with open(vocab_path, "r", encoding="utf-8") as f:
            vocab = json.load(f)
    except (OSError, json.JSONDecodeError):
        return weight
    idx_to_class_key = vocab.get("idx_to_class_key") or {}

    ace_indices = []
    dat_indices = []
    for raw_idx, kv in idx_to_class_key.items():
        if not isinstance(kv, (list, tuple)) or len(kv) != 2:
            continue
        try:
            idx = int(raw_idx)
        except (TypeError, ValueError):
            continue
        if not 0 <= idx < vocab_size:
            continue
        if kv[0] == "ace_abstract":
            ace_indices.append(idx)
        elif kv[0] == "model_id":
            dat_indices.append(idx)

    if abs(ace_abstract_weight - 1.0) > 1e-9:
        for idx in ace_indices:
            weight[idx] = ace_abstract_weight
        print(f"  class_space_weight: {len(ace_indices)} ace_abstract tokens × {ace_abstract_weight}")

    if dat_inv_freq and dat_freq is not None and dat_indices:
        dat_freq_arr = np.asarray(dat_freq, dtype=np.float64)
        dat_only = dat_freq_arr[dat_indices]
        positive = dat_only[dat_only > 0]
        if positive.size == 0:
            print("  WARN: DAT inv-freq requested but no positive DAT counts; skipping.")
        else:
            median_freq = float(np.median(positive))
            mults = np.zeros(vocab_size, dtype=np.float32)
            mults[:] = 1.0
            for idx in dat_indices:
                f = max(float(dat_freq_arr[idx]), 1.0)  # never sqrt(inf); zero-occ → max boost
                m = math.sqrt(median_freq / f)
                m = max(dat_clamp_min, min(dat_clamp_max, m))
                mults[idx] = m
            weight = weight * torch.from_numpy(mults)
            applied = mults[dat_indices]
            n_max = int((np.isclose(applied, dat_clamp_max)).sum())
            n_min = int((np.isclose(applied, dat_clamp_min)).sum())
            print(f"  class_space_weight: dat_inv_freq applied to {len(dat_indices)} DAT tokens "
                  f"(median_freq={median_freq:.0f}, clamp=[{dat_clamp_min}, {dat_clamp_max}], "
                  f"clamped_max={n_max}, clamped_min={n_min}, "
                  f"mean={float(applied.mean()):.2f})")

    print(f"  class_space_weight: final stats min={float(weight.min()):.3f} "
          f"mean={float(weight.mean()):.3f} max={float(weight.max()):.3f}")
    return weight


def compute_label_frequencies(sequences: np.ndarray, seq_lengths: np.ndarray,
                              indices: np.ndarray, vocab_size: int) -> np.ndarray:
    """Per-vocab-idx label count over the supplied sample indices.

    Used to seed the DAT inverse-frequency weight and the retail marginal
    (the anti-collapse KL target). Computed from the training split only.
    """
    counts = np.zeros(vocab_size, dtype=np.float64)
    for i in indices:
        n = int(seq_lengths[i])
        if n == 0:
            continue
        wcids = sequences[i, :n, 0].astype(np.int64)
        wcids = wcids[(wcids >= 0) & (wcids < vocab_size)]
        if wcids.size:
            np.add.at(counts, wcids, 1.0)
    return counts


def build_retail_marginal(label_counts: np.ndarray, eps: float = 1e-12) -> torch.Tensor:
    """Normalise a label-count array into a probability distribution."""
    counts = np.asarray(label_counts, dtype=np.float64)
    total = counts.sum()
    if total <= 0:
        return torch.full((counts.shape[0],), 1.0 / counts.shape[0], dtype=torch.float32)
    probs = counts / total
    probs = np.maximum(probs, eps)  # smooth to keep KL finite
    probs = probs / probs.sum()
    return torch.from_numpy(probs.astype(np.float32))


def build_ace_abstract_mask(vocab_size: int, vocab_path: str) -> torch.Tensor:
    """Boolean (V,) mask: True for token indices that map to ace_abstract.

    Used by validation diagnostics to surface vocab-space collapse — when
    the argmax over the validation set is overwhelmingly model_id even
    though the corpus is majority-ace_abstract, training has gone wrong
    (the v2/v3 failure mode) and no eyeballing of the loss curve catches
    it.
    """
    mask = torch.zeros(vocab_size, dtype=torch.bool)
    try:
        with open(vocab_path, "r", encoding="utf-8") as f:
            vocab = json.load(f)
    except (OSError, json.JSONDecodeError):
        return mask
    for raw_idx, kv in (vocab.get("idx_to_class_key") or {}).items():
        if isinstance(kv, (list, tuple)) and len(kv) == 2 and kv[0] == "ace_abstract":
            try:
                idx = int(raw_idx)
            except (TypeError, ValueError):
                continue
            if 0 <= idx < vocab_size:
                mask[idx] = True
    return mask


def build_family_projection(token_family_index: torch.Tensor, vocab_size: int) -> torch.Tensor:
    family_projection = torch.zeros(vocab_size, FAMILY_COUNT, dtype=torch.float32)
    family_projection[torch.arange(vocab_size), token_family_index] = 1.0
    return family_projection


# ─── Dataset ─────────────────────────────────────────────────────────────────

class PlacementDataset(Dataset):
    """
    Dataset of landblock placements.
    
    Each sample: (context_N, input_sequence, target_sequence, seq_len)
    
    The input sequence is the object tokens shifted right by one (teacher forcing).
    The target sequence is the next-token targets.
    """
    
    def __init__(self, contexts: np.ndarray, sequences: np.ndarray,
                 seq_lengths: np.ndarray, config: dict,
                 indices: Optional[np.ndarray] = None,
                 augment: bool = True,
                 atlas_ids: Optional[np.ndarray] = None,
                 atlas_scalars: Optional[np.ndarray] = None,
                 atlas_poi: Optional[np.ndarray] = None,
                 atlas_mats: Optional[np.ndarray] = None):
        self.contexts = torch.from_numpy(contexts).float()
        self.sequences = torch.from_numpy(sequences).float()
        self.seq_lengths = torch.from_numpy(seq_lengths).long()
        if indices is None:
            self.indices = torch.arange(len(self.contexts), dtype=torch.long)
        else:
            self.indices = torch.from_numpy(np.asarray(indices, dtype=np.int64)).long()
        self.config = config
        self.augment = augment
        self.max_len = sequences.shape[1]
        self.schema = config.get('dataset_schema', 'legacy')
        self.coord_slice = tuple(config.get('coord_slice', (1, 3)))
        self.rot_slice = tuple(config.get('rot_slice', (4, 6)))
        self.link_idx = int(config.get('link_idx', 7))
        self.has_atlas = atlas_ids is not None
        if self.has_atlas:
            self.atlas_ids = torch.from_numpy(atlas_ids).long()
            self.atlas_scalars = torch.from_numpy(atlas_scalars).float()
            self.atlas_poi = torch.from_numpy(atlas_poi).float()
            self.atlas_mats = torch.from_numpy(atlas_mats).float()
            self.atlas_dropout = float(config.get('atlas_context_dropout', 0.0))
        else:
            self.atlas_ids = None
            self.atlas_scalars = None
            self.atlas_poi = None
            self.atlas_mats = None
            self.atlas_dropout = 0.0

    def __len__(self):
        return len(self.indices)
    
    def __getitem__(self, idx):
        src_idx = self.indices[idx].item()
        ctx = self.contexts[src_idx].clone()
        seq = self.sequences[src_idx].clone()
        seq_len = self.seq_lengths[src_idx].item()
        
        if self.augment:
            jitter_std = self.config['context_jitter_std']
            if self.schema == 'legacy' and ctx.numel() >= 81:
                ctx[:81] += torch.randn(81) * jitter_std
            else:
                ctx += torch.randn_like(ctx) * jitter_std

            coord_std = self.config['coord_noise_std']
            coord_x, coord_y = self.coord_slice[0], self.coord_slice[0] + 1
            seq[:seq_len, coord_x] += torch.randn(seq_len) * coord_std
            seq[:seq_len, coord_y] += torch.randn(seq_len) * coord_std
            seq[:seq_len, coord_x].clamp_(0, 1)
            seq[:seq_len, coord_y].clamp_(0, 1)

            if self.config['rotation_augment'] and random.random() < 0.5:
                seq[:seq_len, coord_x], seq[:seq_len, coord_y] = (
                    seq[:seq_len, coord_y].clone(), seq[:seq_len, coord_x].clone()
                )
                if self.schema == 'legacy' and ctx.numel() >= 81:
                    h = ctx[:81].reshape(9, 9)
                    ctx[:81] = h.T.reshape(-1)
                else:
                    sin_idx, cos_idx = self.rot_slice
                    sin_vals = seq[:seq_len, sin_idx].clone()
                    cos_vals = seq[:seq_len, cos_idx].clone()
                    seq[:seq_len, sin_idx] = cos_vals
                    seq[:seq_len, cos_idx] = -sin_vals
        
        # Teacher forcing: shift the sequence right so the model predicts the
        # next token instead of learning an identity copy of the current token.
        input_seq = torch.zeros_like(seq)
        if seq_len > 1:
            input_seq[1:seq_len] = seq[:seq_len - 1]
        target_wcid = seq[:, 0].long()  # Target wcid indices
        target_pos = seq[:, self.coord_slice[0]:self.coord_slice[1]]
        target_rot = seq[:, self.rot_slice[0]:self.rot_slice[1]]
        target_link = seq[:, self.link_idx]
        
        # Sequence mask (1 for real tokens, 0 for padding)
        mask = torch.zeros(self.max_len, dtype=torch.bool)
        mask[:seq_len] = True

        if self.has_atlas:
            atlas_ids = self.atlas_ids[src_idx].clone()
            atlas_scalars = self.atlas_scalars[src_idx].clone()
            atlas_poi = self.atlas_poi[src_idx].clone()
            atlas_mats = self.atlas_mats[src_idx].clone()
            if self.augment and self.atlas_dropout > 0.0:
                # Per-field Bernoulli drop: ids fall back to UNK (0); scalar/
                # multi-hot blocks zero in place. Forces the model to spread
                # conditioning across multiple semantic fields rather than
                # collapsing onto regionName alone.
                p = self.atlas_dropout
                if atlas_ids.numel() > 0:
                    drop_ids = torch.rand(atlas_ids.shape) < p
                    atlas_ids = torch.where(drop_ids, torch.zeros_like(atlas_ids), atlas_ids)
                if atlas_scalars.numel() > 0:
                    drop_sc = torch.rand(atlas_scalars.shape) < p
                    atlas_scalars = torch.where(drop_sc, torch.zeros_like(atlas_scalars), atlas_scalars)
                if torch.rand(()).item() < p:
                    atlas_poi = torch.zeros_like(atlas_poi)
                if torch.rand(()).item() < p:
                    atlas_mats = torch.zeros_like(atlas_mats)
        else:
            atlas_ids = torch.zeros(0, dtype=torch.long)
            atlas_scalars = torch.zeros(0, dtype=torch.float32)
            atlas_poi = torch.zeros(0, dtype=torch.float32)
            atlas_mats = torch.zeros(0, dtype=torch.float32)

        return (ctx, input_seq, target_wcid, target_pos, target_rot, target_link,
                mask, seq_len, atlas_ids, atlas_scalars, atlas_poi, atlas_mats)


# ─── Model ───────────────────────────────────────────────────────────────────

class ContextProjection(nn.Module):
    """Projects the context vector into d_model space."""

    def __init__(self, context_dim: int, d_model: int):
        super().__init__()
        self.proj = nn.Sequential(
            nn.Linear(context_dim, d_model),
            nn.LayerNorm(d_model),
            nn.GELU(),
            nn.Linear(d_model, d_model),
            nn.LayerNorm(d_model),
        )

    def forward(self, ctx):
        return self.proj(ctx)  # (B, d_model)


class AtlasContextEncoder(nn.Module):
    """V6 atlas-derived semantic context.

    Consumes the four arrays produced by build_atlas_context.py:
      ids:     (B, n_cat) long  — categorical id-table lookups
      scalars: (B, n_scl) float — bool/log1p/confidence scalars
      poi:     (B, P)     float — multi-hot poi categories
      mats:    (B, M)     float — multi-hot material tags

    Embeds the categorical ids, concatenates with the float blocks, and
    projects through an MLP to ``output_dim`` (typically d_model // 2).
    """

    def __init__(self, atlas_meta: dict, output_dim: int):
        super().__init__()
        self.field_order = list(atlas_meta["categorical_field_order"])
        self.embeddings = nn.ModuleList([
            nn.Embedding(int(atlas_meta["vocab_caps"][k]),
                         int(atlas_meta["embedding_dims"][k]))
            for k in self.field_order
        ])
        embed_total = sum(int(atlas_meta["embedding_dims"][k]) for k in self.field_order)
        scalar_total = len(atlas_meta["scalar_field_order"])
        poi_total = int(atlas_meta["poi_categories_cap"])
        mat_total = int(atlas_meta["material_tags_cap"])
        in_dim = embed_total + scalar_total + poi_total + mat_total
        self.proj = nn.Sequential(
            nn.Linear(in_dim, output_dim),
            nn.LayerNorm(output_dim),
            nn.GELU(),
            nn.Linear(output_dim, output_dim),
            nn.LayerNorm(output_dim),
        )

    def forward(self, ids, scalars, poi, mats):
        embeds = [emb(ids[:, j].long().clamp(min=0))
                  for j, emb in enumerate(self.embeddings)]
        flat = torch.cat([*embeds, scalars, poi, mats], dim=-1)
        return self.proj(flat)


class ObjectTokenEmbedding(nn.Module):
    """Embeds a 10-dim object token into d_model space."""
    
    def __init__(self, obj_dim: int, d_model: int, vocab_size: int):
        super().__init__()
        self.wcid_embed = nn.Embedding(vocab_size, d_model // 2)
        self.continuous_proj = nn.Linear(obj_dim - 1, d_model // 2)
        self.combine = nn.Linear(d_model, d_model)
        self.norm = nn.LayerNorm(d_model)
    
    def forward(self, obj_tokens):
        # obj_tokens: (B, T, 10)
        wcid_idx = obj_tokens[:, :, 0].long().clamp(0)
        continuous = obj_tokens[:, :, 1:]  # (B, T, 9)
        
        wcid_emb = self.wcid_embed(wcid_idx)     # (B, T, d_model//2)
        cont_emb = self.continuous_proj(continuous)  # (B, T, d_model//2)
        combined = torch.cat([wcid_emb, cont_emb], dim=-1)  # (B, T, d_model)
        
        return self.norm(self.combine(combined))


class PositionalEncoding(nn.Module):
    """Sinusoidal positional encoding."""
    
    def __init__(self, d_model: int, max_len: int = 256):
        super().__init__()
        pe = torch.zeros(max_len, d_model)
        position = torch.arange(0, max_len, dtype=torch.float).unsqueeze(1)
        div_term = torch.exp(
            torch.arange(0, d_model, 2).float() * (-math.log(10000.0) / d_model)
        )
        pe[:, 0::2] = torch.sin(position * div_term)
        pe[:, 1::2] = torch.cos(position * div_term)
        self.register_buffer('pe', pe.unsqueeze(0))  # (1, max_len, d_model)
    
    def forward(self, x):
        return x + self.pe[:, :x.size(1)]


class ScenePlacerTransformer(nn.Module):
    """
    GPT-style autoregressive transformer for scene object placement.
    
    Generates a sequence of objects conditioned on landblock context:
      [CTX] → [OBJ_1] → [OBJ_2] → ... → [STOP]
    
    Each output predicts:
      - wcid (vocabulary classification)
      - position (x, y continuous)
      - rotation (w, z continuous)
      - is_link_child (binary)
    """
    
    def __init__(self, config: dict):
        super().__init__()
        self.config = config
        
        d_model = config['d_model']
        n_heads = config['n_heads']
        n_layers = config['n_layers']
        d_ff = config['d_ff']
        max_seq = config['max_seq_len'] + 1  # +1 for context token
        
        # Load vocab size
        vocab_path = config.get('vocab_path', VOCAB_PATH)
        if os.path.exists(vocab_path):
            with open(vocab_path) as f:
                vocab = json.load(f)
            self.vocab_size = vocab['vocab_size']
        else:
            self.vocab_size = 13000  # Fallback estimate
        
        # Input embeddings
        atlas_meta = config.get('atlas_meta')
        if atlas_meta is not None:
            half = d_model // 2
            self.ctx_proj = ContextProjection(config['context_dim'], half)
            self.atlas_proj = AtlasContextEncoder(atlas_meta, half)
            self.ctx_combine = nn.Sequential(
                nn.Linear(d_model, d_model),
                nn.LayerNorm(d_model),
                nn.GELU(),
                nn.Linear(d_model, d_model),
                nn.LayerNorm(d_model),
            )
        else:
            self.ctx_proj = ContextProjection(config['context_dim'], d_model)
            self.atlas_proj = None
            self.ctx_combine = None
        self.obj_embed = ObjectTokenEmbedding(config['obj_dim'], d_model, self.vocab_size)
        self.pos_encoding = PositionalEncoding(d_model, max_seq)
        
        # Transformer decoder layers
        decoder_layer = nn.TransformerDecoderLayer(
            d_model=d_model,
            nhead=n_heads,
            dim_feedforward=d_ff,
            dropout=config['dropout_ff'],
            batch_first=True,
            norm_first=True,  # Pre-norm (better training stability)
        )
        self.transformer = nn.TransformerDecoder(decoder_layer, n_layers)
        
        # Causal mask
        self.register_buffer(
            'causal_mask',
            torch.triu(torch.ones(max_seq, max_seq), diagonal=1).bool()
        )
        
        # Output heads
        self.wcid_head = nn.Linear(d_model, self.vocab_size)     # Classification
        self.pos_head = nn.Linear(d_model, 2)                     # x, y continuous
        self.rot_head = nn.Linear(d_model, 2)                     # w, z continuous
        self.link_head = nn.Linear(d_model, 1)                    # Binary link flag
        
        # Apply attention dropout separately
        # (handled by TransformerDecoderLayer's internal dropout)
        
        self._init_weights()
    
    def _init_weights(self):
        """Xavier initialization for better training start."""
        for p in self.parameters():
            if p.dim() > 1:
                nn.init.xavier_uniform_(p)
    
    def forward(self, context, obj_sequence, mask=None,
                atlas_ids=None, atlas_scalars=None, atlas_poi=None, atlas_mats=None,
                atlas_zero_mask: bool = False):
        """
        Forward pass.

        Args:
            context: (B, context_dim) landblock context
            obj_sequence: (B, T, 10) object tokens
            mask: (B, T) boolean mask (True = valid token)
            atlas_ids/scalars/poi/mats: V6 atlas conditioning. Required when
                config['atlas_meta'] is set; ignored otherwise.
            atlas_zero_mask: if True, the atlas branch's contribution is zeroed
                before the concat-projection. Used during the warmup-epoch
                ramp-in so the resumed transformer body sees the V5
                conditioning distribution while the new context Linear is
                still initializing.

        Returns:
            wcid_logits: (B, T, vocab_size)
            pos_pred: (B, T, 2)
            rot_pred: (B, T, 2)
            link_pred: (B, T, 1)
        """
        B, T, _ = obj_sequence.shape

        # Project context to d_model and prepend as first token.
        if self.atlas_proj is not None:
            ctx_half = self.ctx_proj(context)
            atlas_half = self.atlas_proj(atlas_ids, atlas_scalars, atlas_poi, atlas_mats)
            if atlas_zero_mask:
                atlas_half = atlas_half * 0.0
            ctx_full = torch.cat([ctx_half, atlas_half], dim=-1)  # (B, d_model)
            ctx_token = self.ctx_combine(ctx_full).unsqueeze(1)
        else:
            ctx_token = self.ctx_proj(context).unsqueeze(1)  # (B, 1, d_model)
        
        # Embed object tokens
        obj_tokens = self.obj_embed(obj_sequence)  # (B, T, d_model)
        
        # Concatenate: [CTX, OBJ_1, ..., OBJ_T]
        full_seq = torch.cat([ctx_token, obj_tokens], dim=1)  # (B, T+1, d_model)
        
        # Add positional encoding
        full_seq = self.pos_encoding(full_seq)
        
        # Build causal mask (T+1 × T+1)
        seq_len = T + 1
        causal = self.causal_mask[:seq_len, :seq_len]
        
        # Build padding mask if provided
        if mask is not None:
            # Prepend True for context token
            ctx_mask = torch.ones(B, 1, device=mask.device, dtype=torch.bool)
            full_mask = torch.cat([ctx_mask, mask], dim=1)  # (B, T+1)
            # Convert to key padding mask format (True = ignore)
            key_padding_mask = ~full_mask
        else:
            key_padding_mask = None
        
        # Self-attention (decoder-only, no memory/encoder)
        # Use the same sequence as both memory and target for self-attention
        hidden = self.transformer(
            full_seq, full_seq,
            tgt_mask=causal,
            tgt_key_padding_mask=key_padding_mask,
            memory_key_padding_mask=key_padding_mask,
        )
        
        # Take only the object positions (skip context token)
        hidden = hidden[:, 1:, :]  # (B, T, d_model)
        
        # Output heads
        wcid_logits = self.wcid_head(hidden)   # (B, T, vocab_size)
        pos_pred = self.pos_head(hidden)       # (B, T, 2)
        rot_pred = self.rot_head(hidden)       # (B, T, 2)
        link_pred = self.link_head(hidden)     # (B, T, 1)
        
        return wcid_logits, pos_pred, rot_pred, link_pred
    
    def count_parameters(self):
        return sum(p.numel() for p in self.parameters() if p.requires_grad)


# ─── EMA (Exponential Moving Average) ────────────────────────────────────────

class EMA:
    """Exponential Moving Average of model parameters."""
    
    def __init__(self, model: nn.Module, decay: float = 0.999):
        self.model = model
        self.decay = decay
        self.shadow = {}
        self.backup = {}
        
        for name, param in model.named_parameters():
            if param.requires_grad:
                self.shadow[name] = param.data.clone()
    
    def update(self):
        for name, param in self.model.named_parameters():
            if param.requires_grad:
                self.shadow[name].mul_(self.decay).add_(
                    param.data, alpha=1.0 - self.decay
                )
    
    def apply_shadow(self):
        """Replace model params with EMA params (for evaluation)."""
        for name, param in self.model.named_parameters():
            if param.requires_grad:
                self.backup[name] = param.data.clone()
                param.data.copy_(self.shadow[name])
    
    def restore(self):
        """Restore original params after evaluation."""
        for name, param in self.model.named_parameters():
            if param.requires_grad:
                param.data.copy_(self.backup[name])
        self.backup = {}
    
    def state_dict(self):
        return {k: v.clone() for k, v in self.shadow.items()}
    
    def load_state_dict(self, state_dict):
        self.shadow = {k: v.clone() for k, v in state_dict.items()}


# ─── Training Loop ───────────────────────────────────────────────────────────

def compute_loss(model, batch, config, device):
    """Compute composite loss."""
    (ctx, input_seq, target_wcid, target_pos, target_rot, target_link,
     mask, seq_len, atlas_ids, atlas_scalars, atlas_poi, atlas_mats) = batch

    ctx = ctx.to(device)
    input_seq = input_seq.to(device)
    target_wcid = target_wcid.to(device)
    target_pos = target_pos.to(device)
    target_rot = target_rot.to(device)
    target_link = target_link.to(device)
    mask = mask.to(device)
    has_atlas = config.get('atlas_meta') is not None
    if has_atlas:
        atlas_ids = atlas_ids.to(device)
        atlas_scalars = atlas_scalars.to(device)
        atlas_poi = atlas_poi.to(device)
        atlas_mats = atlas_mats.to(device)
    else:
        atlas_ids = atlas_scalars = atlas_poi = atlas_mats = None
    token_family_index = config.get('token_family_index')
    family_projection = config.get('family_projection')

    # Forward
    wcid_logits, pos_pred, rot_pred, link_pred = model(
        ctx, input_seq, mask,
        atlas_ids=atlas_ids, atlas_scalars=atlas_scalars,
        atlas_poi=atlas_poi, atlas_mats=atlas_mats,
        atlas_zero_mask=bool(config.get('_atlas_zero_mask_active', False)),
    )
    
    # Flatten for loss computation
    B, T, V = wcid_logits.shape
    active = mask.float()  # (B, T)
    
    # wcid cross-entropy with label smoothing.
    # When focal_gamma > 0, scale the per-token CE by (1 - p_t)^gamma so
    # already-confident predictions contribute less gradient. p_t is read
    # off the raw (non-smoothed) softmax of the target class — keeping the
    # smoothing in the CE term itself but using the sharp probability for
    # the down-weighting factor.
    wcid_ce = F.cross_entropy(
        wcid_logits.reshape(-1, V),
        target_wcid.reshape(-1),
        label_smoothing=config['label_smoothing'],
        reduction='none'
    ).reshape(B, T)
    focal_gamma = config.get('focal_gamma', 0.0)
    if focal_gamma > 0:
        with torch.no_grad():
            sharp_logp = F.log_softmax(wcid_logits.reshape(-1, V), dim=-1)
            p_t = sharp_logp.gather(
                -1, target_wcid.reshape(-1, 1)
            ).exp().reshape(B, T)
            focal_weight = (1.0 - p_t).clamp_(min=0.0).pow(focal_gamma)
        wcid_ce = wcid_ce * focal_weight
    class_space_weight = config.get('class_space_weight')
    if class_space_weight is not None:
        per_target_weight = class_space_weight.index_select(
            0, target_wcid.reshape(-1).clamp(0, class_space_weight.shape[0] - 1)
        ).reshape(B, T)
        wcid_ce = wcid_ce * per_target_weight
    L_wcid = (wcid_ce * active).sum() / active.sum()
    
    # Position MSE (normalized, only for real tokens)
    pos_err = ((pos_pred - target_pos) ** 2).sum(dim=-1)  # (B, T)
    L_pos = (pos_err * active).sum() / active.sum()
    
    # Rotation MSE
    rot_err = ((rot_pred - target_rot) ** 2).sum(dim=-1)  # (B, T)
    L_rot = (rot_err * active).sum() / active.sum()
    
    # Link flag BCE
    link_err = F.binary_cross_entropy_with_logits(
        link_pred.squeeze(-1), target_link, reduction='none'
    )
    L_link = (link_err * active).sum() / active.sum()
    
    # Entropy regularization: penalize peaked distributions to prevent mode collapse
    # Higher entropy = more diverse predictions = better generalization
    wcid_probs = F.softmax(wcid_logits, dim=-1)  # (B, T, V)
    token_entropy = -(wcid_probs * torch.log(wcid_probs + 1e-10)).sum(dim=-1)  # (B, T)
    avg_entropy = (token_entropy * active).sum() / active.sum()
    # We MAXIMIZE entropy (minimize negative entropy), scaled by lambda
    L_entropy = -avg_entropy  # Negative because we want to maximize entropy

    L_dense_repeat = torch.zeros((), device=device)
    if (
        token_family_index is not None and
        family_projection is not None and
        ctx.shape[1] >= BASE_CONTEXT_DIM + len(SETTLEMENT_ROLE_LABELS) and
        DENSE_ROLE_INDICES
    ):
        role_slice = ctx[:, BASE_CONTEXT_DIM:BASE_CONTEXT_DIM + len(SETTLEMENT_ROLE_LABELS)]
        dense_role_strength = role_slice[:, list(DENSE_ROLE_INDICES)].sum(dim=-1)
        dense_role_mask = dense_role_strength > 0.5
        if dense_role_mask.any():
            input_token_ids = input_seq[:, :, 0].long().clamp(0, V - 1)
            input_family = token_family_index[input_token_ids]
            target_family = token_family_index[target_wcid.clamp(0, V - 1)]

            family_seen = F.one_hot(input_family, num_classes=FAMILY_COUNT).cumsum(dim=1) > 0
            family_probs = torch.matmul(F.softmax(wcid_logits, dim=-1), family_projection)
            repeat_probs = (family_probs * family_seen.float()).sum(dim=-1).clamp(1e-6, 1.0 - 1e-6)

            target_repeat = family_seen.gather(-1, target_family.unsqueeze(-1)).squeeze(-1).float()
            token_positions = torch.arange(T, device=device).unsqueeze(0)
            dense_active = (
                active.bool() &
                dense_role_mask.unsqueeze(1) &
                (target_family != FAMILY_OTHER) &
                (token_positions >= 4)
            )
            if dense_active.any():
                repeat_logits = torch.logit(repeat_probs[dense_active], eps=1e-6)
                repeat_loss = F.binary_cross_entropy_with_logits(
                    repeat_logits,
                    target_repeat[dense_active],
                    reduction='mean'
                )
                L_dense_repeat = repeat_loss

    lambda_ent = config.get('lambda_entropy', 0.1)
    lambda_dense_repeat = config.get('lambda_dense_repeat', 0.0)
    lambda_marginal_kl = config.get('lambda_marginal_kl', 0.0)

    # V5 anti-collapse term: KL(P_retail || batch_marginal). The Phase 0
    # diagnostic showed v4 under-emits ~2700 supported DAT tokens; pushing
    # the per-batch model marginal toward retail directly attacks that.
    # Computed only when lambda > 0 to avoid the extra softmax.full path
    # for legacy runs.
    L_marginal_kl = torch.zeros((), device=device)
    if lambda_marginal_kl > 0.0 and config.get('retail_marginal') is not None:
        retail_marginal = config['retail_marginal']  # (V,) on device
        if 'wcid_probs' in locals():
            probs_for_marginal = wcid_probs
        else:
            probs_for_marginal = F.softmax(wcid_logits, dim=-1)
        # Mask-weighted mean over (B, T)
        active_3d = active.unsqueeze(-1)  # (B, T, 1)
        masked_probs = probs_for_marginal * active_3d  # (B, T, V)
        denom = active.sum().clamp(min=1.0)
        batch_marginal = masked_probs.sum(dim=(0, 1)) / denom  # (V,)
        batch_marginal = batch_marginal.clamp(min=1e-12)
        # KL(retail || batch). retail is already smoothed > 0.
        L_marginal_kl = (retail_marginal *
                         (torch.log(retail_marginal) - torch.log(batch_marginal))).sum()

    # Composite loss
    L_total = (L_wcid
               + config['lambda_pos'] * L_pos
               + config['lambda_rot'] * L_rot
               + config['lambda_link'] * L_link
               + lambda_ent * L_entropy
               + lambda_dense_repeat * L_dense_repeat
               + lambda_marginal_kl * L_marginal_kl)

    return L_total, {
        'total': L_total.item(),
        'wcid': L_wcid.item(),
        'pos': L_pos.item(),
        'rot': L_rot.item(),
        'link': L_link.item(),
        'entropy': avg_entropy.item(),
        'dense_repeat': L_dense_repeat.item(),
        'marginal_kl': L_marginal_kl.item(),
    }


def build_component_feature_matrix(data: np.lib.npyio.NpzFile, vocab_size: int) -> np.ndarray:
    component_index_by_object = data['component_index_by_object'].astype(np.int32, copy=False)
    component_count = data['component_ids'].shape[0]
    feature_dim = 12
    component_features = np.zeros((component_count + 1, feature_dim), dtype=np.float32)

    component_features[1:, 0] = 1.0
    component_features[1:, 1] = data['component_kind'].astype(np.float32) / max(max(int(data['component_kind'].max()), 1), 1)
    component_features[1:, 2] = data['component_lb_coords'][:, 0].astype(np.float32) / 254.0
    component_features[1:, 3] = data['component_lb_coords'][:, 1].astype(np.float32) / 254.0
    component_features[1:, 4] = np.clip(data['component_cell_count'].astype(np.float32) / 64.0, 0.0, 1.0)
    component_features[1:, 5] = np.clip(data['component_static_count'].astype(np.float32) / 512.0, 0.0, 4.0)
    component_features[1:, 6] = np.clip(data['component_entry_count'].astype(np.float32) / 16.0, 0.0, 1.0)
    anchor_idx = data['component_anchor_class_idx'].astype(np.float32)
    anchor_idx = np.where(anchor_idx >= 0, anchor_idx / max(vocab_size - 1, 1), 0.0)
    component_features[1:, 7] = anchor_idx
    component_features[1:, 8:11] = data['component_anchor_pos'].astype(np.float32)
    component_features[1:, 8] /= 192.0
    component_features[1:, 9] /= 192.0
    component_features[1:, 10] /= 512.0
    component_features[1:, 11] = np.clip(data['component_portal_ref_count'].astype(np.float32) / 32.0, 0.0, 4.0)

    gather_index = np.where(component_index_by_object >= 0, component_index_by_object + 1, 0)
    return component_features[gather_index]


def compute_diversity_metrics(model, val_loader, config, device):
    """Compute diversity + calibration metrics on the val split.

    Beyond the legacy `wcid_entropy` / `unique_wcids` / `ace_emit_frac`,
    V5 adds the metrics the Phase 0 diagnostic identified as load-bearing:
      - top-5 / top-10 wcid acc (overall + per class space)
      - KL(retail || model) over greedy preds — the headline calibration metric
      - long-tail recall: frac of retail-supported tokens emitted at least once
      - ace_emit_frac_ex_specials (the apples-to-apples version of ace_emit_frac)
    """
    model.eval()

    vocab_size = model.vocab_size if hasattr(model, "vocab_size") else None
    if vocab_size is None:
        wcid_head = getattr(model, "wcid_head", None)
        vocab_size = wcid_head.out_features if wcid_head is not None else 0

    ace_mask = config.get('ace_abstract_token_mask')  # (V,) bool tensor on device
    if ace_mask is not None and ace_mask.device != device:
        ace_mask = ace_mask.to(device)
    ace_mask_np = ace_mask.detach().cpu().numpy().astype(bool) if ace_mask is not None else None
    dat_mask_np = (~ace_mask_np) if ace_mask_np is not None else None
    # Specials are PAD/STOP — strip them out of dat_mask.
    if dat_mask_np is not None and vocab_size:
        dat_mask_np = dat_mask_np.copy()
        for sp in (PAD_TOKEN, STOP_TOKEN):
            if 0 <= sp < vocab_size:
                dat_mask_np[sp] = False

    retail_marginal_t = config.get('retail_marginal')
    retail_marginal_np = retail_marginal_t.detach().cpu().numpy() if retail_marginal_t is not None else None

    pred_count = np.zeros(vocab_size, dtype=np.int64) if vocab_size else None

    all_pos_preds = []

    top1 = top5 = top10 = total_pos = 0
    cls_total = {"ace": 0, "dat": 0, "special": 0}
    cls_top1 = {"ace": 0, "dat": 0, "special": 0}
    cls_top5 = {"ace": 0, "dat": 0, "special": 0}

    ace_label_pos = 0
    ace_pred_pos = 0
    dat_pred_pos = 0
    special_pred_pos = 0

    with torch.no_grad():
        for batch_idx, batch in enumerate(val_loader):
            max_val_batches = config.get('max_val_batches')
            if max_val_batches is not None and batch_idx >= max_val_batches:
                break
            (ctx, input_seq, target_wcid, target_pos, target_rot, target_link,
             mask, seq_len, atlas_ids, atlas_scalars, atlas_poi, atlas_mats) = batch
            ctx = ctx.to(device)
            input_seq = input_seq.to(device)
            mask_d = mask.to(device)
            target_wcid_d = target_wcid.to(device)
            if config.get('atlas_meta') is not None:
                atlas_ids = atlas_ids.to(device)
                atlas_scalars = atlas_scalars.to(device)
                atlas_poi = atlas_poi.to(device)
                atlas_mats = atlas_mats.to(device)
            else:
                atlas_ids = atlas_scalars = atlas_poi = atlas_mats = None

            wcid_logits, pos_pred, _, _ = model(
                ctx, input_seq, mask_d,
                atlas_ids=atlas_ids, atlas_scalars=atlas_scalars,
                atlas_poi=atlas_poi, atlas_mats=atlas_mats,
                # Diversity metrics always use the trained conditioning, not
                # the warmup zero-mask, so they reflect what the deployed model
                # actually sees.
                atlas_zero_mask=False,
            )
            B, T, V = wcid_logits.shape
            topk = torch.topk(wcid_logits, k=min(10, V), dim=-1).indices  # (B, T, K)
            wcid_pred = topk[:, :, 0]
            active = mask_d
            total_active = int(active.sum().item())

            hit1 = (wcid_pred == target_wcid_d) & active
            hit5 = (topk[:, :, :5] == target_wcid_d.unsqueeze(-1)).any(-1) & active
            hit10 = (topk == target_wcid_d.unsqueeze(-1)).any(-1) & active

            top1 += int(hit1.sum().item())
            top5 += int(hit5.sum().item())
            top10 += int(hit10.sum().item())
            total_pos += total_active

            if ace_mask is not None:
                pred_clamped = wcid_pred.clamp(0, V - 1)
                target_clamped = target_wcid_d.clamp(0, V - 1)
                pred_is_ace = ace_mask[pred_clamped] & active
                label_is_ace = ace_mask[target_clamped] & active
                # specials: token id == PAD or STOP
                pred_is_special = ((wcid_pred == PAD_TOKEN) | (wcid_pred == STOP_TOKEN)) & active
                label_is_special = ((target_wcid_d == PAD_TOKEN) | (target_wcid_d == STOP_TOKEN)) & active
                pred_is_dat = active & ~pred_is_ace & ~pred_is_special
                label_is_dat = active & ~label_is_ace & ~label_is_special

                ace_pred_pos += int(pred_is_ace.sum().item())
                dat_pred_pos += int(pred_is_dat.sum().item())
                special_pred_pos += int(pred_is_special.sum().item())
                ace_label_pos += int(label_is_ace.sum().item())

                cls_total["ace"] += int(label_is_ace.sum().item())
                cls_total["dat"] += int(label_is_dat.sum().item())
                cls_total["special"] += int(label_is_special.sum().item())
                cls_top1["ace"] += int((hit1 & label_is_ace).sum().item())
                cls_top1["dat"] += int((hit1 & label_is_dat).sum().item())
                cls_top1["special"] += int((hit1 & label_is_special).sum().item())
                cls_top5["ace"] += int((hit5 & label_is_ace).sum().item())
                cls_top5["dat"] += int((hit5 & label_is_dat).sum().item())
                cls_top5["special"] += int((hit5 & label_is_special).sum().item())

            # Streamed counts to support KL + long-tail recall, plus pos_std sample.
            if pred_count is not None:
                preds_active = wcid_pred[active].cpu().numpy()
                if preds_active.size:
                    np.add.at(pred_count, preds_active, 1)
            for b in range(wcid_pred.size(0)):
                sl = int(mask_d[b].sum().item())
                if sl == 0:
                    continue
                positions = pos_pred[b, :sl].cpu().numpy()
                all_pos_preds.extend(positions.tolist())

    if pred_count is None or pred_count.sum() == 0:
        return {'wcid_entropy': 0.0, 'unique_wcids': 0, 'unique_ratio': 0.0,
                'pos_std': 0.0, 'ace_emit_frac': 0.0}

    total_preds = int(pred_count.sum())
    nonzero = pred_count > 0
    probs = pred_count[nonzero].astype(np.float64) / total_preds
    wcid_entropy = float(-(probs * np.log2(probs + 1e-10)).sum())  # bits, legacy
    unique_wcids = int(nonzero.sum())
    unique_ratio = unique_wcids / max(total_preds, 1)

    pos_arr = np.array(all_pos_preds) if all_pos_preds else np.zeros(0)
    pos_std = float(pos_arr.std()) if pos_arr.size else 0.0

    ace_emit_frac = ace_pred_pos / max(total_pos, 1)
    nonspecial = total_pos - special_pred_pos
    ace_emit_frac_ex_specials = ace_pred_pos / max(nonspecial, 1)
    dat_emit_frac = dat_pred_pos / max(total_pos, 1)
    label_ace_frac = ace_label_pos / max(total_pos, 1)

    metrics = {
        'wcid_entropy': wcid_entropy,
        'unique_wcids': unique_wcids,
        'unique_ratio': unique_ratio,
        'pos_std': pos_std,
        'ace_emit_frac': ace_emit_frac,
        'ace_emit_frac_ex_specials': ace_emit_frac_ex_specials,
        'dat_emit_frac': dat_emit_frac,
        'label_ace_frac': label_ace_frac,
        'top1_wcid_acc': top1 / max(total_pos, 1),
        'top5_wcid_acc': top5 / max(total_pos, 1),
        'top10_wcid_acc': top10 / max(total_pos, 1),
    }
    for cls in ("ace", "dat", "special"):
        n = max(cls_total[cls], 1)
        metrics[f'top1_wcid_acc_{cls}'] = cls_top1[cls] / n
        metrics[f'top5_wcid_acc_{cls}'] = cls_top5[cls] / n

    if retail_marginal_np is not None and retail_marginal_np.shape[0] == vocab_size:
        q_pred = pred_count.astype(np.float64) / max(total_preds, 1)
        eps = 1e-12
        p = np.maximum(retail_marginal_np.astype(np.float64), 0.0)
        p = p / max(p.sum(), eps)
        q = np.maximum(q_pred, eps)
        # KL(retail || model_argmax). Both supported on full vocab.
        kl = float((p * (np.log(np.maximum(p, eps)) - np.log(q))).sum())
        # Excluding specials — apples-to-apples with retail "61.3% / 38.7%" framing.
        if dat_mask_np is not None and ace_mask_np is not None:
            ns_mask = ace_mask_np | dat_mask_np
            p_ns = p[ns_mask]; q_ns = q[ns_mask]
            p_ns = p_ns / max(p_ns.sum(), eps)
            q_ns = q_ns / max(q_ns.sum(), eps)
            kl_ns = float((p_ns * (np.log(np.maximum(p_ns, eps)) - np.log(np.maximum(q_ns, eps)))).sum())
            metrics['kl_retail_to_model_ex_specials'] = kl_ns
        metrics['kl_retail_to_model'] = kl
        supported = retail_marginal_np > 1e-9
        n_supported = int(supported.sum())
        n_emitted = int((nonzero & supported).sum())
        metrics['long_tail_recall'] = n_emitted / max(n_supported, 1)
        metrics['n_supported'] = n_supported

    return metrics


def find_max_batch_size(model, config, device, start=None):
    """Auto-detect the maximum batch size that fits in GPU memory."""
    print("  Auto-detecting max batch size...")
    
    ctx_dim = config['context_dim']
    max_seq = config['max_seq_len']
    obj_dim = config['obj_dim']
    
    # Determine starting batch size based on GPU VRAM
    if start is None:
        vram_gb = torch.cuda.get_device_properties(0).total_memory / 1024**3
        gpu_name = torch.cuda.get_device_name().lower()
        if 'h100' in gpu_name or 'a100' in gpu_name:
            start = 512
            print(f"    Detected high-end GPU ({torch.cuda.get_device_name()}, {vram_gb:.0f}GB) → trying batch 512")
        elif vram_gb >= 40:
            start = 256
            print(f"    Detected {vram_gb:.0f}GB VRAM → trying batch 256")
        else:
            start = 128
            print(f"    Detected {vram_gb:.0f}GB VRAM → trying batch 128")
    
    candidates = sorted([s for s in [512, 384, 256, 192, 128, 96, 64, 48, 32, 16, 8] if s <= start], reverse=True)
    
    atlas_meta = config.get('atlas_meta')
    if atlas_meta is not None:
        n_cat = len(atlas_meta['categorical_field_order'])
        n_scl = len(atlas_meta['scalar_field_order'])
        poi_dim = int(atlas_meta['poi_categories_cap'])
        mat_dim = int(atlas_meta['material_tags_cap'])
    for batch_size in candidates:
        try:
            torch.cuda.empty_cache()
            dummy_ctx = torch.randn(batch_size, ctx_dim, device=device)
            dummy_seq = torch.randn(batch_size, max_seq, obj_dim, device=device)
            dummy_mask = torch.ones(batch_size, max_seq, dtype=torch.bool, device=device)
            dummy_atlas_kwargs: dict = {}
            if atlas_meta is not None:
                dummy_atlas_kwargs = {
                    'atlas_ids': torch.zeros(batch_size, n_cat, dtype=torch.long, device=device),
                    'atlas_scalars': torch.zeros(batch_size, n_scl, device=device),
                    'atlas_poi': torch.zeros(batch_size, poi_dim, device=device),
                    'atlas_mats': torch.zeros(batch_size, mat_dim, device=device),
                }

            with autocast(dtype=torch.float16):
                out = model(dummy_ctx, dummy_seq, dummy_mask, **dummy_atlas_kwargs)
                loss = out[0].sum()
            loss.backward()
            
            model.zero_grad()
            torch.cuda.empty_cache()
            
            print(f"    Batch size {batch_size}: OK ✓")
            return batch_size
            
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            print(f"    Batch size {batch_size}: OOM ✗")
            continue
    
    return 8  # Minimum fallback


def save_full_checkpoint(epoch, model, optimizer, scheduler, ema, best_val_loss, path):
    """Save full training state for spot instance recovery."""
    checkpoint = {
        'epoch': epoch,
        'model_state_dict': model.state_dict(),
        'optimizer_state_dict': optimizer.state_dict(),
        'scheduler_state_dict': scheduler.state_dict(),
        'ema_state_dict': ema.state_dict(),
        'best_val_loss': best_val_loss,
    }
    temp_path = f"{path}.tmp"
    torch.save(checkpoint, temp_path)
    os.replace(temp_path, path)
    print(f"    Full checkpoint saved: {path}")


def save_weights_only(model, ema, path):
    """Save model weights only (for inference)."""
    # Use safetensors if available, otherwise torch
    try:
        from safetensors.torch import save_file
        # Apply EMA weights temporarily
        ema.apply_shadow()
        save_file(model.state_dict(), path)
        ema.restore()
        print(f"    Weights saved (safetensors): {path}")
    except ImportError:
        actual_path = path.replace('.safetensors', '.pt')
        ema.apply_shadow()
        torch.save(model.state_dict(), actual_path)
        ema.restore()
        print(f"    Weights saved (torch): {actual_path}")


def save_history(history, path):
    """Persist training history atomically to survive interruptions."""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    with tempfile.NamedTemporaryFile('w', delete=False, dir=directory, suffix='.tmp') as tmp:
        json.dump(history, tmp, indent=2)
        temp_path = tmp.name
    os.replace(temp_path, path)


def build_run_paths(run_name: str) -> dict:
    history_dir = os.path.join(LOG_DIR, run_name)
    return {
        'best_weights': os.path.join(CHECKPOINT_DIR, f"{run_name}_best.safetensors"),
        'final_weights': os.path.join(CHECKPOINT_DIR, f"{run_name}_final.safetensors"),
        'resume_checkpoint': os.path.join(CHECKPOINT_DIR, f"{run_name}_resume.pt"),
        'epoch_checkpoint': lambda epoch: os.path.join(CHECKPOINT_DIR, f"{run_name}_resume_epoch_{epoch}.pt"),
        'history': os.path.join(history_dir, "training_history.json"),
    }


def save_resume_checkpoint(epoch, model, optimizer, scheduler, ema, best_val_loss):
    """Write the rolling checkpoint used by --resume."""
    save_full_checkpoint(
        epoch, model, optimizer, scheduler, ema, best_val_loss,
        os.path.join(CHECKPOINT_DIR, "resume.pt")
    )


def filter_compatible_state_dict(module: nn.Module, state_dict: dict) -> tuple[dict, list[str]]:
    """Return only checkpoint tensors whose keys and shapes match the module."""
    current = module.state_dict()
    compatible = {}
    skipped = []

    for key, value in state_dict.items():
        if key not in current or current[key].shape != value.shape:
            skipped.append(key)
            continue
        compatible[key] = value

    return compatible, skipped


def load_compatible_state_dict(module: nn.Module, state_dict: dict, label: str) -> tuple[list[str], list[str]]:
    """
    Load only checkpoint tensors whose shapes still match the current module.
    This allows bounded architecture changes such as context-dimension growth
    while preserving most learned weights.
    """
    compatible, skipped = filter_compatible_state_dict(module, state_dict)
    missing, unexpected = module.load_state_dict(compatible, strict=False)
    if skipped:
        print(f"  {label}: skipped {len(skipped)} incompatible tensors")
    if missing:
        print(f"  {label}: missing {len(missing)} tensors after compatible load")
    if unexpected:
        print(f"  {label}: unexpected tensors {len(unexpected)}")
    return skipped, list(missing)


def load_resume_payload(path: str, device: torch.device) -> tuple[str, dict]:
    """
    Load either a full training checkpoint or a weights-only checkpoint.
    Returns a payload type of "training" or "weights".
    """
    lower_path = path.lower()
    if lower_path.endswith(".safetensors"):
        from safetensors.torch import load_file
        return "weights", load_file(path, device=str(device))

    checkpoint = torch.load(path, map_location=device)
    if not isinstance(checkpoint, dict):
        raise ValueError(f"Unsupported checkpoint format: {path}")
    if "model_state_dict" in checkpoint:
        return "training", checkpoint
    return "weights", checkpoint


def split_indices_for_validation(
    lb_coords: np.ndarray,
    val_split: float,
    mode: str,
    region_tile_size: int,
    seed: int,
):
    n = len(lb_coords)
    indices = np.arange(n)
    if n == 0:
        return indices, indices

    if mode != "region":
        shuffled = np.random.RandomState(seed).permutation(n)
        val_n = max(1, int(n * val_split))
        val_idx = shuffled[:val_n]
        train_idx = shuffled[val_n:]
        return train_idx, val_idx

    tile_size = max(int(region_tile_size), 1)
    region_keys = np.asarray([(int(x) // tile_size, int(y) // tile_size) for x, y in lb_coords], dtype=np.int32)
    unique_regions, inverse = np.unique(region_keys, axis=0, return_inverse=True)
    region_order = np.random.RandomState(seed).permutation(len(unique_regions))
    target_val_n = max(1, int(n * val_split))

    selected_regions = set()
    selected_count = 0
    for region_idx in region_order:
        selected_regions.add(int(region_idx))
        selected_count += int(np.sum(inverse == region_idx))
        if selected_count >= target_val_n:
            break

    val_mask = np.isin(inverse, list(selected_regions))
    val_idx = indices[val_mask]
    train_idx = indices[~val_mask]

    if len(train_idx) == 0 or len(val_idx) == 0:
        shuffled = np.random.RandomState(seed).permutation(n)
        val_n = max(1, int(n * val_split))
        val_idx = shuffled[:val_n]
        train_idx = shuffled[val_n:]

    return train_idx, val_idx


def build_stage_boundaries(total_epochs: int, warmup_epochs: int) -> list[int]:
    post_warmup = max(total_epochs - warmup_epochs, 1)
    raw_boundaries = (
        warmup_epochs,
        warmup_epochs + int(post_warmup * 0.15),
        warmup_epochs + int(post_warmup * 0.40),
        warmup_epochs + int(post_warmup * 0.70),
        total_epochs,
    )
    boundaries = [0]
    for boundary in raw_boundaries:
        boundaries.append(max(boundaries[-1] + 1, min(boundary, total_epochs)))
    boundaries[-1] = total_epochs
    return boundaries


def build_lr_scheduler(optimizer, config: dict, effective_warmup_epochs: int):
    schedule_name = config.get("lr_schedule", "staged")
    if schedule_name == "cosine":
        restart_epoch = int(config.get("cosine_restart_epoch", 0) or 0)
        # restart_epoch is in absolute epoch indices. Translate to "epochs after
        # warmup ends" since the scheduler only steps post-warmup.
        restart_after_warmup = restart_epoch - effective_warmup_epochs
        if restart_after_warmup <= 0:
            return torch.optim.lr_scheduler.CosineAnnealingLR(
                optimizer,
                T_max=max(1, config['epochs'] - effective_warmup_epochs),
                eta_min=config['lr_min'],
            )

        # Two-phase cosine: descend over [0, restart), reset to peak,
        # descend over [restart, end). Using a LambdaLR that returns the
        # multiplier on lr_max so phase boundaries are exact.
        eta_ratio = max(config['lr_min'] / max(config['lr_max'], 1e-12), 1e-6)
        post_warmup_epochs = max(1, config['epochs'] - effective_warmup_epochs)
        phase1_len = restart_after_warmup
        phase2_len = max(1, post_warmup_epochs - phase1_len)

        def lr_lambda(epoch_idx: int):
            if epoch_idx < phase1_len:
                progress = epoch_idx / max(phase1_len, 1)
            else:
                progress = (epoch_idx - phase1_len) / max(phase2_len, 1)
            progress = min(max(progress, 0.0), 1.0)
            cosine_mix = 0.5 * (1.0 + math.cos(math.pi * progress))
            return eta_ratio + (1.0 - eta_ratio) * cosine_mix

        return torch.optim.lr_scheduler.LambdaLR(optimizer, lr_lambda=lr_lambda)

    boundaries = build_stage_boundaries(config['epochs'], effective_warmup_epochs)
    scales = (1.0, 0.60, 0.30, 0.12, max(config['lr_min'] / max(config['lr_max'], 1e-12), 1e-4))

    def lr_lambda(epoch_idx: int):
        actual_epoch = epoch_idx + effective_warmup_epochs
        for start, end, start_scale, end_scale in zip(boundaries[1:-1], boundaries[2:], scales[:-1], scales[1:]):
            if actual_epoch <= end:
                span = max(end - start, 1)
                progress = min(max((actual_epoch - start) / span, 0.0), 1.0)
                cosine_mix = 0.5 * (1.0 + math.cos(math.pi * progress))
                return end_scale + (start_scale - end_scale) * cosine_mix
        return scales[-1]

    return torch.optim.lr_scheduler.LambdaLR(optimizer, lr_lambda=lr_lambda)


def train(config: dict, resume_path: Optional[str] = None):
    """Main training loop."""
    
    # ── Load data ──
    print("[1/5] Loading training data...")
    tensor_path = config.get('tensor_path', TENSOR_PATH)
    vocab_path = config.get('vocab_path', VOCAB_PATH)
    run_name = config.get('run_name', 'scene_placer')
    run_paths = build_run_paths(run_name)
    if not os.path.exists(tensor_path):
        print(f"  ERROR: Training data not found: {tensor_path}")
        return
    
    data = np.load(tensor_path)
    contexts = data['contexts']
    sequences = data['sequences']
    seq_lengths = data['seq_lengths']
    lb_coords = data['lb_coords'] if 'lb_coords' in data.files else None
    sample_weights = data['sample_weights'] if 'sample_weights' in data.files else np.ones(len(contexts), dtype=np.float32)
    vocab = load_vocab_metadata(vocab_path)

    # ── V6 atlas conditioning ──
    atlas_tensor_path = config.get('atlas_tensor_path')
    atlas_vocab_path = config.get('atlas_vocab_path')
    atlas_ids_arr = atlas_scalars_arr = atlas_poi_arr = atlas_mats_arr = None
    atlas_meta = None
    if atlas_tensor_path and atlas_vocab_path and os.path.exists(atlas_tensor_path) and os.path.exists(atlas_vocab_path):
        atlas_data = np.load(atlas_tensor_path) if atlas_tensor_path != tensor_path else data
        if 'atlas_ids' in atlas_data.files:
            atlas_ids_arr = atlas_data['atlas_ids']
            atlas_scalars_arr = atlas_data['atlas_scalars']
            atlas_poi_arr = atlas_data['atlas_poi_categories']
            atlas_mats_arr = atlas_data['atlas_material_tags']
            with open(atlas_vocab_path, 'r', encoding='utf-8') as _f:
                atlas_vocab = json.load(_f)
            atlas_meta = atlas_vocab.get('atlas')
            if atlas_meta is None:
                print("  WARN: atlas vocab missing 'atlas' block — disabling atlas conditioning")
                atlas_ids_arr = atlas_scalars_arr = atlas_poi_arr = atlas_mats_arr = None
            else:
                config['atlas_meta'] = atlas_meta
                print(f"  Atlas conditioning ENABLED: ids={atlas_ids_arr.shape}, "
                      f"scalars={atlas_scalars_arr.shape}, poi={atlas_poi_arr.shape}, "
                      f"mats={atlas_mats_arr.shape}")
                print(f"  Atlas warmup epochs: {config.get('atlas_warmup_epochs', 0)}, "
                      f"per-field dropout: {config.get('atlas_context_dropout', 0.0)}")
        else:
            print(f"  WARN: atlas-tensor-path {atlas_tensor_path} has no atlas_ids — disabling atlas")
    elif atlas_tensor_path or atlas_vocab_path:
        print(f"  WARN: atlas paths set but file missing — atlas-tensor={atlas_tensor_path} "
              f"atlas-vocab={atlas_vocab_path}")
    vocab_size = int(vocab.get('vocab_size', int(np.max(sequences[:, :, 0])) + 1))
    config['target_token_mode'] = str(vocab.get('target_token_mode', 'exact')).lower()

    if 'component_index_by_object' in data.files:
        component_features = build_component_feature_matrix(data, vocab_size)
        link_idx = sequences.shape[2]
        sequences = np.concatenate([sequences, component_features], axis=-1)
        config['dataset_schema'] = 'component_linked'
        config['coord_slice'] = (2, 4)
        config['rot_slice'] = (5, 7)
        config['link_idx'] = link_idx
    else:
        config['dataset_schema'] = 'legacy'
        config['coord_slice'] = (1, 3)
        config['rot_slice'] = (4, 6)
        config['link_idx'] = 7

    config['context_dim'] = int(contexts.shape[1])
    config['obj_dim'] = int(sequences.shape[2])
    config['max_seq_len'] = int(sequences.shape[1])
    config['vocab_path'] = vocab_path
    effective_warmup_epochs = min(
        config['warmup_epochs'],
        max(config.get('warmup_min_epochs', 10),
            int(math.ceil(config['epochs'] * config.get('warmup_fraction_cap', 0.2))))
    )
    
    print(f"  Loaded {len(contexts)} examples, context_dim={contexts.shape[1]}, "
          f"max_seq={sequences.shape[1]}, obj_dim={sequences.shape[2]}")
    print(f"  Dataset schema: {config['dataset_schema']}")
    print(f"  Target token mode: {config['target_token_mode']}")
    print(f"  Effective warmup epochs: {effective_warmup_epochs}")
    print(f"  Run name: {run_name}")
    
    # ── Train/val split ──
    if lb_coords is None:
        lb_coords = np.zeros((len(contexts), 2), dtype=np.int16)
    train_idx, val_idx = split_indices_for_validation(
        lb_coords=lb_coords,
        val_split=config['val_split'],
        mode=config.get('val_split_mode', 'random'),
        region_tile_size=config.get('region_tile_size', 8),
        seed=config.get('split_seed', 42),
    )
    
    train_ds = PlacementDataset(
        contexts, sequences, seq_lengths,
        config, indices=train_idx, augment=True,
        atlas_ids=atlas_ids_arr, atlas_scalars=atlas_scalars_arr,
        atlas_poi=atlas_poi_arr, atlas_mats=atlas_mats_arr,
    )
    val_ds = PlacementDataset(
        contexts, sequences, seq_lengths,
        config, indices=val_idx, augment=False,
        atlas_ids=atlas_ids_arr, atlas_scalars=atlas_scalars_arr,
        atlas_poi=atlas_poi_arr, atlas_mats=atlas_mats_arr,
    )
    
    print(f"  Train: {len(train_ds)}, Val: {len(val_ds)}")
    print(f"  Validation split mode: {config.get('val_split_mode', 'random')}")
    train_weights = torch.as_tensor(sample_weights[train_idx], dtype=torch.double)
    print(
        f"  Train sample weights: min={train_weights.min().item():.2f}, "
        f"mean={train_weights.mean().item():.2f}, max={train_weights.max().item():.2f}"
    )
    
    # ── Device ──
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    print(f"  Device: {device}")
    if device.type == 'cuda':
        print(f"  GPU: {torch.cuda.get_device_name()}")
        print(f"  VRAM: {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GB")
    
    # ── Model ──
    print("\n[2/5] Building model...")
    model = ScenePlacerTransformer(config).to(device)
    param_count = model.count_parameters()
    print(f"  Parameters: {param_count:,} ({param_count/1e6:.1f}M)")
    if config.get('target_token_mode', 'exact') == 'exact':
        token_family_index = build_token_family_index(model.vocab_size, vocab_path)
        config['token_family_index'] = token_family_index.to(device)
        config['family_projection'] = build_family_projection(token_family_index, model.vocab_size).to(device)
    else:
        config['token_family_index'] = None
        config['family_projection'] = None

    ace_abstract_weight = float(config.get('ace_abstract_weight', 1.0))
    dat_inv_freq = bool(config.get('dat_inv_freq', False))
    lambda_marginal_kl = float(config.get('lambda_marginal_kl', 0.0))
    needs_label_freqs = dat_inv_freq or lambda_marginal_kl > 0.0

    label_freqs = None
    if needs_label_freqs:
        print("  Computing per-token label frequencies over training split...")
        label_freqs = compute_label_frequencies(
            sequences, seq_lengths, train_idx, model.vocab_size
        )
        nz = int((label_freqs > 0).sum())
        print(f"    train labels: {int(label_freqs.sum())} tokens, "
              f"{nz} / {model.vocab_size} vocab idxs with positive support")

    if ace_abstract_weight != 1.0 or dat_inv_freq:
        config['class_space_weight'] = build_class_space_weight(
            model.vocab_size, vocab_path, ace_abstract_weight,
            dat_inv_freq=dat_inv_freq,
            dat_freq=label_freqs,
            dat_clamp_min=float(config.get('dat_clamp_min', 0.5)),
            dat_clamp_max=float(config.get('dat_clamp_max', 5.0)),
        ).to(device)
    else:
        config['class_space_weight'] = None

    if lambda_marginal_kl > 0.0 and label_freqs is not None:
        retail_marginal = build_retail_marginal(label_freqs).to(device)
        config['retail_marginal'] = retail_marginal
        # Also stash a CPU numpy copy for compute_diversity_metrics so the
        # KL-to-retail metric is available regardless of the loss term.
        print(f"  retail_marginal: support={int((label_freqs > 0).sum())}, "
              f"argmax_idx={int(label_freqs.argmax())}, "
              f"argmax_mass={float(label_freqs.max() / max(label_freqs.sum(), 1)):.4f}")
    elif label_freqs is not None:
        # Even without the loss term, expose the marginal so val metrics can
        # report KL-to-retail.
        config['retail_marginal'] = build_retail_marginal(label_freqs).to(device)
    else:
        config['retail_marginal'] = None

    config['ace_abstract_token_mask'] = build_ace_abstract_mask(
        model.vocab_size, vocab_path,
    ).to(device)
    
    # ── Batch size auto-detection ──
    if device.type == 'cuda':
        max_batch = find_max_batch_size(model, config, device)
        batch_size = min(config['batch_size'], max_batch)
    else:
        batch_size = min(config['batch_size'], 8)
    
    print(f"  Effective batch size: {batch_size}")
    
    train_sampler = WeightedRandomSampler(
        weights=train_weights,
        num_samples=len(train_weights),
        replacement=True,
    )
    train_loader = DataLoader(train_ds, batch_size=batch_size, sampler=train_sampler,
                              num_workers=0, pin_memory=True, drop_last=True)
    val_loader = DataLoader(val_ds, batch_size=batch_size, shuffle=False,
                            num_workers=0, pin_memory=True)
    
    # ── Optimizer & Scheduler ──
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=config['lr_max'],
        weight_decay=config['weight_decay']
    )
    
    # Cosine annealing with warmup
    scheduler = build_lr_scheduler(optimizer, config, effective_warmup_epochs)
    
    # EMA
    ema = EMA(model, decay=config['ema_decay'])
    
    # Mixed precision
    scaler = GradScaler() if device.type == 'cuda' else None
    
    # ── Resume from checkpoint ──
    start_epoch = 0
    best_val_loss = float('inf')
    
    if resume_path and os.path.exists(resume_path):
        print(f"\n  Resuming from {resume_path}...")
        payload_type, checkpoint = load_resume_payload(resume_path, device)
        ema_skipped = []

        if payload_type == "training":
            model_skipped, _ = load_compatible_state_dict(
                model, checkpoint['model_state_dict'], "Model checkpoint"
            )
            if 'ema_state_dict' in checkpoint:
                ema = EMA(model, decay=config['ema_decay'])
                _, ema_skipped = filter_compatible_state_dict(model, checkpoint['ema_state_dict'])
                if not ema_skipped:
                    ema.load_state_dict(checkpoint['ema_state_dict'])
                else:
                    print(f"  EMA checkpoint: skipped {len(ema_skipped)} incompatible tensors; rebuilding EMA from current model state.")
            if not model_skipped and not ema_skipped:
                optimizer.load_state_dict(checkpoint['optimizer_state_dict'])
                scheduler_state = checkpoint.get('scheduler_state_dict')
                if scheduler_state:
                    try:
                        scheduler.load_state_dict(scheduler_state)
                    except KeyError as exc:
                        print(f"  Scheduler checkpoint missing expected key ({exc}); keeping fresh scheduler state for resumed run.")
            else:
                print("  Resume note: context shape changed, keeping model weights where compatible and resetting optimizer/scheduler state.")
            start_epoch = checkpoint['epoch'] + 1
            best_val_loss = checkpoint['best_val_loss']
            print(f"  Resumed at epoch {start_epoch}, best_val_loss={best_val_loss:.4f}")
        else:
            model_skipped, _ = load_compatible_state_dict(
                model, checkpoint, "Weights checkpoint"
            )
            if model_skipped:
                print("  Weights-only resume: some tensors were incompatible; starting a fresh optimizer/scheduler state.")
            else:
                print("  Weights-only resume: loaded model weights and starting a fresh optimizer/scheduler state.")
            ema = EMA(model, decay=config['ema_decay'])
    
    # ── Training ──
    print(f"\n[3/5] Training for {config['epochs']} epochs...")
    os.makedirs(CHECKPOINT_DIR, exist_ok=True)
    os.makedirs(LOG_DIR, exist_ok=True)
    
    history = []
    patience_counter = 0
    history_path = run_paths['history']
    last_completed_epoch = start_epoch - 1
    entropy_check_epoch = max(
        config.get('min_entropy_check_epoch', effective_warmup_epochs),
        effective_warmup_epochs,
    )
    
    try:
        for epoch in range(start_epoch, config['epochs']):
            t_epoch = time.time()
            model.train()

            # V6 atlas warmup: zero-mask the atlas branch's contribution for
            # the first --atlas-warmup-epochs epochs after a resume so the
            # transformer body adapts to the new context-encoder-half before
            # the atlas conditioning kicks in. Without this, the resumed body
            # sees a different conditioning distribution from epoch 0 and the
            # position head can spike (the failure mode V5 hit at epoch 17).
            atlas_warmup_n = int(config.get('atlas_warmup_epochs', 0) or 0)
            config['_atlas_zero_mask_active'] = (
                config.get('atlas_meta') is not None and epoch < atlas_warmup_n
            )
            if config['_atlas_zero_mask_active']:
                print(f"  [atlas-warmup] epoch {epoch+1}/{atlas_warmup_n}: atlas branch masked to zero")

            epoch_losses = defaultdict(float)
            n_batches = 0
        
            for batch_idx, batch in enumerate(train_loader):
                max_train_batches = config.get('max_train_batches')
                if max_train_batches is not None and batch_idx >= max_train_batches:
                    break
                # Warmup: linear learning rate increase
                if epoch < effective_warmup_epochs:
                    warmup_factor = (epoch * len(train_loader) + n_batches) / \
                                   (effective_warmup_epochs * len(train_loader))
                    for pg in optimizer.param_groups:
                        pg['lr'] = config['lr_max'] * warmup_factor
                
                optimizer.zero_grad()
                
                if scaler:
                    with autocast(dtype=torch.float16):
                        loss, loss_dict = compute_loss(model, batch, config, device)
                    scaler.scale(loss).backward()
                    scaler.unscale_(optimizer)
                    torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                    scaler.step(optimizer)
                    scaler.update()
                else:
                    loss, loss_dict = compute_loss(model, batch, config, device)
                    loss.backward()
                    torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                    optimizer.step()
                
                ema.update()
                
                for k, v in loss_dict.items():
                    epoch_losses[k] += v
                n_batches += 1
        
            # Step scheduler (after warmup)
            if epoch >= effective_warmup_epochs:
                scheduler.step()
        
            # Average training losses
            train_metrics = {k: v / n_batches for k, v in epoch_losses.items()}
            
            # ── Validation ──
            val_metrics = {}
            if (epoch + 1) % config.get('validation_every', 10) == 0 or epoch == config['epochs'] - 1:
                model.eval()
                ema.apply_shadow()  # Use EMA weights for validation
                
                val_losses = defaultdict(float)
                val_batches = 0
                
                with torch.no_grad():
                    for batch_idx, batch in enumerate(val_loader):
                        max_val_batches = config.get('max_val_batches')
                        if max_val_batches is not None and batch_idx >= max_val_batches:
                            break
                        if scaler:
                            with autocast(dtype=torch.float16):
                                _, loss_dict = compute_loss(model, batch, config, device)
                        else:
                            _, loss_dict = compute_loss(model, batch, config, device)
                        
                        for k, v in loss_dict.items():
                            val_losses[k] += v
                        val_batches += 1
                
                val_metrics = {f"val_{k}": v / val_batches for k, v in val_losses.items()}
                
                # Diversity metrics
                diversity = compute_diversity_metrics(model, val_loader, config, device)
                val_metrics.update(diversity)
                
                ema.restore()
                
                # Check overfitting
                overfit_gap = val_metrics.get('val_total', 0) - train_metrics['total']
                val_metrics['overfit_gap'] = overfit_gap
                val_metrics['entropy_check_epoch'] = entropy_check_epoch
                
                # ── EARLY STOPPING RAILS ──
                if epoch >= config['min_overfit_epoch'] and overfit_gap > config['overfit_gap_threshold']:
                    print(f"\n  ⚠️  OVERFIT DETECTED (gap={overfit_gap:.3f} > {config['overfit_gap_threshold']})")
                    save_weights_only(
                        model, ema,
                        os.path.join(CHECKPOINT_DIR, "emergency_overfit_stop.safetensors")
                    )
                    save_resume_checkpoint(epoch, model, optimizer, scheduler, ema, best_val_loss)
                    print("  Training stopped to prevent overfitting.")
                    last_completed_epoch = epoch
                    break
                
                wcid_ent = val_metrics.get('wcid_entropy', 999)
                entropy_gate_open = (
                    config.get('entropy_lr_halving_enabled', True) and
                    epoch >= entropy_check_epoch
                )
                val_metrics['entropy_gate_open'] = float(entropy_gate_open)
                if wcid_ent < config['entropy_collapse_threshold']:
                    if entropy_gate_open:
                        print(
                            f"\n  ⚠️  MODE COLLAPSE (entropy={wcid_ent:.2f} < "
                            f"{config['entropy_collapse_threshold']}, epoch {epoch} >= {entropy_check_epoch})"
                        )
                        print("  Reducing learning rate by 50%...")
                        for pg in optimizer.param_groups:
                            pg['lr'] *= 0.5
                    else:
                        print(
                            f"\n  Note: low validation entropy ({wcid_ent:.2f}) observed at epoch {epoch}, "
                            f"but collapse rail is disabled until epoch {entropy_check_epoch} "
                            f"(post-warmup safeguard)."
                        )
                
                # Track best validation loss
                val_total = val_metrics.get('val_total', float('inf'))
                if val_total < best_val_loss:
                    best_val_loss = val_total
                    patience_counter = 0
                    save_weights_only(
                        model, ema,
                        run_paths['best_weights']
                    )
                    save_full_checkpoint(
                        epoch, model, optimizer, scheduler, ema, best_val_loss,
                        run_paths['resume_checkpoint']
                    )
                else:
                    patience_counter += 1
                
                if patience_counter >= config['patience']:
                    print(f"\n  Early stopping (patience={config['patience']} exhausted)")
                    save_resume_checkpoint(epoch, model, optimizer, scheduler, ema, best_val_loss)
                    last_completed_epoch = epoch
                    break
            
            # ── Logging ──
            elapsed = time.time() - t_epoch
            lr = optimizer.param_groups[0]['lr']
            
            log_entry = {
                'epoch': epoch,
                'lr': lr,
                'elapsed': elapsed,
                **train_metrics,
                **val_metrics,
            }
            history.append(log_entry)
            save_history(history, history_path)
            
            # Print progress
            val_str = ""
            if val_metrics:
                val_str = (f"  val={val_metrics.get('val_total', 0):.4f} "
                          f"ent={val_metrics.get('wcid_entropy', 0):.1f} "
                          f"gap={val_metrics.get('overfit_gap', 0):.3f} "
                          f"ace={val_metrics.get('ace_emit_frac', 0)*100:.1f}%")
            
            print(f"  Epoch {epoch:4d}/{config['epochs']}  "
                  f"loss={train_metrics['total']:.4f} "
                  f"(wcid={train_metrics['wcid']:.3f} pos={train_metrics['pos']:.4f} "
                  f"link={train_metrics['link']:.3f})"
                  f"{val_str}  "
                  f"lr={lr:.2e}  {elapsed:.1f}s")
            
            # ── Checkpointing ──
            if (epoch + 1) % config['resume_checkpoint_every'] == 0:
                save_full_checkpoint(
                    epoch, model, optimizer, scheduler, ema, best_val_loss,
                    run_paths['resume_checkpoint']
                )
            
            if (epoch + 1) % config['checkpoint_every'] == 0:
                save_full_checkpoint(
                    epoch, model, optimizer, scheduler, ema, best_val_loss,
                    run_paths['epoch_checkpoint'](epoch + 1)
                )
            
            last_completed_epoch = epoch
    except KeyboardInterrupt:
        print("\n  Interrupted. Saving resume checkpoint before exit...")
        checkpoint_epoch = last_completed_epoch if last_completed_epoch >= start_epoch else start_epoch
        save_full_checkpoint(
            checkpoint_epoch, model, optimizer, scheduler, ema, best_val_loss,
            run_paths['resume_checkpoint']
        )
        save_history(history, history_path)
        raise
    except Exception:
        print("\n  Training crashed. Saving resume checkpoint before re-raising...")
        checkpoint_epoch = last_completed_epoch if last_completed_epoch >= start_epoch else start_epoch
        save_full_checkpoint(
            checkpoint_epoch, model, optimizer, scheduler, ema, best_val_loss,
            run_paths['resume_checkpoint']
        )
        save_history(history, history_path)
        raise
    
    # ── Final save ──
    print(f"\n[4/5] Saving final model...")
    save_weights_only(
        model, ema,
        run_paths['final_weights']
    )
    
    # Save training history
    save_history(history, history_path)
    print(f"  Training history: {history_path}")
    
    # ── Summary ──
    print(f"\n[5/5] Training complete!")
    print(f"  Best validation loss: {best_val_loss:.4f}")
    print(f"  Total epochs: {epoch + 1}")
    if history:
        final_diversity = {k: v for k, v in history[-1].items() 
                         if k in ('wcid_entropy', 'unique_wcids', 'pos_std')}
        print(f"  Final diversity: {final_diversity}")


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Train Scene Placement Transformer")
    parser.add_argument("--resume", type=str, default=None,
                       help="Resume from checkpoint (.pt file)")
    parser.add_argument("--epochs", type=int, default=None)
    parser.add_argument("--batch", type=int, default=None)
    parser.add_argument("--lr", type=float, default=None)
    parser.add_argument("--lr-min", type=float, default=None)
    parser.add_argument("--patience", type=int, default=None)
    parser.add_argument("--warmup-epochs", type=int, default=None)
    parser.add_argument("--warmup-min-epochs", type=int, default=None)
    parser.add_argument("--warmup-fraction-cap", type=float, default=None)
    parser.add_argument("--weight-decay", type=float, default=None)
    parser.add_argument("--tensor-path", type=str, default=TENSOR_PATH)
    parser.add_argument("--vocab-path", type=str, default=VOCAB_PATH)
    parser.add_argument("--max-train-batches", type=int, default=None)
    parser.add_argument("--max-val-batches", type=int, default=None)
    parser.add_argument("--run-name", type=str, default="scene_placer")
    parser.add_argument("--checkpoint-every", type=int, default=None)
    parser.add_argument("--resume-checkpoint-every", type=int, default=None)
    parser.add_argument("--validation-every", type=int, default=None)
    parser.add_argument("--val-split-mode", type=str, choices=("random", "region"), default=None)
    parser.add_argument("--region-tile-size", type=int, default=None)
    parser.add_argument("--lr-schedule", type=str, choices=("cosine", "staged"), default=None)
    parser.add_argument("--focal-gamma", type=float, default=None,
                        help="Focal loss gamma on the wcid head. 0 = pure CE; 1.0-2.0 down-weights confident predictions to give rare classes more gradient.")
    parser.add_argument("--ace-abstract-weight", type=float, default=None,
                        help="Per-token CE weight for ace_abstract vocab entries (relative to model_id at 1.0). "
                             "Counteracts the ~41x DAT-vs-ACE vocab imbalance. Try 5-20.")
    parser.add_argument("--cosine-restart-epoch", type=int, default=None,
                        help="When using --lr-schedule cosine, reset LR to peak at this absolute epoch and start a fresh cosine descent. 0 = no restart.")
    parser.add_argument("--dat-inv-freq", action="store_true",
                        help="V5: scale DAT (model_id) per-token CE by sqrt(median_dat_freq / token_dat_freq), "
                             "clamped to [--dat-clamp-min, --dat-clamp-max]. Targets the intra-DAT long-tail collapse "
                             "surfaced by Phase 0 diagnostic; ACE entries are unaffected.")
    parser.add_argument("--dat-clamp-min", type=float, default=None,
                        help="Lower clamp for DAT inv-freq weight (default 0.5).")
    parser.add_argument("--dat-clamp-max", type=float, default=None,
                        help="Upper clamp for DAT inv-freq weight (default 5.0).")
    parser.add_argument("--lambda-marginal-kl", type=float, default=None,
                        help="V5: weight on the anti-collapse KL(P_retail || batch_marginal) loss term. "
                             "Pushes the per-batch model token marginal toward the empirical retail "
                             "distribution. Try 0.02-0.05; default 0 (off).")
    parser.add_argument("--label-smoothing", type=float, default=None,
                        help="Label smoothing applied to wcid CE. Default 0.2; raise to 0.3 to spread "
                             "more mass onto rare tokens.")
    parser.add_argument("--atlas-tensor-path", type=str, default=None,
                        help="V6: NPZ with atlas_ids/atlas_scalars/atlas_poi_categories/atlas_material_tags "
                             "aligned to --tensor-path row order. May be the same file as --tensor-path.")
    parser.add_argument("--atlas-vocab-path", type=str, default=None,
                        help="V6: vocab JSON with an 'atlas' block containing categorical_field_order, "
                             "vocab_caps, embedding_dims, scalar_field_order, poi_categories_cap, "
                             "material_tags_cap.")
    parser.add_argument("--atlas-warmup-epochs", type=int, default=None,
                        help="V6: zero-mask the atlas branch's contribution for this many epochs after a "
                             "resume so the resumed transformer body adapts to the new context-encoder "
                             "half before the atlas conditioning kicks in.")
    parser.add_argument("--atlas-context-dropout", type=float, default=None,
                        help="V6: per-field Bernoulli drop probability applied to atlas ids (drop to UNK) "
                             "and scalars (drop to 0) during training. Forces the model to spread "
                             "conditioning across multiple semantic fields.")
    args = parser.parse_args()
    
    config = DEFAULT_CONFIG.copy()
    if args.epochs:
        config['epochs'] = args.epochs
    if args.batch:
        config['batch_size'] = args.batch
    if args.lr:
        config['lr_max'] = args.lr
    if args.lr_min is not None:
        config['lr_min'] = args.lr_min
    if args.patience is not None:
        config['patience'] = args.patience
    if args.warmup_epochs is not None:
        config['warmup_epochs'] = args.warmup_epochs
    if args.warmup_min_epochs is not None:
        config['warmup_min_epochs'] = args.warmup_min_epochs
    if args.warmup_fraction_cap is not None:
        config['warmup_fraction_cap'] = args.warmup_fraction_cap
    if args.weight_decay is not None:
        config['weight_decay'] = args.weight_decay
    if args.checkpoint_every:
        config['checkpoint_every'] = args.checkpoint_every
    if args.resume_checkpoint_every:
        config['resume_checkpoint_every'] = args.resume_checkpoint_every
    if args.validation_every:
        config['validation_every'] = args.validation_every
    if args.val_split_mode:
        config['val_split_mode'] = args.val_split_mode
    if args.region_tile_size:
        config['region_tile_size'] = args.region_tile_size
    if args.lr_schedule:
        config['lr_schedule'] = args.lr_schedule
    if args.focal_gamma is not None:
        config['focal_gamma'] = args.focal_gamma
    if args.ace_abstract_weight is not None:
        config['ace_abstract_weight'] = args.ace_abstract_weight
    if args.cosine_restart_epoch is not None:
        config['cosine_restart_epoch'] = args.cosine_restart_epoch
    if args.dat_inv_freq:
        config['dat_inv_freq'] = True
    if args.dat_clamp_min is not None:
        config['dat_clamp_min'] = args.dat_clamp_min
    if args.dat_clamp_max is not None:
        config['dat_clamp_max'] = args.dat_clamp_max
    if args.lambda_marginal_kl is not None:
        config['lambda_marginal_kl'] = args.lambda_marginal_kl
    if args.label_smoothing is not None:
        config['label_smoothing'] = args.label_smoothing
    config['tensor_path'] = args.tensor_path
    config['vocab_path'] = args.vocab_path
    config['max_train_batches'] = args.max_train_batches
    config['max_val_batches'] = args.max_val_batches
    config['run_name'] = args.run_name
    if args.atlas_tensor_path is not None:
        config['atlas_tensor_path'] = args.atlas_tensor_path
    if args.atlas_vocab_path is not None:
        config['atlas_vocab_path'] = args.atlas_vocab_path
    if args.atlas_warmup_epochs is not None:
        config['atlas_warmup_epochs'] = args.atlas_warmup_epochs
    if args.atlas_context_dropout is not None:
        config['atlas_context_dropout'] = args.atlas_context_dropout
    
    print("=" * 72)
    print("  Scene Placement Transformer — Training")
    print("  ML-Driven World Population for Dereth")
    print("=" * 72)
    print()
    print("  Config:")
    for k, v in sorted(config.items()):
        print(f"    {k}: {v}")
    print()
    
    train(config, resume_path=args.resume)


if __name__ == '__main__':
    main()

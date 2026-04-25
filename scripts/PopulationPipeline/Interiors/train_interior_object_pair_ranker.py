#!/usr/bin/env python3
"""
Train a pairwise support/object ranker.

The model sees one support plus two object candidates and learns to score the
positive object higher than the confuser.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import numpy as np

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    from torch.utils.data import DataLoader, Dataset
except ImportError:
    print("ERROR: PyTorch not found.")
    sys.exit(1)


ROOT = Path(__file__).resolve().parents[3]
REFERENCE_DIR = ROOT / "pipeline_data" / "reference"
MODEL_DIR = ROOT / "pipeline_data" / "models" / "interiors"
DEFAULT_DATASET_JSONL = REFERENCE_DIR / "fullworld_interior_support_object_pairwise_v2.jsonl"

# ── Feature spec, ontology-grounded ──
# The v1 spec leaned on propClass / enrichmentType / lsdHookType which were
# `<none>` for 70%+ of static-envcell rows. The new spec keys off the unified
# ontology's geomCategory / geomScale / primaryType / architecture and the
# is_building / is_scenery DAT signals, which we measured as differing in
# 97.2% of pairs in the rebuilt corpus.

SUPPORT_CATEGORY_SPECS = (
    ("support_class_space",  ("support", "classIdSpace")),
    ("support_class",        ("support", "supportClass")),
    ("support_source_kind",  ("support", "sourceKind")),
    ("support_uo_geom_cat",  ("support", "unifiedOntology", "geomCategory")),
    ("support_uo_geom_scale",("support", "unifiedOntology", "geomScale")),
    ("support_uo_primary",   ("support", "unifiedOntology", "primaryType")),
    ("support_uo_resolution",("support", "unifiedOntology", "resolutionSource")),
)

OBJECT_CATEGORY_SPECS = (
    ("object_class_space",   "classIdSpace"),
    ("object_source_kind",   "sourceKind"),
    ("object_uo_geom_cat",   "unifiedOntology.geomCategory"),
    ("object_uo_geom_scale", "unifiedOntology.geomScale"),
    ("object_uo_primary",    "unifiedOntology.primaryType"),
    ("object_uo_resolution", "unifiedOntology.resolutionSource"),
)

SUPPORT_NUMERIC_KEYS = (
    "supportHalfExtentX",
    "supportHalfExtentY",
    "supportArea",
    "supportCellLocalX",
    "supportCellLocalY",
    "supportDistWest",
    "supportDistEast",
    "supportDistSouth",
    "supportDistNorth",
    "portalCountInCell",
    "visibleCellCount",
    "staticObjectCountInCell",
    "staticObjectCountInComponent",
    "cellCountInComponent",
    "positiveCount",
    "positiveDxMean",
    "positiveDyMean",
    "positiveHeightMean",
    "supportIsHookPlacable",
    "supportHasGroundedName",
    "supportHasWeenieType",
    "supportWeenieType",
    # NEW unified ontology features for the support
    "supportUoMaxDimension",
    "supportUoAspectRatio",
    "supportUoPartCount",
    "supportUoPolyCount",
    "supportUoIsBuilding",
    "supportUoIsScenery",
    "supportUoResolved",
)

OBJECT_NUMERIC_KEYS = (
    "isHookPlacable",
    "hasGroundedName",
    "hasWeenieType",
    "weenieType",
    "semDominantWeenieType",
    # NEW unified ontology features for the object
    "uoMaxDimension",
    "uoAspectRatio",
    "uoPartCount",
    "uoPolyCount",
    "uoIsBuilding",
    "uoIsScenery",
    "uoResolved",
)

MAX_TAG_ITEMS = 12


@dataclass
class Config:
    epochs: int = 80
    batch_size: int = 256
    lr: float = 3e-4
    weight_decay: float = 1e-2
    hidden_dim: int = 256
    depth: int = 3
    dropout: float = 0.15
    val_split: float = 0.15
    seed: int = 42
    # Early-stop patience on val_pair_accuracy plateau (epochs)
    patience: int = 15
    # Identity-embedding dim for objectKey (set to 0 to disable identity feature)
    object_id_embed_dim: int = 32
    # Per-batch dropout applied to the objectKey embedding during training only.
    # Forces the model to fall back on ontology features for the dropped rows.
    object_id_dropout: float = 0.30


def normalized_token(value) -> str:
    if value is None:
        return "<none>"
    text = str(value).strip().lower()
    return text if text else "<none>"


def iter_jsonl(path: Path):
    with path.open("r", encoding="utf-8-sig") as handle:
        for line in handle:
            line = line.strip()
            if line:
                yield json.loads(line)


def nested_get(row: dict, path: tuple[str, ...]):
    cursor = row
    for key in path:
        if not isinstance(cursor, dict):
            return None
        cursor = cursor.get(key)
    return cursor


def object_field(obj: dict, key: str):
    if "." not in key:
        return obj.get(key)
    cursor = obj
    for part in key.split("."):
        if not isinstance(cursor, dict):
            return None
        cursor = cursor.get(part)
    return cursor


def build_vocab(values: list[str], min_freq: int = 1) -> tuple[dict[str, int], list[str]]:
    counts = Counter(values)
    tokens = ["<unk>"]
    for token, count in sorted(counts.items()):
        if token == "<unk>":
            continue
        if count >= min_freq:
            tokens.append(token)
    return {token: idx for idx, token in enumerate(tokens)}, tokens


def split_by_group(rows: list[dict], split_key: str, val_split: float, seed: int):
    groups = sorted({str(row.get(split_key) or "") for row in rows})
    rng = random.Random(seed)
    rng.shuffle(groups)
    val_n = max(1, int(math.ceil(len(groups) * val_split)))
    val_groups = set(groups[:val_n])
    train_idx = []
    val_idx = []
    for idx, row in enumerate(rows):
        if str(row.get(split_key) or "") in val_groups:
            val_idx.append(idx)
        else:
            train_idx.append(idx)
    if not train_idx or not val_idx:
        raise RuntimeError(f"Failed to build non-empty train/val split for {split_key}.")
    return np.asarray(train_idx, dtype=np.int64), np.asarray(val_idx, dtype=np.int64)


class PairDataset(Dataset):
    def __init__(self, support_cat, support_num, pos_cat, pos_num, pos_tags, pos_tag_mask, pos_object_id, neg_cat, neg_num, neg_tags, neg_tag_mask, neg_object_id, weights, indices):
        self.support_cat = torch.from_numpy(support_cat[indices]).long()
        self.support_num = torch.from_numpy(support_num[indices]).float()
        self.pos_cat = torch.from_numpy(pos_cat[indices]).long()
        self.pos_num = torch.from_numpy(pos_num[indices]).float()
        self.pos_tags = torch.from_numpy(pos_tags[indices]).long()
        self.pos_tag_mask = torch.from_numpy(pos_tag_mask[indices]).float()
        self.pos_object_id = torch.from_numpy(pos_object_id[indices]).long()
        self.neg_cat = torch.from_numpy(neg_cat[indices]).long()
        self.neg_num = torch.from_numpy(neg_num[indices]).float()
        self.neg_tags = torch.from_numpy(neg_tags[indices]).long()
        self.neg_tag_mask = torch.from_numpy(neg_tag_mask[indices]).float()
        self.neg_object_id = torch.from_numpy(neg_object_id[indices]).long()
        self.weights = torch.from_numpy(weights[indices]).float()

    def __len__(self):
        return len(self.support_cat)

    def __getitem__(self, idx):
        return (
            self.support_cat[idx],
            self.support_num[idx],
            self.pos_cat[idx],
            self.pos_num[idx],
            self.pos_tags[idx],
            self.pos_tag_mask[idx],
            self.pos_object_id[idx],
            self.neg_cat[idx],
            self.neg_num[idx],
            self.neg_tags[idx],
            self.neg_tag_mask[idx],
            self.neg_object_id[idx],
            self.weights[idx],
        )


class PairRanker(nn.Module):
    def __init__(self, support_cardinalities, support_numeric_dim, object_cardinalities, object_numeric_dim, tag_vocab_size, object_id_vocab_size, object_id_embed_dim, object_id_dropout, hidden_dim, depth, dropout):
        super().__init__()
        self.object_id_dropout_prob = float(object_id_dropout)

        self.support_embeddings = nn.ModuleList()
        support_embed_dims = []
        for size in support_cardinalities:
            emb_dim = min(24, max(4, int(round(size ** 0.5 * 2.0))))
            self.support_embeddings.append(nn.Embedding(size, emb_dim))
            support_embed_dims.append(emb_dim)

        self.object_embeddings = nn.ModuleList()
        object_embed_dims = []
        for size in object_cardinalities:
            emb_dim = min(24, max(4, int(round(size ** 0.5 * 2.0))))
            self.object_embeddings.append(nn.Embedding(size, emb_dim))
            object_embed_dims.append(emb_dim)

        self.tag_embedding = nn.Embedding(tag_vocab_size, min(32, max(8, int(round(tag_vocab_size ** 0.5)))))
        tag_dim = self.tag_embedding.embedding_dim

        if object_id_embed_dim > 0 and object_id_vocab_size > 1:
            self.object_id_embedding = nn.Embedding(object_id_vocab_size, object_id_embed_dim)
            id_dim = object_id_embed_dim
        else:
            self.object_id_embedding = None
            id_dim = 0

        pair_input_dim = sum(support_embed_dims) + support_numeric_dim + sum(object_embed_dims) + object_numeric_dim + tag_dim + id_dim
        layers = [nn.Linear(pair_input_dim, hidden_dim), nn.LayerNorm(hidden_dim), nn.GELU(), nn.Dropout(dropout)]
        for _ in range(max(depth - 1, 0)):
            layers.extend([nn.Linear(hidden_dim, hidden_dim), nn.LayerNorm(hidden_dim), nn.GELU(), nn.Dropout(dropout)])
        self.scorer = nn.Sequential(*layers)
        self.head = nn.Linear(hidden_dim, 1)

    def pool_tags(self, tags, mask):
        hidden = self.tag_embedding(tags)
        mask = mask.unsqueeze(-1)
        summed = (hidden * mask).sum(dim=1)
        count = mask.sum(dim=1).clamp_min(1.0)
        return summed / count

    def object_id_features(self, object_id):
        if self.object_id_embedding is None:
            return None
        emb = self.object_id_embedding(object_id)
        if self.training and self.object_id_dropout_prob > 0.0:
            # Per-row Bernoulli mask: zero the entire embedding for the
            # selected rows so the model is forced to use ontology features.
            keep = (torch.rand(emb.size(0), 1, device=emb.device) >= self.object_id_dropout_prob).float()
            emb = emb * keep
        return emb

    def encode_pair(self, support_cat, support_num, object_cat, object_num, object_tags, object_tag_mask, object_id):
        pieces = [emb(support_cat[:, idx]) for idx, emb in enumerate(self.support_embeddings)]
        pieces.append(support_num)
        pieces.extend([emb(object_cat[:, idx]) for idx, emb in enumerate(self.object_embeddings)])
        pieces.append(object_num)
        pieces.append(self.pool_tags(object_tags, object_tag_mask))
        id_feat = self.object_id_features(object_id)
        if id_feat is not None:
            pieces.append(id_feat)
        hidden = self.scorer(torch.cat(pieces, dim=-1))
        return self.head(hidden).squeeze(-1)

    def forward(self, support_cat, support_num, pos_cat, pos_num, pos_tags, pos_tag_mask, pos_object_id, neg_cat, neg_num, neg_tags, neg_tag_mask, neg_object_id):
        pos_score = self.encode_pair(support_cat, support_num, pos_cat, pos_num, pos_tags, pos_tag_mask, pos_object_id)
        neg_score = self.encode_pair(support_cat, support_num, neg_cat, neg_num, neg_tags, neg_tag_mask, neg_object_id)
        return pos_score, neg_score


def load_rows(path: Path):
    rows = list(iter_jsonl(path))
    if not rows:
        raise RuntimeError(f"No rows found in {path}")
    return rows


def object_numeric(obj: dict):
    sem = obj.get("semanticSummary") or {}
    uo = obj.get("unifiedOntology") or {}
    return [
        float(bool(obj.get("isHookPlacable"))),
        float(bool(obj.get("preferredName"))),
        float(obj.get("weenieType") is not None),
        float(obj.get("weenieType") or 0.0),
        float(sem.get("dominantWeenieType") or 0.0),
        float(uo.get("geomMaxDimension") or 0.0),
        float(uo.get("geomAspectRatio") or 0.0),
        float(uo.get("geomPartCount") or 0.0),
        float(uo.get("geomPolyCount") or 0.0),
        float(bool(uo.get("isBuilding"))),
        float(bool(uo.get("isScenery"))),
        float(bool(uo.get("resolved"))),
    ]


def combined_tags(obj: dict) -> list[str]:
    out = []
    seen = set()
    for seq in (
        obj.get("enrichmentTags") or [],
        ((obj.get("semanticSummary") or {}).get("enrichmentTags") or []),
    ):
        for item in seq:
            token = normalized_token(item)
            if token == "<none>" or token in seen:
                continue
            seen.add(token)
            out.append(token)
            if len(out) >= MAX_TAG_ITEMS:
                return out
    return out


def prepare_arrays(rows: list[dict], train_idx: np.ndarray):
    support_cat_values = {name: [] for name, _ in SUPPORT_CATEGORY_SPECS}
    pos_cat_values = {name: [] for name, _ in OBJECT_CATEGORY_SPECS}
    neg_cat_values = {name: [] for name, _ in OBJECT_CATEGORY_SPECS}
    tag_values = []
    for row in rows:
        for name, path in SUPPORT_CATEGORY_SPECS:
            support_cat_values[name].append(normalized_token(nested_get(row, path)))
        for name, key in OBJECT_CATEGORY_SPECS:
            pos_cat_values[name].append(normalized_token(object_field(row.get("positiveObject") or {}, key)))
            neg_cat_values[name].append(normalized_token(object_field(row.get("negativeObject") or {}, key)))
        tag_values.extend(combined_tags(row.get("positiveObject") or {}))
        tag_values.extend(combined_tags(row.get("negativeObject") or {}))

    support_vocab_meta = {}
    support_cat_arrays = []
    for name, _ in SUPPORT_CATEGORY_SPECS:
        vals = support_cat_values[name]
        vocab, tokens = build_vocab([vals[i] for i in train_idx.tolist()], 1)
        support_cat_arrays.append(np.asarray([vocab.get(v, 0) for v in vals], dtype=np.int64))
        support_vocab_meta[name] = {"tokens": tokens}
    support_cat = np.stack(support_cat_arrays, axis=1)

    object_vocab_meta = {}
    pos_cat_arrays = []
    neg_cat_arrays = []
    for name, _ in OBJECT_CATEGORY_SPECS:
        vals = pos_cat_values[name] + neg_cat_values[name]
        train_vals = [pos_cat_values[name][i] for i in train_idx.tolist()] + [neg_cat_values[name][i] for i in train_idx.tolist()]
        vocab, tokens = build_vocab(train_vals, 1)
        pos_cat_arrays.append(np.asarray([vocab.get(v, 0) for v in pos_cat_values[name]], dtype=np.int64))
        neg_cat_arrays.append(np.asarray([vocab.get(v, 0) for v in neg_cat_values[name]], dtype=np.int64))
        object_vocab_meta[name] = {"tokens": tokens}
    pos_cat = np.stack(pos_cat_arrays, axis=1)
    neg_cat = np.stack(neg_cat_arrays, axis=1)

    tag_vocab, tag_tokens = build_vocab(tag_values, 1)
    tag_vocab_meta = {"tokens": tag_tokens}
    pos_tags = np.zeros((len(rows), MAX_TAG_ITEMS), dtype=np.int64)
    pos_tag_mask = np.zeros((len(rows), MAX_TAG_ITEMS), dtype=np.float32)
    neg_tags = np.zeros((len(rows), MAX_TAG_ITEMS), dtype=np.int64)
    neg_tag_mask = np.zeros((len(rows), MAX_TAG_ITEMS), dtype=np.float32)
    for i, row in enumerate(rows):
        for j, tag in enumerate(combined_tags(row.get("positiveObject") or {})):
            pos_tags[i, j] = tag_vocab.get(normalized_token(tag), 0)
            pos_tag_mask[i, j] = 1.0
        for j, tag in enumerate(combined_tags(row.get("negativeObject") or {})):
            neg_tags[i, j] = tag_vocab.get(normalized_token(tag), 0)
            neg_tag_mask[i, j] = 1.0

    support_num = np.asarray(
        [[
            float(((row.get("supportGeometry") or {}).get("halfExtentX", 0.0) or 0.0)),
            float(((row.get("supportGeometry") or {}).get("halfExtentY", 0.0) or 0.0)),
            float(((row.get("supportGeometry") or {}).get("halfExtentX", 0.0) or 0.0)) * float(((row.get("supportGeometry") or {}).get("halfExtentY", 0.0) or 0.0)) * 4.0,
            float((((row.get("cellGeometry") or {}).get("support") or {}).get("localX", 0.0) or 0.0)),
            float((((row.get("cellGeometry") or {}).get("support") or {}).get("localY", 0.0) or 0.0)),
            float((((row.get("cellGeometry") or {}).get("support") or {}).get("distWest", 0.0) or 0.0)),
            float((((row.get("cellGeometry") or {}).get("support") or {}).get("distEast", 0.0) or 0.0)),
            float((((row.get("cellGeometry") or {}).get("support") or {}).get("distSouth", 0.0) or 0.0)),
            float((((row.get("cellGeometry") or {}).get("support") or {}).get("distNorth", 0.0) or 0.0)),
            float(((row.get("roomContext") or {}).get("portalCountInCell", 0.0) or 0.0)),
            float(((row.get("roomContext") or {}).get("visibleCellCount", 0.0) or 0.0)),
            float(((row.get("roomContext") or {}).get("staticObjectCountInCell", 0.0) or 0.0)),
            float(((row.get("roomContext") or {}).get("staticObjectCountInComponent", 0.0) or 0.0)),
            float(((row.get("roomContext") or {}).get("cellCountInComponent", 0.0) or 0.0)),
            float(((row.get("arrangementSummary") or {}).get("positiveCount", 0.0) or 0.0)),
            float(((row.get("arrangementSummary") or {}).get("dxMean", 0.0) or 0.0)),
            float(((row.get("arrangementSummary") or {}).get("dyMean", 0.0) or 0.0)),
            float(((row.get("arrangementSummary") or {}).get("heightMean", 0.0) or 0.0)),
            float(bool((row.get("support") or {}).get("isHookPlacable"))),
            float(bool((row.get("support") or {}).get("preferredName"))),
            float((row.get("support") or {}).get("weenieType") is not None),
            float((row.get("support") or {}).get("weenieType") or 0.0),
            float((((row.get("support") or {}).get("unifiedOntology") or {}).get("geomMaxDimension") or 0.0)),
            float((((row.get("support") or {}).get("unifiedOntology") or {}).get("geomAspectRatio") or 0.0)),
            float((((row.get("support") or {}).get("unifiedOntology") or {}).get("geomPartCount") or 0.0)),
            float((((row.get("support") or {}).get("unifiedOntology") or {}).get("geomPolyCount") or 0.0)),
            float(bool(((row.get("support") or {}).get("unifiedOntology") or {}).get("isBuilding"))),
            float(bool(((row.get("support") or {}).get("unifiedOntology") or {}).get("isScenery"))),
            float(bool(((row.get("support") or {}).get("unifiedOntology") or {}).get("resolved"))),
        ] for row in rows],
        dtype=np.float32,
    )
    support_num_mean = support_num[train_idx].mean(axis=0)
    support_num_std = support_num[train_idx].std(axis=0)
    support_num_std = np.where(support_num_std < 1e-6, 1.0, support_num_std)
    support_num = (support_num - support_num_mean) / support_num_std

    pos_num = np.asarray([object_numeric(row.get("positiveObject") or {}) for row in rows], dtype=np.float32)
    neg_num = np.asarray([object_numeric(row.get("negativeObject") or {}) for row in rows], dtype=np.float32)
    object_num_train = np.concatenate([pos_num[train_idx], neg_num[train_idx]], axis=0)
    object_num_mean = object_num_train.mean(axis=0)
    object_num_std = object_num_train.std(axis=0)
    object_num_std = np.where(object_num_std < 1e-6, 1.0, object_num_std)
    pos_num = (pos_num - object_num_mean) / object_num_std
    neg_num = (neg_num - object_num_mean) / object_num_std

    weights = np.asarray(
        [
            max(float(row.get("positiveEvidenceWeight", 1.0)), 0.1) * max(float(row.get("negativeEvidenceWeight", 1.0)), 0.1)
            for row in rows
        ],
        dtype=np.float32,
    )

    # Object identity (objectKey) vocab — the model can memorise specific
    # IDs through this embedding when they help, but id-dropout in the
    # PairRanker forces it to fall back on ontology features for the
    # randomly nulled rows so unseen IDs at val time still have signal.
    pos_id_values = [str((row.get("positiveObject") or {}).get("objectKey") or "<unk>") for row in rows]
    neg_id_values = [str((row.get("negativeObject") or {}).get("objectKey") or "<unk>") for row in rows]
    train_id_values = [pos_id_values[i] for i in train_idx.tolist()] + [neg_id_values[i] for i in train_idx.tolist()]
    object_id_vocab, object_id_tokens = build_vocab(train_id_values, 1)
    pos_object_id = np.asarray([object_id_vocab.get(v, 0) for v in pos_id_values], dtype=np.int64)
    neg_object_id = np.asarray([object_id_vocab.get(v, 0) for v in neg_id_values], dtype=np.int64)
    object_id_vocab_meta = {"tokens": object_id_tokens}

    return (
        support_cat,
        support_num,
        pos_cat,
        pos_num,
        pos_tags,
        pos_tag_mask,
        pos_object_id,
        neg_cat,
        neg_num,
        neg_tags,
        neg_tag_mask,
        neg_object_id,
        weights,
        support_vocab_meta,
        object_vocab_meta,
        tag_vocab_meta,
        object_id_vocab_meta,
        support_num_mean,
        support_num_std,
        object_num_mean,
        object_num_std,
    )


def pair_metrics(pos_scores: np.ndarray, neg_scores: np.ndarray) -> dict[str, float]:
    margins = pos_scores - neg_scores
    acc = float(np.mean(margins > 0.0))
    mean_margin = float(np.mean(margins))
    return {"pair_accuracy": acc, "mean_margin": mean_margin}


def main():
    parser = argparse.ArgumentParser(description="Train pairwise support/object ranker.")
    parser.add_argument("--dataset-jsonl", type=Path, default=DEFAULT_DATASET_JSONL)
    parser.add_argument("--epochs", type=int, default=Config.epochs)
    parser.add_argument("--batch", type=int, default=Config.batch_size)
    parser.add_argument("--lr", type=float, default=Config.lr)
    parser.add_argument("--weight-decay", type=float, default=Config.weight_decay)
    parser.add_argument("--hidden-dim", type=int, default=Config.hidden_dim)
    parser.add_argument("--depth", type=int, default=Config.depth)
    parser.add_argument("--dropout", type=float, default=Config.dropout)
    parser.add_argument("--val-split", type=float, default=Config.val_split)
    parser.add_argument("--split-mode", type=str, default="positive_object_key", choices=("landblock", "positive_object_key", "support_positive_pair"))
    parser.add_argument("--seed", type=int, default=Config.seed)
    parser.add_argument("--run-name", type=str, default="interior_object_pair_ranker")
    parser.add_argument("--patience", type=int, default=Config.patience,
                        help="Early-stop patience on val_pair_accuracy plateau (epochs).")
    parser.add_argument("--object-id-embed-dim", type=int, default=Config.object_id_embed_dim,
                        help="Embedding dim for the per-object identity (objectKey). 0 disables.")
    parser.add_argument("--object-id-dropout", type=float, default=Config.object_id_dropout,
                        help="Per-row dropout prob applied to the objectKey embedding during training. "
                             "Forces the model to fall back on ontology features for the dropped rows.")
    args = parser.parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)

    rows = load_rows(args.dataset_jsonl)
    split_key = {
        "landblock": "landblockId",
        "positive_object_key": "positiveObject.objectKey",
        "support_positive_pair": "supportKey",
    }[args.split_mode]
    if split_key == "positiveObject.objectKey":
        for row in rows:
            row["_split_key"] = str((row.get("positiveObject") or {}).get("objectKey") or "")
        actual_split_key = "_split_key"
    elif split_key == "supportKey":
        for row in rows:
            row["_split_key"] = f"{row.get('supportKey')}|{(row.get('positiveObject') or {}).get('objectKey')}"
        actual_split_key = "_split_key"
    else:
        actual_split_key = "landblockId"
    train_idx, val_idx = split_by_group(rows, actual_split_key, args.val_split, args.seed)

    (
        support_cat,
        support_num,
        pos_cat,
        pos_num,
        pos_tags,
        pos_tag_mask,
        pos_object_id,
        neg_cat,
        neg_num,
        neg_tags,
        neg_tag_mask,
        neg_object_id,
        weights,
        support_vocab_meta,
        object_vocab_meta,
        tag_vocab_meta,
        object_id_vocab_meta,
        support_num_mean,
        support_num_std,
        object_num_mean,
        object_num_std,
    ) = prepare_arrays(rows, train_idx)

    train_ds = PairDataset(support_cat, support_num, pos_cat, pos_num, pos_tags, pos_tag_mask, pos_object_id, neg_cat, neg_num, neg_tags, neg_tag_mask, neg_object_id, weights, train_idx)
    val_ds = PairDataset(support_cat, support_num, pos_cat, pos_num, pos_tags, pos_tag_mask, pos_object_id, neg_cat, neg_num, neg_tags, neg_tag_mask, neg_object_id, weights, val_idx)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if device.type == "cuda":
        torch.backends.cudnn.benchmark = True

    model = PairRanker(
        support_cardinalities=[len(support_vocab_meta[name]["tokens"]) for name, _ in SUPPORT_CATEGORY_SPECS],
        support_numeric_dim=len(SUPPORT_NUMERIC_KEYS),
        object_cardinalities=[len(object_vocab_meta[name]["tokens"]) for name, _ in OBJECT_CATEGORY_SPECS],
        object_numeric_dim=len(OBJECT_NUMERIC_KEYS),
        tag_vocab_size=len(tag_vocab_meta["tokens"]),
        object_id_vocab_size=len(object_id_vocab_meta["tokens"]),
        object_id_embed_dim=args.object_id_embed_dim,
        object_id_dropout=args.object_id_dropout,
        hidden_dim=args.hidden_dim,
        depth=args.depth,
        dropout=args.dropout,
    ).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)

    train_loader = DataLoader(train_ds, batch_size=args.batch, shuffle=True, num_workers=0, pin_memory=True)
    val_loader = DataLoader(val_ds, batch_size=args.batch, shuffle=False, num_workers=0, pin_memory=True)

    run_dir = MODEL_DIR / args.run_name
    run_dir.mkdir(parents=True, exist_ok=True)
    best_path = run_dir / "best.pt"
    meta_path = run_dir / "meta.json"

    print("=" * 72)
    print("  Interior Object Pair Ranker Training")
    print("=" * 72)
    print(f"  Dataset: {args.dataset_jsonl}")
    print(f"  Rows: {len(rows):,}  Train: {len(train_ds):,}  Val: {len(val_ds):,}")
    print(f"  Split mode: {args.split_mode}")
    print(f"  Device: {device}")
    if device.type == "cuda":
        print(f"  GPU: {torch.cuda.get_device_name()}")
    print(f"  Run dir: {run_dir}")

    best_val = float("inf")
    best_acc = 0.0
    best_state = None
    history = []
    epochs_since_acc_improve = 0

    for epoch in range(args.epochs):
        model.train()
        train_loss_sum = 0.0
        train_batches = 0
        for batch in train_loader:
            batch = [item.to(device) for item in batch]
            (support_cat_b, support_num_b,
             pos_cat_b, pos_num_b, pos_tags_b, pos_tag_mask_b, pos_object_id_b,
             neg_cat_b, neg_num_b, neg_tags_b, neg_tag_mask_b, neg_object_id_b,
             weights_b) = batch
            pos_score, neg_score = model(support_cat_b, support_num_b,
                                          pos_cat_b, pos_num_b, pos_tags_b, pos_tag_mask_b, pos_object_id_b,
                                          neg_cat_b, neg_num_b, neg_tags_b, neg_tag_mask_b, neg_object_id_b)
            loss_vec = F.softplus(-(pos_score - neg_score))
            loss = (loss_vec * weights_b).sum() / weights_b.sum().clamp_min(1e-6)
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            optimizer.step()
            train_loss_sum += float(loss.item())
            train_batches += 1

        model.eval()
        val_loss_sum = 0.0
        val_batches = 0
        pos_chunks = []
        neg_chunks = []
        with torch.no_grad():
            for batch in val_loader:
                batch = [item.to(device) for item in batch]
                (support_cat_b, support_num_b,
                 pos_cat_b, pos_num_b, pos_tags_b, pos_tag_mask_b, pos_object_id_b,
                 neg_cat_b, neg_num_b, neg_tags_b, neg_tag_mask_b, neg_object_id_b,
                 weights_b) = batch
                pos_score, neg_score = model(support_cat_b, support_num_b,
                                              pos_cat_b, pos_num_b, pos_tags_b, pos_tag_mask_b, pos_object_id_b,
                                              neg_cat_b, neg_num_b, neg_tags_b, neg_tag_mask_b, neg_object_id_b)
                loss_vec = F.softplus(-(pos_score - neg_score))
                loss = (loss_vec * weights_b).sum() / weights_b.sum().clamp_min(1e-6)
                val_loss_sum += float(loss.item())
                val_batches += 1
                pos_chunks.append(pos_score.cpu().numpy())
                neg_chunks.append(neg_score.cpu().numpy())

        avg_train = train_loss_sum / max(train_batches, 1)
        avg_val = val_loss_sum / max(val_batches, 1)
        metrics = pair_metrics(np.concatenate(pos_chunks, axis=0), np.concatenate(neg_chunks, axis=0))
        history_row = {"epoch": epoch + 1, "train_loss": avg_train, "val_loss": avg_val, **metrics}
        history.append(history_row)

        improved_acc = metrics["pair_accuracy"] > best_acc + 1e-4
        improved_loss = avg_val < best_val
        if improved_acc:
            best_acc = metrics["pair_accuracy"]
            epochs_since_acc_improve = 0
        else:
            epochs_since_acc_improve += 1

        if improved_loss:
            best_val = avg_val
            best_state = {
                "model_state_dict": model.state_dict(),
                "config": vars(args),
                "support_category_specs": [name for name, _ in SUPPORT_CATEGORY_SPECS],
                "object_category_specs": [name for name, _ in OBJECT_CATEGORY_SPECS],
                "support_numeric_feature_keys": list(SUPPORT_NUMERIC_KEYS),
                "object_numeric_feature_keys": list(OBJECT_NUMERIC_KEYS),
                "support_vocab_meta": support_vocab_meta,
                "object_vocab_meta": object_vocab_meta,
                "tag_vocab_meta": tag_vocab_meta,
                "object_id_vocab_meta": object_id_vocab_meta,
                "support_num_mean": support_num_mean.tolist(),
                "support_num_std": support_num_std.tolist(),
                "object_num_mean": object_num_mean.tolist(),
                "object_num_std": object_num_std.tolist(),
                "best_val_loss": best_val,
                "best_pair_accuracy": best_acc,
                "history": history,
            }

        print(
            f"  Epoch {epoch + 1:3d}/{args.epochs} train={avg_train:.4f} val={avg_val:.4f} "
            f"pair_acc={metrics['pair_accuracy']:.4f} mean_margin={metrics['mean_margin']:.4f}"
            f"  best_acc={best_acc:.4f} stale={epochs_since_acc_improve}"
        )

        if epochs_since_acc_improve >= args.patience:
            print(f"  Early stop: no pair_accuracy improvement in {args.patience} epochs (best={best_acc:.4f}).")
            break

    if best_state is None:
        raise RuntimeError("Training produced no checkpoint state.")
    torch.save(best_state, best_path)
    meta = {
        "dataset_jsonl": str(args.dataset_jsonl),
        "run_name": args.run_name,
        "rows": len(rows),
        "train_rows": len(train_ds),
        "val_rows": len(val_ds),
        "device": str(device),
        "best_val_loss": best_val,
        "best_pair_accuracy": best_acc,
        "epochs_run": len(history),
        "early_stopped": len(history) < args.epochs,
        "object_id_vocab_size": len(object_id_vocab_meta["tokens"]),
        "object_id_dropout": args.object_id_dropout,
        "object_id_embed_dim": args.object_id_embed_dim,
        "history_tail": history[-10:],
    }
    with meta_path.open("w", encoding="utf-8") as handle:
        json.dump(meta, handle, indent=2)

    print(f"\nSaved checkpoint: {best_path}")
    print(f"Saved metadata:   {meta_path}")
    print(f"Best val loss:    {best_val:.4f}")


if __name__ == "__main__":
    main()

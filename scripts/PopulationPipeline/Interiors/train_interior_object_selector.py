#!/usr/bin/env python3
"""
Train a grounded support/object compatibility selector.

This stage answers a simpler question than micro-placement:
"Does this object identity belong on this support in this room context?"
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
    from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler
except ImportError:
    print("ERROR: PyTorch not found.")
    sys.exit(1)


ROOT = Path(__file__).resolve().parents[3]
REFERENCE_DIR = ROOT / "pipeline_data" / "reference"
MODEL_DIR = ROOT / "pipeline_data" / "models" / "interiors"
DEFAULT_DATASET_JSONL = REFERENCE_DIR / "fullworld_interior_support_object_selection_v1.jsonl"

CATEGORY_SPECS = (
    ("object_class_space", ("object", "classIdSpace")),
    ("object_prop_class", ("object", "propClass")),
    ("object_source_kind", ("object", "sourceKind")),
    ("object_hook_type", ("object", "lsdHookType")),
    ("object_grounding_conf", ("object", "groundingConfidence")),
    ("object_enrichment_type", ("object", "enrichmentType")),
    ("object_sem_signature", ("object", "semanticSummary", "signatureKey")),
    ("object_sem_prop_class", ("object", "semanticSummary", "dominantPropClass")),
    ("object_sem_source_kind", ("object", "semanticSummary", "dominantSourceKind")),
    ("object_sem_enrichment_type", ("object", "semanticSummary", "dominantEnrichmentType")),
    ("object_sem_grounding_conf", ("object", "semanticSummary", "dominantGroundingConfidence")),
    ("support_class_space", ("support", "classIdSpace")),
    ("support_class", ("support", "supportClass")),
    ("support_source_kind", ("support", "sourceKind")),
    ("support_hook_type", ("support", "lsdHookType")),
    ("support_grounding_conf", ("support", "groundingConfidence")),
    ("support_sem_source_kind", ("support", "semanticSummary", "dominantSourceKind")),
    ("support_sem_enrichment_type", ("support", "semanticSummary", "dominantEnrichmentType")),
    ("support_sem_grounding_conf", ("support", "semanticSummary", "dominantGroundingConfidence")),
)

NUMERIC_FEATURE_KEYS = (
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
    "objectIsHookPlacable",
    "candidateEvidenceWeight",
    "objectHasGroundedName",
    "objectHasWeenieType",
    "objectWeenieType",
    "objectSemHasLsdHookType151",
    "objectSemHasGroundingRow",
    "objectSemHasEnrichment",
    "objectSemDominantWeenieType",
    "objectSemDominantLsdHookType",
    "objectSemLsdItemType1",
    "objectSemLsdUseability16",
    "objectSemLsdTargetType94",
    "objectSemLsdSetupDid1",
    "objectSemLsdIconDid8",
    "supportHasGroundedName",
    "supportHasWeenieType",
    "supportWeenieType",
    "supportSemHasLsdHookType151",
    "supportSemHasGroundingRow",
    "supportSemHasEnrichment",
    "supportSemDominantWeenieType",
    "supportSemDominantLsdHookType",
    "supportSemLsdItemType1",
    "supportSemLsdUseability16",
    "supportSemLsdTargetType94",
    "supportSemLsdSetupDid1",
    "supportSemLsdIconDid8",
)

CONTEXT_CATEGORY_SPECS = (
    ("ctx_prop_class", "propClass"),
    ("ctx_source_kind", "sourceKind"),
    ("ctx_name", "preferredName"),
    ("ctx_grounding_conf", "groundingConfidence"),
    ("ctx_sem_signature", "semanticSummary.signatureKey"),
    ("ctx_sem_prop_class", "semanticSummary.dominantPropClass"),
)

CONTEXT_NUMERIC_KEYS = (
    "evidenceWeight",
    "hasGroundedName",
    "hasWeenieType",
    "semHasLsdHookType151",
    "semLsdItemType1",
    "semLsdUseability16",
)

MAX_CONTEXT_ITEMS = 10
MAX_TAG_ITEMS = 12

TAG_CATEGORY_SPECS = (
    ("object_tag", ("object", "enrichmentTags")),
    ("support_tag", ("support", "enrichmentTags")),
)


@dataclass
class Config:
    epochs: int = 120
    batch_size: int = 256
    lr: float = 3e-4
    weight_decay: float = 1e-2
    hidden_dim: int = 256
    depth: int = 3
    dropout: float = 0.15
    val_split: float = 0.15
    min_name_freq: int = 2
    seed: int = 42


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


def item_field(item: dict, key: str):
    if "." not in key:
        return item.get(key)
    cursor = item
    for part in key.split("."):
        if not isinstance(cursor, dict):
            return None
        cursor = cursor.get(part)
    return cursor


def combined_tags(item: dict) -> list[str]:
    out = []
    seen = set()
    for seq in (
        item.get("enrichmentTags") or [],
        ((item.get("semanticSummary") or {}).get("enrichmentTags") or []),
    ):
        for raw in seq:
            token = normalized_token(raw)
            if token == "<none>" or token in seen:
                continue
            seen.add(token)
            out.append(raw)
            if len(out) >= MAX_TAG_ITEMS:
                return out
    return out


def build_vocab(values: list[str], min_freq: int = 1) -> tuple[dict[str, int], list[str]]:
    counts = Counter(values)
    tokens = ["<unk>"]
    for token, count in sorted(counts.items()):
        if token == "<unk>":
            continue
        if count >= min_freq:
            tokens.append(token)
    vocab = {token: idx for idx, token in enumerate(tokens)}
    return vocab, tokens


def flatten_rows(path: Path) -> list[dict]:
    rows = []
    for support_row in iter_jsonl(path):
        support = support_row.get("support") or {}
        support_sem = support.get("semanticSummary") or {}
        support_geom = support_row.get("supportGeometry") or {}
        support_cell = ((support_row.get("cellGeometry") or {}).get("support") or {})
        room = support_row.get("roomContext") or {}
        summary = support_row.get("arrangementSummary") or {}
        positives = support_row.get("positiveObjects") or []
        negatives = support_row.get("negativeObjects") or []
        positive_context = [candidate.get("object") or {} for candidate in positives]
        for collection in (positives, negatives):
            for candidate in collection:
                obj = candidate.get("object") or {}
                obj_sem = obj.get("semanticSummary") or {}
                context_items = [item for item in positive_context if item.get("objectKey") != obj.get("objectKey")][:MAX_CONTEXT_ITEMS]
                rows.append(
                    {
                        "landblockId": support_row.get("landblockId"),
                        "sceneId": support_row.get("sceneId"),
                        "supportKey": support_row.get("supportKey"),
                        "objectKey": obj.get("objectKey"),
                        "supportObjectPairKey": f"{support.get('objectKey')}|{obj.get('objectKey')}",
                        "support": support,
                        "object": obj,
                        "candidateReason": candidate.get("candidateReason"),
                        "labelTier": candidate.get("labelTier"),
                        "label": int(candidate.get("label", 0)),
                        "candidateEvidenceWeight": float(candidate.get("evidenceWeight", 1.0)),
                        "numeric": {
                            "supportHalfExtentX": float(support_geom.get("halfExtentX", 0.0) or 0.0),
                            "supportHalfExtentY": float(support_geom.get("halfExtentY", 0.0) or 0.0),
                            "supportArea": float(support_geom.get("halfExtentX", 0.0) or 0.0) * float(support_geom.get("halfExtentY", 0.0) or 0.0) * 4.0,
                            "supportCellLocalX": float(support_cell.get("localX", 0.0) or 0.0),
                            "supportCellLocalY": float(support_cell.get("localY", 0.0) or 0.0),
                            "supportDistWest": float(support_cell.get("distWest", 0.0) or 0.0),
                            "supportDistEast": float(support_cell.get("distEast", 0.0) or 0.0),
                            "supportDistSouth": float(support_cell.get("distSouth", 0.0) or 0.0),
                            "supportDistNorth": float(support_cell.get("distNorth", 0.0) or 0.0),
                            "portalCountInCell": float(room.get("portalCountInCell", 0.0) or 0.0),
                            "visibleCellCount": float(room.get("visibleCellCount", 0.0) or 0.0),
                            "staticObjectCountInCell": float(room.get("staticObjectCountInCell", 0.0) or 0.0),
                            "staticObjectCountInComponent": float(room.get("staticObjectCountInComponent", 0.0) or 0.0),
                            "cellCountInComponent": float(room.get("cellCountInComponent", 0.0) or 0.0),
                            "positiveCount": float(summary.get("positiveCount", 0.0) or 0.0),
                            "positiveDxMean": float(summary.get("dxMean", 0.0) or 0.0),
                            "positiveDyMean": float(summary.get("dyMean", 0.0) or 0.0),
                            "positiveHeightMean": float(summary.get("heightMean", 0.0) or 0.0),
                            "supportIsHookPlacable": float(bool(support.get("isHookPlacable"))),
                            "objectIsHookPlacable": float(bool(obj.get("isHookPlacable"))),
                            "candidateEvidenceWeight": float(candidate.get("evidenceWeight", 1.0)),
                            "objectHasGroundedName": float(bool(obj.get("preferredName"))),
                            "objectHasWeenieType": float(obj.get("weenieType") is not None),
                            "objectWeenieType": float(obj.get("weenieType") or 0.0),
                            "objectSemHasLsdHookType151": float(bool(obj_sem.get("hasLsdHookType151"))),
                            "objectSemHasGroundingRow": float(bool(obj_sem.get("hasGroundingRow"))),
                            "objectSemHasEnrichment": float(bool(obj_sem.get("hasEnrichment"))),
                            "objectSemDominantWeenieType": float(obj_sem.get("dominantWeenieType") or 0.0),
                            "objectSemDominantLsdHookType": float(obj_sem.get("dominantLsdHookType") or 0.0),
                            "objectSemLsdItemType1": float(obj_sem.get("lsdItemType1") or 0.0),
                            "objectSemLsdUseability16": float(obj_sem.get("lsdUseability16") or 0.0),
                            "objectSemLsdTargetType94": float(obj_sem.get("lsdTargetType94") or 0.0),
                            "objectSemLsdSetupDid1": float(obj_sem.get("lsdSetupDid1") or 0.0),
                            "objectSemLsdIconDid8": float(obj_sem.get("lsdIconDid8") or 0.0),
                            "supportHasGroundedName": float(bool(support.get("preferredName"))),
                            "supportHasWeenieType": float(support.get("weenieType") is not None),
                            "supportWeenieType": float(support.get("weenieType") or 0.0),
                            "supportSemHasLsdHookType151": float(bool(support_sem.get("hasLsdHookType151"))),
                            "supportSemHasGroundingRow": float(bool(support_sem.get("hasGroundingRow"))),
                            "supportSemHasEnrichment": float(bool(support_sem.get("hasEnrichment"))),
                            "supportSemDominantWeenieType": float(support_sem.get("dominantWeenieType") or 0.0),
                            "supportSemDominantLsdHookType": float(support_sem.get("dominantLsdHookType") or 0.0),
                            "supportSemLsdItemType1": float(support_sem.get("lsdItemType1") or 0.0),
                            "supportSemLsdUseability16": float(support_sem.get("lsdUseability16") or 0.0),
                            "supportSemLsdTargetType94": float(support_sem.get("lsdTargetType94") or 0.0),
                            "supportSemLsdSetupDid1": float(support_sem.get("lsdSetupDid1") or 0.0),
                            "supportSemLsdIconDid8": float(support_sem.get("lsdIconDid8") or 0.0),
                        },
                        "positiveContext": context_items,
                    }
                )
    if not rows:
        raise RuntimeError(f"No rows found in {path}")
    return rows


def split_by_group(rows: list[dict], split_key: str, val_split: float, seed: int) -> tuple[np.ndarray, np.ndarray]:
    unique_groups = sorted({str(row.get(split_key) or "") for row in rows})
    rng = random.Random(seed)
    rng.shuffle(unique_groups)
    val_n = max(1, int(math.ceil(len(unique_groups) * val_split)))
    val_groups = set(unique_groups[:val_n])
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


class ObjectSelectorDataset(Dataset):
    def __init__(self, categorical, numeric, ctx_categorical, ctx_numeric, ctx_mask, object_tags, object_tag_mask, support_tags, support_tag_mask, labels, weights, indices):
        self.categorical = torch.from_numpy(categorical[indices]).long()
        self.numeric = torch.from_numpy(numeric[indices]).float()
        self.ctx_categorical = torch.from_numpy(ctx_categorical[indices]).long()
        self.ctx_numeric = torch.from_numpy(ctx_numeric[indices]).float()
        self.ctx_mask = torch.from_numpy(ctx_mask[indices]).float()
        self.object_tags = torch.from_numpy(object_tags[indices]).long()
        self.object_tag_mask = torch.from_numpy(object_tag_mask[indices]).float()
        self.support_tags = torch.from_numpy(support_tags[indices]).long()
        self.support_tag_mask = torch.from_numpy(support_tag_mask[indices]).float()
        self.labels = torch.from_numpy(labels[indices]).float()
        self.weights = torch.from_numpy(weights[indices]).float()

    def __len__(self):
        return len(self.categorical)

    def __getitem__(self, idx):
        return (
            self.categorical[idx],
            self.numeric[idx],
            self.ctx_categorical[idx],
            self.ctx_numeric[idx],
            self.ctx_mask[idx],
            self.object_tags[idx],
            self.object_tag_mask[idx],
            self.support_tags[idx],
            self.support_tag_mask[idx],
            self.labels[idx],
            self.weights[idx],
        )


class ObjectSelector(nn.Module):
    def __init__(self, cardinalities, numeric_dim, ctx_cardinalities, ctx_numeric_dim, tag_vocab_size, hidden_dim, depth, dropout):
        super().__init__()
        self.embeddings = nn.ModuleList()
        embed_dims = []
        for size in cardinalities:
            emb_dim = min(32, max(4, int(round(size ** 0.5 * 2.0))))
            self.embeddings.append(nn.Embedding(size, emb_dim))
            embed_dims.append(emb_dim)

        self.ctx_embeddings = nn.ModuleList()
        ctx_embed_dims = []
        for size in ctx_cardinalities:
            emb_dim = min(16, max(4, int(round(size ** 0.5 * 2.0))))
            self.ctx_embeddings.append(nn.Embedding(size, emb_dim))
            ctx_embed_dims.append(emb_dim)

        context_dim = max(64, hidden_dim // 2)
        ctx_item_dim = sum(ctx_embed_dims) + ctx_numeric_dim
        self.ctx_item_mlp = nn.Sequential(
            nn.Linear(ctx_item_dim, context_dim),
            nn.LayerNorm(context_dim),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(context_dim, context_dim),
            nn.GELU(),
        )

        tag_dim = min(32, max(8, int(round(tag_vocab_size ** 0.5))))
        self.tag_embedding = nn.Embedding(tag_vocab_size, tag_dim)

        input_dim = sum(embed_dims) + numeric_dim + context_dim * 2 + tag_dim * 2
        layers = [nn.Linear(input_dim, hidden_dim), nn.LayerNorm(hidden_dim), nn.GELU(), nn.Dropout(dropout)]
        for _ in range(max(depth - 1, 0)):
            layers.extend(
                [
                    nn.Linear(hidden_dim, hidden_dim),
                    nn.LayerNorm(hidden_dim),
                    nn.GELU(),
                    nn.Dropout(dropout),
                ]
            )
        self.backbone = nn.Sequential(*layers)
        self.head = nn.Linear(hidden_dim, 1)

    def pool_tags(self, tags, tag_mask):
        tag_hidden = self.tag_embedding(tags)
        mask = tag_mask.unsqueeze(-1)
        tag_sum = (tag_hidden * mask).sum(dim=1)
        tag_count = mask.sum(dim=1).clamp_min(1.0)
        return tag_sum / tag_count

    def forward(self, categorical, numeric, ctx_categorical, ctx_numeric, ctx_mask, object_tags, object_tag_mask, support_tags, support_tag_mask):
        pieces = [emb(categorical[:, idx]) for idx, emb in enumerate(self.embeddings)]
        ctx_pieces = [emb(ctx_categorical[:, :, idx]) for idx, emb in enumerate(self.ctx_embeddings)]
        ctx_pieces.append(ctx_numeric)
        ctx_items = torch.cat(ctx_pieces, dim=-1)
        ctx_hidden = self.ctx_item_mlp(ctx_items)
        ctx_mask_exp = ctx_mask.unsqueeze(-1)
        ctx_sum = (ctx_hidden * ctx_mask_exp).sum(dim=1)
        ctx_count = ctx_mask_exp.sum(dim=1).clamp_min(1.0)
        ctx_mean = ctx_sum / ctx_count
        ctx_max = ctx_hidden.masked_fill(ctx_mask_exp == 0, -1e9).amax(dim=1)
        ctx_max = torch.where(ctx_mask_exp.sum(dim=1) > 0, ctx_max, torch.zeros_like(ctx_max))
        object_tag_vec = self.pool_tags(object_tags, object_tag_mask)
        support_tag_vec = self.pool_tags(support_tags, support_tag_mask)
        pieces.extend([numeric, ctx_mean, ctx_max, object_tag_vec, support_tag_vec])
        hidden = self.backbone(torch.cat(pieces, dim=-1))
        return self.head(hidden).squeeze(-1)


def prepare_arrays(rows: list[dict], train_idx: np.ndarray, min_name_freq: int):
    categorical_values = {name: [] for name, _ in CATEGORY_SPECS}
    for row in rows:
        for spec_name, spec_path in CATEGORY_SPECS:
            categorical_values[spec_name].append(normalized_token(nested_get(row, spec_path)))

    vocab_meta = {}
    categorical_arrays = []
    for spec_name, _ in CATEGORY_SPECS:
        values = categorical_values[spec_name]
        train_values = [values[i] for i in train_idx.tolist()]
        vocab, tokens = build_vocab(train_values, min_freq=1)
        categorical_arrays.append(np.asarray([vocab.get(value, 0) for value in values], dtype=np.int64))
        vocab_meta[spec_name] = {"tokens": tokens}
    categorical = np.stack(categorical_arrays, axis=1)

    ctx_values = {name: [] for name, _ in CONTEXT_CATEGORY_SPECS}
    ctx_items_per_row = []
    for row in rows:
        items = (row.get("positiveContext") or [])[:MAX_CONTEXT_ITEMS]
        ctx_items_per_row.append(items)
        for spec_name, item_key in CONTEXT_CATEGORY_SPECS:
            ctx_values[spec_name].extend(normalized_token(item_field(item, item_key)) for item in items)

    ctx_vocab_meta = {}
    ctx_vocabs = {}
    for spec_name, _ in CONTEXT_CATEGORY_SPECS:
        vocab, tokens = build_vocab(ctx_values[spec_name], min_freq=1)
        ctx_vocabs[spec_name] = vocab
        ctx_vocab_meta[spec_name] = {"tokens": tokens}

    numeric = np.asarray(
        [[float((row.get("numeric") or {}).get(key, 0.0)) for key in NUMERIC_FEATURE_KEYS] for row in rows],
        dtype=np.float32,
    )
    numeric_mean = numeric[train_idx].mean(axis=0)
    numeric_std = numeric[train_idx].std(axis=0)
    numeric_std = np.where(numeric_std < 1e-6, 1.0, numeric_std)
    numeric = (numeric - numeric_mean) / numeric_std

    ctx_categorical = np.zeros((len(rows), MAX_CONTEXT_ITEMS, len(CONTEXT_CATEGORY_SPECS)), dtype=np.int64)
    ctx_numeric = np.zeros((len(rows), MAX_CONTEXT_ITEMS, len(CONTEXT_NUMERIC_KEYS)), dtype=np.float32)
    ctx_mask = np.zeros((len(rows), MAX_CONTEXT_ITEMS), dtype=np.float32)
    for row_idx, items in enumerate(ctx_items_per_row):
        for item_idx, item in enumerate(items[:MAX_CONTEXT_ITEMS]):
            ctx_mask[row_idx, item_idx] = 1.0
            for cat_idx, (spec_name, item_key) in enumerate(CONTEXT_CATEGORY_SPECS):
                ctx_categorical[row_idx, item_idx, cat_idx] = ctx_vocabs[spec_name].get(normalized_token(item_field(item, item_key)), 0)
            ctx_numeric[row_idx, item_idx] = np.asarray(
                [
                    float((row.get("candidateEvidenceWeight", 1.0)) if False else item.get("evidenceWeight", 1.0)),
                    float(bool(item.get("preferredName"))),
                    float(item.get("weenieType") is not None),
                    float(bool((item.get("semanticSummary") or {}).get("hasLsdHookType151"))),
                    float(((item.get("semanticSummary") or {}).get("lsdItemType1") or 0.0)),
                    float(((item.get("semanticSummary") or {}).get("lsdUseability16") or 0.0)),
                ],
                dtype=np.float32,
            )
    ctx_numeric_mean = ctx_numeric[train_idx].reshape(-1, len(CONTEXT_NUMERIC_KEYS)).mean(axis=0)
    ctx_numeric_std = ctx_numeric[train_idx].reshape(-1, len(CONTEXT_NUMERIC_KEYS)).std(axis=0)
    ctx_numeric_std = np.where(ctx_numeric_std < 1e-6, 1.0, ctx_numeric_std)
    ctx_numeric = (ctx_numeric - ctx_numeric_mean) / ctx_numeric_std
    ctx_numeric *= ctx_mask[..., None]

    tag_values = []
    object_tag_lists = []
    support_tag_lists = []
    for row in rows:
        obj_tags = combined_tags(row.get("object") or {})
        sup_tags = combined_tags(row.get("support") or {})
        object_tag_lists.append(obj_tags)
        support_tag_lists.append(sup_tags)
        tag_values.extend(normalized_token(tag) for tag in obj_tags)
        tag_values.extend(normalized_token(tag) for tag in sup_tags)
    tag_vocab, tag_tokens = build_vocab(tag_values, min_freq=1)
    tag_vocab_meta = {"tokens": tag_tokens}
    object_tags = np.zeros((len(rows), MAX_TAG_ITEMS), dtype=np.int64)
    object_tag_mask = np.zeros((len(rows), MAX_TAG_ITEMS), dtype=np.float32)
    support_tags = np.zeros((len(rows), MAX_TAG_ITEMS), dtype=np.int64)
    support_tag_mask = np.zeros((len(rows), MAX_TAG_ITEMS), dtype=np.float32)
    for row_idx, tags in enumerate(object_tag_lists):
        for item_idx, tag in enumerate(tags[:MAX_TAG_ITEMS]):
            object_tag_mask[row_idx, item_idx] = 1.0
            object_tags[row_idx, item_idx] = tag_vocab.get(normalized_token(tag), 0)
    for row_idx, tags in enumerate(support_tag_lists):
        for item_idx, tag in enumerate(tags[:MAX_TAG_ITEMS]):
            support_tag_mask[row_idx, item_idx] = 1.0
            support_tags[row_idx, item_idx] = tag_vocab.get(normalized_token(tag), 0)

    labels = np.asarray([float(row.get("label", 0.0)) for row in rows], dtype=np.float32)
    weights = np.asarray(
        [
            float((row.get("numeric") or {}).get("candidateEvidenceWeight", 1.0)) * (1.25 if float(row.get("label", 0.0)) > 0.5 else 1.0)
            for row in rows
        ],
        dtype=np.float32,
    )
    return (
        categorical,
        numeric,
        ctx_categorical,
        ctx_numeric,
        ctx_mask,
        object_tags,
        object_tag_mask,
        support_tags,
        support_tag_mask,
        labels,
        weights,
        vocab_meta,
        ctx_vocab_meta,
        tag_vocab_meta,
        numeric_mean,
        numeric_std,
        ctx_numeric_mean,
        ctx_numeric_std,
    )


def binary_metrics(logits: np.ndarray, labels: np.ndarray) -> dict[str, float]:
    probs = 1.0 / (1.0 + np.exp(-logits))
    pred = (probs >= 0.5).astype(np.float32)
    acc = float(np.mean(pred == labels))
    tp = float(np.sum((pred == 1) & (labels == 1)))
    fp = float(np.sum((pred == 1) & (labels == 0)))
    fn = float(np.sum((pred == 0) & (labels == 1)))
    precision = tp / max(tp + fp, 1.0)
    recall = tp / max(tp + fn, 1.0)
    return {"accuracy": acc, "precision": precision, "recall": recall}


def main():
    parser = argparse.ArgumentParser(description="Train interior support/object selector.")
    parser.add_argument("--dataset-jsonl", type=Path, default=DEFAULT_DATASET_JSONL)
    parser.add_argument("--epochs", type=int, default=Config.epochs)
    parser.add_argument("--batch", type=int, default=Config.batch_size)
    parser.add_argument("--lr", type=float, default=Config.lr)
    parser.add_argument("--weight-decay", type=float, default=Config.weight_decay)
    parser.add_argument("--hidden-dim", type=int, default=Config.hidden_dim)
    parser.add_argument("--depth", type=int, default=Config.depth)
    parser.add_argument("--dropout", type=float, default=Config.dropout)
    parser.add_argument("--val-split", type=float, default=Config.val_split)
    parser.add_argument(
        "--split-mode",
        type=str,
        default="support_object_pair",
        choices=("landblock", "object_key", "support_object_pair"),
    )
    parser.add_argument("--min-name-freq", type=int, default=Config.min_name_freq)
    parser.add_argument("--seed", type=int, default=Config.seed)
    parser.add_argument("--run-name", type=str, default="interior_object_selector")
    args = parser.parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)

    rows = flatten_rows(args.dataset_jsonl)
    split_key = {
        "landblock": "landblockId",
        "object_key": "objectKey",
        "support_object_pair": "supportObjectPairKey",
    }[args.split_mode]
    train_idx, val_idx = split_by_group(rows, split_key, args.val_split, args.seed)
    (
        categorical,
        numeric,
        ctx_categorical,
        ctx_numeric,
        ctx_mask,
        object_tags,
        object_tag_mask,
        support_tags,
        support_tag_mask,
        labels,
        weights,
        vocab_meta,
        ctx_vocab_meta,
        tag_vocab_meta,
        numeric_mean,
        numeric_std,
        ctx_numeric_mean,
        ctx_numeric_std,
    ) = prepare_arrays(rows, train_idx, args.min_name_freq)

    train_ds = ObjectSelectorDataset(categorical, numeric, ctx_categorical, ctx_numeric, ctx_mask, object_tags, object_tag_mask, support_tags, support_tag_mask, labels, weights, train_idx)
    val_ds = ObjectSelectorDataset(categorical, numeric, ctx_categorical, ctx_numeric, ctx_mask, object_tags, object_tag_mask, support_tags, support_tag_mask, labels, weights, val_idx)

    sample_weights = np.asarray([weights[i] for i in train_idx], dtype=np.float64)
    sample_weights = np.clip(sample_weights, 1e-3, None)
    sampler = WeightedRandomSampler(torch.from_numpy(sample_weights), num_samples=len(sample_weights), replacement=True)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if device.type == "cuda":
        torch.backends.cudnn.benchmark = True

    model = ObjectSelector(
        cardinalities=[len(vocab_meta[name]["tokens"]) for name, _ in CATEGORY_SPECS],
        numeric_dim=len(NUMERIC_FEATURE_KEYS),
        ctx_cardinalities=[len(ctx_vocab_meta[name]["tokens"]) for name, _ in CONTEXT_CATEGORY_SPECS],
        ctx_numeric_dim=len(CONTEXT_NUMERIC_KEYS),
        tag_vocab_size=len(tag_vocab_meta["tokens"]),
        hidden_dim=args.hidden_dim,
        depth=args.depth,
        dropout=args.dropout,
    ).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)

    train_loader = DataLoader(train_ds, batch_size=args.batch, sampler=sampler, num_workers=0, pin_memory=True)
    val_loader = DataLoader(val_ds, batch_size=args.batch, shuffle=False, num_workers=0, pin_memory=True)

    run_dir = MODEL_DIR / args.run_name
    run_dir.mkdir(parents=True, exist_ok=True)
    best_path = run_dir / "best.pt"
    meta_path = run_dir / "meta.json"

    print("=" * 72)
    print("  Interior Object Selector Training")
    print("=" * 72)
    print(f"  Dataset: {args.dataset_jsonl}")
    print(f"  Rows: {len(rows):,}  Train: {len(train_ds):,}  Val: {len(val_ds):,}")
    print(f"  Split mode: {args.split_mode}")
    print(f"  Device: {device}")
    if device.type == "cuda":
        print(f"  GPU: {torch.cuda.get_device_name()}")
    print(f"  Run dir: {run_dir}")

    best_val = float("inf")
    best_state = None
    history = []

    for epoch in range(args.epochs):
        model.train()
        train_loss_sum = 0.0
        train_batches = 0
        for cat, num, ctx_cat, ctx_num, ctx_mask_batch, object_tags_batch, object_tag_mask_batch, support_tags_batch, support_tag_mask_batch, labels_batch, weights_batch in train_loader:
            cat = cat.to(device)
            num = num.to(device)
            ctx_cat = ctx_cat.to(device)
            ctx_num = ctx_num.to(device)
            ctx_mask_batch = ctx_mask_batch.to(device)
            object_tags_batch = object_tags_batch.to(device)
            object_tag_mask_batch = object_tag_mask_batch.to(device)
            support_tags_batch = support_tags_batch.to(device)
            support_tag_mask_batch = support_tag_mask_batch.to(device)
            labels_batch = labels_batch.to(device)
            weights_batch = weights_batch.to(device)

            logits = model(cat, num, ctx_cat, ctx_num, ctx_mask_batch, object_tags_batch, object_tag_mask_batch, support_tags_batch, support_tag_mask_batch)
            loss_vec = F.binary_cross_entropy_with_logits(logits, labels_batch, reduction="none")
            loss = (loss_vec * weights_batch).sum() / weights_batch.sum().clamp_min(1e-6)

            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            optimizer.step()
            train_loss_sum += float(loss.item())
            train_batches += 1

        model.eval()
        val_loss_sum = 0.0
        val_batches = 0
        logit_chunks = []
        label_chunks = []
        with torch.no_grad():
            for cat, num, ctx_cat, ctx_num, ctx_mask_batch, object_tags_batch, object_tag_mask_batch, support_tags_batch, support_tag_mask_batch, labels_batch, weights_batch in val_loader:
                cat = cat.to(device)
                num = num.to(device)
                ctx_cat = ctx_cat.to(device)
                ctx_num = ctx_num.to(device)
                ctx_mask_batch = ctx_mask_batch.to(device)
                object_tags_batch = object_tags_batch.to(device)
                object_tag_mask_batch = object_tag_mask_batch.to(device)
                support_tags_batch = support_tags_batch.to(device)
                support_tag_mask_batch = support_tag_mask_batch.to(device)
                labels_batch = labels_batch.to(device)
                weights_batch = weights_batch.to(device)

                logits = model(cat, num, ctx_cat, ctx_num, ctx_mask_batch, object_tags_batch, object_tag_mask_batch, support_tags_batch, support_tag_mask_batch)
                loss_vec = F.binary_cross_entropy_with_logits(logits, labels_batch, reduction="none")
                loss = (loss_vec * weights_batch).sum() / weights_batch.sum().clamp_min(1e-6)
                val_loss_sum += float(loss.item())
                val_batches += 1
                logit_chunks.append(logits.cpu().numpy())
                label_chunks.append(labels_batch.cpu().numpy())

        avg_train = train_loss_sum / max(train_batches, 1)
        avg_val = val_loss_sum / max(val_batches, 1)
        metrics = binary_metrics(np.concatenate(logit_chunks, axis=0), np.concatenate(label_chunks, axis=0))
        history_row = {"epoch": epoch + 1, "train_loss": avg_train, "val_loss": avg_val, **metrics}
        history.append(history_row)

        if avg_val < best_val:
            best_val = avg_val
            best_state = {
                "model_state_dict": model.state_dict(),
                "config": vars(args),
                "category_specs": [name for name, _ in CATEGORY_SPECS],
                "numeric_feature_keys": list(NUMERIC_FEATURE_KEYS),
                "context_category_specs": [name for name, _ in CONTEXT_CATEGORY_SPECS],
                "context_numeric_feature_keys": list(CONTEXT_NUMERIC_KEYS),
                "vocab_meta": vocab_meta,
                "ctx_vocab_meta": ctx_vocab_meta,
                "tag_vocab_meta": tag_vocab_meta,
                "numeric_mean": numeric_mean.tolist(),
                "numeric_std": numeric_std.tolist(),
                "ctx_numeric_mean": ctx_numeric_mean.tolist(),
                "ctx_numeric_std": ctx_numeric_std.tolist(),
                "best_val_loss": best_val,
                "history": history,
            }

        print(
            f"  Epoch {epoch + 1:3d}/{args.epochs} "
            f"train={avg_train:.4f} val={avg_val:.4f} "
            f"acc={metrics['accuracy']:.4f} prec={metrics['precision']:.4f} rec={metrics['recall']:.4f}"
        )

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
        "history_tail": history[-10:],
    }
    with meta_path.open("w", encoding="utf-8") as handle:
        json.dump(meta, handle, indent=2)

    print(f"\nSaved checkpoint: {best_path}")
    print(f"Saved metadata:   {meta_path}")
    print(f"Best val loss:    {best_val:.4f}")


if __name__ == "__main__":
    main()

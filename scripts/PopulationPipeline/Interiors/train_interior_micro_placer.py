#!/usr/bin/env python3
"""
Train a first-pass interior micro-placement model from weighted support-relative labels.

This path is intentionally narrower than the outdoor scene placer:
given a prop/support pair plus compact room context, predict the support-relative
placement target for the prop.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import time
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

DEFAULT_DATASET_JSONL = (
    REFERENCE_DIR / "fullworld_interior_microplacement_training_hq_no_xarabydun.jsonl"
)

NUMERIC_FEATURE_KEYS = (
    "portalCountInCell",
    "visibleCellCount",
    "staticObjectCountInCell",
    "staticObjectCountInComponent",
    "cellCountInComponent",
    "horizontalDistance",
    "competingParentCount",
    "hasSurfaceHint",
    "withinSurfaceFootprint",
    "surfaceFootprintOverflow",
    "evidenceWeight",
    "supportAnchorLocalX",
    "supportAnchorLocalY",
    "supportAnchorLocalZ",
    "propPositionLocalX",
    "propPositionLocalY",
    "propPositionLocalZ",
    "supportSiblingCount",
    "propCellLocalX",
    "propCellLocalY",
    "propDistWest",
    "propDistEast",
    "propDistSouth",
    "propDistNorth",
    "propNearestCornerDistance",
    "propCenterOffsetX",
    "propCenterOffsetY",
    "supportCellLocalX",
    "supportCellLocalY",
    "supportDistWest",
    "supportDistEast",
    "supportDistSouth",
    "supportDistNorth",
    "supportNearestCornerDistance",
    "supportCenterOffsetX",
    "supportCenterOffsetY",
    "supportHalfExtentX",
    "supportHalfExtentY",
    "supportNormalizedDx",
    "supportNormalizedDy",
    "supportEdgeWest",
    "supportEdgeEast",
    "supportEdgeSouth",
    "supportEdgeNorth",
    "supportMatchDistance",
    "nearbySupportCount",
    "propIsHookPlacable",
    "supportIsHookPlacable",
)

CATEGORY_SPECS = (
    ("prop_class", ("prop", "propClass")),
    ("support_class", ("support", "supportClass")),
    ("prop_name", ("prop", "name")),
    ("support_name", ("support", "name")),
    ("prop_inference", ("prop", "propInferenceMode")),
    ("support_inference", ("support", "supportInferenceMode")),
    ("prop_source_kind", ("prop", "sourceKind")),
    ("support_source_kind", ("support", "sourceKind")),
    ("prop_hook_type", ("prop", "lsdHookType")),
    ("support_hook_type", ("support", "lsdHookType")),
    ("component_kind", ("componentKind",)),
    ("label_tier", ("labelTier",)),
)

SIBLING_CATEGORY_SPECS = (
    ("sibling_prop_class", "propClass"),
    ("sibling_source_kind", "sourceKind"),
    ("sibling_label_tier", "labelTier"),
)

SIBLING_NUMERIC_KEYS = (
    "dx",
    "dy",
    "heightAboveSupportPlane",
    "horizontalDistance",
    "yawSin",
    "yawCos",
    "evidenceWeight",
)

MAX_SIBLING_CONTEXT_ITEMS = 8
MAX_NEARBY_SUPPORT_ITEMS = 4

NEARBY_SUPPORT_CATEGORY_SPECS = (
    ("nearby_support_class", "supportClass"),
)

NEARBY_SUPPORT_NUMERIC_KEYS = (
    "dx",
    "dy",
    "distance",
)


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
    min_name_freq: int = 2
    max_train_batches: int | None = None
    max_val_batches: int | None = None
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


def split_by_landblock(rows: list[dict], val_split: float, seed: int) -> tuple[np.ndarray, np.ndarray]:
    unique_landblocks = sorted({str(row.get("landblockId") or "") for row in rows})
    rng = random.Random(seed)
    rng.shuffle(unique_landblocks)
    val_n = max(1, int(math.ceil(len(unique_landblocks) * val_split)))
    val_landblocks = set(unique_landblocks[:val_n])
    train_idx = []
    val_idx = []
    for idx, row in enumerate(rows):
        if str(row.get("landblockId") or "") in val_landblocks:
            val_idx.append(idx)
        else:
            train_idx.append(idx)
    if not train_idx or not val_idx:
        raise RuntimeError("Failed to build non-empty train/val split.")
    return np.asarray(train_idx, dtype=np.int64), np.asarray(val_idx, dtype=np.int64)


def load_rows(path: Path) -> list[dict]:
    rows = []
    for row in iter_jsonl(path):
        target = row.get("target") or {}
        yaw_deg = float(target.get("relativeYawDeg", 0.0))
        row["_target_vec"] = np.asarray(
            [
                float(target.get("dx", 0.0)),
                float(target.get("dy", 0.0)),
                float(target.get("heightAboveSupportPlane", 0.0)),
                math.sin(math.radians(yaw_deg)),
                math.cos(math.radians(yaw_deg)),
            ],
            dtype=np.float32,
        )
        row["_weight"] = float(row.get("evidenceWeight", 1.0))
        rows.append(row)
    if not rows:
        raise RuntimeError(f"No rows found in {path}")
    return rows


class InteriorPlacementDataset(Dataset):
    def __init__(
        self,
        categorical: np.ndarray,
        numeric: np.ndarray,
        sibling_categorical: np.ndarray,
        sibling_numeric: np.ndarray,
        sibling_mask: np.ndarray,
        nearby_categorical: np.ndarray,
        nearby_numeric: np.ndarray,
        nearby_mask: np.ndarray,
        support_constraints: np.ndarray,
        sibling_positions: np.ndarray,
        targets: np.ndarray,
        weights: np.ndarray,
        tier_codes: np.ndarray,
        indices: np.ndarray,
    ):
        self.categorical = torch.from_numpy(categorical[indices]).long()
        self.numeric = torch.from_numpy(numeric[indices]).float()
        self.sibling_categorical = torch.from_numpy(sibling_categorical[indices]).long()
        self.sibling_numeric = torch.from_numpy(sibling_numeric[indices]).float()
        self.sibling_mask = torch.from_numpy(sibling_mask[indices]).float()
        self.nearby_categorical = torch.from_numpy(nearby_categorical[indices]).long()
        self.nearby_numeric = torch.from_numpy(nearby_numeric[indices]).float()
        self.nearby_mask = torch.from_numpy(nearby_mask[indices]).float()
        self.support_constraints = torch.from_numpy(support_constraints[indices]).float()
        self.sibling_positions = torch.from_numpy(sibling_positions[indices]).float()
        self.targets = torch.from_numpy(targets[indices]).float()
        self.weights = torch.from_numpy(weights[indices]).float()
        self.tier_codes = torch.from_numpy(tier_codes[indices]).long()

    def __len__(self) -> int:
        return len(self.categorical)

    def __getitem__(self, idx: int):
        return (
            self.categorical[idx],
            self.numeric[idx],
            self.sibling_categorical[idx],
            self.sibling_numeric[idx],
            self.sibling_mask[idx],
            self.nearby_categorical[idx],
            self.nearby_numeric[idx],
            self.nearby_mask[idx],
            self.support_constraints[idx],
            self.sibling_positions[idx],
            self.targets[idx],
            self.weights[idx],
            self.tier_codes[idx],
        )


class InteriorMicroPlacer(nn.Module):
    def __init__(
        self,
        cardinalities: list[int],
        numeric_dim: int,
        sibling_cardinalities: list[int],
        sibling_numeric_dim: int,
        nearby_cardinalities: list[int],
        nearby_numeric_dim: int,
        hidden_dim: int,
        depth: int,
        dropout: float,
    ):
        super().__init__()
        self.embeddings = nn.ModuleList()
        embed_dims = []
        for size in cardinalities:
            emb_dim = min(32, max(4, int(round(size ** 0.5 * 2.0))))
            self.embeddings.append(nn.Embedding(size, emb_dim))
            embed_dims.append(emb_dim)

        self.sibling_embeddings = nn.ModuleList()
        sibling_embed_dims = []
        for size in sibling_cardinalities:
            emb_dim = min(16, max(4, int(round(size ** 0.5 * 2.0))))
            self.sibling_embeddings.append(nn.Embedding(size, emb_dim))
            sibling_embed_dims.append(emb_dim)

        sibling_item_dim = sum(sibling_embed_dims) + sibling_numeric_dim
        context_dim = max(64, hidden_dim // 2)
        self.sibling_item_mlp = nn.Sequential(
            nn.Linear(sibling_item_dim, context_dim),
            nn.LayerNorm(context_dim),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(context_dim, context_dim),
            nn.GELU(),
        )

        self.nearby_embeddings = nn.ModuleList()
        nearby_embed_dims = []
        for size in nearby_cardinalities:
            emb_dim = min(16, max(4, int(round(size ** 0.5 * 2.0))))
            self.nearby_embeddings.append(nn.Embedding(size, emb_dim))
            nearby_embed_dims.append(emb_dim)

        nearby_item_dim = sum(nearby_embed_dims) + nearby_numeric_dim
        self.nearby_item_mlp = nn.Sequential(
            nn.Linear(nearby_item_dim, context_dim),
            nn.LayerNorm(context_dim),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(context_dim, context_dim),
            nn.GELU(),
        )

        input_dim = sum(embed_dims) + numeric_dim + context_dim * 4
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
        self.head = nn.Linear(hidden_dim, 5)

    def forward(
        self,
        categorical: torch.Tensor,
        numeric: torch.Tensor,
        sibling_categorical: torch.Tensor,
        sibling_numeric: torch.Tensor,
        sibling_mask: torch.Tensor,
        nearby_categorical: torch.Tensor,
        nearby_numeric: torch.Tensor,
        nearby_mask: torch.Tensor,
    ) -> torch.Tensor:
        pieces = [emb(categorical[:, idx]) for idx, emb in enumerate(self.embeddings)]
        sibling_pieces = [emb(sibling_categorical[:, :, idx]) for idx, emb in enumerate(self.sibling_embeddings)]
        sibling_pieces.append(sibling_numeric)
        sibling_items = torch.cat(sibling_pieces, dim=-1)
        sibling_hidden = self.sibling_item_mlp(sibling_items)
        sibling_mask_exp = sibling_mask.unsqueeze(-1)
        sibling_sum = (sibling_hidden * sibling_mask_exp).sum(dim=1)
        sibling_count = sibling_mask_exp.sum(dim=1).clamp_min(1.0)
        sibling_mean = sibling_sum / sibling_count
        sibling_max = sibling_hidden.masked_fill(sibling_mask_exp == 0, -1e9).amax(dim=1)
        sibling_max = torch.where(sibling_mask_exp.sum(dim=1) > 0, sibling_max, torch.zeros_like(sibling_max))
        nearby_pieces = [emb(nearby_categorical[:, :, idx]) for idx, emb in enumerate(self.nearby_embeddings)]
        nearby_pieces.append(nearby_numeric)
        nearby_items = torch.cat(nearby_pieces, dim=-1)
        nearby_hidden = self.nearby_item_mlp(nearby_items)
        nearby_mask_exp = nearby_mask.unsqueeze(-1)
        nearby_sum = (nearby_hidden * nearby_mask_exp).sum(dim=1)
        nearby_count = nearby_mask_exp.sum(dim=1).clamp_min(1.0)
        nearby_mean = nearby_sum / nearby_count
        nearby_max = nearby_hidden.masked_fill(nearby_mask_exp == 0, -1e9).amax(dim=1)
        nearby_max = torch.where(nearby_mask_exp.sum(dim=1) > 0, nearby_max, torch.zeros_like(nearby_max))
        pieces.extend([numeric, sibling_mean, sibling_max, nearby_mean, nearby_max])
        hidden = self.backbone(torch.cat(pieces, dim=-1))
        return self.head(hidden)


def tier_curriculum_scale(tier_codes: torch.Tensor, epoch_index: int, total_epochs: int) -> torch.Tensor:
    progress = float(epoch_index + 1) / max(float(total_epochs), 1.0)
    bronze_scale = min(1.0, 0.2 + progress / 0.35 * 0.8)
    return torch.where(tier_codes > 0, torch.full_like(tier_codes, bronze_scale, dtype=torch.float32), torch.ones_like(tier_codes, dtype=torch.float32))


def weighted_huber_loss(pred: torch.Tensor, target: torch.Tensor, weight: torch.Tensor) -> torch.Tensor:
    per_example = F.smooth_l1_loss(pred, target, reduction="none").mean(dim=-1)
    return (per_example * weight).sum() / weight.sum().clamp_min(1e-6)


def edge_spill_penalty(
    pred_real: torch.Tensor,
    support_constraints: torch.Tensor,
    weight: torch.Tensor,
) -> torch.Tensor:
    dx = pred_real[:, 0]
    dy = pred_real[:, 1]
    half_x = support_constraints[:, 0]
    half_y = support_constraints[:, 1]
    valid = ((half_x > 1e-6) & (half_y > 1e-6)).float()
    spill_x = F.relu(dx.abs() - half_x)
    spill_y = F.relu(dy.abs() - half_y)
    spill = spill_x + spill_y
    weighted = spill * weight * valid
    return weighted.sum() / (weight * valid).sum().clamp_min(1e-6)


def sibling_spacing_penalty(
    pred_real: torch.Tensor,
    sibling_positions: torch.Tensor,
    sibling_mask: torch.Tensor,
    weight: torch.Tensor,
) -> torch.Tensor:
    pred_xy = pred_real[:, None, :2]
    sibling_xy = sibling_positions
    deltas = pred_xy - sibling_xy
    dists = torch.linalg.norm(deltas, dim=-1)
    min_clearance = 0.18
    overlap = F.relu(min_clearance - dists) * sibling_mask
    penalty = overlap.sum(dim=1)
    weighted = penalty * weight
    return weighted.sum() / weight.sum().clamp_min(1e-6)


def compute_metrics(pred: np.ndarray, target: np.ndarray) -> dict[str, float]:
    dx_mae = float(np.mean(np.abs(pred[:, 0] - target[:, 0])))
    dy_mae = float(np.mean(np.abs(pred[:, 1] - target[:, 1])))
    h_mae = float(np.mean(np.abs(pred[:, 2] - target[:, 2])))
    pred_yaw = np.degrees(np.arctan2(pred[:, 3], pred[:, 4]))
    target_yaw = np.degrees(np.arctan2(target[:, 3], target[:, 4]))
    yaw_delta = (pred_yaw - target_yaw + 180.0) % 360.0 - 180.0
    yaw_mae = float(np.mean(np.abs(yaw_delta)))
    return {
        "dx_mae": dx_mae,
        "dy_mae": dy_mae,
        "height_mae": h_mae,
        "yaw_deg_mae": yaw_mae,
    }


def prepare_arrays(rows: list[dict], train_idx: np.ndarray, min_name_freq: int):
    categorical_values: dict[str, list[str]] = {name: [] for name, _ in CATEGORY_SPECS}
    for row in rows:
        for spec_name, spec_path in CATEGORY_SPECS:
            categorical_values[spec_name].append(normalized_token(nested_get(row, spec_path)))

    vocab_meta = {}
    categorical_arrays = []
    for spec_name, _spec_path in CATEGORY_SPECS:
        values = categorical_values[spec_name]
        train_values = [values[i] for i in train_idx.tolist()]
        min_freq = min_name_freq if spec_name in {"prop_name", "support_name"} else 1
        vocab, tokens = build_vocab(train_values, min_freq=min_freq)
        encoded = np.asarray([vocab.get(value, 0) for value in values], dtype=np.int64)
        categorical_arrays.append(encoded)
        vocab_meta[spec_name] = {"tokens": tokens}
    categorical = np.stack(categorical_arrays, axis=1)

    sibling_values: dict[str, list[str]] = {name: [] for name, _ in SIBLING_CATEGORY_SPECS}
    sibling_items_per_row = []
    for row in rows:
        items = ((row.get("supportContext") or {}).get("items") or [])[:MAX_SIBLING_CONTEXT_ITEMS]
        sibling_items_per_row.append(items)
        for spec_name, item_key in SIBLING_CATEGORY_SPECS:
            sibling_values[spec_name].extend(normalized_token(item.get(item_key)) for item in items)

    sibling_vocab_meta = {}
    sibling_vocabs = {}
    for spec_name, _item_key in SIBLING_CATEGORY_SPECS:
        vocab, tokens = build_vocab(sibling_values[spec_name], min_freq=1)
        sibling_vocabs[spec_name] = vocab
        sibling_vocab_meta[spec_name] = {"tokens": tokens}

    nearby_values: dict[str, list[str]] = {name: [] for name, _ in NEARBY_SUPPORT_CATEGORY_SPECS}
    nearby_items_per_row = []
    for row in rows:
        items = ((row.get("nearbySupportContext") or {}).get("items") or [])[:MAX_NEARBY_SUPPORT_ITEMS]
        nearby_items_per_row.append(items)
        for spec_name, item_key in NEARBY_SUPPORT_CATEGORY_SPECS:
            nearby_values[spec_name].extend(normalized_token(item.get(item_key)) for item in items)

    nearby_vocab_meta = {}
    nearby_vocabs = {}
    for spec_name, _item_key in NEARBY_SUPPORT_CATEGORY_SPECS:
        vocab, tokens = build_vocab(nearby_values[spec_name], min_freq=1)
        nearby_vocabs[spec_name] = vocab
        nearby_vocab_meta[spec_name] = {"tokens": tokens}

    numeric = np.asarray(
        [
            [
                float((row.get("roomContext") or {}).get("portalCountInCell", 0.0)),
                float((row.get("roomContext") or {}).get("visibleCellCount", 0.0)),
                float((row.get("roomContext") or {}).get("staticObjectCountInCell", 0.0)),
                float((row.get("roomContext") or {}).get("staticObjectCountInComponent", 0.0)),
                float((row.get("roomContext") or {}).get("cellCountInComponent", 0.0)),
                float((row.get("validation") or {}).get("horizontalDistance", 0.0)),
                float((row.get("validation") or {}).get("competingParentCount", 0.0)),
                float(bool((row.get("validation") or {}).get("hasSurfaceHint"))),
                float(bool((row.get("validation") or {}).get("withinSurfaceFootprint"))),
                float((row.get("validation") or {}).get("surfaceFootprintOverflow", 0.0) or 0.0),
                float(row.get("evidenceWeight", 1.0)),
                float(((row.get("supportAnchorLocal") or {}).get("x", 0.0) or 0.0)),
                float(((row.get("supportAnchorLocal") or {}).get("y", 0.0) or 0.0)),
                float(((row.get("supportAnchorLocal") or {}).get("z", 0.0) or 0.0)),
                float(((row.get("propPositionLocal") or {}).get("x", 0.0) or 0.0)),
                float(((row.get("propPositionLocal") or {}).get("y", 0.0) or 0.0)),
                float(((row.get("propPositionLocal") or {}).get("z", 0.0) or 0.0)),
                float(((row.get("supportContext") or {}).get("siblingCount", 0.0) or 0.0)),
                float((((row.get("cellGeometry") or {}).get("prop") or {}).get("localX", 0.0) or 0.0)),
                float((((row.get("cellGeometry") or {}).get("prop") or {}).get("localY", 0.0) or 0.0)),
                float((((row.get("cellGeometry") or {}).get("prop") or {}).get("distWest", 0.0) or 0.0)),
                float((((row.get("cellGeometry") or {}).get("prop") or {}).get("distEast", 0.0) or 0.0)),
                float((((row.get("cellGeometry") or {}).get("prop") or {}).get("distSouth", 0.0) or 0.0)),
                float((((row.get("cellGeometry") or {}).get("prop") or {}).get("distNorth", 0.0) or 0.0)),
                float((((row.get("cellGeometry") or {}).get("prop") or {}).get("nearestCornerDistance", 0.0) or 0.0)),
                float((((row.get("cellGeometry") or {}).get("prop") or {}).get("centerOffsetX", 0.0) or 0.0)),
                float((((row.get("cellGeometry") or {}).get("prop") or {}).get("centerOffsetY", 0.0) or 0.0)),
                float((((row.get("cellGeometry") or {}).get("support") or {}).get("localX", 0.0) or 0.0)),
                float((((row.get("cellGeometry") or {}).get("support") or {}).get("localY", 0.0) or 0.0)),
                float((((row.get("cellGeometry") or {}).get("support") or {}).get("distWest", 0.0) or 0.0)),
                float((((row.get("cellGeometry") or {}).get("support") or {}).get("distEast", 0.0) or 0.0)),
                float((((row.get("cellGeometry") or {}).get("support") or {}).get("distSouth", 0.0) or 0.0)),
                float((((row.get("cellGeometry") or {}).get("support") or {}).get("distNorth", 0.0) or 0.0)),
                float((((row.get("cellGeometry") or {}).get("support") or {}).get("nearestCornerDistance", 0.0) or 0.0)),
                float((((row.get("cellGeometry") or {}).get("support") or {}).get("centerOffsetX", 0.0) or 0.0)),
                float((((row.get("cellGeometry") or {}).get("support") or {}).get("centerOffsetY", 0.0) or 0.0)),
                float(((row.get("supportGeometry") or {}).get("halfExtentX", 0.0) or 0.0)),
                float(((row.get("supportGeometry") or {}).get("halfExtentY", 0.0) or 0.0)),
                float(((row.get("supportGeometry") or {}).get("normalizedDx", 0.0) or 0.0)),
                float(((row.get("supportGeometry") or {}).get("normalizedDy", 0.0) or 0.0)),
                float((((row.get("supportGeometry") or {}).get("edgeDistances") or {}).get("west", 0.0) or 0.0)),
                float((((row.get("supportGeometry") or {}).get("edgeDistances") or {}).get("east", 0.0) or 0.0)),
                float((((row.get("supportGeometry") or {}).get("edgeDistances") or {}).get("south", 0.0) or 0.0)),
                float((((row.get("supportGeometry") or {}).get("edgeDistances") or {}).get("north", 0.0) or 0.0)),
                float(((row.get("supportGeometry") or {}).get("matchDistance", 0.0) or 0.0)),
                float(((row.get("nearbySupportContext") or {}).get("count", 0.0) or 0.0)),
                float(bool((row.get("prop") or {}).get("isHookPlacable"))),
                float(bool((row.get("support") or {}).get("isHookPlacable"))),
            ]
            for row in rows
        ],
        dtype=np.float32,
    )
    numeric_mean = numeric[train_idx].mean(axis=0)
    numeric_std = numeric[train_idx].std(axis=0)
    numeric_std = np.where(numeric_std < 1e-6, 1.0, numeric_std)
    numeric = (numeric - numeric_mean) / numeric_std

    targets = np.stack([row["_target_vec"] for row in rows], axis=0).astype(np.float32)
    target_mean = targets[train_idx].mean(axis=0)
    target_std = targets[train_idx].std(axis=0)
    target_std = np.where(target_std < 1e-6, 1.0, target_std)
    targets = (targets - target_mean) / target_std

    sibling_categorical = np.zeros(
        (len(rows), MAX_SIBLING_CONTEXT_ITEMS, len(SIBLING_CATEGORY_SPECS)), dtype=np.int64
    )
    sibling_numeric = np.zeros((len(rows), MAX_SIBLING_CONTEXT_ITEMS, len(SIBLING_NUMERIC_KEYS)), dtype=np.float32)
    sibling_mask = np.zeros((len(rows), MAX_SIBLING_CONTEXT_ITEMS), dtype=np.float32)
    sibling_positions = np.zeros((len(rows), MAX_SIBLING_CONTEXT_ITEMS, 2), dtype=np.float32)
    for row_idx, items in enumerate(sibling_items_per_row):
        for item_idx, item in enumerate(items[:MAX_SIBLING_CONTEXT_ITEMS]):
            sibling_mask[row_idx, item_idx] = 1.0
            for cat_idx, (spec_name, item_key) in enumerate(SIBLING_CATEGORY_SPECS):
                sibling_categorical[row_idx, item_idx, cat_idx] = sibling_vocabs[spec_name].get(
                    normalized_token(item.get(item_key)), 0
                )
            yaw_deg = float(item.get("relativeYawDeg", 0.0))
            sibling_numeric[row_idx, item_idx] = np.asarray(
                [
                    float(item.get("dx", 0.0)),
                    float(item.get("dy", 0.0)),
                    float(item.get("heightAboveSupportPlane", 0.0)),
                    float(item.get("horizontalDistance", 0.0)),
                    math.sin(math.radians(yaw_deg)),
                    math.cos(math.radians(yaw_deg)),
                    float(item.get("evidenceWeight", 1.0)),
                ],
                dtype=np.float32,
            )
            sibling_positions[row_idx, item_idx] = np.asarray(
                [
                    float(item.get("dx", 0.0)),
                    float(item.get("dy", 0.0)),
                ],
                dtype=np.float32,
            )
    sibling_numeric_mean = sibling_numeric[train_idx].reshape(-1, len(SIBLING_NUMERIC_KEYS)).mean(axis=0)
    sibling_numeric_std = sibling_numeric[train_idx].reshape(-1, len(SIBLING_NUMERIC_KEYS)).std(axis=0)
    sibling_numeric_std = np.where(sibling_numeric_std < 1e-6, 1.0, sibling_numeric_std)
    sibling_numeric = (sibling_numeric - sibling_numeric_mean) / sibling_numeric_std
    sibling_numeric *= sibling_mask[..., None]

    nearby_categorical = np.zeros(
        (len(rows), MAX_NEARBY_SUPPORT_ITEMS, len(NEARBY_SUPPORT_CATEGORY_SPECS)), dtype=np.int64
    )
    nearby_numeric = np.zeros((len(rows), MAX_NEARBY_SUPPORT_ITEMS, len(NEARBY_SUPPORT_NUMERIC_KEYS)), dtype=np.float32)
    nearby_mask = np.zeros((len(rows), MAX_NEARBY_SUPPORT_ITEMS), dtype=np.float32)
    for row_idx, items in enumerate(nearby_items_per_row):
        for item_idx, item in enumerate(items[:MAX_NEARBY_SUPPORT_ITEMS]):
            nearby_mask[row_idx, item_idx] = 1.0
            for cat_idx, (spec_name, item_key) in enumerate(NEARBY_SUPPORT_CATEGORY_SPECS):
                nearby_categorical[row_idx, item_idx, cat_idx] = nearby_vocabs[spec_name].get(
                    normalized_token(item.get(item_key)), 0
                )
            nearby_numeric[row_idx, item_idx] = np.asarray(
                [
                    float(item.get("dx", 0.0)),
                    float(item.get("dy", 0.0)),
                    float(item.get("distance", 0.0)),
                ],
                dtype=np.float32,
            )
    nearby_numeric_mean = nearby_numeric[train_idx].reshape(-1, len(NEARBY_SUPPORT_NUMERIC_KEYS)).mean(axis=0)
    nearby_numeric_std = nearby_numeric[train_idx].reshape(-1, len(NEARBY_SUPPORT_NUMERIC_KEYS)).std(axis=0)
    nearby_numeric_std = np.where(nearby_numeric_std < 1e-6, 1.0, nearby_numeric_std)
    nearby_numeric = (nearby_numeric - nearby_numeric_mean) / nearby_numeric_std
    nearby_numeric *= nearby_mask[..., None]

    support_constraints = np.asarray(
        [
            [
                float(((row.get("supportGeometry") or {}).get("halfExtentX", 0.0) or 0.0)),
                float(((row.get("supportGeometry") or {}).get("halfExtentY", 0.0) or 0.0)),
                float(bool((row.get("validation") or {}).get("withinSurfaceFootprint"))),
                float(((row.get("validation") or {}).get("surfaceFootprintOverflow", 0.0) or 0.0)),
            ]
            for row in rows
        ],
        dtype=np.float32,
    )

    weights = np.asarray([row["_weight"] for row in rows], dtype=np.float32)
    tier_codes = np.asarray(
        [1 if str(row.get("labelTier") or "").startswith("bronze_") else 0 for row in rows],
        dtype=np.int64,
    )
    return (
        categorical,
        numeric,
        sibling_categorical,
        sibling_numeric,
        sibling_mask,
        nearby_categorical,
        nearby_numeric,
        nearby_mask,
        support_constraints,
        sibling_positions,
        targets,
        weights,
        vocab_meta,
        sibling_vocab_meta,
        nearby_vocab_meta,
        numeric_mean,
        numeric_std,
        sibling_numeric_mean,
        sibling_numeric_std,
        nearby_numeric_mean,
        nearby_numeric_std,
        target_mean,
        target_std,
        tier_codes,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the interior micro-placement model.")
    parser.add_argument("--dataset-jsonl", type=Path, default=DEFAULT_DATASET_JSONL)
    parser.add_argument("--epochs", type=int, default=Config.epochs)
    parser.add_argument("--batch", type=int, default=Config.batch_size)
    parser.add_argument("--lr", type=float, default=Config.lr)
    parser.add_argument("--weight-decay", type=float, default=Config.weight_decay)
    parser.add_argument("--hidden-dim", type=int, default=Config.hidden_dim)
    parser.add_argument("--depth", type=int, default=Config.depth)
    parser.add_argument("--dropout", type=float, default=Config.dropout)
    parser.add_argument("--val-split", type=float, default=Config.val_split)
    parser.add_argument("--min-name-freq", type=int, default=Config.min_name_freq)
    parser.add_argument("--seed", type=int, default=Config.seed)
    parser.add_argument("--max-train-batches", type=int, default=Config.max_train_batches)
    parser.add_argument("--max-val-batches", type=int, default=Config.max_val_batches)
    parser.add_argument("--run-name", type=str, default="interior_micro_placer")
    args = parser.parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)

    rows = load_rows(args.dataset_jsonl)
    train_idx, val_idx = split_by_landblock(rows, args.val_split, args.seed)
    (
        categorical,
        numeric,
        sibling_categorical,
        sibling_numeric,
        sibling_mask,
        nearby_categorical,
        nearby_numeric,
        nearby_mask,
        support_constraints,
        sibling_positions,
        targets,
        weights,
        vocab_meta,
        sibling_vocab_meta,
        nearby_vocab_meta,
        numeric_mean,
        numeric_std,
        sibling_numeric_mean,
        sibling_numeric_std,
        nearby_numeric_mean,
        nearby_numeric_std,
        target_mean,
        target_std,
        tier_codes,
    ) = prepare_arrays(rows, train_idx, args.min_name_freq)

    train_ds = InteriorPlacementDataset(
        categorical,
        numeric,
        sibling_categorical,
        sibling_numeric,
        sibling_mask,
        nearby_categorical,
        nearby_numeric,
        nearby_mask,
        support_constraints,
        sibling_positions,
        targets,
        weights,
        tier_codes,
        train_idx,
    )
    val_ds = InteriorPlacementDataset(
        categorical,
        numeric,
        sibling_categorical,
        sibling_numeric,
        sibling_mask,
        nearby_categorical,
        nearby_numeric,
        nearby_mask,
        support_constraints,
        sibling_positions,
        targets,
        weights,
        tier_codes,
        val_idx,
    )

    sample_weights = np.asarray([rows[i]["_weight"] for i in train_idx], dtype=np.float64)
    sample_weights = np.clip(sample_weights, 1e-3, None)
    train_sampler = WeightedRandomSampler(
        weights=torch.from_numpy(sample_weights),
        num_samples=len(sample_weights),
        replacement=True,
    )

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if device.type == "cuda":
        torch.backends.cudnn.benchmark = True

    model = InteriorMicroPlacer(
        cardinalities=[len(vocab_meta[name]["tokens"]) for name, _ in CATEGORY_SPECS],
        numeric_dim=len(NUMERIC_FEATURE_KEYS),
        sibling_cardinalities=[len(sibling_vocab_meta[name]["tokens"]) for name, _ in SIBLING_CATEGORY_SPECS],
        sibling_numeric_dim=len(SIBLING_NUMERIC_KEYS),
        nearby_cardinalities=[len(nearby_vocab_meta[name]["tokens"]) for name, _ in NEARBY_SUPPORT_CATEGORY_SPECS],
        nearby_numeric_dim=len(NEARBY_SUPPORT_NUMERIC_KEYS),
        hidden_dim=args.hidden_dim,
        depth=args.depth,
        dropout=args.dropout,
    ).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)

    train_loader = DataLoader(train_ds, batch_size=args.batch, sampler=train_sampler, num_workers=0, pin_memory=True)
    val_loader = DataLoader(val_ds, batch_size=args.batch, shuffle=False, num_workers=0, pin_memory=True)

    run_dir = MODEL_DIR / args.run_name
    run_dir.mkdir(parents=True, exist_ok=True)
    best_path = run_dir / "best.pt"
    meta_path = run_dir / "meta.json"

    print("=" * 72)
    print("  Interior Micro Placer Training")
    print("=" * 72)
    print(f"  Dataset: {args.dataset_jsonl}")
    print(f"  Rows: {len(rows):,}  Train: {len(train_ds):,}  Val: {len(val_ds):,}")
    print(f"  Device: {device}")
    if device.type == "cuda":
        print(f"  GPU: {torch.cuda.get_device_name()}")
    print(f"  Run dir: {run_dir}")

    best_val = float("inf")
    best_state = None
    history = []
    target_mean_t = torch.from_numpy(target_mean).to(device)
    target_std_t = torch.from_numpy(target_std).to(device)
    edge_loss_weight = 0.05
    spacing_loss_weight = 0.03

    for epoch in range(args.epochs):
        model.train()
        train_loss_sum = 0.0
        train_batches = 0
        for batch_idx, (
            cat,
            num,
            sib_cat,
            sib_num,
            sib_mask,
            nearby_cat,
            nearby_num,
            nearby_mask,
            support_constraints_batch,
            sibling_positions_batch,
            tgt,
            w,
            tier_codes_batch,
        ) in enumerate(train_loader):
            if args.max_train_batches is not None and batch_idx >= args.max_train_batches:
                break
            cat = cat.to(device)
            num = num.to(device)
            sib_cat = sib_cat.to(device)
            sib_num = sib_num.to(device)
            sib_mask = sib_mask.to(device)
            nearby_cat = nearby_cat.to(device)
            nearby_num = nearby_num.to(device)
            nearby_mask = nearby_mask.to(device)
            support_constraints_batch = support_constraints_batch.to(device)
            sibling_positions_batch = sibling_positions_batch.to(device)
            tgt = tgt.to(device)
            w = w.to(device)
            tier_codes_batch = tier_codes_batch.to(device)

            pred = model(cat, num, sib_cat, sib_num, sib_mask, nearby_cat, nearby_num, nearby_mask)
            batch_weight = w * tier_curriculum_scale(tier_codes_batch, epoch, args.epochs)
            pred_real = pred * target_std_t + target_mean_t
            loss = weighted_huber_loss(pred, tgt, batch_weight)
            loss = loss + edge_loss_weight * edge_spill_penalty(pred_real, support_constraints_batch, batch_weight)
            loss = loss + spacing_loss_weight * sibling_spacing_penalty(
                pred_real, sibling_positions_batch, sib_mask, batch_weight
            )
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            optimizer.step()

            train_loss_sum += float(loss.item())
            train_batches += 1

        model.eval()
        val_loss_sum = 0.0
        val_batches = 0
        pred_chunks = []
        tgt_chunks = []
        with torch.no_grad():
            for batch_idx, (
                cat,
                num,
                sib_cat,
                sib_num,
                sib_mask,
                nearby_cat,
                nearby_num,
                nearby_mask,
                support_constraints_batch,
                sibling_positions_batch,
                tgt,
                w,
                tier_codes_batch,
            ) in enumerate(val_loader):
                if args.max_val_batches is not None and batch_idx >= args.max_val_batches:
                    break
                cat = cat.to(device)
                num = num.to(device)
                sib_cat = sib_cat.to(device)
                sib_num = sib_num.to(device)
                sib_mask = sib_mask.to(device)
                nearby_cat = nearby_cat.to(device)
                nearby_num = nearby_num.to(device)
                nearby_mask = nearby_mask.to(device)
                support_constraints_batch = support_constraints_batch.to(device)
                sibling_positions_batch = sibling_positions_batch.to(device)
                tgt = tgt.to(device)
                w = w.to(device)
                tier_codes_batch = tier_codes_batch.to(device)

                pred = model(cat, num, sib_cat, sib_num, sib_mask, nearby_cat, nearby_num, nearby_mask)
                batch_weight = w * tier_curriculum_scale(tier_codes_batch, epoch, args.epochs)
                pred_real = pred * target_std_t + target_mean_t
                loss = weighted_huber_loss(pred, tgt, batch_weight)
                loss = loss + edge_loss_weight * edge_spill_penalty(pred_real, support_constraints_batch, batch_weight)
                loss = loss + spacing_loss_weight * sibling_spacing_penalty(
                    pred_real, sibling_positions_batch, sib_mask, batch_weight
                )
                val_loss_sum += float(loss.item())
                val_batches += 1

                tgt_real = tgt * target_std_t + target_mean_t
                pred_chunks.append(pred_real.cpu().numpy())
                tgt_chunks.append(tgt_real.cpu().numpy())

        avg_train = train_loss_sum / max(train_batches, 1)
        avg_val = val_loss_sum / max(val_batches, 1)
        metrics = compute_metrics(np.concatenate(pred_chunks, axis=0), np.concatenate(tgt_chunks, axis=0))
        history_row = {"epoch": epoch + 1, "train_loss": avg_train, "val_loss": avg_val, **metrics}
        history.append(history_row)

        if avg_val < best_val:
            best_val = avg_val
            best_state = {
                "model_state_dict": model.state_dict(),
                "config": vars(args),
                "category_specs": [name for name, _ in CATEGORY_SPECS],
                "sibling_category_specs": [name for name, _ in SIBLING_CATEGORY_SPECS],
                "numeric_feature_keys": list(NUMERIC_FEATURE_KEYS),
                "sibling_numeric_feature_keys": list(SIBLING_NUMERIC_KEYS),
                "vocab_meta": vocab_meta,
                "sibling_vocab_meta": sibling_vocab_meta,
                "nearby_vocab_meta": nearby_vocab_meta,
                "numeric_mean": numeric_mean.tolist(),
                "numeric_std": numeric_std.tolist(),
                "sibling_numeric_mean": sibling_numeric_mean.tolist(),
                "sibling_numeric_std": sibling_numeric_std.tolist(),
                "nearby_numeric_mean": nearby_numeric_mean.tolist(),
                "nearby_numeric_std": nearby_numeric_std.tolist(),
                "target_mean": target_mean.tolist(),
                "target_std": target_std.tolist(),
                "best_val_loss": best_val,
                "history": history,
            }

        print(
            f"  Epoch {epoch + 1:3d}/{args.epochs} "
            f"train={avg_train:.4f} val={avg_val:.4f} "
            f"dx_mae={metrics['dx_mae']:.4f} dy_mae={metrics['dy_mae']:.4f} "
            f"h_mae={metrics['height_mae']:.4f} yaw_mae={metrics['yaw_deg_mae']:.2f}"
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

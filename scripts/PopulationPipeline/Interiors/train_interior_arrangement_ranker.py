#!/usr/bin/env python3
"""
Train a support-level arrangement ranker from positive and negative candidates.

This model scores whether a candidate placement is compatible with the support
surface and the rest of the observed arrangement on that support.
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

DEFAULT_DATASET_JSONL = REFERENCE_DIR / "fullworld_interior_support_arrangements_v1.jsonl"

CATEGORY_SPECS = (
    ("prop_class", ("prop", "propClass")),
    ("prop_name", ("prop", "name")),
    ("prop_source_kind", ("prop", "sourceKind")),
    ("prop_hook_type", ("prop", "lsdHookType")),
    ("support_class", ("support", "supportClass")),
    ("support_name", ("support", "name")),
    ("support_source_kind", ("support", "sourceKind")),
    ("support_hook_type", ("support", "lsdHookType")),
    ("label_tier", ("labelTier",)),
)

NUMERIC_FEATURE_KEYS = (
    "dx",
    "dy",
    "heightAboveSupportPlane",
    "yawSin",
    "yawCos",
    "supportHalfExtentX",
    "supportHalfExtentY",
    "normalizedDx",
    "normalizedDy",
    "edgeWest",
    "edgeEast",
    "edgeSouth",
    "edgeNorth",
    "positiveCount",
    "positiveDxMean",
    "positiveDyMean",
    "positiveHeightMean",
    "minDistanceToPositive",
    "meanDistanceToPositive",
    "supportCellLocalX",
    "supportCellLocalY",
    "supportDistWest",
    "supportDistEast",
    "supportDistSouth",
    "supportDistNorth",
    "nearbySupportCount",
    "candidateEvidenceWeight",
    "supportIsHookPlacable",
    "propIsHookPlacable",
)

ARR_CATEGORY_SPECS = (
    ("arr_prop_class", "propClass"),
    ("arr_prop_source_kind", "sourceKind"),
    ("arr_label_tier", "labelTier"),
)

ARR_NUMERIC_KEYS = (
    "dx",
    "dy",
    "heightAboveSupportPlane",
    "yawSin",
    "yawCos",
    "evidenceWeight",
)

MAX_ARR_ITEMS = 12


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


def arrangement_item_from_candidate(candidate: dict) -> dict:
    prop = candidate.get("prop") or {}
    placement = candidate.get("placement") or {}
    yaw_deg = float(placement.get("relativeYawDeg", 0.0))
    return {
        "propClass": prop.get("propClass"),
        "sourceKind": prop.get("sourceKind"),
        "labelTier": candidate.get("labelTier"),
        "dx": float(placement.get("dx", 0.0)),
        "dy": float(placement.get("dy", 0.0)),
        "heightAboveSupportPlane": float(placement.get("heightAboveSupportPlane", 0.0)),
        "yawSin": math.sin(math.radians(yaw_deg)),
        "yawCos": math.cos(math.radians(yaw_deg)),
        "evidenceWeight": float(candidate.get("evidenceWeight", 1.0)),
        "trainingKey": candidate.get("trainingKey"),
    }


def build_flat_samples(rows: list[dict]) -> list[dict]:
    samples = []
    for row in rows:
        support_geom = row.get("supportGeometry") or {}
        cell_geom = row.get("cellGeometry") or {}
        support_cell = (cell_geom.get("support") or {})
        positives = row.get("positives") or []
        arrangement_items = [arrangement_item_from_candidate(candidate) for candidate in positives]
        nearby_support_count = float((row.get("roomContext") or {}).get("staticObjectCountInCell", 0.0))
        summary = row.get("arrangementSummary") or {}
        for candidate in positives + (row.get("negatives") or []):
            prop = candidate.get("prop") or {}
            placement = candidate.get("placement") or {}
            dx = float(placement.get("dx", 0.0))
            dy = float(placement.get("dy", 0.0))
            yaw_deg = float(placement.get("relativeYawDeg", 0.0))
            half_x = float(support_geom.get("halfExtentX", 0.0) or 0.0)
            half_y = float(support_geom.get("halfExtentY", 0.0) or 0.0)
            edge_distances = support_geom.get("edgeDistances") or {}

            arrangement_context = [
                item
                for item in arrangement_items
                if item.get("trainingKey") != candidate.get("trainingKey")
            ][:MAX_ARR_ITEMS]
            distances = []
            for item in arrangement_context:
                distances.append(math.hypot(dx - float(item.get("dx", 0.0)), dy - float(item.get("dy", 0.0))))
            sample = {
                "landblockId": row.get("landblockId"),
                "label": int(candidate.get("label", 0)),
                "supportKey": row.get("supportKey"),
                "candidateSource": candidate.get("candidateSource"),
                "labelTier": candidate.get("labelTier"),
                "prop": prop,
                "support": row.get("support") or {},
                "numeric": {
                    "dx": dx,
                    "dy": dy,
                    "heightAboveSupportPlane": float(placement.get("heightAboveSupportPlane", 0.0)),
                    "yawSin": math.sin(math.radians(yaw_deg)),
                    "yawCos": math.cos(math.radians(yaw_deg)),
                    "supportHalfExtentX": half_x,
                    "supportHalfExtentY": half_y,
                    "normalizedDx": dx / half_x if half_x > 1e-6 else 0.0,
                    "normalizedDy": dy / half_y if half_y > 1e-6 else 0.0,
                    "edgeWest": float(edge_distances.get("west", dx + half_x) or 0.0),
                    "edgeEast": float(edge_distances.get("east", half_x - dx) or 0.0),
                    "edgeSouth": float(edge_distances.get("south", dy + half_y) or 0.0),
                    "edgeNorth": float(edge_distances.get("north", half_y - dy) or 0.0),
                    "positiveCount": float(summary.get("positiveCount", 0.0) or 0.0),
                    "positiveDxMean": float(summary.get("dxMean", 0.0) or 0.0),
                    "positiveDyMean": float(summary.get("dyMean", 0.0) or 0.0),
                    "positiveHeightMean": float(summary.get("heightMean", 0.0) or 0.0),
                    "minDistanceToPositive": min(distances) if distances else 99.0,
                    "meanDistanceToPositive": (sum(distances) / len(distances)) if distances else 99.0,
                    "supportCellLocalX": float(support_cell.get("localX", 0.0) or 0.0),
                    "supportCellLocalY": float(support_cell.get("localY", 0.0) or 0.0),
                    "supportDistWest": float(support_cell.get("distWest", 0.0) or 0.0),
                    "supportDistEast": float(support_cell.get("distEast", 0.0) or 0.0),
                    "supportDistSouth": float(support_cell.get("distSouth", 0.0) or 0.0),
                    "supportDistNorth": float(support_cell.get("distNorth", 0.0) or 0.0),
                    "nearbySupportCount": nearby_support_count,
                    "candidateEvidenceWeight": float(candidate.get("evidenceWeight", 1.0)),
                    "supportIsHookPlacable": float(bool((row.get("support") or {}).get("isHookPlacable"))),
                    "propIsHookPlacable": float(bool(prop.get("isHookPlacable"))),
                },
                "arrangementContext": arrangement_context,
            }
            samples.append(sample)
    if not samples:
        raise RuntimeError("No candidate samples built from arrangement dataset.")
    return samples


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


class ArrangementDataset(Dataset):
    def __init__(
        self,
        categorical: np.ndarray,
        numeric: np.ndarray,
        arr_categorical: np.ndarray,
        arr_numeric: np.ndarray,
        arr_mask: np.ndarray,
        labels: np.ndarray,
        weights: np.ndarray,
        indices: np.ndarray,
    ):
        self.categorical = torch.from_numpy(categorical[indices]).long()
        self.numeric = torch.from_numpy(numeric[indices]).float()
        self.arr_categorical = torch.from_numpy(arr_categorical[indices]).long()
        self.arr_numeric = torch.from_numpy(arr_numeric[indices]).float()
        self.arr_mask = torch.from_numpy(arr_mask[indices]).float()
        self.labels = torch.from_numpy(labels[indices]).float()
        self.weights = torch.from_numpy(weights[indices]).float()

    def __len__(self) -> int:
        return len(self.categorical)

    def __getitem__(self, idx: int):
        return (
            self.categorical[idx],
            self.numeric[idx],
            self.arr_categorical[idx],
            self.arr_numeric[idx],
            self.arr_mask[idx],
            self.labels[idx],
            self.weights[idx],
        )


class ArrangementRanker(nn.Module):
    def __init__(
        self,
        cardinalities: list[int],
        numeric_dim: int,
        arr_cardinalities: list[int],
        arr_numeric_dim: int,
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

        self.arr_embeddings = nn.ModuleList()
        arr_embed_dims = []
        for size in arr_cardinalities:
            emb_dim = min(16, max(4, int(round(size ** 0.5 * 2.0))))
            self.arr_embeddings.append(nn.Embedding(size, emb_dim))
            arr_embed_dims.append(emb_dim)

        context_dim = max(64, hidden_dim // 2)
        arr_item_dim = sum(arr_embed_dims) + arr_numeric_dim
        self.arr_item_mlp = nn.Sequential(
            nn.Linear(arr_item_dim, context_dim),
            nn.LayerNorm(context_dim),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(context_dim, context_dim),
            nn.GELU(),
        )

        input_dim = sum(embed_dims) + numeric_dim + context_dim * 2
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

    def forward(
        self,
        categorical: torch.Tensor,
        numeric: torch.Tensor,
        arr_categorical: torch.Tensor,
        arr_numeric: torch.Tensor,
        arr_mask: torch.Tensor,
    ) -> torch.Tensor:
        pieces = [emb(categorical[:, idx]) for idx, emb in enumerate(self.embeddings)]
        arr_pieces = [emb(arr_categorical[:, :, idx]) for idx, emb in enumerate(self.arr_embeddings)]
        arr_pieces.append(arr_numeric)
        arr_items = torch.cat(arr_pieces, dim=-1)
        arr_hidden = self.arr_item_mlp(arr_items)
        arr_mask_exp = arr_mask.unsqueeze(-1)
        arr_sum = (arr_hidden * arr_mask_exp).sum(dim=1)
        arr_count = arr_mask_exp.sum(dim=1).clamp_min(1.0)
        arr_mean = arr_sum / arr_count
        arr_max = arr_hidden.masked_fill(arr_mask_exp == 0, -1e9).amax(dim=1)
        arr_max = torch.where(arr_mask_exp.sum(dim=1) > 0, arr_max, torch.zeros_like(arr_max))
        pieces.extend([numeric, arr_mean, arr_max])
        hidden = self.backbone(torch.cat(pieces, dim=-1))
        return self.head(hidden).squeeze(-1)


def prepare_arrays(rows: list[dict], train_idx: np.ndarray, min_name_freq: int):
    categorical_values: dict[str, list[str]] = {name: [] for name, _ in CATEGORY_SPECS}
    for row in rows:
        for spec_name, spec_path in CATEGORY_SPECS:
            categorical_values[spec_name].append(normalized_token(nested_get(row, spec_path)))

    vocab_meta = {}
    categorical_arrays = []
    for spec_name, _ in CATEGORY_SPECS:
        values = categorical_values[spec_name]
        train_values = [values[i] for i in train_idx.tolist()]
        min_freq = min_name_freq if spec_name in {"prop_name", "support_name"} else 1
        vocab, tokens = build_vocab(train_values, min_freq=min_freq)
        categorical_arrays.append(np.asarray([vocab.get(value, 0) for value in values], dtype=np.int64))
        vocab_meta[spec_name] = {"tokens": tokens}
    categorical = np.stack(categorical_arrays, axis=1)

    arr_values: dict[str, list[str]] = {name: [] for name, _ in ARR_CATEGORY_SPECS}
    arr_items_per_row = []
    for row in rows:
        items = (row.get("arrangementContext") or [])[:MAX_ARR_ITEMS]
        arr_items_per_row.append(items)
        for spec_name, item_key in ARR_CATEGORY_SPECS:
            arr_values[spec_name].extend(normalized_token(item.get(item_key)) for item in items)

    arr_vocab_meta = {}
    arr_vocabs = {}
    for spec_name, _ in ARR_CATEGORY_SPECS:
        vocab, tokens = build_vocab(arr_values[spec_name], min_freq=1)
        arr_vocabs[spec_name] = vocab
        arr_vocab_meta[spec_name] = {"tokens": tokens}

    numeric = np.asarray(
        [[float((row.get("numeric") or {}).get(key, 0.0)) for key in NUMERIC_FEATURE_KEYS] for row in rows],
        dtype=np.float32,
    )
    numeric_mean = numeric[train_idx].mean(axis=0)
    numeric_std = numeric[train_idx].std(axis=0)
    numeric_std = np.where(numeric_std < 1e-6, 1.0, numeric_std)
    numeric = (numeric - numeric_mean) / numeric_std

    arr_categorical = np.zeros((len(rows), MAX_ARR_ITEMS, len(ARR_CATEGORY_SPECS)), dtype=np.int64)
    arr_numeric = np.zeros((len(rows), MAX_ARR_ITEMS, len(ARR_NUMERIC_KEYS)), dtype=np.float32)
    arr_mask = np.zeros((len(rows), MAX_ARR_ITEMS), dtype=np.float32)
    for row_idx, items in enumerate(arr_items_per_row):
        for item_idx, item in enumerate(items[:MAX_ARR_ITEMS]):
            arr_mask[row_idx, item_idx] = 1.0
            for cat_idx, (spec_name, item_key) in enumerate(ARR_CATEGORY_SPECS):
                arr_categorical[row_idx, item_idx, cat_idx] = arr_vocabs[spec_name].get(normalized_token(item.get(item_key)), 0)
            arr_numeric[row_idx, item_idx] = np.asarray(
                [float(item.get(key, 0.0)) for key in ARR_NUMERIC_KEYS],
                dtype=np.float32,
            )
    arr_numeric_mean = arr_numeric[train_idx].reshape(-1, len(ARR_NUMERIC_KEYS)).mean(axis=0)
    arr_numeric_std = arr_numeric[train_idx].reshape(-1, len(ARR_NUMERIC_KEYS)).std(axis=0)
    arr_numeric_std = np.where(arr_numeric_std < 1e-6, 1.0, arr_numeric_std)
    arr_numeric = (arr_numeric - arr_numeric_mean) / arr_numeric_std
    arr_numeric *= arr_mask[..., None]

    labels = np.asarray([float(row.get("label", 0.0)) for row in rows], dtype=np.float32)
    weights = np.asarray(
        [
            float((row.get("numeric") or {}).get("candidateEvidenceWeight", 1.0)) * (1.0 if float(row.get("label", 0.0)) > 0.5 else 0.8)
            for row in rows
        ],
        dtype=np.float32,
    )
    return (
        categorical,
        numeric,
        arr_categorical,
        arr_numeric,
        arr_mask,
        labels,
        weights,
        vocab_meta,
        arr_vocab_meta,
        numeric_mean,
        numeric_std,
        arr_numeric_mean,
        arr_numeric_std,
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


def load_rows(path: Path) -> list[dict]:
    arrangement_rows = list(iter_jsonl(path))
    if not arrangement_rows:
        raise RuntimeError(f"No rows found in {path}")
    return build_flat_samples(arrangement_rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Train support-level arrangement ranker.")
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
    parser.add_argument("--run-name", type=str, default="interior_arrangement_ranker")
    args = parser.parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)

    rows = load_rows(args.dataset_jsonl)
    train_idx, val_idx = split_by_landblock(rows, args.val_split, args.seed)
    (
        categorical,
        numeric,
        arr_categorical,
        arr_numeric,
        arr_mask,
        labels,
        weights,
        vocab_meta,
        arr_vocab_meta,
        numeric_mean,
        numeric_std,
        arr_numeric_mean,
        arr_numeric_std,
    ) = prepare_arrays(rows, train_idx, args.min_name_freq)

    train_ds = ArrangementDataset(categorical, numeric, arr_categorical, arr_numeric, arr_mask, labels, weights, train_idx)
    val_ds = ArrangementDataset(categorical, numeric, arr_categorical, arr_numeric, arr_mask, labels, weights, val_idx)

    sample_weights = np.asarray([rows[i]["numeric"]["candidateEvidenceWeight"] for i in train_idx], dtype=np.float64)
    sample_weights *= np.asarray([1.35 if rows[i]["label"] > 0.5 else 1.0 for i in train_idx], dtype=np.float64)
    sample_weights = np.clip(sample_weights, 1e-3, None)
    train_sampler = WeightedRandomSampler(torch.from_numpy(sample_weights), num_samples=len(sample_weights), replacement=True)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if device.type == "cuda":
        torch.backends.cudnn.benchmark = True

    model = ArrangementRanker(
        cardinalities=[len(vocab_meta[name]["tokens"]) for name, _ in CATEGORY_SPECS],
        numeric_dim=len(NUMERIC_FEATURE_KEYS),
        arr_cardinalities=[len(arr_vocab_meta[name]["tokens"]) for name, _ in ARR_CATEGORY_SPECS],
        arr_numeric_dim=len(ARR_NUMERIC_KEYS),
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
    print("  Interior Arrangement Ranker Training")
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

    for epoch in range(args.epochs):
        model.train()
        train_loss_sum = 0.0
        train_batches = 0
        for cat, num, arr_cat, arr_num, arr_mask_batch, labels_batch, weights_batch in train_loader:
            cat = cat.to(device)
            num = num.to(device)
            arr_cat = arr_cat.to(device)
            arr_num = arr_num.to(device)
            arr_mask_batch = arr_mask_batch.to(device)
            labels_batch = labels_batch.to(device)
            weights_batch = weights_batch.to(device)

            logits = model(cat, num, arr_cat, arr_num, arr_mask_batch)
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
            for cat, num, arr_cat, arr_num, arr_mask_batch, labels_batch, weights_batch in val_loader:
                cat = cat.to(device)
                num = num.to(device)
                arr_cat = arr_cat.to(device)
                arr_num = arr_num.to(device)
                arr_mask_batch = arr_mask_batch.to(device)
                labels_batch = labels_batch.to(device)
                weights_batch = weights_batch.to(device)

                logits = model(cat, num, arr_cat, arr_num, arr_mask_batch)
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
                "arr_category_specs": [name for name, _ in ARR_CATEGORY_SPECS],
                "arr_numeric_feature_keys": list(ARR_NUMERIC_KEYS),
                "vocab_meta": vocab_meta,
                "arr_vocab_meta": arr_vocab_meta,
                "numeric_mean": numeric_mean.tolist(),
                "numeric_std": numeric_std.tolist(),
                "arr_numeric_mean": arr_numeric_mean.tolist(),
                "arr_numeric_std": arr_numeric_std.tolist(),
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

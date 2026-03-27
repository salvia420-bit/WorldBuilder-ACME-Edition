#!/usr/bin/env python3
"""
train_settlement_planner.py - Train the OutdoorML settlement planner
====================================================================

This model is the first stage of a disciplined two-stage OutdoorML path:
1. predict landblock archetype plus coarse family-count plan
2. condition the scene generator on that explicit plan
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
from dataclasses import dataclass

import numpy as np

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler
except ImportError:
    print("ERROR: PyTorch not found.")
    sys.exit(1)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
TENSOR_PATH = os.path.join(BASE_DIR, "pipeline_data", "reference", "settlement_planner_tensors.npz")
META_PATH = os.path.join(BASE_DIR, "pipeline_data", "reference", "settlement_planner_vocab.json")
MODEL_PATH = os.path.join(BASE_DIR, "pipeline_data", "models", "settlement_planner.pt")


@dataclass
class Config:
    epochs: int = 80
    batch_size: int = 128
    lr: float = 3e-4
    weight_decay: float = 1e-2
    hidden_dim: int = 256
    dropout: float = 0.15
    val_split: float = 0.15


def compute_archetype_weights(archetypes: np.ndarray, archetype_labels: list[str]) -> np.ndarray:
    counts = np.bincount(archetypes, minlength=len(archetype_labels)).astype(np.float32)
    weights = np.ones(len(archetype_labels), dtype=np.float32)
    label_to_idx = {label: idx for idx, label in enumerate(archetype_labels)}

    for idx, count in enumerate(counts):
        if count <= 0:
            weights[idx] = 0.0

    # Target the specific planner miss we keep seeing in generated outputs:
    # too many outposts, too few vendor-bearing town plans, not enough service nodes.
    if 'service_node' in label_to_idx:
        weights[label_to_idx['service_node']] = 1.20
    if 'vendor_portal_hub' in label_to_idx:
        weights[label_to_idx['vendor_portal_hub']] = 1.75
    if 'portal_creature_outpost' in label_to_idx:
        weights[label_to_idx['portal_creature_outpost']] = 0.90

    return weights


class PlannerDataset(Dataset):
    def __init__(
        self,
        contexts: np.ndarray,
        archetypes: np.ndarray,
        service_styles: np.ndarray,
        dense_service_compositions: np.ndarray,
        family_bins: np.ndarray,
    ):
        self.contexts = torch.from_numpy(contexts).float()
        self.archetypes = torch.from_numpy(archetypes).long()
        self.service_styles = torch.from_numpy(service_styles).long()
        self.dense_service_compositions = torch.from_numpy(dense_service_compositions).long()
        self.family_bins = torch.from_numpy(family_bins).long()

    def __len__(self) -> int:
        return len(self.contexts)

    def __getitem__(self, idx: int):
        return (
            self.contexts[idx],
            self.archetypes[idx],
            self.service_styles[idx],
            self.dense_service_compositions[idx],
            self.family_bins[idx],
        )


class SettlementPlanner(nn.Module):
    def __init__(
        self,
        context_dim: int,
        archetype_classes: int,
        family_heads: int,
        service_style_classes: int = 0,
        dense_service_composition_classes: int = 0,
    ):
        super().__init__()
        self.backbone = nn.Sequential(
            nn.Linear(context_dim, 256),
            nn.LayerNorm(256),
            nn.GELU(),
            nn.Dropout(0.15),
            nn.Linear(256, 256),
            nn.LayerNorm(256),
            nn.GELU(),
        )
        self.archetype_head = nn.Linear(256, archetype_classes)
        self.service_style_head = nn.Linear(256, service_style_classes) if service_style_classes > 0 else None
        self.dense_service_composition_head = (
            nn.Linear(256, dense_service_composition_classes) if dense_service_composition_classes > 0 else None
        )
        self.family_head = nn.Linear(256, family_heads * 4)
        self.family_heads = family_heads

    def forward(self, ctx: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor | None, torch.Tensor | None, torch.Tensor]:
        hidden = self.backbone(ctx)
        archetype_logits = self.archetype_head(hidden)
        service_style_logits = self.service_style_head(hidden) if self.service_style_head is not None else None
        dense_service_composition_logits = (
            self.dense_service_composition_head(hidden) if self.dense_service_composition_head is not None else None
        )
        family_logits = self.family_head(hidden).view(ctx.shape[0], self.family_heads, 4)
        return archetype_logits, service_style_logits, dense_service_composition_logits, family_logits


def compute_metrics(
    archetype_logits: torch.Tensor,
    archetypes: torch.Tensor,
    service_style_logits: torch.Tensor | None,
    service_styles: torch.Tensor,
    dense_service_composition_logits: torch.Tensor | None,
    dense_service_compositions: torch.Tensor,
    family_logits: torch.Tensor,
    family_bins: torch.Tensor,
) -> dict[str, float]:
    archetype_acc = (archetype_logits.argmax(dim=-1) == archetypes).float().mean().item()
    service_style_acc = 0.0
    dense_service_composition_acc = 0.0
    if service_style_logits is not None:
        service_style_acc = (service_style_logits.argmax(dim=-1) == service_styles).float().mean().item()
    if dense_service_composition_logits is not None:
        dense_service_composition_acc = (
            (dense_service_composition_logits.argmax(dim=-1) == dense_service_compositions).float().mean().item()
        )
    family_acc = (family_logits.argmax(dim=-1) == family_bins).float().mean().item()
    return {
        "archetype_acc": archetype_acc,
        "service_style_acc": service_style_acc,
        "dense_service_composition_acc": dense_service_composition_acc,
        "family_acc": family_acc,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the OutdoorML settlement planner")
    parser.add_argument("--epochs", type=int, default=Config.epochs)
    parser.add_argument("--batch", type=int, default=Config.batch_size)
    parser.add_argument("--lr", type=float, default=Config.lr)
    args = parser.parse_args()

    if not os.path.exists(TENSOR_PATH):
        print(f"ERROR: planner tensors missing: {TENSOR_PATH}")
        print("Run extract_settlement_planner_tensors.py first.")
        sys.exit(1)

    data = np.load(TENSOR_PATH)
    with open(META_PATH) as f:
        meta = json.load(f)

    contexts = data["contexts"]
    archetypes = data["archetypes"]
    service_styles = data["service_styles"]
    dense_service_compositions = data["dense_service_compositions"]
    family_bins = data["family_bins"]

    rng = np.random.RandomState(42)
    indices = rng.permutation(len(contexts))
    val_n = int(math.ceil(len(indices) * Config.val_split))
    val_idx = indices[:val_n]
    train_idx = indices[val_n:]

    train_ds = PlannerDataset(
        contexts[train_idx],
        archetypes[train_idx],
        service_styles[train_idx],
        dense_service_compositions[train_idx],
        family_bins[train_idx],
    )
    val_ds = PlannerDataset(
        contexts[val_idx],
        archetypes[val_idx],
        service_styles[val_idx],
        dense_service_compositions[val_idx],
        family_bins[val_idx],
    )

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    archetype_weights_np = compute_archetype_weights(archetypes[train_idx], meta["archetype_labels"])
    archetype_weights = torch.from_numpy(archetype_weights_np).float().to(device)
    model = SettlementPlanner(
        context_dim=contexts.shape[1],
        archetype_classes=len(meta["archetype_labels"]),
        family_heads=len(meta["family_labels"]),
        service_style_classes=len(meta.get("service_style_labels", [])),
        dense_service_composition_classes=len(meta.get("dense_service_composition_labels", [])),
    ).to(device)

    sample_weights = archetype_weights_np[archetypes[train_idx]]
    train_sampler = WeightedRandomSampler(
        weights=torch.from_numpy(sample_weights).double(),
        num_samples=len(train_idx),
        replacement=True,
    )
    train_loader = DataLoader(train_ds, batch_size=args.batch, sampler=train_sampler, drop_last=False)
    val_loader = DataLoader(val_ds, batch_size=args.batch, shuffle=False)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=Config.weight_decay)

    print("=" * 72)
    print("  Settlement Planner Training")
    print("=" * 72)
    print(f"  Train: {len(train_ds)}  Val: {len(val_ds)}  Context: {contexts.shape[1]}")
    print(f"  Device: {device}")
    print("  Archetype weights:")
    for label, weight in zip(meta["archetype_labels"], archetype_weights_np.tolist()):
        print(f"    {label:24s} {weight:.2f}")

    best_val = float("inf")
    best_state = None

    for epoch in range(args.epochs):
        model.train()
        train_loss = 0.0
        for ctx, arch, style, dense_comp, fam in train_loader:
            ctx = ctx.to(device)
            arch = arch.to(device)
            style = style.to(device)
            dense_comp = dense_comp.to(device)
            fam = fam.to(device)

            arch_logits, style_logits, dense_comp_logits, fam_logits = model(ctx)
            loss_arch = F.cross_entropy(arch_logits, arch, weight=archetype_weights)
            loss_style = (
                F.cross_entropy(style_logits, style)
                if style_logits is not None else torch.tensor(0.0, device=device)
            )
            loss_dense_comp = (
                F.cross_entropy(dense_comp_logits, dense_comp)
                if dense_comp_logits is not None else torch.tensor(0.0, device=device)
            )
            loss_fam = F.cross_entropy(fam_logits.reshape(-1, 4), fam.reshape(-1))
            loss = loss_arch + 0.35 * loss_style + 0.35 * loss_dense_comp + 0.6 * loss_fam

            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            optimizer.step()
            train_loss += loss.item()

        model.eval()
        val_loss = 0.0
        val_metrics = {
            "archetype_acc": 0.0,
            "service_style_acc": 0.0,
            "dense_service_composition_acc": 0.0,
            "family_acc": 0.0,
        }
        val_batches = 0
        with torch.no_grad():
            for ctx, arch, style, dense_comp, fam in val_loader:
                ctx = ctx.to(device)
                arch = arch.to(device)
                style = style.to(device)
                dense_comp = dense_comp.to(device)
                fam = fam.to(device)
                arch_logits, style_logits, dense_comp_logits, fam_logits = model(ctx)
                loss_arch = F.cross_entropy(arch_logits, arch, weight=archetype_weights)
                loss_style = (
                    F.cross_entropy(style_logits, style)
                    if style_logits is not None else torch.tensor(0.0, device=device)
                )
                loss_dense_comp = (
                    F.cross_entropy(dense_comp_logits, dense_comp)
                    if dense_comp_logits is not None else torch.tensor(0.0, device=device)
                )
                loss_fam = F.cross_entropy(fam_logits.reshape(-1, 4), fam.reshape(-1))
                loss = loss_arch + 0.35 * loss_style + 0.35 * loss_dense_comp + 0.6 * loss_fam
                val_loss += loss.item()
                batch_metrics = compute_metrics(
                    arch_logits,
                    arch,
                    style_logits,
                    style,
                    dense_comp_logits,
                    dense_comp,
                    fam_logits,
                    fam,
                )
                for key, value in batch_metrics.items():
                    val_metrics[key] += value
                val_batches += 1

        avg_train = train_loss / max(len(train_loader), 1)
        avg_val = val_loss / max(val_batches, 1)
        for key in val_metrics:
            val_metrics[key] /= max(val_batches, 1)

        if avg_val < best_val:
            best_val = avg_val
            best_state = {
                "model_state_dict": model.state_dict(),
                "context_dim": contexts.shape[1],
                "archetype_labels": meta["archetype_labels"],
                "service_style_labels": meta.get("service_style_labels", []),
                "dense_service_composition_labels": meta.get("dense_service_composition_labels", []),
                "family_labels": meta["family_labels"],
                "best_val_loss": best_val,
            }

        print(
            f"  Epoch {epoch + 1:3d}/{args.epochs} "
            f"train={avg_train:.4f} val={avg_val:.4f} "
            f"arch_acc={val_metrics['archetype_acc']:.3f} "
            f"style_acc={val_metrics['service_style_acc']:.3f} "
            f"dense_acc={val_metrics['dense_service_composition_acc']:.3f} "
            f"family_acc={val_metrics['family_acc']:.3f}"
        )

    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    if best_state is None:
        best_state = {
            "model_state_dict": model.state_dict(),
            "context_dim": contexts.shape[1],
            "archetype_labels": meta["archetype_labels"],
            "service_style_labels": meta.get("service_style_labels", []),
            "dense_service_composition_labels": meta.get("dense_service_composition_labels", []),
            "family_labels": meta["family_labels"],
            "best_val_loss": best_val,
        }
    torch.save(best_state, MODEL_PATH)
    print(f"\nSaved planner checkpoint: {MODEL_PATH}")
    print(f"Best val loss: {best_val:.4f}")


if __name__ == "__main__":
    random.seed(42)
    np.random.seed(42)
    torch.manual_seed(42)
    main()

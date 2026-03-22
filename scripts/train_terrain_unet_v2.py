#!/usr/bin/env python3
"""
train_terrain_unet_v2.py -- Improved terrain model with anti-overfitting measures.

Changes from v1:
  - 8x data augmentation (4 rotations x 2 flips on the 9x9 grids)
  - Smaller model (base_channels=32, ~1.4M params vs 5.4M)
  - Dropout layers for regularization
  - Early stopping with patience=10
  - Label smoothing on terrain classification
  - Separate best-height and best-terrain checkpoints

Usage:
    .venv311\Scripts\python.exe scripts\train_terrain_unet_v2.py

Outputs saved to models/v2/
"""

import json
import os
import sys
import time
import random
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader
from tqdm import tqdm

# =====================================================================
# Configuration
# =====================================================================
PROJECT_ROOT = Path(__file__).resolve().parent.parent
HEIGHTMAP_FILE = PROJECT_ROOT / "pipeline_data" / "heightmaps" / "retail_heightmaps.jsonl"
BIOME_FILE = PROJECT_ROOT / "pipeline_data" / "enrichment" / "biome_map.json"
MODEL_DIR = PROJECT_ROOT / "pipeline_data" / "models" / "v2"

GRID_SIZE = 9
MAP_SIZE = 255
NUM_TERRAIN_TYPES = 32

BIOME_NAMES = {
    "ocean": 0, "water": 1, "impassable_water": 2,
    "grassland": 3, "forest": 4, "desert": 5,
    "snow": 6, "swamp": 7, "barren": 8, "obsidian": 9,
}
NUM_BIOMES = len(BIOME_NAMES)
OCEAN_BIOMES = {"ocean", "water", "impassable_water"}
OCEAN_BIOME_IDS = {BIOME_NAMES[b] for b in OCEAN_BIOMES}

# Hyperparameters -- tuned for generalization
BATCH_SIZE = 128
EPOCHS = 120           # More epochs since we have early stopping
LEARNING_RATE = 5e-4   # Lower than v1
WEIGHT_DECAY = 1e-4    # Stronger regularization
HEIGHT_LOSS_WEIGHT = 1.0
TERRAIN_LOSS_WEIGHT = 0.5
LABEL_SMOOTHING = 0.1  # Prevent overconfident terrain predictions
DROPOUT = 0.15         # Light dropout
EARLY_STOP_PATIENCE = 15
BASE_CHANNELS = 32     # Half of v1 -- prevents memorization with 22K samples

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


# =====================================================================
# Data Augmentation
# =====================================================================
def augment_grids(height_9x9, terrain_9x9, cond_channels, rng):
    """
    Apply consistent geometric augmentation to target + all condition channels.
    Returns augmented copies. 8 possible transforms (4 rot x 2 flip).
    
    All inputs are numpy arrays. height is (9,9), terrain is (9,9),
    cond_channels is (C, 9, 9).
    """
    k = rng.randint(0, 3)   # 0,1,2,3 = 0,90,180,270 degrees
    flip = rng.random() < 0.5

    def transform(arr_2d):
        a = np.rot90(arr_2d, k=k)
        if flip:
            a = np.fliplr(a)
        return np.ascontiguousarray(a)

    h_aug = transform(height_9x9)
    t_aug = transform(terrain_9x9)

    # Apply same transform to each condition channel
    c_aug = np.stack([transform(cond_channels[i]) for i in range(cond_channels.shape[0])], axis=0)

    return h_aug, t_aug, c_aug


# =====================================================================
# Dataset with Augmentation
# =====================================================================
class TerrainDatasetV2(Dataset):
    """
    Land-only terrain dataset with on-the-fly augmentation.
    
    Condition channels (17 total):
        - 8 neighbor heightmaps (normalized)
        - 8 neighbor terrain maps (normalized)
        - 1 biome ID (broadcast)
    """

    def __init__(self, heightmap_file, biome_grid, exclude_biome_ids=None, augment=True):
        print(f"Loading heightmaps from {heightmap_file}...")
        self.grid = {}
        self.coords = []
        self.biome_grid = biome_grid
        self.augment = augment
        exclude_biome_ids = exclude_biome_ids or set()

        total_loaded = 0
        skipped_ocean = 0
        with open(heightmap_file, "r", encoding="utf-8-sig") as f:
            for line in tqdm(f, desc="Reading JSONL", total=65025):
                rec = json.loads(line)
                x, y = rec["lbX"], rec["lbY"]
                self.grid[(x, y)] = rec
                total_loaded += 1

                bx = min(x, biome_grid.shape[0] - 1)
                by = min(y, biome_grid.shape[1] - 1)
                biome_id = int(biome_grid[bx, by])
                if biome_id not in exclude_biome_ids:
                    self.coords.append((x, y))
                else:
                    skipped_ocean += 1

        print(f"Loaded {total_loaded} total, excluded {skipped_ocean} ocean.")
        print(f"Training on {len(self.coords)} land blocks.")

        # Height normalization from LAND blocks only
        all_h = []
        for x, y in self.coords:
            all_h.extend(self.grid[(x, y)]["heightIndices"])
        all_h = np.array(all_h, dtype=np.float32)
        self.height_mean = float(np.mean(all_h))
        self.height_std = float(np.std(all_h)) + 1e-8
        print(f"Height stats (land): mean={self.height_mean:.1f}, std={self.height_std:.1f}")

        # Per-worker RNG for augmentation (seeded per-worker in worker_init_fn)
        self.rng = np.random.RandomState(42)

    def __len__(self):
        return len(self.coords)

    def _get_heightmap(self, x, y):
        rec = self.grid.get((x, y))
        if rec is None:
            return np.zeros((GRID_SIZE, GRID_SIZE), dtype=np.float32)
        h = np.array(rec["heightIndices"], dtype=np.float32).reshape(GRID_SIZE, GRID_SIZE)
        return (h - self.height_mean) / self.height_std

    def _get_terrain_map(self, x, y):
        rec = self.grid.get((x, y))
        if rec is None:
            return np.zeros((GRID_SIZE, GRID_SIZE), dtype=np.int64)
        return np.array(rec["terrainTypes"], dtype=np.int64).reshape(GRID_SIZE, GRID_SIZE)

    def __getitem__(self, idx):
        x, y = self.coords[idx]

        target_height = self._get_heightmap(x, y)
        target_terrain = self._get_terrain_map(x, y)

        neighbor_offsets = [
            (0, 1), (1, 1), (1, 0), (1, -1),
            (0, -1), (-1, -1), (-1, 0), (-1, 1)
        ]

        cond_channels = []
        for dx, dy in neighbor_offsets:
            cond_channels.append(self._get_heightmap(x + dx, y + dy))
        for dx, dy in neighbor_offsets:
            nt = self._get_terrain_map(x + dx, y + dy).astype(np.float32) / NUM_TERRAIN_TYPES
            cond_channels.append(nt)

        bx = min(x, self.biome_grid.shape[0] - 1)
        by = min(y, self.biome_grid.shape[1] - 1)
        biome_id = self.biome_grid[bx, by] / NUM_BIOMES
        cond_channels.append(np.full((GRID_SIZE, GRID_SIZE), biome_id, dtype=np.float32))

        condition = np.stack(cond_channels, axis=0)  # (17, 9, 9)

        # Augmentation (training only)
        if self.augment:
            target_height, target_terrain, condition = augment_grids(
                target_height, target_terrain, condition, self.rng
            )

        return (
            torch.from_numpy(condition.copy()),
            torch.from_numpy(target_height.copy()).unsqueeze(0),
            torch.from_numpy(target_terrain.copy()),
        )


# =====================================================================
# Model V2: Smaller + Dropout
# =====================================================================
class ResBlockV2(nn.Module):
    """Residual block with GroupNorm + SiLU + Dropout."""
    def __init__(self, channels, dropout=0.0):
        super().__init__()
        self.norm1 = nn.GroupNorm(min(8, channels), channels)
        self.conv1 = nn.Conv2d(channels, channels, 3, padding=1)
        self.norm2 = nn.GroupNorm(min(8, channels), channels)
        self.conv2 = nn.Conv2d(channels, channels, 3, padding=1)
        self.drop = nn.Dropout2d(dropout) if dropout > 0 else nn.Identity()

    def forward(self, x):
        h = self.conv1(F.silu(self.norm1(x)))
        h = self.drop(h)
        h = self.conv2(F.silu(self.norm2(h)))
        return x + h


class TerrainUNetV2(nn.Module):
    """
    Compact U-Net V2: fewer params, dropout, better regularization.
    
    Down: 9 -> 5 -> 3
    Up:   3 -> 5 -> 9
    """
    def __init__(self, in_channels=17, base_channels=32, dropout=0.15):
        super().__init__()
        C = base_channels

        # Encoder
        self.enc1 = nn.Sequential(
            nn.Conv2d(in_channels, C, 3, padding=1),
            nn.SiLU(),
            ResBlockV2(C, dropout),
        )
        self.down1 = nn.Conv2d(C, C * 2, 3, stride=2, padding=1)

        self.enc2 = nn.Sequential(
            nn.SiLU(),
            ResBlockV2(C * 2, dropout),
        )
        self.down2 = nn.Conv2d(C * 2, C * 4, 3, stride=2, padding=1)

        # Bottleneck
        self.bottleneck = nn.Sequential(
            ResBlockV2(C * 4, dropout),
            ResBlockV2(C * 4, dropout),
        )

        # Decoder
        self.up2 = nn.ConvTranspose2d(C * 4, C * 2, 3, stride=2, padding=1, output_padding=0)
        self.dec2 = nn.Sequential(
            ResBlockV2(C * 2 + C * 2, dropout),
            nn.Conv2d(C * 2 + C * 2, C * 2, 1),
            ResBlockV2(C * 2, dropout),
        )

        self.up1 = nn.ConvTranspose2d(C * 2, C, 4, stride=2, padding=1, output_padding=1)
        self.dec1 = nn.Sequential(
            ResBlockV2(C + C, dropout),
            nn.Conv2d(C + C, C, 1),
            ResBlockV2(C, dropout),
        )

        # Dual heads
        self.height_head = nn.Sequential(
            nn.Conv2d(C, C // 2, 1),
            nn.SiLU(),
            nn.Dropout2d(dropout),
            nn.Conv2d(C // 2, 1, 1),
        )
        self.terrain_head = nn.Sequential(
            nn.Conv2d(C, C // 2, 1),
            nn.SiLU(),
            nn.Dropout2d(dropout),
            nn.Conv2d(C // 2, NUM_TERRAIN_TYPES, 1),
        )

    def forward(self, x):
        e1 = self.enc1(x)
        e2 = self.enc2(self.down1(e1))
        b = self.bottleneck(self.down2(e2))

        d2 = self.up2(b)
        d2 = self.dec2(torch.cat([d2, e2], dim=1))

        d1 = self.up1(d2)
        if d1.shape[-2:] != e1.shape[-2:]:
            d1 = F.interpolate(d1, size=e1.shape[-2:], mode='bilinear', align_corners=False)
        d1 = self.dec1(torch.cat([d1, e1], dim=1))

        return self.height_head(d1), self.terrain_head(d1)


# =====================================================================
# Worker init for reproducible augmentation per DataLoader worker
# =====================================================================
def worker_init_fn(worker_id):
    np.random.seed(42 + worker_id)


# =====================================================================
# Training
# =====================================================================
def train():
    print("=" * 70)
    print("  TERRAIN U-NET V2 TRAINING -- GTX 1070 (Improved)")
    print("=" * 70)
    print(f"  Device:         {DEVICE}")
    if DEVICE == "cuda":
        print(f"  GPU:            {torch.cuda.get_device_name(0)}")
        vram = torch.cuda.get_device_properties(0).total_memory / 1024**3
        print(f"  VRAM:           {vram:.1f} GB")
    print(f"  Base channels:  {BASE_CHANNELS} (v1 was 64)")
    print(f"  Dropout:        {DROPOUT}")
    print(f"  Augmentation:   8x (4 rot x 2 flip)")
    print(f"  Early stopping: patience={EARLY_STOP_PATIENCE}")
    print(f"  Label smooth:   {LABEL_SMOOTHING}")
    print(f"  Batch size:     {BATCH_SIZE}")
    print(f"  Max epochs:     {EPOCHS}")
    print(f"  LR:             {LEARNING_RATE}")
    print("=" * 70)

    # -- Load biome grid ---------------------------------------------------
    print("\nLoading biome map...")
    if BIOME_FILE.exists():
        with open(BIOME_FILE, "r", encoding="utf-8-sig") as f:
            biome_data = json.load(f)
        biome_list = biome_data.get("biomeGrid", [])
        if isinstance(biome_list, list) and len(biome_list) > 0:
            def biome_to_int(val):
                return BIOME_NAMES.get(val, 0) if isinstance(val, str) else int(val)

            if isinstance(biome_list[0], list):
                biome_grid = np.array(
                    [[biome_to_int(v) for v in row] for row in biome_list], dtype=np.int32
                )
            else:
                side = int(np.sqrt(len(biome_list)))
                biome_grid = np.array(
                    [biome_to_int(v) for v in biome_list], dtype=np.int32
                ).reshape(side, side)
            print(f"  Biome grid: {biome_grid.shape}")
            unique, counts = np.unique(biome_grid, return_counts=True)
            inv_map = {v: k for k, v in BIOME_NAMES.items()}
            for uid, cnt in zip(unique, counts):
                name = inv_map.get(uid, f"unknown_{uid}")
                print(f"    {name}: {cnt} ({cnt*100/biome_grid.size:.1f}%)")
        else:
            biome_grid = np.zeros((MAP_SIZE, MAP_SIZE), dtype=np.int32)
    else:
        biome_grid = np.zeros((MAP_SIZE, MAP_SIZE), dtype=np.int32)

    # -- Datasets ----------------------------------------------------------
    train_ds = TerrainDatasetV2(HEIGHTMAP_FILE, biome_grid,
                                exclude_biome_ids=OCEAN_BIOME_IDS, augment=True)
    val_ds = TerrainDatasetV2(HEIGHTMAP_FILE, biome_grid,
                              exclude_biome_ids=OCEAN_BIOME_IDS, augment=False)

    # Use the same underlying data but different indices for train/val
    n = len(train_ds)
    n_val = max(1, n // 10)
    n_train = n - n_val
    indices = list(range(n))
    rng = random.Random(42)
    rng.shuffle(indices)
    train_indices = indices[:n_train]
    val_indices = indices[n_train:]

    train_subset = torch.utils.data.Subset(train_ds, train_indices)
    val_subset = torch.utils.data.Subset(val_ds, val_indices)

    print(f"  Train: {n_train} (augmented 8x = ~{n_train*8} effective)")
    print(f"  Val:   {n_val} (no augmentation)")

    train_loader = DataLoader(
        train_subset, batch_size=BATCH_SIZE, shuffle=True,
        num_workers=2, pin_memory=True, persistent_workers=True,
        worker_init_fn=worker_init_fn
    )
    val_loader = DataLoader(
        val_subset, batch_size=BATCH_SIZE, shuffle=False,
        num_workers=2, pin_memory=True, persistent_workers=True
    )

    # -- Model -------------------------------------------------------------
    model = TerrainUNetV2(
        in_channels=17, base_channels=BASE_CHANNELS, dropout=DROPOUT
    ).to(DEVICE)
    n_params = sum(p.numel() for p in model.parameters())
    print(f"  Model params:   {n_params:,} ({n_params * 4 / 1024**2:.1f} MB)")
    print(f"  v1 had:         5,430,273 (20.7 MB) -- {n_params/5430273*100:.0f}% of v1")

    optimizer = torch.optim.AdamW(model.parameters(), lr=LEARNING_RATE, weight_decay=WEIGHT_DECAY)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=EPOCHS, eta_min=1e-6)

    height_criterion = nn.MSELoss()
    terrain_criterion = nn.CrossEntropyLoss(label_smoothing=LABEL_SMOOTHING)

    # -- Training loop -----------------------------------------------------
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    best_val_loss = float("inf")
    patience_counter = 0
    train_losses = []
    val_losses = []
    val_maes = []
    val_accs = []

    # Use train_ds for normalization stats (they share the same underlying data)
    ds_stats = train_ds

    t0 = time.time()
    stopped_epoch = EPOCHS

    for epoch in range(1, EPOCHS + 1):
        # Train
        model.train()
        epoch_loss = 0.0
        for cond, target_h, target_t in train_loader:
            cond = cond.to(DEVICE)
            target_h = target_h.to(DEVICE)
            target_t = target_t.to(DEVICE)

            h_pred, t_pred = model(cond)
            loss_h = height_criterion(h_pred, target_h)
            loss_t = terrain_criterion(t_pred, target_t)
            loss = HEIGHT_LOSS_WEIGHT * loss_h + TERRAIN_LOSS_WEIGHT * loss_t

            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            epoch_loss += loss.item() * cond.size(0)

        train_loss = epoch_loss / n_train
        train_losses.append(train_loss)

        # Validate
        model.eval()
        val_loss_sum = 0.0
        val_h_mae = 0.0
        val_t_correct = 0
        with torch.no_grad():
            for cond, target_h, target_t in val_loader:
                cond = cond.to(DEVICE)
                target_h = target_h.to(DEVICE)
                target_t = target_t.to(DEVICE)

                h_pred, t_pred = model(cond)
                loss_h = height_criterion(h_pred, target_h)
                loss_t = terrain_criterion(t_pred, target_t)
                loss = HEIGHT_LOSS_WEIGHT * loss_h + TERRAIN_LOSS_WEIGHT * loss_t
                val_loss_sum += loss.item() * cond.size(0)

                h_dn = h_pred * ds_stats.height_std + ds_stats.height_mean
                t_dn = target_h * ds_stats.height_std + ds_stats.height_mean
                val_h_mae += torch.abs(h_dn - t_dn).sum().item()
                val_t_correct += (t_pred.argmax(1) == target_t).sum().item()

        val_loss = val_loss_sum / n_val
        val_losses.append(val_loss)
        avg_mae = val_h_mae / (n_val * GRID_SIZE * GRID_SIZE)
        avg_acc = val_t_correct / (n_val * GRID_SIZE * GRID_SIZE) * 100
        val_maes.append(avg_mae)
        val_accs.append(avg_acc)

        scheduler.step()
        lr = scheduler.get_last_lr()[0]

        elapsed = time.time() - t0
        improved = ""

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            patience_counter = 0
            improved = " *BEST*"
            torch.save({
                "model_state_dict": model.state_dict(),
                "optimizer_state_dict": optimizer.state_dict(),
                "epoch": epoch,
                "val_loss": val_loss,
                "val_mae": avg_mae,
                "val_terrain_acc": avg_acc,
                "height_mean": ds_stats.height_mean,
                "height_std": ds_stats.height_std,
            }, MODEL_DIR / "terrain_unet_v2.pt")
        else:
            patience_counter += 1

        print(
            f"  Epoch {epoch:3d}/{EPOCHS} | "
            f"train {train_loss:.4f} | val {val_loss:.4f} | "
            f"MAE {avg_mae:.2f} | acc {avg_acc:.1f}% | "
            f"lr {lr:.2e} | {elapsed:.0f}s{improved}"
        )

        # Early stopping
        if patience_counter >= EARLY_STOP_PATIENCE:
            print(f"\n  Early stopping at epoch {epoch} (no improvement for {EARLY_STOP_PATIENCE} epochs)")
            stopped_epoch = epoch
            break

    total_time = time.time() - t0
    print(f"\n{'=' * 70}")
    print(f"  Training complete in {total_time:.0f}s ({total_time/60:.1f} min)")
    print(f"  Best val loss: {best_val_loss:.4f}")
    print(f"  Stopped at epoch: {stopped_epoch}")
    print(f"{'=' * 70}")

    # -- Save config -------------------------------------------------------
    config = {
        "model": "TerrainUNetV2",
        "version": 2,
        "in_channels": 17,
        "base_channels": BASE_CHANNELS,
        "dropout": DROPOUT,
        "grid_size": GRID_SIZE,
        "num_terrain_types": NUM_TERRAIN_TYPES,
        "height_mean": ds_stats.height_mean,
        "height_std": ds_stats.height_std,
        "best_val_loss": best_val_loss,
        "best_val_mae": min(val_maes) if val_maes else None,
        "best_val_terrain_acc": max(val_accs) if val_accs else None,
        "epochs_trained": stopped_epoch,
        "max_epochs": EPOCHS,
        "batch_size": BATCH_SIZE,
        "learning_rate": LEARNING_RATE,
        "weight_decay": WEIGHT_DECAY,
        "label_smoothing": LABEL_SMOOTHING,
        "augmentation": "8x (4rot x 2flip)",
        "early_stop_patience": EARLY_STOP_PATIENCE,
        "total_samples": len(train_ds),
        "train_samples": n_train,
        "val_samples": n_val,
        "training_time_seconds": total_time,
        "device": DEVICE,
        "gpu": torch.cuda.get_device_name(0) if DEVICE == "cuda" else "cpu",
        "parameters": n_params,
    }
    with open(MODEL_DIR / "terrain_unet_v2_config.json", "w") as f:
        json.dump(config, f, indent=2)
    print(f"  Config: {MODEL_DIR / 'terrain_unet_v2_config.json'}")

    # -- Plots -------------------------------------------------------------
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        fig, axes = plt.subplots(2, 2, figsize=(14, 10))

        # Loss
        ax = axes[0, 0]
        ax.plot(range(1, len(train_losses)+1), train_losses, label="Train", lw=2)
        ax.plot(range(1, len(val_losses)+1), val_losses, label="Val", lw=2)
        ax.set_xlabel("Epoch"); ax.set_ylabel("Loss")
        ax.set_title("Loss (v2: augmented + smaller model)")
        ax.legend(); ax.grid(True, alpha=0.3)

        # Val loss zoomed
        ax = axes[0, 1]
        ax.plot(range(1, len(val_losses)+1), val_losses, label="Val Loss", lw=2, color="tab:orange")
        ax.axhline(y=best_val_loss, color='r', linestyle='--', alpha=0.5, label=f"Best: {best_val_loss:.4f}")
        ax.set_xlabel("Epoch"); ax.set_ylabel("Val Loss")
        ax.set_title("Validation Loss Detail")
        ax.legend(); ax.grid(True, alpha=0.3)

        # MAE
        ax = axes[1, 0]
        ax.plot(range(1, len(val_maes)+1), val_maes, lw=2, color="tab:green")
        ax.set_xlabel("Epoch"); ax.set_ylabel("Height MAE (indices)")
        ax.set_title("Height MAE on Validation Set")
        ax.grid(True, alpha=0.3)

        # Terrain accuracy
        ax = axes[1, 1]
        ax.plot(range(1, len(val_accs)+1), val_accs, lw=2, color="tab:purple")
        ax.set_xlabel("Epoch"); ax.set_ylabel("Accuracy (%)")
        ax.set_title("Terrain Type Accuracy on Validation Set")
        ax.grid(True, alpha=0.3)

        fig.suptitle("Terrain U-Net V2 Training -- GTX 1070", fontsize=14, fontweight='bold')
        fig.tight_layout()
        fig.savefig(MODEL_DIR / "training_v2.png", dpi=150)
        print(f"  Plots: {MODEL_DIR / 'training_v2.png'}")
    except Exception as e:
        print(f"  Could not save plots: {e}")

    # -- VRAM report -------------------------------------------------------
    if DEVICE == "cuda":
        alloc = torch.cuda.max_memory_allocated() / 1024**2
        resv = torch.cuda.max_memory_reserved() / 1024**2
        print(f"\n  GPU Memory:")
        print(f"    Peak allocated: {alloc:.0f} MB")
        print(f"    Peak reserved:  {resv:.0f} MB")

    # -- Compare with v1 ---------------------------------------------------
    v1_config_path = PROJECT_ROOT / "pipeline_data" / "models" / "v1" / "terrain_unet_config.json"
    if v1_config_path.exists():
        with open(v1_config_path) as f:
            v1 = json.load(f)
        print(f"\n  V1 vs V2 Comparison:")
        print(f"    {'Metric':<25} {'V1':>12} {'V2':>12}")
        print(f"    {'-'*25} {'-'*12} {'-'*12}")
        print(f"    {'Parameters':<25} {v1['parameters']:>12,} {n_params:>12,}")
        print(f"    {'Best val loss':<25} {v1['best_val_loss']:>12.4f} {best_val_loss:>12.4f}")
        best_mae = min(val_maes) if val_maes else 0
        best_acc = max(val_accs) if val_accs else 0
        print(f"    {'Best MAE':<25} {'~2.00':>12} {best_mae:>12.2f}")
        print(f"    {'Best terrain acc':<25} {'~80%':>12} {best_acc:>11.1f}%")
        print(f"    {'Training time':<25} {v1['training_time_seconds']:>11.0f}s {total_time:>11.0f}s")
        print(f"    {'Augmentation':<25} {'None':>12} {'8x':>12}")


if __name__ == "__main__":
    train()

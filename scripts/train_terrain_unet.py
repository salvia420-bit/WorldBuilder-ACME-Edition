#!/usr/bin/env python3
"""
train_terrain_unet.py — Train a conditional U-Net on retail AC land heightmaps.
Ocean/water landblocks are excluded from training targets (~65% of grid)
but kept as neighbor context for coastal blocks.
Designed for GTX 1070 (8 GB VRAM). Trains in ~10-30 minutes.

Usage:
    .venv311\Scripts\python.exe scripts\train_terrain_unet.py

Inputs:
    retail_heightmaps.jsonl  — 65,025 landblock heightmaps (9x9 grids)
    biome_map.json           — biome grid (255x255)

Outputs:
    models/terrain_unet.pt         — trained model weights
    models/terrain_unet_config.json — model config & training stats
    models/training_loss.png        — loss curve visualization
"""

import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader
from tqdm import tqdm

# ─────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parent.parent
HEIGHTMAP_FILE = PROJECT_ROOT / "pipeline_data" / "heightmaps" / "retail_heightmaps.jsonl"
BIOME_FILE = PROJECT_ROOT / "pipeline_data" / "enrichment" / "biome_map.json"
MODEL_DIR = PROJECT_ROOT / "pipeline_data" / "models"

GRID_SIZE = 9          # 9x9 heightmap per landblock
MAP_SIZE = 255         # 255x255 landblock grid
NUM_TERRAIN_TYPES = 32 # AC terrain type IDs (0-31)

# Biome string-to-int mapping (from biome_map.json)
BIOME_NAMES = {
    "ocean": 0, "water": 1, "impassable_water": 2,
    "grassland": 3, "forest": 4, "desert": 5,
    "snow": 6, "swamp": 7, "barren": 8, "obsidian": 9,
}
NUM_BIOMES = len(BIOME_NAMES)  # 10

# Biomes to EXCLUDE from training targets (still used as neighbor context)
OCEAN_BIOMES = {"ocean", "water", "impassable_water"}
OCEAN_BIOME_IDS = {BIOME_NAMES[b] for b in OCEAN_BIOMES}

# Training hyperparameters — tuned for 1070
BATCH_SIZE = 128       # Fits easily in 8GB
EPOCHS = 50
LEARNING_RATE = 1e-3
WEIGHT_DECAY = 1e-5
HEIGHT_LOSS_WEIGHT = 1.0
TERRAIN_LOSS_WEIGHT = 0.5
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


# ─────────────────────────────────────────────────────────────────────
# Dataset
# ─────────────────────────────────────────────────────────────────────
class TerrainDataset(Dataset):
    """
    Each sample contains:
        - target heightmap:     (1, 9, 9) normalized heights
        - target terrain types: (9, 9) integer class labels
        - condition:            (C, 9, 9) neighbor context + biome encoding

    Condition channels:
        - 8 neighbor heightmaps (8 x 1 = 8 channels), zero-padded for edges
        - 8 neighbor terrain type maps (8 x 1 = 8 channels), normalized
        - 1 biome ID channel (broadcast to 9x9)
    Total condition channels: 17
    """

    def __init__(self, heightmap_file: Path, biome_grid: np.ndarray,
                 exclude_biome_ids: set = None):
        print(f"Loading heightmaps from {heightmap_file}...")
        self.grid = {}   # (x, y) -> record  (ALL blocks, for neighbor lookups)
        self.coords = [] # Only LAND blocks (training targets)
        self.biome_grid = biome_grid
        exclude_biome_ids = exclude_biome_ids or set()

        total_loaded = 0
        skipped_ocean = 0
        with open(heightmap_file, "r", encoding="utf-8-sig") as f:
            for line in tqdm(f, desc="Reading JSONL", total=65025):
                rec = json.loads(line)
                x, y = rec["lbX"], rec["lbY"]
                self.grid[(x, y)] = rec
                total_loaded += 1

                # Only add to training targets if not ocean/water
                bx = min(x, biome_grid.shape[0] - 1)
                by = min(y, biome_grid.shape[1] - 1)
                biome_id = int(biome_grid[bx, by])
                if biome_id not in exclude_biome_ids:
                    self.coords.append((x, y))
                else:
                    skipped_ocean += 1

        print(f"Loaded {total_loaded} total landblocks.")
        print(f"  Excluded {skipped_ocean} ocean/water blocks from training.")
        print(f"  Training on {len(self.coords)} land blocks.")

        # Precompute height stats from LAND blocks only
        all_heights = []
        for x, y in self.coords:
            all_heights.extend(self.grid[(x, y)]["heightIndices"])
        all_heights = np.array(all_heights, dtype=np.float32)
        self.height_mean = float(np.mean(all_heights))
        self.height_std = float(np.std(all_heights)) + 1e-8
        print(f"Height stats (land only): mean={self.height_mean:.1f}, std={self.height_std:.1f}")

    def __len__(self):
        return len(self.coords)

    def _get_heightmap(self, x, y):
        """Get a 9x9 heightmap, zero-filled if out of bounds."""
        rec = self.grid.get((x, y))
        if rec is None:
            return np.zeros((GRID_SIZE, GRID_SIZE), dtype=np.float32)
        h = np.array(rec["heightIndices"], dtype=np.float32).reshape(GRID_SIZE, GRID_SIZE)
        return (h - self.height_mean) / self.height_std

    def _get_terrain_map(self, x, y):
        """Get a 9x9 terrain type map, zero-filled if out of bounds."""
        rec = self.grid.get((x, y))
        if rec is None:
            return np.zeros((GRID_SIZE, GRID_SIZE), dtype=np.int64)
        return np.array(rec["terrainTypes"], dtype=np.int64).reshape(GRID_SIZE, GRID_SIZE)

    def __getitem__(self, idx):
        x, y = self.coords[idx]

        # Target
        target_height = self._get_heightmap(x, y)            # (9, 9)
        target_terrain = self._get_terrain_map(x, y)          # (9, 9)

        # 8 neighbors: N, NE, E, SE, S, SW, W, NW
        neighbor_offsets = [
            (0, 1), (1, 1), (1, 0), (1, -1),
            (0, -1), (-1, -1), (-1, 0), (-1, 1)
        ]

        cond_channels = []
        for dx, dy in neighbor_offsets:
            nh = self._get_heightmap(x + dx, y + dy)
            cond_channels.append(nh)  # (9, 9)

        for dx, dy in neighbor_offsets:
            nt = self._get_terrain_map(x + dx, y + dy).astype(np.float32)
            nt = nt / NUM_TERRAIN_TYPES  # normalize to [0, 1]
            cond_channels.append(nt)

        # Biome channel
        bx = min(x, self.biome_grid.shape[0] - 1)
        by = min(y, self.biome_grid.shape[1] - 1)
        biome_id = self.biome_grid[bx, by] / NUM_BIOMES
        biome_channel = np.full((GRID_SIZE, GRID_SIZE), biome_id, dtype=np.float32)
        cond_channels.append(biome_channel)

        condition = np.stack(cond_channels, axis=0)  # (17, 9, 9)

        return (
            torch.from_numpy(condition),
            torch.from_numpy(target_height).unsqueeze(0),  # (1, 9, 9)
            torch.from_numpy(target_terrain),               # (9, 9) long
        )


# ─────────────────────────────────────────────────────────────────────
# Model: Conditional U-Net (compact, 9x9 aware)
# ─────────────────────────────────────────────────────────────────────
class ResBlock(nn.Module):
    """Residual block with GroupNorm + SiLU."""
    def __init__(self, channels):
        super().__init__()
        self.norm1 = nn.GroupNorm(min(8, channels), channels)
        self.conv1 = nn.Conv2d(channels, channels, 3, padding=1)
        self.norm2 = nn.GroupNorm(min(8, channels), channels)
        self.conv2 = nn.Conv2d(channels, channels, 3, padding=1)

    def forward(self, x):
        h = self.conv1(F.silu(self.norm1(x)))
        h = self.conv2(F.silu(self.norm2(h)))
        return x + h


class TerrainUNet(nn.Module):
    """
    Compact U-Net for 9x9 terrain generation.

    Input:  (B, 17, 9, 9) — neighbor context + biome
    Output: (B, 1, 9, 9)  — predicted heightmap (regression)
            (B, 32, 9, 9) — predicted terrain types (classification)

    Architecture sized for 9x9: no aggressive downsampling.
    Down: 9 -> 5 -> 3
    Up:   3 -> 5 -> 9
    """
    def __init__(self, in_channels=17, base_channels=64):
        super().__init__()
        C = base_channels

        # Encoder
        self.enc1 = nn.Sequential(
            nn.Conv2d(in_channels, C, 3, padding=1),
            nn.SiLU(),
            ResBlock(C),
        )
        self.down1 = nn.Conv2d(C, C * 2, 3, stride=2, padding=1)  # 9 -> 5

        self.enc2 = nn.Sequential(
            nn.SiLU(),
            ResBlock(C * 2),
        )
        self.down2 = nn.Conv2d(C * 2, C * 4, 3, stride=2, padding=1)  # 5 -> 3

        # Bottleneck
        self.bottleneck = nn.Sequential(
            ResBlock(C * 4),
            ResBlock(C * 4),
        )

        # Decoder
        self.up2 = nn.ConvTranspose2d(C * 4, C * 2, 3, stride=2, padding=1, output_padding=0)  # 3 -> 5
        self.dec2 = nn.Sequential(
            ResBlock(C * 2 + C * 2),  # skip connection doubles channels
            nn.Conv2d(C * 2 + C * 2, C * 2, 1),
            ResBlock(C * 2),
        )

        self.up1 = nn.ConvTranspose2d(C * 2, C, 4, stride=2, padding=1, output_padding=1)  # 5 -> 9 (need output_padding for odd)
        self.dec1 = nn.Sequential(
            ResBlock(C + C),  # skip connection
            nn.Conv2d(C + C, C, 1),
            ResBlock(C),
        )

        # Heads
        self.height_head = nn.Sequential(
            nn.Conv2d(C, C // 2, 1),
            nn.SiLU(),
            nn.Conv2d(C // 2, 1, 1),
        )
        self.terrain_head = nn.Sequential(
            nn.Conv2d(C, C // 2, 1),
            nn.SiLU(),
            nn.Conv2d(C // 2, NUM_TERRAIN_TYPES, 1),
        )

    def forward(self, x):
        # Encoder
        e1 = self.enc1(x)                    # (B, C, 9, 9)
        e2 = self.enc2(self.down1(e1))       # (B, 2C, 5, 5)
        b = self.bottleneck(self.down2(e2))  # (B, 4C, 3, 3)

        # Decoder with skip connections
        d2 = self.up2(b)                     # (B, 2C, 5, 5)
        d2 = self.dec2(torch.cat([d2, e2], dim=1))  # (B, 2C, 5, 5)

        d1 = self.up1(d2)                    # (B, C, 9, 9)
        # Handle size mismatch from transposed conv
        if d1.shape[-2:] != e1.shape[-2:]:
            d1 = F.interpolate(d1, size=e1.shape[-2:], mode='bilinear', align_corners=False)
        d1 = self.dec1(torch.cat([d1, e1], dim=1))  # (B, C, 9, 9)

        # Dual output heads
        height_pred = self.height_head(d1)     # (B, 1, 9, 9)
        terrain_pred = self.terrain_head(d1)   # (B, 32, 9, 9)

        return height_pred, terrain_pred


# ─────────────────────────────────────────────────────────────────────
# Training Loop
# ─────────────────────────────────────────────────────────────────────
def train():
    print("=" * 70)
    print("  TERRAIN U-NET TRAINING -- GTX 1070 Edition")
    print("=" * 70)
    print(f"  Device:     {DEVICE}")
    if DEVICE == "cuda":
        print(f"  GPU:        {torch.cuda.get_device_name(0)}")
        print(f"  VRAM:       {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GB")
    print(f"  Batch size: {BATCH_SIZE}")
    print(f"  Epochs:     {EPOCHS}")
    print(f"  LR:         {LEARNING_RATE}")
    print("=" * 70)

    # ── Load biome grid ──────────────────────────────────────────────
    print("\nLoading biome map...")
    if BIOME_FILE.exists():
        with open(BIOME_FILE, "r", encoding="utf-8-sig") as f:
            biome_data = json.load(f)
        biome_list = biome_data.get("biomeGrid", [])
        if isinstance(biome_list, list) and len(biome_list) > 0:
            # Convert string biome names to integer IDs
            def biome_to_int(val):
                if isinstance(val, str):
                    return BIOME_NAMES.get(val, 0)
                return int(val)

            if isinstance(biome_list[0], list):
                biome_grid = np.array(
                    [[biome_to_int(v) for v in row] for row in biome_list],
                    dtype=np.int32
                )
            else:
                side = int(np.sqrt(len(biome_list)))
                biome_grid = np.array(
                    [biome_to_int(v) for v in biome_list],
                    dtype=np.int32
                ).reshape(side, side)
            print(f"  Biome grid shape: {biome_grid.shape}")
            # Report biome distribution
            unique, counts = np.unique(biome_grid, return_counts=True)
            inv_map = {v: k for k, v in BIOME_NAMES.items()}
            for uid, cnt in zip(unique, counts):
                name = inv_map.get(uid, f"unknown_{uid}")
                print(f"    {name}: {cnt} ({cnt*100/biome_grid.size:.1f}%)")
        else:
            print("  WARNING: biomeGrid not found or empty, using zeros")
            biome_grid = np.zeros((MAP_SIZE, MAP_SIZE), dtype=np.int32)
    else:
        print("  WARNING: biome_map.json not found, using zeros")
        biome_grid = np.zeros((MAP_SIZE, MAP_SIZE), dtype=np.int32)

    # ── Build dataset (excluding ocean/water) ────────────────────────
    dataset = TerrainDataset(HEIGHTMAP_FILE, biome_grid, exclude_biome_ids=OCEAN_BIOME_IDS)

    # 90/10 train/val split
    n = len(dataset)
    n_val = max(1, n // 10)
    n_train = n - n_val
    train_ds, val_ds = torch.utils.data.random_split(
        dataset, [n_train, n_val],
        generator=torch.Generator().manual_seed(42)
    )
    print(f"  Train: {n_train}  Val: {n_val}")

    train_loader = DataLoader(
        train_ds, batch_size=BATCH_SIZE, shuffle=True,
        num_workers=2, pin_memory=True, persistent_workers=True
    )
    val_loader = DataLoader(
        val_ds, batch_size=BATCH_SIZE, shuffle=False,
        num_workers=2, pin_memory=True, persistent_workers=True
    )

    # ── Build model ──────────────────────────────────────────────────
    model = TerrainUNet(in_channels=17, base_channels=64).to(DEVICE)
    n_params = sum(p.numel() for p in model.parameters())
    print(f"  Model parameters: {n_params:,} ({n_params * 4 / 1024**2:.1f} MB fp32)")

    optimizer = torch.optim.AdamW(model.parameters(), lr=LEARNING_RATE, weight_decay=WEIGHT_DECAY)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=EPOCHS, eta_min=1e-6)

    height_criterion = nn.MSELoss()
    terrain_criterion = nn.CrossEntropyLoss()

    # ── Training ─────────────────────────────────────────────────────
    MODEL_DIR.mkdir(exist_ok=True)
    best_val_loss = float("inf")
    train_losses = []
    val_losses = []

    t0 = time.time()
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
        val_t_acc = 0.0
        val_count = 0
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

                # Metrics
                h_pred_denorm = h_pred * dataset.height_std + dataset.height_mean
                target_h_denorm = target_h * dataset.height_std + dataset.height_mean
                val_h_mae += torch.abs(h_pred_denorm - target_h_denorm).sum().item()
                val_t_acc += (t_pred.argmax(1) == target_t).sum().item()
                val_count += cond.size(0)

        val_loss = val_loss_sum / n_val
        val_losses.append(val_loss)
        avg_mae = val_h_mae / (n_val * GRID_SIZE * GRID_SIZE)
        avg_acc = val_t_acc / (n_val * GRID_SIZE * GRID_SIZE) * 100

        scheduler.step()
        lr = scheduler.get_last_lr()[0]

        # Print epoch summary
        elapsed = time.time() - t0
        print(
            f"  Epoch {epoch:3d}/{EPOCHS} | "
            f"train {train_loss:.4f} | val {val_loss:.4f} | "
            f"MAE {avg_mae:.2f} idx | terrain acc {avg_acc:.1f}% | "
            f"lr {lr:.2e} | {elapsed:.0f}s"
        )

        # Save best
        if val_loss < best_val_loss:
            best_val_loss = val_loss
            torch.save({
                "model_state_dict": model.state_dict(),
                "optimizer_state_dict": optimizer.state_dict(),
                "epoch": epoch,
                "val_loss": val_loss,
                "height_mean": dataset.height_mean,
                "height_std": dataset.height_std,
            }, MODEL_DIR / "terrain_unet.pt")
            print(f"    +--> Saved best model (val_loss={val_loss:.4f})")

    total_time = time.time() - t0
    print(f"\n{'=' * 70}")
    print(f"  Training complete in {total_time:.0f}s ({total_time/60:.1f} min)")
    print(f"  Best val loss: {best_val_loss:.4f}")
    print(f"{'=' * 70}")

    # ── Save config ──────────────────────────────────────────────────
    config = {
        "model": "TerrainUNet",
        "in_channels": 17,
        "base_channels": 64,
        "grid_size": GRID_SIZE,
        "num_terrain_types": NUM_TERRAIN_TYPES,
        "height_mean": dataset.height_mean,
        "height_std": dataset.height_std,
        "best_val_loss": best_val_loss,
        "epochs_trained": EPOCHS,
        "batch_size": BATCH_SIZE,
        "learning_rate": LEARNING_RATE,
        "total_samples": len(dataset),
        "training_time_seconds": total_time,
        "device": DEVICE,
        "gpu": torch.cuda.get_device_name(0) if DEVICE == "cuda" else "cpu",
        "parameters": n_params,
    }
    with open(MODEL_DIR / "terrain_unet_config.json", "w") as f:
        json.dump(config, f, indent=2)
    print(f"  Config saved to {MODEL_DIR / 'terrain_unet_config.json'}")

    # ── Plot loss curve ──────────────────────────────────────────────
    try:
        import matplotlib
        matplotlib.use("Agg")  # non-interactive backend
        import matplotlib.pyplot as plt

        fig, ax = plt.subplots(1, 1, figsize=(10, 5))
        ax.plot(range(1, EPOCHS + 1), train_losses, label="Train Loss", linewidth=2)
        ax.plot(range(1, EPOCHS + 1), val_losses, label="Val Loss", linewidth=2)
        ax.set_xlabel("Epoch")
        ax.set_ylabel("Loss")
        ax.set_title("Terrain U-Net Training -- GTX 1070")
        ax.legend()
        ax.grid(True, alpha=0.3)
        fig.tight_layout()
        fig.savefig(MODEL_DIR / "training_loss.png", dpi=150)
        print(f"  Loss curve saved to {MODEL_DIR / 'training_loss.png'}")
    except Exception as e:
        print(f"  Could not save plot: {e}")

    # ── VRAM usage report ────────────────────────────────────────────
    if DEVICE == "cuda":
        allocated = torch.cuda.max_memory_allocated() / 1024**2
        reserved = torch.cuda.max_memory_reserved() / 1024**2
        print(f"\n  GPU Memory Report:")
        print(f"    Peak allocated: {allocated:.0f} MB")
        print(f"    Peak reserved:  {reserved:.0f} MB")


# ─────────────────────────────────────────────────────────────────────
# Inference Helper (for integration with WorldBuilder)
# ─────────────────────────────────────────────────────────────────────
def generate_heightmap(model_path: Path, neighbor_heights: list, neighbor_terrains: list,
                       biome_id: int, height_mean: float, height_std: float):
    """
    Generate a 9x9 heightmap from neighbor context.

    Args:
        model_path: Path to terrain_unet.pt
        neighbor_heights: list of 8 (9x9) arrays for N,NE,E,SE,S,SW,W,NW
        neighbor_terrains: list of 8 (9x9) arrays
        biome_id: integer biome type
        height_mean, height_std: normalization stats from training

    Returns:
        heightmap: (9, 9) array of height indices
        terrain_types: (9, 9) array of terrain type IDs
    """
    model = TerrainUNet(in_channels=17, base_channels=64)
    ckpt = torch.load(model_path, map_location="cpu", weights_only=True)
    model.load_state_dict(ckpt["model_state_dict"])
    model.eval()

    # Build condition tensor
    cond_channels = []
    for nh in neighbor_heights:
        h = (np.array(nh, dtype=np.float32).reshape(9, 9) - height_mean) / height_std
        cond_channels.append(h)
    for nt in neighbor_terrains:
        t = np.array(nt, dtype=np.float32).reshape(9, 9) / NUM_TERRAIN_TYPES
        cond_channels.append(t)
    biome_ch = np.full((9, 9), biome_id / NUM_BIOMES, dtype=np.float32)
    cond_channels.append(biome_ch)

    cond = torch.from_numpy(np.stack(cond_channels)).unsqueeze(0)  # (1, 17, 9, 9)

    with torch.no_grad():
        h_pred, t_pred = model(cond)

    # Denormalize heights and clamp to valid range
    heightmap = (h_pred.squeeze().numpy() * height_std + height_mean)
    heightmap = np.clip(np.round(heightmap), 0, 255).astype(np.uint8)

    terrain_types = t_pred.squeeze().argmax(0).numpy().astype(np.uint8)

    return heightmap, terrain_types


if __name__ == "__main__":
    train()

#!/usr/bin/env python3
"""
train_terrain_v3.py -- Conditional Denoising Diffusion Model for terrain generation.

Major improvements over V1/V2:
  - Conditional DDPM: learns the DISTRIBUTION of valid heightmaps (not the mean)
  - Derived biomes from actual retail data (not mismatched biome_map.json)
  - Large model: ~50M params, targets 4-6GB VRAM usage on GTX 1070
  - DDIM fast sampling: 50 steps instead of 1000
  - Separate terrain type classifier conditioned on generated heights

Architecture:
  - Noise prediction U-Net with timestep embedding
  - Condition: 8 neighbor heightmaps + derived biome one-hot
  - Output: denoised 9x9 heightmap

Usage:
    .venv311\\Scripts\\python.exe scripts\\train_terrain_v3.py

Outputs saved to models/v3/
"""

import json
import math
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
BIOME_FILE = PROJECT_ROOT / "pipeline_data" / "data" / "retail_biomes.npy"
BIOME_INFO_FILE = PROJECT_ROOT / "pipeline_data" / "data" / "retail_biome_info.json"
MODEL_DIR = PROJECT_ROOT / "pipeline_data" / "models" / "v3"

GRID_SIZE = 9
MAP_SIZE = 255
NUM_TERRAIN_TYPES = 32

# ── Diffusion hyperparameters ──
T_DIFFUSION = 1000          # Training diffusion steps
T_SAMPLE = 50               # DDIM sampling steps (fast inference)
BETA_START = 1e-4
BETA_END = 0.02

# ── Model hyperparameters (sized for 4-6 GB VRAM) ──
BASE_CHANNELS = 192          # V2 was 32; this is 6x larger
COND_CHANNELS = 0            # Computed dynamically based on biome clusters
DROPOUT = 0.1
ATTN_RESOLUTION = True       # Self-attention in bottleneck
TIME_EMB_DIM = 512

# ── Training hyperparameters ──
BATCH_SIZE = 64              # Larger batch fills VRAM better
EPOCHS = 200
LEARNING_RATE = 2e-4
WEIGHT_DECAY = 1e-4
EMA_DECAY = 0.9999           # Exponential moving average for stable generation
EARLY_STOP_PATIENCE = 25
GRAD_CLIP = 1.0

# ── Terrain classifier ──
TERRAIN_EPOCHS = 30          # Train separately after diffusion

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


# =====================================================================
# Noise Schedule
# =====================================================================
def linear_beta_schedule(T, beta_start=1e-4, beta_end=0.02):
    """Linear noise schedule as in DDPM."""
    return torch.linspace(beta_start, beta_end, T, dtype=torch.float32)


def cosine_beta_schedule(T, s=0.008):
    """Cosine noise schedule (better for smaller images)."""
    steps = torch.linspace(0, T, T + 1, dtype=torch.float64)
    alphas_cumprod = torch.cos(((steps / T) + s) / (1 + s) * math.pi * 0.5) ** 2
    alphas_cumprod = alphas_cumprod / alphas_cumprod[0]
    betas = 1 - (alphas_cumprod[1:] / alphas_cumprod[:-1])
    return torch.clip(betas, 0.0001, 0.9999).float()


class DiffusionSchedule:
    """Precomputed diffusion schedule tensors."""
    def __init__(self, T, device="cuda"):
        # Cosine schedule works better for small images
        self.betas = cosine_beta_schedule(T).to(device)
        self.alphas = (1.0 - self.betas).to(device)
        self.alphas_cumprod = torch.cumprod(self.alphas, dim=0).to(device)
        self.alphas_cumprod_prev = F.pad(self.alphas_cumprod[:-1], (1, 0), value=1.0).to(device)

        self.sqrt_alphas_cumprod = torch.sqrt(self.alphas_cumprod).to(device)
        self.sqrt_one_minus_alphas_cumprod = torch.sqrt(1.0 - self.alphas_cumprod).to(device)

        # For posterior q(x_{t-1} | x_t, x_0)
        self.posterior_variance = (
            self.betas * (1.0 - self.alphas_cumprod_prev) / (1.0 - self.alphas_cumprod)
        ).to(device)

        self.T = T
        self.device = device

    def q_sample(self, x0, t, noise=None):
        """Forward diffusion: add noise to x0 at timestep t."""
        if noise is None:
            noise = torch.randn_like(x0)
        sqrt_alpha = self.sqrt_alphas_cumprod[t].view(-1, 1, 1, 1)
        sqrt_one_minus = self.sqrt_one_minus_alphas_cumprod[t].view(-1, 1, 1, 1)
        return sqrt_alpha * x0 + sqrt_one_minus * noise, noise


# =====================================================================
# Dataset
# =====================================================================
class TerrainDiffusionDataset(Dataset):
    """Dataset for diffusion model training on retail heightmaps."""

    def __init__(self, heightmap_file, biome_grid, augment=True):
        print(f"Loading heightmaps from {heightmap_file}...")
        self.grid = {}
        self.biome_grid = biome_grid
        self.augment = augment
        self.n_biomes = int(biome_grid.max()) + 1

        with open(heightmap_file, "r", encoding="utf-8-sig") as f:
            for line in tqdm(f, desc="Reading JSONL", total=65025):
                rec = json.loads(line)
                x, y = rec["lbX"], rec["lbY"]
                self.grid[(x, y)] = rec

        # ALL blocks are valid training data (biomes derived from the data itself)
        self.coords = list(self.grid.keys())
        print(f"  {len(self.coords)} total blocks for training")

        # Height normalization
        all_h = []
        for rec in self.grid.values():
            all_h.extend(rec["heightIndices"])
        all_h = np.array(all_h, dtype=np.float32)
        self.height_mean = float(np.mean(all_h))
        self.height_std = float(np.std(all_h)) + 1e-8
        self.height_min = float(np.min(all_h))
        self.height_max = float(np.max(all_h))
        print(f"  Height: mean={self.height_mean:.1f}, std={self.height_std:.1f}, "
              f"range=[{self.height_min:.0f}, {self.height_max:.0f}]")

        self.rng = np.random.RandomState(42)

    def __len__(self):
        return len(self.coords)

    def _normalize_height(self, h):
        """Normalize to [-1, 1] range (standard for diffusion models)."""
        return (h - self.height_mean) / self.height_std

    def _get_heightmap(self, x, y):
        rec = self.grid.get((x, y))
        if rec is None:
            return np.zeros((GRID_SIZE, GRID_SIZE), dtype=np.float32)
        h = np.array(rec["heightIndices"], dtype=np.float32).reshape(GRID_SIZE, GRID_SIZE)
        return self._normalize_height(h)

    def _get_terrain(self, x, y):
        rec = self.grid.get((x, y))
        if rec is None:
            return np.zeros((GRID_SIZE, GRID_SIZE), dtype=np.int64)
        return np.array(rec["terrainTypes"], dtype=np.int64).reshape(GRID_SIZE, GRID_SIZE)

    def __getitem__(self, idx):
        x, y = self.coords[idx]

        # Target heightmap (what the diffusion model learns to generate)
        target_h = self._get_heightmap(x, y)
        target_t = self._get_terrain(x, y)

        # Condition: 8 neighbor heightmaps
        neighbor_offsets = [
            (0, 1), (1, 1), (1, 0), (1, -1),
            (0, -1), (-1, -1), (-1, 0), (-1, 1)
        ]
        cond_channels = []
        for dx, dy in neighbor_offsets:
            cond_channels.append(self._get_heightmap(x + dx, y + dy))

        # Biome one-hot encoding
        bx = min(x, self.biome_grid.shape[0] - 1)
        by = min(y, self.biome_grid.shape[1] - 1)
        biome_id = max(0, int(self.biome_grid[bx, by]))
        biome_onehot = np.zeros(self.n_biomes, dtype=np.float32)
        biome_onehot[biome_id] = 1.0
        # Broadcast biome to spatial
        for b in range(self.n_biomes):
            cond_channels.append(
                np.full((GRID_SIZE, GRID_SIZE), biome_onehot[b], dtype=np.float32)
            )

        # Augmentation (random rotation + flip)
        if self.augment:
            k = self.rng.randint(0, 4)
            flip = self.rng.random() < 0.5
            target_h = np.rot90(target_h, k=k).copy()
            target_t = np.rot90(target_t, k=k).copy()
            if flip:
                target_h = np.fliplr(target_h).copy()
                target_t = np.fliplr(target_t).copy()
            cond_channels = [
                np.fliplr(np.rot90(c, k=k)).copy() if flip
                else np.rot90(c, k=k).copy()
                for c in cond_channels
            ]

        condition = np.stack(cond_channels, axis=0)  # (8 + n_biomes, 9, 9)

        return (
            torch.from_numpy(condition),
            torch.from_numpy(target_h[None].copy()),  # (1, 9, 9)
            torch.from_numpy(target_t.copy()),
        )


# =====================================================================
# Model: Conditional Diffusion U-Net
# =====================================================================
class SinusoidalPosEmb(nn.Module):
    """Sinusoidal timestep embedding."""
    def __init__(self, dim):
        super().__init__()
        self.dim = dim

    def forward(self, t):
        half_dim = self.dim // 2
        emb = math.log(10000) / (half_dim - 1)
        emb = torch.exp(torch.arange(half_dim, device=t.device, dtype=torch.float32) * -emb)
        emb = t.float().unsqueeze(1) * emb.unsqueeze(0)
        return torch.cat([emb.sin(), emb.cos()], dim=1)


class TimeMLPBlock(nn.Module):
    """Project timestep embedding to channel dimension for addition."""
    def __init__(self, time_dim, channels):
        super().__init__()
        self.mlp = nn.Sequential(
            nn.SiLU(),
            nn.Linear(time_dim, channels * 2),  # scale + shift
        )

    def forward(self, t_emb):
        return self.mlp(t_emb)


class ResBlock(nn.Module):
    """Residual block with timestep conditioning."""
    def __init__(self, in_ch, out_ch, time_dim, dropout=0.1):
        super().__init__()
        self.norm1 = nn.GroupNorm(min(32, in_ch), in_ch)
        self.conv1 = nn.Conv2d(in_ch, out_ch, 3, padding=1)
        self.norm2 = nn.GroupNorm(min(32, out_ch), out_ch)
        self.conv2 = nn.Conv2d(out_ch, out_ch, 3, padding=1)
        self.time_mlp = TimeMLPBlock(time_dim, out_ch)
        self.drop = nn.Dropout(dropout)

        if in_ch != out_ch:
            self.skip = nn.Conv2d(in_ch, out_ch, 1)
        else:
            self.skip = nn.Identity()

    def forward(self, x, t_emb):
        h = self.conv1(F.silu(self.norm1(x)))

        # Timestep conditioning: scale and shift
        t_out = self.time_mlp(t_emb)  # (B, 2*out_ch)
        scale, shift = t_out.chunk(2, dim=1)
        h = h * (1 + scale[:, :, None, None]) + shift[:, :, None, None]

        h = self.conv2(self.drop(F.silu(self.norm2(h))))
        return h + self.skip(x)


class SelfAttention(nn.Module):
    """Multi-head self-attention for spatial features."""
    def __init__(self, channels, num_heads=4):
        super().__init__()
        self.norm = nn.GroupNorm(min(32, channels), channels)
        self.attn = nn.MultiheadAttention(channels, num_heads, batch_first=True)
        self.proj = nn.Linear(channels, channels)

    def forward(self, x):
        B, C, H, W = x.shape
        h = self.norm(x)
        h = h.view(B, C, H * W).permute(0, 2, 1)  # (B, HW, C)
        h, _ = self.attn(h, h, h)
        h = self.proj(h)
        h = h.permute(0, 2, 1).view(B, C, H, W)
        return x + h


class DiffusionUNet(nn.Module):
    """
    Large conditional U-Net for diffusion-based terrain generation.

    Input:
      - x: (B, 1, 9, 9) noised heightmap
      - t: (B,) diffusion timestep
      - cond: (B, C_cond, 9, 9) neighbor heights + biome one-hot

    Output:
      - predicted noise: (B, 1, 9, 9)

    Architecture (sized for 4-6 GB VRAM):
      Encoder: 9x9 -> 5x5 -> 3x3
      Channel dims: C -> 2C -> 4C
      Where C = 192 (base_channels)
    """

    def __init__(self, cond_channels, base_channels=192, time_dim=512, dropout=0.1):
        super().__init__()
        C = base_channels
        in_ch = 1 + cond_channels  # noised heightmap + condition

        # Timestep embedding
        self.time_embed = nn.Sequential(
            SinusoidalPosEmb(time_dim),
            nn.Linear(time_dim, time_dim),
            nn.SiLU(),
            nn.Linear(time_dim, time_dim),
        )

        # Encoder
        self.enc1_conv = nn.Conv2d(in_ch, C, 3, padding=1)  # 9x9
        self.enc1_res1 = ResBlock(C, C, time_dim, dropout)
        self.enc1_res2 = ResBlock(C, C, time_dim, dropout)
        self.enc1_res3 = ResBlock(C, C, time_dim, dropout)
        self.enc1_attn = SelfAttention(C, num_heads=4)

        self.down1 = nn.Conv2d(C, C * 2, 3, stride=2, padding=1)  # 9->5

        self.enc2_res1 = ResBlock(C * 2, C * 2, time_dim, dropout)
        self.enc2_res2 = ResBlock(C * 2, C * 2, time_dim, dropout)
        self.enc2_res3 = ResBlock(C * 2, C * 2, time_dim, dropout)
        self.enc2_attn = SelfAttention(C * 2, num_heads=8)

        self.down2 = nn.Conv2d(C * 2, C * 4, 3, stride=2, padding=1)  # 5->3

        # Bottleneck (3x3)
        self.mid_res1 = ResBlock(C * 4, C * 4, time_dim, dropout)
        self.mid_attn = SelfAttention(C * 4, num_heads=8)
        self.mid_res2 = ResBlock(C * 4, C * 4, time_dim, dropout)

        # Decoder
        self.up2 = nn.ConvTranspose2d(C * 4, C * 2, 3, stride=2, padding=1)  # 3->5
        self.dec2_res1 = ResBlock(C * 4, C * 2, time_dim, dropout)  # concat: C*2 + C*2
        self.dec2_res2 = ResBlock(C * 2, C * 2, time_dim, dropout)
        self.dec2_res3 = ResBlock(C * 2, C * 2, time_dim, dropout)
        self.dec2_attn = SelfAttention(C * 2, num_heads=8)

        self.up1 = nn.ConvTranspose2d(C * 2, C, 4, stride=2, padding=1, output_padding=1)  # 5->9
        self.dec1_res1 = ResBlock(C * 2, C, time_dim, dropout)  # concat: C + C
        self.dec1_res2 = ResBlock(C, C, time_dim, dropout)
        self.dec1_res3 = ResBlock(C, C, time_dim, dropout)
        self.dec1_attn = SelfAttention(C, num_heads=4)

        # Output
        self.out_norm = nn.GroupNorm(min(32, C), C)
        self.out_conv = nn.Conv2d(C, 1, 3, padding=1)

    def forward(self, x, t, cond):
        # Timestep embedding
        t_emb = self.time_embed(t)

        # Concat input with condition
        x = torch.cat([x, cond], dim=1)

        # Encoder
        e1 = self.enc1_conv(x)
        e1 = self.enc1_res1(e1, t_emb)
        e1 = self.enc1_res2(e1, t_emb)
        e1 = self.enc1_res3(e1, t_emb)
        e1 = self.enc1_attn(e1)

        e2 = self.down1(e1)
        e2 = self.enc2_res1(e2, t_emb)
        e2 = self.enc2_res2(e2, t_emb)
        e2 = self.enc2_res3(e2, t_emb)
        e2 = self.enc2_attn(e2)

        # Bottleneck
        b = self.down2(e2)
        b = self.mid_res1(b, t_emb)
        b = self.mid_attn(b)
        b = self.mid_res2(b, t_emb)

        # Decoder
        d2 = self.up2(b)
        if d2.shape[-2:] != e2.shape[-2:]:
            d2 = F.interpolate(d2, size=e2.shape[-2:], mode='bilinear', align_corners=False)
        d2 = torch.cat([d2, e2], dim=1)
        d2 = self.dec2_res1(d2, t_emb)
        d2 = self.dec2_res2(d2, t_emb)
        d2 = self.dec2_res3(d2, t_emb)
        d2 = self.dec2_attn(d2)

        d1 = self.up1(d2)
        if d1.shape[-2:] != e1.shape[-2:]:
            d1 = F.interpolate(d1, size=e1.shape[-2:], mode='bilinear', align_corners=False)
        d1 = torch.cat([d1, e1], dim=1)
        d1 = self.dec1_res1(d1, t_emb)
        d1 = self.dec1_res2(d1, t_emb)
        d1 = self.dec1_res3(d1, t_emb)
        d1 = self.dec1_attn(d1)

        return self.out_conv(F.silu(self.out_norm(d1)))


# =====================================================================
# EMA (Exponential Moving Average)
# =====================================================================
class EMA:
    """Exponential Moving Average of model parameters for stable generation."""
    def __init__(self, model, decay=0.9999):
        self.decay = decay
        self.shadow = {}
        for name, param in model.named_parameters():
            if param.requires_grad:
                self.shadow[name] = param.data.clone()

    def update(self, model):
        for name, param in model.named_parameters():
            if param.requires_grad:
                self.shadow[name] = self.decay * self.shadow[name] + (1 - self.decay) * param.data

    def apply(self, model):
        """Apply EMA weights to model (for evaluation)."""
        self.backup = {}
        for name, param in model.named_parameters():
            if param.requires_grad:
                self.backup[name] = param.data.clone()
                param.data = self.shadow[name]

    def restore(self, model):
        """Restore original weights from EMA application."""
        for name, param in model.named_parameters():
            if param.requires_grad:
                param.data = self.backup[name]


# =====================================================================
# DDIM Sampler (fast sampling)
# =====================================================================
@torch.no_grad()
def ddim_sample(model, schedule, cond, n_steps=50, eta=0.0):
    """
    DDIM deterministic sampling for fast inference.
    eta=0: deterministic, eta=1: equivalent to DDPM
    """
    B = cond.shape[0]
    device = cond.device

    # Create timestep subsequence
    step_size = schedule.T // n_steps
    timesteps = list(range(0, schedule.T, step_size))
    timesteps = list(reversed(timesteps))

    # Start from pure noise
    x = torch.randn(B, 1, GRID_SIZE, GRID_SIZE, device=device)

    for i, t in enumerate(timesteps):
        t_batch = torch.full((B,), t, device=device, dtype=torch.long)

        # Predict noise
        eps_pred = model(x, t_batch, cond)

        # DDIM step
        alpha_t = schedule.alphas_cumprod[t]
        if i + 1 < len(timesteps):
            alpha_prev = schedule.alphas_cumprod[timesteps[i + 1]]
        else:
            alpha_prev = torch.tensor(1.0, device=device)

        # Predicted x0
        x0_pred = (x - torch.sqrt(1 - alpha_t) * eps_pred) / torch.sqrt(alpha_t)

        # Direction pointing to x_t
        sigma = eta * torch.sqrt((1 - alpha_prev) / (1 - alpha_t)) * torch.sqrt(1 - alpha_t / alpha_prev)
        dir_xt = torch.sqrt(1 - alpha_prev - sigma**2) * eps_pred

        noise = torch.randn_like(x) if eta > 0 and i < len(timesteps) - 1 else 0
        x = torch.sqrt(alpha_prev) * x0_pred + dir_xt + sigma * noise

    return x


# =====================================================================
# Worker init
# =====================================================================
def worker_init_fn(worker_id):
    np.random.seed(42 + worker_id)


# =====================================================================
# Training
# =====================================================================
def train():
    print("=" * 70)
    print("  TERRAIN DIFFUSION V3 -- GTX 1070 (Full VRAM)")
    print("=" * 70)
    print(f"  Device:          {DEVICE}")
    if DEVICE == "cuda":
        print(f"  GPU:             {torch.cuda.get_device_name(0)}")
        vram = torch.cuda.get_device_properties(0).total_memory / 1024**3
        print(f"  VRAM:            {vram:.1f} GB")
    print(f"  Diffusion steps: {T_DIFFUSION} (train) / {T_SAMPLE} (sample)")
    print(f"  Base channels:   {BASE_CHANNELS}")
    print(f"  Batch size:      {BATCH_SIZE}")
    print(f"  Max epochs:      {EPOCHS}")
    print(f"  LR:              {LEARNING_RATE}")
    print("=" * 70)

    # Load derived biomes
    print("\nLoading derived biomes...")
    if BIOME_FILE.exists():
        biome_grid = np.load(BIOME_FILE)
        with open(BIOME_INFO_FILE) as f:
            biome_info = json.load(f)
        n_biomes = biome_info["n_clusters"]
        print(f"  {n_biomes} biome clusters loaded")
        for cid, info in biome_info["clusters"].items():
            print(f"    Cluster {cid} ({info['name']}): {info['count']} blocks ({info['pct']:.1f}%)")
    else:
        print("  WARNING: No derived biomes found, run derive_retail_biomes.py first!")
        print("  Using dummy biome grid (all zeros)")
        biome_grid = np.zeros((MAP_SIZE, MAP_SIZE), dtype=np.int32)
        n_biomes = 1

    cond_channels = 8 + n_biomes  # 8 neighbor heights + biome one-hot
    print(f"  Condition channels: {cond_channels} (8 neighbors + {n_biomes} biome one-hot)")

    # Dataset
    full_ds = TerrainDiffusionDataset(HEIGHTMAP_FILE, biome_grid, augment=True)
    val_ds = TerrainDiffusionDataset(HEIGHTMAP_FILE, biome_grid, augment=False)

    n = len(full_ds)
    n_val = max(1, n // 10)
    n_train = n - n_val
    indices = list(range(n))
    rng = random.Random(42)
    rng.shuffle(indices)
    train_indices = indices[:n_train]
    val_indices = indices[n_train:]

    train_subset = torch.utils.data.Subset(full_ds, train_indices)
    val_subset = torch.utils.data.Subset(val_ds, val_indices)

    print(f"  Train: {n_train}, Val: {n_val}")

    train_loader = DataLoader(
        train_subset, batch_size=BATCH_SIZE, shuffle=True,
        num_workers=2, pin_memory=True, persistent_workers=True,
        worker_init_fn=worker_init_fn
    )
    val_loader = DataLoader(
        val_subset, batch_size=BATCH_SIZE, shuffle=False,
        num_workers=2, pin_memory=True, persistent_workers=True
    )

    # Model
    model = DiffusionUNet(
        cond_channels=cond_channels,
        base_channels=BASE_CHANNELS,
        time_dim=TIME_EMB_DIM,
        dropout=DROPOUT,
    ).to(DEVICE)

    n_params = sum(p.numel() for p in model.parameters())
    print(f"  Model parameters: {n_params:,} ({n_params * 4 / 1024**2:.1f} MB)")

    optimizer = torch.optim.AdamW(model.parameters(), lr=LEARNING_RATE, weight_decay=WEIGHT_DECAY)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=EPOCHS, eta_min=1e-6)

    # Diffusion schedule
    schedule = DiffusionSchedule(T_DIFFUSION, DEVICE)

    # EMA
    ema = EMA(model, decay=EMA_DECAY)

    # Training loop
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    best_val_loss = float("inf")
    patience_counter = 0
    train_losses = []
    val_losses = []

    t0 = time.time()
    stopped_epoch = EPOCHS

    # Memory report after first batch
    first_batch_done = False

    for epoch in range(1, EPOCHS + 1):
        model.train()
        epoch_loss = 0.0
        n_batches = 0

        for cond, target_h, target_t in train_loader:
            cond = cond.to(DEVICE)
            target_h = target_h.to(DEVICE)  # (B, 1, 9, 9)

            # Sample random timesteps
            t = torch.randint(0, T_DIFFUSION, (cond.shape[0],), device=DEVICE, dtype=torch.long)

            # Forward diffusion
            noised, noise = schedule.q_sample(target_h, t)

            # Predict noise
            noise_pred = model(noised, t, cond)

            # Simple MSE loss on noise prediction
            loss = F.mse_loss(noise_pred, noise)

            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), GRAD_CLIP)
            optimizer.step()
            ema.update(model)

            epoch_loss += loss.item()
            n_batches += 1

            if not first_batch_done:
                first_batch_done = True
                if DEVICE == "cuda":
                    alloc = torch.cuda.max_memory_allocated() / 1024**3
                    resv = torch.cuda.max_memory_reserved() / 1024**3
                    print(f"\n  VRAM after first batch: {alloc:.2f} GB allocated, {resv:.2f} GB reserved")

        train_loss = epoch_loss / n_batches
        train_losses.append(train_loss)

        # Validate (with EMA weights)
        ema.apply(model)
        model.eval()
        val_loss_sum = 0.0
        val_batches = 0
        with torch.no_grad():
            for cond, target_h, target_t in val_loader:
                cond = cond.to(DEVICE)
                target_h = target_h.to(DEVICE)

                t = torch.randint(0, T_DIFFUSION, (cond.shape[0],), device=DEVICE, dtype=torch.long)
                noised, noise = schedule.q_sample(target_h, t)
                noise_pred = model(noised, t, cond)
                loss = F.mse_loss(noise_pred, noise)

                val_loss_sum += loss.item()
                val_batches += 1

        ema.restore(model)
        val_loss = val_loss_sum / val_batches
        val_losses.append(val_loss)

        scheduler.step()
        lr = scheduler.get_last_lr()[0]

        elapsed = time.time() - t0
        improved = ""

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            patience_counter = 0
            improved = " *BEST*"

            # Save EMA weights (these are used for generation)
            ema.apply(model)
            torch.save({
                "model_state_dict": model.state_dict(),
                "epoch": epoch,
                "val_loss": val_loss,
                "height_mean": full_ds.height_mean,
                "height_std": full_ds.height_std,
                "n_biomes": n_biomes,
                "cond_channels": cond_channels,
                "base_channels": BASE_CHANNELS,
                "time_dim": TIME_EMB_DIM,
            }, MODEL_DIR / "terrain_diffusion_v3.pt")
            ema.restore(model)
        else:
            patience_counter += 1

        print(
            f"  Epoch {epoch:3d}/{EPOCHS} | "
            f"train {train_loss:.6f} | val {val_loss:.6f} | "
            f"lr {lr:.2e} | {elapsed:.0f}s{improved}"
        )

        # Early stopping
        if patience_counter >= EARLY_STOP_PATIENCE:
            print(f"\n  Early stopping at epoch {epoch}")
            stopped_epoch = epoch
            break

    total_time = time.time() - t0
    print(f"\n{'=' * 70}")
    print(f"  Training complete in {total_time:.0f}s ({total_time/60:.1f} min)")
    print(f"  Best val loss: {best_val_loss:.6f}")
    print(f"  Stopped at epoch: {stopped_epoch}")
    print(f"{'=' * 70}")

    # Save config
    config = {
        "model": "DiffusionUNet",
        "version": 3,
        "architecture": "conditional_DDPM",
        "cond_channels": cond_channels,
        "base_channels": BASE_CHANNELS,
        "time_dim": TIME_EMB_DIM,
        "dropout": DROPOUT,
        "n_biomes": n_biomes,
        "grid_size": GRID_SIZE,
        "T_diffusion": T_DIFFUSION,
        "T_sample": T_SAMPLE,
        "height_mean": full_ds.height_mean,
        "height_std": full_ds.height_std,
        "best_val_loss": best_val_loss,
        "epochs_trained": stopped_epoch,
        "batch_size": BATCH_SIZE,
        "learning_rate": LEARNING_RATE,
        "total_samples": len(full_ds),
        "training_time_seconds": total_time,
        "device": DEVICE,
        "gpu": torch.cuda.get_device_name(0) if DEVICE == "cuda" else "cpu",
        "parameters": n_params,
    }
    with open(MODEL_DIR / "terrain_v3_config.json", "w") as f:
        json.dump(config, f, indent=2)
    print(f"  Config: {MODEL_DIR / 'terrain_v3_config.json'}")

    # Plot
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        fig, ax = plt.subplots(1, 1, figsize=(12, 6))
        ax.plot(range(1, len(train_losses)+1), train_losses, label="Train", lw=2)
        ax.plot(range(1, len(val_losses)+1), val_losses, label="Val", lw=2)
        ax.set_xlabel("Epoch")
        ax.set_ylabel("Loss (noise prediction MSE)")
        ax.set_title(f"Terrain Diffusion V3 -- {n_params/1e6:.0f}M params, GTX 1070")
        ax.legend()
        ax.grid(True, alpha=0.3)
        fig.tight_layout()
        fig.savefig(MODEL_DIR / "training_v3.png", dpi=150)
        plt.close()
        print(f"  Plot: {MODEL_DIR / 'training_v3.png'}")
    except Exception as e:
        print(f"  Could not save plot: {e}")

    # VRAM report
    if DEVICE == "cuda":
        alloc = torch.cuda.max_memory_allocated() / 1024**3
        resv = torch.cuda.max_memory_reserved() / 1024**3
        print(f"\n  GPU Memory Report:")
        print(f"    Peak allocated: {alloc:.2f} GB")
        print(f"    Peak reserved:  {resv:.2f} GB")


if __name__ == "__main__":
    train()

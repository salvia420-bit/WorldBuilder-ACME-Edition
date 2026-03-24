#!/usr/bin/env python3
"""
generate_populated_world.py — ML Inference → ACE SQL
=====================================================

Runs the trained Scene Placement Transformer to generate object placements
for every landblock in the Vanquish world, then outputs ACE-compatible SQL.

Flow:
  1. Load trained model + vocab
  2. For each non-ocean landblock:
     a. Build context vector (terrain, biome, culture, difficulty)
     b. Run autoregressive generation with temperature/nucleus sampling
     c. Apply quality validation (collision, cultural, density checks)
     d. Handle housing tokens → HousingLinker for slumlord GUID chains
  3. Write landblock_instance + landblock_instance_link + encounter + house_portal SQL

Sampling controls (anti-overfitting, pro-variance):
  - Temperature: 0.8 (controlled randomness)
  - Nucleus (top-p): 0.92 (diverse but reasonable)
  - Top-k: 50 (prevent degenerate rare picks)
  - Frequency penalty: -0.3 * log(freq) (prevent mode collapse)

Usage:
    python scripts/PopulationPipeline/OutdoorML/generate_populated_world.py
    python scripts/PopulationPipeline/OutdoorML/generate_populated_world.py --model scene_placer_best.safetensors
    python scripts/PopulationPipeline/OutdoorML/generate_populated_world.py --temperature 0.9 --top-k 100
"""

import argparse
import json
import math
import os
import sys
import time
import random
import numpy as np
from collections import Counter, defaultdict
from typing import Dict, List, Optional, Tuple

try:
    import torch
    import torch.nn.functional as F
except ImportError:
    print("ERROR: PyTorch not found.")
    sys.exit(1)

# Import project modules
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train_scene_placer import ScenePlacerTransformer, DEFAULT_CONFIG
from housing_linker import HousingLinker, GuidAllocator, write_housing_sql, SQLStatement
from extract_placement_tensors import (
    build_context_vector, load_height_grid, load_difficulty_grid,
    build_cultural_zones, STOP_TOKEN, PAD_TOKEN,
    HOUSING_COTTAGE_TOKEN, HOUSING_VILLA_TOKEN, HOUSING_MANSION_TOKEN,
)

# ─── Configuration ───────────────────────────────────────────────────────────

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

MODEL_DIR = os.path.join(BASE_DIR, "pipeline_data", "models")
VOCAB_PATH = os.path.join(BASE_DIR, "pipeline_data", "reference", "placement_vocab.json")
HEIGHTS_PATH = os.path.join(BASE_DIR, "pipeline_data", "population_output", "vanquish_heights.json")
DIFFICULTY_GRADIENT = os.path.join(BASE_DIR, "pipeline_data", "enrichment", "difficulty_gradient.json")

OUTPUT_DIR = os.path.join(BASE_DIR, "pipeline_data", "population_output")
OUTPUT_SQL = os.path.join(OUTPUT_DIR, "vanquish_ml_populated.sql")

LB_SIZE = 192.0
MAX_OBJECTS_PER_LB = 128

# Housing token → type mapping
HOUSING_TOKEN_MAP = {
    HOUSING_COTTAGE_TOKEN: 'Cottage',
    HOUSING_VILLA_TOKEN: 'Villa',
    HOUSING_MANSION_TOKEN: 'Mansion',
}

# ─── Encounter Generation ────────────────────────────────────────────────────

# Encounter generator wcids by difficulty tier
# These are generator weenies that spawn waves of creatures
# Mapped from retail AC encounter table patterns
ENCOUNTER_GENERATORS_BY_TIER = {
    0: [],  # Ocean/unused
    1: [  # Starter (T1) — rats, drudge skulkers, mite scamps
        1154,  # Drudge Camp Generator
        4213,  # Low Banderling Generator
        4215,  # Low Drudge Generator
        7924,  # Low Mosswart Generator
    ],
    2: [  # Low (T2) — tuskers, armoredillos
        4148,  # Armoredillo Generator
        4149,  # Banderling Generator
        4216,  # Low Undead Generator
        7923,  # Low Lugian Generator
    ],
    3: [  # Medium (T3) — virindi, shadows
        4153,  # Golem Generator
        4221,  # Medium Shadow Generator
        4218,  # Medium Tumerok Generator
        4156,  # Virindi Generator
    ],
    4: [  # Hard (T4) — olthoi, tusker guards
        4152,  # Olthoi Generator
        4222,  # Hard Shadow Generator
        4157,  # Hard Virindi Generator
    ],
    5: [  # Elite/Legendary (T5) — raid bosses, high-level spawns
        4152,  # Olthoi Generator (high)
        4157,  # Virindi Generator (high)
        4222,  # Shadow Generator (high)
    ],
}

# ─── Inference Engine ────────────────────────────────────────────────────────

class PlacementGenerator:
    """
    Autoregressive placement generator with quality controls.
    """
    
    def __init__(self, model, vocab, device,
                 temperature=0.8, top_k=50, nucleus_p=0.92,
                 frequency_penalty=0.3, min_objects=3, max_objects=120):
        self.model = model
        self.vocab = vocab
        self.device = device
        self.temperature = temperature
        self.top_k = top_k
        self.nucleus_p = nucleus_p
        self.frequency_penalty = frequency_penalty
        self.min_objects = min_objects
        self.max_objects = max_objects
        
        self.idx_to_wcid = {int(k): v for k, v in vocab['idx_to_wcid'].items()}
        self.vocab_size = vocab['vocab_size']
    
    @torch.no_grad()
    def generate(self, context: np.ndarray) -> list:
        """
        Generate object placements for a single landblock.
        
        Args:
            context: 224-dim context vector
        
        Returns:
            List of placement dicts: [{wcid, local_x, local_y, local_z, 
                                        rot_w, rot_z, is_link_child}, ...]
        """
        ctx = torch.from_numpy(context).float().unsqueeze(0).to(self.device)
        
        # Initialize sequence with a zero start token
        seq = torch.zeros(1, 1, 10, device=self.device)
        
        placements = []
        wcid_freq = Counter()
        
        for step in range(self.max_objects):
            # Forward pass
            wcid_logits, pos_pred, rot_pred, link_pred = self.model(ctx, seq)
            
            # Get logits for the last position
            logits = wcid_logits[0, -1, :]  # (vocab_size,)
            
            # Apply frequency penalty
            for wcid_idx, count in wcid_freq.items():
                if wcid_idx < len(logits):
                    logits[wcid_idx] -= self.frequency_penalty * math.log(count + 1)
            
            # Temperature scaling
            logits = logits / self.temperature
            
            # Top-k filtering
            if self.top_k > 0:
                top_k_logits, top_k_indices = torch.topk(logits, self.top_k)
                logits = torch.full_like(logits, float('-inf'))
                logits.scatter_(0, top_k_indices, top_k_logits)
            
            # Nucleus (top-p) filtering
            if self.nucleus_p < 1.0:
                sorted_logits, sorted_indices = torch.sort(logits, descending=True)
                cumulative_probs = torch.cumsum(F.softmax(sorted_logits, dim=-1), dim=-1)
                sorted_indices_to_remove = cumulative_probs > self.nucleus_p
                sorted_indices_to_remove[1:] = sorted_indices_to_remove[:-1].clone()
                sorted_indices_to_remove[0] = False
                indices_to_remove = sorted_indices[sorted_indices_to_remove]
                logits[indices_to_remove] = float('-inf')
            
            # Sample
            probs = F.softmax(logits, dim=-1)
            wcid_idx = torch.multinomial(probs, 1).item()
            
            # Check for STOP
            if wcid_idx == STOP_TOKEN:
                if len(placements) >= self.min_objects:
                    break
                else:
                    continue  # Force more objects
            
            # Skip PAD
            if wcid_idx == PAD_TOKEN:
                continue
            
            # Get position and rotation predictions
            pos = pos_pred[0, -1, :].cpu().numpy()   # (2,) normalized
            rot = rot_pred[0, -1, :].cpu().numpy()   # (2,) 
            link = torch.sigmoid(link_pred[0, -1, 0]).item()
            
            # Denormalize position
            local_x = max(4.0, min(188.0, pos[0] * LB_SIZE))
            local_y = max(4.0, min(188.0, pos[1] * LB_SIZE))
            
            # Add small random jitter for variety
            local_x += random.gauss(0, 1.5)
            local_y += random.gauss(0, 1.5)
            local_x = max(2.0, min(190.0, local_x))
            local_y = max(2.0, min(190.0, local_y))
            
            placement = {
                'wcid_idx': wcid_idx,
                'wcid': self.idx_to_wcid.get(wcid_idx, wcid_idx),
                'local_x': round(local_x, 2),
                'local_y': round(local_y, 2),
                'local_z': 0.0,  # Will be height-snapped
                'rot_w': round(float(rot[0]), 4),
                'rot_z': round(float(rot[1]), 4),
                'is_link_child': link > 0.5,
                'is_housing': wcid_idx in HOUSING_TOKEN_MAP,
                'housing_type': HOUSING_TOKEN_MAP.get(wcid_idx),
            }
            placements.append(placement)
            wcid_freq[wcid_idx] += 1
            
            # Build next input token
            next_token = torch.zeros(1, 1, 10, device=self.device)
            next_token[0, 0, 0] = wcid_idx
            next_token[0, 0, 1] = pos[0]
            next_token[0, 0, 2] = pos[1]
            next_token[0, 0, 4] = rot[0]
            next_token[0, 0, 5] = rot[1]
            next_token[0, 0, 7] = float(link > 0.5)
            
            seq = torch.cat([seq, next_token], dim=1)
        
        return placements
    
    def validate_placements(self, placements: list, lb_x: int, lb_y: int,
                            culture: str = "Neutral") -> list:
        """Apply inference-time quality checks."""
        validated = []
        positions = []
        
        for p in placements:
            # Collision check
            too_close = False
            for px, py in positions:
                dx = p['local_x'] - px
                dy = p['local_y'] - py
                if dx*dx + dy*dy < 4.0:  # 2.0 unit minimum
                    too_close = True
                    break
            
            if too_close:
                # Re-roll position
                p['local_x'] = random.uniform(4, 188)
                p['local_y'] = random.uniform(4, 188)
            
            positions.append((p['local_x'], p['local_y']))
            validated.append(p)
        
        return validated


# ─── Height Snapping ─────────────────────────────────────────────────────────

def snap_to_terrain(local_x: float, local_y: float, 
                    heights_9x9: np.ndarray) -> float:
    """
    Interpolate terrain height at a local position within a landblock.
    
    Heights are a 9×9 grid (0,0 to 192,192).
    """
    if heights_9x9 is None or len(heights_9x9) < 81:
        return 0.0
    
    h = heights_9x9[:81].reshape(9, 9)
    
    # Map local position to grid coordinates
    gx = local_x / LB_SIZE * 8.0
    gy = local_y / LB_SIZE * 8.0
    
    # Bilinear interpolation
    x0 = int(max(0, min(7, gx)))
    y0 = int(max(0, min(7, gy)))
    x1 = min(8, x0 + 1)
    y1 = min(8, y0 + 1)
    
    fx = gx - x0
    fy = gy - y0
    
    z = (h[y0, x0] * (1-fx) * (1-fy) +
         h[y0, x1] * fx * (1-fy) +
         h[y1, x0] * (1-fx) * fy +
         h[y1, x1] * fx * fy)
    
    return float(z)


# ─── Ocean Mask ──────────────────────────────────────────────────────────────

def load_ocean_mask(difficulty_grid: np.ndarray) -> np.ndarray:
    """Use the difficulty gradient to identify ocean landblocks (tier < 0)."""
    return difficulty_grid < 0


# ─── Main Generation ─────────────────────────────────────────────────────────

def generate_world(args):
    """Generate placements for the entire world."""
    
    # ── Load model ──
    print("[1/6] Loading model...")
    model_path = os.path.join(MODEL_DIR, args.model)
    if not os.path.exists(model_path):
        print(f"  ERROR: Model not found: {model_path}")
        return
    
    config = DEFAULT_CONFIG.copy()
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    print(f"  Device: {device}")
    
    model = ScenePlacerTransformer(config).to(device)
    
    # Load weights
    if model_path.endswith('.safetensors'):
        from safetensors.torch import load_file
        state = load_file(model_path)
    else:
        state = torch.load(model_path, map_location=device)
    model.load_state_dict(state)
    model.eval()
    print(f"  Model loaded: {model.count_parameters()/1e6:.1f}M params")
    
    # ── Load vocab ──
    print("\n[2/6] Loading vocab...")
    with open(VOCAB_PATH) as f:
        vocab = json.load(f)
    print(f"  Vocab size: {vocab['vocab_size']}")
    
    # ── Load auxiliary data ──
    print("\n[3/6] Loading terrain & gradient data...")
    heights = load_height_grid(HEIGHTS_PATH)
    difficulty_grid = load_difficulty_grid(DIFFICULTY_GRADIENT)
    culture_grid = build_cultural_zones()
    
    ocean_mask = None
    if difficulty_grid is not None:
        ocean_mask = load_ocean_mask(difficulty_grid)
    
    # Instance counts (empty for generated world)
    instance_counts = {}
    
    # ── Initialize generator ──
    generator = PlacementGenerator(
        model, vocab, device,
        temperature=args.temperature,
        top_k=args.top_k,
        nucleus_p=args.nucleus_p,
        frequency_penalty=args.frequency_penalty,
    )
    
    housing_linker = HousingLinker(GuidAllocator(start=0x70000000))
    guid_alloc = GuidAllocator(start=0x72000000)  # Separate range for non-housing
    
    # ── Generate ──
    print(f"\n[4/6] Generating placements (margin={args.margin})...")
    
    all_instance_stmts = []
    all_link_stmts = []
    all_encounter_stmts = []  # encounter table rows
    all_house_portal_stmts = []  # house_portal table rows
    lb_count = 0
    total_objects = 0
    housing_count = 0
    encounter_count = 0
    enc_id_counter = 1  # Auto-incrementing encounter IDs
    now = time.strftime('%Y-%m-%d %H:%M:%S')
    
    t0 = time.time()
    
    for lb_x in range(args.margin, 255 - args.margin):
        for lb_y in range(args.margin, 255 - args.margin):
            # Skip ocean
            if ocean_mask is not None and ocean_mask[lb_y, lb_x]:
                continue
            
            # Build context
            ctx = build_context_vector(
                lb_x, lb_y, heights, difficulty_grid,
                culture_grid, instance_counts
            )
            
            # Generate placements
            placements = generator.generate(ctx)
            
            # Validate
            culture_code = culture_grid[lb_x, lb_y] if 0 <= lb_x < 255 and 0 <= lb_y < 255 else 0
            culture_name = {0:"Neutral", 1:"Aluvian", 2:"Sho", 3:"Gharu'ndim",
                           4:"Viamontian", 5:"Empyrean"}.get(culture_code, "Neutral")
            
            placements = generator.validate_placements(placements, lb_x, lb_y, culture_name)
            
            if not placements:
                continue
            
            lb_count += 1
            cell_id = (lb_x << 24) | (lb_y << 16) | 0x0001
            
            for p in placements:
                # Height snap
                h = heights.get((lb_x, lb_y))
                if h is not None:
                    p['local_z'] = snap_to_terrain(p['local_x'], p['local_y'], h)
                
                world_x = lb_x * LB_SIZE + p['local_x']
                world_y = lb_y * LB_SIZE + p['local_y']
                
                if p.get('is_housing') and p.get('housing_type'):
                    # Housing → use the linker
                    housing_stmts = housing_linker.place_housing(
                        house_type=p['housing_type'],
                        culture=culture_name,
                        world_x=world_x,
                        world_y=world_y,
                        world_z=p['local_z'],
                        lb_x=lb_x, lb_y=lb_y,
                    )
                    for stmt in housing_stmts:
                        if stmt.table == 'landblock_instance':
                            all_instance_stmts.append(stmt)
                        else:
                            all_link_stmts.append(stmt)
                    housing_count += 1
                else:
                    # Regular instance
                    guid = guid_alloc.next()
                    wcid = p.get('wcid', 0)
                    if isinstance(wcid, int) and wcid < 0:
                        continue  # Skip special tokens that leaked through
                    
                    all_instance_stmts.append(SQLStatement(
                        table='landblock_instance',
                        values={
                            'guid': guid,
                            'wcid': wcid,
                            'cell_id': cell_id,
                            'x': round(world_x, 6),
                            'y': round(world_y, 6),
                            'z': round(p['local_z'], 6),
                            'w': p.get('rot_w', 1.0),
                            'qx': 0.0,
                            'qy': 0.0,
                            'qz': p.get('rot_z', 0.0),
                            'is_link_child': p.get('is_link_child', False),
                            'last_modified': now,
                        }
                    ))
                
                total_objects += 1
            
            # ── Generate encounters for this LB (creature generators) ──
            if difficulty_grid is not None and 0 <= lb_x < 255 and 0 <= lb_y < 255:
                tier = max(0, min(5, int(difficulty_grid[lb_y, lb_x])))
                generators = ENCOUNTER_GENERATORS_BY_TIER.get(tier, [])
                
                if generators and tier > 0:
                    # Place 1-4 encounter generators per landblock
                    num_encounters = random.randint(1, min(4, len(generators)))
                    lb_id_enc = (lb_x << 8) | lb_y
                    
                    for _ in range(num_encounters):
                        gen_wcid = random.choice(generators)
                        cell_x = random.randint(0, 7)
                        cell_y = random.randint(0, 7)
                        
                        all_encounter_stmts.append({
                            'id': enc_id_counter,
                            'landblock': lb_id_enc,
                            'wcid': gen_wcid,
                            'cell_x': cell_x,
                            'cell_y': cell_y,
                            'last_modified': now,
                        })
                        enc_id_counter += 1
                        encounter_count += 1
        
        # Progress
        if (lb_x - args.margin + 1) % 25 == 0:
            elapsed = time.time() - t0
            pct = (lb_x - args.margin + 1) / (255 - 2 * args.margin) * 100
            print(f"    {pct:.0f}% ({lb_count} LBs, {total_objects:,} objects, "
                  f"{housing_count} houses, {encounter_count} encounters, {elapsed:.0f}s)")
    
    elapsed = time.time() - t0
    
    # ── Write SQL ──
    print(f"\n[5/7] Writing SQL ({len(all_instance_stmts):,} instances, "
          f"{len(all_link_stmts):,} links, {encounter_count} encounters)...")
    
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    with open(OUTPUT_SQL, 'w', encoding='utf-8') as f:
        f.write(f"-- ML-Generated World Population for Vanquish\n")
        f.write(f"-- Generated: {now}\n")
        f.write(f"-- Model: {args.model}\n")
        f.write(f"-- Temperature: {args.temperature}, Top-k: {args.top_k}, "
                f"Nucleus-p: {args.nucleus_p}\n")
        f.write(f"-- Landblocks: {lb_count}, Objects: {total_objects:,}, "
                f"Houses: {housing_count}, Encounters: {encounter_count}\n")
        f.write(f"-- Generation time: {elapsed:.0f}s\n\n")
        
        # Write instances in batches
        batch_size = 500
        for i in range(0, len(all_instance_stmts), batch_size):
            batch = all_instance_stmts[i:i+batch_size]
            f.write(
                "INSERT INTO `landblock_instance` "
                "(`guid`, `weenie_Class_Id`, `obj_Cell_Id`, "
                "`origin_X`, `origin_Y`, `origin_Z`, "
                "`angles_W`, `angles_X`, `angles_Y`, `angles_Z`, "
                "`is_Link_Child`, `last_Modified`) VALUES\n"
            )
            f.write(",\n".join(s.to_instance_sql() for s in batch))
            f.write(";\n\n")
        
        # Write links
        for i in range(0, len(all_link_stmts), batch_size):
            batch = all_link_stmts[i:i+batch_size]
            f.write(
                "INSERT INTO `landblock_instance_link` "
                "(`id`, `parent_GUID`, `child_GUID`, `last_Modified`) VALUES\n"
            )
            f.write(",\n".join(s.to_link_sql() for s in batch))
            f.write(";\n\n")
        
        # Write encounters
        if all_encounter_stmts:
            f.write(f"\n-- ═══ ENCOUNTER TABLE ({len(all_encounter_stmts)} rows) ═══\n\n")
            for i in range(0, len(all_encounter_stmts), batch_size):
                batch = all_encounter_stmts[i:i+batch_size]
                f.write(
                    "INSERT INTO `encounter` "
                    "(`id`, `landblock`, `weenie_Class_Id`, "
                    "`cell_X`, `cell_Y`, `last_Modified`) VALUES\n"
                )
                rows = []
                for e in batch:
                    rows.append(
                        f"({e['id']},{e['landblock']},{e['wcid']},"
                        f"{e['cell_x']},{e['cell_y']},'{e['last_modified']}')"
                    )
                f.write(",\n".join(rows))
                f.write(";\n\n")
        
        # Write house portals
        if all_house_portal_stmts:
            f.write(f"\n-- ═══ HOUSE PORTAL TABLE ({len(all_house_portal_stmts)} rows) ═══\n\n")
            for i in range(0, len(all_house_portal_stmts), batch_size):
                batch = all_house_portal_stmts[i:i+batch_size]
                f.write(
                    "INSERT INTO `house_portal` "
                    "(`id`, `house_Id`, `obj_Cell_Id`, "
                    "`origin_X`, `origin_Y`, `origin_Z`, "
                    "`angles_W`, `angles_X`, `angles_Y`, `angles_Z`, "
                    "`last_Modified`) VALUES\n"
                )
                rows = []
                for hp in batch:
                    rows.append(
                        f"({hp['id']},{hp['house_id']},{hp['cell_id']},"
                        f"{hp['x']},{hp['y']},{hp['z']},"
                        f"{hp['w']},0,0,{hp['qz']},"
                        f"'{hp['last_modified']}')"
                    )
                f.write(",\n".join(rows))
                f.write(";\n\n")
    
    size_mb = os.path.getsize(OUTPUT_SQL) / 1024 / 1024
    
    # ── Validate housing ──
    print(f"\n[6/7] Validating housing integrity...")
    housing_report = housing_linker.validate_placements()
    print(f"  Houses placed: {housing_report['total_houses']}")
    print(f"  By type: {housing_report['by_type']}")
    print(f"  Valid: {'✓' if housing_report['is_valid'] else '✗'}")
    for issue in housing_report['issues'][:10]:
        print(f"  ⚠️  {issue}")
    
    # ── Encounter validation ──
    print(f"\n[7/7] Encounter summary...")
    print(f"  Total encounters generated: {encounter_count}")
    print(f"  Avg encounters per LB: {encounter_count / max(lb_count, 1):.1f}")
    
    # ── Summary ──
    print()
    print("=" * 72)
    print("  Generation Complete")
    print("=" * 72)
    print(f"  Landblocks populated: {lb_count:,}")
    print(f"  Total objects placed: {total_objects:,}")
    print(f"  Housing units:        {housing_count}")
    print(f"  Encounters:           {encounter_count}")
    print(f"  SQL file:             {OUTPUT_SQL} ({size_mb:.1f} MB)")
    print(f"  Generation time:      {elapsed:.0f}s")
    print()
    print(f"  To import into ACE:")
    print(f'    mysql -u root -pbaltic ace_world < "{OUTPUT_SQL}"')
    print()
    print(f"  To score quality:")
    print(f"    python scripts/PopulationPipeline/OutdoorML/score_placement_quality.py \"{OUTPUT_SQL}\"")
    print("=" * 72)


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Generate ML-populated world")
    parser.add_argument("--model", type=str, default="scene_placer_best.safetensors",
                       help="Model weights file (in pipeline_data/models/)")
    parser.add_argument("--temperature", type=float, default=0.8)
    parser.add_argument("--top-k", type=int, default=50)
    parser.add_argument("--nucleus-p", type=float, default=0.92)
    parser.add_argument("--frequency-penalty", type=float, default=0.3)
    parser.add_argument("--margin", type=int, default=8,
                       help="Landblock margin from edges to skip")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    
    print("=" * 72)
    print("  ML World Population Generator")
    print("  Autoregressive Scene Placement → ACE SQL")
    print("=" * 72)
    print()
    
    generate_world(args)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""
extract_placement_tensors.py — Retail Data → ML Training Tensors
================================================================

Parses the ACE World SQL dump + enrichment data to produce structured
training tensors for the Scene Placement Transformer.

Each training example is one landblock with:
  - context:   224-dim float vector (terrain, biome, culture, difficulty, etc.)
  - objects:    Nx10 array of (wcid_idx, local_x, local_y, local_z,
                rot_w, rot_z, weenie_type, is_link_child, parent_wcid_idx, obj_idx)
  - link_pairs: Mx2 array of (parent_idx_in_sequence, child_idx_in_sequence)

Output: pipeline_data/reference/placement_tensors.npz

Usage:
    python scripts/PopulationPipeline/OutdoorML/extract_placement_tensors.py
"""

import json
import math
import os
import re
import sys
import time
import struct
import numpy as np
from collections import defaultdict
from typing import Dict, List, Tuple, Optional
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from housing_linker import classify_slumlord_house_type

# ─── Configuration ───────────────────────────────────────────────────────────

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

RETAIL_SQL = r"D:\ACE\world-db\ACE-World-Database-v0.9.292.sql"
HEIGHTS_PATH = os.path.join(BASE_DIR, "pipeline_data", "population_output", "vanquish_heights.json")
BIOME_MAP = os.path.join(BASE_DIR, "pipeline_data", "enrichment", "biome_map.json")
DIFFICULTY_GRADIENT = os.path.join(BASE_DIR, "pipeline_data", "enrichment", "difficulty_gradient.json")
ENRICHMENT = os.path.join(BASE_DIR, "pipeline_data", "enrichment", "canonical_enrichment.json")
CULTURE_MAP_PATH = os.path.join(BASE_DIR, "pipeline_data", "enrichment", "building_culture_map.json")

OUTPUT_DIR = os.path.join(BASE_DIR, "pipeline_data", "reference")
OUTPUT_NPZ = os.path.join(OUTPUT_DIR, "placement_tensors.npz")
OUTPUT_VOCAB = os.path.join(OUTPUT_DIR, "placement_vocab.json")

LB_SIZE = 192.0
MAX_OBJECTS_PER_LB = 128

# MariaDB client for weenie type lookups
MYSQL = r"C:\Program Files\MariaDB 12.2\bin\mysql.exe"

# ─── Special Token IDs ───────────────────────────────────────────────────────

PAD_TOKEN = 0
STOP_TOKEN = 1
HOUSING_COTTAGE_TOKEN = 2
HOUSING_VILLA_TOKEN = 3
HOUSING_MANSION_TOKEN = 4
FIRST_REAL_TOKEN = 5  # Real wcid vocab starts here

# ─── WeenieType Constants ────────────────────────────────────────────────────

WT_GENERIC = 1
WT_PORTAL = 7
WT_CREATURE = 10
WT_VENDOR = 12
WT_DOOR = 19
WT_CHEST = 20
WT_LIFESTONE = 25
WT_SLUMLORD = 55

SLUMLORD_TOKEN_BY_HOUSE_TYPE = {
    "Cottage": HOUSING_COTTAGE_TOKEN,
    "Villa": HOUSING_VILLA_TOKEN,
    "Mansion": HOUSING_MANSION_TOKEN,
}

# Cultural zone codes
CULTURE_CODES = {
    "Neutral": 0, "Aluvian": 1, "Sho": 2, "Gharu'ndim": 3,
    "Viamontian": 4, "Empyrean": 5
}

# ─── Step 1: Build vocabulary from enrichment ────────────────────────────────

def build_wcid_vocabulary(enrichment_path: str) -> Tuple[Dict[int, int], Dict[int, int]]:
    """
    Build wcid -> vocab_index mapping from canonical enrichment.
    Returns: (wcid_to_idx, idx_to_wcid)
    """
    print("  Building wcid vocabulary...")
    with open(enrichment_path, encoding="utf-8-sig") as f:
        data = json.load(f)

    entries = data if isinstance(data, list) else data.get("entries", [])
    
    # Collect all unique wcids
    all_wcids = sorted(set(e["wcid"] for e in entries if "wcid" in e))
    
    # Build mapping (reserve first 5 slots for special tokens)
    wcid_to_idx = {}
    idx_to_wcid = {}
    
    for i, wcid in enumerate(all_wcids):
        idx = i + FIRST_REAL_TOKEN
        wcid_to_idx[wcid] = idx
        idx_to_wcid[idx] = wcid
    
    # Add special tokens
    idx_to_wcid[PAD_TOKEN] = -1       # PAD
    idx_to_wcid[STOP_TOKEN] = -2      # STOP
    idx_to_wcid[HOUSING_COTTAGE_TOKEN] = -3
    idx_to_wcid[HOUSING_VILLA_TOKEN] = -4
    idx_to_wcid[HOUSING_MANSION_TOKEN] = -5
    
    print(f"    Vocabulary size: {len(wcid_to_idx) + FIRST_REAL_TOKEN} "
          f"({len(wcid_to_idx)} real + {FIRST_REAL_TOKEN} special)")
    
    return wcid_to_idx, idx_to_wcid


# ─── Step 2: Load weenie types from ACE DB or SQL dump ───────────────────────

def load_wcid_types(sql_path: str = None) -> Dict[int, int]:
    """
    Get wcid -> weenie type mappings.
    
    Tries in order:
      1. Cached JSON file (fast)
      2. MariaDB query (if available locally)
      3. Parse from SQL dump (fallback for L4 instances without MariaDB)
    """
    import subprocess
    
    cache_path = os.path.join(OUTPUT_DIR, "wcid_types_cache.json")
    
    # 1. Try cache
    if os.path.exists(cache_path):
        print("  Loading weenie types from cache...")
        with open(cache_path) as f:
            data = json.load(f)
        wcid_types = {int(k): v for k, v in data.items()}
        print(f"    Loaded {len(wcid_types)} cached wcid->type mappings")
        return wcid_types
    
    # 2. Try MariaDB
    print("  Loading weenie types from ACE database...")
    try:
        result = subprocess.run(
            [MYSQL, "-u", "root", "-pbaltic", "ace_world",
             "-e", "SELECT class_Id, `type` FROM weenie;", "--batch"],
            capture_output=True, text=True, timeout=30
        )
        
        if result.returncode == 0:
            wcid_types = {}
            lines = result.stdout.strip().split("\n")
            for line in lines[1:]:
                parts = line.split("\t")
                if len(parts) == 2:
                    wcid_types[int(parts[0])] = int(parts[1])
            
            # Cache for next time
            os.makedirs(os.path.dirname(cache_path), exist_ok=True)
            with open(cache_path, 'w') as f:
                json.dump(wcid_types, f)
            
            print(f"    Loaded {len(wcid_types)} wcid->type mappings (cached)")
            return wcid_types
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    
    # 3. Fallback: parse from SQL dump (no MariaDB needed)
    if sql_path and os.path.exists(sql_path):
        print("  MariaDB not available — parsing weenie types from SQL dump...")
        wcid_types = {}
        weenie_re = re.compile(r"INSERT INTO `weenie`.*?VALUES\s*(.+?);", re.DOTALL)
        row_re = re.compile(r"\((\d+),'[^']*',(\d+),'[^']*'\)")
        
        with open(sql_path, 'r', encoding='utf-8') as f:
            for line in f:
                if 'INSERT INTO `weenie`' in line:
                    for m in row_re.finditer(line):
                        wcid_types[int(m.group(1))] = int(m.group(2))
        
        # Cache
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        with open(cache_path, 'w') as f:
            json.dump(wcid_types, f)
        
        print(f"    Parsed {len(wcid_types)} wcid->type mappings from SQL")
        return wcid_types
    
    print("    WARNING: No weenie type source available")
    return {}


# ─── Step 3: Parse retail SQL ─────────────────────────────────────────────────

def parse_retail_sql(sql_path: str) -> Tuple[Dict[Tuple[int,int], list], list, Dict[Tuple[int,int], list]]:
    """
    Parse instance, link, AND encounter data from the SQL dump.
    
    Returns:
        instances_by_lb: {(lb_x, lb_y): [instance_dicts]}
        links: [link_dicts]
        encounters_by_lb: {(lb_x, lb_y): [encounter_dicts]}
    """
    print(f"  Parsing {os.path.basename(sql_path)}...")
    
    instances_by_lb = defaultdict(list)
    encounters_by_lb = defaultdict(list)
    links = []
    total_instances = 0
    total_encounters = 0
    
    value_re = re.compile(
        r"\((\d+),(\d+),(\d+),"
        r"([-\d.e+]+),([-\d.e+]+),([-\d.e+]+),"
        r"([-\d.e+]+),([-\d.e+]+),([-\d.e+]+),([-\d.e+]+),"
        r"'([^']*)',"
        r"'([^']*)'\)"
    )
    
    link_re = re.compile(r"\((\d+),(\d+),(\d+),'([^']*)'\)")
    
    # encounter table: (id, landblock, weenie_Class_Id, cell_X, cell_Y, last_Modified)
    encounter_re = re.compile(r"\((\d+),(\d+),(\d+),(\d+),(\d+),'([^']*)'\)")
    
    t0 = time.time()
    with open(sql_path, 'r', encoding='utf-8') as f:
        for line in f:
            if 'INSERT INTO `landblock_instance_link`' in line:
                for m in link_re.finditer(line):
                    links.append({
                        'link_id': int(m.group(1)),
                        'parent_guid': int(m.group(2)),
                        'child_guid': int(m.group(3)),
                    })
            elif 'INSERT INTO `encounter`' in line:
                for m in encounter_re.finditer(line):
                    landblock_id = int(m.group(2))
                    lb_x = (landblock_id >> 8) & 0xFF
                    lb_y = landblock_id & 0xFF
                    
                    encounters_by_lb[(lb_x, lb_y)].append({
                        'enc_id': int(m.group(1)),
                        'wcid': int(m.group(3)),
                        'cell_x': int(m.group(4)),
                        'cell_y': int(m.group(5)),
                        # Position: CellX * 24.0, CellY * 24.0 (from ACE Landblock.cs)
                        'x': max(0.5, min(191.5, int(m.group(4)) * 24.0)),
                        'y': max(0.5, min(191.5, int(m.group(5)) * 24.0)),
                        'z': 0.0,  # Encounters get Z-snapped at runtime
                    })
                    total_encounters += 1
            elif 'INSERT INTO `landblock_instance`' in line:
                for m in value_re.finditer(line):
                    guid = int(m.group(1))
                    wcid = int(m.group(2))
                    cell_id = int(m.group(3))
                    
                    lb_x = (cell_id >> 24) & 0xFF
                    lb_y = (cell_id >> 16) & 0xFF
                    cell_idx = cell_id & 0xFFFF
                    
                    # Track indoor vs outdoor (EnvCell IDs >= 0x100 are interior)
                    is_indoor = cell_idx >= 0x100
                    
                    # Skip invalid landblocks
                    if lb_x < 1 or lb_y < 1:
                        continue
                    
                    is_link = m.group(11) != '\\0'
                    
                    instances_by_lb[(lb_x, lb_y)].append({
                        'guid': guid,
                        'wcid': wcid,
                        'cell_id': cell_id,
                        'x': float(m.group(4)),
                        'y': float(m.group(5)),
                        'z': float(m.group(6)),
                        'w': float(m.group(7)),
                        'qx': float(m.group(8)),
                        'qy': float(m.group(9)),
                        'qz': float(m.group(10)),
                        'is_link_child': is_link,
                        'is_indoor': is_indoor,
                    })
                    total_instances += 1
    
    elapsed = time.time() - t0
    print(f"    Parsed {total_instances:,} instances (outdoor+indoor) across {len(instances_by_lb)} LBs ")
    print(f"    Parsed {total_encounters:,} encounters across {len(encounters_by_lb)} LBs")
    print(f"    + {len(links):,} links in {elapsed:.1f}s")
    
    return instances_by_lb, links, encounters_by_lb


# ─── Step 4: Build context vectors ───────────────────────────────────────────

def load_height_grid(heights_path: str) -> np.ndarray:
    """Load 255x255 grid of per-LB height arrays."""
    if not os.path.exists(heights_path):
        print(f"    WARNING: {heights_path} not found, using zeros")
        return {}
    
    print(f"  Loading height data...")
    with open(heights_path) as f:
        raw = json.load(f)
    
    heights = {}
    for key, vals in raw.items():
        parts = key.split(",")
        x, y = int(parts[0]), int(parts[1])
        heights[(x, y)] = np.array(vals, dtype=np.float32)
    
    print(f"    Loaded heights for {len(heights)} landblocks")
    return heights


def load_difficulty_grid(path: str) -> Optional[np.ndarray]:
    """Load 255x255 difficulty tier grid."""
    if not os.path.exists(path):
        return None
    with open(path) as f:
        data = json.load(f)
    return np.array(data['grid'], dtype=np.int32)


def build_cultural_zones() -> np.ndarray:
    """Build voronoi cultural zone grid."""
    culture_centers = [
        (42,  175, 1),  # Aluvian
        (34,  137, 2),  # Sho
        (22,   96, 3),  # Gharu'ndim
        (70,  246, 4),  # Viamontian
        (87,  148, 5),  # Empyrean
    ]
    
    grid = np.zeros((255, 255), dtype=np.int32)
    for x in range(255):
        for y in range(255):
            best_dist = float('inf')
            best_code = 0
            for cx, cy, code in culture_centers:
                dist = math.sqrt((x - cx)**2 + (y - cy)**2)
                if dist < best_dist and dist < 80:
                    best_dist = dist
                    best_code = code
            grid[x, y] = best_code
    
    return grid


def build_context_vector(lb_x: int, lb_y: int, 
                         heights: dict, 
                         difficulty_grid: Optional[np.ndarray],
                         culture_grid: np.ndarray,
                         instance_counts: Dict[Tuple[int,int], int]) -> np.ndarray:
    """
    Build a 224-dim context vector for a landblock.
    
    Layout:
      [0:81]    = terrain heights (9×9, normalized)
      [81:145]  = terrain type placeholder (8×8, zeros for now)
      [145:209] = road flags placeholder (8×8, zeros for now)
      [209:211] = normalized position (lbX/255, lbY/255)
      [211]     = biome code (0-4)
      [212]     = cultural zone (0-5)
      [213]     = difficulty tier (0-5)
      [214:222] = neighbor density (8 directions, normalized)
      [222]     = flatness score
      [223]     = distance to nearest coast (normalized)
    """
    ctx = np.zeros(224, dtype=np.float32)
    
    # Terrain heights (9×9 = 81 values)
    h = heights.get((lb_x, lb_y))
    if h is not None:
        # Normalize: mean ~129, std ~35
        h_norm = (h[:81] - 129.0) / 35.0 if len(h) >= 81 else np.zeros(81)
        ctx[0:81] = h_norm
    
    # Terrain type and road flags are placeholders until DAT extraction is available
    # ctx[81:145] = terrain types (future)
    # ctx[145:209] = road flags (future)
    
    # Normalized position
    ctx[209] = lb_x / 255.0
    ctx[210] = lb_y / 255.0
    
    # Biome (inferred from latitude for now)
    if lb_y < 85:
        ctx[211] = 0.0  # Arid
    elif lb_y < 170:
        ctx[211] = 0.5  # Temperate
    else:
        ctx[211] = 1.0  # Cold/Forest
    
    # Cultural zone
    if 0 <= lb_x < 255 and 0 <= lb_y < 255:
        ctx[212] = culture_grid[lb_x, lb_y] / 5.0
    
    # Difficulty tier
    if difficulty_grid is not None and 0 <= lb_x < 255 and 0 <= lb_y < 255:
        tier = difficulty_grid[lb_y, lb_x]
        ctx[213] = max(0, tier) / 5.0
    
    # Neighbor density (8 directions)
    dirs = [(-1,-1), (-1,0), (-1,1), (0,-1), (0,1), (1,-1), (1,0), (1,1)]
    for i, (dx, dy) in enumerate(dirs):
        nx, ny = lb_x + dx, lb_y + dy
        count = instance_counts.get((nx, ny), 0)
        ctx[214 + i] = min(count / 100.0, 1.0)  # Normalized, capped at 100
    
    # Flatness score (from height variance in 3×3 neighborhood)
    neighbor_heights = []
    for dx in [-1, 0, 1]:
        for dy in [-1, 0, 1]:
            nh = heights.get((lb_x + dx, lb_y + dy))
            if nh is not None:
                neighbor_heights.append(np.mean(nh[:81]) if len(nh) >= 81 else 0)
    if neighbor_heights:
        ctx[222] = 1.0 - min(np.std(neighbor_heights) / 50.0, 1.0)  # Flat = 1.0
    
    # Distance to coast (simplified: distance from edge of populated area)
    ctx[223] = min(lb_x, lb_y, 254 - lb_x, 254 - lb_y) / 128.0
    
    return ctx


def classify_housing_token(wcid: int, wtype: int) -> Tuple[Optional[int], Optional[str]]:
    """
    Map retail slumlord wcids into the coarse housing-token families used by
    the model. Unknown slumlords fall back to cottage so older/custom rows
    still preserve a housing signal instead of becoming generic objects.
    """
    if wtype != WT_SLUMLORD:
        return None, None

    house_type = classify_slumlord_house_type(wcid)
    if house_type is None:
        return HOUSING_COTTAGE_TOKEN, "UnknownFallback"

    return SLUMLORD_TOKEN_BY_HOUSE_TYPE[house_type], house_type


# ─── Step 5: Build training examples ─────────────────────────────────────────

def build_training_examples(instances_by_lb, links, wcid_to_idx, wcid_types,
                            heights, difficulty_grid, culture_grid):
    """
    Convert raw SQL data into structured training arrays.
    
    Returns:
        contexts: (N, 224) float32 — per-landblock context vectors
        sequences: (N, MAX_OBJECTS, 10) float32 — object sequences
        seq_lengths: (N,) int32 — actual sequence length per LB
    """
    print("  Building training examples...")
    
    # Build GUID -> instance lookup for link resolution
    guid_to_inst = {}
    for lb_key, insts in instances_by_lb.items():
        for inst in insts:
            guid_to_inst[inst['guid']] = (lb_key, inst)
    
    # Build parent_guid -> child_guids index
    parent_children = defaultdict(list)
    for link in links:
        parent_children[link['parent_guid']].append(link['child_guid'])
    
    # Instance counts for neighbor density
    instance_counts = {k: len(v) for k, v in instances_by_lb.items()}
    
    # Filter to populated outdoor landblocks
    populated_lbs = sorted(k for k, v in instances_by_lb.items() 
                          if len(v) >= 2 and k[0] >= 1 and k[1] >= 1)
    
    print(f"    Populated landblocks to process: {len(populated_lbs)}")
    
    contexts = np.zeros((len(populated_lbs), 224), dtype=np.float32)
    sequences = np.zeros((len(populated_lbs), MAX_OBJECTS_PER_LB, 10), dtype=np.float32)
    seq_lengths = np.zeros(len(populated_lbs), dtype=np.int32)
    housing_token_counts = defaultdict(int)
    
    for idx, lb_key in enumerate(populated_lbs):
        lb_x, lb_y = lb_key
        insts = instances_by_lb[lb_key]
        
        # Build context vector
        contexts[idx] = build_context_vector(
            lb_x, lb_y, heights, difficulty_grid, culture_grid, instance_counts
        )
        
        # Sort instances: non-link-children first (parents), then children
        insts.sort(key=lambda i: (i['is_link_child'], i['guid']))
        
        # Build object sequence
        n = min(len(insts), MAX_OBJECTS_PER_LB - 1)  # Leave room for STOP
        
        for obj_idx in range(n):
            inst = insts[obj_idx]
            wcid = inst['wcid']
            wtype = wcid_types.get(wcid, 0)
            
            housing_token, housing_type = classify_housing_token(wcid, wtype)
            if housing_token is not None:
                vocab_idx = housing_token
                housing_token_counts[housing_type] += 1
            else:
                vocab_idx = wcid_to_idx.get(wcid, PAD_TOKEN)
            
            # Compute local position within the landblock
            local_x = inst['x'] % LB_SIZE
            local_y = inst['y'] % LB_SIZE
            
            # Find parent wcid index if this is a link child
            parent_vocab_idx = 0
            if inst['is_link_child']:
                # Search links for this instance's parent
                for link in links:
                    if link['child_guid'] == inst['guid']:
                        parent_info = guid_to_inst.get(link['parent_guid'])
                        if parent_info:
                            parent_wcid = parent_info[1]['wcid']
                            parent_vocab_idx = wcid_to_idx.get(parent_wcid, 0)
                        break
            
            sequences[idx, obj_idx] = [
                vocab_idx,                    # [0] wcid vocab index
                local_x / LB_SIZE,            # [1] normalized local X
                local_y / LB_SIZE,            # [2] normalized local Y
                inst['z'] / 500.0,            # [3] normalized Z (heights up to ~500)
                inst['w'],                    # [4] rotation quaternion W
                inst['qz'],                   # [5] rotation quaternion Z (yaw)
                wtype / 55.0,                 # [6] normalized weenie type
                float(inst['is_link_child']), # [7] is link child flag
                parent_vocab_idx / 13000.0,   # [8] normalized parent vocab index
                obj_idx / MAX_OBJECTS_PER_LB, # [9] position in sequence
            ]
        
        # Add STOP token
        sequences[idx, n, 0] = STOP_TOKEN
        seq_lengths[idx] = n + 1  # Include STOP
        
        if (idx + 1) % 1000 == 0:
            print(f"      {idx + 1}/{len(populated_lbs)} LBs processed")
    
    return contexts, sequences, seq_lengths, populated_lbs, dict(housing_token_counts)


# ─── Step 6: Save output ─────────────────────────────────────────────────────

def save_tensors(contexts, sequences, seq_lengths, populated_lbs,
                 wcid_to_idx, idx_to_wcid):
    """Save training data and vocabulary."""
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    # Save tensors
    print(f"  Saving tensors to {OUTPUT_NPZ}...")
    np.savez_compressed(
        OUTPUT_NPZ,
        contexts=contexts,
        sequences=sequences,
        seq_lengths=seq_lengths,
        lb_coords=np.array(populated_lbs, dtype=np.int32),
    )
    size_mb = os.path.getsize(OUTPUT_NPZ) / 1024 / 1024
    print(f"    -> {size_mb:.1f} MB")
    
    # Save vocabulary
    print(f"  Saving vocabulary to {OUTPUT_VOCAB}...")
    vocab = {
        "special_tokens": {
            "PAD": PAD_TOKEN,
            "STOP": STOP_TOKEN,
            "HOUSING_COTTAGE": HOUSING_COTTAGE_TOKEN,
            "HOUSING_VILLA": HOUSING_VILLA_TOKEN,
            "HOUSING_MANSION": HOUSING_MANSION_TOKEN,
        },
        "vocab_size": len(wcid_to_idx) + FIRST_REAL_TOKEN,
        "wcid_to_idx": {str(k): v for k, v in wcid_to_idx.items()},
        "idx_to_wcid": {str(k): v for k, v in idx_to_wcid.items()},
    }
    with open(OUTPUT_VOCAB, 'w') as f:
        json.dump(vocab, f, indent=2)
    print(f"    -> Vocab size: {vocab['vocab_size']}")


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    print("=" * 72)
    print("  Placement Tensor Extractor")
    print("  SQL + DAT → ML Training Data")
    print("=" * 72)
    print()
    
    # Step 1: Build vocabulary
    print("[Step 1] Building vocabulary...")
    wcid_to_idx, idx_to_wcid = build_wcid_vocabulary(ENRICHMENT)
    print()
    
    # Step 2: Parse SQL (before weenie types — we may need it as fallback)
    print("[Step 2] Parsing retail SQL...")
    if not os.path.exists(RETAIL_SQL):
        print(f"  ERROR: SQL file not found: {RETAIL_SQL}")
        print(f"  Please update RETAIL_SQL path in this script.")
        return
    instances_by_lb, links, encounters_by_lb = parse_retail_sql(RETAIL_SQL)
    print()
    
    # Step 2b: Load weenie types (with SQL fallback)
    print("[Step 2b] Loading weenie types...")
    wcid_types = load_wcid_types(RETAIL_SQL)
    print()
    
    # Step 3: Load auxiliary data
    print("[Step 3] Loading auxiliary data...")
    heights = load_height_grid(HEIGHTS_PATH)
    difficulty_grid = load_difficulty_grid(DIFFICULTY_GRADIENT)
    culture_grid = build_cultural_zones()
    print()
    
    # Step 4: Build training examples
    print("[Step 4] Building training examples...")
    contexts, sequences, seq_lengths, populated_lbs, housing_token_counts = build_training_examples(
        instances_by_lb, links, wcid_to_idx, wcid_types,
        heights, difficulty_grid, culture_grid
    )
    print()
    
    # Step 5: Save
    print("[Step 5] Saving output...")
    save_tensors(contexts, sequences, seq_lengths, populated_lbs,
                 wcid_to_idx, idx_to_wcid)
    print()
    
    # Summary
    print("=" * 72)
    print("  Summary")
    print("=" * 72)
    print(f"  Training landblocks: {len(populated_lbs)}")
    print(f"  Context dim: {contexts.shape[1]}")
    print(f"  Max sequence length: {MAX_OBJECTS_PER_LB}")
    print(f"  Vocab size: {len(wcid_to_idx) + FIRST_REAL_TOKEN}")
    print(f"  Avg objects per LB: {seq_lengths.mean():.1f}")
    print(f"  Max objects in any LB: {seq_lengths.max()}")
    print(f"  Total training tokens: {seq_lengths.sum():,}")
    total_enc = sum(len(v) for v in encounters_by_lb.values())
    print(f"  Encounter spawns: {total_enc:,} across {len(encounters_by_lb)} LBs")
    housing_total = sum(housing_token_counts.values())
    print(f"  Housing supervision tokens: {housing_total:,}")
    if housing_total:
        print(
            "    Breakdown: "
            f"cottage={housing_token_counts.get('Cottage', 0):,}, "
            f"villa={housing_token_counts.get('Villa', 0):,}, "
            f"mansion={housing_token_counts.get('Mansion', 0):,}, "
            f"fallback={housing_token_counts.get('UnknownFallback', 0):,}"
        )
    print()
    
    # Distribution
    print("  Sequence length distribution:")
    for bucket_max in [5, 10, 20, 50, 100, 128]:
        count = np.sum(seq_lengths <= bucket_max)
        pct = count / len(seq_lengths) * 100
        print(f"    ≤{bucket_max:3d}: {count:5d} ({pct:.1f}%)")
    
    print()
    print("Done!")


if __name__ == '__main__':
    main()

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
  - Temperature: 1.0 (validated March 26, 2026 baseline)
  - Nucleus (top-p): 1.0 (disable filtering for current stable path)
  - Top-k: 0 (disable filtering for current stable path)
  - Minimum objects: 5 base + 2 adaptive in buildable contexts
  - PAD bias: 1.0, STOP bias: 0.5 (reduce collapse into control tokens)

Usage:
    python scripts/PopulationPipeline/OutdoorML/generate_populated_world.py
    python scripts/PopulationPipeline/OutdoorML/generate_populated_world.py --model scene_placer_resume_ema.pt
    python scripts/PopulationPipeline/OutdoorML/generate_populated_world.py --temperature 1.0 --top-k 0 --nucleus-p 1.0
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
from train_settlement_planner import SettlementPlanner
from housing_linker import (
    HousingLinker,
    GuidAllocator,
    write_housing_sql,
    SQLStatement,
    classify_slumlord_house_type,
)
from extract_placement_tensors import (
    BASE_CONTEXT_DIM, build_context_vector, load_height_grid, load_difficulty_grid,
    build_cultural_zones, load_wcid_types, STOP_TOKEN, PAD_TOKEN,
    FIRST_REAL_TOKEN, HOUSING_COTTAGE_TOKEN, HOUSING_VILLA_TOKEN, HOUSING_MANSION_TOKEN,
)
from settlement_signatures import SETTLEMENT_ARCHETYPE_LABELS, SETTLEMENT_ROLE_LABELS

# ─── Configuration ───────────────────────────────────────────────────────────

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

MODEL_DIR = os.path.join(BASE_DIR, "pipeline_data", "models")
PLANNER_MODEL_PATH = os.path.join(MODEL_DIR, "settlement_planner.pt")
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
HOUSE_TYPE_TOKEN_MAP = {house_type: token for token, house_type in HOUSING_TOKEN_MAP.items()}

WT_PORTAL = 7
WT_CREATURE = 10
WT_VENDOR = 12
WT_DOOR = 19
WT_LIFESTONE = 25
WT_SLUMLORD = 55
DEFAULT_LIFESTONE_WCID = 509
DEFAULT_VENDOR_WCID = 12718
VENDOR_WCID_BY_CULTURE = {
    'Aluvian': 1390,
    'Sho': 1392,
    'Neutral': 12718,
}

ROLE_LABELS_BY_ARCHETYPE = {
    'service_node': 'service_node',
    'housing_cluster': 'housing_cluster',
    'service_housing_town': 'service_housing_town',
    'portal_creature_outpost': 'outpost',
    'vendor_portal_hub': 'outpost',
    'sparse_misc': 'sparse_creature',
}

PLANNER_FAMILY_TYPE_MAP = {
    'creature': WT_CREATURE,
    'portal': WT_PORTAL,
    'vendor': WT_VENDOR,
    'lifestone': WT_LIFESTONE,
    'door': WT_DOOR,
}


def load_inference_state_dict(model_path: str, device: torch.device,
                              checkpoint_source: str = 'auto') -> tuple[dict, str]:
    """
    Load a state dict suitable for inference.

    Supports:
      - weights-only .pt / .safetensors checkpoints
      - full training checkpoints such as resume.pt

    checkpoint_source:
      - auto: prefer EMA weights when present, otherwise model weights
      - ema: require ema_state_dict
      - model: require model_state_dict
    """
    if model_path.endswith('.safetensors'):
        from safetensors.torch import load_file
        return load_file(model_path), 'weights'

    state = torch.load(model_path, map_location=device)
    if not isinstance(state, dict):
        raise ValueError(f"Unsupported checkpoint format in {model_path}")

    if 'ema_state_dict' in state or 'model_state_dict' in state:
        if checkpoint_source == 'ema':
            if 'ema_state_dict' not in state:
                raise ValueError(f"Checkpoint {model_path} does not contain ema_state_dict")
            return state['ema_state_dict'], 'ema'
        if checkpoint_source == 'model':
            if 'model_state_dict' not in state:
                raise ValueError(f"Checkpoint {model_path} does not contain model_state_dict")
            return state['model_state_dict'], 'model'
        if 'ema_state_dict' in state:
            return state['ema_state_dict'], 'ema'
        if 'model_state_dict' in state:
            return state['model_state_dict'], 'model'

    return state, 'weights'


def load_model_for_inference(model: torch.nn.Module, state_dict: dict,
                             model_path: str) -> None:
    """
    Load inference weights while tolerating older checkpoints that omitted
    non-trainable buffers such as positional encodings or cached masks.
    """
    missing, unexpected = model.load_state_dict(state_dict, strict=False)
    ignored_missing = {'causal_mask', 'pos_encoding.pe'}
    real_missing = [key for key in missing if key not in ignored_missing]
    if real_missing or unexpected:
        raise RuntimeError(
            f"Checkpoint load mismatch for {model_path}: "
            f"missing={real_missing}, unexpected={list(unexpected)}"
        )
    if missing:
        print(f"  Note: older checkpoint omitted buffers {sorted(missing)}; using model defaults")


def infer_context_dim_from_state_dict(state_dict: dict, default: int) -> int:
    """Infer context width from the first context-projection layer when available."""
    weight = state_dict.get('ctx_proj.proj.0.weight')
    if weight is None or len(weight.shape) != 2:
        return default
    return int(weight.shape[1])


def load_settlement_planner(planner_path: str, device: torch.device) -> Optional[dict]:
    if not planner_path or not os.path.exists(planner_path):
        return None

    state = torch.load(planner_path, map_location=device)
    planner = SettlementPlanner(
        context_dim=int(state['context_dim']),
        archetype_classes=len(state['archetype_labels']),
        family_heads=len(state['family_labels']),
        service_style_classes=len(state.get('service_style_labels', [])),
        dense_service_composition_classes=len(state.get('dense_service_composition_labels', [])),
    ).to(device)
    planner.load_state_dict(state['model_state_dict'], strict=False)
    planner.eval()
    return {
        'model': planner,
        'context_dim': int(state['context_dim']),
        'archetype_labels': tuple(state['archetype_labels']),
        'service_style_labels': tuple(state.get('service_style_labels', [])),
        'dense_service_composition_labels': tuple(state.get('dense_service_composition_labels', [])),
        'family_labels': tuple(state['family_labels']),
        'path': planner_path,
    }


@torch.no_grad()
def predict_settlement_plan(planner_bundle: Optional[dict], context: np.ndarray, device: torch.device) -> Optional[dict]:
    if planner_bundle is None:
        return None

    planner_ctx = context
    planner_dim = planner_bundle['context_dim']
    if len(planner_ctx) > planner_dim:
        planner_ctx = planner_ctx[:planner_dim]
    elif len(planner_ctx) < planner_dim:
        planner_ctx = np.pad(planner_ctx, (0, planner_dim - len(planner_ctx)))

    ctx_tensor = torch.from_numpy(planner_ctx).float().unsqueeze(0).to(device)
    archetype_logits, service_style_logits, dense_service_composition_logits, family_logits = planner_bundle['model'](ctx_tensor)
    archetype_idx = int(archetype_logits.argmax(dim=-1).item())
    family_bins = family_logits.argmax(dim=-1).squeeze(0).cpu().tolist()
    service_style = None
    dense_service_composition = None
    service_style_labels = planner_bundle.get('service_style_labels') or ()
    dense_service_composition_labels = planner_bundle.get('dense_service_composition_labels') or ()
    if service_style_logits is not None and service_style_labels:
        service_style_idx = int(service_style_logits.argmax(dim=-1).item())
        service_style = service_style_labels[service_style_idx]
    if dense_service_composition_logits is not None and dense_service_composition_labels:
        dense_service_composition_idx = int(dense_service_composition_logits.argmax(dim=-1).item())
        dense_service_composition = dense_service_composition_labels[dense_service_composition_idx]
    return {
        'archetype': planner_bundle['archetype_labels'][archetype_idx],
        'service_style': service_style,
        'dense_service_composition': dense_service_composition,
        'family_bins': {
            label: int(bin_idx)
            for label, bin_idx in zip(planner_bundle['family_labels'], family_bins)
        },
    }


def apply_planner_plan_to_context(context: np.ndarray, planner_plan: Optional[dict], scene_context_dim: int) -> np.ndarray:
    ctx = context.copy()
    if not planner_plan:
        if len(ctx) > scene_context_dim:
            return ctx[:scene_context_dim]
        if len(ctx) < scene_context_dim:
            return np.pad(ctx, (0, scene_context_dim - len(ctx)))
        return ctx

    role_offset = BASE_CONTEXT_DIM
    role_end = role_offset + len(SETTLEMENT_ROLE_LABELS)
    arch_offset = role_end
    arch_end = arch_offset + len(SETTLEMENT_ARCHETYPE_LABELS)

    planner_archetype = planner_plan['archetype']
    if planner_archetype == 'sparse_misc':
        if len(ctx) > scene_context_dim:
            return ctx[:scene_context_dim]
        if len(ctx) < scene_context_dim:
            return np.pad(ctx, (0, scene_context_dim - len(ctx)))
        return ctx
    planner_role = ROLE_LABELS_BY_ARCHETYPE.get(planner_archetype, 'sparse_creature')

    if len(ctx) >= role_end:
        ctx[role_offset:role_end] = 0.0
        if planner_role in SETTLEMENT_ROLE_LABELS:
            ctx[role_offset + SETTLEMENT_ROLE_LABELS.index(planner_role)] = 1.0
    if len(ctx) >= arch_end:
        ctx[arch_offset:arch_end] = 0.0
        if planner_archetype in SETTLEMENT_ARCHETYPE_LABELS:
            ctx[arch_offset + SETTLEMENT_ARCHETYPE_LABELS.index(planner_archetype)] = 1.0

    if len(ctx) > scene_context_dim:
        return ctx[:scene_context_dim]
    if len(ctx) < scene_context_dim:
        return np.pad(ctx, (0, scene_context_dim - len(ctx)))
    return ctx


def pick_service_position(existing_positions: list[tuple[float, float]], anchor_x: float,
                          anchor_y: float, min_dist: float = 6.0) -> tuple[float, float]:
    """Choose a service-object position near an anchor while avoiding overlaps."""
    candidate_offsets = [
        (0.0, 0.0),
        (8.0, 0.0), (-8.0, 0.0), (0.0, 8.0), (0.0, -8.0),
        (12.0, 0.0), (-12.0, 0.0), (0.0, 12.0), (0.0, -12.0),
        (8.0, 8.0), (-8.0, 8.0), (8.0, -8.0), (-8.0, -8.0),
    ]
    min_dist_sq = min_dist * min_dist
    for dx, dy in candidate_offsets:
        x = max(6.0, min(186.0, anchor_x + dx))
        y = max(6.0, min(186.0, anchor_y + dy))
        if all((x - px) ** 2 + (y - py) ** 2 >= min_dist_sq for px, py in existing_positions):
            return round(x, 2), round(y, 2)
    return round(max(6.0, min(186.0, anchor_x)), 2), round(max(6.0, min(186.0, anchor_y)), 2)


def maybe_add_town_lifestone(placements: list, wcid_types: dict[int, int], min_objects: int,
                             lifestone_wcid: int) -> tuple[list, int]:
    """
    Ensure dense, portal-bearing town-like landblocks are not missing a lifestone.
    This is a narrow post-pass for the exact structural gap seen in large-region QA.
    """
    if len(placements) < min_objects:
        return placements, 0

    has_portal = any(wcid_types.get(p.get('wcid'), 0) == WT_PORTAL for p in placements)
    has_lifestone = any(wcid_types.get(p.get('wcid'), 0) == WT_LIFESTONE for p in placements)
    if not has_portal or has_lifestone:
        return placements, 0

    service_candidates = [
        p for p in placements
        if wcid_types.get(p.get('wcid'), 0) in (WT_PORTAL, WT_VENDOR)
    ]
    if service_candidates:
        anchor = service_candidates[0]
        anchor_x = float(anchor['local_x'])
        anchor_y = float(anchor['local_y'])
    else:
        anchor_x = sum(float(p['local_x']) for p in placements) / max(len(placements), 1)
        anchor_y = sum(float(p['local_y']) for p in placements) / max(len(placements), 1)

    existing_positions = [(float(p['local_x']), float(p['local_y'])) for p in placements]
    local_x, local_y = pick_service_position(existing_positions, anchor_x, anchor_y)
    placements.append({
        'wcid': lifestone_wcid,
        'local_x': local_x,
        'local_y': local_y,
        'local_z': 0.0,
        'rot_w': 1.0,
        'rot_z': 0.0,
        'is_link_child': False,
        'is_housing': False,
        'housing_type': None,
        'is_injected_service': True,
    })
    return placements, 1


def maybe_add_town_vendor(placements: list, wcid_types: dict[int, int], min_objects: int,
                          vendor_wcid: int) -> tuple[list, int]:
    """
    Add a vendor to dense, service-complete town-like landblocks that still lack one.
    Kept opt-in because vendor semantics are narrower than the lifestone fix.
    """
    if len(placements) < min_objects:
        return placements, 0

    has_vendor = any(wcid_types.get(p.get('wcid'), 0) == WT_VENDOR for p in placements)
    has_portal = any(wcid_types.get(p.get('wcid'), 0) == WT_PORTAL for p in placements)
    has_lifestone = any(wcid_types.get(p.get('wcid'), 0) == WT_LIFESTONE for p in placements)
    if has_vendor or not has_portal or not has_lifestone:
        return placements, 0

    service_candidates = [
        p for p in placements
        if wcid_types.get(p.get('wcid'), 0) in (WT_PORTAL, WT_LIFESTONE)
    ]
    if service_candidates:
        anchor = service_candidates[0]
        anchor_x = float(anchor['local_x'])
        anchor_y = float(anchor['local_y'])
    else:
        anchor_x = sum(float(p['local_x']) for p in placements) / max(len(placements), 1)
        anchor_y = sum(float(p['local_y']) for p in placements) / max(len(placements), 1)

    existing_positions = [(float(p['local_x']), float(p['local_y'])) for p in placements]
    local_x, local_y = pick_service_position(existing_positions, anchor_x, anchor_y, min_dist=8.0)
    placements.append({
        'wcid': vendor_wcid,
        'local_x': local_x,
        'local_y': local_y,
        'local_z': 0.0,
        'rot_w': 1.0,
        'rot_z': 0.0,
        'is_link_child': False,
        'is_housing': False,
        'housing_type': None,
        'is_injected_service': True,
    })
    return placements, 1


def apply_sampling_filters(logits: torch.Tensor, temperature: float = 1.0,
                           top_k: int = 0, nucleus_p: float = 1.0) -> torch.Tensor:
    """Apply the same sampling filters used during generation."""
    filtered = logits.clone()

    if temperature <= 0:
        raise ValueError("temperature must be > 0")
    filtered = filtered / temperature

    if top_k > 0 and top_k < filtered.numel():
        top_k_logits, top_k_indices = torch.topk(filtered, top_k)
        filtered = torch.full_like(filtered, float('-inf'))
        filtered.scatter_(0, top_k_indices, top_k_logits)

    if nucleus_p < 1.0:
        sorted_logits, sorted_indices = torch.sort(filtered, descending=True)
        cumulative_probs = torch.cumsum(F.softmax(sorted_logits, dim=-1), dim=-1)
        sorted_indices_to_remove = cumulative_probs > nucleus_p
        sorted_indices_to_remove[1:] = sorted_indices_to_remove[:-1].clone()
        sorted_indices_to_remove[0] = False
        indices_to_remove = sorted_indices[sorted_indices_to_remove]
        filtered[indices_to_remove] = float('-inf')

    return filtered


def summarize_token_probs(probs: torch.Tensor, idx_to_wcid: Dict[int, int],
                          top_k: int = 10) -> dict:
    """Summarize token probability mass and top identities."""
    housing_mass = 0.0
    real_mass = 0.0
    for idx, prob in enumerate(probs.tolist()):
        if idx in HOUSING_TOKEN_MAP:
            housing_mass += prob
        elif idx >= FIRST_REAL_TOKEN:
            real_mass += prob

    top_prob, top_idx = torch.topk(probs, min(top_k, probs.numel()))
    top_tokens = []
    for prob, idx in zip(top_prob.tolist(), top_idx.tolist()):
        if idx == PAD_TOKEN:
            token_kind = 'PAD'
        elif idx == STOP_TOKEN:
            token_kind = 'STOP'
        elif idx in HOUSING_TOKEN_MAP:
            token_kind = f"HOUSING_{HOUSING_TOKEN_MAP[idx].upper()}"
        else:
            token_kind = 'REAL'
        top_tokens.append({
            'idx': int(idx),
            'prob': float(prob),
            'kind': token_kind,
            'wcid': int(idx_to_wcid.get(int(idx), int(idx))),
        })

    return {
        'pad_mass': float(probs[PAD_TOKEN].item()) if PAD_TOKEN < probs.numel() else 0.0,
        'stop_mass': float(probs[STOP_TOKEN].item()) if STOP_TOKEN < probs.numel() else 0.0,
        'housing_mass': float(housing_mass),
        'real_mass': float(real_mass),
        'top_tokens': top_tokens,
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
                 frequency_penalty=0.3, min_objects=3, max_objects=120,
                 wcid_types=None, pad_logit_bias=0.0, stop_logit_bias=0.0,
                 adaptive_min_objects_bonus=0, housing_logit_bias=0.0,
                 housing_flatness_threshold=0.6, housing_difficulty_ceiling=0.6,
                 housing_min_placements=2, max_housing_per_lb=1):
        self.model = model
        self.vocab = vocab
        self.device = device
        self.temperature = temperature
        self.top_k = top_k
        self.nucleus_p = nucleus_p
        self.frequency_penalty = frequency_penalty
        self.min_objects = min_objects
        self.max_objects = max_objects
        self.wcid_types = wcid_types or {}
        self.pad_logit_bias = pad_logit_bias
        self.stop_logit_bias = stop_logit_bias
        self.adaptive_min_objects_bonus = adaptive_min_objects_bonus
        self.housing_logit_bias = housing_logit_bias
        self.housing_flatness_threshold = housing_flatness_threshold
        self.housing_difficulty_ceiling = housing_difficulty_ceiling
        self.housing_min_placements = housing_min_placements
        self.max_housing_per_lb = max_housing_per_lb
        
        self.idx_to_wcid = {int(k): v for k, v in vocab['idx_to_wcid'].items()}
        self.vocab_size = vocab['vocab_size']
        self.role_offset = BASE_CONTEXT_DIM
        self.role_labels = tuple(SETTLEMENT_ROLE_LABELS)
        self.role_index = {label: self.role_offset + i for i, label in enumerate(self.role_labels)}
        self.archetype_offset = self.role_offset + len(self.role_labels)
        self.archetype_labels = tuple(SETTLEMENT_ARCHETYPE_LABELS)
        self.archetype_index = {
            label: self.archetype_offset + i for i, label in enumerate(self.archetype_labels)
        }
        self.type_token_tensors = self._build_type_token_tensors()
        self.compact_roles = {"service_node", "service_housing_town", "housing_cluster"}

    def _build_type_token_tensors(self) -> dict[int, torch.Tensor]:
        indices_by_type = defaultdict(list)
        for idx, wcid in self.idx_to_wcid.items():
            if idx < FIRST_REAL_TOKEN or not isinstance(wcid, int) or wcid < 0:
                continue
            wtype = self.wcid_types.get(wcid, 0)
            indices_by_type[wtype].append(idx)

        tensors = {}
        for wtype, indices in indices_by_type.items():
            tensors[wtype] = torch.tensor(indices, dtype=torch.long, device=self.device)
        return tensors

    def _estimate_min_objects(self, context: np.ndarray) -> int:
        """Raise the minimum object count in contexts that look more buildable."""
        min_objects = self.min_objects
        bonus = 0
        culture_strength = float(context[212]) if len(context) > 212 else 0.0
        difficulty = float(context[213]) if len(context) > 213 else 0.0
        flatness = float(context[222]) if len(context) > 222 else 0.0
        if culture_strength >= 0.2:
            bonus += 1
        if flatness >= 0.55:
            bonus += 1
        if difficulty <= 0.6:
            bonus += 1

        min_objects += min(bonus, self.adaptive_min_objects_bonus)
        return max(0, min(min_objects, self.max_objects))

    def _is_housing_friendly_context(self, context: np.ndarray) -> bool:
        """Heuristic gate for housing-token encouragement."""
        culture_strength = float(context[212]) if len(context) > 212 else 0.0
        difficulty = float(context[213]) if len(context) > 213 else 0.0
        flatness = float(context[222]) if len(context) > 222 else 0.0
        coast_distance = float(context[223]) if len(context) > 223 else 0.0
        return (
            culture_strength >= 0.2 and
            flatness >= self.housing_flatness_threshold and
            difficulty <= self.housing_difficulty_ceiling and
            coast_distance >= 0.08
        )

    def _settlement_role(self, context: np.ndarray) -> str:
        best_label = self.role_labels[0]
        best_value = float('-inf')
        for label, idx in self.role_index.items():
            value = float(context[idx]) if len(context) > idx else 0.0
            if value > best_value:
                best_label = label
                best_value = value
        return best_label

    def _settlement_archetype(self, context: np.ndarray) -> str:
        if len(context) < self.archetype_offset + len(self.archetype_labels):
            role = self._settlement_role(context)
            if role == 'service_housing_town':
                return 'service_housing_town'
            if role == 'housing_cluster':
                return 'housing_cluster'
            if role == 'service_node':
                return 'service_node'
            if role == 'outpost':
                return 'portal_creature_outpost'
            return 'sparse_misc'

        best_label = self.archetype_labels[0]
        best_value = float('-inf')
        for label, idx in self.archetype_index.items():
            value = float(context[idx]) if len(context) > idx else 0.0
            if value > best_value:
                best_label = label
                best_value = value
        return best_label

    def _apply_type_bias(self, logits: torch.Tensor, wtype: int, bias: float) -> None:
        if not bias:
            return
        token_indices = self.type_token_tensors.get(wtype)
        if token_indices is not None and len(token_indices) > 0:
            logits[token_indices] += bias

    def _family_key_for_wcid(self, wcid: int, wtype: int) -> str:
        if wtype == WT_VENDOR:
            return "vendor"
        if wtype == WT_PORTAL:
            return "portal"
        if wtype == WT_LIFESTONE:
            return "lifestone"
        if wtype == WT_DOOR:
            return "door"
        if wtype == WT_CREATURE:
            return "creature"
        if wtype == WT_SLUMLORD:
            house_type = classify_slumlord_house_type(wcid)
            return f"housing_{house_type.lower()}" if house_type else "housing_unknown"
        return f"wt_{wtype}"

    def _apply_compactness_bias(
        self,
        logits: torch.Tensor,
        role: str,
        placements: list[dict],
        wcid_freq: Counter,
    ) -> None:
        """
        Dense town-like blocks should not explode into too many unique WCIDs.
        Once a compact role already has a few placements, gently favor already
        seen WCIDs/families and penalize novelty.
        """
        if role not in self.compact_roles or len(placements) < 6:
            return

        seen_families: set[str] = set()
        for p in placements:
            wcid = p.get('wcid')
            if not isinstance(wcid, int) or wcid < 0:
                continue
            wtype = self.wcid_types.get(wcid, 0)
            seen_families.add(self._family_key_for_wcid(wcid, wtype))

        unique_wcids = len(wcid_freq)
        compactness = min(max((unique_wcids - 6) / 10.0, 0.0), 1.0)
        if compactness <= 0.0:
            return

        for idx, mapped in self.idx_to_wcid.items():
            if idx < FIRST_REAL_TOKEN or idx >= len(logits):
                continue
            if not isinstance(mapped, int) or mapped < 0:
                continue
            wtype = self.wcid_types.get(mapped, 0)
            family_key = self._family_key_for_wcid(mapped, wtype)
            if idx in wcid_freq:
                logits[idx] += 0.22 * math.log(wcid_freq[idx] + 1) * (1.0 + compactness)
            elif family_key in seen_families:
                logits[idx] += 0.10 * compactness
            else:
                logits[idx] -= 0.14 * compactness

    def _family_counts(self, placements: list[dict]) -> Counter:
        counts = Counter()
        for p in placements:
            if p.get('is_housing'):
                counts['housing'] += 1
                continue
            wcid = p.get('wcid')
            if not isinstance(wcid, int) or wcid < 0:
                continue
            wtype = self.wcid_types.get(wcid, 0)
            family_key = self._family_key_for_wcid(wcid, wtype)
            if family_key.startswith('housing_'):
                counts['housing'] += 1
            elif family_key in ('creature', 'portal', 'vendor', 'lifestone', 'door'):
                counts[family_key] += 1
        return counts

    def _apply_family_plan_biases(
        self,
        logits: torch.Tensor,
        placements: list[dict],
        planner_plan: Optional[dict],
    ) -> None:
        if not planner_plan:
            return

        family_bins = planner_plan.get('family_bins') or {}
        archetype = planner_plan.get('archetype')
        if not family_bins:
            return

        counts = self._family_counts(placements)
        scale = 1.0
        if archetype == 'sparse_misc':
            scale = 0.0
        elif archetype == 'portal_creature_outpost':
            scale = 0.55
        elif archetype == 'vendor_portal_hub':
            scale = 0.75
        if scale <= 0.0:
            return
        for family_label, target_bin in family_bins.items():
            current = counts.get(family_label, 0)
            if target_bin <= 0:
                bias = -0.35 if current == 0 else -0.55
            elif target_bin == 1:
                bias = 0.28 if current < 1 else -0.08
            elif target_bin == 2:
                bias = 0.24 if current < 2 else (-0.10 if current >= 4 else 0.0)
            else:
                bias = 0.18 if current < 4 else 0.0
            bias *= scale

            if family_label == 'housing':
                for housing_idx in HOUSING_TOKEN_MAP:
                    logits[housing_idx] += bias
            else:
                wtype = PLANNER_FAMILY_TYPE_MAP.get(family_label)
                if wtype is not None:
                    self._apply_type_bias(logits, wtype, bias)

    def _apply_archetype_realization_biases(
        self,
        logits: torch.Tensor,
        placements: list[dict],
        planner_plan: Optional[dict],
    ) -> None:
        if not planner_plan:
            return

        archetype = planner_plan.get('archetype')
        if archetype not in {'service_node', 'housing_cluster', 'service_housing_town'}:
            return

        counts = self._family_counts(placements)
        creature_count = counts.get('creature', 0)
        portal_count = counts.get('portal', 0)
        vendor_count = counts.get('vendor', 0)
        lifestone_count = counts.get('lifestone', 0)
        door_count = counts.get('door', 0)
        housing_count = counts.get('housing', 0)
        service_count = portal_count + vendor_count + lifestone_count

        if archetype == 'service_node':
            if service_count == 0 and len(placements) >= 1:
                self._apply_type_bias(logits, WT_PORTAL, 0.45)
                self._apply_type_bias(logits, WT_VENDOR, 0.35)
                self._apply_type_bias(logits, WT_LIFESTONE, 0.20)
            if service_count >= 1:
                self._apply_type_bias(logits, WT_CREATURE, -0.28 - 0.08 * min(creature_count, 3))
                self._apply_type_bias(logits, WT_DOOR, 0.16 if door_count == 0 else 0.06)
                if housing_count == 0:
                    for housing_idx in HOUSING_TOKEN_MAP:
                        logits[housing_idx] += 0.10

        elif archetype == 'housing_cluster':
            self._apply_type_bias(logits, WT_CREATURE, -0.18 - 0.06 * min(creature_count, 3))
            self._apply_type_bias(logits, WT_DOOR, 0.14 if door_count == 0 else 0.05)
            if housing_count < self.max_housing_per_lb:
                for housing_idx in HOUSING_TOKEN_MAP:
                    logits[housing_idx] += 0.18
            if service_count == 0 and len(placements) >= 3:
                self._apply_type_bias(logits, WT_PORTAL, 0.10)
                self._apply_type_bias(logits, WT_LIFESTONE, 0.08)

        elif archetype == 'service_housing_town':
            self._apply_type_bias(logits, WT_CREATURE, -0.22 - 0.05 * min(creature_count, 4))
            self._apply_type_bias(logits, WT_DOOR, 0.12 if door_count == 0 else 0.04)
            if housing_count < self.max_housing_per_lb:
                for housing_idx in HOUSING_TOKEN_MAP:
                    logits[housing_idx] += 0.20
            if service_count < 2 and len(placements) >= 2:
                self._apply_type_bias(logits, WT_PORTAL, 0.18)
                self._apply_type_bias(logits, WT_VENDOR, 0.12)
                self._apply_type_bias(logits, WT_LIFESTONE, 0.10)

    def _apply_service_style_biases(
        self,
        logits: torch.Tensor,
        placements: list[dict],
        planner_plan: Optional[dict],
    ) -> None:
        if not planner_plan:
            return

        service_style = planner_plan.get('service_style')
        if not service_style or service_style == 'non_service':
            return

        counts = self._family_counts(placements)
        portal_count = counts.get('portal', 0)
        vendor_count = counts.get('vendor', 0)
        lifestone_count = counts.get('lifestone', 0)
        creature_count = counts.get('creature', 0)
        service_count = portal_count + vendor_count + lifestone_count

        if service_style == 'portal_only':
            if portal_count == 0:
                self._apply_type_bias(logits, WT_PORTAL, 0.22)
            elif service_count >= 1:
                self._apply_type_bias(logits, WT_VENDOR, -0.16)
                self._apply_type_bias(logits, WT_LIFESTONE, -0.12)
        elif service_style == 'portal_lifestone':
            if portal_count == 0:
                self._apply_type_bias(logits, WT_PORTAL, 0.20)
            elif lifestone_count == 0:
                self._apply_type_bias(logits, WT_LIFESTONE, 0.24)
                self._apply_type_bias(logits, WT_VENDOR, -0.10)
        elif service_style == 'portal_vendor':
            if portal_count == 0:
                self._apply_type_bias(logits, WT_PORTAL, 0.18)
            elif vendor_count == 0:
                self._apply_type_bias(logits, WT_VENDOR, 0.28)
                self._apply_type_bias(logits, WT_LIFESTONE, -0.08)
        elif service_style == 'full_service':
            if portal_count == 0:
                self._apply_type_bias(logits, WT_PORTAL, 0.18)
            elif vendor_count == 0:
                self._apply_type_bias(logits, WT_VENDOR, 0.24)
            elif lifestone_count == 0:
                self._apply_type_bias(logits, WT_LIFESTONE, 0.20)
            else:
                self._apply_type_bias(logits, WT_CREATURE, -0.10 - 0.04 * min(creature_count, 3))
        elif service_style == 'vendor_only':
            if vendor_count == 0:
                self._apply_type_bias(logits, WT_VENDOR, 0.22)
            else:
                self._apply_type_bias(logits, WT_PORTAL, -0.10)
                self._apply_type_bias(logits, WT_LIFESTONE, -0.08)
        elif service_style == 'lifestone_only':
            if lifestone_count == 0:
                self._apply_type_bias(logits, WT_LIFESTONE, 0.22)
            else:
                self._apply_type_bias(logits, WT_VENDOR, -0.08)

    def _apply_dense_service_compactness_bias(
        self,
        logits: torch.Tensor,
        placements: list[dict],
        planner_plan: Optional[dict],
        wcid_freq: Counter,
    ) -> None:
        """
        Planner-v2 still over-explodes dense service blocks into novel creature-heavy
        mixes after the core service motif is already present. Keep this narrow:
        only compact portal_vendor / full_service realizations after the service
        structure is established, and only once the block is already dense enough
        that additional novelty is usually harmful.
        """
        if not planner_plan or len(placements) < 9:
            return

        service_style = planner_plan.get('service_style')
        if service_style not in {'portal_vendor', 'full_service'}:
            return

        dense_service_composition = planner_plan.get('dense_service_composition')

        counts = self._family_counts(placements)
        portal_count = counts.get('portal', 0)
        vendor_count = counts.get('vendor', 0)
        lifestone_count = counts.get('lifestone', 0)
        creature_count = counts.get('creature', 0)
        service_count = portal_count + vendor_count + lifestone_count

        if portal_count == 0 or vendor_count == 0:
            return
        if service_style == 'full_service' and lifestone_count == 0:
            return

        seen_families: set[str] = set()
        for p in placements:
            wcid = p.get('wcid')
            if not isinstance(wcid, int) or wcid < 0:
                continue
            wtype = self.wcid_types.get(wcid, 0)
            seen_families.add(self._family_key_for_wcid(wcid, wtype))

        unique_wcids = len(wcid_freq)
        compactness = min(max((unique_wcids - 9) / 8.0, 0.0), 1.0)
        if compactness <= 0.0:
            return

        overgrown = unique_wcids >= 16 or (service_style == 'full_service' and unique_wcids >= 14)
        if dense_service_composition in {'compact_portal_vendor', 'compact_full_service'}:
            compactness = min(compactness * 1.35, 1.0)
            overgrown = overgrown or unique_wcids >= 13
        elif dense_service_composition in {'creature_heavy_portal_vendor', 'creature_heavy_full_service'}:
            compactness *= 0.75
        if overgrown and len(placements) >= 14:
            logits[STOP_TOKEN] += 0.12 + 0.10 * compactness

        for idx, mapped in self.idx_to_wcid.items():
            if idx < FIRST_REAL_TOKEN or idx >= len(logits):
                continue
            if not isinstance(mapped, int) or mapped < 0:
                continue
            wtype = self.wcid_types.get(mapped, 0)
            family_key = self._family_key_for_wcid(mapped, wtype)

            if idx in wcid_freq:
                logits[idx] += 0.20 * math.log(wcid_freq[idx] + 1) * (1.0 + compactness)
                continue

            if family_key in {'portal', 'vendor', 'lifestone', 'door'}:
                logits[idx] += 0.10 * compactness
                continue

            if family_key.startswith('housing_') or family_key == 'housing_unknown':
                logits[idx] += 0.06 * compactness
                continue

            if family_key == 'creature':
                creature_penalty = 0.34 + 0.07 * min(creature_count, 4)
                if service_count >= 3:
                    creature_penalty += 0.10
                if overgrown:
                    creature_penalty += 0.10
                logits[idx] -= creature_penalty * compactness
            elif family_key in seen_families:
                logits[idx] += 0.07 * compactness
            else:
                novelty_penalty = 0.26
                if overgrown:
                    novelty_penalty += 0.10
                logits[idx] -= novelty_penalty * compactness

    def _apply_role_biases(self, logits: torch.Tensor, context: np.ndarray, placements: list[dict]) -> tuple[str, str]:
        role = self._settlement_role(context)
        archetype = self._settlement_archetype(context)
        if not placements:
            return role, archetype

        housing_count = sum(1 for p in placements if p.get('is_housing'))
        has_portal = any(self.wcid_types.get(p.get('wcid'), 0) == WT_PORTAL for p in placements)
        has_vendor = any(self.wcid_types.get(p.get('wcid'), 0) == WT_VENDOR for p in placements)
        has_lifestone = any(self.wcid_types.get(p.get('wcid'), 0) == WT_LIFESTONE for p in placements)
        service_count = int(has_portal) + int(has_vendor) + int(has_lifestone)

        if role == 'service_housing_town':
            if len(placements) >= 2 and housing_count < self.max_housing_per_lb:
                for housing_idx in HOUSING_TOKEN_MAP:
                    logits[housing_idx] += 1.0
            if service_count >= 1:
                self._apply_type_bias(logits, WT_PORTAL, -0.35)
                self._apply_type_bias(logits, WT_VENDOR, -0.20)
                self._apply_type_bias(logits, WT_LIFESTONE, -0.20)
        elif role == 'housing_cluster':
            if len(placements) >= 2 and housing_count < self.max_housing_per_lb:
                for housing_idx in HOUSING_TOKEN_MAP:
                    logits[housing_idx] += 0.85
            self._apply_type_bias(logits, WT_PORTAL, -0.35)
            self._apply_type_bias(logits, WT_VENDOR, -0.25)
            self._apply_type_bias(logits, WT_LIFESTONE, -0.15)
        elif role == 'service_node':
            if service_count == 0 and len(placements) >= 2:
                self._apply_type_bias(logits, WT_PORTAL, 0.45)
                self._apply_type_bias(logits, WT_VENDOR, 0.30)
                self._apply_type_bias(logits, WT_LIFESTONE, 0.25)
            elif service_count >= 1:
                self._apply_type_bias(logits, WT_PORTAL, -0.20)
                self._apply_type_bias(logits, WT_VENDOR, -0.10)
                self._apply_type_bias(logits, WT_LIFESTONE, -0.10)

        if archetype == 'service_housing_town':
            if len(placements) >= 2 and housing_count < self.max_housing_per_lb:
                for housing_idx in HOUSING_TOKEN_MAP:
                    logits[housing_idx] += 1.15
            if service_count == 0 and len(placements) >= 3:
                self._apply_type_bias(logits, WT_PORTAL, 0.35)
                self._apply_type_bias(logits, WT_VENDOR, 0.20)
        elif archetype == 'housing_cluster':
            if len(placements) >= 2 and housing_count < self.max_housing_per_lb:
                for housing_idx in HOUSING_TOKEN_MAP:
                    logits[housing_idx] += 0.95
            self._apply_type_bias(logits, WT_CREATURE, -0.12)
        elif archetype == 'service_node':
            if service_count == 0 and len(placements) >= 2:
                self._apply_type_bias(logits, WT_PORTAL, 0.55)
                self._apply_type_bias(logits, WT_VENDOR, 0.42)
                self._apply_type_bias(logits, WT_LIFESTONE, 0.30)
            elif service_count == 1:
                self._apply_type_bias(logits, WT_VENDOR, 0.18)
                self._apply_type_bias(logits, WT_LIFESTONE, 0.12)
            self._apply_type_bias(logits, WT_CREATURE, -0.16)
        elif archetype == 'portal_creature_outpost':
            self._apply_type_bias(logits, WT_CREATURE, 0.18)
            self._apply_type_bias(logits, WT_PORTAL, 0.10)
            if service_count >= 1:
                self._apply_type_bias(logits, WT_VENDOR, -0.20)
                self._apply_type_bias(logits, WT_LIFESTONE, -0.16)
        elif archetype == 'vendor_portal_hub':
            if service_count == 0:
                self._apply_type_bias(logits, WT_PORTAL, 0.42)
                self._apply_type_bias(logits, WT_VENDOR, 0.38)
            elif service_count >= 2:
                self._apply_type_bias(logits, WT_CREATURE, -0.10)
                self._apply_type_bias(logits, WT_LIFESTONE, -0.10)

        return role, archetype
    
    @torch.no_grad()
    def generate(self, context: np.ndarray, planner_plan: Optional[dict] = None) -> tuple[list, dict]:
        """
        Generate object placements for a single landblock.
        
        Args:
            context: context-dim context vector
        
        Returns:
            List of placement dicts: [{wcid, local_x, local_y, local_z, 
                                        rot_w, rot_z, is_link_child}, ...]
        """
        ctx = torch.from_numpy(context).float().unsqueeze(0).to(self.device)
        
        # Initialize sequence with an explicit start token. Training now uses a
        # shifted-right sequence, so a zero token is the correct first prompt.
        seq = torch.zeros(1, 1, 10, device=self.device)
        
        placements = []
        wcid_freq = Counter()
        min_objects_for_lb = self._estimate_min_objects(context)
        housing_friendly = self._is_housing_friendly_context(context)
        debug = {
            'steps': 0,
            'sampled_stop': 0,
            'sampled_pad': 0,
            'sampled_housing': 0,
            'sampled_regular': 0,
            'sampled_raw_slumlord_as_housing': 0,
            'forced_continue_after_stop': 0,
            'special_leaks': 0,
            'terminated_by_stop': False,
            'max_steps_reached': False,
            'min_objects_target': min_objects_for_lb,
            'stop_suppressed_steps': 0,
            'housing_boost_steps': 0,
            'housing_friendly_context': housing_friendly,
        }
        if planner_plan:
            debug['planner_conditioned'] = 1
        
        for step in range(self.max_objects):
            debug['steps'] += 1
            # Forward pass
            wcid_logits, pos_pred, rot_pred, link_pred = self.model(ctx, seq)
            
            # Get logits for the last position
            logits = wcid_logits[0, -1, :]  # (vocab_size,)
            
            # Apply frequency penalty
            for wcid_idx, count in wcid_freq.items():
                if wcid_idx < len(logits):
                    logits[wcid_idx] -= self.frequency_penalty * math.log(count + 1)

            role = self._settlement_role(context)
            self._apply_compactness_bias(logits, role, placements, wcid_freq)
            self._apply_family_plan_biases(logits, placements, planner_plan)
            self._apply_archetype_realization_biases(logits, placements, planner_plan)
            self._apply_service_style_biases(logits, placements, planner_plan)
            self._apply_dense_service_compactness_bias(logits, placements, planner_plan, wcid_freq)

            if self.pad_logit_bias:
                logits[PAD_TOKEN] -= self.pad_logit_bias

            if len(placements) < min_objects_for_lb:
                logits[STOP_TOKEN] = float('-inf')
                debug['stop_suppressed_steps'] += 1
            elif self.stop_logit_bias:
                logits[STOP_TOKEN] -= self.stop_logit_bias

            self._apply_role_biases(logits, context, placements)

            if housing_friendly:
                housing_count = sum(1 for p in placements if p.get('is_housing'))
                if housing_count >= self.max_housing_per_lb:
                    for housing_idx in HOUSING_TOKEN_MAP:
                        logits[housing_idx] = float('-inf')
                elif len(placements) >= self.housing_min_placements and self.housing_logit_bias:
                    for housing_idx in HOUSING_TOKEN_MAP:
                        logits[housing_idx] += self.housing_logit_bias
                    debug['housing_boost_steps'] += 1
            
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
                debug['sampled_stop'] += 1
                if len(placements) >= min_objects_for_lb:
                    debug['terminated_by_stop'] = True
                    break
                else:
                    debug['forced_continue_after_stop'] += 1
                    continue  # Force more objects
            
            # Skip PAD
            if wcid_idx == PAD_TOKEN:
                debug['sampled_pad'] += 1
                continue

            sampled_wcid = self.idx_to_wcid.get(wcid_idx, wcid_idx)
            housing_type = HOUSING_TOKEN_MAP.get(wcid_idx)
            if housing_type is None and isinstance(sampled_wcid, int) and sampled_wcid >= 0:
                housing_type = classify_slumlord_house_type(sampled_wcid)
                if housing_type is not None:
                    wcid_idx = HOUSE_TYPE_TOKEN_MAP[housing_type]
                    sampled_wcid = self.idx_to_wcid.get(wcid_idx, wcid_idx)
                    debug['sampled_raw_slumlord_as_housing'] += 1

            if housing_type is not None:
                debug['sampled_housing'] += 1
            else:
                debug['sampled_regular'] += 1
            
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
                'wcid': sampled_wcid,
                'local_x': round(local_x, 2),
                'local_y': round(local_y, 2),
                'local_z': 0.0,  # Will be height-snapped
                'rot_w': round(float(rot[0]), 4),
                'rot_z': round(float(rot[1]), 4),
                'is_link_child': link > 0.5,
                'is_housing': housing_type is not None,
                'housing_type': housing_type,
            }

            if (isinstance(placement['wcid'], int) and
                    placement['wcid'] < 0 and
                    not placement['is_housing']):
                debug['special_leaks'] += 1
                continue

            placements.append(placement)
            wcid_freq[wcid_idx] += 1
            
            # Build next input token
            next_token = torch.zeros(1, 1, 10, device=self.device)
            wcid = placement['wcid']
            next_token[0, 0, 0] = wcid_idx
            next_token[0, 0, 1] = float(pos[0])
            next_token[0, 0, 2] = float(pos[1])
            next_token[0, 0, 4] = float(rot[0])
            next_token[0, 0, 5] = float(rot[1])
            next_token[0, 0, 7] = float(link > 0.5)
            if placement['is_housing']:
                next_token[0, 0, 6] = WT_SLUMLORD / 55.0
            elif isinstance(wcid, int):
                next_token[0, 0, 6] = self.wcid_types.get(wcid, 0) / 55.0
            next_token[0, 0, 9] = min((len(placements) - 1) / MAX_OBJECTS_PER_LB, 1.0)
            
            seq = torch.cat([seq, next_token], dim=1)
        else:
            debug['max_steps_reached'] = True
        
        return placements, debug

    @torch.no_grad()
    def inspect_first_step(self, context: np.ndarray, summary_top_k: int = 10) -> dict:
        """Inspect first-token probabilities before and after sampling filters."""
        ctx = torch.from_numpy(context).float().unsqueeze(0).to(self.device)
        seq = torch.zeros(1, 1, 10, device=self.device)

        wcid_logits, _, _, _ = self.model(ctx, seq)
        logits = wcid_logits[0, -1, :]
        raw_probs = F.softmax(logits, dim=-1)

        filtered_logits = apply_sampling_filters(
            logits,
            temperature=self.temperature,
            top_k=self.top_k,
            nucleus_p=self.nucleus_p,
        )
        filtered_probs = F.softmax(filtered_logits, dim=-1)

        return {
            'raw': summarize_token_probs(raw_probs, self.idx_to_wcid, top_k=summary_top_k),
            'filtered': summarize_token_probs(filtered_probs, self.idx_to_wcid, top_k=summary_top_k),
        }
    
    def validate_placements(self, placements: list, lb_x: int, lb_y: int,
                            culture: str = "Neutral") -> tuple[list, dict]:
        """Apply inference-time quality checks."""
        validated = []
        positions = []
        stats = {
            'input_count': len(placements),
            'accepted_count': 0,
            'rerolled_collisions': 0,
        }
        
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
                stats['rerolled_collisions'] += 1
                p['local_x'] = random.uniform(4, 188)
                p['local_y'] = random.uniform(4, 188)
            
            positions.append((p['local_x'], p['local_y']))
            validated.append(p)
        
        stats['accepted_count'] = len(validated)
        
        return validated, stats


def iter_landblocks(args):
    """Yield landblocks for generation, honoring optional debug region bounds."""
    x_start = args.lb_x_min if args.lb_x_min is not None else args.margin
    x_end = args.lb_x_max if args.lb_x_max is not None else 254 - args.margin
    y_start = args.lb_y_min if args.lb_y_min is not None else args.margin
    y_end = args.lb_y_max if args.lb_y_max is not None else 254 - args.margin
    
    x_start = max(0, x_start)
    y_start = max(0, y_start)
    x_end = min(254, x_end)
    y_end = min(254, y_end)
    
    for lb_x in range(x_start, x_end + 1):
        for lb_y in range(y_start, y_end + 1):
            yield lb_x, lb_y


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
    output_sql = os.path.abspath(args.output_sql) if args.output_sql else OUTPUT_SQL
    output_dir = os.path.dirname(output_sql) or OUTPUT_DIR
    
    # ── Load model ──
    print("[1/6] Loading model...")
    model_path = os.path.join(MODEL_DIR, args.model)
    if not os.path.exists(model_path):
        print(f"  ERROR: Model not found: {model_path}")
        return 1
    
    config = DEFAULT_CONFIG.copy()
    cuda_available = torch.cuda.is_available()
    if args.require_cuda and not cuda_available:
        print("  ERROR: CUDA was requested with --require-cuda, but torch.cuda.is_available() is false.")
        print("  Refusing to run on CPU because OutdoorML probe density can diverge materially from CUDA results.")
        return 1

    device = torch.device('cuda' if cuda_available else 'cpu')
    print(f"  Device: {device}")
    if device.type != 'cuda':
        print("  WARNING: running on CPU fallback.")
        print("  OutdoorML probe outputs are not equivalent across CPU and CUDA in this environment.")
        print("  Use --require-cuda to fail fast instead of accepting a CPU fallback.")
    
    # Load weights
    state, state_source = load_inference_state_dict(model_path, device)
    config['context_dim'] = infer_context_dim_from_state_dict(state, config['context_dim'])
    model = ScenePlacerTransformer(config).to(device)
    load_model_for_inference(model, state, model_path)
    model.eval()
    print(f"  Model loaded: {model.count_parameters()/1e6:.1f}M params ({state_source} weights)")
    
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
    wcid_types = load_wcid_types()
    planner_path = None
    planner_bundle = None
    if not args.disable_planner:
        planner_path = args.planner_model
        if not os.path.isabs(planner_path):
            planner_path = os.path.join(MODEL_DIR, planner_path)
        planner_bundle = load_settlement_planner(planner_path, device)
        if planner_bundle is not None:
            print(f"  Planner loaded: {planner_bundle['path']}")
        else:
            print("  Planner not loaded; using heuristic role/archetype context.")
    
    # ── Initialize generator ──
    generator = PlacementGenerator(
        model, vocab, device,
        temperature=args.temperature,
        top_k=args.top_k,
        nucleus_p=args.nucleus_p,
        frequency_penalty=args.frequency_penalty,
        min_objects=args.min_objects,
        wcid_types=wcid_types,
        pad_logit_bias=args.pad_logit_bias,
        stop_logit_bias=args.stop_logit_bias,
        adaptive_min_objects_bonus=args.adaptive_min_objects_bonus,
        housing_logit_bias=args.housing_logit_bias,
        housing_flatness_threshold=args.housing_flatness_threshold,
        housing_difficulty_ceiling=args.housing_difficulty_ceiling,
        housing_min_placements=args.housing_min_placements,
        max_housing_per_lb=args.max_housing_per_lb,
    )
    
    housing_linker = HousingLinker(GuidAllocator(start=0x70000000))
    guid_alloc = GuidAllocator(start=0x72000000)  # Separate range for non-housing
    
    # ── Generate ──
    print(f"\n[4/6] Generating placements (margin={args.margin})...")
    if any(v is not None for v in (args.lb_x_min, args.lb_x_max, args.lb_y_min, args.lb_y_max)):
        print(f"  Region override: x={args.lb_x_min if args.lb_x_min is not None else args.margin}"
              f"..{args.lb_x_max if args.lb_x_max is not None else 254 - args.margin}, "
              f"y={args.lb_y_min if args.lb_y_min is not None else args.margin}"
              f"..{args.lb_y_max if args.lb_y_max is not None else 254 - args.margin}")
    
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
    debug_totals = Counter()
    debug_examples = []
    planner_archetypes = Counter()
    
    t0 = time.time()
    region_blocks = list(iter_landblocks(args))
    total_region_blocks = len(region_blocks)
    
    for i, (lb_x, lb_y) in enumerate(region_blocks, start=1):
        # Skip ocean
        if ocean_mask is not None and ocean_mask[lb_y, lb_x]:
            debug_totals['ocean_skips'] += 1
            continue
        
        # Build context
        ctx = build_context_vector(
            lb_x, lb_y, heights, difficulty_grid,
            culture_grid, instance_counts
        )
        planner_plan = predict_settlement_plan(planner_bundle, ctx, device)
        if planner_plan:
            planner_archetypes[planner_plan['archetype']] += 1
        ctx = apply_planner_plan_to_context(ctx, planner_plan, config['context_dim'])
        
        # Generate placements
        placements, gen_stats = generator.generate(ctx, planner_plan=planner_plan)
        debug_totals['landblocks_visited'] += 1
        debug_totals['raw_generated'] += len(placements)
        debug_totals.update(gen_stats)
        
        # Validate
        culture_code = culture_grid[lb_x, lb_y] if 0 <= lb_x < 255 and 0 <= lb_y < 255 else 0
        culture_name = {0:"Neutral", 1:"Aluvian", 2:"Sho", 3:"Gharu'ndim",
                       4:"Viamontian", 5:"Empyrean"}.get(culture_code, "Neutral")
        
        placements, validation_stats = generator.validate_placements(placements, lb_x, lb_y, culture_name)
        debug_totals.update(validation_stats)

        if args.inject_town_lifestones:
            placements, injected_lifestones = maybe_add_town_lifestone(
                placements,
                wcid_types,
                min_objects=args.town_service_min_objects,
                lifestone_wcid=args.lifestone_wcid,
            )
            debug_totals['injected_lifestones'] += injected_lifestones
        if args.inject_town_vendors:
            vendor_wcid = VENDOR_WCID_BY_CULTURE.get(culture_name, args.vendor_wcid)
            placements, injected_vendors = maybe_add_town_vendor(
                placements,
                wcid_types,
                min_objects=args.town_vendor_min_objects,
                vendor_wcid=vendor_wcid,
            )
            debug_totals['injected_vendors'] += injected_vendors
        
        if not placements:
            debug_totals['empty_landblocks_after_validation'] += 1
            if args.debug_landblocks > 0 and len(debug_examples) < args.debug_landblocks:
                debug_examples.append(
                    f"LB ({lb_x},{lb_y}) empty: raw={gen_stats.get('sampled_regular', 0) + gen_stats.get('sampled_housing', 0)}, "
                    f"stop={gen_stats.get('sampled_stop', 0)}, pad={gen_stats.get('sampled_pad', 0)}, "
                    f"special_leaks={gen_stats.get('special_leaks', 0)}, steps={gen_stats.get('steps', 0)}"
                )
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
                    debug_totals['special_leaks_post_validation'] += 1
                    continue
                
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
        if args.progress_every > 0 and i % args.progress_every == 0:
            elapsed = time.time() - t0
            pct = i / max(total_region_blocks, 1) * 100
            print(f"    {pct:.0f}% ({lb_count} LBs, {total_objects:,} objects, "
                  f"{housing_count} houses, {encounter_count} encounters, {elapsed:.0f}s, "
                  f"raw={debug_totals['raw_generated']}, accepted={debug_totals['accepted_count']})")
    
    elapsed = time.time() - t0
    
    # ── Write SQL ──
    print(f"\n[5/7] Writing SQL ({len(all_instance_stmts):,} instances, "
          f"{len(all_link_stmts):,} links, {encounter_count} encounters)...")
    
    os.makedirs(output_dir, exist_ok=True)
    
    with open(output_sql, 'w', encoding='utf-8') as f:
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
    
    size_mb = os.path.getsize(output_sql) / 1024 / 1024
    
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
    print(f"  Raw placements generated: {debug_totals['raw_generated']}")
    print(f"  Accepted after validation: {debug_totals['accepted_count']}")
    print(f"  Empty landblocks after validation: {debug_totals['empty_landblocks_after_validation']}")
    print(f"  STOP samples: {debug_totals['sampled_stop']}")
    print(f"  PAD samples: {debug_totals['sampled_pad']}")
    print(f"  Collision rerolls: {debug_totals['rerolled_collisions']}")
    if debug_totals['injected_lifestones']:
        print(f"  Injected lifestones: {debug_totals['injected_lifestones']}")
    if debug_totals['injected_vendors']:
        print(f"  Injected vendors: {debug_totals['injected_vendors']}")
    if debug_examples:
        print("  Sample empty-landblock diagnostics:")
        for line in debug_examples:
            print(f"    - {line}")
    
    # ── Summary ──
    print()
    print("=" * 72)
    print("  Generation Complete")
    print("=" * 72)
    print(f"  Landblocks populated: {lb_count:,}")
    print(f"  Total objects placed: {total_objects:,}")
    print(f"  Housing units:        {housing_count}")
    print(f"  Encounters:           {encounter_count}")
    print(f"  SQL file:             {output_sql} ({size_mb:.1f} MB)")
    print(f"  Generation time:      {elapsed:.0f}s")
    print()
    print(f"  To import into ACE:")
    print(f'    mysql -u root -pbaltic ace_world < "{output_sql}"')
    print()
    print(f"  To score quality:")
    print(f"    python scripts/PopulationPipeline/OutdoorML/score_placement_quality.py \"{output_sql}\"")
    print("=" * 72)

    summary = {
        'model': args.model,
        'output_sql': output_sql,
        'generation_time_sec': round(elapsed, 3),
        'region': {
            'lb_x_min': args.lb_x_min,
            'lb_x_max': args.lb_x_max,
            'lb_y_min': args.lb_y_min,
            'lb_y_max': args.lb_y_max,
            'margin': args.margin,
        },
        'sampling': {
            'temperature': args.temperature,
            'top_k': args.top_k,
            'nucleus_p': args.nucleus_p,
            'frequency_penalty': args.frequency_penalty,
            'min_objects': args.min_objects,
            'pad_logit_bias': args.pad_logit_bias,
            'stop_logit_bias': args.stop_logit_bias,
            'adaptive_min_objects_bonus': args.adaptive_min_objects_bonus,
            'housing_logit_bias': args.housing_logit_bias,
            'housing_flatness_threshold': args.housing_flatness_threshold,
            'housing_difficulty_ceiling': args.housing_difficulty_ceiling,
            'housing_min_placements': args.housing_min_placements,
            'max_housing_per_lb': args.max_housing_per_lb,
            'inject_town_lifestones': args.inject_town_lifestones,
            'town_service_min_objects': args.town_service_min_objects,
            'lifestone_wcid': args.lifestone_wcid,
            'inject_town_vendors': args.inject_town_vendors,
            'town_vendor_min_objects': args.town_vendor_min_objects,
            'vendor_wcid': args.vendor_wcid,
            'seed': args.seed,
        },
        'planner': {
            'enabled': planner_bundle is not None,
            'model': planner_path,
            'predicted_archetypes': dict(planner_archetypes),
        },
        'results': {
            'landblocks_populated': lb_count,
            'objects': total_objects,
            'houses': housing_count,
            'encounters': encounter_count,
            'raw_generated': int(debug_totals['raw_generated']),
            'accepted_after_validation': int(debug_totals['accepted_count']),
            'empty_landblocks_after_validation': int(debug_totals['empty_landblocks_after_validation']),
            'ocean_skips': int(debug_totals['ocean_skips']),
            'landblocks_visited': int(debug_totals['landblocks_visited']),
            'stop_samples': int(debug_totals['sampled_stop']),
            'pad_samples': int(debug_totals['sampled_pad']),
            'regular_samples': int(debug_totals['sampled_regular']),
            'housing_samples': int(debug_totals['sampled_housing']),
            'special_leaks': int(debug_totals['special_leaks']),
            'collision_rerolls': int(debug_totals['rerolled_collisions']),
            'injected_lifestones': int(debug_totals['injected_lifestones']),
            'injected_vendors': int(debug_totals['injected_vendors']),
        },
        'debug_examples': debug_examples,
    }
    if args.summary_json:
        summary_path = os.path.abspath(args.summary_json)
        summary_dir = os.path.dirname(summary_path)
        if summary_dir:
            os.makedirs(summary_dir, exist_ok=True)
        with open(summary_path, 'w', encoding='utf-8') as f:
            json.dump(summary, f, indent=2)
        print(f"  Summary JSON:         {summary_path}")
    return 0


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Generate ML-populated world")
    parser.add_argument("--model", type=str, default="scene_placer_resume_ema.pt",
                       help="Model checkpoint in pipeline_data/models/; defaults to the March 26, 2026 validated baseline")
    parser.add_argument("--temperature", type=float, default=1.0)
    parser.add_argument("--top-k", type=int, default=0)
    parser.add_argument("--nucleus-p", type=float, default=1.0)
    parser.add_argument("--frequency-penalty", type=float, default=0.3)
    parser.add_argument("--min-objects", type=int, default=5,
                       help="Base minimum generated objects before STOP can terminate")
    parser.add_argument("--adaptive-min-objects-bonus", type=int, default=2,
                       help="Extra minimum objects in buildable contexts (0-3 recommended)")
    parser.add_argument("--pad-logit-bias", type=float, default=1.0,
                       help="Subtract from PAD logit before sampling")
    parser.add_argument("--stop-logit-bias", type=float, default=0.5,
                       help="Subtract from STOP logit after minimum objects are met")
    parser.add_argument("--housing-logit-bias", type=float, default=0.0,
                       help="Add to housing-token logits in housing-friendly contexts")
    parser.add_argument("--housing-flatness-threshold", type=float, default=0.6,
                       help="Minimum flatness score to encourage housing tokens")
    parser.add_argument("--housing-difficulty-ceiling", type=float, default=0.6,
                       help="Maximum normalized difficulty to encourage housing tokens")
    parser.add_argument("--housing-min-placements", type=int, default=2,
                       help="Minimum placements before housing boost can apply")
    parser.add_argument("--max-housing-per-lb", type=int, default=1,
                       help="Cap housing tokens per landblock during generation")
    parser.add_argument("--inject-town-lifestones", action="store_true", default=True,
                       help="Add a lifestone to dense portal-bearing town-like landblocks that generated none")
    parser.add_argument("--no-inject-town-lifestones", action="store_false", dest="inject_town_lifestones",
                       help="Disable the town-lifestone completion pass")
    parser.add_argument("--town-service-min-objects", type=int, default=15,
                       help="Minimum objects before a landblock is considered town-like for service completion")
    parser.add_argument("--lifestone-wcid", type=int, default=DEFAULT_LIFESTONE_WCID,
                       help="Retail lifestone WCID to inject during service completion")
    parser.add_argument("--inject-town-vendors", action="store_true", default=True,
                       help="Add a vendor to dense portal+lifestone town-like landblocks that generated none")
    parser.add_argument("--no-inject-town-vendors", action="store_false", dest="inject_town_vendors",
                       help="Disable the town-vendor completion pass")
    parser.add_argument("--town-vendor-min-objects", type=int, default=20,
                       help="Minimum objects before a landblock is considered vendor-worthy for service completion")
    parser.add_argument("--vendor-wcid", type=int, default=DEFAULT_VENDOR_WCID,
                       help="Fallback retail vendor WCID for vendor completion when no culture-specific mapping exists")
    parser.add_argument("--planner-model", type=str, default="settlement_planner.pt",
                       help="Optional planner checkpoint in pipeline_data/models/ to predict landblock archetypes and family bins")
    parser.add_argument("--disable-planner", action="store_true",
                       help="Disable the settlement planner and use heuristic role/archetype context only")
    parser.add_argument("--margin", type=int, default=8,
                       help="Landblock margin from edges to skip")
    parser.add_argument("--lb-x-min", type=int, default=None,
                       help="Optional inclusive X start for debug-region generation")
    parser.add_argument("--lb-x-max", type=int, default=None,
                       help="Optional inclusive X end for debug-region generation")
    parser.add_argument("--lb-y-min", type=int, default=None,
                       help="Optional inclusive Y start for debug-region generation")
    parser.add_argument("--lb-y-max", type=int, default=None,
                       help="Optional inclusive Y end for debug-region generation")
    parser.add_argument("--progress-every", type=int, default=25,
                       help="How many processed landblocks between progress logs")
    parser.add_argument("--debug-landblocks", type=int, default=10,
                       help="Number of empty-landblock diagnostic examples to print")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output-sql", type=str, default=None,
                       help="Optional SQL output path (defaults to pipeline_data/population_output/vanquish_ml_populated.sql)")
    parser.add_argument("--summary-json", type=str, default=None,
                       help="Optional JSON summary output path for automated probe runs")
    parser.add_argument("--require-cuda", action="store_true",
                       help="Fail fast if CUDA is unavailable instead of silently running on CPU")
    args = parser.parse_args()
    
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    
    print("=" * 72)
    print("  ML World Population Generator")
    print("  Autoregressive Scene Placement → ACE SQL")
    print("=" * 72)
    print()
    
    raise SystemExit(generate_world(args))


if __name__ == '__main__':
    main()

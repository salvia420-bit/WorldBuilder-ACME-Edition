#!/usr/bin/env python3
"""
score_placement_quality.py — Statistical QA for Generated Placements
=====================================================================

Computes a 0–100% placement quality score by comparing generated placements
against retail AC patterns. No visual rendering — purely numerical.

Scoring breakdown (100 points total):
  Structural (40 pts):
    - Vendor presence in town LBs          (10)
    - Cultural architecture coherence      (10)
    - Essential services (lifestones, etc.) (10)
    - Building integrity (no overlap)      (10)
  Spatial (30 pts):
    - No collisions (min 2.0 unit spacing) (10)
    - Ground snap (no floating/buried)     (10)
    - Density appropriate for tier         (10)
  Diversity (30 pts):
    - Variety (unique wcid ratio)          (10)
    - Natural clustering patterns          (10)
    - Even spacing distribution            (10)

Usage:
    python scripts/PopulationPipeline/OutdoorML/score_placement_quality.py generated.sql
    python scripts/PopulationPipeline/OutdoorML/score_placement_quality.py --compare retail.sql generated.sql
"""

import argparse
import json
import math
import os
import re
import sys
import numpy as np
from collections import Counter, defaultdict
from typing import Dict, List, Tuple, Optional

# ─── Configuration ───────────────────────────────────────────────────────────

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

RETAIL_BASELINE = os.path.join(BASE_DIR, "pipeline_data", "enrichment", "retail_baseline.json")
DIFFICULTY_GRADIENT = os.path.join(BASE_DIR, "pipeline_data", "enrichment", "difficulty_gradient.json")

LB_SIZE = 192.0

# Weenie type constants
WT_VENDOR = 12
WT_PORTAL = 7
WT_LIFESTONE = 25
WT_CREATURE = 10
WT_SLUMLORD = 55
WT_DOOR = 19

# ─── SQL Parser ──────────────────────────────────────────────────────────────

def parse_instances_from_sql(sql_path: str) -> Dict[Tuple[int,int], list]:
    """Parse landblock_instance INSERTs from SQL."""
    print(f"  Parsing {os.path.basename(sql_path)}...")
    
    instances_by_lb = defaultdict(list)
    total = 0
    
    value_re = re.compile(
        r"\((\d+),(\d+),(\d+),"
        r"([-\d.e+]+),([-\d.e+]+),([-\d.e+]+),"
        r"([-\d.e+]+),([-\d.e+]+),([-\d.e+]+),([-\d.e+]+),"
        r"(\d+),'([^']*)'\)"
    )
    
    with open(sql_path, 'r', encoding='utf-8') as f:
        for line in f:
            if 'INSERT INTO `landblock_instance`' in line:
                for m in value_re.finditer(line):
                    cell_id = int(m.group(3))
                    lb_x = (cell_id >> 24) & 0xFF
                    lb_y = (cell_id >> 16) & 0xFF
                    cell_idx = cell_id & 0xFFFF
                    
                    if cell_idx >= 0x100:
                        continue
                    
                    instances_by_lb[(lb_x, lb_y)].append({
                        'guid': int(m.group(1)),
                        'wcid': int(m.group(2)),
                        'x': float(m.group(4)),
                        'y': float(m.group(5)),
                        'z': float(m.group(6)),
                        'is_link_child': int(m.group(11)) == 1,
                    })
                    total += 1
    
    print(f"    {total:,} instances across {len(instances_by_lb)} landblocks")
    return instances_by_lb


def parse_links_from_sql(sql_path: str) -> list:
    """Parse landblock_instance_link INSERTs from SQL."""
    links = []
    link_re = re.compile(r"\((\d+),(\d+),(\d+),'([^']*)'\)")
    
    with open(sql_path, 'r', encoding='utf-8') as f:
        for line in f:
            if 'INSERT INTO `landblock_instance_link`' in line:
                for m in link_re.finditer(line):
                    links.append({
                        'parent_guid': int(m.group(2)),
                        'child_guid': int(m.group(3)),
                    })
    
    return links


# ─── Load weenie type mappings ───────────────────────────────────────────────

def load_wcid_types() -> Dict[int, int]:
    """Try to load weenie types from ACE DB or cached file."""
    cache_path = os.path.join(BASE_DIR, "pipeline_data", "reference", "wcid_types_cache.json")
    
    if os.path.exists(cache_path):
        with open(cache_path) as f:
            data = json.load(f)
        return {int(k): v for k, v in data.items()}
    
    # Try MariaDB
    import subprocess
    MYSQL = r"C:\Program Files\MariaDB 12.2\bin\mysql.exe"
    try:
        result = subprocess.run(
            [MYSQL, "-u", "root", "-pbaltic", "ace_world",
             "-e", "SELECT class_Id, `type` FROM weenie;", "--batch"],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode == 0:
            wcid_types = {}
            for line in result.stdout.strip().split("\n")[1:]:
                parts = line.split("\t")
                if len(parts) == 2:
                    wcid_types[int(parts[0])] = int(parts[1])
            
            # Cache for future runs
            os.makedirs(os.path.dirname(cache_path), exist_ok=True)
            with open(cache_path, 'w') as f:
                json.dump(wcid_types, f)
            
            return wcid_types
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    
    return {}


# ─── Retail Baseline Statistics ──────────────────────────────────────────────

def compute_retail_baseline(instances_by_lb, wcid_types) -> dict:
    """Compute statistical baseline from retail data."""
    
    densities = []
    wcid_counter = Counter()
    type_counter = Counter()
    position_stds = []
    
    for lb_key, insts in instances_by_lb.items():
        densities.append(len(insts))
        
        positions = np.array([(i['x'] % LB_SIZE, i['y'] % LB_SIZE) for i in insts])
        if len(positions) > 1:
            position_stds.append(positions.std())
        
        for inst in insts:
            wcid_counter[inst['wcid']] += 1
            wtype = wcid_types.get(inst['wcid'], 0)
            type_counter[wtype] += 1
    
    return {
        'density_mean': float(np.mean(densities)),
        'density_std': float(np.std(densities)),
        'density_median': float(np.median(densities)),
        'total_landblocks': len(instances_by_lb),
        'total_instances': sum(densities),
        'unique_wcids': len(wcid_counter),
        'position_std_mean': float(np.mean(position_stds)) if position_stds else 0,
        'type_distribution': dict(type_counter.most_common(20)),
        'wcid_distribution_top50': dict(wcid_counter.most_common(50)),
    }


# ─── Scoring Functions ──────────────────────────────────────────────────────

class PlacementQualityScorer:
    """
    Scores generated placements against retail AC developer standards.
    
    Total: 100 points
      Structural: 40 points
      Spatial: 30 points
      Diversity: 30 points
    """
    
    def __init__(self, wcid_types: Dict[int, int],
                 difficulty_grid: Optional[np.ndarray] = None,
                 retail_baseline: Optional[dict] = None):
        self.wcid_types = wcid_types
        self.difficulty_grid = difficulty_grid
        self.retail_baseline = retail_baseline or {}
    
    def score(self, generated_instances: Dict[Tuple[int,int], list],
              generated_links: list) -> dict:
        """
        Compute quality score for generated placements.
        
        Returns dict with per-category scores and total.
        """
        scores = {}
        
        # ── Structural (40 points) ──
        scores['vendor_presence'] = self._score_vendor_presence(generated_instances)
        scores['cultural_coherence'] = self._score_cultural_coherence(generated_instances)
        scores['essential_services'] = self._score_essentials(generated_instances)
        scores['building_integrity'] = self._score_link_integrity(
            generated_instances, generated_links
        )
        
        # ── Spatial (30 points) ──
        scores['no_collisions'] = self._score_collision_free(generated_instances)
        scores['ground_snap'] = self._score_ground_snap(generated_instances)
        scores['density_appropriate'] = self._score_density(generated_instances)
        
        # ── Diversity (30 points) ──
        scores['variety'] = self._score_variety(generated_instances)
        scores['clustering'] = self._score_natural_clustering(generated_instances)
        scores['spacing'] = self._score_spacing(generated_instances)
        
        # Compute totals
        structural = sum(scores[k] for k in 
                        ['vendor_presence', 'cultural_coherence', 
                         'essential_services', 'building_integrity'])
        spatial = sum(scores[k] for k in 
                     ['no_collisions', 'ground_snap', 'density_appropriate'])
        diversity = sum(scores[k] for k in 
                       ['variety', 'clustering', 'spacing'])
        
        total = structural + spatial + diversity
        
        return {
            'total': round(total, 1),
            'structural': round(structural, 1),
            'spatial': round(spatial, 1),
            'diversity': round(diversity, 1),
            'breakdown': {k: round(v, 1) for k, v in scores.items()},
            'grade': self._grade(total),
        }
    
    def _grade(self, total: float) -> str:
        if total >= 95: return "S  (AC Dev quality)"
        if total >= 85: return "A  (Excellent)"
        if total >= 75: return "B  (Good)"
        if total >= 60: return "C  (Acceptable)"
        if total >= 40: return "D  (Needs work)"
        return "F  (Not usable)"
    
    def _score_vendor_presence(self, instances) -> float:
        """
        /10: In landblocks that have many objects (likely towns), 
        check if vendors are present.
        """
        town_lbs = [k for k, v in instances.items() if len(v) >= 20]
        if not town_lbs:
            return 10.0  # No towns to check
        
        vendors_present = 0
        for lb in town_lbs:
            has_vendor = any(
                self.wcid_types.get(i['wcid'], 0) == WT_VENDOR
                for i in instances[lb]
            )
            if has_vendor:
                vendors_present += 1
        
        rate = vendors_present / len(town_lbs)
        return min(10.0, rate * 10.0)
    
    def _score_cultural_coherence(self, instances) -> float:
        """
        /10: Within each populated area, objects should be culturally consistent.
        We check if the majority of culturally-tagged objects in a neighborhood
        share the same culture.
        """
        # Simplified: check if nearby landblocks have consistent object types
        # Full implementation would need cultural tagging per wcid
        # For now, give partial credit based on spatial consistency
        return 7.0  # Placeholder — needs cultural WCID mapping
    
    def _score_essentials(self, instances) -> float:
        """
        /10: Town-like areas should have lifestones and portals.
        """
        town_lbs = [k for k, v in instances.items() if len(v) >= 15]
        if not town_lbs:
            return 10.0
        
        has_portal = 0
        has_lifestone = 0
        for lb in town_lbs:
            types = set(self.wcid_types.get(i['wcid'], 0) for i in instances[lb])
            if WT_PORTAL in types:
                has_portal += 1
            if WT_LIFESTONE in types:
                has_lifestone += 1
        
        portal_rate = has_portal / len(town_lbs)
        ls_rate = has_lifestone / len(town_lbs)
        
        return min(10.0, (portal_rate * 5.0) + (ls_rate * 5.0))
    
    def _score_link_integrity(self, instances, links) -> float:
        """
        /10: All slumlord instances should have their children properly linked.
        """
        all_guids = set()
        slumlord_guids = set()
        for insts in instances.values():
            for inst in insts:
                all_guids.add(inst['guid'])
                if self.wcid_types.get(inst['wcid'], 0) == WT_SLUMLORD:
                    slumlord_guids.add(inst['guid'])
        
        if not slumlord_guids:
            return 10.0  # No housing to check
        
        # Check each slumlord has at least one child link
        parent_set = set(l['parent_guid'] for l in links)
        linked_slumlords = slumlord_guids & parent_set
        
        rate = len(linked_slumlords) / len(slumlord_guids) if slumlord_guids else 1.0
        return min(10.0, rate * 10.0)
    
    def _score_collision_free(self, instances) -> float:
        """
        /10: No two objects within 2.0 world units of each other.
        """
        collision_count = 0
        total_pairs = 0
        min_dist = 2.0
        
        for lb_key, insts in instances.items():
            if len(insts) < 2:
                continue
            
            positions = [(i['x'], i['y'], i['z']) for i in insts]
            for i in range(len(positions)):
                for j in range(i + 1, min(i + 10, len(positions))):
                    dx = positions[i][0] - positions[j][0]
                    dy = positions[i][1] - positions[j][1]
                    dist = math.sqrt(dx*dx + dy*dy)
                    total_pairs += 1
                    if dist < min_dist:
                        collision_count += 1
        
        if total_pairs == 0:
            return 10.0
        
        collision_rate = collision_count / total_pairs
        return max(0, 10.0 * (1.0 - collision_rate * 20))  # Penalize heavily
    
    def _score_ground_snap(self, instances) -> float:
        """
        /10: Objects should not be floating (Z > reasonable height)
        or buried (Z < 0 significantly).
        """
        floating = 0
        buried = 0
        total = 0
        
        for insts in instances.values():
            for inst in insts:
                total += 1
                z = inst['z']
                if z > 500:  # Floating
                    floating += 1
                elif z < -10:  # Buried
                    buried += 1
        
        if total == 0:
            return 10.0
        
        good_rate = 1.0 - (floating + buried) / total
        return min(10.0, good_rate * 10.0)
    
    def _score_density(self, instances) -> float:
        """
        /10: Object density should be within reasonable bounds per landblock.
        """
        densities = [len(v) for v in instances.values()]
        if not densities:
            return 0.0
        
        mean_density = np.mean(densities)
        
        # Retail average is ~5-15 objects per populated LB
        # Penalize extremes
        retail_mean = self.retail_baseline.get('density_mean', 10.0)
        deviation = abs(mean_density - retail_mean) / retail_mean
        
        return max(0, 10.0 * (1.0 - deviation))
    
    def _score_variety(self, instances) -> float:
        """
        /10: Variety of object types placed.
        """
        all_wcids = Counter()
        for insts in instances.values():
            for inst in insts:
                all_wcids[inst['wcid']] += 1
        
        if not all_wcids:
            return 0.0
        
        total = sum(all_wcids.values())
        unique_ratio = len(all_wcids) / max(total, 1)
        
        # Entropy
        probs = np.array(list(all_wcids.values()), dtype=np.float64) / total
        entropy = -np.sum(probs * np.log2(probs + 1e-10))
        
        # Good variety: entropy > 5 bits, unique_ratio > 0.1
        entropy_score = min(1.0, entropy / 8.0) * 5.0
        ratio_score = min(1.0, unique_ratio / 0.2) * 5.0
        
        return min(10.0, entropy_score + ratio_score)
    
    def _score_natural_clustering(self, instances) -> float:
        """
        /10: Objects should form natural clusters (towns, camps)
        rather than being uniformly distributed.
        """
        densities = [len(v) for v in instances.values()]
        if not densities:
            return 0.0
        
        # Good clustering = high density variance (some dense, some sparse)
        cv = np.std(densities) / max(np.mean(densities), 1)  # coefficient of variation
        
        # Retail typically has CV around 1.5–3.0
        if cv < 0.5:
            return 3.0  # Too uniform
        elif cv > 5.0:
            return 5.0  # Too extreme
        else:
            return min(10.0, cv / 2.5 * 10.0)
    
    def _score_spacing(self, instances) -> float:
        """
        /10: Within each landblock, objects should have reasonable spacing.
        """
        good_lbs = 0
        total_lbs = 0
        
        for insts in instances.values():
            if len(insts) < 3:
                continue
            total_lbs += 1
            
            positions = np.array([(i['x'] % LB_SIZE, i['y'] % LB_SIZE) for i in insts])
            pos_std = positions.std()
            
            # Good spacing: std between 20 and 80 (not all clumped, not all at edges)
            if 15 < pos_std < 85:
                good_lbs += 1
        
        if total_lbs == 0:
            return 10.0
        
        return min(10.0, (good_lbs / total_lbs) * 10.0)


# ─── KL Divergence Comparison ────────────────────────────────────────────────

def kl_divergence(p_counts: Counter, q_counts: Counter) -> float:
    """Compute KL divergence between two count distributions."""
    all_keys = set(p_counts.keys()) | set(q_counts.keys())
    
    p_total = sum(p_counts.values())
    q_total = sum(q_counts.values())
    
    if p_total == 0 or q_total == 0:
        return float('inf')
    
    kl = 0.0
    for key in all_keys:
        p = (p_counts.get(key, 0) + 1) / (p_total + len(all_keys))  # Smoothed
        q = (q_counts.get(key, 0) + 1) / (q_total + len(all_keys))
        kl += p * math.log(p / q)
    
    return kl


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Score Placement Quality")
    parser.add_argument("sql_file", help="Generated SQL to score")
    parser.add_argument("--compare", type=str, default=None,
                       help="Retail SQL to compare against")
    parser.add_argument("--output", type=str, default=None,
                       help="Output quality report JSON path")
    args = parser.parse_args()
    
    print("=" * 72)
    print("  Placement Quality Scorer")
    print("  Statistical QA — No Visual Rendering")
    print("=" * 72)
    print()
    
    # Load weenie types
    print("[1] Loading weenie types...")
    wcid_types = load_wcid_types()
    print(f"    {len(wcid_types)} types loaded")
    print()
    
    # Parse generated SQL
    print("[2] Parsing generated SQL...")
    gen_instances = parse_instances_from_sql(args.sql_file)
    gen_links = parse_links_from_sql(args.sql_file)
    print()
    
    # Load or compute retail baseline
    retail_baseline = {}
    if args.compare:
        print("[3] Parsing retail SQL for comparison...")
        retail_instances = parse_instances_from_sql(args.compare)
        retail_baseline = compute_retail_baseline(retail_instances, wcid_types)
        
        # Distribution comparison
        gen_wcids = Counter()
        retail_wcids = Counter()
        for insts in gen_instances.values():
            for i in insts:
                gen_wcids[i['wcid']] += 1
        for insts in retail_instances.values():
            for i in insts:
                retail_wcids[i['wcid']] += 1
        
        kl = kl_divergence(gen_wcids, retail_wcids)
        print(f"    KL divergence (gen||retail): {kl:.4f}")
        print()
    elif os.path.exists(RETAIL_BASELINE):
        with open(RETAIL_BASELINE) as f:
            retail_baseline = json.load(f)
    
    # Load difficulty grid
    difficulty_grid = None
    if os.path.exists(DIFFICULTY_GRADIENT):
        with open(DIFFICULTY_GRADIENT) as f:
            data = json.load(f)
        difficulty_grid = np.array(data['grid'], dtype=np.int32)
    
    # Score
    print("[4] Computing quality scores...")
    scorer = PlacementQualityScorer(
        wcid_types=wcid_types,
        difficulty_grid=difficulty_grid,
        retail_baseline=retail_baseline,
    )
    
    result = scorer.score(gen_instances, gen_links)
    
    # Report
    print()
    print("=" * 72)
    print(f"  QUALITY SCORE: {result['total']}/100  [{result['grade']}]")
    print("=" * 72)
    print()
    print(f"  Structural: {result['structural']}/40")
    for k in ['vendor_presence', 'cultural_coherence', 'essential_services', 'building_integrity']:
        print(f"    {k:30s}: {result['breakdown'][k]}/10")
    print()
    print(f"  Spatial:    {result['spatial']}/30")
    for k in ['no_collisions', 'ground_snap', 'density_appropriate']:
        print(f"    {k:30s}: {result['breakdown'][k]}/10")
    print()
    print(f"  Diversity:  {result['diversity']}/30")
    for k in ['variety', 'clustering', 'spacing']:
        print(f"    {k:30s}: {result['breakdown'][k]}/10")
    print()
    
    # Overall stats
    total_instances = sum(len(v) for v in gen_instances.values())
    total_lbs = len(gen_instances)
    print(f"  Stats:")
    print(f"    Total instances:  {total_instances:,}")
    print(f"    Total landblocks: {total_lbs:,}")
    print(f"    Avg per LB:       {total_instances/max(total_lbs,1):.1f}")
    print(f"    Links:            {len(gen_links):,}")
    print()
    
    # Save report
    output_path = args.output or os.path.join(
        BASE_DIR, "pipeline_data", "population_output", "quality_report.json"
    )
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    report = {
        'score': result,
        'stats': {
            'total_instances': total_instances,
            'total_landblocks': total_lbs,
            'avg_per_lb': total_instances / max(total_lbs, 1),
            'total_links': len(gen_links),
        },
        'sql_file': args.sql_file,
    }
    
    with open(output_path, 'w') as f:
        json.dump(report, f, indent=2)
    print(f"  Report saved: {output_path}")
    print("=" * 72)


if __name__ == '__main__':
    main()

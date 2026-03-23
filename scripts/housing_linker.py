#!/usr/bin/env python3
"""
housing_linker.py — Deterministic Housing GUID/Link Engine
==========================================================

Handles the special mechanics of Asheron's Call housing placement:
  - Slumlord objects with hardcoded GUIDs in the landblock
  - Parent-child linking (slumlord → crystal, hooks, storage)
  - Correct weenie class selection based on house type

This is NOT a neural network — it's a deterministic engine called by
the ML scene placer when it outputs HOUSING_COTTAGE/VILLA/MANSION tokens.

From the Discord discussion:
  - OptimShi: "There is a hard coded guid in the landblock associated 
    with the house which must match the guid of the slumlord."
  - Advan: "all the town housing that was added are all landblock instances 
    added through child/parent linking example: /creatinst -c GUID of housing 
    slumlord obj -p WeenieID of housing crystal, housing hooks, housing storage etc"

Usage:
    from housing_linker import HousingLinker, GuidAllocator
    
    linker = HousingLinker(GuidAllocator(start=0x70000000))
    sql_statements = linker.place_housing(
        house_type='Cottage', culture='Aluvian',
        world_x=32736.0, world_y=34464.0, world_z=94.0,
        lb_x=170, lb_y=179
    )
"""

import json
import os
import random
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

# ─── Configuration ───────────────────────────────────────────────────────────

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ─── GUID Allocator ──────────────────────────────────────────────────────────

class GuidAllocator:
    """
    Sequential GUID allocator for generated instances.
    
    ACE uses 32-bit unsigned GUIDs. Retail instances use various ranges.
    We allocate from a high range (0x70000000+) to avoid collisions.
    """
    
    def __init__(self, start: int = 0x70000000):
        self.next_guid = start
        self.allocated = set()
    
    def next(self) -> int:
        """Allocate the next available GUID."""
        guid = self.next_guid
        self.next_guid += 1
        self.allocated.add(guid)
        return guid
    
    def reserve(self, guid: int):
        """Reserve a specific GUID (for known retail GUIDs)."""
        self.allocated.add(guid)
        if guid >= self.next_guid:
            self.next_guid = guid + 1
    
    @property
    def total_allocated(self) -> int:
        return len(self.allocated)


# ─── Slumlord Weenie Classes ─────────────────────────────────────────────────

# From ACE WeenieClassName enum — grouped by house type and price tier
SLUMLORD_WEENIES = {
    'Cottage': {
        'cheap':     11711,  # W_SLUMLORDCOTTAGECHEAP_CLASS
        'moderate':  11713,  # W_SLUMLORDCOTTAGEMODERATE_CLASS
        'expensive': 11712,  # W_SLUMLORDCOTTAGEEXPENSIVE_CLASS
        # Numbered ranges for specific housing zones
        'ranges': [
            (11977,  349,  579),   # W_SLUMLORDCOTTAGES349_579_CLASS
            (11979,  580,  800),   # W_SLUMLORDCOTTAGE580_800_CLASS
            (12461, 1001, 1075),   # W_SLUMLORDCOTTAGE1001_1075_CLASS
            (12462, 1076, 1150),   # W_SLUMLORDCOTTAGE1076_1150_CLASS
            (13078, 1151, 1275),   # W_SLUMLORDCOTTAGE1151_1275_CLASS
            (13079, 1276, 1400),   # W_SLUMLORDCOTTAGE1276_1400_CLASS
            (14243, 1451, 1650),   # W_SLUMLORDCOTTAGE1451_1650_CLASS
            (14244, 1651, 1850),   # W_SLUMLORDCOTTAGE1651_1850_CLASS
            (14247, 1951, 2150),   # W_SLUMLORDCOTTAGE1951_2150_CLASS
            (14248, 2151, 2350),   # W_SLUMLORDCOTTAGE2151_2350_CLASS
            (14934, 2451, 2525),   # W_SLUMLORDCOTTAGE2451_2525_CLASS
            (14935, 2526, 2600),   # W_SLUMLORDCOTTAGE2526_2600_CLASS
        ]
    },
    'Villa': {
        'cheap':     11717,  # W_SLUMLORDVILLACHEAP_CLASS
        'moderate':  11719,  # W_SLUMLORDVILLAMODERATE_CLASS
        'expensive': 11718,  # W_SLUMLORDVILLAEXPENSIVE_CLASS
        'ranges': [
            (11978,  851,  925),
            (11980,  926,  970),
            (13080, 1401, 1440),
            (14245, 1851, 1940),
            (14249, 2351, 2440),
            (14936, 2601, 2640),
        ]
    },
    'Mansion': {
        'cheap':     11714,  # W_SLUMLORDMANSIONCHEAP_CLASS
        'moderate':  11716,  # W_SLUMLORDMANSIONMODERATE_CLASS
        'expensive': 11715,  # W_SLUMLORDMANSIONEXPENSIVE_CLASS
        'ranges': [
            (13081, 1441, 1450),
            (14246, 1941, 1950),
            (14250, 2441, 2450),
            (14937, 2641, 2650),
        ]
    }
}

# ─── Housing Child Templates ─────────────────────────────────────────────────

# These define what objects get linked as children of each slumlord type.
# In retail AC, the children are:
#   - Housing Crystal (the UI element for buying)
#   - House Hooks (for placing decorations)
#   - House Storage (chests)
#   - House Sign (the sign outside)

# Approximate weenie IDs (from retail — these vary by housing batch)
HOUSING_TEMPLATES = {
    'Cottage': {
        'description': 'Small single-room house, 1-2 hooks, 1 storage',
        'children': [
            {'role': 'crystal',  'wcid': 9621,  'offset_x': 0.0, 'offset_y': 2.0, 'offset_z': 0.0},
            {'role': 'hook',     'wcid': 9686,  'offset_x': 3.0, 'offset_y': 0.0, 'offset_z': 1.5},
            {'role': 'hook',     'wcid': 9686,  'offset_x': -3.0, 'offset_y': 0.0, 'offset_z': 1.5},
            {'role': 'storage',  'wcid': 9687,  'offset_x': 0.0, 'offset_y': -2.0, 'offset_z': 0.0},
            {'role': 'sign',     'wcid': 9688,  'offset_x': 0.0, 'offset_y': 5.0, 'offset_z': 0.0},
        ],
        'footprint': (12, 12),  # approximate size in world units
    },
    'Villa': {
        'description': 'Medium multi-room house, 4-6 hooks, 2 storage',
        'children': [
            {'role': 'crystal',  'wcid': 9621,  'offset_x': 0.0, 'offset_y': 2.0, 'offset_z': 0.0},
            {'role': 'hook',     'wcid': 9686,  'offset_x': 5.0, 'offset_y': 0.0, 'offset_z': 1.5},
            {'role': 'hook',     'wcid': 9686,  'offset_x': -5.0, 'offset_y': 0.0, 'offset_z': 1.5},
            {'role': 'hook',     'wcid': 9686,  'offset_x': 5.0, 'offset_y': 5.0, 'offset_z': 1.5},
            {'role': 'hook',     'wcid': 9686,  'offset_x': -5.0, 'offset_y': 5.0, 'offset_z': 1.5},
            {'role': 'storage',  'wcid': 9687,  'offset_x': 3.0, 'offset_y': -2.0, 'offset_z': 0.0},
            {'role': 'storage',  'wcid': 9687,  'offset_x': -3.0, 'offset_y': -2.0, 'offset_z': 0.0},
            {'role': 'sign',     'wcid': 9688,  'offset_x': 0.0, 'offset_y': 8.0, 'offset_z': 0.0},
        ],
        'footprint': (18, 18),
    },
    'Mansion': {
        'description': 'Large estate, 8-12 hooks, 4 storage',
        'children': [
            {'role': 'crystal',  'wcid': 9621,  'offset_x': 0.0, 'offset_y': 3.0, 'offset_z': 0.0},
            {'role': 'hook',     'wcid': 9686,  'offset_x': 8.0, 'offset_y': 0.0, 'offset_z': 1.5},
            {'role': 'hook',     'wcid': 9686,  'offset_x': -8.0, 'offset_y': 0.0, 'offset_z': 1.5},
            {'role': 'hook',     'wcid': 9686,  'offset_x': 8.0, 'offset_y': 8.0, 'offset_z': 1.5},
            {'role': 'hook',     'wcid': 9686,  'offset_x': -8.0, 'offset_y': 8.0, 'offset_z': 1.5},
            {'role': 'hook',     'wcid': 9686,  'offset_x': 4.0, 'offset_y': 4.0, 'offset_z': 1.5},
            {'role': 'hook',     'wcid': 9686,  'offset_x': -4.0, 'offset_y': 4.0, 'offset_z': 1.5},
            {'role': 'hook',     'wcid': 9686,  'offset_x': 4.0, 'offset_y': -4.0, 'offset_z': 1.5},
            {'role': 'hook',     'wcid': 9686,  'offset_x': -4.0, 'offset_y': -4.0, 'offset_z': 1.5},
            {'role': 'storage',  'wcid': 9687,  'offset_x': 6.0, 'offset_y': -3.0, 'offset_z': 0.0},
            {'role': 'storage',  'wcid': 9687,  'offset_x': -6.0, 'offset_y': -3.0, 'offset_z': 0.0},
            {'role': 'storage',  'wcid': 9687,  'offset_x': 6.0, 'offset_y': 6.0, 'offset_z': 0.0},
            {'role': 'storage',  'wcid': 9687,  'offset_x': -6.0, 'offset_y': 6.0, 'offset_z': 0.0},
            {'role': 'sign',     'wcid': 9688,  'offset_x': 0.0, 'offset_y': 12.0, 'offset_z': 0.0},
        ],
        'footprint': (28, 28),
    }
}


# ─── Main Housing Linker ─────────────────────────────────────────────────────

@dataclass
class SQLStatement:
    """Represents a SQL INSERT or UPDATE statement."""
    table: str
    values: dict
    
    def to_instance_sql(self) -> str:
        """Generate landblock_instance INSERT."""
        v = self.values
        is_link = 1 if v.get('is_link_child', False) else 0
        return (
            f"({v['guid']},{v['wcid']},{v['cell_id']},"
            f"{v['x']},{v['y']},{v['z']},"
            f"{v['w']},{v['qx']},{v['qy']},{v['qz']},"
            f"{is_link},'{v['last_modified']}')"
        )
    
    def to_link_sql(self) -> str:
        """Generate landblock_instance_link INSERT."""
        v = self.values
        return (
            f"({v['link_id']},{v['parent_guid']},{v['child_guid']},"
            f"'{v['last_modified']}')"
        )


class HousingLinker:
    """
    Deterministic housing placement engine.
    
    When the ML scene placer outputs a HOUSING_COTTAGE/VILLA/MANSION token,
    this engine generates all the necessary SQL for a complete housing unit:
      1. Slumlord instance (with unique GUID)
      2. Child objects (crystal, hooks, storage) linked via instance_link
      3. All with correct obj_Cell_Id matching the target landblock
    """
    
    def __init__(self, guid_allocator: GuidAllocator, 
                 link_id_start: int = 1000000):
        self.guid_alloc = guid_allocator
        self.next_link_id = link_id_start
        self.placed_houses = []  # Track all placed houses for validation
        self.templates = HOUSING_TEMPLATES
        self._housing_number = 0  # Sequential housing number for slumlord selection
    
    def _next_link_id(self) -> int:
        lid = self.next_link_id
        self.next_link_id += 1
        return lid
    
    def pick_slumlord_wcid(self, house_type: str, price_tier: str = 'moderate') -> int:
        """
        Select the appropriate slumlord weenie class.
        
        Args:
            house_type: 'Cottage', 'Villa', or 'Mansion'
            price_tier: 'cheap', 'moderate', or 'expensive'
        
        Returns:
            Weenie class ID for the slumlord
        """
        self._housing_number += 1
        
        slumlord_info = SLUMLORD_WEENIES.get(house_type)
        if not slumlord_info:
            raise ValueError(f"Unknown house type: {house_type}")
        
        # Check if this housing number falls in a numbered range
        for range_wcid, lo, hi in slumlord_info.get('ranges', []):
            if lo <= self._housing_number <= hi:
                return range_wcid
        
        # Otherwise use the generic tier-based slumlord
        return slumlord_info.get(price_tier, slumlord_info['moderate'])
    
    def place_housing(self, house_type: str, culture: str,
                      world_x: float, world_y: float, world_z: float,
                      lb_x: int, lb_y: int,
                      price_tier: str = 'moderate',
                      rotation_w: float = 1.0,
                      rotation_z: float = 0.0) -> List[SQLStatement]:
        """
        Generate all SQL statements for a complete housing placement.
        
        CRITICAL: The slumlord GUID is hardcoded in the landblock and must
        match the actual spawned slumlord object's GUID. This function handles
        that by being the single source of truth for GUID allocation.
        
        Args:
            house_type: 'Cottage', 'Villa', or 'Mansion'
            culture: 'Aluvian', 'Sho', etc. (for future culture-specific buildings)
            world_x, world_y, world_z: Absolute world position
            lb_x, lb_y: Landblock coordinates
            price_tier: 'cheap', 'moderate', or 'expensive'
            rotation_w, rotation_z: Orientation quaternion components
        
        Returns:
            List of SQLStatement objects (instances + links)
        """
        now = time.strftime('%Y-%m-%d %H:%M:%S')
        
        # 1. Pick slumlord weenie class
        slumlord_wcid = self.pick_slumlord_wcid(house_type, price_tier)
        
        # 2. Allocate unique GUID for the slumlord
        #    THIS IS THE CRITICAL GUID that must match the landblock reference
        slumlord_guid = self.guid_alloc.next()
        
        # 3. Build obj_Cell_Id
        cell_id = (lb_x << 24) | (lb_y << 16) | 0x0001
        
        # 4. Create slumlord instance
        statements = []
        statements.append(SQLStatement(
            table='landblock_instance',
            values={
                'guid': slumlord_guid,
                'wcid': slumlord_wcid,
                'cell_id': cell_id,
                'x': round(world_x, 6),
                'y': round(world_y, 6),
                'z': round(world_z, 6),
                'w': rotation_w,
                'qx': 0.0,
                'qy': 0.0,
                'qz': rotation_z,
                'is_link_child': False,
                'last_modified': now,
            }
        ))
        
        # 5. Create child objects from template
        template = self.templates.get(house_type)
        if not template:
            raise ValueError(f"No template for house type: {house_type}")
        
        for child_def in template['children']:
            child_guid = self.guid_alloc.next()
            
            # Child instance (positioned relative to slumlord)
            statements.append(SQLStatement(
                table='landblock_instance',
                values={
                    'guid': child_guid,
                    'wcid': child_def['wcid'],
                    'cell_id': cell_id,
                    'x': round(world_x + child_def['offset_x'], 6),
                    'y': round(world_y + child_def['offset_y'], 6),
                    'z': round(world_z + child_def['offset_z'], 6),
                    'w': rotation_w,
                    'qx': 0.0,
                    'qy': 0.0,
                    'qz': rotation_z,
                    'is_link_child': True,
                    'last_modified': now,
                }
            ))
            
            # Parent-child link
            statements.append(SQLStatement(
                table='landblock_instance_link',
                values={
                    'link_id': self._next_link_id(),
                    'parent_guid': slumlord_guid,
                    'child_guid': child_guid,
                    'last_modified': now,
                }
            ))
        
        # Track this placement
        self.placed_houses.append({
            'house_type': house_type,
            'culture': culture,
            'slumlord_guid': slumlord_guid,
            'slumlord_wcid': slumlord_wcid,
            'lb': (lb_x, lb_y),
            'position': (world_x, world_y, world_z),
            'child_count': len(template['children']),
        })
        
        return statements
    
    def validate_placements(self) -> dict:
        """
        Validate all placed houses for correctness.
        
        Returns a report dict with any issues found.
        """
        issues = []
        
        # Check for duplicate slumlord GUIDs
        seen_guids = set()
        for house in self.placed_houses:
            guid = house['slumlord_guid']
            if guid in seen_guids:
                issues.append(f"DUPLICATE GUID {guid:#x} for {house['house_type']} at {house['lb']}")
            seen_guids.add(guid)
        
        # Check for houses too close together
        for i, h1 in enumerate(self.placed_houses):
            for h2 in self.placed_houses[i+1:]:
                dx = h1['position'][0] - h2['position'][0]
                dy = h1['position'][1] - h2['position'][1]
                dist = (dx**2 + dy**2) ** 0.5
                
                # Minimum distance based on house type
                min_dist = max(
                    HOUSING_TEMPLATES[h1['house_type']]['footprint'][0],
                    HOUSING_TEMPLATES[h2['house_type']]['footprint'][0]
                ) * 1.5
                
                if dist < min_dist:
                    issues.append(
                        f"Houses too close: {h1['house_type']} and {h2['house_type']} "
                        f"at distance {dist:.1f} (min {min_dist:.1f})"
                    )
        
        return {
            'total_houses': len(self.placed_houses),
            'by_type': {
                ht: sum(1 for h in self.placed_houses if h['house_type'] == ht)
                for ht in ['Cottage', 'Villa', 'Mansion']
            },
            'total_guids_allocated': self.guid_alloc.total_allocated,
            'issues': issues,
            'is_valid': len(issues) == 0,
        }


# ─── SQL Writer ───────────────────────────────────────────────────────────────

def write_housing_sql(statements: List[SQLStatement], output_path: str):
    """Write housing SQL statements to a file."""
    
    instance_stmts = [s for s in statements if s.table == 'landblock_instance']
    link_stmts = [s for s in statements if s.table == 'landblock_instance_link']
    
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(f"-- Housing Placement SQL\n")
        f.write(f"-- Generated: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
        f.write(f"-- Instances: {len(instance_stmts)}, Links: {len(link_stmts)}\n\n")
        
        # Write instances in batches of 500
        batch_size = 500
        for i in range(0, len(instance_stmts), batch_size):
            batch = instance_stmts[i:i+batch_size]
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
        for i in range(0, len(link_stmts), batch_size):
            batch = link_stmts[i:i+batch_size]
            f.write(
                "INSERT INTO `landblock_instance_link` "
                "(`id`, `parent_GUID`, `child_GUID`, `last_Modified`) VALUES\n"
            )
            f.write(",\n".join(s.to_link_sql() for s in batch))
            f.write(";\n\n")
    
    size_kb = os.path.getsize(output_path) / 1024
    print(f"  Written {len(instance_stmts)} instances + {len(link_stmts)} links "
          f"to {output_path} ({size_kb:.1f} KB)")


# ─── Retail Housing Template Extractor ────────────────────────────────────────

def extract_retail_housing_templates(sql_path: str) -> dict:
    """
    Extract housing templates from the retail SQL dump.
    
    This finds all slumlord instances and their linked children to build
    accurate templates for each house type.
    """
    print("  Extracting retail housing templates...")
    
    import re
    
    # First pass: find all slumlord instances
    slumlord_guids = {}  # guid -> wcid
    all_instances = {}    # guid -> instance data
    
    value_re = re.compile(
        r"\((\d+),(\d+),(\d+),"
        r"([-\d.e+]+),([-\d.e+]+),([-\d.e+]+),"
        r"([-\d.e+]+),([-\d.e+]+),([-\d.e+]+),([-\d.e+]+),"
        r"'([^']*)',"
        r"'([^']*)'\)"
    )
    
    link_re = re.compile(r"\((\d+),(\d+),(\d+),'([^']*)'\)")
    
    # All known slumlord wcids
    all_slumlord_wcids = set()
    for ht_info in SLUMLORD_WEENIES.values():
        all_slumlord_wcids.add(ht_info['cheap'])
        all_slumlord_wcids.add(ht_info['moderate'])
        all_slumlord_wcids.add(ht_info['expensive'])
        for rwcid, _, _ in ht_info.get('ranges', []):
            all_slumlord_wcids.add(rwcid)
    
    links = []
    
    with open(sql_path, 'r', encoding='utf-8') as f:
        for line in f:
            if 'INSERT INTO `landblock_instance_link`' in line:
                for m in link_re.finditer(line):
                    links.append({
                        'parent_guid': int(m.group(2)),
                        'child_guid': int(m.group(3)),
                    })
            elif 'INSERT INTO `landblock_instance`' in line:
                for m in value_re.finditer(line):
                    guid = int(m.group(1))
                    wcid = int(m.group(2))
                    
                    inst = {
                        'guid': guid,
                        'wcid': wcid,
                        'x': float(m.group(4)),
                        'y': float(m.group(5)),
                        'z': float(m.group(6)),
                    }
                    all_instances[guid] = inst
                    
                    if wcid in all_slumlord_wcids:
                        slumlord_guids[guid] = wcid
    
    print(f"    Found {len(slumlord_guids)} slumlord instances")
    
    # Build templates from retail data
    templates_by_type = defaultdict(list)
    for parent_guid, parent_wcid in slumlord_guids.items():
        children = []
        for link in links:
            if link['parent_guid'] == parent_guid:
                child = all_instances.get(link['child_guid'])
                if child:
                    parent = all_instances.get(parent_guid)
                    if parent:
                        children.append({
                            'wcid': child['wcid'],
                            'offset_x': round(child['x'] - parent['x'], 1),
                            'offset_y': round(child['y'] - parent['y'], 1),
                            'offset_z': round(child['z'] - parent['z'], 1),
                        })
        
        # Determine house type from slumlord wcid
        house_type = None
        for ht, info in SLUMLORD_WEENIES.items():
            if parent_wcid in (info['cheap'], info['moderate'], info['expensive']):
                house_type = ht
                break
            for rwcid, _, _ in info.get('ranges', []):
                if parent_wcid == rwcid:
                    house_type = ht
                    break
        
        if house_type and children:
            templates_by_type[house_type].append({
                'slumlord_wcid': parent_wcid,
                'children': children,
            })
    
    for ht, tmpls in templates_by_type.items():
        print(f"    {ht}: {len(tmpls)} examples, avg {sum(len(t['children']) for t in tmpls)/len(tmpls):.1f} children")
    
    return dict(templates_by_type)


# ─── Main (for testing) ──────────────────────────────────────────────────────

def main():
    print("=" * 72)
    print("  Housing Linker — Test Mode")
    print("=" * 72)
    print()
    
    alloc = GuidAllocator(start=0x70000000)
    linker = HousingLinker(alloc)
    
    # Test: Place housing of each type
    all_statements = []
    
    test_placements = [
        ('Cottage', 'Aluvian', 32736.0, 34464.0, 94.0, 170, 179),
        ('Cottage', 'Aluvian', 32800.0, 34464.0, 94.0, 170, 179),
        ('Villa', 'Sho', 42000.0, 26000.0, 50.0, 218, 135),
        ('Mansion', "Gharu'ndim", 24000.0, 18000.0, 30.0, 125, 93),
    ]
    
    for house_type, culture, wx, wy, wz, lx, ly in test_placements:
        stmts = linker.place_housing(
            house_type=house_type,
            culture=culture,
            world_x=wx, world_y=wy, world_z=wz,
            lb_x=lx, lb_y=ly,
        )
        all_statements.extend(stmts)
        print(f"  Placed {house_type} at ({lx},{ly}): {len(stmts)} SQL statements")
    
    # Validate
    print()
    report = linker.validate_placements()
    print(f"  Total houses: {report['total_houses']}")
    print(f"  By type: {report['by_type']}")
    print(f"  GUIDs allocated: {report['total_guids_allocated']}")
    print(f"  Valid: {report['is_valid']}")
    for issue in report['issues']:
        print(f"  ⚠️  {issue}")
    
    # Write test SQL
    output_path = os.path.join(BASE_DIR, "pipeline_data", "population_output", "housing_test.sql")
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    write_housing_sql(all_statements, output_path)
    
    print()
    print("Done!")


if __name__ == '__main__':
    main()

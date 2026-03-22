#!/usr/bin/env python3
"""
cluster_shuffle_populate.py — DB-First Cluster Shuffle World Population
========================================================================

Novel approach to populating the Vanquish world:
  1. Parse the retail ACE SQL dump (155MB) to extract ALL 365K instances
  2. Group instances by landblock, detect spatial clusters
  3. Classify clusters (town, hunting, dungeon entrance, scenery)
  4. Map each cluster to a valid location in the Vanquish world
  5. Output remapped SQL ready for import into ace_world

This avoids the LSD-Partial data gap (45% coverage) by using the
authoritative ACE database SQL as the single source of truth.

Usage:
    python scripts/cluster_shuffle_populate.py [--dry-run] [--output remapped.sql]
"""

import json
import math
import os
import re
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

# ─── Configuration ───────────────────────────────────────────────────────────

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

RETAIL_SQL = r"D:\ACE\world-db\ACE-World-Database-v0.9.292.sql"
DIFFICULTY_GRADIENT = os.path.join(BASE_DIR, "difficulty_gradient.json")

# ACE DB connection (for weenie type lookups)
MYSQL = r"C:\Program Files\MariaDB 12.2\bin\mysql.exe"

# Output
OUTPUT_DIR = os.path.join(BASE_DIR, "population_output")
OUTPUT_SQL = os.path.join(OUTPUT_DIR, "vanquish_instances.sql")
CLUSTER_JSON = os.path.join(OUTPUT_DIR, "clusters.json")

# Landblock grid: 0-254 for outdoor cells (255x255)
LB_SIZE = 192.0  # world units per landblock

# ─── Data Classes ────────────────────────────────────────────────────────────

@dataclass
class InstanceLink:
    """A parent-child relationship between two instances."""
    link_id: int
    parent_guid: int
    child_guid: int
    last_modified: str


@dataclass
class Instance:
    """A single landblock instance from the retail SQL."""
    guid: int
    wcid: int
    obj_cell_id: int
    origin_x: float
    origin_y: float
    origin_z: float
    angles_w: float
    angles_x: float
    angles_y: float
    angles_z: float
    is_link_child: bool
    last_modified: str

    @property
    def lb_x(self) -> int:
        return (self.obj_cell_id >> 24) & 0xFF

    @property
    def lb_y(self) -> int:
        return (self.obj_cell_id >> 16) & 0xFF

    @property
    def lb_key(self) -> Tuple[int, int]:
        return (self.lb_x, self.lb_y)

    @property
    def is_outdoor(self) -> bool:
        """Outdoor landblocks have lbX >= 1 and cell index in lower 16 bits."""
        return self.lb_x >= 1 and self.lb_y >= 1

    @property
    def is_interior(self) -> bool:
        """Interior cells (dungeons/building interiors) have specific patterns."""
        cell_idx = self.obj_cell_id & 0xFFFF
        return cell_idx >= 0x100  # EnvCell IDs start at 0x100


@dataclass
class Cluster:
    """A group of connected populated landblocks forming a logical unit."""
    cluster_id: int
    landblocks: Set[Tuple[int, int]] = field(default_factory=set)
    instances: List[Instance] = field(default_factory=list)
    classification: str = "unknown"  # town, hunting, dungeon_entrance, scenery, interior
    difficulty_tier: int = -1
    footprint_w: int = 0  # width in landblocks
    footprint_h: int = 0  # height in landblocks

    # Target placement in Vanquish
    target_offset_x: int = 0  # landblock offset X
    target_offset_y: int = 0  # landblock offset Y

    @property
    def instance_count(self) -> int:
        return len(self.instances)

    @property
    def lb_count(self) -> int:
        return len(self.landblocks)

    def compute_footprint(self):
        if not self.landblocks:
            return
        xs = [lb[0] for lb in self.landblocks]
        ys = [lb[1] for lb in self.landblocks]
        self.footprint_w = max(xs) - min(xs) + 1
        self.footprint_h = max(ys) - min(ys) + 1

    @property
    def center_lb(self) -> Tuple[float, float]:
        if not self.landblocks:
            return (0, 0)
        xs = [lb[0] for lb in self.landblocks]
        ys = [lb[1] for lb in self.landblocks]
        return (sum(xs) / len(xs), sum(ys) / len(ys))


# ─── Step 1: Parse Retail SQL ────────────────────────────────────────────────

def parse_retail_sql(sql_path: str) -> Tuple[Dict[Tuple[int, int], List[Instance]], List[InstanceLink]]:
    """
    Parse the ACE World SQL dump and extract all landblock_instance AND
    landblock_instance_link rows.

    Returns: (instances_by_lb, links)
    """
    print(f"  Parsing {os.path.basename(sql_path)} ({os.path.getsize(sql_path)/1024/1024:.1f} MB)...")

    instances_by_lb = defaultdict(list)
    links = []
    total_instances = 0
    interior_instances = 0

    # Regex for instance value tuples
    value_pattern = re.compile(
        r"\((\d+),(\d+),(\d+),"          # guid, wcid, obj_cell_id
        r"([-\d.e+]+),([-\d.e+]+),([-\d.e+]+),"  # x, y, z
        r"([-\d.e+]+),([-\d.e+]+),([-\d.e+]+),([-\d.e+]+),"  # angles
        r"'([^']*)',"                     # is_link_child
        r"'([^']*)'\)"                    # last_modified
    )

    # Regex for link value tuples: (id, parent_guid, child_guid, last_modified)
    link_pattern = re.compile(
        r"\((\d+),(\d+),(\d+),'([^']*)'\)"
    )

    t0 = time.time()
    instance_lines = 0
    link_lines = 0

    with open(sql_path, 'r', encoding='utf-8') as f:
        for line in f:
            if 'INSERT INTO `landblock_instance_link`' in line:
                link_lines += 1
                for m in link_pattern.finditer(line):
                    links.append(InstanceLink(
                        link_id=int(m.group(1)),
                        parent_guid=int(m.group(2)),
                        child_guid=int(m.group(3)),
                        last_modified=m.group(4),
                    ))
            elif 'INSERT INTO `landblock_instance`' in line:
                instance_lines += 1
                for m in value_pattern.finditer(line):
                    is_link = m.group(11) != '\\0'
                    inst = Instance(
                        guid=int(m.group(1)),
                        wcid=int(m.group(2)),
                        obj_cell_id=int(m.group(3)),
                        origin_x=float(m.group(4)),
                        origin_y=float(m.group(5)),
                        origin_z=float(m.group(6)),
                        angles_w=float(m.group(7)),
                        angles_x=float(m.group(8)),
                        angles_y=float(m.group(9)),
                        angles_z=float(m.group(10)),
                        is_link_child=is_link,
                        last_modified=m.group(12),
                    )

                    if inst.is_interior:
                        interior_instances += 1
                        instances_by_lb[(-1, -1)].append(inst)
                    else:
                        instances_by_lb[inst.lb_key].append(inst)

                    total_instances += 1

    elapsed = time.time() - t0
    outdoor_instances = total_instances - interior_instances
    print(f"    Parsed {total_instances:,} instances + {len(links):,} links in {elapsed:.1f}s")
    print(f"    Outdoor: {outdoor_instances:,} across {len(instances_by_lb)-1} landblocks")
    print(f"    Interior (dungeon/building): {interior_instances:,}")
    print(f"    SQL lines: {instance_lines} instance, {link_lines} link")

    return instances_by_lb, links


# ─── Step 2: Detect Clusters ────────────────────────────────────────────────

def find_clusters(instances_by_lb: Dict[Tuple[int, int], List[Instance]]) -> List[Cluster]:
    """
    Find connected components of populated landblocks.
    Two LBs are connected if they are adjacent (including diagonals).
    """
    print("  Detecting spatial clusters...")

    # Get all outdoor landblock keys
    outdoor_lbs = {k for k in instances_by_lb.keys() if k != (-1, -1)}

    visited = set()
    clusters = []
    cluster_id = 0

    for lb in outdoor_lbs:
        if lb in visited:
            continue

        # BFS to find connected component
        cluster = Cluster(cluster_id=cluster_id)
        queue = [lb]
        while queue:
            current = queue.pop(0)
            if current in visited:
                continue
            if current not in outdoor_lbs:
                continue
            visited.add(current)
            cluster.landblocks.add(current)
            cluster.instances.extend(instances_by_lb[current])

            # Check 8 neighbors (including diagonals)
            cx, cy = current
            for dx in [-1, 0, 1]:
                for dy in [-1, 0, 1]:
                    if dx == 0 and dy == 0:
                        continue
                    neighbor = (cx + dx, cy + dy)
                    if neighbor in outdoor_lbs and neighbor not in visited:
                        queue.append(neighbor)

        cluster.compute_footprint()
        clusters.append(cluster)
        cluster_id += 1

    clusters.sort(key=lambda c: c.instance_count, reverse=True)

    print(f"    Found {len(clusters)} clusters")
    print(f"    Largest: {clusters[0].instance_count} instances across {clusters[0].lb_count} LBs")
    print(f"    Smallest: {clusters[-1].instance_count} instances across {clusters[-1].lb_count} LBs" if clusters else "")

    return clusters


# ─── Step 3: Classify Clusters ──────────────────────────────────────────────

def classify_clusters(clusters: List[Cluster], wcid_types: Dict[int, int]) -> None:
    """
    Classify each cluster based on the types of weenies it contains.

    Classification rules:
      - TOWN: has vendors (type 12), doors (type 19), AND lifestones or signs
      - DUNGEON_ENTRANCE: has portals (type 7), few other objects
      - HUNTING: has mostly creatures (type 10) and generators (type 1)
      - SCENERY: sparse, mostly generic objects
    """
    print("  Classifying clusters...")

    VENDOR = 12
    DOOR = 19
    CREATURE = 10
    PORTAL = 7
    GENERIC = 1
    LIFESTONE = 25
    CHEST = 20

    for cluster in clusters:
        type_counts = defaultdict(int)
        for inst in cluster.instances:
            wtype = wcid_types.get(inst.wcid, -1)
            type_counts[wtype] += 1

        vendors = type_counts.get(VENDOR, 0)
        doors = type_counts.get(DOOR, 0)
        creatures = type_counts.get(CREATURE, 0)
        portals = type_counts.get(PORTAL, 0)
        generics = type_counts.get(GENERIC, 0)
        lifestones = type_counts.get(LIFESTONE, 0)
        chests = type_counts.get(CHEST, 0)
        total = cluster.instance_count

        # Classification logic
        if vendors >= 2 and doors >= 1:
            cluster.classification = "town"
        elif vendors >= 1 or (doors >= 3 and lifestones >= 1):
            cluster.classification = "settlement"
        elif portals >= 1 and total < 10:
            cluster.classification = "dungeon_entrance"
        elif creatures >= total * 0.5:
            cluster.classification = "hunting"
        elif total <= 3:
            cluster.classification = "scenery"
        else:
            cluster.classification = "mixed"

    # Summary
    class_counts = defaultdict(int)
    class_instances = defaultdict(int)
    for c in clusters:
        class_counts[c.classification] += 1
        class_instances[c.classification] += c.instance_count

    print(f"    Classification results:")
    for cls in sorted(class_counts.keys()):
        print(f"      {cls:20s}: {class_counts[cls]:>4} clusters, {class_instances[cls]:>6} instances")


# ─── Step 4: Assign Difficulty Tiers ────────────────────────────────────────

def load_difficulty_gradient(path: str) -> List[List[int]]:
    """Load the 255x255 difficulty tier grid."""
    with open(path) as f:
        data = json.load(f)
    return data['grid']


def assign_tiers(clusters: List[Cluster], gradient: List[List[int]]) -> None:
    """Assign each cluster a difficulty tier based on the gradient at its center."""
    # NOTE: The difficulty gradient is for the VANQUISH world.
    # We use the RETAIL landblock positions to determine what tier the content
    # was designed for, based on creature levels from the ACE DB.
    # For now, we'll assign tiers based on center position.
    for cluster in clusters:
        cx, cy = cluster.center_lb
        # Clamp to grid bounds
        gx = max(0, min(254, int(cx)))
        gy = max(0, min(254, int(cy)))
        cluster.difficulty_tier = gradient[gy][gx]


# ─── Step 5: Build Vanquish Terrain Map ─────────────────────────────────────

def build_vanquish_availability(gradient: List[List[int]]) -> Dict[int, List[Tuple[int, int]]]:
    """
    Build a map of available (non-ocean) landblocks in the Vanquish world,
    grouped by difficulty tier.

    Returns: {tier: [(lbX, lbY), ...]}
    """
    availability = defaultdict(list)
    for y in range(255):
        for x in range(255):
            tier = gradient[y][x]
            if tier >= 0:  # -1 or specific value = ocean
                availability[tier].append((x, y))

    print(f"  Vanquish available landblocks by tier:")
    for tier in sorted(availability.keys()):
        print(f"    Tier {tier}: {len(availability[tier]):>5} landblocks")

    return availability


# ─── Step 6: Place Clusters ─────────────────────────────────────────────────

def place_clusters(
    clusters: List[Cluster],
    gradient: List[List[int]],
    availability: Dict[int, List[Tuple[int, int]]]
) -> None:
    """
    Find a valid placement for each cluster in the Vanquish world.

    Strategy:
      - Towns get priority placement on flat areas at appropriate tiers
      - Clusters preserve their internal shape (footprint)
      - Placed clusters are removed from availability to prevent overlap
    """
    print("  Placing clusters in Vanquish world...")

    # Track which landblocks are taken
    occupied = set()

    # Sort: towns first, then by size descending
    priority_order = {"town": 0, "settlement": 1, "mixed": 2,
                      "hunting": 3, "dungeon_entrance": 4, "scenery": 5, "unknown": 6}
    sorted_clusters = sorted(clusters, key=lambda c: (priority_order.get(c.classification, 9), -c.instance_count))

    placed = 0
    failed = 0

    for cluster in sorted_clusters:
        # Determine target tier
        target_tier = cluster.difficulty_tier
        if target_tier < 0:
            target_tier = 3  # default to "Hard" for untiered content

        # Get cluster footprint as offsets from min corner
        if not cluster.landblocks:
            continue
        lbs = sorted(cluster.landblocks)
        min_x = min(lb[0] for lb in lbs)
        min_y = min(lb[1] for lb in lbs)
        shape = set((lb[0] - min_x, lb[1] - min_y) for lb in lbs)

        # Search for a valid placement
        # Try the exact tier first, then expand ±1 tier
        placed_ok = False
        for tier_delta in [0, -1, 1, -2, 2, -3, 3]:
            search_tier = target_tier + tier_delta
            if search_tier < 0 or search_tier > 5:
                continue

            candidates = availability.get(search_tier, [])
            for anchor_x, anchor_y in candidates:
                # Check if the full footprint fits
                target_lbs = set()
                fits = True
                for dx, dy in shape:
                    tx, ty = anchor_x + dx, anchor_y + dy
                    if tx < 0 or tx >= 255 or ty < 0 or ty >= 255:
                        fits = False
                        break
                    if (tx, ty) in occupied:
                        fits = False
                        break
                    if gradient[ty][tx] < 0:  # ocean
                        fits = False
                        break
                    target_lbs.add((tx, ty))

                if fits:
                    # Place the cluster here
                    cluster.target_offset_x = anchor_x - min_x
                    cluster.target_offset_y = anchor_y - min_y
                    occupied.update(target_lbs)
                    placed_ok = True
                    break

            if placed_ok:
                break

        if placed_ok:
            placed += 1
        else:
            failed += 1
            # Fallback: place at original position if it's within bounds
            cluster.target_offset_x = 0
            cluster.target_offset_y = 0

    print(f"    Placed: {placed}, Failed to place: {failed}")


# ─── Step 7: Generate Remapped SQL ──────────────────────────────────────────

def remap_cell_id(cell_id: int, offset_x: int, offset_y: int) -> int:
    """Remap an obj_Cell_Id by shifting the landblock coordinates."""
    lbX = (cell_id >> 24) & 0xFF
    lbY = (cell_id >> 16) & 0xFF
    cell_idx = cell_id & 0xFFFF

    new_lbX = lbX + offset_x
    new_lbY = lbY + offset_y

    # Clamp to valid range
    new_lbX = max(1, min(254, new_lbX))
    new_lbY = max(1, min(254, new_lbY))

    return (new_lbX << 24) | (new_lbY << 16) | cell_idx


def generate_remapped_sql(
    clusters: List[Cluster],
    interior_instances: List[Instance],
    links: List['InstanceLink'],
    output_path: str,
    dry_run: bool = False
) -> None:
    """Generate SQL INSERT statements with remapped positions."""
    print(f"  Generating remapped SQL...")

    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    total_outdoor = sum(c.instance_count for c in clusters)
    total_interior = len(interior_instances)

    if dry_run:
        print(f"    [DRY RUN] Would write {total_outdoor + total_interior:,} instances + {len(links):,} links")
        return

    def write_instance_batch(f, batch):
        f.write(
            "INSERT INTO `landblock_instance` "
            "(`guid`, `weenie_Class_Id`, `obj_Cell_Id`, "
            "`origin_X`, `origin_Y`, `origin_Z`, "
            "`angles_W`, `angles_X`, `angles_Y`, `angles_Z`, "
            "`is_Link_Child`, `last_Modified`) VALUES\n"
        )
        f.write(",\n".join(batch))
        f.write(";\n\n")

    def format_instance(inst, cell_id):
        is_link = 1 if inst.is_link_child else 0
        return (
            f"({inst.guid},{inst.wcid},{cell_id},"
            f"{inst.origin_x},{inst.origin_y},{inst.origin_z},"
            f"{inst.angles_w},{inst.angles_x},{inst.angles_y},{inst.angles_z},"
            f"{is_link},'{inst.last_modified}')"
        )

    batch_size = 500

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write("-- Vanquish World Population - Cluster Shuffle Method\n")
        f.write(f"-- Generated: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
        f.write(f"-- Outdoor instances: {total_outdoor:,}\n")
        f.write(f"-- Interior instances: {total_interior:,}\n")
        f.write(f"-- Links: {len(links):,}\n")
        f.write(f"-- Total: {total_outdoor + total_interior:,}\n\n")

        # Write ALL outdoor instances (remapped)
        f.write("-- === OUTDOOR INSTANCES (remapped) ===\n\n")
        batch = []
        written = 0

        for cluster in clusters:
            ox = cluster.target_offset_x
            oy = cluster.target_offset_y

            for inst in cluster.instances:
                new_cell = remap_cell_id(inst.obj_cell_id, ox, oy)
                batch.append(format_instance(inst, new_cell))
                written += 1

                if len(batch) >= batch_size:
                    write_instance_batch(f, batch)
                    batch = []

        if batch:
            write_instance_batch(f, batch)

        print(f"    Outdoor instances written: {written:,}")

        # Write interior instances (NOT remapped — dungeons stay in place)
        f.write("-- === INTERIOR INSTANCES (preserved in place) ===\n\n")
        batch = []
        for inst in interior_instances:
            batch.append(format_instance(inst, inst.obj_cell_id))

            if len(batch) >= batch_size:
                write_instance_batch(f, batch)
                batch = []

        if batch:
            write_instance_batch(f, batch)

        print(f"    Interior instances written: {len(interior_instances):,}")

        # Write ALL links (guid references don't change)
        f.write("-- === INSTANCE LINKS ===\n\n")
        batch = []
        for link in links:
            batch.append(f"({link.link_id},{link.parent_guid},{link.child_guid},'{link.last_modified}')")

            if len(batch) >= batch_size:
                f.write(
                    "INSERT INTO `landblock_instance_link` "
                    "(`id`, `parent_GUID`, `child_GUID`, `last_Modified`) VALUES\n"
                )
                f.write(",\n".join(batch))
                f.write(";\n\n")
                batch = []

        if batch:
            f.write(
                "INSERT INTO `landblock_instance_link` "
                "(`id`, `parent_GUID`, `child_GUID`, `last_Modified`) VALUES\n"
            )
            f.write(",\n".join(batch))
            f.write(";\n\n")

        print(f"    Links written: {len(links):,}")

    size_mb = os.path.getsize(output_path) / 1024 / 1024
    print(f"    Written to {output_path} ({size_mb:.1f} MB)")


# ─── Step 5b: Portal Destination Remapping ──────────────────────────────────

def build_lb_remap(clusters: List[Cluster]) -> Dict[Tuple[int, int], Tuple[int, int]]:
    """Build retail LB -> vanquish LB mapping from cluster placement offsets."""
    lb_remap = {}
    for cluster in clusters:
        ox = cluster.target_offset_x
        oy = cluster.target_offset_y
        for lb in cluster.landblocks:
            lb_remap[lb] = (lb[0] + ox, lb[1] + oy)
    return lb_remap


def generate_portal_remap_sql(
    lb_remap: Dict[Tuple[int, int], Tuple[int, int]],
    output_path: str,
    dry_run: bool = False
) -> None:
    """Generate SQL UPDATEs to remap outdoor portal destinations."""
    import subprocess
    print(f"  Generating portal remap SQL...")
    if dry_run:
        print(f"    [DRY RUN] Skipped")
        return

    result = subprocess.run(
        [MYSQL, "-u", "root", "-pbaltic", "ace_world",
         "-e", "SELECT wpp.object_Id, wpp.position_Type, wpp.obj_Cell_Id "
               "FROM weenie_properties_position wpp "
               "JOIN weenie w ON wpp.object_Id = w.class_Id "
               "WHERE w.`type` = 7;", "--batch"],
        capture_output=True, text=True, timeout=30)

    if result.returncode != 0:
        print(f"    ERROR: {result.stderr[:300]}")
        return

    lines = result.stdout.strip().split("\n")
    if len(lines) < 2:
        print("    No portal positions found")
        return

    headers = lines[0].split("\t")
    updates = []
    skipped_interior = 0
    skipped_no_remap = 0

    for line in lines[1:]:
        row = dict(zip(headers, line.split("\t")))
        cell_id = int(row['obj_Cell_Id'])
        cell_idx = cell_id & 0xFFFF
        if cell_idx >= 0x100:
            skipped_interior += 1
            continue
        lbX = (cell_id >> 24) & 0xFF
        lbY = (cell_id >> 16) & 0xFF
        if (lbX, lbY) not in lb_remap:
            skipped_no_remap += 1
            continue
        vx, vy = lb_remap[(lbX, lbY)]
        new_cell = (vx << 24) | (vy << 16) | cell_idx
        if new_cell != cell_id:
            updates.append({'oid': row['object_Id'], 'pt': row['position_Type'],
                            'old': cell_id, 'new': new_cell})

    print(f"    Portal positions: {len(lines)-1}, Interior: {skipped_interior}, "
          f"No remap: {skipped_no_remap}, Remapped: {len(updates)}")

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(f"-- Portal Destination Remap ({len(updates)} updates)\n")
        f.write(f"-- Generated: {time.strftime('%Y-%m-%d %H:%M:%S')}\n\n")
        for u in updates:
            f.write(f"UPDATE `weenie_properties_position` SET `obj_Cell_Id` = {u['new']} "
                    f"WHERE `object_Id` = {u['oid']} AND `position_Type` = {u['pt']} "
                    f"AND `obj_Cell_Id` = {u['old']};\n")
    print(f"    Written to {output_path} ({os.path.getsize(output_path)/1024:.1f} KB)")


# ─── Step 8: Generate Cluster Report ────────────────────────────────────────

def save_cluster_report(clusters: List[Cluster], output_path: str, wcid_types: Dict[int, int]) -> None:
    """Save a JSON report of all clusters for inspection."""
    print(f"  Saving cluster report...")

    report = {
        "total_clusters": len(clusters),
        "total_instances": sum(c.instance_count for c in clusters),
        "classification_summary": {},
        "clusters": []
    }

    class_summary = defaultdict(lambda: {"count": 0, "instances": 0, "landblocks": 0})
    for c in clusters:
        cs = class_summary[c.classification]
        cs["count"] += 1
        cs["instances"] += c.instance_count
        cs["landblocks"] += c.lb_count

    report["classification_summary"] = dict(class_summary)

    # Top 50 clusters by size
    for c in clusters[:50]:
        # Count weenie types
        type_counts = defaultdict(int)
        for inst in c.instances:
            wtype = wcid_types.get(inst.wcid, -1)
            type_counts[wtype] += 1

        TYPE_NAMES = {1: "Generic", 7: "Portal", 10: "Creature", 12: "Vendor",
                      19: "Door", 20: "Chest", 25: "LifeStone", 26: "HotSpot"}

        report["clusters"].append({
            "id": c.cluster_id,
            "classification": c.classification,
            "landblock_count": c.lb_count,
            "instance_count": c.instance_count,
            "footprint": f"{c.footprint_w}x{c.footprint_h}",
            "center_lb": list(c.center_lb),
            "difficulty_tier": c.difficulty_tier,
            "target_offset": [c.target_offset_x, c.target_offset_y],
            "type_breakdown": {TYPE_NAMES.get(t, f"Type{t}"): n for t, n in sorted(type_counts.items())},
        })

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'w') as f:
        json.dump(report, f, indent=2)
    print(f"    Saved to {output_path}")


# ─── Step 9: Load Weenie Types from ACE DB ──────────────────────────────────

def load_wcid_types() -> Dict[int, int]:
    """Query the ACE database for weenie type mappings."""
    import subprocess
    print(f"  Loading weenie types from ACE database...")

    result = subprocess.run(
        [MYSQL, "-u", "root", "-pbaltic", "ace_world",
         "-e", "SELECT class_Id, `type` FROM weenie;", "--batch"],
        capture_output=True, text=True, timeout=30
    )

    wcid_types = {}
    if result.returncode == 0:
        lines = result.stdout.strip().split("\n")
        for line in lines[1:]:  # skip header
            parts = line.split("\t")
            if len(parts) == 2:
                wcid_types[int(parts[0])] = int(parts[1])

    print(f"    Loaded {len(wcid_types)} wcid->type mappings")
    return wcid_types


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    dry_run = "--dry-run" in sys.argv

    print("=" * 70)
    print("  Cluster Shuffle World Population")
    print("  DB-First approach for Vanquish World")
    print("=" * 70)
    print()

    # Step 0: Load weenie types from ACE DB
    wcid_types = load_wcid_types()
    print()

    # Step 1: Parse the retail SQL
    print("[Step 1] Parsing retail SQL...")
    instances_by_lb, links = parse_retail_sql(RETAIL_SQL)
    print()

    # Separate interior instances
    interior_instances = instances_by_lb.pop((-1, -1), [])

    # Step 2: Detect clusters
    print("[Step 2] Detecting clusters...")
    clusters = find_clusters(instances_by_lb)
    print()

    # Step 3: Classify clusters
    print("[Step 3] Classifying clusters...")
    classify_clusters(clusters, wcid_types)
    print()

    # Step 4: Load difficulty gradient and assign tiers
    print("[Step 4] Loading difficulty gradient...")
    gradient = load_difficulty_gradient(DIFFICULTY_GRADIENT)
    vanquish_avail = build_vanquish_availability(gradient)
    assign_tiers(clusters, gradient)
    print()

    # Step 5: Place clusters in Vanquish
    print("[Step 5] Placing clusters...")
    place_clusters(clusters, gradient, vanquish_avail)
    print()

    # Step 5b: Build portal destination remap
    print("[Step 5b] Building portal destination remap table...")
    lb_remap = build_lb_remap(clusters)
    print(f"    Landblock remap entries: {len(lb_remap)}")
    print()

    # Step 6: Generate output
    print("[Step 6] Generating output...")
    save_cluster_report(clusters, CLUSTER_JSON, wcid_types)
    generate_remapped_sql(clusters, interior_instances, links, OUTPUT_SQL, dry_run=dry_run)

    # Step 6b: Portal destination remap
    portal_sql_path = os.path.join(OUTPUT_DIR, "portal_remap.sql")
    generate_portal_remap_sql(lb_remap, portal_sql_path, dry_run=dry_run)
    print()

    # Summary
    print("=" * 70)
    print("  Summary")
    print("=" * 70)
    outdoor = sum(c.instance_count for c in clusters)
    interior = len(interior_instances)
    print(f"  Total outdoor instances: {outdoor:,}")
    print(f"  Total interior instances: {interior:,}")
    print(f"  Total links: {len(links):,}")
    print(f"  Total clusters: {len(clusters)}")
    print(f"  LB remap entries: {len(lb_remap)}")
    print(f"  Output: {OUTPUT_SQL}")
    print(f"  Portal remap: {portal_sql_path}")
    print()
    if dry_run:
        print("  *** DRY RUN — no SQL file written ***")
    else:
        print("  To import into ACE (run in order):")
        print(f'    1. "{MYSQL}" -u root -pbaltic ace_world < "{OUTPUT_SQL}"')
        print(f'    2. "{MYSQL}" -u root -pbaltic ace_world < "{portal_sql_path}"')
    print()
    print("Done!")


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""
extract_wiki_features.py — Phase 1: Extract geographic features from wiki + Locations.txt

Parses the AC fandom wiki XML dump and Locations.txt to build a catalog of
named geographic features with their landblock grid coordinates.

Outputs: data/wiki_features.json

Usage:
    python scripts/extract_wiki_features.py
"""

import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
WIKI_XML = PROJECT_ROOT / "AcWikisXML" / "asheron.fandom.com xml dumps-20260306T183940Z-3-001" / "asheron.fandom.com xml dumps" / "2025-12-06-asheron_backup2_pages_full.xml"
LOCATIONS_TXT = PROJECT_ROOT / "WorldBuilder" / "Data" / "Locations.txt"
OUTPUT = PROJECT_ROOT / "pipeline_data" / "data" / "wiki_features.json"

MAP_SIZE = 255

# ─── Coordinate conversion ───────────────────────────────────────────

def ns_ew_to_landblock(ns_str, ew_str):
    """
    Convert wiki coordinates like '42.6N, 57.4E' to landblock grid (lbX, lbY).
    
    AC coordinate system:
    - 0,0 is roughly map center
    - N/S is latitude (Y axis), E/W is longitude (X axis)
    - Full map spans roughly 102S to 102N latitude, 102W to 102E longitude
    - Map is 255x255 landblocks
    
    Formula (from AC community):
    - lbX = int((ew_degrees + 101.95) / 0.8)  # EW → X
    - lbY = int((ns_degrees + 101.95) / 0.8)  # NS → Y (N is positive)
    
    But the actual cell ID is the definitive source. This is a fallback.
    """
    try:
        ns_val = float(ns_str.replace('N', '').replace('S', '').strip())
        if 'S' in ns_str:
            ns_val = -ns_val
            
        ew_val = float(ew_str.replace('E', '').replace('W', '').strip())
        if 'W' in ew_str:
            ew_val = -ew_val
        
        # AC coordinate to landblock conversion
        # Each landblock is 192m or roughly 0.8 degrees
        lbX = int((ew_val + 101.95) / 0.8)
        lbY = int((ns_val + 101.95) / 0.8)
        
        # Clamp to valid range
        lbX = max(0, min(254, lbX))
        lbY = max(0, min(254, lbY))
        
        return lbX, lbY
    except (ValueError, IndexError):
        return None


def cell_id_to_landblock(cell_hex):
    """
    Convert AC cell ID hex string to landblock grid position.
    Cell ID format: 0xAABBCCDD where AA=lbX (high byte), BB=lbY
    
    Example: 0x3E310004 → lbX=0x3E=62, lbY=0x31=49
    """
    try:
        cell_id = int(cell_hex, 16)
        lbX = (cell_id >> 24) & 0xFF
        lbY = (cell_id >> 16) & 0xFF
        
        # Only return if it's an outdoor cell (low word < 0x100 typically)
        # Actually, landblock cells have subcell < 0xFFFF
        return lbX, lbY
    except (ValueError, TypeError):
        return None


# ─── Parse Locations.txt ──────────────────────────────────────────────

def parse_locations_txt():
    """
    Parse Locations.txt format:
    Name | Type | 0xCELLID [x y z] qx qy qz qw
    
    Returns dict: name -> {type, lbX, lbY, cell_id}
    """
    locations = {}
    
    with open(LOCATIONS_TXT, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            
            parts = line.split('|')
            if len(parts) < 3:
                continue
            
            name = parts[0].strip()
            loc_type = parts[1].strip()
            rest = parts[2].strip()
            
            # Extract cell ID
            cell_match = re.match(r'(0x[0-9A-Fa-f]+)', rest)
            if not cell_match:
                continue
                
            cell_hex = cell_match.group(1)
            result = cell_id_to_landblock(cell_hex)
            if result is None:
                continue
                
            lbX, lbY = result
            
            if name not in locations:
                locations[name] = {
                    'type': loc_type,
                    'lbX': lbX,
                    'lbY': lbY,
                    'cell_id': cell_hex,
                }
    
    return locations


# ─── Parse wiki coordinate patterns ──────────────────────────────────

# Pattern: "42.6N, 57.4E" or "42.6S, 57.4W" or "42.6N 57.4E"
COORD_PATTERN = re.compile(
    r'(\d+\.?\d*)\s*([NS])\s*[,\s]\s*(\d+\.?\d*)\s*([EW])',
    re.IGNORECASE
)

def extract_coords_from_text(text):
    """Find all NS/EW coordinate pairs in wiki text."""
    coords = []
    for m in COORD_PATTERN.finditer(text):
        ns_str = m.group(1) + m.group(2).upper()
        ew_str = m.group(3) + m.group(4).upper()
        result = ns_ew_to_landblock(ns_str, ew_str)
        if result:
            coords.append(result)
    return coords


# ─── Parse wiki XML ──────────────────────────────────────────────────

def parse_wiki_xml():
    """
    Parse the fandom wiki XML dump for geographic features.
    
    Categories of interest:
    - Geographic Region: named landmasses, mountain ranges, plains
    - Point of Interest: named surface locations
    - Minor POI: smaller named locations
    - Town: settlements (useful as landmarks)
    """
    print(f"Parsing wiki XML: {WIKI_XML.name} ({WIKI_XML.stat().st_size / 1e9:.1f} GB)...")
    
    geographic_regions = []
    pois = []
    towns = []
    
    count = 0
    for event, elem in ET.iterparse(str(WIKI_XML), events=('end',)):
        tag = elem.tag.split('}')[-1] if '}' in elem.tag else elem.tag
        
        if tag == 'page':
            ns_prefix = elem.tag.replace('page', '') if '}' in elem.tag else ''
            title_el = elem.find(f'{ns_prefix}title')
            text_el = elem.find(f'.//{ns_prefix}text')
            
            if title_el is not None and text_el is not None and text_el.text:
                title = title_el.text
                text = text_el.text
                
                # Skip namespace pages (Category:, File:, etc.)
                if ':' in title and not title.startswith(('Category:', 'File:')):
                    pass  # Allow through
                elif ':' in title:
                    elem.clear()
                    count += 1
                    continue
                
                # Extract coordinates from text
                coords = extract_coords_from_text(text)
                
                # Also check for coordinates in the title itself
                # Many POIs are titled like "42.6N, 57.4E - Some Location"
                title_coords = extract_coords_from_text(title)
                if title_coords:
                    coords = title_coords + coords
                
                # Categorize
                if 'Category:Geographic Region' in text:
                    # Extract description (first paragraph before categories)
                    desc = text.split('[[Category:')[0].strip()
                    desc = re.sub(r'\[\[([^\]|]+\|)?([^\]]+)\]\]', r'\2', desc)  # Remove wiki links
                    desc = re.sub(r"'{2,3}", '', desc)  # Remove bold/italic
                    desc = desc.strip()
                    
                    geographic_regions.append({
                        'name': title,
                        'description': desc[:500] if desc else '',
                        'wiki_coords': coords,
                    })
                    
                elif 'Category:Point of Interest' in text or 'Category:Minor POI' in text:
                    poi_type = 'minor_poi' if 'Minor POI' in text else 'poi'
                    pois.append({
                        'name': title,
                        'type': poi_type,
                        'wiki_coords': coords,
                    })
                    
                elif 'Category:Town' in text:
                    towns.append({
                        'name': title,
                        'wiki_coords': coords,
                    })
            
            elem.clear()
            count += 1
            
            if count % 20000 == 0:
                print(f"  ...parsed {count} pages")
    
    print(f"  Total pages parsed: {count}")
    print(f"  Geographic Regions: {len(geographic_regions)}")
    print(f"  Points of Interest: {len(pois)}")
    print(f"  Towns: {len(towns)}")
    
    return geographic_regions, pois, towns


# ─── Cross-reference with Locations.txt ──────────────────────────────

def cross_reference(geographic_regions, pois, towns, locations):
    """
    Cross-reference wiki features with Locations.txt to get accurate landblock coords.
    Locations.txt has definitive cell IDs; wiki coordinates are approximate.
    """
    print("\nCross-referencing with Locations.txt...")
    
    # Build lookup: lowercase name -> location data
    loc_lookup = {}
    for name, data in locations.items():
        loc_lookup[name.lower()] = data
    
    matched = 0
    
    # Cross-ref geographic regions
    for region in geographic_regions:
        name_lower = region['name'].lower()
        if name_lower in loc_lookup:
            loc = loc_lookup[name_lower]
            region['location_match'] = {
                'lbX': loc['lbX'],
                'lbY': loc['lbY'],
                'cell_id': loc['cell_id'],
                'type': loc['type'],
            }
            matched += 1
        
        # Also find POIs from Locations.txt that reference this region
        region_pois = []
        for loc_name, loc_data in locations.items():
            if region['name'].lower() in loc_name.lower():
                region_pois.append({
                    'name': loc_name,
                    'lbX': loc_data['lbX'],
                    'lbY': loc_data['lbY'],
                })
        if region_pois:
            region['related_locations'] = region_pois
    
    # Cross-ref POIs
    for poi in pois:
        # Try exact match
        name_lower = poi['name'].lower()
        if name_lower in loc_lookup:
            loc = loc_lookup[name_lower]
            poi['location_match'] = {
                'lbX': loc['lbX'],
                'lbY': loc['lbY'],
                'cell_id': loc['cell_id'],
            }
            matched += 1
        # Try matching coordinate-titled POIs like "42.6N, 57.4E - Something"
        elif poi['wiki_coords']:
            poi['derived_coords'] = [{'lbX': x, 'lbY': y} for x, y in poi['wiki_coords']]
    
    # Cross-ref towns
    for town in towns:
        name_lower = town['name'].lower()
        if name_lower in loc_lookup:
            loc = loc_lookup[name_lower]
            town['location_match'] = {
                'lbX': loc['lbX'],
                'lbY': loc['lbY'],
                'cell_id': loc['cell_id'],
            }
            matched += 1
    
    print(f"  Matched {matched} features to Locations.txt")
    
    return geographic_regions, pois, towns


# ─── Build surface POI index ─────────────────────────────────────────

def build_surface_poi_index(locations):
    """
    Build a grid of surface POIs from Locations.txt.
    Filter to outdoor/surface locations (POI type, town, etc.)
    
    Returns: dict of (lbX, lbY) -> list of POI names at that block
    """
    surface_types = {'Town', 'POI', 'Settlement', 'Village', 'Outpost', 'Lifestone'}
    
    poi_grid = {}
    surface_count = 0
    dungeon_count = 0
    
    for name, data in locations.items():
        loc_type = data['type']
        lbX = data['lbX']
        lbY = data['lbY']
        
        # Dungeons have cell IDs in certain ranges but let's just
        # track surface types explicitly + any with "POI" in name
        if loc_type in surface_types or loc_type not in {'Dungeon'}:
            key = (lbX, lbY)
            if key not in poi_grid:
                poi_grid[key] = []
            poi_grid[key].append({'name': name, 'type': loc_type})
            surface_count += 1
        else:
            dungeon_count += 1
    
    print(f"\nSurface POI index: {surface_count} surface entries, {dungeon_count} dungeon entries skipped")
    print(f"  Unique landblocks with surface POIs: {len(poi_grid)}")
    
    return poi_grid


# ─── Main ─────────────────────────────────────────────────────────────

def main():
    print("=" * 70)
    print("  PHASE 1: Extract Wiki Geographic Features")
    print("=" * 70)
    
    # Parse Locations.txt
    print(f"\nParsing Locations.txt...")
    locations = parse_locations_txt()
    print(f"  {len(locations)} unique named locations")
    
    # Count by type
    type_counts = {}
    for data in locations.values():
        t = data['type']
        type_counts[t] = type_counts.get(t, 0) + 1
    for t, c in sorted(type_counts.items(), key=lambda x: -x[1]):
        print(f"    {t}: {c}")
    
    # Parse wiki XML
    geographic_regions, pois, towns = parse_wiki_xml()
    
    # Cross-reference
    geographic_regions, pois, towns = cross_reference(
        geographic_regions, pois, towns, locations
    )
    
    # Build surface POI index
    poi_grid = build_surface_poi_index(locations)
    
    # Compile output
    output = {
        'geographic_regions': geographic_regions,
        'points_of_interest': pois,
        'towns': towns,
        'surface_poi_grid': {
            f"{k[0]},{k[1]}": v for k, v in poi_grid.items()
        },
        'stats': {
            'total_locations_txt': len(locations),
            'geographic_regions': len(geographic_regions),
            'pois': len(pois),
            'towns': len(towns),
            'surface_poi_blocks': len(poi_grid),
        }
    }
    
    # Save
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    
    print(f"\n{'=' * 70}")
    print(f"  Output: {OUTPUT}")
    print(f"  Geographic Regions: {len(geographic_regions)}")
    print(f"  POIs: {len(pois)}")
    print(f"  Towns: {len(towns)}")
    print(f"  Surface POI blocks: {len(poi_grid)}")
    print(f"{'=' * 70}")
    
    # Print some sample features with coords
    print("\n  Sample Geographic Regions:")
    for r in geographic_regions[:10]:
        coords_str = ""
        if r.get('location_match'):
            lm = r['location_match']
            coords_str = f" -> ({lm['lbX']}, {lm['lbY']})"
        elif r.get('wiki_coords'):
            coords_str = f" -> wiki coords: {r['wiki_coords'][:3]}"
        elif r.get('related_locations'):
            rl = r['related_locations']
            coords_str = f" -> {len(rl)} related locations"
        print(f"    {r['name']}{coords_str}")
    
    print("\n  Sample Towns:")
    for t in towns[:10]:
        if t.get('location_match'):
            lm = t['location_match']
            print(f"    {t['name']} -> ({lm['lbX']}, {lm['lbY']})")
    
    print("\n  Sample POIs with coords:")
    coord_pois = [p for p in pois if p.get('location_match') or p.get('wiki_coords') or p.get('derived_coords')]
    for p in coord_pois[:10]:
        if p.get('location_match'):
            lm = p['location_match']
            print(f"    {p['name']} -> ({lm['lbX']}, {lm['lbY']})")
        elif p.get('derived_coords'):
            dc = p['derived_coords'][0]
            print(f"    {p['name']} -> ({dc['lbX']}, {dc['lbY']}) [from wiki text]")


if __name__ == "__main__":
    main()

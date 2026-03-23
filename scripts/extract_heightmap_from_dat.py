#!/usr/bin/env python3
"""
extract_heightmap_from_dat.py — Extract terrain heights from client_cell_1.dat
===============================================================================

Reads the Asheron's Call client_cell_1.dat file and extracts the 9×9 height grid
for every outdoor landblock (cell IDs 0xXXYY0001–0xXXYY0009).

The cell_1.dat file format:
  - DAT file header (0x300 bytes)
  - File entries in a BTree structure
  - Each landblock terrain entry (ID = 0xXXYY0001 where XX=lbX, YY=lbY):
      - 4 bytes: file ID
      - 4 bytes: flags (has_objects etc.)
      - Array of terrain info structs
      - 9×9 height values (byte[81]) — terrain heights at grid vertices
      - 9×9 terrain type data

Output: vanquish_heights.json (compatible with placement pipeline)

Usage:
    python scripts/extract_heightmap_from_dat.py --dat path/to/client_cell_1.dat
"""

import argparse
import json
import os
import struct
import sys

# ─── DAT File Constants ──────────────────────────────────────────────────────

DAT_HEADER_SIZE = 0x300
BTREE_NODE_SIZE = 0x3E8   # Standard BTree node in cell.dat

# Landblock terrain cell IDs: 0xXXYY0001
# XX = landblock X, YY = landblock Y

def read_dat_header(f):
    """Read DAT file header and return key parameters."""
    f.seek(0)
    header = f.read(DAT_HEADER_SIZE)
    
    # Key fields from DAT header
    file_type = struct.unpack_from('<I', header, 0x140)[0]
    block_size = struct.unpack_from('<I', header, 0x144)[0]
    file_size = struct.unpack_from('<I', header, 0x148)[0]
    data_set = struct.unpack_from('<I', header, 0x150)[0]
    data_subset = struct.unpack_from('<I', header, 0x154)[0]
    free_head = struct.unpack_from('<I', header, 0x158)[0]
    free_tail = struct.unpack_from('<I', header, 0x15C)[0]
    free_count = struct.unpack_from('<I', header, 0x160)[0]
    btree_root = struct.unpack_from('<I', header, 0x164)[0]
    
    print(f"  DAT Header:")
    print(f"    File type: {file_type}")
    print(f"    Block size: {block_size}")
    print(f"    File size: {file_size}")
    print(f"    BTree root offset: 0x{btree_root:08X}")
    
    return {
        'block_size': block_size,
        'file_size': file_size,
        'btree_root': btree_root,
    }


def read_btree_node(f, offset, block_size):
    """Read a BTree node and return its entries and child pointers."""
    f.seek(offset)
    data = f.read(block_size)
    
    if len(data) < 12:
        return [], []
    
    # BTree node header
    # packed_data contains file entries
    # Each entry: file_id (4 bytes) + file_offset (4 bytes) + file_size (4 bytes)
    
    # Node structure varies. For cell.dat:
    # First 4 bytes: branch pointers array
    # Then entries
    num_entries = struct.unpack_from('<I', data, 0x3C4)[0] if len(data) > 0x3C8 else 0
    
    entries = []
    children = []
    
    # Read branch block pointers (up to 62)
    for i in range(62):
        ptr = struct.unpack_from('<I', data, i * 4)[0]
        if ptr > 0:
            children.append(ptr)
    
    # Read file entries
    entry_start = 0xF8  # After branch pointers
    for i in range(min(num_entries, 61)):
        off = entry_start + i * 12
        if off + 12 > len(data):
            break
        file_id = struct.unpack_from('<I', data, off)[0]
        file_offset = struct.unpack_from('<I', data, off + 4)[0]
        file_size = struct.unpack_from('<I', data, off + 8)[0]
        if file_id > 0:
            entries.append({
                'id': file_id,
                'offset': file_offset,
                'size': file_size,
            })
    
    return entries, children


def collect_all_file_entries(f, header):
    """Walk the BTree and collect all file entries."""
    block_size = header['block_size']
    root_offset = header['btree_root']
    
    all_entries = {}
    visited = set()
    stack = [root_offset]
    
    while stack:
        offset = stack.pop()
        if offset in visited or offset == 0:
            continue
        visited.add(offset)
        
        try:
            entries, children = read_btree_node(f, offset, block_size)
            for e in entries:
                if e['id'] > 0:
                    all_entries[e['id']] = e
            for c in children:
                if c > 0 and c not in visited:
                    stack.append(c)
        except Exception:
            continue
    
    return all_entries


def extract_landblock_heights(f, entry):
    """Extract the 9×9 height grid from a landblock terrain entry."""
    f.seek(entry['offset'])
    data = f.read(min(entry['size'], 4096))
    
    if len(data) < 200:
        return None
    
    # Landblock cell format:
    # 4 bytes: file ID
    # 4 bytes: flags  
    # Then terrain data varies by version
    
    # The height data is 81 bytes (9×9) starting after the header
    # Each byte is a height value that gets scaled
    
    # Try to find the height grid
    # In AC, landblock terrain height bytes start at offset 8
    # and each byte represents: height = byte_val * 2.0 (rough scale)
    
    try:
        heights = []
        for i in range(81):
            h = data[8 + i]  # byte value 0-255
            # ACE height formula: actual_height = height_byte * 2.0
            heights.append(h * 2.0)
        return heights
    except (IndexError, struct.error):
        return None


def extract_all_heights(dat_path: str) -> dict:
    """Extract heightmaps for all landblocks from the dat file."""
    print(f"  Reading {dat_path}...")
    
    heights_by_lb = {}
    
    with open(dat_path, 'rb') as f:
        # Read header
        header = read_dat_header(f)
        
        # Alternative approach: directly scan for landblock entries
        # Landblock terrain IDs are 0xXXYY0001 where XX,YY = 0x00-0xFF
        # We can try reading them sequentially
        
        print(f"  Scanning for landblock terrain entries...")
        
        # Try BTree approach first
        entries = collect_all_file_entries(f, header)
        
        terrain_entries = {}
        for file_id, entry in entries.items():
            # Terrain cells end in 0xFFFF (the cell mask is the low 16 bits)
            cell = file_id & 0xFFFF
            if cell == 0xFFFF:  # Landblock info entries
                lb_x = (file_id >> 24) & 0xFF
                lb_y = (file_id >> 16) & 0xFF
                terrain_entries[(lb_x, lb_y)] = entry
        
        print(f"  Found {len(terrain_entries)} landblock terrain entries")
        print(f"  Total entries in DAT: {len(entries)}")
        
        # If BTree didn't find much, try brute-force scanning
        if len(terrain_entries) < 100:
            print(f"  BTree yielded few results, trying direct scan...")
            
            file_size = os.path.getsize(dat_path)
            block_size = header['block_size']
            
            # Scan through the file looking for landblock data
            # Landblock entries start with their file ID
            scan_count = 0
            f.seek(DAT_HEADER_SIZE)
            
            while f.tell() < file_size:
                pos = f.tell()
                try:
                    chunk = f.read(4)
                    if len(chunk) < 4:
                        break
                    
                    file_id = struct.unpack('<I', chunk)[0]
                    cell = file_id & 0xFFFF
                    
                    if cell == 0xFFFF and file_id > 0x00010000:
                        lb_x = (file_id >> 24) & 0xFF
                        lb_y = (file_id >> 16) & 0xFF
                        
                        if 0 < lb_x < 255 and 0 < lb_y < 255:
                            terrain_entries[(lb_x, lb_y)] = {
                                'id': file_id,
                                'offset': pos,
                                'size': 1024,
                            }
                            scan_count += 1
                    
                    # Skip to next potential entry
                    f.seek(pos + 4)
                    
                except Exception:
                    f.seek(pos + 4)
                    continue
                
                if scan_count > 0 and scan_count % 5000 == 0:
                    print(f"    Scanned {scan_count} terrain entries...")
            
            print(f"  Direct scan found {scan_count} additional terrain entries")
        
        # Extract heights from terrain entries
        print(f"  Extracting heights from {len(terrain_entries)} landblocks...")
        extracted = 0
        
        for (lb_x, lb_y), entry in sorted(terrain_entries.items()):
            heights = extract_landblock_heights(f, entry)
            if heights:
                heights_by_lb[f"{lb_x},{lb_y}"] = heights
                extracted += 1
        
        print(f"  Extracted heights for {extracted} landblocks")
    
    return heights_by_lb


def main():
    parser = argparse.ArgumentParser(description="Extract heightmaps from client_cell_1.dat")
    parser.add_argument("--dat", required=True, help="Path to client_cell_1.dat")
    parser.add_argument("--output", default=None, help="Output JSON path")
    args = parser.parse_args()
    
    if not os.path.exists(args.dat):
        print(f"ERROR: DAT file not found: {args.dat}")
        sys.exit(1)
    
    output_path = args.output
    if output_path is None:
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        output_path = os.path.join(base_dir, "pipeline_data", "population_output", "vanquish_heights.json")
    
    print("=" * 72)
    print("  Heightmap Extractor — client_cell_1.dat → vanquish_heights.json")
    print("=" * 72)
    print()
    
    heights = extract_all_heights(args.dat)
    
    print(f"\n  Saving to {output_path}...")
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'w') as f:
        json.dump(heights, f)
    
    size_mb = os.path.getsize(output_path) / 1024 / 1024
    print(f"  Saved {len(heights)} landblock heightmaps ({size_mb:.1f} MB)")
    print(f"\nDone!")


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""
Extract height data from vanquish client_cell_1.dat - FAST version.
Single pass through the file, looking for outdoor landblock cell patterns.
"""
import struct
import json
import os
import time

DAT_PATH = r"d:\Clones\WorldBuilder-ACME-Edition-master\vanquishtest\client_cell_1.dat"
OUTPUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "population_output", "vanquish_heights.json")

HEIGHT_SCALE = 2.0

def main():
    print("Loading DAT file into memory...")
    t0 = time.time()
    with open(DAT_PATH, 'rb') as f:
        data = f.read()
    file_len = len(data)
    print(f"  Loaded {file_len:,} bytes in {time.time()-t0:.1f}s")

    # Single pass: scan for all xxyyFFFF patterns that look like valid cell entries
    # A valid cell entry has:
    #   uint32 cell_id = (lbX << 24) | (lbY << 16) | 0xFFFF  where 1 <= lbX,lbY <= 254
    #   uint32 flags < 0x10000 (reasonable terrain flags)
    #   Then 162 bytes of terrain data + 81 bytes of heights = 243 more bytes

    print("Scanning for landblock cell entries (single pass)...")
    height_cache = {}  # "lbX,lbY" -> [81 height float values]
    
    # We look for the 0xFFFF pattern in the low 16 bits
    # Scan aligned to 4-byte boundaries for speed
    pos = 0x400  # skip DAT header area
    candidates = 0
    valid = 0
    
    while pos + 4 + 4 + 162 + 81 <= file_len:
        # Quick check: does this look like a cell ID? (low 16 bits = 0xFFFF)
        low16 = struct.unpack_from('<H', data, pos)[0]
        if low16 == 0xFFFF:
            cell_id = struct.unpack_from('<I', data, pos)[0]
            lbX = (cell_id >> 24) & 0xFF
            lbY = (cell_id >> 16) & 0xFF
            
            # Valid outdoor landblock range
            if 1 <= lbX <= 254 and 1 <= lbY <= 254:
                candidates += 1
                # Check flags
                flags = struct.unpack_from('<I', data, pos + 4)[0]
                if flags < 0x10000:
                    # This looks like a valid cell entry
                    key = f"{lbX},{lbY}"
                    if key not in height_cache:
                        # Extract heights
                        h_start = pos + 8 + 162  # skip ID(4) + flags(4) + terrain(162)
                        heights = []
                        for i in range(81):
                            heights.append(data[h_start + i] * HEIGHT_SCALE)
                        
                        # Sanity check: heights should have reasonable variation
                        h_min = min(heights)
                        h_max = max(heights)
                        if h_max - h_min < 600:  # reasonable terrain variation
                            height_cache[key] = heights
                            valid += 1
                        
        pos += 4  # advance by 4 bytes (uint32 aligned)
        
        if pos % (50 * 1024 * 1024) < 4:
            pct = pos / file_len * 100
            print(f"  ...{pct:.0f}% ({valid} landblocks found)")
    
    print(f"\nScan complete:")
    print(f"  Candidates: {candidates}")
    print(f"  Valid landblocks: {valid}")
    
    # Save to JSON (compact)
    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    
    # Save as a more compact format
    compact = {}
    for key, heights in height_cache.items():
        # Store as list of rounded values
        compact[key] = [round(h, 1) for h in heights]
    
    with open(OUTPUT, 'w') as f:
        json.dump(compact, f, separators=(',', ':'))
    
    sz = os.path.getsize(OUTPUT) / 1024 / 1024
    print(f"Saved to {OUTPUT} ({sz:.1f} MB)")
    
    # Quick validation
    test_keys = ["128,128", "50,50", "200,200", "100,100"]
    for k in test_keys:
        if k in compact:
            h = compact[k]
            print(f"  LB({k}): min={min(h):.0f} max={max(h):.0f}")
        else:
            print(f"  LB({k}): not found (ocean?)")
    
    print(f"Total time: {time.time()-t0:.1f}s")

if __name__ == '__main__':
    main()

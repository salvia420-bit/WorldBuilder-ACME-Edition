import json

d = json.load(open(r"d:\Clones\WorldBuilder-ACME-Edition-master\vanquishtest\building_old_cells.json"))
entries = []
for k, v in d.items():
    olb = v["oldLbKey"]
    lbx = (olb >> 8) & 0xFF
    lby = olb & 0xFF
    if abs(lbx - 170) <= 3 and abs(lby - 180) <= 3:
        entries.append((k, v))

print(f"{len(entries)} buildings near Holtburg retail (170,180)")
print()
for k, v in entries:
    olb = v["oldLbKey"]
    nlb = v["newLbKey"]
    lbx, lby = (olb >> 8) & 0xFF, olb & 0xFF
    nlbx, nlby = (nlb >> 8) & 0xFF, nlb & 0xFF
    cells = v["oldCells"]
    cell_hex = [f"0x{c:04X}" for c in cells[:5]]
    if len(cells) > 5:
        cell_hex.append("...")
    print(f"  {k}:")
    print(f"    ModelId:       0x{v['modelId']:08X}")
    print(f"    Retail LB:     ({lbx},{lby}) = 0x{olb:04X}")
    print(f"    Vanquish LB:   ({nlbx},{nlby}) = 0x{nlb:04X}")
    print(f"    EnvCells ({len(cells)}): {', '.join(cell_hex)}")
    print(f"    Retail LBI:    0x{olb:04X}FFFE")
    print(f"    Vanquish LBI:  0x{nlb:04X}FFFE")
    if cells:
        print(f"    Retail cells:  0x{olb:04X}{cells[0]:04X} .. 0x{olb:04X}{cells[-1]:04X}")
    else:
        print(f"    Retail cells:  (none — exterior-only building)")
    print()

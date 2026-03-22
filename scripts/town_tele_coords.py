"""Generate /tele commands for all Vanquish towns in AC coordinate format."""
import json, os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with open(os.path.join(BASE_DIR, "pipeline_data", "population_output", "town_placements.json")) as f:
    data = json.load(f)
towns = data.get("towns", data)

# AC coordinate formula (derived from retail landblock ↔ coordinate mappings):
#   NS ≈ 0.8 * lbY - 102.4   (positive = North, negative = South)
#   EW ≈ 0.8 * lbX - 102.4   (positive = East, negative = West)

print(f"{'Town':<25} /tele command")
print("-" * 55)

for name, pos in sorted(towns.items()):
    lbx = pos["lbX"]
    lby = pos["lbY"]
    ns = 0.8 * lby - 102.4
    ew = 0.8 * lbx - 102.4

    ns_str = f"{abs(ns):.1f}{'N' if ns >= 0 else 'S'}"
    ew_str = f"{abs(ew):.1f}{'E' if ew >= 0 else 'W'}"
    print(f"{name:<25} /tele {ns_str} {ew_str}")

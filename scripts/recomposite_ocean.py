"""
Pastes the exact original ocean pixels from world_map.png back onto the
quantized image, guaranteeing impassable water remains byte-identical.
"""
from PIL import Image

ORIGINAL  = "pipeline_data/screenshots/world_map.png"
QUANTIZED = "pipeline_data/screenshots/world_map_quantized.png"
MASK      = "pipeline_data/screenshots/ocean_mask.png"
OUTPUT    = "pipeline_data/screenshots/world_map_final.png"

original  = Image.open(ORIGINAL).convert("RGB")
quantized = Image.open(QUANTIZED).convert("RGB")
mask      = Image.open(MASK).convert("L")

# Where mask=0 (black=ocean) -> use original pixel
# Where mask=255 (white=land) -> use quantized pixel
final = Image.composite(quantized, original, mask)

final.save(OUTPUT, compress_level=0)   # lossless PNG
print(f"Saved -> {OUTPUT}")
print("Ocean pixels are now mathematically identical to the original.")

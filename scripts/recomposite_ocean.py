"""
Pastes the exact original ocean pixels from world_map.png back onto the
quantized image, guaranteeing impassable water remains byte-identical.
"""
from PIL import Image

ORIGINAL  = "screenshots/world_map.png"
QUANTIZED = "screenshots/world_map_quantized.png"
MASK      = "screenshots/ocean_mask.png"
OUTPUT    = "screenshots/world_map_final.png"

original  = Image.open(ORIGINAL).convert("RGB")
quantized = Image.open(QUANTIZED).convert("RGB")
mask      = Image.open(MASK).convert("L")

# Where mask=0 (black=ocean) -> use original pixel
# Where mask=255 (white=land) -> use quantized pixel
final = Image.composite(quantized, original, mask)

final.save(OUTPUT, compress_level=0)   # lossless PNG
print(f"Saved -> {OUTPUT}")
print("Ocean pixels are now mathematically identical to the original.")

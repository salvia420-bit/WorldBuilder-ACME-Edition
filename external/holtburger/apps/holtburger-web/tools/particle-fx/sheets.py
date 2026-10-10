#!/usr/bin/env python3
"""Contact sheets of every particle surface texture, labeled, composited the
way the engine blends them (additive on black, alpha over mid-grey)."""
import json, os
from collections import defaultdict
from PIL import Image, ImageDraw
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.environ.get("PFX_WORK") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "work")
os.makedirs(WORK, exist_ok=True)
rows = json.load(open(os.path.join(WORK, "emitters_ctx.json")))
by_surf = defaultdict(list)
for e in rows:
    s = e["surface"]
    sid = e["gfx"]["surfaces"][0] if e["gfx"]["surfaces"] else 0
    by_surf[sid].append(e)

order = sorted(by_surf, key=lambda s: -len(by_surf[s]))
json.dump([{"surface": s, "n": len(by_surf[s])} for s in order], open(os.path.join(WORK, "surf_order.json"), "w"))
T = 112; LAB = 30; COLS = 6; ROWS = 5
os.makedirs(os.path.join(WORK, "sheets"), exist_ok=True)
for si in range(0, len(order), COLS * ROWS):
    chunk = order[si:si + COLS * ROWS]
    sheet = Image.new("RGB", (COLS * T, ROWS * (T + LAB)), (40, 40, 40))
    dr = ImageDraw.Draw(sheet)
    for i, sid in enumerate(chunk):
        x, y = (i % COLS) * T, (i // COLS) * (T + LAB)
        es = by_surf[sid]
        st = es[0]["surface"] or {}
        add = bool(st.get("type", 0) & 0x10000)
        p = os.path.join(WORK, "thumbs", f"{sid:08X}.png")
        if os.path.exists(p):
            im = np.asarray(Image.open(p).convert("RGBA")).astype(np.float32) / 255
            a = im[:, :, 3:4]
            if add:
                rgb = im[:, :, :3] * a
            else:
                bg = np.full_like(im[:, :, :3], 0.45)
                rgb = im[:, :, :3] * a + bg * (1 - a)
            tile = Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8)).resize((T - 4, T - 4), Image.NEAREST)
            sheet.paste(tile, (x + 2, y + 2))
        else:
            c = st.get("color")
            dr.rectangle([x + 2, y + 2, x + T - 2, y + T - 2], outline=(200, 0, 0))
            dr.text((x + 6, y + 40), f"no tex\n{c:#x}" if c is not None else "no tex", fill=(255, 255, 255))
        dr.text((x + 2, y + T), f"{sid:08X} n={len(es)}", fill=(255, 255, 0))
        dr.text((x + 2, y + T + 12), f"{'ADD' if add else 'ALP'} {st.get('w','?')}x{st.get('h','?')} #{si+i}", fill=(180, 220, 255))
    sheet.save(os.path.join(WORK, "sheets", f"sheet_{si // (COLS*ROWS):02d}.png"))
print(len(order), "surfaces")

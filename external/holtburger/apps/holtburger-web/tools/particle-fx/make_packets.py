#!/usr/bin/env python3
"""Build the 8 reviewer packets (markdown + group contact sheet) from profiles.json."""
import json, os
from collections import defaultdict
from PIL import Image, ImageDraw
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.environ.get("PFX_WORK") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "work")
os.makedirs(WORK, exist_ok=True)
P = json.load(open(os.path.join(WORK, "profiles.json")))
E = {f"0x{e['id']:08X}": e for e in json.load(open(os.path.join(WORK, "emitters_ctx.json")))}
FEAT = {int(k, 16): v for k, v in json.load(open(os.path.join(WORK, "surface_features.json"))).items()}
import importlib.util
spec = importlib.util.spec_from_file_location("gp", os.path.join(HERE, "gen_profiles.py"))

GROUPS = {
    "g1_star_a": None, "g1_star_b": None,
    "g2_glow": ["glow_orb", "glow_point", "streak", "beam"],
    "g3_haze_mist": ["faint_glow", "mist_magic"],
    "g4_swirl_ring_rune": ["swirl_tex", "vortex", "vortex_dark", "ring_soft", "ring_line", "rune", "specks"],
    "g5_fire_smoke": ["fire", "flame_tongue", "mist_fire", "smoke_add", "smoke_dark", "smoke_light"],
    "g6_arc_dark_gas": ["lightning", "tendril", "star_dark", "dark_burst", "gas_alpha"],
    "g7_matter_misc": ["solid_ball", "none", "snow", "liquid", "insect", "splash", "mist_white", "misc", "bubbles",
                       "blood", "solid_shard", "leaves", "debris", "water_sheet", "solid_disc", "water_streak",
                       "dust", "blood_mist", "sky"],
}
stars = sorted(k for k, v in P.items() if v["family"] == "star")
half = len(stars) // 2
members = defaultdict(list)
for k, v in P.items():
    if v["family"] == "star":
        members["g1_star_a" if k in stars[:half] else "g1_star_b"].append(k)
        continue
    for g, fams in GROUPS.items():
        if fams and v["family"] in fams:
            members[g].append(k)
            break
    else:
        raise SystemExit(f"unassigned family {v['family']}")

PTYPE = {0: "Unknown", 1: "Still", 2: "LocalVel", 3: "ParabLVGA", 4: "ParabLVGAGR", 5: "Swarm", 6: "Explode", 7: "Implode",
         8: "ParabLVLA", 9: "ParabLVLALR", 10: "ParabGVGA", 11: "ParabGVGAGR", 12: "GlobalVel"}

SEM = open(os.path.join(HERE, "semantics.md")).read()

os.makedirs(os.path.join(WORK, "packets"), exist_ok=True)
os.makedirs(os.path.join(HERE, "overrides"), exist_ok=True)


def sheet(path, surfs):
    T = 160; LAB = 18; COLS = 5
    rows = (len(surfs) + COLS - 1) // COLS
    im = Image.new("RGB", (COLS * T, max(1, rows) * (T + LAB)), (40, 40, 40))
    dr = ImageDraw.Draw(im)
    for i, sid in enumerate(surfs):
        x, y = (i % COLS) * T, (i // COLS) * (T + LAB)
        f = FEAT.get(int(sid, 16), {})
        p = os.path.join(WORK, "thumbs", f"{int(sid, 16):08X}.png")
        if os.path.exists(p):
            a = np.asarray(Image.open(p).convert("RGBA")).astype(np.float32) / 255
            al = a[:, :, 3:4]
            rgb = a[:, :, :3] * al if f.get("additive") else a[:, :, :3] * al + 0.45 * (1 - al)
            t = Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8)).resize((T - 4, T - 4), Image.NEAREST)
            im.paste(t, (x + 2, y + 2))
        else:
            dr.text((x + 10, y + 60), "no texture", fill=(255, 80, 80))
        dr.text((x + 2, y + T), f"{sid} {'ADD' if f.get('additive') else 'ALP'}", fill=(255, 255, 0))
    im.save(path)


ONLY_G = [x for x in os.environ.get("PFX_ONLY", "").split(",") if x]
for g, ks in sorted(members.items()):
    if ONLY_G and g not in ONLY_G:
        continue
    ks.sort()
    by_s = defaultdict(list)
    for k in ks:
        by_s[P[k]["surface"]].append(k)
    surfs = sorted(by_s, key=lambda s: -len(by_s[s]))
    sheet_path = os.path.join(WORK, "packets", f"{g}_sheet.png")
    sheet(sheet_path, surfs)
    lines = []
    lines.append(f"# Particle FX review packet — `{g}` ({len(ks)} emitters, {len(surfs)} textures)\n")
    lines.append(SEM)
    lines.append("\n## Your textures\n")
    lines.append(f"Contact sheet (additive sprites composited on black, alpha sprites over mid-grey): `{sheet_path}`\n")
    lines.append("Individual thumbnails (RGBA, raw): `" + os.path.join(WORK, "thumbs") + "/<SURFACE>.png` (8 hex digits, no 0x, uppercase).\n")
    lines.append("| surface | family (generator) | emitters | additive | radial | edge | lum95 | hue | chroma | size px |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|")
    for s in surfs:
        f = FEAT.get(int(s, 16), {})
        st = E[by_s[s][0]]["surface"] or {}
        lines.append(f"| {s} | {P[by_s[s][0]]['family']} | {len(by_s[s])} | {'Y' if f.get('additive') else 'N'} | {f.get('radial','-')} | {f.get('edge','-')} | {f.get('lum95','-')} | {f.get('hue','-')} | {f.get('chroma','-')} | {st.get('w','?')}x{st.get('h','?')} |")
    lines.append("\n## Your emitters\n")
    lines.append("Columns: did · surface · family · behaviour · ParticleType · S=sprite size m (quad×avg scale) · L=lifespan s · n=expected live particles · trans start→final (0 opaque, 1 invisible; retail lerps opacity between them) · crowd (overlap estimate) · uv · context (who plays it) · generated params (only non-neutral keys).\n")
    for s in surfs:
        lines.append(f"\n### surface {s} — {P[by_s[s][0]]['family']} ({len(by_s[s])})\n")
        for k in by_s[s]:
            v = P[k]; e = E[k]; m = v.get("meta") or {}
            prm = {kk: vv for kk, vv in v["params"].items() if vv not in (0, 0.0, 1.0, [1, 1, 1]) and not (kk == "flickerHz" and not v['params'].get('flicker') and not v['params'].get('twinkle')) and not (kk == 'pulseHz' and not v['params'].get('pulse')) and not (kk == 'tintCurve' and v['params'].get('tint0') == v['params'].get('tint1'))}
            ctx = "; ".join((e.get("ctx") or ["(none)"])[:3])
            if e.get("nCtx", 0) > 3:
                ctx += f" (+{e['nCtx']-3} more)"
            uv = "full" if e["gfx"].get("uvBounds") == [0.0, 0.0, 1.0, 1.0] else str(e["gfx"].get("uvBounds"))
            lines.append(f"- **{k}** {v['behavior']} · {PTYPE.get(e['particleType'], e['particleType'])} · S={m.get('S')} L={m.get('L')} n={m.get('nLive','-')} · trans {e['startTrans']:.2f}→{e['finalTrans']:.2f} · crowd={m.get('crowd','-')} · uv={uv} · birthrate={e['birthrate']:.3g} max={e['maxParticles']} init={e['initialParticles']} total={e['totalParticles']} secs={e['totalSeconds']:.3g}\n  - ctx: {ctx}\n  - gen: `{json.dumps(prm, separators=(',', ':'))}`")
    lines.append(f"\n## Output\n\nWrite `{os.path.join(HERE, 'overrides', g + '.json')}` (see the schema above). Every emitter listed in this packet MUST appear in `emitters` with a `note`; include `params` only for keys you change.\n")
    open(os.path.join(WORK, "packets", f"{g}.md"), "w").write("\n".join(lines))
    print(g, len(ks), "emitters", len(surfs), "textures", os.path.getsize(os.path.join(WORK, "packets", f"{g}.md")) // 1024, "KB")

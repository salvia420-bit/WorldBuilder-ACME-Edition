#!/usr/bin/env python3
"""Every portal Setup in client_portal.dat → data/portal-setups.json.

The portal set piece (scene3d/vfx/fx_showcase.js: portal-space disc + ground
ring, in the portal's own colour) used to key on ObjectDescriptionFlags PORTAL,
which ACE sets on every Portal weenie — including the 22 disguised ones that
draw no portal (bookcases, statues, arena arches, floor pads, the invisible
Great Hall) — and never on a static portal decoration. It also took the disc
centre from the nearest swirl distortion source, which on pillar and destroyed
portals is the funnel hanging off the ground-level anchor (part 6, z 0).

A portal is a Setup built on the portal quad GfxObj 0x0100168B (an invisible
2.8 m quad no other model uses) whose default script spawns something. Per
Setup this records, from the DAT alone:

  kind     disc   — the quad alone + a swirl (purple / coloured / white Gateway /
                    two-tone / Dark Vapor)
           pillar — the quad + the eight 0x010001EC anchors + a live swirl
                    funnel (catacomb / temple / Mysterious Portal)
           dead   — a pillar rig whose swirl is gone: the 39 Destroyed Portals'
                    sputters, The Shadows, the Combat Arena (dark funnel + stars)
           dark   — the quad + dark swirls only (shadow portals, Spire's Head)
  centre   Setup-local AC metres: the main swirl's anchor (its part frame in the
           static pose — Resting 0x65 → Default 0 → first, as walk_setup_parts —
           plus the hook offset) for a disc; the quad's own frame otherwise
  radius   the disc radius: the main swirl's tier-1 distortion radius x 0.95,
           clamped 0.8..3.5 (what fx_showcase used from the live source)
  color    the main swirl's tier-1 light colour (max channel 1), else the
           Setup's LightInfo colour, else the kind's default
  swirl    the main swirl emitter (0x32…), when there is one

Run from apps/holtburger-web/tools/particle-fx:
    python3 portal_setups.py            # → ../../data/portal-setups.json
then `node scripts/gen-portal-setups.mjs` (from apps/holtburger-web).
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
_argv = sys.argv
sys.argv = [sys.argv[0]]  # datcat makes its work dir from argv[1] at import
os.environ.setdefault("PFX_WORK", os.path.join(HERE, "work"))
import datcat as dc  # noqa: E402
sys.argv = _argv

HOLT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HOLT, "data", "portal-setups.json")
PORTAL_QUAD = 0x0100168B
ANCHOR = 0x010001EC
SWIRL_FAMILIES = ("vortex",)
DARK_FAMILIES = ("vortex_dark", "dark_burst", "star_dark")
DEFAULT_COLOR = {"disc": [0.75, 0.5, 1.0], "pillar": [0.75, 0.5, 1.0], "dead": [0.55, 0.25, 0.85], "dark": [0.6, 0.12, 0.2]}


def parse_setup(b):
    """Setup → parts, placement frames {key: [frame per part]}, LightInfo colours."""
    r = dc.R(b)
    sid = r.u32(); fl = r.u32(); n = r.u32()
    parts = [r.u32() for _ in range(n)]
    if fl & 1: r.p += 4 * n
    if fl & 2: r.p += 12 * n
    for _ in range(2):  # holding locations, connection points
        c = r.i32(); r.p += c * (4 + 4 + 28)
    pf = {}
    pc = r.i32()
    for _ in range(pc):
        key = r.i32()
        frames = [r.frame() for _ in range(n)]
        nh = r.u32()
        for _ in range(nh):
            dc.read_hook(r)
        pf[key] = frames
    c = r.u32(); r.p += 20 * c   # cylinder spheres
    c = r.u32(); r.p += 16 * c   # spheres
    r.p += 16 + 32               # height, radius, step up/down; sorting + selection spheres
    lights = []
    c = r.i32()
    for _ in range(c):
        r.i32(); r.frame()
        argb = r.u32(); r.f32(); r.f32(); r.f32()
        lights.append([((argb >> 16) & 0xFF) / 255.0, ((argb >> 8) & 0xFF) / 255.0, (argb & 0xFF) / 255.0])
    r.u32()  # default animation
    default_script = r.u32()
    return {"parts": parts, "pf": pf, "lights": lights, "defaultScript": default_script}


def static_pose(pf, n):
    """walk_setup_parts' static chain: Resting (0x65) → Default (0) → first."""
    frames = pf.get(0x65) or pf.get(0) or (next(iter(pf.values())) if pf else None)
    if not frames or len(frames) != n:
        return [{"origin": [0.0, 0.0, 0.0], "q": [1.0, 0.0, 0.0, 0.0]}] * n
    return frames


def qrot(q, v):
    w, x, y, z = q
    return [
        v[0] * (1 - 2 * (y * y + z * z)) + v[1] * (2 * (x * y - w * z)) + v[2] * (2 * (x * z + w * y)),
        v[0] * (2 * (x * y + w * z)) + v[1] * (1 - 2 * (x * x + z * z)) + v[2] * (2 * (y * z - w * x)),
        v[0] * (2 * (x * z - w * y)) + v[1] * (2 * (y * z + w * x)) + v[2] * (1 - 2 * (x * x + y * y)),
    ]


def norm_color(c):
    m = max(c) if c else 0
    return [round(x / m, 4) for x in c] if m > 1e-4 else None


def main():
    dat = dc.Dat(dc.DAT)
    cat = json.load(open(os.path.join(HOLT, "data", "particle-fx-catalog.json")))["emitters"]
    tier1 = json.load(open(os.path.join(HOLT, "data", "particle-fx-tier1.json")))["emitters"]
    scripts = {}
    emitters = {}

    def script(sid):
        if sid not in scripts:
            b = dat.get(sid)
            scripts[sid] = dc.parse_script(b)[1] if b else []
        return scripts[sid]

    def emitter(eid):
        if eid not in emitters:
            b = dat.get(eid)
            emitters[eid] = dc.parse_emitter(b) if b else None
        return emitters[eid]

    def hooks(sid, seen):
        if sid in seen:
            return []
        seen.add(sid)
        out = []
        for h in script(sid):
            if h["type"] in ("CreateParticle", "CreateBlockingParticle"):
                out.append(h)
            elif h["type"] == "CallPES":
                out += hooks(h["pes"], seen)
        return out

    out = {}
    for sid in dat.ids(0x02):
        b = dat.get(sid)
        try:
            s = parse_setup(b)
        except Exception:
            continue
        parts = s["parts"]
        if PORTAL_QUAD not in parts or not s["defaultScript"]:
            continue
        live = []
        for h in hooks(s["defaultScript"], set()):
            e = emitter(h["emitterInfo"])
            if not e or not e["hwGfxObj"]:
                continue  # retail ParticleEmitter::SetInfo refuses hw GfxObj 0 (never spawns)
            key = "0x%08X" % h["emitterInfo"]
            row = cat.get(key, {})
            live.append({"did": key, "part": h["part"], "offset": h["offset"]["origin"],
                         "family": row.get("family"), "behavior": row.get("behavior")})
        if not live:
            continue
        quad = parts.index(PORTAL_QUAD)
        pillar = len(parts) > 1 and parts.count(ANCHOR) >= 4
        swirls = [e for e in live if e["family"] in SWIRL_FAMILIES and e["behavior"] in ("stream", "plume")]
        sputters = [e for e in live if e["family"] in SWIRL_FAMILIES and e["behavior"] == "standing"]
        dark = [e for e in live if e["family"] in DARK_FAMILIES]
        if swirls:
            kind = "pillar" if pillar else "disc"
        elif pillar and (sputters or dark):
            kind = "dead"
        elif dark and not pillar:
            kind = "dark"
        else:
            kind = "pillar" if pillar else "disc"
        pose = static_pose(s["pf"], len(parts))
        # the main swirl: the widest swirl on the quad's own part (a disc — the
        # two-tone portals carry a small heart swirl under the outer one), else
        # the first swirl / sputter / dark layer in script order
        reach = lambda e: tier1.get(e["did"], {}).get("distortRadius") or 0
        on_quad = [e for e in swirls if e["part"] == quad]
        main = max(on_quad, key=reach) if on_quad else (swirls or sputters or dark or live)[0]
        if kind == "disc" and 0 <= main["part"] < len(parts):
            f = pose[main["part"]]
            off = qrot(f["q"], main["offset"])
            centre = [f["origin"][i] + off[i] for i in range(3)]
        else:
            centre = list(pose[quad]["origin"])
        t1 = tier1.get(main["did"], {})
        dr = t1.get("distortRadius")
        radius = min(3.5, max(0.8, dr * 0.95)) if dr else 1.5
        color = None
        if t1.get("lightColor") and kind in ("disc", "pillar"):
            color = norm_color(t1["lightColor"])
        if not color:
            for e in sputters + swirls:
                lc = tier1.get(e["did"], {}).get("lightColor")
                if lc:
                    color = norm_color(lc)
                    break
        if not color and s["lights"]:
            color = norm_color(s["lights"][0])
        if not color:
            color = norm_color(DEFAULT_COLOR[kind])
        out["0x%08X" % sid] = {
            "kind": kind,
            "quadPart": quad,
            "centre": [round(v, 4) for v in centre],
            "radius": round(radius, 4),
            "color": color,
            "swirl": main["did"] if main in swirls + sputters else None,
        }
    doc = {
        "_note": "GENERATED by tools/particle-fx/portal_setups.py from client_portal.dat + "
                 "data/particle-fx-catalog.json + data/particle-fx-tier1.json — do not edit. "
                 "Every Setup built on the portal quad 0x0100168B whose default script spawns "
                 "something; fields documented in the generator.",
        "portalQuad": "0x%08X" % PORTAL_QUAD,
        "setups": dict(sorted(out.items())),
    }
    with open(OUT, "w") as f:
        json.dump(doc, f, indent=1)
        f.write("\n")
    kinds = {}
    for v in out.values():
        kinds[v["kind"]] = kinds.get(v["kind"], 0) + 1
    print(f"portal setups: {len(out)} {kinds} -> {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()

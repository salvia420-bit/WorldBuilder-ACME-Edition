#!/usr/bin/env python3
"""Validate reviewer override files against their packets."""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.environ.get("PFX_WORK") or os.path.join(HERE, "work")
KEYS = {"gain", "core", "sat", "tintCurve", "tint0", "tint1", "fadeIn", "fadeOut", "erode", "flicker", "flickerHz",
        "twinkle", "spin", "wobble", "soft", "nearFade", "lit", "pulse", "pulseHz", "edgeSoft"}
FAMS = None
sys.path.insert(0, HERE)
import gen_profiles as G  # noqa
FAMS = set(G.R)

for fn in sorted(os.listdir(os.path.join(HERE, "overrides"))):
    if not fn.endswith(".json"):
        continue
    g = fn[:-5]
    try:
        d = json.load(open(os.path.join(HERE, "overrides", fn)))
    except Exception as ex:
        print(f"{g}: PARSE ERROR {ex}")
        continue
    em = d.get("emitters", {})
    pk = os.path.join(WORK, "packets", f"{g}.md")
    want = set(re.findall(r"^- \*\*(0x[0-9A-F]{8})\*\*", open(pk).read(), re.M)) if os.path.exists(pk) else set()
    missing = sorted(want - set(em))
    extra = sorted(set(em) - want) if want else []
    badkeys = sorted({k for v in em.values() for k in (v.get("params") or {}) if k not in KEYS})
    badfam = sorted({v["family"] for v in em.values() if v.get("family") and v["family"] not in FAMS})
    nonotes = [k for k, v in em.items() if not (isinstance(v.get("note"), str) and len(v["note"]) > 15)]
    tuned = sum(1 for v in em.values() if v.get("params"))
    refiled = sum(1 for v in em.values() if v.get("family"))
    print(f"{g}: {len(em)} entries (packet {len(want)}), missing {len(missing)}, extra {len(extra)}, tuned {tuned}, "
          f"refiled {refiled}, bad keys {badkeys}, bad families {badfam}, short notes {len(nonotes)}")
    if missing[:5]:
        print("   missing:", missing[:8])

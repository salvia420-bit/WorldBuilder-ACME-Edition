#!/usr/bin/env python3
"""Critic fixes for the Dereth town-tour plan (2026-10-14). Idempotent: re-run after any rebuild of plan.json
(research/final-plan-build/build.py does NOT contain these fixes).

F1  sanamar.03 -> sanamar-royal-hall.01 was a hard CUT between two sites whose skies differ
    (0.42 neutral -> 0.66 warm): the sun jumps mid-chapter. Give the Royal Hall sub-site a 0.8 s dissolve
    (same as every town boundary) so the change of place and light reads as a scene change.
F2  The Eroica Finale (IV) bursts in fortissimo at 2728.86 s (song/LICENSE.txt track map; song.json energy
    0.00 -> 0.24 at 2729.0) but the cut shoushi.04 -> shoushi.05 sat 2.1 s earlier (2726.736), so the outburst
    landed mid-shot. Move that cut to the bar downbeat 2729.0886 (first downbeat after the onset): shoushi.04
    +2.3524 s, shoushi.05 -2.3524 s. The sum, the town boundary (2739.885) and every other cut are unchanged.
"""
import json, sys

PLAN = "/mnt/wbterminal2/film-projects/dereth-town-tour/plan.json"
p = json.load(open(PLAN))
S = {s["id"]: s for s in p["shots"]}
changed = []

# F1
s = S["sanamar-royal-hall.01"]
if s.get("transition") != {"type": "dissolve", "durationSec": 0.8}:
    s["transition"] = {"type": "dissolve", "durationSec": 0.8}
    if "[critic F1]" not in s["notes"]:
        s["notes"] += " [critic F1: dissolve in from Sanamar city - the sky changes 0.42 -> 0.66 between the two sub-sites, a hard cut made the sun jump]"
    changed.append("F1")

# F2
a, b = S["shoushi.04"], S["shoushi.05"]
OLD_A, OLD_B, D = 12.3932, 13.1488, 2.3524
if abs(a["duration"]["sec"] - OLD_A) < 1e-6 and abs(b["duration"]["sec"] - OLD_B) < 1e-6:
    a["duration"]["sec"] = round(OLD_A + D, 4)
    b["duration"]["sec"] = round(OLD_B - D, 4)
    a["notes"] += " [critic F2: held 2.35 s longer through the Scherzo's last chords and the silence; cut on the Finale's opening downbeat 2729.09 s]"
    b["notes"] += " [critic F2: starts on the Eroica Finale's fortissimo opening (bar downbeat 2729.09 s), 2.35 s shorter]"
    changed.append("F2")
elif abs(a["duration"]["sec"] - (OLD_A + D)) > 1e-3:
    sys.exit(f"F2: unexpected shoushi.04/05 durations {a['duration']} {b['duration']} - plan was rebuilt differently, re-derive the cut")

json.dump(p, open(PLAN, "w"), indent=1, ensure_ascii=False)
print("applied:", changed or "nothing (already applied)")

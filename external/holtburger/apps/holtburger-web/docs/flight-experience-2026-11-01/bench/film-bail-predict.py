#!/usr/bin/env python3
"""film-bail-predict.py — where does a bailed-out body land? (take D2 of the Hellcat film, 2026-11-02)
A replay of ACE's VehicleBailout.StepFall (Dt 1/30: free fall g 9.8, terminal 50 m/s, horizontal tau 4 s; the chute at
150 m AGL: sink 5 m/s, glide 8 m/s along the bail heading, decel 15 m/s^2) over the world tier's bake heights (bilinear).
Replayed from take D's bail it lands within 3 m of where the body did; from take D2's bails within 2 m once the server's
bail point is taken 37 m (t1) / 9 m (t2) BEHIND the eval's bail event (the client predictor leads the server).
  python3 film-bail-predict.py AIM_X AIM_Y [HEADING_DEG=71.4] [LEAD_FROM LEAD_TO STEP] [--agl 2603.7]
prints, per bail lead (the eval's dist to the aim at the bail), the landing relative to the aim and to Al-Arqas.
"""
import json, math, sys
W = "/home/wbterminal/hb-serve/dist/current/world/"
WH = open(W + "world_height.u8", "rb").read(); TAB = json.load(open(W + "world_meta.json"))["landHeightTable"]
def g(x, y):
    fx, fy = x / 24, y / 24; i, j = int(fx), int(fy); u, v = fx - i, fy - j
    H = lambda a, b: TAB[WH[b * 2041 + a]]
    return H(i, j) * (1 - u) * (1 - v) + H(i + 1, j) * u * (1 - v) + H(i, j + 1) * (1 - u) * v + H(i + 1, j + 1) * u * v
def mt(c, t, d): return t if abs(t - c) <= d else c + math.copysign(d, t - c)
def sim(x, y, z, hdg_deg, v=111.0, dt=1 / 30):
    h = math.radians(hdg_deg); vx, vy, vz = math.sin(h) * v, math.cos(h) * v, 0.0; chute = False; t = 0; tc = None
    while True:
        if not chute:
            vz -= 9.8 * dt; vz = max(vz, -50); k = math.exp(-dt / 4); vx *= k; vy *= k
        else:
            vz = mt(vz, -5, 15 * dt); vx = mt(vx, math.sin(h) * 8, 7.5 * dt); vy = mt(vy, math.cos(h) * 8, 7.5 * dt)
        x += vx * dt; y += vy * dt; z += vz * dt; t += dt
        gg = g(x, y)
        if not chute and z - gg <= 150: chute = True; tc = t
        if z <= gg: return x, y, t, tc
if __name__ == "__main__":
    a = [x for x in sys.argv[1:] if not x.startswith("--")]
    agl = float(sys.argv[sys.argv.index("--agl") + 1]) if "--agl" in sys.argv else 2603.7
    if "--agl" in sys.argv: a = [x for x in a if x != sys.argv[sys.argv.index("--agl") + 1]]
    if len(a) < 2: print(__doc__); sys.exit(2)
    ax, ay = float(a[0]), float(a[1]); hd = float(a[2]) if len(a) > 2 else 71.4
    l0, l1, st = (float(a[3]), float(a[4]), float(a[5])) if len(a) > 5 else (540.0, 660.0, 6.0)
    TX, TY = 27636, 16956
    h = math.radians(hd); lead = l0
    while lead <= l1 + 1e-9:
        bx, by = ax - math.sin(h) * lead, ay - math.cos(h) * lead
        lx, ly, t, tc = sim(bx, by, g(bx, by) + agl, hd)
        along = (lx - ax) * math.sin(h) + (ly - ay) * math.cos(h)
        print(f"lead {lead:6.1f}: land ({lx:.1f}, {ly:.1f})  vs aim along {along:+6.1f} m  vs Al-Arqas E{lx - TX:+6.1f} N{ly - TY:+6.1f}  fall {t:.1f} s, chute {t - tc:.1f} s, ground {g(lx, ly):.1f} m")
        lead += st

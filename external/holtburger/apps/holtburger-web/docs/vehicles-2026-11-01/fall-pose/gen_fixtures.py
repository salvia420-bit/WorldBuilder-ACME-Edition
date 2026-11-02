#!/usr/bin/env python3
"""Fall-pose fixtures (vehicles DESIGN decision 54+), generated FROM the retail client_portal.dat.

Reads the base DATs read-only (tools/dat-patch/datlib.py: the minimal ACE.DatLoader port) and writes
fall-pose-fixtures.json, which tests/vehicle_fall_pose.test.mjs uses to pin scene3d/vehicle/fall_pose.js:

  * chargen      CharGen 0x0E000002: per heritage x sex the Scale (percent; ACE PlayerFactory sets
                 PropertyFloat.DefaultScale = Scale / 100, the rig's root scale), Setup and MotionTable.
                 The gender record's fixed fields follow its name (holtburger-dat char_gen.rs
                 CharacterGenGender: scale, setup, sound table, icon, base palette, skin palette set,
                 physics table, motion table, combat table); the scan validates Setup 0x02.. / MT 0x09...
  * setups       per Setup: part count, the RightHand / LeftHand / None (back) holding locations, and the
                 torso (part 9) / head (part 16) GfxObj vertex measurements in PART-LOCAL metres
                 (local +y = the back: the chest's rest frame is ~180 deg about z), or for the Olthoi rigs
                 the part-local pack anchor computed from the rest placement.
  * motionTables per MotionTable: the NonCombat Falling (0x40000015) cycle and the Ready <-> Falling links.
  * anims        the Falling loop 0x030004A9 (every humanoid MotionTable's NonCombat Falling cycle):
                 numFrames, numParts, frames (frame-major, part-minor, 7 floats [x, y, z, qw, qx, qy, qz]).
  * restFrames   the human Setup 0x02000001 default placement (34 x [x, y, z, qw, qx, qy, qz]).

  python3 gen_fixtures.py            # regenerate
  python3 gen_fixtures.py --check    # exit 1 if the committed JSON is stale
"""
import json
import math
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[6]  # .../WorldBuilder-ACME-Edition
sys.path.insert(0, str(REPO / "tools" / "dat-patch"))
from datlib import Dat, R, parse_setup, _vertex_array  # noqa: E402

PORTAL_PATH = Path("/home/wbterminal/ac_base_dats/client_portal.dat")
OUTPUT = HERE / "fall-pose-fixtures.json"

NONCOMBAT = 0x8000003D
READY = 0x41000003
FALLING = 0x40000015
FALLING_LOOP = 0x030004A9
# AnimationHook payload sizes after the 8-byte (type, direction) base (ACE.DatLoader Entity/AnimationHooks).
HOOK_PAYLOAD = {0: 0, 1: 4, 2: 4, 3: 28, 4: 0, 6: 4, 7: 16, 8: 12, 9: 16, 10: 12, 11: 16, 12: 8, 13: 40, 14: 4,
                15: 4, 16: 4, 17: 0, 18: 4, 19: 8, 20: 12, 21: 16, 22: 12, 23: 8, 24: 12, 25: 4, 26: 40}


def r6(v):
    return float("%.6g" % v)


def cu32(b, o):
    b0 = b[o]
    if not (b0 & 0x80):
        return b0, o + 1
    b1 = b[o + 1]
    if not (b0 & 0x40):
        return ((b0 & 0x7F) << 8) | b1, o + 2
    s = struct.unpack_from("<H", b, o + 2)[0]
    return ((((b0 & 0x3F) << 8) | b1) << 16) | s, o + 4


def gfx_vertices(dat, did):
    b = dat.get(did)
    if b is None:
        return []
    n, o = cu32(b, 8)
    r = R(b)
    r.o = o + 4 * n
    P, _N, _UV, _idx = _vertex_array(r)
    return P


def parse_anim(dat, did):
    b = dat.get(did)
    o = 0
    _aid, flags, nparts, nframes = struct.unpack_from("<4I", b, o)
    o += 16
    if flags & 1:
        o += 28 * nframes
    frames = []
    for _ in range(nframes):
        for _p in range(nparts):
            frames.extend(struct.unpack_from("<7f", b, o))
            o += 28
        nh = struct.unpack_from("<I", b, o)[0]
        o += 4
        for _h in range(nh):
            ht = struct.unpack_from("<I", b, o)[0]
            o += 8
            if ht == 5:
                o += 2
                v = struct.unpack_from("<H", b, o)[0]
                o += 4 if (v & 0x8000) else 2
            else:
                o += HOOK_PAYLOAD[ht]
    if o != len(b):
        raise ValueError("animation 0x%08X not fully consumed" % did)
    return {"did": "0x%08X" % did, "flags": flags, "numFrames": nframes, "numParts": nparts,
            "frames": [r6(v) for v in frames]}


def parse_mtable(dat, did):
    b = dat.get(did)
    o = 0

    def u32():
        nonlocal o
        v = struct.unpack_from("<I", b, o)[0]
        o += 4
        return v

    def mdata():
        nonlocal o
        na, _bf, fl = b[o], b[o + 1], b[o + 2]
        o += 4
        anims = []
        for _ in range(na):
            aid, lo, hi, fps = struct.unpack_from("<Iiif", b, o)
            o += 16
            anims.append({"anim": "0x%08X" % aid, "low": lo, "high": hi, "fps": r6(fps)})
        if fl & 1:
            o += 12
        if fl & 2:
            o += 12
        return anims

    def dict_md():
        out = {}
        for _ in range(u32()):
            k = u32()
            out[k] = mdata()
        return out

    u32()  # id
    u32()  # default style
    for _ in range(u32()):
        u32(); u32()
    cycles = dict_md()
    dict_md()  # modifiers
    links = {}
    for _ in range(u32()):
        k = u32()
        links[k] = dict_md()
    if o != len(b):
        raise ValueError("motion table 0x%08X not fully consumed" % did)

    def key(style, cmd):
        return ((style << 16) & 0xFFFFFFFF) | (cmd & 0xFFFFF)

    return {
        "fallingCycle": cycles.get(key(NONCOMBAT, FALLING)),
        "readyToFalling": links.get(key(NONCOMBAT, READY), {}).get(FALLING),
        "fallingToReady": links.get(key(NONCOMBAT, FALLING), {}).get(READY),
    }


def chargen_rows(dat):
    """Heritage x sex rows from CharGen 0x0E000002 (see the module docstring for the scan)."""
    b = dat.get(0x0E000002)
    heritage_at = []
    for i in range(len(b) - 20):
        n = b[i]
        if 3 <= n <= 20 and i + 1 + n + 12 <= len(b):
            s = b[i + 1:i + 1 + n]
            if all(32 <= c < 127 for c in s):
                icon, setup, env = struct.unpack_from("<3I", b, i + 1 + n)
                if (icon >> 24) == 0x06 and (setup >> 24) == 0x02 and (env >> 24) == 0x02:
                    heritage_at.append((i, s.decode()))
    rows = []
    for tag in (b"\x04Male", b"\x06Female"):
        pos = 0
        while True:
            j = b.find(tag, pos)
            if j < 0:
                break
            pos = j + 1
            scale, setup, _sound, _icon, _pal, _skin, _phys, mt, _ct = struct.unpack_from("<9I", b, j + len(tag))
            if (setup >> 24) != 0x02 or (mt >> 24) != 0x09:
                continue
            her = [h for h in heritage_at if h[0] < j][-1][1]
            rows.append({"heritage": her, "sex": tag[1:].decode(), "scale": scale,
                         "setup": "0x%08X" % setup, "motionTable": "0x%08X" % mt})
    order = [h[1] for h in heritage_at]
    rows.sort(key=lambda r: (order.index(r["heritage"]), r["sex"] != "Male"))
    return rows


def qrot(q, v):
    w, x, y, z = q
    tx = 2 * (y * v[2] - z * v[1])
    ty = 2 * (z * v[0] - x * v[2])
    tz = 2 * (x * v[1] - y * v[0])
    return (v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx))


def qconj(q):
    return (q[0], -q[1], -q[2], -q[3])


def qmul(a, b):
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return (aw * bw - ax * bx - ay * by - az * bz, aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw)


def torso_measures(P):
    """Back / front / top / bottom / half-width of a torso GfxObj, part-local (+y = the back)."""
    back = [p[1] for p in P if abs(p[0]) <= 0.2 and -0.12 <= p[2] <= 0.32]
    front = [p[1] for p in P if abs(p[0]) <= 0.2 and 0.05 <= p[2] <= 0.36]
    wide = [abs(p[0]) for p in P if 0.0 <= p[2] <= 0.3]
    return {
        "backY": r6(max(back)), "frontY": r6(min(front)),
        "top": r6(max(p[2] for p in P)), "bottom": r6(min(p[2] for p in P)),
        "halfW": r6(max(wide)),
    }


def olthoi_anchor(dat, setup, st):
    """Part-local pack anchor for the two Olthoi rigs (no hands; the pack rides the thorax, part 0).

    Same convention as the humanoid anchor: the pack root is the centre of its FRONT face (the face against the
    body); the pack extends along its own +y (away from the body) and its own +z is the pack's top.
    """
    rest = st["frames"][0]

    def world(i):
        o, q = rest[i]
        return [tuple(a + b for a, b in zip(qrot(q, p), o)) for p in gfx_vertices(dat, st["parts"][i])]

    if setup == 0x02001A21:
        # upright soldier: the back of the thorax (part 0, object -y), pack depth pointing backward, top up
        part = 0
        back = min(p[1] for p in world(0))
        obj = (0.0, back - 0.01, 1.62)
        objq = (0.0, 0.0, 0.0, 1.0)  # 180 deg about z: pack +y (away from the body) -> object -y
    else:
        # horizontal acid olthoi: on top of the thorax (the part holding the highest vertex over the body's
        # middle), pack depth pointing up, pack top toward the head (+y)
        best = None
        for i in range(len(st["parts"])):
            for p in world(i):
                if abs(p[0]) < 0.3 and 0.0 <= p[1] <= 1.0 and (best is None or p[2] > best[1]):
                    best = (i, p[2])
        part = best[0]
        obj = (0.0, 0.5, best[1] + 0.01)
        h = math.sqrt(0.5)
        objq = (0.0, 0.0, h, h)  # pack x -> -x, y -> +z, z -> +y
    o0, q0 = rest[part]
    local = qrot(qconj(q0), tuple(a - b for a, b in zip(obj, o0)))
    lq = qmul(qconj(q0), objq)
    return {"part": part, "pos": [r6(v) for v in local], "quat": [r6(v) for v in lq], "objectPos": [r6(v) for v in obj]}


def build():
    dat = Dat(str(PORTAL_PATH))
    rows = chargen_rows(dat)
    setups = {}
    for r in rows:
        sid = int(r["setup"], 16)
        key = r["setup"]
        if key in setups:
            continue
        st = parse_setup(dat.get(sid))
        n = len(st["parts"])
        hold = st["holding"]
        entry = {
            "parts": n,
            "rightHandPart": hold[1][0] if 1 in hold else None,
            "leftHandPart": hold[2][0] if 2 in hold else None,
        }
        humanoid = n >= 17 and entry["rightHandPart"] == 15 and entry["leftHandPart"] == 12
        entry["kind"] = "humanoid" if humanoid else "no-hands"
        if humanoid:
            entry["torsoGfx"] = "0x%08X" % st["parts"][9]
            entry["torso"] = torso_measures(gfx_vertices(dat, st["parts"][9]))
            head = gfx_vertices(dat, st["parts"][16])
            entry["headHalfW"] = r6(max(abs(p[0]) for p in head)) if head else 0.09
            back = hold.get(0)  # ParentLocation None: the retail back-worn location on the chest
            entry["backHolding"] = {"part": back[0], "pos": [r6(v) for v in back[1]]} if back else None
        else:
            entry["anchor"] = olthoi_anchor(dat, sid, st)
        setups[key] = entry
    mts = {}
    for r in rows:
        if r["motionTable"] not in mts:
            mts[r["motionTable"]] = parse_mtable(dat, int(r["motionTable"], 16))
    human = parse_setup(dat.get(0x02000001))
    rest = [[r6(v) for v in (*o, *q)] for (o, q) in human["frames"][0]]
    return {
        "source": "client_portal.dat (~/ac_base_dats): CharGen 0x0E000002, the heritage Setups / GfxObjs / "
                  "MotionTables, Animation 0x030004A9 — tools/dat-patch/datlib.py, gen_fixtures.py",
        "chargen": rows,
        "setups": setups,
        "motionTables": mts,
        "anims": {"0x030004A9": parse_anim(dat, FALLING_LOOP)},
        "restFrames": rest,
    }


def main():
    out = json.dumps(build(), indent=1) + "\n"
    if "--check" in sys.argv:
        cur = OUTPUT.read_text() if OUTPUT.exists() else ""
        if cur != out:
            print("fall-pose-fixtures.json is stale: run python3 gen_fixtures.py")
            sys.exit(1)
        print("fall-pose-fixtures.json up to date")
        return
    OUTPUT.write_text(out)
    print("wrote", OUTPUT)


if __name__ == "__main__":
    main()

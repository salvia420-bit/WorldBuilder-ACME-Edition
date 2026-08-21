#!/usr/bin/env python3
"""Offline ragdoll death baker -- "Emote-Dice deaths" lane, pilot v1.

Ports the CORE math of the validated web ragdoll
(external/holtburger/apps/holtburger-web/scene3d/ragdoll.js) into an offline,
deterministic, seeded baker that emits AC Animation (0x03) records plus the
edited MotionTable (0x09) for one creature species.

What is ported: verlet particle per Setup part, distance constraints along the
parent + grandparent links of the Setup's ParentIndex graph, rigidity braces to
3 spanning anchors with a per-joint randomized give schedule, a seeded
directional topple (omega x r) + twist + shove, a flat ground plane with
friction/restitution, and the bone-swing orientation derivation
(restDir -> currentBoneDir, leaves inherit the parent swing).

What is deliberately dropped (offline bake, no live environment):
  * walls / env bridge (floorZAt, constrainAC)  -- flat plane only
  * the mechanical-energy governor              -- kept the cheap parts of it
    (per-node speed + up-speed ceilings and the penetration-tracking contact
    pass, which is where the fly-away actually came from); the ratcheting E cap
    is not needed for a 1 s bake and would be untestable offline.
  * settle detection / freeze                   -- the bake runs a fixed number
    of frames by construction.

SPACE CONVENTION.  AC model space is +Z up (verified: the retail Drudge death
Animation 0x030000EF drops every part origin's Z from ~1.20 to ~0.27 over its
40 frames), so gravity is -Z -- the same convention ragdoll.js documents.  Part
AFrames are ABSOLUTE model-space transforms, not parent-relative (the client
does Frame::combine(objFrame, animframe->frame[i]) per part, acclient.c
CPartArray::UpdateParts), so a baked frame is just N (origin, quat) pairs.

AFrame byte layout is origin FIRST then the quaternion as w,x,y,z
(ACE.DatLoader/Entity/Frame.cs).  See motionlib.py for the full record layout.

Usage
-----
    python3 ragdoll_bake.py bake   --out DIR            # sim + encode 0x03 records
    python3 ragdoll_bake.py mtable --out DIR            # edit + encode the 0x09
    python3 ragdoll_bake.py sql    --out DIR            # emit insert + rollback SQL
    python3 ragdoll_bake.py all    --out DIR
"""
import argparse
import json
import math
import os
import struct
import sys

import datlib
import motionlib as M

# --------------------------------------------------------------- pilot config

BASE_PORTAL = "/home/wbterminal/ac_base_dats/client_portal.dat"

SPECIES = dict(
    name="drudge",
    wcid=7,                      # Drudge Skulker (LSD didStats: Setup=1, MTable=2)
    setup=0x020007DD,
    mtable=0x09000008,
    death_anim=0x030000EF,       # retail Links[(NonCombat<<16)|Ready][Dead] anim
)

SPRAWL_DID = 0x0300F000
FALL_DIDS = [0x0300F001, 0x0300F002, 0x0300F003, 0x0300F004]

FPS = 30.0                       # retail Dead framerate; the bake samples at it
BEAT_FRAMES = 3                  # shared impact beat = retail death frames 0..2
FALL_FRAMES = 30                 # 1.000 s of ragdoll fall per variant
BLEND_FRAMES = 12                # last N frames converge into the shared sprawl

# the shared sprawl sim (see cmd_bake)
SPRAWL_SEED = 0x5B4A1177
SPRAWL_DIR = math.radians(-105.0)   # neutral: the centre of the variant fan
SPRAWL_TOPPLE = 0.55
SPRAWL_SETTLE_FRAMES = 90           # 3.0 s at 30 fps -- long past settle

# Variant MotionCommands.  Every one of these is in the client's 408-entry
# command_ids table (acclient.c:40403) at index == low16, which is what makes
# InterpretedMotionState::UnPack's unguarded command_ids[idx] safe.
VARIANT_CMDS = [
    ("WindedState", 0x430000FD),
    ("SlouchState", 0x430000FA),
    ("KneelState",  0x430000F7),
    ("PossumState", 0x43000145),
]

# Per-variant style knobs: (seed, fall direction rad in model XY, topple scale,
# twist scale, give-start offset s).  Directions are a moderate fan, not a full
# 360 spread: all four must converge into ONE shared sprawl (the corpse has a
# single rest cycle), so a wide fan buys variety in the fall at the cost of a
# violent convergence blend.
VARIANTS = [
    dict(cmd=VARIANT_CMDS[0], seed=0xA17C0DE1, dir=math.radians(-115.0),
         topple=1.00, twist=0.6, give=0.00, label="backpedal-left"),
    dict(cmd=VARIANT_CMDS[1], seed=0x5EED2222, dir=math.radians(-65.0),
         topple=0.80, twist=1.4, give=0.10, label="slump-right-twist"),
    dict(cmd=VARIANT_CMDS[2], seed=0x13579BDF, dir=math.radians(-90.0),
         topple=1.25, twist=0.2, give=-0.08, label="hard-backfall"),
    dict(cmd=VARIANT_CMDS[3], seed=0xC0FFEE44, dir=math.radians(-150.0),
         topple=0.70, twist=1.0, give=0.18, label="crumple-left"),
]

# --------------------------------------------------------------- sim tunables
# (values carried over from ragdoll.js unless noted)
GRAVITY = 9.8
DAMPING = 0.985
FLOOR_FRICTION = 0.55
NODE_RADIUS = 0.06
ITERATIONS = 3
ITERATIONS_RIGID = 5
IMPULSE = 2.2
BEND_RIGID = 1.0
GIVE_MIN = 0.30
GIVE_SPAN = 0.95
GIVE_RAMP = 0.45
CORE_BIAS = 0.55
TOPPLE_GAIN = 1.0
TOPPLE_RATE_CAP = 0.6
TWIST = 2.2
DIR_JITTER = 0.9
PIVOT_LEAD = 0.18
LINEAR_FRAC = 0.25
JITTER = 0.12
BOUNCE_MAX = 0.35
MAX_SPEED = 8.0
MAX_UP_SPEED = 3.0
BRACE_STIFF = 1.0

SUBSTEPS = 4                     # sim substeps per baked frame (dt = 1/120 s)
FLOOR_Z = 0.0                    # model-space ground: the creature's foot plane

ROOT = 0xFFFFFFFF


# ------------------------------------------------------------------ prng/math

def mulberry32(seed):
    a = [seed & 0xFFFFFFFF or 0x9E3779B9]

    def rand():
        a[0] = (a[0] + 0x6D2B79F5) & 0xFFFFFFFF
        t = a[0]
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        t &= 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0
    return rand


def qmul(a, b):
    """Hamilton product, both (w,x,y,z).  Result applies b first, then a."""
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return (aw * bw - ax * bx - ay * by - az * bz,
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw)


def qnorm(q):
    n = math.sqrt(sum(c * c for c in q))
    if n < 1e-12:
        return (1.0, 0.0, 0.0, 0.0)
    return tuple(c / n for c in q)


def qslerp(a, b, t):
    a = qnorm(a)
    b = qnorm(b)
    d = sum(x * y for x, y in zip(a, b))
    if d < 0:
        b = tuple(-c for c in b)
        d = -d
    if d > 0.9995:
        return qnorm(tuple(a[i] + t * (b[i] - a[i]) for i in range(4)))
    th0 = math.acos(max(-1.0, min(1.0, d)))
    th = th0 * t
    s0 = math.sin(th0)
    return qnorm(tuple((math.sin(th0 - th) / s0) * a[i] + (math.sin(th) / s0) * b[i]
                       for i in range(4)))


def quat_from_unit_vectors(a, b):
    """Shortest-arc rotation taking unit vector a to unit vector b, as (w,x,y,z)."""
    d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    if d < -0.999999:
        # 180 deg: any perpendicular axis
        ax = (1.0, 0.0, 0.0) if abs(a[0]) < 0.9 else (0.0, 1.0, 0.0)
        c = (a[1] * ax[2] - a[2] * ax[1],
             a[2] * ax[0] - a[0] * ax[2],
             a[0] * ax[1] - a[1] * ax[0])
        return qnorm((0.0, c[0], c[1], c[2]))
    c = (a[1] * b[2] - a[2] * b[1],
         a[2] * b[0] - a[0] * b[2],
         a[0] * b[1] - a[1] * b[0])
    return qnorm((1.0 + d, c[0], c[1], c[2]))


def smoothstep(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3.0 - 2.0 * t)


# ---------------------------------------------------------------- sim (ported)

def valid_parent(p, n):
    return p is not None and p != ROOT and 0 <= p < n


def build_depths(parent):
    n = len(parent)
    depth = [0] * n
    for i in range(n):
        cur, d = i, 0
        for _ in range(n):
            p = parent[cur]
            if not valid_parent(p, n) or p == cur:
                break
            cur = p
            d += 1
        depth[i] = d
    return depth


def build_constraints(parent, pos=None):
    """ragdoll.js buildConstraints + ONE offline-only addition: orphan welds.

    The Drudge Setup's ParentIndex has THREE roots (0 = body, 8 and 11 = the two
    hips): the legs are separate chains with no link to the torso at all.  The
    web sim gets away with that because its braces (which do span the body) are
    still holding when a corpse settles a second later.  A baked animation is
    watched frame by frame, so an orphan root is welded to its nearest part in
    the start pose with a permanently stiff bone constraint -- otherwise the
    legs free-fall away from the body once the braces fade.  `kind="weld"`
    constraints never enter the give schedule.
    """
    cons = []
    n = len(parent)
    for i in range(n):
        p = parent[i]
        if not valid_parent(p, n):
            if pos is not None and i != 0:
                near = min((j for j in range(n) if j != i and _dist(pos, i, j) > 1e-4),
                           key=lambda j: _dist(pos, i, j), default=None)
                if near is not None:
                    cons.append(dict(a=i, b=near, rest=0.0, stiff=1.0, kind="weld",
                                     t0=0.0, t1=0.0))
            continue
        cons.append(dict(a=i, b=p, rest=0.0, stiff=1.0, kind="bone", t0=0.0, t1=0.0))
        gp = parent[p]
        if valid_parent(gp, n):
            cons.append(dict(a=i, b=gp, rest=0.0, stiff=0.5, kind="bend", t0=0.0, t1=0.0))
    return cons


def _dist(pos, i, j):
    return math.sqrt(sum((pos[i * 3 + k] - pos[j * 3 + k]) ** 2 for k in range(3)))


def build_braces(parent, pos, rand, depth, give_shift=0.0):
    n = len(parent)
    braces = []
    if n < 4:
        return braces
    max_depth = max(1, max(depth))
    a1 = min(range(n), key=lambda i: pos[i * 3 + 2])
    a2, best = -1, 0.0
    for i in range(n):
        if i == a1:
            continue
        l = _dist(pos, i, a1)
        if l > best:
            best, a2 = l, i
    if a2 < 0 or best < 1e-4:
        return braces
    v = tuple((pos[a2 * 3 + k] - pos[a1 * 3 + k]) / best for k in range(3))
    a3, best_perp = -1, 0.0
    for i in range(n):
        if i in (a1, a2):
            continue
        w = tuple(pos[i * 3 + k] - pos[a1 * 3 + k] for k in range(3))
        dp = sum(w[k] * v[k] for k in range(3))
        perp = math.sqrt(sum((w[k] - dp * v[k]) ** 2 for k in range(3)))
        if perp > best_perp:
            best_perp, a3 = perp, i
    anchors = [a1, a2, a3] if (a3 >= 0 and best_perp > 1e-3 * best) else [a1, a2]

    def window(coreness, extra_hold):
        t0 = (GIVE_MIN + GIVE_SPAN * (CORE_BIAS * coreness + (1 - CORE_BIAS) * rand())
              + extra_hold + give_shift)
        return t0, t0 + GIVE_RAMP * (0.6 + 0.8 * rand())

    for i in range(n):
        if i in anchors:
            continue
        coreness = 1.0 - depth[i] / max_depth
        for a in anchors:
            rest = _dist(pos, i, a)
            if rest <= 1e-4:
                continue
            t0, t1 = window(coreness, 0.0)
            braces.append(dict(a=i, b=a, rest=rest, t0=t0, t1=t1))
    for i in range(len(anchors)):
        for j in range(i + 1, len(anchors)):
            rest = _dist(pos, anchors[i], anchors[j])
            if rest <= 1e-4:
                continue
            t0, t1 = window(1.0, GIVE_SPAN * 0.25)
            braces.append(dict(a=anchors[i], b=anchors[j], rest=rest, t0=t0, t1=t1))
    return braces


def build_bone_children(parent, pos):
    n = len(parent)
    child = [-1] * n
    best = [0.0] * n
    for i in range(n):
        p = parent[i]
        if not valid_parent(p, n):
            continue
        l = _dist(pos, i, p)
        if l > best[p]:
            best[p] = l
            child[p] = i
    return child


def give_gain(t, t0, t1):
    if not (t1 > t0):
        return 0.0
    if t <= t0:
        return 1.0
    if t >= t1:
        return 0.0
    u = (t1 - t) / (t1 - t0)
    return u * u * (3.0 - 2.0 * u)


def init_sim(parent, positions, seed, direction, topple_scale, twist_scale,
             give_shift, dt, impulse_speed=IMPULSE, floor_z=FLOOR_Z):
    n = len(parent)
    pos = list(positions)
    prev = [0.0] * (n * 3)
    rand = mulberry32(seed)

    zmin = min(pos[i * 3 + 2] for i in range(n))
    zmax = max(pos[i * 3 + 2] for i in range(n))
    cx = sum(pos[i * 3] for i in range(n)) / n
    cy = sum(pos[i * 3 + 1] for i in range(n)) / n
    height = max(0.25, zmax - zmin)

    ang = direction + (rand() - 0.5) * DIR_JITTER
    dx, dy = math.cos(ang), math.sin(ang)
    rate = (min((impulse_speed / height) * TOPPLE_GAIN,
                TOPPLE_RATE_CAP * math.sqrt(GRAVITY / height))
            * (0.7 + 0.6 * rand()) * topple_scale)
    ox, oy = -dy * rate, dx * rate
    twist = TWIST * (-1.0 if rand() < 0.5 else 1.0) * (0.35 + 0.65 * rand()) * twist_scale

    low_band = zmin + 0.25 * height
    sel = [i for i in range(n) if pos[i * 3 + 2] <= low_band]
    if sel:
        px = sum(pos[i * 3] for i in sel) / len(sel)
        py = sum(pos[i * 3 + 1] for i in sel) / len(sel)
    else:
        px, py = cx, cy
    px += dx * PIVOT_LEAD * height
    py += dy * PIVOT_LEAD * height
    pz = zmin

    shove = LINEAR_FRAC * impulse_speed
    jitter = JITTER * (0.3 + impulse_speed / IMPULSE)
    for i in range(n):
        i3 = i * 3
        rx, ry, rz = pos[i3] - px, pos[i3 + 1] - py, pos[i3 + 2] - pz
        vx = oy * rz
        vy = -ox * rz
        vz = ox * ry - oy * rx
        vx -= twist * (pos[i3 + 1] - cy)
        vy += twist * (pos[i3] - cx)
        vx += dx * shove + (rand() - 0.5) * jitter
        vy += dy * shove + (rand() - 0.5) * jitter
        vz += (rand() - 0.5) * jitter
        prev[i3] = pos[i3] - vx * dt
        prev[i3 + 1] = pos[i3 + 1] - vy * dt
        prev[i3 + 2] = pos[i3 + 2] - vz * dt

    depth = build_depths(parent)
    max_depth = max(1, max(depth))
    cons = build_constraints(parent, pos)
    for c in cons:
        c["rest"] = _dist(pos, c["a"], c["b"])
        if c["kind"] == "bend":
            coreness = 1.0 - depth[c["a"]] / max_depth
            c["t0"] = (GIVE_MIN + GIVE_SPAN
                       * (CORE_BIAS * coreness + (1 - CORE_BIAS) * rand()) + give_shift)
            c["t1"] = c["t0"] + GIVE_RAMP * (0.6 + 0.8 * rand())
    braces = build_braces(parent, pos, rand, depth, give_shift)
    brace_end = max([b["t1"] for b in braces] + [c["t1"] for c in cons] + [0.0])

    return dict(n=n, pos=pos, prev=prev, cons=cons, braces=braces,
                floor_z=floor_z, brace_end=brace_end,
                bounce=BOUNCE_MAX * rand() * rand(), t=0.0,
                seed_dir=(dx, dy), twist=twist, rate=rate)


def step_sim(sim, dt):
    n, pos, prev = sim["n"], sim["pos"], sim["prev"]
    cons, braces = sim["cons"], sim["braces"]
    push = [0.0] * n
    sim["t"] += dt
    t = sim["t"]
    g = GRAVITY * dt * dt
    damp = DAMPING

    for i in range(n):
        ix = i * 3
        x, y, z = pos[ix], pos[ix + 1], pos[ix + 2]
        vx = (x - prev[ix]) * damp
        vy = (y - prev[ix + 1]) * damp
        vz = (z - prev[ix + 2]) * damp
        prev[ix], prev[ix + 1], prev[ix + 2] = x, y, z
        pos[ix] = x + vx
        pos[ix + 1] = y + vy
        pos[ix + 2] = z + vz - g

    rigid = t < sim["brace_end"]
    keff = [(c["stiff"] + (BEND_RIGID - c["stiff"]) * give_gain(t, c["t0"], c["t1"]))
            if c["t1"] > 0 else c["stiff"] for c in cons]
    kbrace = [BRACE_STIFF * give_gain(t, b["t0"], b["t1"]) for b in braces] if rigid else []

    floor_min = sim["floor_z"] + NODE_RADIUS
    iters = ITERATIONS_RIGID if rigid else ITERATIONS
    for _ in range(iters):
        for ci, c in enumerate(cons):
            ax, bx = c["a"] * 3, c["b"] * 3
            dx = pos[ax] - pos[bx]
            dy = pos[ax + 1] - pos[bx + 1]
            dz = pos[ax + 2] - pos[bx + 2]
            ln = math.sqrt(dx * dx + dy * dy + dz * dz) or 1e-9
            k = ((ln - c["rest"]) / ln) * 0.5 * keff[ci]
            pos[ax] -= dx * k
            pos[ax + 1] -= dy * k
            pos[ax + 2] -= dz * k
            pos[bx] += dx * k
            pos[bx + 1] += dy * k
            pos[bx + 2] += dz * k
        if rigid:
            for bi, b in enumerate(braces):
                kb = kbrace[bi]
                if kb <= 0:
                    continue
                ax, bx = b["a"] * 3, b["b"] * 3
                dx = pos[ax] - pos[bx]
                dy = pos[ax + 1] - pos[bx + 1]
                dz = pos[ax + 2] - pos[bx + 2]
                ln = math.sqrt(dx * dx + dy * dy + dz * dz) or 1e-9
                k = ((ln - b["rest"]) / ln) * 0.5 * kb
                pos[ax] -= dx * k
                pos[ax + 1] -= dy * k
                pos[ax + 2] -= dz * k
                pos[bx] += dx * k
                pos[bx + 1] += dy * k
                pos[bx + 2] += dz * k
        for i in range(n):
            iz = i * 3 + 2
            if pos[iz] < floor_min:
                push[i] += floor_min - pos[iz]
                pos[iz] = floor_min

    # contact: friction + (seeded) restitution, penetration-depth corrected
    bounce = sim["bounce"]
    for i in range(n):
        ix = i * 3
        if push[i] <= 0 and pos[ix + 2] > floor_min + 1e-6:
            continue
        prev[ix] = pos[ix] - (pos[ix] - prev[ix]) * FLOOR_FRICTION
        prev[ix + 1] = pos[ix + 1] - (pos[ix + 1] - prev[ix + 1]) * FLOOR_FRICTION
        vz = pos[ix + 2] - prev[ix + 2] - push[i]
        prev[ix + 2] = pos[ix + 2] - (-vz * bounce if vz < 0 else vz)

    max_step = MAX_SPEED * dt
    max_up = MAX_UP_SPEED * dt
    for i in range(n):
        ix = i * 3
        vx = pos[ix] - prev[ix]
        vy = pos[ix + 1] - prev[ix + 1]
        vz = pos[ix + 2] - prev[ix + 2]
        if vz > max_up:
            vz = max_up
        sp = math.sqrt(vx * vx + vy * vy + vz * vz)
        if sp > max_step:
            s = max_step / sp
            vx, vy, vz = vx * s, vy * s, vz * s
        prev[ix] = pos[ix] - vx
        prev[ix + 1] = pos[ix + 1] - vy
        prev[ix + 2] = pos[ix + 2] - vz
        for k in range(3):
            if not math.isfinite(pos[ix + k]):
                pos[ix + k] = prev[ix + k] if math.isfinite(prev[ix + k]) else 0.0
            if not math.isfinite(prev[ix + k]):
                prev[ix + k] = pos[ix + k]


def derive_quats(sim_pos, parent, bone_child, rest_dir, q0):
    """applyRagdoll's orientation pass: bone swing composed onto the rest quat."""
    n = len(parent)
    swing = [None] * n
    for i in range(n):
        d0 = rest_dir[i]
        c = bone_child[i]
        if d0 is None or c < 0:
            continue
        b = (sim_pos[c * 3] - sim_pos[i * 3],
             sim_pos[c * 3 + 1] - sim_pos[i * 3 + 1],
             sim_pos[c * 3 + 2] - sim_pos[i * 3 + 2])
        l = math.sqrt(b[0] ** 2 + b[1] ** 2 + b[2] ** 2)
        if l <= 1e-4:
            continue
        swing[i] = quat_from_unit_vectors(d0, (b[0] / l, b[1] / l, b[2] / l))
    out = []
    for i in range(n):
        s = swing[i]
        if s is None:
            p = parent[i]
            if valid_parent(p, n) and swing[p] is not None:
                s = swing[p]
        out.append(qnorm(qmul(s, q0[i])) if s is not None else qnorm(q0[i]))
    return out


# ------------------------------------------------------------------ the bake

def load_species(portal_path):
    d = datlib.Dat(portal_path)
    setup = datlib.parse_setup(d.get(SPECIES["setup"]))
    death = M.parse_animation(d.get(SPECIES["death_anim"]))
    if death["numparts"] != len(setup["parts"]):
        raise SystemExit("death anim numparts %d != setup parts %d"
                         % (death["numparts"], len(setup["parts"])))
    return d, setup, death


def _pose_from_frame(frame):
    pos = []
    quats = []
    for (o, q) in frame["parts"]:
        pos += [o[0], o[1], o[2]]
        quats.append(q)
    return pos, quats


def _rest_dirs(pos, parent):
    bone_child = build_bone_children(parent, pos)
    n = len(parent)
    rest = [None] * n
    for i in range(n):
        c = bone_child[i]
        if c < 0:
            continue
        b = (pos[c * 3] - pos[i * 3], pos[c * 3 + 1] - pos[i * 3 + 1],
             pos[c * 3 + 2] - pos[i * 3 + 2])
        l = math.sqrt(b[0] ** 2 + b[1] ** 2 + b[2] ** 2)
        if l > 1e-4:
            rest[i] = (b[0] / l, b[1] / l, b[2] / l)
    return bone_child, rest


def simulate(parent, start_pos, start_quats, frames, seed, direction, topple,
             twist, give, impulse=IMPULSE, blend_to=None, blend_from=0):
    """Run the sim and return `frames` sampled poses [(pos[], quats[]), ...].

    `blend_to` is an optional flat target position array -- the shared sprawl.
    From frame `blend_from` on, each frame's PARTICLE POSITIONS are crossfaded
    into the target with a smoothstep weight that reaches 1 on the last frame,
    and the orientations are then derived from the crossfaded positions.

    Two things this gets right that the obvious implementations do not:

    * The crossfade is KINEMATIC (applied to the sampled frames), not a force
      inside the sim.  An in-sim magnet reaches equilibrium against the distance
      constraints at a large residual -- distance constraints are indifferent to
      where the body IS, so they happily hold the fall's own configuration and
      cancel most of the pull; measured residual stalled at ~0.5 model units and
      then snapped at the pin frame.
    * Orientations are re-derived from the blended positions rather than slerped
      independently to the sprawl's quats.  A part that ends the fall ~180 deg
      from its sprawl orientation (measured: 179.1 deg on the Drudge's left
      hand) turns an independent quat blend into a visible spin; deriving from
      positions keeps orientation a pure function of the pose that is on screen.
    """
    bone_child, rest_dir = _rest_dirs(start_pos, parent)
    dt = 1.0 / (FPS * SUBSTEPS)
    sim = init_sim(parent, start_pos, seed, direction, topple, twist, give, dt,
                   impulse_speed=impulse)
    n = len(parent)
    poses = []
    for _fi in range(frames):
        for _si in range(SUBSTEPS):
            step_sim(sim, dt)
        poses.append(list(sim["pos"]))
    if blend_to is not None:
        span = max(1, frames - blend_from)
        for fi in range(blend_from, frames):
            w = smoothstep((fi - blend_from + 1) / float(span))
            p = poses[fi]
            poses[fi] = [p[j] + (blend_to[j] - p[j]) * w for j in range(n * 3)]
    return [(p, derive_quats(p, parent, bone_child, rest_dir, start_quats))
            for p in poses]


def sign_continuous(quats_by_frame):
    """Flip each frame's quats to the hemisphere of the previous frame."""
    for fi in range(1, len(quats_by_frame)):
        prev = quats_by_frame[fi - 1]
        cur = quats_by_frame[fi]
        for i in range(len(cur)):
            if sum(a * b for a, b in zip(prev[i], cur[i])) < 0.0:
                cur[i] = tuple(-c for c in cur[i])
    return quats_by_frame


def encode_anim(did, numparts, frames):
    """frames = [(pos_flat, quats)]  ->  raw 0x03 record bytes (no PosFrames)."""
    a = dict(id=did, flags=0, numparts=numparts, numframes=len(frames),
             posframes=[], frames=[])
    for pos, quats in frames:
        parts = []
        for i in range(numparts):
            parts.append(((pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]), quats[i]))
        a["frames"].append(dict(parts=parts, hooks=[]))
    return M.encode_animation(a), a


def cmd_bake(args):
    os.makedirs(args.out, exist_ok=True)
    d, setup, death = load_species(BASE_PORTAL)
    parent = setup["parent"]
    n = len(setup["parts"])

    # start pose: the frame the shared impact beat ends on (beat plays retail
    # frames 0..BEAT_FRAMES-1, so the fall continues from BEAT_FRAMES).
    start_pos, start_quats = _pose_from_frame(death["frames"][BEAT_FRAMES])

    # ---- the SHARED sprawl -------------------------------------------------
    # A 5th sim from the SAME start pose and the SAME constraint rest lengths as
    # the four falls, given a mild neutral-direction topple and 3 s to settle.
    # Sharing the basis is what makes the falls' position-convergence also
    # converge their orientations (see simulate()).
    sprawl_run = simulate(parent, start_pos, start_quats, SPRAWL_SETTLE_FRAMES,
                          SPRAWL_SEED, SPRAWL_DIR, SPRAWL_TOPPLE, 0.0, 0.0)
    sprawl_pose = sprawl_run[-1]

    variants = []
    for vi, v in enumerate(VARIANTS):
        run = simulate(parent, start_pos, start_quats, FALL_FRAMES, v["seed"],
                       v["dir"], v["topple"], v["twist"], v["give"],
                       blend_to=sprawl_pose[0],
                       blend_from=FALL_FRAMES - BLEND_FRAMES)
        sign_continuous([q for _p, q in run])
        variants.append((v, run))

    # ---- encode ------------------------------------------------------------
    records = {}
    sprawl_frames = [(sprawl_pose[0], list(sprawl_pose[1]))]
    raw, parsed = encode_anim(SPRAWL_DID, n, sprawl_frames)
    records[SPRAWL_DID] = raw
    metrics = dict(sprawl=_metrics(sprawl_frames, parent, start_pos))

    for i, (v, run) in enumerate(variants):
        did = FALL_DIDS[i]
        raw, parsed = encode_anim(did, n, run)
        records[did] = raw
        metrics["0x%08X" % did] = _metrics(run, parent, start_pos)
        metrics["0x%08X" % did]["label"] = v["label"]
        metrics["0x%08X" % did]["cmd"] = "%s 0x%08X" % (v["cmd"][0], v["cmd"][1])

    for did, raw in records.items():
        p = os.path.join(args.out, "anim_%08X.bin" % did)
        open(p, "wb").write(raw)
        # self-verify: python re-parse of the exact bytes we will land
        chk = M.parse_animation(raw)
        assert chk["id"] == did and chk["numparts"] == n and chk["_tail"] == 0, did
        assert chk["flags"] == 0 and not chk["posframes"]
        assert all(len(f["hooks"]) == 0 for f in chk["frames"])
        assert M.encode_animation(chk) == raw

    meta = dict(species=SPECIES, sprawl_did="0x%08X" % SPRAWL_DID,
                fall_dids=["0x%08X" % x for x in FALL_DIDS], fps=FPS,
                numparts=n, fall_frames=FALL_FRAMES, beat_frames=BEAT_FRAMES,
                blend_frames=BLEND_FRAMES, substeps=SUBSTEPS,
                retail_death_anim="0x%08X" % SPECIES["death_anim"],
                retail_death_frames=death["numframes"], metrics=metrics)
    json.dump(meta, open(os.path.join(args.out, "bake.json"), "w"), indent=2)
    print(json.dumps(metrics, indent=2))
    print("wrote %d records to %s" % (len(records), args.out))


def _metrics(frames, parent, ref_pos):
    """Sanity metrics used as the offline PASS gate for a baked variant.

    `maxRigidStretch` is measured against the SIM's own rest lengths (the stiff
    bone + weld links taken from `ref_pos`), which is the real detachment
    metric.  The loose grandparent "bend" links are excluded -- retail's own
    authored death animation stretches some parent links by 45 % (part origins
    are absolute, the artist moves them freely), so a fixed-reference stretch
    number over every link is not a defect signal.
    """
    n = len(parent)
    rest = {}
    for c in build_constraints(parent, ref_pos):
        if c["kind"] in ("bone", "weld"):
            rest[(c["a"], c["b"])] = _dist(ref_pos, c["a"], c["b"])
    max_qerr = 0.0
    min_dot = 1.0
    max_dpos = max_dang = 0.0
    at_pos = at_ang = at_str = -1
    min_z = 1e9
    worst = 1.0
    for fi, (pos, quats) in enumerate(frames):
        for i in range(n):
            q = quats[i]
            max_qerr = max(max_qerr, abs(math.sqrt(sum(c * c for c in q)) - 1.0))
            min_z = min(min_z, pos[i * 3 + 2])
        for (i, p), r in rest.items():
            if r > 1e-6:
                s = abs(_dist(pos, i, p) / r - 1.0) + 1.0
                if s > worst:
                    worst, at_str = s, fi
        if fi:
            ppos, pquats = frames[fi - 1]
            for i in range(n):
                dp = _dist_ab(pos, ppos, i)
                if dp > max_dpos:
                    max_dpos, at_pos = dp, fi
                sd = sum(a * b for a, b in zip(quats[i], pquats[i]))
                min_dot = min(min_dot, sd)
                da = 2.0 * math.degrees(math.acos(min(1.0, abs(sd))))
                if da > max_dang:
                    max_dang, at_ang = da, fi
    return dict(frames=len(frames), maxQuatNormErr=max_qerr,
                minFrameToFrameDot=min_dot,
                maxFrameDeltaPos=max_dpos, maxFrameDeltaPosAtFrame=at_pos,
                maxFrameDeltaDeg=max_dang, maxFrameDeltaDegAtFrame=at_ang,
                minZ=min_z,
                maxRigidStretch=worst, maxRigidStretchAtFrame=at_str)


def _dist_ab(a, b, i):
    return math.sqrt(sum((a[i * 3 + k] - b[i * 3 + k]) ** 2 for k in range(3)))


# ------------------------------------------------------------------- mtable

def _f32(x):
    return struct.unpack("<f", struct.pack("<f", x))[0]


def _ace_len_f32(anims, nf):
    """MotionTable.GetAnimationLength summed the way ACE does it: float32."""
    total = _f32(0.0)
    for a in anims:
        total = _f32(total + _f32(M.anim_length(a, nf)))
    return total


def cmd_mtable(args):
    d = datlib.Dat(BASE_PORTAL)
    raw = d.get(SPECIES["mtable"])
    ok, mt = M.roundtrip_motiontable(raw)
    if not ok:
        raise SystemExit("ROUNDTRIP GATE FAILED on 0x%08X -- refusing to edit"
                         % SPECIES["mtable"])
    print("roundtrip gate: PASS (%d bytes, zero-edit re-encode byte-identical)" % len(raw))

    meta = json.load(open(os.path.join(args.out, "bake.json")))
    numframes = {}

    def nf(aid):
        if aid in numframes:
            return numframes[aid]
        if aid == 0:
            numframes[aid] = 0            # ACE: missing id -> default Animation
            return 0
        rec = d.get(aid)
        if rec is None:
            p = os.path.join(args.out, "anim_%08X.bin" % aid)
            rec = open(p, "rb").read() if os.path.exists(p) else None
        numframes[aid] = struct.unpack_from("<I", rec, 12)[0] if rec else 0
        return numframes[aid]

    NC = M.NONCOMBAT
    ready_key = M.cyc_key(NC, M.READY)
    dead_key = M.cyc_key(NC, M.DEAD)

    retail_link = mt["links"][ready_key][M.DEAD]
    retail_len = sum(M.anim_length(a, nf) for a in retail_link["anims"])
    print("retail Ready->Dead length = %.9f s  (%r)" % (retail_len, retail_link["anims"]))

    # ---- rebuild Ready->Dead: impact beat + phantom spacer -----------------
    beat = dict(anim=SPECIES["death_anim"], low=0, high=BEAT_FRAMES - 1, fps=FPS)
    beat_len = M.anim_length(beat, nf)
    # spacer: AnimId 0 => ACE reads a default (NumFrames 0) Animation and counts
    # (0 - LowFrame)/Framerate seconds; the client drops the node outright
    # (set_animation_id(0) -> anim==0 -> has_anim() false, acclient.c:341085/341010).
    spacer_frames = int(round((retail_len - beat_len) * FPS))
    spacer = dict(anim=0, low=-spacer_frames, high=-1, fps=FPS)
    new_len = beat_len + M.anim_length(spacer, nf)
    print("new    Ready->Dead length = %.9f s  (beat %d frames + spacer %d frames)"
          % (new_len, BEAT_FRAMES, spacer_frames))
    # ACE accumulates the length in float32 (`float length; length += n/fps`), so
    # the equality gate has to be run in float32 too, not in python doubles.
    r32 = _ace_len_f32(retail_link["anims"], nf)
    n32 = _ace_len_f32([beat, spacer], nf)
    same = struct.pack("<f", r32) == struct.pack("<f", n32)
    print("  ACE float32: retail %.9f (%s) new %.9f (%s) -> BIT-IDENTICAL: %s"
          % (r32, struct.pack("<f", r32).hex(), n32, struct.pack("<f", n32).hex(), same))
    if not same:
        raise SystemExit("Dead length is not bit-identical to retail -- refusing")
    delta = new_len - retail_len
    print("  delta = %.12g s  (%.6g frames at %g fps)" % (delta, delta * FPS, FPS))

    assert spacer["anim"] == 0, "negative frames are only safe with AnimId 0"
    assert beat["low"] >= 0 and 0 <= beat["high"] < nf(SPECIES["death_anim"])

    new_dead = dict(bitfield=retail_link["bitfield"], flags=retail_link["flags"],
                    anims=[beat, spacer])
    for k in list(mt["links"]):
        if M.DEAD in mt["links"][k]:
            mt["links"][k][M.DEAD] = new_dead

    # ---- Dead cycle := the shared sprawl hold ------------------------------
    # Replaced under EVERY stance that has one (the corpse is pinned
    # NonCombat/Dead by Corpse.cs, but a creature killed mid-combat-stance
    # would otherwise hold the retail pose), mirroring the Ready->Dead edit.
    # low=0/high=-1 is strictly in range for the 1-frame sprawl; retail's own
    # idiom here is low == NumFrames, which only works because the client
    # clamps it in AnimSequenceNode::set_animation_id (acclient.c:341085).
    sprawl_nf = nf(SPRAWL_DID)
    assert sprawl_nf >= 1
    dead_cycle_keys = [k for k in mt["cycles"] if (k & 0xFFFF) == (M.DEAD & 0xFFFF)]
    for k in dead_cycle_keys:
        old_cycle = mt["cycles"][k]
        mt["cycles"][k] = dict(
            bitfield=old_cycle["bitfield"], flags=old_cycle["flags"],
            anims=[dict(anim=SPRAWL_DID, low=0, high=-1, fps=0.0)])
        print("Dead cycle %08X: %r -> sprawl 0x%08X (%d frame, fps 0 = hold)"
              % (k, old_cycle["anims"], SPRAWL_DID, sprawl_nf))

    # ---- variants: Links[NonCombat|Dead][cmd] + Cycles[NonCombat|cmd] ------
    if dead_key not in mt["links"]:
        mt["links"][dead_key] = {}
    for i, v in enumerate(VARIANTS):
        name, cmd = v["cmd"]
        assert (cmd & 0xFFFF) < 408, "%s low16 %d >= 408" % (name, cmd & 0xFFFF)
        did = FALL_DIDS[i]
        fall_nf = nf(did)
        fall = dict(anim=did, low=0, high=-1, fps=FPS)
        assert fall["low"] >= 0 and fall_nf > 0
        mt["links"][dead_key][cmd] = dict(bitfield=0, flags=0, anims=[fall])
        mt["cycles"][M.cyc_key(NC, cmd)] = dict(
            bitfield=0, flags=0,
            anims=[dict(anim=SPRAWL_DID, low=0, high=-1, fps=0.0)])
        vlen = M.anim_length(fall, nf)
        print("  %-12s 0x%08X -> fall 0x%08X (%d frames, %.4f s) + sprawl cycle"
              % (name, cmd, did, fall_nf, vlen))
        if beat_len + vlen > retail_len + 1e-6:
            raise SystemExit("variant %s overruns the retail Dead length" % name)

    out_raw = M.encode_motiontable(mt)
    p = os.path.join(args.out, "mtable_%08X.bin" % SPECIES["mtable"])
    open(p, "wb").write(out_raw)
    # re-parse the exact bytes we will land
    ok2, mt2 = M.roundtrip_motiontable(out_raw)
    assert ok2 and mt2["_tail"] == 0
    assert mt2["cycles"][dead_key]["anims"][0]["anim"] == SPRAWL_DID
    for i, v in enumerate(VARIANTS):
        cmd = v["cmd"][1]
        assert mt2["links"][dead_key][cmd]["anims"][0]["anim"] == FALL_DIDS[i]
        assert mt2["cycles"][M.cyc_key(NC, cmd)]["anims"][0]["anim"] == SPRAWL_DID
    chk_len = sum(M.anim_length(a, nf) for a in mt2["links"][ready_key][M.DEAD]["anims"])
    print("re-parsed new mtable: Ready->Dead = %.9f s (retail %.9f s), %d bytes "
          "(base %d)" % (chk_len, retail_len, len(out_raw), len(raw)))
    json.dump(dict(retail_dead_len=retail_len, new_dead_len=chk_len,
                   delta=chk_len - retail_len, beat_frames=BEAT_FRAMES,
                   spacer_frames=spacer_frames, bytes=len(out_raw),
                   base_bytes=len(raw)),
              open(os.path.join(args.out, "mtable.json"), "w"), indent=2)


# ---------------------------------------------------------------------- sql

def cmd_sql(args):
    wcid = SPECIES["wcid"]
    probs = [0.25, 0.5, 0.75, 1.0]
    tag = "ragdoll-deaths pilot (drudge, wcid %d)" % wcid
    ins = ["-- %s\n-- ACE GetEmoteSet: rng=Next(0,1) in [0,1); keeps rows with"
           "\n-- Probability > rng, orders ASCENDING, takes the first.  So the"
           "\n-- ladder below gives each variant exactly 25%%, and the 1.0 row"
           "\n-- guarantees one always fires.\n" % tag,
           "START TRANSACTION;"]
    roll = ["-- rollback for %s\nSTART TRANSACTION;" % tag,
            "DELETE ea FROM weenie_properties_emote_action ea"
            " JOIN weenie_properties_emote e ON e.id = ea.emote_Id"
            " WHERE e.object_Id = %d AND e.category = 3;" % wcid,
            "DELETE FROM weenie_properties_emote WHERE object_Id = %d AND category = 3;"
            % wcid,
            "COMMIT;"]
    for i, v in enumerate(VARIANTS):
        name, cmd = v["cmd"]
        ins.append(
            "\n-- variant %d: %s -> %s (0x%08X), fall anim 0x%08X\n"
            "INSERT INTO weenie_properties_emote"
            " (object_Id, category, probability, style, substyle)\n"
            "VALUES (%d, 3, %s, %d, %d);\n"
            "SET @e := LAST_INSERT_ID();\n"
            "INSERT INTO weenie_properties_emote_action"
            " (emote_Id, `order`, type, delay, extent, motion)\n"
            "VALUES (@e, 0, 5, 0, 1, %d);"
            % (i + 1, v["label"], name, cmd, FALL_DIDS[i],
               wcid, probs[i], M.NONCOMBAT, M.DEAD, cmd))
    ins.append("\nCOMMIT;")
    os.makedirs(args.out, exist_ok=True)
    open(os.path.join(args.out, "ragdoll_emotes.sql"), "w").write("\n".join(ins) + "\n")
    open(os.path.join(args.out, "ragdoll_emotes_rollback.sql"), "w").write(
        "\n".join(roll) + "\n")
    print("wrote ragdoll_emotes.sql + ragdoll_emotes_rollback.sql to", args.out)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("cmd", choices=["bake", "mtable", "sql", "all"])
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    if args.cmd in ("bake", "all"):
        cmd_bake(args)
    if args.cmd in ("mtable", "all"):
        cmd_mtable(args)
    if args.cmd in ("sql", "all"):
        cmd_sql(args)


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Bake per-archetype skeleton snapshots for the z-z patcher ragdoll preview.

Reuses tools/dat-patch/{datlib,motionlib} + ragdoll_bake's pose extraction — NO new DAT
parsing, and the launcher NEVER reads a DAT at runtime. Emits AcmeLauncher/preview_skeletons.json
(embedded resource): per body { name, archetype, setupDid, parent[], startPos[] (n*3),
startQuats[] (n*4 w,x,y,z) } — the model-space pose at the retail death-anim beat frame,
exactly what RagdollSim seeds from (ragdoll_bake.py:_pose_from_frame @ BEAT_FRAMES).

Regenerate when a body's Setup/death anim changes:
  python3 AcmeLauncher/tools/gen_preview_skeletons.py [portal.dat]
"""
import sys, os, json
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "tools", "dat-patch"))
import datlib
import motionlib as M

BEAT = 3  # ragdoll_bake.BEAT_FRAMES

# Bodies to bake, one per animating archetype (census of ragdoll_profiles.json; props never
# animate). death = the retail MotionTable Links[(NonCombat<<16)|Ready][Dead] anim, resolved
# via LSD weenie didStats (Setup=1 -> MTable=2) and verified numparts==setup parts
# (2026-08-24 session; K'nath's Dead link lives under style key 0x003C0003 instead).
BODIES = [
    dict(name="Drudge",      archetype="biped",     setup=0x020007DD, death=0x030000EF),
    dict(name="Reedshark",   archetype="quadruped", setup=0x02000039, death=0x030001C0),
    dict(name="Olthoi",      archetype="arthropod", setup=0x02000F95, death=0x0300098E),  # GaitMotion's TargetSetupDid
    dict(name="Gromnie",     archetype="avian",     setup=0x02000037, death=0x03000142),
    dict(name="Olthoi Grub", archetype="serpent",   setup=0x020004D4, death=0x03000739),
    dict(name="Wisp",        archetype="floater",   setup=0x02000599, death=0x03000613),
    dict(name="K'nath",      archetype="blob",      setup=0x020004AA, death=0x03000612),
]

PROFILES = os.path.join(HERE, "..", "..", "AcmeRagdoll", "ragdoll_profiles.json")

def profile_arrays(setup_did, n):
    """Dense per-part looseness/role/ground from the shipped profile, with the plugin's own
    sentinel convention (RagdollProfiles.NoWeight = -1 -> 'use the structural heuristic')."""
    profs = json.load(open(PROFILES))["profiles"]
    p = profs.get("0x%08X" % setup_did)
    loose = [-1.0] * n
    roles = [""] * n
    ground = [False] * n
    if p:
        for part in p.get("parts", []):
            i = part.get("i", -1)
            if 0 <= i < n:
                if "w" in part: loose[i] = part["w"]
                if "role" in part: roles[i] = part["role"]
                if "ground" in part: ground[i] = bool(part["ground"])
    return (p["archetype"] if p else None), loose, roles, ground

def pose_from_frame(frame):
    pos, quats = [], []
    for (o, q) in frame["parts"]:
        pos += [o[0], o[1], o[2]]
        quats += [q[0], q[1], q[2], q[3]]
    return pos, quats

def bake(portal):
    d = datlib.Dat(portal)
    out = []
    for b in BODIES:
        setup = datlib.parse_setup(d.get(b["setup"]))
        death = M.parse_animation(d.get(b["death"]))
        n = len(setup["parts"])
        if death["numparts"] != n:
            raise SystemExit("%s: death numparts %d != setup parts %d" % (b["name"], death["numparts"], n))
        frame = death["frames"][BEAT] if len(death["frames"]) > BEAT else death["frames"][-1]
        pos, quats = pose_from_frame(frame)
        parent = setup["parent"]
        prof_arch, loose, roles, ground = profile_arrays(b["setup"], n)
        if prof_arch and prof_arch != b["archetype"]:
            raise SystemExit("%s: profile archetype %r != BODIES %r" % (b["name"], prof_arch, b["archetype"]))
        out.append(dict(name=b["name"], archetype=b["archetype"],
                        setupDid=b["setup"], n=n, parent=parent,
                        startPos=pos, startQuats=quats,
                        looseness=loose, roles=roles, ground=ground))
        # sanity: settle Z should drop over the fall (checked in-launcher, but note here)
        zs = [pos[i*3+2] for i in range(n)]
        print("  %-8s parts=%d  z[min..max]=%.3f..%.3f" % (b["name"], n, min(zs), max(zs)))
    return out

def main():
    portal = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/ac_base_dats/client_portal.dat")
    if not os.path.exists(portal):
        raise SystemExit("portal dat not found: " + portal)
    skels = bake(portal)
    dest = os.path.join(HERE, "..", "preview_skeletons.json")
    with open(dest, "w") as f:
        json.dump(dict(bodies=skels), f)
    print("wrote %s (%d bodies)" % (os.path.relpath(dest), len(skels)))

if __name__ == "__main__":
    main()

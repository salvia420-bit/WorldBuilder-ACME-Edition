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

# Bodies to bake. Add archetypes here as their Setup + death-anim DIDs are confirmed.
# (biped=Drudge is the baker's proven pilot; others extend the same way.)
BODIES = [
    dict(name="Drudge",  archetype="biped",     setup=0x020007DD, death=0x030000EF),
    # dict(name="Olthoi", archetype="arthropod", setup=0x02000F95, death=0x........),
]

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
        out.append(dict(name=b["name"], archetype=b["archetype"],
                        setupDid=b["setup"], n=n, parent=parent,
                        startPos=pos, startQuats=quats))
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

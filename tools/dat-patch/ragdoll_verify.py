"""Structural diff base-mtable vs new-mtable: prove the edit is exactly the
five intended changes and nothing else."""
import sys, json
sys.path.insert(0, "/home/wbterminal/WorldBuilder-ACME-Edition/tools/dat-patch")
import datlib, motionlib as M, ragdoll_bake as R

OUT = "/mnt/wbterminal2/dat-patch-ragdoll/bake"
d = datlib.Dat(R.BASE_PORTAL)
base = M.parse_motiontable(d.get(R.SPECIES["mtable"]))
new = M.parse_motiontable(open(OUT + "/mtable_%08X.bin" % R.SPECIES["mtable"], "rb").read())

fails = []
def chk(cond, msg):
    print(("PASS  " if cond else "FAIL  ") + msg)
    if not cond:
        fails.append(msg)

chk(base["id"] == new["id"] == R.SPECIES["mtable"], "id unchanged")
chk(base["default_style"] == new["default_style"], "DefaultStyle unchanged")
chk(base["style_defaults"] == new["style_defaults"], "StyleDefaults unchanged")
chk(base["modifiers"] == new["modifiers"], "Modifiers byte-equal")

NC = M.NONCOMBAT
dead_key = M.cyc_key(NC, M.DEAD)
variant_cycle_keys = {M.cyc_key(NC, c) for _n, c in R.VARIANT_CMDS}

changed_cycles = {k for k in set(base["cycles"]) | set(new["cycles"])
                  if base["cycles"].get(k) != new["cycles"].get(k)}
dead_cycle_keys = {k for k in base["cycles"] if (k & 0xFFFF) == (M.DEAD & 0xFFFF)}
chk(changed_cycles == dead_cycle_keys | variant_cycle_keys,
    "cycles changed == %d Dead holds + 4 variants  (got %s)"
    % (len(dead_cycle_keys), sorted("%08X" % k for k in changed_cycles)))
chk(set(new["cycles"]) - set(base["cycles"]) == variant_cycle_keys,
    "only the 4 variant cycles are NEW")

dead_links = {k for k in base["links"] if M.DEAD in base["links"][k]}
changed_links = []
for k in set(base["links"]) | set(new["links"]):
    b, n = base["links"].get(k, {}), new["links"].get(k, {})
    for kk in set(b) | set(n):
        if b.get(kk) != n.get(kk):
            changed_links.append((k, kk))
expect = [(k, M.DEAD) for k in dead_links] + [(dead_key, c) for _n, c in R.VARIANT_CMDS]
chk(sorted(changed_links) == sorted(expect),
    "links changed == Ready->Dead x%d + Dead->variant x4 (got %s)"
    % (len(dead_links), sorted("%08X/%08X" % t for t in changed_links)))

# lengths
numframes = {}
def nf(aid):
    if aid == 0:
        return 0
    if aid not in numframes:
        rec = d.get(aid)
        if rec is None:
            rec = open(OUT + "/anim_%08X.bin" % aid, "rb").read()
        import struct
        numframes[aid] = struct.unpack_from("<I", rec, 12)[0]
    return numframes[aid]

ready = M.cyc_key(NC, M.READY)
rl = R._ace_len_f32(base["links"][ready][M.DEAD]["anims"], nf)
nl = R._ace_len_f32(new["links"][ready][M.DEAD]["anims"], nf)
import struct
chk(struct.pack("<f", rl) == struct.pack("<f", nl),
    "ACE Dead length bit-identical: retail %.9f vs new %.9f" % (rl, nl))

# frame-range safety
bad = []
for name, dct in (("cycles", new["cycles"]), ):
    for k, md in dct.items():
        for a in md["anims"]:
            if a["anim"] == 0:
                continue
            if a["low"] < 0 or a["low"] >= nf(a["anim"]) or (
                    a["high"] != -1 and not 0 <= a["high"] < nf(a["anim"])):
                bad.append((name, "%08X" % k, a))
for k, inner in new["links"].items():
    for kk, md in inner.items():
        for a in md["anims"]:
            if a["anim"] == 0:
                continue
            if a["low"] < 0 or a["low"] >= nf(a["anim"]) or (
                    a["high"] != -1 and not 0 <= a["high"] < nf(a["anim"])):
                bad.append(("links", "%08X/%08X" % (k, kk), a))
base_bad = set()
for k, md in base["cycles"].items():
    for a in md["anims"]:
        if a["anim"] and (a["low"] < 0 or a["low"] >= nf(a["anim"])
                          or (a["high"] != -1 and not 0 <= a["high"] < nf(a["anim"]))):
            base_bad.add(("cycles", "%08X" % k))
new_bad = {(t[0], t[1]) for t in bad}
chk(new_bad <= base_bad,
    "no NEW out-of-range AnimData: new offenders %d, all pre-existing retail "
    "(retail idiom low==NumFrames, clamped by set_animation_id); base had %d"
    % (len(new_bad), len(base_bad)))

neg = []
for dct in (new["cycles"], ):
    for k, md in dct.items():
        for a in md["anims"]:
            if (a["low"] < 0 or a["high"] < -1) and a["anim"] != 0:
                neg.append(a)
for k, inner in new["links"].items():
    for kk, md in inner.items():
        for a in md["anims"]:
            if (a["low"] < 0 or a["high"] < -1) and a["anim"] != 0:
                neg.append(a)
chk(not neg, "negative frames appear ONLY on AnimId==0 spacers")

# variant safety
for name, cmd in R.VARIANT_CMDS:
    chk((cmd & 0xFFFF) < 408, "%s low16 %d < 408 (client command_ids bound)"
        % (name, cmd & 0xFFFF))
    ck = M.cyc_key(NC, cmd)
    chk(ck in new["cycles"] and (new["cycles"][ck]["bitfield"] & 2) == 0,
        "%s cycle exists and bitfield&2 == 0 (is_allowed from Dead)" % name)
    chk(cmd in new["links"][dead_key], "%s link from Dead exists" % name)

print()
print("RESULT:", "ALL PASS" if not fails else "%d FAILURES" % len(fails))
sys.exit(1 if fails else 0)

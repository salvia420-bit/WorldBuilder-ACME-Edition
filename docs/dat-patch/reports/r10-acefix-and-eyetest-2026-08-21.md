# r10 ACE-crash root-cause + fix, and the 4.P4 scale-out sample eye-test (2026-08-21)

Session: resumed from HANDOFF-2026-08-21-r10.md to run "THE ONE PENDING GATE"
(4.P4 scale-out sample eye-test on the 1070). The gate immediately surfaced a
shipping-blocker bug in the r10work portal instead; this report covers the
root-cause, the fix, and the eye-test that then ran on the fixed portal.

## 1. FINDING: `DatRecordInsert --compress` on GfxObjs kills vanilla ACE

**Symptom chain.** Every ACE boot on the r10work portal since the 08:15 swap
died silently seconds after "World is now open" (log ends at the world-open
line; stdout/stderr went to /dev/null). Because the log looked normal, the
handoff attributed last night's buildbox client "Failed to establish
connection / timed out" to box networking — it was actually the dead server.
The 1070 gate reproduced the same timeout dialog twice before the server was
run with captured output, which caught:

```
Unhandled exception. System.NotImplementedException
  at ACE.DatLoader.Entity.CVertexArray.Unpack (CVertexArray.cs:24)
  at ACE.DatLoader.FileTypes.GfxObj.Unpack ...
  at ... EnvCell.init_static_objects -> Landblock.Init (boot-time preload)
```

**Root cause.** Vanilla ACE has NO dat-record decompression — ACE.DatLoader
reads the raw stored bytes; for a zlib-compressed record it parses the zlib
stream as the record and dies (here: garbage vertex-array type ≠ 1 →
NotImplementedException). The scale-out batches landed all **1,209 subdivided
creature-part GfxObjs with `--compress`**; creature-part GfxObjs are reachable
as landblock statics (statues etc.), so ACE hit one during boot-time landblock
init and the server died before any client could connect.

Why nothing caught it earlier:
- **datlib transparently decompresses** (`Dat.get` honors the IsCompressed
  flag), so every readback verify and invariant check was blind to storage
  compression — checks passed on the *inflated* bytes.
- The r9 portal serves fine because its only compressed records are **18,264
  0x06 textures**, which the server never reads. The r10work portal's 1,209
  compressed 0x01s were the first compressed records in ACE's read path.
- The patched kit client (8/8 exe) decompresses fine — this is a SERVER-side
  incompatibility only, invisible to client-side gates.

**The rule (now enforced):** `--compress` is safe ONLY for record types the
server never reads (0x05/0x06 texture family). Never compress GfxObj, Setup,
Environment, or anything else in ACE's physics/world read path.

## 2. The fix (landed)

- `client_portal.r10work-acefix.dat` = r10work portal with all 1,209 records
  re-inserted UNCOMPRESSED (extracted inflated via datlib → DatRecordInsert
  --overwrite; readback verified=1209 mismatch=0). walk_check entries=81,206
  free=26 size=572,314,624 → OK (+11.6 MB vs compressed). Zero compressed 0x01
  records remain; all 1,209 headers re-verified ACE-valid (vtype==1).
  sha256 `f1d6907fb35d74a2a8c2ed289a5e3b37e0e407190da469d86f4e1cde77c3f56c`.
- **ACE boot-proof:** serving the fixed portal, survived well past the crash
  window (prior crashes ≤20 s after world open), accepted the 1070 client
  login, and served the full eye-test session.
- **Guards landed (uncommitted, this session):**
  - `DatRecordInsert` now REFUSES `--compress` for any id outside 0x05/0x06
    (`--force-compress` overrides for client-only dats ACE never serves).
  - `creature_scaleout.py` insert call dropped `--compress`; docstring carries
    the trap.
- **ACE ops trap fixed en route:** the ACE relaunch recipe's FIFO writer died
  with the old session → ACE got stdin EOF → silent exit. The 08:15 "RUNNING"
  state in the handoff was already dead. Relaunched with a session-independent
  `setsid sleep infinity > ~/ace_stdin.fifo` writer. ALSO: "check the log says
  World is now open" is NOT an aliveness check — `ss -ulpn | grep ':900'` is.

## 3. 4.P4 scale-out sample eye-test (1070, real GPU)

Rig: acdtgater10 task (= acdt-watch.ps1, 1200 s lifetime, off-screen + muted,
PrintWindow shots every 20 s + client-native ScreenShots), acdtclick1 char
select, acdtchat PostMessage chat rig; every @command verified server-side in
ACE's audit log before proceeding. Client: kit exe + fixed r10 portal (sha
verified after scp) + world2 highres + r8 cell; ACE serving the identical set.

Cast (all confirmed spawned via ACE audit "has created ..."):
- `@create 7` Drudge Skulker (7/17 subdivided parts) — spawned 10:26:21
- `@create 8` Creeper Mosswart (9/17) — spawned 10:28:42
- `@create 88165` **Mukkir (21/27)** — spawned 10:32:11. Substituted for the
  handoff's `@create 49051` Grievver, which the SERVER refused: wcid 49051 is
  weenie type 71 (CombatPet) on this shard — "You cannot spawn
  ace49051-grievver because it is a CombatPet" (visible in shot43's chat). The
  Mukkir was picked by ranking ALL type-10 shard creatures by subdivided-part
  count against the r10 id set (it and portalbossinfiltration/soft Thuun top
  out at 21-24 of 27-28 parts) — a strictly better sample than the Grievver,
  and its fleshy multi-limb body is exactly the concave-region risk class.

**VERDICT: PASS.**
- Client ran the FULL 1200 s lifetime on the r10 portal (60 frames, no crash,
  no exit) — char select, world entry, three creature spawns, continuous
  rendering on the real GTX 1070.
- Mukkir (frames 43-50, montaged): a continuous idle/motion cycle at melee
  range — every limb stays attached to the thorax through the pose cycle,
  claws articulate, carapace tracks the body sway; no poke-through of the
  buried original shell, no detachment, no inversion, no exploded vertices.
- Drudge Skulker (24-27) and Creeper Mosswart (32-37): multiple distinct poses
  each (idle sway, spear-carry) at melee range, all parts attached, then both
  walked off camera (walk cycle exercised) — clean.
- Caveats, honestly: fixed 3rd-person camera meant partial viewing angles
  (creatures clustered behind the player's head); lighting dark; no confirmed
  mid-attack-swing frame (the Mukkir's raised-limb aggro poses come closest).
  Same bar as the Banderling test, met on a 4×-larger part sample including
  the highest-subdiv-density creature found in the shard DB.

Frames: laptop scratchpad r10-eyetest/final/shot01-60.png (+mukkir-montage);
also on the 1070 at C:\Temp\acdt\.

## 4. State / follow-ups

- The compressed r10work portal is superseded; the acefix portal is the r10
  work portal now. ACE serves it; the 1070 has it in place (sha-verified).
- The defective 927 MB WBT-export portal that was sitting IN PLACE as the
  1070's `client_portal.dat` (not as `.scratch` — the handoff's cleanup note
  was slightly off) was deleted before the first gate attempt.
- `replaceDrawing` obj-import mode (loose end 6) implemented + verified this
  session by agent (12/12 invariants; legacy path byte-identical). NOTE: the
  hoped ~5×→4× byte saving is actually ~2.4 % — the vertex array dominates the
  record and is still carried; the mode's real value is eliminating the
  concave poke-through risk (no buried original shell), not bytes.
- Kit-assembly implication: the r10 kit portal MUST be built from the acefix
  lineage. If a future lane wants compressed 0x01s for client-size reasons it
  needs a separate client-only portal AND a server-side uncompressed portal —
  but DDD equality makes that a non-starter; just ship uncompressed.

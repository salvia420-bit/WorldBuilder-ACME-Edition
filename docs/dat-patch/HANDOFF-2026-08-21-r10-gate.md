# HANDOFF — 2026-08-21 (r10 gate session: ACE-crash blocker found+fixed, 4.P4 sample eye-test PASS)

Continues HANDOFF-2026-08-21-r10.md. The "one pending gate" ran on the 1070 —
and first caught a shipping-blocker: the r10work portal killed vanilla ACE.
Full story: **reports/r10-acefix-and-eyetest-2026-08-21.md** (read it first).
A parallel docs-audit swept every dat-patch doc for gaps; its findings are
folded into the priority list below.

## What happened (compressed)

1. **BLOCKER FOUND+FIXED: compressed GfxObjs kill vanilla ACE.** The scale-out
   landed all 1,209 subdivided parts with `DatRecordInsert --compress`; vanilla
   ACE has NO record decompression and died seconds after "World is now open"
   (NotImplementedException in CVertexArray via landblock-static init). Every
   "ACE is running" claim since the 08:15 portal swap was actually a dead
   server (incl. the buildbox "connection timed out" — not box networking).
   Fixed by re-inserting all 1,209 uncompressed. `client_portal.r10work.dat`
   (572,314,624 B, sha `f1d6907f…`) IS now the fixed portal; the compressed
   original is parked as `.compressed-hold`. Rule now enforced in
   DatRecordInsert itself (refuses --compress outside 0x05/0x06;
   --force-compress for client-only dats) and creature_scaleout.py.
2. **4.P4 sample eye-test PASS** on the 1070 (real GPU, full 1200 s client
   lifetime, 60 frames): Drudge Skulker (7/17 parts), Creeper Mosswart (9/17),
   **Mukkir (21/27** — substituted for Grievver 49051, which is a CombatPet on
   this shard and refuses @create; the Mukkir is the densest-subdivided
   creature in the shard DB). All parts track the skeleton, no poke-through/
   detachment. **4.P4 is now fully gated; r10 is clear for kit assembly** from
   the acefix lineage once lanes accumulate.
3. **`replaceDrawing` obj-import landed** (loose end 6, agent-implemented +
   verified 12/12; legacy path proven byte-identical to pre-change output).
   Honest finding: byte saving is only ~2.4 % (vertex array dominates, still
   carried) — the mode's real value is killing the concave poke-through risk,
   not bytes. JSON arg: `"replaceDrawing": true` (default false).
4. **PREP-envgeo doc corrected**: its step 2 prescribed the banned DRW
   TryDelete path; rewritten to `DatCompact --verify --exclude` reconstruction
   (the r9-gate mechanism). No delete driver is to be written.

## Box / server state

- **ACE (laptop)**: RUNNING (pid in `ss -ulpn | grep :900`), serving
  ace-r9-dats/ = **acefix r10 portal** + world2 highres + r8 cell.
  ⚠ TWO ops traps fixed this session — re-read before touching ACE:
  (a) the FIFO-writer must be session-independent (`setsid nohup sleep
  infinity > ~/ace_stdin.fifo &`) or ACE dies with the session that launched
  it; (b) "World is now open" in the log is NOT an aliveness check — the
  process can be dead right after it; check `ss -ulpn | grep ':900'`.
  Consider keeping stdout captured (this session: scratchpad ace_stdout2.log)
  — /dev/null is why the crash was invisible for 2+ hours.
- **1070**: `D:\ac-dat-test\client_portal.dat` = acefix r10 (sha-verified);
  shipped r9 parked as `.r9-kit`; the defective 927 MB WBT-export portal that
  was sitting IN PLACE as client_portal.dat (handoff said `.scratch` — it
  wasn't) is DELETED. New rig pieces: task `acdtgater10` (1200 s gate),
  task `acdtschat` + `C:\Temp\acdt-schat.ps1` — the WORKING chat injector
  (focus + SendInput, idle-guarded). ⚠ `acdtchat` (PostMessage) does NOT work
  — the client ignores posted keys; it had never actually been run before
  today. ⚠ SendInput resets GetLastInputInfo, so an idle-guard above your own
  send cadence self-blocks (bit us; acdt-schat.ps1 now uses 20 s).
  Eye-test frames kept at C:\Temp\acdt\shot01-60.png.
- **buildbox**: OFF, untouched today.
- **Laptop working tree (integ/all-20260813), UNCOMMITTED — review + commit
  next**: WBT replaceDrawing (3 files), DatRecordInsert guard,
  creature_scaleout.py --compress removal, PREP-envgeo correction, and the two
  new docs (this file + the report). Nothing pushed.

## Priority list (merges the r10 loose ends with the 2026-08-21 docs audit)

1. **Commit the working tree** (above) after review.
2. **Kit assembly prerequisites** (audit findings, release-critical):
   - `/mnt/wbterminal2/ac-eor-patch/` is untracked, single-copy, and
     assemble_kit.sh hard-depends on it → copy patch_client.py + PATCHES.md
     into the repo (or second drive) BEFORE `assemble_kit.sh --tag r10`.
   - r10 kit portal MUST come from the acefix lineage (compressed-hold must
     never ship — ACE dies on it).
   - Re-run `kit-gate.ps1` on the assembled r10 kit (not run since r8); batch
     the two never-run interactive arms (MessageBox presentation, real
     play.bat launch) into that 1070 session.
   - VmSize/F-A ledger was silently dropped from r9 (PLAN said "no lane ships
     without it") → make the r10 kit gate a multi-stop tour with per-stop
     VmSize sampling.
3. **4.P3 env re-cut** — PREP doc now corrected (DatCompact --exclude, no
   deletes); staged recipe otherwise unchanged. Unblocks the 6,236-cluster
   dungeon backlog re-run.
4. **Announce/distribution** (audit): no r9/r10 announce exists (only the r8
   draft); server-ops.md + community-norms.md are pre-HIFI-split and
   contradict the "ship the trio" rule → revise both + re-point the announce
   before any release; 5 owner questions in the draft still open.
5. Small recorded-but-open items (audit §C7-8): 8 blend-ST collapse ruling,
   `fix_degrade_chains.py --check` on the r9 portal, 9-texture micro-lane,
   DRW TryDelete fix upstreaming, roofs veto-vs-clamp owner call, 33 kept
   retail highres records vs DECISIONS #3, MERGE-STATUS staleness (master
   25 behind), buildbox disk 95 %.
6. 4.H4 selective 4096² — still blocked on a true view-distance input.
   Optional icon probe — designed, unrun.
7. Future creature tranches: creature_scaleout.py is now uncompressed-insert
   and can use `replaceDrawing:true`; re-verify the first new batch with both.

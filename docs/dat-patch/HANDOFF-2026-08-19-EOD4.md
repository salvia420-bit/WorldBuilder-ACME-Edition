# HANDOFF — 2026-08-19 EOD4 (r8 kit BUILT + player-facing gates green; DRW delete bug ROOT-CAUSED and FIXED)

Continues HANDOFF-2026-08-19-EOD3.md on the owner's r8 sign-off
("vistested it a lot on the 1070, it's good"). Full detail:
reports/r8-kit-assembly-2026-08-19.md and upstream-drw-btree-delete-fix.md.

## HEADLINE 1 — the r8 kit is assembled, and its two player-facing mechanisms are GATED
`/mnt/wbterminal2/dat-patch-r8/kit/acme-r8/` = r8 portal (530 MiB) + r8 highres
(922 MiB) + cell (331 MiB) + README + manifest + SHA256SUMS + `play.bat` +
`patch-my-client.bat` + `acme-patch-client.ps1`, packaged as `acme-r8.tgz`.
Built by `tools/dat-patch/kit/assemble_kit.sh`, which sha256-verifies every copy,
self-gates the manifest with play.bat's own rule, and refuses to assemble at all
if the patcher's table has drifted from the registry.

## HEADLINE 2 — the kit ships NO client executable; it ships a PATCHER
EOD3's sketch had the FMCAP exe in the kit. That collides with our own
distribution note (community-norms.md: no retail files, no game binary — the
player patches their own install), and r8 is the first tier that truly needs a
patched client. So the delta ships instead, as `acme-patch-client.ps1`:
the 8 shipped patches as signature-located byte edits applied to the player's own
`acclient.exe`, plain readable text, PowerShell 5.1+, refuses on any unknown
build, idempotent, keeps `acclient.exe.acme-orig.bak`.
**Proof it is the same client we gated**: applying the ps1's own table to the
pristine retail exe reproduces the shipping exe byte-for-byte —
sha256 `6c3232ea…` (= md5 `34b68dea…`, the FMCAP/r8-tour exe). The kit's exe
delivery therefore inherits the in-client gates instead of needing new ones.

## GATES THIS SESSION
- **Laptop** `tools/dat-patch/kit/check_ps1_table.py`: table parity vs
  `patch_client.py` (8/8, nothing extra) + artifact parity (byte-identical exe).
  Now a hard precondition inside `assemble_kit.sh`.
- **1070, headless** `tools/dat-patch/kit/kit-gate.ps1`: **14/14 PASS** — patcher
  arms (patch / idempotent re-run / verify both ways / refuse a foreign file,
  backup kept and correct) and play.bat arms (complete → KIT-OK; missing dat,
  short dat, oversized dat, unpatched exe → LOUD-FAIL rc 1 with no launch;
  re-patched → KIT-OK). No client launched, no display touched, box left clean.
- **Real artifacts**: `D:\ac-dat-test` (the live r8 pair + FMCAP exe, 1.87 GB) →
  KIT-OK on the real sizes; LOUD-FAIL with the real 967 MB highres renamed away,
  restored immediately.

## ⚠ TWO DEFECTS IN THE EOD3 play.bat — the gate caught both, both fixed
1. **The wrong-size check never fired**: a caret-escaped `(` inside a nested for
   body mangled the block, so a truncated dat passed as OK. EOD3 had only ever
   gated the missing-file case.
2. **The missing-file case died** with `'.' was unexpected at this time` (rc 255)
   instead of refusing — a `)` inside the expanded message closed the if-block.
Rewritten with a `:checkone` subroutine, `goto`-based flow and no parentheses in
any message. The reasoning is a comment in play.bat so it is not reintroduced.

## HEADLINE 3 — the EOD3 TryDelete finding is now a ROOT CAUSE + a 4-line FIX
`tools/dat-patch/DatDeleteRepro/` reproduces the corruption synthetically (no
retail dats): insert N sparse ids, delete every 8th, assert the survivors. Corrupt
from N=800 up; at N=20,000 → 436 refused deletes, 1 lost record, 1 phantom id,
6,273 records the walk yields but `TryGetFile` cannot find.
Four defects in `DatBTreeReaderWriter`: the left-sibling borrow AND merge both use
the right-hand separator key (off by one); `DeleteKeyFromNode` pulls the successor
out of the LEFT child; `DeleteSuccessor`'s non-leaf path recurses into
`DeletePredecessor`. Patch: `docs/dat-patch/patches/drw-btree-delete-fix.patch`
(branch `acme/fix-btree-delete` in the vendored checkout, which is left on
`master`). After: 36/36 clean across strides/seeds/orders; the library's own
synthetic tests unchanged.
**Why it shipped**: the existing unit test deletes EVERY key ASCENDING at
N ≤ 1000 — the one pattern that doesn't corrupt.
Our lane's no-TryDelete rule stands regardless: the shipped r8 pair was built by
reconstruction and is unaffected.

## NEXT SESSION (in order)
1. **OWNER**: (a) read `ANNOUNCE-r8-DRAFT.md` — the open questions at its foot
   (where to post, hosting for ~1.3 GB, zip alongside tgz, whether to wait for the
   showcase video) are the only things between here and announcing; (b) still open
   from EOD3: git-track `/mnt/wbterminal2/ac-eor-patch/`? It is now
   release-critical — the kit patcher's table is generated from `patch_client.py`
   and gated against it, but the registry itself is untracked.
2. **Not gated yet** (cheap, needs an interactive box session): the MessageBox
   presentation of a loud fail, and one real `play.bat` → client launch from an
   assembled kit. Both are unchanged in shape from gated versions.
3. **9-texture micro-lane** (needs the buildbox Remacri stack; SPOT was preempting
   every 8–40 min) — ids in reports/eyetest-ab-review-2026-08-18.md. Treat as an
   r8.1 respin: rebuild = ours_diff + DatHifiSplit + assemble_kit.sh (~1 h) rather
   than holding r8.
4. **Phase 4 fill** per PLAN (scenery aa+ab first — the 1.44 GiB of freed portal
   runway's first customer), creature-subdiv spike, D5 terrain detail.
5. Send the DRW delete fix upstream (patch + repro + suggested test are ready).

## BOX STATE
- 1070: idle probe 8.9 h and climbing 1:1 (nobody there); only headless file work
  done. `C:\Temp\kitgate\` holds the gate harness and stand-in files;
  `D:\ac-dat-test` gained the new play.bat + patcher (old kept as
  `play.bat.prev-20260819.bak`), dats and exe untouched. Two junk files my first
  (buggy) gate harness wrote into the box's home directory were removed. No
  processes left running.
- buildbox: untouched, powered off, still on SPOT.
- ACE: untouched, still serving ace-r7-dats.

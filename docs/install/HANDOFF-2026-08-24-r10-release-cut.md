# HANDOFF 2026-08-24 (third arc) — the r10 release cut is BUILT; one gate stands

Continues HANDOFF-2026-08-24-preview-complete.md. This arc: full CLI parity for
zzpatcher, the release-completeness audit (which caught the palette blocker the
owner remembered), the dat repair, and the complete twice-reviewed r10 archive.
Commits `42a3da7b..3e9d3eb8`. Owner calls this arc: AcmeRedline SHIPS; announce
drafted for review; r10 is the cut; envgeo recut examined (stays out, eye-test
owed).

## The artifacts (on /mnt/wbterminal2)

- **`acme-r10.tgz` 1,853,165,648 B** sha256 `2ff6463e…d238c34`
- **`acme-r10.zip` 1,853,183,660 B** sha256 `fe26efc5…7f691259`
- Layout: kit at root (r10 trio + 9-patch ps1/py patchers + play.bat/play.sh +
  CLIENT-PATCHES.md + both install guides + appended README + unified
  SHA256SUMS) + `acme-plugins/` (zzpatcher, patched Chorizite runtime,
  4 plugins incl. AcmeRedline, chorizite-patches/, licenses/NOTICES/provenance).
- Trio: portal `1c773046…` (r9 + 1,209 subdiv GfxObj parts − 204 big-head
  reverts = 1,005 at 4×) · highres `b2706d83…` 1,333,604,352 B (the 3,414-record
  palette repair AND 4.H2, first file with both — see
  REPORT-2026-08-25-r10-lineage.md + the r10fixed repallet report) · cell r9b.
- Machinery: `tools/make-release-archive.sh` (wrapper) ←
  `tools/dat-patch/kit/assemble_kit.sh` + `tools/plugin-pack/assemble_plugin_pack.sh`
  (+ `gen_cfg_examples.py`). All fail-loud with verify gates incl. a leak grep
  over shipped text, cfg-example defaults parity, licence invariants.

## What was reviewed (team model held: Fable builds, Opus reviews, orchestrator tests)

- Opus completeness audit over 2 weeks of commits: 6 blockers / 12 should-fix —
  ALL closed (B1 corrupted r9b palettes → r10; B2 the split-brain highres →
  repaired on the right base; B3 lineage doc+kit → written+assembled; B4
  registry backups refreshed; B5 9-patch README; B6 licence set).
- Opus assembly review: 5 blocking (the generated cfg examples were unreadable
  by the plugins' own parsers — sky's 2026-08-23 StripInlineComment fix is now
  ported to Lights+Ragdoll parsers too; the wrapper clobbered the kit README;
  wrong cloudminstep; both guides contradicted the combined layout) — all fixed
  and re-proven end-to-end.
- CLI parity (earlier this arc, `42a3da7b`): every GUI action headless on
  Windows AND Wine, proven on both platforms.

## THE ONE REMAINING GATE before announcing

**The 1070 in-client session** (batched; ~one sitting):
1. Fresh-install loud-fail: unpack the REAL archive on the box, patch a copy of
   the retail exe with the SHIPPED patcher, play.bat/kit checks, world entry on
   the r10 trio (laptop ACE must swap to the trio first — it currently serves
   the 4.H2-less highres; restart per memory/ace-live.md; the 9 stale
   test clients from 13:45 will lose their char-select session — expected).
2. Plugin pack fleet tests from the ARCHIVE's runtime: two-client per-PID log
   separation; full launcher→attach→plugins; `--status` green; AcmeRedline's
   stock-plugin deps (RmlUi/AC) — does it load with only our pack, or must
   stock plugins ride along? (Its manifest declares them; pack ships only ours.)
3. In-world livemotion hits (the SpringMotion refactor's residual gate).
4. Preview eyetests: ragdoll pane (7 bodies/modes) + sky §3.3 vs screenshots +
   FAKE_WINE GUI render; fleet-video for the owner.
5. Second serving window: the envgeo recut pair
   (`/mnt/wbterminal2/dat-patch-envgeo/recut-20260821/export/`) — tour +
   frames/video → owner eyeball ("feet-sink gone, no relief seams"). If passed,
   r11 = recut + creature records re-applied (mechanical, lanes are documented).

Then: `assemble_kit.sh`-filled sizes/shas → the announce placeholders, and the
owner's 6 posting questions (ANNOUNCE-r10-DRAFT.md).

## Traps refreshed this arc
- cmd `dir`/compound schtasks over ssh to the 1070 lie — PowerShell only; run
  `schtasks /run /tn acdtidle` as its own command then read idle.txt.
- rg `-rln` redacts (again); pkill self-match killed an ssh (again).
- The box AcmeInject at C:\Games\Chorizite is NOW current (deployed this
  session) — but D:\ac-dat-test dats are r9-family; after ACE swaps to r10 the
  box needs the archive's dats or logins DDD-boot.
- Chorizite runtime builds clean on Linux (`-p:EnableWindowsTargeting=true`);
  the pack's runtime is a fresh build with byte-proven patches, NOT the old
  bin/ output.

# HANDOFF 2026-08-24 (fourth arc) — the 1070 gate PASSED, a shipped-credential leak found and recut

Continues HANDOFF-2026-08-24-r10-release-cut.md. This arc ran the one remaining
gate (the batched 1070 in-client session), found a release blocker mid-gate
(dev credentials compiled into the shipped injector), fixed + recut via an Opus
agent while the gate continued, and re-validated the recut on the box. Team
model held: orchestrator drove the box, Opus agent did the fix/recut.
Commits `fa9e09e1..3c6a7655` + this handoff. **The announce candidate is now
`/mnt/wbterminal2/release-r10-recut/`** — NOT the original release-r10 archive.

## The blocker (found during gate item 2, fixed, recut, re-proven)

Shipped `AcmeInject.dll` had UTF-16LE-embedded dev defaults
(`AcmeInject/Program.cs` DefClient/DefArgs): `D:\ac-dat-test\acclient.exe` +
`-h <server-ip> -p 9000 -a <account> -v <account> -rodat off`. Running the
shipped injector with no args launched the dev rig path against the dev
tailscale IP with test creds — and appended `-rodat off`, the exact flag the
install guide forbids with the injector. The assembler leak grep only scanned
ASCII text, so .NET UTF-16 string literals sailed through.

Fix (agent, 4 commits, reviewed in its report): defaults deleted — no args +
no `ACMEINJECT_*` env + no `inject.cfg` → usage + **exit 5**; attach modes
unchanged; `--help` + `ACMEINJECT_CFG` added. New `tools/leak_scan.py` (ASCII
+ UTF-16LE, mmap, unit-tested 13pos/9neg) wired fail-loud into ALL THREE
assemblers (plugin-pack had NO leak gate before). That flushed: builds now use
`-p:PathMap` (every assembly embedded `/home/wbterminal/...` in RSDS), plus 3
text leaks (pack NOTICES named /mnt path; sky.cfg.example named buildbox;
INSTALL-WINDOWS §13 named D:\ac-dat-test). zzpatcher pre-bundle inputs (466)
scanned CLEAN — no secrets ever shipped in it. Stale "ACME r8" branding fixed
at source in all 5 kit tools.

**Recut** `/mnt/wbterminal2/release-r10-recut/`:
- `acme-r10.tgz` 1,853,169,421 B sha256 `360afafdc46cdf579dc2f40c70e4224a5d1b24a1c47d9bb9a1601b7d98ed2e17`
- `acme-r10.zip` 1,853,154,176 B sha256 `0f17689d46729c43e99900a532e94f69cccbd2c6223e8280ed7ccf0fc8894a50`
- Dat trio BYTE-IDENTICAL to r10; layout identical (174 files); deep sweep of
  all 175 files zero hits; 14 binaries differ = AcmeInject.dll (the fix) + 13
  proven-benign PathMap/git-SHA stamp deltas (agent string-diffed every one).
- ANNOUNCE-r10-DRAFT placeholders filled from the recut (by hand — the draft's
  claim that assemble_kit.sh fills them is stale prose, left alone).
- Originals untouched at release-r10/ + kit-r10/; intermediates kept at
  kit-r10-recut/ + plugin-pack-r10-recut/.

## Gate results (all on the REAL transferred archive, sha-verified end-to-end)

1. **Fresh-install loud-fail: PASS.** Mock retail install on the box
   (`D:\Temp\acme-r10-test\install` = pristine EoR exe `bca95bbe…` + retail
   support DLLs from D:\ac-dat-test — acclient dies silently without
   Keystone/msvcr70/etc, and client_local_English.dat is required). All 3
   refusal arms fire RC=1 with exact filenames (missing dat / wrong size /
   unpatched exe via `ACME_KIT_CHECK_ONLY=1` + `ACME_KIT_CHECK_SILENT=1`);
   happy path KIT-OK; shipped patcher applied 9/9 to the pristine exe
   (backup kept, PE checksum fixed).
2. **World entry on the r10 trio: PASS.** Laptop ACE swapped to the trio
   (staged sha-verified at `/mnt/wbterminal2/dat-patch-r10/ace-r10-dats/`,
   Config.js DatFilesDirectory updated, `stop-now` via ~/ace_stdin.fifo, log
   `/mnt/wbterminal2/ace-logs/ace_r10_20260824.log`). DDD interrogation:
   `portal 2074 | cell 982 | local 994 | no update required`. In-world render
   screenshotted (VeryHigh, muted, windowed).
3. **Plugin pack fleet: PASS.** From the ARCHIVE runtime: `--attach-all` onto
   a running client; injected LAUNCH bypasses the retail single-instance
   mutex (two clients concurrently); per-PID logs `log-<pid>.txt` both live;
   `zzpatcher --status` green both (`active · 10 hooks · gov · diet`, diet
   freed 263–817MB); `--check-dats`/`--verify-exe`/`--check-prefs` clean.
   **AcmeRedline does NOT load from our pack alone**: clean
   `Dependency RmlUi not found`, other plugins unaffected. Owner decision:
   ship stock RmlUi/AC in the pack, or relax the manifest dep.
4. **Livemotion (the SpringMotion residual): PASS, live-proven.**
   Non-lethal landed hits on a spawned Drudge Skulker → `livemotion HIT`
   lines with full telemetry (dmg%, energy pool, v0 kick, latency ≤31ms);
   kills → full `ragdoll ARM → CORPSE-handoff matched (dist 0.00,
   parentHashMatch=True)` chain; player deaths crumple too (both test chars
   died at least once; ARM fired for 0x50000125 and 0x50000018).
5. **Preview eyetests: captured for owner eyeball** (screenshots taildropped
   to the owner's phone + in session scratchpad): ragdoll pane Drudge
   Auto/Hit(pool bar + knee marker)/Death, Olthoi Walk(GaitMotion)+Death,
   Reedshark, Gromnie, Wisp; sky pane 10:03 clear + 18:06 sunset with cost
   meter; FAKE_WINE GUI renders the full Wine checklist with fix buttons
   pointed at the right install. **Fleet video** (ragdoll death burst,
   1280px 11fps) at `/mnt/wbterminal2/release-r10/r10-gate-fleet-video-ragdoll-death.mp4`,
   taildropped to the owner.
6. **Recut re-validation: PASS.** Recut transferred + sha-verified on box;
   KIT-OK with recut kit files ("ACME kit", no r8); AcmeInject no-args →
   usage + RC=5; `--attach-all` idempotent (2 skipped); explicit
   `--client ... -rodat 1` launch injected, DDD clean, status green,
   **entered world 22:02:29**.

envgeo recut tour (item 5 of the old gate list) stays owed — the second
serving window.

## Findings for the owner (not release-blocking)

- **AsyncLog defeats per-PID logs**: `livemotion HIT` + `ragdoll ARM` lines
  land in legacy `data/logs/log.txt`, not `log-<pid>.txt` — two clients
  interleave. AcmeRagdoll/Lib/AsyncLog.cs path resolution never got the
  per-PID update.
- **K'nath preview renders as a single dot** (17-part skeleton; Wisp-as-dot
  is plausibly real wisp anatomy, K'nath is not). Olthoi Grub never captured
  (dropdown nav); eyeball it manually.
- `zzpatcher --status` needs `--set-chorizite-dir` before it can see a
  non-default runtime's logs (defaults to C:\Games\Chorizite → "no log yet").
- `C:\Temp\acdt\inject.cfg` is still compiled into AcmeInject as the LAST
  config fallback (kept so the 1070 rig works; it's a path, not a secret).
  Owner may order it removed.
- HANDOFF-2026-08-24-zzpatcher.md:39 claims zzpatcher passes `-rodat` — no
  such code exists; stale.

## Traps learned this arc (box driving)

- **Mixed `-rodat` modes can't share dats**: a `-rodat off` client holds the
  dats writable; a second client with `-rodat 1` gets "Can't open the data
  files" and exits. Fleet clients must all use the SAME rodat mode
  (`-rodat 1`, per the guide).
- **Retail client default keybinds** (fresh install, no acclient.keymap):
  combat toggle = BACKTICK (DIK_GRAVE, vk192 sc41), NOT Tab; medium attack =
  END (DIK_END, vk35 sc79 EXTENDED — SendInput needs KEYEVENTF_EXTENDEDKEY);
  select-last-attacker = HOME (vk36 sc71 ext). Char-select ENTER button needs
  a mouse CLICK at ~(347,419) of the 806x629 window — the Enter key does
  nothing there.
- The running ACE binary predates `@createcreature` — use **`@create <wcid>`**
  (owner-confirmed). `@god` one-shots everything (no livemotion HIT — the
  death path preempts it); `@ungod` for non-lethal hit telemetry.
  `@attackable on` needed before mobs engage an admin char.
- Driver kit for the retail client now lives at **D:\Temp** (persistent):
  `acme-r10-chat.ps1` (types a chat line from acme-r10-chat.txt into pid from
  C:\Temp\acdt\pid.txt), `acme-r10-key.ps1` (vk/sc/ext from acme-r10-key.txt),
  `acme-r10-click.ps1` (-X -Y window-relative), `acme-r10-click2x.ps1` (two
  clicks, keeps focus between — REQUIRED for WPF dropdowns: the single-click
  driver's focus-restore closes an open dropdown). Matching schtasks:
  acmer10chat/key/click/click2x/gclick/g2x/shot/burst (+ dietshot/dietburst
  use C:\Temp\acdt\pid.txt). All idle-guarded.
- acclient needs the retail support DLLs + client_local_English.dat next to
  the exe or it exits silently (no dialog, no log) — a kit-only folder is not
  a runnable install by design (the kit patches over a real install).
- rg `-rln` redacted output AGAIN (twice this arc). It is `--replace ln`.
  Never.

## Box/laptop state at handoff

- 1070: ALL acclients killed (0 remain); test zzpatcher instances closed; the
  person's Chrome untouched throughout (idle 6.6h+ the whole session).
  Archives + unpacked trees at `D:\Temp\acme-r10-test\` (original) and
  `D:\Temp\acme-r10-recut\` (recut) with the mock install between them.
- Laptop ACE: RUNNING, serving the r10 trio, world open, log
  ace-logs/ace_r10_20260824.log, stdin ~/ace_stdin.fifo (sleep-infinity
  writer). Old r9 dat dir untouched. Non-persistent spawned Drudge Skulkers
  (Holtburg lifestone + Bandit Castle) vanish on restart.
- Announce: recut numbers are in the draft; the owner's 6 posting questions
  remain open.

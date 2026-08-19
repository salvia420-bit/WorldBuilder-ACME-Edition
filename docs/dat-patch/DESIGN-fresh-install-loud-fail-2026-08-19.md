# Fresh-install loud-fail gate (r8 HIFI-split precondition 2.3) — design

Post-split, client_highres.dat is LOAD-BEARING: the portal no longer carries the
superseded retail top-levels, so a kit missing the highres renders missing
textures — silently, because the force-mount patch's absent-file path is a
graceful no-op by design (mount-gate arm C, byte-proven).

## Decision needed (owner): mechanism A vs B

**B (recommended): kit-level launcher check.** Ship the r8 kit with a launcher
(`play.bat` / tiny exe) that before exec'ing acclient verifies:
- client_highres.dat exists next to the exe,
- size matches the release manifest (and optionally sha256 — full hash of
  ~650 MB adds ~2-3 s; size+first/last-block hash is instant and catches
  truncated copies),
- same for client_portal.dat / client_cell_1.dat while we're there.
On failure: a blocking message box (powershell/mshta) naming the missing file
and the download URL, and NO client launch. Zero client-byte risk, trivially
testable, works for every wine/windows player. Cost: players who bypass the
launcher and run acclient.exe directly skip the check (mitigate: name the real
exe acclient-bin.exe in the kit? — decide at kit-assembly time).

**A (alternative): client patch.** Extend the force-mount patch so the
LookForFile-failed arm raises the retail "DAT files are incomplete" dialog
instead of falling through. Catches direct-exe launches too, but is new byte
work on the exact code path we just gated, needs its own box gate, and couples
kit policy into the exe. Keep as a candidate only if bypass-the-launcher proves
common.

## The gate itself (pre-r8-announce, boxable in one arm)
1. Assemble a fresh kit dir from the r8 artifacts, DELETE client_highres.dat.
2. Launch via the kit launcher → must refuse loudly (screenshot the message).
3. Launch acclient directly (the bypass case) → capture what a player would see
   (expected: world loads, textures missing) — document, don't gate on it if
   mechanism B is chosen.
4. Restore the highres, relaunch → normal boot (control).

# ACME dat patch — distribution norms note (roadmap §5.7)

The Asheron's Call preservation community's standing convention is that DAT
mods ship as **patch-over-existing-install**: the player supplies their own
retail install (the dats are Turbine/WB-copyrighted content; nobody
redistributes clean retail dats), and a mod package replaces or patches files
inside it.

What ACME releases do to stay inside that norm (**revised 2026-08-21 for the
r8+ kit shape**):

- The package contains the modified dat TRIO (`client_portal.dat`,
  `client_cell_1.dat`, `client_highres.dat`) + sha256s + a README, plus the
  **client patcher and launcher** (`acme-patch-client` + `play.bat` with the
  fresh-install loud-fail check): the patcher applies documented byte patches
  to the player's OWN `acclient.exe` (dat-decompress, force-mount highres,
  caps — see tools/dat-patch/ac-eor-patch/PATCHES.md). Still **no clean
  retail files, no full replacement client executable, no server binaries** —
  the player supplies their own install; we ship only deltas and derived
  content. (The pre-r8 "ONLY the modified dats, no client executable" wording
  described the pair-era packages; the patcher addition keeps the same
  patch-over-existing-install principle: the shipped exe artifact is the
  PATCHER, not the game binary.)
- The README's first instruction is BACK UP the originals — the package
  overwrites/patches files in an install the player already owns.
- Every asset in the patch is derived from the player's own retail content
  (upscales, displacement shells, verbatim record clones) — no third-party
  IP is introduced.
- Server operators get `server-ops.md`; players connecting to unpatched
  servers rely on the retail-matched DDD iteration pair (see that doc).

Practical upshot for announcements: link the package + sha256, state the
tier it patches over (any retail install; earlier ACME tiers are fine to
patch over — each release is self-contained, not a delta), and point at the
rollback instructions (restore the backed-up originals).

# ACME dat patch — distribution norms note (roadmap §5.7)

The Asheron's Call preservation community's standing convention is that DAT
mods ship as **patch-over-existing-install**: the player supplies their own
retail install (the dats are Turbine/WB-copyrighted content; nobody
redistributes clean retail dats), and a mod package replaces or patches files
inside it.

What ACME releases do to stay inside that norm:

- The tgz contains ONLY the modified dats (`client_portal.dat`, and from r5
  `client_cell_1.dat`) + sha256s + a README. No client executable, no clean
  retail files, no server binaries.
- The README's first instruction is BACK UP the originals — the package
  overwrites files in an install the player already owns.
- Every asset in the patch is derived from the player's own retail content
  (upscales, displacement shells, verbatim record clones) — no third-party
  IP is introduced.
- Server operators get `server-ops.md`; players connecting to unpatched
  servers rely on the retail-matched DDD iteration pair (see that doc).

Practical upshot for announcements: link the package + sha256, state the
tier it patches over (any retail install; earlier ACME tiers are fine to
patch over — each release is self-contained, not a delta), and point at the
rollback instructions (restore the backed-up originals).

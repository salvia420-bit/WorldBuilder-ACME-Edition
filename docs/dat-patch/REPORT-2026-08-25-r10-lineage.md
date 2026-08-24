# REPORT 2026-08-25 — r10 release dat lineage (the trio the kit ships)

The r10 kit's three dats, their exact provenance, and what r10 adds over the
r9b kit. This is the assembly-input record: `assemble_kit.sh --tag r10` is fed
precisely these files, and the kit's own `SHA256SUMS.txt`/`kit-manifest.txt`
must agree with the shas/sizes below.

## The trio

| file (kit name) | source artifact (READ-ONLY) | size | sha256 |
|---|---|---:|---|
| `client_portal.dat` | `/mnt/wbterminal2/dat-patch-creature-fix/client_portal.r10-headfix.dat` | 572,314,624 | `1c773046594e0c8a07b062a866abd615ac85a4f5769172b726319da2f107a3f6` |
| `client_highres.dat` | `/mnt/wbterminal2/dat-patch-r10-highres/client_highres.r10.dat` | 1,333,604,352 | `b2706d830d9767d12e7dcd017578f30adbd8d662c70699c51f39a1c792fcf5e0` |
| `client_cell_1.dat` | `/mnt/wbterminal2/dat-patch-r9/kit-r9b/acme-r9/client_cell_1.dat` (r9b, unchanged) | 347,298,304 | `2eaf2a84f4f8b4e5…` (byte-identical to the shipped r9b cell; full sha in the kit SHA256SUMS) |

## Portal — r9 portal + 4.P4 creature subdiv scale-out + big-head reverts

Lineage: the r9-gated portal → `client_portal.r10work.dat` (pilot 20 subdiv
creatures, `reports/r10-lineage-2026-08-21.md`) → full 4.P4 scale-out
(`HANDOFF-2026-08-21-r10-gate.md`: the compressed-GfxObj/vanilla-ACE blocker
found there is why every creature insert is uncompressed) → the
creature-fix lane's final pass, which is two things on top of the scale-out:

1. **1,209 creature GfxObj parts re-meshed at 4× subdivision and landed**
   (`HANDOFF-2026-08-21-r10-gate.md`; pn_tessellate level 1, orientation off,
   gfxObjOnly + preservePhysics — the POC invariants: id unchanged, drawn tris
   up, physics polys byte-identical, sort/degrade/surfaces untouched).
2. **Big-head reverts:** the proportion audit caught 204 of those parts whose
   subdiv pass bulged head geometry (`bulged_ids.json`, 204 ids); all 204 were
   reverted via `headfix-revert.json` (204 inserts, readback verified). A revert
   rolls the record back to its RETAIL geometry — an intentional quality
   regression for those parts versus shipping them bulged at 4×.
   **Net: 1,005 GfxObj parts ship subdivided at 4×** (1,209 landed − 204
   reverted); the 204 reverted parts ship byte-retail.

Server-compat gate (creature-fix lane `ace_regr.log`): a vanilla ACE serving the
r9 lineage answers the r10-headfix client's DDD interrogation with
`no update required` — the portal keeps retail's iteration record, so
unmodified servers leave the files alone.

## Highres — r10work (r9 world2 + 4.H2) + INDEX16 palette repair on the CORRECT base

Lineage per `/mnt/wbterminal2/dat-patch-r10-highres/PROVENANCE.txt` (that file is
the authoritative step-by-step record):

- Base: `client_highres.r10work.dat` (9,085 records = r9 gated world2 + the three
  4.H2 detail-texture records; palettes corrupted by the earlier build-pipeline
  bug).
- The 2026-08-21 idx16 repair had been run against the WRONG base (an r9b-kit
  copy, 9,082 records, no 4.H2). This lane re-ran the identical, deterministic
  repair (`idx16_scan_fix.py`, unchanged) against the intended base:
  **3,414 palettized records repaired**, all bins byte-identical to the 08-21
  run's, inserted compressed (`0x06` family = server-safe), readback 3,414/3,414.
- Verification (all pass): distinct-index sets and sentinel fractions match the
  clean source per record; dims/format/palette untouched; 4.H2's three records
  present and byte-identical to r10work; full BTree walk 9,085/9,085.
- `REPORT-2026-08-25-repallet-verification-r10fixed.md` closes the loop from the
  texture side: the repaired probe record is **exact index-preserving 2× nearest
  replication of retail** (100.0% index match, 904/904 palette rows) — the old
  08-24 report's "3.8% match" finding is now understood as the corruption
  signature, sampled from the corrupted r10work by mistake.

## Cell — r9b, unchanged

No r10 lane touched the cell dat. The kit re-ships the r9b
`client_cell_1.dat` byte-identical (347,298,304 B).

## What r10 adds over r9b, and the audit blockers it closes

Over the r9b kit:
- **4.P4 creature subdiv** — 1,005 creature GfxObj parts at 4× mesh density
  (1,209 landed, 204 bulged-head parts reverted to retail — portal).
- **INDEX16 palette repair** — 3,414 corrupted palettized textures restored to
  palette-correct 2× content (highres). Nothing corrupted was ever publicly
  shipped; the corruption existed only in internal tiers.
- **4.H2 detail textures** — the three baked detail-texture records
  (0x060037D2, 0x06006D57, 0x06006D58) ride the highres for the first time in a
  shippable base (they were in r10work but r10work's palettes were unshippable).

Release-audit blockers closed by this trio (bc171bff's numbering: B1–B3 are the
dat-lineage blockers; B4–B6, the registry/README/licence items, landed
separately in that commit):
- **B1 — no shippable highres existed** (every candidate had corrupted INDEX16
  palettes, or was repaired on the wrong base and lacked 4.H2): the only prior "repaired" highres either
  lacked 4.H2 (repair-on-wrong-base) or had corrupted palettes (r10work). The
  `client_highres.r10.dat` artifact is the first highres that is simultaneously
  palette-correct AND 4.H2-complete — verified both by the lane's own 3,414/3,414
  checks and independently by the repallet re-verification report.
- **B2 — the subdiv portal shipped bulged heads** (the scale-out's proportion
  regression): reverted (204/204, to retail geometry) in
  `client_portal.r10-headfix.dat`; the shipped portal carries the subdiv win
  without the defect.
- **B3 — no assembled, gated r10 kit existed** for the repaired artifacts: closed
  by the `assemble_kit.sh --tag r10` run this report records (patcher-table +
  artifact-parity gates PASS, manifest self-gate PASS).

## Kit assembly

Assembled by `tools/dat-patch/kit/assemble_kit.sh --tag r10` with the three
source paths above; the patcher-table gate (`check_ps1_table.py`) and the
play.bat manifest self-gate run as always. The kit output's `SHA256SUMS.txt` is
authoritative for the shipped bytes; this report is authoritative for where
they came from.

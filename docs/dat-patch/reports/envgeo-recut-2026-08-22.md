# 4.P3 env-variant re-cut — automated gates GREEN (2026-08-22)

The wider env-geo re-cut (staged per PREP-envgeo-recut-lineage + PREP-ENVGEO-STAGED §5)
is built and passes every automated gate. Ready for the mandatory 1070 in-client eye-test,
then kit assembly.

## Inputs (recut-20260821 run root: /mnt/wbterminal2/dat-patch-envgeo/recut-20260821)
- Pre-envgeo portal seed: client_portal.pre-envgeo.dat sha 50b0d325… (PREP-ENVGEO-STAGED verified)
- base cell copy: client_cell_1.base.dat
- cluster: `env_geo.py cluster --top 7236 --min-cells 8` → 6,133 clusters → **3,214 variants**,
  257,778 wall-cells covered (45%); LB all-or-none → 2,294 LBs fully covered.
- variant-build: 3,074 OBJs emitted (140 known r5-era build failures, waived), 232,471 retargets.

## Output (staged, NOT yet kit-assembled)
- `export/client_portal.dat`  c9f2ef01c9a4b24975a7e81e0bd3d21faa5631fe6c4a8b4812d89dbfd4a1a75d  (637,578,240 B)
- `export/client_cell_1.dat`  f9231a6dc532d991806d2a7022f32a4b4c7d8e793ae6383a32a1ebe4c99b7061  (347,298,304 B)

## Gates
| gate | result |
|---|---|
| variant-apply (clone→append→retarget via WBT) | 3,074 cloned, 3,074 appended, **232,471 retargeted, 0 fail** |
| fixup (DRW b-tree sentinel/compaction) | portal 80,356 entries; cell 805,348 entries — clean |
| variant_verify | **CLEAN** — 3,074/3,214 built+parsed (140 waived), 232,471/232,471 retargets landed |
| cell-portal-graph-sweep vs base | **PASS** — 12/12 batches match base over 2,294 LBs (0 orphaned/asymmetric/unresolved) |
| orientation veto audit | up-facing shell **~2.9%** of carved area (82,926/2,059,915 polys), down from the pre-veto 28% |

## STILL GATED (mandatory, needs the owner / a GPU box)
- **1070 in-client eye-test**: feet-sink gone + no relief seams at cell edges across a walked
  dungeon (PREP-ENVGEO-STAGED §6). Batch with other 1070 eye-tests; off-screen/headless.
- After the eye-test: kit assembly (assemble_kit.sh with this portal+cell), then ship.

## Operational note (transient)
The one-command `variant_release.sh` run reported "variant-apply: OK (0 command responses)"
and verify then failed (0 retargets landed) — a transient in that run's WBT subprocess
(capture_output pipe), NOT a content/pipeline bug: re-running the identical variant-apply
batch standalone succeeded fully (clonedCount 3074, retargetedCount 232471), and fixup+verify+
sweep+audit all pass on the result. If re-run via the script, prefer file-redirected stdout
over capture_output for the giant clone/retarget responses.

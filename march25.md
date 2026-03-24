# March 25 Reminder

The current Google Cloud VM run is set up to:

- continue `generate_populated_world.py`
- wait for generation to finish
- create a local artifact tarball in the repo root
- shut the VM down automatically

Important follow-up for the next session:

1. Restart the VM if it is stopped.
2. Go to `~/WorldBuilder-ACME-Edition`.
3. Look for a file named like:
   - `artifacts_YYYYMMDDTHHMMSSZ.tar.gz`
4. Inspect or download that tarball before deleting anything.
5. Check:
   - `generate.log`
   - `finalize.log`
   - `pipeline_data/population_output/vanquish_ml_populated.sql`
   - `pipeline_data/models/scene_placer_best.pt`
6. Important generation finding:
   - the first whole-world progress report was
     `10% (0 LBs, 0 objects, 0 houses, 0 encounters, 6674s)`
   - assume generation/inference needs debugging before spending many more hours on full-world runs

Why this matters:

- the VM service account could not upload to GCS
- results are being bundled locally instead
- the tarball is the main handoff artifact for the next agent
- the current highest-value next task is probably instrumentation of
  `generate_populated_world.py`, not longer blind generation

This file is temporary and can be deleted after the tarball is recovered.

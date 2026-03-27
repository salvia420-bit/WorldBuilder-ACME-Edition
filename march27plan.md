# March 27 Plan

Current validated baseline:
- Planner-v2 leader on `master`
- Best validated score: `85.4/100`
- Leader probe: `247 / PAD 8 / STOP 25`

Winning artifacts
- Region A: `pipeline_data/population_output/serviceprior_region_20260327T155119Z_score.txt` -> `85.4/100`
- Region B: `pipeline_data/population_output/serviceprior_region_v2_b_20260327T1600.sql` -> `85.4/100`
- Probe: `pipeline_data/population_output/probes/probe_scene_placer_final_20260327T155447Z.json` -> `247 / PAD 8 / STOP 25`

Current repo state
- `master` is intentionally restored to the validated planner-v2 winner line.
- Latest repo commit: `143a83b`
- Do not resume from the rejected dense-service-head or retail-cluster-conditioned branches.

Completed
- [x] Freeze the winning planner-v2 branch as the production-quality baseline.
- [x] Add dense-entropy diagnostics to `analyze_population_gaps.py`.
- [x] Identify the real remaining failure buckets in dense service blocks.
- [x] Test dense-service planner-head variants.
- [x] Drop the non-winning dense-service-head line and restore `master` to the validated planner-v2 leader.

Next steps toward `90`
- [x] Extract a dedicated retail dense-service benchmark dataset from retail SQL.
- [x] Cluster retail dense-service blocks into data-driven composition groups.
- [ ] Add a new planner supervision target based on those retail-derived clusters.
- [ ] Condition generation on the new cluster signal with mild realization biases only.
- [ ] Run the full 7-stage detached OutdoorML cycle on the new branch.
- [ ] Compare against the current leader and reject anything that does not beat `85.4/100`.
- [ ] If a branch wins, validate it across multiple representative `20x20` regions.

Rejected lines
- Dense-service composition head v1:
  - moved the right buckets
  - regressed total score to `83.6/100`
- Softer dense-service composition head:
  - still regressed total score to `84.3/100`
  - worsened dense entropy in the worst service bucket
- Retail-cluster supervision + cluster-conditioned generation:
  - recovered the strong probe line `247 / PAD 8 / STOP 25`
  - but only scored `84.9/100`
  - dense entropy still worsened to `29.1` unique WCIDs per dense LB
  - rejected against the `85.4/100` planner-v2 leader

Decision
- Keep planner-v2 as the winning branch.
- Do not continue local generator tuning on this line.
- The next research step should be better retail-derived supervision, not more logit surgery.

Shutdown handoff
- Safe production-quality baseline: planner-v2 winner on `master`
- Retail dense-service research artifacts now exist:
  - `pipeline_data/reference/dense_service_retail_dataset.json`
  - `pipeline_data/reference/dense_service_retail_dataset.npz`
  - `pipeline_data/reference/dense_service_retail_clusters.json`
  - `pipeline_data/reference/dense_service_retail_clusters.npz`
- The retail-cluster-conditioned branch was tested and rejected:
  - strong probe recovery, but only `84.9/100`
  - dense entropy remained worse than the winner
- If work resumes, branch from current `master` and use the retail dense-service artifacts as inputs for the next supervision design.

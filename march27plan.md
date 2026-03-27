# March 27 Plan

Current validated baseline:
- Planner-v2 leader on `master`
- Best validated score: `85.4/100`
- Leader probe: `247 / PAD 8 / STOP 25`

Completed
- [x] Freeze the winning planner-v2 branch as the production-quality baseline.
- [x] Add dense-entropy diagnostics to `analyze_population_gaps.py`.
- [x] Identify the real remaining failure buckets in dense service blocks.
- [x] Test dense-service planner-head variants.
- [x] Drop the non-winning dense-service-head line and restore `master` to the validated planner-v2 leader.

Next steps toward `90`
- [x] Extract a dedicated retail dense-service benchmark dataset from retail SQL.
- [ ] Cluster retail dense-service blocks into data-driven composition groups.
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

Decision
- Keep planner-v2 as the winning branch.
- Do not continue local generator tuning on this line.
- The next research step should be better retail-derived supervision, not more logit surgery.

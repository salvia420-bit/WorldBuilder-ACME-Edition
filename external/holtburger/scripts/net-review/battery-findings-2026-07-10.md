# Full-telepoi battery — laptop findings (2026-07-10)

Driver: `battery-telepoi.mjs` (62 POIs from `telepoi-list-2026-07-10.txt`,
land + stream-settle per stop, `--resume` across renderer deaths).
Run dir: `/mnt/wbterminal2/holtburger-scratch/battery-20260710T134356Z/`.
All arms: laptop SwiftShader + `?nullRender=1`, tailnet1, serve.py live tree.

## The 2×2 (55/62 landed per arm; 7 non-landings = same-LB duplicate POIs)

| arm | active cycle | settleMed | saturated(lru≥150) med | park/unpark ops |
|---|---|---|---|---|
| default            | 618 s | 8.7 s | 12.1 s | — |
| warmPark=on        | **551 s** | **8.3 s** | 13.2 s | 4144 / 3747 |
| default + ringFloor=ringMax   | 657 s | 10.4 s | 13.4 s | — |
| warmPark + ringFloor=ringMax | 598 s | 8.5 s | 16.0 s | 8515 / 6578 |

## Conclusions
1. **warmPark: consistently ~9–11 % faster full-cycle actives**, lower settle
   medians, stability-neutral (3 SwiftShader renderer deaths per arm in both
   modes). Its win is ring-overlap/revisit re-attach; first-visit saturated
   stops stay cold-bake-bound.
2. **At-cap reclaim ping-pong is real** (~75 reclaim ops/stop): the LRU
   reclaims LBs the ring loaders immediately restore — re-BAKE in classic
   mode (the 12–18 s per-town settle), re-ATTACH under warmPark (why it
   wins). Root-cause fix is NOT the floor:
3. **ringFloor=ringMax A/B = NEGATIVE RESULT** (kept as a constructor param,
   default 1). It made churn worse (8515 park ops) — hypothesis: right after
   a teleport the reclaim center is STALE (`pose.landblockId` freeze, a
   documented trap), so a big floor protects the OLD ring while the arriving
   ring's fresh bakes get reclaimed. Follow-up: make `getCurrentLbId`
   teleport-fresh (or gate reclaim during the post-teleport freeze window),
   THEN revisit the floor + the A11-F7 hysteresis latch.
4. **SwiftShader renderer dies under sustained teleport churn** every ~15–40
   stops (both modes, pre-existing). `--resume` absorbs it; real-GPU runs
   (1070) should not need it, and a 1070 death WOULD be signal.
5. Measurement caveat: the settle metric is *stability*, not completeness —
   a streaming-starved page settles "fast". Always read settle next to the
   lru curve (the first warmPark attempt looked 10× faster while baking
   nothing: arm-1's crashed chromium zombies had starved it).

# Movement parity report — retail vs holtburger

Generated: 2026-08-11T18:50:46.079Z
Retail source: `/tmp/claude-1000/-home-wbterminal/c726c308-6f35-4389-b7b9-037e600897d0/scratchpad/pairs/retail-<scenario>.jsonl`
holtburger source: `/tmp/claude-1000/-home-wbterminal/c726c308-6f35-4389-b7b9-037e600897d0/scratchpad/pairs/holt-<scenario>.jsonl`

Rows are ranked by |delta| relative to the metric's tolerance, so the first row of each table is the worst real divergence. `delta` is holtburger minus retail: positive means holtburger is faster/higher/slower-to-settle than retail.

Verdicts: **PASS**/**FAIL** against the metric's tolerance. **no-data** — one side never produced samples in that window (a stall, or a scenario step with no driver hook). **retail-unresolvable** — the metric is finer than retail's ~1 Hz wire sampling can see (any ms-tolerance metric, and the ~500 ms jump arc); the holtburger figure may be perfectly good but there is nothing trustworthy to compare it against until the in-process sampler (T4/MoveOracle) lands. Only FAIL rows enter the ranked defect list.

`intent_speed` is the source's OWN reported velocity over the steady window, beside the realized (position-differentiated) `steady_speed`. They should agree; `intent_speed` much larger than `steady_speed` means the avatar was commanded to a speed it never reached — a slope, an obstacle, or a collision at the capture site.

## walk-hold

| metric | retail | holtburger | delta | delta % | verdict |
|---|---:|---:|---:|---:|---|
| accel_t90 | 0 | — | — | — | no-data |
| decel_t10 | — | — | — | — | no-data |
| gait | — | run | — | — | no-data |
| intent_speed | — | 0 | — | — | no-data |
| release.steady_speed | — | — | — | — | no-data |
| steady_speed | 1.849 | — | — | — | no-data |

## run-hold

| metric | retail | holtburger | delta | delta % | verdict |
|---|---:|---:|---:|---:|---|
| accel_t90 | 1260 | 40 | -1220 | -96.8% | retail-unresolvable |
| steady_speed | 7.859 | 7.232 | -0.627 | -8.0% | FAIL |
| decel_t10 | 1100 | — | — | — | no-data |
| gait | — | run | — | — | no-data |
| intent_speed | — | 7.787 | — | — | no-data |
| release.steady_speed | — | — | — | — | no-data |

## run-hold-long

| metric | retail | holtburger | delta | delta % | verdict |
|---|---:|---:|---:|---:|---|
| decel_t10 | 1020 | 40 | -980 | -96.1% | retail-unresolvable |
| steady_speed | 7.885 | 7.806 | -0.079 | -1.0% | FAIL |
| gait | — | run | — | — | no-data |
| intent_speed | — | 7.787 | — | — | no-data |
| release.steady_speed | — | 0 | — | — | no-data |

## walk-edge-after-manualheld-walk

| metric | retail | holtburger | delta | delta % | verdict |
|---|---:|---:|---:|---:|---|
| first_hold.steady_speed | — | 3.131 | — | — | no-data |
| gait | — | run|walk | — | — | no-data |
| intent_speed | — | 3.120 | — | — | no-data |
| second_hold.steady_speed | 7.660 | — | — | — | no-data |

## strafe-diagonal

| metric | retail | holtburger | delta | delta % | verdict |
|---|---:|---:|---:|---:|---|
| steady_speed | 7.768 | 7.976 | 0.208 | 2.7% | FAIL |
| heading_drift | 0 | 0 | 0 | — | no-tolerance |
| gait | — | run | — | — | no-data |
| intent_speed | — | 8.358 | — | — | no-data |

## turn-while-run

| metric | retail | holtburger | delta | delta % | verdict |
|---|---:|---:|---:|---:|---|
| steady_speed | 2.493 | 7.522 | 5.028 | 201.7% | FAIL |
| turn_rate | 133.924 | 0 | -133.924 | -100.0% | FAIL |
| gait | — | run | — | — | no-data |
| intent_speed | — | 7.787 | — | — | no-data |

## jump-standing

| metric | retail | holtburger | delta | delta % | verdict |
|---|---:|---:|---:|---:|---|
| flight.steady_speed | — | 0 | — | — | no-data |
| gait | — | run | — | — | no-data |
| jump_airtime | — | 0 | — | — | no-data |
| jump_apex | — | 0 | — | — | no-data |
| jump_distance | — | 0 | — | — | no-data |

## jump-running

| metric | retail | holtburger | delta | delta % | verdict |
|---|---:|---:|---:|---:|---|
| flight.steady_speed | 9.061 | 7.232 | -1.829 | -20.2% | FAIL |
| jump_distance | 6.549 | 4 | -2.549 | -38.9% | retail-unresolvable |
| jump_apex | 0.000 | 0.350 | 0.350 | 2347967668.8% | retail-unresolvable |
| jump_airtime | 634.225 | 513.100 | -121.125 | -19.1% | retail-unresolvable |
| gait | — | run | — | — | no-data |
| intent_speed | — | 7.787 | — | — | no-data |
| pre_jump.steady_speed | — | 7.797 | — | — | no-data |

## cast-stationary

| metric | retail | holtburger | delta | delta % | verdict |
|---|---:|---:|---:|---:|---|
| cast.steady_speed | — | 7.782 | — | — | no-data |
| cast_speed_during | — | 7.782 | — | — | no-data |
| gait | — | run | — | — | no-data |

## cast-while-moving

| metric | retail | holtburger | delta | delta % | verdict |
|---|---:|---:|---:|---:|---|
| cast.steady_speed | — | 6.671 | — | — | no-data |
| cast_speed_during | — | 6.671 | — | — | no-data |
| gait | — | run | — | — | no-data |
| intent_speed | — | 7.787 | — | — | no-data |
| pre_cast.steady_speed | — | 7.791 | — | — | no-data |

## stance-switch

| metric | retail | holtburger | delta | delta % | verdict |
|---|---:|---:|---:|---:|---|
| after.steady_speed | — | — | — | — | no-data |
| combat.steady_speed | — | — | — | — | no-data |
| gait | — | run | — | — | no-data |
| peace.steady_speed | — | 7.785 | — | — | no-data |

## Ranked defects

1. **turn-while-run / turn_rate** — retail 133.924, holtburger 0 (delta -133.924, -100.0%).
1. **turn-while-run / steady_speed** — retail 2.493, holtburger 7.522 (delta 5.028, 201.7%).
1. **jump-running / flight.steady_speed** — retail 9.061, holtburger 7.232 (delta -1.829, -20.2%).
1. **run-hold / steady_speed** — retail 7.859, holtburger 7.232 (delta -0.627, -8.0%).
1. **strafe-diagonal / steady_speed** — retail 7.768, holtburger 7.976 (delta 0.208, 2.7%).
1. **run-hold-long / steady_speed** — retail 7.885, holtburger 7.806 (delta -0.079, -1.0%).

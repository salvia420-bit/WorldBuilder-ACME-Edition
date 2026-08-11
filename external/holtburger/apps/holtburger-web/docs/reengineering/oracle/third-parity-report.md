# Movement parity report — retail vs holtburger

Generated: 2026-08-11T20:16:28.226Z
Retail source: `/tmp/claude-1000/-home-wbterminal/c726c308-6f35-4389-b7b9-037e600897d0/scratchpad/s3/pairdir/retail-<scenario>.jsonl`
holtburger source: `/tmp/claude-1000/-home-wbterminal/c726c308-6f35-4389-b7b9-037e600897d0/scratchpad/s3/pairdir/holt-<scenario>.jsonl`

Rows are ranked by |delta| relative to the metric's tolerance, so the first row of each table is the worst real divergence. `delta` is holtburger minus retail: positive means holtburger is faster/higher/slower-to-settle than retail.

Verdicts: **PASS**/**FAIL** against the metric's tolerance. **no-data** — one side never produced samples in that window (a stall, or a scenario step with no driver hook). **retail-unresolvable** — the metric is finer than retail's ~1 Hz wire sampling can see (any ms-tolerance metric, and the ~500 ms jump arc); the holtburger figure may be perfectly good but there is nothing trustworthy to compare it against until the in-process sampler (T4/MoveOracle) lands. Only FAIL rows enter the ranked defect list.

`intent_speed` is the source's OWN reported velocity over the steady window, beside the realized (position-differentiated) `steady_speed`. They should agree; `intent_speed` much larger than `steady_speed` means the avatar was commanded to a speed it never reached — a slope, an obstacle, or a collision at the capture site.

## run-hold-long

| metric | retail | holtburger | delta | delta % | verdict |
|---|---:|---:|---:|---:|---|
| steady_speed | 7.895 | 7.884 | -0.011 | -0.1% | PASS |
| decel_t10 | 1100 | — | — | — | no-data |
| gait | — | run | — | — | no-data |
| intent_speed | — | 7.880 | — | — | no-data |
| release.steady_speed | 2.222 | — | — | — | no-data |

## strafe-diagonal

| metric | retail | holtburger | delta | delta % | verdict |
|---|---:|---:|---:|---:|---|
| steady_speed | 8.468 | 8.362 | -0.106 | -1.3% | FAIL |
| heading_drift | 0 | 0 | 0 | — | no-tolerance |
| gait | — | run | — | — | no-data |
| intent_speed | — | 8.358 | — | — | no-data |

## Ranked defects

1. **strafe-diagonal / steady_speed** — retail 8.468, holtburger 8.362 (delta -0.106, -1.3%).

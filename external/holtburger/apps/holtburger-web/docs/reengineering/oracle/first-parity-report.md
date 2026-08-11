# Movement parity report — retail vs holtburger

Generated: 2026-08-11T16:20:20.154Z
Retail source: `/tmp/claude-1000/-home-wbterminal/c726c308-6f35-4389-b7b9-037e600897d0/scratchpad/retail.jsonl`
holtburger source: `/tmp/claude-1000/-home-wbterminal/c726c308-6f35-4389-b7b9-037e600897d0/scratchpad/holt-run-hold.jsonl`

Rows are ranked by |delta| relative to the metric's tolerance, so the first row of each table is the worst real divergence. `delta` is holtburger minus retail: positive means holtburger is faster/higher/slower-to-settle than retail.

## run-hold

| metric | retail | holtburger | delta | delta % | verdict |
|---|---:|---:|---:|---:|---|
| release.steady_speed | 2.658 | 7.787 | 5.129 | 193.0% | FAIL |
| accel_t90 | 1460 | 0 | -1460 | -100.0% | FAIL |
| steady_speed | 7.400 | 7.787 | 0.387 | 5.2% | FAIL |
| decel_t10 | 1060 | — | — | — | no-data |
| gait | — | walk | — | — | no-data |

## Ranked defects

1. **run-hold / accel_t90** — retail 1460, holtburger 0 (delta -1460, -100.0%).
1. **run-hold / release.steady_speed** — retail 2.658, holtburger 7.787 (delta 5.129, 193.0%).
1. **run-hold / steady_speed** — retail 7.400, holtburger 7.787 (delta 0.387, 5.2%).

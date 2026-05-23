# multi-agent — N wire-agent sessions in one chromium

Density-test orchestrator for the wire-agent fleet workflow. Opens N
pages in ONE chromium browser context (vs N separate chromiums) so the
V8 runtime, JIT caches, and chrome process overhead are paid once.
Empirically ~30-40% less RSS per agent than N independent browsers.

## What it's for

- **Density baseline** — "can 4/8/16 agents fit on this 4 vCPU / 8 GB VM?"
- **Batch landblock validation** — N agents at N different LBs, screenshot each
- **Coordinated multi-player scenarios** — PvP / fellowship / trade tests
  where two sessions need to share an in-JS orchestrator that observes
  both ends without going through the wire

## What it's NOT for

- "WB.Terminal says X exists in this LB but in-game X is missing" diagnostics.
  That's an **observed-vs-expected diff** problem and the lever is an
  in-browser oracle + failure-mode taxonomy on the entity lifecycle (what
  spawned, what errored, what's still pending). Multi-session adds nothing
  to that picture; it's a separate workstream.

## Pre-flight

The wire-agent companion flag stack on the laptop:

```bash
ps -ef | grep -E '(ACE.Server|wsbridge|nocache)' | grep -v grep
# expect: dotnet ACE.Server.dll | holtburger-wsbridge | python3 nocache-server.py 8765
```

Playwright + chromium-headless-shell-1223 from the Playwright cache must
be present. The script hardcodes the path
`~/.cache/ms-playwright/chromium_headless_shell-1223/...` — adjust if
your install differs.

## Usage

```bash
# 4 agents on the default LB (Holtburg fence pen area)
node fleet.mjs --agents=4

# 8 agents with the pure-protocol-bot preset (zero GPU work)
node fleet.mjs --agents=8 --flags="nullRender=1"

# Custom label + render scale
node fleet.mjs --agents=4 --flags="renderScale=0.5" --label=density-half

# Different HTTP base (e.g. for the 1070 tunnel)
node fleet.mjs --agents=4 --base=http://localhost:7080
```

Output goes to `/mnt/wbterminal1/tmp/claude-scratch/multi-agent/<label>-<UTC>/`
with per-agent screenshots, console tails, and `report.json`.

## Default preset

Every agent boots with:

```
autoLogin=1&autoSpawn=first&renderer=3d&quality=low
&kickDance=1&agentic=low&wireframe=1&hud=none&plugins=none
&renderOnDemand=1&netDrainHz=30
```

Account rotation: `phase4demo / phase4demo_2a6 / acadmp1ge522 / tailnet1`
(password = account name; all level-4 / Developer in ACE's Config.js).
The `--flags` arg is appended; later wins on duplicate keys per standard
URLSearchParams semantics.

## Interpreting the report

`report.json` contains:

- `successful` / `failed` counts
- `bootMs.{median,min,max}` — boot-to-ready across the fleet
- per-agent `stats.{entityMapSize, spawnCount, frameCount, sessionHandleExists, renderOnceExists, netDrainAttached}`

If `netDrainAttached: true` and `frameCount` stays low across agents, the
fleet is running on the pure-protocol-bot path correctly.

## Related

- `scripts/perf-worker/` — 1070-driven A/B smoothness testing (single agent)
- `~/.claude/projects/-home-wbterminal/memory/reference_wire_agent_cadence_flags.md`
  — full URL flag reference

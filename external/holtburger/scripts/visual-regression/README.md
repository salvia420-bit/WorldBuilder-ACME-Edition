# Visual regression suite (Phase X.2)

Capture + diff infrastructure for the visual-fidelity push. Lands
**infrastructure only** in this commit — the full 40-screenshot golden
bake (10 views × 4 presets) is deferred to live-ACE per §7 of the plan.

## Files

| Path | Purpose |
|---|---|
| `views.json` | 10 canonical view definitions (id, landblock, teleloc target, sky hour, description). |
| `capture-all.cjs` | Playwright capture script. Two modes — laptop-safe `mockSession` (default), live-ACE `--live` (stub). |
| `diff-vs-golden.cjs` | `pixelmatch` PNG diff vs the canonical `golden.png` in each `{view}/{quality}/` dir. |
| `ci-workflow.example.yml` | Manual-dispatch CI workflow template. Copy to `.github/workflows/visual-regression.yml` (requires `workflow` scope on the pushing user — Claude Code's OAuth token does not have it). |

## Storage layout

Goldens land on the external drive (system disk is ~96% full):

```
/mnt/wbterminal1/holtburger-goldens/
  {view-id}/
    {quality}/
      golden.png                 # canonical reference
      2026-05-13_164227.png      # date-stamped capture
      diff-2026-05-13T19-13-53.png   # pixelmatch diff visualization
      diff-2026-05-13T19-13-53.json  # diff numbers + metadata
  _summary-2026-05-13_164307.json    # per-run summary
```

PNG only (not JPG — lossless avoids false diffs from compression).

## Quickstart (laptop, harness validation)

```bash
NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
  node external/holtburger/scripts/visual-regression/capture-all.cjs \
    --view holtburg_plaza_noon --quality low

# Accept first capture as golden
cp /mnt/wbterminal1/holtburger-goldens/holtburg_plaza_noon/low/<stamp>.png \
   /mnt/wbterminal1/holtburger-goldens/holtburg_plaza_noon/low/golden.png

# Run diff
NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
  node external/holtburger/scripts/visual-regression/diff-vs-golden.cjs \
    --view holtburg_plaza_noon --quality low
```

Two consecutive `mockSession` captures of the same view at the same
preset produce byte-identical PNGs (validated 2026-05-13). The 5%
threshold is permissive for future shader churn.

## Laptop safety gates

`capture-all.cjs` refuses to run two laptop-unsafe combos by default:

- `--quality ultra` without `--live` — ultra loads full Dereth at max
  settings (POM + SSAO + CSM + subdiv=8). OOM risk on the dev laptop.
  Override with `VISREG_ALLOW_LOCAL_ULTRA=1` if you really mean it.
- `--all` without `--live` — that's 40 captures end-to-end and is a
  live-ACE operation.

Both gates exit 2 immediately with a clear message. Per the §7 hard
rule from `docs/visual-fidelity-push-prompt-2026-05-13.md`.

## Live-ACE bake (PK runs on Tailscale 100.116.47.66)

For the actual golden suite, run on the live-ACE box:

```bash
# On the live-ACE host
ssh tailnet1@100.116.47.66
cd ~/WorldBuilder-ACME-Edition

# Bake all 40 captures (10 views × 4 presets)
NODE_PATH=$HOME/.npm/_npx/e41f203b7505f1fb/node_modules \
VISREG_PAGE_BASE=http://127.0.0.1:8765/apps/holtburger-web/index.html \
VISREG_ACCOUNT=PK VISREG_PASSWORD='<redacted>' \
VISREG_BRIDGE_URL=ws://127.0.0.1:9000 \
VISREG_SERVER_HOST=100.116.47.66 VISREG_SERVER_PORT=9000 \
  node external/holtburger/scripts/visual-regression/capture-all.cjs --all --live

# Manually review captures, copy chosen captures as goldens
for V in $(node -e "console.log(require('./external/holtburger/scripts/visual-regression/views.json').views.map(v=>v.id).join('\n'))"); do
  for Q in low mid high ultra; do
    LAST=$(ls -t /mnt/wbterminal1/holtburger-goldens/$V/$Q/*.png | grep -v golden | head -1)
    [ -n "$LAST" ] && cp "$LAST" "/mnt/wbterminal1/holtburger-goldens/$V/$Q/golden.png"
  done
done

# Now diff future captures against the new goldens
for V in $(node -e "..."); do
  for Q in low mid high ultra; do
    node external/holtburger/scripts/visual-regression/diff-vs-golden.cjs \
      --view "$V" --quality "$Q"
  done
done
```

The `--live` path in `capture-all.cjs` is currently a stub. PK should
adapt the login + `@teleloc` pattern from
`apps/holtburger-web/capture_academy_tour.cjs` (sendChat helper at
L347-L360, teleloc dispatch at L583-L620) into the
`captureLiveAceView` function before running the bake.

## Status (2026-05-13)

- Infrastructure landed; capture + diff scripts working end-to-end.
- 2 sample goldens at `quality=low`:
  - `/mnt/wbterminal1/holtburger-goldens/holtburg_plaza_noon/low/golden.png`
  - `/mnt/wbterminal1/holtburger-goldens/forge_closeup/low/golden.png`
- Full 40-capture bake **not yet run** — defers to PK on live-ACE.
- `--live` capture path is a stub — needs the academy-tour pattern
  copied in before PK can run the full bake.

## Open follow-ons

- Mobile UA captures (`?quality=mid` should auto-downgrade to `low`) —
  add a `--ua mobile` flag once we have the harness wired in the
  live-ACE path.
- Replay-driven captures — for animation/sky-time-dependent views,
  drive a deterministic time-of-day fixture instead of relying on the
  wall-clock AC_LAUNCH_UNIX_EPOCH offset.
- Per-view masks — exclude HUD / chat overlay regions from the diff
  (currently the canvas-only screenshot already does this; revisit if
  HUD ever lands in the canvas).

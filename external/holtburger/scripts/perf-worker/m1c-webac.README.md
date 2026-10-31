# m1c-webac.mjs: the W arm of M1c-WEBAC

`scripts/perf-worker/m1c-webac.mjs` runs one rep of the W arm of queue item `M1c-WEBAC`
(`apps/holtburger-web/docs/reengineering/queue-1070/batch-R3-M1-2026-10-30.json`). W is WebAC, run from
its Vite dev server on this laptop, on the 1070. The rep:

- parks at 0xA9B40001 (96, 96, 80) facing yaw 0, with draw distance 8 and `degmul=1`;
- measures the idle phase the way WebAC's own `tools/measure-perf.ts` does;
- writes `<out>/W-r<N>.json`, which `hbreport.py m1c` reads.

Our H arms (`hbbench.mjs --item M1c-WEBAC`) run between the W reps.

It replaces recipe steps 5 to 9. There, a Playwright `connectOverCDP` opened the tab, a separate
step parked the character, and `measure-perf.ts --attach` measured. Playwright's attach hangs on the
box's Chrome 156 (`lib/cdp_raw.mjs` explains why), so this tool does all three over raw CDP. It reuses
the measure-perf page expressions and statistics unchanged.

Sources:
- the queue item's recipe and `protocolExceptions`;
- `apps/holtburger-web/docs/2026-10-29-webac-openac-renderer-lessons.md` section 5.1;
- `/mnt/wbterminal1/ac-refs/webac/tools/measure-perf.ts` and `tools/perf-ratchet-lib.ts`.

## Laptop setup (once per session; nothing here touches the box)

Check `free -m` first: you need at least 2.5 GB available, and nothing heavy may be running
(`~/CLAUDE.md`).

```bash
cd /mnt/wbterminal1/ac-refs/webac && npm install        # npm install --ignore-scripts if better-sqlite3 fails to build
mkdir dat && ln -s /home/wbterminal/ac_base_dats/client_portal.dat /home/wbterminal/ac_base_dats/client_cell_1.dat /home/wbterminal/ac_base_dats/client_local_English.dat dat/
setsid nohup npx tsx services/ws-tcp-bridge/src/bridge.ts 9090 127.0.0.1 9000 > /mnt/wbterminal2/webac-bridge.log 2>&1 &
setsid nohup npx vite --host 127.0.0.1 --port 3000 --strictPort > /mnt/wbterminal2/webac-vite.log 2>&1 &
```

The tunnel needs two extra forwards for the M1c window: add `-R 3000:127.0.0.1:3000 -R 9090:127.0.0.1:9090`
to the box ssh. Keep `-L 9333`, `-R 8765`, `-R 8080` and `-R 8766`. Every preflight refusal prints
these commands; they are read from the queue recipe.

## One rep

```bash
node scripts/perf-worker/m1c-webac.mjs --rep N --out <m1c dir> [--secs 20] [--dry-run]
```

Flags:

| Flag | Default | What it does |
|---|---|---|
| `--url-base` | `http://127.0.0.1:3000` | WebAC's dev server. |
| `--bridge` | `ws://127.0.0.1:9090` | WebAC's own bridge. Ours cannot carry bare AC datagrams. |
| `--secs` | 20 | Length of the idle phase, in seconds. |
| `--capped` | off | Keeps vsync on. The default is uncapped, like the H arms' `--uncapped`. |
| `--no-box-samples` | off | Skips the box samples. |
| `--no-seed-draw-distance` | off | Skips the draw-distance seed. |
| `--no-cooldown` | off | Skips the 65 s login cool-down. |
| `--load-timeout` | 1800 | Seconds to wait for the first load. |
| `--settle-cap` | 120 | Seconds to wait for the scene to settle. |
| `--dry-run` | off | Prints every step and touches nothing: no box, no network, no files. |

Credentials come from the `M1C_ACCOUNT` and `M1C_PASSWORD` environment variables at run time. If they
are unset, the tool uses the bench's own account, read from `lib/hb_v2.mjs` `benchUrlBase`. They are
never written to a file. Every log line and the run JSON show the URL with `password=***`.

The tool runs W first and our H arm second, on the same account (`tailnet1`). Before it logs in, it
waits for ACE's `[LOGOUT]` line plus 65 s. After its teardown it does the same, so the H arm can start
straight away.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | `W-r<N>.json` was written. |
| 1 | The run failed. Diagnostics are in `W-r<N>.failed.json`. |
| 2 | The run was refused, or the command line was wrong. |
| 3 | Wrong adapter: the renderer is not the GTX 1070 on D3D11. |
| 4 | CDP :9333 still answers after the kill. Do NOT start the H arm: it would attach to that Chrome. |

## Steps (each one is logged, and `m1c.steps` records the order)

1. **preflight** (laptop only). The checks:
   - vite answers and serves the three DATs as DATs, not as HTML;
   - the bridge's `/healthz` answers;
   - ACE holds UDP :9000;
   - the `-L 9333` forward is up and no Chrome answers on it;
   - `W-r<N>.json` does not exist yet.
2. **account**: waits for ACE's `[LOGOUT]` line, then the 65 s gap.
3. **box.check**, one ssh call. It refuses when a Chrome on `C:\Temp\hbm1c-webac` (W's own persistent
   profile; 2026-10-30: no longer the owner's MODE P `C:\Temp\cdpwb-wls`, which the kill can never match)
   is already running, and the tool never kills a Chrome it did not start. It also checks that the box
   reaches vite and the bridge through the `-R` forwards.
4. **box.launcher** writes `D:\Temp\hbbench\m1c-webac-launch.bat`. The launcher:
   - runs `hbgate.ps1` first;
   - starts Chrome muted and off-screen at -32000,-32000, never minimized;
   - uses `--window-size=1920,1080`, CDP 9333 and the persistent profile `C:\Temp\hbm1c-webac`;
   - keeps hbprobe-launch.bat's MODE T background flags and its uncapped flags;
   - then starts `noflash.ps1 -Seconds 3600` (a cold first load can outlast its 900 s default).
5. **launch**: arms Ctrl-C, then runs `hb_box launchChrome` through the task `hbm1cwebac` and
   `hidden-run.vbs`. Ctrl-C kills the W Chrome before the process exits.
6. **cdp**, **window**:
   - opens raw CDP to the about:blank tab, plus the browser endpoint for `Browser.*`;
   - closes any extra tab the persistent profile opened;
   - sets the INNER window to 1920x1080 with `lib/hb_session.mjs` `sizeWindow`, the same sizing and
     emulation fallback as the H arms;
   - records inner size, outer size and dpr.
7. **renderer**: UNMASKED_RENDERER on the blank tab must name the GTX 1070 and D3D11. This check runs
   before any login (exit 3 otherwise).
8. **shim**: `Page.addScriptToEvaluateOnNewDocument` with the lessons doc's DAT-iteration shim,
   verbatim (portal 2074, cell 982, language 994). Then measure-perf's `--draw-distance` seed (8), on
   the WebAC origin only.
9. **navigate** to `http://127.0.0.1:3000/?ace&bridge=ws://127.0.0.1:9090&account=…&password=…&degmul=1`.
   Never with `?nocache`, and never reloaded.
10. **load** polls every 5 s, with progress (origin storage MB, UI screen) every 30 s. The first load
    on a cold profile streams about 1.27 GB into OPFS. The gate is `acDebug.collisionState().x > 0` and
    `window.__ac.sceneManager`.
11. **streams**: a 10 s wait, measure-perf's "letting object streams settle".
12. **park**:
    - `acDebug.admin('@teleloc 0xA9B40001 96 96 80')`, skipped within 10 m (measure-perf's rule: a
      same-position teleport breaks CreateObject registration);
    - waits until the player is within 5 m of world (32544, 34656) and `loginComplete`;
    - then `acDebug.setPlayerYaw(0)`.
13. **settle**: measure-perf's `waitForSceneSettle`. The mesh count must stay within max(1, 1 %) over
    4 polls 2 s apart, capped at 120 s. "Never plateaued" is recorded in `m1c.problems`.
14. **sky**: ACE's in-game hour = `acDebug.timeOfDay().timeOfDay * 24`. It counts only when
    `gameClock` (the server's PortalYearTicks) has synced; otherwise `hour` is null and `why` says
    why. Also recorded:
    - `skytimeArg`, the value for our `--skytime`;
    - the day group, plus whether its name matches our `DAY_GROUP_DAT_NAMES` index.
15. **measure**: measure-perf's idle sequence, call for call:
    1. renderer;
    2. draw distance;
    3. location;
    4. render timer;
    5. frameStats start;
    6. yaw 0;
    7. drain;
    8. `--secs` of rAF, with renderer.info and camera yaw every frame;
    9. renderInfo, renderJs, census.

    The statistics are the same ones: `stats()`, the means over 30-degree heading sectors,
    `estimateRealGpu` and `droppedFrameWarnings`. It refuses to measure a hidden tab.
16. **write** `W-r<N>.json`.
17. **teardown**:
    1. about:blank (WebAC's unload closes the ACE session);
    2. close the tab;
    3. kill ONLY the W Chrome by its user-data-dir;
    4. check that CDP :9333 no longer answers;
    5. wait for `[LOGOUT]` plus 65 s;
    6. delete the task.

    The kill takes `chrome.exe` processes whose `--user-data-dir` is exactly `C:\Temp\hbm1c-webac`, as
    long as their browser root carries `--remote-debugging-port=9333 --mute-audio
    --window-position=-32000,-32000`. It also takes that root's children and orphans on that profile.
    It never matches by image name. It never kills the user's Chrome, the bench's `D:\Temp\hbbench\`
    Chrome, or an on-screen MODE P Chrome (`hb_box` `selectProfileKill` / `profileKillScript`).

## The W JSON

It has the shape of measure-perf's own JSON, restricted to the idle phase. `hbreport.py m1c` reads
these fields:

| Field | What it holds |
|---|---|
| `phases[phase=idle].avgFps` | Idle frame rate. |
| `render.idle.drawCalls` | Mean draw calls over the heading sectors. |
| `renderJs.idle.p50Ms` | Median JS-side `renderer.render()` time. |
| `viewport` | The real innerWidth x innerHeight. |
| `renderSampling` | How draws were sampled (`frame-heading-binned`). |

It also carries:
- `rawSamples.idle`: every frame delta and every renderJs sample;
- `renderSamples.idle`: renderer.info and yaw for every frame;
- `drawDistance` (8), `degmul` (1) and `landscapeDrawDistance`;
- an `m1c` block with:
  - profile, window, dpr and vsync;
  - shim, load, park, settle, sky and box samples;
  - console errors, steps, problems and teardown;
  - `frameStatsHbbench`: hbbench's frame statistics over the same deltas.

Where it differs from measure-perf, and why:
- **Transport.** Raw CDP instead of Playwright. Focus emulation is on, as in Playwright's attach.
  `Network.enable`, `Log.enable` and worker auto-attach are not replicated (recorded in `m1c.cdp`).
- **viewport.** Playwright's `page.viewportSize()` is null on an attached tab, so measure-perf would
  write its 1568x775 constant. This tool records the real size.
- **Phases.** Only the idle phase runs. The recipe quotes only idle.
- **Box samples.** They mark the W Chrome as ours. `hbwho.ps1` itself still counts it as "a browser of
  theirs", and its GPU time lands in `gpu3d_other`.

## Reps 1 to 3, interleaved with the H arms (rotate which goes first)

| Rep | First | Second |
|---|---|---|
| 1 | W | H, with `--skytime <W's hour>` |
| 2 | H, with the `--skytime` value that `m1c-webac.mjs --predict-hour <m1c>/W-r1.json --at <expected W-r2 time>` prints | W |
| 3 | W | H, with `--skytime <W's hour>` |

`--predict-hour` works offline. It advances the W reading by wall-clock time, because ACE's
PortalYearTicks run in real time and a Dereth day is `dayLengthSeconds` (7620 s) long. Compare the
predicted hour with W-r2's measured hour, and note any mismatch next to the reading.

The H-arm command is the recipe's, and the tool prints it after each W rep:

```bash
node scripts/perf-worker/hbbench.mjs --arms apps/holtburger-web/docs/reengineering/queue-1070/batch-R3-M1-2026-10-30.json --item M1c-WEBAC --reps 1 --port 8766 --uncapped --skytime <hour> --out <m1c>/H-r<N>
```

Report:

```bash
python3 -I scripts/perf-worker/hbreport.py m1c --h <m1c>/H-r1 --h <m1c>/H-r2 --h <m1c>/H-r3 --w <m1c>/W-r1.json --w <m1c>/W-r2.json --w <m1c>/W-r3.json
```

Cleanup: stop vite and the bridge by the port each one listens on. Never use `pkill -f <pattern>`: the
shell that runs it contains the pattern too, and kills itself.

```bash
for p in 3000 9090; do kill $(ss -Hltnp "sport = :$p" | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); done
```

Then drop the `-R 3000` and `-R 9090` forwards. The tool has already killed the W Chrome and deleted the
task.

## Tests

```bash
capped-wireagent node scripts/perf-worker/tests/m1c_webac.test.mjs
```

The tests use fakes only:
- `ssh` on PATH is a stub that fails;
- the box is a fake that decodes the encoded PowerShell;
- the Chrome is a fake CDP server on 127.0.0.1:0, driven through `lib/cdp_raw.mjs`;
- time is virtual.

The W JSON round-trips through `python3 -I hbreport.py m1c`.

The oom-guard hook treats any node entry script whose text mentions playwright as a headless-Chrome
job. That includes this tool and its suite, so run them with `capped-wireagent`. Neither one starts a
local browser.

# Agent Memory — `WorldBuilder-ACME-Edition` & `holtburger` (read first; keep this file < 20 KB)

## 0. Orient before acting (this is how sessions got lost on 2026-11-17)
- **Which machine are you on?** Commit timezone tells history: `-0330/-0230` = **Dell `wbterminal`** (owner's home Linux box,
  production ACE + Dericost, `/mnt/wbterminal2`); `+0000` = **Vast.ai** container (ephemeral, `/workspace/wb`, since 2026-11-12);
  `win32` = **1070 laptop** `desktop-4anudo2`. Check `hostname`, `ip -br addr`, `nvidia-smi -L` before assuming anything.
- **Vast boxes have NO running ACE.** `vast-bootstrap.sh` restores only ACE *source*. Run `bash scripts/vast/ace-up.sh`
  (idempotent: .NET 10, MariaDB, ACE-World DB, build, Config.js, DAT dir, vehicle props, wsbridge). Vast cannot reach the Dell
  (no Tailscale in the container). Do not ask the owner for a tailnet key — build the local server.
- **Project state (2026-11-17):** master = Dericost continent + Hellcat F6F-6N + Willys Jeep + deployables + ISO containers
  (HBV1 v5) + `trailer_models.js` (client-only, reserved WCID 4000030/31). ACE fork: **`github.com/salvia420-bit/ace-server-holtburger`
  (private), branch `Dericost`, patches 0001–0013** (mirror: `external/holtburger/apps/holtburger-web/docs/vehicles-2026-11-01/ace/`).
  `origin` of `~/ace-server` is upstream ACEmulator — push the fork to remote `fork`.
- **2026-11-17 incident:** commits 765588ed/a33cf184/3f9d4849 (pallet jack / "trailers") were broken (TDZ crash on boot, failing
  protocol tests, C# in the wrong project, root junk files) and were reverted in 4abd052c. Report: those came from a prior Vast instance.

## 1. Where things live
| What | Path / URL |
|---|---|
| Repo | `/home/wbterminal/WorldBuilder-ACME-Edition` (Vast: symlink to `/workspace/wb/home/...`; Win: `D:\WorldBuilder-ACME-Edition`) |
| Web client | `external/holtburger/apps/holtburger-web` (start: `external/holtburger/HANDOFF.md`, flags: `docs/url-flags.md`) |
| ACE source | `/home/wbterminal/ace-server` (Dell, live) · Vast `/workspace/wb/home/ace-server` · GitHub fork above |
| ACE runtime (Vast) | bin `Source/ACE.Server/bin/Release/net10.0`, console `echo cmd > /workspace/wb/ace_stdin.fifo`, log `/workspace/wb/ace_console.log` |
| DATs | `ace-dats-ssd/ace-r10-dats` (ACE; r10 portal iteration 2074) · `ac_base_dats` (retail). Never mix r10 cell + retail portal (ACE crashes). |
| Baked dist | Vast `/workspace/wb/hb-serve/dist/current` (`HOLTBURGER_DIST`) · Win `D:\hb-serve\dist\current` |
| gdrive pool | `rclone gdrive:` → `bundles/*.tar.zst`, `vast-bootstrap.sh` (mirror in repo `scripts/vast/`). Service account: can **overwrite** existing files, **cannot create** new ones (403 storageQuotaExceeded). |
| Login | `index.html?nosw=1&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&bridge_url=ws://127.0.0.1:8080/&server_host=127.0.0.1&server_port=9000` (Vast accounts auto-create at access 5) |

## 2. Hard-won technical facts
- `?quality=ultra&clouds=on` are the real flags (`clouds` defaults on at high/ultra). `?skytime=` pins time; noon is
  `setSkyTimeOverride(0.5)` on the session (hour 10 can still look dark). `?camDebug=on` → `window.__cam.orbit(x,y,z,dist,az,el)`
  in AC world metres for framing **in-game** shots (owner wants in-game shots, not `?filmMode`).
- In-game screenshots: `node harness/ingame-driver.mjs` (persistent login, `:8799` `/eval` `/shot` `/profile` `/chat`); staging
  example `harness/trailer-shots-stage.js`. Hide HUD with CSS `[id^=hb-]{visibility:hidden}` (HUD band tints the canvas top).
- Vehicle debug API: `window.__vehicles` (`containers.list()/get()`, `deployables.spawnLocal`). Server spawn:
  `@container spawn 20|40|40hc x y z` (global AC metres; deck height = ground + 1.32 for a chassis). Ground: `__sessionHandle.terrainHeightAt(x,y)`.
- Never three.js-raycast the ultra terrain group for ground height (minutes). Use `terrainHeightAt`.
- `pkill -f`/`pgrep -f` patterns match your own shell command line — use the `[x]yz` bracket trick and never put the
  pattern text elsewhere in the same command (killed the tool shell 4× on 2026-11-17).
- Shallow clones cannot be pushed to a new remote (`index-pack failed`) — `git fetch --unshallow origin` first.
- Rebuild `pkg/` (`wasm-pack build --target web --out-dir pkg --release`) after Rust changes; serve with `scripts/serve.py`.

## 3. Commit hygiene (enforced — the 17 Nov breakage violated all of these)
- House style: `feat(scope): …` / `fix(scope): …`, body explains why + how verified; ACE changes ship as a numbered patch
  (`format-patch` into `docs/vehicles-2026-11-01/ace/`) AND a push to the fork; protocol changes bump HBV1 in Rust + ACE together.
- Before committing: `node --check` touched JS, the relevant `node tests/*.test.mjs`, `cargo test -p <crate>` for Rust,
  `node harness/run-js-headless.mjs --coverage` (0 unregistered). For client-boot-path changes, actually load the page.
- No scratch files at repo root (`PROJECT.md`, `handoff.md`, `repro_*.cs`). Server logic goes in `ace-server`, not `WorldBuilder.Shared`.
- WCIDs: 4000002 radar, 4000010–17 deployables, 4000020–22 containers, 4000030–31 trailer chassis (reserved). Never reuse.

---

## Profile A — Vast.ai Linux Cloud GPU Workstation (`linux` / `/workspace/wb`)
1. **Parallelism**: `mold` + `sccache` via `/etc/profile.d/wb-dev-pool.sh`; `CARGO_BUILD_JOBS=$(nproc)`, `HB_TEST_JOBS=$(nproc)`;
   `heavy_lock.mjs` heap 3072 MB on ≥32 GiB hosts.
2. **GPU Chromium**: `/workspace/wb/ms-playwright/chromium-1254/chrome-linux64/chrome` with
   `--headless=new --use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist --mute-audio --window-position=-32000,-32000`.
   Never `--enable-logging`. playwright-core: `/workspace/wb/mnt1/ac-refs/webac/node_modules/playwright-core`.
3. **Ephemeral NVMe**: commit + `git push` (repo AND ace fork) before teardown; `save-sccache-to-pool`; shutdown = `vastdown`.

## Profile B — Windows `desktop-4anudo2` GTX 1070 (`win32`)
*i7-7700HQ 4C/8T, 16 GB RAM, GTX 1070 8 GB. A person uses this machine.*
### 1. MANDATORY: zero pop-ups, zero taskbar flashes, zero audio
- `Start-Process … -NoNewWindow`/`-WindowStyle Hidden`; Node `child_process` `windowsHide: true`.
- Scheduled tasks never run `.bat`/`cmd`/`powershell` directly: `wscript.exe //B //Nologo C:\tmp\hbbench\hidden-run.vbs <launcher.bat>`
  (verify `hb*`/`wls*` tasks with `C:\tmp\hbbench\hide-tasks.ps1`).
- Test Chrome: `--window-position=-32000,-32000 --mute-audio --user-data-dir=C:\tmp\hbbench\<profile> --no-first-run
  --no-default-browser-check --disable-features=CalculateNativeWinOcclusion --disable-renderer-backgrounding
  --disable-background-timer-throttling --disable-backgrounding-occluded-windows`; **never `--enable-logging`**; run
  `C:\tmp\hbbench\noflash.ps1` hidden alongside; respect `C:\tmp\hbbench\hbgate.ps1` (idle ≥ 900 s, browsers == 0,
  gpu3d_other < 35 %, or `gate-owner-ok.txt`).
- Kill only our Chrome: `powershell -NoProfile -ExecutionPolicy Bypass -File C:\tmp\hbbench\hbbench-kill.ps1`. **Never**
  `taskkill /IM chrome.exe` / `Stop-Process -Name chrome`. Never OS-mute. Headless Playwright: `headless: true` + the two flags above.
### 2. One heavy job at a time (`harness/lib/heavy_lock.mjs`, lock `D:\Temp\hb-heavy.lock`)
- Heavy = full JS gate, `cargo build/test`, `wasm-pack`, real-GPU Chrome, `dotnet build`. Needs ≥ 2,560 MB free
  (`HB_MIN_FREE_MB=2560`); JS gate children `--max-old-space-size=1536`.
- Rust: never `--workspace`; `-p <crate> -j6` (`CARGO_HOME=D:\.cargo`, `RUSTUP_HOME=D:\.rustup`, `CARGO_TARGET_DIR=D:\cargo-target`).
- Subagents: read/edit + targeted single tests only; no browsers/gate/builds. Put this rule and §1 verbatim in every subagent prompt.
### 3. Paths & network
- Repo `D:\WorldBuilder-ACME-Edition` (junctions: `D:\Clones\WorldBuilder-ACME-Edition-master`, `D:\home\wbterminal\WorldBuilder-ACME-Edition`).
- Toolchains on D: `node` v18.12.0 (gate), `D:\nodejs\node.exe` v20.20.2 (`film.mjs`), cargo 1.99.1 + wasm32, wasm-pack 0.15.1
  (`D:\.cargo\bin`), playwright-core 1.59.1 (`D:\node_modules`), ffmpeg 8.0.1 (`D:\home\wbterminal\bin\ffmpeg.exe`).
- Scratch `D:\Temp` (junction from `C:\Temp`); keep C: ≥ 15 GiB free, D: ≥ 440 GiB free.
- ACE + wsbridge on Dell `wbterminal`: LAN `192.168.2.79` / Tailscale `100.116.47.66`, bridge `ws://<host>:8080/`,
  `server_host=127.0.0.1&server_port=9000`. Assets: `py -3.13 …\external\holtburger\scripts\serve.py --bind 127.0.0.1 --port 8765`
  (never `--allow-missing` for visual/film gates).
- WorldBuilder.Terminal: `dotnet D:\WorldBuilder-ACME-Edition\WorldBuilder.Terminal\bin\Release\net8.0\WorldBuilder.Terminal.dll --stdin`.

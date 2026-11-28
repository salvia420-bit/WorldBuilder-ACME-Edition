# `holtburger-web` + `holtburger-wsbridge` + `ACE.Server` Maximum In-Game Player Capacity Report (2026-11-28)

## Hardware & Software Environment

| Component | Configuration |
|---|---|
| Host / Container | Vast.ai Linux (`7.2.15+kali-amd64`), Intel Core i5-4590 @ 3.30 GHz (4C/4T, up to 3.70 GHz; `cgroup cpu.max = 384000 100000` = 3.84 vCPUs), 15.9 GiB host RAM + 15.6 GiB swap (`cgroup memory.max = 15,299 MiB`; ~6.0–6.3 GiB pre-existing host swap) |
| GPU | NVIDIA GeForce GTX 1070 (8,192 MiB VRAM, Driver `550.163.01`; ~596–800 MiB baseline used) |
| ACE Server | `ace-server` fork (`Dericost` branch, .NET 10 Release), MariaDB local (`127.0.0.1:3306`), `client_cell_1.dat` (r10) + `client_portal.dat` (iter 2074) |
| Default ACE Config | `MaximumAllowedSessions: 128`, `WorldThreadCountMultiplier: 0.34` (`WorldThreadCount: 1`), `DatabaseThreadCountMultiplier: 0.66` (`DatabaseThreadCount: 2`), `MultiThreadedLandblockGroupPhysicsTicking: true`, `MultiThreadedLandblockGroupTicking: true`, `WorldDatabasePrecaching: false` |
| WebSocket Bridge | `holtburger-wsbridge` (`127.0.0.1:8080`, default `--max-conns 256`, `--max-frames-per-sec 500`) |
| Web Client | `holtburger-web` via `serve.py` (`127.0.0.1:8765`), headless EGL GPU Chromium 1254 (`1280x720`, `?renderDiag=on&camDebug=on&portalSpace=off&atmosphereLut=bake`; bare default auto-probes `quality=ultra` on GTX 1070) |

## Methodology (Reflecting Reality)

Every test player (both real Chromium `holtburger-web` clients and real-protocol Rust `ace-loadtest` clients over WebSocket -> `holtburger-wsbridge` -> UDP -> `ACE.Server`):
1. Authenticates with a distinct account, creates a valid 55-skill Aluvian character from `client_portal.dat` (`CharGen` + `SkillTable`), and enters the world.
2. Executes `@god`, `@neversaydie on`, and `@attackable off`, and waits for ACE confirmation of all three (`god=100%`, `immortal=100%`, `unattackable=100%`, **0 deaths**, **0 monster damage events**) **before** teleporting out of the Training Hall.
3. Teleports **out of the Training Hall** (`@teleloc` / `@tele`) onto verified dry outdoor Dereth terrain loaded from `client_cell_1.dat` + `Region::land_height_table` (`outdoor=100%`, verified `!is_indoors()`), sending `LoginComplete` on arrival so ACE clears `Teleporting`.
4. Continuously runs across terrain at 12 m/s (`MoveToState` raw `WalkForward + HoldKey::Run` + 1 Hz `AutonomousPosition` with server-authoritative `UpdatePosition` landblock-crossing confirmation and obstacle reconciliation), crossing 192 m landblock boundaries every ~16 s and waking fresh outdoor landblocks, creatures, and world objects.

---

## Executive Summary — Measured Maximum Player Capacities

| Bottleneck / Layer Tested | Sustainable Playable Max | Hard Ceiling / Failure Mode | Primary Limiting Factor |
|---|---:|---:|---|
| **1. Real `holtburger-web` Browsers on Single 16 GB / GTX 1070 Host (`quality=ultra`, GTX 1070 auto-probe default)** | **1–2 browsers** | **2 browsers** (browser #1 crashes at N=3 with V8 OOM) | **`quality=default` resolves to `ultra`** (`farRadius=11`, `subdivLevel=8`, 119k grass blades, 18k rocks, SSAO/GTAO/SSR/CSM/POM): **~3.1–3.7 GB V8 JS heap / ~5.4 GB RSS per browser** hits Chrome's 4 GB V8 cage & 15.6 GB host swap at N=3 (GPU only 23–32%, ~980 MiB VRAM/browser). |
| **1B. Real `holtburger-web` Separate Browsers (`quality=mid`)** | **2 browsers** | **2–3 browsers** (6.7 FPS at N=3, **0 crashes**) | JS heap cut ~2x to **1.1–1.8 GB/browser** (WASM 215–389 MB, VRAM 2.94 GB at N=3, GPU 33%); eliminates V8 OOM crash, bounded by **4-vCPU contention + 14.5 GB host swap** (6.1 s swap stalls at N=3). |
| **1C. Real `holtburger-web` Tabs (`quality=low`, shared browser)** | **2–3 tabs** | **3–4 tabs** (5.6 FPS at N=4, **0 crashes**) | JS heap cut ~3x to **0.9–1.34 GB/tab** (VRAM 3.49 GB at N=4, GPU 7%); bounded by **4-vCPU main-thread CPU + 15.5 GB swap**. |
| **2. Single `holtburger-web` Client Rendering In-Frustum Moving Crowd (`quality=ultra`, flat open arena `0xCC76`, 95–100% visible)** | **~100–110 visible players** (`>=30 FPS`: 31.1 FPS at 96 visible / 101 online) | **~190–200 visible players** drops below 15 FPS (**18.4 FPS** at 175 visible -> **9.0 FPS** at 204 visible -> **8.6 FPS** at 250 visible / 256 online, **0 crashes**) | **CPU draw-call submission**: each visible animated humanoid rig adds **~22 draw calls** (`273 -> 5,945` calls from 1 to 250 visible players), while GPU stays 26–38% and WASM stays flat (377 MB). *(Note: if players are mostly off-screen/occluded — e.g. only 2–8 in frustum out of 127 in Holtburg — FPS stays at 27–38 FPS.)* |
| **3. Dedicated `ACE.Server` — Dispersed Moving Players (Default Config: `WT=1, DBT=2, MaxSessions=128`)** | **~50–60 moving players** (`>=30 Hz`, 44.2 Hz at 50) | **128 online** (config cap; 14.7 Hz, 65.9 ms tick, 135 ms p50 RTT, 2,347 active LBs, 92k objects, 4.68 GB RSS; excess rejected with `CharacterError::LogonServerFull (0x15)`) | **`WorldThreadCount = 1`** (`0.34 * 4 = 1`) saturates 1 core at 92% CPU. |
| **4. Dedicated `ACE.Server` — Dispersed Moving Players (Balanced Config: `WT=2, DBT=2`, `0.50/0.50`, `MaxSessions=256`)** | **~140–150 moving players** (`>=30 Hz`: **49.7 Hz** at 128 players, 19.7 ms tick, 28 ms p50 RTT -> 26.8 Hz at 160 players) | **224+ dispersed moving players** (**21.2 Hz**, 46.5 ms tick, 66 ms p50 RTT, **4,065 active + 3,190 dormant LBs, 53.2k creatures, 160.9k objects**, 7.14 GB GC heap, 0 failures, 0 disconnects, 0 deaths) | **Balanced 3-way split** at 224 players (`Physics=15.9ms`, `MT=15.7ms`, `ST=14.3ms [PlayerTick=0.2ms, WorldObjHeartbeat=7.0ms]`) + **~1.75 MB GC heap per active landblock (~32 MB/dispersed moving player)** pushing host swap to 9.7 GB on this 16 GB box. *(Contrast `WT=3, DBT=1`, which starved DB login bursts and collapsed at 188 players / 5.5 Hz due to CPU/swap thrashing.)* |
| **5. `holtburger-wsbridge`** | **256 connections** (default `--max-conns 256`) | **Hard cap at 256 connections** (excess rejected cleanly with HTTP `503 Service Unavailable`) | At 256 N²-broadcast crowd players: **33.2% CPU, 10.7 MB RSS, 781 FDs**. At 224 dispersed players: **3.5% CPU, 8.0 MB RSS, 685 FDs**. Zero drops. |

---

## Detailed Metrics by Phase

### Phase 1 — Multi-Browser Real GPU `holtburger-web` on Single Host (1280x720)

#### 1A. `quality=ultra` (bare default auto-probed on GTX 1070, separate Chromium processes)

| Browsers (N) | Mean FPS | Min FPS | Avg p95 Frame (ms) | Alive / Outdoor | Per-Client JS Heap (MB) | Chrome RSS (MB) | Chrome CPU (%) | VRAM Used (MiB) | GPU Util (%) | Host Swap (MB) | Notes |
|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 11.4 | 11.4 | 312.1 | 1/1 | 3,141 | 5,388 | 220.9% | 1,783 / 8,192 | 30% | 9,639 | Cold Holtburg streaming |
| 2 | 12.0 | 2.7 | 1,047.5 | 2/2 | 3,240 / 3,488 | 6,370 | 224.7% | 2,603 / 8,192 | 32% | 14,376 | #1 settled 21.4 FPS; #2 booting Yaraq |
| 3 | 3.3* | 0.0 | 953.6 | 2/3 *(1 crashed)* | crashed / 3,734 / 2,702 | 5,185 | 156.0% | 2,590 / 8,192 | 23% | 15,598 | **#1 crashed (`Target crashed`, V8 heap OOM)**; swap 100% full |

*\*Original run excluded crashed #1 from meanFPS (reporting 3.3 across #2/#3); fixed harness now includes crashed tabs as 0 FPS and aborts immediately on crash.*

#### 1B. `quality=mid` (separate Chromium processes, auto-provisioned via `--provision-only`)

| Browsers (N) | Mean FPS | Min FPS | Avg p95 Frame (ms) | Alive / Crashed | Per-Client JS Heap (MB) | WASM (MB) | Chrome RSS (MB) | Chrome CPU (%) | VRAM Used (MiB) | GPU Util (%) | Host Swap (MB) |
|---:|---:|---:|---:|---|---|---|---:|---:|---:|---:|---:|
| 1 | 11.5 | 11.5 | 328.9 | 1 / 0 | 1,483 | 389 | 4,767 | 258.3% | 1,228 / 8,192 | 37% | 7,590 |
| 2 | 15.7 | 4.2 | 517.5 | 2 / 0 | 1,794 / 1,107 | 389 / 245 | 6,501 | 256.1% | 1,817 / 8,192 | 39% | 11,142 |
| 3 | 6.7 | 0.9 | 2,332.7 | 3 / 0 | 1,579 / 1,157 / 944 | 389 / 245 / 215 | 6,417 | 235.3% | 2,940 / 8,192 | 33% | 14,507 |

*Zero crashes at `quality=mid` up to N=3 (`#2 Yaraq` ran 612.2 m across 4 landblocks); N=3 hit swap-induced 6.1 s frame stalls (`stalls5s=3` on #2, `2` on #3).*

#### 1C. `quality=low` (shared Chromium browser process)

| Tabs (N) | Mean FPS | Min FPS | Avg p95 Frame (ms) | Per-Tab JS Heap (MB) | WASM (MB) | Chrome RSS (MB) | Chrome CPU (%) | VRAM Used (MiB) | GPU Util (%) | Host Swap (MB) |
|---:|---:|---:|---:|---|---|---:|---:|---:|---:|---:|
| 1 | 13.5 | 13.5 | 273.1 | 940 | 379 | 4,165 | 236.0% | 1,451 / 8,192 | 29% | 6,806 |
| 2 | 10.5 | 4.2 | 349.3 | 1,075 / 1,140 | 379 / 389 | 4,648 | 198.5% | 2,399 / 8,192 | 19% | 10,893 |
| 3 | 8.1 | 2.3 | 824.3 | 1,078 / 1,339 / 888 | 379–389 | 4,796 | 216.8% | 2,852 / 8,192 | 7% | 13,347 |
| 4 | 5.6 | 2.2 | 759.7 | 1,083 / 1,343 / 1,313 / 1,040 | 376–389 | 5,421 | 191.4% | 3,487 / 8,192 | 7% | 15,539 |

---

### Phase 2 — Single `holtburger-web` Client Rendering Full-Frustum Visible Moving Crowd (`0xCC76` Flat Arena, `quality=ultra`, `MaxSessions=256`)

*Elevated `?camDebug=on` camera (`dist=72m, el=34°`) framing concentric running rings (`r=8..28m`, 12 m/s) so **95–100% of all online players are simultaneously visible in the camera frustum**. Zero deaths, zero disconnects, zero obstacle reconciliations (`recon=0`), zero ACE warnings.*

| Total Online (`rPl`) | In-Frustum Visible (`vPl`) | Observer FPS | Frame p50 / p95 / p99 (ms) | Draw Calls | Triangles | Observer Heap / WASM (MB) | ACE Tick Avg (ms) | ACE Hz | ACE CPU (%) | wsbridge CPU / RSS / FDs | Ping p50 / p95 (ms) |
|---:|---:|---:|---|---:|---:|---|---:|---:|---:|---|---|
| 1 (baseline) | 1 | 37.2–42.4 | 17.8 / 56.8 / 114.2 | 273–285 | 1,502k–1,729k | 3,346 / 378 | 1.6 | 60.2 | 14.8% | 0.0% / 1.2 MB / 16 | - |
| 11 | 10 | **57.7** | 16.7 / 22.5 / 30.6 | 474 | 1,676k | 3,455 / 378 | 1.0 | 59.9 | 23.7% | 0.7% / 2.4 MB / 46 | 1.4 / 9.2 |
| 21 | 21 | **58.1** | 16.7 / 20.5 / 29.3 | 722 | 1,683k | 3,448 / 378 | 0.7 | 60.0 | 24.8% | 1.5% / 2.7 MB / 76 | 1.7 / 24.2 |
| 41 | 39 | **52.2** | 18.7 / 23.0 / 26.6 | 1,150 | 1,695k | 3,476 / 378 | 0.7 | 60.0 | 28.3% | 4.1% / 3.4 MB / 136 | 2.6 / 31.5 |
| 61 | 58 | **41.0** | 22.6 / 32.9 / 42.3 | 1,579 | 1,704k | 3,297 / 378 | 1.2 | 59.9 | 31.4% | 6.6% / 3.7 MB / 196 | 4.8 / 18.4 |
| 81 | 77 | **36.6** | 25.3 / 41.2 / 57.5 | 2,027 | 1,716k | 3,288 / 378 | 1.3 | 59.9 | 37.3% | 10.1% / 4.4 MB / 256 | 5.6 / 16.8 |
| **101** | **96** | **31.1** | 30.0 / 46.2 / 57.7 | **2,443** | 1,726k | 3,288 / 378 | 1.6 | 60.0 | 39.8% | 13.1% / 5.1 MB / 316 | 5.9 / 17.6 |
| 126 | 123 | **28.7** | 34.0 / 41.2 / 50.2 | 2,976 | 1,741k | 3,308 / 378 | 1.5 | 59.9 | 49.8% | 17.8% / 6.0 MB / 391 | 5.9 / 15.1 |
| 151 | 146 | **24.9** | 39.0 / 49.2 / 59.6 | 3,585 | 1,755k | 3,324 / 378 | 1.8 | 59.9 | 55.2% | 21.8% / 6.8 MB / 466 | 6.4 / 16.4 |
| 181 | 175 | **18.4** | 46.8 / 85.7 / 115.4 | 4,068 | 1,769k | 3,321 / 378 | 3.3 | 59.9 | 57.6% | 25.0% / 7.9 MB / 556 | 9.1 / 45.1 |
| **211** | **204** | **9.0** | 95.6 / 206.8 / - | **4,910** | 1,846k | - / 377 | 4.3 | 59.1 | - | 25.4% / - / - | - |
| 241 | 239 | **9.5** | 101.1 / 131.9 / - | 5,438 | 1,862k | 2,078 / 377 | 3.8 | 59.8 | 73.8% | 33.5% / 10.1 MB / 736 | 10.0 / 27.3 |
| **256** *(5 full)* | **250** | **8.6** | 110.5 / 160.4 / - | **5,945** | 1,872k | 1,910 / 377 | 4.8 | 59.1 | 75.5% | 33.2% / 10.7 MB / 781 | 12.7 / 45.5 |

*At step 260 (+ 1 observer = 261 total WS attempts), `holtburger-wsbridge` (`--max-conns 256`) cleanly rejected all 5 excess connections while the 256 in-game players continued moving smoothly at 59.1 Hz ACE tick.*

---

### Phase 3 — Dedicated `ACE.Server` Dispersed World-Wide Landblock Loading: Default (`WT=1, DBT=2`) vs Balanced (`WT=2, DBT=2`) vs Over-World (`WT=3, DBT=1`)

#### 3A. Balanced 4-vCPU Config (`WT=2, DBT=2`, `0.50/0.50`, `MaxSessions=256`) — **Recommended**

*Zero login failures (`fail=0`), zero disconnects (`disc=0`), zero deaths (`death=0`), zero `MOVEMENT SPEED` warnings, zero `failed transition` warnings, zero server errors across all 224 brand-new accounts/characters and 2,134 server-confirmed landblock crossings.*

| Players Online & Moving | Active LBs | Dormant LBs | Creatures | Total World Objects | Tick Avg / Long (ms) | ACE Hz | Phys / MT / ST (ms) | ST Breakdown (PlayerTick / ObjHB) | ACE CPU (%) | ACE RSS / GC Heap (MB) | GC Pause (%) | Ping p50 / p95 (ms) | Host Swap (MB) |
|---:|---:|---:|---:|---:|---|---:|---|---|---:|---|---:|---|---:|
| 0 | 1 | 0 | 47 | 165 | 0.2 / 2 | 59.8 | 0.1 / 0.0 / 0.0 | 0.0 / 0.0 | 8.6% | 443 / 174 | 7.64% | - | 6,179 |
| 25 | 412 | 0 | 2,857 | 8,407 | **3.3** / 301 | **59.1** | 1.1 / 1.7 / 0.4 | 0.0 / 0.2 | 63.1% | 1,352 / 994 | 3.14% | **1.2** / 38.6 | 6,138 |
| 50 | 987 | 21 | 7,510 | 21,544 | **5.9** / 274 | **59.5** | 2.5 / 2.3 / 1.0 | 0.0 / 0.4 | 71.1% | 1,889 / 1,398 | 3.05% | **1.3** / 27.3 | 6,110 |
| 75 | 1,525 | 261 | 13,310 | 39,411 | **16.4** / 1,367 | **47.5** | 6.6 / 6.5 / 3.2 | 0.1 / 1.3 | 93.4% | 2,706 / 2,077 | 3.68% | **18.7** / 1,496 | 6,074 |
| **100** | 2,016 | 654 | 19,664 | 59,761 | **14.7** / 302 | **57.2** | 5.4 / 5.4 / 3.9 | 0.1 / 1.4 | 140.8% | 3,493 / 2,880 | 3.80% | **15.7** / 65.3 | 6,053 |
| **128** | 2,474 | 1,186 | 26,956 | 83,905 | **19.7** / 281 | **49.7** | 7.5 / 6.4 / 5.7 | 0.1 / 2.2 | 158.7% | 4,489 / 3,948 | 4.01% | **28.1** / 111.0 | 6,160 |
| **160** | 3,069 | 1,762 | 35,404 | 109,088 | **36.6** / 740 | **26.8** | 12.4 / 13.1 / 10.8 | 0.2 / 5.4 | 144.3% | 5,211 / 4,935 | 4.43% | **56.1** / 378.3 | 6,616 |
| 192 | 3,642 | 2,440 | 44,819 | 136,464 | 43.0 / 3,565 | 23.0 | 12.7 / 17.6 / 12.2 | 0.1 / 6.3 | 136.0% | 5,353 / 5,988 | 5.69% | 56.8 / 2,983 | 8,626 |
| **224** | **4,065** | **3,190** | **53,214** | **160,915** | **46.5** / 874 | **21.2** | 15.9 / 15.7 / 14.3 | **0.2 / 7.0** | 147.1% | 4,913 / 7,144 | 5.80% | **66.1** / 368.3 | 9,744 |

#### 3B. Comparison vs Default (`WT=1, DBT=2, MaxSessions=128`) and Imbalanced (`WT=3, DBT=1, MaxSessions=256`)

| Dispersed Moving Players | Default `WT=1, DBT=2` (Hz / Tick / p50 RTT) | Balanced `WT=2, DBT=2` (Hz / Tick / p50 RTT) | Imbalanced `WT=3, DBT=1` (Hz / Tick / p50 RTT) |
|---:|---|---|---|
| ~50 | 44.2 Hz / 19.8 ms / 26.6 ms | **59.5 Hz / 5.9 ms / 1.3 ms** | ~56.1 Hz *(at 40)* / 10.6 ms / 3.2 ms |
| ~100 | 19.3 Hz / 51.6 ms / 79.2 ms | **57.2 Hz / 14.7 ms / 15.7 ms** | ~22.3 Hz *(at 93)* / 43.4 ms / 64.2 ms |
| ~128 | 14.7 Hz / 65.9 ms / 135.0 ms | **49.7 Hz / 19.7 ms / 28.1 ms** | ~20.5 Hz *(at 125)* / 47.1 ms / 76.0 ms |
| ~160 | *(capped at 128; `LogonServerFull`)* | **26.8 Hz / 36.6 ms / 56.1 ms** | 13.9 Hz *(at 157)* / 71.1 ms / 136.6 ms |
| ~192 | — | **23.0 Hz / 43.0 ms / 56.8 ms** | **5.5 Hz *(at 188)* / 175.9 ms / 258.6 ms (collapsed)** |
| 224 | — | **21.2 Hz / 46.5 ms / 66.1 ms (4,065 LBs, 161k objs)** | — |

---

## Key Bottlenecks & Actionable Findings

1. **`holtburger-web` Draw-Call Submission Caps In-Frustum Crowd Rendering**: Each visible animated humanoid rig submits **~22 draw calls** (`273 -> 5,945` calls from 1 to 250 visible players). On GTX 1070 / 4 vCPU at `quality=ultra`, a single client holds **>=30 FPS up to ~100–110 simultaneously visible moving players**, **~25 FPS at 150**, and drops below 15 FPS at **~190–200 visible players** (`9.0 FPS` at 204 visible, `8.6 FPS` at 250 visible) while GPU utilization stays at only 26–38% and WASM memory stays completely flat (377 MB). Enabling/expanding `?entityBatch` instancing/batching for humanoid rigs is the direct path to >250 visible players at 30+ FPS.
2. **`holtburger-web` JS Heap Footprint (`quality=default` Auto-Probes `ultra` on GTX 1070)**: Bare URL launch auto-probes `quality=ultra` on GTX 1070 (`farRadius=11`, `subdivLevel=8`, 119k grass blades, 18k rocks), consuming **~3.1–3.7 GB V8 JS heap** (~5.4 GB RSS) and crashing at 3 concurrent browsers on 16 GB RAM. Setting `?quality=mid` cuts JS heap to **1.1–1.8 GB** (0 crashes up to 3 browsers); `?quality=low` cuts it to **0.9–1.34 GB** (0 crashes up to 4 shared tabs, bottlenecked by 4-vCPU CPU + swap).
3. **ACE Thread Balance (`WT=2, DBT=2` = `0.50 / 0.50`) More Than Doubles Dispersed Capacity on 4 vCPUs**: Default `0.34 / 0.66` (`WT=1, DBT=2`) starves the world tick at **14.7 Hz** at 128 players; imbalanced `0.75 / 0.25` (`WT=3, DBT=1`) starves MariaDB login writes (35/50 timeouts) and oversubscribes cores into swap thrash (collapsing to 5.5 Hz at 188 players). Balanced **`0.50 / 0.50` (`WT=2, DBT=2`)** sustains **49.7 Hz at 128 dispersed moving players** (3.4x faster than default), **>=30 Hz to ~140–150 dispersed players**, and still holds **21.2 Hz at 224 dispersed moving players** (`4,065` active + `3,190` dormant landblocks, `53.2k` creatures, `160.9k` objects) with zero failures.
4. **ACE Memory & Single-Threaded Heartbeat Scaling**: Under balanced `WT=2, DBT=2`, tick cost splits evenly across `Physics` (15.9 ms), `MultiThreadedWork` (15.7 ms), and `SingleThreadedWork` (14.3 ms, of which `WorldObject_Heartbeat` is 7.0 ms and `Player_Tick` is only 0.2 ms at 161k objects). Memory grows at **~1.75 MB GC heap per active landblock (~32 MB per dispersed moving player)**, reaching 7.14 GB GC heap at 224 dispersed players (4,065 active LBs).
5. **`holtburger-wsbridge` Scales Cleanly to Its 256 Connection Cap**: 33.2% CPU / 10.7 MB RSS / 781 FDs under 256-player N² crowd broadcasts, and 3.5% CPU / 8.0 MB RSS under 224 dispersed players, with clean HTTP 503 enforcement past `--max-conns 256`.

## Caveats & Scope Notes

- On this shared 15.9 GiB host (~6.1 GiB pre-existing swap), swap-bound ceilings (ACE past ~5 GB RSS at 192–224 dispersed players; 3–4 concurrent Chromium browsers) reflect host swap pressure in addition to raw CPU/VRAM limits.
- Dispersed ACE testing stopped at 224 moving players (`21.2 Hz`, zero failures); pushing to 256+ (`--direct-udp` / higher `MaximumAllowedSessions`) and testing combat/spells/inventory/vehicles/dungeons or 30-min dormancy soaks remain future follow-ons.
- The final 2-line monotonic stuck-turn tweak in `browser_swarm.mjs` / `live_observer_bench.mjs` was syntax-checked (`node --check`) but not re-run live after early wrap-up.

## Reproducibility Commands

```bash
# Build & unit-test the real-protocol load generator
cargo test --manifest-path external/holtburger/Cargo.toml -p holtburger-tools --bin ace-loadtest
cargo build --manifest-path external/holtburger/Cargo.toml --release -p holtburger-tools --bin ace-loadtest

# Phase 1: Multi-browser real-GPU holtburger-web capacity (auto-provisions accounts via --provision-only)
node external/holtburger/apps/holtburger-web/harness/load_test/browser_swarm.mjs --quality=mid --max=4 --hold=20

# Phase 2: Single holtburger-web client full-frustum visible moving crowd capacity (0xCC76 flat open arena)
node external/holtburger/apps/holtburger-web/harness/load_test/live_observer_bench.mjs \
  --mode=crowd --center-lb=CC76 --center-x=96 --center-y=96 --center-z=22 \
  --crowd-radius-min=8 --crowd-radius-max=28 --cam-dist=72 --cam-el=34 \
  --steps=10,20,40,60,80,100,125,150,180 --hold=25 --ramp-ms=100

# Phase 3: Dedicated ACE.Server dispersed world-wide landblock-loading capacity
node external/holtburger/apps/holtburger-web/harness/load_test/live_observer_bench.mjs \
  --no-observer --mode=dispersed --steps=25,50,75,100,128,160,192,224 --hold=30 --ramp-ms=140
```

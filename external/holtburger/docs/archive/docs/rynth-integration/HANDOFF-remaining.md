# Handoff — RynthSuite → holtburger-web: what's LEFT (2026-07-16)

Continuation of `~/handoff-rynthsuite-holtburger-port-2026-07-16.md` (the scoping doc).
That doc asked the question; this session **built the answer**. An autonomous, multi-account,
remotely-controllable grind bot now runs on holtburger-web entirely through a reimplemented
`RynthCoreHost` seam, live-verified end to end against local ACE. This handoff covers only
the **remaining** work.

Repo: `WorldBuilder-ACME-Edition`, submodule `external/holtburger`, branch **master** (pushed).
Head at handoff: `464d552b`. 31 `rynth-integration` commits this session.

> **2026-07-16 (later session): item A is DELIVERED.** The RynthNav global router
> sidecar exists (`apps/rynthnav-sidecar` — Recast bake with real collision geometry,
> Detour query, portal Dijkstra, HTTP `route()` on :8767), `rynth/global_router.js` +
> `bot.goto()` + `!bot goto` consume it, and `rynth_globalroute_smoke` walked 9 legs
> around Holtburg's buildings live (0 replans, 2.6 m final error). See §2A below for
> what replaced it as remaining nav depth, and `apps/rynthnav-sidecar/README.md` for
> run/bake/traps.

---

## 0. Read these first (all in the repo, version-controlled)

- `external/holtburger/docs/rynth-integration/STATUS.md` — **the delivery reconciliation**:
  every synthesis phase + report + report-11 rule mapped to done/TODO with its smoke test.
  Start here.
- `external/holtburger/apps/holtburger-web/rynth/README.md` — module map, contract sources,
  the encoded live-verified traps, how to run the suite.
- `external/holtburger/docs/rynth-integration/workflow-reports/16-synthesis.md` — the original
  16-agent roadmap (unchanged).
- `external/holtburger/docs/rynth-integration/netwasm-spike/` — the D1 fork spike (proven).

## 1. What EXISTS (so you don't rebuild it)

Bot code: `external/holtburger/apps/holtburger-web/rynth/` — 9 JS modules + `spell_ladders.json`.
Entry point: `createGrindBot(sessionHandle, config)` in `bot.js`. 20 smokes (`rynth_*_smoke.cjs`),
runner `rynth_test_all.cjs`. The seam is `webhost.js` (`RynthWebHost`).

Fully done & live-verified: the whole grind loop (combat/buff/loot/nav/vitals via `kernel.js`),
report-11 **combat contract** (T2/T8/T9/T10, P2/P3/P5/E4, P12, all 3 attack modes) and **buff
contract** (B1–B16), the multi-account `supervisor.cjs`, the tell-based `control_channel.js`,
the push-event plane, ~20 new wasm getters in `apps/holtburger-web/src/lib.rs` (search
"rynth-integration"), and the D1 language fork resolved (JS ships; `.NET-wasm` de-risked).

## 2. Remaining work (ranked; none are open feasibility questions)

### A. RynthNav GLOBAL router sidecar — ✅ DELIVERED 2026-07-16 (later session)
Built as report 09's Option A: `apps/rynthnav-sidecar` (net10.0) vendors PortalRoute +
TerrainSampler/DatDatabase + NavBake from rynthsuite@bf1fb52, lifts the Detour query layer
from `RynthNavPlugin.cs`, and serves `POST /route -> legs[{lb,x,y,z,portal}]` (CORS'd,
127.0.0.1:8767) in `router.js`'s exact frame. The bake is obstacle-aware: `tools/GeomExtract`
(NuGet Chorizite.DatReaderWriter) extracts cell.dat `LandBlockInfo` statics/buildings +
the dist bake's per-LB scenery jsonl into collision triangles — **including the trap that
scenery Setups carry no physics polys; retail collides their CylSphere list** (emitted as
prisms). Terrain-only tiles are a proven failure mode (servo grinds on Holtburg's walls,
pursuitStatus stuck ACTIVE). A9B4 bakes 183 polys (upstream datum 265). Live-verified:
`rynth_globalroute_smoke` PASS. What REMAINS of nav (all M-or-smaller except the bake):
- **Full-map bake** — only A7–AB × B2–B6 is baked; elsewhere = straight-line fallback
  legs. Buildbox fan-out job; raise DetourRouter `maxTiles` (256) + add eviction first.
- **Indoor routing** — dungeon walls aren't baked (upstream Phase-3 gap); needs the
  report-09 §1b cell-graph A* path over `getRenderSet`/`takePortalCellIds`.
- **Portal-arrival re-validation** — portals.tsv is retail GoArrow data (~0.1° rounded);
  spot-check `portal:true` legs against our ACE beyond the Holtburg region.
- **Sidecar lifecycle** — manual `setsid nohup`, dies on reboot (sysvinit box): cron
  `@reboot` or a supervisor.cjs spawn block.

### B. Incremental .NET-wasm lift (D1 path A′) — strategic, large
The bot is JS today. `netwasm-spike/` PROVED a RynthAi-shaped C# slice compiles to and runs in
browser wasm via `[JSExport]` (~4.1 MB runtime). If preserving the ~41k-line C# investment
matters more than the JS reimplementation, lift RynthAi's pure-tier files (report 15's ~13k
Tier-A lines) into a wasm crate behind the SAME `webhost.js` seam, largest-value-first
(CombatManager scoring, BuffManager scheduling), each validated byte-for-byte against the JS
behavior. Prereq: `dotnet workload install wasm-tools` (already installed on this laptop).

### C. VTank meta-scripting (ExpressionEngine) — deferred by design
101 of 367 `Has*` guard sites; a 3,738-line `ExpressionEngine` the four grind loops never touch
(report 03 deferred it). Gate on demonstrated user need. Its one memory-address dependency
(`ExpressionEngine.cs:2971` game clock) already has a shim path: `serverTime()`.

### D. Small polish (optional)
- Missile ammo-out is already covered (ACE toggle guard + server revert; combat_loop mode guard
  bounds a can't-enter-combat character). No real gap.
- Item-enchant duration is server-authoritative/unreadable (B7 uses interval recast); if a
  future protocol surface exposes it, tighten `buff_loop.js` `itemRecastMs`.
- Full render-session path: `getSpellRecord` (live SpellCatalog) is a fallback in `buff_loop.js`
  but was never exercised (headless has no catalog) — verify it in a `?renderer=3d` session.

## 3. How to run / verify (all local on this laptop)

Prereqs, all already running/available here:
- ACE server: `dotnet ACE.Server.dll` (UDP 9000/9001). Check `ss -ulpn | grep 900`.
- `external/holtburger/scripts/serve.py` on :8765 (live JS tree).
- `holtburger-wsbridge` on :8080 (WS↔UDP).
- rynthnav sidecar on :8767 (`apps/rynthnav-sidecar/README.md` has the launch + bake recipes).
- **RELEASE** wasm in `apps/holtburger-web/pkg/` — `env PATH=".../.cargo/bin:..." capped-build
  wasm-pack build --target web --out-dir pkg --release` (dev wasm's memory tax destabilizes
  headless tabs — this cost hours; always release before a headless campaign).
- Playwright on `NODE_PATH` (`/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules`).

Run the suite from `apps/holtburger-web/`:
`NODE_PATH=<pw> node rynth_test_all.cjs` (fast) · `--full` (adds grind tests) · `--only=a,b`.
Last green baseline: fast set 7/7.

## 4. Traps that cost real time this session (all encoded, but know them)

1. **`?autoLogin=1` is single-shot** — the Account-In-Use kick dance defeats it; every smoke
   boots via `rynth_boot_helper.cjs` (reload-retry, success = `__sessionHandle` attached).
2. **Test account is SHARED (`tailnet1`)** and its state PERSISTS: HP (`@sethealth`, ushort
   ≤65535 — larger silently no-ops; `@heal` was a near no-op), wielded gear (the melee smoke
   unwields then MUST re-wield — it does), and drifting saved position (movement smokes
   `@telepoi Holtburg` first). Pace logins ≥70 s (ACE reap window).
3. **ACE silently reverts Melee mode when a bow/wand is wielded** — always use the
   equipment-derived `toggleCombatMode`, never a blind `setCombatMode`. Untargeted self-buff
   casts also require Magic mode (`Player_Magic.cs:279`).
4. **Enchantment `start_time`/`duration` are Derethian-epoch seconds** — remaining time via the
   buffs-hud A1 formula (`Enchantment.cs:100-104`, self-stamped receivedAt), not serverTime diffs.
5. **The live SpellCatalog isn't loaded headless** — `getSpellRecord` is empty under
   `?nullRender=1`; that's why the buff tier table is a baked `spell_ladders.json` asset.
6. **Pose for the brain is wasm world-state** (AC Z-up, landblock-local) — never three.js coords.

## 5. Verify-before-trust

Every "done" claim in STATUS.md has a named smoke that PASSED live. If you doubt a piece, run
its smoke. Agent/citation drift is real — re-read leads before acting (this is why every module
carries file:line contract references).

*Nothing here is blocked on feasibility. A, B, and C are scope decisions; D is polish.*

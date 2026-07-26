# RESULTS — MaterialCache falsifier reruns: the 3.6 GB step is NOT the cache's pixel bytes (2026-07-26)

> **⚠ PARTIAL RETRACTION (same night, later):** the "3,586 MB step" itself was an
> instrument artifact — unflagged `performance.memory` is quantized and cached for
> 20 minutes, and 3,586 MB exceeds this box's V8 heap limit. See
> `RETRACTION-jsheap-step-2026-07-26.md`. The INTERVENTION findings below stand
> (cache pinned at 64 MB, settle worsened, tracked bytes honest); every sentence
> about "the step" and its POI position is void.

Executes next-move 1's falsifier from `RESULTS-validation-battery-2026-07-25.md`
(bounded-cache armLong rerun) against the merged `feat/matcache-budget`
(`?matBudgetMB=N` byte-budget LRU, commit `207b0468`) + `feat/arc-surface-pixels`
(option E, `81ad4891`), release wasm 4.9 MB built 2026-07-26 00:55. Same armLong
rig: full 62-POI route, ONE unlimited session, `?nullRender=1&nosw=1`, park at
Samsur, no concurrent builds.
Raw: `/mnt/wbterminal2/matcache-falsifier-2026-07-26/` (`run1-1024/`, run 2 at top
level).

## Run 1 — `matBudgetMB=1024` (00:57–01:24)

| metric | armLong (unbounded, last night) | armLongMC=1024 |
|---|---:|---:|
| sessions/deaths | 1 / 0 | 1 / 0 |
| settleMed(work) | 17.1 s | 17.3 s |
| capped | 20 | 21 |
| maxMain / maxWkr | 679 / 234 | 680 / 232 |
| jsHeapPeak max | 3,586 MB | 3,586 MB |
| final mats | 1,802 | 1,807 |
| tracked cache bytes (`matMB`) | — (no instrument) | **355 MB, evictions 0** |

**The budget never bound.** Tracked LRU bytes (`Σ image.data.byteLength` per DID —
a direct measurement, not a model) reached only 355 MB at mats=1,807, ~196 KB/DID
average: this route/preset holds mostly small albedo-only textures (normal maps off
in the low preset ⇒ 1 plane, and most surfaces are ≤256², not the 512² 3-plane
2.25 MiB the §6 model assumed).

**And yet the heap stepped anyway, identically**: 54 MB flat → 3,586 MB at stop
~47 (mats=1,488, tracked cache = **261 MB** at that moment), and the settle
age-collapse persisted (caps per decade 1/3/1/4/5/5). The four bounded Maps held
an order of magnitude too few bytes to be the step.

### Reading

`RESULTS-validation-battery-2026-07-25.md` verdict 1 ("MaterialCache retainer:
CONFIRMED") conflated *correlation* (mats grows linearly with route progress; so
does every other route-cumulative quantity) with *identity of the retainer*. The
step detector fired at the same place while the cache's actual content was 261 MB.

**New lead suspect: entity-owned recolored textures.** `preloadBatch`'s
entity-owned leg (`_buildEntityOwnedFromPixels`, materials.js) deliberately does
NOT install into `this.materials` ("would collide with non-recoloured uses of the
same surface DID") — each entity registers its own texture via
`inst.registerOwnedTexture`/`registerOwnedMaterial`. Those textures are: outside
all four bounded Maps, uncounted by `matMB`, per-entity (not per-DID — a popular
recolored surface is duplicated per wearer), and cumulative with route progress
exactly like `mats`. A 62-town roam accumulates thousands of NPC/player/item
spawns.

## Run 2 — `matBudgetMB=64` (01:27–…, binding by construction)

Purpose: clean interventional kill. 64 MB < the 261 MB the cache held at run 1's
step, so evictions MUST fire (gate proof: `evict>0` in the relay). If the heap
still steps to ~3.6 GB and the 31+ bucket still caps while the cache is pinned at
64 MB, the MaterialCache mechanism is **refuted by intervention** and the hunt
moves to the entity-owned pool. If the step vanishes, the eviction of derived
clones/anim frames (which ARE dropped on evict but only partially charged) was
load-bearing after all.

RESULTS (01:27–01:57): **REFUTED, cleanly.** Gate proof: `mats` pinned at 64 MB
from ~stop 4 (`mats=496@64MB/64 evict=26` at Arwic), **5,723 evictions** over the
route, final mats 375. And:

| metric | armLong (unbounded) | run 1 (=1024, never bound) | run 2 (=64, bound) |
|---|---:|---:|---:|
| settleMed(work) | 17.1 s | 17.3 s | **23.8 s** |
| capped | 20 | 21 | **25** |
| jsHeapPeak max | 3,586 MB | 3,586 MB | **3,586 MB** |
| step position | ~Timaru | stop ~47 | **stop ~49 (Swank)** |
| maxMain / maxWkr | 679 / 234 | 680 / 232 | 681 / 237 |
| deaths | 0 | 0 | 0 |

1. **The heap step is untouched** — same magnitude, same route position — with the
   four maps holding 64 MB. The MaterialCache maps are not the 3.6 GB.
2. **Bounding the cache made settle WORSE** (23.8 s vs 17.1 s; caps per decade
   3/4/0/5/5/6): the churn (5,723 re-creates) is pure cost. The maps' content was
   earning its keep.
3. **The step is a route-position event, not a monotone threshold-crossing**: in
   all three runs it fires entering the *Swank* cluster (Storage → **Swank** →
   Timaru; last night's write-up said "from Timaru onward" — Swank is two stops
   earlier, same boundary). Hotel Swank is an item museum: a mass spawn of dyed
   items ⇒ a burst of entity-owned recolored textures, allocated at that stop and
   **retained through every later stop** (js stays 3,586 to route end). This is
   §6's H2 branch, which the mats-correlation had wrongly demoted.

## Option E cold-spike note (from run 1, weak single sample)

maxMain 680 MB — low end of the 678–986 lottery band; boot-town variance makes one
session uninformative. The designed instrument is `decodeAdmission.peakLiveBytes`
cold-boot A/B (option E analysis, commit `81ad4891` message + agent report): the
entity-batch accumulator now shares planes with the cache, predicted ≈ halving of
that path's peak. Not yet measured.

## Next moves, in order

1. **Instrument the entity-owned pool**: count + byte-sum textures/materials
   registered via `registerOwnedTexture`/`registerOwnedMaterial` (entities.js
   :2681/:2685) across live entity instances; add `entMB` to `__diag` + the
   relay. Discriminator: `entMB` stepping at Swank while `matMB` stays flat
   confirms; then a skip-Swank route control isolates the POI. Note entity
   teardown DOES `dispose()` owned textures (:2932-2938) but `Texture.dispose()`
   frees GPU handles only — the JS bytes free on unreachability, so the question
   is which holder keeps dead entity instances (or their textures) reachable
   after leaving town.
2. **Fix the entity-owned lifecycle** once instrumented: share recolors by
   `(did, palette-key)` instead of per-wearer, and/or make despawn actually
   unreachable the texture objects. Expected to retire the 3.6 GB step.
3. **The settle age-collapse is now un-explained again** — it persists under a
   bounded cache (worse) and an unbounded one (17.1 s). With the MaterialCache
   mechanism dead, GC pressure from the entity-owned pool is the remaining
   route-cumulative suspect; re-test after move 2.
4. `matBudgetMB` stays **armable-but-off** (correct, tested instrument; wrong
   address for the killer). Do NOT arm a default; the 64 MB run doubles as the
   grey-surface/churn cost datum (~+7 s settle at museum-density).
5. Cold spike: `decodeAdmission.peakLiveBytes` cold-boot A/B for option E on a
   boot-town-matched pair, plus extend `bakeBatchMax` to the two entity fetch
   paths it never covered (option E analysis, `81ad4891`).

## Outstanding items (end-of-night 2026-07-26 ~05:30, post-retraction)

Where the remaining open work stands after the full night (see also
`RETRACTION-jsheap-step-2026-07-26.md`, `RESULTS-recolor-ab-2026-07-26.md`,
`DESIGN-recolor-residency-2026-07-26.md`). Everything through the dye→recolor
rename is merged and pushed (`9a6e2ade`).

1. **Settle age-collapse: mechanism OPEN again.** The GC-pressure-from-JS-heap
   story died with the retraction (real V8 heap ~50 MB). Facts that survive:
   collapse is session-age-dependent (armLong 17.1 s vs age-matched 9.8 s),
   worsens under matcache eviction churn (23.8 s at 64 MB), and is NOT
   surface-budget-related (ABAB). Remaining suspects: wasm-side caches/
   allocator behaviour at 680 MB residency, scene-graph growth, eviction/park
   churn. Instrument first: the fixed `jsV8Peak*` column plus per-pool byte
   tallies over an armLong pair.
2. **Wasm main 680 MB cold-boot residency** — now THE memory number that
   matters. Next probes: `decodeAdmission.peakLiveBytes` cold-boot A/B for
   option E (accumulator-sharing prediction, commit `81ad4891`), and extending
   `bakeBatchMax` to `fetchEntitySurfacesPixels`/`Batch` (`bake_worker_client`
   ~:972/:1044) — verdict 4's refutation never armed the entity legs.
3. **`palBudgetMB=64` default is provisional.** Live-verified gating (714 sigs
   @ 64 MB pinned, evictions flowing, boot clean) but the museum-density
   confirmation arm never landed (see 5). If a future Swank-cluster run shows
   heavy `palEvict` with visual fallback flashes, raise the default; escape is
   `?palBudgetMB=off` (legacy 256-count).
4. **LLM director call failures — genuine, undiagnosed.** During the eyetest
   soak `rynthAI` errored 5× on boot (plausibly CPU-starved timeouts) and self-
   disabled, but a post-restart call ALSO failed on an idle box (calls 6,
   errs 1) — so `minimax/minimax-m3` via OpenRouter has a real problem
   (candidates: model id drift, the GLM-style maxTokens/timeout needs from the
   soak-13 notes, provider routing). The stream ended before a console capture
   caught the actual error string. Repro: `rynthAI.checkNow()` with a CDP
   console listener attached.
5. **armSlim teleport wedge.** Both the fresh run and the resume hit
   `no-move dup` on all 22 POIs from Hotel Swank onward — `@teleloc` accepted
   but position never changed, session boots fine (ACE + wsbridge probe-proven
   healthy). Character/server-state bug (corpse-window family?); it blocked the
   slim build's museum-cluster datapoints. Investigate vendortest/+Vendbot…
   actually the battery char is tailnet1's — check the char's state in the
   shard DB before the next battery.
6. **Stream rig root-capture black** — since the 07-25 thermal reboot, root
   x11grab reads black while windows render (scanout bypass). Workaround
   shipped: `go_live-window.sh` (window-id capture, per-iteration re-resolve).
   Root cause unfound; if a later reboot fixes root capture, the original
   `go_live.sh` still works. STREAM-RIG-OPS.md step 1 (xrandr 720p) remains
   mandatory and was the first of two independent black-frame causes tonight.
7. **Retail-parity residency options B/C** (GPU-side composite per signature;
   shader palette lookup) — designed and ranked in
   `DESIGN-recolor-residency-2026-07-26.md` §2; deliberately not started.
8. **Housekeeping:** MEMORY.md is ~435 B over its self-imposed load budget;
   `tests_substitution::…composes_part_and_texture` fails on master (pre-
   existing, unrelated — triage separately); fresh worktrees need
   `external/chorizite` symlinks before Rust builds; the YouTube stream key
   used tonight passed through chat and disk — rotate it in Studio.

## Addendum — remote-play console triage (2026-07-26 morning, cloudflared session)

First real remote-player session on the merged build (serve.py + wsbridge over
two cloudflared quick tunnels; interactive login via `?bridge_url=`; flags
`clouds=on&rain=off&snow=off&lightning=off&textureScale=2&nosw=1`). Console
findings, triaged:

1. **`/dist/scenery/0x9FBF.scenery.jsonl` + `/dist/events/…` 404s — NOT bugs.**
   Landblock 0x9FBF has no `LandBlockInfo` record in the cell DAT at all
   (probe-verified: `0x9FBFFFFE` absent from `client_cell_1.dat`; ~33 blocks of
   the 0x9Fxx row likewise empty). The bake rightly emits nothing; the client
   fetches per-LB layers unconditionally and treats 404 as an empty layer.
   Cosmetic console noise; optional fix is a client-side manifest presence
   check before fetch.
2. **`[motion-link] no MotionTable link for attack 0x4d (stance 0x3d, mtable
   0x0900000C) on 0x8000cca7` — real data gap, minor.** NOT the known-benign
   `0x13xxxxxx` QuickEmote class: a swing-family command with no link in that
   creature's table for that stance ⇒ the swing anim silently doesn't play.
   Retail clamps/falls back (`retail-clamps-never-empties`); if frozen-mid-
   combat creatures get reported, add a stance-fallback chain to the motion
   linker. One creature observed, low priority.
3. **`[particle-owner] addEmitter failed: TypeError … 'morphAttributes' of
   null` ×4 — REAL BUG, unfixed.** `ParticleEmitter._meshFactory`
   (particle_manager.js:974) constructs `new THREE.Mesh` with a NULL geometry —
   the emitter's particle-model geometry failed to resolve (missing/failed
   GfxObj decode or a null cache return) and nothing guards it. Fail-soft
   upstream (owner_registry.js:182 catches), so the cost is a static's
   particle effect silently missing via `_runStaticParticleChain`
   (statics.js:4109). Two defects: the null-geometry source, and the factory
   not guarding null before mesh construction. JS-only fix; queued.

Session otherwise: remote play over the tunnels worked end-to-end (login,
world, combat), on the full night's merged build.

## Execution log — 2026-07-26 afternoon session (working the outstanding list)

Status key: ✅ done · 🔶 partial/narrowed · ⏳ in flight · ⛔ blocked-on-user.

**End state: all 8 outstanding items + both addendum code items worked to
completion or explicit closure.** Items 1, 2, 3, 4, 5, 8 done (1 = pair run +
analysis, mechanism now a two-suspect pre-registered intervention); 6 closed
workaround-permanent per user (no Xorg restart); 7 deliberately deferred by
design (unchanged); YouTube-key rotation dropped per user. Commits this
session (master, **unpushed**): `ff0634bc` test fix, `f1ac9e83` particle
guard, `16bb8fb8` bakeBatchMax entity legs, `a78d4c90` rynth-ai auth
hardening, `44597a5d` liveness abort, `c9496dfd`+`718be1c3` palRemint,
`b707d665` residency checkpoints, + this doc. Remaining user actions:
provision a new OpenRouter key (item 4). Next-session queue: the GC-vs-NOGC
armLong intervention (item 1), decoded-mesh-bytes lease column (item 2
follow-on), `sgEntities` one-liner, settle-criterion first-stop fix.

- **Item 8a ✅ MEMORY.md trim** — 24,835 → 23,954 B (budget 24,400). Lossless:
  the six §4 lines removed were already duplicated verbatim in
  `memory/recall-overflow.md` (the 2026-07-02 spill that never removed its
  sources); replaced with one `spilled-recalls →` pointer line.
- **Item 8b ✅ `composes_part_and_texture` triaged AND fixed** (`ff0634bc`).
  Not a code bug: the test predated the wire-TMChange semantic fix (TMChanges
  carry SurfaceTexture 0x05 ids, resolved through the part's Surface records
  into minted `tex_swap_alias_for` dids — the chain-shirt fix). It fed a
  Surface 0x08 did with no Surface record in the MockSource, so the swap
  correctly no-opped. Test now synthesizes the Surface record, swaps by 0x05
  ids, asserts the alias + its resolution. `cargo test -p holtburger-web
  --lib`: **197 passed / 0 failed** — master's lib suite is fully green.
- **Item 6 🔶 stream-rig root-capture black — narrowed, escalation is user's.**
  Probes this session: root reads pure black (mean 0.0) via BOTH x11grab and
  `xwd -root` ⇒ not an ffmpeg bug; persists with xfwm4 compositing OFF ⇒ not
  the compositor; persists across a 1080p→720p re-modeset cycle ⇒ not a stale
  mode. Per-window capture works. Fault is X-server-level screen-pixmap
  readback (modesetting+glamor on HD520) since the 07-25 thermal reboot. Next
  step would be an Xorg restart — **user declined (2026-07-26): it would kill
  the live desktop session; do NOT restart X.** CLOSED as workaround-permanent:
  `go_live-window.sh` is the capture path until a natural reboot; if root
  capture works again after one, `go_live.sh` is usable again.
- **Item 8c — YouTube stream key rotation: DROPPED per user (2026-07-26).**
- **Item 7 (options B/C)** — unchanged, deliberately deferred by design doc.
- **Item 5 ✅ armSlim "teleport wedge" — NOT a character/state bug.** Shard DB
  state for the battery char (`+Tester2`, 0x5000011E, acct tailnet1) is fully
  clean — no corpses, no PK timer, no stuck flags; `Teleporting` is never
  persisted. Root cause: a SECOND `tailnet1` login at 03:51:36 (another
  browser session on the box) triggered ACE's `account_login_boots_in_use`
  eviction (`AuthenticationHandler.cs:182-193`); after its retry won, every
  battery packet was discarded by the endpoint check
  (`NetworkManager.cs:152-155`) — `@telepoi` never reached a handler, and the
  WS↔UDP bridge gave the page no close signal. Correction: first lost stop was
  **Sawato** (19 consecutive losses Sawato→Zaikhal); `Hotel Swank`/`Swank`/
  `NightClub` no-move dups are the harness's legitimate duplicate-POI class
  present in every healthy run. Verified live: 6/6 teleports incl. the Swank
  cluster; char re-parked at Samsur; nothing changed in DB/ACE. Re-wedge risk:
  recurs ONLY under concurrent same-account logins — mitigations: (a)
  dedicated battery account via `HARNESS_ACCOUNT`/`HARNESS_PASSWORD`
  (boot.mjs:75-76), (b) harness liveness-abort instead of `no-move dup` on
  frozen pose (queued for the next battery run), (c) optional
  `account_login_boots_in_use=0`.
- **Addendum item 3 ✅ particle null-geometry bug fixed** (`f1ac9e83`). Root
  cause is DATA, not a race: the four live `zero-tri` setups (e.g.
  `0x02000363` → GfxObj `0x010008A8`) are pure light/emitter ANCHOR objects —
  their only polygon is `NoPos`-stippled, so the decoder correctly emits zero
  triangles and `meshToGeometryGroups` yields no geometry; retail doesn't draw
  them either (same family as the 2026-06-20 null-material white-box guard).
  Guard added in `addEmitter` + meshFactory with one rate-limited warn per
  (emitter, gfxobj); `test_particles.mjs` 58→64/64; boot smoke 0 errors.
- **Item 2b ✅ `bakeBatchMax` now covers the entity decode legs** (`16bb8fb8`).
  `fetchEntitySurfacesPixels` uses the A16 wave split;
  `fetchEntitySurfacesPixelsBatch` gets a group-boundary-preserving splitter
  (`splitEntityBatchGroupWaves` — flat cuts would desync the five parallel
  arrays; bound is `max(N, longest group)`). Unarmed path byte-identical;
  urgent + main-thread fallbacks untouched. Live proof at `bakeBatchMax=8`:
  entity-leg submissions 15→27. Note: the `Batch` leg is unit-covered but not
  live-exercised at the boot spawn (F.41 pre-warm doesn't fire there).
- **Item 4 ✅ LLM director failures diagnosed — the OpenRouter key is REVOKED.**
  Captured error (journal + live repro): `HTTP 401 {"error":{"message":"User
  not found.","code":401}}` on every call since the last good plan 07-24
  20:44. NOT model-id drift (`minimax/minimax-m3` live, 1M ctx), NOT provider
  routing (novita/minimax pin valid), NOT maxTokens/timeout (GLM-style tuning
  already applied + confirmed on the wire), NOT rate/credit. ONE cause for
  boot+idle failures — "calls 6, errs 1" was a misread: `calls` counts
  attempts, panel `errs` is the CONSECUTIVE counter reset by re-arm; all six
  failed. Undiagnosable before because LlmClient/director logs were no-ops —
  failures lived only in the localStorage journal. Fix `a78d4c90`: auth
  (401/403) is terminal on the FIRST strike with an actionable journal
  message; LLM failures now hit the console (`[rynthAI] …`); 86/86 tests.
  Client path proven end-to-end vs the mock LLM server (2× checkNow → 200 →
  parsed plan → executed). ⛔ REMAINING USER ACTION: provision a new
  OpenRouter key (`rynthAI.setKey(…)` in the rig profile + update
  `/mnt/wbterminal2/stream/.keys/openrouter-key`) — until then the director
  is dead on arrival (and now says so immediately). Operator notes: the
  breaker does NOT survive `?bot=1` reconnect re-arms (only `rynthAI.stop()`
  latches), and `?botInterval=0.5`+`maxCallsPerHour=70` ⇒ ~70 calls/hr floor.
- **Addendum item 1 (404-noise manifest check): WONTFIX-for-now, verified** —
  `dist/manifest.json` (v2) has no per-LB layer enumeration and `_health.json`
  is layer-level only; a presence check would require changing the bake,
  which is out of scope. Console noise stays cosmetic.
- **Item 1 ✅ settle age-collapse: instrumented pair run, field narrowed to
  two suspects, decisive intervention designed.** armLong vs 5-session
  age-matched control, 58 landed stops each, full instrument set (raw:
  `/mnt/wbterminal2/settle-age-pair-2026-07-26/`; new default-OFF battery
  instruments `--sceneCensus`/`--checkpointEvery`, commit `b707d665`).
  - **The collapse is a THRESHOLD at ~stop 40, not a drift**: paired-by-POI
    settle ratio 1.14 through stop 39, **3.24** from stop 40 (per-decade
    paired deltas −0.1/+0.0/+0.6/+0.0/+7.3/+5.8/+32.1 s). Same work, more
    time: streamed bake units per stop identical (+7% route total), settle
    per work-unit 1.0→1.54→2.99. First-stop settle floor confirmed (N=1
    excluded; criterion fields stamp at +14–18 s).
  - **Exonerated**: decode/re-decode churn (sdTot/sdDids = 1.000 everywhere),
    renderer RSS (falls late-route), main wasm (pinned 680 MB from stop 1 —
    the "residency" number never grows in-session), surface+pal cache bytes
    (budget-pinned), scene-graph size (rho ≈ 0 despite 4×), LRU resident
    count.
  - **Standing, inseparable by correlation** (the collinearity trap again —
    every route-cumulative metric scores rho ≈ .33): **H1 major-GC cost
    scaling with live JS heap** (honest post-GC V8: 16 → **310 MB** in one
    session, resets every control boot; only large non-ArrayBuffer grower)
    and **H2 landblock-LRU park/evict bookkeeping** (evicted 0 in the ENTIRE
    control vs **4,108** in armLong; parked 118 → 5,578; consistent with the
    matBudget=64 churn datum).
  - **`jsV8PeakMB` mystery RESOLVED — retire or rename the column**: precise
    `usedJSHeapSize` read 9,462 MB against a 2,144 MB heap limit and 3,284 MB
    whole-browser RSS — it is V8's external-memory ledger, a monotone
    ALLOCATION ODOMETER (ArrayBuffers registered on alloc, never decremented
    across worker transfer), not residency. Honest V8 = `Runtime.getHeapUsage`
    after `collectGarbage`; footprint = renderer RSS. (Item-3's 866→1,921 MB
    reading was the same odometer.)
  - **Next experiment (pre-registered, ~1 h, no new code)**: armLong ×2 —
    arm GC `--checkpointEvery 1` (forced full GC per stop, outside the settle
    window) vs arm NOGC. Late-route ratio collapsing toward 1.0 ⇒ H1
    confirmed (fix = drop the geometry/material retainers parked LBs hold);
    unchanged ⇒ H1 refuted by intervention, H2 owns it (follow with
    `?fixedGridPark=off` + `?lbCap` sweep). Caveats on record: checkpoint
    GCs 8 vs 13 (mild pro-control bias); `sgEntities` column dead (reads 2D
    `entityMap` before the 3D fallback — one-line fix next touch).
- **Item 2 ✅ cold-spike probes both executed — verdicts in, with mechanisms.**
  Cold-boot A/B (6 boots, acct tailnet1-baseline, spawn `0xCE940035`, fresh
  profile each; raw: `/mnt/wbterminal2/optE-coldboot-ab-2026-07-26/`):
  - **Instrument finding first**: `decodeAdmission.peakLiveBytes` is
    structurally INVARIANT to option E — the only site that revises with
    decoded bytes charges plane LENGTHS (lib.rs:10962), which E preserves
    byte-identically; the entity/mesh/building lease sites never `revise()`
    at all (wire-estimate only). The "≈halving" prediction targeted a blind
    instrument. Measured: main peakLiveBytes 51,120 B bit-identical in all
    six boots.
  - **Option E's real effect**: bake-worker wasm high-water 92.0 MiB (E) vs
    104.0 MiB (E surgically reverted on HEAD — a `81ad4891^` worktree build
    would have confounded 4 other memory-relevant commits) = **−12 MiB /
    −11.5%, ranges disjoint at n=2**. Main wasm unmoved (380–382 MiB in every
    arm): main never runs the decode path E touches — the 678–986 MB main
    spike is NOT option-E-addressable, and decode admission explains ~none of
    main's residency (peakLiveBytes 51 KB, shardCache 43 MB vs 381 MiB).
  - **`bakeBatchMax=16` on the now-covered entity legs: refutation
    RECONFIRMED, mechanism found** — the flag bites (worker admits 156→217)
    but the wasm already splits `fetch_surfaces_pixels` internally at
    `SURFACE_BATCH_SPLIT_CHUNK = 16` (lib.rs:9761), so a 16-DID JS cap is a
    no-op for the dominant funnel; worker peak = 1–2 such chunks exactly.
    Moving it needs `bakeBatchMax < 16` or a smaller internal chunk.
  - Live `pkg/` restored byte-identical (sha `fcbefe2f`, post-restore smoke
    boot in arm-A band). **Identified next instrument** (future session, not
    in tonight's scope): main's 8.4–9.0k admits are `fetch_model_meshes`/
    building leases charged by wire estimate and never revised — a decoded-
    mesh-bytes column there is the missing probe for main's 680 MB.
- **Item 3 ✅ `palBudgetMB=64` CONFIRMED as default at museum density.**
  Swank-cluster A/B (14 stops, 4× Hotel Swank incl. evict-then-return, fixed
  40 s dwell; raw: `/mnt/wbterminal2/palbudget-museum-2026-07-26/`): the
  raise-trigger did NOT fire — 64 arm ended 58.35 MB / 555 sigs with
  **0 evictions, 0 remints, 0 fallback events**; the `off` (count-cap) arm
  capped at 28.3 MB — 20 MB BELOW the 48.7 MB museum working set — paying 386
  evictions + **89 remints** (wearers re-rendering unrecolored = the headless
  form of the fallback flash). ~105 KB/signature measured (design est. ~100).
  Churn cost: none either way (palQuiet 110.6 s vs 107.3 s) — unlike
  matBudget's +7 s. New instrument `palRemint` (`c9496dfd` bounded FIFO of
  evicted keys + counter, 101/101 tests; relay column `718be1c3`). Watch
  line: a route holding two Town-Network-class hubs concurrently showing
  `palHiMB`→64 with `palRemint`>0 is the signal to raise to 96 MiB.
  ⚠ Two harness findings for item 1: (a) battery settle inference reads
  `liveScene3d` fields that stamp ~20 s post-in-world — on a fast boot every
  early stop "settles" at the 3 s floor (short-dwell arms are silently
  wrong; museum run used a fixed-dwell driver `museum-arm.mjs` instead);
  (b) precise `jsV8PeakMB` reads 866→1,921 MB over one 14-stop session,
  identical in both arms — ~40× the retraction's CDP-measured ~50 MB "real
  V8 heap"; instrument discrepancy unresolved, live lead for item 1.
- **Item 5 mitigation (b) ✅ battery session-liveness abort** (`44597a5d`,
  31/31 unit tests). Signal: `sessionLastRecvAgeMs()` — wasm transport stamps
  `last_recv_instant` at exactly one site (lib.rs:38956, inbound frames only),
  truthful on `?nullRender=1`, no `__diag` needed. A no-move stop with
  freshest-inbound-frame age ≥15 s (`--recvDeadMs`) counts toward a 3-stop
  streak (`--sessionLostStops`) → abort with **exit code 4** (deliberately not
  3 — the wrapper's `--resume` arm must not re-login into the eviction fight),
  `abortReason:"session-lost"`, loud stderr line. Legit duplicate-POI dups
  (server traffic flowing) never count; existing fields/log-lines unchanged,
  new fields additive (`deadNoMoveStops` is the early-warning column). Replay
  of the Sawato→Zaikhal wedge aborts at stop 3 instead of wasting 16 stops.
  Operator note: rows with `sessionLive:false` must be discarded before a
  manual `--resume`.

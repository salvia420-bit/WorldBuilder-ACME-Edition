# task-T4-EYES — clearing the blocked 1070 queue on the Tesla T4 box

**Session:** 2026-08-11, autonomous Opus agent driving `buildbox` from the laptop.
**Rig:** GCE spot `n1-standard-4` + **Tesla T4**, Debian 12, driver 550.54.15, Google
Chrome 151 headless (`--headless=new --no-sandbox --use-gl=angle --use-angle=gl-egl`),
fresh `--user-data-dir` per arm, puppeteer-core over CDP :933x.
**Renderer string read inside the live client, every arm:**
`ANGLE (NVIDIA Corporation, Tesla T4/PCIe/SSE2, OpenGL ES 3.2)`.

> **GPU-FAMILY CAVEAT ON EVERY VERDICT BELOW.** This is a T4 / Linux / EGL arm, not
> the 1070. **Owner ratification is owed on all of it.** Anything that smells
> preset- or GPU-dependent is called out in place.

**Evidence:** `box:~/eyetest/out/` — 24 arm JSONs (`arm-<arm>.json`, full step values +
console capture + failed-response list), 102 GL frames (`<shot>-gl.png`), per-arm
console logs (`console-<arm>.log`). 343 MB total. 13 story frames taildropped to the
redmi as `01-..13-*.png`.

---

## 0. Preconditions actually verified (not assumed)

* **Dist:** `HOLTBURGER_DIST=$HOME/holtburger-dist-v4 python3 scripts/serve.py --check`
  → `--check OK: all required layers present` — `shards 263 / scenery 65025 /
  spawns 38153 / events 80397 / index 1 / packs 256 / manifest.json 1`, wasm 6.4 MB
  release-shaped. The laptop-side rsync was still mid-flight at session start
  (scenery 62 k/195 k, **spawns MISSING**); I waited it out and re-checked rather than
  starting my own copy. `--allow-missing` was never passed and the server was never
  started on a partial dist.
* **Tunnel:** `ws://127.0.0.1:8080` up at session start and still up at report time.
* **Repo:** box at `917d1539`, a clean ancestor of the laptop's `4cf6701c` (the six
  newer commits are all movement-oracle work, untouched by these items). The punch
  fix `b97b9ee1` is in the box tree.
* **Accounts:** `agentp07` / `agentp10` only, alternating, never `tailnet1`.

---

## 1. Verdict table

| item | kind | verdict |
|---|---|---|
| OFF-ARM-BOOT | probe | **CLEAN** |
| PORTAL-SWIRL-RENDER `followUp1070` (brief TEST 1) | eye | **PASS** |
| punchSidedness on/off/heuristic (brief TEST 2) | eye | **PASS with caveat** |
| PORTAL-P0-VALIDATE A / B / C / D | eye+probe | **not-reproduced / CLEAN / inconclusive / mixed** |
| RELIEF-EYE | eye | **CLEAN on measurement, eye-imperceptible** |
| E6 (GATE-POOLS) | eye | **INCONCLUSIVE** — 1 assertion not demonstrated |
| E1-TCO-ARM | eye | **PARTIAL** — C1 confirmed on counters |
| T128-INTERIM-EYE | eye | **BLOCKED** — asset tier absent from the dist |
| CTX-LOSS-MIRRORS | probe | **DIRTY** — `mirrorRestoreFailed = 6` |
| TEXWORKER-INTERLEAVE | bench | **SKIPPED** — 1070-baseline-bound |
| MOVE-FIX-BASELINE | bench | **SKIPPED** — baseline-creating for the 1070 |

Full per-item counters, arms, assertions and screenshot paths are written into the
rows of `docs/reengineering/queue-1070/batch-D-2026-08-10.json`.

---

## 2. The two headline results

### 2.1 PORTAL-SWIRL — the owner-registry fix is real (PASS)

Arm-identical parked camera at the Yaraq town portal
(`@telepoi Yaraq` → `@teleloc 0x7D640025 103 100 12.0` →
`__cam.orbit(24103,19306.8,13.2,14,180,12)`), A/B on `?particleOwnerPending`:

| | emitters carrying info `0x320002CD` | live particles | totalEmitted | eye |
|---|---|---|---|---|
| **default (ON)** | **3** | 10 / 12 | 295 → **484** over 30 s | bright additive purple swirl |
| **`=off`** | **0** | – | – | **bare pedestal** — crystals only |

The 30-second frame is still swirling and the swirl has visibly **rotated to a new
phase**, so it persists rather than freezing. The 3-vs-0 split reproduced on all four
independent boots of the pair. This matches the 2026-08-10 laptop-HD520 validation
exactly, now on NVIDIA hardware.
Frames `01`/`02`/`03` in the taildrop.

### 2.2 CTX-LOSS-MIRRORS — first live test of the rehydrate path, and it FAILS (DIRTY)

Settled `texCompressedOnly + texWorkers + terrainT1024` arm, forced
`WEBGL_lose_context.loseContext()` → 5 s → `restoreContext()` → 35 s settle.

The renderer **recovers** (`isContextLost()` false, 6 866 meshes, 124 terrain LBs) but
the mirror gate does not:

```
mirrorsArmed 30 · mirrorsFreed 6 · mirrorReleaseDeferred 3
mirrorRestores 0 · mirrorRestoreFailed 6          ← gate demands 0
```

with the console trail naming the casualties:

```
[webgl-recovery] context RESTORED after 5092ms — rebuilding subsystem GPU state
[tex-rehydrate] context-restore #1: re-supplying pixels for 6 released texture(s)
[tex-rehydrate] MISS 0x6003A66:texFull owner=texCompressedOnly:full
                — rehydrator returned false; this texture will render BLACK   (×6)
[tex-rehydrate] pass finished with 6 MISS(es) in 3ms (rehydrated=0 skipped=0 gcd=0)
```

Six of six released full-tier textures failed to rehydrate. A forced loss on T4/EGL
may not mirror a real-world loss exactly, but *a rehydrator returning false* is a code
path failing, not a GPU artefact. Note the literal gate in the queue names
`__terrainBc7Stats.mirrorRestoreFailed`, which is **vacuous on this dist** (terrain
ladder absent, §3.3); the failure is in the live full-tier path
(`__bc7Stats()` / `__texStats().mirrors.release`).

---

## 3. The rest, briefly

### 3.1 punchSidedness — the real `portal_side` flag behaves (PASS with caveat)

Three arms at identical parked vantages on the Yaraq blacksmith:

| arm | offered | kept | dropped.backface |
|---|---|---|---|
| `off` (default, kill path) | 22 / 22 / 24 | 22 / 22 / 24 | 0 |
| `=on` (real retail `portal_side`) | 22 / 22 / 24 | 14 / 12 / 16 | **8 / 10 / 8** |
| `=heuristic` (round-5 AABB inference) | 22 / 22 / 24 | 22 / 22 / 24 | 0 |

The brief's bar is *"the ON arm must not DROP apertures the OFF arm keeps"*. It drops
8–10 as back-faces — and the **eye at the identical overview vantage shows the same
interiors rendering in both arms** (frames `04`/`05`), so those rejections are
redundant back-facing polygons, not needed apertures. The heuristic arm rejects
nothing at these vantages, i.e. the real flag is strictly more discriminating than the
inference it replaces. `absent === off` was re-confirmed from `cells.js`
`PUNCH_SIDEDNESS_MODE`, so no separate bare arm was needed.

### 3.2 PORTAL-P0-VALIDATE

* **A (Yaraq punch)** — punch structurally alive (`gates.losSunkenExempt: true`,
  `offered` 9–47). `punchLosSunken` ON vs `=off`: **`dropped.terrain` identical** (1 at
  one vantage, 0 elsewhere) — the same null differential the laptop rig reported.
  **The grass-over-sunken-interior defect did not reproduce** at any outdoor vantage
  that rendered (frames `04`/`05`/`06`: forge, oven, barrels, NPCs all visible, no
  grass over them). *Limitation:* 4 of 5 ground-level orbits (25–30 m, el 18–25) put
  the camera **inside** Yaraq's dense building block and rendered black; only el ≥ 38
  vantages are judged. A true street-level T4 vantage is still owed.
* **B (envcell ring)** — **CLEAN.** Default `envCellLoadedLbs.size` 7 → 9 with keys
  forming the neighbour ring around the player LB `0xa9b4`; `&envcellRing=off`
  collapses to 0 → 1; **zero** `PVS loadEnvCellsForLandblock failed` lines.
* **C (watchdog)** — **INCONCLUSIVE, my fault:** I deleted the set's first element,
  which was an *outdoor* ring LB, not the player's indoor LB, so no re-fire was owed.
  What did hold: exactly **one** `[cell-watchdog] indoor cell 0x7d640100 in unfetched
  LB 0x7d640000` line fired naturally — no 2 Hz storm. Redo with the player's own LB.
* **D (direct seal)** — assertions fail, picture is clean. `_indoorSplitArmed: true`
  but `_directPortalSealPass` reads **null** and `_portalSealDiag` is
  `{kept: 0, dropped:{straddle: 4}}` against an assertion of `kept > 0`. The diag *is*
  being stamped, so the pass runs; `liveScene3d` is a one-time init3D snapshot, so the
  null pass reference may be a stale read rather than a missing pass — flagged, not
  resolved.
  **The third datapoint the queue asked for:** standing inside `0x7d640100`, the
  interior renders **correctly** on the T4 — flagstones, platforms, NPCs, walls, with
  outdoor grass visible only through the doorway (frame `07`). The laptop-HD520
  "grass overpaints the interior floor" bleed is **not reproduced**. That agrees with
  the owner's rig and disagrees with the Mesa/Intel rig, so **the indoor bleed looks
  GPU/driver-specific to Mesa Intel, not a client defect** — and it renders clean even
  with the seal keeping 0 apertures, i.e. the seal is not load-bearing here.

### 3.3 RELIEF-EYE — the differ says yes, the eye can't see it

Trap gate satisfied by console rather than by diag: arm a logs
`[geomBundles] armed … (relief variants ON)` with **no** `0 GEOMR rows resident`
warning (that warning is unconditional when rows are 0), so `variantRowsResident > 0`.
*`__diag.geometry.relief` is unusable as the gate* — `diag/geometry.js` installs its
`gfxRelief` gate **over** `geom_bundles`' `_stats`, so it is the gate function in every
arm. Worth fixing in the diag, or the queue's assertion can never be read literally.

Arms a/b/c at an identical anchor (player world pos `32532, 34567.1, 94`). No human
could separate the frames, so I measured them (RGB diff, % pixels differing > 8):

| vantage | a↔c (both relief) | a↔b | b↔c |
|---|---|---|---|
| overview (60 m, el 45) | **1.60 %** | 7.60 % | 8.15 % |
| street (22 m) | **13.6 %** | 18.0 % | 21.6 % |

Same ordering at both vantages: the two relief-bearing arms are far and away the
closest pair and both stand off the flat arm — which is exactly the checklist's
*"protrudes on a and c, flat on b"* + *"a vs c: rails visually identical"*.
An interior close-up pair (both arms independently picking the **same** mesh
`surface-08000660`) differs by 0.18 % — a positive confirmation of D2 *"interiors are
FLAT BY DESIGN"*, not a miss.

Why nothing protrudes to the eye is **not** a defect: `gfxSubdivLevel` is 0 on every
tier (per-texel displacement retired 2026-07-30), `reliefBundles` refuses to arm above
level 0, and variant rows are **sparse — 83 of 796 distinct GfxObjs**. A randomly
chosen tudor wall most likely carries no variant. **To make this a human eye test,
shoot a model known to carry a GEOMR row.**

### 3.4 E6 — nine of ten assertions pass, one does not

PASS: `classesCreatedPostBoot 0` (+`sealed true`), `mutationsThisFrame 0` ×3 reads,
classes 17 (≤ 63), pools 46 town / 12 dungeon (≤ 300), `heldOutNoRsId 0`,
`heldOutRetired 46` stable, **`refeedFormatMismatch 0`** (the cached-record race did
not fire), `refusedBakedMissing 0`. Kill arm: `__diag.pools()` → `{enabled:false}` in
town *and* dungeon.

**NOT DEMONSTRATED:** *"`heldOutByReason.offPage` CLIMBS then `reOfferAdmitted`
FOLLOWS"*. offPage held-out went 203 → 205 while `reOfferAdmitted` stayed flat at 32
and `reOfferedByReason` carried only `bc7Pending: 192`. No offPage re-offer was seen
draining. **UNVERIFIABLE BY NAME:** `envcells.visible === containersVisible` — this
census has no `containersVisible` key (actual envcells block recorded in the queue).
Per *BLOCKED-with-evidence beats a soft verdict*, this is **not** a CLEAN.

### 3.5 E1-TCO-ARM — C1 confirmed on counters, the softness eye is not closable here

`deferredNodes` **329 (tco) vs 453 (plain) = −27 %**, `singletonUpgrades` 435 vs 483,
`atlasLayers` 68 vs 64 — C1's predicted deferred-shrink reproduces on the v4 dist.
`texRefPageKeyed = 965 (> 0)`, `texRefAbsent = 0`, `__texStats().mirrors.records 274`.
The *"does it sharpen"* half compares against archived **1070** pairs; a T4-vs-1070
sharpness comparison is not sound, so arm-identical T4 tco-vs-plain frames are
archived instead. **Flag:** `fullFailed = 18` on the tco arm is non-zero and
unexplained.

### 3.6 T128-INTERIM-EYE — BLOCKED on the dist, not the client

`__terrainBc7Stats().ladder` = `{mode:"absent", armed:false, promotions:0}`,
`lastError: "scene3d/assets/terrain_bc7/t512: HTTP 404"`. The v4 dist carries **no**
`scene3d/assets/terrain_bc7` tier, so `?terrainT1024=512` has nothing to promote and
there is no t128 interim to eye. Re-queue once such a dist is staged.

### 3.7 Benches skipped, deliberately

`TEXWORKER-INTERLEAVE` and `MOVE-FIX-BASELINE` are frame-timing work whose acceptance
argument is *comparison against a 1070 baseline* (and in the second case, **creating**
that baseline). Producing either number on a GCE spot n1-standard-4 + T4 under
headless ANGLE/EGL would be worse than producing none. Both stay queued for the 1070.

---

## 4. Box friction worth keeping (runbook material)

1. **`page.screenshot()` photographs a BLACK world.** The client renders ~21 passes
   per frame; only the **last** targets the default framebuffer, and three.js builds
   its context with `preserveDrawingBuffer:false`, so for ~20/21 of every frame the
   default FB holds nothing but the clear colour (a flat `meanLuma 1.72`). The
   compositor snapshot and an idle `toDataURL` both catch that window. Forcing
   `preserveDrawingBuffer:true` via `evaluateOnNewDocument` is **not** sufficient.
   **What works:** hook `renderer.render`, and on the call where
   `renderer.getRenderTarget() === null`, `gl.readPixels` the drawing buffer
   *synchronously inside that call*, flip it (GL is bottom-up), force alpha opaque.
   Every frame in this session was captured that way and carries its own
   `nonBlackPct` / `meanLuma`, so a black frame is self-evident in the JSON.
2. **`?renderScale=1` is mandatory for eye work.** `adaptiveRes` had silently pinned
   the backing store at **448×280** stretched over a 1280×800 element. Pinning
   `renderScale` disables adaptiveRes and restores 1:1.
3. **Same-account re-login inside ~3 minutes is fatal.** ACE logs
   `Account was logged in, booting` and the *new* handshake dies with
   `no CharacterList within 30s`. Closing Chrome does not log out — ACE reaps by
   network timeout ~2-3 min later. Alternate two bots **and** keep ≥ 90 s between
   arms; the harness also got `--loginRetries`-style retries (reload + 60 s gap),
   which rescued the lossy-tunnel handshake drops.
4. **`pkill -f <pattern>` over SSH self-kills the session (exit 143/255)** when the
   pattern appears in your own command line — including the bracket trick, since your
   command line contains the literal. Kill by PID resolved from `ss`/`pgrep` inside a
   **script file** whose name doesn't match the pattern (`stopdrv.sh` here).
5. **`rg -rn 'foo'` is the `-r ln` trap in disguise** — `-r` ate `n` as the
   replacement and rewrote every match to `n`, which is how `?particleOwnerPending`
   first appeared as `?n`. Use `rg -n`.
6. **Camera anchors from the queue are not gospel.** `MOVE-FIX-BASELINE`'s anchor
   `25171,20344,42.0` is **not** where `@telepoi Holtburg` lands (LB `0xa9b4`, world
   `32532, 34567, 94`) — parking there put the camera ~10 km away in unstreamed void.
   Derive the anchor at runtime from `__cam.world()` after the POI teleport; it is
   deterministic per POI, so arms stay identical (verified: same anchor to 0.01 m in
   every arm, and the wall picker independently chose the same mesh in both arms).
7. **Dense towns eat low orbits.** Around the Yaraq smithy, 25–30 m orbits at
   elevation 18–25 put the camera inside the building block (`nonBlackPct 0`).
   el ≥ 38 clears the roofs. Always shoot an unparked follow-cam frame first as a
   safety net.
8. **Three 404s per arm are expected on this dist** and are the *only* console errors
   in every clean arm: `terrain_bc7/t1024/manifest.json`, `terrain_bc7/t512/manifest.json`,
   `pbr_terrain/manifest.json`. Zero `pageerror` in every arm.
9. **`__diag.geometry` has two competing installers** (see §3.3) — the bundle stats
   are unreachable through it.

---

## 5. What is still owed

* Owner ratification of every verdict above (T4, not 1070).
* RELIEF-EYE close-up on a **GEOMR-variant-bearing** model.
* E6's offPage → `reOfferAdmitted` drain: adjudicate whether the assertion is stale
  for this census or needs a page-turnover vantage.
* PORTAL-P0-VALIDATE **C** redo with the player's own LB as the watchdog victim.
* PORTAL-P0-VALIDATE **D**: is `_directPortalSealPass` a stale snapshot read, and is
  `sealDiag.kept 0` with 4 straddle drops correct for this interior?
* CTX-LOSS-MIRRORS: file the 6 rehydrate MISSes as a defect.
* A ground-level Yaraq street vantage on a real GPU.
* The two benches, on the 1070.

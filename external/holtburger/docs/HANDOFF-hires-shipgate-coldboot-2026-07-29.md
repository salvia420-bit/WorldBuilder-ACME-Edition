# HANDOFF — hires dist ship-gate + 1070 cold-boot A/B + 10-stop tour (2026-07-29 evening)

Continues X-track #20 (`/mnt/wbterminal2/holtburger-dist-hires/HIRES-DIST-REPORT.md`).
The hires dist itself stays **off-repo** by design; this file is the repo-side
record of the gates and measurements, which had none.

---

## 1. Ship-gate — both §5 caveats cleared

### 1.1 Release wasm
`pkg/holtburger_web_bg.wasm` **16,745,602 B (dev) → 4,972,623 B (release)**.
`capped-build wasm-pack build --target web --out-dir pkg-R --release`, exit 0
(`Finished release [optimized] in 1m 49s`, 4m 41s total with `wasm-opt`), then
`rsync -a --delete pkg-R/ pkg/`; `cmp` confirms byte-identical.

**A fresh build was required, not hygiene.** `pkg-rel/`, `pkg-N/`, `pkg-L/`,
`pkg-D/` are all release-shaped but date to 2026-07-28, while
`apps/holtburger-web/src/texture_overrides.rs` + `lib.rs` changed 2026-07-29
12:34–12:39 (`f350c159`, the statTexOverride wasm layer). **Every existing
release dir predates the override code.** `serve.py --check` now reports
`release-shaped` on both roots and the stale `stale_vs_rust_commit` flag is gone.

### 1.2 `--verify-boot-reachability` — PASSES
```
boot-reachability: landblock=0xA9B4 fully_packable=true reachable=344 missing=0
dat-shard: boot landblock 0xA9B4 is fully packable (visual chain) ✅  EXIT_CODE=0
```
No standalone binary exposes `verify_boot_pack` (`apps/holtburger-tools/src/boot_verify.rs`
— only `dat-shard` and one integration test call it), so a full rebake was the
only route, as §3 assessed. Gate bake: 11m25s, peak RSS 1.78 GiB (`VmHWM`
polled — **`/usr/bin/time` does not exist on this box**; a first attempt no-op'd
in 17s on `env: '/usr/bin/time': No such file or directory`).

### 1.3 The bake is bit-reproducible
Baked to a **separate** dir and compared, so "fully packable" describes the real
dist's bytes rather than a sibling's: `boot.hba` sha256 `3072a39e…` on both and
equal to the recorded value; all 4 `manifest/*.bin` catalogs byte-identical;
**885,155 files + 885,161 symlinks**; `manifest.json` differs only in
`generated_at`. Identical catalogs ⇒ identical shard hashes by construction.
Inputs re-verified 5/5 (`sha256sum -c bake-source.sha256`), base DAT still
`dc6e500b…` — `bake-base-dats-only` honoured.

---

## 2. Cold-boot A/B on the 1070 — REAL GPU, both arms clean

Fresh chrome profile per arm (shader + HTTP cache otherwise warms arm 2), 65s
quiet gap between arms for ACE's 60s session reap, `?nosw=1`,
`ANGLE (NVIDIA GeForce GTX 1070 … Direct3D11)` asserted both times,
**0 console errors both arms**.

| metric | live | hires | Δ |
|---|--:|--:|--:|
| `boot.hba` bytes | 1,972,432 | 11,339,312 | **+9,366,880** |
| `boot.hba` download | 226 ms | 1,148 ms | +922 ms |
| ms → in-world | 8,197 | 12,517 | +4,320 |
| ms → `ready` | 14,289 | 15,136 | +847 |
| ms → populated scene (>100 meshes) | 57,742 | 58,789 | +1,047 |
| shards fetched | 867 | 780 | −87 |
| shard bytes | 40,012,943 | 41,488,113 | +1,475,170 |
| total wire bytes | 128,377,336 | 149,360,165 | +20,982,829 (+16.3%) |
| FCP | 5,056 ms | 7,468 ms | +2,412 ms |

### 2.1 The double-fetch is a cache hit, not a second download
`index.html` fetches `boot.hba` twice — main-thread wasm init plus the bake
worker's own instance (prewarm re-fetch + sha256). Network events show the
second fetch returning **content-length 0 in both arms**, i.e. served from cache.
It does not double the wire cost.

### 2.2 This reframes the boot.hba worry (§7.4 / task "boot.hba 5.75x")
`boot.hba` is **~1.5% → ~7.6%** of cold-boot wire bytes. The 5.75× headline is
real but small in context; the dominant costs are elsewhere: `eor-cell.bin`
15.35 MB, ~48 shards of exactly 1,048,600 B (~50 MB) landing at 41–44 s, terrain
normal maps ~9.5 MB, scattering EXRs ~7.7 MB, `spells-catalog.json` fetched
**twice** at 1.77 MB each. Recommendation: shipping as-is is defensible; the boot
pack is not the first place to trim.

**Honest limits:** n=1 per arm and streaming is nondeterministic (867 vs 780
shards), so only the +9.37 MB `boot.hba` delta is deterministic — the +16.3%
total carries real variance. Everything ran over an **SSH reverse tunnel from the
laptop**, so absolute times reflect that link, not deployment bandwidth. Byte
deltas trustworthy; time deltas indicative only.

### 2.3 Harness trap found (cost one invalid run)
`performance.getEntriesByType('resource')` **silently caps at 250 entries** by
default. The first run reported 105 KB for an entire cold boot because `boot.hba`
and the wasm had been evicted from the timeline. Fix: `addInitScript` →
`performance.setResourceTimingBufferSize(30000)` **before** any fetch, and
account bytes from CDP response events too, which no buffer can drop.
Also: `bootState` order is **`form-shown → connecting → spawning → in-world →
ready`** — `ready` arrives ~6 s AFTER `in-world`, so breaking a poll at
`in-world` yields `msToReady: null` (confirms the MEMORY.md warning).
`kickDance` is a **removed** flag (lint fails re-emitters); use `?maxRetries=N`.

---

## 3. 10-stop screenshot tour (hires dist, real GPU)
`/mnt/wbterminal2/hires-tour-2026-07-29/` — 10 × 1600×900 PNG + `tour.json`,
**0 console errors**. Taildropped to `redmi-note-13-5g`.

| # | POI | landblock | meshes | baked LBs |
|--:|---|---|--:|--:|
| 1 | Holtburg | 0xa9b40019 | 2,916 | 121 |
| 2 | Town Network (interior) | 0x70143 | 1,944 | 127 |
| 3 | Shoushi | 0xda55001d | 3,751 | 143 |
| 4 | Yaraq | 0x7d64000d | 5,690 | 276 |
| 5 | Sanamar | 0x33d90015 | 6,975 | 292 |
| 6 | Cragstone | 0xbb9f0040 | 5,241 | 415 |
| 7 | Zaikhal | 0x80900013 | 5,751 | 536 |
| 8 | Hebian-to | 0xe64e002f | 4,207 | 657 |
| 9 | Al-Arqas | 0x8f58003b | 6,297 | 778 |
| 10 | Dryreach | 0xda75002b | 4,806 | 34 |

Gate per stop: landblock change, then mesh count unchanged 4 polls (~4 s). Spot
checks (Holtburg, Dryreach) confirm fully-streamed scenes. Two flaws to know:
stop 1 reports `moved=false` because the tour **spawns** in Holtburg so the
landblock never changed (shot is valid, the move just wasn't proven), and stops
3–10 hit the 60 s settle ceiling rather than converging, so counts may still have
been creeping. Dryreach's low `baked=34` is a counter reset on entering a new
region, not under-streaming.

### 3.1 Camera controls (mapped, for future tours)
`scene3d/camera.js` `CameraSwitcher`: modes `follow` (PointerLock) / `orbit` /
`topDown`, cycled by the **`C`** key; `switchMode(next)`. Framing is via plain
mutable fields consumed by `tick()`: `followYaw` (0 = looking toward AC +Y north,
π/2 = +X east), `followPitch` (positive = down, clamped
`FOLLOW_PITCH_MIN/MAX`), `followDistance` (metres behind player, default 6).
⚠ `tick()` **eases `followYaw` back toward the player's heading** when not
right-drag free-looking, so an assigned yaw decays — set framing and shoot
promptly, or drive heading instead. Pin `camera.fov` +
`updateProjectionMatrix()` for pixel A/Bs (it drifts 60→55).

---

## 4. 1070 availability — no sleep timer; the risk is human
Asked whether the box sleeps at a fixed hour. It does not, and it cannot by
design (Windows sleep is idle-timeout based, not time-of-day):
`Sleep after` = **0/never** (AC+DC), `Hibernate after` = **0/never**,
`Display off` = **0/never**, **no wake timers**, and **no scheduled task**
sleeps/shuts down/hibernates (the only "shutdown" match is an ASUS hotkey task
that *cancels* one).

One midnight-adjacent setting does exist: **Windows Update active hours =
12:00 → 00:00**, so from midnight on WU may auto-restart to finish updates.
Currently defanged by `NoAutoRebootWithLoggedOnUsers = 1` and
`RebootRequired = False`. `Schedule Scan` (`usoclient StartScan`) fires 02:04.

Event log says shutdowns are **person-initiated** (`1074` via
`RuntimeBroker.exe` = the Windows UI): Jul 29 01:24, Jul 27 22:01, Jul 27 21:33.
Exactly one sleep event in 3 days (Jul 27 17:01, resumed 1 s later). Last boot
2026-07-29 15:47 after an *unexpected* shutdown at 15:35.

**Consequence for automation:** the real-GPU path needs the **interactive**
session (`schtasks /it`), so any reboot/logout kills it and Chrome returns with
no GL context (the `MODE3` failure). Treat the box as available only while a
user session is live, and checkpoint artifacts to the laptop as they land.

---

## 5. Still open
1. **boot.hba cold-boot cost** — reachability proves the pack *complete*, not
   *cheap*. §2.2 argues the cost is modest; the call is the user's.
2. **`0x06003C25` plank regrade** — bundle v2's warm per-channel tint
   `[1.129, 1.031, 0.741]` is UNJUDGED. See §6.
3. **Real-placement context shots** — the systemic fix. See §6.
4. Untouched: the 5 refused 4096² records, the 5 symlinked layers, and the
   **DatReaderWriter b-tree leaf-marker bug** (HIRES-DIST-REPORT §2/§5.5).

## 5b. WHERE THE "THOUSANDS OF TEXTURES" EFFORT WENT — it is DONE and UNSHIPPED

Recording this because the task list had drifted onto a 34-item side quest and made
the main line look absent. **The at-scale auto-approved replacement happened.** It is
baked, validated, and sitting in `/mnt/wbterminal2/holtburger-dist-hires`, not live.

### The funnel (exterior/statics, X1→X4)
| stage | n |
|---|--:|
| retail surfaces total (X1 census) | **6,152** (2,979 = 48% INDEX16) |
| RGB-class candidates | **1,790** |
| **auto-ship — classifier-approved, NO per-texture human review** | **1,501** |
| permanent hazard exclusions | **252** (alpha 123 · dither 44 · tiny 85) |
| residual no-upscale | **37** (22 quarantined + 15 fail the fidelity gate) |
| **written into the hires DAT at 4×** | **1,500** (5 refused — DRW 5 MB record cap) |
| static placements covered | **3,090,474** |

### The auto-approval mechanism the effort was supposed to have — it exists
`/mnt/wbterminal2/pbr-terrain/bake/full/classify_ship_final.py`. Four hazard gates plus
a fidelity gate took 1,790 → 1,501 with **no per-texture eyetest**:
1. **alpha** — alpha-test/blended cutouts, on two independent signals: retail
   SurfaceType flags *and* pixel-alpha coverage. The flags matter because a colour-key
   (`Base1ClipMap`) cutout has **zero pixel alpha**, so a pixel-only rule misses it.
2. **dither** — intentional dither/speckle, which ESRGAN reads as compression noise and
   "fixes" into invented veins or gradient mush. Thresholds calibrated against real
   observed failures (`0x060041F5` coh 0.395, `0x06003A6A` 0.306, `0x060038AA` 0.236).
3. **tiny** — `min(w,h) <= 32`.
4. **no-upscale** — x4 output absent/unreadable/not actually 4×.
5. **fidelity** — box-downsample the ×4 back to source size and require it to reproduce
   the source.

### Interiors came almost free
All **729,888** EnvCells draw from only **804** distinct Surfaces (**3,861,366** slot
refs), and **84.9% of those slot refs are already covered by the same X4 batch with zero
additional upscale work**. Interiors are also far cleaner than the world at large: only
36/804 (4.5%) are INDEX16 = 1.0% of slot refs, all in the tail.

### So the confusion is a scope collision
Two tracks, wildly different sizes, easy to conflate:
- **X4 upscale — 1,500 surfaces, auto-approved, done.** Preserves character by
  construction (it upscales the retail art), which is *why* it needs no human sign-off.
- **X3 CC0 substitution — 34 surfaces, hand-approved.** *Replaces* the art, so character
  can drift, which is why it needs eyetests. §6 below is about these 34 only.

**The main line is therefore: ship the 1,500 (task #7), close the remainder — 5 refused
+ 37 + the 252 hazard rows that need a different treatment than ×4 ESRGAN (#8) — and
take the interior 15.1% tail (#9).** The 34 CC0 picks are demoted.

## 6. Why the plank re-pick is piecemeal — and what replaces it
`0x06003C25` (CC0 `Planks036B`, `roughness 0.509`, `gain 0.566`, tint
`[1.129, 1.031, 0.741]`) failed the 1070 eyetest as a **character** regression —
"modern laminate vs warm knotty retail" — not a technical one (dims, normal
stride and roughness all verified correct).

The v2 response was a per-channel **tint**, which is a pure colour-temperature
correction: +13% R, +3% G, −26% B. But the complaint names **two** defects, and
tint can only address one. Knots, grain irregularity and tonal variation are
*spatial* properties of the image; no gain/tint scalar can add them. A tinted
uniform laminate is a warmer uniform laminate. So the regrade fixes this only if
the objection was mostly warmth.

**The piecemeal part is real:** all 34 picks were approved from A/B swatch
sheets, i.e. judged texture-vs-texture, never texture-in-world. `0x06003C25`
isn't special — it's simply the one a tour happened to fly past. Nothing has
looked at the other 33 in situ, so one-rsId-at-a-time is symptom-chasing. (Note
the ESRGAN upscales carry far less character risk by construction: they upscale
the retail art rather than replace it. The 34 CC0 substitutions are where
character can drift.)

The eyetest already exposed this blind spot **twice**: the plank, and the
authored-normal demo that "landed on an ambient-lit interior floor where normals
buy nothing" — a technically-correct normal map showing zero benefit purely
because of where it sat (which is why sun-lit exterior `0x06003AD6` had to be
added). Both are placement-dependent verdicts a swatch cannot produce.

**Real-placement context shots** are therefore the fix, not a nicety: for each
substituted rsId, render before/after at its actual in-world placements (real
geometry, lighting, viewing angle, neighbours) and judge all 34 in one batched
pass. The placement data already exists from the X4 work (e.g. `0x06003AD6` =
1,400 exterior placements, 21 outdoor static instances in the `0xA9B3`–`0xA9B6`
Holtburg cluster), so shot locations can be derived rather than guessed. Today's
10-stop tour is a crude ancestor: right mechanism (real world, real GPU), but
POI-driven rather than rsId-targeted.

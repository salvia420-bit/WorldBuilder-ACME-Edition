# Handoff — AcmeRagdoll death-orientation variety + AcmeSky takram clouds (2026-08-23)

## TL;DR for the next agent

Two things the owner still wants fixed, plus one fix that landed and should be kept:

1. **Death-orientation variety (IMPLEMENTED, awaiting a live motion check).** Creatures —
   especially front-heavy ones like drudges — always fell face-first (prone). The first attempt (a
   per-death **pre-lean** of the death pose) was **rejected by the owner**: it made bodies *snap
   from standing straight to flat with no fall animation*. It has been **deleted** and replaced by
   an **angular-velocity ORIENTATION COMMIT** in the sim's seed, which cancels the body's measured
   centre-of-mass bias instead of moving its pose — so the topple still takes ~0.5–1 s. Offline it
   turns the drudge's 83% prone into ~48/46/6 prone/supine/side. **Verify in motion.** See §1.
2. **AcmeSky takram clouds (OPEN, aesthetic).** AcmeSky was never deployed; it's deployed now
   and its baked clouds *do* render under DXVK — but the owner says they "don't appear at all
   like they do in the retail version." Your job: make the clouds look right. See §3.
3. **Double-ragdoll under simultaneous deaths (FIXED — keep).** A second ragdoll used to appear
   after the first settled when several creatures died at once (`@smite`). Root-caused and fixed
   (shared handoff records + a match-retry grace). No complaint from the owner. See §2.

The owner's hard constraints on ragdoll deaths (from earlier in the project):
- **No flying/launched bodies** — the server expects the corpse near the death spot; launching
  breaks that. `maxSpeed`/`maxUpSpeed` are capped so variety can never exceed defaults.
- **No long twisting** — corpses despawn (~mins) and the death window is short; keep falls quick
  but *readable*.
- **No corpse may sink** — the lowest part must stay above the floor Z (anti-sink clamp exists).
- Deaths are a per-body 33/33/34 blend of (retail metrics / sim defaults / authored vibe),
  baked into `AcmeRagdoll/ragdoll_profiles.json` (693 setupDids). Don't discard that.

---

## Repo state

Branch `integ/all-20260813`. Relevant commits (newest first):
- `ece7a0b4` — fall-orientation pre-lean (now disabled) + multi-death double-ragdoll fix.
- `35cfd233` — death-variety PCA "manifold" sampler (per-death param variety).
- `143d312d` — per-body individualized deaths + live-motion layer + wine/DXVK fixes.

This handoff's commit disables the pre-lean and adds this doc.

**Build (memory-safe, single project):**
`DOTNET_ROLL_FORWARD=LatestMajor dotnet build AcmeRagdoll -c Release`  (AcmeSky same).
Do NOT `dotnet build` the whole solution on the laptop (OOMs). Output: `AcmeRagdoll/bin/net8.0/`.

---

## §1 Death-orientation variety — IMPLEMENTED 2026-08-23 (needs a live MOTION check)

> **Status update (same day, later).** The angular-velocity idea below was implemented as the
> **ORIENTATION COMMIT** in `RagdollSim`'s ctor, and the pre-lean (`ApplyDeathLean`, `LeanBase`) was
> **deleted**. `DeathVariety.Perturb` now outputs `orientCommit` (was `leanRad`); it flows through
> `HandoffRecord.OrientCommit` exactly like `Direction`, so corpse handoffs continue the same fall.
> New live cfg key **`deathorientgain`** (default 1.4, clamp 0–4) multiplies `deathvarietystrength`.
> Measured offline against a faithful Python port of the shipped sim, driven by the real
> `0x020007DD` part origins: drudge **83% prone → 48% prone / 46% supine / 6% side** at
> strength 0.7, with the fall's flat-by frame unchanged (p50 15 frames = 0.5 s, so no snap), CoM
> rise +0.014 yd vs baseline (no launch) and settle drift 0.90 yd mean / 1.17 yd max.
> **Still unverified in-client — watch the motion, not stills.** The rest of this section is the
> original problem statement, kept because the diagnosis is still the right one.

### Original brief

### Why they always face-plant
`RagdollRegistry.Seed()` already gives each death an **even random heading**
(`direction = 2π·frac(seed·φ)`, ~line 528). The sim (`RagdollSim`) topples the body so its
*top* moves toward `direction`. So headings ARE varied — but a front-heavy creature (drudge:
hunched, arms hung forward) has its center of mass **ahead of its feet**, so gravity's forward
torque overrides the seeded topple and it lands prone every time, regardless of heading. The
owner diagnosed this correctly ("the ragdoll gravity of their arms pulls them forward").
`dirBiasStrength`/`dirBiasDeg` in the profiles are mostly 0 for these bodies, so the bias is NOT
the cause; it's the physics.

### What was tried and REJECTED
`RagdollSim.ApplyDeathLean(pos, n, directionRad, leanRad)` (static, still in the file) rotates
the whole death pose about the foot pivot toward `direction`, tipping the CoM *past* the pivot so
gravity commits the fall that way. `DeathVariety.Perturb` produced a `leanRad` (~0.32 rad at
strength 0.7) and `Seed()` applied it to `startPos` before building the sim (~line 549), baking it
into the handoff record too. In **stills** it produced a real prone/supine/on-side mix (drudges
landed showing their green bellies = supine). But in **motion** it snapped the body flat almost
instantly — leaning past the balance point makes gravity collapse it in a frame or two, so there's
no visible topple. **Now disabled**: `DeathVariety.Perturb` sets `leanRad = 0f` (see the comment
there). `ApplyDeathLean` is a no-op when `leanRad==0`, so deaths animate as before (faceplant, but
with a real fall). Keep or delete `ApplyDeathLean` as you see fit.

### Ideas to try (didn't get to these)
- **Much smaller lean** (e.g. 3–6°) — just enough to break the tie, not enough to snap. Likely
  still too coarse alone.
- **Angular *velocity* impulse, not a static pose rotation.** Seed a real torque about the CoM in
  the chosen direction so the body *rotates over time* instead of starting pre-tipped. The sim
  already seeds `omega × r` topple (`RagdollSim` ctor ~line 149-184); bias/strengthen that toward
  the heading rather than pre-leaning the pose. This preserves the fall arc.
- **Lengthen the fall / soften the early braces** so the topple reads. `FallFrames` per body
  (profiles) and the brace give-schedule (`BuildBraces`, `Window`, `GiveMin/Span/Ramp`) control how
  long the body stays rigid; a rigid pole topples visibly, then goes limp. The current settle is
  ~2s (fast). Slower + committed heading might read as a real directional fall.
- **Counter the CoM.** For a supine (backward) fall, kick the *feet* forward (low-body linear shove
  opposite the heading) so the body rotates back over its heels rather than pre-leaning the torso.
- **Blend toward a retail death-animation orientation** instead of pure physics — retail creatures
  have canned Dead motions with a characteristic final pose; matching that per body may look better
  than physics variety. (Bigger change.)

Test the MOTION, not stills — the owner watches the video. The stills lied here.

---

## §2 Double-ragdoll under simultaneous deaths (FIXED — keep, don't regress)

**Symptom:** with several identical creatures dying at once (`@smite all`), a body would fall,
settle, then a *second* ragdoll would play — the corpse re-seeding a fresh fall.

**Root cause (proven from ARM logs):** when a creature dies we record a `HandoffRecord`; when its
corpse object spawns it should *continue* that record (no re-seed). Records were **one-shot**
(consumed on first match). Clustered identical corpses (same part count, cell, parent-hash, within
6 yd) raced for the nearest record; the losers found none left and re-seeded a fresh ragdoll = the
double. Also a timing race: a corpse could position *before* its creature's record was created.

**Fix (`RagdollRegistry.cs`):**
- Records are now **shared, not consumed** — `rec.MatchCount++` instead of `_records.Remove(rec)`
  at both match sites (`ArmCorpseHandoff` ~line 330, deferred path ~line 463). Identical clustered
  creatures fall identically, so every corpse continuing the same nearby record is correct. Records
  still expire via `HandoffWindowMillis` (8 s) / `HandoffRecordTtl` in `TryMatchRecord`.
- **Match-retry grace** — a positioned corpse that finds no record waits up to `MatchRetryMax`
  (6 frames ≈ 0.2 s) for one to appear before falling back to a crumple (`ResolvePending`, no-record
  branch ~line 484). Closes the timing race.

**Live result:** miss rate ~60% → ~17% (log), and — the decisive test — the settled pile is
**identical from t=2s to t=7s** (screenshots), i.e. it falls once and holds; nothing re-animates
after settle. The occasional lone `deferred=True class=CREATURE-crumple` in the log is a
position-late *living* creature crumpling correctly, not a post-settle double. Verify with:
`grep 'ragdoll ARM' inject.log | tail -40` and count `CORPSE-handoff` vs `CREATURE-crumple`; watch
that no corpse re-falls after settling.

---

## §3 AcmeSky takram clouds (OPEN — render but wrong vs retail)

**What was wrong:** AcmeSky was simply **never deployed** to the box's Chorizite plugins dir
(only AcmeRagdoll was). No code bug. Deployed now → it loads, installs its `GameSky::Draw` hook at
`0x00507A50`, and its baked cloud domes render under DXVK (log: `acmesky: ready -- retail sky
suppressed, baked sky armed`).

**What's still wrong:** the owner says the clouds "don't appear at all like they do in the retail
version." So this is now an **appearance** problem, not a deployment one. Where to look:
- `AcmeSky/Services/SkyRenderer.cs` — draws the atmosphere dome, cloud domes, star dome on the
  client's fixed-function D3D9 device.
- `AcmeSky/Services/SkyHook.cs` — the `GameSky::Draw` detour that suppresses retail sky.
- `AcmeSky/AcmeSkyPlugin.cs` — loads 6 palettes (broken/clear/overcast/rain/scattered/storm),
  builds `SkyRenderer` (currently `testGradient=True diag=True live=False` per the boot log — check
  whether it's stuck in a test/diag mode rather than live weather-driven rendering).
- Assets: `AcmeSky/bin/net8.0/assets/sky/` — `cloud_*.askytex`, `stars_equirect.askytex`,
  `skytime_*.json` (per-weather palettes), `clouds/local_weather_dereth.tileable.png`.
- Compare against the **retail** AC sky/cloud look (and the earlier holtburger-web takram cloud
  work: `external/holtburger/apps/holtburger-web/vendor/takram-three-clouds/`). The owner knows the
  target look; get a screenshot to them early.

Note `testGradient=True` / `live=False` in the boot line — that strongly suggests the renderer is
in a diagnostic gradient mode, not the real cloud rendering. Start there.

---

## Box operations (buildbox T4 — everything runs here)

- **Access:** `gcloud compute ssh buildbox --zone=us-east1-c`. Real GPU: Tesla T4, Xorg on
  **DISPLAY :1**. Spot instance (~$0.15/hr) — can be preempted (STOP; disk safe, new IP on restart).
- **ACE server** runs on the LAPTOP (not the box): ports 9000/9001, account `tailnet1`/`tailnet1`
  (level-999 tester). The box client connects to it over tailscale (`-h 100.116.47.66 -p 9000`,
  baked into the Chorizite injector config, `D:\ac-dat-test\acclient.exe`).
- **Launch:** `bash ~/inject-dxvk.sh` (Chorizite injector → acclient under DXVK v2.4.1; sets
  `d3d9=n`, DXVK HUD). Then `bash ~/prep-outdoor.sh` (clicks char-select **Tester ≈ (1000,935)** +
  **ENTER ≈ (1223,898)** — the panel sits **bottom-right** of the 1920×1080 display; then first-
  person via `KP_Decimal` and `@telepoi holtburg`). Sometimes needs a second `prep-outdoor.sh` run.
  Confirm in-world via `xdotool getwindowgeometry` == `1920x1080`.
- **DXVK outdoor fix:** `D:\ac-dat-test\dxvk.conf` has `d3d9.textureMemory = 0` — REQUIRED or the
  outdoors crashes (32-bit texture-paging tmpfs exhaustion). Don't remove it.
- **Account-in-use ghost:** ACE holds the `tailnet1` session ~150 s after the client dies. After
  `pkill acclient`, **wait ~150 s** before relaunching or you get kicked back to char-select.
- **Live cfg:** `~/acwine/drive_c/Temp/acdt/ragdoll.cfg` == `C:\Temp\acdt\ragdoll.cfg`. Keys:
  `livemotion=1`, `deathvariety=1`, `deathvarietystrength=0.7` (0–1.5), `deathorientgain=1.4` (0–4). Hot-reloaded by the config
  poller each frame in-world (no relaunch needed for cfg changes; DLL changes DO need a relaunch).
- **Capture scripts on the box** (I wrote these; `@` is typed via shift-hold because xdotool
  mistypes `@`→`2`): `~/capshots.sh <wcid> <name> <n>` (spawn n, smite, direct screenshots at
  t=0,1,2,4,7), `~/capab.sh <name>` (spawn 6, smite, 9 s @ 60fps via h264_nvenc — T4 hardware
  encoder), `~/capvariety.sh`, `~/capline.sh` (walk+spawn to spread them), `~/capdeath.sh`.
  ffmpeg capture region is `:1+320,270` (the game window is offset within the display).
- **Encoding for phone:** `-c:v libx264/h264_nvenc -pix_fmt yuv420p -profile:v main -movflags
  +faststart` (Android can't decode yuv444p — that caused black videos earlier).
- **Taildrop to owner's phone:** `tailscale file cp <file> redmi-note-13-5g:` (100.123.121.86).
- **Plugins dir:** `~/acwine/drive_c/Games/Chorizite/plugins/`. Deploy by copying the built DLL
  over `AcmeRagdoll/AcmeRagdoll.dll` (curated layout: dll + manifest.json + Chorizite.ACBindings.dll
  + FASM*.DLL + Reloaded.Assembler.targets + ragdoll_profiles.json). AcmeSky mirrors this plus its
  `assets/` dir. **The box currently has the animate-again (lean-disabled) AcmeRagdoll.dll deployed
  but the running client still has the OLD (snap-flat) build loaded — relaunch to pick up the new
  one.** AcmeSky is deployed only on the box (repo has the source; nothing to commit for deploy).

Sanity checks: `strings <dll> | grep -c ApplyDeathLean` / `MatchRetries` to confirm which build is
deployed.

---

## Key files / symbols

- `AcmeRagdoll/Sim/RagdollSim.cs` — the verlet sim (model space, +Z up). Topple seed in the ctor
  (~138-208); `ApplyDeathLean` static (now unused); `FallFrames`, braces, give-schedule.
- `AcmeRagdoll/Sim/DeathVariety.cs` — `Perturb()` (PCA sampler; `leanRad` now forced 0);
  `LeanBase` const; envelope `Min[]/Max[]`.
- `AcmeRagdoll/Sim/DeathVarietyModel.cs` — baked PCA basis/eigen/std (18 params, K=4).
- `AcmeRagdoll/Services/RagdollRegistry.cs` — `Seed()` (~500-566, incl. the disabled
  `ApplyDeathLean` call ~549 and `direction` seed ~528); handoff records; `TryMatchRecord` (~612);
  `ArmCorpseHandoff` (shared, `MatchCount`); `ResolvePending` (retry grace, `MatchRetryMax`).
- `AcmeRagdoll/ragdoll_profiles.json` — 693 per-setupDid profiles. Drudge Skulker (wcid 7) =
  setupDid `0x020007DD`. Reedshark (wcid 222) = `0x02000039` (anti-spin patched — one hind leg).
- `AcmeSky/` — `AcmeSkyPlugin.cs`, `Services/SkyRenderer.cs`, `Services/SkyHook.cs`, `assets/sky/`.

## Useful wcids for testing
Drudge Skulker `7` (front-heavy biped, best face-plant repro). Veteran Reedshark `222`
(tripedal, anti-spin case). Olthoi Warrior `24308`. `@create <wcid>` then `@smite all`.

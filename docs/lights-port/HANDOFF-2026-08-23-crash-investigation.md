# HANDOFF — 2026-08-23 PM: crash investigation + followup plugin ship (1070 live session)

Owner ran the P3+P4 human-test build on the 1070. Feedback + a series of crashes drove this
session. Owner had to leave; this is the state at handoff.

## Owner feedback on the test build (per HANDOFF-2026-08-23-1070-human-test.md)
1. **FPS avg fine; 1% lows need work** without cutting visual quality. → pacing agent (shipped, below).
2. Ragdoll: will retest.
3. Glow lights: OK.
4. Selection: good.
5. **Bloom too weak outdoors by day**; **lifestone glow not noticeable — "do it system wide."**
   → bloom/glow agent (shipped, below).

## THE CRASHES — two distinct root causes

### Crash family A: DAT parser pointer-alignment over >2GB buffers — **FIXED + VERIFIED**
Four crashes (TN ×2, Sawato, and the earlier ones) were all the SAME latent retail bug, found by
full minidump analysis (dumps pulled to `/mnt/wbterminal2/crashdump*/`; WER local dumps armed via
`HKLM\...\Windows Error Reporting\LocalDumps\acclient.exe`, DumpType=2, folder `C:\Temp\acdt\dumps`).

- **Mechanism:** acclient is LARGE-ADDRESS-AWARE (PE char 0x012E). Under the r9 dense-dat residency
  the process exceeds 2 GB, so cache/archive buffers get addresses ≥ 0x80000000. Retail's archive
  alignment idiom computes `(signed int)cursor % 4` — a pointer ≥ 0x80000000 is **negative** as a
  signed int, so the modulo returns the wrong pad count, the read cursor desyncs from the real data
  layout, and a later read walks off the buffer into unmapped memory → AV.
- **Proof:** crash #4 (dump `acclient.exe.18236.dmp`) faulted reading `0x9A049000` (a buffer above
  2 GB) in `AnimData::UnPack+0x16`, called from `MotionData::UnPack`, whose align idiom at
  VA 0x5271A6 is exactly this pattern. MotionTable 0x09000068 (the record being parsed) is
  BYTE-IDENTICAL to retail base — data is fine; the parser math is the bug.
- **Fix (deployed, candidate):** patched all **189** instances of the align idiom
  `and eax,0x80000003` → `and eax,0x3` (i.e. signed `%4` → unsigned `&3`). For any sub-2GB pointer
  the result is byte-identical (already non-negative), so the common path is unchanged; only the
  high-memory case is corrected. Filter required both the `mov r32,4` and `or r32,-4` idiom bytes
  in-window (2 non-idiom sites correctly skipped). Verified: exactly 189 imm edits + PE checksum,
  nothing else; crash-site disassembles to `and eax,0x3` cleanly.
  - Build: `/mnt/wbterminal2/ac-eor-patch/acclient.eor.patched.lfa.exe`
    (sha256 f2880d6c…75a40730). Deployed to `D:\ac-dat-test\acclient.exe` on the 1070.
  - Backup of the pre-fix exe: `D:\ac-dat-test\acclient.exe.bak-prelfa-0823`.
  - **VERIFIED by owner: Sawato portal (which crashed twice before) now works.** TN/Arwic also fine.
- **OWED:** fold this into `/mnt/wbterminal2/ac-eor-patch/patch_client.py` as a proper registry
  entry (suggest key `dat-align-lfa`), with the 189-site signature scan, and run the box's normal
  exe-patch QA. Right now it's a hand-rolled out-of-lane patch. Also decide whether the SHIPPING
  player launcher passes an arg that makes acclient large-address-aware / whether players will hit
  the same >2GB alignment path (they will, once residency is high) — this fix belongs in the
  shipped exe.

### Crash family B: heap exhaustion at ~2.6 GB — **STILL OPEN (priority)**
- Owner crashed **standing in Yaraq (NOT portalling)**. Fault was in **`ntdll.dll`+0x87d4c** (the
  Windows heap allocator), exc 0xC0000005, at **VM = 2.65 GB** (mem.log `C:\Temp\acdt\mem.log`,
  20:32:31 → 2,653 MB). Dump: `C:\Temp\acdt\dumps\acclient.exe.12356.dmp` (2.5 GB, not yet pulled).
- This is NOT the parser bug (that's fixed) — it's genuine memory exhaustion + heap fragmentation.
  Yaraq is a large dense desert city; the r9 dats (≈3–4× denser meshes + upscaled textures) push
  residency past what a 32-bit process can hold even with LAA. The parser fix lets us survive high
  pointers; it does nothing about actually running out of address space.
- **Mitigations already applied this session** (client prefs, `D:\ac-dat-test\UserPreferences.ini`,
  backup `.bak-0823`): `AutomaticDegrades=False→True`, `DegradeDistance=10000→100`,
  `Environment/LandscapeTextureDetail=VeryHigh→High`, `LandscapeDrawDistance=VeryHigh→High`.
  These helped (TN/Arwic/Sawato held ~1.5–2.2 GB) but Yaraq still blew past 2.6 GB.
- **NEXT SESSION — the real shipping fix is footprint reduction. Options, roughly in order:**
  1. **Content diet on r9** (most durable): cap the relief-mesh densification factor, audit/reduce
     the texture upscales (the 0x06 bulk). Rebuild the r9 dat set lighter. This is the root lever.
  2. **Plugin-side residency governor**: a cache-trim / aggressive-degrade plugin that evicts
     distant models under a memory watermark (mirror retail's DBOCache refcount + slot grid).
  3. **Client prefs floor**: push texture detail to Medium / draw distances lower as a shipping
     default and measure Yaraq VM; may be enough on its own if content diet is deferred.
  - Diagnostic harness is in place: `C:\Temp\acdt\memlog.ps1` (scheduled task `acdtmemlog`) logs
    VM/priv/WS every 5 s to `C:\Temp\acdt\mem.log`. WER full dumps auto-capture to
    `C:\Temp\acdt\dumps`. Minidump reader: `scratchpad/dump_stack.py` (standalone, no deps) +
    `dump_analyze.py` (needs the `minidump` wheel unpacked in `scratchpad/pylibs`).

### Aside: the Sawato "downloading 0/961" bar (RESOLVED, not a crash cause)
AcmeInject was launching with `-rodat off`, which makes the dats writable and arms retail's DDD
patch path. Coastal Sawato legitimately has ~961 ocean landblocks with no LandBlockInfo record
(verified: r9 cell dat is record-identical to base, 805,348 recs, zero missing); a patch-enabled
client asks the server for them, vanilla ACE has patching disabled and never replies → bar stuck at
0/961. Fixed by forcing `-rodat 1` via `ACMEINJECT_ARGS` in `C:\Temp\acdt-inject.bat` (backup
`.bak-0823`). The crash that followed was family B (memory), not the bar.

## Followup plugins SHIPPED this session (deployed to 1070, built clean, merged)
Branch `integ/lights-0823-followup` (this branch). Two Opus agents, worktrees merged + conflicts
hand-resolved by the orchestrator; all three plugins build Release with 0 errors.

Deployed to `C:\Games\Chorizite\plugins\*` (backups `*.dll.bak-0823-2`):
- **AcmeLights.dll** (99 KB) — pacing + bloom/glow + outdoor enable (details below)
- **AcmeRagdoll.dll** (108 KB) — pacing
- **AcmeSky.dll** (606 KB) — pacing

### Pacing (the 1% lows) — agent worktree-agent-a6ba02d6407adcd25
Dominant hitch was **Chorizite's logger doing a synchronous file open/append/close per line on the
render thread** (every heartbeat = a multi-ms stall; at 100 fps one 1ms stall/sec IS the 1% frame).
Fixes: `AcmeLights/Lib/AsyncLog.cs` + `AcmeRagdoll/Lib/AsyncLog.cs` (batched background writer);
`glowlog` default 1→0; mtime-gated `LightsConfig.MaybeReload`; time-sliced glow classification
(≤8 new/scan); phase-offset torch scan; `BloomCompositor` per-frame `CreateStateBlock`→cached
`Capture`; ragdoll per-hit/per-death writes async; alloc-before-bail fixes in ComputeBodyMetrics/Seed;
AcmeSky heartbeat + reload gated. No visual/light-math changes.

### Bloom day/night + system-wide glow — agent worktree-agent-a2f287caa70ce8d69
- **Day bloom:** `AcmeLights/Lib/SkyState.cs` reads the ambient funnel the plugin already detours
  (`SmartBox::SetWorldAmbientLight`); night/indoor bit-identical to owner-proven values, day lerps
  brighter. Knobs: `bloomday=1`, `bloomdaythreshold=0.38`, `bloomdayintensity=3.2`, `bloomdayradius=4`,
  `bloomnightamb=0.20`, `bloomdayamb=0.62` (**guess — read live `amb=` in the heartbeat at noon and
  set to it**).
- **System-wide glow gain:** `glowgain=1.6`, `glowrangegain=1.6` + per-class trims. Chose RANGE as
  the primary lever: D3D `Range = falloff×1.5` is a HARD cutoff and intensity is already ~18×
  saturated near-field; lifestone now reaches ~13.4 m (was 6.0 m — owner stood at 5.4 m, on the edge).
- **Outdoor glow enable (P3b):** `LScape::draw` @0x00506D90 PRE-detour re-adds tracked glow emitters
  via retail's own `add_active_light`/`enable_active_lights`. Fixes the gap where outdoor draws ran
  with an active light set of exactly {sun}, so NO glow gain could show outdoors. Default-ON, argued
  safe-by-construction (retail's own primitives, one-pass lifetime, self-allocating slots).
  **Live-validation still OWED.** Knobs: `glowoutdoor=1` (=0 before launch removes the detour
  entirely — the escape hatch if it destabilizes), `glowoutdoorbudget=6`. Watch heartbeat for
  `outdoor N/frame` and confirm nearby retail torches don't go dark (drop budget to 3–4 if so).

Full details: `docs/lights-port/P3-GLOWLIGHTS-2026-08-23.md` §9–§10, `P4-SELECTION-2026-08-23.md`.

## Deploy state at handoff
- Client RUNNING (relaunched after a ghost-session "Account In Use"; ACE dropped tailnet1 20:29:19).
- Exe = LFA-fixed. Plugins = the merged followup build. Prefs = mitigated. `-rodat 1`.
- All knobs hot-reload via `C:\Temp\acdt\lights.cfg` (glowlog now default 0; `loglights=2` restores
  the 1 Hz heartbeat).

## Immediate next steps (priority order)
1. **Family-B memory fix** — pull `acclient.exe.12356.dmp`, confirm the ntdll heap-exhaustion read,
   then attack footprint (content diet on r9 preferred; measure Yaraq VM after). This is the
   remaining ship blocker.
2. **Fold the LFA align patch into `patch_client.py`** (`dat-align-lfa`) + run exe-patch QA; get it
   into the shipped exe / player launcher path.
3. **Live-validate P3b outdoor glow** on the 1070 (lifestone tints ground blue at ~5 m; torches
   don't starve; 10-min stability with transitions).
4. **Calibrate `bloomdayamb`** from the live `amb=` at noon outdoors.
5. Ragdoll death retest (owner hadn't gotten to it).

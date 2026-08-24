# ACME for Asheron's Call — Windows install guide

ACME is a high-resolution texture and content patch for the retail Asheron's Call
client, made by and for the preservation community. It patches an Asheron's Call
install **you already own**: the package contains no retail files and no game
executable. Optionally, a plugin pack adds modern lighting, a volumetric sky,
ragdolls, and stability fixes on top.

This guide starts simple. If everything works you only need the first two pages.
The further you scroll, the more technical it gets — the back half is there so
that if something breaks, you can diagnose and fix it yourself.

---

## 1. What you need

- Your own **retail Asheron's Call install** (the 2015 End-of-Retail client,
  `acclient.exe`, 4,841,472 bytes). Any retail install or an earlier ACME
  release is fine to patch over — each ACME release is self-contained, not a delta.
- **Windows** (64-bit recommended — the client is 32-bit but benefits from the
  large-address patch on 64-bit Windows), any DirectX 9 capable GPU.
- About **4 GB of free disk** for the new dats.
- An account on a server that runs the matching ACME dats (ask your server
  operator — see "DAT files are incomplete" in Troubleshooting for why this matters).

## 2. Quick install

1. **BACK UP** these files from your Asheron's Call folder somewhere safe:
   `client_portal.dat`, `client_cell_1.dat`, `client_highres.dat` (if present),
   and `acclient.exe`.
2. **Copy every file** from the ACME release archive into your Asheron's Call
   install folder (the folder that contains `acclient.exe`). Don't run anything
   from the download folder.
3. Run **`patch-my-client.bat`** once. It patches *your own* `acclient.exe` in
   place, keeps a backup (`acclient.exe.acme-orig.bak`), and refuses to touch
   the file if it doesn't recognise it.
4. Open `UserPreferences.ini` (in the install folder, or in
   `Documents\Asheron's Call\`) and make sure the `[Render]` section contains:

   ```ini
   [Render]
   EnvironmentTextureDetail=VeryHigh
   LandscapeTextureDetail=VeryHigh
   ```

   Spell the words out exactly as shown. Do NOT use numbers here: a numeric
   value is read as a worst-first list index, so `=0` silently selects
   **VeryLow** (quarter detail) — the opposite of what it looks like. The boot
   default is only Medium; without this change you only see half the patch.
5. Start the game with **`play.bat`** — not `acclient.exe` directly. To connect
   to a server, pass the usual client arguments through it:

   ```
   play.bat -h <server-address> -p 9000 -a <accountname> -v <password> -rodat
   ```

   (`play.bat` passes everything through to the client. A desktop shortcut with
   those arguments works too.)
6. Play. If the game refuses to start with a message box instead — good, that's
   the installer check protecting you; it names the exact file that's missing or
   wrong. Re-copy the kit or see Troubleshooting.

**Two quick things worth knowing on day one:**

- If you log out (or crash) and reconnect immediately, you may get
  **"Cannot have two accounts logged on at the same time."** After a *clean*
  logout the server holds your character only a few seconds. After a **crash or
  a killed client** — the usual cause of this dialog — the ghost session lingers
  ~110–150 seconds. Wait **~2–3 minutes** and log in again; retrying inside that
  window just re-triggers it. Nothing is broken.
- If the game suddenly runs at exactly ~10 fps: the window has lost focus
  ("background throttle"). Click inside the game window once.

## 3. What's in the release

| file | what it is |
|---|---|
| `client_portal.dat` | game content: models, textures, animations — the ACME re-encoded set |
| `client_highres.dat` | the high-resolution texture tier. **REQUIRED** — after the ACME split this file is load-bearing (see §7) |
| `client_cell_1.dat` | world/dungeon cell data |
| `play.bat` | the launcher — verifies the install every start, then runs the client |
| `patch-my-client.bat` | one-time client patch, run once |
| `acme-patch-client.ps1` | the patch itself — plain readable PowerShell, auditable |
| `acme-patch-client.py` | the same patcher + install check for Linux/wine users |
| `kit-manifest.txt` | exact file sizes `play.bat` verifies |
| `SHA256SUMS.txt` | checksums for everything |
| `README.txt` | short version of this document |

Exact sizes and sha256s vary per release — trust `SHA256SUMS.txt` in *your*
archive, and verify the archive checksum from the release post before unpacking.

## 4. Optional: the Acme plugin pack (lighting, sky, ragdolls, stability)

Included in the release archive but **entirely optional to install**, and more
experimental than the dats. It bundles the open-source **Chorizite** plugin
runtime (MIT-licensed; we ship a patched build because the plugins need a fix
that isn't upstream — full provenance and the published patches are in
`THIRD-PARTY-PROVENANCE.md`). Note it **injects code into the running client**
(the same technique Decal and every AC plugin loader use), so **some antivirus/EDR
may flag or block it** — see the troubleshooting note. It injects a plugin
runtime (Chorizite) into the
client. The dats work fine without it: if you don't copy the plugin folder and
you launch with `play.bat`, you never touch any of this. With it you get:

| plugin | what it does |
|---|---|
| **AcmeLights** | modern lighting: bloom, day/night bloom scaling, glow lights on portals/lifestones/projectiles, torch flicker, importance-ranked light selection — plus two *stability* services: a memory governor and the "mirror diet" (both exist because the high-res content made the 32-bit client run out of address space in towns; see §9) |
| **AcmeSky** | volumetric sky: real clouds, star field, atmosphere — replaces the retail sky |
| **AcmeRagdoll** | creatures ragdoll on death, per-body individualized |

Install shape (this mirrors the reference machine the pack was developed on):

```
C:\Games\Chorizite\                      the runtime (AcmeInject.exe, Chorizite.*.dll, ...)
C:\Games\Chorizite\plugins\AcmeLights\   each plugin in its own folder
C:\Games\Chorizite\plugins\AcmeSky\
C:\Games\Chorizite\plugins\AcmeRagdoll\
C:\Games\Chorizite\data\logs\log.txt     THE log file (see §10)
C:\Temp\acdt\lights.cfg                  AcmeLights settings (plain text, hot-reloads while playing)
```

Launch with the injector instead of plain acclient — a `.bat` like:

```bat
@echo off
cd /d C:\Games\Chorizite
set ACMEINJECT_ARGS=-h <server-address> -p 9000 -a <account> -v <password> -rodat 1
AcmeInject.exe
```

Note `-rodat 1` is **required** with the injector (it keeps the dats read-only;
without it the client's own dat-repair machinery can corrupt the ACME dats).

Every visual feature has an off switch in `lights.cfg` (see §8) and each plugin
can be removed by deleting its folder — the client runs fine with any subset.

---
---

# Technical reference

Everything below is for verification, tuning, and self-rescue.

## 5. Verifying your install

The archive: `sha256sum` (or `certutil -hashfile <file> SHA256` on Windows)
against the release post's hash and against `SHA256SUMS.txt` inside.

The exe patch state, at any time:

```
powershell -NoProfile -ExecutionPolicy Bypass -File acme-patch-client.ps1 -Verify -Exe acclient.exe
```

Exit code 0 = all patch sites present. `play.bat` runs this same check (plus dat
size checks) on every start; `set ACME_KIT_CHECK_ONLY=1` before running
`play.bat` makes it verify-and-report without launching.

Reference hashes for the *pristine* retail exe you supply:

| file | md5 |
|---|---|
| retail `acclient.exe` (EOR 2015-06-12, 4,841,472 bytes) | `116d9a66a70b6af449dc3a28d82f2f6d` |

The patched exe's hash changes whenever the patch set changes between releases,
so the ps1 `-Verify` (which checks the actual byte sites) is the authoritative
check, not an md5 table. For this release the kit patcher reproduces the
reference exe exactly — patched md5 `061106ec1cb6248204a63be2147b5bca`,
sha256 `f2880d6c…75a40730` — so you *can* compare, but a mismatch only means
"different retail source exe or different release", not "broken".

## 6. What the client patch actually changes

Every patch is located by a **unique byte signature** (never a hardcoded
address); the patcher aborts if a signature is missing or matches twice, and is
idempotent (safe to re-run). The shipped set:

| patch | why it exists |
|---|---|
| `palette-leak` + `palette-leak-2` | the community palette-refcount leak fix (notan/eriknihlen) — the retail client leaks palette memory constantly |
| `palette-double-free` | **the mandatory third site** (Mag-nus). The widely-circulated 2-site leak fix alone corrupts the heap at world entry (the leak was masking a double-free). Never run the first two without this one |
| `dat-version-preserve` | compressed dat records load correctly (trevis's fix — restores the record version that `DiskController::Decompress` zeroes). Enables the ~40–50 % smaller portal |
| `highres-force-mount` | the client only mounts `client_highres.dat` when a server tells it to; this makes it mount unconditionally. Without it, most ACME textures silently never load |
| `highres-advertise-cap` | the patched client does *not* advertise the extra dat to servers — your server sees the same three files retail does and won't try to "repair" you |
| `res-4k-unlock` + `res-4k-unlock-2` | UI resize clamps lifted for 4K displays |
| `dat-align-lfa` | DAT-parser pointer-alignment fix. The exe is *already* large-address-aware; above 2 GB retail's signed `%4` alignment math returns the wrong pad count → read-cursor desync → access violation in the DAT parsers. Applied at 189 idiom sites (fixes a distinct crash family from the town-memory one) |

The registry also carries **candidate** patches that are deliberately NOT in
player builds (`allow-multiclient`, headless-bot render bypasses, mip-chain
experiments — one of which, `mip-cap-16`, is recorded as REJECTED because it
whites out large textures). If someone hands you an exe with extras, `-Verify`
will show exactly which sites differ.

Full provenance, signatures, and per-patch history: `PATCHES.md` in the
`ac-eor-patch` lane of the ACME repo.

## 7. Why `client_highres.dat` is load-bearing (and the loud-fail launcher)

Retail's portal dat format caps at 2 GiB. ACME moves its upgraded textures into
`client_highres.dat` and strips the superseded copies from the portal — so a
missing/truncated highres does not error, it just silently renders untextured
surfaces (the client's absent-file mount path is a graceful no-op). That's why:

- `play.bat` refuses to start unless every dat matches `kit-manifest.txt` sizes
  AND the exe verifies as patched (an unpatched exe never mounts the highres at all);
- launching `acclient.exe` directly (ThwargLauncher, Decal, shortcuts) skips
  that check — fine once you know the install is good, but run `play.bat` (or
  `acme-patch-client.py --check-kit`) once after installing, and again after
  anything that could have replaced your exe or dats.

## 8. Configuration reference

### Client arguments

| arg | meaning |
|---|---|
| `-h <address>` | server address |
| `-p 9000` | server port (ACE default) |
| `-a <name>` / `-v <password>` | account / password (auto-login) |
| `-rodat` (plain client) / `-rodat 1` (via AcmeInject) | dats read-only — **keep this on**; without it the client's dat self-repair can write to (and corrupt) the ACME dats |

### UserPreferences.ini

- `EnvironmentTextureDetail=VeryHigh`, `LandscapeTextureDetail=VeryHigh` — the
  names must be spelled out. ⚠ Numeric values are a worst-first choice INDEX
  (`{VeryLow..VeryHigh}` ↔ values `{4..0}`), so `=0` selects **VeryLow =
  quarter detail** — the historic backwards recipe (commit 1fa77b9d). The boot
  default is Medium, i.e. NOT full detail.
- `FullScreen=False` (windowed) is the best-tested configuration; windowed mode
  also avoids device-loss on alt-tab entirely.

### lights.cfg (AcmeLights — only if you installed the plugin pack)

Plain text `key=value` lines at `C:\Temp\acdt\lights.cfg`, **hot-reloaded about
once a second while the game runs** — edit, save, watch it apply. Anything not
listed in the file uses the built-in default. The load-bearing knobs:

| knob | default | what it does |
|---|---|---|
| `diet` | 0 (reference machine ships **3**) | the RGBA-mirror diet: frees ~400–500 MB of redundant CPU-side texture mirrors. `0` off (nothing installed) · `1` inventory-log only · `2` DAT-loaded textures · `3` everything incl. terrain merges. The single biggest town-crash fix; see §9 |
| `memgov` | 1 | memory governor: caps the client's dead-object caches and trims under pressure. `0` = fully off, retail behavior restored live |
| `memlowmb` / `memhighmb` | 1100 / 950 (reference machine: 1300 / 1200) | committed-memory trim watermark / re-arm level (MB) |
| `memcritmb` / `memcritfragmb` | 1350 / 6 (reference: 1700 / 5) | emergency thresholds (commit MB / largest-free-block MB): freelisting off + cells unloaded until recovery |
| `memcaptex` `memcapgfx` `memcapsurf` `memcapland` `memcapscene` | 64/80/64/48/40 | per-cache dead-object count caps (retail's were 400/200/200/144/100 — sized for 2005 assets) |
| `memlog` | 0 | 1 = a memory heartbeat line every 5 s in the log |
| `framelog` | 1 | frame-time stats line every 5 s (see §10) — cheap, leave on; it's how you prove a stutter |
| `bloom` / `bloomthreshold` / `bloomintensity` / `bloomradius` | on / 0.55 / 2.0 / 3 | night bloom pass |
| `bloomday` / `bloomdaythreshold` / `bloomdayintensity` / `bloomdayradius` | on / 0.38 / 3.2 / 4 (reference machine: 0.45 / 2.6 / 3) | day bloom variant |
| `torchlights` | 1 | unlit torch/lantern objects get real lights |
| `glowlights` family (`glowmax`, `glowrange`, `glowoutdoor`, per-class colors/boosts…) | on | dynamic glow lights: portals, lifestones, projectiles, spell impacts, creatures |
| `selection` / `selbudget` | 1 / 8 | importance-ranked light selection (best-N per draw instead of retail's first-N) |
| `flicker` / `ambientfix` | 1 / 1 | torch flicker; fixes retail's red-biased ambient bug |
| `dungeonambient` | `-1` (= leave retail's 0.2) | override the hard-coded dungeon ambient. Set `0`..`1` to change it — note `0` is pitch black, not "off"; `-1` is the off value |

Escape hatch logic: **startup-gated** features (`diet`, `selection`,
`glowoutdoor`) install nothing at all when 0 at boot — set to 0 and restart for
a bit-identical stock client. The rest toggle live.

`sky.cfg` (AcmeSky) is optional — the plugin ships working defaults and only
reads the file if present (same folder as lights.cfg). AcmeRagdoll likewise
runs on defaults (`ragdoll_profiles.json` beside the plugin is optional).

## 9. The town-crash story (family B), and what protects you

The high-res content made the 32-bit client exhaust and fragment its address
space in dense towns — crashes with `priv` around 1.3–1.9 GB, worst right after
teleporting (double-residency spikes). Two layers now stand between you and that:

1. **The memory governor** (`memgov=1`): right-sizes the client's 2005-era
   cache budgets and trims under pressure.
2. **The mirror diet** (`diet=3`): the client keeps a permanent CPU copy of every
   texture purely as device-loss insurance; the diet frees them once the GPU
   copy exists (zero pixels change — the mirror is never what's rendered) and
   the client rebuilds from the dats in the rare case it's needed. In stress
   testing this took worst-town memory from ~1.9 GB to ~1.28 GB on the 14-stop
   tour (and 748 MB–1.13 GB on the harder 20-second-sprint tour) and eliminated
   the town crashes entirely.

(The `dat-align-lfa` exe patch fixes a *separate* crash family — a DAT-parser
alignment bug above 2 GB — not this address-space one. It's in your patched exe
regardless; §6.)

If you still crash in towns: first confirm `diet=3` and `memgov=1` are set,
then collect a dump (below) and report it.

**Collecting a crash dump** (registry, one-time — this is how the family-B
crashes were diagnosed):

```
HKLM\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\acclient.exe
  DumpType   REG_DWORD  2
  DumpFolder REG_EXPAND_SZ  <somewhere with ~3 GB free>
```

A full dump is ~2.5 GB and contains the whole story of the crash.

## 10. Reading the log

`C:\Games\Chorizite\data\logs\log.txt` (rotates per session to
`log.prevclient.txt`). The lines that matter when something feels wrong:

```
acmelights: frametime lb=0xA9B4 n=277 avg=18.0ms p99=49ms max=51.4ms >33ms=5 >100ms=0 | cum n=538 ...
```
Frame-time stats every 5 s: `lb` = the landblock you're standing in, `avg/p99/max`
frame times, `>33ms/>100ms` = hitch counts this window, `cum` = totals since
launch, `gaps` = loading screens (not counted as frames). ~16–17 ms avg is
60 fps (20 ms ≈ 50 fps); p99 spiking to 45+ with a normal avg = stutter, and
the `lb` tells you where.

```
acmelights: memgov priv=892MB lfree=62MB gfx:1/1158 stex:17/269 ...
```
Memory heartbeat (`memlog=1`): committed private MB, largest free low-address
block MB, then free/total per cache. `CRIT` in this line = emergency mode
(expect brief stutter); persistent CRIT = report it.

```
acmelights: diet mode=3 imgtex=1754 mirrors=1045 (395MB, did0=947) freed+0 (0MB) cum=665/387MB
```
The mirror diet's ledger: how many texture mirrors remain and the cumulative
amount freed. `diet ... FAULT — self-disabled` means the diet found an
unexpected client layout and turned itself off permanently for that session —
safe, but report it.

Also useful: `hook installed`/`hook FAILED` lines at startup name every code
patch the plugins made; `memgov probe OK` / `diet probe OK` confirm the memory
services validated the client's layout before touching anything.

## 11. Troubleshooting ladder

Work top to bottom; each step names its cause.

1. **`play.bat` shows a message box and refuses to start.** Read it — it names
   the missing/wrong-size file or the unpatched exe. Re-copy from the archive,
   or re-run `patch-my-client.bat`. This is the system working.
2. **Game runs but many surfaces are untextured/white.** You bypassed the
   launcher with an incomplete install: `client_highres.dat` missing/truncated,
   exe not patched, or a client "repair" restored a stock exe. Run `play.bat`
   once — it will tell you which.
3. **Textures look no better than retail.** `UserPreferences.ini` texture
   detail not at `VeryHigh` (§8 — and remember `=0` means VeryLow, not full). Note: creature/armor improvements are resolution
   upscales — visible up close, genuinely invisible at distance (the mip chain
   samples them back down). That's expected, not a broken install.
4. **"Cannot have two accounts logged on at the same time."** You reconnected
   too fast after a crash/kill. Wait ~2–3 minutes (the ghost session lingers
   ~110–150 s), then retry. After a clean logout a few seconds is enough.
5. **"DAT files are incomplete" dialog at login.** The server's dat-version
   handshake (DDD) doesn't match your dats — you're on a server that serves a
   different dat lineage. This is a server-pairing problem, not an install
   problem: connect to a server running the matching ACME set, or restore your
   backups to play there.
6. **Exactly ~10 fps, constant.** Window activation throttle — the client
   deactivated (launched behind another window, or a focus quirk). Click in the
   game window. If launching via scripts: the window must actually receive a
   real activation, not just be "visible".
7. **Sudden fps drop after alt-tab or resolution change (plugin pack).** The
   device-reset path with `diet=3` is the least-tested corner. Relog fixes it;
   if reproducible, set `diet=2` (or 0) at boot and report.
8. **Town crashes.** §9. Check `diet=3`/`memgov=1`, capture a dump, report with
   the last 200 log lines.
9. **Something visual is wrong (plugin pack).** Bisect with live knobs, no
   restart needed: `bloom=0`, `bloomday=0`, `glowlights=0`, `torchlights=0`,
   `selection=0`+restart, `flicker=0`. Sky wrong → remove/rename
   `plugins\AcmeSky`. Death animations wrong → remove `plugins\AcmeRagdoll`.
   Each plugin folder is independent.
10. **Plugins don't load / your antivirus warned about `acclient.exe` or the
    injector.** The plugin pack injects into the running client (as Decal and
    all AC plugin tools do), which AV/EDR can block. If you want the plugins,
    add an exclusion for the game folder and the injector in your AV; if you
    don't, ignore it — the dats + exe patch (the visual upgrade) do **no**
    injection and work regardless, so a blocked injector just means "no plugins",
    not a broken game. Only add exclusions you understand.
11. **Total rollback.** Restore your backed-up dats and
    `acclient.exe.acme-orig.bak` (rename to `acclient.exe`), delete/skip the
    Chorizite folder. You're back to bone-stock retail.

## 12. Scriptable command line

Everything the four tabs do is also a command — same exe, no separate tool.
Handy for batch files, multi-box setups, or fixing a machine over remote help:

```bat
zzpatcher.exe --help                        rem the full command table
zzpatcher.exe --list                        rem running clients + plugin state (tab-separated)
zzpatcher.exe --status                      rem per-client health lights + summaries
zzpatcher.exe --attach-all                  rem enable plugins on every plain client
zzpatcher.exe --knobs ragdoll               rem knob catalogue with current values
zzpatcher.exe --tune sky.cloudcover=0.8 lights.bloom=1
zzpatcher.exe --save-profile mine.zzp       rem snapshot; --load-profile restores (validated like --tune)
zzpatcher.exe --check-dats > report.txt     rem output redirects like any console tool
```

Exit codes are script-friendly: `0` ok, `1` a check found problems, `2` bad
arguments, `4` a destructive command (`--rollback`, `--uninstall-plugin`) was
run without `--yes`, plus the injector's own statuses (23 = already injected,
24 = no clients). Profiles (`.zzp`) are interchangeable between the GUI's
Save/Load buttons and `--save-profile`/`--load-profile`.

## 13. Appendix — developer/reference values

For whoever maintains this after the fact:

- Reference Windows machine: GTX 1070, install at `D:\ac-dat-test` (dats + exe),
  plugin runtime at `C:\Games\Chorizite`, launch rig `C:\Temp\acdt-inject.bat`
  (`ACMEINJECT_ARGS=-h <dev-server> -p 9000 -a <dev-account> -v <dev-password> -rodat 1`).
  Dev server = a vanilla ACE (master @a8ff29f + entity-cache mod) serving the
  matching dat pair.
- Current lineage at time of writing (r10work): portal 572,314,624 B, cell
  347,298,304 B, highres ~1.33 GB (the exact highres size is lineage-specific —
  the shipping `kit-manifest.txt`/`SHA256SUMS.txt` is authoritative, not this
  note). Canonical patched exe: md5 `061106ec1cb6248204a63be2147b5bca`,
  sha256 `f2880d6c…75a40730` — **9 shipped patches** (`palette-leak` ×2,
  `palette-double-free`, `dat-version-preserve`, `highres-force-mount`,
  `highres-advertise-cap`, `res-4k-unlock` ×2, `dat-align-lfa`; the last is a
  189-site idiom scan, one logical patch). The kit patchers
  (`acme-patch-client.ps1`/`.py`) reproduce this exact artifact byte-for-byte
  from a pristine retail exe — gated by `tools/dat-patch/kit/check_ps1_table.py`.
- Repo landmarks: `ac-eor-patch/PATCHES.md` + `patch_client.py` (patch
  registry/patcher), `docs/dat-patch/` (the full content-lane history and every
  gate report), `docs/lights-port/` (the plugin lane; the memory work is
  `HANDOFF-2026-08-24-mirror-diet-design.md`), `AcmeLights/Lib/LightsConfig.cs`
  (the authoritative knob list — every `case "<knob>"` line), kit smoke artifacts
  at the `redline-kit-smoke` lane (play.bat/manifest reference copies).
- Ship-gate evidence: 14-town gauntlets with 20 s sprint legs on the reference
  machine (zero crashes with `diet=3`, worst-town priv 1.28 GB on the tour /
  748 MB–1.13 GB on the sprint tour) and a **plain client, no plugin pack**
  under wine on a Tesla T4 (14/14, zero faults — that arm evidences the exe +
  dats, not the diet) — reports in
  `docs/lights-port/HANDOFF-2026-08-24-mirror-diet-design.md` and
  `docs/dat-patch/REPORT-2026-08-24-wine-ship-gate.md`.

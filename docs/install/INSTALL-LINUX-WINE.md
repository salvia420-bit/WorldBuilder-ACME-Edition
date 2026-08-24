# Asheron's Call (ACME Edition) — Linux Install Guide (Wine)

This guide gets the game running on Linux using Wine. The short version at the top
is all most people need. The further down you read, the more technical it gets —
the deep sections exist so that if something breaks, you can fix it yourself.

**What you need before starting:**

- **A full, working retail Asheron's Call install** (the 2015 End-of-Retail
  client). This is the critical bit: the ACME kit is a *patch over your own
  install*, not a whole game. Your install folder must already contain
  `acclient.exe` **and its ~38 support DLLs** (`corestrings.dll`, `Keystone.dll`,
  `MSVCP71.dll`, `chatclient.dll`, …). If you only have `acclient.exe` and the
  dats in a bare folder, the client starts but shows placeholder text everywhere
  (see the `corestrings.dll` note in Troubleshooting) — get a complete install
  first.
- The ACME kit you downloaded. It ships **three** dats (`client_portal.dat`,
  `client_highres.dat`, `client_cell_1.dat`), the client patcher
  (`acme-patch-client.py`), and `play.bat`/README — **no game executable and no
  `UserPreferences.ini`** (those stay yours; the kit patches your own
  `acclient.exe` in place).
- The server address and your account name/password (from whoever runs your server).
- About 4 GB of free disk space and 8 GB of system RAM.
- Any 64-bit Linux with a working graphics driver (NVIDIA, AMD, or Intel).

---

## Quick install (do these six steps)

Open a terminal and paste each block.

**1. Install Wine, including 32-bit support** (the game is a 32-bit program):

```sh
# Debian / Ubuntu / Mint
sudo dpkg --add-architecture i386
sudo apt update
sudo apt install wine wine32 wine64

# Arch / Manjaro  (enable [multilib] in /etc/pacman.conf first)
sudo pacman -S wine

# Fedora
sudo dnf install wine
```

**2. Install 32-bit graphics libraries.** Without these the game falls back to a
software renderer and crawls. The game is 32-bit, so it needs the **32-bit**
driver, which is a separate package from the 64-bit one. Pick your GPU:

```sh
# NVIDIA — Debian/Ubuntu (match YOUR installed driver major version, e.g. 535/550):
sudo apt install libnvidia-gl-535:i386
# NVIDIA — Arch:
sudo pacman -S lib32-nvidia-utils
# NVIDIA — Fedora (RPM Fusion):
sudo dnf install xorg-x11-drv-nvidia-libs.i686

# AMD / Intel (Mesa) — Debian/Ubuntu  (libgl1 alone is only the loader — you
# need the actual hardware DRI driver, or you land on llvmpipe/software):
sudo apt install libgl1-mesa-dri:i386 libglx-mesa0:i386 mesa-vulkan-drivers:i386
# AMD / Intel — Arch:
sudo pacman -S lib32-mesa
# AMD / Intel — Fedora:
sudo dnf install mesa-dri-drivers.i686 mesa-libGL.i686
```

(Package names vary by distro/release; if one isn't found, search your package
manager for your GPU's 32-bit / `i386` / `lib32-` GL driver.)

**3. Create a Wine prefix for the game** (a private Windows-like folder, so the
game can't interfere with anything else you run in Wine):

```sh
WINEPREFIX=~/acwine wineboot -u
```

**4. THE IMPORTANT STEP — set the video memory size.** This single registry key
is required: without it the 2005-era client mishandles a modern GPU's large VRAM
figure and faults (typically at world entry), and a surviving session also
stutters badly outdoors. Every fresh prefix needs it:

```sh
WINEPREFIX=~/acwine wine reg add 'HKCU\Software\Wine\Direct3D' /v VideoMemorySize /t REG_SZ /d 2048 /f
```

**5. Copy the kit's dats into your retail install folder, then patch your own
exe.** Copy the kit's three `client_*.dat` files and the patcher scripts into the
folder that already holds your `acclient.exe` (back up the originals first — the
dats overwrite, the patcher keeps its own `acclient.exe.acme-orig.bak`):

```sh
cd ~/ac              # <- YOUR retail install folder (has acclient.exe + the base DLLs)
cp ~/Downloads/acme-kit/client_*.dat .
cp ~/Downloads/acme-kit/acme-patch-client.py .
python3 acme-patch-client.py            # patches your acclient.exe in place, keeps a backup
python3 acme-patch-client.py --check-kit   # verifies dats + patched exe; prints KIT-OK
```

Then set texture detail to full — edit these two lines in your
`UserPreferences.ini` (in the install folder or `~/.../drive_c/users/<you>/`),
spelling the words out (a **number** here is a worst-first index, so `=0` is the
*ugliest* setting):

```ini
[Render]
EnvironmentTextureDetail=VeryHigh
LandscapeTextureDetail=VeryHigh
```

**6. Launch** (note: `acclient.exe`, the one you just patched — the kit ships no
separate exe):

```sh
cd ~/ac
WINEPREFIX=~/acwine wine acclient.exe -h <server-address> -p 9000 -a <account> -v <password> -rodat
```

Replace `<server-address>`, `<account>`, `<password>` with your own. The game
starts windowed, shows the character screen, and you double-click your character
to enter the world. That's it.

> Tip: put step 6 in a small `play.sh` script so it's one command from now on.

---

## What performance to expect

Reference numbers measured 2026-08-24 on an NVIDIA Tesla T4 (roughly a GTX 1070
class card), 1920×1080, all settings VeryHigh, default Wine (no DXVK):

| Situation | fps |
|---|---|
| Town, outdoors, settled | 90–96 |
| Right after a teleport (world still streaming in) | 50–55 for a few seconds |
| Dungeons / indoors | 500+ |

A 7-town, 2-lap tour (14 stops) with 20-second sprints out of every town ran to
completion with **zero crashes and zero page faults** on this exact setup (plain
client, no plugin pack — that's the tested Linux posture). Per-town fps ranged
62–295. If your numbers are wildly below this (especially outdoors), go to
[Low fps outdoors](#low-fps-outdoors--the-checklist) below — it is almost always
one of two fixable environment problems.

Memory: the client uses 2.6–3.2 GB in towns. The retail exe is *already*
large-address-aware, and 64-bit Wine gives a 32-bit LAA process ~4 GB — this is
why step 1 installs `wine64` as well; don't build a pure-32-bit Wine for this
game. (The `dat-align-lfa` patch in your exe is a *separate* fix — it corrects
DAT-parser math that goes wrong once the process crosses 2 GB, not the address
space itself.)

---

## Configuration reference

### Launch flags

```
-h <address>   server IP or hostname
-p 9000        server port (9000 is the standard ACE port)
-a <account>   account name (auto-login)
-v <password>  password (auto-login)
-rodat         open the dat files read-only (recommended; prevents the client
               writing into your dats, which keeps them byte-identical to what
               the server expects)
```

`-a`/`-v` auto-fill the login screen; omit them to type your login by hand. The
server host/port are what you actually need to reach a server.

### UserPreferences.ini

This is **your own** file (the kit ships no ini) — edit it, don't replace it, or
you'll lose your keybinds and audio settings. Notes that matter:

- **Texture detail is a trap** (repeat of step 5, because it bites everyone):
  spell the choice name — `EnvironmentTextureDetail=VeryHigh` /
  `LandscapeTextureDetail=VeryHigh`. A **numeric** value is read as a worst-first
  index, so `=0` selects VeryLow (quarter detail) — the opposite of what it looks
  like. When unsure, set it from the in-game options screen instead.
- **Windowed mode is the best-tested option** (`FullScreen=False`) — windowed
  D3D9 doesn't lose the device on alt-tab. Fullscreen works too; it just saw less
  validation.
- The client **saves preferences on clean exit** — keep a backup of a "known
  good" ini; a crashed or tweaked session can overwrite it.

### The prefix

Everything above uses `WINEPREFIX=~/acwine`. You can pick any path, but use the
same one in every command — the VideoMemorySize key from step 4 lives *inside*
the prefix, so a new prefix silently loses it (and your fps with it).

---

## Low fps outdoors — the checklist

Symptom: indoors is fine, outdoors is 25–30 fps or worse. Two known causes, in
order of likelihood:

### 1. The VideoMemorySize key is missing

Wine reports your GPU's real VRAM to the game. On a modern card the 2005-era
client mishandles that large figure — a 4 MiB `memset` overruns a smaller region
— and it faults (classically right at world entry, but a surviving session also
thrashes the texture-purge path outdoors). **Capping the reported figure at
2048 MB** fixes both: it stops the overrun and keeps the purge trigger
(`IsAvailableVideoMemoryLow`, `acclient.c:457974`) from firing. Verify:

```sh
WINEPREFIX=~/acwine wine reg query 'HKCU\Software\Wine\Direct3D'
```

You must see `VideoMemorySize REG_SZ 2048`. If not, re-run step 4. Set exactly
`2048` — leaving it unset or setting it absurdly high both re-expose the overrun.
This is the single most important Wine setting for this game; every fresh prefix
needs it.

### 2. You're on software rendering (missing 32-bit GPU driver)

The game is 32-bit, so it needs the **32-bit** OpenGL driver, which is a separate
package from the 64-bit one on every distro. Check what the 32-bit side sees:

```sh
# 64-bit check (should already be your GPU):
glxinfo | grep "OpenGL renderer"

# 32-bit driver files present? (this is the side the game uses)
# NVIDIA (Debian/Ubuntu path shown; Arch: /usr/lib32/):
ls /usr/lib/i386-linux-gnu/ | grep -i libGLX_nvidia && echo "32-bit NVIDIA GL: OK"
# Mesa (AMD/Intel):
ls /usr/lib/i386-linux-gnu/dri/ 2>/dev/null | head   # radeonsi/iris/... = OK
```

The definitive in-game check: launch once with `WINEDEBUG=+fps` added (see the
crash-capture command below) and look at the wine log — WineD3D prints the GL
renderer it picked near the top, and `approx N fps` lines while running. A
renderer string containing `llvmpipe`, `softpipe`, or `SWRast` means software
rendering — go back to Quick-install step 2 and install the `:i386` / `lib32-`
driver package for your GPU, then reboot. (On the dev box this exact state —
NVIDIA 64-bit driver installed, no 32-bit compat libraries — was the other
source of terrible fps.)

Also worth knowing: fps dips to ~50 for a few seconds right after a teleport are
*normal* — that's the world streaming in — and recover on their own.

---

## Troubleshooting dialogs and errors

**"DAT files are incomplete"** on the login screen: this is the *server's*
message, not a client check — the server compared its dat iterations against
yours, found a mismatch, and (with DAT patching disabled, the ACE default)
booted the session. Fix: use exactly the dat set shipped for your server — all
of them, from the same release. Don't mix a portal from one release with a
highres from another, and don't let a stock retail installer's dats shadow the
shipped ones.

**"Cannot have two accounts logged on at the same time"**: you reconnected too
fast. After a *clean* logout the server holds your character in-world only a few
seconds. But after a **crash or a killed client** — the case that usually
produces this dialog — the ghost session lingers much longer: measured around
**110–150 seconds**. Wait **~2–3 minutes** and log in again; retrying inside that
window just re-triggers the message.

**Error box `<corestrings.dll not found. Tried to print stringID …>`** (message
text shows as placeholders): this is NOT cosmetic and NOT a login collision — the
client could not load `corestrings.dll`. You launched from a bare or overlay-only
folder. Run from your **full retail install folder**, which supplies
`corestrings.dll` and ~37 other base DLLs (see "What you need"). This is the most
common "I only copied the exe and dats" mistake.

**Client exits instantly with no window**: usually the wrong working directory —
`cd` into the game folder first (the client finds its dats and DLLs by working
directory).

**Black window / nothing renders, but sound or UI works**: almost always the
32-bit-driver problem above; check the renderer string.

---

## Crashes: how to capture something useful

The shipped configuration ran the full stress tour crash-free, so a crash on
your machine is most likely environmental — but capture it so it can be fixed:

```sh
cd ~/ac
WINEPREFIX=~/acwine WINEDEBUG=+seh wine acclient.exe -h <server> -p 9000 -a <acct> -v <pw> -rodat > ~/ac-crash.log 2>&1
```

`+seh` logs every Windows-side exception. After the crash:

```sh
grep -a "Unhandled page fault" ~/ac-crash.log | tail -5
```

Attach the last ~200 lines of the log to your bug report. Things a maintainer
will want to know: your GPU + driver version, `wine --version`, whether the
VideoMemorySize key is set, and whether the crash is reproducible in the same
place in-world.

Context that may save someone a rabbit hole — the release history had three
distinct client crashes, all fixed by byte patches that are in your patched exe:

1. **UI won't render / crash at startup against the ACME dats** — the kit portal
   is compressed, and `dat-version-preserve` is load-bearing at startup (an
   unpatched exe cannot boot these dats at all). Fixed 2026-08-17.
2. **Heap corruption ~30–45 s after world entry** — fixed 2026-08-17 by
   `dat-version-preserve` (the palette patches were *ruled out* for this one).
3. **World-entry heap corruption with pink/broken avatars** — a genuine palette
   **double-free** in the client, tickled by the modded dats; fixed 2026-08-19
   by `palette-double-free`. Running an OLD exe missing this patch resurrects it,
   so verify your exe (next section).

Separately there's a Windows-side **town crash family** (heap *fragmentation* in
dense towns — low-2 GB contiguity, not raw exhaustion; the client is already
large-address-aware on both platforms). It was **not observed in the Wine ship
gauntlet** (14/14, VM 2.6–3.2 GB, plain client), but it is still an open blocker
on the Windows plugin build — which is why the plain client is the tested Linux
posture and the memory-management plugins are a Windows concern, not a Linux one.

---

## Verifying your files

Your `acclient.exe` is your own retail exe plus a set of byte patches applied by
`acme-patch-client.py`. To confirm it's fully patched for this release:

```sh
python3 acme-patch-client.py --check-kit
```

This checks the dats against `kit-manifest.txt` AND every patch site in your exe,
and prints `KIT-OK` only when all are correct. (`acme-patch-client.py --verify`
reports the per-patch state without the dat check.) The pristine unpatched retail
exe is md5 `116d9a66a70b6af449dc3a28d82f2f6d` — it will **not** start against the
ACME dats at all (the compressed-record patch is load-bearing at startup), so a
mismatch there is expected, not a problem; the check tool is the real test.

The shipping patch set (all applied by the kit patcher): `palette-leak` ×2 +
`palette-double-free` (crash fixes), `dat-version-preserve` (compressed dats),
`highres-force-mount` + `highres-advertise-cap` (mounts `client_highres.dat`),
`res-4k-unlock` ×2 (UI resolution clamps removed), `dat-align-lfa` (189-site
DAT-parser alignment fix for >2 GB). Patches are located by byte signature, not
offset, so the patcher works on any pristine retail exe and refuses anything it
doesn't recognise.

---

## Advanced: DXVK (Vulkan) as an alternate renderer

The measured-good default is Wine's built-in D3D9→OpenGL (everything above). If
that path misbehaves on your driver — or you just want to try Vulkan — DXVK's
D3D9 is a well-trodden community path for this client and is proven to
hardware-accelerate it (validated on the dev T4 with DXVK 2.4.1):

1. Install 32-bit Vulkan drivers (`lib32-vulkan-icd-loader` + your GPU's 32-bit
   Vulkan package on Arch; `mesa-vulkan-drivers:i386` on Debian/Ubuntu;
   NVIDIA's driver ships Vulkan with the compat32 GL package).
2. Download a DXVK release, copy its **x32** `d3d9.dll` into
   `~/acwine/drive_c/windows/syswow64/`.
3. Launch with the override:

```sh
WINEPREFIX=~/acwine WINEDLLOVERRIDES=d3d9=n wine acclient.exe -h <server> -p 9000 -a <acct> -v <pw> -rodat
```

`d3d9=n` means "use the native (DXVK) d3d9.dll". Remove the override to go back
to WineD3D.

**Required for the DXVK path:** a `dxvk.conf` next to the exe containing

```ini
d3d9.textureMemory = 0
```

Without it the game **crashes outdoors** under DXVK (32-bit texture-paging tmpfs
exhaustion). Keep this line. Optionally add `d3d9.samplerAnisotropy = 16` in the
same file for sharper ground textures at grazing angles.

The `VideoMemorySize` registry key is a WineD3D setting and does not affect DXVK,
so DXVK can double as a cross-check: if DXVK is fine and WineD3D is slow, your
WineD3D registry key is probably missing.

---

## Advanced: plugins (Chorizite) under Wine — experimental

The release ships an optional plugin stack (the open-source **Chorizite** runtime,
MIT-licensed and bundled — see `THIRD-PARTY-PROVENANCE.md` — plus the Acme
plugins: lighting/bloom, sky, ragdolls, and a memory governor). The **supported
Linux posture is the plain client** — that is what the shipping gauntlet
validated, and under 64-bit Wine the plain client doesn't need the memory
plugins at all (they exist for Windows' 32-bit 2 GB ceiling). Note the plugin
runtime injects into the client, which some AV (or, rarely, Wine security
wrappers) may interfere with; the plain client does no injection and is
unaffected.

For tinkerers: injection itself works under Wine — the release's `AcmeInject`
is a base-aware injector written specifically because the stock injection method
faults under Wine's different DLL base layout (it reads the bootstrap's *remote*
base from the load-thread exit code). AcmeLights and AcmeRagdoll run under
Wine+DXVK on the dev box. Two Wine-only prerequisites, or every plugin fails to
load:

```sh
# 1. the plugin runtime needs its temp dir to exist:
mkdir -p ~/acwine/drive_c/users/$USER/Temp/chorizite
# 2. plugin asset dirs need the traverse bit:
find ~/path/to/Chorizite/plugins -type d -exec chmod u+rwx {} +
```

Known-broken: the AcmeSky **live** volumetric compositor's D3D11→D3D9 readback
faults under DXVK — and note the live sky **defaults ON**, so under Wine you must
turn it off: set `live = 0` in `sky.cfg` (the cfg file is the last word — it
outranks any `ACMESKY_LIVE` env), or just run `--fix-wine --apply` (next
section). AcmeSky's **baked** sky (`live = 0`) is proven working under Wine. None of the plugin stack is
gate-tested for shipping on Linux; you are in experimental territory, and the
plain client is the known-good fallback.

---

## The z-z patcher tool under Wine

The release's plugin-manager/tuner GUI (`zzpatcher.exe`) does **not** run under
Wine — WPF dies with a stack overflow during startup (tested wine 8.0; don't
re-tread it). Its **headless commands run fine**, and they automate this doc:

```sh
cd /path/to/Chorizite
WINEPREFIX=~/acwine wine zzpatcher.exe --fix-wine           # CHECK the Wine checklist
WINEPREFIX=~/acwine wine zzpatcher.exe --fix-wine --apply   # apply the safe fixes
```

`--fix-wine` checks the four Wine items this guide describes by hand — the
`VideoMemorySize=2048` registry cap, `dxvk.conf`'s required
`d3d9.textureMemory = 0`, the plugin runtime's `Temp\chorizite` dir, and that
AcmeSky is in baked (not live) mode — printing one
`WINEFIX <name> <verdict> <detail>` line each. Verdicts: `OK`, `MISSING`/`WRONG`
(a real problem), or `ADVISORY-MISSING`/`ADVISORY-WRONG` for the situational
rows — `dxvk.conf` when you don't use DXVK, the plugin temp dir on a
plain-client install. **Exit 0 = nothing blocking** (advisory rows don't fail
the exit code). With `--apply` it performs the fixes that are plain
file/registry writes (`applied:` / `apply-FAILED:` lines) and re-reports; it
will patch an existing `dxvk.conf` but only *creates* one when you also pass
`--dxvk` (creating it unasked would mislead non-DXVK users). The sky fix writes
`live = 0` into the cfg, which outranks any `ACMESKY_LIVE` env the plugin sees.
Plugin cfg tuning works headlessly the same way:
`wine zzpatcher.exe --tune sky.cloudcover=0.4`. The exe/dat patching itself
stays native (`python3 acme-patch-client.py`), as above.

---

## Appendix: how the Linux validation was actually done (dev notes)

For whoever maintains this after a hiatus:

- Validation box: GCE `n1-standard-2` + Tesla T4, headless Xorg on the T4, wine
  8.0 + wine32, NVIDIA compat32 GL, DXVK staged, tailscale to a laptop-hosted
  vanilla ACE server. (A player desktop needs none of the headless gymnastics —
  they already have a display.)
- The full recipe, gate scripts (`~/gate-*.sh`, `~/wine-gauntlet.sh`,
  `~/fps-triage.sh`) and traps (double-launch on timed-out ssh, self-matching
  `pkill`, the 90–130 s inter-launch account guard) live in
  `docs/dat-patch/REPORT-2026-08-24-wine-ship-gate.md`,
  `docs/dat-patch/HANDOFF-2026-08-17-EOD.md`, and the fleet runbook.
- fps was measured with `WINEDEBUG=+fps` (WineD3D prints an `approx N fps` line
  per present interval to stderr) — useful for any player-side perf report too:
  add `,+fps` to the `WINEDEBUG` value in the crash-capture command above.
- History of the Wine-specific crash hunt (killed hypotheses list, so nobody
  re-treads them: VA exhaustion, d3d9 format/pitch mismatch, detail level,
  `-rodat`, win32-vs-win64 prefix, esync, audio, DXVK-vs-WineD3D, oversized
  record inflates): `docs/dat-patch/HANDOFF-2026-08-17-EOD.md` §"THE open
  blocker" — resolved by the `palette-double-free` patch, see
  `/mnt/wbterminal2/ac-eor-patch/PATCHES.md` provenance table.

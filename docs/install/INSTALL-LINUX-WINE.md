# Asheron's Call (ACME Edition) — Linux Install Guide (Wine)

This guide gets the game running on Linux using Wine. The short version at the top
is all most people need. The further down you read, the more technical it gets —
the deep sections exist so that if something breaks, you can fix it yourself.

**What you need before starting:**

- The game kit you downloaded (the patched `acclient.eor.patched.exe`, the four
  `client_*.dat` files, and `UserPreferences.ini`). All five dat/ini files and the
  exe live together in one folder.
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

**2. Install 32-bit graphics libraries.** Without these the game runs on a software
renderer and gets 5–30 fps. Pick your GPU:

```sh
# NVIDIA — Debian/Ubuntu (match your installed driver major version, e.g. 535):
sudo apt install libnvidia-gl-535:i386
# NVIDIA — Arch:
sudo pacman -S lib32-nvidia-utils
# NVIDIA — Fedora (RPM Fusion):
sudo dnf install xorg-x11-drv-nvidia-libs.i686

# AMD / Intel (Mesa) — Debian/Ubuntu:
sudo apt install mesa-vulkan-drivers:i386 libgl1:i386
# AMD / Intel — Arch:
sudo pacman -S lib32-mesa
# AMD / Intel — Fedora:
sudo dnf install mesa-dri-drivers.i686 mesa-libGL.i686
```

**3. Create a Wine prefix for the game** (a private Windows-like folder, so the
game can't interfere with anything else you run in Wine):

```sh
WINEPREFIX=~/acwine wineboot -u
```

**4. THE IMPORTANT STEP — set the video memory size.** This single registry key is
the difference between a smooth game and a 25–30 fps slideshow outdoors. Every
fresh prefix needs it:

```sh
WINEPREFIX=~/acwine wine reg add 'HKCU\Software\Wine\Direct3D' /v VideoMemorySize /t REG_SZ /d 2048 /f
```

**5. Put the game folder somewhere easy** (example: `~/ac`), so it contains
`acclient.eor.patched.exe`, `client_portal.dat`, `client_cell_1.dat`,
`client_highres.dat`, `client_local_English.dat`, `UserPreferences.ini`.

**6. Launch:**

```sh
cd ~/ac
WINEPREFIX=~/acwine wine acclient.eor.patched.exe -h <server-address> -p 9000 -a <account> -v <password> -rodat
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

A 14-town, 2-lap stress tour with 20-second sprints out of every town ran to
completion with **zero crashes and zero page faults** on this exact setup. If your
numbers are wildly below this (especially outdoors), go to
[Low fps outdoors](#low-fps-outdoors--the-checklist) below — it is almost always
one of two fixable environment problems.

Memory: the client uses 2.6–3.2 GB in towns. The shipped exe is patched
large-address-aware, and 64-bit Wine gives it the full 4 GB it wants — this is why
step 1 installs `wine64` as well; don't build a pure-32-bit Wine for this game.

---

## Configuration reference

### Launch flags

```
-h <address>   server IP or hostname
-p 9000        server port (9000 is the standard ACE port)
-a <account>   account name
-v <password>  password
-rodat         open the dat files read-only (recommended; prevents the client
               writing into your dats, which keeps them byte-identical to what
               the server expects)
```

The client with **no** arguments exits silently — the `-h/-p/-a/-v` set is
required.

### UserPreferences.ini

Lives next to the exe. Notes that matter:

- **Windowed mode is recommended** (`FullScreen=False`). It's what all shipping
  validation ran, and windowed D3D9 does not lose the device on alt-tab.
- **Texture detail values are a trap**: the numeric INI values are a *choice
  index, worst-first* — a bigger number is NOT better. If you edit detail levels
  by hand you can silently get the ugliest setting. Use the in-game options
  screen, or take the shipped `UserPreferences.ini` (already set to VeryHigh)
  and leave the detail lines alone.
- The client **saves preferences on clean exit** — if you keep a "known good"
  ini, keep a backup copy; a crashed or tweaked session can overwrite it.

### The prefix

Everything above uses `WINEPREFIX=~/acwine`. You can pick any path, but use the
same one in every command — the VideoMemorySize key from step 4 lives *inside*
the prefix, so a new prefix silently loses it (and your fps with it).

---

## Low fps outdoors — the checklist

Symptom: indoors is fine, outdoors is 25–30 fps or worse. Two known causes, in
order of likelihood:

### 1. The VideoMemorySize key is missing

Wine's built-in Direct3D advertises a tiny amount of video memory by default.
The 2005-era client believes it, decides it is out of VRAM, and constantly
purges and reloads textures — which murders outdoor areas (they use the most
textures) while dungeons stay fast. Verify:

```sh
WINEPREFIX=~/acwine wine reg query 'HKCU\Software\Wine\Direct3D'
```

You must see `VideoMemorySize REG_SZ 2048`. If not, re-run step 4. This was
found the hard way: it is the single "unlock" that took the dev test box from a
slideshow to hundreds of fps.

Technical detail for the curious: the client's texture-purge trigger
(`acclient.c:457974` in the decompiled source) never fires on a modern VRAM
figure; `2048` (MB) puts you safely past it. Don't set it absurdly high — an
uncapped value overflows a 4 MiB memset in the client.

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

**"DAT files are incomplete"** on the login screen: your `client_*.dat` files do
not match what the server serves. This is the client's own update check (DDD)
refusing the mismatch. Fix: use exactly the dat set shipped for your server —
all of them, from the same release. Don't mix a portal from one release with a
highres from another, and don't let a stock retail installer's dats shadow the
shipped ones.

**"Cannot have two accounts logged on at the same time"**: you reconnected too
fast. When a client disconnects, the server keeps the character in-world for the
logout animation (~8 seconds — an anti-combat-logging rule). Wait ~10 seconds
and log in again. If it persists, another session really is holding the account.

**Error box mentioning `corestrings.dll not found`**: cosmetic side effect of a
login collision (usually appears together with the two-accounts message). Click
OK, wait, retry. It does not indicate a broken install.

**Client exits instantly with no window**: you launched with no arguments, or
from the wrong directory. `cd` into the game folder first (the client finds its
dats by working directory).

**Black window / nothing renders, but sound or UI works**: almost always the
32-bit-driver problem above; check the renderer string.

---

## Crashes: how to capture something useful

The shipped configuration ran the full stress tour crash-free, so a crash on
your machine is most likely environmental — but capture it so it can be fixed:

```sh
cd ~/ac
WINEPREFIX=~/acwine WINEDEBUG=+seh wine acclient.eor.patched.exe -h <server> -p 9000 -a <acct> -v <pw> -rodat > ~/ac-crash.log 2>&1
```

`+seh` logs every Windows-side exception. After the crash:

```sh
grep -a "Unhandled page fault" ~/ac-crash.log | tail -5
```

Attach the last ~200 lines of the log to your bug report. Things a maintainer
will want to know: your GPU + driver version, `wine --version`, whether the
VideoMemorySize key is set, and whether the crash is reproducible in the same
place in-world.

Context that may save someone a rabbit hole: the release history had exactly two
crash families. (1) An in-world heap corruption ~30–45 s after entry under Wine
— that was a client palette **double-free** bug tickled by the modded dats, fixed
2026-08-19 by the `palette-double-free` byte patch which is in the shipped exe;
if you somehow run an OLD exe you can resurrect it, so verify your exe (next
section). (2) A Windows-only 32-bit address-space exhaustion in dense towns —
not applicable under 64-bit Wine, which grants the client the full 4 GB.

---

## Verifying your files

The shipped exe is the retail End-of-Retail client plus a set of byte patches.
To confirm you have the right one:

```sh
md5sum acclient.eor.patched.exe
```

- Shipped patched exe (2026-08-24 lineage): `061106ec1cb6248204a63be2147b5bca`
- Pristine unpatched retail exe: `116d9a66a70b6af449dc3a28d82f2f6d` — this one
  will boot but is **wrong** for the shipped dats (no large-address patch, no
  palette double-free fix, no highres mount).

If the release includes `patch_client.py` (the patch tool), you can audit any
exe: `python3 patch_client.py verify acclient.eor.patched.exe` prints, per
patch, whether the bytes are original or patched. The shipping set is:
`palette-leak` ×2 + `palette-double-free` (crash fixes), `dat-version-preserve`,
`highres-force-mount` + `highres-advertise-cap` (mounts `client_highres.dat`),
`res-4k-unlock` ×2 (UI resolution clamps removed), `dat-align-lfa`
(large-address alignment). Patches are located by byte signature, not offset, so
`verify` also works on partially patched or unknown files — anything it reports
as "unknown bytes" is not a shipped artifact.

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
WINEPREFIX=~/acwine WINEDLLOVERRIDES=d3d9=n wine acclient.eor.patched.exe -h <server> -p 9000 -a <acct> -v <pw> -rodat
```

`d3d9=n` means "use the native (DXVK) d3d9.dll". Remove the override to go back
to WineD3D. The `VideoMemorySize` registry key does not apply to DXVK (DXVK
reports real VRAM), so it can also serve as a cross-check: if DXVK is fast and
WineD3D is slow, your WineD3D registry key is missing.

Optional: a `dxvk.conf` next to the exe can force anisotropic filtering
(`d3d9.samplerAnisotropy = 16`) for sharper ground textures at grazing angles.

---

## Advanced: plugins (Chorizite) under Wine — experimental

The Windows build ships with an optional plugin stack (Chorizite + the Acme
plugins: lighting/bloom, sky, ragdolls, and a memory governor). The **supported
Linux posture is the plain client** — that is what the shipping gauntlet
validated, and under 64-bit Wine the plain client doesn't need the memory
plugins at all (they exist for Windows' 32-bit 2 GB ceiling).

For tinkerers: injection itself works under Wine — the release's `AcmeInject`
is a base-aware injector written specifically because the stock injection method
faults under Wine's different DLL base layout (it resolves the bootstrap export
at the *remote* base). Ragdolls and lighting have run under Wine+DXVK on the dev
box. Known-broken: the AcmeSky live compositor's D3D11→D3D9 readback path
crashes under DXVK — leave AcmeSky disabled under Wine. None of this is
gate-tested for shipping; you are in experimental territory, and the plain
client is the fallback that is known-good.

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

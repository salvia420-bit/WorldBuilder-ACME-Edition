# WINE-RIG — running the retail Asheron's Call client headless as a movement oracle

A retail `acclient.exe`, under Wine on the buildbox, logged into the vanilla
ACE server on the laptop, is the movement/combat **ground truth** the
holtburger parity oracle diffs against. This is how to stand it up from
nothing, and every trap that cost time the first time.

Everything here is reproducible from two scripts:

| script | host | what it does |
|---|---|---|
| `scripts/oracle/box-rig.sh` | buildbox | packages, wine prefix, client install, Xvfb, client launch, capture |
| `scripts/oracle/tunnel-up.sh` | laptop | host-side UDP relays + the `ssh -R` tunnel |
| `scripts/oracle/relay-box.sh` | buildbox | box-side UDP relays |
| `scripts/oracle/udp_tcp_relay.py` | both | the datagram-preserving relay itself |

> **Client sources are owner-supplied and are deliberately not recorded in
> git.** Two artifacts are needed on the box in `~/acdl/`: the retail
> installer (`ac1install.exe`) and the End-of-Retail archive. Keep the URLs in
> `~/oracle-notes.md` on the box, not here.

---

## 0. The one-paragraph version

Install the **base** client from the InstallShield installer, drop the four
End-of-Retail files on top, write `UserPreferences.ini` with
`FullScreen=False`, disable wine's gstreamer, start an Xvfb **with GLX**, and
point the client at a UDP relay that tunnels to ACE. Miss any one of those and
the client either refuses to start or starts and transmits nothing.

---

## 1. Box preparation

```sh
./box-rig.sh setup
```

Installs wine + i386, Xvfb, xauth, xdotool, ImageMagick, Mesa, socat, tcpdump,
unshield, and creates a **32-bit** prefix at `~/acwine` (`WINEARCH=win32` —
`acclient.exe` is a 32-bit binary; a win64 prefix cannot run it).

Verified working combination:

| component | version |
|---|---|
| OS | Debian 12 (bookworm) |
| wine | 8.0 (`wine-8.0 (Debian 8.0~repack-4)`) |
| GL | Mesa **llvmpipe** (software) via Xvfb `+extension GLX` |
| client | End-of-Retail `acclient.exe` (4,841,472 bytes, 2016-03-19) over the 2013 base install |

No WineHQ upgrade, no NVIDIA/Xorg, no winetricks, and no DirectX redistributable
were needed. The box has a Tesla T4, but the rig **does not use it** — the
oracle measures movement curves, not pixels, so software GL is fine.

### TRAP — `xvfb-run` silently no-ops without `xauth`

`xvfb-run -a wine ...` prints `xauth command not found` and exits 0 having done
nothing. Install `xauth` (it is not a dependency of `xvfb`).

---

## 2. Installing the client

```sh
./box-rig.sh install-client
```

### TRAP — the End-of-Retail archive is a PATCH OVERLAY, not a client

The EoR archive contains exactly four files:

```
acclient.exe              4,841,472   2016-03-19
client_cell_1.dat       348,127,232   2019-07-17
client_local_English.dat  1,048,576   2019-10-31
client_portal.dat       926,941,184   2019-07-17
```

That looks like a complete client and is not. Running that `acclient.exe` out
of a bare directory does nothing visible — it needs the base install's
`Keystone.dll`, `MSVCP71.dll`, `chatclient.dll`, `corestrings.dll`, `dbghelp.dll`,
`glsclient.dll` and friends (38 files in total). **Install the base first, then
drop these four on top, replacing.**

### TRAP — the installer payload cannot be extracted statically

`ac1install.exe` is an **InstallShield Setup Player 2K2** PE, not an archive:

- `7z x ac1install.exe` → `Cannot open the file as archive`.
- Running it unpacks only a bootstrap (`data1.cab` 307 KB, `data1.hdr`,
  `engine32.cab`, `setup.inx`) into `~/acwine/drive_c/users/$USER/Temp/*/Disk1/`.
- `unshield x data1.cab` extracts **15 of the 231 listed files** — the InstallShield
  engine and support DLLs. Every `DefaultComponent` file (the client itself and
  the dats) lives in cab volumes streamed from inside the exe and is not there.

So the wizard has to actually run. It is driven headlessly by **absolute-coordinate
mouse clicks**, because:

### TRAP — no window manager means no keyboard focus

With a bare Xvfb there is no WM, so `xdotool windowactivate` / `key --window`
do nothing (`XGetInputFocus returned the focused window of 1`). Mouse clicks at
root coordinates **do** land. The wizard's geometry at 1024x768 is fixed:

| control | coords |
|---|---|
| `Next >` / `Finish` | 580, 602 |
| confirmation `OK` | 515, 413 |

Wizard flow: Welcome → Next; Destination (`c:\Turbine\Asheron's Call`) → Next;
"Successful. The Target directory is…" → OK; → Next; ~1.4 GB copy (2-4 min);
Finish.

The same PointerRoot behaviour is what makes **in-game input** work: park the
pointer over the client viewport and the window under it receives key events.

---

## 3. `UserPreferences.ini` — the single most important file

```ini
[Display]
FullScreen=False
```

written (CRLF) to the **client directory**:

```
~/acwine/drive_c/Turbine/Asheron's Call/UserPreferences.ini
```

`./box-rig.sh prefs` writes it; `./box-rig.sh client` asserts it exists.

### Why

AC defaults to fullscreen. The fullscreen path calls
`RenderDeviceD3D::CheckDisplayModes`, which walks the adapter's mode list for a
resolution + refresh-rate match. **Xvfb exposes exactly one mode**, the match
fails, and `SelectBufferFormats` bails to
`PlatformString::DisplayString(0x80u, …)` — `acclient.c:459429` / `:459445` —
which is this modal:

> The game encountered a fatal DirectX issue while attempting to start. Try a
> different screen resolution or bit depth. If that doesn't work, try new video
> drivers.

The client stays alive showing that dialog and transmits **nothing**. The
windowed branch explicitly skips `CheckDisplayModes` and reuses the desktop
format, so it proceeds.

Measured A/B with the ini as the only variable:

| | packets to :9000 |
|---|---|
| with ini | **20** (retrying every 2s) |
| without | **0** |

Diagnostic detail: the client is **d3d9**, not d3d8 — `WINEDEBUG=+d3d8` traces
are empty, which is why early debugging found nothing. Under
`WINEDEBUG=+d3d9`, the failing run emits 15 d3d9 lines and never reaches
`CreateDevice`; the working run emits ~159,000 and `d3d9_CheckDeviceType` flips
from `windowed 0` to `windowed 0x1`.

### Path precedence

`acclient.c:62177` checks `<cwd>\UserPreferences.ini` **first**
(`PSUtils::get_cwd` + `check_access`), falling back to
`SHGetSpecialFolderPathA(CSIDL_PERSONAL)\Asheron's Call\`. The rig launches
with `cwd` = the client dir, so the client-dir copy is authoritative. (The
widely-circulated Windows-10 workaround names the `Documents` copy; both work,
but only if you write the one the client actually reads.)

---

## 4. Wine media stack

```sh
wine reg add "HKCU\Software\Wine\Drivers"      /v Audio          /t REG_SZ /d "" /f
wine reg add "HKCU\Software\Wine\DllOverrides" /v winegstreamer  /t REG_SZ /d "" /f
# and at launch:
export WINEDLLOVERRIDES="winegstreamer=d;quartz=d"
```

### TRAP — the client authenticates, then dies in gstreamer

The VM has no sound card. The client authenticated successfully against ACE and
then died with:

```
Assertion failed: ret, file dlls/winegstreamer/quartz_parser.c, line 1152
```

preceded by a wall of `ALSA lib … cannot find card '0'`. This crash happens
**after** a successful login, so ACE's log shows a healthy session and the
client is simply gone — an easy failure to misdiagnose as a network problem.

---

## 5. Networking: the UDP-over-TCP relay

ACE runs on the laptop; the client runs on the box; `ssh` forwards only TCP.

```
[box] acclient --UDP:9000/9001--> relay(box) --TCP:19000/19001--> ssh -R
                                                                    |
[laptop] ACE :9000/:9001 <--UDP-- relay(host) <--TCP:19000/19001----+
```

```sh
# laptop
./tunnel-up.sh up
# box
./relay-box.sh up
```

`ssh -R` is opened **from the laptop to the box**, so the listener lives on the
box and forwards inbound connections down to the laptop.

### TRAP — a bare socat pipe corrupts this traffic

The obvious `socat UDP4-LISTEN:9000,fork TCP4:127.0.0.1:19000` pair is **wrong**.
TCP is a byte stream with no message boundaries: two AC packets written
back-to-back coalesce into one segment and the far socat re-emits them as a
**single** UDP datagram, silently swallowing the second. Measured on this box —
a 200-datagram burst through a socat UDP→TCP→UDP pair:

```
sent=200 datagrams, echo server received=46 datagrams
```

`udp_tcp_relay.py` length-prefixes each datagram (4-byte big-endian) so
boundaries survive exactly. Its self-test fires the same burst and asserts all
200 arrive intact both ways:

```sh
python3 scripts/oracle/test_udp_tcp_relay.py
# PASS: all datagram boundaries preserved in both directions
```

### TRAP — both ports, or a mystery timeout

ACE uses **9000 for login and 9001 for the world**, and the client is told to
switch mid-session. Relaying only 9000 gives a clean login followed by an
inexplicable timeout. Both scripts always bring up both.

### TRAP — backgrounded processes die with the ssh session

A backgrounded pipeline started inside a non-interactive `ssh host '...'` is
killed when the session tears down, even with `nohup`. Wrap each long-lived
process in its own script and `setsid` **that**. Both relay scripts do this;
it is why they exist as scripts rather than inline commands.

---

## 6. Launching and playing

```sh
./box-rig.sh client agentp08 agentp08
```

Launch arguments (retail's own, confirmed three ways — the decomp's
`gmClient::BuildCommandLineArgs` / `Client::BuildCommandLineArgs` arg table,
ACE's changelog, and Chorizite's `LaunchManager.cs`):

```
acclient.exe -h 127.0.0.1 -p 9000 -a <account> -v <password> -rodat off
```

| switch | meaning |
|---|---|
| `-h` | host |
| `-p` | server port |
| `-a` | account |
| `-v` | password (`vgpassword`) |
| `-q` | fixed local UDP port (multiboxing) |
| `-rodat off` | open the dats writable — **the client writes to its dats** |

`-rodat off` is why the rig always uses its **own copy** of the dats and never
points at `~/ac_base_dats`.

Character select needs one click (`ENTER` at ~455, 487 at 1024x768). In-game
input goes through the pointer-focus trick from §2.

### Retail's key map differs from holtburger's

Retail AC default: `W`/`S` forward/back, `A`/`D` **turn**, `Q`/`E` **strafe**.
holtburger: `w`/`s` forward, `a`/`d` **strafe**, `q`/`e` **turn**, `shift` =
walk modifier. A driver that assumes one layout for both will produce a
clean-looking report full of axis-swapped garbage. `scenarios.json` records the
mapping per side; only `W` and `space` are common to both.

---

## 6a. Playing a scenario (session 2)

Do not type the scenario by hand. The plan is generated on the laptop and
replayed on the box:

```sh
# laptop
node harness/oracle-run.mjs --emit-retail-plan --out-dir /tmp/plans
scp /tmp/plans/*.plan box:~/oracle-plans/

# box
ORACLE_DISPLAY=95 ./box-rig.sh scenario ~/oracle-plans/run-hold.plan out.pcap
```

`scenario` teleports to the shared capture site, waits for the destination to
load, starts `tcpdump`, replays the plan's `down`/`up` directives on a
millisecond clock, releases every key, and prints the pcap path.

Two things live in the generated plan rather than in this script, deliberately:

* **The key remap.** Retail `A`/`D` turn and `Q`/`E` strafe; holtburger is the
  reverse. Scenario keys are written in holtburger's layout and mean an AXIS,
  so the emitter swaps `a<->q` and `d<->e` (`oracle-run.mjs::retailKey`, unit
  tested). A hand-typed retail script gets this wrong and produces a
  clean-looking report full of axis-swapped garbage — MOVE-F6 in particular
  would strafe with a key that turns.
* **The capture site.** `scenarios.json.capture_site` becomes the `@teleloc`
  line of every plan, so both sides measure the same ground facing the same
  way. See that file's `$comment` for why Samsur and how it was chosen.

### TRAP — the client starts wherever the character logged out

The very first `agentp08` login of session 2 put the avatar in a corner facing
a wall. A capture taken there measures the wall, not the movement code: the
client keeps reporting a full-speed intent while the position barely changes.
Always teleport first, and check the differ's `intent_speed` row against
`steady_speed` afterwards — they should agree.

---

## 7. Capturing

```sh
./box-rig.sh capture ~/oracle-caps/run.pcap 120
```

`tcpdump -i lo -n -s 0 -w <out> 'udp port 9000 or udp port 9001'`.
`-s 0` matters: a snaplen-truncated capture loses the tail of fragmented
messages. Classic pcap (`-w`) is what `pcap2jsonl` reads — pcapng is rejected
with a pointed error.

Decode:

```sh
cargo build -p holtburger-tools --bin pcap2jsonl --release
./target/release/pcap2jsonl --input run.pcap --output retail.jsonl --summary
```

### What a capture can and cannot measure

The player's own curve comes from the **c2s** stream (`MoveToState` /
`AutonomousPosition`) — the client's own physics output, which is the right
thing to compare against holtburger's local integrator. But that stream is a
heartbeat, not a tick:

```
sample interval: min 145 ms, median 1058 ms, max 1874 ms
```

At ~1 Hz, **steady-state speed is measurable** (retail run measured at
7.40 m/s) but **accel ramps and jump arcs are not** — a ~1 s jump falls
entirely between two samples, and `jump_apex` comes back 0.00 because every
reported `z` is ground level. This is the concrete argument for the D2
Chorizite `MoveOracle` plugin: per-frame sampling inside the client process is
the only way to resolve those.

Two normalization traps the first real capture exposed, both now guarded in
`oracle-diff.mjs`:

1. The server **echoes** the player's position back (s2c `UpdatePosition`) with
   the same coordinates tens of ms later. Differentiating across the
   interleaved stream yields real speed, 0.000, real speed, 0.000… whose median
   is ~0. Build the player curve from **one** source.
2. **Every** entity in view emits `UpdatePosition`. Unfiltered, an NPC across
   the square joins the player's curve — the first capture produced a
   185 m/s "sample" exactly this way. s2c positions are admitted only with an
   explicit player guid.

---

## 8. Preemption recovery

The buildbox is a GCE **spot** VM and can be preempted at any time.

```sh
gcloud compute instances describe buildbox --zone us-central1-a \
  --format='value(status,networkInterfaces[0].accessConfigs[0].natIP)'
# TERMINATED ->
gcloud compute instances start buildbox --zone us-central1-a
# then re-derive the IP: it is EPHEMERAL and changes on every start.
```

The wine prefix and installed client live on the boot disk and survive a
preemption. After a restart you need only:

```sh
touch ~/.keep-awake
./box-rig.sh xvfb && ./box-rig.sh status     # box
./tunnel-up.sh up                            # laptop
./relay-box.sh up                            # box
./box-rig.sh client agentp08 agentp08        # box
```

`tunnel-up.sh` resolves the box IP through `gcloud` on every run rather than
caching it, precisely because it changes.

---

## 9. Verified end state

- `ACE_Log.txt`: `client agentp08 connected with verified password`, followed
  by a DDD interrogation response, through the relay.
- Client renders the character-select screen against world
  **`ACEmulator-local`**, then the live world (avatar, chat channels joined,
  coordinates on the radar).
- A 40 s scripted `run-hold` + `jump-running` capture decodes to 110 messages:
  39 `UpdatePosition`, 33 `UpdateMotion`, 17 `GameAction` (including a `Jump`),
  1 `VectorUpdate`. Committed as
  `harness/fixtures/oracle/retail-run-jump.pcap`.

## Account hygiene

`agentp08` is the retail-side account, `agentp09` the holtburger driver's.
One login per account, and leave ~25 s between session teardowns — ACE holds
a dropped session for a while and a fast relogin races it.

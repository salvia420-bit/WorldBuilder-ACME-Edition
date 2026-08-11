#!/usr/bin/env bash
# box-rig.sh — the retail-client side of the movement parity oracle.
#
# Runs ON THE BUILDBOX (Debian 12 + wine).  Every subcommand is idempotent and
# re-runnable, because the box is a GCE *spot* VM that can be preempted at any
# moment: after a preemption you re-run `setup` and `install-client` and you
# are back where you were.  Nothing here depends on shell state surviving.
#
# Subcommands:
#   setup            install packages + create the 32-bit wine prefix
#   install-client   drive the InstallShield base install, then overlay EoR
#   prefs            write UserPreferences.ini (FullScreen=False) — REQUIRED
#   xvfb             (re)start the headless X server the client renders into
#   client           launch acclient.exe against the relay
#   capture          tcpdump the relay's UDP leg to a pcap
#   status           what is up right now
#   stop             tear down client + Xvfb (leaves the prefix alone)
#
# The client sources (installer + End-of-Retail archive) are owner-supplied
# and deliberately NOT referenced by URL here — see ~/oracle-notes.md on the
# box.  Put the two files in $DL_DIR before running `install-client`.

set -uo pipefail

DISPLAY_NUM="${ORACLE_DISPLAY:-96}"
export DISPLAY=":${DISPLAY_NUM}"
export WINEPREFIX="${WINEPREFIX:-$HOME/acwine}"
export WINEARCH=win32
export WINEDEBUG="${WINEDEBUG:--all}"

DL_DIR="$HOME/acdl"
EOR_DIR="$HOME/ac_client"
AC_DIR="$WINEPREFIX/drive_c/Turbine/Asheron's Call"
LOG_DIR="$HOME/oracle-logs"
CAP_DIR="$HOME/oracle-caps"
SCREEN_GEOM="${ORACLE_SCREEN:-1024x768x24}"

mkdir -p "$LOG_DIR" "$CAP_DIR"

log() { printf '[box-rig] %s\n' "$*" >&2; }
die() { printf '[box-rig] ERROR: %s\n' "$*" >&2; exit 1; }

# --------------------------------------------------------------------------
cmd_setup() {
  log "enabling i386 + installing packages"
  sudo dpkg --add-architecture i386
  sudo apt-get update -qq
  # xauth is required by xvfb-run; without it you get the misleading
  # "xauth command not found" and a silent no-op launch.
  # mesa is required because wine's d3d9 needs a working GLX on the virtual
  # display — a bare Xvfb yields acclient's "fatal DirectX issue" dialog.
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    wine wine32:i386 wine64 winbind \
    xvfb xauth xdotool imagemagick x11-apps \
    libgl1-mesa-dri libglx-mesa0 mesa-utils \
    socat tcpdump megatools cabextract unshield p7zip-full unzip \
    || die "apt install failed"
  log "creating 32-bit wine prefix at $WINEPREFIX"
  WINEARCH=win32 wineboot -u >"$LOG_DIR/wineboot.log" 2>&1
  log "setup complete; wine $(wine --version 2>/dev/null)"
}

# --------------------------------------------------------------------------
# The InstallShield 2K2 wizard cannot be silently driven without a recorded
# setup.iss, and there is no window manager on the virtual display, so
# xdotool's windowactivate/key path does not work (no focus). Clicking at
# absolute root coordinates does work, and the wizard's button geometry is
# fixed at 1024x768. Hence the coordinate clicks below.
INSTALLER_NEXT_X=580
INSTALLER_NEXT_Y=602
INSTALLER_OK_X=515
INSTALLER_OK_Y=413

cmd_install_client() {
  local installer="$DL_DIR/ac1install.exe"
  [ -f "$installer" ] || die "missing $installer (owner-supplied; see ~/oracle-notes.md)"
  if [ -d "$AC_DIR" ] && [ -f "$AC_DIR/Keystone.dll" ]; then
    log "base client already installed at $AC_DIR — skipping wizard"
  else
    cmd_xvfb
    log "launching InstallShield wizard (headless, coordinate-driven)"
    ( cd "$DL_DIR" && setsid wine ac1install.exe </dev/null \
        >"$LOG_DIR/installer-run.log" 2>&1 & )
    sleep 40
    _shot inst-welcome
    log "step: Welcome -> Next"
    xdotool mousemove $INSTALLER_NEXT_X $INSTALLER_NEXT_Y click 1; sleep 5
    log "step: Destination -> Next"
    xdotool mousemove $INSTALLER_NEXT_X $INSTALLER_NEXT_Y click 1; sleep 5
    log "step: confirm dialog -> OK"
    xdotool mousemove $INSTALLER_OK_X $INSTALLER_OK_Y click 1; sleep 3
    log "step: begin copy -> Next"
    xdotool mousemove $INSTALLER_NEXT_X $INSTALLER_NEXT_Y click 1
    log "copying ~1.4 GB; waiting for the tree to stop growing"
    local last=0 same=0
    for _ in $(seq 1 90); do
      sleep 10
      local now; now=$(du -sm "$AC_DIR" 2>/dev/null | cut -f1 || echo 0)
      [ "$now" = "$last" ] && same=$((same + 1)) || same=0
      last="$now"
      log "  installed ${now}MB"
      [ "$same" -ge 3 ] && [ "$now" -gt 1000 ] && break
    done
    _shot inst-complete
    log "step: Finish"
    xdotool mousemove $INSTALLER_NEXT_X $INSTALLER_NEXT_Y click 1; sleep 5
  fi

  # --- End-of-Retail overlay -------------------------------------------
  # The EoR archive is a PATCH OVERLAY, not a standalone client: it carries
  # only acclient.exe + the three dats. Dropping those four files on a base
  # install (replacing) is what produces a final-patch client. Running the
  # EoR acclient.exe out of a bare directory fails silently — it needs the
  # base install's Keystone.dll / MSVCP71.dll / chatclient.dll / etc.
  [ -d "$EOR_DIR" ] || die "missing $EOR_DIR (unzip the EoR archive there first)"
  local n=0
  for f in acclient.exe client_cell_1.dat client_local_English.dat client_portal.dat; do
    [ -f "$EOR_DIR/$f" ] || { log "WARN: EoR archive lacks $f"; continue; }
    cp -f "$EOR_DIR/$f" "$AC_DIR/$f" || die "overlay copy failed for $f"
    n=$((n + 1))
  done
  # The client WRITES to its dats unless -rodat on; make sure they are writable
  # (the installer marks some files read-only).
  chmod u+w "$AC_DIR"/*.dat 2>/dev/null
  cmd_prefs
  log "EoR overlay applied ($n files); client ready at $AC_DIR"
}

# --------------------------------------------------------------------------
# THE SINGLE MOST IMPORTANT LINE IN THIS FILE.
#
# AC defaults to FULLSCREEN. Its fullscreen path calls
# RenderDeviceD3D::CheckDisplayModes, which walks the adapter's mode list for
# a resolution+refresh-rate match. Xvfb exposes exactly ONE mode, so the match
# fails, SelectBufferFormats bails to PlatformString::DisplayString(0x80,...)
# (acclient.c:459429/459445), and you get the modal
#   "The game encountered a fatal DirectX issue while attempting to start."
# with the client alive but transmitting NOTHING. The windowed branch skips
# CheckDisplayModes entirely and reuses the desktop format, so it proceeds.
#
# Measured A/B on this box with the ini as the only variable:
#   with ini: 20 UDP packets to :9000 (retry every 2s)
#   without : 0 packets
#
# Path: the client checks <cwd>\UserPreferences.ini FIRST (acclient.c:62177,
# PSUtils::get_cwd + check_access) and only falls back to
# SHGetSpecialFolderPathA(CSIDL_PERSONAL)\Asheron's Call\. Since we launch
# with cwd = the client dir, the client-dir copy is the authoritative one.
# CRLF because it is a Windows INI written by WritePrivateProfileStringA.
cmd_prefs() {
  [ -d "$AC_DIR" ] || die "no client dir at $AC_DIR"
  printf '[Display]\r\nFullScreen=False\r\n' >"$AC_DIR/UserPreferences.ini"
  log "wrote $AC_DIR/UserPreferences.ini (FullScreen=False)"
}

# --------------------------------------------------------------------------
cmd_xvfb() {
  if xdpyinfo -display ":$DISPLAY_NUM" >/dev/null 2>&1; then
    log "Xvfb :$DISPLAY_NUM already up"
    return 0
  fi
  pkill -f "Xvfb :$DISPLAY_NUM" 2>/dev/null
  sleep 1
  # +extension GLX is load-bearing: wine translates the client's D3D calls to
  # OpenGL, and without GLX acclient dies with "fatal DirectX issue".
  # Rendering lands on Mesa llvmpipe (software) — fine here, because the
  # oracle measures movement curves, not pixels.
  setsid Xvfb ":$DISPLAY_NUM" -screen 0 "$SCREEN_GEOM" \
    +extension GLX +extension RANDR -nolisten tcp \
    </dev/null >"$LOG_DIR/xvfb.log" 2>&1 &
  for _ in $(seq 1 20); do
    sleep 1
    xdpyinfo -display ":$DISPLAY_NUM" >/dev/null 2>&1 && { log "Xvfb :$DISPLAY_NUM up ($SCREEN_GEOM)"; return 0; }
  done
  die "Xvfb :$DISPLAY_NUM failed to start; see $LOG_DIR/xvfb.log"
}

_shot() {
  import -window root "$LOG_DIR/$1.png" 2>/dev/null && log "screenshot $LOG_DIR/$1.png"
}

# --------------------------------------------------------------------------
# Launch args are retail's own, confirmed three ways: the decomp's arg table
# (gmClient::BuildCommandLineArgs / Client::BuildCommandLineArgs in
# acclient.c), ACE's changelog ("acclient.exe -a <acct> -v <pw> -h host:port"),
# and Chorizite's launcher (LaunchManager.cs: "-h {host} -p {port} -a {user}
# -v {password} -rodat off").
cmd_client() {
  local acct="${1:-agentp08}"
  local pw="${2:-$acct}"
  local host="${ORACLE_HOST:-127.0.0.1}"
  local port="${ORACLE_PORT:-9000}"
  [ -f "$AC_DIR/acclient.exe" ] || die "no client at $AC_DIR — run install-client"
  # Absence of this file silently costs the whole run (fullscreen -> DirectX
  # dialog -> zero packets), so assert rather than discover it in a pcap.
  [ -f "$AC_DIR/UserPreferences.ini" ] || cmd_prefs
  cmd_xvfb
  pkill -f 'acclien[t]\.exe' 2>/dev/null
  sleep 2
  log "launching acclient.exe -h $host -p $port -a $acct -rodat off"
  ( cd "$AC_DIR" && setsid wine acclient.exe \
      -h "$host" -p "$port" -a "$acct" -v "$pw" -rodat off \
      </dev/null >"$LOG_DIR/client.log" 2>&1 & )
  sleep 5
  pgrep -f 'acclien[t]\.exe' >/dev/null \
    && log "client running (pid $(pgrep -f 'acclien[t]\.exe' | head -1))" \
    || die "client exited immediately; see $LOG_DIR/client.log"
}

# --------------------------------------------------------------------------
cmd_capture() {
  local out="${1:-$CAP_DIR/oracle-$(date +%Y%m%d-%H%M%S).pcap}"
  local secs="${2:-120}"
  log "capturing UDP 9000/9001 on lo for ${secs}s -> $out"
  # -s 0: full payload (a snaplen-truncated capture silently loses the tail of
  # fragmented messages). Classic pcap (-w) is what pcap2jsonl reads.
  sudo timeout "$secs" tcpdump -i lo -n -s 0 -w "$out" \
    'udp port 9000 or udp port 9001' >/dev/null 2>&1
  sudo chown "$(id -un)" "$out" 2>/dev/null
  local n; n=$(tcpdump -r "$out" 2>/dev/null | wc -l)
  log "captured $n packets -> $out"
  [ "$n" -gt 0 ] || log "WARN: empty capture — is the relay up and the client connected?"
  echo "$out"
}

# --------------------------------------------------------------------------
cmd_status() {
  echo "wine:      $(wine --version 2>/dev/null || echo MISSING)"
  echo "prefix:    $WINEPREFIX $([ -d "$WINEPREFIX" ] && echo OK || echo MISSING)"
  echo "client:    $AC_DIR $([ -f "$AC_DIR/acclient.exe" ] && echo OK || echo MISSING)"
  echo "Xvfb :$DISPLAY_NUM:  $(xdpyinfo -display ":$DISPLAY_NUM" >/dev/null 2>&1 && echo UP || echo DOWN)"
  echo "GL:        $(DISPLAY=":$DISPLAY_NUM" glxinfo 2>/dev/null | grep -m1 'OpenGL renderer' || echo 'n/a')"
  echo "client pid: $(pgrep -f 'acclien[t]\.exe' | head -1 || echo none)"
  echo "relay pid:  $(pgrep -f 'udp_tcp_relay.py --mode bo[x]' | head -1 || echo none)"
}

cmd_stop() {
  pkill -f 'acclien[t]\.exe' 2>/dev/null && log "client stopped"
  pkill -f "Xvfb :$DISPLAY_NUM" 2>/dev/null && log "Xvfb stopped"
  true
}

case "${1:-status}" in
  setup)          shift; cmd_setup "$@" ;;
  install-client) shift; cmd_install_client "$@" ;;
  prefs)          shift; cmd_prefs "$@" ;;
  xvfb)           shift; cmd_xvfb "$@" ;;
  client)         shift; cmd_client "$@" ;;
  capture)        shift; cmd_capture "$@" ;;
  status)         shift; cmd_status "$@" ;;
  stop)           shift; cmd_stop "$@" ;;
  *) die "unknown subcommand '$1' (setup|install-client|prefs|xvfb|client|capture|status|stop)" ;;
esac

#!/usr/bin/env bash
# scripts/vast/ace-up.sh — bring up a LOCAL ACE (holtburger vehicles fork, Dericost branch) + wsbridge on a
# Vast.ai box, idempotently. A fresh Vast box only has the ACE *source*; this installs everything else.
#
#   bash scripts/vast/ace-up.sh            # install what's missing, build, start ACE + wsbridge
#   bash scripts/vast/ace-up.sh stop       # stop ACE (graceful) + wsbridge
#   bash scripts/vast/ace-up.sh status
#
# Result: ACE on udp 127.0.0.1:9000/9001, wsbridge on ws://127.0.0.1:8080/, accounts auto-created at
# access level 5 (admin) — log in with ?autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first.
# ACE console: echo "<command>" > /workspace/wb/ace_stdin.fifo ; log: /workspace/wb/ace_console.log
# The DB lives on the ephemeral NVMe (characters do not survive the instance; the code does — it is on GitHub).
set -euo pipefail

WB=/workspace/wb
ACE_DIR=$WB/home/ace-server
ACE_FORK=https://github.com/salvia420-bit/ace-server-holtburger.git
ACE_BRANCH=Dericost
DOTNET_DIR=$WB/dotnet
DATS_SRC=$WB/home/ace-dats-ssd/ace-r10-dats
DATS=$WB/ace-dats-local
FIFO=$WB/ace_stdin.fifo
LOG=$WB/ace_console.log
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HB=$REPO/external/holtburger
export DOTNET_ROOT=$DOTNET_DIR PATH=$DOTNET_DIR:$PATH DOTNET_CLI_TELEMETRY_OPTOUT=1 DEBIAN_FRONTEND=noninteractive
BIN=$ACE_DIR/Source/ACE.Server/bin/Release/net10.0

ace_pid() { pgrep -f "dotnet ACE.Server.dl[l]" || true; }
bridge_pid() { pgrep -f "holtburger-wsbridg[e]" || true; }

case "${1:-up}" in
  status) echo "ACE pid: $(ace_pid)  wsbridge pid: $(bridge_pid)"; ss -lunp 2>/dev/null | grep -E ':900[01]' || true; exit 0 ;;
  stop)
    [ -n "$(ace_pid)" ] && { echo "stop-now" > "$FIFO" || true; sleep 5; [ -n "$(ace_pid)" ] && kill "$(ace_pid)"; }
    [ -n "$(bridge_pid)" ] && kill "$(bridge_pid)"; echo stopped; exit 0 ;;
esac

echo "[ace-up] 1/8 packages (mariadb, unzip)"
command -v mariadbd >/dev/null || { apt-get update -qq && apt-get install -y -qq mariadb-server unzip >/dev/null; }

echo "[ace-up] 2/8 .NET 10 SDK -> $DOTNET_DIR"
[ -x $DOTNET_DIR/dotnet ] || { curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh; bash /tmp/dotnet-install.sh --channel 10.0 --install-dir $DOTNET_DIR >/dev/null; }

echo "[ace-up] 3/8 ACE source (fork $ACE_BRANCH)"
if [ ! -d $ACE_DIR/.git ]; then
  git clone -b $ACE_BRANCH $ACE_FORK $ACE_DIR
else
  git config --global --add safe.directory $ACE_DIR
  git -C $ACE_DIR remote get-url fork >/dev/null 2>&1 || git -C $ACE_DIR remote add fork $ACE_FORK
  git -C $ACE_DIR fetch -q fork $ACE_BRANCH && git -C $ACE_DIR merge -q --ff-only fork/$ACE_BRANCH 2>/dev/null \
    || echo "[ace-up]   (local ACE branch diverged from fork/$ACE_BRANCH — left as is; push or reconcile it)"
fi
ln -sfn $ACE_DIR /home/wbterminal/ace-server

echo "[ace-up] 4/8 MariaDB + ACE databases"
if ! mysqladmin ping >/dev/null 2>&1; then
  mkdir -p /run/mysqld && chown mysql:mysql /run/mysqld
  (setsid nohup mysqld_safe >$WB/mysqld.log 2>&1 &); for _ in $(seq 30); do mysqladmin ping >/dev/null 2>&1 && break; sleep 1; done
fi
mysql -uroot -e "CREATE USER IF NOT EXISTS 'ace'@'127.0.0.1' IDENTIFIED BY 'ace'; CREATE USER IF NOT EXISTS 'ace'@'localhost' IDENTIFIED BY 'ace';
  GRANT ALL ON *.* TO 'ace'@'127.0.0.1'; GRANT ALL ON *.* TO 'ace'@'localhost'; FLUSH PRIVILEGES;"
if [ "$(mysql -uroot -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='ace_world'")" -lt 5 ]; then
  for b in Authentication:ace_auth Shard:ace_shard World:ace_world; do
    mysql -uroot -e "CREATE DATABASE IF NOT EXISTS ${b##*:}"; mysql -uroot ${b##*:} < $ACE_DIR/Database/Base/${b%%:*}Base.sql
  done
  U=$(curl -fsSL https://api.github.com/repos/ACEmulator/ACE-World-16PY-Patches/releases/latest \
      | python3 -c 'import sys,json;print([a["browser_download_url"] for a in json.load(sys.stdin)["assets"] if a["name"].endswith(".sql.zip")][0])')
  echo "[ace-up]   world DB: $U"; curl -fsSL -o $WB/aceworld.sql.zip "$U"; rm -rf $WB/aceworld; unzip -q -o $WB/aceworld.sql.zip -d $WB/aceworld
  mysql -uroot ace_world < "$(ls $WB/aceworld/*.sql | head -1)"
  for b in Authentication:ace_auth Shard:ace_shard World:ace_world; do
    for f in $(ls $ACE_DIR/Database/Updates/${b%%:*}/*.sql 2>/dev/null | sort); do mysql -uroot ${b##*:} < "$f" 2>/dev/null || true; done
  done
fi

echo "[ace-up] 5/8 DAT dir (no dangling symlinks: ACE crashes on a dangling client_highres.dat)"
mkdir -p $DATS
for f in client_cell_1.dat client_portal.dat client_local_English.dat client_highres.dat; do
  if [ -e "$DATS_SRC/$f" ]; then ln -sfn "$DATS_SRC/$f" "$DATS/$f"; else rm -f "$DATS/$f"; fi
done

echo "[ace-up] 6/8 build ACE (Release) + Config.js"
if [ ! -f $BIN/ACE.Server.dll ] || [ "$(stat -c %Y $BIN/ACE.Server.dll)" -lt "$(git -C $ACE_DIR log -1 --format=%ct)" ]; then
  dotnet build $ACE_DIR/Source/ACE.Server/ACE.Server.csproj -c Release -v q -nologo | tail -2
fi
if [ ! -f $BIN/Config.js ]; then
  cp $ACE_DIR/Source/ACE.Server/Config.js.example $BIN/Config.js
  sed -i "s#\"DatFilesDirectory\": \"[^\"]*\"#\"DatFilesDirectory\": \"$DATS/\"#; s#\"ModsDirectory\": \"[^\"]*\"#\"ModsDirectory\": \"$WB/ace-mods/\"#;
          s#\"Username\": \"root\"#\"Username\": \"ace\"#; s#\"Password\": \"\"#\"Password\": \"ace\"#; s#\"DefaultAccessLevel\": 0#\"DefaultAccessLevel\": 5#" $BIN/Config.js
  mkdir -p $WB/ace-mods
fi

echo "[ace-up] 7/8 start ACE"
[ -p $FIFO ] || { rm -f $FIFO; mkfifo $FIFO; }
pgrep -f "sleep infinity" >/dev/null || (setsid nohup sleep infinity > $FIFO &)
if [ -z "$(ace_pid)" ]; then
  : > $LOG; (cd $BIN && setsid nohup $DOTNET_DIR/dotnet ACE.Server.dll < $FIFO >> $LOG 2>&1 &)
  for _ in $(seq 90); do grep -q "World is now open" $LOG && break; grep -q "Unhandled exception" $LOG && { tail -20 $LOG; exit 1; }; sleep 1; done
  for p in vehicles_enabled landblock_wake_on_entry vehicle_preload vehicle_shared_cellstructs; do echo "modifybool $p true" > $FIFO; sleep 1; done
fi

echo "[ace-up] 8/8 wsbridge"
WSB=${CARGO_TARGET_DIR:-$WB/cargo-target}/release/holtburger-wsbridge
[ -x $WSB ] || (cd $HB && cargo build --release -p holtburger-wsbridge -j"$(nproc)" -q)
[ -n "$(bridge_pid)" ] || (setsid nohup $WSB --listen 127.0.0.1:8080 > $WB/wsbridge.log 2>&1 &)
sleep 1
echo "[ace-up] ready: ACE pid $(ace_pid), wsbridge pid $(bridge_pid)"
echo "[ace-up] serve: HOLTBURGER_DIST=$WB/hb-serve/dist/current python3 $HB/scripts/serve.py --bind 127.0.0.1 --port 8765"
echo "[ace-up] login: http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&bridge_url=ws://127.0.0.1:8080/&server_host=127.0.0.1&server_port=9000"

# ACE local setup — bringing the ACEmulator backend up to unblock live-ACE round-trip

> **Audience:** anyone who needs to run a live ACEmulator (`external/ACE/`)
> instance locally so the Phase 1 follow-on (`holtburger-cli ↔
> holtburger-wsshim ↔ holtburger-wsbridge ↔ ACE`) can be exercised end-to-end.
>
> **Status when this doc was written (2026-05-04):** all assets needed are
> already present in this tree or local environment. The blocker isn't
> "find the data" — it's "do the install + config dance correctly". This
> doc is a step-by-step that walks through it.

---

## TL;DR

1. Provision MariaDB locally (the daemon is already installed; `scripts/spin-up-mariadb.sh` already handles the boot path).
2. Create three databases: `ace_auth`, `ace_shard`, `ace_world`. Load the world dump from `ace_world_release/ACE-World-Database-v0.9.292.sql`.
3. Install .NET 10 SDK (the only missing dependency in the current env).
4. Build ACE with `dotnet build -c Release` from `external/ACE/Source/`.
5. Drop a `Config.js` next to the built `ACE.Server.dll` pointing at `/home/wbterminal/ac_base_dats/` for DATs and `127.0.0.1` for SQL.
6. Run ACE — it auto-creates `ace_auth` + `ace_shard` schemas via EF Core migrations on first start.
7. Wire `holtburger-wsbridge` in front (UDP `:9000`/`:9001` → WS `:8080`), point `holtburger-wsshim` at it, run an unmodified `holtburger-cli` against the shim. If `holtburger-cli` reaches handshake + walks around, **Phase 1 closes**.

---

## Status — what's verified locally

| Asset | Status | Path |
|---|---|---|
| AC client `client_portal.dat` | ✅ present (884 MB) | `/home/wbterminal/ac_base_dats/client_portal.dat` |
| AC client `client_cell_1.dat` | ✅ present (332 MB) | `/home/wbterminal/ac_base_dats/client_cell_1.dat` |
| AC client `client_local_English.dat` | ✅ present (1.0 MB) | `/home/wbterminal/ac_base_dats/client_local_English.dat` |
| AC client `client_highres.dat` | ⚠️ NOT present in `~/ac_base_dats/` | Other copies under `/home/wbterminal/projects/*/dats/base/` exist but **must not be reused** — those project DATs are world-specific WorldBuilder outputs and may have diverged from ACE-master compatibility. If ACE rejects startup without highres, source a clean retail-build copy and drop it in `~/ac_base_dats/`. |
| `acclient.exe` (reference build) | ✅ present (4.7 MB) | `/home/wbterminal/ac_base_dats/acclient.exe` |
| World DB seed (decompressed) | ✅ present (149 MB) | `ace_world_release/ACE-World-Database-v0.9.292.sql` |
| World DB seed (zip) | ✅ present (19 MB) | `ACE-World-Database-v0.9.292.sql.zip` |
| MariaDB daemon | ✅ installed (binaries) | `/usr/bin/mysql`, `/sbin/mariadbd`. **Note: this host is non-systemd**; `scripts/spin-up-mariadb.sh` falls back to `service`. |
| MariaDB running | ❓ check before proceeding | `mysqladmin --silent ping` |
| .NET 10 SDK | ❌ NOT installed | `dotnet --version` returns "command not found" |
| Docker / docker-compose | ❌ NOT installed | irrelevant if going the native path |
| ACE source tree | ✅ vendored | `external/ACE/Source/ACE.sln` |
| `Config.js.example` template | ✅ vendored | `external/ACE/Source/ACE.Server/Config.js.example` |
| `docker-compose.yml` + `docker.env` | ✅ vendored | `external/ACE/{docker-compose.yml,docker.env}` (env vars include `ACE_NONINTERACTIVE_SETUP=true`) |
| Existing fixture script | ✅ available | `scripts/spin-up-mariadb.sh` (creates a single `baltic` DB; needs adapting for the three ACE DBs) |

**Bottom line:** the only missing piece is the .NET 10 SDK. Everything else
is one command away.

---

## Pick a path

**Path A — native bare-metal (recommended for the current env).** No
container daemon, full visibility, uses the MariaDB already installed.
Only adds the .NET SDK. Best for first-time setup where you might need
to debug.

**Path B — Docker compose.** ACE upstream ships a `docker-compose.yml`
+ `docker.env` with non-interactive setup and an automatic latest-world-DB
download. Cleaner if you don't want a local MariaDB or .NET install. But
Docker isn't installed in the current env either, so this path needs
two installs (Docker + nothing else) instead of one (.NET SDK).

Both end with the same artifact: ACE listening on UDP `:9000`/`:9001`
with all three DBs connected.

---

## Path A — native bare-metal

### A.1 Install .NET 10 SDK

The `Dockerfile` confirms the target framework — `mcr.microsoft.com/dotnet/sdk:10.0-noble`.
Install via Microsoft's package feed:

```bash
# Ubuntu/Debian — adjust for your distro
wget https://packages.microsoft.com/config/ubuntu/24.04/packages-microsoft-prod.deb -O /tmp/ms.deb
sudo dpkg -i /tmp/ms.deb
sudo apt-get update
sudo apt-get install -y dotnet-sdk-10.0
dotnet --version  # should print 10.0.x
```

If 10.0 isn't yet in the Microsoft feed for your distro, the official
`dotnet-install.sh` script handles channel-specific builds:

```bash
curl -sSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
bash /tmp/dotnet-install.sh --channel 10.0 --install-dir $HOME/.dotnet
export PATH="$HOME/.dotnet:$PATH"
```

### A.2 Bring up MariaDB

```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition
./scripts/spin-up-mariadb.sh
```

That existing script handles install (if needed), daemon start (with
non-systemd fallback), and provisions a `baltic` database for
WorldBuilder testing. **It does not create the three ACE databases —
those come next.** Re-running it is idempotent; it drops and reloads
`baltic` only.

If MariaDB is already running and you just want to confirm:

```bash
sudo mysqladmin --silent ping && echo "mariadb up"
```

### A.3 Create the three ACE databases + load the world dump

ACE auto-creates `ace_auth` and `ace_shard` via EF Core on first run —
so we only need to *create the empty databases* plus *load the world
dump* into `ace_world`. The auth/shard tables populate themselves.

```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition
sudo mariadb <<'SQL'
CREATE DATABASE IF NOT EXISTS ace_auth  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS ace_shard CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS ace_world CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'ace'@'localhost' IDENTIFIED BY 'ace';
GRANT ALL PRIVILEGES ON ace_auth.*  TO 'ace'@'localhost';
GRANT ALL PRIVILEGES ON ace_shard.* TO 'ace'@'localhost';
GRANT ALL PRIVILEGES ON ace_world.* TO 'ace'@'localhost';
FLUSH PRIVILEGES;
SQL

# Load the 149 MB world dump (1-3 minutes).
mysql -u ace -pace ace_world < ace_world_release/ACE-World-Database-v0.9.292.sql

# Verify a few representative tables exist + have rows.
mysql -u ace -pace -e "
  USE ace_world;
  SELECT 'weenie'              AS table_name, COUNT(*) AS rows FROM weenie
  UNION SELECT 'landblock_instance',           COUNT(*)        FROM landblock_instance
  UNION SELECT 'spell',                        COUNT(*)        FROM spell;
"
```

The dump's first lines target `ace_world` directly (no rewrite needed —
unlike `spin-up-mariadb.sh`'s `baltic` remap).

### A.4 (Conditional) Source `client_highres.dat` if ACE rejects startup

`~/ac_base_dats/` is the canonical ACE-master-compatible DAT set, but
it is missing `client_highres.dat`. The other `client_highres.dat`
copies under `/home/wbterminal/projects/*/dats/base/` are NOT
appropriate substitutes — those project DATs are WorldBuilder outputs
for custom worlds and may have diverged from retail in
ACE-incompatible ways.

**Try without it first.** ACE may run with three of four DATs (highres
holds high-resolution UI textures; without it, certain UI assets may
fall back or some features may be unavailable, but the network /
session / world layers don't depend on it). If ACE refuses to start
or DatManager throws "missing file", source a clean retail
`client_highres.dat` from a known-good location (the original AC
retail install, the ACEmulator wiki's DAT list, or by extracting from
`acclient.exe` if it bundles the file) and drop it directly in
`~/ac_base_dats/`. Do NOT symlink from the project mirrors.

### A.5 Build ACE

```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/ACE/Source
dotnet restore
dotnet build --configuration Release
# Build output lands at:
#   external/ACE/Source/ACE.Server/bin/x64/Release/net10.0/
```

The first restore pulls a couple hundred MB of NuGet packages — no
internet means no build.

### A.6 Configure ACE

ACE looks for a `Config.js` (NOT `.json`) next to its DLL on first run.
If absent, it auto-clones from `Config.js.example` and runs the
interactive setup wizard (`Program_Setup.cs`). Skip the wizard by
dropping a fully-formed `Config.js` in place:

```bash
BUILD_OUT="external/ACE/Source/ACE.Server/bin/x64/Release/net10.0"
cd /home/wbterminal/WorldBuilder-ACME-Edition

# log4net config — purely so the server emits logs.
cp "$BUILD_OUT/log4net.config.example" "$BUILD_OUT/log4net.config"

# Main config. Start from the example, then patch in our paths.
cp "$BUILD_OUT/Config.js.example" "$BUILD_OUT/Config.js"
```

Edit `$BUILD_OUT/Config.js` — three patches needed:

1. **DAT files directory** (line 39): replace
   `"DatFilesDirectory": "c:\\ACE\\Dats\\",`
   with
   `"DatFilesDirectory": "/home/wbterminal/ac_base_dats/",`
   (Linux paths — fully expanded, NOT `~`. Trailing slash matters.)

2. **MySQL credentials** (lines 155-181). All three sections (`Authentication`,
   `Shard`, `World`) need their `Username`/`Password` set. Easiest:
   leave Host = `127.0.0.1`, Port = `3306`, set
   `"Username": "ace", "Password": "ace"` in each.

3. **(Optional) Disable auto-update** (lines 213-219). The default
   `AutoUpdateWorldDatabase: true` will try to download a newer world DB
   on startup. We've already loaded one — set it to `false` to keep
   startup deterministic:
   ```json
   "AutoUpdateWorldDatabase": false,
   "AutoApplyWorldCustomizations": false,
   ```

A working minimal `Config.js` (drop-in replacement) — substitute the
realistic block from the example for the parts not shown:

```json
{
    "Server": {
        "WorldName": "ACEmulator-local",
        "Network": { "Host": "0.0.0.0", "Port": 9000,
                     "MaximumAllowedSessions": 128, "DefaultSessionTimeout": 60,
                     "MaximumAllowedSessionsPerIPAddress": -1,
                     "AllowUnlimitedSessionsFromIPAddresses": [] },
        "Accounts": { "OverrideCharacterPermissions": true, "DefaultAccessLevel": 0,
                      "AllowAutoAccountCreation": true, "PasswordHashWorkFactor": 8,
                      "ForceWorkFactorMigration": true },
        "DatFilesDirectory": "/home/wbterminal/ac_base_dats/",
        "ModsDirectory": "/home/wbterminal/WorldBuilder-ACME-Edition/external/ACE/Source/ACE.Server/bin/x64/Release/net10.0/Mods/",
        "ShutdownInterval": "60",
        "Threading": { "WorldThreadCountMultiplier": 0.34, "DatabaseThreadCountMultiplier": 0.66,
                       "MultiThreadedLandblockGroupPhysicsTicking": true,
                       "MultiThreadedLandblockGroupTicking": true },
        "ShardPlayerBiotaCacheTime": "31", "ShardNonPlayerBiotaCacheTime": "11",
        "WorldDatabasePrecaching": false, "LandblockPreloading": true,
        "PreloadedLandblocks": [
            { "Id": "E74EFFFF", "Description": "Hebian-To",
              "Permaload": true, "IncludeAdjacents": false, "Enabled": true }
        ]
    },
    "MySql": {
        "Authentication": { "Host": "127.0.0.1", "Port": 3306, "Database": "ace_auth",
                            "Username": "ace", "Password": "ace",
                            "EnableDetailedErrors": false, "EnableSensitiveDataLogging": false },
        "Shard":          { "Host": "127.0.0.1", "Port": 3306, "Database": "ace_shard",
                            "Username": "ace", "Password": "ace",
                            "EnableDetailedErrors": false, "EnableSensitiveDataLogging": false },
        "World":          { "Host": "127.0.0.1", "Port": 3306, "Database": "ace_world",
                            "Username": "ace", "Password": "ace",
                            "EnableDetailedErrors": false, "EnableSensitiveDataLogging": false }
    },
    "Offline": {
        "AutoServerUpdateCheck": false,
        "AutoApplyDatabaseUpdates": true,
        "AutoUpdateWorldDatabase": false,
        "AutoApplyWorldCustomizations": false,
        "WorldCustomizationAddedPaths": [], "RecurseWorldCustomizationPaths": true
    },
    "DDD": { "EnableDATPatching": false, "PrecacheCompressedDATFiles": false }
}
```

### A.7 Run ACE

```bash
cd external/ACE/Source/ACE.Server/bin/x64/Release/net10.0
dotnet ACE.Server.dll
```

First-run startup signals (in order, watch the console):

1. `Initializing ConfigManager...`
2. `Performing setup for ACEmulator...` — only if `Config.js` is missing.
3. `Initializing DatManager...` — touches `DatFilesDirectory`. Failure
   here means `client_*.dat` is missing or the path is wrong.
4. EF Core migrations — `Applied migration 'XYZ' to ace_auth/ace_shard`.
5. `Initializing WorldManager...` — loads from `ace_world`.
6. `Initializing SocketManager...` — binds UDP `:9000` and `:9001`.
7. `Server is now running. Type ? for a list of commands.` — final
   ready signal.

Total cold-start time: **30–90 seconds** depending on disk speed
(loading 1.7 GB of DATs + parsing world DB).

---

## Path B — Docker compose

If you have Docker installed (you don't on this host yet — `which docker`
returns "command not found"), upstream ACE ships a fully-wired
`docker-compose.yml` + `docker.env`.

```bash
# Install Docker first if needed (Ubuntu/Debian):
# sudo apt-get install -y docker.io docker-compose-v2

cd /home/wbterminal/WorldBuilder-ACME-Edition/external/ACE

# Drop the DATs into ./Dats/ (the volume mount target).
# Only ~/ac_base_dats/ is ACE-master-compatible — do NOT pull DATs from
# /home/wbterminal/projects/*/dats/base/ (those are world-specific
# WorldBuilder outputs, see §A.4).
mkdir -p Dats Config Content Logs Mods
ln -sf /home/wbterminal/ac_base_dats/client_portal.dat        Dats/
ln -sf /home/wbterminal/ac_base_dats/client_cell_1.dat        Dats/
ln -sf /home/wbterminal/ac_base_dats/client_local_English.dat Dats/
# client_highres.dat: see §A.4 — try without first; source a clean
# retail copy if ACE rejects startup.

# Build + run.
docker compose up --build
```

`docker.env` already sets `ACE_NONINTERACTIVE_SETUP=true` and
`ACE_SQL_DOWNLOAD_LATEST_WORLD_RELEASE=true` — meaning the container
will fetch a current world DB on first start automatically. (If you'd
rather use the local `ace_world_release/ACE-World-Database-v0.9.292.sql`,
load it manually into the `mysql` container after first boot.)

The compose mounts:

- `./Config:/ace/Config` — drop a `Config.js` here to override.
- `./Dats:/ace/Dats` — DAT files (link or copy from `~/ac_base_dats/`).
- `./Content:/ace/Content` — custom `.sql` for world customisations.
- `./Logs:/ace/Logs` — server logs.
- `./Mods:/ace/Mods` — Harmony mods.
- `./db-data:/var/lib/mysql` — persistent DB data (so a `docker compose down`
  doesn't blow away your characters).

UDP ports `9000-9001` map host:container 1:1.

---

## Verification — proving ACE is alive

Once the server prints `Server is now running. Type ? for a list of
commands.`, run these three checks:

### V.1 Sockets are listening

```bash
# UDP listeners
sudo ss -uln | grep -E '9000|9001'
# Expected: two lines, 0.0.0.0:9000 and 0.0.0.0:9001 (or 127.0.0.1: if you
# narrowed Host)
```

### V.2 Schemas auto-created

```bash
mysql -u ace -pace -e "
  SHOW DATABASES LIKE 'ace_%';
  SELECT TABLE_SCHEMA, COUNT(*) AS tables FROM INFORMATION_SCHEMA.TABLES
   WHERE TABLE_SCHEMA IN ('ace_auth','ace_shard','ace_world')
   GROUP BY TABLE_SCHEMA;
"
# Expected: ~10-20 tables in ace_auth, ~30-50 in ace_shard,
# 50+ in ace_world (the loaded dump).
```

### V.3 ACE responds to a UDP probe

ACE's login handshake starts with the client. We don't have a
hand-rolled probe, but `holtburger-cli` is the simplest live tester
(see next section). For raw protocol-agnostic confirmation, send a
single UDP packet and verify the socket accepts it:

```bash
echo -n "probe" | nc -u -w1 127.0.0.1 9000
# No response expected; the test is "the send doesn't fail and ACE doesn't crash".
# Check ACE's console: it'll log a parse error from the malformed packet.
# That parse error means the socket is alive — exactly what we want.
```

---

## Closing the live-ACE loop (the actual goal)

Phase 1's outstanding follow-on (per `docs/emit-dynamic-site.md` §8) is:

> ⏳ Live-ACE round-trip — blocked on standing up ACE locally. Once this
> clears, Phase 1 closes and Phase 2 (WASM port) opens.

With ACE running, the Phase 1 loop becomes runnable:

```text
holtburger-cli ──udp──▶ holtburger-wsshim ──ws──▶ holtburger-wsbridge ──udp──▶ ACE
              ◀──udp──                  ◀──ws──                       ◀──udp──
```

### L.1 Run the bridge

`holtburger-wsbridge` listens on a WS port and forwards each frame to
ACE's UDP login + world ports.

```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger
cargo build --release -p holtburger-wsbridge
./target/release/holtburger-wsbridge \
    --listen-host 127.0.0.1 \
    --listen-port 8080 \
    --ace-host 127.0.0.1 \
    --ace-login-port 9000 \
    --ace-world-port 9001
```

(Exact flag names are at `external/holtburger/apps/holtburger-wsbridge/src/main.rs`;
the `--help` output is authoritative.)

### L.2 Run the shim

`holtburger-wsshim` binds the UDP ports an unmodified `holtburger-cli`
already dials and tunnels them over WS to the bridge.

```bash
./target/release/holtburger-wsshim \
    --bridge-url ws://127.0.0.1:8080 \
    --listen-login-port 9000 \
    --listen-world-port 9001 \
    --ace-login-port 9000 \
    --ace-world-port 9001
```

The `--listen-*-port` and `--ace-*-port` split is documented in the
shim's `--help`: `listen-*` is where the cli dials locally, `ace-*` is
the wire-tag the bridge uses on the ACE side. Equal in the standard-port
case; useful if the cli or ACE runs on non-default ports.

(Note: the shim binds the same UDP ports ACE binds, so for a single-host
test you have to either run them on different ports or run them on
different machines. Easiest: on the same host, use ports `19000`/`19001`
for the shim's listen side and tell the cli to dial those.)

### L.3 Run the cli

```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger
cargo run --release -p holtburger-cli -- \
    --server 127.0.0.1 \
    --login-port 9000 --world-port 9001 \
    --username yourname --password yourpassword
```

(`--username`/`--password` is whatever account ACE auto-creates on
first login — the example `Config.js` enables `AllowAutoAccountCreation`,
so any new credentials become a fresh account.)

### L.4 What success looks like

The cli should:

1. Connect through the shim → WS → bridge → ACE.
2. Complete the AC login handshake (account auto-create or login).
3. Receive a character list (empty on first login).
4. Create a character + enter the world.
5. Receive `ClientViewEvent` deltas — landblock surfaces, NPCs, props.
6. Walk around (cli movement commands), receive position updates.
7. `/say hi` reaches the chat log.

Any of those failing localises the bug:
- step 1 fails → bridge / shim / port wiring
- step 2 fails → ISAAC / packet framing / ACE config
- step 3-4 fails → DB connectivity / world DB integrity
- step 5 fails → DAT file issue / landblock loader

When all 7 succeed, **Phase 1 is officially closed**. Update
`docs/emit-dynamic-site.md` §8 Phase 1 status block (move the ⏳ to
✅) and the auto-memory entry. Phase 2's open follow-on
(`try_ws_handshake_smoke` against a live bridge) becomes runnable
the same way, just with the WASM bundle replacing the cli.

---

## Gotchas

- **Auto-update on startup** can mask configuration errors —
  if `AutoUpdateWorldDatabase: true` and the network is flaky, ACE
  will hang for minutes trying to fetch a release. The example
  `Config.js` above sets it to `false` for deterministic startup.
- **`Config.js`, not `Config.json`.** ACE reads JSON from a `.js`
  file (with comments stripped); using `.json` looks fine but
  silently isn't loaded.
- **Trailing slash on `DatFilesDirectory`** is required on Linux
  per the comment in `Config.js.example` line 37-38. Without it,
  DatManager's path concatenation produces `~/ac_base_datsclient_portal.dat`
  and the load fails with "file not found".
- **Schema migrations need write permissions.** The MySQL user must
  have `CREATE`, `ALTER`, `INDEX`, `REFERENCES` on `ace_auth` and
  `ace_shard`. The recipe above grants `ALL PRIVILEGES`, which
  covers it; using `mysql_secure_installation`'s default
  `app_user`-style restrictions will bite.
- **Non-systemd hosts** (this one) need MariaDB started via `service
  mariadb start` or by running `sudo mariadbd-safe &` directly.
  `scripts/spin-up-mariadb.sh` already handles this — but if you
  bring MariaDB up some other way, double-check the daemon survives
  shell exit.
- **First-start RAM peak** — ACE caches preloaded landblocks. With
  `WorldDatabasePrecaching: false` (default), peak is ~1 GB.
  Set to `true` for production-realistic latency at ~1.7 GB peak.
- **Account auto-creation** — `Config.js` sets
  `AllowAutoAccountCreation: true`. The first login with a new
  username/password creates the account at access level 0 (player).
  For an admin account, log in once, then via `mysql`:
  ```sql
  UPDATE ace_auth.account SET AccessLevel = 5 WHERE AccountName = 'yourname';
  ```
  (5 = Admin; access levels are documented in
  `external/ACE/Source/ACE.Entity/Enum/AccessLevel.cs`.)
- **ACE's `SocketManager` is in `ACE.Adapter`**, a NuGet/DLL dep
  not in the source tree. The bridge approach in `holtburger-wsbridge`
  treats ACE as a black box and proxies UDP — it doesn't call into
  `SocketManager`. If a future need forces ACE-side WS awareness
  (e.g. tick-batched delivery), the patch path requires bringing
  `ACE.Adapter`'s source in-tree — currently unnecessary.

---

## Reference index

### Local assets (verified 2026-05-04)
- `~/ac_base_dats/` — **the canonical ACE-master-compatible DAT set**.
  Currently three of four (`client_portal.dat`, `client_cell_1.dat`,
  `client_local_English.dat`) plus `acclient.exe`. `client_highres.dat`
  is not present; see §A.4 for the conditional sourcing path. The
  `client_highres.dat` copies elsewhere on disk under
  `/home/wbterminal/projects/*/dats/base/` are world-specific
  WorldBuilder outputs and **must not be reused** for ACE.
- `ace_world_release/ACE-World-Database-v0.9.292.sql` — 149 MB world dump
- `ACE-World-Database-v0.9.292.sql.zip` — 19 MB zipped backup

### ACE source tree
- `external/ACE/Source/ACE.sln` — solution file
- `external/ACE/Source/ACE.Server/Config.js.example` — config template (240 lines, walked through above)
- `external/ACE/Source/ACE.Server/Program.cs:312` — `SocketManager.Initialize()` — UDP socket binding
- `external/ACE/Source/ACE.Server/Program_Setup.cs:14-160` — interactive setup flow (skipped by `Config.js` drop-in)
- `external/ACE/Source/ACE.Server/WorldObjects/Player.cs:43, 114-117` — Session injection seam
- `external/ACE/Source/ACE.Entity/Enum/AccessLevel.cs` — admin/player access levels

### Container path
- `external/ACE/Dockerfile` — `mcr.microsoft.com/dotnet/sdk:10.0-noble`
- `external/ACE/docker-compose.yml` — `mysql:8.0` + `acemulator/ace:latest`
- `external/ACE/docker.env` — non-interactive setup env vars

### Existing fixtures
- `scripts/spin-up-mariadb.sh` — bootstraps MariaDB + creates a `baltic` DB (NOT the three ACE DBs; only the daemon-management half is reusable)
- `scripts/spin-down-mariadb.sh` — tear-down

### Bridge + shim (the consumers of a live ACE)
- `external/holtburger/apps/holtburger-wsbridge/src/main.rs` — server-side WS↔UDP bridge entry point
- `external/holtburger/apps/holtburger-wsbridge/src/bin/wsshim.rs` — client-side UDP↔WS shim entry point
- `external/holtburger/apps/holtburger-wsbridge/ARCHITECTURE.md` — frame protocol + topology
- `external/holtburger/apps/holtburger-wsbridge/src/lib.rs` — shared frame codec

### Design context
- `docs/emit-dynamic-site.md` §8 Phase 1 — phased plan; this work closes the ⏳ entry
- `docs/phase-2-wasm-spike.md` — Phase 2 §8 ledger (the cross-compile floor + WsTransport + HttpResourceSource)
- `docs/phase-3-renderer.md` — Phase 3 step 1 + step 2 as-built reference

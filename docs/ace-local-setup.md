# ACE local setup — bringing the ACEmulator backend up to unblock live-ACE round-trip

> **Audience:** anyone who needs to run a live ACEmulator (`external/ACE/`)
> instance locally so the Phase 1 follow-on (`holtburger-cli ↔
> holtburger-wsshim ↔ holtburger-wsbridge ↔ ACE`) can be exercised end-to-end.
>
> **Status (2026-05-04):** Phase 1 follow-on is **CLOSED**. Both validation
> paths ran successfully end-to-end:
> 1. `holtburger-cli → UDP 127.0.0.1:9000 → ACE` direct: full handshake,
>    DddInterrogation response, CharacterList, ServerName "ACEmulator-local",
>    cli reached the Selection page.
> 2. `holtburger-cli → UDP 127.0.0.1:19000 → wsshim → ws://127.0.0.1:8080
>    → wsbridge → UDP 127.0.0.1:9000 → ACE`: identical handshake events,
>    confirming the proxy is transparent.
>
> See "Validation results (2026-05-04)" below for the runtime evidence.
> The "Lessons learned" callout flags the things that bit during the
> first dry run — read it before reproducing.

---

## TL;DR

1. Provision MariaDB locally (already installed + running on this host).
   Create three databases: `ace_auth`, `ace_shard`, `ace_world` + an `ace`
   user. **MariaDB 11+ on Debian needs an explicit
   `ALTER USER ... IDENTIFIED VIA mysql_native_password` after `CREATE
   USER`** — the default auth plugin for new users is `unix_socket`,
   which would block app-side login. (See "Lessons learned" §1.)
2. Load `ace_world_release/ACE-World-Database-v0.9.292.sql` into
   `ace_world` and `Database/Base/{Authentication,Shard}Base.sql` (from
   the upstream ACE clone in step 4) into `ace_auth` + `ace_shard`. The
   audit's claim that EF Core auto-creates the auth/shard schemas is
   incorrect — they ship as `.sql` files in the upstream tree.
3. Install .NET 10 SDK. The user-local `dotnet-install.sh` path
   (`~/.dotnet`) avoids needing sudo and is the simplest; verified with
   `dotnet --version` returning `10.0.203` on Debian 13.
4. **The vendored `external/ACE/Source/` is a partial vendor (only
   `ACE.Entity` + `ACE.Server` directories).** Do NOT try to build from
   it. Clone the full upstream `ACEmulator/ACE` into a separate
   location (e.g. `~/ace-server/`) and build there.
5. Drop a `Config.js` next to the built `ACE.Server.dll` pointing at
   `/home/wbterminal/ac_base_dats/` for DATs and `127.0.0.1` for SQL.
6. Run ACE with `ACE_NONINTERACTIVE_CONSOLE=true ... < /dev/null` —
   **mandatory for headless runs.** Without it, the interactive prompt
   loops on EOF, spamming stdout + filling disk (we hit 803 MB in 4
   minutes during the first dry run).
7. Wire `holtburger-wsbridge` in front (UDP `:9000`/`:9001` → WS `:8080`),
   point `holtburger-wsshim` at it (binds local UDP `:19000`/`:19001`
   tagging frames as 9000/9001), run an unmodified `holtburger-cli`
   against the shim. **The cli's `--dats` flag wants the holtburger HBA
   bundle dir (`external/holtburger/dats/` containing `assets.hba`),
   NOT raw retail DATs** — the cli loads synthesized `holtburger/core`
   assets (skill table, spell table, motion kinematics) that don't
   exist in raw client DATs.

---

## Status — what's verified locally

| Asset | Status | Path |
|---|---|---|
| AC client `client_portal.dat` | ✅ present (884 MB) | `/home/wbterminal/ac_base_dats/client_portal.dat` |
| AC client `client_cell_1.dat` | ✅ present (332 MB) | `/home/wbterminal/ac_base_dats/client_cell_1.dat` |
| AC client `client_local_English.dat` | ✅ present (1.0 MB) | `/home/wbterminal/ac_base_dats/client_local_English.dat` |
| AC client `client_highres.dat` | ⚠️ NOT present — **and not actually required.** Validated: ACE booted clean and the cli completed login + reached the Selection page with only 3 of 4 DATs. The `Config.js.example` line 36 description lists 4 files, but the loader doesn't enforce it. Source a clean retail copy only if a future feature surfaces that needs it. |
| `acclient.exe` (reference build) | ✅ present (4.7 MB) | `/home/wbterminal/ac_base_dats/acclient.exe` |
| World DB seed (decompressed) | ✅ present (149 MB) | `ace_world_release/ACE-World-Database-v0.9.292.sql` — loads 43,911 weenies + 365,183 landblock_instances + 6,266 spells into `ace_world`. |
| World DB seed (zip) | ✅ present (19 MB) | `ACE-World-Database-v0.9.292.sql.zip` |
| Auth + Shard base schemas | ✅ in upstream ACE clone | `~/ace-server/Database/Base/{AuthenticationBase,ShardBase}.sql` (after step 4's clone). Loading these into `ace_auth` + `ace_shard` is **required** — the audit's "EF Core auto-creates them" claim was wrong; ACE startup expects the tables already present. |
| MariaDB daemon | ✅ installed + running | `/sbin/mariadbd`, version `11.8.6-MariaDB-0+deb13u1`. Already accepting connections at session start. **Non-systemd host** — uses `mariadbd-safe`. |
| .NET 10 SDK | ✅ installed (2026-05-04) | `~/.dotnet/dotnet --version` returns `10.0.203`. User-local install via `dotnet-install.sh`, no sudo needed. |
| Docker / docker-compose | ❌ NOT installed | Native path was chosen instead; Path B is unverified. |
| Vendored ACE source `external/ACE/Source/` | ⚠️ **partial — only ACE.Entity + ACE.Server** | Cannot build from this directly; the `.sln` references 9 projects, only 2 directories exist. Use a fresh upstream clone (step 4). |
| Upstream ACE source clone | ✅ in place | `/home/wbterminal/ace-server/` (cloned from `https://github.com/ACEmulator/ACE.git --depth 1`, ~28 MB). All 9 projects present. Build output at `~/ace-server/Source/ACE.Server/bin/x64/Release/net10.0/ACE.Server.dll`. |
| Built `ACE.Server.dll` | ✅ built | 0 errors, 14 warnings (all log4net 2.0.17 known CVE non-blockers). |
| Live `ace_auth` / `ace_shard` / `ace_world` | ✅ provisioned | `mysql -u ace -pace` connects with `ALL PRIVILEGES` on all three. |
| ACE running locally | ✅ as of 2026-05-04 | Listening on UDP `0.0.0.0:9000` + `0.0.0.0:9001`. World OPEN. Auth DB has no admin accounts → "the next account to be created will automatically be promoted to an Admin account". |
| `holtburger-cli`, `holtburger-wsbridge`, `holtburger-wsshim` | ✅ built | `external/holtburger/target/release/{tui,holtburger-wsbridge,holtburger-wsshim}` |
| Phase 1 follow-on | ✅ **CLOSED** (2026-05-04) | Both direct cli↔ACE and full bridge+shim+cli loop reach the Selection page. Login + handshake + character list + ServerName all received. |

---

## Lessons learned (2026-05-04 dry run)

The pre-validation draft of this doc had several inaccuracies that
bit during the actual run. Patched here for the next reader.

1. **MariaDB on Debian 13 needs explicit `mysql_native_password` for
   the app user.** `CREATE USER 'ace'@'localhost' IDENTIFIED BY 'ace'`
   on MariaDB 11.8 silently creates the user with the `unix_socket`
   auth plugin (mirroring the root account's plugin). Subsequent
   `mysql -u ace -pace` fails with error `1698 Access denied`. The
   fix is one explicit ALTER:
   ```sql
   ALTER USER 'ace'@'localhost' IDENTIFIED VIA mysql_native_password USING PASSWORD('ace');
   FLUSH PRIVILEGES;
   ```
   Or use `IDENTIFIED VIA mysql_native_password USING PASSWORD('ace')`
   directly on `CREATE USER`. The original doc's recipe is updated
   below.

2. **`ACE_NONINTERACTIVE_CONSOLE=true` is mandatory for headless
   runs.** Without a TTY, ACE's interactive console reads EOF and
   loops the prompt (`>> ACE >> ACE >> ...`) infinitely, producing
   ~13 MB/s of stdout. We hit 803 MB in ~4 minutes during the first
   run before noticing. Set the env var when launching, and redirect
   stdin to `/dev/null` for belt-and-suspenders. The Config.js
   `Server.NonInteractive` setting does NOT exist; this is env-var
   only.

3. **The vendored `external/ACE/Source/` is a partial vendor.** Only
   `ACE.Entity` and `ACE.Server` directories are present, but
   `ACE.sln` references 9 projects (`ACE.Common`, `ACE.DatLoader`,
   `ACE.Database`, `ACE.Adapter`, plus tests for each). `dotnet
   restore` fails with `MSB3202: project file ... was not found`.
   Solution: clone the full upstream `ACEmulator/ACE` to a sibling
   location and build there. Recipe below.

4. **Auth + Shard schemas are NOT auto-created by EF Core.** The
   audit Section 1.2 / 1.3 said "schema auto-generated" — that's
   wrong. ACE expects the tables to exist before startup. The
   schemas are at `Database/Base/{AuthenticationBase,ShardBase,
   WorldBase}.sql` in the upstream tree (after step 4's clone). Auth
   has 2 tables, Shard has 40, World gets 54+ from the v0.9.292 dump.

5. **The `holtburger-cli --dats` flag wants the holtburger HBA
   bundle dir, NOT raw retail DATs.** Pointing it at
   `~/ac_base_dats/` fails with `failed to load skill table for
   client runtime` because the cli's `ContentRepository` reads
   synthesized assets from the `holtburger/core` namespace
   (skill_table, spell_table, motion_kinematics, XP table) — these
   only exist in `dats/assets.hba` produced by `dat2hba`. Point
   `--dats` at `external/holtburger/dats/` (already has
   `assets.hba`).

6. **`client_highres.dat` is not actually required.** ACE booted
   clean and the cli logged in successfully with only 3 of 4
   client DATs. The Config.js example comment lists 4, but the
   DatManager doesn't enforce it.

7. **ACE auto-account-creation works exactly as advertised.**
   `Config.js.example` ships with `AllowAutoAccountCreation: true`.
   First login with new credentials creates the account; if no
   admin exists yet, the new account is promoted to admin
   automatically. Subsequent accounts are players.

8. **The cli is a TUI — needs a pty for headless validation.**
   Wrap with `timeout 30 script -qfc 'COMMAND' /dev/null` to give
   it a pty while discarding the recorded transcript. Use
   `--debug-log <FILE>` + `-VVVV` to capture transport-level events.
   Note: `--auto-quit` only fires "when the client disconnects" —
   a healthy logged-in connection keeps the cli alive past the
   timeout, which is fine for a smoke test (kill via `timeout`).

9. **MariaDB's `ace_world` v0.9.292 dump exit code is 1, not 0.**
   The dump finishes loading completely (43k+ weenies) but exits
   with code 1 — likely an `ALTER TABLE` on a non-existent table,
   common in MariaDB-vs-MySQL variants. Check row counts to verify
   success rather than relying on exit code.

10. **`SELECT ... FROM x AS rows ...` is invalid in MariaDB 11.8.**
    `rows` is a reserved word now. Quote it as a column alias if
    needed (`AS \`rows\``) or use a different name.

---

## Validation results (2026-05-04)

The runs that closed Phase 1's follow-on, captured here as the
authoritative "this works" reference.

### Direct cli↔ACE (option 1)

```
holtburger-cli ──UDP 9000/9001──▶ ACE
```

Run:
```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger
timeout 30 script -qfc \
  'target/release/tui --host 127.0.0.1 --port 9000 --account smoketest1 --password smoketest1 --dats ./dats --debug-log /tmp/cli-debug.log -VVVV --auto-quit' \
  /dev/null
```

Result (from `/tmp/cli-debug.log`):
- `Mounted content source ./dats/assets.hba with namespaces [eor/cell, eor/portal, holtburger/core]`
- `>>> Sending Login Request for account smoketest1`
- `<<< Inbound from 127.0.0.1:9000` — handshake `ConnectRequestData { server_seed: ..., client_seed: ... }`
- `Inbound packet confirmed activation source 127.0.0.1:9001; switching expected source from 127.0.0.1:9000`
- `GameMessage: DddInterrogation` → `>>> Outgoing Message: DddInterrogationResponse(language: 1, lists: [])`
- `GameMessage: CharacterList { characters: [], max_slots: 11, account_name: "smoketest1", use_turbine_chat: true, has_tod_expansion: true }`
- `GameMessage: ServerName { current_connections: 0, max_connections: 128, name: "ACEmulator-local" }`
- `Page transition: "Selection" -> Selection (character list received)`

The cli reached the Selection page on a real ACE instance.

### Full Phase 1 loop (option 2)

```
holtburger-cli ──UDP 19000/19001──▶ wsshim ──ws://127.0.0.1:8080──▶ wsbridge ──UDP 9000/9001──▶ ACE
              ◀──UDP 19000/19001──         ◀──ws://127.0.0.1:8080──         ◀──UDP 9000/9001──
```

Run (3 terminals or 3 background processes):
```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger

# T1: bridge in front of ACE
./target/release/holtburger-wsbridge \
    --listen 127.0.0.1:8080 \
    --ace-host 127.0.0.1 \
    --ace-login-port 9000

# T2: shim in front of cli
./target/release/holtburger-wsshim \
    --bridge ws://127.0.0.1:8080/ \
    --listen-host 127.0.0.1 \
    --listen-login-port 19000 \
    --ace-login-port 9000

# T3: cli through the shim
timeout 30 script -qfc \
  'target/release/tui --host 127.0.0.1 --port 19000 --account smoketest2 --password smoketest2 --dats ./dats --debug-log /tmp/cli-loop-debug.log -VVVV --auto-quit' \
  /dev/null
```

Bridge accepted the WS connection from shim and opened an ephemeral
UDP socket toward ACE:
```
[bridge] [127.0.0.1:35748] accepted; upgrading to ws
[bridge] [127.0.0.1:35748] udp socket bound to Some(0.0.0.0:34576)
```

cli's debug log shows the same handshake events as option 1, just
with the proxy in the middle. The bridge being transparent is
verified.

**Phase 1 follow-on is officially closed.** Update
`docs/emit-dynamic-site.md` §8 Phase 1 status block (move ⏳ →
✅) and the auto-memory entry.

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

**Recommended (verified 2026-05-04):** user-local install via
`dotnet-install.sh`. No sudo needed; lands at `~/.dotnet/`. Confirmed
working on Debian 13 trixie with `libicu76` already installed:

```bash
curl -sSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
chmod +x /tmp/dotnet-install.sh
bash /tmp/dotnet-install.sh --channel 10.0 --install-dir $HOME/.dotnet
$HOME/.dotnet/dotnet --version   # should print 10.0.x (10.0.203 as of writing)
```

For the rest of this doc, we use `$HOME/.dotnet/dotnet` directly
rather than relying on PATH munging — keeps the recipe explicit.

**Alternative:** Microsoft's apt feed for system-wide install
(needs sudo). Debian 13's feed exists at
`https://packages.microsoft.com/config/debian/13/packages-microsoft-prod.deb`:

```bash
wget https://packages.microsoft.com/config/debian/13/packages-microsoft-prod.deb -O /tmp/ms.deb
sudo dpkg -i /tmp/ms.deb
sudo apt-get update
sudo apt-get install -y dotnet-sdk-10.0
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

### A.3 Create the three ACE databases + load all schemas

**Important correction:** the original draft said "EF Core auto-creates
auth/shard schemas on first run." Wrong — ACE expects the tables to
exist before startup. The base schemas are at `Database/Base/*.sql` in
the upstream ACE clone (see §A.5). Load all three.

```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition

# Step 1 — create databases + ace user. Note the explicit
# `IDENTIFIED VIA mysql_native_password USING PASSWORD()` form
# (MariaDB 11.8 on Debian 13 silently uses unix_socket auth otherwise).
sudo mariadb <<'SQL'
CREATE DATABASE IF NOT EXISTS ace_auth  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS ace_shard CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS ace_world CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

DROP USER IF EXISTS 'ace'@'localhost';
CREATE USER 'ace'@'localhost' IDENTIFIED VIA mysql_native_password USING PASSWORD('ace');
GRANT ALL PRIVILEGES ON ace_auth.*  TO 'ace'@'localhost';
GRANT ALL PRIVILEGES ON ace_shard.* TO 'ace'@'localhost';
GRANT ALL PRIVILEGES ON ace_world.* TO 'ace'@'localhost';
FLUSH PRIVILEGES;
SQL

# Verify the ace user can connect (this is where unix_socket-auth fails fast).
mysql -u ace -pace -e "SHOW DATABASES;"
# Expected: ace_auth, ace_shard, ace_world, information_schema

# Step 2 — load auth + shard base schemas (after step A.5's clone, but
# you can do it now if the upstream clone is already in place).
mysql -u ace -pace ace_auth  < $HOME/ace-server/Database/Base/AuthenticationBase.sql
mysql -u ace -pace ace_shard < $HOME/ace-server/Database/Base/ShardBase.sql

# Step 3 — load the 149 MB world dump (1-3 minutes). Exit code may be 1
# from a non-fatal ALTER on a non-existent table; verify by row counts.
mysql -u ace -pace ace_world < ace_world_release/ACE-World-Database-v0.9.292.sql

# Step 4 — verify all three DBs are populated.
mysql -u ace -pace -e "
  SELECT 'ace_auth'  AS db, COUNT(*) AS tables FROM information_schema.tables WHERE table_schema='ace_auth'
  UNION SELECT 'ace_shard', COUNT(*) FROM information_schema.tables WHERE table_schema='ace_shard'
  UNION SELECT 'ace_world', COUNT(*) FROM information_schema.tables WHERE table_schema='ace_world';
"
# Expected (verified 2026-05-04): ace_auth=2, ace_shard=40, ace_world=54

mysql -u ace -pace -e "
  USE ace_world;
  SELECT 'weenie'             AS t, COUNT(*) AS n FROM weenie
  UNION SELECT 'landblock_instance', COUNT(*)    FROM landblock_instance
  UNION SELECT 'spell',              COUNT(*)    FROM spell;
"
# Expected: weenie=43911, landblock_instance=365183, spell=6266
```

**Gotcha:** if `mysql -u ace -pace -e "..."` returns
`ERROR 1698 (28000) Access denied`, the user got created with
`unix_socket` auth instead of password auth. Re-run the ALTER:
```bash
sudo mysql -e "ALTER USER 'ace'@'localhost' IDENTIFIED VIA mysql_native_password USING PASSWORD('ace'); FLUSH PRIVILEGES;"
```
**Gotcha 2:** column alias `rows` is reserved in MariaDB 11.8 — use
`n` or quote the alias as `\`rows\``.

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

### A.5 Clone the full upstream ACE + build

**Important correction:** the vendored `external/ACE/Source/` is a
partial copy with only `ACE.Entity` + `ACE.Server` directories. The
solution file references 9 projects (`ACE.Common`, `ACE.DatLoader`,
`ACE.Database`, `ACE.Adapter` plus their tests), and `dotnet restore`
fails with `MSB3202: project file ... was not found`. Clone full
upstream into a sibling location and build there:

```bash
git clone --depth 1 https://github.com/ACEmulator/ACE.git $HOME/ace-server
cd $HOME/ace-server/Source

$HOME/.dotnet/dotnet restore
# Restores 9 projects with NuGet pulls — first run takes 10-30 sec
# depending on connection. Only warning is log4net 2.0.17 known CVE
# (non-blocking).

$HOME/.dotnet/dotnet build --configuration Release
# Verified clean build: 0 Errors, 14 Warnings (all log4net), ~45 sec.

# Build output:
ls $HOME/ace-server/Source/ACE.Server/bin/x64/Release/net10.0/ACE.Server.dll
```

The vendored `external/ACE/` in this repo provides the Dockerfile,
docker-compose.yml, docker.env, and Config.js.example as references —
the build root is the fresh clone.

### A.6 Configure ACE

ACE looks for a `Config.js` (NOT `.json`) next to its DLL on first run.
If absent, it auto-clones from `Config.js.example` and runs the
interactive setup wizard (`Program_Setup.cs`). Skip the wizard by
dropping a fully-formed `Config.js` in place:

```bash
BUILD_OUT="$HOME/ace-server/Source/ACE.Server/bin/x64/Release/net10.0"

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
        "ModsDirectory": "/home/wbterminal/ace-server/Source/ACE.Server/bin/x64/Release/net10.0/Mods/",
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

### A.7 Run ACE (headless-safe)

**Mandatory env var:** `ACE_NONINTERACTIVE_CONSOLE=true` disables the
interactive command-prompt loop. Without it, ACE reads EOF from stdin
and busy-loops the prompt forever, producing ~13 MB/s of stdout
(verified — we hit 803 MB in 4 minutes during the dry run). Pair with
`< /dev/null` to ensure stdin is genuinely closed:

```bash
cd $HOME/ace-server/Source/ACE.Server/bin/x64/Release/net10.0
ACE_NONINTERACTIVE_CONSOLE=true $HOME/.dotnet/dotnet ACE.Server.dll < /dev/null
```

Or as a backgroundable one-liner from anywhere:
```bash
cd $HOME/ace-server/Source/ACE.Server/bin/x64/Release/net10.0 \
  && ACE_NONINTERACTIVE_CONSOLE=true $HOME/.dotnet/dotnet ACE.Server.dll < /dev/null > /tmp/ace.log 2>&1 &
```

First-run startup signals (in order, watch the console or
`tail -f /tmp/ace.log`):

1. `Initializing ConfigManager...`
2. `DAT Patching Disabled...`
3. `Initializing DatabaseManager...`
4. `[DATABASE] Successfully connected to ace_auth database on 127.0.0.1:3306.`
5. `Authentication Database does not contain any admin accounts. The next account to be created will automatically be promoted to an Admin account.` — fresh DB, expected.
6. `[DATABASE] Successfully connected to ace_world database on 127.0.0.1:3306.`
7. `[DATABASE] Successfully connected to ace_shard database on 127.0.0.1:3306.`
8. `Initializing WorldManager...`
9. `Initializing SocketManager...`
10. `Binding ConnectionListener to 0.0.0.0:9000`
11. `Binding ConnectionListener to 0.0.0.0:9001`
12. `Found 6 landblock entries in PreloadedLandblocks configuration, 1 are set to preload.`
13. `World started and is currently Closed and will open automatically when server startup is complete.`
14. `ACEmulator command prompt disabled - Environment.GetEnvironmentVariable(ACE_NONINTERACTIVE_CONSOLE) was true` — confirms env var was picked up.
15. `[CHAT][AUDIT] [SYSTEM] says on the Audit channel, "World is now open"` — final ready signal.

**First-run cold-start time** (verified): ~10-15 seconds. The original
audit guess of "30–90 seconds" came from assuming all the SQL update
files apply on every boot — they actually only apply on FIRST boot.
Subsequent restarts skip them and finish in seconds.

The very first run also applies ~50 SQL update files
(`Found YYYY-MM-DD-NN-Fix-X.sql ... Importing into ace_shard ... complete!`)
between steps 5 and 6. That batch takes 30-60 seconds. Once applied,
ACE remembers and skips them on subsequent boots.

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

## Closing the live-ACE loop (DONE 2026-05-04)

Phase 1's outstanding follow-on (per `docs/emit-dynamic-site.md` §8)
was the live-ACE round-trip. With ACE running, the Phase 1 loop became
runnable; both validation paths succeeded. See "Validation results
(2026-05-04)" near the top for the captured handshake events.

```text
holtburger-cli ──udp──▶ holtburger-wsshim ──ws──▶ holtburger-wsbridge ──udp──▶ ACE
              ◀──udp──                  ◀──ws──                       ◀──udp──
```

The recipes below are the verified commands; they replace the original
draft's flag names (which had `--listen-port` and `--username`, both
wrong).

### L.1 Build the bridge + shim + cli

```bash
source ~/.cargo/env
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger

cargo build --release -p holtburger-wsbridge   # builds bridge AND shim
cargo build --release -p holtburger-cli        # builds the TUI

ls target/release/{holtburger-wsbridge,holtburger-wsshim,tui}
```

The wsbridge crate produces both binaries (bridge + shim) since
they share the frame codec. The cli's binary is named `tui` (set
by `default-run = "tui"` in its Cargo.toml).

### L.2 Run the bridge (listens on WS :8080, forwards to ACE)

```bash
./target/release/holtburger-wsbridge \
    --listen 127.0.0.1:8080 \
    --ace-host 127.0.0.1 \
    --ace-login-port 9000
# World port defaults to login + 1 = 9001 to match holtburger's auth.rs
# convention. Same applies to the shim.
```

Expected log:
```
[bridge] listening on ws://127.0.0.1:8080  →  udp 127.0.0.1:9000 (login) / 127.0.0.1:9001 (world)
```

### L.3 Run the shim (binds local UDP :19000/:19001)

The shim must bind UDP ports DIFFERENT from ACE's, since ACE itself
listens on 9000/9001 on this host. The original draft's recipe was
broken for single-host testing.

```bash
./target/release/holtburger-wsshim \
    --bridge ws://127.0.0.1:8080/ \
    --listen-host 127.0.0.1 \
    --listen-login-port 19000 \
    --ace-login-port 9000
# Tags WS frames as ace login=9000, world=9001 — the bridge uses these
# tags to route to ACE's actual ports.
```

Expected log:
```
[shim] listening udp 127.0.0.1:19000 (login) / 127.0.0.1:19001 (world); tagging ws frames as ace login=9000, world=9001; dialing ws://127.0.0.1:8080/
[shim] ws connected to ws://127.0.0.1:8080/
```

### L.4 Run the cli through the shim

The cli is a TUI, so wrap it under `script` for headless validation
(or run it interactively in a real terminal). Note the corrected
flag names:

- `--account` (not `--username`) for the account name
- `--password` for the password
- `--port` (not `--login-port`) — the cli derives the world port
- `--dats` must point at a directory containing `assets.hba` (the
  holtburger HBA bundle), NOT raw retail DATs. The repo's
  `external/holtburger/dats/` directory has it.

```bash
# Headless validation (under pty, 30s budget):
timeout 30 script -qfc \
  'target/release/tui --host 127.0.0.1 --port 19000 --account smoketest1 --password smoketest1 --dats ./dats --debug-log /tmp/cli-loop.log -VVVV --auto-quit' \
  /dev/null

# Interactive (in a real terminal):
target/release/tui --host 127.0.0.1 --port 19000 --account yourname --password yourpassword --dats ./dats
```

`AllowAutoAccountCreation: true` (in Config.js) means any new
credentials auto-create an account. The first account on a fresh
ACE install is auto-promoted to admin.

### L.5 What success looks like

The cli should:

1. ✅ Mount HBA: `Mounted content source ./dats/assets.hba with namespaces [eor/cell, eor/portal, holtburger/core]`
2. ✅ Connect: `Sending Login Request for account ...`
3. ✅ Handshake: `<<< Inbound from 127.0.0.1:9000` (or :19000 through shim)
4. ✅ DddInterrogation + response
5. ✅ CharacterList received: `GameMessage: CharacterList(...)` (empty for new account)
6. ✅ ServerName: `GameMessage: ServerName { ... name: "ACEmulator-local" }`
7. ✅ Page transition: `Page transition: "Selection" -> Selection`

Steps 1-7 are what the 2026-05-04 validation reached. Going further
(create a character, enter the world, walk around, chat) requires
interactive use of the TUI — not part of the headless smoke.

Failure localisation:
- step 1 fails → wrong `--dats` path; needs an `assets.hba` directory
- step 2-3 fails → bridge / shim / port wiring (or ACE not listening)
- step 4-6 fails → ISAAC / packet framing / ACE config drift
- past step 6 → DB connectivity / world DB integrity / DAT version

**Phase 1 is closed.** Update `docs/emit-dynamic-site.md` §8 Phase 1
status block (move the ⏳ to ✅) and the auto-memory entry. Phase 2's
open follow-on (`try_ws_handshake_smoke` against a live bridge)
becomes runnable the same way, just with the WASM bundle replacing
the cli — that's the next milestone.

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
- **Schema bootstrap is `.sql` files, not EF Core.** The `Database/
  Base/{Authentication,Shard,World}Base.sql` files in the upstream
  ACE clone must be loaded explicitly before first startup. ACE does
  NOT auto-create them on first run; startup will fail at
  `Initializing DatabaseManager` if the tables don't exist. The
  `Offline.AutoApplyDatabaseUpdates: true` setting handles
  *post-base* update SQL scripts (the ~50 `Database/Updates/*.sql`
  files), not the base schemas.
- **`ACE_NONINTERACTIVE_CONSOLE=true` is mandatory for headless.** The
  Config.js has no equivalent setting; this must be an env var when
  launching. Pair with `< /dev/null` for stdin closure. Without it,
  ACE's prompt loops on EOF and floods stdout (~13 MB/s, hit 803 MB
  in 4 minutes during the dry run).
- **MariaDB 11.8 (Debian 13) silently picks `unix_socket` auth.**
  `CREATE USER ... IDENTIFIED BY 'pass'` produces a user that the
  application can't log into via `mysql -u user -ppass`. Use the
  explicit `IDENTIFIED VIA mysql_native_password USING PASSWORD('pass')`
  syntax. If you forget, fix with `ALTER USER ...` (see Lessons §1).
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
- **ACE's `SocketManager` is part of the upstream ACE source** (in
  `Source/ACE.Server/`). The original draft inherited the audit's
  incorrect "`ACE.Adapter` is a NuGet dep" claim — actually
  `ACE.Adapter` is one of the 9 projects that need cloning from
  upstream. The vendored partial copy in `external/ACE/Source/`
  doesn't have it. The bridge approach in `holtburger-wsbridge`
  treats ACE as a black box and proxies UDP — never calls into
  `SocketManager` regardless. Patching ACE-side would mean editing
  `Source/ACE.Server/SocketManager.cs` in the upstream clone;
  unnecessary so far.
- **`holtburger-cli --dats` wants the HBA bundle dir, not raw retail
  DATs.** Pointing at `~/ac_base_dats/` fails with `failed to load
  skill table for client runtime` because the cli reads synthesized
  `holtburger/core` assets. Point at `external/holtburger/dats/`
  (which contains `assets.hba`).
- **The cli is a TUI; needs a pty for headless.** Wrap with
  `timeout 30 script -qfc 'CMD' /dev/null`. `--auto-quit` only fires
  on disconnect — a healthy logged-in connection keeps the cli alive
  past the timeout, which is fine for a smoke test.
- **MariaDB column alias `rows` is reserved in 11.8.** Use a
  different alias or backtick-quote it.
- **World dump exit code 1 is OK.** The 149 MB v0.9.292 dump exits 1
  but loads fully — verify by row counts (43,911 weenies expected),
  not exit code.

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

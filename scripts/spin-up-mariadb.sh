#!/usr/bin/env bash
# spin-up-mariadb.sh — bootstrap a local MariaDB fixture loaded with the ACE
# world dump for ground-truthing the static-site emitter. Idempotent: safe
# to re-run; existing database gets dropped and reloaded.
#
# Credentials are intentionally unguarded (baltic/baltic) — this is a
# developer fixture on 127.0.0.1, not a production deployment.
set -euo pipefail

DB_NAME="baltic"
DB_USER="baltic"
DB_PASS="baltic"
SQL_DUMP="${1:-ace_world_release/ACE-World-Database-v0.9.292.sql}"
SQL_ZIP="${SQL_DUMP}.zip"

cd "$(dirname "$0")/.." || exit 1

if [ ! -f "$SQL_DUMP" ]; then
    if [ -f "$SQL_ZIP" ]; then
        echo "[spin-up] Unzipping $SQL_ZIP …"
        unzip -o "$SQL_ZIP" -d "$(dirname "$SQL_DUMP")"
    else
        echo "ERROR: SQL dump $SQL_DUMP not found, and $SQL_ZIP also missing." >&2
        exit 1
    fi
fi

# 1. Install mariadb-server if absent.
if ! command -v mariadb >/dev/null 2>&1 && ! command -v mysql >/dev/null 2>&1; then
    echo "[spin-up] mariadb / mysql not on PATH — installing mariadb-server …"
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y mariadb-server
fi

# 2. Start the daemon if not running. Try systemctl first, fall back to
#    `service` and (Docker-friendly) the mysqld_safe / mariadbd binary.
if ! sudo mysqladmin --silent ping 2>/dev/null; then
    if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q mariadb; then
        echo "[spin-up] Starting mariadb via systemctl …"
        sudo systemctl start mariadb
    elif command -v service >/dev/null 2>&1; then
        echo "[spin-up] Starting mariadb via service …"
        sudo service mariadb start || sudo service mysql start
    else
        echo "[spin-up] No service manager found — start the daemon manually." >&2
        exit 1
    fi
fi

# 3. Wait up to 30s for the daemon to accept connections.
for _ in $(seq 1 30); do
    if sudo mysqladmin --silent ping 2>/dev/null; then
        break
    fi
    sleep 1
done
if ! sudo mysqladmin --silent ping 2>/dev/null; then
    echo "[spin-up] mariadb daemon never came up — check logs (journalctl -u mariadb)." >&2
    exit 1
fi

# 4. Provision DB + user. Drop-and-recreate so a re-run cleanly reseeds.
echo "[spin-up] Provisioning database '$DB_NAME' and user '$DB_USER'@'localhost' …"
sudo mariadb <<SQL
DROP DATABASE IF EXISTS \`$DB_NAME\`;
CREATE DATABASE \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
SQL

# 5. Stream the dump through sed to remap the source database name
#    (`ace_world`) to our fixture name (`baltic`). The dump opens with
#    DROP/CREATE/USE statements scoped to `ace_world`; our wrapper above
#    has already created `baltic`, so we strip those statements and
#    rewrite remaining backtick-quoted references.
echo "[spin-up] Loading dump into '$DB_NAME' (this takes 1-3 minutes for ~155MB) …"
sed -E '
    /^\/\*!40000 DROP DATABASE/d
    /^CREATE DATABASE \/\*!32312/d
    /^USE `ace_world`;/d
    s/`ace_world`/`'"$DB_NAME"'`/g
' "$SQL_DUMP" | mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME"

# 6. Verify with row counts on the two tables the rest of the wave depends on.
echo "[spin-up] Verification:"
mysql -u "$DB_USER" -p"$DB_PASS" -e "
    SELECT COUNT(*) AS weenies            FROM \`$DB_NAME\`.weenie;
    SELECT COUNT(*) AS landblock_instances FROM \`$DB_NAME\`.landblock_instance;
    SELECT COUNT(*) AS spells              FROM \`$DB_NAME\`.spell;
"

echo "[spin-up] Done. Connect via:"
echo "  mysql -u $DB_USER -p$DB_PASS $DB_NAME"
echo "or programmatically with:"
echo "  ace-db connect host=127.0.0.1 port=3306 user=$DB_USER password=$DB_PASS database=$DB_NAME"

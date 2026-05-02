#!/usr/bin/env bash
# spin-down-mariadb.sh — drop the developer fixture database and user
# created by spin-up-mariadb.sh. Leaves the daemon running so other
# databases on the same instance are untouched.
set -euo pipefail

DB_NAME="baltic"
DB_USER="baltic"

if ! sudo mysqladmin --silent ping 2>/dev/null; then
    echo "[spin-down] mariadb not running — nothing to do."
    exit 0
fi

echo "[spin-down] Dropping database '$DB_NAME' and user '$DB_USER'@'localhost' …"
sudo mariadb <<SQL
DROP DATABASE IF EXISTS \`$DB_NAME\`;
DROP USER IF EXISTS '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
SQL

echo "[spin-down] Done."

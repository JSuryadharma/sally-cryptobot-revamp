#!/usr/bin/env bash
# Copies all app data (the kv_store table) from the current database (e.g. Neon,
# used by Vercel) into the bundled server Postgres. Run from the deploy/ folder:
#
#   ./copy-db-from-neon.sh 'postgresql://user:pass@host/db?sslmode=require'
#
# It replaces whatever is in the server database. Pause the cron-job.org job
# first so no tick writes to the old database while you copy.
set -euo pipefail

SOURCE_URL="${1:?Usage: ./copy-db-from-neon.sh '<current DATABASE_URL>'}"

echo "Dumping kv_store from the current database..."
docker run --rm postgres:17-alpine \
  pg_dump "$SOURCE_URL" --table=kv_store --clean --if-exists --no-owner --no-privileges \
  > kv_store.sql

echo "Loading it into the server database..."
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d sallycryptobot < kv_store.sql

echo "Rows now in the server database:"
docker compose exec -T db psql -U postgres -d sallycryptobot -c "SELECT count(*) FROM kv_store;"
rm -f kv_store.sql
echo "Done."

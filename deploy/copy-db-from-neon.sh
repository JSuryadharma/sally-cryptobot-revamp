#!/usr/bin/env bash
# Copies all app data (the kv_store table) from the current database (e.g. Neon,
# used by Vercel) into the bundled server Postgres. Run from the deploy/ folder:
#
#   ./copy-db-from-neon.sh 'postgresql://user:pass@host/db?sslmode=require'
#
# It replaces whatever is in the server database. Pause the cron-job.org job
# first so no tick writes to the old database while you copy.
# With the root docker-compose.yml (web app + Postgres, no Caddy), run it from the repo
# root instead:  DB_SERVICE=postgres deploy/copy-db-from-neon.sh '<url>'
set -euo pipefail
DB_SERVICE="${DB_SERVICE:-db}"

SOURCE_URL="${1:?Usage: ./copy-db-from-neon.sh '<current DATABASE_URL>'}"

# A ?schema=NAME on the URL is the app's own setting, not something pg_dump knows:
# take it off, dump NAME.kv_store, and load it as public.kv_store on the server.
SCHEMA=$(printf '%s' "$SOURCE_URL" | sed -n 's/.*[?&]schema=\([A-Za-z0-9_]*\).*/\1/p')
SCHEMA=${SCHEMA:-public}
SOURCE_URL=$(printf '%s' "$SOURCE_URL" | sed -E 's/([?&])schema=[A-Za-z0-9_]*&?/\1/; s/[?&]$//')

echo "Dumping $SCHEMA.kv_store from the current database..."
docker run --rm postgres:17-alpine \
  pg_dump "$SOURCE_URL" --table="$SCHEMA.kv_store" --clean --if-exists --no-owner --no-privileges \
  | sed -e "s/\b$SCHEMA\.kv_store\b/public.kv_store/g" -e "/^SET transaction_timeout/d" \
  > kv_store.sql

echo "Loading it into the server database..."
docker compose exec -T "$DB_SERVICE" psql -v ON_ERROR_STOP=1 -U postgres -d sallycryptobot < kv_store.sql

echo "Rows now in the server database:"
docker compose exec -T "$DB_SERVICE" psql -U postgres -d sallycryptobot -c "SELECT count(*) FROM kv_store;"
rm -f kv_store.sql
echo "Done."

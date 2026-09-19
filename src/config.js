import path from 'node:path';

const rootDir = process.cwd();

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Bootstrap-only constants. Everything that used to live here as an env var
// (watchlist, trading parameters, Binance base URL, Telegram, the OpenAI
// advisor) now lives in the DB-backed settings object (src/settings.js) -
// editable at runtime from the Settings page, no restart needed, and no
// separate "env var" and "DB value" to keep in sync. What's left here is
// only what genuinely can't live in the database: values needed BEFORE the
// app can even attempt a database connection.
export const config = {
  rootDir,
  publicDir: path.join(rootDir, 'public'),
  // Not a live storage backend anymore (see storage.js) - only used by
  // scripts/migrateToPostgres.mjs, the one-time explicit migration of old
  // data/*.json files into Postgres. That directory is empty after a
  // successful migration; this path just tells the script where to look.
  dataDir: process.env.DATA_DIR || path.join(rootDir, 'data'),
  // The server has to bind a port before it can query the database to find
  // out what port to bind to - a hard chicken-and-egg case, so this is the
  // one business-ish setting that has to stay an env var (or its default).
  port: numberFromEnv('PORT', 3300)
};

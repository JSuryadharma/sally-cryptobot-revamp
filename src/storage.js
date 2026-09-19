import { isPgConfigured, pgGet, pgSet, pgDel } from './pgClient.js';

// Every other module only ever calls readJson/writeJson - same interface as
// robotrader's storage.js, now backed by Postgres only. Local files are not
// a supported storage backend - by design, so there's exactly one code path
// to reason about and no risk of silently running on stale file-backed state
// without realizing the database is unreachable. DATABASE_URL/POSTGRES_URL
// is required; see .env.example.
//
// Migrating old data/*.json files (from before this switch) into Postgres is
// a one-time, explicit step - see scripts/migrateToPostgres.mjs - not
// something this module does implicitly on read.
const KV_PREFIX = 'robocrypto:';

function requirePg() {
  if (!isPgConfigured()) {
    throw new Error('DATABASE_URL (or POSTGRES_URL) is not set - Postgres is required, there is no local-file fallback. See .env.example.');
  }
}

export async function readJson(fileName, fallback) {
  requirePg();
  const value = await pgGet(KV_PREFIX + fileName); // throws on a real connection/query failure - never silently masked as "just use the fallback"
  return value !== null ? value : structuredClone(fallback);
}

export async function writeJson(fileName, value) {
  requirePg();
  await pgSet(KV_PREFIX + fileName, value);
}

export async function deleteJson(fileName) {
  requirePg();
  await pgDel(KV_PREFIX + fileName);
}

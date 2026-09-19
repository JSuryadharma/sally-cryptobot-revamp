#!/usr/bin/env node
// One-time, explicit migration: data/*.json -> Postgres (src/pgClient.js),
// then deletes each local file once its Postgres copy is verified to match.
// Requires DATABASE_URL/POSTGRES_URL (see .env.example) - this app has no
// local-file storage backend anymore (see src/storage.js), so this script
// exists purely to carry over whatever was written before that switch.
//
// Safe to re-run: a key already present in Postgres is left untouched and
// reported as "already migrated" unless --force is passed. Never deletes a
// local file unless the Postgres copy was just verified byte-for-byte
// against it - a write or verify failure leaves that one file in place and
// reports the error, everything else still proceeds.
//
// Run:
//   node --env-file-if-exists=.env scripts/migrateToPostgres.mjs [--force] [--keep-files]

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { isPgConfigured, pgGet, pgSet } from '../src/pgClient.js';

const KV_PREFIX = 'robocrypto:';

// Every key this app has ever persisted under data/*.json - see storage.js's
// callers (settings.js, tradingRobot.js, notifications.js, backtestRunner.js,
// refreshWatchlist.js). Migrating a name that never existed locally is a
// harmless no-op (reported as "no local file").
const KNOWN_FILES = [
  'settings.json',
  'portfolio.json',
  'notifications.json',
  'telegram-status.json',
  'coins-cache.json',
  'backtest-verdict.json'
];

// A plain JSON.stringify(a) === JSON.stringify(b) comparison is order-
// sensitive - Postgres's JSONB column type does not preserve the original
// key order of a stored object (confirmed directly: writing
// {"watchlist":...,"autoTrade":...,"telegram":...} and reading it back came
// back as {"telegram":...,"autoTrade":...,"watchlist":...} - same data,
// different key order), so that naive comparison reported a false mismatch
// on every single migrated file. This recurses and compares by value,
// ignoring key order.
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const keysA = Object.keys(a), keysB = Object.keys(b);
    return keysA.length === keysB.length && keysA.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

async function migrateOne(fileName, { force, keepFiles }) {
  const filePath = path.join(config.dataDir, fileName);
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { fileName, status: 'no-local-file' };
    throw error;
  }

  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { fileName, status: 'invalid-json', error: error.message };
  }

  const key = KV_PREFIX + fileName;
  const existing = await pgGet(key);
  if (existing !== null && !force) {
    return { fileName, status: 'already-in-postgres' };
  }

  await pgSet(key, value);
  const verify = await pgGet(key);
  if (!deepEqual(verify, value)) {
    return { fileName, status: 'verify-failed' };
  }

  if (!keepFiles) {
    await fs.rm(filePath, { force: true });
  }
  return { fileName, status: keepFiles ? 'migrated-kept-file' : 'migrated-and-deleted' };
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const keepFiles = args.includes('--keep-files');

  if (!isPgConfigured()) {
    console.error('DATABASE_URL (or POSTGRES_URL) is not set - nothing to migrate to. See .env.example.');
    process.exitCode = 1;
    return;
  }

  console.log(`Migrating data/*.json -> Postgres (${force ? 'force overwrite' : 'skip existing'})...\n`);
  const results = [];
  for (const fileName of KNOWN_FILES) {
    try {
      results.push(await migrateOne(fileName, { force, keepFiles }));
    } catch (error) {
      results.push({ fileName, status: 'error', error: error.message });
    }
  }

  for (const r of results) {
    const label = {
      'no-local-file': 'no local file (nothing to migrate)',
      'invalid-json': `local file is not valid JSON: ${r.error}`,
      'already-in-postgres': 'already in Postgres - left untouched (pass --force to overwrite)',
      'verify-failed': 'wrote to Postgres but the read-back did not match - local file KEPT, investigate',
      'migrated-and-deleted': 'migrated, verified, local file deleted',
      'migrated-kept-file': 'migrated and verified (--keep-files: local file left in place)',
      error: `failed: ${r.error}`
    }[r.status];
    console.log(`  ${r.fileName.padEnd(22)} ${label}`);
  }

  const failed = results.filter((r) => r.status === 'verify-failed' || r.status === 'error' || r.status === 'invalid-json');
  if (failed.length) {
    console.log(`\n${failed.length} file(s) need attention - see above. Nothing was deleted for those.`);
    process.exitCode = 1;
  } else {
    console.log('\nDone.');
  }
}

main().catch((error) => {
  console.error('\nMigration failed:', error.message);
  process.exitCode = 1;
});

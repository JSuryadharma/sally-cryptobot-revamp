// Minimal Postgres-backed key-value store, used in place of local files on
// serverless hosts (Vercel) whose deployed filesystem is read-only (confirmed
// directly - writing without this throws "EROFS: read-only file system").
// Chosen over Redis/KV because Vercel's Redis marketplace integration is a
// paid product, while Postgres (via the Neon integration Vercel's Storage tab
// offers) has a genuinely free tier.
//
// Uses the standard `pg` driver (the one real npm dependency this project
// now has - see package.json) rather than a provider-specific HTTP API,
// because raw Postgres wire protocol has no plain-fetch equivalent the way
// Redis's REST commands do, and `pg` works identically against ANY Postgres
// host (Neon, Supabase, Vercel Postgres, Railway, a self-hosted instance) -
// no vendor lock-in to one provider's undocumented HTTP contract.
//
// One `kv_store` table holds every JSON blob this app persists (settings,
// portfolio, notifications, telegram status, the coin-cache from
// api/cron/refresh.js) - one row per key, matching storage.js's existing
// per-fileName-key shape exactly, so nothing above this layer needs to know
// which backend is active.
import pg from 'pg';

const { Pool } = pg;

const CONNECTION_STRING = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';

// A small pool, not pg's default of 10 - serverless functions each get their
// own process, so a generous per-instance pool multiplies across concurrent
// invocations and can exhaust a managed Postgres's total connection limit
// faster than a single long-running server ever would. Neon/Supabase/Vercel
// Postgres all expect this pattern from serverless clients.
let pool = null;
let schemaReady = null;

// Only pass an explicit `ssl` option when the connection string doesn't
// already carry its own sslmode= (e.g. Neon/Supabase URLs already include
// one), so the same thing isn't specified two different ways at once.
// Note: a Neon-style ?sslmode=require URL still logs a one-time forward-
// compat warning from pg-connection-string regardless of this - that's
// pg's own deprecation notice about 'require' being a libpq-semantics alias
// in a future major version, not something this file's config is doing
// wrong. Non-blocking; the connection still succeeds.
function sslOption() {
  if (process.env.POSTGRES_SSL === 'false') return { ssl: false }; // explicit escape hatch for a local/self-hosted instance with no TLS listener
  if (/sslmode=/i.test(CONNECTION_STRING)) return {}; // omit entirely - let pg-connection-string parse sslmode from the URL itself
  return { ssl: { rejectUnauthorized: false } }; // no sslmode in the URL - assume a managed host that still needs TLS
}

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: CONNECTION_STRING,
      max: 3,
      idleTimeoutMillis: 10_000,
      ...sslOption()
    });
  }
  return pool;
}

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = getPool().query(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }
  return schemaReady;
}

export function isPgConfigured() {
  return Boolean(CONNECTION_STRING);
}

export async function pgGet(key) {
  await ensureSchema();
  const { rows } = await getPool().query('SELECT value FROM kv_store WHERE key = $1', [key]);
  return rows.length ? rows[0].value : null;
}

export async function pgSet(key, value) {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
}

export async function pgSetMany(entries) {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const [key, value] of entries) {
      await client.query(
        `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify(value)]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// A row-based lease rather than pg_advisory_lock: session-level advisory locks
// are tied to one pooled connection and leak across serverless invocations.
// The conditional upsert only overwrites a lease whose expiry has passed, so
// exactly one caller gets a RETURNING row.
export async function pgTryAcquireLease(key, owner, ttlMs) {
  await ensureSchema();
  const now = Date.now();
  const { rows } = await getPool().query(
    `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
     WHERE COALESCE((kv_store.value->>'expiresAt')::bigint, 0) < $3
     RETURNING key`,
    [key, JSON.stringify({ owner, expiresAt: now + ttlMs }), now]
  );
  return rows.length === 1;
}

export async function pgReleaseLease(key, owner) {
  await ensureSchema();
  await getPool().query(`DELETE FROM kv_store WHERE key = $1 AND value->>'owner' = $2`, [key, owner]);
}

export async function pgDel(key) {
  await ensureSchema();
  await getPool().query('DELETE FROM kv_store WHERE key = $1', [key]);
}

// Real connection check (not just "is DATABASE_URL set") - actually pings
// the database with a cheap query, so the UI indicator reflects reality
// (wrong password, DB paused/sleeping, network block, etc. all show up here)
// instead of just confirming an env var exists.
export async function checkConnection() {
  if (!isPgConfigured()) return { connected: false, configured: false, error: 'DATABASE_URL/POSTGRES_URL not set.' };
  const startedAt = Date.now();
  try {
    await getPool().query('SELECT 1');
    return { connected: true, configured: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { connected: false, configured: true, error: error.message };
  }
}

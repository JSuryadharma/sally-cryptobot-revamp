import crypto from 'node:crypto';

function bearerFrom(req) {
  const header = req.headers?.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// Returns null when authorized, otherwise { status, error } for the caller to send.
// An unset secret is only tolerated in local dev, so a deployment (Vercel, or a
// server running with NODE_ENV=production) missing the env var fails closed instead of open.
export function checkBearer(req, envName) {
  const expected = process.env[envName] || '';
  if (!expected) {
    const deployed = process.env.VERCEL || process.env.NODE_ENV === 'production';
    return deployed ? { status: 503, error: `${envName} is not configured on the server.` } : null;
  }
  return safeEqual(bearerFrom(req), expected) ? null : { status: 401, error: 'Unauthorized.' };
}

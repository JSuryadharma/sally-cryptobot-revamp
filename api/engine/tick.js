// Called by .github/workflows/engine-tick.yml every ~5 minutes. Uses raw
// writeHead/end to match server.js's sendJson style.
import { handleTickRequest } from '../../src/engine/tick.js';

export default async function handler(req, res) {
  const { status, body } = await handleTickRequest(req);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

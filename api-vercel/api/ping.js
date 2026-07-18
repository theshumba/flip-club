/**
 * GET /api/ping — unauthenticated uptime check.
 */
import { applyCors, sendJson } from './_firestore.js';

export default function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'GET only' });
  }
  return sendJson(res, 200, { ok: true });
}

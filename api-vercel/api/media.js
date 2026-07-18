/**
 * POST /api/media — admin writes for stock/{id}/media/{n} photo docs.
 * Body: { action: 'add'|'clear', stockId, photo?: { b64, w, h, order } }
 * One photo per 'add' call (keeps the body well under Vercel's 4.5MB limit).
 * Auth: header x-cfy-key === env CFY_ADMIN_KEY. All responses JSON.
 */
import {
  applyCors, checkAdminKey, sendJson, readJsonBody,
  fsRequest, toFields, listMediaPaths,
  validatePhoto, ID_RE,
} from './_firestore.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
  if (!checkAdminKey(req)) return sendJson(res, 401, { error: 'unauthorised' });

  const body = await readJsonBody(req);
  if (!body) return sendJson(res, 400, { error: 'invalid JSON body' });
  const { action, stockId, photo } = body;

  if (typeof stockId !== 'string' || !ID_RE.test(stockId)) {
    return sendJson(res, 400, { error: 'stockId must be a valid stock id' });
  }

  try {
    switch (action) {
      case 'add': {
        const v = validatePhoto(photo);
        if (v.error) return sendJson(res, 400, { error: v.error });
        // parent must exist — don't create orphan media
        await fsRequest(`/stock/${encodeURIComponent(stockId)}?mask.fieldPaths=status`);
        const docId = String(v.clean.order); // media doc id = "0","1",... per contract
        await fsRequest(`/stock/${encodeURIComponent(stockId)}/media/${docId}`, {
          method: 'PATCH', // create-or-overwrite at a fixed id (re-upload replaces)
          body: { fields: toFields(v.clean) },
        });
        return sendJson(res, 200, { ok: true, id: docId });
      }

      case 'clear': {
        const paths = await listMediaPaths(stockId);
        for (const p of paths) {
          await fsRequest(`/${p}`, { method: 'DELETE' });
        }
        return sendJson(res, 200, { ok: true, deleted: paths.length });
      }

      default:
        return sendJson(res, 400, { error: "action must be one of: add | clear" });
    }
  } catch (e) {
    if (e.status === 404) return sendJson(res, 404, { error: 'stock unit not found' });
    return sendJson(res, 500, { error: e.message || 'internal error' });
  }
}

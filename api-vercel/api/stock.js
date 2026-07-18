/**
 * POST /api/stock — admin writes for stock/{id} docs.
 * Body: { action: 'create'|'update'|'delete'|'markSold'|'seed', id?, data? }
 * Auth: header x-cfy-key === env CFY_ADMIN_KEY. All responses JSON.
 */
import {
  applyCors, checkAdminKey, sendJson, readJsonBody,
  fsRequest, toFields, listMediaPaths,
  validateUnit, makeStockId, ID_RE,
} from './_firestore.js';

async function createUnit(data) {
  const v = validateUnit(data, { partial: false });
  if (v.error) return { status: 400, body: { error: v.error } };
  const unit = { ...v.clean, created_at: new Date().toISOString(), sold_at: null };
  let id = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    id = makeStockId(unit.name);
    try {
      await fsRequest(`/stock?documentId=${encodeURIComponent(id)}`, {
        method: 'POST',
        body: { fields: toFields(unit) },
      });
      return { status: 200, body: { id } };
    } catch (e) {
      if (e.status === 409 && attempt < 2) continue; // id collision → new random suffix
      throw e;
    }
  }
  throw new Error('could not allocate a unique id');
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
  if (!checkAdminKey(req)) return sendJson(res, 401, { error: 'unauthorised' });

  const body = await readJsonBody(req);
  if (!body) return sendJson(res, 400, { error: 'invalid JSON body' });
  const { action, id, data } = body;

  const requireId = () => {
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      sendJson(res, 400, { error: 'id must be a valid stock id' });
      return false;
    }
    return true;
  };

  try {
    switch (action) {
      case 'create': {
        const out = await createUnit(data);
        return sendJson(res, out.status, out.body);
      }

      case 'update': {
        if (!requireId()) return;
        const v = validateUnit(data, { partial: true });
        if (v.error) return sendJson(res, 400, { error: v.error });
        const fields = Object.keys(v.clean);
        if (!fields.length) return sendJson(res, 400, { error: 'no valid fields to update' });
        const q = new URLSearchParams({ 'currentDocument.exists': 'true' });
        for (const f of fields) q.append('updateMask.fieldPaths', f);
        await fsRequest(`/stock/${encodeURIComponent(id)}?${q.toString()}`, {
          method: 'PATCH',
          body: { fields: toFields(v.clean) },
        });
        return sendJson(res, 200, { ok: true, id });
      }

      case 'markSold': {
        if (!requireId()) return;
        const q = new URLSearchParams({ 'currentDocument.exists': 'true' });
        q.append('updateMask.fieldPaths', 'status');
        q.append('updateMask.fieldPaths', 'sold_at');
        await fsRequest(`/stock/${encodeURIComponent(id)}?${q.toString()}`, {
          method: 'PATCH',
          body: { fields: toFields({ status: 'sold', sold_at: new Date().toISOString() }) },
        });
        return sendJson(res, 200, { ok: true, id });
      }

      case 'delete': {
        if (!requireId()) return;
        // confirm it exists so a typo'd id doesn't silently "succeed"
        await fsRequest(`/stock/${encodeURIComponent(id)}?mask.fieldPaths=status`);
        // remove media docs first, then the unit itself
        const mediaPaths = await listMediaPaths(id);
        for (const p of mediaPaths) {
          await fsRequest(`/${p}`, { method: 'DELETE' });
        }
        await fsRequest(`/stock/${encodeURIComponent(id)}`, { method: 'DELETE' });
        return sendJson(res, 200, { ok: true, id, mediaDeleted: mediaPaths.length });
      }

      case 'seed': {
        const items = Array.isArray(body.items) ? body.items
          : Array.isArray(data?.items) ? data.items : null;
        if (!items || !items.length) return sendJson(res, 400, { error: 'seed requires items: [...]' });
        if (items.length > 50) return sendJson(res, 400, { error: 'seed max 50 items per call' });
        // validate everything first — all-or-nothing before any write
        for (let i = 0; i < items.length; i++) {
          const v = validateUnit(items[i], { partial: false });
          if (v.error) return sendJson(res, 400, { error: `items[${i}]: ${v.error}` });
        }
        const ids = [];
        for (const item of items) {
          const out = await createUnit(item);
          if (out.status !== 200) return sendJson(res, out.status, out.body);
          ids.push(out.body.id);
        }
        return sendJson(res, 200, { ids });
      }

      default:
        return sendJson(res, 400, { error: "action must be one of: create | update | delete | markSold | seed" });
    }
  } catch (e) {
    if (e.status === 404) return sendJson(res, 404, { error: 'stock unit not found' });
    return sendJson(res, 500, { error: e.message || 'internal error' });
  }
}

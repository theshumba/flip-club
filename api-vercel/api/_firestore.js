/**
 * CFY Shop API — shared helpers (zero npm deps).
 * Google service-account auth (JWT signed with node:crypto), Firestore REST,
 * CORS, auth check, JSON responses, input validation.
 *
 * Env (runtime): GOOGLE_SERVICE_ACCOUNT (service-account JSON string),
 *                CFY_ADMIN_KEY (admin passcode for header x-cfy-key).
 */
import crypto from 'node:crypto';

const PROJECT_ID = 'cfy-shop';
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/* ---------------- Google auth (manual JWT, no deps) ---------------- */

let tokenCache = { token: null, exp: 0 };

const b64url = (input) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && now < tokenCache.exp - 60) return tokenCache.token;

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT env var is not set');
  let sa;
  try { sa = JSON.parse(raw); } catch { throw new Error('GOOGLE_SERVICE_ACCOUNT is not valid JSON'); }

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claims}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(sa.private_key);
  const jwt = `${signingInput}.${b64url(signature)}`;

  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new Error(`Google token exchange failed (${r.status}): ${j.error_description || j.error || 'unknown'}`);
  }
  tokenCache = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return j.access_token;
}

/* ---------------- Firestore REST ---------------- */

/** Perform a Firestore REST call. pathAndQuery starts with "/" (relative to /documents). */
export async function fsRequest(pathAndQuery, { method = 'GET', body } = {}) {
  const token = await getAccessToken();
  const r = await fetch(`${FS_BASE}${pathAndQuery}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = {};
  if (text) { try { json = JSON.parse(text); } catch { json = { raw: text }; } }
  if (!r.ok) {
    const msg = json?.error?.message || `Firestore error ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    err.googleStatus = json?.error?.status;
    throw err;
  }
  return json;
}

/** JS value → Firestore REST Value. */
export function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'object') return { mapValue: { fields: toFields(v) } };
  throw new Error(`unsupported value type: ${typeof v}`);
}

export const toFields = (obj) =>
  Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, toValue(v)]));

/** Firestore REST Value → JS value (used by tests / future reads). */
export function fromValue(v) {
  if (v == null) return null;
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  return null;
}

export const fromFields = (fields = {}) =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, fromValue(v)]));

/** List all media doc paths (relative to /documents) for a stock unit. */
export async function listMediaPaths(stockId) {
  const paths = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({ pageSize: '300' });
    q.append('mask.fieldPaths', 'order'); // skip the heavy b64 payloads
    if (pageToken) q.set('pageToken', pageToken);
    const j = await fsRequest(`/stock/${encodeURIComponent(stockId)}/media?${q.toString()}`);
    for (const d of j.documents || []) {
      const rel = d.name.split('/documents/')[1];
      if (rel) paths.push(rel);
    }
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return paths;
}

/* ---------------- HTTP helpers ---------------- */

const ORIGIN_ALLOWLIST = new Set([
  'https://consolesforyou.com',
  'https://www.consolesforyou.com',
  'null', // file:// pages send Origin: null — allowed for local testing
]);
const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

/**
 * Apply CORS. Returns true if the request was a preflight (already answered).
 * Access-Control-Allow-Origin is echoed per-request because the allowlist has
 * multiple origins; the origin-agnostic CORS headers also live in vercel.json.
 */
export function applyCors(req, res) {
  const origin = req.headers?.origin;
  if (origin && (ORIGIN_ALLOWLIST.has(origin) || LOCALHOST_RE.test(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-cfy-key');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

/** Constant-time admin-key check against env CFY_ADMIN_KEY. */
export function checkAdminKey(req) {
  const got = req.headers?.['x-cfy-key'];
  const expect = process.env.CFY_ADMIN_KEY;
  if (!got || !expect) return false;
  const a = crypto.createHash('sha256').update(String(got)).digest();
  const b = crypto.createHash('sha256').update(String(expect)).digest();
  return crypto.timingSafeEqual(a, b);
}

export function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

/** Read the JSON body (Vercel pre-parses; falls back to reading the stream). */
export async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      try { return JSON.parse(req.body); } catch { return null; }
    }
    if (typeof req.body === 'object') return req.body;
    return null;
  }
  let data = '';
  try {
    for await (const chunk of req) data += chunk;
  } catch { return null; }
  if (!data) return null;
  try { return JSON.parse(data); } catch { return null; }
}

/* ---------------- Validation ---------------- */

export const PLATFORMS = ['playstation', 'xbox', 'nintendo', 'retro', 'accessory'];
export const CONDITIONS = ['boxed', 'good', 'faulty'];
export const STATUSES = ['live', 'sold', 'sample'];

const MAX_B64 = 1024 * 1024; // 1MB data-URL cap (contract)
const DATA_URL_RE = /^data:image\/(webp|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const URLISH_RE = /^https?:\/\/\S+$/i;
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidImageDataUrl(s) {
  return typeof s === 'string' && s.length <= MAX_B64 && DATA_URL_RE.test(s);
}

/**
 * Validate stock-unit fields. partial=false (create/seed) enforces required
 * fields and applies defaults; partial=true (update) validates only what's sent.
 * Unknown fields are ignored (never written). Returns { clean } or { error }.
 */
export function validateUnit(data, { partial = false } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { error: 'data must be an object' };
  }
  const clean = {};
  const problems = [];
  const has = (k) => data[k] !== undefined;

  if (has('name')) {
    if (typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 120) {
      problems.push('name must be a non-empty string (max 120 chars)');
    } else clean.name = data.name.trim();
  } else if (!partial) problems.push('name is required');

  if (has('platform')) {
    if (!PLATFORMS.includes(data.platform)) problems.push(`platform must be one of: ${PLATFORMS.join(' | ')}`);
    else clean.platform = data.platform;
  } else if (!partial) problems.push('platform is required');

  if (has('condition')) {
    if (!CONDITIONS.includes(data.condition)) problems.push(`condition must be one of: ${CONDITIONS.join(' | ')}`);
    else clean.condition = data.condition;
  } else if (!partial) problems.push('condition is required');

  if (has('price')) {
    if (!Number.isInteger(data.price) || data.price <= 0) problems.push('price must be an integer number of pence > 0');
    else clean.price = data.price;
  } else if (!partial) problems.push('price is required');

  if (has('cex_price')) {
    if (data.cex_price === null) clean.cex_price = null;
    else if (!Number.isInteger(data.cex_price) || data.cex_price <= 0) problems.push('cex_price must be an integer number of pence > 0, or null');
    else clean.cex_price = data.cex_price;
  } else if (!partial) clean.cex_price = null;

  if (has('status')) {
    if (!STATUSES.includes(data.status)) problems.push(`status must be one of: ${STATUSES.join(' | ')}`);
    else clean.status = data.status;
  } else if (!partial) clean.status = 'live';

  if (has('grade_note')) {
    if (data.grade_note === null) clean.grade_note = null;
    else if (typeof data.grade_note !== 'string' || data.grade_note.length > 300) problems.push('grade_note must be a string (max 300 chars) or null');
    else clean.grade_note = data.grade_note;
  } else if (!partial) clean.grade_note = null;

  if (has('in_box')) {
    if (
      !Array.isArray(data.in_box) || data.in_box.length > 20 ||
      data.in_box.some((s) => typeof s !== 'string' || !s.trim() || s.length > 80)
    ) problems.push('in_box must be an array of up to 20 non-empty strings (max 80 chars each)');
    else clean.in_box = data.in_box.map((s) => s.trim());
  } else if (!partial) clean.in_box = [];

  for (const k of ['video_url', 'stripe_link']) {
    if (has(k)) {
      if (data[k] === null || data[k] === '') clean[k] = null;
      else if (typeof data[k] !== 'string' || data[k].length > 500 || !URLISH_RE.test(data[k])) problems.push(`${k} must be an http(s) URL (max 500 chars) or null`);
      else clean[k] = data[k];
    } else if (!partial) clean[k] = null;
  }

  if (has('tested_date')) {
    if (data.tested_date === null || data.tested_date === '') clean.tested_date = null;
    else if (typeof data.tested_date !== 'string' || !DATE_RE.test(data.tested_date)) problems.push('tested_date must be "YYYY-MM-DD" or null');
    else clean.tested_date = data.tested_date;
  } else if (!partial) clean.tested_date = null;

  if (has('serial_last4')) {
    if (data.serial_last4 === null || data.serial_last4 === '') clean.serial_last4 = null;
    else if (typeof data.serial_last4 !== 'string' || data.serial_last4.length > 8) problems.push('serial_last4 must be a short string (max 8 chars) or null');
    else clean.serial_last4 = data.serial_last4;
  } else if (!partial) clean.serial_last4 = null;

  if (has('thumb_b64')) {
    if (data.thumb_b64 === null || data.thumb_b64 === '') clean.thumb_b64 = '';
    else if (!isValidImageDataUrl(data.thumb_b64)) problems.push('thumb_b64 must be a data:image/webp or data:image/jpeg base64 data-URL, max 1MB');
    else clean.thumb_b64 = data.thumb_b64;
  } else if (!partial) clean.thumb_b64 = '';

  if (problems.length) return { error: problems.join('; ') };
  return { clean };
}

/** Validate a media photo payload {b64,w,h,order}. Returns { clean } or { error }. */
export function validatePhoto(photo) {
  if (!photo || typeof photo !== 'object' || Array.isArray(photo)) {
    return { error: 'photo must be an object {b64, w, h, order}' };
  }
  const { b64, w, h, order } = photo;
  if (!isValidImageDataUrl(b64)) {
    return { error: 'photo.b64 must be a data:image/webp or data:image/jpeg base64 data-URL, max 1MB' };
  }
  if (!Number.isInteger(w) || w <= 0 || w > 10000 || !Number.isInteger(h) || h <= 0 || h > 10000) {
    return { error: 'photo.w and photo.h must be positive integers' };
  }
  if (!Number.isInteger(order) || order < 0 || order > 99) {
    return { error: 'photo.order must be an integer between 0 and 99' };
  }
  return { clean: { b64, w, h, order } };
}

/** Server-generated slug id, e.g. "playstation-5-slim-disc-a1b2". */
export function makeStockId(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '') || 'unit';
  return `${slug}-${crypto.randomBytes(2).toString('hex')}`;
}

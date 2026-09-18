// Raw-body validation for Vercel account webhooks.  Vercel signs the exact
// request bytes with HMAC-SHA1, so callers must set `api.bodyParser: false` on
// their Function and pass this reader the original request stream.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const VERCEL_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

function bodyTooLargeError() {
  const error = new Error('Vercel webhook body is too large');
  error.code = 'VERCEL_WEBHOOK_BODY_TOO_LARGE';
  return error;
}

function rawBodyFromValue(value, maxBytes) {
  if (value == null) return null;
  const rawBody = Buffer.isBuffer(value)
    ? value.toString('utf8')
    : typeof value === 'string'
      ? value
      // The object fallback is for direct handler tests and compatible
      // runtimes only. Production body parsing remains disabled.
      : typeof value === 'object' && !Array.isArray(value)
        ? JSON.stringify(value)
        : null;
  if (rawBody != null && Buffer.byteLength(rawBody, 'utf8') > maxBytes) throw bodyTooLargeError();
  return rawBody;
}

export function parseVercelWebhookPayload(value, { maxBytes = VERCEL_WEBHOOK_MAX_BODY_BYTES } = {}) {
  const rawBody = rawBodyFromValue(value, maxBytes);
  if (rawBody == null) return null;
  try {
    const payload = JSON.parse(rawBody);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    return { rawBody, payload };
  } catch {
    return null;
  }
}

export async function readVercelWebhookPayload(req, { maxBytes = VERCEL_WEBHOOK_MAX_BODY_BYTES } = {}) {
  const fromBody = parseVercelWebhookPayload(req?.body, { maxBytes });
  if (fromBody) return fromBody;
  if (!req || typeof req[Symbol.asyncIterator] !== 'function') return null;
  const chunks = [];
  let bytes = 0;
  for await (const value of req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
    bytes += chunk.length;
    if (bytes > maxBytes) throw bodyTooLargeError();
    chunks.push(chunk);
  }
  return parseVercelWebhookPayload(Buffer.concat(chunks), { maxBytes });
}

export function vercelWebhookSignature(headers = {}) {
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() !== 'x-vercel-signature') continue;
    return typeof value === 'string' ? value : null;
  }
  return null;
}

export function isValidVercelWebhookSignature({ rawBody, signature, secret } = {}) {
  if (typeof rawBody !== 'string' || !rawBody || typeof signature !== 'string' || !signature || typeof secret !== 'string' || !secret) return false;
  const expected = createHmac('sha1', secret).update(rawBody, 'utf8').digest('hex');
  if (signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expected, 'utf8'));
}

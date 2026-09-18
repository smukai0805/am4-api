// Notion webhook verification is intentionally isolated from the API route so
// the signed raw body is handled consistently in production and tests.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const NOTION_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

function bodyTooLargeError() {
  const error = new Error('Notion webhook body is too large');
  error.code = 'NOTION_WEBHOOK_BODY_TOO_LARGE';
  return error;
}

function rawBodyFromValue(value, maxBytes) {
  if (value == null) return null;
  const rawBody = Buffer.isBuffer(value)
    ? value.toString('utf8')
    : typeof value === 'string'
      ? value
      // Vercel's body parser is disabled for this route in production. This
      // object fallback keeps direct handler tests and compatible hosts safe.
      : typeof value === 'object' && !Array.isArray(value)
        ? JSON.stringify(value)
        : null;
  if (rawBody != null && Buffer.byteLength(rawBody, 'utf8') > maxBytes) throw bodyTooLargeError();
  return rawBody;
}

export function parseNotionWebhookPayload(value, { maxBytes = NOTION_WEBHOOK_MAX_BODY_BYTES } = {}) {
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

// With api.bodyParser disabled this consumes the original request stream, which
// is essential: serializing a parsed JSON body can change the signed bytes.
export async function readNotionWebhookPayload(req, { maxBytes = NOTION_WEBHOOK_MAX_BODY_BYTES } = {}) {
  const fromBody = parseNotionWebhookPayload(req?.body, { maxBytes });
  if (fromBody) return fromBody;
  if (!req || typeof req[Symbol.asyncIterator] !== 'function') return null;

  const chunks = [];
  let byteLength = 0;
  for await (const value of req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
    byteLength += chunk.length;
    if (byteLength > maxBytes) throw bodyTooLargeError();
    chunks.push(chunk);
  }
  return parseNotionWebhookPayload(Buffer.concat(chunks), { maxBytes });
}

export function notionWebhookSignature(headers = {}) {
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() !== 'x-notion-signature') continue;
    return typeof value === 'string' ? value : null;
  }
  return null;
}

export function isValidNotionWebhookSignature({ rawBody, signature, verificationToken } = {}) {
  if (typeof rawBody !== 'string' || !rawBody || typeof signature !== 'string' || !signature || typeof verificationToken !== 'string' || !verificationToken) {
    return false;
  }
  const expected = `sha256=${createHmac('sha256', verificationToken).update(rawBody, 'utf8').digest('hex')}`;
  if (signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expected, 'utf8'));
}

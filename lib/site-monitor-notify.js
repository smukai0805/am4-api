// Operator notification transport. Durable alert state lives in the monitor
// store; this module only delivers a compact, non-secret notice to the fixed
// Notion API origin. Generic operator-configured webhook URLs are deliberately
// unsupported: accepting an arbitrary URL would make the monitor an SSRF
// primitive (including through DNS rebinding).

const NOTION_API_VERSION = '2026-03-11';
const NOTION_RICH_TEXT_LIMIT = 1_500;

function safeNotionPageId(value) {
  const compact = String(value || '').trim().replace(/-/gu, '').toLowerCase();
  return /^[0-9a-f]{32}$/u.test(compact) ? compact : null;
}

function compactMessage(value) {
  // Alert messages are deliberately controlled by monitor code. Keep a
  // second boundary here nevertheless: never send raw metadata, headers, or
  // multiline values to an operator-facing system.
  return String(value || 'AM4の自動監査で状態が変化しました。')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim()
    .slice(0, NOTION_RICH_TEXT_LIMIT);
}

function notificationText(alert) {
  const outcome = alert?.status === 'resolved' ? '修復完了' : '要確認';
  return compactMessage(`【AM4 自動監査】${outcome}｜${compactMessage(alert?.message)}`);
}

async function appendNotionAuditAlert(alert, pageId, apiKey, fetcher) {
  // Appending blocks is non-idempotent. The durable monitor state deduplicates
  // status transitions, and this transport intentionally does not retry an
  // ambiguous timeout or 5xx response that could create a duplicate record.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetcher(`https://api.notion.com/v1/blocks/${pageId}/children`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Notion-Version': NOTION_API_VERSION,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        children: [{
          object: 'block',
          type: 'bulleted_list_item',
          bulleted_list_item: {
            rich_text: [{ type: 'text', text: { content: notificationText(alert) } }],
          },
        }],
      }),
      signal: controller.signal,
    });
    if (response.ok) return { state: 'delivered', channel: 'notion_audit', status: response.status };
    // A Notion 429 definitively means no block was appended, so one durable
    // delayed retry is safe. Do not retry timeouts or 5xx responses because
    // an append may already have committed before the connection failed.
    const retryAfterSeconds = Number(response.headers?.get?.('Retry-After'));
    return {
      state: 'failed', channel: 'notion_audit', status: response.status,
      ...(response.status === 429 ? {
        retryable: true,
        retryAfterMs: Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? Math.min(15 * 60_000, Math.ceil(retryAfterSeconds * 1_000))
          : 60_000,
      } : {}),
    };
  } catch (error) {
    return {
      state: 'failed', channel: 'notion_audit',
      errorCode: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'request_failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function deliverSiteMonitorAlert(alert, {
  notionAuditPageId = process.env.SITE_MONITOR_NOTION_AUDIT_PAGE_ID,
  notionApiKey = process.env.NOTION_API_KEY,
  fetcher = fetch,
} = {}) {
  const pageId = safeNotionPageId(notionAuditPageId);
  if (!pageId || !String(notionApiKey || '').trim()) return { state: 'unconfigured' };
  const delivery = await appendNotionAuditAlert(alert, pageId, notionApiKey, fetcher);
  if (delivery.state === 'delivered') {
    return {
      state: 'delivered',
      deliveries: [{ channel: delivery.channel, status: delivery.status }],
    };
  }
  return {
    state: 'failed',
    ...(delivery.status ? { status: delivery.status } : {}),
    ...(delivery.retryable === true ? {
      retryable: true,
      retryAfterMs: delivery.retryAfterMs || 60_000,
    } : {}),
    deliveries: [{ channel: delivery.channel, status: delivery.status || null }],
  };
}

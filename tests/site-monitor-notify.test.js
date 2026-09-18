import assert from 'node:assert/strict';
import test from 'node:test';

import { deliverSiteMonitorAlert } from '../lib/site-monitor-notify.js';

test('notification ignores arbitrary webhook URLs and never fetches an untrusted origin', async () => {
  let calls = 0;
  const result = await deliverSiteMonitorAlert({ key: 'x', metadata: { secret: 'must-not-send' } }, {
    // This legacy option is intentionally ignored. Alert delivery supports
    // only the fixed Notion API origin, so neither private URLs nor a
    // DNS-rebound public hostname can become an SSRF target.
    endpoint: 'https://attacker.example/monitor',
    fetcher: async () => {
      calls += 1;
      return new Response('{}', { status: 200 });
    },
  });
  assert.deepEqual(result, { state: 'unconfigured' });
  assert.equal(calls, 0);
});

test('notification appends one compact, non-secret event to a configured Notion audit page', async () => {
  let request = null;
  const result = await deliverSiteMonitorAlert({
    key: 'report-repair:1570391:version',
    category: 'repair_success',
    status: 'resolved',
    message: 'AM4は試合解説を修復し、本番の実ブラウザー検査まで完了しました。',
    metadata: { token: 'must-not-send', body: 'must-not-send' },
  }, {
    endpoint: '',
    notionAuditPageId: '3dbb49a3-67ef-81ab-a08e-f543a6909ac1',
    notionApiKey: 'notion-secret',
    fetcher: async (url, init) => {
      request = { url: String(url), init, body: JSON.parse(init.body) };
      return new Response('{"results":[]}', { status: 200 });
    },
  });
  assert.deepEqual(result, {
    state: 'delivered',
    deliveries: [{ channel: 'notion_audit', status: 200 }],
  });
  assert.equal(request.url, 'https://api.notion.com/v1/blocks/3dbb49a367ef81aba08ef543a6909ac1/children');
  assert.equal(request.init.method, 'PATCH');
  assert.equal(request.init.headers.Authorization, 'Bearer notion-secret');
  assert.equal(request.init.headers['Notion-Version'], '2026-03-11');
  const content = request.body.children[0].bulleted_list_item.rich_text[0].text.content;
  assert.match(content, /^【AM4 自動監査】修復完了｜/u);
  assert.ok(content.length <= 1_500);
  assert.equal(JSON.stringify(request.body).includes('must-not-send'), false);
});

test('notification never calls Notion for an invalid audit page identifier', async () => {
  let calls = 0;
  const result = await deliverSiteMonitorAlert({ key: 'x' }, {
    endpoint: '',
    notionAuditPageId: 'https://attacker.example/notion',
    notionApiKey: 'notion-secret',
    fetcher: async () => {
      calls += 1;
      return new Response('{}', { status: 200 });
    },
  });
  assert.deepEqual(result, { state: 'unconfigured' });
  assert.equal(calls, 0);
});

test('Notion audit append failure is recorded without retrying the non-idempotent write', async () => {
  let calls = 0;
  const result = await deliverSiteMonitorAlert({ key: 'x', message: '修復完了' }, {
    endpoint: '',
    notionAuditPageId: '3dbb49a367ef81aba08ef543a6909ac1',
    notionApiKey: 'notion-secret',
    fetcher: async () => {
      calls += 1;
      return new Response('{}', { status: 429 });
    },
  });
  assert.deepEqual(result, {
    state: 'failed',
    status: 429,
    retryable: true,
    retryAfterMs: 60_000,
    deliveries: [{ channel: 'notion_audit', status: 429 }],
  });
  assert.equal(calls, 1);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectNotionChanges,
  collectNotionSourcePages,
  createNotionClient,
  notionMarkdownToBlocks,
  publishGeneratedMatchPrediction,
  publishGeneratedMatchReport,
  syncNotionPage,
} from '../lib/notion-content-sync.js';
import { compactArticleIndexEntry } from '../lib/sync-article-store.js';

function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function notionPage({ version = '2026-09-14T00:00:00.000Z', sourceId = 'source-pred', state = '公開済' } = {}) {
  return {
    id: 'page-1', url: 'https://www.notion.so/page-1',
    parent: { type: 'data_source_id', data_source_id: sourceId },
    last_edited_time: version,
    properties: {
      記事タイトル: { type: 'title', title: [{ plain_text: '監視対象記事' }] },
      記事状態: { type: 'select', select: { name: state } },
      'Match Key': { type: 'rich_text', rich_text: [{ plain_text: 'Premier League|2026-09-15|Arsenal|Chelsea' }] },
      大会: { type: 'select', select: { name: 'Premier League' } },
      ホーム: { type: 'rich_text', rich_text: [{ plain_text: 'Arsenal' }] },
      アウェイ: { type: 'rich_text', rich_text: [{ plain_text: 'Chelsea' }] },
      試合日: { type: 'date', date: { start: '2026-09-15' } },
    },
  };
}

function paragraph(text) {
  return {
    id: 'block-1', type: 'paragraph', has_children: false,
    paragraph: { rich_text: [{ plain_text: text }] },
  };
}

test('Notion 429 returns its Retry-After as a durable deferral signal without an early in-function retry', async () => {
  let calls = 0;
  const client = createNotionClient({
    apiKey: 'notion-token',
    requestTimeoutMs: 1_000,
    fetcher: async () => {
      calls += 1;
      return new Response('', { status: 429, headers: { 'Retry-After': '17' } });
    },
    sleep: async () => { throw new Error('429 must defer instead of sleeping/retrying in this request'); },
  });
  await assert.rejects(
    () => client.getPage('page-1'),
    (error) => error?.code === 'NOTION_RATE_LIMITED' && error?.retryAfterMs === 17_000,
  );
  assert.equal(calls, 1);
});

test('Notion 5xx retries a finite number of times with bounded backoff before accepting a valid response', async () => {
  const waits = [];
  let calls = 0;
  const client = createNotionClient({
    apiKey: 'notion-token', requestTimeoutMs: 1_000, maxAttempts: 3,
    sleep: async (ms) => { waits.push(ms); },
    fetcher: async () => {
      calls += 1;
      if (calls < 3) return new Response('', { status: 503 });
      return response({ id: 'page-1' });
    },
  });
  const page = await client.getPage('page-1');
  assert.equal(page.id, 'page-1');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [500, 1_000]);
});

test('creating a Notion page never retries an ambiguous 5xx POST', async () => {
  let calls = 0;
  const client = createNotionClient({
    apiKey: 'notion-token', maxAttempts: 3,
    fetcher: async () => {
      calls += 1;
      return new Response('', { status: 503 });
    },
    sleep: async () => { throw new Error('createPage must not retry an ambiguous write'); },
  });
  await assert.rejects(
    () => client.createPage({ parent: { type: 'data_source_id', data_source_id: 'source-report' }, properties: {} }),
    (error) => error?.code === 'NOTION_HTTP_ERROR' && error?.status === 503,
  );
  assert.equal(calls, 1);
});

test('the Notion reader follows deeply nested child blocks through the final body marker', async () => {
  const children = new Map([
    ['page-1', [{ id: 'depth-1', type: 'toggle', has_children: true, toggle: { rich_text: [{ plain_text: 'depth 1' }] } }]],
    ['depth-1', [{ id: 'depth-2', type: 'toggle', has_children: true, toggle: { rich_text: [{ plain_text: 'depth 2' }] } }]],
    ['depth-2', [{ id: 'depth-3', type: 'toggle', has_children: true, toggle: { rich_text: [{ plain_text: 'depth 3' }] } }]],
    ['depth-3', [{ id: 'depth-4', type: 'toggle', has_children: true, toggle: { rich_text: [{ plain_text: 'depth 4' }] } }]],
    ['depth-4', [{ id: 'tail', type: 'paragraph', has_children: false, paragraph: { rich_text: [{ plain_text: '本文の最終マーカー。' }] } }]],
  ]);
  const client = createNotionClient({
    apiKey: 'notion-token',
    fetcher: async (url) => {
      const match = String(url).match(/\/blocks\/([^/]+)\/children/u);
      if (!match) throw new Error(`Unexpected URL ${url}`);
      return response({ results: children.get(match[1]) || [], has_more: false });
    },
  });
  const markdown = await client.pageMarkdown('page-1');
  assert.match(markdown, /depth 4/);
  assert.match(markdown, /本文の最終マーカー。/);
});

test('generated match reports use only the validated source schema and preserve the complete body in flat blocks', async () => {
  let payload = null;
  const schema = {
    記事タイトル: { type: 'title', title: {} },
    記事状態: { type: 'select', select: { options: [{ name: '自動生成' }, { name: '公開準備' }] } },
    'Match Key': { type: 'rich_text', rich_text: {} },
    試合日: { type: 'date', date: {} },
    大会: { type: 'select', select: { options: [{ name: 'Premier League' }] } },
    ホーム: { type: 'rich_text', rich_text: {} },
    アウェイ: { type: 'rich_text', rich_text: {} },
    'Fixture ID': { type: 'number', number: {} },
    生成日時: { type: 'date', date: {} },
  };
  const result = await publishGeneratedMatchReport({
    match: {
      fixtureId: 1550125, date: '2026-09-16', kickoff: '2026-09-16T18:45:00Z', timezone: 'UTC',
      competition: 'Premier League', homeTeam: 'Arsenal', awayTeam: 'Chelsea',
      homeTeamId: 42, awayTeamId: 49, homeGoals: 2, awayGoals: 1,
    },
    draft: '# 試合解説\nArsenal 2-1 Chelsea の本文末尾マーカー。',
    sources: [{ title: 'Official match centre', url: 'https://example.com/match' }],
    now: () => new Date('2026-09-17T00:00:00.000Z'),
    client: {
      sourceProperties: async () => schema,
      createPage: async (value) => {
        payload = value;
        return { id: 'generated-page', created_time: '2026-09-17T00:00:00.000Z' };
      },
    },
  });
  assert.equal(result.page.id, 'generated-page');
  assert.equal(payload.parent.data_source_id, 'd9c69a0d-7471-4624-a697-56d7d43ec2b8');
  assert.equal(payload.properties.記事状態.select.name, '自動生成');
  assert.equal(payload.properties['Fixture ID'].number, 1550125);
  assert.equal(payload.properties['Match Key'].rich_text[0].text.content, 'Premier League|2026-09-16|Arsenal|Chelsea');
  assert.ok(payload.children.some((block) => block.heading_1?.rich_text?.[0]?.text?.content === '試合解説'));
  assert.ok(payload.children.some((block) => block.paragraph?.rich_text?.[0]?.text?.content.includes('本文末尾マーカー。')));
  assert.ok(payload.children.some((block) => block.bulleted_list_item?.rich_text?.[0]?.text?.content.includes('Official match centre')));
  assert.equal(notionMarkdownToBlocks('## 見出し\n本文末尾').length, 2);
});

test('generated match predictions use the prediction source schema and retain structured score metadata', async () => {
  let payload = null;
  const schema = {
    記事タイトル: { type: 'title', title: {} },
    記事状態: { type: 'select', select: { options: [{ name: '自動生成' }, { name: '公開準備' }] } },
    'Match Key': { type: 'rich_text', rich_text: {} },
    試合日: { type: 'date', date: {} },
    大会: { type: 'select', select: { options: [{ name: 'Premier League' }] } },
    ホーム: { type: 'rich_text', rich_text: {} },
    アウェイ: { type: 'rich_text', rich_text: {} },
    'Fixture ID': { type: 'number', number: {} },
    予想スコア: { type: 'rich_text', rich_text: {} },
    本命: { type: 'rich_text', rich_text: {} },
    確信度: { type: 'number', number: {} },
    生成日時: { type: 'date', date: {} },
  };
  const result = await publishGeneratedMatchPrediction({
    match: {
      fixtureId: 1557409, date: '2026-09-19', kickoff: '2026-09-19T14:00:00Z', timezone: 'UTC',
      competition: 'Premier League', homeTeam: 'Brighton', awayTeam: 'Arsenal',
      homeTeamId: 51, awayTeamId: 42,
    },
    prediction: { score: '1-2', pick: 'Arsenal', confidence: 64 },
    draft: '# 3行要約\nBrightonとArsenalの本文末尾マーカー。\n\n## 予想の根拠\n検証済みの直近結果だけを使う。',
    sources: [{ title: 'Contract fixture data', url: 'https://example.com/fixture' }],
    now: () => new Date('2026-09-18T00:00:00.000Z'),
    client: {
      sourceProperties: async () => schema,
      createPage: async (value) => {
        payload = value;
        return { id: 'generated-prediction-page', created_time: '2026-09-18T00:00:00.000Z' };
      },
    },
  });
  assert.equal(result.page.id, 'generated-prediction-page');
  assert.equal(payload.parent.data_source_id, 'b4743ad8-9ca9-462c-b90d-406e3e0a0c4b');
  assert.equal(payload.properties.記事状態.select.name, '自動生成');
  assert.equal(payload.properties['Fixture ID'].number, 1557409);
  assert.equal(payload.properties.予想スコア.rich_text[0].text.content, '1-2');
  assert.equal(payload.properties.本命.rich_text[0].text.content, 'Arsenal');
  assert.equal(payload.properties.確信度.number, 64);
  assert.ok(payload.children.some((block) => block.paragraph?.rich_text?.[0]?.text?.content.includes('本文末尾マーカー。')));
});

test('the durable usage gate counts each nested Notion HTTP attempt and prevents the next request at its cap', async () => {
  let reservations = 0;
  let fetches = 0;
  const client = createNotionClient({
    apiKey: 'notion-token',
    consumeRequest: async () => {
      reservations += 1;
      return reservations <= 2 ? { ok: true } : { ok: false, exceeded: 'apiCallsPerRun' };
    },
    fetcher: async (url) => {
      fetches += 1;
      if (url.includes('/blocks/page-1/children')) {
        return response({
          results: [{ ...paragraph('親ブロック'), id: 'nested-1', has_children: true }],
          has_more: false,
        });
      }
      if (url.includes('/blocks/nested-1/children')) {
        return response({ results: [paragraph('子ブロック')], has_more: true, next_cursor: 'next-page' });
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  await assert.rejects(
    () => client.pageMarkdown('page-1'),
    (error) => error?.code === 'NOTION_USAGE_LIMIT' && error?.details?.exceeded === 'apiCallsPerRun',
  );
  assert.equal(fetches, 2);
  assert.equal(reservations, 3); // root, nested first page, then blocked nested continuation
});

test('a collection cap preserves unfinished source checkpoints instead of issuing another source query', async () => {
  let fetches = 0;
  const result = await collectNotionChanges({
    apiKey: 'notion-token',
    sourceIds: { match_prediction: 'source-pred', match_report: 'source-report' },
    types: ['match_prediction', 'match_report'],
    consumeRequest: async () => ({ ok: false, exceeded: 'apiCallsPerRun' }),
    fetcher: async () => { fetches += 1; return response({ results: [], has_more: false }); },
  });
  assert.equal(fetches, 0);
  // Source definitions are deterministic and report is collected first; the
  // cap prevents that first request and never advances to prediction.
  assert.equal(result.errors.match_report, 'quota_exceeded');
  assert.equal(result.errors.match_prediction, undefined);
  assert.equal(result.quotaExceeded.exceeded, 'apiCallsPerRun');
  assert.deepEqual(result.sources, {});
});

test('the collector preserves a persisted Notion Retry-After window instead of querying that source early', async () => {
  const result = await collectNotionChanges({
    apiKey: 'notion-token', sourceIds: { match_prediction: 'source-pred' },
    types: ['match_prediction'], observedAt: '2026-09-14T00:00:00.000Z',
    notBeforeBySource: { match_prediction: '2026-09-14T00:00:17.000Z' },
    fetcher: async () => { throw new Error('the source must remain deferred'); },
  });
  assert.equal(result.errors.match_prediction, undefined);
  assert.equal(result.sources.match_prediction, undefined);
  assert.equal(result.deferred.match_prediction, '2026-09-14T00:00:17.000Z');
});

test('collectNotionChanges pages every changed source with an overlapping last-edited-time boundary', async () => {
  let requestBody = null;
  const result = await collectNotionChanges({
    apiKey: 'notion-token', sourceIds: { match_prediction: 'source-pred' },
    types: ['match_prediction'],
    checkpoints: { match_prediction: { watermark: '2026-09-14T00:00:00.000Z' } },
    overlapMs: 120_000,
    observedAt: '2026-09-14T01:00:00.000Z',
    fetcher: async (url, init) => {
      assert.match(url, /data_sources\/source-pred\/query$/);
      requestBody = JSON.parse(init.body);
      return response({ results: [notionPage()], has_more: false, next_cursor: null });
    },
  });
  assert.equal(requestBody.filter.timestamp, 'last_edited_time');
  assert.equal(requestBody.filter.last_edited_time.on_or_after, '2026-09-13T23:58:00.000Z');
  assert.equal(result.errors.match_prediction, undefined);
  assert.equal(result.sources.match_prediction.pages.length, 1);
  assert.equal(result.sources.match_prediction.watermark, '2026-09-14T00:00:00.000Z');
});

test('a full source collector exposes each persisted Notion page cursor and resumes from it', async () => {
  const cursors = [];
  const first = await collectNotionSourcePages({
    apiKey: 'notion-token', sourceIds: { match_report: 'source-report' }, types: ['match_report'],
    fetcher: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.start_cursor, undefined);
      return response({ results: [notionPage({ sourceId: 'source-report' })], has_more: true, next_cursor: 'cursor-2' });
    },
    onPage: async ({ nextCursor, complete }) => {
      cursors.push([nextCursor, complete]);
      // Simulate a durable caller stopping after it has stored this cursor.
      throw Object.assign(new Error('stop after durable page'), { code: 'STOP' });
    },
  });
  assert.equal(first.errors.match_report, 'unavailable');
  assert.deepEqual(cursors, [['cursor-2', false]]);

  let resumedCursor = null;
  const resumed = await collectNotionSourcePages({
    apiKey: 'notion-token', sourceIds: { match_report: 'source-report' }, types: ['match_report'],
    cursors: { match_report: { cursor: 'cursor-2' } },
    fetcher: async (_url, init) => {
      const body = JSON.parse(init.body);
      resumedCursor = body.start_cursor;
      return response({ results: [notionPage({ sourceId: 'source-report', version: '2026-09-14T01:00:00.000Z' })], has_more: false, next_cursor: null });
    },
  });
  assert.equal(resumedCursor, 'cursor-2');
  assert.equal(resumed.sources.match_report.complete, true);
  assert.equal(resumed.sources.match_report.pages.length, 1);
});

test('a streaming full source collector retains cursors, not the full source in memory', async () => {
  const delivered = [];
  const result = await collectNotionSourcePages({
    apiKey: 'notion-token', sourceIds: { match_report: 'source-report' }, types: ['match_report'],
    fetcher: async () => response({
      results: [notionPage({ sourceId: 'source-report' }), notionPage({ sourceId: 'source-report', version: '2026-09-14T01:00:00.000Z' })],
      has_more: false, next_cursor: null,
    }),
    onPage: async ({ pages, complete }) => delivered.push({ count: pages.length, complete }),
  });
  assert.deepEqual(delivered, [{ count: 2, complete: true }]);
  assert.equal(result.sources.match_report.pageCount, 2);
  assert.deepEqual(result.sources.match_report.pages, []);
});

test('a streaming Notion client does not aggregate query results behind the callback', async () => {
  let requestCount = 0;
  const client = createNotionClient({
    apiKey: 'notion-token',
    fetcher: async () => {
      requestCount += 1;
      return requestCount === 1
        ? response({ results: [notionPage()], has_more: true, next_cursor: 'cursor-2' })
        : response({ results: [notionPage({ version: '2026-09-14T01:00:00.000Z' })], has_more: false, next_cursor: null });
    },
  });
  const streamed = [];
  const aggregate = await client.queryPages('source-report', {
    onPage: async ({ results, complete }) => streamed.push({ count: results.length, complete }),
  });
  assert.equal(requestCount, 2);
  assert.deepEqual(streamed, [{ count: 1, complete: false }, { count: 1, complete: true }]);
  assert.deepEqual(aggregate, []);
});

test('the delta collector reuses a durable cursor and its original overlap filter after an interrupted page', async () => {
  let saved = null;
  const first = await collectNotionChanges({
    apiKey: 'notion-token', sourceIds: { match_report: 'source-report' }, types: ['match_report'],
    checkpoints: { match_report: { watermark: '2026-09-14T00:00:00.000Z' } },
    fetcher: async () => response({ results: [notionPage({ sourceId: 'source-report' })], has_more: true, next_cursor: 'delta-cursor' }),
    onPage: async (progress) => {
      saved = { cursor: progress.nextCursor, since: progress.since };
      throw new Error('stop after durable delta page');
    },
  });
  assert.equal(first.errors.match_report, 'unavailable');
  assert.equal(saved.cursor, 'delta-cursor');
  assert.equal(saved.since, '2026-09-13T23:58:00.000Z');

  let body = null;
  const resumed = await collectNotionChanges({
    apiKey: 'notion-token', sourceIds: { match_report: 'source-report' }, types: ['match_report'],
    checkpoints: { match_report: { watermark: '2026-09-14T00:00:00.000Z' } },
    cursors: { match_report: saved },
    fetcher: async (_url, init) => {
      body = JSON.parse(init.body);
      return response({ results: [notionPage({ sourceId: 'source-report', version: '2026-09-14T01:00:00.000Z' })], has_more: false });
    },
  });
  assert.equal(body.start_cursor, 'delta-cursor');
  assert.equal(body.filter.last_edited_time.on_or_after, saved.since);
  assert.equal(resumed.sources.match_report.pages.length, 1);
});

test('syncNotionPage shares normalisation and rejects a changed version before persistent write', async () => {
  const page = notionPage();
  let pageReads = 0;
  const writes = [];
  const store = {
    async getArticle() { return null; },
    async saveArticle(article) { writes.push(article); },
  };
  const result = await syncNotionPage({
    pageId: 'page-1', sourceType: 'match_prediction', expectedSourceVersion: page.last_edited_time,
    apiKey: 'notion-token', sourceIds: { match_prediction: 'source-pred' }, articleStore: store,
    hydratePredictionArticle: async (article) => ({
      ...article,
      prediction: { ...article.prediction, keyPlayerCards: [{ playerName: 'Known Player', reason: '理由', resolved: false }] },
    }),
    fetcher: async (url) => {
      if (url.endsWith('/pages/page-1')) {
        pageReads += 1;
        return response(pageReads === 1 ? page : { ...page, last_edited_time: '2026-09-14T00:01:00.000Z' });
      }
      if (url.includes('/blocks/page-1/children')) return response({ results: [paragraph('本文の末尾マーカー。')], has_more: false });
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  assert.equal(result.outcome, 'source_changed');
  assert.equal(result.sourceVersion, '2026-09-14T00:01:00.000Z');
  assert.equal(writes.length, 0);
});

test('syncNotionPage keeps a failed monitor-created delivery private until the Notion source changes', async () => {
  const page = notionPage({ version: '2026-09-18T00:00:00.000Z' });
  const held = {
    id: 'notion-match_prediction-page-1', type: 'match_prediction', public: false,
    notion: { pageId: page.id, updatedAt: page.last_edited_time, state: '自動生成' },
    siteMonitor: {
      deliveryHold: { sourceVersion: page.last_edited_time, reason: 'browser_validation_failed' },
    },
  };
  const writes = [];
  let pageReads = 0;
  const result = await syncNotionPage({
    pageId: page.id, sourceType: 'match_prediction', expectedSourceVersion: page.last_edited_time,
    apiKey: 'notion-token', sourceIds: { match_prediction: 'source-pred' },
    articleStore: {
      async getArticle() { return held; },
      async saveArticle(article) { writes.push(article); },
    },
    fetcher: async (url) => {
      if (url.endsWith('/pages/page-1')) {
        pageReads += 1;
        return response(page);
      }
      throw new Error(`the held revision must not fetch blocks: ${url}`);
    },
  });
  assert.equal(result.outcome, 'monitor_delivery_hold');
  assert.equal(result.article, held);
  assert.equal(pageReads, 1);
  assert.equal(writes.length, 0);
});

test('the compact article index retains only the monitor delivery hold needed by a full source scan', () => {
  const compact = compactArticleIndexEntry({
    id: 'notion-match_prediction-page-1', type: 'match_prediction', public: false,
    siteMonitor: {
      provisionalCreation: { sourceVersion: '2026-09-18T00:00:00.000Z', sourceJobId: 'source-job' },
      deliveryHold: { sourceVersion: '2026-09-18T00:00:00.000Z', sourceJobId: 'source-job', reason: 'browser_validation_failed' },
      ignoredSensitiveValue: 'must-not-copy',
    },
  });
  assert.deepEqual(compact.siteMonitor, {
    provisionalCreation: {
      sourceVersion: '2026-09-18T00:00:00.000Z', sourceJobId: 'source-job', reason: null,
    },
    deliveryHold: {
      sourceVersion: '2026-09-18T00:00:00.000Z', sourceJobId: 'source-job', reason: 'browser_validation_failed',
    },
  });
  assert.equal(JSON.stringify(compact.siteMonitor).includes('must-not-copy'), false);
});

test('syncNotionPage never hides a page that was republished before its guarded write', async () => {
  const archived = { ...notionPage({ version: '2026-09-14T00:00:00.000Z' }), archived: true };
  const republished = notionPage({ version: '2026-09-14T00:01:00.000Z' });
  const existing = {
    id: 'notion-match_prediction-page-1', type: 'match_prediction', public: true,
    notion: { pageId: 'page-1', updatedAt: archived.last_edited_time, state: '公開済' },
  };
  const writes = [];
  let pageReads = 0;
  const result = await syncNotionPage({
    pageId: 'page-1', sourceType: 'match_prediction', expectedSourceVersion: archived.last_edited_time,
    apiKey: 'notion-token', sourceIds: { match_prediction: 'source-pred' },
    articleStore: {
      async getArticle() { return existing; },
      async saveArticle(article) { writes.push(article); },
    },
    fetcher: async (url) => {
      if (url.endsWith('/pages/page-1')) {
        pageReads += 1;
        return response(pageReads === 1 ? archived : republished);
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  assert.equal(result.outcome, 'source_changed');
  assert.equal(result.sourceVersion, republished.last_edited_time);
  assert.equal(pageReads, 2);
  assert.equal(writes.length, 0);
});

test('syncNotionPage takes the same ownership/write guard before hiding an archived article', async () => {
  const archived = { ...notionPage(), archived: true };
  const existing = {
    id: 'notion-match_prediction-page-1', type: 'match_prediction', public: true,
    notion: { pageId: 'page-1', updatedAt: archived.last_edited_time, state: '公開済' },
  };
  const writes = [];
  const guardCalls = [];
  const result = await syncNotionPage({
    pageId: 'page-1', sourceType: 'match_prediction', expectedSourceVersion: archived.last_edited_time,
    apiKey: 'notion-token', sourceIds: { match_prediction: 'source-pred' },
    articleStore: {
      async getArticle() { return existing; },
      async saveArticle(article) { writes.push(article); },
    },
    beforeWrite: async (input) => { guardCalls.push(input); return false; },
    fetcher: async (url) => {
      if (url.endsWith('/pages/page-1')) return response(archived);
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  assert.equal(result.outcome, 'write_cancelled');
  assert.equal(guardCalls.length, 1);
  assert.equal(guardCalls[0].operation, 'hide');
  assert.equal(guardCalls[0].article.public, false);
  assert.equal(writes.length, 0);
});

test('syncNotionPage does not hide when the page is republished after its ownership guard but before save', async () => {
  const archived = { ...notionPage({ version: '2026-09-14T00:00:00.000Z' }), archived: true };
  const republished = notionPage({ version: '2026-09-14T00:01:00.000Z' });
  const existing = {
    id: 'notion-match_prediction-page-1', type: 'match_prediction', public: true,
    notion: { pageId: 'page-1', updatedAt: archived.last_edited_time, state: '公開済' },
  };
  const writes = [];
  let pageReads = 0;
  let guardCalls = 0;
  const result = await syncNotionPage({
    pageId: 'page-1', sourceType: 'match_prediction', expectedSourceVersion: archived.last_edited_time,
    apiKey: 'notion-token', sourceIds: { match_prediction: 'source-pred' },
    articleStore: {
      async getArticle() { return existing; },
      async saveArticle(article) { writes.push(article); },
    },
    beforeWrite: async () => { guardCalls += 1; return true; },
    fetcher: async (url) => {
      if (url.endsWith('/pages/page-1')) {
        pageReads += 1;
        return response(pageReads < 3 ? archived : republished);
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  assert.equal(result.outcome, 'source_changed');
  assert.equal(result.sourceVersion, republished.last_edited_time);
  assert.equal(pageReads, 3);
  assert.equal(guardCalls, 1);
  assert.equal(writes.length, 0);
});

test('an archived Notion page with no mirrored article is a no-op rather than a failed hide', async () => {
  const archived = { ...notionPage(), archived: true };
  const result = await syncNotionPage({
    pageId: 'page-1', sourceType: 'match_prediction', apiKey: 'notion-token',
    sourceIds: { match_prediction: 'source-pred' },
    articleStore: {
      async getArticle() { return null; },
      async saveArticle() { throw new Error('there is no mirror to hide'); },
    },
    fetcher: async (url) => {
      if (url.endsWith('/pages/page-1')) return response(archived);
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  assert.equal(result.outcome, 'non_public');
});

test('syncNotionPage writes a non-empty current body through the existing article store only for an owned source', async () => {
  const page = notionPage();
  const writes = [];
  const store = {
    async getArticle() { return null; },
    async saveArticle(article) { writes.push(article); },
  };
  const result = await syncNotionPage({
    pageId: 'page-1', apiKey: 'notion-token',
    sourceIds: { match_prediction: 'source-pred' }, articleStore: store,
    fetcher: async (url) => {
      if (url.endsWith('/pages/page-1')) return response(page);
      if (url.includes('/blocks/page-1/children')) return response({ results: [paragraph('本文の末尾マーカー。')], has_more: false });
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  assert.equal(result.outcome, 'created');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body, '本文の末尾マーカー。');
  assert.equal(writes[0].notion.pageId, 'page-1');

  const untrusted = await syncNotionPage({
    pageId: 'page-1', apiKey: 'notion-token', articleStore: store,
    sourceIds: { match_prediction: 'different-source' },
    fetcher: async () => response(page),
  });
  assert.equal(untrusted.outcome, 'untrusted_source');
  assert.equal(writes.length, 1);
});

test('syncNotionPage rebuilds the public index when an interrupted write left a verified article Blob ahead of it', async () => {
  const page = notionPage();
  const existing = {
    id: 'notion-match_prediction-page-1', type: 'match_prediction', status: 'published', public: true,
    title: '監視対象記事', body: '本文の末尾マーカー。',
    notion: { pageId: 'page-1', updatedAt: page.last_edited_time, state: '公開済' },
    match: { identityVersion: 2, fixtureId: null },
  };
  const writes = [];
  const store = {
    async getArticle() { return existing; },
    async hasIndexedArticle() { return false; },
    async saveArticle(article) { writes.push(article); },
    async flush() {},
  };
  let pageReads = 0;
  const result = await syncNotionPage({
    pageId: 'page-1', sourceType: 'match_prediction', apiKey: 'notion-token',
    sourceIds: { match_prediction: 'source-pred' }, articleStore: store,
    fetcher: async (url) => {
      if (url.endsWith('/pages/page-1')) {
        pageReads += 1;
        return response(page);
      }
      throw new Error(`A verified unchanged article must not reread its body: ${url}`);
    },
  });
  assert.equal(result.outcome, 'reindexed');
  assert.equal(pageReads, 2); // initial check + write-time version check
  assert.deepEqual(writes, [existing]);
});

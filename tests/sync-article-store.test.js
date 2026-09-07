import test from 'node:test';
import assert from 'node:assert/strict';
import { compactArticleIndexEntry, createSyncArticleStore } from '../lib/sync-article-store.js';

function streamJson(value) {
  return new Response(JSON.stringify(value)).body;
}

test('sync index metadata keeps list fields but drops long editorial bodies', () => {
  const bodySentinel = 'BODY-SENTINEL-' + 'x'.repeat(400);
  const article = {
    id: 'report-1',
    type: 'match_report',
    title: 'Arsenal vs Chelsea｜試合解説',
    publishedAt: '2026-09-08T00:00:00.000Z',
    status: 'published',
    public: true,
    body: bodySentinel,
    deck: '短い導入',
    summary: '短い要約',
    report: { tactics: 'REPORT-SENTINEL-' + 'y'.repeat(400) },
    prediction: { summary: 'PREDICTION-SENTINEL-' + 'z'.repeat(400) },
    match: {
      competition: 'Premier League',
      date: '2026-09-08',
      homeTeam: 'Arsenal',
      awayTeam: 'Chelsea',
    },
    notion: {
      pageId: 'page-1',
      pageUrl: 'https://notion.so/private-editor-url',
      updatedAt: '2026-09-08T00:00:00.000Z',
      state: '公開済',
    },
    tags: ['Premier League'],
  };

  const entry = compactArticleIndexEntry(article);
  assert.equal(entry.id, article.id);
  assert.equal(entry.match.homeTeam, 'Arsenal');
  assert.equal(entry.notion.pageId, 'page-1');
  assert.equal(entry.notion.updatedAt, '2026-09-08T00:00:00.000Z');
  assert.equal('pageUrl' in entry.notion, false);
  assert.equal('report' in entry, false);
  assert.equal('prediction' in entry, false);
  assert.equal('body' in entry, false);
  assert.equal(entry.popularRank, null);
  assert.match(entry.searchText, /arsenal/);
  assert.match(entry.searchText, /chelsea/);
  assert.match(entry.searchText, /premier league/);
  assert.doesNotMatch(entry.searchText, /body-sentinel|report-sentinel|prediction-sentinel/i);
});

test('scheduled sync uses bounded index reads, one index write, and preserves a concurrent article', async () => {
  const initialIndex = [{
    id: 'legacy-report',
    type: 'match_report',
    title: 'Legacy report',
    publishedAt: '2026-09-01T00:00:00.000Z',
    status: 'published',
    public: true,
    report: { tactics: 'legacy long field' },
    notion: { pageId: 'legacy-page', updatedAt: '2026-09-01T00:00:00.000Z' },
  }];
  const concurrentEntry = compactArticleIndexEntry({
    id: 'transfer-concurrent',
    type: 'transfer_news',
    title: 'Concurrent transfer',
    publishedAt: '2026-09-08T01:30:00.000Z',
    status: 'published',
    public: true,
    body: 'short transfer body',
  });
  const gets = [];
  const puts = [];
  let indexReadCount = 0;
  const blob = {
    get: async (pathname, options) => {
      gets.push({ pathname, options });
      if (pathname === 'articles/index.json') {
        indexReadCount += 1;
        const value = indexReadCount === 1 ? initialIndex : [...initialIndex, concurrentEntry];
        return { stream: streamJson(value) };
      }
      return null;
    },
    put: async (pathname, value, options) => {
      puts.push({ pathname, value: String(value), options });
      return { pathname };
    },
  };
  const store = createSyncArticleStore({ blob, logger: null });

  await store.listArticles({ page: 1, pageSize: 100, includeHidden: true });
  await store.listArticles({ page: 1, pageSize: 100, includeHidden: true });
  await store.saveArticle({
    id: 'report-a', type: 'match_report', title: 'A', publishedAt: '2026-09-08T01:00:00.000Z', status: 'published', public: true,
    body: 'A'.repeat(500), notion: { pageId: 'page-a', updatedAt: '2026-09-08T01:00:00.000Z' },
  });
  await store.saveArticle({
    id: 'report-b', type: 'match_report', title: 'B', publishedAt: '2026-09-08T02:00:00.000Z', status: 'published', public: true,
    body: 'B'.repeat(500), notion: { pageId: 'page-b', updatedAt: '2026-09-08T02:00:00.000Z' },
  });

  const stats = await store.flush();
  assert.equal(gets.filter((entry) => entry.pathname === 'articles/index.json').length, 2);
  assert.ok(gets.every((entry) => entry.options.useCache === false));
  assert.equal(puts.filter((entry) => entry.pathname === 'articles/index.json').length, 1);
  assert.equal(puts.filter((entry) => entry.pathname !== 'articles/index.json').length, 2);
  assert.equal(stats.indexReads, 2);
  assert.equal(stats.indexWrites, 1);
  assert.equal(stats.articleWrites, 2);
  assert.equal(stats.compactedEntries, 1);

  const indexWrite = puts.find((entry) => entry.pathname === 'articles/index.json');
  const storedIndex = JSON.parse(indexWrite.value);
  assert.equal(storedIndex.length, 4);
  assert.equal('report' in storedIndex.find((entry) => entry.id === 'legacy-report'), false);
  assert.equal('body' in storedIndex.find((entry) => entry.id === 'report-a'), false);
  assert.equal(storedIndex.some((entry) => entry.id === 'transfer-concurrent'), true);
});

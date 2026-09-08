const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../vercel.json');

const RETIRED_GENERATION_ROUTES = new Set([
  '/api/academy-debut-watch',
  '/api/match-report-watch',
  '/api/transfer-news-watch',
]);

const ACTIVE_CONTENT_CRONS = [
  { path: '/api/articles?trendingRefresh=1', schedule: '45 8 * * *' },
  { path: '/api/articles?notionSync=1', schedule: '30 0 * * *' },
  { path: '/api/articles?notionSync=1', schedule: '30 1 * * *' },
  { path: '/api/articles?notionSync=1', schedule: '30 2 * * *' },
  { path: '/api/articles?notionSync=1', schedule: '30 3 * * *' },
  { path: '/api/articles?notionSync=1', schedule: '30 4 * * *' },
  { path: '/api/articles?notionSync=1', schedule: '30 5 * * *' },
  { path: '/api/articles?notionSync=1', schedule: '30 6 * * *' },
  { path: '/api/articles?notionSync=1', schedule: '30 7 * * *' },
  { path: '/api/articles?notionSync=1', schedule: '30 8 * * *' },
  { path: '/api/articles?notionSync=1', schedule: '30 9 * * *' },
  { path: '/api/articles?notionSync=1', schedule: '30 10 * * *' },
  { path: '/api/articles?notionSync=1', schedule: '30 11 * * *' },
  { path: '/api/articles?notionSync=1', schedule: '30 12 * * *' },
  { path: '/api/articles?notionSync=1', schedule: '30 13 * * *' },
  { path: '/api/articles?notionSync=1', schedule: '30 14 * * *' },
  { path: '/api/articles?notionSync=1', schedule: '30 15 * * *' },
  { path: '/api/articles?notionSync=1', schedule: '30 16 * * *' },
  { path: '/api/articles?notionSync=1', schedule: '30 17 * * *' },
  { path: '/api/articles?notionSync=1', schedule: '30 18 * * *' },
  { path: '/api/articles?notionSync=1', schedule: '30 19 * * *' },
  { path: '/api/articles?notionSync=1', schedule: '30 20 * * *' },
  { path: '/api/articles?notionSync=1', schedule: '30 21 * * *' },
  { path: '/api/articles?notionSync=1', schedule: '30 22 * * *' },
  { path: '/api/articles?notionSync=1', schedule: '30 23 * * *' },
];

test('retired AI generation routes are not scheduled', () => {
  const scheduledPaths = (config.crons || []).map(({ path }) => path);

  for (const path of scheduledPaths) {
    assert.equal(RETIRED_GENERATION_ROUTES.has(path), false, `${path} must not be scheduled`);
  }
});

test('editorial sync and trending refresh schedules remain enabled', () => {
  assert.deepEqual(config.crons, ACTIVE_CONTENT_CRONS);
});

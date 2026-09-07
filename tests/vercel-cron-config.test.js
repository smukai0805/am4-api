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
  { path: '/api/articles?notionSync=1', schedule: '30 * * * *' },
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

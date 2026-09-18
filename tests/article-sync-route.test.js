import assert from 'node:assert/strict';
import test from 'node:test';

import {
  respondWithContentAvailability,
  respondWithMatchContent,
} from '../api/articles.js';

function response() {
  return {
    headers: new Map(), statusCode: null, body: undefined,
    setHeader(key, value) { this.headers.set(key.toLowerCase(), value); },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

test('an index read failure is a retryable availability failure, never a false no-label response', async () => {
  const res = response();
  let options = null;
  await respondWithContentAvailability({
    query: {
      fixtureIds: '123',
      matchKeys: 'Premier League|2026-09-15|Arsenal|Chelsea',
    },
  }, res, {
    logger: { error() {} },
    getAvailability: async (_fixtureIds, _matchKeys, input) => {
      options = input;
      throw new Error('index temporarily unavailable');
    },
  });
  assert.equal(res.statusCode, 500);
  assert.equal(options.throwOnError, true);
  assert.equal(res.body.availability, undefined);
});

function fixtureEditorial({ id, type, fixtureId = 1570376 } = {}) {
  return {
    id,
    type,
    title: `${type} title`,
    status: 'published',
    public: true,
    contentKind: `notion_${type}`,
    match: {
      fixtureId,
      competition: 'Premier League',
      date: '2026-09-13',
      homeTeam: 'Arsenal',
      awayTeam: 'Chelsea',
      matchKey: 'Premier League|2026-09-13|Arsenal|Chelsea',
    },
    body: `full ${type} body`,
  };
}

test('the compatibility match-content route reads only the persisted public archive', async () => {
  const fixtureId = 1570376;
  const prediction = fixtureEditorial({ id: 'prediction-1', type: 'match_prediction', fixtureId });
  const report = fixtureEditorial({ id: 'report-1', type: 'match_report', fixtureId });
  const listCalls = [];
  const readCalls = [];
  const res = response();

  await respondWithMatchContent({ query: { fixtureId: String(fixtureId) } }, res, {
    listPublicArticles: async (input) => {
      listCalls.push(input);
      return {
        items: input.type === 'match_prediction' ? [prediction] : [report],
        totalPages: 1,
      };
    },
    getArticleById: async (id, options) => {
      readCalls.push([id, options]);
      return id === prediction.id ? prediction : id === report.id ? report : null;
    },
    logger: { error() {}, warn() {} },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.body.prediction.id, prediction.id);
  assert.equal(res.body.report.id, report.id);
  assert.equal(res.body.partial, false);
  assert.deepEqual(res.body.errors, {});
  assert.deepEqual(listCalls.map((call) => call.type).sort(), ['match_prediction', 'match_report']);
  assert.ok(listCalls.every((call) => (
    call.fixtureId === fixtureId
    && call.publishedOnly === true
    && call.throwOnError === true
    && call.pageSize === 100
  )));
  assert.deepEqual(readCalls, [
    [prediction.id, { publishedOnly: true }],
    [report.id, { publishedOnly: true }],
  ]);
});

test('a split persisted archive is retryable rather than an empty match-content response', async () => {
  const fixtureId = 1570376;
  const prediction = fixtureEditorial({ id: 'prediction-1', type: 'match_prediction', fixtureId });
  const res = response();

  await respondWithMatchContent({ query: { fixtureId: String(fixtureId) } }, res, {
    listPublicArticles: async (input) => ({
      items: input.type === 'match_prediction' ? [prediction] : [],
      totalPages: 1,
    }),
    getArticleById: async () => null,
    logger: { error() {}, warn() {} },
  });

  assert.equal(res.statusCode, 503);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.body.error, '公開済み記事アーカイブを取得できませんでした');
  assert.equal('prediction' in res.body, false);
});

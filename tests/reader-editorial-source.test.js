import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { readArticle } = require('../article-load-state.js');

test('the match-detail reader never calls the private Notion bridge on page refresh', async () => {
  const source = await readFile(new URL('../match-detail.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /client\.matchContent\s*\(/u);
  assert.match(source, /fullEditorialArticle\s*\(/u);
});

test('an article mirror miss stays retryable and never asks the reader to query matchContent', async () => {
  const requests = [];
  const id = 'notion-match_report-3dab49a367ef81188b2cd573b7694c49';
  const result = await readArticle({
    apiBase: '/api',
    id,
    fixtureId: 1570376,
    fetcher: async (url) => {
      requests.push(url);
      return { ok: false, status: 404 };
    },
  });

  assert.equal(result.state, 'unavailable');
  assert.deepEqual(requests, [`/api/articles?id=${id}`]);
});

test('an ordinary unknown article keeps the established missing state', async () => {
  const result = await readArticle({
    apiBase: '/api',
    id: 'legacy-public-article-that-does-not-exist',
    fetcher: async () => ({ ok: false, status: 404 }),
  });

  assert.equal(result.state, 'missing');
});

test('the public articles handler does not import the live Notion match-content reader', async () => {
  const source = await readFile(new URL('../api/articles.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /fetchNotionMatchContent/u);
  assert.match(source, /listFixtureArchiveEditorials/u);
});

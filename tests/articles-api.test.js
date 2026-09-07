import test from 'node:test';
import assert from 'node:assert/strict';
import { matchContentCacheControl } from '../api/articles.js';

test('live match editorial cache never preserves an absent or partial Notion result', () => {
  assert.equal(matchContentCacheControl({ prediction: null, report: null, errors: {} }), 'no-store');
  assert.equal(matchContentCacheControl({ prediction: { id: 'prediction' }, report: null, errors: {} }), 'no-store');
  assert.equal(matchContentCacheControl({ prediction: { id: 'prediction' }, report: { id: 'report' }, errors: { match_report: 'unavailable' } }), 'no-store');
});

test('a complete live editorial pair expires promptly for Notion corrections', () => {
  assert.equal(
    matchContentCacheControl({ prediction: { id: 'prediction' }, report: { id: 'report' }, errors: {} }),
    'public, s-maxage=60, stale-while-revalidate=0',
  );
});

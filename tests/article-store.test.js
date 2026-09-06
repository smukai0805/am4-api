import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicArticle } from '../lib/article-visibility.js';
import { matchContentAvailability } from '../lib/article-content-availability.js';

test('only explicitly published and public articles are eligible for the public API', () => {
  assert.equal(isPublicArticle({ status: 'published', public: true }), true);
  assert.equal(isPublicArticle({ status: 'published' }), true);
  assert.equal(isPublicArticle({ status: 'draft', public: true }), false);
  assert.equal(isPublicArticle({ status: 'published', public: false }), false);
  assert.equal(isPublicArticle({ public: true }), false);
});

test('match content availability exposes only published prediction and report types for requested fixtures', () => {
  const availability = matchContentAvailability([
    { type: 'match_prediction', status: 'published', match: { fixtureId: 123 } },
    { type: 'match_report', status: 'published', match: { fixtureId: 123 } },
    { type: 'match_prediction', status: 'draft', match: { fixtureId: 456 } },
    { type: 'match_report', status: 'published', public: false, match: { fixtureId: 456 } },
    { type: 'am4_story', status: 'published', match: { fixtureId: 123 } },
    { type: 'match_prediction', status: 'published', match: { fixtureId: 999 } },
  ], [123, 456, 789]);

  assert.deepEqual(availability, {
    123: ['prediction', 'report'],
    456: [],
    789: [],
  });
});

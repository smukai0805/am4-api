import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicArticle } from '../lib/article-visibility.js';
import { matchContentAvailability } from '../lib/article-content-availability.js';
import { filterArticleIndex } from '../lib/article-store.js';

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

test('public Match Key lookup restores only the exact published archive editorial', () => {
  const matching = {
    id: 'published-ipswich-report', type: 'match_report', status: 'published', public: true, contentKind: 'notion_match_report',
    match: { competition: 'Premier League', date: '2026-09-04', homeTeam: 'Ipswich Town', awayTeam: 'Liverpool' },
  };
  const otherSeason = {
    ...matching, id: 'other-season', match: { ...matching.match, date: '2025-09-04' },
  };
  const draft = { ...matching, id: 'draft', status: 'draft' };
  const privateArticle = { ...matching, id: 'private', public: false };

  assert.deepEqual(filterArticleIndex([matching, otherSeason, draft, privateArticle], {
    type: 'match_report',
    matchKey: 'プレミアリーグ|2026-09-04|Ipswich|Liverpool',
    publishedOnly: true,
  }).map((article) => article.id), ['published-ipswich-report']);
});

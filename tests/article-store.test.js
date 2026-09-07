import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicArticle } from '../lib/article-visibility.js';
import { matchContentAvailability, matchContentAvailabilityByMatchKey } from '../lib/article-content-availability.js';
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

test('match content availability restores published legacy editorials by exact canonical Match Key', () => {
  const availability = matchContentAvailabilityByMatchKey([
    {
      type: 'match_prediction', status: 'published', public: true,
      match: { competition: 'Premier League', date: '2026-09-04', homeTeam: 'Ipswich Town', awayTeam: 'Liverpool' },
    },
    {
      type: 'match_report', status: 'published', public: true,
      match: { competition: 'Premier League', date: '2025-09-04', homeTeam: 'Ipswich Town', awayTeam: 'Liverpool' },
    },
    {
      type: 'match_report', status: 'draft', public: true,
      match: { competition: 'Premier League', date: '2026-09-04', homeTeam: 'Ipswich Town', awayTeam: 'Liverpool' },
    },
    {
      type: 'match_report', status: 'published', public: false,
      match: { competition: 'Premier League', date: '2026-09-04', homeTeam: 'Ipswich Town', awayTeam: 'Liverpool' },
    },
    {
      type: 'match_report', status: 'published', public: true,
      match: { fixtureId: 999999, competition: 'Premier League', date: '2026-09-04', homeTeam: 'Ipswich Town', awayTeam: 'Liverpool' },
    },
  ], ['プレミアリーグ|2026-09-04|Ipswich|Liverpool']);

  assert.deepEqual(availability, {
    'premierleague|2026-09-04|ipswichtown|liverpool': ['prediction'],
  });
});

test('match card availability recognizes provider and Notion club-name variants in CL fixtures', () => {
  const publishedPrediction = (match) => ({
    type: 'match_prediction', status: 'published', public: true, match,
  });
  const availability = matchContentAvailabilityByMatchKey([
    publishedPrediction({
      competition: 'Champions League', date: '2026-09-08',
      homeTeam: 'Club Brugge', awayTeam: 'Aston Villa',
    }),
    publishedPrediction({
      competition: 'Champions League', date: '2026-09-09',
      homeTeam: 'Liverpool', awayTeam: 'Atlético de Madrid',
    }),
  ], [
    'チャンピオンズリーグ|2026-09-08|Club Brugge KV|Aston Villa',
    'チャンピオンズリーグ|2026-09-09|Liverpool|Atletico Madrid',
  ]);

  assert.deepEqual(availability, {
    'championsleague|2026-09-08|brugge|astonvilla': ['prediction'],
    'championsleague|2026-09-09|liverpool|atleticomadrid': ['prediction'],
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

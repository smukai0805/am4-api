import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDefaultSeason,
  selectDailyFixtures,
  selectFeaturedFixtures,
  selectHomepageFixtures,
} from '../api/fixtures.js';

function fixture(id, competition, homeId, awayId, kickoff) {
  return { id, competition, homeId, awayId, kickoff };
}

test('featured fixtures use the football season containing the current Tokyo date', () => {
  assert.equal(resolveDefaultSeason(new Date('2026-08-15T03:00:00Z')), 2026);
  assert.equal(resolveDefaultSeason(new Date('2027-02-15T03:00:00Z')), 2026);
});

test('featured fixtures prefer picked-club matchups regardless of competition distribution', () => {
  const selected = selectFeaturedFixtures([
    fixture(1, 'プレミアリーグ', 33, 9001, '2026-08-20T18:00:00Z'),
    fixture(2, 'プレミアリーグ', 40, 42, '2026-08-24T18:00:00Z'),
    fixture(3, 'ラ・リーガ', 541, 9003, '2026-08-21T18:00:00Z'),
    fixture(4, 'チャンピオンズリーグ', 529, 9004, '2026-08-22T18:00:00Z'),
  ]);

  assert.equal(selected.length, 3);
  assert.equal(selected[0].id, 2);
});

test('featured fixtures still fill three slots when only one competition is available', () => {
  const selected = selectFeaturedFixtures([
    fixture(1, 'プレミアリーグ', 33, 9001, '2026-08-20T18:00:00Z'),
    fixture(2, 'プレミアリーグ', 40, 9002, '2026-08-21T18:00:00Z'),
    fixture(3, 'プレミアリーグ', 42, 9003, '2026-08-22T18:00:00Z'),
  ]);

  assert.deepEqual(selected.map((item) => item.id), [1, 2, 3]);
});

test('featured fixtures surface a major derby ahead of a generic picked-club matchup', () => {
  const selected = selectFeaturedFixtures([
    fixture(1, 'プレミアリーグ', 42, 40, '2026-08-20T18:00:00Z'),
    fixture(2, 'プレミアリーグ', 42, 47, '2026-08-22T18:00:00Z'),
    fixture(3, 'ラ・リーガ', 541, 9003, '2026-08-21T18:00:00Z'),
  ]);

  assert.equal(selected[0].id, 2);
});

test('featured fixtures give a close Champions League headline matchup an editorial boost', () => {
  const selected = selectFeaturedFixtures([
    fixture(1, 'プレミアリーグ', 50, 40, '2026-08-20T18:00:00Z'),
    fixture(2, 'チャンピオンズリーグ', 50, 541, '2026-08-22T18:00:00Z'),
    fixture(3, 'セリエA', 489, 9003, '2026-08-21T18:00:00Z'),
  ]);

  assert.equal(selected[0].id, 2);
});

test('featured fixtures prefer a nearby matchup at a Japan-friendly kickoff time', () => {
  const selected = selectFeaturedFixtures([
    fixture(1, 'プレミアリーグ', 33, 42, '2026-08-20T18:00:00Z'), // 03:00 JST
    fixture(2, 'プレミアリーグ', 40, 49, '2026-08-21T12:00:00Z'), // 21:00 JST
    fixture(3, 'ラ・リーガ', 541, 9003, '2026-08-21T18:00:00Z'),
  ]);

  assert.equal(selected[0].id, 2);
});

test('featured fixtures preserve the top three editorial scores even when a club repeats', () => {
  const selected = selectFeaturedFixtures([
    fixture(1, 'プレミアリーグ', 42, 47, '2026-08-20T18:00:00Z'),
    fixture(2, 'チャンピオンズリーグ', 42, 541, '2026-08-21T18:00:00Z'),
    fixture(3, 'プレミアリーグ', 50, 40, '2026-08-22T18:00:00Z'),
    fixture(4, 'プレミアリーグ', 33, 9004, '2026-08-23T18:00:00Z'),
  ]);

  assert.deepEqual(selected.map((item) => item.id), [1, 2, 3]);
});

test('featured fixtures recognise headline rivalries across the major leagues', () => {
  const selected = selectFeaturedFixtures([
    fixture(1, 'プレミアリーグ', 42, 40, '2026-08-20T18:00:00Z'),
    fixture(2, 'プレミアリーグ', 33, 40, '2026-08-21T18:00:00Z'),
    fixture(3, 'ラ・リーガ', 530, 541, '2026-08-22T18:00:00Z'),
    fixture(4, 'セリエA', 496, 505, '2026-08-23T18:00:00Z'),
  ]);

  assert.deepEqual(selected.map((item) => item.id), [2, 3, 4]);
});

test('featured fixtures recognise Le Classique as the Ligue 1 headline rivalry', () => {
  const selected = selectFeaturedFixtures([
    fixture(1, 'リーグ・アン', 85, 9001, '2026-08-20T18:00:00Z'),
    fixture(2, 'リーグ・アン', 85, 81, '2026-08-21T18:00:00Z'),
  ]);

  assert.equal(selected[0].id, 2);
});

test('homepage shows matches on the requested Tokyo date before higher-rated later fixtures', () => {
  const selected = selectHomepageFixtures([
    fixture(1, 'クラブ親善試合', 40, 9001, '2026-08-16T10:30:00Z'),
    fixture(2, 'クラブ親善試合', 42, 50, '2026-08-16T14:00:00Z'),
    fixture(3, 'プレミアリーグ', 33, 40, '2026-08-22T11:30:00Z'),
  ], '2026-08-16');

  assert.deepEqual(selected.map((item) => item.id), [2, 1]);
});

test('daily fixtures combine every provider competition and club friendlies in kickoff order', () => {
  const providerFixtures = [
    {
      fixture: { id: 3, date: '2026-08-16T23:30:00+09:00', status: { short: 'NS' }, venue: { name: 'Stadium C' } },
      league: { id: 140, round: 'Regular Season - 1' },
      teams: { home: { id: 30, name: 'Basel', logo: 'basel.png' }, away: { id: 529, name: 'Barcelona', logo: 'barcelona.png' } },
      goals: { home: null, away: null },
    },
    {
      fixture: { id: 1, date: '2026-08-16T19:30:00+09:00', status: { short: 'NS' }, venue: { name: 'Stadium A' } },
      league: { id: 667, round: 'Club Friendlies 1' },
      teams: { home: { id: 40, name: 'Liverpool', logo: 'liverpool.png' }, away: { id: 9001, name: 'Como', logo: 'como.png' } },
      goals: { home: null, away: null },
    },
    {
      fixture: { id: 2, date: '2026-08-16T21:00:00+09:00', status: { short: 'NS' }, venue: { name: 'Stadium B' } },
      league: { id: 999, name: 'Other League', round: 'Regular Season - 1' },
      teams: { home: { id: 10, name: 'Outside Scope A', logo: null }, away: { id: 11, name: 'Outside Scope B', logo: null } },
      goals: { home: null, away: null },
    },
  ];

  const selected = selectDailyFixtures(providerFixtures);

  assert.deepEqual(selected.map((item) => item.id), [1, 2, 3]);
  assert.deepEqual(selected.map((item) => item.competition), ['クラブ親善試合', 'Other League', 'ラ・リーガ']);
  assert.deepEqual(selected.map((item) => item.am4Focus), [true, false, true]);
});

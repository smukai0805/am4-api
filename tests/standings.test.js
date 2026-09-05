import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeStandings,
  resolveStandingCompetition,
  resolveStandingSeason,
} from '../api/standings.js';

test('standings normalisation retains provider team identity and prefers provider qualification text', () => {
  const [row] = normalizeStandings([{
    rank: 12,
    team: { id: 42, name: 'Arsenal', logo: 'https://example.test/arsenal.png' },
    all: { played: 8, win: 5, draw: 2, lose: 1 },
    goalsDiff: 7,
    points: 17,
    description: 'Champions League',
  }], { competition: 'プレミアリーグ', season: 2026 });

  assert.deepEqual(row, {
    rank: 12,
    teamId: 42,
    club: 'Arsenal',
    logo: 'https://example.test/arsenal.png',
    played: 8,
    win: 5,
    draw: 2,
    lose: 1,
    goalsDiff: 7,
    points: 17,
    group: null,
    description: 'Champions League',
    status: null,
    zone: 'champions_league',
    zoneSource: 'provider',
  });
});

test('standings do not guess qualification zones when the provider omits verified data', () => {
  const rows = normalizeStandings([{
    rank: 18,
    team: { id: 1, name: 'Club' },
    all: { played: 8, win: 1, draw: 2, lose: 5 },
    goalsDiff: -9,
    points: 5,
  }], { competition: 'プレミアリーグ', season: 2026 });

  assert.equal(rows[0].zone, null);
  assert.equal(rows[0].zoneSource, null);
});

test('standing requests preserve a fixture competition ID outside the primary league map', () => {
  assert.deepEqual(resolveStandingCompetition({ competitionId: 39 }), { name: 'プレミアリーグ', providerId: 39 });
  assert.deepEqual(resolveStandingCompetition({ competition: 'Jupiler Pro League', competitionId: 144 }), { name: 'Jupiler Pro League', providerId: 144 });
  assert.equal(resolveStandingCompetition({ competition: 'クラブ親善試合' }), null);
  assert.equal(resolveStandingSeason(undefined, new Date('2026-09-03T00:00:00Z')), 2026);
  assert.equal(resolveStandingSeason(2021), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDefaultSeason, selectFeaturedFixtures } from '../api/fixtures.js';

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

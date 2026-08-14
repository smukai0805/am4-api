import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFeaturedFixtures } from '../api/fixtures.js';

function fixture(id, competition, homeId, awayId, kickoff) {
  return { id, competition, homeId, awayId, kickoff };
}

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

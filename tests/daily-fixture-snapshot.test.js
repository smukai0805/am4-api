import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isProductionDailyFixtureSnapshotEnabled,
  preserveDailyFixtureSnapshot,
  stabilizeDailyFixtures,
} from '../lib/daily-fixture-snapshot.js';
import { applyDailyFixtureSnapshot } from '../api/fixtures.js';

const SNAPSHOT_PATH = 'daily-fixture-snapshots/current.json';

function fixture(id, competitionId, kickoff, overrides = {}) {
  return {
    id,
    competitionId,
    competition: `Competition ${competitionId}`,
    kickoff,
    status: 'NS',
    home: `Home ${id}`,
    away: `Away ${id}`,
    ...overrides,
  };
}

function snapshot(fixtures, capturedAt = '2026-09-28T05:00:00.000Z') {
  return {
    version: 1,
    date: '2026-09-28',
    capturedAt,
    fixtures,
  };
}

function createBlob(initial = {}) {
  const values = new Map(Object.entries(initial).map(([path, value], index) => [path, {
    text: JSON.stringify(value), etag: `etag-${index + 1}`,
  }]));
  const getCalls = [];
  const putCalls = [];
  let revision = values.size;
  const conflict = (message) => Object.assign(new Error(message), { status: 412 });
  return {
    async get(path) {
      getCalls.push(path);
      const current = values.get(path);
      return current ? { stream: new Blob([current.text]).stream(), blob: { etag: current.etag } } : null;
    },
    async put(path, text, options = {}) {
      putCalls.push({ path, text, options });
      const current = values.get(path);
      if (options.allowOverwrite === false && current) throw conflict('already exists');
      if (options.ifMatch && (!current || current.etag !== options.ifMatch)) throw conflict('etag mismatch');
      const etag = `etag-${++revision}`;
      values.set(path, { text, etag });
      return { etag };
    },
    getCalls,
    putCalls,
    values,
  };
}

test('restores only recently missing complete competition groups from the last good daily snapshot', () => {
  const previous = snapshot([
      fixture(1, 5, '2026-09-27T16:45:00.000Z'),
      fixture(2, 5, '2026-09-27T19:45:00.000Z'),
      fixture(3, 10, '2026-09-27T17:00:00.000Z'),
      fixture(4, 10, '2026-09-27T20:00:00.000Z'),
      fixture(5, 140, '2026-09-27T18:00:00.000Z'),
  ]);
  const current = [fixture(5, 140, '2026-09-27T18:00:00.000Z', { status: 'FT', homeGoals: 2, awayGoals: 1 })];

  const result = stabilizeDailyFixtures(current, previous, {
    date: '2026-09-28',
    now: new Date('2026-09-28T05:04:00.000Z'),
  });

  assert.deepEqual(result.restoredCompetitionIds, [5, 10]);
  assert.deepEqual(result.fixtures.map((item) => item.id), [1, 3, 5, 2, 4]);
  assert.equal(result.fixtures.find((item) => item.id === 5).status, 'FT');
});

test('does not restore a stale snapshot or a group that still has a current fixture', () => {
  const previous = snapshot([
      fixture(1, 5, '2026-09-27T16:45:00.000Z'),
      fixture(2, 5, '2026-09-27T19:45:00.000Z'),
      fixture(3, 10, '2026-09-27T17:00:00.000Z'),
      fixture(4, 10, '2026-09-27T20:00:00.000Z'),
  ], '2026-09-28T04:00:00.000Z');

  const stale = stabilizeDailyFixtures([fixture(5, 140, '2026-09-27T18:00:00.000Z')], previous, {
    date: '2026-09-28',
    now: new Date('2026-09-28T05:04:00.000Z'),
  });
  assert.deepEqual(stale.restoredCompetitionIds, []);
  assert.deepEqual(stale.fixtures.map((item) => item.id), [5]);

  const recent = {
    ...previous,
    capturedAt: '2026-09-28T05:00:00.000Z',
  };
  const partialGroup = stabilizeDailyFixtures([
    fixture(1, 5, '2026-09-27T16:45:00.000Z', { status: 'FT' }),
    fixture(5, 140, '2026-09-27T18:00:00.000Z'),
  ], recent, {
    date: '2026-09-28',
    now: new Date('2026-09-28T05:04:00.000Z'),
  });
  assert.deepEqual(partialGroup.restoredCompetitionIds, [10]);
  assert.deepEqual(partialGroup.fixtures.map((item) => item.id), [1, 3, 5, 4]);
});

test('keeps a fresh full snapshot when the upstream daily response is empty', async () => {
  const previous = snapshot([
      fixture(1, 5, '2026-09-27T16:45:00.000Z'),
      fixture(2, 5, '2026-09-27T19:45:00.000Z'),
  ]);
  const blob = createBlob({ [SNAPSHOT_PATH]: previous });

  const result = await preserveDailyFixtureSnapshot('2026-09-28', [], {
    now: new Date('2026-09-28T05:04:00.000Z'),
    blob,
  });

  assert.deepEqual(result.fixtures.map((item) => item.id), [1, 2]);
  assert.deepEqual(result.restoredCompetitionIds, [5]);
  assert.equal(blob.putCalls.length, 0);
});

test('creates one private current-day snapshot with a conditional create', async () => {
  const blob = createBlob();
  const current = [
    fixture(1, 5, '2026-09-27T16:45:00.000Z'),
    fixture(2, 5, '2026-09-27T19:45:00.000Z'),
  ];

  const result = await preserveDailyFixtureSnapshot('2026-09-28', current, {
    now: new Date('2026-09-28T05:00:00.000Z'),
    blob,
  });

  assert.deepEqual(result.fixtures, current);
  assert.equal(blob.getCalls.length, 1);
  assert.equal(blob.putCalls.length, 1);
  assert.equal(blob.putCalls[0].path, SNAPSHOT_PATH);
  assert.deepEqual(blob.putCalls[0].options, {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: false,
    contentType: 'application/json',
  });
});

test('does not renew a recovered snapshot while an upstream competition remains absent', async () => {
  const previous = snapshot([
    fixture(1, 5, '2026-09-27T16:45:00.000Z'),
    fixture(2, 5, '2026-09-27T19:45:00.000Z'),
    fixture(3, 140, '2026-09-27T18:00:00.000Z'),
  ]);
  const blob = createBlob({ [SNAPSHOT_PATH]: previous });

  const result = await preserveDailyFixtureSnapshot('2026-09-28', [
    fixture(3, 140, '2026-09-27T18:00:00.000Z'),
  ], {
    now: new Date('2026-09-28T05:06:00.000Z'),
    blob,
  });

  assert.deepEqual(result.fixtures.map((item) => item.id), [1, 3, 2]);
  assert.deepEqual(result.restoredCompetitionIds, [5]);
  assert.equal(result.snapshot.capturedAt, previous.capturedAt);
  assert.equal(blob.putCalls.length, 0);
});

test('expires a recovered competition after the original short freshness window', async () => {
  const previous = snapshot([
    fixture(1, 5, '2026-09-27T16:45:00.000Z'),
    fixture(2, 5, '2026-09-27T19:45:00.000Z'),
    fixture(3, 140, '2026-09-27T18:00:00.000Z'),
  ]);
  const blob = createBlob({ [SNAPSHOT_PATH]: previous });
  const partial = [fixture(3, 140, '2026-09-27T18:00:00.000Z')];

  const duringWindow = await preserveDailyFixtureSnapshot('2026-09-28', partial, {
    now: new Date('2026-09-28T05:04:00.000Z'),
    blob,
  });
  const afterWindow = await preserveDailyFixtureSnapshot('2026-09-28', partial, {
    now: new Date('2026-09-28T05:11:00.000Z'),
    blob,
  });

  assert.deepEqual(duringWindow.fixtures.map((item) => item.id), [1, 3, 2]);
  assert.deepEqual(afterWindow.fixtures.map((item) => item.id), [3]);
  assert.deepEqual(afterWindow.restoredCompetitionIds, []);
  assert.equal(blob.putCalls.length, 1);
  assert.equal(JSON.parse(blob.putCalls[0].text).capturedAt, '2026-09-28T05:11:00.000Z');
});

test('keeps the latest Blob record when a conditional write races another request', async () => {
  const previous = snapshot([
    fixture(1, 5, '2026-09-27T16:45:00.000Z'),
    fixture(2, 5, '2026-09-27T19:45:00.000Z'),
  ]);
  const concurrent = snapshot([
    fixture(1, 5, '2026-09-27T16:45:00.000Z', { status: 'FT', homeGoals: 2 }),
    fixture(2, 5, '2026-09-27T19:45:00.000Z'),
  ], '2026-09-28T05:05:01.000Z');
  const blob = createBlob({ [SNAPSHOT_PATH]: previous });
  const originalPut = blob.put.bind(blob);
  let raced = false;
  blob.put = async (path, text, options) => {
    if (!raced) {
      raced = true;
      blob.values.set(path, { text: JSON.stringify(concurrent), etag: 'etag-concurrent' });
    }
    return originalPut(path, text, options);
  };

  await preserveDailyFixtureSnapshot('2026-09-28', [
    fixture(1, 5, '2026-09-27T16:45:00.000Z', { status: 'FT', homeGoals: 1 }),
    fixture(2, 5, '2026-09-27T19:45:00.000Z'),
  ], {
    now: new Date('2026-09-28T05:05:00.000Z'),
    blob,
  });

  assert.equal(blob.putCalls.length, 1);
  assert.deepEqual(JSON.parse(blob.values.get(SNAPSHOT_PATH).text), concurrent);
});

test('only uses the durable snapshot for the current Tokyo day and production configuration', async () => {
  assert.equal(isProductionDailyFixtureSnapshotEnabled({ VERCEL_ENV: 'preview', BLOB_READ_WRITE_TOKEN: 'present' }), false);
  assert.equal(isProductionDailyFixtureSnapshotEnabled({ VERCEL_ENV: 'production' }), false);
  assert.equal(isProductionDailyFixtureSnapshotEnabled({ VERCEL_ENV: 'production', BLOB_READ_WRITE_TOKEN: 'present' }), true);

  const blob = createBlob();
  const result = await preserveDailyFixtureSnapshot('2026-09-27', [
    fixture(1, 5, '2026-09-27T16:45:00.000Z'),
  ], {
    now: new Date('2026-09-28T05:00:00.000Z'),
    blob,
  });

  assert.equal(result, null);
  assert.deepEqual(blob.getCalls, []);
  assert.deepEqual(blob.putCalls, []);
});

test('leaves the normal daily response untouched unless a snapshot restored a missing competition', () => {
  const current = [
    { id: 'as-received-first', kickoff: 'not-a-date' },
    fixture(2, 5, '2026-09-27T19:45:00.000Z'),
    fixture(1, 5, '2026-09-27T16:45:00.000Z'),
  ];
  const noRestore = {
    fixtures: [fixture(1, 5, '2026-09-27T16:45:00.000Z')],
    restoredCompetitionIds: [],
  };
  const restored = {
    fixtures: [fixture(1, 5, '2026-09-27T16:45:00.000Z')],
    restoredCompetitionIds: [5],
  };

  assert.strictEqual(applyDailyFixtureSnapshot(current, noRestore), current);
  assert.strictEqual(applyDailyFixtureSnapshot(current, null), current);
  assert.strictEqual(applyDailyFixtureSnapshot(current, restored), restored.fixtures);
});

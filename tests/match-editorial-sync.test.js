import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MATCH_EDITORIAL_ASSOCIATION_RULESET_VERSION,
  MATCH_EDITORIAL_BACKFILL_GENERATION,
  MATCH_EDITORIAL_DUPLICATE_CANDIDATE_VERSION,
  matchEditorialAssociationRulesetNeedsReconciliation,
  matchEditorialBackfillTypesNeedingScan,
  matchEditorialDuplicateCandidatesNeedScan,
  queueMatchEditorialBackfill,
  queueUnlinkedMatchEditorialReconciliation,
  refreshMatchEditorialDuplicateCandidates,
  scanMatchEditorialDuplicateCandidates,
} from '../lib/match-editorial-sync.js';
import { createSiteMonitorStore } from '../lib/site-monitor-store.js';

function createBlob() {
  const data = new Map();
  let revision = 0;
  const conflict = () => Object.assign(new Error('etag mismatch'), { status: 412 });
  return {
    async get(path) {
      const entry = data.get(path);
      return entry ? { stream: new Blob([entry.text]).stream(), etag: entry.etag } : null;
    },
    async put(path, text, options = {}) {
      const entry = data.get(path);
      if (options.allowOverwrite === false && entry) throw conflict();
      if (options.ifMatch && (!entry || entry.etag !== options.ifMatch)) throw conflict();
      const etag = `e${++revision}`;
      data.set(path, { text, etag });
      return { etag };
    },
  };
}

function page(id, version) {
  return { id, last_edited_time: version };
}

test('a prior source generation starts one resumable scan for both authored match types', () => {
  const state = {
    matchEditorialSync: {
      backfill: {
        match_report: {
          generation: 'notion-match-editorial-sync-v6',
          sourceScanCompletedAt: '2026-09-17T00:00:00.000Z',
        },
        match_prediction: {
          generation: 'notion-match-editorial-sync-v6',
          sourceScanCompletedAt: '2026-09-17T00:00:00.000Z',
        },
      },
    },
  };
  assert.deepEqual(matchEditorialBackfillTypesNeedingScan(state), ['match_report', 'match_prediction']);
});

test('prediction and report source scans keep independent durable cursors and completion state', async () => {
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => new Date('2026-09-17T00:00:00.000Z') });
  const first = await queueMatchEditorialBackfill({
    store,
    collectSourcePages: async ({ types, cursors, onPage }) => {
      assert.deepEqual(types, ['match_report', 'match_prediction']);
      assert.equal(cursors.match_report.cursor, null);
      assert.equal(cursors.match_prediction.cursor, null);
      await onPage({
        sourceType: 'match_report',
        pages: [page('report-a', '2026-09-16T01:00:00.000Z')],
        nextCursor: 'report-next',
        complete: false,
      });
      await onPage({
        sourceType: 'match_prediction',
        pages: [page('prediction-a', '2026-09-16T02:00:00.000Z')],
        nextCursor: null,
        complete: true,
      });
      return {
        sources: { match_prediction: { complete: true } },
        errors: { match_report: 'unavailable' },
        retryAfterMs: {},
      };
    },
  });
  assert.equal(first.state, 'partial');
  assert.equal(first.types.match_report.state, 'unavailable');
  assert.equal(first.types.match_prediction.state, 'queued');
  let state = (await store.readState()).value;
  assert.equal(state.matchEditorialSync.backfill.match_report.cursor, 'report-next');
  assert.equal(state.matchEditorialSync.backfill.match_report.sourceScanCompletedAt, null);
  assert.ok(state.matchEditorialSync.backfill.match_prediction.sourceScanCompletedAt);

  const resumed = await queueMatchEditorialBackfill({
    store,
    collectSourcePages: async ({ types, cursors, onPage }) => {
      assert.deepEqual(types, ['match_report']);
      assert.equal(cursors.match_report.cursor, 'report-next');
      await onPage({
        sourceType: 'match_report',
        pages: [page('report-b', '2026-09-16T03:00:00.000Z')],
        nextCursor: null,
        complete: true,
      });
      return { sources: { match_report: { complete: true } }, errors: {}, retryAfterMs: {} };
    },
  });
  assert.equal(resumed.state, 'queued');
  state = (await store.readState()).value;
  assert.ok(state.matchEditorialSync.backfill.match_report.sourceScanCompletedAt);
  assert.ok(state.matchEditorialSync.backfill.match_prediction.sourceScanCompletedAt);

  const noRepeat = await queueMatchEditorialBackfill({
    store,
    collectSourcePages: async () => { throw new Error('completed editorial sources must not be re-read'); },
  });
  assert.equal(noRepeat.state, 'already_scanned');
  const jobs = await Promise.all((await store.readQueue()).value.items
    .map(async (item) => (await store.readJob(item.jobId)).value));
  assert.deepEqual(jobs.map((job) => `${job.sourceType}:${job.pageId}`).sort(), [
    'match_prediction:prediction-a', 'match_report:report-a', 'match_report:report-b',
  ]);
  assert.ok(jobs.every((job) => job.deliveryOnly === true));
});

test('prediction fixture reconciliation queues only stored public predictions missing fixture identity', async () => {
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => new Date('2026-09-17T00:00:00.000Z') });
  await store.updateState((state) => ({
    ...state,
    matchEditorialSync: {
      backfill: {
        match_prediction: {
          generation: MATCH_EDITORIAL_BACKFILL_GENERATION,
          sourceScanCompletedAt: '2026-09-17T00:00:00.000Z',
        },
      },
    },
  }));
  const result = await queueUnlinkedMatchEditorialReconciliation({
    store,
    types: ['match_prediction'],
    listArticles: async ({ type }) => {
      assert.equal(type, 'match_prediction');
      return {
        page: 1,
        totalPages: 1,
        items: [
          {
            id: 'notion-match_prediction-unlinked', type: 'match_prediction', status: 'published', public: true,
            notion: { updatedAt: '2026-09-16T01:00:00.000Z' }, match: { fixtureId: null },
          },
          {
            id: 'notion-match_prediction-linked', type: 'match_prediction', status: 'published', public: true,
            notion: { updatedAt: '2026-09-16T01:00:00.000Z' }, match: { fixtureId: 1557404 },
          },
        ],
      };
    },
  });
  assert.equal(result.state, 'queued');
  assert.equal(result.types.match_prediction.candidates, 1);
  assert.equal(result.types.match_prediction.queued, 1);
  const queued = (await store.readQueue()).value.items;
  assert.equal(queued.length, 1);
  const job = (await store.readJob(queued[0].jobId)).value;
  assert.equal(job.articleId, 'notion-match_prediction-unlinked');
  assert.equal(job.sourceType, 'match_prediction');
  assert.equal(job.deliveryOnly, true);
});

test('a changed fixture-association ruleset bypasses the ordinary retry interval without rereading Notion', async () => {
  const now = () => new Date('2026-09-18T00:30:00.000Z');
  const store = createSiteMonitorStore({ blob: createBlob(), now });
  await store.updateState((state) => ({
    ...state,
    matchEditorialSync: {
      backfill: {
        match_prediction: {
          generation: MATCH_EDITORIAL_BACKFILL_GENERATION,
          sourceScanCompletedAt: '2026-09-17T00:00:00.000Z',
        },
      },
      reconciliation: {
        match_prediction: {
          rulesetVersion: 'fixture-identity-v1',
          lastQueuedAt: '2026-09-18T00:29:00.000Z',
          completedAt: '2026-09-18T00:29:00.000Z',
        },
      },
    },
  }));
  assert.equal(matchEditorialAssociationRulesetNeedsReconciliation((await store.readState()).value), true);
  let listCalls = 0;
  const result = await queueUnlinkedMatchEditorialReconciliation({
    store,
    types: ['match_prediction'],
    now,
    listArticles: async () => {
      listCalls += 1;
      return {
        page: 1,
        totalPages: 1,
        items: [{
          id: 'notion-match_prediction-ruleset-retry', type: 'match_prediction', status: 'published', public: true,
          notion: { updatedAt: '2026-09-17T01:00:00.000Z' }, match: { fixtureId: null },
        }],
      };
    },
  });
  assert.equal(result.state, 'queued');
  assert.equal(listCalls, 1);
  const state = (await store.readState()).value;
  assert.equal(state.matchEditorialSync.reconciliation.match_prediction.rulesetVersion, MATCH_EDITORIAL_ASSOCIATION_RULESET_VERSION);
  const [item] = (await store.readQueue()).value.items;
  const job = (await store.readJob(item.jobId)).value;
  assert.match(job.repairGeneration, new RegExp(MATCH_EDITORIAL_ASSOCIATION_RULESET_VERSION));
  assert.equal(matchEditorialAssociationRulesetNeedsReconciliation(state), false);
});

test('a ruleset reconciliation continues its stored page cursor on the editorial worker', async () => {
  const now = () => new Date('2026-09-18T00:30:00.000Z');
  const store = createSiteMonitorStore({ blob: createBlob(), now });
  await store.updateState((state) => ({
    ...state,
    matchEditorialSync: {
      backfill: {
        match_report: {
          generation: MATCH_EDITORIAL_BACKFILL_GENERATION,
          sourceScanCompletedAt: '2026-09-17T00:00:00.000Z',
        },
      },
      reconciliation: {
        match_report: {
          rulesetVersion: MATCH_EDITORIAL_ASSOCIATION_RULESET_VERSION,
          generation: `match-editorial-match_report-association-${MATCH_EDITORIAL_ASSOCIATION_RULESET_VERSION}-2026-09-18`,
          nextPage: 2,
          totalPages: 2,
          startedAt: '2026-09-18T00:29:00.000Z',
        },
      },
    },
  }));
  assert.equal(matchEditorialAssociationRulesetNeedsReconciliation((await store.readState()).value), true);
  const pages = [];
  const result = await queueUnlinkedMatchEditorialReconciliation({
    store,
    types: ['match_report'],
    now,
    listArticles: async ({ page }) => {
      pages.push(page);
      return { page, totalPages: 2, items: [] };
    },
  });
  assert.equal(result.state, 'queued');
  assert.deepEqual(pages, [2]);
  assert.equal(matchEditorialAssociationRulesetNeedsReconciliation((await store.readState()).value), false);
});

test('duplicate fixture pages are recorded for review without deleting or merging either article', async () => {
  const now = () => new Date('2026-09-18T01:00:00.000Z');
  const store = createSiteMonitorStore({ blob: createBlob(), now });
  const article = (id, fixtureId, updatedAt) => ({
    id, type: 'match_report', status: 'published', public: true,
    notion: { updatedAt }, match: { fixtureId },
  });
  assert.equal(matchEditorialDuplicateCandidatesNeedScan((await store.readState()).value), true);
  const result = await scanMatchEditorialDuplicateCandidates({
    store,
    types: ['match_report'],
    now,
    listArticles: async ({ page }) => page === 1
      ? { page, totalPages: 2, items: [article('report-first', 101, '2026-09-17T01:00:00.000Z')] }
      : { page, totalPages: 2, items: [
        article('report-second', 101, '2026-09-17T02:00:00.000Z'),
        article('report-unique', 102, '2026-09-17T03:00:00.000Z'),
      ] },
  });
  assert.equal(result.state, 'recorded');
  assert.equal(result.candidates, 1);
  const state = (await store.readState()).value;
  assert.equal(matchEditorialDuplicateCandidatesNeedScan(state, ['match_report']), false);
  assert.deepEqual(state.matchEditorialSync.duplicateCandidates.match_report.candidates, [{
    fixtureId: 101,
    articles: [
      { articleId: 'report-first', sourceVersion: '2026-09-17T01:00:00.000Z' },
      { articleId: 'report-second', sourceVersion: '2026-09-17T02:00:00.000Z' },
    ],
  }]);
});

test('a later editorial delivery refreshes only its fixture duplicate candidate', async () => {
  const now = () => new Date('2026-09-18T01:00:00.000Z');
  const store = createSiteMonitorStore({ blob: createBlob(), now });
  await store.updateState((state) => ({
    ...state,
    matchEditorialSync: {
      duplicateCandidates: {
        match_prediction: {
          version: MATCH_EDITORIAL_DUPLICATE_CANDIDATE_VERSION,
          completedAt: '2026-09-18T00:59:00.000Z',
          candidates: [{
            fixtureId: 201,
            articles: [
              { articleId: 'existing-a', sourceVersion: '2026-09-17T01:00:00.000Z' },
              { articleId: 'existing-b', sourceVersion: '2026-09-17T02:00:00.000Z' },
            ],
          }],
        },
      },
    },
  }));
  const result = await refreshMatchEditorialDuplicateCandidates({
    store,
    now,
    articles: [{
      id: 'new-a', type: 'match_prediction', status: 'published', public: true,
      notion: { updatedAt: '2026-09-18T01:00:00.000Z' }, match: { fixtureId: 202 },
    }],
    listArticles: async ({ type, fixtureId, page }) => {
      assert.equal(type, 'match_prediction');
      assert.equal(fixtureId, 202);
      assert.equal(page, 1);
      return {
        page, totalPages: 1, items: [
          { id: 'new-a', type, status: 'published', public: true, notion: { updatedAt: '2026-09-18T01:00:00.000Z' }, match: { fixtureId } },
          { id: 'new-b', type, status: 'published', public: true, notion: { updatedAt: '2026-09-18T01:01:00.000Z' }, match: { fixtureId } },
        ],
      };
    },
  });
  assert.deepEqual(result, { state: 'recorded', checked: 1, candidates: 1, unavailable: 0 });
  const candidates = (await store.readState()).value.matchEditorialSync.duplicateCandidates.match_prediction.candidates;
  assert.deepEqual(candidates.map(({ fixtureId, articles }) => ({ fixtureId, articleIds: articles.map(({ articleId }) => articleId) })), [
    { fixtureId: 201, articleIds: ['existing-a', 'existing-b'] },
    { fixtureId: 202, articleIds: ['new-a', 'new-b'] },
  ]);
});

test('an association correction rechecks both old and new duplicate fixtures', async () => {
  const now = () => new Date('2026-09-18T01:00:00.000Z');
  const store = createSiteMonitorStore({ blob: createBlob(), now });
  await store.updateState((state) => ({
    ...state,
    matchEditorialSync: {
      duplicateCandidates: {
        match_report: {
          version: MATCH_EDITORIAL_DUPLICATE_CANDIDATE_VERSION,
          completedAt: '2026-09-18T00:59:00.000Z',
          candidates: [{
            fixtureId: 301,
            articles: [
              { articleId: 'moved-report', sourceVersion: '2026-09-17T01:00:00.000Z' },
              { articleId: 'old-partner', sourceVersion: '2026-09-17T02:00:00.000Z' },
            ],
          }],
        },
      },
    },
  }));
  const checked = [];
  await refreshMatchEditorialDuplicateCandidates({
    store,
    now,
    articles: [{
      id: 'moved-report', type: 'match_report', status: 'published', public: true,
      notion: { updatedAt: '2026-09-18T01:00:00.000Z' }, match: { fixtureId: 302 },
    }],
    listArticles: async ({ type, fixtureId, page }) => {
      assert.equal(type, 'match_report');
      assert.equal(page, 1);
      checked.push(fixtureId);
      return fixtureId === 301
        ? { page, totalPages: 1, items: [{ id: 'old-partner', type, status: 'published', public: true, notion: { updatedAt: '2026-09-17T02:00:00.000Z' }, match: { fixtureId } }] }
        : { page, totalPages: 1, items: [{ id: 'moved-report', type, status: 'published', public: true, notion: { updatedAt: '2026-09-18T01:00:00.000Z' }, match: { fixtureId } }] };
    },
  });
  assert.deepEqual(checked.sort((left, right) => left - right), [301, 302]);
  assert.deepEqual((await store.readState()).value.matchEditorialSync.duplicateCandidates.match_report.candidates, []);
});

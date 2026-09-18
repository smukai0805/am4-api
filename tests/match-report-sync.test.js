import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MATCH_REPORT_BACKFILL_GENERATION,
  queueMatchReportBackfill,
  queueUnlinkedMatchReportReconciliation,
} from '../lib/match-report-sync.js';
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
    async del(path, options = {}) {
      const entry = data.get(path);
      if (options.ifMatch && (!entry || entry.etag !== options.ifMatch)) throw conflict();
      data.delete(path);
    },
  };
}

function reportPage(id, version) {
  return { id, last_edited_time: version };
}

test('a full match-report source scan persists its next Notion cursor before resuming', async () => {
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => new Date('2026-09-15T00:00:00.000Z') });
  const first = await queueMatchReportBackfill({
    store,
    collectSourcePages: async ({ cursors, onPage }) => {
      assert.equal(cursors.match_report.cursor, null);
      await onPage({
        sourceType: 'match_report',
        pages: [reportPage('page-a', '2026-09-14T01:00:00.000Z')],
        nextCursor: 'notion-next-cursor',
        complete: false,
      });
      return { sources: {}, errors: { match_report: 'unavailable' }, retryAfterMs: {} };
    },
  });
  assert.equal(first.state, 'unavailable');
  let state = (await store.readState()).value;
  assert.equal(state.matchEditorialSync.backfill.match_report.cursor, 'notion-next-cursor');
  assert.equal(state.matchEditorialSync.backfill.match_report.sourceScanCompletedAt, null);
  assert.equal((await store.readQueue()).value.items.length, 1);

  const resumed = await queueMatchReportBackfill({
    store,
    collectSourcePages: async ({ cursors, onPage }) => {
      assert.equal(cursors.match_report.cursor, 'notion-next-cursor');
      await onPage({
        sourceType: 'match_report',
        pages: [reportPage('page-b', '2026-09-14T02:00:00.000Z')],
        nextCursor: null,
        complete: true,
      });
      return { sources: { match_report: { complete: true } }, errors: {}, retryAfterMs: {} };
    },
  });
  assert.equal(resumed.state, 'queued');
  state = (await store.readState()).value;
  assert.equal(state.matchEditorialSync.backfill.match_report.cursor, null);
  assert.ok(state.matchEditorialSync.backfill.match_report.sourceScanCompletedAt);
  const jobs = await Promise.all((await store.readQueue()).value.items.map(async (item) => (await store.readJob(item.jobId)).value));
  assert.deepEqual(jobs.map((job) => job.pageId).sort(), ['page-a', 'page-b']);
  assert.ok(jobs.every((job) => job.deliveryOnly === true));

  const noRepeat = await queueMatchReportBackfill({
    store,
    collectSourcePages: async () => { throw new Error('a complete scan must not be re-read'); },
  });
  assert.equal(noRepeat.state, 'already_scanned');
});

test('periodic reconciliation queues only source-versioned report rows without a fixture ID', async () => {
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => new Date('2026-09-15T00:00:00.000Z') });
  await store.updateState((state) => ({
    ...state,
    matchEditorialSync: {
      backfill: {
        match_report: {
          generation: MATCH_REPORT_BACKFILL_GENERATION,
          sourceScanCompletedAt: '2026-09-15T00:00:00.000Z',
        },
      },
    },
  }));
  const result = await queueUnlinkedMatchReportReconciliation({
    store,
    listArticles: async () => ({
      page: 1,
      totalPages: 1,
      items: [
        {
          id: 'notion-match_report-unlinked', type: 'match_report', status: 'published', public: true,
          notion: { updatedAt: '2026-09-14T01:00:00.000Z' }, match: { fixtureId: null },
        },
        {
          id: 'notion-match_report-linked', type: 'match_report', status: 'published', public: true,
          notion: { updatedAt: '2026-09-14T01:00:00.000Z' }, match: { fixtureId: 1557404 },
        },
      ],
    }),
  });
  assert.equal(result.state, 'queued');
  assert.equal(result.candidates, 1);
  assert.equal(result.queued, 1);
  const queued = (await store.readQueue()).value.items;
  assert.equal(queued.length, 1);
  const job = (await store.readJob(queued[0].jobId)).value;
  assert.equal(job.articleId, 'notion-match_report-unlinked');
  assert.equal(job.deliveryOnly, true);
});

test('an unlinked-report reconciliation persists and resumes past its bounded page batch', async () => {
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => new Date('2026-09-15T00:00:00.000Z') });
  await store.updateState((state) => ({
    ...state,
    matchEditorialSync: {
      backfill: {
        match_report: {
          generation: MATCH_REPORT_BACKFILL_GENERATION,
          sourceScanCompletedAt: '2026-09-15T00:00:00.000Z',
        },
      },
    },
  }));
  const calls = [];
  const listArticles = async ({ page }) => {
    calls.push(page);
    return {
      page, totalPages: 11,
      items: [{
        id: `notion-match_report-unlinked-${page}`, type: 'match_report', status: 'published', public: true,
        notion: { updatedAt: '2026-09-14T01:00:00.000Z' }, match: { fixtureId: null },
      }],
    };
  };
  const first = await queueUnlinkedMatchReportReconciliation({ store, listArticles });
  assert.equal(first.state, 'partial');
  assert.equal(first.nextPage, 11);
  assert.deepEqual(calls, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  let state = (await store.readState()).value;
  assert.equal(state.matchEditorialSync.reconciliation.match_report.nextPage, 11);
  assert.equal(state.matchEditorialSync.reconciliation.match_report.lastQueuedAt, undefined);

  calls.length = 0;
  const second = await queueUnlinkedMatchReportReconciliation({ store, listArticles });
  assert.equal(second.state, 'queued');
  assert.deepEqual(calls, [11]);
  state = (await store.readState()).value;
  assert.equal(state.matchEditorialSync.reconciliation.match_report.nextPage, null);
  assert.ok(state.matchEditorialSync.reconciliation.match_report.lastQueuedAt);
});

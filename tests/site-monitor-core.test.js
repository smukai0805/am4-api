import assert from 'node:assert/strict';
import test from 'node:test';

import { createSiteMonitorStore } from '../lib/site-monitor-store.js';
import {
  isTransientBrowserRuntimeRecoveryJob,
  runSiteMonitor,
  siteMonitorSettings,
} from '../lib/site-monitor-core.js';
import { MATCH_EDITORIAL_BACKFILL_GENERATION } from '../lib/match-editorial-sync.js';

test('browser verification gets a bounded forty-second budget for article, match, and list checks', () => {
  const settings = siteMonitorSettings({});
  assert.equal(settings.browserBudgetMs, 40_000);
  assert.ok(settings.browserBudgetMs < settings.maxRunMs);
});

test('only the code-owned browser-runtime migration can use its browser reserve', () => {
  const exact = {
    kind: 'transient_browser_recovery',
    repairGeneration: 'browser-runtime-interruption-recovery-v1',
    trigger: 'transient_browser_runtime_recovery',
    payload: { releaseMonitorDeliveryHold: true },
  };
  assert.equal(isTransientBrowserRuntimeRecoveryJob(exact), true);
  assert.equal(isTransientBrowserRuntimeRecoveryJob({ ...exact, trigger: 'other' }), false);
  assert.equal(isTransientBrowserRuntimeRecoveryJob({ ...exact, repairGeneration: 'other' }), false);
  assert.equal(isTransientBrowserRuntimeRecoveryJob({ ...exact, payload: {} }), false);
});

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

test('a full editorial backfill excludes both source types from delta collection and seeds both checkpoints', async () => {
  const now = () => new Date('2026-09-17T00:00:00.000Z');
  const store = createSiteMonitorStore({ blob: createBlob(), now, uuid: () => 'editorial-owner' });
  let deltaCalls = 0;
  let fullTypes = null;
  const result = await runSiteMonitor({
    store,
    trigger: 'match_editorial_backfill',
    collect: true,
    // Collection is the subject of this test. Prevent the worker from claiming
    // either just-enqueued page in the same deterministic invocation.
    onlyJobIds: ['different-job'],
    now,
    settings: {
      ...siteMonitorSettings({}),
      maxJobsPerRun: 1,
      maxRunMs: 30_000,
      minJobStartMs: 5_000,
    },
    dependencies: {
      collectChanges: async () => {
        deltaCalls += 1;
        return { sources: {}, errors: {}, retryAfterMs: {} };
      },
      collectFullSourcePages: async ({ types, cursors, onPage }) => {
        fullTypes = types;
        assert.equal(cursors.match_report.cursor, null);
        assert.equal(cursors.match_prediction.cursor, null);
        await onPage({
          sourceType: 'match_report',
          pages: [{ id: 'report-page', last_edited_time: '2026-09-16T02:00:00.000Z' }],
          nextCursor: null,
          complete: true,
        });
        await onPage({
          sourceType: 'match_prediction',
          pages: [{ id: 'prediction-page', last_edited_time: '2026-09-16T03:00:00.000Z' }],
          nextCursor: null,
          complete: true,
        });
        return {
          sources: { match_report: { complete: true }, match_prediction: { complete: true } },
          errors: {}, retryAfterMs: {},
        };
      },
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(deltaCalls, 0);
  assert.deepEqual(fullTypes, ['match_report', 'match_prediction']);
  assert.equal(result.collected.backfill.types.match_report.complete, true);
  assert.equal(result.collected.backfill.types.match_prediction.complete, true);
  const state = (await store.readState()).value;
  assert.ok(state.collector.checkpoints.match_report.watermark);
  assert.ok(state.collector.checkpoints.match_prediction.watermark);
  const jobs = await Promise.all((await store.readQueue()).value.items
    .map(async (item) => (await store.readJob(item.jobId)).value));
  assert.deepEqual(jobs.map((job) => job.sourceType).sort(), ['match_prediction', 'match_report']);
});

test('a dedicated editorial recovery resumes only its unfinished full-source cursor without a regular delta read', async () => {
  const now = () => new Date('2026-09-17T01:00:00.000Z');
  const store = createSiteMonitorStore({ blob: createBlob(), now, uuid: () => 'editorial-resume-owner' });
  await store.updateState((state) => ({
    ...state,
    matchEditorialSync: {
      backfill: {
        match_report: {
          generation: MATCH_EDITORIAL_BACKFILL_GENERATION,
          cursor: 'report-resume-cursor',
          scanStartedAt: '2026-09-17T00:00:00.000Z',
          sourceScanCompletedAt: null,
        },
        match_prediction: {
          generation: MATCH_EDITORIAL_BACKFILL_GENERATION,
          sourceScanCompletedAt: '2026-09-17T00:30:00.000Z',
        },
      },
    },
  }));
  const result = await runSiteMonitor({
    store,
    trigger: 'match_editorial_backfill',
    collect: true,
    onlyJobIds: ['different-job'],
    now,
    settings: {
      ...siteMonitorSettings({}),
      maxJobsPerRun: 1,
      maxRunMs: 30_000,
      minJobStartMs: 5_000,
    },
    dependencies: {
      collectChanges: async () => {
        assert.fail('dedicated editorial recovery must not start a regular delta collection');
      },
      collectFullSourcePages: async ({ types, cursors, onPage }) => {
        assert.deepEqual(types, ['match_report']);
        assert.equal(cursors.match_report.cursor, 'report-resume-cursor');
        await onPage({
          sourceType: 'match_report',
          pages: [{ id: 'report-resumed-page', last_edited_time: '2026-09-16T02:00:00.000Z' }],
          nextCursor: null,
          complete: true,
        });
        return { sources: { match_report: { complete: true } }, errors: {}, retryAfterMs: {} };
      },
    },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.collected.backfill.types.match_report.state, 'queued');
  assert.equal(result.collected.backfill.types.match_prediction.state, 'already_scanned');
  const state = (await store.readState()).value;
  assert.equal(state.matchEditorialSync.backfill.match_report.cursor, null);
  assert.ok(state.matchEditorialSync.backfill.match_report.sourceScanCompletedAt);
  const jobs = await Promise.all((await store.readQueue()).value.items
    .map(async (item) => (await store.readJob(item.jobId)).value));
  assert.deepEqual(jobs.map((job) => job.pageId), ['report-resumed-page']);
});

test('an interrupted prediction delta scan resumes its persisted Notion cursor after a new monitor store instance', async () => {
  const blob = createBlob();
  const now = () => new Date('2026-09-17T01:00:00.000Z');
  const settings = {
    ...siteMonitorSettings({}), maxJobsPerRun: 1, maxRunMs: 30_000, minJobStartMs: 5_000,
  };
  const firstStore = createSiteMonitorStore({ blob, now, uuid: () => 'cursor-owner-one' });
  let firstInput = null;
  const first = await runSiteMonitor({
    store: firstStore,
    trigger: 'manual',
    collect: true,
    onlyJobIds: ['different-job'],
    now,
    settings,
    dependencies: {
      collectChanges: async (input) => {
        firstInput = input;
        await input.onPage({
          sourceType: 'match_prediction',
          pages: [{ id: 'prediction-page-one', last_edited_time: '2026-09-17T00:30:00.000Z' }],
          nextCursor: 'prediction-cursor-two',
          complete: false,
          since: '2026-09-16T23:00:00.000Z',
        });
        return { sources: {}, errors: {}, retryAfterMs: {} };
      },
    },
  });
  assert.equal(first.status, 'completed');
  assert.equal(firstInput.cursors.match_prediction, undefined);
  const persisted = (await firstStore.readState()).value.collector.cursors.match_prediction;
  assert.deepEqual(persisted, {
    cursor: 'prediction-cursor-two',
    since: '2026-09-16T23:00:00.000Z',
    updatedAt: '2026-09-17T01:00:00.000Z',
  });

  // A fresh store simulates a new Vercel Function rather than relying on the
  // warm process that wrote the first page.
  const secondStore = createSiteMonitorStore({ blob, now, uuid: () => 'cursor-owner-two' });
  let secondInput = null;
  const second = await runSiteMonitor({
    store: secondStore,
    trigger: 'manual',
    collect: true,
    onlyJobIds: ['different-job'],
    now,
    settings,
    dependencies: {
      collectChanges: async (input) => {
        secondInput = input;
        return { sources: {}, errors: {}, retryAfterMs: {} };
      },
    },
  });
  assert.equal(second.status, 'completed');
  assert.deepEqual(secondInput.cursors.match_prediction, persisted);
});

const fixture = {
  id: 1550125, date: '2026-09-15', kickoff: '2026-09-15T18:45:00Z', timezone: 'UTC',
  competition: 'Premier League',
  home: { id: 42, name: 'Arsenal', logo: 'https://media.api-sports.io/football/teams/42.png' },
  away: { id: 49, name: 'Chelsea', logo: 'https://media.api-sports.io/football/teams/49.png' },
};

function sourceArticle(type) {
  return {
    id: `notion-${type}-page1`, type, status: 'published', public: true,
    title: '監視対象', body: '新しい本文の末尾マーカー。',
    notion: { pageId: 'page-1', updatedAt: 'v1', state: '公開済' },
    match: {
      fixtureId: null, competition: 'Premier League', date: '2026-09-15',
      homeTeam: 'Arsenal', awayTeam: 'Chelsea',
      matchKey: 'Premier League|2026-09-15|Arsenal|Chelsea',
      canonicalKey: 'premierleague|2026-09-15|arsenal|chelsea', identityVersion: 2,
    },
    ...(type === 'match_prediction' ? {
      prediction: { keyPlayers: 'Arsenal：Bukayo Saka — 理由。', keyPlayerCards: [{ playerName: 'Bukayo Saka', teamId: 42, side: 'home', reason: '理由。', resolved: false }] },
    } : {
      report: { keyFigures: 'MOTM：Cole Palmer（Chelsea）：決定的な仕事をした。' },
    }),
  };
}

function previousArticle(type) {
  return {
    ...sourceArticle(type), body: '古い本文。', notion: { pageId: 'page-1', updatedAt: 'v0', state: '公開済' },
  };
}

function fixtureResolution() {
  return { state: 'resolved', fixture, method: 'fixture_id' };
}

async function runRepairCase(type, {
  mutateArticle = (article) => article,
  hydrateReportOverride = null,
  deliveryOnly = false,
  trigger = 'test',
  notifyOverride = null,
} = {}) {
  const blob = createBlob();
  let clock = new Date('2026-09-14T00:00:00.000Z');
  let sequence = 0;
  const store = createSiteMonitorStore({ blob, now: () => clock, uuid: () => `run-owner-${++sequence}` });
  const database = new Map([[sourceArticle(type).id, previousArticle(type)]]);
  const sidecars = [];
  const notifications = [];
  const browserCalls = [];
  const article = mutateArticle(sourceArticle(type));
  await store.enqueue({
    kind: 'notion_page', pageId: 'page-1', sourceType: type, sourceVersion: 'v1',
    deliveryOnly, trigger, priority: 10,
  });
  const dependencies = {
    collectChanges: async () => ({ sources: {}, errors: {} }),
    createSyncStore: () => ({ getArticle: async () => null, saveArticle: async () => {}, flush: async () => ({}) }),
    syncPage: async (options) => {
      const old = database.get(article.id);
      const allowed = await options.beforeWrite({ existingArticle: old, article, page: { last_edited_time: 'v1' } });
      if (allowed === false) return { outcome: 'write_cancelled' };
      database.set(article.id, structuredClone(article));
      return { outcome: 'updated', article: structuredClone(article), articleId: article.id, sourceVersion: 'v1' };
    },
    getArticle: async (id) => database.get(id) ? structuredClone(database.get(id)) : null,
    saveArticle: async (value) => { database.set(value.id, structuredClone(value)); },
    resolveFixture: async () => fixtureResolution(),
    associationRepair: (value) => ({
      ...value,
      match: { ...value.match, fixtureId: fixture.id, homeTeamId: fixture.home.id, awayTeamId: fixture.away.id },
    }),
    getFixture: async () => fixture,
    hydratePrediction: async (value) => ({
      ...value,
      prediction: {
        ...value.prediction,
        keyPlayerCards: [{
          playerName: 'Bukayo Saka', playerId: 100, teamId: 42, side: 'home', clubName: 'Arsenal',
          reason: '理由。', photoUrl: 'https://media.api-sports.io/football/players/100.png',
          logoUrl: 'https://media.api-sports.io/football/teams/42.png', resolved: true,
        }],
      },
    }),
    hydrateReport: async (value) => hydrateReportOverride
      ? hydrateReportOverride(value)
      : ({
      ...value,
      report: {
        ...value.report,
        motmCard: {
          playerName: 'Cole Palmer', playerId: 200, teamId: 49, side: 'away', clubName: 'Chelsea',
          reason: '決定的な仕事をした。', photoUrl: 'https://media.api-sports.io/football/players/200.png',
          logoUrl: 'https://media.api-sports.io/football/teams/49.png', resolved: true,
        },
      },
    }),
    readStoredPredictionCards: async () => [],
    saveStoredPredictionCards: async (value) => { sidecars.push(value.id); return true; },
    getAvailability: async () => ({ availability: { [fixture.id]: [type === 'match_prediction' ? 'prediction' : 'report'] }, matchAvailability: {} }),
    browserVerify: async () => {
      browserCalls.push('called');
      return { status: 'passed', checks: { initialHtml: true, hydrated: true } };
    },
    notify: notifyOverride || (async (notice) => { notifications.push(notice); return { state: 'delivered' }; }),
    listArticles: async () => ({ items: [] }),
  };
  const result = await runSiteMonitor({
    store, trigger: 'manual', collect: false, now: () => clock, dependencies,
    settings: {
      maxJobsPerRun: 10, maxRepairAttemptsPerVersion: 2, maxTransportRetries: 1,
      maxRepairsPerDay: 20, maxBrowserLaunchesPerDay: 10, maxApiCallsPerDay: 100,
      lockTtlMs: 60_000, jobLeaseMs: 60_000, browserEnabled: true,
    },
  });
  return {
    result, database, sidecars, notifications, browserCalls, store, article,
    setClock: (value) => { clock = new Date(value); },
  };
}

test('acceptance A+B+C: a stale article is resynchronised, relinked, media-repaired, then browser-rechecked', async () => {
  const { result, database, sidecars, notifications, article } = await runRepairCase('match_prediction');
  const repaired = database.get(article.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.jobs[0].status, 'completed');
  assert.equal(repaired.body, '新しい本文の末尾マーカー。'); // A full article body, not a summary
  assert.equal(repaired.match.fixtureId, fixture.id); // B durable linkage for labels/link
  assert.equal(repaired.prediction.keyPlayerCards[0].playerId, 100); // C structured first-paint media
  assert.deepEqual(sidecars, [article.id]);
  assert.deepEqual(notifications, []);
  assert.ok(result.jobs[0].result.repairs.some((item) => item.kind === 'article_sync'));
  assert.ok(result.jobs[0].result.repairs.some((item) => item.kind === 'fixture_association'));
  assert.ok(result.jobs[0].result.repairs.some((item) => item.kind === 'player_media'));
});

test('acceptance C includes report MOTM structured media while preserving the selected person and rationale', async () => {
  const { result, database, article } = await runRepairCase('match_report');
  const repaired = database.get(article.id);
  assert.equal(result.status, 'completed');
  assert.equal(repaired.report.motmCard.playerName, 'Cole Palmer');
  assert.equal(repaired.report.motmCard.playerId, 200);
  assert.match(repaired.report.motmCard.reason, /決定的な仕事/);
});

test('a confirmed notification 429 is retried once through the durable minute-worker lane', async () => {
  let attempts = 0;
  const notify = async () => {
    attempts += 1;
    return attempts === 1
      ? { state: 'failed', status: 429, retryable: true, retryAfterMs: 60_000 }
      : { state: 'delivered', deliveries: [{ channel: 'notion_audit', status: 200 }] };
  };
  const { result, store, setClock } = await runRepairCase('match_report', {
    trigger: 'report_generation_browser_validation',
    notifyOverride: notify,
  });
  assert.equal(result.jobs[0].status, 'completed');
  assert.equal(attempts, 1);
  const queued = (await store.readQueue()).value.items;
  assert.equal(queued.length, 1);
  assert.equal((await store.readJob(queued[0].jobId)).value.kind, 'notification_delivery');

  setClock('2026-09-14T00:01:01.000Z');
  const retried = await runSiteMonitor({
    store,
    trigger: 'editorial_continuation',
    collect: false,
    claimJobKinds: ['notification_delivery'],
    claimDeliveryOnly: true,
    now: () => new Date('2026-09-14T00:01:01.000Z'),
    dependencies: { notify, listArticles: async () => ({ items: [] }) },
    settings: {
      maxJobsPerRun: 2, maxRepairAttemptsPerVersion: 2, maxTransportRetries: 1,
      maxRepairsPerDay: 20, maxBrowserLaunchesPerDay: 10, maxApiCallsPerDay: 100,
      lockTtlMs: 60_000, jobLeaseMs: 60_000, browserEnabled: false,
    },
  });
  assert.equal(retried.status, 'completed');
  assert.equal(retried.jobs[0].result.notificationDelivery.delivery.state, 'delivered');
  assert.equal(attempts, 2);
  assert.equal((await store.readQueue()).value.items.length, 0);
});

test('a delivery-only source job publishes, links, and verifies the reader contract without waiting for Chromium', async () => {
  const { result, database, browserCalls, article } = await runRepairCase('match_report', { deliveryOnly: true });
  const repaired = database.get(article.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.jobs[0].status, 'completed');
  assert.equal(repaired.body, '新しい本文の末尾マーカー。');
  assert.equal(repaired.match.fixtureId, fixture.id);
  assert.equal(repaired.report.motmCard.playerName, 'Cole Palmer');
  assert.deepEqual(browserCalls, []);
});

test('a delivery-only reconciliation job skips the provider when a source job already persisted a verified fixture link', async () => {
  const blob = createBlob();
  const store = createSiteMonitorStore({ blob, now: () => new Date('2026-09-14T00:00:00.000Z'), uuid: () => 'reconciliation-owner' });
  const article = {
    ...sourceArticle('match_report'),
    match: {
      ...sourceArticle('match_report').match,
      fixtureId: fixture.id,
      homeTeamId: fixture.home.id,
      awayTeamId: fixture.away.id,
      identityVersion: 2,
    },
  };
  const database = new Map([[article.id, article]]);
  await store.enqueue({
    kind: 'article_validation', articleId: article.id, sourceType: 'match_report', sourceVersion: 'v1',
    deliveryOnly: true, repairGeneration: 'match-editorial-match_report-association-v5-2026-09-14', priority: 45,
  });
  let fixtureLookups = 0;
  const result = await runSiteMonitor({
    store, trigger: 'manual', collect: false,
    dependencies: {
      getArticle: async (id) => structuredClone(database.get(id)),
      getAvailability: async () => ({ availability: { [fixture.id]: ['report'] }, matchAvailability: {} }),
      resolveFixture: async () => { fixtureLookups += 1; throw new Error('already-linked reconciliation must not call provider'); },
      notify: async () => ({ state: 'delivered' }),
      listArticles: async () => ({ items: [] }),
    },
    settings: {
      maxJobsPerRun: 1, maxRepairAttemptsPerVersion: 2, maxTransportRetries: 1,
      maxRepairsPerDay: 20, maxBrowserLaunchesPerDay: 10, maxApiCallsPerDay: 100,
      lockTtlMs: 60_000, jobLeaseMs: 60_000, browserEnabled: true,
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.jobs[0].status, 'completed');
  assert.equal(result.jobs[0].result.fixture.id, fixture.id);
  assert.equal(fixtureLookups, 0);
});

test('a stale delivery-only Notion job skips external reads only after its exact persisted page is current, linked, and visible', async () => {
  const blob = createBlob();
  const store = createSiteMonitorStore({ blob, now: () => new Date('2026-09-14T00:00:00.000Z'), uuid: () => 'stale-source-owner' });
  const article = {
    ...sourceArticle('match_report'),
    notion: { ...sourceArticle('match_report').notion, updatedAt: '2026-09-14T10:00:00.000Z' },
    match: {
      ...sourceArticle('match_report').match,
      fixtureId: fixture.id,
      homeTeamId: fixture.home.id,
      awayTeamId: fixture.away.id,
      identityVersion: 2,
    },
  };
  const database = new Map([[article.id, article]]);
  await store.enqueue({
    kind: 'notion_page', pageId: 'page-1', sourceType: 'match_report',
    sourceVersion: '2026-09-14T09:00:00.000Z', deliveryOnly: true,
    repairGeneration: MATCH_EDITORIAL_BACKFILL_GENERATION, priority: 70,
  });
  let notionReads = 0;
  let fixtureLookups = 0;
  const result = await runSiteMonitor({
    store, trigger: 'manual', collect: false,
    dependencies: {
      getArticle: async (id) => structuredClone(database.get(id)),
      getAvailability: async () => ({ availability: { [fixture.id]: ['report'] }, matchAvailability: {} }),
      syncPage: async () => { notionReads += 1; throw new Error('delivered stale job must not read Notion'); },
      resolveFixture: async () => { fixtureLookups += 1; throw new Error('delivered stale job must not read provider'); },
      notify: async () => ({ state: 'delivered' }),
      listArticles: async () => ({ items: [] }),
    },
    settings: {
      maxJobsPerRun: 1, maxRepairAttemptsPerVersion: 2, maxTransportRetries: 1,
      maxRepairsPerDay: 20, maxBrowserLaunchesPerDay: 10, maxApiCallsPerDay: 100,
      lockTtlMs: 60_000, jobLeaseMs: 60_000, browserEnabled: true,
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.jobs[0].status, 'completed');
  assert.equal(result.jobs[0].result.state, 'superseded');
  assert.equal(result.jobs[0].result.reason, 'already_delivered_source_version');
  assert.equal(result.jobs[0].result.fixture.id, fixture.id);
  assert.equal(notionReads, 0);
  assert.equal(fixtureLookups, 0);
});

test('a Notion page with incomplete availability skips neither repair nor verification', async () => {
  const blob = createBlob();
  const store = createSiteMonitorStore({ blob, now: () => new Date('2026-09-14T00:00:00.000Z'), uuid: () => 'incomplete-delivery-owner' });
  const article = {
    ...sourceArticle('match_report'),
    notion: { ...sourceArticle('match_report').notion, updatedAt: '2026-09-14T10:00:00.000Z' },
    match: {
      ...sourceArticle('match_report').match,
      fixtureId: fixture.id,
      homeTeamId: fixture.home.id,
      awayTeamId: fixture.away.id,
      identityVersion: 2,
    },
  };
  const database = new Map([[article.id, article]]);
  await store.enqueue({
    kind: 'notion_page', pageId: 'page-1', sourceType: 'match_report',
    sourceVersion: '2026-09-14T09:00:00.000Z', deliveryOnly: true,
    repairGeneration: MATCH_EDITORIAL_BACKFILL_GENERATION, priority: 70,
  });
  let notionReads = 0;
  let fixtureLookups = 0;
  const result = await runSiteMonitor({
    store, trigger: 'manual', collect: false,
    dependencies: {
      getArticle: async (id) => structuredClone(database.get(id)),
      getAvailability: async () => ({ availability: {}, matchAvailability: {} }),
      // The current persisted source revision can be reused for the fixture
      // retry, but it may never be promoted to a completed delivery while the
      // reader-facing card/index is absent.
      syncPage: async () => { notionReads += 1; throw new Error('current mirror must avoid a duplicate Notion body read'); },
      resolveFixture: async () => { fixtureLookups += 1; return fixtureResolution(); },
      associationRepair: (value) => value,
      hydrateReport: async (value) => value,
      notify: async () => ({ state: 'delivered' }),
      listArticles: async () => ({ items: [] }),
    },
    settings: {
      maxJobsPerRun: 1, maxRepairAttemptsPerVersion: 2, maxTransportRetries: 1,
      maxRepairsPerDay: 20, maxBrowserLaunchesPerDay: 10, maxApiCallsPerDay: 100,
      lockTtlMs: 60_000, jobLeaseMs: 60_000, browserEnabled: true,
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(notionReads, 0);
  assert.equal(fixtureLookups, 1);
  assert.equal(result.jobs[0].status, 'deferred');
  assert.equal(result.jobs[0].result.state, 'verification_failed');
  const queued = (await store.readQueue()).value.items;
  assert.equal(queued.length, 1);
});

test('a current persisted unlinked Notion page resolves its fixture without redownloading the same Notion body', async () => {
  const blob = createBlob();
  const store = createSiteMonitorStore({ blob, now: () => new Date('2026-09-14T00:00:00.000Z'), uuid: () => 'persisted-association-owner' });
  const article = {
    ...sourceArticle('match_report'),
    notion: { ...sourceArticle('match_report').notion, updatedAt: '2026-09-14T10:00:00.000Z' },
  };
  const database = new Map([[article.id, article]]);
  await store.enqueue({
    kind: 'notion_page', pageId: 'page-1', sourceType: 'match_report',
    sourceVersion: '2026-09-14T09:00:00.000Z', deliveryOnly: true,
    repairGeneration: MATCH_EDITORIAL_BACKFILL_GENERATION, priority: 70,
  });
  let notionReads = 0;
  let fixtureLookups = 0;
  const result = await runSiteMonitor({
    store, trigger: 'manual', collect: false,
    dependencies: {
      getArticle: async (id) => structuredClone(database.get(id)),
      saveArticle: async (value) => { database.set(value.id, structuredClone(value)); },
      getAvailability: async () => ({ availability: { [fixture.id]: ['report'] }, matchAvailability: {} }),
      syncPage: async () => { notionReads += 1; throw new Error('current mirror must avoid a duplicate Notion body read'); },
      resolveFixture: async () => { fixtureLookups += 1; return fixtureResolution(); },
      associationRepair: (value) => ({
        ...value,
        match: {
          ...value.match,
          fixtureId: fixture.id,
          homeTeamId: fixture.home.id,
          awayTeamId: fixture.away.id,
          identityVersion: 2,
        },
      }),
      hydrateReport: async (value) => value,
      notify: async () => ({ state: 'delivered' }),
      listArticles: async () => ({ items: [] }),
    },
    settings: {
      maxJobsPerRun: 1, maxRepairAttemptsPerVersion: 2, maxTransportRetries: 1,
      maxRepairsPerDay: 20, maxBrowserLaunchesPerDay: 10, maxApiCallsPerDay: 100,
      lockTtlMs: 60_000, jobLeaseMs: 60_000, browserEnabled: true,
    },
  });
  const repaired = database.get(article.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.jobs[0].status, 'completed');
  assert.equal(notionReads, 0);
  assert.equal(fixtureLookups, 1);
  assert.equal(repaired.match.fixtureId, fixture.id);
  assert.ok(result.jobs[0].result.repairs.some((item) => item.kind === 'persisted_source_association'));
  assert.ok(result.jobs[0].result.repairs.some((item) => item.kind === 'fixture_association'));
});

test('a Notion page preflight retains hidden, older, and mismatched stored records for normal source sync', async () => {
  const unsafeRecords = [
    {
      name: 'hidden record',
      mutate: (article) => ({ ...article, public: false }),
    },
    {
      name: 'non-published record',
      mutate: (article) => ({ ...article, status: 'draft' }),
    },
    {
      name: 'older source revision',
      mutate: (article) => ({ ...article, notion: { ...article.notion, updatedAt: '2026-09-14T08:00:00.000Z' } }),
    },
    {
      name: 'different Notion page',
      mutate: (article) => ({ ...article, notion: { ...article.notion, pageId: 'page-2' } }),
    },
  ];
  for (const unsafe of unsafeRecords) {
    const store = createSiteMonitorStore({ blob: createBlob(), now: () => new Date('2026-09-14T00:00:00.000Z'), uuid: () => `unsafe-${unsafe.name}` });
    const current = {
      ...sourceArticle('match_report'),
      notion: { ...sourceArticle('match_report').notion, updatedAt: '2026-09-14T10:00:00.000Z' },
      match: {
        ...sourceArticle('match_report').match,
        fixtureId: fixture.id,
        homeTeamId: fixture.home.id,
        awayTeamId: fixture.away.id,
        identityVersion: 2,
      },
    };
    const article = unsafe.mutate(current);
    await store.enqueue({
      kind: 'notion_page', pageId: 'page-1', sourceType: 'match_report',
      sourceVersion: '2026-09-14T09:00:00.000Z', deliveryOnly: true,
      repairGeneration: MATCH_EDITORIAL_BACKFILL_GENERATION, priority: 70,
    });
    let notionReads = 0;
    const result = await runSiteMonitor({
      store, trigger: 'manual', collect: false,
      dependencies: {
        getArticle: async () => structuredClone(article),
        getAvailability: async () => ({ availability: { [fixture.id]: ['report'] }, matchAvailability: {} }),
        syncPage: async () => {
          notionReads += 1;
          return {
            outcome: 'source_changed', page: { id: 'page-1' }, sourceType: 'match_report',
            sourceVersion: '2026-09-14T11:00:00.000Z',
          };
        },
        notify: async () => ({ state: 'delivered' }),
        listArticles: async () => ({ items: [] }),
      },
      settings: {
        maxJobsPerRun: 1, maxRepairAttemptsPerVersion: 2, maxTransportRetries: 1,
        maxRepairsPerDay: 20, maxBrowserLaunchesPerDay: 10, maxApiCallsPerDay: 100,
        lockTtlMs: 60_000, jobLeaseMs: 60_000, browserEnabled: true,
      },
    });
    assert.equal(result.status, 'completed', unsafe.name);
    assert.equal(notionReads, 1, unsafe.name);
  }
});

test('a Notion version change preserves the source delivery lane and repair generation', async () => {
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => new Date('2026-09-14T00:00:00.000Z'), uuid: () => 'source-change-owner' });
  await store.enqueue({
    kind: 'notion_page', pageId: 'report-page', sourceType: 'match_report', sourceVersion: 'v1',
    deliveryOnly: true, repairGeneration: 'notion-match-report-sync-v4', priority: 70,
  });
  const result = await runSiteMonitor({
    store, trigger: 'manual', collect: false,
    dependencies: {
      createSyncStore: () => ({}),
      // No durable mirror exists for this page, so the source_changed path
      // must remain reachable independently of the production Blob adapter.
      getArticle: async () => null,
      syncPage: async () => ({
        outcome: 'source_changed', page: { id: 'report-page' }, sourceType: 'match_report', sourceVersion: 'v2',
      }),
      notify: async () => ({ state: 'delivered' }),
    },
    settings: {
      maxJobsPerRun: 1, maxRepairAttemptsPerVersion: 2, maxTransportRetries: 1,
      maxRepairsPerDay: 20, maxBrowserLaunchesPerDay: 10, maxApiCallsPerDay: 100,
      lockTtlMs: 60_000, jobLeaseMs: 60_000, browserEnabled: true,
    },
  });
  assert.equal(result.status, 'completed');
  const queued = (await store.readQueue()).value.items;
  assert.equal(queued.length, 1);
  const replacement = (await store.readJob(queued[0].jobId)).value;
  assert.equal(replacement.sourceVersion, 'v2');
  assert.equal(replacement.deliveryOnly, true);
  assert.equal(replacement.repairGeneration, 'notion-match-report-sync-v4');
});

test('an unselected MOTM mention never creates a false player-media repair or alert', async () => {
  const { result, notifications, article } = await runRepairCase('match_report', {
    mutateArticle: (value) => ({
      ...value,
      report: { keyFigures: 'MOTMは確認できないため、選出は行わない。' },
    }),
    hydrateReportOverride: async (value) => value,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.jobs[0].status, 'completed');
  assert.equal(article.report.motmCard, undefined);
  assert.equal(result.jobs[0].result.issues, undefined);
  assert.equal(result.jobs[0].result.repairs.some((item) => item.kind === 'player_media'), false);
  assert.deepEqual(notifications, []);
});

test('a worker that loses ownership before the prediction-card sidecar write leaves that sidecar untouched', async () => {
  const blob = createBlob();
  const store = createSiteMonitorStore({ blob, now: () => new Date('2026-09-14T00:00:00.000Z'), uuid: () => 'owner' });
  const article = sourceArticle('match_prediction');
  article.match = { ...article.match, fixtureId: fixture.id, homeTeamId: fixture.home.id, awayTeamId: fixture.away.id };
  const previous = previousArticle('match_prediction');
  const database = new Map([[article.id, previous]]);
  const sidecars = [];
  await store.enqueue({ kind: 'notion_page', pageId: 'page-1', sourceType: article.type, sourceVersion: 'v1' });

  const originalRenewLease = store.renewLease.bind(store);
  let renewalCalls = 0;
  store.renewLease = async (...args) => {
    renewalCalls += 1;
    // Initial renewal; two sync gates; two article-media gates; then the
    // gate immediately before saveStoredPredictionCards.
    if (renewalCalls === 6) return null;
    return originalRenewLease(...args);
  };
  const result = await runSiteMonitor({
    store, trigger: 'manual', collect: false,
    dependencies: {
      collectChanges: async () => ({ sources: {}, errors: {} }),
      createSyncStore: () => ({}),
      syncPage: async (options) => {
        const allowed = await options.beforeWrite({ existingArticle: database.get(article.id), article, page: { last_edited_time: 'v1' } });
        if (!allowed) return { outcome: 'write_cancelled' };
        database.set(article.id, structuredClone(article));
        return { outcome: 'updated', article: structuredClone(article), articleId: article.id, sourceVersion: 'v1' };
      },
      getArticle: async (id) => structuredClone(database.get(id)),
      saveArticle: async (value) => database.set(value.id, structuredClone(value)),
      resolveFixture: async () => fixtureResolution(),
      associationRepair: (value) => value,
      getFixture: async () => fixture,
      hydratePrediction: async (value) => ({
        ...value,
        prediction: {
          ...value.prediction,
          keyPlayerCards: [{
            playerName: 'Bukayo Saka', playerId: 100, teamId: fixture.home.id, side: 'home', clubName: 'Arsenal',
            reason: '理由。', photoUrl: 'https://media.api-sports.io/football/players/100.png', logoUrl: fixture.home.logo, resolved: true,
          }],
        },
      }),
      readStoredPredictionCards: async () => [],
      saveStoredPredictionCards: async () => { sidecars.push('written'); },
      getAvailability: async () => ({ availability: { [fixture.id]: ['prediction'] }, matchAvailability: {} }),
      browserVerify: async () => ({ status: 'passed' }),
      notify: async () => ({ state: 'delivered' }),
      listArticles: async () => ({ items: [] }),
    },
    settings: {
      maxJobsPerRun: 10, maxRepairAttemptsPerVersion: 2, maxTransportRetries: 1,
      maxRepairsPerDay: 20, maxBrowserLaunchesPerDay: 10, maxApiCallsPerDay: 100,
      lockTtlMs: 60_000, jobLeaseMs: 60_000, browserEnabled: true,
    },
  });

  assert.equal(result.status, 'attention');
  assert.equal(result.jobs[0].status, 'lease_lost');
  assert.deepEqual(sidecars, []);
});

test('a deliberate deployment recheck is browser-only and cannot bypass the per-version repair ceiling', async () => {
  const blob = createBlob();
  const store = createSiteMonitorStore({ blob, now: () => new Date('2026-09-14T00:00:00.000Z'), uuid: () => 'owner' });
  const source = sourceArticle('match_prediction');
  const article = {
    ...source,
    match: { ...source.match, fixtureId: fixture.id, homeTeamId: fixture.home.id, awayTeamId: fixture.away.id },
    prediction: {
      ...source.prediction,
      keyPlayerCards: [{
        playerName: 'Bukayo Saka', playerId: 100, teamId: fixture.home.id, side: 'home', clubName: 'Arsenal',
        reason: '理由。', photoUrl: 'https://media.api-sports.io/football/players/100.png',
        logoUrl: fixture.home.logo, resolved: true,
      }],
    },
  };
  await store.enqueue({
    kind: 'deployment_validation', deploymentId: 'dpl-safe', validationId: 'manual-recheck-1',
    verificationOnly: true, trigger: 'manual_deployment_recheck', priority: 90,
  });
  const writes = [];
  const result = await runSiteMonitor({
    store, trigger: 'manual_deployment_recheck', deploymentId: 'dpl-safe', collect: false,
    dependencies: {
      listArticles: async () => ({ items: [structuredClone(article)] }),
      getArticle: async () => structuredClone(article),
      saveArticle: async (value) => writes.push(value),
      resolveFixture: async () => fixtureResolution(),
      associationRepair: () => { throw new Error('verification-only recheck must not repair fixture data'); },
      hydratePrediction: async () => { throw new Error('verification-only recheck must not resolve player media'); },
      getAvailability: async () => ({ availability: { [fixture.id]: ['prediction'] }, matchAvailability: {} }),
      browserVerify: async () => ({ status: 'passed', checks: { mobileFirstPaint: true } }),
      notify: async () => ({ state: 'delivered' }),
    },
    settings: { maxJobsPerRun: 10, maxRepairAttemptsPerVersion: 2, maxTransportRetries: 1, maxRepairsPerDay: 20, maxBrowserLaunchesPerDay: 10, maxApiCallsPerDay: 100, lockTtlMs: 60_000, jobLeaseMs: 60_000, browserEnabled: true },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.jobs.length, 2);
  assert.deepEqual(writes, []);
  assert.deepEqual(result.jobs[1].result.repairs, []);
});

test('a legacy article-validation job without a persisted target is retired without an alert or editorial write', async () => {
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => new Date('2026-09-14T00:00:00.000Z'), uuid: () => 'owner' });
  await store.enqueue({
    id: 'legacy-article-validation', kind: 'article_validation', sourceType: 'match_report',
    sourceVersion: 'v1', deploymentId: 'dpl-legacy', priority: 90,
  });
  let notified = false;
  const result = await runSiteMonitor({
    store, trigger: 'manual', deploymentId: 'dpl-legacy', collect: false,
    dependencies: { notify: async () => { notified = true; return { state: 'delivered' }; } },
    settings: { maxJobsPerRun: 1, maxRepairAttemptsPerVersion: 2, maxTransportRetries: 1, maxRepairsPerDay: 20, maxBrowserLaunchesPerDay: 10, maxApiCallsPerDay: 100, lockTtlMs: 60_000, jobLeaseMs: 60_000, browserEnabled: true },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.jobs[0].result.state, 'superseded');
  assert.equal(result.jobs[0].result.reason, 'legacy_article_target_missing');
  assert.equal(notified, false);
});

test('a worker stops claiming jobs before its deadline and leaves the remaining durable queue for the next run', async () => {
  let clock = new Date('2026-09-14T00:00:00.000Z');
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => clock, uuid: () => `owner-${clock.getTime()}` });
  await store.enqueue({ kind: 'notion_page', pageId: 'story-1', sourceType: 'am4_story', sourceVersion: 'v1', priority: 10 });
  await store.enqueue({ kind: 'notion_page', pageId: 'story-2', sourceType: 'am4_story', sourceVersion: 'v1', priority: 10 });
  const articleFor = (pageId) => ({
    id: `notion-am4_story-${pageId}`, type: 'am4_story', status: 'published', public: true,
    title: pageId, body: '本文末尾。', notion: { pageId, updatedAt: 'v1', state: '公開済' },
  });
  const articles = new Map();
  let browserCalls = 0;
  const result = await runSiteMonitor({
    store, trigger: 'manual', collect: false, now: () => clock,
    dependencies: {
      createSyncStore: () => ({}),
      syncPage: async ({ pageId }) => {
        const article = articleFor(pageId);
        articles.set(article.id, article);
        // The first job consumes most of this Function's safe budget. A
        // second job must remain unclaimed rather than risking the platform
        // timeout and losing its queue lease.
        clock = new Date(clock.getTime() + 45_000);
        return { outcome: 'created', article, articleId: article.id, sourceVersion: 'v1' };
      },
      getArticle: async (id) => structuredClone(articles.get(id)),
      saveArticle: async (article) => articles.set(article.id, structuredClone(article)),
      browserVerify: async () => { browserCalls += 1; return { status: 'passed' }; },
      notify: async () => ({ state: 'delivered' }),
      listArticles: async () => ({ items: [] }),
    },
    settings: {
      maxJobsPerRun: 10, maxRunMs: 60_000, minJobStartMs: 20_000,
      maxRepairAttemptsPerVersion: 2, maxTransportRetries: 1,
      maxRepairsPerDay: 20, maxBrowserLaunchesPerDay: 10, maxApiCallsPerDay: 100,
      lockTtlMs: 60_000, jobLeaseMs: 60_000, browserEnabled: true,
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].status, 'deferred');
  assert.equal(result.jobs[0].result.state, 'deferred_budget');
  assert.equal(browserCalls, 0);
  assert.equal(result.timeBudgetExhausted, true);
  assert.equal((await store.readQueue()).value.items.length, 2);
});

test('an actual Notion request cap defers the same source version without launching a browser or consuming a repair attempt', async () => {
  const clock = new Date('2026-09-14T00:00:00.000Z');
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => clock, uuid: () => 'quota-owner' });
  await store.enqueue({ kind: 'notion_page', pageId: 'page-quota', sourceType: 'am4_story', sourceVersion: 'v1', priority: 10 });
  let browserCalls = 0;
  const result = await runSiteMonitor({
    store, trigger: 'manual', collect: false, now: () => clock,
    dependencies: {
      createSyncStore: () => ({}),
      syncPage: async ({ consumeRequest }) => {
        assert.equal((await consumeRequest()).ok, true);
        const denied = await consumeRequest();
        assert.equal(denied.ok, false);
        return { outcome: 'usage_limit', quota: denied };
      },
      browserVerify: async () => { browserCalls += 1; return { status: 'passed' }; },
      notify: async () => ({ state: 'delivered' }),
    },
    settings: {
      maxJobsPerRun: 1, maxApiCallsPerRun: 1, maxRunMs: 60_000, minJobStartMs: 20_000,
      maxRepairAttemptsPerVersion: 2, maxTransportRetries: 1,
      maxRepairsPerDay: 20, maxBrowserLaunchesPerDay: 10, maxApiCallsPerDay: 100,
      lockTtlMs: 60_000, jobLeaseMs: 60_000, browserEnabled: true,
    },
  });
  assert.equal(result.status, 'attention');
  assert.equal(result.jobs[0].status, 'deferred');
  assert.equal(result.jobs[0].result.state, 'quota_exceeded');
  assert.equal(browserCalls, 0);
  assert.equal(result.usage.apiCalls, 1);
  assert.equal((await store.readQueue()).value.items.length, 1);
});

test('the daily browser launch cap defers visual validation to JST midnight without blocking its source version', async () => {
  const clock = new Date('2026-09-14T00:00:00.000Z');
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => clock, uuid: () => 'browser-cap-owner' });
  const article = sourceArticle('am4_story');
  const queued = await store.enqueue({
    kind: 'article_validation', articleId: article.id, sourceType: article.type,
    sourceVersion: 'v1', priority: 80,
  });
  let browserCalls = 0;
  const result = await runSiteMonitor({
    store, trigger: 'manual', collect: false, now: () => clock,
    dependencies: {
      getArticle: async () => structuredClone(article),
      browserVerify: async () => { browserCalls += 1; return { status: 'passed' }; },
      notify: async () => ({ state: 'delivered' }),
    },
    settings: {
      maxJobsPerRun: 1, maxRunMs: 60_000, minJobStartMs: 5_000,
      maxRepairAttemptsPerVersion: 2, maxTransportRetries: 1,
      maxRepairsPerDay: 20, maxBrowserLaunchesPerDay: 0, maxApiCallsPerDay: 100,
      lockTtlMs: 60_000, jobLeaseMs: 60_000, browserEnabled: true,
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.jobs[0].status, 'deferred');
  assert.equal(result.jobs[0].result.browser.reason, 'browser_quota_exceeded');
  assert.equal(browserCalls, 0);
  const job = (await store.readJob(queued.job.id)).value;
  assert.equal(job.status, 'queued');
  assert.equal(job.lastError, 'browser_usage_limit');
  assert.equal(job.repairAttempts, 0);
  assert.equal((await store.readQueue()).value.items[0].availableAt, '2026-09-14T15:00:05.000Z');
});

test('a persisted snapshot survives a deferred visual retry and restores only the monitor write on the final failure', async () => {
  let clock = new Date('2026-09-14T00:00:00.000Z');
  let sequence = 0;
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => clock, uuid: () => `owner-${++sequence}` });
  const raw = sourceArticle('match_prediction');
  const article = {
    ...raw,
    match: { ...raw.match, fixtureId: fixture.id, homeTeamId: fixture.home.id, awayTeamId: fixture.away.id },
    prediction: {
      ...raw.prediction,
      keyPlayerCards: [{
        playerName: 'Bukayo Saka', playerId: 100, teamId: fixture.home.id, side: 'home', clubName: 'Arsenal',
        reason: '理由。', photoUrl: 'https://media.api-sports.io/football/players/100.png', logoUrl: fixture.home.logo, resolved: true,
      }],
    },
  };
  const previous = { ...article, body: '修復前の本文。', notion: { ...article.notion, updatedAt: 'v0' } };
  const database = new Map([[article.id, previous]]);
  await store.enqueue({ kind: 'notion_page', pageId: 'page-1', sourceType: article.type, sourceVersion: 'v1' });
  const dependencies = {
    collectChanges: async () => ({ sources: {}, errors: {} }),
    createSyncStore: () => ({}),
    syncPage: async (options) => {
      const current = database.get(article.id);
      if (current.body === article.body) return { outcome: 'unchanged', article: structuredClone(article), articleId: article.id, sourceVersion: 'v1' };
      const allowed = await options.beforeWrite({ existingArticle: current, article, page: { last_edited_time: 'v1' } });
      if (!allowed) return { outcome: 'write_cancelled' };
      database.set(article.id, structuredClone(article));
      return { outcome: 'updated', article: structuredClone(article), articleId: article.id, sourceVersion: 'v1' };
    },
    getArticle: async (id) => structuredClone(database.get(id)),
    saveArticle: async (value) => database.set(value.id, structuredClone(value)),
    resolveFixture: async () => fixtureResolution(),
    associationRepair: (value) => value,
    hydratePrediction: async (value) => value,
    getAvailability: async () => ({ availability: { [fixture.id]: ['prediction'] }, matchAvailability: {} }),
    browserVerify: async () => ({ status: 'failed', failureKind: 'regression' }),
    notify: async () => ({ state: 'delivered' }),
    listArticles: async () => ({ items: [] }),
  };
  const settings = { maxJobsPerRun: 10, maxRepairAttemptsPerVersion: 2, maxTransportRetries: 1, maxRepairsPerDay: 20, maxBrowserLaunchesPerDay: 10, maxApiCallsPerDay: 100, lockTtlMs: 60_000, jobLeaseMs: 60_000, browserEnabled: true };
  const first = await runSiteMonitor({ store, trigger: 'manual', collect: false, dependencies, settings, now: () => clock });
  assert.equal(first.jobs[0].status, 'deferred');
  assert.equal(database.get(article.id).body, article.body);
  const deferredJob = (await store.readJob(first.jobs[0].jobId)).value;
  assert.equal(deferredJob.snapshotIds.length, 1);

  clock = new Date('2026-09-14T00:01:01.000Z');
  const second = await runSiteMonitor({ store, trigger: 'manual', collect: false, dependencies, settings, now: () => clock });
  assert.equal(second.status, 'attention');
  assert.equal(second.jobs[0].status, 'blocked');
  assert.equal(second.jobs[0].result.rolledBack[0].state, 'restored');
  assert.equal(database.get(article.id).body, '修復前の本文。');
});

test('a failed visual regression reverts only the monitor snapshot after two bounded repair attempts', async () => {
  const blob = createBlob();
  const store = createSiteMonitorStore({ blob, now: () => new Date('2026-09-14T00:00:00.000Z'), uuid: () => 'owner' });
  const article = sourceArticle('match_prediction');
  const previous = previousArticle('match_prediction');
  const database = new Map([[article.id, previous]]);
  await store.enqueue({ kind: 'notion_page', pageId: 'page-1', sourceType: article.type, sourceVersion: 'v1' });
  const dependencies = {
    collectChanges: async () => ({ sources: {}, errors: {} }),
    createSyncStore: () => ({}),
    syncPage: async (options) => {
      await options.beforeWrite({ existingArticle: database.get(article.id), article, page: { last_edited_time: 'v1' } });
      database.set(article.id, structuredClone(article));
      return { outcome: 'updated', article: structuredClone(article), articleId: article.id, sourceVersion: 'v1' };
    },
    getArticle: async (id) => structuredClone(database.get(id)),
    saveArticle: async (value) => database.set(value.id, structuredClone(value)),
    resolveFixture: async () => fixtureResolution(),
    associationRepair: (value) => value,
    hydratePrediction: async (value) => value,
    getAvailability: async () => ({ availability: { [fixture.id]: ['prediction'] }, matchAvailability: {} }),
    browserVerify: async () => ({ status: 'failed', failureKind: 'regression' }),
    notify: async () => ({ state: 'delivered' }),
    listArticles: async () => ({ items: [] }),
  };
  const outcome = await runSiteMonitor({
    store, trigger: 'manual', collect: false, dependencies,
    settings: { maxJobsPerRun: 10, maxRepairAttemptsPerVersion: 1, maxTransportRetries: 1, maxRepairsPerDay: 20, maxBrowserLaunchesPerDay: 10, maxApiCallsPerDay: 100, lockTtlMs: 60_000, jobLeaseMs: 60_000, browserEnabled: true },
  });
  assert.equal(outcome.status, 'attention');
  assert.equal(database.get(article.id).body, '古い本文。');
  assert.equal(outcome.jobs[0].status, 'blocked');
  assert.equal(outcome.jobs[0].result.rolledBack[0].state, 'restored');
});

test('a browser-only deployment validation gets one bounded cold recheck without rewriting the article', async () => {
  let clock = new Date('2026-09-14T00:00:00.000Z');
  let sequence = 0;
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => clock, uuid: () => `browser-only-${++sequence}` });
  const article = sourceArticle('am4_story');
  const database = new Map([[article.id, structuredClone(article)]]);
  const notifications = [];
  let browserCalls = 0;
  await store.enqueue({
    kind: 'article_validation', articleId: article.id, sourceType: article.type,
    sourceVersion: 'v1', trigger: 'production_deployment', priority: 80,
  });
  const dependencies = {
    getArticle: async (id) => structuredClone(database.get(id) || null),
    browserVerify: async () => {
      browserCalls += 1;
      return { status: 'failed', failureKind: 'browser_assertion' };
    },
    notify: async (notice) => { notifications.push(notice); return { state: 'delivered' }; },
    listArticles: async () => ({ items: [] }),
  };
  const settings = {
    maxJobsPerRun: 1, maxRepairAttemptsPerVersion: 2, maxTransportRetries: 1,
    maxRepairsPerDay: 20, maxBrowserLaunchesPerDay: 10, maxApiCallsPerDay: 100,
    lockTtlMs: 60_000, jobLeaseMs: 60_000, browserEnabled: true,
  };

  const first = await runSiteMonitor({ store, trigger: 'manual', collect: false, dependencies, settings, now: () => clock });
  assert.equal(first.jobs[0].status, 'deferred');
  assert.equal(browserCalls, 1);
  assert.equal(database.get(article.id).body, article.body);
  assert.equal((await store.readJob(first.jobs[0].jobId)).value.repairAttempts, 1);

  clock = new Date('2026-09-14T00:01:01.000Z');
  const second = await runSiteMonitor({ store, trigger: 'manual', collect: false, dependencies, settings, now: () => clock });
  assert.equal(second.jobs[0].status, 'blocked');
  assert.equal(browserCalls, 2);
  assert.equal(database.get(article.id).body, article.body);
  assert.equal((await store.readJob(second.jobs[0].jobId)).value.repairAttempts, 2);
  assert.equal(notifications.length, 1);
});

test('a transient browser runtime interruption gets one non-destructive cold recheck', async () => {
  let clock = new Date('2026-09-18T00:00:00.000Z');
  let sequence = 0;
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => clock, uuid: () => `runtime-recheck-${++sequence}` });
  const article = sourceArticle('am4_story');
  const database = new Map([[article.id, structuredClone(article)]]);
  await store.enqueue({
    kind: 'article_validation', articleId: article.id, sourceType: article.type, sourceVersion: 'v1', priority: 90,
  });
  let browserCalls = 0;
  const dependencies = {
    getArticle: async (id) => structuredClone(database.get(id) || null),
    saveArticle: async (value) => database.set(value.id, structuredClone(value)),
    browserVerify: async () => {
      browserCalls += 1;
      return browserCalls === 1
        ? {
          status: 'unavailable', reason: 'browser_runtime_unavailable',
          runtimeFailure: 'runtime_browser_transport_interrupted',
        }
        : { status: 'passed' };
    },
    notify: async () => ({ state: 'delivered' }),
    listArticles: async () => ({ items: [] }),
  };
  const settings = {
    maxJobsPerRun: 1, maxRepairAttemptsPerVersion: 2, maxTransportRetries: 1,
    maxRepairsPerDay: 20, maxBrowserLaunchesPerDay: 10, maxApiCallsPerDay: 100,
    lockTtlMs: 60_000, jobLeaseMs: 60_000, browserEnabled: true,
  };
  const first = await runSiteMonitor({ store, trigger: 'manual', collect: false, dependencies, settings, now: () => clock });
  assert.equal(first.jobs[0].status, 'deferred');
  assert.equal((await store.readJob(first.jobs[0].jobId)).value.repairAttempts, 1);
  assert.equal(database.get(article.id).public, true);

  clock = new Date('2026-09-18T00:01:01.000Z');
  const second = await runSiteMonitor({ store, trigger: 'manual', collect: false, dependencies, settings, now: () => clock });
  assert.equal(second.jobs[0].status, 'completed');
  assert.equal(database.get(article.id).public, true);
});

test('a production validation restores only a legacy browser-process hold through the normal sync and browser path', async () => {
  let clock = new Date('2026-09-18T00:00:00.000Z');
  let sequence = 0;
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => clock, uuid: () => `runtime-recovery-${++sequence}` });
  const publicArticle = sourceArticle('match_prediction');
  const held = {
    ...publicArticle,
    public: false,
    siteMonitor: {
      provisionalCreation: { sourceVersion: 'v1', sourceJobId: 'generation-job' },
      deliveryHold: { sourceVersion: 'v1', sourceJobId: 'generation-job', reason: 'browser_validation_failed' },
    },
  };
  const database = new Map([[held.id, structuredClone(held)]]);
  const legacy = await store.enqueue({
    kind: 'article_validation', articleId: held.id, sourceType: held.type, sourceVersion: 'v1', priority: 99,
  });
  const legacyClaim = await store.claimJobs({ owner: 'legacy-owner', jobIds: [legacy.job.id] });
  await store.finishJob(legacyClaim.jobs[0].id, {
    owner: 'legacy-owner', status: 'blocked', error: 'browser_failed',
    result: {
      state: 'browser_failed', article: structuredClone(held),
      browser: { error: 'Target page, context or browser has been closed' },
    },
    repairAttempts: 2,
  });
  // The normal daily browser allowance is already exhausted. The incident
  // migration may use only its two code-owned reserve launches (21 and 22),
  // then remains bounded by the same durable daily ledger.
  assert.equal((await store.consumeUsage({ browserLaunches: 20 }, { browserLaunches: 20 })).ok, true);
  await store.enqueue({ kind: 'deployment_validation', deploymentId: 'dpl-runtime-recovery', priority: 90 });
  const notifications = [];
  let released = false;
  let browserCalls = 0;
  const dependencies = {
    getArticle: async (id) => structuredClone(database.get(id) || null),
    listArticles: async () => ({ items: [] }),
    createSyncStore: () => ({}),
    syncPage: async (options) => {
      released = options.releaseMonitorDeliveryHold === true;
      const current = database.get(held.id);
      const allowed = await options.beforeWrite({
        existingArticle: structuredClone(current), article: structuredClone(publicArticle),
        page: { id: 'page-1', last_edited_time: 'v1' },
      });
      if (!allowed) return { outcome: 'write_cancelled' };
      database.set(publicArticle.id, structuredClone(publicArticle));
      return {
        outcome: 'updated', article: structuredClone(publicArticle), articleId: publicArticle.id,
        sourceType: publicArticle.type, sourceVersion: 'v1',
      };
    },
    saveArticle: async (article) => database.set(article.id, structuredClone(article)),
    getFixture: async () => fixture,
    resolveFixture: async () => fixtureResolution(),
    associationRepair: (article) => ({
      ...article,
      match: { ...article.match, fixtureId: fixture.id, homeTeamId: fixture.home.id, awayTeamId: fixture.away.id },
    }),
    hydratePrediction: async (article) => ({
      ...article,
      prediction: {
        ...article.prediction,
        keyPlayerCards: [{
          playerName: 'Bukayo Saka', playerId: 100, teamId: fixture.home.id, side: 'home', clubName: 'Arsenal',
          reason: '理由。', photoUrl: 'https://media.api-sports.io/football/players/100.png',
          logoUrl: fixture.home.logo, resolved: true,
        }],
      },
    }),
    readStoredPredictionCards: async () => [],
    saveStoredPredictionCards: async () => true,
    getAvailability: async () => ({ availability: { [fixture.id]: ['prediction'] }, matchAvailability: {} }),
    browserVerify: async () => {
      browserCalls += 1;
      return browserCalls === 1
        ? {
          status: 'unavailable', reason: 'browser_runtime_unavailable',
          runtimeFailure: 'runtime_browser_transport_interrupted',
        }
        : { status: 'passed' };
    },
    notify: async (notice) => { notifications.push(notice); return { state: 'delivered' }; },
  };
  const first = await runSiteMonitor({
    store, trigger: 'cron', deploymentId: 'dpl-runtime-recovery', collect: false, dependencies,
    now: () => clock,
    settings: {
      maxJobsPerRun: 2, maxRepairAttemptsPerVersion: 2, maxTransportRetries: 1,
      maxRepairsPerDay: 20, maxBrowserLaunchesPerDay: 12, maxApiCallsPerDay: 100,
      lockTtlMs: 60_000, jobLeaseMs: 60_000, browserEnabled: true,
    },
  });
  assert.equal(first.status, 'completed');
  assert.equal(released, true);
  assert.equal(database.get(publicArticle.id).public, false);
  assert.equal(database.get(publicArticle.id).siteMonitor?.deliveryHold?.reason, 'browser_validation_failed');
  assert.equal(first.jobs.length, 2);
  assert.equal(first.jobs[1].status, 'deferred');
  assert.equal(notifications.length, 0);

  clock = new Date('2026-09-18T00:01:01.000Z');
  const second = await runSiteMonitor({
    store, trigger: 'cron', deploymentId: 'dpl-runtime-recovery', collect: false, dependencies,
    now: () => clock,
    settings: {
      maxJobsPerRun: 2, maxRepairAttemptsPerVersion: 2, maxTransportRetries: 1,
      maxRepairsPerDay: 20, maxBrowserLaunchesPerDay: 12, maxApiCallsPerDay: 100,
      lockTtlMs: 60_000, jobLeaseMs: 60_000, browserEnabled: true,
    },
  });
  assert.equal(second.status, 'completed');
  assert.equal(database.get(publicArticle.id).public, true);
  assert.equal(database.get(publicArticle.id).siteMonitor?.deliveryHold, undefined);
  assert.equal(second.jobs.length, 1);
  assert.equal(second.jobs[0].status, 'completed');
  assert.equal(second.jobs[0].result.notification.category, 'repair_success');
  assert.equal(notifications.length, 1);
  assert.deepEqual(
    (await store.readState()).value.browserRuntimeRecovery.processedLegacyJobIds,
    [legacy.job.id],
  );
  assert.equal((await store.readState()).value.usage.browserLaunches, 22);
});

test('a repeated runtime interruption restores a legacy recovery hold before both defer and terminal block', async () => {
  let clock = new Date('2026-09-18T00:00:00.000Z');
  let sequence = 0;
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => clock, uuid: () => `runtime-hold-${++sequence}` });
  const publicArticle = sourceArticle('am4_story');
  const held = {
    ...publicArticle,
    public: false,
    siteMonitor: {
      provisionalCreation: { sourceVersion: 'v1', sourceJobId: 'generation-job' },
      deliveryHold: { sourceVersion: 'v1', sourceJobId: 'generation-job', reason: 'browser_validation_failed' },
    },
  };
  const database = new Map([[held.id, structuredClone(held)]]);
  const queued = await store.enqueue({
    kind: 'transient_browser_recovery', pageId: 'page-1', articleId: held.id,
    sourceType: held.type, sourceVersion: 'v1', repairGeneration: 'browser-runtime-interruption-recovery-v1',
    trigger: 'transient_browser_runtime_recovery', priority: 99,
    payload: { releaseMonitorDeliveryHold: true },
  });
  const dependencies = {
    getArticle: async (id) => structuredClone(database.get(id) || null),
    saveArticle: async (article) => database.set(article.id, structuredClone(article)),
    listArticles: async () => ({ items: [] }),
    createSyncStore: () => ({}),
    syncPage: async (options) => {
      const allowed = await options.beforeWrite({
        existingArticle: structuredClone(database.get(held.id)), article: structuredClone(publicArticle),
        page: { id: 'page-1', last_edited_time: 'v1' },
      });
      if (!allowed) return { outcome: 'write_cancelled' };
      database.set(publicArticle.id, structuredClone(publicArticle));
      return {
        outcome: 'updated', article: structuredClone(publicArticle), articleId: publicArticle.id,
        sourceType: publicArticle.type, sourceVersion: 'v1',
      };
    },
    browserVerify: async () => ({
      status: 'unavailable', reason: 'browser_runtime_unavailable',
      runtimeFailure: 'runtime_browser_transport_interrupted',
    }),
    notify: async () => ({ state: 'delivered' }),
  };
  const settings = {
    maxJobsPerRun: 1, maxRepairAttemptsPerVersion: 2, maxTransportRetries: 1,
    maxRepairsPerDay: 20, maxBrowserLaunchesPerDay: 12, maxApiCallsPerDay: 100,
    lockTtlMs: 60_000, jobLeaseMs: 60_000, browserEnabled: true,
  };

  const first = await runSiteMonitor({ store, trigger: 'cron', collect: false, dependencies, settings, now: () => clock });
  assert.equal(first.jobs[0].status, 'deferred');
  assert.equal(database.get(held.id).public, false);
  assert.equal(database.get(held.id).siteMonitor?.deliveryHold?.reason, 'browser_validation_failed');

  clock = new Date('2026-09-18T00:01:01.000Z');
  const second = await runSiteMonitor({ store, trigger: 'cron', collect: false, dependencies, settings, now: () => clock });
  assert.equal(second.jobs[0].status, 'blocked');
  assert.equal((await store.readJob(queued.job.id)).value.status, 'blocked');
  assert.equal(database.get(held.id).public, false);
  assert.equal(database.get(held.id).siteMonitor?.deliveryHold?.reason, 'browser_validation_failed');
});

test('a legacy recovery restores its hold when fixture validation fails before Chromium starts', async () => {
  const clock = new Date('2026-09-18T00:00:00.000Z');
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => clock, uuid: () => 'runtime-fixture-hold' });
  const publicArticle = sourceArticle('match_prediction');
  const held = {
    ...publicArticle,
    public: false,
    siteMonitor: {
      provisionalCreation: { sourceVersion: 'v1', sourceJobId: 'generation-job' },
      deliveryHold: { sourceVersion: 'v1', sourceJobId: 'generation-job', reason: 'browser_validation_failed' },
    },
  };
  const database = new Map([[held.id, structuredClone(held)]]);
  await store.enqueue({
    kind: 'transient_browser_recovery', pageId: 'page-1', articleId: held.id,
    sourceType: held.type, sourceVersion: 'v1', repairGeneration: 'browser-runtime-interruption-recovery-v1',
    trigger: 'transient_browser_runtime_recovery', priority: 99,
    payload: { releaseMonitorDeliveryHold: true },
  });
  let browserCalls = 0;
  const dependencies = {
    getArticle: async (id) => structuredClone(database.get(id) || null),
    saveArticle: async (article) => database.set(article.id, structuredClone(article)),
    listArticles: async () => ({ items: [] }),
    createSyncStore: () => ({}),
    syncPage: async (options) => {
      const allowed = await options.beforeWrite({
        existingArticle: structuredClone(database.get(held.id)), article: structuredClone(publicArticle),
        page: { id: 'page-1', last_edited_time: 'v1' },
      });
      if (!allowed) return { outcome: 'write_cancelled' };
      database.set(publicArticle.id, structuredClone(publicArticle));
      return {
        outcome: 'updated', article: structuredClone(publicArticle), articleId: publicArticle.id,
        sourceType: publicArticle.type, sourceVersion: 'v1',
      };
    },
    resolveFixture: async () => ({ state: 'source_unavailable' }),
    browserVerify: async () => { browserCalls += 1; return { status: 'passed' }; },
    notify: async () => ({ state: 'delivered' }),
  };
  const result = await runSiteMonitor({
    store, trigger: 'cron', collect: false, dependencies, now: () => clock,
    settings: {
      maxJobsPerRun: 1, maxRepairAttemptsPerVersion: 2, maxTransportRetries: 1,
      maxRepairsPerDay: 20, maxBrowserLaunchesPerDay: 12, maxApiCallsPerDay: 100,
      lockTtlMs: 60_000, jobLeaseMs: 60_000, browserEnabled: true,
    },
  });
  assert.equal(result.jobs[0].status, 'deferred');
  assert.equal(browserCalls, 0);
  assert.equal(database.get(held.id).public, false);
  assert.equal(database.get(held.id).siteMonitor?.deliveryHold?.reason, 'browser_validation_failed');
});

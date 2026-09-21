import assert from 'node:assert/strict';
import test from 'node:test';

import { createSiteMonitorStore } from '../lib/site-monitor-store.js';
import {
  createGeneratedReport,
  isRetryableReportRepairError,
  prepareReportGeneration,
  REPORT_GENERATION_REPAIR_GENERATION,
  REPORT_GENERATION_SOURCE_TYPE,
  scanMissingMatchReports,
} from '../lib/match-report-repair.js';
import { runSiteMonitor, siteMonitorSettings } from '../lib/site-monitor-core.js';

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
    async del() {},
  };
}

function rawFixture({ id = 1570387, status = 'FT', leagueId = 140 } = {}) {
  return {
    fixture: {
      id,
      date: '2026-09-16T19:00:00+00:00', timezone: 'UTC',
      status: { short: status, long: status === 'FT' ? 'Match Finished' : 'Not Started' },
      venue: { name: 'Test Stadium' },
    },
    league: {
      id: leagueId,
      name: leagueId === 140 ? 'La Liga' : 'Premier League',
      round: 'Regular Season - 5',
    },
    teams: {
      home: { id: 126, name: 'RC Deportivo' },
      away: { id: 536, name: 'Sevilla' },
    },
    goals: { home: 2, away: 1 },
  };
}

function ratingPlayers() {
  return [{
    team: { id: 126, name: 'RC Deportivo' },
    players: [{
      player: { id: 1, name: 'Verified Player' },
      statistics: [{
        games: { minutes: 90, position: 'F' }, goals: { total: 1, assists: 0 },
        passes: { key: 2, accuracy: 88 }, dribbles: { success: 1 }, shots: { on: 2 },
        duels: { total: 5, won: 4 }, tackles: { total: 0, interceptions: 0, blocks: 0 },
        fouls: { committed: 0 }, cards: { yellow: 0, red: 0 },
      }],
    }],
  }];
}

test('fixture-first scan queues only a finished target match without a public report', async () => {
  const now = () => new Date('2026-09-18T00:00:00.000Z');
  const store = createSiteMonitorStore({ blob: createBlob(), now, uuid: () => 'report-scan-owner' });
  const result = await scanMissingMatchReports({
    store, now,
    fetchFixtures: async (_path, params) => ({
      response: params.date === '2026-09-16'
        ? [rawFixture(), rawFixture({ id: 1570388, status: 'NS' }), rawFixture({ id: 999999, leagueId: 667 })]
        : [],
    }),
    listPublicArticles: async () => ({ items: [] }),
  });
  assert.equal(result.state, 'queued');
  assert.equal(result.finishedFixtures, 1);
  assert.equal(result.missingReports, 1);
  const queue = (await store.readQueue()).value.items;
  assert.equal(queue.length, 1);
  const job = (await store.readJob(queue[0].jobId)).value;
  assert.equal(job.kind, 'report_generation');
  assert.equal(job.sourceType, REPORT_GENERATION_SOURCE_TYPE);
  assert.equal(job.fixtureId, 1570387);
  assert.equal(job.payload.fixture.homeGoals, 2);
  assert.equal(job.repairGeneration, REPORT_GENERATION_REPAIR_GENERATION);
});

test('a deterministic generation-engine change restarts the bounded initial reconciliation window', async () => {
  const now = () => new Date('2026-09-18T00:00:00.000Z');
  const store = createSiteMonitorStore({ blob: createBlob(), now, uuid: () => 'deterministic-rescan-owner' });
  await store.updateState((state) => ({
    ...state,
    matchReportRepair: {
      generation: 'notion-match-report-generation-v1',
      initialCompletedAt: '2026-09-17T00:00:00.000Z',
      lastScanAt: '2026-09-18T00:00:00.000Z',
    },
  }));
  const result = await scanMissingMatchReports({
    store, now,
    fetchFixtures: async (_path, params) => ({
      response: params.date === '2026-09-16' ? [rawFixture()] : [],
    }),
    listPublicArticles: async () => ({ items: [] }),
  });
  assert.equal(result.state, 'queued');
  assert.equal(result.mode, 'initial');
  assert.equal(result.queued, 1);
  const queue = (await store.readQueue()).value.items;
  const job = (await store.readJob(queue[0].jobId)).value;
  assert.equal(job.repairGeneration, REPORT_GENERATION_REPAIR_GENERATION);
  const state = (await store.readState()).value.matchReportRepair;
  assert.equal(state.generation, REPORT_GENERATION_REPAIR_GENERATION);
  assert.equal(state.lastResult.generationChanged, true);
});

test('a fixture-ID report with reversed teams is queued for source relinking, not treated as healthy', async () => {
  const now = () => new Date('2026-09-18T00:00:00.000Z');
  const store = createSiteMonitorStore({ blob: createBlob(), now, uuid: () => 'fixture-conflict-owner' });
  const result = await scanMissingMatchReports({
    store, now,
    fetchFixtures: async (_path, params) => ({
      response: params.date === '2026-09-16' ? [rawFixture()] : [],
    }),
    listPublicArticles: async () => ({ items: [{
      id: 'wrong-fixture-card', type: 'match_report', status: 'published', public: true,
      notion: { pageId: 'source-page', updatedAt: '2026-09-17T00:00:00.000Z' },
      match: { fixtureId: 1570387, homeTeamId: 536, awayTeamId: 126, homeTeam: 'Sevilla', awayTeam: 'RC Deportivo' },
    }] }),
  });
  assert.equal(result.missingReports, 1);
  assert.equal(result.queued, 1);
  const state = (await store.readState()).value.matchReportRepair.fixtures['1570387'];
  assert.equal(state.classification, 'C_public_report_fixture_conflict');
  assert.equal(state.productionArticleId, 'wrong-fixture-card');
});

test('a public report suppresses generation, while an existing Notion report is sent to sync instead of recreated', async () => {
  const fixture = rawFixture();
  const publicResult = await prepareReportGeneration({
    fixtureId: 1570387,
    fetchFixture: async () => ({ response: [fixture] }),
    listPublicArticles: async () => ({ items: [{
      id: 'already-public', type: 'match_report', status: 'published', public: true,
      match: { fixtureId: 1570387 },
    }] }),
    findNotionReport: async () => assert.fail('public report must avoid Notion generation lookup'),
  });
  assert.equal(publicResult.state, 'public_report_exists');

  const notionResult = await prepareReportGeneration({
    fixtureId: 1570387,
    fetchFixture: async () => ({ response: [fixture] }),
    listPublicArticles: async () => ({ items: [] }),
    findNotionReport: async () => ({
      page: { id: 'existing-notion-report', last_edited_time: '2026-09-17T00:00:00.000Z' },
      matchMethod: 'fixture_id', ambiguous: false,
    }),
  });
  assert.equal(notionResult.state, 'notion_report_exists');
  assert.equal(notionResult.page.id, 'existing-notion-report');
});

test('a conflicting public fixture card reuses its source page and forces a source resync', async () => {
  const fixture = rawFixture();
  let lookedUpNotion = false;
  const result = await prepareReportGeneration({
    fixtureId: 1570387,
    fetchFixture: async () => ({ response: [fixture] }),
    listPublicArticles: async () => ({ items: [{
      id: 'wrong-fixture-card', type: 'match_report', status: 'published', public: true,
      notion: { pageId: 'source-page', updatedAt: '2026-09-17T00:00:00.000Z' },
      match: { fixtureId: 1570387, homeTeamId: 536, awayTeamId: 126, homeTeam: 'Sevilla', awayTeam: 'RC Deportivo' },
    }] }),
    findNotionReport: async () => {
      lookedUpNotion = true;
      return { page: null, ambiguous: false };
    },
  });
  assert.equal(lookedUpNotion, false);
  assert.equal(result.state, 'notion_report_exists');
  assert.equal(result.forceSourceSync, true);
  assert.equal(result.page.id, 'source-page');
});

test('a PEN fixture without a verified shootout score is retried before any new report is created', async () => {
  const fixture = rawFixture({ status: 'PEN' });
  fixture.fixture.status.long = 'Match Finished';
  const result = await prepareReportGeneration({
    fixtureId: 1570387,
    fetchFixture: async () => ({ response: [fixture] }),
    listPublicArticles: async () => ({ items: [] }),
    findNotionReport: async () => ({ page: null, ambiguous: false }),
  });
  assert.equal(result.state, 'retryable');
  assert.equal(result.reason, 'fixture_penalty_result_unavailable');
});

test('new report creation replaces an accidental generated award with one AM4-backed MOTM rationale', async () => {
  const fixture = rawFixture();
  let published = null;
  let draftMatchInfo = null;
  const result = await createGeneratedReport({
    fixture: {
      id: 1570387, leagueId: 140, competition: 'La Liga', round: 'Regular Season - 5', status: 'FT',
      date: '2026-09-16', kickoff: fixture.fixture.date, venue: 'Test Stadium', timezone: 'UTC',
      homeTeam: 'RC Deportivo', awayTeam: 'Sevilla', homeTeamId: 126, awayTeamId: 536, homeGoals: 2, awayGoals: 1,
    },
    match: {
      fixtureId: 1570387, date: '2026-09-16', kickoff: fixture.fixture.date, timezone: 'UTC', competition: 'La Liga',
      homeTeam: 'RC Deportivo', awayTeam: 'Sevilla', homeTeamId: 126, awayTeamId: 536, homeGoals: 2, awayGoals: 1,
    },
    fetchFixture: async (path) => {
      if (path === '/fixtures/events') return { response: [{ type: 'Goal', detail: 'Normal Goal', team: { id: 126 }, player: { id: 1 }, time: { elapsed: 42 } }] };
      if (path === '/fixtures/players') return { response: ratingPlayers() };
      assert.fail(`unexpected provider path: ${path}`);
    },
    generateDraft: async (matchInfo) => {
      draftMatchInfo = matchInfo;
      return {
        draft: `# 試合解説\n${'RC Deportivo 2-1 Sevilla の検証済み試合展開。'.repeat(35)}\n## MOTM\nMOTM：Old Choice — 旧選出。\n根拠：残してはいけない理由。\n## 総括\n本文の結び。`,
        searchSources: [{ title: 'Official report', url: 'https://example.com/official' }],
      };
    },
    publishReport: async (input) => {
      published = input;
      return { page: { id: 'new-notion-report', created_time: '2026-09-17T00:00:00.000Z' }, sourceVersion: '2026-09-17T00:00:00.000Z' };
    },
  });
  assert.equal(result.page.id, 'new-notion-report');
  assert.match(published.draft, /MOTM：Verified Player/);
  assert.match(published.draft, /AM4独自選出/);
  assert.equal((published.draft.match(/^MOTM：/gmu) || []).length, 1);
  assert.equal(published.draft.includes('Old Choice'), false);
  assert.equal(published.draft.includes('残してはいけない理由'), false);
  assert.equal(published.draft.includes('機械採点'), false);
  assert.equal(published.draft.includes('API-Footballの試合スタッツ'), false);
  assert.match(published.draft, /42分の先制点が勝敗を左右する場面だったため加点/);
  assert.match(published.draft, /本文の結び。/);
  assert.equal(published.sources[0].url, 'https://example.com/official');
  assert.equal(draftMatchInfo.fixtureId, 1570387);
  assert.equal(draftMatchInfo.sourceReferences[0].url, 'https://v3.football.api-sports.io/fixtures?id=1570387');
  assert.equal(draftMatchInfo.sourceReferences[1].url, 'https://v3.football.api-sports.io/fixtures/events?fixture=1570387');
  assert.equal(draftMatchInfo.events[0].time.elapsed, 42);
});

test('Notion configuration failures are not retried as transient report-generation faults', () => {
  const error = Object.assign(new Error('forbidden'), {
    code: 'NOTION_HTTP_ERROR', status: 403, retryable: false,
  });
  assert.equal(isRetryableReportRepairError(error), false);
});

test('an existing non-public Notion report becomes a durable manual hold without regeneration', async () => {
  const now = () => new Date('2026-09-18T00:00:00.000Z');
  const store = createSiteMonitorStore({ blob: createBlob(), now, uuid: () => 'private-report-owner' });
  await store.enqueue({
    kind: 'report_generation', fixtureId: 1570387, sourceType: REPORT_GENERATION_SOURCE_TYPE,
    sourceVersion: 'result-private-v1', trigger: 'test', priority: 95,
  });
  const fixture = { id: 1570387, status: 'FT', home: { id: 126, name: 'RC Deportivo' }, away: { id: 536, name: 'Sevilla' } };
  let generationCalls = 0;
  const notifications = [];
  const result = await runSiteMonitor({
    store,
    trigger: 'report_generation',
    claimSourceTypes: [REPORT_GENERATION_SOURCE_TYPE],
    collect: false,
    now,
    settings: {
      ...siteMonitorSettings({}), allowExtendedRun: true, maxRunMs: 285_000,
      minJobStartMs: 255_000, maxJobsPerRun: 1,
    },
    dependencies: {
      prepareReportGeneration: async () => ({
        state: 'notion_report_exists', fixture,
        page: { id: 'private-notion-report', last_edited_time: '2026-09-17T00:00:00.000Z' },
        sourceVersion: '2026-09-17T00:00:00.000Z',
      }),
      createGeneratedReport: async () => {
        generationCalls += 1;
        throw new Error('must not generate a duplicate report');
      },
      getArticle: async () => null,
      createSyncStore: () => ({}),
      syncPage: async () => ({
        outcome: 'non_public', sourceType: 'match_report', sourceVersion: '2026-09-17T00:00:00.000Z',
        page: { id: 'private-notion-report' }, articleId: 'notion-match_report-private-notion-report',
      }),
      notify: async (alert) => {
        notifications.push(alert);
        return { state: 'delivered' };
      },
    },
  });
  assert.equal(generationCalls, 0);
  assert.equal(result.jobs[0].status, 'blocked');
  assert.equal(result.jobs[0].result.reason, 'existing_notion_report_not_public');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].category, 'manual_review');
  const state = (await store.readState()).value;
  assert.equal(state.matchReportRepair.fixtures['1570387'].outcome, 'manual_review');
  assert.equal(state.matchReportRepair.fixtures['1570387'].display, 'report_pending');
});

test('an ambiguous Notion create result becomes a durable hold rather than a second report creation', async () => {
  const now = () => new Date('2026-09-18T00:00:00.000Z');
  const store = createSiteMonitorStore({ blob: createBlob(), now, uuid: () => 'unknown-create-owner' });
  await store.enqueue({
    kind: 'report_generation', fixtureId: 1570387, sourceType: REPORT_GENERATION_SOURCE_TYPE,
    sourceVersion: 'result-unknown-create-v1', trigger: 'test', priority: 95,
  });
  const fixture = { id: 1570387, status: 'FT', home: { id: 126, name: 'RC Deportivo' }, away: { id: 536, name: 'Sevilla' } };
  let createCalls = 0;
  const result = await runSiteMonitor({
    store, trigger: 'report_generation', claimSourceTypes: [REPORT_GENERATION_SOURCE_TYPE], collect: false, now,
    settings: { ...siteMonitorSettings({}), allowExtendedRun: true, maxRunMs: 285_000, minJobStartMs: 255_000, maxJobsPerRun: 1 },
    dependencies: {
      prepareReportGeneration: async () => ({ state: 'ready', fixture, match: { fixtureId: 1570387 } }),
      createGeneratedReport: async () => {
        createCalls += 1;
        throw Object.assign(new Error('timeout after POST'), {
          code: 'NOTION_REQUEST_TIMEOUT', notionCreateOutcomeUnknown: true, retryable: true,
        });
      },
      notify: async () => ({ state: 'delivered' }),
    },
  });
  assert.equal(createCalls, 1);
  assert.equal(result.jobs[0].status, 'blocked');
  assert.equal(result.jobs[0].result.reason, 'notion_create_outcome_unknown');
  const state = (await store.readState()).value;
  assert.equal(state.matchReportRepair.fixtures['1570387'].classification, 'A_notion_create_outcome_unknown');
});

test('a provider per-run cap resumes the same report job on the next worker, not tomorrow', async () => {
  const now = () => new Date('2026-09-18T00:00:00.000Z');
  const store = createSiteMonitorStore({ blob: createBlob(), now, uuid: () => 'provider-cap-owner' });
  const queued = await store.enqueue({
    kind: 'report_generation', fixtureId: 1570387, sourceType: REPORT_GENERATION_SOURCE_TYPE,
    sourceVersion: 'result-provider-cap-v1', trigger: 'test', priority: 95,
  });
  await runSiteMonitor({
    store,
    trigger: 'report_generation',
    claimSourceTypes: [REPORT_GENERATION_SOURCE_TYPE],
    collect: false,
    now,
    settings: {
      ...siteMonitorSettings({}), allowExtendedRun: true, maxRunMs: 285_000,
      minJobStartMs: 255_000, maxJobsPerRun: 1,
    },
    dependencies: {
      prepareReportGeneration: async () => {
        const error = new Error('provider run cap');
        error.code = 'PROVIDER_USAGE_LIMIT';
        error.details = { exceeded: 'providerRequestsPerRun' };
        throw error;
      },
      notify: async () => ({ state: 'delivered' }),
    },
  });
  const job = (await store.readJob(queued.job.id)).value;
  const queue = (await store.readQueue()).value.items.find((item) => item.jobId === queued.job.id);
  assert.equal(job.status, 'queued');
  assert.equal(job.lastError, 'usage_limit');
  assert.equal(Date.parse(queue.availableAt) - now().getTime(), 60_000);
});

test('the monitor claims a report-generation job only in the explicitly extended worker lane', async () => {
  const now = () => new Date('2026-09-18T00:00:00.000Z');
  const store = createSiteMonitorStore({ blob: createBlob(), now, uuid: () => 'generation-owner' });
  await store.enqueue({
    kind: 'report_generation', fixtureId: 1570387, sourceType: REPORT_GENERATION_SOURCE_TYPE,
    sourceVersion: 'result-v1', trigger: 'test', priority: 95,
  });
  const result = await runSiteMonitor({
    store, trigger: 'report_generation', claimSourceTypes: [REPORT_GENERATION_SOURCE_TYPE], collect: false, now,
    settings: {
      ...siteMonitorSettings({}), allowExtendedRun: true, maxRunMs: 285_000,
      minJobStartMs: 220_000, maxJobsPerRun: 1,
    },
    dependencies: {
      prepareReportGeneration: async () => ({ state: 'public_report_exists', fixture: { id: 1570387 } }),
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].result.reason, 'public_report_exists');
});

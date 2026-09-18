import assert from 'node:assert/strict';
import test from 'node:test';

import { createSiteMonitorStore } from '../lib/site-monitor-store.js';
import {
  createGeneratedPrediction,
  PREDICTION_GENERATION_REPAIR_GENERATION,
  PREDICTION_GENERATION_SOURCE_TYPE,
  predictionGenerationVersion,
  preparePredictionGeneration,
  scanMissingMatchPredictions,
} from '../lib/match-prediction-repair.js';
import { monitorArticleDigest, runSiteMonitor, siteMonitorSettings } from '../lib/site-monitor-core.js';
import matchArchive from '../match-archive.js';

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

function rawFixture({ id = 1557409, status = 'NS', home = 'Brighton', away = 'Arsenal', homeId = 51, awayId = 42 } = {}) {
  return {
    fixture: {
      id,
      date: '2026-09-19T14:00:00+00:00', timezone: 'UTC',
      status: { short: status, long: status === 'NS' ? 'Not Started' : 'Match Finished' },
      venue: { name: 'Test Stadium' },
    },
    league: { id: 39, name: 'Premier League', season: 2026, round: 'Regular Season - 5' },
    teams: { home: { id: homeId, name: home }, away: { id: awayId, name: away } },
    goals: { home: status === 'NS' ? null : 2, away: status === 'NS' ? null : 1 },
  };
}

function completedFixture({ id, date, homeId, awayId, home, away, homeGoals, awayGoals }) {
  return {
    fixture: { id, date, status: { short: 'FT' } },
    teams: { home: { id: homeId, name: home }, away: { id: awayId, name: away } },
    goals: { home: homeGoals, away: awayGoals },
  };
}

test('fixture-first prediction scan queues a scheduled target match with no public prediction', async () => {
  const now = () => new Date('2026-09-18T12:00:00.000Z');
  const store = createSiteMonitorStore({ blob: createBlob(), now, uuid: () => 'prediction-scan-owner' });
  const result = await scanMissingMatchPredictions({
    store, now,
    fetchFixtures: async (_path, params) => ({
      response: params.date === '2026-09-19'
        ? [rawFixture(), rawFixture({ id: 1557410, status: 'FT' })]
        : [],
    }),
    listPublicArticles: async () => ({ items: [] }),
  });
  assert.equal(result.state, 'queued');
  assert.equal(result.scheduledFixtures, 1);
  assert.equal(result.missingPredictions, 1);
  const queue = (await store.readQueue()).value.items;
  assert.equal(queue.length, 1);
  const job = (await store.readJob(queue[0].jobId)).value;
  assert.equal(job.kind, 'prediction_generation');
  assert.equal(job.sourceType, PREDICTION_GENERATION_SOURCE_TYPE);
  assert.equal(job.fixtureId, 1557409);
  assert.equal(job.repairGeneration, PREDICTION_GENERATION_REPAIR_GENERATION);
  assert.equal(job.priority, 98);
});

test('a priority-rule revision promotes an existing near-kickoff prediction job without duplicating it', async () => {
  const now = () => new Date('2026-09-18T12:00:00.000Z');
  const store = createSiteMonitorStore({ blob: createBlob(), now, uuid: () => 'prediction-priority-owner' });
  const fixture = rawFixture();
  const candidate = {
    id: 1557409, status: 'NS', kickoff: fixture.fixture.date, date: '2026-09-19',
    leagueId: 39, season: 2026, homeTeamId: 51, awayTeamId: 42,
  };
  const existing = await store.enqueue({
    kind: 'prediction_generation', fixtureId: candidate.id,
    sourceType: PREDICTION_GENERATION_SOURCE_TYPE,
    sourceVersion: predictionGenerationVersion(candidate),
    repairGeneration: PREDICTION_GENERATION_REPAIR_GENERATION,
    trigger: 'scheduled_fixture_scan', priority: 94,
  });
  await store.updateState((state) => ({
    ...state,
    matchPredictionRepair: {
      lastScanAt: now().toISOString(), lastScanTokyoDate: '2026-09-18', queuePriorityVersion: 'legacy-priority',
    },
  }));
  const result = await scanMissingMatchPredictions({
    store, now,
    fetchFixtures: async (_path, params) => ({ response: params.date === '2026-09-19' ? [fixture] : [] }),
    listPublicArticles: async () => ({ items: [] }),
  });
  assert.equal(result.state, 'queued');
  assert.equal(result.queued, 0);
  assert.equal((await store.readQueue()).value.items.length, 1);
  assert.equal((await store.readQueue()).value.items[0].priority, 98);
  assert.equal((await store.readJob(existing.job.id)).value.priority, 98);
});

test('fixture-first prediction scan exhausts the public archive before it creates a source page', async () => {
  const now = () => new Date('2026-09-18T00:00:00.000Z');
  const store = createSiteMonitorStore({ blob: createBlob(), now, uuid: () => 'prediction-pagination-owner' });
  const pages = [];
  const result = await scanMissingMatchPredictions({
    store, now,
    fetchFixtures: async (_path, params) => ({
      response: params.date === '2026-09-18' ? [rawFixture()] : [],
    }),
    listPublicArticles: async ({ page }) => {
      pages.push(page);
      return page === 1
        ? { items: [], page, totalPages: 2 }
        : {
          items: [{
            type: 'match_prediction', public: true, status: 'published',
            match: {
              fixtureId: 1557409, homeTeamId: 51, awayTeamId: 42,
              homeTeam: 'Brighton', awayTeam: 'Arsenal',
            },
          }],
          page, totalPages: 2,
        };
    },
  });
  assert.deepEqual(pages, [1, 2]);
  assert.equal(result.missingPredictions, 0);
  assert.equal((await store.readQueue()).value.items.length, 0);
});

test('a same-fixture prediction with one known contradictory card side is repaired instead of accepted', async () => {
  const now = () => new Date('2026-09-18T00:00:00.000Z');
  const store = createSiteMonitorStore({ blob: createBlob(), now, uuid: () => 'prediction-partial-card-owner' });
  const result = await scanMissingMatchPredictions({
    store, now,
    fetchFixtures: async (_path, params) => ({ response: params.date === '2026-09-18' ? [rawFixture()] : [] }),
    listPublicArticles: async () => ({
      items: [{
        type: 'match_prediction', public: true, status: 'published',
        match: { fixtureId: 1557409, homeTeam: 'Wrong Home', awayTeam: '' },
      }], page: 1, totalPages: 1,
    }),
  });
  assert.equal(result.missingPredictions, 1);
  assert.equal(result.queued, 1);
  assert.equal((await store.readQueue()).value.items.length, 1);
  assert.equal(matchArchive.normalizedTeam('Man Utd'), matchArchive.normalizedTeam('Manchester United'));
});

test('an unavailable public archive persists a bounded scan backoff before another provider read', async () => {
  const observed = new Date('2026-09-18T00:00:00.000Z');
  const now = () => observed;
  const store = createSiteMonitorStore({ blob: createBlob(), now, uuid: () => 'prediction-archive-backoff-owner' });
  let fixtureCalls = 0;
  const first = await scanMissingMatchPredictions({
    store, now,
    fetchFixtures: async () => {
      fixtureCalls += 1;
      return { response: [] };
    },
    listPublicArticles: async () => { throw new Error('archive unavailable'); },
  });
  assert.deepEqual(first, { state: 'unavailable', reason: 'public_prediction_archive_unavailable' });
  const state = (await store.readState()).value.matchPredictionRepair;
  assert.equal(state.lastScanError, 'public_prediction_archive_unavailable');
  assert.ok(Date.parse(state.notBefore) > observed.getTime());
  const second = await scanMissingMatchPredictions({
    store, now,
    fetchFixtures: async () => {
      fixtureCalls += 1;
      return { response: [] };
    },
    listPublicArticles: async () => ({ items: [] }),
  });
  assert.equal(second.state, 'throttled');
  assert.equal(fixtureCalls, 3);
});

test('an existing Notion prediction is resynced rather than recreated', async () => {
  const result = await preparePredictionGeneration({
    fixtureId: 1557409,
    fetchFixture: async () => ({ response: [rawFixture()] }),
    listPublicArticles: async () => ({ items: [] }),
    findNotionPrediction: async () => ({
      page: { id: 'existing-notion-prediction', last_edited_time: '2026-09-18T00:00:00.000Z' },
      matchMethod: 'fixture_id', ambiguous: false,
    }),
  });
  assert.equal(result.state, 'notion_prediction_exists');
  assert.equal(result.page.id, 'existing-notion-prediction');
});

test('a later archive page for one fixture still suppresses duplicate prediction generation', async () => {
  const result = await preparePredictionGeneration({
    fixtureId: 1557409,
    fetchFixture: async () => ({ response: [rawFixture()] }),
    listPublicArticles: async ({ page }) => (page === 1
      ? { items: [], page, totalPages: 2 }
      : {
        items: [{
          type: 'match_prediction', public: true, status: 'published',
          match: { fixtureId: 1557409, homeTeam: 'Brighton', awayTeam: 'Arsenal' },
        }], page, totalPages: 2,
      }),
    findNotionPrediction: async () => assert.fail('a public prediction on a later page must prevent source creation'),
  });
  assert.equal(result.state, 'public_prediction_exists');
});

test('deterministic prediction creation uses verified recent form and current player identities only', async () => {
  let published = null;
  const fixture = {
    id: 1557409, leagueId: 39, competition: 'Premier League', season: 2026, round: 'Regular Season - 5',
    status: 'NS', date: '2026-09-19', kickoff: '2026-09-19T14:00:00+00:00', timezone: 'UTC', venue: 'Test Stadium',
    homeTeam: 'Brighton', awayTeam: 'Arsenal', homeTeamId: 51, awayTeamId: 42,
  };
  const homeHistory = [
    completedFixture({ id: 1001, date: '2026-09-14T14:00:00+00:00', homeId: 51, awayId: 99, home: 'Brighton', away: 'Everton', homeGoals: 2, awayGoals: 0 }),
    completedFixture({ id: 1002, date: '2026-09-07T14:00:00+00:00', homeId: 98, awayId: 51, home: 'Leeds', away: 'Brighton', homeGoals: 1, awayGoals: 1 }),
  ];
  const awayHistory = [
    completedFixture({ id: 2001, date: '2026-09-14T14:00:00+00:00', homeId: 42, awayId: 97, home: 'Arsenal', away: 'West Ham', homeGoals: 3, awayGoals: 1 }),
    completedFixture({ id: 2002, date: '2026-09-07T14:00:00+00:00', homeId: 96, awayId: 42, home: 'Fulham', away: 'Arsenal', homeGoals: 0, awayGoals: 2 }),
  ];
  const result = await createGeneratedPrediction({
    fixture,
    match: fixture,
    fetchFixture: async (path, params) => {
      if (path === '/fixtures' && Number(params.team) === 51) return { response: homeHistory };
      if (path === '/fixtures' && Number(params.team) === 42) return { response: awayHistory };
      if (path === '/players/squads' && Number(params.team) === 51) return { response: [{ team: { id: 51 }, players: [{ id: 501, name: 'Brighton Player' }] }] };
      if (path === '/players/squads' && Number(params.team) === 42) return { response: [{ team: { id: 42 }, players: [{ id: 421, name: 'Arsenal Player' }] }] };
      if (path === '/fixtures/players' && Number(params.fixture) === 1001) {
        return { response: [{ team: { id: 51, name: 'Brighton' }, players: [{ player: { id: 501, name: 'Brighton Player' }, statistics: [{ games: { minutes: 90, rating: '8.1' }, goals: { total: 1, assists: 0 } }] }] }] };
      }
      if (path === '/fixtures/players' && Number(params.fixture) === 2001) {
        return { response: [{ team: { id: 42, name: 'Arsenal' }, players: [{ player: { id: 421, name: 'Arsenal Player' }, statistics: [{ games: { minutes: 88, rating: '8.4' }, goals: { total: 1, assists: 1 } }] }] }] };
      }
      assert.fail(`unexpected provider request ${path} ${JSON.stringify(params)}`);
    },
    publishPrediction: async (input) => {
      published = input;
      return { page: { id: 'new-prediction-page', created_time: '2026-09-18T00:00:00.000Z' }, sourceVersion: '2026-09-18T00:00:00.000Z' };
    },
  });
  assert.equal(result.page.id, 'new-prediction-page');
  assert.match(published.draft, /Brighton Player（Brighton）/);
  assert.match(published.draft, /Arsenal Player（Arsenal）/);
  assert.match(published.draft, /予想される試合展開/);
  assert.ok(published.sources.some((source) => source.title.includes('API-Football契約データ')));
  assert.match(published.prediction.score, /^\d-\d$/);
  assert.equal(published.prediction.pick, 'Arsenal');
  assert.ok(published.prediction.confidence >= 50 && published.prediction.confidence <= 100);
});

test('a generated prediction uses the normal delivery, availability, and browser-validation path', async () => {
  let clock = new Date('2026-09-18T00:00:00.000Z');
  const now = () => clock;
  let uuidCount = 0;
  const store = createSiteMonitorStore({ blob: createBlob(), now, uuid: () => `prediction-delivery-owner-${++uuidCount}` });
  const fixture = {
    id: 1557409, status: 'NS', leagueId: 39, competition: 'Premier League',
    date: '2026-09-19', kickoff: '2026-09-19T14:00:00+00:00', timezone: 'UTC',
    homeTeam: 'Brighton', awayTeam: 'Arsenal', homeTeamId: 51, awayTeamId: 42,
  };
  const article = {
    id: 'notion-match_prediction-new-prediction-page', type: 'match_prediction', status: 'published', public: true,
    title: 'Brighton vs Arsenal', body: '検証済みの試合前予想本文。',
    notion: { pageId: 'new-prediction-page', updatedAt: '2026-09-18T00:00:00.000Z', state: '自動生成' },
    match: {
      fixtureId: 1557409, date: '2026-09-19', kickoff: fixture.kickoff, timezone: 'UTC',
      competition: 'Premier League', homeTeam: 'Brighton', awayTeam: 'Arsenal',
      homeTeamId: 51, awayTeamId: 42, canonicalKey: 'premierleague|2026-09-19|brighton|arsenal', identityVersion: 2,
    },
    prediction: {},
  };
  await store.enqueue({
    kind: 'prediction_generation', fixtureId: fixture.id, sourceType: PREDICTION_GENERATION_SOURCE_TYPE,
    sourceVersion: 'scheduled-v1', repairGeneration: PREDICTION_GENERATION_REPAIR_GENERATION,
    trigger: 'scheduled_fixture_scan', priority: 94,
  });
  const notifications = [];
  const dependencies = {
    preparePredictionGeneration: async () => ({ state: 'ready', fixture, match: fixture }),
    createGeneratedPrediction: async () => ({
      page: { id: 'new-prediction-page', created_time: '2026-09-18T00:00:00.000Z' },
      sourceVersion: '2026-09-18T00:00:00.000Z',
    }),
    createSyncStore: () => ({}),
    syncPage: async () => ({
      outcome: 'created', sourceType: 'match_prediction', sourceVersion: article.notion.updatedAt,
      page: { id: article.notion.pageId }, articleId: article.id, article,
    }),
    getArticle: async () => article,
    resolveFixture: async () => ({ state: 'resolved', fixture: { id: fixture.id }, method: 'fixture_id' }),
    associationRepair: (input) => input,
    hydratePrediction: async (input) => input,
    getAvailability: async () => ({ availability: { [fixture.id]: ['prediction'] }, matchAvailability: {} }),
    browserVerify: async () => ({ status: 'passed', checks: { article: { tailChecked: true } } }),
    notify: async (alert) => {
      notifications.push(alert);
      return { state: 'delivered' };
    },
  };
  const settings = {
    ...siteMonitorSettings({}), allowExtendedRun: true, maxRunMs: 285_000,
    minJobStartMs: 220_000, maxJobsPerRun: 1,
  };
  const generated = await runSiteMonitor({
    store, trigger: 'prediction_generation', claimSourceTypes: [PREDICTION_GENERATION_SOURCE_TYPE],
    collect: false, now, settings, dependencies,
  });
  assert.equal(generated.jobs[0].status, 'completed');
  assert.equal(generated.jobs[0].result.predictionGeneration.outcome, 'created_and_synced');
  const queued = (await store.readQueue()).value.items;
  assert.equal(queued.length, 1);
  const browserJob = (await store.readJob(queued[0].jobId)).value;
  assert.equal(browserJob.kind, 'article_validation');
  assert.equal(browserJob.trigger, 'prediction_generation_browser_validation');
  assert.deepEqual(browserJob.payload.rollbackSourceJobIds, [generated.jobs[0].jobId]);
  assert.equal(browserJob.payload.rollbackSourceVersion, article.notion.updatedAt);

  clock = new Date('2026-09-18T00:00:01.000Z');
  const verified = await runSiteMonitor({
    store, trigger: 'editorial_continuation', claimJobKinds: ['article_validation'],
    claimDeliveryOnly: true, collect: false, now, settings, dependencies,
  });
  assert.equal(verified.jobs[0].status, 'completed');
  assert.equal(verified.jobs[0].result.browser.status, 'passed');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].category, 'repair_success');
  const state = (await store.readState()).value.matchPredictionRepair.fixtures[String(fixture.id)];
  assert.equal(state.display, 'prediction_primary_verified');
  assert.equal(state.browser, 'passed');
});

test('a failed generated-prediction browser validation restores a guarded source-job write only', async () => {
  let clock = new Date('2026-09-18T00:00:00.000Z');
  const now = () => clock;
  let uuidCount = 0;
  const store = createSiteMonitorStore({ blob: createBlob(), now, uuid: () => `prediction-lineage-owner-${++uuidCount}` });
  const before = {
    id: 'notion-match_prediction-existing', type: 'match_prediction', status: 'published', public: true,
    body: '監視前の本文。', notion: { pageId: 'existing-page', updatedAt: 'v1', state: '公開済' },
    match: { fixtureId: 1557409, canonicalKey: 'premierleague|2026-09-19|brighton|arsenal', identityVersion: 2 }, prediction: {},
  };
  let current = { ...before, body: '監視が書き込んだ本文。' };
  const queuedGeneration = await store.enqueue({
    kind: 'prediction_generation', fixtureId: 1557409, sourceType: PREDICTION_GENERATION_SOURCE_TYPE,
    sourceVersion: 'scheduled-v1', repairGeneration: PREDICTION_GENERATION_REPAIR_GENERATION,
    trigger: 'test', priority: 94,
  });
  const generationClaim = await store.claimJobs({ owner: 'generation-owner', limit: 1 });
  const generationJob = generationClaim.jobs[0];
  const snapshot = await store.writeSnapshot({
    jobId: generationJob.id, owner: 'generation-owner', before,
    afterDigest: monitorArticleDigest(current), sourceVersion: 'v1', articleId: current.id,
  });
  assert.ok(snapshot);
  await store.finishJob(generationJob.id, {
    owner: 'generation-owner', status: 'completed',
    result: {
      state: 'completed', sourceVersion: 'v1',
      predictionGeneration: { fixtureId: 1557409, sourceVersion: 'v1', outcome: 'created_and_synced' },
    },
  });
  await store.enqueue({
    kind: 'article_validation', articleId: current.id, sourceType: 'match_prediction', sourceVersion: 'v1',
    trigger: 'prediction_generation_browser_validation', priority: 99,
    payload: { rollbackSourceJobIds: [generationJob.id], rollbackSourceVersion: 'v1' },
  });
  const dependencies = {
    getArticle: async () => current,
    resolveFixture: async () => ({ state: 'resolved', fixture: { id: 1557409 }, method: 'fixture_id' }),
    associationRepair: (article) => article,
    hydratePrediction: async (article) => article,
    getAvailability: async () => ({ availability: { 1557409: ['prediction'] }, matchAvailability: {} }),
    browserVerify: async () => ({ status: 'failed', reason: 'prediction_primary_missing' }),
    saveArticle: async (article) => { current = article; },
    notify: async () => ({ state: 'delivered' }),
  };
  const settings = {
    ...siteMonitorSettings({}), allowExtendedRun: true, maxRunMs: 285_000,
    minJobStartMs: 220_000, maxJobsPerRun: 1,
  };
  const first = await runSiteMonitor({
    store, trigger: 'editorial_continuation', claimJobKinds: ['article_validation'], collect: false,
    now, settings, dependencies,
  });
  assert.equal(first.jobs[0].status, 'deferred');
  assert.equal(current.body, '監視が書き込んだ本文。');
  clock = new Date('2026-09-18T00:01:01.000Z');
  const second = await runSiteMonitor({
    store, trigger: 'editorial_continuation', claimJobKinds: ['article_validation'], collect: false,
    now, settings, dependencies,
  });
  assert.equal(second.jobs[0].status, 'blocked');
  assert.equal(second.jobs[0].result.rolledBack[0].state, 'restored');
  assert.equal(current.body, '監視前の本文。');
});

test('a failed generated-prediction browser validation hides a newly created delivery and holds its source version', async () => {
  let clock = new Date('2026-09-18T00:00:00.000Z');
  const now = () => clock;
  let uuidCount = 0;
  const store = createSiteMonitorStore({ blob: createBlob(), now, uuid: () => `prediction-created-owner-${++uuidCount}` });
  const fixture = {
    id: 1557410, status: 'NS', leagueId: 39, competition: 'Premier League',
    date: '2026-09-19', kickoff: '2026-09-19T14:00:00+00:00', timezone: 'UTC',
    homeTeam: 'Everton', awayTeam: 'Ipswich', homeTeamId: 45, awayTeamId: 57,
  };
  const article = {
    id: 'notion-match_prediction-created-page', type: 'match_prediction', status: 'published', public: true,
    title: 'Everton vs Ipswich', body: '監視が新規作成した予想本文。',
    notion: { pageId: 'created-page', updatedAt: '2026-09-18T00:00:00.000Z', state: '自動生成' },
    match: {
      fixtureId: fixture.id, date: fixture.date, kickoff: fixture.kickoff, timezone: fixture.timezone,
      competition: fixture.competition, homeTeam: fixture.homeTeam, awayTeam: fixture.awayTeam,
      homeTeamId: fixture.homeTeamId, awayTeamId: fixture.awayTeamId,
      canonicalKey: 'premierleague|2026-09-19|everton|ipswich', identityVersion: 2,
    },
    prediction: {},
  };
  const database = new Map();
  await store.enqueue({
    kind: 'prediction_generation', fixtureId: fixture.id, sourceType: PREDICTION_GENERATION_SOURCE_TYPE,
    sourceVersion: 'scheduled-v1', repairGeneration: PREDICTION_GENERATION_REPAIR_GENERATION,
    trigger: 'test', priority: 94,
  });
  const dependencies = {
    preparePredictionGeneration: async () => ({ state: 'ready', fixture, match: fixture }),
    createGeneratedPrediction: async () => ({
      page: { id: article.notion.pageId, created_time: article.notion.updatedAt },
      sourceVersion: article.notion.updatedAt,
    }),
    createSyncStore: () => ({}),
    syncPage: async (options) => {
      const existing = database.get(article.id) || null;
      const allowed = await options.beforeWrite({
        existingArticle: existing ? structuredClone(existing) : null,
        article: structuredClone(article),
        page: { id: article.notion.pageId, last_edited_time: article.notion.updatedAt },
      });
      if (!allowed) return { outcome: 'write_cancelled' };
      database.set(article.id, structuredClone(article));
      return {
        outcome: existing ? 'updated' : 'created', article: structuredClone(article),
        articleId: article.id, sourceType: article.type, sourceVersion: article.notion.updatedAt,
      };
    },
    getArticle: async (id) => database.has(id) ? structuredClone(database.get(id)) : null,
    saveArticle: async (value) => database.set(value.id, structuredClone(value)),
    resolveFixture: async () => ({ state: 'resolved', fixture: { id: fixture.id }, method: 'fixture_id' }),
    associationRepair: (input) => input,
    hydratePrediction: async (input) => input,
    getAvailability: async () => ({ availability: { [fixture.id]: ['prediction'] }, matchAvailability: {} }),
    browserVerify: async () => ({ status: 'failed', reason: 'prediction_primary_missing' }),
    notify: async () => ({ state: 'delivered' }),
  };
  const settings = {
    ...siteMonitorSettings({}), allowExtendedRun: true, maxRunMs: 285_000,
    minJobStartMs: 220_000, maxJobsPerRun: 1,
  };
  const generated = await runSiteMonitor({
    store, trigger: 'prediction_generation', claimSourceTypes: [PREDICTION_GENERATION_SOURCE_TYPE],
    collect: false, now, settings, dependencies,
  });
  assert.equal(generated.jobs[0].status, 'completed');
  assert.equal(database.get(article.id).public, true);
  const sourceSnapshots = await store.readSnapshots(generated.jobs[0].jobId);
  assert.equal(sourceSnapshots.length, 1);
  assert.equal(sourceSnapshots[0].createdArticle, true);

  clock = new Date('2026-09-18T00:00:01.000Z');
  const first = await runSiteMonitor({
    store, trigger: 'editorial_continuation', claimJobKinds: ['article_validation'], claimDeliveryOnly: true,
    collect: false, now, settings, dependencies,
  });
  assert.equal(first.jobs[0].status, 'deferred');
  assert.equal(database.get(article.id).public, true);

  clock = new Date('2026-09-18T00:01:02.000Z');
  const second = await runSiteMonitor({
    store, trigger: 'editorial_continuation', claimJobKinds: ['article_validation'], claimDeliveryOnly: true,
    collect: false, now, settings, dependencies,
  });
  assert.equal(second.jobs[0].status, 'blocked');
  assert.equal(second.jobs[0].result.rolledBack[0].state, 'hidden');
  const withdrawn = database.get(article.id);
  assert.equal(withdrawn.public, false);
  assert.equal(withdrawn.siteMonitor.deliveryHold.sourceVersion, article.notion.updatedAt);
  const audit = (await store.readState()).value.matchPredictionRepair.fixtures[String(fixture.id)];
  assert.equal(audit.outcome, 'browser_validation_failed');
  assert.equal(audit.display, 'prediction_pending');
});

test('a browser-validation enqueue failure withdraws the generated delivery before retrying without a duplicate source page', async () => {
  let clock = new Date('2026-09-18T00:00:00.000Z');
  const now = () => clock;
  let uuidCount = 0;
  const store = createSiteMonitorStore({ blob: createBlob(), now, uuid: () => `prediction-enqueue-owner-${++uuidCount}` });
  const fixture = {
    id: 1557414, status: 'NS', leagueId: 39, competition: 'Premier League',
    date: '2026-09-19', kickoff: '2026-09-19T14:00:00+00:00', timezone: 'UTC',
    homeTeam: 'Newcastle', awayTeam: 'Hull City', homeTeamId: 34, awayTeamId: 63,
  };
  const article = {
    id: 'notion-match_prediction-enqueue-page', type: 'match_prediction', status: 'published', public: true,
    title: 'Newcastle vs Hull City', body: '監視が新規作成した予想本文。',
    notion: { pageId: 'enqueue-page', updatedAt: '2026-09-18T00:00:00.000Z', state: '自動生成' },
    match: {
      fixtureId: fixture.id, date: fixture.date, kickoff: fixture.kickoff, timezone: fixture.timezone,
      competition: fixture.competition, homeTeam: fixture.homeTeam, awayTeam: fixture.awayTeam,
      homeTeamId: fixture.homeTeamId, awayTeamId: fixture.awayTeamId,
      canonicalKey: 'premierleague|2026-09-19|newcastle|hullcity', identityVersion: 2,
    },
    prediction: {},
  };
  const database = new Map();
  await store.enqueue({
    kind: 'prediction_generation', fixtureId: fixture.id, sourceType: PREDICTION_GENERATION_SOURCE_TYPE,
    sourceVersion: 'scheduled-v1', repairGeneration: PREDICTION_GENERATION_REPAIR_GENERATION,
    trigger: 'test', priority: 94,
  });
  const durableEnqueue = store.enqueue.bind(store);
  let failChildEnqueue = true;
  store.enqueue = async (input) => {
    if (input.kind === 'article_validation' && failChildEnqueue) {
      failChildEnqueue = false;
      throw new Error('temporary validation queue write failure');
    }
    return durableEnqueue(input);
  };
  let createdCount = 0;
  let prepareCount = 0;
  const dependencies = {
    preparePredictionGeneration: async () => {
      prepareCount += 1;
      return prepareCount === 1
        ? { state: 'ready', fixture, match: fixture }
        : {
          state: 'notion_prediction_exists', fixture, match: fixture,
          page: { id: article.notion.pageId, last_edited_time: article.notion.updatedAt },
          sourceVersion: article.notion.updatedAt,
        };
    },
    createGeneratedPrediction: async () => {
      createdCount += 1;
      return {
        page: { id: article.notion.pageId, created_time: article.notion.updatedAt },
        sourceVersion: article.notion.updatedAt,
      };
    },
    createSyncStore: () => ({}),
    syncPage: async (options) => {
      const existing = database.get(article.id) || null;
      const allowed = await options.beforeWrite({
        existingArticle: existing ? structuredClone(existing) : null,
        article: structuredClone(article),
        page: { id: article.notion.pageId, last_edited_time: article.notion.updatedAt },
      });
      if (!allowed) return { outcome: 'write_cancelled' };
      database.set(article.id, structuredClone(article));
      return {
        outcome: existing ? 'updated' : 'created', article: structuredClone(article),
        articleId: article.id, sourceType: article.type, sourceVersion: article.notion.updatedAt,
      };
    },
    getArticle: async (id) => database.has(id) ? structuredClone(database.get(id)) : null,
    saveArticle: async (value) => database.set(value.id, structuredClone(value)),
    resolveFixture: async () => ({ state: 'resolved', fixture: { id: fixture.id }, method: 'fixture_id' }),
    associationRepair: (input) => input,
    hydratePrediction: async (input) => input,
    getAvailability: async () => ({ availability: { [fixture.id]: ['prediction'] }, matchAvailability: {} }),
    browserVerify: async () => ({ status: 'passed' }),
    notify: async () => ({ state: 'delivered' }),
  };
  const settings = {
    ...siteMonitorSettings({}), allowExtendedRun: true, maxRunMs: 285_000,
    minJobStartMs: 220_000, maxJobsPerRun: 1,
  };
  const first = await runSiteMonitor({
    store, trigger: 'prediction_generation', claimSourceTypes: [PREDICTION_GENERATION_SOURCE_TYPE],
    collect: false, now, settings, dependencies,
  });
  assert.equal(first.jobs[0].status, 'deferred');
  assert.equal(createdCount, 1);
  assert.equal(database.get(article.id).public, false);
  assert.equal(database.get(article.id).siteMonitor.deliveryHold, undefined);

  clock = new Date('2026-09-18T00:00:31.000Z');
  const second = await runSiteMonitor({
    store, trigger: 'prediction_generation', claimSourceTypes: [PREDICTION_GENERATION_SOURCE_TYPE],
    collect: false, now, settings, dependencies,
  });
  assert.equal(second.jobs[0].status, 'completed');
  assert.equal(createdCount, 1);
  assert.equal(database.get(article.id).public, true);
  const queued = (await store.readQueue()).value.items;
  assert.equal(queued.length, 1);
  const validation = (await store.readJob(queued[0].jobId)).value;
  assert.equal(validation.trigger, 'prediction_generation_browser_validation');
  assert.deepEqual(validation.payload.rollbackSourceJobIds, [second.jobs[0].jobId]);
  assert.equal(validation.payload.rollbackSourceVersion, article.notion.updatedAt);
});

test('the monitor claims a prediction-generation job only in the explicitly extended worker lane', async () => {
  const now = () => new Date('2026-09-18T00:00:00.000Z');
  const store = createSiteMonitorStore({ blob: createBlob(), now, uuid: () => 'prediction-generation-owner' });
  await store.enqueue({
    kind: 'prediction_generation', fixtureId: 1557409, sourceType: PREDICTION_GENERATION_SOURCE_TYPE,
    sourceVersion: 'scheduled-v1', trigger: 'test', priority: 94,
  });
  const result = await runSiteMonitor({
    store, trigger: 'prediction_generation', claimSourceTypes: [PREDICTION_GENERATION_SOURCE_TYPE], collect: false, now,
    settings: {
      ...siteMonitorSettings({}), allowExtendedRun: true, maxRunMs: 285_000,
      minJobStartMs: 220_000, maxJobsPerRun: 1,
    },
    dependencies: {
      preparePredictionGeneration: async () => ({ state: 'public_prediction_exists', fixture: { id: 1557409 } }),
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].result.reason, 'public_prediction_exists');
});

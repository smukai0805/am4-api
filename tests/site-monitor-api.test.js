import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  isExpectedProductionDeploymentEvent,
  respondWithNotionSiteMonitorWebhook,
  respondWithSiteMonitor,
  respondWithVercelSiteMonitorWebhook,
} from '../api/site-monitor.js';
import { createSiteMonitorStore, siteMonitorPath } from '../lib/site-monitor-store.js';
import { MATCH_EDITORIAL_BACKFILL_GENERATION } from '../lib/match-editorial-sync.js';
import { PREDICTION_GENERATION_SOURCE_TYPE } from '../lib/match-prediction-repair.js';

function createBlob() {
  const data = new Map();
  let revision = 0;
  const conflict = () => Object.assign(new Error('etag mismatch'), { status: 412 });
  return {
    values: data,
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

function response() {
  return {
    headers: new Map(), statusCode: null, body: undefined,
    setHeader(key, value) { this.headers.set(key.toLowerCase(), value); },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end(value) { this.body = value; return this; },
  };
}

function notionRequest(payload, secret) {
  const raw = JSON.stringify(payload);
  return {
    method: 'POST', query: { notionWebhook: '1' }, body: raw,
    headers: { 'x-notion-signature': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` },
  };
}

function vercelRequest(payload, secret) {
  const raw = JSON.stringify(payload);
  return {
    method: 'POST', query: { vercelWebhook: '1' }, body: raw,
    headers: { 'x-vercel-signature': createHmac('sha1', secret).update(raw).digest('hex') },
  };
}

function fixtureEnv() {
  return {
    NOTION_API_KEY: 'notion-read-key',
    NOTION_WEBHOOK_VERIFICATION_TOKEN: 'notion-webhook-token',
    SITE_MONITOR_VERCEL_WEBHOOK_SECRET: 'vercel-webhook-token',
    SITE_MONITOR_ADMIN_SECRET: 'admin-token',
    CRON_SECRET: 'cron-token',
    SITE_MONITOR_VERCEL_PROJECT_ID: 'prj-test',
    SITE_MONITOR_VERCEL_TEAM_ID: 'team-test',
  };
}

function monitorResult(trigger) {
  return { status: 'completed', runId: `run-${trigger}`, trigger, jobs: [], usage: { apiCalls: 0, browserLaunches: 0, repairOperations: 0 } };
}

test('Notion webhook rejects an invalid signature before it can write an event or queue', async () => {
  const blob = createBlob();
  const store = createSiteMonitorStore({ blob });
  const env = fixtureEnv();
  const req = notionRequest({ id: 'evt-invalid', type: 'page.content_updated', entity: { type: 'page', id: 'page-1' } }, 'wrong');
  const res = response();
  await respondWithNotionSiteMonitorWebhook(req, res, { env, createStore: () => store });
  assert.equal(res.statusCode, 401);
  assert.equal((await store.readQueue()).value.items.length, 0);
});

test('Notion duplicate and reordered events are recorded first but coalesce to the latest verified source version', async () => {
  const blob = createBlob();
  const store = createSiteMonitorStore({ blob });
  const env = fixtureEnv();
  let targetCalls = 0;
  const target = async () => {
    targetCalls += 1;
    return { outcome: 'eligible', pageId: 'page-1', sourceType: 'match_prediction', sourceVersion: '2026-09-14T01:00:00.000Z' };
  };
  const runMonitor = async () => { throw new Error('webhook receipt must not run a repair worker'); };
  const base = { type: 'page.content_updated', entity: { type: 'page', id: 'page-1' } };
  const first = response();
  await respondWithNotionSiteMonitorWebhook(notionRequest({ ...base, id: 'evt-new', timestamp: '2026-09-14T01:00:00.000Z' }, env.NOTION_WEBHOOK_VERIFICATION_TOKEN), first, {
    env, createStore: () => store, getTarget: target, runMonitor, notify: async () => ({ state: 'unconfigured' }),
  });
  const duplicate = response();
  await respondWithNotionSiteMonitorWebhook(notionRequest({ ...base, id: 'evt-new', timestamp: '2026-09-14T01:00:00.000Z' }, env.NOTION_WEBHOOK_VERIFICATION_TOKEN), duplicate, {
    env, createStore: () => store, getTarget: target, runMonitor, notify: async () => ({ state: 'unconfigured' }),
  });
  const delayedOld = response();
  await respondWithNotionSiteMonitorWebhook(notionRequest({ ...base, id: 'evt-old', timestamp: '2026-09-14T00:59:00.000Z' }, env.NOTION_WEBHOOK_VERIFICATION_TOKEN), delayedOld, {
    env, createStore: () => store, getTarget: target, runMonitor, notify: async () => ({ state: 'unconfigured' }),
  });
  assert.equal(first.statusCode, 202);
  assert.equal(duplicate.body.duplicateEvent, true);
  assert.equal(delayedOld.statusCode, 202);
  assert.equal((await store.readQueue()).value.items.length, 1);
  // The exact redelivery is durably known already and must not trigger a
  // second Notion lookup. A distinct delayed event is still resolved against
  // the current version, then shares the same priority queue entry. Neither
  // handler is allowed to leave an uncancellable repair worker running after
  // it sends its webhook acknowledgement.
  assert.equal(targetCalls, 2);
  assert.equal(first.body.worker.state, 'queued_for_priority_worker');
  assert.equal(delayedOld.body.worker.state, 'already_queued');
});

test('a signed Notion 429 persists its Retry-After for every source and acknowledges the event without an early retry', async () => {
  const clock = new Date('2026-09-14T01:00:00.000Z');
  const blob = createBlob();
  const store = createSiteMonitorStore({ blob, now: () => clock });
  const env = fixtureEnv();
  let targetCalls = 0;
  const target = async () => {
    targetCalls += 1;
    return { outcome: 'rate_limited', retryAfterMs: 17_000 };
  };
  const payload = { id: 'evt-429', type: 'page.content_updated', entity: { type: 'page', id: 'page-1' } };
  const first = response();
  await respondWithNotionSiteMonitorWebhook(notionRequest(payload, env.NOTION_WEBHOOK_VERIFICATION_TOKEN), first, {
    env, createStore: () => store, getTarget: target, now: () => clock,
  });
  assert.equal(first.statusCode, 202);
  assert.equal(first.body.worker.reason, 'notion_rate_limited');
  const notBefore = (await store.readState()).value.collector.notBefore;
  for (const sourceType of ['match_prediction', 'match_report', 'am4_story']) {
    assert.equal(notBefore[sourceType], '2026-09-14T01:00:17.000Z');
  }
  const duplicate = response();
  await respondWithNotionSiteMonitorWebhook(notionRequest(payload, env.NOTION_WEBHOOK_VERIFICATION_TOKEN), duplicate, {
    env, createStore: () => store, getTarget: target, now: () => clock,
  });
  assert.equal(duplicate.statusCode, 202);
  assert.equal(duplicate.body.worker.state, 'already_recorded');
  assert.equal(targetCalls, 1);
});

test('Vercel webhook accepts only signed production-promotion events from the configured team/project', async () => {
  const blob = createBlob();
  const store = createSiteMonitorStore({ blob });
  const env = fixtureEnv();
  const production = {
    id: 'delivery-1', type: 'deployment.promoted', createdAt: 1,
    payload: { team: { id: 'team-test' }, project: { id: 'prj-test' }, deployment: { id: 'dpl-production' } },
  };
  const res = response();
  const calls = [];
  await respondWithVercelSiteMonitorWebhook(vercelRequest(production, env.SITE_MONITOR_VERCEL_WEBHOOK_SECRET), res, {
    env, createStore: () => store,
    runMonitor: async (input) => {
      calls.push(input);
      return input.trigger === 'vercel_webhook'
        ? {
          status: 'completed',
          jobs: [{
            jobId: input.onlyJobIds[0], status: 'completed',
            result: { state: 'completed', validationJobIds: ['visual-job'] },
          }],
        }
        : input.trigger === 'vercel_webhook_editorial_collection'
          ? {
            status: 'completed',
            collected: { queued: ['source-job'], collected: { errors: {} }, quotaExceeded: null },
            jobs: [],
          }
        : {
          status: 'completed',
          jobs: [{
            jobId: input.onlyJobIds[0], status: 'completed',
            result: { state: 'completed', browser: { status: 'passed' } },
          }],
        };
    },
  });
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.deploymentId, 'dpl-production');
  assert.equal(res.body.worker.state, 'deployment_validation_completed');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].collect, false);
  assert.equal(Object.hasOwn(calls[0], 'allowReportGeneration'), false);
  assert.equal(calls[0].settings.browserEnabled, false);
  assert.equal(calls[1].trigger, 'vercel_webhook_editorial_collection');
  assert.equal(calls[1].collect, true);
  assert.equal(calls[1].settings.maxJobsPerRun, 0);
  assert.equal(calls[1].settings.browserEnabled, false);
  assert.deepEqual(res.body.worker.dispatch.editorialCollection, {
    status: 'completed', queued: 1, sourceErrors: [], quotaExceeded: false,
  });
  assert.equal(calls[2].trigger, 'vercel_webhook_visual');
  assert.deepEqual(calls[2].onlyJobIds, ['visual-job']);
  assert.equal(calls[2].settings.browserEnabled, true);
  assert.equal((await store.readQueue()).value.items.length, 1);

  const ignored = isExpectedProductionDeploymentEvent({
    ...production, type: 'deployment.ready', payload: { ...production.payload, target: 'preview' },
  }, env);
  assert.deepEqual(ignored, { accepted: false, reason: 'unsupported_event' });

  const tampered = response();
  await respondWithVercelSiteMonitorWebhook(vercelRequest(production, 'wrong'), tampered, { env, createStore: () => store });
  assert.equal(tampered.statusCode, 401);
});

test('a duplicate signed Vercel production event reprojects its durable queue entry without launching a worker', async () => {
  const blob = createBlob();
  const store = createSiteMonitorStore({ blob });
  const env = fixtureEnv();
  const production = {
    id: 'delivery-duplicate', type: 'deployment.promoted', createdAt: 1,
    payload: { team: { id: 'team-test' }, project: { id: 'prj-test' }, deployment: { id: 'dpl-production' } },
  };
  let workerCalls = 0;
  const runMonitor = async (input) => {
    workerCalls += 1;
    return { status: 'completed', jobs: [{ jobId: input.onlyJobIds[0], status: 'completed', result: { state: 'completed' } }] };
  };
  const first = response();
  await respondWithVercelSiteMonitorWebhook(vercelRequest(production, env.SITE_MONITOR_VERCEL_WEBHOOK_SECRET), first, {
    env, createStore: () => store, runMonitor,
  });
  const duplicate = response();
  await respondWithVercelSiteMonitorWebhook(vercelRequest(production, env.SITE_MONITOR_VERCEL_WEBHOOK_SECRET), duplicate, {
    env, createStore: () => store, runMonitor,
  });
  assert.equal(first.statusCode, 202);
  assert.equal(duplicate.statusCode, 202);
  assert.equal(duplicate.body.duplicateEvent, true);
  assert.equal(duplicate.body.queued, false);
  assert.equal(duplicate.body.worker.state, 'already_queued');
  assert.equal(workerCalls, 2);
  assert.equal((await store.readQueue()).value.items.length, 1);
});

test('distinct signed Vercel deliveries for one deployment share one bounded worker dispatch', async () => {
  const blob = createBlob();
  const store = createSiteMonitorStore({ blob });
  const env = fixtureEnv();
  const base = {
    type: 'deployment.promoted', createdAt: 1,
    payload: { team: { id: 'team-test' }, project: { id: 'prj-test' }, deployment: { id: 'dpl-production' } },
  };
  let workerCalls = 0;
  const runMonitor = async (input) => {
    workerCalls += 1;
    return { status: 'completed', jobs: [{ jobId: input.onlyJobIds[0], status: 'completed', result: { state: 'completed' } }] };
  };
  const first = response();
  await respondWithVercelSiteMonitorWebhook(vercelRequest({ ...base, id: 'delivery-a' }, env.SITE_MONITOR_VERCEL_WEBHOOK_SECRET), first, {
    env, createStore: () => store, runMonitor,
  });
  const delayedEquivalent = response();
  await respondWithVercelSiteMonitorWebhook(vercelRequest({ ...base, id: 'delivery-b' }, env.SITE_MONITOR_VERCEL_WEBHOOK_SECRET), delayedEquivalent, {
    env, createStore: () => store, runMonitor,
  });
  assert.equal(first.body.queued, true);
  assert.equal(first.body.worker.state, 'deployment_validation_completed');
  assert.equal(delayedEquivalent.body.duplicateEvent, false);
  assert.equal(delayedEquivalent.body.queued, false);
  assert.equal(delayedEquivalent.body.worker.state, 'already_queued');
  assert.equal(workerCalls, 2);
  assert.equal((await store.readQueue()).value.items.length, 1);
});

test('Cron and manual monitor routes are separately authenticated', async () => {
  const env = fixtureEnv();
  const blob = createBlob();
  const store = createSiteMonitorStore({ blob });
  const calls = [];
  const runMonitor = async (input) => { calls.push(input); return monitorResult(input.trigger); };

  const denied = response();
  await respondWithSiteMonitor({ method: 'GET', query: { cron: '1' }, headers: {} }, denied, { env, createStore: () => store, runMonitor });
  assert.equal(denied.statusCode, 401);

  const cron = response();
  await respondWithSiteMonitor({ method: 'GET', query: { cron: '1' }, headers: { authorization: 'Bearer cron-token' } }, cron, { env, createStore: () => store, runMonitor });
  assert.equal(cron.statusCode, 200);
  assert.equal(calls[0].trigger, 'cron');

  const wrongMethod = response();
  await respondWithSiteMonitor({ method: 'GET', query: { run: '1' }, headers: { authorization: 'Bearer admin-token' } }, wrongMethod, { env, createStore: () => store, runMonitor });
  assert.equal(wrongMethod.statusCode, 405);

  const manual = response();
  await respondWithSiteMonitor({ method: 'POST', query: { run: '1' }, headers: { authorization: 'Bearer admin-token' } }, manual, { env, createStore: () => store, runMonitor });
  assert.equal(manual.statusCode, 200);
  assert.equal(calls[1].trigger, 'manual');

  env.VERCEL_DEPLOYMENT_ID = 'dpl-manual-check';
  const recheck = response();
  await respondWithSiteMonitor({ method: 'POST', query: { run: '1', recheckDeployment: '1' }, headers: { authorization: 'Bearer admin-token' } }, recheck, { env, createStore: () => store, runMonitor });
  assert.equal(recheck.statusCode, 200);
  assert.equal(calls[2].trigger, 'manual_deployment_recheck');
  assert.equal(calls[2].collect, false);
  assert.equal(calls[2].deploymentId, 'dpl-manual-check');
  const firstQueue = (await store.readQueue()).value.items;
  assert.equal(firstQueue.length, 1);
  const firstJob = (await store.readJob(firstQueue[0].jobId)).value;
  assert.equal(firstJob.verificationOnly, true);
  assert.ok(firstJob.validationId);

  const repeatedRecheck = response();
  await respondWithSiteMonitor({ method: 'POST', query: { run: '1', recheckDeployment: '1' }, headers: { authorization: 'Bearer admin-token' } }, repeatedRecheck, { env, createStore: () => store, runMonitor });
  assert.equal(repeatedRecheck.statusCode, 200);
  assert.equal(calls[3].trigger, 'manual_deployment_recheck');
  const secondQueue = (await store.readQueue()).value.items;
  assert.equal(secondQueue.length, 2);
  const secondJob = (await store.readJob(secondQueue[1].jobId)).value;
  assert.notEqual(secondJob.validationId, firstJob.validationId);

  const articleRecheck = response();
  await respondWithSiteMonitor({ method: 'POST', query: { run: '1', recheckArticle: 'notion-match_report-page-1' }, headers: { authorization: 'Bearer admin-token' } }, articleRecheck, { env, createStore: () => store, runMonitor });
  assert.equal(articleRecheck.statusCode, 200);
  assert.equal(calls[4].trigger, 'manual_article_recheck');
  assert.equal(calls[4].collect, false);
  assert.equal(calls[4].settings.maxJobsPerRun, 1);
  const articleQueue = (await store.readQueue()).value.items;
  const queuedJobs = await Promise.all(articleQueue.map(async (item) => (await store.readJob(item.jobId)).value));
  const articleJob = queuedJobs.find((job) => job.articleId === 'notion-match_report-page-1');
  assert.equal(articleJob.articleId, 'notion-match_report-page-1');
  assert.equal(articleJob.verificationOnly, true);
  assert.deepEqual(calls[4].onlyJobIds, [articleJob.id]);

  const invalidArticleRecheck = response();
  await respondWithSiteMonitor({ method: 'POST', query: { run: '1', recheckArticle: '../articles/index' }, headers: { authorization: 'Bearer admin-token' } }, invalidArticleRecheck, { env, createStore: () => store, runMonitor });
  assert.equal(invalidArticleRecheck.statusCode, 400);

  const combinedRecheck = response();
  await respondWithSiteMonitor({ method: 'POST', query: { run: '1', recheckDeployment: '1', recheckArticle: 'notion-match_report-page-1' }, headers: { authorization: 'Bearer admin-token' } }, combinedRecheck, { env, createStore: () => store, runMonitor });
  assert.equal(combinedRecheck.statusCode, 400);

  const deniedContinuation = response();
  await respondWithSiteMonitor({ method: 'GET', query: { continuation: '1' }, headers: {} }, deniedContinuation, { env, createStore: () => store, runMonitor });
  assert.equal(deniedContinuation.statusCode, 401);

  const continuation = response();
  await respondWithSiteMonitor({ method: 'GET', query: { continuation: '1' }, headers: { authorization: 'Bearer cron-token' } }, continuation, { env, createStore: () => store, runMonitor });
  assert.equal(continuation.statusCode, 200);
  assert.equal(calls[5].trigger, 'continuation');
  assert.equal(calls[5].collect, false);

  const deniedEditorialContinuation = response();
  await respondWithSiteMonitor({ method: 'GET', query: { editorialContinuation: '1' }, headers: {} }, deniedEditorialContinuation, { env, createStore: () => store, runMonitor });
  assert.equal(deniedEditorialContinuation.statusCode, 401);

  // Steady-state minute work must remain a queue drain. A distinct test below
  // covers the one-time generation-mismatch source scan.
  await store.updateState((state) => ({
    ...state,
    matchEditorialSync: {
      ...(state.matchEditorialSync || {}),
      backfill: {
        ...(state.matchEditorialSync?.backfill || {}),
        match_report: { generation: MATCH_EDITORIAL_BACKFILL_GENERATION, sourceScanCompletedAt: '2026-09-17T00:00:00.000Z' },
        match_prediction: { generation: MATCH_EDITORIAL_BACKFILL_GENERATION, sourceScanCompletedAt: '2026-09-17T00:00:00.000Z' },
      },
    },
  }));

  const editorialContinuation = response();
  await respondWithSiteMonitor({ method: 'GET', query: { editorialContinuation: '1' }, headers: { authorization: 'Bearer cron-token' } }, editorialContinuation, { env, createStore: () => store, runMonitor });
  assert.equal(editorialContinuation.statusCode, 200);
  assert.equal(calls[6].trigger, 'editorial_continuation');
  assert.equal(calls[6].collect, false);
  assert.deepEqual(calls[6].claimSourceTypes, ['match_report', 'match_prediction']);
  assert.deepEqual(calls[6].claimJobKinds, ['deployment_validation', 'article_validation', 'transient_browser_recovery', 'notification_delivery']);
  assert.equal(calls[6].claimDeliveryOnly, true);
  assert.ok(calls[6].settings.maxJobsPerRun >= 40);
  assert.ok(calls[6].settings.maxApiCallsPerRun >= 500);
  assert.ok(calls[6].settings.maxApiCallsPerDay >= 5_000);
  assert.ok(calls[6].settings.maxRepairsPerDay >= 1_500);
  assert.equal(calls[6].settings.maxBrowserLaunchesPerDay, 20);
  assert.equal(
    (await store.readState()).value.browserRuntimeRecovery.browserQuotaPolicyVersion,
    'browser-runtime-interruption-recovery-browser-reserve-v1',
  );
});

test('the authenticated Production Cron queues one bounded deployment validation when webhook delivery is absent', async () => {
  const env = {
    ...fixtureEnv(),
    VERCEL_ENV: 'production',
    VERCEL_DEPLOYMENT_ID: 'dpl-production-a',
    SITE_MONITOR_MAX_BROWSER_LAUNCHES_PER_DAY: '5',
  };
  const store = createSiteMonitorStore({ blob: createBlob() });
  const calls = [];
  const runMonitor = async (input) => {
    calls.push(input);
    return monitorResult(input.trigger);
  };

  const first = response();
  await respondWithSiteMonitor({
    method: 'GET', query: { cron: '1' }, headers: { authorization: 'Bearer cron-token' },
  }, first, { env, createStore: () => store, runMonitor });
  assert.equal(first.statusCode, 200);
  assert.equal(calls[0].deploymentId, 'dpl-production-a');
  assert.equal(calls[0].settings.maxBrowserLaunchesPerDay, 12);
  let queue = (await store.readQueue()).value.items;
  assert.equal(queue.length, 1);
  let job = (await store.readJob(queue[0].jobId)).value;
  assert.equal(job.kind, 'deployment_validation');
  assert.equal(job.deploymentId, 'dpl-production-a');
  assert.equal(job.trigger, 'cron_deployment_detection');

  const duplicate = response();
  await respondWithSiteMonitor({
    method: 'GET', query: { cron: '1' }, headers: { authorization: 'Bearer cron-token' },
  }, duplicate, { env, createStore: () => store, runMonitor });
  queue = (await store.readQueue()).value.items;
  assert.equal(queue.length, 1);

  env.VERCEL_DEPLOYMENT_ID = 'dpl-production-b';
  const laterDeployment = response();
  await respondWithSiteMonitor({
    method: 'GET', query: { cron: '1' }, headers: { authorization: 'Bearer cron-token' },
  }, laterDeployment, { env, createStore: () => store, runMonitor });
  queue = (await store.readQueue()).value.items;
  assert.equal(queue.length, 2);
  job = (await store.readJob(queue[1].jobId)).value;
  assert.equal(job.deploymentId, 'dpl-production-b');
});

test('Production Cron retains its finite visual-validation ceiling when deployment identity is supplied by a webhook', async () => {
  const env = {
    ...fixtureEnv(),
    SITE_MONITOR_MAX_BROWSER_LAUNCHES_PER_DAY: '5',
  };
  const calls = [];
  const res = response();
  await respondWithSiteMonitor({
    method: 'GET', query: { cron: '1' }, headers: { authorization: 'Bearer cron-token' },
  }, res, {
    env,
    createStore: () => createSiteMonitorStore({ blob: createBlob() }),
    runMonitor: async (input) => {
      calls.push(input);
      return monitorResult(input.trigger);
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(calls[0].settings.maxBrowserLaunchesPerDay, 12);
});

test('an editorial continuation resumes a missing source generation exactly through the durable backfill worker', async () => {
  const env = fixtureEnv();
  const store = createSiteMonitorStore({ blob: createBlob() });
  const calls = [];
  const res = response();
  await respondWithSiteMonitor({
    method: 'GET', query: { editorialContinuation: '1' }, headers: { authorization: 'Bearer cron-token' },
  }, res, {
    env,
    createStore: () => store,
    runMonitor: async (input) => {
      calls.push(input);
      return monitorResult(input.trigger);
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].trigger, 'match_editorial_backfill');
  assert.equal(calls[0].collect, true);
  assert.deepEqual(calls[0].claimSourceTypes, ['match_report', 'match_prediction']);
  assert.equal(calls[0].claimDeliveryOnly, true);
  assert.ok(calls[0].settings.maxJobsPerRun >= 40);
  assert.ok(calls[0].settings.maxApiCallsPerRun >= 500);
});

test('concurrent editorial continuations reconnect exactly two code-owned browser-runtime recoveries', async () => {
  const clock = new Date('2026-09-18T00:00:00.000Z');
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => clock });
  const malformed = await store.enqueue({
    kind: 'transient_browser_recovery', pageId: 'page-malformed', articleId: 'notion-match_prediction-malformed',
    sourceType: 'match_prediction', sourceVersion: 'v1', repairGeneration: 'browser-runtime-interruption-recovery-v1',
  });
  const valid = [];
  for (const suffix of ['one', 'two', 'three']) {
    valid.push(await store.enqueue({
      kind: 'transient_browser_recovery', pageId: `page-${suffix}`, articleId: `notion-match_prediction-${suffix}`,
      sourceType: 'match_prediction', sourceVersion: 'v1', repairGeneration: 'browser-runtime-interruption-recovery-v1',
      trigger: 'transient_browser_runtime_recovery', payload: { releaseMonitorDeliveryHold: true },
    }));
  }
  for (const job of [malformed, ...valid]) {
    const claim = await store.claimJobs({ owner: `owner-${job.job.id}`, jobIds: [job.job.id] });
    await store.deferJob(claim.jobs[0].id, {
      owner: `owner-${job.job.id}`, reason: 'browser_usage_limit', delayMs: 12 * 60 * 60 * 1000,
    });
  }
  const calls = [];
  const dependencies = {
    env: fixtureEnv(), now: () => clock, createStore: () => store,
    listPublicArticles: async () => ({ items: [], page: 1, totalPages: 1 }),
    scanMissingReports: async () => ({ state: 'not_configured', finishedFixtures: 0, missingReports: 0, queued: [] }),
    scanMissingPredictions: async () => ({ state: 'not_configured', scheduledFixtures: 0, missingPredictions: 0, queued: [] }),
    scanDuplicateCandidates: async () => ({ state: 'not_needed', candidates: 0, types: {} }),
    runMonitor: async (input) => { calls.push(input); return monitorResult(input.trigger); },
  };
  const request = {
    method: 'GET', query: { editorialContinuation: '1' }, headers: { authorization: 'Bearer cron-token' },
  };
  const first = response();
  const second = response();
  await Promise.all([
    respondWithSiteMonitor(request, first, dependencies),
    respondWithSiteMonitor(request, second, dependencies),
  ]);

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(calls.length, 2);
  const queue = (await store.readQueue()).value.items;
  const released = valid.filter((job) => (
    queue.find((item) => item.jobId === job.job.id).availableAt === clock.toISOString()
  ));
  assert.equal(released.length, 2);
  assert.notEqual(queue.find((item) => item.jobId === malformed.job.id).availableAt, clock.toISOString());
  assert.equal((await store.readJob(malformed.job.id)).value.lastError, 'browser_usage_limit');
  const recovery = (await store.readState()).value.browserRuntimeRecovery;
  assert.equal(recovery.browserQuotaPolicyVersion, 'browser-runtime-interruption-recovery-browser-reserve-v1');
  assert.equal(recovery.browserQuotaPolicyAppliedAt, clock.toISOString());
});

test('an editorial continuation routes a fixture-first missing prediction into the extended durable generator', async () => {
  const env = { ...fixtureEnv(), API_FOOTBALL_KEY: 'provider-key' };
  const store = createSiteMonitorStore({ blob: createBlob() });
  await store.updateState((state) => ({
    ...state,
    matchEditorialSync: {
      backfill: {
        match_report: { generation: MATCH_EDITORIAL_BACKFILL_GENERATION, sourceScanCompletedAt: '2026-09-17T00:00:00.000Z' },
        match_prediction: { generation: MATCH_EDITORIAL_BACKFILL_GENERATION, sourceScanCompletedAt: '2026-09-17T00:00:00.000Z' },
      },
    },
  }));
  const calls = [];
  let predictionScanConsumer = null;
  const res = response();
  await respondWithSiteMonitor({
    method: 'GET', query: { editorialContinuation: '1' }, headers: { authorization: 'Bearer cron-token' },
  }, res, {
    env,
    createStore: () => store,
    scanMissingPredictions: async ({ consumeProviderRequest }) => {
      predictionScanConsumer = consumeProviderRequest;
      assert.equal((await consumeProviderRequest()).ok, true);
      const queued = await store.enqueue({
        kind: 'prediction_generation', fixtureId: 1557409,
        sourceType: PREDICTION_GENERATION_SOURCE_TYPE, sourceVersion: 'scheduled-v1',
        repairGeneration: 'test-generation', trigger: 'scheduled_fixture_scan', priority: 94,
      });
      return {
        state: 'queued', scheduledFixtures: 1, publicPredictions: 0,
        missingPredictions: 1, queued: [queued.job.id],
      };
    },
    scanMissingReports: async ({ consumeProviderRequest }) => {
      assert.equal(consumeProviderRequest, predictionScanConsumer);
      assert.equal((await consumeProviderRequest()).ok, true);
      return { state: 'throttled', finishedFixtures: 0, missingReports: 0, queued: [] };
    },
    scanDuplicateCandidates: async () => ({ state: 'not_needed', candidates: 0, types: {} }),
    runMonitor: async (input) => {
      calls.push(input);
      return monitorResult(input.trigger);
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].trigger, 'prediction_generation');
  assert.deepEqual(calls[0].claimSourceTypes, [PREDICTION_GENERATION_SOURCE_TYPE]);
  assert.deepEqual(calls[0].claimJobKinds, ['article_validation', 'transient_browser_recovery', 'notification_delivery']);
  assert.equal(calls[0].claimDeliveryOnly, false);
  assert.equal(calls[0].collect, false);
  assert.equal(calls[0].settings.allowExtendedRun, true);
  assert.equal(calls[0].settings.maxRunMs, 285_000);
  assert.equal(calls[0].settings.browserEnabled, true);
  assert.ok(calls[0].settings.maxGenerationsPerDay >= 20);
  assert.ok(calls[0].settings.maxBrowserLaunchesPerDay >= 20);
  assert.equal(res.body.missingPredictionScan.missingPredictions, 1);
});

test('an editorial continuation delivers a collected Notion revision before an unrelated ready generator', async () => {
  const env = fixtureEnv();
  const store = createSiteMonitorStore({ blob: createBlob() });
  await store.updateState((state) => ({
    ...state,
    matchEditorialSync: {
      backfill: {
        match_report: { generation: MATCH_EDITORIAL_BACKFILL_GENERATION, sourceScanCompletedAt: '2026-09-17T00:00:00.000Z' },
        match_prediction: { generation: MATCH_EDITORIAL_BACKFILL_GENERATION, sourceScanCompletedAt: '2026-09-17T00:00:00.000Z' },
      },
    },
  }));
  await store.enqueue({
    kind: 'notion_page', pageId: 'latest-prediction', sourceType: 'match_prediction',
    sourceVersion: '2026-09-18T14:22:00.000Z', deliveryOnly: true, priority: 70,
  });
  await store.enqueue({
    kind: 'prediction_generation', fixtureId: 1557409,
    sourceType: PREDICTION_GENERATION_SOURCE_TYPE, sourceVersion: 'scheduled-v1',
    repairGeneration: 'test-generation', priority: 94,
  });
  const calls = [];
  const res = response();
  await respondWithSiteMonitor({
    method: 'GET', query: { editorialContinuation: '1' }, headers: { authorization: 'Bearer cron-token' },
  }, res, {
    env,
    createStore: () => store,
    scanMissingPredictions: async () => ({ state: 'throttled' }),
    scanMissingReports: async () => ({ state: 'throttled' }),
    scanDuplicateCandidates: async () => ({ state: 'not_needed', candidates: 0, types: {} }),
    runMonitor: async (input) => { calls.push(input); return monitorResult(input.trigger); },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].trigger, 'editorial_continuation');
  assert.deepEqual(calls[0].claimSourceTypes, ['match_report', 'match_prediction']);
  assert.equal(calls[0].claimDeliveryOnly, true);
  assert.equal(calls[0].collect, false);
});

test('an editorial continuation hydrates a legacy delivery projection before a ready generator can claim work', async () => {
  const env = fixtureEnv();
  const blob = createBlob();
  const store = createSiteMonitorStore({ blob });
  await store.updateState((state) => ({
    ...state,
    matchEditorialSync: {
      backfill: {
        match_report: { generation: MATCH_EDITORIAL_BACKFILL_GENERATION, sourceScanCompletedAt: '2026-09-17T00:00:00.000Z' },
        match_prediction: { generation: MATCH_EDITORIAL_BACKFILL_GENERATION, sourceScanCompletedAt: '2026-09-17T00:00:00.000Z' },
      },
    },
  }));
  const delivery = await store.enqueue({
    kind: 'notion_page', pageId: 'legacy-prediction', sourceType: 'match_prediction',
    sourceVersion: '2026-09-18T14:22:00.000Z', deliveryOnly: true, priority: 70,
  });
  const generator = await store.enqueue({
    kind: 'prediction_generation', fixtureId: 1557410,
    sourceType: PREDICTION_GENERATION_SOURCE_TYPE, sourceVersion: 'scheduled-v1',
    repairGeneration: 'test-generation', priority: 94,
  });
  const internal = await store.enqueue({
    kind: 'article_validation', articleId: 'legacy-validation', sourceType: 'match_prediction',
    sourceVersion: '2026-09-18T14:22:00.000Z', priority: 10,
  });
  const queuePath = siteMonitorPath('queue.json');
  const stored = blob.values.get(queuePath);
  const legacyQueue = JSON.parse(stored.text);
  const legacyItem = legacyQueue.items.find((item) => item.jobId === delivery.job.id);
  delete legacyItem.sourceType;
  delete legacyItem.kind;
  delete legacyItem.deliveryOnly;
  const legacyInternal = legacyQueue.items.find((item) => item.jobId === internal.job.id);
  delete legacyInternal.sourceType;
  delete legacyInternal.kind;
  delete legacyInternal.deliveryOnly;
  blob.values.set(queuePath, { ...stored, text: JSON.stringify(legacyQueue) });
  const calls = [];
  const res = response();
  await respondWithSiteMonitor({
    method: 'GET', query: { editorialContinuation: '1' }, headers: { authorization: 'Bearer cron-token' },
  }, res, {
    env,
    createStore: () => store,
    scanMissingPredictions: async () => ({ state: 'throttled' }),
    scanMissingReports: async () => ({ state: 'throttled' }),
    scanDuplicateCandidates: async () => ({ state: 'not_needed', candidates: 0, types: {} }),
    runMonitor: async (input) => {
      calls.push(input);
      const claimed = await store.claimJobs({
        owner: 'test-delivery-worker', limit: 1,
        sourceTypes: input.claimSourceTypes,
        kinds: input.claimJobKinds,
        deliveryOnly: input.claimDeliveryOnly,
      });
      assert.deepEqual(claimed.jobs.map((job) => job.id), [delivery.job.id]);
      return monitorResult(input.trigger);
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(calls[0].trigger, 'editorial_continuation');
  const queue = (await store.readQueue()).value.items;
  const hydrated = queue.find((item) => item.jobId === delivery.job.id);
  assert.equal(hydrated.sourceType, 'match_prediction');
  assert.equal(hydrated.kind, 'notion_page');
  assert.equal(hydrated.deliveryOnly, true);
  const hydratedInternal = queue.find((item) => item.jobId === internal.job.id);
  assert.equal(hydratedInternal.sourceType, 'match_prediction');
  assert.equal(hydratedInternal.kind, 'article_validation');
  const internalClaim = await store.claimJobs({
    owner: 'test-internal-worker', limit: 1, kinds: ['article_validation'], deliveryOnly: true,
  });
  assert.deepEqual(internalClaim.jobs.map((job) => job.id), [internal.job.id]);
  assert.equal((await store.readJob(generator.job.id)).value.status, 'queued');
});

test('an overlapping editorial continuation leaves fixture scans to the durable scan lease', async () => {
  const env = { ...fixtureEnv(), API_FOOTBALL_KEY: 'provider-key' };
  const store = createSiteMonitorStore({ blob: createBlob() });
  await store.updateState((state) => ({
    ...state,
    matchEditorialSync: {
      backfill: {
        match_report: { generation: MATCH_EDITORIAL_BACKFILL_GENERATION, sourceScanCompletedAt: '2026-09-17T00:00:00.000Z' },
        match_prediction: { generation: MATCH_EDITORIAL_BACKFILL_GENERATION, sourceScanCompletedAt: '2026-09-17T00:00:00.000Z' },
      },
    },
  }));
  const lock = await store.acquireLock({ name: 'fixture-editorial-scan', ttlMs: 60_000 });
  assert.ok(lock);
  let scans = 0;
  const res = response();
  await respondWithSiteMonitor({
    method: 'GET', query: { editorialContinuation: '1' }, headers: { authorization: 'Bearer cron-token' },
  }, res, {
    env,
    createStore: () => store,
    scanMissingPredictions: async () => { scans += 1; return {}; },
    scanMissingReports: async () => { scans += 1; return {}; },
    scanDuplicateCandidates: async () => ({ state: 'not_needed', candidates: 0, types: {} }),
    runMonitor: async (input) => monitorResult(input.trigger),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(scans, 0);
  assert.equal(res.body.missingPredictionScan.reason, 'fixture_scan_in_progress');
  assert.equal(res.body.missingReportScan.reason, 'fixture_scan_in_progress');
  await store.releaseLock(lock);
});

test('an editorial continuation seeds only a source-controlled association-ruleset retry before draining the durable queue', async () => {
  const env = fixtureEnv();
  const store = createSiteMonitorStore({ blob: createBlob() });
  await store.updateState((state) => ({
    ...state,
    matchEditorialSync: {
      backfill: {
        match_report: { generation: MATCH_EDITORIAL_BACKFILL_GENERATION, sourceScanCompletedAt: '2026-09-17T00:00:00.000Z' },
        match_prediction: { generation: MATCH_EDITORIAL_BACKFILL_GENERATION, sourceScanCompletedAt: '2026-09-17T00:00:00.000Z' },
      },
    },
  }));
  const calls = [];
  const res = response();
  await respondWithSiteMonitor({
    method: 'GET', query: { editorialContinuation: '1' }, headers: { authorization: 'Bearer cron-token' },
  }, res, {
    env,
    createStore: () => store,
    listPublicArticles: async () => ({ items: [], page: 1, totalPages: 1 }),
    queueUnlinkedEditorials: async (input) => {
      calls.push(input);
      return { state: 'queued', queued: 0, candidates: 0 };
    },
    runMonitor: async (input) => monitorResult(input.trigger),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].store, store);
  assert.equal(typeof calls[0].listArticles, 'function');
  assert.deepEqual(res.body.editorialRulesetReconciliation, { state: 'queued', queued: 0, candidates: 0 });
});

test('the editorial worker records duplicate fixture candidates separately from safe delivery', async () => {
  const env = fixtureEnv();
  const store = createSiteMonitorStore({ blob: createBlob() });
  await store.updateState((state) => ({
    ...state,
    matchEditorialSync: {
      backfill: {
        match_report: { generation: MATCH_EDITORIAL_BACKFILL_GENERATION, sourceScanCompletedAt: '2026-09-17T00:00:00.000Z' },
        match_prediction: { generation: MATCH_EDITORIAL_BACKFILL_GENERATION, sourceScanCompletedAt: '2026-09-17T00:00:00.000Z' },
      },
    },
  }));
  const scanCalls = [];
  const res = response();
  await respondWithSiteMonitor({
    method: 'GET', query: { editorialContinuation: '1' }, headers: { authorization: 'Bearer cron-token' },
  }, res, {
    env,
    createStore: () => store,
    listPublicArticles: async () => ({ items: [], page: 1, totalPages: 1 }),
    runMonitor: async (input) => monitorResult(input.trigger),
    scanDuplicateCandidates: async (input) => {
      scanCalls.push(input);
      return { state: 'recorded', candidates: 3, types: {} };
    },
    refreshDuplicateCandidates: async () => { throw new Error('baseline scan must take precedence'); },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(scanCalls.length, 1);
  assert.equal(scanCalls[0].store, store);
  assert.equal(typeof scanCalls[0].listArticles, 'function');
  assert.deepEqual(res.body.editorialDuplicateCandidates, { state: 'recorded', candidates: 3, types: {} });
});

test('an authenticated collection backfill uses the normal durable worker rather than a public reader route', async () => {
  const env = fixtureEnv();
  const store = createSiteMonitorStore({ blob: createBlob() });
  const calls = [];
  const res = response();
  await respondWithSiteMonitor({
    method: 'POST', query: { run: '1', backfill: '1' }, headers: { authorization: 'Bearer admin-token' },
  }, res, {
    env,
    createStore: () => store,
    runMonitor: async (input) => {
      calls.push(input);
      return monitorResult(input.trigger);
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].trigger, 'match_editorial_backfill');
  assert.equal(calls[0].collect, true);
  assert.deepEqual(calls[0].claimSourceTypes, ['match_report', 'match_prediction']);
  assert.equal(calls[0].claimDeliveryOnly, true);
  assert.ok(calls[0].settings.maxJobsPerRun >= 40);
  assert.ok(calls[0].settings.maxApiCallsPerRun >= 500);
  assert.ok(calls[0].settings.maxApiCallsPerDay >= 5_000);
  assert.ok(calls[0].settings.maxRepairsPerDay >= 1_500);
});

test('an already-scanned editorial backfill drains only durable editorial work', async () => {
  const env = fixtureEnv();
  const store = createSiteMonitorStore({ blob: createBlob() });
  await store.updateState((state) => ({
    ...state,
    matchEditorialSync: {
      backfill: {
        match_report: { generation: MATCH_EDITORIAL_BACKFILL_GENERATION, sourceScanCompletedAt: '2026-09-17T00:00:00.000Z' },
        match_prediction: { generation: MATCH_EDITORIAL_BACKFILL_GENERATION, sourceScanCompletedAt: '2026-09-17T00:00:00.000Z' },
      },
    },
  }));
  const calls = [];
  const res = response();
  await respondWithSiteMonitor({
    method: 'POST', query: { run: '1', backfill: '1' }, headers: { authorization: 'Bearer admin-token' },
  }, res, {
    env,
    createStore: () => store,
    runMonitor: async (input) => { calls.push(input); return monitorResult(input.trigger); },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].collect, false);
  assert.deepEqual(calls[0].claimSourceTypes, ['match_report', 'match_prediction']);
  assert.equal(calls[0].claimDeliveryOnly, true);
});

test('a deployment-scoped secondary admin key can run a backfill without replacing the standing key', async () => {
  const env = { ...fixtureEnv(), SITE_MONITOR_EPHEMERAL_ADMIN_SECRET: 'one-deployment-token' };
  const store = createSiteMonitorStore({ blob: createBlob() });
  const calls = [];
  const runMonitor = async (input) => { calls.push(input); return monitorResult(input.trigger); };

  const accepted = response();
  await respondWithSiteMonitor({
    method: 'POST', query: { run: '1', backfill: '1' },
    headers: { 'x-site-monitor-admin': 'Bearer one-deployment-token' },
  }, accepted, { env, createStore: () => store, runMonitor });
  assert.equal(accepted.statusCode, 200);
  assert.equal(calls[0].trigger, 'match_editorial_backfill');

  const rejected = response();
  await respondWithSiteMonitor({
    method: 'POST', query: { run: '1' },
    headers: { 'x-site-monitor-admin': 'Bearer wrong-deployment-token' },
  }, rejected, { env, createStore: () => store, runMonitor });
  assert.equal(rejected.statusCode, 401);
});

test('an authenticated exact Notion page resync queues only the current trusted source version', async () => {
  const env = fixtureEnv();
  const blob = createBlob();
  const store = createSiteMonitorStore({ blob });
  const calls = [];
  let targetCalls = 0;
  const runMonitor = async (input) => { calls.push(input); return monitorResult(input.trigger); };
  const getTarget = async ({ pageId, apiKey, consumeRequest }) => {
    targetCalls += 1;
    assert.equal(pageId, '3dab49a3-67ef-816c-b10b-cf39e560b1a7');
    assert.equal(apiKey, 'notion-read-key');
    assert.equal((await consumeRequest()).ok, true);
    return {
      outcome: 'eligible', pageId,
      sourceType: 'match_report', sourceVersion: '2026-09-14T01:00:00.000Z',
    };
  };

  const res = response();
  await respondWithSiteMonitor({
    method: 'POST',
    query: { run: '1', resyncPage: '3dab49a3-67ef-816c-b10b-cf39e560b1a7' },
    headers: { 'x-site-monitor-admin': 'Bearer admin-token' },
  }, res, { env, createStore: () => store, runMonitor, getTarget });

  assert.equal(res.statusCode, 200);
  assert.equal(targetCalls, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].trigger, 'manual_page_resync');
  assert.equal(calls[0].collect, false);
  assert.equal(calls[0].settings.maxJobsPerRun, 1);
  const queued = (await store.readQueue()).value.items;
  assert.equal(queued.length, 1);
  const job = (await store.readJob(queued[0].jobId)).value;
  assert.equal(job.kind, 'notion_page');
  assert.equal(job.pageId, '3dab49a3-67ef-816c-b10b-cf39e560b1a7');
  assert.equal(job.sourceType, 'match_report');
  assert.equal(job.sourceVersion, '2026-09-14T01:00:00.000Z');
  assert.equal(job.trigger, 'manual_page_resync');
  assert.equal(job.verificationOnly, false);
  assert.equal(job.repairGeneration, null);
  assert.deepEqual(calls[0].onlyJobIds, [job.id]);

  // A manual URL must not silently bypass the two-attempt/source-version
  // ceiling by reactivating a terminal durable record.
  await store.updateJob(job.id, (current) => ({ ...current, status: 'completed' }));
  const terminal = response();
  await respondWithSiteMonitor({
    method: 'POST',
    query: { run: '1', resyncPage: '3dab49a3-67ef-816c-b10b-cf39e560b1a7' },
    headers: { authorization: 'Bearer admin-token' },
  }, terminal, { env, createStore: () => store, runMonitor, getTarget });
  assert.equal(terminal.statusCode, 409);
  assert.equal(terminal.body.worker.state, 'already_processed');
  assert.equal(calls.length, 1);
  assert.equal(targetCalls, 2);

  const invalid = response();
  await respondWithSiteMonitor({
    method: 'POST', query: { run: '1', resyncPage: '../notion-page' },
    headers: { authorization: 'Bearer admin-token' },
  }, invalid, { env, createStore: () => store, runMonitor, getTarget });
  assert.equal(invalid.statusCode, 400);
  assert.equal(targetCalls, 2);
  assert.equal(calls.length, 1);

  const combined = response();
  await respondWithSiteMonitor({
    method: 'POST',
    query: { run: '1', resyncPage: '3dab49a3-67ef-816c-b10b-cf39e560b1a7', recheckDeployment: '1' },
    headers: { authorization: 'Bearer admin-token' },
  }, combined, { env, createStore: () => store, runMonitor, getTarget });
  assert.equal(combined.statusCode, 400);
  assert.equal(targetCalls, 2);
});

test('a corrected delivery generation can reopen only a terminal browser/delivery failure once', async () => {
  const env = fixtureEnv();
  const target = {
    outcome: 'eligible', pageId: '3dab49a3-67ef-8134-ac0d-d4c38fb78748',
    sourceType: 'match_prediction', sourceVersion: '2026-09-13T02:24:00.000Z',
  };
  const makeStore = () => createSiteMonitorStore({ blob: createBlob() });

  for (const status of ['running', 'completed']) {
    const store = makeStore();
    const ordinary = await store.enqueue({
      kind: 'notion_page', pageId: target.pageId, sourceType: target.sourceType, sourceVersion: target.sourceVersion,
    });
    if (status !== 'queued') await store.updateJob(ordinary.job.id, (job) => ({ ...job, status }));
    let runCalls = 0;
    const res = response();
    await respondWithSiteMonitor({
      method: 'POST', query: { run: '1', resyncPage: target.pageId }, headers: { authorization: 'Bearer admin-token' },
    }, res, {
      env, createStore: () => store,
      getTarget: async () => target,
      runMonitor: async () => { runCalls += 1; return monitorResult('manual_page_resync'); },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(runCalls, 0);
  }

  const queuedStore = makeStore();
  const queuedOrdinary = await queuedStore.enqueue({
    kind: 'notion_page', pageId: target.pageId, sourceType: target.sourceType, sourceVersion: target.sourceVersion,
  });
  const queuedCalls = [];
  const queuedResponse = response();
  await respondWithSiteMonitor({
    method: 'POST', query: { run: '1', resyncPage: target.pageId }, headers: { authorization: 'Bearer admin-token' },
  }, queuedResponse, {
    env, createStore: () => queuedStore,
    getTarget: async () => target,
    runMonitor: async (input) => { queuedCalls.push(input); return monitorResult(input.trigger); },
  });
  assert.equal(queuedResponse.statusCode, 200);
  assert.deepEqual(queuedCalls[0].onlyJobIds, [queuedOrdinary.job.id]);
  assert.equal((await queuedStore.readJob(queuedOrdinary.job.id)).value.repairGeneration, null);
  assert.equal((await queuedStore.readQueue()).value.items.filter((item) => item.jobId === queuedOrdinary.job.id).length, 1);

  const store = makeStore();
  const ordinary = await store.enqueue({
    kind: 'notion_page', pageId: target.pageId, sourceType: target.sourceType, sourceVersion: target.sourceVersion,
  });
  await store.updateJob(ordinary.job.id, (job) => ({
    ...job, status: 'blocked', lastError: 'browser_failed', repairAttempts: 2,
  }));
  const calls = [];
  const res = response();
  await respondWithSiteMonitor({
    method: 'POST', query: { run: '1', resyncPage: target.pageId }, headers: { authorization: 'Bearer admin-token' },
  }, res, {
    env, createStore: () => store,
    getTarget: async () => target,
    runMonitor: async (input) => { calls.push(input); return monitorResult(input.trigger); },
  });
  assert.equal(res.statusCode, 200);
  const generated = (await Promise.all((await store.readQueue()).value.items.map(async ({ jobId }) => (await store.readJob(jobId)).value)))
    .find((job) => job?.repairGeneration === 'structured-media-2026-09-15-v1');
  assert.ok(generated);
  assert.deepEqual(calls[0].onlyJobIds, [generated.id]);

  await store.updateJob(generated.id, (job) => ({ ...job, status: 'blocked', repairAttempts: 2 }));
  const duplicate = response();
  await respondWithSiteMonitor({
    method: 'POST', query: { run: '1', resyncPage: target.pageId }, headers: { authorization: 'Bearer admin-token' },
  }, duplicate, {
    env, createStore: () => store,
    getTarget: async () => target,
    runMonitor: async (input) => { calls.push(input); return monitorResult(input.trigger); },
  });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(calls.length, 1);
});

test('protected monitor status exposes compact persisted diagnostics without article bodies', async () => {
  const env = fixtureEnv();
  const blob = createBlob();
  const store = createSiteMonitorStore({ blob });
  await store.enqueue({
    kind: 'notion_page', pageId: 'report-page', sourceType: 'match_report', sourceVersion: 'v1',
    deliveryOnly: true, priority: 70,
  });
  await store.enqueue({
    kind: 'notion_page', pageId: 'prediction-page', sourceType: 'match_prediction', sourceVersion: 'v1',
    deliveryOnly: false, priority: 45,
  });
  await store.enqueue({ kind: 'deployment_validation', deploymentId: 'dpl-legacy', priority: 90 });
  const run = await store.beginRun({ trigger: 'manual', deploymentId: 'dpl-test' });
  await store.finishRun(run.id, {
    status: 'attention',
    jobs: [{
      jobId: 'job-1', status: 'blocked', result: {
        state: 'browser_failed',
        article: {
          id: 'notion-match_report-page-1',
          notion: { pageId: 'page-1', updatedAt: '2026-09-14T00:00:00.000Z' },
          body: 'must not be returned',
        },
        fixture: { id: 12345 },
        browser: {
          status: 'failed', failureKind: 'browser_assertion', error: 'portrait mismatch',
          checks: {
            article: { url: 'https://am4football.com/article.html?id=notion-match_report-page-1', tailChecked: true },
            match: {
              url: 'https://am4football.com/match.html?id=12345',
              cards: [{ playerId: 276, imageUrl: 'https://media.api-sports.io/football/players/276.png', naturalWidth: 180 }],
            },
            badge: { state: 'passed', kind: 'report', href: '/match.html?id=12345' },
          },
        },
      },
    }],
  });
  const res = response();
  await respondWithSiteMonitor({
    method: 'GET', query: { status: '1', runId: run.id },
    headers: { authorization: 'Bearer admin-token' },
  }, res, { env, createStore: () => store });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.run.runId, run.id);
  assert.equal(res.body.run.jobs[0].browser.error, 'portrait mismatch');
  assert.equal(res.body.run.jobs[0].articleId, 'notion-match_report-page-1');
  assert.equal(res.body.run.jobs[0].notionPageId, 'page-1');
  assert.equal(res.body.run.jobs[0].sourceVersion, '2026-09-14T00:00:00.000Z');
  assert.equal(res.body.run.jobs[0].fixtureId, 12345);
  assert.deepEqual(res.body.run.jobs[0].browser.checks, {
    article: { url: 'https://am4football.com/article.html', tailChecked: true },
    match: {
      url: 'https://am4football.com/match.html',
      cards: [{ playerId: 276, imageUrl: 'https://media.api-sports.io/football/players/276.png', naturalWidth: 180 }],
    },
    badge: { state: 'passed', kind: 'report', href: '/match.html' },
  });
  assert.equal('article' in res.body.run.jobs[0], false);
  assert.deepEqual(res.body.editorialQueue, {
    bySource: {
      match_report: { queued: 1, deliveryOnly: 1, priorities: { 70: 1 } },
      match_prediction: { queued: 1, deliveryOnly: 0, priorities: { 45: 1 } },
      match_report_generation: { queued: 0, deliveryOnly: 0, priorities: {} },
      match_prediction_generation: { queued: 0, deliveryOnly: 0, priorities: {} },
    },
    itemsWithoutSourceMetadata: 1,
  });
});

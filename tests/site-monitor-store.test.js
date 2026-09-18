import assert from 'node:assert/strict';
import test from 'node:test';

import { createSiteMonitorStore, siteMonitorPath } from '../lib/site-monitor-store.js';

function createBlob() {
  const values = new Map();
  let revision = 0;
  const conflict = (message) => Object.assign(new Error(message), { status: 412 });
  return {
    async get(path) {
      const current = values.get(path);
      return current ? { stream: new Blob([current.text]).stream(), etag: current.etag } : null;
    },
    async put(path, text, options = {}) {
      const current = values.get(path);
      if (options.allowOverwrite === false && current) throw conflict('already exists');
      if (options.ifMatch && (!current || current.etag !== options.ifMatch)) throw conflict('etag mismatch');
      const etag = `etag-${++revision}`;
      values.set(path, { text, etag });
      return { etag };
    },
    async del(path, options = {}) {
      const current = values.get(path);
      if (options.ifMatch && (!current || current.etag !== options.ifMatch)) throw conflict('etag mismatch');
      values.delete(path);
    },
    values,
  };
}

test('site monitor queue persists deduplicated version jobs and recovers expired leases', async () => {
  const blob = createBlob();
  let clock = new Date('2026-09-14T00:00:00.000Z');
  const now = () => clock;
  const store = createSiteMonitorStore({ blob, now, uuid: () => 'owner-a' });

  const first = await store.enqueue({
    kind: 'notion_page', pageId: 'page-1', sourceType: 'match_prediction',
    sourceVersion: '2026-09-14T00:00:00.000Z', priority: 10,
  });
  const duplicate = await store.enqueue({
    kind: 'notion_page', pageId: 'page-1', sourceType: 'match_prediction',
    sourceVersion: '2026-09-14T00:00:00.000Z', priority: 10,
  });
  assert.equal(first.enqueued, true);
  assert.equal(duplicate.enqueued, false);

  const one = await store.claimJobs({ owner: 'runner-one', limit: 1, leaseMs: 1_000 });
  assert.equal(one.jobs.length, 1);
  assert.equal(one.jobs[0].status, 'running');

  clock = new Date('2026-09-14T00:00:02.000Z');
  const recovered = await store.claimJobs({ owner: 'runner-two', limit: 1, leaseMs: 1_000 });
  assert.equal(recovered.jobs.length, 1);
  assert.equal(recovered.jobs[0].id, one.jobs[0].id);
  assert.equal(recovered.jobs[0].leaseOwner, 'runner-two');

  await store.finishJob(recovered.jobs[0].id, { owner: 'runner-two', status: 'completed', result: { verified: true } });
  const queue = await store.readQueue();
  assert.equal(queue.value.items.length, 0);
  const complete = await store.readJob(one.jobs[0].id);
  assert.equal(complete.value.status, 'completed');
  assert.deepEqual(complete.value.result, { verified: true });
});

test('a queued source job can be promoted without changing its durable identity', async () => {
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => new Date('2026-09-14T00:00:00.000Z') });
  const first = await store.enqueue({
    kind: 'prediction_generation', fixtureId: 1557409, sourceType: 'match_prediction_generation',
    sourceVersion: 'fixture-v1', priority: 94,
  });
  const promoted = await store.enqueue({
    kind: 'prediction_generation', fixtureId: 1557409, sourceType: 'match_prediction_generation',
    sourceVersion: 'fixture-v1', priority: 98, promotePriority: true,
  });
  assert.equal(promoted.enqueued, false);
  assert.equal(promoted.priorityPromoted, true);
  assert.equal(promoted.job.id, first.job.id);
  assert.equal((await store.readJob(first.job.id)).value.priority, 98);
  assert.equal((await store.readQueue()).value.items[0].priority, 98);
});

test('deliberate deployment rechecks have an isolated durable identity', async () => {
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => new Date('2026-09-14T00:00:00.000Z') });
  const first = await store.enqueue({
    kind: 'deployment_validation', deploymentId: 'dpl-1', validationId: 'recheck-a', verificationOnly: true,
  });
  const duplicate = await store.enqueue({
    kind: 'deployment_validation', deploymentId: 'dpl-1', validationId: 'recheck-a', verificationOnly: true,
  });
  const second = await store.enqueue({
    kind: 'deployment_validation', deploymentId: 'dpl-1', validationId: 'recheck-b', verificationOnly: true,
  });
  assert.equal(first.enqueued, true);
  assert.equal(duplicate.enqueued, false);
  assert.equal(second.enqueued, true);
});

test('a source-owned repair generation permits one new bounded job after a repair-code correction', async () => {
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => new Date('2026-09-14T00:00:00.000Z') });
  const legacy = await store.enqueue({
    kind: 'notion_page', pageId: 'page-1', sourceType: 'match_prediction', sourceVersion: 'v1',
  });
  await store.updateJob(legacy.job.id, (job) => ({ ...job, status: 'blocked' }));

  const repaired = await store.enqueue({
    kind: 'notion_page', pageId: 'page-1', sourceType: 'match_prediction', sourceVersion: 'v1',
    repairGeneration: 'structured-media-v1',
  });
  const duplicate = await store.enqueue({
    kind: 'notion_page', pageId: 'page-1', sourceType: 'match_prediction', sourceVersion: 'v1',
    repairGeneration: 'structured-media-v1',
  });

  assert.equal(repaired.enqueued, true);
  assert.notEqual(repaired.job.id, legacy.job.id);
  assert.equal((await store.readJob(repaired.job.id)).value.repairGeneration, 'structured-media-v1');
  assert.equal(duplicate.enqueued, false);
});

test('a reviewed quota-policy release wakes only deferred usage-limited jobs without creating another identity', async () => {
  let clock = new Date('2026-09-14T00:00:00.000Z');
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => clock });
  const held = await store.enqueue({
    kind: 'report_generation', fixtureId: 123, sourceType: 'match_report_generation', sourceVersion: 'v1',
    priority: 95,
  });
  const unrelated = await store.enqueue({
    kind: 'notion_page', pageId: 'page-1', sourceType: 'match_report', sourceVersion: 'v1',
  });
  const heldClaim = await store.claimJobs({ owner: 'held-owner', jobIds: [held.job.id] });
  await store.deferJob(heldClaim.jobs[0].id, { owner: 'held-owner', reason: 'usage_limit', delayMs: 12 * 60 * 60 * 1000 });
  const unrelatedClaim = await store.claimJobs({ owner: 'unrelated-owner', jobIds: [unrelated.job.id] });
  await store.deferJob(unrelatedClaim.jobs[0].id, { owner: 'unrelated-owner', reason: 'usage_limit', delayMs: 12 * 60 * 60 * 1000 });

  const released = await store.requeueDeferredUsageLimitedJobs({ sourceTypes: ['match_report_generation'] });
  assert.deepEqual(released, { requeued: 1, jobIds: [held.job.id] });
  const queue = (await store.readQueue()).value.items;
  assert.equal(queue.find((item) => item.jobId === held.job.id).availableAt, clock.toISOString());
  assert.notEqual(queue.find((item) => item.jobId === unrelated.job.id).availableAt, clock.toISOString());
  assert.equal((await store.readJob(held.job.id)).value.lastError, 'usage_limit_released');
  assert.equal((await store.readJob(unrelated.job.id)).value.lastError, 'usage_limit');
});

test('only historical browser-quota terminal jobs are revived for the next bounded browser window', async () => {
  const clock = new Date('2026-09-14T00:00:00.000Z');
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => clock, uuid: () => 'browser-quota-owner' });
  const held = await store.enqueue({
    kind: 'article_validation', articleId: 'notion-match_report-held', sourceType: 'match_report',
    sourceVersion: 'v1', priority: 80,
  });
  const unrelated = await store.enqueue({
    kind: 'article_validation', articleId: 'notion-story-runtime', sourceType: 'am4_story',
    sourceVersion: 'v1', priority: 80,
  });
  const heldClaim = await store.claimJobs({ owner: 'held-owner', jobIds: [held.job.id] });
  await store.finishJob(heldClaim.jobs[0].id, {
    owner: 'held-owner', status: 'blocked', error: 'browser_quota_exceeded',
    result: { state: 'browser_unavailable', browser: { reason: 'browser_quota_exceeded' } },
    repairAttempts: 1,
  });
  const unrelatedClaim = await store.claimJobs({ owner: 'runtime-owner', jobIds: [unrelated.job.id] });
  await store.finishJob(unrelatedClaim.jobs[0].id, {
    owner: 'runtime-owner', status: 'blocked', error: 'browser_runtime_unavailable',
    result: { state: 'browser_unavailable', browser: { reason: 'browser_runtime_unavailable' } },
    repairAttempts: 1,
  });

  const availableAt = '2026-09-14T15:00:05.000Z';
  const released = await store.requeueBlockedBrowserQuotaJobs({ availableAt });
  assert.deepEqual(released, { requeued: 1, jobIds: [held.job.id] });
  const resumed = (await store.readJob(held.job.id)).value;
  assert.equal(resumed.status, 'queued');
  assert.equal(resumed.lastError, 'browser_quota_exceeded_requeued');
  assert.equal(resumed.repairAttempts, 1);
  assert.equal((await store.readJob(unrelated.job.id)).value.status, 'blocked');
  const queued = (await store.readQueue()).value.items;
  assert.equal(queued.length, 1);
  assert.equal(queued[0].jobId, held.job.id);
  assert.equal(queued[0].availableAt, availableAt);
});

test('an interrupted historical browser-quota recovery keeps its exact terminal marker until the queue projection is durable', async () => {
  const clock = new Date('2026-09-14T00:00:00.000Z');
  const base = createBlob();
  let failNextJobWrite = false;
  const blob = {
    ...base,
    async put(path, text, options) {
      if (failNextJobWrite && String(path).includes('/jobs/')) {
        failNextJobWrite = false;
        throw new Error('simulated job write interruption');
      }
      return base.put(path, text, options);
    },
  };
  const store = createSiteMonitorStore({ blob, now: () => clock, uuid: () => 'browser-quota-interrupt-owner' });
  const held = await store.enqueue({
    kind: 'article_validation', articleId: 'notion-match_report-interrupted', sourceType: 'match_report',
    sourceVersion: 'v1', priority: 80,
  });
  const claim = await store.claimJobs({ owner: 'held-owner', jobIds: [held.job.id] });
  await store.finishJob(claim.jobs[0].id, {
    owner: 'held-owner', status: 'blocked', error: 'browser_quota_exceeded',
    result: { state: 'browser_unavailable', browser: { reason: 'browser_quota_exceeded' } },
  });

  failNextJobWrite = true;
  await assert.rejects(
    store.requeueBlockedBrowserQuotaJobs({ availableAt: '2026-09-14T15:00:05.000Z' }),
    /simulated job write interruption/,
  );
  // The projection was written first, but the authoritative record remains
  // safely discoverable by the next worker instead of becoming an orphaned
  // queued job with no queue item.
  assert.equal((await store.readJob(held.job.id)).value.status, 'blocked');
  assert.equal((await store.readJob(held.job.id)).value.lastError, 'browser_quota_exceeded');
  assert.equal((await store.readQueue()).value.items[0].jobId, held.job.id);

  const resumed = await store.requeueBlockedBrowserQuotaJobs({ availableAt: '2026-09-14T15:00:05.000Z' });
  assert.deepEqual(resumed, { requeued: 1, jobIds: [held.job.id] });
  assert.equal((await store.readJob(held.job.id)).value.status, 'queued');
});

test('article-validation jobs persist and distinguish their exact article target', async () => {
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => new Date('2026-09-14T00:00:00.000Z') });
  const first = await store.enqueue({
    kind: 'article_validation', articleId: 'notion-match_report-a', sourceType: 'match_report',
    sourceVersion: 'v1', deploymentId: 'dpl-1',
  });
  const second = await store.enqueue({
    kind: 'article_validation', articleId: 'notion-match_report-b', sourceType: 'match_report',
    sourceVersion: 'v1', deploymentId: 'dpl-1',
  });
  assert.equal(first.enqueued, true);
  assert.equal(second.enqueued, true);
  assert.equal((await store.readJob(first.job.id)).value.articleId, 'notion-match_report-a');
  assert.equal((await store.readJob(second.job.id)).value.articleId, 'notion-match_report-b');
});

test('a bounded manual recheck can claim only its exact durable job', async () => {
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => new Date('2026-09-14T00:00:00.000Z'), uuid: () => 'owner' });
  const older = await store.enqueue({ kind: 'article_validation', articleId: 'older', sourceVersion: 'v1', priority: 90 });
  const requested = await store.enqueue({ kind: 'article_validation', articleId: 'requested', sourceVersion: 'v1', priority: 90 });
  const claimed = await store.claimJobs({ owner: 'owner', limit: 1, jobIds: [requested.job.id] });
  assert.deepEqual(claimed.jobs.map((job) => job.id), [requested.job.id]);
  assert.equal((await store.readJob(older.job.id)).value.status, 'queued');
});

test('a source-filtered recovery claims only its intended editorial lanes', async () => {
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => new Date('2026-09-14T00:00:00.000Z'), uuid: () => 'owner' });
  const prediction = await store.enqueue({ kind: 'notion_page', pageId: 'prediction', sourceType: 'match_prediction', sourceVersion: 'v1', priority: 70 });
  const report = await store.enqueue({ kind: 'notion_page', pageId: 'report', sourceType: 'match_report', sourceVersion: 'v1', priority: 70 });
  const unrelated = await store.enqueue({ kind: 'notion_page', pageId: 'story', sourceType: 'am4_story', sourceVersion: 'v1', priority: 100 });

  const claimed = await store.claimJobs({
    owner: 'owner', limit: 3,
    sourceTypes: ['match_prediction', 'match_report'],
  });
  assert.deepEqual(new Set(claimed.jobs.map((job) => job.id)), new Set([prediction.job.id, report.job.id]));
  assert.equal((await store.readJob(unrelated.job.id)).value.status, 'queued');
});

test('an editorial continuation can also claim its allow-listed deployment and visual jobs', async () => {
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => new Date('2026-09-14T00:00:00.000Z'), uuid: () => 'owner' });
  const report = await store.enqueue({
    kind: 'notion_page', pageId: 'report', sourceType: 'match_report', sourceVersion: 'v1', deliveryOnly: true, priority: 70,
  });
  const deployment = await store.enqueue({ kind: 'deployment_validation', deploymentId: 'dpl-1', priority: 90 });
  const storyVisual = await store.enqueue({
    kind: 'article_validation', articleId: 'notion-am4_story-1', sourceType: 'am4_story', sourceVersion: 'v1', priority: 80,
  });
  const unrelatedStory = await store.enqueue({
    kind: 'notion_page', pageId: 'story', sourceType: 'am4_story', sourceVersion: 'v1', deliveryOnly: true, priority: 100,
  });

  const claimed = await store.claimJobs({
    owner: 'owner', limit: 4,
    sourceTypes: ['match_prediction', 'match_report'],
    kinds: ['deployment_validation', 'article_validation'],
    deliveryOnly: true,
  });
  assert.deepEqual(new Set(claimed.jobs.map((job) => job.id)), new Set([
    report.job.id, deployment.job.id, storyVisual.job.id,
  ]));
  assert.equal((await store.readJob(unrelatedStory.job.id)).value.status, 'queued');
});

test('the ordinary monitor can leave report generation for its dedicated extended lane', async () => {
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => new Date('2026-09-14T00:00:00.000Z'), uuid: () => 'owner' });
  const reportGeneration = await store.enqueue({
    kind: 'report_generation', fixtureId: 123, sourceType: 'match_report_generation', sourceVersion: 'v1', priority: 95,
  });
  const ordinary = await store.enqueue({
    kind: 'notion_page', pageId: 'story', sourceType: 'am4_story', sourceVersion: 'v1', priority: 10,
  });
  const claimed = await store.claimJobs({ owner: 'owner', limit: 2, excludeSourceTypes: ['match_report_generation'] });
  assert.deepEqual(claimed.jobs.map((job) => job.id), [ordinary.job.id]);
  assert.equal((await store.readJob(reportGeneration.job.id)).value.status, 'queued');
});

test('a normal-priority editorial recovery interleaves the opposite source lane without bypassing urgent work', async () => {
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => new Date('2026-09-14T00:10:00.000Z'), uuid: () => 'owner' });
  const report = await store.enqueue({
    kind: 'notion_page', pageId: 'report-first', sourceType: 'match_report', sourceVersion: 'v1',
    priority: 70, createdAt: '2026-09-14T00:00:00.000Z',
  });
  const prediction = await store.enqueue({
    kind: 'notion_page', pageId: 'prediction-second', sourceType: 'match_prediction', sourceVersion: 'v1',
    priority: 45, createdAt: '2026-09-14T00:01:00.000Z',
  });
  const urgentReport = await store.enqueue({
    kind: 'notion_page', pageId: 'urgent-report', sourceType: 'match_report', sourceVersion: 'v1',
    priority: 80, createdAt: '2026-09-14T00:02:00.000Z',
  });

  const urgent = await store.claimJobs({
    owner: 'owner', limit: 1,
    sourceTypes: ['match_report', 'match_prediction'],
    preferredSourceTypes: ['match_prediction'],
  });
  assert.deepEqual(urgent.jobs.map((job) => job.id), [urgentReport.job.id]);
  await store.finishJob(urgentReport.job.id, { owner: 'owner', status: 'completed' });

  const preferred = await store.claimJobs({
    owner: 'owner', limit: 1,
    sourceTypes: ['match_report', 'match_prediction'],
    preferredSourceTypes: ['match_prediction'],
  });
  assert.deepEqual(preferred.jobs.map((job) => job.id), [prediction.job.id]);
  assert.equal((await store.readJob(report.job.id)).value.status, 'queued');
});

test('an aged normal-priority report cannot masquerade as urgent work and starve predictions', async () => {
  const store = createSiteMonitorStore({ blob: createBlob(), now: () => new Date('2026-09-17T00:10:00.000Z'), uuid: () => 'owner' });
  const agedReport = await store.enqueue({
    kind: 'notion_page', pageId: 'aged-report', sourceType: 'match_report', sourceVersion: 'v1',
    priority: 70, createdAt: '2026-09-14T00:00:00.000Z',
  });
  const prediction = await store.enqueue({
    kind: 'notion_page', pageId: 'current-prediction', sourceType: 'match_prediction', sourceVersion: 'v1',
    priority: 70, createdAt: '2026-09-17T00:00:00.000Z',
  });

  const claimed = await store.claimJobs({
    owner: 'owner', limit: 1,
    sourceTypes: ['match_report', 'match_prediction'],
    preferredSourceTypes: ['match_prediction'],
  });
  assert.deepEqual(claimed.jobs.map((job) => job.id), [prediction.job.id]);
  assert.equal((await store.readJob(agedReport.job.id)).value.status, 'queued');
});

test('legacy delivery-only editorial queue metadata is migrated from the authoritative job', async () => {
  const blob = createBlob();
  const store = createSiteMonitorStore({ blob, now: () => new Date('2026-09-14T00:00:00.000Z'), uuid: () => 'owner' });
  const queued = await store.enqueue({
    kind: 'notion_page', pageId: 'legacy-report', sourceType: 'match_report',
    sourceVersion: 'v1', deliveryOnly: true, priority: 70,
  });
  const queuePath = siteMonitorPath('queue.json');
  const legacy = blob.values.get(queuePath);
  const queue = JSON.parse(legacy.text);
  delete queue.items[0].sourceType;
  delete queue.items[0].deliveryOnly;
  blob.values.set(queuePath, { ...legacy, text: JSON.stringify(queue) });

  const migrated = await store.migrateQueuedMetadata({
    sourceTypes: ['match_report', 'match_prediction'], deliveryOnly: true,
  });
  assert.equal(migrated.migrated, 1);
  const recovered = await store.claimJobs({
    owner: 'owner', limit: 1,
    sourceTypes: ['match_report', 'match_prediction'], deliveryOnly: true,
  });
  assert.deepEqual(recovered.jobs.map((job) => job.id), [queued.job.id]);
});

test('an expired worker cannot finish a job reclaimed by another durable lease owner', async () => {
  const blob = createBlob();
  let clock = new Date('2026-09-14T00:00:00.000Z');
  const store = createSiteMonitorStore({ blob, now: () => clock, uuid: () => 'unused' });
  await store.enqueue({ kind: 'notion_page', pageId: 'page-lease', sourceType: 'match_report', sourceVersion: 'v1' });
  const first = await store.claimJobs({ owner: 'first', leaseMs: 1_000 });
  assert.equal(first.jobs.length, 1);
  clock = new Date('2026-09-14T00:00:02.000Z');
  const second = await store.claimJobs({ owner: 'second', leaseMs: 10_000 });
  assert.equal(second.jobs.length, 1);
  assert.equal(await store.finishJob(first.jobs[0].id, { owner: 'first', status: 'completed' }), null);
  const running = await store.readJob(first.jobs[0].id);
  assert.equal(running.value.leaseOwner, 'second');
  assert.equal(await store.finishJob(second.jobs[0].id, { owner: 'second', status: 'completed' }).then((job) => job.status), 'completed');
  assert.equal((await store.readQueue()).value.items.length, 0);
});

test('a lease that expires while a snapshot Blob is written cannot attach that snapshot', async () => {
  const blob = createBlob();
  let clock = new Date('2026-09-14T00:00:00.000Z');
  const originalPut = blob.put.bind(blob);
  blob.put = async (path, ...args) => {
    const result = await originalPut(path, ...args);
    if (String(path).includes('/backups/')) clock = new Date('2026-09-14T00:00:02.000Z');
    return result;
  };
  const store = createSiteMonitorStore({ blob, now: () => clock, uuid: () => 'unused' });
  const queued = await store.enqueue({ kind: 'notion_page', pageId: 'page-snapshot', sourceType: 'match_report', sourceVersion: 'v1' });
  const claimed = await store.claimJobs({ owner: 'worker', leaseMs: 1_000 });

  const snapshot = await store.writeSnapshot({
    jobId: claimed.jobs[0].id,
    owner: 'worker',
    articleId: 'notion-match_report-page-snapshot',
    sourceVersion: 'v1',
    afterDigest: 'after',
    before: { id: 'notion-match_report-page-snapshot', body: 'before' },
  });

  assert.equal(snapshot, null);
  assert.deepEqual((await store.readJob(queued.job.id)).value.snapshotIds, []);
});

test('site monitor uses a Blob compare-and-set lock and daily configurable quota', async () => {
  const blob = createBlob();
  let clock = new Date('2026-09-14T01:00:00.000Z');
  const now = () => clock;
  const first = createSiteMonitorStore({ blob, now, uuid: () => 'first' });
  const second = createSiteMonitorStore({ blob, now, uuid: () => 'second' });

  const lock = await first.acquireLock({ name: 'runner', ttlMs: 1_000 });
  assert.equal(lock.owner, 'first');
  assert.equal(await second.acquireLock({ name: 'runner', ttlMs: 1_000 }), null);
  clock = new Date('2026-09-14T01:00:02.000Z');
  const replacement = await second.acquireLock({ name: 'runner', ttlMs: 1_000 });
  assert.equal(replacement.owner, 'second');
  assert.equal(await first.releaseLock(lock), false);

  const allowed = await second.consumeUsage(
    { apiCalls: 3, browserLaunches: 1, repairOperations: 2 },
    { apiCalls: 4, browserLaunches: 1, repairOperations: 2 },
  );
  assert.equal(allowed.ok, true);
  const denied = await second.consumeUsage(
    { apiCalls: 2 },
    { apiCalls: 4, browserLaunches: 1, repairOperations: 2 },
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.exceeded, 'apiCalls');
  assert.equal(denied.usage.apiCalls, 3);
  assert.equal(denied.usage.browserLaunches, 1);
  assert.equal(denied.usage.repairOperations, 2);

  clock = new Date('2026-09-15T01:00:00.000Z');
  const reset = await second.consumeUsage({ apiCalls: 1 }, { apiCalls: 4 });
  assert.equal(reset.ok, true);
  assert.equal(reset.usage.apiCalls, 1);
  assert.equal(reset.usage.repairOperations, 0);
});

test('one exhausted recovery budget does not block an unrelated browser reservation', async () => {
  const store = createSiteMonitorStore({
    blob: createBlob(),
    now: () => new Date('2026-09-18T00:00:00.000Z'),
  });
  const recovery = await store.consumeUsage(
    { repairOperations: 5 },
    { repairOperations: 200 },
  );
  assert.equal(recovery.ok, true);

  const browser = await store.consumeUsage(
    { browserLaunches: 1 },
    { repairOperations: 2, browserLaunches: 1 },
  );
  assert.equal(browser.ok, true);
  assert.equal(browser.usage.browserLaunches, 1);
  assert.equal(browser.usage.repairOperations, 5);
});

test('a lock renewal retries a stale ETag only when the durable owner is unchanged', async () => {
  const blob = createBlob();
  let clock = new Date('2026-09-14T01:00:00.000Z');
  const first = createSiteMonitorStore({ blob, now: () => clock, uuid: () => 'first' });
  const second = createSiteMonitorStore({ blob, now: () => clock, uuid: () => 'second' });

  const lock = await first.acquireLock({ name: 'runner', ttlMs: 60_000 });
  const persisted = blob.values.get(lock.path);
  // Simulate an idempotent retry / adjacent renewal by the same owner. The
  // caller's ETag is now stale, but the durable lock has not changed hands.
  await blob.put(lock.path, persisted.text, { access: 'private' });
  const renewed = await first.renewLock(lock, 60_000);
  assert.equal(renewed.owner, 'first');
  assert.notEqual(renewed.etag, lock.etag);

  clock = new Date('2026-09-14T01:02:01.000Z');
  const replacement = await second.acquireLock({ name: 'runner', ttlMs: 60_000 });
  assert.equal(replacement.owner, 'second');
  assert.equal(await first.renewLock(renewed, 60_000), null);
});

test('site monitor records immutable inbound events before queueing and suppresses duplicate alerts', async () => {
  const blob = createBlob();
  const store = createSiteMonitorStore({ blob, now: () => new Date('2026-09-14T02:00:00.000Z') });
  const received = await store.recordEvent({
    source: 'notion', eventId: 'evt-1', pageId: 'page-1', sourceVersion: 'v1', type: 'page.content_updated',
  });
  const again = await store.recordEvent({
    source: 'notion', eventId: 'evt-1', pageId: 'page-1', sourceVersion: 'v1', type: 'page.content_updated',
  });
  assert.equal(received.duplicate, false);
  assert.equal(again.duplicate, true);
  await store.markEventQueued(received.id);

  const opened = await store.recordAlert({ key: 'notion-auth', status: 'open', category: 'auth', message: 'Notion unavailable' });
  const repeated = await store.recordAlert({ key: 'notion-auth', status: 'open', category: 'auth', message: 'Notion unavailable' });
  const resolved = await store.recordAlert({ key: 'notion-auth', status: 'resolved', category: 'auth', message: 'Notion restored' });
  assert.equal(opened.shouldDeliver, true);
  assert.equal(repeated.shouldDeliver, false);
  assert.equal(resolved.shouldDeliver, true);
});

// Deterministic AM4 monitor/repair orchestration.  It deliberately does not
// generate or edit editorial prose: the only write paths are the existing
// Notion mirror, a verified fixture identity, and verified player media.

import { createSyncArticleStore } from './sync-article-store.js';
import {
  getArticle,
  getMatchContentAvailability,
  listArticles,
  saveArticle,
} from './article-store.js';
import {
  collectNotionChanges,
  collectNotionSourcePages,
  notionArticleId,
  syncNotionPage,
} from './notion-content-sync.js';
import {
  matchEditorialBackfillTypesNeedingScan,
  queueMatchEditorialBackfill,
  queueUnlinkedMatchEditorialReconciliation,
} from './match-editorial-sync.js';
import { getFixtureIdentity } from '../api/fixtures.js';
import { hydratePredictionKeyPlayers } from './prediction-key-player-data.js';
import {
  readVerifiedPredictionKeyPlayerCards,
  saveVerifiedPredictionKeyPlayerCards,
} from './prediction-key-player-store.js';
import {
  hydrateMatchReportMotm,
  selectedMatchReportMotm,
  verifiedMotmCard,
} from './match-report-motm-data.js';
import {
  associationRepairArticle,
  resolveVerifiedFixtureForArticle,
} from './site-monitor-association.js';
import { siteMonitorDigest } from './site-monitor-store.js';
import { deliverSiteMonitorAlert } from './site-monitor-notify.js';
import {
  createGeneratedReport,
  isRetryableReportRepairError,
  prepareReportGeneration,
  reportGenerationFailureReason,
} from './match-report-repair.js';
import {
  createGeneratedPrediction,
  isRetryablePredictionRepairError,
  preparePredictionGeneration,
  predictionGenerationFailureReason,
} from './match-prediction-repair.js';

const MATCH_TYPES = new Set(['match_prediction', 'match_report']);
const TRANSIENT_OUTCOMES = new Set(['source_unavailable', 'storage_unavailable']);
const MIN_BROWSER_BUDGET_MS = 10_000;
const BROWSER_CLEANUP_RESERVE_MS = 5_000;
const MIN_FIXTURE_STEP_MS = 8_000;
const MIN_MEDIA_STEP_MS = 15_000;
// The deterministic report composer runs only after verified provider data is
// available, then needs enough time for its Notion write and normal public
// delivery.  Keep it out of the short monitor lane while leaving the dedicated
// worker a finite, practical execution budget.
const MIN_REPORT_GENERATION_STEP_MS = 90_000;
const MIN_PREDICTION_GENERATION_STEP_MS = 90_000;
const MIN_PRIMARY_CRON_BROWSER_LAUNCHES_PER_DAY = 12;
const EDITORIAL_QUEUE_METADATA_MIGRATION = 'editorial-delivery-queue-metadata-v2';
// A previous monitor build treated an explicit Chromium page/context/browser
// disconnect as a visual regression and could withdraw an otherwise healthy
// generated article. This narrowly scoped migration makes one fresh
// source-validated recovery job for those legacy records only.
export const TRANSIENT_BROWSER_RUNTIME_RECOVERY_KIND = 'transient_browser_recovery';
const TRANSIENT_BROWSER_RUNTIME_RECOVERY_GENERATION = 'browser-runtime-interruption-recovery-v1';
const TRANSIENT_BROWSER_RUNTIME_FAILURE = 'runtime_browser_transport_interrupted';
const MANUAL_REVIEW_OUTCOMES = new Set([
  'untrusted_source', 'empty_body', 'fixture_conflict', 'ambiguous',
  'insufficient_identity', 'not_found', 'fixture_missing', 'monitor_delivery_hold',
]);

export const DEFAULT_SITE_MONITOR_LIMITS = Object.freeze({
  maxJobsPerRun: 10,
  // Leave room below the Function's 120-second ceiling for a durable queue
  // transition and response. This is a budget, not a longer timeout.
  maxRunMs: 85_000,
  minJobStartMs: 20_000,
  maxRepairAttemptsPerVersion: 2,
  maxTransportRetries: 3,
  maxRepairsPerDay: 20,
  // New source-page creation is scarcer than ordinary deterministic repair
  // work. This is an atomic, durable per-day reservation immediately before a
  // Notion write, not a soft telemetry counter.
  maxGenerationsPerDay: 20,
  // Provider reads owned by the automatic report-repair lane. This is kept
  // apart from Notion HTTP attempts so a fixture scan cannot consume the
  // editorial-source cap or hide its own cost.
  maxProviderRequestsPerDay: 200,
  maxBrowserLaunchesPerDay: 12,
  maxApiCallsPerDay: 600,
  // This is a hard cap on actual Notion HTTP attempts in one worker run.
  // It includes retries, pagination, and nested Notion block reads.
  maxApiCallsPerRun: 100,
  maxProviderRequestsPerRun: 30,
  // A cold mobile pass loads the full article, the match SSR page, images,
  // and the date-filtered list. Twenty-five seconds made an otherwise healthy
  // three-surface check expire before its durable result was recorded.
  // Keep this finite and below the 85-second worker budget.
  browserBudgetMs: 40_000,
  lockTtlMs: 9 * 60 * 1000,
  jobLeaseMs: 8 * 60 * 1000,
  staleAfterMs: 130 * 60 * 1000,
});

function positive(value, fallback) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : fallback;
}

export function siteMonitorSettings(env = process.env) {
  const maxRunMs = Math.min(105_000, Math.max(30_000, positive(env.SITE_MONITOR_MAX_RUN_MS, DEFAULT_SITE_MONITOR_LIMITS.maxRunMs)));
  const browserBudgetCeiling = Math.max(MIN_BROWSER_BUDGET_MS, maxRunMs - BROWSER_CLEANUP_RESERVE_MS);
  return {
    ...DEFAULT_SITE_MONITOR_LIMITS,
    maxJobsPerRun: Math.min(50, Math.max(1, positive(env.SITE_MONITOR_MAX_JOBS_PER_RUN, DEFAULT_SITE_MONITOR_LIMITS.maxJobsPerRun))),
    maxRunMs,
    minJobStartMs: Math.min(maxRunMs, Math.max(5_000, positive(env.SITE_MONITOR_MIN_JOB_START_MS, DEFAULT_SITE_MONITOR_LIMITS.minJobStartMs))),
    maxRepairAttemptsPerVersion: Math.min(5, Math.max(1, positive(env.SITE_MONITOR_MAX_REPAIRS_PER_VERSION, DEFAULT_SITE_MONITOR_LIMITS.maxRepairAttemptsPerVersion))),
    maxTransportRetries: Math.min(6, Math.max(0, positive(env.SITE_MONITOR_MAX_TRANSPORT_RETRIES, DEFAULT_SITE_MONITOR_LIMITS.maxTransportRetries))),
    maxRepairsPerDay: positive(env.SITE_MONITOR_MAX_REPAIRS_PER_DAY, DEFAULT_SITE_MONITOR_LIMITS.maxRepairsPerDay),
    maxGenerationsPerDay: positive(env.SITE_MONITOR_MAX_GENERATIONS_PER_DAY, DEFAULT_SITE_MONITOR_LIMITS.maxGenerationsPerDay),
    maxBrowserLaunchesPerDay: positive(env.SITE_MONITOR_MAX_BROWSER_LAUNCHES_PER_DAY, DEFAULT_SITE_MONITOR_LIMITS.maxBrowserLaunchesPerDay),
    maxApiCallsPerDay: positive(env.SITE_MONITOR_MAX_API_CALLS_PER_DAY, DEFAULT_SITE_MONITOR_LIMITS.maxApiCallsPerDay),
    maxProviderRequestsPerDay: positive(env.SITE_MONITOR_MAX_PROVIDER_REQUESTS_PER_DAY, DEFAULT_SITE_MONITOR_LIMITS.maxProviderRequestsPerDay),
    maxApiCallsPerRun: Math.min(1_000, Math.max(0, positive(env.SITE_MONITOR_MAX_API_CALLS_PER_RUN, DEFAULT_SITE_MONITOR_LIMITS.maxApiCallsPerRun))),
    maxProviderRequestsPerRun: Math.min(1_000, Math.max(0, positive(env.SITE_MONITOR_MAX_PROVIDER_REQUESTS_PER_RUN, DEFAULT_SITE_MONITOR_LIMITS.maxProviderRequestsPerRun))),
    browserBudgetMs: Math.min(browserBudgetCeiling, Math.max(MIN_BROWSER_BUDGET_MS, positive(env.SITE_MONITOR_BROWSER_BUDGET_MS, DEFAULT_SITE_MONITOR_LIMITS.browserBudgetMs))),
    browserEnabled: String(env.SITE_MONITOR_BROWSER_ENABLED || 'true').toLowerCase() !== 'false',
  };
}

function nowIso(now) {
  return new Date(now()).toISOString();
}

function nowMs(now) {
  const value = new Date(now()).getTime();
  return Number.isFinite(value) ? value : Date.now();
}

function remainingRunMs(deadlineAt, now) {
  return deadlineAt - nowMs(now);
}

function canStartWork(deadlineAt, now, minimumMs = 0) {
  return remainingRunMs(deadlineAt, now) >= Math.max(0, Number(minimumMs) || 0);
}

function typeAvailability(type) {
  return type === 'match_prediction' ? 'prediction' : type === 'match_report' ? 'report' : null;
}

function normalisedBody(value) {
  return String(value || '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

// `getArticle` enriches a stored article with derived relation fields.  Compare
// only persistence-owned fields before a rollback/write guard so those derived
// views do not make a correct targeted restore look stale.
export function monitorArticleProjection(article) {
  if (!article) return null;
  return {
    id: article.id || null,
    type: article.type || null,
    title: article.title || null,
    body: normalisedBody(article.body),
    status: article.status || null,
    public: article.public !== false,
    publishedAt: article.publishedAt || null,
    notion: article.notion || null,
    match: article.match || null,
    prediction: article.prediction || null,
    report: article.report || null,
    story: article.story || null,
  };
}

export function monitorArticleDigest(article) {
  return siteMonitorDigest(monitorArticleProjection(article));
}

function sameArticle(left, right) {
  return monitorArticleDigest(left) === monitorArticleDigest(right);
}

function sourceVersion(article) {
  return article?.notion?.updatedAt || null;
}

// A newly mirrored article has no earlier public record to restore.  Keep a
// private, complete tombstone as its creation snapshot so that a final visual
// regression can withdraw exactly this monitor-created delivery without
// deleting or modifying the Notion source page.  A later editor revision is
// still free to publish through the normal synchronizer.
function createdArticleRollbackTombstone(article, { sourceVersion: version = null, jobId = null } = {}) {
  const prior = article?.siteMonitor && typeof article.siteMonitor === 'object'
    ? article.siteMonitor : {};
  const { deliveryHold: _deliveryHold, ...rest } = prior;
  return {
    ...article,
    public: false,
    siteMonitor: {
      ...rest,
      provisionalCreation: {
        sourceVersion: version || sourceVersion(article) || null,
        sourceJobId: jobId || null,
      },
    },
  };
}

function createdArticleDeliveryHold(snapshot, sourceVersionValue) {
  const before = snapshot?.before;
  const tombstone = createdArticleRollbackTombstone(before, {
    sourceVersion: snapshot?.sourceVersion || sourceVersionValue || sourceVersion(before),
    jobId: snapshot?.jobId || null,
  });
  return {
    ...tombstone,
    siteMonitor: {
      ...(tombstone.siteMonitor || {}),
      deliveryHold: {
        sourceVersion: snapshot?.sourceVersion || sourceVersionValue || sourceVersion(before) || null,
        reason: 'browser_validation_failed',
        sourceJobId: snapshot?.jobId || null,
      },
    },
  };
}

// A reconciliation job is queued only for an archive row that was unlinked
// when that scan ran.  A higher-priority source-owned Notion job can safely
// resolve and persist that same row before the reconciliation item reaches
// the head of the queue.  In that case, do not spend another provider lookup:
// identityVersion 2 is written only by `associationRepairArticle` after the
// full ordered-card validation has succeeded.  We still read the delivery
// projection below, so a stale index or missing card badge falls through to
// the normal repair path rather than being treated as success.
function verifiedPersistedFixtureId(article) {
  const fixtureId = Number(article?.match?.fixtureId);
  const identityVersion = Number(article?.match?.identityVersion);
  return Number.isSafeInteger(fixtureId) && fixtureId > 0 && identityVersion >= 2
    ? fixtureId
    : null;
}

// A queue item is allowed to stand down only when the durable mirror proves it
// already represents this Notion revision (or a newer one).  Do not use a
// lexical comparison: Notion normally gives ISO timestamps, but an unknown
// version format must fall through to the source request rather than being
// mistaken for a later revision.
function sourceVersionAtLeast(article, expectedVersion) {
  const actual = String(sourceVersion(article) || '').trim();
  const expected = String(expectedVersion || '').trim();
  if (!actual || !expected) return false;
  if (actual === expected) return true;
  const actualMs = Date.parse(actual);
  const expectedMs = Date.parse(expected);
  return Number.isFinite(actualMs) && Number.isFinite(expectedMs) && actualMs >= expectedMs;
}

function hasReusableMatchIdentity(article) {
  const match = article?.match || {};
  return /^\d{4}-\d{2}-\d{2}$/.test(String(match.date || '').slice(0, 10))
    && Boolean(String(match.homeTeam || '').trim())
    && Boolean(String(match.awayTeam || '').trim());
}

// Read the exact persisted mirror only when it is demonstrably the same
// source-owned Notion page and a same-or-newer editor revision.  This helper
// makes no claim that an unknown future Notion revision has been read: it
// merely proves that *this durable job's revision* was already mirrored.
// Delta collection and signed webhooks still enqueue a later source version.
async function readCurrentPersistedNotionPage(job, dependencies) {
  if (job.kind !== 'notion_page' || job.deliveryOnly !== true || !MATCH_TYPES.has(job.sourceType)) return null;
  const pageId = String(job.pageId || '').trim();
  if (!pageId || !job.sourceVersion) return null;
  const articleId = notionArticleId(job.sourceType, pageId);
  const article = await dependencies.getArticle(articleId, { includeHidden: true });
  if (
    !article
    || article.id !== articleId
    || article.type !== job.sourceType
    || String(article?.notion?.pageId || '') !== pageId
    || article.public === false
    || article.status !== 'published'
    || !sourceVersionAtLeast(article, job.sourceVersion)
  ) return null;
  return article;
}

// Backfills and webhook/delta collection deliberately use distinct durable
// generations.  A busy historical repair can therefore contain an old source
// job for an article which is already reader-visible at a newer revision.
// Before spending a Notion request or a provider fixture lookup, prove the
// exact page is already delivered.  Any uncertainty (different page/type,
// non-public record, unverified identity, stale version, or missing card
// availability) returns null and preserves the normal sync/repair path.
async function deliveredNotionPagePreflight(job, dependencies, persistedArticle = null) {
  const article = persistedArticle || await readCurrentPersistedNotionPage(job, dependencies);
  if (!article) return null;
  const fixtureId = verifiedPersistedFixtureId(article);
  if (!fixtureId) return null;
  const delivery = await inspectDelivery(article, { id: fixtureId }, dependencies, { requireMedia: false });
  if (delivery.issues.length) return null;
  return {
    state: 'superseded',
    reason: 'already_delivered_source_version',
    article,
    fixture: { id: fixtureId },
    delivery,
    sourceVersion: sourceVersion(article),
    repairs: [],
  };
}

function retryDelay(retries, retryAfterMs = null) {
  const requested = Number(retryAfterMs);
  if (Number.isFinite(requested) && requested > 0) return Math.ceil(requested);
  return Math.min(15 * 60 * 1000, 30_000 * (2 ** Math.max(0, retries)));
}

function quotaDetails(result) {
  const details = result?.details || {};
  return details?.quota || details?.quotaExceeded || details || {};
}

function nextTokyoMidnightDelay(now = () => new Date()) {
  const current = new Date(now());
  if (!Number.isFinite(current.getTime())) return 60 * 60 * 1000;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(current).reduce((output, part) => ({ ...output, [part.type]: part.value }), {});
  // The following JST midnight is 15:00 UTC on the *same local calendar
  // date* (for example, Sep 18 JST -> Sep 18 15:00 UTC). Adding a calendar
  // day here would defer a quota-held repair for an unnecessary extra day.
  const nextMidnightUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 15, 0, 5);
  return Math.max(60_000, nextMidnightUtc - current.getTime());
}

function quotaRetryDelay(result, now) {
  const exceeded = String(quotaDetails(result)?.exceeded || '');
  // Daily counters reset at Tokyo midnight. A per-run cap only needs the next
  // scheduled worker, which avoids leaving a version permanently blocked.
  return ['apiCallsPerRun', 'providerRequestsPerRun'].includes(exceeded)
    ? 60_000
    : nextTokyoMidnightDelay(now);
}

function compactIssue(code, detail = {}) {
  return { code, ...detail };
}

function defaultDependencies() {
  return {
    collectChanges: collectNotionChanges,
    collectFullSourcePages: collectNotionSourcePages,
    syncPage: syncNotionPage,
    createSyncStore: createSyncArticleStore,
    getArticle,
    saveArticle,
    listArticles,
    getAvailability: getMatchContentAvailability,
    getFixture: getFixtureIdentity,
    resolveFixture: resolveVerifiedFixtureForArticle,
    associationRepair: associationRepairArticle,
    hydratePrediction: hydratePredictionKeyPlayers,
    hydrateReport: hydrateMatchReportMotm,
    readStoredPredictionCards: readVerifiedPredictionKeyPlayerCards,
    saveStoredPredictionCards: saveVerifiedPredictionKeyPlayerCards,
    notify: deliverSiteMonitorAlert,
    // This module dynamically loads Playwright/Chromium only in the monitor
    // Function. Tests can inject a deterministic browser verifier instead.
    browserVerify: async (input) => {
      const { verifySiteMonitorInBrowser } = await import('./site-monitor-browser.js');
      return verifySiteMonitorInBrowser(input);
    },
    prepareReportGeneration,
    createGeneratedReport,
    preparePredictionGeneration,
    createGeneratedPrediction,
  };
}

async function alert(store, dependencies, {
  key,
  status = 'open',
  category,
  message,
  metadata = {},
}, { now = () => new Date() } = {}) {
  const recorded = await store.recordAlert({ key, status, category, message, metadata });
  if (!recorded.shouldDeliver) return { ...recorded, delivery: { state: 'suppressed' } };
  const delivery = await dependencies.notify(recorded.alert);
  // A 429 is the narrow case where the remote service confirms that it did
  // not accept a notification write. Persist one delayed retry job instead
  // of retrying a non-idempotent Notion append in-process. Timeouts/5xx stay
  // recorded but are not replayed, avoiding duplicate operator notices.
  let retryJob = null;
  if (delivery?.state === 'failed' && delivery?.retryable === true) {
    const availableAt = new Date(new Date(now()).getTime() + retryDelay(0, delivery.retryAfterMs)).toISOString();
    const queued = await store.enqueue({
      kind: 'notification_delivery',
      sourceType: 'monitor_alert',
      sourceVersion: siteMonitorDigest({ key: recorded.alert.key, status: recorded.alert.status }).slice(0, 40),
      payload: {
        alert: {
          key: recorded.alert.key,
          category: recorded.alert.category,
          status: recorded.alert.status,
          message: recorded.alert.message,
          firstSeenAt: recorded.alert.firstSeenAt,
          lastSeenAt: recorded.alert.lastSeenAt,
        },
      },
      trigger: 'notification_rate_limit_retry',
      priority: 99,
      availableAt,
    });
    retryJob = queued.job?.id || null;
  }
  const recordedDelivery = retryJob ? { ...delivery, retryJobId: retryJob } : delivery;
  await store.markAlertDelivery(recorded.alert.key, recordedDelivery);
  return { ...recorded, delivery: recordedDelivery };
}

async function reserve(store, limits, delta) {
  return store.consumeUsage(delta, {
    apiCalls: limits.maxApiCallsPerDay,
    providerRequests: limits.maxProviderRequestsPerDay,
    browserLaunches: limits.maxBrowserLaunchesPerDay,
    repairOperations: limits.maxRepairsPerDay,
    generations: limits.maxGenerationsPerDay,
  });
}

async function migrateClaimQueueMetadata(store, sourceTypes, kinds, now) {
  if (
    typeof store.migrateQueuedMetadata !== 'function'
    || ((!Array.isArray(sourceTypes) || !sourceTypes.length) && (!Array.isArray(kinds) || !kinds.length))
  ) {
    return { state: 'not_required', scanned: 0, migrated: 0 };
  }
  const state = (await store.readState()).value;
  const prior = state?.matchEditorialSync?.queueMetadataMigration || {};
  if (prior.generation === EDITORIAL_QUEUE_METADATA_MIGRATION && prior.completedAt) {
    return { state: 'already_complete', scanned: 0, migrated: 0 };
  }
  const result = await store.migrateQueuedMetadata({
    sourceTypes,
    kinds,
    deliveryOnly: true,
    afterJobId: prior.generation === EDITORIAL_QUEUE_METADATA_MIGRATION ? prior.cursor : null,
    limit: 200,
  });
  await store.updateState((current) => ({
    ...current,
    matchEditorialSync: {
      ...(current.matchEditorialSync || {}),
      queueMetadataMigration: {
        generation: EDITORIAL_QUEUE_METADATA_MIGRATION,
        cursor: result.complete ? null : result.nextCursor,
        completedAt: result.complete ? nowIso(now) : null,
        lastRunAt: nowIso(now),
        scanned: Number(prior.scanned || 0) + Number(result.scanned || 0),
        migrated: Number(prior.migrated || 0) + Number(result.migrated || 0),
      },
    },
  }));
  return { state: result.complete ? 'complete' : 'partial', ...result };
}

async function saveGuardedArticle({
  article,
  expected,
  sourceVersion: expectedVersion,
  job,
  store,
  dependencies,
  limits,
  snapshots,
  ensureWriteOwnership,
  deadlineAt = null,
  now = () => new Date(),
}) {
  if (deadlineAt != null && !canStartWork(deadlineAt, now, 3_000)) return { state: 'deferred_budget' };
  const current = await dependencies.getArticle(article.id, { includeHidden: true });
  if (!current || !sameArticle(current, expected) || (expectedVersion && sourceVersion(current) !== expectedVersion)) {
    return { state: 'source_changed' };
  }
  if (sameArticle(current, article)) return { state: 'unchanged', article: current };
  const quota = await reserve(store, limits, { repairOperations: 1 });
  if (!quota.ok) return { state: 'quota_exceeded', quota };
  if (!await ensureWriteOwnership()) return { state: 'source_changed' };
  const snapshot = await store.writeSnapshot({
    jobId: job.id,
    owner: job.leaseOwner,
    before: current,
    afterDigest: monitorArticleDigest(article),
    sourceVersion: expectedVersion,
    articleId: article.id,
  });
  if (!snapshot) return { state: 'source_changed' };
  snapshots.push(snapshot);
  if (deadlineAt != null && !canStartWork(deadlineAt, now, 2_000)) return { state: 'deferred_budget' };
  if (!await ensureWriteOwnership()) return { state: 'source_changed' };
  await dependencies.saveArticle(article);
  return { state: 'written', article };
}

async function rollbackSnapshots(
  snapshots,
  sourceVersionValue,
  dependencies,
  ensureWriteOwnership,
  { holdCreatedArticle = false } = {},
) {
  const result = [];
  for (const snapshot of [...snapshots].reverse()) {
    if (!await ensureWriteOwnership()) {
      result.push({ articleId: snapshot.articleId, state: 'skipped_lease_lost' });
      break;
    }
    try {
      const current = await dependencies.getArticle(snapshot.articleId, { includeHidden: true });
      const expectedSourceVersion = snapshot.sourceVersion || sourceVersionValue;
      if (
        !current
        || (expectedSourceVersion && sourceVersion(current) !== expectedSourceVersion)
        || monitorArticleDigest(current) !== snapshot.afterDigest
      ) {
        result.push({ articleId: snapshot.articleId, state: 'skipped_changed' });
        continue;
      }
      if (!await ensureWriteOwnership()) {
        result.push({ articleId: snapshot.articleId, state: 'skipped_lease_lost' });
        break;
      }
      const restored = snapshot.createdArticle === true
        ? holdCreatedArticle
          ? createdArticleDeliveryHold(snapshot, sourceVersionValue)
          : snapshot.before
        : snapshot.before;
      await dependencies.saveArticle(restored);
      result.push({
        articleId: snapshot.articleId,
        state: snapshot.createdArticle === true ? 'hidden' : 'restored',
      });
    } catch (error) {
      result.push({ articleId: snapshot.articleId, state: 'restore_failed', error: error.message });
    }
  }
  return result;
}

// A legacy browser-runtime recovery is allowed to make the previously held
// source visible only long enough to perform a real browser check. If that
// runtime disappears again, restore the exact delivery hold before either a
// retry or a terminal alert. This is intentionally separate from ordinary
// article validation: an existing public document must not be withdrawn just
// because Chromium is temporarily unavailable.
async function restoreTransientBrowserRecoveryHold(job, result, context) {
  const { store, dependencies, ensureWriteOwnership } = context;
  const expectedVersion = result.sourceVersion || job.sourceVersion || null;
  let persistedSnapshots = [];
  try {
    persistedSnapshots = await store.readSnapshots(job.id);
  } catch {
    // Fall through to the strict current-version fallback below. A Blob read
    // outage must never turn a held article into a permanently public one.
  }
  const snapshots = [...new Map(
    [...persistedSnapshots, ...(result.snapshots || [])].map((snapshot) => [snapshot.id, snapshot]),
  ).values()];
  const rolledBack = snapshots.length
    ? await rollbackSnapshots(
      snapshots,
      expectedVersion,
      dependencies,
      ensureWriteOwnership,
      { holdCreatedArticle: true },
    )
    : [];
  const restored = snapshots.length > 0
    && rolledBack.length === snapshots.length
    && rolledBack.every((item) => item.state === 'restored' || item.state === 'hidden');
  if (restored) return { state: 'held', rolledBack };

  // A recovery source is admitted only from a same-version monitor-created
  // hold. If its own snapshot could not be read or was interrupted midway,
  // reapply that hold only when the currently persisted public projection is
  // still exactly the article this worker inspected. This avoids overwriting
  // a newer source edit or another repair worker's result.
  try {
    const current = await dependencies.getArticle(result.article?.id || job.articleId, { includeHidden: true });
    const currentHold = current?.siteMonitor?.deliveryHold;
    if (
      current?.public === false
      && currentHold?.sourceVersion === expectedVersion
      && currentHold?.reason === 'browser_validation_failed'
    ) return { state: 'held', rolledBack };
    if (
      !current
      || !result.article
      || (expectedVersion && sourceVersion(current) !== expectedVersion)
      || monitorArticleDigest(current) !== monitorArticleDigest(result.article)
      || !await ensureWriteOwnership()
    ) return { state: 'unavailable', reason: 'browser_runtime_recovery_hold_incomplete', rolledBack };
    const prior = current.siteMonitor && typeof current.siteMonitor === 'object' ? current.siteMonitor : {};
    await dependencies.saveArticle({
      ...current,
      public: false,
      siteMonitor: {
        ...prior,
        provisionalCreation: prior.provisionalCreation || {
          sourceVersion: expectedVersion || sourceVersion(current) || null,
          sourceJobId: job.id,
        },
        deliveryHold: {
          sourceVersion: expectedVersion || sourceVersion(current) || null,
          reason: 'browser_validation_failed',
          sourceJobId: job.id,
        },
      },
    });
    return {
      state: 'held',
      rolledBack: [...rolledBack, { articleId: current.id, state: 'hidden_fallback' }],
    };
  } catch {
    return { state: 'unavailable', reason: 'browser_runtime_recovery_hold_incomplete', rolledBack };
  }
}

async function hydrateForMedia(article, fixture, dependencies) {
  if (article?.type === 'match_prediction') return dependencies.hydratePrediction(article, fixture);
  if (article?.type === 'match_report') return dependencies.hydrateReport(article, fixture);
  return article;
}

function mediaIssue(article, fixture) {
  if (article?.type === 'match_prediction') {
    const source = article?.prediction?.keyPlayers || article?.prediction?.keyPlayerCards;
    if (!source) return null;
    const cards = Array.isArray(article?.prediction?.keyPlayerCards) ? article.prediction.keyPlayerCards : [];
    if (!cards.length || cards.some((card) => card?.resolved !== true || !card.playerId || !card.teamId || !card.photoUrl || !card.logoUrl)) {
      return compactIssue('key_player_media_missing');
    }
    return null;
  }
  if (article?.type === 'match_report') {
    if (!selectedMatchReportMotm(article)) return null;
    return verifiedMotmCard(article?.report?.motmCard, fixture)
      ? null
      : compactIssue('motm_media_missing');
  }
  return null;
}

async function inspectDelivery(article, fixture, dependencies, { requireMedia = true } = {}) {
  const delivered = await dependencies.getArticle(article.id, { includeHidden: true });
  if (!delivered || delivered.public === false) return { article: delivered, issues: [compactIssue('article_not_delivered')] };
  const issues = [];
  if (normalisedBody(delivered.body) !== normalisedBody(article.body)) issues.push(compactIssue('article_body_mismatch'));
  if (MATCH_TYPES.has(delivered.type)) {
    if (!fixture?.id) {
      issues.push(compactIssue('fixture_unresolved'));
    } else {
      const availability = await dependencies.getAvailability([fixture.id], [delivered.match?.canonicalKey].filter(Boolean), { fresh: true });
      const expected = typeAvailability(delivered.type);
      const visible = new Set([
        ...(availability?.availability?.[fixture.id] || []),
        ...(availability?.matchAvailability?.[delivered.match?.canonicalKey] || []),
      ]);
      if (!visible.has(expected)) issues.push(compactIssue('label_or_link_missing', { fixtureId: fixture.id, expected }));
    }
    if (requireMedia) {
      const issue = mediaIssue(delivered, fixture);
      if (issue) issues.push(issue);
    }
  }
  return { article: delivered, issues };
}

async function browserInspection(article, fixture, store, dependencies, limits, { deadlineAt = null, now = () => new Date() } = {}) {
  if (!limits.browserEnabled) return { status: 'unavailable', reason: 'browser_disabled' };
  const configuredBudget = Math.max(MIN_BROWSER_BUDGET_MS, Number(limits.browserBudgetMs) || DEFAULT_SITE_MONITOR_LIMITS.browserBudgetMs);
  const remaining = deadlineAt == null ? configuredBudget : remainingRunMs(deadlineAt, now);
  const timeoutMs = Math.min(configuredBudget, Math.max(0, remaining - BROWSER_CLEANUP_RESERVE_MS));
  // Do not burn a browser quota or launch Chromium when its bounded first
  // paint check cannot fit before the worker's durable cleanup reserve.
  if (timeoutMs <= MIN_BROWSER_BUDGET_MS) return { status: 'deferred', reason: 'time_budget_exhausted' };
  const quota = await reserve(store, limits, { browserLaunches: 1 });
  if (!quota.ok) return { status: 'unavailable', reason: 'browser_quota_exceeded', quota };
  return dependencies.browserVerify({
    article,
    fixture,
    // A repair must be checked against the newly persisted delivery data, not
    // a one-minute public CDN response left from before the write.
    cacheKey: `${article?.id || 'article'}-${sourceVersion(article) || Date.now()}`,
    timeoutMs,
    deadlineAt: new Date(nowMs(now) + timeoutMs).toISOString(),
  });
}

async function syncPageArticle(job, context) {
  const {
    store, dependencies, limits, snapshots, deploymentId, ensureWriteOwnership, deadlineAt, consumeApiRequest,
  } = context;
  let quotaExceeded = null;
  let deploymentChanged = false;
  let snapshotUnavailable = false;
  const syncStartedAt = Date.now();
  const articleStore = dependencies.createSyncStore();
  const predictionHydrator = async (article) => {
    const fixtureId = Number(article?.match?.fixtureId);
    if (!Number.isInteger(fixtureId) || fixtureId <= 0) return article;
    const fixture = await dependencies.getFixture(fixtureId);
    return fixture ? dependencies.hydratePrediction(article, fixture) : article;
  };
  const reportHydrator = async (article) => {
    const fixtureId = Number(article?.match?.fixtureId);
    if (!Number.isInteger(fixtureId) || fixtureId <= 0) return article;
    const fixture = await dependencies.getFixture(fixtureId);
    return fixture ? dependencies.hydrateReport(article, fixture) : article;
  };
  const outcome = await dependencies.syncPage({
    pageId: job.pageId,
    sourceType: job.sourceType,
    expectedSourceVersion: job.sourceVersion,
    // This flag is attached only by the code-owned legacy runtime-recovery
    // migration below. It cannot be supplied by a reader or generic admin
    // request, and syncNotionPage still re-reads the source page/version
    // before it considers releasing the exact monitor-created hold.
    releaseMonitorDeliveryHold: job.kind === TRANSIENT_BROWSER_RUNTIME_RECOVERY_KIND
      && job.payload?.releaseMonitorDeliveryHold === true,
    articleStore,
    hydratePredictionArticle: predictionHydrator,
    hydrateReportArticle: reportHydrator,
    deadlineAt,
    consumeRequest: consumeApiRequest,
    beforeWrite: async ({ existingArticle, article, page }) => {
      // A deployment event is useful only while this Function is serving the
      // exact production deployment that triggered it. Never repair against a
      // newer/older code deployment silently.
      if (deploymentId && job.deploymentId && deploymentId !== job.deploymentId) {
        deploymentChanged = true;
        return false;
      }
      const quota = await reserve(store, limits, { repairOperations: 1 });
      if (!quota.ok) {
        quotaExceeded = quota;
        return false;
      }
      if (!await ensureWriteOwnership()) {
        snapshotUnavailable = true;
        return false;
      }
      // New public mirrors need a rollback record too. Their pre-write
      // counterpart is a private tombstone rather than a nonexistent Blob,
      // so a later failed real-browser validation can hide only this
      // monitor-created delivery while preserving the source page for review.
      const createdArticle = !existingArticle
        || existingArticle?.siteMonitor?.provisionalCreation != null;
      const snapshot = await store.writeSnapshot({
        jobId: job.id,
        owner: job.leaseOwner,
        before: existingArticle || createdArticleRollbackTombstone(article, {
          sourceVersion: page?.last_edited_time || page?.created_time || null,
          jobId: job.id,
        }),
        afterDigest: monitorArticleDigest(article),
        sourceVersion: page?.last_edited_time || page?.created_time || null,
        articleId: article.id,
        createdArticle,
      });
      if (!snapshot) {
        snapshotUnavailable = true;
        return false;
      }
      snapshots.push(snapshot);
      if (!await ensureWriteOwnership()) {
        snapshotUnavailable = true;
        return false;
      }
      return true;
    },
  });
  const timing = { syncPageMs: Math.max(0, Date.now() - syncStartedAt) };
  if (quotaExceeded) return { outcome: 'quota_exceeded', quota: quotaExceeded, timing };
  if (deploymentChanged) return { outcome: 'deployment_changed', timing };
  if (snapshotUnavailable) return { outcome: 'source_changed', timing };
  return { ...outcome, timing: { ...(outcome?.timing || {}), ...timing } };
}

async function reserveGeneratedEditorialAttempt(job, context) {
  const { store, limits, ensureWriteOwnership } = context;
  const existingAttempts = Number(job.generationAttempts || 0);
  // A provider/Notion transport retry is tracked separately by the queue.
  // This ceiling specifically limits costly model writes for the exact same
  // fixture result version across Function restarts.
  if (existingAttempts >= 2) return { state: 'manual_review', reason: 'generation_attempt_limit' };
  const quota = await reserve(store, limits, { generations: 1, repairOperations: 1 });
  if (!quota.ok) return { state: 'quota_exceeded', details: { quota } };
  if (!await ensureWriteOwnership()) return { state: 'superseded', reason: 'lease_lost' };
  const updated = await store.updateJob(job.id, (current) => {
    if (
      !current
      || current.status !== 'running'
      || current.leaseOwner !== job.leaseOwner
    ) return null;
    const generationAttempts = Number(current.generationAttempts || 0) + 1;
    if (generationAttempts > 2) return null;
    return { ...current, generationAttempts };
  });
  if (!updated?.changed || !updated.value) return { state: 'superseded', reason: 'lease_lost' };
  return { state: 'reserved', generationAttempts: updated.value.generationAttempts };
}

async function updateGenerationAudit(store, stateKey, fixture, patch, now) {
  const fixtureId = Number(fixture?.id || patch?.fixtureId);
  if (!Number.isSafeInteger(fixtureId) || fixtureId <= 0) return;
  try {
    await store.updateState((state) => {
      const repair = state[stateKey] && typeof state[stateKey] === 'object'
        ? state[stateKey] : {};
      const fixtures = repair.fixtures && typeof repair.fixtures === 'object' ? repair.fixtures : {};
      const prior = fixtures[String(fixtureId)] || { fixtureId };
      return {
        ...state,
        [stateKey]: {
          ...repair,
          fixtures: {
            ...fixtures,
            [String(fixtureId)]: {
              ...prior,
              ...patch,
              fixtureId,
              updatedAt: nowIso(now),
            },
          },
        },
      };
    });
  } catch {
    // Audit metadata is valuable, but an auxiliary Blob update must never
    // turn a verified source/public repair into a false failure.
  }
}

async function updateReportGenerationAudit(store, fixture, patch, now) {
  return updateGenerationAudit(store, 'matchReportRepair', fixture, patch, now);
}

async function updatePredictionGenerationAudit(store, fixture, patch, now) {
  return updateGenerationAudit(store, 'matchPredictionRepair', fixture, patch, now);
}

// A generated source job can write an association/media correction before it
// queues a separate cold-browser validation. Persist the narrow rollback
// lineage *inside the child job's initial record*, rather than attaching it
// after the public write. That makes the visual job self-contained across a
// Function interruption and lets the source worker back out safely if even
// its durable enqueue cannot be confirmed.
function browserValidationLineage(job, sourceVersionValue) {
  const sourceJobId = String(job?.id || '').trim();
  const sourceVersion = String(sourceVersionValue || '').trim();
  if (!sourceJobId || !sourceVersion) return null;
  return {
    // A safe retry of the *same* generated source version gets a new child
    // identity only after the source job itself has been reclaimed. This
    // avoids reusing an abandoned child after an enqueue/storage failure.
    validationId: siteMonitorDigest({
      sourceJobId,
      sourceVersion,
      sourceAttempt: Number(job?.attempts || 0),
      transportRetries: Number(job?.transportRetries || 0),
    }).slice(0, 40),
    payload: {
      rollbackSourceJobIds: [sourceJobId],
      rollbackSourceVersion: sourceVersion,
    },
  };
}

function hasBrowserValidationLineage(validationJob, lineage) {
  const payload = validationJob?.payload && typeof validationJob.payload === 'object'
    ? validationJob.payload : {};
  return Boolean(
    lineage
    && String(payload.rollbackSourceVersion || '') === lineage.payload.rollbackSourceVersion
    && Array.isArray(payload.rollbackSourceJobIds)
    && payload.rollbackSourceJobIds.includes(lineage.payload.rollbackSourceJobIds[0]),
  );
}

async function enqueueGeneratedBrowserValidation({
  store,
  sourceJob,
  article,
  sourceType,
  sourceVersionValue,
  trigger,
}) {
  const lineage = browserValidationLineage(sourceJob, sourceVersionValue);
  if (!lineage) return { state: 'unavailable', reason: 'browser_validation_lineage_invalid' };
  let queued;
  try {
    queued = await store.enqueue({
      kind: 'article_validation',
      articleId: article.id,
      sourceType,
      sourceVersion: sourceVersionValue,
      validationId: lineage.validationId,
      deliveryOnly: false,
      trigger,
      priority: 99,
      payload: lineage.payload,
    });
  } catch {
    return { state: 'unavailable', reason: 'browser_validation_enqueue_unavailable' };
  }
  if (hasBrowserValidationLineage(queued.job, lineage)) {
    return { state: 'queued', job: queued.job, enqueued: queued.enqueued };
  }

  // The only expected path here is a job created by an earlier monitor
  // version. Bring an active record up to the same code-owned payload. A
  // terminal or storage-unavailable record is deliberately not trusted.
  try {
    const attached = await store.updateJob(queued.job?.id, (current) => {
      if (!current || ['completed', 'blocked', 'failed'].includes(current.status)) return null;
      const payload = current.payload && typeof current.payload === 'object' ? current.payload : {};
      return { ...current, payload: { ...payload, ...lineage.payload } };
    });
    if (attached?.changed && hasBrowserValidationLineage(attached.value, lineage)) {
      return { state: 'queued', job: attached.value, enqueued: queued.enqueued };
    }
  } catch {
    // The source worker handles this as an unvalidated write below.
  }
  return { state: 'unavailable', reason: 'browser_validation_lineage_unavailable' };
}

async function rollbackUnvalidatedGeneratedDelivery(job, delivery, context) {
  const { store, dependencies, ensureWriteOwnership } = context;
  let snapshots;
  try {
    snapshots = await store.readSnapshots(job.id);
  } catch {
    return { state: 'unavailable', reason: 'generation_snapshot_unavailable', rolledBack: [] };
  }
  if (!snapshots.length) return { state: 'unavailable', reason: 'generation_snapshot_missing', rolledBack: [] };
  const rolledBack = await rollbackSnapshots(
    snapshots,
    delivery.sourceVersion || job.sourceVersion,
    dependencies,
    ensureWriteOwnership,
    { holdCreatedArticle: false },
  );
  const safe = rolledBack.length === snapshots.length
    && rolledBack.every((item) => item.state === 'restored' || item.state === 'hidden');
  return {
    state: safe ? 'rolled_back' : 'unavailable',
    reason: safe ? null : 'generation_rollback_incomplete',
    rolledBack,
  };
}

function browserValidationLineageKind(job) {
  if (job?.trigger === 'report_generation_browser_validation') return 'report_generation';
  if (job?.trigger === 'prediction_generation_browser_validation') return 'prediction_generation';
  return null;
}

async function linkedBrowserValidationSnapshots(job, store) {
  const expectedKind = browserValidationLineageKind(job);
  const expectedVersion = String(job?.sourceVersion || '').trim();
  const payload = job?.payload && typeof job.payload === 'object' ? job.payload : {};
  const configuredVersion = String(payload.rollbackSourceVersion || '').trim();
  const sourceJobIds = Array.isArray(payload.rollbackSourceJobIds)
    ? [...new Set(payload.rollbackSourceJobIds
      .filter((id) => typeof id === 'string' && /^[a-f0-9]{40}$/iu.test(id)))]
    : [];
  if (!expectedKind || !expectedVersion || configuredVersion !== expectedVersion || !sourceJobIds.length) return [];
  const snapshots = [];
  for (const sourceJobId of sourceJobIds.slice(-2)) {
    const source = await store.readJob(sourceJobId);
    const sourceJob = source?.value;
    const generated = expectedKind === 'report_generation'
      ? sourceJob?.result?.reportGeneration
      : sourceJob?.result?.predictionGeneration;
    if (
      sourceJob?.kind !== expectedKind
      || String(generated?.sourceVersion || sourceJob?.result?.sourceVersion || '') !== expectedVersion
    ) continue;
    snapshots.push(...await store.readSnapshots(sourceJobId));
  }
  return snapshots;
}

async function processReportGeneration(job, context) {
  const {
    store, dependencies, deadlineAt, now, limits, consumeProviderRequest,
  } = context;
  if (!job.fixtureId) return { state: 'manual_review', reason: 'missing_fixture_id' };
  let prepared;
  try {
    prepared = await dependencies.prepareReportGeneration({
      fixtureId: job.fixtureId,
      listPublicArticles: dependencies.listArticles,
      deadlineAt,
      consumeRequest: context.consumeApiRequest,
      consumeProviderRequest,
    });
  } catch (error) {
    if (error?.code === 'PROVIDER_USAGE_LIMIT') return { state: 'quota_exceeded', details: { quota: error.details || null } };
    if (error?.code === 'NOTION_USAGE_LIMIT') return { state: 'quota_exceeded', details: { quota: error.details || null } };
    const reason = reportGenerationFailureReason(error, 'report_generation_prepare_unavailable');
    return isRetryableReportRepairError(error)
      ? {
        state: 'retryable', reason,
        details: { retryAfterMs: error?.retryAfterMs || null },
      }
      : { state: 'manual_review', reason };
  }
  if (!prepared || prepared.state === 'superseded' || prepared.state === 'public_report_exists') {
    return { state: 'completed', reason: prepared?.reason || prepared?.state || 'report_already_available', fixture: prepared?.fixture || null, repairs: [] };
  }
  if (prepared.state === 'retryable') {
    return {
      state: 'retryable', reason: prepared.reason || 'fixture_result_unavailable',
      fixture: prepared.fixture || null,
      details: { retryAfterMs: prepared.retryAfterMs || null },
    };
  }
  if (prepared.state === 'manual_review') {
    await updateReportGenerationAudit(store, prepared.fixture, {
      classification: 'ambiguous', outcome: 'manual_review', cause: prepared.reason || 'notion_report_ambiguous',
      display: 'report_pending',
    }, now);
    return { state: 'manual_review', reason: prepared.reason || 'notion_report_ambiguous', fixture: prepared.fixture || null };
  }

  let page = prepared.page || null;
  let sourceVersionValue = prepared.sourceVersion || null;
  let generated = false;
  let generationAttempts = Number(job.generationAttempts || 0);
  if (prepared.state === 'ready') {
    if (!canStartWork(deadlineAt, now, MIN_REPORT_GENERATION_STEP_MS)) {
      return { state: 'deferred_budget', reason: 'report_generation_time_budget' };
    }
    const reservation = await reserveGeneratedEditorialAttempt(job, context);
    if (reservation.state !== 'reserved') return reservation;
    generationAttempts = reservation.generationAttempts;
    try {
      const created = await dependencies.createGeneratedReport({
        fixture: prepared.fixture,
        match: prepared.match,
        deadlineAt,
        consumeRequest: context.consumeApiRequest,
        consumeProviderRequest,
      });
      page = created.page;
      sourceVersionValue = created.sourceVersion;
      generated = true;
    } catch (error) {
      if (error?.code === 'PROVIDER_USAGE_LIMIT') return { state: 'quota_exceeded', details: { quota: error.details || null } };
      if (error?.code === 'NOTION_USAGE_LIMIT') return { state: 'quota_exceeded', details: { quota: error.details || null } };
      const reason = reportGenerationFailureReason(error, 'report_generation_unavailable');
      if (error?.notionCreateOutcomeUnknown) {
        await updateReportGenerationAudit(store, prepared.fixture, {
          classification: 'A_notion_create_outcome_unknown',
          outcome: 'manual_review',
          cause: reason,
          display: 'report_pending',
        }, now);
        return { state: 'manual_review', reason, fixture: prepared.fixture, generationAttempts };
      }
      return isRetryableReportRepairError(error)
        ? {
          state: 'retryable', reason,
          details: { retryAfterMs: error?.retryAfterMs || null }, generationAttempts,
        }
        : { state: 'manual_review', reason, generationAttempts };
    }
  }
  const pageId = String(page?.id || '').trim();
  if (!pageId || !sourceVersionValue) {
    return { state: 'retryable', reason: 'generated_notion_page_unconfirmed', generationAttempts };
  }
  // Reuse the normal page synchronizer rather than teaching the generator how
  // to write the public archive, resolve aliases, hydrate portraits, or build
  // match availability. Delivery-only protects the good source page from a
  // transient browser failure; a separate high-priority visual job follows.
  const deliveryJob = {
    ...job,
    kind: 'notion_page',
    pageId,
    sourceType: 'match_report',
    sourceVersion: sourceVersionValue,
    // A fixture-ID/card conflict must re-read the exact Notion source.  A
    // delivery-only preflight would otherwise trust the stale public mirror
    // and suppress the association repair which this generator discovered.
    deliveryOnly: prepared.forceSourceSync !== true,
    trigger: generated ? 'report_generation_sync' : 'existing_report_resync',
  };
  const delivery = await processArticle(deliveryJob, context);
  if (delivery.state === 'completed' && !delivery.article?.id) {
    // A source report can legitimately be a Notion draft or non-public page.
    // Never silently mark that fixture recovered (and never generate a
    // duplicate).  The normal Notion collector will requeue the page when an
    // editor publishes it; until then this remains a durable, alerted hold.
    await updateReportGenerationAudit(store, prepared.fixture, {
      classification: 'B_existing_notion_report_not_public',
      outcome: 'manual_review',
      cause: delivery.details?.outcome || 'notion_report_not_public',
      notionPageId: pageId,
      sourceVersion: sourceVersionValue,
      fixtureLinked: false,
      display: 'report_pending',
    }, now);
    return {
      state: 'manual_review',
      reason: 'existing_notion_report_not_public',
      fixture: prepared.fixture,
      pageId,
      details: delivery.details || null,
      generationAttempts,
    };
  }
  if (delivery.state !== 'completed' || !delivery.article?.id) {
    return { ...delivery, generationAttempts };
  }
  const verification = await enqueueGeneratedBrowserValidation({
    store,
    sourceJob: job,
    article: delivery.article,
    sourceType: 'match_report',
    sourceVersionValue: delivery.sourceVersion || sourceVersionValue,
    trigger: 'report_generation_browser_validation',
  });
  if (verification.state !== 'queued') {
    const rollback = await rollbackUnvalidatedGeneratedDelivery(job, delivery, context);
    if (rollback.state === 'rolled_back') {
      return {
        state: 'retryable', reason: verification.reason, fixture: prepared.fixture,
        details: { rolledBack: rollback.rolledBack }, generationAttempts,
      };
    }
    return {
      state: 'manual_review', reason: verification.reason || rollback.reason,
      fixture: prepared.fixture, details: { rolledBack: rollback.rolledBack }, generationAttempts,
    };
  }
  await updateReportGenerationAudit(store, prepared.fixture, {
    classification: generated ? 'A_created_missing_notion_report'
      : prepared.forceSourceSync ? 'C_public_report_fixture_relinked'
        : 'B_existing_notion_report_resynced',
    outcome: generated ? 'created_and_synced'
      : prepared.forceSourceSync ? 'fixture_relinked_and_synced'
        : 'existing_report_resynced',
    cause: generated ? 'notion_report_missing'
      : prepared.forceSourceSync ? 'fixture_card_conflict'
        : 'production_sync_missing_or_stale',
    notionPageId: pageId,
    productionArticleId: delivery.article.id,
    sourceVersion: sourceVersionValue,
    syncVersion: delivery.sourceVersion || sourceVersionValue,
    fixtureLinked: Number(delivery.fixture?.id) === Number(prepared.fixture?.id),
    display: 'report_available',
    browserValidationJobId: verification.job?.id || null,
  }, now);
  return {
    ...delivery,
    state: 'completed',
    generationAttempts,
    reportGeneration: {
      fixtureId: prepared.fixture?.id || Number(job.fixtureId),
      outcome: generated ? 'created_and_synced'
        : prepared.forceSourceSync ? 'fixture_relinked_and_synced'
          : 'existing_report_resynced',
      notionPageId: pageId,
      sourceVersion: sourceVersionValue,
      browserValidationJobId: verification.job?.id || null,
    },
    repairs: [
      ...(delivery.repairs || []),
      { kind: generated ? 'match_report_generation' : 'match_report_resync', fixtureId: prepared.fixture?.id || Number(job.fixtureId) },
    ],
  };
}

async function processPredictionGeneration(job, context) {
  const {
    store, dependencies, deadlineAt, now, consumeProviderRequest,
  } = context;
  if (!job.fixtureId) return { state: 'manual_review', reason: 'missing_fixture_id' };
  let prepared;
  try {
    prepared = await dependencies.preparePredictionGeneration({
      fixtureId: job.fixtureId,
      listPublicArticles: dependencies.listArticles,
      deadlineAt,
      consumeRequest: context.consumeApiRequest,
      consumeProviderRequest,
    });
  } catch (error) {
    if (error?.code === 'PROVIDER_USAGE_LIMIT') return { state: 'quota_exceeded', details: { quota: error.details || null } };
    if (error?.code === 'NOTION_USAGE_LIMIT') return { state: 'quota_exceeded', details: { quota: error.details || null } };
    const reason = predictionGenerationFailureReason(error, 'prediction_generation_prepare_unavailable');
    return isRetryablePredictionRepairError(error)
      ? { state: 'retryable', reason, details: { retryAfterMs: error?.retryAfterMs || null } }
      : { state: 'manual_review', reason };
  }
  if (!prepared || prepared.state === 'superseded' || prepared.state === 'public_prediction_exists') {
    return { state: 'completed', reason: prepared?.reason || prepared?.state || 'prediction_already_available', fixture: prepared?.fixture || null, repairs: [] };
  }
  if (prepared.state === 'retryable') {
    return {
      state: 'retryable', reason: prepared.reason || 'prediction_context_unavailable',
      fixture: prepared.fixture || null, details: { retryAfterMs: prepared.retryAfterMs || null },
    };
  }
  if (prepared.state === 'manual_review') {
    await updatePredictionGenerationAudit(store, prepared.fixture, {
      classification: 'ambiguous', outcome: 'manual_review', cause: prepared.reason || 'notion_prediction_ambiguous',
      display: 'prediction_pending',
    }, now);
    return { state: 'manual_review', reason: prepared.reason || 'notion_prediction_ambiguous', fixture: prepared.fixture || null };
  }

  let page = prepared.page || null;
  let sourceVersionValue = prepared.sourceVersion || null;
  let generated = false;
  let generationAttempts = Number(job.generationAttempts || 0);
  if (prepared.state === 'ready') {
    if (!canStartWork(deadlineAt, now, MIN_PREDICTION_GENERATION_STEP_MS)) {
      return { state: 'deferred_budget', reason: 'prediction_generation_time_budget' };
    }
    const reservation = await reserveGeneratedEditorialAttempt(job, context);
    if (reservation.state !== 'reserved') return reservation;
    generationAttempts = reservation.generationAttempts;
    try {
      const created = await dependencies.createGeneratedPrediction({
        fixture: prepared.fixture,
        match: prepared.match,
        deadlineAt,
        consumeRequest: context.consumeApiRequest,
        consumeProviderRequest,
      });
      page = created.page;
      sourceVersionValue = created.sourceVersion;
      generated = true;
    } catch (error) {
      if (error?.code === 'PROVIDER_USAGE_LIMIT') return { state: 'quota_exceeded', details: { quota: error.details || null } };
      if (error?.code === 'NOTION_USAGE_LIMIT') return { state: 'quota_exceeded', details: { quota: error.details || null } };
      const reason = predictionGenerationFailureReason(error, 'prediction_generation_unavailable');
      if (error?.notionCreateOutcomeUnknown) {
        await updatePredictionGenerationAudit(store, prepared.fixture, {
          classification: 'A_notion_create_outcome_unknown', outcome: 'manual_review', cause: reason, display: 'prediction_pending',
        }, now);
        return { state: 'manual_review', reason, fixture: prepared.fixture, generationAttempts };
      }
      return isRetryablePredictionRepairError(error)
        ? { state: 'retryable', reason, details: { retryAfterMs: error?.retryAfterMs || null }, generationAttempts }
        : { state: 'manual_review', reason, generationAttempts };
    }
  }
  const pageId = String(page?.id || '').trim();
  if (!pageId || !sourceVersionValue) {
    return { state: 'retryable', reason: 'generated_notion_page_unconfirmed', generationAttempts };
  }
  const deliveryJob = {
    ...job,
    kind: 'notion_page',
    pageId,
    sourceType: 'match_prediction',
    sourceVersion: sourceVersionValue,
    deliveryOnly: prepared.forceSourceSync !== true,
    trigger: generated ? 'prediction_generation_sync' : 'existing_prediction_resync',
  };
  const delivery = await processArticle(deliveryJob, context);
  if (delivery.state === 'completed' && !delivery.article?.id) {
    await updatePredictionGenerationAudit(store, prepared.fixture, {
      classification: 'B_existing_notion_prediction_not_public', outcome: 'manual_review',
      cause: delivery.details?.outcome || 'notion_prediction_not_public', notionPageId: pageId,
      sourceVersion: sourceVersionValue, fixtureLinked: false, display: 'prediction_pending',
    }, now);
    return {
      state: 'manual_review', reason: 'existing_notion_prediction_not_public', fixture: prepared.fixture,
      pageId, details: delivery.details || null, generationAttempts,
    };
  }
  if (delivery.state !== 'completed' || !delivery.article?.id) return { ...delivery, generationAttempts };
  const verification = await enqueueGeneratedBrowserValidation({
    store,
    sourceJob: job,
    article: delivery.article,
    sourceType: 'match_prediction',
    sourceVersionValue: delivery.sourceVersion || sourceVersionValue,
    trigger: 'prediction_generation_browser_validation',
  });
  if (verification.state !== 'queued') {
    const rollback = await rollbackUnvalidatedGeneratedDelivery(job, delivery, context);
    if (rollback.state === 'rolled_back') {
      return {
        state: 'retryable', reason: verification.reason, fixture: prepared.fixture,
        details: { rolledBack: rollback.rolledBack }, generationAttempts,
      };
    }
    return {
      state: 'manual_review', reason: verification.reason || rollback.reason,
      fixture: prepared.fixture, details: { rolledBack: rollback.rolledBack }, generationAttempts,
    };
  }
  await updatePredictionGenerationAudit(store, prepared.fixture, {
    classification: generated ? 'A_created_missing_notion_prediction'
      : prepared.forceSourceSync ? 'C_public_prediction_fixture_relinked'
        : 'B_existing_prediction_resynced',
    outcome: generated ? 'created_and_synced'
      : prepared.forceSourceSync ? 'fixture_relinked_and_synced'
        : 'existing_prediction_resynced',
    cause: generated ? 'notion_prediction_missing'
      : prepared.forceSourceSync ? 'fixture_card_conflict'
        : 'production_sync_missing_or_stale',
    notionPageId: pageId, productionArticleId: delivery.article.id, sourceVersion: sourceVersionValue,
    syncVersion: delivery.sourceVersion || sourceVersionValue,
    fixtureLinked: Number(delivery.fixture?.id) === Number(prepared.fixture?.id),
    display: 'prediction_available', browserValidationJobId: verification.job?.id || null,
  }, now);
  return {
    ...delivery,
    state: 'completed',
    generationAttempts,
    predictionGeneration: {
      fixtureId: prepared.fixture?.id || Number(job.fixtureId),
      outcome: generated ? 'created_and_synced'
        : prepared.forceSourceSync ? 'fixture_relinked_and_synced'
          : 'existing_prediction_resynced',
      notionPageId: pageId,
      sourceVersion: sourceVersionValue,
      browserValidationJobId: verification.job?.id || null,
    },
    repairs: [
      ...(delivery.repairs || []),
      { kind: generated ? 'match_prediction_generation' : 'match_prediction_resync', fixtureId: prepared.fixture?.id || Number(job.fixtureId) },
    ],
  };
}

function notificationAlertPayload(job) {
  const alert = job?.payload?.alert;
  const key = String(alert?.key || '').trim();
  if (!key || key.length > 200 || /[\r\n\0]/u.test(key)) return null;
  return {
    key,
    category: String(alert?.category || 'monitor').slice(0, 80),
    status: String(alert?.status || 'open').slice(0, 32),
    message: String(alert?.message || 'AM4の自動監査で状態が変化しました。').slice(0, 1_000),
    firstSeenAt: alert?.firstSeenAt || null,
    lastSeenAt: alert?.lastSeenAt || null,
  };
}

async function processNotificationDelivery(job, { dependencies }) {
  const alert = notificationAlertPayload(job);
  if (!alert) return { state: 'superseded', reason: 'invalid_notification_payload' };
  const delivery = await dependencies.notify(alert);
  // This is the single durable retry for a confirmed 429. Further attempts
  // would turn an operator notification into an unbounded side effect.
  return {
    state: 'completed',
    notificationDelivery: { alertKey: alert.key, delivery },
  };
}

async function processArticle(job, context) {
  const {
    store, dependencies, limits, deploymentId, ensureWriteOwnership, deadlineAt, now, consumeApiRequest, fixtureCache,
  } = context;
  const snapshots = [];
  const repairs = [];
  let article = null;
  let sourceVersionValue = job.sourceVersion || null;
  const verificationOnly = job.verificationOnly === true;
  const deliveryOnly = job.deliveryOnly === true;
  let mediaPending = null;

  if (job.kind === 'report_generation') return processReportGeneration(job, context);
  if (job.kind === 'prediction_generation') return processPredictionGeneration(job, context);
  if (job.kind === 'notification_delivery') return processNotificationDelivery(job, context);

  // A pre-release queue format did not persist articleId for this job kind.
  // It cannot be mapped back safely, so retire only that monitor-owned stale
  // entry without touching editorial data or generating a false alert.
  if (job.kind === 'article_validation' && !job.articleId) {
    return { state: 'superseded', reason: 'legacy_article_target_missing', repairs: [] };
  }

  // A production-deployment validation must run from the deployment which is
  // actually serving it. If traffic moved again, leave the old work behind and
  // let the newer deployment event create its own representative checks.
  if (job.deploymentId && deploymentId && job.deploymentId !== deploymentId) {
    return { state: 'superseded', reason: 'deployment_changed' };
  }

  if (job.kind === 'notion_page' || job.kind === TRANSIENT_BROWSER_RUNTIME_RECOVERY_KIND) {
    // A runtime-recovery job must re-read the exact held Notion page. It must
    // not short-circuit through a local record, because that is the record
    // whose same-version delivery hold is being assessed.
    const persistedArticle = job.kind === 'notion_page'
      ? await readCurrentPersistedNotionPage(job, dependencies)
      : null;
    const alreadyDelivered = job.kind === 'notion_page'
      ? await deliveredNotionPagePreflight(job, dependencies, persistedArticle)
      : null;
    if (alreadyDelivered) return alreadyDelivered;
    // Fixture retries commonly outlive the first source mirror. Reusing that
    // exact public revision avoids downloading the same Notion body and block
    // tree on every retry, while still running the full provider association
    // and reader-visible availability verification below. A missing body or
    // incomplete card identity deliberately falls back to a fresh Notion read.
    if (persistedArticle && normalisedBody(persistedArticle.body) && hasReusableMatchIdentity(persistedArticle)) {
      article = persistedArticle;
      sourceVersionValue = sourceVersion(article) || sourceVersionValue;
      repairs.push({ kind: 'persisted_source_association', articleId: article.id, sourceVersion: sourceVersionValue });
    } else {
      const sync = await syncPageArticle(job, { ...context, snapshots, deploymentId });
      if (sync.outcome === 'time_budget_exhausted') return { state: 'deferred_budget', reason: sync.outcome, details: sync };
      if (TRANSIENT_OUTCOMES.has(sync.outcome)) return { state: 'retryable', reason: sync.outcome, details: sync };
      if (sync.outcome === 'source_changed') {
        if (sync.page?.id && sync.sourceVersion) {
          await store.enqueue({
            kind: 'notion_page', pageId: sync.page.id, sourceType: sync.sourceType,
            sourceVersion: sync.sourceVersion,
            // A newer editor version must remain in the same source-owned
            // delivery lane.  Dropping these fields here would send an already
            // safe backfill job through the legacy browser/rollback path.
            deliveryOnly: job.deliveryOnly === true,
            repairGeneration: job.repairGeneration || null,
            trigger: 'superseded', priority: job.priority,
          });
        }
        return { state: 'superseded', details: sync };
      }
      if (sync.outcome === 'usage_limit') return { state: 'quota_exceeded', details: sync };
      if (sync.outcome === 'quota_exceeded') return { state: 'quota_exceeded', details: sync };
      if (sync.outcome === 'deployment_changed') return { state: 'superseded', details: sync };
      if (MANUAL_REVIEW_OUTCOMES.has(sync.outcome)) return { state: 'manual_review', reason: sync.outcome, details: sync };
      if (sync.outcome === 'non_public' || sync.outcome === 'hidden') return { state: 'completed', article: null, repairs, details: sync };
      article = sync.article || await dependencies.getArticle(sync.articleId, { includeHidden: true });
      sourceVersionValue = sync.sourceVersion || sourceVersionValue || sourceVersion(article);
      if (['created', 'updated', 'reindexed'].includes(sync.outcome)) repairs.push({ kind: 'article_sync', outcome: sync.outcome, articleId: article?.id || null });
    }
  } else if (job.kind === 'article_validation') {
    article = await dependencies.getArticle(job.articleId, { includeHidden: true });
    sourceVersionValue = sourceVersion(article);
    if (!article) return { state: 'manual_review', reason: 'article_missing' };
  } else {
    return { state: 'manual_review', reason: 'unsupported_job' };
  }

  if (!article || article.public === false) return { state: 'completed', article, repairs };
  let fixture = null;
  if (MATCH_TYPES.has(article.type)) {
    const alreadyLinkedFixtureId = job.kind === 'article_validation' && deliveryOnly
      ? verifiedPersistedFixtureId(article)
      : null;
    if (alreadyLinkedFixtureId) {
      const alreadyDelivered = await inspectDelivery(
        article,
        { id: alreadyLinkedFixtureId },
        dependencies,
        { requireMedia: false },
      );
      if (!alreadyDelivered.issues.length) {
        return {
          state: 'completed', article, fixture: { id: alreadyLinkedFixtureId }, repairs,
          delivery: alreadyDelivered, sourceVersion: sourceVersionValue,
        };
      }
    }
    if (!canStartWork(deadlineAt, now, MIN_FIXTURE_STEP_MS)) {
      return { state: 'deferred_budget', reason: 'time_budget_exhausted', article, repairs, sourceVersion: sourceVersionValue };
    }
    const resolution = await dependencies.resolveFixture(article, {
      getFixture: dependencies.getFixture,
      fixtureCache,
      recoverConflictingFixtureId: true,
    });
    if (resolution.state === 'source_unavailable') return { state: 'retryable', reason: 'fixture_source_unavailable', details: resolution };
    if (resolution.state !== 'resolved') {
      // An absent or not-yet-listed provider fixture is not evidence that the
      // Notion article is invalid. Keep the published mirror and let the
      // bounded queue retry; a later reconciliation generation retries only
      // unresolved rows rather than silently making a reader see a 404.
      if (deliveryOnly && ['not_found', 'fixture_missing', 'ambiguous', 'insufficient_identity'].includes(resolution.state)) {
        return { state: 'association_pending', reason: resolution.state, details: resolution, article, sourceVersion: sourceVersionValue };
      }
      return { state: 'manual_review', reason: resolution.state, details: resolution, article };
    }
    fixture = resolution.fixture;
    // Manual deployment rechecks deliberately prove the reader-visible output
    // without bypassing the per-version repair ceiling through a new job id.
    // Normal cron/webhook/deployment jobs keep the limited write path below.
    if (!verificationOnly) {
      const associated = dependencies.associationRepair(article, fixture);
      if (associated && !sameArticle(associated, article)) {
        const saved = await saveGuardedArticle({
          article: associated, expected: article, sourceVersion: sourceVersionValue,
          job, store, dependencies, limits, snapshots, ensureWriteOwnership,
          deadlineAt, now,
        });
        if (saved.state === 'quota_exceeded') return { state: 'quota_exceeded', details: saved, article };
        if (saved.state === 'source_changed') return { state: 'superseded', details: saved, article };
        if (saved.state === 'deferred_budget') return { state: 'deferred_budget', reason: 'time_budget_exhausted', article, fixture, repairs, snapshots, sourceVersion: sourceVersionValue };
        if (saved.state === 'written') {
          article = associated;
          repairs.push({ kind: 'fixture_association', fixtureId: fixture.id, method: resolution.method });
        }
      }

      let enriched;
      if (!canStartWork(deadlineAt, now, deliveryOnly ? 5_000 : MIN_MEDIA_STEP_MS)) {
        if (deliveryOnly) {
          mediaPending = { reason: 'time_budget_exhausted' };
        } else {
          return { state: 'deferred_budget', reason: 'time_budget_exhausted', article, fixture, repairs, snapshots, sourceVersion: sourceVersionValue };
        }
      }
      if (!mediaPending) {
        try {
          enriched = await hydrateForMedia(article, fixture, dependencies);
        } catch (error) {
          // A portrait/lineup lookup is additive. It must never erase or roll
          // back a validated Notion body, its fixture link, or the authored
          // MOTM/POTM text. A future reconciliation can enrich it safely.
          if (deliveryOnly) {
            mediaPending = { reason: 'player_media_source_unavailable' };
            enriched = article;
          } else {
            return { state: 'retryable', reason: 'player_media_source_unavailable', details: { error: error.message }, article };
          }
        }
      }
      if (enriched && !sameArticle(enriched, article)) {
        const saved = await saveGuardedArticle({
          article: enriched, expected: article, sourceVersion: sourceVersionValue,
          job, store, dependencies, limits, snapshots, ensureWriteOwnership,
          deadlineAt, now,
        });
        if (saved.state === 'quota_exceeded') return { state: 'quota_exceeded', details: saved, article };
        if (saved.state === 'source_changed') return { state: 'superseded', details: saved, article };
        if (saved.state === 'deferred_budget') return { state: 'deferred_budget', reason: 'time_budget_exhausted', article, fixture, repairs, snapshots, sourceVersion: sourceVersionValue };
        if (saved.state === 'written') {
          article = enriched;
          repairs.push({ kind: 'player_media', fixtureId: fixture.id });
          if (article.type === 'match_prediction') {
            try {
              const previous = await dependencies.readStoredPredictionCards(article.id);
              // The card sidecar is reader-facing data too.  It must not be
              // refreshed by a Function which lost its job lease after the
              // article write but before this derived-data write.
              if (!await ensureWriteOwnership()) {
                return {
                  state: 'superseded', reason: 'lease_lost', article, fixture,
                  repairs, snapshots, sourceVersion: sourceVersionValue,
                };
              }
              await dependencies.saveStoredPredictionCards(article, previous);
            } catch (error) {
              return { state: 'retryable', reason: 'player_media_sidecar_unavailable', details: { error: error.message }, article };
            }
          }
        }
      }
    }
  }

  const delivery = await inspectDelivery(article, fixture, dependencies, { requireMedia: !deliveryOnly });
  if (delivery.issues.length) {
    return { state: 'verification_failed', article, fixture, repairs, snapshots, issues: delivery.issues, sourceVersion: sourceVersionValue };
  }
  if (deliveryOnly) {
    return {
      state: 'completed', article, fixture, repairs, delivery,
      ...(mediaPending ? { mediaPending } : {}),
      sourceVersion: sourceVersionValue,
    };
  }
  const browser = await browserInspection(article, fixture, store, dependencies, limits, { deadlineAt, now });
  if (browser.status === 'deferred') {
    return { state: 'deferred_budget', reason: browser.reason || 'time_budget_exhausted', article, fixture, repairs, snapshots, sourceVersion: sourceVersionValue };
  }
  if (browser.status !== 'passed') {
    return {
      state: browser.status === 'failed' ? 'browser_failed' : 'browser_unavailable',
      article, fixture, repairs, snapshots, browser, sourceVersion: sourceVersionValue,
    };
  }
  if (job.trigger === 'report_generation_browser_validation') {
    await updateReportGenerationAudit(store, fixture, {
      browser: 'passed',
      display: 'report_primary_verified',
      browserCheckedAt: nowIso(now),
    }, now);
  }
  if (job.trigger === 'prediction_generation_browser_validation') {
    await updatePredictionGenerationAudit(store, fixture, {
      browser: 'passed',
      display: 'prediction_primary_verified',
      browserCheckedAt: nowIso(now),
    }, now);
  }
  const recoveredTransientBrowserRuntime = job.trigger === 'transient_browser_runtime_recovery';
  if (recoveredTransientBrowserRuntime && article.type === 'match_prediction') {
    await updatePredictionGenerationAudit(store, fixture, {
      classification: 'browser_runtime_interruption_recovered',
      outcome: 'resynced_after_browser_runtime_interruption',
      productionArticleId: article.id,
      sourceVersion: sourceVersionValue,
      fixtureLinked: Number(article.match?.fixtureId) === Number(fixture?.id),
      display: 'prediction_primary_verified',
      browser: 'passed',
      browserCheckedAt: nowIso(now),
    }, now);
  }
  if (recoveredTransientBrowserRuntime && article.type === 'match_report') {
    await updateReportGenerationAudit(store, fixture, {
      classification: 'browser_runtime_interruption_recovered',
      outcome: 'resynced_after_browser_runtime_interruption',
      productionArticleId: article.id,
      sourceVersion: sourceVersionValue,
      fixtureLinked: Number(article.match?.fixtureId) === Number(fixture?.id),
      display: 'report_primary_verified',
      browser: 'passed',
      browserCheckedAt: nowIso(now),
    }, now);
  }
  const generatedPredictionBrowserValidation = job.trigger === 'prediction_generation_browser_validation';
  return {
    state: 'completed', article, fixture, repairs, browser, sourceVersion: sourceVersionValue,
    ...(job.trigger === 'report_generation_browser_validation' ? {
      notification: {
        key: `report-repair:${fixture?.id || article?.match?.fixtureId || article.id}:${sourceVersionValue || article.id}`,
        category: 'repair_success',
        message: 'AM4は試合解説を修復し、本番の実ブラウザー検査まで完了しました。',
        metadata: {
          fixtureId: fixture?.id || article?.match?.fixtureId || null,
          articleId: article.id,
          sourceVersion: sourceVersionValue || null,
        },
      },
    } : generatedPredictionBrowserValidation ? {
      notification: {
        key: `prediction-repair:${fixture?.id || article?.match?.fixtureId || article.id}:${sourceVersionValue || article.id}`,
        category: 'repair_success',
        message: 'AM4は試合予想を修復し、本番の実ブラウザー検査まで完了しました。',
        metadata: {
          fixtureId: fixture?.id || article?.match?.fixtureId || null,
          articleId: article.id,
          sourceVersion: sourceVersionValue || null,
        },
      },
    } : recoveredTransientBrowserRuntime ? {
      notification: {
        key: `browser-runtime-recovery:${fixture?.id || article?.match?.fixtureId || article.id}:${sourceVersionValue || article.id}`,
        category: 'repair_success',
        message: `AM4は${article.type === 'match_report' ? '試合解説' : '試合予想'}をブラウザー実行停止から復旧し、本番の実ブラウザー検査まで完了しました。`,
        metadata: {
          fixtureId: fixture?.id || article?.match?.fixtureId || null,
          articleId: article.id,
          sourceVersion: sourceVersionValue || null,
        },
      },
    } : {}),
  };
}

async function enqueueLegacyTransientBrowserRuntimeRecoveries(store, dependencies) {
  if (typeof store.findBlockedTransientBrowserValidationJobs !== 'function') {
    return { state: 'not_supported', candidates: 0, queued: 0, jobIds: [] };
  }
  const recoveryState = await store.readState();
  const prior = recoveryState.value?.browserRuntimeRecovery;
  const processedLegacyJobIds = prior?.generation === TRANSIENT_BROWSER_RUNTIME_RECOVERY_GENERATION
    && Array.isArray(prior.processedLegacyJobIds)
    ? prior.processedLegacyJobIds
    : [];
  const legacy = await store.findBlockedTransientBrowserValidationJobs({
    limit: 20,
    excludeJobIds: processedLegacyJobIds,
  });
  const jobIds = [];
  const inspectedLegacyJobIds = [];
  const failedLegacyJobIds = [];
  for (const validation of legacy.jobs || []) {
    let article;
    try {
      article = await dependencies.getArticle(validation.articleId, { includeHidden: true });
    } catch {
      // Do not record source/storage outages as inspected. The next
      // deployment validation must retain this exact candidate for a bounded
      // retry rather than incorrectly declaring it reconciled.
      failedLegacyJobIds.push(validation.id);
      continue;
    }
    // The legacy terminal job itself is immutable. Once its current article
    // has been read and either queued or ruled out by the exact-version
    // checks below, remember it so later Production deployments advance to
    // older candidates instead of repeatedly selecting the same newest page.
    inspectedLegacyJobIds.push(validation.id);
    const pageId = String(article?.notion?.pageId || '').trim();
    const sourceVersionValue = sourceVersion(article);
    const hold = article?.siteMonitor?.deliveryHold;
    if (
      !article
      || article.public !== false
      || !MATCH_TYPES.has(article.type)
      || article.type !== validation.sourceType
      || !pageId
      || !sourceVersionValue
      || sourceVersionValue !== validation.sourceVersion
      || hold?.reason !== 'browser_validation_failed'
      || hold?.sourceVersion !== sourceVersionValue
    ) continue;
    try {
      const queued = await store.enqueue({
        kind: TRANSIENT_BROWSER_RUNTIME_RECOVERY_KIND,
        pageId,
        articleId: article.id,
        sourceType: article.type,
        sourceVersion: sourceVersionValue,
        repairGeneration: TRANSIENT_BROWSER_RUNTIME_RECOVERY_GENERATION,
        trigger: 'transient_browser_runtime_recovery',
        priority: 99,
        payload: {
          releaseMonitorDeliveryHold: true,
          legacyValidationJobId: validation.id,
        },
      });
      if (queued.enqueued && queued.job?.id) jobIds.push(queued.job.id);
    } catch {
      // A queue-write failure is not a completed migration. Remove this
      // candidate from the local inspected list so it remains eligible on the
      // next deployment validation.
      inspectedLegacyJobIds.pop();
      failedLegacyJobIds.push(validation.id);
    }
  }
  if (inspectedLegacyJobIds.length) {
    await store.updateState((current) => {
      const currentRecovery = current.browserRuntimeRecovery;
      const alreadyProcessed = currentRecovery?.generation === TRANSIENT_BROWSER_RUNTIME_RECOVERY_GENERATION
        && Array.isArray(currentRecovery.processedLegacyJobIds)
        ? currentRecovery.processedLegacyJobIds
        : [];
      return {
        ...current,
        browserRuntimeRecovery: {
          generation: TRANSIENT_BROWSER_RUNTIME_RECOVERY_GENERATION,
          processedLegacyJobIds: [...new Set([...alreadyProcessed, ...inspectedLegacyJobIds])].slice(-500),
        },
      };
    });
  }
  return {
    state: jobIds.length ? 'queued' : 'already_reconciled',
    candidates: (legacy.jobs || []).length,
    queued: jobIds.length,
    jobIds,
    failedLegacyJobIds,
  };
}

async function processDeploymentValidation(job, context) {
  const { dependencies, store, deploymentId } = context;
  if (job.deploymentId && deploymentId && job.deploymentId !== deploymentId) {
    return { state: 'superseded', reason: 'deployment_changed', repairs: [] };
  }
  const result = await dependencies.listArticles({ page: 1, pageSize: 100, publishedOnly: true });
  const rows = Array.isArray(result?.items) ? result.items : [];
  const candidates = [];
  // A finished-match report is the reader-facing primary surface after full
  // time, so validate it first when a Production deployment changes. The
  // remaining source types are still queued below; this ordering only picks
  // which single representative document a bounded webhook worker may check
  // immediately.
  for (const type of ['match_report', 'match_prediction', 'am4_story']) {
    const article = rows.find((item) => item?.type === type && item.public !== false);
    if (article) candidates.push(article);
  }
  const validationJobIds = [];
  for (const article of candidates) {
    const queued = await store.enqueue({
      kind: 'article_validation', articleId: article.id, sourceType: article.type,
      sourceVersion: sourceVersion(article), deploymentId: job.deploymentId,
      validationId: job.validationId || null,
      verificationOnly: job.verificationOnly === true,
      trigger: job.verificationOnly ? 'manual_deployment_recheck' : 'production_deployment', priority: 80,
    });
    if (queued.job?.id) validationJobIds.push(queued.job.id);
  }
  // This migration is bound to a Production deployment validation rather than
  // a reader request or arbitrary repair endpoint. It reopens only legacy
  // jobs whose private article is still held at exactly the same Notion
  // version, then the normal synchronizer and browser verifier own the rest.
  const transientBrowserRuntimeRecovery = await enqueueLegacyTransientBrowserRuntimeRecoveries(store, dependencies);
  return {
    state: 'completed',
    deploymentValidation: candidates.map((article) => article.id),
    validationJobIds,
    transientBrowserRuntimeRecovery,
    repairs: [],
  };
}

async function handleResult(job, result, context) {
  const { store, dependencies, limits, owner, ensureWriteOwnership, now = () => new Date() } = context;
  // Do not let an expired worker perform a deferred write, a rollback, or a
  // terminal queue transition after a replacement worker has reclaimed it.
  if (!await store.renewLease(job.id, owner, limits.jobLeaseMs)) {
    return { status: 'lease_lost', result };
  }
  if (result.state === 'completed' || result.state === 'superseded') {
    const finished = await store.finishJob(job.id, { owner, status: 'completed', result });
    if (!finished) return { status: 'lease_lost', result };
    let notificationDelivery = null;
    if (result.notificationDelivery?.alertKey) {
      notificationDelivery = await store.markAlertDelivery(
        result.notificationDelivery.alertKey,
        result.notificationDelivery.delivery,
      );
    }
    let notification = null;
    if (result.state === 'completed' && result.notification) {
      notification = await alert(store, dependencies, {
        key: result.notification.key,
        status: 'resolved',
        category: result.notification.category || 'repair_success',
        message: result.notification.message || 'AM4の自動修復が完了しました。',
        metadata: result.notification.metadata || {},
      }, { now });
    }
    return {
      status: 'completed', result,
      ...(notification ? { notification } : {}),
      ...(notificationDelivery ? { notificationDelivery } : {}),
    };
  }
  // A code-owned legacy runtime recovery has one narrow public window: after
  // it mirrors the exact held source version and before its real browser
  // check passes. Any non-success result after that mirror—fixture/source
  // retry, delivery assertion, browser outage, or time budget—must restore
  // the hold first. This does not apply to ordinary public article validation.
  if (job.kind === TRANSIENT_BROWSER_RUNTIME_RECOVERY_KIND) {
    const hold = await restoreTransientBrowserRecoveryHold(job, result, context);
    result = { ...result, rolledBack: hold.rolledBack || [] };
    if (hold.state !== 'held') {
      const finished = await store.finishJob(job.id, {
        owner,
        status: 'blocked',
        result,
        error: hold.reason || 'browser_runtime_recovery_hold_incomplete',
      });
      if (!finished) return { status: 'lease_lost', result };
      await alert(store, dependencies, {
        key: `browser-runtime-hold:${job.id}`, category: 'persistent_public_impact',
        message: 'AM4監視は再検査停止後の配信保留を安全に復元できませんでした。',
        metadata: {
          jobId: job.id,
          articleId: result.article?.id || job.articleId || null,
          reason: hold.reason || null,
          rolledBack: hold.rolledBack || [],
        },
      });
      return { status: 'blocked', result };
    }
  }
  // The caller deliberately stopped before the serverless deadline. This is
  // not an external failure and must not consume a transport retry; the
  // unmodified durable job simply becomes eligible for a later worker.
  if (result.state === 'deferred_budget') {
    const deferred = await store.deferJob(job.id, {
      owner,
      reason: result.reason || 'time_budget_exhausted',
      delayMs: 60_000,
    });
    if (!deferred) return { status: 'lease_lost', result };
    return { status: 'deferred', result };
  }
  if (result.state === 'retryable') {
    if (job.transportRetries < limits.maxTransportRetries) {
      const deferred = await store.deferJob(job.id, {
        owner,
        reason: result.reason,
        delayMs: retryDelay(job.transportRetries, result.details?.retryAfterMs),
        transportRetry: true,
      });
      if (!deferred) return { status: 'lease_lost', result };
      return { status: 'deferred', result };
    }
    const finished = await store.finishJob(job.id, { owner, status: 'blocked', result, error: result.reason });
    if (!finished) return { status: 'lease_lost', result };
    await alert(store, dependencies, {
      key: `transport:${job.id}`, category: 'external_connection',
      message: `AM4監視の外部接続が復旧しません: ${result.reason}`,
      metadata: { jobId: job.id, pageId: job.pageId || null, articleId: result.article?.id || null },
    });
    return { status: 'blocked', result };
  }
  if (result.state === 'quota_exceeded') {
    // A daily cap is a pause, not a terminal editorial failure. Preserve the
    // exact source-version job until the relevant counter resets; a per-run
    // cap resumes on the next worker instead. No repair/write retry is spent.
    const deferred = await store.deferJob(job.id, {
      owner,
      reason: 'usage_limit',
      delayMs: quotaRetryDelay(result, now),
    });
    if (!deferred) return { status: 'lease_lost', result };
    await alert(store, dependencies, {
      key: 'usage_limit', category: 'usage_limit',
      message: 'AM4監視は設定済みの利用量上限に達したため、安全に停止しました。',
      metadata: { jobId: job.id },
    });
    return { status: 'deferred', result };
  }
  if (result.state === 'association_pending') {
    const nextRepairAttempt = job.repairAttempts + 1;
    if (nextRepairAttempt < limits.maxRepairAttemptsPerVersion) {
      const deferred = await store.deferJob(job.id, {
        owner,
        reason: result.reason || 'fixture_unresolved',
        delayMs: 5 * 60_000,
        repairAttempts: nextRepairAttempt,
      });
      if (!deferred) return { status: 'lease_lost', result };
      return { status: 'deferred', result };
    }
    // The source-valid body is already durable. Do not turn a provider fixture
    // delay into an article deletion or a false 404: a later date-scoped
    // reconciliation generation is the bounded next attempt.
    const finished = await store.finishJob(job.id, {
      owner,
      status: 'blocked',
      result,
      error: result.reason || 'fixture_unresolved',
      repairAttempts: nextRepairAttempt,
    });
    if (!finished) return { status: 'lease_lost', result };
    await alert(store, dependencies, {
      key: `fixture:${job.id}`, category: 'fixture_association',
      message: 'AM4試合解説のfixture紐付けをまだ安全に確定できませんでした。記事本文は保持し、補完同期で再試行します。',
      metadata: { jobId: job.id, articleId: result.article?.id || null, reason: result.reason || null },
    });
    return { status: 'blocked', result };
  }
  if (result.state === 'verification_failed' || result.state === 'browser_failed') {
    if (job.deliveryOnly) {
      const nextRepairAttempt = job.repairAttempts + 1;
      if (nextRepairAttempt < limits.maxRepairAttemptsPerVersion) {
        const deferred = await store.deferJob(job.id, {
          owner,
          reason: result.state,
          delayMs: 60_000,
          repairAttempts: nextRepairAttempt,
        });
        if (!deferred) return { status: 'lease_lost', result };
        return { status: 'deferred', result };
      }
      // A verified Notion page has already been mirrored. Preserve it even if
      // a derived availability/index assertion is temporarily unavailable;
      // this durable state is explicitly revisited by the reconciliation scan.
      const finished = await store.finishJob(job.id, {
        owner,
        status: 'blocked',
        result,
        error: result.state,
        repairAttempts: nextRepairAttempt,
      });
      if (!finished) return { status: 'lease_lost', result };
      await alert(store, dependencies, {
        key: `delivery:${job.id}`, category: 'persistent_public_impact',
        message: 'AM4試合解説の配信検証が完了しませんでした。記事本文は保持し、補完同期で再試行します。',
        metadata: { jobId: job.id, articleId: result.article?.id || null, issues: result.issues || [] },
      });
      return { status: 'blocked', result };
    }
    // A visual mismatch can be a short-lived public-delivery race (for
    // example, an edge response that has not caught up with a just-written
    // mirror), even when this particular validation job made no write. Give
    // every source-version exactly one bounded cold-browser recheck before
    // raising a durable failure. The same counter also caps actual repair
    // writes, so this cannot turn a deployment check into an infinite loop.
    const nextRepairAttempt = job.repairAttempts + 1;
    if (nextRepairAttempt < limits.maxRepairAttemptsPerVersion) {
      const deferred = await store.deferJob(job.id, {
        owner,
        reason: result.state,
        delayMs: 60_000,
        repairAttempts: nextRepairAttempt,
      });
      if (!deferred) return { status: 'lease_lost', result };
      return { status: 'deferred', result };
    }
    // Snapshots are attached to the durable job record as well as the current
    // in-memory result. A generated source job may have made its guarded
    // write before it created this separate browser-validation job, so include
    // only the code-owned, version-checked lineage persisted by that worker.
    // A browser failure can be retried in a new Function, so the final bounded
    // rollback must include writes from every attempt.
    const [persistedSnapshots, lineageSnapshots] = await Promise.all([
      store.readSnapshots(job.id),
      linkedBrowserValidationSnapshots(job, store),
    ]);
    const snapshots = [...new Map(
      [...persistedSnapshots, ...lineageSnapshots, ...(result.snapshots || [])].map((snapshot) => [snapshot.id, snapshot]),
    ).values()];
    const rolledBack = snapshots.length
      ? await rollbackSnapshots(
        snapshots,
        result.sourceVersion || job.sourceVersion,
        dependencies,
        ensureWriteOwnership,
        { holdCreatedArticle: true },
      )
      : [];
    if (job.trigger === 'report_generation_browser_validation') {
      await updateReportGenerationAudit(store, result.fixture, {
        outcome: 'browser_validation_failed',
        display: 'report_pending',
        browser: 'failed',
        browserValidationJobId: job.id,
        rolledBack,
      }, now);
    }
    if (job.trigger === 'prediction_generation_browser_validation') {
      await updatePredictionGenerationAudit(store, result.fixture, {
        outcome: 'browser_validation_failed',
        display: 'prediction_pending',
        browser: 'failed',
        browserValidationJobId: job.id,
        rolledBack,
      }, now);
    }
    const finished = await store.finishJob(job.id, {
      owner,
      status: 'blocked', result: { ...result, rolledBack }, error: result.state,
      repairAttempts: nextRepairAttempt,
    });
    if (!finished) return { status: 'lease_lost', result };
    await alert(store, dependencies, {
      key: `verification:${job.id}`, category: 'persistent_public_impact',
      message: `AM4監視は自動修復後の再検査に合格できませんでした: ${result.state}`,
      metadata: { jobId: job.id, articleId: result.article?.id || null, issues: result.issues || [], rolledBack },
    });
    return { status: 'blocked', result: { ...result, rolledBack } };
  }
  const browserUnavailableResult = result;
  // A missing browser runtime is never silently upgraded to success. It is a
  // distinct operator action, and does not trigger a destructive rollback of
  // verified article data merely because visual inspection could not start.
  // A daily browser launch cap is different: it is an intentional, bounded
  // scheduling hold. Keep the same job/version and resume at JST midnight;
  // do not consume a repair attempt, block a verified article, or mistake the
  // cap for a missing Chromium runtime.
  if (result.state === 'browser_unavailable' && result.browser?.reason === 'browser_quota_exceeded') {
    const deferred = await store.deferJob(job.id, {
      owner,
      reason: 'browser_usage_limit',
      delayMs: nextTokyoMidnightDelay(now),
    });
    if (!deferred) return { status: 'lease_lost', result: browserUnavailableResult };
    return { status: 'deferred', result: browserUnavailableResult };
  }
  // A Playwright/Chromium process disconnect is not evidence that the public
  // document failed its assertions. Give this explicit runtime class one
  // cold recheck, then retain the article and surface a runtime alert rather
  // than rolling back editor-verified content. Selector/assertion timeouts
  // remain in the browser_failed branch above.
  if (
    result.state === 'browser_unavailable'
    && result.browser?.reason === 'browser_runtime_unavailable'
    && result.browser?.runtimeFailure === TRANSIENT_BROWSER_RUNTIME_FAILURE
  ) {
    const nextRepairAttempt = job.repairAttempts + 1;
    if (nextRepairAttempt < limits.maxRepairAttemptsPerVersion) {
      const deferred = await store.deferJob(job.id, {
        owner,
        reason: 'browser_runtime_interrupted',
        delayMs: 60_000,
        repairAttempts: nextRepairAttempt,
      });
      if (!deferred) return { status: 'lease_lost', result: browserUnavailableResult };
      return { status: 'deferred', result: browserUnavailableResult };
    }
  }
  if (result.state === 'browser_unavailable') {
    const finished = await store.finishJob(job.id, {
      owner,
      status: 'blocked',
      result: browserUnavailableResult,
      error: result.browser?.reason || 'browser_unavailable',
    });
    if (!finished) return { status: 'lease_lost', result: browserUnavailableResult };
    await alert(store, dependencies, {
      key: 'browser_runtime', category: 'browser_runtime',
      message: 'AM4監視の実ブラウザー再検査を実行できませんでした。',
      metadata: { jobId: job.id, articleId: result.article?.id || null, reason: result.browser?.reason || null },
    });
    return { status: 'blocked', result: browserUnavailableResult };
  }
  const finished = await store.finishJob(job.id, { owner, status: 'blocked', result, error: result.reason || result.state });
  if (!finished) return { status: 'lease_lost', result };
  await alert(store, dependencies, {
    key: `review:${job.id}`, category: 'manual_review',
    message: `AM4監視は人の判断が必要な状態を検出しました: ${result.reason || result.state}`,
    metadata: { jobId: job.id, pageId: job.pageId || null, articleId: result.article?.id || null },
  });
  return { status: 'blocked', result };
}

async function collectJobs(
  store,
  dependencies,
  settings,
  now,
  deadlineAt = null,
  consumeApiRequest = null,
  { fullReconciliation = false, editorialOnly = false } = {},
) {
  const state = await store.readState();
  const observedAt = nowIso(now);
  // A source-wide editorial scan is authoritative for each missing type. Do
  // not simultaneously feed that same source through the delta collector:
  // it would schedule two differently keyed reads of every Notion page. A
  // type already fully scanned continues to receive ordinary delta updates,
  // except for a dedicated editorial-only recovery worker.
  const fullMatchEditorialScanTypes = fullReconciliation
    ? matchEditorialBackfillTypesNeedingScan(state.value)
    : [];
  const deltaTypes = ['match_prediction', 'match_report', 'am4_story']
    .filter((type) => !fullMatchEditorialScanTypes.includes(type));
  const queued = [];
  const queuedVersions = new Set();
  const enqueueCollectedPage = async (sourceType, page) => {
    const version = page?.last_edited_time || page?.created_time || null;
    const pageId = String(page?.id || '').trim();
    if (!pageId || !version) return;
    const key = `${sourceType}|${pageId}|${version}`;
    if (queuedVersions.has(key)) return;
    queuedVersions.add(key);
    const item = await store.enqueue({
      kind: 'notion_page', pageId, sourceType, sourceVersion: version,
      // The durable source mirror and fixture association must not wait for
      // a browser launch. A visual monitor run remains a separate job.
      deliveryOnly: true, trigger: 'cron', priority: 10,
    });
    if (item.enqueued) queued.push(item.job.id);
  };
  const collected = editorialOnly
    ? { sources: {}, errors: {}, deferred: {}, retryAfterMs: {}, quotaExceeded: null }
    : await dependencies.collectChanges({
      checkpoints: state.value.collector?.checkpoints || {},
      notBeforeBySource: state.value.collector?.notBefore || {},
      cursors: state.value.collector?.cursors || {},
      ...(fullMatchEditorialScanTypes.length ? { types: deltaTypes } : {}),
      observedAt,
      deadlineAt,
      consumeRequest: consumeApiRequest,
      onPage: async ({ sourceType, pages, nextCursor, complete, since }) => {
        // Persist rows before their continuation cursor. If this invocation
        // stops between the two operations, re-enqueueing the page is harmless;
        // the source-version queue identity deduplicates it.
        for (const page of pages || []) await enqueueCollectedPage(sourceType, page);
        await store.updateState((current) => {
          const cursors = { ...(current.collector?.cursors || {}) };
          if (complete) delete cursors[sourceType];
          else if (nextCursor) {
            cursors[sourceType] = {
              cursor: nextCursor,
              since: since || null,
              updatedAt: nowIso(now),
            };
          }
          return {
            ...current,
            collector: { ...(current.collector || {}), cursors },
          };
        });
      },
    });
  for (const [sourceType, source] of Object.entries(collected.sources || {})) {
    // Custom test/migration collectors that predate the page callback still
    // use this fallback. The standard collector has already queued these rows.
    for (const page of source.pages || []) await enqueueCollectedPage(sourceType, page);
  }
  // Commit only complete source scans. A source error leaves its old
  // checkpoint intact, so a later run repeats rather than skipping edits.
  await store.updateState((current) => {
    const currentNotBefore = current.collector?.notBefore || {};
    const currentCursors = current.collector?.cursors || {};
    const observedAtMs = Date.parse(observedAt);
    const completedSources = new Set(Object.keys(collected.sources || {}));
    const retainedNotBefore = Object.fromEntries(Object.entries(currentNotBefore).filter(([type, value]) => (
      !completedSources.has(type) && Date.parse(value || '') > observedAtMs
    )));
    const retryNotBefore = Object.fromEntries(Object.entries(collected.retryAfterMs || {}).map(([type, delayMs]) => [
      type,
      new Date(observedAtMs + Math.max(1_000, Number(delayMs) || 0)).toISOString(),
    ]));
    return {
      ...current,
      collector: {
        ...current.collector,
        checkpoints: {
          ...(current.collector?.checkpoints || {}),
          ...Object.fromEntries(Object.entries(collected.sources || {}).map(([type, source]) => [type, {
            watermark: source.watermark,
            collectedAt: source.collectedAt,
          }])),
        },
        notBefore: { ...retainedNotBefore, ...retryNotBefore },
        // Retain a cursor only for a source that did not complete. A complete
        // scan writes its checkpoint below, so replaying its old cursor would
        // be both unnecessary and potentially skip a later delta.
        cursors: Object.fromEntries(Object.entries(currentCursors).filter(([type]) => !completedSources.has(type))),
      },
    };
  });
  for (const sourceType of Object.keys(collected.errors || {})) {
    if (collected.errors[sourceType] === 'quota_exceeded') continue;
    await alert(store, dependencies, {
      key: `notion:${sourceType}`, category: 'external_connection',
      message: `AM4監視はNotionデータソースを収集できませんでした: ${sourceType}`,
      metadata: { sourceType },
    });
  }

  let backfill = { state: 'not_requested', queued: 0 };
  let reconciliation = { state: 'not_requested', queued: 0 };
  if (fullReconciliation) {
    try {
      backfill = await queueMatchEditorialBackfill({
        store,
        collectSourcePages: dependencies.collectFullSourcePages,
        now,
        deadlineAt,
        consumeRequest: consumeApiRequest,
      });
      // Each completed full source scan has observed every current page for
      // that type. Seed only that type's normal delta checkpoint from its
      // conservative scan-start watermark, so the next run sees overlap/new
      // edits rather than independently re-reading the whole collection.
      for (const [type, outcome] of Object.entries(backfill.types || {})) {
        if (outcome.state !== 'queued' || !outcome.complete || !outcome.watermark) continue;
        await store.updateState((current) => {
          const cursors = { ...(current.collector?.cursors || {}) };
          const notBefore = { ...(current.collector?.notBefore || {}) };
          delete cursors[type];
          delete notBefore[type];
          return {
            ...current,
            collector: {
              ...(current.collector || {}),
              checkpoints: {
                ...(current.collector?.checkpoints || {}),
                [type]: { watermark: outcome.watermark, collectedAt: nowIso(now) },
              },
              cursors,
              notBefore,
            },
          };
        });
      }
      // Do not add a second job generation for rows the full scan just
      // queued. Once all source scans are complete, later Cron runs revisit
      // only genuinely unlinked stored predictions/reports.
      if (backfill.state === 'already_scanned') {
        reconciliation = await queueUnlinkedMatchEditorialReconciliation({
          store,
          listArticles: dependencies.listArticles,
          now,
        });
      }
    } catch (error) {
      backfill = { state: 'unavailable', queued: 0, error: error.message };
      await alert(store, dependencies, {
        key: 'notion:match_editorial_backfill', category: 'external_connection',
        message: 'AM4試合予想・試合解説の全件再照合を開始または再開できませんでした。',
        metadata: { error: error.message },
      });
    }
  }
  return {
    collected,
    queued,
    backfill,
    reconciliation,
    quotaExceeded: collected.quotaExceeded || (backfill.state === 'quota_exceeded' ? { exceeded: 'apiCalls' } : null),
  };
}

function renewalIntervalMs(settings) {
  const shortest = Math.min(settings.lockTtlMs, settings.jobLeaseMs);
  return Math.min(60_000, Math.max(5_000, Math.floor(shortest / 3)));
}

// Keep both the global editorial writer lock and the individual job lease
// alive while a provider/browser call is in flight. A Function crash simply
// leaves these records to expire; a stale Function is never allowed to finish
// or roll back a job after ownership moves to another runner.
async function processWithRenewals(job, context) {
  const { store, limits } = context;
  let activeLock = context.lock;
  let ownershipLost = false;
  let renewal = Promise.resolve();
  const renew = async () => {
    if (ownershipLost) return;
    try {
      const [lease, lock] = await Promise.all([
        store.renewLease(job.id, activeLock.owner, limits.jobLeaseMs),
        store.renewLock(activeLock, limits.lockTtlMs),
      ]);
      if (!lease || !lock) {
        ownershipLost = true;
        return;
      }
      activeLock = lock;
    } catch {
      ownershipLost = true;
    }
  };
  // All reader-facing writes (including a targeted rollback) pass through
  // this serial renewal gate. It refreshes both durable ownership records
  // immediately before the write rather than trusting a timer tick from an
  // earlier provider/browser operation.
  const ensureWriteOwnership = async () => {
    if (ownershipLost) return false;
    renewal = renewal.then(renew, renew);
    await renewal;
    return !ownershipLost;
  };
  context.ensureWriteOwnership = ensureWriteOwnership;

  await renew();
  if (ownershipLost) return {
    result: { state: 'superseded', reason: 'lease_lost' }, lock: activeLock, ownershipLost: true,
    ensureWriteOwnership, getLock: () => activeLock,
  };
  const timer = setInterval(() => {
    renewal = renewal.then(renew, renew);
  }, renewalIntervalMs(limits));
  try {
    const result = job.kind === 'deployment_validation'
      ? await processDeploymentValidation(job, context)
      : await processArticle(job, context);
    await renewal;
    return {
      result: ownershipLost ? { state: 'superseded', reason: 'lease_lost' } : result,
      lock: activeLock,
      ownershipLost,
      ensureWriteOwnership,
      getLock: () => activeLock,
    };
  } finally {
    clearInterval(timer);
  }
}

export async function runSiteMonitor({
  store,
  trigger = 'cron',
  deploymentId = process.env.VERCEL_DEPLOYMENT_ID || null,
  onlyJobIds = null,
  claimSourceTypes = null,
  claimJobKinds = null,
  excludeSourceTypes = null,
  claimDeliveryOnly = false,
  settings = siteMonitorSettings(),
  dependencies: supplied = {},
  now = () => new Date(),
  collect = trigger === 'cron' || trigger === 'manual',
} = {}) {
  if (!store) throw new Error('A durable site monitor store is required');
  // Vercel's configured Cron path is Production-only. Keep its complete-site
  // visual inspection finite but sufficient even when an inherited runtime
  // setting is lower; the durable daily ledger still enforces this ceiling
  // across invocations and never resets it per deployment or retry.
  if (trigger === 'cron') {
    settings = {
      ...settings,
      maxBrowserLaunchesPerDay: Math.max(
        Number(settings.maxBrowserLaunchesPerDay) || 0,
        MIN_PRIMARY_CRON_BROWSER_LAUNCHES_PER_DAY,
      ),
    };
  }
  const dependencies = { ...defaultDependencies(), ...supplied };
  // Only the dedicated, Cron-authenticated report-generation lane may use a
  // longer Function budget. Every normal monitor/webhook invocation retains
  // the 105-second ceiling even if an environment variable is misconfigured.
  const maxRunBudgetMs = settings.allowExtendedRun === true ? 285_000 : 105_000;
  const runBudgetMs = Math.min(maxRunBudgetMs, Math.max(30_000, Number(settings.maxRunMs) || DEFAULT_SITE_MONITOR_LIMITS.maxRunMs));
  const minJobStartMs = Math.min(runBudgetMs, Math.max(5_000, Number(settings.minJobStartMs) || DEFAULT_SITE_MONITOR_LIMITS.minJobStartMs));
  const maxApiCallsPerRun = Math.min(1_000, Math.max(0, Number.isFinite(Number(settings.maxApiCallsPerRun))
    ? Math.floor(Number(settings.maxApiCallsPerRun))
    : DEFAULT_SITE_MONITOR_LIMITS.maxApiCallsPerRun));
  const startedAtMs = nowMs(now);
  const deadlineAt = startedAtMs + runBudgetMs;
  // Every active HTTP sync path now enters through this durable writer lock.
  // The former full-archive importer is intentionally unreachable from HTTP,
  // so a monitor repair cannot race it with an index/article write.
  let lock = await store.acquireLock({ name: 'editorial-writer', ttlMs: settings.lockTtlMs });
  if (!lock) return { status: 'already_running' };
  const run = await store.beginRun({ trigger, deploymentId });
  const summary = {
    runId: run.id, trigger, deploymentId, collected: null, jobs: [], errors: [],
    timeBudgetExhausted: false,
    timings: {
      startedAt: new Date(startedAtMs).toISOString(),
      deadlineAt: new Date(deadlineAt).toISOString(),
      collectionMs: 0,
      processingMs: 0,
      totalMs: 0,
    },
  };
  try {
    // Restore only historical jobs that an earlier monitor version incorrectly
    // marked terminal when the daily browser budget was exhausted. New jobs
    // take the defer path in `handleResult`; both paths wake at the same JST
    // midnight and preserve all repair/version counters.
    summary.browserQuotaRecovery = typeof store.requeueBlockedBrowserQuotaJobs === 'function'
      ? await store.requeueBlockedBrowserQuotaJobs({
        availableAt: new Date(startedAtMs + nextTokyoMidnightDelay(now)).toISOString(),
      })
      : { requeued: 0, jobIds: [] };
    const usageBefore = (await store.readState()).value.usage;
    let runApiCalls = 0;
    let runProviderRequests = 0;
    // `createNotionClient` invokes this once per real HTTP attempt. This is
    // intentionally shared by collection and every queued page so a paged
    // source or deeply nested body cannot bypass a per-run/day budget.
    const consumeApiRequest = async () => {
      if (runApiCalls >= maxApiCallsPerRun) {
        return {
          ok: false,
          exceeded: 'apiCallsPerRun',
          usage: { apiCalls: runApiCalls },
          requested: { apiCalls: 1 },
        };
      }
      const reservation = await reserve(store, settings, { apiCalls: 1 });
      if (reservation.ok) runApiCalls += 1;
      return reservation;
    };
    const consumeProviderRequest = async () => {
      if (runProviderRequests >= settings.maxProviderRequestsPerRun) {
        return {
          ok: false,
          exceeded: 'providerRequestsPerRun',
          usage: { providerRequests: runProviderRequests },
          requested: { providerRequests: 1 },
        };
      }
      const reservation = await reserve(store, settings, { providerRequests: 1 });
      if (reservation.ok) runProviderRequests += 1;
      return reservation;
    };
    await store.updateState((state) => ({ ...state, lastRun: { id: run.id, startedAt: run.startedAt, trigger, deploymentId } }));
    if (collect) {
      const collectionStartedAt = nowMs(now);
      summary.collected = await collectJobs(store, dependencies, settings, now, deadlineAt, consumeApiRequest, {
        // Regular Cron owns the automatic full-source reconciliation. A
        // dedicated authenticated backfill invocation can use the same safe
        // path, while manual source-page repairs remain strictly targeted.
        fullReconciliation: trigger === 'cron' || trigger === 'match_editorial_backfill' || trigger === 'match_report_backfill',
        // A dedicated recovery must spend its finite Notion allowance solely
        // on the two editorial sources it is repairing. Routine Cron retains
        // the normal all-source delta collector.
        editorialOnly: trigger === 'match_editorial_backfill' || trigger === 'match_report_backfill',
      });
      summary.timings.collectionMs = Math.max(0, nowMs(now) - collectionStartedAt);
      if (summary.collected.quotaExceeded) {
        summary.errors.push('usage_limit');
        await alert(store, dependencies, {
          key: 'usage_limit', category: 'usage_limit',
          message: 'AM4監視は設定済みの利用量上限に達したため、安全に停止しました。',
          metadata: { phase: 'collection' },
        });
      }
      const sourceErrors = Object.entries(summary.collected.collected?.errors || {})
        .filter(([, error]) => error !== 'quota_exceeded')
        .map(([source]) => source);
      if (sourceErrors.length) summary.errors.push(`notion_sources:${sourceErrors.join(',')}`);
    }
    const queueMetadataMigration = claimDeliveryOnly
      ? await migrateClaimQueueMetadata(store, claimSourceTypes, claimJobKinds, now)
      : { state: 'not_required', scanned: 0, migrated: 0 };
    summary.queueMetadataMigration = queueMetadataMigration;
    let ownershipLost = false;
    // Many reports share a date/round. Reuse the same bounded provider
    // response inside this worker instead of issuing identical fixture calls
    // for every source page.
    const fixtureCache = new Map();
    // A full Notion source scan can enqueue all reports immediately before all
    // predictions. Alternate only equal-priority filtered editorial jobs so
    // neither reader-visible content type waits for the other's entire
    // backlog. High-priority webhook/targeted work still wins in the store.
    const editorialSourceTypes = Array.isArray(claimSourceTypes)
      ? [...new Set(claimSourceTypes.filter((type) => MATCH_TYPES.has(type)))]
      : [];
    let nextEditorialSourceIndex = 0;
    const processingStartedAt = nowMs(now);
    while (!ownershipLost && summary.jobs.length < settings.maxJobsPerRun) {
      // Claim only one item at a time. If the current Function is nearly out
      // of budget, untouched work stays queued instead of being leased and
      // then abandoned when Vercel terminates the request.
      if (!canStartWork(deadlineAt, now, minJobStartMs)) {
        summary.timeBudgetExhausted = true;
        break;
      }
      const preferredSourceType = editorialSourceTypes[nextEditorialSourceIndex] || null;
      const claim = await store.claimJobs({
        owner: lock.owner,
        limit: 1,
        leaseMs: settings.jobLeaseMs,
        jobIds: onlyJobIds,
        sourceTypes: claimSourceTypes,
        kinds: claimJobKinds,
        excludeSourceTypes,
        ...(preferredSourceType ? { preferredSourceTypes: [preferredSourceType] } : {}),
        deliveryOnly: claimDeliveryOnly,
      });
      if (!claim.jobs.length) break;
      const [job] = claim.jobs;
      const claimedSourceIndex = editorialSourceTypes.indexOf(job.sourceType);
      if (claimedSourceIndex >= 0) {
        nextEditorialSourceIndex = (claimedSourceIndex + 1) % editorialSourceTypes.length;
      }
      let result;
      try {
        const processed = await processWithRenewals(job, {
          store, dependencies, limits: settings, deploymentId, lock, deadlineAt, now,
          consumeApiRequest, consumeProviderRequest, fixtureCache,
        });
        lock = processed.lock;
        if (processed.ownershipLost) {
          ownershipLost = true;
          summary.jobs.push({ jobId: job.id, fixtureId: job.fixtureId || null, status: 'lease_lost', result: processed.result });
          break;
        }
        result = processed.result;
        const handled = await handleResult(job, result, {
          store, dependencies, limits: settings, owner: lock.owner,
          ensureWriteOwnership: processed.ensureWriteOwnership, now,
        });
        lock = processed.getLock();
        summary.jobs.push({ jobId: job.id, fixtureId: job.fixtureId || null, ...handled });
        if (result.state === 'quota_exceeded' && !summary.errors.includes('usage_limit')) summary.errors.push('usage_limit');
        if (handled.status === 'lease_lost') ownershipLost = true;
      } catch (error) {
        const fallback = { state: 'retryable', reason: 'unexpected_error', details: { error: error.message } };
        const handled = await handleResult(job, fallback, {
          store, dependencies, limits: settings, owner: lock.owner, now,
        });
        summary.jobs.push({ jobId: job.id, fixtureId: job.fixtureId || null, ...handled });
        if (handled.status === 'lease_lost') ownershipLost = true;
      }
    }
    summary.timings.processingMs = Math.max(0, nowMs(now) - processingStartedAt);
    summary.timings.totalMs = Math.max(0, nowMs(now) - startedAtMs);
    if (ownershipLost) summary.errors.push('lease_lost');
    const complete = summary.errors.length === 0 && summary.jobs.every((item) => item.status === 'completed' || item.status === 'deferred');
    await store.updateState((state) => ({
      ...state,
      lastRun: { id: run.id, startedAt: run.startedAt, finishedAt: nowIso(now), trigger, deploymentId, status: complete ? 'completed' : 'attention' },
      ...(complete ? { lastSuccessfulRunAt: nowIso(now) } : {}),
    }));
    const usageAfter = (await store.readState()).value.usage;
    summary.usage = Object.fromEntries(['apiCalls', 'providerRequests', 'browserLaunches', 'repairOperations', 'generations'].map((key) => [key,
      usageAfter.day === usageBefore.day ? Math.max(0, usageAfter[key] - usageBefore[key]) : usageAfter[key],
    ]));
    await store.finishRun(run.id, (value) => ({
      ...value,
      status: complete ? 'completed' : 'attention',
      collected: summary.collected,
      jobs: summary.jobs,
      usage: summary.usage,
      browserQuotaRecovery: summary.browserQuotaRecovery,
      timeBudgetExhausted: summary.timeBudgetExhausted,
      timings: summary.timings,
    }));
    return { status: complete ? 'completed' : 'attention', ...summary };
  } catch (error) {
    summary.errors.push(error.message);
    await store.finishRun(run.id, (value) => ({ ...value, status: 'failed', errors: [...(value.errors || []), error.message] }));
    await alert(store, dependencies, {
      key: 'runner_failure', category: 'monitor_runtime',
      message: 'AM4監視の実行自体が失敗しました。', metadata: { runId: run.id, error: error.message },
    });
    return { status: 'failed', ...summary };
  } finally {
    await store.releaseLock(lock);
  }
}

// The watchdog is a distinct scheduled invocation. It does not assume a
// failed primary runner can notify on its own; it reads the durable heartbeat
// written only after a run reaches its terminal state.
export async function checkSiteMonitorWatchdog({
  store,
  settings = siteMonitorSettings(),
  dependencies: supplied = {},
  now = () => new Date(),
} = {}) {
  if (!store) throw new Error('A durable site monitor store is required');
  const dependencies = { ...defaultDependencies(), ...supplied };
  const state = await store.readState();
  const last = Date.parse(state.value.lastSuccessfulRunAt || '');
  const stale = !Number.isFinite(last) || new Date(now()).getTime() - last > settings.staleAfterMs;
  if (stale) {
    const notification = await alert(store, dependencies, {
      key: 'watchdog_stale', category: 'monitor_runtime',
      message: 'AM4監視の定期実行が遅延または停止している可能性があります。',
      metadata: { lastSuccessfulRunAt: state.value.lastSuccessfulRunAt || null },
    });
    return { status: 'stale', lastSuccessfulRunAt: state.value.lastSuccessfulRunAt || null, notification };
  }
  await alert(store, dependencies, {
    key: 'watchdog_stale', status: 'resolved', category: 'monitor_runtime',
    message: 'AM4監視の定期実行は復旧しています。', metadata: { lastSuccessfulRunAt: state.value.lastSuccessfulRunAt },
  });
  return { status: 'healthy', lastSuccessfulRunAt: state.value.lastSuccessfulRunAt };
}

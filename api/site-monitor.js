// Authenticated entry points for AM4's durable inspection and safe repair
// worker. This is intentionally separate from public article APIs: external
// callers can enqueue only signed Notion/Vercel events, while Cron and manual
// operation require distinct secrets.

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import { isAuthorizedCronRequest } from '../lib/cron-auth.js';
import {
  isValidNotionWebhookSignature,
  notionWebhookSignature,
  readNotionWebhookPayload,
} from '../lib/notion-webhook-auth.js';
import { getNotionPageMonitorTarget, notionSourceDefinitions } from '../lib/notion-content-sync.js';
import {
  matchEditorialAssociationRulesetNeedsReconciliation,
  matchEditorialBackfillNeedsScan,
  matchEditorialDuplicateCandidatesNeedScan,
  queueUnlinkedMatchEditorialReconciliation,
  refreshMatchEditorialDuplicateCandidates,
  scanMatchEditorialDuplicateCandidates,
} from '../lib/match-editorial-sync.js';
import { listArticles } from '../lib/article-store.js';
import { deliverSiteMonitorAlert } from '../lib/site-monitor-notify.js';
import { runSiteMonitor, checkSiteMonitorWatchdog, siteMonitorSettings } from '../lib/site-monitor-core.js';
import { createSiteMonitorStore, siteMonitorDigest } from '../lib/site-monitor-store.js';
import {
  REPORT_GENERATION_SOURCE_TYPE,
  scanMissingMatchReports,
} from '../lib/match-report-repair.js';
import {
  PREDICTION_GENERATION_SOURCE_TYPE,
  scanMissingMatchPredictions,
} from '../lib/match-prediction-repair.js';
import {
  isValidVercelWebhookSignature,
  readVercelWebhookPayload,
  vercelWebhookSignature,
} from '../lib/vercel-webhook-auth.js';

// Normal monitor work remains bounded below 120 seconds in the core. The
// authenticated, one-fixture report-generation lane has a separate 285-second
// budget for verified provider reads, deterministic drafting, and the durable
// Notion handoff.
export const config = { maxDuration: 300, api: { bodyParser: false } };

const NOTION_PAGE_EVENTS = new Set([
  'page.created',
  'page.properties_updated',
  'page.content_updated',
  'page.moved',
  'page.deleted',
  'page.undeleted',
]);
const VERCEL_PRODUCTION_EVENTS = new Set(['deployment.promoted']);
const DEFAULT_VERCEL_PROJECT_ID = 'prj_8EJAFi2Dgph83Jbuf20rmfyFahuu';
const DEFAULT_VERCEL_TEAM_ID = 'team_j4FD3nvbNt5PKHJLJJfO9Xbq';
const MATCH_EDITORIAL_SOURCE_TYPES = Object.freeze(['match_report', 'match_prediction']);
// These source types are internal, durable creation jobs. They are never
// claimed by the ordinary reader-safe monitor lane: a single, authenticated
// extended worker owns one verified editorial generation at a time.
const GENERATED_EDITORIAL_SOURCE_TYPES = Object.freeze([
  REPORT_GENERATION_SOURCE_TYPE,
  PREDICTION_GENERATION_SOURCE_TYPE,
]);
const MONITOR_QUEUE_SOURCE_TYPES = Object.freeze([
  ...MATCH_EDITORIAL_SOURCE_TYPES,
  ...GENERATED_EDITORIAL_SOURCE_TYPES,
]);
// This is intentionally source-controlled rather than operator input.  It
// identifies the corrected association/media repair below, so one legacy
// terminal job cannot prevent a single safe recovery after the repair code
// itself changes.  Repeating the same URL keeps the same durable job and
// cannot reset its repair-attempt ceiling.
const KNOWN_DELIVERY_REPAIR_GENERATION = 'structured-media-2026-09-15-v1';
// A source-wide editorial recovery is an operator-authenticated, durable
// delivery operation. It may legitimately need to repair more than the
// routine Cron guard permits, but it still has finite ceilings and retains
// every per-run, transport-retry, Notion-429, queue, and write-ownership
// safeguard. These values are intentionally scoped below to `backfill=1`;
// ordinary Cron, webhook, reader, and targeted-repair requests retain their
// configured daily budgets (and defer safely if the shared daily ledger has
// already been consumed by this explicitly requested recovery).
const MANUAL_EDITORIAL_BACKFILL_DAILY_LIMITS = Object.freeze({
  maxApiCallsPerDay: 5_000,
  maxRepairsPerDay: 1_500,
});
// A bounded initial incident recovery can legitimately need more than the
// unattended routine's twenty deterministic writes: a newly generated report
// needs its source page plus the normal public delivery and association work.
// The costly model cap remains 20/day.  This is enabled only for the isolated
// one-fixture report lane, never for reader requests or generic Cron work.
const REPORT_GENERATION_RECOVERY_DAILY_LIMITS = Object.freeze({
  maxApiCallsPerDay: 1_000,
  maxProviderRequestsPerDay: 400,
  maxGenerationsPerDay: 20,
  // The project can already have a legitimate editorial-sync backlog in the
  // shared ledger when a finished-fixture incident begins.  Leave 95 bounded
  // operations above the observed 145-operation baseline: enough for the
// sixteen target reports' Notion/public/association writes, while the new
// report-creation ceiling remains 20 and ordinary Cron remains at 20 repairs.
  maxRepairsPerDay: 240,
  maxBrowserLaunchesPerDay: 20,
});
const REPORT_GENERATION_QUOTA_POLICY_VERSION = 'report-generation-recovery-limits-v3-deterministic';
// Production's hourly reader-facing monitor has a finite 12-launch daily
// ceiling. This preserves a bounded site-wide visual pass even if a legacy
// runtime setting is lower; the durable JST usage ledger is never reset by a
// run or deployment.
const PRODUCTION_DEPLOYMENT_BROWSER_VALIDATION_LIMIT = 12;

function queryIs(req, key) {
  return String(req?.query?.[key] || '') === '1';
}

async function enqueueProductionDeploymentValidation(store, deploymentId, now = () => new Date()) {
  if (!deploymentId) return { state: 'deployment_identity_unavailable' };
  const state = await store.readState();
  const lastDeploymentId = state.value?.deploymentValidation?.lastEnqueuedDeploymentId || null;
  if (lastDeploymentId === deploymentId) return { state: 'already_enqueued' };

  // The Vercel webhook remains the immediate trigger. This small Cron fallback
  // makes a missed or not-yet-configured webhook recoverable without letting a
  // repeated hourly run create fresh browser work for the same deployment.
  const queued = await store.enqueue({
    kind: 'deployment_validation', deploymentId,
    trigger: 'cron_deployment_detection', priority: 90,
  });
  await store.updateState((current) => ({
    ...current,
    deploymentValidation: {
      ...(current.deploymentValidation && typeof current.deploymentValidation === 'object'
        ? current.deploymentValidation
        : {}),
      lastEnqueuedDeploymentId: deploymentId,
      enqueuedAt: new Date(now()).toISOString(),
    },
  }));
  return { state: queued.enqueued ? 'queued' : 'already_queued', jobId: queued.job.id };
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

function finishEmpty(res, status = 204) {
  noStore(res);
  return res.status(status).end();
}

function safeId(value, limit = 200) {
  const id = String(value || '').trim();
  return id && id.length <= limit && !/[\r\n\0]/.test(id) ? id : null;
}

function browserErrorCode(value) {
  const text = String(value || '').toLowerCase();
  if (!text) return null;
  if (/executable|browser.*not found|enoent/u.test(text)) return 'browser_executable_unavailable';
  if (/timeout|timed out/u.test(text)) return 'browser_timeout';
  if (/closed|crash|killed/u.test(text)) return 'browser_closed';
  return 'browser_runtime_error';
}

function safeArticleId(value) {
  const id = safeId(value);
  // Article records live under a Blob key. Keep this administrative verifier
  // to the actual article-id grammar rather than accepting a path-like value.
  return id && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(id) ? id : null;
}

function safeNotionPageId(value) {
  const id = safeId(value, 64);
  // A targeted source repair is intentionally narrower than a generic
  // identifier endpoint. Accept Notion's UUID with or without separators,
  // but reject paths, URLs, and arbitrary strings before any upstream read.
  const compact = id ? id.replace(/-/gu, '') : '';
  return /^[a-f0-9]{32}$/iu.test(compact) ? id : null;
}

function ordinaryNotionPageJobId({ pageId, sourceType, sourceVersion }) {
  return siteMonitorDigest({
    kind: 'notion_page',
    pageId: pageId || null,
    fixtureId: null,
    sourceType: sourceType || null,
    sourceVersion: sourceVersion || null,
    deploymentId: null,
    deliveryOnly: true,
  }).slice(0, 40);
}

function legacyOrdinaryNotionPageJobId({ pageId, sourceType, sourceVersion }) {
  // Jobs queued before the delivery/browser split deliberately retain their
  // original identity. Recognise them for a targeted operator request rather
  // than silently creating a second concurrent repair of the same version.
  return siteMonitorDigest({
    kind: 'notion_page',
    pageId: pageId || null,
    fixtureId: null,
    sourceType: sourceType || null,
    sourceVersion: sourceVersion || null,
    deploymentId: null,
  }).slice(0, 40);
}

function correctedDeliveryRepairAllowed(job) {
  // Do not use a code-generation retry for a source/manual-review failure.
  // It is reserved for the exact class where a previously persisted delivery
  // repair was rolled back after its browser/delivery check failed. The next
  // run still has the normal two-write ceiling and snapshot rollback.
  return job?.status === 'blocked'
    && ['browser_failed', 'verification_failed'].includes(String(job.lastError || ''));
}

function authorizationValue(req) {
  const header = req?.headers?.authorization;
  return typeof header === 'string' ? header : null;
}

function siteMonitorAdminAuthorizationValue(req) {
  // Vercel's protected-deployment client can use `Authorization` for its own
  // access token. Keep the conventional Bearer header for direct operators,
  // while allowing the same value in a dedicated header so protection bypass
  // cannot replace the monitor credential in transit. Never accept it in a
  // URL or request body.
  const dedicated = req?.headers?.['x-site-monitor-admin'];
  return typeof dedicated === 'string' ? dedicated : authorizationValue(req);
}

function isExpectedAdminBearer(actual, secret) {
  const expected = typeof secret === 'string' && secret ? `Bearer ${secret}` : null;
  if (!actual || !expected || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8'));
}

export function isAuthorizedSiteMonitorAdmin(
  req,
  secret = process.env.SITE_MONITOR_ADMIN_SECRET,
  ephemeralSecret = process.env.SITE_MONITOR_EPHEMERAL_ADMIN_SECRET,
) {
  const actual = siteMonitorAdminAuthorizationValue(req);
  // A one-deployment secondary credential lets a controlled operator run a
  // bounded backfill without replacing the standing admin credential. It is
  // server-only, never accepted from a query/body, and expires when that
  // deployment is superseded. The primary secret remains valid throughout.
  return isExpectedAdminBearer(actual, secret) || isExpectedAdminBearer(actual, ephemeralSecret);
}

function safePublicHttpsUrl(value, limit = 1_000) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > limit || /[\r\n\0]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    // Browser checks can contain a cache-busting query parameter. Never echo
    // query strings from a persisted result: the stable path plus article and
    // fixture IDs below remain sufficient operational evidence.
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function safeRelativePath(value, limit = 500) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > limit || !raw.startsWith('/') || raw.startsWith('//') || /[\r\n\0]/.test(raw)) return null;
  try {
    return new URL(raw, 'https://am4.local').pathname;
  } catch {
    return null;
  }
}

function compactBrowserChecks(checks) {
  if (!checks || typeof checks !== 'object') return null;
  const cards = (Array.isArray(checks.match?.cards) ? checks.match.cards : [])
    .slice(0, 2)
    .map((card) => {
      const playerId = Number(card?.playerId);
      const naturalWidth = Number(card?.naturalWidth);
      const imageUrl = safePublicHttpsUrl(card?.imageUrl);
      if (!Number.isSafeInteger(playerId) || playerId <= 0 || !imageUrl) return null;
      return {
        playerId,
        imageUrl,
        naturalWidth: Number.isSafeInteger(naturalWidth) && naturalWidth > 0 ? naturalWidth : null,
      };
    })
    .filter(Boolean);
  const article = checks.article && typeof checks.article === 'object'
    ? {
      url: safePublicHttpsUrl(checks.article.url),
      tailChecked: checks.article.tailChecked === true,
    }
    : null;
  const match = checks.match && typeof checks.match === 'object'
    ? { url: safePublicHttpsUrl(checks.match.url), cards }
    : null;
  const badge = checks.badge && typeof checks.badge === 'object'
    ? {
      state: safeId(checks.badge.state, 40),
      kind: safeId(checks.badge.kind, 40),
      href: safeRelativePath(checks.badge.href),
    }
    : null;
  if (!article && !match && !badge) return null;
  return { article, match, badge };
}

function compactRun(result) {
  const compactJob = (job = {}) => {
    const article = job?.result?.article || null;
    const fixtureId = Number(job?.result?.fixture?.id ?? article?.match?.fixtureId);
    return {
      jobId: job.jobId,
      status: job.status,
      state: job.result?.state || null,
      // Status is admin-authenticated and needs enough lineage to investigate
      // a failed browser assertion. Deliberately expose only stable IDs and
      // versions; article bodies and Notion properties never leave the store.
      articleId: safeArticleId(article?.id),
      notionPageId: safeId(article?.notion?.pageId),
      sourceVersion: safeId(job.result?.sourceVersion || article?.notion?.updatedAt, 100),
      fixtureId: Number.isSafeInteger(fixtureId) && fixtureId > 0 ? fixtureId : null,
      reason: job.result?.reason || job.result?.browser?.reason || null,
      repairs: Array.isArray(job.result?.repairs) ? job.result.repairs : [],
      issues: Array.isArray(job.result?.issues) ? job.result.issues : [],
      browser: job.result?.browser ? {
        status: job.result.browser.status || null,
        failureKind: job.result.browser.failureKind || null,
        reason: job.result.browser.reason || null,
        error: job.result.browser.error || null,
        checks: compactBrowserChecks(job.result.browser.checks),
      } : null,
      reportGeneration: job.result?.reportGeneration ? {
        fixtureId: Number.isSafeInteger(Number(job.result.reportGeneration.fixtureId))
          ? Number(job.result.reportGeneration.fixtureId) : null,
        outcome: safeId(job.result.reportGeneration.outcome, 80),
        notionPageId: safeId(job.result.reportGeneration.notionPageId, 80),
        sourceVersion: safeId(job.result.reportGeneration.sourceVersion, 100),
        browserValidationJobId: safeId(job.result.reportGeneration.browserValidationJobId, 80),
      } : null,
      predictionGeneration: job.result?.predictionGeneration ? {
        fixtureId: Number.isSafeInteger(Number(job.result.predictionGeneration.fixtureId))
          ? Number(job.result.predictionGeneration.fixtureId) : null,
        outcome: safeId(job.result.predictionGeneration.outcome, 80),
        notionPageId: safeId(job.result.predictionGeneration.notionPageId, 80),
        sourceVersion: safeId(job.result.predictionGeneration.sourceVersion, 100),
        browserValidationJobId: safeId(job.result.predictionGeneration.browserValidationJobId, 80),
      } : null,
    };
  };
  return {
    status: result?.status || 'unknown',
    runId: result?.runId || null,
    trigger: result?.trigger || null,
    deploymentId: result?.deploymentId || null,
    jobs: Array.isArray(result?.jobs) ? result.jobs.map(compactJob) : [],
    usage: result?.usage || null,
  };
}

function compactEditorialQueue(items = []) {
  // Queue membership is operational metadata, not editorial data. Keeping a
  // small per-lane count in the protected status response lets us distinguish
  // "the prediction lane is waiting" from "the source scan never queued it"
  // without exposing page IDs, article bodies, or Notion properties.
  const bySource = Object.fromEntries(MONITOR_QUEUE_SOURCE_TYPES.map((sourceType) => [sourceType, {
    queued: 0,
    deliveryOnly: 0,
    priorities: {},
  }]));
  let itemsWithoutSourceMetadata = 0;
  for (const item of Array.isArray(items) ? items : []) {
    const sourceType = item?.sourceType;
    const summary = bySource[sourceType];
    if (!summary) {
      if (!sourceType) itemsWithoutSourceMetadata += 1;
      continue;
    }
    summary.queued += 1;
    if (item.deliveryOnly === true) summary.deliveryOnly += 1;
    const priority = Number(item.priority);
    const priorityKey = Number.isSafeInteger(priority) && priority >= 0 ? String(priority) : 'unknown';
    summary.priorities[priorityKey] = Number(summary.priorities[priorityKey] || 0) + 1;
  }
  return { bySource, itemsWithoutSourceMetadata };
}

async function recordWebhookAlert(store, notify, {
  key,
  category,
  message,
  metadata = {},
}) {
  const recorded = await store.recordAlert({ key, status: 'open', category, message, metadata });
  if (!recorded.shouldDeliver) return recorded;
  const delivery = await notify(recorded.alert);
  await store.markAlertDelivery(recorded.alert.key, delivery);
  return { ...recorded, delivery };
}

function eventDigest(rawBody) {
  return createHash('sha256').update(rawBody, 'utf8').digest('hex');
}

async function deferNotionCollectorForRateLimit(store, retryAfterMs, now) {
  const startedAt = new Date(now()).getTime();
  const delayMs = Math.max(1_000, Number(retryAfterMs) || 60_000);
  const notBefore = new Date(startedAt + delayMs).toISOString();
  const sourceTypes = notionSourceDefinitions().map((source) => source.type);
  await store.updateState((state) => ({
    ...state,
    collector: {
      ...state.collector,
      // A Notion integration-level 429 applies to every AM4 source. Persist
      // it before acknowledging the event so later deliveries/Cron workers
      // cannot start an early request on another Function instance.
      notBefore: {
        ...(state.collector?.notBefore || {}),
        ...Object.fromEntries(sourceTypes.map((sourceType) => [sourceType, notBefore])),
      },
    },
  }));
  return notBefore;
}

function vercelScope(env) {
  return {
    projectId: safeId(env.SITE_MONITOR_VERCEL_PROJECT_ID || env.VERCEL_PROJECT_ID || DEFAULT_VERCEL_PROJECT_ID),
    teamId: safeId(env.SITE_MONITOR_VERCEL_TEAM_ID || env.VERCEL_ORG_ID || DEFAULT_VERCEL_TEAM_ID),
  };
}

export function isExpectedProductionDeploymentEvent(payload, env = process.env) {
  const scope = vercelScope(env);
  const eventType = String(payload?.type || '');
  const projectId = safeId(payload?.payload?.project?.id || payload?.payload?.projectId);
  const teamId = safeId(payload?.payload?.team?.id || payload?.teamId);
  const deploymentId = safeId(payload?.payload?.deployment?.id);
  if (!VERCEL_PRODUCTION_EVENTS.has(eventType)) return { accepted: false, reason: 'unsupported_event' };
  // deployment.promoted is the Vercel event which fires after production
  // traffic begins; do not confuse a Preview build with a reader-visible one.
  if (!scope.projectId || projectId !== scope.projectId) return { accepted: false, reason: 'unexpected_project' };
  if (!scope.teamId || teamId !== scope.teamId) return { accepted: false, reason: 'unexpected_team' };
  if (!deploymentId) return { accepted: false, reason: 'invalid_deployment' };
  return { accepted: true, deploymentId, projectId, teamId, eventType };
}

export async function respondWithNotionSiteMonitorWebhook(req, res, {
  env = process.env,
  createStore = createSiteMonitorStore,
  readPayload = readNotionWebhookPayload,
  getTarget = getNotionPageMonitorTarget,
  notify = deliverSiteMonitorAlert,
  now = () => new Date(),
} = {}) {
  if (String(req?.method || '').toUpperCase() !== 'POST') {
    res.setHeader('Allow', 'POST');
    return finishEmpty(res, 405);
  }
  let received;
  try {
    received = await readPayload(req);
  } catch (error) {
    noStore(res);
    return res.status(error?.code === 'NOTION_WEBHOOK_BODY_TOO_LARGE' ? 413 : 400).json({ error: 'Invalid webhook payload' });
  }
  if (!received) {
    noStore(res);
    return res.status(400).json({ error: 'Invalid webhook payload' });
  }
  // The one-time Notion verification request is deliberately acknowledged
  // without persisting a secret or treating it as editorial input. The token
  // must be placed in the protected environment before activation.
  if (typeof received.payload.verification_token === 'string' && received.payload.verification_token) return finishEmpty(res);

  const verificationToken = env.NOTION_WEBHOOK_VERIFICATION_TOKEN;
  if (!verificationToken) {
    noStore(res);
    return res.status(503).json({ error: 'Webhook verification is not configured' });
  }
  if (!isValidNotionWebhookSignature({
    rawBody: received.rawBody,
    signature: notionWebhookSignature(req?.headers),
    verificationToken,
  })) {
    noStore(res);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const payload = received.payload;
  if (!NOTION_PAGE_EVENTS.has(payload.type) || payload?.entity?.type !== 'page') return finishEmpty(res);
  const pageId = safeId(payload.entity.id);
  if (!pageId) {
    noStore(res);
    return res.status(400).json({ error: 'Invalid Notion page event' });
  }

  const store = createStore();
  // Save receipt before any Notion API call. Retries and reordered events can
  // then be de-duplicated without losing the signal if this Function stops.
  const event = await store.recordEvent({
    source: 'notion',
    eventId: safeId(payload.id),
    payloadDigest: eventDigest(received.rawBody),
    pageId,
    type: payload.type,
    metadata: { timestamp: safeId(payload.timestamp), attempt: Number(payload.attempt_number) || null },
  });
  // A Notion retry can repeat the exact event after its first receipt has
  // already been converted into a source-version job. Never reread Notion or
  // start another immediate worker for that duplicate.
  if (event.duplicate && event.event?.queuedAt) {
    noStore(res);
    return res.status(202).json({ accepted: true, duplicateEvent: true, queued: false, worker: { state: 'already_recorded' } });
  }
  if (!env.NOTION_API_KEY) {
    await store.markEventQueued(event.id);
    await recordWebhookAlert(store, notify, {
      key: 'notion:webhook-api-key', category: 'external_connection',
      message: 'AM4監視はNotion Webhookを受信しましたが、Notion読取り接続を利用できません。',
      metadata: { eventId: event.id },
    });
    noStore(res);
    return res.status(503).json({ error: 'Notion sync is not configured' });
  }

  const settings = siteMonitorSettings(env);
  let webhookApiCalls = 0;
  const consumeRequest = async () => {
    if (webhookApiCalls >= settings.maxApiCallsPerRun) {
      return { ok: false, exceeded: 'apiCallsPerRun', usage: { apiCalls: webhookApiCalls }, requested: { apiCalls: 1 } };
    }
    const reservation = await store.consumeUsage({ apiCalls: 1 }, {
      apiCalls: settings.maxApiCallsPerDay,
      browserLaunches: settings.maxBrowserLaunchesPerDay,
      repairOperations: settings.maxRepairsPerDay,
    });
    if (reservation.ok) webhookApiCalls += 1;
    return reservation;
  };
  const target = await getTarget({ pageId, apiKey: env.NOTION_API_KEY, consumeRequest });
  if (target.outcome === 'rate_limited') {
    const notBefore = await deferNotionCollectorForRateLimit(store, target.retryAfterMs, now);
    await store.markEventQueued(event.id);
    noStore(res);
    return res.status(202).json({
      accepted: true, duplicateEvent: event.duplicate, queued: false,
      worker: { state: 'deferred_to_cron', reason: 'notion_rate_limited', notBefore },
    });
  }
  if (target.outcome === 'usage_limit') {
    await store.markEventQueued(event.id);
    await recordWebhookAlert(store, notify, {
      key: 'usage_limit', category: 'usage_limit',
      message: 'AM4監視は設定済みの利用量上限に達したため、安全に停止しました。',
      metadata: { eventId: event.id },
    });
    noStore(res);
    return res.status(202).json({
      accepted: true, duplicateEvent: event.duplicate, queued: false,
      worker: { state: 'deferred_to_cron', reason: 'usage_limit' },
    });
  }
  if (target.outcome === 'source_unavailable') {
    await store.markEventQueued(event.id);
    await recordWebhookAlert(store, notify, {
      key: 'notion:webhook-read', category: 'external_connection',
      message: 'AM4監視はNotion更新後のページを再取得できませんでした。',
      metadata: { eventId: event.id, pageId },
    });
    noStore(res);
    return res.status(503).json({ error: 'Notion page could not be verified' });
  }
  if (target.outcome !== 'eligible') {
    await store.markEventQueued(event.id);
    noStore(res);
    return res.status(202).json({
      accepted: true, duplicateEvent: event.duplicate, queued: false,
      worker: { state: 'not_actionable', reason: target.outcome || 'untrusted_source' },
    });
  }
  const queued = await store.enqueue({
    kind: 'notion_page', pageId: target.pageId, sourceType: target.sourceType,
    sourceVersion: target.sourceVersion, deliveryOnly: true,
    trigger: 'notion_webhook', priority: 100,
  });
  await store.markEventQueued(event.id);
  // A webhook receipt is a durable, priority trigger, not an unsafe
  // background worker. Serverless webhook handlers cannot reliably cancel a
  // partly-running repair after their response deadline. The authenticated
  // hourly worker claims this priority entry first and records the full
  // inspection/repair result under its durable lease.
  noStore(res);
  return res.status(202).json({
    accepted: true,
    duplicateEvent: event.duplicate,
    queued: queued.enqueued,
    pageId: target.pageId,
    sourceVersion: target.sourceVersion,
    worker: { state: queued.enqueued ? 'queued_for_priority_worker' : 'already_queued' },
  });
}

export async function respondWithVercelSiteMonitorWebhook(req, res, {
  env = process.env,
  createStore = createSiteMonitorStore,
  readPayload = readVercelWebhookPayload,
  runMonitor = runSiteMonitor,
  now = () => new Date(),
} = {}) {
  if (String(req?.method || '').toUpperCase() !== 'POST') {
    res.setHeader('Allow', 'POST');
    return finishEmpty(res, 405);
  }
  let received;
  try {
    received = await readPayload(req);
  } catch (error) {
    noStore(res);
    return res.status(error?.code === 'VERCEL_WEBHOOK_BODY_TOO_LARGE' ? 413 : 400).json({ error: 'Invalid webhook payload' });
  }
  if (!received) {
    noStore(res);
    return res.status(400).json({ error: 'Invalid webhook payload' });
  }
  if (!isValidVercelWebhookSignature({
    rawBody: received.rawBody,
    signature: vercelWebhookSignature(req?.headers),
    secret: env.SITE_MONITOR_VERCEL_WEBHOOK_SECRET,
  })) {
    noStore(res);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const expected = isExpectedProductionDeploymentEvent(received.payload, env);
  if (!expected.accepted) return finishEmpty(res);
  const store = createStore();
  const event = await store.recordEvent({
    source: 'vercel', eventId: safeId(received.payload.id), payloadDigest: eventDigest(received.rawBody),
    deploymentId: expected.deploymentId, type: expected.eventType,
    metadata: { projectId: expected.projectId, teamId: expected.teamId, createdAt: received.payload.createdAt || null },
  });
  // Account-webhook delivery can be retried after a successful 202 response.
  // Always project even an already-recorded event back into the durable queue:
  // a deployment can be promoted while an older Function version is still
  // serving the alias, and that older version may have written a queue entry
  // before the current queue metadata existed. `enqueue` is idempotent for
  // the deployment identity, never reopens a terminal validation, and only
  // repairs the non-authoritative queue projection when needed.
  const queued = await store.enqueue({
    kind: 'deployment_validation', deploymentId: expected.deploymentId,
    trigger: 'vercel_webhook', priority: 90,
  });
  await store.markEventQueued(event.id);
  // A Production promotion is a small, trusted, code-owned operation.  Run
  // its deployment-expansion job immediately instead of treating an accepted
  // webhook response as proof that later repair work happened.  It only reads
  // the persisted public index and creates bounded, durable validation jobs;
  // it neither accepts caller content nor performs an article write.  A
  // duplicate event never enters this branch, and the durable lock still
  // protects a concurrent Cron.
  let dispatch = null;
  if (queued.enqueued) {
    try {
      const result = await runMonitor({
        store,
        trigger: 'vercel_webhook',
        deploymentId: expected.deploymentId,
        onlyJobIds: [queued.job.id],
        collect: false,
        settings: {
          ...siteMonitorSettings(env),
          maxJobsPerRun: 1,
          maxRunMs: 30_000,
          minJobStartMs: 5_000,
          browserEnabled: false,
        },
        now,
      });
      dispatch = {
        status: safeId(result?.status, 80) || 'unknown',
        recoveredBrowserQuotaHolds: Number(result?.browserQuotaRecovery?.requeued || 0),
        jobs: (result?.jobs || []).map((job) => ({
          jobId: safeId(job?.jobId, 80) || null,
          queueStatus: safeId(job?.status, 80) || null,
          state: safeId(job?.result?.state, 80) || null,
          reason: safeId(job?.result?.reason, 80) || null,
        })),
      };
      // Validate one report surface while the signed deployment event is
      // still active. The expansion job returns code-owned IDs only; this
      // cannot become an arbitrary browser URL runner. Remaining candidates
      // stay in the same durable queue for the minute worker.
      const validationJobId = (result?.jobs || []).flatMap((job) => (
        Array.isArray(job?.result?.validationJobIds) ? job.result.validationJobIds : []
      )).find((jobId) => typeof jobId === 'string' && jobId);
      if (validationJobId) {
        try {
          const visualResult = await runMonitor({
            store,
            trigger: 'vercel_webhook_visual',
            deploymentId: expected.deploymentId,
            onlyJobIds: [validationJobId],
            collect: false,
            settings: {
              ...siteMonitorSettings(env),
              maxJobsPerRun: 1,
              maxRunMs: 105_000,
              minJobStartMs: 5_000,
            },
            now,
          });
          dispatch.visual = {
            status: safeId(visualResult?.status, 80) || 'unknown',
            recoveredBrowserQuotaHolds: Number(visualResult?.browserQuotaRecovery?.requeued || 0),
            jobs: (visualResult?.jobs || []).map((job) => ({
              jobId: safeId(job?.jobId, 80) || null,
              queueStatus: safeId(job?.status, 80) || null,
              state: safeId(job?.result?.state, 80) || null,
              reason: safeId(job?.result?.reason, 80) || null,
              browserStatus: safeId(job?.result?.browser?.status, 80) || null,
            })),
          };
        } catch (_error) {
          dispatch.visual = { status: 'deferred', jobs: [] };
        }
      }
    } catch (_error) {
      // The job was already committed before this call. Leave it for the
      // authenticated continuation rather than converting a transient worker
      // startup failure into a failed webhook delivery or a duplicate write.
      dispatch = { status: 'deferred', jobs: [] };
    }
  }
  // As with Notion, receipt records a high-priority durable validation rather
  // than leaving an uncancellable repair running after the signed webhook is
  // acknowledged. A second delivery for the same deployment may therefore
  // reuse this entry without consuming another inspection budget.
  const terminal = ['completed', 'blocked', 'failed'].includes(queued.job?.status);
  const deploymentCompleted = dispatch?.jobs?.some((job) => (
    job.jobId === queued.job?.id && job.queueStatus === 'completed' && job.state === 'completed'
  ));
  const workerState = deploymentCompleted
    ? 'deployment_validation_completed'
    : queued.enqueued
      ? 'queued_for_priority_worker'
    : terminal ? 'already_processed' : 'already_queued';
  // This is deliberately a tiny, secret-free operational breadcrumb. It lets
  // production logs prove that a signed deployment event reached the durable
  // repair queue without logging its payload or webhook signature.
  console.info('[site-monitor] vercel-webhook', JSON.stringify({
    deploymentId: expected.deploymentId,
    duplicateEvent: event.duplicate,
    queued: queued.enqueued,
    metadataMigrated: queued.metadataMigrated === true,
    workerState,
    dispatch,
  }));
  noStore(res);
  return res.status(202).json({
    accepted: true,
    duplicateEvent: event.duplicate,
    queued: queued.enqueued,
    deploymentId: expected.deploymentId,
    worker: { state: workerState, dispatch },
  });
}

export async function respondWithSiteMonitor(req, res, {
  env = process.env,
  createStore = createSiteMonitorStore,
  runMonitor = runSiteMonitor,
  listPublicArticles = listArticles,
  queueUnlinkedEditorials = queueUnlinkedMatchEditorialReconciliation,
  scanDuplicateCandidates = scanMatchEditorialDuplicateCandidates,
  refreshDuplicateCandidates = refreshMatchEditorialDuplicateCandidates,
  scanMissingReports = scanMissingMatchReports,
  scanMissingPredictions = scanMissingMatchPredictions,
  runWatchdog = checkSiteMonitorWatchdog,
  now = () => new Date(),
  getTarget = getNotionPageMonitorTarget,
  notify = deliverSiteMonitorAlert,
  ...webhookDependencies
} = {}) {
  if (queryIs(req, 'notionWebhook')) {
    return respondWithNotionSiteMonitorWebhook(req, res, {
      env, createStore, now, getTarget, notify, ...webhookDependencies,
    });
  }
  if (queryIs(req, 'vercelWebhook')) {
    return respondWithVercelSiteMonitorWebhook(req, res, { env, createStore, now, ...webhookDependencies });
  }

  // The continuation worker deliberately does not collect Notion deltas. It
  // gives an existing durable backlog another bounded claim window between
  // hourly collections, so a busy hour is not permanently capped at one
  // ten-job worker. It remains a Cron-authenticated route, never a public
  // repair endpoint.
  const primaryCron = queryIs(req, 'cron');
  const continuation = queryIs(req, 'continuation');
  // This is a Cron-authenticated delivery drain, not a public backfill
  // endpoint. It prevents unrelated monitor work from starving the two
  // editorial lanes while retaining the ordinary Cron's normal source
  // collection, rate-limit, retry, and daily-budget safeguards.
  const editorialContinuation = queryIs(req, 'editorialContinuation');
  const cron = primaryCron || queryIs(req, 'watchdog') || continuation || editorialContinuation;
  const manual = queryIs(req, 'run') || queryIs(req, 'status');
  if (!cron && !manual) {
    noStore(res);
    return res.status(404).json({ error: 'Not found' });
  }
  if (cron) {
    if (!env.CRON_SECRET || !isAuthorizedCronRequest(req, env.CRON_SECRET)) {
      noStore(res);
      return res.status(401).json({ error: 'Unauthorized' });
    }
  } else if (!isAuthorizedSiteMonitorAdmin(
    req,
    env.SITE_MONITOR_ADMIN_SECRET,
    env.SITE_MONITOR_EPHEMERAL_ADMIN_SECRET,
  )) {
    noStore(res);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const store = createStore();
  const activeDeploymentId = safeId(env.VERCEL_DEPLOYMENT_ID);
  if (queryIs(req, 'status')) {
    const runId = safeId(req?.query?.runId);
    const [state, queue, run] = await Promise.all([
      store.readState(),
      store.readQueue(),
      runId ? store.readRun(runId) : Promise.resolve(null),
    ]);
    noStore(res);
    return res.status(200).json({
      state: state.value.lastRun || null,
      lastSuccessfulRunAt: state.value.lastSuccessfulRunAt || null,
      usage: state.value.usage,
      matchEditorialSync: state.value.matchEditorialSync || null,
      matchReportRepair: state.value.matchReportRepair || null,
      matchPredictionRepair: state.value.matchPredictionRepair || null,
      // Preserve the former report-only state during the migration so an
      // existing operational consumer does not lose historical visibility.
      matchReportSync: state.value.matchReportSync || null,
      queued: queue.value.items.length,
      editorialQueue: compactEditorialQueue(queue.value.items),
      run: run?.value ? compactRun({ ...run.value, runId: run.value.id }) : null,
    });
  }
  if (queryIs(req, 'watchdog')) {
    const result = await runWatchdog({ store, settings: siteMonitorSettings(env), now });
    noStore(res);
    return res.status(result.status === 'healthy' ? 200 : 503).json(result);
  }
  if (queryIs(req, 'run') && String(req?.method || '').toUpperCase() !== 'POST') {
    res.setHeader('Allow', 'POST');
    return finishEmpty(res, 405);
  }
  // Webhook delivery is preferred, but it must not be the sole way a newly
  // promoted Production deployment receives the bounded visual checks. Cron
  // records the current immutable deployment once; the durable job identity
  // suppresses repeats, and the running function passes that same identity to
  // the worker so an older job cannot validate newer code by accident.
  if (primaryCron && String(env.VERCEL_ENV || '').toLowerCase() === 'production' && activeDeploymentId) {
    await enqueueProductionDeploymentValidation(store, activeDeploymentId, now);
  }
  const recheckDeployment = queryIs(req, 'run') && queryIs(req, 'recheckDeployment');
  // `backfill=1` remains authenticated, but now reconciles both Notion match
  // editorial sources rather than silently leaving predictions behind.
  const runMatchEditorialBackfill = queryIs(req, 'run') && queryIs(req, 'backfill');
  const requestedArticleId = queryIs(req, 'run') ? req?.query?.recheckArticle : null;
  const recheckArticleId = requestedArticleId ? safeArticleId(requestedArticleId) : null;
  const requestedResyncPage = queryIs(req, 'run') ? req?.query?.resyncPage : null;
  const resyncPageId = requestedResyncPage ? safeNotionPageId(requestedResyncPage) : null;
  if (requestedArticleId && !recheckArticleId) {
    noStore(res);
    return res.status(400).json({ error: 'Invalid article recheck target' });
  }
  if (requestedResyncPage && !resyncPageId) {
    noStore(res);
    return res.status(400).json({ error: 'Invalid Notion page resync target' });
  }
  const requestedModes = [recheckDeployment, runMatchEditorialBackfill, Boolean(recheckArticleId), Boolean(resyncPageId)].filter(Boolean);
  if (requestedModes.length > 1) {
    noStore(res);
    return res.status(400).json({ error: 'Choose one monitor target' });
  }
  const isManualTargetedRun = recheckDeployment || Boolean(recheckArticleId) || Boolean(resyncPageId);
  // A source-owned generation mismatch starts exactly one resumable full scan.
  // This also lets the dedicated minute worker resume an interrupted recovery
  // after deployment, while a completed generation remains a queue-only
  // worker: Cron/Webhooks retain responsibility for ordinary delta collection
  // and a large recovery cannot re-read unrelated Notion sources every minute.
  const needsEditorialBackfillState = runMatchEditorialBackfill || editorialContinuation;
  const editorialBackfillState = needsEditorialBackfillState
    ? (await store.readState()).value
    : null;
  const collectMatchEditorialBackfill = needsEditorialBackfillState
    && matchEditorialBackfillNeedsScan(editorialBackfillState);
  const scanEditorialDuplicateCandidates = editorialContinuation
    && matchEditorialDuplicateCandidatesNeedScan(editorialBackfillState);
  const deploymentId = activeDeploymentId;
  if ((recheckDeployment || recheckArticleId) && !deploymentId) {
    noStore(res);
    return res.status(503).json({ error: 'Current deployment identity is unavailable' });
  }
  if (recheckDeployment) {
    // This is a read/verify-only counterpart of a genuine
    // `deployment.promoted` event. It gives an authenticated operator a safe
    // way to re-run representative visual checks after changing monitor code,
    // without re-syncing Notion or retrying a blocked source version.
    await store.enqueue({
      kind: 'deployment_validation', deploymentId,
      validationId: randomUUID(), verificationOnly: true,
      trigger: 'manual_deployment_recheck', priority: 90,
    });
  }
  let targetJobId = null;
  if (recheckArticleId) {
    // This is intentionally inspection-only: it cannot resync, relink, or
    // mutate a requested record. A high priority and a one-job run guarantee
    // that stale queue work cannot substitute a different article's result.
    const target = await store.enqueue({
      kind: 'article_validation', articleId: recheckArticleId, deploymentId,
      validationId: randomUUID(), verificationOnly: true,
      trigger: 'manual_article_recheck', priority: 90,
    });
    targetJobId = target.job.id;
  }
  const settings = siteMonitorSettings(env);
  if (resyncPageId) {
    // This is an authenticated, exact-page recovery path for a reader-visible
    // mirror gap. It obtains the current page from the normal Notion API,
    // verifies that the page belongs to an AM4 source, and queues the usual
    // sync job. It does not accept a source type, URL, body, or publication
    // override from the caller.
    if (!env.NOTION_API_KEY) {
      await recordWebhookAlert(store, notify, {
        key: 'notion:manual-resync-api-key', category: 'external_connection',
        message: 'AM4監視は対象記事を再同期できません。Notion読取り接続を利用できません。',
        metadata: { pageId: resyncPageId },
      });
      noStore(res);
      return res.status(503).json({ error: 'Notion sync is not configured' });
    }
    let manualApiCalls = 0;
    const consumeRequest = async () => {
      if (manualApiCalls >= settings.maxApiCallsPerRun) {
        return { ok: false, exceeded: 'apiCallsPerRun', usage: { apiCalls: manualApiCalls }, requested: { apiCalls: 1 } };
      }
      const reservation = await store.consumeUsage({ apiCalls: 1 }, {
        apiCalls: settings.maxApiCallsPerDay,
        browserLaunches: settings.maxBrowserLaunchesPerDay,
        repairOperations: settings.maxRepairsPerDay,
      });
      if (reservation.ok) manualApiCalls += 1;
      return reservation;
    };
    const target = await getTarget({ pageId: resyncPageId, apiKey: env.NOTION_API_KEY, consumeRequest });
    if (target.outcome === 'rate_limited') {
      const notBefore = await deferNotionCollectorForRateLimit(store, target.retryAfterMs, now);
      noStore(res);
      return res.status(202).json({
        accepted: false,
        worker: { state: 'deferred_to_cron', reason: 'notion_rate_limited', notBefore },
      });
    }
    if (target.outcome === 'usage_limit') {
      await recordWebhookAlert(store, notify, {
        key: 'usage_limit', category: 'usage_limit',
        message: 'AM4監視は設定済みの利用量上限に達したため、安全に停止しました。',
        metadata: { pageId: resyncPageId, trigger: 'manual_page_resync' },
      });
      noStore(res);
      return res.status(202).json({ accepted: false, worker: { state: 'deferred_to_cron', reason: 'usage_limit' } });
    }
    if (target.outcome === 'source_unavailable' || target.outcome === 'time_budget_exhausted') {
      await recordWebhookAlert(store, notify, {
        key: 'notion:manual-resync-read', category: 'external_connection',
        message: 'AM4監視は対象記事を再取得できませんでした。既存の配信データは保持しています。',
        metadata: { pageId: resyncPageId, outcome: target.outcome },
      });
      noStore(res);
      return res.status(503).json({ error: 'Notion page could not be verified' });
    }
    if (target.outcome !== 'eligible') {
      noStore(res);
      return res.status(202).json({
        accepted: false,
        worker: { state: 'not_actionable', reason: target.outcome || 'untrusted_source' },
      });
    }
    const [deliveryJob, legacyJob] = await Promise.all([
      store.readJob(ordinaryNotionPageJobId(target)),
      store.readJob(legacyOrdinaryNotionPageJobId(target)),
    ]);
    const ordinaryJob = deliveryJob?.value || legacyJob?.value || null;
    const usesLegacyIdentity = !deliveryJob?.value && Boolean(legacyJob?.value);
    if (ordinaryJob?.status === 'queued') {
      // Re-enqueue the exact same durable identity before claiming it. This
      // repairs the crash window where a job Blob was written but the queue
      // index write did not finish, without creating a second repair attempt.
      const ensured = await store.enqueue({
        kind: 'notion_page', pageId: target.pageId, sourceType: target.sourceType,
        sourceVersion: target.sourceVersion,
        ...(usesLegacyIdentity ? {} : { deliveryOnly: true }),
        trigger: 'manual_page_resync', priority: 100,
      });
      targetJobId = ensured.job.id;
    } else if (ordinaryJob && !correctedDeliveryRepairAllowed(ordinaryJob)) {
      noStore(res);
      return res.status(409).json({
        accepted: false,
        worker: {
          state: ordinaryJob.status === 'running' ? 'already_processing' : 'already_processed',
          reason: ordinaryJob.status,
          sourceVersion: target.sourceVersion,
        },
      });
    } else {
      const queued = await store.enqueue({
        kind: 'notion_page', pageId: target.pageId, sourceType: target.sourceType,
        sourceVersion: target.sourceVersion,
        ...(correctedDeliveryRepairAllowed(ordinaryJob) ? { repairGeneration: KNOWN_DELIVERY_REPAIR_GENERATION } : {}),
        ...(usesLegacyIdentity ? {} : { deliveryOnly: true }),
        trigger: 'manual_page_resync', priority: 100,
      });
      // The durable identity includes the source version and the source-owned
      // repair generation. Do not quietly turn a terminal generation back into
      // work: that would bypass its per-version repair ceiling. A newer Notion
      // edit or a deliberately reviewed repair-code generation produces a new
      // identity; this response makes the existing terminal state explicit.
      if (!queued.enqueued && ['completed', 'blocked', 'failed'].includes(queued.job.status)) {
        noStore(res);
        return res.status(409).json({
          accepted: false,
          worker: {
            state: 'already_processed',
            reason: queued.job.status,
            sourceVersion: target.sourceVersion,
          },
        });
      }
      targetJobId = queued.job.id;
    }
  }
  // A fixture scan consumes provider budget before it can enqueue ordinary
  // work, so it has a separate durable lease from the later editorial writer
  // lock. This prevents overlapping minute Crons from paying for the same
  // source scan while still letting the current queue drain if a scan is in
  // progress elsewhere.
  const fixtureScanConfigured = Boolean(env.API_FOOTBALL_KEY && env.NOTION_API_KEY);
  let fixtureScanLock = null;
  let fixtureScanLockState = null;
  let scanProviderRequests = 0;
  const consumeFixtureScanProviderRequest = async () => {
    if (scanProviderRequests >= settings.maxProviderRequestsPerRun) {
      return {
        ok: false, exceeded: 'providerRequestsPerRun',
        usage: { providerRequests: scanProviderRequests }, requested: { providerRequests: 1 },
      };
    }
    const reservation = await store.consumeUsage({ providerRequests: 1 }, {
      providerRequests: settings.maxProviderRequestsPerDay,
    });
    if (reservation.ok) scanProviderRequests += 1;
    return reservation;
  };
  if (editorialContinuation && fixtureScanConfigured) {
    try {
      fixtureScanLock = await store.acquireLock({ name: 'fixture-editorial-scan', ttlMs: settings.lockTtlMs });
      fixtureScanLockState = fixtureScanLock ? 'acquired' : 'already_running';
    } catch {
      fixtureScanLockState = 'unavailable';
    }
  }
  let missingPredictionScan = null;
  let missingReportScan = null;
  try {
  // Every minute the existing authenticated editorial continuation reconciles
  // the scheduled target-fixture list with the public prediction mirror. The
  // fixture-first scanner itself is hourly, so a missing Notion source page is
  // queued for deterministic creation without turning the minute Cron into an
  // unbounded provider poll.
  if (editorialContinuation) {
    if (!env.API_FOOTBALL_KEY || !env.NOTION_API_KEY) {
      missingPredictionScan = { state: 'not_configured', reason: !env.API_FOOTBALL_KEY ? 'fixture_provider_unconfigured' : 'notion_unconfigured' };
      await recordWebhookAlert(store, notify, {
        key: 'prediction-generation:configuration', category: 'external_connection',
        message: 'AM4監視は試合予想の自動復旧を開始できません。必要なサーバー接続を利用できません。',
        metadata: { reason: missingPredictionScan.reason },
      });
    } else if (!fixtureScanLock) {
      missingPredictionScan = {
        state: fixtureScanLockState === 'already_running' ? 'already_running' : 'unavailable',
        reason: fixtureScanLockState === 'already_running' ? 'fixture_scan_in_progress' : 'fixture_scan_lock_unavailable',
      };
    } else try {
      missingPredictionScan = await scanMissingPredictions({
        store, now, consumeProviderRequest: consumeFixtureScanProviderRequest,
      });
      if (missingPredictionScan?.state === 'unavailable') {
        await recordWebhookAlert(store, notify, {
          key: 'prediction-generation:fixture-scan', category: 'external_connection',
          message: 'AM4監視は近日の試合予想欠落を再確認できませんでした。既存記事は保持し、次の巡回で再試行します。',
          metadata: { reason: missingPredictionScan.reason || null },
        });
      }
      if (missingPredictionScan?.state === 'quota_exceeded') {
        await recordWebhookAlert(store, notify, {
          key: 'usage_limit', category: 'usage_limit',
          message: 'AM4監視は設定済みの利用量上限に達したため、安全に停止しました。',
          metadata: { phase: 'prediction_fixture_scan' },
        });
      }
    } catch (_error) {
      missingPredictionScan = { state: 'unavailable', reason: 'prediction_fixture_scan_failed' };
      await recordWebhookAlert(store, notify, {
        key: 'prediction-generation:fixture-scan', category: 'external_connection',
        message: 'AM4監視は近日の試合予想欠落を再確認できませんでした。既存記事は保持し、次の巡回で再試行します。',
      });
    }
  }
  // Every minute the existing authenticated editorial continuation reconciles
  // the independent fixture list with the public report mirror. The scanner
  // itself is throttled to an hourly rolling pass after its bounded initial
  // recovery, so this Cron signal is not an unbounded provider poll.
  if (editorialContinuation) {
    if (!env.API_FOOTBALL_KEY || !env.NOTION_API_KEY) {
      missingReportScan = { state: 'not_configured', reason: !env.API_FOOTBALL_KEY ? 'fixture_provider_unconfigured' : 'notion_unconfigured' };
      await recordWebhookAlert(store, notify, {
        key: 'report-generation:configuration', category: 'external_connection',
        message: 'AM4監視は終了試合の解説自動復旧を開始できません。必要なサーバー接続を利用できません。',
        metadata: { reason: missingReportScan.reason },
      });
    } else if (!fixtureScanLock) {
      missingReportScan = {
        state: fixtureScanLockState === 'already_running' ? 'already_running' : 'unavailable',
        reason: fixtureScanLockState === 'already_running' ? 'fixture_scan_in_progress' : 'fixture_scan_lock_unavailable',
      };
    } else try {
      missingReportScan = await scanMissingReports({
        store, now, consumeProviderRequest: consumeFixtureScanProviderRequest,
      });
      if (missingReportScan?.state === 'unavailable') {
        await recordWebhookAlert(store, notify, {
          key: 'report-generation:fixture-scan', category: 'external_connection',
          message: 'AM4監視は終了試合の解説欠落を再確認できませんでした。既存記事は保持し、次の巡回で再試行します。',
          metadata: { reason: missingReportScan.reason || null },
        });
      }
      if (missingReportScan?.state === 'quota_exceeded') {
        await recordWebhookAlert(store, notify, {
          key: 'usage_limit', category: 'usage_limit',
          message: 'AM4監視は設定済みの利用量上限に達したため、安全に停止しました。',
          metadata: { phase: 'fixture_scan' },
        });
      }
    } catch (_error) {
      missingReportScan = { state: 'unavailable', reason: 'fixture_scan_failed' };
      await recordWebhookAlert(store, notify, {
        key: 'report-generation:fixture-scan', category: 'external_connection',
        message: 'AM4監視は終了試合の解説欠落を再確認できませんでした。既存記事は保持し、次の巡回で再試行します。',
      });
    }
  }
  } finally {
    if (fixtureScanLock) {
      try {
        await store.releaseLock(fixtureScanLock);
      } catch {
        // The lease expires safely if Blob is transiently unavailable here.
        // It is never evidence that either source scan completed.
      }
    }
  }
  // The minute-level editorial worker normally drains only durable jobs. When
  // a source-controlled fixture matcher changes, let that same authenticated
  // worker seed one Blob-only retry of currently unlinked records immediately
  // rather than making a previously safe 12-hour retry delay block a known
  // association correction. This path never reads Notion or accepts an
  // external target; queue identity still deduplicates concurrent Cron runs.
  let editorialRulesetReconciliation = null;
  if (editorialContinuation) {
    try {
      const current = await store.readState();
      if (matchEditorialAssociationRulesetNeedsReconciliation(current.value)) {
        editorialRulesetReconciliation = await queueUnlinkedEditorials({
          store,
          listArticles: listPublicArticles,
          now,
        });
      }
    } catch (error) {
      // A Blob read failure is not evidence that there are no missing cards.
      // Leave the stored ruleset version unchanged so the next authenticated
      // continuation can retry; the ordinary durable worker still drains any
      // existing editorial jobs in this invocation.
      editorialRulesetReconciliation = { state: 'unavailable' };
    }
  }

  // Do not wait for midnight after deploying a reviewed, higher-but-finite
  // recovery allowance.  This releases only prior `usage_limit` holds from
  // the same durable generation lane; it neither resets model attempts nor
  // creates a duplicate fixture job.  Later invocations are no-ops because
  // the policy marker is persisted with the monitor state.
  let releasedReportGenerationHolds = null;
  if (editorialContinuation) {
    try {
      const current = await store.readState();
      const repair = current.value.matchReportRepair && typeof current.value.matchReportRepair === 'object'
        ? current.value.matchReportRepair : {};
      const { providerCircuit: retiredProviderCircuit, ...repairWithoutProviderCircuit } = repair;
      const quotaPolicyChanged = repair.quotaPolicyVersion !== REPORT_GENERATION_QUOTA_POLICY_VERSION;
      if (quotaPolicyChanged || retiredProviderCircuit) {
        if (quotaPolicyChanged) {
          releasedReportGenerationHolds = await store.requeueDeferredUsageLimitedJobs({
            sourceTypes: GENERATED_EDITORIAL_SOURCE_TYPES,
            limit: REPORT_GENERATION_RECOVERY_DAILY_LIMITS.maxGenerationsPerDay || 20,
          });
        }
        await store.updateState((state) => ({
          ...state,
          matchReportRepair: {
            ...repairWithoutProviderCircuit,
            quotaPolicyVersion: REPORT_GENERATION_QUOTA_POLICY_VERSION,
            quotaPolicyAppliedAt: new Date(now()).toISOString(),
            generationEngine: 'deterministic-api-football-v1',
            ...(retiredProviderCircuit ? {
              retiredProviderCircuitAt: new Date(now()).toISOString(),
              retiredProviderCircuitReason: 'external_generation_dependency_removed',
            } : {}),
          },
        }));
      }
    } catch (_error) {
      // The next authenticated minute worker retries the release.  Existing
      // jobs remain durable and no source/public content is altered here.
      releasedReportGenerationHolds = { state: 'unavailable' };
    }
  }

  // Generation is deliberately isolated from the short source-delivery drain.
  // Only one ready fixture is claimed in this 300-second lane; normal
  // editorial delivery resumes on the next minute when no generator is
  // ready. Both composers use only verified provider data and their shared
  // durable attempt/version ceilings, so no external text-generation circuit
  // or reader request can create a duplicate source page.
  const readyGenerationSourceTypes = editorialContinuation
    ? [...new Set((await store.readQueue()).value.items
      .filter((item) => (
        GENERATED_EDITORIAL_SOURCE_TYPES.includes(item?.sourceType)
        && !item.leaseOwner
        && Date.parse(item.availableAt || '') <= new Date(now()).getTime()
      ))
      .map((item) => item.sourceType))]
    : [];
  const generationWorkReady = readyGenerationSourceTypes.length > 0;
  const monitorTrigger = generationWorkReady
    ? readyGenerationSourceTypes.includes(REPORT_GENERATION_SOURCE_TYPE)
      ? 'report_generation'
      : 'prediction_generation'
    : (runMatchEditorialBackfill || (editorialContinuation && collectMatchEditorialBackfill))
    ? 'match_editorial_backfill'
    : editorialContinuation ? 'editorial_continuation'
      : continuation ? 'continuation'
        : cron ? 'cron'
          : recheckDeployment ? 'manual_deployment_recheck'
            : recheckArticleId ? 'manual_article_recheck'
              : resyncPageId ? 'manual_page_resync'
                : 'manual';
  const result = await runMonitor({
    store,
    trigger: monitorTrigger,
    ...(deploymentId ? { deploymentId } : {}),
    ...(targetJobId ? { onlyJobIds: [targetJobId] } : {}),
    // A full manual editorial recovery must never consume its elevated
    // allowance on another monitor lane. Normal Cron remains unfiltered so
    // it can drain legacy work and every supported source as before.
    ...(generationWorkReady ? {
      claimSourceTypes: readyGenerationSourceTypes,
      claimDeliveryOnly: false,
    } : runMatchEditorialBackfill ? {
      claimSourceTypes: MATCH_EDITORIAL_SOURCE_TYPES,
      claimDeliveryOnly: true,
    } : editorialContinuation ? {
      claimSourceTypes: MATCH_EDITORIAL_SOURCE_TYPES,
      // A signed production promotion first creates a durable deployment
      // validation, which then creates its own article-validation jobs. Let
      // this authenticated minute worker drain only those internal kinds in
      // addition to its two source lanes, so Production verification starts
      // promptly instead of waiting for the next hourly general Cron. A
      // confirmed notification 429 also gets its one durable retry here;
      // this lane never replays ambiguous notification writes.
      claimJobKinds: ['deployment_validation', 'article_validation', 'notification_delivery'],
      claimDeliveryOnly: true,
    } : {
      // Source-page creation is never safe in the short generic monitor: it
      // needs the authenticated 285-second lane and its separate recovery
      // budget. Without this exclusion a regular Cron can repeatedly defer a
      // generator behind its smaller routine write cap.
      excludeSourceTypes: GENERATED_EDITORIAL_SOURCE_TYPES,
    }),
    settings: generationWorkReady ? {
      ...settings,
      allowExtendedRun: true,
      maxJobsPerRun: 1,
      maxRunMs: 285_000,
      // Verified provider reads and deterministic composition leave a
      // substantial durable Notion/sync tail without requiring the former
      // model-call budget.
      minJobStartMs: 90_000,
      // Browser verification is a separate, durable follow-up after the
      // source page and public mirror are safely written.
      browserEnabled: false,
      maxApiCallsPerRun: Math.max(settings.maxApiCallsPerRun, 180),
      maxApiCallsPerDay: Math.max(settings.maxApiCallsPerDay, REPORT_GENERATION_RECOVERY_DAILY_LIMITS.maxApiCallsPerDay),
      maxProviderRequestsPerDay: Math.max(settings.maxProviderRequestsPerDay, REPORT_GENERATION_RECOVERY_DAILY_LIMITS.maxProviderRequestsPerDay),
      maxGenerationsPerDay: Math.max(settings.maxGenerationsPerDay, REPORT_GENERATION_RECOVERY_DAILY_LIMITS.maxGenerationsPerDay),
      maxRepairsPerDay: Math.max(settings.maxRepairsPerDay, REPORT_GENERATION_RECOVERY_DAILY_LIMITS.maxRepairsPerDay),
      maxBrowserLaunchesPerDay: Math.max(settings.maxBrowserLaunchesPerDay, REPORT_GENERATION_RECOVERY_DAILY_LIMITS.maxBrowserLaunchesPerDay),
    } : runMatchEditorialBackfill || editorialContinuation
      ? {
        ...settings,
        // The authenticated full-backfill path and its dedicated continuation
        // Cron are both bounded below the Function ceiling, do no browser
        // work for source jobs, and retain the same Notion retry/rate-limit
        // guards.  Giving the continuation the same finite batch allowance
        // prevents a large, already-durable editorial backlog from being
        // artificially limited to the ordinary ten-job monitoring batch.
        maxJobsPerRun: Math.max(settings.maxJobsPerRun, 40),
        maxRunMs: Math.max(settings.maxRunMs, 100_000),
        minJobStartMs: 5_000,
        maxApiCallsPerRun: Math.max(settings.maxApiCallsPerRun, 500),
        // The normal daily budget intentionally limits unattended Cron. A
        // separately authenticated all-source backfill has a larger but
        // still finite allowance so an existing backlog cannot be stranded
        // behind yesterday's routine usage. This does not affect any reader
        // request or automatic trigger.
        maxApiCallsPerDay: Math.max(settings.maxApiCallsPerDay, MANUAL_EDITORIAL_BACKFILL_DAILY_LIMITS.maxApiCallsPerDay),
        maxRepairsPerDay: Math.max(settings.maxRepairsPerDay, MANUAL_EDITORIAL_BACKFILL_DAILY_LIMITS.maxRepairsPerDay),
      }
      : isManualTargetedRun ? { ...settings, maxJobsPerRun: 1 }
        // Vercel executes configured Cron paths only from Production. Do not
        // depend on an optional system environment variable being exposed to
        // the Function when applying this finite server-side visual budget.
        : primaryCron ? {
          ...settings,
          maxBrowserLaunchesPerDay: Math.max(
            settings.maxBrowserLaunchesPerDay,
            PRODUCTION_DEPLOYMENT_BROWSER_VALIDATION_LIMIT,
          ),
        }
          : settings,
    // Keep reader-facing Notion traffic bounded to the regular hourly
    // collection. The editorial minute worker may collect only while a
    // source-controlled recovery generation is incomplete; otherwise both
    // continuations claim work that is already durable.
    collect: generationWorkReady ? false
      : editorialContinuation
      ? collectMatchEditorialBackfill
      : continuation ? false
        : runMatchEditorialBackfill ? collectMatchEditorialBackfill
          : !isManualTargetedRun,
    now,
  });
  // Candidate reporting is deliberately independent from delivery success:
  // this Blob-only diagnostic never deletes, chooses between, or rewrites
  // articles. A first deployment scans the small public archive once;
  // subsequent successful jobs refresh only their own fixture row.
  let editorialDuplicateCandidates = null;
  try {
    if (scanEditorialDuplicateCandidates) {
      editorialDuplicateCandidates = await scanDuplicateCandidates({
        store,
        listArticles: listPublicArticles,
        now,
      });
    } else {
      editorialDuplicateCandidates = await refreshDuplicateCandidates({
        store,
        listArticles: listPublicArticles,
        articles: (result.jobs || []).map((job) => job?.result?.article).filter(Boolean),
        now,
      });
    }
  } catch (_error) {
    // Archive candidate reporting must never turn a healthy Notion delivery
    // into a reader-visible failure. The next minute worker retries a pending
    // baseline; incremental updates leave the last known candidate intact.
    editorialDuplicateCandidates = { state: 'unavailable' };
  }
  // Keep a compact, non-secret execution trail in the server log.  It is
  // deliberately limited to durable identifiers/counts/outcomes: no Notion
  // body, source URL, token, or provider payload is emitted.  This lets the
  // separate Vercel log channel prove that a scheduled repair actually ran
  // instead of treating an HTTP response code as monitor success.
  console.info('[site-monitor] cycle', JSON.stringify({
    trigger: monitorTrigger,
    status: result.status,
    runId: result.runId || null,
    jobs: (result.jobs || []).map((job) => ({
      jobId: job.jobId || null,
      queueStatus: job.status || null,
      state: job.result?.state || null,
      reason: job.result?.reason || null,
      fixtureId: job.result?.reportGeneration?.fixtureId || job.result?.predictionGeneration?.fixtureId || job.result?.fixture?.id || job.fixtureId || null,
      outcome: job.result?.reportGeneration?.outcome || job.result?.predictionGeneration?.outcome || null,
      // A fixed error class is operationally useful for the server browser
      // runtime, without ever logging the raw browser message (which may
      // contain deployment paths or a future library's request details).
      browserStatus: safeId(job.result?.browser?.status, 80),
      browserReason: safeId(job.result?.browser?.reason, 80),
      browserRuntimeFailure: job.result?.browser?.runtimeFailure || null,
      // Never log a raw launch exception: it may contain a deployment path,
      // URL, or a future library's request details. Keep only a fixed class.
      browserErrorCode: browserErrorCode(job.result?.browser?.error),
      notificationState: safeId(job.notification?.delivery?.state, 80),
      notificationRetryJobId: safeId(job.notification?.delivery?.retryJobId, 80),
      notificationDeliveryState: safeId(job.notificationDelivery?.value?.deliveries?.at?.(-1)?.state, 80),
      quota: job.result?.state === 'quota_exceeded' ? (() => {
        const quota = job.result?.details?.quota || job.result?.details || {};
        return {
          exceeded: safeId(quota.exceeded, 80),
          usage: quota.usage && typeof quota.usage === 'object' ? quota.usage : null,
          requested: quota.requested && typeof quota.requested === 'object' ? quota.requested : null,
        };
      })() : null,
    })),
    reportScan: missingReportScan ? {
      state: missingReportScan.state || null,
      finishedFixtures: Number(missingReportScan.finishedFixtures || 0),
      missingReports: Number(missingReportScan.missingReports || 0),
      queued: Array.isArray(missingReportScan.queued) ? missingReportScan.queued.length : 0,
      reason: missingReportScan.reason || null,
    } : null,
    predictionScan: missingPredictionScan ? {
      state: missingPredictionScan.state || null,
      scheduledFixtures: Number(missingPredictionScan.scheduledFixtures || 0),
      missingPredictions: Number(missingPredictionScan.missingPredictions || 0),
      queued: Array.isArray(missingPredictionScan.queued)
        ? missingPredictionScan.queued.length
        : Number(missingPredictionScan.queued || 0),
      reason: missingPredictionScan.reason || null,
    } : null,
    // Source reconciliation is the evidence that an editorial recovery
    // actually queried Notion, rather than merely draining an old queue. Log
    // only aggregate type/count/outcome data; page IDs, article bodies, and
    // provider responses remain in the protected durable store.
    editorialBackfill: result.collected?.backfill ? (() => {
      const backfill = result.collected.backfill;
      const types = Object.fromEntries(Object.entries(backfill.types || {}).map(([type, outcome]) => [type, {
        state: safeId(outcome?.state, 80),
        pages: Number(outcome?.pages || 0),
        queued: Number(outcome?.queued || 0),
        duplicate: Number(outcome?.duplicate || 0),
        skipped: Number(outcome?.skipped || 0),
        complete: outcome?.complete === true,
      }]));
      return {
        state: safeId(backfill.state, 80),
        pages: Number(backfill.pages || 0),
        queued: Number(backfill.queued || 0),
        duplicate: Number(backfill.duplicate || 0),
        skipped: Number(backfill.skipped || 0),
        types,
      };
    })() : null,
    releasedReportGenerationHolds,
  }));
  noStore(res);
  return res.status(result.status === 'failed' ? 500 : result.status === 'attention' ? 503 : 200).json({
    ...compactRun(result),
    ...(missingPredictionScan ? { missingPredictionScan } : {}),
    ...(missingReportScan ? { missingReportScan } : {}),
    ...(editorialRulesetReconciliation ? { editorialRulesetReconciliation } : {}),
    ...(editorialDuplicateCandidates ? { editorialDuplicateCandidates } : {}),
  });
}

export default async function handler(req, res) {
  return respondWithSiteMonitor(req, res);
}

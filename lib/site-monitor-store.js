// Durable state for the AM4 site monitor.  This module deliberately uses
// conditional Vercel Blob writes instead of process memory: Cron, webhooks
// and concurrent Function instances must observe the same queue and lock.

import { createHash, randomUUID } from 'node:crypto';
import './blob-environment.js';
import { del, get, put } from '@vercel/blob';

const PREFIX = 'site-monitor/';
const CONTENT_TYPE = 'application/json; charset=utf-8';
const DEFAULT_CAS_RETRIES = 6;
const HISTORY_LIMIT = 500;
const EDITORIAL_INTERLEAVE_PRIORITY_CEILING = 80;

function iso(now = new Date()) {
  return new Date(now).toISOString();
}

function positiveInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : fallback;
}

function safeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function siteMonitorDigest(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

export function siteMonitorPath(name) {
  return `${PREFIX}${String(name || '').replace(/^\/+/, '')}`;
}

export class SiteMonitorConflictError extends Error {
  constructor(message = 'Site monitor state changed concurrently') {
    super(message);
    this.name = 'SiteMonitorConflictError';
  }
}

function isConditionalWriteConflict(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return error?.status === 412
    || error?.statusCode === 412
    || /precondition|etag|condition.*fail|already exists|conflict/.test(text);
}

async function responseText(result) {
  if (!result?.stream) return null;
  return new Response(result.stream).text();
}

function queueDefault() {
  return { version: 1, updatedAt: null, items: [], history: [] };
}

function stateDefault() {
  return {
    version: 1,
    updatedAt: null,
    // `cursors` is the durable continuation of an interrupted Notion list
    // query. Keep it alongside checkpoints and Retry-After windows; dropping
    // it would restart at page one and could starve later new/updated pages.
    collector: { checkpoints: {}, notBefore: {}, cursors: {} },
    usage: { day: null, apiCalls: 0, providerRequests: 0, browserLaunches: 0, repairOperations: 0, generations: 0 },
    lastRun: null,
    lastSuccessfulRunAt: null,
  };
}

function normaliseQueue(value) {
  const source = safeObject(value, queueDefault());
  return {
    version: 1,
    updatedAt: source.updatedAt || null,
    items: Array.isArray(source.items) ? source.items.filter((item) => item?.jobId) : [],
    history: Array.isArray(source.history) ? source.history.slice(-HISTORY_LIMIT) : [],
  };
}

function normaliseState(value) {
  const source = safeObject(value, stateDefault());
  const usage = safeObject(source.usage);
  const collector = safeObject(source.collector);
  return {
    ...stateDefault(),
    ...source,
    collector: {
      checkpoints: safeObject(collector.checkpoints),
      // A Notion 429's Retry-After survives a Function restart. The next
      // collector invocation must not issue an early request merely because
      // it landed on another warm instance.
      notBefore: safeObject(collector.notBefore),
      // An opaque Notion cursor plus the original overlap boundary. This is
      // source progress, not cache: it must survive CAS normalization and a
      // new Function instance before the next source request is issued.
      cursors: safeObject(collector.cursors),
    },
    usage: {
      day: typeof usage.day === 'string' ? usage.day : null,
      apiCalls: positiveInteger(usage.apiCalls),
      providerRequests: positiveInteger(usage.providerRequests),
      browserLaunches: positiveInteger(usage.browserLaunches),
      repairOperations: positiveInteger(usage.repairOperations),
      generations: positiveInteger(usage.generations),
    },
  };
}

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function effectivePriority(item, now) {
  // A high-priority webhook can jump the queue briefly, but every hour a
  // waiting item gains one point so old work cannot starve forever.
  const ageHours = Math.max(0, Math.floor((now - timestamp(item.createdAt)) / (60 * 60 * 1000)));
  return positiveInteger(item.priority) + ageHours;
}

function queueSort(now, preferredSourceTypes = null) {
  const sourceRanks = new Map((Array.isArray(preferredSourceTypes) ? preferredSourceTypes : [])
    .filter((sourceType) => typeof sourceType === 'string' && sourceType)
    .map((sourceType, index) => [sourceType, index]));
  const sourceRank = (item) => sourceRanks.get(item?.sourceType) ?? sourceRanks.size;
  return (left, right) => {
    const leftBasePriority = positiveInteger(left.priority);
    const rightBasePriority = positiveInteger(right.priority);
    const leftPriority = effectivePriority(left, now);
    const rightPriority = effectivePriority(right, now);
    const sourcePreference = sourceRank(left) - sourceRank(right);
    // A filtered editorial drain alternates its normal source/reconciliation
    // priorities (70/45), not just exact ties. Otherwise a pre-existing
    // report queue can still starve all predictions. Use the configured base
    // priority for the urgent-work boundary: age raises ordinary work so it
    // is eventually served globally, but must not turn a week-old report into
    // a faux webhook that permanently bypasses the prediction lane.
    if (
      sourceRanks.size
      && sourcePreference
      && Math.max(leftBasePriority, rightBasePriority) < EDITORIAL_INTERLEAVE_PRIORITY_CEILING
    ) return sourcePreference;
    return leftPriority === rightPriority
      ? timestamp(left.createdAt) - timestamp(right.createdAt)
        || String(left.jobId).localeCompare(String(right.jobId))
      : rightPriority - leftPriority;
  };
}

function dailyKey(now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(now));
}

function jobPath(jobId) {
  return siteMonitorPath(`jobs/${encodeURIComponent(String(jobId))}.json`);
}

function eventPath(eventId) {
  return siteMonitorPath(`events/${encodeURIComponent(String(eventId))}.json`);
}

function runPath(runId) {
  return siteMonitorPath(`runs/${encodeURIComponent(String(runId))}.json`);
}

function alertPath(key) {
  return siteMonitorPath(`alerts/${encodeURIComponent(String(key))}.json`);
}

export function createSiteMonitorStore({
  blob = { get, put, del },
  now = () => new Date(),
  uuid = randomUUID,
  casRetries = DEFAULT_CAS_RETRIES,
  logger = console,
} = {}) {
  async function readJson(path) {
    const result = await blob.get(path, { access: 'private', useCache: false });
    if (!result?.stream) return { value: null, etag: null };
    const text = await responseText(result);
    try {
      return { value: JSON.parse(text), etag: result.etag || null };
    } catch (error) {
      throw new Error(`Invalid JSON in durable monitor record ${path}: ${error.message}`);
    }
  }

  async function writeJson(path, value, { etag = null, create = false } = {}) {
    const options = {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: !create,
      contentType: CONTENT_TYPE,
      ...(etag ? { ifMatch: etag } : {}),
    };
    return blob.put(path, JSON.stringify(value), options);
  }

  async function updateJson(path, defaultValue, mutate) {
    let lastConflict = null;
    for (let attempt = 0; attempt < casRetries; attempt += 1) {
      const current = await readJson(path);
      const base = current.value == null ? defaultValue() : current.value;
      const next = await mutate(base, current);
      if (next == null) return { value: base, etag: current.etag, changed: false };
      try {
        const result = await writeJson(path, next, {
          etag: current.etag,
          create: current.value == null,
        });
        return { value: next, etag: result?.etag || null, changed: true };
      } catch (error) {
        if (!isConditionalWriteConflict(error)) throw error;
        lastConflict = error;
      }
    }
    throw new SiteMonitorConflictError(lastConflict?.message);
  }

  async function readState() {
    const current = await readJson(siteMonitorPath('state.json'));
    return { ...current, value: normaliseState(current.value) };
  }

  async function updateState(mutate) {
    return updateJson(siteMonitorPath('state.json'), stateDefault, async (value, current) => {
      const next = await mutate(normaliseState(value), current);
      if (next == null) return null;
      return { ...normaliseState(next), updatedAt: iso(now()) };
    });
  }

  async function readQueue() {
    const current = await readJson(siteMonitorPath('queue.json'));
    return { ...current, value: normaliseQueue(current.value) };
  }

  async function updateQueue(mutate) {
    return updateJson(siteMonitorPath('queue.json'), queueDefault, async (value, current) => {
      const next = await mutate(normaliseQueue(value), current);
      if (next == null) return null;
      return { ...normaliseQueue(next), updatedAt: iso(now()) };
    });
  }

  async function readJob(jobId) {
    return readJson(jobPath(jobId));
  }

  async function writeJob(job, { create = false, etag = null } = {}) {
    if (!job?.id) throw new Error('A monitor job id is required');
    const value = { ...job, updatedAt: iso(now()) };
    const result = await writeJson(jobPath(job.id), value, { create, etag });
    return { value, etag: result?.etag || null };
  }

  async function updateJob(jobId, mutate) {
    return updateJson(jobPath(jobId), () => null, async (value, current) => {
      if (!value) return null;
      const next = await mutate(value, current);
      return next == null ? null : { ...next, updatedAt: iso(now()) };
    });
  }

  async function enqueue(input = {}) {
    const createdAt = input.createdAt || iso(now());
    const identity = {
      kind: input.kind || 'notion_page',
      pageId: input.pageId || null,
      fixtureId: input.fixtureId || null,
      sourceType: input.sourceType || null,
      sourceVersion: input.sourceVersion || null,
      deploymentId: input.deploymentId || null,
    };
    // Preserve the historical identity for ordinary jobs so upgrading the
    // monitor cannot re-enqueue an already durable source version. Only an
    // explicit authenticated recheck gets an additional identity component.
    // Article-validation jobs must additionally retain their target: unlike a
    // Notion page job, they do not have a pageId from which it can be rebuilt.
    if (input.articleId) identity.articleId = input.articleId;
    if (input.validationId) identity.validationId = input.validationId;
    if (input.verificationOnly === true) identity.verificationOnly = true;
    // Delivery-only jobs prove the persisted reader contract first.  Keep
    // their identity separate from a visual-only monitor pass so a browser
    // outage can never deduplicate or block a source-content sync.
    if (input.deliveryOnly === true) identity.deliveryOnly = true;
    // A repair generation is deliberately code-owned (never request input).
    // It permits one fresh, bounded execution when a known repair algorithm
    // itself has been corrected, without reopening ordinary terminal jobs.
    if (input.repairGeneration) identity.repairGeneration = input.repairGeneration;
    const id = input.id || siteMonitorDigest(identity).slice(0, 40);
    const initial = {
      version: 1,
      id,
      ...identity,
      articleId: input.articleId || null,
      validationId: input.validationId || null,
      verificationOnly: input.verificationOnly === true,
      deliveryOnly: input.deliveryOnly === true,
      repairGeneration: input.repairGeneration || null,
      trigger: input.trigger || 'cron',
      createdAt,
      updatedAt: createdAt,
      status: 'queued',
      priority: positiveInteger(input.priority),
      attempts: 0,
      repairAttempts: 0,
      generationAttempts: 0,
      transportRetries: 0,
      payload: safeObject(input.payload),
      snapshotIds: [],
      result: null,
      lastError: null,
    };

    let existing = await readJob(id);
    if (!existing.value) {
      try {
        existing = await writeJob(initial, { create: true });
      } catch (error) {
        if (!isConditionalWriteConflict(error)) throw error;
        existing = await readJob(id);
      }
    }
    const job = existing.value || initial;
    // A complete/blocked version remains deduplicated. A newer Notion version
    // has a different id and is independently eligible for repair.
    if (['completed', 'blocked', 'failed'].includes(job.status)) return { job, enqueued: false, duplicate: true };

    let added = false;
    let metadataMigrated = false;
    await updateQueue((queue) => {
      const present = queue.items.find((item) => item.jobId === id);
      if (present) {
        // Queue metadata is a non-authoritative projection of the durable job.
        // Safely fill it when a newer worker sees a legacy queue item so a
        // source-filtered recovery can claim the same existing source version.
        const sourceType = typeof input.sourceType === 'string' ? input.sourceType : null;
        const kind = input.kind || 'notion_page';
        const deliveryOnly = input.deliveryOnly === true;
        if ((!present.sourceType && sourceType) || (!present.kind && kind) || (deliveryOnly && present.deliveryOnly !== true)) {
          metadataMigrated = true;
          return {
            ...queue,
            items: queue.items.map((item) => item.jobId !== id ? item : {
              ...item,
              ...(item.sourceType ? {} : { sourceType }),
              ...(item.kind ? {} : { kind }),
              ...(deliveryOnly ? { deliveryOnly: true } : {}),
            }),
          };
        }
        return queue;
      }
      added = true;
      return {
        ...queue,
        items: [...queue.items, {
          jobId: id,
          createdAt,
          availableAt: input.availableAt || createdAt,
          priority: positiveInteger(input.priority),
          sourceType: typeof input.sourceType === 'string' ? input.sourceType : null,
          kind: input.kind || 'notion_page',
          deliveryOnly: input.deliveryOnly === true,
          leaseOwner: null,
          leaseUntil: null,
        }],
      };
    });
    return { job, enqueued: added, duplicate: !added, metadataMigrated };
  }

  async function claimJobs({
    owner = uuid(),
    limit = 10,
    leaseMs = 8 * 60 * 1000,
    jobIds = null,
    sourceTypes = null,
    kinds = null,
    excludeSourceTypes = null,
    preferredSourceTypes = null,
    deliveryOnly = null,
  } = {}) {
    const claimAt = new Date(now()).getTime();
    const safeLimit = Math.min(Math.max(1, positiveInteger(limit, 10)), 50);
    const requestedIds = Array.isArray(jobIds)
      ? new Set(jobIds.filter((jobId) => typeof jobId === 'string' && jobId))
      : null;
    // Source type is copied onto the queue entry so a bounded recovery can
    // claim only its intended durable lane without reading/locking unrelated
    // jobs first. Legacy entries without this field remain eligible for normal
    // Cron, but are intentionally outside a source-filtered operator run.
    const requestedSourceTypes = Array.isArray(sourceTypes)
      ? new Set(sourceTypes.filter((sourceType) => typeof sourceType === 'string' && sourceType))
      : null;
    // A bounded continuation may share its editorial source lane with a very
    // small set of monitor-owned jobs (notably production deployment visual
    // checks). This is an allow-list, never a caller-supplied execution type.
    const requestedKinds = Array.isArray(kinds)
      ? new Set(kinds.filter((kind) => typeof kind === 'string' && kind))
      : null;
    const excludedSourceTypes = Array.isArray(excludeSourceTypes)
      ? new Set(excludeSourceTypes.filter((sourceType) => typeof sourceType === 'string' && sourceType))
      : null;
    const claimed = [];
    await updateQueue((queue) => {
      const recovered = queue.items.map((item) => (
        item.leaseUntil && timestamp(item.leaseUntil) <= claimAt
          ? { ...item, leaseOwner: null, leaseUntil: null, availableAt: item.availableAt || iso(now()) }
          : item
      ));
      const candidates = recovered
        .filter((item) => {
          const sourceAllowed = requestedSourceTypes?.has(item.sourceType) === true;
          const kindAllowed = requestedKinds?.has(item.kind) === true;
          const hasLaneFilter = Boolean(requestedSourceTypes || requestedKinds);
          // Source lanes and explicitly allowed internal job kinds are a
          // union: deployment validation has no editorial source type, while
          // Notion delivery jobs intentionally retain their source filter.
          const laneAllowed = !hasLaneFilter || sourceAllowed || kindAllowed;
          const deliveryAllowed = deliveryOnly !== true || item.deliveryOnly === true || kindAllowed;
          return !item.leaseOwner
            && timestamp(item.availableAt) <= claimAt
            && (!requestedIds || requestedIds.has(item.jobId))
            && laneAllowed
            && (!excludedSourceTypes || !excludedSourceTypes.has(item.sourceType))
            && deliveryAllowed;
        })
        .sort(queueSort(claimAt, preferredSourceTypes))
        .slice(0, safeLimit);
      const candidateIds = new Set(candidates.map((item) => item.jobId));
      const leaseUntil = new Date(claimAt + leaseMs).toISOString();
      claimed.push(...candidates.map((item) => ({ ...item, leaseOwner: owner, leaseUntil })));
      return {
        ...queue,
        items: recovered.map((item) => candidateIds.has(item.jobId)
          ? { ...item, leaseOwner: owner, leaseUntil }
          : item),
      };
    });
    const jobs = [];
    for (const claimedItem of claimed) {
      const updated = await updateJob(claimedItem.jobId, (job) => {
        const terminal = ['completed', 'blocked', 'failed'].includes(job.status);
        const ownedByAnotherLiveRunner = job.leaseOwner
          && job.leaseOwner !== owner
          && timestamp(job.leaseUntil) > claimAt;
        if (terminal || ownedByAnotherLiveRunner) return null;
        return {
          ...job,
          status: 'running',
          attempts: positiveInteger(job.attempts) + 1,
          leaseOwner: owner,
          leaseUntil: claimedItem.leaseUntil,
        };
      });
      if (updated.changed && updated.value) {
        jobs.push(updated.value);
        continue;
      }
      // The queue lease can be stale while a different worker has already
      // completed, renewed, or reclaimed the authoritative job record. Only
      // clear our own queue lease; never release another worker's lease.
      const terminal = ['completed', 'blocked', 'failed'].includes(updated.value?.status);
      await updateQueue((queue) => ({
        ...queue,
        items: queue.items.flatMap((item) => {
          if (item.jobId !== claimedItem.jobId || item.leaseOwner !== owner) return [item];
          return terminal ? [] : [{ ...item, leaseOwner: null, leaseUntil: null }];
        }),
      }));
    }
    return { owner, jobs };
  }

  // Older queue entries predate the lightweight source/delivery metadata used
  // for a filtered backfill. Hydrate a bounded page of those fields only from
  // the authoritative job records; never infer a source type from an ID or
  // title. A caller persists `nextCursor` and resumes another page if needed.
  async function migrateQueuedMetadata({ sourceTypes = null, kinds = null, deliveryOnly = null, afterJobId = null, limit = 200 } = {}) {
    const requestedSourceTypes = Array.isArray(sourceTypes)
      ? new Set(sourceTypes.filter((sourceType) => typeof sourceType === 'string' && sourceType))
      : null;
    const requestedKinds = Array.isArray(kinds)
      ? new Set(kinds.filter((kind) => typeof kind === 'string' && kind))
      : null;
    const safeLimit = Math.min(Math.max(1, positiveInteger(limit, 200)), 500);
    if (!requestedSourceTypes?.size && !requestedKinds?.size) return { scanned: 0, migrated: 0, nextCursor: null, complete: true };
    const queue = (await readQueue()).value;
    const cursor = typeof afterJobId === 'string' && afterJobId ? afterJobId : null;
    const candidates = queue.items
      .filter((item) => {
        const sourceAllowed = requestedSourceTypes?.has(item.sourceType) === true;
        // Legacy deployment/article validation entries have no source type,
        // so include that bounded subset when an internal job-kind allow-list
        // is requested. A full job read below remains authoritative.
        const kindMayBeAllowed = requestedKinds?.size && !item.kind && (!item.sourceType || sourceAllowed);
        const sourceMetadataMissing = !item.sourceType && requestedSourceTypes?.size;
        const deliveryMetadataMissing = deliveryOnly === true && sourceAllowed && item.deliveryOnly !== true;
        return (sourceMetadataMissing || kindMayBeAllowed || deliveryMetadataMissing)
          && (!cursor || String(item.jobId) > cursor);
      })
      .sort((left, right) => String(left.jobId).localeCompare(String(right.jobId)))
      .slice(0, safeLimit);
    if (!candidates.length) return { scanned: 0, migrated: 0, nextCursor: null, complete: true };

    const resolved = [];
    // Bound Blob reads too: queue metadata migration must not turn a recovery
    // request into an unbounded fan-out over a legacy backlog.
    for (let offset = 0; offset < candidates.length; offset += 10) {
      const batch = candidates.slice(offset, offset + 10);
      const values = await Promise.all(batch.map(async (item) => ({ item, job: (await readJob(item.jobId)).value })));
      resolved.push(...values);
    }
    const metadata = new Map(resolved.flatMap(({ item, job }) => {
      const sourceAllowed = requestedSourceTypes?.has(job?.sourceType) === true;
      const kindAllowed = requestedKinds?.has(job?.kind) === true;
      if (!job || (!sourceAllowed && !kindAllowed) || (deliveryOnly === true && job.deliveryOnly !== true && !kindAllowed)) return [];
      return [[item.jobId, {
        sourceType: job.sourceType || null,
        kind: job.kind || null,
        deliveryOnly: job.deliveryOnly === true,
      }]];
    }));
    let migrated = 0;
    if (metadata.size) {
      await updateQueue((current) => {
        const items = current.items.map((item) => {
          const next = metadata.get(item.jobId);
          if (!next) return item;
          const changed = (!item.sourceType && next.sourceType)
            || (!item.kind && next.kind)
            || (next.deliveryOnly && item.deliveryOnly !== true);
          if (!changed) return item;
          migrated += 1;
          return {
            ...item,
            ...(item.sourceType ? {} : { sourceType: next.sourceType }),
            ...(item.kind ? {} : { kind: next.kind }),
            ...(next.deliveryOnly ? { deliveryOnly: true } : {}),
          };
        });
        return migrated ? { ...current, items } : current;
      });
    }
    const nextCursor = String(candidates.at(-1)?.jobId || '') || null;
    return {
      scanned: candidates.length,
      migrated,
      nextCursor: candidates.length >= safeLimit ? nextCursor : null,
      complete: candidates.length < safeLimit,
    };
  }

  async function renewLease(jobId, owner, leaseMs = 8 * 60 * 1000) {
    const renewalAt = new Date(now()).getTime();
    const expires = new Date(new Date(now()).getTime() + leaseMs).toISOString();
    const job = await updateJob(jobId, (value) => {
      if (
        value.leaseOwner !== owner
        || value.status !== 'running'
        || timestamp(value.leaseUntil) <= renewalAt
      ) return null;
      return { ...value, leaseUntil: expires };
    });
    if (!job.changed) return false;
    await updateQueue((queue) => ({
      ...queue,
      items: queue.items.map((item) => item.jobId === jobId && item.leaseOwner === owner
        ? { ...item, leaseUntil: expires }
        : item),
    }));
    return true;
  }

  async function finishJob(jobId, {
    owner,
    status = 'completed',
    result = null,
    error = null,
    repairAttempts = null,
  } = {}) {
    if (!owner) throw new Error('A lease owner is required to finish a monitor job');
    const finishedAt = iso(now());
    const finishAt = new Date(now()).getTime();
    const finalized = await updateJob(jobId, (job) => {
      // A worker which lost or outlived its lease must not erase the queue
      // entry claimed by a replacement worker.
      if (job.leaseOwner !== owner || job.status !== 'running' || timestamp(job.leaseUntil) <= finishAt) return null;
      return {
        ...job,
        status,
        finishedAt,
        leaseOwner: null,
        leaseUntil: null,
        ...(repairAttempts == null ? {} : { repairAttempts: positiveInteger(repairAttempts) }),
        result,
        lastError: error ? String(error).slice(0, 500) : null,
      };
    });
    if (!finalized.changed) return null;
    await updateQueue((queue) => {
      const removed = queue.items.find((item) => item.jobId === jobId && item.leaseOwner === owner);
      const history = removed ? [...queue.history, {
        jobId,
        status,
        finishedAt,
        sourceVersion: finalized.value?.sourceVersion || null,
        error: error ? String(error).slice(0, 240) : null,
      }].slice(-HISTORY_LIMIT) : queue.history;
      return {
        ...queue,
        items: queue.items.filter((item) => !(item.jobId === jobId && item.leaseOwner === owner)),
        history,
      };
    });
    return finalized.value;
  }

  async function deferJob(jobId, {
    owner,
    reason = 'retryable_error',
    delayMs = 60_000,
    transportRetry = false,
    repairAttempts = null,
  } = {}) {
    if (!owner) throw new Error('A lease owner is required to defer a monitor job');
    const availableAt = new Date(new Date(now()).getTime() + Math.max(1_000, delayMs)).toISOString();
    const deferAt = new Date(now()).getTime();
    const deferred = await updateJob(jobId, (job) => {
      if (job.leaseOwner !== owner || job.status !== 'running' || timestamp(job.leaseUntil) <= deferAt) return null;
      return {
        ...job,
        status: 'queued',
        leaseOwner: null,
        leaseUntil: null,
        transportRetries: positiveInteger(job.transportRetries) + (transportRetry ? 1 : 0),
        ...(repairAttempts == null ? {} : { repairAttempts: positiveInteger(repairAttempts) }),
        lastError: String(reason).slice(0, 500),
      };
    });
    if (!deferred.changed) return null;
    await updateQueue((queue) => ({
      ...queue,
      items: queue.items.map((item) => item.jobId === jobId && item.leaseOwner === owner
        ? { ...item, leaseOwner: null, leaseUntil: null, availableAt }
        : item),
    }));
    return deferred.value;
  }

  // A daily usage hold is normally released at the next Tokyo midnight.  A
  // reviewed, code-owned quota policy can safely make a held class eligible
  // earlier without manufacturing a second job identity or spending another
  // repair attempt.  Keep this deliberately narrow: only queued, unleased
  // jobs whose last transition was `usage_limit` are touched.
  async function requeueDeferredUsageLimitedJobs({
    sourceTypes = null,
    reasons = ['usage_limit'],
    limit = 50,
  } = {}) {
    const wakeAt = new Date(now()).getTime();
    const allowedSourceTypes = Array.isArray(sourceTypes)
      ? new Set(sourceTypes.filter((sourceType) => typeof sourceType === 'string' && sourceType))
      : null;
    const allowedReasons = new Set((Array.isArray(reasons) ? reasons : ['usage_limit'])
      .filter((reason) => typeof reason === 'string' && reason));
    const queue = await readQueue();
    const candidates = queue.value.items
      .filter((item) => !item?.leaseOwner
        && timestamp(item.availableAt) > wakeAt
        && (!allowedSourceTypes || allowedSourceTypes.has(item.sourceType)))
      .slice(0, Math.min(50, Math.max(1, positiveInteger(limit, 50))));
    const released = [];
    for (const item of candidates) {
      const updated = await updateJob(item.jobId, (job) => {
        if (
          !job
          || job.status !== 'queued'
          || job.leaseOwner
          || !allowedReasons.has(job.lastError)
        ) return null;
        return { ...job, lastError: `${job.lastError}_released` };
      });
      if (updated.changed && updated.value) released.push(item.jobId);
    }
    if (!released.length) return { requeued: 0, jobIds: [] };
    const releasedIds = new Set(released);
    const availableAt = iso(now());
    await updateQueue((current) => ({
      ...current,
      items: current.items.map((item) => (
        releasedIds.has(item.jobId) && !item.leaseOwner && timestamp(item.availableAt) > wakeAt
          ? { ...item, availableAt }
          : item
      )),
    }));
    return { requeued: released.length, jobIds: released };
  }

  // A browser launch limit is a daily scheduling hold, not a failed visual
  // assertion or an unavailable Chromium runtime. Older monitor versions
  // terminally recorded this one specific condition. Re-open only those exact
  // durable records after the queue writer lock has been acquired by the
  // caller; never broaden this into a generic retry of blocked jobs.
  //
  // The job identity, repair-attempt count, source version, and prior visual
  // result remain intact. The caller supplies the next JST-midnight wake time
  // so the repaired projection cannot immediately spend a browser launch over
  // the same daily cap.
  async function requeueBlockedBrowserQuotaJobs({ availableAt = null, limit = 50 } = {}) {
    const targetAvailableAt = timestamp(availableAt) > 0
      ? new Date(timestamp(availableAt)).toISOString()
      : iso(now());
    const queue = await readQueue();
    const candidateIds = [...new Set(queue.value.history
      .filter((entry) => entry?.status === 'blocked' && entry?.error === 'browser_quota_exceeded')
      .map((entry) => entry.jobId)
      .filter((jobId) => typeof jobId === 'string' && jobId)
      .slice(-Math.min(50, Math.max(1, positiveInteger(limit, 50))))
      .reverse())];
    if (!candidateIds.length) return { requeued: 0, jobIds: [] };

    const eligible = [];
    for (const jobId of candidateIds) {
      const current = await readJob(jobId);
      const job = current.value;
      if (
        job
        && job.status === 'blocked'
        && job.lastError === 'browser_quota_exceeded'
        && job.result?.state === 'browser_unavailable'
        && job.result?.browser?.reason === 'browser_quota_exceeded'
      ) eligible.push(job);
    }
    if (!eligible.length) return { requeued: 0, jobIds: [] };

    // Persist the non-authoritative queue projection *before* changing the
    // authoritative job status. If this Function stops between the two Blob
    // writes, the job is still blocked with its original exact marker and the
    // next lock holder can safely project it again. The opposite order would
    // leave a queued job permanently invisible to every worker.
    const eligibleById = new Map(eligible.map((job) => [job.id, job]));
    await updateQueue((current) => {
      const seen = new Set();
      const items = current.items.map((item) => {
        const job = eligibleById.get(item.jobId);
        if (!job) return item;
        seen.add(job.id);
        return {
          ...item,
          availableAt: targetAvailableAt,
          priority: positiveInteger(job.priority),
          sourceType: job.sourceType || null,
          kind: job.kind || 'notion_page',
          deliveryOnly: job.deliveryOnly === true,
          leaseOwner: null,
          leaseUntil: null,
        };
      });
      for (const job of eligible) {
        if (seen.has(job.id)) continue;
        items.push({
          jobId: job.id,
          createdAt: job.createdAt || iso(now()),
          availableAt: targetAvailableAt,
          priority: positiveInteger(job.priority),
          sourceType: job.sourceType || null,
          kind: job.kind || 'notion_page',
          deliveryOnly: job.deliveryOnly === true,
          leaseOwner: null,
          leaseUntil: null,
        });
      }
      return { ...current, items };
    });
    const reopened = [];
    for (const original of eligible) {
      const updated = await updateJob(original.id, (job) => {
        // Check the exact original terminal state again after the projection
        // write. A replacement state always wins; its projected item will be
        // discarded by the normal durable claim path rather than revived.
        if (
          !job
          || job.status !== 'blocked'
          || job.lastError !== 'browser_quota_exceeded'
          || job.result?.state !== 'browser_unavailable'
          || job.result?.browser?.reason !== 'browser_quota_exceeded'
        ) return null;
        return {
          ...job,
          status: 'queued',
          leaseOwner: null,
          leaseUntil: null,
          resumedAt: iso(now()),
          // This is operational metadata only; it deliberately does not
          // reset source/repair/transport counters.
          lastError: 'browser_quota_exceeded_requeued',
        };
      });
      if (updated.changed && updated.value) reopened.push(updated.value);
    }
    return { requeued: reopened.length, jobIds: reopened.map((job) => job.id) };
  }

  async function acquireLock({ name = 'runner', ttlMs = 9 * 60 * 1000, owner = uuid() } = {}) {
    const path = siteMonitorPath(`locks/${encodeURIComponent(name)}.json`);
    const acquiredAt = iso(now());
    const expiresAt = new Date(new Date(now()).getTime() + ttlMs).toISOString();
    const candidate = { version: 1, name, owner, acquiredAt, expiresAt };
    for (let attempt = 0; attempt < casRetries; attempt += 1) {
      const current = await readJson(path);
      if (!current.value) {
        try {
          const result = await writeJson(path, candidate, { create: true });
          return { ...candidate, etag: result?.etag || null, path };
        } catch (error) {
          if (!isConditionalWriteConflict(error)) throw error;
          continue;
        }
      }
      if (timestamp(current.value.expiresAt) > new Date(now()).getTime()) return null;
      try {
        const result = await writeJson(path, candidate, { etag: current.etag });
        return { ...candidate, etag: result?.etag || null, path };
      } catch (error) {
        if (!isConditionalWriteConflict(error)) throw error;
      }
    }
    return null;
  }

  async function renewLock(lock, ttlMs = 9 * 60 * 1000) {
    if (!lock?.path || !lock.owner) return null;
    let active = { ...lock };
    const renewalAt = new Date(now()).getTime();
    const expiresAt = new Date(renewalAt + ttlMs).toISOString();
    // A conditional write can race with this same worker's immediately
    // preceding renewal (or a retried transport response). Do not treat that
    // transient stale ETag as a lost lock without first reading the durable
    // record. We continue only when the owner and lock name are unchanged and
    // the existing lease has not expired; a replacement owner always wins.
    for (let attempt = 0; attempt < casRetries; attempt += 1) {
      try {
        const result = await writeJson(active.path, {
          version: 1,
          name: active.name,
          owner: active.owner,
          acquiredAt: active.acquiredAt,
          expiresAt,
        }, { etag: active.etag });
        return { ...active, expiresAt, etag: result?.etag || null };
      } catch (error) {
        if (!isConditionalWriteConflict(error)) throw error;
        const current = await readJson(active.path);
        if (
          !current.value
          || current.value.owner !== active.owner
          || current.value.name !== active.name
          || timestamp(current.value.expiresAt) <= renewalAt
        ) return null;
        active = {
          ...active,
          acquiredAt: current.value.acquiredAt || active.acquiredAt,
          etag: current.etag || null,
        };
      }
    }
    return null;
  }

  async function releaseLock(lock) {
    if (!lock?.path || !lock.etag) return false;
    try {
      await blob.del(lock.path, { ifMatch: lock.etag });
      return true;
    } catch (error) {
      if (isConditionalWriteConflict(error)) return false;
      throw error;
    }
  }

  async function recordEvent(event = {}) {
    const identity = {
      source: event.source || 'unknown',
      eventId: event.eventId || null,
      payloadDigest: event.payloadDigest || null,
      pageId: event.pageId || null,
      sourceVersion: event.sourceVersion || null,
      deploymentId: event.deploymentId || null,
      type: event.type || null,
    };
    const id = event.id || siteMonitorDigest(identity).slice(0, 48);
    const record = {
      version: 1,
      id,
      ...identity,
      receivedAt: event.receivedAt || iso(now()),
      queuedAt: event.queuedAt || null,
      metadata: safeObject(event.metadata),
    };
    try {
      const result = await writeJson(eventPath(id), record, { create: true });
      return { id, event: record, etag: result?.etag || null, duplicate: false };
    } catch (error) {
      if (!isConditionalWriteConflict(error)) throw error;
      const existing = await readJson(eventPath(id));
      return { id, event: existing.value || record, etag: existing.etag || null, duplicate: true };
    }
  }

  async function markEventQueued(id) {
    return updateJson(eventPath(id), () => null, (event) => event ? { ...event, queuedAt: iso(now()) } : null);
  }

  async function beginRun(input = {}) {
    const id = input.id || uuid();
    const record = {
      version: 1,
      id,
      trigger: input.trigger || 'manual',
      deploymentId: input.deploymentId || null,
      startedAt: iso(now()),
      status: 'running',
      usage: { apiCalls: 0, providerRequests: 0, browserLaunches: 0, repairOperations: 0, generations: 0 },
      inspected: [],
      repairs: [],
      unresolved: [],
      errors: [],
    };
    await writeJson(runPath(id), record, { create: true });
    return record;
  }

  async function finishRun(id, mutate) {
    return updateJson(runPath(id), () => null, (run) => {
      if (!run) return null;
      const next = typeof mutate === 'function' ? mutate(run) : { ...run, ...safeObject(mutate) };
      return {
        ...next,
        status: next.status || 'completed',
        finishedAt: iso(now()),
      };
    });
  }

  async function readRun(id) {
    return readJson(runPath(id));
  }

  async function consumeUsage(delta = {}, limits = {}) {
    const requested = {
      apiCalls: positiveInteger(delta.apiCalls),
      providerRequests: positiveInteger(delta.providerRequests),
      browserLaunches: positiveInteger(delta.browserLaunches),
      repairOperations: positiveInteger(delta.repairOperations),
      generations: positiveInteger(delta.generations),
    };
    let result = null;
    await updateState((state) => {
      const day = dailyKey(now());
      const usage = state.usage.day === day
        ? state.usage
        : { day, apiCalls: 0, providerRequests: 0, browserLaunches: 0, repairOperations: 0, generations: 0 };
      const next = Object.fromEntries(Object.keys(requested).map((key) => [key, usage[key] + requested[key]]));
      const exceeded = Object.keys(requested).find((key) => {
        const limit = Number(limits[key]);
        // An elevated recovery lane may legitimately have consumed more of a
        // *different* budget than the routine worker allows. A later browser
        // read must reserve and enforce its own quota, not be rejected merely
        // because it requests zero writes in that already-exhausted category.
        return requested[key] > 0 && Number.isFinite(limit) && limit >= 0 && next[key] > limit;
      });
      if (exceeded) {
        result = { ok: false, exceeded, usage, requested };
        return state;
      }
      result = { ok: true, usage: { day, ...next }, requested };
      return { ...state, usage: { day, ...next } };
    });
    return result;
  }

  async function writeSnapshot({
    jobId,
    owner = null,
    before,
    afterDigest,
    sourceVersion,
    articleId,
    createdArticle = false,
  }) {
    if (!jobId || !before || !articleId) return null;
    const snapshotAt = new Date(now()).getTime();
    if (owner) {
      const current = await readJob(jobId);
      if (
        !current.value
        || current.value.status !== 'running'
        || current.value.leaseOwner !== owner
        || timestamp(current.value.leaseUntil) <= snapshotAt
      ) return null;
    }
    const id = `${jobId}-${siteMonitorDigest({ sourceVersion, afterDigest, articleId }).slice(0, 16)}`;
    const snapshot = {
      version: 1,
      id,
      jobId,
      articleId,
      sourceVersion: sourceVersion || null,
      afterDigest: afterDigest || null,
      // A normal snapshot restores a pre-existing article. A creation
      // snapshot instead contains a private tombstone for a reader-visible
      // record the monitor just introduced; it lets a failed post-write
      // browser check withdraw only that monitor-owned delivery.
      createdArticle: createdArticle === true,
      createdAt: iso(now()),
      before,
    };
    const path = siteMonitorPath(`backups/${encodeURIComponent(id)}.json`);
    let persisted = snapshot;
    try {
      await writeJson(path, snapshot, { create: true });
    } catch (error) {
      // A retry after a Function interruption may have already written the
      // deterministic snapshot. Reuse it rather than failing a safe repair.
      if (!isConditionalWriteConflict(error)) throw error;
      const existing = await readJson(path);
      if (!existing.value) throw error;
      persisted = existing.value;
    }
    const attached = await updateJob(jobId, (job) => {
      if (
        !job
        || (owner && (
          job.status !== 'running'
          || job.leaseOwner !== owner
          // A Blob write may take long enough for the lease to expire after
          // the preflight above.  Re-read time at the compare-and-set point
          // so a stale worker cannot attach a rollback record to a reclaimed
          // job.
          || timestamp(job.leaseUntil) <= new Date(now()).getTime()
        ))
      ) return null;
      const snapshotIds = Array.isArray(job.snapshotIds) ? job.snapshotIds.filter(Boolean) : [];
      if (snapshotIds.includes(id)) return job;
      return { ...job, snapshotIds: [...snapshotIds, id] };
    });
    // Do not write editorial data after this worker has lost the durable job
    // lease. The orphaned backup is harmless; no reader-facing data changed.
    return attached.changed && attached.value ? persisted : null;
  }

  async function readSnapshots(jobId) {
    const job = await readJob(jobId);
    const ids = Array.isArray(job.value?.snapshotIds) ? job.value.snapshotIds.filter(Boolean) : [];
    const snapshots = [];
    for (const id of ids) {
      const stored = await readJson(siteMonitorPath(`backups/${encodeURIComponent(id)}.json`));
      if (stored.value?.jobId === jobId) snapshots.push(stored.value);
    }
    return snapshots;
  }

  async function recordAlert({ key, status, category, message, metadata = {} } = {}) {
    const safeKey = key || siteMonitorDigest({ category, message, metadata }).slice(0, 48);
    const path = alertPath(safeKey);
    let shouldDeliver = false;
    const updated = await updateJson(path, () => null, (current) => {
      const prior = current || null;
      shouldDeliver = !prior || prior.status !== status;
      return {
        version: 1,
        key: safeKey,
        category: category || prior?.category || 'monitor',
        status: status || 'open',
        message: String(message || '').slice(0, 1_000),
        metadata: safeObject(metadata),
        firstSeenAt: prior?.firstSeenAt || iso(now()),
        lastSeenAt: iso(now()),
        deliveries: Array.isArray(prior?.deliveries) ? prior.deliveries.slice(-20) : [],
      };
    });
    return { alert: updated.value, shouldDeliver };
  }

  async function markAlertDelivery(key, delivery) {
    return updateJson(alertPath(key), () => null, (alert) => {
      if (!alert) return null;
      return {
        ...alert,
        deliveries: [...(Array.isArray(alert.deliveries) ? alert.deliveries : []), {
          at: iso(now()),
          ...safeObject(delivery),
        }].slice(-20),
      };
    });
  }

  async function logError(message, details = {}) {
    // Logging must never make a repair path fail. It is intentionally compact
    // and does not retain Notion bodies or request signatures.
    try {
      logger?.warn?.('[site-monitor]', message, details);
    } catch {
      // no-op
    }
  }

  return {
    readJson,
    writeJson,
    readState,
    updateState,
    readQueue,
    readJob,
    writeJob,
    updateJob,
    enqueue,
    claimJobs,
    migrateQueuedMetadata,
    renewLease,
    finishJob,
    deferJob,
    requeueDeferredUsageLimitedJobs,
    requeueBlockedBrowserQuotaJobs,
    acquireLock,
    renewLock,
    releaseLock,
    recordEvent,
    markEventQueued,
    beginRun,
    finishRun,
    readRun,
    consumeUsage,
    writeSnapshot,
    readSnapshots,
    recordAlert,
    markAlertDelivery,
    logError,
  };
}

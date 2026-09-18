// Durable Notion → AM4 match-editorial reconciliation.
//
// Both authored match editorial types use the same public archive, fixture
// route, and card availability projection. A source-wide repair must therefore
// treat predictions and reports symmetrically. This module owns only durable
// discovery/association work: readers never call Notion and it never alters
// editorial prose.

export const MATCH_EDITORIAL_TYPES = Object.freeze(['match_report', 'match_prediction']);
// This version is source-owned rather than time-owned.  Bumping it starts one
// resumable full source reconciliation so rows that predate an earlier scan
// cannot remain invisible indefinitely; once complete, normal operation goes
// back to webhook/delta collection only.
// v7 is the one-time recovery release for the missing 2026-09-19 prediction
// deliveries.  It deliberately uses the same resumable source scan for both
// authored match types: the normal mirror deduplicates unchanged source
// versions, while a page that exists in Notion but was missed by an earlier
// collector is queued and delivered through the ordinary durable path.
export const MATCH_EDITORIAL_BACKFILL_GENERATION = 'notion-match-editorial-sync-v7';
// Bump only when the deterministic fixture-resolution rules themselves
// change. It causes existing unlinked, already-mirrored articles to receive
// one fresh association attempt without rereading Notion or waiting out the
// ordinary retry cadence.
export const MATCH_EDITORIAL_ASSOCIATION_RULESET_VERSION = 'fixture-identity-v4';
// Duplicate authored pages are never deleted or merged by the synchronizer.
// This source-owned version starts one read-only archive scan which records
// same-type / same-fixture candidates for protected operator review. Future
// successful page deliveries update only their affected fixture candidate.
export const MATCH_EDITORIAL_DUPLICATE_CANDIDATE_VERSION = 'fixture-duplicate-candidates-v1';

const RECONCILIATION_INTERVAL_MS = 12 * 60 * 60 * 1000;
const RECONCILIATION_PAGE_LIMIT = 10;
const DUPLICATE_CANDIDATE_PAGE_LIMIT = 10;

function iso(now) {
  return new Date(now()).toISOString();
}

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function positivePage(value, fallback = 1) {
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : fallback;
}

function pageVersion(page) {
  const value = page?.last_edited_time || page?.created_time || null;
  return timestamp(value) ? value : null;
}

function normaliseTypes(types = MATCH_EDITORIAL_TYPES) {
  const requested = Array.isArray(types) ? types : [types];
  return [...new Set(requested.filter((type) => MATCH_EDITORIAL_TYPES.includes(type)))];
}

function editorialState(state) {
  return state?.matchEditorialSync || {};
}

function backfillState(state, type) {
  return editorialState(state)?.backfill?.[type] || {};
}

function reconciliationState(state, type) {
  return editorialState(state)?.reconciliation?.[type] || {};
}

function duplicateCandidateState(state, type) {
  return editorialState(state)?.duplicateCandidates?.[type] || {};
}

export function matchEditorialAssociationRulesetNeedsReconciliation(state, types = MATCH_EDITORIAL_TYPES) {
  return normaliseTypes(types).some((type) => {
    const backfill = backfillState(state, type);
    const reconciliation = reconciliationState(state, type);
    return backfill.generation === MATCH_EDITORIAL_BACKFILL_GENERATION
      && Boolean(backfill.sourceScanCompletedAt)
      // A ruleset retry can be bounded across several index pages. Continue
      // its durable cursor on the minute worker rather than waiting for the
      // next hourly collector merely because page one already recorded the
      // current ruleset version.
      && (
        reconciliation.rulesetVersion !== MATCH_EDITORIAL_ASSOCIATION_RULESET_VERSION
        || positivePage(reconciliation.nextPage, 0) > 1
      );
  });
}

function sameGeneration(state, type) {
  return backfillState(state, type).generation === MATCH_EDITORIAL_BACKFILL_GENERATION;
}

export function matchEditorialBackfillTypesNeedingScan(state, types = MATCH_EDITORIAL_TYPES) {
  return normaliseTypes(types).filter((type) => {
    const current = backfillState(state, type);
    return current.generation !== MATCH_EDITORIAL_BACKFILL_GENERATION || !current.sourceScanCompletedAt;
  });
}

export function matchEditorialBackfillNeedsScan(state, types = MATCH_EDITORIAL_TYPES) {
  return matchEditorialBackfillTypesNeedingScan(state, types).length > 0;
}

function updateBackfillState(current, type, patch) {
  const prior = sameGeneration(current, type) ? backfillState(current, type) : {};
  return {
    ...current,
    matchEditorialSync: {
      ...editorialState(current),
      backfill: {
        ...(editorialState(current).backfill || {}),
        [type]: {
          generation: MATCH_EDITORIAL_BACKFILL_GENERATION,
          cursor: null,
          // This predates the first request in an interrupted scan. It becomes
          // the conservative normal-delta watermark after source completion.
          scanStartedAt: null,
          watermark: null,
          pagesScanned: 0,
          jobsQueued: 0,
          sourceScanCompletedAt: null,
          lastError: null,
          ...prior,
          ...patch,
        },
      },
    },
  };
}

function updateReconciliationState(current, type, patch) {
  return {
    ...current,
    matchEditorialSync: {
      ...editorialState(current),
      reconciliation: {
        ...(editorialState(current).reconciliation || {}),
        [type]: {
          ...reconciliationState(current, type),
          ...patch,
        },
      },
    },
  };
}

function updateDuplicateCandidateState(current, type, patch) {
  return {
    ...current,
    matchEditorialSync: {
      ...editorialState(current),
      duplicateCandidates: {
        ...(editorialState(current).duplicateCandidates || {}),
        [type]: {
          ...duplicateCandidateState(current, type),
          ...patch,
        },
      },
    },
  };
}

function publishedFixtureId(article, type) {
  const fixtureId = Number(article?.match?.fixtureId);
  return article?.type === type
    && article?.public !== false
    && article?.status === 'published'
    && Number.isSafeInteger(fixtureId)
    && fixtureId > 0
    ? fixtureId
    : null;
}

function duplicateReference(article) {
  const articleId = String(article?.id || '').trim();
  if (!articleId) return null;
  return {
    articleId,
    sourceVersion: String(article?.notion?.updatedAt || article?.updatedAt || '').trim() || null,
  };
}

function normalisedReferenceList(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : [])
    .map((reference) => ({
      articleId: String(reference?.articleId || '').trim(),
      sourceVersion: String(reference?.sourceVersion || '').trim() || null,
    }))
    .filter((reference) => reference.articleId && !seen.has(reference.articleId) && seen.add(reference.articleId))
    .sort((left, right) => left.articleId.localeCompare(right.articleId));
}

function candidateList(candidateByFixture) {
  return Object.entries(candidateByFixture || {})
    .map(([fixtureId, articles]) => ({
      fixtureId: Number(fixtureId),
      articles: normalisedReferenceList(articles),
    }))
    .filter((candidate) => Number.isSafeInteger(candidate.fixtureId) && candidate.fixtureId > 0 && candidate.articles.length > 1)
    .sort((left, right) => left.fixtureId - right.fixtureId);
}

function mapCandidateList(candidates) {
  return Object.fromEntries((Array.isArray(candidates) ? candidates : []).map((candidate) => [
    String(candidate?.fixtureId || ''), normalisedReferenceList(candidate?.articles),
  ]).filter(([fixtureId, articles]) => /^\d+$/.test(fixtureId) && articles.length > 1));
}

function sourceResult(type, counts, state, extra = {}) {
  return {
    type,
    state,
    queued: counts.queued,
    duplicate: counts.duplicate,
    pages: counts.pages,
    skipped: counts.skipped,
    ...extra,
  };
}

function aggregateBackfill(results) {
  const values = Object.values(results);
  const quotaExceeded = values.some((result) => result.state === 'quota_exceeded');
  const incomplete = values.some((result) => !['queued', 'already_scanned'].includes(result.state));
  return {
    state: quotaExceeded ? 'quota_exceeded' : incomplete ? 'partial'
      : values.every((result) => result.state === 'already_scanned') ? 'already_scanned' : 'queued',
    queued: values.reduce((sum, result) => sum + Number(result.queued || 0), 0),
    duplicate: values.reduce((sum, result) => sum + Number(result.duplicate || 0), 0),
    pages: values.reduce((sum, result) => sum + Number(result.pages || 0), 0),
    skipped: values.reduce((sum, result) => sum + Number(result.skipped || 0), 0),
    types: results,
  };
}

// Queue every current match-editorial page once per source-owned repair
// generation. `onPage` persists the next opaque Notion cursor only after all
// rows from that page have been durably enqueued. A crash repeats at most a
// source-version-deduplicated page and cannot mark a partial scan complete.
export async function queueMatchEditorialBackfill({
  store,
  collectSourcePages,
  sourceIds,
  types = MATCH_EDITORIAL_TYPES,
  now = () => new Date(),
  deadlineAt = null,
  consumeRequest = null,
} = {}) {
  if (!store || typeof store.readState !== 'function' || typeof store.enqueue !== 'function') {
    throw new Error('A durable monitor store is required for match-editorial backfill');
  }
  if (typeof collectSourcePages !== 'function') throw new Error('A Notion source collector is required for match-editorial backfill');

  const requestedTypes = normaliseTypes(types);
  const initial = (await store.readState()).value;
  const scanTypes = matchEditorialBackfillTypesNeedingScan(initial, requestedTypes);
  const countsByType = Object.fromEntries(requestedTypes.map((type) => [type, {
    queued: 0, duplicate: 0, pages: 0, skipped: 0,
  }]));
  if (!scanTypes.length) {
    return aggregateBackfill(Object.fromEntries(requestedTypes.map((type) => [
      type, sourceResult(type, countsByType[type], 'already_scanned', { complete: true }),
    ])));
  }

  const scan = Object.fromEntries(scanTypes.map((type) => {
    const prior = sameGeneration(initial, type) ? backfillState(initial, type) : {};
    return [type, {
      cursor: String(prior.cursor || '').trim() || null,
      scanStartedAt: prior.scanStartedAt || iso(now),
    }];
  }));
  const collected = await collectSourcePages({
    sourceIds,
    types: scanTypes,
    cursors: Object.fromEntries(scanTypes.map((type) => [type, { cursor: scan[type].cursor }])),
    deadlineAt,
    consumeRequest,
    onPage: async ({ sourceType, pages, nextCursor, complete }) => {
      if (!scan[sourceType]) return;
      const counts = countsByType[sourceType];
      let pageQueued = 0;
      for (const page of pages || []) {
        const pageId = String(page?.id || '').trim();
        const sourceVersion = pageVersion(page);
        if (!pageId || !sourceVersion) {
          counts.skipped += 1;
          continue;
        }
        const queued = await store.enqueue({
          kind: 'notion_page',
          pageId,
          sourceType,
          sourceVersion,
          repairGeneration: MATCH_EDITORIAL_BACKFILL_GENERATION,
          // Publishing/associating trusted source content must not wait for a
          // Chromium launch. Visual inspection remains a separate operation.
          deliveryOnly: true,
          trigger: `notion_${sourceType}_backfill`,
          priority: 70,
        });
        if (queued.enqueued) {
          counts.queued += 1;
          pageQueued += 1;
        } else {
          counts.duplicate += 1;
        }
      }
      counts.pages += (pages || []).length;
      const updatedAt = iso(now);
      await store.updateState((state) => {
        const existing = sameGeneration(state, sourceType) ? backfillState(state, sourceType) : {};
        return updateBackfillState(state, sourceType, {
          cursor: nextCursor || null,
          scanStartedAt: existing.scanStartedAt || scan[sourceType].scanStartedAt,
          watermark: existing.watermark || existing.scanStartedAt || scan[sourceType].scanStartedAt,
          pagesScanned: Number(existing.pagesScanned || 0) + (pages || []).length,
          jobsQueued: Number(existing.jobsQueued || 0) + pageQueued,
          lastProgressAt: updatedAt,
          // Source-list completion is not a claim that all body/fixture jobs
          // have succeeded; downstream failures stay in the durable queue.
          ...(complete ? { sourceScanCompletedAt: updatedAt } : {}),
          lastError: null,
        });
      });
    },
  });

  const results = {};
  for (const type of requestedTypes) {
    const counts = countsByType[type];
    if (!scan[type]) {
      results[type] = sourceResult(type, counts, 'already_scanned', { complete: true });
      continue;
    }
    const source = collected.sources?.[type] || null;
    // The source collector stops after quota exhaustion. Later requested
    // sources consequently have no own error object; preserve their cursor and
    // make the pending quota state explicit rather than completing them.
    const outcome = collected.errors?.[type]
      || (!source && collected.quotaExceeded ? 'quota_exceeded' : null)
      || (!source ? 'unavailable' : null);
    if (outcome) {
      await store.updateState((state) => updateBackfillState(state, type, {
        scanStartedAt: backfillState(state, type).scanStartedAt || scan[type].scanStartedAt,
        watermark: backfillState(state, type).watermark || backfillState(state, type).scanStartedAt || scan[type].scanStartedAt,
        lastError: outcome,
        lastErrorAt: iso(now),
      }));
      results[type] = sourceResult(type, counts, outcome, {
        complete: false,
        retryAfterMs: collected.retryAfterMs?.[type] || null,
      });
      continue;
    }
    if (source.complete) {
      await store.updateState((state) => {
        const existing = backfillState(state, type);
        const watermark = existing.watermark || existing.scanStartedAt || scan[type].scanStartedAt;
        return updateBackfillState(state, type, {
          cursor: null,
          scanStartedAt: existing.scanStartedAt || scan[type].scanStartedAt,
          watermark,
          sourceScanCompletedAt: existing.sourceScanCompletedAt || iso(now),
          lastError: null,
        });
      });
      const final = backfillState((await store.readState()).value, type);
      results[type] = sourceResult(type, counts, 'queued', {
        complete: true,
        watermark: final.watermark || scan[type].scanStartedAt,
      });
    } else {
      results[type] = sourceResult(type, counts, 'incomplete', { complete: false });
    }
  }
  return aggregateBackfill(results);
}

function reconciliationGeneration(type, now) {
  return `match-editorial-${type}-association-${MATCH_EDITORIAL_ASSOCIATION_RULESET_VERSION}-${iso(now).slice(0, 10)}`;
}

function needsFixtureReconciliation(article, type) {
  const fixtureId = Number(article?.match?.fixtureId);
  return article?.type === type
    && article?.public !== false
    && article?.status === 'published'
    && (!Number.isInteger(fixtureId) || fixtureId <= 0)
    && Boolean(article?.id)
    && Boolean(article?.notion?.updatedAt);
}

async function queueUnlinkedTypeReconciliation({ store, listArticles, type, now }) {
  const state = (await store.readState()).value;
  const backfill = backfillState(state, type);
  if (backfill.generation !== MATCH_EDITORIAL_BACKFILL_GENERATION || !backfill.sourceScanCompletedAt) {
    return { type, state: 'backfill_not_scanned', queued: 0, candidates: 0 };
  }
  const reconciliation = reconciliationState(state, type);
  const rulesetChanged = reconciliation.rulesetVersion !== MATCH_EDITORIAL_ASSOCIATION_RULESET_VERSION;
  // A changed deterministic matcher must reconsider every currently
  // unlinked record, not resume partway through an older matcher generation.
  // This is still a Blob-only association pass; it does not reread Notion.
  const resumePage = rulesetChanged ? 1 : positivePage(reconciliation.nextPage, 1);
  const continuing = !rulesetChanged && resumePage > 1;
  const previous = timestamp(reconciliation.lastQueuedAt);
  const current = new Date(now()).getTime();
  if (!rulesetChanged && !continuing && previous && current - previous < RECONCILIATION_INTERVAL_MS) {
    return { type, state: 'not_due', queued: 0, candidates: 0 };
  }

  let page = resumePage;
  let candidates = 0;
  let queuedCount = 0;
  let totalPages = continuing ? Math.max(resumePage, positivePage(reconciliation.totalPages, 1)) : 1;
  const generation = continuing && reconciliation.generation
    ? reconciliation.generation
    : reconciliationGeneration(type, now);
  const startedAt = continuing && reconciliation.startedAt ? reconciliation.startedAt : iso(now);
  let scannedPages = 0;
  while (page <= totalPages && scannedPages < RECONCILIATION_PAGE_LIMIT) {
    const result = await listArticles({ type, page, pageSize: 100, publishedOnly: true });
    totalPages = Math.max(1, Number(result?.totalPages) || 1);
    for (const article of result?.items || []) {
      if (!needsFixtureReconciliation(article, type)) continue;
      candidates += 1;
      const queued = await store.enqueue({
        kind: 'article_validation',
        articleId: article.id,
        sourceType: type,
        sourceVersion: article.notion.updatedAt,
        repairGeneration: generation,
        deliveryOnly: true,
        trigger: `notion_${type}_fixture_reconciliation`,
        priority: 45,
      });
      if (queued.enqueued) queuedCount += 1;
    }
    page += 1;
    scannedPages += 1;
  }
  const partial = page <= totalPages;
  await store.updateState((currentState) => updateReconciliationState(currentState, type, {
    generation,
    rulesetVersion: MATCH_EDITORIAL_ASSOCIATION_RULESET_VERSION,
    startedAt,
    lastProgressAt: iso(now),
    totalPages,
    nextPage: partial ? page : null,
    candidates: (continuing ? Number(reconciliation.candidates || 0) : 0) + candidates,
    queued: (continuing ? Number(reconciliation.queued || 0) : 0) + queuedCount,
    ...(partial ? {} : { lastQueuedAt: iso(now), completedAt: iso(now) }),
  }));
  return {
    type,
    state: partial ? 'partial' : 'queued',
    candidates,
    queued: queuedCount,
    ...(partial ? { nextPage: page, totalPages } : {}),
  };
}

// A completed source scan can still leave rows awaiting provider fixtures.
// Revisit only unlinked records on a bounded cadence. Each editorial type has
// its own cursor/generation, so an interrupted prediction scan cannot starve
// report recovery (or vice versa).
export async function queueUnlinkedMatchEditorialReconciliation({
  store,
  listArticles,
  types = MATCH_EDITORIAL_TYPES,
  now = () => new Date(),
} = {}) {
  if (!store || typeof store.readState !== 'function' || typeof store.enqueue !== 'function') {
    throw new Error('A durable monitor store is required for fixture reconciliation');
  }
  if (typeof listArticles !== 'function') throw new Error('An article lister is required for fixture reconciliation');
  const results = {};
  for (const type of normaliseTypes(types)) {
    results[type] = await queueUnlinkedTypeReconciliation({ store, listArticles, type, now });
  }
  const values = Object.values(results);
  return {
    state: values.some((result) => result.state === 'partial') ? 'partial'
      : values.some((result) => result.state === 'queued') ? 'queued'
        : values.every((result) => result.state === 'backfill_not_scanned') ? 'backfill_not_scanned' : 'not_due',
    candidates: values.reduce((sum, result) => sum + Number(result.candidates || 0), 0),
    queued: values.reduce((sum, result) => sum + Number(result.queued || 0), 0),
    types: results,
  };
}

// A duplicate is an operational review signal, never an instruction to pick a
// winner. Keep every source page available in the public archive and record
// only stable IDs/source versions under the protected monitor state. The scan
// is paged and resumable so a Blob/index error cannot replace an existing
// candidate record with a false "none" result.
export function matchEditorialDuplicateCandidatesNeedScan(state, types = MATCH_EDITORIAL_TYPES) {
  return normaliseTypes(types).some((type) => {
    const current = duplicateCandidateState(state, type);
    return current.version !== MATCH_EDITORIAL_DUPLICATE_CANDIDATE_VERSION
      || !current.completedAt
      || positivePage(current.nextPage, 0) > 1;
  });
}

export async function scanMatchEditorialDuplicateCandidates({
  store,
  listArticles,
  types = MATCH_EDITORIAL_TYPES,
  now = () => new Date(),
} = {}) {
  if (!store || typeof store.readState !== 'function' || typeof store.updateState !== 'function') {
    throw new Error('A durable monitor store is required for duplicate-candidate reconciliation');
  }
  if (typeof listArticles !== 'function') throw new Error('An article lister is required for duplicate-candidate reconciliation');

  const results = {};
  for (const type of normaliseTypes(types)) {
    const initial = (await store.readState()).value;
    const prior = duplicateCandidateState(initial, type);
    const changed = prior.version !== MATCH_EDITORIAL_DUPLICATE_CANDIDATE_VERSION;
    const complete = !changed && Boolean(prior.completedAt) && positivePage(prior.nextPage, 0) <= 1;
    if (complete) {
      results[type] = { type, state: 'already_scanned', candidates: candidateList(mapCandidateList(prior.candidates)).length };
      continue;
    }

    let page = changed ? 1 : positivePage(prior.nextPage, 1);
    let totalPages = changed ? 1 : Math.max(page, positivePage(prior.totalPages, 1));
    let firstByFixture = changed ? {} : { ...(prior.firstByFixture || {}) };
    let candidateByFixture = changed ? {} : { ...(prior.candidateByFixture || {}) };
    let scannedPages = 0;
    let failure = null;

    while (page <= totalPages && scannedPages < DUPLICATE_CANDIDATE_PAGE_LIMIT) {
      let result;
      try {
        result = await listArticles({ type, page, pageSize: 100, publishedOnly: true });
      } catch (error) {
        failure = error;
        break;
      }
      totalPages = Math.max(1, Number(result?.totalPages) || 1);
      for (const article of result?.items || []) {
        const fixtureId = publishedFixtureId(article, type);
        const reference = duplicateReference(article);
        if (!fixtureId || !reference) continue;
        const key = String(fixtureId);
        const first = firstByFixture[key];
        if (!first) {
          firstByFixture[key] = reference;
          continue;
        }
        candidateByFixture[key] = normalisedReferenceList([
          ...(candidateByFixture[key] || [first]),
          reference,
        ]);
      }
      page += 1;
      scannedPages += 1;
    }

    const partial = !failure && page <= totalPages;
    const detectedAt = iso(now);
    const candidates = candidateList(candidateByFixture);
    await store.updateState((state) => updateDuplicateCandidateState(state, type, {
      version: MATCH_EDITORIAL_DUPLICATE_CANDIDATE_VERSION,
      startedAt: changed ? detectedAt : prior.startedAt || detectedAt,
      totalPages,
      nextPage: failure || partial ? page : null,
      scannedPages: (changed ? 0 : Number(prior.scannedPages || 0)) + scannedPages,
      lastProgressAt: detectedAt,
      ...(failure ? {
        completedAt: null,
        lastError: String(failure?.message || failure).slice(0, 240),
        lastErrorAt: detectedAt,
        firstByFixture,
        candidateByFixture,
      } : partial ? {
        completedAt: null,
        lastError: null,
        firstByFixture,
        candidateByFixture,
      } : {
        completedAt: detectedAt,
        lastError: null,
        candidates,
        firstByFixture: null,
        candidateByFixture: null,
      }),
    }));
    results[type] = {
      type,
      state: failure ? 'unavailable' : partial ? 'partial' : 'recorded',
      candidates: candidates.length,
      ...(failure ? { error: String(failure?.message || failure).slice(0, 240) } : {}),
    };
  }
  const values = Object.values(results);
  return {
    state: values.some((result) => result.state === 'unavailable') ? 'unavailable'
      : values.some((result) => result.state === 'partial') ? 'partial'
        : values.every((result) => result.state === 'already_scanned') ? 'already_scanned' : 'recorded',
    candidates: values.reduce((sum, result) => sum + Number(result.candidates || 0), 0),
    types: results,
  };
}

// Normal operation does not repeatedly scan the archive. Once the baseline
// scan has completed, a successfully delivered page reads only its own
// fixture's public rows and refreshes that single candidate record. This keeps
// future Notion updates cheap while preserving both pages when they conflict.
export async function refreshMatchEditorialDuplicateCandidates({
  store,
  listArticles,
  articles,
  now = () => new Date(),
} = {}) {
  if (!store || typeof store.readState !== 'function' || typeof store.updateState !== 'function') {
    throw new Error('A durable monitor store is required for duplicate-candidate refresh');
  }
  if (typeof listArticles !== 'function') throw new Error('An article lister is required for duplicate-candidate refresh');
  const targets = new Map();
  for (const article of Array.isArray(articles) ? articles : []) {
    const type = article?.type;
    const fixtureId = publishedFixtureId(article, type);
    if (!MATCH_EDITORIAL_TYPES.includes(type) || !fixtureId) continue;
    targets.set(`${type}:${fixtureId}`, { type, fixtureId });
    // An association repair can legitimately move an already-recorded page
    // from fixture A to fixture B. Re-evaluate both sides: otherwise the old
    // A candidate could remain visible after this page leaves it. We discover
    // A only from the protected candidate ledger; no prose or source read is
    // needed, and a page that was never a duplicate has no old candidate to
    // invalidate.
    const state = (await store.readState()).value;
    const prior = duplicateCandidateState(state, type);
    if (prior.version !== MATCH_EDITORIAL_DUPLICATE_CANDIDATE_VERSION || !prior.completedAt) continue;
    for (const candidate of prior.candidates || []) {
      const oldFixtureId = Number(candidate?.fixtureId);
      if (!Number.isSafeInteger(oldFixtureId) || oldFixtureId <= 0 || oldFixtureId === fixtureId) continue;
      if (normalisedReferenceList(candidate?.articles).some((reference) => reference.articleId === article.id)) {
        targets.set(`${type}:${oldFixtureId}`, { type, fixtureId: oldFixtureId });
      }
    }
  }
  if (!targets.size) return { state: 'not_applicable', checked: 0, candidates: 0 };

  let checked = 0;
  let candidates = 0;
  let unavailable = 0;
  for (const { type, fixtureId } of targets.values()) {
    const state = (await store.readState()).value;
    const prior = duplicateCandidateState(state, type);
    // The baseline must be complete before an incremental update may replace
    // one fixture's candidate list. A concurrent/resumable baseline owns the
    // authoritative scan state instead.
    if (prior.version !== MATCH_EDITORIAL_DUPLICATE_CANDIDATE_VERSION || !prior.completedAt) continue;
    let rows = [];
    let page = 1;
    let totalPages = 1;
    try {
      do {
        const result = await listArticles({ type, fixtureId, page, pageSize: 100, publishedOnly: true });
        rows.push(...(result?.items || []));
        totalPages = Math.max(1, Number(result?.totalPages) || 1);
        page += 1;
      } while (page <= totalPages && page <= DUPLICATE_CANDIDATE_PAGE_LIMIT);
    } catch (_error) {
      unavailable += 1;
      continue;
    }
    if (page <= totalPages) {
      unavailable += 1;
      continue;
    }
    const references = normalisedReferenceList(rows
      .filter((article) => publishedFixtureId(article, type) === fixtureId)
      .map(duplicateReference));
    const isCandidate = references.length > 1;
    await store.updateState((current) => {
      const currentPrior = duplicateCandidateState(current, type);
      if (currentPrior.version !== MATCH_EDITORIAL_DUPLICATE_CANDIDATE_VERSION || !currentPrior.completedAt) return null;
      const byFixture = mapCandidateList(currentPrior.candidates);
      if (isCandidate) {
        byFixture[String(fixtureId)] = references;
      } else {
        delete byFixture[String(fixtureId)];
      }
      return updateDuplicateCandidateState(current, type, {
        candidates: candidateList(byFixture),
        lastIncrementalRefreshAt: iso(now),
      });
    });
    checked += 1;
    if (isCandidate) candidates += 1;
  }
  return {
    state: unavailable ? (checked ? 'partial' : 'unavailable') : 'recorded',
    checked,
    candidates,
    unavailable,
  };
}

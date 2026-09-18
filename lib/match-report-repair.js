// Durable recovery for finished fixtures that have no AM4 match report yet.
//
// This module never writes the public article archive directly. A generated
// report is first created in the existing Notion match-report source and then
// handed back to the normal monitor synchronizer for persistence, fixture
// association, media enrichment, availability, and browser verification.

import { apiFootballFetch } from './api-football-client.js';
import {
  computePlayerRatings,
  generateMatchReportDraft,
} from './match-report-core.js';
import {
  findNotionMatchPageTarget,
  NotionSchemaError,
  publishGeneratedMatchReport,
} from './notion-content-sync.js';
import { listArticles } from './article-store.js';
import { siteMonitorDigest } from './site-monitor-store.js';
import matchArchive from '../match-archive.js';

export const REPORT_GENERATION_SOURCE_TYPE = 'match_report_generation';
// v2 deliberately changes the durable job identity after retiring the
// retired external writer. It permits one bounded, idempotent retry for a
// finished fixture previously held by that unavailable provider; it does not
// reopen a completed or already-public report.
export const REPORT_GENERATION_REPAIR_GENERATION = 'notion-match-report-generation-v2-deterministic';
export const REPORT_RECOVERY_START_JST = '2026-09-16';
export const FINISHED_REPORT_STATUSES = new Set(['FT', 'AET', 'PEN']);

// These are the requested men's top-flight competition IDs. CL/EL are
// competition-wide rather than a five-league club allowlist by design.
export const REPORT_TARGET_COMPETITIONS = new Map([
  [39, 'Premier League'],
  [140, 'La Liga'],
  [135, 'Serie A'],
  [78, 'Bundesliga'],
  [61, 'Ligue 1'],
  [2, 'Champions League'],
  [3, 'Europa League'],
]);

const INITIAL_LOOKBACK_BUFFER_DAYS = 1;
const ONGOING_LOOKBACK_DAYS = 2;
const MAX_INITIAL_SCAN_DAYS_PER_RUN = 7;
const SCAN_INTERVAL_MS = 60 * 60 * 1000;
const TRANSIENT_SCAN_DELAY_MS = 10 * 60 * 1000;

export class MatchReportRepairError extends Error {
  constructor(message, { code = 'REPORT_REPAIR_FAILED', retryable = true, details = null } = {}) {
    super(message);
    this.name = 'MatchReportRepairError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

async function reserveProviderRequest(consumeProviderRequest) {
  if (typeof consumeProviderRequest !== 'function') return;
  const reservation = await consumeProviderRequest();
  if (reservation === false || reservation?.ok === false) {
    throw new MatchReportRepairError('Provider request is deferred by the usage cap', {
      code: 'PROVIDER_USAGE_LIMIT', retryable: false, details: reservation || null,
    });
  }
}

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function integerGoal(value) {
  if (value == null || String(value).trim() === '') return null;
  const goal = Number(value);
  return Number.isInteger(goal) && goal >= 0 ? goal : null;
}

function validDate(value) {
  const date = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/u.test(date) ? date : null;
}

function dayParts(value) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value)).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
}

export function tokyoDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = dayParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDays(date, amount) {
  const timestamp = Date.parse(`${validDate(date) || ''}T12:00:00.000Z`);
  return Number.isFinite(timestamp)
    ? new Date(timestamp + Number(amount) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    : null;
}

function compareDates(left, right) {
  return String(left || '').localeCompare(String(right || ''));
}

// Shared target-fixture normalisation for both the finished-report and
// scheduled-prediction recovery lanes.  Status-specific eligibility remains
// in the caller so a scheduled fixture is never mistaken for a final result.
export function targetFixtureCandidate(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const fixture = source.fixture || {};
  const league = source.league || {};
  const teams = source.teams || {};
  const id = positiveId(fixture.id);
  const leagueId = positiveId(league.id);
  const homeId = positiveId(teams.home?.id);
  const awayId = positiveId(teams.away?.id);
  const homeTeam = String(teams.home?.name || '').trim();
  const awayTeam = String(teams.away?.name || '').trim();
  const status = String(fixture.status?.short || '').trim().toUpperCase();
  const kickoff = String(fixture.date || '').trim() || null;
  const date = tokyoDate(kickoff) || validDate(kickoff);
  const homeGoals = integerGoal(source.goals?.home);
  const awayGoals = integerGoal(source.goals?.away);
  const homePenaltyGoals = integerGoal(source.score?.penalty?.home);
  const awayPenaltyGoals = integerGoal(source.score?.penalty?.away);
  const competition = REPORT_TARGET_COMPETITIONS.get(leagueId) || null;
  if (!id || !leagueId || !homeId || !awayId || !homeTeam || !awayTeam || !kickoff || !date || !competition) return null;
  return {
    id,
    leagueId,
    competition,
    providerCompetition: String(league.name || '').trim() || null,
    season: positiveId(league.season),
    round: String(league.round || '').trim() || null,
    status,
    statusLong: String(fixture.status?.long || '').trim() || null,
    date,
    kickoff,
    timezone: String(fixture.timezone || '').trim() || null,
    venue: String(fixture.venue?.name || '').trim() || null,
    homeTeam,
    awayTeam,
    homeTeamId: homeId,
    awayTeamId: awayId,
    homeGoals,
    awayGoals,
    homePenaltyGoals,
    awayPenaltyGoals,
    raw: source,
  };
}

export function finishedReportCandidate(raw, { minimumTokyoDate = REPORT_RECOVERY_START_JST } = {}) {
  const candidate = targetFixtureCandidate(raw);
  if (!candidate) return null;
  if (!REPORT_TARGET_COMPETITIONS.has(candidate.leagueId)) return null;
  if (!FINISHED_REPORT_STATUSES.has(candidate.status)) return null;
  if (candidate.homeGoals == null || candidate.awayGoals == null) return null;
  if (compareDates(candidate.date, minimumTokyoDate) < 0) return null;
  return candidate;
}

export function reportGenerationVersion(candidate) {
  return siteMonitorDigest({
    fixtureId: candidate?.id || null,
    status: candidate?.status || null,
    kickoff: candidate?.kickoff || null,
    homeTeamId: candidate?.homeTeamId || null,
    awayTeamId: candidate?.awayTeamId || null,
    homeGoals: candidate?.homeGoals ?? null,
    awayGoals: candidate?.awayGoals ?? null,
    homePenaltyGoals: candidate?.homePenaltyGoals ?? null,
    awayPenaltyGoals: candidate?.awayPenaltyGoals ?? null,
    leagueId: candidate?.leagueId || null,
  }).slice(0, 40);
}

function candidatePayload(candidate) {
  return {
    fixtureId: candidate.id,
    status: candidate.status,
    kickoff: candidate.kickoff,
    date: candidate.date,
    competition: candidate.competition,
    leagueId: candidate.leagueId,
    homeTeam: candidate.homeTeam,
    awayTeam: candidate.awayTeam,
    homeTeamId: candidate.homeTeamId,
    awayTeamId: candidate.awayTeamId,
    homeGoals: candidate.homeGoals,
    awayGoals: candidate.awayGoals,
    homePenaltyGoals: candidate.homePenaltyGoals,
    awayPenaltyGoals: candidate.awayPenaltyGoals,
  };
}

function reportFixtureId(article) {
  return positiveId(article?.match?.fixtureId);
}

function articleTeamId(article, side) {
  const match = article?.match || {};
  return positiveId(match?.[`${side}TeamId`] || match?.[side]?.id);
}

function articleTeamName(article, side) {
  const match = article?.match || {};
  return String(match?.[`${side}Team`] || match?.[side]?.name || '').trim() || null;
}

// A provider fixture ID is strong only while the ordered teams do not
// contradict it.  Older records may lack both team fields; that is unknown,
// not a conflict.  When either team ID or both names are present, however, a
// reversed/different card must reach the normal source-resync path instead of
// suppressing the repair as a healthy report.
function reportFixtureCardMatches(article, candidate) {
  const homeTeamId = articleTeamId(article, 'home');
  const awayTeamId = articleTeamId(article, 'away');
  if (homeTeamId && homeTeamId !== candidate.homeTeamId) return false;
  if (awayTeamId && awayTeamId !== candidate.awayTeamId) return false;
  const homeTeam = articleTeamName(article, 'home');
  const awayTeam = articleTeamName(article, 'away');
  if (!homeTeam || !awayTeam) return true;
  const compared = matchArchive.orderedTeamIdentityComparison(
    { homeTeam, awayTeam },
    { homeTeam: candidate.homeTeam, awayTeam: candidate.awayTeam },
  );
  return compared?.orientation === 'direct';
}

function isPublicReport(article, candidate) {
  return article?.type === 'match_report'
    && article.public !== false
    && article.status === 'published'
    && reportFixtureId(article) === candidate.id
    && reportFixtureCardMatches(article, candidate);
}

function isConflictingPublicReport(article, candidate) {
  return article?.type === 'match_report'
    && article.public !== false
    && article.status === 'published'
    && reportFixtureId(article) === candidate.id
    && !reportFixtureCardMatches(article, candidate);
}

function notBeforeDate(now, milliseconds) {
  return new Date(new Date(now).getTime() + milliseconds).toISOString();
}

function nextTokyoMidnight(now) {
  const date = new Date(now);
  const parts = dayParts(date);
  const next = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 15, 0, 5);
  return new Date(next).toISOString();
}

function scanState(state) {
  const value = state?.matchReportRepair;
  return value && typeof value === 'object' ? value : {};
}

function initialFetchDate() {
  return addDays(REPORT_RECOVERY_START_JST, -INITIAL_LOOKBACK_BUFFER_DAYS);
}

function scanDates(current, state) {
  if (!state.initialCompletedAt) {
    const start = validDate(state.initialCursorDate) || initialFetchDate();
    const dates = [];
    let date = start;
    while (date && compareDates(date, current) <= 0 && dates.length < MAX_INITIAL_SCAN_DAYS_PER_RUN) {
      dates.push(date);
      date = addDays(date, 1);
    }
    return { mode: 'initial', dates, nextCursorDate: date, completeAfterRun: !date || compareDates(date, current) > 0 };
  }
  const dates = [];
  for (let offset = ONGOING_LOOKBACK_DAYS; offset >= 0; offset -= 1) {
    const date = addDays(current, -offset);
    if (date) dates.push(date);
  }
  return { mode: 'ongoing', dates: [...new Set(dates)], nextCursorDate: null, completeAfterRun: true };
}

// Scan fixture data independently of existing AM4 articles. The public index
// only suppresses a job when it already has a report with the verified fixture
// ID; a report with an unresolved or stale link still reaches the Notion-first
// recovery path instead of being incorrectly treated as healthy.
export async function scanMissingMatchReports({
  store,
  now = () => new Date(),
  fetchFixtures = apiFootballFetch,
  listPublicArticles = listArticles,
  minimumTokyoDate = REPORT_RECOVERY_START_JST,
  consumeProviderRequest = null,
} = {}) {
  if (!store) throw new Error('A durable site monitor store is required');
  const observed = new Date(now());
  const currentDate = tokyoDate(observed);
  if (!currentDate) throw new MatchReportRepairError('Tokyo date is unavailable', { retryable: true });
  const current = (await store.readState()).value;
  const prior = scanState(current);
  // A reviewed generation-engine change needs a complete reconciliation, not
  // merely the normal two-day tail scan.  Otherwise an older fixture that was
  // correctly held by the retired engine could never receive the new
  // deterministic job.  The persisted cursor keeps this bounded to seven
  // dates per run and makes interruption/resumption safe.
  const generationChanged = prior.generation !== REPORT_GENERATION_REPAIR_GENERATION;
  const planningState = generationChanged
    ? { ...prior, initialCompletedAt: null, initialCursorDate: initialFetchDate() }
    : prior;
  const retryAt = Date.parse(prior.notBefore || '');
  if (Number.isFinite(retryAt) && retryAt > observed.getTime()) {
    return { state: 'deferred', reason: 'upstream_retry_window', notBefore: new Date(retryAt).toISOString() };
  }
  const lastScan = Date.parse(prior.lastScanAt || '');
  if (!generationChanged && prior.initialCompletedAt && Number.isFinite(lastScan) && observed.getTime() - lastScan < SCAN_INTERVAL_MS) {
    return { state: 'throttled', reason: 'hourly_interval', lastScanAt: prior.lastScanAt };
  }
  const plan = scanDates(currentDate, planningState);
  let reports = [];
  try {
    const indexed = await listPublicArticles({ type: 'match_report', page: 1, pageSize: 2_000, publishedOnly: true, throwOnError: true });
    reports = Array.isArray(indexed?.items) ? indexed.items : [];
  } catch (error) {
    await store.updateState((state) => ({
      ...state,
      matchReportRepair: {
        ...scanState(state),
        lastScanError: 'article_index_unavailable',
        notBefore: notBeforeDate(observed, TRANSIENT_SCAN_DELAY_MS),
      },
    }));
    return { state: 'unavailable', reason: 'article_index_unavailable' };
  }
  const publicReportsByFixture = new Map();
  for (const article of reports) {
    const fixtureId = reportFixtureId(article);
    if (!fixtureId) continue;
    const rows = publicReportsByFixture.get(fixtureId) || [];
    rows.push(article);
    publicReportsByFixture.set(fixtureId, rows);
  }
  const candidates = new Map();
  let failedDate = null;
  for (const date of plan.dates) {
    let response;
    try {
      await reserveProviderRequest(consumeProviderRequest);
      response = await fetchFixtures('/fixtures', { date, timezone: 'Asia/Tokyo' }, { retries: 1, timeoutMs: 12_000 });
    } catch (error) {
      if (error?.code === 'PROVIDER_USAGE_LIMIT') {
        await store.updateState((state) => ({
          ...state,
          matchReportRepair: {
            ...scanState(state),
            lastScanError: 'provider_usage_limit',
            notBefore: nextTokyoMidnight(observed),
            updatedAt: observed.toISOString(),
          },
        }));
        return { state: 'quota_exceeded', reason: 'provider_usage_limit', quota: error.details || null };
      }
      failedDate = date;
      break;
    }
    if (response?.errors && Object.keys(response.errors).length) {
      failedDate = date;
      break;
    }
    for (const raw of Array.isArray(response?.response) ? response.response : []) {
      const candidate = finishedReportCandidate(raw, { minimumTokyoDate });
      if (candidate) candidates.set(candidate.id, candidate);
    }
  }
  if (failedDate) {
    await store.updateState((state) => ({
      ...state,
      matchReportRepair: {
        ...scanState(state),
        initialCursorDate: plan.mode === 'initial' ? failedDate : scanState(state).initialCursorDate || null,
        lastScanError: 'fixture_source_unavailable',
        notBefore: notBeforeDate(observed, TRANSIENT_SCAN_DELAY_MS),
        updatedAt: observed.toISOString(),
      },
    }));
    return { state: 'unavailable', reason: 'fixture_source_unavailable', failedDate };
  }
  const publicReportForCandidate = (candidate) => (
    (publicReportsByFixture.get(candidate.id) || []).find((article) => isPublicReport(article, candidate)) || null
  );
  const missing = [...candidates.values()].filter((candidate) => !publicReportForCandidate(candidate));
  const queued = [];
  const queuedByFixture = new Map();
  for (const candidate of missing) {
    const item = await store.enqueue({
      kind: 'report_generation',
      fixtureId: candidate.id,
      sourceType: REPORT_GENERATION_SOURCE_TYPE,
      sourceVersion: reportGenerationVersion(candidate),
      repairGeneration: REPORT_GENERATION_REPAIR_GENERATION,
      payload: { fixture: candidatePayload(candidate) },
      trigger: 'finished_fixture_scan',
      priority: 95,
    });
    if (item.enqueued) queued.push(item.job.id);
    queuedByFixture.set(candidate.id, {
      id: item.job?.id || null,
      status: item.job?.status || null,
    });
  }
  await store.updateState((state) => {
    const previous = scanState(state);
    const initialCompletedAt = plan.mode === 'initial'
      ? (plan.completeAfterRun ? observed.toISOString() : null)
      : previous.initialCompletedAt || null;
    const fixtureRecords = { ...(previous.fixtures && typeof previous.fixtures === 'object' ? previous.fixtures : {}) };
    for (const candidate of candidates.values()) {
      const publicReport = publicReportForCandidate(candidate);
      const conflictingReport = (publicReportsByFixture.get(candidate.id) || [])
        .find((article) => isConflictingPublicReport(article, candidate)) || null;
      const priorFixture = fixtureRecords[String(candidate.id)] || null;
      const queuedJob = queuedByFixture.get(candidate.id) || null;
      // A terminal manual hold (for example an existing Notion draft) is
      // still a missing public report, but it must not be overwritten by the
      // next fixture scan as a fresh unclassified queue item.  A changed
      // result has a different durable job identity and therefore replaces
      // this hold safely.
      const preserveManualHold = !publicReport
        && queuedJob?.status === 'blocked'
        && priorFixture?.outcome === 'manual_review';
      fixtureRecords[String(candidate.id)] = {
        fixtureId: candidate.id,
        status: candidate.status,
        kickoff: candidate.kickoff,
        competition: candidate.competition,
        homeTeam: candidate.homeTeam,
        awayTeam: candidate.awayTeam,
        ...(publicReport ? {
          classification: 'normal',
          outcome: 'already_reported',
          notionPageId: publicReport?.notion?.pageId || null,
          productionArticleId: publicReport.id || null,
          sourceVersion: publicReport?.notion?.updatedAt || null,
          fixtureLinked: reportFixtureId(publicReport) === candidate.id,
          display: 'report_available',
          queuedJobId: null,
        } : preserveManualHold ? {
          ...priorFixture,
          queuedJobId: null,
          lastObservedStatus: candidate.status,
          lastObservedAt: observed.toISOString(),
        } : {
          classification: conflictingReport ? 'C_public_report_fixture_conflict' : 'report_missing_unclassified',
          outcome: 'queued_for_cause_check',
          notionPageId: conflictingReport?.notion?.pageId || null,
          productionArticleId: conflictingReport?.id || null,
          sourceVersion: null,
          fixtureLinked: false,
          display: 'report_pending',
          ...(conflictingReport ? { cause: 'fixture_card_conflict' } : {}),
          queuedJobId: queuedJob?.id || null,
        }),
        scannedAt: observed.toISOString(),
      };
    }
    return {
      ...state,
      matchReportRepair: {
        ...previous,
        version: 1,
        generation: REPORT_GENERATION_REPAIR_GENERATION,
        initialCursorDate: plan.mode === 'initial' && !plan.completeAfterRun ? plan.nextCursorDate : null,
        initialCompletedAt,
        lastScanAt: observed.toISOString(),
        lastScanError: null,
        notBefore: null,
        lastResult: {
          mode: plan.mode,
          generationChanged,
          finishedFixtures: candidates.size,
          publicReports: candidates.size - missing.length,
          missingReports: missing.length,
          enqueued: queued.length,
        },
        fixtures: fixtureRecords,
      },
    };
  });
  return {
    state: 'queued', mode: plan.mode, dates: plan.dates,
    finishedFixtures: candidates.size,
    publicReports: candidates.size - missing.length,
    missingReports: missing.length,
    queued: queued.length,
    jobs: queued,
  };
}

function responseFixture(response, fixtureId) {
  if (response?.errors && Object.keys(response.errors).length) {
    throw new MatchReportRepairError('Fixture provider reported an unavailable response', {
      code: 'FIXTURE_SOURCE_UNAVAILABLE', retryable: true,
    });
  }
  const raw = Array.isArray(response?.response) ? response.response[0] : null;
  const candidate = targetFixtureCandidate(raw);
  if (!candidate || candidate.id !== positiveId(fixtureId)) {
    throw new MatchReportRepairError('Fixture identity could not be verified', {
      code: 'FIXTURE_UNAVAILABLE', retryable: true,
    });
  }
  return candidate;
}

function matchIdentityInput(candidate) {
  return {
    fixtureId: candidate.id,
    date: candidate.date,
    kickoff: candidate.kickoff,
    timezone: candidate.timezone,
    competition: candidate.competition,
    homeTeam: candidate.homeTeam,
    awayTeam: candidate.awayTeam,
    homeTeamId: candidate.homeTeamId,
    awayTeamId: candidate.awayTeamId,
    homeGoals: candidate.homeGoals,
    awayGoals: candidate.awayGoals,
    homePenaltyGoals: candidate.homePenaltyGoals,
    awayPenaltyGoals: candidate.awayPenaltyGoals,
  };
}

async function publicReportForFixture(candidate, listPublicArticles) {
  const result = await listPublicArticles({
    type: 'match_report', fixtureId: candidate.id, page: 1, pageSize: 10,
    publishedOnly: true, throwOnError: true,
  });
  return (result?.items || []).find((article) => isPublicReport(article, candidate)) || null;
}

function conflictingPublicReportForFixture(candidate, articles) {
  return (articles?.items || []).find((article) => isConflictingPublicReport(article, candidate)) || null;
}

// Re-fetch the official fixture immediately before every generation attempt.
// The queued payload is only a deduplication/version record, never evidence
// that a match is still final or that its score is current.
export async function prepareReportGeneration({
  fixtureId,
  fetchFixture = apiFootballFetch,
  listPublicArticles = listArticles,
  findNotionReport = findNotionMatchPageTarget,
  deadlineAt = null,
  consumeRequest = null,
  consumeProviderRequest = null,
} = {}) {
  const id = positiveId(fixtureId);
  if (!id) throw new MatchReportRepairError('Invalid fixture ID', { code: 'INVALID_FIXTURE_ID', retryable: false });
  await reserveProviderRequest(consumeProviderRequest);
  const response = await fetchFixture('/fixtures', { id }, { retries: 1, timeoutMs: 12_000 });
  const fixture = responseFixture(response, id);
  if (!REPORT_TARGET_COMPETITIONS.has(fixture.leagueId)) {
    return { state: 'superseded', reason: 'outside_target_competition', fixture };
  }
  if (!FINISHED_REPORT_STATUSES.has(fixture.status) || fixture.homeGoals == null || fixture.awayGoals == null) {
    return { state: 'superseded', reason: 'fixture_not_finished', fixture };
  }
  if (compareDates(fixture.date, REPORT_RECOVERY_START_JST) < 0) {
    return { state: 'superseded', reason: 'before_recovery_window', fixture };
  }
  const publicReport = await publicReportForFixture(fixture, listPublicArticles);
  if (publicReport) return { state: 'public_report_exists', fixture, article: publicReport };
  const listedReports = await listPublicArticles({
    type: 'match_report', fixtureId: fixture.id, page: 1, pageSize: 10,
    publishedOnly: true, throwOnError: true,
  });
  const conflictingPublicReport = conflictingPublicReportForFixture(fixture, listedReports);
  const match = matchIdentityInput(fixture);
  if (conflictingPublicReport) {
    const pageId = String(conflictingPublicReport?.notion?.pageId || '').trim();
    const sourceVersion = conflictingPublicReport?.notion?.updatedAt || null;
    if (!pageId || !sourceVersion) {
      return {
        state: 'manual_review', reason: 'public_report_fixture_conflict_source_unavailable',
        fixture, match, article: conflictingPublicReport,
      };
    }
    return {
      state: 'notion_report_exists', fixture, match,
      page: { id: pageId, last_edited_time: sourceVersion }, sourceVersion,
      matchMethod: 'fixture_id_conflict', forceSourceSync: true,
    };
  }
  const found = await findNotionReport({
    match, type: 'match_report', deadlineAt, consumeRequest,
  });
  if (found.ambiguous) return { state: 'manual_review', reason: 'notion_report_ambiguous', fixture, match, found };
  if (found.page) {
    return {
      state: 'notion_report_exists', fixture, match, page: found.page,
      sourceVersion: found.page.last_edited_time || found.page.created_time || null,
      matchMethod: found.matchMethod || null,
    };
  }
  if (fixture.status === 'PEN' && (
    fixture.homePenaltyGoals == null
    || fixture.awayPenaltyGoals == null
    || fixture.homePenaltyGoals === fixture.awayPenaltyGoals
  )) {
    return { state: 'retryable', reason: 'fixture_penalty_result_unavailable', fixture, match };
  }
  return { state: 'ready', fixture, match };
}

function cleanGeneratedDraft(value) {
  return String(value || '')
    .replace(/^.*フォーマット\(AM4\).*\n+/mu, '')
    .replace(/^(#{1,3})\s+\d+\.\s*/gmu, '$1 ')
    .trim();
}

function removeGeneratedAwardCopy(draft) {
  const award = '(?:MOTM|MOM|POTM|MVP|Man of the Match|Player of the Match|試合主要人物)';
  // The deterministic body never selects an award, but remove an accidental
  // whole award section before adding AM4's single structured
  // selection.  Do not change existing Notion reports: this is only used
  // before a brand-new source page is created.
  const heading = new RegExp(`^\\s*#{1,6}\\s*(?:\\d+[.．]\\s*)?[^\\n]*${award}[^\\n]*$`, 'iu');
  const line = new RegExp(`^\\s*(?:[-*]\\s*)?(?:(?:AM4|公式)\\s*)?${award}[^\\n]*$`, 'iu');
  const continuation = /^\s*(?:根拠|理由|選出理由|criteria)\s*[：:]/iu;
  let droppingSection = false;
  let droppingInlineReason = false;
  const retained = [];
  for (const value of String(draft || '').split(/\r?\n/)) {
    if (/^\s*#{1,6}\s+/u.test(value)) {
      droppingSection = heading.test(value);
      droppingInlineReason = false;
      if (!droppingSection) retained.push(value);
      continue;
    }
    if (droppingSection) continue;
    if (line.test(value)) {
      droppingInlineReason = true;
      continue;
    }
    if (droppingInlineReason && (continuation.test(value) || !value.trim())) {
      continue;
    }
    droppingInlineReason = false;
    retained.push(value);
  }
  return retained
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function appendAm4Motm(draft, ratingResult) {
  const mom = ratingResult?.mom;
  if (!mom?.name || !mom?.team || !Number.isFinite(Number(mom.rating))) {
    throw new MatchReportRepairError('A verified AM4 MOTM selection is required', {
      code: 'MOTM_SELECTION_UNAVAILABLE', retryable: true,
    });
  }
  const contributions = Array.isArray(mom.comments) && mom.comments.length
    ? ` ${mom.comments.slice(0, 2).join('。')}。`
    : '';
  const base = removeGeneratedAwardCopy(draft);
  return `${base}\n\n## 試合主要人物\nMOTM：${mom.name}（${mom.team}）— AM4選出。\n根拠：${mom.minutes || 0}分出場、API-Footballの試合スタッツとイベントを基にしたAM4機械採点 ${mom.rating}。${contributions}`;
}

function validateGeneratedDraft(draft, fixture) {
  const body = String(draft || '').trim();
  if (body.length < 500) {
    throw new MatchReportRepairError('Generated report is too short to publish', {
      code: 'GENERATED_REPORT_INSUFFICIENT', retryable: false,
    });
  }
  if (/^(?:#{1,6}\s*)?(?:予想スコア|予想される試合展開)\b/mu.test(body)) {
    throw new MatchReportRepairError('Generated report has a prediction-only section', {
      code: 'GENERATED_REPORT_LOOKS_LIKE_PREDICTION', retryable: false,
    });
  }
  const score = `${fixture.homeGoals}-${fixture.awayGoals}`;
  if (!body.includes(score)) {
    throw new MatchReportRepairError('Generated report does not state the verified final score', {
      code: 'GENERATED_REPORT_SCORE_MISSING', retryable: false,
    });
  }
  if (fixture.status === 'PEN') {
    const penaltyScore = `${fixture.homePenaltyGoals}-${fixture.awayPenaltyGoals}`;
    if (
      fixture.homePenaltyGoals == null
      || fixture.awayPenaltyGoals == null
      || fixture.homePenaltyGoals === fixture.awayPenaltyGoals
      || !body.includes('PK')
      || !body.includes(penaltyScore)
    ) {
      throw new MatchReportRepairError('Generated report does not state the verified penalty result', {
        code: 'GENERATED_REPORT_PENALTY_RESULT_MISSING', retryable: false,
      });
    }
  }
  if (!body.includes(fixture.homeTeam) || !body.includes(fixture.awayTeam)) {
    throw new MatchReportRepairError('Generated report does not identify both verified teams', {
      code: 'GENERATED_REPORT_TEAMS_MISSING', retryable: false,
    });
  }
}

function matchInfoForDraft(fixture, events = []) {
  const fixtureId = positiveId(fixture?.id);
  return {
    fixtureId,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    homeTeamId: fixture.homeTeamId,
    awayTeamId: fixture.awayTeamId,
    homeGoals: fixture.homeGoals,
    awayGoals: fixture.awayGoals,
    homePenaltyGoals: fixture.homePenaltyGoals,
    awayPenaltyGoals: fixture.awayPenaltyGoals,
    status: fixture.status,
    competition: fixture.competition,
    round: fixture.round,
    date: fixture.kickoff,
    venue: fixture.venue,
    // Trace the exact, credential-free provider resources used for the
    // deterministic record. These endpoints intentionally omit the API key:
    // they identify the reproducible contract-data query without pretending a
    // public web page exists for every fixture.
    sourceReferences: fixtureId ? [
      {
        title: `API-Football契約データ（fixture ID ${fixtureId}: 結果・試合状態）`,
        url: `https://v3.football.api-sports.io/fixtures?id=${encodeURIComponent(fixtureId)}`,
      },
      {
        title: `API-Football契約データ（fixture ID ${fixtureId}: イベント）`,
        url: `https://v3.football.api-sports.io/fixtures/events?fixture=${encodeURIComponent(fixtureId)}`,
      },
      {
        title: `API-Football契約データ（fixture ID ${fixtureId}: 選手スタッツ）`,
        url: `https://v3.football.api-sports.io/fixtures/players?fixture=${encodeURIComponent(fixtureId)}`,
      },
    ] : [],
    // Preserve only the already retrieved provider event records for the
    // composer.  It may omit them when they cannot be reconciled to the final
    // score; it must never invent a timeline from the score alone.
    events: Array.isArray(events) ? events : [],
  };
}

function checkedProviderArray(response, label) {
  if (response?.errors && Object.keys(response.errors).length) {
    throw new MatchReportRepairError(`${label} provider response is unavailable`, {
      code: 'FIXTURE_DETAIL_UNAVAILABLE', retryable: true,
    });
  }
  return Array.isArray(response?.response) ? response.response : [];
}

// Create a new source-of-truth Notion page only after the caller has reserved
// its generation quota. This function performs no archive write itself.
export async function createGeneratedReport({
  fixture,
  match,
  fetchFixture = apiFootballFetch,
  generateDraft = generateMatchReportDraft,
  publishReport = publishGeneratedMatchReport,
  deadlineAt = null,
  consumeRequest = null,
  consumeProviderRequest = null,
} = {}) {
  if (!fixture || !match) throw new MatchReportRepairError('Verified fixture context is required', { retryable: false });
  await reserveProviderRequest(consumeProviderRequest);
  await reserveProviderRequest(consumeProviderRequest);
  const [eventsResponse, playersResponse] = await Promise.all([
    fetchFixture('/fixtures/events', { fixture: fixture.id }, { retries: 1, timeoutMs: 15_000 }),
    fetchFixture('/fixtures/players', { fixture: fixture.id }, { retries: 1, timeoutMs: 15_000 }),
  ]);
  const events = checkedProviderArray(eventsResponse, 'Fixture events');
  const players = checkedProviderArray(playersResponse, 'Fixture players');
  const ratings = computePlayerRatings(players, events, fixture.homeTeamId, fixture.awayTeamId, {
    [fixture.homeTeamId]: fixture.awayGoals,
    [fixture.awayTeamId]: fixture.homeGoals,
  });
  if (!ratings.ratings.length) {
    throw new MatchReportRepairError('Fixture player statistics are not available yet', {
      code: 'PLAYER_STATISTICS_UNAVAILABLE', retryable: true,
    });
  }
  const generated = await generateDraft(matchInfoForDraft(fixture, events), ratings, {
    deadlineAt,
    // Preserve the existing call contract so alternate safe composers can
    // honor the durable source-to-public delivery deadline.  The built-in
    // deterministic composer does no remote text-generation call.
    postGenerationReserveMs: 105_000,
  });
  const draft = cleanGeneratedDraft(generated?.draft);
  const reportDraft = appendAm4Motm(draft, ratings);
  validateGeneratedDraft(reportDraft, fixture);
  if ((reportDraft.match(/^MOTM：/gmu) || []).length !== 1) {
    throw new MatchReportRepairError('Generated report does not contain exactly one AM4 MOTM selection', {
      code: 'MOTM_SELECTION_INVALID', retryable: false,
    });
  }
  const report = await publishReport({
    match,
    draft: reportDraft,
    sources: generated?.searchSources,
    deadlineAt,
    consumeRequest,
  });
  return { ...report, fixture, match, ratings };
}

export function isRetryableReportRepairError(error) {
  if (error instanceof NotionSchemaError) return false;
  if (error instanceof MatchReportRepairError) return error.retryable;
  if (typeof error?.retryable === 'boolean') return error.retryable;
  if (error?.code === 'NOTION_RATE_LIMITED' || error?.code === 'NOTION_REQUEST_TIMEOUT') return true;
  if (Number(error?.status) >= 500 || Number(error?.status) === 429) return true;
  return true;
}

// Keep configuration/authorization failures out of the generic transport
// retry bucket.  These codes are intentionally compact because they are
// persisted in the operator queue and alert channel, never exposed to readers.
export function reportGenerationFailureReason(error, fallback = 'report_generation_invalid') {
  if (error?.notionCreateOutcomeUnknown) return 'notion_create_outcome_unknown';
  const status = Number(error?.status);
  if (error?.code === 'NOTION_HTTP_ERROR' && [400, 401, 403, 404].includes(status)) {
    return `notion_configuration_or_authorization_${status}`;
  }
  if (error instanceof NotionSchemaError) return 'notion_schema_unsupported';
  return error?.code || fallback;
}

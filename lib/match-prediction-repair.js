// Durable recovery for scheduled target fixtures that have no AM4 prediction.
//
// Predictions are source-first just like match reports: the worker checks the
// current fixture and existing Notion page before it creates anything, writes
// one schema-validated Notion page, then hands that page to the ordinary
// synchronizer for persistence, fixture association, portraits, and browser
// validation.  The deterministic copy below uses only provider observations;
// it never presents a predicted lineup, score, or player appearance as a
// confirmed event.

import { apiFootballFetch } from './api-football-client.js';
import {
  findNotionMatchPageTarget,
  NotionSchemaError,
  publishGeneratedMatchPrediction,
} from './notion-content-sync.js';
import { listArticles } from './article-store.js';
import { siteMonitorDigest } from './site-monitor-store.js';
import matchArchive from '../match-archive.js';
import {
  REPORT_TARGET_COMPETITIONS,
  targetFixtureCandidate,
  tokyoDate,
} from './match-report-repair.js';

export const PREDICTION_GENERATION_SOURCE_TYPE = 'match_prediction_generation';
export const PREDICTION_GENERATION_REPAIR_GENERATION = 'notion-match-prediction-generation-v1-deterministic';
export const PREDICTION_UPCOMING_STATUSES = new Set(['NS', 'TBD']);

const PREDICTION_LOOKAHEAD_DAYS = 2;
const PREDICTION_SCAN_INTERVAL_MS = 60 * 60 * 1000;
const TRANSIENT_SCAN_DELAY_MS = 10 * 60 * 1000;

export class MatchPredictionRepairError extends Error {
  constructor(message, { code = 'PREDICTION_REPAIR_FAILED', retryable = true, details = null } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerGoal(value) {
  const goal = finiteNumber(value);
  return Number.isInteger(goal) && goal >= 0 ? goal : null;
}

function validDate(value) {
  const date = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/u.test(date) ? date : null;
}

function addDays(date, amount) {
  const stamp = Date.parse(`${validDate(date) || ''}T12:00:00.000Z`);
  return Number.isFinite(stamp)
    ? new Date(stamp + Number(amount) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    : null;
}

function compareDates(left, right) {
  return String(left || '').localeCompare(String(right || ''));
}

function upcomingPredictionCandidate(raw) {
  const candidate = targetFixtureCandidate(raw);
  if (!candidate || !REPORT_TARGET_COMPETITIONS.has(candidate.leagueId)) return null;
  if (!PREDICTION_UPCOMING_STATUSES.has(candidate.status)) return null;
  return candidate;
}

async function reserveProviderRequest(consumeProviderRequest) {
  if (typeof consumeProviderRequest !== 'function') return;
  const reservation = await consumeProviderRequest();
  if (reservation === false || reservation?.ok === false) {
    throw new MatchPredictionRepairError('Provider request is deferred by the usage cap', {
      code: 'PROVIDER_USAGE_LIMIT', retryable: false, details: reservation || null,
    });
  }
}

function scanState(state) {
  const value = state?.matchPredictionRepair;
  return value && typeof value === 'object' ? value : {};
}

function nextTokyoMidnight(now) {
  const date = new Date(now);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 15, 0, 5)).toISOString();
}

function laterIso(now, milliseconds) {
  return new Date(new Date(now).getTime() + milliseconds).toISOString();
}

function fixturePayload(candidate) {
  return {
    fixtureId: candidate.id,
    status: candidate.status,
    kickoff: candidate.kickoff,
    date: candidate.date,
    competition: candidate.competition,
    leagueId: candidate.leagueId,
    season: candidate.season,
    homeTeam: candidate.homeTeam,
    awayTeam: candidate.awayTeam,
    homeTeamId: candidate.homeTeamId,
    awayTeamId: candidate.awayTeamId,
  };
}

export function predictionGenerationVersion(candidate) {
  return siteMonitorDigest({
    fixtureId: candidate?.id || null,
    status: candidate?.status || null,
    kickoff: candidate?.kickoff || null,
    homeTeamId: candidate?.homeTeamId || null,
    awayTeamId: candidate?.awayTeamId || null,
    leagueId: candidate?.leagueId || null,
    season: candidate?.season || null,
  }).slice(0, 40);
}

function articleFixtureId(article) {
  return positiveId(article?.match?.fixtureId);
}

function articleTeamId(article, side) {
  return positiveId(article?.match?.[`${side}TeamId`] || article?.match?.[side]?.id);
}

function articleTeamName(article, side) {
  return String(article?.match?.[`${side}Team`] || article?.match?.[side]?.name || '').trim() || null;
}

function predictionFixtureCardMatches(article, candidate) {
  const homeId = articleTeamId(article, 'home');
  const awayId = articleTeamId(article, 'away');
  if (homeId && homeId !== candidate.homeTeamId) return false;
  if (awayId && awayId !== candidate.awayTeamId) return false;
  const home = articleTeamName(article, 'home');
  const away = articleTeamName(article, 'away');
  // A valid fixture ID is useful only when every card identity that is
  // present agrees with the ordered provider fixture. A blank legacy field is
  // not a contradiction, but it must not hide the other side's known mismatch.
  // `normalizedTeam` applies the reviewed alias dictionary (Celta/Celta Vigo,
  // Man Utd/Manchester United, etc.) without any partial-name guessing.
  if (home && matchArchive.normalizedTeam(home) !== matchArchive.normalizedTeam(candidate.homeTeam)) return false;
  if (away && matchArchive.normalizedTeam(away) !== matchArchive.normalizedTeam(candidate.awayTeam)) return false;
  return true;
}

function isPublicPrediction(article, candidate) {
  return article?.type === 'match_prediction'
    && article.public !== false
    && article.status === 'published'
    && articleFixtureId(article) === candidate.id
    && predictionFixtureCardMatches(article, candidate);
}

function isConflictingPublicPrediction(article, candidate) {
  return article?.type === 'match_prediction'
    && article.public !== false
    && article.status === 'published'
    && articleFixtureId(article) === candidate.id
    && !predictionFixtureCardMatches(article, candidate);
}

function predictionMatchIdentity(candidate) {
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
  };
}

function responseFixture(response, fixtureId) {
  if (response?.errors && Object.keys(response.errors).length) {
    throw new MatchPredictionRepairError('Fixture provider response is unavailable', {
      code: 'FIXTURE_SOURCE_UNAVAILABLE', retryable: true,
    });
  }
  const candidate = upcomingPredictionCandidate(Array.isArray(response?.response) ? response.response[0] : null);
  if (!candidate || candidate.id !== positiveId(fixtureId)) {
    throw new MatchPredictionRepairError('Scheduled fixture identity could not be verified', {
      code: 'FIXTURE_UNAVAILABLE', retryable: true,
    });
  }
  return candidate;
}

function scanDates(now) {
  const today = tokyoDate(now);
  if (!today) return [];
  return Array.from({ length: PREDICTION_LOOKAHEAD_DAYS + 1 }, (_, index) => addDays(today, index)).filter(Boolean);
}

function scanAllowed(state, now) {
  const prior = scanState(state);
  const observed = new Date(now);
  const observedAt = observed.getTime();
  const last = Date.parse(prior.lastScanAt || '');
  const date = tokyoDate(observed);
  if (prior.notBefore && Date.parse(prior.notBefore) > observedAt) return false;
  return !(
    date
    && prior.lastScanTokyoDate === date
    && Number.isFinite(last)
    && observedAt - last < PREDICTION_SCAN_INTERVAL_MS
  );
}

// The archive is a public delivery mirror, not an authority for source
// creation. Still, its pagination must be exhausted before we decide that a
// scheduled fixture is missing: stopping at an arbitrary first page could
// create a duplicate Notion prediction after the archive grows.
async function listAllPublicPredictions(listPublicArticles, filters = {}) {
  const pageSize = 100;
  const rows = [];
  let page = 1;
  while (true) {
    const result = await listPublicArticles({
      type: 'match_prediction', ...filters, page, pageSize, publishedOnly: true, throwOnError: true,
    });
    const items = Array.isArray(result?.items) ? result.items : [];
    rows.push(...items);
    const totalPages = positiveId(result?.totalPages);
    if (totalPages) {
      if (page >= totalPages) return rows;
    } else if (items.length < pageSize) {
      return rows;
    }
    page += 1;
    // A malformed internal archive response must defer this repair rather
    // than silently treating an unbounded list as complete.
    if (page > 10_000) {
      throw new MatchPredictionRepairError('Public prediction archive pagination is invalid', {
        code: 'PUBLIC_ARCHIVE_PAGINATION_INVALID', retryable: true,
      });
    }
  }
}

// Fixture-first scan. It begins with scheduled target fixtures, not existing
// articles, so an entirely absent Notion prediction cannot hide behind an
// otherwise healthy match card.
export async function scanMissingMatchPredictions({
  store,
  now = () => new Date(),
  fetchFixtures = apiFootballFetch,
  listPublicArticles = listArticles,
  consumeProviderRequest = null,
} = {}) {
  const observed = new Date(now());
  const existingState = (await store.readState()).value;
  if (!scanAllowed(existingState, observed)) return { state: 'throttled', scheduledFixtures: 0, missingPredictions: 0, queued: 0, reason: 'hourly_interval' };
  const dates = scanDates(observed);
  const candidates = new Map();
  let failedDate = null;
  for (const date of dates) {
    let response;
    try {
      await reserveProviderRequest(consumeProviderRequest);
      response = await fetchFixtures('/fixtures', { date, timezone: 'Asia/Tokyo' }, { retries: 1, timeoutMs: 12_000 });
    } catch (error) {
      if (error?.code === 'PROVIDER_USAGE_LIMIT') {
        await store.updateState((state) => ({
          ...state,
          matchPredictionRepair: {
            ...scanState(state), lastScanError: 'provider_usage_limit', notBefore: nextTokyoMidnight(observed), updatedAt: observed.toISOString(),
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
      const candidate = upcomingPredictionCandidate(raw);
      if (candidate) candidates.set(candidate.id, candidate);
    }
  }
  if (failedDate) {
    await store.updateState((state) => ({
      ...state,
      matchPredictionRepair: {
        ...scanState(state), lastScanError: 'fixture_source_unavailable', notBefore: laterIso(observed, TRANSIENT_SCAN_DELAY_MS), updatedAt: observed.toISOString(),
      },
    }));
    return { state: 'unavailable', reason: 'fixture_source_unavailable', failedDate };
  }
  let rows;
  try {
    rows = await listAllPublicPredictions(listPublicArticles);
  } catch {
    // The fixture reads above do not establish that the public mirror is
    // absent. Persist a short outage backoff so the minute continuation does
    // not spend provider requests again while this independent archive read
    // is unavailable.
    await store.updateState((state) => ({
      ...state,
      matchPredictionRepair: {
        ...scanState(state),
        lastScanError: 'public_prediction_archive_unavailable',
        notBefore: laterIso(observed, TRANSIENT_SCAN_DELAY_MS),
        updatedAt: observed.toISOString(),
      },
    }));
    return { state: 'unavailable', reason: 'public_prediction_archive_unavailable' };
  }
  const missing = [...candidates.values()].filter((candidate) => !rows.some((article) => isPublicPrediction(article, candidate)));
  const queued = [];
  const queuedByFixture = new Map();
  for (const candidate of missing) {
    const item = await store.enqueue({
      kind: 'prediction_generation', fixtureId: candidate.id,
      sourceType: PREDICTION_GENERATION_SOURCE_TYPE,
      sourceVersion: predictionGenerationVersion(candidate),
      repairGeneration: PREDICTION_GENERATION_REPAIR_GENERATION,
      payload: { fixture: fixturePayload(candidate) },
      trigger: 'scheduled_fixture_scan', priority: 94,
    });
    if (item.enqueued) queued.push(item.job.id);
    queuedByFixture.set(candidate.id, { id: item.job?.id || null, status: item.job?.status || null });
  }
  await store.updateState((state) => {
    const previous = scanState(state);
    const fixtureRecords = { ...(previous.fixtures && typeof previous.fixtures === 'object' ? previous.fixtures : {}) };
    for (const candidate of candidates.values()) {
      const publicPrediction = rows.find((article) => isPublicPrediction(article, candidate)) || null;
      const conflicting = rows.find((article) => isConflictingPublicPrediction(article, candidate)) || null;
      const priorFixture = fixtureRecords[String(candidate.id)] || null;
      const queuedJob = queuedByFixture.get(candidate.id) || null;
      const preserveManualHold = !publicPrediction && (
        (queuedJob?.status === 'blocked' && priorFixture?.outcome === 'manual_review')
        // A final browser failure withdraws the monitor-created public
        // mirror and leaves the exact source revision under a durable hold.
        // Do not overwrite that operator-facing state with a fresh-looking
        // "queued" record every hourly scan; a Notion edit creates a new
        // source version and resumes the normal path.
        || priorFixture?.outcome === 'browser_validation_failed'
      );
      fixtureRecords[String(candidate.id)] = publicPrediction ? {
        fixtureId: candidate.id, status: candidate.status, kickoff: candidate.kickoff, competition: candidate.competition,
        homeTeam: candidate.homeTeam, awayTeam: candidate.awayTeam,
        classification: 'normal', outcome: 'already_predicted', notionPageId: publicPrediction?.notion?.pageId || null,
        productionArticleId: publicPrediction.id, sourceVersion: publicPrediction?.notion?.updatedAt || null,
        fixtureLinked: true, display: 'prediction_available', queuedJobId: null, scannedAt: observed.toISOString(),
      } : preserveManualHold ? {
        ...priorFixture, lastObservedStatus: candidate.status, lastObservedAt: observed.toISOString(), queuedJobId: null,
      } : {
        fixtureId: candidate.id, status: candidate.status, kickoff: candidate.kickoff, competition: candidate.competition,
        homeTeam: candidate.homeTeam, awayTeam: candidate.awayTeam,
        classification: conflicting ? 'C_public_prediction_fixture_conflict' : 'prediction_missing_unclassified',
        outcome: 'queued_for_cause_check', notionPageId: conflicting?.notion?.pageId || null,
        productionArticleId: conflicting?.id || null, sourceVersion: null, fixtureLinked: false,
        display: 'prediction_pending', ...(conflicting ? { cause: 'fixture_card_conflict' } : {}),
        queuedJobId: queuedJob?.id || null, scannedAt: observed.toISOString(),
      };
    }
    return {
      ...state,
      matchPredictionRepair: {
        ...previous, version: 1, generation: PREDICTION_GENERATION_REPAIR_GENERATION,
        lastScanAt: observed.toISOString(), lastScanTokyoDate: tokyoDate(observed), lastScanError: null, notBefore: null,
        lastResult: { scheduledFixtures: candidates.size, publicPredictions: candidates.size - missing.length, missingPredictions: missing.length, enqueued: queued.length },
        fixtures: fixtureRecords,
      },
    };
  });
  return { state: 'queued', dates, scheduledFixtures: candidates.size, publicPredictions: candidates.size - missing.length, missingPredictions: missing.length, queued: queued.length, jobs: queued };
}

async function publicPredictionForFixture(candidate, listPublicArticles) {
  const rows = await listAllPublicPredictions(listPublicArticles, { fixtureId: candidate.id });
  return rows.find((article) => isPublicPrediction(article, candidate)) || null;
}

export async function preparePredictionGeneration({
  fixtureId,
  fetchFixture = apiFootballFetch,
  listPublicArticles = listArticles,
  findNotionPrediction = findNotionMatchPageTarget,
  deadlineAt = null,
  consumeRequest = null,
  consumeProviderRequest = null,
} = {}) {
  const id = positiveId(fixtureId);
  if (!id) throw new MatchPredictionRepairError('Invalid fixture ID', { code: 'INVALID_FIXTURE_ID', retryable: false });
  await reserveProviderRequest(consumeProviderRequest);
  const response = await fetchFixture('/fixtures', { id }, { retries: 1, timeoutMs: 12_000 });
  const fixture = responseFixture(response, id);
  if (!REPORT_TARGET_COMPETITIONS.has(fixture.leagueId)) return { state: 'superseded', reason: 'outside_target_competition', fixture };
  if (!PREDICTION_UPCOMING_STATUSES.has(fixture.status)) return { state: 'superseded', reason: 'fixture_not_scheduled', fixture };
  const publicPrediction = await publicPredictionForFixture(fixture, listPublicArticles);
  if (publicPrediction) return { state: 'public_prediction_exists', fixture, article: publicPrediction };
  const listed = await listAllPublicPredictions(listPublicArticles, { fixtureId: fixture.id });
  const conflicting = listed.find((article) => isConflictingPublicPrediction(article, fixture)) || null;
  const match = predictionMatchIdentity(fixture);
  if (conflicting) {
    const pageId = String(conflicting?.notion?.pageId || '').trim();
    const sourceVersion = conflicting?.notion?.updatedAt || null;
    if (!pageId || !sourceVersion) {
      return { state: 'manual_review', reason: 'public_prediction_fixture_conflict_source_unavailable', fixture, match, article: conflicting };
    }
    return {
      state: 'notion_prediction_exists', fixture, match,
      page: { id: pageId, last_edited_time: sourceVersion }, sourceVersion,
      matchMethod: 'fixture_id_conflict', forceSourceSync: true,
    };
  }
  const found = await findNotionPrediction({ match, type: 'match_prediction', deadlineAt, consumeRequest });
  if (found.ambiguous) return { state: 'manual_review', reason: 'notion_prediction_ambiguous', fixture, match, found };
  if (found.page) {
    return {
      state: 'notion_prediction_exists', fixture, match, page: found.page,
      sourceVersion: found.page.last_edited_time || found.page.created_time || null,
      matchMethod: found.matchMethod || null,
    };
  }
  return { state: 'ready', fixture, match };
}

function checkedProviderArray(response, label) {
  if (response?.errors && Object.keys(response.errors).length) {
    throw new MatchPredictionRepairError(`${label} provider response is unavailable`, {
      code: 'PREDICTION_CONTEXT_UNAVAILABLE', retryable: true,
    });
  }
  return Array.isArray(response?.response) ? response.response : [];
}

function recentForm(rawFixtures, candidate, teamId) {
  const kickoffMs = Date.parse(candidate.kickoff || '');
  const results = (rawFixtures || [])
    .map((entry) => {
      const fixture = entry?.fixture || {};
      const teams = entry?.teams || {};
      const homeId = positiveId(teams.home?.id);
      const awayId = positiveId(teams.away?.id);
      const dateMs = Date.parse(fixture.date || '');
      const homeGoals = integerGoal(entry?.goals?.home);
      const awayGoals = integerGoal(entry?.goals?.away);
      const isHome = homeId === teamId;
      if (!['FT', 'AET', 'PEN'].includes(String(fixture.status?.short || '').toUpperCase())) return null;
      if (!Number.isFinite(dateMs) || (Number.isFinite(kickoffMs) && dateMs >= kickoffMs)) return null;
      if (!isHome && awayId !== teamId) return null;
      if (homeGoals == null || awayGoals == null) return null;
      const goalsFor = isHome ? homeGoals : awayGoals;
      const goalsAgainst = isHome ? awayGoals : homeGoals;
      const opponent = String(isHome ? teams.away?.name : teams.home?.name || '').trim();
      if (!opponent || !positiveId(fixture.id)) return null;
      return {
        fixtureId: positiveId(fixture.id), date: fixture.date, dateMs, opponent,
        goalsFor, goalsAgainst,
        result: goalsFor > goalsAgainst ? 'W' : goalsFor === goalsAgainst ? 'D' : 'L',
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.dateMs - left.dateMs)
    .slice(0, 5);
  if (!results.length) return null;
  const summary = results.reduce((output, result) => ({
    games: output.games + 1,
    wins: output.wins + (result.result === 'W' ? 1 : 0),
    draws: output.draws + (result.result === 'D' ? 1 : 0),
    losses: output.losses + (result.result === 'L' ? 1 : 0),
    goalsFor: output.goalsFor + result.goalsFor,
    goalsAgainst: output.goalsAgainst + result.goalsAgainst,
  }), { games: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0 });
  return { results, ...summary };
}

function squadIds(rawSquads, teamId) {
  const ids = new Set();
  for (const group of rawSquads || []) {
    if (positiveId(group?.team?.id) !== teamId) continue;
    for (const player of group?.players || []) {
      const id = positiveId(player?.id);
      if (id) ids.add(id);
    }
  }
  return ids;
}

function selectedRecentPerformer(rawPlayers, { teamId, teamName, form, rosterIds }) {
  const latest = form?.results?.[0] || null;
  if (!latest || !rosterIds?.size) return null;
  const team = (rawPlayers || []).find((group) => positiveId(group?.team?.id) === teamId);
  const candidates = (team?.players || []).map((entry) => {
    const playerId = positiveId(entry?.player?.id);
    const name = String(entry?.player?.name || '').trim();
    const stats = entry?.statistics?.[0] || {};
    const rating = finiteNumber(stats?.games?.rating);
    const minutes = finiteNumber(stats?.games?.minutes);
    const goals = integerGoal(stats?.goals?.total) || 0;
    const assists = integerGoal(stats?.goals?.assists) || 0;
    if (!playerId || !name || !rosterIds.has(playerId) || rating == null || minutes == null || minutes <= 0) return null;
    return { playerId, name, teamId, teamName, rating, minutes, goals, assists, latest };
  }).filter(Boolean).sort((left, right) => (
    right.rating - left.rating
    || (right.goals + right.assists) - (left.goals + left.assists)
    || right.minutes - left.minutes
    || left.playerId - right.playerId
  ));
  return candidates[0] || null;
}

function keyPlayerReason(player) {
  if (!player) return null;
  const contributions = [];
  if (player.goals) contributions.push(`${player.goals}得点`);
  if (player.assists) contributions.push(`${player.assists}アシスト`);
  const suffix = contributions.length ? `、${contributions.join('・')}を記録` : '';
  return `直近の${player.latest.opponent}戦で${Math.round(player.minutes)}分に出場し、API-Footballの評価は${player.rating.toFixed(1)}${suffix}。直近の実績を踏まえ、この試合での影響力に注目する。`;
}

function expectedScore(home, away) {
  const homeFor = home.goalsFor / home.games;
  const homeAgainst = home.goalsAgainst / home.games;
  const awayFor = away.goalsFor / away.games;
  const awayAgainst = away.goalsAgainst / away.games;
  const homeGoals = Math.max(0, Math.min(3, Math.round((homeFor + awayAgainst) / 2 + 0.2)));
  const awayGoals = Math.max(0, Math.min(3, Math.round((awayFor + homeAgainst) / 2)));
  return { homeGoals, awayGoals };
}

function predictionMetadata(candidate, homeForm, awayForm) {
  const { homeGoals, awayGoals } = expectedScore(homeForm, awayForm);
  const difference = Math.abs(homeGoals - awayGoals);
  const sample = homeForm.games + awayForm.games;
  const confidence = Math.max(50, Math.min(78, Math.round(52 + difference * 4 + Math.min(10, sample * 2))));
  return {
    score: `${homeGoals}-${awayGoals}`,
    pick: homeGoals === awayGoals ? '引き分け' : homeGoals > awayGoals ? candidate.homeTeam : candidate.awayTeam,
    confidence,
  };
}

function formSummary(team, form) {
  return `${team}は直近${form.games}試合で${form.wins}勝${form.draws}分${form.losses}敗、${form.goalsFor}得点・${form.goalsAgainst}失点。`;
}

function sourceReference(title, path, params) {
  const url = new URL(`https://v3.football.api-sports.io${path}`);
  Object.entries(params || {}).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  return { title, url: url.href };
}

function generatedPredictionDraft(candidate, homeForm, awayForm, prediction, keyPlayers) {
  const keyLines = keyPlayers.map((player) => `${player.name}（${player.teamName}）：${keyPlayerReason(player)}`).filter(Boolean);
  const homeLatest = homeForm.results[0];
  const awayLatest = awayForm.results[0];
  return [
    '# 3行要約',
    formSummary(candidate.homeTeam, homeForm),
    formSummary(candidate.awayTeam, awayForm),
    `AM4の予想は${prediction.score}、本命は${prediction.pick}。これは検証済みの直近結果から計算した試合前の見立てであり、公式の先発・試合結果ではない。`,
    '',
    '# キーマン',
    ...(keyLines.length ? keyLines : ['直近試合の評価と現登録選手を同時に確認できないため、キーマンの個人選出は保留する。本文と予想スコアは保持する。']),
    '',
    '# 予想される試合展開',
    `${candidate.homeTeam}は直近の${homeLatest.opponent}戦で${homeLatest.goalsFor}-${homeLatest.goalsAgainst}、${candidate.awayTeam}は${awayLatest.opponent}戦で${awayLatest.goalsFor}-${awayLatest.goalsAgainst}だった。両チームの直近${Math.min(homeForm.games, awayForm.games)}試合の得点・失点を比較し、ホーム側には固定の小さなホーム補正だけを加えて${prediction.score}とした。`,
    '',
    '# 予想の根拠',
    `根拠は各チームの試合前に完了している直近最大5試合の結果、現在の登録選手、および直近試合の選手スタッツである。負傷、当日の先発、戦術変更、試合中の出来事は未確定のため、確認できない事実としては書かない。`,
    '',
    '# 欠場・ローテーション情報',
    '公式の試合当日メンバー発表前であるため、確定した先発・欠場としては扱わない。最新の公式発表があればそれを優先する。',
  ].join('\n');
}

function validateGeneratedPrediction(draft, candidate, prediction) {
  const body = String(draft || '').trim();
  if (body.length < 450) {
    throw new MatchPredictionRepairError('Generated prediction is too short to publish', {
      code: 'GENERATED_PREDICTION_INSUFFICIENT', retryable: false,
    });
  }
  if (!body.includes(candidate.homeTeam) || !body.includes(candidate.awayTeam) || !body.includes(prediction.score)) {
    throw new MatchPredictionRepairError('Generated prediction lacks verified fixture identity or score metadata', {
      code: 'GENERATED_PREDICTION_IDENTITY_MISSING', retryable: false,
    });
  }
  if (!body.includes('試合前の見立て') || !body.includes('予想される試合展開') || !body.includes('予想の根拠')) {
    throw new MatchPredictionRepairError('Generated prediction does not clearly disclose its pre-match basis', {
      code: 'GENERATED_PREDICTION_DISCLOSURE_MISSING', retryable: false,
    });
  }
}

// Create one prediction only after the caller has atomically reserved both a
// generation slot and a repair write. Provider observations are retained in
// the generated source references so editorial claims remain traceable.
export async function createGeneratedPrediction({
  fixture,
  match,
  fetchFixture = apiFootballFetch,
  publishPrediction = publishGeneratedMatchPrediction,
  deadlineAt = null,
  consumeRequest = null,
  consumeProviderRequest = null,
} = {}) {
  if (!fixture || !match) throw new MatchPredictionRepairError('Verified scheduled fixture context is required', { retryable: false });
  const candidate = fixture;
  if (!PREDICTION_UPCOMING_STATUSES.has(candidate.status)) {
    throw new MatchPredictionRepairError('Prediction generation requires a currently scheduled fixture', {
      code: 'FIXTURE_NOT_SCHEDULED', retryable: false,
    });
  }
  // Reserve sequentially before starting concurrent fetch promises. Blob
  // usage accounting is compare-and-set based; parallel reservations could
  // otherwise race and undercount a provider burst.
  for (let count = 0; count < 4; count += 1) await reserveProviderRequest(consumeProviderRequest);
  const [homeHistoryResponse, awayHistoryResponse, homeSquadResponse, awaySquadResponse] = await Promise.all([
    fetchFixture('/fixtures', { team: candidate.homeTeamId, last: 5 }, { retries: 1, timeoutMs: 12_000 }),
    fetchFixture('/fixtures', { team: candidate.awayTeamId, last: 5 }, { retries: 1, timeoutMs: 12_000 }),
    fetchFixture('/players/squads', { team: candidate.homeTeamId }, { retries: 1, timeoutMs: 12_000 }),
    fetchFixture('/players/squads', { team: candidate.awayTeamId }, { retries: 1, timeoutMs: 12_000 }),
  ]);
  const homeForm = recentForm(checkedProviderArray(homeHistoryResponse, 'Home recent fixtures'), candidate, candidate.homeTeamId);
  const awayForm = recentForm(checkedProviderArray(awayHistoryResponse, 'Away recent fixtures'), candidate, candidate.awayTeamId);
  if (!homeForm || !awayForm) {
    throw new MatchPredictionRepairError('Recent completed results are not sufficient for a factual prediction', {
      code: 'PREDICTION_CONTEXT_INSUFFICIENT', retryable: true,
    });
  }
  const homeRosterIds = squadIds(checkedProviderArray(homeSquadResponse, 'Home squad'), candidate.homeTeamId);
  const awayRosterIds = squadIds(checkedProviderArray(awaySquadResponse, 'Away squad'), candidate.awayTeamId);
  // Both sides can have played the same fixture most recently. Resolve its
  // player data only once so a derby never spends the provider budget twice.
  const lastFixtureIds = [...new Set([
    homeForm.results[0]?.fixtureId,
    awayForm.results[0]?.fixtureId,
  ].filter(Boolean))];
  for (let count = 0; count < lastFixtureIds.length; count += 1) await reserveProviderRequest(consumeProviderRequest);
  const playerResponses = await Promise.all(lastFixtureIds.map((fixtureId) => (
    fetchFixture('/fixtures/players', { fixture: fixtureId }, { retries: 1, timeoutMs: 12_000 })
  )));
  const byFixture = new Map(lastFixtureIds.map((fixtureId, index) => [fixtureId, checkedProviderArray(playerResponses[index], 'Fixture player statistics')]));
  const keyPlayers = [
    selectedRecentPerformer(byFixture.get(homeForm.results[0].fixtureId), {
      teamId: candidate.homeTeamId, teamName: candidate.homeTeam, form: homeForm, rosterIds: homeRosterIds,
    }),
    selectedRecentPerformer(byFixture.get(awayForm.results[0].fixtureId), {
      teamId: candidate.awayTeamId, teamName: candidate.awayTeam, form: awayForm, rosterIds: awayRosterIds,
    }),
  ].filter(Boolean);
  const prediction = predictionMetadata(candidate, homeForm, awayForm);
  const draft = generatedPredictionDraft(candidate, homeForm, awayForm, prediction, keyPlayers);
  validateGeneratedPrediction(draft, candidate, prediction);
  const sources = [
    sourceReference(`API-Football契約データ（fixture ID ${candidate.id}: 試合日時・状態）`, '/fixtures', { id: candidate.id }),
    sourceReference(`API-Football契約データ（${candidate.homeTeam}: 直近結果）`, '/fixtures', { team: candidate.homeTeamId, last: 5 }),
    sourceReference(`API-Football契約データ（${candidate.awayTeam}: 直近結果）`, '/fixtures', { team: candidate.awayTeamId, last: 5 }),
    sourceReference(`API-Football契約データ（${candidate.homeTeam}: 現登録選手）`, '/players/squads', { team: candidate.homeTeamId }),
    sourceReference(`API-Football契約データ（${candidate.awayTeam}: 現登録選手）`, '/players/squads', { team: candidate.awayTeamId }),
    ...lastFixtureIds.map((fixtureId) => sourceReference(`API-Football契約データ（fixture ID ${fixtureId}: 選手スタッツ）`, '/fixtures/players', { fixture: fixtureId })),
  ];
  const published = await publishPrediction({ match, prediction, draft, sources, deadlineAt, consumeRequest });
  return { ...published, fixture: candidate, match, prediction, keyPlayers, homeForm, awayForm };
}

export function isRetryablePredictionRepairError(error) {
  if (error instanceof NotionSchemaError) return false;
  if (error?.retryable === false) return false;
  const status = Number(error?.status);
  if (Number.isFinite(status) && status >= 400 && status < 500 && status !== 429) return false;
  return true;
}

export function predictionGenerationFailureReason(error, fallback = 'prediction_generation_unavailable') {
  const code = String(error?.code || '').trim();
  return /^[A-Z0-9_]{3,100}$/u.test(code) ? code.toLowerCase() : fallback;
}

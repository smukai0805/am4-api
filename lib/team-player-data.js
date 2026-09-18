// Pure normalizers shared by the team and player entity pages.  Upstream
// payloads are deliberately normalized here before rendering so a missing
// provider value stays missing instead of becoming a misleading zero.

import { apiFootballFetch } from './api-football-client.js';
import { resolveStandingZone, standingZoneLegend } from './standing-qualifications.js';
import { TEAM_IDS } from './team-ids.js';

const JAPANESE_TEAM_NAMES_BY_ID = new Map();
Object.entries(TEAM_IDS).forEach(([name, id]) => {
  const numericId = Number(id);
  if (Number.isSafeInteger(numericId) && numericId > 0 && !JAPANESE_TEAM_NAMES_BY_ID.has(numericId)) {
    JAPANESE_TEAM_NAMES_BY_ID.set(numericId, name);
  }
});

export function positiveId(value) {
  const text = typeof value === 'number' ? String(value) : String(value || '').trim();
  if (!/^[1-9]\d*$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : null;
}

function optionalNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function optionalInteger(value) {
  const number = optionalNumber(value);
  return number != null && Number.isInteger(number) ? number : null;
}

function safeText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text || null;
}

function preferredTeamName(id, providerName) {
  return JAPANESE_TEAM_NAMES_BY_ID.get(positiveId(id)) || safeText(providerName);
}

function providerResponse(payload) {
  return Array.isArray(payload?.response) ? payload.response : [];
}

function statRecord(player, statistic) {
  const team = statistic?.team || {};
  const league = statistic?.league || {};
  const games = statistic?.games || {};
  const goals = statistic?.goals || {};
  const shots = statistic?.shots || {};
  const passes = statistic?.passes || {};
  const tackles = statistic?.tackles || {};
  const duels = statistic?.duels || {};
  const dribbles = statistic?.dribbles || {};
  const fouls = statistic?.fouls || {};
  const cards = statistic?.cards || {};
  return {
    playerId: positiveId(player?.id),
    name: safeText(player?.name),
    photo: safeText(player?.photo),
    teamId: positiveId(team.id),
    teamName: preferredTeamName(team.id, team.name),
    teamEnglishName: safeText(team.name),
    teamLogo: safeText(team.logo),
    teamNational: team.national === true,
    teamNationalVerified: typeof team.national === 'boolean',
    leagueId: positiveId(league.id),
    leagueName: safeText(league.name),
    season: optionalInteger(league.season),
    appearances: optionalInteger(games.appearences ?? games.appearances),
    starts: optionalInteger(games.lineups),
    minutes: optionalInteger(games.minutes),
    goals: optionalInteger(goals.total),
    assists: optionalInteger(goals.assists),
    shots: optionalInteger(shots.total),
    shotsOnTarget: optionalInteger(shots.on),
    keyPasses: optionalInteger(passes.key),
    passes: optionalInteger(passes.total),
    tackles: optionalInteger(tackles.total),
    interceptions: optionalInteger(tackles.interceptions),
    duelsWon: optionalInteger(duels.won),
    dribblesCompleted: optionalInteger(dribbles.success),
    foulsDrawn: optionalInteger(fouls.drawn),
    foulsCommitted: optionalInteger(fouls.committed),
    yellow: optionalInteger(cards.yellow),
    red: optionalInteger(cards.red),
  };
}

export function normalizeTeamPlayerStatistics(payload, { teamId, leagueId } = {}) {
  const targetTeamId = positiveId(teamId);
  const targetLeagueId = positiveId(leagueId);
  if (!targetTeamId || !targetLeagueId) return [];
  const records = [];
  for (const entry of providerResponse(payload)) {
    const player = entry?.player || {};
    for (const statistic of Array.isArray(entry?.statistics) ? entry.statistics : []) {
      const record = statRecord(player, statistic);
      if (record.playerId && record.teamId === targetTeamId && record.leagueId === targetLeagueId) records.push(record);
    }
  }
  return records;
}

function positiveStat(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function rankingRows(records, field, limit) {
  const ranked = (Array.isArray(records) ? records : [])
    .filter((record) => positiveId(record?.playerId) && positiveStat(record?.[field]) != null)
    .slice()
    .sort((left, right) => (
      right[field] - left[field]
      || String(left.name || '').localeCompare(String(right.name || ''), 'ja')
      || left.playerId - right.playerId
    ));
  const rows = [];
  let previousValue = null;
  let rank = 0;
  for (let index = 0; index < ranked.length && rows.length < limit; index += 1) {
    const record = ranked[index];
    if (record[field] !== previousValue) rank = index + 1;
    previousValue = record[field];
    rows.push({ ...record, value: record[field], rank });
  }
  return rows;
}

export function buildTopPlayerRankings(records, { limit = 5 } = {}) {
  const max = Math.min(Math.max(1, Number(limit) || 5), 8);
  return {
    goals: rankingRows(records, 'goals', max),
    assists: rankingRows(records, 'assists', max),
    minutes: rankingRows(records, 'minutes', max),
    yellow: rankingRows(records, 'yellow', max),
    red: rankingRows(records, 'red', max),
  };
}

function fixtureStatus(status = {}) {
  const short = safeText(status.short)?.toUpperCase() || 'TBD';
  const long = safeText(status.long) || short;
  if (['CANC', 'PST', 'ABD', 'AWD', 'WO'].includes(short)) return { short, label: long, kind: 'cancelled', complete: false };
  if (['TBD', 'NS'].includes(short)) return { short, label: short === 'TBD' ? '日時未定' : '試合前', kind: short === 'TBD' ? 'unscheduled' : 'scheduled', complete: false };
  if (['FT', 'AET', 'PEN'].includes(short)) return { short, label: short === 'AET' ? '延長終了' : short === 'PEN' ? 'PK戦終了' : '終了', kind: 'finished', complete: true };
  if (['1H', '2H', 'HT', 'ET', 'BT', 'P'].includes(short)) return { short, label: long, kind: 'live', complete: false };
  return { short, label: long, kind: 'scheduled', complete: false };
}

export function normalizeTeamFixture(entry = {}) {
  const fixture = entry.fixture || {};
  const teams = entry.teams || {};
  const goals = entry.goals || {};
  const status = fixtureStatus(fixture.status);
  const kickoff = safeText(fixture.date);
  return {
    fixtureId: positiveId(fixture.id),
    kickoff: kickoff && !Number.isNaN(Date.parse(kickoff)) ? kickoff : null,
    timestamp: optionalInteger(fixture.timestamp),
    leagueId: positiveId(entry.league?.id),
    leagueName: safeText(entry.league?.name),
    leagueLogo: safeText(entry.league?.logo),
    season: optionalInteger(entry.league?.season),
    round: safeText(entry.league?.round),
    home: { id: positiveId(teams.home?.id), name: preferredTeamName(teams.home?.id, teams.home?.name), logo: safeText(teams.home?.logo) },
    away: { id: positiveId(teams.away?.id), name: preferredTeamName(teams.away?.id, teams.away?.name), logo: safeText(teams.away?.logo) },
    score: {
      home: status.complete ? optionalInteger(goals.home) : null,
      away: status.complete ? optionalInteger(goals.away) : null,
    },
    status,
  };
}

function addStatistic(left, right, key) {
  const first = optionalInteger(left?.[key]);
  const second = optionalInteger(right?.[key]);
  // A multi-competition total must not look complete when either source did
  // not provide the metric.  Explicit zero remains a real zero.
  if (first == null || second == null) return null;
  return first + second;
}

function statisticTotal(records, key) {
  const values = (Array.isArray(records) ? records : []).map((record) => optionalInteger(record?.[key]));
  if (!values.length || values.some((value) => value == null)) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

function careerSeasonAssociations(history) {
  const associations = new Set();
  for (const row of Array.isArray(history) ? history : []) {
    const teamId = positiveId(row?.teamId);
    const season = optionalInteger(row?.season);
    if (teamId && season != null) associations.add(`${teamId}:${season}`);
  }
  return associations;
}

export function buildPlayerCareerRows(records, { history = [] } = {}) {
  const grouped = new Map();
  for (const input of Array.isArray(records) ? records : []) {
    const playerId = positiveId(input?.playerId);
    const season = optionalInteger(input?.season);
    const teamId = positiveId(input?.teamId);
    const leagueId = positiveId(input?.leagueId);
    if (!playerId || season == null || !teamId || !leagueId) continue;
    const key = [playerId, season, teamId].join(':');
    const competition = {
      leagueId,
      leagueName: safeText(input.leagueName),
      appearances: optionalInteger(input.appearances),
      minutes: optionalInteger(input.minutes),
      goals: optionalInteger(input.goals),
      assists: optionalInteger(input.assists),
    };
    const existing = grouped.get(key);
    if (existing) {
      const previousCompetition = existing.competitions.find((row) => row.leagueId === leagueId);
      if (previousCompetition) {
        previousCompetition.appearances = addStatistic(previousCompetition, competition, 'appearances');
        previousCompetition.minutes = addStatistic(previousCompetition, competition, 'minutes');
        previousCompetition.goals = addStatistic(previousCompetition, competition, 'goals');
        previousCompetition.assists = addStatistic(previousCompetition, competition, 'assists');
      } else {
        existing.competitions.push(competition);
      }
      continue;
    }
    grouped.set(key, {
      playerId,
      season,
      teamId,
      teamName: preferredTeamName(teamId, input.teamName),
      teamLogo: safeText(input.teamLogo),
      appearances: competition.appearances,
      minutes: competition.minutes,
      goals: competition.goals,
      assists: competition.assists,
      competitions: [competition],
    });
  }
  const rows = [...grouped.values()];
  for (const row of rows) {
    row.appearances = statisticTotal(row.competitions, 'appearances');
    row.minutes = statisticTotal(row.competitions, 'minutes');
    row.goals = statisticTotal(row.competitions, 'goals');
    row.assists = statisticTotal(row.competitions, 'assists');
    row.competitions.sort((left, right) => String(left.leagueName || '').localeCompare(String(right.leagueName || ''), 'ja'));
  }
  const associations = careerSeasonAssociations(history);
  return rows.sort((left, right) => {
    const bySeason = right.season - left.season;
    if (bySeason) return bySeason;
    // The players/teams feed is an association list, not a transfer timeline.
    // Infer a same-season order only from immediately adjacent seasons: a
    // later return to a former club must not rewrite an older transfer.
    const leftContinues = associations.has(`${left.teamId}:${left.season + 1}`) ? 1 : 0;
    const rightContinues = associations.has(`${right.teamId}:${right.season + 1}`) ? 1 : 0;
    if (leftContinues !== rightContinues) return rightContinues - leftContinues;
    const leftPrecedes = associations.has(`${left.teamId}:${left.season - 1}`) ? 1 : 0;
    const rightPrecedes = associations.has(`${right.teamId}:${right.season - 1}`) ? 1 : 0;
    if (leftPrecedes !== rightPrecedes) return leftPrecedes - rightPrecedes;
    return String(left.teamName || '').localeCompare(String(right.teamName || ''), 'ja');
  });
}

export function normalizePlayerStatistics(payload) {
  const records = [];
  for (const entry of providerResponse(payload)) {
    const player = entry?.player || {};
    for (const statistic of Array.isArray(entry?.statistics) ? entry.statistics : []) {
      const record = statRecord(player, statistic);
      if (record.playerId && record.teamId && record.leagueId && record.season != null) records.push(record);
    }
  }
  return records;
}

export function normalizeTeamIdentity(payload, expectedId = null) {
  const entry = providerResponse(payload)[0] || {};
  const team = entry?.team || entry;
  const id = positiveId(team.id);
  if (!id || (expectedId && id !== positiveId(expectedId))) return null;
  return {
    id,
    name: preferredTeamName(team.id, team.name),
    englishName: safeText(team.name),
    code: safeText(team.code),
    country: safeText(team.country),
    founded: optionalInteger(team.founded),
    national: typeof team.national === 'boolean' ? team.national : null,
    logo: safeText(team.logo),
    venue: (entry.venue || team.venue) && typeof (entry.venue || team.venue) === 'object' ? {
      name: safeText((entry.venue || team.venue).name),
      city: safeText((entry.venue || team.venue).city),
      capacity: optionalInteger((entry.venue || team.venue).capacity),
    } : null,
  };
}

export function normalizePlayerProfile(payload, expectedId = null) {
  const response = providerResponse(payload);
  const source = response[0]?.player || response[0] || {};
  const id = positiveId(source.id);
  if (!id || (expectedId && id !== positiveId(expectedId))) return null;
  return {
    id,
    name: safeText(source.name),
    firstname: safeText(source.firstname),
    lastname: safeText(source.lastname),
    age: ageFromBirth(source.birth?.date) ?? optionalInteger(source.age),
    birth: {
      date: safeText(source.birth?.date),
      place: safeText(source.birth?.place),
      country: safeText(source.birth?.country),
    },
    nationality: safeText(source.nationality),
    height: safeText(source.height),
    weight: safeText(source.weight),
    injured: source.injured === true,
    photo: safeText(source.photo),
    position: safeText(source.position),
    number: optionalInteger(source.number),
    // A profile's direct team is a current-team candidate. Its team identity
    // is verified before it is rendered as a current club.
    currentTeam: source.team && positiveId(source.team.id) ? {
      id: positiveId(source.team.id),
      name: preferredTeamName(source.team.id, source.team.name),
      englishName: safeText(source.team.name),
      logo: safeText(source.team.logo),
      national: typeof source.team.national === 'boolean' ? source.team.national : null,
    } : null,
  };
}

function ageFromBirth(value, now = new Date()) {
  const birth = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birth)) return null;
  const [year, month, day] = birth.split('-').map(Number);
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;
  const currentDay = now.getUTCDate();
  const age = currentYear - year - (currentMonth < month || (currentMonth === month && currentDay < day) ? 1 : 0);
  return Number.isInteger(age) && age >= 0 && age < 100 ? age : null;
}

const POSITION_LABELS = {
  Goalkeeper: 'GK',
  Defender: 'DF',
  Midfielder: 'MF',
  Attacker: 'FW',
};
const POSITION_ORDER = { GK: 1, DF: 2, MF: 3, FW: 4, OTHER: 5 };
const MIN_ENTITY_SEASON = 2000;

function currentTokyoSeason(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit',
  }).formatToParts(now).reduce((all, part) => ({ ...all, [part.type]: part.value }), {});
  return Number(parts.month) >= 7 ? Number(parts.year) : Number(parts.year) - 1;
}

function validSeason(value, now = new Date()) {
  const season = optionalInteger(value);
  const maximum = currentTokyoSeason(now) + 1;
  return season != null && season >= MIN_ENTITY_SEASON && season <= maximum ? season : null;
}

export function providerErrors(payload) {
  return payload?.errors && typeof payload.errors === 'object' && Object.keys(payload.errors).length
    ? payload.errors
    : null;
}

function assertProviderData(payload, context) {
  if (providerErrors(payload)) throw new Error(`${context} unavailable`);
  return payload;
}

function teamCompetitionRows(payload) {
  const rows = [];
  for (const source of providerResponse(payload)) {
    const league = source?.league || {};
    const leagueId = positiveId(league.id);
    if (!leagueId) continue;
    for (const season of Array.isArray(source?.seasons) ? source.seasons : []) {
      const year = validSeason(season?.year);
      if (year == null) continue;
      rows.push({
        leagueId,
        leagueName: safeText(league.name),
        leagueLogo: safeText(league.logo),
        leagueType: safeText(league.type),
        country: safeText(source?.country?.name || league.country),
        season: year,
        current: season?.current === true,
        coverage: season?.coverage && typeof season.coverage === 'object' ? {
          fixtures: season.coverage.fixtures !== false,
          standings: season.coverage.standings === true,
          players: season.coverage.players === true,
        } : null,
      });
    }
  }
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.leagueId}:${row.season}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => (
    Number(right.current) - Number(left.current)
    || Number(right.leagueType === 'League') - Number(left.leagueType === 'League')
    || right.season - left.season
    || String(left.leagueName || '').localeCompare(String(right.leagueName || ''), 'ja')
  ));
}

export function normalizeTeamCompetitions(payload) {
  return teamCompetitionRows(payload);
}

export function selectTeamCompetition(options, { leagueId = null, season = null } = {}) {
  const rows = Array.isArray(options) ? options : [];
  const requestedLeagueId = positiveId(leagueId);
  const requestedSeason = validSeason(season);
  if (requestedLeagueId && requestedSeason != null) {
    const exact = rows.find((row) => row.leagueId === requestedLeagueId && row.season === requestedSeason);
    if (exact) return exact;
  }
  if (requestedLeagueId) {
    const leagueRows = rows.filter((row) => row.leagueId === requestedLeagueId);
    if (leagueRows.length) return leagueRows[0];
  }
  if (requestedSeason != null) {
    const seasonRows = rows.filter((row) => row.season === requestedSeason);
    if (seasonRows.length) return seasonRows[0];
  }
  return rows[0] || null;
}

export function currentTeamCompetition(options) {
  const current = (Array.isArray(options) ? options : []).filter((row) => row?.current === true);
  return current.find((row) => row.leagueType === 'League' && row.country && row.country !== 'World')
    || current.find((row) => row.leagueType === 'League')
    || current[0]
    || null;
}

function squadPosition(value) {
  return POSITION_LABELS[safeText(value)] || 'OTHER';
}

export function normalizeCurrentSquad(payload) {
  const source = providerResponse(payload)[0];
  const players = Array.isArray(source?.players) ? source.players : [];
  const seen = new Set();
  return players.map((player) => ({
    playerId: positiveId(player?.id),
    name: safeText(player?.name),
    photo: safeText(player?.photo),
    number: optionalInteger(player?.number),
    age: optionalInteger(player?.age),
    nationality: safeText(player?.nationality),
    position: squadPosition(player?.position),
    providerPosition: safeText(player?.position),
  })).filter((player) => {
    if (!player.playerId || seen.has(player.playerId)) return false;
    seen.add(player.playerId);
    return true;
  }).sort((left, right) => (
    POSITION_ORDER[left.position] - POSITION_ORDER[right.position]
    || (left.number ?? Number.MAX_SAFE_INTEGER) - (right.number ?? Number.MAX_SAFE_INTEGER)
    || String(left.name || '').localeCompare(String(right.name || ''), 'ja')
  ));
}

export function mergeCurrentSquadWithStatistics(squad, statistics) {
  const statsByPlayerId = new Map((Array.isArray(statistics) ? statistics : [])
    .filter((record) => positiveId(record?.playerId))
    .map((record) => [record.playerId, record]));
  return (Array.isArray(squad) ? squad : []).map((player) => {
    const stats = statsByPlayerId.get(player.playerId);
    return {
      ...player,
      appearances: stats?.appearances ?? null,
      goals: stats?.goals ?? null,
      assists: stats?.assists ?? null,
      minutes: stats?.minutes ?? null,
      yellow: stats?.yellow ?? null,
      red: stats?.red ?? null,
    };
  });
}

function fixtureMoment(fixture) {
  const timestamp = Number(fixture?.timestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) return timestamp * 1000;
  const parsed = Date.parse(fixture?.kickoff || '');
  return Number.isFinite(parsed) ? parsed : null;
}

export function orderTeamFixtures(fixtures, now = Date.now()) {
  const unique = new Map();
  for (const fixture of Array.isArray(fixtures) ? fixtures : []) {
    if (positiveId(fixture?.fixtureId)) unique.set(fixture.fixtureId, fixture);
  }
  const values = [...unique.values()];
  const upcoming = values.filter((fixture) => {
    const moment = fixtureMoment(fixture);
    return moment != null && moment >= now && !fixture.status?.complete && fixture.status?.kind !== 'cancelled';
  }).sort((left, right) => fixtureMoment(left) - fixtureMoment(right));
  const recent = values.filter((fixture) => fixture.status?.complete || (fixtureMoment(fixture) != null && fixtureMoment(fixture) < now))
    .filter((fixture) => !upcoming.includes(fixture))
    .sort((left, right) => fixtureMoment(right) - fixtureMoment(left));
  const unscheduled = values.filter((fixture) => !upcoming.includes(fixture) && !recent.includes(fixture))
    .sort((left, right) => String(left.leagueName || '').localeCompare(String(right.leagueName || ''), 'ja'));
  return { upcoming, recent, unscheduled };
}

export function normalizeStandingGroups(payload, { teamId = null, competition = null, season = null } = {}) {
  const targetTeamId = positiveId(teamId);
  const groups = payload?.response?.[0]?.league?.standings;
  if (!Array.isArray(groups)) return [];
  return groups.map((group, groupIndex) => ({
    label: safeText(group?.[0]?.group) || (groups.length > 1 ? `グループ ${groupIndex + 1}` : null),
    rows: (Array.isArray(group) ? group : []).map((row) => {
      const description = safeText(row?.description);
      const status = safeText(row?.status);
      const zone = resolveStandingZone({
        rank: row?.rank,
        description,
        status,
        competition,
        season,
      });
      return {
        rank: optionalInteger(row?.rank),
        teamId: positiveId(row?.team?.id),
        name: preferredTeamName(row?.team?.id, row?.team?.name),
        logo: safeText(row?.team?.logo),
        played: optionalInteger(row?.all?.played),
        wins: optionalInteger(row?.all?.win),
        draws: optionalInteger(row?.all?.draw),
        losses: optionalInteger(row?.all?.lose),
        goalsDiff: optionalInteger(row?.goalsDiff),
        points: optionalInteger(row?.points),
        description,
        status,
        zone: zone.key,
        zoneSource: zone.source,
        highlighted: positiveId(row?.team?.id) === targetTeamId,
      };
    }),
  })).filter((group) => group.rows.length);
}

function statSum(records, field) {
  const values = records.map((record) => optionalInteger(record?.[field]));
  if (!values.length || values.some((value) => value == null)) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

export function buildPlayerStatsSummary(records) {
  const list = Array.isArray(records) ? records : [];
  return {
    appearances: statSum(list, 'appearances'),
    starts: statSum(list, 'starts'),
    minutes: statSum(list, 'minutes'),
    goals: statSum(list, 'goals'),
    assists: statSum(list, 'assists'),
    shots: statSum(list, 'shots'),
    shotsOnTarget: statSum(list, 'shotsOnTarget'),
    keyPasses: statSum(list, 'keyPasses'),
    passes: statSum(list, 'passes'),
    tackles: statSum(list, 'tackles'),
    interceptions: statSum(list, 'interceptions'),
    duelsWon: statSum(list, 'duelsWon'),
    dribblesCompleted: statSum(list, 'dribblesCompleted'),
    foulsDrawn: statSum(list, 'foulsDrawn'),
    foulsCommitted: statSum(list, 'foulsCommitted'),
    yellow: statSum(list, 'yellow'),
    red: statSum(list, 'red'),
  };
}

export function playerLeagueOptions(records) {
  const seen = new Set();
  return (Array.isArray(records) ? records : []).map((record) => ({
    leagueId: positiveId(record?.leagueId), leagueName: safeText(record?.leagueName),
  })).filter((league) => {
    if (!league.leagueId || seen.has(league.leagueId)) return false;
    seen.add(league.leagueId);
    return true;
  }).sort((left, right) => String(left.leagueName || '').localeCompare(String(right.leagueName || ''), 'ja'));
}

const TEAM_IDENTITY_CACHE_TTL_MS = 60 * 60 * 1000;
const teamIdentityCache = new Map();
const PLAYER_PROFILE_CACHE_TTL_MS = 60 * 60 * 1000;
const PLAYER_TEAMS_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const PLAYER_CURRENT_TEAM_CACHE_TTL_MS = 60 * 60 * 1000;
const PLAYER_CURRENT_STATISTICS_CACHE_TTL_MS = 5 * 60 * 1000;
const PLAYER_HISTORICAL_STATISTICS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const playerProfileCache = new Map();
const playerTeamsCache = new Map();
const playerCurrentTeamCache = new Map();
const playerSeasonStatisticsCache = new Map();

async function cachedRead(cache, key, ttlMs, load) {
  const cached = cache.get(key);
  if (cached?.expiresAt > Date.now()) return cached.promise;
  const promise = Promise.resolve().then(load);
  cache.set(key, { expiresAt: Date.now() + ttlMs, promise });
  try {
    return await promise;
  } catch (error) {
    if (cache.get(key)?.promise === promise) cache.delete(key);
    throw error;
  }
}

async function fetchTeamIdentity(teamId) {
  const safeTeamId = positiveId(teamId);
  if (!safeTeamId) return null;
  const cached = teamIdentityCache.get(safeTeamId);
  if (cached?.expiresAt > Date.now()) return cached.promise;
  const promise = (async () => {
    const payload = assertProviderData(await apiFootballFetch('/teams', { id: safeTeamId }, { retries: 1, timeoutMs: 12000 }), 'team');
    return normalizeTeamIdentity(payload, safeTeamId);
  })();
  teamIdentityCache.set(safeTeamId, { expiresAt: Date.now() + TEAM_IDENTITY_CACHE_TTL_MS, promise });
  try {
    return await promise;
  } catch (error) {
    if (teamIdentityCache.get(safeTeamId)?.promise === promise) teamIdentityCache.delete(safeTeamId);
    throw error;
  }
}

async function fetchTeamCompetitions(teamId) {
  const payload = assertProviderData(await apiFootballFetch('/leagues', { team: teamId }, { retries: 1, timeoutMs: 12000 }), 'competitions');
  return normalizeTeamCompetitions(payload);
}

async function fetchAllTeamPlayerStatistics({ teamId, leagueId, season }) {
  const records = [];
  const maximumPages = 10;
  for (let page = 1; page <= maximumPages; page += 1) {
    const payload = assertProviderData(await apiFootballFetch('/players', {
      team: teamId, league: leagueId, season, page,
    }, { retries: 1, timeoutMs: 15000 }), 'player statistics');
    records.push(...normalizeTeamPlayerStatistics(payload, { teamId, leagueId }));
    const paging = payload?.paging || {};
    const total = optionalInteger(paging.total);
    const current = optionalInteger(paging.current) || page;
    // A club ranking is only meaningful when every provider page was read.
    // Do not treat an incomplete pagination envelope as a complete first page.
    if (total == null) throw new Error('player statistics pagination unavailable');
    if (current >= total) break;
    if (page === maximumPages) throw new Error('player statistics incomplete');
  }
  return records;
}

async function fetchTeamFixtures({ teamId, leagueId, season }) {
  const payload = assertProviderData(await apiFootballFetch('/fixtures', {
    team: teamId, league: leagueId, season, timezone: 'Asia/Tokyo',
  }, { retries: 1, timeoutMs: 15000 }), 'fixtures');
  const fixtures = providerResponse(payload).map(normalizeTeamFixture).filter((fixture) => fixture.fixtureId);
  try {
    const { getMatchContentAvailability } = await import('./article-store.js');
    const ids = fixtures.map((fixture) => fixture.fixtureId);
    const availability = await getMatchContentAvailability(ids);
    fixtures.forEach((fixture) => { fixture.editorials = availability.availability?.[fixture.fixtureId] || []; });
  } catch (error) {
    // Fixture data remains correct when editorial badges are temporarily
    // unavailable.  Do not claim that no prediction/report exists.
    fixtures.forEach((fixture) => { fixture.editorials = null; });
  }
  return orderTeamFixtures(fixtures);
}

async function loadTeamColumns(teamId) {
  try {
    const { listRelatedColumnArticles } = await import('./article-store.js');
    return { state: 'ready', items: await listRelatedColumnArticles({ teamId }) };
  } catch (error) {
    console.error(`[team columns] ${teamId} unavailable:`, error);
    return { state: 'error', items: [] };
  }
}

async function teamSection({ teamId, selection, tab }) {
  if (tab === 'columns') return loadTeamColumns(teamId);
  if (!selection) return { state: 'empty', message: '利用可能な大会・シーズンが見つかりません。' };
  if (tab === 'fixtures') {
    const fixtures = await fetchTeamFixtures({ teamId, leagueId: selection.leagueId, season: selection.season });
    return { state: 'ready', ...fixtures };
  }
  if (tab === 'roster') {
    const [squadPayload, statistics] = await Promise.all([
      apiFootballFetch('/players/squads', { team: teamId }, { retries: 1, timeoutMs: 15000 }).then((payload) => assertProviderData(payload, 'squad')),
      fetchAllTeamPlayerStatistics({ teamId, leagueId: selection.leagueId, season: selection.season }),
    ]);
    return {
      state: 'ready',
      scope: '現在の所属選手。数値は選択した大会・シーズンにおけるこのクラブでの記録です。',
      players: mergeCurrentSquadWithStatistics(normalizeCurrentSquad(squadPayload), statistics),
    };
  }
  if (tab === 'standings') {
    const payload = assertProviderData(await apiFootballFetch('/standings', {
      league: selection.leagueId, season: selection.season,
    }, { retries: 1, timeoutMs: 15000 }), 'standings');
    const groups = normalizeStandingGroups(payload, {
      teamId,
      competition: selection.leagueName,
      season: selection.season,
    });
    return groups.length
      ? { state: 'ready', groups, qualificationLegend: standingZoneLegend(groups.flatMap((group) => group.rows)) }
      : { state: 'empty', message: 'この大会の順位表は提供されていません。' };
  }
  if (tab === 'rankings') {
    const statistics = await fetchAllTeamPlayerStatistics({ teamId, leagueId: selection.leagueId, season: selection.season });
    const rankings = buildTopPlayerRankings(statistics);
    const hasRows = Object.values(rankings).some((rows) => rows.length);
    return hasRows
      ? { state: 'ready', rankings, scope: '選択した大会・シーズンにおける、このクラブの選手記録です。' }
      : { state: 'empty', message: 'ランキングを作成できる選手記録はありません。' };
  }
  return { state: 'empty', message: 'このタブは利用できません。' };
}

const TEAM_TABS = new Set(['fixtures', 'roster', 'standings', 'rankings', 'columns']);

export async function loadTeamPageData({ teamId, leagueId = null, season = null, tab = 'fixtures' } = {}) {
  const safeTeamId = positiveId(teamId);
  if (!safeTeamId) return { state: 'not_found' };
  const team = await fetchTeamIdentity(safeTeamId);
  if (!team) return { state: 'not_found' };
  let competitions = [];
  let competitionState = 'ready';
  try {
    competitions = await fetchTeamCompetitions(safeTeamId);
  } catch (error) {
    console.error(`[team competitions] ${safeTeamId} unavailable:`, error);
    competitionState = 'error';
  }
  const selection = selectTeamCompetition(competitions, { leagueId, season });
  const selectedTab = TEAM_TABS.has(tab) ? tab : 'fixtures';
  const columnsPromise = loadTeamColumns(safeTeamId);
  let section;
  let columns;
  if (selectedTab === 'columns') {
    columns = await columnsPromise;
    section = columns;
  } else {
    [columns, section] = await Promise.all([
      columnsPromise,
      teamSection({ teamId: safeTeamId, selection, tab: selectedTab }).catch((error) => {
        console.error(`[team ${selectedTab}] ${safeTeamId} unavailable:`, error);
        return { state: 'error', message: 'この情報を取得できませんでした。もう一度お試しください。' };
      }),
    ]);
  }
  return {
    state: 'ready', team, competitions, competitionState, selection,
    currentCompetition: currentTeamCompetition(competitions),
    tab: selectedTab, columns, section,
  };
}

export async function loadTeamSectionData({ teamId, leagueId = null, season = null, tab = 'fixtures' } = {}) {
  const safeTeamId = positiveId(teamId);
  if (!safeTeamId) return { state: 'not_found' };
  if (!TEAM_TABS.has(tab)) return { state: 'invalid' };
  let competitions = [];
  try {
    competitions = await fetchTeamCompetitions(safeTeamId);
  } catch (error) {
    return { state: 'error', message: '大会・シーズン情報を取得できませんでした。' };
  }
  const selection = selectTeamCompetition(competitions, { leagueId, season });
  const columnsPromise = loadTeamColumns(safeTeamId);
  try {
    if (tab === 'columns') {
      const columns = await columnsPromise;
      return { state: 'ready', competitions, competitionState: 'ready', selection, tab, columns, section: columns };
    }
    const [columns, section] = await Promise.all([columnsPromise, teamSection({ teamId: safeTeamId, selection, tab })]);
    return { state: 'ready', competitions, competitionState: 'ready', selection, tab, columns, section };
  } catch (error) {
    console.error(`[team section] ${safeTeamId}/${tab} unavailable:`, error);
    const columns = await columnsPromise;
    return {
      state: 'ready', competitions, competitionState: 'ready', selection, tab, columns,
      section: { state: 'error', message: 'この情報を取得できませんでした。もう一度お試しください。' },
    };
  }
}

export function normalizePlayerTeamHistory(payload) {
  const rows = [];
  const add = (source, inheritedTeam = null) => {
    if (!source || typeof source !== 'object') return;
    const team = source.team || inheritedTeam;
    const teamId = positiveId(team?.id);
    const season = validSeason(source.season?.year ?? source.season ?? source.year);
    if (teamId && season != null) {
      rows.push({
        teamId, teamName: preferredTeamName(teamId, team?.name), teamLogo: safeText(team?.logo), season,
        current: source.current === true || source.active === true || source.is_current === true || team?.current === true,
      });
    }
    if (Array.isArray(source.seasons)) source.seasons.forEach((seasonEntry) => {
      const season = typeof seasonEntry === 'object' && seasonEntry !== null
        ? seasonEntry
        : { season: seasonEntry };
      add({ ...season, team }, team);
    });
    if (Array.isArray(source.teams)) source.teams.forEach((teamEntry) => add(teamEntry));
  };
  providerResponse(payload).forEach((entry) => add(entry));
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.teamId}:${row.season}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => right.season - left.season || left.teamId - right.teamId);
}

async function verifiedClubTeam(team) {
  const teamId = positiveId(team?.id);
  if (!teamId || team?.national === true) return null;
  try {
    const identity = await fetchTeamIdentity(teamId);
    return identity?.national === false ? publicTeamIdentity(identity) : null;
  } catch (_error) {
    return null;
  }
}

async function currentTeamFromHistory(rows) {
  const candidates = [...new Map((Array.isArray(rows) ? rows : [])
    .filter((row) => row?.current === true)
    .map((row) => [positiveId(row.teamId), {
      id: row.teamId, name: row.teamName, logo: row.teamLogo, national: null,
    }]))
    .values()]
    .filter((team) => positiveId(team.id));
  const resolved = await Promise.all(candidates.map(verifiedClubTeam));
  const clubs = resolved.filter(Boolean);
  return clubs.length === 1 ? clubs[0] : null;
}

export function currentTeamCandidatesFromPlayerSquad(payload, playerId) {
  const targetPlayerId = positiveId(playerId);
  if (!targetPlayerId) return null;
  const candidates = [];
  const seen = new Set();
  for (const entry of providerResponse(payload)) {
    const team = entry?.team || {};
    const teamId = positiveId(team.id);
    if (!teamId) continue;
    const players = Array.isArray(entry?.players) ? entry.players : [];
    if (!players.some((player) => positiveId(player?.id) === targetPlayerId)) continue;
    if (seen.has(teamId)) continue;
    seen.add(teamId);
    candidates.push({
      id: teamId,
      name: preferredTeamName(teamId, team.name),
      englishName: safeText(team.name),
      logo: safeText(team.logo),
      national: typeof team.national === 'boolean' ? team.national : null,
    });
  }
  return candidates;
}

function publicTeamIdentity(team) {
  return team ? {
    id: team.id,
    name: team.name,
    englishName: team.englishName,
    logo: team.logo,
  } : null;
}

async function fetchPlayerProfile(playerId) {
  const safePlayerId = positiveId(playerId);
  if (!safePlayerId) return null;
  return cachedRead(playerProfileCache, safePlayerId, PLAYER_PROFILE_CACHE_TTL_MS, async () => {
    const payload = assertProviderData(await apiFootballFetch('/players/profiles', { player: safePlayerId }, { retries: 1, timeoutMs: 15000 }), 'player profile');
    return normalizePlayerProfile(payload, safePlayerId);
  });
}

async function fetchPlayerTeams(playerId) {
  const safePlayerId = positiveId(playerId);
  if (!safePlayerId) return [];
  return cachedRead(playerTeamsCache, safePlayerId, PLAYER_TEAMS_CACHE_TTL_MS, async () => {
    const payload = assertProviderData(await apiFootballFetch('/players/teams', { player: safePlayerId }, { retries: 1, timeoutMs: 15000 }), 'player teams');
    return normalizePlayerTeamHistory(payload);
  });
}

async function fetchPlayerCurrentTeam(playerId) {
  const safePlayerId = positiveId(playerId);
  if (!safePlayerId) return null;
  return cachedRead(playerCurrentTeamCache, safePlayerId, PLAYER_CURRENT_TEAM_CACHE_TTL_MS, async () => {
    const payload = assertProviderData(await apiFootballFetch('/players/squads', { player: safePlayerId }, { retries: 1, timeoutMs: 15000 }), 'current player squad');
    const candidates = currentTeamCandidatesFromPlayerSquad(payload, safePlayerId) || [];
    if (!candidates.length) return null;
    const resolved = await Promise.all(candidates.map(async (candidate) => {
      try { return await fetchTeamIdentity(candidate.id); } catch (_error) { return null; }
    }));
    const clubs = resolved.filter((team) => team?.national === false);
    return clubs.length === 1 ? publicTeamIdentity(clubs[0]) : null;
  });
}

async function classifyPlayerTeamNationalStatus(records) {
  const teamIds = [...new Set((Array.isArray(records) ? records : [])
    .map((record) => positiveId(record?.teamId))
    .filter(Boolean))];
  const identities = await Promise.all(teamIds.map(async (teamId) => {
    try { return await fetchTeamIdentity(teamId); } catch (_error) { return null; }
  }));
  const byId = new Map(identities.filter(Boolean).map((team) => [team.id, team]));
  return (Array.isArray(records) ? records : []).map((record) => {
    const team = byId.get(positiveId(record?.teamId));
    return team ? {
      ...record,
      teamNational: team.national,
      teamNationalVerified: typeof team.national === 'boolean',
    } : record;
  });
}

export function confirmedClubPlayerRecords(records) {
  return (Array.isArray(records) ? records : [])
    .filter((record) => record?.teamNationalVerified === true && record.teamNational === false);
}

async function loadPlayerContext(playerId) {
  const [profileResult, historyResult, currentTeamResult] = await Promise.allSettled([
    fetchPlayerProfile(playerId),
    fetchPlayerTeams(playerId),
    fetchPlayerCurrentTeam(playerId),
  ]);
  if (profileResult.status === 'rejected') throw profileResult.reason;
  const profile = profileResult.value;
  if (!profile) return { state: 'not_found' };
  let history = [];
  let historyState = 'ready';
  if (historyResult.status === 'fulfilled') {
    history = historyResult.value;
  } else {
    console.error(`[player teams] ${playerId} unavailable:`, historyResult.reason);
    historyState = 'error';
  }
  const currentSquadTeam = currentTeamResult.status === 'fulfilled' ? currentTeamResult.value : null;
  if (currentTeamResult.status === 'rejected') {
    // Profile and stat data remain useful when the current-squad endpoint is
    // temporarily unavailable. Never substitute a historical team instead.
    console.error(`[player current team] ${playerId} unavailable:`, currentTeamResult.reason);
  }
  const profileCurrentTeam = await verifiedClubTeam(profile.currentTeam);
  const historyCurrentTeam = profileCurrentTeam || currentSquadTeam ? null : await currentTeamFromHistory(history);
  return {
    state: 'ready',
    player: {
      ...profile,
      currentTeam: profileCurrentTeam || currentSquadTeam || historyCurrentTeam,
    },
    history,
    historyState,
  };
}

function newestHistorySeason(history, { currentOnly = false } = {}) {
  const seasons = (Array.isArray(history) ? history : [])
    .filter((row) => !currentOnly || row?.current === true)
    .map((row) => validSeason(row?.season))
    .filter((season) => season != null)
    .sort((left, right) => right - left);
  return seasons[0] || null;
}

async function resolveInitialPlayerSeason({ requestedSeason, player, history }) {
  const requested = validSeason(requestedSeason);
  if (requested != null) return requested;
  const historyCurrent = newestHistorySeason(history, { currentOnly: true });
  if (historyCurrent != null) return historyCurrent;
  const teamId = positiveId(player?.currentTeam?.id);
  if (teamId) {
    try {
      const current = currentTeamCompetition(await fetchTeamCompetitions(teamId));
      if (current?.season != null) return current.season;
    } catch (error) {
      console.error(`[player season] ${player?.id || 'unknown'} team competitions unavailable:`, error);
    }
  }
  return newestHistorySeason(history) ?? currentTokyoSeason();
}

async function fetchPlayerSeasonStatistics(playerId, season) {
  const safePlayerId = positiveId(playerId);
  const safeSeason = validSeason(season);
  if (!safePlayerId || safeSeason == null) return [];
  const ttl = safeSeason >= currentTokyoSeason()
    ? PLAYER_CURRENT_STATISTICS_CACHE_TTL_MS
    : PLAYER_HISTORICAL_STATISTICS_CACHE_TTL_MS;
  const key = `${safePlayerId}:${safeSeason}`;
  return cachedRead(playerSeasonStatisticsCache, key, ttl, async () => {
    const payload = assertProviderData(await apiFootballFetch('/players', { id: safePlayerId, season: safeSeason }, { retries: 1, timeoutMs: 15000 }), 'player statistics');
    const records = normalizePlayerStatistics(payload).filter((record) => record.playerId === safePlayerId && record.season === safeSeason);
    return classifyPlayerTeamNationalStatus(records);
  });
}

async function loadPlayerColumns(playerId) {
  try {
    const { listRelatedColumnArticles } = await import('./article-store.js');
    return { state: 'ready', items: await listRelatedColumnArticles({ playerId }) };
  } catch (error) {
    console.error(`[player columns] ${playerId} unavailable:`, error);
    return { state: 'error', items: [] };
  }
}

async function playerStatsSection({ playerId, season, leagueId, fallbackSeason = null }) {
  const selectedSeason = validSeason(season) ?? validSeason(fallbackSeason) ?? currentTokyoSeason();
  const records = await fetchPlayerSeasonStatistics(playerId, selectedSeason);
  const clubRecords = confirmedClubPlayerRecords(records);
  const leagues = playerLeagueOptions(clubRecords);
  const requestedLeagueId = positiveId(leagueId);
  const selectedLeagueId = requestedLeagueId && leagues.some((league) => league.leagueId === requestedLeagueId)
    ? requestedLeagueId
    : 'all';
  const selectedRecords = selectedLeagueId === 'all'
    ? clubRecords
    : clubRecords.filter((record) => record.leagueId === selectedLeagueId);
  if (!selectedRecords.length) {
    return { state: 'empty', season: selectedSeason, leagues, selectedLeagueId, message: 'この条件の選手記録はありません。' };
  }
  return {
    state: 'ready',
    season: selectedSeason,
    leagues,
    selectedLeagueId,
    summary: buildPlayerStatsSummary(selectedRecords),
  };
}

async function playerCareerSection({ playerId, history, cursor = 0 }) {
  const seasons = [...new Set((Array.isArray(history) ? history : []).map((row) => row.season))]
    .sort((left, right) => right - left);
  const safeCursor = Math.max(0, Math.min(Number.isInteger(Number(cursor)) ? Number(cursor) : 0, seasons.length));
  const requestedSeasons = seasons.slice(safeCursor, safeCursor + 2);
  if (!requestedSeasons.length) return { state: 'empty', message: '取得できるクラブキャリア記録はありません。', nextCursor: null };
  const records = [];
  for (const season of requestedSeasons) records.push(...await fetchPlayerSeasonStatistics(playerId, season));
  const career = buildPlayerCareerRows(confirmedClubPlayerRecords(records), { history });
  const nextCursor = safeCursor + requestedSeasons.length < seasons.length ? safeCursor + requestedSeasons.length : null;
  if (career.length || nextCursor != null || safeCursor > 0) return { state: 'ready', rows: career, nextCursor };
  return { state: 'empty', message: '取得できるクラブキャリア記録はありません。', nextCursor: null };
}

const PLAYER_TABS = new Set(['stats', 'career', 'columns']);

export async function loadPlayerPageData({ playerId, season = null, leagueId = null, tab = 'stats', cursor = 0 } = {}) {
  const safePlayerId = positiveId(playerId);
  if (!safePlayerId) return { state: 'not_found' };
  const context = await loadPlayerContext(safePlayerId);
  if (context.state === 'not_found') return context;
  const { player, history, historyState } = context;
  const selectedTab = PLAYER_TABS.has(tab) ? tab : 'stats';
  const fallbackSeason = selectedTab === 'stats'
    ? await resolveInitialPlayerSeason({ requestedSeason: season, player, history })
    : null;
  const columnsPromise = loadPlayerColumns(safePlayerId);
  let section;
  let columns;
  if (selectedTab === 'columns') {
    columns = await columnsPromise;
    section = columns;
  } else {
    const sectionPromise = selectedTab === 'stats'
      ? playerStatsSection({ playerId: safePlayerId, season, leagueId, fallbackSeason })
      : playerCareerSection({ playerId: safePlayerId, history, cursor });
    [columns, section] = await Promise.all([
      columnsPromise,
      sectionPromise.catch((error) => {
        console.error(`[player ${selectedTab}] ${safePlayerId} unavailable:`, error);
        return { state: 'error', message: 'この情報を取得できませんでした。もう一度お試しください。' };
      }),
    ]);
  }
  return { state: 'ready', player, historyState, history, tab: selectedTab, columns, section };
}

export async function loadPlayerSectionData({ playerId, season = null, leagueId = null, tab = 'stats', cursor = 0 } = {}) {
  const safePlayerId = positiveId(playerId);
  if (!safePlayerId) return { state: 'not_found' };
  if (!PLAYER_TABS.has(tab)) return { state: 'invalid' };
  try {
    const columnsPromise = loadPlayerColumns(safePlayerId);
    if (tab === 'columns') {
      const columns = await columnsPromise;
      return { state: 'ready', tab, columns, history: [], section: columns };
    }
    if (tab === 'stats') {
      const [columns, context] = await Promise.all([columnsPromise, loadPlayerContext(safePlayerId)]);
      if (context.state === 'not_found') return context;
      return {
        state: 'ready', tab, columns, history: context.history,
        section: await playerStatsSection({
          playerId: safePlayerId, season, leagueId,
          fallbackSeason: await resolveInitialPlayerSeason({ requestedSeason: season, player: context.player, history: context.history }),
        }),
      };
    }
    const [columns, history] = await Promise.all([columnsPromise, fetchPlayerTeams(safePlayerId)]);
    return { state: 'ready', tab, columns, history, section: await playerCareerSection({ playerId: safePlayerId, history, cursor }) };
  } catch (error) {
    console.error(`[player section] ${safePlayerId}/${tab} unavailable:`, error);
    return { state: 'ready', tab, columns: { state: 'error', items: [] }, history: [], section: { state: 'error', message: 'この情報を取得できませんでした。もう一度お試しください。' } };
  }
}

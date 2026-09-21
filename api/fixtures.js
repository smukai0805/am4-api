import { withFootballCacheMetadata } from '../lib/football-cache-context.js';

// api/fixtures.js
// Vercelのサーバーレス関数(Node.js)。
// api/standings.jsと同じ5大リーグを対象に、指定シーズンの全試合データを返す。
// 「試合結果」セクションの日付順/節別ビューが、実際に特定の日付・節を選べるように
// するための実データソース(2026-07-31追加。それまではフロント側にサンプル
// (架空)の試合結果が数件ハードコードされているだけで、日付・節の選択機能は
// 無かった)。
//
// 例: /api/fixtures?league=プレミアリーグ&season=2025
//
// 【2026-07-31修正】ページ読み込み時、このエンドポイント(既定リーグ=プレミアリーグ)と
// api/standings.js(5リーグ分を並列でAPI-Footballへ問い合わせる)がほぼ同時に実行され、
// API-Football側のレート制限(data.errors.rateLimit、HTTPステータス自体は200)に
// 一部だけ引っかかることを確認した(実データ検証で、初回読み込み時のプレミアリーグだけ
// 「日付・節がありません」表示になり、その後の個別のリーグタブ切り替え(単発リクエスト、
// 競合が無い)では問題なく取得できる、という症状で発覚)。リトライ・グローバル
// スロットリング機能を持つlib/api-football-client.jsのapiFootballFetch()に統一した。

import { getLineupInsights } from '../lib/lineup-insights.js';
import { apiFootballFetch } from '../lib/api-football-client.js';
import { getArticle, listArticles } from '../lib/article-store.js';
import { applyStoredPredictionKeyPlayerCards, hydratePredictionEditorials } from '../lib/prediction-key-player-data.js';
import {
  readVerifiedPredictionKeyPlayerCards,
  saveVerifiedPredictionKeyPlayerCards,
} from '../lib/prediction-key-player-store.js';
import matchArchive from '../match-archive.js';
import { renderMatchErrorPage, renderMatchPage } from '../lib/match-page-html.js';
import { loadTeamPageData, loadTeamSectionData, positiveId as entityPositiveId } from '../lib/team-player-data.js';
import { renderEntityErrorPage, renderTeamPage, renderTeamPageFragments } from '../lib/team-player-page-html.js';

const COMPETITIONS = {
  'プレミアリーグ': { providerId: 39, featured: true, editorialBonus: 6 },
  'ラ・リーガ': { providerId: 140, featured: true, editorialBonus: 6 },
  'セリエA': { providerId: 135, featured: true, editorialBonus: 6 },
  'ブンデスリーガ': { providerId: 78, featured: true, editorialBonus: 6 },
  'リーグ・アン': { providerId: 61, featured: true, editorialBonus: 6 },
  'チャンピオンズリーグ': { providerId: 2, featured: true, editorialBonus: 16 },
  // EL is available on demand from the existing competition tab. It remains
  // out of the automatic featured fetch fan-out, so this support does not add
  // a provider request to an ordinary homepage visit.
  'ヨーロッパリーグ': { providerId: 3, featured: false, editorialBonus: 0 },
  // 2026-08-12追加(EL BLANCO連携作業時): クラブの「次節試合カード」的な用途では、
  // 国内リーグ・CL戦だけでなくプレシーズンの親善試合も対象に含めたいという要望があった。
  // API-Footballの/leagues?search=Friendliesで実際に検索したところ、"Friendlies"
  // (id:10、国代表の親善試合)・"Friendlies Women"(id:666)・"Friendlies Clubs"
  // (id:667、クラブの親善試合)の3つが存在することを確認した。クラブの試合カード用途に
  // 合うのはid:667のみ(実データでレアル・マドリードのプレシーズンツアー戦を確認済み、
  // id:10は国代表戦のため0件だった)。
  'クラブ親善試合': { providerId: 667, featured: true, editorialBonus: 0 }
};
const LEAGUES = Object.fromEntries(
  Object.entries(COMPETITIONS).map(([name, competition]) => [name, competition.providerId])
);
const COMPETITION_NAMES_BY_PROVIDER_ID = new Map(
  Object.entries(COMPETITIONS).map(([name, competition]) => [competition.providerId, name])
);

// api/standings.js・api/top-scorers.jsと同じ対応範囲。注目試合の既定シーズンは
// 固定せず、日本時間の現在日が属する欧州シーズンを使う。
const MIN_SEASON = 2022;
const MAX_SEASON = 2026;

function tokyoDateParts(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).reduce((parts, part) => ({ ...parts, [part.type]: part.value }), {});
}

export function resolveDefaultSeason(now = new Date()) {
  const parts = tokyoDateParts(now);
  const year = Number(parts.year);
  return Number(parts.month) >= 7 ? year : year - 1;
}

// 終了済み(Match Finished)の試合のみスコア表示の対象にする(延長・PK戦を含む)。
const FINISHED_STATUSES = ['FT', 'AET', 'PEN'];
const LIVE_STATUSES = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT', 'LIVE']);
const FEATURED_LEAGUES = Object.entries(COMPETITIONS)
  .filter(([, competition]) => competition.featured)
  .map(([name]) => name);
const FEATURED_FIXTURE_LIMIT = 3;
const SCHEDULED_STATUSES = new Set(['NS', 'TBD']);
const CLUB_IDS = {
  manchesterUnited: 33,
  newcastleUnited: 34,
  liverpool: 40,
  arsenal: 42,
  everton: 45,
  tottenham: 47,
  chelsea: 49,
  manchesterCity: 50,
  marseille: 81,
  parisSaintGermain: 85,
  bayernMunich: 157,
  borussiaDortmund: 165,
  bayerLeverkusen: 168,
  acMilan: 489,
  juventus: 496,
  interMilan: 505,
  barcelona: 529,
  atleticoMadrid: 530,
  realMadrid: 541,
};
const FEATURED_CLUBS = [
  'manchesterUnited', 'newcastleUnited', 'liverpool', 'arsenal', 'tottenham', 'chelsea',
  'manchesterCity', 'marseille', 'parisSaintGermain', 'bayernMunich', 'borussiaDortmund',
  'bayerLeverkusen', 'acMilan', 'juventus', 'interMilan', 'barcelona',
  'atleticoMadrid', 'realMadrid',
];
const FEATURED_TEAM_IDS = new Set(FEATURED_CLUBS.map((club) => CLUB_IDS[club]));
const DAILY_FOCUS_PROVIDER_IDS = new Set(
  Object.entries(COMPETITIONS)
    .filter(([name]) => name !== 'クラブ親善試合')
    .map(([, competition]) => competition.providerId)
);
const FEATURED_RIVALRIES = new Set([
  teamPairKey(CLUB_IDS.manchesterUnited, CLUB_IDS.manchesterCity),
  teamPairKey(CLUB_IDS.manchesterUnited, CLUB_IDS.liverpool),
  teamPairKey(CLUB_IDS.liverpool, CLUB_IDS.everton),
  teamPairKey(CLUB_IDS.arsenal, CLUB_IDS.tottenham),
  teamPairKey(CLUB_IDS.arsenal, CLUB_IDS.chelsea),
  teamPairKey(CLUB_IDS.barcelona, CLUB_IDS.realMadrid),
  teamPairKey(CLUB_IDS.atleticoMadrid, CLUB_IDS.realMadrid),
  teamPairKey(CLUB_IDS.acMilan, CLUB_IDS.interMilan),
  teamPairKey(CLUB_IDS.juventus, CLUB_IDS.interMilan),
  teamPairKey(CLUB_IDS.bayernMunich, CLUB_IDS.borussiaDortmund),
  teamPairKey(CLUB_IDS.marseille, CLUB_IDS.parisSaintGermain),
]);

// Champions Leagueの決勝トーナメント各ラウンド(API-Football表記→日本語ラベル)。
// 2026-07-31追加: リーグフェーズの「第N節」表記と紛らわしいとの指摘を受け、
// 決勝トーナメントは段階名で表示するようにした。
const KNOCKOUT_STAGE_LABELS = {
  'Round of 32': 'ベスト32',
  'Round of 16': 'ベスト16',
  'Quarter-finals': '準々決勝',
  'Semi-finals': '準決勝',
  'Final': '決勝',
};
// 節別タブの並び順に使う値(数字の節より必ず後ろ、かつ決勝トーナメントの
// 進行順になるよう大きめの値を割り振ってある)。
const KNOCKOUT_STAGE_ORDER = {
  'Round of 32': 100,
  'Round of 16': 101,
  'Quarter-finals': 102,
  'Semi-finals': 103,
  'Final': 104,
};

// API-Footballのleague.round(例: "Regular Season - 24"、Champions Leagueの
// リーグフェーズなら"League Stage - 3"、決勝トーナメントなら"Round of 16"等)から、
// 節別タブ用のキー・表示ラベル・並び順を求める。国内リーグ、本戦、決勝
// トーナメントに加え、シーズン序盤のCL予選とプレーオフも選択できるようにする。
//
// 【2026-07-31、Champions League対応で修正】当初は文字列中の最初の数字を
// そのまま拾うだけだったが、Champions Leagueの予選ラウンド("1st Qualifying Round"
// 等)にも数字が含まれるため、本戦のリーグフェーズ("League Stage - 1")と
// 同じ節番号1〜3として誤って衝突することが実データ検証で判明した(決勝
// トーナメントの"Round of 16"/"Round of 32"も同様に数字を含み、節と紛らわしい)。
// そのため「Regular Season - N」「League Stage - N」の2形式のみを数字の節として
// 扱うホワイトリスト方式にし、決勝トーナメントの各ラウンドは別途、段階名の
// 固定リスト(KNOCKOUT_STAGE_LABELS)と突き合わせて判定する。
function resolveRoundInfo(rawRound) {
  if (!rawRound) return null;
  const qualifyingMatch = String(rawRound).match(/^(1st|2nd|3rd) Qualifying Round$/i);
  if (qualifyingMatch) {
    const number = { '1st': 1, '2nd': 2, '3rd': 3 }[qualifyingMatch[1].toLowerCase()];
    return { key: `qualifying-${number}`, label: `予選${number}回戦`, order: -20 + number };
  }
  if (/^Play-?offs?$/i.test(String(rawRound))) {
    return { key: 'qualifying-playoff', label: 'プレーオフ', order: -10 };
  }
  if (/^Preliminary Round$/i.test(String(rawRound))) {
    return { key: 'preliminary', label: '予備予選', order: -30 };
  }
  const seasonMatch = String(rawRound).match(/^Regular Season\s*-\s*(\d+)$/i);
  if (seasonMatch) {
    const n = Number(seasonMatch[1]);
    return { key: `season-${n}`, label: `第${n}節`, order: n };
  }
  // 2026-07-31: 国内リーグの「第N節」表記と紛らわしいとの指摘を受け、Champions
  // Leagueのリーグフェーズ(旧グループステージ)は「GL第N節」表記にした。
  const stageMatch = String(rawRound).match(/^League Stage\s*-\s*(\d+)$/i);
  if (stageMatch) {
    const n = Number(stageMatch[1]);
    return { key: `league-stage-${n}`, label: `GL第${n}節`, order: n };
  }
  if (KNOCKOUT_STAGE_LABELS[rawRound]) {
    return { key: `ko-${rawRound}`, label: KNOCKOUT_STAGE_LABELS[rawRound], order: KNOCKOUT_STAGE_ORDER[rawRound] };
  }
  return null;
}

function simplifyFixture(f, competition, includeProviderRound = false) {
  const played = FINISHED_STATUSES.includes(f.fixture.status?.short);
  const roundInfo = resolveRoundInfo(f.league.round);
  return {
    id: f.fixture.id,
    date: (f.fixture.date || '').slice(0, 10),
    kickoff: f.fixture.date || null,
    competition,
    competitionId: nullableNumber(f.league?.id),
    competitionLogo: f.league?.logo || null,
    competitionCountry: f.league?.country || null,
    roundKey: roundInfo?.key || null,
    roundLabel: roundInfo?.label || (includeProviderRound ? f.league.round : null),
    status: f.fixture.status?.short,
    elapsed: nullableNumber(f.fixture.status?.elapsed),
    homeId: f.teams.home.id,
    awayId: f.teams.away.id,
    home: f.teams.home.name,
    away: f.teams.away.name,
    homeLogo: f.teams.home.logo || null,
    awayLogo: f.teams.away.logo || null,
    homeGoals: f.goals.home,
    awayGoals: f.goals.away,
    score: played ? `${f.goals.home}-${f.goals.away}` : '-',
    venue: f.fixture.venue?.name || null,
  };
}

function teamPairKey(homeId, awayId) {
  return [homeId, awayId].sort((a, b) => a - b).join(':');
}

function japanViewingBonus(kickoff) {
  if (!Number.isFinite(Date.parse(kickoff))) return 0;
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23'
  }).format(new Date(kickoff)));
  if (hour >= 19 && hour <= 23) return 12;
  if (hour <= 1) return 8;
  if (hour === 2) return 3;
  return 0;
}

function featuredScore(fixture) {
  const pickedClubs = Number(FEATURED_TEAM_IDS.has(fixture.homeId)) + Number(FEATURED_TEAM_IDS.has(fixture.awayId));
  const derbyBonus = FEATURED_RIVALRIES.has(teamPairKey(fixture.homeId, fixture.awayId)) ? 30 : 0;
  const competitionBonus = COMPETITIONS[fixture.competition]?.editorialBonus || 0;
  return pickedClubs * 100 + derbyBonus + competitionBonus + japanViewingBonus(fixture.kickoff);
}

export function selectFeaturedFixtures(fixtures) {
  const ranked = [...fixtures]
    .sort((a, b) => featuredScore(b) - featuredScore(a) || Date.parse(a.kickoff) - Date.parse(b.kickoff));
  // AM4注目度をそのまま反映し、同点時だけキックオフが近い試合を先にする。
  return ranked.slice(0, FEATURED_FIXTURE_LIMIT);
}

function tokyoDateKey(value) {
  const parts = tokyoDateParts(new Date(value));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function selectHomepageFixtures(fixtures, requestedTokyoDate) {
  const valid = (fixtures || []).filter((fixture) => Number.isFinite(Date.parse(fixture.kickoff)));
  const sameDay = valid.filter((fixture) => tokyoDateKey(fixture.kickoff) === requestedTokyoDate);
  if (sameDay.length) return selectFeaturedFixtures(sameDay);

  const nextDate = valid
    .map((fixture) => tokyoDateKey(fixture.kickoff))
    .filter((date) => date > requestedTokyoDate)
    .sort()[0];
  return nextDate
    ? selectFeaturedFixtures(valid.filter((fixture) => tokyoDateKey(fixture.kickoff) === nextDate))
    : [];
}

export function selectDailyFixtures(providerFixtures) {
  return (providerFixtures || [])
    .map((fixture) => {
      const simplified = simplifyFixture(
        fixture,
        COMPETITION_NAMES_BY_PROVIDER_ID.get(Number(fixture.league?.id)) || fixture.league?.name || 'その他の大会',
        true,
      );
      return {
        ...simplified,
        am4Focus: DAILY_FOCUS_PROVIDER_IDS.has(Number(fixture.league?.id)) ||
          FEATURED_TEAM_IDS.has(simplified.homeId) || FEATURED_TEAM_IDS.has(simplified.awayId),
      };
    })
    .sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
}

function minuteLabel(time = {}) {
  const elapsed = Number(time.elapsed);
  if (!Number.isFinite(elapsed)) return "—";
  const extra = Number(time.extra);
  return `${elapsed}${Number.isFinite(extra) && extra > 0 ? `+${extra}` : ""}'`;
}

export function selectGoalEvents(events) {
  return (events || [])
    .filter((event) => event?.type === 'Goal')
    .map((event) => ({
      minute: minuteLabel(event.time),
      teamId: event.team?.id ?? null,
      team: event.team?.name || 'チーム情報なし',
      scorer: event.player?.name || '得点者情報なし',
      assist: event.assist?.name || null,
      detail: event.detail || 'Goal',
      ownGoal: event.detail === 'Own Goal',
      sortMinute: Number(event.time?.elapsed) || 0,
      sortExtra: Number(event.time?.extra) || 0,
    }))
    .sort((a, b) => a.sortMinute - b.sortMinute || a.sortExtra - b.sortExtra)
    .map(({ sortMinute, sortExtra, ...goal }) => goal);
}

function hasProviderErrors(data) {
  return Boolean(data?.errors && Object.keys(data.errors).length > 0);
}

function nullableNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeParticipant(participant) {
  return {
    id: nullableNumber(participant?.id),
    name: participant?.name || null,
    logo: participant?.logo || null,
  };
}

// Keep a provider's already-curated player label when it is available. The
// browser owns the final presentation fallback, but this normalization layer
// must not discard a short/common name before it reaches that shared resolver.
function normalizePlayerIdentity(player) {
  const normalized = {
    id: nullableNumber(player?.id),
    name: player?.name || null,
  };
  const displayName = [
    player?.knownAs,
    player?.known_as,
    player?.commonName,
    player?.common_name,
    player?.shortName,
    player?.short_name,
    player?.displayName,
    player?.display_name,
  ].find((value) => typeof value === 'string' && value.trim());
  if (displayName) normalized.displayName = displayName.trim();
  return normalized;
}

function normalizeDetailFixture(source) {
  const fixture = source?.fixture || {};
  const league = source?.league || {};
  const status = fixture.status || {};
  return {
    id: nullableNumber(fixture.id),
    date: (fixture.date || '').slice(0, 10) || null,
    kickoff: fixture.date || null,
    timestamp: nullableNumber(fixture.timestamp),
    competition: COMPETITION_NAMES_BY_PROVIDER_ID.get(nullableNumber(league.id)) || league.name || null,
    competitionId: nullableNumber(league.id),
    competitionLogo: league.logo || null,
    competitionCountry: league.country || null,
    round: league.round || null,
    roundLabel: resolveRoundInfo(league.round)?.label || league.round || null,
    status: status.short || null,
    statusLong: status.long || null,
    elapsed: nullableNumber(status.elapsed),
    home: normalizeParticipant(source?.teams?.home),
    away: normalizeParticipant(source?.teams?.away),
    goals: {
      home: nullableNumber(source?.goals?.home),
      away: nullableNumber(source?.goals?.away),
    },
    score: {
      halftime: { home: nullableNumber(source?.score?.halftime?.home), away: nullableNumber(source?.score?.halftime?.away) },
      fulltime: { home: nullableNumber(source?.score?.fulltime?.home), away: nullableNumber(source?.score?.fulltime?.away) },
      extratime: { home: nullableNumber(source?.score?.extratime?.home), away: nullableNumber(source?.score?.extratime?.away) },
      penalty: { home: nullableNumber(source?.score?.penalty?.home), away: nullableNumber(source?.score?.penalty?.away) },
    },
    venue: {
      name: fixture.venue?.name || null,
      city: fixture.venue?.city || null,
    },
    referee: fixture.referee || null,
    timezone: fixture.timezone || null,
  };
}

export function canonicalEventType(event) {
  const providerType = String(event?.type || '').toLowerCase();
  const detail = String(event?.detail || '').toLowerCase();
  const value = `${providerType} ${detail}`;
  if (value.includes('var') || value.includes('disallowed') || value.includes('cancelled') || value.includes('canceled')) return 'var';
  if (value.includes('subst')) return 'substitution';
  if (value.includes('card')) {
    if (value.includes('red') || value.includes('second yellow')) return 'red_card';
    return 'yellow_card';
  }
  if (value.includes('goal')) {
    if (value.includes('missed penalty')) return 'penalty_missed';
    if (value.includes('own goal')) return 'own_goal';
    if (value.includes('penalty')) return 'penalty';
    return 'goal';
  }
  return 'other';
}

function canonicalEventSubtype(event, type) {
  const value = `${event?.type || ''} ${event?.detail || ''}`.toLowerCase();
  if (type === 'red_card' && value.includes('second yellow')) return 'second_yellow';
  if (type === 'var' && value.includes('goal')) return 'goal_review';
  return null;
}

function fixtureTeamForEvent(team, fixture) {
  const teamId = nullableNumber(team?.id);
  if (teamId === fixture?.home?.id) return fixture.home;
  if (teamId === fixture?.away?.id) return fixture.away;
  return null;
}

function isScoringEvent(event) {
  return ['goal', 'penalty', 'own_goal'].includes(event?.type);
}

function scoreSideForEvent(event, fixture) {
  if (!isScoringEvent(event)) return null;
  const teamId = event.team?.id;
  // API-Football assigns every goal event, including own goals, to the side
  // credited on the scoreboard. The player may belong to the opposing team.
  if (teamId === fixture.home?.id) return 'home';
  if (teamId === fixture.away?.id) return 'away';
  return null;
}

function hasFinalScore(fixture) {
  return FINISHED_STATUSES.includes(fixture?.status)
    && Number.isInteger(fixture?.goals?.home)
    && Number.isInteger(fixture?.goals?.away);
}

// API-Football's event endpoint is requested with the fixture ID, but the
// provider response itself does not repeat that ID for each item. Validate its
// team association against the authoritative primary fixture before it reaches
// the browser. For completed matches, only keep scoring events when their
// home/away tally agrees with the official final score.
export function validateFixtureEvents(events, fixture) {
  const teamMatched = (events || []).filter((event) => fixtureTeamForEvent(event.team, fixture));
  if (!hasFinalScore(fixture)) {
    return { events: teamMatched, integrity: { teamAssociation: true, goalScore: 'not_final' } };
  }

  const scored = { home: 0, away: 0 };
  teamMatched.forEach((event) => {
    const side = scoreSideForEvent(event, fixture);
    if (side) scored[side] += 1;
  });
  const consistent = scored.home === fixture.goals.home && scored.away === fixture.goals.away;
  return {
    events: consistent ? teamMatched : teamMatched.filter((event) => !isScoringEvent(event)),
    integrity: { teamAssociation: true, goalScore: consistent ? 'consistent' : 'mismatch' },
  };
}

function normalizeDetailEvents(events, fixture) {
  return (Array.isArray(events) ? events : [])
    .map((event, index) => {
      const team = fixtureTeamForEvent(event?.team, fixture);
      const type = canonicalEventType(event);
      return {
        minute: minuteLabel(event?.time),
        elapsed: nullableNumber(event?.time?.elapsed),
        extra: nullableNumber(event?.time?.extra),
        // A canonical event type is deliberately separate from provider prose;
        // the UI translates this key for the selected locale.
        type,
        subtype: canonicalEventSubtype(event, type),
        providerType: event?.type || null,
        detail: event?.detail || null,
        comments: event?.comments || null,
        team: team ? { ...team } : normalizeParticipant(event?.team),
        player: normalizePlayerIdentity(event?.player),
        assist: normalizePlayerIdentity(event?.assist),
        sortIndex: index,
      };
    })
    .sort((a, b) => {
      const aElapsed = a.elapsed ?? Number.MAX_SAFE_INTEGER;
      const bElapsed = b.elapsed ?? Number.MAX_SAFE_INTEGER;
      return aElapsed - bElapsed || (a.extra ?? 0) - (b.extra ?? 0) || a.sortIndex - b.sortIndex;
    })
    .map(({ sortIndex, ...event }) => event);
}

function normalizeLineupPlayer(entry) {
  const player = entry?.player || {};
  return {
    ...normalizePlayerIdentity(player),
    number: nullableNumber(player.number),
    position: player.pos || null,
    grid: player.grid || null,
  };
}

function orderByFixtureTeam(items, fixture) {
  const teamIds = [fixture.home.id, fixture.away.id];
  return items
    .map((item, index) => ({ item, index, order: teamIds.indexOf(item.team?.id) }))
    .sort((a, b) => (a.order < 0 ? 99 : a.order) - (b.order < 0 ? 99 : b.order) || a.index - b.index)
    .map(({ item }) => item);
}

function normalizeDetailLineups(lineups, fixture) {
  const normalized = (Array.isArray(lineups) ? lineups : []).map((lineup) => ({
    team: normalizeParticipant(lineup?.team),
    formation: lineup?.formation || null,
    coach: { id: nullableNumber(lineup?.coach?.id), name: lineup?.coach?.name || null },
    startXI: (Array.isArray(lineup?.startXI) ? lineup.startXI : []).map(normalizeLineupPlayer),
    substitutes: (Array.isArray(lineup?.substitutes) ? lineup.substitutes : []).map(normalizeLineupPlayer),
  }));
  return orderByFixtureTeam(normalized, fixture);
}

function normalizeDetailStatistics(statistics, fixture) {
  const normalized = (Array.isArray(statistics) ? statistics : []).map((entry) => ({
    team: normalizeParticipant(entry?.team),
    statistics: (Array.isArray(entry?.statistics) ? entry.statistics : []).map((statistic) => ({
      type: statistic?.type || null,
      value: statistic?.value ?? null,
    })),
  }));
  return orderByFixtureTeam(normalized, fixture);
}

function cacheControlForStatus(status, { liveRefresh = false } = {}) {
  // This route is requested only by an open match page. Keep the start
  // boundary short even while the provider still reports NS/TBD; otherwise a
  // cached pre-kickoff response can delay the first live event by minutes.
  if (liveRefresh) return 's-maxage=15, stale-while-revalidate=15';
  if (FINISHED_STATUSES.includes(status)) return 's-maxage=300, stale-while-revalidate=86400';
  if (LIVE_STATUSES.has(status)) {
    return 's-maxage=15, stale-while-revalidate=45';
  }
  return 's-maxage=60, stale-while-revalidate=300';
}

function isNearKickoff(fixture, now = Date.now()) {
  if (!SCHEDULED_STATUSES.has(fixture?.status)) return false;
  const kickoffAt = Date.parse(fixture?.kickoff || '');
  if (!Number.isFinite(kickoffAt)) return false;
  // The browser rechecks at kickoff. Keep its source response fresh in the
  // narrow window before/after the whistle, including small provider delays.
  return kickoffAt >= now - (2 * 60 * 60 * 1000) && kickoffAt <= now + (5 * 60 * 1000);
}

// The primary fixture establishes whether the requested match exists. Each optional
// section is intentionally fetched independently so a provider gap (for example,
// pre-match lineups) does not hide the rest of the match detail.
export async function getFixtureIdentity(fixtureId, fetchFixture = apiFootballFetch) {
  // A detail page is an explicit, user-initiated request. Do not keep it alive for
  // retry backoffs: the shared throttle already spaces requests safely, and the UI
  // can offer a clear retry when a provider is unavailable.
  const detailRequestOptions = { timeoutMs: 6000, retries: 0 };
  const primary = await fetchFixture('/fixtures', { id: fixtureId }, detailRequestOptions);
  if (hasProviderErrors(primary)) throw new Error('Primary fixture unavailable');
  const source = Array.isArray(primary?.response) ? primary.response[0] : null;
  if (!source) return null;
  const fixture = normalizeDetailFixture(source);
  if (fixture.id !== Number(fixtureId)) throw new Error('Primary fixture ID mismatch');
  return fixture;
}

export async function getFixtureDetail(fixtureId, fetchFixture = apiFootballFetch) {
  const detailRequestOptions = { timeoutMs: 6000, retries: 0 };
  const fixture = await getFixtureIdentity(fixtureId, fetchFixture);
  if (!fixture) return null;
  const sections = await Promise.allSettled([
    fetchFixture('/fixtures/events', { fixture: fixtureId }, detailRequestOptions),
    fetchFixture('/fixtures/lineups', { fixture: fixtureId }, detailRequestOptions),
    fetchFixture('/fixtures/statistics', { fixture: fixtureId }, detailRequestOptions),
  ]);
  const usable = (result) => result.status === 'fulfilled' && !hasProviderErrors(result.value);
  const eventData = usable(sections[0]) ? sections[0].value.response : null;
  const lineupData = usable(sections[1]) ? sections[1].value.response : null;
  const statisticsData = usable(sections[2]) ? sections[2].value.response : null;
  const normalizedEvents = eventData == null ? null : normalizeDetailEvents(eventData, fixture);
  const eventResult = normalizedEvents == null ? null : validateFixtureEvents(normalizedEvents, fixture);

  return {
    fixture,
    events: eventResult?.events ?? null,
    eventIntegrity: eventResult?.integrity ?? { teamAssociation: null, goalScore: 'unavailable' },
    lineups: lineupData == null ? null : normalizeDetailLineups(lineupData, fixture),
    statistics: statisticsData == null ? null : normalizeDetailStatistics(statisticsData, fixture),
    availability: {
      events: eventData != null,
      lineups: lineupData != null,
      statistics: statisticsData != null,
    },
    cacheControl: cacheControlForStatus(fixture.status),
  };
}

// The live refresh route intentionally omits lineups. They are fetched once when
// the match page opens, then retained in the browser while mutable score, event,
// and statistics data update. Optional provider gaps remain independent.
export async function getFixtureLiveDetail(fixtureId, fetchFixture = apiFootballFetch) {
  const detailRequestOptions = { timeoutMs: 6000, retries: 0 };
  const fixture = await getFixtureIdentity(fixtureId, fetchFixture);
  if (!fixture) return null;
  const sections = await Promise.allSettled([
    fetchFixture('/fixtures/events', { fixture: fixtureId }, detailRequestOptions),
    fetchFixture('/fixtures/statistics', { fixture: fixtureId }, detailRequestOptions),
  ]);
  const usable = (result) => result.status === 'fulfilled' && !hasProviderErrors(result.value);
  const eventData = usable(sections[0]) ? sections[0].value.response : null;
  const statisticsData = usable(sections[1]) ? sections[1].value.response : null;
  const normalizedEvents = eventData == null ? null : normalizeDetailEvents(eventData, fixture);
  const eventResult = normalizedEvents == null ? null : validateFixtureEvents(normalizedEvents, fixture);

  return {
    fixture,
    events: eventResult?.events ?? null,
    eventIntegrity: eventResult?.integrity ?? { teamAssociation: null, goalScore: 'unavailable' },
    statistics: statisticsData == null ? null : normalizeDetailStatistics(statisticsData, fixture),
    availability: {
      events: eventData != null,
      statistics: statisticsData != null,
    },
    cacheControl: cacheControlForStatus(fixture.status, { liveRefresh: true }),
  };
}

const MATCH_EDITORIAL_TYPES = [
  { type: 'match_prediction', property: 'prediction' },
  { type: 'match_report', property: 'report' },
];
const MATCH_PAGE_CACHE_CONTROL = 'public, max-age=0, s-maxage=60, stale-while-revalidate=120';
const FINISHED_MATCH_PAGE_CACHE_CONTROL = 'public, max-age=0, s-maxage=300, stale-while-revalidate=300';
const LIVE_MATCH_PAGE_CACHE_CONTROL = 'public, max-age=0, s-maxage=15, stale-while-revalidate=15';

function matchPageFixtureId(value) {
  if (value == null || value === '') return null;
  const fixtureId = Number(value);
  return Number.isInteger(fixtureId) && fixtureId > 0 ? fixtureId : null;
}

function matchPageArticleId(value) {
  const id = String(value || '').trim();
  return /^[a-z0-9][a-z0-9._-]{0,180}$/i.test(id) ? id : null;
}

function matchPageCanonicalKey(value) {
  const raw = String(value || '').trim();
  return raw && raw.length <= 320 ? matchArchive.canonicalMatchKey(raw) : null;
}

export function matchPageCacheControl(detail) {
  const status = detail?.fixture?.status;
  if (FINISHED_STATUSES.includes(status)) return FINISHED_MATCH_PAGE_CACHE_CONTROL;
  if (LIVE_STATUSES.has(status)) return LIVE_MATCH_PAGE_CACHE_CONTROL;
  return MATCH_PAGE_CACHE_CONTROL;
}

function initialMatchDetail(fixture) {
  return {
    fixture,
    events: null,
    lineups: null,
    statistics: null,
    eventIntegrity: { teamAssociation: null, goalScore: 'unavailable' },
    availability: { events: false, lineups: false, statistics: false },
    // The page can paint its factual header and published editorial now. The
    // browser retrieves these optional sections after first paint, instead of
    // making the initial SSR document wait for three provider calls.
    deferred: true,
  };
}

function sendMatchPageError(response, { status, title, heading, message }) {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  return response.status(status).send(renderMatchErrorPage({ title, heading, message }));
}

function archiveDetailFromEditorials(editorials) {
  const archive = matchArchive.fixtureFromArchiveEditorials(editorials);
  if (!archive?.fixture) return null;
  return {
    ...archive,
    events: null,
    lineups: null,
    statistics: null,
    eventIntegrity: { teamAssociation: null, goalScore: 'unavailable' },
    availability: { events: false, lineups: false, statistics: false },
  };
}

function hasEditorial(editorials) {
  return Boolean(editorials?.prediction || editorials?.report);
}

// The public Match Key is a recovery mechanism for older articles that did
// not retain the provider fixture ID. Read only the published Blob mirror;
// this page must never make a public request to the private Notion sources.
async function resolvePublishedEditorials({ fixture = null, articleId = null, canonicalKey = null }, {
  getArticleById = getArticle,
  listPublicArticles = listArticles,
} = {}) {
  let anchor = null;
  if (articleId) {
    anchor = await getArticleById(articleId, { publishedOnly: true });
    if (!anchor || !matchArchive.isPublishedMatchEditorial(anchor)) {
      return { state: 'absent', editorials: { prediction: null, report: null, errors: {} }, canonicalKey: null };
    }
  }

  const fixtureId = matchPageFixtureId(fixture?.id ?? fixture?.fixtureId);
  const fixtureKey = fixture ? matchArchive.fixtureMatchKey(fixture) : null;
  const requestedKey = canonicalKey || fixtureKey || matchArchive.canonicalMatchKey(anchor?.match);
  if (anchor && canonicalKey && !matchArchive.matchIdentityComparison(anchor.match, canonicalKey)) {
    return { state: 'absent', editorials: { prediction: null, report: null, errors: {} }, canonicalKey: null };
  }
  if (!anchor && !fixtureId && !requestedKey) {
    return { state: 'absent', editorials: { prediction: null, report: null, errors: {} }, canonicalKey: null };
  }

  const queries = [
    ...(fixtureId ? [{ fixtureId }] : []),
    ...(requestedKey ? [{ matchKey: requestedKey }] : []),
  ];
  const listed = await Promise.all(MATCH_EDITORIAL_TYPES.map(async ({ type, property }) => {
    const reads = await Promise.allSettled(queries.map((criteria) => listPublicArticles({
      type,
      ...criteria,
      page: 1,
      pageSize: 100,
      publishedOnly: true,
      // A match page must distinguish an unavailable public archive from an
      // empty one. The interactive list API retains its existing soft-empty
      // behavior; this SSR caller explicitly opts into the strict seam.
      throwOnError: true,
    })));
    const items = new Map();
    let unavailable = false;
    reads.forEach((result) => {
      if (result.status !== 'fulfilled') {
        unavailable = true;
        return;
      }
      (result.value?.items || []).forEach((article) => {
        if (article?.id) items.set(article.id, article);
      });
    });
    return { type, property, items: [...items.values()], unavailable };
  }));

  const candidates = [anchor, ...listed.flatMap(({ items }) => items)].filter(Boolean);
  const resolution = matchArchive.resolveArchiveEditorials(candidates, {
    ...(fixtureId ? { fixtureId } : {}),
    ...(requestedKey ? { canonicalKey: requestedKey } : {}),
    ...(anchor ? { articleId: anchor.id } : {}),
  });
  if (resolution.ambiguous || resolution.anchorMismatch) {
    return { state: 'absent', editorials: { prediction: null, report: null, errors: {} }, canonicalKey: null };
  }

  const editorials = { prediction: null, report: null, errors: {} };
  for (const { type, property, unavailable } of listed) {
    const selected = resolution[property];
    if (!selected?.id) {
      if (unavailable) editorials.errors[type] = 'unavailable';
      continue;
    }
    try {
      const full = selected.id === anchor?.id
        ? anchor
        : await getArticleById(selected.id, { publishedOnly: true });
      if (full && matchArchive.isPublishedMatchEditorial(full)) editorials[property] = full;
      else if (unavailable) editorials.errors[type] = 'unavailable';
    } catch (error) {
      editorials.errors[type] = 'unavailable';
    }
  }

  if (hasEditorial(editorials)) {
    return { state: 'ready', editorials, canonicalKey: resolution.canonicalKey || requestedKey || null };
  }
  return {
    state: Object.keys(editorials.errors).length ? 'unavailable' : 'absent',
    editorials,
    canonicalKey: resolution.canonicalKey || requestedKey || null,
  };
}

// /match.html is rewritten here so the existing Hobby-plan function count does
// not grow. A true absence is a 404; provider/Blob failures remain a 503 and
// are never mislabeled as an absent public match.
export async function respondWithMatchPage(req, response, dependencies = {}) {
  const rawFixtureId = req?.query?.id;
  const rawArticleId = req?.query?.article;
  const rawMatchKey = req?.query?.matchKey;
  const fixtureId = matchPageFixtureId(rawFixtureId);
  const articleId = matchPageArticleId(rawArticleId);
  const canonicalKey = matchPageCanonicalKey(rawMatchKey);
  const invalidFixture = rawFixtureId != null && rawFixtureId !== '' && !fixtureId;
  const invalidArticle = rawArticleId != null && rawArticleId !== '' && !articleId;
  const invalidKey = rawMatchKey != null && rawMatchKey !== '' && !canonicalKey;
  if (invalidFixture || invalidArticle || invalidKey || (!fixtureId && !articleId && !canonicalKey)) {
    return sendMatchPageError(response, {
      status: 404,
      title: '試合が見つかりません｜AM4 Football',
      heading: '試合が見つかりません',
      message: 'URLを確認するか、試合一覧または公開済み記事から別の試合を選んでください。',
    });
  }

  const getFixtureIdentityById = dependencies.getFixtureIdentityById || getFixtureIdentity;
  const resolveEditorials = dependencies.resolveEditorials || resolvePublishedEditorials;
  const hydrateEditorials = dependencies.hydratePredictionEditorials || hydratePredictionEditorials;
  let providerFailure = false;

  if (fixtureId) {
    try {
      const fixture = await getFixtureIdentityById(fixtureId);
      if (fixture) {
        const detail = initialMatchDetail(fixture);
        let archive = { state: 'absent', editorials: { prediction: null, report: null, errors: {} }, canonicalKey: null };
        try {
          archive = await resolveEditorials({ fixture, articleId, canonicalKey }, dependencies);
        } catch (error) {
          console.error(`[match page] public editorial archive unavailable for ${fixtureId}:`, error);
          archive = {
            state: 'unavailable',
            editorials: {
              prediction: null,
              report: null,
              errors: { match_prediction: 'unavailable', match_report: 'unavailable' },
            },
            canonicalKey: matchArchive.fixtureMatchKey(fixture),
          };
        }
        let editorials = archive.editorials;
        let storedKeyPlayerCards = [];
        if (process.env.VERCEL_ENV === 'production' && editorials.prediction?.id) {
          try {
            storedKeyPlayerCards = await readVerifiedPredictionKeyPlayerCards(editorials.prediction.id);
            editorials = {
              ...editorials,
              prediction: applyStoredPredictionKeyPlayerCards(
                editorials.prediction,
                fixture,
                storedKeyPlayerCards,
              ),
            };
          } catch (error) {
            console.warn('[match page] stored key-player media unavailable for ' + fixtureId + ':', error);
          }
        }
        try {
          // Only the two authored key-player references use these lightweight
          // squad reads. A provider gap keeps the archived prose/card shell
          // intact instead of making the entire match page unavailable.
          editorials = await hydrateEditorials(editorials, fixture);
        } catch (error) {
          console.warn('[match page] key-player portraits unavailable for ' + fixtureId + ':', error);
        }
        if (process.env.VERCEL_ENV === 'production' && editorials.prediction?.id) {
          try {
            await saveVerifiedPredictionKeyPlayerCards(editorials.prediction, storedKeyPlayerCards);
          } catch (error) {
            console.warn('[match page] key-player media cache unavailable for ' + fixtureId + ':', error);
          }
        }
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.setHeader('Cache-Control', matchPageCacheControl(detail));
        return response.status(200).send(renderMatchPage({
          detail,
          editorials,
          route: 'fixture',
          fixtureId,
          canonicalKey: archive.canonicalKey,
        }));
      }
    } catch (error) {
      providerFailure = true;
      console.error(`[match page] fixture identity unavailable for ${fixtureId}:`, error);
    }
  }

  try {
    const archive = await resolveEditorials({ articleId, canonicalKey, fixture: null }, dependencies);
    const detail = archiveDetailFromEditorials(archive.editorials);
    if (archive.state === 'ready' && detail) {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('Cache-Control', MATCH_PAGE_CACHE_CONTROL);
      return response.status(200).send(renderMatchPage({
        detail,
        editorials: archive.editorials,
        route: 'archive',
        fixtureId,
        archiveArticleId: articleId,
        canonicalKey: archive.canonicalKey || canonicalKey,
      }));
    }
    if (archive.state === 'unavailable') {
      return sendMatchPageError(response, {
        status: 503,
        title: '試合情報を取得できませんでした｜AM4 Football',
        heading: '試合情報を取得できませんでした',
        message: '公開済み記事の取得に一時的な障害が発生している可能性があります。時間をおいてもう一度お試しください。',
      });
    }
  } catch (error) {
    console.error('[match page] public archive unavailable:', error);
    return sendMatchPageError(response, {
      status: 503,
      title: '試合情報を取得できませんでした｜AM4 Football',
      heading: '試合情報を取得できませんでした',
      message: '公開済み記事の取得に一時的な障害が発生している可能性があります。時間をおいてもう一度お試しください。',
    });
  }

  if (providerFailure) {
    return sendMatchPageError(response, {
      status: 503,
      title: '試合情報を取得できませんでした｜AM4 Football',
      heading: '試合情報を取得できませんでした',
      message: '試合データの取得に一時的な障害が発生している可能性があります。時間をおいてもう一度お試しください。',
    });
  }
  return sendMatchPageError(response, {
    status: 404,
    title: '試合が見つかりません｜AM4 Football',
    heading: '試合が見つかりません',
    message: '指定された試合、または一致する公開済み記事は見つかりませんでした。',
  });
}

async function getFeaturedFixtures(season) {
  const responses = [];
  const successfulSources = [];
  const errors = {};
  const now = new Date();
  // 読者の表示基準（日本時間）で今月末までに限定し、9月表示のカードを混ぜない。
  const tokyoParts = tokyoDateParts(now);
  const year = Number(tokyoParts.year);
  const month = Number(tokyoParts.month);
  const from = `${tokyoParts.year}-${tokyoParts.month}-${tokyoParts.day}`;
  const monthEndDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const to = `${tokyoParts.year}-${tokyoParts.month}-${String(monthEndDay).padStart(2, '0')}`;
  const nextMonthStart = Date.UTC(year, month, 1) - (9 * 60 * 60 * 1000);
  // 全大会を同時に処理へ載せる。実際の外部送信はapiFootballFetch()の共通
  // スロットルが1.1秒間隔に整列するためレート制限を守りつつ、各レスポンス待ちを
  // 直列に積み上げずに済む。大会ごとの失敗はallSettledで独立して扱う。
  const leagueResults = await Promise.allSettled(FEATURED_LEAGUES.map(async (name) => {
      const data = await apiFootballFetch('/fixtures', { league: LEAGUES[name], season, from, to }, { timeoutMs: 10000 });
      if (data.errors && Object.keys(data.errors).length > 0) {
        throw Object.assign(new Error(`${name} data unavailable`), { providerErrors: data.errors });
      }
      return { name, fixtures: (data.response || []).map((fixture) => simplifyFixture(fixture, name, true)) };
  }));

  leagueResults.forEach((result, index) => {
    const name = FEATURED_LEAGUES[index];
    if (result.status === 'fulfilled') {
      successfulSources.push(name);
      responses.push(...result.value.fixtures);
    } else {
      const caughtError = result.reason;
      console.error(`[featured fixtures] ${name} unavailable:`, caughtError);
      errors[name] = caughtError?.providerErrors || { unavailable: true };
    }
  });

  const nowMs = now.getTime();
  const upcoming = responses.filter((fixture) =>
    Number.isFinite(Date.parse(fixture.kickoff)) &&
    Date.parse(fixture.kickoff) >= nowMs &&
    SCHEDULED_STATUSES.has(fixture.status)
  );
  const candidates = upcoming.filter((fixture) => Date.parse(fixture.kickoff) < nextMonthStart);
  const selected = selectHomepageFixtures(candidates, from);
  return { fixtures: selected, sources: successfulSources, errors };
}

function entityReturnPath(value, fallback) {
  const path = String(value || '');
  return path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') && path.length <= 1200
    ? path
    : fallback;
}

function requestEntityReturnPath(query, fallback) {
  return entityReturnPath(query?.returnPath, entityReturnPath(query?.return, fallback));
}

function entityCacheControl(tab) {
  if (tab === 'roster') return 's-maxage=1800, stale-while-revalidate=3600';
  if (tab === 'standings' || tab === 'rankings') return 's-maxage=300, stale-while-revalidate=600';
  if (tab === 'columns') return 's-maxage=300, stale-while-revalidate=300';
  return 's-maxage=120, stale-while-revalidate=300';
}

function entityUnavailablePage(res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(503).send(renderEntityErrorPage({
    status: 503,
    title: 'チーム情報を取得できませんでした｜AM4 Football',
    heading: 'チーム情報を取得できませんでした',
    message: '一時的にデータを取得できません。時間をおいてもう一度お試しください。',
  }));
}

async function respondWithTeamPage(req, res) {
  const teamId = entityPositiveId(req.query?.teamId);
  if (!teamId) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(404).send(renderEntityErrorPage({
      status: 404,
      title: 'チームが見つかりません｜AM4 Football',
      heading: 'チームが見つかりません',
      message: '指定されたチームIDは利用できません。',
    }));
  }
  if (!process.env.API_FOOTBALL_KEY) return entityUnavailablePage(res);
  const tab = String(req.query?.tab || 'fixtures');
  try {
    const data = await loadTeamPageData({
      teamId,
      leagueId: req.query?.league,
      season: req.query?.season,
      tab,
    });
    if (data.state === 'not_found') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(404).send(renderEntityErrorPage({
        status: 404,
        title: 'チームが見つかりません｜AM4 Football',
        heading: 'チームが見つかりません',
        message: '指定されたチーム、または利用可能なチーム情報は見つかりませんでした。',
      }));
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', entityCacheControl(data.tab));
    return res.status(200).send(renderTeamPage(data, {
      origin: 'https://am4football.com',
      requestPath: requestEntityReturnPath(req.query, null),
    }));
  } catch (error) {
    console.error(`[team page] ${teamId} unavailable:`, error);
    return entityUnavailablePage(res);
  }
}

async function respondWithTeamData(req, res) {
  const teamId = entityPositiveId(req.query?.teamId);
  if (!teamId) return res.status(404).json({ state: 'not_found' });
  if (!process.env.API_FOOTBALL_KEY) return res.status(503).json({ state: 'error', message: 'チーム情報を取得できませんでした。' });
  const tab = String(req.query?.tab || 'fixtures');
  try {
    const data = await loadTeamSectionData({
      teamId,
      leagueId: req.query?.league,
      season: req.query?.season,
      tab,
    });
    if (data.state !== 'ready') return res.status(503).json({ state: 'error', message: data.message || 'チーム情報を取得できませんでした。' });
    const returnPath = requestEntityReturnPath(req.query, `/teams/${teamId}`);
    const fragments = renderTeamPageFragments(data, { teamId, requestPath: returnPath });
    res.setHeader('Cache-Control', entityCacheControl(data.tab));
    return res.status(200).json({
      state: 'ready', tab: data.tab, selection: data.selection,
      tabsHtml: fragments.tabsHtml, contentHtml: fragments.contentHtml,
    });
  } catch (error) {
    console.error(`[team data] ${teamId} unavailable:`, error);
    return res.status(503).json({ state: 'error', message: 'チーム情報を取得できませんでした。' });
  }
}

async function handler(req, res) {
  if (req.query.teamPage === '1') return respondWithTeamPage(req, res);
  if (req.query.teamData === '1') return respondWithTeamData(req, res);
  if (req.query.matchPage === '1') {
    return respondWithMatchPage(req, res);
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  const API_KEY = process.env.API_FOOTBALL_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: 'API_FOOTBALL_KEY が設定されていません' });
  }

  const { league, featured, date, events, detail, liveDetail, lineupInsights } = req.query;
  if (lineupInsights != null) {
    const id = Number(lineupInsights);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({error:'Invalid fixture ID'});
    try {
      const fixture = await getFixtureIdentity(id);
      if (!fixture) return res.status(404).json({error:'Fixture not found'});
      const result = await getLineupInsights(fixture);
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
      return res.status(200).json(result);
    } catch { return res.status(503).json({error:'Lineup information unavailable'}); }
  }

  if (liveDetail != null) {
    const fixtureId = Number(liveDetail);
    if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
      return res.status(400).json({ error: 'liveDetail は有効な試合IDで指定してください' });
    }
    try {
      const fixtureDetail = await getFixtureLiveDetail(fixtureId);
      if (!fixtureDetail) {
        return res.status(404).json({ error: '指定された試合が見つかりません' });
      }
      res.setHeader('Cache-Control', fixtureDetail.cacheControl);
      const { cacheControl, ...body } = fixtureDetail;
      return res.status(200).json(body);
    } catch (error) {
      console.error(`[live fixture detail] ${fixtureId} unavailable:`, error);
      return res.status(503).json({ error: '試合中データの取得に失敗しました' });
    }
  }

  if (detail != null) {
    const fixtureId = Number(detail);
    if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
      return res.status(400).json({ error: 'detail は有効な試合IDで指定してください' });
    }
    try {
      const fixtureDetail = await getFixtureDetail(fixtureId);
      if (!fixtureDetail) {
        return res.status(404).json({ error: '指定された試合が見つかりません' });
      }
      res.setHeader('Cache-Control', fixtureDetail.cacheControl);
      const { cacheControl, ...body } = fixtureDetail;
      return res.status(200).json(body);
    } catch (error) {
      console.error(`[fixture detail] ${fixtureId} unavailable:`, error);
      return res.status(503).json({ error: '試合詳細の取得に失敗しました' });
    }
  }

  if (events != null) {
    const fixtureId = Number(events);
    if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
      return res.status(400).json({ error: 'events は有効な試合IDで指定してください' });
    }
    try {
      const data = await apiFootballFetch('/fixtures/events', { fixture: fixtureId }, { timeoutMs: 10000 });
      if (data.errors && Object.keys(data.errors).length > 0) {
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
        return res.status(200).json({ fixtureId, errors: data.errors, goals: [] });
      }
      const goals = selectGoalEvents(data.response || []);
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400');
      return res.status(200).json({ fixtureId, goals });
    } catch (error) {
      console.error(`[fixture events] ${fixtureId} unavailable:`, error);
      return res.status(500).json({ error: '得点情報の取得に失敗しました', detail: error.message });
    }
  }

  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    return res.status(400).json({ error: 'date は YYYY-MM-DD 形式で指定してください' });
  }

  if (date) {
    try {
      const data = await apiFootballFetch('/fixtures', { date, timezone: 'Asia/Tokyo' }, { timeoutMs: 10000 });
      if (data.errors && Object.keys(data.errors).length > 0) {
        console.error(`[daily fixtures] ${date}:`, data.errors);
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
        return res.status(200).json({ date, errors: data.errors, fixtures: [], competitions: [] });
      }
      const fixtures = selectDailyFixtures(data.response || []);
      const focusFixtures = fixtures.filter((fixture) => fixture.am4Focus);
      const competitions = [...new Set(fixtures.map((fixture) => fixture.competition))];
      const featuredFixtures = selectFeaturedFixtures(focusFixtures.length ? focusFixtures : fixtures);
      const cacheControl = fixtures.some((fixture) => LIVE_STATUSES.has(fixture.status) || isNearKickoff(fixture))
        ? 's-maxage=15, stale-while-revalidate=15'
        : 's-maxage=60, stale-while-revalidate=300';
      res.setHeader('Cache-Control', cacheControl);
      return res.status(200).json({ date, fixtures, focusFixtures, featuredFixtures, competitions });
    } catch (err) {
      console.error(`[daily fixtures] ${date} unavailable:`, err);
      return res.status(500).json({ error: '指定日の試合取得に失敗しました', detail: err.message });
    }
  }

  const seasonParam = Number(req.query.season);
  const SEASON = Number.isInteger(seasonParam) ? seasonParam : resolveDefaultSeason();
  if (SEASON < MIN_SEASON || SEASON > MAX_SEASON) {
    return res.status(400).json({ error: `season は ${MIN_SEASON}〜${MAX_SEASON} の範囲で指定してください` });
  }

  try {
    if (featured === '1') {
      const featuredResult = await getFeaturedFixtures(SEASON);
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
      return res.status(200).json({ season: SEASON, ...featuredResult });
    }

    const leagueId = LEAGUES[league];
    if (!leagueId) {
      return res.status(400).json({ error: `league は次のいずれかを指定してください: ${Object.keys(LEAGUES).join(' / ')}` });
    }
    const data = await apiFootballFetch('/fixtures', { league: leagueId, season: SEASON });

    if (data.errors && Object.keys(data.errors).length > 0) {
      console.error(`[fixtures] ${league} (league=${leagueId}, season=${SEASON}):`, data.errors);
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
      return res.status(200).json({ league, season: SEASON, errors: data.errors, fixtures: [], rounds: [], dates: [] });
    }

    const roundInfoByKey = new Map();
    const fixtures = (data.response || []).map(f => {
      const roundInfo = resolveRoundInfo(f.league.round);
      if (roundInfo && !roundInfoByKey.has(roundInfo.key)) {
        roundInfoByKey.set(roundInfo.key, roundInfo);
      }
      return simplifyFixture(f, league);
    });

    // 節・段階タブ一覧(並び順つき)・日付一覧(昇順)。フロント側のタブ用。
    const rounds = [...roundInfoByKey.values()]
      .sort((a, b) => a.order - b.order)
      .map(({ key, label }) => ({ key, label }));
    const dates = [...new Set(fixtures.map(f => f.date).filter(Boolean))].sort();

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
    return res.status(200).json({ league, season: SEASON, fixtures, rounds, dates });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '取得に失敗しました', detail: err.message });
  }
}

export default withFootballCacheMetadata(handler);

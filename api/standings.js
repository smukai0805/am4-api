// api/standings.js
// Vercelのサーバーレス関数(Node.js)。
// このファイルをデプロイすると、
// https://あなたのプロジェクト.vercel.app/api/standings
// で「5大リーグ全部」の順位表がまとめてJSONで返ってきます。
//
// 非公開・個人利用の想定なので、1日数回このエンドポイントを叩く程度なら
// 無料枠(1日100リクエスト ※API-Football側への実際の通信回数でカウント)に
// 余裕で収まります(1回の呼び出しで6リーグ分(5大リーグ+Champions League)
// ＝6リクエスト消費)。
//
// 2026-07-31: 5リーグを並行して問い合わせる際、api/fixtures.jsの同時実行と
// API-Football側のレート制限に一部だけ引っかかる事例を確認したため、リトライ・
// グローバルスロットリング機能を持つapiFootballFetch()に統一した。

import { apiFootballFetch } from '../lib/api-football-client.js';
import { resolveStandingZone, standingZoneLegend } from '../lib/standing-qualifications.js';

// Seasons are resolved against the current Tokyo date. An explicit fixture
// date still wins on the detail page, so historic matches request their own
// season instead of inheriting the current campaign.
const MIN_SEASON = 2022;
const MAX_SEASON = 2026;

// Match detail requests one competition at a time. This mapping keeps provider
// IDs and qualification normalisation out of the browser UI.
export const STANDING_COMPETITIONS = {
  'プレミアリーグ': 39,
  'ラ・リーガ': 140,
  'セリエA': 135,
  'ブンデスリーガ': 78,
  'リーグ・アン': 61,
  'チャンピオンズリーグ': 2,
};

const COMPETITION_ALIASES = {
  'Premier League': 'プレミアリーグ',
  'La Liga': 'ラ・リーガ',
  'Serie A': 'セリエA',
  Bundesliga: 'ブンデスリーガ',
  'Ligue 1': 'リーグ・アン',
  'UEFA Champions League': 'チャンピオンズリーグ',
  'Champions League': 'チャンピオンズリーグ',
};

function tokyoSeason(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit',
  }).formatToParts(now).reduce((all, part) => ({ ...all, [part.type]: part.value }), {});
  return Number(parts.month) >= 7 ? Number(parts.year) : Number(parts.year) - 1;
}

export function resolveStandingSeason(value, now = new Date()) {
  if (value == null || value === '') return Math.min(MAX_SEASON, Math.max(MIN_SEASON, tokyoSeason(now)));
  const season = Number(value);
  return Number.isInteger(season) && season >= MIN_SEASON && season <= MAX_SEASON ? season : null;
}

export function resolveStandingCompetition({ competition, competitionId } = {}) {
  const requestedId = Number(competitionId);
  if (Number.isInteger(requestedId) && requestedId > 0) {
    const matched = Object.entries(STANDING_COMPETITIONS).find(([, providerId]) => providerId === requestedId);
    if (matched) return { name: matched[0], providerId: matched[1] };
    // Fixtures can belong to a domestic league outside AM4's primary five.
    // Keep its provider ID as the factual lookup key. If it is a cup without
    // a table, API-Football returns no standings and the UI uses its honest
    // no-table state instead of manufacturing one.
    return { name: competition || null, providerId: requestedId };
  }
  const name = COMPETITION_ALIASES[competition] || competition;
  return STANDING_COMPETITIONS[name] ? { name, providerId: STANDING_COMPETITIONS[name] } : null;
}

function providerErrors(data) {
  return data?.errors && Object.keys(data.errors).length ? data.errors : null;
}

function flattenStandingTables(data) {
  const groups = data?.response?.[0]?.league?.standings;
  return Array.isArray(groups) ? groups.flatMap((group) => Array.isArray(group) ? group : []) : [];
}

// API-Football → AM4 stable row. UI does not inspect provider response shapes
// or hard-code qualification positions.
export function normalizeStandings(rows, { competition, season } = {}) {
  return (rows || []).map((row) => {
    const zone = resolveStandingZone({
      rank: row?.rank,
      description: row?.description,
      status: row?.status,
      competition,
      season,
    });
    return {
      rank: Number(row?.rank) || null,
      teamId: Number(row?.team?.id) || null,
      club: row?.team?.name || null,
      logo: row?.team?.logo || null,
      played: Number(row?.all?.played) || 0,
      win: Number(row?.all?.win) || 0,
      draw: Number(row?.all?.draw) || 0,
      lose: Number(row?.all?.lose) || 0,
      goalsDiff: Number(row?.goalsDiff) || 0,
      points: Number(row?.points) || 0,
      group: row?.group || null,
      description: row?.description || null,
      status: row?.status || null,
      zone: zone.key,
      zoneSource: zone.source,
    };
  });
}

async function fetchCompetitionStandings({ name, providerId }, season) {
  const data = await apiFootballFetch('/standings', { league: providerId, season });
  const errors = providerErrors(data);
  if (errors) return { name, providerId, standings: [], available: false, errors };
  const standings = normalizeStandings(flattenStandingTables(data), { competition: name, season });
  return { name, providerId, standings, available: standings.length > 0, errors: null };
}

function scopedPayload(result, season, requestedName) {
  return {
    season,
    competition: result?.name || requestedName || null,
    competitionId: result?.providerId || null,
    standings: result?.standings || [],
    standingsAvailable: Boolean(result?.available),
    qualificationLegend: standingZoneLegend(result?.standings || []),
    ...(result?.errors ? { errors: { [result.name]: result.errors } } : {}),
  };
}

export default async function handler(req, res) {
  const API_KEY = process.env.API_FOOTBALL_KEY;

  res.setHeader('Access-Control-Allow-Origin', '*');

  if (!API_KEY) {
    return res.status(500).json({ error: 'API_FOOTBALL_KEY が設定されていません' });
  }

  // Match detail always asks for the fixture's season. The aggregate endpoint
  // still works without a query, but now follows the current Tokyo season.
  const { season: seasonParam } = req.query;
  const SEASON = resolveStandingSeason(seasonParam);
  if (SEASON == null) {
    return res.status(400).json({
      error: `season は ${MIN_SEASON}〜${MAX_SEASON} の範囲の整数で指定してください`,
      received: seasonParam
    });
  }

  try {
    const requestedName = req.query?.competition;
    const requestedCompetition = resolveStandingCompetition({
      competition: requestedName,
      competitionId: req.query?.competitionId,
    });

    // Match detail's scoped request. A cup / friendly that has no supported
    // table gets a true empty state without a speculative provider request.
    if (requestedName || req.query?.competitionId) {
      if (!requestedCompetition) {
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=300');
        return res.status(200).json(scopedPayload(null, SEASON, requestedName));
      }
      const result = await fetchCompetitionStandings(requestedCompetition, SEASON);
      res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=900');
      return res.status(200).json(scopedPayload(result, SEASON, requestedCompetition.name));
    }

    // Preserve the aggregate response for external callers. Each row now has
    // a provider team ID and a normalized qualification-zone key as well.
    const results = await Promise.all(Object.entries(STANDING_COMPETITIONS).map(async ([name, providerId]) =>
      fetchCompetitionStandings({ name, providerId }, SEASON),
    ));
    const leagues = Object.fromEntries(results.map((result) => [result.name, result.standings]));
    const errors = Object.fromEntries(results.filter((result) => result.errors).map((result) => [result.name, result.errors]));
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=900');
    return res.status(200).json({ season: SEASON, leagues, ...(Object.keys(errors).length ? { errors } : {}) });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '取得に失敗しました', detail: err.message });
  }
}

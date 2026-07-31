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

import { apiFootballFetch } from '../lib/api-football-client.js';

const LEAGUES = {
  'プレミアリーグ': 39,
  'ラ・リーガ': 140,
  'セリエA': 135,
  'ブンデスリーガ': 78,
  'リーグ・アン': 61
};

// api/standings.js・api/top-scorers.jsと同じ範囲・既定値(2026-07-31のPro
// プラン切り替えの根拠はstandings.jsのコメント参照)。
const MIN_SEASON = 2022;
const MAX_SEASON = 2026;
const DEFAULT_SEASON = 2025;

// 終了済み(Match Finished)の試合のみスコア表示の対象にする(延長・PK戦を含む)。
const FINISHED_STATUSES = ['FT', 'AET', 'PEN'];

// API-Footballのleague.round(例: "Regular Season - 24")から節番号だけを取り出す。
function parseRoundNumber(rawRound) {
  if (!rawRound) return null;
  const match = String(rawRound).match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const API_KEY = process.env.API_FOOTBALL_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: 'API_FOOTBALL_KEY が設定されていません' });
  }

  // 【一時的な調査用】/fixturesのteams.*.nameと/teamsのteam.nameの表記差を確認。
  // GET ?teamNameCheck=1&team=34
  if (req.method === 'GET' && req.query.teamNameCheck === '1') {
    const teamId = Number(req.query.team);
    const d = await apiFootballFetch('/teams', { id: teamId });
    return res.status(200).json({ teamsEndpoint: d.response?.[0]?.team || null });
  }

  const { league } = req.query;
  const leagueId = LEAGUES[league];
  if (!leagueId) {
    return res.status(400).json({ error: `league は次のいずれかを指定してください: ${Object.keys(LEAGUES).join(' / ')}` });
  }

  const seasonParam = Number(req.query.season);
  const SEASON = Number.isInteger(seasonParam) ? seasonParam : DEFAULT_SEASON;
  if (SEASON < MIN_SEASON || SEASON > MAX_SEASON) {
    return res.status(400).json({ error: `season は ${MIN_SEASON}〜${MAX_SEASON} の範囲で指定してください` });
  }

  try {
    const data = await apiFootballFetch('/fixtures', { league: leagueId, season: SEASON });

    if (data.errors && Object.keys(data.errors).length > 0) {
      console.error(`[fixtures] ${league} (league=${leagueId}, season=${SEASON}):`, data.errors);
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
      return res.status(200).json({ league, season: SEASON, errors: data.errors, fixtures: [], rounds: [], dates: [] });
    }

    const fixtures = (data.response || []).map(f => {
      const played = FINISHED_STATUSES.includes(f.fixture.status?.short);
      return {
        id: f.fixture.id,
        date: (f.fixture.date || '').slice(0, 10),
        round: parseRoundNumber(f.league.round),
        status: f.fixture.status?.short,
        home: f.teams.home.name,
        away: f.teams.away.name,
        homeLogo: f.teams.home.logo || null,
        awayLogo: f.teams.away.logo || null,
        homeGoals: f.goals.home,
        awayGoals: f.goals.away,
        score: played ? `${f.goals.home}-${f.goals.away}` : '-',
        venue: f.fixture.venue?.name || null,
      };
    });

    // 節一覧(昇順)・日付一覧(昇順)。フロント側のプルダウン用。
    const rounds = [...new Set(fixtures.map(f => f.round).filter(r => r !== null))].sort((a, b) => a - b);
    const dates = [...new Set(fixtures.map(f => f.date).filter(Boolean))].sort();

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
    return res.status(200).json({ league, season: SEASON, fixtures, rounds, dates });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '取得に失敗しました', detail: err.message });
  }
}

// api/standings.js
// Vercelのサーバーレス関数(Node.js)。
// このファイルをデプロイすると、
// https://あなたのプロジェクト.vercel.app/api/standings
// で「5大リーグ全部」の順位表がまとめてJSONで返ってきます。
//
// 非公開・個人利用の想定なので、1日数回このエンドポイントを叩く程度なら
// 無料枠(1日100リクエスト ※API-Football側への実際の通信回数でカウント)に
// 余裕で収まります(1回の呼び出しで5リーグ分＝5リクエスト消費)。
//
// 2026-07-31: 5リーグを並行して問い合わせる際、api/fixtures.jsの同時実行と
// API-Football側のレート制限に一部だけ引っかかる事例を確認したため、リトライ・
// グローバルスロットリング機能を持つapiFootballFetch()に統一した。

import { apiFootballFetch } from '../lib/api-football-client.js';

// 2026-07-31: Proプランへの切り替えに伴い、無料プラン時代の上限(2024固定)から
// 引き上げた。API-Footballの/leaguesレスポンス(seasons配列)を実際に確認したところ
// (5大リーグすべてで同じパターン): season=2025は2025-08〜2026-05で終了済みの
// 「2025-26シーズン」(最新の完了シーズン、実データがフル)。season=2026は
// current:trueだが2026-08開幕予定でまだ試合が無い(空の順位表になる)。そのため
// MAX_SEASONは開幕後に備えて2026まで許容しつつ、DEFAULT_SEASONは実データが
// そろっている2025(2025-26シーズン)にした。
const MIN_SEASON = 2022;
const MAX_SEASON = 2026;
const DEFAULT_SEASON = 2025;

export default async function handler(req, res) {
  const API_KEY = process.env.API_FOOTBALL_KEY;

  res.setHeader('Access-Control-Allow-Origin', '*');

  if (!API_KEY) {
    return res.status(500).json({ error: 'API_FOOTBALL_KEY が設定されていません' });
  }

  // 【一時的な調査用】Champions Leagueのstandingsレスポンス形式を確認するための診断用。
  // GET ?clStandingsCheck=1&season=2025
  if (req.method === 'GET' && req.query.clStandingsCheck === '1') {
    const season = Number(req.query.season) || 2025;
    const d = await apiFootballFetch('/standings', { league: 2, season });
    const standingsGroups = d.response?.[0]?.league?.standings || [];
    const leaguesResp = await apiFootballFetch('/leagues', { id: 2 });
    const fixturesResp = await apiFootballFetch('/fixtures', { league: 2, season });
    const roundLabels = [...new Set((fixturesResp.response || []).map(f => f.league.round))];
    return res.status(200).json({
      errors: d.errors,
      groupCount: standingsGroups.length,
      firstGroupLength: standingsGroups[0]?.length,
      logo: leaguesResp.response?.[0]?.league?.logo || null,
      totalFixtures: (fixturesResp.response || []).length,
      roundLabels,
    });
  }

  // ?season=2023 のように指定可能。未指定ならデフォルト値を使う。
  const { season: seasonParam } = req.query;
  let SEASON = DEFAULT_SEASON;
  if (seasonParam !== undefined) {
    SEASON = Number(seasonParam);
    if (!Number.isInteger(SEASON) || SEASON < MIN_SEASON || SEASON > MAX_SEASON) {
      return res.status(400).json({
        error: `season は ${MIN_SEASON}〜${MAX_SEASON} の範囲の整数で指定してください`,
        received: seasonParam
      });
    }
  }

  // サイト内の leaguesData のキー名と、API-Football側のリーグIDの対応表
  const LEAGUES = {
    'プレミアリーグ': 39,
    'ラ・リーガ': 140,
    'セリエA': 135,
    'ブンデスリーガ': 78,
    'リーグ・アン': 61
  };

  try {
    // 5リーグ分を並行して取得(Promise.allでまとめて投げる)
    const entries = Object.entries(LEAGUES);
    const errorsByLeague = {};
    const results = await Promise.all(
      entries.map(async ([name, leagueId]) => {
        const data = await apiFootballFetch('/standings', { league: leagueId, season: SEASON });

        // api-footballはキー無効・プラン制限・シーズン範囲外などの場合でも
        // HTTPステータスは200を返し、代わりに data.errors にエラー理由を入れてくる。
        // ここを見ずに response だけ拾うと、エラー時に無言で空配列になってしまう。
        if (data.errors && Object.keys(data.errors).length > 0) {
          console.error(`[standings] ${name} (league=${leagueId}, season=${SEASON}):`, data.errors);
          errorsByLeague[name] = data.errors;
        }

        const table = data.response?.[0]?.league?.standings?.[0] || [];
        const simplified = table.map(row => ({
          rank: row.rank,
          club: row.team.name,
          logo: row.team.logo || null,
          played: row.all.played,
          win: row.all.win,
          draw: row.all.draw,
          lose: row.all.lose,
          goalsDiff: row.goalsDiff,
          points: row.points
        }));
        return [name, simplified];
      })
    );

    // { 'プレミアリーグ': [...], 'ラ・リーガ': [...], ... } の形に整形
    const leaguesData = Object.fromEntries(results);

    // 個人利用なら、少し長めにキャッシュしても実用上問題ない(30分)
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
    const body = { season: SEASON, leagues: leaguesData };
    if (Object.keys(errorsByLeague).length > 0) {
      body.errors = errorsByLeague;
    }
    return res.status(200).json(body);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '取得に失敗しました', detail: err.message });
  }
}

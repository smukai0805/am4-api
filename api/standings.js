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

  // サイト内の leaguesData のキー名と、API-Football側のリーグIDの対応表。
  // 2026-07-31: Champions League(league id=2)を追加。standingsのレスポンス形式を
  // 実際に確認したところ、2024-25シーズンからの36チーム単一リーグフェーズ表は
  // 他5リーグと全く同じ形状(response[0].league.standings[0]が単一のフラット配列)
  // だったため、既存のマッピングロジックをそのまま流用できた(コード変更不要)。
  const LEAGUES = {
    'プレミアリーグ': 39,
    'ラ・リーガ': 140,
    'セリエA': 135,
    'ブンデスリーガ': 78,
    'リーグ・アン': 61,
    'チャンピオンズリーグ': 2
  };

  // 一時診断: EL BLANCO連携作業のため、"International Friendlies"のAPI-FootballリーグID
  // とレアル・マドリードの直近親善試合の有無を検証する。突き合わせ後に削除する。
  if (req.query.leagueSearch) {
    const data = await apiFootballFetch('/leagues', { search: req.query.leagueSearch });
    return res.status(200).json({ results: (data.response||[]).map(r=>({ id: r.league.id, name: r.league.name, type: r.league.type, country: r.country?.name })) });
  }
  if (req.query.friendliesCheck === '1') {
    const leagueId = Number(req.query.leagueId) || 10;
    const seasonParam = Number(req.query.season) || 2026;
    const data = await apiFootballFetch('/fixtures', { team: 541, league: leagueId, season: seasonParam });
    return res.status(200).json({
      leagueId, season: seasonParam,
      errors: data.errors,
      fixtures: (data.response||[]).map(f => ({ date: f.fixture.date, status: f.fixture.status?.short, home: f.teams.home.name, away: f.teams.away.name, roundRaw: f.league.round }))
    });
  }

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

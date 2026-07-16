// api/standings.js
// Vercelのサーバーレス関数(Node.js)。
// このファイルをデプロイすると、
// https://あなたのプロジェクト.vercel.app/api/standings
// で「5大リーグ全部」の順位表がまとめてJSONで返ってきます。
//
// 非公開・個人利用の想定なので、1日数回このエンドポイントを叩く程度なら
// 無料枠(1日100リクエスト ※API-Football側への実際の通信回数でカウント)に
// 余裕で収まります(1回の呼び出しで5リーグ分＝5リクエスト消費)。

const MIN_SEASON = 2022;
const MAX_SEASON = 2024;
const DEFAULT_SEASON = 2024;

export default async function handler(req, res) {
  const API_KEY = process.env.API_FOOTBALL_KEY;

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
        const response = await fetch(
          `https://v3.football.api-sports.io/standings?league=${leagueId}&season=${SEASON}`,
          { headers: { 'x-apisports-key': API_KEY } }
        );
        if (!response.ok) {
          throw new Error(`${name} の取得に失敗: ${response.status}`);
        }
        const data = await response.json();

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

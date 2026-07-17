// api/top-scorers.js
// Vercelのサーバーレス関数(Node.js)。
// 指定したリーグ・シーズンの得点ランキング(TOP10)を取得する。
// 例: /api/top-scorers?league=プレミアリーグ&season=2023
//
// 無料プランの制限上、season は 2022〜2024 のみ対応(standings.jsと同じ制限)。

const LEAGUES = {
  'プレミアリーグ': 39,
  'ラ・リーガ': 140,
  'セリエA': 135,
  'ブンデスリーガ': 78,
  'リーグ・アン': 61
};

const MIN_SEASON = 2022;
const MAX_SEASON = 2024;

export default async function handler(req, res) {
  // ブラウザから直接fetchできるようCORSを許可(standings.jsと同じ対応)
  res.setHeader('Access-Control-Allow-Origin', '*');

  const API_KEY = process.env.API_FOOTBALL_KEY;
  const { league, season } = req.query;
  const SEASON = Number(season) || 2024;

  if (!API_KEY) {
    return res.status(500).json({ error: 'API_FOOTBALL_KEY が設定されていません' });
  }
  if (SEASON < MIN_SEASON || SEASON > MAX_SEASON) {
    return res.status(400).json({ error: `season は ${MIN_SEASON}〜${MAX_SEASON} の範囲で指定してください(無料プランの制限)` });
  }
  const leagueId = LEAGUES[league];
  if (!leagueId) {
    return res.status(400).json({ error: `league は次のいずれかを指定してください: ${Object.keys(LEAGUES).join(' / ')}` });
  }

  try {
    const response = await fetch(
      `https://v3.football.api-sports.io/players/topscorers?league=${leagueId}&season=${SEASON}`,
      { headers: { 'x-apisports-key': API_KEY } }
    );
    if (!response.ok) throw new Error(`取得に失敗: ${response.status}`);
    const data = await response.json();

    if (data.errors && Object.keys(data.errors).length > 0) {
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
      return res.status(200).json({ league, season: SEASON, errors: data.errors, ranking: [] });
    }

    const ranking = (data.response || []).slice(0, 10).map((entry, i) => {
      const stat = entry.statistics?.[0];
      return {
        rank: i + 1,
        name: entry.player.name,
        nationality: entry.player.nationality,
        team: stat?.team?.name || null,
        goals: stat?.goals?.total ?? null,
        assists: stat?.goals?.assists ?? null,
        appearances: stat?.games?.appearences ?? null
      };
    });

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
    return res.status(200).json({ league, season: SEASON, ranking });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '取得に失敗しました', detail: err.message });
  }
}

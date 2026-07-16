// api/player-stats.js
// Vercelのサーバーレス関数(Node.js)。
// 選手名(英字表記)で検索して、今季の個人成績を取得する。
// 例: /api/player-stats?search=Erling Haaland&season=2024
//
// 無料プランの制限上、season は 2022〜2024 のみ対応(standings.jsと同じ制限)。

const MIN_SEASON = 2022;
const MAX_SEASON = 2024;
const DEFAULT_SEASON = 2024;

export default async function handler(req, res) {
  const API_KEY = process.env.API_FOOTBALL_KEY;
  const { search, season: seasonParam } = req.query;

  if (!API_KEY) {
    return res.status(500).json({ error: 'API_FOOTBALL_KEY が設定されていません' });
  }
  if (!search || search.trim().length < 3) {
    return res.status(400).json({ error: 'search パラメータ(選手名、3文字以上)が必要です' });
  }

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

  try {
    const response = await fetch(
      `https://v3.football.api-sports.io/players?search=${encodeURIComponent(search)}&season=${SEASON}`,
      { headers: { 'x-apisports-key': API_KEY } }
    );
    if (!response.ok) {
      throw new Error(`取得に失敗: ${response.status}`);
    }
    const data = await response.json();

    // standings.js と同様、api-footballはエラー時もHTTP 200を返し、
    // errors フィールドに理由を入れてくる。ここも必ず確認する。
    if (data.errors && Object.keys(data.errors).length > 0) {
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
      return res.status(200).json({ found:false, errors: data.errors });
    }

    const player = data.response?.[0];
    if (!player) {
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
      return res.status(200).json({ found:false, message:'選手が見つかりませんでした' });
    }

    // 複数クラブに在籍歴がある場合、出場数が一番多いクラブの成績を採用
    const stat = (player.statistics || []).sort((a,b)=>(b.games?.appearences||0)-(a.games?.appearences||0))[0];

    const simplified = {
      found: true,
      name: player.player.name,
      nationality: player.player.nationality,
      age: player.player.age,
      team: stat?.team?.name || null,
      league: stat?.league?.name || null,
      season: SEASON,
      stats: {
        出場: stat?.games?.appearences ?? null,
        ゴール: stat?.goals?.total ?? null,
        アシスト: stat?.goals?.assists ?? null,
        イエロー: stat?.cards?.yellow ?? null,
        レッド: stat?.cards?.red ?? null,
        平均レーティング: stat?.games?.rating ? Number(stat.games.rating).toFixed(2) : null
      }
    };

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
    return res.status(200).json(simplified);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '取得に失敗しました', detail: err.message });
  }
}

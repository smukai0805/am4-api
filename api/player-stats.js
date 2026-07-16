// api/player-stats.js
// Vercelのサーバーレス関数(Node.js)。
// 選手名(英字表記)+ 所属クラブ名で検索して、今季の個人成績を取得する。
// 例: /api/player-stats?search=Erling Haaland&team=マンチェスター・シティ&season=2024
//
// 注意: API-Footballの仕様上、search(選手名)だけでは検索できず、
// team(チームID)かleague(リーグID)を必ず一緒に指定する必要がある。
// なので、サイト側のクラブ名(日本語)→ API-FootballのチームIDの対応表をここに持たせている。
//
// 無料プランの制限上、season は 2022〜2024 のみ対応(standings.jsと同じ制限)。

const TEAM_IDS = {
  'マンチェスター・シティ': 50,
  'レアル・マドリード': 541,
  'バイエルン・ミュンヘン': 157,
  'アーセナル': 42,
  'パリ・サンジェルマン': 85,
  'FCバルセロナ': 529,
  'バルセロナ': 529,
  'ガラタサライ': 645,
  'マンチェスター・ユナイテッド': 33,
  'ウェストハム': 48,
  'ベンフィカ': 211,
  'ブライトン': 51,
  'チェルシー': 49,
  'リヴァプール': 40,
  'インテル': 505,
  'ユヴェントス': 496,
  'アトレティコ・マドリード': 530,
  'バイヤー・レバークーゼン': 168,
  'ボルシア・ドルトムント': 165,
  'ミラン': 489
};

const MIN_SEASON = 2022;
const MAX_SEASON = 2024;

export default async function handler(req, res) {
  const API_KEY = process.env.API_FOOTBALL_KEY;
  const { search, team, season } = req.query;
  const SEASON = Number(season) || 2024;

  if (!API_KEY) {
    return res.status(500).json({ error: 'API_FOOTBALL_KEY が設定されていません' });
  }
  if (!search || search.trim().length < 3) {
    return res.status(400).json({ error: 'search パラメータ(選手名、3文字以上)が必要です' });
  }
  if (SEASON < MIN_SEASON || SEASON > MAX_SEASON) {
    return res.status(400).json({ error: `season は ${MIN_SEASON}〜${MAX_SEASON} の範囲で指定してください(無料プランの制限)` });
  }

  const teamId = TEAM_IDS[team];
  if (!teamId) {
    return res.status(200).json({
      found: false,
      message: `クラブ「${team}」のチームID対応表が未登録です。TEAM_IDSに追加してください。`
    });
  }

  try {
    const response = await fetch(
      `https://v3.football.api-sports.io/players?search=${encodeURIComponent(search)}&team=${teamId}&season=${SEASON}`,
      { headers: { 'x-apisports-key': API_KEY } }
    );
    if (!response.ok) {
      throw new Error(`取得に失敗: ${response.status}`);
    }
    const data = await response.json();

    if (data.errors && Object.keys(data.errors).length > 0) {
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
      return res.status(200).json({ found:false, errors: data.errors });
    }

    const player = data.response?.[0];
    if (!player) {
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
      return res.status(200).json({ found:false, message:`${SEASON}シーズンの${team}に、この選手のデータが見つかりませんでした` });
    }

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

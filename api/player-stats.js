// api/player-stats.js
// Vercelのサーバーレス関数(Node.js)。
// 選手名(姓のみ推奨)+ 所属クラブ名で検索して、2022〜2024の3シーズン分の成績と顔写真URLをまとめて取得する。
// 例: /api/player-stats?search=Haaland&team=マンチェスター・シティ
//
// 注意: API-Footballの仕様上、search(選手名)だけでは検索できず、
// team(チームID)かleague(リーグID)を必ず一緒に指定する必要がある。
// また、フルネームより姓だけの方が検索にヒットしやすい。
//
// 顔写真について: API-Football側が選手ごとに配布している公式の選手写真URL
// (player.photo)をそのまま返す。自前でホスティングはしていない。
//
// 無料プランの制限上、対応シーズンは 2022〜2024 のみ(standings.jsと同じ制限)。

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

const SEASONS = [2022, 2023, 2024]; // 無料プランで対応できる範囲を全部まとめて取得

export default async function handler(req, res) {
  const API_KEY = process.env.API_FOOTBALL_KEY;
  const { search, team } = req.query;

  if (!API_KEY) {
    return res.status(500).json({ error: 'API_FOOTBALL_KEY が設定されていません' });
  }
  if (!search || search.trim().length < 3) {
    return res.status(400).json({ error: 'search パラメータ(選手の姓、3文字以上)が必要です' });
  }

  const teamId = TEAM_IDS[team];
  if (!teamId) {
    return res.status(200).json({
      found: false,
      message: `クラブ「${team}」のチームID対応表が未登録です。TEAM_IDSに追加してください。`
    });
  }

  try {
    const results = await Promise.all(
      SEASONS.map(async season => {
        const response = await fetch(
          `https://v3.football.api-sports.io/players?search=${encodeURIComponent(search)}&team=${teamId}&season=${season}`,
          { headers: { 'x-apisports-key': API_KEY } }
        );
        if (!response.ok) return { season, error: `HTTP ${response.status}` };
        const data = await response.json();
        if (data.errors && Object.keys(data.errors).length > 0) {
          return { season, error: data.errors };
        }
        const player = data.response?.[0];
        if (!player) return { season, found: false };

        const stat = (player.statistics || []).sort((a,b)=>(b.games?.appearences||0)-(a.games?.appearences||0))[0];
        return {
          season,
          found: true,
          playerName: player.player.name,
          photo: player.player.photo || null,
          nationality: player.player.nationality,
          age: player.player.age,
          team: stat?.team?.name || null,
          league: stat?.league?.name || null,
          stats: {
            出場: stat?.games?.appearences ?? null,
            ゴール: stat?.goals?.total ?? null,
            アシスト: stat?.goals?.assists ?? null,
            イエロー: stat?.cards?.yellow ?? null,
            レッド: stat?.cards?.red ?? null,
            平均レーティング: stat?.games?.rating ? Number(stat.games.rating).toFixed(2) : null
          }
        };
      })
    );

    const foundAny = results.find(r => r.found);
    const seasons = {};
    results.forEach(r => { seasons[r.season] = r; });

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
    return res.status(200).json({
      found: !!foundAny,
      name: foundAny?.playerName || null,
      photo: foundAny?.photo || null,
      nationality: foundAny?.nationality || null,
      age: foundAny?.age || null,
      seasons
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '取得に失敗しました', detail: err.message });
  }
}

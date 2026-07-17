// api/player-stats.js
// Vercelのサーバーレス関数(Node.js)。
//
// 写真は「選手名」だけで取得(所属クラブが実データと違っていてもOK)。
// 成績は「選手名+所属クラブ」で取得(API-Football側の仕様上、クラブ指定が必須のため)。
// 例: /api/player-stats?search=Haaland&team=マンチェスター・シティ
//
// 【将来、有料プランに切り替えたら】
// 下の SEASONS 配列に対応したい年(例: 2025)を足すだけで、
// 自動的にその年の成績・写真も取得対象になります。
// (players/profiles は元々シーズンに縛られないので、写真は今のままでも
//  常に最新のものが返ってきます)

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

// 対応シーズン一覧。有料プランに上げたら、ここに新しい年を足すだけでOK。
const SEASONS = [2022, 2023, 2024];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const API_KEY = process.env.API_FOOTBALL_KEY;
  const { search, team } = req.query;

  if (!API_KEY) {
    return res.status(500).json({ error: 'API_FOOTBALL_KEY が設定されていません' });
  }
  if (!search || search.trim().length < 3) {
    return res.status(400).json({ error: 'search パラメータ(選手の姓、3文字以上)が必要です' });
  }

  // ---- ① 写真だけは「名前のみ」で取得(クラブが実データと違っていてもOK) ----
  let photo = null;
  let profileName = null;
  let profileNationality = null;
  try {
    const profileRes = await fetch(
      `https://v3.football.api-sports.io/players/profiles?search=${encodeURIComponent(search)}`,
      { headers: { 'x-apisports-key': API_KEY } }
    );
    if (profileRes.ok) {
      const profileData = await profileRes.json();
      const profile = profileData.response?.[0]?.player;
      if (profile) {
        photo = profile.photo || null;
        profileName = profile.name || null;
        profileNationality = profile.nationality || null;
      }
    }
  } catch (err) {
    console.error('profile fetch error:', err);
    // 写真取得の失敗は致命的ではないので、ここでは処理を止めずに続行する
  }

  // ---- ② 成績はクラブ指定が必要なので、team が対応表にある場合のみ取得を試みる ----
  const teamId = TEAM_IDS[team];
  let seasons = {};
  let statsFoundAny = false;

  if (teamId) {
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
      results.forEach(r => { seasons[r.season] = r; });
      statsFoundAny = results.some(r => r.found);
    } catch (err) {
      console.error('stats fetch error:', err);
    }
  }

  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
  return res.status(200).json({
    found: !!(photo || statsFoundAny),
    name: profileName,
    photo,
    nationality: profileNationality,
    statsAvailable: statsFoundAny,
    statsNote: !teamId
      ? `クラブ「${team}」のID対応表が未登録のため、成績は取得していません(写真のみ)`
      : (!statsFoundAny ? '実データ(2022〜2024)に該当する在籍記録が見つかりませんでした(写真のみ反映)' : null),
    seasons
  });
}

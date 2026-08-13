// api/squad.js
// Vercelのサーバーレス関数(Node.js)。
//
// 指定クラブ(日本語クラブ名)の現在の全選手を、ポジション・背番号・顔写真つきで
// API-Footballの/players/squadsから1回のリクエストで取得する。
//
// 【2026-08-01追加の経緯】スカッド作成(クラブから編成)機能は、以前は
// football-hub.html内の手作業サンプル選手配列(クラブごとに数人しか無い)しか
// 参照しておらず、実データ確認でレアル・マドリード選択時に4-4-2の11枠中3枠しか
// 埋まらない(GK・DF該当選手が0人)ことが判明した。/players/squadsは1回の呼び出しで
// チーム全体の登録選手(実データ確認で30〜40人規模)を、ポジション(Goalkeeper/
// Defender/Midfielder/Attacker)・顔写真URL付きで返すため、スタメン+ベンチを
// 実在選手で埋められない問題と、追加の写真取得が必要な問題を同時に解決できる。
//
// クラブ名→API-FootballチームIDの対応表はlib/team-ids.js(元api/player-stats.jsの
// TEAM_IDS)を共有する。対応表に無いクラブはfound:falseを返し、フロント側は
// 従来のサンプル選手配列にフォールバックする。
//
// 例: /api/squad?club=レアル・マドリード
//
// 【2026-08-14追加】EL BLANCO連携で、外部フロントエンドから数値のAPI-Football
// チームID(例: team=541)で直接叩こうとして404/500になる問い合わせが複数回あった
// (実際にはclub=<日本語クラブ名>のみ対応で、teamパラメータ自体を読んでいなかった
// ため、常に「club パラメータが必要です」の400になっていた)。外部連携では
// 日本語クラブ名対応表(lib/team-ids.js)への収録有無に依存せず任意のAPI-Football
// チームIDを直接指定できた方が扱いやすいため、team(または teamId)パラメータで
// 数値IDを直接渡せるようにした(club指定時と同じレスポンス形式)。既存のclub=
// 呼び出し元(スカッド作成機能)への影響は無い。

import { TEAM_IDS } from '../lib/team-ids.js';

// API-Footballの4区分(Goalkeeper/Defender/Midfielder/Attacker)を、
// このサイトのフォーメーション判定(GK/DF/MF/FW)に合わせて変換する。
const POSITION_MAP = {
  'Goalkeeper': 'GK',
  'Defender': 'DF',
  'Midfielder': 'MF',
  'Attacker': 'FW',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const API_KEY = process.env.API_FOOTBALL_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: 'API_FOOTBALL_KEY が設定されていません' });
  }

  const { club, team, teamId: teamIdParam } = req.query;
  if (!club && !team && !teamIdParam) {
    return res.status(400).json({ error: 'club(日本語クラブ名)または team/teamId(API-FootballチームID)のいずれかのパラメータが必要です' });
  }

  // club(日本語クラブ名)が指定されていればlib/team-ids.jsで解決し、無ければ
  // team/teamId(数値のAPI-FootballチームID)をそのまま使う。
  let teamId = club ? TEAM_IDS[club] : Number(team ?? teamIdParam);
  if (!teamId || Number.isNaN(teamId)) {
    // clubが対応表に無い場合・team/teamIdが数値として不正な場合は、エラーではなく
    // found:falseで返す。フロント側はこれを見て従来のサンプル選手配列による
    // 自動編成にフォールバックする。
    const reason = club
      ? `クラブ「${club}」のID対応表が未登録です`
      : `team/teamId「${team ?? teamIdParam}」が有効な数値のチームIDではありません`;
    return res.status(200).json({ found: false, reason });
  }

  try {
    const response = await fetch(
      `https://v3.football.api-sports.io/players/squads?team=${teamId}`,
      { headers: { 'x-apisports-key': API_KEY } }
    );
    if (!response.ok) throw new Error(`取得に失敗: ${response.status}`);
    const data = await response.json();

    if (data.errors && Object.keys(data.errors).length > 0) {
      return res.status(200).json({ found: false, reason: 'API-Football側でエラーが発生しました', errors: data.errors });
    }

    const squad = data.response?.[0]?.players || [];
    const players = squad
      .filter(p => POSITION_MAP[p.position]) // 稀にposition不明の選手が混ざるため除外
      .map(p => ({
        id: p.id,
        name: p.name,
        position: POSITION_MAP[p.position],
        number: p.number ?? null,
        age: p.age ?? null,
        photo: p.photo || null,
      }));

    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate');
    return res.status(200).json({ found: players.length > 0, players });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '取得に失敗しました', detail: err.message });
  }
}

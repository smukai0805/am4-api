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
//
// 【2026-08-14追加(下部組織フィルタ)】EL BLANCOの選手名鑑で、レアル・マドリード
// (team=541)のレスポンスに背番号重複が多発する不具合を実データで調査した結果、
// /players/squads?team=541 が以下2種類の「トップチームではない選手」を
// 混入させていることが判明した(いずれも実際のAPI-Football応答で確認済み、憶測なし):
//   (a) Castilla/下部組織所属で今季トップチームの公式戦に一度も出場していない選手
//       (例: 20歳のGKが2試合とも0出場のままトップの背番号帯に登録されている)
//   (b) 移籍市場のノイズと思われる「他クラブに現役在籍中の選手」の混入
//       (例: マルク・ククレジャ(チェルシー)やベルナルド・シルバ(マンチェスターC)が
//       /transfers で確認しても一度もレアル・マドリードへ移籍した記録が無いのに
//       スカッド一覧に含まれていた)
// 一方で、今夏(2026年7月〜8月)に加入したばかりの新戦力(イブラヒマ・コナテ、
// カルロス・エスピ等)は直近シーズンの出場数が0のままでも/transfersで
// 「Real Madridへの移籍」が確認できるため、これらは除外せず含める必要がある。
//
// そのため、以下2段階で「実際にトップチームに所属している選手」かどうかを
// 判定する(いずれもAPI-Football側の実データのみで判定し、年齢等の推測は使わない):
//   1. 直近に終了したシーズンの/players?team=&season=統計で、そのクラブ(team.id一致)
//      での総出場数が1以上 → トップチーム所属とみなす
//   2. 統計に出てこない選手(そのシーズンにまだ所属していなかった選手)は、
//      /transfers で直近の移籍先(teams.in.id)がこのクラブと一致するかを確認し、
//      一致すれば「今シーズンの新加入選手」としてトップチーム所属とみなす
// どちらにも該当しない選手のみ除外する。データが薄いリーグ(下位クラブ等)で
// 過剰に絞り込まれないよう、除外後の人数が極端に少なくなる場合は安全側に倒して
// フィルタ処理自体を諦め、元の一覧をそのまま返す。

import { TEAM_IDS } from '../lib/team-ids.js';

// API-Footballの4区分(Goalkeeper/Defender/Midfielder/Attacker)を、
// このサイトのフォーメーション判定(GK/DF/MF/FW)に合わせて変換する。
const POSITION_MAP = {
  'Goalkeeper': 'GK',
  'Defender': 'DF',
  'Midfielder': 'MF',
  'Attacker': 'FW',
};

// lib/champions-league.js等と同じ「7月以降はその年」ルールで現在進行中の
// シーズンを求め、その1年前(=直近に終了し、統計が出揃っているシーズン)を返す。
function lastCompletedSeasonYear(date = new Date()) {
  const month = date.getMonth();
  const currentSeasonYear = month >= 6 ? date.getFullYear() : date.getFullYear() - 1;
  return currentSeasonYear - 1;
}

// 指定チームの直近終了シーズンの選手統計を、/players?team=&season=&page= で
// ページングしながら集める(1ページ最大20件)。このエンドポイントは「そのシーズンに
// 実際にチームへ登録され、統計レコードを持つ選手」のみを返すため、下部組織の
// 未出場選手や移籍市場ノイズの選手は基本的にここに現れない。
async function fetchSeasonStatsMap(teamId, season, apiKey) {
  const map = new Map(); // playerId -> このteamIdでの総出場数
  for (let page = 1; page <= 5; page++) {
    const r = await fetch(
      `https://v3.football.api-sports.io/players?team=${teamId}&season=${season}&page=${page}`,
      { headers: { 'x-apisports-key': apiKey } }
    );
    if (!r.ok) break;
    const d = await r.json();
    for (const item of d.response || []) {
      const pid = item.player?.id;
      if (pid == null) continue;
      const total = (item.statistics || [])
        .filter(st => st.team?.id === teamId)
        .reduce((sum, st) => sum + (st.games?.appearences || 0), 0);
      map.set(pid, (map.get(pid) || 0) + total);
    }
    if (!d.paging || d.paging.current >= d.paging.total) break;
  }
  return map;
}

// 統計に出てこない選手について、直近の移籍先がこのクラブと一致するかを確認する
// (=今季まだ出場記録は無いが、既に加入が確定している新戦力かどうかの判定)。
//
// 【注意】実データで確認した結果、/transfers のtransfers配列は日付の新しい順に
// 並んでいるとは限らない(例: イブラヒマ・コナテの最新移籍(2026-06-30、
// レアル・マドリード加入)がAPI応答の3番目に入っており、先頭は2021年の
// リヴァプール加入だった)。そのため先頭要素ではなく、date文字列を比較して
// 実際に最も新しいレコードを探す。また、in/out双方が同一クラブになっている
// レコード(下部組織→トップ登録などクラブ内の内部移動と思われるもの、例:
// マリオ・リバス)は「他クラブからの加入」ではないため対象外とする。
async function isConfirmedNewSignee(playerId, teamId, apiKey) {
  try {
    const r = await fetch(
      `https://v3.football.api-sports.io/transfers?player=${playerId}`,
      { headers: { 'x-apisports-key': apiKey } }
    );
    if (!r.ok) return false;
    const d = await r.json();
    const transfers = d.response?.[0]?.transfers || [];
    const latest = transfers.reduce((max, t) => {
      if (!t?.date) return max;
      return (!max || new Date(t.date) > new Date(max.date)) ? t : max;
    }, null);
    if (!latest) return false;
    return latest.teams?.in?.id === teamId && latest.teams?.out?.id !== teamId;
  } catch {
    return false;
  }
}

// トップチーム以外(下部組織の未出場選手・移籍市場ノイズ)を除外する。
// 判定に必要な追加リクエストが失敗した場合や、絞り込みすぎて不自然になる場合は
// 安全側に倒して元の一覧(フィルタなし)をそのまま返す。
async function filterToFirstTeam(players, teamId, apiKey) {
  try {
    const season = lastCompletedSeasonYear();
    const statsMap = await fetchSeasonStatsMap(teamId, season, apiKey);

    const notInStats = players.filter(p => !statsMap.has(p.id));
    const confirmedFlags = await Promise.all(
      notInStats.map(p => isConfirmedNewSignee(p.id, teamId, apiKey))
    );
    const confirmedIds = new Set(
      notInStats.filter((_, i) => confirmedFlags[i]).map(p => p.id)
    );

    const filtered = players.filter(p => {
      const apps = statsMap.get(p.id);
      if (apps != null) return apps > 0;
      return confirmedIds.has(p.id);
    });

    // データが薄いリーグ等で過剰に絞り込まれた場合は、フィルタ自体を諦めて
    // 元の一覧を返す(スタメンすら組めなくなるより、多少ノイズが残る方がまし)。
    if (filtered.length < 11 || filtered.length < players.length * 0.4) {
      return players;
    }
    return filtered;
  } catch (err) {
    console.error('filterToFirstTeam failed, falling back to unfiltered squad:', err);
    return players;
  }
}

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
    const rawPlayers = squad
      .filter(p => POSITION_MAP[p.position]) // 稀にposition不明の選手が混ざるため除外
      .map(p => ({
        id: p.id,
        name: p.name,
        position: POSITION_MAP[p.position],
        number: p.number ?? null,
        age: p.age ?? null,
        photo: p.photo || null,
      }));

    // トップチーム以外(下部組織の未出場選手・移籍市場ノイズ)を除外する。
    const players = await filterToFirstTeam(rawPlayers, teamId, API_KEY);

    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate');
    return res.status(200).json({ found: players.length > 0, players });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '取得に失敗しました', detail: err.message });
  }
}

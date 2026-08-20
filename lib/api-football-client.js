// lib/api-football-client.js
//
// academy-debut-watch.js・match-report-watch.jsで重複していたAPI-Football呼び出しの
// 共通ヘルパー。PILOT_CLUBSを6→15クラブに拡張した際の実データ検証で、レート制限
// (data.errors.rateLimit、HTTPステータス自体は200のまま返る)が想定より厳しく、
// 「5件ずつのバッチ処理+リトライ」程度では防ぎきれないことが分かった
// (/players/profiles だけで20回以上リトライが発生し、検知フェーズだけでVercelの
// 実行時間上限(300秒)を使い切ってタイムアウトする事態になった)。
//
// そのため、ステージ(fixtures取得→lineups取得→profiles取得)をまたいで通しで効く、
// グローバルな最小リクエスト間隔の強制(スロットリング)に設計を変更した。
// mapWithConcurrency()によるバッチ分割と組み合わせて、二重に安全側に振っている。

const API_FOOTBALL_HOST = 'v3.football.api-sports.io';
const API_KEY = process.env.API_FOOTBALL_KEY;

// リクエスト間の最小間隔(ミリ秒)。この関数を呼び出すすべてのAPI-Football呼び出しに
// (fixtures/lineups/profilesのどのステージでも横断して)適用される。実際の許容レートが
// 不明なため保守的な値にしてあるが、実行時間に余裕があるうちはここを詰めても構わない。
const MIN_REQUEST_INTERVAL_MS = 1100;
let nextAvailableAt = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 直前の呼び出しからMIN_REQUEST_INTERVAL_MS以上間隔を空けるまで待つ。
// モジュールスコープの nextAvailableAt により、同一関数実行内のどの呼び出し元
// (どのバッチ・どのステージ)からでも通しで間隔が守られる。
async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, nextAvailableAt - now);
  nextAvailableAt = Math.max(now, nextAvailableAt) + MIN_REQUEST_INTERVAL_MS;
  if (wait > 0) await sleep(wait);
}

export async function apiFootballFetch(path, params, { retries = 3, retryDelayMs = 3000, timeoutMs = 15000 } = {}) {
  const url = new URL(`https://${API_FOOTBALL_HOST}${path}`);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));

  for (let attempt = 0; ; attempt++) {
    await throttle();
    const res = await fetch(url, {
      headers: { 'x-apisports-key': API_KEY },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`API-Football error: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    if (data.errors?.rateLimit && attempt < retries) {
      console.error(`API-Football rate limit hit (${path}), retry ${attempt + 1}/${retries}...`);
      await sleep(retryDelayMs * (attempt + 1));
      continue;
    }
    return data;
  }
}

// 2026-08-04: 略称での検索が、公式名に略称が含まれない全く無関係の弱小クラブに
// 誤ヒットすることを実データで確認した(例: "PSG"で検索すると、フランスのパリ・
// サンジェルマン(公式名"Paris Saint Germain"には"PSG"という文字列が含まれない)
// ではなく、インドネシアの"PSGC Ciamis"がヒットしてしまい、急上昇選手ランキングの
// サムネイルに誤ったクラブロゴが表示される不具合につながった)。AIが移籍速報生成時に
// この種の一般的な略称を使うことがあるため、既知の主要な略称は検索前に正式名へ
// 変換しておく。
const TEAM_NAME_ALIASES = {
  'psg': 'Paris Saint Germain',
  'man utd': 'Manchester United',
  'man united': 'Manchester United',
  'man city': 'Manchester City',
  'barca': 'Barcelona',
  'atletico': 'Atletico Madrid',
  'atleti': 'Atletico Madrid',
  'inter': 'Inter Milan',
  'bayern': 'Bayern Munich',
  'juve': 'Juventus',
};

// クラブ名(英語表記)からAPI-FootballのチームIDを検索する(2026-08-04追加、
// api/transfer-news-watch.jsの移籍速報サムネイル用、fromClub/toClubのロゴ表示に使う)。
// 同名の下部組織・女子チーム等が複数ヒットする可能性があるが、先頭の結果(実データで
// 確認した限り、主要クラブが常に最初に返る)を採用する簡易実装(academy-core.jsの
// searchPlayerProfileByNameと同じ方針)。見つからない場合はnullを返す。
export async function searchTeamIdByName(name) {
  const alias = TEAM_NAME_ALIASES[name.trim().toLowerCase()];
  const data = await apiFootballFetch('/teams', { search: alias || name });
  return data.response?.[0]?.team?.id ?? null;
}

// items を limit 件ずつのバッチに分けて順に処理する(バッチ内は並列)。
// スロットリングにより実際のリクエスト送出はどのみち直列化されるが、
// 同時に開くコネクション数を抑える目的でバッチ分割も併用している。
export async function mapWithConcurrency(items, limit, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

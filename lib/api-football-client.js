// lib/api-football-client.js
//
// academy-debut-watch.js・match-report-watch.jsで重複していたAPI-Football呼び出しの
// 共通ヘルパー。PILOT_CLUBSを6→15クラブに拡張した際の実データ検証で、全クラブ分の
// fixtures取得を一斉にPromise.allで並列実行すると、API-Football側のレート制限
// (data.errors.rateLimit、HTTPステータス自体は200のまま返る)に一部のクラブが
// 引っかかることを確認した。これに対処するため2つの仕組みを提供する:
//   1. apiFootballFetch(): レート制限を検知した場合、短い待機を挟んで自動リトライする
//   2. mapWithConcurrency(): 一斉並列ではなく、一定数ずつバッチ処理することで
//      そもそもレート制限に引っかかりにくくする

const API_FOOTBALL_HOST = 'v3.football.api-sports.io';
const API_KEY = process.env.API_FOOTBALL_KEY;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function apiFootballFetch(path, params, { retries = 3, retryDelayMs = 1500 } = {}) {
  const url = new URL(`https://${API_FOOTBALL_HOST}${path}`);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { 'x-apisports-key': API_KEY } });
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

// items を limit 件ずつのバッチに分けて順に処理する(バッチ内は並列)。
// 15クラブ全部を一斉並列で叩くとAPI-Football側のレート制限に当たりやすいため、
// 検知系のfixtures一括取得はこれ経由にする。
export async function mapWithConcurrency(items, limit, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

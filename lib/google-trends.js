// lib/google-trends.js
//
// 「急上昇選手ランキング」機能(lib/trending-players.js)の補助シグナル用。
//
// 【2026-08-04の実データ検証で判明した重要な制約】当初想定していた「特定の選手名
// リストの検索ボリュームを直接比較する」エンドポイント(trends.google.com/trends/api/
// explore、いわゆるinterestOverTime系、pytrends等が使う方式)は、簡単なテストだけで
// 即座に429(Too Many Requests)を返し、実運用に耐えないことを確認した。
//
// 唯一安定して動作したのは、https://trends.google.com/trending/rss?geo=<国コード> という
// 「その国の一般的な急上昇検索ワード」を返すRSSフィード(上位10件、category指定は
// 効果が無いことも確認済み)。これは特定の選手名を狙い撃ちでは検索できず、あくまで
// 「今何が話題か」の一覧に過ぎないため、この対応表に載っている選手が毎回ヒットする
// 保証は無い(実データ確認では、6カ国×10件=60件中サッカー関連は数件程度だった)。
//
// そのため「急上昇選手ランキング」本体は、このモジュールを主要な情報源にはせず、
// サイト内の記事生成頻度(lib/trending-players.js側)を主軸とし、このモジュールは
// 「たまたま一般トレンドにも載っていれば🔥バッジを追加する」補助シグナルとして
// 使う設計にしている。取得失敗(ネットワークエラー・429・XML解析失敗等)は個別の
// 国ごとに握りつぶし、他の国の結果はそのまま使う(全滅した場合は単に🔥バッジが
// 一つも付かないだけで、呼び出し元のランキング計算自体は落ちない)。

import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({ ignoreAttributes: false, processEntities: false });

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};

function decodeEntities(str) {
  return String(str ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

async function fetchCountryTrends(geo) {
  const res = await fetch(`https://trends.google.com/trending/rss?geo=${geo}`, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const data = parser.parse(xml);
  const items = data?.rss?.channel?.item;
  const list = Array.isArray(items) ? items : (items ? [items] : []);
  return list.map(it => {
    const title = decodeEntities(it.title);
    // ht:news_item は1件のトレンドに対して複数(関連ニュース記事ごと)入っており、
    // 配列で返ってくる(単一の場合はオブジェクトのことがあるため両対応)。見出しの
    // 表記ゆれ(例: "lukas hornicek" vs "Lukáš Horníček")を拾えるよう全件連結する。
    const newsItems = Array.isArray(it['ht:news_item']) ? it['ht:news_item'] : (it['ht:news_item'] ? [it['ht:news_item']] : []);
    const newsTitles = newsItems.map(n => decodeEntities(n?.['ht:news_item_title'] ?? '')).join(' ');
    return `${title} ${newsTitles}`.toLowerCase();
  });
}

// 複数国のGoogle Trends一般トレンドを取得し、選手名の部分一致に使える1つの
// 小文字テキストにまとめて返す。個々の国の取得失敗は握りつぶし、成功した国だけを
// 反映する(全滅してもエラーを投げず、空のテキスト+failed一覧を返す)。
export async function fetchTrendingTermsBlob(countries) {
  const results = await Promise.allSettled(countries.map(geo => fetchCountryTrends(geo)));
  const countriesOk = [];
  const countriesFailed = [];
  const lines = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      countriesOk.push(countries[i]);
      lines.push(...r.value);
    } else {
      countriesFailed.push({ geo: countries[i], reason: r.reason?.message || String(r.reason) });
    }
  });
  return { text: lines.join(' \n '), countriesOk, countriesFailed };
}

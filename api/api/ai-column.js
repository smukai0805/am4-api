// api/news.js
// Vercelのサーバーレス関数(Node.js)。
// サッカー専門メディアのRSSフィードを取得・パースして、
// football-hub.html 側の news 配列と同じ形で返す。
// APIキー不要、無料で使える(RSSはそもそも公開情報の配信フォーマット)。
//
// 依存パッケージ: fast-xml-parser (package.json に追記済み)
//
// ------------------------------------------------------------------
// 【2026-07 改修】ニュースタブのリッチ化に合わせて、以下を追加で返すようにした。
//   - summary : 記事の概要(descriptionタグをHTMLタグ除去のうえ100文字程度に短縮)
//   - image   : サムネイル画像URL(media:thumbnail / media:content / enclosure のいずれかから取得)
//   - link    : 元記事へのURL(フロント側で見出し・カードをクリックすると開く)
// また、Sky Sportsフィードが取得失敗していた問題への対策として、
// fetch時にUser-Agentヘッダーを明示的に付与するようにした
// (UAが空/Node標準のfetchだと一部メディアがボット判定してブロックすることがあるため)。
// 情報源も1件追加し、記事の多様性を増やしている。
// ------------------------------------------------------------------

import { XMLParser } from 'fast-xml-parser';

// 取得元のRSSフィード一覧。信頼できる主要メディアに絞ることで、
// 出典の怪しい記事が混ざるのを防ぐ。増やしたい場合はここに追記するだけ。
//
// lang: サイトのUI言語(ja/en/es)と紐付けるためのタグ。
// フロント側で選択中の言語に応じて、この言語の記事を優先的に返す(下記ハンドラ内のフィルタ処理を参照)。
//
// スペイン語(es)向けソースについては、Marca(スペイン最大手のスポーツ紙)のRSSを検証したが、
// (1) 記事の日付が実際の配信日と大きくズレており更新が止まっている疑いがあること、
// (2) 暴力事件や性的な話題など、このアプリの読者層にそぐわないタブロイド記事が
//     サッカー記事に混ざって配信されていたこと、の2点から採用を見送った。
// 現状はes言語選択時、下記ハンドラ内でen(英語)の記事にフォールバックしている。
const FEEDS = [
  { url: 'http://feeds.bbci.co.uk/sport/football/rss.xml', source: 'BBC Sport', lang: 'en' },
  { url: 'https://www.skysports.com/rss/12040', source: 'Sky Sports', lang: 'en' },
  { url: 'https://www.theguardian.com/football/rss', source: 'The Guardian', lang: 'en' },
  // ゲキサカ(講談社運営)の「海外サッカー」カテゴリRSS。日本語記事を増やす目的で追加。
  // サッカーキング(soccer-king.jp)のRSSはRDF/RSS1.0という別形式で、
  // 現状のパーサー(RSS2.0の<rss><channel><item>構造を前提)とは互換性が無いため見送り、
  // 同じRSS2.0形式で提供されているゲキサカを採用した。更新頻度も高く、
  // 画像(<image><url>)・要約・リンクが全記事に揃っている。
  // limit: 15 — 日本語(ja)ソースはこの1本しか無いため、英語3ソース合計(最大24件)と
  // 記事のボリュームに差が出すぎないよう、他フィードより多めに取得しておく。
  { url: 'https://web.gekisaka.jp/feed?category=foreign', source: 'ゲキサカ', lang: 'ja', limit: 15 },
  // 他に追加したい場合はここに { url, source, lang, limit(省略可、既定8) } を追記
];

// UI言語 → 実際にフィルタで使う言語のマッピング。
// esには専用ソースが無いため、いまはenにフォールバックする。
const LANG_FALLBACK = { es: 'en' };

// 一部メディアはUser-Agentが無い/簡素なリクエストをボット判定してブロックすることがあるため、
// ブラウザからのアクセスに近いヘッダーを明示的に付与する
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; AM4NewsBot/1.0; +https://am4-api.vercel.app)',
  'Accept': 'application/rss+xml, application/xml, text/xml, */*'
};

// processEntities:false にして、fast-xml-parserの実体参照展開まわりの
// 安全機構(「Entity expansion limit exceeded」エラー)が、本文中に
// タイポグラフィ実体参照(&#8217;など)を大量に含むフィード(Guardian等)で
// 発火してフィード全体が取得失敗になるのを回避する。
// 実体参照そのものは下のdecodeEntities()で手動デコードする。
const parser = new XMLParser({ ignoreAttributes: false, processEntities: false });

function decodeEntities(str) {
  return String(str ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripHtml(str) {
  return decodeEntities(str)
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 日付が欠落/不正な形式でも例外を投げず、フィード全体の取得失敗に
// つながらないようにする(Sky Sportsで実際にこの問題が起きていた:
// pubDateが無い/パースできない記事が1件でもあると、修正前は
// .toISOString()が例外を投げてフィード全体がfailedFeeds行きになっていた)
function safeIsoDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len).trim() + '…' : str;
}

function extractImage(item) {
  // media:thumbnail (BBC等) — 単一 or 配列(複数解像度)の場合がある
  const thumb = item['media:thumbnail'];
  if (thumb) {
    const t = Array.isArray(thumb) ? thumb[0] : thumb;
    if (t && t['@_url']) return decodeEntities(t['@_url']);
  }
  // media:content (Guardian等) — Guardianのurl属性は "?width=140&amp;quality=85&amp;..." のように
  // 実体参照がエスケープされたまま入っているため、decodeEntities()で"&"に戻す
  // (デコードしないとURLのクエリパラメータ区切りとして壊れる)
  const content = item['media:content'];
  if (content) {
    const c = Array.isArray(content) ? content[0] : content;
    if (c && c['@_url']) return decodeEntities(c['@_url']);
  }
  // enclosure(画像添付形式のRSS)
  if (item.enclosure && item.enclosure['@_url'] && /image/.test(item.enclosure['@_type'] || '')) {
    return decodeEntities(item.enclosure['@_url']);
  }
  // <image><url>...</url></image>(ゲキサカ等) — 記事によっては無い場合もある
  if (item.image && item.image.url) {
    return decodeEntities(String(item.image.url));
  }
  return null;
}

// 全フィードを取得してパースする共通処理。lang絞り込み等は行わず、
// 取得できた生の記事一覧をそのまま返す。
// api/ai-column.js側でもこの関数を再利用し(AM4コラムの「話題まとめ」機能で
// 実際の報道記事をAIに読ませて要約させるため)、RSS取得・パース処理を二重管理しないようにしている。
export async function fetchAllNewsItems() {
  const results = await Promise.allSettled(
    FEEDS.map(async feed => {
      const response = await fetch(feed.url, { headers: FETCH_HEADERS });
      if (!response.ok) throw new Error(`${feed.source} の取得に失敗: ${response.status}`);
      const xml = await response.text();
      const data = parser.parse(xml);
      const items = data?.rss?.channel?.item || [];
      return items.slice(0, feed.limit || 8).map(item => {
        const rawTitle = typeof item.title === 'string' ? item.title : String(item.title ?? '');
        return {
          headline: decodeEntities(rawTitle),
          summary: truncate(stripHtml(item.description), 100),
          image: extractImage(item),
          source: feed.source,
          lang: feed.lang,
          time: safeIsoDate(item.pubDate),
          link: item.link ? decodeEntities(String(item.link)) : null
        };
      });
    })
  );

  const fetchedItems = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  const failedFeeds = results
    .map((r, i) => (r.status === 'rejected' ? { source: FEEDS[i].source, error: String(r.reason?.message || r.reason) } : null))
    .filter(Boolean);

  return { items: fetchedItems, failedFeeds };
}

export default async function handler(req, res) {
  // 他のエンドポイント(player-stats.js等)には元から入っていたが、
  // このnews.jsだけ設定が漏れていた。file://で直接HTMLを開いた場合や
  // 別ドメインからのfetchはこれが無いとブラウザ側でブロックされ、
  // フロント側は「取得失敗」としてサンプルデータ表示にフォールバックしてしまう。
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { items: fetchedItems, failedFeeds } = await fetchAllNewsItems();

    // ?lang=ja/en/es のクエリに応じて、対応する言語のソースを優先的に返す。
    // 例: ?lang=ja なら日本語記事(ゲキサカ)のみに絞る。
    // 該当言語のソースが無い/該当記事が0件の場合は、全言語混合の一覧にフォールバックする
    // (空っぽの結果を返してフロント側を「取得失敗」扱いにしないため)。
    const requestedLang = String(req.query.lang || '').toLowerCase();
    const targetLang = LANG_FALLBACK[requestedLang] || requestedLang;
    const hasLangSource = FEEDS.some(f => f.lang === targetLang);

    let pool = fetchedItems;
    if (targetLang && hasLangSource) {
      const inLang = fetchedItems.filter(n => n.lang === targetLang);
      if (inLang.length > 0) pool = inLang;
    }

    const allItems = pool
      .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))
      .slice(0, 15); // TOP15件に絞る(サイト側はTOP8前後表示なので余裕を持たせている)

    // ニュースは移籍情報ほど速報性が問われないので、長めに(30分)キャッシュ。
    // フロント側は5分おきに再フェッチするが、Vercelのエッジキャッシュにより
    // 実際にAPI-Football側やメディア側への外部リクエストが発生するのは
    // キャッシュ切れの30分ごとに抑えられる。
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
    return res.status(200).json({ news: allItems, failedFeeds });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '取得に失敗しました', detail: err.message });
  }
}

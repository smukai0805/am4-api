// api/news.js
// Vercelのサーバーレス関数(Node.js)。
// サッカー専門メディアのRSSフィードを取得・パースして、
// football-hub.html 側の news 配列と同じ形(headline, source, time)で返す。
// APIキー不要、無料で使える(RSSはそもそも公開情報の配信フォーマット)。
//
// 依存パッケージ: fast-xml-parser (package.json に追記が必要、下記参照)

import { XMLParser } from 'fast-xml-parser';

// 取得元のRSSフィード一覧。信頼できる主要メディアに絞ることで、
// 出典の怪しい記事が混ざるのを防ぐ。増やしたい場合はここに追記するだけ。
const FEEDS = [
  { url: 'http://feeds.bbci.co.uk/sport/football/rss.xml', source: 'BBC Sport' },
  { url: 'https://www.skysports.com/rss/12040', source: 'Sky Sports' },
  // 他に追加したい場合はここに { url, source } を追記
];

const parser = new XMLParser({ ignoreAttributes: false });

export default async function handler(req, res) {
  try {
    const results = await Promise.allSettled(
      FEEDS.map(async feed => {
        const response = await fetch(feed.url);
        if (!response.ok) throw new Error(`${feed.source} の取得に失敗: ${response.status}`);
        const xml = await response.text();
        const data = parser.parse(xml);
        const items = data?.rss?.channel?.item || [];
        return items.slice(0, 5).map(item => ({
          headline: typeof item.title === 'string' ? item.title : String(item.title ?? ''),
          source: feed.source,
          time: item.pubDate ? new Date(item.pubDate).toISOString() : null,
          link: item.link ?? null
        }));
      })
    );

    // 取得に失敗したフィードがあってもエラーにせず、成功した分だけ返す
    const allItems = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))
      .slice(0, 10); // TOP10件に絞る(サイト側はTOP5表示なので余裕を持たせている)

    const failedFeeds = results
      .map((r, i) => (r.status === 'rejected' ? FEEDS[i].source : null))
      .filter(Boolean);

    // ニュースは移籍情報ほど速報性が問われないので、長めに(30分)キャッシュ
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
    return res.status(200).json({ news: allItems, failedFeeds });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '取得に失敗しました', detail: err.message });
  }
}

// api/other-news.js
// 「その他のニュース」機能: ニュースタブのAM4編集部記事一覧の下に、生RSS記事のうち
// AM4編集部コラム・試合レポートの根拠記事(sources)として使われなかったものだけを
// シンプルなテキストリストとして表示するためのエンドポイント。
//
// 【AIコストについて】このエンドポイント自体はAnthropic APIを一切呼ばない。
// 「どの記事が既に使われたか」を知るために /api/ai-column と /api/match-report を
// 叩くが、これらは既にVercelのエッジキャッシュに乗っている生成済みの結果を読むだけ
// なので(通常はキャッシュHIT)、追加のAI呼び出しは発生しない。
//
// レスポンス: { items: [{ headline, source, link, publishedAt, image }], generatedAt }
// キャッシュは短め(15分)。AI処理を挟まないため、コスト面で長くキャッシュする必要が無い。

import { fetchAllNewsItems } from './news.js';

const AM4_API_BASE = 'https://am4-api.vercel.app';

async function fetchUsedLinks(lang) {
  const usedLinks = new Set();
  const results = await Promise.allSettled([
    fetch(`${AM4_API_BASE}/api/ai-column?lang=${lang}`),
    fetch(`${AM4_API_BASE}/api/match-report?lang=${lang}`),
  ]);

  for (const result of results) {
    if (result.status !== 'fulfilled' || !result.value.ok) continue;
    try {
      const data = await result.value.json();
      const lists = [data.columns, data.reports].filter(Array.isArray);
      for (const list of lists) {
        for (const item of list) {
          for (const source of item.sources || []) {
            if (source.link) usedLinks.add(source.link);
          }
        }
      }
    } catch {
      // 片方の取得・解析に失敗しても、もう片方の結果だけで続行する
    }
  }
  return usedLinks;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const lang = String(req.query.lang || 'ja').toLowerCase();

    const [{ items: newsItems }, usedLinks] = await Promise.all([
      fetchAllNewsItems(),
      fetchUsedLinks(lang),
    ]);

    const items = newsItems
      .filter(n => !n.link || !usedLinks.has(n.link))
      .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))
      .slice(0, 20)
      .map(n => ({
        headline: n.headline,
        source: n.source,
        link: n.link,
        publishedAt: n.time || null,
        image: n.image || null,
      }));

    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate');
    return res.status(200).json({ items, generatedAt: new Date().toISOString() });

  } catch (err) {
    console.error('other-news error:', err);
    return res.status(500).json({ error: '取得に失敗しました', detail: err.message });
  }
}

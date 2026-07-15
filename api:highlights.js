// api/highlights.js
// Vercelのサーバーレス関数(Node.js)。
// 試合カード(home, away, date)を渡すと、公式チャンネルに絞ってハイライト動画を検索し、
// 見つかった動画IDを返す。このIDをそのまま football-hub.html 側の
// match.videoId / player.videoId / club.videoId に入れると、
// 既に作ってある youtubeEmbedSection() がそのまま埋め込み再生してくれる。
//
// 使い方: /api/highlights?home=フランス&away=スペイン&date=2026-07-15

export default async function handler(req, res) {
  const API_KEY = process.env.YOUTUBE_API_KEY;
  const { home, away, date } = req.query;

  if (!API_KEY) {
    return res.status(500).json({ error: 'YOUTUBE_API_KEY が設定されていません' });
  }
  if (!home || !away) {
    return res.status(400).json({ error: 'home と away は必須パラメータです' });
  }

  // 公式チャンネルだけに絞ることで、非公式の切り抜き動画がヒットするのを防ぐ。
  // チャンネルIDは事前にYouTube上で確認して埋めておく(例: DAZN Japan, FIFA, 各リーグ公式など)。
  const OFFICIAL_CHANNEL_IDS = [
    'UCqZQlzSHbVJrwrn5XvzrzcA', // 例: FIFA公式(要確認・差し替え)
    // 'UCxxxxxxxxxxxxxxxxxxxxxx', // 例: DAZN Japan公式など、随時追加
  ];

  const query = `${home} vs ${away} highlights ${date || ''}`.trim();

  try {
    // search.list は1回100ユニット消費(1日あたり検索できる回数は少なめ、目安100回/日)。
    // なので「試合終了後に1回だけ」検索し、結果を保存して使い回すのが前提の設計。
    const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
    searchUrl.searchParams.set('part', 'snippet');
    searchUrl.searchParams.set('q', query);
    searchUrl.searchParams.set('type', 'video');
    searchUrl.searchParams.set('order', 'relevance');
    searchUrl.searchParams.set('maxResults', '10');
    searchUrl.searchParams.set('key', API_KEY);

    const response = await fetch(searchUrl.toString());
    if (!response.ok) {
      throw new Error(`YouTube API エラー: ${response.status}`);
    }
    const data = await response.json();

    // 公式チャンネルの動画があれば優先。なければ検索結果の1件目にフォールバック。
    const officialMatch = data.items.find(item => OFFICIAL_CHANNEL_IDS.includes(item.snippet.channelId));
    const best = officialMatch || data.items[0];

    if (!best) {
      return res.status(200).json({ videoId: null, message: '該当する動画が見つかりませんでした' });
    }

    // 一度取得した結果はキャッシュして使い回す想定(24時間)。
    // 同じ試合を何度も検索し直すと、search.list の少ない日次枠をすぐ使い切ってしまう。
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
    return res.status(200).json({
      videoId: best.id.videoId,
      title: best.snippet.title,
      channelTitle: best.snippet.channelTitle,
      isOfficial: !!officialMatch
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '取得に失敗しました', detail: err.message });
  }
}
